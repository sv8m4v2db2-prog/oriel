// Periodic work of the collab module: date reminders (09:00 Europe/Paris on the date), daily
// notification digest e-mails (08:00 Europe/Paris) and cleanup of old notifications.
import type { AppContext } from '../context.js';
import { canSeePage, getPageRow, roleOf } from '../access.js';
import { cleanupInviteMails } from './invites.js';
import { notify, sendDigests } from './notify.js';
import { runPropertyReminders } from './propertyReminders.js';
import { DIGEST_HOUR, parisClock, REMINDER_HOUR } from './time.js';

const DAY = 24 * 60 * 60 * 1000;

/** Fires due reminders; returns how many notifications were created. */
export function runReminders(ctx: AppContext, now = Date.now()): number {
  const { db } = ctx;
  const clock = parisClock(now);
  const due = db.all<{ page_id: string; user_id: string; date: string; workspace_id: string }>(
    `SELECT page_id, user_id, date, workspace_id FROM collab_reminders
     WHERE fired_at IS NULL AND (date < ? OR (date = ? AND ? >= ?))`,
    clock.date,
    clock.date,
    clock.hour,
    REMINDER_HOUR,
  );
  let created = 0;
  for (const r of due) {
    db.tx(() => {
      db.run('UPDATE collab_reminders SET fired_at = ? WHERE page_id = ? AND user_id = ? AND date = ?', now, r.page_id, r.user_id, r.date);
      const page = getPageRow(db, r.page_id);
      const role = page ? roleOf(db, r.user_id, page.workspace_id) : null;
      if (!page || !role || page.trashed_at !== null || !canSeePage(r.user_id, role, page, db)) return;
      const id = notify(ctx, { userId: r.user_id, workspaceId: page.workspace_id, type: 'reminder', actorId: null, pageId: page.id, date: r.date, excerpt: page.title });
      if (id) created++;
    });
  }
  return created;
}

const DIGEST_META = 'collab_last_digest';

/** Sends the daily digests once per day after DIGEST_HOUR (Paris). */
export async function runDigestIfDue(ctx: AppContext, now = Date.now()): Promise<number> {
  const clock = parisClock(now);
  if (clock.hour < DIGEST_HOUR) return 0;
  if (ctx.db.getMeta(DIGEST_META) === clock.date) return 0;
  ctx.db.setMeta(DIGEST_META, clock.date);
  return sendDigests(ctx, now);
}

export function cleanupNotifications(ctx: AppContext, now = Date.now()): number {
  const { db } = ctx;
  return (
    db.run('DELETE FROM collab_notifications WHERE created_at < ?', now - 180 * DAY) +
    db.run('DELETE FROM collab_notifications WHERE archived_at IS NOT NULL AND archived_at < ?', now - 60 * DAY) +
    db.run('DELETE FROM collab_password_resets WHERE expires_at < ?', now - DAY) +
    cleanupInviteMails(db, now)
  );
}

export async function runCollabJobs(ctx: AppContext, now = Date.now()): Promise<{ reminders: number; digests: number }> {
  const reminders = runReminders(ctx, now) + runPropertyReminders(ctx, now);
  const digests = await runDigestIfDue(ctx, now);
  return { reminders, digests };
}

export function startCollabJobTimers(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runCollabJobs(ctx)
      .then((r) => {
        if (r.reminders || r.digests) log(`collab : ${r.reminders} rappel(s), ${r.digests} résumé(s) envoyés`);
      })
      .catch((err) => log('collab: tâche périodique en échec', err))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 15_000);
  const interval = setInterval(tick, 60_000);
  const cleanup = setInterval(() => {
    try {
      cleanupNotifications(ctx);
    } catch (err) {
      log('collab: nettoyage en échec', err);
    }
  }, 6 * 60 * 60 * 1000);
  first.unref();
  interval.unref();
  cleanup.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
    clearInterval(cleanup);
  };
}
