// Compact card of the latest brief on the Home page (nothing when the feature is disabled).
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Skeleton, Spinner } from '../components/common';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { formatLongDay, scheduleLabel, todayKey } from './format';
import { useAiSettings, useLatestBrief } from './hooks';
import './ai.css';

export function HomeBriefCard() {
  const { workspaceId } = useWorkspaceCtx();
  const settings = useAiSettings(workspaceId);
  const enabled = !!settings.data?.settings.enabled;
  const latest = useLatestBrief(workspaceId, enabled);
  if (!enabled) return null;
  const brief = latest.data?.latest ?? null;
  const running = latest.data?.running ?? null;
  const c = brief?.content ?? null;
  const isToday = brief?.briefDate === todayKey();

  return (
    <section className="brief-card" aria-label="Brief du jour">
      <div className="brief-card__head">
        <span className="brief-card__title">
          <Sparkles size={15} /> Brief du jour
        </span>
        {brief && <span className="brief-card__date">{isToday ? 'Aujourd’hui' : `Dernier brief : ${formatLongDay(brief.briefDate)}`}</span>}
        {running && (
          <span className="brief-card__running">
            <Spinner size={13} /> Analyse en cours…
          </span>
        )}
      </div>
      {latest.isLoading ? (
        <>
          <Skeleton width="90%" />
          <Skeleton width="70%" style={{ marginTop: 8 }} />
        </>
      ) : c ? (
        <>
          <p className="brief-card__summary">{c.resume}</p>
          <div className="brief-card__counts">
            <span className="brief-stat">
              <strong>{c.priorites.length}</strong> priorité{c.priorites.length > 1 ? 's' : ''}
            </span>
            <span className={`brief-stat${c.en_retard.length ? ' is-danger' : ''}`}>
              <strong>{c.en_retard.length}</strong> en retard
            </span>
            <span className="brief-stat">
              <strong>{c.a_venir.length}</strong> à venir
            </span>
            <span className={`brief-stat${c.risques.some((r) => r.gravite === 'haute') ? ' is-danger' : ''}`}>
              <strong>{c.risques.length}</strong> risque{c.risques.length > 1 ? 's' : ''}
            </span>
          </div>
        </>
      ) : (
        <p className="brief-card__summary muted">
          {settings.data?.configured
            ? `Aucun brief pour l’instant. Le prochain sera généré ${scheduleLabel(settings.data.settings)}.`
            : (settings.data?.blocker ?? 'Le brief du jour n’est pas encore configuré.')}
        </p>
      )}
      <div className="brief-card__actions">
        <Link to={`/w/${workspaceId}/brief`} className="btn btn--secondary btn--sm">
          Voir le brief <ArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
}
