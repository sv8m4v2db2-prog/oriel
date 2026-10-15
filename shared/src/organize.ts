// Organize module (wave H3): daily journal, workspace tags, workspace page properties, smart
// collections and the "All pages" listing. Contract shared by server, web and MCP.
import type { PageKind, ParentType, Visibility } from './types.js';

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`, a real calendar day between 2000 and 2100. */
export function isJournalDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export interface JournalDay {
  day: string;
  pageId: string;
}

/** GET /api/workspaces/:wid/journal?month=YYYY-MM — days of the month that have a page. */
export interface JournalMonthResponse {
  month: string;
  days: JournalDay[];
  /** Page « Journal » holding the day pages, null until the first day is opened. */
  containerId: string | null;
  /** Chosen template (a page template visible to the viewer), null for an empty page. */
  template: { id: string; title: string; icon: string | null } | null;
}

/** POST /api/workspaces/:wid/journal/days/:day */
export interface JournalOpenResponse {
  day: string;
  pageId: string;
  created: boolean;
}

/** PUT /api/workspaces/:wid/journal/settings */
export interface JournalSettingsRequest {
  templateId: string | null;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const TAG_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red', 'indigo', 'lime'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  /** Pages (not trashed) the viewer can see that carry the tag. */
  pageCount: number;
  createdBy: string | null;
}

export interface TagsResponse {
  tags: Tag[];
}

export interface CreateTagRequest {
  name: string;
  color?: TagColor;
}

export interface UpdateTagRequest {
  name?: string;
  color?: TagColor;
}

export interface ApplyTagsRequest {
  pageIds: string[];
  add?: string[];
  remove?: string[];
}

export interface ApplyTagsResponse {
  changed: number;
  /** Pages the viewer cannot edit or does not see (indistinguishable on purpose). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Workspace page properties
// ---------------------------------------------------------------------------

export type PageProp = {
  id: string;
  name: string;
  type: PagePropType;
  options: PagePropOption[];
  /** always: shown even when empty; hide_empty: shown once it has a value; hidden: never in the header. */
  display: PagePropDisplay;
  position: string;
};
export type PagePropType = 'text' | 'number' | 'date' | 'checkbox' | 'select';
export type PagePropDisplay = 'always' | 'hide_empty' | 'hidden';
export interface PagePropOption {
  id: string;
  name: string;
  color: TagColor;
}
export type PagePropValue = string | number | boolean | null;

export interface PagePropsResponse {
  props: PageProp[];
}

export interface CreatePagePropRequest {
  name: string;
  type: PagePropType;
  options?: PagePropOption[];
  display?: PagePropDisplay;
}

export interface UpdatePagePropRequest {
  name?: string;
  options?: PagePropOption[];
  display?: PagePropDisplay;
  after?: string | null;
}

/** GET /api/pages/:pid/organization — what the page header shows. */
export interface PageOrganization {
  tagIds: string[];
  props: Record<string, PagePropValue>;
}

// ---------------------------------------------------------------------------
// Filters (collections' rules and "All pages")
// ---------------------------------------------------------------------------

export type PageTypeFilter = 'page' | 'database' | 'row' | 'template' | 'journal';

export type PageCondition =
  | { type: 'tag'; op: 'any' | 'all' | 'none'; tagIds: string[] }
  | { type: 'user'; by: 'created' | 'updated'; userIds: string[] }
  | { type: 'date'; field: 'created' | 'updated'; after?: string; before?: string; lastDays?: number }
  | { type: 'prop'; propId: string; op: PagePropOp; value?: PagePropValue }
  | { type: 'space'; space: string }
  | { type: 'kind'; kinds: PageTypeFilter[] }
  | { type: 'title'; value: string };

export type PagePropOp = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'empty' | 'not_empty' | 'checked' | 'unchecked';

export interface PageFilter {
  match: 'all' | 'any';
  conditions: PageCondition[];
}

export const MAX_CONDITIONS = 20;

export type PageGroupBy = 'none' | 'tag' | 'author' | 'created_month' | 'updated_month' | 'type' | { prop: string };
export type PageSortField = 'title' | 'created' | 'updated' | { prop: string };

export interface PageSort {
  field: PageSortField;
  dir: 'asc' | 'desc';
}

export interface PageQuery {
  filter?: PageFilter;
  /** Collection whose pages (rules, additions, exclusions) restrict the listing. */
  collectionId?: string;
  group?: PageGroupBy;
  sort?: PageSort;
  /** Workspace property ids whose values are returned (at most 12). */
  propIds?: string[];
  offset?: number;
  limit?: number;
}

export interface PageListItem {
  id: string;
  kind: PageKind;
  parentType: ParentType;
  parentId: string;
  /** Title of the parent when the viewer sees it. */
  parentTitle: string | null;
  title: string;
  icon: string | null;
  visibility: Visibility;
  isTemplate: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  tagIds: string[];
  props: Record<string, PagePropValue>;
  /** Group key when grouping is on: tag id, user id, YYYY-MM, option id, type… ('' = none). */
  group: string | null;
}

export interface PageListResponse {
  items: PageListItem[];
  total: number;
  offset: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface Collection {
  id: string;
  name: string;
  icon: string | null;
  rules: PageFilter;
  /** Pages added by hand / excluded by hand (only the ones the viewer can see). */
  included: string[];
  excluded: string[];
  position: string;
  createdBy: string | null;
}

export interface CollectionsResponse {
  collections: Collection[];
}

export interface CollectionInput {
  name: string;
  icon?: string | null;
  rules?: PageFilter;
}

export interface UpdateCollectionRequest {
  name?: string;
  icon?: string | null;
  rules?: PageFilter;
  after?: string | null;
}

/** POST /api/workspaces/:wid/collections/preview — unsaved draft. */
export interface CollectionPreviewRequest {
  rules: PageFilter;
  included?: string[];
  excluded?: string[];
  offset?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Saved views of "All pages"
// ---------------------------------------------------------------------------

export interface AllPagesViewConfig {
  layout: 'list' | 'grid';
  filter: PageFilter;
  group: PageGroupBy;
  sort: PageSort;
  columns: string[];
}

export interface SavedPagesView {
  id: string;
  name: string;
  shared: boolean;
  ownerId: string;
  mine: boolean;
  config: AllPagesViewConfig;
}

export interface SavedPagesViewsResponse {
  views: SavedPagesView[];
}

export interface SavedPagesViewInput {
  name: string;
  shared?: boolean;
  config: AllPagesViewConfig;
}

// ---------------------------------------------------------------------------
// Batch actions, sidebar folder items
// ---------------------------------------------------------------------------

export type PagesBatchRequest =
  | { action: 'trash'; pageIds: string[] }
  | { action: 'move'; pageIds: string[]; parentType: 'workspace' | 'page'; parentId: string; visibility?: 'workspace' | 'private'; confirmAccess?: boolean };

export interface PagesBatchResponse {
  done: string[];
  failed: Array<{ id: string; reason: string }>;
}

export type FolderItemKind = 'tag' | 'collection';

export interface FolderItem {
  folderId: string;
  kind: FolderItemKind;
  refId: string;
  position: string;
}

export interface FolderItemsResponse {
  items: FolderItem[];
}
