// Databases for the MCP tools: schema loading, human-friendly property values (option names, people
// by name or e-mail, relations by row title, dates "YYYY-MM-DD"…) ⇄ stored values, readable row values
// (formulas and rollups computed with the web client's own logic), filters and sorts by property name.
import {
  COLORS,
  COMPUTED_PROPERTY_TYPES,
  shortId,
  type Color,
  type DatabaseResponse,
  type DatabaseSchema,
  type DateValue,
  type FileValue,
  type FilterOperator,
  type FilterQuantifier,
  type FilterRule,
  type Member,
  type Page,
  type PlaceValue,
  type PropertyDef,
  type PropertyValue,
  type PublicUser,
  type RowsResponse,
  type SelectOption,
  type SortRule,
} from '@oriel/shared';
import { createRowContext, getFormulaResult, getRollupResult, propertyKind, type RowContext, type ValueKind } from '../../web/src/database/logic/values';
import { isFormulaStructured } from '../../web/src/database/logic/formula';
import { deriveRows } from '../../web/src/database/logic/pipeline';
import { isDurationOperator, isMultiValueRollup, operatorsForKind, rollupItemKind, rollupItemProp } from '../../web/src/database/logic/filter';
import { asDuration } from '../../web/src/database/logic/dates';
import { formatUniqueId } from '../../web/src/database/logic/format';
import { asVerification, verificationText } from '../../web/src/database/row/verification';
import type { Oriel } from './oriel.js';
import { looseKey } from './oriel.js';
import { pageIdFrom } from './content/links.js';

export interface LoadedDatabase {
  info: DatabaseResponse;
  schema: DatabaseSchema;
  rows: Page[];
  users: PublicUser[];
}

export async function loadDatabase(oriel: Oriel, databaseId: string, withRows = true): Promise<LoadedDatabase> {
  const id = encodeURIComponent(databaseId);
  const [info, rows] = await Promise.all([
    oriel.client.get<DatabaseResponse>(`/databases/${id}`),
    withRows ? oriel.client.get<RowsResponse>(`/databases/${id}/rows`) : Promise.resolve({ rows: [], users: [] } as RowsResponse),
  ]);
  return { info, schema: info.schema, rows: rows.rows, users: rows.users };
}

/** A property by name (case/accent-insensitive) or id; error listing the available names. */
export function findProperty(schema: DatabaseSchema, ref: string): PropertyDef {
  const r = ref.trim();
  const found = schema.properties.find((p) => p.id === r) ?? schema.properties.find((p) => looseKey(p.name) === looseKey(r));
  if (!found) throw new Error(`Propriété « ${ref} » introuvable. Propriétés : ${schema.properties.map((p) => `« ${p.name} »`).join(', ')}.`);
  return found;
}

const isComputed = (def: PropertyDef) => COMPUTED_PROPERTY_TYPES.includes(def.type);

// ---------------------------------------------------------------------------
// Readable values
// ---------------------------------------------------------------------------

/** Row context with related databases loaded (relation titles, rollups). */
export async function rowContext(oriel: Oriel, db: LoadedDatabase): Promise<RowContext> {
  const relatedIds = new Set<string>();
  for (const p of db.schema.properties) if (p.type === 'relation' && p.relation?.databaseId) relatedIds.add(p.relation.databaseId);
  const related = new Map<string, LoadedDatabase>();
  related.set(db.schema.id, db);
  await Promise.all(
    [...relatedIds]
      .filter((id) => id !== db.schema.id)
      .map(async (id) => {
        try {
          related.set(id, await loadDatabase(oriel, id));
        } catch {
          /* related database inaccessible: titles unknown, rollups empty */
        }
      }),
  );
  const rowsById = new Map<string, Page>();
  const users = new Map<string, PublicUser>();
  for (const d of related.values()) {
    for (const r of d.rows) rowsById.set(r.id, r);
    for (const u of d.users) users.set(u.id, u);
  }
  const contexts = new Map<string, RowContext>();
  const contextOf = (id: string): RowContext | undefined => {
    const d = related.get(id);
    if (!d) return undefined;
    let c = contexts.get(id);
    if (!c) {
      c = createRowContext(d.schema.properties, {
        users: users.values(),
        relationTitle: (pid) => rowsById.get(pid)?.title,
        related: { row: (pid) => rowsById.get(pid), context: contextOf },
      });
      contexts.set(id, c);
    }
    return c;
  };
  return contextOf(db.schema.id)!;
}

