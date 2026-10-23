import { useState } from 'react';
import type { Review } from '@shared/domain';
import type { CodeSyncDirection, WorkspaceState } from '@shared/ipc';
import './WorkspacePanel.css';

export function CodeSyncPanel({ review, state, onChange, onClose }: {
  review: Review; state: WorkspaceState; onChange: (state: WorkspaceState) => void; onClose: () => void;
}) {
  const [direction, setDirection] = useState<CodeSyncDirection>('push');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sync = async () => {
    if (busy || !state.localId) return;
    setBusy(true); setError('');
    try {
      await window.duetlens.review.syncCode(state.localId, direction);
      await window.duetlens.review.refreshLocal(state.localId, true).catch(() => { /* 代码已同步,显示可由刷新操作重试。 */ });
      onChange(await window.duetlens.review.workspaceState(review.id)); onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="rerun-scrim" onClick={() => !busy && onClose()}>
    <section className="rerun-panel workspace-panel code-sync-panel" role="dialog" aria-modal="true" aria-label="同步代码" aria-busy={busy} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
      <header className="rp-head"><h2>同步代码</h2><button type="button" disabled={busy} aria-label="关闭同步窗口" onClick={onClose}>×</button></header>
      <p>{review.sourceRef}</p>
      <div className="code-sync-options" role="group" aria-label="同步方向">
        <button autoFocus type="button" disabled={busy} aria-pressed={direction === 'push'} onClick={() => setDirection('push')}><b>推送本地 → 远端</b><span>推送已有提交到原 PR 分支。未提交改动留在本地。</span></button>
        <button type="button" disabled={busy} aria-pressed={direction === 'pull'} onClick={() => setDirection('pull')}><b>拉取远端 → 本地</b><span>将原 PR 分支的提交快进更新到本地。</span></button>
      </div>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <div className="code-sync-footer"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="submit-cta" disabled={busy} onClick={() => void sync()}>{busy ? '同步中…' : direction === 'push' ? '确认推送' : '确认拉取'}</button></div>
    </section>
  </div>;
}
