// Uniform, typed access to row values (stored, computed and formula values).
// Every other logic module (filter, sort, group, calc, format) reads rows through these helpers.
import type {
  FileValue,
  Page,
  PlaceValue,
  PropertyDef,
  PropertyType,
  PropertyValue,
  PublicUser,
  SelectOption,
  StatusGroup,
} from '@oriel/shared';
import { COMPUTED_PROPERTY_TYPES } from '@oriel/shared';
import {
  compileFormula,
  evaluateFormula,
  formulaBudgetExhausted,
  formulaFailure,
  formulaList,
  formulaPage,
  formulaPerson,
  formulaValueToText,
  FORMULA_TOO_COSTLY,
  type CompiledFormula,
  type FormulaEnv,
  type FormulaPage,
  type FormulaResult,
  type FormulaValue,
} from './formula';
import { dateValueToRange, type DateRange } from './dates';
import { computeRollup, rollupKind, type RollupResult } from './rollup';
import { verificationOptionId, verificationRank, verificationText, asVerification } from '../row/verification';

/** Logical family of a property, which drives filters, sorting, grouping and calculations. */
export type ValueKind = 'text' | 'number' | 'select' | 'multi' | 'person' | 'relation' | 'files' | 'date' | 'checkbox';

/** Access to the rows and schemas of related databases (rollups). */
export interface RelatedResolver {
  /** A row of a related database, when loaded. */
  row(pageId: string): Page | undefined;
  /** Row context of a related database, when its schema is loaded. */
  context(databaseId: string): RowContext | undefined;
}

export interface RowContext {
  properties: PropertyDef[];
  byId: Map<string, PropertyDef>;
  byName: Map<string, PropertyDef>;
  users: Map<string, PublicUser>;
  /** Title of a related page (relation values), when known. */
  relationTitle: (pageId: string) => string | undefined;
  now: () => Date;
  /** Signed-in user (the « moi » filter value on people); undefined in public views. */
  currentUserId?: string;
  /** Compiled formula per property id. */
  formulas: Map<string, CompiledFormula>;
  /** Formula results per row object (rows are immutable: a new object means new values). */
  formulaCache: WeakMap<Page, Map<string, FormulaResult>>;
  /** Related databases (rollups); undefined when not loaded / not needed. */
  related?: RelatedResolver;
  /** Rollup results per row object. */
  rollupCache: WeakMap<Page, Map<string, RollupResult>>;
}

export interface RowContextOptions {
  users?: Iterable<PublicUser>;
  relationTitle?: (pageId: string) => string | undefined;
  now?: () => Date;
  related?: RelatedResolver;
  currentUserId?: string;
}

export function createRowContext(properties: PropertyDef[], opts: RowContextOptions = {}): RowContext {
  const byId = new Map<string, PropertyDef>();
  const byName = new Map<string, PropertyDef>();
  const formulas = new Map<string, CompiledFormula>();
  for (const p of properties) {
    byId.set(p.id, p);
    if (!byName.has(p.name)) byName.set(p.name, p);
    if (p.type === 'formula') formulas.set(p.id, compileFormula(p.formula ?? ''));
  }
  const users = new Map<string, PublicUser>();
  for (const u of opts.users ?? []) users.set(u.id, u);
  return {
    properties,
    byId,
    byName,
    users,
    relationTitle: opts.relationTitle ?? (() => undefined),
    now: opts.now ?? (() => new Date()),
    currentUserId: opts.currentUserId,
    formulas,
    formulaCache: new WeakMap(),
    related: opts.related,
    rollupCache: new WeakMap(),
  };
}

export const isComputedType = (t: PropertyType) => COMPUTED_PROPERTY_TYPES.includes(t);

/** Value as stored for this property (title read from Page.title). */
export function rawValue(row: Page, prop: PropertyDef): PropertyValue {
  if (prop.type === 'title') return row.title;
  const v = row.properties?.[prop.id];
  return v === undefined ? null : v;
}

export function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
}

