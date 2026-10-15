// Multi-key sorting (SPEC §5.5). Empty values always come last, whatever the direction.
// Without sort rules the manual order (row position) applies.
import type { Page, PropertyDef, SortRule } from '@oriel/shared';
import { comparePositions } from '@oriel/shared';
import { collatorCompare } from './text';
import { formulaValueToText } from './formula';
import { verificationRank } from '../row/verification';
import {
  asFiles,
  findOption,
  getBoolean,
  getDateRange,
  getFormulaResult,
  getIdList,
  getNumber,
  getRollupResult,
  getText,
  orderedOptions,
  asPlace,
  rawValue,
  type RowContext,
} from './values';

type SortKey = number | string | null;


function joinNonEmpty(parts: string[]): string | null {
  const s = parts.filter(Boolean).join(', ');
  return s === '' ? null : s;
}

/** Sort key of one row for one property. */
export function sortKey(row: Page, prop: PropertyDef, ctx: RowContext, optionRank?: Map<string, number>): SortKey {
  switch (prop.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone': {
      const t = getText(row, prop, ctx).trim();
      return t === '' ? null : t;
    }
    case 'number':
    case 'unique_id':
      return getNumber(row, prop, ctx);
    case 'select':
    case 'status': {
      const id = rawValue(row, prop);
      if (typeof id !== 'string') return null;
      const rank = optionRank?.get(id);
      return rank === undefined ? null : rank;
    }
    case 'multi_select':
      return joinNonEmpty(getIdList(row, prop).map((id) => findOption(prop, id)?.name ?? ''));
    case 'person':
    case 'created_by':
    case 'last_edited_by':
      return joinNonEmpty(getIdList(row, prop).map((id) => ctx.users.get(id)?.name ?? ''));
    case 'relation':
      return joinNonEmpty(getIdList(row, prop).map((id) => ctx.relationTitle(id) ?? ''));
    case 'files':
      return joinNonEmpty(asFiles(rawValue(row, prop)).map((f) => f.name));
    case 'date':
    case 'created_time':
    case 'last_visited':
    case 'last_edited_time': {
      const r = getDateRange(row, prop, ctx);
      return r ? r.start.getTime() : null;
    }
    case 'checkbox':
      return getBoolean(row, prop, ctx) ? 1 : 0;
    case 'formula': {
      const r = getFormulaResult(row, prop, ctx);
      if (r.value === null) return null;
      if (typeof r.value === 'number') return r.value;
      if (typeof r.value === 'boolean') return r.value ? 1 : 0;
      if (r.value instanceof Date) return r.value.getTime();
      // Lists, pages and people (I2) sort by their text.
      const text = formulaValueToText(r.value);
      return text === '' ? null : text;
    }
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      if (r.value === null) return null;
      if (typeof r.value === 'number') return r.value;
      if (typeof r.value === 'boolean') return r.value ? 1 : 0;
      if (r.value instanceof Date) return r.value.getTime();
      // Lists, pages and people (I2) sort by their text.
      const text = formulaValueToText(r.value);
      return text === '' ? null : text;
    }
    case 'place':
      return asPlace(rawValue(row, prop))?.address || null;
    case 'verification':
      return verificationRank(rawValue(row, prop));
  }
}

/** Compares two non-null keys: numbers before strings, strings with the French collator. */
export function compareKeys(a: Exclude<SortKey, null>, b: Exclude<SortKey, null>): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return collatorCompare(a, b);
}

/** Returns a new array sorted by the rules (stable; ties keep the incoming order). */
export function applySorts(rows: readonly Page[], sorts: readonly SortRule[] | null | undefined, ctx: RowContext): Page[] {
  const rules = (sorts ?? [])
    .map((s) => ({ s, prop: ctx.byId.get(s.propertyId) }))
    .filter((x): x is { s: SortRule; prop: PropertyDef } => !!x.prop);
  if (rules.length === 0) return [...rows];
  const ranks = rules.map(({ prop }) => {
    if (prop.type !== 'select' && prop.type !== 'status') return undefined;
    const m = new Map<string, number>();
    orderedOptions(prop).forEach((o, i) => m.set(o.id, i));
    return m;
  });
  const keyed = rows.map((row, index) => ({
    row,
    index,
    keys: rules.map(({ prop }, i) => sortKey(row, prop, ctx, ranks[i])),
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < rules.length; i++) {
      const ka = a.keys[i] ?? null;
      const kb = b.keys[i] ?? null;
      if (ka === null && kb === null) continue;
      if (ka === null) return 1;
      if (kb === null) return -1;
      const c = compareKeys(ka, kb);
      if (c !== 0) return rules[i]!.s.direction === 'desc' ? -c : c;
    }
    return a.index - b.index;
  });
  return keyed.map((k) => k.row);
}

/**
 * Manual order: rows by fractional position. With `rowOrder` (I1, the view's own order), a row's index
 * there replaces its page position; rows absent from it keep their page position (same key space).
 */
export function sortByManualOrder(rows: readonly Page[], rowOrder?: Readonly<Record<string, string>>): Page[] {
  if (!rowOrder || Object.keys(rowOrder).length === 0) return [...rows].sort(comparePositions);
  return rows
    .map((row) => ({ id: row.id, position: rowOrder[row.id] ?? row.position, row }))
    .sort(comparePositions)
    .map((k) => k.row);
}

/** Effective manual position of a row in a view (its view index, else its page position). */
export function manualPosition(row: Page, rowOrder?: Readonly<Record<string, string>>): string {
  return rowOrder?.[row.id] ?? row.position;
}
