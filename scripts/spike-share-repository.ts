/** 实际 HTTP → ReviewManager → PrWorkspace,只操作临时 Git 和数据库。 */
import { request } from 'node:http';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { PrWorkspace, type WorkspaceRun } from '../src/backend/source/pr-workspace';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';
import { SessionShareServer } from '../src/backend/share/session-share-server';
import { SharedSessionReader } from '../src/backend/share/session-reader';

const exec = promisify(execFile);
async function main() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'duetlens-bind-http-')));
  const db = openDatabase(':memory:');
  const store = new ReviewStore(db);
  const commands: string[][] = [];
  const run: WorkspaceRun = async (cmd, args, cwd) => { commands.push([cmd, ...args]); return (await exec(cmd, args, { cwd })).stdout; };
  let duringInspect: (() => void) | undefined;
  let prBase = 'b'.repeat(40);
  const snapshots = path.join(root, 'snapshots');
  let duringArchive: (() => void) | undefined;
  const workspace = new PrWorkspace(run, async () => { duringInspect?.(); return { state: 'open', html_url: 'https://github.com/acme/repo/pull/1', head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'acme/repo' } }, base: { sha: prBase } }; });
  const manager = new ReviewManager(store, undefined, { prWorkspace: workspace, snapshotRoot: snapshots,
    sourceFactory: target => {
      const source = new LocalWorktreeSource(target);
      const save = source.saveSnapshot.bind(source);
      source.saveSnapshot = async directory => {
        await save(directory);
        duringArchive?.();
      };
      return source;
    },
    agentFactory: () => { throw new Error('must never start agent'); } });
  const reader = new SharedSessionReader(store, snapshots);
  let refreshes = 0;
  const server = new SessionShareServer(store, reader, path.join(root, 'port.json'), async () => { refreshes++; }, (id, directory, guard) => manager.attachWorkspace(id, directory, guard));
  try {
    const repos = await Promise.all(['old', 'new', 'wrong'].map(async name => {
      const dir = path.join(root, name); await mkdir(dir);
      const git = async (...args: string[]) => (await exec('git', args, { cwd: dir })).stdout;
      await git('init', '-q', '-b', 'feature'); await git('config', 'user.name', 'test'); await git('config', 'user.email', 'test@example.com');
      await writeFile(path.join(dir, 'code.ts'), 'original\n'); await git('add', '.'); await git('commit', '-qm', 'base');
      await git('remote', 'add', 'origin', `https://github.com/acme/${name === 'wrong' ? 'other' : 'repo'}.git`);
      await writeFile(path.join(dir, 'code.ts'), 'dirty\n');
      return dir;
    }));
    const before = await Promise.all(repos.map(async cwd => (await exec('git', ['diff', '--binary', 'HEAD'], { cwd })).stdout));
    const review = store.createReview({ source: 'github-pr', sourceRef: 'acme/repo#1', repoPath: repos[0], status: 'reviewing' });
    store.startRound(review.id, 1, { headSha: 'a'.repeat(40) }); store.finishRound(review.id, 1, 'done');
    const finding = store.addFinding(review.id, { title: 'Keep', severity: 'low', body: 'Body', file: 'code.ts', line: 1 });
    store.addMessage(finding.discussionId, 'user', 'Keep comment');
    const share = await server.share(review.id);
    const context = async () => (await (await fetch(share.url)).json());
    const expected = (c: Awaited<ReturnType<typeof context>>) => ({ reviewId: c.review.id, head: c.review.head, round: c.review.round, base: c.review.baseRef, repositoryPath: c.repository.path, updatedAt: c.review.updatedAt });
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${share.url}/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const first = await context();
    assert.equal(first.access.bindRepository, true);
    const input = { repoPath: repos[1], expected: expected(first) };
    assert.equal((await post(input, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => { const req = request(`${share.url}/repository`, { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end(JSON.stringify(input)); });
    assert.equal(wrongHost, 403);
    assert.equal((await post(input, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ repoPath: '../bad', expected: input.expected })).status, 400);
    assert.equal((await post({ repoPath: repos[1] })).status, 400);
    assert.equal((await post({ ...input, padding: 'x'.repeat(17000) })).status, 413);
    assert.equal((await fetch(`${share.url}/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(share.url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${share.url}/repository`)).status, 405);
    for (const patch of [{ reviewId: 'other' }, { head: 'c'.repeat(40) }, { round: 99 }, { base: 'wrong' }, { repositoryPath: '/wrong' }, { updatedAt: 0 }]) {
      assert.equal((await post({ ...input, expected: { ...input.expected, ...patch } })).status, 409);
    }
    assert.equal((await post({ ...input, repoPath: repos[2] })).status, 422, 'foreign repository rejected by domain logic');
    const refreshedBefore = refreshes;
    const response = await post(input); assert.equal(response.status, 200, await response.clone().text());
    const updated = await response.json();
    assert.equal(updated.repository.path, repos[1]);
    assert.equal(updated.review.id, review.id); assert.equal(updated.review.head, first.review.head); assert.equal(updated.review.round, first.review.round);
    assert.equal(updated.discussions[0].messages[0].text, 'Keep comment');
    assert.equal(refreshes, refreshedBefore, 'POST never refreshes workspace or starts scan');
    assert.equal((await post(input)).status, 409, 'replay uses stale old directory');
    assert(commands.every(args => !['fetch', 'pull', 'push', 'checkout', 'commit', 'add'].some(op => args.includes(op))), 'binding must never mutate Git');
    for (let i = 0; i < repos.length; i++) assert.equal((await exec('git', ['diff', '--binary', 'HEAD'], { cwd: repos[i] })).stdout, before[i]);
    const client = path.resolve(__dirname, '../skills/duetlens/scripts/duetlens.py');
    const bindClient = async (directory: string) => JSON.parse((await exec('python3', [client, 'bind-repository', share.url, '--repo-path', directory, '--confirm'], { cwd: root })).stdout);
    assert.equal((await bindClient(repos[0])).repository.path, repos[0]);
    assert.equal((await bindClient(repos[1])).repository.path, repos[1]);
    store.setReviewStatus(review.id, 'scanning');
    const busy = await context();
    assert.equal((await post({ repoPath: repos[0], expected: expected(busy) })).status, 422);
    store.setReviewStatus(review.id, 'reviewing');
    const race = await context();
    duringInspect = () => { store.startRound(review.id, 2, { headSha: 'c'.repeat(40) }); store.finishRound(review.id, 2, 'done'); };
    assert.equal((await post({ repoPath: repos[0], expected: expected(race) })).status, 409, 'revision changing during inspect cannot commit');
    assert.equal(store.getReview(review.id)!.repoPath, repos[1]);
    duringInspect = undefined;
    const current = await context();
    duringInspect = () => server.revoke(review.id);
    assert.equal((await post({ repoPath: repos[0], expected: expected(current) })).status, 404, 'revoked during inspect cannot commit');
    assert.equal(store.getReview(review.id)!.repoPath, repos[1]);
    duringInspect = undefined;
    const second = await server.share(review.id);
    assert.notEqual(second.url, share.url);
    prBase = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repos[0] })).stdout.trim();
    const oldSource = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: repos[1], materialize: false });
    await writeFile(path.join(repos[1], 'code.ts'), 'previous review snapshot\n');
    const oldSnapshot = await oldSource.prepare();
    const local = store.createWorkspaceLocal(review.id, repos[1], prBase, await oldSource.getDiff(), oldSnapshot.headSha!);
    store.startRound(local.id, 1, { headSha: oldSnapshot.headSha });
    store.finishRound(local.id, 1, 'done');
    await oldSource.saveSnapshot(path.join(snapshots, local.id));
    await oldSource.dispose();
    store.setWorkspaceMode(review.id, 'local');
    store.setSyncedCommit(review.id, prBase);
    const discussion = manager.addUserDiscussion(local.id);
    const message = store.addMessage(discussion.id, 'user', 'Keep local history', 'note');
    const c = reader.context(review.id, second.url);
    const refusal = await fetch(`${second.url}/repository`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath: repos[0], expected: expected(c) }) });
    assert.equal(refusal.status, 422, 'existing independent local review cannot be silently retargeted');
    assert.equal(store.getReview(review.id)!.repoPath, repos[1]);
    const localShare = await server.share(local.id);
    const localExpected = expected(reader.context(local.id, localShare.url));
    const localPost = (url: string, version: typeof localExpected) => fetch(`${url}/repository`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repos[0], expected: version }),
    });
    assert.equal((await localPost(localShare.url, { ...localExpected, reviewId: review.id })).status, 409);
    const alternateFile = path.join(snapshots, local.id, 'objects/info/alternates');
    const originalAlternates = await readFile(alternateFile, 'utf8');
    duringArchive = () => server.revoke(local.id);
    assert.equal((await localPost(localShare.url, localExpected)).status, 404);
    assert.equal(await readFile(alternateFile, 'utf8'), originalAlternates);
    assert.equal(store.getReview(local.id)!.repoPath, repos[1]);
    assert.equal(store.getReview(review.id)!.repoPath, repos[1]);
    duringArchive = undefined;
    const retryShare = await server.share(local.id);
    const retryVersion = expected(reader.context(local.id, retryShare.url));
    await rename(repos[1], path.join(root, 'retired'));
    const changed = await localPost(retryShare.url, retryVersion);
    assert.equal(changed.status, 200, await changed.clone().text());
    const updatedLocal = await changed.json();
    assert.equal(updatedLocal.review.id, local.id);
    assert.equal(updatedLocal.review.mode, 'local');
    assert.equal(updatedLocal.review.round, 1);
    assert.equal(updatedLocal.review.reviewedHead, oldSnapshot.headSha);
    assert.notEqual(updatedLocal.review.head, oldSnapshot.headSha);
    assert.equal(updatedLocal.repository.path, repos[0]);
    assert.equal(store.getReview(review.id)!.repoPath, repos[0]);
    assert.equal(updatedLocal.discussions.find((item: { id: string }) => item.id === discussion.id).messages[0].id, message.id);
    assert.deepEqual(store.getWorkspaceState(review.id), { remoteId: review.id, localId: local.id, activeMode: 'local', syncedCommit: null });
    assert.equal((await localPost(retryShare.url, retryVersion)).status, 409);
    assert.equal((await (await fetch(retryShare.url)).json()).repository.path, repos[0]);
    const file = updatedLocal.files.find((item: { path: string }) => item.path === 'code.ts');
    assert.equal((await (await fetch(file.url)).json()).content, 'dirty\n');
    assert.equal((await exec('git', ['diff', '--binary', 'HEAD'], { cwd: repos[0] })).stdout, before[0]);
    console.log('local share rebind: scope and CAS, revoked-token archive rollback, removed old directory, retained review/history, new snapshot passed');
    console.log('repository HTTP: version/CAS, host/origin/token gates, bounded JSON, domain validation, revocation during inspect, read-only Git, preserved messages and local-view protection passed');
  } finally { await server.close(); db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
