import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Review } from '@shared/domain';
import type { CodeSyncDirection, CodeSyncResult, CodeSyncPreview } from '@shared/ipc';
import { resolveTool } from '../config/tool-paths';
import { resolvePrRef } from './github-pr-source';

const exec = promisify(execFile);
export type WorkspaceRun = (cmd: string, args: string[], cwd?: string) => Promise<string>;
const boundedRun: WorkspaceRun = async (cmd, args, cwd) =>
  (await exec(resolveTool(cmd), args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

export interface WorkspacePr {
  state: string;
  html_url: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref?: string; sha: string; repo?: { full_name: string } };
}

/** 仅接受 GitHub 仓库 URL;比较身份不依赖 remote 名字,也不把凭据传到界面。 */
export function githubRepository(url: string): string | null {
  const match = url.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return match?.[1].toLowerCase() ?? null;
}

export class PrWorkspace {
  private readonly baseMetadata = new Map<string, { at: number; pr: WorkspacePr }>();
  constructor(
    private readonly run: WorkspaceRun = boundedRun,
    private readonly getPr = async (ref: string, repoPath: string): Promise<WorkspacePr> => {
      const { nwo, num } = await resolvePrRef(ref, repoPath);
      return JSON.parse(await boundedRun('gh', ['api', `repos/${nwo}/pulls/${num}`])) as WorkspacePr;
    },
  ) {}

  async inspect(review: Review, directory: string, requireBranch = false) {
    if (review.source !== 'github-pr' || review.headRef || review.parentReviewId) {
      throw new Error('请在整个 PR 的审核任务中关联工作区');
    }
    if (!directory.trim()) throw new Error('请选择本地 Git 仓库');
    const repoPath = await realpath((await this.run('git', ['rev-parse', '--show-toplevel'], directory)).trim());
    const pr = await this.getPr(review.sourceRef, repoPath);
    if (pr.state !== 'open' || !pr.head.repo) throw new Error('原 PR 已关闭或来源仓库不可用');
    if (![pr.head.sha, pr.base.sha].every((sha) => /^[a-f0-9]{40}$/i.test(sha))) throw new Error('PR 返回的提交标识无效');
    const nwo = pr.head.repo.full_name.toLowerCase();
    const remotes = (await this.run('git', ['remote'], repoPath)).trim().split('\n').filter(Boolean);
    let remoteUrl = '';
    for (const remote of remotes) {
      const urls = (await this.run('git', ['remote', 'get-url', '--push', '--all', remote], repoPath)).trim().split('\n');
      if (urls.length === 1 && githubRepository(urls[0]) === nwo) {
        remoteUrl = urls[0];
        break;
      }
    }
    if (!remoteUrl) throw new Error(`本地仓库缺少指向 PR 来源仓库 ${nwo} 的唯一推送地址`);
    const branch = (await this.run('git', ['branch', '--show-current'], repoPath)).trim();
    if (requireBranch) {
      if (branch !== pr.head.ref) throw new Error(`请先切到 PR 来源分支 ${pr.head.ref}（当前: ${branch || 'detached HEAD'}）`);
      if ((await this.run('git', ['ls-files', '--unmerged', '-z'], repoPath)).length) throw new Error('本地仍有未解决的合并冲突');
      const baseUrl = pr.base.repo ? `https://github.com/${pr.base.repo.full_name}.git` : remoteUrl;
      for (const [sha, url] of [[pr.head.sha, remoteUrl], [pr.base.sha, baseUrl]]) {
        try { await this.run('git', ['cat-file', '-e', `${sha}^{commit}`], repoPath); }
        catch { await this.run('git', ['fetch', '--no-tags', '--', url, sha], repoPath); }
      }
      try { await this.run('git', ['merge-base', '--is-ancestor', pr.head.sha, 'HEAD'], repoPath); }
      catch { throw new Error('本地分支落后于原 PR 或已经分叉,请先拉取并整合远端提交'); }
    }
    return { repoPath, pr, branch, remoteUrl, nwo };
  }

  async localTarget(review: Review, directory: string) {
    const info = await this.inspect(review, directory, true);
    const baseCommit = review.baseRef
      ? (await this.run('git', ['rev-parse', '--verify', '--end-of-options', `${review.baseRef}^{commit}`], info.repoPath)).trim()
      : info.pr.base.sha;
    const base = (await this.run('git', ['merge-base', 'HEAD', baseCommit], info.repoPath)).trim();
    return { repoPath: info.repoPath, base };
  }

  /** 本地展示允许 rebase 后的分支;不要求尚未推送的 HEAD 是旧 PR head 的后代。 */
  async reviewBase(review: Review, forceMetadata = false): Promise<string> {
    if (!review.repoPath) throw new Error('本地仓库未关联');
    const git = (args: string[]) => this.run('git', ['--no-optional-locks', ...args], review.repoPath!);
    if (review.baseRef) {
      const explicit = (await git(['rev-parse', '--verify', '--end-of-options', `${review.baseRef}^{commit}`])).trim();
      return (await git(['merge-base', 'HEAD', explicit])).trim();
    }
    const key = `${review.sourceRef}:${review.repoPath}`;
    let cached = this.baseMetadata.get(key);
    if (forceMetadata || !cached || Date.now() - cached.at > 60_000) {
      cached = { at: Date.now(), pr: await this.getPr(review.sourceRef, review.repoPath) };
      this.baseMetadata.set(key, cached);
    }
    const pr = cached.pr;
    let target = pr.base.sha;
    if (pr.base.ref && pr.base.repo) {
      const candidates: string[] = [];
      const remotes = (await git(['remote'])).trim().split('\n').filter(Boolean);
      for (const remote of remotes) {
        const url = (await git(['remote', 'get-url', remote])).trim();
        if (githubRepository(url) !== pr.base.repo.full_name.toLowerCase()) continue;
        const ref = `refs/remotes/${remote}/${pr.base.ref}`;
        try { candidates.push((await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()); }
        catch { /* 没有跟踪目标分支时使用 API 的提交,不会退回旧共同祖先。 */ }
      }
      if (new Set(candidates).size > 1) throw new Error('目标仓库存在不同版本的远端跟踪分支,请先更新并统一目标分支');
      if (candidates.length) {
        target = candidates[0];
        // API 已前进且对象在本地可用时,旧的 remote-tracking ref 不能把基线拉回去。
        try {
          await git(['cat-file', '-e', `${pr.base.sha}^{commit}`]);
          try { await git(['merge-base', '--is-ancestor', target, pr.base.sha]); target = pr.base.sha; }
          catch { /* 跟踪分支可能比缓存的 API 元数据更新,继续使用它。 */ }
        } catch { /* 尚未下载最新目标对象,使用已验证身份的本地跟踪分支。 */ }
      }
    }
    try { return (await git(['merge-base', 'HEAD', target])).trim(); }
    catch { throw new Error('无法确定当前 PR 目标分支的共同祖先,请先在本地更新远端目标分支'); }
  }

  /** 轻量状态查询:只读状态与提交标识,不生成快照或启动审核。 */
  async syncStatus(review: Review) {
    if (!review.repoPath) return { pending: false };
    const info = await this.inspect(review, review.repoPath);
    const untracked = await this.run('git', ['ls-files', '--others', '--exclude-standard', '-z'], info.repoPath);
    if (untracked.length) return { pending: true };
    // 比较最终代码内容,不因本地额外的空提交或已抵消的改动误报差异。
    try {
      await this.run('git', ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', '--quiet', info.pr.head.sha, '--'], info.repoPath);
      return { pending: false };
    } catch (error) {
      if ((error as { code?: number }).code === 1) return { pending: true };
      throw new Error('无法比较本地代码和远端版本,请先拉取远端提交');
    }
  }

  async verifySyncedReview(review: Review, commit: string, reviewedTree: string) {
    const info = await this.inspect(review, review.repoPath ?? '', true);
    const liveRemote = (await this.run('git', ['ls-remote', '--exit-code', info.remoteUrl, `refs/heads/${info.pr.head.ref}`], info.repoPath)).split(/\s/)[0];
    if (info.pr.head.sha !== commit || liveRemote !== commit) throw new Error('远端 PR 在同步后已有更新,请重新同步并审核后应用结论');
    const tree = (await this.run('git', ['rev-parse', `${commit}^{tree}`], info.repoPath)).trim();
    if (tree !== reviewedTree) throw new Error('本地审核快照与已推送代码不同,请先复审当前本地改动');
  }

  private async syncContext(review: Review) {
    if (!review.localReview || !review.repoPath) throw new Error('请先关联本地代码仓库');
    const info = await this.inspect(review, review.repoPath);
    const git = (args: string[]) => this.run('git', args, info.repoPath);
    const checkBranch = async () => {
      const branch = (await git(['branch', '--show-current'])).trim();
      if (branch !== info.pr.head.ref) throw new Error(`请先切到 PR 来源分支 ${info.pr.head.ref}（当前: ${branch || 'detached HEAD'}）`);
      if ((await git(['ls-files', '--unmerged', '-z'])).length) throw new Error('本地仍有未解决的合并冲突');
    };
    await checkBranch();
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    const remote = (await git(['ls-remote', '--exit-code', info.remoteUrl, `refs/heads/${info.pr.head.ref}`])).split(/\s/)[0];
    if (!/^[a-f0-9]{40}$/i.test(remote)) throw new Error('远端分支的提交标识无效');
    // 按确定的提交取对象,不依赖会被其他 Git 操作改写的 FETCH_HEAD。
    await git(['fetch', '--no-tags', '--', info.remoteUrl, remote]);
    await checkBranch();
    if ((await git(['rev-parse', 'HEAD'])).trim() !== head) throw new Error('同步期间本地提交已变化,请重试');
    return { info, git, head, remote };
  }

  async syncPreview(review: Review): Promise<CodeSyncPreview> {
    const { info, git, head, remote } = await this.syncContext(review);
    const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', `${head}...${remote}`])).trim().split(/\s/).map(Number);
    const dirty = !!(await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z'])).length;
    return { direction: ahead && !behind ? 'push' : behind && !ahead ? 'pull' : null, ahead, behind, dirty, branch: info.pr.head.ref, repository: info.nwo };
  }

  /** 同步只传输已有提交,不创建提交、不暂存文件,拉取只允许快进。 */
  async syncCode(review: Review, direction: CodeSyncDirection): Promise<CodeSyncResult> {
    if (direction !== 'push' && direction !== 'pull') throw new Error('同步方向无效');
    const { info, git, head, remote } = await this.syncContext(review);
    let commit = head;
    if (direction === 'push') {
      try { await git(['merge-base', '--is-ancestor', remote, head]); }
      catch { throw new Error('本地分支落后或已分叉,请先拉取或在编辑器中整合提交'); }
      await git(['push', '--porcelain', '--', info.remoteUrl, `${head}:refs/heads/${info.pr.head.ref}`]);
    } else {
      if ((await git(['status', '--porcelain=v1', '-z'])).length) throw new Error('本地有未提交改动,请先提交或自行 stash 后再拉取');
      try { await git(['merge-base', '--is-ancestor', head, remote]); }
      catch {
        // 本地已包含远端时无需移动 HEAD;真正分叉才拒绝自动整合。
        try { await git(['merge-base', '--is-ancestor', remote, head]); return { commit: remote, prUrl: info.pr.html_url }; }
        catch { throw new Error('本地和远端分支已分叉,请在编辑器中整合提交后重试'); }
      }
      await git(['merge', '--ff-only', '--no-edit', '--no-autostash', remote]);
      commit = (await git(['rev-parse', 'HEAD'])).trim();
    }
    return { commit, prUrl: info.pr.html_url };
  }
}
