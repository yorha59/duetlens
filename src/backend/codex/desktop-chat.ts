import { EventEmitter } from 'node:events';
import type { CodexChatMessage, CodexChatState } from '@shared/codex-chat';
import { parseCodexThread } from '@shared/codex-handoff';
import { DesktopIpc, type DesktopEnvelope } from './desktop-ipc';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const badKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Immer 的数组路径补丁;版本断档时要求新快照,不猜测缺失状态。 */
export function applyDesktopPatches(root: ObjectValue, patches: unknown[]): ObjectValue {
  for (const raw of patches) {
    const patch = object(raw); const parts = array(patch.path);
    if (!parts.length || parts.some(p => (typeof p !== 'string' && typeof p !== 'number') || badKeys.has(String(p)))) throw new Error('Codex 增量格式不兼容');
    let target: unknown = root;
    for (const part of parts.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, String(part))) throw new Error('Codex 增量路径缺失');
      target = (target as ObjectValue)[String(part)];
    }
    if (!target || typeof target !== 'object') throw new Error('Codex 增量目标无效');
    const key = String(parts.at(-1));
    if (Array.isArray(target)) {
      if (key === 'length' && patch.op === 'replace' && Number.isSafeInteger(patch.value) && Number(patch.value) >= 0 && Number(patch.value) <= 1000000) { target.length = Number(patch.value); continue; }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index > target.length || (patch.op !== 'add' && index === target.length)) throw new Error('Codex 增量数组范围无效');
    }
    if (patch.op === 'remove') {
      if (Array.isArray(target)) target.splice(Number(key), 1); else delete (target as ObjectValue)[key];
    } else if (patch.op === 'add' || patch.op === 'replace') {
      if (Array.isArray(target) && patch.op === 'add') target.splice(Number(key), 0, patch.value);
      else (target as ObjectValue)[key] = patch.value;
    } else throw new Error('Codex 增量操作不兼容');
  }
  return root;
}

function turns(state: ObjectValue): ObjectValue[] {
  const history = object(object(state.turnHistory).history);
  const entities = object(history.entitiesByKey);
  const keys = array(history.islands).flatMap(island => array(object(island).entries).map(entry => string(object(entry).value)));
  const stored = keys.length ? keys.map(key => entities[key]).filter(Boolean) : Object.values(entities);
  return [...stored, ...array(state.turns)].map(object);
}
function inputText(value: unknown): string {
  return array(value).map(v => { const input = object(v); return input.type === 'text' ? string(input.text) : ''; }).filter(Boolean).join('\n\n');
}
export function projectDesktopChat(threadId: string, state: ObjectValue): CodexChatState {
  const messages = new Map<string, CodexChatMessage>();
  let activity = '';
  for (const turn of turns(state)) {
    const id = string(turn.turnId) || String(turn.turnStartedAtMs);
    const input = inputText(object(turn.params).input);
    if (input) messages.set(id + ':user', { id: id + ':user', role: 'user', text: input });
    for (const raw of array(turn.items)) {
      const item = object(raw); const itemId = string(item.id);
      if (item.type === 'userMessage' && !input) {
        const text = string(item.text) || inputText(item.content);
        if (text) messages.set(itemId, { id: itemId, role: 'user', text });
      } else if (item.type === 'agentMessage' && typeof item.text === 'string') messages.set(itemId, { id: itemId, role: 'assistant', text: item.text, phase: string(item.phase) });
      else if (item.status === 'inProgress' || item.status === 'in_progress') activity = item.type === 'commandExecution' ? string(item.command).slice(0, 240) : string(item.type);
    }
  }
  const requests = array(state.requests);
  if (requests.length) activity = '等待审批或输入,请在 Codex 中处理';
  const runtime = object(state.threadRuntimeStatus).type;
  const latest = turns(state).at(-1);
  const busy = runtime ? runtime === 'active' : latest?.status === 'inProgress' || latest?.status === 'in_progress';
  return { threadId, title: string(state.title) || 'Codex 对话', connection: 'connected', busy, activity: busy ? activity || 'Codex 正在回复' : '', messages: [...messages.values()].slice(-300) };
}

