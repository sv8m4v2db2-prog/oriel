// Synced blocks (editor module): which pages show which synced block. Tables of the feature
// migration `editor-003-synced-blocks` (db/features/editor.ts).
import type { Db } from '../db/index.js';

/**
 * Replaces the synced blocks recorded for a page by `ids` (from extractContent / remapState). Only
 * blocks of the page's own workspace are recorded: a reference copied from another workspace is
 * never resolved (AI reader, lists of pages).
 */
export function recordSyncedRefs(db: Db, pageId: string, workspaceId: string, ids: readonly string[]): void {
  db.run('DELETE FROM editor_synced_refs WHERE page_id = ?', pageId);
  for (const id of ids) {
    db.run(
      'INSERT OR IGNORE INTO editor_synced_refs (synced_id, page_id) SELECT id, ? FROM editor_synced_blocks WHERE id = ? AND workspace_id = ?',
      pageId,
      id,
      workspaceId,
    );
  }
}
