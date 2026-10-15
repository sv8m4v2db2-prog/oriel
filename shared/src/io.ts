// Contract of the "io" feature module (types shared by server and web): page content API used by
// workspace import/export, and the manifest written into Oriel export archives.
import type { PageKind, PropertyDef, ViewConfig, ViewType, Visibility } from './types.js';

// ---------------------------------------------------------------------------
// Page content API
// ---------------------------------------------------------------------------

/** Maximum decoded size of a Yjs update sent to PUT /api/pages/:pid/content. */
export const PAGE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;

/** GET /api/pages/:pid/content (read access). */
export interface PageContentResponse {
  /** Base64 Yjs update encoding the full current document state (fresher than the last save). */
  update: string;
}

/**
 * - `replace`: the page's `blocknote` fragment is emptied, then filled with the blocks of the update
 *   (a `before-restore` snapshot of the previous content is kept when it was not empty).
 * - `append`: the blocks of the update are added after the existing ones.
 */
/** merge requires a full copy of the existing CRDT history, including its shared root. */
export type PageContentMode = 'replace' | 'append' | 'merge';

/** PUT /api/pages/:pid/content (edit access) → PutPageContentResponse. */
export interface PutPageContentRequest {
  /**
   * Base64 Yjs update of a standalone document (e.g. BlockNote `blocksToYDoc`). Only its
   * `blocknote` XML fragment is read; an update touching any other shared type is refused.
   */
  update: string;
  mode: PageContentMode;
}

export interface PutPageContentResponse {
  ok: true;
  /** Number of top-level blocks written. */
  blocks: number;
}

// ---------------------------------------------------------------------------
// Export archive manifest (`oriel.json` at the root of a workspace export zip)
// ---------------------------------------------------------------------------

export const EXPORT_MANIFEST_FILE = 'oriel.json';
export const EXPORT_MANIFEST_FORMAT = 'oriel-export';

export interface ExportManifestEntry {
  /** Path of the entry's file inside the archive (`.md` for pages and rows, `.csv` for databases). */
  path: string;
  /** Id in the exporting workspace (informational; imports always create new ids). */
  id: string;
  kind: PageKind;
  /** 'row' when the page is a database row. */
  role: 'page' | 'database' | 'row';
  title: string;
  icon: string | null;
  /** Top-level entries only. */
  visibility?: Visibility;
  /** Databases under a page: shown inline in the parent's content. */
  isInline?: boolean;
  /** Databases: full schema (property ids are re-created on import). */
  properties?: PropertyDef[];
  /** Databases: views (property ids refer to `properties`). */
  views?: Array<{ name: string; type: ViewType; config: ViewConfig }>;
}

export interface ExportManifest {
  format: typeof EXPORT_MANIFEST_FORMAT;
  version: 1;
  exportedAt: string;
  workspace: { name: string; icon: string | null };
  entries: ExportManifestEntry[];
}
