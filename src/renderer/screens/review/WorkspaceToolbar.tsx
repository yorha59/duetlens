import { useEffect, useRef, useState } from 'react';
import type { Review } from '@shared/domain';
import type { WorkspaceState, WorkspaceSyncStatus } from '@shared/ipc';
import { WorkspacePanel } from './WorkspacePanel';
import './WorkspacePanel.css';

export function WorkspaceToolbar({ review, state, onChange, onModalChange, onApplied }: {
  review: Review; state: WorkspaceState | null; onChange: (state: WorkspaceState) => void; onModalChange: (open: boolean) => void; onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sync, setSync] = useState<WorkspaceSyncStatus>({ pending: false });
  useEffect(() => { onModalChange(open); return () => onModalChange(false); }, [open, onModalChange]);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let checking = false;
    const check = () => {
      if (checking || !state?.localId) return;
      checking = true;
      void window.duetlens.review.syncStatus(review.id).then((value) => { if (alive) setSync(value); })
        .catch((error: Error) => { if (alive) setSync({ pending: false, error: error.message }); })
        .finally(() => { checking = false; });
    };
    refresh.current = check;
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(() => { if (!document.hidden) check(); }, 30_000);
    return () => { alive = false; window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); window.clearInterval(timer); };
  }, [review.id, state?.localId]);
  const pick = async (mode: 'local' | 'remote') => {
    if (busy || state?.activeMode === mode) return;
    if (mode === 'local' && !state?.localId && !review.repoPath) { setOpen(true); return; }
    setBusy(true); setError('');
    try { onChange(await window.duetlens.review.switchWorkspace(review.id, mode)); }
    catch (error) { setError((error as Error).message); setOpen(true); }
    finally { setBusy(false); }
  };
  return <>
    {!state && <button className="rerun-cta" type="button" onClick={() => {
      void window.duetlens.review.workspaceState(review.id).then(onChange).catch((error: Error) => { setError(error.message); setOpen(true); });
    }}>重新加载来源</button>}
    <div className="workspace-toggle" role="group" aria-label="审核代码来源">
      <button className="rerun-cta" type="button" aria-pressed={state?.activeMode !== 'local'} disabled={busy || !state} onClick={() => void pick('remote')}>远端 PR</button>
      <button className="rerun-cta" type="button" aria-pressed={state?.activeMode === 'local'} disabled={busy || !state} onClick={() => void pick('local')}>本地代码</button>
    </div>
    <button className="rerun-cta" type="button" onClick={() => setOpen(true)}>仓库</button>
    {(sync.pending || sync.error) && <button className="rerun-cta workspace-sync-cta" type="button" title={sync.error ?? '本地存在尚未推送到原 PR 的改动'} onClick={() => setOpen(true)}>{sync.error ? '检查同步' : '同步到远端'}</button>}
    {open && <WorkspacePanel review={review} state={state} onApplied={onApplied} initialError={error} onChange={(next) => { onChange(next); refresh.current(); }} onClose={() => { setOpen(false); refresh.current(); }} />}
  </>;
}
