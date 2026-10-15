// Excel (.xlsx) → sheets of text cells. Formulas yield the value cached in the file. Dates are
// rendered as ISO text so that column type detection (csv.ts) treats them like any CSV import.
import { IMPORT_LIMITS, ImportError } from './limits';
import { openBoundedZip, type InflateBudget } from './safeZip';
import { child, childrenNamed, elements, parseXml, scanXml, textOf, type XmlElement } from './xml';

export interface Sheet {
  name: string;
  headers: string[];
  rows: string[][];
  notes: string[];
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
  const c = code.toLowerCase().replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/.test(c) && !/^(general|0|#)/.test(c.trim());
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function serialToText(serial: number, date1904: boolean): string {
  const ms = Math.round((serial - (date1904 ? 24107 : 25569)) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16);
}

const trimRow = (r: string[]) => {
  while (r.length && r[r.length - 1] === '') r.pop();
  return r;
};

export async function readWorkbook(input: Blob | Uint8Array, fileName: string, budget?: InflateBudget): Promise<{ sheets: Sheet[]; warnings: string[] }> {
  const zip = await openBoundedZip(input, fileName, budget);
  const warnings = [...zip.warnings];
  const wbXml = await zip.readText('xl/workbook.xml');
  if (!wbXml) throw new ImportError(`« ${fileName} » n’est pas un classeur Excel valide (xl/workbook.xml absent).`);
  const wb = parseXml(wbXml);
  const date1904 = child(wb, 'workbookPr')?.attrs.date1904 === '1';
  const sheetsEl = child(wb, 'sheets');
  const rels = new Map<string, string>();
  const relsXml = await zip.readText('xl/_rels/workbook.xml.rels');
  if (relsXml) for (const r of elements(parseXml(relsXml))) rels.set(r.attrs.Id ?? '', r.attrs.Target ?? '');

  // Shared strings
  const shared: string[] = [];
  const ssXml = await zip.readText('xl/sharedStrings.xml');
  if (ssXml) {
    for (const si of childrenNamed(parseXml(ssXml), 'si')) {
      let t = '';
      const walk = (e: XmlElement) => {
        for (const c of elements(e)) {
          if (c.name === 't') t += textOf(c);
          else if (c.name === 'r' || c.name === 'si') walk(c);
        }
      };
      walk(si);
      shared.push(t.slice(0, IMPORT_LIMITS.maxCellChars));
    }
  }

  // Styles → which cell formats are dates
  const dateXf = new Set<number>();
  const stXml = await zip.readText('xl/styles.xml');
  if (stXml) {
    const st = parseXml(stXml);
    const custom = new Map<number, string>();
    const numFmts = child(st, 'numFmts');
    if (numFmts) for (const f of childrenNamed(numFmts, 'numFmt')) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? '');
    const xfs = child(st, 'cellXfs');
    if (xfs) {
      childrenNamed(xfs, 'xf').forEach((xf, i) => {
        const id = Number(xf.attrs.numFmtId ?? 0);
        if (BUILTIN_DATE.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dateXf.add(i);
      });
    }
  }

  const sheets: Sheet[] = [];
  const list = sheetsEl ? childrenNamed(sheetsEl, 'sheet') : [];
  if (list.length > IMPORT_LIMITS.maxSheets) warnings.push(`Seules les ${IMPORT_LIMITS.maxSheets} premières feuilles sont lues.`);
  for (const s of list.slice(0, IMPORT_LIMITS.maxSheets)) {
    const name = s.attrs.name ?? `Feuille ${sheets.length + 1}`;
    if ((s.attrs.state ?? 'visible') !== 'visible') continue;
    const target = rels.get(s.attrs['r:id'] ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    if (!zip.has(path)) {
      warnings.push(`Feuille « ${name} » introuvable dans l’archive.`);
      continue;
    }
    const xml = await zip.readText(path);
    if (!xml) continue;
    const grid = new Map<number, string[]>();
    const notes: string[] = [];
    let formulasWithoutValue = 0;
    let errors = 0;
    let truncated = false;
    let cell: { col: number; t: string; s: number; v: string; inline: string; hasF: boolean; row: number } | null = null;
    let rowNo = -1;
    let inTag = '';
    let inInline = false;
    scanXml(xml, {
      open(tag, attrs) {
        if (tag === 'row') rowNo = attrs.r ? Number(attrs.r) - 1 : rowNo + 1;
        else if (tag === 'c') {
          cell = { col: attrs.r ? colIndex(attrs.r) : (cell?.col ?? -1) + 1, t: attrs.t ?? 'n', s: Number(attrs.s ?? 0), v: '', inline: '', hasF: false, row: rowNo };
        } else if (cell && tag === 'f') cell.hasF = true;
        else if (cell && tag === 'is') inInline = true;
        inTag = tag;
      },
      text(t) {
        if (!cell) return;
        if (inTag === 'v') cell.v += t;
        else if (inTag === 't' && inInline) cell.inline += t;
      },
      close(tag) {
        if (tag === 'is') inInline = false;
        if (tag !== 'c' || !cell) return;
        const c = cell;
        cell = null;
        if (c.row >= IMPORT_LIMITS.maxRowsPerSheet + 1 || c.col >= IMPORT_LIMITS.maxColumns) {
          truncated = true;
          return;
        }
        let out = '';
        if (c.t === 's') out = shared[Number(c.v)] ?? '';
        else if (c.t === 'inlineStr') out = c.inline;
        else if (c.t === 'str') out = c.v;
        else if (c.t === 'b') out = c.v === '1' ? 'true' : 'false';
        else if (c.t === 'e') {
          errors++;
          out = '';
        } else if (c.v !== '') {
          const n = Number(c.v);
          out = Number.isFinite(n) && dateXf.has(c.s) ? serialToText(n, date1904) : c.v;
        } else if (c.hasF) formulasWithoutValue++;
        if (out === '') return;
        let row = grid.get(c.row);
        if (!row) grid.set(c.row, (row = []));
        while (row.length < c.col) row.push('');
        row[c.col] = out.slice(0, IMPORT_LIMITS.maxCellChars);
      },
    });
    if (truncated) notes.push(`Feuille tronquée à ${IMPORT_LIMITS.maxRowsPerSheet} lignes et ${IMPORT_LIMITS.maxColumns} colonnes.`);
    if (formulasWithoutValue) notes.push(`${formulasWithoutValue} formule(s) sans valeur calculée dans le fichier : cellules vides.`);
    if (errors) notes.push(`${errors} cellule(s) en erreur laissées vides.`);
    const rowKeys = [...grid.keys()].sort((a, b) => a - b);
    const matrix = rowKeys.map((k) => trimRow([...(grid.get(k) ?? [])]).map((v) => v ?? '')).filter((r) => r.some((c) => c.trim() !== ''));
    if (matrix.length === 0) {
      warnings.push(`Feuille « ${name} » vide, ignorée.`);
      continue;
    }
    const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    const headers = Array.from({ length: width }, (_, i) => (matrix[0]![i] ?? '').trim() || `Colonne ${i + 1}`);
    const rows = matrix.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    sheets.push({ name, headers, rows, notes });
  }
  if (sheets.length === 0) throw new ImportError(`Aucune feuille exploitable dans « ${fileName} ».`);
  return { sheets, warnings };
}
