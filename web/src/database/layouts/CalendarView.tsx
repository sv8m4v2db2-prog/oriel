// Calendar: month grid or week columns (Monday first) by a date property. Multi-day items are drawn
// as one bar per week; dragging a card or a bar to another day shifts its dates; clicking an empty
// day creates a row on that day.
import { useMemo, useState, type CSSProperties } from 'react';
import { DbPopover as Popover } from '../ui/DbPopover';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { CalendarX, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { DateValue, Page, PropertyDef, ViewConfig } from '@oriel/shared';
import { useDb } from '../context';
import { layoutWeek, isMultiDay, type CalendarItem, type WeekSpan } from '../logic/calendarLayout';
import { dayKey, shiftDateValue, toDateString } from '../logic/dates';
import { newPropertyDef } from '../logic/properties';
import { getDateRange, rawValue } from '../logic/values';
import { isDateLike } from '../logic/viewConfig';
import { cx, IconBtn, NativeSelect, stopEscape } from '../ui/primitives';
import { ValueDisplay } from '../ui/ValueDisplay';
import { openRowMenu } from '../ui/contextMenus';
import type { ViewState } from '../view/types';
import { dragClock, EmptyState, openRow, RowTitle } from './common';

const MAX_PER_DAY = 4;
const LANE_H = 24;

function CalendarCard({ row, day, vs, draggable }: { row: Page; day: number; vs: ViewState; draggable: boolean }) {
  const db = useDb();
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `${row.id}@${day}`, data: { rowId: row.id, day }, disabled: !draggable });
  const extra = vs.visibleProps.filter((p) => p.type !== 'title' && p.id !== vs.config.dateProperty).slice(0, 2);
  return (
    <div
      ref={setNodeRef}
      className={cx('ordb-cal-card', isDragging && 'is-dimmed')}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        openRow(row.id);
      }}
      onContextMenu={(e) => openRowMenu(e, db, row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openRow(row.id);
      }}
      {...(draggable ? listeners : {})}
    >
      <RowTitle row={row} />
      {extra.map((p) => (
        <span key={p.id} className="ordb-cal-card-prop">
          <ValueDisplay row={row} prop={p} variant="card" />
        </span>
      ))}
    </div>
  );
}

