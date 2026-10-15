// Editor contributions of the canvas module (H1), plugged through editor/extensions.ts:
//  - block `canvasFrame`: a frame (or the whole canvas) shown read-only in a page, kept live;
//  - slash items « Sous-page canevas » and « Cadre de canevas ».
// Light module: the view itself (Yjs document, renderers) loads on demand.
import { lazy, Suspense } from 'react';
import { createReactBlockSpec, type DefaultReactSuggestionItem } from '@blocknote/react';
import { Frame, Presentation } from 'lucide-react';
import { CANVAS_ID_RE, EDITOR_TYPES } from '@oriel/shared';
import { ErrorBoundary } from '../components/common';
import { useEditorEnv } from '../editor/env';
import { getEditor } from '../editor/registry';
import { navigation } from '../lib/navigation';
import { createCanvasPage } from './create';

export const CANVAS_FRAME_BLOCK = 'canvasFrame';
const PAGE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const FrameBlockView = lazy(() => import('./FrameBlock'));

/** Blocks inserted by the slash menu that open the canvas picker once mounted. */
export const pendingCanvasPick = new Set<string>();

function CanvasFrame({ blockId, pageId, frameId, update }: { blockId: string; pageId: string; frameId: string; update: (p: { pageId?: string; frameId?: string }) => void }) {
  const env = useEditorEnv();
  // Bounded props (like withSafeProps): anything else is treated as empty.
  const safePage = PAGE_ID_RE.test(pageId) ? pageId : '';
  const safeFrame = CANVAS_ID_RE.test(frameId) ? frameId : '';
  return (
    <div className="or-cv-block-host" contentEditable={false} data-canvas-page={safePage || undefined}>
      <ErrorBoundary resetKey={`${safePage}:${safeFrame}`} fallback={() => <div className="or-cv-block-empty">Le cadre n’a pas pu s’afficher.</div>}>
        <Suspense fallback={<div className="or-cv-block-empty">Chargement du cadre…</div>}>
          <FrameBlockView
            blockId={blockId}
            pageId={safePage}
            frameId={safeFrame}
            canEdit={env.canEdit && env.mode === 'app'}
            publicMode={env.mode === 'public'}
            workspaceId={env.workspaceId}
            hostPageId={env.pageId}
            update={update}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export const CanvasFrameBlock = createReactBlockSpec(
  {
    type: CANVAS_FRAME_BLOCK,
    propSchema: { pageId: { default: '' }, frameId: { default: '' } },
    content: 'none',
  },
  {
    meta: { selectable: true },
    render: ({ block, editor }) => (
      <CanvasFrame
        blockId={block.id}
        pageId={block.props.pageId}
        frameId={block.props.frameId}
        update={(props) => {
          const current = editor.getBlock(block.id);
          if (current) editor.updateBlock(current, { props: { ...current.props, ...props } } as never);
        }}
      />
    ),
    toExternalHTML: () => (
      <p>
        <em>Cadre de canevas</em>
      </p>
    ),
  },
);

export const canvasBlockSpecs = {
  [CANVAS_FRAME_BLOCK]: CanvasFrameBlock(),
};

interface SlashEditor {
  getTextCursorPosition(): { block: { id: string; type: string; content?: unknown; children?: unknown[] } };
  replaceBlocks(toReplace: unknown[], blocks: unknown[]): { insertedBlocks: Array<{ id: string }> };
  insertBlocks(blocks: unknown[], ref: unknown, placement: 'before' | 'after'): Array<{ id: string }>;
  getBlock(id: string): { id: string; type: string; content?: unknown; children?: unknown[] } | undefined;
  document: Array<{ id: string }>;
}

const isEmptyParagraph = (b: { type: string; content?: unknown; children?: unknown[] }) =>
  b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 0 && (!b.children || b.children.length === 0);

/** Page whose editor is `editor` (main view or side panel). */
function hostPageId(editor: unknown): string | null {
  const fromPath = /\/p\/([^/?#]+)/.exec(window.location.pathname)?.[1];
  const candidates = [navigation.getState().peekPageId, fromPath ? decodeURIComponent(fromPath) : null];
  return candidates.find((id): id is string => !!id && getEditor(id) === editor) ?? null;
}

function insertBlock(ed: SlashEditor, block: unknown, refId: string): string | null {
  const ref = ed.getBlock(refId);
  if (ref && isEmptyParagraph(ref)) return ed.replaceBlocks([ref], [block]).insertedBlocks[0]?.id ?? null;
  if (ref) return ed.insertBlocks([block], ref, 'after')[0]?.id ?? null;
  const last = ed.document[ed.document.length - 1];
  return last ? (ed.insertBlocks([block], last, 'after')[0]?.id ?? null) : null;
}

export function canvasSlashItems(editor: unknown, ctx: { workspaceId: string | null; canEdit?: boolean }): DefaultReactSuggestionItem[] {
  if (!ctx.workspaceId || ctx.canEdit === false) return [];
  const ed = editor as SlashEditor;
  const workspaceId = ctx.workspaceId;
  return [
    {
      title: 'Sous-page canevas',
      subtext: 'Crée un tableau blanc dans une sous-page et insère un lien vers lui',
      aliases: ['canevas', 'tableau blanc', 'whiteboard', 'canvas', 'storyboard', 'moodboard', 'carte mentale', 'sous-page canevas'],
      group: 'Pages et bases',
      icon: <Presentation size={18} />,
      onItemClick: () => {
        const parentId = hostPageId(editor);
        if (!parentId) return;
        const refId = ed.getTextCursorPosition().block.id;
        void createCanvasPage({ workspaceId, parentType: 'page', parentId, open: false })
          .then((page) => insertBlock(ed, { type: EDITOR_TYPES.subpage, props: { pageId: page.id } }, refId))
          .catch(() => undefined);
      },
    },
    {
      title: 'Cadre de canevas',
      subtext: 'Affiche un cadre d’un canevas, à jour en temps réel',
      aliases: ['cadre', 'canevas', 'frame', 'tableau blanc', 'diapositive'],
      group: 'Pages et bases',
      icon: <Frame size={18} />,
      onItemClick: () => {
        const id = insertBlock(ed, { type: CANVAS_FRAME_BLOCK, props: { pageId: '', frameId: '' } }, ed.getTextCursorPosition().block.id);
        if (id) pendingCanvasPick.add(id);
      },
    },
  ];
}
