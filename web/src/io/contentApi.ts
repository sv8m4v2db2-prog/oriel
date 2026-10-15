// HTTP calls of the import/export module that are not part of the shared API client.
import type { PageContentResponse, PutPageContentRequest, PutPageContentResponse } from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath } from '../lib/apiPath';

async function request<T>(method: 'GET' | 'PUT', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin', headers: {}, signal };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
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
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur ${res.status}`);
  }
  return data as T;
}

export const contentApi = {
  /** Full Yjs state of a page (base64). */
  get: (pageId: string, signal?: AbortSignal) => request<PageContentResponse>('GET', apiPath`/pages/${pageId}/content`, undefined, signal),
  /** Writes blocks into a page through the collaboration server (live for connected editors). */
  put: (pageId: string, body: PutPageContentRequest, signal?: AbortSignal) =>
    request<PutPageContentResponse>('PUT', apiPath`/pages/${pageId}/content`, body, signal),
};

/** Downloads an uploaded file (same-origin `/api/files/…` URL or any CORS-enabled URL). */
export async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  // The URL comes from the content: `/api/files/../../workspaces/…` must not reach another route.
  assertApiPath(url);
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new ApiError(res.status, 'http_error', `Téléchargement impossible (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}
