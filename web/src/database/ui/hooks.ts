// Rendering helpers for large row counts: fixed-height windowing and incremental chunks.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Nearest ancestor that actually scrolls vertically, or null for the window. Horizontal scrollers
 * (`overflow-x: auto` also computes `overflow-y: auto`, and their scrollbar makes scrollHeight a bit
 * larger than clientHeight) are marked with `data-hscroll` and skipped.
 */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (!node.hasAttribute('data-hscroll')) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

export interface WindowRange {
  start: number;
  end: number;
}

/**
 * Visible slice of a list of `count` rows of fixed `rowHeight` rendered inside `ref`, relative to
 * the nearest scroll container. Disabled → the full range.
 */
export function useWindowRange(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  enabled: boolean,
  overscan = 12,
): WindowRange {
  const initialEnd = enabled ? Math.min(count, 60) : count;
  const [range, setRange] = useState<WindowRange>({ start: 0, end: initialEnd });

  const compute = useCallback(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setRange((r) => (r.start === 0 && r.end === count ? r : { start: 0, end: count }));
      return;
    }
    const parent = findScrollParent(el);
    const rect = el.getBoundingClientRect();
    const viewTop = parent ? parent.getBoundingClientRect().top : 0;
    const viewBottom = parent ? parent.getBoundingClientRect().bottom : window.innerHeight;
    const top = viewTop - rect.top;
    const bottom = viewBottom - rect.top;
    const start = Math.max(0, Math.min(count, Math.floor(top / rowHeight) - overscan));
    const end = Math.max(start, Math.min(count, Math.ceil(bottom / rowHeight) + overscan));
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [ref, enabled, count, rowHeight, overscan]);

  useLayoutEffect(() => {
    compute();
  }, [compute]);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    // Capture phase: scroll events of any container (they don't bubble).
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, compute]);

  return enabled ? range : { start: 0, end: count };
}

/**
 * Incremental rendering: shows `step` items, then more whenever the returned sentinel ref becomes
 * visible (or `showMore` is called). Resets when `resetKey` changes.
 */
export function useChunk(total: number, step: number, resetKey?: unknown) {
  const [limit, setLimit] = useState(step);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => setLimit(step), [resetKey, step]);
  const showMore = useCallback(() => setLimit((l) => l + step), [step]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || limit >= total || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) showMore();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [limit, total, showMore]);
  return { count: Math.min(limit, total), hasMore: limit < total, showMore, sentinel };
}

/** Keeps the latest value in a ref (stable callbacks reading fresh state). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
