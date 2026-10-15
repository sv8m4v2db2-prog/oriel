// Read-only rendering of a property value (table cells, cards, list rows, row panel).
import { memo } from 'react';
import { FileText, Image as ImageIcon, MapPin, TriangleAlert } from 'lucide-react';
import type { DateValue, Page, PropertyDef } from '@oriel/shared';
import { navigation } from '../../lib/navigation';
import { useDb } from '../context';
import {
  displayText,
  formatDate,
  formatDateValue,
  formatFormulaResult,
  formatNumber,
  formatPropertyNumber,
  formatUniqueId,
  progressMax,
  progressRatio,
  toHref,
} from '../logic/format';
import { formulaValueToText, isFormulaStructured, type FormulaResult, type FormulaValue } from '../logic/formula';
import type { RollupItem } from '../logic/rollup';
import { asFiles, asNumber, asPlace, asString, findOption, getFormulaResult, getIdList, getRollupResult, rawValue } from '../logic/values';
import { CheckBox, cx, OptionTag, UserChip } from './primitives';
import { VerificationBadge } from '../row/VerificationField';
import { asVerification } from '../row/verification';

export type DisplayVariant = 'table' | 'panel' | 'card' | 'list';

export function isImageFile(f: { mime?: string; name: string }) {
  return (f.mime ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.name);
}

