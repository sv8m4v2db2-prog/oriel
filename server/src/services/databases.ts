// Database schema, property values, type conversion and views (ARCHITECTURE §3.4).
import { syncPropertyReminders } from '../collab/propertyReminders.js';
import {
  COMPUTED_PROPERTY_TYPES,
  PAGE_METADATA_PROPERTY_TYPES,
  DEFAULT_STATUS_OPTIONS,
  PROPERTY_TYPE_LABELS,
  VIEW_TYPE_LABELS,
  defaultDatabaseProperties,
  defaultViewConfig,
  positionForInsert,
  positionsBetween,
  shortId,
  newId,
  type Change,
  type DateValue,
  type FileValue,
  type FilterGroup,
  type PropertyDef,
  type PropertyType,
  type PropertyValue,
  type SelectOption,
  type PlaceValue,
  type VerificationValue,
  VERIFICATION_OPTIONS,
  type ViewConfig,
  type ViewType,
  type WorkspaceRole,
} from '@oriel/shared';
import { FORM_QUESTION_TYPES, type ChartConfig } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { PAGE_COLUMNS, parseJson, toPublicUser, toView, type DatabaseRow, type PageRow, type UserRow, type ViewRow } from '../db/rows.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { canEditProperty, canReadProperty, canSeePage, getPageRow, pageAudience, pageChain, roleOf } from '../access.js';
import { indexPage } from './search.js';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, EDITOR_TYPES } from '@oriel/shared';
import { assertPropertyWrites } from './propertyAccess.js';
import { copyViewRowOrder } from './viewOrder.js';
import { renameFormulaReferencesInWorkspace } from './formulaRename.js';

export const TEXT_TYPES: PropertyType[] = ['text', 'url', 'email', 'phone'];
export const OPTION_TYPES: PropertyType[] = ['select', 'multi_select', 'status'];
const GROUPABLE_TYPES: PropertyType[] = ['select', 'status', 'checkbox', 'person'];
const DATE_TYPES: PropertyType[] = ['date', 'created_time', 'last_edited_time'];

const isComputed = (t: PropertyType) => COMPUTED_PROPERTY_TYPES.includes(t);

// ---------------------------------------------------------------------------
// Schema storage
// ---------------------------------------------------------------------------

export interface LoadedSchema {
  row: DatabaseRow;
  properties: PropertyDef[];
}

export function loadSchema(db: Db, databaseId: string): LoadedSchema {
  const row = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', databaseId);
  if (!row) throw notFound('Base de données introuvable.');
  return { row, properties: parseJson<PropertyDef[]>(row.properties, []) };
}

export function saveSchema(db: Db, databaseId: string, properties: PropertyDef[]): void {
  db.run('UPDATE databases SET properties = ?, version = version + 1 WHERE page_id = ?', JSON.stringify(properties), databaseId);
}

/** Default schema, a "Tableau" view and (optionally) 3 empty rows for a brand-new database page. */
export function initDatabase(
  db: Db,
  dbPage: Pick<PageRow, 'id' | 'workspace_id' | 'visibility' | 'owner_id'>,
  actorId: string,
  withRows: boolean,
  now: number,
): void {
  const properties = defaultDatabaseProperties(() => shortId(6));
  db.run('INSERT INTO databases (page_id, properties, next_unique_id, version) VALUES (?, ?, 1, 1)', dbPage.id, JSON.stringify(properties));
  db.run(
    'INSERT INTO views (id, database_id, name, type, position, config, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    newId(),
    dbPage.id,
    VIEW_TYPE_LABELS.table,
    'table',
    positionForInsert([], undefined),
    JSON.stringify(defaultViewConfig('table', properties)),
    now,
    now,
  );
  if (!withRows) return;
  for (const position of positionsBetween(null, null, 3)) {
    db.run(
      `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, icon, cover, position, visibility, owner_id,
        properties, format, is_inline, is_public, created_at, created_by, updated_at, updated_by, version)
       VALUES (?, ?, 'database', ?, 'page', '', NULL, NULL, ?, ?, ?, '{}', '{}', 0, 0, ?, ?, ?, ?, 1)`,
      newId(),
      dbPage.workspace_id,
      dbPage.id,
      position,
      dbPage.visibility,
      dbPage.owner_id,
      now,
      actorId,
      now,
      actorId,
    );
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Date.parse rolls impossible days over ("2024-02-30" → 1 March): the calendar day must exist. */
const isCalendarDay = (s: string): boolean => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const isDateString = (s: unknown): s is string =>
  typeof s === 'string' && DATE_RE.test(s) && isCalendarDay(s) && !Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s));

const invalid = (def: PropertyDef) => badRequest(`Valeur invalide pour la propriété « ${def.name} ».`);
/** File links are rendered as <a href>/<img src> (also on public pages): uploads (/api/files/…) or http(s) only. */
const SAFE_FILE_URL = /^(\/|https?:\/\/)/i;

function stringList(def: PropertyDef, v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)) throw invalid(def);
  return [...new Set(v as string[])];
}

/** Validates one (non-null) value against its property definition. */
export function validateValue(db: Db, def: PropertyDef, v: unknown, workspaceId: string): PropertyValue {
  if (isComputed(def.type)) throw badRequest(`La propriété « ${def.name} » est calculée et ne peut pas être modifiée.`);
  switch (def.type) {
    case 'title':
    case 'text':
      if (typeof v !== 'string' || v.length > 100_000) throw invalid(def);
      return v;
    case 'url':
      if (typeof v !== 'string' || v.length > 2000) throw invalid(def);
      return v;
    case 'email':
      if (typeof v !== 'string' || v.length > 320) throw invalid(def);
      return v;
    case 'phone':
      if (typeof v !== 'string' || v.length > 100) throw invalid(def);
      return v;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(def);
      return v;
    case 'checkbox':
      if (typeof v !== 'boolean') throw invalid(def);
      return v;
    case 'select':
    case 'status': {
      if (typeof v !== 'string') throw invalid(def);
      if (!(def.options ?? []).some((o) => o.id === v)) throw badRequest(`Option inconnue pour la propriété « ${def.name} ».`);
      return v;
    }
    case 'multi_select': {
      const ids = stringList(def, v, 500);
      const known = new Set((def.options ?? []).map((o) => o.id));
      if (!ids.every((id) => known.has(id))) throw badRequest(`Option inconnue pour la propriété « ${def.name} ».`);
      return ids;
    }
    case 'person': {
      const ids = stringList(def, v, 200);
      for (const id of ids) {
        if (!roleOf(db, id, workspaceId)) throw badRequest(`Personne inconnue pour la propriété « ${def.name} ».`);
      }
      return ids;
    }
    case 'relation': {
      const ids = stringList(def, v, 1000);
      // « Limiter à une page »: the last picked page wins.
      return def.relation?.singlePage && ids.length > 1 ? [ids[ids.length - 1]!] : ids;
    }
    case 'date': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(def);
      const d = v as Partial<DateValue>;
      if (!isDateString(d.start)) throw invalid(def);
      if (d.end !== undefined && d.end !== null && !isDateString(d.end)) throw invalid(def);
      if (d.includeTime !== undefined && typeof d.includeTime !== 'boolean') throw invalid(def);
      const out: DateValue = { start: d.start };
      if (d.end) out.end = d.end;
      if (d.includeTime) out.includeTime = true;
      return out;
    }
    case 'files': {
      if (!Array.isArray(v) || v.length > 100) throw invalid(def);
      return v.map((f): FileValue => {
        if (!f || typeof f !== 'object') throw invalid(def);
        const file = f as Partial<FileValue>;
        if (
          typeof file.name !== 'string' ||
          file.name.length > 500 ||
          typeof file.url !== 'string' ||
          file.url.length > 2000 ||
          !SAFE_FILE_URL.test(file.url)
        ) {
          throw invalid(def);
        }
        const out: FileValue = { name: file.name, url: file.url };
        if (file.size !== undefined) {
          if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) throw invalid(def);
          out.size = file.size;
        }
        if (file.mime !== undefined) {
          if (typeof file.mime !== 'string' || file.mime.length > 200) throw invalid(def);
          out.mime = file.mime;
        }
        return out;
      });
    }
    case 'place': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(def);
      const p = v as Partial<PlaceValue>;
      if (typeof p.address !== 'string' || p.address.length > 500) throw invalid(def);
      const out: PlaceValue = { address: p.address };
      if (p.lat !== undefined || p.lng !== undefined) {
        const okLat = typeof p.lat === 'number' && Number.isFinite(p.lat) && p.lat >= -90 && p.lat <= 90;
        const okLng = typeof p.lng === 'number' && Number.isFinite(p.lng) && p.lng >= -180 && p.lng <= 180;
        if (!okLat || !okLng) throw invalid(def);
        out.lat = p.lat;
        out.lng = p.lng;
      }
      if (!out.address.trim() && out.lat === undefined) throw invalid(def);
      return out;
    }
    case 'verification': {
      // D21. Stored shape; mergePropertyValues re-stamps verifiedBy / verifiedAt with the writer.
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(def);
      const x = v as Partial<VerificationValue>;
      if (typeof x.verifiedBy !== 'string' || !roleOf(db, x.verifiedBy, workspaceId)) throw invalid(def);
      if (!isDateString(x.verifiedAt)) throw invalid(def);
      const expiresAt = x.expiresAt ?? null;
      if (expiresAt !== null && (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || !isCalendarDay(expiresAt))) {
        throw invalid(def);
      }
      return { verifiedBy: x.verifiedBy, verifiedAt: x.verifiedAt, expiresAt };
    }
    default:
      throw invalid(def);
  }
}

/**
 * Merges `input` into `current` (null clears a key). The title property is returned separately.
 * Unknown property ids → 400. `actorId`: the writer, whose per-property permissions (D30) are checked
 * (hidden → 400, read-only → 403); null only for trusted server-side writes.
 */
export function mergePropertyValues(
  db: Db,
  schema: PropertyDef[],
  current: Record<string, PropertyValue>,
  input: Record<string, unknown>,
  workspaceId: string,
  actorId: string | null,
): { properties: Record<string, PropertyValue>; title?: string } {
  if (actorId !== null) assertPropertyWrites(schema, roleOf(db, actorId, workspaceId), input, db);
  const out: Record<string, PropertyValue> = { ...current };
  let title: string | undefined;
  for (const [key, value] of Object.entries(input)) {
    const def = schema.find((p) => p.id === key);
    if (!def) throw badRequest(`Propriété inconnue : ${key}.`);
    if (def.type === 'title') {
      if (value !== null && typeof value !== 'string') throw invalid(def);
      title = (value ?? '') as string;
      continue;
    }
    if (value === null || value === undefined) {
      if (isComputed(def.type)) throw badRequest(`La propriété « ${def.name} » est calculée et ne peut pas être modifiée.`);
      delete out[key];
      continue;
    }
    if (def.type === 'verification' && actorId !== null && value && typeof value === 'object' && !Array.isArray(value)) {
      // Verifying is stamped by the server: the writer (an editor, checked above) at the current time.
      out[key] = validateValue(db, def, { ...value, verifiedBy: actorId, verifiedAt: new Date().toISOString() }, workspaceId);
      continue;
    }
    out[key] = validateValue(db, def, value, workspaceId);
  }
  return title === undefined ? { properties: out } : { properties: out, title };
}

