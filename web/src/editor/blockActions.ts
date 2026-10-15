// Block operations shared by the drag-handle menu, the right-click menu and keyboard shortcuts.
import type { Block, BlockNoteEditor } from '@blocknote/core';
import { blocksToYXmlFragment } from '@blocknote/core/yjs';
import * as Y from 'yjs';
import { BLOCK_ANCHOR_PREFIX, type TreeResponse } from '@oriel/shared';
import { commentExtraBlock } from './extensions';
import { acquireCollab, releaseCollab, type CollabEntry } from '../lib/collab';
import { qk } from '../lib/queryKeys';
import { queryClient } from '../lib/queryClient';
import { openPagePicker, toast } from '../lib/ui';
import { appNavigate, copyToClipboard, pagePath, sharePath } from '../lib/util';
import type { EditorEnv } from './env';
import { api } from '../lib/api';
import { newId } from '@oriel/shared';
import { pendingDatabaseCopies, prepareBlockCopies, type PendingDatabaseCopy } from './databaseCopy';

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = Block<any, any, any>;

// ---------------------------------------------------------------------------
// Duplicate / delete
// ---------------------------------------------------------------------------

export function stripIds(block: any): any {
  const { id: _id, children, ...rest } = block;
  return { ...rest, children: Array.isArray(children) ? children.map(stripIds) : [] };
}

/** Blocks targeted by keyboard actions: the selected blocks, or the block holding the cursor. */
export function selectedBlocks(editor: AnyEditor): AnyBlock[] {
  const sel = editor.getSelection();
  if (sel && sel.blocks.length > 0) return sel.blocks;
  try {
    return [editor.getTextCursorPosition().block];
  } catch {
    return [];
  }
}

/** Inserts copies of `blocks` after `after`; the copy of an inline database block gets its own database. */
export function insertBlockCopies(editor: AnyEditor, blocks: AnyBlock[], after: AnyBlock): AnyBlock[] {
  const { copies, pending } = prepareBlockCopies(blocks, newId);
  for (const p of pending) pendingDatabaseCopies.add(p.blockId);
  const inserted = editor.insertBlocks(copies, after, 'after');
  for (const p of pending) void finishDatabaseCopy(editor, p);
  return inserted;
}

async function finishDatabaseCopy(editor: AnyEditor, p: PendingDatabaseCopy): Promise<void> {
  try {
    const copy = await api.pages.duplicate(p.sourceId);
    pendingDatabaseCopies.delete(p.blockId);
    // Block removed meanwhile (undo, deletion): the copy would be an orphan.
    if (!editor.getBlock(p.blockId)) void api.pages.trash(copy.id).catch(() => undefined);
    else editor.updateBlock(p.blockId, { props: { databaseId: copy.id } } as never);
  } catch {
    pendingDatabaseCopies.delete(p.blockId);
    if (editor.getBlock(p.blockId)) editor.removeBlocks([p.blockId]);
    toast.error('Impossible de dupliquer la base de données');
  }
}

export function duplicateBlocks(editor: AnyEditor, blocks: AnyBlock[]): void {
  if (blocks.length === 0) return;
  const last = blocks[blocks.length - 1]!;
  const copies = insertBlockCopies(editor, blocks, last);
  const target = copies[copies.length - 1];
  if (target) {
    try {
      editor.setTextCursorPosition(target, 'end');
    } catch {
      /* non-text block */
    }
  }
}

export function removeBlocks(editor: AnyEditor, blocks: AnyBlock[]): void {
  if (blocks.length) editor.removeBlocks(blocks);
}

// ---------------------------------------------------------------------------
// Transform ("Transformer en…")
// ---------------------------------------------------------------------------

export interface TransformTarget {
  key: string;
  label: string;
  type: string;
  props?: Record<string, unknown>;
}

