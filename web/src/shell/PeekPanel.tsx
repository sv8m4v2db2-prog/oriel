// Right-hand "peek" panel (database rows), driven by lib/navigation.
import { useQuery } from '@tanstack/react-query';
import { Tooltip } from '@mantine/core';
import { ChevronsRight, Columns2, Maximize2 } from 'lucide-react';
import { api } from '../lib/api';
import { errorMessage, isNotFound } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { navigation, useNavigationState } from '../lib/navigation';
import { EmptyState, ErrorState, PageSkeleton } from '../components/common';
import { PageView } from '../page/PageView';
import { ReadingHost } from '../reading';
import { splitActions } from '../split/actions';
import { PageTopBar } from './TopBar';
import { useWorkspaceCtx } from './WorkspaceContext';

export function PeekPanel() {
  const { peekPageId } = useNavigationState();
  const { workspaceId } = useWorkspaceCtx();
  const query = useQuery({
    queryKey: qk.page(peekPageId ?? ''),
    queryFn: () => api.pages.get(peekPageId!),
    enabled: !!peekPageId,
  });
  if (!peekPageId) return <ReadingHost />;
  const detail = query.data;
  return (
    <>
    <ReadingHost />
    <aside className="peek" role="dialog" aria-label="Aperçu de la page">
      <div className="peek__header">
        <Tooltip label="Fermer (Échap)" openDelay={300}>
          <button type="button" className="icon-btn" aria-label="Fermer l’aperçu" onClick={() => navigation.closePeek()}>
            <ChevronsRight size={18} />
          </button>
        </Tooltip>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigation.openPage(peekPageId)}>
          <Maximize2 size={14} /> Ouvrir en pleine page
        </button>
        <Tooltip label="Ouvrir dans le panneau voisin (⌥clic)" openDelay={300}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Ouvrir à côté"
            onClick={() => {
              navigation.closePeek();
              splitActions.openBeside(peekPageId);
            }}
          >
            <Columns2 size={16} />
          </button>
        </Tooltip>
        <div className="peek__spacer" />
        {detail && <PageTopBar detail={detail} compact />}
      </div>
      <div className="peek__body" key={peekPageId}>
        {query.isLoading ? (
          <PageSkeleton />
        ) : query.isError || !detail ? (
          isNotFound(query.error) ? (
            <EmptyState title="Page introuvable">Elle a peut-être été supprimée, ou vous n’y avez pas accès.</EmptyState>
          ) : (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          )
        ) : (
          <PageView detail={detail} workspaceId={workspaceId} variant="peek" />
        )}
      </div>
    </aside>
    </>
  );
}
