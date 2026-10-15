// Contract of the "editor" feature module (types shared by server and web).
import type { ParentType, Visibility } from './types.js';

// ---------------------------------------------------------------------------
// Link previews (bookmark block)
// ---------------------------------------------------------------------------

/** GET /api/link-preview?url= → LinkPreview (authenticated workspace members only). */
export interface LinkPreview {
  /** Final URL after redirects (http/https). */
  url: string;
  title: string;
  description: string;
  /** https image URL (Open Graph / Twitter card), or '' */
  image: string;
  /** https favicon URL, or '' */
  favicon: string;
  /** Site name (og:site_name) or host name. */
  siteName: string;
}

// ---------------------------------------------------------------------------
// Embeds
// ---------------------------------------------------------------------------

export type EmbedProvider =
  | 'youtube'
  | 'vimeo'
  | 'loom'
  | 'figma'
  | 'google-maps'
  | 'google-docs'
  | 'google-sheets'
  | 'google-slides'
  | 'google-drive'
  | 'spotify'
  | 'frameio'
  | 'generic';

/**
 * Origins that the SPA may frame (CSP `frame-src`), one per supported provider.
 * Keep in sync with `embedSource()` in web/src/editor/embeds.ts.
 */
export const EMBED_FRAME_ORIGINS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://player.vimeo.com',
  'https://www.loom.com',
  'https://www.figma.com',
  'https://embed.figma.com',
  'https://www.google.com',
  'https://maps.google.com',
  'https://docs.google.com',
  'https://drive.google.com',
  'https://open.spotify.com',
];

/** Block type names of the editor module (not page references: never extracted as links). */
export const EDITOR_BLOCK_TYPES = {
  /** props: { url, provider, height } */
  embed: 'embed',
  /** props: { url, title, description, image, favicon } */
  bookmark: 'bookmark',
  /** props: { url, name, height } — uploaded PDF shown in a viewer */
  pdf: 'pdf',
  /** props: { tex } — display equation (KaTeX) */
  equation: 'equation',
  /** Inline content. props: { tex } — inline equation */
  inlineEquation: 'inlineEquation',
  /** props: { label, icon, actions (JSON ButtonAction[]) } */
  button: 'button',
  /** Ancestors of the page, live. No props. */
  breadcrumb: 'breadcrumb',
  /** Tabs container: its children are `tab` blocks (one per tab). */
  tabs: 'tabs',
  /** One tab of a `tabs` block: props { title }; its children are the tab's content. */
  tab: 'tab',
  /** props: { syncedId } — content lives in the Yjs document `synced:<syncedId>` */
  syncedBlock: 'syncedBlock',
  /** props: { html } — user HTML/CSS/JS rendered in a sandboxed frame (opaque origin) */
  html: 'html',
  /** props: { strokes (JSON, see DRAWING_* limits) } — freehand sketch stored as bounded SVG strokes */
  drawing: 'drawing',
  /** Inline content. props: { note } — footnote call; numbered by document order (see FOOTNOTE_MAX_LENGTH) */
  footnote: 'footnote',
} as const;

// ---------------------------------------------------------------------------
// Drawing block, code block renders and image props (wave G5)
// ---------------------------------------------------------------------------

/**
 * `drawing` block: props.strokes is a JSON array of `{ c: '#rrggbb', w: width, p: [x0, y0, x1, y1, …] }`
 * in a fixed logical canvas (DRAWING_WIDTH × DRAWING_HEIGHT). Bounds are enforced when reading AND writing.
 */
export const DRAWING_WIDTH = 1000;
export const DRAWING_HEIGHT = 600;
export const DRAWING_MAX_STROKES = 400;
export const DRAWING_MAX_POINTS = 2000;
/** Largest serialized `strokes` value (UTF-16 units). */
export const DRAWING_MAX_LENGTH = 100 * 1024;
export const DRAWING_MAX_STROKE_WIDTH = 24;

/** Code block languages shown as a diagram / score / typeset document; `view` prop of those blocks. */
export const CODE_RENDER_LANGUAGES = ['mermaid', 'abc', 'typst'] as const;
export const CODE_VIEWS = ['code', 'preview', 'both'] as const;
export type CodeView = (typeof CODE_VIEWS)[number];
/** Longest source (characters) of a Mermaid / ABC / Typst block that is rendered. */
export const CODE_RENDER_MAX_LENGTH = 20_000;

/** Typst preview bounds (H5): compilation time (ms) and SVG output size (UTF-16 units). */
export const TYPST_TIMEOUT_MS = 8000;
export const TYPST_MAX_SVG_LENGTH = 3_000_000;

// ---------------------------------------------------------------------------
// Footnotes and block metadata (H5)
// ---------------------------------------------------------------------------

/** Longest footnote text (characters), bounded when read AND written. */
export const FOOTNOTE_MAX_LENGTH = 1000;
/** Most footnotes shown in the list at the bottom of a page. */
export const FOOTNOTE_MAX_LISTED = 500;

/** Most rows of block metadata kept for one page, and most blocks followed per save window. */
export const BLOCK_META_MAX_PER_PAGE = 20_000;
export const BLOCK_META_MAX_PER_WINDOW = 2_000;
/** Block ids accepted by the metadata API (BlockNote ids are UUIDs; imports may use other short ids). */
export const BLOCK_ID_PATTERN = /^[\w.:-]{1,128}$/;

