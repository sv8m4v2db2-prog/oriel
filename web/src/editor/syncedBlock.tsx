// Synced block ("Bloc synchronisé"): blocks whose content lives in their own collaborative document
// (`synced:<id>`) and is shown, and editable, in every page that holds a reference to it.
//
// - The page where it is created owns it (server side: editor_synced_blocks); its access rules are
//   the owner page's. The block of a page only stores `syncedId`.
// - Before opening the document, the block asks the server about it *for the page showing it*: the
//   server answers only for a block of the page's workspace whose owner page the reader can see.
//   Otherwise (and when the connection is refused or revoked) the reader sees "Contenu indisponible".
// - Copy as reference: copying the block (⌘C or "Copier la référence") and pasting it in another
//   page. Unsync: the reference is replaced by a local copy of the blocks.
import { Suspense, lazy, useCallback, useContext, useEffect, useState } from 'react';
import { createReactBlockSpec, type DefaultReactSuggestionItem } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { yDocToBlocks } from '@blocknote/core/yjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Files, Lock, MoreHorizontal, RefreshCw, Unlink } from 'lucide-react';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, EDITOR_BLOCK_TYPES, isSyncedId, type SyncedBlockInfo } from '@oriel/shared';
import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/queryClient';
import { confirmDialog, toast } from '../lib/ui';
import { pageTitle } from '../lib/util';
import { propString } from '../lib/props';
import { PageIcon, Spinner } from '../components/common';
import { openContextMenu, type ContextMenuEntries } from '../components/ContextMenu';
import { openPageRef, pageRefHref, useEditorEnv, type EditorEnv } from './env';
import { syncedApi, syncedQueryKey } from './syncedApi';
import {
  SYNCED_SLASH_TITLE,
  SyncedNestingContext,
  detachedCopies,
  setSyncedSeed,
  syncedEditorOf,
  type LooseBlock,
} from './syncedLogic';
import './advancedBlocks.css';

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = { id: string; type: string; props: Record<string, unknown>; children?: unknown[] };

// Loaded on first use: it imports the editor schema, which imports this file.
const SyncedContent = lazy(() => import('./SyncedContent'));

function Unavailable({ reason }: { reason?: string }) {
  return (
    <div className="or-synced or-synced--off" contentEditable={false}>
      <Lock size={15} />
      <span>{reason ?? 'Contenu indisponible'}</span>
    </div>
  );
}

const notFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 400);

