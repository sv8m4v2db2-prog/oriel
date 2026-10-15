// Settings › IA — month spend against the monthly cap.
import { Skeleton } from '../components/common';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { formatUsd } from './format';
import { useAiUsage } from './hooks';

export function AiUsageGauge({ budget }: { budget: number }) {
  const { workspaceId } = useWorkspaceCtx();
  const usage = useAiUsage(workspaceId);
  if (usage.isLoading) return <Skeleton height={40} />;
  if (!usage.data) return null;
  const u = usage.data;
  const ratio = budget > 0 ? u.spentUsd / budget : u.spentUsd > 0 ? 1 : 0;
  const tone = ratio >= 1 ? 'is-over' : ratio >= 0.75 ? 'is-warn' : 'is-ok';
  const [year, month] = u.month.split('-');
  const monthLabel = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const details = [
    `${u.succeeded} brief${u.succeeded > 1 ? 's' : ''} publié${u.succeeded > 1 ? 's' : ''}`,
    u.failed ? `${u.failed} en échec` : null,
    u.skipped ? `${u.skipped} non généré${u.skipped > 1 ? 's' : ''} (plafond)` : null,
  ].filter(Boolean);
  return (
    <div className="ai-gauge">
      <div className="ai-gauge__head">
        <span>
          Dépensé en {monthLabel} : <strong>{formatUsd(u.spentUsd)}</strong> sur {formatUsd(budget)}
        </span>
        <span className="muted">{Math.min(999, Math.round(ratio * 100))} %</span>
      </div>
      <div
        className={`ai-gauge__bar ${tone}`}
        role="progressbar"
        aria-label="Budget mensuel consommé"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, ratio) * 100)}
      >
        <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <p className="field-hint">
        {u.runs === 0
          ? 'Aucun brief ce mois-ci.'
          : `${details.join(', ')}${u.averageCostUsd !== null ? ` · coût moyen ${formatUsd(u.averageCostUsd)} par brief` : ''}.`}
      </p>
      {u.budgetUsd > 0 && (
        <p className="field-hint">
          Générations manuelles des membres jusqu’à {formatUsd(u.manualLimitUsd)} dépensés
          {u.spentUsd >= u.manualLimitUsd ? ' : seuil atteint, le reste du plafond est réservé aux briefs automatiques.' : '.'}
        </p>
      )}
    </div>
  );
}
