// Date mentions: French parsing of what follows "@" ("demain", "lundi prochain", "15/11",
// "15 novembre", "dans 3 jours"…) and localized labels. Dates are local calendar days 'YYYY-MM-DD'.
import { normalizeText } from '../lib/util';

const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function validDate(year: number, month: number, day: number): Date | null {
  const d = new Date(year, month, day);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
}

/** Day and month without a year: this year, or next year if it is more than a month ago. */
function withoutYear(month: number, day: number, today: Date): Date | null {
  const d = validDate(today.getFullYear(), month, day);
  if (!d) return validDate(today.getFullYear() + 1, month, day);
  if (d.getTime() < addDays(today, -31).getTime()) return validDate(today.getFullYear() + 1, month, day);
  return d;
}

function nextWeekday(today: Date, weekday: number): Date {
  const diff = (weekday - today.getDay() + 7) % 7 || 7;
  return addDays(today, diff);
}

function monthIndex(word: string): number {
  if (word.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(word));
}

/** Parses a French date expression; returns null when nothing matches. */
export function parseFrenchDate(input: string, now = new Date()): Date | null {
  const q = normalizeText(input).replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const today = startOfToday(now);
  if (q === 'aujourdhui' || q === 'auj') return today;
  if (q === 'demain') return addDays(today, 1);
  if (q === 'apres-demain' || q === 'apres demain' || q === 'apresdemain') return addDays(today, 2);
  if (q === 'hier') return addDays(today, -1);
  let m = /^dans (\d{1,3}) (jour|jours|j|semaine|semaines|sem|mois)$/.exec(q);
  if (m) {
    const n = Number(m[1]);
    if (m[2]!.startsWith('j')) return addDays(today, n);
    if (m[2]!.startsWith('s')) return addDays(today, n * 7);
    return validDate(today.getFullYear(), today.getMonth() + n, today.getDate()) ?? addDays(today, n * 30);
  }
  m = /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)( prochain)?$/.exec(q);
  if (m) return nextWeekday(today, WEEKDAYS.indexOf(m[1]!));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (m) return validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(q);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    if (m[3]) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return validDate(year, month, day);
    }
    return withoutYear(month, day, today);
  }
  m = /^(\d{1,2})(?:er)? ([a-z]+)\.?(?: (\d{4}))?$/.exec(q);
  if (m) {
    const month = monthIndex(m[2]!);
    if (month === -1) return null;
    const day = Number(m[1]);
    return m[3] ? validDate(Number(m[3]), month, day) : withoutYear(month, day, today);
  }
  return null;
}

export interface DateSuggestion {
  label: string;
  date: string;
}

/** Suggestions for the mention menu: keyword shortcuts matching the query, or the parsed date. */
export function dateSuggestions(query: string, now = new Date()): DateSuggestion[] {
  const today = startOfToday(now);
  const shortcuts: DateSuggestion[] = [
    { label: 'Aujourd’hui', date: toIsoDate(today) },
    { label: 'Demain', date: toIsoDate(addDays(today, 1)) },
    { label: 'Lundi prochain', date: toIsoDate(nextWeekday(today, 1)) },
    { label: 'Après-demain', date: toIsoDate(addDays(today, 2)) },
    { label: 'Dans une semaine', date: toIsoDate(addDays(today, 7)) },
  ];
  const q = normalizeText(query).replace(/[’']/g, '');
  if (!q) return shortcuts.slice(0, 3);
  const out: DateSuggestion[] = [];
  const parsed = parseFrenchDate(query, now);
  if (parsed) out.push({ label: formatDateLabel(toIsoDate(parsed), now, true), date: toIsoDate(parsed) });
  for (const s of shortcuts) {
    if (normalizeText(s.label).replace(/[’']/g, '').startsWith(q) && !out.some((o) => o.date === s.date)) out.push(s);
  }
  if (out.length === 0) {
    const weekday = WEEKDAYS.findIndex((w) => q.length >= 2 && w.startsWith(q));
    if (weekday !== -1) {
      const d = nextWeekday(today, weekday);
      out.push({ label: `${WEEKDAYS[weekday]![0]!.toUpperCase()}${WEEKDAYS[weekday]!.slice(1)} prochain`, date: toIsoDate(d) });
    }
  }
  return out.slice(0, 4);
}

const longFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** "Aujourd’hui", "Demain", "Hier", "15 novembre" (this year) or "15 novembre 2027". */
export function formatDateLabel(iso: string, now = new Date(), withWeekday = false): string {
  const d = fromIsoDate(iso);
  if (!d) return iso || 'Date';
  const today = startOfToday(now);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  if (withWeekday && d.getFullYear() === today.getFullYear()) {
    const s = weekdayFmt.format(d);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return d.getFullYear() === today.getFullYear() ? shortFmt.format(d) : longFmt.format(d);
}

export function formatDateLong(iso: string): string {
  const d = fromIsoDate(iso);
  return d ? longFmt.format(d) : iso;
}

export function isPast(iso: string, now = new Date()): boolean {
  const d = fromIsoDate(iso);
  return !!d && d.getTime() < startOfToday(now).getTime();
}
