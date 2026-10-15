// Results of a page listing, as a table (list) or cards (grid), with group headers, selection
// and the chosen columns. Shared by « Toutes les pages », tag pages and the collection preview.
import { Fragment, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { Member, PageGroupBy, PageListItem, PageProp, PagePropValue, Tag } from '@oriel/shared';
import { PageIcon } from '../components/common';
import { formatWhen, pagePath, pageTitle } from '../lib/util';
import { BASE_COLUMNS, groupLabel, formatPropValue, type ResultsContext } from './logic';
import { TagChip } from './TagChip';

export { BASE_COLUMNS, groupLabel, formatPropValue, type ResultsContext };

function Cell({ item, column, ctx }: { item: PageListItem; column: string; ctx: ResultsContext }) {
  if (column === 'tags') {
    return (
      <span className="org-cell-tags">
        {item.tagIds.map((id) => {
          const t = ctx.tags.get(id);
          return t ? <TagChip key={id} tag={t} /> : null;
        })}
      </span>
    );
  }
  if (column === 'parent') return <span className="muted">{item.parentTitle !== null ? pageTitle(item.parentTitle) : '—'}</span>;
  if (column === 'author') return <span>{ctx.members.get(item.updatedBy)?.user.name ?? '—'}</span>;
  if (column === 'created') return <span className="muted">{formatWhen(item.createdAt)}</span>;
  if (column === 'updated') return <span className="muted">{formatWhen(item.updatedAt)}</span>;
  if (column.startsWith('prop:')) {
    const def = ctx.props.get(column.slice(5));
    return <span>{def ? formatPropValue(def, item.props[def.id]) : ''}</span>;
  }
  return null;
}

export function columnLabel(column: string, ctx: Pick<ResultsContext, 'props'>): string {
  if (column.startsWith('prop:')) return ctx.props.get(column.slice(5))?.name ?? 'Propriété';
  return BASE_COLUMNS.find((c) => c.id === column)?.label ?? column;
}

export function PageResults({
  items,
  layout,
  columns,
  group,
  ctx,
  selected,
  onToggle,
  onToggleAll,
}: {
  items: PageListItem[];
  layout: 'list' | 'grid';
  columns: string[];
  group: PageGroupBy;
  ctx: ResultsContext;
  selected?: ReadonlySet<string>;
  onToggle?: (id: string, on: boolean) => void;
  onToggleAll?: (on: boolean) => void;
}) {
  const grouped = group !== 'none';
  const withGroups = (render: (item: PageListItem) => ReactElement, wrap: 'rows' | 'cards') => {
    const out: ReactElement[] = [];
    let last: string | null | undefined;
    for (const item of items) {
      if (grouped && item.group !== last) {
        last = item.group;
        out.push(
          wrap === 'rows' ? (
            <tr key={`g:${item.group}:${item.id}`} className="org-group-row">
              <th colSpan={columns.length + 2}>{groupLabel(group, item.group ?? '', ctx)}</th>
            </tr>
          ) : (
            <h3 key={`g:${item.group}:${item.id}`} className="org-group-title">
              {groupLabel(group, item.group ?? '', ctx)}
            </h3>
          ),
        );
      }
      out.push(render(item));
    }
    return out;
  };

  if (layout === 'grid') {
    return (
      <div className="org-grid">
        {withGroups(
          (item) => (
            <Fragment key={item.id}>
              <Link to={pagePath(ctx.workspaceId, item.id)} className={`org-card${selected?.has(item.id) ? ' is-selected' : ''}`}>
                <span className="org-card__head">
                  {onToggle && (
                    <input
                      type="checkbox"
                      checked={selected?.has(item.id) ?? false}
                      aria-label={`Sélectionner ${pageTitle(item.title)}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onToggle(item.id, e.target.checked)}
                    />
                  )}
                  <PageIcon icon={item.icon} kind={item.kind} size={18} />
                  <span className="org-card__title">{pageTitle(item.title)}</span>
                </span>
                {columns.map((c) => (
                  <span className="org-card__field" key={c}>
                    <span className="org-card__label">{columnLabel(c, ctx)}</span>
                    <Cell item={item} column={c} ctx={ctx} />
                  </span>
                ))}
              </Link>
            </Fragment>
          ),
          'cards',
        )}
      </div>
    );
  }

  return (
    <div className="org-table-wrap">
      <table className="org-table">
        <thead>
          <tr>
            {onToggleAll && (
              <th className="org-table__check">
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={items.length > 0 && items.every((i) => selected?.has(i.id))}
                  onChange={(e) => onToggleAll(e.target.checked)}
                />
              </th>
            )}
            <th>Page</th>
            {columns.map((c) => (
              <th key={c}>{columnLabel(c, ctx)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {withGroups(
            (item) => (
              <tr key={item.id} className={selected?.has(item.id) ? 'is-selected' : undefined}>
                {onToggle && (
                  <td className="org-table__check">
                    <input
                      type="checkbox"
                      checked={selected?.has(item.id) ?? false}
                      aria-label={`Sélectionner ${pageTitle(item.title)}`}
                      onChange={(e) => onToggle(item.id, e.target.checked)}
                    />
                  </td>
                )}
                <td>
                  <Link to={pagePath(ctx.workspaceId, item.id)} className="org-table__title">
                    <PageIcon icon={item.icon} kind={item.kind} size={16} />
                    <span>{pageTitle(item.title)}</span>
                  </Link>
                </td>
                {columns.map((c) => (
                  <td key={c}>
                    <Cell item={item} column={c} ctx={ctx} />
                  </td>
                ))}
              </tr>
            ),
            'rows',
          )}
        </tbody>
      </table>
    </div>
  );
}
