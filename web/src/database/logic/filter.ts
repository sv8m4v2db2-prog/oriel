// View filters (SPEC §5.4): rules combined with AND / OR, operators depending on the property kind.
import type { FilterGroup, FilterOperator, FilterRule, Page, PropertyDef, RelativeRange } from '@oriel/shared';
import {
  asDuration,
  dayKey,
  durationDayKey,
  durationRangeKeys,
  rangeDayKeys,
  relativeRangeKeys,
  resolveFilterDate,
  RELATIVE_RANGES,
} from './dates';
import { normalizeText } from './text';
import {
  asFiles,
  getBoolean,
  getDateRange,
  getIdList,
  getNumber,
  getOptionId,
  getRollupResult,
  getText,
  propertyKind,
  rawValue,
  type RowContext,
  type ValueKind,
} from './values';

/** Value standing for the signed-in user in the people filters (« moi »). */
export const ME_FILTER_VALUE = '@me';

const TEXT_OPS: FilterOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
];
const NUMBER_OPS: FilterOperator[] = ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty'];
const SELECT_OPS: FilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
const LIST_OPS: FilterOperator[] = ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
/** Multi-valued properties: « contains any », « contains all » and « contains none » of the values. */
const MULTI_OPS: FilterOperator[] = ['contains', 'contains_all', 'not_contains', 'is_empty', 'is_not_empty'];
const DATE_OPS: FilterOperator[] = [
  'equals',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'within',
  'within_last',
  'within_next',
  'exactly_ago',
  'exactly_ahead',
  'is_empty',
  'is_not_empty',
];
/** Operators whose value is a RelativeDuration. */
const DURATION_OPS: FilterOperator[] = ['within_last', 'within_next', 'exactly_ago', 'exactly_ahead'];
export const isDurationOperator = (op: FilterOperator) => DURATION_OPS.includes(op);
const CHECKBOX_OPS: FilterOperator[] = ['checked', 'unchecked'];

export function operatorsForKind(kind: ValueKind): FilterOperator[] {
  switch (kind) {
    case 'text':
      return TEXT_OPS;
    case 'number':
      return NUMBER_OPS;
    case 'select':
      return SELECT_OPS;
    case 'multi':
    case 'person':
    case 'relation':
      return MULTI_OPS;
    case 'files':
      return LIST_OPS;
    case 'date':
      return DATE_OPS;
    case 'checkbox':
      return CHECKBOX_OPS;
  }
}

/** French label of an operator for a given kind. */
export function operatorLabel(op: FilterOperator, kind: ValueKind): string {
  if (kind === 'number') {
    const sym: Partial<Record<FilterOperator, string>> = {
      equals: '=',
      not_equals: '≠',
      gt: '>',
      lt: '<',
      gte: '≥',
      lte: '≤',
    };
    if (sym[op]) return sym[op]!;
  }
  switch (op) {
    case 'equals':
      return 'est';
    case 'not_equals':
      return "n'est pas";
    case 'contains':
      return 'contient';
    case 'not_contains':
      return 'ne contient pas';
    case 'starts_with':
      return 'commence par';
    case 'ends_with':
      return 'se termine par';
    case 'is_empty':
      return 'est vide';
    case 'is_not_empty':
      return "n'est pas vide";
    case 'gt':
      return 'est supérieur à';
    case 'lt':
      return 'est inférieur à';
    case 'gte':
      return 'est supérieur ou égal à';
    case 'lte':
      return 'est inférieur ou égal à';
    case 'before':
      return 'est avant';
    case 'after':
      return 'est après';
    case 'on_or_before':
      return 'est au plus tard';
    case 'on_or_after':
      return 'est au plus tôt';
    case 'within':
      return 'est dans';
    case 'contains_all':
      return 'contient tous';
    case 'within_last':
      return 'est dans les derniers';
    case 'within_next':
      return 'est dans les prochains';
    case 'exactly_ago':
      return 'il y a exactement';
    case 'exactly_ahead':
      return 'dans exactement';
    case 'checked':
      return 'est coché';
    case 'unchecked':
      return "n'est pas coché";
  }
}

