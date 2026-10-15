// Typed HTTP client for the Oriel API (see shared/src/api.ts for the contract).
import type {
  AcceptInviteResponse,
  AdminSettings,
  AdminUsersResponse,
  ApiErrorBody,
  AuthConfigResponse,
  BacklinksResponse,
  ChangePasswordRequest,
  CreateInviteRequest,
  CreatePageRequest,
  CreatePropertyRequest,
  CreateRowRequest,
  CreateTemplateRequest,
  DeletePropertyMirrorMode,
  ImportRowsRequest,
  ImportRowsResponse,
  BatchUpdateRowsRequest,
  BatchUpdateRowsResponse,
  SetDefaultTemplateRequest,
  MoveViewRowRequest,
  MoveViewRowResponse,
  SetTemplateRecurrenceRequest,
  TemplatesResponse,
  CreateViewRequest,
  CreateWorkspaceRequest,
  DatabaseResponse,
  DatabaseSchema,
  PropertyAccessRole,
  RelationGraphResponse,
  FavoriteRequest,
  FavoritesResponse,
  HealthResponse,
  Invite,
  InviteInfoResponse,
  LoginRequest,
  Member,
  MovePageRequest,
  MovePropertyRequest,
  MoveViewRequest,
  Page,
  PageDetailResponse,
  PublicDatabaseResponse,
  PublicPageResponse,
  PublicRowsResponse,
  RecentResponse,
  RowsResponse,
  SearchResponse,
  SessionResponse,
  SignupRequest,
  SnapshotResponse,
  SnapshotsResponse,
  TrashResponse,
  TreeResponse,
  UpdateMeRequest,
  UpdateMemberRequest,
  UpdatePageRequest,
  UpdatePropertyRequest,
  UpdateViewRequest,
  UpdateWorkspaceRequest,
  UploadedFile,
  User,
  View,
  WorkspaceSummary,
} from '@oriel/shared';
import { apiPath, isSafeApiPath, queryString } from './apiPath';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Refuses a path the URL parser would rewrite (`..` from a forged id, see lib/apiPath.ts). Called at
 * the top of the async request functions: the failure is a rejected promise, never a sync throw.
 */
export function assertApiPath(path: string): void {
  if (!isSafeApiPath(path)) throw new ApiError(400, 'invalid_path', 'Adresse de requête invalide.');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let unauthorizedHandler: (() => void) | null = null;
/** Called on any 401 response (except for the session probe). */
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
}

/**
 * Handlers able to resolve an API error by its code (e.g. `reauth_required`: the user confirms their
 * identity, auth/ReauthDialog.tsx). Resolving true retries the request once.
 */
const errorRecoveries = new Map<string, (err: ApiError) => Promise<boolean>>();
export function onApiErrorCode(code: string, handler: (err: ApiError) => Promise<boolean>) {
  errorRecoveries.set(code, handler);
}
export async function recoverApiError(err: ApiError): Promise<boolean> {
  const handler = errorRecoveries.get(err.code);
  return handler ? handler(err) : false;
}

