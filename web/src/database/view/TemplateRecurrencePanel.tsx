// I1 — recurring row template: frequency, interval, weekdays, start, time (Europe/Paris) and end. The
// server creates the rows (background job); this panel only edits the schedule and shows the next run.
import { useState } from 'react';
import type { Page, RecurrenceFrequency, TemplateRecurrence, TemplateRecurrenceInfo } from '@oriel/shared';
import { nextOccurrence, recurrenceProblem } from '@oriel/shared';
import { Btn, cx, NativeSelect, PanelHeader } from '../ui/primitives';

const WEEKDAYS = [
  { value: 1, label: 'L', name: 'lundi' },
  { value: 2, label: 'M', name: 'mardi' },
  { value: 3, label: 'M', name: 'mercredi' },
  { value: 4, label: 'J', name: 'jeudi' },
  { value: 5, label: 'V', name: 'vendredi' },
  { value: 6, label: 'S', name: 'samedi' },
  { value: 7, label: 'D', name: 'dimanche' },
];

const UNITS: Record<RecurrenceFrequency, [string, string]> = {
  daily: ['jour', 'jours'],
  weekly: ['semaine', 'semaines'],
  monthly: ['mois', 'mois'],
  yearly: ['an', 'ans'],
};

const pad = (n: number) => String(n).padStart(2, '0');
/** Now, as 'YYYY-MM-DDTHH:MM' in Europe/Paris (the server's clock for occurrences). */
function parisNow(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${pad(Number(parts.hour) % 24)}:${parts.minute}`;
}

/** « lundi 3 mars 2031 à 09:30 » */
export function formatOccurrence(moment: string): string {
  const [date, time] = moment.split('T');
  const d = new Date(`${date}T12:00:00Z`);
  const day = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  return `${day} à ${time}`;
}

export function TemplateRecurrencePanel({
  template,
  info,
  onSave,
  onBack,
}: {
  template: Page;
  info: TemplateRecurrenceInfo | undefined;
  onSave: (recurrence: TemplateRecurrence | null) => Promise<unknown>;
  onBack: () => void;
}) {
  const today = parisNow().slice(0, 10);
  const [draft, setDraft] = useState<TemplateRecurrence>(
    () => info?.recurrence ?? { frequency: 'weekly', interval: 1, weekdays: [], startDate: today, time: '09:00', endDate: null },
  );
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<TemplateRecurrence>) => setDraft((d) => ({ ...d, ...patch }));
  const problem = recurrenceProblem(draft);
  const preview = problem ? null : nextOccurrence(draft, parisNow());
  const unit = UNITS[draft.frequency][draft.interval > 1 ? 1 : 0];
  const save = async (value: TemplateRecurrence | null) => {
    setSaving(true);
    await onSave(value);
    setSaving(false);
  };

  return (
    <div className="ordb-recurrence">
      <PanelHeader title={`Répéter « ${template.title || 'Sans titre'} »`} onBack={onBack} />
      <div className="ordb-field-row">
        <span>Fréquence</span>
        <NativeSelect
          ariaLabel="Fréquence"
          value={draft.frequency}
          onChange={(v) => set({ frequency: v as RecurrenceFrequency })}
          choices={[
            { value: 'daily', label: 'Quotidienne' },
            { value: 'weekly', label: 'Hebdomadaire' },
            { value: 'monthly', label: 'Mensuelle' },
            { value: 'yearly', label: 'Annuelle' },
          ]}
        />
      </div>
      <label className="ordb-field-row">
        <span>Tous les</span>
        <span className="ordb-recurrence-interval">
          <input
            className="ordb-input"
            type="number"
            min={1}
            max={365}
            value={draft.interval}
            aria-label="Intervalle"
            onChange={(e) => set({ interval: Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))) })}
          />
          {unit}
        </span>
      </label>
      {draft.frequency === 'weekly' && (
        <div className="ordb-field-row">
          <span>Le</span>
          <span className="ordb-weekdays" role="group" aria-label="Jours de la semaine">
            {WEEKDAYS.map((d) => {
              const on = draft.weekdays?.includes(d.value) ?? false;
              return (
                <button
                  key={d.value}
                  type="button"
                  className={cx('ordb-weekday', on && 'is-active')}
                  aria-pressed={on}
                  aria-label={d.name}
                  title={d.name}
                  onClick={() => set({ weekdays: on ? (draft.weekdays ?? []).filter((x) => x !== d.value) : [...(draft.weekdays ?? []), d.value] })}
                >
                  {d.label}
                </button>
              );
            })}
          </span>
        </div>
      )}
      <label className="ordb-field-row">
        <span>À partir du</span>
        <input className="ordb-input" type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
      </label>
      <label className="ordb-field-row">
        <span>À</span>
        <input className="ordb-input" type="time" value={draft.time} onChange={(e) => set({ time: e.target.value.slice(0, 5) })} />
      </label>
      <label className="ordb-field-row">
        <span>Jusqu’au</span>
        <input className="ordb-input" type="date" value={draft.endDate ?? ''} onChange={(e) => set({ endDate: e.target.value || null })} />
      </label>
      <div className="ordb-menu-hint is-tight" role="status">
        {problem
          ? problem
          : preview
            ? `Prochaine ligne : ${formatOccurrence(preview)} (heure de Paris).`
            : 'Aucune occurrence à venir.'}
        {info?.lastError && <div className="ordb-recurrence-error">Dernière occurrence : {info.lastError}</div>}
      </div>
      <div className="ordb-recurrence-actions">
        {info && (
          <Btn size="sm" variant="ghost" disabled={saving} onClick={() => void save(null)}>
            Arrêter la répétition
          </Btn>
        )}
        <Btn size="sm" variant="primary" disabled={saving || !!problem} onClick={() => void save(draft)}>
          Enregistrer
        </Btn>
      </div>
    </div>
  );
}
