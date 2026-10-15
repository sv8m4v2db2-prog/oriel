// Central access control (ARCHITECTURE §3.3). Every route goes through these helpers.
import type { PropertyDef, WorkspaceRole } from '@oriel/shared';
import type { Db } from './db/index.js';
import { PAGE_COLUMNS, type PageRow, type WorkspaceRow } from './db/rows.js';
import { cannotEdit, forbidden, notFound, pageNotFound, workspaceNotFound } from './errors.js';
import { workspaceAllowed } from './auth/apiTokens.js';

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const canEditRole = (role: WorkspaceRole | null | undefined): boolean => !!role && role !== 'viewer';
export const canManageRole = (role: WorkspaceRole | null | undefined): boolean => role === 'owner' || role === 'admin';
export const roleAtLeast = (role: WorkspaceRole, min: WorkspaceRole): boolean => ROLE_RANK[role] >= ROLE_RANK[min];

/**
 * Per-property permissions (D30), on top of the access to the database. `role` null = anonymous
 * visitor or service account (AI brief): only unrestricted properties. Owners and admins always see
 * and edit every property (they set the rules). The title is never restricted.
 */
export function canReadProperty(role: WorkspaceRole | null | undefined, def: Pick<PropertyDef, 'type' | 'access'>): boolean {
  if (def.type === 'title') return true;
  const roles = def.access?.readRoles;
  if (!roles) return true;
  if (!role) return false;
  return canManageRole(role) || (roles as string[]).includes(role);
}

export function canEditProperty(role: WorkspaceRole | null | undefined, def: Pick<PropertyDef, 'type' | 'access'>): boolean {
  if (!canEditRole(role) || !canReadProperty(role, def)) return false;
  if (def.type === 'title') return true;
  const roles = def.access?.editRoles;
  return !roles || canManageRole(role) || (roles as string[]).includes(role!);
}

export function roleOf(db: Db, userId: string, workspaceId: string): WorkspaceRole | null {
  // Workspace-restricted API token: every other workspace is invisible.
  if (!workspaceAllowed(userId, workspaceId)) return null;
  return (
    db.get<{ role: WorkspaceRole }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)
      ?.role ?? null
  );
}

export function getPageRow(db: Db, id: string): PageRow | undefined {
  return db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, id);
}

/**
 * Visibility rule: workspace pages are readable by every member; private pages only by their owner;
 * pages of a closed or private teamspace (visibility 'teamspace', navigation module) only by the
 * explicit members of that teamspace. The membership check needs `db`: without it (or without
 * `teamspace_id`) a teamspace page is refused — fail closed.
 */
export function canSeePage(
  userId: string,
  role: WorkspaceRole | null,
  page: Pick<PageRow, 'visibility' | 'owner_id'> & { teamspace_id?: string | null },
  db?: Db,
): boolean {
  if (!role) return false;
  if (page.visibility === 'private') return page.owner_id === userId;
  if (page.visibility === 'teamspace') return !!db && !!page.teamspace_id && isTeamspaceMember(db, page.teamspace_id, userId);
  return page.visibility === 'workspace';
}

/** Explicit member of a teamspace (restricted teamspaces have no implicit members). */
export function isTeamspaceMember(db: Db, teamspaceId: string, userId: string): boolean {
  return !!db.get('SELECT 1 AS x FROM nav_teamspace_members WHERE teamspace_id = ? AND user_id = ?', teamspaceId, userId);
}

/**
 * Recipients of an invalidation about a page (EventBus.publish): its owner for a private page, the
 * explicit members of its teamspace for a restricted teamspace page (QA-G7-04: ids and activity of
 * those pages never reach the rest of the workspace), everyone otherwise. Changes that make a page
 * leave a restricted place must still reach everyone (callers pass `undefined` for those).
 */
export function pageAudience(
  db: Db,
  page: Pick<PageRow, 'id' | 'visibility' | 'owner_id'> & { teamspace_id?: string | null },
): string | ((userId: string) => boolean) | undefined {
  if (page.visibility === 'private') return page.owner_id;
  if (page.visibility !== 'teamspace') return undefined;
  const teamspaceId = page.teamspace_id !== undefined ? page.teamspace_id : getPageRow(db, page.id)?.teamspace_id ?? null;
  // Members read now (inside the writing transaction): still right when the teamspace is deleted with it.
  const members = new Set(
    teamspaceId
      ? db.all<{ user_id: string }>('SELECT user_id FROM nav_teamspace_members WHERE teamspace_id = ?', teamspaceId).map((r) => r.user_id)
      : [],
  );
  return (userId: string) => members.has(userId);
}

