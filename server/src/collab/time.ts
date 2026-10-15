// Wall-clock helpers in the Europe/Paris time zone (reminders at 09:00, daily digest at 08:00).
export const COLLAB_TIME_ZONE = 'Europe/Paris';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: COLLAB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface ParisClock {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
}

export function parisClock(now = Date.now()): ParisClock {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export const parisToday = (now = Date.now()): string => parisClock(now).date;

/** Hour (Paris) at which date reminders fire, and at which the daily digest is sent. */
export const REMINDER_HOUR = 9;
export const DIGEST_HOUR = 8;
