// Route /w/:workspaceId/brief — latest brief, history, regeneration.
import { Link, useSearchParams } from 'react-router-dom';
import { Menu } from '@mantine/core';
import { Check, ChevronDown, CircleAlert, History, RefreshCw, Settings, Sparkles } from 'lucide-react';
import type { AiBriefSummary } from '@oriel/shared';
import { errorMessage, isNotFound } from '../lib/queryClient';
import { useDocumentTitle } from '../lib/util';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { BriefView } from './BriefView';
import { formatShortDay, formatUsd, scheduleLabel } from './format';
import { useAiSettings, useBrief, useBriefHistory, useLatestBrief, useStartBrief } from './hooks';
import './ai.css';

const STATUS_LABELS: Record<AiBriefSummary['status'], string> = {
  running: 'En cours',
  succeeded: 'Publié',
  failed: 'Échec',
  skipped: 'Non généré',
};

export function BriefPage() {
  const { workspaceId, workspace, user } = useWorkspaceCtx();
  useDocumentTitle(`Brief du jour · ${workspace.name}`);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');
  const settings = useAiSettings(workspaceId);
  const latest = useLatestBrief(workspaceId);
  const history = useBriefHistory(workspaceId);
  const selected = useBrief(selectedId);
  const { start, starting } = useStartBrief(workspaceId);

  const running = latest.data?.running ?? null;
  const conf = settings.data;
  const canRun = !!conf?.canRun && !!conf?.configured;
  // Daily quota, budget reserve of the scheduled briefs, caps (a run in progress has its own spinner).
  const manualBlock = canRun && !running && conf && !conf.manualRun.allowed ? conf.manualRun.reason : null;
  const settingsLink = user.isAdmin ? `/w/${workspaceId}/settings/ai` : null;
  const shown = selectedId ? (selected.data ?? null) : (latest.data?.latest ?? null);
  const lastRun = latest.data?.lastRun ?? null;
  const showLastFailure =
    !selectedId && !running && lastRun && (lastRun.status === 'failed' || lastRun.status === 'skipped') && lastRun.id !== shown?.id;

  const regenerate = async () => {
    const brief = await start();
    if (brief?.status === 'running' && selectedId) setParams({}, { replace: true });
  };
  const select = (id: string | null) => setParams(id ? { id } : {}, { replace: false });

  const runs = history.data?.briefs ?? [];
  const historyMenu = runs.length > 0 && (
    <Menu position="bottom-end" width={300} shadow="md">
      <Menu.Target>
        <button type="button" className="btn btn--ghost btn--sm" aria-label="Historique des briefs">
          <History size={15} /> <span className="brief-topbar__label">{shown ? formatShortDay(shown.briefDate) : 'Historique'}</span>
          <ChevronDown size={13} />
        </button>
      </Menu.Target>
      <Menu.Dropdown className="brief-history">
        <Menu.Label>Historique</Menu.Label>
        {runs.map((r) => {
          const current = shown?.id === r.id;
          const usable = r.status === 'succeeded';
          return (
            <Menu.Item
              key={r.id}
              disabled={!usable}
              onClick={() => select(r.id === latest.data?.latest?.id ? null : r.id)}
              leftSection={current ? <Check size={14} /> : <span className="brief-history__spacer" />}
              rightSection={<span className="brief-history__cost">{formatUsd(r.costUsd)}</span>}
              title={r.error ?? undefined}
            >
              <span className="brief-history__date">
                {formatShortDay(r.briefDate)} · {new Date(r.startedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className={`brief-history__status is-${r.status}`}>
                {STATUS_LABELS[r.status]}
                {r.trigger === 'schedule' ? ' · auto' : ''}
              </span>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );

  const topRight = (
    <>
      {historyMenu}
      {conf?.canRun && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!canRun || !!running || starting || !!manualBlock}
          title={!conf.configured ? (conf.blocker ?? undefined) : (manualBlock ?? undefined)}
          onClick={() => void regenerate()}
        >
          {running || starting ? <Spinner size={14} /> : <RefreshCw size={14} />} Régénérer
        </button>
      )}
    </>
  );

  let body;
  if (settings.isLoading || latest.isLoading || (selectedId && selected.isLoading)) {
    body = (
      <div className="brief" aria-busy="true">
        <Skeleton width="45%" height={30} />
        <Skeleton width="30%" style={{ marginTop: 10 }} />
        <Skeleton height={90} style={{ marginTop: 28 }} radius={10} />
        <Skeleton width="80%" style={{ marginTop: 28 }} />
        <Skeleton width="70%" style={{ marginTop: 12 }} />
        <Skeleton width="75%" style={{ marginTop: 12 }} />
      </div>
    );
  } else if (settings.isError || latest.isError) {
    body = (
      <ErrorState
        message={errorMessage(settings.error ?? latest.error)}
        onRetry={() => {
          void settings.refetch();
          void latest.refetch();
        }}
      />
    );
  } else if (selectedId && (selected.isError || !shown)) {
    body = (
      <EmptyState
        icon={<CircleAlert size={28} />}
        title={isNotFound(selected.error) ? 'Brief introuvable' : 'Impossible d’afficher ce brief'}
        action={
          <button type="button" className="btn btn--secondary" onClick={() => select(null)}>
            Voir le dernier brief
          </button>
        }
      />
    );
  } else {
    body = (
      <>
        {running && (
          <div className="brief-banner is-running" role="status">
            <Spinner size={16} />
            <div>
              <strong>Analyse des projets en cours…</strong>
              <span>Le brief s’affichera ici automatiquement (en général moins de deux minutes).</span>
            </div>
          </div>
        )}
        {showLastFailure && (
          <div className="brief-banner is-error" role="alert">
            <CircleAlert size={16} />
            <div>
              <strong>{lastRun.status === 'skipped' ? 'Brief non généré' : 'La dernière génération a échoué'}</strong>
              <span>{lastRun.error}</span>
            </div>
            {settingsLink && (
              <Link to={settingsLink} className="btn btn--ghost btn--sm">
                <Settings size={14} /> Réglages › IA
              </Link>
            )}
          </div>
        )}
        {conf && !conf.configured && shown && (
          <div className="brief-banner is-warning">
            <CircleAlert size={16} />
            <div>
              <span>{conf.blocker}</span>
            </div>
          </div>
        )}
        {shown?.content ? (
          <>
            {selectedId && (
              <button type="button" className="link-button brief-back" onClick={() => select(null)}>
                ← Revenir au dernier brief
              </button>
            )}
            <BriefView brief={shown} />
          </>
        ) : !running && conf && !conf.configured ? (
          <EmptyState
            icon={<Sparkles size={28} />}
            title="Le brief du jour n’est pas encore configuré"
            action={
              settingsLink ? (
                <Link to={settingsLink} className="btn btn--primary">
                  <Settings size={15} /> Configurer dans Réglages › IA
                </Link>
              ) : undefined
            }
          >
            <p>
              Chaque matin, un agent Claude parcourt vos pages projets et leurs rétro-plannings, puis publie ici les priorités du jour, les
              retards, les échéances de la semaine et les risques.
            </p>
            <p>{settingsLink ? conf.blocker : 'Demandez à un administrateur de l’instance de l’activer.'}</p>
          </EmptyState>
        ) : !running ? (
          <EmptyState
            icon={<Sparkles size={28} />}
            title="Aucun brief pour l’instant"
            action={
              canRun ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={starting || !!manualBlock}
                  title={manualBlock ?? undefined}
                  onClick={() => void regenerate()}
                >
                  {starting ? <Spinner size={15} /> : <Sparkles size={15} />} Générer le brief maintenant
                </button>
              ) : undefined
            }
          >
            {conf ? <p>Le prochain brief sera généré automatiquement {scheduleLabel(conf.settings)}.</p> : null}
            {manualBlock && <p>{manualBlock}</p>}
          </EmptyState>
        ) : null}
      </>
    );
  }

  return (
    <>
      <TopBar right={topRight}>
        <span className="topbar__title">
          <Sparkles size={15} /> Brief du jour
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="brief-page">{body}</div>
      </div>
    </>
  );
}
