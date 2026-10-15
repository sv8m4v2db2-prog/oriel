// Page actions shared by the sidebar, top bar, editor and settings (optimistic where useful).
import {
  newId,
  positionForInsert,
  type FavoritesResponse,
  type PageDetailResponse,
  type PageKind,
  type ParentType,
  type TreeNode,
  type TreeResponse,
  type UpdatePageRequest,
  type Visibility,
} from '@oriel/shared';
import { api } from './api';
import { qk } from './queryKeys';
import { queryClient, errorMessage } from './queryClient';
import { buildTreeIndex, childKey, descendantIds } from './tree';
import { toast } from './ui';
import { appNavigate, copyToClipboard, pagePath, pickFile } from './util';
import { navigation } from './navigation';
import { normalizeMarkdownFences } from '../editor/codeLanguages';

// --- Cache helpers ----------------------------------------------------------------

function patchTree(workspaceId: string, fn: (nodes: TreeNode[]) => TreeNode[]) {
  queryClient.setQueryData<TreeResponse>(qk.tree(workspaceId), (old) => (old ? { nodes: fn(old.nodes) } : old));
}

function patchPageDetail(pageId: string, patch: Partial<PageDetailResponse['page']>) {
  queryClient.setQueryData<PageDetailResponse>(qk.page(pageId), (old) =>
    old ? { ...old, page: { ...old.page, ...patch } } : old,
  );
}

async function snapshotQueries(keys: ReadonlyArray<readonly unknown[]>) {
  await Promise.all(keys.map((k) => queryClient.cancelQueries({ queryKey: k })));
  return keys.map((k) => [k, queryClient.getQueryData(k)] as const);
}

function restoreQueries(saved: ReadonlyArray<readonly [readonly unknown[], unknown]>) {
  for (const [k, v] of saved) queryClient.setQueryData(k, v);
}

// --- Pending Markdown imports (applied by the editor once the document is synced) -------

const pendingImports = new Map<string, string>();
export const takePendingImport = (pageId: string) => {
  const md = pendingImports.get(pageId);
  pendingImports.delete(pageId);
  return md;
};
export const hasPendingImport = (pageId: string) => pendingImports.has(pageId);

// --- Create -----------------------------------------------------------------------

export interface CreatePageOptions {
  workspaceId: string;
  parentType: ParentType;
  parentId: string;
  visibility?: Visibility;
  kind?: PageKind;
  title?: string;
  after?: string | null;
  isInline?: boolean;
  /** Navigate to the new page (default true). */
  open?: boolean;
  /** Focus the title after navigation (default true). */
  focusTitle?: boolean;
}

/** Page id whose title should get focus on next mount. */
export let titleFocusRequest: string | null = null;
export const consumeTitleFocus = (pageId: string) => {
  if (titleFocusRequest === pageId) {
    titleFocusRequest = null;
    return true;
  }
  return false;
};

export async function createPage(opts: CreatePageOptions) {
  const id = newId();
  const kind = opts.kind ?? 'page';
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(opts.workspaceId));
  let visibility: Visibility = opts.visibility ?? 'workspace';
  if (opts.parentType === 'page' && tree) {
    const parent = tree.nodes.find((n) => n.id === opts.parentId);
    if (parent) visibility = parent.visibility;
  }
  if (tree && opts.parentType !== 'database') {
    const index = buildTreeIndex(tree.nodes);
    const siblings = (index.children.get(childKey(opts.parentType, opts.parentId)) ?? []).filter(
      (n) => opts.parentType !== 'workspace' || n.visibility === visibility,
    );
    const node: TreeNode = {
      id,
      parentType: opts.parentType,
      parentId: opts.parentId,
      kind,
      title: opts.title ?? '',
      icon: null,
      position: positionForInsert(siblings, opts.after),
      visibility,
      isInline: !!opts.isInline,
    };
    patchTree(opts.workspaceId, (nodes) => [...nodes, node]);
  }
  try {
    const page = await api.pages.create(opts.workspaceId, {
      id,
      parentType: opts.parentType,
      parentId: opts.parentId,
      kind,
      title: opts.title,
      visibility: opts.parentType === 'workspace' ? visibility : undefined,
      after: opts.after,
      isInline: opts.isInline,
    });
    // Navigate once the page exists on the server (the page view fetches it right away).
    if (opts.open !== false) {
      if (opts.focusTitle !== false) titleFocusRequest = id;
      appNavigate(pagePath(opts.workspaceId, id));
    }
    return page;
  } catch (e) {
    patchTree(opts.workspaceId, (nodes) => nodes.filter((n) => n.id !== id));
    toast.error(errorMessage(e, 'Impossible de créer la page.'));
    throw e;
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.tree(opts.workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.recent(opts.workspaceId) });
  }
}

// --- Update -----------------------------------------------------------------------