export function operatorNeedsValue(op: FilterOperator): boolean {
  return !(op === 'is_empty' || op === 'is_not_empty' || op === 'checked' || op === 'unchecked');
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

export function toFilterNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[\s  ]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** True for « show original » rollups: a quantifier makes the rule apply to each related value. */
export function isMultiValueRollup(prop: PropertyDef | undefined): boolean {
  return prop?.type === 'rollup' && prop.rollup?.function === 'show_original';
}

/** Target property of a « show original » rollup (the one whose values it lists), when loaded. */
export function rollupItemProp(prop: PropertyDef, ctx: RowContext): PropertyDef | null {
  const cfg = prop.rollup;
  if (prop.type !== 'rollup' || !cfg || cfg.function !== 'show_original') return null;
  const rel = ctx.byId.get(cfg.relationPropertyId);
  if (!rel || rel.type !== 'relation' || !rel.relation) return null;
  return ctx.related?.context(rel.relation.databaseId)?.byId.get(cfg.targetPropertyId) ?? null;
}

/** Kind of the values a « show original » rollup lists (its target property), null when unknown / not loaded. */
export function rollupItemKind(prop: PropertyDef, ctx: RowContext): ValueKind | null {
  const target = rollupItemProp(prop, ctx);
  const tctx = target ? ctx.related?.context(ctx.byId.get(prop.rollup!.relationPropertyId)!.relation!.databaseId) : undefined;
  return target && tctx ? propertyKind(target, [], tctx) : null;
}

const WHOLE_VALUE_OPS: FilterOperator[] = ['is_empty', 'is_not_empty'];

/**
 * Kind that decides the operators and the value of a rule: the kind of the related values when the
 * rule has a quantifier on a « show original » rollup, the property's own kind otherwise.
 */
export function ruleKind(rule: FilterRule, prop: PropertyDef, kind: ValueKind, ctx: RowContext): ValueKind | null {
  if (rule.quantifier && isMultiValueRollup(prop) && !WHOLE_VALUE_OPS.includes(rule.operator)) return rollupItemKind(prop, ctx);
  return kind;
}

/** A rule participates in filtering only when its operator is valid for the kind and it has a value if needed. */
export function isRuleActive(rule: FilterRule, prop: PropertyDef | undefined, kind: ValueKind, ctx?: RowContext): boolean {
  if (!prop) return false;
  let k: ValueKind | null = kind;
  if (rule.quantifier && ctx && isMultiValueRollup(prop) && !WHOLE_VALUE_OPS.includes(rule.operator)) {
    k = rollupItemKind(prop, ctx);
    if (!k) return false;
  }
  if (!operatorsForKind(k).includes(rule.operator)) return false;
  if (!operatorNeedsValue(rule.operator)) return true;
  if (!hasValue(rule.value) && !isDurationOperator(rule.operator)) return false;
  if (k === 'number') return toFilterNumber(rule.value) !== null;
  if (k === 'date') {
    if (rule.operator === 'within') return RELATIVE_RANGES.includes(rule.value as RelativeRange);
    if (isDurationOperator(rule.operator)) return asDuration(rule.value) !== null;
    return resolveFilterDate(rule.value, new Date()) !== null;
  }
  return true;
}

function textMatches(op: FilterOperator, text: string, value: unknown): boolean {
  const t = normalizeText(text.trim());
  const v = normalizeText(String(value ?? '').trim());
  switch (op) {
    case 'equals':
      return t === v;
    case 'not_equals':
      return t !== v;
    case 'contains':
      return t.includes(v);
    case 'not_contains':
      return !t.includes(v);
    case 'starts_with':
      return t.startsWith(v);
    case 'ends_with':
      return t.endsWith(v);
    case 'is_empty':
      return t === '';
    case 'is_not_empty':
      return t !== '';
    default:
      return true;
  }
}

function valueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  if (typeof value === 'string' && value) return [value];
  return [];
}

/** Wanted ids of a people / relation / option rule, « moi » resolved to the signed-in user. */
function wantedIds(value: unknown, ctx: RowContext): string[] {
  const out: string[] = [];
  for (const v of valueList(value)) {
    if (v === ME_FILTER_VALUE) {
      if (ctx.currentUserId) out.push(ctx.currentUserId);
    } else out.push(v);
  }
  return out;
}

