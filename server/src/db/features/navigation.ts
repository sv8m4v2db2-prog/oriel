// Feature migrations of the "navigation" module (wave G7): teamspaces with members and access modes,
// personal sidebar shortcuts and sections, folders, page view statistics. Append entries; never edit
// an applied one. Each id is prefixed with "nav-". All of them are additive: existing pages keep
// their access (former navigation groups become open default teamspaces).
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    // Teamspaces. `access`: open (content readable by every workspace member, pages stay
    // visibility='workspace'), closed or private (subtree in visibility='teamspace' with
    // pages.teamspace_id = root id, readable by explicit members only).
    id: 'nav-001-teamspaces',
    sql: `
      CREATE TABLE nav_teamspaces (
        page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        access TEXT NOT NULL DEFAULT 'open' CHECK (access IN ('open', 'closed', 'private')),
        is_default INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        created_by TEXT
      );
      CREATE INDEX nav_teamspaces_ws ON nav_teamspaces(workspace_id);
      CREATE TABLE nav_teamspace_members (
        teamspace_id TEXT NOT NULL REFERENCES nav_teamspaces(page_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (teamspace_id, user_id)
      );
      CREATE INDEX nav_teamspace_members_user ON nav_teamspace_members(user_id);
      CREATE TABLE nav_teamspace_requests (
        teamspace_id TEXT NOT NULL REFERENCES nav_teamspaces(page_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (teamspace_id, user_id)
      );
      ALTER TABLE pages ADD COLUMN teamspace_id TEXT;
      CREATE INDEX pages_teamspace ON pages(teamspace_id) WHERE teamspace_id IS NOT NULL;
      -- Every insert path (page, duplicate, database row) inherits the restricted teamspace of its parent.
      CREATE TRIGGER nav_pages_teamspace_insert AFTER INSERT ON pages
        WHEN NEW.visibility = 'teamspace' AND NEW.parent_type != 'workspace'
      BEGIN
        UPDATE pages SET teamspace_id = (SELECT p.teamspace_id FROM pages p WHERE p.id = NEW.parent_id) WHERE id = NEW.id;
      END;
      CREATE TRIGGER nav_pages_teamspace_clear AFTER UPDATE OF visibility ON pages
        WHEN NEW.visibility != 'teamspace' AND NEW.teamspace_id IS NOT NULL
      BEGIN
        UPDATE pages SET teamspace_id = NULL WHERE id = NEW.id;
      END;
      -- Former navigation groups: open default teamspaces, i.e. no access change at all.
      INSERT OR IGNORE INTO nav_teamspaces (page_id, workspace_id, access, is_default, created_at, created_by)
        SELECT id, workspace_id, 'open', 1, created_at, created_by FROM pages
        WHERE parent_type = 'workspace' AND kind = 'page' AND visibility = 'workspace'
          AND json_valid(format) AND json_extract(format, '$.teamspaceRoot') = 1;
    `,
  },
  {
    // Personal sidebar: named sections (NULL section = "Raccourcis") and shortcuts to a page, a
    // database view or an external link. Titles are resolved when listing, never stored for pages.
    id: 'nav-002-sidebar',
    sql: `
      CREATE TABLE nav_sidebar_sections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position TEXT NOT NULL,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX nav_sidebar_sections_user ON nav_sidebar_sections(user_id, workspace_id);
      CREATE TABLE nav_sidebar_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        section_id TEXT REFERENCES nav_sidebar_sections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('page', 'view', 'link')),
        page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
        view_id TEXT REFERENCES views(id) ON DELETE CASCADE,
        url TEXT,
        label TEXT NOT NULL DEFAULT '',
        position TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX nav_sidebar_items_user ON nav_sidebar_items(user_id, workspace_id);
    `,
  },
  {
    // Folders: group root pages of a space ('workspace', 'private' or a teamspace root id) without a
    // parent page. No content; each page keeps its own access.
    id: 'nav-003-folders',
    sql: `
      CREATE TABLE nav_folders (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        space TEXT NOT NULL,
        owner_id TEXT,
        name TEXT NOT NULL,
        position TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX nav_folders_ws ON nav_folders(workspace_id, space);
      CREATE TABLE nav_folder_pages (
        page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        folder_id TEXT NOT NULL REFERENCES nav_folders(id) ON DELETE CASCADE,
        position TEXT NOT NULL
      );
      CREATE INDEX nav_folder_pages_folder ON nav_folder_pages(folder_id);
    `,
  },
  {
    // Page views per day (members deduplicated per half hour; anonymous visitors: a counter only)
    // and the workspace switch hiding the readers list.
    id: 'nav-004-page-views',
    sql: `
      CREATE TABLE nav_page_views (
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        anonymous_views INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (page_id, day)
      );
      CREATE TABLE nav_workspace_settings (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        show_readers INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX visits_page ON visits(page_id, visited_at);
    `,
  },
];
