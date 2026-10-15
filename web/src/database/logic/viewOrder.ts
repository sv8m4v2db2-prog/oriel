// I1 — manual order of a view and default template of a view (pure logic, shared by the layouts).
import { positionForInsert, positionsBetween, sortByPosition, type Page } from '@oriel/shared';

/**
 * Order of a view after moving `id` right after `after` (null = first), as the server computes it:
 * effective positions are the view's own indexes, else the page positions; equal or malformed keys are
 * renumbered for the whole view. Used for the optimistic update.
 */
export function moveInViewOrder(
  rows: readonly Page[],
  rowOrder: Readonly<Record<string, string>> | undefined,
  id: string,
  after: string | null,
): Record<string, string> {
  const next: Record<string, string> = { ...(rowOrder ?? {}) };
  const effective = rows.map((r) => ({ id: r.id, position: next[r.id] ?? r.position }));
  const target = after === id ? undefined : after;
  try {
    next[id] = positionForInsert(effective, target, id);
  } catch {
    const sorted = sortByPosition(effective);
    const keys = positionsBetween(null, null, sorted.length);
    sorted.forEach((r, i) => {
      r.position = keys[i]!;
      next[r.id] = r.position;
    });
    next[id] = positionForInsert(sorted, target, id);
  }
  return next;
}

/**
 * Template used by the « Nouveau » button of a view: the view's own default ('blank' = none), else the
 * database default. A default naming a template that no longer exists falls back to the next level.
 */
export function effectiveTemplateId(
  viewDefault: string | null | undefined,
  databaseDefault: string | null,
  templates: ReadonlyArray<{ id: string }>,
): string | null {
  if (viewDefault === 'blank') return null;
  if (viewDefault && templates.some((t) => t.id === viewDefault)) return viewDefault;
  return databaseDefault && templates.some((t) => t.id === databaseDefault) ? databaseDefault : null;
}

/**
 * Row after which `activeId` goes once dropped before/after `overId` among `sectionIds` (a list or
 * gallery section, in display order). The first row of a section goes right after the row preceding the
 * section in the whole view (`allIds`), or first (null). undefined = nothing to move.
 */
export function afterIdForDrop(
  sectionIds: readonly string[],
  allIds: readonly string[],
  activeId: string,
  overId: string,
  place: 'before' | 'after',
): string | null | undefined {
  if (activeId === overId) return undefined;
  const next = sectionIds.filter((x) => x !== activeId);
  const at = next.indexOf(overId);
  if (at === -1) return undefined;
  next.splice(place === 'after' ? at + 1 : at, 0, activeId);
  const idx = next.indexOf(activeId);
  if (idx > 0) return next[idx - 1]!;
  const following = next[1];
  if (!following) return undefined;
  const gi = allIds.indexOf(following);
  const prev = allIds.slice(0, Math.max(gi, 0)).reverse().find((x) => x !== activeId);
  return prev ?? null;
}
