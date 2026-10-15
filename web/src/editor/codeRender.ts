// Mermaid / ABC code block: view switch (code, preview, both) around BlockNote's code block node view.
// Plain DOM (the code block is a vanilla BlockNote block): the original node view, whose contentDOM is
// the editable code, is moved into a shell that also holds the preview. The preview follows the text
// (MutationObserver on the contentDOM, so remote Yjs edits are shown too) and the theme.
import { CODE_VIEWS, type CodeView } from '@oriel/shared';
import { themeStore } from '../lib/theme';
import { codeRenderKind, codeView, renderSourceLimit, type CodeRenderKind } from './codeRenderLogic';
import { svgElementFromText } from './svgSanitize';
import { renderDiagram } from './diagramRenderers';

type NodeViewDom = { dom: HTMLElement | DocumentFragment; contentDOM?: HTMLElement; destroy?: () => void; ignoreMutation?: unknown };
type AnyEditor = { isEditable: boolean; updateBlock: (id: string, update: unknown) => unknown };

const VIEW_LABEL: Record<CodeView, { text: string; title: string }> = {
  code: { text: 'Code', title: 'Afficher le code seul' },
  preview: { text: 'Aperçu', title: 'Afficher l’aperçu seul' },
  both: { text: 'Les deux', title: 'Afficher le code et l’aperçu côte à côte' },
};
const KIND_LABEL: Record<CodeRenderKind, string> = { mermaid: 'diagramme', abc: 'partition', typst: 'document' };
const SHADOW_CSS =
  ':host{display:block;overflow:auto}svg{display:block;max-width:100%;height:auto;margin:0 auto}' +
  '.dark svg.abc{filter:invert(.92) hue-rotate(180deg)}' +
  // Typst pages are paper: kept white (and black text) in dark mode too.
  'svg.typst{background:#fff;box-shadow:0 0 0 1px rgba(128,128,128,.35)}';
const DEBOUNCE_MS = 450;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Wraps the node view of a code block whose language is Mermaid or ABC. */
export function withCodeRender(
  rendered: NodeViewDom,
  block: { id: string; props: Record<string, unknown> },
  editor: AnyEditor,
  kind: CodeRenderKind,
): NodeViewDom {
  const contentDOM = rendered.contentDOM;
  if (!contentDOM) return rendered;
  const view = codeView(block.props.view);

  const shell = el('div', 'or-code-render');
  shell.dataset.view = view;
  shell.dataset.kind = kind;
  const bar = el('div', 'or-code-render__bar');
  bar.contentEditable = 'false';
  const code = el('div', 'or-code-render__code');
  const preview = el('div', 'or-code-render__preview');
  preview.contentEditable = 'false';
  const status = el('div', 'or-code-render__status');
  status.setAttribute('role', 'status');
  const host = el('div', 'or-code-render__host');
  preview.append(status, host);
  const root = host.attachShadow({ mode: 'closed' });
  const base = document.createElement('style');
  base.textContent = SHADOW_CSS;
  const stage = el('div', '');
  root.append(base, stage);

  // Original children: [language select (div), pre > code].
  const original = rendered.dom;
  const nodes = Array.from(original instanceof DocumentFragment ? original.childNodes : [original]);
  for (const node of nodes) {
    if (node instanceof HTMLElement && node.querySelector('select') && !node.querySelector('code')) {
      node.classList.add('or-code-render__lang');
      bar.appendChild(node);
    } else code.appendChild(node);
  }
  const caption = el('span', 'or-code-render__kind', `Aperçu ${KIND_LABEL[kind]}`);
  bar.appendChild(caption);
  const group = el('div', 'or-code-render__views');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Affichage du bloc');
  const buttons = new Map<CodeView, HTMLButtonElement>();
  for (const v of CODE_VIEWS) {
    const b = el('button', 'or-code-render__view', VIEW_LABEL[v].text);
    b.type = 'button';
    b.title = VIEW_LABEL[v].title;
    b.setAttribute('aria-pressed', String(v === view));
    // Keep the editor selection: the button must not take the focus.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (!editor.isEditable || v === view) return;
      try {
        editor.updateBlock(block.id, { props: { view: v } });
      } catch {
        /* block removed meanwhile */
      }
    });
    buttons.set(v, b);
    group.appendChild(b);
  }
  if (editor.isEditable) bar.appendChild(group);
  shell.append(bar, el('div', 'or-code-render__body'));
  shell.lastElementChild!.append(code, preview);

  // --- preview ---------------------------------------------------------------------------
  let destroyed = false;
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shownSource: string | null = null;
  let shownDark: boolean | null = null;

  const setStatus = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('or-code-render__status--error', error);
    status.style.display = text ? '' : 'none';
  };
  setStatus('');

  const run = async () => {
    timer = null;
    if (destroyed || view === 'code') return;
    const source = contentDOM.textContent ?? '';
    const dark = themeStore.get().resolved === 'dark';
    if (source === shownSource && dark === shownDark) return;
    const limit = renderSourceLimit(source);
    if (limit !== 'ok') {
      stage.replaceChildren();
      shownSource = null;
      setStatus(limit === 'empty' ? 'Saisissez du code pour voir l’aperçu.' : 'Le code est trop long pour être affiché (20 000 caractères au plus).', limit === 'too-large');
      return;
    }
    const mine = ++token;
    const result = await renderDiagram(kind, source, dark);
    if (destroyed || mine !== token) return;
    shownSource = source;
    shownDark = dark;
    if (!result.ok) {
      // Keep the last good render visible next to the error: the code is being typed.
      setStatus(result.error, true);
      return;
    }
    const children: Node[] = [];
    for (const svg of result.svgs) {
      const node = svgElementFromText(svg);
      if (node) {
        if (kind === 'abc' || kind === 'typst') node.classList.add(kind);
        children.push(node);
      }
    }
    stage.className = dark ? 'dark' : '';
    stage.replaceChildren(...children);
    setStatus(children.length ? '' : 'Le rendu n’a pas pu être affiché.', children.length === 0);
  };
  const schedule = (delay = DEBOUNCE_MS) => {
    if (destroyed || view === 'code') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  };

  const observer = new MutationObserver(() => schedule());
  observer.observe(contentDOM, { characterData: true, childList: true, subtree: true });
  const unsubscribeTheme = themeStore.subscribe(() => schedule(0));
  schedule(0);

  return {
    dom: shell,
    contentDOM,
    // Changes of the toolbar and of the preview are not edits: without this, ProseMirror would re-read
    // the whole node (and re-create this view, hence render again) after every preview update.
    ignoreMutation: (mutation: { type: string; target: Node }) => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
    destroy: () => {
      destroyed = true;
      token++;
      if (timer) clearTimeout(timer);
      observer.disconnect();
      unsubscribeTheme();
      rendered.destroy?.();
    },
  };
}

export { codeRenderKind };
