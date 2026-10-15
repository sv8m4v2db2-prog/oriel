// Hourly maintenance: purge old trash, expired sessions/invites and expired snapshots.
import { LIMITS } from '@oriel/shared';
import type { AppContext } from './context.js';
import { PAGE_COLUMNS, type PageRow } from './db/rows.js';
import { deleteSubtree } from './services/pages.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function runMaintenance(ctx: AppContext, now = Date.now()): { pages: number; sessions: number; snapshots: number } {
  const { db } = ctx;
  const cutoff = now - LIMITS.trashRetentionDays * DAY;
  const roots = db.all<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE trashed_at IS NOT NULL AND trashed_at < ?
       AND (trash_root = 1 OR parent_type = 'workspace'
            OR parent_id NOT IN (SELECT id FROM pages WHERE trashed_at IS NOT NULL))`,
    cutoff,
  );
  let pages = 0;
  for (const root of roots) {
    db.tx(() => {
      if (!db.get('SELECT 1 AS x FROM pages WHERE id = ?', root.id)) return; // removed with an earlier subtree
      pages += deleteSubtree(ctx, root).length;
    });
  }
  const sessions = db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
  db.run('DELETE FROM invites WHERE expires_at < ? OR (revoked = 1 AND created_at < ?)', now - 30 * DAY, now - 30 * DAY);
  const snapshots =
    db.run("DELETE FROM snapshots WHERE reason = 'auto' AND created_at < ?", now - 30 * DAY) +
    // Restore checkpoints (G6, SPEC « Fréquence et rétention des versions »): 90 days.
    db.run("DELETE FROM snapshots WHERE reason IN ('before-restore', 'restore') AND created_at < ?", now - 90 * DAY) +
    db.run("DELETE FROM snapshots WHERE reason = 'daily' AND created_at < ?", now - 365 * DAY);
  // Title and values of database rows over time (G6): 1 year, the latest record of each row kept.
  db.run(
    'DELETE FROM history_props WHERE created_at < ? AND id NOT IN (SELECT MAX(id) FROM history_props GROUP BY page_id)',
    now - 365 * DAY,
  );
  ctx.authLimiter.prune(now);
  return { pages, sessions, snapshots };
}

export function startJobs(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  const run = () => {
    try {
      const r = runMaintenance(ctx);
      if (r.pages || r.sessions || r.snapshots) {
        log(`maintenance: ${r.pages} page(s), ${r.sessions} session(s), ${r.snapshots} instantané(s) purgés`);
      }
    } catch (err) {
      log('maintenance failed', err);
    }
  };
  const first = setTimeout(run, 10_000);
  const interval = setInterval(run, HOUR);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
