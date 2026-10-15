// Version history (G6): comparison of two block trees. Pure logic, tested (diff.test.ts); run in a
// Web Worker for large pages (runDiff.ts).
import { base64ToBytes, plainText, treeFromState, type HBlock, type HSeg } from './tree';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export type TextOpKind = 'eq' | 'ins' | 'del';
export interface TextOp {
  op: TextOpKind;
  text: string;
}

/** Words, runs of spaces and single punctuation marks. */
const TOKEN_RE = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu;
export const tokenize = (s: string): string[] => s.match(TOKEN_RE) ?? [];

/** Above this, a text is shown as fully replaced instead of diffed word by word. */
const MAX_TOKENS = 20_000;
const MAX_EDITS = 4_000;

/**
 * Myers' O((N+M)·D) shortest edit script on token arrays (common prefix and suffix trimmed first).
 * Returns null when the texts are too large or too different to be worth a fine diff.
 */
function myers(a: string[], b: string[]): TextOpKind[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const maxD = Math.min(max, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    const next = v;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Backtrack.
  const ops: TextOpKind[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && pv[offset + k - 1]! < pv[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = pv[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('eq');
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push('ins');
      y--;
    } else {
      ops.push('del');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('eq');
    x--;
    y--;
  }
  return ops.reverse();
}

function pushOp(out: TextOp[], op: TextOpKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

/** Word-level difference between two texts (insertions and deletions in reading order). */
export function diffText(before: string, after: string): TextOp[] {
  if (before === after) return before ? [{ op: 'eq', text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: TextOp[] = [];
  pushOp(out, 'eq', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const script = midA.length + midB.length <= MAX_TOKENS ? myers(midA, midB) : null;
  if (!script) {
    pushOp(out, 'del', midA.join(''));
    pushOp(out, 'ins', midB.join(''));
  } else {
    // Deletions before insertions inside each changed run reads better.
    let i = 0;
    let j = 0;
    let del = '';
    let ins = '';
    const flush = () => {
      pushOp(out, 'del', del);
      pushOp(out, 'ins', ins);
      del = '';
      ins = '';
    };
    for (const op of script) {
      if (op === 'eq') {
        flush();
        pushOp(out, 'eq', midA[i]!);
        i++;
        j++;
      } else if (op === 'del') del += midA[i++]!;
      else ins += midB[j++]!;
    }
    flush();
  }
  pushOp(out, 'eq', a.slice(endA).join(''));
  return joinChanges(out);
}

/** Folds a space between two changes into them: « un drone » → « une perche son » reads as one change. */
function joinChanges(ops: TextOp[]): TextOp[] {
  const out: TextOp[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.op === 'eq') {
      out.push({ ...op });
      i++;
      continue;
    }
    let del = '';
    let ins = '';
    while (i < ops.length) {
      const cur = ops[i]!;
      if (cur.op === 'del') del += cur.text;
      else if (cur.op === 'ins') ins += cur.text;
      else if (/^\s+$/.test(cur.text) && i + 1 < ops.length && ops[i + 1]!.op !== 'eq') {
        del += cur.text;
        ins += cur.text;
      } else break;
      i++;
    }
    if (del) out.push({ op: 'del', text: del });
    if (ins) out.push({ op: 'ins', text: ins });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type BlockStatus = 'same' | 'added' | 'removed' | 'modified';

export interface PropChange {
  key: string;
  before: string | null;
  after: string | null;
}

export interface DiffNode {
  id: string;
  status: BlockStatus;
  /** Matched block whose parent or rank among its siblings changed. */
  moved: boolean;
  /** Block as it is on the newer side (the older one for a removed block). */
  block: HBlock;
  /** Older side of a matched block. */
  old?: HBlock;
  /** Type change of a matched block (older type). */
  oldType?: string;
  /** Text changes of a modified block (absent when its text did not change). */
  text?: TextOp[];
  /** Same text, different formatting or inline references. */
  formatChanged?: boolean;
  props: PropChange[];
  children: DiffNode[];
}

export interface DiffStats {
  added: number;
  removed: number;
  modified: number;
  moved: number;
  same: number;
}

export interface DiffResult {
  nodes: DiffNode[];
  stats: DiffStats;
}

interface Located {
  block: HBlock;
  parent: string | null;
  index: number;
}

function index(blocks: HBlock[], parent: string | null, into: Map<string, Located>): void {
  blocks.forEach((block, i) => {
    if (!into.has(block.id)) into.set(block.id, { block, parent, index: i });
    index(block.children, block.id, into);
  });
}

/** Positions (in `seq`) of a longest strictly increasing subsequence. */
function lisPositions(seq: number[]): Set<number> {
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
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k]!;
  }
  return keep;
}

function propChanges(a: Record<string, string>, b: Record<string, string>): PropChange[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: PropChange[] = [];
  for (const key of keys) {
    const before = a[key] ?? null;
    const after = b[key] ?? null;
    if (before !== after) out.push({ key, before, after });
  }
  return out;
}

const sameSegs = (a: HSeg[], b: HSeg[]): boolean => a.length === b.length && a.every((s, i) => s.t === b[i]!.t && s.m === b[i]!.m);

/**
 * Compares an older and a newer block tree. Blocks are matched by id; the result is the newer tree
 * with the removed blocks put back at their old place (after their nearest previous old sibling).
 */
export function diffTrees(older: HBlock[], newer: HBlock[]): DiffResult {
  const oldIdx = new Map<string, Located>();
  const newIdx = new Map<string, Located>();
  index(older, null, oldIdx);
  index(newer, null, newIdx);
  const stats: DiffStats = { added: 0, removed: 0, modified: 0, moved: 0, same: 0 };

  // Moves: another parent, or out of the longest run kept in order among the siblings.
  const moved = new Set<string>();
  const byParent = new Map<string | null, string[]>();
  for (const [id, loc] of newIdx) {
    const o = oldIdx.get(id);
    if (!o) continue;
    if (o.parent !== loc.parent) {
      moved.add(id);
      continue;
    }
    const list = byParent.get(loc.parent) ?? [];
    list.push(id);
    byParent.set(loc.parent, list);
  }
  for (const ids of byParent.values()) {
    ids.sort((x, y) => newIdx.get(x)!.index - newIdx.get(y)!.index);
    const keep = lisPositions(ids.map((id) => oldIdx.get(id)!.index));
    ids.forEach((id, i) => {
      if (!keep.has(i)) moved.add(id);
    });
  }

  const removedNode = (block: HBlock): DiffNode => {
    stats.removed++;
    return { id: block.id, status: 'removed', moved: false, block, props: [], children: merge([], block.children) };
  };

  const matchedNode = (block: HBlock, old: HBlock): DiffNode => {
    const node: DiffNode = { id: block.id, status: 'same', moved: moved.has(block.id), block, old, props: propChanges(old.props, block.props), children: [] };
    if (old.type !== block.type) node.oldType = old.type;
    if (!sameSegs(old.segs, block.segs)) {
      const a = plainText(old);
      const b = plainText(block);
      if (a === b) node.formatChanged = true;
      else node.text = diffText(a, b);
    }
    if (node.oldType || node.text || node.formatChanged || node.props.length > 0) node.status = 'modified';
    if (node.status === 'modified') stats.modified++;
    else stats.same++;
    if (node.moved) stats.moved++;
    node.children = merge(block.children, old.children);
    return node;
  };

  function merge(newKids: HBlock[], oldKids: HBlock[]): DiffNode[] {
    const out: DiffNode[] = newKids.map((b) => {
      const o = oldIdx.get(b.id);
      if (o) return matchedNode(b, o.block);
      stats.added++;
      return { id: b.id, status: 'added', moved: false, block: b, props: [], children: merge(b.children, []) };
    });
    // Removed blocks of this (old) sibling list, at their old place.
    let anchor = -1; // position in `out` after which the next removed block goes
    for (const o of oldKids) {
      if (newIdx.has(o.id)) {
        const at = out.findIndex((n) => n.id === o.id);
        if (at >= 0) anchor = at;
        continue;
      }
      const node = removedNode(o);
      out.splice(anchor + 1, 0, node);
      anchor++;
    }
    return out;
  }

  const nodes = merge(newer, older);
  return { nodes, stats };
}

// ---------------------------------------------------------------------------
// Display rows (« Changements seulement »)
// ---------------------------------------------------------------------------

export type DiffRow = { kind: 'block'; node: DiffNode; depth: number; context: boolean } | { kind: 'gap'; count: number; depth: number };

const interesting = (n: DiffNode): boolean => n.status !== 'same' || n.moved || n.children.some(interesting);

const countBlocks = (n: DiffNode): number => 1 + n.children.reduce((s, c) => s + countBlocks(c), 0);

/**
 * Flattens the merged tree into rows. With `changesOnly`, runs of unchanged blocks become gaps
 * (« n blocs inchangés ») and an unchanged block is kept only as the parent (context) of a change.
 */
export function diffRows(nodes: DiffNode[], changesOnly: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  const walk = (list: DiffNode[], depth: number) => {
    let gap = 0;
    const flushGap = () => {
      if (gap > 0) rows.push({ kind: 'gap', count: gap, depth });
      gap = 0;
    };
    for (const n of list) {
      if (changesOnly && !interesting(n)) {
        gap += countBlocks(n);
        continue;
      }
      flushGap();
      rows.push({ kind: 'block', node: n, depth, context: n.status === 'same' && !n.moved });
      walk(n.children, depth + 1);
    }
    flushGap();
  };
  walk(nodes, 0);
  return rows;
}

/** Ids of the rows that are changes, in display order (navigation « précédent / suivant »). */
export const changeIds = (rows: DiffRow[]): string[] =>
  rows.flatMap((r) => (r.kind === 'block' && !r.context ? [r.node.id] : []));

// ---------------------------------------------------------------------------
// Whole comparison of two base64 Yjs states (worker and main thread)
// ---------------------------------------------------------------------------

export type DiffOutcome = { kind: 'ok'; result: DiffResult } | { kind: 'too-large' } | { kind: 'error'; message: string };

export function compareStates(older: string, newer: string): DiffOutcome {
  try {
    const a = treeFromState(base64ToBytes(older));
    const b = treeFromState(base64ToBytes(newer));
    if (a.truncated || b.truncated) return { kind: 'too-large' };
    return { kind: 'ok', result: diffTrees(a.blocks, b.blocks) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
