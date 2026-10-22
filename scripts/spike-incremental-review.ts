/** 真实快照增量与编排验证;agentFactory 是失败哨兵,绝不启动真实 agent。 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';
import { findingTouchesDelta, shiftedFindingLine } from '../src/shared/incremental-review';
import { parseUnifiedDiff } from '../src/shared/diff';
import { buildRerunPrompt } from '../src/backend/prompt/rerun-prompt';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-incremental-'));
  const repo = path.join(root, 'repo');
  const snapshots = path.join(root, 'snapshots');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(repo, 'code.ts'), 'const base = 1;\n');
  await writeFile(path.join(repo, 'unchanged.ts'), 'const untouched = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'local-worktree', sourceRef: 'local', repoPath: repo, status: 'completed' });
  const archive = path.join(snapshots, review.id);
  const target = { source: 'local-worktree' as const, ref: '', repoPath: repo, snapshotPath: archive };
  let source = new LocalWorktreeSource(target);
  try {
    await writeFile(path.join(repo, 'code.ts'), 'const base = 1;\nconst reviewedEarlier = true;\n');
    await writeFile(path.join(repo, 'reverted.ts'), 'added last round\n');
    const first = await source.prepare();
    const firstDiff = await source.getDiff();
    store.setDiff(review.id, firstDiff);
    store.startRound(review.id, 1, { headSha: first.headSha });
    store.finishRound(review.id, 1, 'done');
    await source.saveSnapshot(archive);
    const skipped = store.addFinding(review.id, { severity: 'high', title: 'old issue', body: 'retain', file: 'unchanged.ts', line: 1 });
    await source.dispose();
    let agentStarts = 0;
    const manager = new ReviewManager(store, undefined, { snapshotRoot: snapshots, agentFactory: () => { agentStarts++; throw new Error('TEST_AGENT_STOP'); } });
    await assert.rejects(manager.rerunReview(review.id), /NO_REVIEW_CHANGES/);
    assert.equal(agentStarts, 0);
    assert.equal(store.getReview(review.id)!.currentRound, 1);
    await writeFile(path.join(repo, 'code.ts'), 'const base = 1;\nconst reviewedEarlier = true;\nconst onlyNewChange = true;\n');
    await rm(path.join(repo, 'reverted.ts'));
    source = new LocalWorktreeSource(target); // 模拟重启,上轮临时目录已删除。
    await source.prepare();
    const delta = await source.getDiffSince(first.headSha!);
    assert.ok(delta.includes('+const onlyNewChange'));
    assert.ok(!delta.includes('+const reviewedEarlier'), 'old additions must not be re-reviewed');
    assert.ok(!delta.includes('unchanged.ts'));
    const sample = parseUnifiedDiff('diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -10,1 +10,2 @@\n old\n+new\n');
    assert.equal(findingTouchesDelta({ file: 'file.ts', line: 10 }, sample), true);
    assert.equal(findingTouchesDelta({ file: 'file.ts', line: 50 }, sample), false);
    assert.equal(shiftedFindingLine({ file: 'file.ts', line: 50 }, sample), 51);
    assert.equal(parseUnifiedDiff(delta).find((file) => file.path === 'reverted.ts')!.status, 'deleted');
    await source.dispose();
    await assert.rejects(manager.rerunReview(review.id), /TEST_AGENT_STOP/);
    assert.equal(agentStarts, 1);
    const round = store.getRound(review.id, 2)!;
    assert.equal(round.incremental, true);
    assert.deepEqual(round.changedFiles.sort(), ['code.ts', 'reverted.ts']);
    assert.equal(store.getRoundScanDiff(review.id, 2), delta);
    assert.ok(store.getRawDiff(review.id)!.includes('+const reviewedEarlier'), 'UI keeps full diff');
    assert.equal(store.getFinding(skipped.id)!.lastSeenRound, 1, 'unchanged finding must not pretend to be reverified');
    const prompt = buildRerunPrompt({ round: 2, prevRound: store.getRound(review.id, 1), headSha: round.headSha, changedFiles: round.changedFiles, codeChanged: true, openFindings: [], dismissedFindings: [], messagesByDiscussion: {}, pr: null, incremental: true, skippedFindings: 1 });
    assert.ok(prompt.includes('禁止重新通读未变化文件'));
    assert.ok(prompt.includes('跳过 1 条'));
    assert.ok(!prompt.includes('但不要只看这些'));
    assert.ok(!prompt.includes('对此前遗漏的问题'));
    await assert.rejects(manager.rerunReview(review.id), /上一轮未完整完成/);
    assert.equal(agentStarts, 1, 'failed scan must not become an incremental baseline');
    assert.equal(store.getReview(review.id)!.currentRound, 2);
    // Full review remains an explicit escape hatch and supplies the entire patch.
    store.setReviewStatus(review.id, 'completed');
    await assert.rejects(manager.rerunReview(review.id, { fullReview: true }), /TEST_AGENT_STOP/);
    assert.equal(store.getRoundScanDiff(review.id, 3), null);
    assert.equal(store.getFinding(skipped.id)!.lastSeenRound, 1);
    console.log('incremental review: durable tree/delta-only/revert/unchanged files/no-change zero agents/full UI diff/persisted scope/history/full fallback passed');
  } finally { await source.dispose(); db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
