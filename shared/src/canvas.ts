// Canvas pages (vague H, session H1): data model shared by the server ingest guard and the web
// renderer. A canvas page is a regular page (`kind = 'page'`) whose `format.layout` is `'canvas'`.
// Its Yjs document has ONE root, the Y.Map `canvas`: key = object id, value = the whole object as
// plain JSON (last writer wins per object). `sanitizeCanvasObject` is the single definition of what
// an object may contain: the server refuses an update holding anything it rejects, and the client
// renders only what it returns (defence in depth).
import { COLORS } from './constants.js';
import type { Color } from './types.js';

/** Name of the root Y.Map of a canvas document. */
export const CANVAS_ROOT = 'canvas';
export const CANVAS_LAYOUT = 'canvas';

export const CANVAS_LIMITS = {
  /** Objects in one canvas. */
  objects: 5000,
  /** JSON size of one object (UTF-16 code units of JSON.stringify). */
  objectBytes: 64 * 1024,
  /** JSON size of all the objects. */
  totalBytes: 8 * 1024 * 1024,
  /** Text of a shape, a text or a note. */
  text: 10_000,
  /** Short labels: connector label, frame name, file name. */
  label: 300,
  /** Numbers of a stroke (x, y pairs): 2 500 points. */
  strokeNumbers: 5000,
  /** Absolute coordinate bound. */
  coord: 1_000_000,
  /** Width / height bound. */
  size: 200_000,
  mindmapNodes: 500,
  mindmapDepth: 12,
  mindmapText: 200,
} as const;

export const CANVAS_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Uploaded files only (`POST /api/workspaces/:wid/files` returns these URLs). */
export const CANVAS_FILE_SRC_RE = /^\/api\/files\/[0-9a-f]{32}\/[A-Za-z0-9%._~!$&'()*+,;=:@-]{1,800}$/;
/** fractional-indexing keys (base 62). */
const ORDER_RE = /^[0-9A-Za-z]{1,80}$/;

export type CanvasColor = Color;
/** `none` = transparent. */
export type CanvasFill = Color | 'none';
export type CanvasShapeKind = 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'triangle' | 'hexagon';
export type CanvasFontSize = 's' | 'm' | 'l' | 'xl';
export type CanvasAlign = 'left' | 'center' | 'right';
export type CanvasDash = 'solid' | 'dashed' | 'dotted';
export type CanvasCap = 'none' | 'arrow' | 'triangle' | 'dot' | 'diamond';
export type CanvasRoute = 'straight' | 'elbow' | 'curve';
export type MindmapLayout = 'right' | 'left' | 'balanced';
export type MindmapStyle = 'classic' | 'outline' | 'org' | 'minimal';

export const CANVAS_SHAPES: CanvasShapeKind[] = ['rect', 'rounded', 'ellipse', 'diamond', 'triangle', 'hexagon'];
export const CANVAS_FONT_SIZES: Record<CanvasFontSize, number> = { s: 14, m: 18, l: 26, xl: 40 };
export const CANVAS_STROKE_WIDTHS = [1, 2, 4, 8] as const;
export const CANVAS_CAPS: CanvasCap[] = ['none', 'arrow', 'triangle', 'dot', 'diamond'];
export const MINDMAP_LAYOUTS: MindmapLayout[] = ['right', 'left', 'balanced'];
export const MINDMAP_STYLES: MindmapStyle[] = ['classic', 'outline', 'org', 'minimal'];

interface CanvasBase {
  id: string;
  /** Top-left corner and size, in canvas units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order (fractional index): later = above. */
  z: string;
  locked?: boolean;
  /** Objects sharing a group id are selected and moved together. */
  groupId?: string;
}

export interface CanvasShape extends CanvasBase {
  type: 'shape';
  shape: CanvasShapeKind;
  fill: CanvasFill;
  stroke: CanvasColor;
  strokeWidth: number;
  dash: CanvasDash;
  text: string;
  fontSize: CanvasFontSize;
  textColor: CanvasColor;
}

export interface CanvasText extends CanvasBase {
  type: 'text';
  text: string;
  fontSize: CanvasFontSize;
  color: CanvasColor;
  align: CanvasAlign;
  bold?: boolean;
}

/** Sticky note; its text is light Markdown rendered by the application (never raw HTML). */
export interface CanvasNote extends CanvasBase {
  type: 'note';
  text: string;
  fill: CanvasColor;
}

/** Pen or highlighter stroke; `points` are x, y pairs relative to (x, y). */
export interface CanvasStroke extends CanvasBase {
  type: 'stroke';
  tool: 'pen' | 'highlighter';
  points: number[];
  color: CanvasColor;
  size: number;
}

/** Attached end (`id`, optional fixed anchor in 0–1 of the target box; absent = automatic) or free point. */
export type CanvasEnd = { id: string; ax?: number; ay?: number } | { x: number; y: number };

export interface CanvasConnector extends CanvasBase {
  type: 'connector';
  from: CanvasEnd;
  to: CanvasEnd;
  route: CanvasRoute;
  startCap: CanvasCap;
  endCap: CanvasCap;
  color: CanvasColor;
  strokeWidth: number;
  dash: CanvasDash;
  label: string;
}

export interface CanvasImage extends CanvasBase {
  type: 'image';
  src: string;
  name: string;
}

export interface CanvasFile extends CanvasBase {
  type: 'file';
  src: string;
  name: string;
  mime: string;
  size: number;
}

export interface CanvasPageCard extends CanvasBase {
  type: 'page';
  pageId: string;
}

export interface CanvasFrame extends CanvasBase {
  type: 'frame';
  name: string;
  /** Presentation order (fractional index). */
  order: string;
  fill: CanvasFill;
}

export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
  collapsed?: boolean;
  color?: CanvasColor;
}

