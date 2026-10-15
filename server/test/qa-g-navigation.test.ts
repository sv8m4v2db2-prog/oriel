// Security review, wave G (review E): navigation and teamspaces (G7). Style of qa-*.test.ts: every
// invisible resource answers 404 and never leaks a title; only workspace owners/admins turn a page
// into a teamspace (user decision, 15/10, QA-CORE-09), whatever the path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { Change, Page, ServerMessage, TeamspacesResponse, TreeResponse } from '@oriel/shared';
import { addMember, Client, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor } from './helpers.js';

async function trio(base: string) {
  const { admin, wid } = await setupAdmin(base);
  const { client: bob, user: bobUser } = await addMember(admin, wid, 'bob@oriel.test', 'Bob Membre', 'member');
  const { client: carol, user: carolUser } = await addMember(admin, wid, 'carol@oriel.test', 'Carol Membre', 'member');
  return { admin, wid, bob, bobUser, carol, carolUser };
}

const tree = async (c: Client, wid: string) => expectOk(await c.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
const directory = async (c: Client, wid: string) => expectOk(await c.get<TeamspacesResponse>(`/workspaces/${wid}/teamspaces`)).teamspaces;

test('QA-G7-01: a page of a private teamspace restored from the trash never surfaces as a teamspace of its own', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, carol, carolUser } = await trio(srv.base);
    const rh = await createPage(admin, wid, { title: 'RH', visibility: 'private' });
    expectOk(await admin.post(`/pages/${rh.id}/teamspace`, { access: 'private' }));
    expectOk(await admin.put(`/teamspaces/${rh.id}/members/${carolUser.id}`, { role: 'member' }));
    // Carol, a plain workspace member of the teamspace, files a page two levels down.
    const folder = await createPage(carol, wid, { title: 'Dossier', parentType: 'page', parentId: rh.id });
    const secret = await createPage(carol, wid, { title: 'Salaires 2027 confidentiel', parentType: 'page', parentId: folder.id });
    expectOk(await carol.post(`/pages/${secret.id}/trash`));
    expectOk(await carol.post(`/pages/${folder.id}/trash`));
    // Its parent is in the trash: the restored page needs a new place.
    const restored = expectOk(await carol.post<Page>(`/pages/${secret.id}/restore`));

    // Never listed (title, icon, owners) to someone outside the private teamspace.
    const dir = await directory(bob, wid);
    assert(!JSON.stringify(dir).includes(secret.id));
    assert(!JSON.stringify(dir).includes('Salaires'));
    assert.equal((await bob.get(`/teamspaces/${secret.id}`)).status, 404);
    assert.equal((await bob.post(`/teamspaces/${secret.id}/request`, {})).status, 404);
    assert.equal((await bob.get(`/pages/${secret.id}`)).status, 404);
    // It stays in its teamspace (not a new teamspace created by a non-admin) and readable by its members.
    assert.equal(restored.parentType, 'page');
    assert.equal(restored.parentId, rh.id);
    assert.equal(restored.visibility, 'teamspace');
    const node = (await tree(carol, wid)).find((n) => n.id === secret.id);
    assert(node && !node.isTeamspace);
    assert(!(await directory(carol, wid)).some((t) => t.id === secret.id));
    expectOk(await carol.get(`/pages/${secret.id}`));
    // Teamspace root itself in the trash: restoring the page alone is refused (no orphan root).
    const memo = await createPage(carol, wid, { title: 'Mémo RH', parentType: 'page', parentId: rh.id });
    expectOk(await carol.post(`/pages/${memo.id}/trash`));
    expectOk(await admin.post(`/pages/${rh.id}/trash`));
    assert.equal((await carol.post(`/pages/${memo.id}/restore`)).status, 409);
    assert(!JSON.stringify(await directory(bob, wid)).includes(memo.id));
  } finally {
    await srv.stop();
  }
});

