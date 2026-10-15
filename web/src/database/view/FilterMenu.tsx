// Filter editor: rules combined with AND / OR, operators and value inputs depending on the kind.
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash, X } from 'lucide-react';
import type { FilterGroup, FilterOperator, FilterQuantifier, FilterRule, PropertyDef, RelativeDuration, RelativeRange } from '@oriel/shared';
import { shortId } from '@oriel/shared';
import { useDb } from '../context';
import { useRowsQuery, useTemplatesQuery } from '../data';
import { asDuration, DURATION_UNIT_LABELS, DURATION_UNITS, RELATIVE_DAY_LABELS, RELATIVE_DAYS, RELATIVE_RANGE_LABELS, RELATIVE_RANGES } from '../logic/dates';
import {
  defaultRule,
  isDurationOperator,
  isMultiValueRollup,
  ME_FILTER_VALUE,
  operatorLabel,
  operatorNeedsValue,
  operatorsForKind,
  rollupItemKind,
  rollupItemProp,
} from '../logic/filter';
import { orderedOptions, type ValueKind } from '../logic/values';
import { PropertyIcon } from '../ui/icons';
import { IconBtn, MenuDivider, MenuItem, MenuLabel, NativeSelect, Tag, type SelectChoice } from '../ui/primitives';
import type { ViewState } from './types';

/** Text input that reports its value after a short pause. */
function DebouncedInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  inputMode,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel: string;
  inputMode?: 'decimal' | 'text';
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <input
      className="ordb-input"
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      inputMode={inputMode}
      autoFocus={autoFocus}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => latest.current(v), 350);
      }}
      onBlur={() => {
        if (timer.current) clearTimeout(timer.current);
        if (draft !== value) latest.current(draft);
      }}
    />
  );
}

/** « N jours / semaines / mois » for the duration operators. */
function DurationInput({ value, onChange }: { value: unknown; onChange: (v: RelativeDuration | undefined) => void }) {
  const current = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<RelativeDuration>) : {};
  const unit = DURATION_UNITS.includes(current.unit as RelativeDuration['unit']) ? (current.unit as RelativeDuration['unit']) : 'day';
  const amount = current.amount === undefined ? '' : String(current.amount);
  const plural = Number(amount) !== 1;
  return (
    <span className="ordb-filter-date">
      <DebouncedInput
        ariaLabel="Nombre"
        placeholder="Nombre…"
        inputMode="decimal"
        value={amount}
        onChange={(v) => {
          const d = asDuration({ amount: v, unit });
          onChange(d ?? (v.trim() === '' ? undefined : ({ amount: v as unknown as number, unit } as RelativeDuration)));
        }}
      />
      <NativeSelect
        ariaLabel="Unité"
        value={unit}
        onChange={(u) => onChange({ amount: (current.amount ?? 1) as number, unit: u as RelativeDuration['unit'] })}
        choices={DURATION_UNITS.map((u) => ({ value: u, label: DURATION_UNIT_LABELS[u][plural ? 1 : 0] }))}
      />
    </span>
  );
}

/** Several values at once (any / all / none of them): chips and a picker for the next one. */
function MultiValueInput({
  value,
  onChange,
  choices,
  placeholder,
}: {
  value: unknown;
  onChange: (v: string[] | undefined) => void;
  choices: SelectChoice[];
  placeholder: string;
}) {
  const selected = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : typeof value === 'string' && value ? [value] : [];
  const label = (id: string) => choices.find((c) => c.value === id)?.label ?? id;
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  return (
    <span className="ordb-filter-multi">
      {selected.map((id) => (
        <Tag key={id} color="default" onRemove={() => set(selected.filter((x) => x !== id))}>
          {label(id)}
        </Tag>
      ))}
      <NativeSelect
        ariaLabel="Ajouter une valeur"
        value=""
        onChange={(v) => v && set([...selected, v])}
        choices={[{ value: '', label: selected.length ? 'Ajouter…' : placeholder }, ...choices.filter((c) => c.value && !selected.includes(c.value))]}
      />
    </span>
  );
}

