// Entry point of the file importers: recognizes Word, Excel, Confluence, Evernote, Trello, Asana and
// Google Docs exports among the files dropped, and returns the plan they would create. Files that
// are not recognized are left to the Markdown / CSV planner (plan.ts).
import { decodeText } from '../text';
import { extname, joinPath, dirname, Vfs, type VfsFile } from '../vfs';
import type { ImporterFormat, ImportPlan } from '../plan';
import { mergePlans, PlanBuilder } from './builder';
import { looksLikeConfluence, looksLikeGoogleDocs, planConfluence, planHtmlDocument } from './confluence';
import { docxToBlocks } from './docx';
import { isEnex, planEnex } from './enex';
import { IMPORT_LIMITS, ImportError } from './limits';
import { InflateBudget } from './safeZip';
import { isAsanaCsv, isTrelloExport, planAsana, planTrello } from './tasks';
import { readWorkbook, type Sheet } from './xlsx';
import { parseCsv } from '../csv';

export interface Detected {
  plan: ImportPlan | null;
  /** Files consumed by an importer (the Markdown / CSV planner must not see them). */
  handled: Set<string>;
  formats: ImporterFormat[];
}

const stem = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

function sheetToDatabase(b: PlanBuilder, sheet: Sheet, title: string): void {
  const numeric = (i: number) => {
    const vals = sheet.rows.map((r) => (r[i] ?? '').trim()).filter(Boolean);
    return vals.length > 0 && vals.every((v) => /^-?[\d\s.,]+$/.test(v));
  };
  const textual = sheet.headers.findIndex((_, i) => !numeric(i) && sheet.rows.some((r) => (r[i] ?? '').trim()));
  const titleIndex = textual >= 0 ? textual : 0;
  const db = b.database({ title, headers: sheet.headers, titleIndex, notes: sheet.notes });
  for (const cells of sheet.rows) b.row(db, { title: (cells[titleIndex] ?? '').trim(), cells });
}

export async function detectImporters(vfs: Vfs, onlyNames?: (f: VfsFile) => boolean): Promise<Detected> {
  const budget = new InflateBudget();
  const plans: ImportPlan[] = [];
  const formats: ImporterFormat[] = [];
  const handled = new Set<string>();
  const errors: string[] = [];
  const files = vfs.list().filter((f) => (onlyNames ? onlyNames(f) : true));
  const tooBig = (f: VfsFile) => f.size > IMPORT_LIMITS.maxInputBytes;

  // Confluence first: it owns every HTML page of the export.
  const htmlFiles = files.filter((f) => ['html', 'htm'].includes(extname(f.path)) && f.size <= IMPORT_LIMITS.maxTextPartBytes);
  const confluenceHits: VfsFile[] = [];
  for (const f of htmlFiles.slice(0, 50)) {
    const head = decodeText((await f.read()).subarray(0, 20000));
    if (looksLikeConfluence(head)) confluenceHits.push(f);
  }
  if (confluenceHits.length > 0) {
    const b = new PlanBuilder();
    try {
      if (await planConfluence(b, vfs)) {
        plans.push(b.build('confluence', vfs.warnings));
        formats.push('confluence');
        for (const f of htmlFiles) handled.add(f.path);
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  for (const f of files) {
    if (handled.has(f.path)) continue;
    const ext = extname(f.path);
    const b = new PlanBuilder();
    try {
      if (['docx', 'xlsx', 'enex', 'json', 'html', 'htm'].includes(ext) && tooBig(f)) {
        errors.push(`« ${f.path} » est trop volumineux (plus de ${IMPORT_LIMITS.maxInputBytes / 1024 / 1024} Mo).`);
        handled.add(f.path);
        continue;
      }
      if (ext === 'docx') {
        handled.add(f.path);
        const media = joinPath(dirname(f.path), `${stem(f.path)}.medias`);
        const r = await docxToBlocks(await f.read(), f.path, vfs, media, budget);
        b.page({ title: r.title, blocks: r.blocks });
        b.counts.attachments += r.images;
        const note = /google/i.test(f.path) ? [] : [];
        plans.push(b.build('docx', [...r.warnings, ...note]));
        formats.push('docx');
      } else if (ext === 'xlsx') {
        handled.add(f.path);
        const wb = await readWorkbook(await f.read(), f.path, budget);
        wb.sheets.forEach((s) => sheetToDatabase(b, s, wb.sheets.length > 1 ? `${stem(f.path)} – ${s.name}` : s.name || stem(f.path)));
        plans.push(b.build('xlsx', wb.warnings));
        formats.push('xlsx');
      } else if (ext === 'enex') {
        handled.add(f.path);
        const text = decodeText(await f.read());
        if (!isEnex(text)) throw new ImportError(`« ${f.path} » n’est pas un export Evernote.`);
        planEnex(b, vfs, text, f.path, dirname(f.path));
        plans.push(b.build('evernote'));
        formats.push('evernote');
      } else if (ext === 'json') {
        const text = decodeText(await f.read());
        if (!/"lists"\s*:/.test(text.slice(0, 2_000_000)) || !/"cards"\s*:/.test(text)) continue;
        const json: unknown = JSON.parse(text);
        if (!isTrelloExport(json)) continue;
        handled.add(f.path);
        planTrello(b, json, stem(f.path));
        plans.push(b.build('trello'));
        formats.push('trello');
      } else if (ext === 'csv') {
        const text = decodeText(await f.read());
        const first = parseCsv(text.slice(0, 20000))[0] ?? [];
        if (!isAsanaCsv(first)) continue;
        handled.add(f.path);
        planAsana(b, text, stem(f.path));
        plans.push(b.build('asana'));
        formats.push('asana');
      } else if (ext === 'html' || ext === 'htm') {
        const html = decodeText(await f.read());
        handled.add(f.path);
        planHtmlDocument(b, vfs, f.path, html);
        plans.push(b.build(looksLikeGoogleDocs(html) ? 'gdocs-html' : 'gdocs-html'));
        formats.push('gdocs-html');
      }
    } catch (e) {
      handled.add(f.path);
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (plans.length === 0) {
    if (errors.length) throw new ImportError(errors[0]!);
    return { plan: null, handled, formats };
  }
  const merged = mergePlans(plans);
  merged.warnings.push(...errors.map((e) => `Fichier ignoré : ${e}`));
  return { plan: merged, handled, formats };
}

/** Merges the plan of the file importers with the Markdown / CSV plan of the remaining files. */
export function combinePlans(special: ImportPlan | null, legacy: ImportPlan | null): ImportPlan {
  // The Markdown / CSV part (Notion exports) has never had a page limit: only the file importers' part is capped.
  if (special && legacy && legacy.roots.length > 0) return mergePlans([special, legacy], Infinity);
  const one = special ?? legacy;
  if (!one) throw new ImportError('Aucun fichier exploitable.');
  return one;
}
