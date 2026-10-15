/// <reference types="node" />
// QA-WEB-12 — identifiers taken from the route or from the shared document (pageMention.pageId,
// database / linked view blocks…) were interpolated as-is into /api/... paths: a forged
// `../../auth/…` made the reader's client call another API route with their cookies.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { apiPath, isSafeApiPath, pathSegment, queryString } from './apiPath';

/** What fetch(`/api${path}`) would really request. */
const resolved = (path: string) => {
  const u = new URL(`/api${path}`, 'https://oriel.example/w/1/p/2');
  return u.pathname + u.search + u.hash;
};

describe('QA-WEB-12: dynamic path segments are encoded', () => {
  test('the bug: an unencoded id escapes its route', () => {
    const id = '../../auth/me';
    assert.equal(resolved(`/pages/${id}/content`), '/auth/me/content');
  });

  test('every interpolation stays ONE segment of the intended route', () => {
    assert.equal(apiPath`/pages/${'../../auth/me'}/content`, '/pages/..%2F..%2Fauth%2Fme/content');
    assert.equal(resolved(apiPath`/pages/${'../../auth/me'}/content`), '/api/pages/..%2F..%2Fauth%2Fme/content');
    assert.equal(apiPath`/pages/${'a?visit=1'}`, '/pages/a%3Fvisit%3D1');
    assert.equal(resolved(apiPath`/pages/${'a#x'}/threads`), '/api/pages/a%23x/threads');
    assert.equal(apiPath`/invites/${'a/b'}/accept`, '/invites/a%2Fb/accept');
    assert.equal(apiPath`/pages/${'..\\..\\auth'}`, '/pages/..%5C..%5Cauth');
    assert.equal(resolved(apiPath`/pages/${'..\\..\\auth'}`), '/api/pages/..%5C..%5Cauth');
    assert.equal(apiPath`/pages/${'.\t.'}`, '/pages/.%09.');
    assert.equal(apiPath`/pages/${'100%'}`, '/pages/100%25');
  });

  test('unicode, lone surrogates, numbers, literal parts', () => {
    assert.equal(apiPath`/x/${'été 🧊'}`, '/x/%C3%A9t%C3%A9%20%F0%9F%A7%8A');
    assert.equal(pathSegment('a\uD800b'), 'a%EF%BF%BDb'); // encodeURIComponent alone throws URIError
    assert.equal(pathSegment('\uDC00'), '%EF%BF%BD');
    assert.equal(pathSegment('a\uD800🧊\uDC00'), 'a%EF%BF%BD%F0%9F%A7%8A%EF%BF%BD'); // pair kept, lone ones replaced
    assert.equal(apiPath`/workspaces/${'w1'}/ai/briefs?limit=${30}`, '/workspaces/w1/ai/briefs?limit=30');
    assert.equal(apiPath`/pages/${'p1'}?visit=0`, '/pages/p1?visit=0');
    assert.equal(apiPath`/health`, '/health');
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal(apiPath`/pages/${uuid}/snapshots/${uuid}/restore`, `/pages/${uuid}/snapshots/${uuid}/restore`);
  });

  test('a bare `.` / `..` value cannot be encoded away: the request functions refuse it', () => {
    // The URL parser resolves %2e%2e like `..`: no encoding helps, hence isSafeApiPath.
    assert.equal(resolved('/pages/%2E%2E/content'), '/api/content');
    for (const id of ['..', '.']) {
      const path = apiPath`/pages/${id}/content`;
      assert.equal(isSafeApiPath(path), false, path);
    }
    for (const path of ['/pages/%2e%2E/x', '/pages/.%2e/x', '/pages/%2e./x', '/pages/%2E', '/a/..', '/a\\b', '/a/.\t./b', '/a/\n']) {
      assert.equal(isSafeApiPath(path), false, JSON.stringify(path));
    }
    for (const path of ['/pages/p1/content', '/pages/..%2F..%2Fauth/x', '/pages/...', '/pages/a..b', '/pages/p1?q=..', '/search?q=../x#..']) {
      assert.equal(isSafeApiPath(path), true, JSON.stringify(path));
    }
    assert.equal(isSafeApiPath('/api/files/abc/doc.pdf'), true);
    assert.equal(isSafeApiPath('/api/files/../../api/auth/me'), false);
  });

  test('the API clients encode, and refuse dot segments with a rejected promise (no fetch)', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { api, ApiError } = await import('./api');
      const { editorApi } = await import('../editor/editorApi');
      const { collabApi } = await import('../collab/api');
      const { contentApi, fetchBytes } = await import('../io/contentApi');

      await api.pages.get('../../auth/me');
      await api.databases.get('../x', 'l?1');
      await api.invites.info('../../admin/users');
      await editorApi.pageInfo('../workspaces');
      await collabApi.threads('a#b');
      await contentApi.get('a/b');
      assert.deepEqual(calls, [
        '/api/pages/..%2F..%2Fauth%2Fme',
        '/api/databases/..%2Fx?linkId=l%3F1',
        '/api/invites/..%2F..%2Fadmin%2Fusers',
        '/api/pages/..%2Fworkspaces?visit=0',
        '/api/pages/a%23b/threads',
        '/api/pages/a%2Fb/content',
      ]);

      calls.length = 0;
      const refused = [
        () => api.pages.get('..'),
        () => api.views.remove('.'),
        () => editorApi.pageInfo('..'),
        () => collabApi.deleteThread('..'),
        () => contentApi.put('..', { update: '', mode: 'append' }),
        () => fetchBytes('/api/files/../../api/auth/me'),
      ];
      for (const call of refused) {
        const pending = call(); // never a synchronous throw (it would crash an effect / a render)
        assert.ok(pending instanceof Promise);
        await assert.rejects(pending, (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === 'invalid_path');
      }
      assert.deepEqual(calls, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('query strings are built with URLSearchParams', () => {
    assert.equal(queryString({ q: 'a&b=c#d', limit: 20 }), '?q=a%26b%3Dc%23d&limit=20');
    assert.equal(queryString({ linkId: undefined, mirror: '' }), '');
    assert.equal(queryString({ linkId: null, filter: 'inbox' }), '?filter=inbox');
    assert.equal(queryString({ url: 'https://x.example/?a=1&b=2' }), '?url=https%3A%2F%2Fx.example%2F%3Fa%3D1%26b%3D2');
    assert.equal(new URL(`/api/link-preview${queryString({ url: 'https://x.example/a b+c' })}`, 'https://b.example').searchParams.get('url'), 'https://x.example/a b+c');
  });
});
