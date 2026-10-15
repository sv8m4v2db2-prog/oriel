// HTML block: the block's own HTML, CSS and JavaScript, run on demand in a sandboxed frame.
//
// Security (docs/QA-REPORT.md, HTML block constraints): the frame loads the static bootstrap page
// HTML_FRAME_PATH, served with its own CSP (`sandbox allow-scripts`, no network, no forms), with
// sandbox="allow-scripts" only (an opaque origin: no cookies, storage, or access to this page) and no
// referrer. The page talks to it through postMessage: it checks `event.source`, accepts only `ready`
// and `resize` (0–4000 px), and sends the HTML once. Nothing runs before a click, nor for anonymous
// visitors of a published page. Sources are limited to HTML_BLOCK_MAX_LENGTH.
import { useEffect, useRef, useState } from 'react';
import { createReactBlockSpec, type DefaultReactSuggestionItem } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { Code2, Eye, EyeOff, Play, RotateCcw, Square } from 'lucide-react';
import { EDITOR_BLOCK_TYPES, HTML_BLOCK_MAX_LENGTH, HTML_FRAME_PATH } from '@oriel/shared';
import { useEditorEnv, type EditorEnv } from './env';
import {
  HTML_FRAME_INITIAL_HEIGHT,
  HTML_FRAME_SANDBOX,
  HTML_RUN_NOTICE,
  createFrameSession,
  htmlSource,
  readFrameMessage,
  sizeLabel,
} from './htmlFrameLogic';
import './advancedBlocks.css';

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = { id: string; type: string; props: Record<string, unknown> };

/**
 * Blocks inserted from the slash menu in this tab: their code editor opens right away (kept a few
 * seconds: the node view may be mounted again while the insertion is synchronized).
 */
const freshBlocks = new Set<string>();
export function markFreshHtmlBlock(blockId: string) {
  freshBlocks.add(blockId);
  setTimeout(() => freshBlocks.delete(blockId), 10_000);
}

