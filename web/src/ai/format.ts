// French formatting helpers of the AI module.
import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AI_WEEKDAY_LABELS, aiModelInfo, type AiSettings, type IsoWeekday } from '@oriel/shared';

/** USD amount with French conventions: « 0,42 $ », « 0,004 $ ». */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount === 0) return '0 $';
  const digits = Math.abs(amount) < 0.1 ? 3 : 2;
  return `${amount.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: digits })} $`;
}

/** « 12 480 » / « 1,2 M » */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`;
  return n.toLocaleString('fr-FR');
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

const parseDay = (day: string) => parseISO(`${day}T12:00:00`);

/** 'YYYY-MM-DD' → « mercredi 14 octobre 2026 » */
export function formatLongDay(day: string): string {
  const d = parseDay(day);
  return isValid(d) ? format(d, 'EEEE d MMMM yyyy', { locale: fr }) : day;
}

/** 'YYYY-MM-DD' → « 14 oct. » */
export function formatShortDay(day: string): string {
  const d = parseDay(day);
  return isValid(d) ? format(d, 'd MMM', { locale: fr }) : day;
}

/** Local 'YYYY-MM-DD' of the browser. */
export const todayKey = (): string => format(new Date(), 'yyyy-MM-dd');

/** « aujourd’hui », « demain », « dans 3 jours », « il y a 2 jours » */
export function relativeDay(day: string, today = todayKey()): string {
  const diff = differenceInCalendarDays(parseDay(day), parseDay(today));
  if (diff === 0) return 'aujourd’hui';
  if (diff === 1) return 'demain';
  if (diff === -1) return 'hier';
  return diff > 0 ? `dans ${diff} jours` : `il y a ${-diff} jours`;
}

export const modelLabel = (id: string): string => aiModelInfo(id)?.label ?? id;

/** « du lundi au vendredi à 07:30 » */
export function scheduleLabel(settings: Pick<AiSettings, 'scheduleDays' | 'scheduleTime'>): string {
  const days = [...settings.scheduleDays].sort((a, b) => a - b);
  let when: string;
  if (days.length === 7) when = 'tous les jours';
  else if (days.join() === '1,2,3,4,5') when = 'du lundi au vendredi';
  else if (days.length === 0) when = 'aucun jour';
  else {
    const names = days.map((d) => `le ${AI_WEEKDAY_LABELS[d as IsoWeekday].toLowerCase()}`);
    when = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`;
  }
  const [h = '0', m = '00'] = settings.scheduleTime.split(':');
  return `${when} à ${Number(h)} h${m === '00' ? '' : ` ${m}`}`;
}
