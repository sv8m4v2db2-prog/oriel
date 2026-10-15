// Ordering of siblings with fractional indexes (lexicographically sortable strings), so that
// moving one item never rewrites its siblings.
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export interface Positioned {
  id: string;
  position: string;
}

export const comparePositions = (a: Positioned, b: Positioned) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export const sortByPosition = <T extends Positioned>(items: readonly T[]): T[] =>
  [...items].sort(comparePositions);

export const positionBetween = (before: string | null, after: string | null): string =>
  generateKeyBetween(before, after);

export const positionsBetween = (before: string | null, after: string | null, n: number): string[] =>
  generateNKeysBetween(before, after, n);

/**
 * Compute the position for inserting into an (unsorted) sibling list.
 * - after === undefined → append at the end
 * - after === null      → insert first
 * - after === id        → insert right after that sibling (falls back to the end if unknown)
 * `excludeId` lets a move ignore the item being moved.
 */
export function positionForInsert(
  siblings: readonly Positioned[],
  after: string | null | undefined,
  excludeId?: string,
): string {
  const sorted = sortByPosition(siblings.filter((s) => s.id !== excludeId));
  if (sorted.length === 0) return positionBetween(null, null);
  if (after === null) return positionBetween(null, sorted[0]!.position);
  const idx = after === undefined ? -1 : sorted.findIndex((s) => s.id === after);
  if (idx === -1) return positionBetween(sorted[sorted.length - 1]!.position, null);
  const next = sorted[idx + 1];
  return positionBetween(sorted[idx]!.position, next ? next.position : null);
}
