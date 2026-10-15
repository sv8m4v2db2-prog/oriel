// Sidebar entry "Brief du jour" (under "Accueil").
import { NavLink } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { useAiSettings } from './hooks';

export function BriefSidebarLink() {
  const { workspaceId, user, canManage } = useWorkspaceCtx();
  const settings = useAiSettings(workspaceId);
  const isAdmin = user.isAdmin || canManage;
  // Members only see it once the feature works; admins always (to discover and configure it).
  if (!isAdmin && !settings.data?.configured) return null;
  return (
    <NavLink to={`/w/${workspaceId}/brief`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
      <Sparkles size={16} />
      <span className="nav-item__label">Brief du jour</span>
    </NavLink>
  );
}
