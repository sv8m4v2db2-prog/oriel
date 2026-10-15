// Database views for the MCP tools: human input (property NAMES, option names) → ViewConfig checked
// against the schema with the web's own rules (chart dimensions and aggregates, form questions and
// conditions, `place` property of maps), and ViewConfig → readable description.
//
// A form's `isPublic` flag is never set here: opening anonymous submissions is a publication, which
// API tokens cannot do (the current value is kept as it is).
import { z } from 'zod';
import {
  CHART_VIEW_TYPES,
  FORM_QUESTION_TYPES,
  VIEW_TYPES,
  defaultChartConfig,
  isChartView,
  type ChartConfig,
  type ChartViewType,
  type DashboardWidget,
  type DatabaseSchema,
  type FormConfig,
  type FormQuestion,
  type PropertyDef,
  type View,
  type ViewConfig,
  type ViewType,
} from '@oriel/shared';
import { canAggregate, canChartBy, isDateDimension } from '../../web/src/database/logic/chart';
import type { ValueKind } from '../../web/src/database/logic/values';
import { canBeCondition } from '../../web/src/database/logic/form';
import { looseKey } from './oriel.js';
import { findProperty } from './databases.js';

const BUCKETS = ['day', 'week', 'month', 'year'] as const;
const nameField = z.string().min(1).max(200);

export const chartSpec = z
  .object({
    x: nameField.nullable().optional().describe('Axe X : propriété qui regroupe les lignes (nom). Ignoré par chart_number.'),
    xBucket: z.enum(BUCKETS).optional().describe('Axe X de type date : regroupement par jour, semaine, mois ou année.'),
    aggregate: z.enum(['count', 'sum', 'average', 'min', 'max']).optional().describe("Valeur : 'count' (nombre de lignes, défaut) ou agrégat d'une propriété nombre."),
    value: nameField.nullable().optional().describe('Propriété nombre agrégée (sum, average, min, max).'),
    series: nameField.nullable().optional().describe('Second regroupement (barres empilées, une ligne par valeur). Barres et lignes seulement.'),
    seriesBucket: z.enum(BUCKETS).optional(),
    sort: z.enum(['default', 'label_asc', 'label_desc', 'value_asc', 'value_desc']).optional(),
    showLegend: z.boolean().optional(),
    showLabels: z.boolean().optional(),
    hideEmpty: z.boolean().optional().describe('Masquer la catégorie « Sans valeur ».'),
  })
  .strict();

const widgetSpec = z
  .object({
    type: z.enum(['list', ...CHART_VIEW_TYPES] as [ChartViewType | 'list', ...Array<ChartViewType | 'list'>]),
    title: z.string().max(200).optional(),
    chart: chartSpec.optional(),
    sorts: z.array(z.object({ property: nameField, direction: z.enum(['asc', 'desc']).optional() }).strict()).max(10).optional().describe('Liste : tri.'),
    limit: z.number().int().min(1).max(50).optional().describe('Liste : nombre de lignes (défaut 5).'),
    w: z.number().int().min(1).max(4).optional().describe('Largeur en colonnes (1–4).'),
    h: z.number().int().min(1).max(3).optional().describe('Hauteur en rangées (1–3).'),
  })
  .strict();

const questionSpec = z
  .object({
    property: nameField.describe('Propriété remplie par la question (nom).'),
    label: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    required: z.boolean().optional(),
    showIf: z
      .object({
        question: nameField.describe("Question précédente (nom de sa propriété) : sélection, statut, multi-sélection ou case à cocher."),
        value: z.union([z.string().max(200), z.boolean()]).describe("Nom d'option, ou true / false pour une case à cocher."),
      })
      .strict()
      .optional()
      .describe('Question posée seulement si une réponse précédente vaut cette valeur.'),
  })
  .strict();

export const formSpec = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    questions: z.array(questionSpec).max(100).optional().describe('Questions, dans l’ordre (remplacent les précédentes).'),
    acceptResponses: z.boolean().optional().describe('Réponses acceptées (défaut true).'),
    submitLabel: z.string().max(100).optional(),
    confirmation: z.string().max(2000).optional().describe('Message affiché après l’envoi.'),
  })
  .strict();

