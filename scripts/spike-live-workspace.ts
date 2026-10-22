/** 真 Git 工作区:新增后删除文件、结论随文件隐藏/恢复、无变化零快照、不启动模型。 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { SharedSessionReader } from '../src/backend/share/session-reader';
import { createSource } from '../src/backend/source/create-source';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';
const exec = promisify(execFile);
async function main() {
 const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-live-'));
 const repo = path.join(root, 'repo'); const snapshots = path.join(root, 'snapshots');
 const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout;
 const db = openDatabase(':memory:');
 try {
  await exec('git', ['init', '-q', '-b', 'main', repo]); await git('config', 'user.name', 'test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(repo, 'keep.ts'), 'base\n'); await git('add', '.'); await git('commit', '-qm', 'base');
  const base = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(path.join(repo, 'ad-review.policy.ts'), 'old reviewed policy\n');
  const source = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: repo });
  const prepared = await source.prepare(); const raw = await source.getDiff();
  const store = new ReviewStore(db);
  const remote = store.createReview({ source: 'github-pr', sourceRef: 'test/repo#1', baseRef: base, repoPath: repo, status: 'reviewing' });
  const local = store.createWorkspaceLocal(remote.id, repo, base, raw, prepared.headSha!);
  store.startRound(local.id, 1, { headSha: prepared.headSha }); store.finishRound(local.id, 1, 'done');
  await source.saveSnapshot(path.join(snapshots, local.id)); await source.dispose();
  const finding = store.addFinding(local.id, { severity: 'medium', title: 'old finding', body: 'policy issue', file: 'ad-review.policy.ts', line: 1 });
  store.addMessage(finding.discussionId, 'user', 'old comment');
  let snapshotsMade = 0; let agents = 0; let workspaceEvents = 0;
  const manager = new ReviewManager(store, undefined, { snapshotRoot: snapshots,
   sourceFactory: (target) => { assert.equal(target.materialize, false); snapshotsMade++; return createSource(target); },
   agentFactory: () => { agents++; throw new Error('must not run'); },
  });
  manager.on('review-event', (event) => { if (event.type === 'workspace') workspaceEvents++; });
  await manager.refreshLocal(local.id);
  const initial = snapshotsMade;
  await manager.refreshLocal(local.id); assert.equal(snapshotsMade, initial, 'unchanged poll must not snapshot');
  const index = await readFile(path.join(repo, '.git/index'));
  await rm(path.join(repo, 'ad-review.policy.ts'));
  assert.equal((await manager.refreshLocal(local.id)).changed, true);
  assert.equal(manager.getDiff(local.id).some((file) => file.path === 'ad-review.policy.ts'), false, 'new-then-deleted file must vanish from current PR diff');
  assert.equal(manager.getFindings(local.id).length, 0);
  assert.equal(manager.getDiscussions(local.id).length, 0);
  assert.equal(store.listFindings(local.id).length, 1, 'history is recoverable');
  assert.equal(store.getRound(local.id, 1)!.headSha, prepared.headSha, 'review baseline must remain unchanged');
  assert.equal(store.getReview(local.id)!.currentRound, 1);
  const reader = new SharedSessionReader(store, snapshots);
  const shared = reader.context(local.id, 'http://127.0.0.1/test');
  assert.equal(shared.findings.length, 0); assert.equal(shared.discussions.length, 0);
  assert.equal(shared.files.some((file) => file.path === 'ad-review.policy.ts'), false);
  assert.notEqual(shared.review.head, shared.review.reviewedHead);
  await writeFile(path.join(repo, 'keep.ts'), 'edited now\n');
  await manager.refreshLocal(local.id);
  assert.equal(await manager.getFileContent(local.id, 'keep.ts'), 'edited now\n');
  const sharedNew = reader.context(local.id, 'http://127.0.0.1/test');
  const file = await reader.file(local.id, 'keep.ts', sharedNew.review.head, '1');
  assert.equal(file.content, 'edited now\n'); assert.equal(file.contentSource, 'workspace-snapshot');
  await writeFile(path.join(repo, 'ad-review.policy.ts'), 'restored file\n');
  await manager.refreshLocal(local.id);
  assert.equal(manager.getFindings(local.id)[0].id, finding.id, 'restored file restores its history');
  assert.deepEqual(await readFile(path.join(repo, '.git/index')), index, 'refresh never stages files');
  assert.equal(agents, 0); assert.ok(workspaceEvents >= 3);
  store.setReviewStatus(local.id, 'scanning');
  assert.equal((await manager.refreshLocal(local.id)).deferred, true, 'active scan must retain pinned source');
  console.log('live workspace: actual diff/deleted-file findings and comments/restore/current file and share/no-change fast path/review baseline/index preserved/zero agents passed');
 } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
