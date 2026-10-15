// CSV export (current view or whole database) and import (parsing, type inference, value
// conversion) of the database module. Pure functions: no React, no DOM.
import Papa from 'papaparse';
import type { DateValue, FileValue, NumberFormat, Page, PropertyDef, PropertyType, PropertyValue, PublicUser, SelectOption } from '@oriel/shared';
import { formatNumber } from './format';
import { dateValueToRange } from './dates';
import { normalizeText } from './text';
import {
  asFiles,
  asNumber,
  findOption,
  getDateRange,
  getIdList,
  getRollupResult,
  getFormulaResult,
  isComputedType,
  asPlace,
  rawValue,
  type RowContext,
} from './values';
import { formatFormulaResult } from './format';
import { newOption } from './properties';
import { SPREADSHEET_FORMULA, unescapeSpreadsheetCell } from '../../lib/spreadsheet';
import { parseCoordinates } from './map';
import { verificationText } from '../row/verification';

export type CsvDelimiter = ',' | ';';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoDateTime(d: Date, withTime: boolean): string {
  return withTime ? `${isoDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : isoDay(d);
}

/** Number written for spreadsheets: decimal comma with the French `;` separator. */
function csvNumber(n: number, delimiter: CsvDelimiter): string {
  const s = String(Math.round(n * 1e10) / 1e10);
  return delimiter === ';' ? s.replace('.', ',') : s;
}

/** Text of one cell (spreadsheet friendly: ISO dates, plain numbers, names instead of ids). */
export function csvCell(row: Page, prop: PropertyDef, ctx: RowContext, delimiter: CsvDelimiter = ','): string {
  const v = rawValue(row, prop);
  switch (prop.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof v === 'string' ? v : '';
    case 'number': {
      const n = asNumber(v);
      return n === null ? '' : csvNumber(n, delimiter);
    }
    case 'unique_id': {
      const n = asNumber(v);
      return n === null ? '' : prop.uniqueIdPrefix ? `${prop.uniqueIdPrefix}-${n}` : String(n);
    }
    case 'select':
    case 'status':
    case 'multi_select':
      return getIdList(row, prop)
        .map((id) => findOption(prop, id)?.name)
        .filter(Boolean)
        .join(', ');
    case 'person':
    case 'created_by':
    case 'last_edited_by':
      return getIdList(row, prop)
        .map((id) => ctx.users.get(id)?.name ?? '')
        .filter(Boolean)
        .join(', ');
    case 'relation':
      return getIdList(row, prop)
        .map((id) => ctx.relationTitle(id) ?? '')
        .filter(Boolean)
        .join(', ');
    case 'files':
      return asFiles(v)
        .map((f) => (f.url.startsWith('/') && typeof location !== 'undefined' ? `${location.origin}${f.url}` : f.url))
        .join(', ');
    case 'checkbox':
      return v === true ? 'Oui' : 'Non';
    case 'date': {
      const r = dateValueToRange(v);
      if (!r) return '';
      return r.end ? `${isoDateTime(r.start, r.includeTime)} → ${isoDateTime(r.end, r.includeTime)}` : isoDateTime(r.start, r.includeTime);
    }
    case 'created_time':
      return isoDateTime(new Date(row.createdAt), true);
    case 'last_edited_time':
      return isoDateTime(new Date(row.updatedAt), true);
    case 'last_visited': // navigation module: viewer's last visit
      return row.lastVisitedAt ? isoDateTime(new Date(row.lastVisitedAt), true) : '';
    case 'formula': {
      const r = getFormulaResult(row, prop, ctx);
      if (typeof r.value === 'number') return csvNumber(r.value, delimiter);
      if (r.value instanceof Date) return isoDateTime(r.value, r.value.getHours() !== 0 || r.value.getMinutes() !== 0);
      return formatFormulaResult(r);
    }
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      if (typeof r.value === 'number' && r.numberFormat !== 'percent') return csvNumber(r.value, delimiter);
      if (r.range) {
        const d = getDateRange(row, prop, ctx);
        return d ? `${isoDateTime(d.start, d.includeTime)}${d.end ? ` → ${isoDateTime(d.end, d.includeTime)}` : ''}` : '';
      }
      if (r.value instanceof Date) return isoDateTime(r.value, !!r.includeTime);
      return r.text ?? '';
    }
    case 'place':
      return asPlace(rawValue(row, prop))?.address ?? '';
    case 'verification':
      return verificationText(rawValue(row, prop));
  }
}

/** Full CSV text (UTF-8 BOM so that Excel detects the encoding). */
export function buildCsv(rows: readonly Page[], props: PropertyDef[], ctx: RowContext, delimiter: CsvDelimiter = ','): string {
  const data = [props.map((p) => p.name), ...rows.map((r) => props.map((p) => csvCell(r, p, ctx, delimiter)))];
  // Formula-like cells (=, +, -, @…) are prefixed with ' so that spreadsheets show them as text.
  return '﻿' + Papa.unparse(data, { delimiter, newline: '\r\n', escapeFormulae: SPREADSHEET_FORMULA });
}

// ---------------------------------------------------------------------------
// Import: parsing
// ---------------------------------------------------------------------------

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Parses CSV text (separator auto-detected); the first row holds the column names. */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
  const all = (result.data ?? []).filter((r) => Array.isArray(r)).map((r) => r.map((c) => unescapeSpreadsheetCell(typeof c === 'string' ? c : String(c ?? ''))));
  if (all.length === 0) return { headers: [], rows: [] };
  const width = all.reduce((m, r) => Math.max(m, r.length), 0);
  const norm = (r: string[]) => {
    const out = [...r];
    while (out.length < width) out.push('');
    return out;
  };
  const headers = norm(all[0]!).map((h, i) => h.trim() || `Colonne ${i + 1}`);
  return { headers, rows: all.slice(1).map(norm) };
}

// ---------------------------------------------------------------------------
// Import: value parsers
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['oui', 'yes', 'true', 'vrai', 'x', '✓', '✔', '☑', '1']);
const FALSE_WORDS = new Set(['non', 'no', 'false', 'faux', '', '0', '☐']);

export function parseCsvBoolean(raw: string): boolean | null {
  const k = normalizeText(raw.trim());
  if (TRUE_WORDS.has(k)) return true;
  if (FALSE_WORDS.has(k)) return false;
  return null;
}

/** "1 234,5", "1,234.5", "12 %", "3,50 €", "-2" → number; null when not a number. */
export function parseCsvNumber(raw: string): number | null {
  let s = raw.trim().replace(/[\s  ]/g, '').replace(/[€$%£]/g, '');
  if (s === '' || !/^[-+]?[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // The last separator is the decimal one.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // "1,234" (thousands) vs "1,5" (decimal): three digits after a single comma = thousands.
    const parts = s.split(',');
    s = parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3 && !s.startsWith('0')) ? parts.join('') : s.replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1, january: 1,
  fevrier: 2, fevr: 2, fev: 2, february: 2, feb: 2,
  mars: 3, mar: 3, march: 3,
  avril: 4, avr: 4, april: 4, apr: 4,
  mai: 5, may: 5,
  juin: 6, june: 6, jun: 6,
  juillet: 7, juil: 7, july: 7, jul: 7,
  aout: 8, august: 8, aug: 8,
  septembre: 9, sept: 9, sep: 9, september: 9,
  octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11,
  decembre: 12, dec: 12, december: 12,
};

function validDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** One date (with optional time) → [YYYY-MM-DD, 'HH:mm' | null]. */
function parseOneDate(raw: string): [string, string | null] | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    const day = validDay(+m[1]!, +m[2]!, +m[3]!);
    return day ? [day, m[4] ? `${pad(+m[4])}:${m[5]}` : null] : null;
  }
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+(\d{1,2})[:h](\d{2}))?$/.exec(s);
  if (m) {
    const day = validDay(+m[3]!, +m[2]!, +m[1]!);
    return day ? [day, m[4] ? `${pad(+m[4])}:${m[5]}` : null] : null;
  }
  m = /^(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})(?:\s+(\d{1,2})[:h](\d{2}))?$/.exec(s);
  if (m) {
    const month = MONTHS[normalizeText(m[2]!).replace(/\.$/, '')];
    const day = month ? validDay(+m[3]!, month, +m[1]!) : null;
    return day ? [day, m[4] ? `${pad(+m[4])}:${m[5]}` : null] : null;
  }
  m = /^([A-Za-zÀ-ÿ.]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[normalizeText(m[1]!).replace(/\.$/, '')];
    const day = month ? validDay(+m[3]!, month, +m[2]!) : null;
    return day ? [day, null] : null;
  }
  return null;
}

function toStored([day, time]: [string, string | null]): string {
  if (!time) return day;
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

/** "2026-10-13", "13/10/2026", "13 oct. 2026 14:30", "a → b" (range) → DateValue. */
export function parseCsvDate(raw: string): DateValue | null {
  const parts = raw.split(/\s*(?:→|->|–)\s*/);
  if (parts.length > 2) return null;
  const start = parseOneDate(parts[0] ?? '');
  if (!start) return null;
  const end = parts[1] ? parseOneDate(parts[1]) : null;
  if (parts[1] && !end) return null;
  const includeTime = !!start[1] || !!end?.[1];
  const value: DateValue = { start: includeTime ? toStored([start[0], start[1] ?? '00:00']) : start[0] };
  if (end) value.end = includeTime ? toStored([end[0], end[1] ?? '00:00']) : end[0];
  if (includeTime) value.includeTime = true;
  return value;
}

// Domain labels cannot contain dots: no ambiguous split, linear on crafted cells (QA-WEB-06).
const EMAIL = /^[^\s@]+@(?:[^\s@.]+\.)+[^\s@.]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const PHONE = /^\+?\d[\d\s.()-]{7,}\d$/;

/** Values of a multi-valued cell. */
export function splitList(raw: string): string[] {
  return raw
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Import: type inference
// ---------------------------------------------------------------------------

/** Property type guessed from the (non-empty) values of a column. */
export function inferColumnType(values: readonly string[]): PropertyType {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (vals.length === 0) return 'text';
  const all = (fn: (v: string) => boolean) => vals.every(fn);
  if (all((v) => parseCsvBoolean(v) !== null) && vals.some((v) => !/^[01]$/.test(v))) return 'checkbox';
  if (all((v) => parseCsvDate(v) !== null)) return 'date';
  if (all((v) => EMAIL.test(v))) return 'email';
  if (all((v) => URL_RE.test(v))) return 'url';
  if (all((v) => parseCsvNumber(v) !== null)) {
    // Phone numbers look numeric: keep them as text-like phones when formatted as such.
    if (all((v) => PHONE.test(v) && (/^\+|^0\d/.test(v) || /\s|\./.test(v))) && vals.some((v) => /^\+|^0/.test(v))) return 'phone';
    return 'number';
  }
  if (all((v) => PHONE.test(v))) return 'phone';
  const longest = Math.max(...vals.map((v) => v.length));
  if (longest <= 60) {
    const lists = vals.map(splitList);
    const tokens = lists.flat().map((t) => normalizeText(t));
    const distinct = new Set(tokens).size;
    const multi = lists.some((l) => l.length > 1);
    if (distinct <= Math.max(12, Math.ceil(vals.length / 2)) && (distinct < vals.length || vals.length <= 3 || multi)) {
      return multi ? 'multi_select' : 'select';
    }
  }
  return 'text';
}

/** Display format of a number column guessed from its values ("3,50 €" → euro, "12 %" → percent…). */
export function inferNumberFormat(values: readonly string[]): NumberFormat {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (vals.some((v) => v.includes('€'))) return 'euro';
  if (vals.some((v) => v.includes('$'))) return 'dollar';
  if (vals.some((v) => v.includes('%'))) return 'percent';
  if (vals.some((v) => /\d[\s\u00a0\u202f]\d{3}(?!\d)/.test(v) || /\d,\d{3}\./.test(v))) return 'number_with_commas';
  return 'number';
}

// ---------------------------------------------------------------------------
// Import: conversion
// ---------------------------------------------------------------------------

/** Options to add to a select-like property so that every value of the column exists. */
export function missingOptions(prop: PropertyDef, values: readonly string[]): SelectOption[] {
  const existing = new Set((prop.options ?? []).map((o) => normalizeText(o.name.trim())));
  const out: SelectOption[] = [];
  const all = [...(prop.options ?? [])];
  for (const raw of values) {
    const names = prop.type === 'multi_select' ? splitList(raw) : raw.trim() ? [raw.trim()] : [];
    for (const name of names) {
      const k = normalizeText(name);
      if (existing.has(k)) continue;
      existing.add(k);
      const o = newOption(name.slice(0, 200), all, prop.type === 'status' ? 'todo' : undefined);
      all.push(o);
      out.push(o);
    }
  }
  return out;
}

export interface ConversionContext {
  /** Members of the workspace (person columns: names or e-mails). */
  users: readonly PublicUser[];
  /** Rows of the related database, by relation property id (relation columns: titles). */
  relationRows?: ReadonlyMap<string, readonly Pick<Page, 'id' | 'title'>[]>;
}

/** Stored value of a CSV cell for a property (undefined = nothing to write). */
export function csvToValue(prop: PropertyDef, raw: string, cx: ConversionContext): PropertyValue | undefined {
  const s = raw.trim();
  if (isComputedType(prop.type)) return undefined;
  switch (prop.type) {
    case 'title':
      return raw.trim();
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return s ? raw : undefined;
    case 'number': {
      const n = parseCsvNumber(s);
      return n === null ? undefined : n;
    }
    case 'checkbox':
      return parseCsvBoolean(s) ?? undefined;
    case 'date':
      return parseCsvDate(s) ?? undefined;
    case 'select':
    case 'status': {
      if (!s) return undefined;
      return prop.options?.find((o) => normalizeText(o.name.trim()) === normalizeText(s))?.id;
    }
    case 'multi_select': {
      const ids = splitList(s)
        .map((name) => prop.options?.find((o) => normalizeText(o.name.trim()) === normalizeText(name))?.id)
        .filter((x): x is string => !!x);
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case 'person': {
      const ids = splitList(s)
        .map((name) => cx.users.find((u) => normalizeText(u.name) === normalizeText(name) || u.email.toLowerCase() === name.toLowerCase())?.id)
        .filter((x): x is string => !!x);
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case 'relation': {
      const rows = cx.relationRows?.get(prop.id) ?? [];
      const ids = splitList(s)
        .map((title) => rows.find((r) => normalizeText(r.title.trim()) === normalizeText(title))?.id)
        .filter((x): x is string => !!x);
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case 'files': {
      const files: FileValue[] = splitList(s)
        .filter((u) => URL_RE.test(u))
        .map((url) => ({ name: decodeURIComponent(url.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? url), url }));
      return files.length ? files : undefined;
    }
    case 'place': {
      // An address (placed on a map once searched from the cell), or « lat, lng » coordinates.
      if (!s) return undefined;
      const coords = parseCoordinates(s);
      return coords ? { address: s, ...coords } : { address: s.slice(0, 500) };
    }
    default:
      return undefined;
  }
}

/** Human summary of a number (dialog preview). */
export const previewNumber = (n: number) => formatNumber(n, 'number_with_commas');

/** Properties a CSV column can be mapped to (computed ones excluded). */
export const importableProperty = (p: PropertyDef) => !isComputedType(p.type);
