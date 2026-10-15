// « Modifier la propriété… » for several rows: pick a property, a value, apply to every row.
import { useMemo, useState } from 'react';
import { Modal } from '@mantine/core';
import type { DateValue, FileValue, PropertyDef, PropertyValue } from '@oriel/shared';
import { useDb } from '../context';
import { parseNumberInput } from '../logic/format';
import { isComputedType } from '../logic/values';
import { DateEditor } from './editors/DateEditor';
import { OptionsEditor } from './editors/OptionsEditor';
import { FilesEditor, PersonEditor, RelationEditor } from './editors/PickerEditors';
import { Btn, MenuLabel, NativeSelect, Toggle } from './primitives';

export function BulkEditModal({
  rowIds,
  opened,
  onClose,
  initialPropId,
}: {
  rowIds: string[];
  opened: boolean;
  onClose: () => void;
  /** Property preselected (table grid: first column of the selected range). */
  initialPropId?: string;
}) {
  const { properties, m, canEdit } = useDb();
  const editable = useMemo(() => properties.filter((p) => !isComputedType(p.type)), [properties]);
  const [propId, setPropId] = useState<string>(initialPropId ?? '');
  const prop = editable.find((p) => p.id === propId) ?? editable.find((p) => p.type !== 'title') ?? editable[0];
  const [value, setValue] = useState<PropertyValue>(null);
  const [text, setText] = useState('');
  const n = rowIds.length;

  const pick = (id: string) => {
    setPropId(id);
    setValue(null);
    setText('');
  };

  const apply = (v: PropertyValue) => {
    if (!prop || !canEdit) return;
    if (prop.type === 'title') void m.updateRows(rowIds, { title: typeof v === 'string' ? v : '' });
    else void m.updateRows(rowIds, { properties: { [prop.id]: v } });
    onClose();
  };

  const current = (): PropertyValue => {
    if (!prop) return null;
    switch (prop.type) {
      case 'number': {
        const parsed = parseNumberInput(text);
        return parsed === undefined ? null : parsed;
      }
      case 'title':
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        return text.trim() === '' && prop.type !== 'title' ? null : text;
      default:
        return value;
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={`Modifier ${n} ligne${n > 1 ? 's' : ''}`} centered size="sm" zIndex={400}>
      {prop ? (
        <div className="ordb-bulk">
          <MenuLabel>Propriété</MenuLabel>
          <NativeSelect ariaLabel="Propriété à modifier" value={prop.id} onChange={pick} choices={editable.map((p) => ({ value: p.id, label: p.name }))} />
          <MenuLabel>Nouvelle valeur</MenuLabel>
          <div className="ordb-bulk-editor">
            <ValueInput prop={prop} value={value} onChange={setValue} text={text} onText={setText} />
          </div>
          <div className="ordb-confirm-actions">
            <Btn variant="outline" onClick={() => apply(prop.type === 'title' ? '' : null)}>
              Effacer la valeur
            </Btn>
            <Btn variant="primary" onClick={() => apply(current())}>
              Appliquer à {n} ligne{n > 1 ? 's' : ''}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="ordb-menu-hint">Aucune propriété modifiable.</div>
      )}
    </Modal>
  );
}

function ValueInput({
  prop,
  value,
  onChange,
  text,
  onText,
}: {
  prop: PropertyDef;
  value: PropertyValue;
  onChange: (v: PropertyValue) => void;
  text: string;
  onText: (s: string) => void;
}) {
  const { canEdit } = useDb();
  const list = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
  switch (prop.type) {
    case 'select':
    case 'status':
    case 'multi_select':
      return (
        <OptionsEditor
          prop={prop}
          mode="select"
          selected={list}
          canManage={canEdit}
          onChange={(ids) => onChange(prop.type === 'multi_select' ? ids : (ids[0] ?? null))}
        />
      );
    case 'date':
      return <DateEditor value={(value as DateValue | null) ?? null} onChange={(v) => onChange(v)} />;
    case 'person':
      return <PersonEditor value={list} onChange={(ids) => onChange(ids)} />;
    case 'relation':
      return <RelationEditor prop={prop} value={list} onChange={(ids) => onChange(ids)} canCreate={canEdit} />;
    case 'files':
      return <FilesEditor value={Array.isArray(value) ? (value as FileValue[]) : []} onChange={(f) => onChange(f)} />;
    case 'checkbox':
      return <Toggle label="Coché" checked={value === true} onChange={(c) => onChange(c)} />;
    default:
      return (
        <input
          className="ordb-input"
          autoFocus
          aria-label="Valeur"
          inputMode={prop.type === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(e) => onText(e.target.value)}
        />
      );
  }
}
