// Rollup properties: aggregate a property of the pages related through a relation property.
// Computed client-side from the related databases' rows (RowContext.related).
import type { NumberFormat, Page, PropertyDef, RollupFunction } from '@oriel/shared';
import { differenceInCalendarDays } from 'date-fns';
import type { FormulaResult, FormulaValue } from './formula';
import type { DateRange } from './dates';
import { displayText, formatDate, formatNumber } from './format';
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
  isEmptyValue,
  propertyKind,
  rawValue,
  type RowContext,
  type ValueKind,
} from './values';

export interface RollupItem {
  row: Page;
  prop: PropertyDef;
  ctx: RowContext;
}

export interface RollupResult extends FormulaResult {
  /** Plain text rendering (used by text filters, sorting, CSV, formulas). */
  text?: string;
  /** show_original: the related values, rendered with their own display. */
  items?: RollupItem[];
  /** date_range: covered interval. */
  range?: DateRange;
  /** Date results: whether the time is meaningful. */
  includeTime?: boolean;
  /** Number results: display format. */
  numberFormat?: NumberFormat;
  /** Related data not loaded yet (not cached). */
  pending?: boolean;
}

export const ROLLUP_FUNCTION_LABELS: Record<RollupFunction, string> = {
  show_original: 'Afficher l’original',
  count_all: 'Tout compter',
  count_values: 'Compter les valeurs',
  count_unique: 'Compter les valeurs uniques',
  count_empty: 'Compter les vides',
  count_not_empty: 'Compter les non vides',
  percent_empty: 'Pourcentage de vides',
  percent_not_empty: 'Pourcentage de non vides',
  sum: 'Somme',
  average: 'Moyenne',
  median: 'Médiane',
  min: 'Minimum',
  max: 'Maximum',
  range: 'Plage (max − min)',
  earliest: 'Date la plus ancienne',
  latest: 'Date la plus récente',
  date_range: 'Plage de dates',
  checked: 'Cochées',
  unchecked: 'Non cochées',
  percent_checked: 'Pourcentage cochées',
};

const COMMON: RollupFunction[] = [
  'show_original',
  'count_all',
  'count_values',
  'count_unique',
  'count_empty',
  'count_not_empty',
  'percent_empty',
  'percent_not_empty',
];

/** Functions offered for a target property of the given kind. */
export function rollupFunctionsForKind(kind: ValueKind): RollupFunction[] {
  switch (kind) {
    case 'number':
      return [...COMMON, 'sum', 'average', 'median', 'min', 'max', 'range'];
    case 'date':
      return [...COMMON, 'earliest', 'latest', 'date_range'];
    case 'checkbox':
      return ['show_original', 'count_all', 'checked', 'unchecked', 'percent_checked'];
    default:
      return COMMON;
  }
}

/** Logical kind of a rollup's result (drives filters, sorting and footer calculations). */
export function rollupKind(prop: PropertyDef): ValueKind {
  switch (prop.rollup?.function) {
    case undefined:
    case 'show_original':
      return 'text';
    case 'earliest':
    case 'latest':
    case 'date_range':
      return 'date';
    default:
      return 'number';
  }
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** Values held by a related row, as typed keys (multi-valued properties count each value). */
function valuesOf(row: Page, prop: PropertyDef, ctx: RowContext): string[] {
  switch (prop.type) {
    case 'multi_select':
      return getIdList(row, prop).filter((id) => findOption(prop, id));
    case 'person':
    case 'relation':
    case 'created_by':
    case 'last_edited_by':
    case 'select':
    case 'status':
      return getIdList(row, prop);
    case 'files':
      return asFiles(rawValue(row, prop)).map((f) => f.url);
    case 'checkbox':
      return getBoolean(row, prop, ctx) ? ['true'] : [];
    default: {
      if (isEmptyValue(row, prop, ctx)) return [];
      return [valueKey(row, prop, ctx)];
    }
  }
}

const typedKey = (v: FormulaValue): string => (v instanceof Date ? `date:${v.getTime()}` : `${typeof v}:${String(v)}`);
const rangeKey = (r: DateRange | null): string => `date:${r?.start.getTime()}${r?.end ? `→${r.end.getTime()}` : ''}`;

/**
 * Typed key of a single value, for count_unique: built from the raw value, not its display (1,231 € and
 * 1,232 € shown with two decimals are two values; so are two times of the same minute).
 */
function valueKey(row: Page, prop: PropertyDef, ctx: RowContext): string {
  switch (prop.type) {
    case 'number':
    case 'unique_id':
      return typedKey(getNumber(row, prop, ctx));
    case 'date':
    case 'created_time':
    case 'last_edited_time':
    case 'last_visited':
      return rangeKey(getDateRange(row, prop, ctx));
    case 'formula':
      return typedKey(getFormulaResult(row, prop, ctx).value);
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      return r.range ? rangeKey(r.range) : typedKey(r.value);
    }
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'place':
      return `string:${getText(row, prop, ctx)}`;
    default:
      return `string:${displayText(row, prop, ctx)}`;
  }
}

const numberResult = (value: number, numberFormat: NumberFormat = 'number'): RollupResult => ({
  type: 'number',
  value,
  numberFormat,
  text: formatNumber(value, numberFormat),
});

const EMPTY: RollupResult = { type: 'empty', value: null, text: '' };

