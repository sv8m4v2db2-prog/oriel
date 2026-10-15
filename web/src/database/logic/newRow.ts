// Initial values for a row created inside a filtered view, chosen so that the new row stays visible
// (SPEC §5.4: « une nouvelle ligne créée dans une vue filtrée reçoit si possible des valeurs qui la
// rendent visible »).
import type { FilterGroup, PropertyValue } from '@oriel/shared';
import { addDays } from 'date-fns';
import { asDuration, durationDayKey, relativeRangeKeys, resolveFilterDate, toDateString } from './dates';
import { ME_FILTER_VALUE, prepareFilter, toFilterNumber, type PreparedRule } from './filter';
import { isComputedType, orderedOptions, type RowContext } from './values';

export interface NewRowValues {
  title?: string;
  properties: Record<string, PropertyValue>;
}

function firstString(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (Array.isArray(v)) {
    const s = v.find((x) => typeof x === 'string' && x);
    return typeof s === 'string' ? s : null;
  }
  return null;
}

function dayFromKey(key: number): Date {
  return new Date(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100);
}

/** Applies one rule to `out`; returns false when the rule cannot be satisfied by a value. */
function applyRule(p: PreparedRule, out: NewRowValues, now: Date, currentUserId?: string): boolean {
  const { rule, prop, kind } = p;
  if (isComputedType(prop.type)) return false;
  const op = rule.operator;
  const set = (v: PropertyValue) => {
    if (prop.type === 'title') out.title = typeof v === 'string' ? v : '';
    else out.properties[prop.id] = v;
  };

  switch (kind) {
    case 'text': {
      if (op === 'is_empty') return true;
      const v = typeof rule.value === 'string' ? rule.value : String(rule.value ?? '');
      if (['equals', 'contains', 'starts_with', 'ends_with'].includes(op) && v.trim()) {
        set(v.trim());
        return true;
      }
      return false;
    }
    case 'number': {
      if (op === 'is_empty') return true;
      const v = toFilterNumber(rule.value);
      if (v === null) return false;
      const map: Record<string, number> = { equals: v, gte: v, lte: v, gt: v + 1, lt: v - 1 };
      if (op in map) {
        set(map[op]!);
        return true;
      }
      return false;
    }
    case 'select': {
      if (op === 'is_empty') return true;
      if (op === 'equals') {
        const id = firstString(rule.value);
        if (id && prop.options?.some((o) => o.id === id)) {
          set(id);
          return true;
        }
      }
      if (op === 'is_not_empty' || op === 'not_equals') {
        const excluded = op === 'not_equals' ? (Array.isArray(rule.value) ? rule.value : [rule.value]) : [];
        const first = orderedOptions(prop).find((o) => !excluded.includes(o.id));
        if (first) {
          set(first.id);
          return true;
        }
      }
      return false;
    }
    case 'multi':
    case 'person':
    case 'relation': {
      if (op === 'is_empty') return true;
      if (op === 'contains' || op === 'contains_all') {
        // « Moi » stands for the signed-in user; « contains all » adds every wanted value.
        const wanted = (Array.isArray(rule.value) ? rule.value : [rule.value])
          .map((v) => (v === ME_FILTER_VALUE ? currentUserId : v))
          .filter((v): v is string => typeof v === 'string' && v !== '');
        const ids = op === 'contains' ? wanted.slice(0, 1) : wanted;
        if (ids.length === 0) return false;
        const current = out.properties[prop.id];
        const list = Array.isArray(current) ? (current as string[]) : [];
        const next = [...list, ...ids.filter((id) => !list.includes(id))];
        if (next.length !== list.length) set(next);
        return true;
      }
      if (op === 'is_not_empty' && prop.type === 'multi_select') {
        const first = prop.options?.[0];
        if (first) {
          set([first.id]);
          return true;
        }
      }
      return false;
    }
    case 'date': {
      if (op === 'is_empty') return true;
      if (op === 'within') {
        const [a, b] = relativeRangeKeys(rule.value as never, now);
        const today = toDateString(now);
        const todayKey = Number(today.replaceAll('-', ''));
        const day = todayKey >= a && todayKey <= b ? today : toDateString(dayFromKey(a));
        set({ start: day });
        return true;
      }
      if (op === 'is_not_empty' || op === 'within_last' || op === 'within_next') {
        set({ start: toDateString(now) });
        return true;
      }
      if (op === 'exactly_ago' || op === 'exactly_ahead') {
        const dur = asDuration(rule.value);
        if (!dur) return false;
        const k = durationDayKey(dur, op === 'exactly_ago' ? 'ago' : 'ahead', now);
        set({ start: toDateString(dayFromKey(k)) });
        return true;
      }
      const d = resolveFilterDate(rule.value, now);
      if (!d) return false;
      const target = op === 'before' ? addDays(d, -1) : op === 'after' ? addDays(d, 1) : d;
      set({ start: toDateString(target) });
      return true;
    }
    case 'checkbox':
      if (op === 'checked') {
        set(true);
        return true;
      }
      if (op === 'unchecked') {
        set(false);
        return true;
      }
      return false;
    case 'files':
      return op === 'is_empty';
  }
}

export function valuesForNewRow(filter: FilterGroup | null | undefined, ctx: RowContext): NewRowValues {
  const out: NewRowValues = { properties: {} };
  const prepared = prepareFilter(filter, [], ctx);
  const now = ctx.now();
  /** Applies a list of rules; with OR, the first satisfiable one is enough. */
  const applyAll = (conjunction: 'and' | 'or', rules: PreparedRule[], target: NewRowValues): boolean => {
    if (conjunction === 'or') {
      for (const p of rules) {
        const attempt: NewRowValues = { properties: { ...target.properties }, title: target.title };
        if (applyRule(p, attempt, now, ctx.currentUserId)) {
          Object.assign(target, attempt);
          return true;
        }
      }
      return rules.length === 0;
    }
    let ok = true;
    for (const p of rules) ok = applyRule(p, target, now, ctx.currentUserId) && ok;
    return ok;
  };
  if (prepared.conjunction === 'or') {
    // One satisfied rule or group is enough.
    for (const p of prepared.rules) {
      const attempt: NewRowValues = { properties: {} };
      if (applyRule(p, attempt, now, ctx.currentUserId)) return attempt;
    }
    for (const g of prepared.groups) {
      const attempt: NewRowValues = { properties: {} };
      if (applyAll(g.conjunction, g.rules, attempt)) return attempt;
    }
    return out;
  }
  for (const p of prepared.rules) applyRule(p, out, now, ctx.currentUserId);
  for (const g of prepared.groups) applyAll(g.conjunction, g.rules, out);
  return out;
}
