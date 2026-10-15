// Related pages section of a row page (D31, SPEC §5.9): a relation property set to « Section » is shown
// under the property list, as a list or a small table of the related pages, with quick add and remove.
import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Page, PropertyDef } from '@oriel/shared';
import { useDb } from '../context';
import { useDatabaseQuery } from '../data';
import { displayText } from '../logic/format';
import { createRowContext, getIdList } from '../logic/values';
import { DbPopover as Popover } from '../ui/DbPopover';
import { PropertyIcon } from '../ui/icons';
import { RelationEditor } from '../ui/editors/PickerEditors';
import { cx, IconBtn, stopEscape } from '../ui/primitives';
import { RelationChip } from '../ui/ValueDisplay';
import './g3.css';

const TABLE_COLUMNS = 3;

/** Relation properties of a schema shown as a section (D31). */
export const isSectionRelation = (p: PropertyDef) => p.type === 'relation' && p.relation?.rowPageDisplay === 'section';
/** Relation properties kept out of the property list of the row page (section or hidden). */
export const isOutOfPropertyList = (p: PropertyDef) =>
  p.type === 'relation' && (p.relation?.rowPageDisplay === 'section' || p.relation?.rowPageDisplay === 'hidden');

export function RelatedSections({ row }: { row: Page }) {
  const { properties } = useDb();
  const sections = properties.filter(isSectionRelation);
  if (sections.length === 0) return null;
  return (
    <div className="ordb-related-sections">
      {sections.map((p) => (
        <RelatedSection key={p.id} row={row} prop={p} />
      ))}
    </div>
  );
}

function RelatedSection({ row, prop }: { row: Page; prop: PropertyDef }) {
  const { m, canEdit, related, relatedLoaded, publicMode } = useDb();
  const [adding, setAdding] = useState(false);
  const targetId = prop.relation?.databaseId ?? '';
  const editable = canEdit && !prop.readOnly;
  const ids = getIdList(row, prop);
  // Ids missing from a loaded target are trashed rows (latent links): not displayed.
  const visible = ids.filter((id) => related.has(id) || !relatedLoaded?.has(targetId));
  const setIds = (next: string[]) => void m.updateRow(row.id, { properties: { [prop.id]: next } });
  const remove = (id: string) => setIds(ids.filter((x) => x !== id));
  const full = !!prop.relation?.singlePage && visible.length >= 1;

  return (
    <section className="ordb-related" aria-label={prop.name}>
      <header className="ordb-related-head">
        <PropertyIcon type="relation" />
        <span className="ordb-related-title ordb-ellipsis">{prop.name}</span>
        <span className="ordb-related-count">{visible.length}</span>
        <span className="ordb-option-spacer" />
        {editable && !full && (
          <Popover opened={adding} onChange={setAdding} onClose={() => setAdding(false)} position="bottom-end" width={320} shadow="md" trapFocus={false}>
            <Popover.Target>
              <button type="button" className="ordb-related-add" onClick={() => setAdding((a) => !a)}>
                <Plus size={13} /> Ajouter
              </button>
            </Popover.Target>
            <Popover.Dropdown
              className="ordb-dropdown"
              onKeyDown={(e) => {
                stopEscape(e);
                if (e.key === 'Escape') setAdding(false);
              }}
            >
              <RelationEditor prop={prop} value={ids} onChange={setIds} canCreate={editable} onDone={() => setAdding(false)} />
            </Popover.Dropdown>
          </Popover>
        )}
      </header>
      {visible.length === 0 ? (
        <div className="ordb-related-empty">Aucune page liée.</div>
      ) : prop.relation?.sectionLayout === 'table' && !publicMode ? (
        <RelatedTable ids={visible} targetId={targetId} onRemove={editable ? remove : undefined} />
      ) : (
        <ul className="ordb-related-list">
          {visible.map((id) => {
            const page = related.get(id);
            return (
              <li key={id} className="ordb-related-item">
                <RelationChip id={id} title={page?.title} icon={page?.icon} />
                {editable && (
                  <IconBtn label="Retirer le lien" onClick={() => remove(id)}>
                    <X size={13} />
                  </IconBtn>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Small table: title and the first properties of the related database (text only). */
function RelatedTable({ ids, targetId, onRemove }: { ids: string[]; targetId: string; onRemove?: (id: string) => void }) {
  const { related, ctx } = useDb();
  const target = useDatabaseQuery(targetId, false, !!targetId).data;
  const columns = useMemo(
    () => (target?.schema.properties ?? []).filter((p) => p.type !== 'title' && p.type !== 'relation').slice(0, TABLE_COLUMNS),
    [target?.schema.properties],
  );
  const targetCtx = useMemo(
    () =>
      createRowContext(target?.schema.properties ?? [], {
        users: ctx.users.values(),
        relationTitle: (id) => related.get(id)?.title,
        related: ctx.related,
      }),
    [target?.schema.properties, ctx.users, ctx.related, related],
  );
  return (
    <div className="ordb-related-table-wrap">
      <table className="ordb-related-table">
        <thead>
          <tr>
            <th>Nom</th>
            {columns.map((c) => (
              <th key={c.id}>{c.name}</th>
            ))}
            {onRemove && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const page = related.get(id);
            const rowPage = ctx.related?.row(id);
            return (
              <tr key={id}>
                <td>
                  <RelationChip id={id} title={page?.title} icon={page?.icon} />
                </td>
                {columns.map((c) => (
                  <td key={c.id} className={cx('ordb-ellipsis', c.type === 'number' && 'is-numeric')}>
                    {rowPage ? displayText(rowPage, c, targetCtx) : ''}
                  </td>
                ))}
                {onRemove && (
                  <td className="ordb-related-actions">
                    <IconBtn label="Retirer le lien" onClick={() => onRemove(id)}>
                      <X size={13} />
                    </IconBtn>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