export interface CanvasMindmap extends CanvasBase {
  type: 'mindmap';
  root: MindNode;
  layout: MindmapLayout;
  style: MindmapStyle;
}

export type CanvasObject =
  | CanvasShape
  | CanvasText
  | CanvasNote
  | CanvasStroke
  | CanvasConnector
  | CanvasImage
  | CanvasFile
  | CanvasPageCard
  | CanvasFrame
  | CanvasMindmap;

export type CanvasObjectType = CanvasObject['type'];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const color = (v: unknown): Color | null => oneOf(v, COLORS);
const fill = (v: unknown): CanvasFill | null => (v === 'none' ? 'none' : color(v));
const DASHES: CanvasDash[] = ['solid', 'dashed', 'dotted'];
const ALIGNS: CanvasAlign[] = ['left', 'center', 'right'];
const SIZES: CanvasFontSize[] = ['s', 'm', 'l', 'xl'];
const ROUTES: CanvasRoute[] = ['straight', 'elbow', 'curve'];

function sanitizeEnd(v: unknown): CanvasEnd | null {
  if (!isRec(v)) return null;
  if (v.id !== undefined) {
    if (typeof v.id !== 'string' || !CANVAS_ID_RE.test(v.id)) return null;
    const end: { id: string; ax?: number; ay?: number } = { id: v.id };
    if (v.ax !== undefined || v.ay !== undefined) {
      const ax = num(v.ax, 0, 1);
      const ay = num(v.ay, 0, 1);
      if (ax === null || ay === null) return null;
      end.ax = ax;
      end.ay = ay;
    }
    return end;
  }
  const x = num(v.x, -CANVAS_LIMITS.coord, CANVAS_LIMITS.coord);
  const y = num(v.y, -CANVAS_LIMITS.coord, CANVAS_LIMITS.coord);
  return x === null || y === null ? null : { x, y };
}

/** Mind map tree, bounded in size and depth (iterative: the input is untrusted). */
export function sanitizeMindNode(v: unknown): MindNode | null {
  let count = 0;
  const seen = new Set<string>();
  const visit = (raw: unknown, depth: number): MindNode | null => {
    if (!isRec(raw) || depth > CANVAS_LIMITS.mindmapDepth) return null;
    if (++count > CANVAS_LIMITS.mindmapNodes) return null;
    if (typeof raw.id !== 'string' || !CANVAS_ID_RE.test(raw.id) || seen.has(raw.id)) return null;
    seen.add(raw.id);
    const text = str(raw.text, CANVAS_LIMITS.mindmapText);
    if (text === null || !Array.isArray(raw.children)) return null;
    const children: MindNode[] = [];
    for (const c of raw.children) {
      const child = visit(c, depth + 1);
      if (!child) return null;
      children.push(child);
    }
    const node: MindNode = { id: raw.id, text, children };
    if (raw.collapsed === true) node.collapsed = true;
    else if (raw.collapsed !== undefined && raw.collapsed !== false) return null;
    if (raw.color !== undefined) {
      const c = color(raw.color);
      if (!c) return null;
      node.color = c;
    }
    return node;
  };
  // Depth is bounded (12), so recursion depth is too.
  return visit(v, 0);
}

/**
 * The object as the application uses it, or null when anything is missing, out of bounds or of the
 * wrong type. Unknown keys are dropped. Pure; the same function runs on the server and the client.
 */
