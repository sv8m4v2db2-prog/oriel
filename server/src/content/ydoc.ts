// Server-side reading of page documents (Yjs + BlockNote fragment). The server never authors
// editor content; it only extracts text/links and rewrites page references when duplicating.
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, EDITOR_BLOCK_TYPES, EDITOR_TYPES, isSyncedId } from '@oriel/shared';

/**
 * Deepest element nesting accepted (page content API and /collab). BlockNote documents stay far
 * below it; Yjs `clone()`, its garbage collection and integration of nested types recurse and
 * overflow the stack around a thousand levels.
 */
export const MAX_CONTENT_DEPTH = 256;
/** Most children of one element: Yjs inserts a clone's children as call arguments (stack overflow beyond ~100k). */
export const MAX_CONTENT_CHILDREN = 50_000;

const REFERENCE_NODE_NAMES = new Set<string>(Object.values(EDITOR_TYPES));
const REFERENCE_ATTRIBUTES = ['pageId', 'databaseId'] as const;
/** Text held in an attribute (equations, tab titles, button labels): part of the page text (search, AI). */
const TEXT_ATTRIBUTE: Record<string, string> = {
  [EDITOR_BLOCK_TYPES.equation]: 'tex',
  [EDITOR_BLOCK_TYPES.inlineEquation]: 'tex',
  [EDITOR_BLOCK_TYPES.tab]: 'title',
  [EDITOR_BLOCK_TYPES.button]: 'label',
};
const TEXT_ATTRIBUTE_MAX = 4000;
/** Most synced blocks recorded for one page (each is a row of `editor_synced_refs`). */
export const MAX_SYNCED_REFS = 500;
/** Elements that start a new line in the plain-text rendering. */
const BLOCK_BREAK = new Set(['blockContainer', 'tableRow', 'hardBreak']);
/** Elements followed by a space (table cells). */
const CELL = new Set(['tableCell', 'tableHeader']);

const CELL_END = Symbol('cell-end');

/**
 * Depth-first walk in document order. Iterative (explicit stack): documents written over /collab
 * before its ingest checks may nest deeper than the call stack, and may hold non-XML values
 * (skipped).
 */
function walk(nodes: unknown[], visit: (el: Y.XmlElement) => void, onText: (t: Y.XmlText) => void, onBreak: () => void, onCell: () => void) {
  const stack: unknown[] = [];
  const pushChildren = (children: unknown[]) => {
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  };
  pushChildren(nodes);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === CELL_END) {
      onCell();
    } else if (node instanceof Y.XmlText) {
      onText(node);
    } else if (node instanceof Y.XmlElement) {
      const name = node.nodeName;
      if (BLOCK_BREAK.has(name)) onBreak();
      visit(node);
      if (CELL.has(name)) stack.push(CELL_END);
      pushChildren(node.toArray());
    }
  }
}

function xmlTextToPlain(t: Y.XmlText): string {
  let out = '';
  for (const op of t.toDelta() as Array<{ insert?: unknown }>) {
    if (typeof op.insert === 'string') out += op.insert;
  }
  return out;
}

export interface ExtractedContent {
  text: string;
  links: string[];
  /** Ids of the synced blocks shown (syntactically valid ids only, at most MAX_SYNCED_REFS). */
  synced: string[];
}

/** Plain text (one line per block) and referenced page/database ids of a document. */
export function extractContent(doc: Y.Doc): ExtractedContent {
  const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
  const parts: string[] = [];
  const links = new Set<string>();
  const synced = new Set<string>();
  walk(
    fragment.toArray(),
    (el) => {
      const name = el.nodeName;
      const textAttr = TEXT_ATTRIBUTE[name];
      if (textAttr) {
        const value = el.getAttribute(textAttr) as unknown;
        if (typeof value === 'string' && value) parts.push(` ${value.slice(0, TEXT_ATTRIBUTE_MAX)} `);
        return;
      }
      if (name === EDITOR_BLOCK_TYPES.syncedBlock) {
        const id = el.getAttribute('syncedId') as unknown;
        if (isSyncedId(id) && synced.size < MAX_SYNCED_REFS) synced.add(id);
        return;
      }
      if (!REFERENCE_NODE_NAMES.has(name)) return;
      for (const attr of REFERENCE_ATTRIBUTES) {
        const value = el.getAttribute(attr) as unknown;
        if (typeof value === 'string' && value) links.add(value);
      }
    },
    (t) => parts.push(xmlTextToPlain(t)),
    () => parts.push('\n'),
    () => parts.push(' '),
  );
  const text = parts
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
  return { text, links: [...links], synced: [...synced] };
}