const isoDate = (d: Date) => d.toISOString();

function dateText(v: DateValue | null | undefined): string | null {
  if (!v || typeof v !== 'object' || !v.start) return null;
  return v.end ? `${v.start} → ${v.end}` : v.start;
}

function formulaValue(v: unknown): unknown {
  if (v instanceof Date) return isoDate(v);
  // I2: lists, pages and people of structured formulas (titles and names, as for relations and people).
  if (isFormulaStructured(v)) {
    if (v.kind === 'list') return v.items.map(formulaValue);
    return v.kind === 'page' ? v.title : v.name;
  }
  return v;
}

/** Value of a property for Claude (option names, people names, relation titles, computed values). */
export function readableValue(row: Page, prop: PropertyDef, ctx: RowContext): unknown {
  const raw = prop.type === 'title' ? row.title : row.properties[prop.id];
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const option = (id: unknown) => prop.options?.find((o) => o.id === id)?.name;
  const userName = (id: string) => ctx.users.get(id)?.name ?? id;
  switch (prop.type) {
    case 'title':
      return row.title;
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof raw === 'string' && raw ? raw : null;
    case 'number':
      return typeof raw === 'number' ? raw : null;
    case 'checkbox':
      return raw === true;
    case 'select':
    case 'status':
      return (typeof raw === 'string' && option(raw)) || null;
    case 'multi_select': {
      const names = list(raw).map(option).filter((x): x is string => !!x);
      return names.length ? names : null;
    }
    case 'person': {
      const ids = list(raw);
      return ids.length ? ids.map(userName) : null;
    }
    case 'relation': {
      const ids = list(raw);
      return ids.length ? ids.map((id) => ({ id, titre: ctx.relationTitle(id) ?? null })) : null;
    }
    case 'date':
      return dateText(raw as DateValue | null);
    case 'files': {
      const files = Array.isArray(raw) ? (raw as FileValue[]) : [];
      return files.length ? files.map((f) => ({ nom: f.name, url: f.url })) : null;
    }
    case 'created_time':
      return isoDate(new Date(row.createdAt));
    case 'last_edited_time':
      return isoDate(new Date(row.updatedAt));
    case 'last_visited':
      // Navigation module: the token user's last visit of the row.
      return row.lastVisitedAt ? isoDate(new Date(row.lastVisitedAt)) : null;
    case 'created_by':
      return userName(row.createdBy);
    case 'last_edited_by':
      return userName(row.updatedBy);
    case 'unique_id':
      return typeof raw === 'number' ? formatUniqueId(raw, prop.uniqueIdPrefix) : null;
    case 'formula': {
      const r = getFormulaResult(row, prop, ctx);
      return r.error ? `#ERREUR : ${r.error}` : formulaValue(r.value);
    }
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      if (r.error) return `#ERREUR : ${r.error}`;
      if (r.type === 'number' || r.type === 'boolean') return r.value;
      return r.text ?? formulaValue(r.value);
    }
    case 'place': {
      const p = raw as Partial<PlaceValue> | null;
      if (!p || typeof p !== 'object' || typeof p.address !== 'string') return null;
      const located = typeof p.lat === 'number' && typeof p.lng === 'number';
      return located ? { adresse: p.address, lat: p.lat, lng: p.lng } : { adresse: p.address };
    }
    case 'verification': {
      // D21: state derived from the expiry, who verified and when.
      const v = asVerification(raw);
      if (!v) return null;
      return { etat: verificationText(v), par: userName(v.verifiedBy), le: v.verifiedAt.slice(0, 10), jusqu_au: v.expiresAt };
    }
  }
}

