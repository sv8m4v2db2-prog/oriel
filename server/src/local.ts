// Desktop local mode (ARCHITECTURE §3.1): a single local user, auto-logged-in from loopback.
import { newId } from '@oriel/shared';
import type { AppContext } from './context.js';
import type { UserRow } from './db/rows.js';
import { createWorkspace } from './services/workspaces.js';

export const LOCAL_EMAIL = 'local@oriel.app';
export const LOCAL_NAME = 'Moi';

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
}

/**
 * In local mode the server trusts loopback clients, so the Host header must also be a loopback
 * name: this blocks DNS-rebinding pages (attacker domain resolving to 127.0.0.1).
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/** Creates (if needed) the local user and their workspace. Password login is disabled for this account. */
export function ensureLocalUser(ctx: AppContext): UserRow {
  const { db } = ctx;
  return db.tx(() => {
    let user = db.get<UserRow>('SELECT * FROM users WHERE email = ?', LOCAL_EMAIL);
    if (!user) {
      const id = newId();
      const now = Date.now();
      db.run(
        "INSERT INTO users (id, email, name, avatar_url, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, NULL, 'disabled', 1, ?, ?)",
        id,
        LOCAL_EMAIL,
        LOCAL_NAME,
        now,
        now,
      );
      user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
    }
    if (!db.get('SELECT 1 AS x FROM members WHERE user_id = ?', user.id)) {
      createWorkspace(ctx, user.id, 'Mon espace', null, { welcomePage: true });
    }
    return user;
  });
}
