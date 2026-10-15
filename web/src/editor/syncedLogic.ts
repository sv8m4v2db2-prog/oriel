// Synced blocks: shared state between the block of the host page and the editor of its content
// (loaded lazily), and pure helpers (unit-tested, see syncedBlock.test.ts).
import { createContext } from 'react';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, EDITOR_BLOCK_TYPES, isSyncedId } from '@oriel/shared';

/** Title of the slash-menu item (left out inside a synced block: synced blocks do not nest). */
export const SYNCED_SLASH_TITLE = 'Bloc synchronisé';

/** Id of the synced block whose content is being edited, or null in a page's own editor. */
export const SyncedNestingContext = createContext<string | null>(null);

/** Loose view of an editor block. */
export interface LooseBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: LooseBlock[];
}

/**
 * Copies of blocks for another document (unsync, convert, export): ids removed so the editor
 * assigns new ones, nested synced blocks left out (their content belongs to another document).
 */
export function detachedCopies(blocks: readonly LooseBlock[]): LooseBlock[] {
  const out: LooseBlock[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || typeof b.type !== 'string') continue;
    if (b.type === EDITOR_BLOCK_TYPES.syncedBlock) continue;
    const { id: _id, children, ...rest } = b;
    out.push({ ...rest, children: Array.isArray(children) ? detachedCopies(children) : [] });
  }
  return out;
}

/** Synced block ids referenced by blocks (any depth), valid ids only, in order, without duplicates. */
export function syncedIdsOf(blocks: readonly LooseBlock[]): string[] {
  const ids = new Set<string>();
  const stack = [...blocks].reverse();
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (!b || typeof b !== 'object') continue;
    if (b.type === EDITOR_BLOCK_TYPES.syncedBlock) {
      const id = b.props?.syncedId;
      if (isSyncedId(id)) ids.add(id);
    }
    if (Array.isArray(b.children)) for (let i = b.children.length - 1; i >= 0; i--) stack.push(b.children[i]!);
  }
  return [...ids];
}

/** Most synced blocks read from one page document (same bound as the server, content/ydoc.ts). */
const MAX_SYNCED_PER_PAGE = 500;

/** Synced blocks referenced by a page document (Yjs update; valid ids only), e.g. to fetch before an export. */
export function syncedIdsInUpdate(update: Uint8Array): string[] {
  const doc = new Y.Doc();
  const ids = new Set<string>();
  try {
    Y.applyUpdate(doc, update);
    const stack: unknown[] = doc.getXmlFragment(COLLAB_FRAGMENT).toArray().reverse();
    while (stack.length > 0 && ids.size < MAX_SYNCED_PER_PAGE) {
      const node = stack.pop();
      if (!(node instanceof Y.XmlElement)) continue;
      if (node.nodeName === EDITOR_BLOCK_TYPES.syncedBlock) {
        const id = node.getAttribute('syncedId') as unknown;
        if (isSyncedId(id)) ids.add(id);
        continue;
      }
      const children = node.toArray();
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  } catch {
    /* unreadable document: nothing to fetch */
  } finally {
    doc.destroy();
  }
  return [...ids];
}

/** True when a document holds nothing but empty paragraphs. */
export function isBlankDocument(blocks: readonly LooseBlock[]): boolean {
  return blocks.every(
    (b) => b.type === 'paragraph' && (!Array.isArray(b.content) || b.content.length === 0) && (!b.children || b.children.length === 0),
  );
}

// --- live state (by synced id / host block id) ----------------------------------------

interface Seed {
  blocks: LooseBlock[];
  /** Called once the blocks are in the synced document (removes the originals from the host). */
  onSeeded?: () => void;
}

/** Content to write into a new synced block once its document is open and empty. */
const seeds = new Map<string, Seed>();
export const setSyncedSeed = (syncedId: string, seed: Seed) => seeds.set(syncedId, seed);
export function takeSyncedSeed(syncedId: string): Seed | undefined {
  const seed = seeds.get(syncedId);
  seeds.delete(syncedId);
  return seed;
}
export const hasSyncedSeed = (syncedId: string) => seeds.has(syncedId);

/** Mounted content editors, by id of the host block showing them. */
export interface SyncedEditorHandle {
  syncedId: string;
  blocks: () => LooseBlock[];
}
const mounted = new Map<string, SyncedEditorHandle>();
export function registerSyncedEditor(hostBlockId: string, handle: SyncedEditorHandle): () => void {
  mounted.set(hostBlockId, handle);
  return () => {
    if (mounted.get(hostBlockId) === handle) mounted.delete(hostBlockId);
  };
}
export const syncedEditorOf = (hostBlockId: string) => mounted.get(hostBlockId);
