// Settings tab « Tags et propriétés » : manage the workspace tags and the workspace page properties.
import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash } from 'lucide-react';
import type { PageProp, PagePropDisplay, PagePropType, Tag, TagColor } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { confirmDialog, promptDialog, toast } from '../lib/ui';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { orgApi } from './api';
import { invalidateOrg, usePageProps, useTags } from './hooks';
import { ColorSwatches, TagChip } from './TagChip';
import './organize.css';

const TYPE_LABELS: Record<PagePropType, string> = { text: 'Texte', number: 'Nombre', date: 'Date', checkbox: 'Case à cocher', select: 'Sélection' };
const DISPLAY_LABELS: Record<PagePropDisplay, string> = {
  always: 'Toujours affichée',
  hide_empty: 'Masquée si vide',
  hidden: 'Toujours masquée',
};

async function guarded(action: () => Promise<unknown>, fallback: string) {
  try {
    await action();
  } catch (e) {
    toast.error(errorMessage(e, fallback));
  }
}

export function OrganizeSettings() {
  return (
    <>
      <TagsSection />
      <PropsSection />
    </>
  );
}

function TagsSection() {
  const { workspaceId, canEdit, canManage, user } = useWorkspaceCtx();
  const tags = useTags(workspaceId);
  const [open, setOpen] = useState<string | null>(null);

  const create = async () => {
    const name = await promptDialog({ title: 'Nouveau tag', label: 'Nom', placeholder: 'Ex. : Épisode 3', confirmLabel: 'Créer' });
    if (name?.trim()) await guarded(() => orgApi.createTag(workspaceId, { name }).then(() => invalidateOrg('tags')), 'Création impossible.');
  };
  const rename = async (t: Tag) => {
    const name = await promptDialog({ title: 'Renommer le tag', label: 'Nom', initialValue: t.name, confirmLabel: 'Renommer' });
    if (name?.trim() && name !== t.name) await guarded(() => orgApi.updateTag(t.id, { name }).then(() => invalidateOrg('tags', 'list', 'page-org')), 'Renommage impossible.');
  };
  const recolor = (t: Tag, color: TagColor) => guarded(() => orgApi.updateTag(t.id, { color }).then(() => invalidateOrg('tags', 'list', 'page-org')), 'Modification impossible.');
  const remove = async (t: Tag) => {
    if (!(await confirmDialog({ title: `Supprimer le tag « ${t.name} » ?`, message: 'Il sera retiré de toutes les pages.', confirmLabel: 'Supprimer', danger: true }))) return;
    await guarded(() => orgApi.deleteTag(t.id).then(() => invalidateOrg('tags', 'list', 'page-org', 'folder-items')), 'Suppression impossible.');
  };

  return (
    <section className="settings-section" aria-labelledby="org-tags-title">
      <h2 className="settings-section__title" id="org-tags-title">
        Tags
      </h2>
      <p className="settings-section__desc">
        Libellés colorés communs à l’espace, applicables à n’importe quelle page. Les nombres ne comptent que les pages que vous pouvez voir.
      </p>
      <div className="settings-section__body">
        {(tags.data ?? []).length === 0 && <p className="muted">Aucun tag pour l’instant.</p>}
        <ul className="org-settings-list">
          {(tags.data ?? []).map((t) => (
            <li key={t.id}>
              <div className="org-settings-row">
                <TagChip tag={t} />
                <span className="muted">
                  {t.pageCount} page{t.pageCount > 1 ? 's' : ''}
                </span>
                <span className="org-toolbar__spacer" />
                {canEdit && (
                  <>
                    <button type="button" className="btn" onClick={() => setOpen(open === t.id ? null : t.id)}>
                      Couleur
                    </button>
                    <button type="button" className="btn" onClick={() => void rename(t)}>
                      Renommer
                    </button>
                    {(canManage || t.createdBy === user.id) && (
                      <button type="button" className="icon-btn" aria-label={`Supprimer le tag ${t.name}`} onClick={() => void remove(t)}>
                        <Trash size={15} />
                      </button>
                    )}
                  </>
                )}
              </div>
              {open === t.id && <ColorSwatches value={t.color} onChange={(c) => void recolor(t, c)} />}
            </li>
          ))}
        </ul>
        {canEdit && (
          <button type="button" className="btn" onClick={() => void create()}>
            <Plus size={14} /> Nouveau tag
          </button>
        )}
      </div>
    </section>
  );
}

