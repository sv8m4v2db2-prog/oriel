// Small presentational pieces shared by the import and export cards.
import type { ReactNode } from 'react';

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('fr-FR')} ${n > 1 ? pluralWord : word}`;
}

export function ProgressBar({ done, total, phase, label }: { done: number; total: number; phase: string; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="io-progress">
      <div className="io-progress__head">
        <span className="io-progress__phase">{phase}</span>
        <span className="io-progress__count">
          {total > 0 ? `${done.toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')}` : ''} {total > 0 ? `· ${pct} %` : ''}
        </span>
      </div>
      <div className="io-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={phase}>
        <div className={`io-progress__bar${total === 0 ? ' is-indeterminate' : ''}`} style={total > 0 ? { width: `${pct}%` } : undefined} />
      </div>
      {label ? <div className="io-progress__label">{label}</div> : null}
    </div>
  );
}

export function MessageList({ title, items, tone, open }: { title: string; items: string[]; tone: 'warning' | 'error' | 'info'; open?: boolean }) {
  if (items.length === 0) return null;
  return (
    <details className={`io-messages io-messages--${tone}`} open={open}>
      <summary>
        {title} ({items.length.toLocaleString('fr-FR')})
      </summary>
      <ul>
        {items.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </details>
  );
}

export function Stat({ value, label, icon }: { value: number; label: string; icon?: ReactNode }) {
  return (
    <div className="io-stat">
      <span className="io-stat__value">
        {icon}
        {value.toLocaleString('fr-FR')}
      </span>
      <span className="io-stat__label">{label}</span>
    </div>
  );
}
