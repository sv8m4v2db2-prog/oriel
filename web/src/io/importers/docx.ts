// Word (.docx) → page. Reads word/document.xml (+ styles, numbering, relationships, footnotes) with
// the safe XML reader. Embedded images become attachments of the virtual file system.
import type { Blk } from '../blocks';
import { basename, extname, type Vfs } from '../vfs';
import { pathHref } from './builder';
import { IMPORT_LIMITS, ImportError } from './limits';
import { openBoundedZip, type InflateBudget } from './safeZip';
import { child, childrenNamed, elements, parseXml, textOf, type XmlElement } from './xml';
import { mergeRuns, type Inline, type Styles, type TextRun } from './htmlToBlocks';

export interface DocxResult {
  title: string;
  blocks: Blk[];
  warnings: string[];
  images: number;
}

const attr = (el: XmlElement | undefined, name: string): string | undefined => el?.attrs[name];
const val = (el: XmlElement | undefined) => attr(el, 'w:val');
/** `<w:b/>` is on unless `w:val` is false/0/none. */
const on = (el: XmlElement | undefined): boolean => !!el && !['false', '0', 'none', 'off'].includes((val(el) ?? '').toLowerCase());

interface Numbering {
  /** numId → ilvl → ordered? */
  ordered(numId: string, ilvl: number): boolean;
}

function parseNumbering(root: XmlElement | null): Numbering {
  const abstract = new Map<string, Map<number, string>>();
  const nums = new Map<string, string>();
  if (root) {
    for (const a of childrenNamed(root, 'w:abstractNum')) {
      const lv = new Map<number, string>();
      for (const l of childrenNamed(a, 'w:lvl')) lv.set(Number(l.attrs['w:ilvl'] ?? 0), val(child(l, 'w:numFmt')) ?? 'bullet');
      abstract.set(a.attrs['w:abstractNumId'] ?? '', lv);
    }
    for (const n of childrenNamed(root, 'w:num')) nums.set(n.attrs['w:numId'] ?? '', val(child(n, 'w:abstractNumId')) ?? '');
  }
  return {
    ordered(numId, ilvl) {
      const fmt = abstract.get(nums.get(numId) ?? '')?.get(ilvl);
      return !!fmt && fmt !== 'bullet' && fmt !== 'none';
    },
  };
}

function parseRels(root: XmlElement | null): Map<string, { target: string; external: boolean }> {
  const out = new Map<string, { target: string; external: boolean }>();
  if (root) for (const r of elements(root)) out.set(r.attrs.Id ?? '', { target: r.attrs.Target ?? '', external: (r.attrs.TargetMode ?? '') === 'External' });
  return out;
}

/** Style id → heading level (1–4) from styles.xml names and outline levels. */
function parseStyles(root: XmlElement | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!root) return out;
  for (const s of childrenNamed(root, 'w:style')) {
    const id = s.attrs['w:styleId'] ?? '';
    const name = (val(child(s, 'w:name')) ?? '').toLowerCase();
    const m = /^(?:heading|titre)\s*(\d)$/.exec(name);
    if (m) out.set(id, Math.min(4, Number(m[1])));
    else if (name === 'title' || name === 'titre') out.set(id, 1);
    else if (name === 'subtitle' || name === 'sous-titre') out.set(id, 2);
    else {
      const lvl = val(child(child(s, 'w:pPr') ?? s, 'w:outlineLvl'));
      if (lvl !== undefined && Number(lvl) < 9) out.set(id, Math.min(4, Number(lvl) + 1));
    }
  }
  return out;
}