/** Rollup « show original » with a quantifier: the rule is evaluated on every related value. */
function matchesRollupItems(row: Page, rule: FilterRule, prop: PropertyDef, ctx: RowContext, now: Date): boolean {
  const items = getRollupResult(row, prop, ctx).items ?? [];
  // « moi » is resolved here: the contexts of related databases know nothing of the signed-in user.
  const hasMe = rule.value === ME_FILTER_VALUE || (Array.isArray(rule.value) && rule.value.includes(ME_FILTER_VALUE));
  const value = hasMe ? wantedIds(rule.value, ctx) : rule.value;
  const inner: FilterRule = { id: rule.id, propertyId: rule.propertyId, operator: rule.operator, value };
  const hit = (item: (typeof items)[number]) => {
    const kind = propertyKind(item.prop, [], item.ctx);
    if (!operatorsForKind(kind).includes(inner.operator)) return false;
    return matchesRule(item.row, inner, item.prop, kind, item.ctx, now);
  };
  switch (rule.quantifier) {
    case 'every':
      return items.length > 0 && items.every(hit);
    case 'none':
      return !items.some(hit);
    default:
      return items.some(hit);
  }
}

export function matchesRule(
  row: Page,
  rule: FilterRule,
  prop: PropertyDef,
  kind: ValueKind,
  ctx: RowContext,
  now: Date,
): boolean {
  const op = rule.operator;
  if (rule.quantifier && isMultiValueRollup(prop) && !WHOLE_VALUE_OPS.includes(op)) {
    return matchesRollupItems(row, rule, prop, ctx, now);
  }
  switch (kind) {
    case 'text':
      return textMatches(op, getText(row, prop, ctx), rule.value);

    case 'number': {
      const x = getNumber(row, prop, ctx);
      if (op === 'is_empty') return x === null;
      if (op === 'is_not_empty') return x !== null;
      const v = toFilterNumber(rule.value);
      if (v === null) return true;
      if (op === 'not_equals') return x === null || x !== v;
      if (x === null) return false;
      switch (op) {
        case 'equals':
          return x === v;
        case 'gt':
          return x > v;
        case 'lt':
          return x < v;
        case 'gte':
          return x >= v;
        case 'lte':
          return x <= v;
        default:
          return true;
      }
    }

    case 'select': {
      const x = getOptionId(row, prop);
      if (op === 'is_empty') return x === null;
      if (op === 'is_not_empty') return x !== null;
      const wanted = valueList(rule.value);
      if (op === 'equals') return x !== null && wanted.includes(x);
      if (op === 'not_equals') return x === null || !wanted.includes(x);
      return true;
    }

    case 'multi':
    case 'person':
    case 'relation': {
      let list = getIdList(row, prop);
      if (prop.type === 'multi_select') list = list.filter((id) => prop.options?.some((o) => o.id === id));
      if (op === 'is_empty') return list.length === 0;
      if (op === 'is_not_empty') return list.length > 0;
      const wanted = wantedIds(rule.value, ctx);
      const hit = wanted.some((w) => list.includes(w));
      if (op === 'contains') return hit;
      if (op === 'not_contains') return !hit;
      if (op === 'contains_all') return wanted.length > 0 && wanted.every((w) => list.includes(w));
      return true;
    }

    case 'files': {
      const names = asFiles(rawValue(row, prop)).map((f) => normalizeText(f.name));
      if (op === 'is_empty') return names.length === 0;
      if (op === 'is_not_empty') return names.length > 0;
      const v = normalizeText(String(rule.value ?? '').trim());
      const hit = names.some((n) => n.includes(v));
      if (op === 'contains') return hit;
      if (op === 'not_contains') return !hit;
      return true;
    }

    case 'date': {
      const r = getDateRange(row, prop, ctx);
      if (op === 'is_empty') return r === null;
      if (op === 'is_not_empty') return r !== null;
      if (!r) return false;
      const [start, end] = rangeDayKeys(r);
      if (op === 'within') {
        const [a, b] = relativeRangeKeys(rule.value as RelativeRange, now);
        return start <= b && end >= a;
      }
      if (op === 'within_last' || op === 'within_next') {
        const dur = asDuration(rule.value);
        if (!dur) return true;
        const [a, b] = durationRangeKeys(dur, op === 'within_last' ? 'last' : 'next', now);
        return start <= b && end >= a;
      }
      if (op === 'exactly_ago' || op === 'exactly_ahead') {
        const dur = asDuration(rule.value);
        if (!dur) return true;
        const k = durationDayKey(dur, op === 'exactly_ago' ? 'ago' : 'ahead', now);
        return start <= k && k <= end;
      }
      const d = resolveFilterDate(rule.value, now);
      if (!d) return true;
      const k = dayKey(d);
      switch (op) {
        case 'equals':
          return start <= k && k <= end;
        case 'before':
          return start < k;
        case 'after':
          return start > k;
        case 'on_or_before':
          return start <= k;
        case 'on_or_after':
          return start >= k;
        default:
          return true;
      }
    }

    case 'checkbox': {
      const x = getBoolean(row, prop, ctx);
      if (op === 'checked') return x;
      if (op === 'unchecked') return !x;
      return true;
    }
  }
}

