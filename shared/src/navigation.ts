// Navigation module (wave G7): teamspaces, personal sidebar, folders, page statistics, profiles.
import type { Crumb, PageKind, PublicUser, TeamspaceAccess, Visibility, WorkspaceRole } from './types.js';

// ---------------------------------------------------------------------------
// Teamspaces
// ---------------------------------------------------------------------------

export type TeamspaceRole = 'owner' | 'member';

export interface TeamspaceSummary {
  /** Id of the teamspace's root page. */
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  description: string;
  access: TeamspaceAccess;
  /** Open teamspace every workspace member belongs to. */
  isDefault: boolean;
  memberCount: number;
  owners: PublicUser[];
  /** Viewer's role, null when not a member. */
  myRole: TeamspaceRole | null;
  /** The viewer asked to join (closed teamspace). */
  requested: boolean;
  canManage: boolean;
}

/** GET /api/workspaces/:wid/teamspaces — the directory (private teamspaces only for their members). */
export interface TeamspacesResponse {
  teamspaces: TeamspaceSummary[];
}

export interface TeamspaceMember {
  user: PublicUser;
  role: TeamspaceRole;
  joinedAt: number;
}

/** GET /api/teamspaces/:tid/members (members and managers only). */
export interface TeamspaceMembersResponse {
  members: TeamspaceMember[];
  /** Pending requests, for managers only (empty otherwise). */
  requests: Array<{ user: PublicUser; createdAt: number }>;
}

/** PATCH /api/teamspaces/:tid */
export interface UpdateTeamspaceRequest {
  access?: TeamspaceAccess;
  isDefault?: boolean;
  description?: string;
  /** Required (true) when the change widens access (closed/private → open, private → closed). */
  confirmAccess?: boolean;
}

/** Effect of an operation on who can read a subtree. Counts only: no names leak. */
export interface AccessEffect {
  /** Pages concerned (the page and all its descendants, rows included). */
  pageCount: number;
  from: AccessAudience;
  to: AccessAudience;
  /** People who will gain / lose read access. */
  gain: number;
  lose: number;
  widens: boolean;
  narrows: boolean;
}

export interface AccessAudience {
  visibility: Visibility;
  /** Teamspace (root page) when the place is inside one. */
  teamspace: { id: string; title: string; access: TeamspaceAccess } | null;
  /** Number of people with read access. */
  readers: number;
}

/** POST /api/pages/:pid/teamspace/preview and POST /api/pages/:pid/teamspace */
export interface ConvertToTeamspaceRequest {
  access: TeamspaceAccess;
  /** Required (true) when access widens, or when people lose access. */
  confirmAccess?: boolean;
}

/** POST /api/pages/:pid/move/preview (same body as a move). */
export interface MovePreviewRequest {
  parentType: 'workspace' | 'page';
  parentId: string;
  visibility?: 'workspace' | 'private';
}

// ---------------------------------------------------------------------------
// Personal sidebar and folders
// ---------------------------------------------------------------------------

export type SidebarItemKind = 'page' | 'view' | 'link';

export interface SidebarItem {
  id: string;
  sectionId: string | null;
  kind: SidebarItemKind;
  position: string;
  /** Link label, or custom label. Page/view titles are resolved live. */
  label: string;
  /** kind 'page' | 'view': the page (database for 'view'). */
  page: { id: string; title: string; icon: string | null; kind: PageKind } | null;
  view: { id: string; name: string; type: string } | null;
  url: string | null;
}

export interface SidebarSection {
  id: string;
  name: string;
  position: string;
  collapsed: boolean;
}

/** GET /api/workspaces/:wid/sidebar — items whose target is invisible are omitted. */
export interface SidebarResponse {
  sections: SidebarSection[];
  items: SidebarItem[];
}

export interface CreateSidebarItemRequest {
  kind: SidebarItemKind;
  sectionId?: string | null;
  pageId?: string;
  viewId?: string;
  url?: string;
  label?: string;
  after?: string | null;
}

export interface UpdateSidebarItemRequest {
  label?: string;
  url?: string;
  sectionId?: string | null;
  /** Reorder: id of the item to put this one after (null = first). */
  after?: string | null;
}

export interface FolderSummary {
  id: string;
  /** 'workspace' | 'private' | teamspace root id. */
  space: string;
  name: string;
  position: string;
  /** Visible pages of the folder, in order. */
  pageIds: string[];
}

/** GET /api/workspaces/:wid/folders */
export interface FoldersResponse {
  folders: FolderSummary[];
}

/** GET /api/sidebar/databases/:did/rows?offset=&limit= — light rows of a pinned database. */
export interface SidebarRowsResponse {
  rows: Array<{ id: string; title: string; icon: string | null }>;
  total: number;
}

// ---------------------------------------------------------------------------
// Page statistics, profiles
// ---------------------------------------------------------------------------

export interface PageStatsResponse {
  /** Last 30 days, oldest first, every day present. `date` is YYYY-MM-DD (UTC). */
  days: Array<{ date: string; views: number; anonymousViews: number }>;
  totalViews: number;
  uniqueReaders7: number;
  uniqueReaders30: number;
  uniqueReadersAll: number;
  /** null when the workspace hides readers. */
  readers: Array<{ user: PublicUser; lastVisitedAt: number }> | null;
  editors: Array<{ user: PublicUser; at: number }>;
}

export interface NavigationSettings {
  showReaders: boolean;
}

export interface ProfileResponse {
  user: PublicUser;
  role: WorkspaceRole;
  joinedAt: number;
  /** Pages created by the person, visible to the viewer, most recently edited first. */
  pages: Array<Crumb & { updatedAt: number }>;
  /** Pages the person edited recently (visible to the viewer). */
  activity: Array<Crumb & { at: number; created: boolean }>;
  collaborators: Array<{ user: PublicUser; sharedPages: number }>;
}
