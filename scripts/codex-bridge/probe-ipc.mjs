// 只探测文件上下文方法,不调用 turn/start、queue 或 history injection。
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const socket = net.connect(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc/ipc.sock'));
let buffer = Buffer.alloc(0);
let clientId = 'initializing-client';
const pending = new Map();
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const body = Buffer.from(JSON.stringify({ type: 'request', requestId: id, sourceClientId: clientId, version: 0, method, params, timeoutMs: 1200 }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    const timer = setTimeout(() => { pending.delete(id); reject(Error('IPC timeout')); }, 2500);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    socket.write(Buffer.concat([header, body]));
  });
}
socket.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
    const length = buffer.readUInt32LE(0);
    const response = JSON.parse(buffer.subarray(4, 4 + length));
    buffer = buffer.subarray(4 + length);
    pending.get(response.requestId)?.(response);
    pending.delete(response.requestId);
  }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('connect', async () => {
  try {
    const init = await request('initialize', { clientType: 'duetlens-probe' });
    clientId = init.result.clientId;
    const result = await request('add-context-file', {});
    console.log(JSON.stringify({ method: 'add-context-file', resultType: result.resultType, error: result.error }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { socket.destroy(); }
});
