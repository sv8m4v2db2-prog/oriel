// HTTP client of the database module's extra routes (contract: shared/src/api.ts):
// feed previews, address search, forms (public definition, submissions), map tiles.
import type {
  ApiErrorBody,
  GeocodeResponse,
  MapConfigResponse,
  PublicFormResponse,
  PublicFormsResponse,
  RowPreviewsResponse,
  SubmitFormRequest,
  View,
} from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath, queryString } from '../lib/apiPath';

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { anonymous?: boolean } = {}): Promise<T> {
  assertApiPath(path);
  // Public form answers are anonymous: no session cookie is sent (the server ignores it anyway).
  const init: RequestInit = { method, credentials: opts.anonymous ? 'omit' : 'same-origin', headers: {} };
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

export const dbExtrasApi = {
  previews: (did: string, ids: string[], lines: number, publicMode: boolean) =>
    request<RowPreviewsResponse>(
      'GET',
      (publicMode ? apiPath`/public/databases/${did}/previews` : apiPath`/databases/${did}/previews`) + queryString({ ids: ids.join(','), lines }),
    ),
  geocode: (wid: string, q: string) => request<GeocodeResponse>('GET', apiPath`/workspaces/${wid}/geocode` + queryString({ q })),
  submitForm: (vid: string, body: SubmitFormRequest) => request<{ ok: true }>('POST', apiPath`/forms/${vid}/submit`, body),
  /** Definition of a form open to people without an account (its database need not be published). */
  publicForm: (vid: string) => request<PublicFormResponse>('GET', apiPath`/public/forms/${vid}`, undefined, { anonymous: true }),
  submitPublicForm: (vid: string, body: SubmitFormRequest) =>
    request<{ ok: true }>('POST', apiPath`/public/forms/${vid}/submit`, body, { anonymous: true }),
  mapConfig: () => request<MapConfigResponse>('GET', '/public/map-config'),
  /** Every public form of a database, linked block views included (QA-VIEW-05). */
  publicForms: (did: string) => request<PublicFormsResponse>('GET', apiPath`/databases/${did}/public-forms`),
  closePublicForm: (vid: string) => request<View>('POST', apiPath`/views/${vid}/close-public-form`),
};
