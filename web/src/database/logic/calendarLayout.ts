// Calendar layout: multi-day items are drawn as one bar per week row, packed into lanes.
import { differenceInCalendarDays } from 'date-fns';

export interface CalendarItem {
  id: string;
  start: Date;
  end: Date;
}

export interface WeekSpan {
  id: string;
  /** Column of the first / last covered day in the week (0 = Monday). */
  from: number;
  to: number;
  lane: number;
  /** The item started before / goes on after this week. */
  continuesLeft: boolean;
  continuesRight: boolean;
}

/** True for items covering more than one calendar day. */
export const isMultiDay = (item: CalendarItem) => differenceInCalendarDays(item.end, item.start) >= 1;

/**
 * Bars of the multi-day `items` intersecting the week starting on `weekStart`, packed into lanes
 * (earliest first, longest first on ties). Returns the spans and the number of lanes used.
 */
export function layoutWeek(weekStart: Date, items: readonly CalendarItem[], days = 7): { spans: WeekSpan[]; lanes: number } {
  const placed: Array<{ item: CalendarItem; from: number; to: number; s: number; e: number }> = [];
  for (const item of items) {
    if (!isMultiDay(item)) continue;
    const s = differenceInCalendarDays(item.start, weekStart);
    const e = differenceInCalendarDays(item.end, weekStart);
    if (e < 0 || s > days - 1) continue;
    placed.push({ item, from: Math.max(0, s), to: Math.min(days - 1, e), s, e });
  }
  placed.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from) || a.item.id.localeCompare(b.item.id));
  const laneEnds: number[] = [];
  const spans: WeekSpan[] = [];
  for (const p of placed) {
    let lane = laneEnds.findIndex((end) => end < p.from);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(p.to);
    } else {
      laneEnds[lane] = p.to;
    }
    spans.push({ id: p.item.id, from: p.from, to: p.to, lane, continuesLeft: p.s < 0, continuesRight: p.e > days - 1 });
  }
  return { spans, lanes: laneEnds.length };
}
