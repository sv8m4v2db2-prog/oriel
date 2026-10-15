// Timeline: horizontal bars from date ranges, week / month scale, drag to shift, drag the right
// edge to change the end, click an empty track to schedule a row.
import { useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  format,
  getISOWeek,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DateValue, Page, PropertyDef } from '@oriel/shared';
import { useDb } from '../context';
import { dateValueToRange, serializeDate, shiftDateValue, toDateString } from '../logic/dates';
import { formatDateRange } from '../logic/format';
import { newPropertyDef } from '../logic/properties';
import { getDateRange, rawValue } from '../logic/values';
import { isDateLike } from '../logic/viewConfig';
import { useChunk } from '../ui/hooks';
import { cx, IconBtn, NativeSelect } from '../ui/primitives';
import type { ViewState } from '../view/types';
import { dragClock, EmptyState, openRow, RowTitle } from './common';
import { openRowMenu } from '../ui/contextMenus';
import { toast } from '../../lib/ui';
import { cascadeShift, dependencyEdges, isConflict, type DaySpan } from '../logic/dependencies';

const ROW_H = 36;
const DAY_W = { week: 36, month: 10 } as const;

interface Span {
  start: Date;
  end: Date;
}

function rowSpan(row: Page, startProp: PropertyDef, endProp: PropertyDef | null, ctx: ReturnType<typeof useDb>['ctx']): Span | null {
  const r = getDateRange(row, startProp, ctx);
  if (!r) return null;
  let end = r.end ?? r.start;
  if (endProp) {
    const e = getDateRange(row, endProp, ctx);
    if (e) end = e.start;
  }
  const s = startOfDay(r.start);
  const e = startOfDay(end);
  return e < s ? { start: e, end: s } : { start: s, end: e };
}

interface DragState {
  rowId: string;
  mode: 'move' | 'resize';
  startX: number;
  deltaDays: number;
}

