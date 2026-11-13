/** 走真实 HTTP、ReviewManager、SQLite 和 Python 客户端，仅使用临时审核。 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { SharedSessionReader } from '../src/backend/share/session-reader';
import { SessionShareServer } from '../src/backend/share/session-share-server';
import type { ReviewEvent } from '../src/shared/ipc';

const exec = promisify(execFile);

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'duetlens-writeback-'));
  const dbPath = path.join(dir, 'review.db');
  let db = openDatabase(dbPath);
  let store = new ReviewStore(db);
  const events: ReviewEvent[] = [];
  const snapshots = path.join(dir, 'snapshots');
  const portPath = path.join(dir, 'share-server.json');
  function makeServer() {
    const manager = new ReviewManager(store, undefined, {
      snapshotRoot: snapshots,
      agentFactory: () => { throw new Error('writeback must never start agent'); },
    });
    manager.on('review-event', (event: ReviewEvent) => events.push(event));
    return new SessionShareServer(store, new SharedSessionReader(store, snapshots), portPath,
      (id) => manager.refreshLocal(id), undefined,
      (id, input, assertShare, assertVersion) => manager.writeSharedReview(id, input, assertShare, assertVersion));
  }
  let server = makeServer();
  try {
    const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', status: 'reviewing' });
    store.startRound(review.id, 1, { headSha: 'a'.repeat(40) });
    store.finishRound(review.id, 1, 'done');
    const findingInput = { title: 'Issue', severity: 'low' as const, body: 'Original finding', file: 'code.ts', line: 1 };
    const finding = store.addFinding(review.id, findingInput);
    const dismissed = store.addFinding(review.id, { ...findingInput, line: 2 });
    store.setTriage(dismissed.id, 'dismiss', 'Keep manual decision');
    const note = store.addMessage(finding.discussionId, 'user', 'Original note', 'note');
    const other = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#2' });
    const otherFinding = store.addFinding(other.id, findingInput);
    const { url } = await server.share(review.id);
    const get = async (shareUrl = url) => {
      const res = await fetch(shareUrl);
      assert.equal(res.status, 200);
      return res.json() as Promise<ReturnType<SharedSessionReader['context']> & { access: { writeback: boolean } }>;
    };
    const expected = (context: Awaited<ReturnType<typeof get>>) => ({
      reviewId: context.review.id, head: context.review.head, round: context.review.round,
      base: context.review.baseRef, repositoryPath: context.repository.path, updatedAt: context.review.updatedAt,
    });
    const post = (body: unknown, headers = {}, endpoint = url) => fetch(`${endpoint}/writeback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const readReceipt = async (res: Response) => {
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      return data;
    };
    const context = await get();
    assert.equal(context.access.writeback, true);
    assert.equal(context.access.readOnly, false);
    const reply = { kind: 'reply', discussionId: finding.discussionId, text: '已修复并验证', requestId: 'reply-1', confirm: true, expected: expected(context) };
    assert.equal((await post({ ...reply, confirm: false })).status, 400);
    assert.equal((await post(reply, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ ...reply, discussionId: otherFinding.discussionId })).status, 404);
    assert.equal((await post({ ...reply, expected: { ...reply.expected, reviewId: other.id } })).status, 409);
    assert.equal((await fetch(`${url}/writeback`)).status, 405);
    const [first, second] = await Promise.all([post(reply).then(readReceipt), post(reply).then(readReceipt)]);
    assert.equal(first.messageId, second.messageId);
    assert.notEqual(first.replayed, second.replayed);
    assert.deepEqual(store.listMessages(finding.discussionId).map(({ role, kind, text }) => ({ role, kind, text })), [
      { role: 'user', kind: 'note', text: 'Original note' },
      { role: 'agent', kind: 'chat', text: reply.text },
    ]);
    assert.equal(store.listMessages(finding.discussionId)[0].id, note.id);
    assert.equal((await post({ ...reply, requestId: 'new-id' })).status, 409, 'old version cannot write');
    assert.equal((await post({ ...reply, text: 'Conflicting text' })).status, 409, 'request IDs cannot be reused for different writes');

    const fresh = await get();
    const fix = { kind: 'mark-fixed', findingId: finding.id, text: 'Targeted tests passed', requestId: 'fix-1', confirm: true, expected: expected(fresh) };
    assert.equal((await post({ ...fix, findingId: otherFinding.id })).status, 404);
    assert.equal((await post({ ...fix, findingId: dismissed.id })).status, 422);
    assert.equal(store.getFinding(dismissed.id)?.dismissReason, 'Keep manual decision');
    assert.equal((await post({ ...fix, expected: { ...fix.expected, head: 'b'.repeat(40) } })).status, 409);
    assert.equal((await post(fix).then(readReceipt)).alreadyFixed, false);
    const fixed = store.getFinding(finding.id)!;
    assert.equal(fixed.body, finding.body);
    assert.equal(fixed.discussionId, finding.discussionId);
    assert.equal(fixed.resolution, 'fixed');
    assert.equal(fixed.resolutionNote, fix.text);
    assert.equal(fixed.autoClosed, true);
    assert.equal(fixed.triage, 'dismiss');
    const current = await get();
    assert.equal((await post({ ...fix, text: 'Do not overwrite', requestId: 'fix-2', expected: expected(current) }).then(readReceipt)).alreadyFixed, true);
    assert.equal(store.getFinding(finding.id)?.resolutionNote, fix.text);
    assert.deepEqual(events.map(event => event.type), ['message', 'finding']);

    await server.close();
    db.close();
    db = openDatabase(dbPath);
    store = new ReviewStore(db);
    server = makeServer();
    await server.start();
    assert.equal((await post(reply).then(readReceipt)).replayed, true);
    assert.equal((await post(fix).then(readReceipt)).replayed, true);
    assert.equal(events.length, 2, 'replayed requests never emit UI events');
    const cli = path.resolve(__dirname, '../skills/duetlens/scripts/duetlens.py');
    const call = async (...args: string[]) => JSON.parse((await exec('python3', [cli, ...args], { cwd: dir })).stdout);
    const replyArgs = ['reply', url, '--discussion-id', finding.discussionId, '--text', '第二条回复'];
    await assert.rejects(call(...replyArgs), /--confirm/);
    const added = await call(...replyArgs, '--confirm');
    assert.equal((await call(...replyArgs, '--confirm')).messageId, added.messageId);
    assert.equal(store.listMessages(finding.discussionId).length, 3);
    assert.equal((await call('mark-fixed', url, '--finding-id', finding.id, '--text', '验证通过', '--confirm')).alreadyFixed, true);
    assert.equal((await call('context', url)).access.deleteNote, true);
    const digest = createHash('sha256').update(note.text).digest('hex');
    const sibling = store.addMessage(finding.discussionId, 'user', 'Another note', 'note');
    const remove = { kind: 'delete-note', messageId: note.id, sha256: digest, replyRequestId: reply.requestId,
      requestId: 'delete-1', confirm: true, expected: expected(await get()) };
    assert.equal((await post(remove)).status, 422, 'generic reply does not qualify');
    assert.equal((await post({ ...remove, kind: 'delete-finding' })).status, 400);
    const targetedArgs = [...replyArgs.slice(0, -1), '处理原批注', '--message-id', note.id, '--note-sha256', digest, '--confirm'];
    const targeted = await call(...targetedArgs);
    const authorized = { ...remove, replyRequestId: targeted.requestId, expected: expected(await get()) };
    assert.equal((await post({ ...authorized, confirm: false })).status, 400);
    assert.equal((await post({ ...authorized, messageId: sibling.id })).status, 422);
    const otherShare = await server.share(other.id);
    assert.equal((await post({ ...authorized, expected: expected(await get(otherShare.url)) }, {}, otherShare.url)).status, 422);
    const removedReplyNote = store.addMessage(dismissed.discussionId, 'user', 'Note with cleared reply', 'note');
    const removedReplyDigest = createHash('sha256').update(removedReplyNote.text).digest('hex');
    const removedReply = await call('reply', url, '--discussion-id', dismissed.discussionId,
      '--message-id', removedReplyNote.id, '--note-sha256', removedReplyDigest, '--text', 'Processed', '--confirm');
    store.clearMessages(dismissed.discussionId, 'chat');
    assert.equal((await post({ ...authorized, messageId: removedReplyNote.id, sha256: removedReplyDigest,
      replyRequestId: removedReply.requestId, expected: expected(await get()) })).status, 422);
    assert.equal(store.listMessages(dismissed.discussionId)[0].id, removedReplyNote.id);

    assert.equal((await post({ ...authorized, expected: remove.expected })).status, 409);
    store.updateUserMessage(review.id, note.id, 'Edited by user', note.text);
    assert.equal((await post({ ...authorized, expected: expected(await get()) })).status, 409, 'a reply to old text cannot authorize deletion');
    store.updateUserMessage(review.id, note.id, note.text, 'Edited by user');
    const deleteArgs = ['delete-note', url, '--message-id', note.id, '--note-sha256', digest,
      '--reply-request-id', targeted.requestId, '--request-id', authorized.requestId, '--confirm'];
    const removed = await call(...deleteArgs);
    assert.equal(removed.messageId, note.id);
    assert.equal((await call(...deleteArgs)).replayed, true);
    const remaining = store.listMessages(finding.discussionId);
    assert(!remaining.some(message => message.id === note.id));
    assert(remaining.some(message => message.id === sibling.id));
    assert(remaining.some(message => message.id === targeted.messageId));
    assert.equal(events.filter(event => event.type === 'message-deleted').length, 1);
    await server.close();
    db.close();
    db = openDatabase(dbPath);
    store = new ReviewStore(db);
    server = makeServer();
    await server.start();
    assert.equal((await call(...deleteArgs)).replayed, true);
    store.setReviewStatus(review.id, 'scanning');
    assert.equal((await post({ ...reply, requestId: 'while-busy', expected: expected(await get()) })).status, 422);

    // 本地版本在客户端 GET 和 POST 之间变化时，刷新后拒绝旧写入。
    const repo = path.join(dir, 'repo');
    await mkdir(repo);
    const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
    await git('init', '-q', '-b', 'feature');
    await writeFile(path.join(repo, 'code.ts'), 'base\n');
    await git('add', 'code.ts');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
    const local = store.createReview({ source: 'local-worktree', sourceRef: repo, repoPath: repo, status: 'reviewing', baseRef: await git('rev-parse', 'HEAD') });
    const localDiscussion = store.addUserDiscussion(local.id);
    const localShare = await server.share(local.id);
    const localVersion = expected(await get(localShare.url));
    await writeFile(path.join(repo, 'code.ts'), 'changed\n');
    const localReply = { ...reply, discussionId: localDiscussion.id, expected: localVersion };
    const staleLocal = await post(localReply, {}, localShare.url);
    assert.equal(staleLocal.status, 409, await staleLocal.text());
    assert.equal(store.listMessages(localDiscussion.id).length, 0);
    assert.equal((await post({ ...localReply, expected: expected(await get(localShare.url)) }, {}, localShare.url).then(readReceipt)).replayed, false);

    server.revoke(review.id);
    assert.equal((await post(reply)).status, 404);
    console.log('share writeback: scope, CAS, durable replay, note history, finding disposition, CLI and local refresh passed');
  } finally {
    await server.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
