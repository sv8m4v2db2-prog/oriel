// Chart data: rows grouped into categories (X axis) and optionally series, then aggregated
// (count, or sum / average / min / max of a number property). Pure: used by the chart views,
// the dashboard widgets and the tests.
import type {
  ChartAggregate,
  ChartConfig,
  ChartDateBucket,
  Color,
  NumberFormat,
  Page,
  PropertyDef,
  PropertyType,
} from '@oriel/shared';
import { NUMBER_CURRENCY_CODES } from '@oriel/shared';
import { addDays, addMonths, addWeeks, addYears, format, startOfDay, startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toDateString } from './dates';
import { displayText, formatNumber, formatPropertyNumber } from './format';
import { NO_VALUE_KEY } from './group';
import { sortKey } from './sort';
import { collatorCompare } from './text';
import {
  findOption,
  getBoolean,
  getDateRange,
  getIdList,
  getNumber,
  orderedOptions,
  propertyKind,
  type RowContext,
  type ValueKind,
} from './values';

export { NO_VALUE_KEY };
/** Key of the category gathering the categories past the display limit. */
export const OTHER_KEY = '__other__';

export const CHART_AGGREGATE_LABELS: Record<ChartAggregate, string> = {
  count: 'Nombre de lignes',
  sum: 'Somme',
  average: 'Moyenne',
  min: 'Minimum',
  max: 'Maximum',
};

export const CHART_BUCKET_LABELS: Record<ChartDateBucket, string> = {
  day: 'Jour',
  week: 'Semaine',
  month: 'Mois',
  year: 'Année',
};

/** Property types usable as X axis or series (files excluded: nothing to group by). */
const DIMENSION_TYPES: PropertyType[] = [
  'title',
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'checkbox',
  'url',
  'email',
  'phone',
  'relation',
  'formula',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'rollup',
  'place',
];

export const canChartBy = (prop: PropertyDef): boolean => DIMENSION_TYPES.includes(prop.type);

/** Properties whose values can be summed / averaged. */
export function canAggregate(prop: PropertyDef, kind?: ValueKind): boolean {
  if (prop.type === 'number') return true;
  if (prop.type === 'formula' || prop.type === 'rollup') return (kind ?? propertyKind(prop)) === 'number';
  return false;
}

type DimensionKind = 'option' | 'multi' | 'checkbox' | 'date' | 'number' | 'ids' | 'text';

function dimensionKind(prop: PropertyDef, kind: ValueKind): DimensionKind {
  switch (prop.type) {
    case 'select':
    case 'status':
      return 'option';
    case 'multi_select':
      return 'multi';
    case 'checkbox':
      return 'checkbox';
    case 'date':
    case 'created_time':
    case 'last_edited_time':
    case 'last_visited':
      return 'date';
    case 'number':
    case 'unique_id':
      return 'number';
    case 'person':
    case 'created_by':
    case 'last_edited_by':
    case 'relation':
      return 'ids';
    case 'formula':
    case 'rollup':
      return kind === 'date' ? 'date' : kind === 'number' ? 'number' : kind === 'checkbox' ? 'checkbox' : 'text';
    default:
      return 'text';
  }
}

/** Is the property shown as dates on a chart axis (bucket setting offered)? */
export function isDateDimension(prop: PropertyDef, kind?: ValueKind): boolean {
  return dimensionKind(prop, kind ?? propertyKind(prop)) === 'date';
}

// ---------------------------------------------------------------------------
// Date buckets
// ---------------------------------------------------------------------------

export interface DateBucket {
  key: string;
  label: string;
  /** Start of the bucket (ms), for chronological order. */
  start: number;
}

/** Bucket of a date: local day, week (Monday first), month or year. */
export function dateBucket(d: Date, bucket: ChartDateBucket): DateBucket {
  switch (bucket) {
    case 'day': {
      const s = startOfDay(d);
      return { key: toDateString(s), label: format(s, 'd MMM yyyy', { locale: fr }), start: s.getTime() };
    }
    case 'week': {
      const s = startOfWeek(d, { weekStartsOn: 1 });
      return { key: `S${toDateString(s)}`, label: `Sem. du ${format(s, 'd MMM yyyy', { locale: fr })}`, start: s.getTime() };
    }
    case 'month': {
      const s = startOfMonth(d);
      return { key: format(s, 'yyyy-MM'), label: format(s, 'MMM yyyy', { locale: fr }), start: s.getTime() };
    }
    case 'year': {
      const s = startOfYear(d);
      return { key: format(s, 'yyyy'), label: format(s, 'yyyy'), start: s.getTime() };
    }
  }
}

