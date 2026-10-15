// BlockNote schema of the MCP process: a mirror of the web editor schema (web/src/editor/schema.ts)
// built with DOM-free specs. Type names, prop names and prop defaults MUST stay identical to the web
// ones so that documents round-trip through the MCP without losing nodes or attributes
// (test/schema-mirror.test.ts parses the web sources and fails when this mirror drifts).
import {
  BlockNoteSchema,
  createBlockSpec,
  createCodeBlockSpec,
  createHeadingBlockSpec,
  createImageBlockSpec,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from '@blocknote/core';
import { withMultiColumn } from '@blocknote/xl-multi-column';
import { COLLAB_TYPES, EDITOR_BLOCK_TYPES, EDITOR_TYPES } from '@oriel/shared';

type PropDefault = string | number | boolean;

export interface MirroredSpec {
  props: Record<string, PropDefault>;
  content: 'none' | 'inline';
}

/** Custom blocks of the web schema (editor, database and media modules). */
export const CUSTOM_BLOCKS = {
  [EDITOR_TYPES.subpage]: { props: { pageId: '' }, content: 'none' },
  [EDITOR_TYPES.pageLink]: { props: { pageId: '' }, content: 'none' },
  [EDITOR_TYPES.database]: { props: { databaseId: '' }, content: 'none' },
  [EDITOR_TYPES.callout]: { props: { emoji: '💡', backgroundColor: 'default' }, content: 'inline' },
  [EDITOR_TYPES.toc]: { props: {}, content: 'none' },
  [EDITOR_BLOCK_TYPES.embed]: { props: { url: '', provider: 'generic', height: 0 }, content: 'none' },
  [EDITOR_BLOCK_TYPES.bookmark]: { props: { url: '', title: '', description: '', image: '', favicon: '' }, content: 'none' },
  [EDITOR_BLOCK_TYPES.pdf]: { props: { url: '', name: '', height: 640 }, content: 'none' },
  [EDITOR_TYPES.linkedDatabase]: { props: { databaseId: '', linkId: '' }, content: 'none' },
  // Canvas module (H1): a frame (or the whole canvas) of a canvas page, shown read-only.
  canvasFrame: { props: { pageId: '', frameId: '' }, content: 'none' },
  [EDITOR_BLOCK_TYPES.equation]: { props: { tex: '' }, content: 'none' },
  [EDITOR_BLOCK_TYPES.breadcrumb]: { props: {}, content: 'none' },
  // Tabs: a `tabs` block whose children are `tab` blocks (title in props) holding each tab's content.
  [EDITOR_BLOCK_TYPES.tabs]: { props: {}, content: 'none' },
  [EDITOR_BLOCK_TYPES.tab]: { props: { title: 'Onglet' }, content: 'none' },
  // Content in the Yjs document `synced:<syncedId>` (never in the page document).
  [EDITOR_BLOCK_TYPES.syncedBlock]: { props: { syncedId: '' }, content: 'none' },
  [EDITOR_BLOCK_TYPES.html]: { props: { html: '' }, content: 'none' },
  // Freehand sketch: bounded JSON strokes (web/src/editor/drawingLogic.ts).
  [EDITOR_BLOCK_TYPES.drawing]: { props: { strokes: '[]' }, content: 'none' },
  // `actions`: JSON text of ButtonAction[] (always read through parseButtonActions).
  [EDITOR_BLOCK_TYPES.button]: { props: { label: 'Nouveau bouton', icon: '', actions: '[]' }, content: 'none' },
} as const satisfies Record<string, MirroredSpec>;

/** Custom inline content of the web schema (page mentions; person and date mentions of the collab module; inline equations; footnotes). */
export const CUSTOM_INLINE = {
  [EDITOR_TYPES.pageMention]: { props: { pageId: '' }, content: 'none' },
  [COLLAB_TYPES.userMention]: { props: { userId: '' }, content: 'none' },
  [COLLAB_TYPES.dateMention]: { props: { date: '', reminder: false, userId: '' }, content: 'none' },
  [EDITOR_BLOCK_TYPES.inlineEquation]: { props: { tex: '' }, content: 'none' },
  // Footnote call (H5): the note text lives in the prop; numbered by the editor in document order.
  [EDITOR_BLOCK_TYPES.footnote]: { props: { note: '' }, content: 'none' },
} as const satisfies Record<string, { props: Record<string, PropDefault>; content: 'none' }>;

/** Heading levels allowed by the web schema. */
export const HEADING_LEVELS = [1, 2, 3, 4] as const;
/** Default language of code blocks in the web schema. */
export const CODE_DEFAULT_LANGUAGE = 'text';
/** Block types added by `withMultiColumn` (xl-multi-column). */
export const MULTI_COLUMN_TYPES = ['columnList', 'column'] as const;

const propSchemaOf = (props: Record<string, PropDefault>) =>
  Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { default: v }])) as Record<string, { default: PropDefault }>;

/** Placeholder DOM rendering (only used by HTML/Markdown export, which the MCP avoids for these blocks). */
function placeholder(type: string, inline: boolean) {
  const dom = document.createElement(inline ? 'span' : 'div');
  dom.setAttribute('data-oriel-type', type);
  return dom;
}

function blockSpec(type: string, spec: MirroredSpec) {
  return createBlockSpec(
    { type, propSchema: propSchemaOf(spec.props), content: spec.content },
    {
      render: () => {
        const dom = placeholder(type, false);
        if (spec.content === 'inline') {
          const contentDOM = document.createElement('div');
          dom.appendChild(contentDOM);
          return { dom, contentDOM };
        }
        return { dom };
      },
    },
  )();
}

function inlineSpec(type: string, props: Record<string, PropDefault>) {
  return createInlineContentSpec(
    { type, propSchema: propSchemaOf(props), content: 'none' },
    { render: () => ({ dom: placeholder(type, true) }) },
  );
}

/**
 * Props Oriel adds to NATIVE blocks (web/src/editor/schema.ts): `image` (non destructive crop `x,y,w,h`
 * and hyperlink, imageBlock.tsx) and `codeBlock` (`view` of Mermaid / ABC blocks). BlockNote reads the
 * attributes of a block from its config object, so the prop schema is extended in place.
 */
export const EXTENDED_NATIVE_PROPS = {
  image: { crop: '', link: '' },
  codeBlock: { view: 'both' },
} as const satisfies Record<string, Record<string, PropDefault>>;

function extendNative<S extends { config: { propSchema: object } }>(spec: S, props: Record<string, PropDefault>): S {
  Object.assign(spec.config.propSchema, propSchemaOf(props));
  return spec;
}

const customBlockSpecs = Object.fromEntries(Object.entries(CUSTOM_BLOCKS).map(([type, spec]) => [type, blockSpec(type, spec)]));
const customInlineSpecs = Object.fromEntries(Object.entries(CUSTOM_INLINE).map(([type, spec]) => [type, inlineSpec(type, spec.props)]));

export const schema = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      heading: createHeadingBlockSpec({ levels: [...HEADING_LEVELS] }),
      image: extendNative(createImageBlockSpec(), EXTENDED_NATIVE_PROPS.image),
      codeBlock: extendNative(createCodeBlockSpec({ defaultLanguage: CODE_DEFAULT_LANGUAGE }), EXTENDED_NATIVE_PROPS.codeBlock),
      ...customBlockSpecs,
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      ...customInlineSpecs,
    },
  }),
);

export type McpSchema = typeof schema;
