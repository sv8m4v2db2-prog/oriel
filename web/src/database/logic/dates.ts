// Date helpers for database values. Dates without time are stored as 'YYYY-MM-DD' and must be
// interpreted in the *local* time zone (never as UTC midnight); dates with time are full ISO strings.
import type { DateValue, RelativeDuration, RelativeRange } from '@oriel/shared';
import { addDays, addMonths, addWeeks, addYears, startOfDay } from 'date-fns';

export interface DateRange {
  start: Date;
  end: Date | null;
  includeTime: boolean;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses 'YYYY-MM-DD' as a local date, anything else as an ISO date-time. Invalid → null. */
export function parseDateString(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = DATE_ONLY.exec(value);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as 'YYYY-MM-DD'. */
export function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Serialized form stored in DateValue.start / end. */
export function serializeDate(d: Date, includeTime: boolean): string {
  return includeTime ? d.toISOString() : toDateString(d);
}

/** Comparable integer for a local calendar day (YYYYMMDD). */
export function dayKey(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function isDateValue(v: unknown): v is DateValue {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as DateValue).start === 'string';
}

export function dateValueToRange(v: unknown): DateRange | null {
  if (!isDateValue(v)) return null;
  const start = parseDateString(v.start);
  if (!start) return null;
  const end = v.end ? parseDateString(v.end) : null;
  return { start, end, includeTime: !!v.includeTime };
}

/** Inclusive day-key interval covered by a range (end defaults to start; swapped if reversed). */
export function rangeDayKeys(r: DateRange): [number, number] {
  const a = dayKey(r.start);
  const b = r.end ? dayKey(r.end) : a;
  return a <= b ? [a, b] : [b, a];
}

/** Inclusive interval (as day keys) of a relative range, computed from `now`. */
export function relativeRangeKeys(range: RelativeRange, now: Date): [number, number] {
  const today = startOfDay(now);
  const k = dayKey(today);
  switch (range) {
    case 'today':
      return [k, k];
    case 'yesterday': {
      const y = dayKey(addDays(today, -1));
      return [y, y];
    }
    case 'tomorrow': {
      const t = dayKey(addDays(today, 1));
      return [t, t];
    }
    case 'past_week':
      return [dayKey(addWeeks(today, -1)), k];
    case 'past_month':
      return [dayKey(addMonths(today, -1)), k];
    case 'past_year':
      return [dayKey(addYears(today, -1)), k];
    case 'next_week':
      return [k, dayKey(addWeeks(today, 1))];
    case 'next_month':
      return [k, dayKey(addMonths(today, 1))];
    case 'next_year':
      return [k, dayKey(addYears(today, 1))];
  }
}

export const RELATIVE_RANGES: RelativeRange[] = [
  'yesterday',
  'today',
  'tomorrow',
  'past_week',
  'past_month',
  'past_year',
  'next_week',
  'next_month',
  'next_year',
];

export const RELATIVE_RANGE_LABELS: Record<RelativeRange, string> = {
  yesterday: 'hier',
  today: "aujourd'hui",
  tomorrow: 'demain',
  past_week: 'la semaine passée',
  past_month: 'le mois passé',
  past_year: "l'année passée",
  next_week: 'la semaine prochaine',
  next_month: 'le mois prochain',
  next_year: "l'année prochaine",
};

/** Relative day tokens accepted as values of absolute date operators. */
export const RELATIVE_DAYS = ['today', 'tomorrow', 'yesterday'] as const;
export type RelativeDay = (typeof RELATIVE_DAYS)[number];
export const RELATIVE_DAY_LABELS: Record<RelativeDay, string> = {
  today: "Aujourd'hui",
  tomorrow: 'Demain',
  yesterday: 'Hier',
};

/** Resolves a filter date value ('YYYY-MM-DD' | 'today' | 'tomorrow' | 'yesterday') to a local day. */
export function resolveFilterDate(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const today = startOfDay(now);
  if (value === 'today') return today;
  if (value === 'tomorrow') return addDays(today, 1);
  if (value === 'yesterday') return addDays(today, -1);
  return parseDateString(value);
}

/** Shifts every date of a DateValue by `days`, keeping time and range length. */
export function shiftDateValue(v: DateValue, days: number): DateValue {
  const r = dateValueToRange(v);
  if (!r) return v;
  const start = addDays(r.start, days);
  const end = r.end ? addDays(r.end, days) : null;
  return {
    start: serializeDate(start, r.includeTime),
    end: end ? serializeDate(end, r.includeTime) : v.end === undefined ? undefined : null,
    includeTime: v.includeTime,
  };
}

/** Moves a DateValue so that it starts on `day` (local), keeping time of day and range length. */
export function moveDateValueToDay(v: DateValue | null, day: Date): DateValue {
  if (!v) return { start: toDateString(day) };
  const r = dateValueToRange(v);
  if (!r) return { start: toDateString(day) };
  const delta = Math.round((startOfDay(day).getTime() - startOfDay(r.start).getTime()) / 86_400_000);
  return shiftDateValue(v, delta);
}

// ---------------------------------------------------------------------------
// Durations relative to today (« dans les 7 derniers jours », « il y a exactement 2 semaines »)
// ---------------------------------------------------------------------------

export const DURATION_UNITS: RelativeDuration['unit'][] = ['day', 'week', 'month'];
export const DURATION_UNIT_LABELS: Record<RelativeDuration['unit'], [string, string]> = {
  day: ['jour', 'jours'],
  week: ['semaine', 'semaines'],
  month: ['mois', 'mois'],
};
/** Largest amount accepted in a duration filter. */
export const MAX_DURATION_AMOUNT = 10_000;

/** A valid duration (integer amount from 0 to 10 000, known unit), or null. Numeric strings are accepted. */
export function asDuration(value: unknown): RelativeDuration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { amount, unit } = value as { amount?: unknown; unit?: unknown };
  const n = typeof amount === 'string' && amount.trim() !== '' ? Number(amount.replace(',', '.')) : amount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_DURATION_AMOUNT) return null;
  if (!DURATION_UNITS.includes(unit as RelativeDuration['unit'])) return null;
  return { amount: Math.round(n), unit: unit as RelativeDuration['unit'] };
}

/** `day` shifted by `amount` units (negative: into the past), as a local calendar day. */
export function shiftByDuration(day: Date, d: RelativeDuration, sign: 1 | -1): Date {
  const n = sign * d.amount;
  switch (d.unit) {
    case 'day':
      return addDays(day, n);
    case 'week':
      return addWeeks(day, n);
    case 'month':
      return addMonths(day, n);
  }
}

/** Inclusive day-key interval of the last / next `d` from `now` (today included). */
export function durationRangeKeys(d: RelativeDuration, direction: 'last' | 'next', now: Date): [number, number] {
  const today = startOfDay(now);
  const k = dayKey(today);
  const other = dayKey(shiftByDuration(today, d, direction === 'last' ? -1 : 1));
  return direction === 'last' ? [other, k] : [k, other];
}

/** Day key of the day `d` ago / ahead of `now`. */
export function durationDayKey(d: RelativeDuration, direction: 'ago' | 'ahead', now: Date): number {
  return dayKey(shiftByDuration(startOfDay(now), d, direction === 'ago' ? -1 : 1));
}
