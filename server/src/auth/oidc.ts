// OIDC single sign-on (A07): authorization code flow with PKCE (S256), `state` bound to the browser by a
// cookie, `nonce`, ID token verified with jose (issuer, audience, signature with an asymmetric algorithm,
// expiry). Configured by the server administrator (environment, see oidcConfig and docs/DEPLOY.md).
//
// Account linking is never automatic: an unknown identity whose e-mail belongs to an existing account
// is refused; the account owner links it from Réglages › Sécurité (signed in, re-authenticated). New
// accounts follow SIGNUP_MODE, or the auto-join of a verified domain (e-mail verified by the provider).
//
// Outgoing requests go to the administrator-chosen issuer only (and the endpoints it publishes): https,
// or http on loopback for tests and local providers; timeout and size limit on every response.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { newId, type LinkedIdentity, type SignupMode } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { UserRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, rateLimited } from '../errors.js';
import { parse, requireAuth } from '../http.js';
import { createWorkspace, firstName } from '../services/workspaces.js';
import { completeFirstFactor, MFA_COOKIE } from './loginFlow.js';
import {
  challengeData,
  consumeChallenge,
  createChallenge,
  findChallenge,
  hasPassword,
  ipKey,
  isProtected,
  logSecurity,
  passkeyCount,
} from './security.js';
import { markReauthenticated, requireRecentAuth } from './stepUp.js';
import { autoJoinTargets } from './domains.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  scopes: string;
}

/** OIDC_ISSUER + OIDC_CLIENT_ID + PUBLIC_URL are required; never in the desktop local mode. */
export function oidcConfig(ctx: AppContext, env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  if (ctx.config.localMode || !ctx.config.publicUrl) return null;
  const issuer = (env.OIDC_ISSUER ?? '').trim().replace(/\/+$/, '');
  const clientId = (env.OIDC_CLIENT_ID ?? '').trim();
  if (!issuer || !clientId || !allowedUrl(issuer, issuer)) return null;
  const scopes = (env.OIDC_SCOPES ?? '').trim() || 'openid email profile';
  return {
    issuer,
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET ?? '',
    label: (env.OIDC_LABEL ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'SSO',
    scopes: scopes.split(/\s+/).includes('openid') ? scopes : `openid ${scopes}`,
  };
}

export const oidcLabel = (ctx: AppContext): string | null => oidcConfig(ctx)?.label ?? null;

export function identitiesOf(db: Db, userId: string): LinkedIdentity[] {
  return db
    .all<{ issuer: string; email: string | null; created_at: number; last_login_at: number | null }>(
      'SELECT issuer, email, created_at, last_login_at FROM auth_identities WHERE user_id = ? ORDER BY created_at',
      userId,
    )
    .map((r) => ({ issuer: r.issuer, email: r.email, createdAt: r.created_at, lastLoginAt: r.last_login_at }));
}

// ---------------------------------------------------------------------------
// HTTP to the provider
// ---------------------------------------------------------------------------

const isLoopbackName = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** https, or http on loopback when the issuer itself is a loopback http URL. */
function allowedUrl(url: string, issuer: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    const iss = new URL(issuer);
    return u.protocol === 'http:' && iss.protocol === 'http:' && isLoopbackName(u.hostname) && isLoopbackName(iss.hostname);
  } catch {
    return false;
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('réponse trop volumineuse');
      }
      chunks.push(value);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON inattendu');
  return data as Record<string, unknown>;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveries = new Map<string, { at: number; value: Discovery }>();
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discover(cfg: OidcConfig): Promise<Discovery> {
  const cached = discoveries.get(cfg.issuer);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.value;
  const doc = await fetchJson(`${cfg.issuer}/.well-known/openid-configuration`);
  // The document must describe exactly the configured issuer (no mix-up between providers).
  if (doc.issuer !== cfg.issuer) throw new Error('émetteur inattendu dans la découverte');
  const value = {
    authorization_endpoint: String(doc.authorization_endpoint ?? ''),
    token_endpoint: String(doc.token_endpoint ?? ''),
    jwks_uri: String(doc.jwks_uri ?? ''),
  };
  for (const url of Object.values(value)) if (!allowedUrl(url, cfg.issuer)) throw new Error('point de terminaison refusé');
  discoveries.set(cfg.issuer, { at: Date.now(), value });
  return value;
}

const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** Verifies the ID token (signature with an asymmetric algorithm only, issuer, audience, expiry, nonce). */
export async function verifyIdToken(cfg: OidcConfig, jwksUri: string, idToken: string, nonce: string): Promise<JWTPayload> {
  let jwks = jwksSets.get(jwksUri);
  if (!jwks) jwksSets.set(jwksUri, (jwks = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60 * 1000 })));
  const { payload } = await jwtVerify(idToken, jwks, { issuer: cfg.issuer, audience: cfg.clientId, algorithms: ALGORITHMS, clockTolerance: 60, requiredClaims: ['sub', 'exp', 'iat'] });
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, nonce)) throw new Error('nonce invalide');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== cfg.clientId) throw new Error('azp invalide');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('sub invalide');
  return payload;
}

