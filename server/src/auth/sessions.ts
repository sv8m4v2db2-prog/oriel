import { createHash, randomBytes } from 'node:crypto';
import { LIMITS } from '@oriel/shared';
import type { Db } from '../db/index.js';
import type { UserRow } from '../db/rows.js';

export const SESSION_COOKIE = 'oriel_session';
export const SESSION_TTL_MS = LIMITS.sessionDays * 24 * 60 * 60 * 1000;
/** Sliding expiration: extend at most once per hour of activity. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export interface Auth {
  user: UserRow;
  /** Hashed session id (primary key of `sessions`). */
  sessionId: string;
  /** Last strong authentication of the session (login or re-authentication); null for API tokens. */
  authAt?: number | null;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * `amr`: authentication methods (e.g. "pwd", "pwd+totp", "passkey", "oidc", "local") — the session counts
 * as freshly authenticated (sessions.auth_at = now, see auth/stepUp.ts).
 */
export function createSession(
  db: Db,
  userId: string,
  userAgent: string | undefined,
  amr = 'pwd',
): { token: string; sessionId: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const sessionId = hashToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, auth_at, amr) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sessionId,
    userId,
    now,
    expiresAt,
    (userAgent ?? '').slice(0, 300) || null,
    now,
    amr,
  );
  return { token, sessionId, expiresAt };
}

/**
 * Resolves a raw cookie token. Returns the session (and whether its expiration was extended, in which
 * case the caller should re-send the cookie) or null when missing/expired.
 */
export function resolveSession(db: Db, token: string | undefined): (Auth & { refreshed: boolean }) | null {
  if (!token || token.length > 200) return null;
  const sessionId = hashToken(token);
  const row = db.get<UserRow & { s_expires_at: number; s_auth_at: number | null }>(
    `SELECT u.*, s.expires_at AS s_expires_at, s.auth_at AS s_auth_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return null;
  const now = Date.now();
  if (row.s_expires_at <= now) {
    db.run('DELETE FROM sessions WHERE id = ?', sessionId);
    return null;
  }
  let refreshed = false;
  if (row.s_expires_at - now < SESSION_TTL_MS - REFRESH_AFTER_MS) {
    db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', now + SESSION_TTL_MS, sessionId);
    refreshed = true;
  }
  const { s_expires_at: _ignored, s_auth_at: authAt, ...user } = row;
  return { user, sessionId, refreshed, authAt };
}

export function deleteSession(db: Db, sessionId: string): void {
  db.run('DELETE FROM sessions WHERE id = ?', sessionId);
}

/** Minimal Cookie header parser (used for WebSocket upgrades). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (!(key in out)) out[key] = value;
  }
  return out;
}