export function TimelineView({ vs }: { vs: ViewState }) {
  const db = useDb();
  const { properties, ctx, canEdit, m, databaseId } = db;
  const markerId = useId().replace(/:/g, '');
  const startProp = properties.find((p) => p.id === vs.config.dateProperty && isDateLike(p)) ?? null;
  const endProp = properties.find((p) => p.id === vs.config.dateEndProperty && isDateLike(p) && p.id !== startProp?.id) ?? null;
  const depProp =
    properties.find((p) => p.id === vs.config.dependencyProperty && p.type === 'relation' && p.relation?.databaseId === databaseId) ?? null;
  const scale = vs.config.timelineScale;
  const dayW = DAY_W[scale];
  const [anchor, setAnchor] = useState(() => new Date());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const chunk = useChunk(vs.rows.length, 120, vs.view.id);

  const { rangeStart, days } = useMemo(() => {
    if (scale === 'week') {
      const s = addWeeks(startOfWeek(anchor, { weekStartsOn: 1 }), -1);
      return { rangeStart: s, days: 7 * 9 };
    }
    const s = startOfMonth(addMonths(anchor, -1));
    const e = endOfMonth(addMonths(anchor, 5));
    return { rangeStart: s, days: differenceInCalendarDays(e, s) + 1 };
  }, [anchor, scale]);

  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(rangeStart, i)), [rangeStart, days]);
  const months = useMemo(() => {
    const out: Array<{ label: string; from: number; span: number }> = [];
    dayList.forEach((d, i) => {
      const label = format(d, 'LLLL yyyy', { locale: fr });
      const last = out[out.length - 1];
      if (last && last.label === label) last.span++;
      else out.push({ label, from: i, span: 1 });
    });
    return out;
  }, [dayList]);

  if (!startProp) {
    const candidates = properties.filter(isDateLike);
    return (
      <EmptyState
        action={
          canEdit ? (
            <span className="ordb-empty-actions">
              {candidates.map((p) => (
                <button key={p.id} type="button" className="ordb-btn is-outline is-sm" onClick={() => vs.setConfig({ dateProperty: p.id })}>
                  Utiliser « {p.name} »
                </button>
              ))}
              {candidates.length === 0 && (
                <button
                  type="button"
                  className="ordb-btn is-primary is-sm"
                  onClick={() => {
                    const { id } = m.createProperty(newPropertyDef('date', properties, { name: 'Dates' }));
                    vs.setConfig({ dateProperty: id });
                  }}
                >
                  Créer une propriété Date
                </button>
              )}
            </span>
          ) : undefined
        }
      >
        La chronologie affiche chaque ligne selon une plage de dates.
      </EmptyState>
    );
  }

  const editable = canEdit && startProp.type === 'date' && (!endProp || endProp.type === 'date');
  const totalW = days * dayW;
  const todayOffset = differenceInCalendarDays(startOfDay(new Date()), rangeStart);

  /** After a drag: offer to shift the dependent tasks by the same number of days. */
  const offerCascade = (row: Page, delta: number) => {
    if (!depProp || !delta) return;
    const patches = cascadeShift(vs.allRows, depProp, row.id, delta, startProp, endProp);
    if (patches.length === 0) return;
    const n = patches.length;
    toast(`« ${row.title || 'Sans titre'} » décalée de ${delta > 0 ? '+' : ''}${delta} j.`, {
      tone: 'info',
      duration: 10_000,
      action: {
        label: `Décaler les tâches dépendantes (${n})`,
        onClick: () => {
          for (const p of patches) void m.updateRow(p.rowId, { properties: p.properties });
        },
      },
    });
  };

  const commit = (row: Page, mode: 'move' | 'resize', delta: number) => {
    if (!delta) return;
    const startVal = rawValue(row, startProp) as DateValue | null;
    if (!startVal) return;
    offerCascade(row, delta);
    if (mode === 'move') {
      const patch: Record<string, DateValue> = { [startProp.id]: shiftDateValue(startVal, delta) };
      if (endProp) {
        const endVal = rawValue(row, endProp) as DateValue | null;
        if (endVal) patch[endProp.id] = shiftDateValue(endVal, delta);
      }
      void m.updateRow(row.id, { properties: patch });
      return;
    }
    // Resize: move the end only.
    if (endProp) {
      const endVal = rawValue(row, endProp) as DateValue | null;
      const base = endVal ?? startVal;
      const shifted = shiftDateValue({ start: base.start, includeTime: base.includeTime }, delta);
      const startRange = dateValueToRange(startVal);
      const newEnd = dateValueToRange(shifted);
      if (startRange && newEnd && newEnd.start < startOfDay(startRange.start)) return;
      void m.updateRow(row.id, { properties: { [endProp.id]: shifted } });
    } else {
      const r = dateValueToRange(startVal);
      if (!r) return;
      const end = addDays(r.end ?? r.start, delta);
      if (startOfDay(end) < startOfDay(r.start)) return;
      const next: DateValue = { start: startVal.start, includeTime: startVal.includeTime };
      if (differenceInCalendarDays(end, r.start) > 0) next.end = serializeDate(end, r.includeTime);
      void m.updateRow(row.id, { properties: { [startProp.id]: next } });
    }
  };

  const beginDrag = (row: Page, mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const state: DragState = { rowId: row.id, mode, startX: e.clientX, deltaDays: 0 };
    dragRef.current = state;
    setDrag(state);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - state.startX) / dayW);
      if (Math.abs(ev.clientX - state.startX) > 3) moved = true;
      if (dragRef.current && delta !== dragRef.current.deltaDays) {
        dragRef.current = { ...dragRef.current, deltaDays: delta };
        setDrag(dragRef.current);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const final = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (moved) {
        dragClock.endedAt = Date.now();
        if (final) commit(row, mode, final.deltaDays);
      } else if (mode === 'move') {
        openRow(row.id);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const schedule = (row: Page) => (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!editable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.floor((e.clientX - rect.left) / dayW);
    const day = addDays(rangeStart, Math.max(0, Math.min(days - 1, idx)));
    void m.updateRow(row.id, { properties: { [startProp.id]: { start: toDateString(day) } } });
  };

  const shift = (dir: 1 | -1) => setAnchor((a) => (scale === 'week' ? addWeeks(a, dir * 4) : addMonths(a, dir * 3)));
  const rows = vs.rows.slice(0, chunk.count);

  // Bar geometry (drag preview included) and dependency arrows.
  interface Geo {
    index: number;
    span: Span | null;
    left: number;
    width: number;
    clippedL: boolean;
    clippedR: boolean;
  }
  const geo = new Map<string, Geo>();
  rows.forEach((row, index) => {
    const span = rowSpan(row, startProp, endProp, ctx);
    const d = drag && drag.rowId === row.id ? drag : null;
    let shown: Span | null = span;
    if (span && d?.mode === 'move') shown = { start: addDays(span.start, d.deltaDays), end: addDays(span.end, d.deltaDays) };
    else if (span && d?.mode === 'resize') {
      const end = addDays(span.end, d.deltaDays);
      shown = { start: span.start, end: end < span.start ? span.start : end };
    }
    let left = 0;
    let width = 0;
    let clippedL = false;
    let clippedR = false;
    if (shown) {
      const s = differenceInCalendarDays(shown.start, rangeStart);
      const e = differenceInCalendarDays(shown.end, rangeStart);
      clippedL = s < 0;
      clippedR = e >= days;
      const cs = Math.max(0, s);
      const ce = Math.min(days - 1, e);
      left = cs * dayW;
      width = ce >= cs ? (ce - cs + 1) * dayW : 0;
    }
    geo.set(row.id, { index, span: shown, left, width, clippedL, clippedR });
  });
  const spanOf = (id: string): DaySpan | null => geo.get(id)?.span ?? null;
  const edges = depProp ? dependencyEdges(rows, depProp) : [];
  const conflicts = new Set(edges.filter((e) => isConflict(e, spanOf)).map((e) => e.to));
  const arrowPath = (from: Geo, to: Geo): string | null => {
    if (!from.span || !to.span) return null;
    const x1 = Math.max(0, Math.min(totalW, from.left + from.width));
    const x2 = Math.max(0, Math.min(totalW, to.left));
    const y1 = from.index * ROW_H + ROW_H / 2;
    const y2 = to.index * ROW_H + ROW_H / 2;
    const gap = 8;
    if (x2 - x1 >= gap * 2) return `M${x1},${y1} H${x1 + gap} V${y2} H${x2 - 1}`;
    const yMid = y2 > y1 ? y2 - ROW_H / 2 : y2 + ROW_H / 2;
    return `M${x1},${y1} H${x1 + gap} V${yMid} H${x2 - gap} V${y2} H${x2 - 1}`;
  };

  return (
    <div className="ordb-timeline">
      <div className="ordb-cal-toolbar">
        <span className="ordb-cal-month">{format(anchor, 'LLLL yyyy', { locale: fr })}</span>
        <span className="ordb-option-spacer" />
        <NativeSelect
          ariaLabel="Échelle"
          value={scale}
          onChange={(v) => vs.setConfig({ timelineScale: v as 'week' | 'month' })}
          choices={[
            { value: 'week', label: 'Semaine' },
            { value: 'month', label: 'Mois' },
          ]}
        />
        <button type="button" className="ordb-btn is-outline is-sm" onClick={() => setAnchor(new Date())}>
          Aujourd'hui
        </button>
        <IconBtn label="Période précédente" onClick={() => shift(-1)}>
          <ChevronLeft size={16} />
        </IconBtn>
        <IconBtn label="Période suivante" onClick={() => shift(1)}>
          <ChevronRight size={16} />
        </IconBtn>
      </div>
      <div className="ordb-tl-scroller" data-hscroll="">
        <div className="ordb-tl-grid" style={{ width: 240 + totalW, ['--ordb-day-w' as string]: `${dayW}px`, ['--ordb-tl-row-h' as string]: `${ROW_H}px` }}>
          <div className="ordb-tl-head">
            <div className="ordb-tl-corner">{startProp.name}</div>
            <div className="ordb-tl-scale" style={{ width: totalW }}>
              <div className="ordb-tl-months">
                {months.map((mo) => (
                  <div key={mo.label + mo.from} className="ordb-tl-month" style={{ left: mo.from * dayW, width: mo.span * dayW }}>
                    <span>{mo.label}</span>
                  </div>
                ))}
              </div>
              <div className="ordb-tl-days">
                {dayList.map((d, i) =>
                  scale === 'week' ? (
                    <div
                      key={i}
                      className={cx('ordb-tl-day', (d.getDay() === 0 || d.getDay() === 6) && 'is-weekend', i === todayOffset && 'is-today')}
                      style={{ left: i * dayW, width: dayW }}
                    >
                      {format(d, 'EEEEE', { locale: fr })}
                      <strong>{d.getDate()}</strong>
                    </div>
                  ) : d.getDay() === 1 ? (
                    <div key={i} className="ordb-tl-day is-week" style={{ left: i * dayW, width: dayW * 7 }}>
                      S{getISOWeek(d)} · {d.getDate()}
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          </div>
          <div className="ordb-tl-body" style={{ height: rows.length * ROW_H }}>
            {todayOffset >= 0 && todayOffset < days && <div className="ordb-tl-today" style={{ left: 240 + todayOffset * dayW + dayW / 2 }} />}
            {edges.length > 0 && (
              <svg className="ordb-tl-deps" width={totalW} height={rows.length * ROW_H} aria-hidden>
                <defs>
                  <marker id={`${markerId}-a`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" className="ordb-tl-dep-head" />
                  </marker>
                  <marker id={`${markerId}-c`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L8,4 L0,8 z" className="ordb-tl-dep-head is-conflict" />
                  </marker>
                </defs>
                {edges.map((e) => {
                  const from = geo.get(e.from);
                  const to = geo.get(e.to);
                  const d = from && to ? arrowPath(from, to) : null;
                  if (!d) return null;
                  const conflict = isConflict(e, spanOf);
                  return (
                    <path
                      key={`${e.from}>${e.to}`}
                      d={d}
                      className={cx('ordb-tl-dep', conflict && 'is-conflict')}
                      markerEnd={`url(#${markerId}-${conflict ? 'c' : 'a'})`}
                    />
                  );
                })}
              </svg>
            )}
            {rows.map((row, i) => {
              const g = geo.get(row.id)!;
              const span = g.span;
              const d = drag && drag.rowId === row.id ? drag : null;
              const { left, width, clippedL, clippedR } = g;
              return (
                <div key={row.id} className="ordb-tl-row" style={{ top: i * ROW_H, height: ROW_H }}>
                  <div
                    className="ordb-tl-label"
                    role="button"
                    tabIndex={0}
                    onClick={() => openRow(row.id)}
                    onContextMenu={(e) => openRowMenu(e, db, row)}
                  >
                    <RowTitle row={row} />
                  </div>
                  <div
                    className={cx('ordb-tl-track', !span && editable && 'is-schedulable')}
                    style={{ width: totalW }}
                    onClick={!span ? schedule(row) : undefined}
                    title={!span && editable ? 'Cliquer pour planifier' : undefined}
                  >
                    {span && width > 0 && (
                      <div
                        className={cx(
                          'ordb-tl-bar',
                          d && 'is-dragging',
                          clippedL && 'is-clipped-left',
                          clippedR && 'is-clipped-right',
                          editable && 'is-editable',
                          conflicts.has(row.id) && 'is-conflict',
                        )}
                        style={{ left, width }}
                        onPointerDown={beginDrag(row, 'move')}
                        onContextMenu={(e) => openRowMenu(e, db, row)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!editable) openRow(row.id);
                        }}
                        title={`${row.title || 'Sans titre'} — ${formatDateRange({ start: span.start, end: span.end > span.start ? span.end : null, includeTime: false })}${
                          conflicts.has(row.id) ? ' — commence avant la fin d’une tâche bloquante' : ''
                        }`}
                      >
                        <span className="ordb-tl-bar-label">{row.title || 'Sans titre'}</span>
                        {editable && <span className="ordb-tl-resize" onPointerDown={beginDrag(row, 'resize')} aria-hidden />}
                      </div>
                    )}
                    {span && width === 0 && (
                      <span className="ordb-tl-offscreen ordb-muted">
                        {differenceInCalendarDays(span.start, rangeStart) < 0 ? '← ' : ''}
                        {formatDateRange({ start: span.start, end: span.end > span.start ? span.end : null, includeTime: false })}
                        {differenceInCalendarDays(span.start, rangeStart) >= days ? ' →' : ''}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {chunk.hasMore && (
        <div ref={chunk.sentinel} className="ordb-more">
          <button type="button" className="ordb-linkbtn" onClick={chunk.showMore}>
            Afficher plus ({vs.rows.length - chunk.count})
          </button>
        </div>
      )}
    </div>
  );
}
