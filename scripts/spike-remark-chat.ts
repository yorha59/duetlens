/** 临时仓库 + stub agent + 真 MCP:批注修改及未复审工作区直接问答。 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import type { ConversationalAgent, StartConversationOptions, ResumeConversationOptions } from '../src/backend/agent/conversational-agent';
import type { AgentEvent } from '../src/shared/agent-events';
import { SharedSessionReader } from '../src/backend/share/session-reader';
const exec = promisify(execFile);
const observed: string[] = [];
let starts = 0; let resumes = 0; let turns = 0;
class Agent extends EventEmitter implements ConversationalAgent {
  opts!: StartConversationOptions;
  async startConversation(opts: StartConversationOptions) { this.opts = opts; starts++; return { conversationId: 'stub-chat' }; }
  async resumeConversation(opts: ResumeConversationOptions) { this.opts = opts; resumes++; return { conversationId: opts.conversationId }; }
  async sendMessage(_id: string, text: string) {
    assert.ok(text.includes('代码') || text.includes('是什么'), 'turn must be the user question, never a scan prompt');
    const id = `turn-${++turns}`;
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.opts.mcpUrl!), { requestInit: { headers: { authorization: `Bearer ${this.opts.mcpToken}` } } }));
    const result = await client.callTool({ name: 'get_file', arguments: { path: 'code.ts' } });
    observed.push(JSON.stringify(result.content)); await client.close();
    this.emit('event', { kind: 'message-delta', text: '当前代码用于说明。', turnId: id } satisfies AgentEvent);
    this.emit('event', { kind: 'turn-completed', turnId: id } satisfies AgentEvent);
    return id;
  }
  streamEvents(handler: (event: AgentEvent) => void) { this.on('event', handler); return () => { this.off('event', handler); }; }
  async interrupt() {} dispose() {}
}
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-remark-chat-'));
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const manager = new ReviewManager(store, undefined, { agentFactory: () => new Agent(), snapshotRoot: path.join(root, 'snapshots') });
  try {
    const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout;
    await git('init', '-q', '-b', 'feature'); await git('config', 'user.name', 'test'); await git('config', 'user.email', 'test@example.com');
    await writeFile(path.join(root, 'code.ts'), 'const version = 0;\n'); await git('add', 'code.ts'); await git('commit', '-qm', 'base');
    await writeFile(path.join(root, 'code.ts'), 'const version = 1;\n');
    const review = store.createReview({ source: 'local-worktree', sourceRef: '', repoPath: root, currentRound: 0, status: 'reviewing' });
    const discussion = manager.addUserDiscussion(review.id, { file: 'code.ts', line: 1 });
    const note = await manager.sendMessage(review.id, discussion.id, '原来的批注', 'note');
    const edited = manager.editMessage(review.id, note.id, '修改后的批注', note.text);
    assert.equal(edited.id, note.id); assert.equal(edited.createdAt, note.createdAt);
    assert.equal(store.listMessages(discussion.id).length, 1); assert.equal(starts, 0);
    assert.throws(() => manager.editMessage(review.id, note.id, '另一个修改', note.text), /已被修改/);
    assert.throws(() => manager.editMessage(review.id, note.id, ' ', edited.text), /不能为空/);
    const other = store.createReview({ source: 'local-worktree', sourceRef: '', repoPath: root });
    assert.throws(() => manager.editMessage(other.id, note.id, '串号', edited.text), /不属于/);
    const agentMessage = store.addMessage(discussion.id, 'agent', '模型回复');
    assert.throws(() => manager.editMessage(review.id, agentMessage.id, '改模型', agentMessage.text), /不属于/);
    assert.equal(new SharedSessionReader(store, root).context(review.id, 'http://127.0.0.1/test').discussions[0].messages[0].text, edited.text);
    await manager.sendMessage(review.id, discussion.id, '这段代码是什么？', 'agent');
    assert.equal(starts, 1); assert.equal(turns, 1); assert.ok(observed[0].includes('version = 1'));
    assert.equal(store.getReview(review.id)!.currentRound, 0); assert.equal(store.listFindings(review.id).length, 0);
    await writeFile(path.join(root, 'code.ts'), 'const version = 2;\n');
    await manager.sendMessage(review.id, discussion.id, '现在的代码是什么？', 'agent');
    assert.equal(resumes, 1); assert.ok(observed[1].includes('version = 2'), 'follow-up must read current code after edits');
    await manager.sendMessage(review.id, discussion.id, '继续解释代码', 'agent');
    assert.equal(resumes, 1, 'unchanged context must reuse the warm conversation');
    assert.equal(store.getReview(review.id)!.currentRound, 0); assert.equal(store.getReview(review.id)!.status, 'reviewing');
    console.log('remarks/chat: edit identity/CAS/scope/role/no-agent/share visibility/new chat/current code/warm reuse/no scan passed');
  } finally { await manager.disposeAll(); db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
