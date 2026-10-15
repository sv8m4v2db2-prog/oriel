// HTTP routes of account security (wave G9, docs/SPEC.md « Sécurité des comptes »):
// - second step of a login, sign-in with a passkey, re-authentication (A05, A06);
// - /api/me/security: authenticator app, recovery codes, passkeys, security log; /api/me/email;
// - instance administration: two-factor status of the accounts, reset (logged);
// - workspace two-factor policy.
// Every route under /api/me/security, /api/me/email and the workspace policy is cookie-only
// (auth/apiTokens.ts COOKIE_ONLY): an API token never reaches account security settings.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SECURITY_LIMITS,
  type AdminUserSecurity,
  type PasskeyOptionsResponse,
  type ReauthMethod,
  type ReauthOptionsResponse,
  type RecoveryCodesResponse,
  type SecurityLogEntry,
  type SecurityStatus,
  type TotpSetupResponse,
  type WorkspaceSecurityPolicy,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { toPublicUser, toUser, type UserRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound, rateLimited, unauthorized } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requireWorkspace } from '../access.js';
import type { Auth } from './sessions.js';
import { verifyPassword } from './password.js';
import { MFA_COOKIE, openSession } from './loginFlow.js';
import {
  authenticationOptions,
  passkeyChallenge,
  passkeyName,
  registrationOptions,
  relyingParty,
  verifyAssertion,
  verifyChallengeAssertion,
  verifyRegistration,
} from './passkeys.js';
import {
  challengeData,
  checkTotp,
  consumeChallenge,
  consumeRecoveryCode,
  failChallenge,
  findChallenge,
  generateRecoveryCodes,
  hasPassword,
  ipKey,
  isProtected,
  logSecurity,
  passkeyCount,
  recoveryCodesRemaining,
  requiringWorkspaces,
  revokeSessions,
  sealTotpSecret,
  securityLimiters,
  securityMail,
  sendSecurityMail,
  totpEnabled,
  totpRow,
  enrollmentRequired,
  updateChallengeData,
} from './security.js';
import { markReauthenticated, reauthUntil, requireRecentAuth } from './stepUp.js';
import { generateTotpSecret, otpauthUri } from './totp.js';
import { revokeResetTokens } from './passwordReset.js';
import { applyPasswordReset } from './resetRoutes.js';
import { identitiesOf, oidcLabel } from './oidc.js';
import { registerTransferRoutes } from './transfer.js';
import { registerOidcRoutes } from './oidc.js';
import { registerDomainRoutes } from './domains.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const code = z.string().trim().max(20);
const webauthnJson = z.record(z.string(), z.unknown());
const mfaSchema = z.object({
  ticket: z.string().max(200).optional(),
  code: code.optional(),
  recoveryCode: z.string().max(40).optional(),
  passkey: webauthnJson.optional(),
});
const ticketSchema = z.object({ ticket: z.string().max(200).optional() });
const passkeyLoginSchema = z.object({ ticket: z.string().max(200), response: webauthnJson });
const reauthSchema = z.object({
  password: z.string().max(256).optional(),
  code: code.optional(),
  ticket: z.string().max(200).optional(),
  passkey: webauthnJson.optional(),
});
const confirmSchema = z.object({ code });
const registerSchema = z.object({ ticket: z.string().max(200), response: webauthnJson, name: z.string().max(200).optional() });
const renameSchema = z.object({ name: z.string().trim().min(1).max(SECURITY_LIMITS.passkeyNameMax) });
const emailSchema = z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email()) });
const policySchema = z.object({ require2fa: z.boolean(), graceDays: z.number().int().min(0).max(SECURITY_LIMITS.graceDaysMax).optional() });
const idParams = z.object({ id: idParam });
const uidParams = z.object({ uid: idParam });
const widParams = z.object({ wid: idParam });

const wrongCode = () => badRequest('Code incorrect ou expiré.');

