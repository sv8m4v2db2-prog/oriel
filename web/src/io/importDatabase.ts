// Import of one database: schema (from a Oriel manifest or inferred from the CSV columns),
// views (manifest only) and rows with their property values.
import {
  newId,
  type FileValue,
  type PropertyDef,
  type PropertyValue,
  type SelectOption,
  type UploadedFile,
  type Visibility,
} from '@oriel/shared';
import { api, ApiError } from '../lib/api';
import { applyColumnHint, cellToValue, columnFromDef, inferColumn, propertyForColumn, splitList, type ColumnSpec, type MemberRef } from './csv';
import { errorText } from './importTypes';
import type { PlanDatabase, PlanRow } from './plan';
import { throwIfAborted } from './text';
import { dirname } from './vfs';

export interface ParentRef {
  parentType: 'workspace' | 'page';
  parentId: string;
  visibility?: Visibility;
}

export interface DbImportEnv {
  workspaceId: string;
  members: MemberRef[];
  signal: AbortSignal;
  warn(message: string): void;
  /** Uploads an archive file once (cached by path). */
  upload(path: string): Promise<UploadedFile | null>;
  /** Archive path of an attachment named relatively to one of `bases`, or null. */
  attachmentPath(raw: string, bases: string[]): string | null;
  created(item: PlanDatabase | PlanRow, id: string): void;
}

interface Columns {
  specs: ColumnSpec[];
  propIds: Map<number, string>;
  options: Map<number, SelectOption[] | undefined>;
}

function columnsOf(db: PlanDatabase, env: DbImportEnv): ColumnSpec[] {
  const cells = (i: number) => db.rows.map((r) => r.cells[i] ?? '');
  const bases = [db.csvPath ? dirname(db.csvPath) : '', db.dirPath ?? ''].filter((b, i, a) => a.indexOf(b) === i);
  const defs = db.meta?.properties ?? null;
  const specs: ColumnSpec[] = [];
  db.headers.forEach((name, i) => {
    if (i === db.titleIndex || db.columnHints?.[i]?.skip) return;
    const def = defs?.find((d) => d.name === name && d.type !== 'title');
    const inferred = def
      ? columnFromDef(i, def)
      : inferColumn(i, name, cells(i), {
          members: env.members,
          fileExists: (item) => !!env.attachmentPath(item, bases) || db.rows.some((r) => r.dirPath && env.attachmentPath(item, [r.dirPath])),
        });
    const spec = applyColumnHint(inferred, db.columnHints?.[i], cells(i), env.members);
    if (spec.note) env.warn(`« ${db.title} › ${name} » : ${spec.note}.`);
    specs.push(spec);
  });
  return specs;
}

async function createProperty(
  dbId: string,
  def: Omit<PropertyDef, 'id'> & { id?: string },
  after: string,
  before: Set<string>,
  env: DbImportEnv,
): Promise<PropertyDef> {
  let schema;
  try {
    schema = await api.databases.createProperty(dbId, { property: def, after });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 400 || def.type === 'text') throw e;
    env.warn(`Propriété « ${def.name} » créée en texte (${e.message})`);
    schema = await api.databases.createProperty(dbId, { property: { name: def.name, type: 'text' }, after });
  }
  const created = schema.properties.find((p) => (def.id ? p.id === def.id : !before.has(p.id))) ?? schema.properties[schema.properties.length - 1]!;
  for (const p of schema.properties) before.add(p.id);
  return created;
}

async function rowValues(db: PlanDatabase, cols: Columns, row: PlanRow, env: DbImportEnv): Promise<Record<string, PropertyValue>> {
  const out: Record<string, PropertyValue> = {};
  for (const spec of cols.specs) {
    const propId = cols.propIds.get(spec.index);
    const raw = row.cells[spec.index] ?? '';
    if (!propId || !raw.trim()) continue;
    if (spec.type === 'files') {
      const bases = [db.csvPath ? dirname(db.csvPath) : '', db.dirPath ?? '', row.dirPath ?? ''];
      const files: FileValue[] = [];
      for (const item of splitList(raw)) {
        const path = env.attachmentPath(item, bases);
        const up = path ? await env.upload(path) : null;
        if (up) files.push({ name: up.name, url: up.url, size: up.size, mime: up.mime });
      }
      if (files.length) out[propId] = files;
      continue;
    }
    const v = cellToValue(spec, raw, cols.options.get(spec.index), env.members);
    if (v !== undefined) out[propId] = v;
  }
  return out;
}

/** Creates the database, its properties, views and rows. Returns the database id. */
export async function importDatabase(db: PlanDatabase, parent: ParentRef, env: DbImportEnv): Promise<string> {
  const { workspaceId, signal } = env;
  const id = newId();
  await api.pages.create(workspaceId, {
    id,
    parentType: parent.parentType,
    parentId: parent.parentId,
    kind: 'database',
    title: db.title.slice(0, 2000),
    icon: db.icon,
    visibility: parent.visibility,
    emptyDatabase: true,
    isInline: parent.parentType === 'page' && db.inline,
  });
  env.created(db, id);

  // Schema: title column name, then one property per column in CSV order.
  const cols: Columns = { specs: columnsOf(db, env), propIds: new Map(), options: new Map() };
  const current = await api.databases.get(id);
  const titleName = (db.headers[db.titleIndex] ?? '').trim();
  if (titleName && titleName !== current.schema.properties.find((p) => p.type === 'title')?.name) {
    await api.databases.updateProperty(id, 'title', { name: titleName.slice(0, 200) });
  }
  const known = new Set(current.schema.properties.map((p) => p.id));
  for (const p of current.schema.properties) if (p.type !== 'title') await api.databases.deleteProperty(id, p.id);
  let after = 'title';
  for (const spec of cols.specs) {
    throwIfAborted(signal);
    try {
      const created = await createProperty(id, propertyForColumn(spec), after, known, env);
      cols.propIds.set(spec.index, created.id);
      cols.options.set(spec.index, created.options);
      after = created.id;
    } catch (e) {
      env.warn(`Colonne « ${spec.name} » de « ${db.title} » ignorée (${errorText(e)})`);
    }
  }

  // Views of a Oriel export (property and option ids were kept, so configs apply as is).
  const views = db.meta?.views ?? [];
  if (views.length > 0) {
    try {
      const fresh = await api.databases.get(id);
      const [first, ...rest] = views;
      const defaultView = fresh.views[0];
      if (defaultView && first) await api.views.update(defaultView.id, { name: first.name, type: first.type, config: first.config });
      for (const v of rest) await api.databases.createView(id, { name: v.name, type: v.type, config: v.config });
    } catch (e) {
      env.warn(`Vues de « ${db.title} » non restaurées (${errorText(e)})`);
    }
  }

  for (const row of db.rows) {
    throwIfAborted(signal);
    const rowId = newId();
    const title = row.title.slice(0, 2000);
    const properties = await rowValues(db, cols, row, env);
    try {
      await api.databases.createRow(id, { id: rowId, title, icon: row.icon, properties });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
      env.warn(`Ligne « ${row.title} » de « ${db.title} » : valeurs ignorées (${e.message})`);
      await api.databases.createRow(id, { id: rowId, title, icon: row.icon });
    }
    env.created(row, rowId);
  }
  return id;
}
