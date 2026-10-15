import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UploadedFile } from '@oriel/shared';
import { Client, addMember, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('SPA static serving', () => {
  let srv: TestServer;
  let web: string;

  before(async () => {
    web = mkdtempSync(path.join(os.tmpdir(), 'oriel-web-'));
    mkdirSync(path.join(web, 'assets'));
    writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Oriel SPA</title>');
    writeFileSync(path.join(web, 'assets', 'app-123.js'), 'console.log(1)');
    srv = await startTestServer({ webDist: web });
  });
  after(async () => {
    await srv.stop();
    rmSync(web, { recursive: true, force: true });
  });

  test('index, history fallback, assets and API 404', async () => {
    for (const url of ['/', '/w/abc', '/w/abc/p/def', '/share/xyz', '/invite/tok']) {
      const res = await fetch(`${srv.base}${url}`);
      assert.equal(res.status, 200, url);
      assert.match(await res.text(), /Oriel SPA/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.ok(res.headers.get('content-security-policy'));
    }
    const asset = await fetch(`${srv.base}/assets/app-123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await fetch(`${srv.base}/assets/missing.js`)).status, 404);
    const api = await fetch(`${srv.base}/api/unknown/route`);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error.code, 'not_found');
  });
});

describe('file uploads', () => {
  let srv: TestServer;
  let admin: Client;
  let viewer: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer({ maxUploadMb: 1 });
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
  });
  after(async () => {
    await srv.stop();
  });

  const upload = (c: Client, blob: Blob, name: string) => {
    const form = new FormData();
    form.append('file', blob, name);
    return fetch(`${srv.base}/api/workspaces/${wid}/files`, {
      method: 'POST',
      headers: c.cookie ? { cookie: `oriel_session=${c.cookie}` } : {},
      body: form,
    });
  };

  test('upload and serve by capability URL', async () => {
    const res = await upload(admin, new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' }), 'photo été.png');
    assert.equal(res.status, 200);
    const file = (await res.json()) as UploadedFile;
    assert.equal(file.name, 'photo été.png');
    assert.equal(file.mime, 'image/png');
    assert.equal(file.size, 7);
    assert.match(file.url, /^\/api\/files\/[a-f0-9]{32}\//);
    const got = await fetch(`${srv.base}${file.url}`); // no session needed
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.match(got.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(got.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await got.arrayBuffer()).byteLength, 7);
    const ranged = await fetch(`${srv.base}${file.url}`, { headers: { range: 'bytes=2-4' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 2-4/7');
    assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [78, 71, 1]);
  });

  test('SVG and HTML are served as attachments', async () => {
    for (const [type, name] of [
      ['image/svg+xml', 'x.svg'],
      ['text/html', 'x.html'],
    ] as const) {
      const res = await upload(admin, new Blob(['<svg onload="alert(1)"/>'], { type }), name);
      const file = (await res.json()) as UploadedFile;
      const got = await fetch(`${srv.base}${file.url}`);
      assert.match(got.headers.get('content-disposition') ?? '', /^attachment/);
    }
  });

  test('limits and permissions', async () => {
    const big = await upload(admin, new Blob([new Uint8Array(1024 * 1024 + 10)]), 'gros.bin');
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as { error: { code: string } }).error.code, 'payload_too_large');
    assert.equal((await upload(viewer, new Blob(['x']), 'a.txt')).status, 403);
    assert.equal((await upload(new Client(srv.base), new Blob(['x']), 'a.txt')).status, 401);
    assert.equal((await fetch(`${srv.base}/api/files/${'0'.repeat(32)}/x`)).status, 404);
    const avatar = await upload(admin, new Blob([new Uint8Array([1])], { type: 'image/png' }), 'a.png');
    const { url } = (await avatar.json()) as UploadedFile;
    const me = expectOk(await admin.patch('/me', { avatarUrl: url }));
    assert.equal(me.user.avatarUrl, url);
    assert.equal((await admin.patch('/me', { avatarUrl: 'javascript:alert(1)' })).status, 400);
  });
});
