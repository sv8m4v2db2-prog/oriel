// Re-authentication of sensitive actions (A06) and the two-factor enrolment gate (A05).
//
// - A session counts as recently authenticated for REAUTH_WINDOW_MS after its login or its last
//   re-authentication (sessions.auth_at, read from the database on every check). API tokens never do:
//   the sensitive routes are cookie-only anyway (auth/apiTokens.ts COOKIE_ONLY).
// - Routes owned by other modules are covered by a route table checked in a preHandler (route pattern +
//   method, so percent-encoded variants are covered); this module's own routes call requireRecentAuth.
// - Enrolment gate: an account without a second factor that belongs to a workspace requiring one (grace
//   period over) only reaches the enrolment endpoints; every other API request — tokens included — gets
//   403 `mfa_enrollment_required`, and WebSocket upgrades are refused (app.ts).
// - Desktop local mode: a single local user without credentials, automatically signed in from the
//   machine; re-authentication is not applicable and the gate never applies.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MFA_ENROLLMENT_REQUIRED, REAUTH_REQUIRED, REAUTH_WINDOW_MS } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { HttpError, unauthorized } from '../errors.js';
import { enrollmentRequired } from './security.js';
import { checkSecretsKeyEnv } from './secretBox.js';

export const reauthRequired = () => new HttpError(403, REAUTH_REQUIRED, 'Confirmez votre identité pour continuer.');
export const enrollmentRequiredError = () =>
  new HttpError(403, MFA_ENROLLMENT_REQUIRED, 'Un espace dont vous êtes membre impose la double authentification : activez-la pour continuer.');

/** Until when the request's session counts as recently authenticated, or null. */
export function reauthUntil(ctx: AppContext, req: FastifyRequest, now = Date.now()): number | null {
  if (!req.auth || req.apiToken) return null;
  if (ctx.config.localMode) return now + REAUTH_WINDOW_MS;
  const row = ctx.db.get<{ auth_at: number | null }>('SELECT auth_at FROM sessions WHERE id = ?', req.auth.sessionId);
  if (!row?.auth_at) return null;
  const until = row.auth_at + REAUTH_WINDOW_MS;
  return until > now ? until : null;
}

export function requireRecentAuth(ctx: AppContext, req: FastifyRequest): void {
  if (!req.auth) throw unauthorized();
  if (reauthUntil(ctx, req) === null) throw reauthRequired();
}

export function markReauthenticated(ctx: AppContext, sessionId: string, now = Date.now()): void {
  ctx.db.run('UPDATE sessions SET auth_at = ? WHERE id = ?', now, sessionId);
}

const grantsManagerRole = (req: FastifyRequest) => {
  const role = (req.body as { role?: unknown } | undefined)?.role;
  return role === 'admin' || role === 'owner';
};

/**
 * Sensitive routes of other modules. `when`: extra condition on the parsed request. An invitation with
 * the admin role creates an administrator: same rule as a promotion.
 */
const STEP_UP_ROUTES: Array<{ method: string; url: string; when?: (req: FastifyRequest) => boolean }> = [
  { method: 'DELETE', url: '/api/workspaces/:wid' },
  { method: 'PATCH', url: '/api/workspaces/:wid/members/:uid', when: grantsManagerRole },
  { method: 'POST', url: '/api/workspaces/:wid/invites', when: grantsManagerRole },
  { method: 'POST', url: '/api/workspaces/:wid/invites/email', when: grantsManagerRole },
  { method: 'POST', url: '/api/me/tokens' },
  { method: 'DELETE', url: '/api/me/tokens/:id' },
];

/** Requests an account blocked by the enrolment gate may still make (route patterns). */
const ENROLMENT_ALLOWED = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/reauth',
  '/api/auth/reauth/passkey-options',
  // Signing in again (another account, or this one with a second factor) is never blocked.
  '/api/auth/login',
  '/api/auth/login/mfa',
  '/api/auth/login/mfa/passkey-options',
  '/api/auth/passkey/options',
  '/api/auth/passkey/login',
  '/api/auth/oidc/start',
  '/api/auth/oidc/callback',
]);
const ENROLMENT_ALLOWED_PREFIX = '/api/me/security';

export function isEnrolmentAllowedRoute(route: string): boolean {
  return ENROLMENT_ALLOWED.has(route) || route === ENROLMENT_ALLOWED_PREFIX || route.startsWith(`${ENROLMENT_ALLOWED_PREFIX}/`);
}

/** To call from app.ts after the authentication hook and before the routes. */
export function setupAccountSecurity(app: FastifyInstance, ctx: AppContext): void {
  checkSecretsKeyEnv();

  app.addHook('onRequest', async (req) => {
    if (!req.auth || ctx.config.localMode) return;
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/') || isEnrolmentAllowedRoute(route)) return;
    if (enrollmentRequired(ctx, req.auth.user.id)) throw enrollmentRequiredError();
  });

  app.addHook('preHandler', async (req) => {
    const route = req.routeOptions.url ?? '';
    const rule = STEP_UP_ROUTES.find((r) => r.method === req.method && r.url === route);
    if (!rule || (rule.when && !rule.when(req))) return;
    requireRecentAuth(ctx, req);
  });
}
