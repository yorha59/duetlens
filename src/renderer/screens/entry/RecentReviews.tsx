import { useState } from 'react';
import type { RecentReview } from '@shared/ipc';
import { isUnscanned, UNSCANNED_LABEL, type ReviewStatus, type SourceKind } from '@shared/domain';
import { GhIcon, GitButlerIcon, LocalBranchIcon } from './icons';
import { repoName } from '../../review/source-ref';

/** 入口只摆最近这些条,全量翻阅走审核历史屏。 */
const LIMIT = 20;

/** 最近审核列表:源徽标 + 标题 + 计数/状态元信息;空态给首次引导。 */
export function RecentReviews({
  reviews,
  onOpen,
  onChanged,
  onDeleted,
}: {
  reviews: RecentReview[];
  onOpen: (id: string) => void;
  onChanged: (review: RecentReview) => void;
  onDeleted: (id: string) => void;
}) {
  const shown = reviews.slice(0, LIMIT);
  return (
    <div className="recent-section">
      <div className="section-head">
        <h3 className="mono">最近的审核</h3>
        {shown.length > 0 && <span className="count mono">{shown.length}</span>}
      </div>

      {shown.length === 0 ? (
        <div className="empty-history">
          <div className="eh-ic">◇</div>
          <div className="eh-t">还没有审核记录</div>
          <div className="eh-s">
            在上面粘贴一个 PR 链接,或选择本地分支 / GitButler 来源,开始你的第一次协同 review。完成的审核会留在这里,随时可以恢复。
          </div>
        </div>
      ) : (
        <div className="recent-list">
          {shown.map((r) => (
            <RecentReviewRow key={r.id} review={r} onOpen={onOpen} onChanged={onChanged} onDeleted={onDeleted} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentReviewRow({ review: r, onOpen, onChanged, onDeleted }: {
  review: RecentReview; onOpen: (id: string) => void; onChanged: (review: RecentReview) => void; onDeleted: (id: string) => void;
}) {
  const [panel, setPanel] = useState<'title' | 'delete' | null>(null);
  const [draft, setDraft] = useState(r.localTitle ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { const updated = await window.duetlens.review.setLocalTitle(r.id, draft); onChanged({ ...r, ...updated }); setPanel(null); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await window.duetlens.review.delete(r.id); onDeleted(r.id); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="recent-review-item">
            <div className="recent-rev" onClick={() => onOpen(r.id)}>
              <SourceBadge source={r.source} sourceRef={r.sourceRef} />
              <div className="m">
                <div className="t">{r.localTitle ?? r.title ?? r.sourceRef}</div>
                {r.localTitle && <div className="recent-original-title" title={r.title ?? r.sourceRef}>{r.title ?? r.sourceRef}</div>}
                <div className="meta mono">
                  <span>{repoName(r) ?? r.source}</span>
                  {/* 只审一个 commit 的那条要能与「整个 PR」分开(同 HistoryScreen 的元信息行) */}
                  {r.headRef && (
                    <>
                      <span className="dot" />
                      <span title="仅审核 PR 中的这一个提交">@{r.headRef.slice(0, 7)}</span>
                    </>
                  )}
                  {r.scopeCount > 0 && (
                    <>
                      <span className="dot" />
                      <span title="这个 PR 下另建过几个提交范围,各自有自己的 findings">
                        含 {r.scopeCount} 个提交范围
                      </span>
                    </>
                  )}
                  <span className="dot" />
                  <span className={r.findingCount === 0 ? 'find zero' : 'find'}>{r.findingCount} findings</span>
                  {r.submittedCount > 0 ? (
                    <>
                      <span className="dot" />
                      <span className="sub">{r.submittedCount} 已提交</span>
                    </>
                  ) : r.discussionCount > 0 ? (
                    <>
                      <span className="dot" />
                      <span>{r.discussionCount} discussions</span>
                    </>
                  ) : null}
                </div>
              </div>
              <StatusChip status={r.status} unscanned={isUnscanned(r)} scanningScopes={r.scanningScopeCount} />
              <div className="recent-actions" onClick={event => event.stopPropagation()}>
                <button type="button" onClick={() => { setPanel('title'); setDraft(r.localTitle ?? ''); setError(''); }}>{r.localTitle ? '编辑标题' : '添加标题'}</button>
                <button type="button" onClick={() => { setPanel('delete'); setError(''); }}>删除</button>
              </div>
              <span className="arrow">→</span>
            </div>
    {panel && <div className="recent-edit-panel">
      {panel === 'title' ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>本地备注标题<input autoFocus aria-label="本地备注标题" maxLength={120} value={draft} disabled={busy} placeholder="例如：节目草稿需求" onChange={event => setDraft(event.target.value)} /></label>
        <p>仅用于本地标记需求；留空可恢复原始标题。</p>
        <div><button type="button" disabled={busy} onClick={() => setPanel(null)}>取消</button><button type="submit" disabled={busy}>{busy ? '保存中…' : '保存标题'}</button></div>
      </form> : <>
        <p>删除这条本地审核记录？对应批注、对话和审核结果也会删除，正在运行的机审会停止。Git 分支和 GitHub PR 不受影响。</p>
        <div><button type="button" disabled={busy} onClick={() => setPanel(null)}>取消</button><button type="button" className="recent-confirm-delete" disabled={busy} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除审核'}</button></div>
      </>}
      {error && <p className="recent-action-error" role="alert">{error}</p>}
    </div>}
  </div>;
}

function SourceBadge({ source, sourceRef }: { source: SourceKind; sourceRef: string }) {
  if (source === 'github-pr') {
    const num = sourceRef.match(/#?(\d+)/)?.[1];
    return (
      <span className="srcbadge gh">
        <GhIcon />
        <b>{num ? `#${num}` : 'PR'}</b>
      </span>
    );
  }
  if (source === 'gitbutler-vbranch') {
    return (
      <span className="srcbadge gb">
        <GitButlerIcon />
        vbranch
      </span>
    );
  }
  return (
    <span className="srcbadge local">
      <LocalBranchIcon />
      本地
    </span>
  );
}

const STATUS_META: Record<ReviewStatus, { cls: string; label: string; pulse?: boolean }> = {
  scanning: { cls: 'scanning', label: '扫描中', pulse: true },
  reviewing: { cls: 'review', label: '审核中', pulse: true },
  completed: { cls: 'done', label: '已完成' },
  submitted: { cls: 'submitted', label: '✓ 已提交' },
  failed: { cls: 'failed', label: '✕ 失败' },
};

function StatusChip({
  status,
  unscanned,
  scanningScopes,
}: {
  status: ReviewStatus;
  unscanned: boolean;
  scanningScopes: number;
}) {
  // 与历史屏同一口径:子范围在扫即整条 PR 在扫;轮次 0 的容器不能借 agent 那套运行态文案
  if (scanningScopes > 0) {
    const m = STATUS_META.scanning;
    return (
      <span className={`stat ${m.cls}`} title={`${scanningScopes} 个提交范围正在机审`}>
        <span className="pulse" />
        {m.label}
      </span>
    );
  }
  if (unscanned)
    return (
      <span className="stat idle" title="只拉了 diff,还没跑过机审">
        {UNSCANNED_LABEL}
      </span>
    );
  const m = STATUS_META[status];
  return (
    <span className={`stat ${m.cls}`}>
      {m.pulse && <span className="pulse" />}
      {m.label}
    </span>
  );
}
