// Software authenticator for tests: builds WebAuthn registration ("none" attestation) and assertion
// responses with a P-256 key, exactly as a browser would send them (RegistrationResponseJSON /
// AuthenticationResponseJSON).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

export interface SoftKey {
  credentialId: Buffer;
  privateKey: KeyObject;
  cose: Buffer;
  counter: number;
}

export function newSoftKey(): SoftKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  return { credentialId: randomBytes(32), privateKey, cose, counter: 0 };
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export function registrationResponse(key: SoftKey, opts: { challenge: string; origin: string; rpId: string; uv?: boolean }) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
  const counter = Buffer.alloc(4);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(key.credentialId.length);
  const authData = Buffer.concat([
    sha256(opts.rpId),
    Buffer.from([UP | AT | (opts.uv === false ? 0 : UV)]),
    counter,
    Buffer.alloc(16),
    credLen,
    key.credentialId,
    key.cose,
  ]);
  const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
  return {
    id: b64u(key.credentialId),
    rawId: b64u(key.credentialId),
    type: 'public-key',
    response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    clientExtensionResults: {},
  };
}

export function assertionResponse(
  key: SoftKey,
  opts: { challenge: string; origin: string; rpId: string; uv?: boolean; userHandle?: string; counter?: number },
) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
  key.counter = opts.counter ?? key.counter + 1;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(key.counter);
  const authData = Buffer.concat([sha256(opts.rpId), Buffer.from([UP | (opts.uv === false ? 0 : UV)]), counter]);
  const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), key.privateKey);
  return {
    id: b64u(key.credentialId),
    rawId: b64u(key.credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
      ...(opts.userHandle ? { userHandle: b64u(Buffer.from(opts.userHandle)) } : {}),
    },
    clientExtensionResults: {},
  };
}
