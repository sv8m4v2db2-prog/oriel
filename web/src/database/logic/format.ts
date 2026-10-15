// Human readable (French) formatting of property values.
import type { DateValue, NumberFormat, Page, PropertyDef } from '@oriel/shared';
import { MAX_NUMBER_PRECISION, NUMBER_CURRENCY_CODES } from '@oriel/shared';
import { format as formatDateFns } from 'date-fns';
import { fr } from 'date-fns/locale';
import { formulaValueToText, type FormulaResult } from './formula';
import { dateValueToRange, type DateRange } from './dates';
import { verificationText } from '../row/verification';
import {
  asFiles,
  asNumber,
  findOption,
  getFormulaResult,
  getIdList,
  getRollupResult,
  asPlace,
  rawValue,
  asString,
  type RowContext,
} from './values';

export const NUMBER_FORMAT_LABELS: Record<NumberFormat, string> = {
  number: 'Nombre',
  number_with_commas: 'Nombre avec séparateurs',
  percent: 'Pourcentage',
  euro: 'Euro (€)',
  dollar: 'Dollar américain ($)',
  gbp: 'Livre sterling (£)',
  chf: 'Franc suisse (CHF)',
  cad: 'Dollar canadien (CA$)',
  jpy: 'Yen (¥)',
  aud: 'Dollar australien (A$)',
  cny: 'Yuan renminbi (CN¥)',
  sek: 'Couronne suédoise (SEK)',
  nok: 'Couronne norvégienne (NOK)',
  dkk: 'Couronne danoise (DKK)',
  pln: 'Zloty (PLN)',
  czk: 'Couronne tchèque (CZK)',
  brl: 'Réal brésilien (R$)',
  mxn: 'Peso mexicain (MX$)',
  inr: 'Roupie indienne (₹)',
  krw: 'Won sud-coréen (₩)',
};

const formatters = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = formatters.get(key);
  if (!f) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

/** Decimals kept by `numberPrecision`: an integer from 0 to 10, undefined when not a valid precision. */
export function normalizePrecision(precision: unknown): number | undefined {
  if (typeof precision !== 'number' || !Number.isFinite(precision)) return undefined;
  return Math.min(MAX_NUMBER_PRECISION, Math.max(0, Math.round(precision)));
}

/**
 * fr-FR number formatting (Intl.NumberFormat). Percent: the stored value is the percentage itself
 * (42 → « 42 % »). `precision` fixes the number of decimals (0 to 10); without it, as many as
 * needed (up to 10, 4 for percentages) and the usual two for currencies.
 */
export function formatNumber(n: number, fmt: NumberFormat = 'number', precision?: number): string {
  if (!Number.isFinite(n)) return '';
  const digits = normalizePrecision(precision);
  const fixed = digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  const key = `${fmt}:${digits ?? ''}`;
  switch (fmt) {
    case 'number':
      return nf(key, () => new Intl.NumberFormat('fr-FR', { useGrouping: false, maximumFractionDigits: 10, ...fixed })).format(n);
    case 'number_with_commas':
      return nf(key, () => new Intl.NumberFormat('fr-FR', { useGrouping: true, maximumFractionDigits: 10, ...fixed })).format(n);
    case 'percent':
      return nf(key, () => new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 4, ...fixed })).format(n / 100);
    default: {
      const currency = NUMBER_CURRENCY_CODES[fmt];
      if (!currency) return nf('n', () => new Intl.NumberFormat('fr-FR', { useGrouping: false, maximumFractionDigits: 10 })).format(n);
      return nf(key, () => new Intl.NumberFormat('fr-FR', { style: 'currency', currency, currencyDisplay: fmt === 'dollar' ? 'narrowSymbol' : 'symbol', ...fixed })).format(n);
    }
  }
}

/** A number property's value the way its settings display it (format and precision). */
export function formatPropertyNumber(prop: Pick<PropertyDef, 'numberFormat' | 'numberPrecision'>, n: number): string {
  return formatNumber(n, prop.numberFormat ?? 'number', prop.numberPrecision);
}

/** Maximum a progress bar / ring is drawn against (default 100). */
export function progressMax(prop: Pick<PropertyDef, 'numberMax'>): number {
  const m = prop.numberMax;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 100;
}

