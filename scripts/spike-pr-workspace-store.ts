/** 工作区切换迁移与事务验证;不起 agent,不访问远端。 */
import { strict as assert } from 'node:assert';
import { openDatabase } from '../src/backend/db/database';
import { migrate } from '../src/backend/db/schema';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';

async function main() {
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', repoPath: '/original', status: 'reviewing' });
  const finding = store.addFinding(review.id, { severity: 'high', title: 'existing issue', body: 'keep context', file: 'code.ts', line: 1 });
  store.setTriage(finding.id, 'dismiss', 'existing reviewer decision');
  store.addMessage(finding.discussionId, 'user', 'existing discussion');
  store.setDiff(review.id, 'old remote diff');
  // 模拟旧版库,新增列只能追加迁移,存量 PR 默认仍用远端。
  db.exec('ALTER TABLE discussions DROP COLUMN side; ALTER TABLE findings DROP COLUMN side; ALTER TABLE reviews DROP COLUMN workspace_missing_files; DROP TABLE review_shares; DROP TABLE workspace_finding_links; DROP TABLE workspace_views; DROP INDEX idx_reviews_workspace; ALTER TABLE reviews DROP COLUMN workspace_remote_id; ALTER TABLE reviews DROP COLUMN workspace_snapshot_tree; ALTER TABLE reviews DROP COLUMN local_review; ALTER TABLE reviews DROP COLUMN local_base_ref; ALTER TABLE review_rounds DROP COLUMN scan_diff;');
  db.pragma(`user_version = ${25}`);
  migrate(db);
  assert.equal(store.getReview(review.id)!.localReview, false);
  store.setReviewWorkspace(review.id, '/linked', false, null);
  assert.equal(store.getReview(review.id)!.repoPath, '/linked');
  const local = { ...store.getReview(review.id)!, localReview: true, localBaseRef: 'base-sha' };
  store.recordWorkspaceRound(local, 2, { headSha: 'local-tree', note: 'local review' }, 'local diff');
  assert.equal(store.getReview(review.id)!.localReview, true);
  assert.equal(store.getReview(review.id)!.sourceRef, 'acme/repo#1');
  assert.equal(store.getRawDiff(review.id), 'local diff');
  assert.equal(store.getRound(review.id, 2)!.headSha, 'local-tree');
  assert.equal(store.getFinding(finding.id)!.dismissReason, 'existing reviewer decision');
  assert.equal(store.listMessages(finding.discussionId)[0].text, 'existing discussion');
  const manager = new ReviewManager(store);
  assert.equal((await manager.submitReview(review.id, { event: 'comment' })).status, 'failed', 'local tree must not be sent as GitHub commit_id');
  const remote = { ...store.getReview(review.id)!, localReview: false, localBaseRef: null };
  db.exec("CREATE TEMP TRIGGER reject_round BEFORE INSERT ON review_rounds BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => store.recordWorkspaceRound(remote, 3, { headSha: 'remote-commit' }, 'new remote diff'), /test failure/);
  assert.equal(store.getReview(review.id)!.localReview, true, 'failed round must roll back mode');
  assert.equal(store.getRawDiff(review.id), 'local diff', 'failed round must roll back snapshot');
  assert.equal(store.getReview(review.id)!.currentRound, 2);
  db.exec('DROP TRIGGER reject_round;');
  store.recordWorkspaceRound(remote, 3, { headSha: 'remote-commit' }, 'new remote diff');
  assert.equal(store.getReview(review.id)!.localReview, false);
  assert.equal(store.getRawDiff(review.id), 'new remote diff');
  assert.equal(store.listFindings(review.id).length, 1);
  assert.equal(store.listRounds(review.id).length, 2);
  db.close();
  console.log('PR workspace store: migration/history/mode/snapshot/round transaction/rollback/local submission guard passed');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
