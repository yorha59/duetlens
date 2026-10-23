/** 实际临时 Git 仓库与 bare 远端验证;不接触用户工作区、不访问 GitHub。 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Review } from '../src/shared/domain';
import { parseUnifiedDiff } from '../src/shared/diff';
import { githubRepository, PrWorkspace, type WorkspaceRun } from '../src/backend/source/pr-workspace';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';

const exec = promisify(execFile);
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-pr-workspace-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const url = 'git@github.com:acme/repo.git';
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout;
  let failPush = false;
  let pushCalls = 0;
  const run: WorkspaceRun = async (cmd, args, cwd) => {
    assert.equal(cmd, 'git');
    if (['push', 'fetch', 'ls-remote'].includes(args[0])) {
      if (args[0] === 'push') {
        pushCalls++;
        assert.ok(!args.some((arg) => /force|^\+/.test(arg)), 'must never force-push');
        if (failPush) throw Object.assign(new Error('test network failure'), { stderr: 'test network failure' });
      }
      args = args.map((arg) => arg === url || arg === 'https://github.com/acme/repo.git' ? remote : arg);
    }
    return git(cwd ?? root, ...args);
  };
  try {
    await git(root, 'init', '--bare', '-q', remote);
    await git(root, 'init', '-q', '-b', 'main', repo);
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'test');
    await writeFile(path.join(repo, 'base.ts'), 'base\n');
    await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'base');
    const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await git(repo, 'remote', 'add', 'origin', url);
    await git(repo, 'push', '-q', remote, 'main');
    await git(repo, 'switch', '-qc', 'feature');
    await writeFile(path.join(repo, 'pr.ts'), 'original PR commit\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'PR');
    await git(repo, 'push', '-q', remote, 'feature');
    const service = new PrWorkspace(run, async () => ({
      state: 'open', html_url: 'https://github.com/acme/repo/pull/1',
      head: { ref: 'feature', sha: (await git(root, '--git-dir', remote, 'rev-parse', 'feature')).trim(), repo: { full_name: 'acme/repo' } },
      base: { sha: base, repo: { full_name: 'acme/repo' } },
    }));
    const review: Review = {
      id: 'test', source: 'github-pr', sourceRef: 'acme/repo#1', baseRef: null, headRef: null,
      parentReviewId: null, repoPath: repo, localReview: true, localBaseRef: base, agent: 'codex', agentSessionId: null,
      model: null, reasoningEffort: null, intensity: 'standard', title: 'test', status: 'reviewing', summaryBody: null,
      summaryFiles: [], summaryRound: null, currentRound: 1, createdAt: 0, updatedAt: 0,
    };
    assert.equal(githubRepository('https://github.com/ACME/repo.git'), 'acme/repo');
    assert.equal(githubRepository('ssh://git@github.com/acme/repo.git'), 'acme/repo');
    assert.equal(githubRepository('https://github.com.evil.test/acme/repo.git'), null);
    assert.equal(githubRepository('https://token@github.com/acme/repo.git'), null);
    await assert.rejects(service.inspect({ ...review, headRef: base }, repo), /整个 PR/);
    await git(repo, 'remote', 'set-url', 'origin', 'git@github.com:other/repo.git');
    await assert.rejects(service.inspect(review, repo), /来源仓库/);
    await git(repo, 'remote', 'set-url', 'origin', url);
    await git(repo, 'switch', '-q', 'main');
    await assert.rejects(service.syncCode(review, 'push'), /来源分支/);
    await git(repo, 'switch', '-q', 'feature');
    await writeFile(path.join(repo, 'committed.ts'), 'local commit\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'local commit');
    await writeFile(path.join(repo, 'base.ts'), 'staged\n'); await git(repo, 'add', 'base.ts');
    await writeFile(path.join(repo, 'base.ts'), 'final working tree\n');
    await writeFile(path.join(repo, '新增 文件.ts'), 'new file\n');
    await writeFile(path.join(repo, 'ignored.txt'), 'ignored\n');
    const index = await readFile(path.join(repo, '.git/index'));
    const local = await service.localTarget(review, repo);
    const snapshot = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: local.repoPath, baseRef: local.base });
    try {
      await snapshot.prepare();
      const files = parseUnifiedDiff(await snapshot.getDiff()).map((file) => file.path);
      assert.ok(files.includes('pr.ts') && files.includes('committed.ts') && files.includes('base.ts'));
      assert.equal(await snapshot.getFile('base.ts'), 'final working tree\n');
    } finally { await snapshot.dispose(); }
    const before = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const dirty = await git(repo, 'status', '--porcelain=v1');
    failPush = true;
    await assert.rejects(service.syncCode(review, 'push'), /test network failure/);
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), before);
    failPush = false;
    const result = await service.syncCode(review, 'push');
    assert.equal(result.commit, before, 'push must never create a commit');
    assert.equal((await git(root, '--git-dir', remote, 'rev-parse', 'feature')).trim(), before);
    assert.equal((await git(root, '--git-dir', remote, 'rev-parse', 'main')).trim(), base);
    assert.equal(await git(repo, 'status', '--porcelain=v1'), dirty, 'push preserves dirty files');
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), index, 'push preserves staged changes');
    assert.equal(await readFile(path.join(repo, '新增 文件.ts'), 'utf8'), 'new file\n');
    await assert.rejects(service.syncCode(review, 'pull'), /未提交改动/);
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), before);
    assert.equal(pushCalls, 2);
    // 仅清理测试生成的临时仓库,然后验证真正的远端拉取。
    await git(repo, 'reset', '--hard', 'HEAD'); await rm(path.join(repo, '新增 文件.ts'));
    const other = path.join(root, 'other');
    await git(root, 'clone', '-q', '--branch', 'feature', remote, other);
    await git(other, 'config', 'user.email', 'test@example.com'); await git(other, 'config', 'user.name', 'test');
    await writeFile(path.join(other, 'remote.ts'), 'new remote commit\n');
    await git(other, 'add', '.'); await git(other, 'commit', '-qm', 'remote moved'); await git(other, 'push', '-q');
    await assert.rejects(service.syncCode(review, 'push'), /落后|分叉/);
    const pulled = await service.syncCode(review, 'pull');
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), pulled.commit);
    assert.equal(await readFile(path.join(repo, 'remote.ts'), 'utf8'), 'new remote commit\n');
    assert.equal((await service.syncStatus(review)).pending, false);
    await writeFile(path.join(repo, 'local.ts'), 'local ahead\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'local ahead');
    const ahead = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await service.syncCode(review, 'pull');
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), ahead, 'pull must preserve local commits');
    await writeFile(path.join(other, 'remote.ts'), 'remote diverged\n');
    await git(other, 'commit', '-qam', 'remote diverged'); await git(other, 'push', '-q');
    await assert.rejects(service.syncCode(review, 'pull'), /分叉/);
    await assert.rejects(service.syncCode(review, 'push'), /分叉/);
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), ahead, 'divergence must not change local HEAD');
    assert.equal(await git(repo, 'status', '--porcelain'), '');
    console.log('PR workspace: identity/branch/baseline/push existing commits/dirty preservation/pull fast-forward/divergence protection passed');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
