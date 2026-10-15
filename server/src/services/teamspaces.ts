// Teamspaces (navigation module, wave G7): access modes, members, requests, conversion of a page,
// effect of a move on who can read a subtree. A teamspace is a root page of the workspace:
// - open: its subtree keeps visibility 'workspace' (every member reads it);
// - closed / private: its subtree has visibility 'teamspace' and teamspace_id = root id, readable by
//   the explicit members only (access.ts canSeePage / visiblePageClause).
// A root page flagged `format.teamspaceRoot` without a nav_teamspaces row (navigation groups created
// before this module, or by a script) is an open default teamspace: nothing changes for it.
import {
  positionForInsert,
  type AccessAudience,
  type AccessEffect,
  type PageFormat,
  type TeamspaceAccess,
  type TeamspaceMember,
  type TeamspaceRole,
  type TeamspaceSummary,
  type TreeNode,
  type Visibility,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson, toPublicUser, type PageRow, type UserRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { canManageRole, getPageRow, pageAudience, pageChain, requirePage, roleOf, subtreeIds } from '../access.js';
import { emitPage, pageChange } from './pages.js';
import { notify } from '../collab/notify.js';

export interface TeamspaceRow {
  page_id: string;
  workspace_id: string;
  access: TeamspaceAccess;
  is_default: number;
  description: string;
  created_at: number;
  created_by: string | null;
}

export const ACCESS_LABELS: Record<TeamspaceAccess, string> = { open: 'ouvert', closed: 'fermé', private: 'privé' };

/** Root page that is a teamspace (flagged, or restricted). */
export function isTeamspaceRoot(page: Pick<PageRow, 'parent_type' | 'kind' | 'visibility' | 'format'>): boolean {
  if (page.parent_type !== 'workspace' || page.kind !== 'page') return false;
  if (page.visibility === 'teamspace') return true;
  return page.visibility === 'workspace' && parseJson<PageFormat>(page.format, {}).teamspaceRoot === true;
}

/** Settings of a teamspace root (synthesized open default when the row does not exist yet). */
export function teamspaceOf(db: Db, root: PageRow): TeamspaceRow | null {
  if (!isTeamspaceRoot(root)) return null;
  // A restricted root is its own teamspace; a page of another teamspace that ended up at the root is
  // not a teamspace (it would be listed to the whole workspace — QA-G7-01).
  if (root.visibility === 'teamspace' && root.teamspace_id !== root.id) return null;
  const row = db.get<TeamspaceRow>('SELECT * FROM nav_teamspaces WHERE page_id = ?', root.id);
  if (row) return row;
  return {
    page_id: root.id,
    workspace_id: root.workspace_id,
    access: root.visibility === 'teamspace' ? 'closed' : 'open',
    is_default: root.visibility === 'teamspace' ? 0 : 1,
    description: '',
    created_at: root.created_at,
    created_by: root.created_by,
  };
}

/** Teamspace containing a page (its root's), or null. */
export function teamspaceOfPage(db: Db, pageId: string): { root: PageRow; ts: TeamspaceRow } | null {
  const chain = pageChain(db, pageId);
  const root = chain[chain.length - 1];
  if (!root || root.parent_type !== 'workspace') return null;
  const ts = teamspaceOf(db, root);
  return ts ? { root, ts } : null;
}

/** Persists the row of a (possibly synthesized) teamspace. */
function ensureRow(db: Db, ts: TeamspaceRow): void {
  db.run(
    `INSERT OR IGNORE INTO nav_teamspaces (page_id, workspace_id, access, is_default, description, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ts.page_id,
    ts.workspace_id,
    ts.access,
    ts.is_default,
    ts.description,
    ts.created_at,
    ts.created_by,
  );
}

export function explicitRole(db: Db, teamspaceId: string, userId: string): TeamspaceRole | null {
  return db.get<{ role: TeamspaceRole }>('SELECT role FROM nav_teamspace_members WHERE teamspace_id = ? AND user_id = ?', teamspaceId, userId)?.role ?? null;
}

/** Member (explicit, or every workspace member for an open default teamspace). */
export function memberRole(db: Db, ts: TeamspaceRow, userId: string): TeamspaceRole | null {
  const explicit = explicitRole(db, ts.page_id, userId);
  if (explicit) return explicit;
  return ts.access === 'open' && ts.is_default === 1 && roleOf(db, userId, ts.workspace_id) ? 'member' : null;
}

/** Teamspace owners, workspace owners/admins (not for private teamspaces unless member) manage it. */
export function canManageTeamspace(db: Db, ts: TeamspaceRow, userId: string): boolean {
  const wsRole = roleOf(db, userId, ts.workspace_id);
  if (!wsRole) return false;
  if (explicitRole(db, ts.page_id, userId) === 'owner') return true;
  if (!canManageRole(wsRole)) return false;
  if (ts.access !== 'private') return true;
  // Private teamspace left without owner: the workspace owners can take it back.
  return wsRole === 'owner' && ownerIds(db, ts.page_id).length === 0;
}

/** Visible in the directory / addressable by the user: open and closed ones, private ones to members. */
export function canSeeTeamspace(db: Db, ts: TeamspaceRow, userId: string): boolean {
  if (!roleOf(db, userId, ts.workspace_id)) return false;
  if (ts.access !== 'private') return true;
  return !!explicitRole(db, ts.page_id, userId) || canManageTeamspace(db, ts, userId);
}

function ownerIds(db: Db, teamspaceId: string): string[] {
  return db
    .all<{ user_id: string }>(
      `SELECT t.user_id FROM nav_teamspace_members t JOIN nav_teamspaces n ON n.page_id = t.teamspace_id
       JOIN members m ON m.workspace_id = n.workspace_id AND m.user_id = t.user_id
       WHERE t.teamspace_id = ? AND t.role = 'owner' ORDER BY t.joined_at`,
      teamspaceId,
    )
    .map((r) => r.user_id);
}

/** Resolves a teamspace for a user: invisible or missing → 404. */
export function requireTeamspace(db: Db, userId: string, teamspaceId: string): { root: PageRow; ts: TeamspaceRow } {
  const root = getPageRow(db, teamspaceId);
  const ts = root && root.trashed_at === null ? teamspaceOf(db, root) : null;
  if (!root || !ts || !canSeeTeamspace(db, ts, userId)) throw notFound('Espace d’équipe introuvable.');
  return { root, ts };
}

function requireManage(db: Db, userId: string, ts: TeamspaceRow): void {
  if (!canManageTeamspace(db, ts, userId)) throw forbidden('Seuls les propriétaires de l’espace d’équipe peuvent faire cela.');
}

// ---------------------------------------------------------------------------
// Audiences and effects
// ---------------------------------------------------------------------------

interface Place {
  visibility: Visibility;
  ownerId: string;
  teamspaceId: string | null;
}

/** Users who can read a page at that place. */
function audience(db: Db, workspaceId: string, place: Place): Set<string> {
  if (place.visibility === 'private') return new Set([place.ownerId]);
  if (place.visibility === 'teamspace') {
    if (!place.teamspaceId) return new Set();
    return new Set(
      db
        .all<{ user_id: string }>(
          `SELECT t.user_id FROM nav_teamspace_members t JOIN members m ON m.user_id = t.user_id AND m.workspace_id = ?
           WHERE t.teamspace_id = ?`,
          workspaceId,
          place.teamspaceId,
        )
        .map((r) => r.user_id),
    );
  }
  return new Set(db.all<{ user_id: string }>('SELECT user_id FROM members WHERE workspace_id = ?', workspaceId).map((r) => r.user_id));
}

function audienceDto(place: Place, teamspace: { root: PageRow; ts: TeamspaceRow } | null, readers: number): AccessAudience {
  return {
    visibility: place.visibility,
    teamspace: teamspace ? { id: teamspace.root.id, title: teamspace.root.title, access: teamspace.ts.access } : null,
    readers,
  };
}

export function accessEffect(
  db: Db,
  page: PageRow,
  from: Place,
  to: Place,
  teams: { from: { root: PageRow; ts: TeamspaceRow } | null; to: { root: PageRow; ts: TeamspaceRow } | null },
  extraReaders: string[] = [],
): AccessEffect {
  const a = audience(db, page.workspace_id, from);
  const b = audience(db, page.workspace_id, to);
  for (const id of extraReaders) b.add(id);
  let gain = 0;
  let lose = 0;
  for (const id of b) if (!a.has(id)) gain++;
  for (const id of a) if (!b.has(id)) lose++;
  const pageCount = subtreeIds(db, page.id).length;
  return {
    pageCount,
    from: audienceDto(from, teams.from, a.size),
    to: audienceDto(to, teams.to, b.size),
    gain,
    lose,
    widens: gain > 0,
    narrows: lose > 0,
  };
}

const placeOf = (p: Pick<PageRow, 'visibility' | 'owner_id' | 'teamspace_id'>): Place => ({
  visibility: p.visibility,
  ownerId: p.owner_id,
  teamspaceId: p.teamspace_id ?? null,
});

/** Rewrites the access of a subtree (pages, databases, rows, trashed ones included). */
export function applySubtreeAccess(db: Db, ids: string[], place: Place): void {
  for (const id of ids) {
    if (place.visibility === 'teamspace') db.run("UPDATE pages SET visibility = 'teamspace', teamspace_id = ? WHERE id = ?", place.teamspaceId, id);
    else if (place.visibility === 'private') db.run("UPDATE pages SET visibility = 'private', owner_id = ? WHERE id = ?", place.ownerId, id);
    else db.run("UPDATE pages SET visibility = 'workspace' WHERE id = ?", id);
  }
}

/** After commit: connections of people who lost access are closed. */
function closeLost(ctx: AppContext, ids: string[]): void {
  ctx.db.afterCommit(() => ctx.collab.closeUnauthorized?.(ids));
}

function publishTeamspaces(ctx: AppContext, workspaceId: string, onlyUserId?: string): void {
  ctx.bus.publish(workspaceId, { entity: 'navigation', workspaceId, scope: 'teamspaces' }, onlyUserId);
}

/**
 * The sidebar tree changes for everyone (pages appear/disappear) when the teamspace becomes or stops
 * being restricted; otherwise only those who can read the root learn its id (QA-G7-04).
 */
function publishTree(ctx: AppContext, root: PageRow, everyone: boolean): void {
  const fresh = getPageRow(ctx.db, root.id) ?? root;
  ctx.bus.publish(root.workspace_id, pageChange(root, true), everyone ? undefined : pageAudience(ctx.db, fresh));
  publishTeamspaces(ctx, root.workspace_id);
}

// ---------------------------------------------------------------------------
// Moves (used by services/pages.ts movePage and the preview route)
// ---------------------------------------------------------------------------

export interface MoveAccess {
  place: Place;
  effect: AccessEffect;
  /** The move crosses a teamspace boundary and widens access: explicit consent required. */
  needsConfirm: boolean;
}

/**
 * Access of a page after a move, and its effect. Throws for moves a teamspace root does not allow
 * (under a page, or to another visibility).
 */
export function moveAccess(
  db: Db,
  actorId: string,
  page: PageRow,
  input: { parentType: 'workspace' | 'page' | 'database'; parentId: string; visibility?: Visibility },
): MoveAccess {
  const fromTeam = teamspaceOfPage(db, page.id);
  // Restricted roots stay restricted roots; an open one moved elsewhere becomes a plain page again
  // (its marker is ignored), as navigation groups always did.
  if (isTeamspaceRoot(page) && page.visibility === 'teamspace') {
    if (input.parentType !== 'workspace') throw badRequest('Un espace d’équipe reste à la racine : déplacez plutôt ses pages.');
    if (input.visibility && input.visibility !== page.visibility) throw badRequest('Changez le mode d’accès dans les réglages de l’espace d’équipe.');
    const place = placeOf(page);
    return { place, effect: accessEffect(db, page, place, place, { from: fromTeam, to: fromTeam }), needsConfirm: false };
  }
  let place: Place;
  let toTeam: { root: PageRow; ts: TeamspaceRow } | null = null;
  if (input.parentType === 'workspace') {
    const requested = input.visibility ?? (page.visibility === 'teamspace' ? 'workspace' : page.visibility);
    if (requested === 'teamspace') throw badRequest('Destination invalide.');
    place = { visibility: requested, ownerId: requested === 'private' ? actorId : page.owner_id, teamspaceId: null };
  } else {
    const parent = getPageRow(db, input.parentId);
    if (!parent) throw notFound('Page de destination introuvable.');
    place = { visibility: parent.visibility, ownerId: parent.visibility === 'private' ? parent.owner_id : page.owner_id, teamspaceId: parent.teamspace_id ?? null };
    toTeam = teamspaceOfPage(db, parent.id);
  }
  const effect = accessEffect(db, page, placeOf(page), place, { from: fromTeam, to: toTeam });
  const crosses = (fromTeam?.root.id ?? null) !== (toTeam?.root.id ?? null) && (!!fromTeam || !!toTeam);
  return { place, effect, needsConfirm: crosses && effect.widens };
}

// ---------------------------------------------------------------------------
// Directory and settings
// ---------------------------------------------------------------------------

function summary(db: Db, root: PageRow, ts: TeamspaceRow, userId: string): TeamspaceSummary {
  const memberCount =
    ts.access === 'open' && ts.is_default === 1
      ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE workspace_id = ?', ts.workspace_id)!.n
      : db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM nav_teamspace_members t JOIN members m ON m.user_id = t.user_id AND m.workspace_id = ?
           WHERE t.teamspace_id = ?`,
          ts.workspace_id,
          ts.page_id,
        )!.n;
  const owners = ownerIds(db, ts.page_id)
    .map((id) => db.get<UserRow>('SELECT * FROM users WHERE id = ?', id))
    .filter((u): u is UserRow => !!u)
    .map(toPublicUser);
  return {
    id: root.id,
    workspaceId: root.workspace_id,
    title: root.title,
    icon: root.icon,
    description: ts.description,
    access: ts.access,
    isDefault: ts.is_default === 1,
    memberCount,
    owners,
    myRole: memberRole(db, ts, userId),
    requested: !!db.get('SELECT 1 AS x FROM nav_teamspace_requests WHERE teamspace_id = ? AND user_id = ?', ts.page_id, userId),
    canManage: canManageTeamspace(db, ts, userId),
  };
}

export function listTeamspaces(db: Db, userId: string, workspaceId: string): TeamspaceSummary[] {
  const roots = db.all<PageRow>(
    `SELECT p.* FROM pages p WHERE p.workspace_id = ? AND p.parent_type = 'workspace' AND p.kind = 'page'
       AND p.trashed_at IS NULL AND p.visibility IN ('workspace', 'teamspace') ORDER BY p.position, p.id`,
    workspaceId,
  );
  const out: TeamspaceSummary[] = [];
  for (const root of roots) {
    const ts = teamspaceOf(db, root);
    if (!ts || !canSeeTeamspace(db, ts, userId)) continue;
    out.push(summary(db, root, ts, userId));
  }
  return out;
}

export function teamspaceSummary(db: Db, userId: string, teamspaceId: string): TeamspaceSummary {
  const { root, ts } = requireTeamspace(db, userId, teamspaceId);
  return summary(db, root, ts, userId);
}

/** Members (members and managers only) and pending requests (managers only). */
export function listMembers(db: Db, userId: string, teamspaceId: string) {
  const { ts } = requireTeamspace(db, userId, teamspaceId);
  const manage = canManageTeamspace(db, ts, userId);
  if (!manage && !memberRole(db, ts, userId)) throw forbidden('Rejoignez l’espace d’équipe pour voir ses membres.');
  const members: TeamspaceMember[] = db
    .all<UserRow & { t_role: TeamspaceRole; t_joined: number }>(
      `SELECT u.*, t.role AS t_role, t.joined_at AS t_joined FROM nav_teamspace_members t JOIN users u ON u.id = t.user_id
       JOIN members m ON m.user_id = t.user_id AND m.workspace_id = ?
       WHERE t.teamspace_id = ? ORDER BY t.role = 'owner' DESC, u.name COLLATE NOCASE`,
      ts.workspace_id,
      ts.page_id,
    )
    .map((r) => ({ user: toPublicUser(r), role: r.t_role, joinedAt: r.t_joined }));
  const requests = manage
    ? db
        .all<UserRow & { r_at: number }>(
          `SELECT u.*, r.created_at AS r_at FROM nav_teamspace_requests r JOIN users u ON u.id = r.user_id
           JOIN members m ON m.user_id = r.user_id AND m.workspace_id = ?
           WHERE r.teamspace_id = ? ORDER BY r.created_at`,
          ts.workspace_id,
          ts.page_id,
        )
        .map((r) => ({ user: toPublicUser(r), createdAt: r.r_at }))
    : [];
  return { members, requests };
}

/** Explicit members of a default teamspace (before it stops being "everyone"). */
function materializeDefault(db: Db, ts: TeamspaceRow, now: number): void {
  db.run(
    `INSERT OR IGNORE INTO nav_teamspace_members (teamspace_id, user_id, role, joined_at)
     SELECT ?, user_id, 'member', ? FROM members WHERE workspace_id = ?`,
    ts.page_id,
    now,
    ts.workspace_id,
  );
}

export function updateTeamspace(
  ctx: AppContext,
  actorId: string,
  teamspaceId: string,
  input: { access?: TeamspaceAccess; isDefault?: boolean; description?: string; confirmAccess?: boolean },
): TeamspaceSummary {
  const { db } = ctx;
  return db.tx(() => {
    const { root, ts } = requireTeamspace(db, actorId, teamspaceId);
    requireManage(db, actorId, ts);
    ensureRow(db, ts);
    const now = Date.now();
    const access = input.access ?? ts.access;
    const wasDefault = ts.is_default === 1;
    const isDefault = access === 'open' ? (input.isDefault ?? wasDefault) : false;
    if (input.isDefault && access !== 'open') throw badRequest('Seul un espace d’équipe ouvert peut être un espace par défaut.');
    // A default teamspace enrols every member of the workspace: a workspace-wide decision, like
    // creating a teamspace (QA-CORE-09, QA-G7-03).
    if (isDefault !== wasDefault && !canManageRole(roleOf(db, actorId, ts.workspace_id))) {
      throw forbidden("Seuls les propriétaires et administrateurs de l'espace de travail choisissent les espaces d'équipe par défaut.");
    }
    // Widening: content (closed/private → open) or existence (private → closed).
    const widens = (ts.access !== 'open' && access === 'open') || (ts.access === 'private' && access === 'closed');
    if (widens && input.confirmAccess !== true) throw conflict('Ce changement élargit l’accès : confirmez-le explicitement.');
    if (wasDefault && !isDefault) materializeDefault(db, ts, now);
    // The actor keeps access whatever happens.
    db.run(
      `INSERT INTO nav_teamspace_members (teamspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
       ON CONFLICT(teamspace_id, user_id) DO UPDATE SET role = 'owner'`,
      ts.page_id,
      actorId,
      now,
    );
    db.run(
      'UPDATE nav_teamspaces SET access = ?, is_default = ?, description = ? WHERE page_id = ?',
      access,
      isDefault ? 1 : 0,
      input.description !== undefined ? input.description.trim().slice(0, 500) : ts.description,
      ts.page_id,
    );
    const restricted = access !== 'open';
    if (restricted !== (ts.access !== 'open')) {
      const ids = subtreeIds(db, root.id);
      applySubtreeAccess(db, ids, restricted ? { visibility: 'teamspace', ownerId: root.owner_id, teamspaceId: root.id } : { visibility: 'workspace', ownerId: root.owner_id, teamspaceId: null });
      if (!restricted) db.run('DELETE FROM nav_teamspace_requests WHERE teamspace_id = ?', ts.page_id);
      closeLost(ctx, ids);
    }
    publishTree(ctx, root, restricted !== (ts.access !== 'open'));
    return summary(db, getPageRow(db, root.id)!, db.get<TeamspaceRow>('SELECT * FROM nav_teamspaces WHERE page_id = ?', ts.page_id)!, actorId);
  });
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

function memberChanged(ctx: AppContext, root: PageRow, ts: TeamspaceRow, userId: string, lostAccess: boolean): void {
  publishTeamspaces(ctx, ts.workspace_id);
  // The sidebar of that user changes (section "Espaces d'équipe", restricted pages).
  ctx.bus.publish(ts.workspace_id, pageChange(root, true), userId);
  if (lostAccess && ts.access !== 'open') closeLost(ctx, subtreeIds(ctx.db, root.id));
}

export function joinTeamspace(ctx: AppContext, actorId: string, teamspaceId: string): TeamspaceSummary {
  const { db } = ctx;
  return db.tx(() => {
    const { root, ts } = requireTeamspace(db, actorId, teamspaceId);
    if (!memberRole(db, ts, actorId)) {
      if (ts.access !== 'open' && !canManageTeamspace(db, ts, actorId)) throw forbidden('Cet espace d’équipe est fermé : demandez l’accès.');
      ensureRow(db, ts);
      db.run("INSERT OR IGNORE INTO nav_teamspace_members (teamspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", ts.page_id, actorId, Date.now());
      db.run('DELETE FROM nav_teamspace_requests WHERE teamspace_id = ? AND user_id = ?', ts.page_id, actorId);
      memberChanged(ctx, root, ts, actorId, false);
    }
    return summary(db, root, ts, actorId);
  });
}

export function requestAccess(ctx: AppContext, actorId: string, teamspaceId: string): TeamspaceSummary {
  const { db } = ctx;
  return db.tx(() => {
    const { root, ts } = requireTeamspace(db, actorId, teamspaceId);
    if (memberRole(db, ts, actorId)) return summary(db, root, ts, actorId);
    if (ts.access !== 'closed') throw badRequest(ts.access === 'open' ? 'Cet espace d’équipe est ouvert : rejoignez-le directement.' : 'Espace d’équipe introuvable.');
    ensureRow(db, ts);
    const already = db.get('SELECT 1 AS x FROM nav_teamspace_requests WHERE teamspace_id = ? AND user_id = ?', ts.page_id, actorId);
    if (!already) {
      db.run('INSERT INTO nav_teamspace_requests (teamspace_id, user_id, created_at) VALUES (?, ?, ?)', ts.page_id, actorId, Date.now());
      let recipients = ownerIds(db, ts.page_id);
      if (recipients.length === 0) {
        recipients = db
          .all<{ user_id: string }>("SELECT user_id FROM members WHERE workspace_id = ? AND role IN ('owner', 'admin')", ts.workspace_id)
          .map((r) => r.user_id);
      }
      for (const userId of recipients) {
        // The notification names the teamspace root: only recipients who can read it get one.
        notify(ctx, { userId, workspaceId: ts.workspace_id, type: 'teamspace_request', actorId, pageId: root.id, excerpt: root.title });
      }
      publishTeamspaces(ctx, ts.workspace_id);
    }
    return summary(db, root, ts, actorId);
  });
}

export function answerRequest(ctx: AppContext, actorId: string, teamspaceId: string, userId: string, accept: boolean): void {
  const { db } = ctx;
  db.tx(() => {
    const { root, ts } = requireTeamspace(db, actorId, teamspaceId);
    requireManage(db, actorId, ts);
    if (db.run('DELETE FROM nav_teamspace_requests WHERE teamspace_id = ? AND user_id = ?', ts.page_id, userId) === 0) {
      throw notFound('Demande introuvable.');
    }
    if (accept && roleOf(db, userId, ts.workspace_id)) {
      db.run("INSERT OR IGNORE INTO nav_teamspace_members (teamspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", ts.page_id, userId, Date.now());
      notify(ctx, { userId, workspaceId: ts.workspace_id, type: 'teamspace_request_granted', actorId, pageId: root.id, excerpt: root.title });
    }
    memberChanged(ctx, root, ts, userId, false);
  });
}

export function addMember(ctx: AppContext, actorId: string, teamspaceId: string, userId: string, role: TeamspaceRole): void {
  const { db } = ctx;
  db.tx(() => {
    const { root, ts } = requireTeamspace(db, actorId, teamspaceId);
    requireManage(db, actorId, ts);
    if (!roleOf(db, userId, ts.workspace_id)) throw notFound('Membre introuvable.');
    ensureRow(db, ts);
    db.run(
      `INSERT INTO nav_teamspace_members (teamspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(teamspace_id, user_id) DO UPDATE SET role = excluded.role`,
      ts.page_id,
      userId,
      role,
      Date.now(),
    );
    if (role === 'member' && ownerIds(db, ts.page_id).length === 0) throw conflict('Il doit rester au moins un propriétaire.');
    db.run('DELETE FROM nav_teamspace_requests WHERE teamspace_id = ? AND user_id = ?', ts.page_id, userId);
    memberChanged(ctx, root, ts, userId, false);
  });
}

/** Removes a member (managers), or leaves (self). The last owner stays. */
export function removeMember(ctx: AppContext, actorId: string, teamspaceId: string, userId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const { root, ts } = requireTeamspace(db, actorId, teamspaceId);
    if (userId !== actorId) requireManage(db, actorId, ts);
    if (ts.access === 'open' && ts.is_default === 1) throw conflict('Tous les membres font partie d’un espace d’équipe par défaut.');
    const role = explicitRole(db, ts.page_id, userId);
    if (!role) throw notFound('Membre introuvable.');
    if (role === 'owner' && ownerIds(db, ts.page_id).length <= 1) throw conflict('Il doit rester au moins un propriétaire.');
    db.run('DELETE FROM nav_teamspace_members WHERE teamspace_id = ? AND user_id = ?', ts.page_id, userId);
    memberChanged(ctx, root, ts, userId, true);
  });
}

