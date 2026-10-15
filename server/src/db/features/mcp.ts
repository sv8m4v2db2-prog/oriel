// Feature migrations of the "mcp" module (personal API tokens). Append entries; never edit an applied one.
// Each id must be unique across all modules (prefix it with "mcp-").
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    id: 'mcp-001-api-tokens',
    sql: /* sql */ `
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read','write')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER);
CREATE INDEX api_tokens_user ON api_tokens(user_id, created_at);
`,
  },
  {
    // Revocation enforced by the database itself, whatever the code path:
    //  - every token of a user whose password changes (password change, reset link, admin reset);
    //  - tokens restricted to a workspace when their owner leaves it (or is removed from it).
    id: 'mcp-002-token-revocation-triggers',
    sql: /* sql */ `
CREATE TRIGGER api_tokens_revoke_on_password AFTER UPDATE OF password_hash ON users
WHEN NEW.password_hash IS NOT OLD.password_hash
BEGIN
  UPDATE api_tokens SET revoked_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE user_id = NEW.id AND revoked_at IS NULL;
END;
CREATE TRIGGER api_tokens_revoke_on_member_removed AFTER DELETE ON members
BEGIN
  UPDATE api_tokens SET revoked_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE user_id = OLD.user_id AND workspace_id = OLD.workspace_id AND revoked_at IS NULL;
END;
`,
  },
];
