// View configuration helpers: defaults, property order and visibility, column widths.
import type {
  ChartConfig,
  ChartViewType,
  DashboardWidget,
  FilterGroup,
  FormConfig,
  FormQuestion,
  PropertyDef,
  PropertyType,
  SortRule,
  ViewConfig,
  ViewType,
} from '@oriel/shared';
import { CHART_VIEW_TYPES, defaultChartConfig, defaultViewConfig, isChartView } from '@oriel/shared';

/** Fills missing keys (older or partial configs) with the defaults of the view type. */
export function normalizeConfig(
  config: Partial<ViewConfig> | null | undefined,
  type: ViewType,
  properties: PropertyDef[],
): ViewConfig {
  const base = defaultViewConfig(type, properties);
  const c = config ?? {};
  const out: ViewConfig = {
    filter: c.filter && Array.isArray(c.filter.rules) ? c.filter : base.filter,
    sorts: Array.isArray(c.sorts) ? c.sorts : base.sorts,
    groupBy: c.groupBy !== undefined ? c.groupBy : base.groupBy,
    hiddenGroups: Array.isArray(c.hiddenGroups) ? c.hiddenGroups : base.hiddenGroups,
    collapsedGroups: Array.isArray(c.collapsedGroups) ? c.collapsedGroups : base.collapsedGroups,
    propertyOrder: Array.isArray(c.propertyOrder) ? c.propertyOrder : base.propertyOrder,
    hiddenProperties: Array.isArray(c.hiddenProperties) ? c.hiddenProperties : base.hiddenProperties,
    propertyWidths: c.propertyWidths && typeof c.propertyWidths === 'object' ? c.propertyWidths : base.propertyWidths,
    calculations: c.calculations && typeof c.calculations === 'object' ? c.calculations : base.calculations,
    wrap: typeof c.wrap === 'boolean' ? c.wrap : base.wrap,
    cardCover: c.cardCover === 'cover' || c.cardCover === 'none' ? c.cardCover : base.cardCover,
    cardSize: c.cardSize === 'small' || c.cardSize === 'medium' || c.cardSize === 'large' ? c.cardSize : base.cardSize,
    dateProperty: c.dateProperty !== undefined ? c.dateProperty : base.dateProperty,
    dateEndProperty: c.dateEndProperty !== undefined ? c.dateEndProperty : base.dateEndProperty,
    timelineScale: c.timelineScale === 'month' || c.timelineScale === 'week' ? c.timelineScale : base.timelineScale,
    dependencyProperty: typeof c.dependencyProperty === 'string' ? c.dependencyProperty : null,
    calendarMode: c.calendarMode === 'week' ? 'week' : 'month',
  };
  // Settings of the newer layouts: kept whenever present (a view keeps them when its layout changes
  // back and forth), defaults of the view type otherwise.
  const feedPreviewLines = clampInt(c.feedPreviewLines, 0, 20) ?? base.feedPreviewLines;
  if (feedPreviewLines !== undefined) out.feedPreviewLines = feedPreviewLines;
  const chartType: ChartViewType = isChartView(type) ? type : 'chart_bar';
  const chart = c.chart !== undefined ? normalizeChartConfig(c.chart, chartType, properties) : base.chart;
  if (chart) out.chart = chart;
  const widgets = Array.isArray(c.widgets) ? normalizeWidgets(c.widgets, properties) : base.widgets;
  if (widgets) out.widgets = widgets;
  const placeProperty = c.placeProperty === null || typeof c.placeProperty === 'string' ? c.placeProperty : base.placeProperty;
  if (placeProperty !== undefined) out.placeProperty = placeProperty;
  const form = c.form !== undefined ? normalizeFormConfig(c.form) : base.form;
  if (form) out.form = form;
  // I1: template of the view's « Nouveau » button ('blank' or a template id; absent = database default).
  if (typeof c.defaultTemplateId === 'string' && c.defaultTemplateId) out.defaultTemplateId = c.defaultTemplateId.slice(0, 64);
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const AGGREGATES = ['count', 'sum', 'average', 'min', 'max'] as const;
const BUCKETS = ['day', 'week', 'month', 'year'] as const;
const CHART_SORTS = ['default', 'label_asc', 'label_desc', 'value_asc', 'value_desc'] as const;

/** Valid chart settings (unknown / invalid fields replaced by the defaults of `type`). */
export function normalizeChartConfig(raw: unknown, type: ChartViewType, properties: PropertyDef[]): ChartConfig {
  const d = defaultChartConfig(type, properties);
  if (!isRecord(raw)) return d;
  const out: ChartConfig = {
    xProperty: raw.xProperty === null ? null : (idOrNull(raw.xProperty) ?? d.xProperty),
    aggregate: oneOf(raw.aggregate, AGGREGATES) ?? d.aggregate,
    valueProperty: idOrNull(raw.valueProperty),
    seriesProperty: idOrNull(raw.seriesProperty),
    sort: oneOf(raw.sort, CHART_SORTS) ?? d.sort,
    showLegend: typeof raw.showLegend === 'boolean' ? raw.showLegend : d.showLegend,
    showLabels: typeof raw.showLabels === 'boolean' ? raw.showLabels : d.showLabels,
    hideEmpty: typeof raw.hideEmpty === 'boolean' ? raw.hideEmpty : d.hideEmpty,
  };
  const xBucket = oneOf(raw.xBucket, BUCKETS);
  if (xBucket) out.xBucket = xBucket;
  const seriesBucket = oneOf(raw.seriesBucket, BUCKETS);
  if (seriesBucket) out.seriesBucket = seriesBucket;
  return out;
}

const WIDGET_TYPES: ReadonlyArray<DashboardWidget['type']> = [...CHART_VIEW_TYPES, 'list'];

function normalizeFilter(raw: unknown): FilterGroup | null {
  return isRecord(raw) && Array.isArray(raw.rules) ? (raw as unknown as FilterGroup) : null;
}
function normalizeSorts(raw: unknown): SortRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is SortRule => isRecord(s) && typeof s.propertyId === 'string' && (s.direction === 'asc' || s.direction === 'desc'),
  );
}

