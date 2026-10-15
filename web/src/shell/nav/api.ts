// HTTP client and query keys of the navigation module (wave G7; contract: shared/src/navigation.ts).
import type {
  AccessEffect,
  ApiErrorBody,
  ConvertToTeamspaceRequest,
  CreateSidebarItemRequest,
  FolderSummary,
  FoldersResponse,
  MovePreviewRequest,
  NavigationSettings,
  Page,
  PageStatsResponse,
  ProfileResponse,
  SidebarItem,
  SidebarResponse,
  SidebarRowsResponse,
  SidebarSection,
  TeamspaceMembersResponse,
  TeamspaceRole,
  TeamspacesResponse,
  TeamspaceSummary,
  UpdateSidebarItemRequest,
  UpdateTeamspaceRequest,
} from '@oriel/shared';
import { ApiError, assertApiPath } from '../../lib/api';
import { apiPath, queryString } from '../../lib/apiPath';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'network', 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur ${res.status}`);
  }
  return data as T;
}

/** Query keys of the navigation module (invalidated by lib/events.ts on `navigation` changes). */
export const nk = {
  teamspaces: (wid: string) => ['nav-teamspaces', wid] as const,
  teamspaceMembers: (tid: string) => ['nav-teamspaces-members', tid] as const,
  sidebar: (wid: string) => ['nav-sidebar', wid] as const,
  sidebarRows: (did: string) => ['nav-sidebar-rows', did] as const,
  folders: (wid: string) => ['nav-folders', wid] as const,
  stats: (pid: string) => ['nav-stats', pid] as const,
  settings: (wid: string) => ['nav-settings', wid] as const,
  profile: (wid: string, uid: string) => ['nav-profile', wid, uid] as const,
};

type Ok = { ok: true };

export const navApi = {
  // teamspaces
  teamspaces: (wid: string) => request<TeamspacesResponse>('GET', apiPath`/workspaces/${wid}/teamspaces`),
  updateTeamspace: (tid: string, body: UpdateTeamspaceRequest) => request<TeamspaceSummary>('PATCH', apiPath`/teamspaces/${tid}`, body),
  join: (tid: string) => request<TeamspaceSummary>('POST', apiPath`/teamspaces/${tid}/join`, {}),
  requestAccess: (tid: string) => request<TeamspaceSummary>('POST', apiPath`/teamspaces/${tid}/request`, {}),
  leave: (tid: string) => request<Ok>('POST', apiPath`/teamspaces/${tid}/leave`, {}),
  members: (tid: string) => request<TeamspaceMembersResponse>('GET', apiPath`/teamspaces/${tid}/members`),
  setMember: (tid: string, uid: string, role: TeamspaceRole) => request<Ok>('PUT', apiPath`/teamspaces/${tid}/members/${uid}`, { role }),
  removeMember: (tid: string, uid: string) => request<Ok>('DELETE', apiPath`/teamspaces/${tid}/members/${uid}`),
  answer: (tid: string, uid: string, accept: boolean) => request<Ok>('POST', apiPath`/teamspaces/${tid}/requests/${uid}`, { accept }),
  previewConversion: (pid: string, body: ConvertToTeamspaceRequest) => request<AccessEffect>('POST', apiPath`/pages/${pid}/teamspace/preview`, body),
  convert: (pid: string, body: ConvertToTeamspaceRequest) => request<Page>('POST', apiPath`/pages/${pid}/teamspace`, body),
  previewMove: (pid: string, body: MovePreviewRequest) =>
    request<AccessEffect & { needsConfirm: boolean }>('POST', apiPath`/pages/${pid}/move/preview`, body),
  // sidebar
  sidebar: (wid: string) => request<SidebarResponse>('GET', apiPath`/workspaces/${wid}/sidebar`),
  addItem: (wid: string, body: CreateSidebarItemRequest) => request<SidebarItem>('POST', apiPath`/workspaces/${wid}/sidebar/items`, body),
  updateItem: (id: string, body: UpdateSidebarItemRequest) => request<Ok>('PATCH', apiPath`/sidebar/items/${id}`, body),
  deleteItem: (id: string) => request<Ok>('DELETE', apiPath`/sidebar/items/${id}`),
  addSection: (wid: string, name: string) => request<SidebarSection>('POST', apiPath`/workspaces/${wid}/sidebar/sections`, { name }),
  updateSection: (id: string, body: { name?: string; collapsed?: boolean; after?: string | null }) =>
    request<Ok>('PATCH', apiPath`/sidebar/sections/${id}`, body),
  deleteSection: (id: string) => request<Ok>('DELETE', apiPath`/sidebar/sections/${id}`),
  sidebarRows: (did: string, offset: number, limit = 25) =>
    request<SidebarRowsResponse>('GET', apiPath`/sidebar/databases/${did}/rows` + queryString({ offset, limit })),
  // folders
  folders: (wid: string) => request<FoldersResponse>('GET', apiPath`/workspaces/${wid}/folders`),
  addFolder: (wid: string, space: string, name: string) => request<FolderSummary>('POST', apiPath`/workspaces/${wid}/folders`, { space, name }),
  updateFolder: (id: string, body: { name?: string; after?: string | null }) => request<Ok>('PATCH', apiPath`/folders/${id}`, body),
  deleteFolder: (id: string) => request<Ok>('DELETE', apiPath`/folders/${id}`),
  putInFolder: (id: string, pid: string, after?: string | null) => request<Ok>('PUT', apiPath`/folders/${id}/pages/${pid}`, { after }),
  removeFromFolder: (pid: string) => request<Ok>('DELETE', apiPath`/folders/pages/${pid}`),
  // statistics, settings, profiles
  stats: (pid: string) => request<PageStatsResponse>('GET', apiPath`/pages/${pid}/stats`),
  settings: (wid: string) => request<NavigationSettings>('GET', apiPath`/workspaces/${wid}/navigation-settings`),
  updateSettings: (wid: string, body: Partial<NavigationSettings>) => request<NavigationSettings>('PATCH', apiPath`/workspaces/${wid}/navigation-settings`, body),
  profile: (wid: string, uid: string) => request<ProfileResponse>('GET', apiPath`/workspaces/${wid}/people/${uid}`),
};
