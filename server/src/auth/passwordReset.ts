// Password reset tokens: random 32-byte secrets sent by e-mail (or shown to an instance admin),
// stored hashed (SHA-256), single use, short-lived. Creating a token invalidates the user's
// previous unused tokens.
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { hashToken } from './sessions.js';

/** Link sent by e-mail ("Mot de passe oublié"). */
export const RESET_TTL_MS = 60 * 60 * 1000;
/** Link created by an instance administrator (handed over manually). */
export const ADMIN_RESET_TTL_MS = 24 * 60 * 60 * 1000;

export interface ResetTokenRow {
  id: string;
  user_id: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export function createResetToken(db: Db, userId: string, createdBy: string | null, ttlMs = RESET_TTL_MS, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + ttlMs;
  db.tx(() => {
    db.run('DELETE FROM collab_password_resets WHERE user_id = ? AND used_at IS NULL', userId);
    db.run(
      'INSERT INTO collab_password_resets (id, user_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)',
      hashToken(token),
      userId,
      createdBy,
      now,
      expiresAt,
    );
  });
  return { token, expiresAt };
}

/** A usable token (not used, not expired) or null. */
export function findResetToken(db: Db, token: string, now = Date.now()): ResetTokenRow | null {
  if (!token || token.length > 200) return null;
  const row = db.get<ResetTokenRow>('SELECT * FROM collab_password_resets WHERE id = ?', hashToken(token));
  if (!row || row.used_at !== null || row.expires_at <= now) return null;
  return row;
}

/** Marks the token used and removes the user's other pending tokens (call inside a transaction). */
export function consumeResetToken(db: Db, row: ResetTokenRow, now = Date.now()): void {
  db.run('UPDATE collab_password_resets SET used_at = ? WHERE id = ?', now, row.id);
  db.run('DELETE FROM collab_password_resets WHERE user_id = ? AND used_at IS NULL', row.user_id);
}

/** Drops the user's unused tokens (e.g. after a password change: old links must stop working). */
export function revokeResetTokens(db: Db, userId: string): void {
  db.run('DELETE FROM collab_password_resets WHERE user_id = ? AND used_at IS NULL', userId);
}

/** "alice@example.com" → "al***@example.com" */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const keep = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${keep}***@${domain}`;
}
