/// <reference types="node" />
// QA-WEB-04 — /login?next=… is followed after sign-in (and right away for a signed-in visitor).
// "/\evil.example" passed the check: browsers read it as //evil.example. React Router 7.18 refuses
// the external navigation (it throws), so the visible effect was an error screen instead of the app.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from './next';

const BASE = 'https://oriel.example/login';

describe('QA-WEB-04: post-login destination', () => {
  test('anything that leaves the origin falls back to /', () => {
    for (const next of ['//evil.example', '/\\evil.example', '/\\/evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', 'javascript:alert(1)', ' /x', '', null]) {
      const out = safeNext(next);
      assert.equal(new URL(out, BASE).origin, 'https://oriel.example', JSON.stringify(next));
      assert.equal(out, '/', JSON.stringify(next));
    }
  });

  test('application paths are kept', () => {
    for (const next of ['/w/abc/p/def', '/w/abc/p/def?thread=t1#bloc-x', '/share/abc', '/w/abc/settings/members']) {
      assert.equal(safeNext(next), next);
    }
  });
});