/** Workspace membership removed: drop teamspace memberships and requests in that workspace. */
export function forgetWorkspaceMember(db: Db, workspaceId: string, userId: string): void {
  db.run('DELETE FROM nav_teamspace_members WHERE user_id = ? AND teamspace_id IN (SELECT page_id FROM nav_teamspaces WHERE workspace_id = ?)', userId, workspaceId);
  db.run('DELETE FROM nav_teamspace_requests WHERE user_id = ? AND teamspace_id IN (SELECT page_id FROM nav_teamspaces WHERE workspace_id = ?)', userId, workspaceId);
}

// ---------------------------------------------------------------------------
// Converting a page into a teamspace
// ---------------------------------------------------------------------------

function conversionCheck(db: Db, actorId: string, pageId: string, access: TeamspaceAccess) {
  const { page, role } = requirePage(db, actorId, pageId, 'edit');
  // User decision: only workspace owners/admins turn a page into a teamspace (invisible page → 404 above).
  if (!canManageRole(role)) throw forbidden("Seuls les propriétaires et administrateurs de l'espace peuvent transformer une page en espace d'équipe.");
  if (page.kind !== 'page' || page.parent_type === 'database') throw badRequest('Seule une page peut devenir un espace d’équipe.');
  if (page.trashed_at !== null) throw badRequest('Restaurez la page avant de la transformer.');
  if (isTeamspaceRoot(page)) throw conflict('Cette page est déjà un espace d’équipe.');
  if (db.get('SELECT 1 AS x FROM pages WHERE id = ? AND is_template = 1', page.id)) throw badRequest('Un modèle ne peut pas devenir un espace d’équipe.');
  const to: Place = access === 'open' ? { visibility: 'workspace', ownerId: page.owner_id, teamspaceId: null } : { visibility: 'teamspace', ownerId: page.owner_id, teamspaceId: page.id };
  const fromTeam = teamspaceOfPage(db, page.id);
  const effect = accessEffect(db, page, placeOf(page), to, { from: fromTeam, to: null }, access === 'open' ? [] : [actorId]);
  effect.to.teamspace = { id: page.id, title: page.title, access };
  return { page, to, effect };
}

