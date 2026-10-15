// Option picker for select / multi_select / status values, with on-the-fly option management:
// create (random color), rename, recolor, change status group, delete, reorder.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Ellipsis, GripVertical, Plus, Trash } from 'lucide-react';
import type { Color, PropertyDef, SelectOption, StatusGroup } from '@oriel/shared';
import { COLOR_LABELS, COLORS, STATUS_GROUP_LABELS } from '@oriel/shared';
import { useDb } from '../../context';
import { newOption } from '../../logic/properties';
import { normalizeText } from '../../logic/text';
import { orderedOptions, STATUS_GROUP_ORDER } from '../../logic/values';
import { StatusDot } from '../icons';
import { CommitInput, cx, IconBtn, MenuDivider, MenuItem, NativeSelect, OptionTag, PanelHeader, Tag } from '../primitives';
import { moveId, SortableList, useSortableItem } from '../Sortable';

interface Props {
  prop: PropertyDef;
  /** 'select': pick values for a row; 'manage': edit the option list only. */
  mode: 'select' | 'manage';
  selected?: string[];
  onChange?: (ids: string[]) => void;
  /** Single select: called after a choice is made. */
  onDone?: () => void;
  canManage: boolean;
}

export function OptionsEditor({ prop, mode, selected = [], onChange, onDone, canManage }: Props) {
  const { m } = useDb();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const multi = prop.type === 'multi_select';
  const isStatus = prop.type === 'status';
  const options = useMemo(() => orderedOptions(prop), [prop]);
  const all = prop.options ?? [];

  const q = normalizeText(query.trim());
  const visible = q ? options.filter((o) => normalizeText(o.name).includes(q)) : options;
  const exact = options.some((o) => normalizeText(o.name) === q);
  const canCreate = canManage && q !== '' && !exact;
  const itemCount = visible.length + (canCreate ? 1 : 0);

  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    if (!editing) inputRef.current?.focus();
  }, [editing]);

  const saveOptions = (next: SelectOption[]) => m.updateProperty(prop.id, { options: next });

  const toggle = (id: string) => {
    if (mode === 'manage') {
      setEditing(id);
      return;
    }
    if (multi) {
      onChange?.(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
      setQuery('');
    } else {
      onChange?.(selected[0] === id ? [] : [id]);
      onDone?.();
    }
  };

  const create = async (group?: StatusGroup) => {
    const name = query.trim();
    if (!name) return;
    const opt = newOption(name, all, isStatus ? (group ?? 'todo') : undefined);
    setQuery('');
    const ok = await saveOptions([...all, opt]);
    if (!ok || mode === 'manage') return;
    if (multi) onChange?.([...selected, opt.id]);
    else {
      onChange?.([opt.id]);
      onDone?.();
    }
  };

  const onMove = (activeId: string, overId: string, place: 'before' | 'after') => {
    const ids = moveId(options.map((o) => o.id), activeId, overId, place);
    const over = all.find((o) => o.id === overId);
    const next = ids
      .map((id) => all.find((o) => o.id === id)!)
      .map((o) => (isStatus && o.id === activeId && over?.group && over.group !== o.group ? { ...o, group: over.group } : o));
    void saveOptions(next);
  };

  const editingOption = editing ? all.find((o) => o.id === editing) : undefined;
  if (editingOption) {
    return (
      <OptionDetail
        option={editingOption}
        isStatus={isStatus}
        onBack={() => setEditing(null)}
        onSave={(patch) => saveOptions(all.map((o) => (o.id === editingOption.id ? { ...o, ...patch } : o)))}
        onDelete={() => {
          setEditing(null);
          void saveOptions(all.filter((o) => o.id !== editingOption.id));
          if (selected.includes(editingOption.id)) onChange?.(selected.filter((x) => x !== editingOption.id));
        }}
      />
    );
  }

  const selectedOptions = selected.map((id) => all.find((o) => o.id === id)).filter((o): o is SelectOption => !!o);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (itemCount ? (h + 1) % itemCount : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (itemCount ? (h - 1 + itemCount) % itemCount : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight < visible.length) toggle(visible[highlight]!.id);
      else if (canCreate) void create();
    } else if (e.key === 'Backspace' && query === '' && mode === 'select' && selected.length > 0) {
      onChange?.(selected.slice(0, -1));
    }
  };

  let lastGroup: StatusGroup | null = null;

  return (
    <div className="ordb-options-editor">
      <div className="ordb-token-field" onClick={() => inputRef.current?.focus()}>
        {mode === 'select' &&
          selectedOptions.map((o) => (
            <OptionTag key={o.id} option={o} status={isStatus} onRemove={() => onChange?.(selected.filter((x) => x !== o.id))} />
          ))}
        <input
          ref={inputRef}
          className="ordb-token-input"
          value={query}
          placeholder={canManage ? 'Rechercher ou créer une option…' : 'Rechercher une option…'}
          aria-label="Rechercher une option"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
      </div>
      <div className="ordb-menu-hint">
        {mode === 'manage' ? 'Cliquez sur une option pour la modifier' : canManage ? 'Choisissez une option ou créez-en une' : 'Choisissez une option'}
      </div>
      <div className="ordb-options-list" role="listbox" aria-multiselectable={multi}>
        <SortableList ids={visible.map((o) => o.id)} onMove={onMove} disabled={!canManage || q !== ''}>
          {visible.map((o, i) => {
            const header =
              isStatus && !q && (o.group ?? 'todo') !== lastGroup ? (
                <div className="ordb-menu-label" key={`g-${o.group}`}>
                  <StatusDot group={o.group} /> {STATUS_GROUP_LABELS[(o.group ?? 'todo') as StatusGroup]}
                </div>
              ) : null;
            lastGroup = (o.group ?? 'todo') as StatusGroup;
            return (
              <Fragment key={o.id}>
                {header}
                <OptionRow
                  option={o}
                  status={isStatus}
                  selected={selected.includes(o.id)}
                  highlighted={highlight === i}
                  sortable={canManage && q === ''}
                  canManage={canManage}
                  onClick={() => toggle(o.id)}
                  onEdit={() => setEditing(o.id)}
                  onHover={() => setHighlight(i)}
                />
              </Fragment>
            );
          })}
        </SortableList>
        {canCreate && (
          <button
            type="button"
            className={cx('ordb-option-row', 'is-create', highlight === visible.length && 'is-highlighted')}
            onMouseEnter={() => setHighlight(visible.length)}
            onClick={() => void create()}
          >
            <Plus size={14} />
            <span>Créer</span>
            <Tag color="default">{query.trim()}</Tag>
          </button>
        )}
        {!canCreate && visible.length === 0 && <div className="ordb-menu-empty">Aucune option</div>}
      </div>
      {isStatus && canManage && q !== '' && !exact && (
        <>
          <MenuDivider />
          <div className="ordb-menu-hint">Créer dans un autre groupe :</div>
          {(['in_progress', 'done'] as StatusGroup[]).map((g) => (
            <MenuItem key={g} icon={<StatusDot group={g} />} label={`« ${query.trim()} » dans ${STATUS_GROUP_LABELS[g]}`} onClick={() => void create(g)} />
          ))}
        </>
      )}
    </div>
  );
}

