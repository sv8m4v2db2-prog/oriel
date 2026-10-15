// Feature migrations of the "editor" module. Append entries; never edit an applied one.
// Each id must be unique across all modules (prefix it with "editor-").
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    // Page templates: listed in the sidebar "Modèles" section, instantiated by deep copy.
    id: 'editor-001-page-templates',
    sql: `
      ALTER TABLE pages ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX pages_templates ON pages(workspace_id) WHERE is_template = 1;
    `,
  },
  {
    // Cache of fetched link previews (bookmark block), keyed by requested URL.
    id: 'editor-002-link-previews',
    sql: `
      CREATE TABLE editor_link_previews (
        url TEXT PRIMARY KEY,
        ok INTEGER NOT NULL,
        data TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX editor_link_previews_fetched ON editor_link_previews(fetched_at);
    `,
  },
  {
    // Synced blocks: content in the Yjs document `synced:<id>`, owned by the page where the block
    // was created (its access rules apply), within that page's workspace. `editor_synced_refs`
    // lists the pages whose content shows the block (same workspace only, kept on every save).
    id: 'editor-003-synced-blocks',
    sql: `
      CREATE TABLE editor_synced_blocks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        state BLOB,
        text TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX editor_synced_blocks_owner ON editor_synced_blocks(owner_page_id);
      CREATE INDEX editor_synced_blocks_workspace ON editor_synced_blocks(workspace_id);
      CREATE TABLE editor_synced_refs (
        synced_id TEXT NOT NULL REFERENCES editor_synced_blocks(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        PRIMARY KEY (synced_id, page_id)
      );
      CREATE INDEX editor_synced_refs_page ON editor_synced_refs(page_id);
    `,
  },
  {
    // Block metadata (H5): last creation and last modification of each block of a page, fed from the
    // updates received on /collab, kept OUTSIDE the Yjs document. Bounded per page by the service.
    // Authors are plain ids (no foreign key: a deleted account leaves "unknown", never a cascade).
    id: 'editor-004-block-meta',
    sql: `
      CREATE TABLE editor_block_meta (
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER,
        modified_by TEXT,
        modified_at INTEGER,
        PRIMARY KEY (page_id, block_id)
      ) WITHOUT ROWID;
    `,
  },
];
