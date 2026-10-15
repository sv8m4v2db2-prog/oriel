// Settings tabs and sidebar link of the navigation module (registered in features/registry.tsx).
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Switch } from '@mantine/core';
import { Users } from 'lucide-react';
import { errorMessage, queryClient } from '../../lib/queryClient';
import { toast } from '../../lib/ui';
import { useWorkspaceCtx } from '../WorkspaceContext';
import { navApi, nk } from './api';
import { setHighContrast, useHighContrast } from './contrast';

/** "Espaces d'équipe" entry of the sidebar navigation (directory). */
export function TeamspacesSidebarLink() {
  const { workspaceId } = useWorkspaceCtx();
  return (
    <NavLink to={`/w/${workspaceId}/teamspaces`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
      <Users size={16} />
      <span className="nav-item__label">Espaces d’équipe</span>
    </NavLink>
  );
}

export function AccessibilitySettings() {
  const high = useHighContrast();
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Accessibilité</h2>
      <Switch
        checked={high}
        onChange={(e) => setHighContrast(e.currentTarget.checked)}
        label="Contraste élevé"
        description="Textes, bordures et contours de focus renforcés, en thème clair comme en sombre. Réglage propre à cet appareil."
      />
    </section>
  );
}

export function PageStatsSettings() {
  const { workspaceId, canManage } = useWorkspaceCtx();
  const settings = useQuery({ queryKey: nk.settings(workspaceId), queryFn: () => navApi.settings(workspaceId) });
  const update = async (showReaders: boolean) => {
    try {
      const next = await navApi.updateSettings(workspaceId, { showReaders });
      queryClient.setQueryData(nk.settings(workspaceId), next);
      toast.success(showReaders ? 'Les lecteurs sont affichés' : 'Les lecteurs sont masqués');
    } catch (e) {
      toast.error(errorMessage(e, 'Réglage impossible.'));
    }
  };
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Statistiques des pages</h2>
      <p className="muted">
        Les membres voient, pour chaque page qu’ils peuvent lire, le nombre de vues et de lecteurs ainsi que les auteurs des dernières
        modifications. Les visiteurs anonymes d’une page publiée ne sont qu’un compteur, sans donnée personnelle.
      </p>
      <Switch
        checked={settings.data?.showReaders ?? true}
        disabled={!canManage || !settings.data}
        onChange={(e) => void update(e.currentTarget.checked)}
        label="Afficher la liste des lecteurs"
        description={canManage ? 'Désactivé : seuls les chiffres restent visibles.' : 'Seuls les propriétaires et administrateurs peuvent changer ce réglage.'}
      />
    </section>
  );
}
