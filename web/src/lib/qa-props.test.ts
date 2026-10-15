/// <reference types="node" />
// QA-WEB-08 — block / inline-content props come from the shared Yjs document: an editor can store an
// object where a string is expected (verified: the server stores { date: { y: 2026 } } on a date
// mention and serves it to anonymous readers of the published page). Rendered as a React child, the
// object throws and the whole page editor is replaced by an error. Renderers coerce through these.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { propNumber, propString } from './props';

describe('QA-WEB-08: props of the shared document are coerced before rendering', () => {
  test('strings', () => {
    assert.equal(propString('💡'), '💡');
    for (const v of [{ y: 2026 }, ['a'], 42, true, null, undefined]) assert.equal(propString(v), '', JSON.stringify(v));
  });

  test('numbers', () => {
    assert.equal(propNumber(480), 480);
    for (const v of ['480', {}, NaN, Infinity, null]) assert.equal(propNumber(v), 0, String(v));
    assert.equal(propNumber('x', 640), 640);
  });
});
