import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveTool } from '../config/tool-paths';
import { run } from './exec';
import { gitGrep } from './git-grep';
import type { CodeSearchInput, PreparedSource, ReviewTarget, Source } from './source';

const exec = promisify(execFile);

/** 暂存区 + 工作区相对 HEAD 的最终内容;只在临时仓库写索引和对象,不碰用户仓库。 */
export class LocalWorktreeSource implements Source {
  private snapshot = '';
  private tree = '';
  private base = '';

  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    await this.dispose();
    const repo = await realpath((await run('git', ['-C', this.target.repoPath, 'rev-parse', '--show-toplevel'])).trim());
    this.snapshot = await mkdtemp(path.join(os.tmpdir(), 'duetlens-worktree-'));
    try {
      // shared clone 仅在临时库记录源对象目录,无需复制整个历史,也不改变原库的 HEAD/index。
      await run('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', repo, this.snapshot]);
      let head = '';
      try {
        head = (await run('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD'])).trim();
      } catch {
        // 刚初始化、尚无首个提交的仓库也可审。
      }
      this.base = this.target.baseRef && head
        ? (await this.git(['merge-base', head, this.target.baseRef])).trim()
        : head || (await this.git(['hash-object', '-t', 'tree', '--stdin'], '')).trim();
      if (head) await this.git(['read-tree', head]);
      const tracked = await run('git', ['-C', repo, ...(head
        ? ['diff', '--no-ext-diff', '--name-only', '-z', head, '--']
        : ['ls-files', '--cached', '-z'])]);
      const untracked = await run('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard', '-z']);
      const files = new Set((tracked + untracked).split('\0').filter(Boolean));
      for (const file of files) {
        const absolute = path.join(repo, file);
        let stat;
        try {
          stat = await lstat(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await this.git(['update-index', '--force-remove', '--', file]);
          continue;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          throw new Error(`暂不支持审核子模块或特殊文件的未提交改动: ${file}`);
        }
        const bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
        const hash = (await this.git(['hash-object', '-w', '--stdin'], bytes)).trim();
        const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
        await this.git(['update-index', '--add', '--cacheinfo', mode, hash, file]);
      }
      this.tree = (await this.git(['write-tree'])).trim();
      // agent 的 cwd 也是本轮快照,普通只读工具与 MCP 看到同一份代码。
      await this.git(['checkout-index', '--all', '--force']);
      return { title: `未提交改动 · ${path.basename(repo)}`, cwd: this.snapshot, headSha: this.tree };
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async getDiff(): Promise<string> {
    return this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', this.base, this.tree, '--']);
  }

  async getFile(file: string): Promise<string> {
    return this.git(['show', `${this.tree}:${file}`]);
  }

  searchCode(input: CodeSearchInput) {
    return gitGrep(this.snapshot, input.query, { treeish: this.tree, pathPrefix: input.pathPrefix });
  }

  async dispose(): Promise<void> {
    if (this.snapshot) await rm(this.snapshot, { recursive: true, force: true });
    this.snapshot = '';
    this.tree = '';
    this.base = '';
  }

  private async git(args: string[], input?: string | Buffer): Promise<string> {
    const child = exec(resolveTool('git'), ['-C', this.snapshot, '-c', 'core.quotepath=false', ...args], { maxBuffer: 64 * 1024 * 1024 });
    if (input !== undefined) child.child.stdin?.end(input);
    return (await child).stdout;
  }
}
