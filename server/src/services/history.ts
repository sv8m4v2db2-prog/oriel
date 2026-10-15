// Version history (G6, SPEC « Historique des versions »): restores applied as collaborative edits,
// recovery of deleted blocks, title and values of a database row at a date.
import * as Y from 'yjs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  collabDocumentName,
  newId,
  type DeletedBlock,
  type DeletedBlocksResponse,
  type HistoryPropertiesResponse,
  type PropertyValue,
  type PublicUser,
  type RestoreBlockItem,
  type RestoreBlocksResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { requirePageHistory } from '../access.js';
import { visibleProperties } from './propertyAccess.js';
import { parseJson, toPublicUser, type UserRow } from '../db/rows.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { readPageState } from '../io/content.js';
import { docFromState, sameBytes } from '../content/ydoc.js';
import { blockMap, blockSummaries, reconcileDocument, restoreChosenBlocks } from '../content/restore.js';
import { loadSchema } from './databases.js';

const DAY = 24 * 60 * 60 * 1000;
/** Recovery window (SPEC): versions of the last 30 days, at most 60 of them, at most 200 blocks. */
export const RECOVERY_DAYS = 30;
export const RECOVERY_MAX_VERSIONS = 60;
export const RECOVERY_MAX_BLOCKS = 200;
/**
 * At most this much version data decoded per recovery list (QA-G6-03): each version is decoded in
 * full, synchronously; 60 versions of a large page blocked the instance for seconds per request.
 * The newest versions are scanned first, and at least one always is.
 */
export const RECOVERY_MAX_BYTES = 16 * 1024 * 1024;

export interface SnapshotRow {
  id: string;
  page_id: string;
  state: Uint8Array;
  created_at: number;
  authors: string;
  reason: string;
  restored_from: string | null;
}

export function getSnapshot(ctx: AppContext, pageId: string, snapshotId: string): SnapshotRow {
  const row = ctx.db.get<SnapshotRow>('SELECT * FROM snapshots WHERE id = ? AND page_id = ?', snapshotId, pageId);
  if (!row) throw notFound('Version introuvable.');
  return row;
}

/** Resolves user ids to public users (unknown ids are dropped). */
export function usersOf(ctx: AppContext, ids: string[]): PublicUser[] {
  const out: PublicUser[] = [];
  for (const id of [...new Set(ids)]) {
    const u = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (u) out.push(toPublicUser(u));
  }
  return out;
}

function hocuspocusOf(ctx: AppContext): Hocuspocus {
  const candidate = (ctx.collab as unknown as { hocuspocus?: unknown }).hocuspocus;
  if (candidate && typeof (candidate as Hocuspocus).openDirectConnection === 'function') return candidate as Hocuspocus;
  throw new HttpError(503, 'unavailable', 'Le service de collaboration est indisponible.');
}

/**
 * Applies `edit` to the live page document through a direct connection (connected editors get it
 * as a normal Yjs update), then records the previous state (`before-restore`) and the result
 * (`restore`, pointing at the restored version) as versions. Nothing is recorded when nothing changed.
 */
async function editLive<T>(ctx: AppContext, userId: string, pageId: string, snapshotId: string, edit: (doc: Y.Doc) => T): Promise<T> {
  const { db } = ctx;
  const direct = await hocuspocusOf(ctx).openDirectConnection(collabDocumentName(pageId), { userId, pageId });
  try {
    const doc = direct.document;
    if (!doc) throw new HttpError(503, 'unavailable', 'Document indisponible.');
    const before = Y.encodeStateAsUpdate(doc);
    let result!: T;
    await direct.transact((d) => {
      result = edit(d);
    });
    const after = Y.encodeStateAsUpdate(doc);
    if (!sameBytes(before, after)) {
      db.tx(() => {
        const now = Date.now();
        const existing = db.get<{ editors: string }>('SELECT editors FROM documents WHERE page_id = ?', pageId);
        db.run(
          "INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, ?, 'before-restore')",
          newId(),
          pageId,
          before,
          now,
          JSON.stringify(parseJson<string[]>(existing?.editors, [])),
        );
        db.run(
          "INSERT INTO snapshots (id, page_id, state, created_at, authors, reason, restored_from) VALUES (?, ?, ?, ?, ?, 'restore', ?)",
          newId(),
          pageId,
          after,
          now + 1,
          JSON.stringify([userId]),
          snapshotId,
        );
        db.run("UPDATE documents SET editors = '[]' WHERE page_id = ?", pageId);
      });
    }
    return result;
  } finally {
    // Persists synchronously (text, search index, links) and unloads when unused.
    await direct.disconnect();
  }
}

function requireRestorable(ctx: AppContext, userId: string, pageId: string) {
  const access = requirePageHistory(ctx.db, userId, pageId, 'edit');
  // Trashed pages are read-only (same rule as PUT /content; QA-INT-04).
  if (access.page.trashed_at !== null) throw badRequest('Restaurez la page avant de restaurer une version.');
  return access;
}

/** Brings the whole page back to a version, as a merged collaborative edit. */
export async function restoreWholePage(ctx: AppContext, userId: string, pageId: string, snapshotId: string): Promise<void> {
  requireRestorable(ctx, userId, pageId);
  const row = getSnapshot(ctx, pageId, snapshotId);
  const source = docFromState(row.state);
  try {
    await editLive(ctx, userId, pageId, snapshotId, (d) => reconcileDocument(d, source));
  } finally {
    source.destroy();
  }
}

