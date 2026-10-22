/** 真实 blob:none 克隆:旧版 shared clone 会遍历缺失历史对象,快照只应取必要对象。 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';
import { parseUnifiedDiff } from '../src/shared/diff';

const exec = promisify(execFile);
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-partial-clone-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'partial');
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout;
  let snapshot: LocalWorktreeSource | undefined;
  try {
    await git(root, 'init', '-q', '-b', 'main', seed);
    await git(seed, 'config', 'user.name', 'test');
    await git(seed, 'config', 'user.email', 'test@example.com');
    await writeFile(path.join(seed, 'code.ts'), 'old version\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-qm', 'base');
    const base = (await git(seed, 'rev-parse', 'HEAD')).trim();
    const oldBlob = (await git(seed, 'rev-parse', 'HEAD:code.ts')).trim();
    await git(seed, 'switch', '-qc', 'feature');
    await writeFile(path.join(seed, 'code.ts'), 'PR version\n');
    await git(seed, 'commit', '-qam', 'PR change');
    await git(root, 'clone', '-q', '--bare', seed, remote);
    await git(root, '--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true');
    await git(root, '--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    await git(root, 'clone', '-q', '--filter=blob:none', '--branch', 'feature', `file://${remote}`, repo);
    assert.equal((await git(repo, 'config', '--get', 'remote.origin.promisor')).trim(), 'true');
    assert.ok((await git(repo, 'rev-list', '--objects', '--all', '--missing=print')).includes(`?${oldBlob}`), 'fixture must have a missing historical blob');
    await writeFile(path.join(repo, 'code.ts'), 'local working version\n');
    await writeFile(path.join(repo, 'new.ts'), 'new untracked file\n');
    await git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    const index = await readFile(path.join(repo, '.git/index'));
    const config = await readFile(path.join(repo, '.git/config'));
    const packs = await readdir(path.join(repo, '.git/objects/pack'));
    snapshot = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: repo, baseRef: 'origin/main' });
    const prepared = await snapshot.prepare();
    const diff = await snapshot.getDiff();
    assert.ok(diff.includes('-old version') && diff.includes('+local working version'));
    assert.deepEqual(parseUnifiedDiff(diff).map((file) => file.path).sort(), ['code.ts', 'new.ts']);
    assert.equal(await snapshot.getFile('code.ts'), 'local working version\n');
    assert.equal(await readFile(path.join(prepared.cwd, 'code.ts'), 'utf8'), 'local working version\n');
    assert.ok((await snapshot.searchCode({ query: 'local working version' })).files.some((file) => file.path === 'code.ts'));
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), index);
    assert.deepEqual(await readFile(path.join(repo, '.git/config')), config);
    assert.deepEqual(await readdir(path.join(repo, '.git/objects/pack')), packs, 'lazy fetch must write only to temporary snapshot');
    assert.ok((await git(repo, 'rev-list', '--objects', '--all', '--missing=print')).includes(`?${oldBlob}`));
    const shallowRepo = path.join(root, 'shallow');
    await git(root, 'clone', '-q', '--depth=1', '--branch', 'feature', `file://${remote}`, shallowRepo);
    const shallowSource = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: shallowRepo });
    try { await shallowSource.prepare(); assert.equal(await shallowSource.getDiff(), ''); }
    finally { await shallowSource.dispose(); }
    console.log('partial clone snapshot: missing historical blob/local changes/search/temporary lazy fetch/source index and config preserved passed');
  } finally { await snapshot?.dispose(); await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
