// Equations rendered with KaTeX (MIT, loaded on first use): display equation block, inline equation,
// click-to-edit popover with a live preview, formatting-toolbar button and the `$$…$$` input rule.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@mantine/core';
import { createReactBlockSpec, createReactInlineContentSpec, useBlockNoteEditor, useComponentsContext, useEditorState } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { Sigma } from 'lucide-react';
import { EDITOR_BLOCK_TYPES } from '@oriel/shared';
import { useEditorEnv } from './env';
import { KATEX_OPTIONS, MAX_TEX, displayMathMarkdown, inlineMathMarkdown, texRefusal } from './mathMarkdown';

type AnyEditor = BlockNoteEditor<any, any, any>;
type Katex = typeof import('katex').default;

let katexPromise: Promise<Katex> | null = null;
let katexLoaded: Katex | null = null;

export function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => {
    katexLoaded = m.default;
    return m.default;
  });
  return katexPromise;
}

/** HTML of `tex` (trusted KaTeX output, see KATEX_OPTIONS: `trust: false`, bounded size and expansions). */
function renderTex(katex: Katex, tex: string, displayMode: boolean): { html: string } | { error: string } {
  const refused = texRefusal(tex.slice(0, MAX_TEX));
  if (refused) return { error: `Formule non affichée : ${refused}.` };
  try {
    return {
      html: katex.renderToString(tex.slice(0, MAX_TEX), { ...KATEX_OPTIONS, displayMode, output: 'htmlAndMathml' }),
    };
  } catch (e) {
    // KaTeX explains the error in English, with its position: kept after a French label.
    return { error: e instanceof Error ? `Erreur de syntaxe TeX : ${e.message.replace(/^KaTeX parse error:\s*/, '')}` : 'Formule invalide' };
  }
}

/**
 * HTML export: equations exported as `$$tex$$` / `$tex$` text (toExternalHTML, also copied as plain
 * text) are replaced in `root` by KaTeX's MathML, which browsers render without any stylesheet.
 */
export async function renderExportedMath(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('[data-or-tex]');
  if (nodes.length === 0) return;
  const katex = await loadKatex();
  nodes.forEach((el) => {
    const tex = el.getAttribute('data-or-tex') ?? '';
    const display = el.getAttribute('data-or-display') === 'block';
    try {
      if (texRefusal(tex.slice(0, MAX_TEX))) throw new Error('refused');
      el.innerHTML = katex.renderToString(tex.slice(0, MAX_TEX), { ...KATEX_OPTIONS, displayMode: display, output: 'mathml' });
    } catch {
      /* invalid TeX: the source text stays */
    }
    el.removeAttribute('data-or-tex');
    el.removeAttribute('data-or-display');
  });
}

/** TeX of an exported equation element (HTML paste), or undefined. */
function parseExported(el: HTMLElement, display: boolean): { tex: string } | undefined {
  if (!el.hasAttribute('data-or-tex') || (el.getAttribute('data-or-display') === 'block') !== display) return undefined;
  return { tex: (el.getAttribute('data-or-tex') ?? '').slice(0, MAX_TEX) };
}

function useKatex(): Katex | null {
  const [k, setK] = useState<Katex | null>(katexLoaded);
  useEffect(() => {
    if (k) return;
    let alive = true;
    void loadKatex().then((m) => alive && setK(() => m));
    return () => {
      alive = false;
    };
  }, [k]);
  return k;
}

function TexRender({ tex, display, placeholder }: { tex: string; display: boolean; placeholder: string }) {
  const katex = useKatex();
  const result = useMemo(() => (katex && tex.trim() ? renderTex(katex, tex, display) : null), [katex, tex, display]);
  if (!tex.trim()) return <span className="or-math__placeholder">{placeholder}</span>;
  if (!katex) return <span className="or-math__loading">{tex}</span>;
  if (result && 'error' in result) {
    return (
      <span className="or-math__error" title={result.error}>
        {tex}
      </span>
    );
  }
  // eslint-disable-next-line react/no-danger
  return <span className="or-math__render" dangerouslySetInnerHTML={{ __html: result?.html ?? '' }} />;
}