function RelationMultiInput({ prop, value, onChange }: { prop: PropertyDef; value: unknown; onChange: (v: string[] | undefined) => void }) {
  const { publicMode, hostPageId, canEdit } = useDb();
  const target = prop.relation?.databaseId ?? '';
  const rows = useRowsQuery(target, publicMode, !!target).data?.rows ?? [];
  // I1: « Cette page » — the row or row template whose content shows this view. In a template, the
  // value follows the new row when the template is used.
  const templates = useTemplatesQuery(target, !!target && !!hostPageId && canEdit).data?.rows ?? [];
  const host = hostPageId ? (rows.find((r) => r.id === hostPageId) ?? templates.find((t) => t.id === hostPageId)) : undefined;
  const choices = rows.filter((r) => r.id !== host?.id).map((r) => ({ value: r.id, label: r.title || 'Sans titre' }));
  if (host) choices.unshift({ value: host.id, label: 'Cette page' });
  return <MultiValueInput value={value} onChange={onChange} placeholder="Choisir une page…" choices={choices} />;
}

function DateValueInput({ op, value, onChange }: { op: FilterOperator; value: unknown; onChange: (v: unknown) => void }) {
  if (isDurationOperator(op)) return <DurationInput value={value} onChange={onChange} />;
  if (op === 'within') {
    return (
      <NativeSelect
        ariaLabel="Période"
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(v || undefined)}
        choices={[
          { value: '', label: 'Choisir…' },
          ...RELATIVE_RANGES.map((r: RelativeRange) => ({ value: r, label: RELATIVE_RANGE_LABELS[r] })),
        ]}
      />
    );
  }
  const v = typeof value === 'string' ? value : '';
  const isRelative = (RELATIVE_DAYS as readonly string[]).includes(v);
  return (
    <span className="ordb-filter-date">
      <NativeSelect
        ariaLabel="Date de référence"
        value={isRelative ? v : 'exact'}
        onChange={(choice) => onChange(choice === 'exact' ? '' : choice)}
        choices={[
          ...RELATIVE_DAYS.map((d) => ({ value: d, label: RELATIVE_DAY_LABELS[d] })),
          { value: 'exact', label: 'Date précise' },
        ]}
      />
      {!isRelative && (
        <input
          type="date"
          className="ordb-input"
          aria-label="Date"
          value={v}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      )}
    </span>
  );
}

function ValueInput({
  prop,
  kind,
  rule,
  onChange,
}: {
  prop: PropertyDef;
  kind: ValueKind;
  rule: FilterRule;
  onChange: (v: unknown) => void;
}) {
  const { members, ctx } = useDb();
  if (!operatorNeedsValue(rule.operator)) return null;
  const str = typeof rule.value === 'string' || typeof rule.value === 'number' ? String(rule.value) : '';
  switch (kind) {
    case 'text':
    case 'files':
      return <DebouncedInput ariaLabel="Valeur" placeholder="Valeur…" value={str} onChange={(v) => onChange(v)} autoFocus />;
    case 'number':
      return <DebouncedInput ariaLabel="Nombre" placeholder="Nombre…" inputMode="decimal" value={str} onChange={(v) => onChange(v)} />;
    case 'select': {
      const choices: SelectChoice[] = [{ value: '', label: 'Choisir une option…' }, ...orderedOptions(prop).map((o) => ({ value: o.id, label: o.name || 'Sans nom' }))];
      const current = Array.isArray(rule.value) ? String(rule.value[0] ?? '') : str;
      return <NativeSelect ariaLabel="Option" value={current} onChange={(v) => onChange(v || undefined)} choices={choices} />;
    }
    case 'multi':
      return (
        <MultiValueInput
          value={rule.value}
          onChange={onChange}
          placeholder="Choisir une option…"
          choices={orderedOptions(prop).map((o) => ({ value: o.id, label: o.name || 'Sans nom' }))}
        />
      );
    case 'person': {
      const users = new Map(members.map((u) => [u.id, u]));
      for (const [id, u] of ctx.users) if (!users.has(id)) users.set(id, u);
      return (
        <MultiValueInput
          value={rule.value}
          onChange={onChange}
          placeholder="Choisir une personne…"
          choices={[{ value: ME_FILTER_VALUE, label: 'Moi' }, ...[...users.values()].map((u) => ({ value: u.id, label: u.name }))]}
        />
      );
    }
    case 'relation':
      return <RelationMultiInput prop={prop} value={rule.value} onChange={onChange} />;
    case 'date':
      return <DateValueInput op={rule.operator} value={rule.value} onChange={onChange} />;
    case 'checkbox':
      return null;
  }
}

interface RuleListProps {
  rules: FilterRule[];
  conjunction: 'and' | 'or';
  onChange: (next: { rules: FilterRule[]; conjunction: 'and' | 'or' }) => void;
  kindOf: (p: PropertyDef) => ValueKind;
}

