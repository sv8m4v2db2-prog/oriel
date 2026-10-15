// Tools: databases (schema, queries, creation, schema changes, rows).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  COLORS,
  NUMBER_FORMATS,
  type Color,
  type DatabaseSchema,
  type NumberFormat,
  type Page,
  type PropertyDef,
  type PropertyType,
  type SelectOption,
  type TemplatesResponse,
  type View,
  type ViewConfig,
} from '@oriel/shared';
import { describeView, viewConfigFrom, viewSettings, viewTypeField, type KindOf } from '../views.js';
import { propertyKind } from '../../../web/src/database/logic/values';
import { looseKey } from '../oriel.js';
import { pageIdFrom } from '../content/links.js';
import { writePageContent } from '../content/pageContent.js';
import {
  FILTER_OPERATORS,
  buildFilterRules,
  buildSorts,
  describeSchema,
  findProperty,
  loadDatabase,
  queryRows,
  readableProperties,
  rowContext,
  ValueConverter,
  type LoadedDatabase,
} from '../databases.js';
import type { Oriel } from '../oriel.js';
import { DESTRUCTIVE, READ, WRITE, findDatabase, ref, resolveParent, tool, type ToolContext } from './common.js';

const PROPERTY_TYPES = [
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
  'relation',
  'formula',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'rollup',
  'place',
  // Computed by the server: last visit of the reader (navigation), who verified the row and when.
  'last_visited',
  'verification',
] as const satisfies readonly PropertyType[];

const ROLLUP_FUNCTIONS = [
  'show_original',
  'count_all',
  'count_values',
  'count_unique',
  'count_empty',
  'count_not_empty',
  'percent_empty',
  'percent_not_empty',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest',
  'latest',
  'date_range',
  'checked',
  'unchecked',
  'percent_checked',
] as const;

const databaseIdField = z.string().min(1).max(500).describe('Id de la base (ou lien oriel://database/<id>, ou URL).');

const optionInput = z.union([
  z.string().min(1).max(200),
  z
    .object({
      name: z.string().min(1).max(200),
      color: z.enum(COLORS as [Color, ...Color[]]).optional(),
      group: z.enum(['todo', 'in_progress', 'done']).optional().describe('Statut : groupe (à faire, en cours, terminé).'),
    })
    .strict(),
]);

const propertySpec = z
  .object({
    name: z.string().min(1).max(200),
    type: z.enum(PROPERTY_TYPES),
    options: z.array(optionInput).max(500).optional().describe('Sélection / multi-sélection / statut : options (noms ou { name, color, group }).'),
    numberFormat: z.enum(NUMBER_FORMATS as [NumberFormat, ...NumberFormat[]]).optional(),
    formula: z.string().max(10_000).optional().describe('Formule, ex. prop("Prix") * prop("Quantité").'),
    prefix: z.string().max(20).optional().describe('ID unique : préfixe, ex. "TACHE".'),
    relation: z
      .object({
        database: z.string().min(1).max(500).describe("Base cible : id, titre, ou 'self' pour la base elle-même."),
        twoWay: z.boolean().optional().describe('Relation bidirectionnelle (propriété miroir créée dans la base cible).'),
        mirrorName: z.string().max(200).optional().describe('Nom de la propriété miroir.'),
        singlePage: z.boolean().optional().describe('Limiter à une page.'),
      })
      .strict()
      .optional(),
    rollup: z
      .object({
        relation: z.string().min(1).max(200).describe('Nom de la propriété relation de cette base.'),
        property: z.string().min(1).max(200).describe('Nom de la propriété agrégée dans la base liée.'),
        function: z.enum(ROLLUP_FUNCTIONS),
      })
      .strict()
      .optional(),
  })
  .strict();

type PropertySpec = z.output<typeof propertySpec>;

function toOptions(input: Array<z.output<typeof optionInput>> | undefined, type: string, existing: SelectOption[] = []): Array<Omit<SelectOption, 'id'> & { id?: string }> | undefined {
  if (!input) return undefined;
  const used = existing.map((o) => o.color);
  return input.map((o, i) => {
    const spec = typeof o === 'string' ? { name: o } : o;
    const color = spec.color ?? (COLORS.filter((c) => c !== 'default')[(used.length + i) % (COLORS.length - 1)] as Color);
    return { name: spec.name, color, ...(type === 'status' ? { group: spec.group ?? 'todo' } : {}) };
  });
}

