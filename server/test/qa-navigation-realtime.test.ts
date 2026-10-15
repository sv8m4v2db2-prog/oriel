// Navigation module (wave G7): collaboration sockets follow teamspace membership.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { addMember, createPage, expectOk, setupAdmin, startTestServer, waitFor } from './helpers.js';

const opened: Array<() => void> = [];
after(() => opened.splice(0).forEach((close) => close()));

async function connect(wsBase: string, pageId: string, cookie: string | null) {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const state = { failed: null as string | null };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `page:${pageId}`,
    document: new Y.Doc(),
    onAuthenticationFailed: ({ reason }) => {
      state.failed = reason || 'denied';
    },
  });
  provider.attach();
  opened.push(() => {
    provider.destroy();
    socket.destroy();
  });
  await waitFor(() => provider.isSynced || state.failed, 5000, 'collab sync');
  return { provider, state };
}

test('QA-NAV-10 closed teamspace: collab refused to non-members, closed when a member leaves', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid } = await setupAdmin(srv.base);
    const { client: bob, user: bobUser } = await addMember(admin, wid, 'bob@oriel.test', 'Bob', 'member');
    const root = await createPage(admin, wid, { title: 'Fermé', visibility: 'workspace' });
    const page = await createPage(admin, wid, { title: 'Page fermée', parentType: 'page', parentId: root.id });
    // Bob is connected while the page is still shared; restricting the teamspace closes his socket.
    const early = await connect(srv.wsBase, page.id, bob.cookie);
    assert.equal(early.state.failed, null);
    expectOk(await admin.post(`/pages/${root.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    await waitFor(() => early.state.failed || !early.provider.isSynced, 5000, 'socket closed after restriction');
    const denied = await connect(srv.wsBase, page.id, bob.cookie);
    assert.notEqual(denied.state.failed, null);
    // Member: allowed; leaving closes the socket.
    expectOk(await admin.put(`/teamspaces/${root.id}/members/${bobUser.id}`, { role: 'member' }));
    const ok = await connect(srv.wsBase, page.id, bob.cookie);
    assert.equal(ok.state.failed, null);
    expectOk(await bob.post(`/teamspaces/${root.id}/leave`, {}));
    await waitFor(() => ok.state.failed || !ok.provider.isSynced, 5000, 'socket closed after leaving');
  } finally {
    await srv.stop();
  }
});
