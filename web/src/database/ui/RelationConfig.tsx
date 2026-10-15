// Relation (two-way, single page) and rollup configuration panels, used when creating a property
// and from the property menu.
import { useMemo, useState } from 'react';
import { ArrowLeftRight, Database } from 'lucide-react';
import type { PropertyDef, RollupConfig, RollupFunction } from '@oriel/shared';
import { useDb } from '../context';
import { useDatabaseQuery } from '../data';
import { ROLLUP_FUNCTION_LABELS, rollupFunctionsForKind } from '../logic/rollup';
import { createRowContext, propertyKind } from '../logic/values';
import { Btn, MenuLabel, NativeSelect, Toggle } from './primitives';

/** Title / schema of a related database (cached database query). */
export function useTargetDatabase(databaseId: string | undefined) {
  const { publicMode, databaseId: selfId, page } = useDb();
  const q = useDatabaseQuery(databaseId ?? '', publicMode, !!databaseId);
  const isSelf = databaseId === selfId;
  return {
    title: (isSelf ? page?.title : q.data?.page.title) || 'Sans titre',
    icon: isSelf ? (page?.icon ?? null) : (q.data?.page.icon ?? null),
    properties: q.data?.schema.properties,
    isSelf,
    loading: q.isLoading,
  };
}

function DbName({ title, icon }: { title: string; icon: string | null }) {
  return (
    <span className="ordb-relation-db">
      {icon ? <span className="ordb-emoji">{icon}</span> : <Database size={13} />}
      <span className="ordb-ellipsis">{title}</span>
    </span>
  );
}

/** Relations of the target database pointing back to this one, usable as the reciprocal property. */
function pairCandidates(targetProps: PropertyDef[] | undefined, selfId: string, exclude?: string): PropertyDef[] {
  return (targetProps ?? []).filter(
    (p) => p.type === 'relation' && p.relation?.databaseId === selfId && !p.relation.syncedPropertyId && p.id !== exclude,
  );
}

/** Reciprocal property of a two-way relation: a new property (named) or an existing relation back. */
function MirrorChoice({
  targetTitle,
  candidates,
  pairWith,
  onPairWith,
  name,
  onName,
  placeholder,
  inputId,
}: {
  targetTitle: string;
  candidates: PropertyDef[];
  pairWith: string;
  onPairWith: (id: string) => void;
  name: string;
  onName: (name: string) => void;
  placeholder: string;
  inputId: string;
}) {
  return (
    <>
      {candidates.length > 0 && (
        <>
          <MenuLabel>Propriété réciproque dans « {targetTitle} »</MenuLabel>
          <NativeSelect
            ariaLabel="Propriété réciproque"
            value={pairWith}
            onChange={onPairWith}
            choices={[{ value: '', label: 'Nouvelle propriété' }, ...candidates.map((c) => ({ value: c.id, label: `${c.name} (existante)` }))]}
          />
        </>
      )}
      {pairWith ? (
        <div className="ordb-menu-hint is-tight">
          Les liens des deux propriétés sont fusionnés, puis elles restent synchronisées.
        </div>
      ) : (
        <>
          <label className="ordb-field-label" htmlFor={inputId}>
            Nom de la propriété dans « {targetTitle} »
          </label>
          <input id={inputId} className="ordb-input" value={name} placeholder={placeholder} onChange={(e) => onName(e.target.value)} />
        </>
      )}
    </>
  );
}