export async function updatePage(workspaceId: string | null, pageId: string, body: UpdatePageRequest) {
  const keys: Array<readonly unknown[]> = [qk.page(pageId)];
  if (workspaceId) keys.push(qk.tree(workspaceId));
  const saved = await snapshotQueries(keys);
  const { format, ...rest } = body;
  const old = queryClient.getQueryData<PageDetailResponse>(qk.page(pageId));
  patchPageDetail(pageId, {
    ...(rest as Partial<PageDetailResponse['page']>),
    ...(format && old ? { format: { ...old.page.format, ...format } } : {}),
    ...(body.properties && old ? { properties: { ...old.page.properties, ...body.properties } } : {}),
  });
  if (workspaceId && (body.title !== undefined || body.icon !== undefined)) {
    patchTree(workspaceId, (nodes) =>
      nodes.map((n) =>
        n.id === pageId
          ? { ...n, ...(body.title !== undefined ? { title: body.title } : {}), ...(body.icon !== undefined ? { icon: body.icon } : {}) }
          : n,
      ),
    );
  }
  try {
    const page = await api.pages.update(pageId, body);
    queryClient.setQueryData<PageDetailResponse>(qk.page(pageId), (o) => (o ? { ...o, page } : o));
    return page;
  } catch (e) {
    restoreQueries(saved);
    toast.error(errorMessage(e, 'Modification impossible.'));
    throw e;
  }
}

// --- Move -------------------------------------------------------------------------

export interface MoveTarget {
  parentType: ParentType;
  parentId: string;
  after?: string | null;
  visibility?: Visibility;
  /** Navigation module: the user confirmed a move that widens access across teamspaces. */
  confirmAccess?: boolean;
}

export async function movePage(workspaceId: string, pageId: string, target: MoveTarget) {
  const saved = await snapshotQueries([qk.tree(workspaceId)]);
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  if (tree) {
    const index = buildTreeIndex(tree.nodes);
    let visibility: Visibility = target.visibility ?? index.byId.get(pageId)?.visibility ?? 'workspace';
    if (target.parentType === 'page') visibility = index.byId.get(target.parentId)?.visibility ?? visibility;
    const siblings = (index.children.get(childKey(target.parentType, target.parentId)) ?? []).filter(
      (n) => target.parentType !== 'workspace' || n.visibility === visibility,
    );
    const position = positionForInsert(siblings, target.after, pageId);
    const subtree = descendantIds(index, pageId);
    patchTree(workspaceId, (nodes) =>
      nodes.map((n) => {
        if (n.id === pageId) return { ...n, parentType: target.parentType, parentId: target.parentId, position, visibility };
        if (subtree.has(n.id)) return { ...n, visibility };
        return n;
      }),
    );
  }
  try {
    await api.pages.move(pageId, {
      parentType: target.parentType,
      parentId: target.parentId,
      after: target.after,
      // A closed/private teamspace root keeps its access (never sent: 'teamspace' is server-derived).
      visibility:
        target.parentType === 'workspace' && target.visibility !== 'teamspace'
          ? (target.visibility ?? (tree && buildTreeIndex(tree.nodes).byId.get(pageId)?.visibility === 'teamspace' ? undefined : 'workspace'))
          : undefined,
      ...(target.confirmAccess ? { confirmAccess: true } : {}),
    });
  } catch (e) {
    restoreQueries(saved);
    toast.error(errorMessage(e, 'Déplacement impossible.'));
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.page(pageId) });
  }
}

// --- Duplicate / trash / restore ------------------------------------------------------

export async function duplicatePage(workspaceId: string, pageId: string, open = true) {
  try {
    const copy = await api.pages.duplicate(pageId);
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    toast.success('Page dupliquée');
    if (open) appNavigate(pagePath(workspaceId, copy.id));
    return copy;
  } catch (e) {
    toast.error(errorMessage(e, 'Duplication impossible.'));
    return null;
  }
}

export async function trashPage(workspaceId: string, pageId: string) {
  const saved = await snapshotQueries([qk.tree(workspaceId), qk.favorites(workspaceId)]);
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  if (tree) {
    const index = buildTreeIndex(tree.nodes);
    const removed = descendantIds(index, pageId);
    removed.add(pageId);
    patchTree(workspaceId, (nodes) => nodes.filter((n) => !removed.has(n.id)));
    queryClient.setQueryData<FavoritesResponse>(qk.favorites(workspaceId), (old) =>
      old ? { favorites: old.favorites.filter((f) => !removed.has(f.id)) } : old,
    );
  }
  if (navigation.getState().peekPageId === pageId) navigation.closePeek();
  try {
    await api.pages.trash(pageId);
    toast('Page déplacée dans la corbeille', {
      action: { label: 'Annuler', onClick: () => void restorePage(workspaceId, pageId) },
      duration: 6000,
    });
  } catch (e) {
    restoreQueries(saved);
    toast.error(errorMessage(e, 'Suppression impossible.'));
  } finally {
    for (const key of [qk.tree(workspaceId), qk.trash(workspaceId), qk.page(pageId), qk.recent(workspaceId), qk.favorites(workspaceId)])
      void queryClient.invalidateQueries({ queryKey: key });
  }
}

