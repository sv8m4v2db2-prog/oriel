// In-place editor for text-like values (title, text, number, url, email, phone).
import { useLayoutEffect, useRef, useState } from 'react';
import type { PropertyType } from '@oriel/shared';
import { cx } from '../primitives';

export type EditMove = 'next' | 'prev' | 'down' | undefined;

const PLACEHOLDERS: Partial<Record<PropertyType, string>> = {
  title: 'Sans titre',
  text: 'Saisissez du texte…',
  number: 'Nombre',
  url: 'https://…',
  email: 'nom@exemple.fr',
  phone: '+33 …',
};

export function TextEditor({
  initial,
  type,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  type: PropertyType;
  /** Called once with the final draft (also on blur). */
  onCommit: (value: string, move?: EditMove) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const multiline = type === 'text';

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    resize();
  }, []);

  const finish = (value: string | null, move?: EditMove) => {
    if (done.current) return;
    done.current = true;
    if (value === null) onCancel();
    else onCommit(value, move);
  };

  return (
    <textarea
      ref={ref}
      className={cx('ordb-text-editor', `is-${type}`, className)}
      value={draft}
      rows={1}
      placeholder={PLACEHOLDERS[type]}
      aria-label="Modifier la valeur"
      inputMode={type === 'number' ? 'decimal' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : undefined}
      spellCheck={type === 'text' || type === 'title'}
      onChange={(e) => {
        setDraft(type === 'text' ? e.target.value : e.target.value.replace(/\n/g, ''));
        resize();
      }}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        } else if (e.key === 'Enter' && !(multiline && e.shiftKey) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(draft, 'down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(draft, e.shiftKey ? 'prev' : 'next');
        }
      }}
    />
  );
}
