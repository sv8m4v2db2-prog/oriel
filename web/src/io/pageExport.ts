// Exports of ONE page (H5): standalone HTML and PNG image. The HTML is built from the editor's own
// serialization (blocksToHTMLLossy), then cleaned (no script, no frame, no handler, no active URL),
// its uploaded images are inlined (bounded), its footnotes listed, its diagrams drawn as sanitized SVG.
// The PNG is the same HTML drawn by the browser (SVG foreignObject → canvas), light theme, never sent
// anywhere. Markdown and PDF stay in editor/registry.ts and page/print.ts.
import { sanitizeSvg } from '../editor/svgSanitize';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Largest uploaded image inlined (bytes) and total inlined per page; beyond, images stay linked. */
export const EXPORT_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const EXPORT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
/** Most diagrams (Mermaid / ABC / Typst) drawn in one export. */
export const EXPORT_MAX_DIAGRAMS = 30;
/** PNG: width of the page (CSS px), tallest page (CSS px), density. */
export const PNG_WIDTH = 800;
export const PNG_MAX_HEIGHT = 16_000;
export const PNG_SCALE = 2;

// ---------------------------------------------------------------------------
// Sanitizing (works on any tree exposing the few DOM members below, so that tests need no browser)
// ---------------------------------------------------------------------------

export interface TreeNode {
  tagName: string;
  children: ArrayLike<TreeNode>;
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  remove(): void;
}

/** Elements that are removed with their content: nothing active, nothing that loads another document. */
const DROPPED_ELEMENTS = new Set([
  'SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'NOSCRIPT', 'TEMPLATE', 'PORTAL', 'DIALOG', 'FOREIGNOBJECT', 'ANIMATE', 'ANIMATETRANSFORM', 'SET',
]);
/** Attributes that hold a URL. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'srcset']);
const SCHEME = /^[\s\u0000-\u001f]*([a-z][a-z0-9+.-]*):/i;

/** True when a URL attribute value may stay in a document that must hold no script. */
export function isSafeExportUrl(value: string, attribute: string, tag: string): boolean {
  // Control characters and spaces are ignored by URL parsers: `java\nscript:` is `javascript:`.
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000- \u007f-\u009f]+/g, '');
  const m = SCHEME.exec(flat);
  if (!m) return true; // relative, fragment, network-path
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return true;
  // Images drawn from data: (inline images, drawings): raster or SVG, which is inert inside <img>.
  if (scheme === 'data') return attribute === 'src' && tag === 'IMG' && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(flat);
  return false;
}

/**
 * Removes from the tree what could execute or load code: dangerous elements, every `on*` attribute,
 * `srcdoc`, `style` values with `expression(` / `javascript:` / `@import`, and URL attributes with an
 * active scheme. Returns the number of removals. Iterative (an adversarial page may nest deeply).
 */
