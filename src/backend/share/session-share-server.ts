import http from 'node:http';
import { z } from 'zod';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewStore } from '../db/review-store';
import { SharedSessionReader, ShareReadError } from './session-reader';

/** 本机分享与显式仓库绑定入口,独立于审核 agent 的临时 MCP,不会占用 agent 或启动模型。 */
export class SessionShareServer {
  private server?: http.Server;
  private starting?: Promise<string>;
  private origin?: string;
  private activeReads = 0;
  constructor(private readonly store: ReviewStore, private readonly reader: SharedSessionReader, private readonly statePath: string, private readonly refreshLocal?: (id: string) => Promise<unknown>, private readonly bindRepository?: (id: string, repoPath: string, guard: () => void) => Promise<unknown>) {}

  async start(): Promise<string> {
    if (this.origin) return this.origin;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  private async listen(): Promise<string> {
    let port = 0;
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8')) as { port: number };
      if (!Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) throw new Error('invalid port');
      port = saved.port;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('分享接口配置无法读取,请检查应用数据目录'); }
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      const actualPort = (server.address() as AddressInfo).port;
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify({ port: actualPort }), { mode: 0o600 });
      this.origin = `http://127.0.0.1:${actualPort}`;
      return this.origin;
    } catch {
      server.close(); this.server = undefined;
      throw new Error('本机会话分享接口无法启动（原端口可能被占用）,请重试');
    }
  }

  async share(reviewId: string): Promise<{ url: string }> {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error('审核任务不存在');
    if (review.localReview && !review.workspaceRemoteId) throw new Error('正在迁移本地审核视图,请稍后重试');
    const origin = await this.start();
    const token = this.store.createReviewShare(reviewId);
    return { url: `${origin}/sessions/${token}` };
  }

  revoke(reviewId: string): void { this.store.revokeReviewShare(reviewId); }

  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    const server = this.server;
    this.origin = undefined; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }

  private context(id: string, url: string) {
    const result = this.reader.context(id, url);
    return { ...result, access: { ...result.access, readOnly: !this.bindRepository, bindRepository: !!this.bindRepository } };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const send = (status: number, body: unknown, type = 'application/json; charset=utf-8') => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(body, null, 2) : String(body));
    };
    // 不开放 CORS;写操作同样只允许直接本机客户端,令牌不得交给网页或外部服务。
    if (!this.origin || req.headers.host !== this.origin.slice('http://'.length) || req.headers.origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) { send(403, { error: '只允许本机直接访问' }); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', this.origin); } catch { send(400, { error: '无效请求地址' }); return; }
    const match = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{43})(?:\/(file|diff|repository))?$/);
    const id = match ? this.store.getSharedReviewId(match[1]) : null;
    if (!id || !match) { send(404, { error: '会话不存在或分享已停止' }); return; }
    const binding = match[2] === 'repository';
    const method = binding && this.bindRepository ? 'POST' : 'GET';
    if ((binding && !this.bindRepository) || req.method !== method) { res.setHeader('Allow', binding ? (this.bindRepository ? 'POST' : '') : 'GET'); send(405, { error: '此端点不支持该操作' }); return; }
    if (this.activeReads >= 4) { send(429, { error: '读取请求较多,请稍后重试' }); return; }
    this.activeReads++;
    try {
      const sessionUrl = `${this.origin}/sessions/${match[1]}`;
      if (binding) {
        if (url.search) throw new ShareReadError(400, '仓库绑定参数必须通过 JSON 请求体传递');
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ShareReadError(415, '请使用 application/json');
        const input = repositoryBindingSchema.safeParse(await readJsonBody(req));
        if (!input.success) throw new ShareReadError(400, '需要绝对 repoPath 和完整 expected 版本信息');
        const guard = () => {
          if (this.store.getSharedReviewId(match[1]) !== id) throw new ShareReadError(404, '分享已停止');
          this.reader.assertRepositoryVersion(id, input.data.expected);
        };
        guard();
        try { await this.bindRepository!(id, input.data.repoPath, guard); }
        catch (error) {
          if (error instanceof ShareReadError) throw error;
          throw new ShareReadError(422, error instanceof Error ? error.message : '无法关联此仓库');
        }
        if (this.store.getSharedReviewId(match[1]) !== id) throw new ShareReadError(404, '分享已停止');
        send(200, this.context(id, sessionUrl));
        return;
      }
      // 后台窗口也能读取最新工作区;不启动 agent。版本变化由 file/diff 的 409 闸门处理。
      await this.refreshLocal?.(id);
      if (this.store.getSharedReviewId(match[1]) !== id) throw new ShareReadError(404, '分享已停止');
      if (match[2] === 'file') {
        const result = await this.reader.file(id, url.searchParams.get('path') ?? '', url.searchParams.get('head'), url.searchParams.get('round'), url.searchParams.get('base'));
        // 读取期间撤销或删除的分享不再返回数据。
        if (this.store.getSharedReviewId(match[1]) !== id) throw new ShareReadError(404, '分享已停止');
        send(200, result);
      } else if (match[2] === 'diff') {
        send(200, this.reader.diff(id, url.searchParams.get('head'), url.searchParams.get('round'), url.searchParams.get('base')), 'text/plain; charset=utf-8');
      } else send(200, this.context(id, sessionUrl));
    } catch (error) {
      if (error instanceof ShareReadError) send(error.status, { error: error.message });
      else send(500, { error: '无法读取此会话,请在 Duetlens 中确认任务状态' });
    } finally { this.activeReads--; }
  }
}

const repositoryBindingSchema = z.object({
  repoPath: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes('\0')),
  expected: z.object({
    reviewId: z.string().min(1), head: z.string().nullable(), round: z.number().int().nonnegative(),
    base: z.string().nullable(), repositoryPath: z.string().nullable(), updatedAt: z.number().int().nonnegative(),
  }).strict(),
}).strict();

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > 16 * 1024) { settled = true; reject(new ShareReadError(413, '请求体不能超过 16 KiB')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ShareReadError(400, '无效 JSON 请求体')); }
    });
    req.on('error', () => { if (!settled) { settled = true; reject(new ShareReadError(400, '请求体读取失败')); } });
    req.on('aborted', () => { if (!settled) { settled = true; reject(new ShareReadError(400, '请求已中断')); } });
  });
}