/** 只跟随现有桌面 owner。不会 resume、start app-server 或改变会话权限/工具。 */
export class DesktopChat extends EventEmitter {
  private client?: DesktopIpc;
  private raw: ObjectValue = {};
  private revision: number | null = null;
  private owner?: string;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private publishTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private retry = 0;
  private pendingSend = false;
  private sent = new Set<string>();
  state: CodexChatState;
  constructor(readonly threadId: string, private makeClient = () => new DesktopIpc()) {
    super(); parseCodexThread(threadId);
    this.state = { threadId, connection: 'connecting', title: 'Codex 对话', messages: [], busy: false, activity: '' };
  }
  start(): void { this.stopped = false; void this.connect(); }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = this.makeClient(); this.client = client;
    this.state = { ...this.state, connection: 'connecting', error: undefined }; this.emit('state', this.state);
    client.on('broadcast', (message: DesktopEnvelope) => this.onMessage(message));
    client.on('disconnected', () => {
      if (this.client !== client || this.stopped) return;
      this.owner = undefined; this.revision = null;
      clearTimeout(this.publishTimer); this.publishTimer = undefined;
      this.state = { ...this.state, connection: 'disconnected', busy: false, error: 'Codex 连接断开,正在重连' }; this.emit('state', this.state);
      this.scheduleReconnect();
    });
    try { await client.connect(); if (this.stopped || this.client !== client) { client.close(); return; } this.follow(); }
    catch (error) {
      if (this.stopped || this.client !== client) return;
      this.state = { ...this.state, connection: 'disconnected', error: `请打开 Codex 和绑定的对话：${(error as Error).message}` }; this.emit('state', this.state);
      client.removeAllListeners(); client.close(); this.scheduleReconnect();
    }
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(); }, Math.min(15000, 1000 * 2 ** Math.min(this.retry++, 4)));
  }
  private follow(): void {
    this.client?.broadcast('thread-stream-following-changed', { conversationId: this.threadId, hostId: 'local', following: true }, 1);
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      if (this.revision != null || this.stopped) return;
      this.state = { ...this.state, connection: 'disconnected', error: '请在 Codex 中打开此对话,然后点击重连' }; this.emit('state', this.state);
    }, 6000);
  }
  private onMessage(message: DesktopEnvelope): void {
    if (message.method === 'client-status-changed' && message.params?.status === 'connected') { this.follow(); return; }
    if (message.method === 'thread-stream-following-status-requested' && message.params?.conversationId === this.threadId && message.params?.hostId === 'local') { this.follow(); return; }
    if (message.method === 'client-status-changed' && message.params?.clientId === this.owner && message.params?.status === 'disconnected') {
      this.owner = undefined; this.revision = null; clearTimeout(this.publishTimer); this.publishTimer = undefined;
      this.state = { ...this.state, connection: 'disconnected', busy: false, error: 'Codex 执行端已关闭,请重新打开绑定的对话' }; this.emit('state', this.state); return;
    }
    if (message.method !== 'thread-stream-state-changed' || message.params?.conversationId !== this.threadId || message.params?.hostId !== 'local') return;
    if (message.version !== 11) {
      clearTimeout(this.publishTimer); this.publishTimer = undefined; this.owner = undefined; this.revision = null;
      this.state = { ...this.state, connection: 'incompatible', error: 'Codex 的同步协议版本已变化,请更新 Duetlens' }; this.emit('state', this.state); return;
    }
    const change = object(message.params.change);
    try {
      if (change.type === 'snapshot') {
        if (object(change.conversationState).id !== this.threadId) throw new Error('Codex 会话快照不匹配');
        this.raw = object(change.conversationState); this.owner = message.sourceClientId;
      } else if (change.type === 'patches') {
        if (this.owner !== message.sourceClientId || this.revision == null || this.revision !== change.baseRevision) { this.revision = null; this.follow(); return; }
        this.raw = applyDesktopPatches(this.raw, array(change.patches));
      } else throw new Error('未知的 Codex 同步事件');
      if (typeof change.revision !== 'number') throw new Error('Codex 同步版本无效');
      this.revision = change.revision; this.retry = 0; clearTimeout(this.snapshotTimer);
      // 合并频繁 token 事件,只把可见消息投影传给 renderer,不复制整份内部会话状态。
      if (!this.publishTimer) this.publishTimer = setTimeout(() => { this.publishTimer = undefined; this.state = projectDesktopChat(this.threadId, this.raw); this.emit('state', this.state); }, 100);
    } catch (error) {
      clearTimeout(this.publishTimer); this.publishTimer = undefined; this.owner = undefined;
      this.revision = null;
      this.state = { ...this.state, connection: 'incompatible', error: (error as Error).message }; this.emit('state', this.state);
      this.follow();
    }
  }
  async send(text: string, requestId: string, beforeSend?: () => void): Promise<void> {
    parseCodexThread(requestId);
    if (!text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('消息为空或超过 2 MiB');
    if (!this.owner || this.revision == null || this.state.connection !== 'connected') throw new Error('Codex 对话尚未连接；请先在 Codex 打开它');
    if (this.pendingSend || projectDesktopChat(this.threadId, this.raw).busy) throw new Error('Codex 正在处理当前消息,请等本轮结束后发送');
    if (this.sent.has(requestId)) throw new Error('这条消息已经尝试发送；请检查原会话,不要重复提交');
    this.pendingSend = true;
    try {
      beforeSend?.();
      this.sent.add(requestId);
      const result = await this.client!.request('thread-follower-start-turn', {
        conversationId: this.threadId,
        turnStart: { request: { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: requestId }, context: { inheritThreadSettings: true } },
      }, 2, 30000, this.owner);
      if (result.method !== 'thread-follower-start-turn') throw new Error('Codex 发送回执不兼容；请检查原会话,不要重复发送');
    } finally { this.pendingSend = false; }
  }
  async inspectOwner(): Promise<DesktopEnvelope> {
    return this.client!.request('thread-owner-discovery', { conversationId: this.threadId, hostId: 'local' }, 1);
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.reconnectTimer); clearTimeout(this.publishTimer); clearTimeout(this.snapshotTimer);
    try { this.client?.broadcast('thread-stream-following-changed', { conversationId: this.threadId, hostId: 'local', following: false }, 1); } catch { /* socket 已断 */ }
    this.client?.close(); this.removeAllListeners();
  }
}