export function sanitizeExportTree(root: TreeNode): number {
  let removed = 0;
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toUpperCase();
      if (DROPPED_ELEMENTS.has(tag)) {
        child.remove();
        removed++;
        continue;
      }
      for (const name of child.getAttributeNames()) {
        const lower = name.toLowerCase();
        const value = child.getAttribute(name) ?? '';
        let drop = false;
        if (lower.startsWith('on') || lower === 'srcdoc') drop = true;
        else if (URL_ATTRIBUTES.has(lower)) {
          if (lower === 'srcset') drop = true;
          else drop = !isSafeExportUrl(value, lower === 'xlink:href' ? 'href' : lower, tag);
        } else if (lower === 'style') drop = /expression\s*\(|javascript:|vbscript:|@import|behaviou?r\s*:|-moz-binding/i.test(value);
        if (drop) {
          child.removeAttribute(name);
          removed++;
        }
      }
      stack.push(child);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** Meta CSP of the exported file: it cannot run a script even if one slipped through. */
export const EXPORT_CSP = "default-src 'none'; img-src data: https: http:; media-src https: http:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

export const EXPORT_CSS = `
:root { color-scheme: light dark; --fg: #1f2328; --bg: #ffffff; --muted: #5f6670; --line: #d1d5db; --soft: #f3f4f6; --accent: #1c7ed6; }
@media (prefers-color-scheme: dark) { :root:not(.or-png) { --fg: #e6e8eb; --bg: #1a1b1e; --muted: #a5abb3; --line: #3a3d42; --soft: #25262b; --accent: #74c0fc; } }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.6; }
.or-png { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.6; }
.or-doc { max-width: 760px; margin: 0 auto; padding: 48px 24px 72px; overflow-wrap: anywhere; }
.or-doc__title { font-size: 2.1em; line-height: 1.25; margin: 0 0 0.6em; }
.or-doc h1 { font-size: 1.8em; margin: 1.2em 0 0.4em; } .or-doc h2 { font-size: 1.45em; margin: 1.1em 0 0.4em; }
.or-doc h3 { font-size: 1.2em; margin: 1em 0 0.3em; } .or-doc h4 { font-size: 1.05em; margin: 1em 0 0.3em; }
.or-doc p { margin: 0.5em 0; } .or-doc ul, .or-doc ol { padding-left: 1.6em; margin: 0.4em 0; }
.or-doc img, .or-doc video, .or-doc svg { max-width: 100%; height: auto; }
.or-doc pre { background: var(--soft); padding: 12px 16px; border-radius: 6px; overflow: auto; white-space: pre-wrap; }
.or-doc code { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em; }
.or-doc :not(pre) > code { background: var(--soft); padding: 0.1em 0.35em; border-radius: 4px; }
.or-doc blockquote { border-left: 3px solid var(--line); margin: 0.6em 0; padding-left: 16px; color: var(--muted); }
.or-doc table { border-collapse: collapse; margin: 0.6em 0; } .or-doc td, .or-doc th { border: 1px solid var(--line); padding: 6px 10px; }
.or-doc hr { border: 0; border-top: 1px solid var(--line); margin: 1.4em 0; }
.or-doc a { color: var(--accent); }
.or-doc math[display='block'] { margin: 12px 0; }
.or-doc figure.or-diagram { margin: 0.8em 0; text-align: center; } .or-doc figure.or-diagram svg { background: #fff; }
.or-doc details > summary { cursor: pointer; }
.or-doc sup.or-fn a { text-decoration: none; font-weight: 600; }
.or-doc section.or-footnotes { margin-top: 3em; border-top: 1px solid var(--line); padding-top: 0.6em; font-size: 0.88em; color: var(--muted); }
.or-doc section.or-footnotes ol { padding-left: 1.4em; }
.or-doc__meta { margin-top: 3em; font-size: 0.8em; color: var(--muted); }
`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ExportEditorLike {
  document: unknown[];
  blocksToHTMLLossy(blocks: never): string;
}

export interface BuildOptions {
  title: string;
  heading: string;
  /** `png`: every image must be inlined (a foreignObject image loads nothing from outside). */
  forImage?: boolean;
  /** Diagram renderer (editor/diagramRenderers.renderDiagram), injected for tests. */
  renderDiagram?: (kind: 'mermaid' | 'abc' | 'typst', source: string) => Promise<{ ok: true; svgs: string[] } | { ok: false; error: string }>;
  signal?: AbortSignal;
}

export interface BuiltPage {
  /** Complete HTML file. */
  html: string;
  /** Inner HTML of the page (title and content), without document wrapper. */
  body: string;
  warnings: string[];
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

async function toDataUrl(url: string, budget: { left: number }, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > EXPORT_MAX_IMAGE_BYTES || blob.size > budget.left) return null;
    const type = blob.type || 'application/octet-stream';
    if (!/^image\//i.test(type)) return null;
    budget.left -= blob.size;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Footnote calls of the cleaned DOM → numbered links, and the list of notes. Returns the list HTML. */
function numberFootnotes(root: ParentNode): string {
  const calls = Array.from(root.querySelectorAll('sup[data-or-fn]'));
  if (calls.length === 0) return '';
  const items: string[] = [];
  calls.forEach((sup, i) => {
    const n = i + 1;
    const note = (sup.getAttribute('data-or-fn') ?? '').slice(0, 1000);
    sup.removeAttribute('data-or-fn');
    sup.className = 'or-fn';
    sup.id = `fnref-${n}`;
    const link = sup.ownerDocument.createElement('a');
    link.href = `#fn-${n}`;
    link.textContent = String(n);
    sup.replaceChildren(link);
    items.push(`<li id="fn-${n}">${escapeHtml(note) || '&nbsp;'} <a href="#fnref-${n}" aria-label="Revenir à l’appel de la note ${n}">↩</a></li>`);
  });
  return `<section class="or-footnotes" aria-label="Notes de bas de page"><ol>${items.join('')}</ol></section>`;
}

/** Code blocks of Mermaid / ABC / Typst become drawings (the source stays in a <details>). */
async function drawDiagrams(root: ParentNode, opts: BuildOptions, warnings: string[]): Promise<void> {
  const render = opts.renderDiagram;
  if (!render) return;
  const KINDS = new Set(['mermaid', 'abc', 'typst']);
  let done = 0;
  for (const code of Array.from(root.querySelectorAll('pre > code, pre[data-language]'))) {
    const pre = code.tagName === 'PRE' ? code : code.parentElement!;
    const lang =
      (pre.getAttribute('data-language') ?? '').toLowerCase() ||
      /(?:^|\s)language-([\w-]+)/.exec(code.getAttribute('class') ?? '')?.[1]?.toLowerCase() ||
      '';
    if (!KINDS.has(lang)) continue;
    if (done >= EXPORT_MAX_DIAGRAMS) {
      warnings.push(`Plus de ${EXPORT_MAX_DIAGRAMS} diagrammes : les suivants restent en code.`);
      break;
    }
    opts.signal?.throwIfAborted();
    const source = pre.textContent ?? '';
    const result = await render(lang as 'mermaid' | 'abc' | 'typst', source);
    if (!result.ok) continue;
    const figure = pre.ownerDocument.createElement('figure');
    figure.className = 'or-diagram';
    for (const svg of result.svgs) {
      const safe = sanitizeSvg(svg);
      if (safe) figure.insertAdjacentHTML('beforeend', safe);
    }
    if (!figure.firstElementChild) continue;
    if (!opts.forImage) {
      const details = pre.ownerDocument.createElement('details');
      const summary = pre.ownerDocument.createElement('summary');
      summary.textContent = 'Code source';
      pre.replaceWith(figure);
      details.append(summary, pre);
      figure.after(details);
    } else pre.replaceWith(figure);
    done++;
  }
}

async function inlineImages(root: ParentNode, opts: BuildOptions, warnings: string[]): Promise<void> {
  const budget = { left: EXPORT_MAX_TOTAL_BYTES };
  const images = Array.from(root.querySelectorAll('img[src]'));
  let kept = 0;
  const work = async (img: Element) => {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('data:')) return;
    const abs = absoluteUrl(src);
    const same = abs.startsWith(location.origin + '/');
    // Uploaded files: always tried. Other https images only for the PNG (they must be drawn by the page).
    if (same || opts.forImage) {
      const data = await toDataUrl(abs, budget, opts.signal);
      if (data) {
        img.setAttribute('src', data);
        return;
      }
    }
    if (opts.forImage) {
      // A foreignObject cannot load it: leave a visible placeholder rather than a broken image.
      const span = img.ownerDocument.createElement('span');
      span.textContent = `[image : ${img.getAttribute('alt') || src.split('/').pop() || 'non incluse'}]`;
      img.replaceWith(span);
      kept++;
    } else {
      img.setAttribute('src', abs);
      if (same) kept++;
    }
  };
  // Four at a time.
  const iterator = images[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        opts.signal?.throwIfAborted();
        await work(next.value);
      }
    }),
  );
  if (kept > 0) {
    warnings.push(
      opts.forImage
        ? `${kept} image(s) n’ont pas pu être incluses dans l’image.`
        : `${kept} image(s) trop volumineuses restent liées à l’application (elles ne s’afficheront que connecté).`,
    );
  }
}

