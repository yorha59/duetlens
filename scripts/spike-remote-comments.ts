/** 无网络/模型的 GitHub 评论读取验证:完整分页、回复、侧别及错误反馈。 */
import { strict as assert } from 'node:assert';
import type { Review } from '../src/shared/domain';
import { readRemoteComments } from '../src/backend/source/remote-pr-comments';
const review = { source: 'github-pr', sourceRef: 'acme/repo#1' } as Review;
const c = (id: string) => ({ id, body: id, url: 'https://github.com/acme/repo/pull/1', createdAt: '2026-10-23T00:00:00Z', author: null });
const page = <T>(nodes: T[], more = false, end: string | null = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: end } });
const thread = (id: string) => ({ id, path: 'src/code.ts', line: null, originalLine: 20, diffSide: 'LEFT', isResolved: true, isOutdated: true, comments: page([c(id)], id === 'first', 'replies') });
async function main() {
  const calls: string[][] = [];
  const execute = async (args: string[]) => {
    calls.push(args);
    const endpoint = args[1];
    if (endpoint !== 'graphql') {
      assert.ok(args.includes('--paginate') && args.includes('--slurp'));
      return JSON.stringify([[{ id: 1, body: 'comment', user: null, html_url: 'https://github.com', created_at: '2026-10-23' }], [{ id: 2, body: endpoint.endsWith('/reviews') ? '' : 'next page', state: 'APPROVED', user: { login: 'author' } }]]);
    }
    if (args.some(arg => arg.startsWith('id='))) return JSON.stringify({ data: { node: { comments: page([c('first'), c('reply')]) } } });
    const next = args.includes('after=next');
    return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'a'.repeat(40), reviewThreads: next ? page([thread('second')]) : page([thread('first')], true, 'next') } } } });
  };
  const result = await readRemoteComments(review, execute);
  assert.equal(result.threads.length, 2);
  assert.deepEqual(result.threads[0].comments.map(c => c.id), ['first', 'reply']);
  assert.equal(result.threads[0].side, 'old'); assert.equal(result.threads[0].line, 20);
  assert.equal(result.threads[0].resolved, true); assert.equal(result.threads[0].outdated, true);
  assert.equal(result.comments.length, 2); assert.equal(result.reviews.length, 1);
  assert.equal(result.comments[0].author, '(unknown)');
  assert.equal(calls.filter(args => args[1] === 'graphql').length, 3);
  await assert.rejects(readRemoteComments(review, async () => { throw new Error('auth failed'); }), /auth failed/);
  await assert.rejects(readRemoteComments(review, async () => JSON.stringify({ errors: [{ message: 'no permission' }] })), /no permission/);
  await assert.rejects(readRemoteComments({ ...review, source: 'local-worktree' }, execute), /GitHub PR/);
  await assert.rejects(readRemoteComments(review, async args => args[1] !== 'graphql' ? '[]' : JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'a'.repeat(40), reviewThreads: page([], true, 'repeat') } } } })), /分页异常/);
  console.log('remote comments: thread/reply/REST pagination, dedupe, anchors/status/author, visible errors and cursor guard passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
