import type {
  ChartConfig,
  ChartViewType,
  Color,
  FormQuestion,
  NumberFormat,
  PropertyDef,
  PropertyType,
  SelectOption,
  StatusGroup,
  ViewConfig,
  ViewType,
  WorkspaceRole,
} from './types.js';

export const APP_NAME = 'Oriel';

export const COLORS: Color[] = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
];

export const COLOR_LABELS: Record<Color, string> = {
  default: 'Par défaut',
  gray: 'Gris',
  brown: 'Marron',
  orange: 'Orange',
  yellow: 'Jaune',
  green: 'Vert',
  blue: 'Bleu',
  purple: 'Violet',
  pink: 'Rose',
  red: 'Rouge',
};

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  title: 'Titre',
  text: 'Texte',
  number: 'Nombre',
  select: 'Sélection',
  multi_select: 'Multi-sélection',
  status: 'Statut',
  date: 'Date',
  person: 'Personne',
  checkbox: 'Case à cocher',
  url: 'URL',
  email: 'E-mail',
  phone: 'Téléphone',
  files: 'Fichiers et médias',
  relation: 'Relation',
  formula: 'Formule',
  created_time: 'Date de création',
  created_by: 'Créé par',
  last_edited_time: 'Dernière modification',
  last_edited_by: 'Modifié par',
  unique_id: 'ID unique',
  rollup: 'Rollup',
  place: 'Lieu',
  last_visited: 'Dernière consultation',
  verification: 'Vérification',
};

/**
 * Fixed options of `verification` properties (D21): the derived state of a row, used by filters and
 * sorts. No value = « Non vérifiée » (empty).
 */
export const VERIFICATION_OPTIONS: SelectOption[] = [
  { id: 'verified', name: 'Vérifiée', color: 'green' },
  { id: 'expired', name: 'À revérifier', color: 'orange' },
];

/** Types whose values are computed and never written by clients. */
export const COMPUTED_PROPERTY_TYPES: PropertyType[] = [
  'formula',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'rollup',
  'last_visited',
];

/**
 * Page metadata shown as properties: the value is part of every page (`createdAt`, `createdBy`,
 * `updatedAt`, `updatedBy`), so per-property rights (D30) could not hide it and are refused (QA-G3-04).
 */
export const PAGE_METADATA_PROPERTY_TYPES: PropertyType[] = ['created_time', 'created_by', 'last_edited_time', 'last_edited_by'];

export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  table: 'Tableau',
  board: 'Kanban',
  list: 'Liste',
  gallery: 'Galerie',
  calendar: 'Calendrier',
  timeline: 'Chronologie',
  feed: 'Fil d’actualité',
  chart_bar: 'Graphique à barres verticales',
  chart_hbar: 'Graphique à barres horizontales',
  chart_line: 'Graphique en lignes',
  chart_donut: 'Graphique en anneau',
  chart_number: 'Graphique numérique',
  dashboard: 'Tableau de bord',
  map: 'Carte',
  form: 'Formulaire',
};

/** Every view type, in menu order. */
export const VIEW_TYPES: ViewType[] = [
  'table',
  'board',
  'list',
  'gallery',
  'calendar',
  'timeline',
  'feed',
  'chart_bar',
  'chart_hbar',
  'chart_line',
  'chart_donut',
  'chart_number',
  'dashboard',
  'map',
  'form',
];

export const CHART_VIEW_TYPES: ChartViewType[] = ['chart_bar', 'chart_hbar', 'chart_line', 'chart_donut', 'chart_number'];

export const isChartView = (type: string): type is ChartViewType => (CHART_VIEW_TYPES as string[]).includes(type);

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: 'Membre',
  viewer: 'Lecteur',
};

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  todo: 'À faire',
  in_progress: 'En cours',
  done: 'Terminé',
};

export const DEFAULT_STATUS_OPTIONS: SelectOption[] = [
  { id: 'not_started', name: 'Pas commencé', color: 'default', group: 'todo' },
  { id: 'in_progress', name: 'En cours', color: 'blue', group: 'in_progress' },
  { id: 'done', name: 'Terminé', color: 'green', group: 'done' },
];

/** Predefined cover gradients (CSS background values). */
export const COVER_GRADIENTS: Record<string, string> = {
  aurora: 'linear-gradient(120deg, #0f2027 0%, #203a43 45%, #2c5364 100%)',
  glacier: 'linear-gradient(135deg, #e0f2fe 0%, #a5d8ff 50%, #74c0fc 100%)',
  dawn: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  lagoon: 'linear-gradient(135deg, #43cea2 0%, #185a9d 100%)',
  lavender: 'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
  ember: 'linear-gradient(135deg, #f12711 0%, #f5af19 100%)',
  night: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  moss: 'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)',
};

export const COVER_COLORS: Record<string, string> = {
  red: '#e03e3e',
  orange: '#d9730d',
  yellow: '#dfab01',
  green: '#0f7b6c',
  blue: '#0b6e99',
  purple: '#6940a5',
  pink: '#ad1a72',
  gray: '#9b9a97',
};

export const TITLE_PROPERTY_ID = 'title';

/** Number formats that display a currency, with their ISO 4217 code (G1 / D25). */
export const NUMBER_CURRENCY_CODES: Partial<Record<NumberFormat, string>> = {
  euro: 'EUR',
  dollar: 'USD',
  gbp: 'GBP',
  chf: 'CHF',
  cad: 'CAD',
  jpy: 'JPY',
  aud: 'AUD',
  cny: 'CNY',
  sek: 'SEK',
  nok: 'NOK',
  dkk: 'DKK',
  pln: 'PLN',
  czk: 'CZK',
  brl: 'BRL',
  mxn: 'MXN',
  inr: 'INR',
  krw: 'KRW',
};