/** Absolute links for what points into the application (files, pages): the file may be opened anywhere. */
function absolutizeLinks(root: ParentNode) {
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('/') && !href.startsWith('//')) a.setAttribute('href', absoluteUrl(href));
  }
  for (const el of Array.from(root.querySelectorAll('video[src], audio[src], source[src]'))) {
    const src = el.getAttribute('src') ?? '';
    if (src.startsWith('/')) el.setAttribute('src', absoluteUrl(src));
  }
}

/** Builds the standalone page from already serialized HTML (see exportPageHtml for the editor side). */
export async function buildPageFromHtml(contentHtml: string, opts: BuildOptions): Promise<BuiltPage> {
  const warnings: string[] = [];
  const parsed = new DOMParser().parseFromString(`<div class="or-doc__content">${contentHtml}</div>`, 'text/html');
  const content = parsed.body.firstElementChild as HTMLElement;
  sanitizeExportTree(content as unknown as TreeNode);
  const footnotes = numberFootnotes(content);
  await drawDiagrams(content, opts, warnings);
  await inlineImages(content, opts, warnings);
  absolutizeLinks(content);
  // Links opened from a file on disk must not leak the file's origin or control the opener.
  for (const a of Array.from(content.querySelectorAll('a[href]'))) {
    if (!a.getAttribute('href')!.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  const body = `<h1 class="or-doc__title">${escapeHtml(opts.heading)}</h1>\n${content.innerHTML}\n${footnotes}`;
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(EXPORT_CSP)}" />
<meta name="generator" content="Oriel" />
<title>${escapeHtml(opts.title || 'Sans titre')}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<main class="or-doc">
${body}
</main>
</body>
</html>
`;
  // Belt and braces: whatever the cleaning missed, a file with an active element is not delivered.
  if (/<\s*(script|iframe|object|embed)\b/i.test(html.replace(/<style>[\s\S]*?<\/style>/i, ''))) throw new Error('Le contenu contient un élément actif : export refusé.');
  return { html, body, warnings };
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

export interface PngLimits {
  /** Page height (CSS px). */
  height: number;
}

/** Scale to draw a page of `height` CSS px (≤ PNG_SCALE), or null when it is taller than PNG_MAX_HEIGHT. */
export function pngScale(height: number): number | null {
  if (!Number.isFinite(height) || height <= 0) return null;
  if (height > PNG_MAX_HEIGHT) return null;
  return PNG_SCALE;
}

/** Draws the built page as a PNG (light theme, PNG_WIDTH wide). */
export async function renderPng(page: BuiltPage): Promise<Blob> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${PNG_WIDTH}px;pointer-events:none;visibility:hidden`;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = EXPORT_CSS;
  const root = document.createElement('div');
  root.className = 'or-png';
  root.style.cssText = `width:${PNG_WIDTH}px;background:#fff;color:#1f2328;`;
  const main = document.createElement('main');
  main.className = 'or-doc';
  main.style.cssText = 'padding:32px 28px 40px;margin:0;max-width:none';
  main.innerHTML = page.body;
  root.append(main);
  shadow.append(style, root);
  document.body.appendChild(host);
  try {
    // Fonts and images are in place: wait a frame so that layout is final before measuring.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const height = Math.ceil(root.getBoundingClientRect().height);
    const scale = pngScale(height);
    if (scale === null) throw new Error(`La page est trop longue pour une image (${PNG_MAX_HEIGHT.toLocaleString('fr-FR')} px au plus).`);
    // Same markup, serialized as XML for the SVG foreignObject (the stylesheet travels with it).
    const xhtml = new XMLSerializer().serializeToString(
      (() => {
        const wrap = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        wrap.setAttribute('class', 'or-png');
        wrap.setAttribute('style', `width:${PNG_WIDTH}px;background:#fff;color:#1f2328;`);
        const st = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
        st.textContent = EXPORT_CSS;
        const m = main.cloneNode(true) as HTMLElement;
        wrap.append(st, m);
        return wrap;
      })(),
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PNG_WIDTH * scale}" height="${height * scale}" viewBox="0 0 ${PNG_WIDTH} ${height}"><foreignObject x="0" y="0" width="${PNG_WIDTH}" height="${height}">${xhtml}</foreignObject></svg>`;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Le navigateur n’a pas pu dessiner la page.'));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = PNG_WIDTH * scale;
    canvas.height = height * scale;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Image impossible dans ce navigateur.');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image impossible.'))), 'image/png'));
  } finally {
    host.remove();
  }
}
