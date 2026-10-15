// SVG path builders of the canvas (H1), shared by the live renderer and the export: shape
// outlines, smoothed pen strokes (perfect-freehand, MIT) and connector end caps.
import { getStroke } from 'perfect-freehand';
import type { CanvasCap, CanvasDash, CanvasShapeKind } from '@oriel/shared';
import type { Point } from './model';

const n = (v: number) => Math.round(v * 100) / 100;

/** Outline of a shape in its own box (0, 0, w, h). `rect`/`rounded`/`ellipse` have native elements too. */
export function shapePath(kind: CanvasShapeKind, w: number, h: number): string {
  switch (kind) {
    case 'diamond':
      return `M ${n(w / 2)} 0 L ${n(w)} ${n(h / 2)} L ${n(w / 2)} ${n(h)} L 0 ${n(h / 2)} Z`;
    case 'triangle':
      return `M ${n(w / 2)} 0 L ${n(w)} ${n(h)} L 0 ${n(h)} Z`;
    case 'hexagon': {
      const k = Math.min(w / 4, h / 2);
      return `M ${n(k)} 0 L ${n(w - k)} 0 L ${n(w)} ${n(h / 2)} L ${n(w - k)} ${n(h)} L ${n(k)} ${n(h)} L 0 ${n(h / 2)} Z`;
    }
    case 'ellipse': {
      const rx = w / 2;
      const ry = h / 2;
      return `M 0 ${n(ry)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(w)} ${n(ry)} A ${n(rx)} ${n(ry)} 0 1 0 0 ${n(ry)} Z`;
    }
    case 'rounded': {
      const r = Math.min(w, h) * 0.14;
      return `M ${n(r)} 0 H ${n(w - r)} Q ${n(w)} 0 ${n(w)} ${n(r)} V ${n(h - r)} Q ${n(w)} ${n(h)} ${n(w - r)} ${n(h)} H ${n(r)} Q 0 ${n(h)} 0 ${n(h - r)} V ${n(r)} Q 0 0 ${n(r)} 0 Z`;
    }
    default:
      return `M 0 0 H ${n(w)} V ${n(h)} H 0 Z`;
  }
}

export const dashArray = (dash: CanvasDash, width: number): string | undefined =>
  dash === 'dashed' ? `${n(width * 4)} ${n(width * 3)}` : dash === 'dotted' ? `${n(Math.max(0.1, width * 0.1))} ${n(width * 2.5)}` : undefined;

/** Filled outline of a pen / highlighter stroke (points relative to the stroke box). */
export function freehandPath(points: number[], size: number, tool: 'pen' | 'highlighter', complete = true): string {
  const input: Array<[number, number]> = [];
  for (let i = 0; i + 1 < points.length; i += 2) input.push([points[i]!, points[i + 1]!]);
  const outline = getStroke(input, {
    size,
    thinning: tool === 'pen' ? 0.55 : 0,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: tool === 'pen',
    last: complete,
    start: { cap: true },
    end: { cap: true },
  });
  if (outline.length < 2) return '';
  // Quadratic curves through the midpoints of the outline (closed).
  let d = `M ${n(outline[0]![0])} ${n(outline[0]![1])} Q`;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]!;
    const [x1, y1] = outline[(i + 1) % outline.length]!;
    d += ` ${n(x0)} ${n(y0)} ${n((x0 + x1) / 2)} ${n((y0 + y1) / 2)}`;
  }
  return `${d} Z`;
}

/** End cap at `p`, pointing in `angle` (radians, outwards). Filled caps return `filled`. */
export function capPath(cap: CanvasCap, p: Point, angle: number, width: number): { d: string; filled: boolean } | null {
  if (cap === 'none') return null;
  const size = 7 + width * 2;
  const pt = (along: number, across: number) => ({
    x: p.x + Math.cos(angle) * along - Math.sin(angle) * across,
    y: p.y + Math.sin(angle) * along + Math.cos(angle) * across,
  });
  const f = (q: Point) => `${n(q.x)} ${n(q.y)}`;
  if (cap === 'arrow') {
    const a = pt(-size, -size * 0.6);
    const b = pt(-size, size * 0.6);
    return { d: `M ${f(a)} L ${f(p)} L ${f(b)}`, filled: false };
  }
  if (cap === 'triangle') {
    const a = pt(-size, -size * 0.55);
    const b = pt(-size, size * 0.55);
    return { d: `M ${f(p)} L ${f(a)} L ${f(b)} Z`, filled: true };
  }
  if (cap === 'diamond') {
    const a = pt(-size * 0.6, -size * 0.45);
    const b = pt(-size * 1.2, 0);
    const c = pt(-size * 0.6, size * 0.45);
    return { d: `M ${f(p)} L ${f(a)} L ${f(b)} L ${f(c)} Z`, filled: true };
  }
  const r = size * 0.38;
  const c = pt(-r, 0);
  return { d: `M ${n(c.x - r)} ${n(c.y)} a ${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0 a ${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0`, filled: true };
}

/** How far the line stops before a cap so that the cap's tip stays sharp. */
export const capInset = (cap: CanvasCap, width: number) => (cap === 'triangle' || cap === 'diamond' ? (7 + width * 2) * 0.6 : cap === 'dot' ? (7 + width * 2) * 0.4 : 0);