/** Valid dashboard widgets (at most 24, unique ids, spans clamped to the grid). */
export function normalizeWidgets(raw: unknown, properties: PropertyDef[]): DashboardWidget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DashboardWidget[] = [];
  for (const w of raw) {
    if (!isRecord(w) || out.length >= 24) continue;
    const type = oneOf(w.type, WIDGET_TYPES);
    const id = typeof w.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w.id) ? w.id : undefined;
    if (!type || !id || seen.has(id)) continue;
    seen.add(id);
    const widget: DashboardWidget = { id, type, w: clampInt(w.w, 1, 4) ?? 2, h: clampInt(w.h, 1, 3) ?? 2 };
    const title = str(w.title, 200);
    if (title !== undefined) widget.title = title;
    if (type !== 'list') widget.chart = normalizeChartConfig(w.chart, type, properties);
    const filter = normalizeFilter(w.filter);
    if (filter) widget.filter = filter;
    const sorts = normalizeSorts(w.sorts);
    if (sorts.length) widget.sorts = sorts;
    const limit = clampInt(w.limit, 1, 50);
    if (limit !== undefined) widget.limit = limit;
    out.push(widget);
  }
  return out;
}

/** Valid form settings (questions with unique ids; conditions only on another question). */
export function normalizeFormConfig(raw: unknown): FormConfig {
  const r = isRecord(raw) ? raw : {};
  const questions: FormQuestion[] = [];
  const seen = new Set<string>();
  for (const q of Array.isArray(r.questions) ? r.questions : []) {
    if (!isRecord(q) || questions.length >= 100) continue;
    const id = typeof q.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(q.id) ? q.id : undefined;
    if (!id || seen.has(id) || typeof q.propertyId !== 'string' || !q.propertyId) continue;
    seen.add(id);
    const question: FormQuestion = { id, propertyId: q.propertyId };
    const label = str(q.label, 200);
    if (label !== undefined) question.label = label;
    const description = str(q.description, 2000);
    if (description !== undefined) question.description = description;
    if (typeof q.required === 'boolean') question.required = q.required;
    const cond = q.showIf;
    if (isRecord(cond) && typeof cond.questionId === 'string' && typeof cond.value === 'string' && cond.questionId !== id) {
      question.showIf = { questionId: cond.questionId, value: cond.value.slice(0, 200) };
    } else if (cond === null) question.showIf = null;
    questions.push(question);
  }
  const out: FormConfig = {
    questions,
    acceptResponses: typeof r.acceptResponses === 'boolean' ? r.acceptResponses : true,
    isPublic: r.isPublic === true,
  };
  const title = str(r.title, 200);
  if (title !== undefined) out.title = title;
  const description = str(r.description, 5000);
  if (description !== undefined) out.description = description;
  const submitLabel = str(r.submitLabel, 100);
  if (submitLabel !== undefined) out.submitLabel = submitLabel;
  const confirmation = str(r.confirmation, 2000);
  if (confirmation !== undefined) out.confirmation = confirmation;
  return out;
}