/** Spec → body of POST /databases/:did/properties (relation/rollup references resolved). */
async function propertyBody(oriel: Oriel, db: { id: string; workspaceId: string; schema: DatabaseSchema }, spec: PropertySpec) {
  const property: Record<string, unknown> = { name: spec.name, type: spec.type };
  const options = toOptions(spec.options, spec.type);
  if (options) property.options = options;
  if (spec.numberFormat) property.numberFormat = spec.numberFormat;
  if (spec.formula !== undefined) property.formula = spec.formula;
  if (spec.prefix !== undefined) property.uniqueIdPrefix = spec.prefix;
  let twoWay: { name?: string } | undefined;
  if (spec.type === 'relation') {
    if (!spec.relation) throw new Error(`La relation « ${spec.name} » doit indiquer relation.database.`);
    const target = looseKey(spec.relation.database) === 'self' ? db.id : await findDatabase(oriel, db.workspaceId, spec.relation.database);
    property.relation = { databaseId: target, ...(spec.relation.singlePage ? { singlePage: true } : {}) };
    if (spec.relation.twoWay) twoWay = spec.relation.mirrorName ? { name: spec.relation.mirrorName } : {};
  }
  if (spec.type === 'rollup') {
    if (!spec.rollup) throw new Error(`Le rollup « ${spec.name} » doit indiquer rollup.relation, rollup.property et rollup.function.`);
    const rel = findProperty(db.schema, spec.rollup.relation);
    if (rel.type !== 'relation' || !rel.relation) throw new Error(`« ${rel.name} » n'est pas une relation.`);
    const target = rel.relation.databaseId === db.id ? db.schema : (await loadDatabase(oriel, rel.relation.databaseId, false)).schema;
    const targetProp = findProperty(target, spec.rollup.property);
    property.rollup = { relationPropertyId: rel.id, targetPropertyId: targetProp.id, function: spec.rollup.function };
  }
  return { property, ...(twoWay ? { twoWay } : {}) };
}

async function addProperty(oriel: Oriel, db: { id: string; workspaceId: string; schema: DatabaseSchema }, spec: PropertySpec, after?: string): Promise<DatabaseSchema> {
  const body = await propertyBody(oriel, db, spec);
  const schema = await oriel.client.post<DatabaseSchema>(`/databases/${encodeURIComponent(db.id)}/properties`, { ...body, ...(after !== undefined ? { after } : {}) });
  db.schema = schema;
  return schema;
}

async function relationTitles(oriel: Oriel, db: LoadedDatabase): Promise<Map<string, string>> {
  const ids = db.schema.properties.filter((p) => p.relation?.databaseId).map((p) => p.relation!.databaseId);
  return ids.length ? oriel.titles(db.schema.workspaceId, ids) : new Map();
}

function rowResult(oriel: Oriel, row: Page) {
  return { id: row.id, titre: row.title || 'Sans titre', lien: ref(row.id) };
}