function nextBucketDate(d: Date, bucket: ChartDateBucket): Date {
  switch (bucket) {
    case 'day':
      return addDays(d, 1);
    case 'week':
      return addWeeks(d, 1);
    case 'month':
      return addMonths(d, 1);
    case 'year':
      return addYears(d, 1);
  }
}

/** Every bucket from `first` to `last` (inclusive); null when there would be more than `max`. */
export function bucketRange(first: number, last: number, bucket: ChartDateBucket, max = 400): DateBucket[] | null {
  const out: DateBucket[] = [];
  let d = new Date(first);
  while (d.getTime() <= last) {
    if (out.length >= max) return null;
    const b = dateBucket(d, bucket);
    out.push(b);
    d = nextBucketDate(new Date(b.start), bucket);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dimensions (category / series values of a row)
// ---------------------------------------------------------------------------

interface Slot {
  key: string;
  label: string;
  color: Color | null;
  /** Natural order: option index, timestamp, number, or text. */
  order: number | string;
}

interface Dimension {
  kind: DimensionKind;
  /** Slots known before reading the rows (options, checkbox states), in their natural order. */
  seeded: Slot[];
  slotsOf(row: Page): Slot[];
}

function makeDimension(prop: PropertyDef, ctx: RowContext, kind: ValueKind, bucket: ChartDateBucket): Dimension {
  const dk = dimensionKind(prop, kind);
  switch (dk) {
    case 'option':
    case 'multi': {
      const options = dk === 'option' ? orderedOptions(prop) : (prop.options ?? []);
      const seeded = options.map<Slot>((o, i) => ({ key: o.id, label: o.name, color: o.color, order: i }));
      const byId = new Map(seeded.map((s) => [s.key, s]));
      return {
        kind: dk,
        seeded,
        slotsOf: (row) =>
          getIdList(row, prop)
            .filter((id) => findOption(prop, id))
            .map((id) => byId.get(id)!)
            .filter(Boolean),
      };
    }
    case 'checkbox': {
      const yes: Slot = { key: 'true', label: 'Coché', color: 'green', order: 0 };
      const no: Slot = { key: 'false', label: 'Non coché', color: 'default', order: 1 };
      return { kind: dk, seeded: [yes, no], slotsOf: (row) => [getBoolean(row, prop, ctx) ? yes : no] };
    }
    case 'date':
      return {
        kind: dk,
        seeded: [],
        slotsOf: (row) => {
          const r = getDateRange(row, prop, ctx);
          if (!r) return [];
          const b = dateBucket(r.start, bucket);
          return [{ key: b.key, label: b.label, color: null, order: b.start }];
        },
      };
    case 'number':
      return {
        kind: dk,
        seeded: [],
        slotsOf: (row) => {
          const n = prop.type === 'unique_id' ? (sortKey(row, prop, ctx) as number | null) : getNumber(row, prop, ctx);
          if (typeof n !== 'number' || !Number.isFinite(n)) return [];
          const label = prop.type === 'unique_id' ? displayText(row, prop, ctx) : formatPropertyNumber(prop, n);
          return [{ key: `n:${n}`, label, color: null, order: n }];
        },
      };
    case 'ids':
      return {
        kind: dk,
        seeded: [],
        slotsOf: (row) =>
          getIdList(row, prop).map((id) => {
            const label =
              prop.type === 'relation' ? (ctx.relationTitle(id) ?? 'Page sans titre') : (ctx.users.get(id)?.name ?? 'Utilisateur inconnu');
            return { key: id, label, color: null, order: label };
          }),
      };
    case 'text':
      return {
        kind: dk,
        seeded: [],
        slotsOf: (row) => {
          const label = displayText(row, prop, ctx).trim();
          return label ? [{ key: `t:${label}`, label, color: null, order: label }] : [];
        },
      };
  }
}

const compareOrder = (a: number | string, b: number | string) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : collatorCompare(String(a), String(b));

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Aggregate of the rows: their count, or a statistic of the numbers of `valueProp` (rows without a number ignored). */
export function aggregateRows(rows: readonly Page[], aggregate: ChartAggregate, valueProp: PropertyDef | null, ctx: RowContext): number {
  if (aggregate === 'count' || !valueProp) return rows.length;
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const v = getNumber(row, valueProp, ctx);
    if (v === null) continue;
    n++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (n === 0) return 0;
  switch (aggregate) {
    case 'sum':
      return sum;
    case 'average':
      return sum / n;
    case 'min':
      return min;
    case 'max':
      return max;
  }
}

export interface ChartSeriesInfo {
  key: string;
  label: string;
  /** Option color (option / checkbox series); null: categorical palette by index. */
  color: Color | null;
}

export interface ChartCategory {
  key: string;
  label: string;
  color: Color | null;
  /** Value of the bar / slice / point (sum of the series when stacked). */
  value: number;
  /** Number of rows in the category. */
  count: number;
  /** Value per series key (only with a series property). */
  series: Record<string, number>;
  /** Number of rows per series key (0: no data — a gap on a line of averages). */
  seriesCounts: Record<string, number>;
  /** Rows of the category (clicking a bar lists them). */
  rowIds: string[];
}

export interface ChartData {
  categories: ChartCategory[];
  series: ChartSeriesInfo[];
  /** Aggregate over all the rows (« Graphique numérique », donut center). */
  total: number;
  rowCount: number;
  /** Series values add up (count / sum): stacked bars. Otherwise grouped bars. */
  stacked: boolean;
  /** Display format of the values. */
  numberFormat: NumberFormat;
  /** Decimals fixed in the value property's settings (D25); undefined: automatic. */
  numberPrecision?: number;
  /** Value property actually aggregated (null: rows are counted). */
  valueProperty: PropertyDef | null;
  /** X axis shows dates (chronological, gaps filled). */
  dateAxis: boolean;
}

export interface ChartOptions {
  /** Kinds of the properties (formula results); computed when absent. */
  kinds?: Map<string, ValueKind>;
  /** Categories shown before folding the rest into « Autres » (default 60). */
  maxCategories?: number;
  /** Series shown before folding the rest into « Autres » (default 8, the palette size). */
  maxSeries?: number;
}

interface Bin {
  slot: Slot;
  rows: Page[];
}

function binRows(rows: readonly Page[], dim: Dimension): { bins: Bin[]; none: Bin } {
  const bins = new Map<string, Bin>();
  for (const s of dim.seeded) bins.set(s.key, { slot: s, rows: [] });
  const none: Bin = { slot: { key: NO_VALUE_KEY, label: 'Sans valeur', color: 'default', order: '' }, rows: [] };
  for (const row of rows) {
    const slots = dim.slotsOf(row);
    if (slots.length === 0) none.rows.push(row);
    for (const s of slots) {
      let b = bins.get(s.key);
      if (!b) bins.set(s.key, (b = { slot: s, rows: [] }));
      b.rows.push(row);
    }
  }
  const list = [...bins.values()];
  // Seeded slots keep their order; discovered ones are sorted naturally.
  if (dim.seeded.length === 0) list.sort((a, b) => compareOrder(a.slot.order, b.slot.order));
  return { bins: list, none };
}

const uniqueRows = (bins: Bin[]): Page[] => {
  const seen = new Set<string>();
  const out: Page[] = [];
  for (const b of bins) {
    for (const r of b.rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
};

/** Computes the categories and series of a chart from the (already filtered) rows. */
export function computeChart(
  rows: readonly Page[],
  config: ChartConfig,
  properties: PropertyDef[],
  ctx: RowContext,
  opts: ChartOptions = {},
): ChartData {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const kindOf = (p: PropertyDef) => opts.kinds?.get(p.id) ?? propertyKind(p, rows, ctx);
  const rawValueProp = config.valueProperty ? byId.get(config.valueProperty) : undefined;
  const valueProp = config.aggregate !== 'count' && rawValueProp && canAggregate(rawValueProp, kindOf(rawValueProp)) ? rawValueProp : null;
  const aggregate: ChartAggregate = valueProp ? config.aggregate : 'count';
  const numberFormat: NumberFormat = valueProp?.type === 'number' ? (valueProp.numberFormat ?? 'number') : 'number';
  const stacked = aggregate === 'count' || aggregate === 'sum';
  const total = aggregateRows(rows, aggregate, valueProp, ctx);
  const base: ChartData = {
    categories: [],
    series: [],
    total,
    rowCount: rows.length,
    stacked,
    numberFormat,
    numberPrecision: valueProp?.type === 'number' ? valueProp.numberPrecision : undefined,
    valueProperty: valueProp,
    dateAxis: false,
  };

  const xProp = config.xProperty ? byId.get(config.xProperty) : undefined;
  if (!xProp || !canChartBy(xProp)) return base;
  const xDim = makeDimension(xProp, ctx, kindOf(xProp), config.xBucket ?? 'month');
  const dateAxis = xDim.kind === 'date';
  let { bins, none } = binRows(rows, xDim);

  // Time axes are continuous: the empty periods between the first and the last one are shown.
  const sort = config.sort ?? 'default';
  if (dateAxis && bins.length > 1 && (sort === 'default' || sort === 'label_asc' || sort === 'label_desc')) {
    const range = bucketRange(Number(bins[0]!.slot.order), Number(bins[bins.length - 1]!.slot.order), config.xBucket ?? 'month');
    if (range) {
      const known = new Map(bins.map((b) => [b.slot.key, b]));
      bins = range.map((r) => known.get(r.key) ?? { slot: { key: r.key, label: r.label, color: null, order: r.start }, rows: [] });
    }
  }

  // Order of the categories.
  const natural = new Map(bins.map((b, i) => [b.slot.key, i]));
  const labelOrder = (b: Bin) => (xDim.kind === 'option' || xDim.kind === 'multi' || xDim.kind === 'checkbox' ? b.slot.label : b.slot.order);
  const value = (b: Bin) => aggregateRows(b.rows, aggregate, valueProp, ctx);
  const values = new Map(bins.map((b) => [b.slot.key, value(b)]));
  if (sort === 'label_asc' || sort === 'label_desc') {
    const dir = sort === 'label_asc' ? 1 : -1;
    bins.sort((a, b) => dir * compareOrder(labelOrder(a), labelOrder(b)) || natural.get(a.slot.key)! - natural.get(b.slot.key)!);
  } else if (sort === 'value_asc' || sort === 'value_desc') {
    const dir = sort === 'value_asc' ? 1 : -1;
    bins.sort((a, b) => dir * (values.get(a.slot.key)! - values.get(b.slot.key)!) || natural.get(a.slot.key)! - natural.get(b.slot.key)!);
  }
  if (!config.hideEmpty && none.rows.length > 0) {
    if (sort === 'value_asc' || sort === 'value_desc') {
      const v = value(none);
      const at = bins.findIndex((b) => (sort === 'value_asc' ? values.get(b.slot.key)! > v : values.get(b.slot.key)! < v));
      bins.splice(at === -1 ? bins.length : at, 0, none);
    } else bins.push(none);
  }

  // Too many categories: the last ones are gathered in « Autres ».
  const maxCategories = Math.max(2, opts.maxCategories ?? 60);
  if (bins.length > maxCategories) {
    const kept = bins.slice(0, maxCategories - 1);
    const rest = bins.slice(maxCategories - 1);
    bins = [...kept, { slot: { key: OTHER_KEY, label: 'Autres', color: 'gray', order: '' }, rows: uniqueRows(rest) }];
  }

  // Series.
  const sProp = config.seriesProperty ? byId.get(config.seriesProperty) : undefined;
  let series: ChartSeriesInfo[] = [];
  let seriesOf: ((rows: Page[]) => { values: Record<string, number>; counts: Record<string, number> }) | null = null;
  if (sProp && canChartBy(sProp) && sProp.id !== xProp.id) {
    const sDim = makeDimension(sProp, ctx, kindOf(sProp), config.seriesBucket ?? 'month');
    const { bins: sBins, none: sNone } = binRows(rows, sDim);
    let used = sBins.filter((b) => b.rows.length > 0);
    if (sNone.rows.length > 0 && !config.hideEmpty) used.push(sNone);
    const maxSeries = Math.max(2, opts.maxSeries ?? 8);
    let other: Set<string> | null = null;
    if (used.length > maxSeries) {
      other = new Set(used.slice(maxSeries - 1).map((b) => b.slot.key));
      used = [...used.slice(0, maxSeries - 1), { slot: { key: OTHER_KEY, label: 'Autres', color: 'gray', order: '' }, rows: [] }];
    }
    series = used.map((b) => ({
      key: b.slot.key,
      label: b.slot.label,
      color: sDim.kind === 'option' || sDim.kind === 'multi' || sDim.kind === 'checkbox' || b.slot.key === NO_VALUE_KEY || b.slot.key === OTHER_KEY ? b.slot.color : null,
    }));
    const keys = new Set(series.map((s) => s.key));
    seriesOf = (catRows) => {
      const groups = new Map<string, Page[]>();
      for (const row of catRows) {
        const slots = sDim.slotsOf(row);
        const ks = slots.length ? slots.map((s) => s.key) : [NO_VALUE_KEY];
        for (const k0 of new Set(ks.map((k) => (other?.has(k) ? OTHER_KEY : k)))) {
          if (!keys.has(k0)) continue;
          let g = groups.get(k0);
          if (!g) groups.set(k0, (g = []));
          g.push(row);
        }
      }
      const values: Record<string, number> = {};
      const counts: Record<string, number> = {};
      for (const s of series) {
        values[s.key] = aggregateRows(groups.get(s.key) ?? [], aggregate, valueProp, ctx);
        counts[s.key] = groups.get(s.key)?.length ?? 0;
      }
      return { values, counts };
    };
  }

  const categories = bins.map<ChartCategory>((b) => {
    const { values: s, counts } = seriesOf ? seriesOf(b.rows) : { values: {}, counts: {} };
    const v = seriesOf && stacked ? Object.values(s).reduce((a, x) => a + x, 0) : (values.get(b.slot.key) ?? value(b));
    return {
      key: b.slot.key,
      label: b.slot.label,
      color: b.slot.color,
      value: v,
      count: b.rows.length,
      series: s,
      seriesCounts: counts,
      rowIds: b.rows.map((r) => r.id),
    };
  });
  return { ...base, categories, series, dateAxis };
}

/** What the chart measures: « Nombre de lignes », « Somme · Budget »… */
export function chartValueLabel(data: Pick<ChartData, 'valueProperty'>, aggregate: ChartAggregate): string {
  if (!data.valueProperty || aggregate === 'count') return CHART_AGGREGATE_LABELS.count;
  return `${CHART_AGGREGATE_LABELS[aggregate]} · ${data.valueProperty.name}`;
}

/** Text under a « Graphique numérique »: « lignes » for a count, « Somme · Budget · 12 lignes » otherwise. */
export function numberCaption(data: Pick<ChartData, 'valueProperty' | 'rowCount'>, aggregate: ChartAggregate): string {
  const rows = `ligne${data.rowCount > 1 ? 's' : ''}`;
  if (!data.valueProperty || aggregate === 'count') return rows;
  return `${chartValueLabel(data, aggregate)} · ${data.rowCount} ${rows}`;
}

/** Value as displayed on the chart (averages rounded to 2 decimals). */
export function formatChartValue(n: number, data: Pick<ChartData, 'numberFormat' | 'numberPrecision'>): string {
  if (data.numberPrecision !== undefined) {
    return formatNumber(n, data.numberFormat === 'number' ? 'number_with_commas' : data.numberFormat, data.numberPrecision);
  }
  const rounded = Math.round(n * 100) / 100;
  const fmt = data.numberFormat === 'number' ? 'number_with_commas' : data.numberFormat;
  return formatNumber(rounded, fmt);
}

/** Compact axis tick / bar label (1 200 → « 1,2 k », 1 500 € → « 1,5 k € », 12,5 → « 12,5 »). */
export function formatCompact(n: number, data: Pick<ChartData, 'numberFormat'>): string {
  const big = Math.abs(n) >= 1000;
  const num = new Intl.NumberFormat('fr-FR', big ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(n);
  if (data.numberFormat === 'euro') return `${num} €`;
  if (data.numberFormat === 'dollar') return `${num} $`;
  if (data.numberFormat === 'percent') return `${num} %`;
  const code = NUMBER_CURRENCY_CODES[data.numberFormat];
  if (code) return `${num} ${currencySymbol(code)}`;
  return num;
}

/** « Nice » axis maximum and ticks (1, 2, 2.5, 5 × 10^n steps). */
export function niceTicks(min: number, max: number, count = 5): { min: number; max: number; ticks: number[] } {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return { min: 0, max: 1, ticks: [0, 1] };
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = niceMin; t <= niceMax + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { min: niceMin, max: niceMax, ticks };
}

const symbols = new Map<string, string>();
/** Short symbol of a currency in fr-FR (« £GB », « CHF », « ¥ »). */
function currencySymbol(code: string): string {
  let sym = symbols.get(code);
  if (sym === undefined) {
    sym = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: code }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? code;
    symbols.set(code, sym);
  }
  return sym;
}