/** Share of the maximum reached, clamped to 0…1. */
export function progressRatio(n: number, max: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, n / max));
}

/** Parses user input for a number cell ("1 234,5", "12 %", "3.5 €"). Empty → null, invalid → undefined. */
export function parseNumberInput(input: string): number | null | undefined {
  const s = input
    .replace(/[\s  ]/g, '')
    .replace(/[€$£¥₹₩%]|(?:EUR|USD|GBP|CHF|CAD|JPY|AUD|CNY|SEK|NOK|DKK|PLN|CZK|BRL|MXN|INR|KRW)$/gi, '')
    .replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function formatDate(d: Date, includeTime = false): string {
  return formatDateFns(d, includeTime ? 'd MMM yyyy HH:mm' : 'd MMM yyyy', { locale: fr });
}

export function formatDateRange(r: DateRange | null): string {
  if (!r) return '';
  const start = formatDate(r.start, r.includeTime);
  if (!r.end) return start;
  return `${start} → ${formatDate(r.end, r.includeTime)}`;
}

export function formatDateValue(v: DateValue | null | undefined): string {
  return formatDateRange(dateValueToRange(v));
}

export function formatUniqueId(n: number | null, prefix?: string): string {
  if (n === null) return '';
  return prefix ? `${prefix}-${n}` : String(n);
}

export function formatFormulaResult(r: FormulaResult): string {
  switch (r.type) {
    case 'empty':
      return '';
    case 'number':
      return typeof r.value === 'number' ? formatNumber(r.value, 'number') : '';
    case 'boolean':
      return r.value ? 'Vrai' : 'Faux';
    case 'date':
      if (!(r.value instanceof Date)) return '';
      return formatDate(r.value, r.value.getHours() !== 0 || r.value.getMinutes() !== 0);
    case 'string':
      return typeof r.value === 'string' ? r.value : '';
    case 'list':
    case 'page':
    case 'person':
      return formulaValueToText(r.value);
  }
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 102.4) / 10)} Ko`;
  return `${formatNumber(Math.round(bytes / (1024 * 102.4)) / 10)} Mo`;
}

/** Plain-text rendering of any value (used for copy, search, group labels, accessibility). */
export function displayText(row: Page, prop: PropertyDef, ctx: RowContext): string {
  const v = rawValue(row, prop);
  switch (prop.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return asString(v);
    case 'number': {
      const n = asNumber(v);
      return n === null ? '' : formatPropertyNumber(prop, n);
    }
    case 'unique_id':
      return formatUniqueId(asNumber(v), prop.uniqueIdPrefix);
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
        .map((id) => ctx.users.get(id)?.name ?? 'Utilisateur inconnu')
        .join(', ');
    case 'relation':
      return getIdList(row, prop)
        .map((id) => ctx.relationTitle(id) || 'Sans titre')
        .join(', ');
    case 'files':
      return asFiles(v)
        .map((f) => f.name)
        .join(', ');
    case 'checkbox':
      return v === true ? 'Oui' : 'Non';
    case 'date':
      return formatDateValue(v as DateValue | null);
    case 'created_time':
      return formatDate(new Date(row.createdAt), true);
    case 'last_edited_time':
      return formatDate(new Date(row.updatedAt), true);
    case 'last_visited': // navigation module: viewer's last visit
      return row.lastVisitedAt ? formatDate(new Date(row.lastVisitedAt), true) : '';
    case 'formula':
      return formatFormulaResult(getFormulaResult(row, prop, ctx));
    case 'rollup':
      return getRollupResult(row, prop, ctx).text ?? '';
    case 'place':
      return asPlace(rawValue(row, prop))?.address ?? '';
    case 'verification':
      return verificationText(rawValue(row, prop));
  }
}

export { normalizeText } from './text';

/** Turns a free-form URL value into an href (adds https:// when missing). */
export function toHref(type: 'url' | 'email' | 'phone', value: string): string {
  const v = value.trim();
  if (type === 'email') return `mailto:${v}`;
  if (type === 'phone') return `tel:${v.replace(/[^\d+]/g, '')}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    // Only allow safe schemes for clickable links.
    return /^(https?|mailto|tel|ftp):/i.test(v) ? v : '#';
  }
  return `https://${v}`;
}
