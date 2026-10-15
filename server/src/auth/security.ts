// Account security state (wave G9): second factors, recovery codes, short-lived challenges (pending
// second step of a login, WebAuthn ceremonies, OIDC requests), security log and the workspace
// two-factor policy. Routes: auth/securityRoutes.ts. Re-authentication: auth/stepUp.ts.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  newId,
  RECOVERY_CODE_COUNT,
  type RequiringWorkspace,
  type SecondFactorMethod,
  type SecurityEvent,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { UserRow } from '../db/rows.js';
import { getMailer, type MailMessage } from '../collab/mailer.js';
import { clientKey, RateLimiter } from './rateLimit.js';
import { hashToken } from './sessions.js';
import { open, seal, secretsKey } from './secretBox.js';
import { verifyTotp } from './totp.js';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong second-factor answers accepted per pending login before it must start over. */
export const MAX_CHALLENGE_ATTEMPTS = 5;

export type ChallengeKind = 'mfa-login' | 'passkey-register' | 'passkey-auth' | 'passkey-reauth' | 'oidc';

export interface ChallengeRow {
  id: string;
  kind: ChallengeKind;
  user_id: string | null;
  session_id: string | null;
  data: string;
  attempts: number;
  created_at: number;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Rate limits shared by the security routes (per account; per IP limits use ctx.authLimiter)
// ---------------------------------------------------------------------------

const limiters = new WeakMap<AppContext, { secondFactor: RateLimiter; dns: RateLimiter }>();

/** 10 second-factor checks per account and per 5 minutes (TOTP: 3 valid codes out of 10^6). */
export function securityLimiters(ctx: AppContext) {
  let l = limiters.get(ctx);
  if (!l) limiters.set(ctx, (l = { secondFactor: new RateLimiter(10, 5 * 60_000), dns: new RateLimiter(10, 60_000) }));
  return l;
}

export const ipKey = (ip: string | undefined) => clientKey(ip);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const hasPassword = (user: Pick<UserRow, 'password_hash'>): boolean => user.password_hash.startsWith('scrypt$');

export function totpRow(db: Db, userId: string) {
  return db.get<{ secret_enc: string; enabled_at: number | null; last_step: number; created_at: number }>(
    'SELECT secret_enc, enabled_at, last_step, created_at FROM auth_totp WHERE user_id = ?',
    userId,
  );
}

export const totpEnabled = (db: Db, userId: string): boolean => !!totpRow(db, userId)?.enabled_at;

export const passkeyCount = (db: Db, userId: string): number =>
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_passkeys WHERE user_id = ?', userId)!.n;

/** Protected account: authenticator app enabled or at least one passkey. */
export const isProtected = (db: Db, userId: string): boolean => totpEnabled(db, userId) || passkeyCount(db, userId) > 0;

export function secondFactorMethods(db: Db, userId: string): SecondFactorMethod[] {
  const out: SecondFactorMethod[] = [];
  if (totpEnabled(db, userId)) out.push('totp', 'recovery');
  if (passkeyCount(db, userId) > 0) out.push('passkey');
  return out;
}

export function requiringWorkspaces(db: Db, userId: string): RequiringWorkspace[] {
  return db
    .all<{ workspace_id: string; name: string; grace_until: number | null }>(
      `SELECT s.workspace_id, w.name, s.grace_until FROM workspace_security s
       JOIN members m ON m.workspace_id = s.workspace_id AND m.user_id = ?
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.require_2fa = 1 ORDER BY w.name`,
      userId,
    )
    .map((r) => ({ workspaceId: r.workspace_id, workspaceName: r.name, graceUntil: r.grace_until }));
}

/** The account must enrol a second factor before anything else (a workspace requires it, grace over). */
export function enrollmentRequired(ctx: AppContext, userId: string, now = Date.now()): boolean {
  if (ctx.config.localMode) return false;
  const required = requiringWorkspaces(ctx.db, userId);
  if (!required.some((r) => r.graceUntil === null || r.graceUntil <= now)) return false;
  return !isProtected(ctx.db, userId);
}

// ---------------------------------------------------------------------------
// TOTP secrets (encrypted at rest)
// ---------------------------------------------------------------------------

const key = (ctx: AppContext) => secretsKey(ctx.config.dataDir);

export function sealTotpSecret(ctx: AppContext, userId: string, secretB32: string): string {
  return seal(key(ctx), secretB32, `totp:${userId}`);
}

export function openTotpSecret(ctx: AppContext, userId: string, sealed: string): string | null {
  return open(key(ctx), sealed, `totp:${userId}`);
}

/**
 * Checks a code of the enabled authenticator app and consumes its time step (atomic: the same code
 * is accepted once, even by concurrent requests). `pendingOnly`: checks the unconfirmed secret instead.
 */
export function checkTotp(ctx: AppContext, userId: string, code: string, opts: { pending?: boolean } = {}, now = Date.now()): boolean {
  const row = totpRow(ctx.db, userId);
  if (!row || (opts.pending ? row.enabled_at !== null : row.enabled_at === null)) return false;
  const secret = openTotpSecret(ctx, userId, row.secret_enc);
  if (!secret) return false;
  const step = verifyTotp(secret, code, row.last_step, now);
  if (step === null) return false;
  return ctx.db.run('UPDATE auth_totp SET last_step = ? WHERE user_id = ? AND last_step < ?', step, userId, step) === 1;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** No 0/O, 1/I/L: easy to copy by hand. 12 characters ≈ 61 bits. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const recoveryHash = (userId: string, code: string) => createHash('sha256').update(`${userId}:${normalizeRecovery(code)}`).digest('hex');

/** Replaces every recovery code of the account; returns the new ones (shown once). */
export function generateRecoveryCodes(db: Db, userId: string, now = Date.now()): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let raw = '';
    for (let j = 0; j < 12; j++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
  }
  db.tx(() => {
    db.run('DELETE FROM auth_recovery_codes WHERE user_id = ?', userId);
    for (const code of codes) db.run('INSERT INTO auth_recovery_codes (code_hash, user_id, created_at, used_at) VALUES (?, ?, ?, NULL)', recoveryHash(userId, code), userId, now);
  });
  return codes;
}

export function consumeRecoveryCode(db: Db, userId: string, code: string, now = Date.now()): boolean {
  if (normalizeRecovery(code).length !== 12) return false;
  return db.run('UPDATE auth_recovery_codes SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL', now, recoveryHash(userId, code), userId) === 1;
}

export const recoveryCodesRemaining = (db: Db, userId: string): number =>
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId)!.n;

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export function createChallenge(
  db: Db,
  kind: ChallengeKind,
  opts: { userId?: string | null; sessionId?: string | null; data?: unknown; ttlMs?: number },
  now = Date.now(),
): string {
  const ticket = randomBytes(32).toString('base64url');
  db.run('DELETE FROM auth_challenges WHERE expires_at <= ?', now);
  db.run(
    'INSERT INTO auth_challenges (id, kind, user_id, session_id, data, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    hashToken(ticket),
    kind,
    opts.userId ?? null,
    opts.sessionId ?? null,
    JSON.stringify(opts.data ?? {}),
    now,
    now + (opts.ttlMs ?? CHALLENGE_TTL_MS),
  );
  return ticket;
}

