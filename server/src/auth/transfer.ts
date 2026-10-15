// Transfer of a workspace to another owner (A08): proposed by an owner, accepted by the recipient,
// both with a recent re-authentication (A06). The recipient becomes owner, the author admin.
// Cookie-only routes (auth/apiTokens.ts COOKIE_ONLY).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { newId, SECURITY_LIMITS, type TransfersResponse, type WorkspaceRole, type WorkspaceTransfer } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { toPublicUser, type UserRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requireWorkspace } from '../access.js';
import type { Auth } from './sessions.js';
import { logSecurity, securityMail, sendSecurityMail } from './security.js';
import { requireRecentAuth } from './stepUp.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const widParams = z.object({ wid: idParam });
const idParams = z.object({ id: idParam });
const proposeSchema = z.object({ toUserId: idParam });

interface TransferRow {
  id: string;
  workspace_id: string;
  from_user_id: string;
  to_user_id: string;
  created_at: number;
  expires_at: number;
}

function cookieAuth(req: FastifyRequest): Auth {
  const auth = requireAuth(req);
  if (req.apiToken) throw forbidden("Cette action n'est pas disponible avec un jeton d'API.");
  return auth;
}

export function registerTransferRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const toDto = (row: TransferRow): WorkspaceTransfer => {
    const user = (id: string) => toPublicUser(db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', row.workspace_id)?.name ?? '',
      from: user(row.from_user_id),
      to: user(row.to_user_id),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  };
  const live = (row: TransferRow | undefined, now = Date.now()) => (row && row.expires_at > now ? row : undefined);
  const roleIn = (wid: string, uid: string) =>
    db.get<{ role: WorkspaceRole }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', wid, uid)?.role ?? null;
  const mail = (userId: string, subject: string, text: string) => {
    const u = db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (u) sendSecurityMail(ctx, securityMail(u.email, subject, [`Bonjour ${u.name},`, text]));
  };

  app.get('/api/me/transfers', async (req): Promise<TransfersResponse> => {
    const { user } = cookieAuth(req);
    const now = Date.now();
    const rows = (sql: string) => db.all<TransferRow>(sql, user.id, now).map(toDto);
    return {
      incoming: rows('SELECT * FROM workspace_transfers WHERE to_user_id = ? AND expires_at > ? ORDER BY created_at DESC'),
      outgoing: rows('SELECT * FROM workspace_transfers WHERE from_user_id = ? AND expires_at > ? ORDER BY created_at DESC'),
    };
  });

  app.post('/api/workspaces/:wid/transfer', async (req): Promise<WorkspaceTransfer> => {
    const { user } = cookieAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(proposeSchema, req.body);
    const { workspace } = requireWorkspace(db, user.id, wid, 'owner');
    requireRecentAuth(ctx, req);
    if (body.toUserId === user.id) throw badRequest('Choisissez un autre membre de l’espace.');
    // Unknown id and non-member answer the same way.
    if (!roleIn(wid, body.toUserId)) throw notFound('Membre introuvable.');
    const now = Date.now();
    const id = newId();
    db.tx(() => {
      db.run('DELETE FROM workspace_transfers WHERE workspace_id = ?', wid);
      db.run(
        'INSERT INTO workspace_transfers (id, workspace_id, from_user_id, to_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        wid,
        user.id,
        body.toUserId,
        now,
        now + SECURITY_LIMITS.transferDays * DAY_MS,
      );
      logSecurity(db, { userId: user.id, event: 'transfer_proposed', ip: req.ip, detail: workspace.name });
    });
    mail(
      body.toUserId,
      `${user.name} vous propose de devenir propriétaire de « ${workspace.name} »`,
      `${user.name} vous propose de devenir propriétaire de l’espace « ${workspace.name} » sur Oriel. Ouvrez Oriel pour accepter ou refuser. La proposition expire dans ${SECURITY_LIMITS.transferDays} jours.`,
    );
    return toDto(db.get<TransferRow>('SELECT * FROM workspace_transfers WHERE id = ?', id)!);
  });

  app.delete('/api/workspaces/:wid/transfer', async (req) => {
    const { user } = cookieAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'owner');
    const row = live(db.get<TransferRow>('SELECT * FROM workspace_transfers WHERE workspace_id = ?', wid));
    if (!row) throw notFound('Aucun transfert en attente.');
    db.run('DELETE FROM workspace_transfers WHERE id = ?', row.id);
    logSecurity(db, { userId: user.id, event: 'transfer_cancelled', ip: req.ip });
    return { ok: true as const };
  });

  /** A pending transfer addressed to the caller (anything else: 404). */
  const incoming = (req: FastifyRequest, userId: string) => {
    const { id } = parse(idParams, req.params);
    const row = live(db.get<TransferRow>('SELECT * FROM workspace_transfers WHERE id = ?', id));
    if (!row || row.to_user_id !== userId) throw notFound('Proposition de transfert introuvable ou expirée.');
    return row;
  };

  app.post('/api/transfers/:id/accept', async (req) => {
    const { user } = cookieAuth(req);
    incoming(req, user.id);
    requireRecentAuth(ctx, req);
    const row = db.tx(() => {
      const t = incoming(req, user.id);
      const wid = t.workspace_id;
      // Re-checked at acceptance: the author may have lost ownership, the recipient may have left.
      if (roleIn(wid, t.from_user_id) !== 'owner') {
        db.run('DELETE FROM workspace_transfers WHERE id = ?', t.id);
        throw conflict('L’auteur de la proposition n’est plus propriétaire de cet espace.');
      }
      if (!roleIn(wid, user.id)) throw notFound('Proposition de transfert introuvable ou expirée.');
      db.run("UPDATE members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?", wid, user.id);
      db.run("UPDATE members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?", wid, t.from_user_id);
      db.run('DELETE FROM workspace_transfers WHERE id = ?', t.id);
      const name = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', wid)?.name ?? '';
      logSecurity(db, { userId: user.id, event: 'transfer_accepted', ip: req.ip, detail: name });
      logSecurity(db, { userId: t.from_user_id, actorId: user.id, event: 'transfer_accepted', detail: name });
      ctx.bus.publish(wid, { entity: 'members', workspaceId: wid });
      ctx.bus.publish(wid, { entity: 'workspace', id: wid }, user.id);
      ctx.bus.publish(wid, { entity: 'workspace', id: wid }, t.from_user_id);
      return { ...t, name };
    });
    // A viewer who becomes owner gets write access on open documents.
    ctx.collab.setReadOnlyForUser(user.id, row.workspace_id, false);
    mail(row.from_user_id, `Transfert de « ${row.name} » accepté`, `${user.name} est désormais propriétaire de l’espace « ${row.name} ». Vous en restez administrateur.`);
    mail(user.id, `Vous êtes propriétaire de « ${row.name} »`, `Vous êtes désormais propriétaire de l’espace « ${row.name} » sur Oriel.`);
    return { ok: true as const };
  });

  app.post('/api/transfers/:id/decline', async (req) => {
    const { user } = cookieAuth(req);
    const t = incoming(req, user.id);
    db.run('DELETE FROM workspace_transfers WHERE id = ?', t.id);
    logSecurity(db, { userId: t.from_user_id, actorId: user.id, event: 'transfer_declined' });
    const name = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', t.workspace_id)?.name ?? '';
    mail(t.from_user_id, `Transfert de « ${name} » refusé`, `${user.name} a refusé de devenir propriétaire de l’espace « ${name} ».`);
    return { ok: true as const };
  });
}
