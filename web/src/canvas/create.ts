// Creation of a canvas page (H1): same request as a page, with `layout: 'canvas'`.
import { newId, type ParentType, type Visibility } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { toast } from '../lib/ui';
import { appNavigate, pagePath } from '../lib/util';

export async function createCanvasPage(opts: {
  workspaceId: string;
  parentType: Extract<ParentType, 'workspace' | 'page'>;
  parentId: string;
  visibility?: Visibility;
  title?: string;
  /** Navigate to the canvas (default true). */
  open?: boolean;
}) {
  try {
    const page = await api.pages.create(opts.workspaceId, {
      id: newId(),
      parentType: opts.parentType,
      parentId: opts.parentId,
      title: opts.title,
      visibility: opts.parentType === 'workspace' ? (opts.visibility ?? 'workspace') : undefined,
      layout: 'canvas',
    });
    if (opts.open !== false) appNavigate(pagePath(opts.workspaceId, page.id));
    return page;
  } catch (e) {
    toast.error(errorMessage(e, 'Impossible de créer le canevas.'));
    throw e;
  } finally {
    void queryClient.invalidateQueries({ queryKey: qk.tree(opts.workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.recent(opts.workspaceId) });
  }
}