export function docFromState(state: Uint8Array | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (state && state.byteLength > 0) Y.applyUpdate(doc, state);
  return doc;
}

export function extractFromState(state: Uint8Array | null | undefined): ExtractedContent {
  const doc = docFromState(state);
  try {
    return extractContent(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Rewrites `pageId` / `databaseId` attributes of reference elements according to `idMap`
 * (old id → new id). Returns the new full state and the extracted content of the result.
 */
export function remapState(state: Uint8Array, idMap: Map<string, string>): { state: Uint8Array } & ExtractedContent {
  const doc = docFromState(state);
  try {
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    const toUpdate: Array<[Y.XmlElement, string, string]> = [];
    walk(
      fragment.toArray(),
      (el) => {
        if (!REFERENCE_NODE_NAMES.has(el.nodeName)) return;
        for (const attr of REFERENCE_ATTRIBUTES) {
          const value = el.getAttribute(attr) as unknown;
          if (typeof value === 'string' && idMap.has(value)) toUpdate.push([el, attr, idMap.get(value)!]);
        }
      },
      () => {},
      () => {},
      () => {},
    );
    if (toUpdate.length > 0) {
      doc.transact(() => {
        for (const [el, attr, value] of toUpdate) el.setAttribute(attr, value);
      });
    }
    const extracted = extractContent(doc);
    return { state: Y.encodeStateAsUpdate(doc), ...extracted };
  } finally {
    doc.destroy();
  }
}

/** Plain attribute values only (a type or a document stored as an attribute cannot be copied). */
const isPlainValue = (value: unknown) => !(value instanceof Y.AbstractType) && !(value instanceof Y.Doc) && !(value instanceof Uint8Array);

function copyText(text: Y.XmlText): Y.XmlText {
  const copy = new Y.XmlText();
  copy.applyDelta((text.toDelta() as Array<{ insert?: unknown }>).filter((op) => typeof op.insert === 'string'));
  return copy;
}

function copyElement(el: Y.XmlElement): Y.XmlElement {
  const copy = new Y.XmlElement(el.nodeName);
  for (const [key, value] of Object.entries(el.getAttributes() as Record<string, unknown>)) {
    if (isPlainValue(value)) copy.setAttribute(key, value as string);
  }
  return copy;
}

/**
 * Like Yjs `clone()` for what the editor renders (elements, texts, plain attributes, characters),
 * within MAX_CONTENT_DEPTH / MAX_CONTENT_CHILDREN; anything else is left out. Iterative: snapshots
 * taken before the /collab ingest checks may hold any structure, which `clone()` recurses into
 * (and throws on). Returns null for a node that is neither an element nor a text.
 */
export function cloneForEditor(node: unknown): Y.XmlElement | Y.XmlText | null {
  if (node instanceof Y.XmlText) return copyText(node);
  if (!(node instanceof Y.XmlElement)) return null;
  const root = copyElement(node);
  const stack: Array<[Y.XmlElement, Y.XmlElement, number]> = [[node, root, 1]];
  while (stack.length > 0) {
    const [source, target, depth] = stack.pop()!;
    const children: Array<Y.XmlElement | Y.XmlText> = [];
    for (const child of source.toArray() as unknown[]) {
      if (children.length >= MAX_CONTENT_CHILDREN) break;
      if (child instanceof Y.XmlText) {
        children.push(copyText(child));
      } else if (child instanceof Y.XmlElement && depth < MAX_CONTENT_DEPTH) {
        const copy = copyElement(child);
        children.push(copy);
        stack.push([child, copy, depth + 1]);
      }
    }
    // Not integrated yet: the children copies are filled in later, before the whole tree is.
    if (children.length > 0) target.insert(0, children);
  }
  return root;
}

/** Replace the content of `target`'s fragment by copies of the nodes of a snapshot state. */
export function replaceFragmentWithState(target: Y.Doc, snapshotState: Uint8Array): void {
  const source = docFromState(snapshotState);
  try {
    const src = source.getXmlFragment(COLLAB_FRAGMENT);
    const dst = target.getXmlFragment(COLLAB_FRAGMENT);
    const clones: Array<Y.XmlElement | Y.XmlText> = [];
    for (const node of src.toArray() as unknown[]) {
      if (clones.length >= MAX_CONTENT_CHILDREN) break;
      const copy = cloneForEditor(node);
      if (copy) clones.push(copy);
    }
    if (dst.length > 0) dst.delete(0, dst.length);
    if (clones.length > 0) dst.insert(0, clones);
  } finally {
    source.destroy();
  }
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