export async function docxToBlocks(input: Blob | Uint8Array, fileName: string, vfs: Vfs, mediaDir: string, budget?: InflateBudget): Promise<DocxResult> {
  const zip = await openBoundedZip(input, fileName, budget);
  const warnings = [...zip.warnings];
  const docXml = await zip.readText('word/document.xml');
  if (!docXml) throw new ImportError(`« ${fileName} » n’est pas un document Word valide (word/document.xml absent).`);
  const doc = parseXml(docXml);
  const numbering = parseNumbering(zip.has('word/numbering.xml') ? parseXml((await zip.readText('word/numbering.xml'))!) : null);
  const styles = parseStyles(zip.has('word/styles.xml') ? parseXml((await zip.readText('word/styles.xml'))!) : null);
  const rels = parseRels(zip.has('word/_rels/document.xml.rels') ? parseXml((await zip.readText('word/_rels/document.xml.rels'))!) : null);
  const footRoot = zip.has('word/footnotes.xml') ? parseXml((await zip.readText('word/footnotes.xml'))!) : null;
  const footnotes = new Map<string, XmlElement>();
  if (footRoot) for (const f of childrenNamed(footRoot, 'w:footnote')) footnotes.set(f.attrs['w:id'] ?? '', f);

  let images = 0;
  const usedFootnotes: string[] = [];
  const mounted = new Map<string, string>();

  const mountImage = (relId: string): string | null => {
    const rel = rels.get(relId);
    if (!rel || rel.external) return rel?.external && /^https?:/i.test(rel.target) ? rel.target : null;
    const entry = rel.target.replace(/^\//, '').startsWith('word/') ? rel.target.replace(/^\//, '') : `word/${rel.target}`;
    const clean = entry.split('/').filter((s) => s && s !== '.').join('/');
    if (!zip.has(clean)) return null;
    let path = mounted.get(clean);
    if (!path) {
      path = `${mediaDir}/${basename(clean)}`;
      mounted.set(clean, path);
      vfs.add({ path, size: zip.files.get(clean)?.size ?? 0, read: () => zip.read(clean, 64 * 1024 * 1024) });
      images++;
    }
    return pathHref(path);
  };

  const runInline = (run: XmlElement, base: Styles, out: Array<Inline | Blk>): void => {
    const rPr = child(run, 'w:rPr');
    const st: Styles = { ...base };
    if (rPr) {
      if (on(child(rPr, 'w:b'))) st.bold = true;
      if (on(child(rPr, 'w:i'))) st.italic = true;
      const u = child(rPr, 'w:u');
      if (u && on(u)) st.underline = true;
      if (on(child(rPr, 'w:strike')) || on(child(rPr, 'w:dstrike'))) st.strike = true;
      const font = child(rPr, 'w:rFonts')?.attrs['w:ascii'] ?? '';
      if (/(courier|consolas|monaco|menlo)/i.test(font)) st.code = true;
    }
    for (const c of elements(run)) {
      switch (c.name) {
        case 'w:t':
        case 'w:instrText':
          if (c.name === 'w:t') out.push({ type: 'text', text: textOf(c), styles: st });
          break;
        case 'w:tab':
          out.push({ type: 'text', text: '\t', styles: st });
          break;
        case 'w:br':
        case 'w:cr':
          out.push({ type: 'text', text: '\n', styles: st });
          break;
        case 'w:footnoteReference': {
          const id = c.attrs['w:id'] ?? '';
          if (footnotes.has(id)) {
            usedFootnotes.push(id);
            out.push({ type: 'text', text: `[${usedFootnotes.length}]`, styles: { ...st, italic: true } });
          }
          break;
        }
        case 'w:drawing':
        case 'w:pict': {
          const stack: XmlElement[] = [c];
          let found: string | null = null;
          let alt = '';
          while (stack.length && !found) {
            const e = stack.pop()!;
            const embed = e.attrs['r:embed'] ?? e.attrs['r:id'];
            if (embed && (e.name === 'a:blip' || e.name === 'v:imagedata')) found = embed;
            if (e.name === 'wp:docPr') alt = e.attrs.descr ?? e.attrs.name ?? '';
            for (const k of elements(e)) stack.push(k);
          }
          const url = found ? mountImage(found) : null;
          if (url) out.push({ type: 'image', props: { url, name: alt || 'image', caption: alt || undefined } } as Blk);
          else warnings.push('Une image du document n’a pas pu être importée.');
          break;
        }
      }
    }
  };

  const inlineOf = (node: XmlElement, base: Styles, out: Array<Inline | Blk>, depth = 0): void => {
    if (depth > IMPORT_LIMITS.maxDepth) throw new ImportError('Document Word trop profondément imbriqué.');
    for (const c of elements(node)) {
      switch (c.name) {
        case 'w:r':
          runInline(c, base, out);
          break;
        case 'w:hyperlink': {
          const inner: Array<Inline | Blk> = [];
          inlineOf(c, base, inner, depth + 1);
          const rid = c.attrs['r:id'];
          const rel = rid ? rels.get(rid) : undefined;
          const href = rel?.external ? rel.target : '';
          const runs = inner.filter((i): i is TextRun => i.type === 'text');
          if (/^(https?:|mailto:|tel:)/i.test(href) && runs.length) out.push({ type: 'link', href, content: runs });
          else out.push(...inner);
          break;
        }
        case 'w:ins':
        case 'w:smartTag':
        case 'w:sdt':
        case 'w:sdtContent':
        case 'w:fldSimple':
          inlineOf(c, base, out, depth + 1);
          break;
        case 'mc:AlternateContent': {
          const choice = child(c, 'mc:Choice') ?? child(c, 'mc:Fallback');
          if (choice) inlineOf(choice, base, out, depth + 1);
          break;
        }
        default:
      }
    }
  };

  const paragraphBlocks = (p: XmlElement): Blk[] => {
    const items: Array<Inline | Blk> = [];
    inlineOf(p, {}, items);
    const runs: Inline[] = [];
    const files: Blk[] = [];
    for (const it of items) {
      if (it.type === 'text' || it.type === 'link') runs.push(it as Inline);
      else files.push(it as Blk);
    }
    const content = mergeRuns(runs);
    const pPr = child(p, 'w:pPr');
    const out: Blk[] = [];
    const empty = content.length === 0 || content.every((r) => r.type === 'text' && !r.text.trim());
    if (!empty) {
      const style = val(child(pPr ?? p, 'w:pStyle')) ?? '';
      const level = styles.get(style) ?? (/^(heading|titre)(\d)$/i.exec(style) ? Math.min(4, Number(/(\d)$/.exec(style)![1])) : undefined);
      const numPr = child(pPr ?? p, 'w:numPr');
      const numId = val(child(numPr ?? p, 'w:numId'));
      if (level) out.push({ type: 'heading', props: { level }, content, children: [] });
      else if (numPr && numId && numId !== '0') {
        const ilvl = Number(val(child(numPr, 'w:ilvl')) ?? 0);
        out.push({ type: numbering.ordered(numId, ilvl) ? 'numberedListItem' : 'bulletListItem', props: { __level: ilvl }, content, children: [] });
      } else out.push({ type: 'paragraph', content, children: [] });
    }
    return [...out, ...files];
  };

  const tableBlock = (tbl: XmlElement): Blk | null => {
    const rows = childrenNamed(tbl, 'w:tr').slice(0, 500).map((tr) => ({
      cells: childrenNamed(tr, 'w:tc').slice(0, 50).map((tc) => {
        const parts: Inline[] = [];
        for (const p of childrenNamed(tc, 'w:p')) {
          const items: Array<Inline | Blk> = [];
          inlineOf(p, {}, items);
          const runs = items.filter((i): i is Inline => i.type === 'text' || i.type === 'link');
          if (parts.length && runs.length) parts.push({ type: 'text', text: '\n', styles: {} });
          parts.push(...runs);
        }
        return mergeRuns(parts);
      }),
    }));
    const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (!rows.length || !width) return null;
    for (const r of rows) while (r.cells.length < width) r.cells.push([]);
    return { type: 'table', content: { type: 'tableContent', rows }, children: [] };
  };

  // Body, with list items nested by their level.
  const blocks: Blk[] = [];
  const path: Blk[] = [];
  const body = child(doc, 'w:body') ?? doc;
  const walkBody = (container: XmlElement, depth: number) => {
    if (depth > IMPORT_LIMITS.maxDepth) throw new ImportError('Document Word trop profondément imbriqué.');
    for (const el of elements(container)) {
      if (el.name === 'w:p') {
        for (const b of paragraphBlocks(el)) {
          const lvl = b.props?.__level;
          if (typeof lvl === 'number') {
            delete b.props!.__level;
            const level = Math.min(lvl, path.length);
            const parent = level > 0 ? path[level - 1] : undefined;
            if (parent) (parent.children ??= []).push(b);
            else blocks.push(b);
            path.length = level;
            path[level] = b;
          } else {
            path.length = 0;
            blocks.push(b);
          }
        }
      } else if (el.name === 'w:tbl') {
        path.length = 0;
        const t = tableBlock(el);
        if (t) blocks.push(t);
      } else if (el.name === 'w:sdt') {
        const content = child(el, 'w:sdtContent');
        if (content) walkBody(content, depth + 1);
      }
    }
  };
  walkBody(body, 0);

  if (usedFootnotes.length) {
    blocks.push({ type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Notes', styles: {} }], children: [] });
    usedFootnotes.forEach((id, i) => {
      const note = footnotes.get(id)!;
      const items: Array<Inline | Blk> = [];
      for (const p of childrenNamed(note, 'w:p')) inlineOf(p, {}, items);
      const runs = mergeRuns(items.filter((x): x is Inline => x.type === 'text' || x.type === 'link')).filter((r) => r.type !== 'text' || r.text.trim());
      blocks.push({ type: 'numberedListItem', content: [{ type: 'text', text: `[${i + 1}] `, styles: {} }, ...runs], children: [] });
    });
  }

  const first = blocks.find((b) => b.type === 'heading' && b.props?.level === 1);
  const title = first ? (first.content as Inline[]).map((r) => (r.type === 'text' ? r.text : r.content.map((c) => c.text).join(''))).join('') : '';
  return { title: title.trim() || fileName.replace(/\.[^.]+$/, ''), blocks, warnings, images };
}

export const isDocx = (name: string) => extname(name) === 'docx';