async function request<T>(method: Method, path: string, body?: unknown, opts: { quiet401?: boolean; retried?: boolean } = {}): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'network', 'Serveur injoignable. Vérifiez votre connexion.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    if (res.status === 401 && !opts.quiet401) unauthorizedHandler?.();
    const error = new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur ${res.status}`);
    if (!opts.retried && (await recoverApiError(error))) return request<T>(method, path, body, { ...opts, retried: true });
    throw error;
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const q = queryString;

export const api = {
  health: () => request<HealthResponse>('GET', '/health'),

  auth: {
    config: () => request<AuthConfigResponse>('GET', '/auth/config'),
    me: () => request<SessionResponse>('GET', '/auth/me', undefined, { quiet401: true }),
    signup: (body: SignupRequest) => request<SessionResponse>('POST', '/auth/signup', body),
    login: (body: LoginRequest) => request<SessionResponse>('POST', '/auth/login', body, { quiet401: true }),
    logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  },

  me: {
    update: (body: UpdateMeRequest) => request<{ user: User }>('PATCH', '/me', body),
    changePassword: (body: ChangePasswordRequest) => request<{ ok: true }>('POST', '/me/password', body),
  },

  workspaces: {
    list: () => request<WorkspaceSummary[]>('GET', '/workspaces'),
    create: (body: CreateWorkspaceRequest) => request<WorkspaceSummary>('POST', '/workspaces', body),
    get: (wid: string) => request<WorkspaceSummary>('GET', apiPath`/workspaces/${wid}`),
    update: (wid: string, body: UpdateWorkspaceRequest) => request<WorkspaceSummary>('PATCH', apiPath`/workspaces/${wid}`, body),
    remove: (wid: string) => request<{ ok: true }>('DELETE', apiPath`/workspaces/${wid}`),
    tree: (wid: string) => request<TreeResponse>('GET', apiPath`/workspaces/${wid}/tree`),
    favorites: (wid: string) => request<FavoritesResponse>('GET', apiPath`/workspaces/${wid}/favorites`),
    recent: (wid: string) => request<RecentResponse>('GET', apiPath`/workspaces/${wid}/recent`),
    trash: (wid: string) => request<TrashResponse>('GET', apiPath`/workspaces/${wid}/trash`),
    search: (wid: string, query: string, limit = 20) =>
      request<SearchResponse>('GET', apiPath`/workspaces/${wid}/search` + q({ q: query, limit })),
    members: (wid: string) => request<Member[]>('GET', apiPath`/workspaces/${wid}/members`),
    updateMember: (wid: string, uid: string, body: UpdateMemberRequest) =>
      request<Member>('PATCH', apiPath`/workspaces/${wid}/members/${uid}`, body),
    removeMember: (wid: string, uid: string) => request<{ ok: true }>('DELETE', apiPath`/workspaces/${wid}/members/${uid}`),
    invites: (wid: string) => request<Invite[]>('GET', apiPath`/workspaces/${wid}/invites`),
    createInvite: (wid: string, body: CreateInviteRequest) => request<Invite>('POST', apiPath`/workspaces/${wid}/invites`, body),
    revokeInvite: (wid: string, token: string) => request<{ ok: true }>('DELETE', apiPath`/workspaces/${wid}/invites/${token}`),
    upload: (wid: string, file: File | Blob, name?: string) => {
      const form = new FormData();
      form.append('file', file, name ?? (file instanceof File ? file.name : 'fichier'));
      return request<UploadedFile>('POST', apiPath`/workspaces/${wid}/files`, form);
    },
  },

  invites: {
    info: (token: string) => request<InviteInfoResponse>('GET', apiPath`/invites/${token}`),
    accept: (token: string) => request<AcceptInviteResponse>('POST', apiPath`/invites/${token}/accept`),
  },

  pages: {
    create: (wid: string, body: CreatePageRequest) => request<Page>('POST', apiPath`/workspaces/${wid}/pages`, body),
    get: (pid: string) => request<PageDetailResponse>('GET', apiPath`/pages/${pid}`),
    update: (pid: string, body: UpdatePageRequest) => request<Page>('PATCH', apiPath`/pages/${pid}`, body),
    move: (pid: string, body: MovePageRequest) => request<Page>('POST', apiPath`/pages/${pid}/move`, body),
    duplicate: (pid: string) => request<Page>('POST', apiPath`/pages/${pid}/duplicate`),
    trash: (pid: string) => request<{ ok: true }>('POST', apiPath`/pages/${pid}/trash`),
    restore: (pid: string) => request<Page>('POST', apiPath`/pages/${pid}/restore`),
    destroy: (pid: string) => request<{ ok: true }>('DELETE', apiPath`/pages/${pid}`),
    publish: (pid: string, isPublic: boolean) => request<Page>('POST', apiPath`/pages/${pid}/publish`, { isPublic }),
    favorite: (pid: string, body: FavoriteRequest) => request<{ favorites: string[] }>('PUT', apiPath`/pages/${pid}/favorite`, body),
    backlinks: (pid: string) => request<BacklinksResponse>('GET', apiPath`/pages/${pid}/backlinks`),
    snapshots: (pid: string) => request<SnapshotsResponse>('GET', apiPath`/pages/${pid}/snapshots`),
    snapshot: (pid: string, sid: string) => request<SnapshotResponse>('GET', apiPath`/pages/${pid}/snapshots/${sid}`),
    restoreSnapshot: (pid: string, sid: string) => request<{ ok: true }>('POST', apiPath`/pages/${pid}/snapshots/${sid}/restore`),
  },

  databases: {
    /** `linkId`: views of a linked database block (created on first open). */
    get: (did: string, linkId?: string) => request<DatabaseResponse>('GET', apiPath`/databases/${did}` + q({ linkId })),
    rows: (did: string) => request<RowsResponse>('GET', apiPath`/databases/${did}/rows`),
    createRow: (did: string, body: CreateRowRequest) => request<Page>('POST', apiPath`/databases/${did}/rows`, body),
    createProperty: (did: string, body: CreatePropertyRequest) =>
      request<DatabaseSchema>('POST', apiPath`/databases/${did}/properties`, body),
    updateProperty: (did: string, propId: string, body: UpdatePropertyRequest) =>
      request<DatabaseSchema>('PATCH', apiPath`/databases/${did}/properties/${propId}`, body),
    /** Relation schema of a database (D29). */
    relationGraph: (did: string) => request<RelationGraphResponse>('GET', apiPath`/databases/${did}/relation-graph`),
    /** Per-property permissions (D30): owners and admins only; null clears a rule. */
    setPropertyAccess: (did: string, propId: string, body: { readRoles?: PropertyAccessRole[] | null; editRoles?: PropertyAccessRole[] | null }) =>
      request<DatabaseSchema>('PUT', apiPath`/databases/${did}/properties/${propId}/access`, body),
    deleteProperty: (did: string, propId: string, mirror?: DeletePropertyMirrorMode) =>
      request<DatabaseSchema>('DELETE', apiPath`/databases/${did}/properties/${propId}` + q({ mirror })),
    moveProperty: (did: string, propId: string, body: MovePropertyRequest) =>
      request<DatabaseSchema>('POST', apiPath`/databases/${did}/properties/${propId}/move`, body),
    createView: (did: string, body: CreateViewRequest) => request<View>('POST', apiPath`/databases/${did}/views`, body),
    templates: (did: string) => request<TemplatesResponse>('GET', apiPath`/databases/${did}/templates`),
    createTemplate: (did: string, body: CreateTemplateRequest) => request<Page>('POST', apiPath`/databases/${did}/templates`, body),
    setDefaultTemplate: (did: string, templateId: string | null) =>
      request<TemplatesResponse>('PUT', apiPath`/databases/${did}/templates/default`, { templateId } satisfies SetDefaultTemplateRequest),
    /** I1: recurring template (null stops it). */
    setTemplateRecurrence: (did: string, tid: string, body: SetTemplateRecurrenceRequest) =>
      request<TemplatesResponse>('PUT', apiPath`/databases/${did}/templates/${tid}/recurrence`, body),
    importRows: (did: string, body: ImportRowsRequest) => request<ImportRowsResponse>('POST', apiPath`/databases/${did}/import`, body),
    updateRowsBatch: (did: string, body: BatchUpdateRowsRequest) =>
      request<BatchUpdateRowsResponse>('POST', apiPath`/databases/${did}/rows/batch`, body),
  },

  views: {
    update: (vid: string, body: UpdateViewRequest) => request<View>('PATCH', apiPath`/views/${vid}`, body),
    remove: (vid: string) => request<{ ok: true }>('DELETE', apiPath`/views/${vid}`),
    move: (vid: string, body: MoveViewRequest) => request<View>('POST', apiPath`/views/${vid}/move`, body),
    duplicate: (vid: string) => request<View>('POST', apiPath`/views/${vid}/duplicate`),
    /** I1: manual order of a row in this view only. */
    moveRow: (vid: string, body: MoveViewRowRequest) => request<MoveViewRowResponse>('POST', apiPath`/views/${vid}/rows/move`, body),
  },

  public: {
    page: (pid: string) => request<PublicPageResponse>('GET', apiPath`/public/pages/${pid}`),
    database: (did: string, linkId?: string) => request<PublicDatabaseResponse>('GET', apiPath`/public/databases/${did}` + q({ linkId })),
    rows: (did: string) => request<PublicRowsResponse>('GET', apiPath`/public/databases/${did}/rows`),
  },

  admin: {
    settings: () => request<AdminSettings>('GET', '/admin/settings'),
    updateSettings: (body: Partial<AdminSettings>) => request<AdminSettings>('PATCH', '/admin/settings', body),
    users: () => request<AdminUsersResponse>('GET', '/admin/users'),
  },
};

export type Api = typeof api;
