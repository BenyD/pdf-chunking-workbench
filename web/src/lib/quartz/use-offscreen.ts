'use client';

import {useEffect, useRef} from 'react';

/**
 * Marks a live frame with data-offscreen while it is out of view, so its loops pause: the running arc inside it
 * stops on that attribute. Put the returned ref on the frame. `active` is the frame's
 * own live state; when it is false the observer goes and the attribute comes off. It writes the attribute directly,
 * so scrolling a long page re-renders nothing.
 */
function useOffscreen<E extends HTMLElement = HTMLElement>(active = true) {
  const ref = useRef<E>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) el.removeAttribute('data-offscreen');
      else el.setAttribute('data-offscreen', '');
    });
    io.observe(el);
    return () => { io.disconnect(); el.removeAttribute('data-offscreen'); };
  }, [active]);
  return ref;
}

export {useOffscreen};
