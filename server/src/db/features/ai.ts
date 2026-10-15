// Feature migrations of the "ai" module. Append entries; never edit an applied one.
// Each id must be unique across all modules (prefix it with "ai-").
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    id: 'ai-001-brief',
    sql: /* sql */ `
CREATE TABLE ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT 'claude-opus-5-5',
  source_database_ids TEXT NOT NULL DEFAULT '[]',
  schedule_time TEXT NOT NULL DEFAULT '07:30',
  schedule_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  monthly_budget_usd REAL NOT NULL DEFAULT 15,
  updated_at INTEGER NOT NULL,
  updated_by TEXT);
CREATE TABLE ai_briefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brief_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','skipped')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  model TEXT NOT NULL,
  content TEXT,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_by TEXT);
CREATE INDEX ai_briefs_ws ON ai_briefs(workspace_id, started_at);
CREATE INDEX ai_briefs_ws_date ON ai_briefs(workspace_id, brief_date, trigger);
CREATE INDEX ai_briefs_status ON ai_briefs(status);
`,
  },
  {
    // Instance-wide monthly cap (QA-AGT-02): a running brief holds its maximum cost against the cap
    // until it finishes; the instance month is the UTC month of started_at.
    id: 'ai-002-instance-cap',
    sql: /* sql */ `
ALTER TABLE ai_briefs ADD COLUMN max_cost_usd REAL NOT NULL DEFAULT 0;
CREATE INDEX ai_briefs_started ON ai_briefs(started_at);
`,
  },
];
