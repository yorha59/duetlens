import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './ReviewToolbar.css';

export interface ToolbarAction { id: string; label: string; content: ReactNode }
const STORAGE_KEY = 'duetlens.review-toolbar.pinned';
const DRAG_TYPE = 'application/x-duetlens-toolbar-action';
function readPinned(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []; }
  catch { return []; }
}

/** 次要操作默认收起,固定顺序跨审核共用；拖拽只改布局,不触发操作。 */
export function ReviewToolbar({ actions, middle }: { actions: ToolbarAction[]; middle?: ReactNode }) {
  const menuId = useId();
  const [pinned, setPinned] = useState(readPinned);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const lastDrag = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const save = (ids: string[]) => {
    setPinned(ids);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* 禁用存储时仍允许本次调整。 */ }
    window.dispatchEvent(new Event('duetlens-toolbar-layout'));
  };
  useEffect(() => {
    const reload = () => setPinned(readPinned());
    window.addEventListener('storage', reload); window.addEventListener('duetlens-toolbar-layout', reload);
    return () => { window.removeEventListener('storage', reload); window.removeEventListener('duetlens-toolbar-layout', reload); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [open]);
  const move = (id: string, fixed: boolean, before?: string) => {
    if (id === before || !actions.some((item) => item.id === id)) return;
    const next = pinned.filter((item) => item !== id);
    if (fixed) { const at = before ? next.indexOf(before) : -1; next.splice(at < 0 ? next.length : at, 0, id); }
    save(next);
  };
  const drop = (event: React.DragEvent, fixed: boolean, before?: string) => {
    const id = event.dataTransfer.getData(DRAG_TYPE);
    if (!id) return;
    event.preventDefault(); event.stopPropagation(); lastDrag.current = Date.now(); move(id, fixed, before); setDragging(null); if (fixed) setOpen(false);
  };
  const allow = (event: React.DragEvent) => { if (event.dataTransfer.types.includes(DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
  useEffect(() => {
    if (!dragging) return;
    const header = root.current?.closest('.rev-topbar');
    if (!header) return;
    header.classList.add('toolbar-drag-active');
    const overHeader = (event: Event) => {
      const drag = event as DragEvent;
      if (!drag.dataTransfer?.types.includes(DRAG_TYPE)) return;
      drag.preventDefault(); drag.dataTransfer.dropEffect = 'move';
    };
    const dropHeader = (event: Event) => {
      const drag = event as DragEvent;
      const id = drag.dataTransfer?.getData(DRAG_TYPE);
      if (!id || (drag.target as Element).closest('.review-toolbar-menu, .review-toolbar-pinned')) return;
      drag.preventDefault(); lastDrag.current = Date.now(); move(id, true); setDragging(null); setOpen(false);
    };
    header.addEventListener('dragover', overHeader); header.addEventListener('drop', dropHeader);
    return () => { header.classList.remove('toolbar-drag-active'); header.removeEventListener('dragover', overHeader); header.removeEventListener('drop', dropHeader); };
  }, [dragging, pinned, actions]);
  const item = (action: ToolbarAction, fixed: boolean) => <div className="review-toolbar-item" key={action.id} draggable onDragStart={(event) => { event.dataTransfer.setData(DRAG_TYPE, action.id); event.dataTransfer.effectAllowed = 'move'; lastDrag.current = Date.now(); setDragging(action.id); setOpen(true); }} onDragEnd={() => { lastDrag.current = Date.now(); setDragging(null); }} onDragOver={allow} onDrop={(event) => drop(event, fixed, fixed ? action.id : undefined)}>
    <span className="review-toolbar-grip" title={`拖动${action.label}以固定或收起`} aria-hidden="true">⠿</span>
    <div className="review-toolbar-control">{action.content}</div>
    <button className="review-toolbar-pin" type="button" title={fixed ? `将${action.label}收回菜单` : `将${action.label}固定到顶部`} aria-label={fixed ? `收起${action.label}` : `固定${action.label}`} onClick={() => move(action.id, !fixed)}>{fixed ? '−' : '＋'}</button>
  </div>;
  const hidden = actions.filter((action) => !pinned.includes(action.id));
  return <div className={`review-toolbar-layout${dragging ? ' dragging' : ''}`} ref={root} onClickCapture={(event) => { if (Date.now() - lastDrag.current < 250) { event.preventDefault(); event.stopPropagation(); } }} onClick={(event) => { if ((event.target as Element).closest('.review-toolbar-control button')) setOpen(false); }}>
    <div className="review-toolbar-pinned" aria-label="固定的工具栏操作" onDragOver={allow} onDrop={(event) => drop(event, true)}>
      {pinned.flatMap((id) => { const action = actions.find((item) => item.id === id); return action ? [item(action, true)] : []; })}
      {dragging && <span className="review-toolbar-drop">拖到这里固定</span>}
    </div>
    {middle}
    <div className="review-toolbar">
    <button ref={trigger} type="button" className="rerun-cta review-toolbar-trigger" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)} onDragEnter={() => { if (dragging) setOpen(true); }}>更多 ···</button>
    <div id={menuId} className="review-toolbar-menu" hidden={!open} onDragOver={allow} onDrop={(event) => drop(event, false)}>
      <div className="review-toolbar-menu-title">工具栏操作 <button type="button" onClick={() => save([])}>全部收起</button></div>
      <p>拖动整项到顶部空白处固定,拖回这里收起；也可点击 ＋ / −。</p>
      {hidden.map((action) => item(action, false))}
      {!hidden.length && <p>操作已全部固定,可拖回这里。</p>}
      {dragging && <div className="review-toolbar-drop">拖到这里收回菜单</div>}
    </div>
    </div>
  </div>;
}
