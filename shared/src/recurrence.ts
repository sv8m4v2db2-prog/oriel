// Recurring row templates (I1): a template creates a row on a schedule. Occurrences are wall-clock
// moments in the Europe/Paris time zone, written 'YYYY-MM-DDTHH:MM' so that they compare as strings
// and never drift with daylight saving time.

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface TemplateRecurrence {
  frequency: RecurrenceFrequency;
  /** Every N days / weeks / months / years (1–365). */
  interval: number;
  /** weekly: ISO weekdays, 1 (Monday) to 7 (Sunday); empty or absent = the weekday of `startDate`. */
  weekdays?: number[];
  /** First possible occurrence, 'YYYY-MM-DD'. monthly / yearly repeat its day (clamped to the month end). */
  startDate: string;
  /** Wall-clock time, 'HH:MM' (Europe/Paris). */
  time: string;
  /** Last possible occurrence day, 'YYYY-MM-DD'; absent or null = no end. */
  endDate?: string | null;
}

export interface TemplateRecurrenceInfo {
  templateId: string;
  recurrence: TemplateRecurrence;
  /** Next creation, 'YYYY-MM-DDTHH:MM' (Europe/Paris); null when the recurrence is over. */
  nextRun: string | null;
  /** Last creation (epoch ms) and the row it created. */
  lastRunAt: number | null;
  lastRowId: string | null;
  /** Why the last occurrence created nothing (template or database in the trash, access lost). */
  lastError: string | null;
}

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  daily: 'Tous les jours',
  weekly: 'Toutes les semaines',
  monthly: 'Tous les mois',
  yearly: 'Tous les ans',
};

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const dayNumber = (date: string): number => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY_MS;
const fromDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** ISO weekday of a day number: 1 (Monday) to 7 (Sunday). Day 0 (1970-01-01) is a Thursday. */
const isoWeekday = (n: number): number => ((((n + 3) % 7) + 7) % 7) + 1;
const daysInMonth = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** True when `date` is a real calendar day 'YYYY-MM-DD'. */
export function isCalendarDate(date: string): boolean {
  return DATE_RE.test(date) && fromDayNumber(dayNumber(date)) === date;
}

/** Validation message of a recurrence, or null when it is usable. */
export function recurrenceProblem(r: TemplateRecurrence): string | null {
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.frequency)) return 'Fréquence inconnue.';
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 365) return "L'intervalle doit être compris entre 1 et 365.";
  if (!isCalendarDate(r.startDate)) return 'Date de début invalide.';
  if (!TIME_RE.test(r.time)) return 'Heure invalide (HH:MM).';
  if (r.endDate != null && (!isCalendarDate(r.endDate) || r.endDate < r.startDate)) return 'Date de fin invalide.';
  if (r.weekdays && r.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'Jour de la semaine invalide.';
  return null;
}

/**
 * First occurrence strictly after `after` ('YYYY-MM-DDTHH:MM', Europe/Paris), or null when the
 * recurrence has ended. Missed occurrences are never returned: callers pass the current moment.
 */
export function nextOccurrence(r: TemplateRecurrence, after: string): string | null {
  if (recurrenceProblem(r)) return null;
  const start = dayNumber(r.startDate);
  const end = r.endDate ? dayNumber(r.endDate) : Infinity;
  const afterDay = Math.max(dayNumber(after.slice(0, 10)), start);
  const ok = (day: number) => day >= start && day <= end && `${fromDayNumber(day)}T${r.time}` > after;
  // Candidate days in increasing order, from the period containing `afterDay`; at most a few periods
  // need checking, since every period holds at least one occurrence.
  const candidates: number[] = [];
  if (r.frequency === 'daily') {
    const k = Math.floor((afterDay - start) / r.interval);
    for (let i = k; i <= k + 2; i++) candidates.push(start + i * r.interval);
  } else if (r.frequency === 'weekly') {
    const days = (r.weekdays?.length ? [...new Set(r.weekdays)] : [isoWeekday(start)]).sort((a, b) => a - b);
    const monday0 = start - (isoWeekday(start) - 1);
    const k = Math.floor((afterDay - monday0) / (7 * r.interval));
    for (let i = k; i <= k + 2; i++) for (const d of days) candidates.push(monday0 + i * 7 * r.interval + d - 1);
  } else {
    const step = r.frequency === 'monthly' ? r.interval : 12 * r.interval;
    const sy = +r.startDate.slice(0, 4);
    const sm = +r.startDate.slice(5, 7) - 1;
    const sd = +r.startDate.slice(8, 10);
    const a = fromDayNumber(afterDay);
    const elapsed = (+a.slice(0, 4) - sy) * 12 + (+a.slice(5, 7) - 1 - sm);
    const k = Math.max(0, Math.floor(elapsed / step));
    for (let i = k; i <= k + 2; i++) {
      const m = sm + i * step;
      const y = sy + Math.floor(m / 12);
      const m0 = ((m % 12) + 12) % 12;
      candidates.push(Date.UTC(y, m0, Math.min(sd, daysInMonth(y, m0))) / DAY_MS);
    }
  }
  for (const day of candidates) {
    if (day > end) return null;
    if (ok(day)) return `${fromDayNumber(day)}T${r.time}`;
  }
  return null;
}