/** Readable properties of a row, keyed by property name (title excluded). */
export function readableProperties(row: Page, schema: DatabaseSchema, ctx: RowContext, only?: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schema.properties) {
    if (p.type === 'title') continue;
    if (only && !only.has(p.id)) continue;
    const v = readableValue(row, p, ctx);
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) out[p.name] = v;
  }
  return out;
}

/** Schema description for Claude. */
export function describeSchema(db: LoadedDatabase, titles: Map<string, string>): unknown {
  return db.schema.properties.map((p) => {
    const out: Record<string, unknown> = { id: p.id, nom: p.name, type: p.type };
    if (p.options) out.options = p.options.map((o) => (p.type === 'status' ? { nom: o.name, couleur: o.color, groupe: o.group } : { nom: o.name, couleur: o.color }));
    if (p.numberFormat) out.format = p.numberFormat;
    if (p.formula !== undefined) out.formule = p.formula;
    if (p.uniqueIdPrefix) out.prefixe = p.uniqueIdPrefix;
    if (p.relation) {
      out.relation = {
        baseId: p.relation.databaseId,
        base: titles.get(p.relation.databaseId) ?? null,
        bidirectionnelle: !!p.relation.syncedPropertyId,
        ...(p.relation.singlePage ? { unePageMax: true } : {}),
      };
    }
    if (p.rollup) {
      const rel = db.schema.properties.find((x) => x.id === p.rollup!.relationPropertyId);
      out.rollup = { relation: rel?.name ?? p.rollup.relationPropertyId, proprieteCible: p.rollup.targetPropertyId, fonction: p.rollup.function };
    }
    if (isComputed(p)) out.calculee = true;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Human-friendly input → stored values
// ---------------------------------------------------------------------------

/** Lazily loaded data needed to convert values (members, rows of related databases). */
export class ValueConverter {
  private members: Promise<Member[]> | null = null;
  private readonly relatedRows = new Map<string, Promise<Page[]>>();
  /** New select / multi-select options to add to the schema before writing, by property id. */
  readonly newOptions = new Map<string, SelectOption[]>();

  constructor(
    private readonly oriel: Oriel,
    readonly db: LoadedDatabase,
    private readonly currentUserId: string,
    private readonly opts: { createOptions: boolean } = { createOptions: true },
  ) {}

  private memberList(): Promise<Member[]> {
    this.members ??= this.oriel.members(this.db.schema.workspaceId);
    return this.members;
  }

  private rowsOf(databaseId: string): Promise<Page[]> {
    let p = this.relatedRows.get(databaseId);
    if (!p) {
      p =
        databaseId === this.db.schema.id
          ? Promise.resolve(this.db.rows)
          : this.oriel.client.get<RowsResponse>(`/databases/${encodeURIComponent(databaseId)}/rows`).then((r) => r.rows);
      this.relatedRows.set(databaseId, p);
    }
    return p;
  }

  private option(def: PropertyDef, name: string, allowCreate: boolean): string {
    const n = name.trim();
    const all = [...(def.options ?? []), ...(this.newOptions.get(def.id) ?? [])];
    const found = all.find((o) => o.id === n) ?? all.find((o) => looseKey(o.name) === looseKey(n));
    if (found) return found.id;
    if (!allowCreate || !this.opts.createOptions || !n) {
      throw new Error(`Option « ${name} » inconnue pour « ${def.name} ». Options : ${(def.options ?? []).map((o) => `« ${o.name} »`).join(', ') || 'aucune'}.`);
    }
    const used = new Set(all.map((o) => o.color));
    const color = (COLORS.filter((c) => c !== 'default').find((c) => !used.has(c)) ?? COLORS[(all.length % (COLORS.length - 1)) + 1]) as Color;
    const created: SelectOption = { id: shortId(6), name: n.slice(0, 200), color };
    this.newOptions.set(def.id, [...(this.newOptions.get(def.id) ?? []), created]);
    return created.id;
  }

  private async person(def: PropertyDef, ref: string): Promise<string> {
    const r = ref.trim();
    if (['moi', 'me', 'myself'].includes(looseKey(r))) return this.currentUserId;
    const find = (members: Member[]) => {
      const exact =
        members.find((m) => m.user.id === r) ??
        members.find((m) => m.user.email.toLowerCase() === r.toLowerCase()) ??
        members.find((m) => looseKey(m.user.name) === looseKey(r));
      if (exact) return exact;
      const byFirstName = members.filter((m) => looseKey(m.user.name).split(' ')[0] === looseKey(r));
      if (byFirstName.length > 1) throw new Error(`Plusieurs membres s'appellent « ${ref} » : précisez le nom complet ou l'e-mail (propriété « ${def.name} »).`);
      return byFirstName[0];
    };
    let found = find(await this.memberList());
    if (!found) {
      // The member may have joined since the list was cached.
      this.members = this.oriel.members(this.db.schema.workspaceId, { fresh: true });
      found = find(await this.members);
    }
    if (!found) throw new Error(`Personne « ${ref} » introuvable parmi les membres de l'espace (propriété « ${def.name} »).`);
    return found.user.id;
  }

  private async relation(def: PropertyDef, ref: string): Promise<string> {
    const target = def.relation?.databaseId;
    if (!target) throw new Error(`La relation « ${def.name} » n'a pas de base cible.`);
    const id = pageIdFrom(ref);
    const rows = await this.rowsOf(target);
    const byId = rows.find((r) => r.id === id);
    if (byId) return byId.id;
    const matches = rows.filter((r) => looseKey(r.title) === looseKey(ref));
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) throw new Error(`Plusieurs lignes s'appellent « ${ref} » dans la base liée par « ${def.name} » : utilisez leur id (${matches.map((m) => m.id).join(', ')}).`);
    throw new Error(`Aucune ligne « ${ref} » dans la base liée par « ${def.name} ».`);
  }

  /** One property value (human form) → stored value; null clears it. */
  async convert(def: PropertyDef, input: unknown): Promise<PropertyValue> {
    if (isComputed(def)) throw new Error(`La propriété « ${def.name} » est calculée (${def.type}) et ne peut pas être modifiée.`);
    if (input === null || input === undefined || input === '') return null;
    const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v]);
    switch (def.type) {
      case 'title':
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        if (typeof input === 'object') throw new Error(`Texte attendu pour « ${def.name} ».`);
        return String(input);
      case 'number': {
        const n = typeof input === 'number' ? input : Number(String(input).replace(/[\s €$%]/g, '').replace(',', '.'));
        if (!Number.isFinite(n)) throw new Error(`Nombre attendu pour « ${def.name} » (reçu « ${String(input)} »).`);
        return n;
      }
      case 'checkbox': {
        if (typeof input === 'boolean') return input;
        const s = looseKey(String(input));
        if (['true', 'oui', 'yes', '1', 'x', 'vrai', 'coche'].includes(s)) return true;
        if (['false', 'non', 'no', '0', 'faux', ''].includes(s)) return false;
        throw new Error(`Booléen attendu pour « ${def.name} » (true/false).`);
      }
      case 'select':
      case 'status': {
        const v = Array.isArray(input) ? input[0] : input;
        return this.option(def, String(v), def.type === 'select');
      }
      case 'multi_select':
        return [...new Set(asList(input).map((v) => this.option(def, String(v), true)))];
      case 'person':
        return [...new Set(await Promise.all(asList(input).map((v) => this.person(def, String(v)))))];
      case 'relation': {
        const ids = [...new Set(await Promise.all(asList(input).map((v) => this.relation(def, typeof v === 'object' && v && 'id' in v ? String((v as { id: unknown }).id) : String(v)))))];
        return ids;
      }
      case 'date':
        return parseDateInput(def, input);
      case 'files':
        return asList(input).map((f): FileValue => {
          if (typeof f === 'string') return { name: decodeURIComponent(f.split('/').pop() || 'fichier'), url: f };
          const o = f as { name?: unknown; nom?: unknown; url?: unknown };
          if (typeof o?.url !== 'string') throw new Error(`Fichier invalide pour « ${def.name} » : { name, url } attendu.`);
          return { name: String(o.name ?? o.nom ?? o.url.split('/').pop() ?? 'fichier'), url: o.url };
        });
      case 'place':
        return placeInput(def, input);
      default:
        throw new Error(`Type de propriété non pris en charge : ${def.type}.`);
    }
  }

  /**
   * `{ "Nom de propriété": valeur }` → `{ propertyId: storedValue }` (+ the title when given).
   * `deferSelfRelations`: relations to the database itself are returned apart, unconverted (they may
   * name rows created in the same batch).
   */
  async convertAll(
    input: Record<string, unknown>,
    opts: { deferSelfRelations?: boolean } = {},
  ): Promise<{ properties: Record<string, PropertyValue>; title?: string; deferred: Array<[PropertyDef, unknown]> }> {
    const properties: Record<string, PropertyValue> = {};
    const deferred: Array<[PropertyDef, unknown]> = [];
    let title: string | undefined;
    for (const [key, value] of Object.entries(input)) {
      const def = findProperty(this.db.schema, key);
      if (def.type === 'title') {
        title = value === null || value === undefined ? '' : String(value);
        continue;
      }
      if (opts.deferSelfRelations && def.type === 'relation' && def.relation?.databaseId === this.db.schema.id && value !== null && value !== undefined) {
        deferred.push([def, value]);
        continue;
      }
      properties[def.id] = await this.convert(def, value);
    }
    return title === undefined ? { properties, deferred } : { properties, title, deferred };
  }

  /** Rows created meanwhile (self relations of a batch can name them). */
  addRows(rows: Page[]): void {
    this.db.rows = [...this.db.rows, ...rows];
    this.relatedRows.delete(this.db.schema.id);
  }

  /** Adds the select options created while converting (one PATCH per property). Returns their names. */
  async flushOptions(): Promise<string[]> {
    const added: string[] = [];
    for (const [propId, options] of this.newOptions) {
      const def = this.db.schema.properties.find((p) => p.id === propId)!;
      const schema = await this.oriel.client.patch<DatabaseSchema>(
        `/databases/${encodeURIComponent(this.db.schema.id)}/properties/${encodeURIComponent(propId)}`,
        { options: [...(def.options ?? []), ...options] },
      );
      this.db.schema = schema;
      this.db.info = { ...this.db.info, schema };
      added.push(...options.map((o) => `${def.name} : ${o.name}`));
    }
    this.newOptions.clear();
    return added;
  }
}