export const TRANSFORM_TARGETS: TransformTarget[] = [
  { key: 'paragraph', label: 'Texte', type: 'paragraph' },
  { key: 'h1', label: 'Titre 1', type: 'heading', props: { level: 1, isToggleable: false } },
  { key: 'h2', label: 'Titre 2', type: 'heading', props: { level: 2, isToggleable: false } },
  { key: 'h3', label: 'Titre 3', type: 'heading', props: { level: 3, isToggleable: false } },
  { key: 'h4', label: 'Titre 4', type: 'heading', props: { level: 4, isToggleable: false } },
  { key: 'th1', label: 'Titre dépliable 1', type: 'heading', props: { level: 1, isToggleable: true } },
  { key: 'th2', label: 'Titre dépliable 2', type: 'heading', props: { level: 2, isToggleable: true } },
  { key: 'th3', label: 'Titre dépliable 3', type: 'heading', props: { level: 3, isToggleable: true } },
  { key: 'th4', label: 'Titre dépliable 4', type: 'heading', props: { level: 4, isToggleable: true } },
  { key: 'bullet', label: 'Liste à puces', type: 'bulletListItem' },
  { key: 'numbered', label: 'Liste numérotée', type: 'numberedListItem' },
  { key: 'check', label: 'Case à cocher', type: 'checkListItem' },
  { key: 'toggle', label: 'Liste dépliable', type: 'toggleListItem' },
  { key: 'quote', label: 'Citation', type: 'quote' },
  { key: 'callout', label: 'Encadré', type: 'callout' },
];

const TEXT_TYPES = new Set(TRANSFORM_TARGETS.map((t) => t.type));
export const isTransformable = (block: { type: string }) => TEXT_TYPES.has(block.type);

const isToggleBlock = (block: { type: string; props?: Record<string, unknown> }) =>
  block.type === 'toggleListItem' || (block.type === 'heading' && !!block.props?.isToggleable);

export function isCurrentTarget(block: AnyBlock, t: TransformTarget): boolean {
  if (block.type !== t.type) return false;
  if (t.type !== 'heading') return true;
  return block.props.level === t.props!.level && !!block.props.isToggleable === !!t.props!.isToggleable;
}

/**
 * Changes a block's type. Toggle state: a toggle (list or heading) that has children stays toggleable
 * when turned into a heading (its children would otherwise be shown expanded under a plain heading, and
 * the open/closed state — stored per block id — is kept); turning a block into a non-toggle type resets
 * the stored open/closed state.
 */
export function transformBlock(editor: AnyEditor, block: AnyBlock, target: TransformTarget): void {
  const props: Record<string, unknown> = { ...(target.props ?? {}) };
  if (target.type === 'heading' && props.isToggleable === false && isToggleBlock(block) && block.children.length > 0) {
    props.isToggleable = true;
  }
  editor.updateBlock(block, { type: target.type, props } as never);
  const nowToggle = target.type === 'toggleListItem' || (target.type === 'heading' && !!props.isToggleable);
  if (!nowToggle) {
    try {
      window.localStorage.removeItem(`toggle-${block.id}`);
    } catch {
      /* storage unavailable */
    }
  }
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const hasTextColor = (block: AnyBlock) => typeof block.props?.textColor === 'string';
export const hasBackgroundColor = (block: AnyBlock) => typeof block.props?.backgroundColor === 'string' && block.type !== 'callout';

export function setBlockColor(editor: AnyEditor, block: AnyBlock, kind: 'text' | 'background', color: string): void {
  if (block.type === 'callout' && kind === 'background') {
    editor.updateBlock(block, { props: { backgroundColor: color } } as never);
    return;
  }
  editor.updateBlock(block, { props: kind === 'text' ? { textColor: color } : { backgroundColor: color } } as never);
}

// ---------------------------------------------------------------------------
// Block links
// ---------------------------------------------------------------------------

export function blockLink(env: Pick<EditorEnv, 'mode' | 'workspaceId' | 'pageId'>, blockId: string): string {
  const path = env.mode === 'public' || !env.workspaceId ? sharePath(env.pageId) : pagePath(env.workspaceId, env.pageId);
  return `${location.origin}${path}#${BLOCK_ANCHOR_PREFIX}${blockId}`;
}

export async function copyBlockLink(env: Pick<EditorEnv, 'mode' | 'workspaceId' | 'pageId'>, blockId: string): Promise<void> {
  if (await copyToClipboard(blockLink(env, blockId))) toast.success('Lien du bloc copié');
  else toast.error('Copie impossible');
}

// ---------------------------------------------------------------------------
// Move blocks to another page (appended through that page's collaborative document)
// ---------------------------------------------------------------------------

function waitForEntry(entry: CollabEntry, check: (s: ReturnType<CollabEntry['store']['get']>) => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (check(entry.store.get())) return resolve(true);
    const timer = setTimeout(() => {
      unsub();
      resolve(check(entry.store.get()));
    }, timeoutMs);
    const unsub = entry.store.subscribe(() => {
      if (check(entry.store.get())) {
        clearTimeout(timer);
        unsub();
        resolve(true);
      }
    });
  });
}

