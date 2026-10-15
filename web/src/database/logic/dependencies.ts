// Timeline dependencies: a self relation listing, for each row, the rows that block it
// (« Bloqué par »). Arrows go from the blocking row to the blocked one; a blocked row starting
// before its blocker ends is a conflict; moving a row can shift its dependents in cascade.
import type { DateValue, Page, PropertyDef } from '@oriel/shared';
import { dayKey, shiftDateValue } from './dates';
import { getIdList, rawValue, type RowContext } from './values';
import { getDateRange } from './values';

export interface DependencyEdge {
  /** Blocking row. */
  from: string;
  /** Blocked row. */
  to: string;
}

/** Relation properties usable as dependencies (relations to the database itself). */
export function dependencyCandidates(properties: PropertyDef[], databaseId: string): PropertyDef[] {
  return properties.filter((p) => p.type === 'relation' && p.relation?.databaseId === databaseId);
}

/** Edges between the given rows (`depProp` lists the blockers of each row). */
export function dependencyEdges(rows: readonly Page[], depProp: PropertyDef): DependencyEdge[] {
  const ids = new Set(rows.map((r) => r.id));
  const out: DependencyEdge[] = [];
  for (const r of rows) {
    for (const blocker of getIdList(r, depProp)) {
      if (blocker !== r.id && ids.has(blocker)) out.push({ from: blocker, to: r.id });
    }
  }
  return out;
}

export interface DaySpan {
  start: Date;
  end: Date;
}

/** Rows whose start is not after the end of one of their blockers. */
export function conflictingRows(edges: readonly DependencyEdge[], spanOf: (id: string) => DaySpan | null): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    const blocker = spanOf(e.from);
    const blocked = spanOf(e.to);
    if (blocker && blocked && dayKey(blocked.start) <= dayKey(blocker.end)) out.add(e.to);
  }
  return out;
}

export function isConflict(edge: DependencyEdge, spanOf: (id: string) => DaySpan | null): boolean {
  const blocker = spanOf(edge.from);
  const blocked = spanOf(edge.to);
  return !!blocker && !!blocked && dayKey(blocked.start) <= dayKey(blocker.end);
}

/** Every row depending (transitively) on `rowId`, in breadth-first order. Cycles are ignored. */
export function dependentsOf(rows: readonly Page[], depProp: PropertyDef, rowId: string): string[] {
  const blockedBy = new Map<string, string[]>();
  for (const r of rows) {
    for (const blocker of getIdList(r, depProp)) {
      const list = blockedBy.get(blocker);
      if (list) list.push(r.id);
      else blockedBy.set(blocker, [r.id]);
    }
  }
  const seen = new Set([rowId]);
  const out: string[] = [];
  const queue = [rowId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of blockedBy.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

/**
 * Property patches shifting the dependents of `rowId` by `days` (gaps between tasks preserved).
 * Rows without a date are skipped.
 */
export function cascadeShift(
  rows: readonly Page[],
  depProp: PropertyDef,
  rowId: string,
  days: number,
  startProp: PropertyDef,
  endProp: PropertyDef | null,
): Array<{ rowId: string; properties: Record<string, DateValue> }> {
  if (!days) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Array<{ rowId: string; properties: Record<string, DateValue> }> = [];
  for (const id of dependentsOf(rows, depProp, rowId)) {
    const row = byId.get(id);
    if (!row) continue;
    const start = rawValue(row, startProp) as DateValue | null;
    if (!start || typeof start !== 'object') continue;
    const properties: Record<string, DateValue> = { [startProp.id]: shiftDateValue(start, days) };
    if (endProp) {
      const end = rawValue(row, endProp) as DateValue | null;
      if (end && typeof end === 'object') properties[endProp.id] = shiftDateValue(end, days);
    }
    out.push({ rowId: id, properties });
  }
  return out;
}

/** Day span of a row for the timeline (start property, end from the range or the end property). */
export function rowDaySpan(row: Page, startProp: PropertyDef, endProp: PropertyDef | null, ctx: RowContext): DaySpan | null {
  const r = getDateRange(row, startProp, ctx);
  if (!r) return null;
  let end = r.end ?? r.start;
  if (endProp) {
    const e = getDateRange(row, endProp, ctx);
    if (e) end = e.start;
  }
  return end < r.start ? { start: end, end: r.start } : { start: r.start, end };
}