export function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** Place value (address and optional coordinates), null when empty or malformed. */
export function asPlace(v: unknown): PlaceValue | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Partial<PlaceValue>;
  if (typeof p.address !== 'string') return null;
  const located = typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  if (!p.address.trim() && !located) return null;
  return located ? { address: p.address, lat: p.lat, lng: p.lng } : { address: p.address };
}

export function asFiles(v: unknown): FileValue[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (f): f is FileValue => !!f && typeof f === 'object' && typeof (f as FileValue).url === 'string',
  );
}

export function findOption(prop: PropertyDef, id: unknown): SelectOption | undefined {
  if (typeof id !== 'string') return undefined;
  return prop.options?.find((o) => o.id === id);
}

export const STATUS_GROUP_ORDER: StatusGroup[] = ['todo', 'in_progress', 'done'];

/** Options in display order (status options grouped À faire / En cours / Terminé). */
export function orderedOptions(prop: PropertyDef): SelectOption[] {
  const options = prop.options ?? [];
  if (prop.type !== 'status') return options;
  return STATUS_GROUP_ORDER.flatMap((g) => options.filter((o) => (o.group ?? 'todo') === g));
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

const EMPTY_RESULT: FormulaResult = { type: 'empty', value: null };
const TOO_COMPLEX: FormulaResult = { type: 'empty', value: null, error: 'Formule trop complexe' };
const TOO_COSTLY: FormulaResult = { type: 'empty', value: null, error: FORMULA_TOO_COSTLY };

/**
 * Formula evaluations allowed in one evaluation tree (a formula of a row and the formulas it reaches
 * through prop()). Formulas belong to the shared schema: without a bound, circular definitions (whose
 * intermediate results cannot be cached) cost fan^depth evaluations per cell for every viewer.
 */
const FORMULA_BUDGET = 10_000;
/** Lowest stack index reached by a circular reference during the current evaluation (Infinity: none). */
let cycleFloor = Infinity;
/** Formula evaluations in progress; budget left and budget exceeded for the current evaluation tree. */
let evaluating = 0;
let budget = 0;
let exhausted = false;

/**
 * Clock granularity of time-dependent results: a formula calling now() (directly, through prop() or
 * a rollup) is reused while ctx.now() stays in the same minute, then evaluated again.
 */
export const TIME_BUCKET_MS = 60_000;
/** Time bucket in which a time-dependent result (formula or rollup) was computed. */
const timeBuckets = new WeakMap<object, number>();
/** Whether the evaluation in progress read the clock (now(), or a time-dependent result). */
let readsClock = false;

const timeBucket = (ctx: RowContext) => Math.floor(ctx.now().getTime() / TIME_BUCKET_MS);

const NOW_CALL = /\bnow\s*\(/i;
const callsNow = (p: PropertyDef) => p.type === 'formula' && NOW_CALL.test(p.formula ?? '');

/**
 * Whether formulas of the schema, or of the databases its rollups read, call now(): views showing them
 * refresh every TIME_BUCKET_MS (a false positive, now( inside a string, only refreshes more often).
 */
export function schemaReadsClock(properties: readonly PropertyDef[], related?: RelatedResolver): boolean {
  if (properties.some(callsNow)) return true;
  for (const p of properties) {
    if (p.type !== 'rollup' || !p.rollup) continue;
    const rel = properties.find((x) => x.id === p.rollup!.relationPropertyId);
    const tctx = rel?.relation ? related?.context(rel.relation.databaseId) : undefined;
    if (tctx?.properties.some(callsNow)) return true;
  }
  return false;
}

/** A cached result still valid (time-dependent ones expire with their time bucket). */
function stillValid<T extends object>(cached: T | undefined, ctx: RowContext): T | undefined {
  if (!cached) return undefined;
  const at = timeBuckets.get(cached);
  if (at === undefined) return cached;
  if (at !== timeBucket(ctx)) return undefined;
  readsClock = true;
  return cached;
}

/** Marks a result computed from the clock (a copy: results may be shared constants). */
function stampTime<T extends object>(result: T, ctx: RowContext): T {
  const stamped = { ...result };
  timeBuckets.set(stamped, timeBucket(ctx));
  return stamped;
}

/**
 * Key of a computed value being evaluated, in the evaluation stack: a row and one of its properties
 * (formulas walking relations read the same property on other rows, which is no cycle).
 */
export const evaluationKey = (row: Page, prop: PropertyDef): string => `${row.id}\u001f${prop.id}`;

/** Pages read through page.prop() nested in one another, and the bound of that walk. */
const MAX_PAGE_DEPTH = 16;
let pageDepth = 0;

/**
 * Value of the property `name` of a related page (page.prop("Nom")), read with that page's database
 * context: empty while its rows or schema are not loaded (or the page is not visible), `undefined` when
 * the database has no such property. Errors of a formula read this way fail the reading formula.
 */
function readPageProperty(page: FormulaPage, name: string, ctx: RowContext, stack: string[]): FormulaValue | undefined {
  const row = ctx.related?.row(page.id);
  if (!row) return null;
  const tctx = ctx.related?.context(row.parentId);
  if (!tctx) return null;
  const target = tctx.byName.get(name);
  if (!target) return undefined;
  if (pageDepth >= MAX_PAGE_DEPTH) formulaFailure(`Parcours de relations trop profond (${MAX_PAGE_DEPTH} niveaux maximum)`);
  pageDepth++;
  try {
    if (target.type === 'formula') {
      const r = getFormulaResult(row, target, tctx, stack);
      if (r.error) formulaFailure(r.error);
      return r.value;
    }
    return toFormulaValue(row, target, tctx, stack);
  } finally {
    pageDepth--;
  }
}

/** Environment of a formula evaluated for `row`: its properties, related pages' properties, the clock. */
export function formulaEnv(row: Page, ctx: RowContext, stack: string[]): FormulaEnv {
  return {
    getProp: (name) => {
      const target = ctx.byName.get(name);
      if (!target) return undefined;
      return toFormulaValue(row, target, ctx, stack);
    },
    getPageProp: (page, name) => readPageProperty(page, name, ctx, stack),
    now: () => {
      readsClock = true;
      return ctx.now();
    },
  };
}

/** Evaluates (with caching) the formula of `prop` for `row`. Circular references evaluate to empty. */
export function getFormulaResult(row: Page, prop: PropertyDef, ctx: RowContext, stack: string[] = []): FormulaResult {
  if (prop.type !== 'formula') return EMPTY_RESULT;
  let perRow = ctx.formulaCache.get(row);
  const cached = stillValid(perRow?.get(prop.id), ctx);
  if (cached) return cached;
  const key = evaluationKey(row, prop);
  const cycleAt = stack.indexOf(key);
  if (cycleAt >= 0) {
    cycleFloor = Math.min(cycleFloor, cycleAt);
    return { type: 'empty', value: null, error: 'Référence circulaire' };
  }
  // A new evaluation tree starts at an empty stack (the view, or a rollup reading a related row), or
  // when nothing is being evaluated (formula editor preview).
  const outermost = evaluating === 0;
  const root = stack.length === 0;
  const fresh = root || outermost;
  const parentBudget = budget;
  const parentExhausted = exhausted;
  if (fresh) {
    budget = FORMULA_BUDGET;
    exhausted = false;
  }
  if (budget <= 0) {
    exhausted = true;
    return TOO_COMPLEX;
  }
  budget--;
  let compiled = ctx.formulas.get(prop.id);
  if (!compiled) {
    compiled = compileFormula(prop.formula ?? '');
    ctx.formulas.set(prop.id, compiled);
  }
  const nextStack = [...stack, key];
  const outerFloor = cycleFloor;
  cycleFloor = Infinity;
  let floor = Infinity;
  let treeExhausted = false;
  let result: FormulaResult;
  const outerClock = readsClock;
  readsClock = false;
  let clockRead = false;
  evaluating++;
  try {
    result = compiled.error
      ? { type: 'empty' as const, value: null, error: compiled.error.message }
      : evaluateFormula(compiled, formulaEnv(row, ctx, nextStack));
    // Out of evaluation steps (shared by the whole evaluation): results below are path-dependent.
    if (formulaBudgetExhausted()) exhausted = true;
  } finally {
    evaluating--;
    floor = cycleFloor;
    cycleFloor = Math.min(outerFloor, floor);
    treeExhausted = exhausted;
    if (fresh) {
      budget = parentBudget;
      exhausted = parentExhausted;
    }
    clockRead = readsClock;
    readsClock = outerClock || clockRead;
  }
  if (fresh && treeExhausted) result = formulaBudgetExhausted() || result.error === FORMULA_TOO_COSTLY ? TOO_COSTLY : TOO_COMPLEX;
  if (clockRead) result = stampTime(result, ctx);
  // Top-level results are cached; others too unless a circular reference to a formula being evaluated
  // above this one cut them short (they depend on the evaluation path) or the budget ran out below them.
  if ((outermost && root) || (floor >= stack.length && (fresh || !treeExhausted))) {
    if (!perRow) {
      perRow = new Map();
      ctx.formulaCache.set(row, perRow);
    }
    perRow.set(prop.id, result);
  }
  return result;
}

/** A person as seen by formulas (an unknown user keeps its id with an empty name). */
function personValue(id: string, ctx: RowContext) {
  const user = ctx.users.get(id);
  return formulaPerson(id, user?.name ?? '', user?.email);
}

/** Converts a row value into the value seen by formulas through prop("…"). */
export function toFormulaValue(row: Page, prop: PropertyDef, ctx: RowContext, stack: string[] = []): FormulaValue {
  const v = rawValue(row, prop);
  switch (prop.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return asString(v);
    case 'number':
    case 'unique_id':
      return asNumber(v);
    case 'select':
    case 'status':
      return findOption(prop, v)?.name ?? null;
    // Multi-valued properties are lists; `legacy` keeps the text prop() returned before lists, read
    // by the historical functions (existing formulas keep their result).
    case 'multi_select': {
      const names = asStringList(v)
        .map((id) => findOption(prop, id)?.name)
        .filter((name): name is string => !!name);
      return formulaList(names, names.join(', '));
    }
    case 'person': {
      const ids = asStringList(v);
      const people = ids.map((id) => personValue(id, ctx));
      return formulaList(people, people.map((p) => p.name).filter(Boolean).join(', '));
    }
    case 'relation': {
      const ids = asStringList(v);
      // Pages whose title is unknown are not loaded or no longer visible (trashed): not elements.
      const pages: FormulaValue[] = [];
      for (const id of ids) {
        const title = ctx.relationTitle(id);
        if (title !== undefined) pages.push(formulaPage(id, title));
      }
      const legacy = ids
        .map((id) => ctx.relationTitle(id) ?? '')
        .filter(Boolean)
        .join(', ');
      return formulaList(pages, legacy);
    }
    case 'files': {
      const names = asFiles(v).map((f) => f.name);
      return formulaList(names, names.join(', '));
    }
    case 'checkbox':
      return v === true;
    case 'date': {
      const r = dateValueToRange(v);
      return r ? r.start : null;
    }
    case 'created_time':
      return new Date(row.createdAt);
    case 'last_edited_time':
      return new Date(row.updatedAt);
    case 'last_visited': // navigation module: viewer's last visit (null if never opened)
      return row.lastVisitedAt ? new Date(row.lastVisitedAt) : null;
    case 'created_by':
    case 'last_edited_by': {
      const id = prop.type === 'created_by' ? row.createdBy : row.updatedBy;
      const user = ctx.users.get(id);
      return user ? formulaPerson(id, user.name, user.email, user.name) : '';
    }
    case 'formula':
      return getFormulaResult(row, prop, ctx, stack).value;
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx, stack);
      return r.range ? r.range.start : r.value;
    }
    case 'place':
      return asPlace(v)?.address ?? '';
    case 'verification':
      return verificationText(v);
  }
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

const EMPTY_ROLLUP: RollupResult = { type: 'empty', value: null };
/**
 * Rollups being evaluated, per database context (re-entering one means a circular definition across
 * databases). Property ids are only unique within a database: « r » of two databases are two nodes.
 */
const evaluatingRollups = new WeakMap<RowContext, Set<string>>();

/** Rollup result (cached per row). Circular rollups / formulas evaluate to empty. */
export function getRollupResult(row: Page, prop: PropertyDef, ctx: RowContext, stack: string[] = []): RollupResult {
  if (prop.type !== 'rollup') return EMPTY_ROLLUP;
  let perRow = ctx.rollupCache.get(row);
  const cached = stillValid(perRow?.get(prop.id), ctx);
  if (cached) return cached;
  let active = evaluatingRollups.get(ctx);
  const key = evaluationKey(row, prop);
  if (stack.includes(key) || active?.has(prop.id)) {
    // Path-dependent result: formulas being evaluated must not cache what they compute from it.
    cycleFloor = -1;
    return { type: 'empty', value: null, text: '', error: 'Référence circulaire' };
  }
  if (!active) {
    active = new Set();
    evaluatingRollups.set(ctx, active);
  }
  active.add(prop.id);
  let result: RollupResult;
  const outerClock = readsClock;
  readsClock = false;
  let clockRead = false;
  try {
    result = computeRollup(row, prop, ctx, [...stack, key]);
  } finally {
    active.delete(prop.id);
    clockRead = readsClock;
    readsClock = outerClock || clockRead;
  }
  if (clockRead) result = stampTime(result, ctx);
  if (!result.pending) {
    if (!perRow) {
      perRow = new Map();
      ctx.rollupCache.set(row, perRow);
    }
    perRow.set(prop.id, result);
  }
  return result;
}

/**
 * Infers the logical kind of a formula from its first non-empty result, over every row: results are
 * cached and the view evaluates them anyway (empty strings, like "" in a branch of if(), decide nothing).
 */
export function formulaKind(prop: PropertyDef, rows: readonly Page[], ctx: RowContext): ValueKind {
  for (const row of rows) {
    const r = getFormulaResult(row, prop, ctx);
    if (r.type === 'number') return 'number';
    if (r.type === 'boolean') return 'checkbox';
    if (r.type === 'date') return 'date';
    if (r.type === 'string' && r.value !== '') return 'text';
    // Lists, pages and people are filtered and sorted by their text; an empty list decides nothing.
    if (r.type === 'page' || r.type === 'person') return 'text';
    if (r.type === 'list' && formulaValueToText(r.value) !== '') return 'text';
  }
  return 'text';
}

// ---------------------------------------------------------------------------
// Kinds & normalized accessors
// ---------------------------------------------------------------------------

export function propertyKind(prop: PropertyDef, rows?: readonly Page[], ctx?: RowContext): ValueKind {
  switch (prop.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return 'text';
    case 'number':
    case 'unique_id':
      return 'number';
    case 'select':
    case 'status':
      return 'select';
    case 'multi_select':
      return 'multi';
    case 'person':
    case 'created_by':
    case 'last_edited_by':
      return 'person';
    case 'relation':
      return 'relation';
    case 'files':
      return 'files';
    case 'date':
    case 'created_time':
    case 'last_edited_time':
    case 'last_visited':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'formula':
      return rows && ctx ? formulaKind(prop, rows, ctx) : 'text';
    case 'rollup':
      return rollupKind(prop);
    case 'place':
      return 'text';
    case 'verification':
      return 'select'; // fixed options 'verified' / 'expired' (D21)
  }
}

/** Text form used by text filters / sorting (formulas: their text conversion). */
export function getText(row: Page, prop: PropertyDef, ctx: RowContext): string {
  if (prop.type === 'formula') {
    const r = getFormulaResult(row, prop, ctx);
    if (r.value === null) return '';
    if (typeof r.value === 'string') return r.value;
    if (typeof r.value === 'number') return String(r.value);
    if (typeof r.value === 'boolean') return r.value ? 'vrai' : 'faux';
    if (r.value instanceof Date) return r.value.toISOString();
    return formulaValueToText(r.value);
  }
  if (prop.type === 'rollup') return getRollupResult(row, prop, ctx).text ?? '';
  if (prop.type === 'unique_id') {
    const n = asNumber(rawValue(row, prop));
    return n === null ? '' : prop.uniqueIdPrefix ? `${prop.uniqueIdPrefix}-${n}` : String(n);
  }
  if (prop.type === 'place') return asPlace(rawValue(row, prop))?.address ?? '';
  return asString(rawValue(row, prop));
}

export function getNumber(row: Page, prop: PropertyDef, ctx: RowContext): number | null {
  if (prop.type === 'formula') {
    const r = getFormulaResult(row, prop, ctx);
    return typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
  }
  if (prop.type === 'rollup') {
    const r = getRollupResult(row, prop, ctx);
    return typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
  }
  return asNumber(rawValue(row, prop));
}

export function getDateRange(row: Page, prop: PropertyDef, ctx: RowContext): DateRange | null {
  switch (prop.type) {
    case 'created_time':
      return { start: new Date(row.createdAt), end: null, includeTime: true };
    case 'last_edited_time':
      return { start: new Date(row.updatedAt), end: null, includeTime: true };
    case 'last_visited':
      return row.lastVisitedAt ? { start: new Date(row.lastVisitedAt), end: null, includeTime: true } : null;
    case 'formula': {
      const r = getFormulaResult(row, prop, ctx);
      return r.value instanceof Date && !Number.isNaN(r.value.getTime())
        ? { start: r.value, end: null, includeTime: true }
        : null;
    }
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      if (r.range) return r.range;
      return r.value instanceof Date && !Number.isNaN(r.value.getTime()) ? { start: r.value, end: null, includeTime: !!r.includeTime } : null;
    }
    default:
      return dateValueToRange(rawValue(row, prop));
  }
}

