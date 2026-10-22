import { useEffect, useState } from 'react';
import type { CodexBinding } from '@shared/codex-handoff';
import './CodexSessionButton.css';

export function CodexSessionButton({ reviewId, binding, onBinding, open, onOpen }: {
  reviewId: string; binding: CodexBinding | null; onBinding: (binding: CodexBinding | null) => void; open: boolean; onOpen: (open: boolean) => void;
}) {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<CodexBinding['mode']>('copy');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.duetlens.review.codexBinding(reviewId).then((result) => { if (alive) onBinding(result); }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [reviewId, onBinding]);
  useEffect(() => { if (open) { setValue(binding ? `codex://threads/${binding.threadId}` : ''); setMode(binding?.mode ?? 'copy'); } }, [open, binding]);
  const save = async (remove = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try { onBinding(await window.duetlens.review.bindCodex(reviewId, remove ? null : { threadId: value, mode })); onOpen(false); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <button className="rerun-cta" type="button" onClick={() => onOpen(true)} title={binding ? `已绑定 ${binding.threadId}；点击更换或解除` : '绑定已存在的 Codex 对话,选中代码后添加文件行引用'}>{binding ? 'Codex 已绑定' : '绑定 Codex'}</button>
    {open && <div className="codex-binding-scrim" onClick={() => !busy && onOpen(false)}>
      <form className="codex-binding-panel" role="dialog" aria-modal="true" aria-label="绑定 Codex 对话" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onOpen(false); } }} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h2>绑定 Codex 对话</h2>
        <p>粘贴已有本地对话的链接或 UUID。远端和本地审核视图共用此绑定；Duetlens 的机审会话保持独立。</p>
        <label htmlFor="codex-session-link">Codex 对话链接 / Session ID</label>
        <input id="codex-session-link" autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="codex://threads/…" disabled={busy} />
        <label><input type="radio" name="codex-transfer-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} /> 复制原生文件引用并打开对话</label>
        <p>在 Codex 按 ⌘V 添加,保留输入框已有草稿。</p>
        <label><input type="radio" name="codex-transfer-mode" checked={mode === 'prefill'} onChange={() => setMode('prefill')} /> 一键预填到输入框</label>
        <p>将引用预填到 Codex 输入框,可能替换未发送草稿。只预填,由你手动发送；长选区自动改为复制。</p>
        <p>文件引用带起止行号。删除侧或版本不一致时打开 Duetlens 选区快照,不会冒充当前本地文件。</p>
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
