/// <reference types="node" />
// QA-WEB-07 — comment bodies are JSON stored as sent (the server checks size and depth only). A body
// with an unknown block / inline content / style, or a link without content, made BlockNote throw while
// building the comment editor: the page discussion (shown at the top of the page) and the comments panel
// render inside the page editor, so one such comment took the editor down for every reader of the page.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockNoteEditor } from '@blocknote/core';
import type { CommentThread } from '@oriel/shared';
import { commentSchema } from './comments';
import { toThreadData } from './threadStore';
import { safeCommentBody } from './commentBody';

const CRAFTED: unknown[][] = [
  [{ type: 'bookmark', props: { url: 'javascript:alert(1)' } }],
  [{ type: 'paragraph', content: [{ type: 'text', text: 'x', styles: { textColor: 'red', nope: true } }] }],
  [{ type: 'paragraph', content: [{ type: 'pageMention', props: { pageId: 'p' } }] }],
  [{ type: 'paragraph', content: [{ type: 'text', text: 42, styles: {} }] }],
  [{ type: 'paragraph', content: [{ type: 'link', href: 'https://a.example' }] }],
  [{ type: 'paragraph', content: [{ type: 'dateMention', props: { date: { y: 2026 } } }] }],
  [{ type: 'heading', props: { level: '1 onclick=alert(1)' }, content: 'Titre', children: [{ type: 'table' }] }],
  ['texte brut', 12, null],
];

function thread(body: unknown[]): CommentThread {
  return {
    id: 't1',
    pageId: 'p1',
    anchored: false,
    quote: '',
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: 0,
    updatedAt: 0,
    comments: [{ id: 'c1', threadId: 't1', userId: 'u1', body, createdAt: 0, updatedAt: 0, reactions: [] }],
  } as unknown as CommentThread;
}

/** What BlockNote's <Comment> does with a body (useCreateBlockNote({ initialContent: body })). */
const build = (body: unknown) => BlockNoteEditor.create({ schema: commentSchema, initialContent: body as never, trailingBlock: false });

describe('QA-WEB-07: comment bodies always render', () => {
  test('crafted bodies coming from the server no longer break the comment editor', () => {
    for (const body of CRAFTED) {
      const data = toThreadData(thread(body));
      assert.doesNotThrow(() => build(data.comments[0]!.body), JSON.stringify(body));
    }
  });

  test('text survives, dangerous parts do not', () => {
    const [p] = safeCommentBody([{ type: 'heading', content: [{ type: 'text', text: 'Titre', styles: { bold: true, textColor: 'red' } }] }]);
    assert.deepEqual(p, { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Titre', styles: { bold: true } }], children: [] });
    const [m] = safeCommentBody([{ type: 'paragraph', content: [{ type: 'dateMention', props: { date: {}, reminder: 'yes' } }] }]);
    assert.deepEqual(m!.content, [{ type: 'dateMention', props: { date: '', reminder: false, userId: '' } }]);
  });

  test('bodies written by the comment editor are unchanged', () => {
    const editor = build([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Bonjour ', styles: { italic: true } },
          { type: 'userMention', props: { userId: 'u2' } },
          { type: 'link', href: 'https://oriel.example', content: [{ type: 'text', text: 'lien', styles: {} }] },
          { type: 'dateMention', props: { date: '2026-10-20', reminder: true, userId: 'u1' } },
        ],
      },
      { type: 'paragraph', props: { textAlignment: 'center' }, content: 'Deuxième' },
    ]);
    const body = JSON.parse(JSON.stringify(editor.document));
    assert.deepEqual(build(safeCommentBody(body)).document, editor.document);
  });
});
