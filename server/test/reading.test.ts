// Page reading routes (SPEC §13): hover preview, recent activity, page customization flags.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, PageActivityResponse, PagePreviewResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';
import { makeExcerpt } from '../src/routes/reading.js';

describe('reading: preview, activity, customization', () => {
  let srv: TestServer;
  let owner: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin: owner, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(owner, wid, 'membre@oriel.test', 'Marc', 'member'));
    ({ client: viewer } = await addMember(owner, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
  });
  after(async () => {
    await srv.stop();
  });

  test('makeExcerpt collapses whitespace and cuts on a word boundary', () => {
    assert.equal(makeExcerpt('  un\n\n deux   trois '), 'un deux trois');
    const long = Array.from({ length: 200 }, (_, i) => `mot${i}`).join(' ');
    const out = makeExcerpt(long, 50);
    assert.ok(out.endsWith('…'));
    assert.ok(out.length <= 51);
  });

  test('preview returns title and icon; a private page of someone else is a plain 404', async () => {
    const shared = await createPage(owner, wid, { title: 'Plan de projet', icon: '🎬' });
    const res = expectOk(await member.get<PagePreviewResponse>(`/pages/${shared.id}/preview`));
    assert.equal(res.title, 'Plan de projet');
    assert.equal(res.icon, '🎬');
    assert.equal(res.trashed, false);

    const secret = await createPage(owner, wid, { title: 'Secret', visibility: 'private' });
    const hidden = await member.get(`/pages/${secret.id}/preview`);
    const missing = await member.get('/pages/00000000-0000-4000-8000-000000000000/preview');
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(hidden.body, missing.body, 'invisible and missing pages are indistinguishable');
    assert.equal((await member.get(`/pages/${secret.id}/activity`)).status, 404);
  });

  test('activity lists the creation, newest first, and needs authentication', async () => {
    const page = await createPage(owner, wid, { title: 'Journal' });
    const res = expectOk(await owner.get<PageActivityResponse>(`/pages/${page.id}/activity`));
    assert.equal(res.events[0]?.kind, 'created');
    assert.equal(res.events[0]?.user?.name, 'Alice Admin');
    for (let i = 1; i < res.events.length; i++) assert.ok(res.events[i - 1]!.at >= res.events[i]!.at);
    const anon = new Client(srv.base);
    assert.equal((await anon.get(`/pages/${page.id}/preview`)).status, 401);
  });

  test('customization flags are stored in the page format and need edit rights', async () => {
    const page = await createPage(owner, wid, { title: 'Réglages' });
    const updated = expectOk(
      await member.patch<Page>(`/pages/${page.id}`, { format: { hideBacklinks: true, hideComments: true, hideProperties: true, toc: false } }),
    );
    assert.equal(updated.format.hideBacklinks, true);
    assert.equal(updated.format.toc, false);
    const cleared = expectOk(await member.patch<Page>(`/pages/${page.id}`, { format: { toc: null, hideBacklinks: null } }));
    assert.equal(cleared.format.toc, undefined);
    assert.equal(cleared.format.hideBacklinks, undefined);
    assert.equal(cleared.format.hideComments, true);
    const denied = await viewer.patch(`/pages/${page.id}`, { format: { hideBacklinks: true } });
    assert.equal(denied.status, 403);
    const invalid = await member.patch(`/pages/${page.id}`, { format: { toc: 'oui' } });
    assert.equal(invalid.status, 400);
  });
});
