import { useState } from 'react';
import type { Review } from '@shared/domain';
import type { WorkspaceState } from '@shared/ipc';
import './WorkspacePanel.css';

export function WorkspacePanel({ review, state, initialError, onChange, onClose, onApplied, onSync }: {
  onSync: () => void;
  review: Review; state: WorkspaceState | null; initialError?: string;
  onChange: (state: WorkspaceState) => void; onClose: () => void; onApplied: () => void;
}) {
  const [directory, setDirectory] = useState(review.repoPath ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [notice, setNotice] = useState('');
  const synced = !!state?.syncedCommit;
  const perform = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(''); setNotice('');
    try { await action(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(''); }
  };
  return <div className="rerun-scrim" role="presentation" onClick={() => !busy && onClose()}>
    <section className="rerun-panel workspace-panel" role="dialog" aria-label="本地仓库与远端 PR" aria-busy={!!busy}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
      <header className="rp-head"><h2>本地仓库与远端 PR</h2><button type="button" disabled={!!busy} onClick={onClose} aria-label="关闭本地仓库面板">×</button></header>
      <p>{review.sourceRef} · 当前视图：<b>{state?.activeMode === 'local' ? '本地代码' : '远端 PR'}</b></p>
      <p>顶部可随时切换，两边独立保留讨论、结论和已看进度。切换不启动 AI；点击机审或重跑后才审核，复审默认只审新增变化。</p>
      {!state?.localId && <>
        <label className="workspace-directory">本地 Git 仓库<span>
          <input aria-label="关联的本地仓库路径" value={directory} disabled={!!busy} onChange={(event) => setDirectory(event.target.value)} placeholder="选择本地代码目录" />
          <button type="button" disabled={!!busy} onClick={() => void perform('选择目录…', async () => { const path = await window.duetlens.dialog.pickDirectory(); if (path) setDirectory(path); })}>选择目录</button>
        </span></label>
        <button type="button" disabled={!!busy || !directory.trim()} onClick={() => void perform('建立本地视图…', async () => {
          onChange(await window.duetlens.review.switchWorkspace(review.id, 'local', directory)); onClose();
        })}>关联仓库并切到本地</button>
      </>}
      {state?.localId && <p>关联仓库：<span className="mono">{directory}</span></p>}
      <hr /><h3>同步代码</h3>
      <p>选择推送本地提交或拉取远端提交,确认后执行。</p>
      <button type="button" disabled={!!busy || !state?.localId} onClick={onSync}>同步代码…</button>
      {synced && <div className="workspace-apply"><h3>应用本地审核结论</h3>
        <p>以本地 findings 和总结覆盖远端侧结论。远端原有讨论保留，旧问题归档为剔除。本地审核代码必须与已推送代码一致。</p>
        <button type="button" disabled={!!busy} onClick={() => void perform('核对代码并应用结论…', async () => {
          await window.duetlens.review.applyLocal(review.id);
          onChange(await window.duetlens.review.switchWorkspace(review.id, 'remote'));
          onApplied(); onClose();
        })}>用本地结论覆盖远端侧</button>
      </div>}
      {busy && <p role="status">{busy}</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {notice && <p className="workspace-notice" role="status">{notice}</p>}
    </section>
  </div>;
}
