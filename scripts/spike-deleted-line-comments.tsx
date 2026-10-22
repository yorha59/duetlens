import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { SharedSessionReader } from '../src/backend/share/session-reader';
import { parseUnifiedDiff } from '../src/shared/diff';
import { buildPrReviewPayload, isStaleAnchor } from '../src/shared/github-review';
const require = createRequire(import.meta.url);
require.extensions['.css'] = () => {};
const exec = promisify(execFile);
async function main() {
 const { DiffPane } = await import('../src/renderer/screens/review/DiffPane');
 const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-deleted-comments-'));
 const repo = path.join(root, 'repo'); const dbPath = path.join(root, 'test.db');
 let db = openDatabase(dbPath);
 const previousError = console.error;
 console.error = (message, ...rest) => { if (!String(message).includes('useLayoutEffect does nothing on the server')) previousError(message, ...rest); };
 try {
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout;
  await exec('git', ['init', '-qb', 'main', repo]);
  await git('config', 'user.name', 'test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(repo, 'deleted.ts'), 'old first\nold second\n');
  await git('add', '.'); await git('commit', '-qm', 'base');
  const store = new ReviewStore(db);
  const review = store.createReview({ source: 'local-worktree', sourceRef: repo, repoPath: repo, status: 'reviewing' });
  const historical = store.addFinding(review.id, { file: 'deleted.ts', line: 1, title: 'historical new-side finding', body: 'prior issue', severity: 'medium' });
  await rm(path.join(repo, 'deleted.ts'));
  let agents = 0;
  const snapshotRoot = path.join(root, 'snapshots');
  const manager = new ReviewManager(store, undefined, { snapshotRoot, agentFactory: () => { agents++; throw Error('must not run'); } });
  await manager.refreshLocal(review.id);
  assert.equal(manager.getFindings(review.id).length, 0, 'deleted historical new-side findings stay hidden');
  const discussion = manager.addUserDiscussion(review.id, { file: 'deleted.ts', line: 2, side: 'old' });
  await manager.sendMessage(review.id, discussion.id, '这段为什么删除？', 'note');
  const finding = manager.addManualFinding(review.id, { file: 'deleted.ts', line: 1, side: 'old', severity: 'medium', title: 'deletion needs review' });
  await manager.refreshLocal(review.id);
  assert.equal(manager.getDiscussions(review.id).find(d => d.id === discussion.id)?.side, 'old');
  assert.deepEqual(manager.getFindings(review.id).map(f => f.id), [finding.id]);
  assert.equal(store.getFinding(historical.id)?.side, 'new');
  assert.equal(store.getDiscussion(finding.discussionId)?.side, 'old');
  const shared = new SharedSessionReader(store, snapshotRoot).context(review.id, 'http://127.0.0.1/test');
  assert.equal(shared.discussions.find(d => d.id === discussion.id)?.messages[0].text, '这段为什么删除？');
  assert.equal(shared.findings[0].side, 'old');
  const diff = manager.getDiff(review.id);
  assert.equal(isStaleAnchor(finding, diff, 1), false);
  assert.equal(buildPrReviewPayload(store.getReview(review.id)!, [finding], 'comment', '', diff).comments[0].side, 'LEFT');
  for (const view of ['unified', 'split'] as const) {
   const html = renderToStaticMarkup(<DiffPane files={diff} findings={manager.getFindings(review.id)} discussions={manager.getDiscussions(review.id)} activePath="deleted.ts" focusFindingId={null} view={view} viewed={new Set()} collapsed={new Set()} onToggleViewed={() => {}} onToggleCollapsed={() => {}} onStartDiscussion={async () => {}} />);
   assert.equal((html.match(/title="批注这一行"/g) ?? []).length, 2, `${view}: every deleted line must have a comment entry`);
   assert(html.includes('deletion needs review'), `${view}: old-side finding must render inline`);
   assert(html.includes('anchor human'), `${view}: deletion discussion has an anchor dot`);
  }
  const paired = parseUnifiedDiff('diff --git a/paired.ts b/paired.ts\n--- a/paired.ts\n+++ b/paired.ts\n@@ -1 +1 @@\n-old value\n+new value\n');
  for (const view of ['unified', 'split'] as const) {
   const both = [{ ...finding, id: 'old', file: 'paired.ts', title: 'old-side-card' }, { ...finding, id: 'new', file: 'paired.ts', side: 'new' as const, title: 'new-side-card' }];
   const html = renderToStaticMarkup(<DiffPane files={paired} findings={both} discussions={[]} activePath="paired.ts" focusFindingId={null} view={view} viewed={new Set()} collapsed={new Set()} onToggleViewed={() => {}} onToggleCollapsed={() => {}} onStartDiscussion={async () => {}} />);
   assert(html.includes('old-side-card') && html.includes('new-side-card'), `${view}: same-number old and new anchors must both render`);
   assert.equal((html.match(/title="批注这一行"/g) ?? []).length, 2);
  }
  const promoted = manager.promoteDiscussion(review.id, discussion.id);
  assert.equal(promoted.side, 'old');
  db.close(); db = openDatabase(dbPath);
  assert.equal(new ReviewStore(db).getDiscussion(discussion.id)?.side, 'old', 'side survives reopen');
  assert.equal(new ReviewStore(db).getFinding(promoted.id)?.side, 'old');
  assert.equal(agents, 0, 'saving deletion comments never runs an agent');
  console.log('deleted-line comments: unified/split entry and inline cards, save/refresh/reopen/share/promotion, historical hiding, LEFT payload, zero agents passed');
 } finally { console.error = previousError; db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
