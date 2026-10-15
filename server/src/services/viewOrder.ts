// Manual order of the rows per view (I1). Each view — native or of a linked block — keeps its own
// fractional indexes in `database_view_row_order`; a row absent from it falls back to its page position
// (same key space, so both compare directly). Dragging a row in a view writes that view only. A sort of
// the view takes precedence on the client; the server only stores the manual order.
import { positionForInsert, positionsBetween, sortByPosition, type Positioned } from '@oriel/shared';
import type { Db } from '../db/index.js';
import { notFound } from '../errors.js';

/** Rows of a database that may appear in its views (live, row templates excluded). */
function liveRows(db: Db, databaseId: string): Positioned[] {
  return db.all<Positioned>(
    `SELECT id, position FROM pages WHERE parent_type = 'database' AND parent_id = ? AND trashed_at IS NULL
       AND id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)`,
    databaseId,
    databaseId,
  );
}

/**
 * Stored manual order of `viewIds` (view id → row id → index). Only rows still in the database and not
 * templates are listed: live ones, plus those trashed with the database when it is itself in the trash.
 */
export function viewRowOrders(db: Db, databaseId: string, viewIds: string[], databaseTrashedAt: number | null = null): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (viewIds.length === 0) return out;
  const rows = db.all<{ view_id: string; page_id: string; position: string }>(
    `SELECT o.view_id, o.page_id, o.position FROM database_view_row_order o JOIN pages p ON p.id = o.page_id
     WHERE o.view_id IN (${viewIds.map(() => '?').join(',')})
       AND p.parent_type = 'database' AND p.parent_id = ? AND (p.trashed_at IS NULL OR p.trashed_at = ?)
       AND p.id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)`,
    ...viewIds,
    databaseId,
    databaseTrashedAt ?? -1,
    databaseId,
  );
  for (const r of rows) {
    let m = out.get(r.view_id);
    if (!m) out.set(r.view_id, (m = {}));
    m[r.page_id] = r.position;
  }
  return out;
}

const upsert = (db: Db, viewId: string, pageId: string, position: string) =>
  db.run(
    `INSERT INTO database_view_row_order (view_id, page_id, position) VALUES (?, ?, ?)
     ON CONFLICT(view_id, page_id) DO UPDATE SET position = excluded.position`,
    viewId,
    pageId,
    position,
  );

/**
 * Places `rowId` right after `after` (null = first; an unknown id = last) in the order of `viewId`.
 * Equal or malformed keys (imported positions) are renumbered for the whole view first. Returns the
 * view's order. Must run inside a transaction, after the access checks.
 */
export function moveRowInView(db: Db, databaseId: string, viewId: string, rowId: string, after: string | null): Record<string, string> {
  const rows = liveRows(db, databaseId);
  if (!rows.some((r) => r.id === rowId)) throw notFound('Ligne introuvable.');
  const stored = viewRowOrders(db, databaseId, [viewId]).get(viewId) ?? {};
  const effective = rows.map((r) => ({ id: r.id, position: stored[r.id] ?? r.position }));
  let position: string;
  try {
    position = positionForInsert(effective, after === rowId ? undefined : after, rowId);
  } catch {
    const sorted = sortByPosition(effective);
    const keys = positionsBetween(null, null, sorted.length);
    sorted.forEach((r, i) => {
      r.position = keys[i]!;
      upsert(db, viewId, r.id, r.position);
    });
    position = positionForInsert(sorted, after === rowId ? undefined : after, rowId);
  }
  upsert(db, viewId, rowId, position);
  return viewRowOrders(db, databaseId, [viewId]).get(viewId) ?? {};
}

/** Copies the order of a view to another one (duplicated view, copied block); `idMap` renames the rows. */
export function copyViewRowOrder(db: Db, fromViewId: string, toViewId: string, idMap?: ReadonlyMap<string, string>): void {
  for (const r of db.all<{ page_id: string; position: string }>('SELECT page_id, position FROM database_view_row_order WHERE view_id = ?', fromViewId)) {
    const pageId = idMap?.get(r.page_id) ?? r.page_id;
    // Only rows of the target view's database (a row left out of a copy keeps its original database).
    const isRow = db.get(
      `SELECT 1 AS x FROM pages p JOIN views v ON v.id = ? WHERE p.id = ? AND p.parent_type = 'database' AND p.parent_id = v.database_id`,
      toViewId,
      pageId,
    );
    if (isRow) upsert(db, toViewId, pageId, r.position);
  }
}
