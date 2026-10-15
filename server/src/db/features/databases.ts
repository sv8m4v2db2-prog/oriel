// Feature migrations of the "databases" module. Append entries; never edit an applied one.
// Each id must be unique across all modules (prefix it with "databases-").
import type { FeatureMigration } from './types.js';

export const migrations: FeatureMigration[] = [
  {
    // Linked database blocks: views carrying a link id belong to that block (native views: NULL).
    id: 'databases-001-view-links',
    sql: /* sql */ `
      ALTER TABLE views ADD COLUMN link_id TEXT;
      CREATE INDEX views_link ON views(database_id, link_id);
    `,
  },
  {
    // Row templates: rows of a database flagged as templates (hidden from every view).
    id: 'databases-002-row-templates',
    sql: /* sql */ `
      CREATE TABLE database_templates (
        page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE INDEX database_templates_db ON database_templates(database_id);
    `,
  },
  {
    // Geocoding cache (place properties) and form submissions log (rate caps of published forms).
    id: 'databases-003-geocode-forms',
    sql: /* sql */ `
      CREATE TABLE databases_geocode_cache (
        query TEXT PRIMARY KEY,
        results TEXT NOT NULL,
        fetched_at INTEGER NOT NULL);
      CREATE TABLE database_form_submissions (
        id TEXT PRIMARY KEY,
        view_id TEXT NOT NULL,
        is_public INTEGER NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX database_form_submissions_view ON database_form_submissions(view_id, created_at);
    `,
  },
  {
    // I1 — manual order of the rows per view (linked views included): rows absent here fall back to
    // their page position. Recurring row templates: the schedule, and one line per occurrence handled
    // (primary key), so that an occurrence never creates two rows, even across a restart.
    id: 'databases-004-view-order-recurrence',
    sql: /* sql */ `
      CREATE TABLE database_view_row_order (
        view_id TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        position TEXT NOT NULL,
        PRIMARY KEY (view_id, page_id));
      CREATE INDEX database_view_row_order_page ON database_view_row_order(page_id);
      CREATE TABLE database_template_recurrences (
        template_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
        database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
        config TEXT NOT NULL,
        next_run TEXT,
        actor_id TEXT NOT NULL,
        last_run_at INTEGER,
        last_row_id TEXT,
        last_error TEXT,
        updated_at INTEGER NOT NULL);
      CREATE INDEX database_template_recurrences_next ON database_template_recurrences(next_run);
      CREATE TABLE database_template_runs (
        template_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        occurrence TEXT NOT NULL,
        row_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (template_id, occurrence));
    `,
  },
];