/** Default mode that widens nothing: private page → private teamspace, shared page → open. */
export const defaultConversionAccess = (page: Pick<PageRow, 'visibility'>): TeamspaceAccess =>
  page.visibility === 'workspace' ? 'open' : 'private';

export function previewConversion(db: Db, actorId: string, pageId: string, access: TeamspaceAccess): AccessEffect {
  return conversionCheck(db, actorId, pageId, access).effect;
}

export function convertToTeamspace(ctx: AppContext, actorId: string, pageId: string, access: TeamspaceAccess, confirmAccess: boolean): PageRow {
  const { db } = ctx;
  return db.tx(() => {
    const { page, to, effect } = conversionCheck(db, actorId, pageId, access);
    if ((effect.widens || effect.narrows) && !confirmAccess) {
      throw conflict('Cette transformation change qui peut lire ces pages : confirmez-la explicitement.');
    }
    const now = Date.now();
    const position = positionForInsert(
      db.all<{ id: string; position: string }>("SELECT id, position FROM pages WHERE parent_type = 'workspace' AND parent_id = ? AND id != ?", page.workspace_id, page.id),
      undefined,
    );
    const format = { ...parseJson<PageFormat>(page.format, {}), teamspaceRoot: true };
    db.run(
      `UPDATE pages SET parent_type = 'workspace', parent_id = ?, position = ?, format = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
      page.workspace_id,
      position,
      JSON.stringify(format),
      now,
      actorId,
      page.id,
    );
    db.run(
      `INSERT INTO nav_teamspaces (page_id, workspace_id, access, is_default, description, created_at, created_by) VALUES (?, ?, ?, 0, '', ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET access = excluded.access, is_default = 0`,
      page.id,
      page.workspace_id,
      access,
      now,
      actorId,
    );
    db.run(
      `INSERT INTO nav_teamspace_members (teamspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
       ON CONFLICT(teamspace_id, user_id) DO UPDATE SET role = 'owner'`,
      page.id,
      actorId,
      now,
    );
    const ids = subtreeIds(db, page.id);
    applySubtreeAccess(db, ids, to);
    db.run('DELETE FROM nav_folder_pages WHERE page_id = ?', page.id);
    closeLost(ctx, ids);
    const moved = getPageRow(db, page.id)!;
    emitPage(ctx, moved, true, { everyone: true });
    publishTeamspaces(ctx, page.workspace_id);
    return moved;
  });
}


/** Sidebar tree: access mode and membership of the teamspace roots (navigation module). */
export function decorateTeamspaceNodes(db: Db, userId: string, rows: PageRow[], nodes: TreeNode[]): TreeNode[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return nodes.map((n) => {
    if (!n.isTeamspace) return n;
    const row = byId.get(n.id);
    const ts = row ? teamspaceOf(db, row) : null;
    return ts ? { ...n, teamspaceAccess: ts.access, teamspaceMember: !!memberRole(db, ts, userId) } : n;
  });
}