/**
 * Place: an address (`"12 rue …"`) or `{ adresse | address, lat, lng }`. Coordinates are taken as
 * given (WGS 84, both or none); the MCP never geocodes (the server's geocoder is rate-limited and off
 * by default).
 */
function placeInput(def: PropertyDef, input: unknown): PlaceValue {
  const fail = () => new Error(`Lieu attendu pour « ${def.name} » : une adresse, ou { adresse, lat, lng }.`);
  if (typeof input === 'string') {
    const address = input.trim();
    if (!address || address.length > 500) throw fail();
    return { address };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  const o = input as { address?: unknown; adresse?: unknown; lat?: unknown; lng?: unknown; lon?: unknown };
  const address = String(o.adresse ?? o.address ?? '').trim();
  if (address.length > 500) throw fail();
  const lat = o.lat === undefined || o.lat === null || o.lat === '' ? undefined : Number(o.lat);
  const rawLng = o.lng ?? o.lon;
  const lng = rawLng === undefined || rawLng === null || rawLng === '' ? undefined : Number(rawLng);
  if ((lat === undefined) !== (lng === undefined)) throw new Error(`« ${def.name} » : indiquez lat et lng ensemble.`);
  if (lat === undefined || lng === undefined) {
    if (!address) throw fail();
    return { address };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`« ${def.name} » : coordonnées invalides (lat −90…90, lng −180…180).`);
  }
  return { address, lat, lng };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function toLocalDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function oneDate(def: PropertyDef, s: string): { value: string; time: boolean } {
  const t = s.trim();
  const k = looseKey(t);
  if (['aujourd hui', "aujourd'hui", 'today'].includes(k)) return { value: toLocalDay(0), time: false };
  if (['demain', 'tomorrow'].includes(k)) return { value: toLocalDay(1), time: false };
  if (['hier', 'yesterday'].includes(k)) return { value: toLocalDay(-1), time: false };
  if (DATE_ONLY.test(t)) return { value: t, time: false };
  if (DATE_TIME.test(t)) return { value: t.replace(' ', 'T'), time: true };
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (fr) return { value: `${fr[3]}-${fr[2]!.padStart(2, '0')}-${fr[1]!.padStart(2, '0')}`, time: false };
  throw new Error(`Date invalide pour « ${def.name} » : « ${s} » (format AAAA-MM-JJ, AAAA-MM-JJTHH:MM ou JJ/MM/AAAA).`);
}

export function parseDateInput(def: PropertyDef, input: unknown): DateValue {
  if (typeof input === 'object' && input && !Array.isArray(input)) {
    const o = input as { start?: unknown; end?: unknown; debut?: unknown; fin?: unknown; includeTime?: unknown };
    const start = oneDate(def, String(o.start ?? o.debut ?? ''));
    const endRaw = o.end ?? o.fin;
    const end = endRaw ? oneDate(def, String(endRaw)) : null;
    const includeTime = o.includeTime === true || start.time || !!end?.time;
    return { start: start.value, ...(end ? { end: end.value } : {}), ...(includeTime ? { includeTime: true } : {}) };
  }
  const s = String(input);
  const parts = s.split(/\s*(?:→|->|\/\/|\bau\b|\bto\b)\s*/i).filter(Boolean);
  const start = oneDate(def, parts[0] ?? s);
  const end = parts[1] ? oneDate(def, parts[1]) : null;
  const includeTime = start.time || !!end?.time;
  return { start: start.value, ...(end ? { end: end.value } : {}), ...(includeTime ? { includeTime: true } : {}) };
}

// ---------------------------------------------------------------------------
// Filters and sorts by property name
// ---------------------------------------------------------------------------

export const FILTER_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
  'gt',
  'lt',
  'gte',
  'lte',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'within',
  'checked',
  'unchecked',
  'contains_all',
  'within_last',
  'within_next',
  'exactly_ago',
  'exactly_ahead',
] as const satisfies readonly FilterOperator[];

