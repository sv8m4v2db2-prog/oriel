// Duplicating blocks (⌘D, « Dupliquer »): an inline database block owns its database, so its copy gets
// a copy of the database (schema, views, rows, content) instead of a second reference to the same one.
// A linked view (`linkedDatabase`) stays a reference.
import { EDITOR_TYPES } from '@oriel/shared';

export interface PendingDatabaseCopy {
  /** Id given to the copied block (known before insertion). */
  blockId: string;
  /** Database the original block shows. */
  sourceId: string;
}

/** Copied blocks whose database is still being duplicated (they show a placeholder meanwhile). */
export const pendingDatabaseCopies = new Set<string>();

/**
 * Block copies without ids; each inline database block gets a fresh id and an empty `databaseId`
 * (the copy must never show the original database), listed in `pending`.
 */
export function prepareBlockCopies(blocks: readonly any[], makeId: () => string): { copies: any[]; pending: PendingDatabaseCopy[] } {
  const pending: PendingDatabaseCopy[] = [];
  const copy = (block: any): any => {
    const { id: _id, children, ...rest } = block;
    const out = { ...rest, children: Array.isArray(children) ? children.map(copy) : [] };
    const sourceId = block.type === EDITOR_TYPES.database ? block.props?.databaseId : '';
    if (typeof sourceId === 'string' && sourceId) {
      out.id = makeId();
      out.props = { ...block.props, databaseId: '' };
      pending.push({ blockId: out.id, sourceId });
    }
    return out;
  };
  return { copies: blocks.map(copy), pending };
}
