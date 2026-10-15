// SVG charts drawn from ChartData (logic/chart.ts): vertical / horizontal bars (stacked or grouped
// series), lines (one per series), donut, number. No charting library. Loaded lazily through
// charts/LazyChart.tsx, so the other layouts never download this code.
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { ChartConfig, ChartViewType } from '@oriel/shared';
import { formatChartValue, formatCompact, niceTicks, OTHER_KEY, type ChartCategory, type ChartData } from '../logic/chart';
import { NO_VALUE_KEY } from '../logic/group';
import { cx } from '../ui/primitives';
import { markFill } from './colors';
import { useElementSize } from './useElementSize';

export interface ChartRendererProps {
  type: ChartViewType;
  data: ChartData;
  config: ChartConfig;
  /** Accessible name of the chart. */
  label: string;
  /** Text under the number of a « Graphique numérique ». */
  caption?: string;
  /** Click on a category (rows of that category). */
  onSelect?: (categoryKey: string) => void;
  /** Category shown as selected (the others are dimmed). */
  selected?: string | null;
  /** Dashboard widget: tighter margins and labels. */
  compact?: boolean;
}

const FONT = 11.5;
/** Rough width of a text in the axis font (no layout pass needed). */
const textWidth = (s: string, size = FONT) => s.length * size * 0.56;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

/** Fill of category `i` when there is no series: option color, else one hue (donut: one per slot). */
function categoryFill(c: ChartCategory, i: number, perCategory: boolean): string {
  if (c.key === NO_VALUE_KEY || c.key === OTHER_KEY) return markFill(c.color ?? 'gray', i);
  if (c.color) return markFill(c.color, i);
  return markFill(null, perCategory ? i : 0);
}

function seriesFills(data: ChartData): Map<string, string> {
  const out = new Map<string, string>();
  let slot = 0;
  for (const s of data.series) {
    out.set(s.key, s.color ? markFill(s.color, 0) : markFill(null, slot));
    if (!s.color) slot++;
  }
  return out;
}

/** Rectangle path with rounded corners on one side (the data end of a bar). */
function barPath(x: number, y: number, w: number, h: number, r: number, round: 'top' | 'bottom' | 'left' | 'right' | 'none'): string {
  if (w <= 0 || h <= 0) return '';
  const rr = Math.min(r, w / 2, h / 2);
  const tl = round === 'top' || round === 'left' ? rr : 0;
  const tr = round === 'top' || round === 'right' ? rr : 0;
  const br = round === 'bottom' || round === 'right' ? rr : 0;
  const bl = round === 'bottom' || round === 'left' ? rr : 0;
  return [
    `M${x + tl},${y}`,
    `H${x + w - tr}`,
    tr ? `A${tr},${tr} 0 0 1 ${x + w},${y + tr}` : '',
    `V${y + h - br}`,
    br ? `A${br},${br} 0 0 1 ${x + w - br},${y + h}` : '',
    `H${x + bl}`,
    bl ? `A${bl},${bl} 0 0 1 ${x},${y + h - bl}` : '',
    `V${y + tl}`,
    tl ? `A${tl},${tl} 0 0 1 ${x + tl},${y}` : '',
    'Z',
  ].join('');
}

// ---------------------------------------------------------------------------
// Tooltip and legend
// ---------------------------------------------------------------------------

interface Hover {
  index: number;
  x: number;
  y: number;
}