test('QA-G7-02: a non-admin cannot create or dissolve a teamspace by moving, duplicating or restoring a marked page', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const production = await createPage(admin, wid, { title: 'Production', visibility: 'workspace' });
    expectOk(await admin.patch(`/pages/${production.id}`, { format: { teamspaceRoot: true } }));
    const archives = await createPage(admin, wid, { title: 'Archives', visibility: 'workspace' });
    const isTeamspace = async (id: string) => (await tree(bob, wid)).find((n) => n.id === id)?.isTeamspace === true;
    assert.equal(await isTeamspace(production.id), true);

    // Dissolving: an editor cannot move the teamspace under a page or into his private space…
    assert.equal((await bob.post(`/pages/${production.id}/move`, { parentType: 'page', parentId: archives.id })).status, 403);
    assert.equal((await bob.post(`/pages/${production.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' })).status, 403);
    assert.equal(await isTeamspace(production.id), true);
    // …but may still reorder it among the root pages.
    expectOk(await bob.post(`/pages/${production.id}/move`, { parentType: 'workspace', parentId: wid, after: archives.id }));
    assert.equal(await isTeamspace(production.id), true);

    // An admin moves it away (it becomes a plain page, marker kept, as before).
    expectOk(await admin.post(`/pages/${production.id}/move`, { parentType: 'page', parentId: archives.id }));
    assert.equal(await isTeamspace(production.id), false);
    // Creating: the copy of a marked page never carries the marker…
    const copy = expectOk(await bob.post<Page>(`/pages/${production.id}/duplicate`));
    assert.notEqual(copy.format?.teamspaceRoot, true);
    expectOk(await bob.post(`/pages/${copy.id}/move`, { parentType: 'workspace', parentId: wid }));
    assert.equal(await isTeamspace(copy.id), false);
    // …and a marked page brought back to the root by an editor arrives as a plain page.
    expectOk(await bob.post(`/pages/${production.id}/move`, { parentType: 'workspace', parentId: wid }));
    assert.equal(await isTeamspace(production.id), false);
    assert(!(await directory(bob, wid)).some((t) => t.id === production.id || t.id === copy.id));

    // Restore to the root (parent gone to the trash) by an editor: same rule.
    const studio = await createPage(admin, wid, { title: 'Studio', visibility: 'workspace' });
    expectOk(await admin.patch(`/pages/${studio.id}`, { format: { teamspaceRoot: true } }));
    expectOk(await admin.post(`/pages/${studio.id}/move`, { parentType: 'page', parentId: archives.id }));
    expectOk(await bob.post(`/pages/${studio.id}/trash`));
    expectOk(await bob.post(`/pages/${archives.id}/trash`));
    expectOk(await bob.post(`/pages/${studio.id}/restore`));
    assert.equal(await isTeamspace(studio.id), false);

    // The admin keeps the historical behaviour: moving a marked page back to the root restores the teamspace.
    const regie = await createPage(admin, wid, { title: 'Régie', visibility: 'workspace' });
    expectOk(await admin.patch(`/pages/${regie.id}`, { format: { teamspaceRoot: true } }));
    const host = await createPage(admin, wid, { title: 'Hôte', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${regie.id}/move`, { parentType: 'page', parentId: host.id }));
    expectOk(await admin.post(`/pages/${regie.id}/move`, { parentType: 'workspace', parentId: wid }));
    assert.equal(await isTeamspace(regie.id), true);

    // A member of a closed teamspace (plain workspace member) still reorders its root.
    const closed = await createPage(admin, wid, { title: 'Fermé', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${closed.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    const members = expectOk(await admin.get<Array<{ user: { id: string; email: string } }>>(`/workspaces/${wid}/members`));
    const bobId = members.find((m) => m.user.email === 'bob@oriel.test')!.user.id;
    expectOk(await admin.put(`/teamspaces/${closed.id}/members/${bobId}`, { role: 'member' }));
    expectOk(await bob.post(`/pages/${closed.id}/move`, { parentType: 'workspace', parentId: wid, after: regie.id }));
  } finally {
    await srv.stop();
  }
});

test('QA-G7-03: only workspace owners/admins make a teamspace a default one (or stop it being one)', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, bobUser } = await trio(srv.base);
    const page = await createPage(admin, wid, { title: 'Équipe Son', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${page.id}/teamspace`, { access: 'open' }));
    expectOk(await admin.put(`/teamspaces/${page.id}/members/${bobUser.id}`, { role: 'owner' }));
    // Bob, teamspace owner but plain workspace member, cannot enrol everyone (nor stop it).
    assert.equal((await bob.patch(`/teamspaces/${page.id}`, { isDefault: true })).status, 403);
    assert.equal((await directory(admin, wid)).find((t) => t.id === page.id)?.isDefault, false);
    // He still manages the rest of his teamspace.
    expectOk(await bob.patch(`/teamspaces/${page.id}`, { description: 'Recette et dessin son' }));
    expectOk(await admin.patch(`/teamspaces/${page.id}`, { isDefault: true }));
    assert.equal((await bob.patch(`/teamspaces/${page.id}`, { isDefault: false })).status, 403);
    assert.equal((await bob.patch(`/teamspaces/${page.id}`, { access: 'closed' })).status, 403);
    assert.equal((await directory(admin, wid)).find((t) => t.id === page.id)?.isDefault, true);
  } finally {
    await srv.stop();
  }
});

function connectEvents(wsBase: string, cookie: string): Promise<{ messages: ServerMessage[]; changes(): Change[]; send(m: unknown): void; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/events`, { headers: { cookie: `oriel_session=${cookie}` } });
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        messages,
        changes: () => messages.flatMap((m) => (m.type === 'changes' ? m.changes : [])),
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(),
      }),
    );
  });
}

