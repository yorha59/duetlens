// 原型发送端。默认只生成票据;--open 才交给已安装桥接的 Codex,不会发送模型消息。
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createTicket({ threadId, file, line, endLine = line }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw Error('Expected an existing Codex thread UUID');
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(endLine) || endLine < line || endLine > 200000 || endLine - line > 5000) throw Error('Invalid line range');
  const absolute = await fs.realpath(file);
  if (!(await fs.stat(absolute)).isFile()) throw Error('Expected a regular file');
  const requestId = randomUUID();
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'duetlens-bridge');
  const directory = path.join(root, 'pending');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const ticket = { requestId, threadId, createdAt: Date.now(), files: [{ absolute, line, endLine, label: `${path.basename(absolute)}:${line}${endLine > line ? '-' + endLine : ''}` }] };
  const pendingPath = path.join(directory, requestId + '.json');
  await fs.writeFile(pendingPath, JSON.stringify(ticket), { mode: 0o600, flag: 'wx' });
  const url = new URL(`codex://threads/${threadId}`);
  url.searchParams.set('duetlens_ticket', requestId);
  return { ...ticket, url: url.href, pendingPath, ackPath: path.join(root, 'acks', requestId + '.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [threadId, file, start, end, flag] = process.argv.slice(2);
  const ticket = await createTicket({ threadId, file, line: Number(start), endLine: Number(end || start) });
  if (flag !== '--open') console.log(JSON.stringify({ url: ticket.url, requestId: ticket.requestId, opened: false }));
  else {
    try {
      await promisify(execFile)('/usr/bin/open', [ticket.url]);
      const deadline = Date.now() + 10000;
      let receipt;
      while (Date.now() < deadline) {
        try { receipt = JSON.parse(await fs.readFile(ticket.ackPath, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!receipt || receipt.requestId !== ticket.requestId || receipt.threadId !== threadId) throw Error('No native append acknowledgement; Codex may not have loaded the bridge. Nothing was sent to the model.');
      console.log(JSON.stringify({ acknowledged: true, requestId: ticket.requestId }));
    } finally {
      await fs.rm(ticket.pendingPath, { force: true });
      await fs.rm(ticket.ackPath, { force: true });
    }
  }
}
