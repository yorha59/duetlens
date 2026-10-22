import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Review } from '@shared/domain';
import type { CodeSyncPlan, CodeSyncResult } from '@shared/ipc';
import { resolveTool } from '../config/tool-paths';
import { resolvePrRef } from './github-pr-source';
import { LocalWorktreeSource } from './local-worktree-source';

const exec = promisify(execFile);
export type WorkspaceRun = (cmd: string, args: string[], cwd?: string) => Promise<string>;
const boundedRun: WorkspaceRun = async (cmd, args, cwd) =>
  (await exec(resolveTool(cmd), args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

export interface WorkspacePr {
  state: string;
  html_url: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo?: { full_name: string } };
}

/** 仅接受 GitHub 仓库 URL;比较身份不依赖 remote 名字,也不把凭据传到界面。 */
export function githubRepository(url: string): string | null {
  const match = url.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return match?.[1].toLowerCase() ?? null;
}

export class PrWorkspace {
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
      throw new Error('无法比较本地代码和远端版本,请先预览同步或更新本地远端提交');
    }
  }

  async verifySyncedReview(review: Review, commit: string, reviewedTree: string) {
    const info = await this.inspect(review, review.repoPath ?? '', true);
    const liveRemote = (await this.run('git', ['ls-remote', '--exit-code', info.remoteUrl, `refs/heads/${info.pr.head.ref}`], info.repoPath)).split(/\s/)[0];
    if (info.pr.head.sha !== commit || liveRemote !== commit) throw new Error('远端 PR 在同步后已有更新,请重新同步并审核后应用结论');
    const tree = (await this.run('git', ['rev-parse', `${commit}^{tree}`], info.repoPath)).trim();
    if (tree !== reviewedTree) throw new Error('本地审核快照与已推送代码不同,请先复审当前本地改动');
  }

  async plan(review: Review): Promise<CodeSyncPlan> {
    return (await this.preparePlan(review)).public;
  }

  private async preparePlan(review: Review) {
    if (!review.localReview || !review.repoPath) throw new Error('请先切到关联的本地代码进行审核');
    const info = await this.inspect(review, review.repoPath, true);
    const git = (args: string[]) => this.run('git', args, info.repoPath);
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    const liveRemote = (await git(['ls-remote', '--exit-code', info.remoteUrl, `refs/heads/${info.pr.head.ref}`])).split(/\s/)[0];
    if (liveRemote !== info.pr.head.sha) throw new Error('PR 分支刚有更新,请刷新后重新预览同步');
    // 快照同时覆盖暂存、未暂存及未忽略的新文件;原工作区与 index 不受影响。
    const snapshot = new LocalWorktreeSource({ source: 'local-worktree', ref: '', repoPath: info.repoPath });
    let tree: string;
    try { tree = (await snapshot.prepare()).headSha!; }
    finally { await snapshot.dispose(); }
    const index = await git(['ls-files', '--stage', '-z']);
    const paths = await git(['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--']);
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
    const files = [...new Set((paths + untracked).split('\0').filter(Boolean))].sort();
    const commitsAhead = Number((await git(['rev-list', '--count', `${liveRemote}..HEAD`])).trim());
    const token = createHash('sha256').update(JSON.stringify([review.id, info.repoPath, info.remoteUrl, info.branch, head, tree, index, liveRemote])).digest('hex');
    return {
      info, head, tree, git,
      public: { token, branch: info.pr.head.ref, repository: info.nwo, files, commitsAhead },
    };
  }

  async push(review: Review, token: string, message: string): Promise<CodeSyncResult> {
    const plan = await this.preparePlan(review);
    if (!token || token !== plan.public.token) throw new Error('本地代码、暂存区或远端分支已变化,请重新预览同步');
    if (!plan.public.files.length && !plan.public.commitsAhead) throw new Error('没有需要同步的本地改动或提交');
    let commit = plan.head;
    if (plan.public.files.length) {
      if (!message.trim()) throw new Error('请输入提交信息');
      // 用户已看过整份文件清单。使用正常 Git 提交流程,保留 hooks 与签名配置。
      await plan.git(['add', '--all', '--']);
      if ((await plan.git(['write-tree'])).trim() !== plan.tree) throw new Error('预览后文件又有变化,已暂存但尚未提交,请重新预览');
      if ((await plan.git(['rev-parse', 'HEAD'])).trim() !== plan.head || (await plan.git(['branch', '--show-current'])).trim() !== plan.info.branch) {
        throw new Error('提交前 HEAD 或分支发生变化,尚未提交,请重新预览');
      }
      await plan.git(['commit', '-m', message.trim()]);
      commit = (await plan.git(['rev-parse', 'HEAD'])).trim();
    }
    if ((await plan.git(['rev-parse', `${commit}^{tree}`])).trim() !== plan.tree) {
      throw new Error(`提交 ${commit.slice(0, 7)} 被 Git hook 修改,尚未推送,请检查并重新预览`);
    }
    if ((await plan.git(['status', '--porcelain=v1', '-z'])).length) {
      throw new Error('本地提交已保留,但提交期间工作区又有改动;尚未推送,请检查后重新预览');
    }
    try {
      // 明确推送已确认的 commit 到原 PR 分支,只允许普通快进;绝不 force/reset/checkout。
      await plan.git(['push', '--porcelain', '--', plan.info.remoteUrl, `${commit}:refs/heads/${plan.info.pr.head.ref}`]);
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim() || '请检查网络、推送权限或远端分支是否更新';
      throw new Error(`推送失败,提交 ${commit.slice(0, 7)} 仍保留在本地: ${detail}`);
    }
    return { commit, prUrl: plan.info.pr.html_url };
  }
}