/** Options of a new relation (after choosing the target database). */
export function RelationSetup({
  targetId,
  name,
  onChangeTarget,
  onCreate,
}: {
  targetId: string;
  name: string;
  onChangeTarget: () => void;
  onCreate: (opts: { twoWay: boolean; mirrorName: string; singlePage: boolean; pairWith?: string }) => void;
}) {
  const { page, databaseId: selfId } = useDb();
  const target = useTargetDatabase(targetId);
  const defaultMirror = target.isSelf ? `${name.trim() || 'Relation'} (réciproque)` : page?.title || 'Sans titre';
  const [twoWay, setTwoWay] = useState(false);
  const [mirrorName, setMirrorName] = useState('');
  const [singlePage, setSinglePage] = useState(false);
  const [pairWith, setPairWith] = useState('');
  const candidates = pairCandidates(target.properties, selfId);
  return (
    <div className="ordb-panel-body ordb-relation-setup">
      <div className="ordb-field-row">
        <span>Base liée</span>
        <button type="button" className="ordb-linkbtn" onClick={onChangeTarget} title="Changer de base">
          <DbName title={target.title} icon={target.icon} />
        </button>
      </div>
      <Toggle label="Limiter à une page" checked={singlePage} onChange={setSinglePage} />
      <Toggle
        label={
          <span className="ordb-toggle-with-icon">
            <ArrowLeftRight size={13} /> Bidirectionnelle
          </span>
        }
        checked={twoWay}
        onChange={setTwoWay}
      />
      {twoWay && (
        <>
          <MirrorChoice
            targetTitle={target.title}
            candidates={candidates}
            pairWith={pairWith}
            onPairWith={setPairWith}
            name={mirrorName}
            onName={setMirrorName}
            placeholder={defaultMirror}
            inputId="ordb-mirror-name"
          />
          <div className="ordb-menu-hint is-tight">
            Les deux propriétés restent synchronisées : lier une page ici la lie aussi dans l'autre base.
          </div>
        </>
      )}
      <Btn
        variant="primary"
        size="sm"
        className="ordb-full"
        onClick={() => onCreate({ twoWay, mirrorName: mirrorName.trim() || defaultMirror, singlePage, pairWith: pairWith || undefined })}
      >
        Ajouter la relation
      </Btn>
    </div>
  );
}

/** Rollup configuration: relation, target property, aggregation. */
export function RollupSetup({
  value,
  onChange,
  submitLabel,
  onSubmit,
}: {
  value: Partial<RollupConfig>;
  onChange: (next: RollupConfig) => void;
  submitLabel?: string;
  onSubmit?: (cfg: RollupConfig) => void;
}) {
  const { properties, ctx } = useDb();
  const relations = properties.filter((p) => p.type === 'relation' && p.relation);
  const relationId = value.relationPropertyId && relations.some((r) => r.id === value.relationPropertyId) ? value.relationPropertyId : (relations[0]?.id ?? '');
  const rel = relations.find((r) => r.id === relationId);
  const target = useTargetDatabase(rel?.relation?.databaseId);
  const targetProps = target.properties ?? [];
  const targetId = value.targetPropertyId && targetProps.some((p) => p.id === value.targetPropertyId) ? value.targetPropertyId : 'title';
  const targetProp = targetProps.find((p) => p.id === targetId);
  const tctx = useMemo(
    () => (target.properties ? createRowContext(target.properties, { users: ctx.users.values() }) : undefined),
    [target.properties, ctx.users],
  );
  const functions = targetProp ? rollupFunctionsForKind(targetProp.type === 'rollup' ? 'text' : propertyKind(targetProp, [], tctx)) : (['show_original'] as RollupFunction[]);
  const fn = value.function && functions.includes(value.function) ? value.function : 'show_original';
  const current: RollupConfig = { relationPropertyId: relationId, targetPropertyId: targetId, function: fn };
  const set = (patch: Partial<RollupConfig>) => {
    const next = { ...current, ...patch };
    if (patch.relationPropertyId && patch.relationPropertyId !== current.relationPropertyId) next.targetPropertyId = 'title';
    onChange(next);
  };

  if (relations.length === 0) {
    return (
      <div className="ordb-panel-body">
        <div className="ordb-menu-hint">Un rollup agrège les pages liées : ajoutez d'abord une propriété Relation à cette base.</div>
      </div>
    );
  }
  return (
    <div className="ordb-panel-body ordb-rollup-setup">
      <MenuLabel>Relation</MenuLabel>
      <NativeSelect
        ariaLabel="Relation"
        value={relationId}
        onChange={(v) => set({ relationPropertyId: v })}
        choices={relations.map((r) => ({ value: r.id, label: r.name }))}
      />
      <MenuLabel>Propriété de « {target.title} »</MenuLabel>
      <NativeSelect
        ariaLabel="Propriété agrégée"
        value={targetId}
        disabled={target.loading}
        onChange={(v) => set({ targetPropertyId: v })}
        choices={(targetProps.length ? targetProps : [{ id: 'title', name: 'Titre' } as PropertyDef]).map((p) => ({ value: p.id, label: p.name }))}
      />
      <MenuLabel>Calcul</MenuLabel>
      <NativeSelect
        ariaLabel="Calcul"
        value={fn}
        onChange={(v) => set({ function: v as RollupFunction })}
        choices={functions.map((f) => ({ value: f, label: ROLLUP_FUNCTION_LABELS[f] }))}
      />
      {onSubmit && (
        <Btn variant="primary" size="sm" className="ordb-full" onClick={() => onSubmit(current)}>
          {submitLabel ?? 'Valider'}
        </Btn>
      )}
    </div>
  );
}

