// Per-property permissions (D30, SPEC §5.9): every response carrying a database schema or row values
// goes through these helpers, so that a property hidden from the viewer is absent from both, and every
// value write is checked against the edit rule. Predicates live in access.ts (canReadProperty /
// canEditProperty); `role` null means an anonymous visitor or a service account (AI brief).
import type {
  ChartConfig,
  DashboardWidget,
  DatabaseSchema,
  FilterGroup,
  FormQuestion,
  Page,
  PropertyAccess,
  PropertyAccessRole,
  PropertyDef,
  PropertyValue,
  SortRule,
  View,
  ViewConfig,
  WorkspaceRole,
} from '@oriel/shared';
import type { Db } from '../db/index.js';
import { parseJson, toPage, toSchema, type DatabaseRow, type PageRow } from '../db/rows.js';
import { canEditProperty, canEditRole, canManageRole, canReadProperty, roleOf } from '../access.js';
import { badRequest, forbidden, notFound } from '../errors.js';

export type PropertyViewer = WorkspaceRole | null;

const propsOf = (db: Db, databaseId: string): PropertyDef[] =>
  parseJson<PropertyDef[]>(db.get<{ properties: string }>('SELECT properties FROM databases WHERE page_id = ?', databaseId)?.properties, []);

/** Roles allowed by both rule lists (undefined = every role). */
function bothRoles(a: PropertyAccessRole[] | undefined, b: PropertyAccessRole[] | undefined): PropertyAccessRole[] | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.filter((r) => b.includes(r));
}

/**
 * Rules that actually apply to each property (QA-G3-03). A two-way relation and its mirror hold the
 * same links: each side is readable only by the roles that can read both, editable only by those that
 * can edit both. Returns `props` itself, or a copy whose mirrored relations carry the combined `access`
 * (decisions only: never saved nor served). The other side is loaded once per related database.
 */
export function effectiveProperties(db: Db, props: PropertyDef[]): PropertyDef[] {
  let out: PropertyDef[] | null = null;
  const others = new Map<string, PropertyDef[]>();
  props.forEach((p, i) => {
    const synced = p.type === 'relation' ? p.relation?.syncedPropertyId : undefined;
    const target = p.relation?.databaseId;
    if (!synced || !target) return;
    let list = others.get(target);
    if (!list) others.set(target, (list = propsOf(db, target)));
    const mirror = list.find((m) => m.id === synced);
    if (!mirror?.access) return;
    const access: PropertyAccess = {};
    const readRoles = bothRoles(p.access?.readRoles, mirror.access.readRoles);
    const editRoles = bothRoles(p.access?.editRoles, mirror.access.editRoles);
    if (readRoles) access.readRoles = readRoles;
    if (editRoles) access.editRoles = editRoles;
    out ??= props.slice();
    out[i] = { ...p, access };
  });
  return out ?? props;
}

/** Properties of `props` the viewer may see (schema order kept). Owners and admins see them all. */
export function visibleProperties(db: Db, props: PropertyDef[], role: PropertyViewer): PropertyDef[] {
  if (canManageRole(role)) return props;
  const eff = effectiveProperties(db, props);
  return eff.some((p) => p.access) ? props.filter((_p, i) => canReadProperty(role, eff[i]!)) : props;
}

/** Ids of the properties hidden from the viewer. */
export function hiddenPropertyIds(db: Db, props: PropertyDef[], role: PropertyViewer): Set<string> {
  const out = new Set<string>();
  if (canManageRole(role)) return out;
  const eff = effectiveProperties(db, props);
  eff.forEach((p) => {
    if (!canReadProperty(role, p)) out.add(p.id);
  });
  return out;
}

/** Schema as the viewer may see it: hidden properties removed, `readOnly` set on those it cannot edit. */
export function redactSchema(db: Db, schema: DatabaseSchema, role: PropertyViewer): DatabaseSchema {
  if (canManageRole(role)) return schema;
  const eff = effectiveProperties(db, schema.properties);
  if (!eff.some((p) => p.access)) return schema;
  const properties: PropertyDef[] = [];
  schema.properties.forEach((p, i) => {
    const rule = eff[i]!;
    if (!canReadProperty(role, rule)) return;
    properties.push(canEditRole(role) && !canEditProperty(role, rule) ? { ...p, readOnly: true } : p);
  });
  return { ...schema, properties };
}