export interface HumanFilter {
  property: string;
  operator: FilterOperator;
  value?: unknown;
  /** Rollup « show original » only: at least one value (any), all of them (every), none. */
  quantifier?: FilterQuantifier;
}

/** Closest valid operator for the kind (e.g. "contains" on a select means "equals"). */
function adaptOperator(op: FilterOperator, kind: ValueKind): FilterOperator {
  const valid = operatorsForKind(kind);
  if (valid.includes(op)) return op;
  const alias: Partial<Record<FilterOperator, FilterOperator>> =
    kind === 'select'
      ? { contains: 'equals', not_contains: 'not_equals' }
      : kind === 'multi' || kind === 'person' || kind === 'relation' || kind === 'files'
        ? { equals: 'contains', not_equals: 'not_contains' }
        : kind === 'date'
          ? { lt: 'before', gt: 'after', lte: 'on_or_before', gte: 'on_or_after' }
          : kind === 'number'
            ? { before: 'lt', after: 'gt', on_or_before: 'lte', on_or_after: 'gte' }
            : kind === 'checkbox'
              ? {}
              : {};
  const mapped = alias[op];
  if (mapped && valid.includes(mapped)) return mapped;
  throw new Error(`Opérateur « ${op} » impossible ici. Opérateurs valides : ${valid.join(', ')}.`);
}

