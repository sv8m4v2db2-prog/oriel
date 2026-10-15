// References of formulas to properties (D33, I2): shared by the web client and the server, which
// rewrites them in the same transaction as a property rename (interface, API and MCP alike).
//
// Two forms name a property:
//   - prop("Nom"): a property of the row the formula belongs to;
//   - valeur.prop("Nom"): a property of a page (relation element, current in map()/filter(), a let()
//     variable…), which may belong to another database.
// The syntax tree is the evaluator's (formulaSyntax.ts). For the second form, a light inference follows
// relations through the schemas to know which database the page belongs to; a reference whose database
// cannot be known is left unchanged. A source that does not parse falls back to the tokens: only plain
// prop("…") forms are rewritten then. A source that does not tokenize is returned unchanged.
import { parseFormulaSource, tokenizeFormula, type FormulaAst, type FormulaNameSpan, type FormulaToken } from './formulaSyntax.js';

/** What the rewriting reads of a property definition. */
export interface FormulaSchemaProperty {
  id: string;
  name: string;
  type: string;
  formula?: string;
  relation?: { databaseId: string } | null;
}

/** Schema of a database, when known (relation targets, to follow page.prop("…") across relations). */
export type FormulaSchemaResolver = (databaseId: string) => readonly FormulaSchemaProperty[] | undefined;

/** A renamed property, identified by its database and id. */
export interface RenamedFormulaProperty {
  databaseId: string | null;
  propertyId: string;
  oldName: string;
  newName: string;
}

export interface FormulaRenameContext {
  /** Database whose formulas are rewritten (self-relations: current.prop("…") over its own rows). */
  databaseId?: string;
  /** Schemas of the other databases. */
  schemaOf?: FormulaSchemaResolver;
}

/** Writes `name` as a formula string literal. */
const quoteName = (name: string): string => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;

function applyEdits(source: string, spans: FormulaNameSpan[], newName: string): string {
  let out = source;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + quoteName(newName) + out.slice(span.end);
  }
  return out;
}