/** Rows of rules sharing one conjunction (top level or a nested group). */
function RuleList({ rules, conjunction, onChange, kindOf }: RuleListProps) {
  const { properties, ctx } = useDb();
  const shown = rules.filter((r) => properties.some((p) => p.id === r.propertyId));
  const updateRule = (id: string, patch: Partial<FilterRule>) =>
    onChange({ conjunction, rules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  return (
    <div className="ordb-filter-rules">
      {shown.map((rule, i) => {
        const ownProp = properties.find((p) => p.id === rule.propertyId)!;
        const multiRollup = isMultiValueRollup(ownProp);
        // With a quantifier on a « show original » rollup, the rule bears on each related value:
        // operators and value input are those of the listed property.
        const itemProp = multiRollup && rule.quantifier ? rollupItemProp(ownProp, ctx) : null;
        const itemKind = multiRollup && rule.quantifier ? rollupItemKind(ownProp, ctx) : null;
        const prop = itemProp ?? ownProp;
        const kind = itemKind ?? kindOf(ownProp);
        return (
          <div className="ordb-filter-rule" key={rule.id}>
            <span className="ordb-filter-conj">
              {i === 0 ? (
                'Où'
              ) : i === 1 ? (
                <NativeSelect
                  ariaLabel="Combinaison des filtres"
                  value={conjunction}
                  onChange={(v) => onChange({ rules, conjunction: v as 'and' | 'or' })}
                  choices={[
                    { value: 'and', label: 'Et' },
                    { value: 'or', label: 'Ou' },
                  ]}
                />
              ) : conjunction === 'and' ? (
                'Et'
              ) : (
                'Ou'
              )}
            </span>
            <NativeSelect
              ariaLabel="Propriété"
              value={ownProp.id}
              onChange={(id) => {
                const p = properties.find((x) => x.id === id);
                if (!p) return;
                const fresh = defaultRule(rule.id, p, kindOf(p));
                updateRule(rule.id, { propertyId: id, operator: fresh.operator, value: undefined, quantifier: undefined });
              }}
              choices={properties.map((p) => ({ value: p.id, label: p.name }))}
            />
            <NativeSelect
              ariaLabel="Opérateur"
              value={rule.operator}
              onChange={(op) => {
                const shape = (o: string) => (o === 'within' ? 'range' : isDurationOperator(o as FilterOperator) ? 'duration' : 'other');
                updateRule(rule.id, {
                  operator: op as FilterOperator,
                  value: shape(op) !== shape(rule.operator) ? undefined : rule.value,
                });
              }}
              choices={operatorsForKind(kind).map((op) => ({ value: op, label: operatorLabel(op, kind) }))}
            />
            {multiRollup && (
              <NativeSelect
                ariaLabel="Valeurs concernées"
                value={rule.quantifier ?? ''}
                onChange={(q) => {
                  const quantifier = (q || undefined) as FilterQuantifier | undefined;
                  const k = quantifier ? rollupItemKind(ownProp, ctx) : kindOf(ownProp);
                  const fresh = defaultRule(rule.id, ownProp, k ?? 'text');
                  updateRule(rule.id, { quantifier, operator: fresh.operator, value: undefined });
                }}
                choices={[
                  { value: '', label: 'Texte des valeurs' },
                  { value: 'any', label: 'Au moins une valeur' },
                  { value: 'every', label: 'Toutes les valeurs' },
                  { value: 'none', label: 'Aucune valeur' },
                ]}
              />
            )}
            <span className="ordb-filter-value">
              <ValueInput prop={prop} kind={kind} rule={rule} onChange={(value) => updateRule(rule.id, { value })} />
            </span>
            <IconBtn label="Supprimer le filtre" onClick={() => onChange({ conjunction, rules: rules.filter((r) => r.id !== rule.id) })}>
              <X size={14} />
            </IconBtn>
          </div>
        );
      })}
    </div>
  );
}

/** Property list used to add a rule. */
function AddRuleList({ onPick }: { onPick: (p: PropertyDef) => void }) {
  const { properties } = useDb();
  return (
    <>
      <MenuLabel>Filtrer par</MenuLabel>
      <div className="ordb-options-list">
        {properties.map((p) => (
          <MenuItem key={p.id} icon={<PropertyIcon type={p.type} />} label={p.name} onClick={() => onPick(p)} />
        ))}
      </div>
    </>
  );
}

export function FilterMenu({ vs }: { vs: ViewState }) {
  const { properties } = useDb();
  const { config, setConfig, kinds } = vs;
  const filter: FilterGroup = config.filter ?? { conjunction: 'and', rules: [] };
  const groups = filter.groups ?? [];
  const rules = filter.rules.filter((r) => properties.some((p) => p.id === r.propertyId));
  const [addClicked, setAdding] = useState(false);
  /** Group receiving the next rule (index), or null for the top level. */
  const [addingTo, setAddingTo] = useState<number | null>(null);
  const adding = addClicked || (rules.length === 0 && groups.length === 0);

  const save = (next: FilterGroup) => {
    const kept = (next.groups ?? []).filter((g) => g.rules.length > 0);
    const clean: FilterGroup = { conjunction: next.conjunction, rules: next.rules };
    if (kept.length) clean.groups = kept;
    setConfig({ filter: clean.rules.length || kept.length ? clean : null });
  };
  const kindOf = (p: PropertyDef): ValueKind => kinds.get(p.id) ?? 'text';

  const addRule = (p: PropertyDef) => {
    setAdding(false);
    save({ ...filter, rules: [...filter.rules, defaultRule(shortId(8), p, kindOf(p))] });
  };
  const addGroupRule = (index: number, p: PropertyDef) => {
    setAddingTo(null);
    save({ ...filter, groups: groups.map((g, i) => (i === index ? { ...g, rules: [...g.rules, defaultRule(shortId(8), p, kindOf(p))] } : g)) });
  };
  const addGroup = () => {
    const first = properties[0];
    if (!first) return;
    save({ ...filter, groups: [...groups, { conjunction: 'or', rules: [defaultRule(shortId(8), first, kindOf(first))] }] });
  };

  return (
    <div className="ordb-filter-menu">
      {rules.length > 0 && (
        <RuleList rules={filter.rules} conjunction={filter.conjunction} kindOf={kindOf} onChange={(next) => save({ ...filter, ...next })} />
      )}
      {groups.map((g, gi) => (
        <div key={gi} className="ordb-filter-group">
          <div className="ordb-filter-group-head">
            <span className="ordb-filter-conj">
              {rules.length + gi === 0 ? (
                'Où'
              ) : rules.length + gi === 1 ? (
                <NativeSelect
                  ariaLabel="Combinaison des filtres"
                  value={filter.conjunction}
                  onChange={(v) => save({ ...filter, conjunction: v as 'and' | 'or' })}
                  choices={[
                    { value: 'and', label: 'Et' },
                    { value: 'or', label: 'Ou' },
                  ]}
                />
              ) : filter.conjunction === 'and' ? (
                'Et'
              ) : (
                'Ou'
              )}
            </span>
            <span className="ordb-muted ordb-small">Groupe de filtres</span>
            <span className="ordb-option-spacer" />
            <IconBtn label="Supprimer le groupe" onClick={() => save({ ...filter, groups: groups.filter((_, i) => i !== gi) })}>
              <Trash size={13} />
            </IconBtn>
          </div>
          <RuleList
            rules={g.rules}
            conjunction={g.conjunction}
            kindOf={kindOf}
            onChange={(next) => save({ ...filter, groups: groups.map((x, i) => (i === gi ? { ...x, ...next } : x)) })}
          />
          {addingTo === gi ? (
            <AddRuleList onPick={(p) => addGroupRule(gi, p)} />
          ) : (
            <MenuItem icon={<Plus size={14} />} label="Ajouter un filtre au groupe" onClick={() => setAddingTo(gi)} />
          )}
        </div>
      ))}
      {adding ? (
        <>
          {(rules.length > 0 || groups.length > 0) && <MenuDivider />}
          <AddRuleList onPick={addRule} />
        </>
      ) : (
        <>
          <MenuDivider />
          <MenuItem icon={<Plus size={14} />} label="Ajouter un filtre" onClick={() => setAdding(true)} />
          <MenuItem icon={<Plus size={14} />} label="Ajouter un groupe de filtres" onClick={addGroup} />
          {(rules.length > 0 || groups.length > 0) && (
            <MenuItem icon={<Trash size={14} />} label="Supprimer tous les filtres" danger onClick={() => save({ conjunction: 'and', rules: [] })} />
          )}
        </>
      )}
    </div>
  );
}
