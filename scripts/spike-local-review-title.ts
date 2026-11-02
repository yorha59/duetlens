/** 本地备注与删除回归:临时数据库,不调用 agent,不触碰用户仓库。 */
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/backend/db/database';
import { migrate, SCHEMA_VERSION } from '../src/backend/db/schema';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import type { ReviewEvent } from '../src/shared/ipc';

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'duetlens-title-test-'));
  let db = openDatabase(path.join(dir, 'reviews.db'));
  try {
    let store = new ReviewStore(db);
    const remote = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', title: 'Original PR', status: 'reviewing' });
    // 重放上一版本迁移,既有原始标题和数据不能丢失。
    db.exec('ALTER TABLE reviews DROP COLUMN local_title; PRAGMA user_version=36');
    migrate(db);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(store.getReview(remote.id)!.title, 'Original PR');
    assert.equal(store.getReview(remote.id)!.localTitle, null);
    const local = store.createWorkspaceLocal(remote.id, '/unused', 'base', 'diff', 'tree');
    const child = store.createReview({ source: 'github-pr', sourceRef: remote.sourceRef, parentReviewId: remote.id, headRef: 'abc', title: 'Commit title' });
    const finding = store.addFinding(remote.id, { severity: 'low', title: 'Keep finding', body: 'Body', file: 'a.ts', line: 1 });
    store.addMessage(finding.discussionId, 'user', 'Keep note');
    const events: ReviewEvent[] = [];
    const manager = new ReviewManager(store, undefined, { agentFactory: () => { throw new Error('must never start agent'); } });
    manager.on('review-event', event => events.push(event));
    assert.equal(manager.setLocalTitle(local.id, '  草稿需求  ').localTitle, '草稿需求');
    for (const id of [remote.id, local.id, child.id]) {
      assert.equal(store.getReview(id)!.localTitle, '草稿需求');
      assert(events.some(event => event.reviewId === id && event.type === 'review'));
    }
    assert.equal(store.getReview(remote.id)!.title, 'Original PR');
    assert.equal(store.getReview(remote.id)!.sourceRef, remote.sourceRef);
    assert.equal(store.listRecentReviews()[0].localTitle, '草稿需求');
    const later = store.createReview({ source: 'github-pr', sourceRef: remote.sourceRef, parentReviewId: remote.id, headRef: 'def' });
    assert.equal(store.getReview(later.id)!.localTitle, '草稿需求');
    assert.throws(() => manager.setLocalTitle(remote.id, 'x'.repeat(121)), /120/);
    assert.throws(() => manager.setLocalTitle('missing', 'label'), /不存在/);
    db.close();
    db = openDatabase(path.join(dir, 'reviews.db'));
    store = new ReviewStore(db);
    assert.equal(store.getReview(remote.id)!.localTitle, '草稿需求', 'label survives restart');
    const next = new ReviewManager(store);
    next.setLocalTitle(child.id, ' ');
    assert.equal(store.getReview(remote.id)!.localTitle, null);
    assert.equal(store.listMessages(finding.discussionId)[0].text, 'Keep note');
    next.on('review-event', event => events.push(event));
    await next.deleteReview(remote.id);
    assert.equal(store.listReviews().length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM findings').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM messages').pluck().get(), 0);
    const deleted = events.find(event => event.type === 'deleted');
    assert(deleted?.type === 'deleted');
    assert.deepEqual(new Set(deleted.reviewIds), new Set([remote.id, local.id, child.id, later.id]));
    console.log('local review titles: migration, persistence, view inheritance, original metadata, validation, events and deletion cascade passed');
  } finally {
    if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
