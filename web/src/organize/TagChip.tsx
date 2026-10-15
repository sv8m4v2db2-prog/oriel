// Colored tag chip, tag picker (choose / create on the fly) and colour swatches.
import { useMemo, useState, type ReactNode } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { TAG_COLORS, type Tag, type TagColor } from '@oriel/shared';
import { normalizeText } from '../lib/util';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { orgApi } from './api';
import { invalidateOrg } from './hooks';

export const COLOR_LABELS: Record<TagColor, string> = {
  gray: 'Gris',
  brown: 'Marron',
  orange: 'Orange',
  yellow: 'Jaune',
  green: 'Vert',
  teal: 'Turquoise',
  blue: 'Bleu',
  purple: 'Violet',
  pink: 'Rose',
  red: 'Rouge',
  indigo: 'Indigo',
  lime: 'Citron vert',
};

export function TagChip({
  tag,
  onRemove,
  onClick,
  children,
}: {
  tag: Pick<Tag, 'name' | 'color'>;
  onRemove?: () => void;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <span
      className={`tag org-tag${onClick ? ' is-clickable' : ''}`}
      data-color={tag.color}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      <span className="org-tag__name">{tag.name}</span>
      {children}
      {onRemove && (
        <button
          type="button"
          className="org-tag__remove"
          aria-label={`Retirer le tag ${tag.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function ColorSwatches({ value, onChange }: { value: TagColor; onChange: (c: TagColor) => void }) {
  return (
    <div className="org-swatches" role="radiogroup" aria-label="Couleur">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_LABELS[c]}
          title={COLOR_LABELS[c]}
          className={`org-swatch tag${value === c ? ' is-selected' : ''}`}
          data-color={c}
          onClick={() => onChange(c)}
        >
          {value === c && <Check size={12} />}
        </button>
      ))}
    </div>
  );
}

/** Search box + list of tags with checkboxes; typing a new name offers to create it. */
export function TagPicker({
  workspaceId,
  tags,
  selected,
  onToggle,
  canCreate,
}: {
  workspaceId: string;
  tags: Tag[];
  selected: ReadonlySet<string>;
  onToggle: (tagId: string, on: boolean) => void;
  canCreate: boolean;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const n = normalizeText(q);
    return tags.filter((t) => !n || normalizeText(t.name).includes(n));
  }, [tags, q]);
  const exact = tags.some((t) => normalizeText(t.name) === normalizeText(q.trim()));

  const create = async () => {
    const name = q.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const tag = await orgApi.createTag(workspaceId, { name });
      invalidateOrg('tags');
      setQ('');
      onToggle(tag.id, true);
    } catch (e) {
      toast.error(errorMessage(e, 'Création du tag impossible.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="org-picker">
      <input
        className="org-picker__search"
        placeholder="Chercher ou créer un tag…"
        aria-label="Chercher ou créer un tag"
        value={q}
        maxLength={40}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim() && !exact && canCreate) void create();
        }}
      />
      <ul className="org-picker__list">
        {shown.map((t) => {
          const on = selected.has(t.id);
          return (
            <li key={t.id}>
              <button type="button" className="org-picker__row" role="checkbox" aria-checked={on} onClick={() => onToggle(t.id, !on)}>
                <span className="org-picker__check">{on && <Check size={13} />}</span>
                <TagChip tag={t} />
                <span className="org-picker__count">{t.pageCount}</span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && !q.trim() && <li className="org-picker__empty">Aucun tag dans cet espace.</li>}
      </ul>
      {canCreate && q.trim() && !exact && (
        <button type="button" className="org-picker__create" disabled={busy} onClick={() => void create()}>
          <Plus size={14} /> Créer « {q.trim()} »
        </button>
      )}
    </div>
  );
}
