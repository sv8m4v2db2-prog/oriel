// Version history (G6): neutral block tree of a BlockNote Yjs document, for comparison.
// Pure (yjs only): runs in a Web Worker as well as in node tests.
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';

/** A run of text with its formatting (`m`: canonical key of the marks, '' when none). */
export interface HSeg {
  t: string;
  m: string;
}

export interface HBlock {
  id: string;
  /** Content node name (`paragraph`, `heading`…), or the structural node (`columnList`, `column`). */
  type: string;
  /** Attributes of the block container and of its content node (`id` excluded). */
  props: Record<string, string>;
  segs: HSeg[];
  children: HBlock[];
}

export interface HTree {
  blocks: HBlock[];
  /** Number of blocks read (nested included). */
  count: number;
  /** More blocks than `maxBlocks`: the tree is incomplete and must not be compared. */
  truncated: boolean;
}

/** Above this many blocks a comparison is refused (SPEC: the preview stays available). */
export const MAX_DIFF_BLOCKS = 20_000;
const MAX_DEPTH = 300;

const GROUP = 'blockGroup';
const CONTAINER = 'blockContainer';
const ROWS = new Set(['tableRow']);
const CELLS = new Set(['tableCell', 'tableHeader']);
/** Placeholder of an embedded non-text item inside a text. */
export const EMBED_CHAR = '￼';

/** Settings the editor writes with their default value: absent and default compare equal. */
const DEFAULT_ATTRS: Record<string, string> = { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' };

const plainAttr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
};

function attrsOf(el: Y.XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.getAttributes() as Record<string, unknown>)) {
    const s = plainAttr(v);
    if (s !== null && k !== 'id' && DEFAULT_ATTRS[k] !== s) out[k] = s;
  }
  return out;
}

/** Canonical key of a set of marks (sorted), '' when there is none. */
export function marksKey(attrs: Record<string, unknown> | null | undefined): string {
  if (!attrs) return '';
  const keys = Object.keys(attrs).filter((k) => attrs[k] !== null && attrs[k] !== undefined).sort();
  if (keys.length === 0) return '';
  return JSON.stringify(keys.map((k) => [k, attrs[k]]));
}

/** Visible label of an inline node (mention, page link…). */
function inlineLabel(el: Y.XmlElement): string {
  const a = el.getAttributes() as Record<string, unknown>;
  for (const key of ['label', 'name', 'title', 'text', 'date', 'user', 'pageId']) {
    const v = a[key];
    if (typeof v === 'string' && v) return key === 'pageId' ? '↗ page' : key === 'user' ? `@${v}` : v;
  }
  return EMBED_CHAR;
}

function pushSeg(out: HSeg[], t: string, m: string): void {
  if (!t) return;
  const last = out[out.length - 1];
  if (last && last.m === m) last.t += t;
  else out.push({ t, m });
}

function textInto(el: Y.XmlElement | Y.XmlText, out: HSeg[], depth: number): void {
  if (el instanceof Y.XmlText) {
    for (const op of el.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
      if (typeof op.insert === 'string') pushSeg(out, op.insert, marksKey(op.attributes));
      else pushSeg(out, EMBED_CHAR, '#embed');
    }
    return;
  }
  if (depth > MAX_DEPTH) return;
  const name = el.nodeName;
  if (name === 'hardBreak') {
    pushSeg(out, '\n', '');
    return;
  }
  const kids = el.toArray() as unknown[];
  if (kids.length === 0) {
    // Atomic inline node (mention, page reference…): one token, compared by its attributes.
    pushSeg(out, inlineLabel(el), `#${name}${marksKey(el.getAttributes() as Record<string, unknown>)}`);
    return;
  }
  for (const kid of kids) {
    if (kid instanceof Y.XmlText || kid instanceof Y.XmlElement) textInto(kid, out, depth + 1);
  }
  if (CELLS.has(name)) pushSeg(out, '\t', '');
  else if (ROWS.has(name)) pushSeg(out, '\n', '');
}

interface Walk {
  count: number;
  max: number;
  truncated: boolean;
  anon: number;
}

function blocksOf(nodes: unknown[], w: Walk, depth: number, parentId: string): HBlock[] {
  const out: HBlock[] = [];
  if (depth > MAX_DEPTH) return out;
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === GROUP) {
      out.push(...blocksOf(node.toArray() as unknown[], w, depth + 1, parentId));
      continue;
    }
    if (w.count >= w.max) {
      w.truncated = true;
      return out;
    }
    w.count++;
    const rawId = node.getAttribute('id');
    const id = typeof rawId === 'string' && rawId ? rawId : `~${parentId}/${w.anon++}`;
    if (node.nodeName === CONTAINER) {
      const kids = node.toArray() as unknown[];
      const content = kids.find((k): k is Y.XmlElement => k instanceof Y.XmlElement && k.nodeName !== GROUP);
      const group = kids.find((k): k is Y.XmlElement => k instanceof Y.XmlElement && k.nodeName === GROUP);
      const segs: HSeg[] = [];
      if (content) textInto(content, segs, depth + 1);
      out.push({
        id,
        type: content?.nodeName ?? 'paragraph',
        props: { ...attrsOf(node), ...(content ? attrsOf(content) : {}) },
        segs,
        children: group ? blocksOf(group.toArray() as unknown[], w, depth + 1, id) : [],
      });
    } else {
      // Structural block (columns…) or unknown element: its element children are blocks.
      const kids = node.toArray() as unknown[];
      const hasBlocks = kids.some((k) => k instanceof Y.XmlElement && (k.nodeName === CONTAINER || k.nodeName === GROUP || k.getAttribute('id')));
      const segs: HSeg[] = [];
      if (!hasBlocks) textInto(node, segs, depth + 1);
      out.push({ id, type: node.nodeName, props: attrsOf(node), segs, children: hasBlocks ? blocksOf(kids, w, depth + 1, id) : [] });
    }
  }
  return out;
}

export function treeFromDoc(doc: Y.Doc, maxBlocks = MAX_DIFF_BLOCKS): HTree {
  const w: Walk = { count: 0, max: maxBlocks, truncated: false, anon: 0 };
  const blocks = blocksOf(doc.getXmlFragment(COLLAB_FRAGMENT).toArray() as unknown[], w, 0, '');
  return { blocks, count: w.count, truncated: w.truncated };
}

/** Tree of a full Yjs state (as returned by the snapshot and content routes). */
export function treeFromState(state: Uint8Array, maxBlocks = MAX_DIFF_BLOCKS): HTree {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return treeFromDoc(doc, maxBlocks);
  } finally {
    doc.destroy();
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const plainText = (b: Pick<HBlock, 'segs'>): string => b.segs.map((s) => s.t).join('');
