// Passkeys (WebAuthn) with @simplewebauthn/server. The relying party is derived from PUBLIC_URL only:
// https, or http on localhost / *.localhost (secure contexts). Without it — and in the desktop local
// mode, whose 127.0.0.1 origin is not a valid rpID — passkeys are unavailable. Never derived from the
// Host header: a client chooses it.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { newId, SECURITY_LIMITS, type WebAuthnJson } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/rows.js';
import { badRequest, conflict } from '../errors.js';
import { challengeData, consumeChallenge, createChallenge, findChallenge, type ChallengeKind, type ChallengeRow } from './security.js';

export interface RelyingParty {
  rpID: string;
  origin: string;
}

export function relyingParty(ctx: AppContext): RelyingParty | null {
  if (ctx.config.localMode || !ctx.config.publicUrl) return null;
  let url: URL;
  try {
    url = new URL(ctx.config.publicUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const localHost = host === 'localhost' || host.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) return null;
  // An IP address is not a valid rpID.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  return { rpID: host, origin: url.origin };
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
}

const transportsOf = (row: { transports: string | null }): AuthenticatorTransport[] | undefined =>
  row.transports ? (JSON.parse(row.transports) as AuthenticatorTransport[]) : undefined;

const unavailable = () => badRequest('Les clés d’accès ne sont pas disponibles sur ce serveur (PUBLIC_URL en https requis).');

/** A clean, bounded passkey name. */
export function passkeyName(name: unknown): string {
  const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, SECURITY_LIMITS.passkeyNameMax) : '';
  return text || 'Clé d’accès';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registrationOptions(ctx: AppContext, user: UserRow, sessionId: string): Promise<{ ticket: string; options: WebAuthnJson }> {
  const rp = relyingParty(ctx);
  if (!rp) throw unavailable();
  const existing = ctx.db.all<PasskeyRow>('SELECT * FROM auth_passkeys WHERE user_id = ?', user.id);
  if (existing.length >= SECURITY_LIMITS.passkeysPerUser) throw badRequest(`Vous avez déjà ${SECURITY_LIMITS.passkeysPerUser} clés d’accès : retirez-en une avant d’en ajouter.`);
  const options = await generateRegistrationOptions({
    rpName: 'Oriel',
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name,
    // The user handle is the opaque account id: no personal data in the authenticator beyond the name shown.
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: transportsOf(p) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    timeout: 120_000,
  });
  const ticket = createChallenge(ctx.db, 'passkey-register', { userId: user.id, sessionId, data: { challenge: options.challenge } });
  return { ticket, options: options as unknown as WebAuthnJson };
}

export async function verifyRegistration(
  ctx: AppContext,
  user: UserRow,
  sessionId: string,
  ticket: string | undefined,
  response: unknown,
  name: unknown,
): Promise<string> {
  const rp = relyingParty(ctx);
  if (!rp) throw unavailable();
  const row = findChallenge(ctx.db, 'passkey-register', ticket);
  if (!row || row.user_id !== user.id || row.session_id !== sessionId || !consumeChallenge(ctx.db, row)) {
    throw badRequest('Demande d’ajout expirée : recommencez.');
  }
  const { challenge } = challengeData<{ challenge: string }>(row);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch {
    throw badRequest('Clé d’accès refusée : réponse invalide.');
  }
  if (!verification.verified) throw badRequest('Clé d’accès refusée.');
  const info = verification.registrationInfo;
  if (ctx.db.get('SELECT 1 AS x FROM auth_passkeys WHERE credential_id = ?', info.credential.id)) throw conflict('Cette clé d’accès est déjà enregistrée.');
  const id = newId();
  ctx.db.run(
    `INSERT INTO auth_passkeys (id, user_id, credential_id, public_key, counter, transports, name, backed_up, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    user.id,
    info.credential.id,
    info.credential.publicKey,
    info.credential.counter,
    info.credential.transports ? JSON.stringify(info.credential.transports) : null,
    passkeyName(name),
    info.credentialBackedUp ? 1 : 0,
    Date.now(),
  );
  return id;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Options of an assertion. `userId` given: only that account's credentials are allowed (second step,
 * re-authentication); otherwise discoverable credentials (sign-in without password).
 */
export async function authenticationOptions(ctx: AppContext, userId: string | null): Promise<WebAuthnJson & { challenge: string }> {
  const rp = relyingParty(ctx);
  if (!rp) throw unavailable();
  const allow = userId
    ? ctx.db.all<PasskeyRow>('SELECT * FROM auth_passkeys WHERE user_id = ?', userId).map((p) => ({ id: p.credential_id, transports: transportsOf(p) }))
    : undefined;
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, allowCredentials: allow, userVerification: userId ? 'preferred' : 'required', timeout: 120_000 });
  return options as unknown as WebAuthnJson & { challenge: string };
}

export async function passkeyChallenge(
  ctx: AppContext,
  kind: Extract<ChallengeKind, 'passkey-auth' | 'passkey-reauth'>,
  opts: { userId: string | null; sessionId?: string },
): Promise<{ ticket: string; options: WebAuthnJson }> {
  const options = await authenticationOptions(ctx, opts.userId);
  const ticket = createChallenge(ctx.db, kind, { userId: opts.userId, sessionId: opts.sessionId ?? null, data: { challenge: options.challenge } });
  return { ticket, options };
}

/**
 * Verifies an assertion against `challenge`. Returns the owner's id, or null. `expectUserId`: the
 * credential must belong to that account. `requireUv`: user verification (PIN, biometrics) required —
 * always for a sign-in without password.
 */
export async function verifyAssertion(
  ctx: AppContext,
  challenge: string,
  response: unknown,
  opts: { expectUserId?: string; requireUv: boolean },
): Promise<string | null> {
  const rp = relyingParty(ctx);
  if (!rp) return null;
  const credentialId = (response as { id?: unknown } | null)?.id;
  if (typeof credentialId !== 'string' || credentialId.length > 1024) return null;
  const row = ctx.db.get<PasskeyRow>('SELECT * FROM auth_passkeys WHERE credential_id = ?', credentialId);
  if (!row || (opts.expectUserId && row.user_id !== opts.expectUserId)) return null;
  // Discoverable sign-in: the user handle, when present, must match the credential's owner.
  const handle = (response as { response?: { userHandle?: unknown } }).response?.userHandle;
  if (typeof handle === 'string' && handle) {
    let owner = '';
    try {
      owner = Buffer.from(handle, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    if (owner !== row.user_id) return null;
  }
  try {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transportsOf(row) },
      requireUserVerification: opts.requireUv,
    });
    if (!result.verified) return null;
    // Counter regression (cloned authenticator) is rejected by the library; store the new value.
    ctx.db.run('UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ?', result.authenticationInfo.newCounter, Date.now(), row.id);
    return row.user_id;
  } catch {
    return null;
  }
}

/** Consumes a passkey challenge (single use) and verifies the assertion. */
export async function verifyChallengeAssertion(
  ctx: AppContext,
  row: ChallengeRow | null,
  response: unknown,
  opts: { expectUserId?: string; requireUv: boolean },
): Promise<string | null> {
  if (!row || !consumeChallenge(ctx.db, row)) return null;
  return verifyAssertion(ctx, challengeData<{ challenge: string }>(row).challenge, response, opts);
}
