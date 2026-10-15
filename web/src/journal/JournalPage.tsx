// « Journal » : monthly calendar (days with a page are marked), today shortcut, template choice.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, NotebookPen } from 'lucide-react';
import { errorMessage, queryClient } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { useDocumentTitle } from '../lib/util';
import { useTree } from '../lib/tree';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { TopBar } from '../shell/TopBar';
import { orgApi, ok } from '../organize/api';
import { invalidateOrg } from '../organize/hooks';
import { dayKey, dayLabel, isOpenableDay, monthGrid, monthLabel, shiftMonth, WEEKDAYS_SHORT } from './calendar';
import { openJournalDay, openJournalToday } from './openJournal';
import './journal.css';

function currentMonth(): string {
  return dayKey(new Date()).slice(0, 7);
}

export function JournalPage() {
  const { workspaceId, workspace, canEdit } = useWorkspaceCtx();
  useDocumentTitle(`Journal · ${workspace.name}`);
  const [month, setMonth] = useState(currentMonth);
  const today = dayKey(new Date());
  const data = useQuery({ queryKey: ok.journal(workspaceId, month), queryFn: () => orgApi.journal(workspaceId, month), placeholderData: (p) => p });
  const pages = useMemo(() => new Map((data.data?.days ?? []).map((d) => [d.day, d.pageId] as const)), [data.data]);
  const grid = useMemo(() => monthGrid(month), [month]);

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <NotebookPen size={15} /> Journal
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="narrow-page journal">
          <h1 className="narrow-page__title">Journal</h1>
          <p className="muted">Une page privée par jour, rangée sous « Journal » dans la section Privé. Cliquez sur un jour pour l’ouvrir ou le créer.</p>

          <div className="journal__bar">
            <button type="button" className="icon-btn" aria-label="Mois précédent" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
              <ChevronLeft size={17} />
            </button>
            <h2 className="journal__month" aria-live="polite">
              {monthLabel(month)}
            </h2>
            <button type="button" className="icon-btn" aria-label="Mois suivant" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
              <ChevronRight size={17} />
            </button>
            <span className="org-toolbar__spacer" />
            <button type="button" className="btn" onClick={() => setMonth(currentMonth())}>
              Ce mois-ci
            </button>
            {canEdit && (
              <button type="button" className="btn btn--primary" onClick={() => void openJournalToday(workspaceId)}>
                Journal du jour
              </button>
            )}
          </div>

          <div className="journal__grid" role="grid" aria-label={`Calendrier de ${monthLabel(month)}`}>
            {WEEKDAYS_SHORT.map((w) => (
              <div key={w} className="journal__weekday" role="columnheader">
                {w}
              </div>
            ))}
            {grid.map((cell) => {
              const has = pages.has(cell.day);
              const disabled = !isOpenableDay(cell.day) || (!has && !canEdit);
              return (
                <button
                  key={cell.day}
                  type="button"
                  role="gridcell"
                  disabled={disabled}
                  className={`journal__day${cell.inMonth ? '' : ' is-outside'}${has ? ' has-entry' : ''}${cell.day === today ? ' is-today' : ''}`}
                  aria-label={`${dayLabel(cell.day)}${has ? ' — page existante' : ''}`}
                  aria-current={cell.day === today ? 'date' : undefined}
                  onClick={() => void openJournalDay(workspaceId, cell.day)}
                >
                  {Number(cell.day.slice(8))}
                </button>
              );
            })}
          </div>
          {data.isError && <p className="muted">{errorMessage(data.error, 'Calendrier indisponible.')}</p>}

          <JournalTemplateSetting current={data.data?.template ?? null} />
        </div>
      </div>
    </>
  );
}

/** Choice of the page template used for new days (reuses the workspace's page templates). */
export function JournalTemplateSetting({ current }: { current: { id: string; title: string } | null }) {
  const { workspaceId, canEdit } = useWorkspaceCtx();
  const tree = useTree(workspaceId);
  const templates = useMemo(() => [...tree.index.byId.values()].filter((n) => n.isTemplate), [tree.index]);
  const set = async (templateId: string | null) => {
    try {
      await orgApi.setJournalTemplate(workspaceId, templateId);
      invalidateOrg('journal');
      void queryClient.invalidateQueries({ queryKey: ['org', 'journal'] });
    } catch (e) {
      toast.error(errorMessage(e, 'Réglage impossible.'));
    }
  };
  if (!canEdit) return null;
  return (
    <section className="journal__template">
      <h2 className="journal__h">Modèle de journal</h2>
      <p className="muted">Chaque nouvelle journée est une copie de ce modèle de page. Marquez une page comme modèle depuis son menu « … ».</p>
      <select
        className="input"
        aria-label="Modèle de journal"
        value={current?.id ?? ''}
        onChange={(e) => void set(e.target.value || null)}
      >
        <option value="">Page vide</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title || 'Sans titre'}
          </option>
        ))}
      </select>
    </section>
  );
}

export function JournalSettings() {
  const { workspaceId } = useWorkspaceCtx();
  const month = currentMonth();
  const data = useQuery({ queryKey: ok.journal(workspaceId, month), queryFn: () => orgApi.journal(workspaceId, month) });
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Journal</h2>
      <div className="settings-section__body">
        <JournalTemplateSetting current={data.data?.template ?? null} />
      </div>
    </section>
  );
}
