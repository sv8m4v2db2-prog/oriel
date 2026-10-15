// Context shared by custom editor blocks (they are rendered inside BlockNote's React tree).
import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Page, PageDetailResponse, PageKind, RowsResponse, TreeNode } from '@oriel/shared';
import { queryClient } from '../lib/queryClient';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { useTree } from '../lib/tree';
import { appNavigate, pagePath, sharePath } from '../lib/util';
import { navigation } from '../lib/navigation';
import { editorApi } from './editorApi';

export interface EditorEnv {
  mode: 'app' | 'public' | 'preview';
  workspaceId: string | null;
  /** Page whose content is being edited. */
  pageId: string;
  canEdit: boolean;
  /** Public mode: children of the shared page, used to label sub-page links without extra requests. */
  publicChildren?: Map<string, TreeNode>;
}

export const EditorEnvContext = createContext<EditorEnv>({
  mode: 'preview',
  workspaceId: null,
  pageId: '',
  canEdit: false,
});

export const useEditorEnv = () => useContext(EditorEnvContext);

export interface PageRef {
  title: string;
  icon: string | null;
  kind: PageKind;
  status: 'ok' | 'loading' | 'missing';
}

/** Live title/icon of a referenced page (tree query in the app, public API on shared pages). */
export function usePageRef(pageId: string): PageRef {
  const env = useEditorEnv();
  const isPublic = env.mode === 'public';
  const tree = useTree(isPublic ? undefined : (env.workspaceId ?? undefined));
  const fromChildren = isPublic ? env.publicChildren?.get(pageId) : undefined;
  const publicQuery = useQuery({
    queryKey: qk.publicPage(pageId),
    queryFn: () => api.public.page(pageId),
    enabled: isPublic && !!pageId && !fromChildren,
    retry: false,
    staleTime: 60_000,
  });
  // Pages that are not in the sidebar tree (database rows): fetch their detail once (not counted as a visit).
  const inTree = !isPublic && !!pageId && tree.index.byId.has(pageId);
  const cachedPage = !isPublic && pageId && !inTree ? findCachedPage(pageId) : null;
  const detailQuery = useQuery({
    queryKey: qk.page(pageId),
    queryFn: () => editorApi.pageInfo(pageId),
    enabled: !isPublic && !!pageId && !!env.workspaceId && !tree.isLoading && !inTree && !cachedPage,
    retry: false,
    staleTime: 60_000,
  });
  if (!pageId) return { title: '', icon: null, kind: 'page', status: 'missing' };
  if (isPublic) {
    if (fromChildren) return { title: fromChildren.title, icon: fromChildren.icon, kind: fromChildren.kind, status: 'ok' };
    if (publicQuery.data) {
      const p = publicQuery.data.page;
      return { title: p.title, icon: p.icon, kind: p.kind, status: 'ok' };
    }
    return { title: '', icon: null, kind: 'page', status: publicQuery.isLoading ? 'loading' : 'missing' };
  }
  const node = tree.index.byId.get(pageId);
  if (node) return { title: node.title, icon: node.icon, kind: node.kind, status: 'ok' };
  // Database rows are not in the tree: use any cached copy (opened page, loaded database rows), else the detail.
  const cached = cachedPage ?? (detailQuery.data && !detailQuery.data.page.trashedAt ? detailQuery.data.page : null);
  if (cached) return { title: cached.title, icon: cached.icon, kind: cached.kind, status: 'ok' };
  return { title: '', icon: null, kind: 'page', status: tree.isLoading || detailQuery.isLoading ? 'loading' : 'missing' };
}

function findCachedPage(pageId: string): Page | null {
  const detail = queryClient.getQueryData<PageDetailResponse>(qk.page(pageId));
  if (detail && !detail.page.trashedAt) return detail.page;
  const rowsPrefix = qk.rows('').slice(0, 1);
  for (const [, data] of queryClient.getQueriesData<RowsResponse>({ queryKey: rowsPrefix })) {
    const row = data?.rows.find((r) => r.id === pageId);
    if (row) return row;
  }
  return null;
}

export function openPageRef(env: EditorEnv, pageId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) {
  if (!pageId) return;
  if (env.mode === 'public') {
    appNavigate(sharePath(pageId));
    return;
  }
  if (!env.workspaceId) return;
  const path = pagePath(env.workspaceId, pageId);
  if (event && (event.metaKey || event.ctrlKey)) {
    window.open(path, '_blank', 'noopener');
    return;
  }
  navigation.closePeek();
  appNavigate(path);
}

export function pageRefHref(env: EditorEnv, pageId: string): string {
  if (env.mode === 'public') return sharePath(pageId);
  return env.workspaceId ? pagePath(env.workspaceId, pageId) : '#';
}