/** Schema of a database as the viewer may see it. */
export function schemaFor(db: Db, row: DatabaseRow, workspaceId: string, role: PropertyViewer): DatabaseSchema {
  return redactSchema(db, toSchema(row, workspaceId), role);
}

export function redactValues(values: Record<string, PropertyValue>, hidden: ReadonlySet<string>): Record<string, PropertyValue> {
  if (hidden.size === 0) return values;
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(values)) if (!hidden.has(k)) out[k] = v;
  return out;
}

/**
 * Serializes pages for a viewer: values of database rows lose the properties hidden from it. Other
 * pages (and every page when the database has no restricted property) are serialized as is.
 */
export function pagesFor(db: Db, role: PropertyViewer, rows: PageRow[]): Page[] {
  const hiddenByDb = new Map<string, Set<string>>();
  return rows.map((r) => {
    const page = toPage(r);
    if (r.parent_type !== 'database' || !r.parent_id) return page;
    let hidden = hiddenByDb.get(r.parent_id);
    if (!hidden) {
      hidden = hiddenPropertyIds(db, propsOf(db, r.parent_id), role);
      hiddenByDb.set(r.parent_id, hidden);
    }
    return hidden.size ? { ...page, properties: redactValues(page.properties, hidden) } : page;
  });
}

export function pageFor(db: Db, role: PropertyViewer, row: PageRow): Page {
  return pagesFor(db, role, [row])[0]!;
}

/** pageFor with the role of a signed-in user in the page's workspace. */
export function pageForUser(db: Db, userId: string, row: PageRow): Page {
  if (row.parent_type !== 'database') return toPage(row);
  return pageFor(db, roleOf(db, userId, row.workspace_id), row);
}

/**
 * Checks a value write (`input`: property id → value, as sent by the client). A hidden property is
 * reported as unknown (its existence is not revealed); a visible but read-only one is refused (403).
 * A two-way relation follows the rules of both sides (effectiveProperties): the write changes both.
 */
export function assertPropertyWrites(
  props: PropertyDef[],
  role: PropertyViewer,
  input: Record<string, unknown> | undefined,
  db: Db,
): void {
  if (!input) return;
  const eff = effectiveProperties(db, props);
  for (const key of Object.keys(input)) {
    const i = props.findIndex((p) => p.id === key);
    if (i === -1) continue; // unknown ids are reported by mergePropertyValues
    const def = props[i]!;
    const rule = eff[i]!;
    if (!canReadProperty(role, rule)) throw badRequest(`Propriété inconnue : ${key}.`);
    if (!canEditProperty(role, def)) throw forbidden(`Vous ne pouvez pas modifier la propriété « ${def.name} ».`);
    if (!canEditProperty(role, rule)) {
      throw forbidden(`La propriété « ${def.name} » est liée à une propriété que vous ne pouvez pas modifier dans l’autre base.`);
    }
  }
}

/**
 * Properties a form may ask the viewer about: visible to them, and either without edit restriction or
 * editable by their role. Readers answer member forms (the row is created by an editor, see forms.ts),
 * so the edit rule is checked on the role alone, not on canEditRole. Anonymous (null): unrestricted only.
 */
export function formProperties(db: Db, props: PropertyDef[], role: PropertyViewer): PropertyDef[] {
  const eff = effectiveProperties(db, props);
  return props.filter((p, i) => {
    if (p.type === 'title') return true;
    const rule = eff[i]!;
    if (!canReadProperty(role, rule)) return false;
    const roles = rule.access?.editRoles;
    return !roles || (!!role && (canManageRole(role) || (roles as string[]).includes(role)));
  });
}

/**
 * Structure operations (rename, retype, options, move, delete) on a property: hidden → 404 (its
 * existence is not revealed), read-only → 403. With `mirror` (deleting both sides of a two-way
 * relation), the mirror property of the other database is checked too.
 */
