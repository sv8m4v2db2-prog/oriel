// Default reminders of date properties (G1 / D26). A date property can carry a setting
// (`dateReminder`: same day at a time, the day before, two days before, a week before). Every date
// typed in the column then gives its author a reminder, fired like the reminders of date mentions
// (notification of type « reminder », Europe/Paris wall clock). Rows of `collab_property_reminders`
// follow the value: changing or clearing the date drops the old reminders.
import type { DateReminderConfig, DateReminderMode, DateValue, PropertyDef, PropertyValue } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { canReadProperty, canSeePage, getPageRow, roleOf } from '../access.js';
import { parseJson } from '../db/rows.js';
import { notify } from './notify.js';
import { parisClock } from './time.js';

const DEFAULT_MINUTES = 9 * 60;
const MODE_DAYS: Record<DateReminderMode, number | null> = {
  none: null,
  same_day: 0,
  day_before: 1,
  two_days_before: 2,
  week_before: 7,
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` minus `days` (calendar arithmetic on the date itself, no time zone involved). */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** Day of the start of a date value, in Paris for values with a time. Null when unusable. */
export function eventDay(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const start = (value as DateValue).start;
  if (typeof start !== 'string') return null;
  if (DAY_RE.test(start)) return start;
  const ms = Date.parse(start);
  return Number.isNaN(ms) ? null : parisClock(ms).date;
}

function minutesOf(config: DateReminderConfig): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(config.time ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : DEFAULT_MINUTES;
}

/** When the reminder of `value` fires under `config`: Paris day and minutes after midnight. */
export function reminderMoment(value: unknown, config: DateReminderConfig | undefined): { eventDate: string; date: string; minutes: number } | null {
  const days = config ? MODE_DAYS[config.mode] : null;
  if (days === null || days === undefined || !config) return null;
  const eventDate = eventDay(value);
  if (!eventDate) return null;
  return { eventDate, date: shiftDay(eventDate, days), minutes: minutesOf(config) };
}

const sameDate = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Called after a row's values were written: for every date property whose value changed, replaces
 * the reminders of that cell, giving a new one to `actorId` when the property has a default
 * reminder and the moment is still to come.
 */
export function syncPropertyReminders(
  db: Db,
  actorId: string,
  page: { id: string; workspace_id: string },
  schema: PropertyDef[],
  before: Record<string, PropertyValue>,
  after: Record<string, PropertyValue>,
  now = Date.now(),
): void {
  let role: ReturnType<typeof roleOf> | undefined;
  for (const prop of schema) {
    if (prop.type !== 'date' || sameDate(before[prop.id], after[prop.id])) continue;
    db.run('DELETE FROM collab_property_reminders WHERE page_id = ? AND property_id = ?', page.id, prop.id);
    const moment = reminderMoment(after[prop.id], prop.dateReminder);
    if (!moment) continue;
    // A date hidden from the actor (D30: copied by a duplication or a template) gives it no reminder (QA-G3-01).
    if (role === undefined) role = roleOf(db, actorId, page.workspace_id);
    if (!canReadProperty(role, prop)) continue;
    const clock = parisClock(now);
    const past = moment.date < clock.date || (moment.date === clock.date && moment.minutes <= clock.hour * 60 + clock.minute);
    if (past) continue;
    db.run(
      `INSERT OR REPLACE INTO collab_property_reminders
         (page_id, property_id, user_id, workspace_id, event_date, remind_date, remind_minutes, created_at, fired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      page.id,
      prop.id,
      actorId,
      page.workspace_id,
      moment.eventDate,
      moment.date,
      moment.minutes,
      now,
    );
  }
}

/** Fires due property reminders; returns how many notifications were created. */
export function runPropertyReminders(ctx: AppContext, now = Date.now()): number {
  const { db } = ctx;
  const clock = parisClock(now);
  const minutes = clock.hour * 60 + clock.minute;
  const due = db.all<{ page_id: string; property_id: string; user_id: string; event_date: string; workspace_id: string }>(
    `SELECT page_id, property_id, user_id, event_date, workspace_id FROM collab_property_reminders
     WHERE fired_at IS NULL AND (remind_date < ? OR (remind_date = ? AND remind_minutes <= ?))`,
    clock.date,
    clock.date,
    minutes,
  );
  let created = 0;
  for (const r of due) {
    db.tx(() => {
      db.run(
        'UPDATE collab_property_reminders SET fired_at = ? WHERE page_id = ? AND property_id = ? AND user_id = ?',
        now,
        r.page_id,
        r.property_id,
        r.user_id,
      );
      const page = getPageRow(db, r.page_id);
      const role = page ? roleOf(db, r.user_id, page.workspace_id) : null;
      if (!page || !role || page.trashed_at !== null || !canSeePage(r.user_id, role, page, db)) return;
      // The property may have been restricted (D30) or retyped since: its date is not revealed (QA-G3-02).
      const schema = page.parent_type === 'database' ? db.get<{ properties: string }>('SELECT properties FROM databases WHERE page_id = ?', page.parent_id) : undefined;
      const def = parseJson<PropertyDef[]>(schema?.properties, []).find((p) => p.id === r.property_id);
      if (!def || def.type !== 'date' || !canReadProperty(role, def)) return;
      const id = notify(ctx, { userId: r.user_id, workspaceId: page.workspace_id, type: 'reminder', actorId: null, pageId: page.id, date: r.event_date, excerpt: page.title });
      if (id) created++;
    });
  }
  return created;
}