/** Appends copies of `blocks` at the end of `targetPageId`, then removes them here. */
export async function moveBlocksToPage(editor: AnyEditor, blocks: AnyBlock[], targetPageId: string): Promise<boolean> {
  if (blocks.length === 0) return false;
  const entry = acquireCollab(targetPageId, true);
  try {
    const ready = await waitForEntry(entry, (s) => s.synced || s.denied, 10_000);
    const state = entry.store.get();
    if (!ready || state.denied || state.readOnly) {
      toast.error(state.readOnly ? 'Vous ne pouvez pas modifier la page de destination.' : 'Page de destination inaccessible.');
      return false;
    }
    // Serialize the blocks with this editor's schema into a scratch document, then clone the nodes over.
    const scratch = new Y.Doc();
    const fragment = scratch.getXmlFragment('blocks');
    blocksToYXmlFragment(editor, blocks, fragment);
    const group = fragment.get(0);
    if (!(group instanceof Y.XmlElement)) {
      scratch.destroy();
      return false;
    }
    entry.doc.transact(() => {
      const target = entry.fragment;
      const first = target.length > 0 ? target.get(0) : null;
      if (first instanceof Y.XmlElement && first.nodeName === 'blockGroup') {
        first.insert(first.length, group.toArray().map((n) => n.clone()) as Array<Y.XmlElement | Y.XmlText>);
      } else {
        target.insert(target.length, [group.clone()]);
      }
    });
    scratch.destroy();
    // Remove the originals only once the server holds the copy: otherwise (connection lost meanwhile)
    // the blocks would only exist in this browser's offline copy of the destination page.
    if (!(await waitForEntry(entry, (s) => s.unsynced === 0, 15_000))) {
      toast.error('La copie n’est pas encore enregistrée sur le serveur : les blocs sont conservés ici.');
      return false;
    }
    editor.removeBlocks(blocks);
    return true;
  } catch (e) {
    console.error('[Oriel] déplacement de bloc', e);
    toast.error('Déplacement impossible.');
    return false;
  } finally {
    releaseCollab(entry);
  }
}

export function pickPageAndMoveBlocks(editor: AnyEditor, env: EditorEnv, blocks: AnyBlock[]): void {
  if (!env.workspaceId) return;
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(env.workspaceId));
  const exclude = new Set<string>([env.pageId]);
  for (const n of tree?.nodes ?? []) if (n.kind === 'database') exclude.add(n.id);
  const ids = blocks.map((b) => b.id);
  openPagePicker({
    title: blocks.length > 1 ? `Déplacer ${blocks.length} blocs vers…` : 'Déplacer le bloc vers…',
    exclude,
    includeRows: true,
    onPick: (target) => {
      if (target.kind !== 'page') return;
      const current = ids.map((id) => editor.getBlock(id)).filter((b): b is AnyBlock => !!b);
      void moveBlocksToPage(editor, current, target.id).then((ok) => {
        if (ok && env.workspaceId) {
          const wid = env.workspaceId;
          toast.success(current.length > 1 ? 'Blocs déplacés' : 'Bloc déplacé', {
            label: 'Ouvrir',
            onClick: () => appNavigate(pagePath(wid, target.id)),
          });
        }
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Comments (provided by the collaboration module through extensions.ts)
// ---------------------------------------------------------------------------

/** "Commenter" action for a block, or null when comments are unavailable or the block has no text. */
export function blockCommentAction(editor: AnyEditor, block: AnyBlock): (() => void) | null {
  if (!editor.isEditable || !editor.getExtension('comments')) return null;
  if (!Array.isArray(block.content) || block.content.length === 0) return null;
  return () => {
    editor.focus();
    if (!commentExtraBlock(editor, block.id)) toast.error('Impossible de commenter ce bloc.');
  };
}