/**
 * SQL condition "page `alias` is readable by the user", for lists already restricted to one workspace
 * the user belongs to. It takes TWO parameters, both the user id (see visiblePageParams).
 */
export const visiblePageClause = (alias = 'p'): string =>
  `(${alias}.visibility = 'workspace' OR (${alias}.visibility = 'private' AND ${alias}.owner_id = ?) OR ` +
  `(${alias}.visibility = 'teamspace' AND EXISTS (SELECT 1 FROM nav_teamspace_members vtm WHERE vtm.teamspace_id = ${alias}.teamspace_id AND vtm.user_id = ?)))`;
export const visiblePageParams = (userId: string): [string, string] => [userId, userId];

export interface PageAccess {
  page: PageRow;
  role: WorkspaceRole;
  canEdit: boolean;
}

/** Resolves a page for a user; invisible pages (other workspace, someone else's private page…) → 404. */
export function pageAccess(db: Db, userId: string, pageId: string): PageAccess | null {
  const page = getPageRow(db, pageId);
  // Workspace-restricted API token (also enforced by roleOf).
  if (!page || !workspaceAllowed(userId, page.workspace_id)) return null;
  const role = roleOf(db, userId, page.workspace_id);
  if (!role || !canSeePage(userId, role, page, db)) return null;
  return { page, role, canEdit: canEditRole(role) };
}

export function requirePage(db: Db, userId: string, pageId: string, mode: 'read' | 'edit' = 'read'): PageAccess {
  const access = pageAccess(db, userId, pageId);
  if (!access) throw pageNotFound();
  if (mode === 'edit' && !access.canEdit) throw cannotEdit();
  return access;
}

export function requireDatabasePage(db: Db, userId: string, databaseId: string, mode: 'read' | 'edit' = 'read'): PageAccess {
  const access = pageAccess(db, userId, databaseId);
  if (!access || access.page.kind !== 'database') throw pageNotFound();
  if (mode === 'edit' && !access.canEdit) throw cannotEdit();
  return access;
}

/**
 * QA-EDT-05 — row actions of a button block (« Ajouter une ligne », « Modifier des lignes ») run with
 * the rights of whoever clicks, but their target database comes from the page's shared document. The
 * clicker's client names the page of the button (`viaButtonOn`): that page must be visible to the
 * user and of the database's workspace (otherwise 404), and everyone who can read it must be able to
 * read the database (otherwise 403) — a colleague's button on a shared page may not write into the
 * clicker's private database, nor into a restricted teamspace's database. Visibility is stored on
 * every page (inherited from the parent), so a database nested under a private page is private.
 */
export function assertButtonTarget(db: Db, userId: string, hostPageId: string, target: PageRow): void {
  const host = pageAccess(db, userId, hostPageId);
  if (!host || host.page.workspace_id !== target.workspace_id) throw notFound('Page du bouton introuvable.');
  const h = host.page;
  if (target.visibility === 'workspace') return;
  // A private page is read by its owner only (here: the clicker, who can read the database).
  if (h.visibility === 'private' && (target.visibility !== 'private' || target.owner_id === h.owner_id)) return;
  if (target.visibility === 'teamspace' && h.visibility === 'teamspace' && !!h.teamspace_id && h.teamspace_id === target.teamspace_id) return;
  throw forbidden(
    target.visibility === 'private'
      ? 'Ce bouton ne peut pas modifier une base privée depuis une page partagée.'
      : 'Ce bouton ne peut pas modifier une base d’un espace d’équipe restreint depuis une page visible plus largement.',
  );
}

export function requireWorkspace(
  db: Db,
  userId: string,
  workspaceId: string,
  min: 'read' | 'edit' | 'manage' | 'owner' = 'read',
): { workspace: WorkspaceRow; role: WorkspaceRole } {
  const row = db.get<WorkspaceRow & { role: WorkspaceRole }>(
    `SELECT w.*, m.role AS role FROM workspaces w JOIN members m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?`,
    userId,
    workspaceId,
  );
  if (!row || !workspaceAllowed(userId, workspaceId)) throw workspaceNotFound();
  const { role, ...workspace } = row;
  if (min === 'edit' && !canEditRole(role)) throw cannotEdit();
  if (min === 'manage' && !canManageRole(role)) throw forbidden("Seuls les propriétaires et administrateurs de l'espace peuvent faire cela.");
  if (min === 'owner' && role !== 'owner') throw forbidden("Seuls les propriétaires de l'espace peuvent faire cela.");
  return { workspace, role };
}

