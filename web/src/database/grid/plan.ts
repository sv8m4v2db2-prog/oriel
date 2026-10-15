// What a range operation writes (SPEC §5.10): copy, paste, fill down, clear. Pure functions: the
// table view turns a plan into batched row updates.
import type { Page, PropertyDef, PropertyValue, SelectOption } from '@oriel/shared';
import { csvCell, csvToValue, missingOptions, type ConversionContext } from '../logic/csv';
import { rawValue, type RowContext } from '../logic/values';
import type { Bounds, CellPos } from './range';

/** A visible column and whether the current person may write its values. */
export interface GridColumn {
  prop: PropertyDef;
  writable: boolean;
}

export interface RowPatch {
  title?: string;
  properties?: Record<string, PropertyValue>;
}

export interface WritePlan {
  /** Row index (in the displayed rows; ≥ rowCount for rows to create) → values to write. */
  writes: Map<number, RowPatch>;
  /** Cells written. */
  cells: number;
  /** Cells of computed or read-only properties (not written). */
  readOnly: number;
  /** Values that could not be converted to the property type (not written). */
  invalid: number;
  /** Pasted columns beyond the last visible column. */
  droppedCols: number;
  /** Pasted rows beyond the last displayed row. */
  extraRows: number;
  /** Options to add to select-like properties before writing (property id → new options). */
  newOptions: Map<string, SelectOption[]>;
}

const emptyPlan = (): WritePlan => ({
  writes: new Map(),
  cells: 0,
  readOnly: 0,
  invalid: 0,
  droppedCols: 0,
  extraRows: 0,
  newOptions: new Map(),
});

