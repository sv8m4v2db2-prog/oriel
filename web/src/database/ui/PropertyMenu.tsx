// Property menu (column header / row panel): rename, change type, type options, view actions,
// insert, duplicate, delete. Plus the "add a property" panel shared by several entry points.
import { useState, type ReactElement, type ReactNode } from 'react';
import { DbPopover as Popover } from './DbPopover';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Check,
  Copy,
  Database,
  EyeOff,
  ListFilter,
  Lock,
  Sigma,
  Trash,
  TriangleAlert,
} from 'lucide-react';
import type { NumberFormat, Page, PropertyDef, PropertyType, RollupConfig, ViewConfig } from '@oriel/shared';
import { PROPERTY_TYPE_LABELS } from '@oriel/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/queryKeys';
import { useDb } from '../context';
import { NUMBER_FORMAT_LABELS } from '../logic/format';
import { DateReminderSettings, NumberDisplaySettings } from './PropertyDisplaySettings';
import { conversionMayLoseData, conversionPatch, CREATABLE_TYPES, newPropertyDef, OPTION_TYPES, uniquePropertyName } from '../logic/properties';
import { FormulaEditor } from './FormulaEditor';
import { compileFormula } from '../logic/formula';
import { RelationSettings, RelationSetup, RollupSetup, useTargetDatabase } from './RelationConfig';
import { PropertyIcon } from './icons';
import { canManageRole, useWorkspaces } from '../../lib/session';
import { accessSummary, PropertyAccessPanel } from '../row/PropertyAccessPanel';
import { OptionsEditor } from './editors/OptionsEditor';
import { CommitInput, MenuDivider, MenuItem, MenuLabel, PanelHeader, stopEscape, Toggle } from './primitives';

// ---------------------------------------------------------------------------
// Database picker (relation target)
// ---------------------------------------------------------------------------

