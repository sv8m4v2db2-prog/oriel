// Mounted editors by page id (title → editor focus, export from the top bar).
import { createStore } from '../lib/store';
import { downloadText, safeFilename } from '../lib/util';
import type { OrielEditor } from './schema';
import { flattenAdvancedBlocks, prepareMarkdownExport } from './advancedMarkdown';
import { breadcrumbText } from './layoutBlocks';
import { toast } from '../lib/ui';

const editors = new Map<string, OrielEditor>();
/** Bumped when the set of mounted editors changes (so menus can enable/disable exports). */
export const editorsVersion = createStore(0);

export function registerEditor(pageId: string, editor: OrielEditor) {
  editors.set(pageId, editor);
  editorsVersion.set((v) => v + 1);
  return () => {
    if (editors.get(pageId) === editor) {
      editors.delete(pageId);
      editorsVersion.set((v) => v + 1);
    }
  };
}

export const getEditor = (pageId: string) => editors.get(pageId);

export function focusEditorStart(pageId: string): boolean {
  const editor = editors.get(pageId);
  if (!editor) return false;
  const first = editor.document[0];
  try {
    if (first) editor.setTextCursorPosition(first, 'start');
  } catch {
    /* first block has no text */
  }
  editor.focus();
  return true;
}

export type PageExportFormat = 'md' | 'html' | 'png';

export function exportPage(pageId: string, title: string, icon: string | null, format: PageExportFormat): boolean {
  const editor = editors.get(pageId);
  if (!editor) return false;
  const heading = `${icon ? `${icon} ` : ''}${title || 'Sans titre'}`;
  // Tabs as headings, breadcrumb as text, equations as `$$…$$` / MathML (advancedMarkdown.ts).
  const options = { breadcrumb: () => breadcrumbText(pageId) };
  if (format === 'md') {
    const prepared = prepareMarkdownExport(editor.document, options);
    const body = prepared.finish(editor.blocksToMarkdownLossy(prepared.blocks as never));
    downloadText(safeFilename(title, 'md'), `# ${heading}\n\n${body}`, 'text/markdown');
  } else {
    void exportRendered(editor, flattenAdvancedBlocks(editor.document, options), title, heading, format).catch((e: unknown) => {
      console.error('[Oriel] export de page', e);
      toast.error(e instanceof Error && e.message ? e.message : 'L’export a échoué.');
    });
  }
  return true;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Standalone HTML or PNG (io/pageExport.ts, loaded on demand). */
async function exportRendered(editor: OrielEditor, blocks: unknown[], title: string, heading: string, format: 'html' | 'png') {
  const [{ buildPageFromHtml, renderPng }, { renderDiagram }] = await Promise.all([import('../io/pageExport'), import('./diagramRenderers')]);
  const html = await htmlWithMath(editor.blocksToHTMLLossy(blocks as never));
  const page = await buildPageFromHtml(html, {
    title,
    heading,
    forImage: format === 'png',
    renderDiagram: (kind, source) => renderDiagram(kind, source, false),
  });
  if (format === 'html') downloadText(safeFilename(title, 'html'), page.html, 'text/html');
  else downloadBlob(safeFilename(title, 'png'), await renderPng(page));
  if (page.warnings.length) toast(page.warnings.join(' '));
}

/** Exported HTML with its equations rendered as MathML (KaTeX loaded on demand). */
async function htmlWithMath(body: string): Promise<string> {
  if (!body.includes('data-or-tex')) return body;
  try {
    const template = document.createElement('template');
    template.innerHTML = body;
    const { renderExportedMath } = await import('./math');
    await renderExportedMath(template.content);
    const wrap = document.createElement('div');
    wrap.append(template.content);
    return wrap.innerHTML;
  } catch {
    return body;
  }
}
