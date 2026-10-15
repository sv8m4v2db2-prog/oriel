/// <reference types="node" />
// QA-CORE-08 — the page editor waits for the first server handshake before mounting; offline, it
// mounts after a grace period on the local (IndexedDB) copy only. An empty document that the
// server has never described is not mounted: the first keystroke would create a second root block
// group, merged later with the server's content. A refusal of the server always wins.
// QA-WEB-12 (remainder) — the API token client refuses dot segments like the other clients.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { collabEditorGate } from './collab';

const base = { denied: false, localLoaded: true, synced: false };

describe('QA-CORE-08: collabEditorGate', () => {
  test('waits for the local copy, then for the server within the grace period', () => {
    assert.equal(collabEditorGate({ ...base, localLoaded: false }, { isEmpty: false, waited: true }), 'loading');
    assert.equal(collabEditorGate(base, { isEmpty: false, waited: false }), 'loading');
    assert.equal(collabEditorGate(base, { isEmpty: true, waited: false }), 'loading');
    assert.equal(collabEditorGate({ ...base, synced: true }, { isEmpty: true, waited: false }), 'ready');
  });

  test('offline after the grace period: local copy only, never an empty unsynced document', () => {
    assert.equal(collabEditorGate(base, { isEmpty: false, waited: true }), 'ready');
    assert.equal(collabEditorGate(base, { isEmpty: true, waited: true }), 'unavailable');
  });

  test('a refusal of the server hides the local copy, whatever the other flags', () => {
    for (const synced of [false, true]) {
      for (const localLoaded of [false, true]) {
        for (const isEmpty of [false, true]) {
          assert.equal(collabEditorGate({ denied: true, localLoaded, synced }, { isEmpty, waited: true }), 'denied');
        }
      }
    }
  });
});

describe('QA-WEB-12: API token client', () => {
  test('encodes the id and refuses dot segments without any request', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { tokensApi } = await import('../mcp/api');
      await tokensApi.revoke('a/../b');
      await assert.rejects(tokensApi.revoke('..'), /Adresse de requête invalide/);
      await assert.rejects(tokensApi.revoke('.'), /Adresse de requête invalide/);
      assert.deepEqual(calls, ['/api/me/tokens/a%2F..%2Fb']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
