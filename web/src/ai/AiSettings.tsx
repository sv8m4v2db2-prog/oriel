// Settings › IA: instance API key and cap, and the workspace's « Brief du jour » settings.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@mantine/core';
import { Check, Database, Info, Sparkles, TriangleAlert } from 'lucide-react';
import {
  AI_MANUAL_BUDGET_SHARE,
  AI_MANUAL_RUNS_PER_DAY,
  AI_MODELS,
  AI_WEEKDAY_LABELS,
  type AiSettings as AiSettingsValues,
  type IsoWeekday,
  type UpdateAiSettingsRequest,
} from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { ErrorState, Skeleton, Spinner } from '../components/common';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { aiApi } from './api';
import { aiKeys } from './queryKeys';
import { formatUsd, scheduleLabel } from './format';
import { useAiSettings, useStartBrief } from './hooks';
import { AiInstanceCapSection, AiKeySection } from './AiKeySection';
import { AiSourcePicker } from './AiSourcePicker';
import { AiUsageGauge } from './AiUsageGauge';
import { SettingsSection as Section } from './SettingsSection';
import './ai.css';

type Draft = Omit<AiSettingsValues, 'updatedAt' | 'updatedBy'>;
const DAYS: IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];
const BRIEFS_PER_MONTH = 22;