/** Number drawn as a progress bar or ring against the property's maximum (D25). */
export function NumberProgress({ prop, n, className }: { prop: PropertyDef; n: number; className?: string }) {
  const max = progressMax(prop);
  const ratio = progressRatio(n, max);
  const color = prop.numberColor && prop.numberColor !== 'default' ? `var(--tag-${prop.numberColor}-fg)` : 'var(--accent, #2383e2)';
  const label = formatPropertyNumber(prop, n);
  const title = `${label} sur ${formatNumber(max, 'number_with_commas')}`;
  if (prop.numberDisplay === 'ring') {
    const r = 7;
    const c = 2 * Math.PI * r;
    return (
      <span className={cx('ordb-progress-ring', className)} title={title}>
        <svg width="20" height="20" viewBox="0 0 20 20" role="img" aria-label={title}>
          <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3" />
          <circle
            cx="10"
            cy="10"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${c * ratio} ${c}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className={cx('ordb-progress-bar', className)} title={title}>
      <span className="ordb-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(max, Math.max(0, n))}>
        <span className="ordb-progress-fill" style={{ width: `${ratio * 100}%`, background: color }} />
      </span>
      <span>{label}</span>
    </span>
  );
}

function Empty({ variant }: { variant: DisplayVariant }) {
  return variant === 'panel' ? <span className="ordb-empty">Vide</span> : null;
}

/** Chip of a related page (title + icon), opening it in the side panel. */
export function RelationChip({ id, title, icon }: { id: string; title: string | undefined; icon: string | null | undefined }) {
  return (
    <button
      type="button"
      className="ordb-relation-chip"
      onClick={(e) => {
        e.stopPropagation();
        navigation.openPeek(id);
      }}
      title="Ouvrir la page liée"
    >
      {icon ? <span className="ordb-emoji">{icon}</span> : <FileText size={12} />}
      <span>{title === undefined ? 'Page inaccessible' : title || 'Sans titre'}</span>
    </button>
  );
}

/** One original value shown by a rollup (rendered like in its own database). */
function RollupItemView({ item }: { item: RollupItem }) {
  const { row, prop, ctx } = item;
  switch (prop.type) {
    case 'title':
      return <RelationChip id={row.id} title={row.title} icon={row.icon} />;
    case 'select':
    case 'status':
    case 'multi_select':
      return (
        <>
          {getIdList(row, prop)
            .map((id) => findOption(prop, id))
            .filter((o) => !!o)
            .map((o) => (
              <OptionTag key={o.id} option={o} status={prop.type === 'status'} />
            ))}
        </>
      );
    case 'person':
    case 'created_by':
    case 'last_edited_by':
      return (
        <>
          {getIdList(row, prop).map((id) => (
            <UserChip key={id} id={id} user={ctx.users.get(id)} />
          ))}
        </>
      );
    case 'checkbox':
      return <CheckBox checked={rawValue(row, prop) === true} disabled label={prop.name} />;
    default: {
      const text = displayText(row, prop, ctx);
      return text ? <span className="ordb-rollup-item">{text}</span> : null;
    }
  }
}

/** Elements shown for a list, page or person result before « +N » (cells stay light). */
const MAX_FORMULA_CHIPS = 50;

/** Flattens a structured formula result into the values shown as chips (nested lists inline). */
function formulaChips(v: FormulaValue, out: FormulaValue[] = []): FormulaValue[] {
  if (isFormulaStructured(v) && v.kind === 'list') {
    for (const item of v.items) formulaChips(item, out);
  } else if (v !== null && v !== '') out.push(v);
  return out;
}

/** I2: a formula result made of pages, people or a list, shown as chips (pages open in the side panel). */
function FormulaChips({ result, className, variant }: { result: FormulaResult; className: string; variant: DisplayVariant }) {
  const { ctx, related } = useDb();
  const chips = formulaChips(result.value);
  if (!chips.length) return <Empty variant={variant} />;
  const shown = chips.slice(0, MAX_FORMULA_CHIPS);
  return (
    <span className={cx(className, 'ordb-taglist')}>
      {shown.map((v, i) => {
        if (isFormulaStructured(v) && v.kind === 'page') {
          return <RelationChip key={`${i}:${v.id}`} id={v.id} title={v.title} icon={related.get(v.id)?.icon} />;
        }
        if (isFormulaStructured(v) && v.kind === 'person') {
          const user = ctx.users.get(v.id);
          return <UserChip key={`${i}:${v.id}`} id={v.id} user={user ?? (v.name ? { id: v.id, name: v.name, email: v.email ?? '', avatarUrl: null } : undefined)} />;
        }
        const text = formulaValueToText(v);
        return (
          <span key={i} className={cx('ordb-formula-chip', typeof v === 'number' && 'is-numeric')} title={text}>
            {text}
          </span>
        );
      })}
      {chips.length > MAX_FORMULA_CHIPS && <span className="ordb-formula-chip is-more">+{chips.length - MAX_FORMULA_CHIPS}</span>}
    </span>
  );
}

interface Props {
  row: Page;
  prop: PropertyDef;
  variant: DisplayVariant;
  wrap?: boolean;
  /** Checkbox cells toggle directly. */
  onToggle?: (checked: boolean) => void;
}

function ValueDisplayInner({ row, prop, variant, wrap, onToggle }: Props) {
  const { ctx, related, relatedLoaded, hostPageId } = useDb();
  const v = rawValue(row, prop);
  const cls = cx('ordb-value', `is-${prop.type}`, wrap ? 'is-wrap' : 'is-nowrap');

  switch (prop.type) {
    case 'title': {
      const t = asString(v);
      return t ? <span className={cls}>{t}</span> : variant === 'table' ? null : <span className="ordb-empty">Sans titre</span>;
    }
    case 'text': {
      const t = asString(v);
      return t ? <span className={cls}>{t}</span> : <Empty variant={variant} />;
    }
    case 'number': {
      const n = asNumber(v);
      if (n === null) return <Empty variant={variant} />;
      if (prop.numberDisplay === 'bar' || prop.numberDisplay === 'ring') return <NumberProgress prop={prop} n={n} className={cls} />;
      return <span className={cls}>{formatPropertyNumber(prop, n)}</span>;
    }
    case 'unique_id': {
      const n = asNumber(v);
      return n === null ? <Empty variant={variant} /> : <span className={cls}>{formatUniqueId(n, prop.uniqueIdPrefix)}</span>;
    }
    case 'select':
    case 'status': {
      const o = findOption(prop, v);
      return o ? (
        <span className={cls}>
          <OptionTag option={o} status={prop.type === 'status'} />
        </span>
      ) : (
        <Empty variant={variant} />
      );
    }
    case 'multi_select': {
      const opts = getIdList(row, prop)
        .map((id) => findOption(prop, id))
        .filter((o) => !!o);
      return opts.length ? (
        <span className={cx(cls, 'ordb-taglist')}>
          {opts.map((o) => (
            <OptionTag key={o.id} option={o} />
          ))}
        </span>
      ) : (
        <Empty variant={variant} />
      );
    }
    case 'date': {
      const s = formatDateValue(v as DateValue | null);
      return s ? <span className={cls}>{s}</span> : <Empty variant={variant} />;
    }
    case 'created_time':
      return <span className={cls}>{formatDate(new Date(row.createdAt), true)}</span>;
    case 'last_edited_time':
      return <span className={cls}>{formatDate(new Date(row.updatedAt), true)}</span>;
    case 'last_visited': // navigation module: viewer's last visit
      return row.lastVisitedAt ? <span className={cls}>{formatDate(new Date(row.lastVisitedAt), true)}</span> : null;
    case 'person':
    case 'created_by':
    case 'last_edited_by': {
      const ids = getIdList(row, prop);
      return ids.length ? (
        <span className={cx(cls, 'ordb-taglist')}>
          {ids.map((id) => (
            <UserChip key={id} id={id} user={ctx.users.get(id)} />
          ))}
        </span>
      ) : (
        <Empty variant={variant} />
      );
    }
    case 'checkbox':
      return (
        <span className={cls}>
          <CheckBox checked={v === true} onChange={onToggle} disabled={!onToggle} label={prop.name} />
        </span>
      );
    case 'url':
    case 'email':
    case 'phone': {
      const t = asString(v);
      if (!t) return <Empty variant={variant} />;
      return (
        <span className={cls}>
          <a
            className="ordb-link"
            href={toHref(prop.type, t)}
            target={prop.type === 'url' ? '_blank' : undefined}
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {t}
          </a>
        </span>
      );
    }
    case 'files': {
      const files = asFiles(v);
      if (!files.length) return <Empty variant={variant} />;
      return (
        <span className={cx(cls, 'ordb-taglist')}>
          {files.map((f, i) =>
            variant === 'card' && isImageFile(f) ? (
              <img key={i} className="ordb-file-thumb" src={f.url} alt={f.name} loading="lazy" />
            ) : (
              <a
                key={i}
                className="ordb-file-chip"
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={f.name}
              >
                {isImageFile(f) ? <ImageIcon size={12} /> : <FileText size={12} />}
                <span>{f.name}</span>
              </a>
            ),
          )}
        </span>
      );
    }
    case 'relation': {
      // Rows of a loaded related database that are absent are in the trash: not shown.
      const target = prop.relation?.databaseId;
      // I1: « cette page » — the template (or page) whose content shows this database.
      const ids = getIdList(row, prop).filter((id) => related.has(id) || id === hostPageId || !target || !relatedLoaded?.has(target));
      if (!ids.length) return <Empty variant={variant} />;
      return (
        <span className={cx(cls, 'ordb-taglist')}>
          {ids.map((id) => {
            const p = related.get(id);
            return <RelationChip key={id} id={id} title={p ? p.title : id === hostPageId ? 'Cette page' : undefined} icon={p?.icon} />;
          })}
        </span>
      );
    }
    case 'rollup': {
      const r = getRollupResult(row, prop, ctx);
      if (r.error && r.error !== 'Référence circulaire' && variant === 'panel') return <span className="ordb-empty">{r.error}</span>;
      if (prop.rollup?.function === 'show_original' && r.items && r.items.length > 0) {
        return (
          <span className={cx(cls, 'ordb-taglist')}>
            {r.items.map((it) => (
              <RollupItemView key={it.row.id} item={it} />
            ))}
          </span>
        );
      }
      return r.text ? <span className={cx(cls, r.type === 'number' && 'is-numeric')}>{r.text}</span> : <Empty variant={variant} />;
    }
    case 'verification':
      // D21: Vérifiée / À revérifier (nothing when not verified).
      return asVerification(v) ? (
        <span className={cls}>
          <VerificationBadge value={v} />
        </span>
      ) : (
        <Empty variant={variant} />
      );
    case 'place': {
      const place = asPlace(v);
      if (!place) return <Empty variant={variant} />;
      const located = typeof place.lat === 'number' && typeof place.lng === 'number';
      return (
        <span className={cx(cls, 'ordb-place')} title={located ? place.address : `${place.address} (sans position sur la carte)`}>
          <MapPin size={12} className={cx('ordb-place-pin', !located && 'is-unlocated')} aria-hidden />
          <span className="ordb-place-text">{place.address || 'Lieu sans adresse'}</span>
        </span>
      );
    }
    case 'formula': {
      const r = getFormulaResult(row, prop, ctx);
      // D33: a formula citing a deleted, renamed or hidden property says so instead of showing nothing.
      if (r.error?.startsWith('Propriété introuvable')) {
        return (
          <span className={cx(cls, 'ordb-formula-missing')} title={`${r.error} : vérifiez la formule.`}>
            <TriangleAlert size={12} aria-hidden /> Propriété introuvable
          </span>
        );
      }
      if (r.type === 'boolean') {
        return (
          <span className={cls}>
            <CheckBox checked={r.value === true} disabled label={prop.name} />
          </span>
        );
      }
      if (r.type === 'list' || r.type === 'page' || r.type === 'person') return <FormulaChips result={r} className={cls} variant={variant} />;
      const s = formatFormulaResult(r);
      return s ? <span className={cx(cls, r.type === 'number' && 'is-numeric')}>{s}</span> : <Empty variant={variant} />;
    }
  }
}

export const ValueDisplay = memo(ValueDisplayInner);
