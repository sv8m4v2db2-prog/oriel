// Settings › IA — instance-level Anthropic API key and instance-wide monthly cap (instance admins).
// The key is never sent back.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, KeyRound } from 'lucide-react';
import { AI_INSTANCE_DEFAULT_CAP_USD, AI_INSTANCE_MAX_CAP_USD, type AiSettingsResponse } from '@oriel/shared';
import { ErrorState, Skeleton } from '../components/common';
import { errorMessage } from '../lib/queryClient';
import { confirmDialog, toast } from '../lib/ui';
import { aiApi } from './api';
import { formatUsd } from './format';
import { useAiInstance } from './hooks';
import { aiKeys } from './queryKeys';
import { SettingsSection } from './SettingsSection';

const monthLabel = (month: string) => {
  const [year, m] = month.split('-');
  return new Date(Number(year), Number(m) - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
};

/** Monthly cap of all the workspaces of the server together (QA-AGT-02), and the month's spend. Instance admins only. */
export function AiInstanceCapSection() {
  const queryClient = useQueryClient();
  const instance = useAiInstance(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = instance.data;
  const description =
    'Dépense mensuelle maximale de tous les espaces de ce serveur réunis sur la clé API, quel que soit le plafond de chaque espace. ' +
    '0 désactive le brief IA sur tout le serveur. Le mois est compté en temps universel (UTC).';
  if (!data) {
    return (
      <SettingsSection title="Plafond global de l’instance" description={description}>
        {instance.isError ? <ErrorState message={errorMessage(instance.error)} onRetry={() => void instance.refetch()} /> : <Skeleton height={40} />}
      </SettingsSection>
    );
  }
  const value = draft ?? String(data.monthlyCapUsd);
  const parsed = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= AI_INSTANCE_MAX_CAP_USD;
  const changed = valid && Math.round(parsed * 100) / 100 !== data.monthlyCapUsd;
  const used = data.spentUsd + data.reservedUsd;
  const cap = data.monthlyCapUsd;
  const ratio = cap > 0 ? used / cap : used > 0 ? 1 : 0;
  const tone = ratio >= 1 ? 'is-over' : ratio >= 0.75 ? 'is-warn' : 'is-ok';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      const res = await aiApi.updateInstance({ monthlyCapUsd: Math.round(parsed * 100) / 100 });
      queryClient.setQueryData(aiKeys.instance, res);
      setDraft(null);
      toast.success('Plafond global enregistré');
      // Workspace settings and usage show whether the instance cap limits them.
      await queryClient.invalidateQueries({ queryKey: aiKeys.all });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Plafond global de l’instance" description={description}>
      <form className="ai-key-form" onSubmit={(e) => void save(e)}>
        <label className="field ai-budget">
          <span className="field-label">Plafond mensuel du serveur (dollars US)</span>
          <input
            className="input"
            type="number"
            min={0}
            max={AI_INSTANCE_MAX_CAP_USD}
            step={1}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !changed}>
          Enregistrer
        </button>
      </form>
      {!valid && <p className="field-hint">Entre 0 et {formatUsd(AI_INSTANCE_MAX_CAP_USD)}.</p>}
      {data.capIsDefault && (
        <p className="field-hint">Valeur par défaut ({formatUsd(AI_INSTANCE_DEFAULT_CAP_USD)} par mois) tant qu’aucun plafond n’a été enregistré.</p>
      )}
      <div className="ai-gauge">
        <div className="ai-gauge__head">
          <span>
            Dépensé en {monthLabel(data.month)} (UTC), tous espaces : <strong>{formatUsd(data.spentUsd)}</strong> sur {formatUsd(cap)}
          </span>
          <span className="muted">{Math.min(999, Math.round(ratio * 100))} %</span>
        </div>
        <div
          className={`ai-gauge__bar ${tone}`}
          role="progressbar"
          aria-label="Plafond global consommé"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, ratio) * 100)}
        >
          <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
        <p className="field-hint">
          {data.runs} brief{data.runs > 1 ? 's' : ''} ce mois-ci · {data.enabledWorkspaces} espace{data.enabledWorkspaces > 1 ? 's' : ''} avec le brief
          activé
          {data.reservedUsd > 0 ? ` · ${formatUsd(data.reservedUsd)} réservés par les briefs en cours` : ''}.
        </p>
      </div>
    </SettingsSection>
  );
}

export function AiKeySection({ data }: { data: AiSettingsResponse }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const { key } = data;

  const refresh = () => queryClient.invalidateQueries({ queryKey: aiKeys.all });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await aiApi.saveKey(value.trim());
      setValue('');
      toast.success('Clé API enregistrée');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Supprimer la clé API ?',
      message: 'Les briefs ne pourront plus être générés tant qu’une nouvelle clé n’est pas configurée.',
      confirmLabel: 'Supprimer la clé',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await aiApi.deleteKey();
      toast.success('Clé API supprimée');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Clé API Anthropic"
      description="Commune à tous les espaces de ce serveur. Elle n’est jamais renvoyée au navigateur : seuls ses derniers caractères sont affichés."
    >
      <div className={`ai-key-status is-${key.source}`}>
        <KeyRound size={16} />
        <span>
          {key.source === 'env' && (
            <>
              Clé fournie par la variable d’environnement <code>ANTHROPIC_API_KEY</code>
            </>
          )}
          {key.source === 'saved' && <>Clé enregistrée sur ce serveur</>}
          {key.source === 'none' && <>Aucune clé configurée</>}
          {key.hint && <span className="ai-key-status__hint"> ({key.hint})</span>}
        </span>
      </div>
      {data.fakeMode && (
        <div className="ai-note">
          <FlaskConical size={15} />
          <span>
            Mode démonstration actif (<code>ORIEL_AI_FAKE=1</code>) : les briefs sont simulés localement, sans appel à l’API ni coût.
          </span>
        </div>
      )}
      {data.canManageKey ? (
        <>
          {key.source === 'env' ? (
            <p className="field-hint">La variable d’environnement est prioritaire sur une clé enregistrée ici.</p>
          ) : (
            <form className="ai-key-form" onSubmit={(e) => void save(e)}>
              <label className="field">
                <span className="field-label">{key.source === 'saved' ? 'Remplacer la clé' : 'Clé API'}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-ant-…"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
              <button type="submit" className="btn btn--primary" disabled={busy || value.trim().length < 20}>
                Enregistrer
              </button>
              {key.source === 'saved' && (
                <button type="button" className="btn btn--danger-text" disabled={busy} onClick={() => void remove()}>
                  Supprimer
                </button>
              )}
            </form>
          )}
          <p className="field-hint">
            Sur un VPS, préférez la variable d’environnement <code>ANTHROPIC_API_KEY</code> (fichier <code>.env</code> du déploiement) : la clé
            reste alors hors de la base de données et de ses sauvegardes.
          </p>
        </>
      ) : (
        <p className="field-hint">Seul un administrateur de l’instance peut modifier la clé.</p>
      )}
    </SettingsSection>
  );
}
