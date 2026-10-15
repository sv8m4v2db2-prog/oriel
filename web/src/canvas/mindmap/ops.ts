// Mind map tree operations (H1, lot B): immutable edits used by the keyboard commands, import
// from a bullet list / Markdown and export to a nested Markdown list. Pure functions.
import { CANVAS_LIMITS, type MindNode } from '@oriel/shared';
import { cid } from '../model';

export interface Found {
  node: MindNode;
  parent: MindNode | null;
  index: number;
  depth: number;
}

export function findNode(root: MindNode, id: string): Found | null {
  const stack: Found[] = [{ node: root, parent: null, index: 0, depth: 0 }];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (f.node.id === id) return f;
    f.node.children.forEach((c, i) => stack.push({ node: c, parent: f.node, index: i, depth: f.depth + 1 }));
  }
  return null;
}

export function countNodes(root: MindNode): number {
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const c = stack.pop()!;
    n++;
    stack.push(...c.children);
  }
  return n;
}

/** Copy of the tree where `fn` replaced the node `id` (the other nodes are shared). */
export function mapNode(root: MindNode, id: string, fn: (n: MindNode) => MindNode): MindNode {
  if (root.id === id) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const next = mapNode(c, id, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

const fits = (root: MindNode, depth: number) => countNodes(root) < CANVAS_LIMITS.mindmapNodes && depth <= CANVAS_LIMITS.mindmapDepth;

/** Adds an empty child (last) to `id` and unfolds it. Null when a bound is reached. */
export function addChild(root: MindNode, id: string, text = ''): { root: MindNode; id: string } | null {
  const f = findNode(root, id);
  if (!f || !fits(root, f.depth + 1)) return null;
  const child: MindNode = { id: cid(), text, children: [] };
  return { root: mapNode(root, id, (n) => ({ ...n, collapsed: undefined, children: [...n.children, child] })), id: child.id };
}

/** Adds a sibling right after `id` (a child for the root). */
export function addSibling(root: MindNode, id: string, text = ''): { root: MindNode; id: string } | null {
  const f = findNode(root, id);
  if (!f) return null;
  if (!f.parent) return addChild(root, id, text);
  if (!fits(root, f.depth)) return null;
  const sibling: MindNode = { id: cid(), text, children: [] };
  return {
    root: mapNode(root, f.parent.id, (p) => ({ ...p, children: [...p.children.slice(0, f.index + 1), sibling, ...p.children.slice(f.index + 1)] })),
    id: sibling.id,
  };
}

/** Removes `id` and its branch; returns the node to select next. Null tree when the root is removed. */
export function removeNode(root: MindNode, id: string): { root: MindNode | null; next: string | null } {
  const f = findNode(root, id);
  if (!f) return { root, next: null };
  if (!f.parent) return { root: null, next: null };
  const siblings = f.parent.children;
  const next = siblings[f.index + 1]?.id ?? siblings[f.index - 1]?.id ?? f.parent.id;
  return { root: mapNode(root, f.parent.id, (p) => ({ ...p, children: p.children.filter((c) => c.id !== id) })), next };
}

export const setText = (root: MindNode, id: string, text: string) =>
  mapNode(root, id, (n) => ({ ...n, text: text.slice(0, CANVAS_LIMITS.mindmapText) }));

export function toggleCollapsed(root: MindNode, id: string): MindNode {
  return mapNode(root, id, (n) => (n.children.length === 0 ? n : n.collapsed ? { ...n, collapsed: undefined } : { ...n, collapsed: true }));
}

/** JSON-clean copy (drops `undefined` keys written by the immutable helpers). */
export function clean(node: MindNode): MindNode {
  const out: MindNode = { id: node.id, text: node.text, children: node.children.map(clean) };
  if (node.collapsed) out.collapsed = true;
  if (node.color) out.color = node.color;
  return out;
}

/** Neighbour for arrow keys, following the visual layout (`side`: direction of the branch). */
export function neighbour(root: MindNode, id: string, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', side: 1 | -1 | 0): string | null {
  const f = findNode(root, id);
  if (!f) return null;
  const outward = side === -1 ? 'ArrowLeft' : 'ArrowRight';
  const inward = side === -1 ? 'ArrowRight' : 'ArrowLeft';
  if (key === outward || (side === 0 && (key === 'ArrowLeft' || key === 'ArrowRight'))) {
    return f.node.collapsed ? null : (f.node.children[0]?.id ?? null);
  }
  if (key === inward) return f.parent?.id ?? null;
  if (!f.parent) return null;
  const sib = f.parent.children[f.index + (key === 'ArrowUp' ? -1 : 1)];
  return sib?.id ?? null;
}

// --- import / export ---------------------------------------------------------------------------

const BULLET = /^(\s*)(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Whether pasted text looks like a list or an outline worth turning into a mind map. */
export function looksLikeOutline(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const structured = lines.filter((l) => BULLET.test(l) || HEADING.test(l.trim())).length;
  return structured >= Math.max(2, Math.ceil(lines.length * 0.6));
}

const stripInline = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\([^)]*\)/g, '$1')
    .trim();

/**
 * Tree from a bullet list or Markdown outline: headings nest by level, bullets by indentation
 * (2 spaces or a tab per level) under the last heading. Several top-level items get a common root
 * named `fallbackRoot`. Bounded by the mind map limits (extra items are dropped).
 */
export function fromOutline(text: string, fallbackRoot = 'Idée centrale'): MindNode | null {
  const virtual: MindNode = { id: cid(), text: fallbackRoot, children: [] };
  // Stack of [level, node]; headings use levels 0–5, bullets 10 + indentation.
  const stack: Array<{ level: number; node: MindNode; depth: number }> = [{ level: -1, node: virtual, depth: 0 }];
  let count = 1;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let level: number;
    let label: string;
    const h = HEADING.exec(raw.trim());
    const b = BULLET.exec(raw.replace(/\t/g, '  '));
    if (h) {
      level = h[1]!.length - 1;
      label = h[2]!;
    } else if (b) {
      level = 10 + Math.floor(b[1]!.length / 2);
      label = b[2]!;
    } else {
      level = 10 + Math.floor((/^\s*/.exec(raw.replace(/\t/g, '  '))?.[0].length ?? 0) / 2);
      label = raw;
    }
    label = stripInline(label).slice(0, CANVAS_LIMITS.mindmapText);
    if (!label) continue;
    while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop();
    const parent = stack[stack.length - 1]!;
    if (count >= CANVAS_LIMITS.mindmapNodes || parent.depth + 1 > CANVAS_LIMITS.mindmapDepth) continue;
    const node: MindNode = { id: cid(), text: label, children: [] };
    parent.node.children.push(node);
    count++;
    stack.push({ level, node, depth: parent.depth + 1 });
  }
  if (virtual.children.length === 0) return null;
  if (virtual.children.length === 1) return virtual.children[0]!;
  return virtual;
}

/** Nested Markdown list of the whole tree (collapsed branches included). */
export function toOutline(root: MindNode): string {
  const lines: string[] = [];
  const visit = (n: MindNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}- ${n.text || 'Sans titre'}`);
    for (const c of n.children) visit(c, depth + 1);
  };
  visit(root, 0);
  return lines.join('\n');
}
