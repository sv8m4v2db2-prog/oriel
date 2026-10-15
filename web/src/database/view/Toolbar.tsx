// View toolbar: search, filters, sorts, grouping, properties, layout options, "Nouveau".
import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import { DbPopover as Popover } from '../ui/DbPopover';
import {
  ArrowUpDown,
  Check,
  Ellipsis,
  FileDown,
  FileUp,
  Eye,
  EyeOff,
  GripVertical,
  ListFilter,
  Plus,
  Rows3,
  Search,
  SlidersHorizontal,
  Trash,
  X,
} from 'lucide-react';
import type { PropertyDef, SortRule, ViewConfig, ViewType } from '@oriel/shared';
import { isChartView, VIEW_TYPE_LABELS } from '@oriel/shared';
import { useDb } from '../context';
import { canBoardBy, canGroupBy, computeGroups } from '../logic/group';
import { exportProperties, isDateLike } from '../logic/viewConfig';
import { dependencyCandidates } from '../logic/dependencies';
import { normalizeText } from '../logic/text';
import { PropertyIcon, ViewIcon } from '../ui/icons';
import { AddPropertyPanel } from '../ui/PropertyMenu';
import { cx, IconBtn, MenuDivider, MenuItem, MenuLabel, NativeSelect, PanelHeader, stopEscape, Toggle } from '../ui/primitives';
import { moveId, SortableList, useSortableItem } from '../ui/Sortable';
import { FilterMenu } from './FilterMenu';
import { CsvImportModal } from './CsvImportModal';
import { buildCsv, parseCsv, type CsvDelimiter, type ParsedCsv } from '../logic/csv';
import { sortByManualOrder } from '../logic/sort';
import { downloadText, pickFile, safeFilename } from '../../lib/util';
import { toast } from '../../lib/ui';
import { NewRowButton } from './NewRowButton';
import { PublicFormsButton } from './PublicFormsButton';
import type { ViewState } from './types';

import { AGGREGATE_VIEW_TYPES, MENU_VIEW_TYPES as VIEW_TYPES } from './viewTypes';
import { ChartViewOptions } from '../charts/ChartSettings';
import { FeedOptions } from '../layouts/FeedView';
import { RelationGraphHost, RelationGraphMenuItem } from '../row/RelationGraphHost';

export type ToolbarMenu = 'filter' | 'sort' | 'group' | 'properties' | 'layout' | 'more' | null;

const DELIMITER_KEY = 'oriel:csv-delimiter';
function readDelimiter(): CsvDelimiter {
  try {
    return window.localStorage.getItem(DELIMITER_KEY) === ';' ? ';' : ',';
  } catch {
    return ',';
  }
}

/** « … » menu: CSV export (view / whole database) and import. */
function MoreMenu({
  vs,
  unfilteredRows,
  close,
  onImport,
}: {
  vs: ViewState;
  unfilteredRows: ViewState['rows'];
  close: () => void;
  onImport: (csv: { data: ParsedCsv; name: string }) => void;
}) {
  const { canEdit, page, ctx, databaseId, publicMode } = useDb();
  const [delimiter, setDelimiter] = useState<CsvDelimiter>(readDelimiter);
  const dbTitle = page?.title || 'Base sans titre';
  const exportCsv = (scope: 'view' | 'all') => {
    const rows = scope === 'view' ? vs.rows : sortByManualOrder(unfilteredRows, vs.view.rowOrder);
    const props = scope === 'view' ? exportProperties(vs.view.type, vs.config, vs.orderedProps) : vs.orderedProps;
    downloadText(safeFilename(scope === 'view' ? `${dbTitle} - ${vs.view.name}` : dbTitle, 'csv'), buildCsv(rows, props, ctx, delimiter), 'text/csv');
    close();
  };
  const importCsv = async () => {
    close();
    const file = await pickFile('.csv,text/csv,text/plain');
    if (!file) return;
    const data = parseCsv(await file.text());
    if (data.headers.length === 0) {
      toast.error('Ce fichier CSV est vide.');
      return;
    }
    onImport({ data, name: file.name });
  };
  return (
    <div>
      <MenuLabel>Exporter en CSV</MenuLabel>
      <MenuItem icon={<FileDown size={14} />} label="Exporter la vue" right={`${vs.rows.length}`} onClick={() => exportCsv('view')} />
      <MenuItem icon={<FileDown size={14} />} label="Exporter toute la base" right={`${unfilteredRows.length}`} onClick={() => exportCsv('all')} />
      <div className="ordb-panel-body">
        <Toggle
          label="Séparateur « ; » (Excel en français)"
          checked={delimiter === ';'}
          onChange={(on) => {
            const d: CsvDelimiter = on ? ';' : ',';
            setDelimiter(d);
            try {
              window.localStorage.setItem(DELIMITER_KEY, d);
            } catch {
              /* ignore */
            }
          }}
        />
      </div>
      {canEdit && (
        <>
          <MenuDivider />
          <MenuItem icon={<FileUp size={14} />} label="Importer un fichier CSV…" onClick={() => void importCsv()} />
        </>
      )}
      {!publicMode && (
        <>
          <MenuDivider />
          <RelationGraphMenuItem databaseId={databaseId} onOpen={close} />
        </>
      )}
    </div>
  );
}

