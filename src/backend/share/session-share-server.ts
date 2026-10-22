import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewStore } from '../db/review-store';
import { SharedSessionReader, ShareReadError } from './session-reader';

/** 只读的本机分享入口,独立于审核 agent 的临时 MCP,不会占用 agent 或启动模型。 */
export class SessionShareServer {
  private server?: http.Server;
  private starting?: Promise<string>;
  private origin?: string;
  private activeReads = 0;
  constructor(private readonly store: ReviewStore, private readonly reader: SharedSessionReader, private readonly statePath: string) {}

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
    // 不开放 CORS;网页不能借用户浏览器探测或读取本机审核。链接本身是随机只读凭据。
    if (!this.origin || req.headers.host !== this.origin.slice('http://'.length) || req.headers.origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) { send(403, { error: '只允许本机直接读取' }); return; }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(405, { error: '分享接口只支持读取' }); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', this.origin); } catch { send(400, { error: '无效请求地址' }); return; }
    const match = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{43})(?:\/(file|diff))?$/);
    const id = match ? this.store.getSharedReviewId(match[1]) : null;
    if (!id || !match) { send(404, { error: '会话不存在或分享已停止' }); return; }
    if (this.activeReads >= 4) { send(429, { error: '读取请求较多,请稍后重试' }); return; }
    this.activeReads++;
    try {
      const sessionUrl = `${this.origin}/sessions/${match[1]}`;
      if (match[2] === 'file') {
        const result = await this.reader.file(id, url.searchParams.get('path') ?? '', url.searchParams.get('head'), url.searchParams.get('round'));
        // 读取期间撤销或删除的分享不再返回数据。
        if (this.store.getSharedReviewId(match[1]) !== id) throw new ShareReadError(404, '分享已停止');
        send(200, result);
      } else if (match[2] === 'diff') {
        send(200, this.reader.diff(id, url.searchParams.get('head'), url.searchParams.get('round')), 'text/plain; charset=utf-8');
      } else send(200, this.reader.context(id, sessionUrl));
    } catch (error) {
      if (error instanceof ShareReadError) send(error.status, { error: error.message });
      else send(500, { error: '无法读取此会话,请在 Duetlens 中确认任务状态' });
    } finally { this.activeReads--; }
  }
}
