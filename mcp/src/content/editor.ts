// Headless BlockNote editor of the MCP process (DOM provided by jsdom inside @blocknote/server-util)
// and Yjs ⇄ blocks conversions of page documents (`blocknote` XML fragment).
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { CommentMark } from '@blocknote/core/comments';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';
import { schema } from './schema.js';

/** Loose view of BlockNote blocks (custom Oriel blocks included). */
export interface Blk {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Blk[];
}

type Editor = ServerBlockNoteEditor<any, any, any>;
let instance: Editor | null = null;

/**
 * The comment mark (collab module) is part of the schema: without it, y-prosemirror would drop every
 * commented text run while reading a document.
 */
export function serverEditor(): Editor {
  instance ??= ServerBlockNoteEditor.create({ schema, _tiptapOptions: { extensions: [CommentMark] } } as never) as Editor;
  return instance;
}

/** Node and mark names of the document that the mirrored schema does not know (they would be lost). */
export function unknownNodeNames(doc: Y.Doc): string[] {
  const pm = serverEditor().editor.pmSchema;
  const unknown = new Set<string>();
  const walk = (node: unknown) => {
    if (node instanceof Y.XmlElement) {
      if (!pm.nodes[node.nodeName]) unknown.add(node.nodeName);
      node.toArray().forEach(walk);
    } else if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
        for (const mark of Object.keys(op.attributes ?? {})) if (!pm.marks[mark]) unknown.add(`marque ${mark}`);
      }
    } else if (node instanceof Y.XmlFragment) node.toArray().forEach(walk);
  };
  walk(doc.getXmlFragment(COLLAB_FRAGMENT));
  return [...unknown];
}

/** Full Yjs state of a page → blocks (+ names of nodes the schema does not know). */
export function updateToBlocks(update: Uint8Array): { blocks: Blk[]; unknown: string[] } {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const unknown = unknownNodeNames(doc);
    const blocks = serverEditor().yDocToBlocks(doc, COLLAB_FRAGMENT) as unknown as Blk[];
    return { blocks, unknown };
  } finally {
    doc.destroy();
  }
}

/** Blocks → standalone Yjs update of the `blocknote` fragment (what PUT /pages/:pid/content expects). */
export function blocksToUpdate(blocks: Blk[]): Uint8Array {
  const doc = serverEditor().blocksToYDoc(blocks as never, COLLAB_FRAGMENT);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** Removes block ids (fresh ones are generated), e.g. before appending blocks read elsewhere. */
export function stripIds(blocks: Blk[]): Blk[] {
  return blocks.map((b) => {
    const { id: _id, ...rest } = b;
    return { ...rest, children: b.children ? stripIds(b.children) : [] };
  });
}
