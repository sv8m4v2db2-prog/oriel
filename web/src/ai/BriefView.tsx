// Rendering of one brief: summary, priorities, overdue, upcoming, risks, projects, run footer.
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CalendarX, FolderKanban, ListChecks, ShieldAlert, Sparkles, User } from 'lucide-react';
import {
  BRIEF_PROJECT_STATE_LABELS,
  BRIEF_SEVERITY_LABELS,
  type AiBrief,
  type BriefItem,
  type BriefSeverity,
  type BriefTarget,
} from '@oriel/shared';
import { navigation } from '../lib/navigation';
import { formatWhen, pagePath } from '../lib/util';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { formatDuration, formatLongDay, formatShortDay, formatTokens, formatUsd, modelLabel, relativeDay } from './format';

/** Link to a page of the brief: database rows open in the side peek, other pages navigate. */
export function BriefPageLink({ id, cible, children, className }: { id: string; cible: BriefTarget; children: ReactNode; className?: string }) {
  const { workspaceId } = useWorkspaceCtx();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (cible !== 'ligne' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigation.openPeek(id);
  };
  return (
    <Link to={pagePath(workspaceId, id)} onClick={onClick} className={className ?? 'brief-link'}>
      {children}
    </Link>
  );
}

const SEVERITY_COLOR: Record<BriefSeverity, string> = { haute: 'red', moyenne: 'orange', basse: 'yellow' };

