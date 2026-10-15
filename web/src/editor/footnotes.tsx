// Footnotes (H5): inline call `footnote` (props.note), automatic numbering by document order, hover card,
// editable list under the content, links both ways. The note lives in the call's attribute, so it is
// synchronized (Yjs) like any other content; the list is derived from the document, never stored.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createReactInlineContentSpec } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { CornerUpLeft } from 'lucide-react';
import { EDITOR_BLOCK_TYPES, FOOTNOTE_MAX_LENGTH, FOOTNOTE_MAX_LISTED } from '@oriel/shared';
import { clampNote } from './footnoteMarkdown';
import { collectFootnotes, footnoteEndingAt, noteOf, relocateFootnote, type FootnoteEntry, type PmDocLike } from './footnoteLogic';

type AnyEditor = BlockNoteEditor<any, any, any>;

const FOCUS_EVENT = 'oriel:footnote-focus';

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

/** `sup[data-or-fn]` of an exported / copied footnote (HTML paste), or undefined. */
function parseExported(el: HTMLElement): { note: string } | undefined {
  return el.hasAttribute('data-or-fn') ? { note: clampNote(el.getAttribute('data-or-fn')) } : undefined;
}

export const Footnote = createReactInlineContentSpec(
  { type: EDITOR_BLOCK_TYPES.footnote, propSchema: { note: { default: '' } }, content: 'none' },
  {
    // The number is set from outside (FootnoteSection) in document order and shown through CSS.
    render: ({ inlineContent }) => <sup className="or-fn" data-note={noteOf(inlineContent.props.note)} role="doc-noteref" tabIndex={0} aria-label="Note de bas de page" />,
    toExternalHTML: ({ inlineContent }) => <sup data-or-fn={noteOf(inlineContent.props.note)} />,
    parse: parseExported,
  },
);

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

/** Inserts a footnote call at the cursor; the cursor then goes to the note's field under the content. */
export function insertFootnote(editor: AnyEditor): void {
  if (!editor.isEditable || !(EDITOR_BLOCK_TYPES.footnote in editor.schema.inlineContentSchema)) return;
  editor.focus();
  editor.insertInlineContent([{ type: EDITOR_BLOCK_TYPES.footnote, props: { note: '' } }] as never);
  // The list is recomputed after the change event; the field is focused by the section.
  setTimeout(() => {
    const doc = editor.prosemirrorState.doc as unknown as PmDocLike;
    const at = footnoteEndingAt(collectFootnotes(doc), editor.prosemirrorState.selection.from);
    window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { index: at?.index ?? -1 } }));
  }, 60);
}

// ---------------------------------------------------------------------------
// Section under the content: numbering, list, hover card, navigation
// ---------------------------------------------------------------------------

/** Calls of this editor in DOM (= document) order, without those of nested editors (synced blocks). */
function callsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('sup.or-fn')).filter((el) => !el.closest('[data-content-type="syncedBlock"]'));
}

function flash(el: HTMLElement | null) {
  if (!el) return;
  el.classList.add('or-fn--flash');
  setTimeout(() => el.classList.remove('or-fn--flash'), 1400);
}

function NoteField({
  entry,
  editable,
  editor,
  onGoBack,
  registerField,
}: {
  entry: FootnoteEntry;
  editable: boolean;
  editor: AnyEditor;
  onGoBack: (index: number) => void;
  registerField: (index: number, el: HTMLTextAreaElement | null) => void;
}) {
  const [value, setValue] = useState(entry.note);
  const editing = useRef(false);
  const base = useRef(entry.note);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(entry);
  latest.current = entry;

  // Remote changes are shown unless this field is being typed in.
  useEffect(() => {
    if (!editing.current) {
      setValue(entry.note);
      base.current = entry.note;
    }
  }, [entry.note]);

  const commit = useCallback(
    (text: string) => {
      timer.current = null;
      const next = clampNote(text);
      if (next === base.current) return;
      const doc = editor.prosemirrorState.doc as unknown as PmDocLike;
      const target = relocateFootnote(collectFootnotes(doc), latest.current.index, base.current);
      if (!target) return;
      editor.transact((tr: any) => {
        const node = tr.doc.nodeAt(target.pos);
        if (node && node.type.name === EDITOR_BLOCK_TYPES.footnote) tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, note: next });
      });
      base.current = next;
    },
    [editor],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const n = entry.index + 1;
  return (
    <li className="or-fn-item" id={`fn-item-${n}`} data-fn-item={entry.index}>
      <span className="or-fn-item__num">{n}.</span>
      {editable ? (
        <textarea
          ref={(el) => {
            registerField(entry.index, el);
            if (el) {
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }
          }}
          className="or-fn-item__field"
          rows={1}
          maxLength={FOOTNOTE_MAX_LENGTH}
          value={value}
          placeholder="Texte de la note…"
          aria-label={`Note ${n}`}
          onFocus={() => (editing.current = true)}
          onChange={(e) => {
            setValue(e.target.value.replace(/\n/g, ' '));
            editing.current = true;
            if (timer.current) clearTimeout(timer.current);
            const text = e.target.value;
            timer.current = setTimeout(() => commit(text), 500);
          }}
          onBlur={(e) => {
            if (timer.current) clearTimeout(timer.current);
            commit(e.target.value);
            editing.current = false;
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
              editor.focus();
            }
          }}
        />
      ) : (
        <span className="or-fn-item__text">{entry.note || <em>(note vide)</em>}</span>
      )}
      <button type="button" className="or-fn-item__back" title="Revenir à l’appel de note" aria-label={`Revenir à l’appel de la note ${n}`} onClick={() => onGoBack(entry.index)}>
        <CornerUpLeft size={13} />
      </button>
    </li>
  );
}

