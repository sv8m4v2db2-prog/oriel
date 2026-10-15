// Personal API tokens (contract: shared/src/apiTokens.ts) — authentication of `Authorization: Bearer or_…`
// requests, scope enforcement and workspace restriction.
//
// - Bearer requests are not cookie-based: app.ts skips the CSRF rules (Origin / Content-Type) only for a
//   valid token sent WITHOUT a session cookie, and the cookie is never used for authentication when a
//   token is present (an invalid token never falls back to it). Browsers cannot attach this header
//   cross-origin without a CORS preflight, which the server never answers.
// - Only `Bearer or_…` credentials are handled: any other Authorization value (e.g. the Basic auth of a
//   reverse proxy) is ignored and the request goes through the regular cookie session pipeline.
// - `read` tokens: 403 on every mutating method. Cookie-only routes (see COOKIE_ONLY): account security
//   and settings, instance administration, workspace deletion, invitations and roles, publication, AI settings.
// - Workspace-restricted tokens: the request runs inside an AsyncLocalStorage scope consulted by the
//   central access helpers (`roleOf` — hence `pageAccess` —, `requireWorkspace` in access.ts, workspace
//   summaries in services/workspaces.ts): any other workspace is invisible (404). A parameter guard checks
//   ids of the route (`:wid`, `:pid`, `:did`, `:vid`, `:tid`, `:cid`, `:nid`, brief ids) as a second line
//   of defence.
// - Revocation: by the owner (routes/tokens.ts), and by database triggers (db/features/mcp.ts) when the
//   password changes or when the owner leaves the workspace a token is restricted to.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_TOKEN_LIMITS, API_TOKEN_PREFIX, hasApiTokenPrefix, type ApiTokenScope } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/rows.js';
import { forbidden, notFound, rateLimited, unauthorized } from '../errors.js';
import { clientKey, RateLimiter } from './rateLimit.js';
import { hashToken } from './sessions.js';

export interface ApiTokenAuth {
  id: string;
  userId: string;
  scope: ApiTokenScope;
  /** Restricted to this workspace, or null. */
  workspaceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the request is authenticated by a personal API token (req.auth is set too). */
    apiToken: ApiTokenAuth | null;
  }
}

/** Test-only overrides (set before starting the server). Never set in production code. */
export const apiTokenTestHooks: { requestsPerMinute?: number } = {};

const TOKEN_RE = /^or_[A-Za-z0-9_-]{43}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** `last_used_at` is written at most once per minute and per token. */
const TOUCH_INTERVAL_MS = 60_000;
/** Invalid tokens accepted per minute and per IP before 429. */
const FAILURES_PER_MINUTE = 60;

export const API_TOKEN_DISPLAY_LENGTH = API_TOKEN_PREFIX.length + 6;

export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, API_TOKEN_DISPLAY_LENGTH) };
}

/**
 * The raw token of an `Authorization: Bearer or_…` header, or null when the header is absent or carries
 * another scheme / credential (left to the regular pipeline).
 */
export function bearerApiToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m || !hasApiTokenPrefix(m[1]!)) return null;
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Workspace restriction (request scope)
// ---------------------------------------------------------------------------

interface TokenScope {
  userId: string;
  workspaceId: string;
}

const scopeStorage = new AsyncLocalStorage<TokenScope>();

/**
 * False when the current request is authenticated by a token of `userId` restricted to another
 * workspace. Consulted by the central access helpers (access.ts, services/workspaces.ts).
 */
export function workspaceAllowed(userId: string, workspaceId: string): boolean {
  const scope = scopeStorage.getStore();
  return !scope || scope.userId !== userId || scope.workspaceId === workspaceId;
}