export function findChallenge(db: Db, kind: ChallengeKind, ticket: string | undefined, now = Date.now()): ChallengeRow | null {
  if (!ticket || ticket.length > 200) return null;
  const row = db.get<ChallengeRow>('SELECT * FROM auth_challenges WHERE id = ? AND kind = ?', hashToken(ticket), kind);
  if (!row || row.expires_at <= now) return null;
  return row;
}

export function challengeData<T>(row: ChallengeRow): T {
  return JSON.parse(row.data) as T;
}

export function updateChallengeData(db: Db, row: ChallengeRow, data: unknown): void {
  db.run('UPDATE auth_challenges SET data = ? WHERE id = ?', JSON.stringify(data), row.id);
}

/** Counts a wrong answer; deletes the challenge after MAX_CHALLENGE_ATTEMPTS. */
export function failChallenge(db: Db, row: ChallengeRow): void {
  if (row.attempts + 1 >= MAX_CHALLENGE_ATTEMPTS) db.run('DELETE FROM auth_challenges WHERE id = ?', row.id);
  else db.run('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?', row.id);
}

/** Single use: true only for the request that deleted it. */
export const consumeChallenge = (db: Db, row: ChallengeRow): boolean => db.run('DELETE FROM auth_challenges WHERE id = ?', row.id) === 1;

// ---------------------------------------------------------------------------
// Sessions, log, mails
// ---------------------------------------------------------------------------

/** Deletes the user's sessions (except `keep`) and closes their live sockets. */
export function revokeSessions(ctx: AppContext, userId: string, keep?: string): void {
  const ids = ctx.db
    .all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, keep ?? null)
    .map((r) => r.id);
  ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, keep ?? null);
  for (const id of ids) {
    ctx.bus.closeSession(id);
    ctx.collab.closeForSession(id);
  }
}

export function logSecurity(
  db: Db,
  entry: { userId: string; event: SecurityEvent; actorId?: string | null; detail?: string | null; ip?: string | null },
  now = Date.now(),
): void {
  db.run(
    'INSERT INTO auth_security_log (id, user_id, actor_id, event, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    entry.userId,
    entry.actorId ?? entry.userId,
    entry.event,
    entry.detail ? entry.detail.slice(0, 300) : null,
    entry.ip ? ipKey(entry.ip) : null,
    now,
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain security notice (no link: the person goes to Oriel by themselves). */
export function securityMail(to: string, subject: string, paragraphs: string[]): MailMessage {
  const text = `${paragraphs.join('\n\n')}\n\n— Oriel`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">${paragraphs
    .map((p) => `<p style="font-size:15px;line-height:1.55;color:#37352f">${escapeHtml(p)}</p>`)
    .join('')}<p style="color:#787774;font-size:13px">— Oriel</p></div>`;
  return { to, subject, text, html };
}

/** Sends after the response, never throws. */
export function sendSecurityMail(ctx: AppContext, mail: MailMessage, log?: (msg: string, err?: unknown) => void): void {
  setImmediate(() => {
    const mailer = getMailer(ctx);
    if (!mailer.enabled) return;
    void mailer.send(mail, log ?? (() => {})).catch(() => {});
  });
}
