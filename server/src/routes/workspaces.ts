import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LIMITS,
  type AcceptInviteResponse,
  type FavoritesResponse,
  type InviteInfoResponse,
  type RecentResponse,
  type SearchResponse,
  type TrashResponse,
  type TreeResponse,
  type WorkspaceRole,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import {
  PAGE_COLUMNS,
  toInvite,
  toMember,
  toTreeNode,
  type InviteRow,
  type PageRow,
  type UserRow,
  type WorkspaceRow,
} from '../db/rows.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { canEditRole, canManageRole, requireWorkspace, visiblePageClause, visiblePageParams } from '../access.js';
import { createInviteSchema, createWorkspaceSchema, updateMemberSchema, updateWorkspaceSchema } from '../schemas.js';
import { createWorkspace, listWorkspaceSummaries, workspaceSummary } from '../services/workspaces.js';
import { ancestorsCrumbs, searchPages } from '../services/search.js';
import { decorateTeamspaceNodes, forgetWorkspaceMember } from '../services/teamspaces.js';
import { forgetNavigationOf } from '../services/navigation.js';
import { findValidInvite } from './auth.js';
import { pagesFor } from '../services/propertyAccess.js';

const widParams = z.object({ wid: idParam });
const memberParams = z.object({ wid: idParam, uid: idParam });
const inviteParams = z.object({ wid: idParam, token: z.string().min(1).max(200) });
const tokenParams = z.object({ token: z.string().min(1).max(200) });
const searchQuery = z.object({ q: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

/** Readable pages (navigation module: also closed/private teamspaces); two params, see visiblePageParams. */
const visibleClause = visiblePageClause('p');

/** Invite links are bearer tokens: those created by someone who loses the right to invite stop working. */
const revokeInvitesOf = (ctx: AppContext, workspaceId: string, userId: string) =>
  ctx.db.run('UPDATE invites SET revoked = 1 WHERE workspace_id = ? AND created_by = ? AND revoked = 0', workspaceId, userId);

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/workspaces', async (req) => listWorkspaceSummaries(db, requireAuth(req).user.id));

  app.post('/api/workspaces', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(createWorkspaceSchema, req.body);
    const ws = createWorkspace(ctx, user.id, body.name, body.icon ?? null);
    return workspaceSummary(db, user.id, ws.id);
  });

  app.get('/api/workspaces/:wid', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return workspaceSummary(db, user.id, wid);
  });

  app.patch('/api/workspaces/:wid', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(updateWorkspaceSchema, req.body);
    db.tx(() => {
      const { workspace } = requireWorkspace(db, user.id, wid, 'manage');
      db.run(
        'UPDATE workspaces SET name = ?, icon = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        body.name ?? workspace.name,
        body.icon !== undefined ? body.icon : workspace.icon,
        Date.now(),
        wid,
      );
      ctx.bus.publish(wid, { entity: 'workspace', id: wid });
    });
    return workspaceSummary(db, user.id, wid);
  });

  app.delete('/api/workspaces/:wid', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    let pageIds: string[] = [];
    db.tx(() => {
      requireWorkspace(db, user.id, wid, 'owner');
      const memberIds = db.all<{ user_id: string }>('SELECT user_id FROM members WHERE workspace_id = ?', wid).map((m) => m.user_id);
      pageIds = db.all<{ id: string }>('SELECT id FROM pages WHERE workspace_id = ?', wid).map((p) => p.id);
      db.run('DELETE FROM search WHERE workspace_id = ?', wid);
      db.run('DELETE FROM favorites WHERE workspace_id = ?', wid);
      db.run('DELETE FROM workspaces WHERE id = ?', wid);
      ctx.bus.workspaceDeleted(wid, memberIds);
    });
    ctx.collab.closeDocuments(pageIds);
    return { ok: true as const };
  });

  // --- tree, favorites, recent, trash, search --------------------------------

  app.get('/api/workspaces/:wid/tree', async (req): Promise<TreeResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    const rows = db.all<PageRow>(
      `SELECT ${PAGE_COLUMNS}, p.is_template FROM pages p
       WHERE p.workspace_id = ? AND p.trashed_at IS NULL AND p.parent_type != 'database' AND ${visibleClause}
       ORDER BY p.position, p.id`,
      wid,
      ...visiblePageParams(user.id),
    );
    return { nodes: decorateTeamspaceNodes(db, user.id, rows, rows.map(toTreeNode)) };
  });

  app.get('/api/workspaces/:wid/favorites', async (req): Promise<FavoritesResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    const rows = db.all<PageRow>(
      `SELECT p.* FROM favorites f JOIN pages p ON p.id = f.page_id
       WHERE f.user_id = ? AND f.workspace_id = ? AND p.trashed_at IS NULL AND ${visibleClause}
       ORDER BY f.position, f.page_id`,
      user.id,
      wid,
      ...visiblePageParams(user.id),
    );
    return { favorites: rows.map(toTreeNode) };
  });

  app.get('/api/workspaces/:wid/recent', async (req): Promise<RecentResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    const rows = db.all<PageRow & { visited_at: number }>(
      `SELECT p.*, v.visited_at AS visited_at FROM visits v JOIN pages p ON p.id = v.page_id
       WHERE v.user_id = ? AND v.workspace_id = ? AND p.trashed_at IS NULL AND p.is_template = 0 AND ${visibleClause}
       ORDER BY v.visited_at DESC LIMIT 30`,
      user.id,
      wid,
      ...visiblePageParams(user.id),
    );
    return { pages: rows.map((r) => ({ ...toTreeNode(r), visitedAt: r.visited_at, path: ancestorsCrumbs(db, r.id) })) };
  });

  app.get('/api/workspaces/:wid/trash', async (req): Promise<TrashResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const { role } = requireWorkspace(db, user.id, wid);
    const rows = db.all<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM pages p
       WHERE p.workspace_id = ? AND p.trash_root = 1 AND p.trashed_at IS NOT NULL AND ${visibleClause}
       ORDER BY p.trashed_at DESC, p.id LIMIT 1000`,
      wid,
      ...visiblePageParams(user.id),
    );
    // Trashed rows lose the properties hidden from the viewer (D30, G3).
    const pages = pagesFor(db, role, rows);
    return { items: rows.map((r, i) => ({ page: pages[i]!, path: ancestorsCrumbs(db, r.id) })) };
  });

  app.get('/api/workspaces/:wid/search', async (req): Promise<SearchResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const query = parse(searchQuery, req.query);
    requireWorkspace(db, user.id, wid);
    return { results: searchPages(db, user.id, wid, query.q ?? '', query.limit ?? 20) };
  });

  // --- members ---------------------------------------------------------------

  const listMembers = (wid: string) =>
    db
      .all<UserRow & { role: WorkspaceRole; joined_at: number }>(
        `SELECT u.*, m.role AS role, m.joined_at AS joined_at FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY m.joined_at, u.name`,
        wid,
      )
      .map(toMember);

  app.get('/api/workspaces/:wid/members', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    return listMembers(wid);
  });

  app.patch('/api/workspaces/:wid/members/:uid', async (req) => {
    const { user } = requireAuth(req);
    const { wid, uid } = parse(memberParams, req.params);
    const body = parse(updateMemberSchema, req.body);
    let changed: { from: WorkspaceRole; to: WorkspaceRole } | null = null;
    db.tx(() => {
      const { role: actorRole } = requireWorkspace(db, user.id, wid, 'manage');
      const target = db.get<{ role: WorkspaceRole }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', wid, uid);
      if (!target) throw notFound('Membre introuvable.');
      if ((target.role === 'owner' || body.role === 'owner') && actorRole !== 'owner') {
        throw forbidden('Seuls les propriétaires peuvent gérer le rôle de propriétaire.');
      }
      if (target.role === 'owner' && body.role !== 'owner') {
        const owners = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'", wid)!.n;
        if (owners <= 1) throw conflict('Il doit rester au moins un propriétaire.');
      }
      if (target.role !== body.role) {
        db.run('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', body.role, wid, uid);
        if (!canManageRole(body.role)) revokeInvitesOf(ctx, wid, uid);
        changed = { from: target.role, to: body.role };
        ctx.bus.publish(wid, { entity: 'members', workspaceId: wid });
        ctx.bus.publish(wid, { entity: 'workspace', id: wid }, uid);
      }
    });
    if (changed) ctx.collab.setReadOnlyForUser(uid, wid, !canEditRole((changed as { to: WorkspaceRole }).to));
    const member = listMembers(wid).find((m) => m.user.id === uid);
    if (!member) throw notFound('Membre introuvable.');
    return member;
  });

  app.delete('/api/workspaces/:wid/members/:uid', async (req) => {
    const { user } = requireAuth(req);
    const { wid, uid } = parse(memberParams, req.params);
    db.tx(() => {
      const { role: actorRole } = requireWorkspace(db, user.id, wid, uid === user.id ? 'read' : 'manage');
      const target = db.get<{ role: WorkspaceRole }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', wid, uid);
      if (!target) throw notFound('Membre introuvable.');
      if (target.role === 'owner') {
        if (uid !== user.id && actorRole !== 'owner') throw forbidden('Seuls les propriétaires peuvent retirer un propriétaire.');
        const owners = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'", wid)!.n;
        if (owners <= 1) throw conflict('Il doit rester au moins un propriétaire.');
      }
      db.run('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', wid, uid);
      db.run('DELETE FROM favorites WHERE workspace_id = ? AND user_id = ?', wid, uid);
      // Navigation module: teamspace memberships, requests, shortcuts and private folders.
      forgetWorkspaceMember(db, wid, uid);
      forgetNavigationOf(db, wid, uid);
      revokeInvitesOf(ctx, wid, uid);
      ctx.bus.publish(wid, { entity: 'members', workspaceId: wid });
      ctx.bus.revoke(wid, uid);
    });
    ctx.collab.closeForUser(uid, wid);
    return { ok: true as const };
  });

  // --- invites -----------------------------------------------------------------

  app.get('/api/workspaces/:wid/invites', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'manage');
    return db
      .all<InviteRow>('SELECT * FROM invites WHERE workspace_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC', wid, Date.now())
      .map((r) => toInvite(r, ctx.config.publicUrl));
  });

  app.post('/api/workspaces/:wid/invites', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(createInviteSchema, req.body);
    const invite = db.tx(() => {
      requireWorkspace(db, user.id, wid, 'manage');
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      const days = body.expiresInDays ?? LIMITS.inviteDefaultDays;
      db.run(
        'INSERT INTO invites (token, workspace_id, role, created_by, created_at, expires_at, uses, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
        token,
        wid,
        body.role,
        user.id,
        now,
        now + days * 24 * 60 * 60 * 1000,
      );
      ctx.bus.publish(wid, { entity: 'members', workspaceId: wid });
      return db.get<InviteRow>('SELECT * FROM invites WHERE token = ?', token)!;
    });
    return toInvite(invite, ctx.config.publicUrl);
  });

  app.delete('/api/workspaces/:wid/invites/:token', async (req) => {
    const { user } = requireAuth(req);
    const { wid, token } = parse(inviteParams, req.params);
    db.tx(() => {
      requireWorkspace(db, user.id, wid, 'manage');
      if (db.run('UPDATE invites SET revoked = 1 WHERE token = ? AND workspace_id = ?', token, wid) === 0) {
        throw notFound('Invitation introuvable.');
      }
      ctx.bus.publish(wid, { entity: 'members', workspaceId: wid });
    });
    return { ok: true as const };
  });

  app.get('/api/invites/:token', async (req): Promise<InviteInfoResponse> => {
    const { token } = parse(tokenParams, req.params);
    const invite = findValidInvite(ctx, token);
    const ws = invite ? db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', invite.workspace_id) : undefined;
    if (!invite || !ws) return { valid: false, workspace: null, role: null, invitedBy: null };
    const inviter = db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', invite.created_by);
    return {
      valid: true,
      workspace: { id: ws.id, name: ws.name, icon: ws.icon },
      role: invite.role,
      invitedBy: inviter ? { name: inviter.name } : null,
    };
  });

  app.post('/api/invites/:token/accept', async (req): Promise<AcceptInviteResponse> => {
    const { user } = requireAuth(req);
    const { token } = parse(tokenParams, req.params);
    const wid = db.tx(() => {
      const invite = findValidInvite(ctx, token);
      if (!invite) throw notFound("Ce lien d'invitation est invalide ou a expiré.");
      const existing = db.get('SELECT 1 AS x FROM members WHERE workspace_id = ? AND user_id = ?', invite.workspace_id, user.id);
      if (!existing) {
        db.run('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', invite.workspace_id, user.id, invite.role, Date.now());
        db.run('UPDATE invites SET uses = uses + 1 WHERE token = ?', invite.token);
        ctx.bus.publish(invite.workspace_id, { entity: 'members', workspaceId: invite.workspace_id });
      }
      return invite.workspace_id;
    });
    return { workspace: workspaceSummary(db, user.id, wid) };
  });
}