function PropsSection() {
  const { workspaceId, canEdit, canManage } = useWorkspaceCtx();
  const props = usePageProps(workspaceId);
  const list = props.data ?? [];

  const create = async () => {
    const name = await promptDialog({ title: 'Nouvelle propriété', label: 'Nom', placeholder: 'Ex. : Réalisateur', confirmLabel: 'Créer' });
    if (name?.trim()) await guarded(() => orgApi.createProp(workspaceId, { name, type: 'text' }).then(() => invalidateOrg('props')), 'Création impossible.');
  };
  const patch = (p: PageProp, body: Parameters<typeof orgApi.updateProp>[1]) =>
    guarded(() => orgApi.updateProp(p.id, body).then(() => invalidateOrg('props', 'page-org', 'list')), 'Modification impossible.');
  const remove = async (p: PageProp) => {
    if (!(await confirmDialog({ title: `Supprimer « ${p.name} » ?`, message: 'Les valeurs de toutes les pages seront perdues.', confirmLabel: 'Supprimer', danger: true }))) return;
    await guarded(() => orgApi.deleteProp(p.id).then(() => invalidateOrg('props', 'page-org', 'list')), 'Suppression impossible.');
  };
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= list.length) return;
    // `after` = the property that will precede it; null puts it first.
    const after = dir === -1 ? (target === 0 ? null : list[target - 1]!.id) : list[target]!.id;
    return patch(list[i]!, { after });
  };
  const editOptions = async (p: PageProp) => {
    const raw = await promptDialog({
      title: `Options de « ${p.name} »`,
      label: 'Une option par ligne, séparées par des virgules',
      initialValue: p.options.map((o) => o.name).join(', '),
      confirmLabel: 'Enregistrer',
    });
    if (raw === null) return;
    const names = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 50);
    const options = names.map((n, i) => {
      const old = p.options.find((o) => o.name === n);
      return old ?? { id: '', name: n, color: (['gray', 'blue', 'green', 'orange', 'purple', 'pink', 'red', 'yellow'] as TagColor[])[i % 8]! };
    });
    await patch(p, { options });
  };

  return (
    <section className="settings-section" aria-labelledby="org-props-title">
      <h2 className="settings-section__title" id="org-props-title">
        Propriétés de page
      </h2>
      <p className="settings-section__desc">
        Champs communs à l’espace, pour toute page (hors bases de données) : texte, nombre, date, case à cocher, sélection. Ils s’affichent sous
        le titre des pages et servent de colonnes, filtres et tris dans « Toutes les pages ».
      </p>
      <div className="settings-section__body">
        {list.length === 0 && <p className="muted">Aucune propriété pour l’instant.</p>}
        <ul className="org-settings-list">
          {list.map((p, i) => (
            <li key={p.id}>
              <div className="org-settings-row">
                <strong>{p.name}</strong>
                <span className="muted">{TYPE_LABELS[p.type]}</span>
                <span className="org-toolbar__spacer" />
                {canEdit && (
                  <>
                    <select
                      className="input org-select"
                      aria-label={`Affichage de ${p.name}`}
                      value={p.display}
                      onChange={(e) => void patch(p, { display: e.target.value as PagePropDisplay })}
                    >
                      {(Object.keys(DISPLAY_LABELS) as PagePropDisplay[]).map((d) => (
                        <option key={d} value={d}>
                          {DISPLAY_LABELS[d]}
                        </option>
                      ))}
                    </select>
                    {p.type === 'select' && (
                      <button type="button" className="btn" onClick={() => void editOptions(p)}>
                        Options ({p.options.length})
                      </button>
                    )}
                    <button type="button" className="icon-btn" aria-label="Monter" disabled={i === 0} onClick={() => void move(i, -1)}>
                      <ArrowUp size={15} />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Descendre" disabled={i === list.length - 1} onClick={() => void move(i, 1)}>
                      <ArrowDown size={15} />
                    </button>
                    {canManage && (
                      <button type="button" className="icon-btn" aria-label={`Supprimer ${p.name}`} onClick={() => void remove(p)}>
                        <Trash size={15} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="org-settings-new">
            <button type="button" className="btn" onClick={() => void create()}>
              <Plus size={14} /> Nouvelle propriété (texte)
            </button>
            <span className="muted">Le type se choisit à la création :</span>
            {(Object.keys(TYPE_LABELS) as PagePropType[]).slice(1).map((t) => (
              <button
                key={t}
                type="button"
                className="btn"
                onClick={async () => {
                  const name = await promptDialog({ title: `Nouvelle propriété — ${TYPE_LABELS[t]}`, label: 'Nom', confirmLabel: 'Créer' });
                  if (name?.trim()) await guarded(() => orgApi.createProp(workspaceId, { name, type: t }).then(() => invalidateOrg('props')), 'Création impossible.');
                }}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
