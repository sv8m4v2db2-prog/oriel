// Pure rules of the Mermaid / ABC / Typst code block renders (E13, H5). The DOM part is codeRender.ts.
import { CODE_RENDER_MAX_LENGTH, CODE_VIEWS, type CodeView } from '@oriel/shared';

export { CODE_RENDER_MAX_LENGTH };

export type CodeRenderKind = 'mermaid' | 'abc' | 'typst';

/** Diagram kind of a code block language (canonical keys only), or null for an ordinary code block. */
export function codeRenderKind(language: unknown): CodeRenderKind | null {
  return language === 'mermaid' || language === 'abc' || language === 'typst' ? language : null;
}

/** View stored in the shared document is any value: unknown → both. */
export function codeView(raw: unknown): CodeView {
  return typeof raw === 'string' && (CODE_VIEWS as readonly string[]).includes(raw) ? (raw as CodeView) : 'both';
}

export function renderSourceLimit(source: string): 'ok' | 'empty' | 'too-large' {
  if (source.length > CODE_RENDER_MAX_LENGTH) return 'too-large';
  return source.trim() === '' ? 'empty' : 'ok';
}
