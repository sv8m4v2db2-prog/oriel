// Pieces shared by the layouts: titles, cards, covers, group headers, quick-add input.
import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import type { Cover, Page, PropertyDef } from '@oriel/shared';
import { COVER_COLORS, COVER_GRADIENTS } from '@oriel/shared';
import { navigation } from '../../lib/navigation';
import { useDb } from '../context';
import { computeGroups, type RowGroup } from '../logic/group';
import { isEmptyValue } from '../logic/values';
import { cx, IconBtn } from '../ui/primitives';
import { openRowMenu } from '../ui/contextMenus';
import { StatusDot } from '../ui/icons';
import { ValueDisplay } from '../ui/ValueDisplay';
import type { ViewState } from '../view/types';

/** Time of the last drag end: the click that ends a drag must not open the card. */
export const dragClock = { endedAt: 0 };
export const openRow = (id: string) => {
  if (Date.now() - dragClock.endedAt > 200) navigation.openPeek(id);
};

export function RowIcon({ row, size = 14 }: { row: Page; size?: number }) {
  return row.icon ? (
    <span className="ordb-emoji" style={{ fontSize: size }}>
      {row.icon}
    </span>
  ) : (
    <FileText size={size} className="ordb-row-doc" aria-hidden />
  );
}

export function RowTitle({ row, icon = true }: { row: Page; icon?: boolean }) {
  return (
    <span className="ordb-row-title">
      {icon && <RowIcon row={row} />}
      <span className={cx('ordb-row-title-text', !row.title && 'is-empty')}>{row.title || 'Sans titre'}</span>
    </span>
  );
}

export function coverStyle(cover: Cover | null | undefined, position?: number): CSSProperties | null {
  if (!cover) return null;
  switch (cover.type) {
    case 'image':
      return {
        backgroundImage: `url("${cover.url.replace(/["\\]/g, (c) => encodeURIComponent(c))}")`,
        backgroundSize: 'cover',
        backgroundPosition: `center ${position ?? 50}%`,
      };
    case 'gradient':
      return COVER_GRADIENTS[cover.value] ? { background: COVER_GRADIENTS[cover.value] } : null;
    case 'color':
      return COVER_COLORS[cover.value] ? { background: COVER_COLORS[cover.value] } : null;
  }
}

/** Visible, non-empty card properties (title excluded). */
export function CardProperties({ row, props }: { row: Page; props: PropertyDef[] }) {
  const { ctx } = useDb();
  const shown = props.filter((p) => p.type !== 'title' && !isEmptyValue(row, p, ctx));
  if (shown.length === 0) return null;
  return (
    <div className="ordb-card-props">
      {shown.map((p) => (
        <div key={p.id} className="ordb-card-prop" title={p.name}>
          {p.type === 'checkbox' ? (
            <span className="ordb-card-check">
              <ValueDisplay row={row} prop={p} variant="card" />
              <span>{p.name}</span>
            </span>
          ) : (
            <ValueDisplay row={row} prop={p} variant="card" wrap />
          )}
        </div>
      ))}
    </div>
  );
}

export interface CardProps {
  row: Page;
  props: PropertyDef[];
  cover: boolean;
  size?: 'small' | 'medium' | 'large';
  className?: string;
  style?: CSSProperties;
  dragHandle?: Record<string, unknown>;
  ref?: Ref<HTMLDivElement>;
  dimmed?: boolean;
}

function CardInner({ row, props, cover, size = 'medium', className, style, dragHandle, ref, dimmed }: CardProps) {
  const db = useDb();
  const cs = cover ? coverStyle(row.cover, row.format?.coverPosition) : null;
  return (
    <div
      ref={ref}
      style={style}
      className={cx('ordb-card', `is-${size}`, dimmed && 'is-dimmed', className)}
      role="button"
      tabIndex={0}
      onClick={() => openRow(row.id)}
      onContextMenu={(e) => openRowMenu(e, db, row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigation.openPeek(row.id);
      }}
      {...dragHandle}
    >
      {cover && (
        <div className={cx('ordb-card-cover', !cs && 'is-empty')} style={cs ?? undefined}>
          {!cs && row.icon && <span className="ordb-card-cover-icon">{row.icon}</span>}
        </div>
      )}
      <div className="ordb-card-body">
        <div className="ordb-card-title">
          <RowTitle row={row} />
        </div>
        <CardProperties row={row} props={props} />
      </div>
    </div>
  );
}

export const Card = memo(CardInner);

/** Inline "new card" input: Enter creates a row with this title (and stays open), Escape closes. */
export function NewCardInput({ onCreate, onClose, placeholder = 'Titre de la nouvelle page…' }: {
  onCreate: (title: string) => void;
  onClose: () => void;
  placeholder?: string;
}) {
  const [title, setTitle] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="ordb-card ordb-new-card">
      <input
        ref={ref}
        className="ordb-input is-bare"
        value={title}
        placeholder={placeholder}
        aria-label="Titre de la nouvelle page"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            onCreate(title.trim());
            setTitle('');
          } else if (e.key === 'Escape') {
            onClose();
          }
        }}
        onBlur={() => {
          if (title.trim()) onCreate(title.trim());
          onClose();
        }}
      />
    </div>
  );
}

export function AddRowButton({ onClick, label = 'Nouveau', className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button type="button" className={cx('ordb-add-row', className)} onClick={onClick}>
      <Plus size={14} /> {label}
    </button>
  );
}

export function GroupLabel({ group }: { group: RowGroup }) {
  if (group.user) {
    return <span className="ordb-group-label">{group.label}</span>;
  }
  return (
    <span className="tag" data-color={group.color}>
      {group.statusGroup && <StatusDot group={group.statusGroup} />}
      {group.label}
    </span>
  );
}

export function GroupHeader({
  group,
  collapsed,
  onToggle,
  onAdd,
}: {
  group: RowGroup;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
}) {
  return (
    <div className="ordb-group-header">
      <IconBtn label={collapsed ? 'Déplier le groupe' : 'Replier le groupe'} onClick={onToggle}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </IconBtn>
      <button type="button" className="ordb-group-name" onClick={onToggle}>
        <GroupLabel group={group} />
      </button>
      <span className="ordb-group-count">{group.rows.length}</span>
      {onAdd && (
        <IconBtn label="Ajouter une ligne dans ce groupe" onClick={onAdd} className="ordb-group-add">
          <Plus size={14} />
        </IconBtn>
      )}
    </div>
  );
}

/** Groups of the view (grouped table / list / gallery), hidden groups removed. */
export function useViewGroups(vs: ViewState, allowed: (p: PropertyDef) => boolean) {
  const { properties, ctx } = useDb();
  const prop = properties.find((p) => p.id === vs.config.groupBy && allowed(p)) ?? null;
  const groups = useMemo(() => {
    if (!prop) return null;
    const hidden = new Set(vs.config.hiddenGroups);
    return computeGroups(vs.rows, prop, ctx).filter((g) => !hidden.has(g.key));
  }, [prop, vs.rows, vs.config.hiddenGroups, ctx]);
  const collapsed = useMemo(() => new Set(vs.config.collapsedGroups), [vs.config.collapsedGroups]);
  const toggle = (key: string) =>
    vs.setConfig({
      collapsedGroups: collapsed.has(key) ? vs.config.collapsedGroups.filter((k) => k !== key) : [...vs.config.collapsedGroups, key],
    });
  return { prop, groups, collapsed, toggle };
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ordb-empty-state">
      <span>{children}</span>
      {action}
    </div>
  );
}