/** Cookie session required (an API token never manages account security). */
function cookieAuth(req: FastifyRequest): Auth {
  const auth = requireAuth(req);
  if (req.apiToken) throw forbidden("Cette action n'est pas disponible avec un jeton d'API.");
  return auth;
}

function notLocal(ctx: AppContext): void {
  if (ctx.config.localMode) throw badRequest('Indisponible en mode local : un seul utilisateur, connecté automatiquement depuis cet ordinateur.');
}

function requireInstanceAdmin(req: FastifyRequest): Auth {
  const auth = cookieAuth(req);
  if (auth.user.is_admin !== 1) throw forbidden("Réservé aux administrateurs de l'instance.");
  return auth;
}

/** Removing this method would leave the account unprotected while a workspace requires a second factor. */
function assertStillProtectedAfter(ctx: AppContext, userId: string, remove: 'totp' | 'passkey'): void {
  const required = requiringWorkspaces(ctx.db, userId);
  if (required.length === 0) return;
  const left = remove === 'totp' ? passkeyCount(ctx.db, userId) > 0 : totpEnabled(ctx.db, userId) || passkeyCount(ctx.db, userId) > 1;
  if (!left) {
    throw conflict(`L’espace « ${required[0]!.workspaceName} » impose la double authentification : gardez au moins une méthode (application ou clé d’accès).`);
  }
}

function reauthMethods(ctx: AppContext, user: UserRow): ReauthMethod[] {
  const methods: ReauthMethod[] = [];
  const protectedAccount = isProtected(ctx.db, user.id);
  if (passkeyCount(ctx.db, user.id) > 0 && relyingParty(ctx)) methods.push('passkey');
  if (totpEnabled(ctx.db, user.id)) methods.push('totp');
  // With a second factor, the password alone never confirms an identity.
  if (!protectedAccount && hasPassword(user)) methods.push('password');
  // Nor does a sign-in at the provider (a first factor too, often silent): QA-G9-02.
  if (!protectedAccount && oidcLabel(ctx) && identitiesOf(ctx.db, user.id).length > 0) methods.push('sso');
  return methods;
}

function notify(ctx: AppContext, user: Pick<UserRow, 'email' | 'name'>, subject: string, what: string): void {
  sendSecurityMail(
    ctx,
    securityMail(user.email, subject, [
      `Bonjour ${user.name},`,
      what,
      'Si vous n’êtes pas à l’origine de ce changement, contactez rapidement l’administrateur de votre instance Oriel.',
    ]),
  );
}