function SyncedView({ block, editor }: { block: AnyBlock; editor: AnyEditor }) {
  const env = useEditorEnv();
  const nestedIn = useContext(SyncedNestingContext);
  const queryClient = useQueryClient();
  const syncedId = propString(block.props.syncedId);
  const valid = isSyncedId(syncedId);
  const isPublic = env.mode === 'public';
  const key = syncedQueryKey(env.pageId, syncedId, isPublic);
  const info = useQuery({
    queryKey: key,
    queryFn: () => (isPublic ? syncedApi.publicInfo(env.pageId, syncedId) : syncedApi.info(env.pageId, syncedId)),
    enabled: valid && !!env.pageId && !nestedIn,
    retry: (count, e) => !notFound(e) && count < 2,
    staleTime: 30_000,
  });
  const [denied, setDenied] = useState(false);
  useEffect(() => setDenied(false), [syncedId, env.pageId]);
  const onDenied = useCallback(() => {
    setDenied(true);
    void queryClient.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, key.join('|')]);

  if (!valid) return <Unavailable />;
  if (nestedIn) return <Unavailable reason="Un bloc synchronisé ne peut pas en contenir un autre." />;
  if (info.isLoading) {
    return (
      <div className="or-synced or-synced--loading" contentEditable={false}>
        <Spinner size={14} />
      </div>
    );
  }
  if (info.isError || !info.data || denied) return <Unavailable />;
  const data = info.data;
  const isOwner = data.ownerPageId === env.pageId;
  const canEdit = env.canEdit && data.canEdit && !isPublic;

  return (
    <div className={`or-synced${isOwner ? ' or-synced--owner' : ''}`} data-synced-id={syncedId}>
      <div className="or-synced__bar" contentEditable={false}>
        <span className="or-synced__label">
          <RefreshCw size={12} /> {SYNCED_SLASH_TITLE}
        </span>
        {isOwner ? (
          <span className="or-synced__origin">Original</span>
        ) : (
          <a
            className="or-synced__origin or-synced__origin--link"
            href={pageRefHref(env, data.ownerPageId)}
            onClick={(e) => {
              e.preventDefault();
              openPageRef(env, data.ownerPageId, e);
            }}
            title="Ouvrir la page d’origine"
          >
            <PageIcon icon={data.ownerIcon} size={13} /> {pageTitle(data.ownerTitle)}
          </a>
        )}
        {!canEdit && <span className="or-synced__origin">Lecture seule</span>}
        <span className="or-synced__spacer" />
        {!isPublic && (
          <button type="button" className="or-synced__btn" onClick={(e) => openContextMenu(e, pagesMenu(env, data))} title="Pages qui affichent ce bloc">
            <Files size={13} /> {data.pages.length} {data.pages.length > 1 ? 'pages' : 'page'}
          </button>
        )}
        {!isPublic && (
          <button
            type="button"
            className="or-synced__btn"
            title="Options du bloc synchronisé"
            onClick={(e) => openContextMenu(e, actionsMenu(editor, env, block, data))}
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </div>
      <Suspense
        fallback={
          <div className="or-synced__loading" contentEditable={false}>
            <Spinner size={14} />
          </div>
        }
      >
        <SyncedContent syncedId={syncedId} hostBlockId={block.id} canEdit={canEdit} isPublic={isPublic} onDenied={onDenied} />
      </Suspense>
    </div>
  );
}

function pagesMenu(env: EditorEnv, data: SyncedBlockInfo): ContextMenuEntries {
  return [
    { header: data.pages.length > 1 ? `Affiché dans ${data.pages.length} pages` : 'Affiché dans 1 page' },
    ...data.pages.map((p) => ({
      label: `${pageTitle(p.title)}${p.id === data.ownerPageId ? ' (original)' : ''}${p.id === env.pageId ? ' · cette page' : ''}`,
      icon: <PageIcon icon={p.icon} size={14} />,
      onClick: () => openPageRef(env, p.id),
    })),
  ];
}

function actionsMenu(editor: AnyEditor, env: EditorEnv, block: AnyBlock, data: SyncedBlockInfo): ContextMenuEntries {
  return [
    { label: 'Copier la référence', icon: <Copy size={15} />, onClick: () => copySyncedReference(block) },
    data.ownerPageId !== env.pageId && {
      label: 'Ouvrir la page d’origine',
      icon: <ExternalLink size={15} />,
      onClick: () => openPageRef(env, data.ownerPageId),
    },
    env.canEdit && { divider: true as const },
    env.canEdit && {
      label: 'Désynchroniser',
      icon: <Unlink size={15} />,
      onClick: () => void unsyncBlock(editor, env, block),
    },
  ];
}

/**
 * The editor's own HTML form of a reference to a synced block (what its paste handler parses back
 * into a block): the id only, never the content (the id is checked, nothing else is interpolated).
 */
export const referenceHtml = (syncedId: string) =>
  `<div class="bn-block-group" data-node-type="blockGroup"><div class="bn-block-outer" data-node-type="blockOuter">` +
  `<div class="bn-block" data-node-type="blockContainer"><div class="bn-block-content" data-content-type="${EDITOR_BLOCK_TYPES.syncedBlock}" data-synced-id="${syncedId}"></div></div></div></div>`;

/**
 * Puts the block on the clipboard in the editor's own HTML form: pasting it in a page of the same
 * workspace shows the same synced block. A `copy` event is used (synchronous, within the click's user
 * activation): the asynchronous Clipboard API may be refused (permissions, embedded browsers).
 */
export function copySyncedReference(block: AnyBlock): void {
  let copied = false;
  try {
    const syncedId = propString(block.props.syncedId);
    if (!isSyncedId(syncedId)) throw new Error('invalid');
    const html = referenceHtml(syncedId);
    const onCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      // `blocknote/html` is what the editor's own paste handler reads first.
      event.clipboardData.setData('blocknote/html', html);
      event.clipboardData.setData('text/html', html);
      event.clipboardData.setData('text/plain', SYNCED_SLASH_TITLE);
      event.preventDefault();
      copied = true;
    };
    document.addEventListener('copy', onCopy, true);
    try {
      document.execCommand('copy');
    } finally {
      document.removeEventListener('copy', onCopy, true);
    }
  } catch {
    copied = false;
  }
  if (copied) toast('Référence copiée : collez-la dans une autre page pour y afficher ce bloc.', { tone: 'success' });
  else toast('Impossible de copier la référence. Sélectionnez le bloc et utilisez ⌘C.', { tone: 'error' });
}

/** Blocks of a synced block: from its open editor, else from the server copy. */
async function currentBlocks(env: EditorEnv, hostBlockId: string, syncedId: string, editor: AnyEditor): Promise<LooseBlock[]> {
  const live = syncedEditorOf(hostBlockId);
  if (live && live.syncedId === syncedId) return live.blocks();
  const { update } = await syncedApi.content(env.pageId, syncedId);
  const bytes = Uint8Array.from(atob(update), (c) => c.charCodeAt(0));
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return yDocToBlocks(editor as never, doc, COLLAB_FRAGMENT) as unknown as LooseBlock[];
  } finally {
    doc.destroy();
  }
}

