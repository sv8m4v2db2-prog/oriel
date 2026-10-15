import type { FastifyInstance, FastifyRequest } from 'fastify';
import { newId, type AuthConfigResponse, type HealthResponse, type SignupMode } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { InviteRow, UserRow } from '../db/rows.js';
import { toUser } from '../db/rows.js';
import { badRequest, conflict, forbidden, rateLimited, unauthorized } from '../errors.js';
import { clearSessionCookie, parse, requireAuth, setSessionCookie } from '../http.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import { clientKey } from '../auth/rateLimit.js';
import { revokeResetTokens } from '../auth/passwordReset.js';
import { changePasswordSchema, loginSchema, signupSchema, updateMeSchema } from '../schemas.js';
import { createWorkspace, firstName, sessionResponse } from '../services/workspaces.js';
import { VERSION } from '../version.js';
import { ensureLocalUser, isLoopback } from '../local.js';
import { registerPasswordResetRoutes } from '../auth/resetRoutes.js';
import { notifyInviteAccepted } from '../collab/invites.js';
import { completeFirstFactor } from '../auth/loginFlow.js';
import { relyingParty } from '../auth/passkeys.js';
import { oidcLabel } from '../auth/oidc.js';
import { hasPassword, logSecurity } from '../auth/security.js';
import { requireRecentAuth } from '../auth/stepUp.js';
import { registerAccountSecurityRoutes } from '../auth/securityRoutes.js';

export function currentSignupMode(ctx: AppContext): SignupMode {
  const value = ctx.db.getMeta('signup_mode');
  return value === 'open' || value === 'invite' || value === 'first-user' ? value : ctx.config.signupMode;
}

/** A usable invite (not revoked, not expired) or null. */
export function findValidInvite(ctx: AppContext, token: string): InviteRow | null {
  if (!token || token.length > 200) return null;
  const invite = ctx.db.get<InviteRow>('SELECT * FROM invites WHERE token = ?', token);
  if (!invite || invite.revoked === 1 || invite.expires_at <= Date.now()) return null;
  return invite;
}

