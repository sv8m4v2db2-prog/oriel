import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileQuestion } from 'lucide-react';
import { api } from '../lib/api';
import { errorMessage, isNotFound, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { pagePath, pageTitle } from '../lib/util';
import { EmptyState, ErrorState, PageSkeleton } from '../components/common';
import { PageView } from '../page/PageView';
import { CanvasView, isCanvasPage } from '../canvas';
import { PageTopBar, TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { SplitView, useSplitRoute } from '../split';

export function PageRoute() {
  const { pageId = '' } = useParams();
  const { workspaceId, workspace } = useWorkspaceCtx();
  const query = useQuery({ queryKey: qk.page(pageId), queryFn: () => api.pages.get(pageId), enabled: !!pageId });
  const detail = query.data;
  // Split view (lot E): several panes side by side; the route page is the active pane.
  const split = useSplitRoute();

  // Opening a page records a visit: refresh "recent pages".
  useEffect(() => {
    if (query.isSuccess) void queryClient.invalidateQueries({ queryKey: qk.recent(workspaceId) });
  }, [query.isSuccess, pageId, workspaceId]);

  useEffect(() => {
    if (detail) document.title = `${detail.page.icon ? `${detail.page.icon} ` : ''}${pageTitle(detail.page.title)} · ${workspace.name}`;
  }, [detail, workspace.name]);

  if (split.active) return <SplitView workspaceId={workspaceId} state={split.state} />;
  if (query.isLoading) {
    return (
      <>
        <TopBar />
        <div className="main-scroll">
          <PageSkeleton />
        </div>
      </>
    );
  }
  if (query.isError || !detail) {
    return (
      <>
        <TopBar />
        <div className="main-scroll center-content">
          {isNotFound(query.error) ? (
            <EmptyState icon={<FileQuestion size={28} />} title="Page introuvable">
              Elle a peut-être été supprimée définitivement, ou vous n’y avez pas accès.
            </EmptyState>
          ) : (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          )}
        </div>
      </>
    );
  }
  if (detail.page.workspaceId !== workspaceId) {
    return <Navigate to={pagePath(detail.page.workspaceId, detail.page.id)} replace />;
  }
  // Canvas page (H1): whiteboard instead of the block editor, filling the main area.
  if (isCanvasPage(detail.page)) {
    return (
      <>
        <PageTopBar detail={detail} />
        <div className="main-scroll" key={pageId} style={{ overflow: 'hidden', position: 'relative' }}>
          <CanvasView page={detail.page} workspaceId={workspaceId} canEdit={detail.canEdit} mode="app" />
        </div>
      </>
    );
  }
  return (
    <>
      <PageTopBar detail={detail} />
      <div className="main-scroll" key={pageId}>
        <PageView detail={detail} workspaceId={workspaceId} variant="full" />
      </div>
    </>
  );
}
