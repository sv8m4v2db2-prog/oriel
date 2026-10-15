// Core domain types shared by server, web client and desktop shell.
// All timestamps are epoch milliseconds. All ids are opaque strings (UUID v4 unless noted).

// ---------------------------------------------------------------------------
// Users, sessions, workspaces
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** Instance administrator (first account, or promoted). */
  isAdmin: boolean;
  createdAt: number;
}

/** What other members can see about a user. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  version: number;
}

export interface WorkspaceSummary extends Workspace {
  role: WorkspaceRole;
}

export interface Member {
  user: PublicUser;
  role: WorkspaceRole;
  joinedAt: number;
}

export interface Invite {
  token: string;
  workspaceId: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  uses: number;
  /** Absolute URL to share (built from PUBLIC_URL when configured, else relative path). */
  url: string;
}

export type SignupMode = 'first-user' | 'invite' | 'open';

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Where a page lives. For 'workspace', parentId === workspaceId. */
export type ParentType = 'workspace' | 'page' | 'database';
export type PageKind = 'page' | 'database';
/**
 * 'teamspace' (navigation module): page of a closed or private teamspace, readable by the members of
 * that teamspace only. Derived from the teamspace's access mode; never chosen directly by a client.
 */
export type Visibility = 'workspace' | 'private' | 'teamspace';

/** Teamspace access mode (navigation module). */
export type TeamspaceAccess = 'open' | 'closed' | 'private';

export type Cover =
  | { type: 'image'; url: string }
  /** `value` is a key of COVER_GRADIENTS. */
  | { type: 'gradient'; value: string }
  /** `value` is a key of COVER_COLORS. */
  | { type: 'color'; value: string };

export interface PageFormat {
  /** Canvas module (H1): `'canvas'` = whiteboard page (content: Y.Map `canvas`). Set at creation, immutable. */
  layout?: 'canvas';
  /** Navigation group for a shared workspace root. Uses the workspace's existing access rules. */
  teamspaceRoot?: boolean;
  /** Navigation shortcut for a directly shared page, without changing its parent or permissions. */
  sharedShortcut?: boolean;
  fullWidth?: boolean;
  smallText?: boolean;
  /** Vertical focal point of the cover image, 0–100 (percent). Default 50. */
  coverPosition?: number;
  /** Typeface of the page content (editor module). Default 'default'. */
  font?: 'default' | 'serif' | 'mono';
  /** Content is read-only for everyone until an editor unlocks it (editor module). */
  locked?: boolean;
  /** Seed content to generate client-side once, then cleared (editor module). */
  seed?: 'welcome';
  /** Page customization (reading module, SPEC §13.5): hide the "Mentionnée dans" backlinks. */
  hideBacklinks?: boolean;
  /** Hide the page-level discussion at the top of the content (comments on a passage stay). */
  hideComments?: boolean;
  /** Hide the properties header of a database row. */
  hideProperties?: boolean;
  /** Floating table of contents: absent = automatic (3 headings or more), true = always, false = never. */
  toc?: boolean;
}

export interface Page {
  id: string;
  workspaceId: string;
  parentType: ParentType;
  parentId: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  cover: Cover | null;
  /** Fractional index among siblings (same parentType + parentId). */
  position: string;
  visibility: Visibility;
  /** Creator; for private pages, the only user who can see them. */
  ownerId: string;
  /** Property values when the page is a database row (parentType === 'database'). Keyed by property id. */
  properties: Record<string, PropertyValue>;
  format: PageFormat;
  /** For kind 'database' whose parent is a page: displayed inline in the parent's content. */
  isInline: boolean;
  /** Published to the web (applies to descendants too). */
  isPublic: boolean;
  trashedAt: number | null;
  trashedBy: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  version: number;
  /** Navigation module: viewer's last visit, on database rows lists only (property 'last_visited'). */
  lastVisitedAt?: number | null;
}

/** Lightweight node used by the sidebar tree (database rows are excluded from the tree). */
export interface TreeNode {
  id: string;
  parentType: ParentType;
  parentId: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  position: string;
  visibility: Visibility;
  isInline: boolean;
  /** Page template (editor module): listed under "Modèles", hidden from the regular tree. Absent = false. */
  isTemplate?: boolean;
  /** Shared root used to group pages in an espace d'équipe. */
  isTeamspace?: boolean;
  isSharedShortcut?: boolean;
  /** Teamspace root (navigation module): access mode, and whether the viewer is a member. */
  teamspaceAccess?: TeamspaceAccess;
  teamspaceMember?: boolean;
}

