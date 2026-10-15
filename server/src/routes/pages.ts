import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  BacklinksResponse,
  PageDetailResponse,
  SnapshotMeta,
  SnapshotResponse,
  SnapshotsResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { parseJson, toCrumb, toPublicUser, type DatabaseRow, type PageRow, type UserRow } from '../db/rows.js';
import { notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { isPubliclyVisible, requirePage, requirePageHistory, visiblePageClause, visiblePageParams } from '../access.js';
import { restoreWholePage } from '../services/history.js';
import { createPageSchema, favoriteSchema, movePageSchema, publishSchema, updatePageSchema } from '../schemas.js';
import {
  createPage,
  destroyPage,
  duplicatePage,
  movePage,
  restorePage,
  setFavorite,
  setPublic,
  trashPage,
  updatePage,
} from '../services/pages.js';
import { ancestorsCrumbs } from '../services/search.js';
import { recordMemberView } from '../services/navigation.js';
import { pageFor, pageForUser, schemaFor } from '../services/propertyAccess.js';
import { getPageRow } from '../access.js';
import { isCanvasRow } from '../canvas/content.js';
import { restoreCanvasVersion } from '../canvas/service.js';

const widParams = z.object({ wid: idParam });
const pidParams = z.object({ pid: idParam });
const snapParams = z.object({ pid: idParam, sid: idParam });
/** Canvas module (H1): `layout: 'canvas'` creates a whiteboard page. */
const createPageWithLayoutSchema = createPageSchema.extend({ layout: z.literal('canvas').optional() });

interface SnapshotRow {
  id: string;
  page_id: string;
  state: Uint8Array;
  created_at: number;
  authors: string;
  reason: SnapshotMeta['reason'];
  restored_from?: string | null;
}

export function snapshotMeta(ctx: AppContext, rows: Array<Omit<SnapshotRow, 'state'>>): SnapshotMeta[] {
  const userCache = new Map<string, UserRow | undefined>();
  const userOf = (id: string) => {
    if (!userCache.has(id)) userCache.set(id, ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id));
    return userCache.get(id);
  };
  // Restore versions (G6): date of the restored version, when it still exists.
  const restoredFrom = (r: Omit<SnapshotRow, 'state'>) => {
    const src = ctx.db.get<{ id: string; created_at: number }>('SELECT id, created_at FROM snapshots WHERE id = ? AND page_id = ?', r.restored_from, r.page_id);
    return src ? { id: src.id, createdAt: src.created_at } : null;
  };
  return rows.map((r) => ({
    id: r.id,
    pageId: r.page_id,
    createdAt: r.created_at,
    reason: r.reason,
    ...(r.restored_from ? { restoredFrom: restoredFrom(r) } : {}),
    authors: parseJson<string[]>(r.authors, [])
      .map(userOf)
      .filter((u): u is UserRow => !!u)
      .map(toPublicUser),
  }));
}

