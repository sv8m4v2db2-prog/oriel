// Version history (G6): restores applied as targeted Yjs edits of the live document, never by
// replacing the shared types the editors are bound to. Blocks are matched by id: identical blocks
// are left untouched (a concurrent edit there survives), texts are corrected character by character.
// Every function must run inside a transaction on `target`.
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';
import { MAX_CONTENT_CHILDREN, MAX_CONTENT_DEPTH } from './ydoc.js';

type Parent = Y.XmlElement | Y.XmlFragment;
type XmlNode = Y.XmlElement | Y.XmlText;

/** Nodes that are blocks (they carry the block id). */
const BLOCK_NODES = new Set(['blockContainer', 'columnList', 'column']);
const GROUP = 'blockGroup';

const isPlainValue = (value: unknown) => !(value instanceof Y.AbstractType) && !(value instanceof Y.Doc) && !(value instanceof Uint8Array);

const blockId = (node: unknown): string | null => {
  if (!(node instanceof Y.XmlElement) || !BLOCK_NODES.has(node.nodeName)) return null;
  const id = node.getAttribute('id');
  return typeof id === 'string' && id ? id : null;
};

// ---------------------------------------------------------------------------
// Copies (like cloneForEditor, plus an exclusion list of block ids)
// ---------------------------------------------------------------------------

function copyText(text: Y.XmlText): Y.XmlText {
  const copy = new Y.XmlText();
  copy.applyDelta((text.toDelta() as Array<{ insert?: unknown }>).filter((op) => typeof op.insert === 'string'));
  return copy;
}

function copyShallow(el: Y.XmlElement): Y.XmlElement {
  const copy = new Y.XmlElement(el.nodeName);
  for (const [key, value] of Object.entries(el.getAttributes() as Record<string, unknown>)) {
    if (isPlainValue(value)) copy.setAttribute(key, value as string);
  }
  return copy;
}

/** Ids to leave out of a copy (a Set, or the keys of a block map). */
type Exclusion = { has(id: string): boolean };

/** Depth of a node in its document, as checkCollabUpdate counts it (fragment 0, root group 1). */
export function depthOf(node: unknown): number {
  let d = 0;
  for (let n: unknown = node; n instanceof Y.XmlElement || n instanceof Y.XmlText; n = n.parent) d++;
  return d;
}

/**
 * Copy of a node for insertion into the live document at depth `depth` (where the copy itself will
 * sit, see depthOf), within MAX_CONTENT_DEPTH / MAX_CONTENT_CHILDREN: elements that would sit deeper
 * are left out, like the collab guard refuses them (QA-G6-01); blocks whose id is in `exclude` are
 * left out (with an empty group). Children are collected before the parent is built, so that
 * nothing is read from a prelim type.
 */
export function copyNode(node: unknown, exclude: Exclusion = new Set<string>(), depth = 1): XmlNode | null {
  if (node instanceof Y.XmlText) return copyText(node);
  if (!(node instanceof Y.XmlElement)) return null;
  if (depth > MAX_CONTENT_DEPTH) return null;
  const id = blockId(node);
  if (id && exclude.has(id)) return null;
  const copy = copyShallow(node);
  const kids: XmlNode[] = [];
  for (const child of node.toArray() as unknown[]) {
    if (kids.length >= MAX_CONTENT_CHILDREN) break;
    const c = copyNode(child, exclude, depth + 1);
    if (c) kids.push(c);
  }
  // A group left empty by the exclusions is invalid for the editor: drop it.
  if (node.nodeName === GROUP && kids.length === 0 && node.length > 0) return null;
  // So is a block that lost its content (too deep): drop the block.
  if (node.nodeName === 'blockContainer' && contentOf(node) && !kids.some((k) => k instanceof Y.XmlElement && k.nodeName !== GROUP)) return null;
  if (kids.length > 0) copy.insert(0, kids);
  return copy;
}

// ---------------------------------------------------------------------------
// Whole-document reconciliation
// ---------------------------------------------------------------------------

type Run = { text: string; attrs: Record<string, unknown> | undefined };
const attrsKey = (a: Record<string, unknown> | undefined) => (a ? JSON.stringify(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : 1))) : '');

