// Pure rules of the footnotes (H5): the notes of a document in order, finding one again at commit time,
// and the numbering of HTML exports. The DOM / React part is footnotes.tsx.
import { EDITOR_BLOCK_TYPES, FOOTNOTE_MAX_LENGTH, FOOTNOTE_MAX_LISTED } from '@oriel/shared';

export interface FootnoteEntry {
  /** 0-based order of the call in the document (the displayed number is index + 1). */
  index: number;
  /** ProseMirror position of the call node. */
  pos: number;
  note: string;
}

/** The parts of a ProseMirror node the collection needs (the real class is never imported: see CLAUDE.md). */
export interface PmNodeLike {
  type: { name: string };
  attrs: Record<string, unknown>;
}
export interface PmDocLike {
  descendants(visit: (node: PmNodeLike, pos: number) => boolean | void): void;
}

/** Note text read from a node attribute: any stored value is bounded. */
export function noteOf(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, FOOTNOTE_MAX_LENGTH) : '';
}

/** Footnote calls of a document, in document order (at most `limit`, a forged page may hold thousands). */
export function collectFootnotes(doc: PmDocLike, limit = FOOTNOTE_MAX_LISTED): FootnoteEntry[] {
  const out: FootnoteEntry[] = [];
  doc.descendants((node, pos) => {
    if (out.length >= limit) return false;
    if (node.type.name === EDITOR_BLOCK_TYPES.footnote) {
      out.push({ index: out.length, pos, note: noteOf(node.attrs.note) });
      return false;
    }
    return true;
  });
  return out;
}

/**
 * The entry a field started editing, found again among the current ones: the same index when its note
 * is unchanged, else the nearest entry holding the note it had, else null (the call was deleted).
 */
export function relocateFootnote(entries: FootnoteEntry[], index: number, expectedNote: string): FootnoteEntry | null {
  const at = entries[index];
  if (at && at.note === expectedNote) return at;
  let best: FootnoteEntry | null = null;
  for (const e of entries) {
    if (e.note !== expectedNote) continue;
    if (!best || Math.abs(e.index - index) < Math.abs(best.index - index)) best = e;
  }
  return best;
}

/** The entry whose call node ends exactly at `pos` (just inserted, cursor after it), or null. */
export function footnoteEndingAt(entries: FootnoteEntry[], pos: number): FootnoteEntry | null {
  return entries.find((e) => e.pos + 1 === pos) ?? null;
}

export const footnoteAnchor = (n: number) => `fn-${n}`;
export const footnoteRefAnchor = (n: number) => `fnref-${n}`;
