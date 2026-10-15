/**
 * Moteur de formules des propriétés « formule » (SPEC §5.7).
 *
 * Chaîne complète : source → jetons → arbre syntaxique (syntaxe partagée, @oriel/shared formulaSyntax)
 * → évaluation par parcours d'arbre. Aucune exécution de code hôte : pas d'eval, pas de new Function,
 * aucune résolution dynamique de noms (fonctions dans une Map fermée, variables dans des portées
 * connues dès l'analyse).
 *
 * Valeurs : scalaires (nombre, texte, booléen, date, vide) et valeurs structurées (listes, pages,
 * personnes). prop() d'une relation, d'une personne, d'une multi-sélection ou de fichiers renvoie une
 * liste qui garde son ancien texte (`legacy`) : les fonctions historiques écrites f(prop("…")) le lisent
 * toujours, si bien que les formules d'avant les listes gardent exactement leur résultat. La forme
 * suffixe (prop("…").length()) et les fonctions de liste lisent les éléments.
 *
 * Module pur : ni React, ni DOM.
 */
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInMonths,
  differenceInWeeks,
  differenceInYears,
  format as formatDate,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import {
  FORMULA_FUNCTION_SPECS,
  lookupFormulaDateUnit,
  parseFormulaSource,
  type FormulaAst,
  type FormulaBinaryOperator,
  type FormulaDateUnit,
  type FormulaFunctionCategory,
} from '@oriel/shared';

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

/** A page (relation element): its properties are read with page.prop("Nom"). */
export interface FormulaPage {
  readonly kind: 'page';
  readonly id: string;
  readonly title: string;
  /** Text read by the historical functions (see FormulaList.legacy). */
  readonly legacy?: string;
}

export interface FormulaPerson {
  readonly kind: 'person';
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly legacy?: string;
}

export interface FormulaList {
  readonly kind: 'list';
  readonly items: readonly FormulaValue[];
  /**
   * Text that prop() returned before structured values (« A, B »): historical functions written
   * f(prop("…")) keep reading it, so existing formulas keep their result.
   */
  readonly legacy?: string;
}

export type FormulaStructured = FormulaList | FormulaPage | FormulaPerson;
export type FormulaScalar = number | string | boolean | Date | null;
export type FormulaValue = FormulaScalar | FormulaStructured;

export type FormulaResultType = 'number' | 'string' | 'boolean' | 'date' | 'empty' | 'list' | 'page' | 'person';

export interface FormulaResult {
  type: FormulaResultType;
  value: FormulaValue;
  /** runtime error message (French) when evaluation failed; then type 'empty', value null */
  error?: string;
}

export interface FormulaError {
  message: string;
  /** 0-based char offset in the source */
  position: number;
}

export interface CompiledFormula {
  source: string;
  /** null when the source parsed fine */
  error: FormulaError | null;
  /** opaque AST (null when error or empty source) */
  ast: unknown;
  /** property names referenced through prop("…"), deduplicated, in order of appearance */
  references: string[];
}

export interface FormulaEnv {
  /** Value of the property with this exact name for the current row; `undefined` = no such property (→ runtime error "Propriété introuvable : «Nom»"). */
  getProp(name: string): FormulaValue | undefined;
  /** Value of a property of a page (page.prop("Nom")); `undefined` = no such property. Absent: pages cannot be read. */
  getPageProp?(page: FormulaPage, name: string): FormulaValue | undefined;
  /** Clock used by now(); defaults to () => new Date(). */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Limites de sécurité
// ---------------------------------------------------------------------------

/**
 * Evaluation steps allowed for one evaluation, nested evaluations included (formulas of related pages
 * read through page.prop()): bounds the cost of a cell whatever the lists and relations it walks.
 */
const MAX_STEPS = 200_000;
/** Largest list a formula may build. */
const MAX_LIST_ITEMS = 10_000;

export const FORMULA_TOO_COSTLY = 'Formule trop coûteuse (calcul interrompu)';

// ---------------------------------------------------------------------------
// Erreurs internes
// ---------------------------------------------------------------------------

class FormulaRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaRuntimeError';
  }
}

function runtimeError(message: string): FormulaRuntimeError {
  return new FormulaRuntimeError(message);
}

/** Fails the formula being evaluated with `message` (for FormulaEnv callbacks). */
export function formulaFailure(message: string): never {
  throw runtimeError(message);
}

