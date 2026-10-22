/** 真实 git 仓库验证,无需 agent 登录或原生数据库依赖。 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalWorktreeSource } from '../src/backend/source/local-worktree-source';
import { parseUnifiedDiff } from '../src/shared/diff';

async function main() {
const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-worktree-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const source = new LocalWorktreeSource({ source: 'local-worktree', ref: '未提交改动', repoPath: root });
try {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  await writeFile(path.join(root, 'tracked.ts'), 'base\n');
  await writeFile(path.join(root, 'deleted.ts'), 'gone\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  await writeFile(path.join(root, 'tracked.ts'), 'staged\n');
  git('add', 'tracked.ts');
  await writeFile(path.join(root, 'tracked.ts'), 'working tree\n');
  await rm(path.join(root, 'deleted.ts'));
  await writeFile(path.join(root, '新增 文件.ts'), 'new content\n');
  await writeFile(path.join(root, 'ignored.txt'), 'secret\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 255, 1, 2]));
  await symlink('/outside/not-readable', path.join(root, 'link'));
  const status = git('status', '--porcelain=v1', '-z');
  const index = await readFile(path.join(root, '.git/index'));
  const prepared = await source.prepare();
  const diff = await source.getDiff();
  const paths = parseUnifiedDiff(diff).map((file) => file.path);
  for (const file of ['tracked.ts', 'deleted.ts', '新增 文件.ts', 'binary.bin', 'link']) assert.ok(paths.includes(file), file);
  assert.ok(!paths.includes('ignored.txt'));
  assert.equal(await source.getFile('tracked.ts'), 'working tree\n');
  assert.equal(await source.getFile('新增 文件.ts'), 'new content\n');
  assert.equal(await source.getFile('link'), '/outside/not-readable');
  await assert.rejects(source.getFile('deleted.ts'));
  await assert.rejects(source.getFile('../ignored.txt'));
  assert.ok((await source.searchCode({ query: 'working tree' })).files.some((file) => file.path === 'tracked.ts'));
  await writeFile(path.join(root, 'tracked.ts'), 'edited during review\n');
  assert.equal(await source.getFile('tracked.ts'), 'working tree\n');
  assert.equal(await source.getDiff(), diff);
  assert.equal(await readFile(path.join(prepared.cwd, 'tracked.ts'), 'utf8'), 'working tree\n');
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
  await writeFile(path.join(root, 'tracked.ts'), 'working tree\n');
  assert.equal(git('status', '--porcelain=v1', '-z'), status);
  const snapshotPath = prepared.cwd;
  await source.dispose();
  await assert.rejects(readFile(path.join(snapshotPath, 'tracked.ts')));

  // 无改动以及尚无首个提交,都不应被当成 git 故障。
  git('reset', '--hard', '-q', 'HEAD');
  git('clean', '-fdq');
  await source.prepare();
  assert.equal(await source.getDiff(), '');
  await source.dispose();
  await rm(path.join(root, '.git'), { recursive: true });
  git('init', '-q');
  await source.prepare();
  assert.ok((await source.getDiff()).includes('tracked.ts'));
  console.log('worktree source: staged/unstaged/untracked/deleted/binary/symlink/snapshot/readonly/empty/unborn passed');
} finally {
  await source.dispose();
  await rm(root, { recursive: true, force: true });
}

}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
