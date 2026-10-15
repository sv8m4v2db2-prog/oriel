// Dashboard views: widgets (charts or short row lists) laid out on a 4-column grid.
import type { ChartViewType, DashboardWidget, Page, PropertyDef } from '@oriel/shared';
import { defaultChartConfig, VIEW_TYPE_LABELS } from '@oriel/shared';
import { deriveRows } from './pipeline';
import type { RowContext } from './values';

export type WidgetType = DashboardWidget['type'];

export const WIDGET_TYPE_LABELS: Record<WidgetType, string> = {
  chart_bar: 'Barres verticales',
  chart_hbar: 'Barres horizontales',
  chart_line: 'Lignes',
  chart_donut: 'Anneau',
  chart_number: 'Nombre',
  list: 'Liste de lignes',
};

export const WIDGET_TYPES: WidgetType[] = ['chart_number', 'chart_bar', 'chart_hbar', 'chart_line', 'chart_donut', 'list'];

export const MAX_WIDGETS = 24;

/** Default grid span of a new widget. */
export function defaultSpan(type: WidgetType): { w: number; h: number } {
  if (type === 'chart_number') return { w: 1, h: 1 };
  if (type === 'list') return { w: 2, h: 2 };
  return { w: 2, h: 2 };
}

/** Widget id unique in the dashboard (w1, w2…). */
export function newWidgetId(widgets: readonly DashboardWidget[]): string {
  const ids = new Set(widgets.map((w) => w.id));
  for (let i = widgets.length + 1; ; i++) if (!ids.has(`w${i}`)) return `w${i}`;
}

export function newWidget(type: WidgetType, widgets: readonly DashboardWidget[], properties: PropertyDef[]): DashboardWidget {
  const widget: DashboardWidget = { id: newWidgetId(widgets), type, ...defaultSpan(type) };
  if (type === 'list') widget.limit = 5;
  else widget.chart = defaultChartConfig(type as ChartViewType, properties);
  return widget;
}

/** Title shown on a widget (its own, else the kind of widget). */
export function widgetTitle(widget: DashboardWidget): string {
  if (widget.title?.trim()) return widget.title.trim();
  return widget.type === 'list' ? 'Liste' : VIEW_TYPE_LABELS[widget.type];
}

/** Rows of a widget: the view's rows, then the widget's filter and sorts (and its limit for lists). */
export function widgetRows(viewRows: readonly Page[], widget: DashboardWidget, ctx: RowContext): Page[] {
  const hasOwn = !!widget.filter || (widget.sorts?.length ?? 0) > 0;
  const rows = hasOwn ? deriveRows(viewRows, { filter: widget.filter ?? null, sorts: widget.sorts ?? [] }, ctx) : [...viewRows];
  return widget.type === 'list' ? rows.slice(0, Math.max(1, Math.min(50, widget.limit ?? 5))) : rows;
}

export function updateWidget(widgets: readonly DashboardWidget[], id: string, patch: Partial<DashboardWidget>): DashboardWidget[] {
  return widgets.map((w) => (w.id === id ? { ...w, ...patch, id: w.id } : w));
}

/** Changes the type of a widget, keeping its chart settings when it stays a chart. */
export function retypeWidget(widget: DashboardWidget, type: WidgetType, properties: PropertyDef[]): DashboardWidget {
  const next: DashboardWidget = { ...widget, type };
  if (type === 'list') {
    delete next.chart;
    next.limit = widget.limit ?? 5;
  } else {
    const d = defaultChartConfig(type as ChartViewType, properties);
    next.chart = widget.chart ? { ...widget.chart, xProperty: type === 'chart_number' ? null : (widget.chart.xProperty ?? d.xProperty) } : d;
  }
  return next;
}

/** Moves widget `id` before / after `targetId`. */
export function moveWidget(widgets: readonly DashboardWidget[], id: string, targetId: string, place: 'before' | 'after'): DashboardWidget[] {
  if (id === targetId) return [...widgets];
  const moving = widgets.find((w) => w.id === id);
  if (!moving) return [...widgets];
  const rest = widgets.filter((w) => w.id !== id);
  const idx = rest.findIndex((w) => w.id === targetId);
  if (idx === -1) return [...widgets];
  rest.splice(place === 'before' ? idx : idx + 1, 0, moving);
  return rest;
}

/** Duplicate placed right after the original. */
export function duplicateWidget(widgets: readonly DashboardWidget[], id: string): DashboardWidget[] {
  const i = widgets.findIndex((w) => w.id === id);
  if (i === -1 || widgets.length >= MAX_WIDGETS) return [...widgets];
  const copy: DashboardWidget = { ...structuredClone(widgets[i]!), id: newWidgetId(widgets) };
  if (copy.title) copy.title = `${copy.title} (copie)`.slice(0, 200);
  const out = [...widgets];
  out.splice(i + 1, 0, copy);
  return out;
}