function charsOf(text: Y.XmlText): Array<{ c: string; k: string; a: Record<string, unknown> | undefined }> {
  const out: Array<{ c: string; k: string; a: Record<string, unknown> | undefined }> = [];
  for (const op of text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
    if (typeof op.insert !== 'string') continue;
    const k = attrsKey(op.attributes);
    for (const c of op.insert) out.push({ c, k, a: op.attributes });
  }
  return out;
}

/** Makes `cur` read like `tgt` with one deletion and one insertion between their common ends. */
export function reconcileText(cur: Y.XmlText, tgt: Y.XmlText): void {
  const a = charsOf(cur);
  const b = charsOf(tgt);
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.c === b[start]!.c && a[start]!.k === b[start]!.k) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1]!.c === b[endB - 1]!.c && a[endA - 1]!.k === b[endB - 1]!.k) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return;
  // Offsets in UTF-16 units (Yjs positions), from code points.
  const units = (list: typeof a, from: number, to: number) => list.slice(from, to).reduce((n, x) => n + x.c.length, 0);
  const at = units(a, 0, start);
  const delLen = units(a, start, endA);
  if (delLen > 0) cur.delete(at, delLen);
  // Explicit null for every known mark, so that the insertion does not inherit its neighbours' marks.
  const keys = new Set<string>();
  for (const x of [...a, ...b]) for (const k of Object.keys(x.a ?? {})) keys.add(k);
  const runs: Run[] = [];
  for (const x of b.slice(start, endB)) {
    const last = runs[runs.length - 1];
    if (last && attrsKey(last.attrs) === x.k) last.text += x.c;
    else runs.push({ text: x.c, attrs: x.a });
  }
  let pos = at;
  for (const run of runs) {
    const attrs: Record<string, unknown> = {};
    for (const k of keys) attrs[k] = run.attrs?.[k] ?? null;
    cur.insert(pos, run.text, attrs);
    pos += run.text.length;
  }
}

function reconcileAttributes(cur: Y.XmlElement, tgt: Y.XmlElement): void {
  const want = tgt.getAttributes() as Record<string, unknown>;
  const have = cur.getAttributes() as Record<string, unknown>;
  for (const [k, v] of Object.entries(want)) {
    if (!isPlainValue(v)) continue;
    if (JSON.stringify(have[k]) !== JSON.stringify(v)) cur.setAttribute(k, v as string);
  }
  for (const k of Object.keys(have)) if (!(k in want)) cur.removeAttribute(k);
}

/** Keys of the children of a node: block id, else node name and rank among its namesakes. */
function keysOf(nodes: unknown[]): string[] {
  const seen = new Map<string, number>();
  return nodes.map((n) => {
    const id = blockId(n);
    if (id) return `id:${id}`;
    const name = n instanceof Y.XmlText ? '#text' : n instanceof Y.XmlElement ? n.nodeName : '#other';
    const rank = seen.get(name) ?? 0;
    seen.set(name, rank + 1);
    return `${name}#${rank}`;
  });
}

/** Positions of a longest strictly increasing subsequence of `seq`. */
function lis(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) keep.add(k);
  return keep;
}

