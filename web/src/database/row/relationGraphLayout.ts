// Layout of the relation schema (D29): the database in the centre, the related databases on a circle,
// one curved edge per relation property (parallel links between the same two databases fan out).
// DOM-free, unit-tested under Node.
import type { RelationGraphResponse } from '@oriel/shared';

export interface GraphNode {
  id: string;
  title: string;
  icon: string | null;
  x: number;
  y: number;
  center: boolean;
}

export interface GraphEdge {
  key: string;
  fromId: string;
  toId: string;
  /** SVG path (quadratic curve) and label anchor. */
  path: string;
  labelX: number;
  labelY: number;
  label: string;
  twoWay: boolean;
  self: boolean;
}

export const NODE_W = 168;
export const NODE_H = 40;

/** Point where the segment from a box centre towards (tx, ty) leaves the box (2 px outside). */
function borderPoint(x: number, y: number, tx: number, ty: number): [number, number] {
  const dx = tx - x;
  const dy = ty - y;
  if (dx === 0 && dy === 0) return [x, y];
  const t = Math.min(dx ? (NODE_W / 2 + 2) / Math.abs(dx) : Infinity, dy ? (NODE_H / 2 + 2) / Math.abs(dy) : Infinity);
  return [Math.round(x + dx * Math.min(t, 1)), Math.round(y + dy * Math.min(t, 1))];
}

export function layoutRelationGraph(graph: RelationGraphResponse): { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number } {
  const [centre, ...others] = graph.databases;
  if (!centre) return { nodes: [], edges: [], width: 0, height: 0 };
  const n = others.length;
  // Radius large enough for the boxes not to overlap on the circle.
  const radius = n === 0 ? 0 : Math.max(n <= 2 ? 150 : 200, (n * (NODE_W + 24)) / (2 * Math.PI));
  const raw: GraphNode[] = [{ ...centre, x: 0, y: 0, center: true }];
  others.forEach((d, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    raw.push({ ...d, x: Math.round(radius * Math.cos(a)), y: Math.round(radius * Math.sin(a)), center: false });
  });
  // Tight frame around the boxes (plus room for labels and self loops above).
  const selfLoops = graph.links.some((l) => l.fromId === l.toId);
  const padX = NODE_W / 2 + 24;
  const padY = NODE_H / 2 + 24;
  const minX = Math.min(...raw.map((nd) => nd.x)) - padX;
  const maxX = Math.max(...raw.map((nd) => nd.x)) + padX;
  const minY = Math.min(...raw.map((nd) => nd.y)) - padY - (selfLoops ? 80 : 0);
  const maxY = Math.max(...raw.map((nd) => nd.y)) + padY;
  const nodes = raw.map((nd) => ({ ...nd, x: nd.x - minX, y: nd.y - minY }));
  const frameW = Math.ceil(maxX - minX);
  const frameH = Math.ceil(maxY - minY);
  const pos = new Map(nodes.map((nd) => [nd.id, nd] as const));
  const pairCount = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const l of graph.links) pairCount.set(pairKey(l.fromId, l.toId), (pairCount.get(pairKey(l.fromId, l.toId)) ?? 0) + 1);

  const edges: GraphEdge[] = [];
  for (const l of graph.links) {
    const a = pos.get(l.fromId);
    const b = pos.get(l.toId);
    if (!a || !b) continue;
    const key = pairKey(l.fromId, l.toId);
    const index = pairIndex.get(key) ?? 0;
    pairIndex.set(key, index + 1);
    const count = pairCount.get(key) ?? 1;
    const label = l.twoWay && l.mirrorName ? `${l.propertyName} ⇄ ${l.mirrorName}` : l.propertyName;
    if (a.id === b.id) {
      // Self relation: a loop above the node.
      const h = 48 + index * 22;
      const path = `M ${a.x - 30} ${a.y - NODE_H / 2} C ${a.x - 50} ${a.y - NODE_H / 2 - h}, ${a.x + 50} ${a.y - NODE_H / 2 - h}, ${a.x + 30} ${a.y - NODE_H / 2}`;
      edges.push({ key: `${l.fromId}:${l.propertyId}`, fromId: a.id, toId: b.id, path, labelX: a.x, labelY: a.y - NODE_H / 2 - h * 0.75, label, twoWay: l.twoWay, self: true });
      continue;
    }
    // Parallel links bend symmetrically around the straight line.
    const offset = (index - (count - 1) / 2) * 36;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Normal oriented the same way for both directions of a pair (stable fan-out).
    const sign = a.id < b.id ? 1 : -1;
    const qx = mx + (-dy / len) * offset * 2 * sign;
    const qy = my + (dx / len) * offset * 2 * sign;
    // Ends on the box borders (so that the arrow heads stay visible), towards the control point.
    const [sx, sy] = borderPoint(a.x, a.y, qx, qy);
    const [ex, ey] = borderPoint(b.x, b.y, qx, qy);
    edges.push({
      key: `${l.fromId}:${l.propertyId}`,
      fromId: a.id,
      toId: b.id,
      path: `M ${sx} ${sy} Q ${qx} ${qy} ${ex} ${ey}`,
      labelX: (mx + qx) / 2,
      labelY: (my + qy) / 2,
      label,
      twoWay: l.twoWay,
      self: false,
    });
  }
  return { nodes, edges, width: frameW, height: frameH };
}
