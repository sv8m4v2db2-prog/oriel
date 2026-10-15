// Size of an element (callback ref), tracked with a ResizeObserver.
import { useLayoutEffect, useState } from 'react';

export function useElementSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ width: r.width, height: r.height });
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize((s) => (s.width === box.width && s.height === box.height ? s : { width: box.width, height: box.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, ...size };
}