/** Reinserts deleted blocks or reverts modified ones from a version. */
export async function restoreBlocks(
  ctx: AppContext,
  userId: string,
  pageId: string,
  snapshotId: string,
  items: RestoreBlockItem[],
): Promise<RestoreBlocksResponse> {
  requireRestorable(ctx, userId, pageId);
  const row = getSnapshot(ctx, pageId, snapshotId);
  const source = docFromState(row.state);
  try {
    return await editLive(ctx, userId, pageId, snapshotId, (d) => ({ ok: true as const, ...restoreChosenBlocks(d, source, items) }));
  } finally {
    source.destroy();
  }
}

/** Blocks of the recent versions that the current content no longer has (SPEC « Récupération »). */
export function deletedBlocks(ctx: AppContext, userId: string, pageId: string, now = Date.now()): DeletedBlocksResponse {
  const { db } = ctx;
  requirePageHistory(db, userId, pageId);
  const currentDoc = docFromState(readPageState(ctx, pageId));
  const current = new Set(blockMap(currentDoc).keys());
  currentDoc.destroy();
  const versions = db.all<Omit<SnapshotRow, 'state'> & { size: number }>(
    'SELECT id, page_id, created_at, authors, reason, restored_from, length(state) AS size FROM snapshots WHERE page_id = ? AND created_at >= ? ORDER BY created_at DESC, id LIMIT ?',
    pageId,
    now - RECOVERY_DAYS * DAY,
    RECOVERY_MAX_VERSIONS,
  );
  let budget = RECOVERY_MAX_BYTES;
  let scanned = 0;
  const editors = parseJson<string[]>(db.get<{ editors: string }>('SELECT editors FROM documents WHERE page_id = ?', pageId)?.editors, []);
  const found = new Map<string, DeletedBlock>();
  let truncated = false;
  // Newest first: the first version holding a block is the last one before its deletion.
  let newer: { at: number; authors: string[] } | null = null;
  for (const row of versions) {
    if (scanned > 0 && row.size > budget) break;
    budget -= row.size;
    scanned++;
    let doc: Y.Doc | null = null;
    try {
      const state = db.get<{ state: Uint8Array }>('SELECT state FROM snapshots WHERE id = ?', row.id)?.state;
      doc = docFromState(state);
      const blocks = blockSummaries(doc);
      const gone = [...blocks.values()].filter((b) => !current.has(b.id));
      const goneIds = new Set(gone.map((b) => b.id));
      const children = new Map<string, string[]>();
      for (const x of gone) if (x.parentId) children.set(x.parentId, [...(children.get(x.parentId) ?? []), x.id]);
      for (const b of gone) {
        if (found.has(b.id)) continue;
        // Nested blocks are listed under their deleted ancestor.
        if (b.parentId && goneIds.has(b.parentId)) continue;
        let childCount = 0;
        const stack = [b.id];
        while (stack.length > 0) {
          for (const c of children.get(stack.pop()!) ?? []) {
            childCount++;
            stack.push(c);
          }
        }
        // An empty paragraph is noise, not a loss.
        if (!b.text.trim() && childCount === 0 && (b.type === 'paragraph' || b.type === 'blockContainer')) continue;
        if (found.size >= RECOVERY_MAX_BLOCKS) {
          truncated = true;
          break;
        }
        const n = newer as { at: number; authors: string[] } | null;
        found.set(b.id, {
          blockId: b.id,
          type: b.type,
          text: b.text,
          childCount,
          snapshotId: row.id,
          snapshotAt: row.created_at,
          deletedBefore: n ? n.at : null,
          deletedBy: usersOf(ctx, n ? n.authors : editors),
        });
      }
    } catch {
      // An unreadable version is skipped (legacy content), the others still count.
    } finally {
      doc?.destroy();
    }
    newer = { at: row.created_at, authors: parseJson<string[]>(row.authors, []) };
    if (truncated) break;
  }
  return { blocks: [...found.values()], scanned, truncated };
}

/** Title and visible values of a database row at a date (current state when `at` is absent). */
export function propertiesAt(ctx: AppContext, userId: string, pageId: string, at?: number): HistoryPropertiesResponse {
  const { db } = ctx;
  const { page, role } = requirePageHistory(db, userId, pageId);
  if (page.parent_type !== 'database') return { row: false, known: true, title: page.title, values: {}, changedAt: null, changedBy: null };
  const visible = visibleProperties(db, loadSchema(db, page.parent_id).properties, role); // QA-G3-03: mirrors too
  const pick = (json: string) => {
    const all = parseJson<Record<string, PropertyValue>>(json, {});
    const out: Record<string, PropertyValue> = {};
    for (const d of visible) if (d.id in all) out[d.id] = all[d.id]!;
    return out;
  };
  const by = (id: string | null) => (id ? (usersOf(ctx, [id])[0] ?? null) : null);
  if (at === undefined) {
    return { row: true, known: true, title: page.title, values: pick(page.properties), changedAt: page.updated_at, changedBy: by(page.updated_by) };
  }
  const rec = db.get<{ title: string; properties: string; created_at: number; user_id: string | null }>(
    'SELECT title, properties, created_at, user_id FROM history_props WHERE page_id = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1',
    pageId,
    at,
  );
  if (rec) return { row: true, known: true, title: rec.title, values: pick(rec.properties), changedAt: rec.created_at, changedBy: by(rec.user_id) };
  // Never changed since the history started: the current state holds if it predates `at`.
  const any = db.get('SELECT 1 AS x FROM history_props WHERE page_id = ? LIMIT 1', pageId);
  if (!any && page.updated_at <= at) {
    return { row: true, known: true, title: page.title, values: pick(page.properties), changedAt: page.updated_at, changedBy: by(page.updated_by) };
  }
  return { row: true, known: false, title: '', values: {}, changedAt: null, changedBy: null };
}
