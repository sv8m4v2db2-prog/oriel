// Feature migrations of default date reminders on database date properties (G1 / D26).
// Append entries; never edit an applied one. Ids are prefixed with "datereminders-".
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    id: 'datereminders-001-property-reminders',
    sql: `
-- One reminder per (row, date property, person): the one given by the property's default
-- reminder setting when that person typed the date. Fired by the collab jobs like mention reminders.
CREATE TABLE collab_property_reminders (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  remind_date TEXT NOT NULL,
  remind_minutes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  PRIMARY KEY (page_id, property_id, user_id)
);
CREATE INDEX collab_property_reminders_due ON collab_property_reminders(fired_at, remind_date);
`,
  },
];