/** Replaces the reference by a local copy of its blocks (the other pages keep the synced block). */
export async function unsyncBlock(editor: AnyEditor, env: EditorEnv, block: AnyBlock): Promise<void> {
  const syncedId = propString(block.props.syncedId);
  if (!isSyncedId(syncedId)) return;
  const ok = await confirmDialog({
    title: 'Désynchroniser ce bloc ?',
    message: 'Son contenu devient une copie propre à cette page. Les autres pages gardent le bloc synchronisé.',
    confirmLabel: 'Désynchroniser',
  });
  if (!ok) return;
  let blocks: LooseBlock[];
  try {
    blocks = detachedCopies(await currentBlocks(env, block.id, syncedId, editor));
  } catch (e) {
    toast(`Désynchronisation impossible : ${errorMessage(e)}`, { tone: 'error' });
    return;
  }
  if (!editor.getBlock(block.id)) return;
  editor.replaceBlocks([block.id], (blocks.length ? blocks : [{ type: 'paragraph' }]) as never);
}

// --- creation -------------------------------------------------------------------

function canCreate(env: EditorEnv): boolean {
  return env.mode === 'app' && env.canEdit && !!env.pageId;
}

async function createSynced(env: EditorEnv): Promise<string | null> {
  try {
    return (await syncedApi.create(env.pageId)).id;
  } catch (e) {
    toast(`Création du bloc synchronisé impossible : ${errorMessage(e)}`, { tone: 'error' });
    return null;
  }
}

const isEmptyParagraph = (b: { type: string; content?: unknown; children?: unknown[] } | undefined) =>
  !!b && b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 0 && (!b.children || b.children.length === 0);

/** Slash menu: a new, empty synced block owned by the page, at the cursor. */
export async function insertSyncedBlock(editor: AnyEditor, env: EditorEnv): Promise<void> {
  if (!canCreate(env)) return;
  const ref = editor.getTextCursorPosition().block;
  const id = await createSynced(env);
  if (!id) return;
  const block = { type: EDITOR_BLOCK_TYPES.syncedBlock, props: { syncedId: id } };
  const current = editor.getBlock(ref.id);
  if (current && isEmptyParagraph(current)) editor.replaceBlocks([current.id], [block as never]);
  else if (current) editor.insertBlocks([block as never], current.id, 'after');
  else {
    const last = editor.document[editor.document.length - 1];
    if (last) editor.insertBlocks([block as never], last.id, 'after');
  }
}

/**
 * Turns blocks into a synced block owned by the page: the synced block is inserted before them, and
 * they are removed only once their copies are in its document (never lost on a failure).
 */
export async function convertToSyncedBlock(editor: AnyEditor, env: EditorEnv, blocks: Array<{ id: string }>): Promise<void> {
  if (!canCreate(env) || blocks.length === 0) return;
  const originals = blocks.map((b) => editor.getBlock(b.id)).filter(Boolean) as unknown as LooseBlock[];
  if (originals.some((b) => b.type === EDITOR_BLOCK_TYPES.syncedBlock)) {
    toast('Un bloc synchronisé ne peut pas en contenir un autre.', { tone: 'error' });
    return;
  }
  const id = await createSynced(env);
  if (!id) return;
  const ids = originals.map((b) => b.id!).filter(Boolean);
  setSyncedSeed(id, {
    blocks: detachedCopies(originals),
    onSeeded: () => {
      const still = ids.filter((bid) => editor.getBlock(bid));
      if (still.length) editor.removeBlocks(still);
    },
  });
  const first = ids.find((bid) => editor.getBlock(bid));
  if (!first) return;
  editor.insertBlocks([{ type: EDITOR_BLOCK_TYPES.syncedBlock, props: { syncedId: id } } as never], first, 'before');
}

/** Slash-menu item of the editor module ("Avancé" group). */
export function syncedSlashItem(editor: AnyEditor, env: EditorEnv, group: string): DefaultReactSuggestionItem | null {
  if (!canCreate(env)) return null;
  return {
    title: SYNCED_SLASH_TITLE,
    subtext: 'Contenu partagé entre plusieurs pages, modifiable partout',
    aliases: ['synchronise', 'synchro', 'synced', 'partage', 'reutiliser', 'reference'],
    group,
    icon: <RefreshCw size={18} />,
    onItemClick: () => void insertSyncedBlock(editor, env),
  };
}

export const SyncedBlock = createReactBlockSpec(
  {
    type: EDITOR_BLOCK_TYPES.syncedBlock,
    propSchema: { syncedId: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <SyncedView block={block as AnyBlock} editor={editor as AnyEditor} />,
    // Outside the editor (copy to another app): a mention only, never the content (it follows the
    // owner page's access rules). Workspace exports inline the content (io/blocks.ts).
    toExternalHTML: () => <p>{SYNCED_SLASH_TITLE}</p>,
  },
);
