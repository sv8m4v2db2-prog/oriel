// Version history (G6): French labels of block types, block settings and property values. Pure.
import type { PropertyDef, PropertyValue } from '@oriel/shared';

const TYPES: Record<string, string> = {
  paragraph: 'Paragraphe',
  bulletListItem: 'Liste à puces',
  numberedListItem: 'Liste numérotée',
  checkListItem: 'Case à cocher',
  toggleListItem: 'Liste dépliante',
  quote: 'Citation',
  codeBlock: 'Code',
  table: 'Tableau',
  image: 'Image',
  video: 'Vidéo',
  audio: 'Audio',
  file: 'Fichier',
  columnList: 'Colonnes',
  column: 'Colonne',
  subpage: 'Sous-page',
  pageLink: 'Lien vers une page',
  database: 'Base de données intégrée',
  callout: 'Encadré',
  toc: 'Table des matières',
  divider: 'Séparateur',
  syncedBlock: 'Bloc synchronisé',
  bookmark: 'Signet',
  embed: 'Intégration',
  equation: 'Équation',
  button: 'Bouton',
  breadcrumb: "Fil d'Ariane",
  tabs: 'Onglets',
  html: 'Bloc HTML',
};

export function typeLabel(type: string, props: Record<string, string> = {}): string {
  if (type === 'heading') return `Titre ${props.level ?? ''}`.trim();
  if (type === 'toggleHeading') return `Titre dépliant ${props.level ?? ''}`.trim();
  return TYPES[type] ?? type;
}

const PROPS: Record<string, string> = {
  level: 'Niveau',
  checked: 'Cochée',
  textColor: 'Couleur du texte',
  backgroundColor: 'Couleur de fond',
  textAlignment: 'Alignement',
  language: 'Langage',
  url: 'Adresse',
  name: 'Nom',
  caption: 'Légende',
  emoji: 'Emoji',
  width: 'Largeur',
  isToggleable: 'Dépliable',
};

export const propLabel = (key: string): string => PROPS[key] ?? key;

export function propValueLabel(value: string | null): string {
  if (value === null || value === '') return '—';
  if (value === 'true') return 'oui';
  if (value === 'false') return 'non';
  if (value === 'default') return 'par défaut';
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** Plain-text rendering of a property value for the « Propriétés » section of a comparison. */
export function formatPropertyValue(def: Pick<PropertyDef, 'type' | 'options'>, value: PropertyValue | undefined): string {
  if (value === undefined || value === null || value === '') return '—';
  const option = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
  switch (def.type) {
    case 'checkbox':
      return value ? 'oui' : 'non';
    case 'select':
    case 'status':
      return typeof value === 'string' ? option(value) : '—';
    case 'multi_select':
      return Array.isArray(value) ? (value as string[]).map(option).join(', ') || '—' : '—';
    case 'person':
      return Array.isArray(value) ? `${value.length} personne${value.length > 1 ? 's' : ''}` : '—';
    case 'relation':
      return Array.isArray(value) ? `${value.length} page${value.length > 1 ? 's' : ''} liée${value.length > 1 ? 's' : ''}` : '—';
    case 'files':
      return Array.isArray(value) ? `${value.length} fichier${value.length > 1 ? 's' : ''}` : '—';
    default:
      break;
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  const v = value as unknown as Record<string, unknown>;
  if (typeof v.start === 'string') return v.end ? `${v.start} → ${String(v.end)}` : v.start;
  if (typeof v.name === 'string') return v.name;
  return JSON.stringify(value);
}

export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