/** Self + ancestors (self first). */
export function pageChain(db: Db, pageId: string): PageRow[] {
  return db.all<PageRow>(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT ?, 0
       UNION
       SELECT p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.id
       WHERE p.parent_type != 'workspace' AND chain.depth < 10000
     )
     SELECT ${PAGE_COLUMNS.split(',')
       .map((c) => `p.${c.trim()}`)
       .join(', ')} FROM chain JOIN pages p ON p.id = chain.id ORDER BY chain.depth`,
    pageId,
  );
}

/**
 * Extension point: feature modules register, at startup, predicates keeping some pages off the web even
 * inside a published tree (e.g. row templates, databases module — QA-DB-11). A predicate receives the
 * self-first chain and returns true when the page must stay private; it then hides the whole subtree.
 * Keyed by name, so registering again (one per server started in the process) replaces the entry.
 */
export type PublicExclusion = (db: Db, chain: PageRow[]) => boolean;
const publicExclusions = new Map<string, PublicExclusion>();

export function registerPublicExclusion(name: string, exclude: PublicExclusion): void {
  publicExclusions.set(name, exclude);
}

/**
 * Self-first chain of a page published to the web, else null: the page or an ancestor has is_public=1,
 * nothing in the chain is trashed, and no registered exclusion applies.
 */
export function publicChain(db: Db, pageId: string): PageRow[] | null {
  const chain = pageChain(db, pageId);
  if (chain.length === 0 || chain.some((p) => p.trashed_at !== null) || !chain.some((p) => p.is_public === 1)) return null;
  for (const exclude of publicExclusions.values()) if (exclude(db, chain)) return null;
  return chain;
}

/**
 * Self-first chain of a live page that an explicit share other than publication may expose to anonymous
 * visitors (public form, QA-VIEW-04), else null: nothing in the chain is trashed and no registered
 * exclusion applies. Unlike publicChain, no page of the chain needs to be published: the caller only
 * exposes what that share allows, never the page itself.
 */
export function shareableChain(db: Db, pageId: string): PageRow[] | null {
  const chain = pageChain(db, pageId);
  if (chain.length === 0 || chain.some((p) => p.trashed_at !== null)) return null;
  for (const exclude of publicExclusions.values()) if (exclude(db, chain)) return null;
  return chain;
}

/** Published to the web (see publicChain). */
export function isPubliclyVisible(db: Db, pageId: string): boolean {
  return publicChain(db, pageId) !== null;
}

/** Ids of a page and all its descendants (sub-pages, databases, rows), any trash state. */
export function subtreeIds(db: Db, rootId: string): string[] {
  return db
    .all<{ id: string }>(
      `WITH RECURSIVE d(id) AS (
         SELECT ?
         UNION
         SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id AND p.parent_type IN ('page', 'database')
       ) SELECT id FROM d`,
      rootId,
    )
    .map((r) => r.id);
}

/**
 * True when `candidateId` is `ancestorId` itself or one of its descendants. Walks up the whole
 * chain (no depth cap, unlike pageChain: a deeper tree would let a move create a cycle — QA-INT-03);
 * the UNION on the id alone stops on any cycle.
 */
export function isSelfOrDescendant(db: Db, candidateId: string, ancestorId: string): boolean {
  return !!db.get(
    `WITH RECURSIVE up(id) AS (
       SELECT ?
       UNION
       SELECT p.parent_id FROM pages p JOIN up ON p.id = up.id WHERE p.parent_type != 'workspace'
     ) SELECT 1 AS x FROM up WHERE id = ? LIMIT 1`,
    candidateId,
    ancestorId,
  );
}

/**
 * Version history of a page (G6, SPEC « Historique des versions »): workspace role at least
 * `member` on a visible page. Invisible page → 404; a viewer sees the page but not its history → 403.
 */
export function requirePageHistory(db: Db, userId: string, pageId: string, mode: 'read' | 'edit' = 'read'): PageAccess {
  const access = requirePage(db, userId, pageId, mode);
  if (!roleAtLeast(access.role, 'member')) throw forbidden("L'historique est réservé aux membres de l'espace.");
  return access;
}
