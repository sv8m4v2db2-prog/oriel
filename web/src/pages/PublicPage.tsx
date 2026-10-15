// Published page (no session, no sidebar): read-only content, sub-pages for navigation.
import { Fragment, useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Moon, Sun, Globe } from 'lucide-react';
import type { TreeNode } from '@oriel/shared';
import { DatabaseView, RowProperties } from '../database';
import { api } from '../lib/api';
import { isNotFound } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { toggleTheme, useTheme } from '../lib/theme';
import { appNavigate, pageTitle, sharePath } from '../lib/util';
import { navigation, useNavigationState } from '../lib/navigation';
import { EmptyState, ErrorBoundary, ErrorState, Logo, PageIcon, PageSkeleton } from '../components/common';
import { PageEditor } from '../editor/PageEditor';
import { PageHeader } from '../page/PageView';
import { CanvasView, isCanvasPage } from '../canvas';
import '../shell/shell.css';
import '../page/page.css';

export function PublicPage() {
  const { pageId = '' } = useParams();
  const theme = useTheme();
  const query = useQuery({ queryKey: qk.publicPage(pageId), queryFn: () => api.public.page(pageId), retry: false });
  const data = query.data;
  const children = useMemo(() => new Map<string, TreeNode>((data?.children ?? []).map((c) => [c.id, c])), [data]);

  useEffect(() => {
    // Rows opened from a public database: plain navigation (no peek panel here).
    navigation.registerNavigate((id) => appNavigate(sharePath(id)));
  }, []);

  const peek = useNavigationState().peekPageId;
  useEffect(() => {
    if (peek) {
      navigation.closePeek();
      navigation.openPage(peek);
    }
  }, [peek]);

  useEffect(() => {
    if (data) document.title = `${data.page.icon ? `${data.page.icon} ` : ''}${pageTitle(data.page.title)} · Oriel`;
  }, [data]);

  const page = data?.page;
  return (
    <div className="public">
      <header className="public__bar">
        <nav className="breadcrumbs" aria-label="Fil d’Ariane">
          {(data?.ancestors ?? []).map((c) => (
            <Fragment key={c.id}>
              <Link className="breadcrumbs__item" to={sharePath(c.id)}>
                <PageIcon icon={c.icon} kind={c.kind} size={15} />
                <span>{pageTitle(c.title)}</span>
              </Link>
              <span className="breadcrumbs__sep">/</span>
            </Fragment>
          ))}
          {page && (
            <span className="breadcrumbs__item is-current">
              <PageIcon icon={page.icon} kind={page.kind} size={15} />
              <span>{pageTitle(page.title)}</span>
            </span>
          )}
        </nav>
        <span className="public__badge">
          <Globe size={13} /> Page publique
        </span>
        <button type="button" className="icon-btn" aria-label="Changer de thème" onClick={toggleTheme}>
          {theme.resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <main className="public__main">
        {query.isLoading ? (
          <PageSkeleton />
        ) : query.isError || !data || !page ? (
          <div className="center-content">
            {isNotFound(query.error) ? (
              <EmptyState icon={<Globe size={26} />} title="Page indisponible">
                Cette page n’est pas publiée, ou elle n’existe plus.
              </EmptyState>
            ) : (
              <ErrorState onRetry={() => void query.refetch()} />
            )}
          </div>
        ) : isCanvasPage(page) ? (
          // Canvas page (H1): read-only whiteboard filling the public view.
          <div className="public__canvas" style={{ position: 'relative', height: 'calc(100vh - 120px)', minHeight: 420 }}>
            <CanvasView page={page} workspaceId={null} canEdit={false} mode="public" />
          </div>
        ) : (
          <div className={`page page--full${page.kind === 'database' || page.format.fullWidth ? ' is-full-width' : ''}`}>
            <PageHeader page={page} workspaceId={null} canEdit={false} onTitleEnter={() => undefined} />
            {page.parentType === 'database' && (
              <div className="page-width page-row-props">
                <ErrorBoundary resetKey={page.id}>
                  <RowProperties page={page} readOnly publicMode />
                </ErrorBoundary>
              </div>
            )}
            {page.kind === 'database' ? (
              <div className="page-database">
                <ErrorBoundary resetKey={page.id}>
                  <DatabaseView databaseId={page.id} readOnly publicMode />
                </ErrorBoundary>
              </div>
            ) : (
              <div className="page-width page-body">
                <ErrorBoundary resetKey={page.id}>
                  <PageEditor key={page.id} pageId={page.id} workspaceId={null} canEdit={false} mode="public" publicChildren={children} />
                </ErrorBoundary>
              </div>
            )}
            {data.children.length > 0 && (
              <section className="page-width public__children">
                <h2 className="public__children-title">Sous-pages</h2>
                <ul>
                  {data.children.map((c) => (
                    <li key={c.id}>
                      <Link to={sharePath(c.id)} className="public__child">
                        <PageIcon icon={c.icon} kind={c.kind} size={18} />
                        <span>{pageTitle(c.title)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
      <footer className="public__footer">
        <a href="/" className="public__made">
          <Logo size={16} /> Créé avec Oriel
        </a>
      </footer>
    </div>
  );
}
