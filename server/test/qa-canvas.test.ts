// QA (security review) of canvas pages (vague H, H1): a canvas is a page whose Yjs document holds
// one Y.Map `canvas` of plain JSON objects. Each test reproduces a suspected flaw: forged updates on
// /collab, rights (viewer, private, public, trash), layout tampering, duplication and restoration.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { CANVAS_LIMITS, CANVAS_ROOT, type Page, type SearchResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { checkCanvasUpdate } from '../src/canvas/guard.js';
import type { AppContext } from '../src/context.js';

const opened: Array<{ close(): void }> = [];

interface Peer {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  failed: string | null;
  readOnly: boolean;
  close(): void;
}

async function connect(wsBase: string, pageId: string, cookie: string | null): Promise<Peer> {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const state = { failed: null as string | null, readOnly: false };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `page:${pageId}`,
    document: doc,
    token: 'session',
    onAuthenticated: ({ scope }) => {
      state.readOnly = scope === 'readonly';
    },
    onAuthenticationFailed: ({ reason }) => {
      state.failed = reason || 'denied';
    },
  });
  provider.attach();
  const peer: Peer = {
    doc,
    provider,
    get failed() {
      return state.failed;
    },
    get readOnly() {
      return state.readOnly;
    },
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
  opened.push(peer);
  await waitFor(() => provider.isSynced || state.failed, 5000, 'collab sync');
  return peer;
}