function invalidArgs(fn: string, detail?: string): FormulaRuntimeError {
  return runtimeError(`Arguments invalides pour ${fn}()${detail ? ` : ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Catalogue des fonctions
// ---------------------------------------------------------------------------

/** Help list for the editor UI (French descriptions). */
export const FORMULA_FUNCTIONS: ReadonlyArray<{
  name: string;
  signature: string;
  description: string;
  category: FormulaFunctionCategory;
}> = Object.freeze(
  FORMULA_FUNCTION_SPECS.map(({ name, signature, description, category }) =>
    Object.freeze({ name, signature, description, category }),
  ),
);

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compileFormula(source: string): CompiledFormula {
  const src = typeof source === 'string' ? source : '';
  const parsed = parseFormulaSource(src);
  return { source: src, error: parsed.error, ast: parsed.ast, references: parsed.references };
}

// ---------------------------------------------------------------------------
// Valeurs structurées
// ---------------------------------------------------------------------------

export function isFormulaStructured(v: unknown): v is FormulaStructured {
  if (!v || typeof v !== 'object' || v instanceof Date) return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === 'list' || kind === 'page' || kind === 'person';
}

export function formulaList(items: readonly FormulaValue[], legacy?: string): FormulaList {
  return legacy === undefined ? { kind: 'list', items } : { kind: 'list', items, legacy };
}

export function formulaPage(id: string, title: string, legacy?: string): FormulaPage {
  return legacy === undefined ? { kind: 'page', id, title } : { kind: 'page', id, title, legacy };
}

export function formulaPerson(id: string, name: string, email?: string, legacy?: string): FormulaPerson {
  const person: FormulaPerson = email === undefined ? { kind: 'person', id, name } : { kind: 'person', id, name, email };
  return legacy === undefined ? person : { ...person, legacy };
}

/** The value as the historical functions see it (a structured value with a legacy text: that text). */
function hist(v: FormulaValue): FormulaValue {
  return isFormulaStructured(v) && v.legacy !== undefined ? v.legacy : v;
}

/** The value without its legacy text (receiver of the suffix form, page properties). */
function structured(v: FormulaValue): FormulaValue {
  if (!isFormulaStructured(v) || v.legacy === undefined) return v;
  switch (v.kind) {
    case 'list':
      return formulaList(v.items);
    case 'page':
      return formulaPage(v.id, v.title);
    case 'person':
      return formulaPerson(v.id, v.name, v.email);
  }
}

// ---------------------------------------------------------------------------
// Conversion en texte
// ---------------------------------------------------------------------------

const NUMBER_FORMAT = new Intl.NumberFormat('fr-FR', { useGrouping: false, maximumFractionDigits: 10 });
const COLLATOR = new Intl.Collator('fr');

/** Text conversion used by concat/format/+ with strings (see rules below). */
export function formulaValueToText(v: FormulaValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'vrai' : 'faux';
  if (typeof v === 'number') return NUMBER_FORMAT.format(v === 0 ? 0 : v);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const midnight =
      v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0 && v.getMilliseconds() === 0;
    return formatDate(v, midnight ? 'd MMM yyyy' : 'd MMM yyyy HH:mm', { locale: fr });
  }
  if (isFormulaStructured(v)) {
    if (v.legacy !== undefined) return v.legacy;
    if (v.kind === 'page') return v.title;
    if (v.kind === 'person') return v.name;
    return v.items
      .map(formulaValueToText)
      .filter((s) => s !== '')
      .join(', ');
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Évaluation
// ---------------------------------------------------------------------------

interface Scope {
  readonly vars: Map<string, FormulaValue>;
  readonly parent: Scope | null;
}

interface StepBudget {
  left: number;
}

interface EvalContext {
  env: FormulaEnv;
  /** now() figé pour toute l'évaluation (calculé à la première demande). */
  now: Date | undefined;
  /** Variables of let()/lets() and current/index of per-element arguments. */
  scope: Scope | null;
  budget: StepBudget;
}

/** Step budget of the outermost evaluation in progress (shared by evaluations nested in it). */
let activeBudget: StepBudget | null = null;

/** Whether the evaluation in progress ran out of steps (results computed meanwhile are incomplete). */
export function formulaBudgetExhausted(): boolean {
  return activeBudget !== null && activeBudget.left < 0;
}

function charge(ctx: EvalContext, steps = 1): void {
  ctx.budget.left -= steps;
  if (ctx.budget.left < 0) throw runtimeError(FORMULA_TOO_COSTLY);
}

function typeLabel(v: FormulaValue): string {
  if (v === null) return 'une valeur vide';
  if (typeof v === 'number') return 'un nombre';
  if (typeof v === 'string') return 'un texte';
  if (typeof v === 'boolean') return 'un booléen';
  if (isFormulaStructured(v)) return v.kind === 'list' ? 'une liste' : v.kind === 'page' ? 'une page' : 'une personne';
  return 'une date';
}

function truthy(raw: FormulaValue): boolean {
  const v = hist(raw);
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (isFormulaStructured(v) && v.kind === 'list') return v.items.length > 0;
  return true; // Date, page, personne
}

function checkNumber(n: number): number {
  if (!Number.isFinite(n)) throw runtimeError('Résultat numérique invalide');
  return n;
}

function checkDate(d: Date, fn: string): Date {
  if (Number.isNaN(d.getTime())) throw runtimeError(`Date invalide pour ${fn}()`);
  return d;
}

function isFormulaValue(v: unknown): v is FormulaValue {
  return (
    v === null ||
    typeof v === 'number' ||
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    v instanceof Date ||
    isFormulaStructured(v)
  );
}

function readProp(name: string, ctx: EvalContext): FormulaValue {
  const v = ctx.env.getProp(name);
  if (v === undefined) throw runtimeError(`Propriété introuvable : «${name}»`);
  if (isFormulaValue(v)) return v;
  throw runtimeError(`Valeur non prise en charge pour la propriété «${name}»`);
}

function readPageProp(target: FormulaValue, name: string, ctx: EvalContext): FormulaValue {
  const page = structured(target);
  if (page === null) return null;
  if (isFormulaStructured(page) && page.kind === 'page') {
    if (!ctx.env.getPageProp) throw runtimeError('Les propriétés des pages liées ne sont pas disponibles ici');
    const v = ctx.env.getPageProp(page, name);
    if (v === undefined) throw runtimeError(`Propriété introuvable : «${name}»`);
    if (!isFormulaValue(v)) throw runtimeError(`Valeur non prise en charge pour la propriété «${name}»`);
    return structured(v);
  }
  if (isFormulaStructured(page) && page.kind === 'list') {
    throw runtimeError(`prop() s'applique à une page, pas à une liste : utilisez map(current.prop("${name}"))`);
  }
  throw runtimeError(`prop("${name}") s'applique à une page, pas à ${typeLabel(page)}`);
}

function getNow(ctx: EvalContext): Date {
  if (!ctx.now) {
    const clock = ctx.env.now ?? (() => new Date());
    const d = clock();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw runtimeError('Horloge invalide pour now()');
    ctx.now = d;
  }
  return new Date(ctx.now.getTime());
}

function valuesEqual(rawA: FormulaValue, rawB: FormulaValue): boolean {
  const a = hist(rawA);
  const b = hist(rawB);
  if (a === null || b === null) return a === b;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (isFormulaStructured(a) || isFormulaStructured(b)) {
    if (!isFormulaStructured(a) || !isFormulaStructured(b) || a.kind !== b.kind) return false;
    if (a.kind === 'list' && b.kind === 'list') {
      return a.items.length === b.items.length && a.items.every((x, i) => valuesEqual(x, b.items[i] ?? null));
    }
    return (a as FormulaPage | FormulaPerson).id === (b as FormulaPage | FormulaPerson).id;
  }
  if (typeof a === 'string' && typeof b === 'string') return COLLATOR.compare(a, b) === 0;
  return typeof a === typeof b && a === b;
}

/** Ordre entre deux valeurs comparables ; null si non ordonnables (types différents, vide, booléens). */
function orderOf(rawA: FormulaValue, rawB: FormulaValue): number | null {
  const a = hist(rawA);
  const b = hist(rawB);
  let x: number;
  let y: number;
  if (typeof a === 'number' && typeof b === 'number') {
    x = a;
    y = b;
  } else if (typeof a === 'string' && typeof b === 'string') {
    return COLLATOR.compare(a, b);
  } else if (a instanceof Date && b instanceof Date) {
    x = a.getTime();
    y = b.getTime();
  } else {
    return null;
  }
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

function evalBinary(op: FormulaBinaryOperator, rawL: FormulaValue, rawR: FormulaValue): FormulaValue {
  const l = hist(rawL);
  const r = hist(rawR);
  switch (op) {
    case '==':
      return valuesEqual(l, r);
    case '!=':
      return !valuesEqual(l, r);
    case '<': {
      const c = orderOf(l, r);
      return c !== null && c < 0;
    }
    case '>': {
      const c = orderOf(l, r);
      return c !== null && c > 0;
    }
    case '<=': {
      const c = orderOf(l, r);
      return c !== null && c <= 0;
    }
    case '>=': {
      const c = orderOf(l, r);
      return c !== null && c >= 0;
    }
    case '+':
      if (typeof l === 'string' || typeof r === 'string') {
        return formulaValueToText(l) + formulaValueToText(r);
      }
      if (l === null || r === null) return null;
      if (typeof l === 'number' && typeof r === 'number') return checkNumber(l + r);
      throw runtimeError(`Opération « + » impossible entre ${typeLabel(l)} et ${typeLabel(r)}`);
    case '-':
    case '*':
    case '/':
    case '%': {
      if (l === null || r === null) return null;
      if (typeof l !== 'number' || typeof r !== 'number') {
        throw runtimeError(`Opération « ${op} » impossible entre ${typeLabel(l)} et ${typeLabel(r)}`);
      }
      if (op === '-') return checkNumber(l - r);
      if (op === '*') return checkNumber(l * r);
      if (r === 0) throw runtimeError('Division par zéro');
      return checkNumber(op === '/' ? l / r : l % r);
    }
    default:
      throw runtimeError('Opérateur inconnu');
  }
}

/** Décale la virgule décimale de `exp` rangs sans erreur binaire (via la notation exponentielle). */
function shiftDecimal(n: number, exp: number): number {
  const [mantissa, power] = n.toExponential().split('e');
  return Number(`${mantissa ?? '0'}e${Number(power ?? '0') + exp}`);
}

function roundHalfAwayFromZero(n: number, digits: number): number {
  const d = Math.max(-100, Math.min(100, Math.trunc(digits)));
  if (n === 0) return 0;
  const sign = n < 0 ? -1 : 1;
  const scaled = shiftDecimal(Math.abs(n), d);
  const rounded = shiftDecimal(Math.round(scaled), -d);
  return checkNumber(sign * rounded);
}

/** Arguments of min/max/sum: lists without legacy text are walked (nested ones too). */
function spread(values: readonly FormulaValue[], ctx: EvalContext, out: FormulaValue[] = []): FormulaValue[] {
  for (const raw of values) {
    const v = hist(raw);
    if (isFormulaStructured(v) && v.kind === 'list') {
      charge(ctx, v.items.length);
      spread(v.items, ctx, out);
    } else out.push(v);
  }
  return out;
}

function extremum(fn: 'min' | 'max', values: FormulaValue[]): FormulaValue {
  let kind: 'number' | 'date' | null = null;
  let best: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    let k: 'number' | 'date';
    let t: number;
    if (typeof v === 'number') {
      k = 'number';
      t = v;
    } else if (v instanceof Date) {
      k = 'date';
      t = checkDate(v, fn).getTime();
    } else {
      throw invalidArgs(fn, 'nombres ou dates attendus');
    }
    if (Number.isNaN(t)) throw invalidArgs(fn, 'nombre invalide');
    if (kind === null) kind = k;
    else if (kind !== k) throw invalidArgs(fn, 'nombres et dates mélangés');
    if (best === null || (fn === 'min' ? t < best : t > best)) best = t;
  }
  if (best === null || kind === null) return null;
  return kind === 'date' ? new Date(best) : best;
}

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i;

function toNumber(raw: FormulaValue): FormulaValue {
  const v = hist(raw);
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (isFormulaStructured(v)) return null;
  const compact = v.trim().replace(/[\s  ]/gu, '');
  if (!NUMERIC_TEXT.test(compact)) return null;
  const n = Number(compact.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function resolveUnit(fn: string, raw: FormulaValue): FormulaDateUnit {
  const unit = typeof raw === 'string' ? lookupFormulaDateUnit(raw) : undefined;
  if (!unit) throw runtimeError(`Unité invalide pour ${fn}() : «${formulaValueToText(raw)}»`);
  return unit;
}

function dateBetween(a: Date, b: Date, unit: FormulaDateUnit): number {
  switch (unit) {
    case 'days':
      return differenceInDays(a, b);
    case 'weeks':
      return differenceInWeeks(a, b);
    case 'months':
      return differenceInMonths(a, b);
    case 'years':
      return differenceInYears(a, b);
    case 'hours':
      return differenceInHours(a, b);
    case 'minutes':
      return differenceInMinutes(a, b);
  }
}

function dateAdd(d: Date, amount: number, unit: FormulaDateUnit): Date {
  switch (unit) {
    case 'days':
      return addDays(d, Math.trunc(amount));
    case 'weeks':
      return addWeeks(d, Math.trunc(amount));
    case 'months':
      return addMonths(d, Math.trunc(amount));
    case 'years':
      return addYears(d, Math.trunc(amount));
    case 'hours':
      return new Date(d.getTime() + Math.round(amount * 3_600_000));
    case 'minutes':
      return new Date(d.getTime() + Math.round(amount * 60_000));
  }
}

// --- Listes -----------------------------------------------------------------

/** Elements of the list argument of a list function (an empty value is an empty list). */
function listItems(fn: string, raw: FormulaValue): readonly FormulaValue[] {
  if (raw === null) return [];
  if (isFormulaStructured(raw) && raw.kind === 'list') return raw.items;
  throw invalidArgs(fn, `une liste attendue, pas ${typeLabel(hist(raw))}`);
}

function makeList(items: FormulaValue[]): FormulaList {
  if (items.length > MAX_LIST_ITEMS) throw runtimeError(`Liste trop longue (${MAX_LIST_ITEMS} éléments maximum)`);
  return formulaList(items);
}

function integerArg(fn: string, v: FormulaValue): number {
  const n = hist(v);
  if (typeof n !== 'number' || !Number.isFinite(n)) throw invalidArgs(fn, 'une position entière attendue');
  return Math.trunc(n);
}

/** Rank of a value's type in the total order used by sort(). */
function sortRank(v: FormulaValue): number {
  if (typeof v === 'number') return 0;
  if (v instanceof Date) return 1;
  if (typeof v === 'string') return 2;
  if (typeof v === 'boolean') return 3;
  if (isFormulaStructured(v)) return v.kind === 'page' ? 4 : v.kind === 'person' ? 5 : 6;
  return 7; // vide en dernier
}

function sortCompare(rawA: FormulaValue, rawB: FormulaValue): number {
  const a = hist(rawA);
  const b = hist(rawB);
  const ra = sortRank(a);
  const rb = sortRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b || 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime() || 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (isFormulaStructured(a) && isFormulaStructured(b) && a.kind !== 'list' && b.kind !== 'list') {
    const byName = COLLATOR.compare(formulaValueToText(a), formulaValueToText(b));
    return byName || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  return COLLATOR.compare(formulaValueToText(a), formulaValueToText(b));
}

/** Identity key of a value, for unique(). */
function identityKey(raw: FormulaValue): string {
  const v = hist(raw);
  if (v === null) return 'vide';
  if (typeof v === 'number') return `n:${v === 0 ? 0 : v}`;
  if (typeof v === 'string') return `s:${v.normalize('NFC')}`;
  if (typeof v === 'boolean') return `b:${v}`;
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (v.kind === 'list') return `l:[${v.items.map(identityKey).join(',')}]`;
  return `${v.kind === 'page' ? 'p' : 'u'}:${v.id}`;
}

/** Evaluates `node` with `current` = item and `index` = i in scope. */
function evalForItem(node: FormulaAst, item: FormulaValue, i: number, ctx: EvalContext): FormulaValue {
  const outer = ctx.scope;
  ctx.scope = {
    vars: new Map<string, FormulaValue>([
      ['current', item],
      ['index', i],
    ]),
    parent: outer,
  };
  try {
    return evalNode(node, ctx);
  } finally {
    ctx.scope = outer;
  }
}

function readVar(name: string, ctx: EvalContext): FormulaValue {
  for (let s = ctx.scope; s; s = s.parent) {
    if (s.vars.has(name)) return s.vars.get(name) ?? null;
  }
  throw runtimeError(`Variable inconnue : «${name}»`);
}

type CallNode = Extract<FormulaAst, { k: 'call' }>;

function callFunction(node: CallNode, ctx: EvalContext): FormulaValue {
  const { fn, args } = node;
  const arg = (i: number): FormulaValue => {
    const a = args[i];
    if (!a) throw invalidArgs(fn, 'argument manquant');
    const v = evalNode(a, ctx);
    // Le receveur de la forme suffixe est lu comme valeur structurée (liste, page, personne).
    return i === 0 && node.method ? structured(v) : v;
  };
  const all = (): FormulaValue[] => args.map((_, i) => arg(i));
  const lambda = (): FormulaAst => {
    const a = args[1];
    if (!a) throw invalidArgs(fn, 'argument manquant');
    return a;
  };

  switch (fn) {
    case 'if':
      // Seule la branche choisie est évaluée.
      return truthy(arg(0)) ? arg(1) : arg(2);

    case 'concat':
      return all()
        .map((v) => formulaValueToText(hist(v)))
        .join('');

    case 'length': {
      const v = hist(arg(0));
      if (v === null) return 0;
      if (isFormulaStructured(v) && v.kind === 'list') return v.items.length;
      return Array.from(formulaValueToText(v)).length;
    }

    case 'lower':
    case 'upper': {
      const v = hist(arg(0));
      if (v === null) return null;
      const text = formulaValueToText(v);
      return fn === 'lower' ? text.toLocaleLowerCase('fr') : text.toLocaleUpperCase('fr');
    }

    case 'round': {
      const n = hist(arg(0));
      const digits = args.length > 1 ? hist(arg(1)) : 0;
      if (n === null) return null;
      if (typeof n !== 'number' || (digits !== null && typeof digits !== 'number') || Number.isNaN(digits)) {
        throw invalidArgs('round');
      }
      return roundHalfAwayFromZero(n, digits ?? 0);
    }

    case 'floor':
    case 'ceil':
    case 'abs': {
      const n = hist(arg(0));
      if (n === null) return null;
      if (typeof n !== 'number') throw invalidArgs(fn);
      return checkNumber(fn === 'floor' ? Math.floor(n) : fn === 'ceil' ? Math.ceil(n) : Math.abs(n));
    }

    case 'min':
    case 'max':
      return extremum(fn, spread(all(), ctx));

    case 'sum': {
      let total = 0;
      for (const v of spread(all(), ctx)) {
        if (v === null) continue;
        if (typeof v !== 'number' || Number.isNaN(v)) throw invalidArgs(fn, 'nombres attendus');
        total += v;
      }
      return checkNumber(total);
    }

    case 'now':
      return getNow(ctx);

    case 'dateBetween': {
      const a = hist(arg(0));
      const b = hist(arg(1));
      const unit = resolveUnit(fn, hist(arg(2)));
      if (a === null || b === null) return null;
      if (!(a instanceof Date) || !(b instanceof Date)) throw invalidArgs(fn, 'deux dates attendues');
      return checkNumber(dateBetween(checkDate(a, fn), checkDate(b, fn), unit));
    }

    case 'dateAdd': {
      const d = hist(arg(0));
      const amount = hist(arg(1));
      const unit = resolveUnit(fn, hist(arg(2)));
      if (d === null || amount === null) return null;
      if (!(d instanceof Date) || typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw invalidArgs(fn, 'une date et un nombre attendus');
      }
      const result = dateAdd(checkDate(d, fn), amount, unit);
      if (Number.isNaN(result.getTime())) throw runtimeError('Date hors limites pour dateAdd()');
      return result;
    }

    case 'format':
      return formulaValueToText(hist(arg(0)));

    case 'empty': {
      const v = hist(arg(0));
      if (isFormulaStructured(v)) return v.kind === 'list' && v.items.length === 0;
      return v === null || (typeof v === 'string' && v.trim() === '');
    }

    case 'not':
      return !truthy(arg(0));

    case 'toNumber':
      return toNumber(arg(0));

    case 'contains': {
      const text = formulaValueToText(hist(arg(0))).toLocaleLowerCase('fr');
      const search = formulaValueToText(hist(arg(1))).toLocaleLowerCase('fr');
      return text.includes(search);
    }

    // --- Listes ---

    case 'map': {
      const items = listItems(fn, arg(0));
      const expr = lambda();
      const out: FormulaValue[] = [];
      items.forEach((item, i) => {
        charge(ctx);
        out.push(evalForItem(expr, item, i, ctx));
      });
      return makeList(out);
    }

    case 'filter': {
      const items = listItems(fn, arg(0));
      const cond = lambda();
      const out: FormulaValue[] = [];
      items.forEach((item, i) => {
        charge(ctx);
        if (truthy(evalForItem(cond, item, i, ctx))) out.push(item);
      });
      return makeList(out);
    }

    case 'find':
    case 'findIndex':
    case 'some':
    case 'every': {
      const items = listItems(fn, arg(0));
      const cond = lambda();
      for (let i = 0; i < items.length; i++) {
        charge(ctx);
        const item = items[i] ?? null;
        const ok = truthy(evalForItem(cond, item, i, ctx));
        if (fn === 'every' && !ok) return false;
        if (ok && fn !== 'every') return fn === 'find' ? item : fn === 'findIndex' ? i : true;
      }
      return fn === 'find' ? null : fn === 'findIndex' ? -1 : fn === 'every';
    }

    case 'at': {
      const items = listItems(fn, arg(0));
      const at = arg(1);
      if (hist(at) === null) return null;
      const i = integerArg(fn, at);
      return items[i < 0 ? items.length + i : i] ?? null;
    }

    case 'first':
      return listItems(fn, arg(0))[0] ?? null;

    case 'last': {
      const items = listItems(fn, arg(0));
      return items[items.length - 1] ?? null;
    }

    case 'slice': {
      const items = listItems(fn, arg(0));
      const start = integerArg(fn, arg(1));
      const end = args.length > 2 ? arg(2) : null;
      charge(ctx, items.length);
      return makeList(items.slice(start, hist(end) === null ? undefined : integerArg(fn, end)));
    }

    case 'sort': {
      const items = listItems(fn, arg(0));
      const key = args.length > 1 ? lambda() : null;
      charge(ctx, items.length * Math.max(1, Math.ceil(Math.log2(items.length + 1))));
      const keyed = items.map((item, i) => ({ item, i, key: key ? evalForItem(key, item, i, ctx) : item }));
      keyed.sort((a, b) => sortCompare(a.key, b.key) || a.i - b.i);
      return makeList(keyed.map((k) => k.item));
    }

    case 'reverse': {
      const items = listItems(fn, arg(0));
      charge(ctx, items.length);
      return makeList([...items].reverse());
    }

    case 'unique': {
      const items = listItems(fn, arg(0));
      charge(ctx, items.length);
      const seen = new Set<string>();
      const out: FormulaValue[] = [];
      for (const item of items) {
        const k = identityKey(item);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item);
      }
      return makeList(out);
    }

    case 'flat': {
      const out: FormulaValue[] = [];
      for (const item of listItems(fn, arg(0))) {
        const v = structured(item);
        if (isFormulaStructured(v) && v.kind === 'list') {
          charge(ctx, v.items.length);
          if (out.length + v.items.length > MAX_LIST_ITEMS) throw runtimeError(`Liste trop longue (${MAX_LIST_ITEMS} éléments maximum)`);
          out.push(...v.items);
        } else {
          charge(ctx);
          out.push(item);
        }
      }
      return makeList(out);
    }

    case 'join': {
      const items = listItems(fn, arg(0));
      const sep = args.length > 1 ? formulaValueToText(hist(arg(1))) : ', ';
      charge(ctx, items.length);
      return items.map((v) => formulaValueToText(hist(v))).join(sep);
    }

    case 'includes': {
      const items = listItems(fn, arg(0));
      const needle = arg(1);
      charge(ctx, items.length);
      return items.some((v) => valuesEqual(v, needle));
    }

    case 'name':
    case 'email': {
      const v = structured(arg(0));
      if (v === null) return null;
      if (isFormulaStructured(v) && v.kind === 'person') return fn === 'name' ? v.name : (v.email ?? null);
      if (isFormulaStructured(v) && v.kind === 'page' && fn === 'name') return v.title;
      throw invalidArgs(fn, fn === 'name' ? 'une personne ou une page attendue' : 'une personne attendue');
    }

    default:
      throw runtimeError(`Fonction inconnue : ${fn}`);
  }
}

function evalNode(node: FormulaAst, ctx: EvalContext): FormulaValue {
  charge(ctx);
  switch (node.k) {
    case 'lit':
      return node.value;
    case 'prop':
      return readProp(node.name, ctx);
    case 'pageProp':
      return readPageProp(evalNode(node.target, ctx), node.name, ctx);
    case 'var':
      return readVar(node.name, ctx);
    case 'list':
      return makeList(node.items.map((item) => evalNode(item, ctx)));
    case 'let': {
      const outer = ctx.scope;
      const scope: Scope = { vars: new Map(), parent: outer };
      try {
        node.names.forEach((name, i) => {
          const valueNode = node.values[i];
          if (!valueNode) throw runtimeError('Formule invalide');
          ctx.scope = scope; // chaque valeur voit les noms définis avant elle
          const value = evalNode(valueNode, ctx);
          scope.vars.set(name, value);
        });
        ctx.scope = scope;
        return evalNode(node.body, ctx);
      } finally {
        ctx.scope = outer;
      }
    }
    case 'neg':
    case 'plus': {
      const v = hist(evalNode(node.arg, ctx));
      if (v === null) return null;
      if (typeof v !== 'number') {
        throw runtimeError(`Opération « ${node.k === 'neg' ? '-' : '+'} » impossible sur ${typeLabel(v)}`);
      }
      return node.k === 'neg' ? -v : v;
    }
    case 'not':
      return !truthy(evalNode(node.arg, ctx));
    case 'and':
      return truthy(evalNode(node.left, ctx)) && truthy(evalNode(node.right, ctx));
    case 'or':
      return truthy(evalNode(node.left, ctx)) || truthy(evalNode(node.right, ctx));
    case 'bin': {
      const left = evalNode(node.left, ctx);
      const right = evalNode(node.right, ctx);
      return evalBinary(node.op, left, right);
    }
    case 'call':
      return callFunction(node, ctx);
    default:
      throw runtimeError('Formule invalide');
  }
}

function toResult(raw: FormulaValue): FormulaResult {
  const v = hist(raw);
  if (v === null) return { type: 'empty', value: null };
  if (typeof v === 'number') {
    checkNumber(v);
    return { type: 'number', value: v === 0 ? 0 : v };
  }
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw runtimeError('Date invalide');
    return { type: 'date', value: new Date(v.getTime()) };
  }
  if (isFormulaStructured(v)) return { type: v.kind, value: v };
  throw runtimeError('Résultat non pris en charge');
}

export function evaluateFormula(compiled: CompiledFormula, env: FormulaEnv): FormulaResult {
  const outermost = activeBudget === null;
  if (outermost) activeBudget = { left: MAX_STEPS };
  try {
    if (compiled.error) return { type: 'empty', value: null, error: compiled.error.message };
    if (compiled.ast === null || compiled.ast === undefined) return { type: 'empty', value: null };
    const ctx: EvalContext = { env, now: undefined, scope: null, budget: activeBudget ?? { left: MAX_STEPS } };
    return toResult(evalNode(compiled.ast as FormulaAst, ctx));
  } catch (e) {
    let message = 'Erreur lors du calcul de la formule';
    if (e instanceof FormulaRuntimeError) message = e.message;
    else if (e instanceof RangeError && /call stack/i.test(e.message)) message = 'Formule trop complexe';
    return { type: 'empty', value: null, error: message };
  } finally {
    if (outermost) activeBudget = null;
  }
}

/** Convenience: compile + evaluate. */
export function runFormula(source: string, env: FormulaEnv): FormulaResult {
  return evaluateFormula(compileFormula(source), env);
}

// ---------------------------------------------------------------------------
// Références aux propriétés (D33)
// ---------------------------------------------------------------------------

/** Rewrites prop("old") into prop("new"): one implementation, shared with the server's rename. */
export { renameFormulaReference } from '@oriel/shared';

/** Names referenced by a formula that match no property of `properties` (deleted, renamed or hidden). */
export function missingFormulaReferences(source: string | undefined, properties: ReadonlyArray<{ name: string }>): string[] {
  const refs = compileFormula(source ?? '').references;
  return refs.filter((name) => !properties.some((p) => p.name === name));
}
