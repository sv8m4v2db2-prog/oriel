// Chart views (bars, horizontal bars, lines, donut, number): the view's rows (filters and search
// applied) aggregated by logic/chart.ts and drawn by the lazily loaded SVG renderer. Clicking a
// category lists its rows; each one opens in the side panel.
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { ChartConfig, ChartViewType, Page } from '@oriel/shared';
import { defaultChartConfig, VIEW_TYPE_LABELS } from '@oriel/shared';
import { useDb } from '../context';
import { LazyChart } from '../charts/LazyChart';
import { PALETTE_SIZE } from '../charts/colors';
import { canChartBy, chartValueLabel, computeChart, numberCaption, type ChartCategory, type ChartData } from '../logic/chart';
import type { ValueKind } from '../logic/values';
import { IconBtn } from '../ui/primitives';
import type { ViewState } from '../view/types';
import { EmptyState, openRow, RowTitle } from './common';
import '../views.css';

/** Chart data of `rows` with the display limits of the chart type. */
export function useChartData(rows: Page[], type: ChartViewType, chart: ChartConfig, kinds: Map<string, ValueKind>): ChartData {
  const { properties, ctx } = useDb();
  return useMemo(
    () => computeChart(rows, chart, properties, ctx, { kinds, maxCategories: type === 'chart_donut' ? PALETTE_SIZE : undefined }),
    [rows, chart, properties, ctx, kinds, type],
  );
}

/** Why the chart cannot be drawn (no usable X axis), or null. */
export function useChartProblem(type: ChartViewType, chart: ChartConfig): string | null {
  const { properties } = useDb();
  if (type === 'chart_number') return null;
  const x = properties.find((p) => p.id === chart.xProperty);
  return x && canChartBy(x) ? null : 'Choisissez la propriété des catégories dans les réglages du graphique.';
}

const SHOWN_ROWS = 100;

/** Rows of the selected category. */
export function CategoryRows({ category, rows, onClose }: { category: ChartCategory; rows: Page[]; onClose: () => void }) {
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const list = category.rowIds.map((id) => byId.get(id)).filter((r): r is Page => !!r);
  return (
    <div className="ordb-chart-rows" role="region" aria-label={`Lignes de « ${category.label} »`}>
      <div className="ordb-chart-rows-head">
        <span className="ordb-chart-rows-title">{category.label}</span>
        <span className="ordb-chart-rows-count">
          {list.length} ligne{list.length > 1 ? 's' : ''}
        </span>
        <IconBtn label="Fermer la liste" onClick={onClose}>
          <X size={14} />
        </IconBtn>
      </div>
      <ul className="ordb-chart-rows-list">
        {list.slice(0, SHOWN_ROWS).map((r) => (
          <li key={r.id}>
            <button type="button" className="ordb-chart-row" onClick={() => openRow(r.id)}>
              <RowTitle row={r} />
            </button>
          </li>
        ))}
      </ul>
      {list.length > SHOWN_ROWS && <div className="ordb-menu-hint is-tight">… et {list.length - SHOWN_ROWS} autres lignes.</div>}
    </div>
  );
}

export function ChartView({ vs }: { vs: ViewState }) {
  const { properties } = useDb();
  const type = vs.view.type as ChartViewType;
  const chart = useMemo(() => vs.config.chart ?? defaultChartConfig(type, properties), [vs.config.chart, type, properties]);
  const data = useChartData(vs.rows, type, chart, vs.kinds);
  const problem = useChartProblem(type, chart);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [vs.view.id, chart]);
  const category = selected ? data.categories.find((c) => c.key === selected) : undefined;

  if (problem) return <EmptyState>{problem}</EmptyState>;
  return (
    <div className="ordb-chartview">
      {vs.rows.length === 0 && vs.totalRows > 0 && <div className="ordb-menu-hint">Aucune ligne ne correspond aux filtres.</div>}
      <div className={`ordb-chartview-plot is-${type.slice(6)}`}>
        <LazyChart
          type={type}
          data={data}
          config={chart}
          label={`${vs.view.name || VIEW_TYPE_LABELS[type]} — ${chartValueLabel(data, chart.aggregate)}`}
          caption={numberCaption(data, chart.aggregate)}
          onSelect={type === 'chart_number' ? undefined : (key) => setSelected((s) => (s === key ? null : key))}
          selected={category ? selected : null}
        />
      </div>
      {category && <CategoryRows category={category} rows={vs.rows} onClose={() => setSelected(null)} />}
    </div>
  );
}
