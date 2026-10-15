// Canvas geometry (H1): bounds, hit testing, connector routing, snapping, alignment and resizing.
// Pure functions over canvas objects; the editor and the export share them.
import type { CanvasConnector, CanvasEnd, CanvasMindmap, CanvasObject } from '@oriel/shared';
import { layoutMindmap, type MindLayout, type Measure } from './mindmap/layout';
import type { Point, Rect } from './model';

export type Getter = (id: string) => CanvasObject | undefined;

// --- mind maps --------------------------------------------------------------------------------

let measureFn: Measure | undefined;
/** The browser installs a text measure based on canvas 2D (more exact than the estimate). */
export function setMindMeasure(m: Measure | undefined) {
  measureFn = m;
  layouts = new WeakMap();
}
let layouts = new WeakMap<CanvasMindmap, MindLayout>();
/** Layout of a mind map object (cached by object identity: snapshots are immutable). */
export function mindLayoutOf(o: CanvasMindmap): MindLayout {
  let l = layouts.get(o);
  if (!l) {
    l = layoutMindmap(o.root, { layout: o.layout, style: o.style, measure: measureFn });
    layouts.set(o, l);
  }
  return l;
}

// --- rects -----------------------------------------------------------------------------------

export const rectCenter = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const containsRect = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const containsPoint = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export function unionRects(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Bounds of an object in canvas units (connectors: their route; mind maps: their layout). */
export function objectBounds(o: CanvasObject, get: Getter): Rect {
  if (o.type === 'connector') {
    const route = connectorRoute(o, get);
    const r = unionRects(route.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))) ?? { x: 0, y: 0, w: 0, h: 0 };
    const pad = o.strokeWidth + 6;
    return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  }
  if (o.type === 'mindmap') {
    const b = mindLayoutOf(o).bounds;
    return { x: o.x + b.x, y: o.y + b.y, w: b.w, h: b.h };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

// --- strokes ---------------------------------------------------------------------------------

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Points of a stroke in canvas units. */
export function strokePoints(o: { x: number; y: number; points: number[] }): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < o.points.length; i += 2) out.push({ x: o.x + o.points[i]!, y: o.y + o.points[i + 1]! });
  return out;
}

export function nearPolyline(points: Point[], p: Point, radius: number): boolean {
  if (points.length === 1) return Math.hypot(points[0]!.x - p.x, points[0]!.y - p.y) <= radius;
  for (let i = 1; i < points.length; i++) if (distToSegment(p, points[i - 1]!, points[i]!) <= radius) return true;
  return false;
}

/** Stroke box from absolute points: (x, y) top-left, points relative, w/h with the pen size. */
export function strokeFromPoints(abs: Point[], size: number): { x: number; y: number; w: number; h: number; points: number[] } {
  const r = unionRects(abs.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!;
  const pad = size / 2;
  const x = r.x - pad;
  const y = r.y - pad;
  const points: number[] = [];
  for (const p of abs) points.push(Math.round((p.x - x) * 10) / 10, Math.round((p.y - y) * 10) / 10);
  return { x, y, w: r.w + size, h: r.h + size, points };
}

/** Drops points closer than `min` to the previous kept one (keeps first and last). */
export function simplify(points: Point[], min: number): Point[] {
  if (points.length <= 2) return points;
  const out = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]!;
    if (Math.hypot(points[i]!.x - last.x, points[i]!.y - last.y) >= min) out.push(points[i]!);
  }
  out.push(points[points.length - 1]!);
  return out;
}

// --- connectors --------------------------------------------------------------------------------

export interface Route {
  points: Point[];
  /** SVG path. */
  d: string;
  start: Point;
  end: Point;
  /** Direction of travel at each end (radians), pointing out of the line. */
  startAngle: number;
  endAngle: number;
  mid: Point;
}

const isAttached = (e: CanvasEnd): e is { id: string; ax?: number; ay?: number } => 'id' in e;

function targetRect(e: CanvasEnd, get: Getter): Rect | null {
  if (!isAttached(e)) return null;
  const t = get(e.id);
  if (!t || t.type === 'connector') return null;
  return objectBounds(t, get);
}

function isEllipse(e: CanvasEnd, get: Getter): boolean {
  if (!isAttached(e)) return false;
  const t = get(e.id);
  return t?.type === 'shape' && t.shape === 'ellipse';
}