export function getBoolean(row: Page, prop: PropertyDef, ctx: RowContext): boolean {
  if (prop.type === 'formula') return getFormulaResult(row, prop, ctx).value === true;
  if (prop.type === 'rollup') return getRollupResult(row, prop, ctx).value === true;
  return rawValue(row, prop) === true;
}

/** Ids for list-like properties: options, users (incl. created_by / last_edited_by), related pages. */
export function getIdList(row: Page, prop: PropertyDef): string[] {
  switch (prop.type) {
    case 'created_by':
      return row.createdBy ? [row.createdBy] : [];
    case 'last_edited_by':
      return row.updatedBy ? [row.updatedBy] : [];
    case 'select':
    case 'status': {
      const v = rawValue(row, prop);
      return typeof v === 'string' && v ? [v] : [];
    }
    default:
      return asStringList(rawValue(row, prop));
  }
}

/** Option id for select / status (null when empty or unknown option). */
export function getOptionId(row: Page, prop: PropertyDef): string | null {
  const v = rawValue(row, prop);
  if (prop.type === 'verification') return verificationOptionId(v);
  return findOption(prop, v) ? (v as string) : null;
}

export function isEmptyValue(row: Page, prop: PropertyDef, ctx: RowContext): boolean {
  switch (prop.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return getText(row, prop, ctx).trim() === '';
    case 'number':
    case 'unique_id':
      return getNumber(row, prop, ctx) === null;
    case 'select':
    case 'status':
      return getOptionId(row, prop) === null;
    case 'multi_select':
      return getIdList(row, prop).filter((id) => findOption(prop, id)).length === 0;
    case 'person':
    case 'relation':
      return getIdList(row, prop).length === 0;
    case 'files':
      return asFiles(rawValue(row, prop)).length === 0;
    case 'date':
      return getDateRange(row, prop, ctx) === null;
    case 'checkbox':
      return !getBoolean(row, prop, ctx);
    case 'created_time':
    case 'last_edited_time':
    case 'created_by':
    case 'last_edited_by':
      return false;
    case 'last_visited':
      return !row.lastVisitedAt;
    case 'formula': {
      const r = getFormulaResult(row, prop, ctx);
      return r.value === null || r.value === '' || (r.type === 'list' && formulaValueToText(r.value) === '');
    }
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      return r.value === null || r.value === '';
    }
    case 'place':
      return asPlace(rawValue(row, prop)) === null;
    case 'verification':
      return asVerification(rawValue(row, prop)) === null;
  }
}