test('QA-G7-04: invalidations of a restricted teamspace page only reach its members', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, carol, carolUser } = await trio(srv.base);
    const root = await createPage(admin, wid, { title: 'Équipe Dessin', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${root.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    expectOk(await admin.put(`/teamspaces/${root.id}/members/${carolUser.id}`, { role: 'member' }));
    const page = await createPage(admin, wid, { title: 'Plan de dessin', parentType: 'page', parentId: root.id });
    const bobEv = await connectEvents(srv.wsBase, bob.cookie!);
    const carolEv = await connectEvents(srv.wsBase, carol.cookie!);
    try {
      for (const ev of [bobEv, carolEv]) {
        ev.send({ type: 'subscribe', workspaceId: wid });
        await waitFor(() => ev.messages.find((m) => m.type === 'subscribed'));
      }
      const child = await createPage(admin, wid, { title: 'Collecte', parentType: 'page', parentId: page.id });
      expectOk(await admin.patch(`/pages/${page.id}`, { title: 'Plan de dessin v2' }));
      expectOk(await admin.post(`/pages/${child.id}/trash`));
      // Comments, databases and views of the closed teamspace go through the same audience.
      const comment = [{ type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Note', styles: {} }], children: [] }];
      expectOk(await admin.post(`/pages/${page.id}/threads`, { anchored: false, body: comment }));
      const base = await createPage(admin, wid, { kind: 'database', title: 'Archives', parentType: 'page', parentId: page.id });
      expectOk(await admin.post(`/databases/${base.id}/properties`, { property: { name: 'Caméra', type: 'text' } }));
      await waitFor(() => carolEv.changes().some((c) => c.entity === 'comments' && c.pageId === page.id));
      await waitFor(() => carolEv.changes().some((c) => c.entity === 'database' && c.id === base.id));
      // A member receives them…
      await waitFor(() => carolEv.changes().some((c) => c.entity === 'page' && c.id === page.id));
      await waitFor(() => carolEv.changes().some((c) => c.entity === 'page' && c.id === child.id));
      // …a public page change still reaches Bob (the socket works)…
      const open = await createPage(admin, wid, { title: 'Ouvert à tous', visibility: 'workspace' });
      await waitFor(() => bobEv.changes().some((c) => c.entity === 'page' && c.id === open.id));
      await sleep(50);
      // …but Bob never learns the ids (nor the activity) of the closed teamspace's pages.
      const seen = JSON.stringify(bobEv.changes());
      assert(!seen.includes(page.id), 'page id leaked to a non-member');
      assert(!seen.includes(child.id), 'child id leaked to a non-member');
      assert(!seen.includes(base.id), 'database id leaked to a non-member');
    } finally {
      bobEv.close();
      carolEv.close();
    }
  } finally {
    await srv.stop();
  }
});

test('QA-G7-05: only the teamspace owners and the workspace admins can trash a teamspace root', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, carol, carolUser } = await trio(srv.base);
    const team = await createPage(admin, wid, { title: 'Équipe Image', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${team.id}/teamspace`, { access: 'open' }));
    const page = await createPage(admin, wid, { title: 'Bilan', parentType: 'page', parentId: team.id });
    // An editor of the workspace: 403 on the root (whole teamspace), its pages stay his to trash.
    assert.equal((await bob.post(`/pages/${team.id}/trash`)).status, 403);
    expectOk(await bob.post(`/pages/${page.id}/trash`));
    // A teamspace owner who is a plain member of the workspace can.
    expectOk(await admin.put(`/teamspaces/${team.id}/members/${carolUser.id}`, { role: 'owner' }));
    expectOk(await carol.post(`/pages/${team.id}/trash`));
    expectOk(await admin.post(`/pages/${team.id}/restore`));
    // So can a workspace admin.
    expectOk(await admin.post(`/pages/${team.id}/trash`));
  } finally {
    await srv.stop();
  }
});
