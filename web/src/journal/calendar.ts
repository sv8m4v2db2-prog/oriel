// Pure calendar helpers of the journal (no React): month grid starting on Monday, day keys.

export interface CalendarCell {
  /** `YYYY-MM-DD` */
  day: string;
  inMonth: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day of a date, `YYYY-MM-DD`. */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const monthKey = (year: number, month0: number): string => `${year}-${pad(month0 + 1)}`;

export function parseMonth(month: string): { year: number; month0: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  return month0 >= 0 && month0 < 12 && year >= 2000 && year <= 2100 ? { year, month0 } : null;
}

export function shiftMonth(month: string, delta: number): string {
  const p = parseMonth(month) ?? { year: new Date().getFullYear(), month0: new Date().getMonth() };
  const d = new Date(p.year, p.month0 + delta, 1);
  return monthKey(d.getFullYear(), d.getMonth());
}

/** 6 weeks (42 cells) beginning on the Monday on or before the first of the month. */
export function monthGrid(month: string): CalendarCell[] {
  const p = parseMonth(month);
  if (!p) return [];
  const first = new Date(p.year, p.month0, 1);
  const offset = (first.getDay() + 6) % 7;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(p.year, p.month0, 1 - offset + i);
    cells.push({ day: dayKey(d), inMonth: d.getMonth() === p.month0 });
  }
  return cells;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const WEEKDAYS_SHORT = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

export function monthLabel(month: string): string {
  const p = parseMonth(month);
  return p ? `${MONTHS[p.month0]} ${p.year}` : month;
}

/** « jeudi 15 octobre 2026 » for a `YYYY-MM-DD` key (local calendar). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const date = new Date(y, m - 1, d);
  const weekday = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][date.getDay()];
  return `${weekday} ${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}

/** Days outside the server's accepted range (2000-2100) cannot be opened. */
export const isOpenableDay = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number(day.slice(0, 4)) >= 2000 && Number(day.slice(0, 4)) <= 2100;
