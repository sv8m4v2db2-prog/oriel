// Page templates (client side): mark/unmark, list, instantiate.
import type { InstantiateTemplateRequest, Page, TreeNode, TreeResponse } from '@oriel/shared';
import { qk } from '../lib/queryKeys';
import { errorMessage, queryClient } from '../lib/queryClient';
import { openPagePicker, toast } from '../lib/ui';
import { appNavigate, pagePath, pageTitle } from '../lib/util';
import { editorApi } from './editorApi';

/** Templates visible in the cached sidebar tree, sorted by title. */
export function templateNodes(workspaceId: string): TreeNode[] {
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  return (tree?.nodes ?? [])
    .filter((n) => n.isTemplate)
    .sort((a, b) => pageTitle(a.title).localeCompare(pageTitle(b.title), 'fr'));
}

export async function setPageTemplate(workspaceId: string, pageId: string, isTemplate: boolean): Promise<void> {
  // Optimistic: move the page to / out of the "Modèles" section right away.
  queryClient.setQueryData<TreeResponse>(qk.tree(workspaceId), (old) =>
    old
      ? {
          nodes: old.nodes.map((n) => {
            if (n.id !== pageId) return n;
            const { isTemplate: _old, ...rest } = n;
            return isTemplate ? { ...rest, isTemplate: true } : rest;
          }),
        }
      : old,
  );
  try {
    await editorApi.setTemplate(pageId, { isTemplate });
    toast.success(isTemplate ? 'La page est maintenant un modèle' : 'La page n’est plus un modèle');
  } catch (e) {
    toast.error(errorMessage(e, 'Modification impossible.'));
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.recent(workspaceId) });
  }
}

export async function instantiateTemplate(
  workspaceId: string,
  templateId: string,
  target: InstantiateTemplateRequest,
  opts: { open?: boolean } = {},
): Promise<Page | null> {
  try {
    const page = await editorApi.instantiate(templateId, target);
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    if (opts.open !== false) appNavigate(pagePath(workspaceId, page.id));
    return page;
  } catch (e) {
    toast.error(errorMessage(e, 'Impossible de créer la page depuis ce modèle.'));
    return null;
  }
}

/** "Depuis un modèle…": pick a template, then create the page at `target`. */
export function openTemplatePicker(workspaceId: string, target: InstantiateTemplateRequest): void {
  const templates = templateNodes(workspaceId);
  if (templates.length === 0) {
    toast('Aucun modèle pour l’instant : ouvrez une page, menu « … » › « Utiliser comme modèle ».');
    return;
  }
  const ids = new Set(templates.map((t) => t.id));
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  openPagePicker({
    title: 'Nouvelle page depuis un modèle',
    // The picker lists tree pages: exclude everything that is not a template.
    exclude: new Set((tree?.nodes ?? []).filter((n) => !ids.has(n.id)).map((n) => n.id)),
    onPick: (picked) => {
      if (picked.kind === 'page') void instantiateTemplate(workspaceId, picked.id, target);
    },
  });
}
