// Small building blocks styled with theme tokens (see database.css).
import { useEffect, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from 'react';
import { Modal } from '@mantine/core';
import { Check, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { Color, PublicUser, SelectOption } from '@oriel/shared';
import { COLORS } from '@oriel/shared';
import { StatusDot } from './icons';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Tags, avatars
// ---------------------------------------------------------------------------

export function Tag({
  color,
  children,
  onRemove,
  title,
}: {
  color: Color;
  children: ReactNode;
  onRemove?: () => void;
  title?: string;
}) {
  return (
    <span className="tag ordb-tag" data-color={color} title={title}>
      <span className="ordb-tag-label">{children}</span>
      {onRemove && (
        <button
          type="button"
          className="ordb-tag-remove"
          aria-label="Retirer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function OptionTag({ option, status, onRemove }: { option: SelectOption; status?: boolean; onRemove?: () => void }) {
  return (
    <Tag color={option.color} onRemove={onRemove} title={option.name}>
      {status && <StatusDot group={option.group} />}
      {option.name || 'Sans nom'}
    </Tag>
  );
}

const AVATAR_COLORS: Color[] = COLORS.filter((c) => c !== 'default');

function colorFor(id: string): Color {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function Avatar({ user, id, size = 20 }: { user?: PublicUser; id?: string; size?: number }) {
  const name = user?.name ?? '?';
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.48)) };
  if (user?.avatarUrl) {
    return <img className="ordb-avatar" src={user.avatarUrl} alt="" style={style} draggable={false} />;
  }
  return (
    <span className="ordb-avatar tag" data-color={colorFor(user?.id ?? id ?? name)} style={style} aria-hidden>
      {name.trim().charAt(0).toLocaleUpperCase('fr') || '?'}
    </span>
  );
}

export function UserChip({ user, id }: { user?: PublicUser; id: string }) {
  return (
    <span className="ordb-user" title={user?.email}>
      <Avatar user={user} id={id} size={18} />
      <span className="ordb-user-name">{user?.name ?? 'Utilisateur inconnu'}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Btn({
  variant = 'ghost',
  size = 'md',
  className,
  children,
  ...rest
}: ComponentPropsWithRef<'button'> & { variant?: 'ghost' | 'primary' | 'danger' | 'outline'; size?: 'sm' | 'md' }) {
  return (
    <button type="button" className={cx('ordb-btn', `is-${variant}`, `is-${size}`, className)} {...rest}>
      {children}
    </button>
  );
}

export function IconBtn({
  label,
  className,
  children,
  active,
  ...rest
}: ComponentPropsWithRef<'button'> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('ordb-iconbtn', active && 'is-active', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface SelectChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Native <select> (reliable inside popovers), styled with tokens. */
export function NativeSelect({
  value,
  onChange,
  choices,
  ariaLabel,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: SelectChoice[];
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <span className={cx('ordb-select', className)}>
      <select value={value} aria-label={ariaLabel} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {choices.map((c) => (
          <option key={c.value} value={c.value} disabled={c.disabled}>
            {c.label}
          </option>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden />
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cx('ordb-toggle', disabled && 'is-disabled')}>
      <span className="ordb-toggle-label">{label}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ordb-toggle-track" aria-hidden>
        <span className="ordb-toggle-thumb" />
      </span>
    </label>
  );
}

/** Checkbox visual used by checkbox cells and row selection. */
export function CheckBox({
  checked,
  onChange,
  disabled,
  label,
  indeterminate,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  indeterminate?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      className={cx('ordb-checkbox', checked && 'is-checked', indeterminate && 'is-mixed')}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
    >
      {checked && <Check size={12} strokeWidth={3} />}
      {!checked && indeterminate && <span className="ordb-checkbox-dash" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Menu panels (content of popovers with internal navigation)
// ---------------------------------------------------------------------------

export function MenuItem({
  icon,
  label,
  right,
  onClick,
  danger,
  disabled,
  active,
  chevron,
  title,
}: {
  icon?: ReactNode;
  label: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  active?: boolean;
  chevron?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={cx('ordb-menuitem', danger && 'is-danger', active && 'is-active')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon !== undefined && <span className="ordb-menuitem-icon">{icon}</span>}
      <span className="ordb-menuitem-label">{label}</span>
      {right !== undefined && <span className="ordb-menuitem-right">{right}</span>}
      {chevron && <ChevronRight size={14} className="ordb-menuitem-chevron" aria-hidden />}
    </button>
  );
}

export function MenuDivider() {
  return <div className="ordb-menu-divider" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="ordb-menu-label">{children}</div>;
}

export function PanelHeader({ title, onBack }: { title: ReactNode; onBack?: () => void }) {
  return (
    <div className="ordb-panel-header">
      {onBack && (
        <IconBtn label="Retour" onClick={onBack}>
          <ChevronLeft size={15} />
        </IconBtn>
      )}
      <span className="ordb-panel-title">{title}</span>
    </div>
  );
}

/** Text input that commits on Enter / blur and cancels on Escape. */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  autoFocus,
  ariaLabel,
  className,
  selectOnFocus,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel: string;
  className?: string;
  selectOnFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      if (selectOnFocus) ref.current.select();
    }
  }, [autoFocus, selectOnFocus]);
  return (
    <input
      ref={ref}
      className={cx('ordb-input', className)}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (draft !== value) onCommit(draft);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function ConfirmModal({
  opened,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  opened: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={title} centered size="sm" zIndex={400}>
      <div className="ordb-confirm">
        <div className="ordb-confirm-message">{message}</div>
        <div className="ordb-confirm-actions">
          <Btn variant="outline" onClick={onClose}>
            Annuler
          </Btn>
          <Btn
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            autoFocus
          >
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/** Stops Escape from reaching global listeners (e.g. the shell closing the peek panel). */
export function stopEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') e.stopPropagation();
}
