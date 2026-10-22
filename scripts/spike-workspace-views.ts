/** 临时 Git/bare 仓库 + SQLite 验证;不访问 GitHub,不启动真实 agent。 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSubmittable } from '../src/shared/github-review';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { PrWorkspace } from '../src/backend/source/pr-workspace';
import { createSource } from '../src/backend/source/create-source';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';

const exec = promisify(execFile);
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-views-'));
  const repo = path.join(root, 'repo');
  const bare = path.join(root, 'remote.git');
  const url = 'git@github.com:acme/repo.git';
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout;
  const db = openDatabase(':memory:');
  try {
    await git(root, 'init', '--bare', '-q', bare);
    await git(root, 'init', '-q', '-b', 'feature', repo);
    await git(repo, 'config', 'user.name', 'test'); await git(repo, 'config', 'user.email', 'test@example.com');
    await writeFile(path.join(repo, 'code.ts'), 'const base = 1;\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'base');
    const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await writeFile(path.join(repo, 'code.ts'), 'const base = 1;\nconst remote = 2;\n');
    await git(repo, 'commit', '-qam', 'PR'); await git(repo, 'push', '-q', bare, 'feature');
    await git(repo, 'remote', 'add', 'origin', url);
    const remoteHead = async () => (await git(root, '--git-dir', bare, 'rev-parse', 'feature')).trim();
    const workspace = new PrWorkspace(async (cmd, args, cwd) => {
      assert.equal(cmd, 'git');
      return git(cwd ?? root, ...args.map((arg) => arg === url ? bare : arg));
    }, async () => ({ state: 'open', html_url: 'https://github.com/acme/repo/pull/1', head: { ref: 'feature', sha: await remoteHead(), repo: { full_name: 'acme/repo' } }, base: { sha: base, repo: { full_name: 'acme/repo' } } }));
    const store = new ReviewStore(db);
    const remote = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', repoPath: repo, status: 'reviewing' });
    const remoteDiff = await git(repo, 'diff', base, 'HEAD');
    store.setDiff(remote.id, remoteDiff);
    store.startRound(remote.id, 1, { headSha: await remoteHead() }); store.finishRound(remote.id, 1, 'done');
    const original = store.addFinding(remote.id, { title: 'remote-only', body: 'remote conclusion', file: 'code.ts', line: 2, severity: 'medium' });
    store.addMessage(original.discussionId, 'user', 'remote thread');
    store.writeAgentSummary(remote.id, 'remote summary', []);
    let agentStarts = 0;
    const manager = new ReviewManager(store, undefined, {
      prWorkspace: workspace, snapshotRoot: path.join(root, 'snapshots'),
      agentFactory: () => { agentStarts++; throw new Error('must not start'); },
      sourceFactory: (target) => target.source !== 'github-pr' ? createSource(target) : {
        prepare: async () => ({ cwd: repo, title: 'PR', headSha: await remoteHead() }),
        getDiff: async () => git(repo, 'diff', base, await remoteHead()),
        getFile: async (file) => readFile(path.join(repo, file), 'utf8'), dispose: async () => {},
      },
    });
    const index = await readFile(path.join(repo, '.git/index'));
    await writeFile(path.join(repo, 'code.ts'), 'const base = 1;\nconst remote = 2;\nconst local = 3;\n');
    const state = await manager.switchWorkspace(remote.id, 'local');
    assert.ok(state.localId); const localId = state.localId!;
    assert.equal(agentStarts, 0);
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), index, 'switch must preserve index');
    assert.equal(store.getReview(localId)!.currentRound, 0);
    assert.equal(store.listFindings(localId).length, 0);
    assert.equal(store.getRawDiff(remote.id), remoteDiff);
    assert.ok(store.getRawDiff(localId)!.includes('+const local'));
    assert.equal((await manager.syncStatus(remote.id)).pending, true);
    assert.equal(store.listRecentReviews().length, 1, 'local view must not duplicate history cards');
    assert.equal(store.listChildren(remote.id).length, 0, 'local view must not become a commit scope');
    const snapshot = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: repo, baseRef: base });
    const prepared = await snapshot.prepare(); await snapshot.dispose();
    store.startRound(localId, 1, { headSha: prepared.headSha }); store.finishRound(localId, 1, 'done');
    const localFinding = store.addFinding(localId, { title: 'local-only', body: 'local conclusion', file: 'code.ts', line: 3, severity: 'high' });
    store.addMessage(localFinding.discussionId, 'user', 'local thread');
    store.setFindingResolution(localFinding.id, 1, 'still_present', 'current local evidence');
    store.writeAgentSummary(localId, 'local summary', []);
    store.setReviewStatus(localId, 'scanning');
    assert.equal((await manager.switchWorkspace(remote.id, 'remote')).activeMode, 'remote', 'view switches even while other side scans');
    assert.equal(store.listMessages(original.discussionId)[0].text, 'remote thread');
    assert.equal((await manager.switchWorkspace(remote.id, 'local')).localId, localId);
    assert.equal(store.listMessages(localFinding.discussionId)[0].text, 'local thread');
    store.setReviewStatus(localId, 'reviewing');
    await assert.rejects(manager.applyLocal(remote.id), /先将本地代码同步/);
    const plan = await manager.syncPlan(localId);
    const pushed = await manager.syncPush(localId, plan.token, 'sync local');
    assert.equal((await manager.workspaceState(remote.id)).syncedCommit, pushed.commit);
    assert.equal((await manager.syncStatus(remote.id)).pending, false);
    // 审核内容不匹配时,同步成功也不能误把旧结论用于新代码。
    const before = store.getReview(remote.id)!.currentRound;
    db.prepare('UPDATE review_rounds SET head_sha = ? WHERE review_id = ?').run(base, localId);
    await assert.rejects(manager.applyLocal(remote.id), /审核快照与已推送代码不同/);
    assert.equal(store.getReview(remote.id)!.currentRound, before);
    db.prepare('UPDATE review_rounds SET head_sha = ? WHERE review_id = ?').run(prepared.headSha!, localId);
    const updated = await manager.applyLocal(remote.id);
    assert.equal(updated.summaryBody, 'local summary');
    assert.equal(store.getFinding(original.id)!.triage, 'dismiss');
    assert.equal(store.listMessages(original.discussionId)[0].text, 'remote thread');
    const imported = store.listFindings(remote.id).find((f) => f.title === 'local-only')!;
    assert.ok(imported && imported.id !== localFinding.id && imported.discussionId !== localFinding.discussionId);
    assert.equal(imported.submission, 'unsubmitted');
    assert.equal(imported.body, 'current local evidence');
    assert.equal(store.listMessages(imported.discussionId).length, 0, 'conclusion copy must not merge local chat into remote');
    store.setSubmission(imported.id, 'submitted', 'https://github.com/acme/repo/pull/1#comment');
    store.addMessage(imported.discussionId, 'user', 'remote imported thread');
    await manager.applyLocal(remote.id);
    assert.equal(store.listFindings(remote.id).length, 2, 'reapply must not duplicate findings');
    assert.equal(store.getFinding(imported.id)!.submission, 'submitted', 'manual GitHub submission identity survives reapply');
    assert.equal(isSubmittable(store.getFinding(imported.id)!, store.getReview(remote.id)!.currentRound), false, 'unchanged reapply must not create a fresh GitHub follow-up');
    assert.equal(store.getFinding(imported.id)!.body, 'current local evidence');
    assert.equal(store.listMessages(imported.discussionId)[0].text, 'remote imported thread');
    assert.equal(store.listMessages(localFinding.discussionId)[0].text, 'local thread');
    // 并发数据库失败必须整体回滚,不能只归档旧结论。
    db.exec("CREATE TEMP TRIGGER reject_apply BEFORE INSERT ON review_rounds BEGIN SELECT RAISE(ABORT, 'rollback'); END;");
    assert.throws(() => store.applyWorkspaceConclusions(localId, pushed.commit, 'invalid'), /rollback/);
    assert.equal(store.getReview(remote.id)!.summaryBody, 'local summary');
    db.exec('DROP TRIGGER reject_apply');
    // 老版本混合状态保留所有消息、finding ID、轮次与进度,移到本地侧。
    const legacy = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#2', repoPath: repo, status: 'reviewing' });
    store.setReviewWorkspace(legacy.id, repo, true, base); store.setDiff(legacy.id, 'legacy local diff');
    store.startRound(legacy.id, 1, { headSha: prepared.headSha }); store.finishRound(legacy.id, 1, 'done');
    const old = store.addFinding(legacy.id, { title: 'legacy', body: 'preserve', file: 'code.ts', line: 1, severity: 'low' });
    store.addMessage(old.discussionId, 'user', 'legacy thread');
    const migrated = await manager.workspaceState(legacy.id);
    assert.equal(migrated.activeMode, 'local'); assert.ok(migrated.localId);
    assert.equal(store.getFinding(old.id)!.reviewId, migrated.localId);
    assert.equal(store.listMessages(old.discussionId)[0].text, 'legacy thread');
    assert.equal(store.getReview(legacy.id)!.currentRound, 0);
    assert.equal(store.getRawDiff(migrated.localId!), 'legacy local diff');
    assert.equal(store.listRounds(migrated.localId!).length, 1);
    assert.equal(agentStarts, 0);
    await manager.deleteReview(remote.id);
    assert.equal(store.getReview(localId), null, 'deleting root must cascade local view');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    console.log('workspace views: isolation, no-agent switch, lightweight status, push, verified conclusion overwrite, submission identity, rollback, legacy migration and cascade passed');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
