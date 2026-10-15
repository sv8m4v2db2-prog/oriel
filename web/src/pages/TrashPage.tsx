import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Search, Trash } from 'lucide-react';
import { LIMITS } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { destroyPage, restorePage } from '../lib/pages';
import { confirmDialog } from '../lib/ui';
import { formatWhen, normalizeText, pagePath, pageTitle } from '../lib/util';
import { useDocumentTitle } from '../lib/util';
import { EmptyState, ErrorState, PageIcon, Skeleton } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import './home.css';

export function TrashPage() {
  const { workspaceId, canEdit, workspace } = useWorkspaceCtx();
  useDocumentTitle(`Corbeille · ${workspace.name}`);
  const trash = useQuery({ queryKey: qk.trash(workspaceId), queryFn: () => api.workspaces.trash(workspaceId) });
  const [filter, setFilter] = useState('');

  const items = useMemo(() => {
    const q = normalizeText(filter);
    return (trash.data?.items ?? []).filter((i) => !q || normalizeText(pageTitle(i.page.title)).includes(q));
  }, [trash.data, filter]);

  const destroy = async (id: string, title: string) => {
    const ok = await confirmDialog({
      title: 'Supprimer définitivement ?',
      message: `« ${pageTitle(title)} » et ses sous-pages seront supprimées pour toujours.`,
      confirmLabel: 'Supprimer définitivement',
      danger: true,
    });
    if (ok) await destroyPage(workspaceId, id);
  };

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <Trash size={15} /> Corbeille
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="narrow-page">
          <h1 className="narrow-page__title">Corbeille</h1>
          <p className="muted">Les pages supprimées sont conservées {LIMITS.trashRetentionDays} jours, puis effacées automatiquement.</p>
          <label className="input-with-icon">
            <Search size={15} />
            <input className="input" placeholder="Filtrer par titre…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {trash.isLoading ? (
            <div className="list-skeleton">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={40} radius={8} />
              ))}
            </div>
          ) : trash.isError ? (
            <ErrorState onRetry={() => void trash.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<Trash size={26} />} title={filter ? 'Aucun résultat' : 'La corbeille est vide'}>
              {filter ? 'Aucune page supprimée ne correspond à ce filtre.' : 'Les pages que vous supprimez apparaîtront ici.'}
            </EmptyState>
          ) : (
            <ul className="trash-list">
              {items.map(({ page, path }) => (
                <li key={page.id} className="trash-item">
                  <Link to={pagePath(workspaceId, page.id)} className="trash-item__main">
                    <PageIcon icon={page.icon} kind={page.kind} size={18} />
                    <span className="trash-item__text">
                      <span className="trash-item__title">{pageTitle(page.title)}</span>
                      <span className="trash-item__meta">
                        {path.length > 0 ? `${path.map((c) => pageTitle(c.title)).join(' / ')} · ` : ''}
                        Supprimée {page.trashedAt ? formatWhen(page.trashedAt) : ''}
                      </span>
                    </span>
                  </Link>
                  {canEdit && (
                    <span className="trash-item__actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void restorePage(workspaceId, page.id)}>
                        <RotateCcw size={14} /> Restaurer
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm btn--danger-text" onClick={() => void destroy(page.id, page.title)}>
                        Supprimer définitivement
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
