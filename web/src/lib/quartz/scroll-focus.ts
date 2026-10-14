'use client';

import {useEffect, useState, type RefObject} from 'react';

// A scroll box that only a pointer can scroll locks keyboard readers out of what is past its edge. While the
// box scrolls, it takes tabIndex 0, so Tab reaches it and the arrow keys scroll it (WCAG 2.1.1); while its
// content fits, it stays out of the tab order. The scroll area's viewport does the same on its own.

/** 0 while the element's content overflows it, in either axis, and undefined while it fits. */
export function useScrollTabStop(ref: RefObject<HTMLElement | null>, enabled = true): 0 | undefined {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) { setScrolls(false); return; }
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    // The box and each child it holds: rows arriving grow the child, not the box.
    const resize = new ResizeObserver(measure);
    const watch = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
      measure();
    };
    const swap = new MutationObserver(watch);
    swap.observe(el, {childList: true});
    watch();
    return () => { resize.disconnect(); swap.disconnect(); };
  }, [ref, enabled]);
  return scrolls ? 0 : undefined;
}