/** A multi-day item: one bar over the covered days of a week row. */
function SpanBar({ span, row, weekStart, draggable }: { span: WeekSpan; row: Page; weekStart: Date; draggable: boolean }) {
  const db = useDb();
  const day = dayKey(addDays(weekStart, span.from));
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${row.id}@span@${day}`,
    data: { rowId: row.id, day },
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      className={cx('ordb-cal-span', span.continuesLeft && 'is-continued-left', span.continuesRight && 'is-continued-right', isDragging && 'is-dimmed')}
      style={{ gridColumn: `${span.from + 1} / ${span.to + 2}`, gridRow: span.lane + 1 }}
      role="button"
      tabIndex={0}
      title={row.title || 'Sans titre'}
      onClick={(e) => {
        e.stopPropagation();
        openRow(row.id);
      }}
      onContextMenu={(e) => openRowMenu(e, db, row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openRow(row.id);
      }}
      {...(draggable ? listeners : {})}
    >
      {span.continuesLeft && <span aria-hidden>←&nbsp;</span>}
      <RowTitle row={row} />
      {span.continuesRight && <span aria-hidden>&nbsp;→</span>}
    </div>
  );
}

function DayCell({
  day,
  month,
  rows,
  vs,
  draggable,
  onCreate,
  lanes,
  tall,
}: {
  day: Date;
  month: Date | null;
  rows: Page[];
  vs: ViewState;
  draggable: boolean;
  onCreate?: (day: Date) => void;
  lanes: number;
  tall: boolean;
}) {
  const key = dayKey(day);
  const { setNodeRef, isOver } = useDroppable({ id: `day:${key}`, data: { day: key } });
  const [moreOpen, setMoreOpen] = useState(false);
  const today = dayKey(new Date()) === key;
  const max = tall ? 40 : MAX_PER_DAY;
  const visible = rows.slice(0, max);
  const hidden = rows.length - visible.length;
  return (
    <div
      ref={setNodeRef}
      className={cx('ordb-cal-cell', month && !isSameMonth(day, month) && 'is-outside', isOver && 'is-over', today && 'is-today')}
      onClick={() => onCreate?.(day)}
      role="gridcell"
      aria-label={format(day, 'EEEE d MMMM', { locale: fr })}
      style={{ '--ordb-cal-lanes': lanes } as CSSProperties}
    >
      <div className="ordb-cal-cell-head">
        {onCreate && (
          <span className="ordb-cal-add" aria-hidden>
            <Plus size={12} />
          </span>
        )}
        <span className="ordb-cal-num">{day.getDate() === 1 || tall ? format(day, tall ? 'EEE d' : 'd MMM', { locale: fr }) : day.getDate()}</span>
      </div>
      <div className="ordb-cal-cards" style={lanes ? { marginTop: lanes * LANE_H } : undefined}>
        {visible.map((r) => (
          <CalendarCard key={r.id} row={r} day={key} vs={vs} draggable={draggable} />
        ))}
        {hidden > 0 && (
          <Popover opened={moreOpen} onChange={setMoreOpen} position="bottom" width={260} shadow="md">
            <Popover.Target>
              <button
                type="button"
                className="ordb-linkbtn ordb-cal-more"
                onClick={(e) => {
                  e.stopPropagation();
                  setMoreOpen((o) => !o);
                }}
              >
                + {hidden} autre{hidden > 1 ? 's' : ''}
              </button>
            </Popover.Target>
            <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape} onClick={(e) => e.stopPropagation()}>
              <div className="ordb-menu-label">{format(day, 'EEEE d MMMM', { locale: fr })}</div>
              <div className="ordb-options-list">
                {rows.map((r) => (
                  <button type="button" key={r.id} className="ordb-option-row" onClick={() => openRow(r.id)}>
                    <RowTitle row={r} />
                  </button>
                ))}
              </div>
            </Popover.Dropdown>
          </Popover>
        )}
      </div>
    </div>
  );
}

export function CalendarView({ vs }: { vs: ViewState }) {
  const { properties, ctx, canEdit, m } = useDb();
  const dateProp: PropertyDef | null = properties.find((p) => p.id === vs.config.dateProperty && isDateLike(p)) ?? null;
  const mode: NonNullable<ViewConfig['calendarMode']> = vs.config.calendarMode === 'week' ? 'week' : 'month';
  const [anchor, setAnchor] = useState(() => new Date());
  const [dragging, setDragging] = useState<Page | null>(null);
  const [undatedOpen, setUndatedOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const month = startOfMonth(anchor);

  const weeks = useMemo(() => {
    const first = mode === 'week' ? startOfWeek(anchor, { weekStartsOn: 1 }) : startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
    const last = mode === 'week' ? endOfWeek(anchor, { weekStartsOn: 1 }) : endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
    const n = differenceInCalendarDays(last, first) + 1;
    const days = Array.from({ length: n }, (_, i) => addDays(first, i));
    const out: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [anchor, mode]);

  const { singleByDay, multi, undated } = useMemo(() => {
    const map = new Map<number, Page[]>();
    const spans: CalendarItem[] = [];
    const none: Page[] = [];
    if (!dateProp) return { singleByDay: map, multi: spans, undated: none };
    for (const row of vs.rows) {
      const r = getDateRange(row, dateProp, ctx);
      if (!r) {
        none.push(row);
        continue;
      }
      const item = { id: row.id, start: r.start, end: r.end && r.end > r.start ? r.end : r.start };
      if (isMultiDay(item)) {
        spans.push(item);
        continue;
      }
      const k = dayKey(r.start);
      let list = map.get(k);
      if (!list) map.set(k, (list = []));
      list.push(row);
    }
    return { singleByDay: map, multi: spans, undated: none };
  }, [vs.rows, dateProp, ctx]);
  const rowById = useMemo(() => new Map(vs.rows.map((r) => [r.id, r])), [vs.rows]);

  if (!dateProp) {
    const candidates = properties.filter(isDateLike);
    return (
      <EmptyState
        action={
          canEdit ? (
            <span className="ordb-empty-actions">
              {candidates.map((p) => (
                <button key={p.id} type="button" className="ordb-btn is-outline is-sm" onClick={() => vs.setConfig({ dateProperty: p.id })}>
                  Afficher selon « {p.name} »
                </button>
              ))}
              {candidates.length === 0 && (
                <button
                  type="button"
                  className="ordb-btn is-primary is-sm"
                  onClick={() => {
                    const { id } = m.createProperty(newPropertyDef('date', properties, { name: 'Date' }));
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
        Le calendrier place chaque ligne selon une propriété de date.
      </EmptyState>
    );
  }

  const editableDate = canEdit && dateProp.type === 'date';

  const onDragStart = (e: DragStartEvent) => {
    const id = (e.active.data.current as { rowId: string } | undefined)?.rowId;
    setDragging(vs.rows.find((r) => r.id === id) ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    dragClock.endedAt = Date.now();
    setDragging(null);
    const src = e.active.data.current as { rowId: string; day: number } | undefined;
    const dst = e.over?.data.current as { day: number } | undefined;
    if (!src || !dst || src.day === dst.day) return;
    const row = vs.rows.find((r) => r.id === src.rowId);
    const value = row ? (rawValue(row, dateProp) as DateValue | null) : null;
    if (!row || !value) return;
    const toDate = (k: number) => new Date(Math.floor(k / 10000), (Math.floor(k / 100) % 100) - 1, k % 100);
    const delta = differenceInCalendarDays(toDate(dst.day), toDate(src.day));
    void m.updateRow(row.id, { properties: { [dateProp.id]: shiftDateValue(value, delta) } });
  };

  const createOn = editableDate
    ? (day: Date) => vs.createRow({ properties: { [dateProp.id]: { start: toDateString(day) } } }, { open: true })
    : undefined;
  const step = (dir: 1 | -1) => setAnchor((a) => (mode === 'week' ? addWeeks(a, dir) : addMonths(a, dir)));
  const firstWeek = weeks[0] ?? [];
  const title =
    mode === 'week' && firstWeek[0]
      ? `Semaine du ${format(firstWeek[0], 'd MMM', { locale: fr })} au ${format(firstWeek[6] ?? firstWeek[0], 'd MMM yyyy', { locale: fr })}`
      : format(month, 'LLLL yyyy', { locale: fr });

  return (
    <div className={cx('ordb-calendar', mode === 'week' && 'is-week')}>
      <div className="ordb-cal-toolbar">
        <span className="ordb-cal-month">{title}</span>
        <span className="ordb-option-spacer" />
        {undated.length > 0 && (
          <Popover opened={undatedOpen} onChange={setUndatedOpen} position="bottom-end" width={280} shadow="md">
            <Popover.Target>
              <button type="button" className="ordb-btn is-ghost is-sm" onClick={() => setUndatedOpen((o) => !o)}>
                <CalendarX size={14} /> Sans date ({undated.length})
              </button>
            </Popover.Target>
            <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
              <div className="ordb-menu-label">Lignes sans « {dateProp.name} »</div>
              <div className="ordb-options-list">
                {undated.slice(0, 200).map((r) => (
                  <button type="button" key={r.id} className="ordb-option-row" onClick={() => openRow(r.id)}>
                    <RowTitle row={r} />
                  </button>
                ))}
              </div>
            </Popover.Dropdown>
          </Popover>
        )}
        <NativeSelect
          ariaLabel="Affichage du calendrier"
          value={mode}
          onChange={(v) => vs.setConfig({ calendarMode: v as 'month' | 'week' })}
          choices={[
            { value: 'month', label: 'Mois' },
            { value: 'week', label: 'Semaine' },
          ]}
        />
        <button type="button" className="ordb-btn is-outline is-sm" onClick={() => setAnchor(new Date())}>
          Aujourd'hui
        </button>
        <IconBtn label={mode === 'week' ? 'Semaine précédente' : 'Mois précédent'} onClick={() => step(-1)}>
          <ChevronLeft size={16} />
        </IconBtn>
        <IconBtn label={mode === 'week' ? 'Semaine suivante' : 'Mois suivant'} onClick={() => step(1)}>
          <ChevronRight size={16} />
        </IconBtn>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="ordb-cal-month-grid" role="grid">
          {firstWeek.map((d) => (
            <div key={`h${d.getDay()}`} className="ordb-cal-weekhead" role="columnheader">
              {format(d, 'EEE', { locale: fr })}
            </div>
          ))}
        </div>
        {weeks.map((week) => {
          const { spans, lanes } = layoutWeek(week[0]!, multi);
          return (
            <div key={week[0]!.getTime()} className={cx('ordb-cal-weekrow', mode === 'week' && 'is-tall')} role="row">
              {week.map((d) => (
                <DayCell
                  key={d.getTime()}
                  day={d}
                  month={mode === 'month' ? month : null}
                  rows={singleByDay.get(dayKey(d)) ?? []}
                  vs={vs}
                  draggable={editableDate}
                  onCreate={createOn}
                  lanes={lanes}
                  tall={mode === 'week'}
                />
              ))}
              {spans.length > 0 && (
                <div className="ordb-cal-spanlayer">
                  {spans.map((s) => {
                    const row = rowById.get(s.id);
                    return row ? <SpanBar key={s.id} span={s} row={row} weekStart={week[0]!} draggable={editableDate} /> : null;
                  })}
                </div>
              )}
            </div>
          );
        })}
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="ordb-cal-card is-overlay">
              <RowTitle row={dragging} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
