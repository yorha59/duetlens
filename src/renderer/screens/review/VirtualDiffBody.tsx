import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useIsActiveTab } from '../../review/TabVisibility';

/** 文件头一直保留,代码表仅在视口附近挂载,用实测高度维持滚动位置。 */
export function VirtualDiffBody({ force, estimatedHeight, onMount, children }: {
  force: boolean; estimatedHeight: number; onMount: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRef(estimatedHeight);
  const [pinned, setPinned] = useState(false);
  const [near, setNear] = useState(false);
  const active = useIsActiveTab();
  const mounted = force || pinned || (active && near);
  useEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: element.closest('.diff.pane'), rootMargin: '800px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!mounted || !element) return;
    const measure = () => { const value = element.getBoundingClientRect().height; if (value > 0) height.current = value; };
    measure(); onMount();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted, onMount]);
  return <div ref={ref} onFocusCapture={() => setPinned(true)} className="virtual-diff-body" data-mounted={mounted} style={mounted ? undefined : { height: height.current }}>
    {mounted ? children : null}
  </div>;
}
