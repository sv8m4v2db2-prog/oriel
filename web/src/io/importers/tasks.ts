// Task-board importers: Trello (JSON export of a board) and Asana (CSV export of a project).
import type { Blk } from '../blocks';
import { parseCsv } from '../csv';
import { PlanBuilder } from './builder';
import { IMPORT_LIMITS, ImportError } from './limits';

const T = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'text' as const, text, styles });

/** Plain text → paragraph blocks (one per non-empty line; "- " lines become bullets). */
export function textBlocks(text: string): Blk[] {
  const out: Blk[] = [];
  for (const raw of text.slice(0, IMPORT_LIMITS.maxCellChars).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = /^\s*[-*•]\s+(.*)$/.exec(line);
    out.push(m ? { type: 'bulletListItem', content: [T(m[1]!)], children: [] } : { type: 'paragraph', content: [T(line)], children: [] });
  }
  return out;
}

const day = (iso: unknown): string => (typeof iso === 'string' ? iso.slice(0, 10) : '');
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const arr = <X = Record<string, unknown>>(v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : []);

export function isTrelloExport(json: unknown): boolean {
  const o = json as { lists?: unknown; cards?: unknown } | null;
  return !!o && typeof o === 'object' && Array.isArray(o.lists) && Array.isArray(o.cards);
}

export function planTrello(b: PlanBuilder, json: unknown, fallbackName: string): void {
  if (!isTrelloExport(json)) throw new ImportError('Ce fichier n’est pas un export de tableau Trello (listes et cartes absentes).');
  const o = json as Record<string, unknown>;
  const lists = arr(o.lists).filter((l) => !l.closed);
  const listName = new Map(lists.map((l) => [str(l.id), str(l.name, 200)]));
  const members = new Map(arr(o.members).map((m) => [str(m.id), str(m.fullName, 200) || str(m.username, 200)]));
  const checklists = new Map<string, Array<Record<string, unknown>>>();
  for (const c of arr(o.checklists)) {
    const k = str(c.idCard);
    checklists.set(k, [...(checklists.get(k) ?? []), c]);
  }
  const cards = arr(o.cards).filter((c) => !c.closed && listName.has(str(c.idList)));
  const archived = arr(o.cards).length - cards.length;
  const db = b.database({
    title: str(o.name, 200) || fallbackName,
    headers: ['Nom', 'Statut', 'Étiquettes', 'Échéance', 'Membres'],
    columnHints: { 1: { type: 'status' }, 2: { type: 'multi_select' }, 3: { type: 'date' }, 4: { type: 'person' } },
  });
  const listOrder = new Map(lists.map((l, i) => [str(l.id), Number(l.pos ?? i)]));
  cards.sort((a, c) => (listOrder.get(str(a.idList)) ?? 0) - (listOrder.get(str(c.idList)) ?? 0) || Number(a.pos ?? 0) - Number(c.pos ?? 0));
  for (const card of cards) {
    const labels = arr(card.labels).map((l) => str(l.name, 100) || str(l.color, 40)).filter(Boolean);
    const who = arr<string>(card.idMembers).map((id) => members.get(id) ?? '').filter(Boolean);
    const blocks: Blk[] = [];
    const desc = str(card.desc, IMPORT_LIMITS.maxCellChars);
    if (desc) blocks.push(...textBlocks(desc));
    for (const cl of (checklists.get(str(card.id)) ?? []).sort((a, c) => Number(a.pos ?? 0) - Number(c.pos ?? 0))) {
      blocks.push({ type: 'heading', props: { level: 3 }, content: [T(str(cl.name, 200) || 'Checklist')], children: [] });
      for (const it of arr(cl.checkItems).sort((a, c) => Number(a.pos ?? 0) - Number(c.pos ?? 0))) {
        blocks.push({ type: 'checkListItem', props: { checked: it.state === 'complete' }, content: [T(str(it.name, 2000))], children: [] });
      }
    }
    for (const att of arr(card.attachments)) {
      const url = str(att.url, 2000);
      if (/^https?:\/\//i.test(url)) blocks.push({ type: 'paragraph', content: [{ type: 'link', href: url, content: [T(str(att.name, 200) || url)] }], children: [] });
    }
    b.row(db, { title: str(card.name, 2000), cells: [str(card.name, 2000), listName.get(str(card.idList)) ?? '', labels.join(', '), day(card.due), who.join(', ')], blocks: blocks.length ? blocks : undefined });
  }
  if (archived > 0) b.warnings.push(`${archived} carte(s) archivée(s) ou de listes archivées ignorée(s).`);
  b.warnings.push('Les pièces jointes Trello sont conservées comme liens : aucun fichier distant n’est téléchargé.');
}

// --- Asana ---------------------------------------------------------------------------------

const ASANA_COLS = ['name', 'section/column', 'assignee', 'due date', 'tags', 'notes'];
export function isAsanaCsv(headers: string[]): boolean {
  const h = headers.map((x) => x.trim().toLowerCase());
  return h.includes('task id') && h.includes('name') && ASANA_COLS.filter((c) => h.includes(c)).length >= 3;
}

export function planAsana(b: PlanBuilder, csv: string, fallbackName: string): void {
  const table = parseCsv(csv);
  const head = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  if (!isAsanaCsv(table[0] ?? [])) throw new ImportError('Ce CSV n’est pas un export de projet Asana.');
  const col = (name: string) => head.indexOf(name);
  const get = (r: string[], name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
  const rows = table.slice(1).filter((r) => get(r, 'name'));
  if (rows.length > IMPORT_LIMITS.maxRowsPerSheet) b.warnings.push(`Export tronqué à ${IMPORT_LIMITS.maxRowsPerSheet} tâches.`);
  const projects = new Set(rows.map((r) => get(r, 'projects')).filter(Boolean));
  const db = b.database({
    title: projects.size === 1 ? [...projects][0]!.slice(0, 200) : fallbackName,
    headers: ['Nom', 'Section', 'Assigné à', 'Terminée', 'Début', 'Échéance', 'Étiquettes', 'Tâche parente'],
    columnHints: { 1: { type: 'select' }, 2: { type: 'person' }, 3: { type: 'checkbox' }, 4: { type: 'date' }, 5: { type: 'date' }, 6: { type: 'multi_select' }, 7: { type: 'text' } },
  });
  for (const r of rows.slice(0, IMPORT_LIMITS.maxRowsPerSheet)) {
    const notes = get(r, 'notes');
    b.row(db, {
      title: get(r, 'name'),
      cells: [get(r, 'name'), get(r, 'section/column'), get(r, 'assignee'), get(r, 'completed at') ? 'true' : 'false', get(r, 'start date'), get(r, 'due date'), get(r, 'tags'), get(r, 'parent task')],
      blocks: notes ? textBlocks(notes) : undefined,
    });
  }
  b.warnings.push('Les assignés inconnus de l’espace restent en texte ; les sous-tâches sont reliées par une colonne « Tâche parente » (texte).');
}
