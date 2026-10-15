// HTTP client for the editor module's endpoints (server/src/routes/editor.ts).
import type { ApiErrorBody, InstantiateTemplateRequest, LinkPreview, Page, PageDetailResponse, SetTemplateRequest, TreeNode } from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath, queryString } from '../lib/apiPath';

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
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

export const editorApi = {
  linkPreview: (url: string) => call<LinkPreview>('GET', '/link-preview' + queryString({ url })),
  setTemplate: (pageId: string, body: SetTemplateRequest) => call<Page>('PUT', apiPath`/pages/${pageId}/template`, body),
  instantiate: (templateId: string, body: InstantiateTemplateRequest) => call<Page>('POST', apiPath`/pages/${templateId}/instantiate`, body),
  templates: (workspaceId: string) => call<{ templates: TreeNode[] }>('GET', apiPath`/workspaces/${workspaceId}/templates`),
  /** Page detail without recording a visit (labels of links to pages that are not in the tree, e.g. database rows). */
  pageInfo: (pageId: string) => call<PageDetailResponse>('GET', apiPath`/pages/${pageId}?visit=0`),
};
