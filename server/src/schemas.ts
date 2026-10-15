// zod schemas for request bodies (shapes from shared/src/api.ts).
import { z } from 'zod';
import {
  COLORS,
  COVER_COLORS,
  COVER_GRADIENTS,
  LIMITS,
  MAX_NUMBER_PRECISION,
  NUMBER_FORMATS,
  type Color,
  type NumberFormat,
} from '@oriel/shared';

const PROPERTY_TYPES = [
  'title',
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
  'verification',
  'last_visited',
] as const;

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

const CHART_TYPES = ['chart_bar', 'chart_hbar', 'chart_line', 'chart_donut', 'chart_number'] as const;
const VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline', 'feed', ...CHART_TYPES, 'dashboard', 'map', 'form'] as const;
const DATE_BUCKETS = ['day', 'week', 'month', 'year'] as const;
const FILTER_OPERATORS = [
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
] as const;
const CALCULATIONS = [
  'none',
  'count_all',
  'count_values',
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
  'checked',
  'unchecked',
  'percent_checked',
] as const;

export const uuidLike = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'identifiant invalide');
const shortText = (max: number) => z.string().max(max);
const after = z.string().max(128).nullable().optional();

const imageUrl = z
  .string()
  .max(2000)
  .refine((s) => s.startsWith('/') || /^https?:\/\//i.test(s), 'URL invalide');

export const coverSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image'), url: imageUrl }),
  z.object({ type: z.literal('gradient'), value: z.string().refine((v) => v in COVER_GRADIENTS, 'dégradé inconnu') }),
  z.object({ type: z.literal('color'), value: z.string().refine((v) => v in COVER_COLORS, 'couleur inconnue') }),
]);

const iconSchema = z.string().max(500).nullable();
const visibility = z.enum(['workspace', 'private']);
const parentType = z.enum(['workspace', 'page', 'database']);
const propertiesRecord = z.record(z.string().max(64), z.unknown());

// --- auth / account ---------------------------------------------------------

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(LIMITS.passwordMin).max(256),
  inviteToken: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().max(320),
  password: z.string().max(256),
});

export const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  avatarUrl: imageUrl.nullable().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: z.string().min(LIMITS.passwordMin).max(256),
});

// --- workspaces -------------------------------------------------------------

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  icon: iconSchema.optional(),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: iconSchema.optional(),
});

export const updateMemberSchema = z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']) });

export const createInviteSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const adminSettingsSchema = z.object({ signupMode: z.enum(['first-user', 'invite', 'open']).optional() });

// --- pages ------------------------------------------------------------------

export const createPageSchema = z.object({
  id: uuidLike.optional(),
  parentType,
  parentId: z.string().min(1).max(128),
  kind: z.enum(['page', 'database']).optional(),
  title: shortText(LIMITS.titleLength).optional(),
  icon: iconSchema.optional(),
  cover: coverSchema.nullable().optional(),
  visibility: visibility.optional(),
  properties: propertiesRecord.optional(),
  isInline: z.boolean().optional(),
  emptyDatabase: z.boolean().optional(),
  after,
});

export const updatePageSchema = z.object({
  title: shortText(LIMITS.titleLength).optional(),
  icon: iconSchema.optional(),
  cover: coverSchema.nullable().optional(),
  format: z
    .object({
      fullWidth: z.boolean().nullable().optional(),
      teamspaceRoot: z.boolean().nullable().optional(),
      sharedShortcut: z.boolean().nullable().optional(),
      smallText: z.boolean().nullable().optional(),
      coverPosition: z.number().min(0).max(100).nullable().optional(),
      // editor module: page options
      font: z.enum(['default', 'serif', 'mono']).nullable().optional(),
      locked: z.boolean().nullable().optional(),
      seed: z.literal('welcome').nullable().optional(),
      // reading module: page customization (SPEC §13.5)
      hideBacklinks: z.boolean().nullable().optional(),
      hideComments: z.boolean().nullable().optional(),
      hideProperties: z.boolean().nullable().optional(),
      toc: z.boolean().nullable().optional(),
    })
    .optional(),
  properties: propertiesRecord.optional(),
});

export const movePageSchema = z.object({
  parentType,
  parentId: z.string().min(1).max(128),
  visibility: visibility.optional(),
  after,
  /** Navigation module: explicit consent when the move widens access across teamspaces. */
  confirmAccess: z.boolean().optional(),
});