/** Assigns server-side unique_id numbers for every unique_id property (increments the counter). */
export function assignUniqueIds(db: Db, databaseId: string, schema: PropertyDef[], values: Record<string, PropertyValue>): void {
  const uniqueProps = schema.filter((p) => p.type === 'unique_id');
  if (uniqueProps.length === 0) return;
  const counter = db.get<{ next_unique_id: number }>('SELECT next_unique_id FROM databases WHERE page_id = ?', databaseId);
  const n = counter?.next_unique_id ?? 1;
  for (const p of uniqueProps) values[p.id] = n;
  db.run('UPDATE databases SET next_unique_id = ? WHERE page_id = ?', n + 1, databaseId);
}

/** Numbers every existing row (creation order) for a property that just became unique_id. */
function numberExistingRows(db: Db, databaseId: string, propId: string, actorId: string): void {
  const rows = db.all<{ id: string; properties: string }>(
    "SELECT id, properties FROM pages WHERE parent_type = 'database' AND parent_id = ? ORDER BY created_at, position, id",
    databaseId,
  );
  let n = db.get<{ next_unique_id: number }>('SELECT next_unique_id FROM databases WHERE page_id = ?', databaseId)?.next_unique_id ?? 1;
  for (const row of rows) {
    const props = parseJson<Record<string, PropertyValue>>(row.properties, {});
    props[propId] = n++;
    writeRow(db, row.id, props, actorId);
  }
  db.run('UPDATE databases SET next_unique_id = ? WHERE page_id = ?', n, databaseId);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

export interface PropertyInput {
  id?: string;
  name?: string;
  type?: PropertyType;
  options?: Array<{ id?: string; name: string; color: SelectOption['color']; group?: SelectOption['group'] }>;
  numberFormat?: PropertyDef['numberFormat'];
  // G1 / D25-D26: null clears the setting.
  numberPrecision?: number | null;
  numberDisplay?: PropertyDef['numberDisplay'] | null;
  numberMax?: number | null;
  numberColor?: PropertyDef['numberColor'] | null;
  dateReminder?: PropertyDef['dateReminder'] | null;
  formula?: string;
  relation?: { databaseId: string; syncedPropertyId?: string; singlePage?: boolean; rowPageDisplay?: 'property' | 'section' | 'hidden'; sectionLayout?: 'list' | 'table' };
  rollup?: PropertyDef['rollup'];
  uniqueIdPrefix?: string;
}

/** Context of a schema write. `touched` collects the other databases modified (two-way relations). */
export interface SchemaWriteCtx {
  databaseId: string;
  workspaceId: string;
  actorId: string;
  touched?: Set<string>;
}

function normalizeOptions(input: PropertyInput['options'], type: PropertyType): SelectOption[] {
  const seen = new Set<string>();
  return (input ?? []).map((o) => {
    const id = o.id ?? shortId(6);
    if (seen.has(id)) throw badRequest('Identifiants d’options en double.');
    seen.add(id);
    const opt: SelectOption = { id, name: o.name, color: o.color };
    if (type === 'status') opt.group = o.group ?? 'todo';
    return opt;
  });
}

/** Keeps only the fields relevant to the type and fills defaults. */
function normalizeDef(
  db: Db,
  def: PropertyDef,
  ctx: { workspaceId: string; actorId: string; selfDatabaseId: string; previousTarget?: string },
): PropertyDef {
  const out: PropertyDef = { id: def.id, name: def.name, type: def.type };
  if (def.access && def.type !== 'title') out.access = def.access; // D30, set by PUT …/access only
  if (OPTION_TYPES.includes(def.type)) {
    let options = def.options ?? [];
    if (def.type === 'status') {
      if (options.length === 0) options = DEFAULT_STATUS_OPTIONS.map((o) => ({ ...o }));
      options = options.map((o) => ({ ...o, group: o.group ?? 'todo' }));
    } else {
      options = options.map(({ group: _g, ...o }) => o);
    }
    out.options = options;
  }
  if (def.type === 'verification') out.options = VERIFICATION_OPTIONS.map((o) => ({ ...o })); // D21: fixed states
  if (def.type === 'number') {
    out.numberFormat = def.numberFormat ?? 'number';
    if (typeof def.numberPrecision === 'number') out.numberPrecision = def.numberPrecision;
    if (def.numberDisplay === 'bar' || def.numberDisplay === 'ring') {
      out.numberDisplay = def.numberDisplay;
      if (typeof def.numberMax === 'number') out.numberMax = def.numberMax;
      if (def.numberColor) out.numberColor = def.numberColor;
    }
  }
  if (def.type === 'date' && def.dateReminder && def.dateReminder.mode !== 'none') out.dateReminder = def.dateReminder;
  if (def.type === 'formula') out.formula = def.formula ?? '';
  if (def.type === 'unique_id' && def.uniqueIdPrefix) out.uniqueIdPrefix = def.uniqueIdPrefix;
  if (def.type === 'relation') {
    const target = def.relation?.databaseId;
    if (!target) throw badRequest('Une relation doit indiquer la base de données liée.');
    if (target !== ctx.selfDatabaseId) {
      const page = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, target);
      const role = page ? roleOf(db, ctx.actorId, page.workspace_id) : null;
      // A relation whose database was deleted for good stays editable (rename, type change…).
      const dangling = !page && target === ctx.previousTarget;
      if (!dangling && (!page || page.kind !== 'database' || page.workspace_id !== ctx.workspaceId || !canSeePage(ctx.actorId, role, page, db))) {
        throw badRequest('Base de données liée introuvable.');
      }
    }
    // syncedPropertyId is managed by makeTwoWay / removeTwoWay only.
    out.relation = { databaseId: target };
    if (def.relation?.singlePage) out.relation.singlePage = true;
    const display = def.relation?.rowPageDisplay;
    if (display === 'section' || display === 'hidden') out.relation.rowPageDisplay = display; // D31
    if (def.relation?.sectionLayout === 'table') out.relation.sectionLayout = 'table';
  }
  if (def.type === 'rollup') {
    out.rollup = {
      relationPropertyId: def.rollup?.relationPropertyId ?? '',
      targetPropertyId: def.rollup?.targetPropertyId ?? '',
      function: def.rollup?.function ?? 'show_original',
    };
  }
  return out;
}

function insertAt<T extends { id: string }>(list: T[], item: T, after: string | null | undefined): T[] {
  const copy = list.filter((x) => x.id !== item.id);
  if (after === null) return [item, ...copy];
  const idx = after === undefined ? -1 : copy.findIndex((x) => x.id === after);
  if (idx === -1) return [...copy, item];
  copy.splice(idx + 1, 0, item);
  return copy;
}

function insertIdAt(list: string[], id: string, after: string | null | undefined): string[] {
  const copy = list.filter((x) => x !== id);
  if (after === null) return [id, ...copy];
  const idx = after === undefined ? -1 : copy.indexOf(after);
  if (idx === -1) return [...copy, id];
  copy.splice(idx + 1, 0, id);
  return copy;
}

function loadViews(db: Db, databaseId: string): ViewRow[] {
  return db.all<ViewRow>('SELECT * FROM views WHERE database_id = ? ORDER BY position, id', databaseId);
}

function saveViewConfig(db: Db, viewId: string, config: ViewConfig): void {
  db.run('UPDATE views SET config = ?, version = version + 1, updated_at = ? WHERE id = ?', JSON.stringify(config), Date.now(), viewId);
}

function allRows(db: Db, databaseId: string): Array<{ id: string; properties: Record<string, PropertyValue> }> {
  return db
    .all<{ id: string; properties: string }>("SELECT id, properties FROM pages WHERE parent_type = 'database' AND parent_id = ?", databaseId)
    .map((r) => ({ id: r.id, properties: parseJson<Record<string, PropertyValue>>(r.properties, {}) }));
}

/**
 * Internal write of a row's values (schema change, purge). With `actorId`, the change is theirs: the
 * property history (trigger history_props_on_update) records it under their name (QA-G6-07).
 */
function writeRow(db: Db, id: string, properties: Record<string, PropertyValue>, actorId: string | null): void {
  if (actorId) {
    db.run('UPDATE pages SET properties = ?, updated_at = ?, updated_by = ? WHERE id = ?', JSON.stringify(properties), Date.now(), actorId, id);
  } else {
    db.run('UPDATE pages SET properties = ? WHERE id = ?', JSON.stringify(properties), id);
  }
}

export function createProperty(
  db: Db,
  ctx: SchemaWriteCtx,
  input: PropertyInput & { type: PropertyType },
  after: string | null | undefined,
  twoWay?: TwoWayOptions,
): PropertyDef[] {
  const { properties } = loadSchema(db, ctx.databaseId);
  if (input.type === 'title') throw badRequest("Une base ne peut avoir qu'une propriété titre.");
  const id = input.id ?? shortId(6);
  if (id === 'title' || properties.some((p) => p.id === id)) throw badRequest('Cet identifiant de propriété existe déjà.');
  const name = input.name?.trim() || PROPERTY_TYPE_LABELS[input.type];
  const def = normalizeDef(
    db,
    {
      id,
      name,
      type: input.type,
      options: normalizeOptions(input.options, input.type),
      numberFormat: input.numberFormat,
      numberPrecision: input.numberPrecision ?? undefined,
      numberDisplay: input.numberDisplay ?? undefined,
      numberMax: input.numberMax ?? undefined,
      numberColor: input.numberColor ?? undefined,
      dateReminder: input.dateReminder ?? undefined,
      formula: input.formula,
      relation: input.relation,
      rollup: input.rollup,
      uniqueIdPrefix: input.uniqueIdPrefix,
    },
    { workspaceId: ctx.workspaceId, actorId: ctx.actorId, selfDatabaseId: ctx.databaseId },
  );
  const next = insertPropertyDef(db, ctx.databaseId, def, after);
  if (def.type === 'unique_id') numberExistingRows(db, ctx.databaseId, id, ctx.actorId);
  if (def.type === 'relation' && twoWay) {
    makeTwoWay(db, ctx, id, twoWay);
    return loadSchema(db, ctx.databaseId).properties;
  }
  return next;
}

