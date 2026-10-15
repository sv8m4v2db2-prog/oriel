// Map views: tile layer configuration (MAP_TILE_URL) and its public route.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapConfigResponse } from '@oriel/shared';
import { Client, expectOk, startTestServer, type TestServer } from './helpers.js';
import { OSM_TILES, parseMapTiles } from '../src/routes/databaseExtras.js';

describe('databases: map tiles', () => {
  test('default, disabled, custom and invalid tile settings', () => {
    assert.deepEqual(parseMapTiles({}), OSM_TILES);
    assert.equal(parseMapTiles({ url: 'off' }), null);
    assert.equal(parseMapTiles({ url: ' NONE ' }), null);
    assert.deepEqual(parseMapTiles({ url: 'https://tiles.example.test/{z}/{x}/{y}.png', attribution: '© Moi\n<b>', maxZoom: '17' }), {
      url: 'https://tiles.example.test/{z}/{x}/{y}.png',
      attribution: '© Moi <b>',
      maxZoom: 17,
    });
    assert.equal(parseMapTiles({ url: '/tuiles/{z}/{x}/{y}.png' })!.url, '/tuiles/{z}/{x}/{y}.png');
    assert.equal(parseMapTiles({ url: 'https://{s}.tile.example.test/{z}/{x}/{y}{r}.png' })!.attribution, '');
    for (const url of [
      'http://tiles.example.test/{z}/{x}/{y}.png', // blocked by the CSP (img-src https:)
      'https://tiles.example.test/{z}/{x}.png',
      'https://user:pw@tiles.example.test/{z}/{x}/{y}.png',
      'javascript:alert(1)//{z}/{x}/{y}',
      '//tiles.example.test/{z}/{x}/{y}.png',
      'https://tiles.example.test/{z}/{x}/{y}.png"onerror=',
      'https://tiles.example.test/{z}/{x}/{y}/{token}.png',
      `https://tiles.example.test/${'a'.repeat(500)}/{z}/{x}/{y}.png`,
    ]) {
      assert.throws(() => parseMapTiles({ url }), /MAP_TILE_URL/, url);
    }
    assert.throws(() => parseMapTiles({ maxZoom: '40' }), /MAP_TILE_MAX_ZOOM/);
  });

  describe('route', () => {
    let srv: TestServer;
    before(async () => {
      srv = await startTestServer();
    });
    after(async () => {
      await srv.stop();
    });
    test('GET /api/public/map-config answers without a session, nothing else', async () => {
      const anon = new Client(srv.base);
      const res = expectOk(await anon.get<MapConfigResponse>('/public/map-config'));
      assert.deepEqual(Object.keys(res), ['tiles']);
      assert.equal(res.tiles?.url, OSM_TILES.url);
      assert.equal((await anon.post('/public/map-config', {})).status, 404);
    });
  });
});