function OptionRow({
  option,
  status,
  selected,
  highlighted,
  sortable,
  canManage,
  onClick,
  onEdit,
  onHover,
}: {
  option: SelectOption;
  status: boolean;
  selected: boolean;
  highlighted: boolean;
  sortable: boolean;
  canManage: boolean;
  onClick: () => void;
  onEdit: () => void;
  onHover: () => void;
}) {
  const { setNodeRef, style, handleProps } = useSortableItem(option.id, !sortable);
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx('ordb-option-row', highlighted && 'is-highlighted', selected && 'is-selected')}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onClick}
    >
      {sortable ? (
        <span className="ordb-grip" {...handleProps} onClick={(e) => e.stopPropagation()} aria-label="Déplacer l'option">
          <GripVertical size={13} />
        </span>
      ) : (
        <span className="ordb-grip-placeholder" />
      )}
      <OptionTag option={option} status={status} />
      <span className="ordb-option-spacer" />
      {selected && <Check size={14} className="ordb-option-check" />}
      {canManage && (
        <IconBtn
          label="Modifier l'option"
          className="ordb-option-more"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Ellipsis size={14} />
        </IconBtn>
      )}
    </div>
  );
}

function OptionDetail({
  option,
  isStatus,
  onBack,
  onSave,
  onDelete,
}: {
  option: SelectOption;
  isStatus: boolean;
  onBack: () => void;
  onSave: (patch: Partial<SelectOption>) => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="ordb-option-detail">
      <PanelHeader title="Modifier l'option" onBack={onBack} />
      <div className="ordb-panel-body">
        <CommitInput
          value={option.name}
          ariaLabel="Nom de l'option"
          autoFocus
          selectOnFocus
          onCommit={(name) => name.trim() && onSave({ name: name.trim() })}
        />
        {isStatus && (
          <div className="ordb-field-row">
            <span>Groupe</span>
            <NativeSelect
              ariaLabel="Groupe de statut"
              value={option.group ?? 'todo'}
              onChange={(g) => onSave({ group: g as StatusGroup })}
              choices={STATUS_GROUP_ORDER.map((g) => ({ value: g, label: STATUS_GROUP_LABELS[g] }))}
            />
          </div>
        )}
      </div>
      <MenuDivider />
      <div className="ordb-menu-label">Couleur</div>
      <div className="ordb-color-list">
        {COLORS.map((c: Color) => (
          <MenuItem
            key={c}
            icon={<span className="tag ordb-swatch" data-color={c} />}
            label={COLOR_LABELS[c]}
            right={option.color === c ? <Check size={14} /> : undefined}
            onClick={() => onSave({ color: c })}
          />
        ))}
      </div>
      <MenuDivider />
      {confirm ? (
        <div className="ordb-inline-confirm">
          <span>La valeur sera retirée des lignes qui l'utilisent.</span>
          <div>
            <button type="button" className="ordb-btn is-outline is-sm" onClick={() => setConfirm(false)}>
              Annuler
            </button>
            <button type="button" className="ordb-btn is-danger is-sm" onClick={onDelete}>
              Supprimer
            </button>
          </div>
        </div>
      ) : (
        <MenuItem icon={<Trash size={14} />} label="Supprimer l'option" danger onClick={() => setConfirm(true)} />
      )}
    </div>
  );
}
