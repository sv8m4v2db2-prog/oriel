// Feature migrations of the "account security" module (wave G9: two-factor authentication, passkeys,
// re-authentication, workspace transfer, OIDC, verified domains). Append entries; never edit an applied
// one. Ids are prefixed with "sec-".
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    id: 'sec-001-account-security',
    sql: /* sql */ `
-- Time of the last strong authentication of the session (login or re-authentication) and methods used.
ALTER TABLE sessions ADD COLUMN auth_at INTEGER;
ALTER TABLE sessions ADD COLUMN amr TEXT;

-- Authenticator app. secret_enc: AES-256-GCM (auth/secretBox.ts). enabled_at NULL = enrolment not confirmed.
-- last_step: last accepted time step (a code of this step or an older one is refused: no replay).
CREATE TABLE auth_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  enabled_at INTEGER,
  last_step INTEGER NOT NULL DEFAULT 0);

CREATE TABLE auth_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  used_at INTEGER);
CREATE INDEX auth_recovery_codes_user ON auth_recovery_codes(user_id);

CREATE TABLE auth_passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER);
CREATE INDEX auth_passkeys_user ON auth_passkeys(user_id);

-- Short-lived server-side state: pending second step of a login, WebAuthn ceremonies, OIDC requests.
-- id = SHA-256 of the opaque ticket handed to the client.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  data TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE auth_security_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX auth_security_log_user ON auth_security_log(user_id, created_at);

CREATE TABLE workspace_security (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  require_2fa INTEGER NOT NULL DEFAULT 0,
  grace_until INTEGER,
  updated_by TEXT,
  updated_at INTEGER NOT NULL);

CREATE TABLE workspace_transfers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE UNIQUE INDEX workspace_transfers_ws ON workspace_transfers(workspace_id);
CREATE INDEX workspace_transfers_to ON workspace_transfers(to_user_id);

CREATE TABLE auth_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  PRIMARY KEY (issuer, subject));
CREATE INDEX auth_identities_user ON auth_identities(user_id);

CREATE TABLE auth_domains (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,
  verified_at INTEGER,
  auto_join INTEGER NOT NULL DEFAULT 0,
  join_role TEXT NOT NULL DEFAULT 'member' CHECK (join_role IN ('member','viewer')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  PRIMARY KEY (workspace_id, domain));
CREATE UNIQUE INDEX auth_domains_verified ON auth_domains(domain) WHERE verified_at IS NOT NULL;
`,
  },
  {
    // Automatic joins of a verified domain already applied (auth/oidc.ts): a person removed from the
    // workspace, or who left it, is never added back by the next SSO sign-in (QA-G9-04).
    id: 'sec-002-domain-joins',
    sql: /* sql */ `
CREATE TABLE auth_domain_joins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id));
`,
  },
];
