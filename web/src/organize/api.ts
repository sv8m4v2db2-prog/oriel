// HTTP client and query keys of the organize module (wave H3; contract: shared/src/organize.ts).
import type {
  ApiErrorBody,
  ApplyTagsRequest,
  ApplyTagsResponse,
  Collection,
  CollectionInput,
  CollectionPreviewRequest,
  CollectionsResponse,
  CreatePagePropRequest,
  CreateTagRequest,
  FolderItemKind,
  FolderItemsResponse,
  JournalMonthResponse,
  JournalOpenResponse,
  PageListResponse,
  PageOrganization,
  PageProp,
  PagePropValue,
  PagePropsResponse,
  PageQuery,
  PagesBatchRequest,
  PagesBatchResponse,
  SavedPagesView,
  SavedPagesViewInput,
  SavedPagesViewsResponse,
  Tag,
  TagsResponse,
  UpdateCollectionRequest,
  UpdatePagePropRequest,
  UpdateTagRequest,
} from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath, queryString } from '../lib/apiPath';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Ok = { ok: true };

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

/** Query keys; every key starts with 'org' so lib/events.ts can invalidate by scope. */
export const ok = {
  tags: (wid: string) => ['org', 'tags', wid] as const,
  props: (wid: string) => ['org', 'props', wid] as const,
  collections: (wid: string) => ['org', 'collections', wid] as const,
  views: (wid: string) => ['org', 'views', wid] as const,
  folderItems: (wid: string) => ['org', 'folder-items', wid] as const,
  pageOrg: (pid: string) => ['org', 'page-org', pid] as const,
  journal: (wid: string, month: string) => ['org', 'journal', wid, month] as const,
  list: (wid: string, query: unknown) => ['org', 'list', wid, query] as const,
  preview: (wid: string, draft: unknown) => ['org', 'preview', wid, draft] as const,
};

export const orgApi = {
  // journal
  journal: (wid: string, month: string) => request<JournalMonthResponse>('GET', apiPath`/workspaces/${wid}/journal` + queryString({ month })),
  openDay: (wid: string, day: string) => request<JournalOpenResponse>('POST', apiPath`/workspaces/${wid}/journal/days/${day}`, {}),
  setJournalTemplate: (wid: string, templateId: string | null) => request<{ template: JournalMonthResponse['template'] }>('PUT', apiPath`/workspaces/${wid}/journal/settings`, { templateId }),
  // tags
  tags: (wid: string) => request<TagsResponse>('GET', apiPath`/workspaces/${wid}/tags`),
  createTag: (wid: string, body: CreateTagRequest) => request<Tag>('POST', apiPath`/workspaces/${wid}/tags`, body),
  updateTag: (id: string, body: UpdateTagRequest) => request<Tag>('PATCH', apiPath`/tags/${id}`, body),
  deleteTag: (id: string) => request<Ok>('DELETE', apiPath`/tags/${id}`),
  applyTags: (wid: string, body: ApplyTagsRequest) => request<ApplyTagsResponse>('POST', apiPath`/workspaces/${wid}/tags/apply`, body),
  pageOrganization: (pid: string) => request<PageOrganization>('GET', apiPath`/pages/${pid}/organization`),
  setPageTags: (pid: string, tagIds: string[]) => request<{ tagIds: string[] }>('PUT', apiPath`/pages/${pid}/tags`, { tagIds }),
  // workspace page properties
  props: (wid: string) => request<PagePropsResponse>('GET', apiPath`/workspaces/${wid}/page-props`),
  createProp: (wid: string, body: CreatePagePropRequest) => request<PageProp>('POST', apiPath`/workspaces/${wid}/page-props`, body),
  updateProp: (id: string, body: UpdatePagePropRequest) => request<PageProp>('PATCH', apiPath`/page-props/${id}`, body),
  deleteProp: (id: string) => request<Ok>('DELETE', apiPath`/page-props/${id}`),
  setPropValue: (pid: string, propId: string, value: PagePropValue) => request<{ value: PagePropValue }>('PUT', apiPath`/pages/${pid}/props/${propId}`, { value }),
  // listing, batch
  query: (wid: string, body: PageQuery) => request<PageListResponse>('POST', apiPath`/workspaces/${wid}/pages/query`, body),
  batch: (wid: string, body: PagesBatchRequest) => request<PagesBatchResponse>('POST', apiPath`/workspaces/${wid}/pages/batch`, body),
  // collections
  collections: (wid: string) => request<CollectionsResponse>('GET', apiPath`/workspaces/${wid}/collections`),
  createCollection: (wid: string, body: CollectionInput) => request<Collection>('POST', apiPath`/workspaces/${wid}/collections`, body),
  updateCollection: (id: string, body: UpdateCollectionRequest) => request<Collection>('PATCH', apiPath`/collections/${id}`, body),
  deleteCollection: (id: string) => request<Ok>('DELETE', apiPath`/collections/${id}`),
  previewCollection: (wid: string, body: CollectionPreviewRequest) => request<PageListResponse>('POST', apiPath`/workspaces/${wid}/collections/preview`, body),
  setCollectionPage: (id: string, pid: string, mode: 'include' | 'exclude' | null) => request<Ok>('PUT', apiPath`/collections/${id}/pages/${pid}`, { mode }),
  // saved views
  views: (wid: string) => request<SavedPagesViewsResponse>('GET', apiPath`/workspaces/${wid}/page-views`),
  createView: (wid: string, body: SavedPagesViewInput) => request<SavedPagesView>('POST', apiPath`/workspaces/${wid}/page-views`, body),
  updateView: (id: string, body: Partial<SavedPagesViewInput>) => request<SavedPagesView>('PATCH', apiPath`/page-views/${id}`, body),
  deleteView: (id: string) => request<Ok>('DELETE', apiPath`/page-views/${id}`),
  // sidebar folder items
  folderItems: (wid: string) => request<FolderItemsResponse>('GET', apiPath`/workspaces/${wid}/organize/folder-items`),
  putFolderItem: (folderId: string, kind: FolderItemKind, refId: string) => request<Ok>('PUT', apiPath`/folders/${folderId}/items`, { kind, refId }),
  removeFolderItem: (folderId: string, kind: FolderItemKind, refId: string) => request<Ok>('DELETE', apiPath`/folders/${folderId}/items/${kind}/${refId}`),
};
