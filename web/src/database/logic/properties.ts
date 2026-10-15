// Schema helpers: new properties, options, property type metadata.
import type { Color, PropertyDef, PropertyType, SelectOption, StatusGroup } from '@oriel/shared';
import { COLORS, DEFAULT_STATUS_OPTIONS, PROPERTY_TYPE_LABELS, shortId } from '@oriel/shared';

/** Types offered when creating / converting a property (title excluded: exactly one per database). */
export const CREATABLE_TYPES: PropertyType[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'checkbox',
  'url',
  'email',
  'phone',
  'files',
  'place',
  'verification',
  'relation',
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'last_visited',
  'unique_id',
];

export const OPTION_TYPES: PropertyType[] = ['select', 'multi_select', 'status'];

/** Picks a random non-default color, avoiding the ones already used when possible. */
export function randomColor(used: Color[] = [], random: () => number = Math.random): Color {
  const palette = COLORS.filter((c) => c !== 'default');
  const free = palette.filter((c) => !used.includes(c));
  const pool = free.length > 0 ? free : palette;
  return pool[Math.floor(random() * pool.length) % pool.length]!;
}

export function newOption(name: string, existing: SelectOption[], group?: StatusGroup): SelectOption {
  const option: SelectOption = {
    id: shortId(8),
    name: name.trim(),
    color: randomColor(existing.map((o) => o.color)),
  };
  if (group) option.group = group;
  return option;
}

/** Unique property name: "Date", "Date 2", "Date 3"… */
export function uniquePropertyName(base: string, properties: PropertyDef[]): string {
  const names = new Set(properties.map((p) => p.name.toLocaleLowerCase('fr')));
  if (!names.has(base.toLocaleLowerCase('fr'))) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate.toLocaleLowerCase('fr'))) return candidate;
  }
}

/** Definition (without id) of a new property of the given type. */
export function newPropertyDef(
  type: PropertyType,
  properties: PropertyDef[],
  opts: { name?: string; relationDatabaseId?: string } = {},
): Omit<PropertyDef, 'id'> {
  const def: Omit<PropertyDef, 'id'> = {
    name: uniquePropertyName(opts.name?.trim() || PROPERTY_TYPE_LABELS[type], properties),
    type,
  };
  if (type === 'select' || type === 'multi_select') def.options = [];
  if (type === 'status') def.options = DEFAULT_STATUS_OPTIONS.map((o) => ({ ...o }));
  if (type === 'number') def.numberFormat = 'number';
  if (type === 'formula') def.formula = '';
  if (type === 'relation' && opts.relationDatabaseId) def.relation = { databaseId: opts.relationDatabaseId };
  if (type === 'rollup') {
    const rel = properties.find((p) => p.type === 'relation');
    def.rollup = { relationPropertyId: rel?.id ?? '', targetPropertyId: 'title', function: 'show_original' };
  }
  return def;
}

/** Extra fields to send when converting an existing property to `type`. */
export function conversionPatch(prop: PropertyDef, type: PropertyType): Partial<Omit<PropertyDef, 'id'>> {
  const patch: Partial<Omit<PropertyDef, 'id'>> = { type };
  const hadOptions = OPTION_TYPES.includes(prop.type) && (prop.options?.length ?? 0) > 0;
  if (type === 'status' && !hadOptions && prop.type !== 'text') {
    patch.options = DEFAULT_STATUS_OPTIONS.map((o) => ({ ...o }));
  }
  if (type === 'number' && !prop.numberFormat) patch.numberFormat = 'number';
  if (type === 'formula' && prop.formula === undefined) patch.formula = '';
  return patch;
}

/** Whether changing from `from` to `to` may lose values (used to warn the user). */
export function conversionMayLoseData(from: PropertyType, to: PropertyType): boolean {
  if (from === to) return false;
  const lossless: Array<[PropertyType, PropertyType]> = [
    ['select', 'multi_select'],
    ['select', 'status'],
    ['status', 'select'],
    ['number', 'text'],
    ['url', 'text'],
    ['email', 'text'],
    ['phone', 'text'],
    ['text', 'url'],
    ['text', 'email'],
    ['text', 'phone'],
    ['checkbox', 'text'],
  ];
  return !lossless.some(([a, b]) => a === from && b === to);
}