/** Settings of a view by type, all optional (an update keeps what is not given). */
export const viewSettings = {
  previewLines: z.number().int().min(0).max(20).optional().describe("Fil d'actualité : lignes du contenu affichées par publication (0–20, défaut 3)."),
  chart: chartSpec.optional().describe('Graphiques (chart_*).'),
  widgets: z.array(widgetSpec).min(1).max(24).optional().describe('Tableau de bord : widgets, dans l’ordre (remplacent les précédents).'),
  place: nameField.nullable().optional().describe('Carte : propriété de type lieu (place) qui situe les lignes.'),
  form: formSpec.optional().describe('Formulaire : questions et réglages. Le partage public se règle dans Oriel.'),
};

export const viewTypeField = z.enum(VIEW_TYPES as [ViewType, ...ViewType[]]);

export type ViewSettings = { [K in keyof typeof viewSettings]?: z.output<(typeof viewSettings)[K]> };

/** Value kind of a property computed on the rows (formulas and rollups), as the web view settings do. */
export type KindOf = (prop: PropertyDef) => ValueKind | undefined;

const propName = (schema: DatabaseSchema, id: string | null | undefined) => (id ? (schema.properties.find((p) => p.id === id)?.name ?? id) : null);

function chartFrom(type: ChartViewType, spec: z.output<typeof chartSpec> | undefined, schema: DatabaseSchema, base: ChartConfig | undefined, kindOf: KindOf): ChartConfig {
  const out: ChartConfig = { ...(base ?? defaultChartConfig(type, schema.properties)) };
  const s = spec ?? {};
  const dimension = (name: string, what: string): PropertyDef => {
    const p = findProperty(schema, name);
    if (!canChartBy(p)) throw new Error(`« ${p.name} » (${p.type}) ne peut pas servir de ${what}.`);
    return p;
  };
  if (s.x !== undefined) out.xProperty = s.x === null ? null : dimension(s.x, 'axe X').id;
  if (s.series !== undefined) out.seriesProperty = s.series === null ? null : dimension(s.series, 'série').id;
  if (s.aggregate !== undefined) out.aggregate = s.aggregate;
  if (s.value !== undefined) {
    if (s.value === null) out.valueProperty = null;
    else {
      const p = findProperty(schema, s.value);
      if (!canAggregate(p, kindOf(p))) throw new Error(`« ${p.name} » (${p.type}) n'est pas un nombre : elle ne peut pas être agrégée.`);
      out.valueProperty = p.id;
    }
  }
  if (out.aggregate === 'count') out.valueProperty = null;
  else if (!out.valueProperty) throw new Error(`Agrégat « ${out.aggregate} » : indiquez la propriété nombre (value).`);
  if (type === 'chart_number') {
    out.xProperty = null;
    out.seriesProperty = null;
  } else if (!out.xProperty) throw new Error(`Graphique ${type} : indiquez l'axe X (x), aucune propriété ne convient par défaut.`);
  if ((type === 'chart_donut' || type === 'chart_number') && out.seriesProperty) throw new Error(`Graphique ${type} : pas de série.`);
  if (out.seriesProperty && out.seriesProperty === out.xProperty) throw new Error("La série doit être différente de l'axe X.");
  const prop = (id: string | null | undefined) => (id ? schema.properties.find((p) => p.id === id) : undefined);
  if (s.xBucket !== undefined) {
    const x = prop(out.xProperty);
    if (!x || !isDateDimension(x, kindOf(x))) throw new Error("xBucket ne s'applique qu'à un axe X de type date.");
    out.xBucket = s.xBucket;
  }
  if (s.seriesBucket !== undefined) {
    const series = prop(out.seriesProperty);
    if (!series || !isDateDimension(series, kindOf(series))) throw new Error("seriesBucket ne s'applique qu'à une série de type date.");
    out.seriesBucket = s.seriesBucket;
  }
  for (const k of ['sort', 'showLegend', 'showLabels', 'hideEmpty'] as const) if (s[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = s[k];
  return out;
}

function widgetsFrom(specs: Array<z.output<typeof widgetSpec>>, schema: DatabaseSchema, kindOf: KindOf): DashboardWidget[] {
  return specs.map((w, i) => {
    const big = w.type !== 'chart_number' && w.type !== 'list';
    const out: DashboardWidget = { id: `w${i + 1}`, type: w.type, w: w.w ?? (big ? 2 : 1), h: w.h ?? (w.type === 'chart_number' ? 1 : 2) };
    if (w.title) out.title = w.title;
    if (w.type === 'list') {
      if (w.chart) throw new Error(`Widget ${i + 1} : une liste n'a pas de réglages de graphique.`);
      out.limit = w.limit ?? 5;
      if (w.sorts) out.sorts = w.sorts.map((s) => ({ propertyId: findProperty(schema, s.property).id, direction: s.direction ?? 'asc' }));
    } else {
      if (w.sorts || w.limit) throw new Error(`Widget ${i + 1} : tri et nombre de lignes sont réservés aux listes.`);
      try {
        out.chart = chartFrom(w.type, w.chart, schema, undefined, kindOf);
      } catch (err) {
        throw new Error(`Widget ${i + 1} : ${(err as Error).message}`);
      }
    }
    return out;
  });
}

function formFrom(spec: z.output<typeof formSpec>, schema: DatabaseSchema, current: FormConfig | undefined): FormConfig {
  const base: FormConfig = current ?? { questions: [], acceptResponses: true, isPublic: false };
  let questions = base.questions;
  if (spec.questions) {
    const seen = new Map<string, FormQuestion>();
    questions = spec.questions.map((q, i) => {
      const p = findProperty(schema, q.property);
      if (!FORM_QUESTION_TYPES.includes(p.type)) throw new Error(`« ${p.name} » (${p.type}) ne peut pas être une question de formulaire.`);
      if (seen.has(p.id)) throw new Error(`« ${p.name} » est demandée deux fois.`);
      const out: FormQuestion = { id: `q${i + 1}`, propertyId: p.id };
      if (q.label) out.label = q.label;
      if (q.description) out.description = q.description;
      if (q.required) out.required = true;
      if (q.showIf) {
        const cp = findProperty(schema, q.showIf.question);
        const cond = seen.get(cp.id);
        if (!cond) throw new Error(`Question « ${p.name} » : la condition doit porter sur une question précédente (« ${cp.name} »).`);
        if (!canBeCondition(cp)) throw new Error(`« ${cp.name} » (${cp.type}) ne peut pas servir de condition (sélection, statut, multi-sélection ou case à cocher).`);
        let value: string;
        if (cp.type === 'checkbox') {
          const v = looseKey(String(q.showIf.value));
          if (['true', 'oui', 'coche', '1'].includes(v)) value = 'true';
          else if (['false', 'non', '0'].includes(v)) value = 'false';
          else throw new Error(`Condition sur « ${cp.name} » : true ou false attendu.`);
        } else {
          const n = String(q.showIf.value);
          const o = cp.options?.find((x) => x.id === n) ?? cp.options?.find((x) => looseKey(x.name) === looseKey(n));
          if (!o) throw new Error(`Option « ${n} » inconnue pour « ${cp.name} ». Options : ${(cp.options ?? []).map((x) => `« ${x.name} »`).join(', ')}.`);
          value = o.id;
        }
        out.showIf = { questionId: cond.id, value };
      }
      seen.set(p.id, out);
      return out;
    });
  }
  const out: FormConfig = { ...base, questions, acceptResponses: spec.acceptResponses ?? base.acceptResponses ?? true };
  for (const k of ['title', 'description', 'submitLabel', 'confirmation'] as const) if (spec[k] !== undefined) out[k] = spec[k];
  // Never changed through the MCP (publication): see the header.
  out.isPublic = base.isPublic ?? false;
  return out;
}

/**
 * Settings → partial ViewConfig for a view of `type` (validated against the schema). On an update,
 * `current` is the view's config and `currentType` its type. Returns warnings for settings that leave
 * the view incomplete.
 */
export function viewConfigFrom(
  type: ViewType,
  settings: ViewSettings,
  schema: DatabaseSchema,
  current?: ViewConfig,
  currentType?: ViewType,
  kindOf: KindOf = () => undefined,
): { config: Partial<ViewConfig>; warnings: string[] } {
  const config: Partial<ViewConfig> = {};
  const warnings: string[] = [];
  const only = (key: keyof ViewSettings, types: string) => {
    if (settings[key] !== undefined) throw new Error(`Le réglage « ${key} » ne s'applique qu'aux vues ${types} (vue ${type}).`);
  };
  if (type === 'feed') {
    if (settings.previewLines !== undefined) config.feedPreviewLines = settings.previewLines;
  } else only('previewLines', 'feed');
  if (isChartView(type)) {
    // Checked on creation, on a change of chart type and when given.
    if (!current || currentType !== type || settings.chart !== undefined) config.chart = chartFrom(type, settings.chart, schema, current?.chart, kindOf);
  } else only('chart', 'chart_*');
  if (type === 'dashboard') {
    if (settings.widgets) config.widgets = widgetsFrom(settings.widgets, schema, kindOf);
  } else only('widgets', 'dashboard');
  if (type === 'map') {
    if (settings.place !== undefined) {
      if (settings.place === null) config.placeProperty = null;
      else {
        const p = findProperty(schema, settings.place);
        if (p.type !== 'place') throw new Error(`« ${p.name} » n'est pas une propriété de type lieu (place).`);
        config.placeProperty = p.id;
      }
    }
    const place = config.placeProperty !== undefined ? config.placeProperty : (current?.placeProperty ?? schema.properties.find((p) => p.type === 'place')?.id ?? null);
    if (!place) warnings.push("carte sans propriété de lieu : ajoutez une propriété de type « place » puis indiquez-la (place).");
  } else only('place', 'map');
  if (type === 'form') {
    if (settings.form) config.form = formFrom(settings.form, schema, current?.form);
  } else only('form', 'form');
  return { config, warnings };
}

/** Readable chart settings. */
function describeChart(c: ChartConfig | undefined, schema: DatabaseSchema): unknown {
  if (!c) return null;
  return {
    x: propName(schema, c.xProperty),
    ...(c.xBucket ? { xBucket: c.xBucket } : {}),
    aggregate: c.aggregate,
    value: propName(schema, c.valueProperty),
    ...(c.seriesProperty ? { series: propName(schema, c.seriesProperty), ...(c.seriesBucket ? { seriesBucket: c.seriesBucket } : {}) } : {}),
    sort: c.sort ?? 'default',
    showLegend: !!c.showLegend,
    showLabels: !!c.showLabels,
    hideEmpty: !!c.hideEmpty,
  };
}

/** Readable description of a view (property and option names), with the settings of its type. */
export function describeView(v: View, schema: DatabaseSchema): Record<string, unknown> {
  const c = v.config;
  const out: Record<string, unknown> = {
    id: v.id,
    nom: v.name,
    type: v.type,
    filtres: c.filter ? c.filter.rules.length + (c.filter.groups ?? []).reduce((n, g) => n + g.rules.length, 0) : 0,
    tris: c.sorts.map((s) => `${propName(schema, s.propertyId)} ${s.direction}`),
    groupePar: propName(schema, c.groupBy),
  };
  if (v.type === 'feed') out.previewLines = c.feedPreviewLines ?? 3;
  if (isChartView(v.type)) out.chart = describeChart(c.chart, schema);
  if (v.type === 'dashboard') {
    out.widgets = (c.widgets ?? []).map((w) => ({
      type: w.type,
      ...(w.title ? { title: w.title } : {}),
      ...(w.type === 'list' ? { limit: w.limit ?? 5, sorts: (w.sorts ?? []).map((s) => `${propName(schema, s.propertyId)} ${s.direction}`) } : { chart: describeChart(w.chart, schema) }),
      ...(w.filter ? { filtres: w.filter.rules.length } : {}),
      w: w.w,
      h: w.h,
    }));
  }
  if (v.type === 'map') out.place = propName(schema, c.placeProperty);
  if (v.type === 'form' && c.form) {
    const f = c.form;
    const byId = new Map(f.questions.map((q) => [q.id, q]));
    out.form = {
      ...(f.title ? { title: f.title } : {}),
      ...(f.description ? { description: f.description } : {}),
      questions: f.questions.map((q) => {
        const cond = q.showIf ? byId.get(q.showIf.questionId) : undefined;
        const condProp = cond ? schema.properties.find((p) => p.id === cond.propertyId) : undefined;
        return {
          property: propName(schema, q.propertyId),
          ...(q.label ? { label: q.label } : {}),
          ...(q.description ? { description: q.description } : {}),
          required: !!q.required,
          ...(q.showIf
            ? { showIf: { question: condProp?.name ?? q.showIf.questionId, value: condProp?.options?.find((o) => o.id === q.showIf!.value)?.name ?? q.showIf.value } }
            : {}),
        };
      }),
      acceptResponses: f.acceptResponses,
      public: !!f.isPublic,
      ...(f.submitLabel ? { submitLabel: f.submitLabel } : {}),
      ...(f.confirmation ? { confirmation: f.confirmation } : {}),
    };
  }
  return out;
}
