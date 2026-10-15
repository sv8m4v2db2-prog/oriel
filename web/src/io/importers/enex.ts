// Evernote (.enex) → notebook page holding a database of notes (tags as multi-select).
import type { Blk } from '../blocks';
import { base64ToBytes } from '../text';
import { basename, joinPath, type Vfs } from '../vfs';
import { PlanBuilder, pathHref } from './builder';
import { HtmlConverter, mergeRuns } from './htmlToBlocks';
import { parseHtml, type HtmlElement } from './html';
import { IMPORT_LIMITS, ImportError } from './limits';
import { md5Hex } from './md5';
import { child, childrenNamed, parseXml, textOf } from './xml';
import { mimeOf, fileBlockType } from '../importTypes';

const enDate = (s: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

export function isEnex(text: string): boolean {
  return /<en-export[\s>]/.test(text.slice(0, 4096));
}

export function planEnex(b: PlanBuilder, vfs: Vfs, xml: string, filePath: string, dir: string): void {
  const root = parseXml(xml);
  if (root.name !== 'en-export') throw new ImportError('Ce fichier n’est pas un export Evernote (.enex).');
  const stem = basename(filePath).replace(/\.enex$/i, '') || 'Evernote';
  const notes = childrenNamed(root, 'note');
  const page = b.page({ title: stem, icon: '📓' });
  const db = b.database({
    title: 'Notes',
    parent: page,
    headers: ['Titre', 'Étiquettes', 'Créée', 'Modifiée'],
    columnHints: { 1: { type: 'multi_select' }, 2: { type: 'date' }, 3: { type: 'date' } },
  });
  db.inline = true;
  let n = 0;
  for (const note of notes) {
    const title = textOf(child(note, 'title') ?? { name: 't', attrs: {}, children: [] }).trim() || 'Sans titre';
    const tags = childrenNamed(note, 'tag').map((t) => textOf(t).trim()).filter(Boolean);
    // Resources by md5.
    const byHash = new Map<string, { path: string; mime: string; name: string }>();
    const used = new Set<string>();
    let r = 0;
    for (const res of childrenNamed(note, 'resource')) {
      const data = child(res, 'data');
      if (!data) continue;
      const bytes = base64ToBytes(textOf(data).replace(/\s+/g, ''));
      if (bytes.length > IMPORT_LIMITS.maxTextPartBytes) continue;
      const attrs = child(res, 'resource-attributes');
      const mime = textOf(child(res, 'mime') ?? data).trim();
      const name = (attrs ? textOf(child(attrs, 'file-name') ?? data).trim() : '') || `piece-${n}-${++r}`;
      const path = joinPath(dir, `${stem}.pieces-jointes/${n}-${r}-${name.replace(/[\\/]/g, '_')}`);
      vfs.add({ path, size: bytes.length, read: async () => bytes });
      b.attach(path);
      byHash.set(md5Hex(bytes), { path, mime: mime || mimeOf(name), name });
    }
    const content = textOf(child(note, 'content') ?? { name: 'c', attrs: {}, children: [] });
    const htmlRoot = parseHtml(content);
    const conv = new HtmlConverter(htmlRoot, {
      resolveUrl: (u) => (/^(https?:|mailto:|tel:)/i.test(u) ? u : null),
      inline(el, _s, _items) {
        if (el.name === 'en-todo') return [{ type: '__todo', checked: el.attrs.checked === 'true' }];
        if (el.name === 'en-crypt') return [{ type: 'text', text: '[contenu chiffré non importé]', styles: { italic: true } }];
        if (el.name === 'en-media') {
          const hit = byHash.get((el.attrs.hash ?? '').toLowerCase());
          if (!hit) return [];
          used.add(hit.path);
          const type = fileBlockType(hit.mime);
          return [{ type: '__file', block: { type, props: { url: pathHref(hit.path), name: hit.name } } }];
        }
        return null;
      },
      warn: (m) => b.warnings.push(`« ${title} » : ${m}`),
    });
    const blocks: Blk[] = conv.convert(htmlRoot.children as Array<HtmlElement | string>);
    for (const [, v] of byHash) {
      if (!used.has(v.path)) blocks.push({ type: fileBlockType(v.mime), props: { url: pathHref(v.path), name: v.name } });
    }
    mergeRuns([]);
    b.row(db, { title, cells: [title, tags.join(', '), enDate(textOf(child(note, 'created') ?? { name: 'c', attrs: {}, children: [] })), enDate(textOf(child(note, 'updated') ?? { name: 'c', attrs: {}, children: [] }))], blocks: blocks.length ? blocks : undefined });
    n++;
  }
  if (notes.length === 0) b.warnings.push(`« ${stem} » ne contient aucune note.`);
}
