// Feature migrations of the version history module (G6, SPEC « Historique des versions »).
// Append entries; never edit an applied one. Ids are prefixed with "history-".
import type { FeatureMigration } from './types.js';

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export const migrations: FeatureMigration[] = [
  {
    id: 'history-001-restore-and-properties',
    sql: `
ALTER TABLE snapshots ADD COLUMN restored_from TEXT;

-- Title and values of database rows over time. One row per change, grouped per person over
-- 10 minutes; the first change of a row also records the state it started from (origin = 1).
CREATE TABLE history_props (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  properties TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  user_id TEXT,
  origin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX history_props_page ON history_props(page_id, created_at);

CREATE TRIGGER history_props_on_update AFTER UPDATE OF title, properties ON pages
WHEN NEW.parent_type = 'database' AND (OLD.title IS NOT NEW.title OR OLD.properties IS NOT NEW.properties)
BEGIN
  INSERT INTO history_props (page_id, title, properties, created_at, user_id, origin)
    SELECT OLD.id, OLD.title, OLD.properties, OLD.updated_at, OLD.updated_by, 1
    WHERE NOT EXISTS (SELECT 1 FROM history_props WHERE page_id = OLD.id);
  UPDATE history_props SET title = NEW.title, properties = NEW.properties, created_at = ${NOW_MS}
    WHERE id = (SELECT id FROM history_props WHERE page_id = NEW.id ORDER BY id DESC LIMIT 1)
      AND origin = 0 AND user_id IS NEW.updated_by AND created_at >= ${NOW_MS} - 600000;
  INSERT INTO history_props (page_id, title, properties, created_at, user_id)
    SELECT NEW.id, NEW.title, NEW.properties, ${NOW_MS}, NEW.updated_by
    WHERE NOT EXISTS (
      SELECT 1 FROM history_props WHERE page_id = NEW.id AND origin = 0 AND title IS NEW.title
        AND properties IS NEW.properties AND id = (SELECT MAX(id) FROM history_props WHERE page_id = NEW.id)
    );
END;
`,
  },
];
