import { useEffect, useMemo, type CSSProperties } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { events } from '../lib/events';
import { navigation } from '../lib/navigation';
import { queryClient } from '../lib/queryClient';
import { canEditRole, canManageRole, rememberWorkspace, useSession, useWorkspaces } from '../lib/session';
import { useStore } from '../lib/store';
import { closeMobileSidebar, sidebarStore, toast } from '../lib/ui';
import { pagePath } from '../lib/util';
import { ErrorState, Spinner } from '../components/common';
import { WorkspaceContext, type WorkspaceCtx } from './WorkspaceContext';
import { Sidebar } from './Sidebar';
import { PeekPanel } from './PeekPanel';
import { SplitDropOverlay, SplitProvider, installSplitInteractions, useSplitRouteState } from '../split';
import { SearchModal } from './SearchModal';
import { PagePickerModal } from './PagePickerModal';
import { HistoryPanel } from './HistoryPanel';
import { OfflineBanner } from './OfflineBanner';
import { useGlobalShortcuts } from './shortcuts';
import { ShortcutsHelp } from './commands';
import { ConvertTeamspaceHost } from './nav/access';
import './shell.css';

export function AppShell() {
  const { workspaceId = '' } = useParams();
  const location = useLocation();
  const session = useSession();
  const workspaces = useWorkspaces();

  if (session.isLoading) {
    return (
      <div className="center-screen">
        <Spinner size={22} />
      </div>
    );
  }
  if (session.isError && !session.data) {
    return (
      <div className="center-screen">
        <ErrorState title="Serveur injoignable" message="Impossible de vérifier votre session." onRetry={() => void session.refetch()} />
      </div>
    );
  }
  if (!session.data) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  const list = workspaces.data ?? session.data.workspaces;
  const workspace = list.find((w) => w.id === workspaceId);
  if (!workspace) {
    if (workspaces.isFetching) {
      return (
        <div className="center-screen">
          <Spinner size={22} />
        </div>
      );
    }
    return <Navigate to="/" replace />;
  }
  return <ShellLayout key={workspace.id} ctx={{
    workspace,
    workspaceId: workspace.id,
    role: workspace.role,
    canEdit: canEditRole(workspace.role),
    canManage: canManageRole(workspace.role),
    user: session.data.user,
  }} />;
}

function ShellLayout({ ctx }: { ctx: WorkspaceCtx }) {
  const navigate = useNavigate();
  const { pageId } = useParams();
  const location = useLocation();
  const sidebar = useStore(sidebarStore);
  const { workspaceId } = ctx;
  // Split view (lot E): the route's page is the active pane; see split/route.tsx.
  const split = useSplitRouteState(workspaceId);
  useEffect(() => installSplitInteractions(), []);

  useEffect(() => {
    rememberWorkspace(workspaceId);
    events.start(queryClient, {
      onRevoked: (wid) => {
        if (wid === workspaceId) {
          toast.error('Vous n’avez plus accès à cet espace de travail.');
          navigate('/', { replace: true });
        }
      },
    });
    events.setWorkspace(workspaceId);
    navigation.registerNavigate((id) => navigate(pagePath(workspaceId, id)));
  }, [workspaceId, navigate]);

  useEffect(() => {
    closeMobileSidebar();
  }, [location.pathname]);

  useEffect(() => {
    document.title = ctx.workspace.name ? `${ctx.workspace.name} · Oriel` : 'Oriel';
  }, [ctx.workspace.name]);

  useGlobalShortcuts({ workspaceId, canEdit: ctx.canEdit, pageId });

  const style = useMemo(() => ({ '--sidebar-w': `${sidebar.width}px` }) as CSSProperties, [sidebar.width]);

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div
        className={`shell${sidebar.collapsed ? ' is-collapsed' : ''}${sidebar.mobileOpen ? ' is-mobile-open' : ''}`}
        style={style}
      >
        <Sidebar />
        <div className="shell__backdrop" onClick={closeMobileSidebar} aria-hidden />
        <div className="shell__main">
          <OfflineBanner />
          <SplitProvider value={split}>
            <Outlet />
          </SplitProvider>
        </div>
        <PeekPanel />
        <SplitDropOverlay />
      </div>
      <SearchModal />
      <PagePickerModal />
      <HistoryPanel />
      <ShortcutsHelp />
      <ConvertTeamspaceHost />
    </WorkspaceContext.Provider>
  );
}