export const publishSchema = z.object({ isPublic: z.boolean() });
export const favoriteSchema = z.object({ favorite: z.boolean(), after });

// --- databases ----------------------------------------------------------------

const optionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  name: z.string().trim().min(1).max(200),
  color: z.enum(COLORS as [Color, ...Color[]]).default('default'),
  group: z.enum(['todo', 'in_progress', 'done']).optional(),
});

const propertyFields = {
  name: z.string().max(200).optional(),
  options: z.array(optionSchema).max(1000).optional(),
  numberFormat: z.enum(NUMBER_FORMATS as [NumberFormat, ...NumberFormat[]]).optional(),
  // G1 / D25-D26: null clears the setting.
  numberPrecision: z.number().int().min(0).max(MAX_NUMBER_PRECISION).nullable().optional(),
  numberDisplay: z.enum(['number', 'bar', 'ring']).nullable().optional(),
  numberMax: z.number().positive().max(1e12).nullable().optional(),
  numberColor: z.enum(COLORS as [Color, ...Color[]]).nullable().optional(),
  dateReminder: z
    .object({
      mode: z.enum(['none', 'same_day', 'day_before', 'two_days_before', 'week_before']),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    })
    .nullable()
    .optional(),
  formula: z.string().max(10_000).optional(),
  relation: z
    .object({
      databaseId: z.string().min(1).max(128),
      // Managed by the server (ignored when sent).
      syncedPropertyId: z.string().max(64).optional(),
      singlePage: z.boolean().optional(),
      // Row page display of the relation (D31).
      rowPageDisplay: z.enum(['property', 'section', 'hidden']).optional(),
      sectionLayout: z.enum(['list', 'table']).optional(),
    })
    .optional(),
  rollup: z
    .object({
      relationPropertyId: z.string().max(64),
      targetPropertyId: z.string().max(64),
      function: z.enum(ROLLUP_FUNCTIONS),
    })
    .optional(),
  uniqueIdPrefix: z
    .string()
    .max(20)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
};

const twoWaySchema = z.object({ name: z.string().max(200).optional(), pairWith: z.string().min(1).max(64).optional() });

export const createPropertySchema = z.object({
  property: z.object({
    id: z.string().regex(/^[a-z0-9]{4,8}$/).optional(),
    type: z.enum(PROPERTY_TYPES),
    ...propertyFields,
  }),
  twoWay: twoWaySchema.optional(),
  after,
});

export const updatePropertySchema = z.object({
  type: z.enum(PROPERTY_TYPES).optional(),
  ...propertyFields,
  twoWay: twoWaySchema.nullable().optional(),
});
export const positionSchema = z.object({ after });

export const createRowSchema = z.object({
  id: uuidLike.optional(),
  title: shortText(LIMITS.titleLength).optional(),
  icon: iconSchema.optional(),
  properties: propertiesRecord.optional(),
  templateId: uuidLike.optional(),
  after,
  /** QA-EDT-05: the row is added by a button of this page (assertButtonTarget). */
  viaButtonOn: uuidLike.optional(),
});

export const createTemplateSchema = z.object({
  title: shortText(LIMITS.titleLength).optional(),
  fromTemplateId: uuidLike.optional(),
  /** I1: copy of an existing row (with its sub-pages) as a template; the original may go to the trash. */
  fromRowId: uuidLike.optional(),
  trashOriginal: z.boolean().optional(),
});

/** I1: recurring template (validated further by recurrenceProblem). */
export const templateRecurrenceSchema = z.object({
  recurrence: z
    .object({
      frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
      interval: z.number().int().min(1).max(365),
      weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
      startDate: z.string().max(10),
      time: z.string().max(5),
      endDate: z.string().max(10).nullable().optional(),
    })
    .nullable(),
});

/** I1: manual order of a row in one view. */
export const moveViewRowSchema = z.object({ rowId: uuidLike, after: uuidLike.nullable() });

export const setDefaultTemplateSchema = z.object({ templateId: uuidLike.nullable() });

export const importRowsSchema = z.object({
  rows: z
    .array(z.object({ title: shortText(LIMITS.titleLength).optional(), properties: propertiesRecord.optional() }))
    .max(5000),
  updateByTitle: z.boolean().optional(),
});

export const deletePropertyQuerySchema = z.object({ mirror: z.enum(['delete', 'keep']).optional() });
export const linkQuerySchema = z.object({ linkId: uuidLike.optional() });

// --- views ------------------------------------------------------------------

