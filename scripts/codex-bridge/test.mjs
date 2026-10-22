import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { prepare, modules, patchSources } from './prepare.mjs';
import { appendSelection } from './append-selection.mjs';
import { createTicket } from './send.mjs';

const require = createRequire(import.meta.url);
const receiver = require('./receiver.cjs');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'duetlens-native-bridge-'));
const originalHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = directory;
const threadId = '11111111-2222-3333-4444-555555555555';
const requestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ticketDirectory = path.join(directory, 'duetlens-bridge/pending');
const ticketFile = path.join(ticketDirectory, requestId + '.json');
const absolute = path.join(directory, 'file with spaces.ts');
await fs.mkdir(ticketDirectory, { recursive: true, mode: 0o700 });
await fs.writeFile(absolute, 'one\ntwo\nthree\n');
const ticket = { requestId, threadId, createdAt: Date.now(), files: [{ absolute, line: 2, endLine: 3, label: 'file with spaces.ts:2-3' }] };
const save = async (value = ticket) => fs.writeFile(ticketFile, JSON.stringify(value), { mode: 0o600 });
const check = (name, fn) => { fn(); console.log('PASS ' + name); };

try {
  await save();
  const context = receiver.readTicket(requestId, threadId);
  check('real file and exact native line reference', () => assert.equal(context.files[0].fsPath, absolute + '#L2-L3'));
  check('reject wrong destination thread', () => assert.throws(() => receiver.readTicket(requestId, '00000000-2222-3333-4444-555555555555')));
  check('reject traversal', () => assert.throws(() => receiver.readTicket('../../config', threadId)));
  check('reject draft replacement', () => assert.throws(() => receiver.fromUrl(new URL(`codex://threads/${threadId}?duetlens_ticket=${requestId}&prompt=replace`))));
  check('reject remote host', () => assert.throws(() => receiver.fromUrl(new URL(`codex://threads/${threadId}?duetlens_ticket=${requestId}&hostId=remote`))));
  const sent = await createTicket({ threadId, file: absolute, line: 2, endLine: 3 });
  assert.equal(receiver.fromUrl(new URL(sent.url)).files[0].fsPath, await fs.realpath(absolute) + '#L2-L3');
  assert.equal((await fs.stat(sent.pendingPath)).mode & 0o777, 0o600);
  assert.equal(new URL(sent.url).searchParams.has('prompt'), false);
  console.log('PASS sender ticket roundtrip without prompt or file writes');
  await save({ ...ticket, createdAt: Date.now() - 121000 });
  check('reject expired ticket', () => assert.throws(() => receiver.readTicket(requestId, threadId)));
  await save();
  await fs.chmod(ticketFile, 0o644);
  check('reject ticket readable by other users', () => assert.throws(() => receiver.readTicket(requestId, threadId)));
  await fs.chmod(ticketFile, 0o600);
  const output = path.join(directory, 'candidate');
  const manifest = await prepare('/Applications/ChatGPT.app/Contents/Resources/app.asar', output);
  const sources = {};
  const asts = {};
  for (const [key, member] of Object.entries(modules)) {
    sources[key] = await fs.readFile(path.join(output, member), 'utf8');
    asts[key] = parse(sources[key], { sourceType: key === 'composer' ? 'module' : 'script' });
  }
  console.log('PASS patched modules parse against pinned installed build');
  assert.equal(manifest.installed, false);
  check('refuse double patch', () => assert.throws(() => patchSources(sources)));
  function functionSource(key, name) {
    const node = asts[key].program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert(node, 'missing installed function ' + name);
    return sources[key].slice(node.start, node.end);
  }
  const parseRoute = vm.runInNewContext('(' + functionSource('bootstrap', 'JE') + ')', {
    Z: (url, key) => url.searchParams.get(key), require: () => receiver,
  });
  const route = parseRoute(new URL(`codex://threads/${threadId}?duetlens_ticket=${requestId}`));
  assert.equal(route.duetlensContext.threadId, threadId);
  console.log('PASS actual installed route parser receives ticket');
  const navigations = [];
  const navigate = vm.runInNewContext('(' + functionSource('main', 'EZe') + ')', {
    r: { Za: id => '/threads/' + id }, URLSearchParams, C7: () => {},
  });
  await navigate({ window: {}, route: { kind: 'localConversation', conversationId: threadId, ...route }, navigateToRoute: (...args) => navigations.push(args) });
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0][1], '/threads/' + threadId);
  assert.equal(navigations[0][2].prefillPrompt, undefined);
  assert.equal(navigations[0][2].duetlensContext.requestId, requestId);
  console.log('PASS actual navigation preserves draft and targets bound chat');
  // 执行补丁实际插入的 effect,不执行整个应用、不控制界面、不提交消息。
  const anchor = 'const duetlensHandled=';
  const begin = sources.composer.indexOf(anchor);
  const end = sources.composer.indexOf(';let Vo=', begin);
  assert(begin > 0 && end > begin);
  let appendCount = 0;
  let ackCount = 0;
  const draft = { text: 'existing draft', files: [] };
  const handled = new Map();
  const effects = [];
  const pending = [];
  const code = sources.composer.slice(begin, end + 1);
  vm.runInNewContext(code, {
    ZX: { useRef: () => ({ current: handled }), useEffect: fn => effects.push(fn) },
    it: navigations[0][2], Ye: threadId,
    io: files => { appendCount++; draft.files.push(...files); },
    duetlensAppendSelection: params => { const work = appendSelection(params); pending.push(work); return work; },
    to: async (method, { params }) => { assert.equal(method, 'duetlens-context-ack'); ackCount++; return receiver.acknowledge(params.requestId, params.threadId); }, console,
  });
  effects[0](); effects[0]();
  await Promise.all(pending);
  assert.equal(appendCount, 1);
  assert.equal(ackCount, 1);
  assert.equal(draft.text, 'existing draft');
  assert.equal(draft.files[0].fsPath, absolute + '#L2-L3');
  const ack = JSON.parse(await fs.readFile(path.join(directory, 'duetlens-bridge/acks', requestId + '.json')));
  assert.equal(ack.threadId, threadId);
  assert.equal(receiver.fromUrl(new URL(`codex://threads/${threadId}?duetlens_ticket=${requestId}`)), undefined);
  assert.equal(await fs.readFile(absolute, 'utf8'), 'one\ntwo\nthree\n');
  console.log('PASS native mention callback + receipt; draft retained; duplicate effect suppressed');
  assert.equal(await appendSelection({ ticket: context, threadId: 'another-thread', addFiles: () => assert.fail(), handled, acknowledge: () => assert.fail() }), false);
  console.log('PASS inactive/wrong chat receives nothing');
  console.log('LIMIT: callback and route tests are isolated; real Codex UI has not loaded this patch.');
} finally {
  if (originalHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  await fs.rm(directory, { recursive: true, force: true });
}