function DatabasePicker({ onPick, current }: { onPick: (databaseId: string) => void; current?: string }) {
  const { workspaceId, databaseId, page } = useDb();
  const tree = useQuery({
    queryKey: qk.tree(workspaceId),
    queryFn: () => api.workspaces.tree(workspaceId),
    enabled: !!workspaceId,
  });
  const [query, setQuery] = useState('');
  const dbs = (tree.data?.nodes ?? [])
    .filter((n) => n.kind === 'database')
    .map((n) => ({ id: n.id, title: n.title, icon: n.icon }));
  if (!dbs.some((n) => n.id === databaseId)) dbs.unshift({ id: databaseId, title: page?.title ?? '', icon: page?.icon ?? null });
  const q = query.trim().toLocaleLowerCase('fr');
  const list = dbs.filter((n) => !q || (n.title || 'Sans titre').toLocaleLowerCase('fr').includes(q));
  return (
    <div className="ordb-panel-body">
      <input
        className="ordb-input"
        placeholder="Rechercher une base…"
        aria-label="Rechercher une base de données"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="ordb-options-list">
        {tree.isLoading && <div className="ordb-menu-empty">Chargement…</div>}
        {list.map((n) => (
          <MenuItem
            key={n.id}
            icon={n.icon ? <span className="ordb-emoji">{n.icon}</span> : <Database size={14} />}
            label={
              <>
                {n.title || 'Sans titre'}
                {n.id === databaseId && <span className="ordb-muted"> (cette base)</span>}
              </>
            }
            right={current === n.id ? <Check size={14} /> : undefined}
            onClick={() => onPick(n.id)}
          />
        ))}
        {!tree.isLoading && list.length === 0 && <div className="ordb-menu-empty">Aucune base trouvée</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add property
// ---------------------------------------------------------------------------

export function AddPropertyPanel({
  after,
  onCreated,
}: {
  /** Schema position hint (undefined = last). */
  after?: string | null;
  onCreated: (id: string, prop: PropertyDef) => void;
}) {
  const { properties, m } = useDb();
  const [name, setName] = useState('');
  const [relation, setRelation] = useState(false);
  const [relationTarget, setRelationTarget] = useState<string | null>(null);
  const [rollup, setRollup] = useState<RollupConfig | null>(null);

  const create = (type: PropertyType, extra: Partial<Omit<PropertyDef, 'id'>> = {}, twoWay?: { name?: string; pairWith?: string }) => {
    const def = { ...newPropertyDef(type, properties, { name }), ...extra };
    const { id } = m.createProperty(def, after, { twoWay });
    onCreated(id, { ...def, id });
  };

  if (relationTarget) {
    return (
      <>
        <PanelHeader title="Nouvelle relation" onBack={() => setRelationTarget(null)} />
        <RelationSetup
          targetId={relationTarget}
          name={name}
          onChangeTarget={() => setRelationTarget(null)}
          onCreate={(o) =>
            create(
              'relation',
              { relation: { databaseId: relationTarget, ...(o.singlePage ? { singlePage: true } : {}) } },
              o.twoWay ? (o.pairWith ? { pairWith: o.pairWith } : { name: o.mirrorName }) : undefined,
            )
          }
        />
      </>
    );
  }
  if (relation) {
    return (
      <>
        <PanelHeader title="Base liée" onBack={() => setRelation(false)} />
        <DatabasePicker onPick={(dbId) => setRelationTarget(dbId)} />
      </>
    );
  }
  if (rollup) {
    return (
      <>
        <PanelHeader title="Nouveau rollup" onBack={() => setRollup(null)} />
        <RollupSetup value={rollup} onChange={setRollup} submitLabel="Ajouter le rollup" onSubmit={(cfg) => create('rollup', { rollup: cfg })} />
      </>
    );
  }
  return (
    <>
      <div className="ordb-panel-body">
        <input
          className="ordb-input"
          placeholder="Nom de la propriété"
          aria-label="Nom de la nouvelle propriété"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create('text');
          }}
        />
      </div>
      <MenuLabel>Type</MenuLabel>
      <div className="ordb-type-list">
        {CREATABLE_TYPES.map((t) => (
          <MenuItem
            key={t}
            icon={<PropertyIcon type={t} />}
            label={PROPERTY_TYPE_LABELS[t]}
            chevron={t === 'relation' || t === 'rollup'}
            onClick={() =>
              t === 'relation'
                ? setRelation(true)
                : t === 'rollup'
                  ? setRollup(newPropertyDef('rollup', properties).rollup!)
                  : create(t)
            }
          />
        ))}
      </div>
    </>
  );
}

/** Popover wrapper around AddPropertyPanel. */
export function AddPropertyPopover({
  children,
  after,
  onCreated,
  position = 'bottom-start',
}: {
  children: ReactElement;
  after?: string | null;
  onCreated?: (id: string, prop: PropertyDef) => void;
  position?: 'bottom-start' | 'bottom-end' | 'left-start';
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover opened={opened} onChange={setOpened} position={position} width={260} shadow="md">
      <Popover.Target>
        <span className="ordb-popover-target" onClick={() => setOpened((o) => !o)}>
          {children}
        </span>
      </Popover.Target>
      <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
        {opened && (
          <AddPropertyPanel
            after={after}
            onCreated={(id, prop) => {
              setOpened(false);
              onCreated?.(id, prop);
            }}
          />
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Property menu
// ---------------------------------------------------------------------------

export interface PropertyMenuViewActions {
  config: ViewConfig;
  setConfig: (patch: Partial<ViewConfig>) => void;
  onFilter?: (propertyId: string) => void;
  /** Table: insert a new property next to this column. */
  onInsert?: (side: 'left' | 'right') => void;
  /** Table: duplicate also places the copy next to the column. */
  onDuplicated?: (newId: string) => void;
}

type Panel = 'main' | 'type' | 'options' | 'number' | 'relation' | 'delete' | 'rollup' | 'twoWayOff' | 'access' | { confirmType: PropertyType };

export function PropertyMenu({
  prop,
  children,
  opened,
  onOpenedChange,
  view,
  sampleRow,
  initialPanel,
}: {
  prop: PropertyDef;
  children: ReactElement;
  opened: boolean;
  onOpenedChange: (opened: boolean) => void;
  view?: PropertyMenuViewActions;
  sampleRow?: Page;
  /** Panel shown when the menu opens (e.g. 'delete' from the context menu). */
  initialPanel?: 'main' | 'delete';
}) {
  const [formulaOpen, setFormulaOpen] = useState(false);
  return (
    <>
      <Popover
        opened={opened}
        onChange={onOpenedChange}
        position="bottom-start"
        width={270}
        shadow="md"
        offset={2}
      >
        <Popover.Target>{children}</Popover.Target>
        <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
          {opened && (
            <PropertyMenuBody
              prop={prop}
              view={view}
              initialPanel={initialPanel}
              close={() => onOpenedChange(false)}
              openFormula={() => {
                onOpenedChange(false);
                setFormulaOpen(true);
              }}
            />
          )}
        </Popover.Dropdown>
      </Popover>
      {prop.type === 'formula' && (
        <FormulaEditor opened={formulaOpen} prop={prop} sampleRow={sampleRow} onClose={() => setFormulaOpen(false)} />
      )}
    </>
  );
}

function PropertyMenuBody({
  prop,
  view,
  close,
  openFormula,
  initialPanel,
}: {
  prop: PropertyDef;
  view?: PropertyMenuViewActions;
  close: () => void;
  openFormula: () => void;
  initialPanel?: 'main' | 'delete';
}) {
  const { m, canEdit: canEditDatabase, properties, workspaceId } = useDb();
  // Per-property permissions (D30): the server marks the properties this person cannot edit.
  const canEdit = canEditDatabase && !prop.readOnly;
  const canManage = canManageRole(useWorkspaces().data?.find((w) => w.id === workspaceId)?.role);
  // Formulas of this database citing the property by name (D33): updated on rename, warned on delete.
  const citedBy = properties.filter((p) => p.type === 'formula' && p.id !== prop.id && compileFormula(p.formula ?? '').references.includes(prop.name));
  const citedNames = citedBy.map((p) => `« ${p.name} »`).join(', ');
  const [panel, setPanel] = useState<Panel>(initialPanel ?? 'main');
  const [deleteMirror, setDeleteMirror] = useState(true);
  const [rollupDraft, setRollupDraft] = useState<RollupConfig | null>(null);
  const isTitle = prop.type === 'title';
  const back = () => setPanel('main');
  const twoWay = prop.type === 'relation' && !!prop.relation?.syncedPropertyId;
  const target = useTargetDatabase(twoWay ? prop.relation?.databaseId : undefined);
  const mirrorName = twoWay ? (target.properties?.find((p) => p.id === prop.relation?.syncedPropertyId)?.name ?? 'la propriété liée') : '';

  const changeType = (type: PropertyType) => {
    if (type === prop.type) return back();
    if (type === 'relation') return setPanel('relation');
    if (type === 'rollup') {
      setRollupDraft(newPropertyDef('rollup', properties).rollup!);
      return setPanel('rollup');
    }
    if (conversionMayLoseData(prop.type, type)) return setPanel({ confirmType: type });
    void m.updateProperty(prop.id, conversionPatch(prop, type));
    back();
  };

  if (typeof panel === 'object') {
    const type = panel.confirmType;
    return (
      <>
        <PanelHeader title="Changer le type" onBack={back} />
        <div className="ordb-panel-body ordb-warning">
          <TriangleAlert size={16} />
          <span>
            Convertir « {prop.name} » en <strong>{PROPERTY_TYPE_LABELS[type]}</strong> ? Les valeurs existantes seront
            converties au mieux ; celles qui ne peuvent pas l'être seront effacées.
          </span>
        </div>
        <div className="ordb-confirm-actions ordb-panel-body">
          <button type="button" className="ordb-btn is-outline is-sm" onClick={back}>
            Annuler
          </button>
          <button
            type="button"
            className="ordb-btn is-primary is-sm"
            onClick={() => {
              void m.updateProperty(prop.id, conversionPatch(prop, type));
              back();
            }}
          >
            Convertir
          </button>
        </div>
      </>
    );
  }

  switch (panel) {
    case 'access':
      return <PropertyAccessPanel prop={prop} onBack={back} />;
    case 'type':
      return (
        <>
          <PanelHeader title="Type de propriété" onBack={back} />
          <div className="ordb-type-list">
            {CREATABLE_TYPES.map((t) => (
              <MenuItem
                key={t}
                icon={<PropertyIcon type={t} />}
                label={PROPERTY_TYPE_LABELS[t]}
                right={t === prop.type ? <Check size={14} /> : undefined}
                onClick={() => changeType(t)}
              />
            ))}
          </div>
        </>
      );
    case 'options':
      return (
        <>
          <PanelHeader title="Options" onBack={back} />
          <OptionsEditor prop={prop} mode="manage" canManage={canEdit} />
        </>
      );
    case 'number':
      return (
        <>
          <PanelHeader title="Format des nombres" onBack={back} />
          {(Object.keys(NUMBER_FORMAT_LABELS) as NumberFormat[]).map((f) => (
            <MenuItem
              key={f}
              label={NUMBER_FORMAT_LABELS[f]}
              right={(prop.numberFormat ?? 'number') === f ? <Check size={14} /> : undefined}
              onClick={() => {
                void m.updateProperty(prop.id, { numberFormat: f });
                back();
              }}
            />
          ))}
        </>
      );
    case 'relation':
      return (
        <>
          <PanelHeader title="Base liée" onBack={back} />
          <div className="ordb-menu-hint is-tight">
            {prop.type === 'relation'
              ? 'Changer de base liée efface les valeurs actuelles.'
              : 'Les valeurs actuelles seront reliées aux pages de la base choisie portant le même titre (« A, B » → deux pages) ; les autres seront effacées.'}
          </div>
          <DatabasePicker
            current={prop.relation?.databaseId}
            onPick={(dbId) => {
              void m.updateProperty(prop.id, { type: 'relation', relation: { databaseId: dbId } });
              back();
            }}
          />
        </>
      );
    case 'rollup': {
      const draft = rollupDraft ?? prop.rollup ?? newPropertyDef('rollup', properties).rollup!;
      return (
        <>
          <PanelHeader title="Rollup" onBack={back} />
          <RollupSetup
            value={draft}
            onChange={(cfg) => {
              setRollupDraft(cfg);
              if (prop.type === 'rollup') void m.updateProperty(prop.id, { rollup: cfg });
            }}
            submitLabel={prop.type === 'rollup' ? undefined : 'Convertir en rollup'}
            onSubmit={
              prop.type === 'rollup'
                ? undefined
                : (cfg) => {
                    void m.updateProperty(prop.id, { type: 'rollup', rollup: cfg });
                    back();
                  }
            }
          />
        </>
      );
    }
    case 'twoWayOff':
      return (
        <>
          <PanelHeader title="Relation à sens unique" onBack={back} />
          <div className="ordb-panel-body ordb-warning">
            <TriangleAlert size={16} />
            <span>
              La propriété liée « {mirrorName} » de « {target.title} » sera supprimée, avec ses valeurs.
            </span>
          </div>
          <div className="ordb-confirm-actions ordb-panel-body">
            <button type="button" className="ordb-btn is-outline is-sm" onClick={back}>
              Annuler
            </button>
            <button
              type="button"
              className="ordb-btn is-danger is-sm"
              onClick={() => {
                void m.updateProperty(prop.id, { twoWay: null });
                back();
              }}
            >
              Désactiver
            </button>
          </div>
        </>
      );
    case 'delete':
      return (
        <>
          <PanelHeader title="Supprimer la propriété" onBack={back} />
          <div className="ordb-panel-body ordb-warning">
            <TriangleAlert size={16} />
            <span>
              Supprimer « {prop.name} » ? Ses valeurs seront retirées de toutes les lignes et des vues.
              {citedBy.length > 0 && ` ${citedBy.length > 1 ? 'Les formules' : 'La formule'} ${citedNames} ne ${citedBy.length > 1 ? 'pourront' : 'pourra'} plus la lire.`}
            </span>
          </div>
          {twoWay && (
            <div className="ordb-panel-body">
              <Toggle
                label={`Supprimer aussi « ${mirrorName} » dans « ${target.title} »`}
                checked={deleteMirror}
                onChange={setDeleteMirror}
              />
              {!deleteMirror && <div className="ordb-menu-hint is-tight">Elle deviendra une relation à sens unique.</div>}
            </div>
          )}
          <div className="ordb-confirm-actions ordb-panel-body">
            <button type="button" className="ordb-btn is-outline is-sm" onClick={back}>
              Annuler
            </button>
            <button
              type="button"
              className="ordb-btn is-danger is-sm"
              onClick={() => {
                close();
                void m.deleteProperty(prop.id, twoWay ? (deleteMirror ? 'delete' : 'keep') : undefined);
              }}
            >
              Supprimer
            </button>
          </div>
        </>
      );
  }

  const sortBy = (direction: 'asc' | 'desc') => {
    if (!view) return;
    view.setConfig({
      sorts: [{ propertyId: prop.id, direction }, ...view.config.sorts.filter((s) => s.propertyId !== prop.id)],
    });
    close();
  };

  const items: ReactNode[] = [];
  if (canEdit) {
    items.push(
      <div className="ordb-panel-body" key="name">
        <CommitInput
          value={prop.name}
          ariaLabel="Nom de la propriété"
          autoFocus
          selectOnFocus
          onCommit={(name) => {
            const trimmed = name.trim();
            if (!trimmed || trimmed === prop.name) return;
            // The server rewrites the formulas citing it in the same transaction.
            void m.updateProperty(prop.id, { name: trimmed });
          }}
        />
        {citedBy.length > 0 && (
          <div className="ordb-menu-hint is-tight">
            Citée par {citedBy.length > 1 ? 'les formules' : 'la formule'} {citedNames} : un renommage {citedBy.length > 1 ? 'les' : 'la'} mettra à jour.
          </div>
        )}
      </div>,
    );
    if (!isTitle) {
      items.push(
        <MenuItem
          key="type"
          icon={<PropertyIcon type={prop.type} />}
          label="Type"
          right={PROPERTY_TYPE_LABELS[prop.type]}
          chevron
          onClick={() => setPanel('type')}
        />,
      );
    }
    if (OPTION_TYPES.includes(prop.type)) {
      items.push(
        <MenuItem key="opts" label="Modifier les options" right={`${prop.options?.length ?? 0}`} chevron onClick={() => setPanel('options')} />,
      );
    }
    if (prop.type === 'number') {
      items.push(
        <MenuItem
          key="fmt"
          label="Format"
          right={NUMBER_FORMAT_LABELS[prop.numberFormat ?? 'number']}
          chevron
          onClick={() => setPanel('number')}
        />,
        <NumberDisplaySettings key="numdisp" prop={prop} />,
      );
    }
    if (prop.type === 'date') items.push(<DateReminderSettings key="datereminder" prop={prop} />);
    if (prop.type === 'relation') {
      items.push(
        <RelationSettings key="rel" prop={prop} onChangeTarget={() => setPanel('relation')} onAskTwoWayOff={() => setPanel('twoWayOff')} />,
      );
    }
    if (prop.type === 'rollup') {
      items.push(<MenuItem key="rollup" icon={<Database size={14} />} label="Configurer le rollup" chevron onClick={() => setPanel('rollup')} />);
    }
    if (prop.type === 'formula') {
      items.push(<MenuItem key="formula" icon={<Sigma size={14} />} label="Modifier la formule" onClick={openFormula} />);
    }
    if (prop.type === 'unique_id') {
      items.push(
        <div className="ordb-panel-body ordb-field-row" key="prefix">
          <span>Préfixe</span>
          <CommitInput
            value={prop.uniqueIdPrefix ?? ''}
            placeholder="ex. TASK"
            ariaLabel="Préfixe de l'identifiant"
            onCommit={(v) => void m.updateProperty(prop.id, { uniqueIdPrefix: v.trim().replace(/-+$/, '') })}
          />
        </div>,
      );
    }
    items.push(<MenuDivider key="d1" />);
  } else if (prop.type === 'formula') {
    items.push(<MenuItem key="formula" icon={<Sigma size={14} />} label="Voir la formule" onClick={openFormula} />);
  }

  if (view) {
    items.push(
      <MenuItem key="asc" icon={<ArrowUp size={14} />} label="Trier par ordre croissant" onClick={() => sortBy('asc')} />,
      <MenuItem key="desc" icon={<ArrowDown size={14} />} label="Trier par ordre décroissant" onClick={() => sortBy('desc')} />,
    );
    if (view.onFilter) {
      items.push(
        <MenuItem
          key="filter"
          icon={<ListFilter size={14} />}
          label="Filtrer"
          onClick={() => {
            close();
            view.onFilter?.(prop.id);
          }}
        />,
      );
    }
    if (!isTitle) {
      items.push(
        <MenuItem
          key="hide"
          icon={<EyeOff size={14} />}
          label="Masquer dans la vue"
          onClick={() => {
            view.setConfig({ hiddenProperties: [...new Set([...view.config.hiddenProperties, prop.id])] });
            close();
          }}
        />,
      );
    }
  }

  if (canEdit) {
    if (view?.onInsert) {
      items.push(
        <MenuDivider key="d2" />,
        <MenuItem
          key="left"
          icon={<ArrowLeftToLine size={14} />}
          label="Insérer à gauche"
          onClick={() => {
            close();
            view.onInsert?.('left');
          }}
        />,
        <MenuItem
          key="right"
          icon={<ArrowRightToLine size={14} />}
          label="Insérer à droite"
          onClick={() => {
            close();
            view.onInsert?.('right');
          }}
        />,
      );
    }
    if (!isTitle) {
      items.push(
        <MenuDivider key="d3" />,
        <MenuItem
          key="dup"
          icon={<Copy size={14} />}
          label="Dupliquer la propriété"
          onClick={() => {
            const { id: _drop, ...rest } = prop;
            const { id } = m.createProperty({ ...rest, name: uniquePropertyName(`${prop.name} (copie)`, properties) }, prop.id);
            view?.onDuplicated?.(id);
            close();
          }}
        />,
        <MenuItem key="del" icon={<Trash size={14} />} label="Supprimer la propriété" danger onClick={() => setPanel('delete')} />,
      );
    }
  }

  if (prop.readOnly) {
    items.unshift(
      <div key="ro-prop" className="ordb-menu-hint is-tight">
        <Lock size={12} /> Vous ne pouvez pas modifier cette propriété.
      </div>,
    );
  }
  if (canEditDatabase && canManage && !isTitle) {
    items.push(
      <MenuDivider key="access-div" />,
      <MenuItem
        key="access"
        icon={<Lock size={14} />}
        label="Droits d'accès"
        right={accessSummary(prop) ? 'Restreints' : undefined}
        chevron
        onClick={() => setPanel('access')}
      />,
    );
  }
  if (items.length === 0) {
    items.push(<div key="ro" className="ordb-menu-empty">Lecture seule</div>);
  }
  return <>{items}</>;
}
