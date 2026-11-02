import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** 只回报当前视口文件,不发起导航;滚动一帧最多读一次,空闲时不轮询。 */
export function useDiffScrollSpy(container: RefObject<HTMLDivElement>, active: boolean, revision: unknown, onSelect?: (path: string) => void) {
  const callback = useRef(onSelect);
  callback.current = onSelect;
  const navigatingUntil = useRef(0);
  const beginNavigation = useCallback(() => { navigatingUntil.current = performance.now() + 2000; }, []);
  useEffect(() => {
    const pane = container.current;
    if (!active || !pane) return;
    const files = [...pane.querySelectorAll<HTMLElement>('.diff-file[data-path], .offdiff.absent[data-path]')];
    if (!files.length) return;
    let frame = 0;
    let last: string | undefined;
    const update = () => {
      frame = 0;
      if (performance.now() < navigatingUntil.current || !pane.clientHeight) return;
      const top = pane.getBoundingClientRect().top + (parseFloat(getComputedStyle(pane).scrollPaddingTop) || 0) + 1;
      // 区块顺序固定,二分定位跨过阅读线的最后一个文件头,不扫描整份代码 DOM。
      let low = 0, high = files.length - 1, index = 0;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        if (files[middle].getBoundingClientRect().top <= top) { index = middle; low = middle + 1; }
        else high = middle - 1;
      }
      const path = files[index].dataset.path;
      if (path && path !== last) { last = path; callback.current?.(path); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const endNavigation = () => { navigatingUntil.current = 0; schedule(); };
    const onKey = (event: KeyboardEvent) => {
      if (!(event.target as HTMLElement).closest('input,textarea,[contenteditable=true]') && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) endNavigation();
    };
    pane.addEventListener('scroll', schedule, { passive: true });
    pane.addEventListener('scrollend', endNavigation);
    pane.addEventListener('wheel', endNavigation, { passive: true });
    pane.addEventListener('touchstart', endNavigation, { passive: true });
    pane.addEventListener('pointerdown', endNavigation);
    pane.addEventListener('keydown', onKey);
    const observer = new ResizeObserver(schedule);
    observer.observe(pane);
    for (const file of files) observer.observe(file);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      pane.removeEventListener('scroll', schedule);
      pane.removeEventListener('scrollend', endNavigation);
      pane.removeEventListener('wheel', endNavigation);
      pane.removeEventListener('touchstart', endNavigation);
      pane.removeEventListener('pointerdown', endNavigation);
      pane.removeEventListener('keydown', onKey);
    };
  }, [container, active, revision]);
  return beginNavigation;
}
