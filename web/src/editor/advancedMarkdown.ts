// Markdown export of the advanced blocks (pure, unit-tested), applied to BlockNote JSON before
// `blocksToMarkdownLossy` (page export from the top bar, workspace export):
//  - tabs: each tab becomes a level-3 heading followed by its content;
//  - breadcrumb: one line « Parent / Page » (or nothing when the path is unknown);
//  - button: interactive only, not exported (reported in `dropped`);
//  - equations: `$$…$$` / `$…$` (mathMarkdown.ts), restored by `finish` on the serialized Markdown;
//  - footnotes: `[^n]` and `[^n]: text` definitions at the end (footnoteMarkdown.ts).
import { EDITOR_BLOCK_TYPES } from '@oriel/shared';
import { encodeMathBlocks } from './mathMarkdown';
import { encodeFootnoteBlocks } from './footnoteMarkdown';

interface BlockJson {
  type?: string;
  content?: unknown;
  children?: unknown[];
  props?: Record<string, unknown>;
}

export interface AdvancedExportOptions {
  /** « A / B / C » path of the exported page, for breadcrumb blocks. */
  breadcrumb?: () => string;
  /** Collects the block types that have no Markdown form. */
  dropped?: Set<string>;
}

/** Title shown for a tab (same fallback as the tab bar). */
export function tabLabel(props: Record<string, unknown> | undefined, index: number): string {
  const t = typeof props?.title === 'string' ? props.title.trim() : '';
  return t ? t.slice(0, 120) : `Onglet ${index + 1}`;
}

const textItem = (text: string) => ({ type: 'text', text, styles: {} });

/** Advanced blocks → plain blocks (tabs flattened, breadcrumb as text, buttons dropped). */
export function flattenAdvancedBlocks<T extends BlockJson>(blocks: T[], opts: AdvancedExportOptions = {}): T[] {
  const walk = (list: T[]): T[] =>
    list.flatMap((b): T[] => {
      const children = Array.isArray(b.children) ? walk(b.children as T[]) : [];
      switch (b.type) {
        case EDITOR_BLOCK_TYPES.tabs: {
          let i = 0;
          return (Array.isArray(b.children) ? (b.children as T[]) : []).flatMap((child) => {
            if (child.type !== EDITOR_BLOCK_TYPES.tab) return walk([child]);
            const heading = { type: 'heading', props: { level: 3 }, content: [textItem(tabLabel(child.props, i++))], children: [] } as unknown as T;
            return [heading, ...walk(Array.isArray(child.children) ? (child.children as T[]) : [])];
          });
        }
        case EDITOR_BLOCK_TYPES.tab:
          return [{ type: 'heading', props: { level: 3 }, content: [textItem(tabLabel(b.props, 0))], children: [] } as unknown as T, ...children];
        case EDITOR_BLOCK_TYPES.breadcrumb: {
          const path = opts.breadcrumb?.() ?? '';
          return path ? [{ type: 'paragraph', props: {}, content: [textItem(path)], children: [] } as unknown as T, ...children] : children;
        }
        case EDITOR_BLOCK_TYPES.button:
          opts.dropped?.add(b.type);
          return children;
        default:
          return [{ ...b, children }];
      }
    });
  return walk(blocks);
}

/** Blocks ready for Markdown serialization, and `finish` to apply to the produced Markdown. */
export function prepareMarkdownExport<T extends BlockJson>(blocks: T[], opts: AdvancedExportOptions = {}): { blocks: T[]; finish: (md: string) => string } {
  const notes = encodeFootnoteBlocks(flattenAdvancedBlocks(blocks, opts));
  const math = encodeMathBlocks(notes.blocks);
  return { blocks: math.blocks, finish: (md) => notes.decode(math.decode(md)) };
}
