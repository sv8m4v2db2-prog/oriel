// Contract of the "mcp" feature module: personal API tokens (types shared by server and web).
//
// Routes (all under /api):
//   GET    /me/tokens             → ApiTokensResponse          (cookie session only)
//   POST   /me/tokens             → CreatedApiToken            (cookie session only)
//   DELETE /me/tokens/:id         → { ok: true }               (cookie session only)
//   GET    /me/current-token      → ApiTokenInfo               (API token only: introspection)
//
// Authentication with a token: `Authorization: Bearer or_…` on any other /api route (never in the
// query string). Bearer requests are not cookie-based, so the CSRF rules do not apply to them;
// `read` tokens get 403 on every POST/PUT/PATCH/DELETE; workspace-restricted tokens only see that
// workspace (404 elsewhere). WebSocket endpoints (/collab, /api/events) keep cookie auth only.

/** Prefix of every personal API token (`or_` + 43 base64url characters). */
export const API_TOKEN_PREFIX = 'or_';

export const hasApiTokenPrefix = (value: string): boolean => value.startsWith(API_TOKEN_PREFIX);

export type ApiTokenScope = 'read' | 'write';

export const API_TOKEN_SCOPE_LABELS: Record<ApiTokenScope, string> = {
  read: 'Lecture seule',
  write: 'Lecture et écriture',
};

export const API_TOKEN_LIMITS = {
  /** Active (non-revoked) tokens per user. */
  maxPerUser: 50,
  nameMax: 100,
  maxDays: 3650,
  /** Requests per minute and per token. */
  requestsPerMinute: 600,
} as const;

export interface ApiTokenInfo {
  id: string;
  name: string;
  /** First characters of the token, for display (e.g. "or_x8Kf2a"). */
  prefix: string;
  scope: ApiTokenScope;
  /** Restricted to this workspace, or null (every workspace of the user). */
  workspaceId: string | null;
  /** Name of the restricted workspace (null when unrestricted or no longer accessible). */
  workspaceName: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** null = never expires. */
  expiresAt: number | null;
  expired: boolean;
}

/** GET /api/me/tokens — the user's non-revoked tokens, newest first. */
export interface ApiTokensResponse {
  tokens: ApiTokenInfo[];
}

/** POST /api/me/tokens */
export interface CreateApiTokenRequest {
  name: string;
  scope: ApiTokenScope;
  /** Restrict the token to one workspace (must be a member). */
  workspaceId?: string | null;
  /** 1–3650; omitted or null = never expires. */
  expiresInDays?: number | null;
}

/** The raw `token` is returned once, at creation: only its SHA-256 hash is stored. */
export interface CreatedApiToken extends ApiTokenInfo {
  token: string;
}
