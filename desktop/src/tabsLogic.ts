// Tab bar arithmetic. Pure: operates on plain arrays so that it can be unit-tested.

/** New array with the item at `from` moved to `to` (both clamped); same array when nothing moves. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (target === from) return next;
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Index of the tab selected by ⌘1…⌘9: 1…8 are positional, 9 always means the last one. */
export function indexForShortcut(digit: number, count: number): number | null {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || count <= 0) return null;
  if (digit === 9) return count - 1;
  return digit - 1 < count ? digit - 1 : null;
}

/** Circular neighbour (`step` = +1 / −1). */
export function neighbourIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (((current + step) % count) + count) % count;
}

/** Index of the tab to activate after closing the tab at `closed` (the one on its right, else left). */
export function indexAfterClose(closed: number, countBefore: number): number {
  if (countBefore <= 1) return -1;
  return closed >= countBefore - 1 ? closed - 1 : closed;
}

/** Title shown in the tab bar. */
export function tabLabel(title: string | null | undefined): string {
  const text = (title ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 120) : 'Oriel';
}

/**
 * Where a dragged tab lands: index of the slot whose centre is nearest to `x`, given the left
 * edges and widths of the tabs in their current order.
 */
export function dropIndex(x: number, slots: ReadonlyArray<{ left: number; width: number }>): number {
  let best = 0;
  let bestDistance = Infinity;
  slots.forEach((slot, i) => {
    const distance = Math.abs(x - (slot.left + slot.width / 2));
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}