export function FootnoteSection({ editor, canEdit, wrapRef }: { editor: AnyEditor; canEdit: boolean; wrapRef: RefObject<HTMLDivElement | null> }) {
  const [entries, setEntries] = useState<FootnoteEntry[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const fields = useRef(new Map<number, HTMLTextAreaElement>());
  const registerField = useCallback((index: number, el: HTMLTextAreaElement | null) => {
    if (el) fields.current.set(index, el);
    else fields.current.delete(index);
  }, []);

  // The list follows the document (local and remote changes alike).
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      try {
        const list = collectFootnotes(editor.prosemirrorState.doc as unknown as PmDocLike);
        setEntries((prev) => (prev.length === list.length && prev.every((p, i) => p.note === list[i]!.note && p.pos === list[i]!.pos) ? prev : list));
      } catch {
        /* editor being torn down */
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    const off = editor.onChange(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (typeof off === 'function') off();
    };
  }, [editor]);

  // Numbers of the calls, in DOM order. Re-applied when the DOM under the editor changes (a call may be
  // re-created by BlockNote without any change of the list).
  useLayoutEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    let raf = 0;
    const number = () => {
      raf = 0;
      callsOf(root).forEach((el, i) => {
        const n = String(i + 1);
        if (el.getAttribute('data-n') !== n) el.setAttribute('data-n', n);
      });
    };
    number();
    const observer = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(number);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [wrapRef, entries]);

  const goToNote = useCallback((index: number) => {
    const item = document.getElementById(`fn-item-${index + 1}`);
    if (!item) return;
    item.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(item);
  }, []);
  const goToCall = useCallback(
    (index: number) => {
      const root = wrapRef.current;
      const el = root ? callsOf(root)[index] ?? null : null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(el);
    },
    [wrapRef],
  );

  // Event delegation on the editor: hover card and click on a call.
  useEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    const callAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('sup.or-fn') : null);
    const over = (e: MouseEvent) => {
      const call = callAt(e.target);
      if (!call) return;
      const r = call.getBoundingClientRect();
      setHover({ x: r.left + r.width / 2, y: r.bottom, text: call.getAttribute('data-note') || '' });
    };
    const out = (e: MouseEvent) => {
      if (callAt(e.target)) setHover(null);
    };
    const click = (e: MouseEvent) => {
      const call = callAt(e.target);
      if (!call) return;
      const index = callsOf(root).indexOf(call);
      if (index >= 0) {
        e.preventDefault();
        goToNote(index);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const call = callAt(e.target);
      const index = call ? callsOf(root).indexOf(call) : -1;
      if (index >= 0) goToNote(index);
    };
    root.addEventListener('mouseover', over);
    root.addEventListener('mouseout', out);
    root.addEventListener('click', click);
    root.addEventListener('keydown', key);
    return () => {
      root.removeEventListener('mouseover', over);
      root.removeEventListener('mouseout', out);
      root.removeEventListener('click', click);
      root.removeEventListener('keydown', key);
    };
  }, [wrapRef, goToNote]);

  // Focus of a new note's field (insertFootnote).
  useEffect(() => {
    const onFocus = (e: Event) => {
      const index = (e as CustomEvent<{ index: number }>).detail?.index ?? -1;
      if (index < 0) return;
      // The list renders after the change event: wait (a few frames at most) for the field to exist.
      let tries = 0;
      const attempt = () => {
        const field = fields.current.get(index);
        // The new note is empty: the field of that index may still show the previous note until the
        // list has re-rendered (typing there would write into the wrong note).
        if (field && entriesRef.current[index]?.note === '' && field.value === '') {
          field.focus();
          field.scrollIntoView({ block: 'nearest' });
        } else if (++tries < 20) setTimeout(attempt, 40);
      };
      attempt();
    };
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
  }, []);

  return (
    <>
      {entries.length > 0 && (
        <section className="or-footnotes" aria-label="Notes de bas de page" role="doc-endnotes">
          <ol className="or-footnotes__list">
            {entries.slice(0, FOOTNOTE_MAX_LISTED).map((entry) => (
              <NoteField key={entry.index} entry={entry} editable={canEdit} editor={editor} onGoBack={goToCall} registerField={registerField} />
            ))}
          </ol>
        </section>
      )}
      {hover && (
        <div className="or-fn-hover" role="tooltip" style={{ left: hover.x, top: hover.y + 6 }}>
          {hover.text || <em>(note vide)</em>}
        </div>
      )}
    </>
  );
}