/** Every number format, in menu order. */
export const NUMBER_FORMATS: NumberFormat[] = [
  'number',
  'number_with_commas',
  'percent',
  ...(Object.keys(NUMBER_CURRENCY_CODES) as NumberFormat[]),
];

/** Decimals of a number property: bounds of `PropertyDef.numberPrecision`. */
export const MAX_NUMBER_PRECISION = 10;

/** Default schema for a brand new database. */
export function defaultDatabaseProperties(newShortId: () => string): PropertyDef[] {
  return [
    { id: TITLE_PROPERTY_ID, name: 'Nom', type: 'title' },
    { id: newShortId(), name: 'Étiquettes', type: 'multi_select', options: [] },
  ];
}

/**
 * Default configuration for a new view. Tables show every property; other layouts only the title
 * (users reveal more from the view's "Propriétés" menu).
 */
export function defaultViewConfig(type: ViewType, properties: PropertyDef[]): ViewConfig {
  const nonTitle = properties.filter((p) => p.type !== 'title').map((p) => p.id);
  const firstOf = (types: PropertyType[]) => properties.find((p) => types.includes(p.type))?.id ?? null;
  const date = firstOf(['date', 'created_time', 'last_edited_time']);
  return {
    filter: null,
    sorts: [],
    groupBy: type === 'board' ? firstOf(['status', 'select']) : null,
    hiddenGroups: [],
    collapsedGroups: [],
    propertyOrder: properties.map((p) => p.id),
    hiddenProperties: type === 'table' ? [] : nonTitle,
    propertyWidths: {},
    calculations: {},
    wrap: false,
    cardCover: type === 'gallery' ? 'cover' : 'none',
    cardSize: 'medium',
    dateProperty: type === 'calendar' || type === 'timeline' ? date : null,
    dateEndProperty: null,
    timelineScale: 'week',
    ...extraViewDefaults(type, properties),
  };
}

/** Types offered as form questions (computed types excluded). */
export const FORM_QUESTION_TYPES: PropertyType[] = [
  'title',
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
  'person',
  'relation',
  'files',
  'place',
];

/** Question types accepted from anonymous (public) submissions. */
export const PUBLIC_FORM_QUESTION_TYPES: PropertyType[] = [
  'title',
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
];

/** Default chart settings: rows counted by the first select / status / person / checkbox / date property. */
export function defaultChartConfig(type: ChartViewType, properties: PropertyDef[]): ChartConfig {
  const x = ['status', 'select', 'person', 'checkbox', 'multi_select', 'date'].map((t) => properties.find((p) => p.type === t)).find(Boolean);
  return {
    xProperty: type === 'chart_number' ? null : (x?.id ?? null),
    aggregate: 'count',
    valueProperty: null,
    seriesProperty: null,
    sort: 'default',
    showLegend: type === 'chart_donut',
    showLabels: type !== 'chart_line',
    hideEmpty: false,
  };
}

function extraViewDefaults(type: ViewType, properties: PropertyDef[]): Partial<ViewConfig> {
  switch (type) {
    case 'feed':
      return { feedPreviewLines: 3 };
    case 'chart_bar':
    case 'chart_hbar':
    case 'chart_line':
    case 'chart_donut':
    case 'chart_number':
      return { chart: defaultChartConfig(type, properties) };
    case 'dashboard':
      return {
        widgets: [
          { id: 'w1', type: 'chart_number', title: 'Nombre de lignes', chart: defaultChartConfig('chart_number', properties), w: 1, h: 1 },
          { id: 'w2', type: 'chart_bar', chart: defaultChartConfig('chart_bar', properties), w: 2, h: 2 },
          { id: 'w3', type: 'list', title: 'Dernières lignes', limit: 5, w: 1, h: 2 },
        ],
      };
    case 'map':
      return { placeProperty: properties.find((p) => p.type === 'place')?.id ?? null };
    case 'form': {
      const questions: FormQuestion[] = properties
        .filter((p) => FORM_QUESTION_TYPES.includes(p.type))
        .slice(0, 8)
        .map((p, i) => ({ id: `q${i + 1}`, propertyId: p.id, required: p.type === 'title' }));
      return { form: { questions, acceptResponses: true, isPublic: false } };
    }
    default:
      return {};
  }
}

/** Editor block / inline-content type names that carry page references (shared with the server). */
export const EDITOR_TYPES = {
  /** Block: link card to a child page. props: { pageId } */
  subpage: 'subpage',
  /** Block: link card to any existing page. props: { pageId } */
  pageLink: 'pageLink',
  /** Block: inline database. props: { databaseId } */
  database: 'database',
  /** Block: callout. props: { emoji, backgroundColor } */
  callout: 'callout',
  /** Block: table of contents (no props) */
  toc: 'toc',
  /** Block: divider (no props) */
  divider: 'divider',
  /** Inline content: page mention. props: { pageId } */
  pageMention: 'pageMention',
  /** Block: linked view of an existing database, with its own views. props: { databaseId, linkId } */
  linkedDatabase: 'linkedDatabase',
} as const;

export const LIMITS = {
  titleLength: 2000,
  passwordMin: 8,
  uploadMaxMbDefault: 25,
  sessionDays: 30,
  trashRetentionDays: 30,
  inviteDefaultDays: 7,
} as const;
