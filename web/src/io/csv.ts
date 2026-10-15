// CSV ⇄ database properties: parsing, column type inference and value conversion (import), and
// human-readable cell rendering (export). DOM-free, unit-tested under Node.
import Papa from 'papaparse';
import {
  COLORS,
  COMPUTED_PROPERTY_TYPES,
  shortId,
  type Color,
  type DateValue,
  type NumberFormat,
  type PropertyDef,
  type PropertyType,
  type PropertyValue,
  type SelectOption,
  type StatusGroup,
} from '@oriel/shared';
import { looseKey } from './text';
import { SPREADSHEET_FORMULA, unescapeSpreadsheetCell } from '../lib/spreadsheet';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Rows of a CSV file (first row = headers). Separator auto-detected (`,` `;` tab). */
export function parseCsv(text: string): string[][] {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
  const rows = (result.data ?? []).filter((r) => Array.isArray(r));
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => {
    const out = r.map((c) => unescapeSpreadsheetCell(typeof c === 'string' ? c : String(c ?? '')));
    while (out.length < width) out.push('');
    return out;
  });
}

export function toCsv(rows: string[][]): string {
  // Formula-like cells (=, +, -, @…) are prefixed with ' so that spreadsheets show them as text.
  return '﻿' + Papa.unparse(rows, { newline: '\r\n', escapeFormulae: SPREADSHEET_FORMULA });
}

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['yes', 'oui', 'true', 'vrai', '✓', '✔', '✅', '☑', '☑️', '[x]']);
const FALSE_WORDS = new Set(['no', 'non', 'false', 'faux', '☐', '❌', '[ ]']);

export function parseBool(raw: string): boolean | null {
  const k = looseKey(raw);
  if (TRUE_WORDS.has(k)) return true;
  if (FALSE_WORDS.has(k) || k === '') return false;
  return null;
}

const MONTHS: Record<string, number> = {};
(
  [
    [1, 'january jan janvier janv'],
    [2, 'february feb fevrier fevr fev'],
    [3, 'march mar mars'],
    [4, 'april apr avril avr'],
    [5, 'may mai'],
    [6, 'june jun juin'],
    [7, 'july jul juillet juil'],
    [8, 'august aug aout'],
    [9, 'september sep sept septembre'],
    [10, 'october oct octobre'],
    [11, 'november nov novembre'],
    [12, 'december dec decembre'],
  ] as const
).forEach(([n, names]) => names.split(' ').forEach((name) => (MONTHS[name] = n)));

const monthOf = (word: string): number | undefined => MONTHS[looseKey(word).replace(/\.$/, '')];
const WEEKDAY = /^(?:mon|tue|wed|thu|fri|sat|sun|lun|mar|mer|jeu|ven|sam|dim)[a-z]*\.?,?\s+/i;
const pad = (n: number) => String(n).padStart(2, '0');

