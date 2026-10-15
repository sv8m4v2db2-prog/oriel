// Editor of a PageFilter (rules of a collection, filters of « Toutes les pages »).
import { useQuery } from '@tanstack/react-query';
import { MultiSelect, NumberInput, Select, TextInput } from '@mantine/core';
import { Plus, X } from 'lucide-react';
import {
  MAX_CONDITIONS,
  type Member,
  type PageCondition,
  type PageFilter,
  type PageProp,
  type PagePropOp,
  type PageTypeFilter,
  type Tag,
} from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { pageTitle } from '../lib/util';
import { navApi, nk } from '../shell/nav/api';
import { KIND_LABELS } from './logic';

const TYPE_LABELS: Record<PageCondition['type'], string> = {
  tag: 'Tag',
  user: 'Personne',
  date: 'Date',
  prop: 'Propriété',
  space: 'Espace',
  kind: 'Type de page',
  title: 'Titre',
};

export { KIND_LABELS };

const OP_LABELS: Record<PagePropOp, string> = {
  eq: 'est égal à',
  neq: 'est différent de',
  contains: 'contient',
  gt: 'est supérieur à',
  lt: 'est inférieur à',
  empty: 'est vide',
  not_empty: 'n’est pas vide',
  checked: 'est coché',
  unchecked: 'n’est pas coché',
};

const OPS_BY_TYPE: Record<PageProp['type'], PagePropOp[]> = {
  text: ['contains', 'eq', 'neq', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'lt', 'empty', 'not_empty'],
  date: ['eq', 'gt', 'lt', 'empty', 'not_empty'],
  checkbox: ['checked', 'unchecked'],
  select: ['eq', 'neq', 'empty', 'not_empty'],
};

export function emptyFilter(): PageFilter {
  return { match: 'all', conditions: [] };
}

function fresh(type: PageCondition['type'], props: PageProp[]): PageCondition {
  switch (type) {
    case 'tag':
      return { type, op: 'any', tagIds: [] };
    case 'user':
      return { type, by: 'created', userIds: [] };
    case 'date':
      return { type, field: 'updated', lastDays: 7 };
    case 'prop':
      return { type, propId: props[0]?.id ?? '', op: props[0] ? OPS_BY_TYPE[props[0].type][0]! : 'not_empty' };
    case 'space':
      return { type, space: 'workspace' };
    case 'kind':
      return { type, kinds: ['page'] };
    case 'title':
      return { type, value: '' };
  }
}

