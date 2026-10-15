// HTTP API contract. Every route is under /api. JSON in, JSON out, session cookie auth.
// Errors: non-2xx status with body ApiErrorBody.
import type {
  Crumb,
  DatabaseSchema,
  Member,
  Page,
  PageFormat,
  Cover,
  FormConfig,
  ParentType,
  PageKind,
  PropertyDef,
  PropertyValue,
  PublicUser,
  SearchResult,
  SignupMode,
  SnapshotMeta,
  TrashItem,
  TreeNode,
  UploadedFile,
  User,
  View,
  ViewConfig,
  ViewType,
  Visibility,
  Workspace,
  WorkspaceRole,
  WorkspaceSummary,
} from './types.js';
import type { TemplateRecurrence, TemplateRecurrenceInfo } from './recurrence.js';

export interface ApiErrorBody {
  error: {
    /** Stable machine code, e.g. 'unauthorized', 'forbidden', 'not_found', 'validation', 'conflict', 'rate_limited'. */
    code: string;
    /** Human readable (French) message. */
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Auth & account
// ---------------------------------------------------------------------------

/** GET /api/auth/config (public) */
export interface AuthConfigResponse {
  signupMode: SignupMode;
  /** false until the first account exists (then the UI shows the "create admin" flow). */
  hasUsers: boolean;
  version: string;
  /** Passwordless sign-in with a passkey is possible (PUBLIC_URL set, not the desktop local mode). */
  passkeys?: boolean;
  /** OIDC single sign-on configured by the server administrator. */
  sso?: { label: string } | null;
}

/** POST /api/auth/signup */
export interface SignupRequest {
  email: string;
  name: string;
  password: string;
  /** Required when signups are closed (except for the very first account). */
  inviteToken?: string;
}

/** POST /api/auth/login */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Returned by signup, login and GET /api/auth/me */
export interface SessionResponse {
  user: User;
  workspaces: WorkspaceSummary[];
}

/** PATCH /api/me */
export interface UpdateMeRequest {
  name?: string;
  avatarUrl?: string | null;
}

/** POST /api/me/password */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// ---------------------------------------------------------------------------
// Workspaces, members, invites
// ---------------------------------------------------------------------------

/** POST /api/workspaces  → WorkspaceSummary */
export interface CreateWorkspaceRequest {
  name: string;
  icon?: string | null;
}

/** PATCH /api/workspaces/:wid → WorkspaceSummary */
export interface UpdateWorkspaceRequest {
  name?: string;
  icon?: string | null;
}

/** GET /api/workspaces/:wid/members → Member[] */
export type MembersResponse = Member[];

/** PATCH /api/workspaces/:wid/members/:uid → Member */
export interface UpdateMemberRequest {
  role: WorkspaceRole;
}

/** POST /api/workspaces/:wid/invites → Invite */
export interface CreateInviteRequest {
  role: Exclude<WorkspaceRole, 'owner'>;
  /** Default 7. */
  expiresInDays?: number;
}

/** GET /api/invites/:token (public) */
export interface InviteInfoResponse {
  valid: boolean;
  workspace: Pick<Workspace, 'id' | 'name' | 'icon'> | null;
  role: WorkspaceRole | null;
  invitedBy: Pick<PublicUser, 'name'> | null;
}

/** POST /api/invites/:token/accept → { workspace } */
export interface AcceptInviteResponse {
  workspace: WorkspaceSummary;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** GET /api/workspaces/:wid/tree — every visible, non-trashed page/database that is not a database row. */
export interface TreeResponse {
  nodes: TreeNode[];
}

/**
 * Position hint shared by create/move endpoints.
 * - `after: id`  → insert right after that sibling
 * - `after: null` → insert first
 * - omitted      → insert last
 */
export interface PositionHint {
  after?: string | null;
}

/** POST /api/workspaces/:wid/pages → Page */
export interface CreatePageRequest extends PositionHint {
  /** Optional client-generated UUID (lets the client insert a link block before the response). */
  id?: string;
  parentType: ParentType;
  /** For parentType 'workspace' this is the workspace id. */
  parentId: string;
  kind?: PageKind; // default 'page'
  title?: string;
  icon?: string | null;
  cover?: Cover | null;
  /** Only meaningful for top-level pages; nested pages inherit their parent's visibility. Default 'workspace'. */
  visibility?: Visibility;
  /** Initial property values for database rows. */
  properties?: Record<string, PropertyValue>;
  /** kind 'database' under a page: render inline inside the parent. */
  isInline?: boolean;
  /** kind 'database': skip the 3 placeholder rows. */
  emptyDatabase?: boolean;
  /** Canvas module (H1): create a canvas page (kind 'page', not a database row). */
  layout?: 'canvas';
}

/** GET /api/pages/:pid */
export interface PageDetailResponse {
  page: Page;
  /** Root first, excluding the page itself. */
  ancestors: Crumb[];
  role: WorkspaceRole;
  canEdit: boolean;
  isFavorite: boolean;
  /** When the page is a database row: the parent database schema. */
  parentDatabase: DatabaseSchema | null;
  /** True when this page or an ancestor is published. */
  publiclyVisible: boolean;
}

/** PATCH /api/pages/:pid → Page.  `properties` is merged key by key (null clears a value). */
export interface UpdatePageRequest {
  title?: string;
  icon?: string | null;
  cover?: Cover | null;
  format?: Partial<PageFormat>;
  properties?: Record<string, PropertyValue>;
}

/** POST /api/pages/:pid/move → Page */
export interface MovePageRequest extends PositionHint {
  parentType: ParentType;
  parentId: string;
  /** Required when moving to the workspace root: which sidebar section. */
  visibility?: Visibility;
  /** Navigation module: explicit consent to a move that widens access across teamspaces (else 409). */
  confirmAccess?: boolean;
}

/** POST /api/pages/:pid/publish → Page */
export interface PublishRequest {
  isPublic: boolean;
}

/** PUT /api/pages/:pid/favorite → { favorites: string[] } */
export interface FavoriteRequest extends PositionHint {
  favorite: boolean;
}

/** GET /api/workspaces/:wid/favorites → favorite pages, in the user's order */
export interface FavoritesResponse {
  favorites: TreeNode[];
}

/** GET /api/workspaces/:wid/recent → recently visited pages (by me), newest first */
export interface RecentResponse {
  pages: Array<TreeNode & { visitedAt: number; path: Crumb[] }>;
}

/** GET /api/workspaces/:wid/trash */
export interface TrashResponse {
  items: TrashItem[];
}

/** GET /api/workspaces/:wid/search?q=&limit= */
export interface SearchResponse {
  results: SearchResult[];
}

/** GET /api/pages/:pid/backlinks */
export interface BacklinksResponse {
  pages: Crumb[];
}

/** GET /api/pages/:pid/snapshots */
export interface SnapshotsResponse {
  snapshots: SnapshotMeta[];
}

/** GET /api/pages/:pid/snapshots/:sid */
export interface SnapshotResponse {
  snapshot: SnapshotMeta;
  /** Base64 Yjs update encoding the full document state. */
  update: string;
}

// --- Version history: comparison, partial restore, recovery (G6, SPEC « Historique des versions »)

/** One block to restore from a version: `reinsert` a deleted block, `revert` a block to its old text. */
export interface RestoreBlockItem {
  blockId: string;
  action: 'reinsert' | 'revert';
}

/** POST /api/pages/:pid/snapshots/:sid/restore-blocks */
export interface RestoreBlocksRequest {
  items: RestoreBlockItem[];
}

export interface RestoreBlocksResponse {
  ok: true;
  /** Ids of the blocks restored, in request order. */
  restored: string[];
  /** `exists`: reinsert of a block still present; `missing`: revert of a block no longer present;
   *  `not-in-version`: the version has no such block. */
  skipped: Array<{ blockId: string; reason: 'exists' | 'missing' | 'not-in-version' }>;
}

/** POST /api/pages/:pid/snapshots/:sid/restore */
export interface RestoreSnapshotResponse {
  ok: true;
}

/** A block present in a recent version and absent from the current content. */
export interface DeletedBlock {
  blockId: string;
  /** Block type (`paragraph`, `heading`…), as stored in the document. */
  type: string;
  /** Plain-text excerpt (at most 200 characters). */
  text: string;
  /** Nested blocks deleted with it. */
  childCount: number;
  /** Last version that contains the block. */
  snapshotId: string;
  snapshotAt: number;
  /** First later version without the block; null when it was deleted after the latest version. */
  deletedBefore: number | null;
  /** People who edited the page between the two (when known). */
  deletedBy: PublicUser[];
}

/** GET /api/pages/:pid/history/deleted */
export interface DeletedBlocksResponse {
  blocks: DeletedBlock[];
  /** Versions examined (the most recent ones within the recovery window). */
  scanned: number;
  truncated: boolean;
}

/** GET /api/pages/:pid/history/properties?at= — title and values of a database row at a date. */
export interface HistoryPropertiesResponse {
  /** False for a page that is not a database row. */
  row: boolean;
  /** False when no recorded state precedes `at` (history recording started later). */
  known: boolean;
  title: string;
  /** Visible properties only (property-level rights). */
  values: Record<string, PropertyValue>;
  /** When and by whom this state was recorded. */
  changedAt: number | null;
  changedBy: PublicUser | null;
}

// ---------------------------------------------------------------------------
// Databases & views
// ---------------------------------------------------------------------------

/**
 * GET /api/databases/:did[?linkId=]
 * With `linkId` (linked database block), `views` are that block's own views (a default table view
 * is created on first open); without it, the database's native views.
 */
export interface DatabaseResponse {
  page: Page;
  schema: DatabaseSchema;
  /** Ordered by position. */
  views: View[];
  canEdit: boolean;
}

/** GET /api/databases/:did/rows — every non-trashed row, ordered by position. */
export interface RowsResponse {
  rows: Page[];
  /** Users referenced by person / created_by / last_edited_by values (for display). */
  users: PublicUser[];
}

/**
 * POST /api/databases/:did/rows/batch → BatchUpdateRowsResponse (table grid: paste, fill down, clear).
 * At most 500 rows per call; one transaction; each row as with PATCH /api/pages/:pid.
 */
export interface BatchUpdateRowsRequest {
  updates: Array<{ id: string; title?: string; properties?: Record<string, PropertyValue> }>;
  /**
   * QA-EDT-05: the rows are changed by a button block of this page. The database must then be
   * readable by everyone who can read that page (403 otherwise; invisible page → 404).
   */
  viaButtonOn?: string;
}

export interface BatchUpdateRowsResponse {
  updated: number;
}

/** POST /api/databases/:did/rows → Page */
export interface CreateRowRequest extends PositionHint {
  id?: string;
  title?: string;
  icon?: string | null;
  properties?: Record<string, PropertyValue>;
  /**
   * Create the row from a row template: its properties, content and sub-pages are duplicated
   * (`title` / `properties` given here override the template's).
   */
  templateId?: string;
  /** QA-EDT-05: the row is added by a button block of this page (see BatchUpdateRowsRequest). */
  viaButtonOn?: string;
}

/** Two-way relation option: the mirror property created in the target database. */
export interface TwoWayRelationRequest {
  /** Name of the mirror property (default: title of the source database). */
  name?: string;
  /**
   * Pair with this existing one-way relation of the target database (pointing back to the source)
   * instead of creating a mirror — e.g. both sides of an imported relation. Values are merged (union).
   */
  pairWith?: string;
}

/** POST /api/databases/:did/properties → DatabaseSchema */
export interface CreatePropertyRequest extends PositionHint {
  property: Omit<PropertyDef, 'id'> & { id?: string };
  /** relation only: also create a synced mirror property in the target database. */
  twoWay?: TwoWayRelationRequest;
}

/**
 * PATCH /api/databases/:did/properties/:propId → DatabaseSchema
 * Changing `type` converts stored row values on the server (best effort).
 * `options` replaces the whole option list (removed option ids are cleared from rows).
 * `twoWay`: relation only — an object makes the relation two-way (creates the mirror, filled from
 * the current values), null makes it one-way again (the mirror property is deleted).
 * `relation.syncedPropertyId` is managed by the server and ignored.
 */
export type UpdatePropertyRequest = Partial<Omit<PropertyDef, 'id'>> & { twoWay?: TwoWayRelationRequest | null };

/**
 * DELETE /api/databases/:did/properties/:propId?mirror=delete|keep → DatabaseSchema
 * For a two-way relation: `delete` also deletes the mirror property, `keep` (default) turns it into
 * a one-way relation.
 */
export type DeletePropertyMirrorMode = 'delete' | 'keep';

/** GET /api/databases/:did/templates — row templates (hidden from views), in position order. */
export interface TemplatesResponse extends RowsResponse {
  defaultTemplateId: string | null;
  /** Recurring templates (I1): one entry per template that creates rows on a schedule. */
  recurrences?: TemplateRecurrenceInfo[];
}

/**
 * POST /api/databases/:did/templates → Page: a new template, a copy of `fromTemplateId`, or (I1) a copy
 * of the row `fromRowId` with its sub-pages, the original row being put in the trash with `trashOriginal`.
 */
export interface CreateTemplateRequest {
  title?: string;
  fromTemplateId?: string;
  fromRowId?: string;
  trashOriginal?: boolean;
}

/** PUT /api/databases/:did/templates/default → TemplatesResponse */
export interface SetDefaultTemplateRequest {
  templateId: string | null;
}

/** PUT /api/databases/:did/templates/:tid/recurrence → TemplatesResponse (null stops the recurrence). */
export interface SetTemplateRecurrenceRequest {
  recurrence: TemplateRecurrence | null;
}

/**
 * POST /api/views/:vid/rows/move → MoveViewRowResponse (I1): places `rowId` right after `after` (null =
 * first) in the manual order of this view only; the page position and the other views are unchanged.
 */
export interface MoveViewRowRequest {
  rowId: string;
  after: string | null;
}

export interface MoveViewRowResponse {
  viewId: string;
  /** The view's whole manual order after the move (row id → fractional index). */
  rowOrder: Record<string, string>;
}

/**
 * POST /api/databases/:did/import → ImportRowsResponse
 * Values use the stored format of each property (select → option id…). With `updateByTitle`, a row
 * whose title matches an existing row (case-insensitive) updates it instead of creating a new one.
 */
export interface ImportRowsRequest {
  rows: Array<{ title?: string; properties?: Record<string, PropertyValue> }>;
  updateByTitle?: boolean;
}

export interface ImportRowsResponse {
  created: number;
  updated: number;
}

/**
 * GET /api/databases/:did/previews?ids=a,b (public: /api/public/databases/:did/previews) — feed view:
 * first lines of each row's content and its number of open comments (0 on public pages).
 */
export interface RowPreviewsResponse {
  previews: Record<string, { text: string; comments: number }>;
}

/** GET /api/workspaces/:wid/geocode?q= — address search (`enabled: false` when no geocoder is configured). */
export interface GeocodeResponse {
  enabled: boolean;
  results: Array<{ address: string; lat: number; lng: number }>;
}

/**
 * GET /api/public/map-config — tile layer of the map views, chosen by the administrator
 * (MAP_TILE_URL, MAP_TILE_ATTRIBUTION, MAP_TILE_MAX_ZOOM). `tiles: null`: maps without background
 * (MAP_TILE_URL=off). `attribution` is plain text.
 */
export interface MapConfigResponse {
  tiles: { url: string; attribution: string; maxZoom: number } | null;
}

/**
 * POST /api/forms/:vid/submit (members) and POST /api/public/forms/:vid/submit (forms open to people
 * without an account, `form.isPublic`; the database does not need to be published) → { ok: true }.
 * `answers` is keyed by question id. `website` is a honeypot field that must stay empty.
 */
export interface SubmitFormRequest {
  answers: Record<string, unknown>;
  website?: string;
}

/**
 * GET /api/public/forms/:vid (anonymous) → definition of a form open to people without an account, its
 * database being published or not. Only what the public page shows: never rows, nor properties other
 * than those of the questions an anonymous visitor may answer (PUBLIC_FORM_QUESTION_TYPES).
 * 404 when the view is not a public form, or its database (or an ancestor) is trashed or a template.
 */
export interface PublicFormResponse {
  view: { id: string; name: string };
  /** Questions limited to the public question types; `isPublic` is always true. */
  form: FormConfig;
  /** Properties of those questions: id, name, type and choices (select, multi_select, status). */
  properties: Array<Pick<PropertyDef, 'id' | 'name' | 'type' | 'options'>>;
}

/** A form of a database open to people without an account (QA-VIEW-05). */
export interface PublicFormSummary {
  id: string;
  name: string;
  /** Linked database block the view belongs to (null: view of the database itself). */
  linkId: string | null;
  acceptResponses: boolean;
}

/**
 * GET /api/databases/:did/public-forms (members who can see the database) → every public form of the
 * database, linked block views included, so that a form whose block is gone can still be found and
 * closed (POST /api/views/:vid/close-public-form, edit access → View).
 */
export interface PublicFormsResponse {
  forms: PublicFormSummary[];
}

/** GET /api/databases/:did/relation-graph (D29): the database, the databases it relates to (both ways), links. */
export interface RelationGraphResponse {
  /** The requested database first; only databases the viewer can read. */
  databases: Array<{ id: string; title: string; icon: string | null }>;
  /** One link per relation property (a two-way pair is one link with both names). */
  links: Array<{
    /** Database holding `propertyName`. */
    fromId: string;
    toId: string;
    propertyId: string;
    propertyName: string;
    /** Two-way relation: name of the mirror property in `toId` (when visible), else null. */
    mirrorName: string | null;
    twoWay: boolean;
  }>;
}

/** POST /api/databases/:did/properties/:propId/move → DatabaseSchema */
export type MovePropertyRequest = PositionHint;

/** POST /api/databases/:did/views → View */
export interface CreateViewRequest extends PositionHint {
  /** Optional client-generated UUID (lets the client show the view before the response). */
  id?: string;
  /** View of a linked database block (see GET /api/databases/:did?linkId=). */
  linkId?: string;
  name: string;
  type: ViewType;
  config?: Partial<ViewConfig>;
}

/** PATCH /api/views/:vid → View.  `config` is shallow-merged into the stored config. */
export interface UpdateViewRequest {
  name?: string;
  type?: ViewType;
  config?: Partial<ViewConfig>;
}

/** POST /api/views/:vid/move → View */
export type MoveViewRequest = PositionHint;

// ---------------------------------------------------------------------------
// Public (no session) — page or ancestor must be published
// ---------------------------------------------------------------------------

/** GET /api/public/pages/:pid */
export interface PublicPageResponse {
  page: Page;
  /** Ancestors up to (and including) the published root only. */
  ancestors: Crumb[];
  /** Visible children (sub-pages and databases) for navigation. */
  children: TreeNode[];
  parentDatabase: DatabaseSchema | null;
}

/** GET /api/public/databases/:did → same shape as DatabaseResponse with canEdit=false. */
export type PublicDatabaseResponse = DatabaseResponse;
/** GET /api/public/databases/:did/rows */
export type PublicRowsResponse = RowsResponse;

// ---------------------------------------------------------------------------
// Instance administration
// ---------------------------------------------------------------------------

/** GET/PATCH /api/admin/settings */
export interface AdminSettings {
  signupMode: SignupMode;
}

/** GET /api/admin/users */
export interface AdminUsersResponse {
  users: Array<User & { workspaceCount: number }>;
}

/** POST /api/workspaces/:wid/files (multipart, field "file") → UploadedFile */
export type UploadResponse = UploadedFile;

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  version: string;
}
