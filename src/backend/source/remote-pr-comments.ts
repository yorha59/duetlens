import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Review } from '@shared/domain';
import type { RemoteComment, RemotePrComments, RemoteThread } from '@shared/remote-comments';
import { resolveTool } from '../config/tool-paths';
import { resolvePrRef } from './github-pr-source';
const exec = promisify(execFile);
type Run = (args: string[], cwd?: string) => Promise<string>;
const run: Run = async (args, cwd) => (await exec(resolveTool('gh'), args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
const COMMENT_FIELDS = 'id body url createdAt author{login}';
const THREADS = `query($owner:String!,$name:String!,$num:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$num){headRefOid reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id path line originalLine diffSide isResolved isOutdated comments(first:100){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}}}}}}`;
const REPLIES = `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${COMMENT_FIELDS}}}}}}`;
interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface GqlComment { id: string; body: string; url: string; createdAt: string; author: { login: string } | null }
interface GqlThread { id: string; path: string; line: number | null; originalLine: number | null; diffSide: string; isResolved: boolean; isOutdated: boolean; comments: Page<GqlComment> }
const comment = (c: GqlComment): RemoteComment => ({ id: c.id, author: c.author?.login ?? '(unknown)', body: c.body, url: c.url, createdAt: c.createdAt });
/** 展示路径必须区分“读失败”与“没有评论”,且完整翻页。 */
export async function readRemoteComments(review: Review, execute: Run = run): Promise<RemotePrComments> {
  if (review.source !== 'github-pr') throw new Error('此任务没有关联 GitHub PR');
  const { nwo, num } = await resolvePrRef(review.sourceRef, review.repoPath);
  const [owner, name] = nwo.split('/');
  const call = async <T>(args: string[]): Promise<T> => {
    const value = JSON.parse(await execute(['api', ...args], review.repoPath ?? undefined));
    if (value.errors?.length) throw new Error(value.errors.map((error: { message: string }) => error.message).join('; '));
    return value;
  };
  const threadRead = async () => {
    const threads: RemoteThread[] = [];
    const seen = new Set<string>();
    const pageCursors = new Set<string>();
    let after: string | null = null; let head = '';
    do {
      const result: { data: { repository: { pullRequest: { headRefOid: string; reviewThreads: Page<GqlThread> } | null } | null } } = await call(['graphql', '-f', `query=${THREADS}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `num=${num}`, ...(after ? ['-f', `after=${after}`] : [])]);
      const pr = result.data?.repository?.pullRequest;
      if (!pr) throw new Error('无法读取 GitHub PR,请检查访问权限');
      if (head && head !== pr.headRefOid) throw new Error('读取期间 PR 已更新,请刷新评论');
      head = pr.headRefOid;
      for (const thread of pr.reviewThreads.nodes) {
        if (!thread || seen.has(thread.id)) continue;
        seen.add(thread.id);
        const messages = thread.comments.nodes.filter(Boolean).map(comment);
        let page = thread.comments; const cursors = new Set<string>();
        while (page.pageInfo.hasNextPage) {
          const cursor = page.pageInfo.endCursor;
          if (!cursor || cursors.has(cursor)) throw new Error('GitHub 回复分页异常,请重试');
          cursors.add(cursor);
          const response: { data: { node: { comments: Page<GqlComment> } | null } } = await call(['graphql', '-f', `query=${REPLIES}`, '-f', `id=${thread.id}`, '-f', `after=${cursor}`]);
          if (!response.data?.node) throw new Error('GitHub 讨论已变化,请刷新');
          page = response.data.node.comments; messages.push(...page.nodes.filter(Boolean).map(comment));
        }
        threads.push({ id: thread.id, path: thread.path, line: thread.line ?? thread.originalLine, side: thread.diffSide === 'LEFT' ? 'old' : 'new', resolved: thread.isResolved, outdated: thread.isOutdated, comments: [...new Map(messages.map((c) => [c.id, c])).values()] });
      }
      const next = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
      if (pr.reviewThreads.pageInfo.hasNextPage && (!next || pageCursors.has(next))) throw new Error('GitHub 讨论分页异常,请重试');
      if (next) pageCursors.add(next);
      after = next;
    } while (after);
    return { threads, head };
  };
  type RestComment = { id: number; user: { login: string } | null; body: string; html_url: string; created_at: string; submitted_at?: string; state?: string };
  const rest = async (endpoint: string) => {
    const pages = await call<RestComment[][]>([endpoint, '--paginate', '--slurp']);
    return pages.flat().map((c) => ({ id: String(c.id), author: c.user?.login ?? '(unknown)', body: c.body ?? '', url: c.html_url, createdAt: c.submitted_at ?? c.created_at, state: c.state ?? '' }));
  };
  const [inline, comments, reviews] = await Promise.all([threadRead(), rest(`repos/${nwo}/issues/${num}/comments`), rest(`repos/${nwo}/pulls/${num}/reviews`)]);
  return { ...inline, comments, reviews: reviews.filter((review) => review.body.trim()), fetchedAt: Date.now() };
}
