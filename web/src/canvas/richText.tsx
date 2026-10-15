// Light Markdown of canvas notes (H1): headings, bullets, check boxes and inline bold / italic /
// strike / code. Rendered as React elements from the text: never as HTML.
import { Fragment, type ReactNode } from 'react';

export interface NoteLine {
  kind: 'p' | 'h' | 'li' | 'todo';
  checked?: boolean;
  text: string;
}

export function parseNote(text: string): NoteLine[] {
  return text.split('\n').map((raw) => {
    const todo = /^\s*[-*]?\s*\[( |x|X)\]\s?(.*)$/.exec(raw);
    if (todo) return { kind: 'todo', checked: todo[1] !== ' ', text: todo[2]! };
    const h = /^#{1,3}\s+(.*)$/.exec(raw);
    if (h) return { kind: 'h', text: h[1]! };
    const li = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (li) return { kind: 'li', text: li[1]! };
    return { kind: 'p', text: raw };
  });
}

const INLINE = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (token.startsWith('**')) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('~~')) out.push(<s key={key++}>{token.slice(2, -2)}</s>);
    else if (token.startsWith('`')) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function NoteText({ text, placeholder }: { text: string; placeholder?: string }) {
  if (!text.trim()) return placeholder ? <div className="or-cv-note-placeholder">{placeholder}</div> : null;
  return (
    <>
      {parseNote(text).map((l, i) => (
        <Fragment key={i}>
          {l.kind === 'h' ? (
            <div className="or-cv-note-h">{inline(l.text)}</div>
          ) : l.kind === 'li' ? (
            <div className="or-cv-note-li">{inline(l.text)}</div>
          ) : l.kind === 'todo' ? (
            <div className={`or-cv-note-todo${l.checked ? ' is-done' : ''}`}>
              <span className="or-cv-note-box" aria-hidden>
                {l.checked ? '✓' : ''}
              </span>
              {inline(l.text)}
            </div>
          ) : (
            <div className="or-cv-note-p">{l.text ? inline(l.text) : ' '}</div>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** Plain text of a note line (export). */
export function stripInline(text: string): string {
  return text.replace(INLINE, (t) => (t.startsWith('**') || t.startsWith('~~') ? t.slice(2, -2) : t.slice(1, -1)));
}