export interface PreparedRule {
  rule: FilterRule;
  prop: PropertyDef;
  kind: ValueKind;
}

export interface PreparedFilter {
  conjunction: 'and' | 'or';
  rules: PreparedRule[];
  /** Nested groups with at least one active rule (combined with the rules by `conjunction`). */
  groups: Array<{ conjunction: 'and' | 'or'; rules: PreparedRule[] }>;
}

function prepareRules(list: readonly FilterRule[] | undefined, rows: readonly Page[], ctx: RowContext): PreparedRule[] {
  const rules: PreparedRule[] = [];
  for (const rule of list ?? []) {
    const prop = ctx.byId.get(rule.propertyId);
    if (!prop) continue;
    const kind = propertyKind(prop, rows, ctx);
    if (isRuleActive(rule, prop, kind, ctx)) rules.push({ rule, prop, kind });
  }
  return rules;
}

/** Resolves properties/kinds once and drops inactive rules (and empty groups). */
export function prepareFilter(filter: FilterGroup | null | undefined, rows: readonly Page[], ctx: RowContext): PreparedFilter {
  if (!filter || !Array.isArray(filter.rules)) return { conjunction: 'and', rules: [], groups: [] };
  const groups = (Array.isArray(filter.groups) ? filter.groups : [])
    .map((g) => ({ conjunction: g.conjunction === 'or' ? ('or' as const) : ('and' as const), rules: prepareRules(g.rules, rows, ctx) }))
    .filter((g) => g.rules.length > 0);
  return { conjunction: filter.conjunction === 'or' ? 'or' : 'and', rules: prepareRules(filter.rules, rows, ctx), groups };
}

/** Number of active conditions (rules, nested ones included). */
export function activeRuleCount(prepared: PreparedFilter): number {
  return prepared.rules.length + prepared.groups.reduce((n, g) => n + g.rules.length, 0);
}

function matchesRules(row: Page, conjunction: 'and' | 'or', rules: PreparedRule[], ctx: RowContext, now: Date): boolean {
  if (conjunction === 'or') return rules.some((p) => matchesRule(row, p.rule, p.prop, p.kind, ctx, now));
  return rules.every((p) => matchesRule(row, p.rule, p.prop, p.kind, ctx, now));
}

export function matchesFilter(
  row: Page,
  prepared: { conjunction: 'and' | 'or'; rules: PreparedRule[]; groups?: PreparedFilter['groups'] },
  ctx: RowContext,
  now: Date,
): boolean {
  const groups = prepared.groups ?? [];
  if (prepared.rules.length === 0 && groups.length === 0) return true;
  const results: Array<() => boolean> = [
    ...prepared.rules.map((p) => () => matchesRule(row, p.rule, p.prop, p.kind, ctx, now)),
    ...groups.map((g) => () => matchesRules(row, g.conjunction, g.rules, ctx, now)),
  ];
  return prepared.conjunction === 'or' ? results.some((f) => f()) : results.every((f) => f());
}

export function applyFilter(rows: readonly Page[], filter: FilterGroup | null | undefined, ctx: RowContext): Page[] {
  const prepared = prepareFilter(filter, rows, ctx);
  if (activeRuleCount(prepared) === 0) return [...rows];
  const now = ctx.now();
  return rows.filter((row) => matchesFilter(row, prepared, ctx, now));
}

/** Search box: rows whose title contains the query (case and accent insensitive). */
export function applySearch(rows: readonly Page[], query: string): Page[] {
  const q = normalizeText(query.trim());
  if (!q) return [...rows];
  return rows.filter((r) => normalizeText(r.title).includes(q));
}

/** Default operator/value for a new rule on a property. */
export function defaultRule(id: string, prop: PropertyDef, kind: ValueKind): FilterRule {
  const operator: FilterOperator =
    kind === 'checkbox' ? 'checked' : kind === 'multi' || kind === 'person' || kind === 'relation' || kind === 'files' ? 'contains' : kind === 'text' ? 'contains' : 'equals';
  return { id, propertyId: prop.id, operator, value: undefined };
}
