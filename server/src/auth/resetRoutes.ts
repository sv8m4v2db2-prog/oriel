// Password reset: "Mot de passe oublié ?" (e-mail with a single-use 1 h link) and links created
// by instance administrators (24 h, shown to copy — works without SMTP).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LIMITS, type AdminResetLinkResponse, type PasswordResetConfig, type ResetTokenInfo } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/rows.js';
import { badRequest, forbidden, notFound, rateLimited } from '../errors.js';
import { idParam, parse, requireAuth, setSessionCookie } from '../http.js';
import { hashPassword } from './password.js';
import { createSession } from './sessions.js';
import { clientKey, RateLimiter } from './rateLimit.js';
import { ADMIN_RESET_TTL_MS, consumeResetToken, createResetToken, findResetToken, maskEmail, RESET_TTL_MS, revokeResetTokens } from './passwordReset.js';
import { sessionResponse } from '../services/workspaces.js';
import { baseUrl, getMailer, rememberOrigin } from '../collab/mailer.js';
import { passwordResetMail } from '../collab/templates.js';
import { mfaChallenge } from './loginFlow.js';
import { isProtected } from './security.js';
import { requireRecentAuth } from './stepUp.js';

const forgotSchema = z.object({ email: z.string().trim().max(320) });
const resetSchema = z.object({ token: z.string().min(1).max(200), password: z.string().min(LIMITS.passwordMin).max(256) });
const tokenParams = z.object({ token: z.string().min(1).max(200) });
const userParams = z.object({ uid: idParam });
const adminResetSchema = z.object({ sendEmail: z.boolean().optional() });

/** At most 3 reset e-mails per address and per hour (beyond: silently skipped, still 200). */
const perEmail = new WeakMap<AppContext, RateLimiter>();

/**
 * Origin of a request of an *instance administrator*, used for absolute links in e-mails when
 * PUBLIC_URL is not set. Never taken from other requests: the Host / X-Forwarded-Host header is
 * chosen by the client, and the remembered origin ends up in every e-mail (other users' password
 * resets included), so any other account could forge reset or invitation links.
 * `req.host` / `req.protocol` honor X-Forwarded-* only when the immediate peer is a trusted proxy
 * (TRUST_PROXY, util/proxyTrust.ts).
 */
export function requestOrigin(req: FastifyRequest): string {
  // An API token never sets it, even an admin's (QA-TOK-01).
  if (req.auth?.user.is_admin !== 1 || req.apiToken) return '';
  const host = req.host ?? '';
  return /^[a-z0-9.\-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(host) ? `${req.protocol}://${host}` : '';
}

/**
 * New password of a reset link: replaces the hash, closes every session (and their live sockets) and
 * drops the other pending links. Called in the reset route, or after the second step for a protected
 * account (auth/securityRoutes.ts, QA-G9-06).
 */
export function applyPasswordReset(ctx: AppContext, userId: string, hash: string): void {
  const revoked = ctx.db.tx(() => {
    const ids = ctx.db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ?', userId).map((r) => r.id);
    ctx.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), userId);
    ctx.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
    revokeResetTokens(ctx.db, userId);
    return ids;
  });
  for (const id of revoked) {
    ctx.bus.closeSession(id);
    ctx.collab.closeForSession(id);
  }
}

export function registerPasswordResetRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const log = (msg: string, err?: unknown) => (err ? app.log.error({ err }, msg) : app.log.info(msg));

  app.get('/api/auth/password/config', async (): Promise<PasswordResetConfig> => ({ emailEnabled: getMailer(ctx).enabled }));

  app.post('/api/auth/password/forgot', async (req) => {
    if (!ctx.authLimiter.hit(`forgot:${clientKey(req.ip)}`)) throw rateLimited();
    const body = parse(forgotSchema, req.body);
    const email = body.email.toLowerCase();
    // The answer never depends on the account: the work happens after the response.
    setImmediate(() => {
      void (async () => {
        const mailer = getMailer(ctx);
        if (!mailer.enabled || !email) return;
        const user = db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
        if (!user) return;
        let limiter = perEmail.get(ctx);
        if (!limiter) perEmail.set(ctx, (limiter = new RateLimiter(3, 60 * 60 * 1000)));
        if (!limiter.hit(user.id)) return;
        const { token } = createResetToken(db, user.id, null, RESET_TTL_MS);
        const url = `${baseUrl(ctx)}/reset-password/${token}`;
        await mailer.send(passwordResetMail({ to: user.email, name: user.name, url, minutes: RESET_TTL_MS / 60_000 }), log);
      })().catch((err) => log('mot de passe oublié : échec', err));
    });
    return { ok: true as const };
  });

  app.get('/api/auth/password/reset/:token', async (req): Promise<ResetTokenInfo> => {
    if (!ctx.authLimiter.hit(`reset-check:${clientKey(req.ip)}`)) throw rateLimited();
    const { token } = parse(tokenParams, req.params);
    const row = findResetToken(db, token);
    const user = row ? db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', row.user_id) : undefined;
    return row && user ? { valid: true, email: maskEmail(user.email) } : { valid: false, email: null };
  });

  app.post('/api/auth/password/reset', async (req, reply) => {
    if (!ctx.authLimiter.hit(`reset:${clientKey(req.ip)}`)) throw rateLimited();
    const body = parse(resetSchema, req.body);
    if (!findResetToken(db, body.token)) throw badRequest('Ce lien de réinitialisation est invalide ou a expiré.');
    const hash = await hashPassword(body.password);
    const { userId, secondFactor } = db.tx(() => {
      // Re-checked inside the transaction: a token can only be consumed once.
      const row = findResetToken(db, body.token);
      if (!row) throw badRequest('Ce lien de réinitialisation est invalide ou a expiré.');
      consumeResetToken(db, row);
      return { userId: row.user_id, secondFactor: isProtected(db, row.user_id) };
    });
    const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId)!;
    // A reset link proves access to the mailbox only: an account with a second factor still answers it
    // (G9, A05) — and nothing changes before that (password, sessions, API tokens: QA-G9-06).
    if (secondFactor) return mfaChallenge(ctx, user, 'reset', { resetHash: hash });
    applyPasswordReset(ctx, userId, hash);
    const session = createSession(db, userId, req.headers['user-agent'], 'reset');
    setSessionCookie(req, reply, session.token);
    return sessionResponse(db, user);
  });

  app.post('/api/admin/users/:uid/password-reset', async (req): Promise<AdminResetLinkResponse> => {
    const auth = requireAuth(req);
    if (auth.user.is_admin !== 1) throw forbidden("Réservé aux administrateurs de l'instance.");
    // A reset link opens any account without a second factor: same confirmation as a 2FA reset (QA-G9-01).
    requireRecentAuth(ctx, req);
    const { uid } = parse(userParams, req.params);
    const body = parse(adminResetSchema, req.body ?? {});
    rememberOrigin(ctx, requestOrigin(req));
    const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', uid);
    if (!user) throw notFound('Utilisateur introuvable.');
    const { token, expiresAt } = createResetToken(db, user.id, auth.user.id, ADMIN_RESET_TTL_MS);
    const path = `/reset-password/${token}`;
    let emailed = false;
    if (body.sendEmail) {
      emailed = await getMailer(ctx).send(
        passwordResetMail({ to: user.email, name: user.name, url: `${baseUrl(ctx)}${path}`, minutes: ADMIN_RESET_TTL_MS / 60_000, byAdmin: true }),
        log,
      );
    }
    return { url: ctx.config.publicUrl ? `${ctx.config.publicUrl}${path}` : path, expiresAt, emailed };
  });
}