/** Inserts a (normalized) definition into a schema and every view's property order. */
function insertPropertyDef(db: Db, databaseId: string, def: PropertyDef, after: string | null | undefined): PropertyDef[] {
  const { properties } = loadSchema(db, databaseId);
  const next = insertAt(properties, def, after);
  saveSchema(db, databaseId, next);
  for (const view of loadViews(db, databaseId)) {
    const config = parseJson<ViewConfig>(view.config, defaultViewConfig(view.type, next));
    const order = config.propertyOrder ?? [];
    config.propertyOrder = insertIdAt(order.length ? order : properties.map((p) => p.id), def.id, after);
    saveViewConfig(db, view.id, config);
  }
  return next;
}

function uniqueName(base: string, properties: PropertyDef[]): string {
  const names = new Set(properties.map((p) => p.name.toLocaleLowerCase('fr')));
  if (!names.has(base.toLocaleLowerCase('fr'))) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLocaleLowerCase('fr'))) return `${base} ${i}`;
}

function newPropertyId(properties: PropertyDef[]): string {
  for (;;) {
    const id = shortId(6);
    if (id !== 'title' && !properties.some((p) => p.id === id)) return id;
  }
}

export function moveProperty(db: Db, databaseId: string, propId: string, after: string | null | undefined): PropertyDef[] {
  const { properties } = loadSchema(db, databaseId);
  const def = properties.find((p) => p.id === propId);
  if (!def) throw notFound('Propriété introuvable.');
  const next = insertAt(properties, def, after);
  saveSchema(db, databaseId, next);
  return next;
}

/** Removes every reference to a property from a view configuration. */
export function cleanConfigForDeletedProperty(config: ViewConfig, propId: string): ViewConfig {
  const out: ViewConfig = { ...config };
  if (out.filter) out.filter = { ...out.filter, rules: out.filter.rules.filter((r) => r.propertyId !== propId) };
  out.sorts = (out.sorts ?? []).filter((s) => s.propertyId !== propId);
  if (out.groupBy === propId) {
    out.groupBy = null;
    out.hiddenGroups = [];
    out.collapsedGroups = [];
  }
  out.propertyOrder = (out.propertyOrder ?? []).filter((id) => id !== propId);
  out.hiddenProperties = (out.hiddenProperties ?? []).filter((id) => id !== propId);
  const { [propId]: _w, ...widths } = out.propertyWidths ?? {};
  out.propertyWidths = widths;
  const { [propId]: _c, ...calcs } = out.calculations ?? {};
  out.calculations = calcs;
  if (out.dateProperty === propId) out.dateProperty = null;
  if (out.dateEndProperty === propId) out.dateEndProperty = null;
  if (out.dependencyProperty === propId) out.dependencyProperty = null;
  if (out.filter?.groups) {
    out.filter = { ...out.filter, groups: out.filter.groups.map((g) => ({ ...g, rules: g.rules.filter((r) => r.propertyId !== propId) })) };
  }
  return cleanViewExtras(out, propId, null);
}

/** Chart axes, map, form questions and dashboard widgets referring to a deleted (newType null) or retyped property. */
function cleanViewExtras(config: ViewConfig, propId: string, newType: PropertyType | null): ViewConfig {
  const out: ViewConfig = { ...config };
  const NUMERIC: PropertyType[] = ['number', 'formula', 'rollup', 'unique_id'];
  const cleanChart = (c: ChartConfig | undefined): ChartConfig | undefined => {
    if (!c) return c;
    const next = { ...c };
    if (newType === null && next.xProperty === propId) next.xProperty = null;
    if (newType === null && next.seriesProperty === propId) next.seriesProperty = null;
    if (next.valueProperty === propId && (newType === null || !NUMERIC.includes(newType))) {
      next.valueProperty = null;
      next.aggregate = 'count';
    }
    return next;
  };
  const cleanRules = <T extends { rules: Array<{ propertyId: string }>; groups?: Array<{ rules: Array<{ propertyId: string }> }> }>(f: T): T => ({
    ...f,
    rules: f.rules.filter((r) => r.propertyId !== propId),
    ...(f.groups ? { groups: f.groups.map((g) => ({ ...g, rules: g.rules.filter((r) => r.propertyId !== propId) })) } : {}),
  });
  if (out.chart) out.chart = cleanChart(out.chart);
  if (out.placeProperty === propId && newType !== 'place') out.placeProperty = null;
  if (out.form && (newType === null || !FORM_QUESTION_TYPES.includes(newType))) {
    const removed = new Set(out.form.questions.filter((q) => q.propertyId === propId).map((q) => q.id));
    out.form = {
      ...out.form,
      questions: out.form.questions
        .filter((q) => !removed.has(q.id))
        .map((q) => (q.showIf && removed.has(q.showIf.questionId) ? { ...q, showIf: null } : q)),
    };
  }
  if (out.widgets) {
    out.widgets = out.widgets.map((w) => ({
      ...w,
      chart: cleanChart(w.chart),
      filter: w.filter ? cleanRules(w.filter) : w.filter,
      sorts: newType === null ? w.sorts?.filter((x) => x.propertyId !== propId) : w.sorts,
    }));
  }
  return out;
}

function cleanConfigForRetypedProperty(config: ViewConfig, propId: string, newType: PropertyType): ViewConfig {
  const out: ViewConfig = { ...config };
  if (out.filter) out.filter = { ...out.filter, rules: out.filter.rules.filter((r) => r.propertyId !== propId) };
  const { [propId]: _c, ...calcs } = out.calculations ?? {};
  out.calculations = calcs;
  if (out.groupBy === propId && !GROUPABLE_TYPES.includes(newType)) {
    out.groupBy = null;
    out.hiddenGroups = [];
    out.collapsedGroups = [];
  }
  if (out.groupBy === propId) {
    out.hiddenGroups = [];
    out.collapsedGroups = [];
  }
  if (!DATE_TYPES.includes(newType)) {
    if (out.dateProperty === propId) out.dateProperty = null;
    if (out.dateEndProperty === propId) out.dateEndProperty = null;
  }
  if (newType !== 'relation' && out.dependencyProperty === propId) out.dependencyProperty = null;
  if (out.filter?.groups) {
    out.filter = { ...out.filter, groups: out.filter.groups.map((g) => ({ ...g, rules: g.rules.filter((r) => r.propertyId !== propId) })) };
  }
  return cleanViewExtras(out, propId, newType);
}

export function deleteProperty(db: Db, ctx: SchemaWriteCtx, propId: string, mirror: 'delete' | 'keep' = 'keep'): PropertyDef[] {
  const { properties } = loadSchema(db, ctx.databaseId);
  const def = properties.find((p) => p.id === propId);
  if (!def) throw notFound('Propriété introuvable.');
  if (def.type === 'title') throw badRequest('La propriété titre ne peut pas être supprimée.');
  if (def.relation?.syncedPropertyId) removeTwoWay(db, ctx, propId, mirror);
  return deletePropertyRaw(db, ctx.databaseId, propId, ctx.actorId);
}

/** Removes a property from the schema, the rows and the view configurations (no relation logic). */
function deletePropertyRaw(db: Db, databaseId: string, propId: string, actorId: string): PropertyDef[] {
  const { properties } = loadSchema(db, databaseId);
  if (!properties.some((p) => p.id === propId)) return properties;
  const next = properties.filter((p) => p.id !== propId);
  saveSchema(db, databaseId, next);
  for (const row of allRows(db, databaseId)) {
    if (propId in row.properties) {
      delete row.properties[propId];
      writeRow(db, row.id, row.properties, actorId);
    }
  }
  for (const view of loadViews(db, databaseId)) {
    const config = parseJson<ViewConfig>(view.config, defaultViewConfig(view.type, next));
    saveViewConfig(db, view.id, cleanConfigForDeletedProperty(config, propId));
  }
  return next;
}

// --- type conversion --------------------------------------------------------

const TRUTHY = new Set(['oui', 'yes', 'true', 'vrai', '1', 'x', '✓', '✔', '☑']);

function optionName(def: PropertyDef, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return def.options?.find((o) => o.id === id)?.name ?? null;
}

/** Best-effort textual rendering of a stored value (null when nothing meaningful). */
function valueAsText(def: PropertyDef, v: PropertyValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  switch (def.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof v === 'string' && v !== '' ? v : null;
    case 'number':
      return typeof v === 'number' ? String(v) : null;
    case 'select':
    case 'status':
      return optionName(def, v);
    case 'multi_select': {
      if (!Array.isArray(v)) return null;
      const names = (v as string[]).map((id) => optionName(def, id)).filter((n): n is string => !!n);
      return names.length ? names.join(', ') : null;
    }
    case 'checkbox':
      return v === true ? 'Oui' : null;
    case 'date': {
      const d = v as DateValue;
      if (!d || typeof d !== 'object' || typeof d.start !== 'string') return null;
      return d.end ? `${d.start} → ${d.end}` : d.start;
    }
    case 'unique_id':
      return typeof v === 'number' ? (def.uniqueIdPrefix ? `${def.uniqueIdPrefix}-${v}` : String(v)) : null;
    case 'place': {
      const address = (v as Partial<PlaceValue>)?.address;
      return typeof address === 'string' && address.trim() ? address : null;
    }
    default:
      return null;
  }
}

/** Normalized page title used to match relation values by title. */
export const titleKey = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');

/**
 * "Titre (Dossier/Titre%20abc.md)" / "Titre (https://www.notion.so/…)" → "Titre" (exported page references).
 * Linear on any input (text values reach 100 000 characters): a match only starts at the beginning of
 * a whitespace run, and the file name part cannot contain "/".
 */
const stripPageRefs = (s: string): string =>
  s
    .replace(/(?<!\s)\s*\((?:[^()]*\/)?[^()/]*\.(?:md|csv)\)/gi, '')
    .replace(/(?<!\s)\s*\(https?:\/\/(?:www\.)?notion\.so\/[^)]*\)/gi, '');

/** Per title index: the most comma-separated pieces a title spans (bounds the search below). */
const maxPiecesCache = new WeakMap<ReadonlyMap<string, string>, number>();
function maxPieces(index: ReadonlyMap<string, string>): number {
  let n = maxPiecesCache.get(index);
  if (n === undefined) {
    n = 1;
    for (const key of index.keys()) n = Math.max(n, key.split(',').length);
    maxPiecesCache.set(index, n);
  }
  return n;
}

/**
 * Resolves a text listing page titles ("A, B, C") into ids, with `index` (title key → id). Titles may
 * contain commas: the longest matching run of comma-separated pieces wins. Unknown titles are skipped.
 */
export function resolveTitles(text: string, index: ReadonlyMap<string, string>): string[] {
  const clean = stripPageRefs(text);
  const whole = index.get(titleKey(clean));
  if (whole) return [whole];
  const parts = clean.split(',');
  // A run longer than the longest title (in pieces) cannot match: keeps this linear in the text.
  const span = maxPieces(index);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    let next = i + 1;
    for (let j = Math.min(parts.length, i + span); j > i; j--) {
      const id = index.get(titleKey(parts.slice(i, j).join(',')));
      if (id) {
        out.push(id);
        next = j;
        break;
      }
    }
    i = next;
  }
  return [...new Set(out)];
}