/** Where the segment from the centre of `r` towards `toward` leaves `r` (ellipse-aware). */
export function boundaryPoint(r: Rect, toward: Point, ellipse = false): Point {
  const c = rectCenter(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = r.w / 2;
  const hh = r.h / 2;
  let t: number;
  if (ellipse) t = 1 / Math.sqrt((dx * dx) / (hw * hw || 1) + (dy * dy) / (hh * hh || 1));
  else t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Middle of the side of `r` facing `toward` along the dominant axis. */
function sideMid(r: Rect, toward: Point, horizontal: boolean): Point {
  const c = rectCenter(r);
  if (horizontal) return { x: toward.x >= c.x ? r.x + r.w : r.x, y: c.y };
  return { x: c.x, y: toward.y >= c.y ? r.y + r.h : r.y };
}

function refPoint(e: CanvasEnd, get: Getter): Point {
  if (!isAttached(e)) return { x: e.x, y: e.y };
  const r = targetRect(e, get);
  if (!r) return { x: 0, y: 0 };
  if (e.ax !== undefined && e.ay !== undefined) return { x: r.x + e.ax * r.w, y: r.y + e.ay * r.h };
  return rectCenter(r);
}

export function connectorRoute(c: Pick<CanvasConnector, 'from' | 'to' | 'route'>, get: Getter): Route {
  const fromRect = targetRect(c.from, get);
  const toRect = targetRect(c.to, get);
  const fromRef = refPoint(c.from, get);
  const toRef = refPoint(c.to, get);
  const horizontal = Math.abs(toRef.x - fromRef.x) >= Math.abs(toRef.y - fromRef.y);
  const anchor = (e: CanvasEnd, r: Rect | null, ref: Point, other: Point): Point => {
    if (!r || !isAttached(e)) return ref;
    if (e.ax !== undefined && e.ay !== undefined) return ref;
    return c.route === 'straight' ? boundaryPoint(r, other, isEllipse(e, get)) : sideMid(r, other, horizontal);
  };
  const start = anchor(c.from, fromRect, fromRef, toRef);
  const end = anchor(c.to, toRect, toRef, fromRef);
  let points: Point[];
  let d: string;
  if (c.route === 'elbow') {
    if (horizontal) {
      const mx = (start.x + end.x) / 2;
      points = [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
    } else {
      const my = (start.y + end.y) / 2;
      points = [start, { x: start.x, y: my }, { x: end.x, y: my }, end];
    }
    d = `M ${points.map((p) => `${r2(p.x)} ${r2(p.y)}`).join(' L ')}`;
  } else if (c.route === 'curve') {
    const k = Math.max(30, (horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
    const sx = horizontal ? Math.sign(end.x - start.x || 1) : 0;
    const sy = horizontal ? 0 : Math.sign(end.y - start.y || 1);
    const c1 = { x: start.x + sx * k, y: start.y + sy * k };
    const c2 = { x: end.x - sx * k, y: end.y - sy * k };
    points = [start, c1, c2, end];
    d = `M ${r2(start.x)} ${r2(start.y)} C ${r2(c1.x)} ${r2(c1.y)}, ${r2(c2.x)} ${r2(c2.y)}, ${r2(end.x)} ${r2(end.y)}`;
  } else {
    points = [start, end];
    d = `M ${r2(start.x)} ${r2(start.y)} L ${r2(end.x)} ${r2(end.y)}`;
  }
  const a = points[1]!;
  const b = points[points.length - 2]!;
  const startAngle = Math.atan2(start.y - a.y, start.x - a.x);
  const endAngle = Math.atan2(end.y - b.y, end.x - b.x);
  const mid = c.route === 'curve' ? bezierAt(points, 0.5) : midOfPolyline(points);
  return { points, d, start, end, startAngle, endAngle, mid };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function bezierAt([p0, p1, p2, p3]: Point[], t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0!.x + 3 * u * u * t * p1!.x + 3 * u * t * t * p2!.x + t * t * t * p3!.x,
    y: u * u * u * p0!.y + 3 * u * u * t * p1!.y + 3 * u * t * t * p2!.y + t * t * t * p3!.y,
  };
}

function midOfPolyline(points: Point[]): Point {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    if (acc + seg >= total / 2 && seg > 0) {
      const t = (total / 2 - acc) / seg;
      return { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t };
    }
    acc += seg;
  }
  return points[0]!;
}

/** Hit test along a route (curves sampled). */
export function nearRoute(route: Route, p: Point, radius: number, curve: boolean): boolean {
  const pts = curve ? Array.from({ length: 25 }, (_, i) => bezierAt(route.points, i / 24)) : route.points;
  return nearPolyline(pts, p, radius);
}

// --- snapping -----------------------------------------------------------------------------------

export interface Guides {
  x: number[];
  y: number[];
}

/**
 * Offset that aligns `moving` (left/centre/right, top/middle/bottom) with the nearest edges of
 * `others` within `threshold`, and the guide lines to show.
 */
export function snapRect(moving: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guides } {
  const xs = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const ys = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let bestX: { d: number; at: number } | null = null;
  let bestY: { d: number; at: number } | null = null;
  for (const r of others) {
    for (const tx of [r.x, r.x + r.w / 2, r.x + r.w]) {
      for (const mx of xs) {
        const d = tx - mx;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: tx };
      }
    }
    for (const ty of [r.y, r.y + r.h / 2, r.y + r.h]) {
      for (const my of ys) {
        const d = ty - my;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: ty };
      }
    }
  }
  return { dx: bestX?.d ?? 0, dy: bestY?.d ?? 0, guides: { x: bestX ? [bestX.at] : [], y: bestY ? [bestY.at] : [] } };
}

// --- alignment ---------------------------------------------------------------------------------

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';

/** New top-left of each rect so that they align on `mode` (relative to their union). */
export function alignRects(rects: Map<string, Rect>, mode: AlignMode): Map<string, Point> {
  const all = unionRects(rects.values());
  const out = new Map<string, Point>();
  if (!all) return out;
  for (const [id, r] of rects) {
    let { x, y } = r;
    if (mode === 'left') x = all.x;
    else if (mode === 'hcenter') x = all.x + all.w / 2 - r.w / 2;
    else if (mode === 'right') x = all.x + all.w - r.w;
    else if (mode === 'top') y = all.y;
    else if (mode === 'vmiddle') y = all.y + all.h / 2 - r.h / 2;
    else y = all.y + all.h - r.h;
    out.set(id, { x, y });
  }
  return out;
}

/** Equal gaps between rects along an axis (first and last stay). */
export function distributeRects(rects: Map<string, Rect>, axis: 'x' | 'y'): Map<string, Point> {
  const list = [...rects].sort((a, b) => (axis === 'x' ? a[1].x - b[1].x : a[1].y - b[1].y));
  const out = new Map<string, Point>();
  if (list.length < 3) return out;
  const first = list[0]![1];
  const last = list[list.length - 1]![1];
  const span = axis === 'x' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const sizes = list.reduce((s, [, r]) => s + (axis === 'x' ? r.w : r.h), 0);
  const gap = (span - sizes) / (list.length - 1);
  let pos = axis === 'x' ? first.x : first.y;
  for (const [id, r] of list) {
    out.set(id, axis === 'x' ? { x: pos, y: r.y } : { x: r.x, y: pos });
    pos += (axis === 'x' ? r.w : r.h) + gap;
  }
  return out;
}

// --- resizing ---------------------------------------------------------------------------------

/** Handle names: n, s, e, w and corners. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(r: Rect, h: Handle): Point {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

/** Rect after dragging `handle` by (dx, dy); `keepRatio` keeps proportions (corners). Minimum 4. */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, keepRatio: boolean, min = 4): Rect {
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.w;
  let y2 = start.y + start.h;
  if (handle.includes('w')) x1 += dx;
  if (handle.includes('e')) x2 += dx;
  if (handle.includes('n')) y1 += dy;
  if (handle.includes('s')) y2 += dy;
  let r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(min, Math.abs(x2 - x1)), h: Math.max(min, Math.abs(y2 - y1)) };
  if (keepRatio && start.w > 0 && start.h > 0 && handle.length === 2) {
    const ratio = start.w / start.h;
    if (r.w / r.h > ratio) r = { ...r, h: r.w / ratio };
    else r = { ...r, w: r.h * ratio };
    if (handle.includes('w')) r.x = start.x + start.w - r.w;
    if (handle.includes('n')) r.y = start.y + start.h - r.h;
  }
  return r;
}

