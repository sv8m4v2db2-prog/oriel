// HTTP client of the version history module (G6; contract: shared/src/api.ts).
import type {
  ApiErrorBody,
  DeletedBlocksResponse,
  HistoryPropertiesResponse,
  PageContentResponse,
  RestoreBlockItem,
  RestoreBlocksResponse,
  RestoreSnapshotResponse,
} from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath, queryString } from '../lib/apiPath';

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
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

export const historyApi = {
  /** Current content (live state), the newer side of a « compare with now ». */
  current: (pid: string) => request<PageContentResponse>('GET', apiPath`/pages/${pid}/content`),
  restore: (pid: string, sid: string) => request<RestoreSnapshotResponse>('POST', apiPath`/pages/${pid}/snapshots/${sid}/restore`),
  restoreBlocks: (pid: string, sid: string, items: RestoreBlockItem[]) =>
    request<RestoreBlocksResponse>('POST', apiPath`/pages/${pid}/snapshots/${sid}/restore-blocks`, { items }),
  deleted: (pid: string) => request<DeletedBlocksResponse>('GET', apiPath`/pages/${pid}/history/deleted`),
  properties: (pid: string, at?: number) =>
    request<HistoryPropertiesResponse>('GET', apiPath`/pages/${pid}/history/properties` + (at === undefined ? '' : queryString({ at }))),
};

export const historyKeys = {
  deleted: (pid: string) => ['history', 'deleted', pid] as const,
  properties: (pid: string, at: number | 'now') => ['history', 'properties', pid, at] as const,
  current: (pid: string) => ['history', 'current', pid] as const,
};