export function FilterEditor({
  workspaceId,
  value,
  onChange,
  tags,
  props,
  allowMatch = true,
}: {
  workspaceId: string;
  value: PageFilter;
  onChange: (next: PageFilter) => void;
  tags: Tag[];
  props: PageProp[];
  allowMatch?: boolean;
}) {
  const members = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId), staleTime: 60_000 });
  const spaces = useQuery({ queryKey: nk.teamspaces(workspaceId), queryFn: () => navApi.teamspaces(workspaceId), staleTime: 60_000 });
  const set = (i: number, c: PageCondition) => onChange({ ...value, conditions: value.conditions.map((x, j) => (j === i ? c : x)) });
  const remove = (i: number) => onChange({ ...value, conditions: value.conditions.filter((_, j) => j !== i) });
  const spaceOptions = [
    { value: 'workspace', label: 'Partagé (visible de tous)' },
    { value: 'private', label: 'Privé' },
    ...(spaces.data?.teamspaces ?? []).map((t) => ({ value: t.id, label: `Espace d’équipe : ${pageTitle(t.title)}` })),
  ];

  return (
    <div className="org-filter">
      {allowMatch && value.conditions.length > 1 && (
        <div className="org-filter__match">
          Pages qui respectent{' '}
          <Select
            size="xs"
            w={150}
            allowDeselect={false}
            aria-label="Combinaison des règles"
            data={[
              { value: 'all', label: 'toutes les règles' },
              { value: 'any', label: 'au moins une règle' },
            ]}
            value={value.match}
            onChange={(v) => onChange({ ...value, match: v === 'any' ? 'any' : 'all' })}
          />
        </div>
      )}
      {value.conditions.map((c, i) => (
        <div className="org-filter__row" key={i}>
          <Select
            size="xs"
            w={130}
            allowDeselect={false}
            aria-label="Type de règle"
            data={(Object.keys(TYPE_LABELS) as PageCondition['type'][]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
            value={c.type}
            onChange={(t) => t && t !== c.type && set(i, fresh(t as PageCondition['type'], props))}
          />
          <div className="org-filter__body">
            <ConditionBody
              condition={c}
              onChange={(next) => set(i, next)}
              tags={tags}
              props={props}
              members={members.data ?? []}
              spaceOptions={spaceOptions}
            />
          </div>
          <button type="button" className="icon-btn" aria-label="Supprimer la règle" onClick={() => remove(i)}>
            <X size={15} />
          </button>
        </div>
      ))}
      {value.conditions.length < MAX_CONDITIONS && (
        <button
          type="button"
          className="org-filter__add"
          onClick={() => onChange({ ...value, conditions: [...value.conditions, fresh(value.conditions.length === 0 ? 'tag' : 'title', props)] })}
        >
          <Plus size={14} /> Ajouter une règle
        </button>
      )}
    </div>
  );
}

function ConditionBody({
  condition: c,
  onChange,
  tags,
  props,
  members,
  spaceOptions,
}: {
  condition: PageCondition;
  onChange: (c: PageCondition) => void;
  tags: Tag[];
  props: PageProp[];
  members: Member[];
  spaceOptions: Array<{ value: string; label: string }>;
}) {
  switch (c.type) {
    case 'tag':
      return (
        <>
          <Select
            size="xs"
            w={150}
            allowDeselect={false}
            aria-label="Opérateur"
            data={[
              { value: 'any', label: 'a l’un de' },
              { value: 'all', label: 'a tous les' },
              { value: 'none', label: 'n’a aucun des' },
            ]}
            value={c.op}
            onChange={(v) => onChange({ ...c, op: (v as 'any' | 'all' | 'none') ?? 'any' })}
          />
          <MultiSelect
            size="xs"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="Tags"
            aria-label="Tags"
            searchable
            data={tags.map((t) => ({ value: t.id, label: t.name }))}
            value={c.tagIds}
            onChange={(v) => onChange({ ...c, tagIds: v })}
          />
        </>
      );
    case 'user':
      return (
        <>
          <Select
            size="xs"
            w={170}
            allowDeselect={false}
            aria-label="Rôle"
            data={[
              { value: 'created', label: 'créée par' },
              { value: 'updated', label: 'modifiée en dernier par' },
            ]}
            value={c.by}
            onChange={(v) => onChange({ ...c, by: v === 'updated' ? 'updated' : 'created' })}
          />
          <MultiSelect
            size="xs"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="Personnes"
            aria-label="Personnes"
            searchable
            data={members.map((m) => ({ value: m.user.id, label: m.user.name }))}
            value={c.userIds}
            onChange={(v) => onChange({ ...c, userIds: v })}
          />
        </>
      );
    case 'date': {
      const mode = c.lastDays !== undefined ? 'last' : c.after !== undefined && c.before !== undefined ? 'between' : c.before !== undefined ? 'before' : 'after';
      const setMode = (m: string) => {
        const base = { type: 'date' as const, field: c.field };
        if (m === 'last') onChange({ ...base, lastDays: 7 });
        else if (m === 'after') onChange({ ...base, after: new Date().toISOString().slice(0, 10) });
        else if (m === 'before') onChange({ ...base, before: new Date().toISOString().slice(0, 10) });
        else onChange({ ...base, after: new Date().toISOString().slice(0, 10), before: new Date().toISOString().slice(0, 10) });
      };
      return (
        <>
          <Select
            size="xs"
            w={130}
            allowDeselect={false}
            aria-label="Date concernée"
            data={[
              { value: 'created', label: 'Création' },
              { value: 'updated', label: 'Modification' },
            ]}
            value={c.field}
            onChange={(v) => onChange({ ...c, field: v === 'created' ? 'created' : 'updated' })}
          />
          <Select
            size="xs"
            w={150}
            allowDeselect={false}
            aria-label="Période"
            data={[
              { value: 'last', label: 'les derniers jours' },
              { value: 'after', label: 'à partir du' },
              { value: 'before', label: 'jusqu’au' },
              { value: 'between', label: 'entre le' },
            ]}
            value={mode}
            onChange={(v) => v && setMode(v)}
          />
          {mode === 'last' && (
            <NumberInput size="xs" w={90} min={1} max={36500} aria-label="Nombre de jours" suffix=" j" value={c.lastDays ?? 7} onChange={(v) => onChange({ ...c, lastDays: Math.max(1, Number(v) || 1) })} />
          )}
          {(mode === 'after' || mode === 'between') && (
            <input type="date" className="org-date" aria-label="À partir du" value={c.after ?? ''} onChange={(e) => onChange({ ...c, after: e.target.value || undefined })} />
          )}
          {(mode === 'before' || mode === 'between') && (
            <input type="date" className="org-date" aria-label="Jusqu’au" value={c.before ?? ''} onChange={(e) => onChange({ ...c, before: e.target.value || undefined })} />
          )}
        </>
      );
    }
    case 'prop': {
      const def = props.find((p) => p.id === c.propId);
      const ops = def ? OPS_BY_TYPE[def.type] : [];
      const needsValue = !['empty', 'not_empty', 'checked', 'unchecked'].includes(c.op);
      return (
        <>
          <Select
            size="xs"
            w={150}
            allowDeselect={false}
            aria-label="Propriété"
            placeholder="Propriété"
            data={props.map((p) => ({ value: p.id, label: p.name }))}
            value={c.propId || null}
            onChange={(v) => {
              const next = props.find((p) => p.id === v);
              if (next) onChange({ type: 'prop', propId: next.id, op: OPS_BY_TYPE[next.type][0]! });
            }}
          />
          {def && (
            <Select
              size="xs"
              w={150}
              allowDeselect={false}
              aria-label="Opérateur"
              data={ops.map((o) => ({ value: o, label: OP_LABELS[o] }))}
              value={c.op}
              onChange={(v) => v && onChange({ ...c, op: v as PagePropOp })}
            />
          )}
          {def && needsValue && def.type === 'select' && (
            <Select
              size="xs"
              w={140}
              aria-label="Valeur"
              data={def.options.map((o) => ({ value: o.id, label: o.name }))}
              value={typeof c.value === 'string' ? c.value : null}
              onChange={(v) => onChange({ ...c, value: v })}
            />
          )}
          {def && needsValue && def.type === 'number' && (
            <NumberInput size="xs" w={120} aria-label="Valeur" value={typeof c.value === 'number' ? c.value : ''} onChange={(v) => onChange({ ...c, value: v === '' ? undefined : Number(v) })} />
          )}
          {def && needsValue && def.type === 'date' && (
            <input type="date" className="org-date" aria-label="Valeur" value={typeof c.value === 'string' ? c.value : ''} onChange={(e) => onChange({ ...c, value: e.target.value || undefined })} />
          )}
          {def && needsValue && def.type === 'text' && (
            <TextInput size="xs" style={{ flex: 1, minWidth: 120 }} aria-label="Valeur" maxLength={200} value={typeof c.value === 'string' ? c.value : ''} onChange={(e) => onChange({ ...c, value: e.currentTarget.value })} />
          )}
        </>
      );
    }
    case 'space':
      return <Select size="xs" style={{ flex: 1, minWidth: 180 }} allowDeselect={false} aria-label="Espace" data={spaceOptions} value={c.space} onChange={(v) => v && onChange({ ...c, space: v })} />;
    case 'kind':
      return (
        <MultiSelect
          size="xs"
          style={{ flex: 1, minWidth: 140 }}
          aria-label="Types"
          data={(Object.keys(KIND_LABELS) as PageTypeFilter[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))}
          value={c.kinds}
          onChange={(v) => onChange({ ...c, kinds: v as PageTypeFilter[] })}
        />
      );
    case 'title':
      return <TextInput size="xs" style={{ flex: 1, minWidth: 140 }} aria-label="Le titre contient" placeholder="Le titre contient…" maxLength={200} value={c.value} onChange={(e) => onChange({ ...c, value: e.currentTarget.value })} />;
  }
}