/** Raw Hocuspocus client: sends a forged update and reports whether the server applied it. */
class Raw {
  readonly saved = new Map<string, number>();
  readonly closedDocs = new Set<string>();
  readonly auths = new Map<string, string[]>();
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data as Buffer));
      const doc = decoding.readVarString(dec);
      const type = decoding.readVarUint(dec);
      if (type === 7) this.closedDocs.add(doc);
      else if (type === 8) {
        if (decoding.readVarUint(dec) === 1) this.saved.set(doc, (this.saved.get(doc) ?? 0) + 1);
      } else if (type === 2) {
        const sub = decoding.readVarUint(dec);
        const list = this.auths.get(doc) ?? [];
        list.push(sub === 2 ? `authenticated:${decoding.readVarString(dec)}` : 'denied');
        this.auths.set(doc, list);
      }
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  static open(wsBase: string, cookie: string | null): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/collab`, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
      ws.on('open', () => {
        const raw = new Raw(ws);
        opened.push(raw);
        resolve(raw);
      });
      ws.on('error', reject);
    });
  }

  async auth(pageId: string): Promise<string> {
    const doc = `page:${pageId}`;
    const before = this.auths.get(doc)?.length ?? 0;
    const e = encoding.createEncoder();
    encoding.writeVarString(e, doc);
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint(e, 0);
    encoding.writeVarString(e, 'session');
    this.ws.send(encoding.toUint8Array(e));
    await waitFor(() => (this.auths.get(doc)?.length ?? 0) > before || this.closed, 5000, 'auth reply');
    return this.auths.get(doc)?.[before] ?? 'closed';
  }

  async push(pageId: string, update: Uint8Array): Promise<'saved' | 'closed'> {
    const doc = `page:${pageId}`;
    const before = this.saved.get(doc) ?? 0;
    const e = encoding.createEncoder();
    encoding.writeVarString(e, doc);
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint8Array(e, update);
    this.ws.send(encoding.toUint8Array(e));
    await waitFor(() => (this.saved.get(doc) ?? 0) > before || this.closedDocs.has(doc) || this.closed, 5000, 'update verdict');
    return this.closedDocs.has(doc) || this.closed ? 'closed' : 'saved';
  }

  close(): void {
    this.ws.close();
  }
}

let seq = 0;
const z = () => `a${(seq++).toString(36).padStart(4, '0')}`;
const shape = (id: string, text = '') => ({
  id,
  type: 'shape',
  x: 10,
  y: 20,
  w: 120,
  h: 80,
  z: z(),
  shape: 'rect',
  fill: 'blue',
  stroke: 'default',
  strokeWidth: 2,
  dash: 'solid',
  text,
  fontSize: 'm',
  textColor: 'default',
});

describe('QA canevas', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;
  let viewer: Client;
  let member: Client;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    const a = await setupAdmin(srv.base);
    admin = a.admin;
    wid = a.wid;
    viewer = (await addMember(admin, wid, 'vera@oriel.test', 'Vera', 'viewer')).client;
    member = (await addMember(admin, wid, 'max@oriel.test', 'Max', 'member')).client;
  });
  after(async () => {
    for (const c of opened.splice(0)) {
      try {
        c.close();
      } catch {
        /* closed */
      }
    }
    await srv.stop();
  });

  const storedText = (pageId: string) => ctx.db.get<{ text: string }>('SELECT text FROM documents WHERE page_id = ?', pageId)?.text ?? '';
  const storedState = (pageId: string) => ctx.db.get<{ state: Uint8Array }>('SELECT state FROM documents WHERE page_id = ?', pageId)?.state ?? null;
  const canvas = (title = 'Canevas') => createPage(admin, wid, { title, layout: 'canvas' });
  /** Update of a doc in sync with the server's live document, after `change`. */
  const forge = (peer: Peer, change: (doc: Y.Doc, map: Y.Map<unknown>) => void): Uint8Array => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(peer.doc));
    const before = Y.encodeStateVector(copy);
    change(copy, copy.getMap(CANVAS_ROOT));
    return Y.encodeStateAsUpdate(copy, before);
  };
  const editor = async (pageId: string, cookie = admin.cookie) => {
    const raw = await Raw.open(srv.wsBase, cookie);
    assert.equal(await raw.auth(pageId), 'authenticated:read-write');
    return raw;
  };

  test('creation: a canvas is a page with format.layout fixed at creation; never a database or a row', async () => {
    const page = await canvas();
    assert.equal(page.kind, 'page');
    assert.equal(page.format.layout, 'canvas');
    assert.equal(page.icon, '🎨');
    // PATCH cannot add or remove the layout (unknown format key is ignored).
    const patched = expectOk(await admin.patch<Page>(`/pages/${page.id}`, { format: { layout: null, fullWidth: true } }));
    assert.equal(patched.format.layout, 'canvas');
    const plain = await createPage(admin, wid, { title: 'Doc' });
    const forced = expectOk(await admin.patch<Page>(`/pages/${plain.id}`, { format: { layout: 'canvas' } }));
    assert.equal(forced.format.layout, undefined);
    // Not a database, not a row, no other layout value.
    assert.equal((await admin.post(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, kind: 'database', layout: 'canvas' })).status, 400);
    const db = await createPage(admin, wid, { title: 'Base', kind: 'database', emptyDatabase: true });
    assert.equal((await admin.post(`/workspaces/${wid}/pages`, { parentType: 'database', parentId: db.id, layout: 'canvas' })).status, 400);
    assert.equal((await admin.post(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, layout: 'board' })).status, 400);
    // A viewer cannot create one.
    const denied = (await viewer.post(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, layout: 'canvas' })).status;
    assert.ok(denied === 403 || denied === 404, `viewer creation: ${denied}`);
  });

  test('valid objects are stored, indexed for search and linked pages become backlinks', async () => {
    const page = await canvas('Storyboard');
    const target = await createPage(admin, wid, { title: 'Scénario' });
    const peer = await connect(srv.wsBase, page.id, admin.cookie);
    const map = peer.doc.getMap(CANVAS_ROOT);
    peer.doc.transact(() => {
      map.set('s1', shape('s1', 'Plan large sur la falaise'));
      map.set('p1', { id: 'p1', type: 'page', x: 0, y: 0, w: 240, h: 64, z: z(), pageId: target.id });
      map.set('m1', {
        id: 'm1',
        type: 'mindmap',
        x: 0,
        y: 300,
        w: 10,
        h: 10,
        z: z(),
        layout: 'balanced',
        style: 'classic',
        root: { id: 'r', text: 'Tournage', children: [{ id: 'c1', text: 'Repérages', children: [] }] },
      });
    });
    await waitFor(() => storedText(page.id).includes('falaise') && storedText(page.id).includes('Repérages'), 5000, 'canvas text stored');
    const search = expectOk(await admin.get<SearchResponse>(`/workspaces/${wid}/search?q=falaise`));
    assert.ok(search.results.some((r) => r.page.id === page.id), 'canvas found by its text');
    const backlinks = expectOk(await admin.get<{ pages: Array<{ id: string }> }>(`/pages/${target.id}/backlinks`));
    assert.ok(backlinks.pages.some((p) => p.id === page.id));
    peer.close();
  });

  test('forged updates are refused before reaching the document: unknown object, key ≠ id, foreign file URL, nested types, other roots, sizes', async () => {
    const page = await canvas('Hostile');
    const peer = await connect(srv.wsBase, page.id, admin.cookie);
    peer.doc.getMap(CANVAS_ROOT).set('ok', shape('ok', 'Témoin initial'));
    await waitFor(() => storedText(page.id).includes('Témoin initial'), 5000, 'first store');
    const big = 'x'.repeat(CANVAS_LIMITS.objectBytes);
    const hostile: Array<[string, (d: Y.Doc, m: Y.Map<unknown>) => void]> = [
      ['unknown type', (_d, m) => m.set('u1', { ...shape('u1'), type: 'script' })],
      ['key differs from id', (_d, m) => m.set('k1', shape('autre'))],
      ['invalid key', (_d, m) => m.set('../x', shape('../x'))],
      ['external image URL', (_d, m) => m.set('i1', { id: 'i1', type: 'image', x: 0, y: 0, w: 10, h: 10, z: z(), src: 'https://evil.test/pixel.png', name: 'x' })],
      ['javascript: file URL', (_d, m) => m.set('f1', { id: 'f1', type: 'file', x: 0, y: 0, w: 10, h: 10, z: z(), src: 'javascript:alert(1)', name: 'x', mime: 'text/plain', size: 1 })],
      ['out-of-range coordinate', (_d, m) => m.set('c1', { ...shape('c1'), x: 1e12 })],
      ['NaN-like size', (_d, m) => m.set('c2', { ...shape('c2'), w: -5 })],
      ['nested Y.Map value', (_d, m) => m.set('y1', new Y.Map())],
      ['Y.Text value', (_d, m) => m.set('y2', new Y.Text('t'))],
      ['raw string value', (_d, m) => m.set('y3', 'brut')],
      ['editor fragment on a canvas', (d) => d.getXmlFragment('blocknote').insert(0, [new Y.XmlElement('paragraph')])],
      ['another root map', (d) => d.getMap('threads').set('x', 1)],
      ['root array', (d) => d.getArray(CANVAS_ROOT + 'x').insert(0, [1])],
      [
        'oversized object (valid fields)',
        (_d, m) => {
          const points = Array.from({ length: CANVAS_LIMITS.strokeNumbers }, (_, i) => 99999.123456789 - i / 7);
          m.set('b1', { id: 'b1', type: 'stroke', x: 0, y: 0, w: 10, h: 10, z: z(), tool: 'pen', points, color: 'red', size: 4 });
        },
      ],
      ['text over the limit', (_d, m) => m.set('b2', { ...shape('b2'), text: big })],
      [
        'mind map too deep',
        (_d, m) => {
          let node: Record<string, unknown> = { id: 'n0', text: '0', children: [] };
          const root = node;
          for (let i = 1; i <= CANVAS_LIMITS.mindmapDepth + 1; i++) {
            const child = { id: `n${i}`, text: String(i), children: [] };
            (node.children as unknown[]).push(child);
            node = child;
          }
          m.set('mm', { id: 'mm', type: 'mindmap', x: 0, y: 0, w: 1, h: 1, z: z(), layout: 'right', style: 'classic', root });
        },
      ],
      [
        'too many objects',
        (d, m) =>
          d.transact(() => {
            for (let i = 0; i < CANVAS_LIMITS.objects + 1; i++) m.set(`n${i}`, { id: `n${i}`, type: 'note', x: 0, y: 0, w: 10, h: 10, z: 'a0', text: '', fill: 'yellow' });
          }),
      ],
    ];
    for (const [label, change] of hostile) {
      const raw = await editor(page.id);
      assert.equal(await raw.push(page.id, forge(peer, change)), 'closed', label);
      raw.close();
    }
    // Control: a valid object sent the same way is applied and relayed.
    const raw = await editor(page.id);
    assert.equal(await raw.push(page.id, forge(peer, (_d, m) => m.set('t2', shape('t2', 'Témoin valide')))), 'saved');
    raw.close();
    await waitFor(() => peer.doc.getMap(CANVAS_ROOT).has('t2'), 3000, 'valid update relayed');
    const keys = [...peer.doc.getMap(CANVAS_ROOT).keys()].sort();
    assert.deepEqual(keys, ['ok', 't2']);
    assert.deepEqual([...peer.doc.share.keys()].filter((k) => k !== CANVAS_ROOT && peer.doc.share.get(k)!._length > 0), []);
    peer.close();
  });

  test('the guard resolves replaced values in the same update and refuses a value replaced by a forged one', () => {
    const doc = new Y.Doc();
    const map = doc.getMap(CANVAS_ROOT);
    map.set('s', shape('s'));
    const server = new Y.Doc();
    server.getMap(CANVAS_ROOT);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      map.set('s', shape('s', 'a'));
      map.set('s', { ...shape('s'), type: 'evil' });
    });
    assert.match(checkCanvasUpdate(server, Y.encodeStateAsUpdate(doc, before)) ?? '', /objet invalide/);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(server));
    const before2 = Y.encodeStateVector(doc2);
    doc2.getMap(CANVAS_ROOT).set('s', shape('s', 'b'));
    assert.equal(checkCanvasUpdate(server, Y.encodeStateAsUpdate(doc2, before2)), null);
  });

  test('a page document cannot receive canvas objects (the page guard still applies)', async () => {
    const page = await createPage(admin, wid, { title: 'Page ordinaire' });
    const peer = await connect(srv.wsBase, page.id, admin.cookie);
    const raw = await editor(page.id);
    assert.equal(await raw.push(page.id, forge(peer, (_d, m) => m.set('s', shape('s')))), 'closed');
    raw.close();
    peer.close();
  });

  test('rights: a viewer reads only, a private canvas is invisible to others, a trashed canvas is read-only', async () => {
    const page = await canvas('Partagé');
    const viewerPeer = await connect(srv.wsBase, page.id, viewer.cookie);
    assert.equal(viewerPeer.readOnly, true);
    const raw = await Raw.open(srv.wsBase, viewer.cookie);
    assert.equal(await raw.auth(page.id), 'authenticated:readonly');
    raw.close();
    viewerPeer.close();

    const privateCanvas = expectOk(await admin.post<Page>(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, visibility: 'private', layout: 'canvas' }));
    const other = await Raw.open(srv.wsBase, member.cookie);
    assert.equal(await other.auth(privateCanvas.id), 'denied');
    other.close();
    assert.equal((await member.get(`/pages/${privateCanvas.id}`)).status, 404);

    expectOk(await admin.post(`/pages/${page.id}/trash`));
    const trashed = await Raw.open(srv.wsBase, admin.cookie);
    assert.equal(await trashed.auth(page.id), 'authenticated:readonly');
    trashed.close();
  });

  test('public canvas: anonymous visitors read without writing; unpublished stays closed', async () => {
    const page = await canvas('Moodboard public');
    const peer = await connect(srv.wsBase, page.id, admin.cookie);
    peer.doc.getMap(CANVAS_ROOT).set('s', shape('s', 'Référence'));
    await waitFor(() => storedText(page.id).includes('Référence'), 5000, 'stored');
    const anon = await Raw.open(srv.wsBase, null);
    assert.equal(await anon.auth(page.id), 'denied');
    anon.close();
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const visitor = await connect(srv.wsBase, page.id, null);
    assert.equal(visitor.failed, null);
    assert.equal(visitor.readOnly, true);
    assert.equal((visitor.doc.getMap(CANVAS_ROOT).get('s') as { text: string }).text, 'Référence');
    // Anything the visitor sends is ignored.
    visitor.doc.getMap(CANVAS_ROOT).set('pirate', shape('pirate'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(peer.doc.getMap(CANVAS_ROOT).has('pirate'), false);
    visitor.close();
    peer.close();
  });

  test('duplication keeps the canvas and points page cards at the copied sub-pages; restoring a version brings objects back', async () => {
    const page = await canvas('Plan de tournage');
    const child = expectOk(await admin.post<Page>(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: page.id, title: 'Séquence 1' }));
    const peer = await connect(srv.wsBase, page.id, admin.cookie);
    const map = peer.doc.getMap(CANVAS_ROOT);
    peer.doc.transact(() => {
      map.set('s', shape('s', 'Version un'));
      map.set('p', { id: 'p', type: 'page', x: 0, y: 0, w: 200, h: 60, z: z(), pageId: child.id });
    });
    await waitFor(() => storedText(page.id).includes('Version un'), 5000, 'stored');
    const snapshot = ctx.db.get<{ id: string }>("SELECT id FROM snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT 1", page.id);
    assert.ok(snapshot, 'a version exists');

    const copy = expectOk(await admin.post<Page>(`/pages/${page.id}/duplicate`));
    assert.equal(copy.format.layout, 'canvas');
    const copyChild = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE parent_id = ?', copy.id)!;
    const copyDoc = new Y.Doc();
    Y.applyUpdate(copyDoc, storedState(copy.id)!);
    assert.equal((copyDoc.getMap(CANVAS_ROOT).get('p') as { pageId: string }).pageId, copyChild.id);
    assert.ok(storedText(copy.id).includes('Version un'));

    // Change, then restore the version.
    map.set('s', shape('s', 'Version deux'));
    map.delete('p');
    await waitFor(() => storedText(page.id).includes('Version deux'), 5000, 'second store');
    assert.equal((await member.post(`/pages/${page.id}/snapshots/${snapshot.id}/restore`)).status, 200);
    await waitFor(() => (map.get('s') as { text?: string } | undefined)?.text === 'Version un' && map.has('p'), 5000, 'restored live');
    // A viewer cannot restore.
    assert.equal((await viewer.post(`/pages/${page.id}/snapshots/${snapshot.id}/restore`)).status, 403);
    peer.close();
  });
});