/** Maximum age of the provider sign-in for a re-authentication (auth_time, OIDC Core §3.1.2.1 max_age). */
const REAUTH_MAX_AGE_S = 5 * 60;

function freshAuthTime(authTime: unknown, now = Date.now()): boolean {
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) return false;
  const age = now / 1000 - authTime;
  // Same clock tolerance as the ID token (60 s).
  return age <= REAUTH_MAX_AGE_S + 60 && age >= -60;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

/** Test-only: forget cached discovery documents and key sets (a new fake provider per test server). */
export function resetOidcCaches(): void {
  discoveries.clear();
  jwksSets.clear();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const OIDC_COOKIE = 'oriel_oidc';
const COOKIE_PATH = '/api/auth/oidc';
const FLOW_TTL_MS = 10 * 60 * 1000;

type Mode = 'login' | 'link' | 'reauth';
interface FlowData {
  mode: Mode;
  nonce: string;
  verifier: string;
  binding: string;
  next: string;
}

const startSchema = z.object({ mode: z.enum(['login', 'link', 'reauth']).default('login'), next: z.string().max(500).optional() });
const callbackSchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});
const unlinkSchema = z.object({ issuer: z.string().min(1).max(500) });

/** A relative path inside the app (never `//host` or `/\host`). */
export function safeNextPath(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\u0000-\u001f]/.test(next)) return '/';
  return next;
}

function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