const propId = z.string().max(64);
const filterRules = z
  .array(
    z.object({
      id: z.string().max(64),
      propertyId: propId,
      operator: z.enum(FILTER_OPERATORS),
      value: z.unknown().optional(),
      quantifier: z.enum(['any', 'every', 'none']).optional(),
    }),
  )
  .max(100);
const filterGroupSchema = z.object({
  conjunction: z.enum(['and', 'or']),
  rules: filterRules,
  // One level of nested groups.
  groups: z.array(z.object({ conjunction: z.enum(['and', 'or']), rules: filterRules })).max(20).optional(),
});
const sortsSchema = z.array(z.object({ propertyId: propId, direction: z.enum(['asc', 'desc']) })).max(50);
const chartConfigSchema = z.object({
  xProperty: propId.nullable(),
  xBucket: z.enum(DATE_BUCKETS).optional(),
  aggregate: z.enum(['count', 'sum', 'average', 'min', 'max']),
  valueProperty: propId.nullable(),
  seriesProperty: propId.nullable().optional(),
  seriesBucket: z.enum(DATE_BUCKETS).optional(),
  sort: z.enum(['default', 'label_asc', 'label_desc', 'value_asc', 'value_desc']).optional(),
  showLegend: z.boolean().optional(),
  showLabels: z.boolean().optional(),
  hideEmpty: z.boolean().optional(),
});
const widgetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.enum([...CHART_TYPES, 'list']),
  title: z.string().max(200).optional(),
  chart: chartConfigSchema.optional(),
  filter: filterGroupSchema.nullable().optional(),
  sorts: sortsSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  w: z.number().int().min(1).max(4),
  h: z.number().int().min(1).max(3),
});
const formConfigSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  questions: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        propertyId: propId,
        label: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
        required: z.boolean().optional(),
        showIf: z.object({ questionId: z.string().max(64), value: z.string().max(200) }).nullable().optional(),
      }),
    )
    .max(100),
  acceptResponses: z.boolean(),
  isPublic: z.boolean().optional(),
  submitLabel: z.string().max(100).optional(),
  confirmation: z.string().max(2000).optional(),
});

export const viewConfigPartial = z.object({
  filter: filterGroupSchema.nullable().optional(),
  sorts: sortsSchema.optional(),
  groupBy: propId.nullable().optional(),
  hiddenGroups: z.array(z.string().max(200)).max(1000).optional(),
  collapsedGroups: z.array(z.string().max(200)).max(1000).optional(),
  propertyOrder: z.array(propId).max(1000).optional(),
  hiddenProperties: z.array(propId).max(1000).optional(),
  propertyWidths: z.record(propId, z.number().min(0).max(10_000)).optional(),
  calculations: z.record(propId, z.enum(CALCULATIONS)).optional(),
  wrap: z.boolean().optional(),
  cardCover: z.enum(['none', 'cover']).optional(),
  cardSize: z.enum(['small', 'medium', 'large']).optional(),
  dateProperty: propId.nullable().optional(),
  dateEndProperty: propId.nullable().optional(),
  timelineScale: z.enum(['week', 'month']).optional(),
  dependencyProperty: propId.nullable().optional(),
  calendarMode: z.enum(['month', 'week']).optional(),
  feedPreviewLines: z.number().int().min(0).max(20).optional(),
  chart: chartConfigSchema.optional(),
  widgets: z.array(widgetSchema).max(24).optional(),
  placeProperty: propId.nullable().optional(),
  form: formConfigSchema.optional(),
  /** I1: template of the view's « Nouveau » button (null = the database default, 'blank' = empty row). */
  defaultTemplateId: z.union([uuidLike, z.literal('blank')]).nullable().optional(),
});

/** Form submission (members and public); per-question values are validated against the property types. */
export const submitFormSchema = z.object({
  answers: z.record(z.string().max(64), z.unknown()).refine((a) => Object.keys(a).length <= 100, 'trop de réponses'),
  website: z.string().max(500).optional(),
});

export const createViewSchema = z.object({
  id: uuidLike.optional(),
  linkId: uuidLike.optional(),
  name: z.string().trim().max(200),
  type: z.enum(VIEW_TYPES),
  config: viewConfigPartial.optional(),
  after,
});

export const updateViewSchema = z.object({
  name: z.string().trim().max(200).optional(),
  type: z.enum(VIEW_TYPES).optional(),
  config: viewConfigPartial.optional(),
});
