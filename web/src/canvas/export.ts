// Export of a canvas, a selection or a frame (H1) to SVG and PNG. The SVG is written by the
// application from the objects (escaped text, our own paths, images embedded as data URLs): no
// user-provided markup ever reaches it. Colors are the current theme's, resolved at export time.
import { CANVAS_FONT_SIZES, type CanvasObject } from '@oriel/shared';
import { byZ, type Rect } from './model';
import { connectorRoute, intersects, mindLayoutOf, objectBounds, type Getter } from './geometry';
import { capPath, dashArray, freehandPath, shapePath } from './paths';
import { MIND_FONT } from './mindmap/layout';
import { parseNote, stripInline } from './richText';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => Math.round(v * 100) / 100;

/** Resolves `var(--x)` against the document's current theme. */
function resolver() {
  const style = getComputedStyle(document.documentElement);
  const cache = new Map<string, string>();
  const resolve = (value: string): string => {
    const m = /^var\((--[\w-]+)\)$/.exec(value);
    if (!m) return value;
    let v = cache.get(m[1]!);
    if (v === undefined) {
      v = style.getPropertyValue(m[1]!).trim() || '#888888';
      cache.set(m[1]!, v);
    }
    return v;
  };
  return resolve;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, size: number, font: string, bold = false): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.56;
  measureCtx.font = `${bold ? 600 : 400} ${size}px ${font}`;
  return measureCtx.measureText(text).width;
}

function wrap(text: string, width: number, size: number, font: string, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && textWidth(next, size, font, bold) > width) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

function textBlock(
  lines: string[],
  box: Rect,
  opts: { size: number; color: string; font: string; align: 'left' | 'center' | 'right'; valign: 'top' | 'middle'; bold?: boolean; pad?: number },
): string {
  const lh = opts.size * 1.35;
  const pad = opts.pad ?? 0;
  const total = lines.length * lh;
  const top = opts.valign === 'middle' ? box.y + box.h / 2 - total / 2 : box.y + pad;
  const x = opts.align === 'center' ? box.x + box.w / 2 : opts.align === 'right' ? box.x + box.w - pad : box.x + pad;
  const anchor = opts.align === 'center' ? 'middle' : opts.align === 'right' ? 'end' : 'start';
  const tspans = lines.map((l, i) => `<tspan x="${n(x)}" y="${n(top + lh * i + opts.size)}">${esc(l)}</tspan>`).join('');
  return `<text font-family="${esc(opts.font)}" font-size="${opts.size}" fill="${opts.color}" text-anchor="${anchor}"${opts.bold ? ' font-weight="600"' : ''}>${tspans}</text>`;
}

async function dataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface ExportInput {
  objects: CanvasObject[];
  get: Getter;
  /** Area exported (canvas units); null = everything. */
  region: Rect | null;
  /** Page cards: title of each linked page known by the viewer. */
  pageTitles?: Map<string, string>;
}

