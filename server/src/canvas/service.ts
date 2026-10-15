// Canvas pages (H1), server side. A canvas is a page: creation, rights, sharing, trash and
// duplication go through services/pages.ts; this module only adds what differs.
import type { AppContext } from '../context.js';
import { requirePageHistory } from '../access.js';
import { badRequest, notFound } from '../errors.js';

/** Icon given to a new canvas when the creator chose none (changeable like any page icon). */
export const CANVAS_DEFAULT_ICON = '🎨';

/** Brings a canvas back to a version: its objects replace the live ones, as a collaborative edit. */
export async function restoreCanvasVersion(ctx: AppContext, userId: string, pageId: string, snapshotId: string): Promise<void> {
  const { page } = requirePageHistory(ctx.db, userId, pageId, 'edit');
  if (page.trashed_at !== null) throw badRequest('Restaurez la page avant de restaurer une version.');
  const row = ctx.db.get<{ state: Uint8Array }>('SELECT state FROM snapshots WHERE id = ? AND page_id = ?', snapshotId, pageId);
  if (!row) throw notFound('Version introuvable.');
  await ctx.collab.restoreSnapshot(pageId, row.state, userId);
}
