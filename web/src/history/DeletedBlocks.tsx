// Version history (G6): recently deleted blocks of a page, reinserted in one click.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import type { DeletedBlock } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { formatDateTime } from '../lib/util';
import { EmptyState, Spinner } from '../components/common';
import { historyApi, historyKeys } from './api';
import { typeLabel } from './labels';

function when(b: DeletedBlock): string {
  const by = b.deletedBy.length > 0 ? ` · par ${b.deletedBy.map((u) => u.name).join(', ')}` : '';
  const before = b.deletedBefore ? ` · absent de la version ${formatDateTime(b.deletedBefore)}` : ' · supprimé depuis cette version';
  return `Dernière version qui le contient : ${formatDateTime(b.snapshotAt)}${before}${by}`;
}

export function DeletedBlocks({ pageId, canEdit, onRestored }: { pageId: string; canEdit: boolean; onRestored: () => void }) {
  const list = useQuery({ queryKey: historyKeys.deleted(pageId), queryFn: () => historyApi.deleted(pageId) });
  const [busy, setBusy] = useState<string | null>(null);

  const reinsert = async (b: DeletedBlock) => {
    setBusy(b.blockId);
    try {
      const res = await historyApi.restoreBlocks(pageId, b.snapshotId, [{ blockId: b.blockId, action: 'reinsert' }]);
      if (res.restored.length > 0) toast.success('Bloc réinséré');
      else toast.error('Ce bloc est déjà présent dans la page.');
      void list.refetch();
      onRestored();
    } catch (e) {
      toast.error(errorMessage(e, 'Réinsertion impossible.'));
    } finally {
      setBusy(null);
    }
  };

  if (list.isLoading) {
    return (
      <div className="history__loading">
        <Spinner />
      </div>
    );
  }
  if (list.isError || !list.data) return <EmptyState title="Liste indisponible">{errorMessage(list.error, 'Les blocs supprimés n’ont pas pu être lus.')}</EmptyState>;
  if (list.data.blocks.length === 0) {
    return (
      <EmptyState title="Aucun bloc supprimé récemment">
        Les blocs présents dans les versions des 30 derniers jours et absents de la page apparaîtront ici.
      </EmptyState>
    );
  }
  return (
    <div className="hdeleted">
      <p className="muted">
        {list.data.scanned} version{list.data.scanned > 1 ? 's' : ''} examinée{list.data.scanned > 1 ? 's' : ''}. Un bloc supprimé depuis la dernière version
        n’est récupérable que si cette version le contenait.
        {list.data.truncated ? ' Liste limitée aux 200 blocs les plus récents.' : ''}
      </p>
      <ul>
        {list.data.blocks.map((b) => (
          <li key={b.blockId} className="hdeleted__item">
            <div className="hdeleted__main">
              <span className="hdeleted__type">{typeLabel(b.type)}</span>
              <span className="hdeleted__text">{b.text || <span className="muted">Sans texte</span>}</span>
              <span className="hdeleted__meta">
                {when(b)}
                {b.childCount > 0 ? ` · avec ${b.childCount} bloc${b.childCount > 1 ? 's' : ''} imbriqué${b.childCount > 1 ? 's' : ''}` : ''}
              </span>
            </div>
            {canEdit && (
              <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void reinsert(b)}>
                {busy === b.blockId ? <Spinner size={13} /> : <Undo2 size={13} />} Réinsérer
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