/** Title key → id of the live rows of a database (first row in position order wins). */
function titleIndex(db: Db, databaseId: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const r of db.all<{ id: string; title: string }>(
    `SELECT id, title FROM pages WHERE parent_type = 'database' AND parent_id = ? AND trashed_at IS NULL
       AND id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)
     ORDER BY position, id`,
    databaseId,
    databaseId,
  )) {
    const key = titleKey(r.title);
    if (key && !index.has(key)) index.set(key, r.id);
  }
  return index;
}

/** Conversion of any (textual) values into a relation: values matching titles of the target rows are linked. */
function relationFromText(
  db: Db,
  rows: Array<{ id: string; properties: Record<string, PropertyValue> }>,
  oldDef: PropertyDef,
  newDef: PropertyDef,
): Map<string, PropertyValue | undefined> {
  const result = new Map<string, PropertyValue | undefined>();
  const target = newDef.relation?.databaseId;
  const index = target ? titleIndex(db, target) : new Map<string, string>();
  for (const row of rows) {
    const v = row.properties[oldDef.id];
    if (v === undefined || v === null) continue;
    const text = valueAsText(oldDef, v);
    let ids = text ? resolveTitles(text, index) : [];
    if (newDef.relation?.singlePage && ids.length > 1) ids = [ids[ids.length - 1]!];
    result.set(row.id, ids.length ? ids : undefined);
  }
  return result;
}

/**
 * Relation values rendered as the titles of the related pages ("A, B"), for conversions to other types.
 * Only rows of the relation's target database the actor can see are resolved: a stored id never
 * reveals the title of a page of another workspace or of someone else's private database.
 */
function relationAsText(
  db: Db,
  ctx: SchemaWriteCtx,
  rows: Array<{ id: string; properties: Record<string, PropertyValue> }>,
  def: PropertyDef,
): Array<{ id: string; properties: Record<string, PropertyValue> }> {
  const propId = def.id;
  const target = def.relation?.databaseId ?? '';
  const role = roleOf(db, ctx.actorId, ctx.workspaceId);
  const ids = new Set<string>();
  for (const r of rows) for (const id of idList(r.properties[propId])) ids.add(id);
  const titles = new Map<string, string>();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const p of db.all<Pick<PageRow, 'id' | 'title' | 'visibility' | 'owner_id' | 'teamspace_id'>>(
      `SELECT id, title, visibility, owner_id, teamspace_id FROM pages WHERE id IN (${chunk.map(() => '?').join(',')})
         AND parent_type = 'database' AND parent_id = ? AND workspace_id = ?`,
      ...chunk,
      target,
      ctx.workspaceId,
    )) {
      if (canSeePage(ctx.actorId, role, p, db)) titles.set(p.id, p.title.trim() || 'Sans titre');
    }
  }
  return rows.map((r) => {
    const names = idList(r.properties[propId])
      .map((id) => titles.get(id))
      .filter((t): t is string => !!t);
    return { id: r.id, properties: names.length ? { [propId]: names.join(', ') } : {} };
  });
}

