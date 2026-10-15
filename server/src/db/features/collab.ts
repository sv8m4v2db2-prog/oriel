// Feature migrations of the "collab" module. Append entries; never edit an applied one.
// Each id must be unique across all modules (prefix it with "collab-").
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    id: 'collab-001-comments-notifications',
    sql: /* sql */ `
CREATE TABLE collab_threads (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  anchored INTEGER NOT NULL DEFAULT 1,
  quote TEXT NOT NULL DEFAULT '',
  resolved_at INTEGER, resolved_by TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX collab_threads_page ON collab_threads(page_id);
CREATE TABLE collab_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES collab_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  mentions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX collab_comments_thread ON collab_comments(thread_id, created_at);
CREATE TABLE collab_reactions (
  comment_id TEXT NOT NULL REFERENCES collab_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id, emoji));
CREATE TABLE collab_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_id TEXT,
  page_id TEXT, thread_id TEXT, comment_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, read_at INTEGER, archived_at INTEGER, emailed_at INTEGER);
CREATE INDEX collab_notifications_user ON collab_notifications(user_id, workspace_id, created_at);
CREATE INDEX collab_notifications_mail ON collab_notifications(emailed_at, read_at);
CREATE TABLE collab_page_mentions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (page_id, user_id));
CREATE TABLE collab_doc_state (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  initialized_at INTEGER NOT NULL);
CREATE TABLE collab_reminders (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, fired_at INTEGER,
  PRIMARY KEY (page_id, user_id, date));
CREATE INDEX collab_reminders_due ON collab_reminders(fired_at, date);
CREATE TABLE collab_user_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_frequency TEXT NOT NULL DEFAULT 'daily',
  updated_at INTEGER NOT NULL);
`,
  },
  {
    id: 'collab-002-password-resets',
    sql: /* sql */ `
CREATE TABLE collab_password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX collab_password_resets_user ON collab_password_resets(user_id);
`,
  },
  {
    // Invitation e-mails sent by each account (daily cap, collab/invites.ts).
    id: 'collab-003-invite-mails',
    sql: /* sql */ `
CREATE TABLE collab_invite_mails (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL);
CREATE INDEX collab_invite_mails_user ON collab_invite_mails(user_id, sent_at);
`,
  },
];