interface DatePart {
  date: string;
  time: string | null;
}

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseTime(s: string | undefined): string | null | undefined {
  if (!s) return null;
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(s.trim());
  if (!m || (!m[2] && !m[4] && !/h/i.test(s))) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[4]?.toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${pad(h)}:${pad(min)}`;
}

const year2 = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function parseSingleDate(input: string, dayFirst: boolean): DatePart | null {
  const s = input.trim().replace(WEEKDAY, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    const time = parseTime(m[4]);
    return date && time !== undefined ? { date, time } : null;
  }
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:,?\s+(.+))?$/.exec(s);
  if (m) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    const time = parseTime(m[4]);
    return date && time !== undefined ? { date, time } : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:,?\s+(?:à\s+|at\s+)?(.+))?$/i.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [d, mo] = dayFirst ? [a, b] : [b, a];
    const date = validDate(year2(m[3]!), mo, d);
    const time = parseTime(m[4]);
    return date && time !== undefined ? { date, time } : null;
  }
  // "October 13, 2026", "Oct 13, 2026 3:04 PM"
  m = /^([\p{L}.]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+|à\s+)?(.+))?$/iu.exec(s);
  if (m && monthOf(m[1]!)) {
    const date = validDate(Number(m[3]), monthOf(m[1]!)!, Number(m[2]));
    const time = parseTime(m[4]);
    return date && time !== undefined ? { date, time } : null;
  }
  // "13 octobre 2026", "1er mars 2026 à 14h30", "13 Oct 2026"
  m = /^(\d{1,2})(?:er)?\s+([\p{L}.]+)\s+(\d{4})(?:,?\s+(?:à\s+|at\s+)?(.+))?$/iu.exec(s);
  if (m && monthOf(m[2]!)) {
    const date = validDate(Number(m[3]), monthOf(m[2]!)!, Number(m[1]));
    const time = parseTime(m[4]);
    return date && time !== undefined ? { date, time } : null;
  }
  return null;
}

/** Parses a date or a date range ("A → B"); `dayFirst` decides ambiguous 03/04/2026. */
export function parseDateText(raw: string, dayFirst = true): DateValue | null {
  const s = raw
    .trim()
    .replace(/^@/, '')
    .replace(/\s*\((?:GMT|UTC)[^)]*\)\s*$/i, '')
    .trim();
  if (!s) return null;
  const parts = s.split(/\s*(?:→|->|⟶|–|—)\s*|\s+-\s+/);
  if (parts.length === 2) {
    const a = parseSingleDate(parts[0]!.replace(/^@/, ''), dayFirst);
    const b = parseSingleDate(parts[1]!.replace(/^@/, ''), dayFirst);
    if (a && b) {
      const includeTime = !!(a.time || b.time);
      const fmt = (p: DatePart) => (includeTime ? `${p.date}T${p.time ?? '00:00'}` : p.date);
      return includeTime ? { start: fmt(a), end: fmt(b), includeTime } : { start: fmt(a), end: fmt(b) };
    }
    return null;
  }
  if (parts.length > 2) return null;
  const one = parseSingleDate(s, dayFirst);
  if (!one) return null;
  return one.time ? { start: `${one.date}T${one.time}`, includeTime: true } : { start: one.date };
}

export interface ParsedNumber {
  value: number;
  percent: boolean;
  currency: 'euro' | 'dollar' | null;
  grouped: boolean;
}

/** Decimal separator suggested by a column's values. */
export function detectDecimal(values: string[]): ',' | '.' {
  let comma = 0;
  let dot = 0;
  for (const raw of values) {
    const v = raw.replace(/[^\d.,]/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(v) || /\d,(\d{1,2}|\d{4,})$/.test(v)) comma++;
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v) || /\d\.(\d{1,2}|\d{4,})$/.test(v)) dot++;
  }
  return comma > dot ? ',' : '.';
}

export function parseNumberText(raw: string, decimal: ',' | '.' = '.'): ParsedNumber | null {
  let s = raw.trim();
  if (!s) return null;
  const percent = /%$|^%/.test(s);
  const currency = /€|\bEUR\b/i.test(s) ? 'euro' : /\$|\bUSD\b/i.test(s) ? 'dollar' : null;
  s = s.replace(/%|€|\$|£|\b(EUR|USD|GBP)\b/gi, '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (/^[-−]/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  if (!/^\d/.test(s) || !/^[\d.,\s  ']+$/.test(s)) return null;
  // Leading zeros (phone numbers, codes) are not numbers.
  if (/^0\d/.test(s) && !s.startsWith(`0${decimal}`)) return null;
  const di = s.lastIndexOf(decimal);
  let intPart = di >= 0 ? s.slice(0, di) : s;
  const frac = di >= 0 ? s.slice(di + 1) : '';
  if (di >= 0 && !/^\d+$/.test(frac)) return null;
  let grouped = false;
  if (/\D/.test(intPart)) {
    const sep = /[^\d]/.exec(intPart)![0];
    if (sep === decimal) return null;
    const groups = intPart.split(sep);
    if (!/^\d{1,3}$/.test(groups[0]!) || !groups.slice(1).every((g) => /^\d{3}$/.test(g))) return null;
    intPart = groups.join('');
    grouped = true;
  }
  const value = Number(`${intPart}${frac ? `.${frac}` : ''}`) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { value, percent, currency, grouped };
}

const URL_RE = /^(https?:\/\/|www\.)[^\s]+$/i;
// Domain labels cannot contain dots: no ambiguous split, linear on crafted cells (QA-WEB-06).
const EMAIL_RE = /^[^\s@,;]+@(?:[^\s@,;.]+\.)+[^\s@,;.]{2,}$/;
const PHONE_RE = /^\+?[\d][\d\s().-]{5,}\d$/;
const isPhone = (s: string) => {
  const digits = s.replace(/\D/g, '').length;
  return PHONE_RE.test(s) && digits >= 8 && digits <= 15 && (/[\s.()+-]/.test(s) || /^0\d{9}$/.test(s));
};

/** "Titre (Dossier/Titre%20abc.md)" → "Titre" (relation / page reference cells). */
export function stripPageRefs(raw: string): string {
  return raw
    .replace(/\s*\((?:[^()]*\/)?[^()]*\.(?:md|csv)\)/gi, '')
    .replace(/\s*\(https?:\/\/www\.notion\.so\/[^)]*\)/gi, '')
    .trim();
}

export function splitList(raw: string): string[] {
  return raw
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Column inference
// ---------------------------------------------------------------------------

export interface MemberRef {
  id: string;
  name: string;
  email: string;
}

export interface ColumnSpec {
  index: number;
  name: string;
  type: PropertyType;
  options?: SelectOption[];
  numberFormat?: NumberFormat;
  dayFirst?: boolean;
  decimal?: ',' | '.';
  /** Definition carried over from a Oriel export manifest. */
  def?: PropertyDef;
  /** Why the column type differs from the source (shown in the report). */
  note?: string;
}

export interface InferContext {
  members?: MemberRef[];
  /** True when the cell item names a file present in the archive (files columns). */
  fileExists?: (item: string) => boolean;
}

const SELECT_HINT = /(type|cat[ée]gor|statut|status|[ée]tat|priorit|niveau|level|phase|[ée]tape|stage|genre|kind|classe|class|groupe|group|p[ôo]le|[ée]quipe|team|client|projet|project|tags?|[ée]tiquettes?|labels?|sources?|format|cible|canal|channel|langue|language|pays|country|ville|city|r[ôo]le|d[ée]partement|service|cat\.)/i;
const MULTI_HINT = /(tags?|[ée]tiquettes?|labels?|mots?[- ]cl[ée]s|keywords|th[èe]mes?|topics?|comp[ée]tences|skills)/i;
const STATUS_NAME = /^(status|statut|[ée]tat|state|avancement)$/i;
const MAX_OPTIONS = 30;

function colorAt(i: number): Color {
  const palette = COLORS.filter((c) => c !== 'default');
  return palette[i % palette.length]!;
}

function statusGroup(name: string): StatusGroup {
  const k = looseKey(name);
  if (/(pas commenc|not started|a faire|todo|to do|backlog|nouveau|new|idee|idea)/.test(k)) return 'todo';
  if (/(done|termin|fini|complet|livr|valid|clos|ferm|archiv|publi|ok$|fait)/.test(k)) return 'done';
  if (/(progress|cours|doing|review|relecture|attente|bloqu|wip|actif|active|started|commenc)/.test(k)) return 'in_progress';
  return 'todo';
}

export function makeOptions(names: string[], status = false): SelectOption[] {
  return names.map((name, i) => {
    const opt: SelectOption = { id: shortId(6), name: name.slice(0, 200), color: colorAt(i) };
    if (status) opt.group = statusGroup(name);
    return opt;
  });
}

function distinct(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const k = looseKey(v);
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()];
}

export function matchMember(item: string, members: MemberRef[]): MemberRef | undefined {
  const k = looseKey(item.replace(/^@/, ''));
  if (!k) return undefined;
  return members.find((m) => looseKey(m.name) === k || looseKey(m.email) === k);
}

/** Infers the property type of a CSV column from its name and values. */
export function inferColumn(index: number, name: string, cells: string[], ctx: InferContext = {}): ColumnSpec {
  const values = cells.map((c) => c.trim()).filter((c) => c !== '');
  const spec: ColumnSpec = { index, name: name.trim() || `Colonne ${index + 1}`, type: 'text' };
  if (values.length === 0) return spec;

  if (values.every((v) => parseBool(v) !== null) && values.some((v) => looseKey(v) !== '')) {
    return { ...spec, type: 'checkbox' };
  }

  // Dates (FR/EN formats, ranges). Ambiguous numeric dates decided column-wide.
  const numeric = values.map((v) => /^@?(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(v)).filter(Boolean) as RegExpExecArray[];
  let dayFirst = true;
  if (numeric.some((m) => Number(m[2]) > 12)) dayFirst = false;
  if (numeric.some((m) => Number(m[1]) > 12)) dayFirst = true;
  if (values.every((v) => parseDateText(v, dayFirst) !== null)) return { ...spec, type: 'date', dayFirst };

  const decimal = detectDecimal(values);
  const numbers = values.map((v) => parseNumberText(v, decimal));
  if (numbers.every((n) => n !== null)) {
    const ns = numbers as ParsedNumber[];
    let numberFormat: NumberFormat = 'number';
    if (ns.some((n) => n.percent)) numberFormat = 'percent';
    else if (ns.some((n) => n.currency === 'euro')) numberFormat = 'euro';
    else if (ns.some((n) => n.currency === 'dollar')) numberFormat = 'dollar';
    else if (ns.some((n) => n.grouped)) numberFormat = 'number_with_commas';
    return { ...spec, type: 'number', numberFormat, decimal };
  }

  if (values.every((v) => URL_RE.test(v))) return { ...spec, type: 'url' };
  if (values.every((v) => EMAIL_RE.test(v))) return { ...spec, type: 'email' };
  if (values.every(isPhone)) return { ...spec, type: 'phone' };

  // Relations (links to other pages of the export) are kept as text.
  if (values.some((v) => /\.md\)/i.test(v) || /notion\.so\//i.test(v))) {
    return { ...spec, type: 'text', note: 'relation importée comme texte' };
  }

  const items = values.flatMap(splitList);
  if (ctx.fileExists && items.length > 0 && items.every((i) => ctx.fileExists!(i))) return { ...spec, type: 'files' };

  if (ctx.members && ctx.members.length > 0 && items.length > 0 && items.every((i) => matchMember(i, ctx.members!))) {
    return { ...spec, type: 'person' };
  }

  const tooLong = values.some((v) => v.length > 120 || v.includes('\n'));
  if (tooLong) return spec;

  const hasCommas = values.some((v) => splitList(v).length > 1);
  const itemDistinct = distinct(items);
  const valueDistinct = distinct(values);
  const shortItems = items.every((i) => i.length <= 60);

  if (STATUS_NAME.test(spec.name) && !hasCommas && valueDistinct.length <= 12) {
    return { ...spec, type: 'status', options: makeOptions(valueDistinct, true) };
  }
  if (hasCommas && shortItems && itemDistinct.length <= MAX_OPTIONS && (itemDistinct.length < items.length || MULTI_HINT.test(spec.name))) {
    return { ...spec, type: 'multi_select', options: makeOptions(itemDistinct) };
  }
  if (!hasCommas && MULTI_HINT.test(spec.name) && shortItems && itemDistinct.length <= MAX_OPTIONS) {
    return { ...spec, type: 'multi_select', options: makeOptions(itemDistinct) };
  }
  if (
    !hasCommas &&
    values.every((v) => v.length <= 60) &&
    valueDistinct.length <= MAX_OPTIONS &&
    (valueDistinct.length < values.length || SELECT_HINT.test(spec.name))
  ) {
    return { ...spec, type: 'select', options: makeOptions(valueDistinct) };
  }
  return spec;
}

/** Column choices made by a file importer or by the user in the import preview. */
export interface ColumnHint {
  /** Forced property type (options, number format and date order are derived from the values). */
  type?: PropertyType;
  /** Column name replacing the header. */
  name?: string;
  /** Column left out of the import. */
  skip?: boolean;
}

/** Property types the preview lets the user choose for a column. */
export const HINTABLE_TYPES = ['text', 'number', 'date', 'checkbox', 'select', 'multi_select', 'status', 'url', 'email', 'phone', 'person'] as const;

/** Applies a hint to the inferred spec. `person` degrades to text when a name is not a known member. */
export function applyColumnHint(spec: ColumnSpec, hint: ColumnHint | undefined, cells: string[], members: MemberRef[] = []): ColumnSpec {
  if (!hint) return spec;
  const out: ColumnSpec = { ...spec };
  if (hint.name?.trim()) out.name = hint.name.trim().slice(0, 200);
  const type = hint.type;
  if (!type || type === spec.type) return out;
  const values = cells.map((c) => c.trim()).filter((c) => c !== '');
  switch (type) {
    case 'select':
    case 'status': {
      delete out.options;
      out.type = type;
      out.options = makeOptions(distinct(values).slice(0, MAX_OPTIONS * 4), type === 'status');
      break;
    }
    case 'multi_select': {
      out.type = type;
      out.options = makeOptions(distinct(values.flatMap(splitList)).slice(0, MAX_OPTIONS * 4));
      break;
    }
    case 'date': {
      out.type = type;
      const numeric = values.map((v) => /^@?(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(v)).filter(Boolean) as RegExpExecArray[];
      out.dayFirst = !numeric.some((m) => Number(m[2]) > 12) || numeric.some((m) => Number(m[1]) > 12);
      break;
    }
    case 'number': {
      out.type = type;
      out.decimal = detectDecimal(values);
      out.numberFormat = spec.numberFormat ?? 'number';
      delete out.options;
      break;
    }
    case 'person': {
      const items = values.flatMap(splitList);
      if (items.every((i) => matchMember(i, members))) out.type = 'person';
      else {
        out.type = 'text';
        out.note = 'personnes inconnues conservées en texte';
      }
      delete out.options;
      break;
    }
    default:
      out.type = type;
      delete out.options;
  }
  return out;
}

/** Column spec from a Oriel manifest definition (exact types and options). */
export function columnFromDef(index: number, def: PropertyDef): ColumnSpec {
  if (def.type === 'relation') return { index, name: def.name, type: 'text', note: 'relation importée comme texte' };
  return { index, name: def.name, type: def.type, options: def.options, numberFormat: def.numberFormat, def, dayFirst: false };
}

/** Property definition to create for a column (without id unless carried over). */
export function propertyForColumn(col: ColumnSpec): Omit<PropertyDef, 'id'> & { id?: string } {
  if (col.def) {
    const { id, ...rest } = col.def;
    return { ...rest, id };
  }
  const out: Omit<PropertyDef, 'id'> = { name: col.name, type: col.type };
  if (col.options) out.options = col.options;
  if (col.type === 'number') out.numberFormat = col.numberFormat ?? 'number';
  return out;
}

const isComputed = (t: PropertyType) => COMPUTED_PROPERTY_TYPES.includes(t);

/**
 * Stored value for a cell (`undefined` = leave empty). Not for 'files' and 'title' columns, which
 * the importer handles itself. `options` are the created options of the column.
 */
export function cellToValue(col: ColumnSpec, raw: string, options: SelectOption[] | undefined, members: MemberRef[] = []): PropertyValue | undefined {
  const v = raw.trim();
  if (isComputed(col.type)) return undefined;
  switch (col.type) {
    case 'checkbox': {
      const b = parseBool(v);
      return b === null ? undefined : b;
    }
    case 'date':
      return v ? (parseDateText(v, col.dayFirst ?? true) ?? undefined) : undefined;
    case 'number': {
      if (!v) return undefined;
      const n = parseNumberText(v, col.decimal ?? detectDecimal([v]));
      return n ? n.value : undefined;
    }
    case 'select':
    case 'status': {
      if (!v) return undefined;
      const k = looseKey(v);
      return options?.find((o) => looseKey(o.name) === k)?.id;
    }
    case 'multi_select': {
      const ids = splitList(v)
        .map((item) => options?.find((o) => looseKey(o.name) === looseKey(item))?.id)
        .filter((id): id is string => !!id);
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case 'person': {
      const ids = splitList(v)
        .map((item) => matchMember(item, members)?.id)
        .filter((id): id is string => !!id);
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case 'url':
    case 'email':
    case 'phone':
      return v ? v.slice(0, col.type === 'url' ? 2000 : col.type === 'email' ? 320 : 100) : undefined;
    case 'text':
      return v ? (col.note ? stripPageRefs(v) : v).slice(0, 100_000) : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Export: human-readable cells
// ---------------------------------------------------------------------------

export interface CellContext {
  userName: (id: string) => string | undefined;
  relationTitle: (id: string) => string | undefined;
  fileHref: (url: string) => string;
  row: { title: string; createdAt: number; updatedAt: number; createdBy: string; updatedBy: string };
}

function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDatePart(s: string, includeTime: boolean | undefined): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (local) return includeTime === false ? local[1]! : `${local[1]} ${local[2]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return includeTime === false ? localDateTime(d).slice(0, 10) : localDateTime(d);
}

export function formatDateCell(v: DateValue | null | undefined): string {
  if (!v || typeof v !== 'object' || !v.start) return '';
  const start = formatDatePart(v.start, v.includeTime);
  return v.end ? `${start} → ${formatDatePart(v.end, v.includeTime)}` : start;
}

function numberCell(n: number, fmt: NumberFormat | undefined): string {
  const s = String(n);
  if (fmt === 'percent') return `${s}%`;
  if (fmt === 'euro') return `${s} €`;
  if (fmt === 'dollar') return `$${s}`;
  return s;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

export function formatCell(def: PropertyDef, value: PropertyValue | undefined, ctx: CellContext): string {
  const optionName = (id: string) => def.options?.find((o) => o.id === id)?.name ?? '';
  switch (def.type) {
    case 'title':
      return ctx.row.title;
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof value === 'string' ? value : '';
    case 'number':
      return typeof value === 'number' ? numberCell(value, def.numberFormat) : '';
    case 'checkbox':
      return value === true ? 'Oui' : 'Non';
    case 'select':
    case 'status':
      return typeof value === 'string' ? optionName(value) : '';
    case 'multi_select':
      return list(value).map(optionName).filter(Boolean).join(', ');
    case 'person':
      return list(value)
        .map((id) => ctx.userName(id) ?? '')
        .filter(Boolean)
        .join(', ');
    case 'relation':
      return list(value)
        .map((id) => ctx.relationTitle(id) ?? '')
        .filter(Boolean)
        .join(', ');
    case 'date':
      return formatDateCell(value as DateValue | null);
    case 'files':
      return Array.isArray(value)
        ? (value as Array<{ name?: string; url?: string }>)
            .map((f) => (f && typeof f.url === 'string' ? ctx.fileHref(f.url) : ''))
            .filter(Boolean)
            .join(', ')
        : '';
    case 'created_time':
      return localDateTime(new Date(ctx.row.createdAt));
    case 'last_edited_time':
      return localDateTime(new Date(ctx.row.updatedAt));
    case 'created_by':
      return ctx.userName(ctx.row.createdBy) ?? '';
    case 'last_edited_by':
      return ctx.userName(ctx.row.updatedBy) ?? '';
    case 'unique_id':
      return typeof value === 'number' ? (def.uniqueIdPrefix ? `${def.uniqueIdPrefix}-${value}` : String(value)) : '';
    case 'formula':
    default:
      return '';
  }
}
