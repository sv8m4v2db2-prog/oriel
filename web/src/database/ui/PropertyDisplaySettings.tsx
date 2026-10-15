// Settings of number properties (precision, figure / bar / ring, maximum, colour) and of date
// properties (default reminder). Rendered by the property menu (G1 / D25, D26).
import { useEffect, useState } from 'react';
import type { Color, DateReminderMode, NumberDisplay, PropertyDef } from '@oriel/shared';
import { COLOR_LABELS, COLORS, MAX_NUMBER_PRECISION } from '@oriel/shared';
import type { UpdatePropertyRequest } from '@oriel/shared';
import { useDb } from '../context';
import { NativeSelect } from './primitives';

const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 8px' } as const;

/** A patch that clears settings with null (the API treats null as « remove »). */
const patchOf = (p: Record<string, unknown>) => p as UpdatePropertyRequest;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={row}>
      <span className="ordb-small">{label}</span>
      {children}
    </div>
  );
}

export function NumberDisplaySettings({ prop }: { prop: PropertyDef }) {
  const { m, canEdit } = useDb();
  const display: NumberDisplay = prop.numberDisplay ?? 'number';
  const [maxDraft, setMaxDraft] = useState(prop.numberMax === undefined ? '' : String(prop.numberMax));
  useEffect(() => setMaxDraft(prop.numberMax === undefined ? '' : String(prop.numberMax)), [prop.numberMax]);
  const commitMax = () => {
    const n = Number(maxDraft.replace(',', '.'));
    if (maxDraft.trim() === '') void m.updateProperty(prop.id, patchOf({ numberMax: null }));
    else if (Number.isFinite(n) && n > 0) void m.updateProperty(prop.id, { numberMax: n });
    else setMaxDraft(prop.numberMax === undefined ? '' : String(prop.numberMax));
  };
  return (
    <>
      <Field label="Décimales">
        <NativeSelect
          ariaLabel="Nombre de décimales"
          disabled={!canEdit}
          value={prop.numberPrecision === undefined ? 'auto' : String(prop.numberPrecision)}
          onChange={(v) => void m.updateProperty(prop.id, v === 'auto' ? patchOf({ numberPrecision: null }) : { numberPrecision: Number(v) })}
          choices={[
            { value: 'auto', label: 'Automatique' },
            ...Array.from({ length: MAX_NUMBER_PRECISION + 1 }, (_, i) => ({ value: String(i), label: String(i) })),
          ]}
        />
      </Field>
      <Field label="Affichage">
        <NativeSelect
          ariaLabel="Affichage du nombre"
          disabled={!canEdit}
          value={display}
          onChange={(v) => void m.updateProperty(prop.id, v === 'number' ? patchOf({ numberDisplay: null }) : { numberDisplay: v as NumberDisplay })}
          choices={[
            { value: 'number', label: 'Nombre' },
            { value: 'bar', label: 'Barre' },
            { value: 'ring', label: 'Anneau' },
          ]}
        />
      </Field>
      {display !== 'number' && (
        <>
          <Field label="Valeur maximale">
            <input
              className="ordb-input"
              style={{ width: 96 }}
              aria-label="Valeur maximale"
              inputMode="decimal"
              placeholder="100"
              disabled={!canEdit}
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
              onBlur={commitMax}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </Field>
          <Field label="Couleur">
            <NativeSelect
              ariaLabel="Couleur de la progression"
              disabled={!canEdit}
              value={prop.numberColor ?? 'default'}
              onChange={(v) => void m.updateProperty(prop.id, v === 'default' ? patchOf({ numberColor: null }) : { numberColor: v as Color })}
              choices={COLORS.map((c) => ({ value: c, label: COLOR_LABELS[c] }))}
            />
          </Field>
        </>
      )}
    </>
  );
}

const REMINDER_LABELS: Record<DateReminderMode, string> = {
  none: 'Aucun',
  same_day: 'Le jour même',
  day_before: 'La veille',
  two_days_before: '2 jours avant',
  week_before: 'Une semaine avant',
};

export function DateReminderSettings({ prop }: { prop: PropertyDef }) {
  const { m, canEdit } = useDb();
  const mode: DateReminderMode = prop.dateReminder?.mode ?? 'none';
  const time = prop.dateReminder?.time ?? '09:00';
  const save = (next: { mode: DateReminderMode; time?: string }) =>
    void m.updateProperty(prop.id, patchOf({ dateReminder: next.mode === 'none' ? null : next }));
  return (
    <>
      <Field label="Rappel par défaut">
        <NativeSelect
          ariaLabel="Rappel par défaut"
          disabled={!canEdit}
          value={mode}
          onChange={(v) => save({ mode: v as DateReminderMode, time })}
          choices={(Object.keys(REMINDER_LABELS) as DateReminderMode[]).map((k) => ({ value: k, label: REMINDER_LABELS[k] }))}
        />
      </Field>
      {mode !== 'none' && (
        <Field label="À">
          <input
            type="time"
            className="ordb-input"
            aria-label="Heure du rappel"
            disabled={!canEdit}
            value={time}
            onChange={(e) => e.target.value && save({ mode, time: e.target.value })}
          />
        </Field>
      )}
      {mode !== 'none' && (
        <div className="ordb-menu-hint is-tight">
          Chaque nouvelle date saisie dans cette colonne vous envoie une notification (heure de Paris).
        </div>
      )}
    </>
  );
}
