// Recurring row templates (I1): a template creates a row of its database on a schedule (Europe/Paris
// wall clock), as the person who set the recurrence. Each occurrence is claimed in
// `database_template_runs` (primary key template + occurrence) in the same transaction as the row it
// creates: an occurrence never yields two rows, even when the server restarts or two processes share the
// database. After downtime, only one catch-up row is created and the schedule moves to the future.
import { nextOccurrence, recurrenceProblem, type TemplateRecurrence, type TemplateRecurrenceInfo } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { PAGE_COLUMNS, parseJson, type PageRow } from '../db/rows.js';
import { badRequest, notFound } from '../errors.js';
import { pageAccess } from '../access.js';
import { parisClock } from '../collab/time.js';
import { isTemplate } from './databases.js';
import { duplicatePage } from './pages.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** Current moment as 'YYYY-MM-DDTHH:MM' in Europe/Paris (the key space of occurrences). */
export function parisMoment(now = Date.now()): string {
  const c = parisClock(now);
  return `${c.date}T${pad(c.hour)}:${pad(c.minute)}`;
}

interface RecurrenceRow {
  template_id: string;
  database_id: string;
  config: string;
  next_run: string | null;
  actor_id: string;
  last_run_at: number | null;
  last_row_id: string | null;
  last_error: string | null;
}

const toInfo = (r: RecurrenceRow): TemplateRecurrenceInfo => ({
  templateId: r.template_id,
  recurrence: parseJson<TemplateRecurrence>(r.config, {} as TemplateRecurrence),
  nextRun: r.next_run,
  lastRunAt: r.last_run_at,
  lastRowId: r.last_row_id,
  lastError: r.last_error,
});

/** Recurrences of the (non-trashed) templates of a database. */
export function listRecurrences(db: Db, databaseId: string): TemplateRecurrenceInfo[] {
  return db
    .all<RecurrenceRow>(
      `SELECT r.* FROM database_template_recurrences r JOIN pages p ON p.id = r.template_id
       WHERE r.database_id = ? AND p.trashed_at IS NULL ORDER BY p.position, p.id`,
      databaseId,
    )
    .map(toInfo);
}

/**
 * Sets (or with null, stops) the recurrence of a template of `databaseId`. The rows will be created as
 * `actorId`, the editor who sets it. Access checks are the caller's.
 */
export function setRecurrence(db: Db, databaseId: string, templateId: string, actorId: string, recurrence: TemplateRecurrence | null, now = Date.now()): void {
  const template = db.get<{ parent_id: string; parent_type: string }>('SELECT parent_id, parent_type FROM pages WHERE id = ? AND trashed_at IS NULL', templateId);
  if (!template || template.parent_type !== 'database' || template.parent_id !== databaseId || !isTemplate(db, templateId)) {
    throw notFound('Modèle introuvable.');
  }
  if (!recurrence) {
    db.run('DELETE FROM database_template_recurrences WHERE template_id = ?', templateId);
    return;
  }
  const clean: TemplateRecurrence = {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    startDate: recurrence.startDate,
    time: recurrence.time,
    ...(recurrence.frequency === 'weekly' && recurrence.weekdays?.length ? { weekdays: [...new Set(recurrence.weekdays)].sort((a, b) => a - b) } : {}),
    ...(recurrence.endDate ? { endDate: recurrence.endDate } : {}),
  };
  const problem = recurrenceProblem(clean);
  if (problem) throw badRequest(problem);
  db.run(
    `INSERT INTO database_template_recurrences (template_id, database_id, config, next_run, actor_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(template_id) DO UPDATE SET config = excluded.config, next_run = excluded.next_run,
       actor_id = excluded.actor_id, last_error = NULL, updated_at = excluded.updated_at`,
    templateId,
    databaseId,
    JSON.stringify(clean),
    nextOccurrence(clean, parisMoment(now)),
    actorId,
    now,
  );
}

/** Why an occurrence cannot create its row, or null. */
function runProblem(db: Db, r: RecurrenceRow): string | null {
  const template = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, r.template_id);
  if (!template || template.trashed_at !== null || !isTemplate(db, r.template_id)) return 'Le modèle est dans la corbeille.';
  const database = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, r.database_id);
  if (!database || database.trashed_at !== null) return 'La base de données est dans la corbeille.';
  const access = pageAccess(db, r.actor_id, r.database_id);
  if (!access?.canEdit) return "La personne qui a programmé ce modèle ne peut plus modifier la base.";
  return null;
}

/** Creates the rows of the due occurrences; returns how many rows were created. */
export function runTemplateRecurrences(ctx: AppContext, now = Date.now(), log?: (msg: string, err?: unknown) => void): number {
  const { db } = ctx;
  const moment = parisMoment(now);
  const due = db.all<RecurrenceRow>('SELECT * FROM database_template_recurrences WHERE next_run IS NOT NULL AND next_run <= ?', moment);
  let created = 0;
  for (const candidate of due) {
    const occurrence = candidate.next_run!;
    const recurrence = parseJson<TemplateRecurrence>(candidate.config, {} as TemplateRecurrence);
    const next = nextOccurrence(recurrence, moment);
    try {
      db.tx(() => {
        // Re-read inside the transaction: another process may have handled it meanwhile.
        const r = db.get<RecurrenceRow>('SELECT * FROM database_template_recurrences WHERE template_id = ? AND next_run = ?', candidate.template_id, occurrence);
        if (!r) return;
        const claimed = db.run(
          'INSERT OR IGNORE INTO database_template_runs (template_id, occurrence, row_id, created_at) VALUES (?, ?, NULL, ?)',
          r.template_id,
          occurrence,
          now,
        );
        let rowId: string | null = null;
        let error: string | null = null;
        if (claimed > 0) {
          error = runProblem(db, r);
          if (!error) {
            const template = db.get<{ title: string }>('SELECT title FROM pages WHERE id = ?', r.template_id)!;
            rowId = duplicatePage(ctx, r.actor_id, r.template_id, { title: template.title, position: { after: undefined }, asTemplate: false }).id;
            db.run('UPDATE database_template_runs SET row_id = ? WHERE template_id = ? AND occurrence = ?', rowId, r.template_id, occurrence);
            created++;
          }
        }
        db.run(
          `UPDATE database_template_recurrences SET next_run = ?, last_run_at = COALESCE(?, last_run_at),
             last_row_id = COALESCE(?, last_row_id), last_error = ? WHERE template_id = ?`,
          next,
          rowId ? now : null,
          rowId,
          claimed > 0 ? error : r.last_error,
          r.template_id,
        );
      });
    } catch (err) {
      // The row could not be created: the occurrence is skipped (no retry loop every minute).
      log?.(`Modèle récurrent ${candidate.template_id} : création impossible`, err);
      db.run(
        'UPDATE database_template_recurrences SET next_run = ?, last_error = ? WHERE template_id = ? AND next_run = ?',
        next,
        'La création de la ligne a échoué.',
        candidate.template_id,
        occurrence,
      );
    }
  }
  return created;
}

const MINUTE = 60_000;

/** Background job: checks the due occurrences every minute (and once at startup). */
export function startTemplateRecurrenceJob(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  const tick = () => {
    try {
      runTemplateRecurrences(ctx, Date.now(), log);
    } catch (err) {
      log('Modèles récurrents : échec du passage', err);
    }
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, MINUTE);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