export function registerAccountSecurityRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const perIp = (req: FastifyRequest, scope: string) => {
    if (!ctx.authLimiter.hit(`${scope}:${ipKey(req.ip)}`)) throw rateLimited();
  };
  const perUser = (userId: string) => {
    if (!securityLimiters(ctx).secondFactor.hit(userId)) throw rateLimited('Trop de tentatives. Réessayez dans quelques minutes.');
  };

  // -------------------------------------------------------------------------
  // Second step of a login
  // -------------------------------------------------------------------------

  const pendingLogin = (req: FastifyRequest, ticket: string | undefined) => findChallenge(db, 'mfa-login', ticket ?? req.cookies[MFA_COOKIE]);

  app.post('/api/auth/login/mfa/passkey-options', async (req): Promise<PasskeyOptionsResponse> => {
    perIp(req, 'mfa');
    const body = parse(ticketSchema, req.body);
    const row = pendingLogin(req, body.ticket);
    if (!row?.user_id) throw badRequest('Connexion expirée : recommencez.');
    const { passkey: _old, ...data } = challengeData<{ amr: string; passkey?: string }>(row);
    const options = await authenticationOptions(ctx, row.user_id);
    updateChallengeData(db, row, { ...data, passkey: options.challenge });
    return { ticket: body.ticket ?? '', options };
  });

  app.post('/api/auth/login/mfa', async (req, reply) => {
    perIp(req, 'mfa');
    const body = parse(mfaSchema, req.body);
    const row = pendingLogin(req, body.ticket);
    if (!row?.user_id) throw badRequest('Connexion expirée : recommencez.');
    perUser(row.user_id);
    const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) throw badRequest('Connexion expirée : recommencez.');
    const data = challengeData<{ amr: string; passkey?: string; resetHash?: string }>(row);
    let method: string | null = null;
    if (body.code) {
      if (checkTotp(ctx, user.id, body.code)) method = 'totp';
    } else if (body.recoveryCode) {
      if (totpEnabled(db, user.id) && consumeRecoveryCode(db, user.id, body.recoveryCode)) {
        method = 'recovery';
        logSecurity(db, { userId: user.id, event: 'recovery_code_used', ip: req.ip, detail: `${recoveryCodesRemaining(db, user.id)} restants` });
        notify(ctx, user, 'Code de secours utilisé', 'Un code de secours vient d’être utilisé pour vous connecter à Oriel.');
      }
    } else if (body.passkey && data.passkey) {
      // The WebAuthn challenge is single use too: dropped before the verification.
      updateChallengeData(db, row, { amr: data.amr, resetHash: data.resetHash });
      if (await verifyAssertion(ctx, data.passkey, body.passkey, { expectUserId: user.id, requireUv: false })) method = 'passkey';
    }
    if (!method) {
      failChallenge(db, row);
      throw wrongCode();
    }
    if (!consumeChallenge(db, row)) throw badRequest('Connexion expirée : recommencez.');
    // Password reset link of a protected account: the new password applies now (QA-G9-06).
    if (typeof data.resetHash === 'string' && data.resetHash.startsWith('scrypt$')) applyPasswordReset(ctx, user.id, data.resetHash);
    reply.clearCookie(MFA_COOKIE, { path: '/api/auth', httpOnly: true, sameSite: 'lax' });
    return openSession(ctx, req, reply, user, `${data.amr}+${method}`);
  });

  // -------------------------------------------------------------------------
  // Sign-in with a passkey (no password)
  // -------------------------------------------------------------------------

  app.post('/api/auth/passkey/options', async (req): Promise<PasskeyOptionsResponse> => {
    perIp(req, 'passkey');
    return passkeyChallenge(ctx, 'passkey-auth', { userId: null });
  });

  app.post('/api/auth/passkey/login', async (req, reply) => {
    perIp(req, 'passkey');
    const body = parse(passkeyLoginSchema, req.body);
    const userId = await verifyChallengeAssertion(ctx, findChallenge(db, 'passkey-auth', body.ticket), body.response, { requireUv: true });
    const user = userId ? db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId) : undefined;
    if (!user) throw unauthorized('Clé d’accès non reconnue.');
    return openSession(ctx, req, reply, user, 'passkey');
  });

  // -------------------------------------------------------------------------
  // Re-authentication (A06)
  // -------------------------------------------------------------------------

  app.get('/api/auth/reauth', async (req): Promise<ReauthOptionsResponse> => {
    const { user } = cookieAuth(req);
    return { methods: ctx.config.localMode ? [] : reauthMethods(ctx, user), reauthUntil: reauthUntil(ctx, req) };
  });

  app.post('/api/auth/reauth/passkey-options', async (req): Promise<PasskeyOptionsResponse> => {
    const auth = cookieAuth(req);
    notLocal(ctx);
    if (passkeyCount(db, auth.user.id) === 0) throw badRequest('Aucune clé d’accès enregistrée.');
    return passkeyChallenge(ctx, 'passkey-reauth', { userId: auth.user.id, sessionId: auth.sessionId });
  });

  app.post('/api/auth/reauth', async (req): Promise<ReauthOptionsResponse> => {
    const auth = cookieAuth(req);
    notLocal(ctx);
    perIp(req, 'reauth');
    perUser(auth.user.id);
    const body = parse(reauthSchema, req.body);
    const methods = reauthMethods(ctx, auth.user);
    let ok = false;
    if (body.passkey && methods.includes('passkey')) {
      const row = findChallenge(db, 'passkey-reauth', body.ticket);
      ok =
        !!row &&
        row.session_id === auth.sessionId &&
        (await verifyChallengeAssertion(ctx, row, body.passkey, { expectUserId: auth.user.id, requireUv: false })) === auth.user.id;
    } else if (body.code && methods.includes('totp')) {
      ok = checkTotp(ctx, auth.user.id, body.code);
    } else if (body.password !== undefined && methods.includes('password')) {
      ok = await verifyPassword(body.password, auth.user.password_hash);
    }
    if (!ok) throw badRequest('Identité non confirmée : vérifiez votre saisie.');
    markReauthenticated(ctx, auth.sessionId);
    return { methods, reauthUntil: reauthUntil(ctx, req) };
  });

  // -------------------------------------------------------------------------
  // /api/me/security
  // -------------------------------------------------------------------------

  app.get('/api/me/security', async (req): Promise<SecurityStatus> => {
    const { user } = cookieAuth(req);
    const local = ctx.config.localMode;
    const passkeys = db
      .all<{ id: string; name: string; created_at: number; last_used_at: number | null; backed_up: number }>(
        'SELECT id, name, created_at, last_used_at, backed_up FROM auth_passkeys WHERE user_id = ? ORDER BY created_at',
        user.id,
      )
      .map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at, lastUsedAt: p.last_used_at, backedUp: p.backed_up === 1 }));
    const label = oidcLabel(ctx);
    return {
      available: !local,
      passkeysAvailable: relyingParty(ctx) !== null,
      totpEnabled: totpEnabled(db, user.id),
      recoveryCodesRemaining: recoveryCodesRemaining(db, user.id),
      passkeys,
      hasPassword: hasPassword(user),
      identities: identitiesOf(db, user.id),
      sso: !local && label ? { label } : null,
      reauthUntil: reauthUntil(ctx, req),
      requiredBy: local ? [] : requiringWorkspaces(db, user.id),
      enrollmentRequired: enrollmentRequired(ctx, user.id),
    };
  });

  app.post('/api/me/security/totp/setup', async (req): Promise<TotpSetupResponse> => {
    const { user } = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    if (totpEnabled(db, user.id)) throw conflict('L’application d’authentification est déjà activée.');
    const secret = generateTotpSecret();
    db.run(
      `INSERT INTO auth_totp (user_id, secret_enc, created_at, enabled_at, last_step) VALUES (?, ?, ?, NULL, 0)
       ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, created_at = excluded.created_at, enabled_at = NULL, last_step = 0`,
      user.id,
      sealTotpSecret(ctx, user.id, secret),
      Date.now(),
    );
    const issuer = (() => {
      try {
        return ctx.config.publicUrl ? `Oriel (${new URL(ctx.config.publicUrl).host})` : 'Oriel';
      } catch {
        return 'Oriel';
      }
    })();
    return { secret, uri: otpauthUri(issuer, user.email, secret) };
  });

  app.post('/api/me/security/totp/confirm', async (req): Promise<RecoveryCodesResponse> => {
    const { user } = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    perUser(user.id);
    const body = parse(confirmSchema, req.body);
    const row = totpRow(db, user.id);
    if (!row || row.enabled_at !== null) throw badRequest('Commencez par « Activer ».');
    if (!checkTotp(ctx, user.id, body.code, { pending: true })) throw wrongCode();
    const recoveryCodes = db.tx(() => {
      db.run('UPDATE auth_totp SET enabled_at = ? WHERE user_id = ?', Date.now(), user.id);
      logSecurity(db, { userId: user.id, event: 'totp_enabled', ip: req.ip });
      return generateRecoveryCodes(db, user.id);
    });
    notify(ctx, user, 'Double authentification activée', 'La double authentification par application vient d’être activée sur votre compte Oriel.');
    return { recoveryCodes };
  });

  app.delete('/api/me/security/totp', async (req) => {
    const { user } = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    if (!totpRow(db, user.id)) throw notFound('L’application d’authentification n’est pas activée.');
    if (totpEnabled(db, user.id)) assertStillProtectedAfter(ctx, user.id, 'totp');
    const wasEnabled = totpEnabled(db, user.id);
    db.tx(() => {
      db.run('DELETE FROM auth_totp WHERE user_id = ?', user.id);
      db.run('DELETE FROM auth_recovery_codes WHERE user_id = ?', user.id);
      if (wasEnabled) logSecurity(db, { userId: user.id, event: 'totp_disabled', ip: req.ip });
    });
    if (wasEnabled) notify(ctx, user, 'Double authentification désactivée', 'La double authentification par application vient d’être désactivée sur votre compte Oriel.');
    return { ok: true as const };
  });

  app.post('/api/me/security/recovery-codes', async (req): Promise<RecoveryCodesResponse> => {
    const { user } = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    if (!totpEnabled(db, user.id)) throw badRequest('Activez d’abord l’application d’authentification.');
    const recoveryCodes = db.tx(() => {
      logSecurity(db, { userId: user.id, event: 'recovery_codes_generated', ip: req.ip });
      return generateRecoveryCodes(db, user.id);
    });
    return { recoveryCodes };
  });

  app.post('/api/me/security/passkeys/options', async (req): Promise<PasskeyOptionsResponse> => {
    const auth = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    return registrationOptions(ctx, auth.user, auth.sessionId);
  });

  app.post('/api/me/security/passkeys', async (req) => {
    const auth = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    const body = parse(registerSchema, req.body);
    const id = await verifyRegistration(ctx, auth.user, auth.sessionId, body.ticket, body.response, body.name);
    logSecurity(db, { userId: auth.user.id, event: 'passkey_added', ip: req.ip, detail: passkeyName(body.name) });
    notify(ctx, auth.user, 'Clé d’accès ajoutée', `Une clé d’accès (« ${passkeyName(body.name)} ») vient d’être ajoutée à votre compte Oriel.`);
    return { id };
  });

  app.patch('/api/me/security/passkeys/:id', async (req) => {
    const { user } = cookieAuth(req);
    const { id } = parse(idParams, req.params);
    const body = parse(renameSchema, req.body);
    if (db.run('UPDATE auth_passkeys SET name = ? WHERE id = ? AND user_id = ?', passkeyName(body.name), id, user.id) === 0) throw notFound('Clé d’accès introuvable.');
    return { ok: true as const };
  });

  app.delete('/api/me/security/passkeys/:id', async (req) => {
    const { user } = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    const { id } = parse(idParams, req.params);
    const row = db.get<{ name: string }>('SELECT name FROM auth_passkeys WHERE id = ? AND user_id = ?', id, user.id);
    if (!row) throw notFound('Clé d’accès introuvable.');
    assertStillProtectedAfter(ctx, user.id, 'passkey');
    db.run('DELETE FROM auth_passkeys WHERE id = ? AND user_id = ?', id, user.id);
    logSecurity(db, { userId: user.id, event: 'passkey_removed', ip: req.ip, detail: row.name });
    notify(ctx, user, 'Clé d’accès retirée', `La clé d’accès « ${row.name} » a été retirée de votre compte Oriel.`);
    return { ok: true as const };
  });

  app.get('/api/me/security/log', async (req): Promise<{ entries: SecurityLogEntry[] }> => {
    const { user } = cookieAuth(req);
    const rows = db.all<{
      id: string;
      event: SecurityLogEntry['event'];
      detail: string | null;
      created_at: number;
      a_id: string | null;
      a_name: string | null;
      a_email: string | null;
      a_avatar: string | null;
    }>(
      `SELECT l.id, l.event, l.detail, l.created_at, a.id AS a_id, a.name AS a_name, a.email AS a_email, a.avatar_url AS a_avatar
       FROM auth_security_log l LEFT JOIN users a ON a.id = l.actor_id
       WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 50`,
      user.id,
    );
    return {
      entries: rows.map((r) => ({
        id: r.id,
        event: r.event,
        detail: r.detail,
        createdAt: r.created_at,
        actor: r.a_id ? toPublicUser({ id: r.a_id, name: r.a_name!, email: r.a_email!, avatar_url: r.a_avatar }) : null,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // E-mail address (A06)
  // -------------------------------------------------------------------------

  app.post('/api/me/email', async (req) => {
    const auth = cookieAuth(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    const body = parse(emailSchema, req.body);
    const old = auth.user.email;
    if (body.email === old.toLowerCase()) return { user: toUser(auth.user) };
    db.tx(() => {
      if (db.get('SELECT 1 AS x FROM users WHERE email = ? AND id != ?', body.email, auth.user.id)) throw conflict('Cette adresse e-mail est déjà utilisée.');
      db.run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', body.email, Date.now(), auth.user.id);
      // Reset links already sent to the previous address stop working (QA-G9-05).
      revokeResetTokens(db, auth.user.id);
      logSecurity(db, { userId: auth.user.id, event: 'email_changed', ip: req.ip, detail: `${old} → ${body.email}` });
      for (const { workspace_id } of db.all<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE user_id = ?', auth.user.id)) {
        ctx.bus.publish(workspace_id, { entity: 'members', workspaceId: workspace_id });
      }
    });
    // The previous address is warned: a stolen session cannot silently take the account over.
    notify(ctx, { email: old, name: auth.user.name }, 'Adresse e-mail modifiée', `L’adresse e-mail de votre compte Oriel a été remplacée par ${body.email}.`);
    return { user: toUser(db.get<UserRow>('SELECT * FROM users WHERE id = ?', auth.user.id)!) };
  });

  // -------------------------------------------------------------------------
  // Instance administration: two-factor status and reset (recovery)
  // -------------------------------------------------------------------------

  app.get('/api/admin/security/users', async (req): Promise<{ users: AdminUserSecurity[] }> => {
    requireInstanceAdmin(req);
    const rows = db.all<{ id: string; name: string; email: string; totp: number; passkeys: number; identities: number }>(
      `SELECT u.id, u.name, u.email,
              (SELECT COUNT(*) FROM auth_totp t WHERE t.user_id = u.id AND t.enabled_at IS NOT NULL) AS totp,
              (SELECT COUNT(*) FROM auth_passkeys p WHERE p.user_id = u.id) AS passkeys,
              (SELECT COUNT(*) FROM auth_identities i WHERE i.user_id = u.id) AS identities
       FROM users u ORDER BY u.created_at, u.email`,
    );
    return { users: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email, totpEnabled: r.totp > 0, passkeys: r.passkeys, identities: r.identities })) };
  });

  app.post('/api/admin/users/:uid/security/reset', async (req) => {
    const auth = requireInstanceAdmin(req);
    notLocal(ctx);
    requireRecentAuth(ctx, req);
    const { uid } = parse(uidParams, req.params);
    const target = db.get<UserRow>('SELECT * FROM users WHERE id = ?', uid);
    if (!target) throw notFound('Utilisateur introuvable.');
    db.tx(() => {
      db.run('DELETE FROM auth_totp WHERE user_id = ?', uid);
      db.run('DELETE FROM auth_recovery_codes WHERE user_id = ?', uid);
      db.run('DELETE FROM auth_passkeys WHERE user_id = ?', uid);
      db.run("DELETE FROM auth_challenges WHERE user_id = ?", uid);
      logSecurity(db, { userId: uid, actorId: auth.user.id, event: 'mfa_reset_by_admin', ip: req.ip });
      if (uid !== auth.user.id) logSecurity(db, { userId: auth.user.id, event: 'mfa_reset_by_admin', ip: req.ip, detail: `Compte : ${target.email}` });
    });
    // Every session of the account is closed (the admin's own current one excepted).
    revokeSessions(ctx, uid, uid === auth.user.id ? auth.sessionId : undefined);
    req.log.warn({ actor: auth.user.id, target: uid }, 'double authentification réinitialisée par un administrateur');
    notify(
      ctx,
      target,
      'Double authentification réinitialisée',
      `${auth.user.name}, administrateur de votre instance Oriel, a réinitialisé la double authentification de votre compte. Vos sessions ont été fermées ; reconfigurez-la après votre prochaine connexion.`,
    );
    return { ok: true as const };
  });

  // -------------------------------------------------------------------------
  // Workspace two-factor policy
  // -------------------------------------------------------------------------

  const policyOf = (wid: string): WorkspaceSecurityPolicy => {
    const row = db.get<{ require_2fa: number; grace_until: number | null }>('SELECT require_2fa, grace_until FROM workspace_security WHERE workspace_id = ?', wid);
    const members = db.all<UserRow>('SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name', wid);
    return {
      require2fa: row?.require_2fa === 1,
      graceUntil: row?.require_2fa === 1 ? row.grace_until : null,
      nonCompliant: members.filter((m) => !isProtected(db, m.id)).map(toPublicUser),
    };
  };

  app.get('/api/workspaces/:wid/security', async (req): Promise<WorkspaceSecurityPolicy> => {
    const { user } = cookieAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'manage');
    return policyOf(wid);
  });

  app.put('/api/workspaces/:wid/security', async (req): Promise<WorkspaceSecurityPolicy> => {
    const { user } = cookieAuth(req);
    notLocal(ctx);
    const { wid } = parse(widParams, req.params);
    const body = parse(policySchema, req.body);
    requireWorkspace(db, user.id, wid, 'manage');
    requireRecentAuth(ctx, req);
    if (body.require2fa && !isProtected(db, user.id)) {
      throw badRequest('Activez d’abord la double authentification sur votre propre compte.');
    }
    const now = Date.now();
    const graceUntil = body.require2fa ? now + (body.graceDays ?? 0) * DAY_MS : null;
    db.tx(() => {
      db.run(
        `INSERT INTO workspace_security (workspace_id, require_2fa, grace_until, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET require_2fa = excluded.require_2fa, grace_until = excluded.grace_until,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        wid,
        body.require2fa ? 1 : 0,
        graceUntil,
        user.id,
        now,
      );
      logSecurity(db, {
        userId: user.id,
        event: 'workspace_policy_changed',
        ip: req.ip,
        detail: body.require2fa ? `Double authentification imposée (délai : ${body.graceDays ?? 0} j)` : 'Double authentification non imposée',
      });
    });
    if (body.require2fa && (body.graceDays ?? 0) === 0) enforceWorkspacePolicy(ctx, wid);
    return policyOf(wid);
  });
  registerTransferRoutes(app, ctx);
  registerOidcRoutes(app, ctx);
  registerDomainRoutes(app, ctx);
}

/** Closes the live connections of the members who must enrol now (policy enforced, grace over). */
export function enforceWorkspacePolicy(ctx: AppContext, workspaceId: string): void {
  for (const { user_id } of ctx.db.all<{ user_id: string }>('SELECT user_id FROM members WHERE workspace_id = ?', workspaceId)) {
    if (!enrollmentRequired(ctx, user_id)) continue;
    ctx.collab.closeForUser(user_id, workspaceId);
    for (const { id } of ctx.db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ?', user_id)) ctx.bus.closeSession(id);
  }
}

/** Maintenance (every 5 minutes): expired challenges and transfers, policies whose grace just ended. */
export function startAccountSecurityJobs(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  let lastRun = Date.now();
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      ctx.db.run('DELETE FROM auth_challenges WHERE expires_at <= ?', now);
      ctx.db.run('DELETE FROM workspace_transfers WHERE expires_at <= ?', now);
      for (const { workspace_id } of ctx.db.all<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_security WHERE require_2fa = 1 AND grace_until > ? AND grace_until <= ?',
        lastRun - 60_000,
        now,
      )) {
        enforceWorkspacePolicy(ctx, workspace_id);
      }
      lastRun = now;
    } catch (err) {
      log('sécurité des comptes : maintenance impossible', err);
    }
  }, 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

