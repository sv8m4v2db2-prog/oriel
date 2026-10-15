// Block metadata (H5): who created and who last modified each block of a page, and when. Fed from the
// updates received on the collaborative channel (one tracker per loaded document), stored in
// `editor_block_meta` OUTSIDE the Yjs document, bounded per page, readable only by readers of the page.
import * as Y from 'yjs';
import { BLOCK_ID_PATTERN, BLOCK_META_MAX_PER_PAGE, BLOCK_META_MAX_PER_WINDOW, COLLAB_FRAGMENT, type BlockMeta, type BlockMetaUser } from '@oriel/shared';
import type { Db } from '../db/index.js';

const BLOCK_CONTAINER = 'blockContainer';
/** Most changed types looked at per transaction, and most ancestors followed from one of them. */
const MAX_CHANGED_PER_TRANSACTION = 200;
const MAX_ANCESTORS = 64;
/** Most new elements visited per transaction when collecting inserted blocks. */
const MAX_NEW_NODES_PER_TRANSACTION = 50_000;
/**
 * A group with more children than this is not scanned for new blocks (each scan is linear in the number
 * of siblings and runs for every transaction that touches the group): its new blocks are not attributed.
 */
const MAX_SCANNED_CHILDREN = 5_000;
/** Most blocks of a document looked at when pruning (a larger document keeps its stale rows). */
const MAX_BLOCKS_WALKED = 200_000;

export interface BlockTouch {
  userId: string;
  /** The block appeared in the window (else it only changed). */
  created: boolean;
}

/** Blocks touched by authenticated editors since the last store of one document. */
export class BlockTouches {
  readonly touched = new Map<string, BlockTouch>();
  /** A container of blocks changed (insertion or deletion): the stored rows are pruned at the next store. */
  structural = false;

  get isEmpty() {
    return this.touched.size === 0 && !this.structural;
  }

  private touch(id: string, userId: string, created: boolean) {
    if (!BLOCK_ID_PATTERN.test(id)) return;
    const known = this.touched.get(id);
    if (known) {
      this.touched.set(id, { userId, created: known.created || created });
    } else if (this.touched.size < BLOCK_META_MAX_PER_WINDOW) {
      this.touched.set(id, { userId, created });
    }
  }

  /**
   * Records the blocks changed by one transaction of `userId`. Walks only what changed: a text edit
   * resolves to its block through at most MAX_ANCESTORS parents, a block insertion to the new
   * containers among the children of the type that received them.
   */
  record(transaction: Y.Transaction, userId: string): void {
    let seen = 0;
    for (const type of transaction.changed.keys()) {
      if (++seen > MAX_CHANGED_PER_TRANSACTION) break;
      if (!(type instanceof Y.XmlFragment)) {
        this.touchEnclosing(type, userId, false);
        continue;
      }
      const isBlock = type instanceof Y.XmlElement && type.nodeName === BLOCK_CONTAINER;
      if (isBlock) {
        // Its own attributes or content node changed.
        this.touchEnclosing(type, userId, false);
        continue;
      }
      // A group of blocks (fragment, blockGroup, column…) gained or lost children.
      this.structural = true;
      this.collectNew(type, transaction, userId);
    }
  }

  /** Blocks inserted by the transaction under `parent`, new subtrees included (bounded). */
  private collectNew(parent: Y.XmlFragment, transaction: Y.Transaction, userId: string) {
    const stack: Y.XmlFragment[] = [parent];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_NEW_NODES_PER_TRANSACTION) {
      const node = stack.pop()!;
      if (node.length > MAX_SCANNED_CHILDREN) continue;
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        const item = child._item;
        // Only items integrated by this transaction: an older subtree changed on its own would be listed
        // among the changed types.
        if (!item || item.id.clock < (transaction.beforeState.get(item.id.client) ?? 0)) continue;
        visited++;
        if (child.nodeName === BLOCK_CONTAINER) {
          const id = child.getAttribute('id');
          if (typeof id === 'string') this.touch(id, userId, true);
        }
        stack.push(child);
      }
    }
  }

  private touchEnclosing(type: Y.AbstractType<any>, userId: string, created: boolean) {
    let node: Y.AbstractType<any> | null = type;
    for (let depth = 0; node && depth < MAX_ANCESTORS; depth++) {
      if (node instanceof Y.XmlElement && node.nodeName === BLOCK_CONTAINER) {
        const id = node.getAttribute('id');
        if (typeof id === 'string') this.touch(id, userId, created);
        return;
      }
      node = (node as { parent: Y.AbstractType<any> | null }).parent;
    }
  }
}

