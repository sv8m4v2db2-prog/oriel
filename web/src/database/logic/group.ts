// Grouping of rows (board columns, grouped table / list / gallery sections).
import type { Color, Page, PropertyDef, PropertyValue, PublicUser, SelectOption, StatusGroup } from '@oriel/shared';
import { STATUS_GROUP_LABELS } from '@oriel/shared';
import { collatorCompare } from './text';
import { displayText } from './format';
import { sortKey } from './sort';
import { getBoolean, getIdList, getOptionId, orderedOptions, type RowContext } from './values';

export const NO_VALUE_KEY = '__none__';

export interface RowGroup {
  /** Stable key stored in hiddenGroups / collapsedGroups (option id, user id, 'true'/'false', NO_VALUE_KEY). */
  key: string;
  label: string;
  color: Color;
  option?: SelectOption;
  user?: PublicUser;
  statusGroup?: StatusGroup;
  /** Value written into the property when a row is dropped/created in this group (undefined = not assignable). */
  value: PropertyValue | undefined;
  rows: Page[];
}

/** Properties usable for grouped sections (table, list, gallery). */
export function canGroupBy(prop: PropertyDef): boolean {
  return ['select', 'status', 'checkbox', 'person', 'multi_select', 'relation', 'text', 'date', 'created_by', 'last_edited_by', 'formula', 'rollup'].includes(prop.type);
}

/** Properties usable as board columns. */
export function canBoardBy(prop: PropertyDef): boolean {
  return ['select', 'status', 'person', 'multi_select', 'relation', 'text'].includes(prop.type);
}

/**
 * Splits rows into groups, keeping the incoming row order inside each group.
 * Rows with several values (multi_select, person) appear in every matching group.
 */
export function computeGroups(rows: readonly Page[], prop: PropertyDef, ctx: RowContext): RowGroup[] {
  switch (prop.type) {
    case 'select':
    case 'status': {
      const none: RowGroup = { key: NO_VALUE_KEY, label: 'Sans valeur', color: 'default', value: null, rows: [] };
      const groups = orderedOptions(prop).map<RowGroup>((o) => ({
        key: o.id,
        label: o.name,
        color: o.color,
        option: o,
        statusGroup: prop.type === 'status' ? (o.group ?? 'todo') : undefined,
        value: o.id,
        rows: [],
      }));
      const byKey = new Map(groups.map((g) => [g.key, g]));
      for (const row of rows) {
        const id = getOptionId(row, prop);
        const group = id !== null ? byKey.get(id) : undefined;
        (group ?? none).rows.push(row);
      }
      return [none, ...groups];
    }

    case 'multi_select': {
      const none: RowGroup = { key: NO_VALUE_KEY, label: 'Sans valeur', color: 'default', value: [], rows: [] };
      const groups = (prop.options ?? []).map<RowGroup>((o) => ({
        key: o.id,
        label: o.name,
        color: o.color,
        option: o,
        value: [o.id],
        rows: [],
      }));
      const byKey = new Map(groups.map((g) => [g.key, g]));
      for (const row of rows) {
        const ids = getIdList(row, prop).filter((id) => byKey.has(id));
        if (ids.length === 0) none.rows.push(row);
        for (const id of ids) byKey.get(id)!.rows.push(row);
      }
      return [none, ...groups];
    }

    case 'checkbox': {
      const yes: RowGroup = { key: 'true', label: 'Coché', color: 'green', value: true, rows: [] };
      const no: RowGroup = { key: 'false', label: 'Non coché', color: 'default', value: false, rows: [] };
      for (const row of rows) (getBoolean(row, prop, ctx) ? yes : no).rows.push(row);
      return [yes, no];
    }

    case 'relation':
    case 'person':
    case 'created_by':
    case 'last_edited_by': {
      const assignable = prop.type === 'person' || prop.type === 'relation';
      const none: RowGroup = {
        key: NO_VALUE_KEY,
        label: 'Sans valeur',
        color: 'default',
        value: assignable ? [] : undefined,
        rows: [],
      };
      const byKey = new Map<string, RowGroup>();
      for (const row of rows) {
        const ids = getIdList(row, prop);
        if (ids.length === 0) none.rows.push(row);
        for (const id of ids) {
          let g = byKey.get(id);
          if (!g) {
            const user = prop.type === 'relation' ? undefined : ctx.users.get(id);
            g = {
              key: id,
              label: prop.type === 'relation' ? ctx.relationTitle(id) ?? 'Page sans titre' : user?.name ?? 'Utilisateur inconnu',
              color: 'default',
              user,
              value: assignable ? [id] : undefined,
              rows: [],
            };
            byKey.set(id, g);
          }
          g.rows.push(row);
        }
      }
      const groups = [...byKey.values()].sort((a, b) => collatorCompare(a.label, b.label));
      return none.rows.length > 0 || assignable ? [none, ...groups] : groups;
    }

    case 'text':
    case 'date':
    case 'formula':
    case 'rollup': {
      // Computed values: one group per distinct displayed value (not assignable).
      const none: RowGroup = { key: NO_VALUE_KEY, label: 'Sans valeur', color: 'default', value: prop.type === 'text' ? null : undefined, rows: [] };
      const byKey = new Map<string, RowGroup & { order: number | string }>();
      for (const row of rows) {
        const label = displayText(row, prop, ctx).trim();
        if (!label) {
          none.rows.push(row);
          continue;
        }
        const key = label;
        let g = byKey.get(key);
        if (!g) {
          g = { key, label, color: 'default', value: prop.type === 'text' ? label : undefined, rows: [], order: sortKey(row, prop, ctx) ?? label };
          byKey.set(key, g);
        }
        g.rows.push(row);
      }
      const groups = [...byKey.values()].sort((a, b) =>
        typeof a.order === 'number' && typeof b.order === 'number' ? a.order - b.order : collatorCompare(String(a.order), String(b.order)),
      );
      return none.rows.length > 0 ? [...groups.map(({ order: _o, ...g }) => g), none] : groups.map(({ order: _o, ...g }) => g);
    }

    default:
      return [{ key: 'all', label: prop.name, color: 'default', value: undefined, rows: [...rows] }];
  }
}

/** Label of a status group header, e.g. used to render separators in option lists. */
export const statusGroupLabel = (g: StatusGroup) => STATUS_GROUP_LABELS[g];

/**
 * Value written into `prop` when `row` moves from the group `fromKey` to the group `to` (undefined: not
 * assignable). Multi-valued properties (multi_select, person, relation) lose the source value and gain
 * the target one, other values kept; dropping into « Sans valeur » empties them (the only way to show
 * there); a single-page relation is replaced.
 */
export function moveGroupValue(row: Page, prop: PropertyDef, fromKey: string | undefined, to: RowGroup): PropertyValue | undefined {
  if (to.value === undefined) return undefined;
  const multi = prop.type === 'multi_select' || prop.type === 'person' || (prop.type === 'relation' && !prop.relation?.singlePage);
  if (!multi || to.key === NO_VALUE_KEY) return to.value;
  const kept = getIdList(row, prop).filter((id) => id !== fromKey);
  return kept.includes(to.key) ? kept : [...kept, to.key];
}
