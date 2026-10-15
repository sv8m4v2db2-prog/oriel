import { Menu } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, Contrast, LogOut, Monitor, Moon, Plus, Server, Settings, Sun, Users } from 'lucide-react';
import { setHighContrast, useHighContrast } from './nav/contrast';
import { ROLE_LABELS } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { useWorkspaces } from '../lib/session';
import { logoutWithConfirm } from '../lib/logout';
import { setThemePreference, useTheme } from '../lib/theme';
import { promptDialog, toast } from '../lib/ui';
import { desktop, isLocalDesktop } from '../lib/desktop';
import { Avatar } from '../components/common';
import { useWorkspaceCtx } from './WorkspaceContext';

export function WorkspaceIcon({ icon, name, size = 22 }: { icon: string | null; name: string; size?: number }) {
  if (icon) {
    return (
      <span className="ws-icon" style={{ width: size, height: size, fontSize: size * 0.72 }}>
        {icon}
      </span>
    );
  }
  return (
    <span className="ws-icon ws-icon--letter" style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {(name.trim()[0] ?? 'B').toUpperCase()}
    </span>
  );
}

export function WorkspaceSwitcher() {
  const { workspace, user } = useWorkspaceCtx();
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  const highContrast = useHighContrast();
  const theme = useTheme();

  const createWorkspace = async () => {
    const name = await promptDialog({
      title: 'Nouvel espace de travail',
      label: 'Nom',
      placeholder: 'Mon équipe',
      confirmLabel: 'Créer',
    });
    if (!name) return;
    try {
      const ws = await api.workspaces.create({ name });
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      await queryClient.invalidateQueries({ queryKey: qk.session });
      navigate(`/w/${ws.id}`);
      toast.success('Espace de travail créé');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doLogout = async () => {
    // Confirmation when edits have not reached the server (the offline copies are deleted).
    if (!(await logoutWithConfirm())) return;
    navigate('/login', { replace: true });
  };

  return (
    <Menu position="bottom-start" width={280} shadow="md" withinPortal>
      <Menu.Target>
        <button type="button" className="ws-switcher" aria-label="Changer d’espace de travail">
          <WorkspaceIcon icon={workspace.icon} name={workspace.name} />
          <span className="ws-switcher__name">{workspace.name}</span>
          <ChevronDown size={14} className="ws-switcher__chevron" />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        <div className="menu-user">
          <Avatar name={user.name} id={user.id} url={user.avatarUrl} size={28} />
          <div className="menu-user__text">
            <div className="menu-user__name">{user.name}</div>
            <div className="menu-user__email">{user.email}</div>
          </div>
        </div>
        <Menu.Divider />
        <Menu.Label>Espaces de travail</Menu.Label>
        {(workspaces.data ?? []).map((w) => (
          <Menu.Item
            key={w.id}
            leftSection={<WorkspaceIcon icon={w.icon} name={w.name} size={20} />}
            rightSection={w.id === workspace.id ? <Check size={14} /> : <span className="menu-hint">{ROLE_LABELS[w.role]}</span>}
            onClick={() => w.id !== workspace.id && navigate(`/w/${w.id}`)}
          >
            {w.name}
          </Menu.Item>
        ))}
        <Menu.Item leftSection={<Plus size={15} />} onClick={() => void createWorkspace()}>
          Créer un espace de travail
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item leftSection={<Settings size={15} />} onClick={() => navigate(`/w/${workspace.id}/settings/workspace`)}>
          Réglages
        </Menu.Item>
        <Menu.Item leftSection={<Users size={15} />} onClick={() => navigate(`/w/${workspace.id}/settings/members`)}>
          Membres
        </Menu.Item>
        <Menu.Sub>
          <Menu.Sub.Target>
            <Menu.Sub.Item leftSection={theme.resolved === 'dark' ? <Moon size={15} /> : <Sun size={15} />}>Thème</Menu.Sub.Item>
          </Menu.Sub.Target>
          <Menu.Sub.Dropdown>
            <Menu.Item leftSection={<Sun size={15} />} rightSection={theme.preference === 'light' ? <Check size={14} /> : null} onClick={() => setThemePreference('light')}>
              Clair
            </Menu.Item>
            <Menu.Item leftSection={<Moon size={15} />} rightSection={theme.preference === 'dark' ? <Check size={14} /> : null} onClick={() => setThemePreference('dark')}>
              Sombre
            </Menu.Item>
            <Menu.Item leftSection={<Monitor size={15} />} rightSection={theme.preference === 'system' ? <Check size={14} /> : null} onClick={() => setThemePreference('system')}>
              Système
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item
              leftSection={<Contrast size={15} />}
              rightSection={highContrast ? <Check size={14} /> : null}
              aria-checked={highContrast}
              role="menuitemcheckbox"
              onClick={() => setHighContrast(!highContrast)}
            >
              Contraste élevé
            </Menu.Item>
          </Menu.Sub.Dropdown>
        </Menu.Sub>
        {desktop && (
          <Menu.Item leftSection={<Server size={15} />} onClick={() => desktop?.openSetup()}>
            Changer de serveur…
          </Menu.Item>
        )}
        {!isLocalDesktop && (
          <>
            <Menu.Divider />
            <Menu.Item leftSection={<LogOut size={15} />} onClick={() => void doLogout()}>
              Se déconnecter
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