const toDraft = (s: AiSettingsValues): Draft => ({
  enabled: s.enabled,
  model: s.model,
  sourceDatabaseIds: [...s.sourceDatabaseIds],
  scheduleTime: s.scheduleTime,
  scheduleDays: [...s.scheduleDays],
  timezone: s.timezone,
  monthlyBudgetUsd: s.monthlyBudgetUsd,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function timeZones(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'Europe/London', 'America/Montreal', 'UTC'];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

export function AiSettings() {
  const { workspaceId, workspace } = useWorkspaceCtx();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const settings = useAiSettings(workspaceId);
  const { start, starting } = useStartBrief(workspaceId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const data = settings.data;
  const saved = useMemo(() => (data ? toDraft(data.settings) : null), [data]);
  const dirty = !!(draft && saved && !same(draft, saved));
  const zones = useMemo(() => timeZones(draft?.timezone ?? 'Europe/Paris'), [draft?.timezone]);

  // Adopt the server state unless the user has pending edits.
  useEffect(() => {
    if (saved) setDraft((d) => (d === null || !dirty ? saved : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  if (!data || !draft) {
    return (
      <>
        <h1 className="settings__title">Intelligence artificielle</h1>
        {settings.isError ? <ErrorState message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} /> : <Skeleton height={120} />}
      </>
    );
  }
  const readOnly = !data.canManage;
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    if (!saved) return;
    const body: UpdateAiSettingsRequest = {};
    for (const k of Object.keys(draft) as Array<keyof Draft>) {
      if (!same(draft[k], saved[k])) (body as Record<string, unknown>)[k] = draft[k];
    }
    setSaving(true);
    try {
      const res = await aiApi.updateSettings(workspaceId, body);
      queryClient.setQueryData(aiKeys.settings(workspaceId), res);
      setDraft(toDraft(res.settings));
      void queryClient.invalidateQueries({ queryKey: aiKeys.usage(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.latest(workspaceId) });
      toast.success('Réglages IA enregistrés');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    const brief = await start();
    if (brief?.status === 'running') navigate(`/w/${workspaceId}/brief`);
  };

  return (
    <div className="ai-settings">
      <h1 className="settings__title">Intelligence artificielle</h1>
      <p className="ai-settings__intro">
        <Sparkles size={15} />
        <span>
          Chaque matin, un agent Claude lit les pages projets de « {workspace.name} » et leurs rétro-plannings, puis publie le{' '}
          <strong>Brief du jour</strong> : priorités, retards, échéances de la semaine, risques et point par projet.
        </span>
      </p>

      <AiKeySection data={data} />
      {data.canManageKey && <AiInstanceCapSection />}

      <Section
        title="Brief du jour"
        description={readOnly ? 'Seuls les propriétaires et administrateurs de l’espace peuvent modifier ces réglages.' : undefined}
      >
        <Switch
          checked={draft.enabled}
          disabled={readOnly}
          onChange={(e) => set({ enabled: e.currentTarget.checked })}
          label="Activer le brief du jour pour cet espace"
          description={
            draft.enabled
              ? `Brief automatique ${scheduleLabel(draft)} (${draft.timezone}), et à la demande.`
              : 'Le brief est désactivé : son entrée est masquée pour les membres.'
          }
        />
        {data.blocker && saved?.enabled && (
          <div className="ai-note is-warning">
            <TriangleAlert size={15} />
            <span>{data.blocker}</span>
          </div>
        )}
      </Section>

      <Section title="Modèle" description="Estimations pour une quinzaine de projets actifs ; le coût réel de chaque brief est mesuré et affiché.">
        <div className="radio-cards" role="radiogroup" aria-label="Modèle">
          {AI_MODELS.map((m) => {
            const [low, high] = m.estimatePerBriefUsd;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={draft.model === m.id}
                disabled={readOnly}
                className={`radio-card ai-model${draft.model === m.id ? ' is-active' : ''}`}
                onClick={() => set({ model: m.id })}
              >
                <span className="radio-card__label">
                  {m.label}
                  {m.recommended && (
                    <span className="tag" data-color="blue">
                      Recommandé
                    </span>
                  )}
                </span>
                <span className="radio-card__desc">{m.description}</span>
                <span className="ai-model__cost">
                  ≈ {formatUsd(low)} à {formatUsd(high)} par brief · ≈ {formatUsd(Math.round(low * BRIEFS_PER_MONTH * 100) / 100)} à{' '}
                  {formatUsd(Math.round(high * BRIEFS_PER_MONTH * 100) / 100)} par mois ({BRIEFS_PER_MONTH} briefs)
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Bases « Projets » à analyser" description="Les bases dont les lignes sont vos projets (ou vos tâches datées).">
        <AiSourcePicker value={draft.sourceDatabaseIds} onChange={(ids) => set({ sourceDatabaseIds: ids })} disabled={readOnly} data={data} />
      </Section>

      <Section title="Planification">
        <div className="ai-schedule">
          <label className="field">
            <span className="field-label">Heure</span>
            <input
              className="input"
              type="time"
              value={draft.scheduleTime}
              disabled={readOnly}
              onChange={(e) => e.target.value && set({ scheduleTime: e.target.value.slice(0, 5) })}
            />
          </label>
          <label className="field ai-schedule__tz">
            <span className="field-label">Fuseau horaire</span>
            <select className="input select" value={draft.timezone} disabled={readOnly} onChange={(e) => set({ timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span className="field-label">Jours</span>
          <div className="ai-days" role="group" aria-label="Jours du brief automatique">
            {DAYS.map((d) => {
              const active = draft.scheduleDays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  className={`ai-day${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  disabled={readOnly}
                  title={AI_WEEKDAY_LABELS[d]}
                  onClick={() =>
                    set({ scheduleDays: active ? draft.scheduleDays.filter((x) => x !== d) : [...draft.scheduleDays, d].sort((a, b) => a - b) })
                  }
                >
                  {AI_WEEKDAY_LABELS[d].slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title="Budget" description="Au-delà du plafond mensuel, aucun brief n’est généré jusqu’au mois suivant ; un brief en cours s’arrête s’il l’atteint.">
        <label className="field ai-budget">
          <span className="field-label">Plafond mensuel (dollars US)</span>
          <input
            className="input"
            type="number"
            min={0}
            max={10000}
            step={1}
            value={draft.monthlyBudgetUsd}
            disabled={readOnly}
            onChange={(e) => set({ monthlyBudgetUsd: Math.min(10000, Math.max(0, Number(e.target.value) || 0)) })}
          />
        </label>
        <AiUsageGauge budget={saved?.monthlyBudgetUsd ?? draft.monthlyBudgetUsd} />
        {data.instanceCap === 'reached' && (
          <div className="ai-note is-warning">
            <TriangleAlert size={15} />
            <span>
              Le plafond global de l’instance, fixé par l’administrateur du serveur pour tous les espaces, est atteint ce mois-ci : aucun brief
              ne sera généré avant le mois prochain, sauf s’il le relève.
            </span>
          </div>
        )}
        {data.instanceCap === 'limiting' && (
          <div className="ai-note">
            <Info size={15} />
            <span>
              Le plafond global de l’instance, fixé par l’administrateur du serveur pour tous les espaces, limite actuellement la dépense de cet
              espace en dessous de son propre plafond.
            </span>
          </div>
        )}
        <p className="field-hint">
          Les membres peuvent lancer {AI_MANUAL_RUNS_PER_DAY} générations manuelles par jour au plus, tant que la dépense du mois reste sous{' '}
          {Math.round(AI_MANUAL_BUDGET_SHARE * 100)} % du plafond : le reste est réservé aux briefs automatiques. Les propriétaires et
          administrateurs de l’espace ne sont pas limités.
        </p>
      </Section>

      {!readOnly && dirty && (
        <div className="ai-settings__save" role="region" aria-label="Modifications non enregistrées">
          <span className="ai-settings__save-text">Modifications non enregistrées</span>
          <button type="button" className="btn btn--ghost" disabled={saving} onClick={() => saved && setDraft(saved)}>
            Annuler
          </button>
          <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner size={14} /> : <Check size={15} />} Enregistrer
          </button>
        </div>
      )}

      <Section title="Générer maintenant">
        <div className="ai-generate">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={!data.canRun || !data.configured || !data.manualRun.allowed || dirty || starting}
            onClick={() => void generate()}
            title={dirty ? 'Enregistrez d’abord vos modifications.' : undefined}
          >
            {starting ? <Spinner size={14} /> : <Sparkles size={15} />} Générer le brief maintenant
          </button>
          {!data.configured && data.blocker && <span className="field-hint">{data.blocker}</span>}
          {data.configured && data.canRun && data.manualRun.reason && <span className="field-hint">{data.manualRun.reason}</span>}
          {data.configured && data.manualRun.allowed && data.manualRun.dailyLimit !== null && (
            <span className="field-hint">
              {data.manualRun.usedToday} / {data.manualRun.dailyLimit} générations manuelles des membres aujourd’hui
            </span>
          )}
        </div>
      </Section>

      <Section title="Confidentialité">
        <div className="ai-note">
          <Database size={15} />
          <span>
            Pour chaque brief, le contenu des projets analysés (titres, propriétés des lignes, texte des pages lues) est envoyé à l’API
            d’Anthropic. Les pages privées et la corbeille ne sont jamais lues, et l’agent n’a qu’un accès en lecture.
          </span>
        </div>
      </Section>
    </div>
  );
}