/** `depth`: depth of `cur` in the live document (depthOf); copies are bounded from there. */
function reconcileChildren(cur: Parent, tgt: Parent, depth: number): void {
  if (depth > MAX_CONTENT_DEPTH) return;
  const curKids = cur.toArray() as unknown[];
  const tgtKids = (tgt.toArray() as unknown[]).slice(0, MAX_CONTENT_CHILDREN);
  const curKeys = keysOf(curKids);
  const tgtKeys = keysOf(tgtKids);
  const curPos = new Map(curKeys.map((k, i) => [k, i]));
  // Pairs in target order; kept = the longest run already in the same order.
  const pairs: Array<[number, number]> = [];
  tgtKeys.forEach((k, j) => {
    const i = curPos.get(k);
    if (i === undefined) return;
    const a = curKids[i];
    const b = tgtKids[j];
    const sameKind = (a instanceof Y.XmlText && b instanceof Y.XmlText) || (a instanceof Y.XmlElement && b instanceof Y.XmlElement && a.nodeName === b.nodeName);
    if (sameKind) pairs.push([i, j]);
  });
  const keepIdx = lis(pairs.map(([i]) => i));
  const kept = pairs.filter((_, n) => keepIdx.has(n));
  const keptCur = new Set(kept.map(([i]) => i));
  const keptTgt = new Map(kept.map(([i, j]) => [j, i]));

  for (let i = curKids.length - 1; i >= 0; i--) {
    if (keptCur.has(i)) continue;
    let end = i;
    while (i - 1 >= 0 && !keptCur.has(i - 1)) i--;
    cur.delete(i, end - i + 1);
  }
  // Insert copies of the other target children, in runs; then recurse into the kept pairs.
  const slots: Array<number | null> = []; // per position in the result: target index of a kept pair
  let pos = 0;
  let batch: XmlNode[] = [];
  const flush = () => {
    if (batch.length > 0) cur.insert(pos - batch.length, batch);
    batch = [];
  };
  tgtKids.forEach((node, j) => {
    if (keptTgt.has(j)) {
      flush();
      slots.push(j);
      pos++;
      return;
    }
    const copy = copyNode(node, undefined, depth + 1);
    if (copy) {
      batch.push(copy);
      slots.push(null);
      pos++;
    }
  });
  flush();
  const now = cur.toArray() as unknown[];
  slots.forEach((j, at) => {
    if (j === null) return;
    const c = now[at];
    const node = tgtKids[j];
    if (c instanceof Y.XmlText && node instanceof Y.XmlText) reconcileText(c, node);
    else if (c instanceof Y.XmlElement && node instanceof Y.XmlElement) {
      reconcileAttributes(c, node);
      reconcileChildren(c, node, depth + 1);
    }
  });
}

/** Brings the whole content of `target` to the content of `source` (a version). */
export function reconcileDocument(target: Y.Doc, source: Y.Doc): void {
  reconcileChildren(target.getXmlFragment(COLLAB_FRAGMENT), source.getXmlFragment(COLLAB_FRAGMENT), 0);
}

// ---------------------------------------------------------------------------
// Chosen blocks
// ---------------------------------------------------------------------------

type BlockIndex = Map<string, Y.XmlElement>;

/** Adds the blocks below `start` (at depth `depth`) to `out`, first occurrence kept; iterative. */
function collectBlocks(start: unknown, depth: number, out: BlockIndex): BlockIndex {
  const stack: Array<[unknown, number]> = [[start, depth]];
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    const id = blockId(n);
    if (id && !live(out.get(id))) out.set(id, n as Y.XmlElement);
    if (d < MAX_CONTENT_DEPTH && (n instanceof Y.XmlElement || n instanceof Y.XmlFragment)) {
      for (const c of n.toArray() as unknown[]) if (c instanceof Y.XmlElement) stack.push([c, d + 1]);
    }
  }
  return out;
}

/** Block elements of a document by id (first occurrence). */
export function blockMap(doc: Y.Doc): BlockIndex {
  return collectBlocks(doc.getXmlFragment(COLLAB_FRAGMENT), 0, new Map());
}

/** The element, unless an earlier edit of the same restore deleted it. */
function live(el: Y.XmlElement | undefined): Y.XmlElement | undefined {
  return el && !el._item?.deleted ? el : undefined;
}

/**
 * Block maps of the version and of the live document, built once for all the items of a restore
 * (QA-G6-02: rebuilding them per item made 200 items on a large page cost seconds of event loop).
 * Reinsertions add their blocks to `target`; entries deleted meanwhile are skipped by `live`.
 */
export interface RestoreMaps {
  source: BlockIndex;
  target: BlockIndex;
}

const mapsOf = (target: Y.Doc, source: Y.Doc): RestoreMaps => ({ source: blockMap(source), target: blockMap(target) });

const contentOf = (el: Y.XmlElement): Y.XmlElement | undefined =>
  (el.toArray() as unknown[]).find((k): k is Y.XmlElement => k instanceof Y.XmlElement && k.nodeName !== GROUP);

