// Encryption at rest of account secrets (TOTP seeds): AES-256-GCM with a random 96-bit IV and the
// owner's id as additional data (a ciphertext copied to another account does not decrypt).
//
// Key: HKDF-SHA256 of ORIEL_SECRETS_KEY when set (at least 32 characters), otherwise of a 32-byte
// random file `<DATA_DIR>/secret.key` created on first use with mode 0600. Losing the key makes the
// stored secrets unreadable (an instance administrator then resets the affected accounts).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 'v1';
const KEY_FILE = 'secret.key';
/** HKDF label: part of the key derivation, changing it makes every stored secret undecipherable. */
const KDF_LABEL = 'oriel-secrets-v1';
export const SECRETS_KEY_ENV = 'ORIEL_SECRETS_KEY';
export const SECRETS_KEY_MIN_LENGTH = 32;

const keys = new Map<string, Buffer>();

/** Throws when ORIEL_SECRETS_KEY is set but too short (checked at startup). */
export function checkSecretsKeyEnv(env: NodeJS.ProcessEnv = process.env): void {
  const value = env[SECRETS_KEY_ENV];
  if (value !== undefined && value !== '' && value.length < SECRETS_KEY_MIN_LENGTH) {
    throw new Error(`${SECRETS_KEY_ENV} doit contenir au moins ${SECRETS_KEY_MIN_LENGTH} caractères.`);
  }
}

function readOrCreateKeyFile(dataDir: string): Buffer {
  const file = path.join(dataDir, KEY_FILE);
  try {
    fs.writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const stat = fs.statSync(file);
  // Never readable by other local accounts, whatever the umask or a copy made by hand.
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  const raw = fs.readFileSync(file);
  if (raw.length !== 32) throw new Error(`${file} est invalide (32 octets attendus).`);
  return raw;
}

export function secretsKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env[SECRETS_KEY_ENV];
  const cacheKey = fromEnv ? `env:${fromEnv}` : `file:${path.resolve(dataDir)}`;
  let key = keys.get(cacheKey);
  if (!key) {
    checkSecretsKeyEnv(env);
    const ikm = fromEnv ? Buffer.from(fromEnv, 'utf8') : readOrCreateKeyFile(dataDir);
    key = Buffer.from(hkdfSync('sha256', ikm, KDF_LABEL, 'account-secrets', 32));
    keys.set(cacheKey, key);
  }
  return key;
}

export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** Plaintext, or null when the value is malformed, was sealed with another key or for another owner. */
export function open(key: Buffer, sealed: string, aad: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
