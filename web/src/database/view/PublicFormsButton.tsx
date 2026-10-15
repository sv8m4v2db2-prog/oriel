// Public forms of a database (QA-VIEW-05): every form open to people without an account, views of
// linked blocks included. A linked block's views are not tied to its page: when the block is removed
// its public form stays open, and this list is the only place where it can still be found and closed.
// Shown to members only (never on public pages), and only when the database has public forms.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import type { PublicFormSummary } from '@oriel/shared';
import { DbPopover as Popover } from '../ui/DbPopover';
import { stopEscape } from '../ui/primitives';
import { useDb } from '../context';
import { dbExtrasApi } from '../api';
import { qk } from '../../lib/queryKeys';
import { errorMessage, queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/ui';

/** Under the database key: view changes (events) refresh it. */
export const publicFormsKey = (databaseId: string) => [...qk.database(databaseId), 'public-forms'] as const;

export function PublicFormsButton() {
  const { databaseId, publicMode, canEdit, linkId } = useDb();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({
    queryKey: publicFormsKey(databaseId),
    queryFn: () => dbExtrasApi.publicForms(databaseId),
    enabled: !publicMode && !!databaseId,
    staleTime: 30_000,
  });
  const forms = query.data?.forms ?? [];
  if (publicMode || forms.length === 0) return null;

  const close = async (f: PublicFormSummary) => {
    setBusy(f.id);
    try {
      await dbExtrasApi.closePublicForm(f.id);
      toast.success(`« ${f.name} » est maintenant réservé aux membres.`);
      void queryClient.invalidateQueries({ queryKey: qk.database(databaseId) });
    } catch (e) {
      toast.error(errorMessage(e, 'Impossible de fermer ce formulaire.'));
    } finally {
      setBusy(null);
    }
  };

  const label = forms.length === 1 ? '1 formulaire public' : `${forms.length} formulaires publics`;
  const where = (f: PublicFormSummary) =>
    f.linkId === null ? 'Vue de la base' : f.linkId === linkId ? 'Vue de ce bloc' : 'Vue d’un bloc lié (ailleurs, ou supprimé)';

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={340} shadow="md">
      <Popover.Target>
        <button
          type="button"
          className="ordb-toolbtn ordb-public-forms-btn"
          onClick={() => setOpened((o) => !o)}
          aria-label={label}
          title="Formulaires ouverts aux personnes sans compte"
        >
          <Globe size={15} />
          <span className="ordb-toolbtn-label">{label}</span>
        </button>
      </Popover.Target>
      <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
        <div className="ordb-public-forms">
          <p className="ordb-form-help">
            Ces formulaires acceptent des réponses de personnes sans compte, par leur lien de partage, y compris ceux
            des blocs liés placés ailleurs. Fermer un formulaire le réserve aux membres de l’espace.
          </p>
          <ul className="ordb-public-forms-list">
            {forms.map((f) => (
              <li key={f.id} className="ordb-public-forms-item">
                <div className="ordb-public-forms-text">
                  <span className="ordb-public-forms-name">{f.name || 'Formulaire'}</span>
                  <span className="ordb-public-forms-meta">
                    {where(f)}
                    {!f.acceptResponses && ' · réponses suspendues'}
                  </span>
                </div>
                {canEdit && (
                  <button type="button" className="ordb-btn is-sm is-outline" disabled={busy !== null} onClick={() => void close(f)}>
                    {busy === f.id ? 'Fermeture…' : 'Fermer'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
