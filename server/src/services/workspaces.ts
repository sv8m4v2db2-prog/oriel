import { newId, type SessionResponse, type WorkspaceRole, type WorkspaceSummary } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { toUser, toWorkspaceSummary, type UserRow, type WorkspaceRow } from '../db/rows.js';
import { workspaceNotFound } from '../errors.js';
import { createPage } from './pages.js';
import { workspaceAllowed } from '../auth/apiTokens.js';

export const WELCOME_TITLE = 'Bienvenue dans Oriel';
export const WELCOME_ICON = '👋';

export function listWorkspaceSummaries(db: Db, userId: string): WorkspaceSummary[] {
  return db
    .all<WorkspaceRow & { role: WorkspaceRole }>(
      `SELECT w.*, m.role AS role FROM members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? ORDER BY m.joined_at, w.created_at, w.id`,
      userId,
    )
    .filter((w) => workspaceAllowed(userId, w.id))
    .map(toWorkspaceSummary);
}

export function workspaceSummary(db: Db, userId: string, workspaceId: string): WorkspaceSummary {
  const row = db.get<WorkspaceRow & { role: WorkspaceRole }>(
    `SELECT w.*, m.role AS role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND w.id = ?`,
    userId,
    workspaceId,
  );
  if (!row || !workspaceAllowed(userId, workspaceId)) throw workspaceNotFound();
  return toWorkspaceSummary(row);
}

export function sessionResponse(db: Db, user: UserRow): SessionResponse {
  return { user: toUser(user), workspaces: listWorkspaceSummaries(db, user.id) };
}

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name.trim();

/** Creates a workspace owned by `userId` (optionally with the welcome page). Runs in the caller's transaction. */
export function createWorkspace(
  ctx: AppContext,
  userId: string,
  name: string,
  icon: string | null,
  opts: { welcomePage?: boolean } = {},
): WorkspaceRow {
  const { db } = ctx;
  return db.tx(() => {
    const id = newId();
    const now = Date.now();
    db.run(
      'INSERT INTO workspaces (id, name, icon, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)',
      id,
      name,
      icon,
      userId,
      now,
      now,
    );
    db.run("INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", id, userId, now);
    if (opts.welcomePage) {
      const welcome = createPage(ctx, userId, id, { parentType: 'workspace', parentId: id, title: WELCOME_TITLE, icon: WELCOME_ICON, visibility: 'workspace' });
      // The editor fills the (empty) welcome page with a getting-started guide on first open, then clears the flag.
      db.run('UPDATE pages SET format = ? WHERE id = ?', JSON.stringify({ seed: 'welcome' }), welcome.id);
    }
    return db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id)!;
  });
}