/** Rows by id / link / title (unique, case and accent insensitive). */
function findRow(db: LoadedDatabase, input: string): Page {
  const id = pageIdFrom(input);
  const byId = db.rows.find((r) => r.id === id);
  if (byId) return byId;
  const matches = db.rows.filter((r) => looseKey(r.title) === looseKey(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Plusieurs lignes s'appellent « ${input} » : utilisez leur id (${matches.map((m) => m.id).join(', ')}).`);
  throw new Error(`Ligne « ${input} » introuvable dans la base.`);
}

const viewSorts = z
  .array(z.object({ property: z.string().min(1).max(200), direction: z.enum(['asc', 'desc']).optional() }).strict())
  .max(10)
  .optional()
  .describe('Tris de la vue (remplacent les précédents).');

const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), property: propertySpec, after: z.string().max(200).optional().describe('Placer après cette propriété (nom).') }).strict(),
  z.object({ action: z.literal('rename'), property: z.string().min(1).max(200), name: z.string().min(1).max(200) }).strict(),
  z
    .object({
      action: z.literal('retype'),
      property: z.string().min(1).max(200),
      type: z.enum(PROPERTY_TYPES),
      options: z.array(optionInput).max(500).optional(),
    })
    .strict()
    .describe('Change le type (les valeurs sont converties au mieux par le serveur, sinon effacées).'),
  z
    .object({
      action: z.literal('delete'),
      property: z.string().min(1).max(200),
      deleteMirror: z.boolean().optional().describe('Relation bidirectionnelle : supprimer aussi la propriété miroir (sinon elle devient à sens unique).'),
    })
    .strict()
    .describe('DESTRUCTIF : supprime la propriété et ses valeurs dans toutes les lignes.'),
  z.object({ action: z.literal('add_options'), property: z.string().min(1).max(200), options: z.array(optionInput).min(1).max(500) }).strict(),
  z
    .object({
      action: z.literal('remove_options'),
      property: z.string().min(1).max(200),
      options: z.array(z.string().min(1).max(200)).min(1).max(500),
    })
    .strict()
    .describe('DESTRUCTIF : retire des options (et ces valeurs des lignes).'),
  z
    .object({
      action: z.literal('update'),
      property: z.string().min(1).max(200),
      numberFormat: z.enum(['number', 'number_with_commas', 'percent', 'euro', 'dollar']).optional(),
      formula: z.string().max(10_000).optional(),
      prefix: z.string().max(20).optional(),
      singlePage: z.boolean().optional(),
      twoWay: z.boolean().optional().describe('Relation : rendre bidirectionnelle (true) ou à sens unique (false, supprime le miroir).'),
      mirrorName: z.string().max(200).optional(),
    })
    .strict(),
  z.object({ action: z.literal('rename_database'), title: z.string().max(2000) }).strict(),
  z
    .object({
      action: z.literal('add_view'),
      name: z.string().min(1).max(200),
      type: viewTypeField,
      sorts: viewSorts,
      ...viewSettings,
    })
    .strict()
    .describe(
      "Ajoute une vue. Réglages selon le type : feed → previewLines ; chart_bar / chart_hbar / chart_line / chart_donut / chart_number → chart { x, xBucket, aggregate, value, series, sort, showLegend, showLabels, hideEmpty } ; dashboard → widgets [{ type (chart_* ou list), title, chart, limit, sorts, w, h }] ; map → place (propriété de type lieu) ; form → form { title, description, questions [{ property, label, description, required, showIf { question, value } }], acceptResponses, submitLabel, confirmation }. Propriétés et options désignées par leur nom.",
    ),
  z
    .object({
      action: z.literal('update_view'),
      view: z.string().min(1).max(200).describe('Vue (nom ou id).'),
      name: z.string().min(1).max(200).optional().describe('Nouveau nom.'),
      type: viewTypeField.optional().describe('Nouveau type.'),
      sorts: viewSorts,
      ...viewSettings,
    })
    .strict()
    .describe('Modifie une vue (mêmes réglages que add_view ; ce qui n’est pas indiqué est conservé, widgets et questions donnés remplacent les précédents).'),
  z.object({ action: z.literal('delete_view'), view: z.string().min(1).max(200).describe('Vue (nom ou id).') }).strict().describe('DESTRUCTIF : supprime une vue (les lignes restent).'),
]);

function findView(views: View[], input: string): View {
  const v = views.find((x) => x.id === input) ?? views.find((x) => looseKey(x.name) === looseKey(input));
  if (!v) throw new Error(`Vue « ${input} » introuvable. Vues : ${views.map((x) => `« ${x.name} »`).join(', ')}.`);
  return v;
}

