// Small calendar picker: single date or range, optional time, clear.
import { useMemo, useState } from 'react';
import {
  addDays,
  addMonths,
  format,
  isSameDay,
  isSameMonth,
  setHours,
  setMinutes,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Trash } from 'lucide-react';
import type { DateValue } from '@oriel/shared';
import { dateValueToRange, serializeDate } from '../../logic/dates';
import { describeNaturalDate, parseNaturalDate, type NaturalDate } from '../../../lib/naturalDate';
import { cx, IconBtn, MenuDivider, MenuItem, Toggle } from '../primitives';

const WEEKDAYS = ['lu', 'ma', 'me', 'je', 've', 'sa', 'di'];

/** Parses "13/10/2026", "13/10/26", "13-10-2026" or "2026-10-13" (local). */
export function parseTypedDate(input: string): Date | null {
  const s = input.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
    return d.getMonth() === Number(m[2]) - 1 ? d : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 ? d : null;
  }
  return null;
}

/** Parses "14:30", "14h30", "14h", "9" → [hours, minutes]. */
export function parseTypedTime(input: string): [number, number] | null {
  const m = /^(\d{1,2})(?:\s*[:hH]\s*(\d{1,2})?)?$/.exec(input.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h < 24 && min < 60 ? [h, min] : null;
}

function withTimeOf(day: Date, source: Date | null, includeTime: boolean): Date {
  const base = startOfDay(day);
  if (!includeTime) return base;
  return setMinutes(setHours(base, source ? source.getHours() : 9), source ? source.getMinutes() : 0);
}

function DateField({
  label,
  date,
  includeTime,
  active,
  onFocus,
  onDate,
  onTime,
  onNatural,
}: {
  label: string;
  date: Date | null;
  includeTime: boolean;
  active: boolean;
  onFocus: () => void;
  onDate: (d: Date) => void;
  onTime: (h: number, m: number) => void;
  /** A date written in words (« demain », « lundi 14h », « du 12 au 14 nov »). */
  onNatural: (r: NaturalDate) => void;
}) {
  const shown = date ? format(date, 'dd/MM/yyyy') : '';
  const shownTime = date ? format(date, 'HH:mm') : '';
  const [draft, setDraft] = useState<string | null>(null);
  const [draftTime, setDraftTime] = useState<string | null>(null);
  return (
    <div className={cx('ordb-date-field', active && 'is-active')} onClick={onFocus}>
      <input
        className="ordb-input"
        aria-label={label}
        placeholder="jj/mm/aaaa ou « demain »"
        value={draft ?? shown}
        onFocus={onFocus}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft.trim() !== '') {
            const d = parseTypedDate(draft);
            if (d) onDate(d);
            else {
              const natural = parseNaturalDate(draft);
              if (natural) onNatural(natural);
            }
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {draft !== null && draft.trim() !== '' && !parseTypedDate(draft) && (() => {
        const natural = parseNaturalDate(draft);
        return (
          <span className="ordb-muted ordb-small" role="status">
            {natural ? `→ ${describeNaturalDate(natural)}` : 'Date non reconnue'}
          </span>
        );
      })()}
      {includeTime && (
        <input
          className="ordb-input ordb-time-input"
          aria-label={`${label} (heure)`}
          placeholder="hh:mm"
          value={draftTime ?? shownTime}
          onFocus={onFocus}
          onChange={(e) => setDraftTime(e.target.value)}
          onBlur={() => {
            if (draftTime !== null) {
              const t = parseTypedTime(draftTime);
              if (t) onTime(t[0], t[1]);
            }
            setDraftTime(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </div>
  );
}

export function DateEditor({ value, onChange }: { value: DateValue | null; onChange: (v: DateValue | null) => void }) {
  const range = dateValueToRange(value);
  const start = range?.start ?? null;
  const end = range?.end ?? null;
  const includeTime = !!range?.includeTime;
  const hasEnd = !!value?.end;
  const [month, setMonth] = useState(() => startOfMonth(start ?? new Date()));
  const [focus, setFocus] = useState<'start' | 'end'>('start');

  const emit = (s: Date | null, e: Date | null, withTime: boolean, keepEnd = hasEnd) => {
    if (!s) {
      onChange(null);
      return;
    }
    let a = s;
    let b = keepEnd ? (e ?? s) : null;
    if (b && b < a) [a, b] = [b, a];
    const v: DateValue = { start: serializeDate(a, withTime) };
    if (b) v.end = serializeDate(b, withTime);
    if (withTime) v.includeTime = true;
    onChange(v);
  };

  /** Applies a date typed in words to the field being edited; a time or a range turns those options on. */
  const applyNatural = (r: NaturalDate, field: 'start' | 'end') => {
    const withTime = r.hasTime || includeTime;
    if (r.end) emit(r.start, r.end, withTime, true);
    else if (field === 'end') emit(start ?? r.start, r.start, withTime, true);
    else emit(r.start, end, withTime);
    setMonth(startOfMonth(r.start));
  };

  const days = useMemo(() => {
    const first = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [month]);

  const pick = (day: Date) => {
    if (focus === 'end' && hasEnd) {
      emit(start ?? withTimeOf(day, null, includeTime), withTimeOf(day, end, includeTime), includeTime);
      setFocus('start');
    } else {
      const s = withTimeOf(day, start, includeTime);
      emit(s, end && end < s ? s : end, includeTime);
      if (hasEnd) setFocus('end');
    }
  };

  const today = new Date();
  const inRange = (d: Date) => {
    if (!start || !end) return false;
    const t = startOfDay(d).getTime();
    return t > startOfDay(start).getTime() && t < startOfDay(end).getTime();
  };

  return (
    <div className="ordb-date-editor">
      <div className="ordb-date-fields">
        <DateField
          label="Date de début"
          date={start}
          includeTime={includeTime}
          active={focus === 'start'}
          onFocus={() => setFocus('start')}
          onDate={(d) => {
            emit(withTimeOf(d, start, includeTime), end, includeTime);
            setMonth(startOfMonth(d));
          }}
          onTime={(h, mi) => emit(setMinutes(setHours(start ?? startOfDay(new Date()), h), mi), end, true)}
          onNatural={(r) => applyNatural(r, 'start')}
        />
        {hasEnd && (
          <DateField
            label="Date de fin"
            date={end}
            includeTime={includeTime}
            active={focus === 'end'}
            onFocus={() => setFocus('end')}
            onDate={(d) => {
              emit(start, withTimeOf(d, end, includeTime), includeTime);
              setMonth(startOfMonth(d));
            }}
            onTime={(h, mi) => emit(start, setMinutes(setHours(end ?? start ?? startOfDay(new Date()), h), mi), true)}
            onNatural={(r) => applyNatural(r, 'end')}
          />
        )}
      </div>

      <div className="ordb-cal-head">
        <span className="ordb-cal-title">{format(month, 'LLLL yyyy', { locale: fr })}</span>
        <button type="button" className="ordb-btn is-ghost is-sm" onClick={() => setMonth(startOfMonth(new Date()))}>
          Aujourd'hui
        </button>
        <IconBtn label="Mois précédent" onClick={() => setMonth((d) => addMonths(d, -1))}>
          <ChevronLeft size={15} />
        </IconBtn>
        <IconBtn label="Mois suivant" onClick={() => setMonth((d) => addMonths(d, 1))}>
          <ChevronRight size={15} />
        </IconBtn>
      </div>
      <div className="ordb-cal-grid" role="grid" aria-label="Calendrier">
        {WEEKDAYS.map((w) => (
          <span key={w} className="ordb-cal-weekday" role="columnheader">
            {w}
          </span>
        ))}
        {days.map((d) => {
          const isStart = !!start && isSameDay(d, start);
          const isEnd = !!end && isSameDay(d, end);
          return (
            <button
              type="button"
              key={d.getTime()}
              role="gridcell"
              aria-selected={isStart || isEnd}
              aria-label={format(d, 'EEEE d MMMM yyyy', { locale: fr })}
              className={cx(
                'ordb-cal-day',
                !isSameMonth(d, month) && 'is-outside',
                isSameDay(d, today) && 'is-today',
                (isStart || isEnd) && 'is-selected',
                inRange(d) && 'is-in-range',
              )}
              onClick={() => pick(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      <MenuDivider />
      <div className="ordb-panel-body">
        <Toggle
          label="Date de fin"
          checked={hasEnd}
          onChange={(on) => {
            const s = start ?? withTimeOf(new Date(), null, includeTime);
            emit(s, on ? (end ?? s) : null, includeTime, on);
            setFocus(on ? 'end' : 'start');
          }}
        />
        <Toggle
          label="Inclure l'heure"
          checked={includeTime}
          onChange={(on) => {
            const s = start ?? startOfDay(new Date());
            emit(on ? withTimeOf(s, null, true) : startOfDay(s), end ? (on ? withTimeOf(end, null, true) : startOfDay(end)) : null, on);
          }}
        />
      </div>
      <MenuDivider />
      <MenuItem icon={<Trash size={14} />} label="Effacer" onClick={() => onChange(null)} disabled={!value} />
    </div>
  );
}
