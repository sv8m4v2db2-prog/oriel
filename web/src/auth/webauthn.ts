// Browser side of passkeys: JSON options from the server → navigator.credentials → JSON response.
// Uses the native JSON helpers when present, with a manual conversion otherwise.
import type { WebAuthnJson } from '@oriel/shared';

export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials && window.isSecureContext;

function fromB64u(text: string): ArrayBuffer {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64u(buf: ArrayBuffer | ArrayBufferView | null | undefined): string | undefined {
  if (!buf) return undefined;
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Descriptor = { id: string; type?: string; transports?: string[] };
const descriptors = (list: unknown) =>
  ((list as Descriptor[] | undefined) ?? []).map((d) => ({ ...d, type: 'public-key' as const, id: fromB64u(d.id), transports: d.transports as AuthenticatorTransport[] | undefined }));

type JsonCapable = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
};

function credentialJson(cred: PublicKeyCredential): WebAuthnJson {
  const withJson = cred as PublicKeyCredential & { toJSON?: () => WebAuthnJson };
  if (typeof withJson.toJSON === 'function') return withJson.toJSON();
  const r = cred.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const response: Record<string, unknown> = { clientDataJSON: toB64u(r.clientDataJSON) };
  if ('attestationObject' in r && r.attestationObject) {
    response.attestationObject = toB64u(r.attestationObject);
    response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
  } else {
    response.authenticatorData = toB64u(r.authenticatorData);
    response.signature = toB64u(r.signature);
    response.userHandle = toB64u(r.userHandle);
  }
  return { id: cred.id, rawId: toB64u(cred.rawId)!, type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults() };
}

export async function createPasskey(options: WebAuthnJson): Promise<WebAuthnJson> {
  const PKC = window.PublicKeyCredential as JsonCapable;
  const o = options as Record<string, any>;
  const publicKey: PublicKeyCredentialCreationOptions = PKC.parseCreationOptionsFromJSON
    ? PKC.parseCreationOptionsFromJSON(options)
    : {
        ...o,
        challenge: fromB64u(o.challenge),
        user: { ...o.user, id: fromB64u(o.user.id) },
        excludeCredentials: descriptors(o.excludeCredentials),
      } as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Opération annulée.');
  return credentialJson(cred);
}

export async function getPasskey(options: WebAuthnJson): Promise<WebAuthnJson> {
  const PKC = window.PublicKeyCredential as JsonCapable;
  const o = options as Record<string, any>;
  const publicKey: PublicKeyCredentialRequestOptions = PKC.parseRequestOptionsFromJSON
    ? PKC.parseRequestOptionsFromJSON(options)
    : ({ ...o, challenge: fromB64u(o.challenge), allowCredentials: descriptors(o.allowCredentials) } as PublicKeyCredentialRequestOptions);
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Opération annulée.');
  return credentialJson(cred);
}

/** User-facing message for a WebAuthn failure (cancelled dialog, unknown key…). */
export function passkeyError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Opération annulée ou délai dépassé.';
  if (name === 'InvalidStateError') return 'Cette clé d’accès est déjà enregistrée sur ce compte.';
  if (name === 'SecurityError') return 'Les clés d’accès ne sont pas utilisables à cette adresse.';
  return (err as Error | null)?.message || 'Clé d’accès refusée.';
}
