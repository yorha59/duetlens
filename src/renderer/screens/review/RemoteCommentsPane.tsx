import { useEffect, useState } from 'react';
import type { RemoteComment, RemotePrComments, RemoteThread } from '@shared/remote-comments';
import { useIsActiveTab } from '../../review/TabVisibility';
import { renderMarkdown } from './markdown';
import { stripIpcWrapper } from './round-error';
import './RemoteCommentsPane.css';

function Comment({ comment }: { comment: RemoteComment }) {
  const [expanded, setExpanded] = useState(false);
  const long = comment.body.length > 8000;
  return <article className="remote-comment">
    <header><b>@{comment.author}</b><a href={comment.url} target="_blank" rel="noreferrer">{new Date(comment.createdAt).toLocaleString()}</a></header>
    <div className="c-prose">{renderMarkdown(long && !expanded ? comment.body.slice(0, 8000) + '\n…' : comment.body)}</div>
    {long && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开完整评论'}</button>}
  </article>;
}
function Thread({ thread, onFile }: { thread: RemoteThread; onFile: (file: string) => void }) {
  const [limit, setLimit] = useState(20);
  const truncated = thread.comments.length > limit;
  const replies = truncated ? thread.comments.slice(-(limit - 1)) : thread.comments.slice(1);
  return <section className="remote-thread">
    <header><button type="button" onClick={() => onFile(thread.path)} title="定位到对应文件">{thread.path}:{thread.line ?? '?'}{thread.side === 'old' ? '（删除侧）' : ''}</button><span>{thread.resolved ? '已解决' : '未解决'}{thread.outdated ? ' · 已过时' : ''}</span></header>
    {thread.comments[0] && <Comment comment={thread.comments[0]} />}
    {truncated && <button type="button" onClick={() => setLimit(n => n + 20)}>还有 {thread.comments.length - limit} 条较早回复,点击展开</button>}
    {replies.map(comment => <Comment key={comment.id} comment={comment} />)}
  </section>;
}
export function RemoteCommentsPane({ reviewId, onFile }: { reviewId: string; onFile: (file: string) => void }) {
  const active = useIsActiveTab();
  const [data, setData] = useState<RemotePrComments | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [limit, setLimit] = useState(40);
  useEffect(() => {
    if (!active) return;
    let alive = true; setLoading(true); setError('');
    void window.duetlens.review.remoteComments(reviewId).then((result) => { if (alive) setData(result); })
      .catch((error: Error) => { if (alive) setError(stripIpcWrapper(error.message)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reviewId, nonce, active]);
  return <section className="remote-comments" aria-label="GitHub PR 评论">
    <header className="remote-comments-toolbar"><span>GitHub PR 评论 · 只读</span><button type="button" disabled={loading} onClick={() => setNonce(n => n + 1)}>{loading ? '读取中…' : '刷新评论'}</button></header>
    {error && <p className="remote-comments-error" role="alert">读取失败：{error}{data ? '（下方仍是上次读取的内容）' : ''}</p>}
    {loading && !data && <p role="status">正在读取评论和回复…</p>}
    <div className="remote-comments-body">
      {data && <>
        {!data.threads.length && !data.comments.length && !data.reviews.length && <p>这个 PR 暂无评论。</p>}
        {!!data.threads.length && <h3>行内讨论 · {data.threads.length}</h3>}
        {data.threads.slice(0, limit).map(thread => <Thread key={thread.id} thread={thread} onFile={onFile} />)}
        {data.threads.length > limit && <button type="button" onClick={() => setLimit(n => n + 40)}>展开更多行内讨论</button>}
        {!!data.comments.length && <h3>PR 评论 · {data.comments.length}</h3>}
        {data.comments.slice(0, limit).map(comment => <Comment key={comment.id} comment={comment} />)}
        {data.comments.length > limit && <button type="button" onClick={() => setLimit(n => n + 40)}>展开更多 PR 评论</button>}
        {!!data.reviews.length && <h3>Review 总结 · {data.reviews.length}</h3>}
        {data.reviews.slice(0, limit).map(review => <section key={review.id}><p className="remote-review-state">{review.state}</p><Comment comment={review} /></section>)}
        {data.reviews.length > limit && <button type="button" onClick={() => setLimit(n => n + 40)}>展开更多 review 总结</button>}
      </>}
    </div>
  </section>;
}
