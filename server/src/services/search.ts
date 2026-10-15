// Full-text index maintenance and search (FTS5 table `search`).
import { createHash } from 'node:crypto';
import type { Crumb, SearchResult } from '@oriel/shared';
import type { Db } from '../db/index.js';
import { toCrumb, toTreeNode, type PageRow } from '../db/rows.js';
import { visiblePageClause, visiblePageParams } from '../access.js';

/**
 * Stable FTS rowid derived from the page id (52-bit hash) so that updates hit the row directly
 * instead of scanning the UNINDEXED page_id column; stays valid across VACUUM.
 */
export function ftsRowid(pageId: string): number {
  const h = createHash('sha256').update(pageId).digest();
  return (h.readUIntBE(0, 6) * 16 + (h[6]! >> 4)) || 1;
}

export function removeFromIndex(db: Db, pageId: string): void {
  db.run('DELETE FROM search WHERE rowid = ? AND page_id = ?', ftsRowid(pageId), pageId);
}

/** (Re)indexes a page. `body` defaults to the stored document text. */
export function indexPage(db: Db, page: Pick<PageRow, 'id' | 'workspace_id' | 'title'>, body?: string): void {
  const text = body ?? db.get<{ text: string }>('SELECT text FROM documents WHERE page_id = ?', page.id)?.text ?? '';
  const rowid = ftsRowid(page.id);
  db.run('DELETE FROM search WHERE rowid = ?', rowid);
  db.run('INSERT INTO search (rowid, page_id, workspace_id, title, body) VALUES (?, ?, ?, ?, ?)', rowid, page.id, page.workspace_id, page.title, text);
}

/** Builds a safe FTS5 query: every term quoted and prefix-matched, implicitly AND-ed. */
export function buildFtsQuery(input: string): string | null {
  const terms = input
    .normalize('NFC')
    .split(/[\s"'’«»“”()[\]{}:;,.!?*^+\-–—/\\|<>=~`@#&%$]+/u)
    .map((t) => t.trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export function ancestorsCrumbs(db: Db, pageId: string): Crumb[] {
  return db
    .all<Pick<PageRow, 'id' | 'title' | 'icon' | 'kind'> & { depth: number }>(
      `WITH RECURSIVE anc(id, parent_type, parent_id, depth) AS (
         SELECT id, parent_type, parent_id, 0 FROM pages WHERE id = ?
         UNION
         SELECT p.id, p.parent_type, p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id
         WHERE anc.parent_type != 'workspace' AND anc.depth < 10000
       )
       SELECT p.id, p.title, p.icon, p.kind, anc.depth FROM anc JOIN pages p ON p.id = anc.id
       WHERE anc.depth > 0 ORDER BY anc.depth DESC`,
      pageId,
    )
    .map(toCrumb);
}

export function searchPages(db: Db, userId: string, workspaceId: string, q: string, limit: number): SearchResult[] {
  const query = buildFtsQuery(q);
  if (!query) return [];
  let rows: Array<PageRow & { snippet: string }>;
  try {
    rows = db.all<PageRow & { snippet: string }>(
      `SELECT p.*, snippet(search, 3, '[[', ']]', '…', 16) AS snippet
       FROM search JOIN pages p ON p.id = search.page_id
       WHERE search MATCH ? AND search.workspace_id = ? AND p.workspace_id = ?
         AND p.trashed_at IS NULL AND ${visiblePageClause('p')}
       ORDER BY bm25(search, 0.0, 0.0, 8.0, 1.0)
       LIMIT ?`,
      query,
      workspaceId,
      workspaceId,
      ...visiblePageParams(userId),
      limit,
    );
  } catch {
    return [];
  }
  return rows.map((r) => ({
    page: { ...toTreeNode(r), workspaceId: r.workspace_id },
    path: ancestorsCrumbs(db, r.id),
    snippet: r.snippet.includes('[[') ? r.snippet.replace(/\s+/g, ' ').trim() : '',
  }));
}
