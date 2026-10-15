// PUBLIC INTERFACE of the database module (owned by the database team).
// The app shell imports ONLY from this file. Signatures below are the contract; the
// implementation lives in sibling files of this folder.
import type { Page } from '@oriel/shared';
import './database.css';
import { RowPropertiesRoot } from './row/RowProperties';
import { DatabaseRoot } from './view/DatabaseRoot';

export interface DatabaseViewProps {
  databaseId: string;
  /** Rendered inside a page's content (inline database block) rather than as a full page. */
  inline?: boolean;
  /** Force read-only (viewer role, public page, snapshot preview). */
  readOnly?: boolean;
  /** Use the public (no session) API endpoints. Implies readOnly. */
  publicMode?: boolean;
  /**
   * Linked database block: the block's own views/filters/sorts (GET /api/databases/:did?linkId=).
   * Rows and schema edits apply to the source database.
   */
  linkId?: string;
  /** I1: page whose content shows the block (« cette page » in relation filters and values). */
  hostPageId?: string;
}

/** Tabs of views + toolbar (filter/sort/search/properties/new) + the active view layout. */
export function DatabaseView(props: DatabaseViewProps) {
  return (
    <DatabaseRoot
      // Remount when switching databases so per-view state never leaks across databases.
      key={`${props.databaseId}:${props.linkId ?? ''}`}
      databaseId={props.databaseId}
      linkId={props.linkId}
      hostPageId={props.hostPageId}
      inline={props.inline}
      readOnly={props.readOnly || props.publicMode}
      publicMode={props.publicMode}
    />
  );
}

export interface RowPropertiesProps {
  /** The row page (page.parentType === 'database'). */
  page: Page;
  readOnly?: boolean;
  publicMode?: boolean;
}

/** Property list shown under the title of a database row page (name ⇢ editable value). */
export function RowProperties(props: RowPropertiesProps) {
  return (
    <RowPropertiesRoot
      key={props.page.id}
      page={props.page}
      readOnly={props.readOnly || props.publicMode}
      publicMode={props.publicMode}
    />
  );
}

// Extra exports (optional for the shell).
export { FORMULA_FUNCTIONS, runFormula } from './logic/formula';
export { formatDateValue, formatNumber } from './logic/format';

/** Public page of a form view (/share/:pageId/form/:viewId): anonymous answers, no session. */
export { PublicFormPage } from './view/PublicFormPage';
