// HTTP client of the AI module (contract: shared/src/ai.ts).
import type {
  AiBrief,
  AiBriefsResponse,
  AiInstanceStatus,
  AiKeyStatus,
  AiLatestBriefResponse,
  AiSettingsResponse,
  AiUsageResponse,
  ApiErrorBody,
  StartBriefResponse,
  UpdateAiInstanceRequest,
  UpdateAiSettingsRequest,
} from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath, queryString } from '../lib/apiPath';

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
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

export const aiApi = {
  settings: (wid: string) => request<AiSettingsResponse>('GET', apiPath`/workspaces/${wid}/ai/settings`),
  updateSettings: (wid: string, body: UpdateAiSettingsRequest) => request<AiSettingsResponse>('PUT', apiPath`/workspaces/${wid}/ai/settings`, body),
  instance: () => request<AiInstanceStatus>('GET', '/admin/ai'),
  updateInstance: (body: UpdateAiInstanceRequest) => request<AiInstanceStatus>('PUT', '/admin/ai', body),
  saveKey: (apiKey: string) => request<AiKeyStatus>('PUT', '/admin/ai/key', { apiKey }),
  deleteKey: () => request<AiKeyStatus>('DELETE', '/admin/ai/key'),
  start: (wid: string) => request<StartBriefResponse>('POST', apiPath`/workspaces/${wid}/ai/briefs`),
  history: (wid: string, limit = 30) => request<AiBriefsResponse>('GET', apiPath`/workspaces/${wid}/ai/briefs` + queryString({ limit })),
  latest: (wid: string) => request<AiLatestBriefResponse>('GET', apiPath`/workspaces/${wid}/ai/briefs/latest`),
  brief: (id: string) => request<AiBrief>('GET', apiPath`/ai/briefs/${id}`),
  usage: (wid: string) => request<AiUsageResponse>('GET', apiPath`/workspaces/${wid}/ai/usage`),
};
