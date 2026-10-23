import { useEffect, useState } from 'react';
import type { Review } from '@shared/domain';
import type { CodeSyncPreview, WorkspaceState } from '@shared/ipc';
import './WorkspacePanel.css';

export function CodeSyncPanel({ review, state, onChange, onClose }: {
  review: Review; state: WorkspaceState; onChange: (state: WorkspaceState) => void; onClose: () => void;
}) {
  const [preview, setPreview] = useState<CodeSyncPreview | null>(null);
  const [checking, setChecking] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setChecking(true); setError(''); setPreview(null);
    if (!state.localId) { setChecking(false); return; }
    void window.duetlens.review.syncPreview(state.localId).then((result) => { if (alive) setPreview(result); })
      .catch((error: Error) => { if (alive) setError(error.message); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [state.localId, retry]);
  const blocked = !!preview && (preview.ahead > 0 && preview.behind > 0 || preview.direction === 'pull' && preview.dirty);
  const sync = async () => {
    if (busy || checking || blocked || !state.localId || !preview?.direction) return;
    setBusy(true); setError('');
    try {
      await window.duetlens.review.syncCode(state.localId, preview.direction);
      await window.duetlens.review.refreshLocal(state.localId, true).catch(() => { /* 代码已同步,显示可由刷新操作重试。 */ });
      onChange(await window.duetlens.review.workspaceState(review.id)); onClose();
    } catch (error) { setError((error as Error).message); setPreview(null); }
    finally { setBusy(false); }
  };
  return <div className="rerun-scrim" onClick={() => !busy && onClose()}>
    <section className="rerun-panel workspace-panel code-sync-panel" role="dialog" aria-modal="true" aria-label="同步代码" aria-busy={busy || checking} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
      <header className="rp-head"><h2>同步代码</h2><button type="button" disabled={busy} aria-label="关闭同步窗口" onClick={onClose}>×</button></header>
      <p>{review.sourceRef}</p>
      {checking && <p role="status">正在比较本地和远端提交…</p>}
      {preview && <>
        <p className="mono">{preview.repository} / {preview.branch}</p>
        {preview.ahead > 0 && preview.behind > 0 ? <p>本地和远端都有新提交,请先在编辑器中整合分支。</p>
          : preview.direction === 'push' ? <><p>本地领先 {preview.ahead} 个提交,确认推送到远端？</p>{preview.dirty && <p>未提交改动留在本地,不会自动提交。</p>}</>
          : preview.direction === 'pull' ? <><p>远端领先 {preview.behind} 个提交,确认拉取到本地？</p>{preview.dirty && <p>本地有未提交改动,请先提交或自行 stash 后再拉取。</p>}</>
          : <p>{preview.dirty ? '提交已同步。本地尚有未提交改动,不参与推送。' : '本地与远端已同步。'}</p>}
      </>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <div className="code-sync-footer">
        <button autoFocus type="button" disabled={busy} onClick={onClose}>{preview && !preview.direction ? '关闭' : '取消'}</button>
        {error && <button type="button" disabled={busy || checking} onClick={() => setRetry(n => n + 1)}>重新检查</button>}
        {preview?.direction && !blocked && <button type="button" className="submit-cta" disabled={busy || checking} onClick={() => void sync()}>{busy ? '同步中…' : preview.direction === 'push' ? '确认推送' : '确认拉取'}</button>}
      </div>
    </section>
  </div>;
}
