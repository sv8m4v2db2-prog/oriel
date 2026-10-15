// Feature registry: the single place where feature modules plug into the app shell
// (routes, sidebar, settings tabs, home). Each module owns its own folder.
import type { ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import { Bell, Bot, FolderInput, KeyRound, ShieldCheck } from 'lucide-react';
import { AiSettings, BriefPage, BriefSidebarLink, HomeBriefCard } from '../ai';
import { InboxPage, InboxSidebarLink, NotificationSettings } from '../collab';
import { CommentsTopBarButton } from '../collab/comments';
import { DesktopBridge, desktopSettingsTabs } from '../desktop';
import { ImportExportSettings } from '../io';
import { McpSettings } from '../mcp';
import { SecurityHomeCard } from '../auth/SecurityHomeCard';
import { SecuritySettings } from '../auth/SecuritySettings';
import { ChartNoAxesColumn, Contrast, NotebookPen, Tags } from 'lucide-react';
import { AccessibilitySettings, PageStatsSettings, TeamspacesSidebarLink } from '../shell/nav/settings';
import { TeamspacesPage } from '../pages/TeamspacesPage';
import { ProfilePage } from '../pages/ProfilePage';
import { JournalPage, JournalSettings, JournalSidebarLink } from '../journal';
import { AllPagesPage, AllPagesSidebarLink, OrganizeSettings } from '../organize';

/** Child routes of /w/:workspaceId */
export const featureRoutes: RouteObject[] = [
  { path: 'brief', element: <BriefPage /> },
  { path: 'inbox', element: <InboxPage /> },
  // Navigation module: teamspaces directory and people profiles.
  { path: 'teamspaces', element: <TeamspacesPage /> },
  { path: 'people/:userId', element: <ProfilePage /> },
  // Organize module (wave H3): daily journal, all pages, tag pages, collections.
  { path: 'journal', element: <JournalPage /> },
  { path: 'all-pages', element: <AllPagesPage mode="all" /> },
  { path: 'tags/:tagId', element: <AllPagesPage mode="tag" /> },
  { path: 'collections/:collectionId', element: <AllPagesPage mode="collection" /> },
];

/** Entries rendered in the sidebar navigation, under "Accueil". */
export function SidebarFeatureLinks() {
  return (
    <>
      <InboxSidebarLink />
      <JournalSidebarLink />
      <AllPagesSidebarLink />
      <TeamspacesSidebarLink />
      <BriefSidebarLink />
      <DesktopBridge />
    </>
  );
}

/**
 * Extra controls rendered in a page's top bar (full page and peek panel), before the save indicator —
 * e.g. the collaboration module's "Commentaires" button.
 */
export function PageTopBarExtras({ pageId }: { pageId: string; compact?: boolean }): ReactNode {
  return <CommentsTopBarButton pageId={pageId} />;
}

/** Content rendered on the Home page, under the action buttons. */
export function HomeFeatureCards() {
  return (
    <>
      <SecurityHomeCard />
      <HomeBriefCard />
    </>
  );
}

export interface FeatureSettingsTab {
  id: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
  render: () => ReactNode;
}

/** Extra tabs of the Settings page (after the built-in ones). */
export const featureSettingsTabs: FeatureSettingsTab[] = [
  { id: 'notifications', label: 'Notifications', icon: <Bell size={16} />, render: () => <NotificationSettings /> },
  { id: 'import-export', label: 'Import / export', icon: <FolderInput size={16} />, render: () => <ImportExportSettings /> },
  { id: 'ai', label: 'IA', icon: <Bot size={16} />, render: () => <AiSettings /> },
  { id: 'security', label: 'Sécurité', icon: <ShieldCheck size={16} />, render: () => <SecuritySettings /> },
  { id: 'api', label: 'API et MCP', icon: <KeyRound size={16} />, render: () => <McpSettings /> },
  { id: 'accessibility', label: 'Accessibilité', icon: <Contrast size={16} />, render: () => <AccessibilitySettings /> },
  { id: 'organization', label: 'Tags et propriétés', icon: <Tags size={16} />, render: () => <OrganizeSettings /> },
  { id: 'journal', label: 'Journal', icon: <NotebookPen size={16} />, render: () => <JournalSettings /> },
  { id: 'page-stats', label: 'Statistiques', icon: <ChartNoAxesColumn size={16} />, render: () => <PageStatsSettings /> },
  // Desktop app only (empty in a browser): quick search, Dock badge, session, spelling.
  ...desktopSettingsTabs,
];
