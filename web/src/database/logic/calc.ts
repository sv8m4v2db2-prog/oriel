// Footer calculations of the table view (SPEC §5.3).
import type { CalculationType, Page, PropertyDef } from '@oriel/shared';
import { differenceInCalendarDays } from 'date-fns';
import { formatDate, formatNumber } from './format';
import {
  asFiles,
  findOption,
  getBoolean,
  getDateRange,
  getIdList,
  getNumber,
  isEmptyValue,
  rawValue,
  type RowContext,
  type ValueKind,
} from './values';

export const CALCULATION_LABELS: Record<CalculationType, string> = {
  none: 'Aucun',
  count_all: 'Tout compter',
  count_values: 'Compter les valeurs',
  count_empty: 'Compter les vides',
  count_not_empty: 'Compter les non vides',
  percent_empty: 'Pourcentage de vides',
  percent_not_empty: 'Pourcentage de non vides',
  sum: 'Somme',
  average: 'Moyenne',
  median: 'Médiane',
  min: 'Minimum',
  max: 'Maximum',
  range: 'Étendue',
  earliest: 'Date la plus ancienne',
  latest: 'Date la plus récente',
  checked: 'Cochées',
  unchecked: 'Non cochées',
  percent_checked: 'Pourcentage cochées',
};

/** Short prefix displayed before the value in the footer. */
export const CALCULATION_SHORT_LABELS: Record<CalculationType, string> = {
  none: '',
  count_all: 'Nombre',
  count_values: 'Valeurs',
  count_empty: 'Vides',
  count_not_empty: 'Non vides',
  percent_empty: 'Vides',
  percent_not_empty: 'Non vides',
  sum: 'Somme',
  average: 'Moyenne',
  median: 'Médiane',
  min: 'Min',
  max: 'Max',
  range: 'Étendue',
  earliest: 'Plus tôt',
  latest: 'Plus tard',
  checked: 'Cochées',
  unchecked: 'Non cochées',
  percent_checked: 'Cochées',
};

const COMMON: CalculationType[] = [
  'none',
  'count_all',
  'count_values',
  'count_empty',
  'count_not_empty',
  'percent_empty',
  'percent_not_empty',
];

export function calculationsForKind(kind: ValueKind): CalculationType[] {
  switch (kind) {
    case 'number':
      return [...COMMON, 'sum', 'average', 'median', 'min', 'max', 'range'];
    case 'date':
      return [...COMMON, 'earliest', 'latest', 'range'];
    case 'checkbox':
      return ['none', 'count_all', 'checked', 'unchecked', 'percent_checked'];
    default:
      return COMMON;
  }
}

export interface CalculationResult {
  /** Raw numeric result (count, sum, timestamp for dates…), null when not computable. */
  value: number | null;
  /** Formatted value (without the label). */
  display: string;
}

const percent = (part: number, total: number) =>
  total === 0 ? '0 %' : `${formatNumber(Math.round((part / total) * 1000) / 10)} %`;

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Number of values held by a row (multi-valued properties count each value). */
function valueCount(row: Page, prop: PropertyDef, ctx: RowContext): number {
  switch (prop.type) {
    case 'multi_select':
      return getIdList(row, prop).filter((id) => findOption(prop, id)).length;
    case 'person':
    case 'relation':
      return getIdList(row, prop).length;
    case 'files':
      return asFiles(rawValue(row, prop)).length;
    default:
      return isEmptyValue(row, prop, ctx) ? 0 : 1;
  }
}