function Tooltip({ hover, data, width, fills, single }: { hover: Hover; data: ChartData; width: number; fills: Map<string, string>; single?: string }) {
  const c = data.categories[hover.index];
  if (!c) return null;
  const left = hover.x > width / 2 ? undefined : hover.x + 14;
  const right = hover.x > width / 2 ? width - hover.x + 14 : undefined;
  return (
    <div className="ordb-chart-tooltip" style={{ left, right, top: Math.max(4, hover.y - 12) }} role="status">
      <div className="ordb-chart-tooltip-title">{c.label}</div>
      {data.series.length > 0 ? (
        <>
          {data.series.map((s) => (
            <div key={s.key} className="ordb-chart-tooltip-row">
              <span className="ordb-chart-swatch" style={{ background: fills.get(s.key) }} />
              <span className="ordb-chart-tooltip-label">{s.label}</span>
              <span className="ordb-chart-tooltip-value">
                {!data.stacked && !c.seriesCounts[s.key] ? '—' : formatChartValue(c.series[s.key] ?? 0, data)}
              </span>
            </div>
          ))}
          {data.stacked && (
            <div className="ordb-chart-tooltip-row is-total">
              <span className="ordb-chart-tooltip-label">Total</span>
              <span className="ordb-chart-tooltip-value">{formatChartValue(c.value, data)}</span>
            </div>
          )}
        </>
      ) : (
        <div className="ordb-chart-tooltip-row">
          {single && <span className="ordb-chart-swatch" style={{ background: single }} />}
          <span className="ordb-chart-tooltip-value">{!data.stacked && c.count === 0 ? '—' : formatChartValue(c.value, data)}</span>
          {data.valueProperty && <span className="ordb-chart-tooltip-label">{data.valueProperty.name}</span>}
        </div>
      )}
      <div className="ordb-chart-tooltip-foot">
        {c.count} ligne{c.count > 1 ? 's' : ''}
      </div>
    </div>
  );
}

interface LegendItem {
  key: string;
  label: string;
  fill: string;
  detail?: string;
}