export function assertPropertyStructure(db: Db, role: PropertyViewer, databaseId: string, propId: string, mirror = false): void {
  const props = propsOf(db, databaseId);
  const i = props.findIndex((p) => p.id === propId);
  if (i === -1) return; // unknown: reported by the service
  const def = props[i]!;
  // A mirrored relation follows the rules of both sides (QA-G3-03).
  const rule = effectiveProperties(db, [def])[0]!;
  if (!canReadProperty(role, rule)) throw notFound('Propriété introuvable.');
  if (!canEditProperty(role, def)) throw forbidden(`Vous ne pouvez pas modifier la propriété « ${def.name} ».`);
  if (mirror && !canEditProperty(role, rule)) throw forbidden('La relation liée dans l’autre base ne peut pas être supprimée par vous.');
}

// ---------------------------------------------------------------------------
// View configurations (QA-G1-01, QA-G3-06)
// ---------------------------------------------------------------------------
// The settings of a view that name a property hidden from the viewer (filter rules and their values,
// sorts, grouping, calculations, widths, chart / dashboard / map / calendar / timeline properties, form
// questions, ids in propertyOrder…) are left out of the views it is served. When it saves a view, the
// stored hidden settings are put back (restoreHiddenViewSettings), so that it can neither see, remove
// nor change the rules set by someone who sees more.

type Hidden = ReadonlySet<string>;
const isHidden = (hidden: Hidden, id: string | null | undefined): boolean => !!id && hidden.has(id);

function groupHasHidden(g: FilterGroup, hidden: Hidden): boolean {
  return g.rules.some((r) => hidden.has(r.propertyId)) || (g.groups ?? []).some((sub) => groupHasHidden(sub, hidden));
}

/** Filter without the rules on hidden properties; a nested group holding one is left out whole. */
function redactFilter(g: FilterGroup | null | undefined, hidden: Hidden): FilterGroup | null | undefined {
  if (!g || !Array.isArray(g.rules)) return g;
  const out: FilterGroup = { ...g, rules: g.rules.filter((r) => !hidden.has(r.propertyId)) };
  if (g.groups) out.groups = g.groups.filter((sub) => !groupHasHidden(sub, hidden));
  return out;
}

/** The viewer's filter, with the stored hidden rules and groups put back. */
function restoreFilter(next: FilterGroup | null | undefined, stored: FilterGroup | null | undefined, hidden: Hidden): FilterGroup | null {
  const visible = redactFilter(next, hidden) ?? null;
  if (!stored || !Array.isArray(stored.rules)) return visible;
  const rules = stored.rules.filter((r) => hidden.has(r.propertyId));
  const groups = (stored.groups ?? []).filter((sub) => groupHasHidden(sub, hidden));
  if (rules.length === 0 && groups.length === 0) return visible;
  const base: FilterGroup = visible ?? { conjunction: stored.conjunction, rules: [] };
  const out: FilterGroup = { ...base, rules: [...base.rules, ...rules] };
  if (base.groups?.length || groups.length) out.groups = [...(base.groups ?? []), ...groups];
  return out;
}

/** `next` (visible items) with the hidden items of `stored` put back at their former index. */
function reinsertAt<T>(next: T[], stored: T[], keep: (item: T) => boolean): T[] {
  const out = next.filter((x) => !keep(x));
  stored.forEach((item, i) => {
    if (keep(item)) out.splice(Math.min(i, out.length), 0, item);
  });
  return out;
}

function restoreSorts(next: SortRule[] | undefined, stored: SortRule[] | undefined, hidden: Hidden): SortRule[] {
  return reinsertAt(Array.isArray(next) ? next : [], Array.isArray(stored) ? stored : [], (s) => hidden.has(s.propertyId));
}

function redactRecord<T>(rec: Record<string, T> | undefined, hidden: Hidden): Record<string, T> | undefined {
  if (!rec || typeof rec !== 'object') return rec;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) if (!hidden.has(k)) out[k] = v;
  return out;
}

function restoreRecord<T>(next: Record<string, T> | undefined, stored: Record<string, T> | undefined, hidden: Hidden): Record<string, T> {
  const out = redactRecord(next, hidden) ?? {};
  for (const [k, v] of Object.entries(stored ?? {})) if (hidden.has(k)) out[k] = v;
  return out;
}