/** Plain prop("old") forms (not preceded by a dot) of a source that tokenizes but does not parse. */
function tokenSpans(tokens: FormulaToken[], oldName: string): FormulaNameSpan[] {
  const spans: FormulaNameSpan[] = [];
  for (let k = 0; k + 3 < tokens.length; k++) {
    const [a, b, c, d] = [tokens[k]!, tokens[k + 1]!, tokens[k + 2]!, tokens[k + 3]!];
    if (tokens[k - 1]?.kind === '.') continue;
    if (a.kind === 'ident' && a.name.toLowerCase() === 'prop' && b.kind === '(' && c.kind === 'string' && c.value === oldName && d.kind === ')') {
      spans.push({ start: c.pos, end: c.end });
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Inference: which database the pages of an expression belong to
// ---------------------------------------------------------------------------

/** Database of the page(s) an expression yields (a page, or a list of them at any depth); null: none/unknown. */
type PagesOf = string | null;

/** Functions whose result holds the same pages as their list argument. */
const SAME_PAGES = new Set(['filter', 'find', 'first', 'last', 'at', 'slice', 'sort', 'reverse', 'unique', 'flat']);

interface InferenceContext {
  ownDatabaseId: string | null;
  ownProperties: readonly FormulaSchemaProperty[];
  schemaOf: FormulaSchemaResolver;
  renamed: RenamedFormulaProperty;
}

function schemaOf(ic: InferenceContext, db: string | null): readonly FormulaSchemaProperty[] | undefined {
  if (db === null) return undefined;
  if (db === ic.ownDatabaseId) return ic.ownProperties;
  return ic.schemaOf(db);
}

/** Property `name` of database `db`, as it resolved before the rename. */
function lookup(ic: InferenceContext, db: string | null, name: string, own: boolean): FormulaSchemaProperty | undefined {
  const props = own ? ic.ownProperties : schemaOf(ic, db);
  if (!props) return undefined;
  const sameDb = own ? ic.renamed.databaseId === ic.ownDatabaseId || ic.renamed.databaseId === null : db === ic.renamed.databaseId;
  if (sameDb && name === ic.renamed.oldName) return props.find((p) => p.id === ic.renamed.propertyId);
  return props.find((p) => p.name === name);
}

const relationTarget = (p: FormulaSchemaProperty | undefined): PagesOf =>
  p?.type === 'relation' && p.relation?.databaseId ? p.relation.databaseId : null;

/**
 * Walks `node`, collecting the name spans of the renamed property (`ownForm`: plain prop() names it too),
 * and returns the database of the pages it yields.
 */
function walk(node: FormulaAst, scope: ReadonlyMap<string, PagesOf>, ic: InferenceContext, ownForm: boolean, spans: FormulaNameSpan[]): PagesOf {
  const sub = (n: FormulaAst, s: ReadonlyMap<string, PagesOf> = scope) => walk(n, s, ic, ownForm, spans);
  switch (node.k) {
    case 'lit':
      return null;
    case 'prop':
      if (ownForm && node.name === ic.renamed.oldName) spans.push(node.span);
      return relationTarget(lookup(ic, ic.ownDatabaseId, node.name, true));
    case 'pageProp': {
      const db = sub(node.target);
      if (db !== null && db === ic.renamed.databaseId && node.name === ic.renamed.oldName) spans.push(node.span);
      return relationTarget(lookup(ic, db, node.name, false));
    }
    case 'var':
      return scope.get(node.name) ?? null;
    case 'list': {
      const dbs = node.items.map((item) => sub(item));
      return dbs.length > 0 && dbs.every((d) => d === dbs[0]) ? (dbs[0] ?? null) : null;
    }
    case 'let': {
      const inner = new Map(scope);
      node.names.forEach((name, i) => {
        const value = node.values[i];
        inner.set(name, value ? sub(value, inner) : null);
      });
      return sub(node.body, inner);
    }
    case 'neg':
    case 'plus':
    case 'not':
      sub(node.arg);
      return null;
    case 'bin':
    case 'and':
    case 'or':
      sub(node.left);
      sub(node.right);
      return null;
    case 'call': {
      const fn = node.fn;
      const receiver = node.args[0] ? sub(node.args[0]) : null;
      let result: PagesOf = null;
      node.args.forEach((arg, i) => {
        if (i === 0) return;
        // Per-element arguments see `current` as one of the receiver's pages.
        const lambda = i === 1 && ['map', 'filter', 'find', 'findIndex', 'some', 'every', 'sort'].includes(fn);
        const db = lambda ? sub(arg, new Map([...scope, ['current', receiver], ['index', null]])) : sub(arg);
        if (fn === 'map' && i === 1) result = db;
        if (fn === 'if' && i >= 1) result = result ?? db;
      });
      if (SAME_PAGES.has(fn)) return receiver;
      if (fn === 'if') return result;
      if (fn === 'map') return result;
      return null;
    }
  }
}

/**
 * Rewrites the references to `renamed` in a formula of database `ownDatabaseId` (whose properties, after
 * the rename, are `ownProperties`). Plain prop() forms are rewritten when the property belongs to that
 * database; page.prop() forms when the page is known to belong to the renamed property's database.
 */
export function rewriteFormulaReferences(
  source: string,
  renamed: RenamedFormulaProperty,
  ownProperties: readonly FormulaSchemaProperty[],
  context: FormulaRenameContext = {},
): string {
  if (!source || renamed.oldName === renamed.newName) return source;
  const ownDatabaseId = context.databaseId ?? null;
  const ownForm = renamed.databaseId === null || renamed.databaseId === ownDatabaseId;
  const parsed = parseFormulaSource(source);
  if (!parsed.ast) {
    if (!ownForm) return source;
    let tokens: FormulaToken[];
    try {
      tokens = tokenizeFormula(source);
    } catch {
      return source;
    }
    return applyEdits(source, tokenSpans(tokens, renamed.oldName), renamed.newName);
  }
  const ic: InferenceContext = { ownDatabaseId, ownProperties, schemaOf: context.schemaOf ?? (() => undefined), renamed };
  const spans: FormulaNameSpan[] = [];
  walk(parsed.ast, new Map(), ic, ownForm, spans);
  return spans.length ? applyEdits(source, spans, renamed.newName) : source;
}

/**
 * Rewrites every `prop("oldName")` of a formula into `prop("newName")` (renamed property of the formula's
 * own database). The rest of the source is kept byte for byte; a source that does not tokenize is
 * returned unchanged.
 */
export function renameFormulaReference(source: string, oldName: string, newName: string): string {
  return rewriteFormulaReferences(source, { databaseId: null, propertyId: '', oldName, newName }, []);
}

/** Whether `oldName` resolved to `propId` among `properties` after its rename (the first of that name). */
function resolvedToRenamed(properties: readonly FormulaSchemaProperty[], propId: string, oldName: string): FormulaSchemaProperty | undefined {
  const at = properties.findIndex((p) => p.id === propId);
  const renamed = properties[at];
  const homonym = properties.findIndex((p) => p.name === oldName);
  if (!renamed || renamed.name === oldName || (homonym >= 0 && homonym < at)) return undefined;
  return renamed;
}

/**
 * Schema after renaming the property `propId` from `oldName`: formulas citing it by name are rewritten.
 * Only when it was the property prop("oldName") resolved to (the first one of that name). With the
 * database id (and other schemas), page.prop("oldName") over pages of this database is rewritten too.
 */
export function renameFormulaReferences<T extends FormulaSchemaProperty>(
  properties: readonly T[],
  propId: string,
  oldName: string,
  context: FormulaRenameContext = {},
): T[] {
  const renamed = resolvedToRenamed(properties, propId, oldName);
  if (!renamed) return [...properties];
  const target: RenamedFormulaProperty = { databaseId: context.databaseId ?? null, propertyId: propId, oldName, newName: renamed.name };
  return properties.map((p) => {
    if (p.type !== 'formula' || !p.formula) return p;
    const formula = rewriteFormulaReferences(p.formula, target, properties, context);
    return formula === p.formula ? p : { ...p, formula };
  });
}

/**
 * Formulas of another database (`properties`, database `databaseId`) after the rename of a property of
 * `renamedDatabaseId` (whose schema after the rename is `renamedProperties`): page.prop("oldName") over
 * pages of that database is rewritten. Returns null when nothing changes.
 */
export function renameRelatedFormulaReferences<T extends FormulaSchemaProperty>(
  properties: readonly T[],
  databaseId: string,
  renamedDatabaseId: string,
  renamedProperties: readonly FormulaSchemaProperty[],
  propId: string,
  oldName: string,
  schemaOf: FormulaSchemaResolver,
): T[] | null {
  const renamed = resolvedToRenamed(renamedProperties, propId, oldName);
  if (!renamed || databaseId === renamedDatabaseId) return null;
  const target: RenamedFormulaProperty = { databaseId: renamedDatabaseId, propertyId: propId, oldName, newName: renamed.name };
  const resolve: FormulaSchemaResolver = (db) => (db === renamedDatabaseId ? renamedProperties : schemaOf(db));
  let changed = false;
  const next = properties.map((p) => {
    if (p.type !== 'formula' || !formulaReadsPages(p.formula)) return p;
    const formula = rewriteFormulaReferences(p.formula ?? '', target, properties, { databaseId, schemaOf: resolve });
    if (formula === p.formula) return p;
    changed = true;
    return { ...p, formula };
  });
  return changed ? next : null;
}

/** Whether a formula reads properties of related pages (page.prop("…")): candidates of renameRelatedFormulaReferences. */
export function formulaReadsPages(source: string | undefined): boolean {
  return !!source && /\.\s*prop\s*\(/.test(source);
}
