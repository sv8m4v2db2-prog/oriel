// Under a page's title: its workspace tags and workspace properties (outside databases).
// Tags and property values are metadata: whoever can edit the page may change them, even when
// the content is locked. Rendered by page/PageView.tsx.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Popover } from '@mantine/core';
import { Plus, SlidersHorizontal, Tag as TagIcon } from 'lucide-react';
import type { PageProp, PagePropValue } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { orgApi, ok } from './api';
import { invalidateOrg, usePageOrganization, usePageProps, useTags } from './hooks';
import { queryClient } from '../lib/queryClient';
import { TagChip, TagPicker } from './TagChip';
import './organize.css';

export function PageOrganizeBar({ pageId, workspaceId, canEdit }: { pageId: string; workspaceId: string; canEdit: boolean }) {
  const org = usePageOrganization(pageId);
  const tags = useTags(workspaceId);
  const props = usePageProps(workspaceId);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  if (!org.data || !tags.data || !props.data) return null;

  const tagIds = org.data.tagIds;
  const values = org.data.props;
  const byId = new Map(tags.data.map((t) => [t.id, t] as const));
  const chips = tagIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
  const hasValue = (p: PageProp) => values[p.id] !== undefined && values[p.id] !== null && values[p.id] !== '' && !(p.type === 'checkbox' && values[p.id] === false);
  const shown = props.data.filter((p) => p.display === 'always' || (p.display === 'hide_empty' && hasValue(p)));
  const addable = props.data.filter((p) => !shown.includes(p));
  const visibleProps = [...shown, ...props.data.filter((p) => extra.includes(p.id) && !shown.includes(p))];

  if (!canEdit && chips.length === 0 && visibleProps.length === 0) return null;

  const saveTags = async (next: string[]) => {
    queryClient.setQueryData(ok.pageOrg(pageId), { ...org.data, tagIds: next });
    try {
      await orgApi.setPageTags(pageId, next);
    } catch (e) {
      toast.error(errorMessage(e, 'Modification des tags impossible.'));
    } finally {
      invalidateOrg('page-org', 'tags', 'list');
    }
  };

  return (
    <div className="page-width org-bar" data-testid="org-bar">
      <div className="org-bar__tags">
        <TagIcon size={14} className="org-bar__icon" aria-hidden />
        {chips.map((t) => (
          <Link key={t.id} to={`/w/${workspaceId}/tags/${t.id}`} className="org-bar__link" title={`Pages avec le tag ${t.name}`}>
            <TagChip tag={t} onRemove={canEdit ? () => void saveTags(tagIds.filter((x) => x !== t.id)) : undefined} />
          </Link>
        ))}
        {canEdit && (
          <Popover opened={tagsOpen} onChange={setTagsOpen} position="bottom-start" width={260} shadow="md" withinPortal>
            <Popover.Target>
              <button type="button" className="org-bar__add" onClick={() => setTagsOpen((o) => !o)}>
                <Plus size={13} /> {chips.length === 0 ? 'Ajouter un tag' : 'Tag'}
              </button>
            </Popover.Target>
            <Popover.Dropdown p={6}>
              <TagPicker
                workspaceId={workspaceId}
                tags={tags.data}
                selected={new Set(tagIds)}
                canCreate
                onToggle={(id, on) => void saveTags(on ? [...new Set([...tagIds, id])] : tagIds.filter((x) => x !== id))}
              />
            </Popover.Dropdown>
          </Popover>
        )}
      </div>

      {(visibleProps.length > 0 || (canEdit && addable.length > 0)) && (
        <div className="org-bar__props">
          {visibleProps.map((p) => (
            <PropRow key={p.id} prop={p} pageId={pageId} value={values[p.id] ?? null} canEdit={canEdit} />
          ))}
          {canEdit && addable.length > 0 && (
            <Popover opened={propsOpen} onChange={setPropsOpen} position="bottom-start" width={240} shadow="md" withinPortal>
              <Popover.Target>
                <button type="button" className="org-bar__add" onClick={() => setPropsOpen((o) => !o)}>
                  <SlidersHorizontal size={13} /> Propriété
                </button>
              </Popover.Target>
              <Popover.Dropdown p={4}>
                <ul className="org-picker__list">
                  {addable.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="org-picker__row"
                        onClick={() => {
                          setExtra((e) => [...e, p.id]);
                          setPropsOpen(false);
                        }}
                      >
                        {p.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </Popover.Dropdown>
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

function PropRow({ prop, pageId, value, canEdit }: { prop: PageProp; pageId: string; value: PagePropValue; canEdit: boolean }) {
  const save = async (next: PagePropValue) => {
    try {
      await orgApi.setPropValue(pageId, prop.id, next);
    } catch (e) {
      toast.error(errorMessage(e, 'Valeur refusée.'));
    } finally {
      invalidateOrg('page-org', 'list');
    }
  };
  return (
    <label className="org-prop">
      <span className="org-prop__name">{prop.name}</span>
      <span className="org-prop__value">
        <PropEditor prop={prop} value={value} canEdit={canEdit} onSave={save} />
      </span>
    </label>
  );
}

export function PropEditor({
  prop,
  value,
  canEdit,
  onSave,
}: {
  prop: PageProp;
  value: PagePropValue;
  canEdit: boolean;
  onSave: (v: PagePropValue) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (prop.type === 'checkbox') {
    return <input type="checkbox" checked={value === true} disabled={!canEdit} onChange={(e) => onSave(e.target.checked)} />;
  }
  if (prop.type === 'select') {
    return (
      <select value={typeof value === 'string' ? value : ''} disabled={!canEdit} onChange={(e) => onSave(e.target.value || null)} aria-label={prop.name}>
        <option value="">—</option>
        {prop.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  const type = prop.type === 'number' ? 'number' : prop.type === 'date' ? 'date' : 'text';
  const shown = draft ?? (value === null || value === undefined ? '' : String(value));
  const commit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    const next: PagePropValue = raw === '' ? null : prop.type === 'number' ? Number(raw) : raw;
    if (prop.type === 'number' && next !== null && !Number.isFinite(next as number)) return;
    if (next !== value) onSave(next);
  };
  return (
    <input
      type={type}
      value={shown}
      readOnly={!canEdit}
      aria-label={prop.name}
      placeholder={canEdit ? 'Vide' : ''}
      maxLength={prop.type === 'text' ? 2000 : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}
