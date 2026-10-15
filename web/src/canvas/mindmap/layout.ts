// Mind map layout (H1, lot B): pure function from a node tree to positioned boxes and links.
// Coordinates are relative to the root node's top-left corner. Horizontal tidy tree: each subtree
// takes the height of its visible descendants; children are stacked and centred on their parent.
// `balanced` splits the root's children in two sides of similar height (first ones on the right).
import type { CanvasColor, MindNode, MindmapLayout, MindmapStyle } from '@oriel/shared';

export interface MindBox {
  id: string;
  text: string;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 = right of its parent, -1 = left, 0 = root. */
  side: 1 | -1 | 0;
  parentId: string | null;
  /** Hidden descendants (collapsed branch), else 0. */
  hidden: number;
  hasChildren: boolean;
  color: CanvasColor;
}

export interface MindLink {
  from: string;
  to: string;
  side: 1 | -1;
  color: CanvasColor;
}

export interface MindLayout {
  boxes: MindBox[];
  byId: Map<string, MindBox>;
  links: MindLink[];
  bounds: { x: number; y: number; w: number; h: number };
}

export type Measure = (text: string, depth: number) => { w: number; h: number };

export const MIND_FONT = (depth: number) => (depth === 0 ? 20 : depth === 1 ? 16 : 14);
const BRANCH_COLORS: CanvasColor[] = ['blue', 'orange', 'green', 'purple', 'pink', 'red', 'yellow', 'brown'];

/** Approximation without a DOM (tests, server-like contexts): average glyph width ≈ 0.58 em. */
export const estimateMeasure: Measure = (text, depth) => {
  const fs = MIND_FONT(depth);
  const padX = depth === 0 ? 20 : 12;
  const padY = depth === 0 ? 12 : 7;
  const maxText = 280;
  const textW = Math.max(fs * 2, [...text].length * fs * 0.58);
  const lines = Math.max(1, Math.ceil(textW / maxText));
  return { w: Math.round(Math.min(textW, maxText) + padX * 2), h: Math.round(lines * fs * 1.35 + padY * 2) };
};

export function countDescendants(node: MindNode): number {
  let n = 0;
  const stack = [...node.children];
  while (stack.length > 0) {
    const c = stack.pop()!;
    n++;
    stack.push(...c.children);
  }
  return n;
}

interface Sized {
  node: MindNode;
  depth: number;
  w: number;
  h: number;
  /** Height of the visible subtree. */
  span: number;
  children: Sized[];
  color: CanvasColor;
}

export function layoutMindmap(
  root: MindNode,
  opts: { layout: MindmapLayout; style: MindmapStyle; measure?: Measure },
): MindLayout {
  const measure = opts.measure ?? estimateMeasure;
  const hGap = opts.style === 'minimal' ? 36 : 52;
  const vGap = opts.style === 'minimal' ? 8 : 14;

  const size = (node: MindNode, depth: number, color: CanvasColor): Sized => {
    const { w, h } = measure(node.text, depth);
    const children = node.collapsed ? [] : node.children.map((c, i) => size(c, depth + 1, c.color ?? (depth === 0 ? BRANCH_COLORS[i % BRANCH_COLORS.length]! : color)));
    const childSpan = children.reduce((sum, c) => sum + c.span, 0) + Math.max(0, children.length - 1) * vGap;
    return { node, depth, w, h, span: Math.max(h, childSpan), children, color };
  };
  const top = size(root, 0, root.color ?? 'default');

  const boxes: MindBox[] = [];
  const links: MindLink[] = [];
  const place = (s: Sized, x: number, centerY: number, side: 1 | -1 | 0, parentId: string | null) => {
    const box: MindBox = {
      id: s.node.id,
      text: s.node.text,
      depth: s.depth,
      x,
      y: centerY - s.h / 2,
      w: s.w,
      h: s.h,
      side,
      parentId,
      hidden: s.node.collapsed ? countDescendants(s.node) : 0,
      hasChildren: s.node.children.length > 0,
      color: s.color,
    };
    boxes.push(box);
    placeChildren(s, box, s.children, side === 0 ? 1 : side);
  };
  const placeChildren = (parent: Sized, box: MindBox, children: Sized[], side: 1 | -1) => {
    if (children.length === 0) return;
    const total = children.reduce((sum, c) => sum + c.span, 0) + (children.length - 1) * vGap;
    let y = box.y + box.h / 2 - total / 2;
    for (const c of children) {
      const cx = side === 1 ? box.x + box.w + hGap : box.x - hGap - c.w;
      place(c, cx, y + c.span / 2, side, parent.node.id);
      links.push({ from: parent.node.id, to: c.node.id, side, color: c.color });
      y += c.span + vGap;
    }
  };

  // Root at (0, 0); its children go right, left or both.
  const rootBox: MindBox = {
    id: root.id,
    text: root.text,
    depth: 0,
    x: 0,
    y: 0,
    w: top.w,
    h: top.h,
    side: 0,
    parentId: null,
    hidden: root.collapsed ? countDescendants(root) : 0,
    hasChildren: root.children.length > 0,
    color: top.color,
  };
  boxes.push(rootBox);
  if (opts.layout === 'right') placeChildren(top, rootBox, top.children, 1);
  else if (opts.layout === 'left') placeChildren(top, rootBox, top.children, -1);
  else {
    const [right, left] = splitBalanced(top.children);
    placeChildren(top, rootBox, right, 1);
    placeChildren(top, rootBox, left, -1);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { boxes, byId: new Map(boxes.map((b) => [b.id, b])), links, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/** First children on the right until about half of the total height, the rest on the left. */
function splitBalanced(children: Sized[]): [Sized[], Sized[]] {
  if (children.length <= 1) return [children, []];
  const total = children.reduce((sum, c) => sum + c.span, 0);
  const right: Sized[] = [];
  let acc = 0;
  for (const c of children) {
    if (right.length > 0 && acc + c.span / 2 > total / 2) break;
    right.push(c);
    acc += c.span;
  }
  if (right.length === children.length) right.pop();
  return [right, children.slice(right.length)];
}
