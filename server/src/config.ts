import path from 'node:path';
import { LIMITS, type SignupMode } from '@oriel/shared';
import { resolveWebDist } from './util/paths.js';
import { parseTrustProxy, proxyTrust, type TrustProxySetting } from './util/proxyTrust.js';

export interface ServerOptions {
  /** HTTP port; 0 picks a free port (the actual one is returned by startServer). */
  port: number;
  host: string;
  /** Holds oriel.db and uploads/. */
  dataDir: string;
  /** SPA build directory; null = auto-detect (see resolveWebDist). */
  webDist: string | null;
  /** Public URL without trailing slash (absolute invite links). Empty = relative links. */
  publicUrl: string;
  /** Initial signup mode (stored in the database on first start, then admin-controlled). */
  signupMode: SignupMode;
  maxUploadMb: number;
  /** Peers allowed to set X-Forwarded-* (see util/proxyTrust.ts): true = loopback + private networks. */
  trustProxy: TrustProxySetting;
  logLevel: string;
  /** Desktop local mode: auto-login of the local user from loopback. */
  localMode: boolean;
  /** Login/signup attempts per minute and per IP. */
  authRateLimit: number;
  /** Hocuspocus onStoreDocument debounce / max debounce (ms). */
  collabDebounceMs: number;
  collabMaxDebounceMs: number;
  /** Micro-batching window of the invalidation bus (ms). */
  eventBatchMs: number;
  /** Run the hourly maintenance job. */
  jobs: boolean;
}

export interface ResolvedConfig extends ServerOptions {
  /** Resolved SPA directory (null when the web client has not been built). */
  resolvedWebDist: string | null;
  uploadsDir: string;
  dbFile: string;
  /** True when this immediate peer (socket address) may set X-Forwarded-* headers. */
  isTrustedProxy: (address: string | undefined) => boolean;
}

const SIGNUP_MODES: SignupMode[] = ['first-user', 'invite', 'open'];

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const signupMode = (env.SIGNUP_MODE ?? '').trim() as SignupMode;
  return {
    port: envInt(env.PORT, 3000),
    host: env.HOST?.trim() || '0.0.0.0',
    dataDir: env.DATA_DIR?.trim() || './data',
    webDist: env.WEB_DIST?.trim() || null,
    publicUrl: (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
    signupMode: SIGNUP_MODES.includes(signupMode) ? signupMode : 'first-user',
    maxUploadMb: Math.max(1, envInt(env.MAX_UPLOAD_MB, LIMITS.uploadMaxMbDefault)),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    localMode: envBool(env.ORIEL_LOCAL_MODE, false),
    authRateLimit: Math.max(1, envInt(env.AUTH_RATE_LIMIT, 10)),
    collabDebounceMs: 2000,
    collabMaxDebounceMs: 10000,
    eventBatchMs: 50,
    jobs: true,
  };
}

/** Database file name in DATA_DIR. */
export const DB_FILE = 'oriel.db';

export function resolveConfig(overrides: Partial<ServerOptions> = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) as Partial<ServerOptions>;
  const opts: ServerOptions = { ...optionsFromEnv(env), ...defined };
  const dataDir = path.resolve(opts.dataDir);
  return {
    ...opts,
    publicUrl: opts.publicUrl.replace(/\/+$/, ''),
    dataDir,
    resolvedWebDist: resolveWebDist(opts.webDist ?? undefined),
    uploadsDir: path.join(dataDir, 'uploads'),
    dbFile: path.join(dataDir, DB_FILE),
    isTrustedProxy: proxyTrust(opts.trustProxy),
  };
}