export function registerPageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.post('/api/workspaces/:wid/pages', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(createPageWithLayoutSchema, req.body);
    return pageForUser(db, user.id, createPage(ctx, user.id, wid, body));
  });

  app.get('/api/pages/:pid', async (req): Promise<PageDetailResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const { page, role, canEdit } = requirePage(db, user.id, pid);
    // `?visit=0`: metadata lookup (e.g. labelling a link to a database row) — not a visit.
    if ((req.query as { visit?: unknown } | undefined)?.visit !== '0') {
      // Navigation module: daily view counter (once per person per half hour).
      const previous = db.get<{ visited_at: number }>('SELECT visited_at FROM visits WHERE user_id = ? AND page_id = ?', user.id, page.id);
      recordMemberView(db, page.id, previous?.visited_at ?? null);
      db.run(
        `INSERT INTO visits (user_id, page_id, workspace_id, visited_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, page_id) DO UPDATE SET visited_at = excluded.visited_at`,
        user.id,
        page.id,
        page.workspace_id,
        Date.now(),
      );
    }
    let parentDatabase = null;
    if (page.parent_type === 'database') {
      const row = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', page.parent_id);
      if (row) parentDatabase = schemaFor(db, row, page.workspace_id, role);
    }
    const isFavorite = !!db.get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND page_id = ?', user.id, page.id);
    return {
      page: pageFor(db, role, page),
      ancestors: ancestorsCrumbs(db, page.id),
      role,
      canEdit,
      isFavorite,
      parentDatabase,
      publiclyVisible: isPubliclyVisible(db, page.id),
    };
  });

  app.patch('/api/pages/:pid', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(updatePageSchema, req.body);
    return pageForUser(db, user.id, updatePage(ctx, user.id, pid, body));
  });

  app.post('/api/pages/:pid/move', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(movePageSchema, req.body);
    return pageForUser(db, user.id, movePage(ctx, user.id, pid, body));
  });

  app.post('/api/pages/:pid/duplicate', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    return pageForUser(db, user.id, duplicatePage(ctx, user.id, pid));
  });

  app.post('/api/pages/:pid/trash', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    trashPage(ctx, user.id, pid);
    return { ok: true as const };
  });

  app.post('/api/pages/:pid/restore', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    return pageForUser(db, user.id, restorePage(ctx, user.id, pid));
  });

  app.delete('/api/pages/:pid', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    destroyPage(ctx, user.id, pid);
    return { ok: true as const };
  });

  app.post('/api/pages/:pid/publish', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(publishSchema, req.body);
    return pageForUser(db, user.id, setPublic(ctx, user.id, pid, body.isPublic));
  });

  app.put('/api/pages/:pid/favorite', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(favoriteSchema, req.body);
    return { favorites: setFavorite(ctx, user.id, pid, body.favorite, body.after) };
  });

  app.get('/api/pages/:pid/backlinks', async (req): Promise<BacklinksResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const { page } = requirePage(db, user.id, pid);
    const rows = db.all<PageRow>(
      `SELECT p.* FROM page_links l JOIN pages p ON p.id = l.source_id
       WHERE l.target_id = ? AND p.id != ? AND p.workspace_id = ? AND p.trashed_at IS NULL
         AND ${visiblePageClause('p')}
       ORDER BY p.title, p.id`,
      page.id,
      page.id,
      page.workspace_id,
      ...visiblePageParams(user.id),
    );
    return { pages: rows.map(toCrumb) };
  });

  // --- snapshots ---------------------------------------------------------------

  app.get('/api/pages/:pid/snapshots', async (req): Promise<SnapshotsResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    requirePageHistory(db, user.id, pid);
    const rows = db.all<Omit<SnapshotRow, 'state'>>(
      'SELECT id, page_id, created_at, authors, reason, restored_from FROM snapshots WHERE page_id = ? ORDER BY created_at DESC, id LIMIT 500',
      pid,
    );
    return { snapshots: snapshotMeta(ctx, rows) };
  });

  app.get('/api/pages/:pid/snapshots/:sid', async (req): Promise<SnapshotResponse> => {
    const { user } = requireAuth(req);
    const { pid, sid } = parse(snapParams, req.params);
    requirePageHistory(db, user.id, pid);
    const row = db.get<SnapshotRow>('SELECT * FROM snapshots WHERE id = ? AND page_id = ?', sid, pid);
    if (!row) throw notFound('Version introuvable.');
    const [meta] = snapshotMeta(ctx, [row]);
    return { snapshot: meta!, update: Buffer.from(row.state).toString('base64') };
  });

  app.post('/api/pages/:pid/snapshots/:sid/restore', async (req) => {
    const { user } = requireAuth(req);
    const { pid, sid } = parse(snapParams, req.params);
    // Merged into the live document (G6): access, trash rule and versions in services/history.ts.
    // A canvas restores its objects (H1); both paths check access (invisible page: 404).
    if (isCanvasRow(getPageRow(db, pid))) await restoreCanvasVersion(ctx, user.id, pid, sid);
    else await restoreWholePage(ctx, user.id, pid, sid);
    return { ok: true as const };
  });
}