/** Property order: the stored hidden ids go back right after the id that preceded them. */
function restoreOrder(next: string[] | undefined, stored: string[] | undefined, hidden: Hidden): string[] {
  const out = (Array.isArray(next) ? next : []).filter((id) => !hidden.has(id));
  const prev = Array.isArray(stored) ? stored : [];
  prev.forEach((id, i) => {
    if (!hidden.has(id) || out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(prev[j]!);
      if (k !== -1) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
  });
  return out;
}

const CHART_KEYS = ['xProperty', 'valueProperty', 'seriesProperty'] as const;

function redactChart(c: ChartConfig | undefined, hidden: Hidden): ChartConfig | undefined {
  if (!c || typeof c !== 'object') return c;
  const out: ChartConfig = { ...c };
  for (const k of CHART_KEYS) if (isHidden(hidden, out[k])) out[k] = null;
  return out;
}

function restoreChart(next: ChartConfig | undefined, stored: ChartConfig | undefined, hidden: Hidden): ChartConfig | undefined {
  if (!next || typeof next !== 'object' || !stored) return redactChart(next, hidden);
  const out: ChartConfig = { ...next };
  for (const k of CHART_KEYS) if (isHidden(hidden, stored[k]) || isHidden(hidden, out[k])) out[k] = stored[k] ?? null;
  if (isHidden(hidden, stored.xProperty)) out.xBucket = stored.xBucket;
  if (isHidden(hidden, stored.seriesProperty)) out.seriesBucket = stored.seriesBucket;
  if (isHidden(hidden, stored.valueProperty)) out.aggregate = stored.aggregate;
  return out;
}

function redactWidget(w: DashboardWidget, hidden: Hidden): DashboardWidget {
  const out: DashboardWidget = { ...w };
  if (w.chart) out.chart = redactChart(w.chart, hidden);
  if (w.filter !== undefined) out.filter = redactFilter(w.filter, hidden);
  if (Array.isArray(w.sorts)) out.sorts = w.sorts.filter((s) => !hidden.has(s.propertyId));
  return out;
}

function restoreWidgets(next: DashboardWidget[] | undefined, stored: DashboardWidget[] | undefined, hidden: Hidden): DashboardWidget[] | undefined {
  if (!Array.isArray(next)) return next;
  const byId = new Map((Array.isArray(stored) ? stored : []).map((w) => [w.id, w] as const));
  return next.map((w) => {
    const before = byId.get(w.id);
    if (!before) return redactWidget(w, hidden);
    const out: DashboardWidget = { ...w };
    if (w.chart !== undefined || before.chart) out.chart = restoreChart(w.chart ?? before.chart, before.chart, hidden);
    if (w.filter !== undefined || before.filter) out.filter = restoreFilter(w.filter, before.filter, hidden);
    if (w.sorts !== undefined || before.sorts) out.sorts = restoreSorts(w.sorts, before.sorts, hidden);
    return out;
  });
}

function redactQuestions(questions: FormQuestion[], hidden: Hidden): FormQuestion[] {
  const kept = questions.filter((q) => !hidden.has(q.propertyId));
  const ids = new Set(kept.map((q) => q.id));
  return kept.map((q) => (q.showIf && !ids.has(q.showIf.questionId) ? { ...q, showIf: null } : q));
}

function restoreQuestions(next: FormQuestion[], stored: FormQuestion[], hidden: Hidden): FormQuestion[] {
  const hiddenIds = new Set(stored.filter((q) => hidden.has(q.propertyId)).map((q) => q.id));
  const before = new Map(stored.map((q) => [q.id, q] as const));
  const visible = next
    .filter((q) => !hidden.has(q.propertyId) && !hiddenIds.has(q.id))
    .map((q) => {
      const showIf = before.get(q.id)?.showIf;
      return showIf && hiddenIds.has(showIf.questionId) ? { ...q, showIf } : q;
    });
  return reinsertAt(visible, stored, (q) => hiddenIds.has(q.id));
}

const SINGLE_KEYS = ['dateProperty', 'dateEndProperty', 'dependencyProperty', 'placeProperty'] as const;

/** A view configuration as a viewer who does not see the `hidden` properties may see it. */
export function redactViewConfig(config: ViewConfig, hidden: Hidden): ViewConfig {
  if (hidden.size === 0 || !config || typeof config !== 'object') return config;
  const out: ViewConfig = { ...config };
  if (config.filter !== undefined) out.filter = redactFilter(config.filter, hidden) ?? null;
  if (Array.isArray(config.sorts)) out.sorts = config.sorts.filter((s) => !hidden.has(s.propertyId));
  if (isHidden(hidden, config.groupBy)) {
    out.groupBy = null;
    out.hiddenGroups = [];
    out.collapsedGroups = [];
  }
  if (Array.isArray(config.propertyOrder)) out.propertyOrder = config.propertyOrder.filter((id) => !hidden.has(id));
  if (Array.isArray(config.hiddenProperties)) out.hiddenProperties = config.hiddenProperties.filter((id) => !hidden.has(id));
  if (config.propertyWidths) out.propertyWidths = redactRecord(config.propertyWidths, hidden)!;
  if (config.calculations) out.calculations = redactRecord(config.calculations, hidden)!;
  for (const k of SINGLE_KEYS) if (isHidden(hidden, config[k])) out[k] = null;
  if (config.chart) out.chart = redactChart(config.chart, hidden);
  if (Array.isArray(config.widgets)) out.widgets = config.widgets.map((w) => redactWidget(w, hidden));
  if (config.form && Array.isArray(config.form.questions)) out.form = { ...config.form, questions: redactQuestions(config.form.questions, hidden) };
  return out;
}

/**
 * Configuration saved by a viewer who does not see the `hidden` properties: for each setting it sent
 * (`sent`, top-level keys), what it cannot see is taken from the `stored` configuration, and what it
 * could not have seen (a guessed hidden id) is dropped.
 */
export function restoreHiddenViewSettings(next: ViewConfig, stored: ViewConfig, hidden: Hidden, sent: ReadonlySet<string>): ViewConfig {
  if (hidden.size === 0) return next;
  const out: ViewConfig = { ...next };
  if (sent.has('filter')) out.filter = restoreFilter(next.filter, stored.filter, hidden);
  if (sent.has('sorts')) out.sorts = restoreSorts(next.sorts, stored.sorts, hidden);
  if (sent.has('groupBy') || sent.has('hiddenGroups') || sent.has('collapsedGroups')) {
    if (isHidden(hidden, stored.groupBy) || isHidden(hidden, next.groupBy)) {
      out.groupBy = stored.groupBy ?? null;
      out.hiddenGroups = stored.hiddenGroups ?? [];
      out.collapsedGroups = stored.collapsedGroups ?? [];
    }
  }
  if (sent.has('propertyOrder')) out.propertyOrder = restoreOrder(next.propertyOrder, stored.propertyOrder, hidden);
  if (sent.has('hiddenProperties')) {
    const kept = (Array.isArray(next.hiddenProperties) ? next.hiddenProperties : []).filter((id) => !hidden.has(id));
    out.hiddenProperties = [...kept, ...(stored.hiddenProperties ?? []).filter((id) => hidden.has(id))];
  }
  if (sent.has('propertyWidths')) out.propertyWidths = restoreRecord(next.propertyWidths, stored.propertyWidths, hidden);
  if (sent.has('calculations')) out.calculations = restoreRecord(next.calculations, stored.calculations, hidden);
  for (const k of SINGLE_KEYS) {
    if (sent.has(k) && (isHidden(hidden, stored[k]) || isHidden(hidden, next[k]))) out[k] = stored[k] ?? null;
  }
  if (sent.has('chart')) out.chart = restoreChart(next.chart, stored.chart, hidden);
  if (sent.has('widgets')) out.widgets = restoreWidgets(next.widgets, stored.widgets, hidden);
  if (sent.has('form') && next.form && Array.isArray(next.form.questions)) {
    out.form = { ...next.form, questions: restoreQuestions(next.form.questions, stored.form?.questions ?? [], hidden) };
  }
  return out;
}

/** Views of a database as the viewer may see them (owners and admins: as stored). */
export function viewsFor(db: Db, role: PropertyViewer, databaseId: string, views: View[]): View[] {
  if (views.length === 0 || canManageRole(role)) return views;
  const hidden = hiddenPropertyIds(db, propsOf(db, databaseId), role);
  if (hidden.size === 0) return views;
  return views.map((v) => ({ ...v, config: redactViewConfig(v.config, hidden) }));
}

export function viewFor(db: Db, role: PropertyViewer, view: View): View {
  return viewsFor(db, role, view.databaseId, [view])[0]!;
}