export async function restorePage(workspaceId: string, pageId: string) {
  try {
    await api.pages.restore(pageId);
    toast.success('Page restaurée');
  } catch (e) {
    toast.error(errorMessage(e, 'Restauration impossible.'));
  } finally {
    for (const key of [qk.tree(workspaceId), qk.trash(workspaceId), qk.page(pageId), qk.recent(workspaceId), qk.favorites(workspaceId)])
      void queryClient.invalidateQueries({ queryKey: key });
  }
}

export async function destroyPage(workspaceId: string, pageId: string) {
  try {
    await api.pages.destroy(pageId);
    toast.success('Page supprimée définitivement');
    queryClient.removeQueries({ queryKey: qk.page(pageId) });
  } catch (e) {
    toast.error(errorMessage(e, 'Suppression impossible.'));
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.trash(workspaceId) });
  }
}

// --- Favorites ------------------------------------------------------------------------

export async function setFavorite(workspaceId: string, pageId: string, favorite: boolean, after?: string | null) {
  const saved = await snapshotQueries([qk.favorites(workspaceId), qk.page(pageId)]);
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  const node = tree?.nodes.find((n) => n.id === pageId);
  queryClient.setQueryData<FavoritesResponse>(qk.favorites(workspaceId), (old) => {
    if (!old) return old;
    const list = old.favorites.filter((f) => f.id !== pageId);
    if (!favorite) return { favorites: list };
    const item = old.favorites.find((f) => f.id === pageId) ?? node;
    if (!item) return old;
    if (after === undefined) return { favorites: [...list, item] };
    if (after === null) return { favorites: [item, ...list] };
    const idx = list.findIndex((f) => f.id === after);
    list.splice(idx + 1, 0, item);
    return { favorites: list };
  });
  queryClient.setQueryData<PageDetailResponse>(qk.page(pageId), (old) => (old ? { ...old, isFavorite: favorite } : old));
  try {
    await api.pages.favorite(pageId, { favorite, after });
  } catch (e) {
    restoreQueries(saved);
    toast.error(errorMessage(e, 'Impossible de modifier les favoris.'));
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.favorites(workspaceId) });
  }
}

// --- Misc -----------------------------------------------------------------------------

export async function copyPageLink(workspaceId: string, pageId: string) {
  const ok = await copyToClipboard(`${location.origin}${pagePath(workspaceId, pageId)}`);
  if (ok) toast.success('Lien copié');
  else toast.error('Copie impossible');
}

/** Pick a .md file and import it as a new page under the given parent. */
export async function importMarkdown(opts: {
  workspaceId: string;
  parentType: ParentType;
  parentId: string;
  visibility?: Visibility;
}) {
  const file = await pickFile('.md,.markdown,text/markdown,text/plain');
  if (!file) return;
  let text: string;
  try {
    text = await file.text();
  } catch {
    toast.error('Lecture du fichier impossible.');
    return;
  }
  // Code fences with language aliases (```js, ```sh…) are mapped to the editor's language keys.
  text = normalizeMarkdownFences(text.replace(/^﻿/, ''));
  let title = file.name.replace(/\.(md|markdown|txt)$/i, '');
  const lines = text.split(/\r?\n/);
  const firstContent = lines.findIndex((l) => l.trim() !== '');
  const match = firstContent >= 0 ? /^#\s+(.+?)\s*#*\s*$/.exec(lines[firstContent]!) : null;
  if (match) {
    title = match[1]!.trim();
    lines.splice(firstContent, 1);
    text = lines.join('\n');
  }
  try {
    await createPageWithContent(opts, title.slice(0, 2000), text);
    toast.success('Import terminé');
  } catch {
    /* toast already shown */
  }
}

async function createPageWithContent(
  opts: { workspaceId: string; parentType: ParentType; parentId: string; visibility?: Visibility },
  title: string,
  markdown: string,
) {
  const id = newId();
  pendingImports.set(id, markdown);
  try {
    const page = await api.pages.create(opts.workspaceId, {
      id,
      parentType: opts.parentType,
      parentId: opts.parentId,
      title,
      visibility: opts.parentType === 'workspace' ? (opts.visibility ?? 'workspace') : undefined,
    });
    void queryClient.invalidateQueries({ queryKey: qk.tree(opts.workspaceId) });
    appNavigate(pagePath(opts.workspaceId, id));
    return page;
  } catch (e) {
    pendingImports.delete(id);
    toast.error(errorMessage(e, 'Import impossible.'));
    throw e;
  }
}
