import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ShareSessionButton.css';

/** 点击立即复制当前 review 的链接,分享目标不随远端/本地视图切换。 */
export function ShareSessionButton({ reviewId }: { reviewId: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = !busy && !error ? window.setTimeout(() => setOpen(false), 3000) : null;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', outside);
    window.addEventListener('keydown', escape);
    return () => { if (timer !== null) window.clearTimeout(timer); document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape); };
  }, [open, busy, error, url]);
  const copy = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await window.duetlens.review.shareSession(reviewId); setUrl(result.url); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); setOpen(true); }
  };
  return <span ref={root} className="share-session-action">
    <button type="button" className="rerun-cta" disabled={busy} onClick={() => void copy()} title="复制当前审核视图的链接,供本机 Codex 读取评论和文件">{busy ? '复制中…' : '分享会话'}</button>
    {open && createPortal(<section ref={popup} className="share-session-popover share-session-floating" aria-label="会话分享链接">
      <button type="button" className="share-session-close" aria-label="关闭分享提示" onClick={() => setOpen(false)}>×</button>
      {error ? <p role="alert">{error}</p> : <>
        <p role="status">会话链接已复制</p>
        <input aria-label="会话分享链接" readOnly value={url} onFocus={(event) => event.target.select()} />
        <p>粘贴给本机 Codex，即可读取当前视图的评论、行号及审核版本文件。新增评论实时可读，请保持 Duetlens 运行。</p>
        <button type="button" disabled={busy} onClick={() => void (async () => {
          setBusy(true); setError('');
          try { await window.duetlens.review.revokeShare(reviewId); setUrl(''); setOpen(false); }
          catch (error) { setError((error as Error).message); }
          finally { setBusy(false); }
        })()}>停止分享</button>
      </>}
    </section>, document.body)}
  </span>;
}