/** All properties in the view's display order (unknown ids ignored, missing ids appended). */
export function orderedProperties(config: Pick<ViewConfig, 'propertyOrder'>, properties: PropertyDef[]): PropertyDef[] {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: PropertyDef[] = [];
  for (const id of config.propertyOrder ?? []) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      out.push(p);
      seen.add(id);
    }
  }
  for (const p of properties) if (!seen.has(p.id)) out.push(p);
  return out;
}

/** Ordered visible properties (the title is never hidden). */
export function visibleProperties(
  config: Pick<ViewConfig, 'propertyOrder' | 'hiddenProperties'>,
  properties: PropertyDef[],
): PropertyDef[] {
  const hidden = new Set(config.hiddenProperties ?? []);
  return orderedProperties(config, properties).filter((p) => p.type === 'title' || !hidden.has(p.id));
}

/**
 * Columns of a "view" CSV export: the visible properties plus those that structure the layout
 * (calendar/timeline dates, grouping, map place) — hidden on cards by default but meaningful in a sheet.
 */
export function exportProperties(
  type: ViewType,
  config: Pick<ViewConfig, 'propertyOrder' | 'hiddenProperties' | 'groupBy' | 'dateProperty' | 'dateEndProperty' | 'placeProperty'>,
  properties: PropertyDef[],
): PropertyDef[] {
  const structural = new Set<string>();
  if (type === 'calendar' || type === 'timeline') {
    if (config.dateProperty) structural.add(config.dateProperty);
    if (type === 'timeline' && config.dateEndProperty) structural.add(config.dateEndProperty);
  }
  if (config.groupBy) structural.add(config.groupBy);
  if (type === 'map' && config.placeProperty) structural.add(config.placeProperty);
  const hidden = new Set(config.hiddenProperties ?? []);
  return orderedProperties(config, properties).filter((p) => p.type === 'title' || !hidden.has(p.id) || structural.has(p.id));
}

/** Moves `id` before/after `targetId` in the full ordered id list. */
export function reorderIds(ids: string[], id: string, targetId: string, place: 'before' | 'after' = 'before'): string[] {
  if (id === targetId) return ids;
  const without = ids.filter((x) => x !== id);
  const idx = without.indexOf(targetId);
  if (idx === -1) return ids;
  without.splice(place === 'before' ? idx : idx + 1, 0, id);
  return without;
}

/** Inserts `id` next to `anchorId` in an order list (appends when the anchor is unknown). */
export function insertId(ids: string[], id: string, anchorId: string | null, place: 'before' | 'after'): string[] {
  const without = ids.filter((x) => x !== id);
  const idx = anchorId ? without.indexOf(anchorId) : -1;
  if (idx === -1) return [...without, id];
  without.splice(place === 'before' ? idx : idx + 1, 0, id);
  return without;
}

const DEFAULT_WIDTHS: Partial<Record<PropertyType, number>> = {
  title: 280,
  checkbox: 110,
  number: 140,
  date: 190,
  created_time: 190,
  last_edited_time: 190,
  last_visited: 190,
  unique_id: 110,
  text: 240,
};

export const MIN_COLUMN_WIDTH = 72;
export const MAX_COLUMN_WIDTH = 900;

export function columnWidth(config: Pick<ViewConfig, 'propertyWidths'>, prop: PropertyDef): number {
  const w = config.propertyWidths?.[prop.id];
  if (typeof w === 'number' && Number.isFinite(w)) return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w));
  return DEFAULT_WIDTHS[prop.type] ?? 200;
}

/** Date-like properties usable by calendar / timeline views. */
export function isDateLike(prop: PropertyDef): boolean {
  return prop.type === 'date' || prop.type === 'created_time' || prop.type === 'last_edited_time';
}
