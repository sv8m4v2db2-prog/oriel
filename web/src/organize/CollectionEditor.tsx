// Create / edit a smart collection: name, icon, rules and a live preview of the matching pages.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal, TextInput } from '@mantine/core';
import type { Collection, PageFilter } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { confirmDialog, toast } from '../lib/ui';
import { pageTitle } from '../lib/util';
import { PageIcon } from '../components/common';
import { orgApi, ok } from './api';
import { emptyFilter, FilterEditor } from './FilterEditor';
import { invalidateOrg, usePageProps, useTags } from './hooks';
import './organize.css';

export function CollectionEditor({
  workspaceId,
  collection,
  onClose,
  onSaved,
  onDeleted,
}: {
  workspaceId: string;
  collection?: Collection;
  onClose: () => void;
  onSaved?: (c: Collection) => void;
  onDeleted?: () => void;
}) {
  const tags = useTags(workspaceId);
  const props = usePageProps(workspaceId);
  const [name, setName] = useState(collection?.name ?? '');
  const [icon, setIcon] = useState(collection?.icon ?? '');
  const [rules, setRules] = useState<PageFilter>(collection?.rules ?? emptyFilter());
  const [debounced, setDebounced] = useState(rules);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(rules), 350);
    return () => clearTimeout(t);
  }, [rules]);

  const included = collection?.included ?? [];
  const excluded = collection?.excluded ?? [];
  const preview = useQuery({
    queryKey: ok.preview(workspaceId, { rules: debounced, included, excluded }),
    queryFn: () => orgApi.previewCollection(workspaceId, { rules: debounced, included, excluded, limit: 12 }),
    placeholderData: (prev) => prev,
  });

  const save = async () => {
    if (!name.trim()) {
      toast.error('Donnez un nom à la collection.');
      return;
    }
    setBusy(true);
    try {
      const body = { name, icon: icon.trim() || null, rules };
      const saved = collection ? await orgApi.updateCollection(collection.id, body) : await orgApi.createCollection(workspaceId, body);
      invalidateOrg('collections', 'list');
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e, 'Enregistrement impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!collection) return;
    if (!(await confirmDialog({ title: `Supprimer « ${collection.name} » ?`, message: 'Les pages ne sont pas supprimées.', confirmLabel: 'Supprimer', danger: true }))) return;
    try {
      await orgApi.deleteCollection(collection.id);
      invalidateOrg('collections', 'folder-items');
      onDeleted?.();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e, 'Suppression impossible.'));
    }
  };

  return (
    <Modal opened onClose={onClose} title={collection ? 'Modifier la collection' : 'Nouvelle collection'} size="lg" centered>
      <div className="org-editor">
        <div className="org-editor__head">
          <TextInput
            w={64}
            aria-label="Icône"
            placeholder="🗂"
            maxLength={8}
            value={icon}
            onChange={(e) => setIcon(e.currentTarget.value)}
          />
          <TextInput
            style={{ flex: 1 }}
            aria-label="Nom de la collection"
            placeholder="Nom de la collection"
            maxLength={80}
            data-autofocus
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <h3 className="org-editor__h">Règles</h3>
        <FilterEditor workspaceId={workspaceId} value={rules} onChange={setRules} tags={tags.data ?? []} props={props.data ?? []} />
        {(included.length > 0 || excluded.length > 0) && (
          <p className="muted org-editor__note">
            {included.length} page{included.length > 1 ? 's' : ''} ajoutée{included.length > 1 ? 's' : ''} à la main, {excluded.length} exclue
            {excluded.length > 1 ? 's' : ''} : elles s’ajoutent aux règles.
          </p>
        )}
        <h3 className="org-editor__h">
          Aperçu{' '}
          <span className="muted" aria-live="polite">
            {preview.data ? `${preview.data.total} page${preview.data.total > 1 ? 's' : ''}` : ''}
          </span>
        </h3>
        <ul className="org-preview" aria-label="Aperçu des pages concernées">
          {(preview.data?.items ?? []).map((p) => (
            <li key={p.id}>
              <PageIcon icon={p.icon} kind={p.kind} size={15} />
              <span>{pageTitle(p.title)}</span>
              {p.parentTitle !== null && <span className="muted"> · dans {pageTitle(p.parentTitle)}</span>}
            </li>
          ))}
          {preview.data && preview.data.items.length === 0 && (
            <li className="muted">{rules.conditions.length === 0 ? 'Ajoutez une règle pour voir des pages.' : 'Aucune page visible ne correspond.'}</li>
          )}
          {preview.data && preview.data.total > preview.data.items.length && (
            <li className="muted">… et {preview.data.total - preview.data.items.length} autres</li>
          )}
        </ul>
        <div className="org-editor__foot">
          {collection && (
            <button type="button" className="btn btn--danger" onClick={() => void remove()}>
              Supprimer
            </button>
          )}
          <span className="org-toolbar__spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            Enregistrer
          </button>
        </div>
      </div>
    </Modal>
  );
}
