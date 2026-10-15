// HTTP client of the MCP module: personal API tokens (contract: shared/src/apiTokens.ts).
import type { ApiErrorBody, ApiTokensResponse, CreateApiTokenRequest, CreatedApiToken } from '@oriel/shared';
import { ApiError, assertApiPath, recoverApiError } from '../lib/api';
import { apiPath } from '../lib/apiPath';

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, retried = false): Promise<T> {
  assertApiPath(path); // QA-WEB-12: a `.` / `..` id never reaches another route.
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
    const error = new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur ${res.status}`);
    // Token creation / revocation may ask the user to confirm their identity first (G9, A06).
    if (!retried && (await recoverApiError(error))) return request<T>(method, path, body, true);
    throw error;
  }
  return data as T;
}

export const tokensApi = {
  list: () => request<ApiTokensResponse>('GET', '/me/tokens'),
  create: (body: CreateApiTokenRequest) => request<CreatedApiToken>('POST', '/me/tokens', body),
  revoke: (id: string) => request<{ ok: true }>('DELETE', apiPath`/me/tokens/${id}`),
};

export const mcpKeys = {
  tokens: ['mcp', 'tokens'] as const,
};
