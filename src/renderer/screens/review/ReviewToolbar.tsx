import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import './ReviewToolbar.css';

export interface ToolbarAction { id: string; label: string; content: ReactNode }
const STORAGE_KEY = 'duetlens.review-toolbar.pinned';
function readPinned(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []; }
  catch { return []; }
}
interface DragGesture { id: string; pointerId: number; x: number; y: number; started: boolean; element: HTMLElement }

/** 拖动整个操作调整布局；普通点击仍执行操作,拖动结束不触发点击。 */
export function ReviewToolbar({ actions, middle }: { actions: ToolbarAction[]; middle?: ReactNode }) {
  const menuId = useId();
  const [pinned, setPinned] = useState(readPinned);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const [destination, setDestination] = useState<'pin' | 'menu' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<DragGesture | null>(null);
  const lastDrag = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const save = (ids: string[]) => {
    setPinned(ids);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      window.dispatchEvent(new Event('duetlens-toolbar-layout'));
    } catch { /* 禁用存储时仍允许本次调整。 */ }
  };
  useEffect(() => {
    const reload = () => setPinned(readPinned());
    window.addEventListener('storage', reload); window.addEventListener('duetlens-toolbar-layout', reload);
    return () => { window.removeEventListener('storage', reload); window.removeEventListener('duetlens-toolbar-layout', reload); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!gesture.current && !root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape); };
  }, [open]);
  const begin = (event: ReactPointerEvent<HTMLElement>, action: ToolbarAction) => {
    if (event.button !== 0 || !event.isPrimary || !event.currentTarget.contains(event.target as Node)) return;
    const button = (event.target as Element).closest('button');
    if (button?.disabled) return;
    gesture.current = { id: action.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false, element: event.currentTarget };
  };
  useEffect(() => {
    const header = root.current?.closest('.rev-topbar');
    if (!header) return;
    if (gesture.current?.started) header.classList.add('toolbar-drag-active');
    const hit = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y);
      if (!target || !header.contains(target)) return { mode: null, before: undefined };
      if (target.closest('.review-toolbar-menu')) return { mode: 'menu' as const, before: undefined };
      const row = target.closest<HTMLElement>('.review-toolbar-pinned .review-toolbar-item');
      if (row) {
        const rect = row.getBoundingClientRect();
        const at = pinned.indexOf(row.dataset.actionId ?? '');
        return { mode: 'pin' as const, before: x < rect.x + rect.width / 2 ? row.dataset.actionId : pinned[at + 1] };
      }
      return { mode: 'pin' as const, before: undefined };
    };
    const finish = () => {
      const current = gesture.current;
      gesture.current = null;
      if (current?.started) lastDrag.current = Date.now();
      if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
      header.classList.remove('toolbar-drag-active'); setDragging(null); setDestination(null);
    };
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.started) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
        current.started = true;
        current.element.setPointerCapture(event.pointerId);
        header.classList.add('toolbar-drag-active');
        setDragging(current.id); setOpen(true);
      }
      event.preventDefault();
      setPoint({ x: event.clientX, y: event.clientY });
      setDestination(hit(event.clientX, event.clientY).mode);
    };
    const up = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.started) {
        event.preventDefault(); event.stopPropagation();
        const target = hit(event.clientX, event.clientY);
        if (target.mode && actions.some((action) => action.id === current.id)) {
          if (target.mode === 'menu') save(pinned.filter((id) => id !== current.id));
          else if (target.before !== current.id) {
            const next = pinned.filter((id) => id !== current.id);
            const at = target.before ? next.indexOf(target.before) : -1;
            next.splice(at < 0 ? next.length : at, 0, current.id); save(next);
          }
          setOpen(false);
        }
      }
      finish();
    };
    const cancel = () => finish();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current?.started) { finish(); setOpen(false); } };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape);
      // 动作列表和固定顺序更新时重绑处理器,在途手势仍由 ref 承接。
      header.classList.remove('toolbar-drag-active');
    };
  }, [pinned, actions]);
  const item = (action: ToolbarAction) => <div className="review-toolbar-item" data-action-id={action.id} key={action.id} onPointerDown={(event) => begin(event, action)} onDragStart={(event) => event.preventDefault()}>
    <div className="review-toolbar-control">{action.content}</div>
  </div>;
  const hidden = actions.filter((action) => !pinned.includes(action.id));
  return <div className={`review-toolbar-layout${dragging ? ' dragging' : ''}`} ref={root} onClickCapture={(event) => { if (Date.now() - lastDrag.current < 350) { event.preventDefault(); event.stopPropagation(); } }} onClick={(event) => { if ((event.target as Element).closest('.review-toolbar-control button')) setOpen(false); }}>
    <div className="review-toolbar-pinned" data-drop-active={destination === 'pin'} data-empty={!actions.some((action) => pinned.includes(action.id))} aria-label="固定的工具栏操作">
      {pinned.flatMap((id) => { const action = actions.find((item) => item.id === id); return action ? [item(action)] : []; })}
      {dragging && !actions.some((action) => pinned.includes(action.id)) && <span className="review-toolbar-drop">拖到这里固定</span>}
    </div>
    {middle}
    <div className="review-toolbar">
      <button ref={trigger} type="button" className="rerun-cta review-toolbar-trigger" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>更多 ···</button>
      <div id={menuId} className="review-toolbar-menu" hidden={!open} data-drop-active={destination === 'menu'}>
        <div className="review-toolbar-menu-title">工具栏操作</div>
        <p>拖动整项到顶部空白处固定,拖回这里收起。</p>
        {hidden.map(item)}
        {!hidden.length && <p>操作已全部固定,可拖回这里。</p>}
        {dragging && <div className="review-toolbar-drop">拖到这里收回菜单</div>}
      </div>
    </div>
    {dragging && <div className="review-toolbar-drag-preview" style={{ left: point.x + 12, top: point.y + 12 }} aria-hidden="true">{actions.find((action) => action.id === dragging)?.label}</div>}
  </div>;
}