/** A person in block metadata (a member who can see the page). */
export interface BlockMetaUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * GET /api/pages/:pid/blocks/:bid/meta → BlockMeta (authenticated readers of the page only; 404
 * otherwise). Kept server-side outside the Yjs document. A null author/date means "unknown": the
 * block predates the tracking (or was imported) and has not been modified since.
 */
export interface BlockMeta {
  blockId: string;
  createdBy: BlockMetaUser | null;
  createdAt: number | null;
  modifiedBy: BlockMetaUser | null;
  modifiedAt: number | null;
}

/**
 * Native `image` block props added by Oriel: `crop` = "x,y,w,h" fractions (0–1) of the original
 * image ('' = whole image, the original file is never modified); `link` = http(s)/mailto/tel address.
 */
export const IMAGE_CROP_MIN_SIZE = 0.05;

/** Largest HTML block source (bytes of UTF-16 text, checked client-side). */
export const HTML_BLOCK_MAX_LENGTH = 200 * 1024;

/** Static bootstrap page of HTML blocks (GET, no input, its own CSP with `sandbox allow-scripts`). */
export const HTML_FRAME_PATH = '/api/editor/html-frame';

/** Tallest HTML frame (px) a `resize` message may ask for. */
export const HTML_FRAME_MAX_HEIGHT = 4000;

/**
 * Messages between an HTML block and its frame (opaque origin, so `targetOrigin` is '*' and the
 * parent checks `event.source`). Frame → parent: `ready` (bootstrap loaded), `resize`. Parent →
 * frame: `render`, sent once.
 */
export type HtmlFrameMessage = { type: 'ready' } | { type: 'resize'; height: number } | { type: 'render'; html: string };

// ---------------------------------------------------------------------------
// Button block
// ---------------------------------------------------------------------------

/** Values preset by button actions, by property id (title: key "title"). Text form, converted per type. */
export type ButtonPropertyValues = Record<string, string>;

export type ButtonAction =
  /** Inserts copies of recorded blocks (BlockNote JSON, ids stripped) after the button. */
  | { type: 'insert'; blocks: unknown[] }
  /** Adds a row to a database. */
  | { type: 'addRow'; databaseId: string; values: ButtonPropertyValues }
  /** Updates the rows of a database whose property equals a value (empty filter = every row). */
  | { type: 'editRows'; databaseId: string; filter: { propertyId: string; value: string } | null; values: ButtonPropertyValues }
  /** Opens a page of the workspace or a web address. */
  | { type: 'open'; pageId?: string; url?: string }
  /** Asks for confirmation; the next actions run only if accepted. */
  | { type: 'confirm'; message: string };

/** Most actions of one button, and most blocks one `insert` action records. */
export const BUTTON_MAX_ACTIONS = 20;
export const BUTTON_MAX_INSERT_BLOCKS = 50;

// ---------------------------------------------------------------------------
// Synced blocks
// ---------------------------------------------------------------------------

/** Synced block ids are generated by the server (UUID v4, lower case) and checked strictly. */
export const SYNCED_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isSyncedId = (value: unknown): value is string => typeof value === 'string' && SYNCED_ID_PATTERN.test(value);

/** Collaborative document of a synced block. */
export const syncedDocumentName = (syncedId: string) => `synced:${syncedId}`;
/** Synced block id of a collaborative document name, or null (strict). */
export const parseSyncedDocumentName = (name: string): string | null =>
  typeof name === 'string' && name.startsWith('synced:') && isSyncedId(name.slice(7)) ? name.slice(7) : null;

/**
 * POST /api/pages/:pid/synced-blocks → SyncedBlockInfo (the page becomes the owner).
 * GET /api/pages/:pid/synced-blocks/:sid → SyncedBlockInfo, for a page `pid` displaying it (same
 * workspace, the caller can see the owner page; 404 otherwise).
 * GET /api/pages/:pid/synced-blocks/:sid/content → PageContentResponse (export).
 * GET /api/public/pages/:pid/synced-blocks/:sid → SyncedBlockInfo for a published page `pid` (no
 * session): same workspace, owner page published too; `pages` is empty and `canEdit` false.
 */
export interface SyncedBlockInfo {
  id: string;
  /** Page where the synced block was created (its content follows this page's access rules). */
  ownerPageId: string;
  ownerTitle: string;
  ownerIcon: string | null;
  canEdit: boolean;
  /** Pages (visible to the caller) whose content shows this synced block, the owner included. */
  pages: Array<{ id: string; title: string; icon: string | null }>;
}

/** Anchor used by block links: /w/:wid/p/:pid#bloc-<blockId> */
export const BLOCK_ANCHOR_PREFIX = 'bloc-';

// ---------------------------------------------------------------------------
// Page templates
// ---------------------------------------------------------------------------

/** PUT /api/pages/:pid/template → Page */
export interface SetTemplateRequest {
  isTemplate: boolean;
}

/** POST /api/pages/:pid/instantiate → Page (deep copy of the template, titled like the template). */
export interface InstantiateTemplateRequest {
  parentType: Exclude<ParentType, 'database'>;
  /** Workspace id for parentType 'workspace'. */
  parentId: string;
  /** Sidebar section when parentType is 'workspace'. Default 'workspace'. */
  visibility?: Visibility;
  after?: string | null;
}

/** Seed content flags (PageFormat.seed): filled once client-side then cleared. */
export type PageSeed = 'welcome';

export type PageFont = 'default' | 'serif' | 'mono';