/** Human filters → FilterRule[] (values resolved: option names → ids, people, relation titles). */
export async function buildFilterRules(conv: ValueConverter, ctx: RowContext, filters: HumanFilter[]): Promise<FilterRule[]> {
  const rules: FilterRule[] = [];
  for (const [i, f] of filters.entries()) {
    const own = findProperty(conv.db.schema, f.property);
    let prop = own;
    let kind = propertyKind(own, conv.db.rows, ctx);
    if (f.quantifier) {
      // The condition bears on each value listed by the rollup: its operators and values are the target's.
      if (!isMultiValueRollup(own)) throw new Error(`« ${own.name} » n'est pas un rollup « afficher l'original » : pas de quantificateur possible.`);
      const item = rollupItemProp(own, ctx);
      const itemKind = rollupItemKind(own, ctx);
      if (!item || !itemKind) throw new Error(`Les valeurs de « ${own.name} » ne sont pas chargées : quantificateur impossible.`);
      prop = item;
      kind = itemKind;
    }
    let operator: FilterOperator = f.operator;
    if (kind === 'checkbox' && operator === 'equals') operator = f.value === false || looseKey(String(f.value)) === 'false' || looseKey(String(f.value)) === 'non' ? 'unchecked' : 'checked';
    operator = adaptOperator(operator, kind);
    let value: unknown = f.value;
    const needsValue = !['is_empty', 'is_not_empty', 'checked', 'unchecked'].includes(operator);
    if (needsValue) {
      if (value === undefined || value === null || value === '') throw new Error(`Valeur manquante pour le filtre sur « ${prop.name} ».`);
      if (kind === 'select' || kind === 'multi') {
        const list = Array.isArray(value) ? value : [value];
        value = list.map((v) => {
          const n = String(v);
          const o = prop.options?.find((x) => x.id === n) ?? prop.options?.find((x) => looseKey(x.name) === looseKey(n));
          if (!o) throw new Error(`Option « ${n} » inconnue pour « ${prop.name} ». Options : ${(prop.options ?? []).map((x) => `« ${x.name} »`).join(', ')}.`);
          return o.id;
        });
      } else if (kind === 'person' && (prop.type === 'person' || prop.type === 'created_by' || prop.type === 'last_edited_by')) {
        const list = Array.isArray(value) ? value : [value];
        value = await Promise.all(list.map((v) => conv.convert({ ...prop, type: 'person' }, String(v)).then((ids) => (ids as string[])[0]!)));
      } else if (kind === 'relation' && prop.type === 'relation') {
        const list = Array.isArray(value) ? value : [value];
        value = (await conv.convert(prop, list.map(String))) as string[];
      } else if (kind === 'date' && isDurationOperator(operator)) {
        const duration = asDuration(value);
        if (!duration) throw new Error(`Durée invalide pour « ${prop.name} » : attendu { amount: nombre entier, unit: day | week | month }.`);
        value = duration;
      } else if (kind === 'date' && operator !== 'within') {
        const s = String(value);
        value = ['today', 'tomorrow', 'yesterday'].includes(s) ? s : (parseDateInput(prop, s).start.slice(0, 10) as string);
      } else if (kind === 'number') {
        value = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
      }
    }
    rules.push({ id: `f${i}`, propertyId: own.id, operator, value, ...(f.quantifier ? { quantifier: f.quantifier } : {}) });
  }
  return rules;
}

export function buildSorts(schema: DatabaseSchema, sorts: Array<{ property: string; direction?: 'asc' | 'desc' }>): SortRule[] {
  return sorts.map((s) => ({ propertyId: findProperty(schema, s.property).id, direction: s.direction ?? 'asc' }));
}

export function queryRows(rows: Page[], ctx: RowContext, filter: { conjunction: 'and' | 'or'; rules: FilterRule[] } | null, sorts: SortRule[], search?: string): Page[] {
  return deriveRows(rows, { filter: filter && filter.rules.length ? filter : null, sorts }, ctx, { search });
}