export function registerDatabaseTools(server: McpServer, ctx: ToolContext): void {
  tool(server, ctx, 'oriel_get_database', {
    title: 'Schéma d’une base',
    description: 'Schéma d’une base de données : propriétés (id, nom, type, options, relations, rollups, formules), vues, modèles de ligne et nombre de lignes.',
    input: z.object({ databaseId: databaseIdField }).strict(),
    annotations: READ,
    run: async ({ databaseId }, { oriel }) => {
      const id = pageIdFrom(databaseId);
      const [db, templates] = await Promise.all([
        loadDatabase(oriel, id),
        oriel.client.get<TemplatesResponse>(`/databases/${encodeURIComponent(id)}/templates`).catch(() => null),
      ]);
      const titles = await relationTitles(oriel, db);
      return {
        id,
        titre: db.info.page.title || 'Sans titre',
        lien: ref(id),
        url: oriel.webUrl(db.schema.workspaceId, id),
        modifiable: db.info.canEdit,
        lignes: db.rows.length,
        proprietes: describeSchema(db, titles),
        vues: db.info.views.map((v) => describeView(v, db.schema)),
        modeles: templates?.rows.map((r) => ({ id: r.id, titre: r.title || 'Sans titre', parDefaut: r.id === templates.defaultTemplateId })),
      };
    },
  });

  tool(server, ctx, 'oriel_query_database', {
    title: 'Interroger une base',
    description:
      "Lignes d'une base avec valeurs lisibles (noms d'options, personnes, titres des relations, formules et rollups calculés). Filtres par NOM de propriété : equals, not_equals, contains, not_contains, starts_with, ends_with, is_empty, is_not_empty, gt/lt/gte/lte (nombres), before/after/on_or_before/on_or_after (dates 'AAAA-MM-JJ' ou today/tomorrow/yesterday), within (yesterday, today, tomorrow, past_week, past_month, past_year, next_week, next_month, next_year), within_last/within_next/exactly_ago/exactly_ahead (valeur {amount, unit: day|week|month}), contains_all (listes), checked/unchecked. Valeurs lisibles (nom d'option, nom ou e-mail de personne, titre de ligne liée). Paginée.",
    input: z
      .object({
        databaseId: databaseIdField,
        filters: z
          .array(z
              .object({
                property: z.string().min(1).max(200),
                operator: z.enum(FILTER_OPERATORS),
                value: z.unknown().optional(),
                quantifier: z.enum(['any', 'every', 'none']).optional().describe("Rollup « afficher l'original » : la condition porte sur au moins une (any), toutes (every) ou aucune (none) des valeurs liées."),
              })
              .strict())
          .max(50)
          .optional(),
        match: z.enum(['all', 'any']).optional().describe("'all' (ET, défaut) ou 'any' (OU)."),
        sorts: z.array(z.object({ property: z.string().min(1).max(200), direction: z.enum(['asc', 'desc']).optional() }).strict()).max(10).optional(),
        view: z.string().max(200).optional().describe("Appliquer d'abord les filtres et tris d'une vue (nom ou id)."),
        search: z.string().max(200).optional().describe('Recherche dans les titres.'),
        properties: z.array(z.string().max(200)).max(100).optional().describe('Propriétés à renvoyer (noms) ; défaut : toutes.'),
        limit: z.number().int().min(1).max(200).optional().describe('Défaut 50.'),
        offset: z.number().int().min(0).optional(),
      })
      .strict(),
    annotations: READ,
    run: async (args, { oriel }) => {
      const id = pageIdFrom(args.databaseId);
      const db = await loadDatabase(oriel, id);
      const rctx = await rowContext(oriel, db);
      const me = await oriel.me();
      const conv = new ValueConverter(oriel, db, me.user.id, { createOptions: false });
      let rows = db.rows;
      let sorts = args.sorts ? buildSorts(db.schema, args.sorts) : [];
      if (args.view) {
        const v = db.info.views.find((x) => x.id === args.view) ?? db.info.views.find((x) => looseKey(x.name) === looseKey(args.view!));
        if (!v) throw new Error(`Vue « ${args.view} » introuvable. Vues : ${db.info.views.map((x) => `« ${x.name} »`).join(', ')}.`);
        rows = queryRows(rows, rctx, v.config.filter as ViewConfig['filter'] & object, args.sorts ? [] : v.config.sorts);
        if (!args.sorts) sorts = [];
      }
      const rules = await buildFilterRules(conv, rctx, args.filters ?? []);
      rows = queryRows(rows, rctx, rules.length ? { conjunction: args.match === 'any' ? 'or' : 'and', rules } : null, sorts, args.search);
      const only = args.properties ? new Set(args.properties.map((p) => findProperty(db.schema, p).id)) : undefined;
      const start = args.offset ?? 0;
      const size = args.limit ?? 50;
      const page = rows.slice(start, start + size);
      return {
        base: db.info.page.title || 'Sans titre',
        total: rows.length,
        offset: start,
        suivant: start + size < rows.length ? start + size : null,
        lignes: page.map((r) => ({ id: r.id, titre: r.title || 'Sans titre', proprietes: readableProperties(r, db.schema, rctx, only) })),
      };
    },
  });

  tool(server, ctx, 'oriel_create_database', {
    title: 'Créer une base',
    description:
      "Crée une base de données (pleine page à la racine ou sous une page, ou intégrée dans une page avec inline: true) avec ses propriétés : sélections avec options, statut, dates, personnes, relations (vers une autre base, ou 'self', bidirectionnelles), rollups, formules, ID unique… Les propriétés sont créées dans l'ordre (les rollups après les relations).",
    input: z
      .object({
        parent: z
          .object({ type: z.enum(['workspace', 'page']), id: z.string().max(500).optional() })
          .strict()
          .describe("'workspace' (racine, id = espace facultatif) ou 'page' (id de la page)."),
        title: z.string().max(2000),
        icon: z.string().max(50).optional(),
        inline: z.boolean().optional().describe('Sous une page : base intégrée dans le contenu de la page (bloc ajouté à la fin).'),
        titleProperty: z.string().max(200).optional().describe('Nom de la colonne titre (défaut « Nom »).'),
        properties: z.array(propertySpec).max(100).optional(),
      })
      .strict(),
    annotations: WRITE,
    run: async (args, { oriel }) => {
      const parent = await resolveParent(oriel, args.parent);
      const page = await oriel.client.post<Page>(`/workspaces/${encodeURIComponent(parent.workspaceId)}/pages`, {
        parentType: parent.parentType,
        parentId: parent.parentId,
        kind: 'database',
        title: args.title,
        icon: args.icon,
        emptyDatabase: true,
        ...(parent.parentType === 'page' && args.inline ? { isInline: true } : {}),
      });
      oriel.invalidate(parent.workspaceId);
      const db = { id: page.id, workspaceId: parent.workspaceId, schema: (await loadDatabase(oriel, page.id, false)).schema };
      const warnings: string[] = [];
      const specs = args.properties ?? [];
      // Default schema: title « Nom » + « Étiquettes » (multi-select): keep the latter only when asked for.
      const tags = db.schema.properties.find((p) => p.type === 'multi_select' && looseKey(p.name) === looseKey('Étiquettes'));
      const tagSpec = specs.find((s) => looseKey(s.name) === looseKey('Étiquettes') && s.type === 'multi_select');
      if (tags && !tagSpec) db.schema = await oriel.client.del<DatabaseSchema>(`/databases/${encodeURIComponent(page.id)}/properties/${encodeURIComponent(tags.id)}`);
      const titleProp = db.schema.properties.find((p) => p.type === 'title')!;
      if (args.titleProperty && args.titleProperty !== titleProp.name) {
        db.schema = await oriel.client.patch<DatabaseSchema>(`/databases/${encodeURIComponent(page.id)}/properties/title`, { name: args.titleProperty });
      }
      const ordered = [...specs.filter((s) => s.type !== 'rollup'), ...specs.filter((s) => s.type === 'rollup')];
      for (const spec of ordered) {
        if (spec === tagSpec && tags) {
          if (spec.options?.length) db.schema = await oriel.client.patch<DatabaseSchema>(`/databases/${encodeURIComponent(page.id)}/properties/${encodeURIComponent(tags.id)}`, { options: toOptions(spec.options, spec.type) });
          continue;
        }
        try {
          await addProperty(oriel, db, spec);
        } catch (err) {
          warnings.push(`« ${spec.name} » : ${(err as Error).message}`);
        }
      }
      if (parent.parentType === 'page' && args.inline) {
        try {
          await writePageContent(oriel, { workspaceId: parent.workspaceId, pageId: parent.parentId, mode: 'append', blocks: [{ type: 'database', props: { databaseId: page.id } }] });
        } catch (err) {
          warnings.push(`bloc de base non ajouté dans la page parente : ${(err as Error).message}`);
        }
      }
      const loaded = await loadDatabase(oriel, page.id, false);
      return {
        id: page.id,
        titre: page.title,
        lien: ref(page.id),
        url: oriel.webUrl(parent.workspaceId, page.id),
        proprietes: describeSchema(loaded, await relationTitles(oriel, loaded)),
        avertissements: warnings,
      };
    },
  });

  tool(server, ctx, 'oriel_update_database_schema', {
    title: 'Modifier le schéma',
    description:
      "Modifie le schéma d'une base, par opérations successives (arrêt à la première erreur) : add (propriété), rename, retype (conversion des valeurs), delete (DESTRUCTIF : valeurs supprimées), add_options, remove_options (DESTRUCTIF), update (format, formule, préfixe, relation bidirectionnelle…), rename_database, add_view / update_view (tableau, tableau Kanban, liste, galerie, calendrier, chronologie, fil d'actualité, graphiques, tableau de bord, carte, formulaire, avec leurs réglages validés), delete_view (DESTRUCTIF). Les propriétés sont désignées par leur nom.",
    input: z.object({ databaseId: databaseIdField, operations: z.array(operation).min(1).max(50) }).strict(),
    annotations: DESTRUCTIVE,
    run: async ({ databaseId, operations }, { oriel }) => {
      const id = pageIdFrom(databaseId);
      const loaded = await loadDatabase(oriel, id, false);
      const db = { id, workspaceId: loaded.schema.workspaceId, schema: loaded.schema };
      const done: string[] = [];
      const warnings: string[] = [];
      let views = loaded.info.views;
      // Kinds of formulas / rollups (chart values and date axes) need the rows: loaded on first use.
      let kinds: Promise<KindOf> | null = null;
      const kindOf = async (): Promise<KindOf> => {
        kinds ??= (async () => {
          const full = await loadDatabase(oriel, id);
          const rctx = await rowContext(oriel, full);
          return (p: PropertyDef) => propertyKind(p, full.rows, rctx);
        })();
        return kinds;
      };
      const path = (p: PropertyDef) => `/databases/${encodeURIComponent(id)}/properties/${encodeURIComponent(p.id)}`;
      try {
        for (const op of operations) {
          switch (op.action) {
            case 'add': {
              const after = op.after ? findProperty(db.schema, op.after).id : undefined;
              await addProperty(oriel, db, op.property, after);
              done.push(`ajout de « ${op.property.name} »`);
              break;
            }
            case 'rename': {
              const p = findProperty(db.schema, op.property);
              db.schema = await oriel.client.patch<DatabaseSchema>(path(p), { name: op.name });
              done.push(`« ${p.name} » renommée en « ${op.name} »`);
              break;
            }
            case 'retype': {
              const p = findProperty(db.schema, op.property);
              const options = toOptions(op.options, op.type);
              db.schema = await oriel.client.patch<DatabaseSchema>(path(p), { type: op.type, ...(options ? { options } : {}) });
              done.push(`« ${p.name} » : type ${p.type} → ${op.type}`);
              break;
            }
            case 'delete': {
              const p = findProperty(db.schema, op.property);
              if (p.type === 'title') throw new Error('La propriété titre ne peut pas être supprimée.');
              db.schema = await oriel.client.del<DatabaseSchema>(`${path(p)}${op.deleteMirror ? '?mirror=delete' : ''}`);
              done.push(`« ${p.name} » supprimée`);
              break;
            }
            case 'add_options': {
              const p = findProperty(db.schema, op.property);
              if (!['select', 'multi_select', 'status'].includes(p.type)) throw new Error(`« ${p.name} » n'a pas d'options.`);
              const existing = p.options ?? [];
              const fresh = (toOptions(op.options, p.type, existing) ?? []).filter((o) => !existing.some((e) => looseKey(e.name) === looseKey(o.name)));
              db.schema = await oriel.client.patch<DatabaseSchema>(path(p), { options: [...existing, ...fresh] });
              done.push(`« ${p.name} » : ${fresh.length} option(s) ajoutée(s)`);
              break;
            }
            case 'remove_options': {
              const p = findProperty(db.schema, op.property);
              const drop = new Set(op.options.map(looseKey));
              const kept = (p.options ?? []).filter((o) => !drop.has(looseKey(o.name)) && !drop.has(looseKey(o.id)));
              db.schema = await oriel.client.patch<DatabaseSchema>(path(p), { options: kept });
              done.push(`« ${p.name} » : ${(p.options ?? []).length - kept.length} option(s) retirée(s)`);
              break;
            }
            case 'update': {
              const p = findProperty(db.schema, op.property);
              const body: Record<string, unknown> = {};
              if (op.numberFormat) body.numberFormat = op.numberFormat;
              if (op.formula !== undefined) body.formula = op.formula;
              if (op.prefix !== undefined) body.uniqueIdPrefix = op.prefix;
              if (op.singlePage !== undefined) {
                if (!p.relation) throw new Error(`« ${p.name} » n'est pas une relation.`);
                body.relation = { databaseId: p.relation.databaseId, singlePage: op.singlePage };
              }
              if (op.twoWay !== undefined) body.twoWay = op.twoWay ? (op.mirrorName ? { name: op.mirrorName } : {}) : null;
              db.schema = await oriel.client.patch<DatabaseSchema>(path(p), body);
              done.push(`« ${p.name} » mise à jour`);
              break;
            }
            case 'rename_database':
              await oriel.client.patch<Page>(`/pages/${encodeURIComponent(id)}`, { title: op.title });
              oriel.invalidate(db.workspaceId);
              done.push(`base renommée en « ${op.title} »`);
              break;
            case 'add_view': {
              const { action: _a, name, type, sorts, ...settings } = op;
              const { config, warnings: w } = viewConfigFrom(type, settings, db.schema, undefined, undefined, await kindOf());
              if (sorts) config.sorts = buildSorts(db.schema, sorts);
              const view = await oriel.client.post<View>(`/databases/${encodeURIComponent(id)}/views`, { name, type, config });
              views = [...views, view];
              warnings.push(...w.map((x) => `« ${name} » : ${x}`));
              done.push(`vue « ${name} » (${type}) ajoutée`);
              break;
            }
            case 'update_view': {
              const { action: _a, view: ref, name, type, sorts, ...settings } = op;
              const v = findView(views, ref);
              const nextType = type ?? v.type;
              const { config, warnings: w } = viewConfigFrom(nextType, settings, db.schema, v.config, v.type, await kindOf());
              if (sorts) config.sorts = buildSorts(db.schema, sorts);
              const updated = await oriel.client.patch<View>(`/views/${encodeURIComponent(v.id)}`, {
                ...(name ? { name } : {}),
                ...(type ? { type } : {}),
                config,
              });
              views = views.map((x) => (x.id === v.id ? updated : x));
              warnings.push(...w.map((x) => `« ${updated.name} » : ${x}`));
              done.push(`vue « ${v.name} » modifiée`);
              break;
            }
            case 'delete_view': {
              const v = findView(views, op.view);
              if (views.length <= 1) throw new Error('La dernière vue d’une base ne peut pas être supprimée.');
              await oriel.client.del(`/views/${encodeURIComponent(v.id)}`);
              views = views.filter((x) => x.id !== v.id);
              done.push(`vue « ${v.name} » supprimée`);
              break;
            }
          }
        }
      } catch (err) {
        throw new Error(`${(err as Error).message}${done.length ? ` (déjà fait : ${done.join(' ; ')})` : ''}`);
      }
      const after = await loadDatabase(oriel, id, false);
      return {
        id,
        fait: done,
        ...(warnings.length ? { avertissements: warnings } : {}),
        proprietes: describeSchema(after, await relationTitles(oriel, after)),
        vues: after.info.views.map((v) => describeView(v, after.schema)),
      };
    },
  });

  tool(server, ctx, 'oriel_create_rows', {
    title: 'Créer des lignes',
    description:
      "Crée des lignes dans une base (jusqu'à 100 par appel), avec leurs propriétés en valeurs lisibles par NOM de propriété (options par nom — les options de sélection manquantes sont créées —, dates 'AAAA-MM-JJ', personnes par nom/e-mail/'moi', relations par titre ou id) et un contenu Markdown facultatif. Option template : modèle de ligne (nom ou id).",
    input: z
      .object({
        databaseId: databaseIdField,
        rows: z
          .array(
            z
              .object({
                title: z.string().max(2000).optional(),
                icon: z.string().max(50).optional(),
                properties: z.record(z.string(), z.unknown()).optional(),
                markdown: z.string().max(200_000).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        template: z.string().max(500).optional(),
        createMissingOptions: z.boolean().optional().describe('Créer les options de sélection inconnues (défaut true).'),
      })
      .strict(),
    annotations: WRITE,
    run: async (args, { oriel }) => {
      const id = pageIdFrom(args.databaseId);
      const db = await loadDatabase(oriel, id);
      const me = await oriel.me();
      const conv = new ValueConverter(oriel, db, me.user.id, { createOptions: args.createMissingOptions !== false });
      const prepared = [];
      for (const [i, row] of args.rows.entries()) {
        try {
          prepared.push({ row, values: await conv.convertAll(row.properties ?? {}, { deferSelfRelations: true }) });
        } catch (err) {
          throw new Error(`Ligne ${i + 1}${row.title ? ` (« ${row.title} »)` : ''} : ${(err as Error).message} Aucune ligne créée.`);
        }
      }
      const added = await conv.flushOptions();
      let templateId: string | undefined;
      if (args.template) {
        const tpl = await oriel.client.get<TemplatesResponse>(`/databases/${encodeURIComponent(id)}/templates`);
        const t = tpl.rows.find((r) => r.id === pageIdFrom(args.template!)) ?? tpl.rows.find((r) => looseKey(r.title) === looseKey(args.template!));
        if (!t) throw new Error(`Modèle « ${args.template} » introuvable.`);
        templateId = t.id;
      }
      const created = [];
      const pages: Array<{ page: Page; deferred: Array<[PropertyDef, unknown]> }> = [];
      const errors: string[] = [];
      const warnings: string[] = added.length ? [`options ajoutées : ${added.join(', ')}`] : [];
      for (const [i, { row, values }] of prepared.entries()) {
        try {
          const page = await oriel.client.post<Page>(`/databases/${encodeURIComponent(id)}/rows`, {
            title: values.title ?? row.title ?? '',
            icon: row.icon,
            properties: values.properties,
            ...(templateId ? { templateId } : {}),
          });
          if (row.markdown?.trim()) {
            const res = await writePageContent(oriel, { workspaceId: db.schema.workspaceId, pageId: page.id, mode: templateId ? 'append' : 'replace', markdown: row.markdown });
            warnings.push(...res.warnings);
          }
          created.push(rowResult(oriel, page));
          pages.push({ page, deferred: values.deferred });
        } catch (err) {
          errors.push(`ligne ${i + 1} : ${(err as Error).message}`);
        }
      }
      // Relations to the database itself: they may name rows of this batch.
      conv.addRows(pages.map((p) => p.page));
      for (const { page, deferred } of pages) {
        if (deferred.length === 0) continue;
        try {
          const properties: Record<string, unknown> = {};
          for (const [def, value] of deferred) properties[def.id] = await conv.convert(def, value);
          await oriel.client.patch<Page>(`/pages/${encodeURIComponent(page.id)}`, { properties });
        } catch (err) {
          errors.push(`« ${page.title || 'Sans titre'} » (créée, relation non renseignée) : ${(err as Error).message}`);
        }
      }
      return { base: db.info.page.title, creees: created, erreurs: errors, avertissements: warnings };
    },
  });

  tool(server, ctx, 'oriel_update_rows', {
    title: 'Modifier des lignes',
    description:
      "Met à jour des lignes d'une base (jusqu'à 100) désignées par id ou par titre exact : titre, icône et propriétés en valeurs lisibles par NOM de propriété (null efface une valeur). Les autres propriétés ne changent pas.",
    input: z
      .object({
        databaseId: databaseIdField,
        updates: z
          .array(
            z
              .object({
                row: z.string().min(1).max(2000).describe('Id de la ligne ou son titre exact.'),
                title: z.string().max(2000).optional(),
                icon: z.string().max(50).nullable().optional(),
                properties: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        createMissingOptions: z.boolean().optional().describe('Créer les options de sélection inconnues (défaut true).'),
      })
      .strict(),
    annotations: WRITE,
    run: async (args, { oriel }) => {
      const id = pageIdFrom(args.databaseId);
      const db = await loadDatabase(oriel, id);
      const me = await oriel.me();
      const conv = new ValueConverter(oriel, db, me.user.id, { createOptions: args.createMissingOptions !== false });
      const prepared = [];
      for (const u of args.updates) {
        try {
          const row = findRow(db, u.row);
          prepared.push({ u, row, values: await conv.convertAll(u.properties ?? {}) });
        } catch (err) {
          throw new Error(`« ${u.row} » : ${(err as Error).message} Aucune ligne modifiée.`);
        }
      }
      const added = await conv.flushOptions();
      const updated = [];
      const errors: string[] = [];
      for (const { u, row, values } of prepared) {
        try {
          const body: Record<string, unknown> = { properties: values.properties };
          const title = u.title ?? values.title;
          if (title !== undefined) body.title = title;
          if (u.icon !== undefined) body.icon = u.icon;
          const page = await oriel.client.patch<Page>(`/pages/${encodeURIComponent(row.id)}`, body);
          updated.push(rowResult(oriel, page));
        } catch (err) {
          errors.push(`« ${u.row} » : ${(err as Error).message}`);
        }
      }
      return { modifiees: updated, erreurs: errors, avertissements: added.length ? [`options ajoutées : ${added.join(', ')}`] : [] };
    },
  });
}