export function registerOidcRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const secure = (req: FastifyRequest) => req.protocol === 'https' || /^https:\/\//i.test(ctx.config.publicUrl);
  const redirectUri = () => `${ctx.config.publicUrl}/api/auth/oidc/callback`;
  const log = (msg: string, err?: unknown) => app.log.warn({ err }, msg);

  app.post('/api/auth/oidc/start', async (req, reply): Promise<{ url: string }> => {
    const cfg = oidcConfig(ctx);
    if (!cfg) throw badRequest('La connexion d’entreprise (SSO) n’est pas configurée sur ce serveur.');
    if (!ctx.authLimiter.hit(`oidc:${ipKey(req.ip)}`)) throw rateLimited();
    const body = parse(startSchema, req.body);
    let userId: string | null = null;
    let sessionId: string | null = null;
    if (body.mode !== 'login') {
      const auth = requireAuth(req);
      if (req.apiToken) throw forbidden("Cette action n'est pas disponible avec un jeton d'API.");
      if (body.mode === 'link') requireRecentAuth(ctx, req);
      // A protected account confirms its identity with its second factor (QA-G9-02).
      if (body.mode === 'reauth' && isProtected(db, auth.user.id)) throw badRequest('Confirmez votre identité avec votre double authentification.');
      userId = auth.user.id;
      sessionId = auth.sessionId;
    }
    let disco: Discovery;
    try {
      disco = await discover(cfg);
    } catch (err) {
      log('OIDC : découverte impossible', err);
      throw badRequest('Le fournisseur d’identité ne répond pas. Réessayez plus tard.');
    }
    const binding = randomBytes(32).toString('base64url');
    const data: FlowData = {
      mode: body.mode,
      nonce: randomBytes(24).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'),
      binding: sha256(binding),
      next: safeNextPath(body.next),
    };
    const state = createChallenge(db, 'oidc', { userId, sessionId, data, ttlMs: FLOW_TTL_MS });
    reply.setCookie(OIDC_COOKIE, binding, { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, secure: secure(req), maxAge: FLOW_TTL_MS / 1000 });
    const url = new URL(disco.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('scope', cfg.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', data.nonce);
    url.searchParams.set('code_challenge', sha256(data.verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (body.mode === 'reauth') {
      url.searchParams.set('prompt', 'login');
      url.searchParams.set('max_age', '0');
    }
    return { url: url.toString() };
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const query = parse(callbackSchema, req.query);
    const fail = (code: string, next = '/login') => reply.redirect(withParam(next, 'sso_error', code), 303);
    const cfg = oidcConfig(ctx);
    if (!cfg) return fail('unavailable');
    if (!ctx.authLimiter.hit(`oidc:${ipKey(req.ip)}`)) return fail('rate_limited');
    const row = findChallenge(db, 'oidc', query.state);
    const binding = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, secure: secure(req) });
    // The flow must have been started by this browser (no login CSRF with someone else's code).
    if (!row || !binding) return fail('expired');
    const data = challengeData<FlowData>(row);
    if (!safeEqual(sha256(binding), data.binding) || !consumeChallenge(db, row)) return fail('expired');
    const back = data.mode === 'login' ? '/login' : data.next;
    if (query.error || !query.code) return fail('denied', back);

    let claims: JWTPayload;
    try {
      const disco = await discover(cfg);
      const form = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri(), code_verifier: data.verifier });
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      if (cfg.clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`;
      } else {
        form.set('client_id', cfg.clientId);
      }
      const token = await fetchJson(disco.token_endpoint, { method: 'POST', headers, body: form.toString() }, 10_000);
      if (typeof token.id_token !== 'string') throw new Error('id_token absent');
      claims = await verifyIdToken(cfg, disco.jwks_uri, token.id_token, data.nonce);
    } catch (err) {
      log('OIDC : réponse du fournisseur refusée', err);
      return fail('invalid', back);
    }

    const sub = claims.sub!;
    const email = typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email.trim().toLowerCase() : null;
    const emailVerified = claims.email_verified === true && !!email;
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 100) : (email?.split('@')[0] ?? 'Utilisateur');
    const linked = db.get<{ user_id: string }>('SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?', cfg.issuer, sub);

    // --- link / reauth: the session that started the flow must still be the current one -------------
    if (data.mode !== 'login') {
      if (!req.auth || req.auth.sessionId !== row.session_id || req.auth.user.id !== row.user_id) return fail('expired', back);
      if (data.mode === 'reauth') {
        if (linked?.user_id !== req.auth.user.id || isProtected(db, req.auth.user.id)) return fail('mismatch', back);
        // max_age=0 was asked: the provider must state a sign-in made just now, not reuse its session (QA-G9-03).
        if (!freshAuthTime(claims.auth_time)) return fail('stale', back);
        markReauthenticated(ctx, req.auth.sessionId);
        return reply.redirect(data.next, 303);
      }
      if (linked && linked.user_id !== req.auth.user.id) return fail('already_linked', back);
      if (!linked) {
        db.run(
          'INSERT INTO auth_identities (issuer, subject, user_id, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)',
          cfg.issuer,
          sub,
          req.auth.user.id,
          email,
          Date.now(),
        );
        logSecurity(db, { userId: req.auth.user.id, event: 'sso_linked', ip: req.ip, detail: email ?? sub });
      }
      return reply.redirect(withParam(data.next, 'sso', 'linked'), 303);
    }

    // --- login ----------------------------------------------------------------------------------------
    let user: UserRow | undefined;
    if (linked) {
      user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', linked.user_id);
      db.run('UPDATE auth_identities SET last_login_at = ?, email = ? WHERE issuer = ? AND subject = ?', Date.now(), email, cfg.issuer, sub);
    } else {
      // Never linked on the e-mail address alone (pre-account takeover, unverified addresses).
      if (email && db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) return fail('link_required');
      const targets = emailVerified ? autoJoinTargets(db, email!) : [];
      const hasUsers = !!db.get('SELECT 1 AS x FROM users LIMIT 1');
      const mode = currentSignupMode(ctx);
      if (!email || (hasUsers && mode !== 'open' && targets.length === 0)) return fail('signup_closed');
      user = db.tx(() => {
        const id = newId();
        const now = Date.now();
        db.run(
          "INSERT INTO users (id, email, name, avatar_url, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, NULL, 'disabled', ?, ?, ?)",
          id,
          email,
          name,
          !hasUsers,
          now,
          now,
        );
        db.run('INSERT INTO auth_identities (issuer, subject, user_id, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)', cfg.issuer, sub, id, email, now, now);
        if (targets.length === 0) createWorkspace(ctx, id, `Espace de ${firstName(name)}`, null, { welcomePage: true });
        return db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
      });
    }
    if (!user) return fail('invalid');
    // Verified domains: join their workspace at each sign-in (e-mail verified by the provider only).
    if (emailVerified) joinDomainWorkspaces(ctx, user.id, email!);
    const result = completeFirstFactor(ctx, req, reply, user, 'oidc');
    if ('mfa' in result) {
      reply.setCookie(MFA_COOKIE, result.mfa.ticket, { httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: secure(req), maxAge: 300 });
      return reply.redirect(`/login?mfa=${encodeURIComponent(result.mfa.methods.join(','))}`, 303);
    }
    return reply.redirect(data.next === '/' ? '/' : data.next, 303);
  });

  app.delete('/api/me/security/identities', async (req) => {
    const auth = requireAuth(req);
    if (req.apiToken) throw forbidden("Cette action n'est pas disponible avec un jeton d'API.");
    requireRecentAuth(ctx, req);
    const { issuer } = parse(unlinkSchema, req.query);
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ?', auth.user.id)!.n;
    // Never remove the last way to sign in.
    if (count <= 1 && !hasPassword(auth.user) && passkeyCount(db, auth.user.id) === 0) {
      throw conflict('C’est votre seul moyen de connexion : définissez d’abord un mot de passe ou une clé d’accès.');
    }
    if (db.run('DELETE FROM auth_identities WHERE user_id = ? AND issuer = ?', auth.user.id, issuer) === 0) throw badRequest('Aucun compte SSO associé.');
    logSecurity(db, { userId: auth.user.id, event: 'sso_unlinked', ip: req.ip });
    return { ok: true as const };
  });

}

function currentSignupMode(ctx: AppContext): SignupMode {
  const value = ctx.db.getMeta('signup_mode');
  return value === 'open' || value === 'invite' || value === 'first-user' ? value : ctx.config.signupMode;
}

/** Once per workspace and account: a removal (or a departure) is never undone by a later sign-in (QA-G9-04). */
function joinDomainWorkspaces(ctx: AppContext, userId: string, email: string): void {
  const { db } = ctx;
  for (const t of autoJoinTargets(db, email)) {
    const now = Date.now();
    const joined = db.tx(() => {
      const member = !!db.get('SELECT 1 AS x FROM members WHERE workspace_id = ? AND user_id = ?', t.workspaceId, userId);
      const first = db.run('INSERT OR IGNORE INTO auth_domain_joins (workspace_id, user_id, joined_at) VALUES (?, ?, ?)', t.workspaceId, userId, now) === 1;
      if (member || !first) return false;
      db.run('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', t.workspaceId, userId, t.role, now);
      return true;
    });
    if (joined) ctx.bus.publish(t.workspaceId, { entity: 'members', workspaceId: t.workspaceId });
  }
}
