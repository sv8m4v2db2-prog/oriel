// DOM side of "Rechercher dans la page" (SPEC §13.1). Matches are found in the rendered text of the
// editor (so folded blocks, tables, code… are covered the same way) and highlighted with the CSS
// Custom Highlight API, which never touches the document model. Replacing goes through the editor
// (a ProseMirror transaction at the positions of the DOM range), like a user's edit.
import { findMatches, INLINE_PLACEHOLDER, runIndexAt, type Run } from './findLogic';

export interface DomMatch {
  kind: 'dom';
  range: Range;
}
export interface TitleMatch {
  kind: 'title';
  start: number;
  end: number;
}
export type FoundMatch = DomMatch | TitleMatch;

interface TextRun extends Run {
  node: Text;
}

/** Flattened text of an inline-content element; non-text inline elements count as one placeholder. */
function collect(root: Element): { text: string; runs: TextRun[] } {
  let text = '';
  const runs: TextRun[] = [];
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        if (data) {
          runs.push({ node: child as Text, start: text.length, end: text.length + data.length });
          text += data;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.tagName === 'BR') {
          text += '\n';
        } else if (el.hasAttribute('data-inline-content-type') || el.getAttribute('contenteditable') === 'false') {
          text += INLINE_PLACEHOLDER;
        } else {
          visit(el);
        }
      }
    }
  };
  visit(root);
  return { text, runs };
}

/** Matches of `query` in the editor DOM below `container` (inline content of the page's own editor only). */
export function scanEditor(container: HTMLElement, query: string, limit = 2000): DomMatch[] {
  const out: DomMatch[] = [];
  if (!query) return out;
  const editorRoot = container.querySelector('.bn-editor');
  if (!editorRoot) return out;
  for (const el of Array.from(container.querySelectorAll('.bn-inline-content'))) {
    if (out.length >= limit) break;
    // Synced blocks and other nested editors belong to another document.
    if (el.closest('.bn-editor') !== editorRoot) continue;
    const { text, runs } = collect(el);
    if (!text || runs.length === 0) continue;
    for (const m of findMatches(text, query, limit - out.length)) {
      const si = runIndexAt(runs, m.start);
      const ei = runIndexAt(runs, m.end - 1);
      if (si < 0 || ei < 0) continue;
      const range = document.createRange();
      range.setStart(runs[si]!.node, m.start - runs[si]!.start);
      range.setEnd(runs[ei]!.node, m.end - runs[ei]!.start);
      out.push({ kind: 'dom', range });
    }
  }
  return out;
}

// --- highlights -----------------------------------------------------------------------------------

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}
const registry = (): HighlightRegistry | null => {
  const css = (typeof CSS !== 'undefined' ? CSS : null) as unknown as { highlights?: HighlightRegistry } | null;
  return css?.highlights ?? null;
};
const HighlightCtor = () => (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;

export function paintHighlights(matches: FoundMatch[], current: number) {
  const reg = registry();
  const H = HighlightCtor();
  if (!reg || !H) return;
  const ranges = matches.flatMap((m, i) => (m.kind === 'dom' && i !== current ? [m.range] : []));
  reg.set('or-find', new H(...ranges));
  const cur = matches[current];
  if (cur?.kind === 'dom') reg.set('or-find-current', new H(cur.range));
  else reg.delete('or-find-current');
}

export function clearHighlights() {
  const reg = registry();
  reg?.delete('or-find');
  reg?.delete('or-find-current');
}

// --- reveal ---------------------------------------------------------------------------------------

/** Opens the folded ancestors (toggle blocks) of a node, outermost first. Returns true if one opened. */
export function revealAncestors(node: Node): boolean {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const folded: HTMLElement[] = [];
  while (el) {
    if (el.matches?.('.bn-block')) {
      // The wrapper sits inside the block's own content (not in its child group).
      const wrapper = Array.from(el.querySelectorAll<HTMLElement>('.bn-toggle-wrapper[data-show-children="false"]')).find((w) => w.closest('.bn-block') === el);
      const button = wrapper?.querySelector<HTMLElement>('.bn-toggle-button');
      if (button) folded.push(button);
    }
    el = el.parentElement;
  }
  // The deepest ancestor was collected first: open from the outermost one.
  for (const button of folded.reverse()) button.click();
  return folded.length > 0;
}

/** Brings a range into view (opening folded blocks first), centered in its scroller. */
export function scrollRangeIntoView(range: Range) {
  revealAncestors(range.startContainer);
  const el = range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer as Element) : range.startContainer.parentElement;
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
