// Page reading routes (SPEC §13): hover preview and recent activity. Read-only; access goes through
// requirePage, so an invisible page answers 404 exactly like a missing one (no existence leak).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PAGE_ACTIVITY_LIMIT,
  PAGE_PREVIEW_EXCERPT_CHARS,
  type PageActivityEvent,
  type PageActivityResponse,
  type PagePreviewResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { requirePage, roleAtLeast } from '../access.js';
import { parseJson, toPublicUser, type UserRow } from '../db/rows.js';
import { idParam, parse, requireAuth } from '../http.js';

const pidParams = z.object({ pid: idParam });

/** First lines of a stored document text, collapsed to one line and cut on a word boundary. */
export function makeExcerpt(text: string, max = PAGE_PREVIEW_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function registerReadingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/pages/:pid/preview', async (req): Promise<PagePreviewResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const { page } = requirePage(db, user.id, pid);
    const trashed = page.trashed_at !== null;
    let excerpt = '';
    if (!trashed && page.kind === 'page') {
      // Rows of a database carry their text in the same table; databases themselves have none.
      const row = db.get<{ text: string }>('SELECT text FROM documents WHERE page_id = ?', page.id);
      excerpt = makeExcerpt(row?.text ?? '');
    }
    return {
      id: page.id,
      workspaceId: page.workspace_id,
      kind: page.kind,
      title: page.title,
      icon: page.icon,
      excerpt,
      updatedAt: page.updated_at,
      trashed,
    };
  });

  app.get('/api/pages/:pid/activity', async (req): Promise<PageActivityResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const { page, role } = requirePage(db, user.id, pid);

    const userCache = new Map<string, UserRow | undefined>();
    const userOf = (id: string | null | undefined) => {
      if (!id) return null;
      if (!userCache.has(id)) userCache.set(id, db.get<UserRow>('SELECT * FROM users WHERE id = ?', id));
      const row = userCache.get(id);
      return row ? toPublicUser(row) : null;
    };

    const events: PageActivityEvent[] = [];
    events.push({ kind: 'created', at: page.created_at, user: userOf(page.created_by) });
    // The last save, unless it is the creation itself.
    if (page.updated_at > page.created_at) events.push({ kind: 'edited', at: page.updated_at, user: userOf(page.updated_by) });

    // Versions are part of the history, reserved to members (requirePageHistory, QA-G6-04).
    const snapshots = roleAtLeast(role, 'member')
      ? db.all<{ created_at: number; authors: string }>(
          'SELECT created_at, authors FROM snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT ?',
          page.id,
          PAGE_ACTIVITY_LIMIT,
        )
      : [];
    for (const s of snapshots) {
      const authors = parseJson<string[]>(s.authors, []);
      events.push({ kind: 'version', at: s.created_at, user: userOf(authors[0]) });
    }

    const comments = db.all<{ created_at: number; user_id: string }>(
      `SELECT c.created_at, c.user_id FROM collab_comments c JOIN collab_threads t ON t.id = c.thread_id
       WHERE t.page_id = ? ORDER BY c.created_at DESC LIMIT ?`,
      page.id,
      PAGE_ACTIVITY_LIMIT,
    );
    for (const c of comments) events.push({ kind: 'comment', at: c.created_at, user: userOf(c.user_id) });

    const resolved = db.all<{ resolved_at: number; resolved_by: string | null }>(
      'SELECT resolved_at, resolved_by FROM collab_threads WHERE page_id = ? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?',
      page.id,
      PAGE_ACTIVITY_LIMIT,
    );
    for (const r of resolved) events.push({ kind: 'resolved', at: r.resolved_at, user: userOf(r.resolved_by) });

    events.sort((a, b) => b.at - a.at);
    return { events: events.slice(0, PAGE_ACTIVITY_LIMIT) };
  });
}