function HtmlFrame({ html, title }: { html: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(HTML_FRAME_INITIAL_HEIGHT);
  useEffect(() => {
    const session = createFrameSession(html);
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      const message = readFrameMessage(event.source, frameWindow, event.data);
      if (!message || !frameWindow) return;
      if (message.type === 'resize') setHeight(message.height);
      else {
        const render = session.onReady();
        // Opaque origin: no target origin to name; the recipient is the frame's own window.
        if (render) frameWindow.postMessage(render, '*');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html]);
  return (
    <iframe
      ref={frameRef}
      className="or-html__frame"
      src={HTML_FRAME_PATH}
      title={title}
      sandbox={HTML_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ height }}
    />
  );
}

function HtmlView({ block, editor }: { block: AnyBlock; editor: AnyEditor }) {
  const env = useEditorEnv();
  const { html, tooLarge } = htmlSource(block.props.html);
  const anonymous = env.mode === 'public';
  const [showCode, setShowCode] = useState(() => env.canEdit && freshBlocks.has(block.id));
  const [draft, setDraft] = useState(html);
  const [run, setRun] = useState<{ id: number; html: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Remote edits replace the draft unless it is being typed.
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setDraft(html);
  }, [html]);

  const save = (value: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    typing.current = false;
    if (value.length > HTML_BLOCK_MAX_LENGTH || value === html) return;
    try {
      editor.updateBlock(block.id, { props: { html: value } } as never);
    } catch {
      /* block removed meanwhile */
    }
  };
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  if (anonymous) {
    return (
      <div className="or-media or-html or-html--off" contentEditable={false}>
        <div className="or-media__bar">
          <span className="or-media__provider">
            <Code2 size={15} /> HTML
          </span>
        </div>
        <div className="or-media__fallback">Les blocs HTML ne s’exécutent pas sur les pages publiques.</div>
      </div>
    );
  }

  const draftTooLarge = draft.length > HTML_BLOCK_MAX_LENGTH;
  const canRun = !!html && !tooLarge;
  const start = () => {
    if (showCode && env.canEdit) save(draft);
    const source = showCode && env.canEdit && !draftTooLarge ? draft : html;
    if (!source || source.length > HTML_BLOCK_MAX_LENGTH) return;
    setRun({ id: Date.now(), html: source });
  };
  const changedSinceRun = !!run && run.html !== html;

  return (
    <div className="or-media or-html" contentEditable={false}>
      <div className="or-media__bar">
        <span className="or-media__provider">
          <Code2 size={15} /> HTML
        </span>
        <span className="or-media__host">{sizeLabel((showCode ? draft : html).length)}</span>
        {(env.canEdit || html) && (
          <button
            type="button"
            className="or-media__action"
            title={showCode ? 'Masquer le code' : env.canEdit ? 'Modifier le code' : 'Voir le code'}
            onClick={() => {
              if (showCode && env.canEdit) save(draft);
              setShowCode((v) => !v);
            }}
          >
            {showCode ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        {run ? (
          <>
            <button type="button" className="or-media__action" title="Relancer" onClick={start}>
              <RotateCcw size={14} />
            </button>
            <button type="button" className="or-media__action" title="Arrêter" onClick={() => setRun(null)}>
              <Square size={14} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="or-media__action"
            title="Exécuter"
            disabled={!(canRun || (showCode && env.canEdit && draft && !draftTooLarge))}
            onClick={start}
          >
            <Play size={14} />
          </button>
        )}
      </div>
      {showCode && (
        <div className="or-html__code">
          <textarea
            className="or-html__textarea"
            value={draft}
            readOnly={!env.canEdit}
            spellCheck={false}
            placeholder={'<div class="carte">Bonjour</div>\n<style>.carte { padding: 16px; }</style>\n<script>/* … */</script>'}
            aria-label="Code HTML du bloc"
            onChange={(e) => {
              const value = e.target.value;
              typing.current = true;
              setDraft(value);
              if (saveTimer.current) clearTimeout(saveTimer.current);
              saveTimer.current = setTimeout(() => save(value), 800);
            }}
            onBlur={() => env.canEdit && save(draft)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                start();
              }
            }}
          />
          {draftTooLarge && (
            <div className="or-html__error">Code trop volumineux : {sizeLabel(draft.length)}. Il ne sera ni enregistré ni exécuté.</div>
          )}
        </div>
      )}
      {run ? (
        <>
          {changedSinceRun && <div className="or-html__notice">Le code a changé depuis l’exécution : relancez pour voir la nouvelle version.</div>}
          <HtmlFrame key={run.id} html={run.html} title="Bloc HTML" />
        </>
      ) : (
        <div className="or-html__gate">
          {tooLarge ? (
            <span>Ce bloc dépasse la taille maximale ({sizeLabel(html.length)}) : il ne peut pas être exécuté.</span>
          ) : html ? (
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={start}>
                <Play size={14} /> Exécuter le bloc HTML
              </button>
              <span className="or-media__muted">{HTML_RUN_NOTICE}</span>
            </>
          ) : (
            <span className="or-media__muted">{env.canEdit ? 'Bloc HTML vide : saisissez du code puis exécutez-le.' : 'Bloc HTML vide.'}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Slash-menu item ("Avancé" group): an empty HTML block whose code editor opens. */
export function htmlSlashItem(editor: AnyEditor, env: EditorEnv, group: string): DefaultReactSuggestionItem | null {
  if (env.mode !== 'app' || !env.canEdit) return null;
  return {
    title: 'HTML',
    subtext: 'Code HTML, CSS et JavaScript exécuté dans un cadre isolé',
    aliases: ['html', 'code html', 'iframe', 'widget', 'script', 'css', 'javascript'],
    group,
    icon: <Code2 size={18} />,
    onItemClick: () => {
      const ref = editor.getTextCursorPosition().block as { id: string; type: string; content?: unknown; children?: unknown[] };
      const empty = ref.type === 'paragraph' && Array.isArray(ref.content) && ref.content.length === 0 && !ref.children?.length;
      const block = { type: EDITOR_BLOCK_TYPES.html, props: { html: '' } } as never;
      const inserted = empty ? editor.replaceBlocks([ref.id], [block]).insertedBlocks[0] : editor.insertBlocks([block], ref.id, 'after')[0];
      if (inserted) markFreshHtmlBlock(inserted.id);
    },
  };
}

export const HtmlBlock = createReactBlockSpec(
  {
    type: EDITOR_BLOCK_TYPES.html,
    propSchema: { html: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <HtmlView block={block as AnyBlock} editor={editor as AnyEditor} />,
    // Exports and copies outside the editor: the source as a code sample, never live HTML.
    toExternalHTML: ({ block }) => (
      <pre>
        <code className="language-html">{htmlSource(block.props.html).html}</code>
      </pre>
    ),
  },
);