/** Ids of the blocks of a document, or null when it holds more than MAX_BLOCKS_WALKED nodes. */
export function documentBlockIds(doc: Y.Doc): Set<string> | null {
  const ids = new Set<string>();
  const stack: unknown[] = [...doc.getXmlFragment(COLLAB_FRAGMENT).toArray()];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!(node instanceof Y.XmlElement)) continue;
    if (++visited > MAX_BLOCKS_WALKED) return null;
    if (node.nodeName === BLOCK_CONTAINER) {
      const id = node.getAttribute('id');
      if (typeof id === 'string') ids.add(id);
    }
    for (const child of node.toArray()) stack.push(child);
  }
  return ids;
}

/**
 * Stores what a save window touched: modifications (and creations) get their author and date, rows of
 * blocks that no longer exist are removed. Called by the collaboration layer after the document was
 * persisted; never throws into it.
 */
export function flushBlockMeta(db: Db, pageId: string, doc: Y.Doc, touches: BlockTouches, now = Date.now()): void {
  if (touches.isEmpty) return;
  db.tx(() => {
    let count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM editor_block_meta WHERE page_id = ?', pageId)?.n ?? 0;
    for (const [blockId, touch] of touches.touched) {
      const exists = db.get('SELECT 1 AS x FROM editor_block_meta WHERE page_id = ? AND block_id = ?', pageId, blockId);
      if (!exists && count >= BLOCK_META_MAX_PER_PAGE) continue;
      db.run(
        `INSERT INTO editor_block_meta (page_id, block_id, created_by, created_at, modified_by, modified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id, block_id) DO UPDATE SET modified_by = excluded.modified_by, modified_at = excluded.modified_at`,
        pageId,
        blockId,
        touch.created ? touch.userId : null,
        touch.created ? now : null,
        touch.userId,
        now,
      );
      if (!exists) count++;
    }
    if (touches.structural) {
      const present = documentBlockIds(doc);
      if (present) {
        const rows = db.all<{ block_id: string }>('SELECT block_id FROM editor_block_meta WHERE page_id = ?', pageId);
        for (const row of rows) {
          if (!present.has(row.block_id)) db.run('DELETE FROM editor_block_meta WHERE page_id = ? AND block_id = ?', pageId, row.block_id);
        }
      }
    }
  });
}

interface MetaRow {
  created_by: string | null;
  created_at: number | null;
  modified_by: string | null;
  modified_at: number | null;
}

/** Metadata of one block with the people resolved; unknown blocks answer with empty fields. */
export function readBlockMeta(db: Db, pageId: string, blockId: string): BlockMeta {
  const row = db.get<MetaRow>('SELECT created_by, created_at, modified_by, modified_at FROM editor_block_meta WHERE page_id = ? AND block_id = ?', pageId, blockId);
  const person = (id: string | null): BlockMetaUser | null => {
    if (!id) return null;
    const user = db.get<{ id: string; name: string; avatar_url: string | null }>('SELECT id, name, avatar_url FROM users WHERE id = ?', id);
    return user ? { id: user.id, name: user.name, avatarUrl: user.avatar_url } : null;
  };
  return {
    blockId,
    createdBy: person(row?.created_by ?? null),
    createdAt: row?.created_at ?? null,
    modifiedBy: person(row?.modified_by ?? null),
    modifiedAt: row?.modified_at ?? null,
  };
}
