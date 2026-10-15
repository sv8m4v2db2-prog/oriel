// Small shared presentational components.
import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { Database, FileText, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { PageKind } from '@oriel/shared';
import { initials, userColor } from '../lib/util';

export function PageIcon({
  icon,
  kind = 'page',
  size = 18,
  className,
}: {
  icon: string | null | undefined;
  kind?: PageKind;
  size?: number;
  className?: string;
}) {
  if (icon) {
    return (
      <span className={`page-icon ${className ?? ''}`} style={{ fontSize: size * 0.95, width: size + 2, height: size + 2 }} aria-hidden>
        {icon}
      </span>
    );
  }
  const Icon = kind === 'database' ? Database : FileText;
  return (
    <span className={`page-icon page-icon--default ${className ?? ''}`} style={{ width: size + 2, height: size + 2 }} aria-hidden>
      <Icon size={Math.round(size * 0.85)} strokeWidth={1.75} />
    </span>
  );
}

export function Avatar({
  name,
  id,
  url,
  size = 24,
  color,
  title,
  ring,
}: {
  name: string;
  id?: string;
  url?: string | null;
  size?: number;
  color?: string;
  title?: string;
  ring?: boolean;
}) {
  const bg = color ?? userColor(id ?? name);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(9, size * 0.42), background: url ? undefined : bg };
  if (ring) style.boxShadow = `0 0 0 2px var(--bg), 0 0 0 3.5px ${bg}`;
  return (
    <span className="avatar" style={style} title={title ?? name} aria-label={name}>
      {url ? <img src={url} alt="" draggable={false} /> : initials(name)}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-label="Chargement" />;
}

export function Skeleton({ width, height = 14, radius, style }: { width?: number | string; height?: number; radius?: number; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width: width ?? '100%', height, borderRadius: radius, ...style }} />;
}

export function PageSkeleton() {
  return (
    <div className="page-skeleton" aria-busy="true" aria-label="Chargement de la page">
      <Skeleton width={56} height={56} radius={10} />
      <Skeleton width="55%" height={36} style={{ marginTop: 20 }} />
      <div style={{ height: 28 }} />
      <Skeleton width="92%" />
      <Skeleton width="86%" style={{ marginTop: 12 }} />
      <Skeleton width="64%" style={{ marginTop: 12 }} />
      <Skeleton width="78%" style={{ marginTop: 28 }} />
      <Skeleton width="40%" style={{ marginTop: 12 }} />
    </div>
  );
}

export function EditorSkeleton() {
  return (
    <div className="editor-skeleton" aria-busy="true">
      <Skeleton width="90%" />
      <Skeleton width="76%" style={{ marginTop: 12 }} />
      <Skeleton width="58%" style={{ marginTop: 12 }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <div className="empty-state__title">{title}</div>
      {children && <div className="empty-state__text">{children}</div>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Une erreur est survenue', message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<TriangleAlert size={28} />}
      title={title}
      action={
        onRetry && (
          <button type="button" className="btn btn--secondary" onClick={onRetry}>
            Réessayer
          </button>
        )
      }
    >
      {message}
    </EmptyState>
  );
}

interface BoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  resetKey?: unknown;
}

export class ErrorBoundary extends Component<BoundaryProps, { error: Error | null; key: unknown }> {
  override state: { error: Error | null; key: unknown } = { error: null, key: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: Error | null; key: unknown }) {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Oriel]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <ErrorState message="Cette partie de la page n’a pas pu s’afficher." onRetry={this.reset} />;
    }
    return this.props.children;
  }
}

export function Logo({ size = 28 }: { size?: number }) {
  // Original mark: a bay window ("oriel") jutting from a wall — canopy, two receding side panes, a
  // front pane and a corbel. Same geometry as public/favicon.svg and desktop/build/icon.svg.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)" />
      <g fill="var(--text-on-accent)">
        <path d="M6.5 10 11 6.5H21L25.5 10Z" />
        <path d="M10.8 11.6 6.6 12.8V19L10.8 20ZM21.2 11.6 25.4 12.8V19L21.2 20Z" fillOpacity={0.72} />
        <path d="M11.6 11.2H20.4V20.4H11.6Z" />
        <path d="M7.5 21.6H24.5L20.2 25.6H11.8Z" />
      </g>
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
