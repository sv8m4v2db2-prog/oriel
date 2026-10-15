// Page statistics (navigation module, N10): views over 30 days, unique readers, readers (unless the
// workspace hides them) and the authors of the latest changes. Opened from the page top bar.
import { Popover, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesColumn } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../../lib/util';
import { Avatar, Skeleton } from '../../components/common';
import { useWorkspaceCtx } from '../WorkspaceContext';
import { navApi, nk } from './api';
import { profilePath } from './profile';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PageStatsButton({ pageId }: { pageId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover onOpen={() => setOpened(true)} onClose={() => setOpened(false)} width={340} position="bottom-end" shadow="md" withinPortal>
      <Tooltip label="Statistiques de la page" openDelay={400} disabled={opened}>
        <span className="nav-stats__target">
          <Popover.Target>
            <button type="button" className="icon-btn" aria-label="Statistiques de la page" aria-expanded={opened}>
              <ChartNoAxesColumn size={17} />
            </button>
          </Popover.Target>
        </span>
      </Tooltip>
      <Popover.Dropdown className="popover-panel">{opened && <StatsPanel pageId={pageId} />}</Popover.Dropdown>
    </Popover>
  );
}

function StatsPanel({ pageId }: { pageId: string }) {
  const { workspaceId } = useWorkspaceCtx();
  const stats = useQuery({ queryKey: nk.stats(pageId), queryFn: () => navApi.stats(pageId), staleTime: 30_000 });
  if (stats.isLoading) return <Skeleton height={120} radius={8} />;
  if (stats.isError || !stats.data) return <p className="muted">Statistiques indisponibles.</p>;
  const s = stats.data;
  const views30 = s.days.reduce((sum, d) => sum + d.views + d.anonymousViews, 0);
  const anon30 = s.days.reduce((sum, d) => sum + d.anonymousViews, 0);
  const max = Math.max(1, ...s.days.map((d) => d.views + d.anonymousViews));
  return (
    <div className="nav-stats">
      <div className="nav-stats__title">Statistiques</div>
      <dl className="nav-stats__figures">
        <div>
          <dt>Vues (30 jours)</dt>
          <dd>{views30}</dd>
        </div>
        <div>
          <dt>Lecteurs (7 jours)</dt>
          <dd>{s.uniqueReaders7}</dd>
        </div>
        <div>
          <dt>Lecteurs (30 jours)</dt>
          <dd>{s.uniqueReaders30}</dd>
        </div>
      </dl>
      <div className="nav-stats__chart" role="img" aria-label={`Vues par jour sur 30 jours, maximum ${max}`}>
        {s.days.map((d) => (
          <span
            key={d.date}
            className="nav-stats__bar"
            style={{ height: `${Math.round(((d.views + d.anonymousViews) / max) * 100)}%` }}
            title={`${d.date} : ${plural(d.views + d.anonymousViews, 'vue', 'vues')}`}
          />
        ))}
      </div>
      <p className="nav-stats__note">
        {plural(s.totalViews, 'vue', 'vues')} au total{anon30 > 0 ? `, dont ${plural(anon30, 'vue anonyme', 'vues anonymes')} ce mois-ci (page publiée)` : ''}.
        Une personne compte au plus une vue par demi-heure.
      </p>
      <div className="nav-stats__subtitle">Dernières modifications</div>
      {s.editors.length === 0 ? (
        <p className="muted">Aucune modification enregistrée.</p>
      ) : (
        <ul className="nav-stats__people">
          {s.editors.map((e) => (
            <li key={e.user.id}>
              <Link to={profilePath(workspaceId, e.user.id)} className="nav-stats__person">
                <Avatar name={e.user.name} id={e.user.id} url={e.user.avatarUrl} size={20} />
                <span>{e.user.name}</span>
                <span className="nav-stats__when">{formatWhen(e.at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="nav-stats__subtitle">Lecteurs ({s.uniqueReadersAll})</div>
      {s.readers === null ? (
        <p className="muted">La liste des lecteurs est masquée dans cet espace.</p>
      ) : s.readers.length === 0 ? (
        <p className="muted">Personne n’a encore consulté cette page.</p>
      ) : (
        <ul className="nav-stats__people">
          {s.readers.slice(0, 12).map((r) => (
            <li key={r.user.id}>
              <Link to={profilePath(workspaceId, r.user.id)} className="nav-stats__person">
                <Avatar name={r.user.name} id={r.user.id} url={r.user.avatarUrl} size={20} />
                <span>{r.user.name}</span>
                <span className="nav-stats__when">{formatWhen(r.lastVisitedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
