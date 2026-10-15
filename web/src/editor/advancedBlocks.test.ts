/// <reference types="node" />
// HTML block frame (messages, sandbox, size) and synced block helpers. Audit constraints: see
// the security constraints recorded for these blocks in docs/QA-REPORT.md.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, HTML_BLOCK_MAX_LENGTH, HTML_FRAME_MAX_HEIGHT } from '@oriel/shared';
import { HTML_FRAME_SANDBOX, clampFrameHeight, createFrameSession, htmlSource, readFrameMessage, sizeLabel } from './htmlFrameLogic';
import { detachedCopies, isBlankDocument, syncedIdsInUpdate, syncedIdsOf } from './syncedLogic';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('HTML block frame', () => {
  const frame = { name: 'frame window' };

  test('the sandbox grants scripts only (opaque origin: never allow-same-origin)', () => {
    assert.equal(HTML_FRAME_SANDBOX, 'allow-scripts');
  });

  test('only messages from the frame window itself are read', () => {
    assert.deepEqual(readFrameMessage(frame, frame, { type: 'ready' }), { type: 'ready' });
    assert.equal(readFrameMessage({ name: 'another window' }, frame, { type: 'ready' }), null);
    assert.equal(readFrameMessage(null, frame, { type: 'ready' }), null);
    assert.equal(readFrameMessage(undefined, undefined, { type: 'ready' }), null, 'unmounted frame');
    assert.equal(readFrameMessage(null, null, { type: 'ready' }), null);
  });

  test('only `ready` and `resize` are accepted', () => {
    for (const data of [{ type: 'render', html: '<b>x</b>' }, { type: 'navigate', url: 'https://exemple.fr' }, { type: 'READY' }, 'ready', null, [], 42, { height: 10 }]) {
      assert.equal(readFrameMessage(frame, frame, data), null, JSON.stringify(data));
    }
  });

  test('resize heights are finite numbers clamped to 0–4000', () => {
    assert.deepEqual(readFrameMessage(frame, frame, { type: 'resize', height: 321.2 }), { type: 'resize', height: 322 });
    assert.deepEqual(readFrameMessage(frame, frame, { type: 'resize', height: 1e9 }), { type: 'resize', height: HTML_FRAME_MAX_HEIGHT });
    assert.deepEqual(readFrameMessage(frame, frame, { type: 'resize', height: -50 }), { type: 'resize', height: 0 });
    for (const height of ['300', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      assert.equal(readFrameMessage(frame, frame, { type: 'resize', height }), null, String(height));
    }
    assert.equal(clampFrameHeight(4000.5), 4000);
  });

  test('the HTML is sent once, in reply to the first `ready`', () => {
    const session = createFrameSession('<p>Bonjour</p>');
    assert.deepEqual(session.onReady(), { type: 'render', html: '<p>Bonjour</p>' });
    assert.equal(session.onReady(), null, 'a reloaded frame gets nothing');
    assert.equal(session.sent, true);
  });

  test('sources: strings only, 200 KB at most', () => {
    assert.deepEqual(htmlSource('<p>x</p>'), { html: '<p>x</p>', tooLarge: false });
    assert.deepEqual(htmlSource({ forged: true }), { html: '', tooLarge: false });
    assert.equal(htmlSource('x'.repeat(HTML_BLOCK_MAX_LENGTH)).tooLarge, false);
    assert.equal(htmlSource('x'.repeat(HTML_BLOCK_MAX_LENGTH + 1)).tooLarge, true);
    assert.equal(sizeLabel(14), '14 octets sur 200 Ko');
    assert.equal(sizeLabel(1536), '1,5 Ko sur 200 Ko');
  });
});

describe('synced blocks', () => {
  test('detached copies: new ids, nested synced blocks left out, forged entries ignored', () => {
    const copies = detachedCopies([
      { id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'Un', styles: {} }], children: [{ id: 'b', type: 'paragraph', content: [] }] },
      { id: 'c', type: 'syncedBlock', props: { syncedId: SID } },
      null as never,
      { id: 'd', type: 'heading', props: { level: 2 }, content: [], children: [{ id: 'e', type: 'syncedBlock', props: { syncedId: SID2 } }] },
    ]);
    assert.deepEqual(copies, [
      { type: 'paragraph', content: [{ type: 'text', text: 'Un', styles: {} }], children: [{ type: 'paragraph', content: [], children: [] }] },
      { type: 'heading', props: { level: 2 }, content: [], children: [] },
    ]);
  });

  test('ids of the synced blocks shown: valid ids only, any depth, once each', () => {
    assert.deepEqual(
      syncedIdsOf([
        { type: 'syncedBlock', props: { syncedId: SID } },
        { type: 'column', children: [{ type: 'syncedBlock', props: { syncedId: SID2 } }, { type: 'syncedBlock', props: { syncedId: SID } }] },
        { type: 'syncedBlock', props: { syncedId: '../../auth/me' } },
        { type: 'syncedBlock', props: { syncedId: SID.toUpperCase() } },
        { type: 'syncedBlock', props: { syncedId: { id: SID } } },
      ]),
      [SID, SID2],
    );
  });

  test('ids read from a page document (export)', () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    const container = (name: string, attrs: Record<string, string>) => {
      const c = new Y.XmlElement('blockContainer');
      const el = new Y.XmlElement(name);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      c.insert(0, [el]);
      return c;
    };
    group.insert(0, [container('syncedBlock', { syncedId: SID }), container('syncedBlock', { syncedId: 'forged' }), container('paragraph', {}), container('syncedBlock', { syncedId: SID2 })]);
    doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [group]);
    assert.deepEqual(syncedIdsInUpdate(Y.encodeStateAsUpdate(doc)), [SID, SID2]);
    assert.deepEqual(syncedIdsInUpdate(new Uint8Array([1, 2, 3])), [], 'unreadable update');
  });

  test('blank documents', () => {
    assert.equal(isBlankDocument([]), true);
    assert.equal(isBlankDocument([{ type: 'paragraph', content: [], children: [] }]), true);
    assert.equal(isBlankDocument([{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]), false);
    assert.equal(isBlankDocument([{ type: 'heading', content: [] }]), false);
  });
});
