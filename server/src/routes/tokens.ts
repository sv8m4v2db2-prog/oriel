// HTTP routes of the "mcp" feature module: personal API tokens (contract: shared/src/apiTokens.ts).
// Managing tokens requires a cookie session (a token can never list, create or revoke tokens);
// GET /api/me/current-token lets a token describe itself (scope, workspace, expiry).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_TOKEN_LIMITS,
  newId,
  type ApiTokenInfo,
  type ApiTokenScope,
  type ApiTokensResponse,
  type CreatedApiToken,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Auth } from '../auth/sessions.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requireWorkspace } from '../access.js';
import { generateApiToken } from '../auth/apiTokens.js';

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scope: ApiTokenScope;
  workspace_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  workspace_name: string | null;
}

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(API_TOKEN_LIMITS.nameMax)
    .regex(/^[^\u0000-\u001f\u007f]+$/, 'caractères de contrôle interdits'),
  scope: z.enum(['read', 'write']),
  workspaceId: idParam.nullable().optional(),
  expiresInDays: z.number().int().min(1).max(API_TOKEN_LIMITS.maxDays).nullable().optional(),
});
const idParams = z.object({ id: idParam });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Token columns + name of the restricted workspace (only while the owner is still a member). */
const SELECT_TOKENS = `SELECT t.id, t.user_id, t.name, t.prefix, t.scope, t.workspace_id, t.created_at, t.last_used_at,
         t.expires_at, t.revoked_at, w.name AS workspace_name
  FROM api_tokens t
  LEFT JOIN members m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
  LEFT JOIN workspaces w ON w.id = m.workspace_id`;

function toInfo(row: TokenRow, now = Date.now()): ApiTokenInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    expired: row.expires_at !== null && row.expires_at <= now,
  };
}

/** Cookie session required: API tokens cannot manage tokens (also enforced in auth/apiTokens.ts). */
function requireCookieSession(req: FastifyRequest): Auth {
  const auth = requireAuth(req);
  if (req.apiToken) throw forbidden("Les jetons d'API ne peuvent pas gérer les jetons : connectez-vous à Oriel dans le navigateur.");
  return auth;
}

export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const tokenRow = (id: string) => db.get<TokenRow>(`${SELECT_TOKENS} WHERE t.id = ?`, id);

  app.get('/api/me/tokens', async (req): Promise<ApiTokensResponse> => {
    const { user } = requireCookieSession(req);
    const rows = db.all<TokenRow>(`${SELECT_TOKENS} WHERE t.user_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at DESC, t.id`, user.id);
    const now = Date.now();
    return { tokens: rows.map((r) => toInfo(r, now)) };
  });

  app.post('/api/me/tokens', async (req): Promise<CreatedApiToken> => {
    const { user } = requireCookieSession(req);
    const body = parse(createSchema, req.body);
    const created = db.tx(() => {
      if (body.workspaceId) requireWorkspace(db, user.id, body.workspaceId);
      const active = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL', user.id)!.n;
      if (active >= API_TOKEN_LIMITS.maxPerUser) {
        throw badRequest(`Vous avez déjà ${API_TOKEN_LIMITS.maxPerUser} jetons d'API : révoquez-en avant d'en créer un nouveau.`);
      }
      const { token, hash, prefix } = generateApiToken();
      const id = newId();
      const now = Date.now();
      db.run(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, workspace_id, created_at, last_used_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        id,
        user.id,
        body.name,
        hash,
        prefix,
        body.scope,
        body.workspaceId ?? null,
        now,
        body.expiresInDays ? now + body.expiresInDays * DAY_MS : null,
      );
      return { id, token };
    });
    return { ...toInfo(tokenRow(created.id)!), token: created.token };
  });

  app.delete('/api/me/tokens/:id', async (req) => {
    const { user } = requireCookieSession(req);
    const { id } = parse(idParams, req.params);
    const changed = db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', Date.now(), id, user.id);
    if (changed === 0) throw notFound("Jeton d'API introuvable.");
    return { ok: true as const };
  });

  app.get('/api/me/current-token', async (req): Promise<ApiTokenInfo> => {
    requireAuth(req);
    if (!req.apiToken) throw notFound("Cette requête n'est pas authentifiée par un jeton d'API.");
    const row = tokenRow(req.apiToken.id);
    if (!row) throw notFound("Jeton d'API introuvable.");
    return toInfo(row);
  });
}
