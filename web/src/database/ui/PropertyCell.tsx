// A property value that can be edited in place: display + the right editor for its type.
import { memo, useCallback, type ReactNode } from 'react';
import { DbPopover as Popover } from './DbPopover';
import type { DateValue, Page, PlaceValue, PropertyDef, PropertyValue } from '@oriel/shared';
import { useDb } from '../context';
import { parseNumberInput } from '../logic/format';
import { asFiles, asNumber, asPlace, asString, getIdList, isComputedType, rawValue } from '../logic/values';
import { DateEditor } from './editors/DateEditor';
import { OptionsEditor } from './editors/OptionsEditor';
import { FilesEditor, PersonEditor, RelationEditor } from './editors/PickerEditors';
import { PlaceEditor } from './editors/PlaceEditor';
import { VerificationEditor } from '../row/VerificationField';
import { TextEditor, type EditMove } from './editors/TextEditor';
import { cx, stopEscape } from './primitives';
import { ValueDisplay, type DisplayVariant } from './ValueDisplay';

export const TEXT_LIKE = new Set(['title', 'text', 'number', 'url', 'email', 'phone']);

export function isEditableProp(prop: PropertyDef): boolean {
  // readOnly: per-property permissions (D30), set by the server for this viewer.
  return !isComputedType(prop.type) && !prop.readOnly;
}

/** Draft text shown when a text-like editor opens. */
function initialText(row: Page, prop: PropertyDef): string {
  if (prop.type === 'number') {
    const n = asNumber(rawValue(row, prop));
    return n === null ? '' : String(n).replace('.', ',');
  }
  return asString(rawValue(row, prop));
}

const POPOVER_WIDTH: Partial<Record<PropertyDef['type'], number>> = {
  date: 284,
  files: 320,
  relation: 320,
  person: 300,
  place: 340,
};

interface Props {
  row: Page;
  prop: PropertyDef;
  variant: DisplayVariant;
  wrap?: boolean;
  editing: boolean;
  /** Ask to start (true) or stop (false) editing; `move` lets tables jump to another cell. */
  onEditingChange: (editing: boolean, move?: EditMove) => void;
  readOnly?: boolean;
}

function PropertyCellInner({ row, prop, variant, wrap, editing, onEditingChange, readOnly }: Props) {
  const { m, canEdit, workspaceId, publicMode } = useDb();
  const editable = canEdit && !readOnly && isEditableProp(prop);

  const setValue = useCallback(
    (value: PropertyValue) => {
      if (prop.type === 'title') void m.updateRow(row.id, { title: typeof value === 'string' ? value : '' });
      else void m.updateRow(row.id, { properties: { [prop.id]: value } });
    },
    [m, row.id, prop.id, prop.type],
  );

  const commitText = (text: string, move?: EditMove) => {
    const before = initialText(row, prop);
    if (text !== before) {
      if (prop.type === 'number') {
        const n = parseNumberInput(text);
        if (n !== undefined) setValue(n);
      } else if (prop.type === 'title') {
        setValue(text.replace(/\s+$/, ''));
      } else {
        setValue(text.trim() === '' ? null : text);
      }
    }
    onEditingChange(false, move);
  };

  const display = (
    <ValueDisplay
      row={row}
      prop={prop}
      variant={variant}
      wrap={wrap}
      onToggle={editable && prop.type === 'checkbox' ? (c) => setValue(c) : undefined}
    />
  );

  if (editing && editable && TEXT_LIKE.has(prop.type)) {
    return (
      <div className={cx('ordb-cell', `is-${variant}`, 'is-editing')}>
        <TextEditor
          initial={initialText(row, prop)}
          type={prop.type}
          onCommit={commitText}
          onCancel={() => onEditingChange(false)}
          className={variant === 'table' ? 'is-overlay' : undefined}
        />
      </div>
    );
  }

  const openable = editable && prop.type !== 'checkbox';
  const content = (
    <div
      className={cx('ordb-cell', `is-${variant}`, openable && 'is-editable', editing && 'is-editing')}
      onClick={openable ? () => onEditingChange(true) : undefined}
      onKeyDown={(e) => {
        if (openable && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onEditingChange(true);
        }
      }}
      tabIndex={variant === 'panel' && openable ? 0 : undefined}
      role={openable && variant === 'panel' ? 'button' : undefined}
    >
      {display}
    </div>
  );

  if (!editing || !editable || TEXT_LIKE.has(prop.type) || prop.type === 'checkbox') return content;

  const close = () => onEditingChange(false);
  const value = rawValue(row, prop);
  let editor: ReactNode = null;
  switch (prop.type) {
    case 'select':
    case 'status':
    case 'multi_select':
      editor = (
        <OptionsEditor
          prop={prop}
          mode="select"
          selected={getIdList(row, prop)}
          canManage={canEdit}
          onChange={(ids) => setValue(prop.type === 'multi_select' ? ids : (ids[0] ?? null))}
          onDone={close}
        />
      );
      break;
    case 'date':
      editor = <DateEditor value={(value as DateValue | null) ?? null} onChange={(v) => setValue(v)} />;
      break;
    case 'person':
      editor = <PersonEditor value={getIdList(row, prop)} onChange={(ids) => setValue(ids)} />;
      break;
    case 'files':
      editor = <FilesEditor value={asFiles(value)} onChange={(files) => setValue(files)} />;
      break;
    case 'relation':
      editor = (
        <RelationEditor prop={prop} value={getIdList(row, prop)} onChange={(ids) => setValue(ids)} canCreate={canEdit} onDone={close} />
      );
      break;
    case 'place':
      editor = (
        <PlaceEditor
          value={asPlace(value)}
          onChange={(v: PlaceValue | null) => setValue(v)}
          onDone={close}
          workspaceId={publicMode ? null : workspaceId || null}
        />
      );
      break;
    case 'verification':
      editor = <VerificationEditor value={value} onChange={(v) => setValue(v)} onDone={close} />;
      break;
  }

  return (
    <Popover
      opened
      onChange={(o) => !o && close()}
      onClose={close}
      position="bottom-start"
      offset={variant === 'table' ? 1 : 4}
      width={POPOVER_WIDTH[prop.type] ?? 280}
      shadow="md"
      trapFocus={false}
      returnFocus
    >
      <Popover.Target>{content}</Popover.Target>
      <Popover.Dropdown
        className="ordb-dropdown"
        onKeyDown={(e) => {
          stopEscape(e);
          if (e.key === 'Escape') close();
          if (e.key === 'Tab' && variant === 'table') {
            e.preventDefault();
            onEditingChange(false, e.shiftKey ? 'prev' : 'next');
          }
        }}
      >
        {editor}
      </Popover.Dropdown>
    </Popover>
  );
}

export const PropertyCell = memo(PropertyCellInner);
