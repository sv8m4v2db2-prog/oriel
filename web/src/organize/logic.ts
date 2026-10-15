// Pure helpers of the organize module (no React): labels of groups and property values.
import type { Member, PageGroupBy, PageProp, PagePropValue, PageTypeFilter, Tag } from '@oriel/shared';

export const KIND_LABELS: Record<PageTypeFilter, string> = {
  page: 'Page',
  database: 'Base de données',
  row: 'Ligne de base',
  template: 'Modèle',
  journal: 'Journal',
};

export const BASE_COLUMNS: Array<{ id: string; label: string }> = [
  { id: 'tags', label: 'Tags' },
  { id: 'parent', label: 'Dans' },
  { id: 'author', label: 'Modifiée par' },
  { id: 'created', label: 'Créée' },
  { id: 'updated', label: 'Modifiée' },
];

export interface ResultsContext {
  workspaceId: string;
  tags: Map<string, Tag>;
  props: Map<string, PageProp>;
  members: Map<string, Member>;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function groupLabel(group: PageGroupBy, key: string, ctx: ResultsContext): string {
  if (group === 'none') return '';
  if (group === 'tag') return key ? ctx.tags.get(key)?.name ?? 'Tag' : 'Sans tag';
  if (group === 'author') return ctx.members.get(key)?.user.name ?? 'Auteur inconnu';
  if (group === 'created_month' || group === 'updated_month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : 'Sans date';
  }
  if (group === 'type') return KIND_LABELS[key as keyof typeof KIND_LABELS] ?? key;
  if (typeof group === 'object') {
    const def = ctx.props.get(group.prop);
    if (def?.type === 'checkbox') return key === '1' ? `${def.name} : oui` : `${def.name} : non`;
    return key ? def?.options.find((o) => o.id === key)?.name ?? '—' : `${def?.name ?? 'Propriété'} : vide`;
  }
  return key;
}

export function formatPropValue(def: PageProp, value: PagePropValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (def.type === 'checkbox') return value ? 'Oui' : 'Non';
  if (def.type === 'select') return def.options.find((o) => o.id === value)?.name ?? '';
  if (def.type === 'date' && typeof value === 'string') {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  return String(value);
}