/** SVG document of the objects intersecting the region (with a margin). */
export async function buildSvg(input: ExportInput): Promise<{ svg: string; width: number; height: number } | null> {
  const resolve = resolver();
  const font = resolve('var(--font-sans)').replace(/"/g, "'") || 'sans-serif';
  const all = [...input.objects].sort(byZ);
  const bounds = (o: CanvasObject) => objectBounds(o, input.get);
  let region = input.region;
  if (!region) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of all) {
      const b = bounds(o);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y - (o.type === 'frame' ? 24 : 0));
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (minX === Infinity) return null;
    region = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const margin = 24;
  const view = { x: region.x - margin, y: region.y - margin, w: region.w + margin * 2, h: region.h + margin * 2 };
  const parts: string[] = [];
  const bg = resolve('var(--bg)');
  parts.push(`<rect x="${n(view.x)}" y="${n(view.y)}" width="${n(view.w)}" height="${n(view.h)}" fill="${bg}"/>`);
  const ink = (c: string) => resolve(`var(--or-cv-ink-${c})`);
  const fill = (c: string) => (c === 'none' ? 'none' : resolve(`var(--or-cv-fill-${c})`));
  for (const o of all) {
    if (!intersects(bounds(o), view)) continue;
    const t = (body: string) => `<g transform="translate(${n(o.x)} ${n(o.y)})">${body}</g>`;
    switch (o.type) {
      case 'frame':
        parts.push(
          t(
            `<rect width="${n(o.w)}" height="${n(o.h)}" rx="6" fill="${o.fill === 'none' ? resolve('var(--or-cv-frame-bg)') : fill(o.fill)}" stroke="${resolve('var(--border-strong)')}"/>` +
              `<text x="0" y="-8" font-family="${esc(font)}" font-size="13" fill="${resolve('var(--text-secondary)')}">${esc(o.name || 'Cadre')}</text>`,
          ),
        );
        break;
      case 'shape': {
        const path = `<path d="${shapePath(o.shape, o.w, o.h)}" fill="${o.fill === 'none' ? 'none' : fill(o.fill)}" stroke="${o.strokeWidth > 0 ? ink(o.stroke) : 'none'}" stroke-width="${o.strokeWidth}"${dashArray(o.dash, o.strokeWidth) ? ` stroke-dasharray="${dashArray(o.dash, o.strokeWidth)}"` : ''} stroke-linejoin="round"/>`;
        const size = CANVAS_FONT_SIZES[o.fontSize];
        const text = o.text ? textBlock(wrap(o.text, o.w - 16, size, font), { x: 0, y: 0, w: o.w, h: o.h }, { size, color: ink(o.textColor), font, align: 'center', valign: 'middle' }) : '';
        parts.push(t(path + text));
        break;
      }
      case 'text': {
        const size = CANVAS_FONT_SIZES[o.fontSize];
        parts.push(t(textBlock(wrap(o.text, o.w, size, font, o.bold), { x: 0, y: 0, w: o.w, h: o.h }, { size, color: ink(o.color), font, align: o.align, valign: 'top', bold: o.bold })));
        break;
      }
      case 'note': {
        const lines = parseNote(o.text).flatMap((l) => wrap(`${l.kind === 'li' ? '• ' : l.kind === 'todo' ? (l.checked ? '☑ ' : '☐ ') : ''}${stripInline(l.text)}`, o.w - 28, 14, font));
        parts.push(
          t(`<rect width="${n(o.w)}" height="${n(o.h)}" rx="4" fill="${resolve(`var(--or-cv-note-${o.fill})`)}"/>` + textBlock(lines, { x: 0, y: 0, w: o.w, h: o.h }, { size: 14, color: resolve('var(--or-cv-note-text)'), font, align: 'left', valign: 'top', pad: 14 })),
        );
        break;
      }
      case 'stroke':
        parts.push(t(`<path d="${freehandPath(o.points, o.size, o.tool)}" fill="${ink(o.color)}"${o.tool === 'highlighter' ? ' opacity="0.38"' : ''}/>`));
        break;
      case 'connector': {
        const r = connectorRoute(o, input.get);
        const color = ink(o.color);
        let body = `<path d="${r.d}" fill="none" stroke="${color}" stroke-width="${o.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dashArray(o.dash, o.strokeWidth) ? ` stroke-dasharray="${dashArray(o.dash, o.strokeWidth)}"` : ''}/>`;
        for (const cap of [capPath(o.startCap, r.start, r.startAngle, o.strokeWidth), capPath(o.endCap, r.end, r.endAngle, o.strokeWidth)]) {
          if (cap) body += `<path d="${cap.d}" fill="${cap.filled ? color : 'none'}" stroke="${color}" stroke-width="${o.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`;
        }
        if (o.label) {
          body += `<text x="${n(r.mid.x)}" y="${n(r.mid.y)}" font-family="${esc(font)}" font-size="14" text-anchor="middle" dominant-baseline="central" fill="${color}" stroke="${bg}" stroke-width="5" paint-order="stroke">${esc(o.label)}</text>`;
        }
        parts.push(body);
        break;
      }
      case 'image': {
        const href = await dataUrl(o.src);
        parts.push(
          t(
            href
              ? `<image href="${href}" width="${n(o.w)}" height="${n(o.h)}" preserveAspectRatio="xMidYMid meet"/>`
              : `<rect width="${n(o.w)}" height="${n(o.h)}" fill="${resolve('var(--bg-subtle)')}"/>`,
          ),
        );
        break;
      }
      case 'file':
      case 'page': {
        const title = o.type === 'file' ? o.name || 'Fichier' : (input.pageTitles?.get(o.pageId) ?? 'Page liée');
        parts.push(
          t(
            `<rect width="${n(o.w)}" height="${n(o.h)}" rx="8" fill="${resolve('var(--bg-elevated)')}" stroke="${resolve('var(--border-strong)')}"/>` +
              textBlock([title], { x: 0, y: 0, w: o.w, h: o.h }, { size: 14, color: resolve('var(--text)'), font, align: 'left', valign: 'middle', pad: 16, bold: true }),
          ),
        );
        break;
      }
      case 'mindmap': {
        const layout = mindLayoutOf(o);
        let body = '';
        for (const l of layout.links) {
          const a = layout.byId.get(l.from)!;
          const b = layout.byId.get(l.to)!;
          const side = b.side === -1 ? -1 : 1;
          const sx = side === 1 ? a.x + a.w : a.x;
          const sy = a.y + a.h / 2;
          const ex = side === 1 ? b.x : b.x + b.w;
          const ey = o.style === 'minimal' ? b.y + b.h : b.y + b.h / 2;
          const k = (ex - sx) / 2;
          const d =
            o.style === 'outline'
              ? `M ${n(sx)} ${n(sy)} L ${n(ex)} ${n(ey)}`
              : o.style === 'org'
                ? `M ${n(sx)} ${n(sy)} H ${n(sx + k)} V ${n(ey)} H ${n(ex)}`
                : `M ${n(sx)} ${n(sy)} C ${n(sx + k)} ${n(sy)}, ${n(ex - k)} ${n(ey)}, ${n(ex)} ${n(ey)}`;
          body += `<path d="${d}" fill="none" stroke="${o.style === 'minimal' ? resolve('var(--border-strong)') : ink(l.color)}" stroke-width="${a.depth === 0 ? 2.5 : 1.75}" stroke-linecap="round"/>`;
        }
        for (const b of layout.boxes) {
          const root = b.depth === 0;
          const solid = root && o.style !== 'outline' && o.style !== 'minimal';
          const boxFill = o.style === 'minimal' ? 'none' : o.style === 'outline' ? bg : solid ? resolve(`var(--or-cv-solid-${b.color === 'default' ? 'blue' : b.color})`) : fill(b.color);
          const stroke = o.style === 'outline' ? ink(b.color === 'default' ? 'gray' : b.color) : 'none';
          body += `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${o.style === 'org' ? 3 : root ? n(b.h / 2) : 8}" fill="${boxFill}" stroke="${stroke}"/>`;
          if (o.style === 'minimal') body += `<line x1="${n(b.x)}" x2="${n(b.x + b.w)}" y1="${n(b.y + b.h)}" y2="${n(b.y + b.h)}" stroke="${ink(b.color)}" stroke-width="2"/>`;
          const size = MIND_FONT(b.depth);
          body += textBlock(wrap(b.text, b.w - 16, size, font, root), b, { size, color: solid ? '#ffffff' : resolve('var(--text)'), font, align: 'center', valign: 'middle', bold: root });
        }
        parts.push(t(body));
        break;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(view.x)} ${n(view.y)} ${n(view.w)} ${n(view.h)}" width="${Math.ceil(view.w)}" height="${Math.ceil(view.h)}">${parts.join('')}</svg>`;
  return { svg, width: Math.ceil(view.w), height: Math.ceil(view.h) };
}

/** PNG of an SVG document (scale ×2, at most 8 000 px per side). */
export async function svgToPng(svg: string, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(2, 8000 / Math.max(width, height));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
