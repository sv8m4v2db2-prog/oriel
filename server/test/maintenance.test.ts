import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import { newId } from '@oriel/shared';
import { resolveConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { EventBus } from '../src/realtime/events.js';
import { noopCollab, type AppContext } from '../src/context.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { createWorkspace } from '../src/services/workspaces.js';
import { createPage, trashPage } from '../src/services/pages.js';
import { runMaintenance } from '../src/jobs.js';
import { extractFromState } from '../src/content/ydoc.js';
import { buildFtsQuery } from '../src/services/search.js';
import { Client, createPage as createPageHttp, expectOk, setupAdmin, startTestServer, waitFor } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('maintenance job', () => {
  test('purges old trash, expired sessions and snapshots', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oriel-jobs-'));
    const config = resolveConfig({ dataDir: dir });
    const db = openDatabase(config.dbFile);
    const ctx: AppContext = { db, config, bus: new EventBus(db, 10, () => true), collab: noopCollab, authLimiter: new RateLimiter(10, 60_000) };
    try {
      const uid = newId();
      const now = Date.now();
      db.run("INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, 'u@x.test', 'U', 'x', ?, ?)", uid, now, now);
      const ws = createWorkspace(ctx, uid, 'W', null, { welcomePage: true });
      const old = createPage(ctx, uid, ws.id, { parentType: 'workspace', parentId: ws.id, title: 'Ancienne' });
      const oldChild = createPage(ctx, uid, ws.id, { parentType: 'page', parentId: old.id, kind: 'database', title: 'Base' });
      const recent = createPage(ctx, uid, ws.id, { parentType: 'workspace', parentId: ws.id, title: 'Récente' });
      trashPage(ctx, uid, old.id);
      trashPage(ctx, uid, recent.id);
      db.run('UPDATE pages SET trashed_at = ? WHERE trashed_at IS NOT NULL AND id != ?', now - 31 * DAY, recent.id);
      db.run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', ?, ?, ?)", uid, now - 40 * DAY, now - DAY);
      db.run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s2', ?, ?, ?)", uid, now, now + DAY);
      const snap = (reason: string, age: number) =>
        db.run('INSERT INTO snapshots (id, page_id, state, created_at, reason) VALUES (?, ?, ?, ?, ?)', newId(), recent.id, new Uint8Array([0]), now - age, reason);
      snap('auto', 31 * DAY);
      snap('auto', DAY);
      snap('daily', 100 * DAY);
      snap('daily', 400 * DAY);
      snap('before-restore', 91 * DAY);
      snap('restore', 31 * DAY); // restore checkpoints are kept 90 days (G6)

      const result = runMaintenance(ctx, now);
      assert.ok(result.pages >= 5, `purged ${result.pages}`); // page + database + 3 rows
      assert.equal(db.get('SELECT 1 AS x FROM pages WHERE id = ?', old.id), undefined);
      assert.equal(db.get('SELECT 1 AS x FROM pages WHERE id = ?', oldChild.id), undefined);
      assert.equal(db.get('SELECT 1 AS x FROM databases WHERE page_id = ?', oldChild.id), undefined);
      assert.ok(db.get('SELECT 1 AS x FROM pages WHERE id = ?', recent.id), 'recent trash kept');
      assert.equal(result.sessions, 1);
      assert.equal(result.snapshots, 3);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM snapshots')!.n, 3);
    } finally {
      ctx.bus.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('content helpers', () => {
  test('text extraction walks nested blocks, tables and inline mentions', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('blocknote');
    const group = new Y.XmlElement('blockGroup');
    frag.insert(0, [group]);
    const container = (children: Array<Y.XmlElement>) => {
      const c = new Y.XmlElement('blockContainer');
      c.insert(0, children);
      return c;
    };
    const para = (text: string, extra: Y.XmlElement[] = []) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      p.insert(0, [t, ...extra]);
      return p;
    };
    const mention = new Y.XmlElement('pageMention');
    mention.setAttribute('pageId', 'page-123');
    const nested = new Y.XmlElement('blockGroup');
    nested.insert(0, [container([para('Enfant')])]);
    const sub = new Y.XmlElement('subpage');
    sub.setAttribute('pageId', 'page-456');
    const inlineDb = new Y.XmlElement('database');
    inlineDb.setAttribute('databaseId', 'db-789');
    group.insert(0, [container([para('Parent ', [mention]), nested]), container([sub]), container([inlineDb])]);
    const bold = new Y.XmlText();
    bold.insert(0, 'gras', { bold: true });
    group.insert(group.length, [container([(() => {
      const p = new Y.XmlElement('heading');
      p.setAttribute('level', '1');
      p.insert(0, [bold]);
      return p;
    })()])]);
    const { text, links } = extractFromState(Y.encodeStateAsUpdate(doc));
    assert.equal(text, 'Parent\nEnfant\ngras');
    assert.deepEqual(links.sort(), ['db-789', 'page-123', 'page-456']);
  });

  test('FTS query builder quotes every term', () => {
    assert.equal(buildFtsQuery('  '), null);
    assert.equal(buildFtsQuery('***'), null);
    assert.equal(buildFtsQuery('été "NEAR" OR'), '"été"* "NEAR"* "OR"*');
  });
});

describe('workspaces lifecycle and graceful shutdown', () => {
  test('create, rename, delete a workspace', async () => {
    const srv = await startTestServer();
    try {
      const { admin } = await setupAdmin(srv.base);
      const ws = expectOk(await admin.post('/workspaces', { name: 'Équipe', icon: '🧊' }));
      assert.equal(ws.role, 'owner');
      assert.equal(ws.icon, '🧊');
      const renamed = expectOk(await admin.patch(`/workspaces/${ws.id}`, { name: 'Équipe Alpha' }));
      assert.equal(renamed.name, 'Équipe Alpha');
      assert.equal(renamed.version, 2);
      const list = expectOk(await admin.get('/workspaces'));
      assert.equal(list.length, 2);
      const page = await createPageHttp(admin, ws.id, { title: 'À supprimer' });
      expectOk(await admin.del(`/workspaces/${ws.id}`));
      assert.equal((await admin.get(`/workspaces/${ws.id}`)).status, 404);
      assert.equal((await admin.get(`/pages/${page.id}`)).status, 404);
      assert.equal(expectOk(await admin.get('/workspaces')).length, 1);
    } finally {
      await srv.stop();
    }
  });

  test('pending collaborative edits are flushed on shutdown', async () => {
    const srv = await startTestServer({ collabDebounceMs: 60_000, collabMaxDebounceMs: 120_000 });
    let stopped = false;
    try {
      const { admin, wid } = await setupAdmin(srv.base);
      const page = await createPageHttp(admin, wid, { title: 'Brouillon' });
      const cookie = admin.cookie!;
      class CookieWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, { headers: { cookie: `oriel_session=${cookie}` } });
        }
      }
      const socket = new HocuspocusProviderWebsocket({ url: `${srv.wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({ websocketProvider: socket, name: `page:${page.id}`, document: doc });
      provider.attach();
      await waitFor(() => provider.isSynced);
      const t = new Y.XmlText();
      t.insert(0, 'Non encore enregistré');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [t]);
      const c = new Y.XmlElement('blockContainer');
      c.insert(0, [p]);
      const g = new Y.XmlElement('blockGroup');
      g.insert(0, [c]);
      doc.getXmlFragment('blocknote').insert(0, [g]);
      await waitFor(() => !provider.hasUnsyncedChanges, 5000, 'update acknowledged');
      await srv.server.close();
      stopped = true;
      provider.destroy();
      socket.destroy();
      const db = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'), { readOnly: true });
      const row = db.prepare('SELECT text FROM documents WHERE page_id = ?').get(page.id) as { text: string } | undefined;
      db.close();
      assert.equal(row?.text, 'Non encore enregistré');
    } finally {
      if (!stopped) await srv.server.close();
      rmSync(srv.dataDir, { recursive: true, force: true });
    }
  });

  test('client sees 401 on invalid session cookie', async () => {
    const srv = await startTestServer();
    try {
      const c = new Client(srv.base);
      c.cookie = 'not-a-valid-token';
      assert.equal((await c.get('/auth/me')).status, 401);
    } finally {
      await srv.stop();
    }
  });
});
