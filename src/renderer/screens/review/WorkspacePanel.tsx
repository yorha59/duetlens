import { useState } from 'react';
import type { Review } from '@shared/domain';
import type { CodeSyncPlan, WorkspaceState } from '@shared/ipc';
import './WorkspacePanel.css';

export function WorkspacePanel({ review, state, initialError, onChange, onClose, onApplied }: {
  review: Review; state: WorkspaceState | null; initialError?: string;
  onChange: (state: WorkspaceState) => void; onClose: () => void; onApplied: () => void;
}) {
  const [directory, setDirectory] = useState(review.repoPath ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [notice, setNotice] = useState('');
  const [plan, setPlan] = useState<CodeSyncPlan | null>(null);
  const [message, setMessage] = useState('');
  const [synced, setSynced] = useState(!!state?.syncedCommit);
  const perform = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(''); setNotice('');
    try { await action(); }
    catch (error) { setError((error as Error).message); setPlan(null); }
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
      <hr /><h3>同步本地代码到原 PR</h3>
      <p>预览后提交全部暂存、未暂存及新增文件，并推送到原 PR 分支。GitHub 评论仍手动提交。</p>
      <button type="button" disabled={!!busy || !state?.localId} onClick={() => void perform('读取同步预览…', async () => {
        setPlan(await window.duetlens.review.syncPlan(state!.localId!));
      })}>预览同步</button>
      {plan && <div className="workspace-sync-plan">
        <p>目标：<b>{plan.repository}</b> / <b>{plan.branch}</b></p>
        <p>{plan.commitsAhead} 个已有本地提交 · {plan.files.length} 个待提交文件</p>
        {!plan.files.length && !plan.commitsAhead && <p>代码已同步，无需推送。</p>}
        {!!plan.files.length && <><ul aria-label="将提交的文件">{plan.files.map((file) => <li key={file}>{file}</li>)}</ul>
          <label>提交信息<input aria-label="同步提交信息" value={message} disabled={!!busy} onChange={(event) => setMessage(event.target.value)} placeholder="描述这次修改" /></label></>}
        <button type="button" className="submit-cta" disabled={!!busy || (!plan.files.length && !plan.commitsAhead) || (!!plan.files.length && !message.trim())}
          onClick={() => void perform('提交并推送中…', async () => {
            const result = await window.duetlens.review.syncPush(state!.localId!, plan.token, message);
            setPlan(null); setSynced(true);
            onChange(await window.duetlens.review.workspaceState(review.id));
            setNotice(`已推送 ${result.commit.slice(0, 7)}。若本地审核已完成，可将结论应用到远端侧。`);
          })}>{plan.files.length ? '提交并推送到原 PR' : '推送已有提交到原 PR'}</button>
      </div>}
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