export function sanitizeCanvasObject(v: unknown): CanvasObject | null {
  if (!isRec(v)) return null;
  if (typeof v.id !== 'string' || !CANVAS_ID_RE.test(v.id)) return null;
  const L = CANVAS_LIMITS;
  const x = num(v.x, -L.coord, L.coord);
  const y = num(v.y, -L.coord, L.coord);
  const w = num(v.w, 0, L.size);
  const h = num(v.h, 0, L.size);
  if (x === null || y === null || w === null || h === null) return null;
  if (typeof v.z !== 'string' || !ORDER_RE.test(v.z)) return null;
  const base: CanvasBase = { id: v.id, x, y, w, h, z: v.z };
  if (v.locked === true) base.locked = true;
  else if (v.locked !== undefined && v.locked !== false) return null;
  if (v.groupId !== undefined) {
    if (typeof v.groupId !== 'string' || !CANVAS_ID_RE.test(v.groupId)) return null;
    base.groupId = v.groupId;
  }
  switch (v.type) {
    case 'shape': {
      const shape = oneOf(v.shape, CANVAS_SHAPES);
      const f = fill(v.fill);
      const stroke = color(v.stroke);
      const strokeWidth = num(v.strokeWidth, 0, 16);
      const dash = oneOf(v.dash, DASHES);
      const text = str(v.text, L.text);
      const fontSize = oneOf(v.fontSize, SIZES);
      const textColor = color(v.textColor);
      if (!shape || !f || !stroke || strokeWidth === null || !dash || text === null || !fontSize || !textColor) return null;
      return { ...base, type: 'shape', shape, fill: f, stroke, strokeWidth, dash, text, fontSize, textColor };
    }
    case 'text': {
      const text = str(v.text, L.text);
      const fontSize = oneOf(v.fontSize, SIZES);
      const c = color(v.color);
      const align = oneOf(v.align, ALIGNS);
      if (text === null || !fontSize || !c || !align) return null;
      const out: CanvasText = { ...base, type: 'text', text, fontSize, color: c, align };
      if (v.bold === true) out.bold = true;
      return out;
    }
    case 'note': {
      const text = str(v.text, L.text);
      const f = color(v.fill);
      if (text === null || !f) return null;
      return { ...base, type: 'note', text, fill: f };
    }
    case 'stroke': {
      const tool = oneOf(v.tool, ['pen', 'highlighter'] as const);
      const c = color(v.color);
      const size = num(v.size, 1, 64);
      if (!tool || !c || size === null || !Array.isArray(v.points)) return null;
      if (v.points.length < 2 || v.points.length > L.strokeNumbers || v.points.length % 2 !== 0) return null;
      const points: number[] = [];
      for (const p of v.points) {
        const n = num(p, -L.size, L.size);
        if (n === null) return null;
        points.push(n);
      }
      return { ...base, type: 'stroke', tool, points, color: c, size };
    }
    case 'connector': {
      const from = sanitizeEnd(v.from);
      const to = sanitizeEnd(v.to);
      const route = oneOf(v.route, ROUTES);
      const startCap = oneOf(v.startCap, CANVAS_CAPS);
      const endCap = oneOf(v.endCap, CANVAS_CAPS);
      const c = color(v.color);
      const strokeWidth = num(v.strokeWidth, 0.5, 16);
      const dash = oneOf(v.dash, DASHES);
      const label = str(v.label, L.label);
      if (!from || !to || !route || !startCap || !endCap || !c || strokeWidth === null || !dash || label === null) return null;
      return { ...base, type: 'connector', from, to, route, startCap, endCap, color: c, strokeWidth, dash, label };
    }
    case 'image': {
      if (typeof v.src !== 'string' || !CANVAS_FILE_SRC_RE.test(v.src)) return null;
      const name = str(v.name, L.label);
      if (name === null) return null;
      return { ...base, type: 'image', src: v.src, name };
    }
    case 'file': {
      if (typeof v.src !== 'string' || !CANVAS_FILE_SRC_RE.test(v.src)) return null;
      const name = str(v.name, L.label);
      const mime = str(v.mime, 200);
      const size = num(v.size, 0, Number.MAX_SAFE_INTEGER);
      if (name === null || mime === null || size === null) return null;
      return { ...base, type: 'file', src: v.src, name, mime, size };
    }
    case 'page': {
      if (typeof v.pageId !== 'string' || !PAGE_ID_RE.test(v.pageId)) return null;
      return { ...base, type: 'page', pageId: v.pageId };
    }
    case 'frame': {
      const name = str(v.name, L.label);
      const f = fill(v.fill);
      if (name === null || !f || typeof v.order !== 'string' || !ORDER_RE.test(v.order)) return null;
      return { ...base, type: 'frame', name, order: v.order, fill: f };
    }
    case 'mindmap': {
      const root = sanitizeMindNode(v.root);
      const layout = oneOf(v.layout, MINDMAP_LAYOUTS);
      const style = oneOf(v.style, MINDMAP_STYLES);
      if (!root || !layout || !style) return null;
      return { ...base, type: 'mindmap', root, layout, style };
    }
    default:
      return null;
  }
}

/** Searchable text of an object (search index, frame block captions). */
export function canvasObjectText(o: CanvasObject): string {
  switch (o.type) {
    case 'shape':
    case 'text':
    case 'note':
      return o.text;
    case 'connector':
      return o.label;
    case 'frame':
      return o.name;
    case 'image':
    case 'file':
      return o.name;
    case 'mindmap': {
      const out: string[] = [];
      const stack: MindNode[] = [o.root];
      while (stack.length > 0) {
        const n = stack.pop()!;
        out.push(n.text);
        for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
      }
      return out.join('\n');
    }
    default:
      return '';
  }
}

/** True when a page format marks a canvas. */
export const isCanvasFormat = (format: { layout?: unknown } | null | undefined): boolean => format?.layout === CANVAS_LAYOUT;
