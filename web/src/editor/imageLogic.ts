// Image block (E15): non destructive crop and hyperlink. The crop is a rectangle in fractions of the
// original image, stored in the `crop` prop ("x,y,w,h"); the uploaded file is never touched.
// Values come from the shared document: everything is validated here.
import { IMAGE_CROP_MIN_SIZE } from '@oriel/shared';
import { safeLinkUrl } from '../lib/safeUrl';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 10000) / 10000;

/** Valid crop rectangle of a stored value; null = whole image (or anything unusable). */
export function parseCrop(raw: unknown): CropRect | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 80) return null;
  const parts = raw.split(',').map((p) => (p.trim() === '' ? NaN : Number(p)));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [px, py, pw, ph] = parts as [number, number, number, number];
  const w = clamp(pw, IMAGE_CROP_MIN_SIZE, 1);
  const h = clamp(ph, IMAGE_CROP_MIN_SIZE, 1);
  const x = clamp(px, 0, 1 - w);
  const y = clamp(py, 0, 1 - h);
  if (x === 0 && y === 0 && w === 1 && h === 1) return null;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

export function serializeCrop(rect: CropRect | null): string {
  const c = rect ? parseCrop(`${rect.x},${rect.y},${rect.w},${rect.h}`) : null;
  return c ? `${c.x},${c.y},${c.w},${c.h}` : '';
}

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Rectangle after dragging `handle` by (dx, dy) fractions of the image; stays inside the image. */
export function dragCrop(start: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
  const min = IMAGE_CROP_MIN_SIZE;
  if (handle === 'move') {
    return { ...start, x: round(clamp(start.x + dx, 0, 1 - start.w)), y: round(clamp(start.y + dy, 0, 1 - start.h)) };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min);
  if (handle.includes('e')) right = clamp(right + dx, left + min, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, 1);
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

/** Width / height of the cropped area for an original of natW × natH pixels. */
export function cropAspect(crop: CropRect, natW: number, natH: number): number {
  return (crop.w * natW) / (crop.h * natH);
}

/** Position of the full image inside its cropping frame (percentages of the frame). */
export function cropImageStyle(crop: CropRect) {
  return {
    width: `${round(100 / crop.w)}%`,
    left: `${round((-crop.x / crop.w) * 100)}%`,
    top: `${round((-crop.y / crop.h) * 100)}%`,
  };
}

/** CSS `object-view-box` of a crop (exports, copies): the cropped area of the original. */
export function objectViewBox(crop: CropRect): string {
  const pct = (n: number) => `${round(n * 100)}%`;
  return `inset(${pct(crop.y)} ${pct(1 - crop.x - crop.w)} ${pct(1 - crop.y - crop.h)} ${pct(crop.x)})`;
}

/** Validated link of an image (same rules as links of the text: http, https, mailto, tel). */
export function imageLink(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= 2048 ? safeLinkUrl(raw) : null;
}