export function computeCalculation(
  rows: readonly Page[],
  prop: PropertyDef,
  type: CalculationType,
  kind: ValueKind,
  ctx: RowContext,
): CalculationResult {
  const total = rows.length;
  const count = (n: number): CalculationResult => ({ value: n, display: formatNumber(n, 'number_with_commas') });
  const numberFormat = prop.type === 'number' ? (prop.numberFormat ?? 'number') : 'number';
  /** Decimals chosen in the property settings (D25); undefined: automatic. */
  const precision = prop.type === 'number' ? prop.numberPrecision : undefined;

  switch (type) {
    case 'none':
      return { value: null, display: '' };
    case 'count_all':
      return count(total);
    case 'count_values': {
      let n = 0;
      for (const r of rows) n += valueCount(r, prop, ctx);
      return count(n);
    }
    case 'count_empty':
    case 'count_not_empty':
    case 'percent_empty':
    case 'percent_not_empty': {
      let empty = 0;
      for (const r of rows) if (isEmptyValue(r, prop, ctx)) empty++;
      if (type === 'count_empty') return count(empty);
      if (type === 'count_not_empty') return count(total - empty);
      const part = type === 'percent_empty' ? empty : total - empty;
      return { value: total === 0 ? 0 : (part / total) * 100, display: percent(part, total) };
    }
    case 'checked':
    case 'unchecked':
    case 'percent_checked': {
      let checked = 0;
      for (const r of rows) if (getBoolean(r, prop, ctx)) checked++;
      if (type === 'checked') return count(checked);
      if (type === 'unchecked') return count(total - checked);
      return { value: total === 0 ? 0 : (checked / total) * 100, display: percent(checked, total) };
    }
    case 'earliest':
    case 'latest': {
      let best: Date | null = null;
      let withTime = false;
      for (const r of rows) {
        const d = getDateRange(r, prop, ctx);
        if (!d) continue;
        if (!best || (type === 'earliest' ? d.start < best : d.start > best)) {
          best = d.start;
          withTime = d.includeTime;
        }
      }
      return best ? { value: best.getTime(), display: formatDate(best, withTime) } : { value: null, display: '' };
    }
    case 'sum':
    case 'average':
    case 'median':
    case 'min':
    case 'max':
    case 'range': {
      if (kind === 'date') {
        if (type !== 'range') return { value: null, display: '' };
        let min: Date | null = null;
        let max: Date | null = null;
        for (const r of rows) {
          const d = getDateRange(r, prop, ctx);
          if (!d) continue;
          const end = d.end ?? d.start;
          if (!min || d.start < min) min = d.start;
          if (!max || end > max) max = end;
        }
        if (!min || !max) return { value: null, display: '' };
        const days = differenceInCalendarDays(max, min);
        return { value: days, display: `${formatNumber(days, 'number_with_commas')} jour${Math.abs(days) > 1 ? 's' : ''}` };
      }
      const nums: number[] = [];
      for (const r of rows) {
        const n = getNumber(r, prop, ctx);
        if (n !== null) nums.push(n);
      }
      if (nums.length === 0) return { value: null, display: '' };
      let value: number;
      switch (type) {
        case 'sum':
          value = nums.reduce((a, b) => a + b, 0);
          break;
        case 'average':
          value = nums.reduce((a, b) => a + b, 0) / nums.length;
          break;
        case 'median':
          value = median([...nums].sort((a, b) => a - b))!;
          break;
        case 'min':
          value = Math.min(...nums);
          break;
        case 'max':
          value = Math.max(...nums);
          break;
        default:
          value = Math.max(...nums) - Math.min(...nums);
      }
      // Avoid floating point noise (0.1 + 0.2).
      value = Math.round(value * 1e9) / 1e9;
      const display = precision === undefined && type === 'average' && numberFormat === 'number'
        ? formatNumber(Math.round(value * 100) / 100, 'number')
        : formatNumber(value, numberFormat, precision);
      return { value, display };
    }
  }
}

export interface GroupShare {
  count: number;
  /** Share of the view's rows, in percent (0 when the view is empty). */
  percent: number;
  /** « 12 lignes · 34,5 % » */
  display: string;
}

/** Number of rows of a group and its share of all the rows of the grouped view (SPEC §5.10). */
export function groupShare(count: number, total: number): GroupShare {
  const pct = total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
  const n = formatNumber(count, 'number_with_commas');
  // A few rows of a large view: « < 0,1 % » rather than a misleading « 0 % ».
  const share = count > 0 && pct === 0 ? `< ${formatNumber(0.1)} %` : percent(count, total);
  return { count, percent: pct, display: `${n} ligne${count > 1 ? 's' : ''} · ${share}` };
}