/** Popover with a TeX field and the live preview; `onSave` receives the new source. */
function TexEditor({
  tex,
  display,
  opened,
  onClose,
  onSave,
  children,
}: {
  tex: string;
  display: boolean;
  opened: boolean;
  onClose: () => void;
  onSave: (tex: string) => void;
  children: ReactNode;
}) {
  const [value, setValue] = useState(tex);
  const katex = useKatex();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (opened) {
      setValue(tex);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [opened, tex]);
  const preview = katex && value.trim() ? renderTex(katex, value, display) : null;
  const save = () => {
    onSave(value.slice(0, MAX_TEX));
    onClose();
  };
  return (
    <Popover opened={opened} onChange={(o) => !o && onClose()} position="bottom" width={display ? 460 : 340} shadow="md" withinPortal trapFocus>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown className="or-math-editor" onMouseDown={(e) => e.stopPropagation()}>
        <textarea
          ref={ref}
          className="input or-math-editor__input"
          value={value}
          rows={display ? 4 : 2}
          spellCheck={false}
          placeholder={display ? 'E = mc^2' : 'x^2'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !display)) {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className={`or-math-editor__preview${preview && 'error' in preview ? ' is-error' : ''}`}>
          {!value.trim() ? (
            <span className="or-math__placeholder">Aperçu</span>
          ) : !preview ? (
            '…'
          ) : 'error' in preview ? (
            preview.error
          ) : (
            // eslint-disable-next-line react/no-danger
            <span dangerouslySetInnerHTML={{ __html: preview.html }} />
          )}
        </div>
        <div className="or-math-editor__actions">
          <span className="or-math-editor__hint">{display ? '⌘↵ pour valider' : '↵ pour valider'}</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={save}>
            Terminé
          </button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Display equation block
// ---------------------------------------------------------------------------

/** Blocks whose editor should open as soon as they are inserted (from the slash menu). */
export const openOnMount = new Set<string>();

/** The next empty inline equation mounted opens its editor (inserted from the slash menu). */
let openNextInline = false;
export const openNextInlineEquation = () => {
  openNextInline = true;
  setTimeout(() => (openNextInline = false), 1000);
};

function EquationView({ block, editor }: { block: { id: string; props: { tex?: unknown } }; editor: AnyEditor }) {
  const env = useEditorEnv();
  const tex = typeof block.props.tex === 'string' ? block.props.tex : '';
  const [open, setOpen] = useState(() => openOnMount.delete(block.id));
  return (
    <TexEditor
      tex={tex}
      display
      opened={open && env.canEdit}
      onClose={() => setOpen(false)}
      onSave={(next) => {
        const current = editor.getBlock(block.id);
        if (current) editor.updateBlock(current, { props: { tex: next } } as never);
      }}
    >
      <div
        className={`or-math or-math--block${env.canEdit ? ' is-editable' : ''}`}
        contentEditable={false}
        onClick={() => env.canEdit && setOpen(true)}
        role={env.canEdit ? 'button' : undefined}
        aria-label={env.canEdit ? 'Modifier l’équation' : undefined}
      >
        <TexRender tex={tex} display placeholder="Équation vide — cliquez pour écrire en TeX" />
      </div>
    </TexEditor>
  );
}

export const EquationBlock = createReactBlockSpec(
  { type: EDITOR_BLOCK_TYPES.equation, propSchema: { tex: { default: '' } }, content: 'none' },
  {
    render: ({ block, editor }) => <EquationView block={block as never} editor={editor as AnyEditor} />,
    // Source text (plain-text copy, Markdown); the HTML page export swaps it for MathML (renderExportedMath).
    toExternalHTML: ({ block }) => {
      const tex = typeof block.props.tex === 'string' ? block.props.tex : '';
      return (
        <div data-or-tex={tex} data-or-display="block">
          {displayMathMarkdown(tex)}
        </div>
      );
    },
    parse: (el) => parseExported(el, true),
  },
);

// ---------------------------------------------------------------------------
// Inline equation
// ---------------------------------------------------------------------------

function InlineEquationView({ tex, update }: { tex: string; update: (tex: string) => void }) {
  const env = useEditorEnv();
  const [open, setOpen] = useState(() => {
    if (!openNextInline || tex) return false;
    openNextInline = false;
    return true;
  });
  return (
    <TexEditor tex={tex} display={false} opened={open && env.canEdit} onClose={() => setOpen(false)} onSave={update}>
      <span className={`or-math or-math--inline${env.canEdit ? ' is-editable' : ''}`} onClick={() => env.canEdit && setOpen(true)}>
        <TexRender tex={tex} display={false} placeholder="équation" />
      </span>
    </TexEditor>
  );
}

export const InlineEquation = createReactInlineContentSpec(
  { type: EDITOR_BLOCK_TYPES.inlineEquation, propSchema: { tex: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent, updateInlineContent }) => (
      <InlineEquationView
        tex={typeof inlineContent.props.tex === 'string' ? inlineContent.props.tex : ''}
        update={(tex) => updateInlineContent({ type: EDITOR_BLOCK_TYPES.inlineEquation, props: { tex } } as never)}
      />
    ),
    toExternalHTML: ({ inlineContent }) => {
      const tex = typeof inlineContent.props.tex === 'string' ? inlineContent.props.tex : '';
      return <span data-or-tex={tex}>{inlineMathMarkdown(tex)}</span>;
    },
    parse: (el) => parseExported(el, false),
  },
);

// ---------------------------------------------------------------------------
// Formatting toolbar button: the selected text becomes an inline equation
// ---------------------------------------------------------------------------

export function InlineEquationButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor<any, any, any>();
  const text = useEditorState({ editor, selector: ({ editor: ed }) => (ed.isEditable ? ed.getSelectedText() : '') });
  if (!editor.isEditable || !text || text.includes('\n') || !('inlineEquation' in editor.schema.inlineContentSchema)) return null;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Équation"
      mainTooltip="Équation en ligne"
      icon={<Sigma size={16} />}
      onClick={() => {
        editor.focus();
        editor.insertInlineContent([{ type: EDITOR_BLOCK_TYPES.inlineEquation, props: { tex: text } }] as never);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Input rules: `$$tex$$` typed in text → inline equation; `$$` + space in an empty paragraph →
// equation block
// ---------------------------------------------------------------------------

/**
 * Registers a ProseMirror input handler on a mounted editor. The Plugin class is taken from the
 * editor's own plugins (never import prosemirror-state: a second copy breaks the editor in dev).
 */
export function registerMathInputRule(editor: AnyEditor): () => void {
  const tiptap = (editor as unknown as { _tiptapEditor?: { registerPlugin?: (p: unknown) => void; unregisterPlugin?: (p: unknown) => void } })._tiptapEditor;
  const sample = editor.prosemirrorState.plugins[0] as unknown as { constructor: new (spec: unknown) => unknown } | undefined;
  if (!tiptap?.registerPlugin || !sample || !('inlineEquation' in editor.pmSchema.nodes)) return () => undefined;
  const PluginClass = sample.constructor;
  const plugin = new PluginClass({
    props: {
      handleTextInput(view: any, from: number, to: number, text: string) {
        if (from !== to) return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        if (text === ' ' && $from.parent.type.name === 'paragraph' && $from.parent.textContent === '$$' && $from.parentOffset === 2) {
          const id = $from.depth > 1 ? $from.node(-1)?.attrs?.id : null;
          if (typeof id !== 'string' || !('equation' in editor.schema.blockSchema)) return false;
          const block = editor.getBlock(id);
          if (!block || block.children.length > 0) return false;
          openOnMount.add(id);
          editor.updateBlock(block, { type: EDITOR_BLOCK_TYPES.equation, props: { tex: '' }, content: undefined } as never);
          return true;
        }
        if (text !== '$') return false;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
        const m = /\$\$([^$￼]+)\$$/.exec(before);
        if (!m || !m[1]!.trim()) return false;
        const start = from - m[0].length;
        const node = view.state.schema.nodes.inlineEquation.create({ tex: m[1]!.trim() });
        view.dispatch(view.state.tr.replaceWith(start, to, node));
        return true;
      },
    },
  });
  tiptap.registerPlugin(plugin);
  return () => tiptap.unregisterPlugin?.(plugin);
}
