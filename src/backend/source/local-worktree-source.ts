import { execFile } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveTool } from '../config/tool-paths';
import { run } from './exec';
import { archiveSnapshotObjects } from './snapshot-archive';
import { gitGrep } from './git-grep';
import type { CodeSearchInput, PreparedSource, ReviewTarget, Source } from './source';

const exec = promisify(execFile);

/** 暂存区 + 工作区相对 HEAD 的最终内容;只在临时仓库写索引和对象,不碰用户仓库。 */
export class LocalWorktreeSource implements Source {
  private snapshot = '';
  private tree = '';
  private base = '';
  private originalObjects = '';

  constructor(private readonly target: ReviewTarget) {}

  async prepare(): Promise<PreparedSource> {
    await this.dispose();
    const repo = await realpath((await run('git', ['--no-optional-locks', '-C', this.target.repoPath, 'rev-parse', '--show-toplevel'])).trim());
    this.snapshot = await mkdtemp(path.join(os.tmpdir(), 'duetlens-worktree-'));
    try {
      // 不用 clone:对 blob:none 部分克隆,clone 会尝试打包历史中尚未下载的对象,
      // 而 upload-pack 禁止懒加载,会错误地报「仓库损坏」。只借用现有对象目录,
      // 缺少的必要对象由临时库自己的 promisor remote 按需获取,不扫描全部历史。
      const format = (await run('git', ['--no-optional-locks', '-C', repo, 'rev-parse', '--show-object-format'])).trim();
      await this.git(['init', '--quiet', `--object-format=${format}`]);
      const objects = (await run('git', ['--no-optional-locks', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim();
      this.originalObjects = objects;
      const alternates = [objects];
      if (this.target.snapshotPath) {
        const archivedObjects = path.join(this.target.snapshotPath, 'objects');
        try { await access(archivedObjects); alternates.push(archivedObjects); } catch { /* 首轮还没有归档。 */ }
      }
      await writeFile(path.join(this.snapshot, '.git/objects/info/alternates'), alternates.join('\n') + '\n');
      const shallow = (await run('git', ['--no-optional-locks', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'shallow'])).trim();
      try { await writeFile(path.join(this.snapshot, '.git/shallow'), await readFile(shallow)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const remotes = (await run('git', ['--no-optional-locks', '-C', repo, 'remote'])).trim().split('\n').filter(Boolean);
      for (const remote of remotes) {
        let promisor = '';
        try { promisor = (await run('git', ['--no-optional-locks', '-C', repo, 'config', '--bool', '--get', `remote.${remote}.promisor`])).trim(); }
        catch { /* 普通 remote 无此配置。 */ }
        if (promisor !== 'true') continue;
        const url = (await run('git', ['--no-optional-locks', '-C', repo, 'remote', 'get-url', remote])).trim();
        await this.git(['config', `remote.${remote}.url`, url]);
        await this.git(['config', `remote.${remote}.promisor`, 'true']);
        await this.git(['config', `remote.${remote}.partialclonefilter`, 'blob:none']);
      }
      let head = '';
      try {
        head = (await run('git', ['--no-optional-locks', '-C', repo, 'rev-parse', '--verify', 'HEAD'])).trim();
      } catch {
        // 刚初始化、尚无首个提交的仓库也可审。
      }
      const baseCommit = this.target.baseRef && head
        ? (await run('git', ['--no-optional-locks', '-C', repo, 'rev-parse', '--verify', '--end-of-options', `${this.target.baseRef}^{commit}`])).trim()
        : '';
      this.base = baseCommit
        ? (await this.git(['merge-base', head, baseCommit])).trim()
        : head || (await this.git(['hash-object', '-t', 'tree', '--stdin'], '')).trim();
      if (head) {
        await this.git(['update-ref', 'HEAD', head]);
        await this.git(['read-tree', head]);
      }
      const tracked = await run('git', ['--no-optional-locks', '-C', repo, ...(head
        ? ['diff', '--no-ext-diff', '--name-only', '-z', head, '--']
        : ['ls-files', '--cached', '-z'])]);
      const untracked = await run('git', ['--no-optional-locks', '-C', repo, 'ls-files', '--others', '--exclude-standard', '-z']);
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
      if (this.target.materialize !== false) await this.git(['checkout-index', '--all', '--force']);
      return { title: `未提交改动 · ${path.basename(repo)}`, cwd: this.snapshot, headSha: this.tree };
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async getDiff(): Promise<string> {
    return this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', this.base, this.tree, '--']);
  }

  getDiffSince(previousHead: string): Promise<string> {
    return this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', previousHead, this.tree, '--']);
  }

  saveSnapshot(directory: string): Promise<void> {
    return archiveSnapshotObjects(path.join(this.snapshot, '.git'), directory, this.originalObjects);
  }

  async hasFile(file: string): Promise<boolean> {
    return !!(await this.git(['ls-tree', '-z', this.tree, '--', `:(literal)${file}`])).length;
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
