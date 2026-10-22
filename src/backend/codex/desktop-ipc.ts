import net from 'node:net';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface DesktopEnvelope {
  type: string; method?: string; requestId?: string; sourceClientId?: string; version?: number;
  params?: Record<string, unknown>; result?: Record<string, unknown>; resultType?: string; error?: string;
}

/** Codex 当前桌面 IPC。只连本用户已有 socket,不启动 router、不获得会话所有权。 */
export class DesktopIpc extends EventEmitter {
  private socket?: net.Socket;
  private clientId = 'initializing-client';
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (m: DesktopEnvelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private socketPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc/ipc.sock')) { super(); }

  async connect(): Promise<void> {
    const [socket, directory] = await Promise.all([lstat(this.socketPath), lstat(path.dirname(this.socketPath))]);
    const uid = process.getuid?.();
    if (uid == null || !socket.isSocket() || socket.uid !== uid || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) || (socket.mode & 0o077)) throw new Error('Codex 本地通信端点的所有者或权限无效');
    const connection = net.createConnection(this.socketPath);
    this.socket = connection;
    connection.on('data', (bytes) => this.receive(bytes));
    connection.on('error', () => { /* close 统一传播,避免重复通知。 */ });
    connection.on('close', () => {
      this.socket = undefined; this.buffer = Buffer.alloc(0);
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Codex 连接已断开；发送结果可能未知,请先检查对话再重试')); }
      this.pending.clear(); this.emit('disconnected');
    });
    await new Promise<void>((resolve, reject) => { connection.once('connect', resolve); connection.once('error', reject); });
    const response = await this.request('initialize', { clientType: 'duetlens' }, 0, 5000);
    if (typeof response.result?.clientId !== 'string') throw new Error('Codex 本地通信握手不兼容');
    this.clientId = response.result.clientId;
  }

  request(method: string, params: Record<string, unknown>, version: number, timeout = 10000, targetClientId?: string): Promise<DesktopEnvelope> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Codex 请求超时；请先检查原会话,不要重复发送')); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version, timeoutMs: timeout, targetClientId }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  broadcast(method: string, params: Record<string, unknown>, version: number): void {
    this.write({ type: 'broadcast', method, params, version, sourceClientId: this.clientId });
  }
  private write(message: object): void {
    if (!this.socket?.writable) throw new Error('请先打开 Codex 并打开已绑定的对话');
    const bytes = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([header, bytes]));
  }
  private receive(bytes: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length < 1 || length > 128 * 1024 * 1024) { this.close(); return; }
      if (this.buffer.length < length + 4) return;
      const frame = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
      let message: DesktopEnvelope;
      try { message = JSON.parse(frame.toString('utf8')); } catch { this.close(); return; }
      if (message.type === 'response' && message.requestId) {
        const item = this.pending.get(message.requestId);
        if (item) {
          clearTimeout(item.timer); this.pending.delete(message.requestId);
          if (message.resultType === 'success') item.resolve(message);
          else item.reject(new Error(message.error || 'Codex 请求失败'));
        }
      } else if (message.type === 'broadcast') this.emit('broadcast', message);
      else if (message.type === 'client-discovery-request' && message.requestId) this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    }
  }
  close(): void { this.socket?.destroy(); }
}