export interface Crumb {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'person'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'relation'
  | 'formula'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'
  | 'unique_id'
  | 'rollup'
  | 'place'
  /** Navigation module: date of the current user's last visit of the row (computed, per viewer). */
  | 'last_visited'
  /** Verification of a row by a person, with an optional expiry (D21). */
  | 'verification';

export type Color =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red';

export type StatusGroup = 'todo' | 'in_progress' | 'done';

export interface SelectOption {
  id: string;
  name: string;
  color: Color;
  /** Only for `status` properties. */
  group?: StatusGroup;
}

export type NumberFormat =
  | 'number'
  | 'number_with_commas'
  | 'percent'
  | 'euro'
  | 'dollar'
  // Other currencies (ISO 4217 code, lower case), formatted with Intl.NumberFormat in fr-FR.
  | 'gbp'
  | 'chf'
  | 'cad'
  | 'jpy'
  | 'aud'
  | 'cny'
  | 'sek'
  | 'nok'
  | 'dkk'
  | 'pln'
  | 'czk'
  | 'brl'
  | 'mxn'
  | 'inr'
  | 'krw';

/** How a number cell is drawn: the formatted figure, a progress bar or a progress ring. */
export type NumberDisplay = 'number' | 'bar' | 'ring';

/** Default reminder applied to every new date typed in a date property (G1 / D26). */
export type DateReminderMode = 'none' | 'same_day' | 'day_before' | 'two_days_before' | 'week_before';

export interface DateReminderConfig {
  mode: DateReminderMode;
  /** Wall-clock time (Europe/Paris, like every reminder), 'HH:MM'. Default 09:00. */
  time?: string;
}

export interface PropertyDef {
  /** Short random id (4–8 chars [a-z0-9]); the title property always has id 'title'. */
  id: string;
  name: string;
  type: PropertyType;
  /** select / multi_select / status */
  options?: SelectOption[];
  /** number */
  numberFormat?: NumberFormat;
  /** number: fixed number of decimals, 0 to 10 (default: as many as needed, up to 10). */
  numberPrecision?: number;
  /** number: figure (default), progress bar or progress ring. */
  numberDisplay?: NumberDisplay;
  /** number, bar / ring: value that fills the bar (default 100). */
  numberMax?: number;
  /** number, bar / ring: colour of the progress. */
  numberColor?: Color;
  /** date: reminder given to every new date typed in the column. */
  dateReminder?: DateReminderConfig;
  /** formula: expression source */
  formula?: string;
  /** relation: target database id (may be the same database) */
  relation?: RelationConfig;
  /** unique_id: optional prefix, e.g. "TASK" renders "TASK-12" */
  uniqueIdPrefix?: string;
  /** rollup: aggregation of a property of the related pages */
  rollup?: RollupConfig;
  /**
   * Per-property permissions (D30), on top of the access to the database. Set by workspace
   * owners/admins only (PUT /api/databases/:did/properties/:propId/access); absent = no restriction.
   */
  access?: PropertyAccess;
  /**
   * Set by the server in responses only (never stored): the viewer may edit the database but not this
   * property (values and structure), because of its permissions (D30).
   */
  readOnly?: boolean;
}

/** Roles that may be listed in a property permission (owners and admins are always allowed). */
export type PropertyAccessRole = 'member' | 'viewer';

export interface PropertyAccess {
  /** Roles that see the property; absent = everyone who can read the database. Owners/admins always do. */
  readRoles?: PropertyAccessRole[];
  /**
   * Roles that edit its values (and its structure); absent = everyone who can edit the database.
   * Owners/admins always do. Editing also requires seeing the property.
   */
  editRoles?: PropertyAccessRole[];
}

export interface RelationConfig {
  databaseId: string;
  /**
   * Two-way relation: id of the mirror relation property in the target database (set by the
   * server only). Writes on either side are mirrored on the other one.
   */
  syncedPropertyId?: string;
  /** « Limiter à une page »: at most one related page. */
  singlePage?: boolean;
  /** Where the row page shows this relation (D31): property list (default), a dedicated section, or nowhere. */
  rowPageDisplay?: 'property' | 'section' | 'hidden';
  /** Layout of the dedicated section: list of pages (default) or a small table. */
  sectionLayout?: 'list' | 'table';
}

/** Aggregations offered by rollup properties. */
export type RollupFunction =
  | 'show_original'
  | 'count_all'
  | 'count_values'
  | 'count_unique'
  | 'count_empty'
  | 'count_not_empty'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'earliest'
  | 'latest'
  | 'date_range'
  | 'checked'
  | 'unchecked'
  | 'percent_checked';

export interface RollupConfig {
  /** Relation property of the same database. */
  relationPropertyId: string;
  /** Property of the related database whose values are aggregated. */
  targetPropertyId: string;
  function: RollupFunction;
}

export interface DatabaseSchema {
  /** Same id as the database page. */
  id: string;
  workspaceId: string;
  /** Ordered list; exactly one has type 'title'. */
  properties: PropertyDef[];
  version: number;
}

export interface DateValue {
  /** 'YYYY-MM-DD' or full ISO 8601 datetime when includeTime. */
  start: string;
  end?: string | null;
  includeTime?: boolean;
}

export interface FileValue {
  name: string;
  url: string;
  size?: number;
  mime?: string;
}

/**
 * Stored property value, by property type:
 * - text, url, email, phone → string
 * - number → number
 * - select, status → option id (string)
 * - multi_select → option ids; person → user ids; relation → page ids (string[])
 * - date → DateValue
 * - checkbox → boolean
 * - files → FileValue[]
 * - unique_id → number (assigned by the server)
 * - title → never stored here (Page.title)
 * - formula, rollup, created_time, created_by, last_edited_time, last_edited_by → computed, never stored
 */
/** place: an address with its coordinates (geocoded once when chosen, never at display time). */
export interface PlaceValue {
  address: string;
  /** WGS 84 coordinates; absent when the address was typed without geocoding. */
  lat?: number;
  lng?: number;
}

/**
 * verification (D21): who verified the row and when (stamped by the server with the writer and the
 * current time), and until when ('YYYY-MM-DD', null = no expiry). Past the expiry: « À revérifier ».
 */
export interface VerificationValue {
  verifiedBy: string;
  verifiedAt: string;
  expiresAt: string | null;
}

export type PropertyValue = string | number | boolean | string[] | DateValue | FileValue[] | PlaceValue | VerificationValue | null;

export type ChartViewType = 'chart_bar' | 'chart_hbar' | 'chart_line' | 'chart_donut' | 'chart_number';

export type ViewType =
  | 'table'
  | 'board'
  | 'list'
  | 'gallery'
  | 'calendar'
  | 'timeline'
  | 'feed'
  | ChartViewType
  | 'dashboard'
  | 'map'
  | 'form';

export type FilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'within'
  | 'checked'
  | 'unchecked'
  /** multi-values (multi-select, person, relation): contains every wanted value. */
  | 'contains_all'
  /** date, value `RelativeDuration`: within the last / next N days, weeks or months. */
  | 'within_last'
  | 'within_next'
  /** date, value `RelativeDuration`: exactly N days, weeks or months ago / from now. */
  | 'exactly_ago'
  | 'exactly_ahead';

/** Value of the duration-relative date operators. */
export interface RelativeDuration {
  amount: number;
  unit: 'day' | 'week' | 'month';
}

/**
 * Which values of a multi-valued property must satisfy the condition (rollup « show original »):
 * at least one (any, default), all of them (every) or none.
 */
export type FilterQuantifier = 'any' | 'every' | 'none';

/** Relative ranges used by the 'within' date operator. */
export type RelativeRange =
  | 'today'
  | 'yesterday'
  | 'tomorrow'
  | 'past_week'
  | 'past_month'
  | 'past_year'
  | 'next_week'
  | 'next_month'
  | 'next_year';

export interface FilterRule {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  /** string | number | boolean | string[] | 'YYYY-MM-DD' | RelativeRange | RelativeDuration, depending on operator/type. */
  value?: unknown;
  /** Rollups « show original »: the condition is evaluated on each related value (see FilterQuantifier). */
  quantifier?: FilterQuantifier;
}

export interface FilterGroup {
  conjunction: 'and' | 'or';
  rules: FilterRule[];
  /** Nested groups, combined with the rules by the same conjunction (one level of nesting). */
  groups?: FilterGroup[];
}

export interface SortRule {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export type CalculationType =
  | 'none'
  | 'count_all'
  | 'count_values'
  | 'count_empty'
  | 'count_not_empty'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'earliest'
  | 'latest'
  | 'checked'
  | 'unchecked'
  | 'percent_checked';

export interface ViewConfig {
  filter: FilterGroup | null;
  sorts: SortRule[];
  /** Property id used for board columns / grouped sections. */
  groupBy: string | null;
  hiddenGroups: string[];
  collapsedGroups: string[];
  /** Display order of all property ids for this view (unknown ids ignored, missing ids appended). */
  propertyOrder: string[];
  /** Property ids hidden in this view (the title is never hidden). */
  hiddenProperties: string[];
  propertyWidths: Record<string, number>;
  calculations: Record<string, CalculationType>;
  wrap: boolean;
  cardCover: 'none' | 'cover';
  cardSize: 'small' | 'medium' | 'large';
  /** calendar + timeline start date property. */
  dateProperty: string | null;
  /** timeline end date property (optional; falls back to the date range end). */
  dateEndProperty: string | null;
  timelineScale: 'week' | 'month';
  /** timeline: relation property listing the pages that block a row (« Bloqué par »). */
  dependencyProperty?: string | null;
  /** calendar: month grid or week columns. */
  calendarMode?: 'month' | 'week';
  /** feed: lines of page content previewed in each post (0 = none). */
  feedPreviewLines?: number;
  /** chart views. */
  chart?: ChartConfig;
  /** dashboard: widgets, in display order. */
  widgets?: DashboardWidget[];
  /** map: `place` property locating the rows. */
  placeProperty?: string | null;
  /** form: questions and settings. */
  form?: FormConfig;
  /**
   * Row template used by the « Nouveau » button of this view (I1): absent or null = the database's default
   * template, 'blank' = an empty row, otherwise the id of one of the database's row templates.
   */
  defaultTemplateId?: string | null;
}

/** Y value of a chart: number of rows, or an aggregate of a number property. */
export type ChartAggregate = 'count' | 'sum' | 'average' | 'min' | 'max';
/** Grouping of date properties on a chart axis. */
export type ChartDateBucket = 'day' | 'week' | 'month' | 'year';
/** Order of the chart categories ('default': option / chronological order). */
export type ChartSort = 'default' | 'label_asc' | 'label_desc' | 'value_asc' | 'value_desc';

export interface ChartConfig {
  /** X axis (categories): property the rows are grouped by. Ignored by 'chart_number'. */
  xProperty: string | null;
  xBucket?: ChartDateBucket;
  aggregate: ChartAggregate;
  /** Number property aggregated (sum / average / min / max). */
  valueProperty: string | null;
  /** Second grouping: stacked bars / one line per value / … */
  seriesProperty?: string | null;
  seriesBucket?: ChartDateBucket;
  sort?: ChartSort;
  showLegend?: boolean;
  showLabels?: boolean;
  /** Hide the « Sans valeur » category. */
  hideEmpty?: boolean;
}

export interface DashboardWidget {
  id: string;
  /** A chart, or a short list of rows. */
  type: ChartViewType | 'list';
  title?: string;
  chart?: ChartConfig;
  /** Widget filter, applied on top of the view's filters. */
  filter?: FilterGroup | null;
  /** list: sort and number of rows. */
  sorts?: SortRule[];
  limit?: number;
  /** Grid span: columns (1–4) and rows (1–3). */
  w: number;
  h: number;
}

export interface FormQuestion {
  id: string;
  propertyId: string;
  /** Default: the property name. */
  label?: string;
  description?: string;
  required?: boolean;
  /** Asked only when another (earlier) question's answer equals `value` (option id, 'true' / 'false'). */
  showIf?: { questionId: string; value: string } | null;
}

export interface FormConfig {
  title?: string;
  description?: string;
  questions: FormQuestion[];
  /** Responses accepted (closing a form keeps it visible but refuses submissions). */
  acceptResponses: boolean;
  /** Anonymous answers through the share link (the database itself does not need to be published). */
  isPublic?: boolean;
  submitLabel?: string;
  /** Message shown after a submission. */
  confirmation?: string;
}

export interface View {
  id: string;
  databaseId: string;
  /** Views of a linked database block carry the block's link id; native views have none. */
  linkId?: string | null;
  name: string;
  type: ViewType;
  position: string;
  config: ViewConfig;
  version: number;
  /**
   * Manual order of the rows in this view (I1), row id → fractional index. Rows absent from the map fall
   * back to their page position; an active sort of the view takes precedence over both.
   */
  rowOrder?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Files, search, history
// ---------------------------------------------------------------------------

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Relative URL, e.g. /api/files/<id>/<name> */
  url: string;
}

export interface SearchResult {
  page: TreeNode & { workspaceId: string };
  /** Titles of ancestors, root first. */
  path: Crumb[];
  /** Plain-text excerpt; matched terms wrapped in [[ and ]]. Empty for title-only matches. */
  snippet: string;
}

export interface SnapshotMeta {
  id: string;
  pageId: string;
  createdAt: number;
  /** Users who edited since the previous snapshot. */
  authors: PublicUser[];
  /** `restore`: state produced by a restore (G6), `restoredFrom` names the restored version. */
  reason: 'auto' | 'daily' | 'before-restore' | 'restore';
  /** Restore versions only: date of the version that was restored (null when it no longer exists). */
  restoredFrom?: { id: string; createdAt: number } | null;
}

export interface TrashItem {
  page: Page;
  path: Crumb[];
}