function checkRateLimit(ctx: AppContext, req: FastifyRequest): void {
  if (!ctx.authLimiter.hit(`auth:${clientKey(req.ip)}`)) throw rateLimited();
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, version: VERSION }));

  registerPasswordResetRoutes(app, ctx);

  app.get('/api/auth/config', async (): Promise<AuthConfigResponse> => ({
    signupMode: currentSignupMode(ctx),
    hasUsers: !!db.get('SELECT 1 AS x FROM users LIMIT 1'),
    version: VERSION,
    passkeys: relyingParty(ctx) !== null,
    sso: ctx.config.localMode || !oidcLabel(ctx) ? null : { label: oidcLabel(ctx)! },
  }));

  registerAccountSecurityRoutes(app, ctx);

  app.post('/api/auth/signup', async (req, reply) => {
    checkRateLimit(ctx, req);
    const body = parse(signupSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const { user, token } = db.tx(() => {
      const hasUsers = !!db.get('SELECT 1 AS x FROM users LIMIT 1');
      let invite: InviteRow | null = null;
      if (body.inviteToken) {
        invite = findValidInvite(ctx, body.inviteToken);
        if (!invite) throw badRequest("Ce lien d'invitation est invalide ou a expiré.");
      }
      if (hasUsers && !invite && currentSignupMode(ctx) !== 'open') {
        throw forbidden("Les inscriptions sont fermées. Demandez un lien d'invitation à un administrateur.");
      }
      if (db.get('SELECT 1 AS x FROM users WHERE email = ?', body.email)) {
        throw conflict('Un compte existe déjà avec cette adresse e-mail.');
      }
      const id = newId();
      const now = Date.now();
      db.run(
        'INSERT INTO users (id, email, name, avatar_url, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
        id,
        body.email,
        body.name,
        passwordHash,
        !hasUsers,
        now,
        now,
      );
      if (invite) {
        db.run('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', invite.workspace_id, id, invite.role, now);
        db.run('UPDATE invites SET uses = uses + 1 WHERE token = ?', invite.token);
        ctx.bus.publish(invite.workspace_id, { entity: 'members', workspaceId: invite.workspace_id });
        notifyInviteAccepted(ctx, invite, id);
      } else {
        createWorkspace(ctx, id, `Espace de ${firstName(body.name)}`, null, { welcomePage: true });
      }
      const session = createSession(db, id, req.headers['user-agent']);
      return { user: db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!, token: session.token };
    });
    setSessionCookie(req, reply, token);
    return sessionResponse(db, user);
  });

  app.post('/api/auth/login', async (req, reply) => {
    checkRateLimit(ctx, req);
    const body = parse(loginSchema, req.body);
    const user = db.get<UserRow>('SELECT * FROM users WHERE email = ?', body.email.trim());
    const generic = () => unauthorized('E-mail ou mot de passe incorrect.');
    if (!user) {
      await burnPasswordCheck(body.password);
      throw generic();
    }
    if (!(await verifyPassword(body.password, user.password_hash))) throw generic();
    // Accounts with a second factor get a pending challenge instead (auth/loginFlow.ts).
    return completeFirstFactor(ctx, req, reply, user, 'pwd');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      deleteSession(db, req.auth.sessionId);
      ctx.bus.closeSession(req.auth.sessionId);
      ctx.collab.closeForSession(req.auth.sessionId);
    }
    clearSessionCookie(req, reply);
    return { ok: true as const };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (req.auth) return sessionResponse(db, req.auth.user);
    if (ctx.config.localMode && isLoopback(req.socket.remoteAddress)) {
      const user = ensureLocalUser(ctx);
      const session = createSession(db, user.id, req.headers['user-agent'], 'local');
      setSessionCookie(req, reply, session.token);
      return sessionResponse(db, user);
    }
    throw unauthorized();
  });

  app.patch('/api/me', async (req) => {
    const { user } = requireAuth(req);
    const body = parse(updateMeSchema, req.body);
    db.tx(() => {
      if (body.name !== undefined) db.run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', body.name, Date.now(), user.id);
      if (body.avatarUrl !== undefined) db.run('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?', body.avatarUrl, Date.now(), user.id);
      for (const { workspace_id } of db.all<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE user_id = ?', user.id)) {
        ctx.bus.publish(workspace_id, { entity: 'members', workspaceId: workspace_id });
      }
    });
    return { user: toUser(db.get<UserRow>('SELECT * FROM users WHERE id = ?', user.id)!) };
  });

  app.post('/api/me/password', async (req) => {
    const auth = requireAuth(req);
    // The current password is a secret worth brute-forcing with a stolen session: same quota as login.
    if (!ctx.authLimiter.hit(`password:${auth.user.id}`)) throw rateLimited();
    const body = parse(changePasswordSchema, req.body);
    // 400 (not 401) so that the client does not treat it as an expired session. The current password is
    // the confirmation of identity (A06); an account without password (SSO, passkey) re-authenticates.
    if (hasPassword(auth.user)) {
      if (!(await verifyPassword(body.currentPassword, auth.user.password_hash))) throw badRequest('Mot de passe actuel incorrect.');
    } else {
      requireRecentAuth(ctx, req);
    }
    const hash = await hashPassword(body.newPassword);
    const revoked = db.tx(() => {
      const ids = db
        .all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId)
        .map((r) => r.id);
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), auth.user.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId);
      // A pending reset link (e-mailed, or created by an admin) must not override the new password.
      revokeResetTokens(db, auth.user.id);
      logSecurity(db, { userId: auth.user.id, event: 'password_changed', ip: req.ip });
      return ids;
    });
    // Live sockets opened with the revoked sessions must not outlive them.
    for (const id of revoked) {
      ctx.bus.closeSession(id);
      ctx.collab.closeForSession(id);
    }
    return { ok: true as const };
  });
}
