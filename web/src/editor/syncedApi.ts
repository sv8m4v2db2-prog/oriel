// HTTP client of synced blocks (server/src/routes/editor.ts). Every call names the page showing the
// block: the server resolves a block only for a visible page of its own workspace, and only when the
// caller can see the owner page (404 otherwise).
import type { ApiErrorBody, PageContentResponse, SyncedBlockInfo } from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath } from '../lib/apiPath';

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (method === 'POST') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = '{}';
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

export const syncedApi = {
  /** New synced block owned by `pageId` (edit access). */
  create: (pageId: string) => call<SyncedBlockInfo>('POST', apiPath`/pages/${pageId}/synced-blocks`),
  /** Synced block `syncedId` as shown by `pageId`. */
  info: (pageId: string, syncedId: string) => call<SyncedBlockInfo>('GET', apiPath`/pages/${pageId}/synced-blocks/${syncedId}`),
  /** Full Yjs state of the block (export). */
  content: (pageId: string, syncedId: string) => call<PageContentResponse>('GET', apiPath`/pages/${pageId}/synced-blocks/${syncedId}/content`),
  /** Published page `pageId` showing a published synced block (anonymous visitors). */
  publicInfo: (pageId: string, syncedId: string) => call<SyncedBlockInfo>('GET', apiPath`/public/pages/${pageId}/synced-blocks/${syncedId}`),
};

export const syncedQueryKey = (pageId: string, syncedId: string, isPublic: boolean) => ['syncedBlock', isPublic ? 'public' : 'app', pageId, syncedId] as const;
