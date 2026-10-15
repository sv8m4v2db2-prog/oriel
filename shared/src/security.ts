// Account security contract (wave G9): two-factor authentication, passkeys, re-authentication of
// sensitive actions, workspace transfer, OIDC single sign-on and verified domains. See docs/SPEC.md,
// section « Sécurité des comptes ».
import type { SessionResponse } from './api.js';
import type { PublicUser } from './types.js';

/** A sensitive action needs a strong authentication at most this old (login included). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
export const SECURITY_LIMITS = {
  passkeyNameMax: 60,
  passkeysPerUser: 20,
  domainsPerWorkspace: 20,
  graceDaysMax: 30,
  transferDays: 7,
} as const;

/** Error codes of 403 responses the web client acts on. */
export const REAUTH_REQUIRED = 'reauth_required';
export const MFA_ENROLLMENT_REQUIRED = 'mfa_enrollment_required';

export type SecondFactorMethod = 'totp' | 'recovery' | 'passkey';
export type ReauthMethod = 'password' | 'totp' | 'passkey' | 'sso';

/** POST /api/auth/login (and password reset, OIDC) when the account has a second factor: no session yet. */
export interface MfaChallengeResponse {
  mfa: { ticket: string; methods: SecondFactorMethod[] };
}
export type LoginResponse = SessionResponse | MfaChallengeResponse;
export const isMfaChallenge = (r: LoginResponse): r is MfaChallengeResponse => 'mfa' in r;

/** WebAuthn JSON (PublicKeyCredentialCreationOptionsJSON / RequestOptionsJSON, RegistrationResponseJSON…). */
export type WebAuthnJson = Record<string, unknown>;

/** POST /api/auth/login/mfa — one of code / recoveryCode / passkey. ticket may come from a cookie (OIDC). */
export interface MfaVerifyRequest {
  ticket?: string;
  code?: string;
  recoveryCode?: string;
  passkey?: WebAuthnJson;
}

/** POST /api/auth/passkey/options, POST /api/auth/login/mfa/passkey-options */
export interface PasskeyOptionsResponse {
  ticket: string;
  options: WebAuthnJson;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

export interface LinkedIdentity {
  issuer: string;
  email: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface RequiringWorkspace {
  workspaceId: string;
  workspaceName: string;
  /** null = enforced now (no grace). */
  graceUntil: number | null;
}

/** GET /api/me/security */
export interface SecurityStatus {
  /** false in the desktop local mode (single local user): every section is hidden. */
  available: boolean;
  passkeysAvailable: boolean;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  passkeys: PasskeyInfo[];
  hasPassword: boolean;
  identities: LinkedIdentity[];
  sso: { label: string } | null;
  /** The session counts as recently authenticated until then (null: re-authentication needed). */
  reauthUntil: number | null;
  /** Workspaces that require two-factor authentication. */
  requiredBy: RequiringWorkspace[];
  /** The account must enrol before using Oriel (grace period over). */
  enrollmentRequired: boolean;
}

/** POST /api/me/security/totp/setup */
export interface TotpSetupResponse {
  secret: string;
  uri: string;
}

/** POST /api/me/security/totp/confirm and /recovery-codes */
export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

/** GET /api/auth/reauth */
export interface ReauthOptionsResponse {
  methods: ReauthMethod[];
  reauthUntil: number | null;
}

/** POST /api/auth/reauth — one of password / code / passkey (with the ticket of /api/auth/reauth/passkey-options). */
export interface ReauthRequest {
  password?: string;
  code?: string;
  ticket?: string;
  passkey?: WebAuthnJson;
}

export type SecurityEvent =
  | 'totp_enabled'
  | 'totp_disabled'
  | 'recovery_codes_generated'
  | 'recovery_code_used'
  | 'passkey_added'
  | 'passkey_removed'
  | 'mfa_reset_by_admin'
  | 'email_changed'
  | 'password_changed'
  | 'sso_linked'
  | 'sso_unlinked'
  | 'transfer_proposed'
  | 'transfer_accepted'
  | 'transfer_declined'
  | 'transfer_cancelled'
  | 'workspace_policy_changed';

export interface SecurityLogEntry {
  id: string;
  event: SecurityEvent;
  detail: string | null;
  actor: PublicUser | null;
  createdAt: number;
}

/** GET /api/workspaces/:wid/security */
export interface WorkspaceSecurityPolicy {
  require2fa: boolean;
  graceUntil: number | null;
  /** Members without a second factor (managers only). */
  nonCompliant: PublicUser[];
}

/** PUT /api/workspaces/:wid/security */
export interface UpdateWorkspaceSecurityRequest {
  require2fa: boolean;
  /** 0 to SECURITY_LIMITS.graceDaysMax. */
  graceDays?: number;
}

export interface WorkspaceTransfer {
  id: string;
  workspaceId: string;
  workspaceName: string;
  from: PublicUser;
  to: PublicUser;
  createdAt: number;
  expiresAt: number;
}

/** GET /api/me/transfers */
export interface TransfersResponse {
  incoming: WorkspaceTransfer[];
  outgoing: WorkspaceTransfer[];
}

export interface VerifiedDomain {
  domain: string;
  verified: boolean;
  verifiedAt: number | null;
  autoJoin: boolean;
  joinRole: 'member' | 'viewer';
  /** DNS TXT record to create. */
  record: { name: string; value: string };
  checkedAt: number | null;
}

/** GET /api/admin/security/users */
export interface AdminUserSecurity {
  userId: string;
  name: string;
  email: string;
  totpEnabled: boolean;
  passkeys: number;
  identities: number;
}
