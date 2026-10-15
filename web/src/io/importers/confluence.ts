// Confluence HTML space export (zip) and Google Docs HTML export → pages with blocks.
import type { Blk } from '../blocks';
import { decodeText, looseKey } from '../text';
import { basename, dirname, extname, joinPath, type Vfs } from '../vfs';
import { PlanBuilder, pathHref } from './builder';
import { calloutBlock, HtmlConverter } from './htmlToBlocks';
import { findFirst, hasClass, htmlText, parseHtml, type HtmlElement } from './html';
import { IMPORT_LIMITS } from './limits';
import { ImportError } from './limits';

const isHtml = (p: string) => ['html', 'htm'].includes(extname(p));
const CALLOUT: Record<string, string> = { information: 'ℹ️', note: '📝', warning: '⚠️', tip: '💡', success: '✅', error: '⛔' };

export function looksLikeConfluence(html: string): boolean {
  const head = html.slice(0, 20000);
  return /id="main-content"/.test(head) && (/wiki-content/.test(head) || /confluence/i.test(head));
}
export function looksLikeGoogleDocs(html: string): boolean {
  // QA-G8-02: `[^>]*` gaps bounded (unbounded, they rescanned the head from every match: ≈3.6 s per file).
  return /docs-internal-guid|name="generator"[^>]{0,500}Google|class="doc-content"|<style[^>]{0,500}>[^<]*\.lst-kix_/i.test(html.slice(0, 200000));
}