function Legend({ items, vertical }: { items: LegendItem[]; vertical?: boolean }) {
  if (items.length === 0) return null;
  return (
    <ul className={cx('ordb-chart-legend', vertical && 'is-vertical')} aria-label="Légende">
      {items.map((it) => (
        <li key={it.key} className="ordb-chart-legend-item" title={it.label}>
          <span className="ordb-chart-swatch" style={{ background: it.fill }} />
          <span className="ordb-chart-legend-label">{it.label}</span>
          {it.detail && <span className="ordb-chart-legend-detail">{it.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The figures as a table, for screen readers. */
function DataTable({ data, label }: { data: ChartData; label: string }) {
  return (
    <table className="ordb-chart-sr">
      <caption>{label}</caption>
      <thead>
        <tr>
          <th scope="col">Catégorie</th>
          {data.series.map((s) => (
            <th key={s.key} scope="col">
              {s.label}
            </th>
          ))}
          <th scope="col">{data.series.length ? (data.stacked ? 'Total' : 'Ensemble') : 'Valeur'}</th>
        </tr>
      </thead>
      <tbody>
        {data.categories.map((c) => (
          <tr key={c.key}>
            <th scope="row">{c.label}</th>
            {data.series.map((s) => (
              <td key={s.key}>{!data.stacked && !c.seriesCounts[s.key] ? '—' : formatChartValue(c.series[s.key] ?? 0, data)}</td>
            ))}
            <td>{!data.stacked && c.count === 0 ? '—' : formatChartValue(c.value, data)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

interface BarMark {
  ci: number;
  key: string;
  fill: string;
  v0: number;
  v1: number;
  slot: number;
  slots: number;
  /** Outermost segment of its stack (rounded data end). */
  outer: boolean;
}

function barMarks(data: ChartData, fills: Map<string, string>): BarMark[] {
  const marks: BarMark[] = [];
  const perCategory = false;
  data.categories.forEach((c, ci) => {
    if (data.series.length === 0) {
      marks.push({ ci, key: c.key, fill: categoryFill(c, ci, perCategory), v0: 0, v1: c.value, slot: 0, slots: 1, outer: true });
      return;
    }
    if (data.stacked) {
      let pos = 0;
      let neg = 0;
      const own: BarMark[] = [];
      for (const s of data.series) {
        const v = c.series[s.key] ?? 0;
        if (v === 0) continue;
        if (v > 0) {
          own.push({ ci, key: s.key, fill: fills.get(s.key)!, v0: pos, v1: pos + v, slot: 0, slots: 1, outer: false });
          pos += v;
        } else {
          own.push({ ci, key: s.key, fill: fills.get(s.key)!, v0: neg, v1: neg + v, slot: 0, slots: 1, outer: false });
          neg += v;
        }
      }
      const lastPos = own.findLast((m) => m.v1 > m.v0);
      const lastNeg = own.findLast((m) => m.v1 < m.v0);
      if (lastPos) lastPos.outer = true;
      if (lastNeg) lastNeg.outer = true;
      marks.push(...own);
      return;
    }
    data.series.forEach((s, si) => {
      marks.push({ ci, key: s.key, fill: fills.get(s.key)!, v0: 0, v1: c.series[s.key] ?? 0, slot: si, slots: data.series.length, outer: true });
    });
  });
  return marks;
}

/** Value reached by the end of category `ci` (label position) and the label itself. */
function stackEnds(data: ChartData, marks: BarMark[]) {
  return data.categories.map((c, ci) => {
    let hi = 0;
    let lo = 0;
    for (const m of marks) {
      if (m.ci !== ci) continue;
      hi = Math.max(hi, m.v0, m.v1);
      lo = Math.min(lo, m.v0, m.v1);
    }
    return { value: c.value, end: c.value < 0 ? lo : hi };
  });
}

function BarChart({ data, config, horizontal, width, height, compact, onSelect, selected, setHover }: PlotProps & { horizontal: boolean }) {
  const fills = useMemo(() => seriesFills(data), [data]);
  const marks = useMemo(() => barMarks(data, fills), [data, fills]);
  const ends = useMemo(() => stackEnds(data, marks), [data, marks]);
  const n = data.categories.length;
  let lo = 0;
  let hi = 0;
  for (const m of marks) {
    lo = Math.min(lo, m.v0, m.v1);
    hi = Math.max(hi, m.v0, m.v1);
  }
  const scale = niceTicks(lo, hi, horizontal ? Math.max(2, Math.floor(width / 110)) : Math.max(2, Math.floor(height / 60)));
  const tickLabels = scale.ticks.map((t) => formatCompact(t, data));
  const showLabels = config.showLabels !== false;
  const grouped = data.series.length > 0 && !data.stacked;

  if (horizontal) {
    const labelW = Math.min(Math.max(...data.categories.map((c) => textWidth(clip(c.label, 28))), 30) + 10, width * 0.38, compact ? 120 : 180);
    const maxChars = Math.max(4, Math.floor((labelW - 10) / (FONT * 0.56)));
    const valueLabelW = showLabels ? Math.max(...ends.map((e) => textWidth(formatCompact(e.value, data)))) + 8 : 0;
    const top = 6;
    const bottom = 22;
    const rowH = Math.max(grouped ? 10 * data.series.length + 8 : 22, (height - top - bottom) / Math.max(1, n));
    const plotH = rowH * n;
    const left = labelW;
    const right = Math.max(12, valueLabelW);
    const plotW = Math.max(20, width - left - right);
    const xOf = (v: number) => left + ((v - scale.min) / (scale.max - scale.min)) * plotW;
    const svgH = top + plotH + bottom;
    return (
      <svg width={width} height={svgH} className="ordb-chart-svg" aria-hidden>
        {scale.ticks.map((t, i) => (
          <g key={t}>
            <line x1={xOf(t)} x2={xOf(t)} y1={top} y2={top + plotH} className={t === 0 ? 'ordb-chart-zero' : 'ordb-chart-grid'} />
            <text x={xOf(t)} y={top + plotH + 15} textAnchor="middle" className="ordb-chart-tick">
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {data.categories.map((c, ci) => (
          <text key={c.key} x={left - 8} y={top + ci * rowH + rowH / 2} dy="0.35em" textAnchor="end" className="ordb-chart-catlabel">
            <title>{c.label}</title>
            {clip(c.label, maxChars)}
          </text>
        ))}
        {marks.map((m, i) => {
          const groupH = Math.min(rowH * 0.72, grouped ? 16 * m.slots : 28);
          const h = (groupH - 2 * (m.slots - 1)) / m.slots;
          const y = top + m.ci * rowH + (rowH - groupH) / 2 + m.slot * (h + 2);
          const x0 = xOf(Math.min(m.v0, m.v1));
          const x1 = xOf(Math.max(m.v0, m.v1));
          const key = data.categories[m.ci]!.key;
          return (
            <path
              key={i}
              d={barPath(x0, y, x1 - x0, h, 4, m.outer ? (m.v1 >= m.v0 ? 'right' : 'left') : 'none')}
              fill={m.fill}
              className={cx('ordb-chart-mark', data.stacked && data.series.length > 0 && 'is-stacked', selected && selected !== key && 'is-dimmed')}
            />
          );
        })}
        {showLabels &&
          ends.map((e, ci) =>
            e.value === 0 && data.categories[ci]!.count === 0 ? null : (
              <text
                key={ci}
                x={xOf(e.end) + (e.value < 0 ? -6 : 6)}
                y={top + ci * rowH + rowH / 2}
                dy="0.35em"
                textAnchor={e.value < 0 ? 'end' : 'start'}
                className="ordb-chart-value"
              >
                {formatCompact(e.value, data)}
              </text>
            ),
          )}
        {data.categories.map((c, ci) => (
          <rect
            key={c.key}
            x={0}
            y={top + ci * rowH}
            width={width}
            height={rowH}
            className="ordb-chart-hit"
            onMouseMove={(e) => setHover(hoverAt(e, ci))}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(c.key)}
          />
        ))}
      </svg>
    );
  }

  const tickW = Math.max(...tickLabels.map((t) => textWidth(t)));
  const left = tickW + 10;
  const right = 8;
  const plotW = Math.max(20, width - left - right);
  const band = plotW / Math.max(1, n);
  const longest = Math.max(...data.categories.map((c) => textWidth(clip(c.label, 18))), 10);
  const rotate = longest + 6 > band;
  const labelEvery = rotate ? Math.max(1, Math.ceil(16 / band)) : 1;
  const bottom = rotate ? Math.min(compact ? 54 : 80, longest * 0.72 + 18) : 22;
  const top = showLabels ? 18 : 8;
  const plotH = Math.max(20, height - top - bottom);
  const yOf = (v: number) => top + ((scale.max - v) / (scale.max - scale.min)) * plotH;
  const groupMax = grouped ? 22 * data.series.length : 48;
  return (
    <svg width={width} height={height} className="ordb-chart-svg" aria-hidden>
      {scale.ticks.map((t, i) => (
        <g key={t}>
          <line x1={left} x2={left + plotW} y1={yOf(t)} y2={yOf(t)} className={t === 0 ? 'ordb-chart-zero' : 'ordb-chart-grid'} />
          <text x={left - 6} y={yOf(t)} dy="0.35em" textAnchor="end" className="ordb-chart-tick">
            {tickLabels[i]}
          </text>
        </g>
      ))}
      {data.categories.map((c, ci) => {
        if (ci % labelEvery !== 0) return null;
        const x = left + ci * band + band / 2;
        const y = top + plotH + (rotate ? 10 : 15);
        return rotate ? (
          <text key={c.key} x={x} y={y} textAnchor="end" transform={`rotate(-40 ${x} ${y})`} className="ordb-chart-catlabel">
            <title>{c.label}</title>
            {clip(c.label, 18)}
          </text>
        ) : (
          <text key={c.key} x={x} y={y} textAnchor="middle" className="ordb-chart-catlabel">
            <title>{c.label}</title>
            {clip(c.label, Math.max(3, Math.floor(band / (FONT * 0.56))))}
          </text>
        );
      })}
      {marks.map((m, i) => {
        const groupW = Math.min(band * 0.72, groupMax);
        const w = Math.max(1, (groupW - 2 * (m.slots - 1)) / m.slots);
        const x = left + m.ci * band + (band - groupW) / 2 + m.slot * (w + 2);
        const y0 = yOf(Math.max(m.v0, m.v1));
        const y1 = yOf(Math.min(m.v0, m.v1));
        const key = data.categories[m.ci]!.key;
        return (
          <path
            key={i}
            d={barPath(x, y0, w, y1 - y0, 4, m.outer ? (m.v1 >= m.v0 ? 'top' : 'bottom') : 'none')}
            fill={m.fill}
            className={cx('ordb-chart-mark', data.stacked && data.series.length > 0 && 'is-stacked', selected && selected !== key && 'is-dimmed')}
          />
        );
      })}
      {showLabels &&
        ends.map((e, ci) =>
          (e.value === 0 && data.categories[ci]!.count === 0) || textWidth(formatCompact(e.value, data)) > band - 2 ? null : (
            <text
              key={ci}
              x={left + ci * band + band / 2}
              y={yOf(e.end) + (e.value < 0 ? 13 : -5)}
              textAnchor="middle"
              className="ordb-chart-value"
            >
              {formatCompact(e.value, data)}
            </text>
          ),
        )}
      {data.categories.map((c, ci) => (
        <rect
          key={c.key}
          x={left + ci * band}
          y={0}
          width={band}
          height={height}
          className="ordb-chart-hit"
          onMouseMove={(e) => setHover(hoverAt(e, ci))}
          onMouseLeave={() => setHover(null)}
          onClick={() => onSelect?.(c.key)}
        />
      ))}
    </svg>
  );
}

function hoverAt(e: MouseEvent<Element>, index: number): Hover {
  const box = (e.currentTarget as Element).closest('.ordb-chart-plot')?.getBoundingClientRect();
  return { index, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function LineChart({ data, config, width, height, compact, onSelect, selected, setHover, hover }: PlotProps) {
  const fills = useMemo(() => seriesFills(data), [data]);
  const n = data.categories.length;
  // Averages / extremes of an empty period are unknown, not 0: a gap in the line.
  const lines = useMemo(
    () =>
      data.series.length
        ? data.series.map((s) => ({
            key: s.key,
            fill: fills.get(s.key)!,
            values: data.categories.map((c) => (!data.stacked && !c.seriesCounts[s.key] ? null : (c.series[s.key] ?? 0))),
          }))
        : [{ key: '__value__', fill: markFill(null, 0), values: data.categories.map((c) => (!data.stacked && c.count === 0 ? null : c.value)) }],
    [data, fills],
  );
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== null));
  const scale = niceTicks(Math.min(0, ...all), Math.max(0, ...all), Math.max(2, Math.floor(height / 60)));
  const tickLabels = scale.ticks.map((t) => formatCompact(t, data));
  const showLabels = config.showLabels === true;
  const left = Math.max(...tickLabels.map((t) => textWidth(t))) + 10;
  const right = showLabels ? 28 : 14;
  const top = showLabels ? 18 : 10;
  const bottom = 22;
  const plotW = Math.max(20, width - left - right);
  const plotH = Math.max(20, height - top - bottom);
  const xOf = (i: number) => (n <= 1 ? left + plotW / 2 : left + (i * plotW) / (n - 1));
  const yOf = (v: number) => top + ((scale.max - v) / (scale.max - scale.min)) * plotH;
  const longest = Math.max(...data.categories.map((c) => textWidth(clip(c.label, 16))), 10);
  const step = n <= 1 ? 1 : Math.max(1, Math.ceil((longest + 10) / (plotW / (n - 1))));
  const markers = n <= (compact ? 24 : 48);
  const pointLabels = showLabels && lines.length === 1 && n <= 16;
  // « Sans valeur » / « Autres » are not periods: never joined to the line.
  const detached = (i: number) => {
    const k = data.categories[i]?.key;
    return k === NO_VALUE_KEY || k === OTHER_KEY;
  };
  const linePath = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null || detached(i)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xOf(i)},${yOf(v)}`;
      pen = true;
    });
    return d;
  };
  const lastOf = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
    return -1;
  };
  const nearest = (e: MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const x = e.clientX - box.left;
    return n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - left) / plotW) * (n - 1))));
  };
  return (
    <svg width={width} height={height} className="ordb-chart-svg" aria-hidden>
      {scale.ticks.map((t, i) => (
        <g key={t}>
          <line x1={left} x2={left + plotW} y1={yOf(t)} y2={yOf(t)} className={t === 0 ? 'ordb-chart-zero' : 'ordb-chart-grid'} />
          <text x={left - 6} y={yOf(t)} dy="0.35em" textAnchor="end" className="ordb-chart-tick">
            {tickLabels[i]}
          </text>
        </g>
      ))}
      {data.categories.map((c, i) =>
        i % step !== 0 ? null : (
          <text key={c.key} x={xOf(i)} y={top + plotH + 15} textAnchor={n > 1 && i === 0 ? 'start' : 'middle'} className="ordb-chart-catlabel">
            <title>{c.label}</title>
            {clip(c.label, 16)}
          </text>
        ),
      )}
      {hover && <line x1={xOf(hover.index)} x2={xOf(hover.index)} y1={top} y2={top + plotH} className="ordb-chart-crosshair" />}
      {lines.length === 1 && n > 1 && lines[0]!.values.every((v, i) => v !== null && !detached(i)) && (
        <path
          d={`M${xOf(0)},${yOf(0)}${lines[0]!.values.map((v, i) => `L${xOf(i)},${yOf(v ?? 0)}`).join('')}L${xOf(n - 1)},${yOf(0)}Z`}
          fill={lines[0]!.fill}
          className="ordb-chart-area"
        />
      )}
      {lines.map((l) => (
        <g key={l.key}>
          {n > 1 && <path d={linePath(l.values)} stroke={l.fill} className="ordb-chart-line" />}
          {l.values.map((v, i) =>
            v === null || !(markers || n === 1 || detached(i) || ((i === 0 || l.values[i - 1] === null) && (i === n - 1 || l.values[i + 1] === null))) ? null : (
              <circle
                key={i}
                cx={xOf(i)}
                cy={yOf(v)}
                r={hover?.index === i ? 5 : 4}
                fill={l.fill}
                className={cx('ordb-chart-point', selected && selected !== data.categories[i]!.key && 'is-dimmed')}
              />
            ),
          )}
          {showLabels && !pointLabels && lastOf(l.values) >= 0 && (
            <text x={xOf(lastOf(l.values)) + 6} y={yOf(l.values[lastOf(l.values)]!)} dy="0.35em" className="ordb-chart-value">
              {formatCompact(l.values[lastOf(l.values)]!, data)}
            </text>
          )}
        </g>
      ))}
      {pointLabels &&
        lines[0]!.values.map((v, i) =>
          v === null ? null : (
            <text key={i} x={xOf(i)} y={yOf(v) - 9} textAnchor="middle" className="ordb-chart-value">
              {formatCompact(v, data)}
            </text>
          ),
        )}
      <rect
        x={left - 8}
        y={0}
        width={plotW + 16}
        height={height}
        className="ordb-chart-hit"
        onMouseMove={(e) => {
          const i = nearest(e);
          const box = e.currentTarget.closest('.ordb-chart-plot')?.getBoundingClientRect();
          setHover({ index: i, x: xOf(i), y: e.clientY - (box?.top ?? 0) });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const c = data.categories[nearest(e)];
          if (c) onSelect?.(c.key);
        }}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------

function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${cx + r * Math.sin(a)},${cy - r * Math.cos(a)}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    const m = a0 + Math.PI;
    return `${sector(cx, cy, r0, r1, a0, m)}${sector(cx, cy, r0, r1, m, a0 + Math.PI * 2)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

function DonutChart({ data, config, width, height, onSelect, selected, setHover }: PlotProps) {
  const slices = data.categories.map((c, i) => ({ c, i, v: Math.max(0, c.value), fill: categoryFill(c, i, true) }));
  const total = slices.reduce((a, s) => a + s.v, 0);
  const r1 = Math.max(10, Math.min(width, height) / 2 - 6);
  const r0 = r1 * 0.62;
  const ox = width / 2;
  const oy = height / 2;
  let a = 0;
  return (
    <svg width={width} height={height} className="ordb-chart-svg" aria-hidden>
      {total === 0 && <circle cx={ox} cy={oy} r={(r0 + r1) / 2} strokeWidth={r1 - r0} className="ordb-chart-donut-empty" />}
      {slices.map((s) => {
        if (s.v === 0 || total === 0) return null;
        const a0 = a;
        a += (s.v / total) * Math.PI * 2;
        const mid = (a0 + a) / 2;
        const share = s.v / total;
        const lr = (r0 + r1) / 2;
        return (
          <g key={s.c.key}>
            <path
              d={sector(ox, oy, r0, r1, a0, a)}
              fill={s.fill}
              className={cx('ordb-chart-mark is-slice', selected && selected !== s.c.key && 'is-dimmed')}
              onMouseMove={(e) => setHover(hoverAt(e, s.i))}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(s.c.key)}
            />
            {config.showLabels !== false && share >= 0.06 && r1 - r0 >= 22 && (
              <text x={ox + lr * Math.sin(mid)} y={oy - lr * Math.cos(mid)} dy="0.35em" textAnchor="middle" className="ordb-chart-slice-label">
                {Math.round(share * 100)} %
              </text>
            )}
          </g>
        );
      })}
      <text x={ox} y={oy - (r0 > 34 ? 6 : 0)} dy="0.35em" textAnchor="middle" className="ordb-chart-donut-total" style={{ fontSize: Math.max(12, Math.min(28, r0 * 0.42)) }}>
        {formatCompact(data.total, data)}
      </text>
      {r0 > 34 && (
        <text x={ox} y={oy + 16} dy="0.35em" textAnchor="middle" className="ordb-chart-tick">
          {data.valueProperty ? 'Total' : 'Lignes'}
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface PlotProps {
  data: ChartData;
  config: ChartConfig;
  width: number;
  height: number;
  compact?: boolean;
  onSelect?: (key: string) => void;
  selected?: string | null;
  hover: Hover | null;
  setHover: (h: Hover | null) => void;
}

export default function ChartRenderer({ type, data, config, label, caption, onSelect, selected, compact }: ChartRendererProps) {
  const plot = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const fills = useMemo(() => seriesFills(data), [data]);

  if (type === 'chart_number') {
    const text = formatChartValue(data.total, data);
    return (
      <div className={cx('ordb-chart', 'is-number', compact && 'is-compact')} role="figure" aria-label={label}>
        <div ref={plot.ref} className="ordb-chart-number-wrap">
          <div
            className="ordb-chart-number"
            style={{ fontSize: plot.width ? Math.max(22, Math.min(compact ? 52 : 72, plot.height * 0.45, plot.width / (text.length * 0.62))) : undefined }}
          >
            {text}
          </div>
          {caption && <div className="ordb-chart-number-caption">{caption}</div>}
        </div>
      </div>
    );
  }

  const donut = type === 'chart_donut';
  const legendItems: LegendItem[] = donut
    ? (() => {
        const total = data.categories.reduce((a, c) => a + Math.max(0, c.value), 0);
        return data.categories.map((c, i) => ({
          key: c.key,
          label: c.label,
          fill: categoryFill(c, i, true),
          detail: `${formatCompact(c.value, data)}${total > 0 ? ` · ${Math.round((Math.max(0, c.value) / total) * 100)} %` : ''}`,
        }));
      })()
    : data.series.map((s) => ({ key: s.key, label: s.label, fill: fills.get(s.key)! }));
  const showLegend = config.showLegend === true && legendItems.length > 0;
  const sideLegend = donut && showLegend && plot.width > 0 && plot.width >= (compact ? 300 : 420);
  const empty = data.categories.length === 0;

  let body: ReactNode = null;
  if (plot.width > 0 && plot.height > 0 && !empty) {
    const props: PlotProps = { data, config, width: plot.width, height: plot.height, compact, onSelect, selected, hover, setHover };
    if (type === 'chart_line') body = <LineChart {...props} />;
    else if (donut) body = <DonutChart {...props} />;
    else body = <BarChart {...props} horizontal={type === 'chart_hbar'} />;
  }
  const single = data.series.length === 0 && type !== 'chart_donut' ? (data.categories.some((c) => c.color) ? undefined : markFill(null, 0)) : undefined;

  return (
    <div className={cx('ordb-chart', `is-${type.slice(6)}`, compact && 'is-compact', sideLegend && 'has-side-legend')} role="figure" aria-label={label}>
      {showLegend && !sideLegend && <Legend items={legendItems} />}
      <div ref={plot.ref} className={cx('ordb-chart-plot', onSelect && 'is-clickable', type === 'chart_hbar' && 'is-scroll')}>
        {empty ? <div className="ordb-chart-empty">Aucune donnée à afficher.</div> : body}
        {hover && <Tooltip hover={hover} data={data} width={plot.width} fills={fills} single={single} />}
      </div>
      {sideLegend && <Legend items={legendItems} vertical />}
      <DataTable data={data} label={label} />
    </div>
  );
}
