import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, chmod, rm, mkdir, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DesktopIpc } from '../src/backend/codex/desktop-ipc';
import { DesktopChat, applyDesktopPatches, projectDesktopChat } from '../src/backend/codex/desktop-chat';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { migrate, SCHEMA_VERSION } from '../src/backend/db/schema';
import { parseUnifiedDiff } from '../src/shared/diff';
import { IpcChannels } from '../src/shared/ipc';
import { prepareRemoteComment } from '../src/backend/codex/remote-comment-context';
import type { CodexChatDraft, CodexChatEvent } from '../src/shared/codex-chat';
import type { IpcDeps } from '../src/backend/ipc';

const threadId = '11111111-2222-3333-4444-555555555555';
const until = async (condition: () => boolean, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out waiting for desktop state'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const fixture = () => ({
  id: threadId, title: 'Fixture', threadRuntimeStatus: { type: 'idle' }, turns: [], requests: [],
  turnHistory: { kind: 'paginated', history: { entitiesByKey: {
    'turn:1': { turnId: '1', status: 'completed', params: { input: [{ type: 'text', text: 'question' }] }, items: [{ type: 'agentMessage', id: 'answer', text: 'answer', phase: 'final_answer' }] },
  }, islands: [{ entries: [{ key: 'turn:1', value: 'turn:1' }] }] } },
});
function frame(message: object) { const data = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]); }
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'duetlens-desktop-chat-'));
  const socketPath = path.join(directory, 'ipc/ipc.sock');
  await mkdir(path.dirname(socketPath), { mode: 0o700 });
  const peers = new Set<net.Socket>();
  let peer: net.Socket;
  let snapshots = 0; let sends = 0; let connections = 0; let closeOnSend = false;
  let lastInput = '';
  let responseDelay = 0;
  const snapshot = () => { snapshots++; peer.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop-owner', params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: 10, conversationState: fixture() } } })); };
  const patch = (base: number, revision: number, patches: object[], version = 11) => peer.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version, sourceClientId: 'desktop-owner', params: { hostId: 'local', conversationId: threadId, change: { type: 'patches', baseRevision: base, revision, patches } } }));
  const server = net.createServer(socket => {
    peer = socket; peers.add(socket); connections++;
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => {});
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0); const message = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
        if (message.method === 'initialize') {
          const bytes = frame({ type: 'response', method: 'initialize', requestId: message.requestId, resultType: 'success', result: { clientId: 'duetlens-fixture' } });
          socket.write(bytes.subarray(0, 3)); setImmediate(() => socket.write(bytes.subarray(3)));
        } else if (message.method === 'thread-stream-following-changed') { if (message.params.following) snapshot(); }
        else if (message.method === 'thread-follower-start-turn') {
          sends++;
          lastInput = message.params.turnStart.request.input[0].text;
          assert.equal(message.version, 2); assert.equal(message.targetClientId, 'desktop-owner');
          assert.equal(message.params.conversationId, threadId);
          assert.equal(message.params.turnStart.request.threadId, threadId);
          assert.deepEqual(message.params.turnStart.context, { inheritThreadSettings: true });
          assert.equal(message.params.turnStart.request.model, undefined);
          assert.equal(message.params.turnStart.request.approvalPolicy, undefined);
          if (closeOnSend) socket.destroy();
          else {
            const response = frame({ type: 'response', method: 'thread-follower-start-turn', resultType: 'success', requestId: message.requestId, result: { result: { turn: { id: 'new-turn' } } } });
            if (responseDelay) setTimeout(() => socket.write(response), responseDelay); else socket.write(response);
          }
        } else assert.fail('Unexpected request: ' + message.method);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  const chat = new DesktopChat(threadId, () => new DesktopIpc(socketPath));
  const db = openDatabase(path.join(directory, 'db.sqlite'));
  try {
    chat.start(); await until(() => chat.state.connection === 'connected');
    assert.deepEqual(chat.state.messages.map(message => message.text), ['question', 'answer']);
    patch(10, 11, [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:1', 'items', 0, 'text'], value: 'answer streamed' }, { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'active' }]);
    await until(() => chat.state.messages.at(-1)?.text === 'answer streamed');
    assert(chat.state.busy);
    await assert.rejects(chat.send('do not send while active', randomUUID()), /正在处理/); assert.equal(sends, 0);
    patch(11, 12, [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }]);
    await until(() => !chat.state.busy);
    const id = randomUUID(); await chat.send('user clicked send', id);
    assert.equal(sends, 1); await assert.rejects(chat.send('user clicked send', id), /已经尝试/); assert.equal(sends, 1);
    patch(100, 101, []); await until(() => snapshots >= 2 && chat.state.messages.at(-1)?.text === 'answer');
    patch(10, 11, [], 12); await until(() => chat.state.connection === 'incompatible');
    await assert.rejects(chat.send('incompatible', randomUUID()), /尚未连接/);
    snapshot(); await until(() => chat.state.connection === 'connected');
    peer!.write(frame({ type: 'broadcast', method: 'client-status-changed', params: { clientId: 'desktop-owner', status: 'disconnected' } }));
    await until(() => chat.state.connection === 'disconnected');
    peer!.write(frame({ type: 'broadcast', method: 'thread-stream-following-status-requested', params: { conversationId: threadId, hostId: 'local' } }));
    await until(() => chat.state.connection === 'connected');
    closeOnSend = true; const unknown = randomUUID();
    await assert.rejects(chat.send('outcome unknown', unknown), /断开/);
    await until(() => connections >= 2 && chat.state.connection === 'connected');
    assert.equal(sends, 2, 'reconnect must not replay the outgoing request');
    await assert.rejects(chat.send('outcome unknown', unknown), /已经尝试/); assert.equal(sends, 2);
    const store = new ReviewStore(db);
    store.saveCodexChatDraft(threadId, { text: 'unsent text', selections: [{ id: 'selection', file: 'a.ts', line: 4, lineEnd: 7, side: 'old', text: 'selected code', context: 'source path and selected code', snapshot: true }] });
    assert.equal(new ReviewStore(db).getCodexChatDraft(threadId).selections[0].side, 'old');
    assert.equal(store.getCodexChatDraft('another-thread').text, '');
    store.reserveCodexChatSend(threadId, unknown); store.finishCodexChatSend(unknown, 'unknown');
    assert.throws(() => store.reserveCodexChatSend(threadId, unknown), /已经尝试/);
    const state = fixture();
    const turn = state.turnHistory.history.entitiesByKey['turn:1'];
    turn.status = 'inProgress';
    assert.equal(projectDesktopChat(threadId, state).busy, false, 'runtime idle wins over stale historic tail');
    const small = { list: ['a', 'c'] };
    applyDesktopPatches(small, [{ op: 'add', path: ['list', 1], value: 'b' }, { op: 'remove', path: ['list', 2] }]);
    assert.deepEqual(small.list, ['a', 'b']);
    assert.throws(() => applyDesktopPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]));
    assert.throws(() => applyDesktopPatches({}, [{ op: 'replace', path: ['missing', 'text'], value: 'x' }]));
    const legacy = openDatabase(':memory:');
    try {
      const oldStore = new ReviewStore(legacy);
      const oldReview = oldStore.createReview({ source: 'local-worktree', sourceRef: directory });
      oldStore.setCodexBinding(oldReview.id, { threadId, mode: 'copy' });
      legacy.exec('DROP TABLE codex_chat_drafts; DROP TABLE codex_chat_sends; ALTER TABLE messages DROP COLUMN kind; ALTER TABLE discussions DROP COLUMN workspace_stale; PRAGMA user_version=33');
      migrate(legacy);
      assert.equal(legacy.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      assert.equal(oldStore.getCodexBinding(oldReview.id)?.threadId, threadId);
    } finally { legacy.close(); }
    // 注册真实 IPC handler,只替换 Electron 外壳和桌面执行端;校验选区→草稿→手动发送完整链路。
    chat.stop(); closeOnSend = false;
    const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = directory;
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const app = Object.assign(new EventEmitter(), { getPath: () => directory });
    const events: CodexChatEvent[] = [];
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: (_channel: string, value: CodexChatEvent) => events.push(value) });
    const manager = Object.assign(new EventEmitter(), {
      getReview: async (id: string) => store.getReview(id),
      getCodexBinding: (id: string) => store.getCodexBinding(id),
      setCodexBinding: (id: string, binding: Parameters<ReviewStore['setCodexBinding']>[1]) => store.setCodexBinding(id, binding),
      getCodexChatDraft: (id: string) => store.getCodexChatDraft(id),
      saveCodexChatDraft: (id: string, draft: CodexChatDraft) => store.saveCodexChatDraft(id, draft),
      reserveCodexChatSend: (id: string, request: string) => store.reserveCodexChatSend(id, request),
      finishCodexChatSend: (request: string, status: 'unknown' | 'accepted') => store.finishCodexChatSend(request, status),
      getDiff: () => parseUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n header\n-old code\n+selected code\n'),
    });
    const loader = Module as unknown as { _load: (request: string, parent: unknown, main: boolean) => unknown };
    const originalLoad = loader._load;
    loader._load = function(request, parent, main) {
      if (request === 'electron') return { app, ipcMain: { handle: (name: string, callback: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(name, callback) }, clipboard: { write: () => assert.fail('selection must not use clipboard') }, shell: { openExternal: () => assert.fail('selection must not navigate or prefill Codex') } };
      return originalLoad.call(this, request, parent, main);
    };
    try {
      const { registerIpcHandlers } = await import('../src/backend/ipc');
      loader._load = originalLoad;
      registerIpcHandlers({ manager: manager as unknown as IpcDeps['manager'], updater: {} as IpcDeps['updater'], shareServer: { share: async () => ({ url: 'http://127.0.0.1/session' }) } as unknown as IpcDeps['shareServer'], broadcast: (_channel, event) => events.push(event as CodexChatEvent) });
      const call = (name: string, ...args: unknown[]) => Promise.resolve(handlers.get(name)!({ sender }, ...args));
      const review = store.createReview({ source: 'local-worktree', sourceRef: directory, repoPath: directory, status: 'reviewing' });
      await writeFile(path.join(directory, 'a.ts'), 'header\nselected code\n');
      store.setCodexBinding(review.id, { threadId, mode: 'copy' });
      store.saveCodexChatDraft(threadId, { text: '', selections: [] });
      const before = sends;
      await call(IpcChannels.codexAddSelection, review.id, { file: 'a.ts', line: 2, text: 'selected code', side: 'new' });
      await call(IpcChannels.codexChatDraft, review.id, '请修改这里', []);
      const remote = store.createReview({ source: 'github-pr', sourceRef: 'owner/repo#42', repoPath: directory });
      store.setCodexBinding(remote.id, { threadId, mode: 'copy' });
      const selected = { id: 'comment-1', author: 'reviewer', body: '请修改这个判断', url: 'https://github.com/owner/repo/pull/42#discussion_r1', createdAt: '2026-10-23' };
      const commentContext = { comment: selected, head: 'abc123', thread: { id: 'thread-1', path: 'a.ts', line: 2, side: 'old', resolved: false, outdated: true, comments: [selected, { ...selected, id: 'reply-1', body: '补充语境' }] } };
      await call(IpcChannels.codexAddComment, remote.id, commentContext);
      const attachedId = store.getCodexChatDraft(threadId).selections.at(-1)!.id;
      assert.equal(store.getCodexChatDraft(threadId).text, '请修改这里', 'preserve existing composer text');
      assert.equal(store.getCodexChatDraft(threadId).selections.length, 2, 'preserve existing selection');
      await call(IpcChannels.codexAddComment, remote.id, commentContext);
      assert.equal(store.getCodexChatDraft(threadId).selections.at(-1)!.id, attachedId, 'same content is deduplicated');
      commentContext.comment = { ...selected, body: '更新后的评论' };
      await call(IpcChannels.codexAddComment, remote.id, commentContext);
      const attached = store.getCodexChatDraft(threadId).selections.at(-1)!;
      assert.notEqual(attached.id, attachedId, 'updated content survives any in-flight old attachment send');
      assert.equal(store.getCodexChatDraft(threadId).selections.length, 2);
      assert(attached.context.includes('更新后的评论')); assert(!attached.context.includes('请修改这个判断'));
      for (const part of ['补充语境', 'abc123', '删除侧', '已过时', 'a.ts:2', directory, selected.url]) assert(attached.context.includes(part), part);
      assert.equal(attached.kind, 'comment');
      const general = prepareRemoteComment(remote, { comment: selected, head: 'abc123' });
      assert(general.context.includes('PR 评论 / Review 总结'));
      assert.throws(() => prepareRemoteComment(remote, { comment: selected, head: 'abc123', thread: { ...commentContext.thread, line: -1 } }), /无效/);
      await assert.rejects(call(IpcChannels.codexAddComment, review.id, commentContext), /远端 PR/);
      const unbound = store.createReview({ source: 'github-pr', sourceRef: 'owner/repo#99' });
      await assert.rejects(call(IpcChannels.codexAddComment, unbound.id, commentContext), /绑定/);
      assert.equal(sends, before, 'adding comments must not invoke the agent');
      const draft = store.getCodexChatDraft(threadId);
      assert.equal(draft.selections.length, 2); assert.equal(sends, before, 'adding a selection must not invoke the agent');
      await call(IpcChannels.codexChatConnect, review.id);
      await until(() => events.some(event => (event.kind === 'state' || event.kind === 'update') && event.state.connection === 'connected'));
      await call(IpcChannels.codexChatSend, review.id, { text: draft.text, selectionIds: draft.selections.map(selection => selection.id), requestId: randomUUID() });
      assert.equal(sends, before + 1); assert(lastInput.includes('请修改这里')); assert(lastInput.includes('selected code')); assert(lastInput.includes('a.ts:2')); assert(lastInput.includes('更新后的评论')); assert(lastInput.includes('补充语境'));
      assert.deepEqual(store.getCodexChatDraft(threadId), { text: '', selections: [] });
      const eventStart = events.length;
      patch(10, 11, [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn:1', 'items', 0, 'text'], value: 'live answer' }]);
      await until(() => events.slice(eventStart).some(event => event.kind === 'update' && event.messages.length === 1 && event.messages[0].text === 'live answer'));
      responseDelay = 150;
      await call(IpcChannels.codexChatDraft, review.id, '切换标签仍等待回执', []);
      const sentBeforeSwitch = sends;
      const inFlight = call(IpcChannels.codexChatSend, review.id, { text: '切换标签仍等待回执', selectionIds: [], requestId: randomUUID() });
      await until(() => sends > sentBeforeSwitch);
      await call(IpcChannels.codexChatDisconnect, review.id);
      await inFlight;
      assert.equal(store.getCodexChatDraft(threadId).text, '');
      responseDelay = 0;
      const reconnectStart = events.length;
      await call(IpcChannels.codexChatConnect, review.id);
      await until(() => events.slice(reconnectStart).some(event => (event.kind === 'state' || event.kind === 'update') && event.state.connection === 'connected'));
      await call(IpcChannels.codexChatDraft, review.id, '保留失败草稿', []);
      closeOnSend = true;
      await assert.rejects(call(IpcChannels.codexChatSend, review.id, { text: '保留失败草稿', selectionIds: [], requestId: randomUUID() }), /断开/);
      assert.equal(store.getCodexChatDraft(threadId).text, '保留失败草稿');
      await call(IpcChannels.codexChatDisconnect, review.id);
    } finally {
      loader._load = originalLoad; app.emit('before-quit');
      if (previousHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    }
    console.log('codex chat: framed transport, native history projection, streaming patches, busy guard, owner forwarding, inherited settings, no replay, reconnect, revision recovery, protocol gate, persistent drafts and send dedupe passed');
    console.log('codex chat IPC: real selection validation, no clipboard or auto-send, manual owner send, draft clearing, delta-only renderer updates, failed draft retained, v33 migration passed');
  } finally {
    chat.stop(); db.close(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
