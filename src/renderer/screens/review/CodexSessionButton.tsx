import { useEffect, useState } from 'react';
import type { CodexBinding } from '@shared/codex-handoff';
import './CodexSessionButton.css';

export function CodexSessionButton({ reviewId, binding, onBinding, open, onOpen, onShowChat }: {
  reviewId: string; binding: CodexBinding | null; onBinding: (binding: CodexBinding | null) => void; open: boolean; onOpen: (open: boolean) => void; onShowChat: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.duetlens.review.codexBinding(reviewId).then((result) => { if (alive) onBinding(result); }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [reviewId, onBinding]);
  useEffect(() => { if (open) setValue(binding ? `codex://threads/${binding.threadId}` : ''); }, [open, binding]);
  const save = async (remove = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try { onBinding(await window.duetlens.review.bindCodex(reviewId, remove ? null : { threadId: value, mode: 'copy' })); onOpen(false); if (!remove) onShowChat(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <button className="rerun-cta" type="button" onClick={() => binding ? onShowChat() : onOpen(true)} title={binding ? `同步对话 ${binding.threadId}` : '绑定已有 Codex 会话,同步展示并发送选区'}>{binding ? 'Codex 对话' : '绑定 Codex'}</button>
    {binding && <button className="rerun-cta" type="button" onClick={() => onOpen(true)} title="更换或解除 Codex 绑定">更换绑定</button>}
    {open && <div className="codex-binding-scrim" onClick={() => !busy && onOpen(false)}>
      <form className="codex-binding-panel" role="dialog" aria-modal="true" aria-label="绑定 Codex 对话" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onOpen(false); } }} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h2>绑定 Codex 对话</h2>
        <p>粘贴已有本地对话的链接或 UUID,并在 Codex 打开该对话。Duetlens 同步展示消息和回复；选区加入待发送区,由你点击发送后交给原会话执行。</p>
        <label htmlFor="codex-session-link">Codex 对话链接 / Session ID</label>
        <input id="codex-session-link" autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="codex://threads/…" disabled={busy} />
        <p>两边查看同一会话,执行权限和工具沿用 Codex。远端与本地审核视图共用此绑定。删除侧或版本不一致的选区会标注为审核快照。</p>
        {error && <p role="alert">{error}</p>}
        <div className="codex-binding-actions">
          {binding && <button type="button" disabled={busy} onClick={() => void save(true)}>解除绑定</button>}
          <button type="button" disabled={busy} onClick={() => onOpen(false)}>取消</button>
          <button type="submit" disabled={busy || !value.trim()}>{busy ? '保存中…' : '保存绑定'}</button>
        </div>
      </form>
    </div>}
  </>;
}
