// Canvas objects (H1): constructors and small helpers shared by the editor, the renderer, the
// export and the templates. The data model and its validation live in @oriel/shared (canvas.ts).
import { positionBetween, type CanvasColor, type CanvasFill, type CanvasObject } from '@oriel/shared';

export type {
  CanvasObject,
  CanvasShape,
  CanvasText,
  CanvasNote,
  CanvasStroke,
  CanvasConnector,
  CanvasImage,
  CanvasFile,
  CanvasPageCard,
  CanvasFrame,
  CanvasMindmap,
  CanvasEnd,
  MindNode,
} from '@oriel/shared';

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Short random id (12 chars of [a-z0-9]): object ids, mind map nodes, groups. */
export function cid(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const byZ = (a: CanvasObject, b: CanvasObject) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Highest z of a collection (null when empty). */
export function topZ(objects: Iterable<CanvasObject>): string | null {
  let top: string | null = null;
  for (const o of objects) if (top === null || o.z > top) top = o.z;
  return top;
}

export function bottomZ(objects: Iterable<CanvasObject>): string | null {
  let bottom: string | null = null;
  for (const o of objects) if (bottom === null || o.z < bottom) bottom = o.z;
  return bottom;
}

/** `n` z keys above everything (frames go below: see `zBelow`). */
export function zAbove(objects: Iterable<CanvasObject>, n = 1): string[] {
  const out: string[] = [];
  let last = topZ(objects);
  for (let i = 0; i < n; i++) {
    last = positionBetween(last, null);
    out.push(last);
  }
  return out;
}

export function zBelow(objects: Iterable<CanvasObject>): string {
  return positionBetween(null, bottomZ(objects));
}

export const round = (n: number, step = 0.01) => Math.round(n / step) * step;

// --- colors -----------------------------------------------------------------------------------

/** Ink (stroke, text) of a named color: CSS variables defined by canvas.css for both themes. */
export const ink = (c: CanvasColor) => `var(--or-cv-ink-${c})`;
/** Soft fill of a named color (shapes, frames). */
export const softFill = (c: CanvasFill) => (c === 'none' ? 'none' : `var(--or-cv-fill-${c})`);
/** Sticky note paper. */
export const noteFill = (c: CanvasColor) => `var(--or-cv-note-${c})`;

export const PALETTE: CanvasColor[] = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
export const COLOR_NAMES: Record<CanvasColor, string> = {
  default: 'Encre',
  gray: 'Gris',
  brown: 'Brun',
  orange: 'Orange',
  yellow: 'Jaune',
  green: 'Vert',
  blue: 'Bleu',
  purple: 'Violet',
  pink: 'Rose',
  red: 'Rouge',
};

// --- constructors --------------------------------------------------------------------------------

type Init<T> = Omit<T, 'id' | 'z' | 'type'> & { id?: string; z: string };

export const makeShape = (init: Partial<Init<Extract<CanvasObject, { type: 'shape' }>>> & Rect & { z: string }): CanvasObject => ({
  id: init.id ?? cid(),
  type: 'shape',
  x: init.x,
  y: init.y,
  w: init.w,
  h: init.h,
  z: init.z,
  shape: init.shape ?? 'rounded',
  fill: init.fill ?? 'blue',
  stroke: init.stroke ?? 'blue',
  strokeWidth: init.strokeWidth ?? 2,
  dash: init.dash ?? 'solid',
  text: init.text ?? '',
  fontSize: init.fontSize ?? 'm',
  textColor: init.textColor ?? 'default',
  ...(init.groupId ? { groupId: init.groupId } : {}),
});

export const makeText = (init: { x: number; y: number; z: string; text?: string; w?: number; h?: number; fontSize?: 's' | 'm' | 'l' | 'xl'; bold?: boolean; color?: CanvasColor; align?: 'left' | 'center' | 'right'; id?: string; groupId?: string }): CanvasObject => ({
  id: init.id ?? cid(),
  type: 'text',
  x: init.x,
  y: init.y,
  w: init.w ?? 240,
  h: init.h ?? 32,
  z: init.z,
  text: init.text ?? '',
  fontSize: init.fontSize ?? 'm',
  color: init.color ?? 'default',
  align: init.align ?? 'left',
  ...(init.bold ? { bold: true } : {}),
  ...(init.groupId ? { groupId: init.groupId } : {}),
});

export const makeNote = (init: Rect & { z: string; text?: string; fill?: CanvasColor; id?: string; groupId?: string }): CanvasObject => ({
  id: init.id ?? cid(),
  type: 'note',
  x: init.x,
  y: init.y,
  w: init.w,
  h: init.h,
  z: init.z,
  text: init.text ?? '',
  fill: init.fill ?? 'yellow',
  ...(init.groupId ? { groupId: init.groupId } : {}),
});

export const makeFrame = (init: Rect & { z: string; name: string; order: string; fill?: CanvasFill; id?: string }): CanvasObject => ({
  id: init.id ?? cid(),
  type: 'frame',
  x: init.x,
  y: init.y,
  w: init.w,
  h: init.h,
  z: init.z,
  name: init.name,
  order: init.order,
  fill: init.fill ?? 'none',
});

/** Stable string of an object (equality before writing). */
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
