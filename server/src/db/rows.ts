// Row types (snake_case, as stored) and mappers to the shared camelCase types.
import type {
  Cover,
  Crumb,
  DatabaseSchema,
  Invite,
  Member,
  Page,
  PageFormat,
  PageKind,
  ParentType,
  PropertyDef,
  PropertyValue,
  PublicUser,
  TreeNode,
  User,
  View,
  ViewConfig,
  ViewType,
  Visibility,
  Workspace,
  WorkspaceRole,
  WorkspaceSummary,
} from '@oriel/shared';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  password_hash: string;
  is_admin: number;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  icon: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface PageRow {
  id: string;
  workspace_id: string;
  parent_type: ParentType;
  parent_id: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  cover: string | null;
  position: string;
  visibility: Visibility;
  owner_id: string;
  /** Navigation module (nav-001): root of the closed/private teamspace when visibility = 'teamspace'. */
  teamspace_id?: string | null;
  properties: string;
  format: string;
  is_inline: number;
  is_public: number;
  trashed_at: number | null;
  trashed_by: string | null;
  trash_root: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  version: number;
}

export interface DatabaseRow {
  page_id: string;
  properties: string;
  next_unique_id: number;
  version: number;
}

export interface ViewRow {
  id: string;
  database_id: string;
  name: string;
  type: ViewType;
  position: string;
  config: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface InviteRow {
  token: string;
  workspace_id: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  created_by: string;
  created_at: number;
  expires_at: number;
  uses: number;
  revoked: number;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    avatarUrl: r.avatar_url,
    isAdmin: r.is_admin === 1,
    createdAt: r.created_at,
  };
}

export function toPublicUser(r: Pick<UserRow, 'id' | 'name' | 'email' | 'avatar_url'>): PublicUser {
  return { id: r.id, name: r.name, email: r.email, avatarUrl: r.avatar_url };
}

export function toWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

export function toWorkspaceSummary(r: WorkspaceRow & { role: WorkspaceRole }): WorkspaceSummary {
  return { ...toWorkspace(r), role: r.role };
}

export function toPage(r: PageRow): Page {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    parentType: r.parent_type,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    cover: parseJson<Cover | null>(r.cover, null),
    position: r.position,
    visibility: r.visibility,
    ownerId: r.owner_id,
    properties: parseJson<Record<string, PropertyValue>>(r.properties, {}),
    format: parseJson<PageFormat>(r.format, {}),
    isInline: r.is_inline === 1,
    isPublic: r.is_public === 1,
    trashedAt: r.trashed_at,
    trashedBy: r.trashed_by,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    version: r.version,
  };
}

export function toTreeNode(
  r: Pick<PageRow, 'id' | 'parent_type' | 'parent_id' | 'kind' | 'title' | 'icon' | 'position' | 'visibility' | 'is_inline'> & {
    /** Column added by the editor module (feature migration editor-001); present with `SELECT p.*`. */
    is_template?: number;
    format?: string;
  },
): TreeNode {
  return {
    id: r.id,
    parentType: r.parent_type,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    position: r.position,
    visibility: r.visibility,
    isInline: r.is_inline === 1,
    ...(r.is_template === 1 ? { isTemplate: true } : {}),
    ...(r.parent_type === 'workspace' && r.kind === 'page' && (r.visibility === 'teamspace' || (r.visibility === 'workspace' && parseJson<PageFormat>(r.format, {}).teamspaceRoot === true)) ? { isTeamspace: true } : {}),
    ...(parseJson<PageFormat>(r.format, {}).sharedShortcut === true ? { isSharedShortcut: true } : {}),
  };
}

export function toCrumb(r: Pick<PageRow, 'id' | 'title' | 'icon' | 'kind'>): Crumb {
  return { id: r.id, title: r.title, icon: r.icon, kind: r.kind };
}

export function toSchema(r: DatabaseRow, workspaceId: string): DatabaseSchema {
  return {
    id: r.page_id,
    workspaceId,
    properties: parseJson<PropertyDef[]>(r.properties, []),
    version: r.version,
  };
}

export function toView(r: ViewRow): View {
  return {
    id: r.id,
    databaseId: r.database_id,
    name: r.name,
    type: r.type,
    position: r.position,
    config: parseJson<ViewConfig>(r.config, {} as ViewConfig),
    version: r.version,
  };
}

export function toInvite(r: InviteRow, publicUrl: string): Invite {
  const pathPart = `/invite/${r.token}`;
  return {
    token: r.token,
    workspaceId: r.workspace_id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    uses: r.uses,
    url: publicUrl ? `${publicUrl}${pathPart}` : pathPart,
  };
}

export function toMember(r: UserRow & { role: WorkspaceRole; joined_at: number }): Member {
  return { user: toPublicUser(r), role: r.role, joinedAt: r.joined_at };
}

export const PAGE_COLUMNS = `id, workspace_id, parent_type, parent_id, kind, title, icon, cover, position, visibility,
  owner_id, properties, format, is_inline, is_public, trashed_at, trashed_by, trash_root, created_at, created_by,
  updated_at, updated_by, version, teamspace_id`;
