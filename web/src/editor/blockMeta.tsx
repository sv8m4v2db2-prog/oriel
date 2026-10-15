// Block metadata on hover of the block handle (H5): who created and last modified the block, and when.
// Data comes from GET /api/pages/:pid/blocks/:bid/meta (server-side, outside the document), fetched on
// hover only, cached briefly. Nothing is shown to public visitors (they have no side menu).
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { AddBlockButton, DragHandleButton, SideMenu, useBlockNoteEditor, useExtensionState, type SideMenuProps } from '@blocknote/react';
import { SideMenuExtension } from '@blocknote/core/extensions';
import { BLOCK_ID_PATTERN, type BlockMeta } from '@oriel/shared';
import { ApiError, assertApiPath } from '../lib/api';
import { apiPath } from '../lib/apiPath';
import { useEditorEnv } from './env';
import { describeBlockMeta } from './blockMetaLogic';
import { OrielDragHandleMenu } from './menus';

async function fetchBlockMeta(pageId: string, blockId: string): Promise<BlockMeta> {
  const path = apiPath`/pages/${pageId}/blocks/${blockId}/meta`;
  assertApiPath(path);
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'http_error', `Erreur ${res.status}`);
  return (await res.json()) as BlockMeta;
}

/** Metadata of a block (enabled while `enabled`), short-lived cache so that a hover is cheap. */
export function useBlockMeta(pageId: string, blockId: string | undefined, enabled: boolean) {
  const valid = !!blockId && BLOCK_ID_PATTERN.test(blockId);
  return useQuery({
    queryKey: ['block-meta', pageId, blockId ?? ''],
    queryFn: () => fetchBlockMeta(pageId, blockId!),
    enabled: enabled && valid && !!pageId,
    staleTime: 5_000,
    gcTime: 30_000,
    retry: false,
  });
}

function MetaCard({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  // In the body: the side menu is positioned with a CSS transform, which would make `fixed` relative to it.
  return createPortal(
    <div className="or-block-meta" role="tooltip" style={{ left: x, top: y }}>
      {children}
    </div>,
    document.body,
  );
}

/** The drag handle, with the metadata card shown while the pointer rests on it. */
function HandleWithMeta(props: SideMenuProps) {
  const env = useEditorEnv();
  const editor = useBlockNoteEditor<any, any, any>();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const query = useBlockMeta(env.pageId, block?.id, hover && env.mode === 'app');
  const rect = hover ? ref.current?.getBoundingClientRect() : undefined;
  const lines = describeBlockMeta(query.data);
  return (
    <span ref={ref} className="or-block-meta__anchor" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <DragHandleButton {...props} dragHandleMenu={OrielDragHandleMenu} />
      {hover && rect && env.mode === 'app' && query.isSuccess && (
        <MetaCard x={rect.right + 8} y={rect.top}>
          <div>{lines.created}</div>
          {lines.modified && <div>{lines.modified}</div>}
        </MetaCard>
      )}
    </span>
  );
}

/** Side menu of the editor: « + » and the handle with its metadata card. */
export function OrielSideMenu(props: SideMenuProps) {
  return (
    <SideMenu {...props}>
      <AddBlockButton />
      <HandleWithMeta {...props} />
    </SideMenu>
  );
}