/** Gives a block back its type, settings and text of the version, keeping its children and place. */
export function revertBlock(target: Y.Doc, source: Y.Doc, id: string, maps: RestoreMaps = mapsOf(target, source)): 'ok' | 'missing' | 'not-in-version' {
  const src = maps.source.get(id);
  if (!src) return 'not-in-version';
  const cur = live(maps.target.get(id));
  if (!cur) return 'missing';
  reconcileAttributes(cur, src);
  if (cur.nodeName !== 'blockContainer' || src.nodeName !== 'blockContainer') return 'ok';
  const a = contentOf(cur);
  const b = contentOf(src);
  if (!b) return 'ok';
  if (a && a.nodeName === b.nodeName) {
    reconcileAttributes(a, b);
    // Depth of the live element, not of the version's (the block may have moved: QA-G6-01).
    reconcileChildren(a, b, depthOf(a));
    return 'ok';
  }
  const copy = copyNode(b, undefined, depthOf(cur) + 1);
  if (!copy) return 'ok';
  const at = a ? (cur.toArray() as unknown[]).indexOf(a) : 0;
  if (a) cur.delete(at, 1);
  cur.insert(at, [copy]);
  return 'ok';
}

const isEmptyParagraph = (node: unknown): boolean => {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== 'blockContainer' || node.length !== 1) return false;
  const inner = node.get(0);
  return inner instanceof Y.XmlElement && inner.nodeName === 'paragraph' && inner.toArray().every((c) => c instanceof Y.XmlText && c.length === 0);
};

/** Where a reinserted block goes: `depth` is the depth the block itself will have (QA-G6-01). */
type Place = { kind: 'at'; parent: Parent; index: number; depth: number } | { kind: 'new-group'; owner: Y.XmlElement; depth: number } | { kind: 'root'; depth: number };

function nextTo(el: Y.XmlElement, after: boolean): Place | null {
  const parent = el.parent;
  if (!(parent instanceof Y.XmlElement) && !(parent instanceof Y.XmlFragment)) return null;
  const i = (parent.toArray() as unknown[]).indexOf(el);
  if (i < 0) return null;
  return { kind: 'at', parent, index: after ? i + 1 : i, depth: depthOf(el) };
}

/**
 * Puts a deleted block of the version back at the nearest place: after its previous sibling, else
 * before its next sibling, else first child of its parent block, else at the end of the page. Its
 * nested blocks come with it, except those that still exist elsewhere (no duplicate). The copy is
 * bounded at the place it lands (depth and width), like an edit through /collab.
 */