function ToolbarPopover({
  opened,
  onChange,
  width,
  children,
  target,
}: {
  opened: boolean;
  onChange: (o: boolean) => void;
  width: number;
  children: ReactNode;
  target: ReactElement;
}) {
  return (
    <Popover opened={opened} onChange={onChange} position="bottom-end" width={width} shadow="md">
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
        {opened && children}
      </Popover.Dropdown>
    </Popover>
  );
}

function ToolButton({
  icon,
  label,
  count,
  active,
  onClick,
  compact,
  ref,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  compact?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ordb-toolbtn', active && 'is-active', !!count && 'has-count')}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {icon}
      {!compact && <span className="ordb-toolbtn-label">{label}</span>}
      {!!count && <span className="ordb-toolbtn-count">{count}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sort menu
// ---------------------------------------------------------------------------

function SortRow({
  rule,
  index,
  properties,
  onChange,
  onRemove,
}: {
  rule: SortRule;
  index: number;
  properties: PropertyDef[];
  onChange: (r: SortRule) => void;
  onRemove: () => void;
}) {
  const id = `${rule.propertyId}`;
  const { setNodeRef, style, handleProps } = useSortableItem(id);
  return (
    <div ref={setNodeRef} style={style} className="ordb-sort-rule">
      <span className="ordb-grip" {...handleProps} aria-label={`Déplacer le tri ${index + 1}`}>
        <GripVertical size={13} />
      </span>
      <NativeSelect
        ariaLabel="Propriété"
        value={rule.propertyId}
        onChange={(propertyId) => onChange({ ...rule, propertyId })}
        choices={properties.map((p) => ({ value: p.id, label: p.name }))}
      />
      <NativeSelect
        ariaLabel="Sens"
        value={rule.direction}
        onChange={(d) => onChange({ ...rule, direction: d as 'asc' | 'desc' })}
        choices={[
          { value: 'asc', label: 'Croissant' },
          { value: 'desc', label: 'Décroissant' },
        ]}
      />
      <IconBtn label="Supprimer le tri" onClick={onRemove}>
        <X size={14} />
      </IconBtn>
    </div>
  );
}

function SortMenu({ vs }: { vs: ViewState }) {
  const { properties } = useDb();
  const sorts = vs.config.sorts.filter((s) => properties.some((p) => p.id === s.propertyId));
  const [addClicked, setAdding] = useState(false);
  const adding = addClicked || sorts.length === 0;
  const save = (next: SortRule[]) => vs.setConfig({ sorts: next });
  const unused = properties.filter((p) => !sorts.some((s) => s.propertyId === p.id));
  return (
    <div className="ordb-sort-menu">
      {sorts.length > 0 && (
        <SortableList
          ids={sorts.map((s) => s.propertyId)}
          onMove={(a, o, place) => {
            const ids = moveId(
              sorts.map((s) => s.propertyId),
              a,
              o,
              place,
            );
            save(ids.map((id) => sorts.find((s) => s.propertyId === id)!));
          }}
        >
          {sorts.map((s, i) => (
            <SortRow
              key={s.propertyId}
              rule={s}
              index={i}
              properties={properties.filter((p) => p.id === s.propertyId || !sorts.some((x) => x.propertyId === p.id))}
              onChange={(r) => save(sorts.map((x, j) => (j === i ? r : x)))}
              onRemove={() => save(sorts.filter((_, j) => j !== i))}
            />
          ))}
        </SortableList>
      )}
      {sorts.length === 0 && <div className="ordb-menu-hint">Sans tri, l'ordre manuel (glisser-déposer) s'applique.</div>}
      {adding ? (
        <>
          <MenuLabel>Trier par</MenuLabel>
          <div className="ordb-options-list">
            {unused.map((p) => (
              <MenuItem
                key={p.id}
                icon={<PropertyIcon type={p.type} />}
                label={p.name}
                onClick={() => {
                  setAdding(false);
                  save([...sorts, { propertyId: p.id, direction: 'asc' }]);
                }}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <MenuDivider />
          {unused.length > 0 && <MenuItem icon={<Plus size={14} />} label="Ajouter un tri" onClick={() => setAdding(true)} />}
          {sorts.length > 0 && <MenuItem icon={<Trash size={14} />} label="Supprimer les tris" danger onClick={() => save([])} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group menu
// ---------------------------------------------------------------------------

function GroupMenu({ vs, rowsForGroups }: { vs: ViewState; rowsForGroups: ViewState['rows'] }) {
  const { properties, ctx } = useDb();
  const board = vs.view.type === 'board';
  const eligible = properties.filter((p) => (board ? canBoardBy(p) : canGroupBy(p)));
  const groupProp = properties.find((p) => p.id === vs.config.groupBy);
  const groups = groupProp ? computeGroups(rowsForGroups, groupProp, ctx) : [];
  const hidden = new Set(vs.config.hiddenGroups);
  return (
    <div>
      <div className="ordb-panel-body ordb-field-row">
        <span>{board ? 'Colonnes selon' : 'Regrouper par'}</span>
        <NativeSelect
          ariaLabel="Propriété de regroupement"
          value={vs.config.groupBy ?? ''}
          onChange={(v) => vs.setConfig({ groupBy: v || null, hiddenGroups: [], collapsedGroups: [] })}
          choices={[{ value: '', label: 'Aucun' }, ...eligible.map((p) => ({ value: p.id, label: p.name }))]}
        />
      </div>
      {eligible.length === 0 && (
        <div className="ordb-menu-hint">
          {board ? 'Ajoutez une propriété Sélection ou Statut pour créer des colonnes.' : 'Aucune propriété ne permet de regrouper (sélection, statut, case à cocher, personne).'}
        </div>
      )}
      {groupProp && (
        <>
          <MenuDivider />
          <MenuLabel>Groupes</MenuLabel>
          <div className="ordb-options-list">
            {groups.map((g) => (
              <MenuItem
                key={g.key}
                label={
                  <span className="tag" data-color={g.color}>
                    {g.label}
                  </span>
                }
                right={
                  <span className="ordb-group-toggle">
                    <span className="ordb-muted">{g.rows.length}</span>
                    {hidden.has(g.key) ? <EyeOff size={14} /> : <Eye size={14} />}
                  </span>
                }
                onClick={() =>
                  vs.setConfig({
                    hiddenGroups: hidden.has(g.key) ? vs.config.hiddenGroups.filter((k) => k !== g.key) : [...vs.config.hiddenGroups, g.key],
                  })
                }
              />
            ))}
          </div>
          {hidden.size > 0 && <MenuItem label="Afficher tous les groupes" onClick={() => vs.setConfig({ hiddenGroups: [] })} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties menu (visibility & order)
// ---------------------------------------------------------------------------

function PropertyVisibilityRow({
  prop,
  visible,
  sortable,
  onToggle,
}: {
  prop: PropertyDef;
  visible: boolean;
  sortable: boolean;
  onToggle: () => void;
}) {
  const { setNodeRef, style, handleProps } = useSortableItem(prop.id, !sortable);
  return (
    <div ref={setNodeRef} style={style} className="ordb-prop-row">
      {sortable ? (
        <span className="ordb-grip" {...handleProps} aria-label={`Déplacer ${prop.name}`}>
          <GripVertical size={13} />
        </span>
      ) : (
        <span className="ordb-grip-placeholder" />
      )}
      <PropertyIcon type={prop.type} />
      <span className="ordb-ellipsis">{prop.name}</span>
      <span className="ordb-option-spacer" />
      {prop.type === 'title' ? (
        <span className="ordb-muted ordb-small">Toujours visible</span>
      ) : (
        <IconBtn label={visible ? `Masquer ${prop.name}` : `Afficher ${prop.name}`} onClick={onToggle} active={visible}>
          {visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconBtn>
      )}
    </div>
  );
}

function PropertiesMenu({ vs }: { vs: ViewState }) {
  const { canEdit } = useDb();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const hidden = new Set(vs.config.hiddenProperties);
  const q = normalizeText(query.trim());
  const list = vs.orderedProps.filter((p) => !q || normalizeText(p.name).includes(q));

  if (adding) {
    return (
      <>
        <PanelHeader title="Nouvelle propriété" onBack={() => setAdding(false)} />
        <AddPropertyPanel
          onCreated={(id) => {
            setAdding(false);
            vs.setConfig({ hiddenProperties: vs.config.hiddenProperties.filter((x) => x !== id) });
          }}
        />
      </>
    );
  }

  const nonTitle = vs.orderedProps.filter((p) => p.type !== 'title');
  return (
    <div>
      <div className="ordb-panel-body">
        <input
          className="ordb-input"
          placeholder="Rechercher une propriété…"
          aria-label="Rechercher une propriété"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div className="ordb-props-actions">
        <MenuLabel>Propriétés de la vue</MenuLabel>
        <button
          type="button"
          className="ordb-linkbtn"
          onClick={() =>
            vs.setConfig({ hiddenProperties: hidden.size >= nonTitle.length ? [] : nonTitle.map((p) => p.id) })
          }
        >
          {hidden.size >= nonTitle.length ? 'Tout afficher' : 'Tout masquer'}
        </button>
      </div>
      <div className="ordb-options-list">
        <SortableList
          ids={list.map((p) => p.id)}
          disabled={!!q}
          onMove={(a, o, place) => vs.setConfig({ propertyOrder: moveId(vs.orderedProps.map((p) => p.id), a, o, place) })}
        >
          {list.map((p) => (
            <PropertyVisibilityRow
              key={p.id}
              prop={p}
              visible={!hidden.has(p.id)}
              sortable={!q}
              onToggle={() =>
                vs.setConfig({
                  hiddenProperties: hidden.has(p.id) ? vs.config.hiddenProperties.filter((x) => x !== p.id) : [...vs.config.hiddenProperties, p.id],
                })
              }
            />
          ))}
        </SortableList>
      </div>
      {canEdit && (
        <>
          <MenuDivider />
          <MenuItem icon={<Plus size={14} />} label="Nouvelle propriété" onClick={() => setAdding(true)} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout menu
// ---------------------------------------------------------------------------

function LayoutMenu({ vs }: { vs: ViewState }) {
  const { properties, canEdit, m, databaseId } = useDb();
  const { view, config, setConfig } = vs;
  const dateProps = properties.filter(isDateLike);
  const depProps = dependencyCandidates(properties, databaseId);
  const set = (patch: Partial<ViewConfig>) => setConfig(patch);
  return (
    <div>
      {canEdit && (
        <>
          <MenuLabel>Disposition</MenuLabel>
          <div className="ordb-layout-grid">
            {VIEW_TYPES.map((t) => (
              <button
                type="button"
                key={t}
                className={cx('ordb-layout-choice', view.type === t && 'is-active')}
                onClick={() => void m.updateView(view.id, { type: t })}
              >
                <ViewIcon type={t} size={18} />
                <span>{VIEW_TYPE_LABELS[t]}</span>
                {view.type === t && <Check size={12} className="ordb-layout-check" />}
              </button>
            ))}
          </div>
          <MenuDivider />
        </>
      )}
      <MenuLabel>Options de {VIEW_TYPE_LABELS[view.type].toLocaleLowerCase('fr')}</MenuLabel>
      <div className="ordb-panel-body ordb-layout-options">
        {(view.type === 'table' || view.type === 'list') && (
          <Toggle label="Retour à la ligne" checked={config.wrap} onChange={(wrap) => set({ wrap })} />
        )}
        {(view.type === 'gallery' || view.type === 'board') && (
          <>
            <div className="ordb-field-row">
              <span>Taille des cartes</span>
              <NativeSelect
                ariaLabel="Taille des cartes"
                value={config.cardSize}
                onChange={(v) => set({ cardSize: v as ViewConfig['cardSize'] })}
                choices={[
                  { value: 'small', label: 'Petite' },
                  { value: 'medium', label: 'Moyenne' },
                  { value: 'large', label: 'Grande' },
                ]}
              />
            </div>
            <div className="ordb-field-row">
              <span>Aperçu de la carte</span>
              <NativeSelect
                ariaLabel="Aperçu de la carte"
                value={config.cardCover}
                onChange={(v) => set({ cardCover: v as ViewConfig['cardCover'] })}
                choices={[
                  { value: 'none', label: 'Aucun' },
                  { value: 'cover', label: 'Couverture de la page' },
                ]}
              />
            </div>
          </>
        )}
        {(view.type === 'calendar' || view.type === 'timeline') && (
          <div className="ordb-field-row">
            <span>{view.type === 'timeline' ? 'Date de début' : 'Afficher selon'}</span>
            <NativeSelect
              ariaLabel="Propriété de date"
              value={config.dateProperty ?? ''}
              onChange={(v) => set({ dateProperty: v || null })}
              choices={[{ value: '', label: 'Choisir…' }, ...dateProps.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
        )}
        {view.type === 'timeline' && (
          <>
            <div className="ordb-field-row">
              <span>Date de fin</span>
              <NativeSelect
                ariaLabel="Propriété de date de fin"
                value={config.dateEndProperty ?? ''}
                onChange={(v) => set({ dateEndProperty: v || null })}
                choices={[{ value: '', label: 'Fin de la plage' }, ...dateProps.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
            <div className="ordb-field-row">
              <span>Échelle</span>
              <NativeSelect
                ariaLabel="Échelle"
                value={config.timelineScale}
                onChange={(v) => set({ timelineScale: v as ViewConfig['timelineScale'] })}
                choices={[
                  { value: 'week', label: 'Semaine' },
                  { value: 'month', label: 'Mois' },
                ]}
              />
            </div>
            <div className="ordb-field-row">
              <span>Dépendances</span>
              <NativeSelect
                ariaLabel="Propriété des dépendances (bloqué par)"
                value={config.dependencyProperty ?? ''}
                onChange={(v) => set({ dependencyProperty: v || null })}
                choices={[{ value: '', label: 'Aucune' }, ...depProps.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
            <div className="ordb-menu-hint is-tight">
              {depProps.length === 0
                ? 'Ajoutez une relation bidirectionnelle vers cette base (ex. « Bloqué par » / « Bloque ») pour relier les tâches.'
                : 'Choisissez la propriété qui liste les tâches bloquantes (« Bloqué par »).'}
            </div>
          </>
        )}
        {view.type === 'board' && (
          <div className="ordb-field-row">
            <span>Colonnes selon</span>
            <NativeSelect
              ariaLabel="Propriété des colonnes"
              value={config.groupBy ?? ''}
              onChange={(v) => set({ groupBy: v || null, hiddenGroups: [], collapsedGroups: [] })}
              choices={[{ value: '', label: 'Choisir…' }, ...properties.filter(canBoardBy).map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
        )}
        {/* A1 : fil d'actualité, graphiques, tableau de bord. */}
        {view.type === 'feed' && <FeedOptions config={config} set={set} />}
        {isChartView(view.type) && <ChartViewOptions type={view.type} config={config} set={set} kinds={vs.kinds} />}
        {view.type === 'dashboard' && (
          <div className="ordb-menu-hint is-tight">
            Chaque widget se règle depuis son menu « … ». Les filtres et la recherche de la vue s'appliquent à tous les widgets.
          </div>
        )}
        {/* A2 : carte et formulaire. */}
        {view.type === 'map' && (
          <>
            <div className="ordb-field-row">
              <span>Placer selon</span>
              <NativeSelect
                ariaLabel="Propriété de lieu"
                value={config.placeProperty ?? ''}
                onChange={(v) => set({ placeProperty: v || null })}
                choices={[
                  { value: '', label: 'Choisir…' },
                  ...properties.filter((p) => p.type === 'place').map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
            {!properties.some((p) => p.type === 'place') && (
              <div className="ordb-menu-hint is-tight">Ajoutez une propriété « Lieu » pour placer les lignes sur la carte.</div>
            )}
          </>
        )}
        {view.type === 'form' && (
          <div className="ordb-menu-hint is-tight">
            Les questions, le message de confirmation et le partage se règlent dans le formulaire lui-même (onglet « Questions »).
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function Toolbar({
  vs,
  search,
  onSearch,
  menu,
  setMenu,
  compact,
  unfilteredRows,
}: {
  vs: ViewState;
  search: string;
  onSearch: (s: string) => void;
  menu: ToolbarMenu;
  setMenu: (m: ToolbarMenu) => void;
  compact: boolean;
  unfilteredRows: ViewState['rows'];
}) {
  const { canEdit, databaseId } = useDb();
  const [searchOpen, setSearchOpen] = useState(!!search);
  const [csvImport, setCsvImport] = useState<{ data: ParsedCsv; name: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  const toggle = (m: Exclude<ToolbarMenu, null>) => (o: boolean) => setMenu(o ? m : null);
  const filterCount = (vs.config.filter?.rules.length ?? 0) + (vs.config.filter?.groups ?? []).reduce((n, g) => n + g.rules.length, 0);
  const sortCount = vs.config.sorts.length;
  const groupable = vs.view.type === 'table' || vs.view.type === 'list' || vs.view.type === 'gallery';
  const aggregated = AGGREGATE_VIEW_TYPES.includes(vs.view.type);
  // A2 : un formulaire n'affiche pas de lignes (ni recherche, ni filtre, ni tri, ni propriétés).
  const isForm = vs.view.type === 'form';

  return (
    <div className="ordb-toolbar">
      {!isForm && (
      <div className={cx('ordb-search', searchOpen && 'is-open')}>
        <IconBtn label="Rechercher" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
        </IconBtn>
        {searchOpen && (
          <>
            <input
              ref={searchRef}
              className="ordb-search-input"
              placeholder="Rechercher…"
              aria-label="Rechercher dans les titres"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  onSearch('');
                  setSearchOpen(false);
                }
              }}
              onBlur={() => !search && setSearchOpen(false)}
            />
            {search && (
              <IconBtn label="Effacer la recherche" onClick={() => onSearch('')}>
                <X size={13} />
              </IconBtn>
            )}
          </>
        )}
      </div>
      )}
      {!isForm && (
      <ToolbarPopover
        opened={menu === 'filter'}
        onChange={toggle('filter')}
        width={560}
        target={
          <ToolButton
            icon={<ListFilter size={15} />}
            label="Filtrer"
            count={filterCount}
            active={menu === 'filter'}
            compact={compact}
            onClick={() => setMenu(menu === 'filter' ? null : 'filter')}
          />
        }
      >
        <FilterMenu vs={vs} />
      </ToolbarPopover>
      )}
      {!aggregated && !isForm && (
      <ToolbarPopover
        opened={menu === 'sort'}
        onChange={toggle('sort')}
        width={380}
        target={
          <ToolButton
            icon={<ArrowUpDown size={15} />}
            label="Trier"
            count={sortCount}
            active={menu === 'sort'}
            compact={compact}
            onClick={() => setMenu(menu === 'sort' ? null : 'sort')}
          />
        }
      >
        <SortMenu vs={vs} />
      </ToolbarPopover>
      )}
      {(groupable || vs.view.type === 'board') && (
        <ToolbarPopover
          opened={menu === 'group'}
          onChange={toggle('group')}
          width={300}
          target={
            <ToolButton
              icon={<Rows3 size={15} />}
              label={vs.view.type === 'board' ? 'Colonnes' : 'Regrouper'}
              count={groupable && vs.config.groupBy ? 1 : 0}
              active={menu === 'group'}
              compact={compact}
              onClick={() => setMenu(menu === 'group' ? null : 'group')}
            />
          }
        >
          <GroupMenu vs={vs} rowsForGroups={unfilteredRows} />
        </ToolbarPopover>
      )}
      {!aggregated && !isForm && (
      <ToolbarPopover
        opened={menu === 'properties'}
        onChange={toggle('properties')}
        width={290}
        target={
          <ToolButton
            icon={<Eye size={15} />}
            label="Propriétés"
            active={menu === 'properties'}
            compact={compact}
            onClick={() => setMenu(menu === 'properties' ? null : 'properties')}
          />
        }
      >
        <PropertiesMenu vs={vs} />
      </ToolbarPopover>
      )}
      <ToolbarPopover
        opened={menu === 'layout'}
        onChange={toggle('layout')}
        width={300}
        target={
          <ToolButton
            icon={<SlidersHorizontal size={15} />}
            label="Disposition"
            active={menu === 'layout'}
            compact
            onClick={() => setMenu(menu === 'layout' ? null : 'layout')}
          />
        }
      >
        <LayoutMenu vs={vs} />
      </ToolbarPopover>
      <PublicFormsButton />
      <ToolbarPopover
        opened={menu === 'more'}
        onChange={toggle('more')}
        width={280}
        target={
          <ToolButton
            icon={<Ellipsis size={15} />}
            label="Plus d'actions"
            active={menu === 'more'}
            compact
            onClick={() => setMenu(menu === 'more' ? null : 'more')}
          />
        }
      >
        <MoreMenu vs={vs} unfilteredRows={unfilteredRows} close={() => setMenu(null)} onImport={setCsvImport} />
      </ToolbarPopover>
      {csvImport && <CsvImportModal csv={csvImport.data} fileName={csvImport.name} onClose={() => setCsvImport(null)} />}
      <RelationGraphHost databaseId={databaseId} />
      {canEdit && <NewRowButton vs={vs} />}
    </div>
  );
}
