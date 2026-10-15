// Local date/time helpers for a workspace's configured time zone (no dependency: Intl only).
import type { IsoWeekday } from '@oriel/shared';

export interface LocalParts {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'YYYY-MM' */
  month: string;
  /** Minutes since local midnight. */
  minutes: number;
  weekday: IsoWeekday;
}

const WEEKDAYS: Record<string, IsoWeekday> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Calendar parts of `now` in `tz` (falls back to UTC for an invalid zone). */
export function localParts(now: number | Date, tz: string): LocalParts {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const parts = Object.fromEntries(formatterFor(zone).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour) % 24;
  return {
    date,
    month: date.slice(0, 7),
    minutes: hour * 60 + Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/**
 * UTC calendar month of `now`: 'YYYY-MM' and its bounds [start, end) in ms. Period of the instance-wide
 * cap, which spans workspaces of different time zones (each workspace budget follows its own zone).
 */
export function utcMonthRange(now: number): { month: string; start: number; end: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { month: new Date(start).toISOString().slice(0, 7), start, end };
}

/** 'HH:MM' → minutes since midnight (null when malformed). */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Adds days to a 'YYYY-MM-DD' calendar date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const FR_WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « mardi 14 octobre 2026 » */
export function frenchLongDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${FR_WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${FR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
