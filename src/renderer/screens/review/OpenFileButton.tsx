import { useEffect, useState } from 'react';
import type { LocalEditor } from '@shared/ipc';

// 同一屏可能有上百个文件头,共享一次编辑器探测。
let editorsRequest: Promise<LocalEditor[]> | undefined;
export function OpenFileButton({ reviewId, path, hasLocalRepo, line }: { reviewId: string; path: string; hasLocalRepo: boolean; line?: number }) {
  const [editors, setEditors] = useState<LocalEditor[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const timer = setTimeout(() => setOpened(false), 1800);
    return () => clearTimeout(timer);
  }, [opened]);
  useEffect(() => {
    let alive = true;
    editorsRequest ??= window.duetlens.editor.list().catch((error) => {
      editorsRequest = undefined;
      throw error;
    });
    editorsRequest.then((value) => alive && setEditors(value)).catch((error: Error) => alive && setError(error.message));
    return () => { alive = false; };
  }, []);
  const editor = editors?.[0];
  const hint = !hasLocalRepo ? '请先关联本地仓库' : editors?.length === 0 ? '未检测到支持的代码编辑器' : `打开本地当前文件${line ? `第 ${line} 行` : ''},可能与审核版本不同`;
  const disabled = busy || !hasLocalRepo || !editor;
  const open = async (choose: boolean) => {
    setError('');
    setOpened(false);
    setBusy(true);
    try {
      const result = await window.duetlens.editor.openFile(reviewId, path, choose, line);
      if (!result.ok) setError(result.message);
      else if (!choose) setOpened(true);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <span className="file-editor-action">
      <span className="file-editor-buttons">
        <button type="button" className="fh-btn" disabled={disabled} title={hint} onClick={() => void open(false)}>
          <span aria-hidden="true">↗</span> {busy ? '正在打开…' : opened ? '已打开' : editor ? `在 ${editor.name} 中打开` : '编辑器打开'}
        </button>
        <button type="button" className="fh-btn file-editor-more" disabled={disabled} title="打开方式 · 选择本机编辑器" aria-label={`打开方式: ${path}`} onClick={() => void open(true)}>▾</button>
      </span>
      {error && <span className="file-editor-error" role="alert">{error}<button type="button" aria-label="关闭打开文件提示" onClick={() => setError('')}>×</button></span>}
    </span>
  );
}