function parseNumber(s: string): number | null {
  const cleaned = s.replace(/[\s  €$%]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Converts every row value of `oldDef` into `newDef` (may extend newDef.options). */
function convertRows(
  rows: Array<{ id: string; properties: Record<string, PropertyValue> }>,
  oldDef: PropertyDef,
  newDef: PropertyDef,
): Map<string, PropertyValue | undefined> {
  const result = new Map<string, PropertyValue | undefined>();
  const from = oldDef.type;
  const to = newDef.type;
  const options = newDef.options ?? [];
  const byName = new Map(options.map((o) => [o.name.trim().toLowerCase(), o] as const));
  const optionFor = (name: string): string => {
    const key = name.trim().toLowerCase();
    let opt = byName.get(key);
    if (!opt) {
      opt = { id: shortId(6), name: name.trim(), color: 'default' };
      if (to === 'status') opt.group = 'todo';
      options.push(opt);
      byName.set(key, opt);
    }
    return opt.id;
  };
  const knownIds = new Set(options.map((o) => o.id));

  for (const row of rows) {
    const v = row.properties[oldDef.id];
    if (v === undefined || v === null) continue;
    let out: PropertyValue | undefined;
    if (isComputed(to)) {
      out = undefined;
    } else if (TEXT_TYPES.includes(to)) {
      out = valueAsText(oldDef, v) ?? undefined;
    } else if (to === 'number') {
      if (from === 'number' || from === 'unique_id') out = typeof v === 'number' ? v : undefined;
      else if (TEXT_TYPES.includes(from) && typeof v === 'string') out = parseNumber(v) ?? undefined;
    } else if (to === 'select' || to === 'status') {
      if ((from === 'select' || from === 'status') && typeof v === 'string') out = knownIds.has(v) ? v : undefined;
      else if (from === 'multi_select' && Array.isArray(v)) out = (v as string[]).find((id) => knownIds.has(id));
      else if (TEXT_TYPES.includes(from) || from === 'number') {
        const text = valueAsText(oldDef, v);
        out = text ? optionFor(text) : undefined;
      }
    } else if (to === 'multi_select') {
      if ((from === 'select' || from === 'status') && typeof v === 'string') out = knownIds.has(v) ? [v] : undefined;
      else if (from === 'multi_select' && Array.isArray(v)) out = (v as string[]).filter((id) => knownIds.has(id));
      else if (TEXT_TYPES.includes(from) || from === 'number') {
        const text = valueAsText(oldDef, v);
        const names = text ? text.split(',').map((s) => s.trim()).filter(Boolean) : [];
        out = names.length ? [...new Set(names.map(optionFor))] : undefined;
      }
      if (Array.isArray(out) && out.length === 0) out = undefined;
    } else if (to === 'checkbox') {
      if (from === 'checkbox') out = v === true;
      else if (TEXT_TYPES.includes(from) && typeof v === 'string') out = TRUTHY.has(v.trim().toLowerCase());
    } else if (to === 'date') {
      if (from === 'date') out = v;
      else if (TEXT_TYPES.includes(from) && typeof v === 'string' && isDateString(v.trim())) out = { start: v.trim() };
    } else if (to === 'place') {
      // Text → address without coordinates (placed on a map once geocoded from the cell).
      const text = valueAsText(oldDef, v)?.trim().slice(0, 500);
      out = text ? { address: text } : undefined;
    } else if (to === from) {
      out = v;
    }
    result.set(row.id, out);
  }
  if (OPTION_TYPES.includes(to)) newDef.options = options;
  else delete newDef.options;
  return result;
}

export function updateProperty(
  db: Db,
  ctx: SchemaWriteCtx,
  propId: string,
  patch: PropertyInput & { twoWay?: TwoWayOptions | null },
): PropertyDef[] {
  let { properties } = loadSchema(db, ctx.databaseId);
  let idx = properties.findIndex((p) => p.id === propId);
  let oldDef = properties[idx];
  if (!oldDef) throw notFound('Propriété introuvable.');
  const newType = patch.type ?? oldDef.type;
  const targetChanged =
    oldDef.type === 'relation' && (newType !== 'relation' || (!!patch.relation && patch.relation.databaseId !== oldDef.relation?.databaseId));
  if (oldDef.relation?.syncedPropertyId && (targetChanged || patch.twoWay === null)) {
    // Leaving the two-way relation: the mirror is deleted when explicitly turned off, else kept one-way.
    removeTwoWay(db, ctx, propId, patch.twoWay === null && !targetChanged ? 'delete' : 'keep');
    ({ properties } = loadSchema(db, ctx.databaseId));
    idx = properties.findIndex((p) => p.id === propId);
    oldDef = properties[idx]!;
  }
  if (oldDef.type === 'title' && newType !== 'title') throw badRequest('Le type de la propriété titre ne peut pas être modifié.');
  if (oldDef.type !== 'title' && newType === 'title') throw badRequest("Une base ne peut avoir qu'une propriété titre.");

  const typeChanged = newType !== oldDef.type;
  let options: SelectOption[] | undefined;
  if (patch.options !== undefined) options = normalizeOptions(patch.options, newType);
  else if (OPTION_TYPES.includes(newType) && OPTION_TYPES.includes(oldDef.type)) {
    options = (oldDef.options ?? []).map((o) => ({ ...o }));
  }
  const draft: PropertyDef = {
    id: oldDef.id,
    name: patch.name !== undefined ? patch.name.trim() || oldDef.name : oldDef.name,
    type: newType,
    options,
    numberFormat: patch.numberFormat ?? oldDef.numberFormat,
    numberPrecision: patch.numberPrecision === null ? undefined : (patch.numberPrecision ?? oldDef.numberPrecision),
    numberDisplay: patch.numberDisplay === null ? undefined : (patch.numberDisplay ?? oldDef.numberDisplay),
    numberMax: patch.numberMax === null ? undefined : (patch.numberMax ?? oldDef.numberMax),
    numberColor: patch.numberColor === null ? undefined : (patch.numberColor ?? oldDef.numberColor),
    dateReminder: patch.dateReminder === null ? undefined : (patch.dateReminder ?? oldDef.dateReminder),
    formula: patch.formula ?? oldDef.formula,
    relation: patch.relation ? { ...oldDef.relation, ...patch.relation } : oldDef.relation,
    rollup: patch.rollup ?? oldDef.rollup,
    uniqueIdPrefix: patch.uniqueIdPrefix ?? oldDef.uniqueIdPrefix,
    // Per-property permissions (D30) are only changed by PUT …/access, never by this patch. Page
    // metadata types take none (QA-G3-04): their value is on every page.
    access: PAGE_METADATA_PROPERTY_TYPES.includes(newType) ? undefined : oldDef.access,
  };
  if (patch.uniqueIdPrefix === '') delete draft.uniqueIdPrefix;
  const newDef = normalizeDef(db, draft, {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    selfDatabaseId: ctx.databaseId,
    previousTarget: oldDef.type === 'relation' ? oldDef.relation?.databaseId : undefined,
  });
  if (newDef.relation && oldDef.relation?.syncedPropertyId && newDef.relation.databaseId === oldDef.relation.databaseId) {
    newDef.relation.syncedPropertyId = oldDef.relation.syncedPropertyId;
  }
  const becameSingle = newType === 'relation' && !!newDef.relation?.singlePage && !(oldDef.type === 'relation' && oldDef.relation?.singlePage);

  const rows = allRows(db, ctx.databaseId);
  const writeConverted = (converted: Map<string, PropertyValue | undefined>) => {
    for (const row of rows) {
      if (!converted.has(row.id)) continue;
      const value = converted.get(row.id);
      if (value === undefined) delete row.properties[propId];
      else row.properties[propId] = value;
      writeRow(db, row.id, row.properties, ctx.actorId);
    }
  };

  if (typeChanged) {
    if (newType === 'relation') writeConverted(relationFromText(db, rows, oldDef, newDef));
    else if (oldDef.type === 'relation') writeConverted(convertRows(relationAsText(db, ctx, rows, oldDef), { ...oldDef, type: 'text' }, newDef));
    else writeConverted(convertRows(rows, oldDef, newDef));
  } else if (OPTION_TYPES.includes(newType) && patch.options !== undefined) {
    // Removed options disappear from the rows.
    const known = new Set((newDef.options ?? []).map((o) => o.id));
    const converted = new Map<string, PropertyValue | undefined>();
    for (const row of rows) {
      const v = row.properties[propId];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        const kept = (v as string[]).filter((id) => known.has(id));
        if (kept.length !== v.length) converted.set(row.id, kept.length ? kept : undefined);
      } else if (typeof v === 'string' && !known.has(v)) {
        converted.set(row.id, undefined);
      }
    }
    writeConverted(converted);
  } else if (newType === 'relation' && oldDef.relation?.databaseId !== newDef.relation?.databaseId) {
    writeConverted(new Map(rows.filter((r) => propId in r.properties).map((r) => [r.id, undefined] as const)));
  }

  // A rename rewrites the prop("…") of the formulas citing the property, in the same transaction: the
  // interface, the API and the MCP share this path (the patch's own formula included).
  // I2: also the current.prop("…") of this database and of the other databases of the workspace (added to ctx.touched).
  const next = renameFormulaReferencesInWorkspace(
    db,
    ctx,
    properties.map((p, i) => (i === idx ? newDef : p)),
    propId,
    oldDef.name,
  );
  saveSchema(db, ctx.databaseId, next);
  if (typeChanged) {
    for (const view of loadViews(db, ctx.databaseId)) {
      const config = parseJson<ViewConfig>(view.config, defaultViewConfig(view.type, next));
      saveViewConfig(db, view.id, cleanConfigForRetypedProperty(config, propId, newType));
    }
    if (newType === 'unique_id') numberExistingRows(db, ctx.databaseId, propId, ctx.actorId);
  }
  if (becameSingle) truncateToSinglePage(db, ctx, propId);
  if (newType === 'relation' && patch.twoWay && !newDef.relation?.syncedPropertyId) makeTwoWay(db, ctx, propId, patch.twoWay);
  return loadSchema(db, ctx.databaseId).properties;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function completeConfig(type: ViewType, properties: PropertyDef[], partial: Partial<ViewConfig> | undefined, base?: ViewConfig): ViewConfig {
  const defaults = defaultViewConfig(type, properties);
  const merged: ViewConfig = { ...defaults, ...(base ?? {}) };
  for (const [k, v] of Object.entries(partial ?? {})) {
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/** A form view open to anonymous visitors (`form.isPublic`): an anonymous write path (routes/forms.ts). */
export function isPublicForm(type: ViewType, config: Partial<ViewConfig> | null | undefined): boolean {
  return type === 'form' && config?.form?.isPublic === true;
}

/**
 * Config of a copied view (view duplicated, linked block copied with its page): a public form is copied
 * as a members-only form. Opening a form to anonymous visitors stays an explicit act (QA-VIEW-01).
 */
export function withPrivateForm(config: ViewConfig): ViewConfig {
  return config.form?.isPublic ? { ...config, form: { ...config.form, isPublic: false } } : config;
}

/** Views of the same group: native views (linkId null) or the views of one linked block. */
export function viewSiblings(db: Db, databaseId: string, linkId: string | null = null): Array<{ id: string; position: string }> {
  return linkId
    ? db.all<{ id: string; position: string }>('SELECT id, position FROM views WHERE database_id = ? AND link_id = ?', databaseId, linkId)
    : db.all<{ id: string; position: string }>('SELECT id, position FROM views WHERE database_id = ? AND link_id IS NULL', databaseId);
}

export type LinkedViewRow = ViewRow & { link_id: string | null };

export function toLinkedView(r: ViewRow): ReturnType<typeof toView> {
  return { ...toView(r), linkId: (r as LinkedViewRow).link_id ?? null };
}

/** Views of a database (native) or of a linked block, ordered by position. */
export function listViews(db: Db, databaseId: string, linkId: string | null = null): ViewRow[] {
  return linkId
    ? db.all<ViewRow>('SELECT * FROM views WHERE database_id = ? AND link_id = ? ORDER BY position, id', databaseId, linkId)
    : db.all<ViewRow>('SELECT * FROM views WHERE database_id = ? AND link_id IS NULL ORDER BY position, id', databaseId);
}

export function getViewRow(db: Db, viewId: string): ViewRow | undefined {
  return db.get<ViewRow>('SELECT * FROM views WHERE id = ?', viewId);
}

export function insertView(
  db: Db,
  databaseId: string,
  view: { id?: string; name: string; type: ViewType; position: string; config: ViewConfig; linkId?: string | null },
): ViewRow {
  const now = Date.now();
  const id = view.id ?? newId();
  db.run(
    'INSERT INTO views (id, database_id, name, type, position, config, version, created_at, updated_at, link_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    id,
    databaseId,
    view.name,
    view.type,
    view.position,
    JSON.stringify(view.config),
    now,
    now,
    view.linkId ?? null,
  );
  return getViewRow(db, id)!;
}

/** Views of a linked block; a default table view is created on first open. */
export function ensureLinkedViews(db: Db, databaseId: string, linkId: string): ViewRow[] {
  return db.tx(() => {
    const existing = listViews(db, databaseId, linkId);
    if (existing.length > 0) return existing;
    const props = loadSchema(db, databaseId).properties;
    insertView(db, databaseId, {
      name: VIEW_TYPE_LABELS.table,
      type: 'table',
      position: positionForInsert([], undefined),
      config: defaultViewConfig('table', props),
      linkId,
    });
    return listViews(db, databaseId, linkId);
  });
}

/**
 * Users referenced by rows (creator, last editor, person values) for display. Only current members of
 * the workspace come with their e-mail: former members (or any other referenced id) keep their name and
 * avatar but get an empty e-mail (QA-DB-10). `hideEmails` (public pages) hides every e-mail.
 */
export function rowsUsers(db: Db, rows: PageRow[], schema: PropertyDef[], opts: { hideEmails?: boolean } = {}) {
  const ids = new Set<string>();
  const personProps = schema.filter((p) => p.type === 'person').map((p) => p.id);
  for (const r of rows) {
    ids.add(r.created_by);
    ids.add(r.updated_by);
    const props = parseJson<Record<string, PropertyValue>>(r.properties, {});
    for (const pid of personProps) {
      const v = props[pid];
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'string') ids.add(id);
    }
  }
  if (ids.size === 0) return [];
  const list = [...ids];
  const workspaceId = rows[0]!.workspace_id; // rows of one database: one workspace
  const users: Array<UserRow & { is_member: number }> = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    users.push(
      ...db.all<UserRow & { is_member: number }>(
        `SELECT u.*, EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ? AND m.user_id = u.id) AS is_member
         FROM users u WHERE u.id IN (${chunk.map(() => '?').join(',')})`,
        workspaceId,
        ...chunk,
      ),
    );
  }
  return users.map((u) => {
    const pu = toPublicUser(u);
    return opts.hideEmails || !u.is_member ? { ...pu, email: '' } : pu;
  });
}

// ---------------------------------------------------------------------------
// Two-way relations
// ---------------------------------------------------------------------------
//
// A two-way relation is a pair of relation properties A (database S → T) and B (T → S) pointing at
// each other through `relation.syncedPropertyId`. Invariant (for live rows): t ∈ r.A ⇔ r ∈ t.B.
// Every write on one side is mirrored on the other inside the same transaction. Trashed rows keep
// their own values but are removed from the live rows' mirror lists (and put back on restore).
// Row templates are not live rows: their values are never mirrored (a row created from a template
// is), and they never appear in another row's mirror list. A link is only added to rows the actor
// can see (a private database cannot be written through a relation); unlinking always applies.

type RowProps = Record<string, PropertyValue>;

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface TwoWayPair {
  prop: PropertyDef;
  mirror: PropertyDef;
  target: string;
}

interface RowEntry {
  row: PageRow;
  props: RowProps;
  dirty: boolean;
}

/** Applies mirror updates through a row cache; `flush()` writes the modified rows. */
class RelationSync {
  private readonly rows = new Map<string, RowEntry | null>();
  private readonly schemas = new Map<string, PropertyDef[]>();
  private readonly reverse = new Map<string, Map<string, string[]>>();
  private readonly templates = new Map<string, boolean>();
  private readonly roles = new Map<string, WorkspaceRole | null>();

  constructor(
    private readonly db: Db,
    private readonly actorId: string,
    /** Rows never modified (e.g. rows being trashed together). */
    private readonly frozen: ReadonlySet<string> = new Set(),
  ) {}

  /** Row templates are kept out of two-way relations. */
  isTemplate(id: string): boolean {
    let t = this.templates.get(id);
    if (t === undefined) {
      t = !!this.db.get('SELECT 1 AS x FROM database_templates WHERE page_id = ?', id);
      this.templates.set(id, t);
    }
    return t;
  }

  private visible(row: PageRow): boolean {
    let role = this.roles.get(row.workspace_id);
    if (role === undefined) {
      role = roleOf(this.db, this.actorId, row.workspace_id);
      this.roles.set(row.workspace_id, role);
    }
    return canSeePage(this.actorId, role, row, this.db);
  }

  schema(databaseId: string): PropertyDef[] {
    let s = this.schemas.get(databaseId);
    if (!s) {
      const row = this.db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', databaseId);
      s = row ? parseJson<PropertyDef[]>(row.properties, []) : [];
      this.schemas.set(databaseId, s);
    }
    return s;
  }

  entry(id: string): RowEntry | null {
    if (this.rows.has(id)) return this.rows.get(id)!;
    const row = getPageRow(this.db, id);
    const e = row ? { row, props: parseJson<RowProps>(row.properties, {}), dirty: false } : null;
    this.rows.set(id, e);
    return e;
  }

  /** Two-way relation properties of a database with their (consistent) mirror. */
  pairs(databaseId: string): TwoWayPair[] {
    const out: TwoWayPair[] = [];
    for (const prop of this.schema(databaseId)) {
      const synced = prop.type === 'relation' ? prop.relation?.syncedPropertyId : undefined;
      if (!synced || !prop.relation) continue;
      const target = prop.relation.databaseId;
      const mirror = this.schema(target).find(
        (m) => m.id === synced && m.type === 'relation' && m.relation?.databaseId === databaseId && m.relation?.syncedPropertyId === prop.id,
      );
      if (mirror) out.push({ prop, mirror, target });
    }
    return out;
  }

  private set(e: RowEntry, propId: string, list: string[]) {
    if (list.length > 0) e.props[propId] = list;
    else delete e.props[propId];
    e.dirty = true;
  }

  /**
   * « Cette page » (I1): a row inside the content of a row template (e.g. a task of an inline database of
   * the template) may point at that template. The link is never mirrored; instantiating the template
   * turns it into a link to the new row (duplicatePage remaps the copied ids).
   */
  selfRef(sourceId: string, targetId: string, targetDb: string): boolean {
    if (!this.isTemplate(targetId)) return false;
    const t = this.entry(targetId);
    if (!t || t.row.parent_type !== 'database' || t.row.parent_id !== targetDb || t.row.trashed_at !== null) return false;
    return pageChain(this.db, sourceId).some((p) => p.id === targetId);
  }

  /**
   * Ensures `sourceId` is listed in `targetId`'s `mirror`. Returns false when the target cannot hold
   * the link (not a live, visible, non-template row of `targetDb`).
   */
  link(targetId: string, targetDb: string, mirror: PropertyDef, sourceId: string, sourceProp: PropertyDef): boolean {
    if (this.frozen.has(targetId)) return true;
    if (this.selfRef(sourceId, targetId, targetDb)) return true;
    if (!this.accepts(targetId, targetDb)) return false;
    const t = this.entry(targetId)!;
    if (this.isTemplate(sourceId)) return true;
    const list = idList(t.props[mirror.id]);
    if (list.includes(sourceId)) return true;
    if (mirror.relation?.singlePage) {
      // The mirror holds one page: the previous one loses its link to the target.
      for (const prev of list) this.unlink(prev, sourceProp, targetId);
      this.set(t, mirror.id, [sourceId]);
    } else {
      this.set(t, mirror.id, [...list, sourceId]);
    }
    return true;
  }

  /** Removes `sourceId` from `targetId`'s `mirror`. */
  unlink(targetId: string, mirror: PropertyDef, sourceId: string): void {
    if (this.frozen.has(targetId)) return;
    const t = this.entry(targetId);
    if (!t) return;
    const list = idList(t.props[mirror.id]);
    if (!list.includes(sourceId)) return;
    this.set(
      t,
      mirror.id,
      list.filter((x) => x !== sourceId),
    );
  }

  /** True when `targetId` can hold a link: a live, visible, non-template row of `targetDb`. */
  accepts(targetId: string, targetDb: string): boolean {
    const t = this.entry(targetId);
    if (!t || t.row.parent_type !== 'database' || t.row.parent_id !== targetDb || t.row.trashed_at !== null) return false;
    return !this.isTemplate(targetId) && this.visible(t.row);
  }

  /** True when `targetId` is a trashed (non-template) row of `targetDb`: a latent link, back with its restore. */
  latent(targetId: string, targetDb: string): boolean {
    const t = this.entry(targetId);
    return !!t && t.row.parent_type === 'database' && t.row.parent_id === targetDb && t.row.trashed_at !== null && !this.isTemplate(targetId);
  }

  /** Removes `rejected` ids from a row's relation value. */
  drop(rowId: string, propId: string, rejected: ReadonlySet<string>): void {
    const e = this.entry(rowId);
    if (e) this.set(e, propId, idList(e.props[propId]).filter((x) => !rejected.has(x)));
  }

  /** Mirrors the change of a row's values (`before` → `after`). */
  applyRowChange(rowId: string, databaseId: string, before: RowProps, after: RowProps): void {
    if (this.isTemplate(rowId)) return;
    // A trashed row keeps its values without being listed by live rows (it is relinked on restore).
    const source = this.entry(rowId);
    const live = !source || source.row.trashed_at === null;
    const paired = new Set<string>();
    for (const { prop, mirror, target } of this.pairs(databaseId)) {
      paired.add(prop.id);
      const old = new Set(idList(before[prop.id]));
      const now = idList(after[prop.id]);
      const nowSet = new Set(now);
      const rejected = new Set<string>();
      for (const t of now) {
        if (old.has(t)) continue;
        if (live ? !this.link(t, target, mirror, rowId, prop) : !this.accepts(t, target) && !this.selfRef(rowId, t, target)) rejected.add(t);
      }
      for (const t of old) if (!nowSet.has(t)) this.unlink(t, mirror, rowId);
      // A two-way relation only gains pages that hold the link back (live rows of the target the actor can see).
      if (rejected.size > 0) this.drop(rowId, prop.id, rejected);
    }
    // One-way relations only gain live rows of their target database the actor can see (never ids of
    // other workspaces, plain pages or templates); ids already stored (latent links) are kept.
    for (const prop of this.schema(databaseId)) {
      if (prop.type !== 'relation' || !prop.relation || paired.has(prop.id)) continue;
      const target = prop.relation.databaseId;
      const old = new Set(idList(before[prop.id]));
      const rejected = new Set(idList(after[prop.id]).filter((t) => !old.has(t) && !this.accepts(t, target) && !this.selfRef(rowId, t, target)));
      if (rejected.size > 0) this.drop(rowId, prop.id, rejected);
    }
  }

  /** Live rows of `databaseId` listing each page in `propId` (index built once per property). */
  referencing(databaseId: string, propId: string): Map<string, string[]> {
    const key = `${databaseId}:${propId}`;
    let index = this.reverse.get(key);
    if (!index) {
      index = new Map();
      for (const r of this.db.all<{ id: string; properties: string }>(
        `SELECT id, properties FROM pages WHERE parent_type = 'database' AND parent_id = ? AND trashed_at IS NULL
           AND id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)`,
        databaseId,
        databaseId,
      )) {
        const cached = this.rows.get(r.id);
        const props = cached ? cached.props : parseJson<RowProps>(r.properties, {});
        for (const ref of idList(props[propId])) {
          const list = index.get(ref);
          if (list) list.push(r.id);
          else index.set(ref, [r.id]);
        }
      }
      this.reverse.set(key, index);
    }
    return index;
  }

  /** Writes the modified rows; returns them (fresh). */
  flush(): PageRow[] {
    const now = Date.now();
    const out: PageRow[] = [];
    for (const [id, e] of this.rows) {
      if (!e || !e.dirty) continue;
      this.db.run(
        'UPDATE pages SET properties = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?',
        JSON.stringify(e.props),
        now,
        this.actorId,
        id,
      );
      e.dirty = false;
      out.push(getPageRow(this.db, id)!);
    }
    return out;
  }
}

function rowChange(row: Pick<PageRow, 'id' | 'kind' | 'parent_type' | 'parent_id'>): Change {
  const isRow = row.parent_type === 'database';
  return {
    entity: 'page',
    id: row.id,
    kind: row.kind,
    parentType: row.parent_type,
    parentId: row.parent_id,
    databaseId: isRow ? row.parent_id : null,
    affectsTree: false,
  };
}

/** Publishes the invalidations of rows modified as a side effect (one database change past 50 rows). */
function publishRows(ctx: AppContext, rows: PageRow[], skipId?: string): void {
  const list = rows.filter((r) => r.id !== skipId);
  if (list.length > 50) {
    const dbs = new Set(list.filter((r) => r.parent_type === 'database').map((r) => r.parent_id));
    for (const id of dbs) publishDatabase(ctx, id);
    return;
  }
  for (const r of list) ctx.bus.publish(r.workspace_id, rowChange(r), pageAudience(ctx.db, r)); // QA-G7-04
}

export function publishDatabase(ctx: AppContext, databaseId: string): void {
  const page = getPageRow(ctx.db, databaseId);
  if (!page) return;
  ctx.bus.publish(page.workspace_id, { entity: 'database', id: page.id }, pageAudience(ctx.db, page)); // QA-G7-04
}

export interface TwoWayOptions {
  /** Name of the mirror created in the target database. */
  name?: string;
  /** Existing one-way relation of the target database (back to the source) to pair with instead. */
  pairWith?: string;
}

/**
 * Makes relation `propId` two-way: creates its mirror in the target database and fills it from the
 * current values, or pairs it with an existing relation of the target (`pairWith`, values merged).
 */
export function makeTwoWay(db: Db, ctx: SchemaWriteCtx, propId: string, opts: TwoWayOptions = {}): void {
  const source = loadSchema(db, ctx.databaseId).properties;
  const def = source.find((p) => p.id === propId);
  if (!def || def.type !== 'relation' || !def.relation) throw badRequest('Seule une relation peut être bidirectionnelle.');
  if (def.relation.syncedPropertyId) return;
  const target = def.relation.databaseId;
  const targetSchema = loadSchema(db, target).properties;
  const self = target === ctx.databaseId;
  let mirror: PropertyDef;
  if (opts.pairWith) {
    const existing = targetSchema.find((p) => p.id === opts.pairWith);
    if (
      !existing ||
      existing.id === propId ||
      existing.type !== 'relation' ||
      existing.relation?.databaseId !== ctx.databaseId ||
      existing.relation.syncedPropertyId
    ) {
      throw badRequest('Cette propriété ne peut pas servir de relation réciproque.');
    }
    // D30: pairing copies the values of `existing` into the new side and merges them back (QA-G3-05).
    const role = roleOf(db, ctx.actorId, ctx.workspaceId);
    if (!canReadProperty(role, existing)) throw badRequest('Cette propriété ne peut pas servir de relation réciproque.');
    if (!canEditProperty(role, existing)) throw forbidden(`Vous ne pouvez pas modifier la propriété « ${existing.name} ».`);
    mirror = { ...existing, relation: { ...existing.relation, syncedPropertyId: propId } };
    saveSchema(
      db,
      target,
      loadSchema(db, target).properties.map((p) => (p.id === mirror.id ? mirror : p)),
    );
  } else {
    const sourceTitle = getPageRow(db, ctx.databaseId)?.title.trim() || 'Sans titre';
    const base = opts.name?.trim() || (self ? `${def.name} (réciproque)` : sourceTitle);
    mirror = {
      id: newPropertyId(targetSchema),
      name: uniqueName(base.slice(0, 200), targetSchema),
      type: 'relation',
      relation: { databaseId: ctx.databaseId, syncedPropertyId: propId },
    };
    insertPropertyDef(db, target, mirror, self ? propId : undefined);
  }
  const linked: PropertyDef = { ...def, relation: { ...def.relation, syncedPropertyId: mirror.id } };
  saveSchema(
    db,
    ctx.databaseId,
    loadSchema(db, ctx.databaseId).properties.map((p) => (p.id === propId ? linked : p)),
  );
  const sync = new RelationSync(db, ctx.actorId);
  /** Mirrors the values of `prop` (rows of `from`) into `back` (rows of `to`). */
  const fill = (from: string, prop: PropertyDef, to: string, back: PropertyDef) => {
    for (const row of db.all<{ id: string }>("SELECT id FROM pages WHERE parent_type = 'database' AND parent_id = ? AND trashed_at IS NULL", from)) {
      if (sync.isTemplate(row.id)) continue;
      const list = idList(sync.entry(row.id)?.props[prop.id]);
      // Ids that can neither hold the link back nor come back from the trash are dropped.
      const rejected = new Set(list.filter((t) => !sync.link(t, to, back, row.id, prop) && !sync.latent(t, to)));
      if (rejected.size > 0) sync.drop(row.id, prop.id, rejected);
    }
  };
  fill(ctx.databaseId, linked, target, mirror);
  // Pairing: the existing values of the other side are merged too.
  if (opts.pairWith) fill(target, mirror, ctx.databaseId, linked);
  sync.flush();
  if (!self) ctx.touched?.add(target);
}

/** Unlinks a two-way relation: the mirror is deleted or becomes a one-way relation. */
export function removeTwoWay(db: Db, ctx: SchemaWriteCtx, propId: string, mode: 'delete' | 'keep'): void {
  const def = loadSchema(db, ctx.databaseId).properties.find((p) => p.id === propId);
  const synced = def?.relation?.syncedPropertyId;
  if (!def || !def.relation || !synced) return;
  const target = def.relation.databaseId;
  const unlinkDef = (databaseId: string, id: string) =>
    saveSchema(
      db,
      databaseId,
      loadSchema(db, databaseId).properties.map((p) => {
        if (p.id !== id || !p.relation) return p;
        const { syncedPropertyId: _s, ...relation } = p.relation;
        return { ...p, relation };
      }),
    );
  unlinkDef(ctx.databaseId, propId);
  let targetExists = true;
  try {
    loadSchema(db, target);
  } catch {
    targetExists = false;
  }
  if (targetExists && mode === 'delete' && target !== ctx.databaseId) {
    // The mirror of a database the actor cannot see (someone else's private database) is never
    // deleted through the relation: it only becomes a one-way relation.
    const page = getPageRow(db, target);
    if (!page || !canSeePage(ctx.actorId, roleOf(db, ctx.actorId, page.workspace_id), page, db)) mode = 'keep';
  }
  if (targetExists) {
    if (mode === 'delete') deletePropertyRaw(db, target, synced, ctx.actorId);
    else unlinkDef(target, synced);
    if (target !== ctx.databaseId) ctx.touched?.add(target);
  }
}

/** A relation just limited to one page: keep the last value of each row (mirrors updated). */
function truncateToSinglePage(db: Db, ctx: SchemaWriteCtx, propId: string): void {
  const sync = new RelationSync(db, ctx.actorId);
  for (const row of db.all<{ id: string; properties: string }>(
    "SELECT id, properties FROM pages WHERE parent_type = 'database' AND parent_id = ?",
    ctx.databaseId,
  )) {
    const props = parseJson<RowProps>(row.properties, {});
    const list = idList(props[propId]);
    if (list.length <= 1) continue;
    const e = sync.entry(row.id);
    if (!e) continue;
    const before = { ...e.props };
    e.props[propId] = [list[list.length - 1]!];
    e.dirty = true;
    sync.applyRowChange(row.id, ctx.databaseId, before, e.props);
  }
  for (const r of sync.flush()) if (r.parent_type === 'database' && r.parent_id !== ctx.databaseId) ctx.touched?.add(r.parent_id);
}

/**
 * After a row was created or its properties written: mirrors its two-way relation values and drops
 * the relation ids it cannot hold (see RelationSync.applyRowChange).
 */
export function syncRowRelations(ctx: AppContext, actorId: string, rowId: string, before: RowProps): void {
  const row = getPageRow(ctx.db, rowId);
  if (!row || row.parent_type !== 'database') return;
  const sync = new RelationSync(ctx.db, actorId);
  if (!sync.schema(row.parent_id).some((p) => p.type === 'relation')) return;
  sync.applyRowChange(row.id, row.parent_id, before, parseJson<RowProps>(row.properties, {}));
  publishRows(ctx, sync.flush(), row.id);
}

/** Rows (among `ids`) of databases having two-way relations. */
function rowsWithPairs(sync: RelationSync, ids: Iterable<string>): Array<{ entry: RowEntry; pairs: TwoWayPair[] }> {
  const out: Array<{ entry: RowEntry; pairs: TwoWayPair[] }> = [];
  for (const id of ids) {
    const e = sync.entry(id);
    if (!e || e.row.parent_type !== 'database') continue;
    const pairs = sync.pairs(e.row.parent_id);
    if (pairs.length > 0) out.push({ entry: e, pairs });
  }
  return out;
}

/** Pages just trashed: removed from the mirror lists of the live rows they relate to. */
export function relationsAfterTrash(ctx: AppContext, actorId: string, ids: string[]): void {
  const frozen = new Set(ids);
  const sync = new RelationSync(ctx.db, actorId, frozen);
  for (const { entry, pairs } of rowsWithPairs(sync, ids)) {
    for (const { prop, mirror } of pairs) for (const t of idList(entry.props[prop.id])) sync.unlink(t, mirror, entry.row.id);
  }
  publishRows(ctx, sync.flush());
}

/** Pages just restored: put back in the mirror lists, and re-linked from live rows that still list them. */
export function relationsAfterRestore(ctx: AppContext, actorId: string, ids: string[]): void {
  const restored = new Set(ids);
  const sync = new RelationSync(ctx.db, actorId);
  for (const { entry, pairs } of rowsWithPairs(sync, ids)) {
    if (entry.row.trashed_at !== null) continue;
    const id = entry.row.id;
    const databaseId = entry.row.parent_id;
    for (const { prop, mirror, target } of pairs) {
      for (const t of idList(entry.props[prop.id])) if (!restored.has(t)) sync.link(t, target, mirror, id, prop);
      for (const other of sync.referencing(target, mirror.id).get(id) ?? []) {
        if (!restored.has(other)) sync.link(id, databaseId, prop, other, mirror);
      }
    }
  }
  publishRows(ctx, sync.flush());
}

/** Before pages are deleted for good: their ids are removed from every relation value. */
export function relationsBeforeDelete(ctx: AppContext, ids: string[]): void {
  const { db } = ctx;
  if (ids.length === 0) return;
  const deleted = new Set(ids);
  const rowDbs = new Set<string>();
  const deletedDbs = new Set<string>();
  let workspaceId: string | null = null;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all<{ id: string; parent_type: string; parent_id: string; kind: string; workspace_id: string }>(
      `SELECT id, parent_type, parent_id, kind, workspace_id FROM pages WHERE id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    )) {
      workspaceId = r.workspace_id;
      if (r.parent_type === 'database') rowDbs.add(r.parent_id);
      if (r.kind === 'database') deletedDbs.add(r.id);
    }
  }
  if (!workspaceId || (rowDbs.size === 0 && deletedDbs.size === 0)) return;
  const touched = new Set<string>();
  for (const d of db.all<{ page_id: string; properties: string }>(
    'SELECT d.page_id, d.properties FROM databases d JOIN pages p ON p.id = d.page_id WHERE p.workspace_id = ?',
    workspaceId,
  )) {
    if (deleted.has(d.page_id)) continue;
    const schema = parseJson<PropertyDef[]>(d.properties, []);
    const relProps = schema.filter((p) => p.type === 'relation' && p.relation && rowDbs.has(p.relation.databaseId));
    // Relations to a database deleted for good lose their mirror link.
    if (schema.some((p) => p.relation?.syncedPropertyId && deletedDbs.has(p.relation.databaseId))) {
      saveSchema(
        db,
        d.page_id,
        schema.map((p) => {
          if (!p.relation?.syncedPropertyId || !deletedDbs.has(p.relation.databaseId)) return p;
          const { syncedPropertyId: _s, ...relation } = p.relation;
          return { ...p, relation };
        }),
      );
      touched.add(d.page_id);
    }
    if (relProps.length === 0) continue;
    for (const row of allRows(db, d.page_id)) {
      if (deleted.has(row.id)) continue;
      let changed = false;
      for (const p of relProps) {
        const list = idList(row.properties[p.id]);
        const kept = list.filter((x) => !deleted.has(x));
        if (kept.length === list.length) continue;
        changed = true;
        if (kept.length) row.properties[p.id] = kept;
        else delete row.properties[p.id];
      }
      if (changed) {
        writeRow(db, row.id, row.properties, null); // purge: no author, the rows keep their last editor
        touched.add(d.page_id);
      }
    }
  }
  for (const id of touched) publishDatabase(ctx, id);
}

export interface DuplicateHookOptions {
  /** Original id of the duplicated root. */
  rootId: string;
  /** The root copy is a row template (true), a regular row (false), or keeps the original's flag. */
  asTemplate?: boolean;
}

/**
 * After a subtree was duplicated (`idMap`: original → copy): copied databases keep two-way relations
 * only between copied databases, template flags are copied, and copied rows are mirrored.
 */
export function relationsAfterDuplicate(ctx: AppContext, actorId: string, idMap: Map<string, string>, opts: DuplicateHookOptions): void {
  const { db } = ctx;
  const copies = new Set(idMap.values());
  for (const [orig, copy] of idMap) {
    const schemaRow = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', copy);
    if (!schemaRow) continue;
    const schema = parseJson<PropertyDef[]>(schemaRow.properties, []);
    if (schema.some((p) => p.relation?.syncedPropertyId && !copies.has(p.relation.databaseId))) {
      saveSchema(
        db,
        copy,
        schema.map((p) => {
          if (!p.relation?.syncedPropertyId || copies.has(p.relation.databaseId)) return p;
          const { syncedPropertyId: _s, ...relation } = p.relation;
          return { ...p, relation };
        }),
      );
    }
    // Templates of a copied database stay templates (default included).
    for (const t of db.all<{ page_id: string; is_default: number }>('SELECT page_id, is_default FROM database_templates WHERE database_id = ?', orig)) {
      const tc = idMap.get(t.page_id);
      if (tc) db.run('INSERT OR IGNORE INTO database_templates (page_id, database_id, is_default, created_at) VALUES (?, ?, ?, ?)', tc, copy, t.is_default, Date.now());
    }
  }
  // The root row itself.
  const rootCopy = idMap.get(opts.rootId);
  const rootRow = rootCopy ? getPageRow(db, rootCopy) : undefined;
  if (rootCopy && rootRow && rootRow.parent_type === 'database') {
    const wasTemplate = !!db.get('SELECT 1 AS x FROM database_templates WHERE page_id = ?', opts.rootId);
    if (opts.asTemplate ?? wasTemplate) {
      db.run(
        'INSERT OR IGNORE INTO database_templates (page_id, database_id, is_default, created_at) VALUES (?, ?, 0, ?)',
        rootCopy,
        rootRow.parent_id,
        Date.now(),
      );
    }
  }
  const sync = new RelationSync(db, actorId);
  for (const copy of copies) {
    const e = sync.entry(copy);
    if (!e || e.row.parent_type !== 'database') continue;
    sync.applyRowChange(copy, e.row.parent_id, {}, { ...e.props });
  }
  publishRows(ctx, sync.flush());
  const linkedViews = relinkCopiedLinkedViews(db, actorId, [...copies]);
  // I1: copied views keep their manual order, and their filters (and default template) follow the copied
  // pages — a linked view of a template filtered on « cette page » shows the new row's pages.
  const viewPairs: Array<[string, string]> = [...linkedViews];
  for (const [orig, copy] of idMap) {
    const copied = db.all<ViewRow>('SELECT * FROM views WHERE database_id = ? AND link_id IS NULL', copy);
    if (copied.length === 0) continue;
    for (const v of db.all<ViewRow>('SELECT * FROM views WHERE database_id = ? AND link_id IS NULL', orig)) {
      const match = copied.find((c) => c.position === v.position && c.name === v.name && c.type === v.type);
      if (match) viewPairs.push([v.id, match.id]);
    }
  }
  for (const [from, to] of viewPairs) {
    copyViewRowOrder(db, from, to, idMap);
    remapViewConfigIds(db, to, idMap);
  }
}

/** Page ids inside a filter's rule values replaced through `idMap`. */
function remapFilterIds(filter: FilterGroup | null | undefined, idMap: ReadonlyMap<string, string>): FilterGroup | null | undefined {
  if (!filter) return filter;
  const value = (v: unknown): unknown =>
    typeof v === 'string' ? (idMap.get(v) ?? v) : Array.isArray(v) ? v.map(value) : v;
  return {
    ...filter,
    rules: filter.rules.map((r) => (r.value === undefined ? r : { ...r, value: value(r.value) })),
    ...(filter.groups ? { groups: filter.groups.map((g) => remapFilterIds(g, idMap) as FilterGroup) } : {}),
  };
}

/** A copied view: its filters, widget filters and default template follow the copied pages. */
function remapViewConfigIds(db: Db, viewId: string, idMap: ReadonlyMap<string, string>): void {
  const view = getViewRow(db, viewId);
  if (!view) return;
  const config = parseJson<ViewConfig | null>(view.config, null);
  if (!config) return;
  const next: ViewConfig = {
    ...config,
    filter: remapFilterIds(config.filter, idMap) ?? null,
    ...(config.widgets ? { widgets: config.widgets.map((w) => (w.filter ? { ...w, filter: remapFilterIds(w.filter, idMap) ?? null } : w)) } : {}),
    ...(config.defaultTemplateId && idMap.has(config.defaultTemplateId) ? { defaultTemplateId: idMap.get(config.defaultTemplateId)! } : {}),
  };
  const json = JSON.stringify(next);
  if (json !== view.config) db.run('UPDATE views SET config = ? WHERE id = ?', json, viewId);
}

const LINKED_MARKER = Buffer.from(EDITOR_TYPES.linkedDatabase);

/**
 * Copied page documents containing linked database blocks: each block gets a new link id and a
 * copy of its views, so that the copy's views evolve independently of the original's.
 */
function relinkCopiedLinkedViews(db: Db, actorId: string, pageIds: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const pageId of pageIds) {
    const stored = db.get<{ state: Uint8Array }>('SELECT state FROM documents WHERE page_id = ?', pageId);
    if (!stored || !Buffer.from(stored.state).includes(LINKED_MARKER)) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, stored.state);
      const found: Y.XmlElement[] = [];
      // Iterative: the document is client-controlled and may nest deeper than the call stack.
      const stack: unknown[] = doc.getXmlFragment(COLLAB_FRAGMENT).toArray().reverse();
      while (stack.length > 0) {
        const n = stack.pop();
        if (!(n instanceof Y.XmlElement)) continue;
        if (n.nodeName === EDITOR_TYPES.linkedDatabase) found.push(n);
        const children = n.toArray();
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
      if (found.length === 0) continue;
      doc.transact(() => {
        for (const el of found) {
          const linkId = el.getAttribute('linkId') as unknown;
          const databaseId = el.getAttribute('databaseId') as unknown;
          if (typeof linkId !== 'string' || !linkId || typeof databaseId !== 'string') continue;
          const next = newId();
          // Views are only copied inside a database of the same workspace the actor can see (the
          // document is client-controlled); otherwise the copied block starts with default views.
          const host = getPageRow(db, pageId);
          const target = getPageRow(db, databaseId);
          const sameWorkspace = !!host && !!target && target.kind === 'database' && target.workspace_id === host.workspace_id;
          const canCopy = sameWorkspace && canSeePage(actorId, roleOf(db, actorId, target!.workspace_id), target!, db);
          for (const v of canCopy ? listViews(db, databaseId, linkId) : []) {
            const created = insertView(db, databaseId, {
              name: v.name,
              type: v.type,
              position: v.position,
              config: withPrivateForm(parseJson<ViewConfig>(v.config, defaultViewConfig(v.type, []))),
              linkId: next,
            });
            pairs.push([v.id, created.id]);
          }
          el.setAttribute('linkId', next);
        }
      });
      db.run('UPDATE documents SET state = ? WHERE page_id = ?', Y.encodeStateAsUpdate(doc), pageId);
    } finally {
      doc.destroy();
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Row templates
// ---------------------------------------------------------------------------

export function isTemplate(db: Db, pageId: string): boolean {
  return !!db.get('SELECT 1 AS x FROM database_templates WHERE page_id = ?', pageId);
}

/**
 * Public exclusion (registerPublicExclusion, access.ts): row templates and everything under them stay
 * off the web, even in a published tree (QA-DB-11). Only rows can be templates: no query otherwise.
 */
export function chainHasTemplate(db: Db, chain: PageRow[]): boolean {
  const rows = chain.filter((p) => p.parent_type === 'database').map((p) => p.id);
  if (rows.length === 0) return false;
  return !!db.get(`SELECT 1 AS x FROM database_templates WHERE page_id IN (${rows.map(() => '?').join(',')}) LIMIT 1`, ...rows);
}

export function markTemplate(db: Db, pageId: string, databaseId: string): void {
  db.run('INSERT OR IGNORE INTO database_templates (page_id, database_id, is_default, created_at) VALUES (?, ?, 0, ?)', pageId, databaseId, Date.now());
}

export function templateRows(db: Db, databaseId: string): PageRow[] {
  return db.all<PageRow>(
    `SELECT ${PAGE_COLUMNS.split(',')
      .map((c) => `p.${c.trim()}`)
      .join(', ')} FROM pages p JOIN database_templates t ON t.page_id = p.id
     WHERE t.database_id = ? AND p.parent_type = 'database' AND p.parent_id = ? AND p.trashed_at IS NULL
     ORDER BY p.position, p.id`,
    databaseId,
    databaseId,
  );
}

export function defaultTemplateId(db: Db, databaseId: string): string | null {
  return (
    db.get<{ page_id: string }>(
      `SELECT t.page_id FROM database_templates t JOIN pages p ON p.id = t.page_id
       WHERE t.database_id = ? AND t.is_default = 1 AND p.trashed_at IS NULL`,
      databaseId,
    )?.page_id ?? null
  );
}

export function setDefaultTemplate(db: Db, databaseId: string, templateId: string | null): void {
  if (templateId && !db.get('SELECT 1 AS x FROM database_templates WHERE page_id = ? AND database_id = ?', templateId, databaseId)) {
    throw notFound('Modèle introuvable.');
  }
  db.run('UPDATE database_templates SET is_default = 0 WHERE database_id = ?', databaseId);
  if (templateId) db.run('UPDATE database_templates SET is_default = 1 WHERE page_id = ?', templateId);
}

// ---------------------------------------------------------------------------
// CSV import (bulk rows)
// ---------------------------------------------------------------------------

export function importRows(
  ctx: AppContext,
  actorId: string,
  dbPage: PageRow,
  rows: Array<{ title?: string; properties?: Record<string, unknown> }>,
  updateByTitle: boolean,
): { created: number; updated: number } {
  const { db } = ctx;
  return db.tx(() => {
    const schema = loadSchema(db, dbPage.id).properties;
    const existing = db.all<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM pages WHERE parent_type = 'database' AND parent_id = ? AND trashed_at IS NULL
         AND id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)
       ORDER BY position, id`,
      dbPage.id,
      dbPage.id,
    );
    const byTitle = new Map<string, PageRow>();
    if (updateByTitle) for (const r of existing) {
      const k = r.title.trim().toLocaleLowerCase('fr');
      if (k && !byTitle.has(k)) byTitle.set(k, r);
    }
    const last = db.get<{ p: string | null }>("SELECT MAX(position) AS p FROM pages WHERE parent_type = 'database' AND parent_id = ?", dbPage.id)?.p ?? null;
    const toCreate = rows.filter((r) => !(updateByTitle && byTitle.has((r.title ?? '').trim().toLocaleLowerCase('fr')) && (r.title ?? '').trim()));
    const positions = toCreate.length ? positionsBetween(last, null, toCreate.length) : [];
    let created = 0;
    let updated = 0;
    const now = Date.now();
    for (const input of rows) {
      const title = (input.title ?? '').slice(0, 2000);
      const match = updateByTitle && title.trim() ? byTitle.get(title.trim().toLocaleLowerCase('fr')) : undefined;
      if (match) {
        const before = parseJson<RowProps>(match.properties, {});
        const merged = mergePropertyValues(db, schema, before, input.properties ?? {}, dbPage.workspace_id, actorId);
        db.run(
          'UPDATE pages SET properties = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?',
          JSON.stringify(merged.properties),
          now,
          actorId,
          match.id,
        );
        syncRowRelations(ctx, actorId, match.id, before);
        syncPropertyReminders(db, actorId, { id: match.id, workspace_id: dbPage.workspace_id }, schema, before, merged.properties, now);
        updated++;
        continue;
      }
      const merged = mergePropertyValues(db, schema, {}, input.properties ?? {}, dbPage.workspace_id, actorId);
      const properties = merged.properties;
      assignUniqueIds(db, dbPage.id, schema, properties);
      const id = newId();
      db.run(
        `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, icon, cover, position, visibility, owner_id,
           properties, format, is_inline, is_public, created_at, created_by, updated_at, updated_by, version)
         VALUES (?, ?, 'database', ?, 'page', ?, NULL, NULL, ?, ?, ?, ?, '{}', 0, 0, ?, ?, ?, ?, 1)`,
        id,
        dbPage.workspace_id,
        dbPage.id,
        title,
        positions[created]!,
        dbPage.visibility,
        dbPage.visibility === 'private' ? dbPage.owner_id : actorId,
        JSON.stringify(properties),
        now,
        actorId,
        now,
        actorId,
      );
      indexPage(db, { id, workspace_id: dbPage.workspace_id, title }, '');
      syncRowRelations(ctx, actorId, id, {});
      syncPropertyReminders(db, actorId, { id, workspace_id: dbPage.workspace_id }, schema, {}, properties, now);
      created++;
    }
    publishDatabase(ctx, dbPage.id);
    return { created, updated };
  });
}
