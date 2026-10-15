// Feature migrations of the "organize" module (wave H3): daily journal, workspace tags, workspace
// page properties, smart collections, saved "All pages" views, folder items. Ids are prefixed "org-".
// Everything is additive and idempotent: no existing table is altered, no page is touched.
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    // One journal per (workspace, person): a container page « Journal » and a page per day.
    id: 'org-001-journal',
    sql: `
      CREATE TABLE IF NOT EXISTS org_journal_settings (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        container_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
        template_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS org_journal_entries (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        PRIMARY KEY (workspace_id, user_id, day)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS org_journal_entries_page ON org_journal_entries(page_id);
    `,
  },
  {
    // Workspace tags (name unique per workspace, accent- and case-insensitive through name_key) and
    // workspace page properties (text, number, date, checkbox, select) with their values.
    id: 'org-002-tags-props',
    sql: `
      CREATE TABLE IF NOT EXISTS org_tags (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'gray',
        created_by TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (workspace_id, name_key)
      );
      CREATE TABLE IF NOT EXISTS org_page_tags (
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES org_tags(id) ON DELETE CASCADE,
        PRIMARY KEY (page_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS org_page_tags_tag ON org_page_tags(tag_id, page_id);
      CREATE TABLE IF NOT EXISTS org_page_props (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'checkbox', 'select')),
        options TEXT NOT NULL DEFAULT '[]',
        display TEXT NOT NULL DEFAULT 'hide_empty' CHECK (display IN ('always', 'hide_empty', 'hidden')),
        position TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS org_page_props_ws ON org_page_props(workspace_id);
      CREATE TABLE IF NOT EXISTS org_page_prop_values (
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        prop_id TEXT NOT NULL REFERENCES org_page_props(id) ON DELETE CASCADE,
        value TEXT NOT NULL,
        PRIMARY KEY (page_id, prop_id)
      );
      CREATE INDEX IF NOT EXISTS org_page_prop_values_prop ON org_page_prop_values(prop_id);
    `,
  },
  {
    // Smart collections (rules + manual additions/exclusions), saved "All pages" views, and tags or
    // collections placed in a sidebar folder (nav_folders, navigation module).
    id: 'org-003-collections-views',
    sql: `
      CREATE TABLE IF NOT EXISTS org_collections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        icon TEXT,
        rules TEXT NOT NULL DEFAULT '{"match":"all","conditions":[]}',
        position TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS org_collections_ws ON org_collections(workspace_id);
      CREATE TABLE IF NOT EXISTS org_collection_pages (
        collection_id TEXT NOT NULL REFERENCES org_collections(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('include', 'exclude')),
        PRIMARY KEY (collection_id, page_id)
      );
      CREATE INDEX IF NOT EXISTS org_collection_pages_page ON org_collection_pages(page_id);
      CREATE TABLE IF NOT EXISTS org_saved_views (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        shared INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        position TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS org_saved_views_ws ON org_saved_views(workspace_id, owner_id);
      CREATE TABLE IF NOT EXISTS org_folder_items (
        folder_id TEXT NOT NULL REFERENCES nav_folders(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('tag', 'collection')),
        ref_id TEXT NOT NULL,
        position TEXT NOT NULL,
        PRIMARY KEY (folder_id, kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS org_folder_items_ref ON org_folder_items(kind, ref_id);
      CREATE INDEX IF NOT EXISTS org_folder_items_folder ON org_folder_items(folder_id);
    `,
  },
];
