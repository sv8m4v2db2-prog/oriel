import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';
import { extractContent } from '../src/content/ydoc.js';

test('plain text preserves editor hard breaks for search, exports and content audits', () => {
  const doc = new Y.Doc();
  try {
    const group = new Y.XmlElement('blockGroup');
    const container = new Y.XmlElement('blockContainer');
    const paragraph = new Y.XmlElement('paragraph');
    const first = new Y.XmlText(); first.insert(0, 'Ligne avant');
    const second = new Y.XmlText(); second.insert(0, 'Ligne après');
    paragraph.insert(0, [first, new Y.XmlElement('hardBreak'), second]);
    container.insert(0, [paragraph]); group.insert(0, [container]);
    doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [group]);
    assert.equal(extractContent(doc).text, 'Ligne avant\nLigne après');
  } finally { doc.destroy(); }
});
