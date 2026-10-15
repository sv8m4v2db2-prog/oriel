// Drawing block (E14): strokes live in the block prop `strokes` (JSON), which any collaborator can set
// to anything. Everything read from it is bounded and rebuilt here; the SVG is built from numbers only.
import {
  DRAWING_HEIGHT,
  DRAWING_MAX_LENGTH,
  DRAWING_MAX_POINTS,
  DRAWING_MAX_STROKES,
  DRAWING_MAX_STROKE_WIDTH,
  DRAWING_WIDTH,
} from '@oriel/shared';

export interface Stroke {
  /** '#rrggbb' */
  c: string;
  w: number;
  /** x0, y0, x1, y1, … */
  p: number[];
}

export const DRAWING_COLORS = ['#1f2328', '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5', '#868e96', '#ffffff'] as const;
export const DRAWING_WIDTHS = [2, 4, 8, 16] as const;

const COLOR = /^#[0-9a-f]{6}$/i;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Strokes of a stored value; invalid parts are skipped, limits applied (never throws). */
export function parseStrokes(raw: unknown): Stroke[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > DRAWING_MAX_LENGTH) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Stroke[] = [];
  for (const item of data.slice(0, DRAWING_MAX_STROKES)) {
    if (!item || typeof item !== 'object') continue;
    const { c, w, p } = item as Record<string, unknown>;
    if (typeof c !== 'string' || !COLOR.test(c) || typeof w !== 'number' || !Number.isFinite(w) || !Array.isArray(p)) continue;
    const points: number[] = [];
    for (let i = 0; i + 1 < p.length && points.length < DRAWING_MAX_POINTS * 2; i += 2) {
      const x = p[i];
      const y = p[i + 1];
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push(Math.round(clamp(x, 0, DRAWING_WIDTH)), Math.round(clamp(y, 0, DRAWING_HEIGHT)));
    }
    if (points.length >= 2) out.push({ c: c.toLowerCase(), w: Math.round(clamp(w, 1, DRAWING_MAX_STROKE_WIDTH)), p: points });
  }
  return out;
}

/** Serialized strokes within the size limit: the oldest strokes are dropped when needed. */
export function serializeStrokes(strokes: Stroke[]): string {
  // Same bounds as when reading: coordinates inside the canvas, widths, points per stroke.
  let list = strokes.slice(-DRAWING_MAX_STROKES).map((s) => {
    const p: number[] = [];
    for (let i = 0; i + 1 < s.p.length && p.length < DRAWING_MAX_POINTS * 2; i += 2) {
      p.push(Math.round(clamp(s.p[i]!, 0, DRAWING_WIDTH)), Math.round(clamp(s.p[i + 1]!, 0, DRAWING_HEIGHT)));
    }
    return { c: s.c, w: Math.round(clamp(s.w, 1, DRAWING_MAX_STROKE_WIDTH)), p };
  });
  let text = JSON.stringify(list);
  while (text.length > DRAWING_MAX_LENGTH && list.length > 1) {
    list = list.slice(Math.ceil(list.length / 10));
    text = JSON.stringify(list);
  }
  return text.length > DRAWING_MAX_LENGTH ? '[]' : text;
}

/** SVG path data of a stroke (quadratic smoothing); a single point becomes a dot. */
export function strokePath(stroke: Stroke): string {
  const p = stroke.p;
  if (p.length < 4) return `M${p[0]} ${p[1]}h0.01`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i + 3 < p.length; i += 2) d += `Q${p[i]} ${p[i + 1]} ${(p[i]! + p[i + 2]!) / 2} ${(p[i + 1]! + p[i + 3]!) / 2}`;
  return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
}

/** Whole drawing as standalone SVG text (copies, exports). */
export function drawingSvg(raw: unknown, background = ''): string {
  const paths = parseStrokes(raw)
    .map((s) => `<path d="${strokePath(s)}" fill="none" stroke="${s.c}" stroke-width="${s.w}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  const bg = COLOR.test(background) ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}" width="${DRAWING_WIDTH}" height="${DRAWING_HEIGHT}">${bg}${paths}</svg>`;
}

/** Squared distance from (x, y) to the segment a–b. */
function segDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : clamp(((x - ax) * dx + (y - ay) * dy) / len, 0, 1);
  const px = ax + t * dx - x;
  const py = ay + t * dy - y;
  return px * px + py * py;
}

/** Index of the topmost stroke within `radius` of (x, y), or -1 (eraser). */
export function strokeAt(strokes: Stroke[], x: number, y: number, radius: number): number {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]!;
    const r = radius + s.w / 2;
    const p = s.p;
    if (p.length < 4) {
      if ((p[0]! - x) ** 2 + (p[1]! - y) ** 2 <= r * r) return i;
      continue;
    }
    for (let k = 0; k + 3 < p.length; k += 2) if (segDist2(x, y, p[k]!, p[k + 1]!, p[k + 2]!, p[k + 3]!) <= r * r) return i;
  }
  return -1;
}

/** Drops points closer than `min` to the previous one (keeps the last), for compact strokes. */
export function simplifyPoints(points: number[], min = 2): number[] {
  if (points.length <= 4) return points;
  const out = [points[0]!, points[1]!];
  for (let i = 2; i + 1 < points.length - 2; i += 2) {
    if (Math.hypot(points[i]! - out[out.length - 2]!, points[i + 1]! - out[out.length - 1]!) >= min) out.push(points[i]!, points[i + 1]!);
  }
  out.push(points[points.length - 2]!, points[points.length - 1]!);
  return out;
}