/** Runs `fn` with the restriction of a workspace-restricted token (tests, background work). */
export function runWithWorkspaceRestriction<T>(scope: TokenScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** Workspace of the resource designated by a route parameter (undefined: unknown id or parameter). */
const PARAM_WORKSPACE_SQL: Record<string, string> = {
  pid: 'SELECT workspace_id AS w FROM pages WHERE id = ?',
  did: 'SELECT workspace_id AS w FROM pages WHERE id = ?',
  vid: 'SELECT p.workspace_id AS w FROM views v JOIN pages p ON p.id = v.database_id WHERE v.id = ?',
  tid: 'SELECT workspace_id AS w FROM collab_threads WHERE id = ?',
  cid: 'SELECT t.workspace_id AS w FROM collab_comments c JOIN collab_threads t ON t.id = c.thread_id WHERE c.id = ?',
  nid: 'SELECT workspace_id AS w FROM collab_notifications WHERE id = ?',
};
const BRIEF_WORKSPACE_SQL = 'SELECT workspace_id AS w FROM ai_briefs WHERE id = ?';

function paramWorkspaces(ctx: AppContext, req: FastifyRequest): string[] {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const route = req.routeOptions.url ?? '';
  const out: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value) continue;
    if (name === 'wid') {
      out.push(value);
      continue;
    }
    const sql = PARAM_WORKSPACE_SQL[name] ?? (name === 'id' && route.startsWith('/api/ai/briefs/') ? BRIEF_WORKSPACE_SQL : undefined);
    if (!sql) continue;
    try {
      const row = ctx.db.get<{ w: string }>(sql, value);
      if (row) out.push(row.w);
    } catch {
      /* table of a disabled module: nothing to check */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

const READS = new Set(['GET', 'HEAD']);
/**
 * Routes that require a cookie session, whatever the token scope: account security and settings, instance
 * administration, and actions whose effect would outlive the token's revocation (invitations, roles,
 * publication, AI settings). `[^/]+` matches both a route pattern parameter (`:wid`) and a raw id.
 */
const COOKIE_ONLY: Array<{ re: RegExp; methods?: 'writes' | 'delete' }> = [
  { re: /^\/api\/me\/tokens(\/|$)/ },
  { re: /^\/api\/me\/password$/ },
  // Account settings (QA-TOK-02): global to the account, so out of reach of a workspace restriction
  // (name and avatar URL shown in every workspace, e-mail notifications that warn the owner).
  { re: /^\/api\/me$/, methods: 'writes' },
  { re: /^\/api\/me\/notification-settings$/, methods: 'writes' },
  { re: /^\/api\/auth\//, methods: 'writes' },
  { re: /^\/api\/admin(\/|$)/ },
  { re: /^\/api\/workspaces\/[^/]+$/, methods: 'delete' },
  { re: /^\/api\/workspaces\/[^/]+\/members\/[^/]+$/, methods: 'writes' },
  { re: /^\/api\/workspaces\/[^/]+\/invites(\/|$)/ },
  { re: /^\/api\/invites\//, methods: 'writes' },
  { re: /^\/api\/pages\/[^/]+\/publish$/ },
  { re: /^\/api\/workspaces\/[^/]+\/ai\/settings$/, methods: 'writes' },
  // Account security (G9): never reachable with a token, reads included.
  { re: /^\/api\/me\/security(\/|$)/ },
  { re: /^\/api\/me\/email$/ },
  { re: /^\/api\/me\/transfers$/ },
  { re: /^\/api\/transfers\// },
  { re: /^\/api\/auth\/reauth(\/|$)/ },
  { re: /^\/api\/workspaces\/[^/]+\/(transfer|security|domains)(\/|$)/ },
];

function isCookieOnlyRoute(path: string, method: string): boolean {
  return COOKIE_ONLY.some(
    (r) => r.re.test(path) && (r.methods === undefined || (r.methods === 'writes' ? !READS.has(method) : method === 'DELETE')),
  );
}

interface TokenUserRow extends UserRow {
  t_id: string;
  t_scope: ApiTokenScope;
  t_workspace_id: string | null;
  t_expires_at: number | null;
  t_revoked_at: number | null;
  t_last_used_at: number | null;
}

export interface ApiTokenAuthenticator {
  /**
   * Authenticates a `Bearer or_…` request (sets `req.auth` and `req.apiToken`) and returns true; returns
   * false when the request carries no API token. Throws 401 / 403 / 429.
   */
  authenticate(req: FastifyRequest): boolean;
}

/** Decorates requests, installs the workspace-restriction hook and returns the authenticator used by app.ts. */
export function setupApiTokenAuth(app: FastifyInstance, ctx: AppContext): ApiTokenAuthenticator {
  const { db } = ctx;
  const limiter = new RateLimiter(apiTokenTestHooks.requestsPerMinute ?? API_TOKEN_LIMITS.requestsPerMinute, 60_000);
  const failures = new RateLimiter(FAILURES_PER_MINUTE, 60_000);

  app.decorateRequest('apiToken', null);

  // Runs the handler (and the hooks after this one) inside the restriction scope. Callback style: the
  // rest of the chain is invoked synchronously from `done`, so it inherits the AsyncLocalStorage store.
  app.addHook('preHandler', (req, _reply, done) => {
    const token = req.apiToken;
    if (!token?.workspaceId) return done();
    const restricted = token.workspaceId;
    if (paramWorkspaces(ctx, req).some((w) => w !== restricted)) return done(notFound('Ressource introuvable.'));
    scopeStorage.run({ userId: token.userId, workspaceId: restricted }, done);
  });

  return {
    authenticate(req) {
      const raw = bearerApiToken(req.headers.authorization);
      if (raw === null) return false;
      const route = req.routeOptions.url ?? '';
      const path = req.url.split('?')[0] ?? '';
      if (isCookieOnlyRoute(route, req.method) || isCookieOnlyRoute(path, req.method)) {
        throw forbidden("Cette action n'est pas disponible avec un jeton d'API : connectez-vous à Oriel dans le navigateur.");
      }
      const now = Date.now();
      const row = TOKEN_RE.test(raw)
        ? db.get<TokenUserRow>(
            `SELECT u.*, t.id AS t_id, t.scope AS t_scope, t.workspace_id AS t_workspace_id, t.expires_at AS t_expires_at,
                    t.revoked_at AS t_revoked_at, t.last_used_at AS t_last_used_at
             FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
            hashToken(raw),
          )
        : undefined;
      if (!row || row.t_revoked_at !== null || (row.t_expires_at !== null && row.t_expires_at <= now)) {
        if (!failures.hit(`api-token:${clientKey(req.ip)}`, now)) throw rateLimited();
        throw unauthorized("Jeton d'API invalide, expiré ou révoqué.");
      }
      if (!limiter.hit(row.t_id, now)) {
        throw rateLimited(`Trop de requêtes avec ce jeton d'API (${API_TOKEN_LIMITS.requestsPerMinute} par minute). Réessayez dans une minute.`);
      }
      if (row.t_scope !== 'write' && MUTATING.has(req.method)) {
        throw forbidden("Ce jeton d'API est en lecture seule : créez un jeton « Lecture et écriture » pour modifier l'espace.");
      }
      if (row.t_workspace_id && req.method === 'POST' && (route === '/api/workspaces' || path === '/api/workspaces')) {
        throw forbidden("Ce jeton d'API est limité à un espace de travail : il ne peut pas en créer d'autres.");
      }
      if (row.t_last_used_at === null || now - row.t_last_used_at >= TOUCH_INTERVAL_MS) {
        db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.t_id);
      }
      const { t_id, t_scope, t_workspace_id, t_expires_at: _e, t_revoked_at: _r, t_last_used_at: _l, ...user } = row;
      req.auth = { user, sessionId: `api-token:${t_id}` };
      req.apiToken = { id: t_id, userId: user.id, scope: t_scope, workspaceId: t_workspace_id };
      return true;
    },
  };
}
