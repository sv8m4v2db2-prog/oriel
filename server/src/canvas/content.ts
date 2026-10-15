// Content of canvas documents (H1): searchable text and page links for `persist`, id remapping for
// duplication, and restoration of a version. Only objects accepted by `sanitizeCanvasObject` count.
import * as Y from 'yjs';
import { canvasObjectText, isCanvasFormat, sanitizeCanvasObject, type CanvasObject } from '@oriel/shared';
import { parseJson } from '../db/rows.js';
import { docFromState, type ExtractedContent } from '../content/ydoc.js';
import { canvasMap } from './guard.js';

/** Indexed text of a canvas is capped (search index row). */
const MAX_TEXT = 200_000;

export const isCanvasRow = (row: { format: string } | null | undefined): boolean => !!row && isCanvasFormat(parseJson<{ layout?: unknown }>(row.format, {}));

export function canvasObjects(doc: Y.Doc): CanvasObject[] {
  const out: CanvasObject[] = [];
  for (const value of canvasMap(doc).values()) {
    const o = sanitizeCanvasObject(value);
    if (o) out.push(o);
  }
  return out;
}

/** Text (one line per object text) and linked pages of a canvas document. */
export function extractCanvasContent(doc: Y.Doc): ExtractedContent {
  const parts: string[] = [];
  let length = 0;
  const links = new Set<string>();
  for (const o of canvasObjects(doc).sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0))) {
    if (o.type === 'page') links.add(o.pageId);
    const text = canvasObjectText(o).replace(/[ \t]+/g, ' ').trim();
    if (!text || length >= MAX_TEXT) continue;
    parts.push(text);
    length += text.length + 1;
  }
  return { text: parts.join('\n').slice(0, MAX_TEXT), links: [...links], synced: [] };
}

/** Duplication: page cards pointing at copied pages point at the copies. */
export function remapCanvasState(state: Uint8Array, idMap: Map<string, string>): { state: Uint8Array } & ExtractedContent {
  const doc = docFromState(state);
  try {
    const map = canvasMap(doc);
    const updates: Array<[string, unknown]> = [];
    for (const [key, value] of map.entries()) {
      const o = sanitizeCanvasObject(value);
      if (o?.type === 'page' && idMap.has(o.pageId)) updates.push([key, { ...(value as object), pageId: idMap.get(o.pageId)! }]);
    }
    if (updates.length > 0) doc.transact(() => updates.forEach(([k, v]) => map.set(k, v)));
    return { state: Y.encodeStateAsUpdate(doc), ...extractCanvasContent(doc) };
  } finally {
    doc.destroy();
  }
}

/** Restoration: the live canvas gets the objects of the version (changed keys only). */
export function replaceCanvasWithState(target: Y.Doc, snapshotState: Uint8Array): void {
  const source = docFromState(snapshotState);
  try {
    const src = new Map<string, CanvasObject>();
    for (const value of canvasMap(source).values()) {
      const o = sanitizeCanvasObject(value);
      if (o) src.set(o.id, o);
    }
    const dst = canvasMap(target);
    for (const key of [...dst.keys()]) if (!src.has(key)) dst.delete(key);
    for (const [key, o] of src) {
      if (JSON.stringify(dst.get(key)) !== JSON.stringify(o)) dst.set(key, o);
    }
  } finally {
    source.destroy();
  }
}
