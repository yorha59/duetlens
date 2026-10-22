// 本机桥接原型:只读取当前用户创建的一次性交接票据,不接收外部传来的文件正文或提示词。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const root = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'duetlens-bridge');

function readTicket(id, threadId) {
  if (!UUID.test(id || '') || !UUID.test(threadId || '')) throw Error('Invalid Duetlens ticket ID');
  const file = path.join(root(), 'pending', id + '.json');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let ticket;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 16384) throw Error('Invalid Duetlens ticket ownership or size');
    ticket = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (ticket.requestId !== id || ticket.threadId !== threadId || !Number.isSafeInteger(ticket.createdAt) || Date.now() - ticket.createdAt > 120000 || ticket.createdAt > Date.now() + 5000) throw Error('Expired or mismatched Duetlens ticket');
  if (!Array.isArray(ticket.files) || ticket.files.length !== 1) throw Error('Expected one selected file');
  for (const file of ticket.files) {
    if (typeof file.absolute !== 'string' || !path.isAbsolute(file.absolute) || file.absolute.includes('\0') || !Number.isSafeInteger(file.line) || !Number.isSafeInteger(file.endLine) || file.line < 1 || file.endLine < file.line || file.endLine > 200000 || file.endLine - file.line > 5000 || typeof file.label !== 'string' || file.label.length > 1000 || !fs.statSync(file.absolute).isFile()) throw Error('Invalid Duetlens selection');
  }
  return { requestId: id, threadId, files: ticket.files.map(file => {
    const target = file.absolute + '#L' + file.line + (file.endLine > file.line ? '-L' + file.endLine : '');
    return { label: file.label, path: target, fsPath: target };
  }) };
}

function fromUrl(url) {
  const id = url.searchParams.get('duetlens_ticket');
  if (id == null) return undefined;
  if (url.searchParams.has('hostId') && url.searchParams.get('hostId') !== 'local') throw Error('Duetlens ticket requires a local Codex host');
  if (url.searchParams.has('prompt') || url.searchParams.getAll('duetlens_ticket').length !== 1) throw Error('Duetlens tickets cannot replace a draft');
  if (UUID.test(id) && fs.existsSync(path.join(root(), 'acks', id + '.json'))) return undefined;
  return readTicket(id, url.pathname.replace(/^\//, '').replace(/\/$/, ''));
}

function acknowledge(requestId, threadId) {
  readTicket(requestId, threadId);
  const directory = path.join(root(), 'acks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, requestId + '.json');
  fs.writeFileSync(file, JSON.stringify({ requestId, threadId, addedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  return { success: true };
}

module.exports = { readTicket, fromUrl, acknowledge };
