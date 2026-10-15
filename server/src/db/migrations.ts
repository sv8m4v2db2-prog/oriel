// Ordered migration scripts; MIGRATIONS[i] upgrades schema_version i → i+1 (see ARCHITECTURE §3.2).
// The `meta` table itself is created before migrations run.

const V1 = /* sql */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  avatar_url TEXT, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, user_agent TEXT);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  joined_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
CREATE TABLE invites (
  token TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_type TEXT NOT NULL CHECK (parent_type IN ('workspace','page','database')),
  parent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('page','database')),
  title TEXT NOT NULL DEFAULT '', icon TEXT, cover TEXT,
  position TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'workspace', owner_id TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}', format TEXT NOT NULL DEFAULT '{}',
  is_inline INTEGER NOT NULL DEFAULT 0, is_public INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER, trashed_by TEXT, trash_root INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX pages_parent ON pages(parent_type, parent_id);
CREATE INDEX pages_ws ON pages(workspace_id, trashed_at);
CREATE TABLE databases (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  properties TEXT NOT NULL,
  next_unique_id INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE views (
  id TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL, position TEXT NOT NULL, config TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE documents (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  state BLOB NOT NULL, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
  editors TEXT NOT NULL DEFAULT '[]');
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  state BLOB NOT NULL, created_at INTEGER NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL);
CREATE INDEX snapshots_page ON snapshots(page_id, created_at);
CREATE TABLE page_links (
  source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id));
CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, position TEXT NOT NULL, PRIMARY KEY (user_id, page_id));
CREATE TABLE visits (
  user_id TEXT NOT NULL, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, visited_at INTEGER NOT NULL, PRIMARY KEY (user_id, page_id));
CREATE TABLE files (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, uploader_id TEXT NOT NULL, name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE search USING fts5(page_id UNINDEXED, workspace_id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2');
`;

/** Secondary indexes for the hot lookups (descendant walks, backlinks, per-user lists, purge). */
const V2 = /* sql */ `
CREATE INDEX pages_parent_id ON pages(parent_id);
CREATE INDEX pages_trash ON pages(workspace_id, trash_root, trashed_at);
CREATE INDEX members_user ON members(user_id);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX invites_ws ON invites(workspace_id);
CREATE INDEX views_db ON views(database_id);
CREATE INDEX page_links_target ON page_links(target_id);
CREATE INDEX favorites_user_ws ON favorites(user_id, workspace_id);
CREATE INDEX visits_user_ws ON visits(user_id, workspace_id, visited_at);
`;

export const MIGRATIONS: string[] = [V1, V2];
