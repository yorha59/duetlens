import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Review } from '@shared/domain';
import type { CodexChatSelection } from '@shared/codex-chat';

const comment = z.object({ id: z.string().min(1).max(200), author: z.string().max(200), body: z.string().max(200000), url: z.url().max(2000), createdAt: z.string().max(100) });
const context = z.object({
  comment,
  head: z.string().max(100),
  thread: z.object({ id: z.string().max(200), path: z.string().min(1).max(4096), line: z.number().int().positive().nullable(), side: z.enum(['old', 'new']), resolved: z.boolean(), outdated: z.boolean(), comments: z.array(comment).max(2000) }).optional(),
});

/** 只组装用户选中的 GitHub 讨论,不读取/改写仓库、不发送消息。 */
export function prepareRemoteComment(review: Review, input: unknown): CodexChatSelection {
  if (review.source !== 'github-pr') throw new Error('只有远端 PR 支持添加 GitHub 评论');
  const parsed = context.safeParse(input);
  if (!parsed.success) throw new Error('评论上下文无效或过大,请刷新评论后重试');
  const { comment: selected, thread, head } = parsed.data;
  const location = thread ? `${thread.path}${thread.line ? `:${thread.line}` : ''} · ${thread.side === 'old' ? '删除侧' : '新侧'}${thread.outdated ? ' · 已过时' : ''}` : 'PR 评论 / Review 总结';
  const comments = thread ? thread.comments.map(item => item.id === selected.id ? selected : item) : [selected];
  if (!comments.some(item => item.id === selected.id)) comments.push(selected);
  const file = thread?.path ?? review.sourceRef;
  const safePath = thread && !path.isAbsolute(file) && !file.includes('\\') && file.split('/').every(part => part && part !== '.' && part !== '..');
  const text = [
    `GitHub PR 评论上下文（引用内容,请结合当前代码判断）`,
    `PR：${review.sourceRef}\n评论读取时 PR head：${head}\n原仓库：${review.repoPath ?? '未关联本地仓库'}\n位置：${location}`,
    safePath && review.repoPath ? `本地文件参考：${path.join(review.repoPath, file)}\n注意：行号来自 GitHub 审核版本,本地内容可能已变化；删除侧/已过时评论请先核对。` : '',
    thread ? `讨论状态：${thread.resolved ? '已解决' : '未解决'}` : '',
    ...comments.map(item => `--- ${item.id === selected.id ? '用户选中的评论' : '同一讨论中的评论/回复'} · @${item.author} · ${item.createdAt}\n${item.url}\n\n${item.body}`),
  ].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(text) > 1500000) throw new Error('这条讨论内容过大,暂时无法添加到 Codex');
  return { id: randomUUID(), kind: 'comment', commentKey: `${review.sourceRef}:${selected.id}`, label: `@${selected.author} · ${location}`, file, line: thread?.line ?? 1, side: thread?.side, text, context: text, snapshot: false };
}