function Section({ icon, title, count, tone, children }: { icon: ReactNode; title: string; count?: number; tone?: 'danger'; children: ReactNode }) {
  return (
    <section className={`brief-section${tone ? ` brief-section--${tone}` : ''}`}>
      <h2 className="brief-section__title">
        {icon}
        {title}
        {count !== undefined && <span className="brief-section__count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="brief-empty">{children}</p>;
}

function Item({ item, index, today, showDue = true }: { item: BriefItem; index?: number; today: string; showDue?: boolean }) {
  return (
    <li className="brief-item">
      {index !== undefined && <span className="brief-item__rank">{index + 1}</span>}
      <div className="brief-item__body">
        <div className="brief-item__head">
          <BriefPageLink id={item.pageId} cible={item.cible} className="brief-link brief-item__title">
            {item.titre}
          </BriefPageLink>
          {item.projetId && item.projetTitre && (
            <BriefPageLink id={item.projetId} cible="page" className="brief-chip">
              <FolderKanban size={12} /> {item.projetTitre}
            </BriefPageLink>
          )}
        </div>
        {(item.note || (showDue && item.echeance) || item.responsables.length > 0) && (
          <div className="brief-item__meta">
            {showDue && item.echeance && (
              <span className={`brief-due${item.echeance < today ? ' is-late' : ''}`} title={formatLongDay(item.echeance)}>
                <CalendarClock size={12} /> {formatShortDay(item.echeance)} · {relativeDay(item.echeance, today)}
              </span>
            )}
            {item.responsables.length > 0 && (
              <span className="brief-people">
                <User size={12} /> {item.responsables.join(', ')}
              </span>
            )}
            {item.note && <span className="brief-item__note">{item.note}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

export function BriefView({ brief }: { brief: AiBrief }) {
  const c = brief.content;
  if (!c) return null;
  const upcoming = [...c.a_venir].sort((a, b) => (a.echeance ?? '9999').localeCompare(b.echeance ?? '9999'));
  const totalTokens = brief.usage.inputTokens + brief.usage.outputTokens + brief.usage.cacheCreationTokens + brief.usage.cacheReadTokens;
  return (
    <article className="brief">
      <header className="brief__header">
        <h1 className="brief__title">Brief du {formatLongDay(brief.briefDate)}</h1>
        <p className="brief__meta">
          {brief.trigger === 'schedule' ? 'Brief automatique' : `Généré à la demande${brief.createdBy?.name ? ` par ${brief.createdBy.name}` : ''}`}
          {brief.finishedAt ? ` · ${formatWhen(brief.finishedAt)}` : ''}
        </p>
      </header>

      <section className="brief-summary">
        <Sparkles size={16} className="brief-summary__icon" />
        <p>{c.resume || 'Aucun résumé.'}</p>
      </section>

      <div className="brief-stats" role="list">
        <span className="brief-stat" role="listitem">
          <strong>{c.priorites.length}</strong> priorité{c.priorites.length > 1 ? 's' : ''}
        </span>
        <span className={`brief-stat${c.en_retard.length ? ' is-danger' : ''}`} role="listitem">
          <strong>{c.en_retard.length}</strong> en retard
        </span>
        <span className="brief-stat" role="listitem">
          <strong>{c.a_venir.length}</strong> à venir
        </span>
        <span className={`brief-stat${c.risques.some((r) => r.gravite === 'haute') ? ' is-danger' : ''}`} role="listitem">
          <strong>{c.risques.length}</strong> risque{c.risques.length > 1 ? 's' : ''}
        </span>
      </div>

      <Section icon={<ListChecks size={16} />} title="Priorités du jour" count={c.priorites.length}>
        {c.priorites.length === 0 ? (
          <Empty>Aucune priorité particulière aujourd’hui.</Empty>
        ) : (
          <ol className="brief-list">
            {c.priorites.map((item, i) => (
              <Item key={`${item.pageId}-${i}`} item={item} index={i} today={brief.briefDate} />
            ))}
          </ol>
        )}
      </Section>

      <Section icon={<CalendarX size={16} />} title="En retard" count={c.en_retard.length} tone={c.en_retard.length ? 'danger' : undefined}>
        {c.en_retard.length === 0 ? (
          <Empty>Aucune tâche en retard.</Empty>
        ) : (
          <ul className="brief-list">
            {c.en_retard.map((item, i) => (
              <Item key={`${item.pageId}-${i}`} item={item} today={brief.briefDate} />
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<CalendarClock size={16} />} title="À venir (7 jours)" count={upcoming.length}>
        {upcoming.length === 0 ? (
          <Empty>Aucune échéance dans les 7 prochains jours.</Empty>
        ) : (
          <ul className="brief-list">
            {upcoming.map((item, i) => (
              <Item key={`${item.pageId}-${i}`} item={item} today={brief.briefDate} />
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<ShieldAlert size={16} />} title="Risques" count={c.risques.length}>
        {c.risques.length === 0 ? (
          <Empty>Aucun risque identifié.</Empty>
        ) : (
          <ul className="brief-risks">
            {c.risques.map((risk, i) => (
              <li key={i} className={`brief-risk is-${risk.gravite}`}>
                <span className="tag brief-risk__badge" data-color={SEVERITY_COLOR[risk.gravite]}>
                  <AlertTriangle size={11} /> {BRIEF_SEVERITY_LABELS[risk.gravite]}
                </span>
                <div className="brief-risk__body">
                  <p>{risk.description}</p>
                  {risk.pages.length > 0 && (
                    <div className="brief-risk__pages">
                      {risk.pages.map((p) => (
                        <BriefPageLink key={p.id} id={p.id} cible={p.cible} className="brief-chip">
                          {p.titre}
                        </BriefPageLink>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<FolderKanban size={16} />} title="Projets" count={c.projets.length}>
        {c.projets.length === 0 ? (
          <Empty>Aucun projet actif.</Empty>
        ) : (
          <div className="brief-projects">
            {c.projets.map((p) => (
              <div key={p.pageId} className={`brief-project is-${p.etat}`}>
                <div className="brief-project__head">
                  <BriefPageLink id={p.pageId} cible={p.cible} className="brief-link brief-project__title">
                    {p.titre}
                  </BriefPageLink>
                  <span className="brief-project__state">{BRIEF_PROJECT_STATE_LABELS[p.etat]}</span>
                </div>
                {p.commentaire && <p className="brief-project__comment">{p.commentaire}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      <footer className="brief-footer">
        <span>Modèle : {modelLabel(brief.model)}</span>
        <span title={`Entrée ${formatTokens(brief.usage.inputTokens)} · sortie ${formatTokens(brief.usage.outputTokens)} · écriture cache ${formatTokens(brief.usage.cacheCreationTokens)} · lecture cache ${formatTokens(brief.usage.cacheReadTokens)}`}>
          {formatTokens(totalTokens)} jetons
          {brief.usage.cacheReadTokens > 0 ? ` (dont ${formatTokens(brief.usage.cacheReadTokens)} lus en cache)` : ''}
        </span>
        <span>Coût : {formatUsd(brief.costUsd)}</span>
        {brief.finishedAt && <span>Généré en {formatDuration(brief.finishedAt - brief.startedAt)}</span>}
        <span>
          {brief.turns} tour{brief.turns > 1 ? 's' : ''} d’analyse
        </span>
      </footer>
    </article>
  );
}
