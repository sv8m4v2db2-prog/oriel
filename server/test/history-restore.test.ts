// Version history (G6): restores merged into the Yjs history (pure, no server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { reconcileDocument, reinsertBlock, revertBlock } from '../src/content/restore.js';

function block(id: string, text: string, children: Y.XmlElement[] = []): Y.XmlElement {
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', id);
  const paragraph = new Y.XmlElement('paragraph');
  const content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  container.insert(0, [paragraph]);
  if (children.length > 0) {
    const g = new Y.XmlElement('blockGroup');
    g.insert(0, children);
    container.insert(1, [g]);
  }
  return container;
}

const root = (doc: Y.Doc) => doc.getXmlFragment('blocknote').get(0) as Y.XmlElement;
const list = (doc: Y.Doc) => doc.getXmlFragment('blocknote').toJSON();
const copyOf = (doc: Y.Doc) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(doc));
  return d;
};
const textIn = (doc: Y.Doc, i: number) => (((root(doc).get(i) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText);

function initial(): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement('blockGroup');
  doc.getXmlFragment('blocknote').insert(0, [g]);
  g.insert(0, [block('a', 'Alpha'), block('b', 'Bravo', [block('b1', 'Enfant')]), block('c', 'Charlie')]);
  return doc;
}

test('whole restore: structure and texts back, an offline edit in an untouched block survives the merge', () => {
  const live = initial();
  const version = copyOf(live);
  live.transact(() => {
    textIn(live, 1).insert(5, ' modifié');
    root(live).delete(2, 1);
    root(live).insert(0, [block('z', 'Nouveau')]);
  });
  const offline = copyOf(live);
  const rootBefore = root(live)._item!.id;
  live.transact(() => reconcileDocument(live, version));
  assert.equal(list(live), list(version));
  assert.deepEqual(root(live)._item!.id, rootBefore, 'root group kept');
  // A client that was offline edits « Alpha » (untouched by the restore), then syncs.
  textIn(offline, 1).insert(5, ' !');
  Y.applyUpdate(live, Y.encodeStateAsUpdate(offline));
  Y.applyUpdate(offline, Y.encodeStateAsUpdate(live));
  assert.equal(list(live), list(offline));
  assert.match(list(live), /Alpha !/);
  assert.doesNotMatch(list(live), /Nouveau/);
  assert.equal((list(live).match(/id="a"/g) ?? []).length, 1, 'no duplicate');
});

test('chosen blocks: reinsert after the previous sibling with its children, revert text and type', () => {
  const live = initial();
  const version = copyOf(live);
  live.transact(() => {
    root(live).delete(1, 1); // b and its child
    textIn(live, 0).insert(0, 'X');
  });
  live.transact(() => {
    assert.equal(reinsertBlock(live, version, 'b'), 'ok');
    assert.equal(reinsertBlock(live, version, 'b'), 'exists');
    assert.equal(revertBlock(live, version, 'a'), 'ok');
    assert.equal(revertBlock(live, version, 'zz'), 'not-in-version');
  });
  assert.equal(list(live), list(version));
});

test('reinsert falls back to the next sibling, then the parent, never duplicating a surviving child', () => {
  const live = initial();
  const version = copyOf(live);
  live.transact(() => {
    // b1 moves to the top level, then b is deleted: reinserting b must not copy b1 again.
    const child = (root(live).get(1) as Y.XmlElement).get(1) as Y.XmlElement;
    child.delete(0, 1);
    root(live).insert(3, [block('b1', 'Enfant')]);
    root(live).delete(0, 2); // a, b
  });
  live.transact(() => {
    assert.equal(reinsertBlock(live, version, 'b'), 'ok');
  });
  const json = list(live);
  assert.equal((json.match(/id="b1"/g) ?? []).length, 1);
  assert.ok(json.indexOf('id="b"') < json.indexOf('id="c"'), 'before its next sibling');
});

test('formatting: a restored text gets its old marks, not its neighbours', () => {
  const live = initial();
  const version = copyOf(live);
  live.transact(() => {
    const t = textIn(live, 0);
    t.format(0, 5, { bold: true });
    t.insert(5, 'xx', { bold: true });
  });
  live.transact(() => reconcileDocument(live, version));
  assert.deepEqual(textIn(live, 0).toDelta(), textIn(version, 0).toDelta());
});
