import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec';

/** 只查 HEAD、变化路径和文件元数据,代码没变时不创建快照或扫描整棵代码树。 */
export async function worktreeFingerprint(repo: string): Promise<string> {
  const git = (args: string[]) => run('git', ['--no-optional-locks', ...args], repo);
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const changed = await git(['diff', '--no-ext-diff', '--name-only', '-z', head, '--']);
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = [...new Set((changed + untracked).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256').update(head);
  for (const file of paths) {
    hash.update(file);
    try { const stat = await lstat(path.join(repo, file), { bigint: true }); hash.update(`${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update('deleted'); }
  }
  return hash.digest('hex');
}
