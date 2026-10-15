import { HomeFeatureCards } from '../features/registry';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Clock, Database, FilePlus, House, Star } from 'lucide-react';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { createPage } from '../lib/pages';
import { formatRelative, pagePath, pageTitle } from '../lib/util';
import { useDocumentTitle } from '../lib/util';
import { EmptyState, ErrorState, PageIcon, Skeleton } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import './home.css';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 18) return 'Bonjour';
  return 'Bonsoir';
}

export function HomePage() {
  const { workspaceId, workspace, user, canEdit } = useWorkspaceCtx();
  useDocumentTitle(`Accueil · ${workspace.name}`);
  const recent = useQuery({ queryKey: qk.recent(workspaceId), queryFn: () => api.workspaces.recent(workspaceId) });
  const favorites = useQuery({ queryKey: qk.favorites(workspaceId), queryFn: () => api.workspaces.favorites(workspaceId) });
  const firstName = user.name.split(/\s+/)[0] ?? user.name;

  const newPage = (kind: 'page' | 'database' = 'page') =>
    void createPage({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility: 'workspace', kind }).catch(() => undefined);

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <House size={15} /> Accueil
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="home">
          <h1 className="home__greeting">
            {greeting()}, {firstName}
          </h1>
          <p className="home__subtitle">
            {workspace.icon ? `${workspace.icon} ` : ''}
            {workspace.name}
          </p>

          {canEdit && (
            <div className="home__actions">
              <button type="button" className="btn btn--primary" onClick={() => newPage('page')}>
                <FilePlus size={16} /> Nouvelle page
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => newPage('database')}>
                <Database size={16} /> Nouvelle base de données
              </button>
            </div>
          )}

          <HomeFeatureCards />

          <section className="home__section">
            <h2 className="home__heading">
              <Clock size={15} /> Consultées récemment
            </h2>
            {recent.isLoading ? (
              <div className="home__cards">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="home-card is-skeleton">
                    <Skeleton width={32} height={32} radius={8} />
                    <Skeleton width="80%" style={{ marginTop: 14 }} />
                    <Skeleton width="50%" height={10} style={{ marginTop: 10 }} />
                  </div>
                ))}
              </div>
            ) : recent.isError ? (
              <ErrorState message="Impossible de charger les pages récentes." onRetry={() => void recent.refetch()} />
            ) : (recent.data?.pages.length ?? 0) === 0 ? (
              <EmptyState title="Rien pour l’instant">Les pages que vous ouvrez apparaîtront ici.</EmptyState>
            ) : (
              <div className="home__cards">
                {recent.data!.pages.slice(0, 8).map((p) => (
                  <Link key={p.id} to={pagePath(workspaceId, p.id)} className="home-card">
                    <PageIcon icon={p.icon} kind={p.kind} size={30} />
                    <span className="home-card__title">{pageTitle(p.title)}</span>
                    {p.path.length > 0 && <span className="home-card__path">{p.path.map((c) => pageTitle(c.title)).join(' / ')}</span>}
                    <span className="home-card__time">{formatRelative(p.visitedAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="home__section">
            <h2 className="home__heading">
              <Star size={15} /> Favoris
            </h2>
            {favorites.isLoading ? (
              <Skeleton width="40%" />
            ) : (favorites.data?.favorites.length ?? 0) === 0 ? (
              <p className="muted">Ajoutez des pages aux favoris avec l’étoile en haut de chaque page.</p>
            ) : (
              <ul className="home__list">
                {favorites.data!.favorites.map((f) => (
                  <li key={f.id}>
                    <Link to={pagePath(workspaceId, f.id)} className="home__list-item">
                      <PageIcon icon={f.icon} kind={f.kind} size={18} />
                      <span>{pageTitle(f.title)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