export function reinsertBlock(
  target: Y.Doc,
  source: Y.Doc,
  id: string,
  maps: RestoreMaps = mapsOf(target, source),
): 'ok' | 'exists' | 'missing' | 'not-in-version' {
  const src = maps.source.get(id);
  if (!src) return 'not-in-version';
  const current = maps.target;
  const exists = { has: (x: string) => !!live(current.get(x)) };
  if (exists.has(id)) return 'exists';
  const parent = src.parent;
  const siblings = parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment ? (parent.toArray() as unknown[]) : [];
  const i = siblings.indexOf(src);
  const liveSibling = (j: number) => {
    const sib = blockId(siblings[j]);
    return sib ? live(current.get(sib)) : undefined;
  };
  let place: Place | null = null;
  for (let j = i - 1; j >= 0 && !place; j--) {
    const el = liveSibling(j);
    if (el) place = nextTo(el, true);
  }
  for (let j = i + 1; j < siblings.length && !place; j++) {
    const el = liveSibling(j);
    if (el) place = nextTo(el, false);
  }
  if (!place) {
    // Parent block: a column holds blocks directly, a block container through its group.
    const owner = parent instanceof Y.XmlElement && parent.nodeName === GROUP ? parent.parent : parent;
    const ownerId = blockId(owner);
    const ownerEl = ownerId ? live(current.get(ownerId)) : undefined;
    if (ownerEl?.nodeName === 'blockContainer') {
      const group = (ownerEl.toArray() as unknown[]).find((k): k is Y.XmlElement => k instanceof Y.XmlElement && k.nodeName === GROUP);
      place = group ? { kind: 'at', parent: group, index: 0, depth: depthOf(group) + 1 } : { kind: 'new-group', owner: ownerEl, depth: depthOf(ownerEl) + 2 };
    } else if (ownerEl && src.nodeName !== 'column') {
      place = { kind: 'at', parent: ownerEl, index: 0, depth: depthOf(ownerEl) + 1 };
    }
  }
  // A column only makes sense inside its column list.
  if (!place && src.nodeName === 'column') return 'missing';
  place ??= { kind: 'root', depth: 2 };
  const copy = copyNode(src, exists, place.depth);
  if (!copy) return 'missing';
  if (place.kind === 'at') {
    if (place.parent.length >= MAX_CONTENT_CHILDREN) return 'missing';
    place.parent.insert(place.index, [copy]);
  } else if (place.kind === 'new-group') {
    const g = new Y.XmlElement(GROUP);
    g.insert(0, [copy]);
    place.owner.insert(place.owner.length, [g]);
  } else {
    const fragment = target.getXmlFragment(COLLAB_FRAGMENT);
    let root = fragment.length > 0 ? fragment.get(0) : null;
    if (!(root instanceof Y.XmlElement) || root.nodeName !== GROUP) {
      root = new Y.XmlElement(GROUP);
      fragment.insert(fragment.length, [root]);
    }
    const group = root as Y.XmlElement;
    if (group.length >= MAX_CONTENT_CHILDREN) return 'missing';
    // BlockNote keeps an empty trailing paragraph: the block goes before it.
    const end = group.length > 0 && isEmptyParagraph(group.get(group.length - 1)) ? group.length - 1 : group.length;
    group.insert(end, [copy]);
  }
  collectBlocks(copy, place.depth, current);
  return 'ok';
}

export interface ChosenBlocksResult {
  restored: string[];
  skipped: Array<{ blockId: string; reason: 'exists' | 'missing' | 'not-in-version' }>;
}

/** Applies the chosen items of a restore (request order, duplicates ignored), with shared block maps. */
export function restoreChosenBlocks(target: Y.Doc, source: Y.Doc, items: ReadonlyArray<{ blockId: string; action: 'reinsert' | 'revert' }>): ChosenBlocksResult {
  const out: ChosenBlocksResult = { restored: [], skipped: [] };
  const maps = mapsOf(target, source);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.blockId)) continue;
    seen.add(item.blockId);
    const r = item.action === 'reinsert' ? reinsertBlock(target, source, item.blockId, maps) : revertBlock(target, source, item.blockId, maps);
    if (r === 'ok') out.restored.push(item.blockId);
    else out.skipped.push({ blockId: item.blockId, reason: r });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block summaries (recovery list)
// ---------------------------------------------------------------------------

export interface BlockSummary {
  id: string;
  type: string;
  text: string;
  parentId: string | null;
}

function textOf(el: Y.XmlElement, max: number): string {
  let out = '';
  const stack: unknown[] = [el];
  while (stack.length > 0 && out.length < max) {
    const n = stack.pop();
    if (n instanceof Y.XmlText) {
      for (const op of n.toDelta() as Array<{ insert?: unknown }>) if (typeof op.insert === 'string') out += op.insert;
    } else if (n instanceof Y.XmlElement && n.nodeName !== GROUP && !BLOCK_NODES.has(n.nodeName)) {
      stack.push(...(n.toArray() as unknown[]).reverse());
    }
  }
  return out.slice(0, max);
}

/** Every block of a document with its type, an excerpt and its parent block. */
export function blockSummaries(doc: Y.Doc, maxText = 200): Map<string, BlockSummary> {
  const out = new Map<string, BlockSummary>();
  for (const [id, el] of blockMap(doc)) {
    let p: unknown = el.parent;
    while (p instanceof Y.XmlElement && !blockId(p)) p = p.parent;
    const content = el.nodeName === 'blockContainer' ? contentOf(el) : undefined;
    out.set(id, {
      id,
      type: content?.nodeName ?? el.nodeName,
      text: content ? textOf(content, maxText) : '',
      parentId: blockId(p),
    });
  }
  return out;
}

