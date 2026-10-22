import { useEffect, useRef, useState } from 'react';
import type { Review } from '@shared/domain';
import type { CodeSyncPlan, ReviewStartStage } from '@shared/ipc';
import { newStartId, roundSteps, StartSteps } from '../../components/StartProgress';
import './WorkspacePanel.css';

/** PR 的身份与讨论保留,代码来源按轮次在远端和本地之间切换。 */
export function WorkspacePanel({ review, onClose }: { review: Review; onClose: () => void }) {
  const [directory, setDirectory] = useState(review.repoPath ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [plan, setPlan] = useState<CodeSyncPlan | null>(null);
  const [message, setMessage] = useState('');
  const [fullReview, setFullReview] = useState(false);
  const [stage, setStage] = useState<ReviewStartStage>('resolve');
  const startId = useRef<string | null>(null);
  useEffect(() => window.duetlens.review.onStartProgress((progress) => {
    if (progress.startId === startId.current) setStage(progress.stage);
  }), []);
  const perform = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError('');
    setNotice('');
    try { await action(); }
    catch (error) { const message = (error as Error).message; if (message.includes('NO_REVIEW_CHANGES:')) setNotice(message.split('NO_REVIEW_CHANGES:')[1]); else setError(message); setPlan(null); }
    finally { setBusy(''); startId.current = null; }
  };
  const switchMode = (mode: 'local' | 'remote') => perform('切换并启动复审…', async () => {
    startId.current = newStartId();
    setStage('resolve');
    await window.duetlens.review.rerun(review.id, {
      workspace: { mode, repoPath: directory },
      fullReview,
      startId: startId.current,
      note: mode === 'local' ? '本轮审核关联仓库的当前本地代码,包含分支提交与未提交改动。' : '本轮切回原远端 PR 的最新代码复审。',
    });
    onClose();
  });
  return (
    <div className="rerun-scrim" role="presentation" onClick={() => !busy && onClose()}>
      <section className="rerun-panel workspace-panel" role="dialog" aria-label="本地仓库与远端 PR" aria-busy={!!busy}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
        }}>
        <header className="rp-head"><h2>本地仓库与远端 PR</h2><button type="button" disabled={!!busy} onClick={onClose} aria-label="关闭本地仓库面板">×</button></header>
        <p>当前审核来源：<b>{review.localReview ? '本地代码' : '远端 PR'}</b> · {review.sourceRef}</p>
        <p>默认只审相对上一轮有变化的地方，未变化的代码和旧问题沿用原结论；完整改动仍可在左侧查看。</p>
        <label className="workspace-directory">本地 Git 仓库
          <span><input aria-label="关联的本地仓库路径" value={directory} disabled={!!busy || !!review.localReview} onChange={(event) => { setDirectory(event.target.value); setPlan(null); }} placeholder="选择本地代码目录" />
            <button type="button" disabled={!!busy || !!review.localReview} onClick={() => void perform('选择目录…', async () => {
              const path = await window.duetlens.dialog.pickDirectory();
              if (path) { setDirectory(path); setPlan(null); }
            })}>选择目录</button></span>
        </label>
        <div className="workspace-buttons">
          <button type="button" disabled={!!busy || !directory.trim() || !!review.localReview} onClick={() => void perform('关联仓库…', async () => {
            await window.duetlens.review.attachWorkspace(review.id, directory);
            setNotice('已关联本地仓库，审核来源仍为远端 PR。');
          })}>关联／更换仓库</button>
          <button type="button" disabled={!!busy || !directory.trim()} onClick={() => void switchMode('local')}>{review.localReview ? '刷新本地并复审' : '切到本地并复审'}</button>
          <button type="button" disabled={!!busy || !review.localReview} onClick={() => void switchMode('remote')}>切回远端并复审</button>
        </div>
        <label><input type="checkbox" checked={fullReview} disabled={!!busy} onChange={(event) => setFullReview(event.target.checked)} /> 全量复审（可选）</label>
        <hr />
        <h3>同步本地代码到原 PR</h3>
        <p>提交文件清单中的全部暂存、未暂存及新增文件，并将本地提交推送到原 PR 的来源分支。</p>
        <button type="button" disabled={!!busy || !review.localReview} onClick={() => void perform('读取同步预览…', async () => {
          setPlan(await window.duetlens.review.syncPlan(review.id));
        })}>预览同步</button>
        {plan && <div className="workspace-sync-plan">
          <p>目标：<b>{plan.repository}</b> / <b>{plan.branch}</b></p>
          <p>{plan.commitsAhead} 个已有本地提交 · {plan.files.length} 个待提交文件</p>
          {!!plan.files.length && <><ul aria-label="将提交的文件">{plan.files.map((file) => <li key={file}>{file}</li>)}</ul>
            <label>提交信息<input aria-label="同步提交信息" value={message} disabled={!!busy} onChange={(event) => setMessage(event.target.value)} placeholder="描述这次修改" /></label></>}
          <button type="button" className="submit-cta" disabled={!!busy || (!plan.files.length && !plan.commitsAhead) || (!!plan.files.length && !message.trim())}
            onClick={() => void perform('提交并推送中…', async () => {
              const result = await window.duetlens.review.syncPush(review.id, plan.token, message);
              setPlan(null);
              setNotice(`已推送提交 ${result.commit.slice(0, 7)} 到原 PR。可切回远端并复审最新代码。`);
            })}>{plan.files.length ? '提交并推送到原 PR' : '推送已有提交到原 PR'}</button>
        </div>}
        {busy && <div role="status">{busy}{startId.current && <StartSteps hint="启动后机审在后台继续运行" stage={stage} steps={roundSteps({ isGithub: true, first: false })} />}</div>}
        {error && <p className="workspace-error" role="alert">{error}</p>}
        {notice && <p className="workspace-notice" role="status">{notice}</p>}
      </section>
    </div>
  );
}