function put(plan: WritePlan, row: number, prop: PropertyDef, value: PropertyValue) {
  const patch = plan.writes.get(row) ?? {};
  if (prop.type === 'title') patch.title = typeof value === 'string' ? value : '';
  else (patch.properties ??= {})[prop.id] = value;
  plan.writes.set(row, patch);
  plan.cells++;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Readable text of each cell of the range (spreadsheet friendly: decimal comma, ISO dates, names). */
export function copyMatrix(rows: readonly Page[], props: readonly PropertyDef[], b: Bounds, ctx: RowContext): string[][] {
  const out: string[][] = [];
  for (let r = b.top; r <= b.bottom; r++) {
    const row = rows[r];
    if (!row) continue;
    const line: string[] = [];
    for (let c = b.left; c <= b.right; c++) {
      const prop = props[c];
      line.push(prop ? csvCell(row, prop, ctx, ';') : '');
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

export type Converted = { kind: 'set'; value: PropertyValue } | { kind: 'clear' } | { kind: 'invalid' };

/** Stored value of a pasted cell. An empty cell clears the value (the title becomes empty). */
export function convertCell(prop: PropertyDef, raw: string, cx: ConversionContext): Converted {
  if (raw.trim() === '') return prop.type === 'title' ? { kind: 'set', value: '' } : { kind: 'clear' };
  const value = csvToValue(prop, raw, cx);
  return value === undefined ? { kind: 'invalid' } : { kind: 'set', value };
}

const SELECT_LIKE = new Set(['select', 'status', 'multi_select']);

export interface PasteOptions {
  /** Selected range: a single pasted value fills all of it. */
  range?: Bounds;
  /** Allow creating options missing from select-like properties (default true). */
  createOptions?: boolean;
}

/**
 * Plan of a paste of `matrix` with its top-left cell at `start`. Rows beyond `rowCount` are counted
 * in `extraRows` and planned with indices ≥ rowCount (created only after confirmation).
 */
export function planPaste(
  matrix: readonly (readonly string[])[],
  start: CellPos,
  rowCount: number,
  cols: readonly GridColumn[],
  cx: ConversionContext,
  opts: PasteOptions = {},
): WritePlan {
  const plan = emptyPlan();
  if (matrix.length === 0 || matrix[0]!.length === 0) return plan;
  let data = matrix;
  const single = matrix.length === 1 && matrix[0]!.length === 1;
  if (single && opts.range) {
    const value = matrix[0]![0]!;
    const h = opts.range.bottom - opts.range.top + 1;
    const w = opts.range.right - opts.range.left + 1;
    data = Array.from({ length: h }, () => Array.from({ length: w }, () => value));
    start = { row: opts.range.top, col: opts.range.left };
  }
  const width = data[0]!.length;
  plan.droppedCols = Math.max(0, start.col + width - cols.length);
  plan.extraRows = Math.max(0, start.row + data.length - rowCount);

  // Columns: effective property (with the options to create) per pasted column.
  const effective: (PropertyDef | null)[] = [];
  for (let c = 0; c < width; c++) {
    const col = cols[start.col + c];
    if (!col) {
      effective.push(null);
      continue;
    }
    let prop = col.prop;
    if (col.writable && SELECT_LIKE.has(prop.type) && opts.createOptions !== false) {
      const values = data.map((line) => line[c] ?? '').filter((v) => v.trim() !== '');
      const added = missingOptions(prop, values);
      if (added.length > 0) {
        plan.newOptions.set(prop.id, added);
        prop = { ...prop, options: [...(prop.options ?? []), ...added] };
      }
    }
    effective.push(prop);
  }

  data.forEach((line, r) => {
    for (let c = 0; c < width; c++) {
      const prop = effective[c];
      const col = cols[start.col + c];
      if (!prop || !col) continue;
      if (!col.writable) {
        plan.readOnly++;
        continue;
      }
      const conv = convertCell(prop, line[c] ?? '', cx);
      if (conv.kind === 'invalid') plan.invalid++;
      else put(plan, start.row + r, prop, conv.kind === 'set' ? conv.value : null);
    }
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Fill down / clear
// ---------------------------------------------------------------------------

/** Copies the first row of the range into the following rows (stored values, not text). */
export function planFillDown(rows: readonly Page[], cols: readonly GridColumn[], b: Bounds): WritePlan {
  const plan = emptyPlan();
  const source = rows[b.top];
  if (!source || b.bottom <= b.top) return plan;
  for (let c = b.left; c <= b.right; c++) {
    const col = cols[c];
    if (!col) continue;
    const value = col.prop.type === 'title' ? source.title : rawValue(source, col.prop);
    for (let r = b.top + 1; r <= b.bottom; r++) {
      if (!rows[r]) continue;
      if (!col.writable) {
        plan.readOnly++;
        continue;
      }
      put(plan, r, col.prop, value ?? null);
    }
  }
  return plan;
}

/** Empties the writable cells of the range. */
export function planClear(rowCount: number, cols: readonly GridColumn[], b: Bounds): WritePlan {
  const plan = emptyPlan();
  for (let r = b.top; r <= Math.min(b.bottom, rowCount - 1); r++) {
    for (let c = b.left; c <= b.right; c++) {
      const col = cols[c];
      if (!col) continue;
      if (!col.writable) plan.readOnly++;
      else put(plan, r, col.prop, col.prop.type === 'title' ? '' : null);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Message about the cells that were not written (null when everything was written). */
export function skippedMessage(plan: Pick<WritePlan, 'readOnly' | 'invalid' | 'droppedCols'>): string | null {
  const parts: string[] = [];
  if (plan.readOnly) parts.push(`${plural(plan.readOnly, 'cellule calculée ou en lecture seule', 'cellules calculées ou en lecture seule')}`);
  if (plan.invalid) parts.push(`${plural(plan.invalid, 'valeur non reconnue', 'valeurs non reconnues')}`);
  if (plan.droppedCols) parts.push(`${plural(plan.droppedCols, 'colonne en trop', 'colonnes en trop')}`);
  return parts.length ? `Ignoré : ${parts.join(', ')}.` : null;
}

/** Relation targets: titles of the related rows, for pasting page titles into relation cells. */
export function relationRowsFor(
  props: readonly PropertyDef[],
  rowsOf: (databaseId: string) => readonly Pick<Page, 'id' | 'title'>[] | undefined,
): Map<string, readonly Pick<Page, 'id' | 'title'>[]> {
  const out = new Map<string, readonly Pick<Page, 'id' | 'title'>[]>();
  for (const p of props) {
    const target = p.type === 'relation' ? p.relation?.databaseId : undefined;
    const rows = target ? rowsOf(target) : undefined;
    if (rows) out.set(p.id, rows);
  }
  return out;
}
