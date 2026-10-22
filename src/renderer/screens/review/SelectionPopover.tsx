import { useState } from 'react';
import { PencilIcon } from './PencilIcon';

/** 框选动作:在 Duetlens 批注,或把文件行引用传到绑定的 Codex 对话。定位和选区解析由 DiffPane 托管。 */
export interface SelectionPopoverProps {
  label: string;
  /** 固定定位坐标(viewport) */
  top: number;
  left: number;
  onAnnotate: () => void;
  onAddToCodex?: () => Promise<string>;
}

export function SelectionPopover({ label, top, left, onAnnotate, onAddToCodex }: SelectionPopoverProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div
      className="sel-pop show"
      style={{ top, left }}
      // 阻止 mousedown 冒泡到全局关闭逻辑,否则点按钮会先清掉选区
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="sp-range">{label}</span>
      <button className="sp-annotate" onClick={onAnnotate}>
        <PencilIcon /> 段落批注
      </button>
      <button type="button" className="sp-annotate" disabled={!onAddToCodex || busy} title={onAddToCodex ? '添加带行号的 Codex 文件引用' : '请先点击顶栏“绑定 Codex”'} onClick={() => {
        if (!onAddToCodex || busy) return;
        setBusy(true); setMessage('');
        void onAddToCodex().then(setMessage).catch((error: Error) => setMessage(error.message)).finally(() => setBusy(false));
      }}>{busy ? '添加中…' : '添加到 Codex'}</button>
      {message && <span className="codex-selection-status" role="status">{message}</span>}
    </div>
  );
}