function resolver(vfs: Vfs, pagePath: string, b: PlanBuilder, label: string, pages: Set<string>) {
  return (raw: string): string | null => {
    const u = raw.trim();
    if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.startsWith('/')) return null;
    const noFrag = u.replace(/[?#].*$/, '');
    let dec = noFrag;
    try {
      dec = decodeURIComponent(noFrag);
    } catch {
      /* keep */
    }
    const path = joinPath(dirname(pagePath), dec);
    if (pages.has(looseKey(path)) || vfs.resolve(path)) return pathHref(vfs.resolve(path)?.path ?? path);
    b.warnings.push(`${label} : fichier lié introuvable (${dec.slice(0, 80)}).`);
    return null;
  };
}

function confluenceBlock(el: HtmlElement, convert: (c: Array<HtmlElement | string>) => Blk[]): Blk[] | null {
  const cls = el.attrs.class ?? '';
  if (el.name === 'div' || el.name === 'span') {
    if (hasClass(el, 'toc-macro') || hasClass(el, 'greybox') || hasClass(el, 'plugin_pagetree')) return [];
    const info = /confluence-information-macro-(information|note|warning|tip|success|error)/.exec(cls);
    if (info) {
      const body = findFirst(el, (e) => hasClass(e, 'confluence-information-macro-body'));
      return [calloutBlock(CALLOUT[info[1]!]!, convert(body ? body.children : el.children))];
    }
    if (hasClass(el, 'panel')) {
      const body = findFirst(el, (e) => hasClass(e, 'panelContent'));
      const title = findFirst(el, (e) => hasClass(e, 'panelHeader'));
      const inner = convert(body ? body.children : el.children);
      if (title) inner.unshift({ type: 'paragraph', content: [{ type: 'text', text: htmlText(title).trim(), styles: { bold: true } }], children: [] });
      return [calloutBlock('📌', inner)];
    }
    if (hasClass(el, 'expand-container')) {
      const ctl = findFirst(el, (e) => hasClass(e, 'expand-control-text'));
      const body = findFirst(el, (e) => hasClass(e, 'expand-content'));
      return [{ type: 'toggleListItem', content: [{ type: 'text', text: ctl ? htmlText(ctl).trim() : 'Détails', styles: {} }], children: body ? convert(body.children) : [] }];
    }
    if (hasClass(el, 'code') && hasClass(el, 'panel')) return null;
  }
  return null;
}

/** Plans every HTML page of a Confluence export. Returns false when none was recognized. */
export async function planConfluence(b: PlanBuilder, vfs: Vfs): Promise<boolean> {
  const files = vfs.list().filter((f) => isHtml(f.path));
  const pages: Array<{ path: string; html: string; title: string; crumbs: string[]; root: HtmlElement; main: HtmlElement }> = [];
  for (const f of files) {
    if (f.size > IMPORT_LIMITS.maxTextPartBytes) {
      b.warnings.push(`« ${f.path} » est trop volumineux, ignoré.`);
      continue;
    }
    const html = decodeText(await f.read());
    if (!looksLikeConfluence(html)) continue;
    try {
      const root = parseHtml(html);
      const main = findFirst(root, (e) => e.attrs.id === 'main-content');
      if (!main) continue;
      const titleEl = findFirst(root, (e) => e.attrs.id === 'title-text');
      let title = (titleEl ? htmlText(titleEl) : (basename(f.path).replace(/\.html?$/i, '').replace(/_\d+$/, '').replace(/_/g, ' '))).trim();
      const colon = title.indexOf(' : ');
      if (colon > 0 && colon < 40) title = title.slice(colon + 3);
      const crumbs: string[] = [];
      const bc = findFirst(root, (e) => e.attrs.id === 'breadcrumbs');
      if (bc) {
        const walk = (e: HtmlElement) => {
          for (const c of e.children) {
            if (typeof c === 'string') continue;
            if (c.name === 'a' && c.attrs.href) crumbs.push(joinPath(dirname(f.path), decodeURIComponent(c.attrs.href.replace(/[?#].*$/, ''))));
            else walk(c);
          }
        };
        walk(bc);
      }
      pages.push({ path: f.path, html, title: title || 'Sans titre', crumbs, root, main });
    } catch (e) {
      b.warnings.push(`« ${f.path} » ignoré : ${(e as Error).message}`);
    }
  }
  if (pages.length === 0) return false;
  const known = new Set(pages.map((p) => looseKey(p.path)));
  const created = new Map<string, ReturnType<PlanBuilder['page']>>();
  // Parents first: depth = number of known breadcrumb ancestors.
  const parentPath = (p: (typeof pages)[number]): string | null => {
    for (let i = p.crumbs.length - 1; i >= 0; i--) {
      const c = p.crumbs[i]!;
      if (looseKey(c) !== looseKey(p.path) && known.has(looseKey(c))) return c;
    }
    return null;
  };
  const ordered = [...pages].sort((a, c) => a.crumbs.length - c.crumbs.length);
  for (const p of ordered) {
    const par = parentPath(p);
    const parent = par ? created.get(looseKey(par)) ?? null : null;
    const conv = new HtmlConverter(p.root, {
      resolveUrl: resolver(vfs, p.path, b, p.title, known),
      block: confluenceBlock,
      warn: (m) => b.warnings.push(`« ${p.title} » : ${m}`),
    });
    let blocks: Blk[] = [];
    try {
      blocks = conv.convert(p.main.children);
    } catch (e) {
      b.warnings.push(`« ${p.title} » : contenu non converti (${(e as Error).message}).`);
    }
    const idMatch = /_(\d+)\.html?$/i.exec(p.path);
    const dirPath = idMatch ? joinPath(dirname(p.path), `attachments/${idMatch[1]}`) : undefined;
    const page = b.page({ title: p.title, parent, blocks, sourcePath: p.path, dirPath });
    created.set(looseKey(p.path), page);
  }
  // Attachments (files under attachments/, images/ that pages reference are uploaded on demand).
  for (const f of vfs.list()) if (/(^|\/)attachments\//.test(f.path) && !isHtml(f.path)) b.attach(f.path);
  return true;
}

/** One Google Docs HTML export (or any single HTML document) → one page. */
export function planHtmlDocument(b: PlanBuilder, vfs: Vfs, path: string, html: string): void {
  const root = parseHtml(html);
  const body = findFirst(root, (e) => e.name === 'body') ?? root;
  const titleEl = findFirst(root, (e) => e.name === 'title');
  const known = new Set<string>();
  const conv = new HtmlConverter(root, {
    resolveUrl: resolver(vfs, path, b, basename(path), known),
    dataImage: (mime, base64) => {
      if (base64.length > 48_000_000) return null;
      const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*/, '') ?? 'png';
      const p = joinPath(dirname(path), `${basename(path).replace(/\.[^.]+$/, '')}.images/image-${vfs.size + 1}.${ext}`);
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      vfs.add({ path: p, size: bytes.length, read: async () => bytes });
      return pathHref(p);
    },
    warn: (m) => b.warnings.push(`${basename(path)} : ${m}`),
  });
  const blocks = conv.convert(body.children);
  if (blocks.length === 0) throw new ImportError(`« ${basename(path)} » ne contient aucun texte importable.`);
  const first = blocks[0];
  let title = titleEl ? htmlText(titleEl).trim() : '';
  if (!title && first?.type === 'heading') title = ((first.content as Array<{ text?: string }>) ?? []).map((r) => r.text ?? '').join('').trim();
  b.page({ title: title || basename(path).replace(/\.[^.]+$/, ''), blocks, sourcePath: path });
}
