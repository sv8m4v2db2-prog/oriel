/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareBlockCopies } from './databaseCopy';

describe('block copies (⌘D, « Dupliquer »)', () => {
  test('an inline database copy gets its own database, never the original reference', () => {
    // Regression: duplicating an inline database block made both blocks show the same database.
    let n = 0;
    const blocks = [
      { id: 'p1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Avant', styles: {} }], children: [] },
      { id: 'db1', type: 'database', props: { databaseId: 'base-a' }, children: [] },
      {
        id: 't1',
        type: 'toggleListItem',
        props: {},
        content: [],
        children: [{ id: 'db2', type: 'database', props: { databaseId: 'base-b' }, children: [] }],
      },
    ];
    const { copies, pending } = prepareBlockCopies(blocks, () => `copie-${++n}`);
    assert.deepEqual(pending, [
      { blockId: 'copie-1', sourceId: 'base-a' },
      { blockId: 'copie-2', sourceId: 'base-b' },
    ]);
    assert.equal(copies[0].id, undefined);
    assert.deepEqual(copies[0].content, blocks[0]!.content);
    assert.deepEqual(copies[1], { id: 'copie-1', type: 'database', props: { databaseId: '' }, children: [] });
    assert.equal(copies[2].id, undefined);
    assert.deepEqual(copies[2].children[0], { id: 'copie-2', type: 'database', props: { databaseId: '' }, children: [] });
    // The originals are untouched.
    assert.equal(blocks[1]!.props.databaseId, 'base-a');
  });

  test('a linked view stays a reference; an empty database block needs nothing', () => {
    const blocks = [
      { id: 'l1', type: 'linkedDatabase', props: { databaseId: 'base-a', linkId: 'lien-1' }, children: [] },
      { id: 'db0', type: 'database', props: { databaseId: '' }, children: [] },
    ];
    const { copies, pending } = prepareBlockCopies(blocks, () => 'jamais');
    assert.deepEqual(pending, []);
    assert.deepEqual(copies[0], { type: 'linkedDatabase', props: { databaseId: 'base-a', linkId: 'lien-1' }, children: [] });
    assert.deepEqual(copies[1], { type: 'database', props: { databaseId: '' }, children: [] });
  });
});