/** Computes a rollup for `row` (`stack`: properties being evaluated, for cycle detection). */
export function computeRollup(row: Page, prop: PropertyDef, ctx: RowContext, _stack: string[]): RollupResult {
  const cfg = prop.rollup;
  if (!cfg || !cfg.relationPropertyId || !cfg.targetPropertyId) return { ...EMPTY, error: 'Rollup à configurer' };
  const rel = ctx.byId.get(cfg.relationPropertyId);
  if (!rel || rel.type !== 'relation' || !rel.relation) return { ...EMPTY, error: 'Relation introuvable' };
  const tctx = ctx.related?.context(rel.relation.databaseId);
  if (!tctx) return { ...EMPTY, pending: true };
  const target = tctx.byId.get(cfg.targetPropertyId);
  if (!target) return { ...EMPTY, error: 'Propriété introuvable' };
  const ids = getIdList(row, rel);
  const rows: Page[] = [];
  for (const id of ids) {
    const r = ctx.related?.row(id);
    if (r) rows.push(r);
  }
  const fn = cfg.function;
  const numberFormat: NumberFormat = target.type === 'number' ? (target.numberFormat ?? 'number') : 'number';
  const total = rows.length;
  const out = ((): RollupResult => {
    switch (fn) {
      case 'show_original': {
        const items = rows.filter((r) => !isEmptyValue(r, target, tctx)).map((r) => ({ row: r, prop: target, ctx: tctx }));
        const text = items.map((i) => displayText(i.row, i.prop, i.ctx)).filter(Boolean).join(', ');
        if (target.type === 'number' && items.length === 1) {
          const n = getNumber(items[0]!.row, target, tctx);
          if (n !== null) return { ...numberResult(n, numberFormat), items };
        }
        return { type: text ? 'string' : 'empty', value: text || null, text, items };
      }
      case 'count_all':
        return numberResult(total);
      case 'count_values': {
        let n = 0;
        for (const r of rows) n += valuesOf(r, target, tctx).length;
        return numberResult(n);
      }
      case 'count_unique': {
        const set = new Set<string>();
        for (const r of rows) for (const v of valuesOf(r, target, tctx)) set.add(v);
        return numberResult(set.size);
      }
      case 'count_empty':
      case 'count_not_empty':
      case 'percent_empty':
      case 'percent_not_empty': {
        let empty = 0;
        for (const r of rows) if (isEmptyValue(r, target, tctx)) empty++;
        if (fn === 'count_empty') return numberResult(empty);
        if (fn === 'count_not_empty') return numberResult(total - empty);
        const part = fn === 'percent_empty' ? empty : total - empty;
        return numberResult(total === 0 ? 0 : round((part / total) * 100), 'percent');
      }
      case 'checked':
      case 'unchecked':
      case 'percent_checked': {
        let checked = 0;
        for (const r of rows) if (getBoolean(r, target, tctx)) checked++;
        if (fn === 'checked') return numberResult(checked);
        if (fn === 'unchecked') return numberResult(total - checked);
        return numberResult(total === 0 ? 0 : round((checked / total) * 100), 'percent');
      }
      case 'sum':
      case 'average':
      case 'median':
      case 'min':
      case 'max':
      case 'range': {
        const nums: number[] = [];
        for (const r of rows) {
          const n = getNumber(r, target, tctx);
          if (n !== null) nums.push(n);
        }
        if (nums.length === 0) return fn === 'sum' ? numberResult(0, numberFormat) : EMPTY;
        let value: number;
        if (fn === 'sum') value = nums.reduce((a, b) => a + b, 0);
        else if (fn === 'average') value = nums.reduce((a, b) => a + b, 0) / nums.length;
        else if (fn === 'median') value = median([...nums].sort((a, b) => a - b));
        else if (fn === 'min') value = Math.min(...nums);
        else if (fn === 'max') value = Math.max(...nums);
        else value = Math.max(...nums) - Math.min(...nums);
        value = round(value);
        if (fn === 'average' && numberFormat === 'number') value = Math.round(value * 100) / 100;
        return numberResult(value, numberFormat);
      }
      case 'earliest':
      case 'latest':
      case 'date_range': {
        let min: DateRange | null = null;
        let max: { date: Date; includeTime: boolean } | null = null;
        for (const r of rows) {
          const d = getDateRange(r, target, tctx);
          if (!d) continue;
          const end = d.end ?? d.start;
          if (!min || d.start < min.start) min = d;
          if (!max || end > max.date) max = { date: end, includeTime: d.includeTime };
        }
        if (!min || !max) return EMPTY;
        if (fn === 'earliest') return { type: 'date', value: min.start, includeTime: min.includeTime, text: formatDate(min.start, min.includeTime) };
        if (fn === 'latest') return { type: 'date', value: max.date, includeTime: max.includeTime, text: formatDate(max.date, max.includeTime) };
        const includeTime = min.includeTime || max.includeTime;
        const range: DateRange = { start: min.start, end: max.date > min.start ? max.date : null, includeTime };
        const days = differenceInCalendarDays(max.date, min.start);
        const text = range.end ? `${formatDate(range.start, includeTime)} → ${formatDate(range.end, includeTime)}` : formatDate(range.start, includeTime);
        return { type: 'date', value: min.start, range, includeTime, text: text + (days > 0 ? ` (${days} j)` : '') };
      }
    }
  })();
  return out;
}

/** Kind of the rollup's target property (to offer the matching functions). */
export function rollupTargetKind(target: PropertyDef, tctx: RowContext | undefined): ValueKind {
  return tctx ? propertyKind(target, [], tctx) : propertyKind(target);
}