/** Settings of an existing relation (property menu). */
/** Row page display of a relation (D31), as one choice of the select below. */
const ROW_PAGE_DISPLAY_CHOICES = [
  { value: 'property', label: 'Dans les propriétés' },
  { value: 'section:list', label: 'Section : liste' },
  { value: 'section:table', label: 'Section : tableau' },
  { value: 'hidden', label: 'Masquée' },
];

function rowPageDisplayKey(prop: PropertyDef): string {
  const display = prop.relation?.rowPageDisplay ?? 'property';
  return display === 'section' ? `section:${prop.relation?.sectionLayout ?? 'list'}` : display;
}

export function RelationSettings({
  prop,
  onChangeTarget,
  onAskTwoWayOff,
}: {
  prop: PropertyDef;
  onChangeTarget: () => void;
  onAskTwoWayOff: () => void;
}) {
  const { m, page, databaseId: selfId } = useDb();
  const targetId = prop.relation?.databaseId;
  const target = useTargetDatabase(targetId);
  const [pairWith, setPairWith] = useState('');
  const candidates = pairCandidates(target.properties, selfId, prop.id);
  const mirror = prop.relation?.syncedPropertyId ? target.properties?.find((p) => p.id === prop.relation!.syncedPropertyId) : undefined;
  const [naming, setNaming] = useState(false);
  const [mirrorName, setMirrorName] = useState('');
  const twoWay = !!prop.relation?.syncedPropertyId;
  const defaultMirror = target.isSelf ? `${prop.name} (réciproque)` : page?.title || 'Sans titre';
  if (!targetId) return null;
  return (
    <div className="ordb-panel-body ordb-relation-setup">
      <div className="ordb-field-row">
        <span>Base liée</span>
        <button type="button" className="ordb-linkbtn" onClick={onChangeTarget} title="Changer de base">
          <DbName title={target.title} icon={target.icon} />
        </button>
      </div>
      <Toggle
        label="Limiter à une page"
        checked={!!prop.relation?.singlePage}
        onChange={(singlePage) => void m.updateProperty(prop.id, { relation: { databaseId: targetId, singlePage } })}
      />
      <div className="ordb-field-row">
        <span>Dans la page de ligne</span>
        <NativeSelect
          ariaLabel="Affichage dans la page de ligne"
          value={rowPageDisplayKey(prop)}
          choices={ROW_PAGE_DISPLAY_CHOICES}
          onChange={(key) => {
            // D31: where the row page shows this relation (kept in the property).
            const [rowPageDisplay, sectionLayout] = key.split(':') as ['property' | 'section' | 'hidden', ('list' | 'table')?];
            void m.updateProperty(prop.id, { relation: { databaseId: targetId, rowPageDisplay, sectionLayout: sectionLayout ?? 'list' } });
          }}
        />
      </div>
      <Toggle
        label={
          <span className="ordb-toggle-with-icon">
            <ArrowLeftRight size={13} /> Bidirectionnelle
          </span>
        }
        checked={twoWay || naming}
        onChange={(on) => {
          if (on) setNaming(true);
          else if (naming) setNaming(false);
          else onAskTwoWayOff();
        }}
      />
      {twoWay && (
        <div className="ordb-menu-hint is-tight">
          Synchronisée avec « {mirror?.name ?? '…'} » dans « {target.title} ».
        </div>
      )}
      {naming && !twoWay && (
        <>
          <MirrorChoice
            targetTitle={target.title}
            candidates={candidates}
            pairWith={pairWith}
            onPairWith={setPairWith}
            name={mirrorName}
            onName={setMirrorName}
            placeholder={defaultMirror}
            inputId="ordb-mirror-name-edit"
          />
          <Btn
            variant="primary"
            size="sm"
            className="ordb-full"
            onClick={() => {
              setNaming(false);
              void m.updateProperty(prop.id, {
                twoWay: pairWith ? { pairWith } : { name: mirrorName.trim() || defaultMirror },
              });
            }}
          >
            Rendre bidirectionnelle
          </Btn>
        </>
      )}
    </div>
  );
}
