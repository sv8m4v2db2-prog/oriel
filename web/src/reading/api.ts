// HTTP client of the reading module (contract: shared/src/reading.ts, SPEC §13).
import type { PageActivityResponse, PagePreviewResponse, ThreadsResponse } from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath } from '../lib/apiPath';

async function get<T>(path: string): Promise<T> {
  assertApiPath(path);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'GET', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Serveur injoignable.');
  }
  if (!res.ok) throw new ApiError(res.status, 'http_error', `Erreur ${res.status}`);
  return (await res.json()) as T;
}

export const readingApi = {
  preview: (pageId: string) => get<PagePreviewResponse>(apiPath`/pages/${pageId}/preview`),
  activity: (pageId: string) => get<PageActivityResponse>(apiPath`/pages/${pageId}/activity`),
  threads: (pageId: string) => get<ThreadsResponse>(apiPath`/pages/${pageId}/threads`),
};

export const readingKeys = {
  preview: (pageId: string) => ['reading-preview', pageId] as const,
  activity: (pageId: string, version: number) => ['reading-activity', pageId, version] as const,
  threads: (pageId: string) => ['reading-threads', pageId] as const,
};