/** Maps a point of `from` onto `to` (selection resize). */
export function mapPoint(p: Point, from: Rect, to: Rect): Point {
  return {
    x: to.x + (from.w === 0 ? 0 : ((p.x - from.x) / from.w) * to.w),
    y: to.y + (from.h === 0 ? 0 : ((p.y - from.y) / from.h) * to.h),
  };
}

/** Object scaled from the selection box `from` to `to` (strokes scale their points, free ends move). */
export function scaleObject(o: CanvasObject, from: Rect, to: Rect): CanvasObject {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  if (o.type === 'connector') {
    const end = (e: CanvasEnd): CanvasEnd => ('id' in e ? e : mapPoint(e, from, to));
    return { ...o, from: end(o.from), to: end(o.to) };
  }
  if (o.type === 'mindmap') {
    const p = mapPoint({ x: o.x, y: o.y }, from, to);
    return { ...o, x: p.x, y: p.y };
  }
  const p = mapPoint({ x: o.x, y: o.y }, from, to);
  const scaled = { ...o, x: p.x, y: p.y, w: Math.max(1, o.w * sx), h: Math.max(1, o.h * sy) };
  if (o.type === 'stroke') return { ...scaled, points: o.points.map((v, i) => Math.round(v * (i % 2 === 0 ? sx : sy) * 10) / 10) } as CanvasObject;
  return scaled as CanvasObject;
}

/** Moves an object by (dx, dy); attached connector ends follow their targets by themselves. */
export function translateObject(o: CanvasObject, dx: number, dy: number): CanvasObject {
  if (o.type === 'connector') {
    const end = (e: CanvasEnd): CanvasEnd => ('id' in e ? e : { x: e.x + dx, y: e.y + dy });
    return { ...o, from: end(o.from), to: end(o.to) };
  }
  return { ...o, x: o.x + dx, y: o.y + dy };
}
