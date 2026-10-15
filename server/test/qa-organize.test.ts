// Organize module (wave H3): daily journal, workspace tags, workspace page properties, smart
// collections, « Toutes les pages », saved views, batch actions, folder items. Style of qa-*.test.ts:
// an invisible resource answers 404 and never leaks a title, a count or an id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type {
  ApplyTagsResponse,
  Collection,
  CollectionsResponse,
  FolderItemsResponse,
  JournalMonthResponse,
  JournalOpenResponse,
  Page,
  PageListResponse,
  PageOrganization,
  PageProp,
  PagesBatchResponse,
  SavedPagesView,
  SavedPagesViewsResponse,
  Tag,
  TagsResponse,
  TreeResponse,
} from '@oriel/shared';
import { addMember, Client, createPage, expectOk, setupAdmin, startTestServer } from './helpers.js';
import { migrations } from '../src/db/features/organize.js';

async function trio(base: string) {
  const { admin, wid } = await setupAdmin(base);
  const { client: bob, user: bobUser } = await addMember(admin, wid, 'bob@oriel.test', 'Bob Membre', 'member');
  const { client: viewer } = await addMember(admin, wid, 'vera@oriel.test', 'Vera Lectrice', 'viewer');
  return { admin, wid, bob, bobUser, viewer };
}

const query = async (c: Client, wid: string, body: Record<string, unknown> = {}) =>
  expectOk(await c.post<PageListResponse>(`/workspaces/${wid}/pages/query`, body));
const titles = (r: PageListResponse) => r.items.map((i) => i.title);
const newTag = async (c: Client, wid: string, name: string, color?: string) => expectOk(await c.post<Tag>(`/workspaces/${wid}/tags`, { name, color }), 201);
const setTags = async (c: Client, pid: string, tagIds: string[]) => c.put<{ tagIds: string[] }>(`/pages/${pid}/tags`, { tagIds });

test('QA-ORG-01 journal: one private page per day, idempotent, per person', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, viewer } = await trio(srv.base);
    const first = expectOk(await admin.post<JournalOpenResponse>(`/workspaces/${wid}/journal/days/2026-10-15`, {}));
    assert.equal(first.created, true);
    const again = expectOk(await admin.post<JournalOpenResponse>(`/workspaces/${wid}/journal/days/2026-10-15`, {}));
    assert.equal(again.created, false);
    assert.equal(again.pageId, first.pageId);
    // Concurrent opens of a new day converge on one page.
    const race = await Promise.all([1, 2, 3].map(() => admin.post<JournalOpenResponse>(`/workspaces/${wid}/journal/days/2026-10-16`, {})));
    assert.equal(new Set(race.map((r) => expectOk(r).pageId)).size, 1);

    const page = (expectOk(await admin.get<{ page: Page }>(`/pages/${first.pageId}`)).page);
    assert.equal(page.visibility, 'private');
    assert.equal(page.title, 'jeudi 15 octobre 2026');
    // Nested under a private « Journal » page, newest day first.
    const month = expectOk(await admin.get<JournalMonthResponse>(`/workspaces/${wid}/journal?month=2026-10`));
    assert.deepEqual(month.days.map((d) => d.day), ['2026-10-15', '2026-10-16']);
    assert(month.containerId);
    const container = (expectOk(await admin.get<{ page: Page }>(`/pages/${month.containerId}`)).page);
    assert.equal(container.title, 'Journal');
    assert.equal(page.parentId, container.id);

    // Bob sees nothing of Alice's journal, and has his own.
    assert.equal((await bob.get(`/pages/${first.pageId}`)).status, 404);
    assert.equal(expectOk(await bob.get<JournalMonthResponse>(`/workspaces/${wid}/journal?month=2026-10`)).days.length, 0);
    const bobDay = expectOk(await bob.post<JournalOpenResponse>(`/workspaces/${wid}/journal/days/2026-10-15`, {}));
    assert.notEqual(bobDay.pageId, first.pageId);

    // Validation and rights.
    for (const bad of ['2026-13-01', '2026-02-30', '1999-12-31', 'hier', '2026-10-15x']) {
      assert.equal((await admin.post(`/workspaces/${wid}/journal/days/${bad}`, {})).status, 400, bad);
    }
    assert.equal((await admin.get(`/workspaces/${wid}/journal?month=2026-1`)).status, 400);
    assert.equal((await viewer.post(`/workspaces/${wid}/journal/days/2026-10-15`, {})).status, 403);
    assert.equal((await new Client(srv.base).post(`/workspaces/${wid}/journal/days/2026-10-15`, {})).status, 401);

    // A trashed day is replaced by a new page on the next open.
    expectOk(await admin.post(`/pages/${first.pageId}/trash`, {}));
    const reopened = expectOk(await admin.post<JournalOpenResponse>(`/workspaces/${wid}/journal/days/2026-10-15`, {}));
    assert.equal(reopened.created, true);
    assert.notEqual(reopened.pageId, first.pageId);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-02 journal template reuses page templates; invisible template is refused', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const tpl = await createPage(admin, wid, { title: 'Modèle de journée' });
    expectOk(await admin.put(`/pages/${tpl.id}/template`, { isTemplate: true }));
    const priv = await createPage(admin, wid, { title: 'Modèle secret', visibility: 'private' });
    expectOk(await admin.put(`/pages/${priv.id}/template`, { isTemplate: true }));
    // A page that is not a template, and a template Bob cannot see: refused, 404 either way.
    assert.equal((await admin.put(`/workspaces/${wid}/journal/settings`, { templateId: (await createPage(admin, wid, { title: 'Simple' })).id })).status, 404);
    assert.equal((await bob.put(`/workspaces/${wid}/journal/settings`, { templateId: priv.id })).status, 404);
    expectOk(await bob.put(`/workspaces/${wid}/journal/settings`, { templateId: tpl.id }));
    const day = expectOk(await bob.post<JournalOpenResponse>(`/workspaces/${wid}/journal/days/2026-03-01`, {}));
    const copy = (expectOk(await bob.get<{ page: Page }>(`/pages/${day.pageId}`)).page);
    assert.equal(copy.title, 'dimanche 1er mars 2026');
    assert.equal(copy.visibility, 'private');
    const month = expectOk(await bob.get<JournalMonthResponse>(`/workspaces/${wid}/journal?month=2026-03`));
    assert.equal(month.template?.id, tpl.id);
    // Removing the template: new days are empty again.
    expectOk(await bob.put(`/workspaces/${wid}/journal/settings`, { templateId: null }));
    assert.equal(expectOk(await bob.get<JournalMonthResponse>(`/workspaces/${wid}/journal?month=2026-03`)).template, null);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-03 tags: rights, uniqueness, counts never include invisible pages', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, viewer } = await trio(srv.base);
    const tag = await newTag(admin, wid, 'Épisode', 'blue');
    assert.equal((await admin.post(`/workspaces/${wid}/tags`, { name: '  épisode ' })).status, 409);
    assert.equal((await admin.post(`/workspaces/${wid}/tags`, { name: '' })).status, 400);
    assert.equal((await admin.post(`/workspaces/${wid}/tags`, { name: 'x', color: 'chartreuse' })).status, 400);
    assert.equal((await viewer.post(`/workspaces/${wid}/tags`, { name: 'Lecteur' })).status, 403);
    // The viewer reads the tags.
    expectOk(await viewer.get<TagsResponse>(`/workspaces/${wid}/tags`));

    const shared = await createPage(admin, wid, { title: 'Scénario partagé' });
    const secret = await createPage(admin, wid, { title: 'Carnet intime', visibility: 'private' });
    expectOk(await setTags(admin, shared.id, [tag.id]));
    expectOk(await setTags(admin, secret.id, [tag.id]));
    const countFor = async (c: Client) => expectOk(await c.get<TagsResponse>(`/workspaces/${wid}/tags`)).tags.find((t) => t.id === tag.id)!.pageCount;
    assert.equal(await countFor(admin), 2);
    assert.equal(await countFor(bob), 1);
    // The tag page lists the shared page only for Bob.
    const asBob = await query(bob, wid, { filter: { match: 'all', conditions: [{ type: 'tag', op: 'any', tagIds: [tag.id] }] } });
    assert.deepEqual(titles(asBob), ['Scénario partagé']);
    assert.equal(asBob.total, 1);

    // Bob cannot see, read or tag Alice's private page: 404 (no existence oracle).
    assert.equal((await setTags(bob, secret.id, [tag.id])).status, 404);
    assert.equal((await bob.get(`/pages/${secret.id}/organization`)).status, 404);
    // Viewer: reads a shared page's tags but cannot change them.
    assert.deepEqual(expectOk(await viewer.get<PageOrganization>(`/pages/${shared.id}/organization`)).tagIds, [tag.id]);
    assert.equal((await setTags(viewer, shared.id, [])).status, 403);

    // Rename / recolor by an editor; deletion by author or admin only.
    expectOk(await bob.patch<Tag>(`/tags/${tag.id}`, { name: 'Épisodes', color: 'green' }));
    const bobTag = await newTag(bob, wid, 'Idée');
    assert.equal((await admin.del(`/tags/${bobTag.id}`)).status, 200); // admin may
    const other = await newTag(admin, wid, 'Archive');
    assert.equal((await bob.del(`/tags/${other.id}`)).status, 403); // editor, not the author
    expectOk(await admin.del(`/tags/${tag.id}`));
    assert.deepEqual(expectOk(await admin.get<PageOrganization>(`/pages/${shared.id}/organization`)).tagIds, []);

    // A tag of another workspace is unknown here.
    const ws2 = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Autre' }));
    const foreign = await newTag(admin, ws2.id, 'Étranger');
    assert.equal((await setTags(admin, shared.id, [foreign.id])).status, 404);
    assert.equal((await bob.get(`/workspaces/${ws2.id}/tags`)).status, 404);
    assert.equal((await bob.patch(`/tags/${foreign.id}`, { name: 'x' })).status, 404);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-04 batch tagging counts refusals as skipped without revealing why', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, viewer } = await trio(srv.base);
    const tag = await newTag(admin, wid, 'Lot');
    const mine = await createPage(bob, wid, { title: 'À moi' });
    const shared = await createPage(admin, wid, { title: 'Partagée' });
    const secret = await createPage(admin, wid, { title: 'Privée', visibility: 'private' });
    const r = expectOk(await bob.post<ApplyTagsResponse>(`/workspaces/${wid}/tags/apply`, { pageIds: [mine.id, shared.id, secret.id, 'inexistante'], add: [tag.id] }));
    assert.equal(r.changed, 2); // a member edits shared pages too
    assert.equal(r.skipped, 2); // private + unknown: indistinguishable
    assert.equal((await viewer.post(`/workspaces/${wid}/tags/apply`, { pageIds: [mine.id], add: [tag.id] })).status, 403);
    const r2 = expectOk(await bob.post<ApplyTagsResponse>(`/workspaces/${wid}/tags/apply`, { pageIds: [mine.id], remove: [tag.id] }));
    assert.equal(r2.changed, 1);
    assert.equal((await bob.post(`/workspaces/${wid}/tags/apply`, { pageIds: Array.from({ length: 101 }, (_, i) => `p${i}`), add: [tag.id] })).status, 400);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-05 workspace page properties: typing, display, options, rights', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, viewer } = await trio(srv.base);
    const page = await createPage(admin, wid, { title: 'Épisode 3' });
    const secret = await createPage(admin, wid, { title: 'Privée', visibility: 'private' });
    const mk = async (body: Record<string, unknown>) => expectOk(await admin.post<PageProp>(`/workspaces/${wid}/page-props`, body), 201);
    const text = await mk({ name: 'Réalisateur', type: 'text', display: 'always' });
    const nb = await mk({ name: 'Durée (min)', type: 'number' });
    const date = await mk({ name: 'Tournage', type: 'date' });
    const box = await mk({ name: 'Validé', type: 'checkbox', display: 'hidden' });
    const sel = await mk({ name: 'Statut', type: 'select', options: [{ name: 'À faire', color: 'gray' }, { name: 'Fini', color: 'green' }] });
    assert.equal(text.display, 'always');
    assert.equal(nb.display, 'hide_empty');
    assert.equal(sel.options.length, 2);
    assert((await admin.post(`/workspaces/${wid}/page-props`, { name: 'réalisateur', type: 'text' })).status === 409);
    assert((await admin.post(`/workspaces/${wid}/page-props`, { name: 'Z', type: 'formula' })).status === 400);

    const set = (c: Client, pid: string, propId: string, value: unknown) => c.put(`/pages/${pid}/props/${propId}`, { value });
    expectOk(await set(admin, page.id, text.id, 'Agnès'));
    expectOk(await set(admin, page.id, nb.id, 52));
    expectOk(await set(admin, page.id, date.id, '2026-11-03'));
    expectOk(await set(admin, page.id, box.id, true));
    expectOk(await set(admin, page.id, sel.options[1] ? sel.id : sel.id, sel.options[1]!.id));
    // Type checks.
    assert.equal((await set(admin, page.id, nb.id, 'beaucoup')).status, 400);
    assert.equal((await set(admin, page.id, date.id, '2026-02-30')).status, 400);
    assert.equal((await set(admin, page.id, box.id, 'oui')).status, 400);
    assert.equal((await set(admin, page.id, sel.id, 'inconnue')).status, 400);
    assert.equal((await set(admin, page.id, 'inconnue', 'x')).status, 404);
    const org = expectOk(await bob.get<PageOrganization>(`/pages/${page.id}/organization`));
    assert.equal(org.props[text.id], 'Agnès');
    assert.equal(org.props[nb.id], 52);
    assert.equal(org.props[box.id], true);

    // Rights: viewer reads, cannot write; private page is a 404 for others.
    assert.equal((await set(viewer, page.id, text.id, 'x')).status, 403);
    assert.equal((await set(bob, secret.id, text.id, 'x')).status, 404);
    assert.equal((await bob.get(`/pages/${secret.id}/organization`)).status, 404);
    // Editors create and rename, only admins delete.
    expectOk(await bob.patch(`/page-props/${nb.id}`, { name: 'Durée' }));
    assert.equal((await bob.del(`/page-props/${nb.id}`)).status, 403);

    // Removing an option clears the values that used it; reorder with `after`.
    expectOk(await admin.patch(`/page-props/${sel.id}`, { options: [sel.options[0]!] }));
    assert.equal(expectOk(await admin.get<PageOrganization>(`/pages/${page.id}/organization`)).props[sel.id], undefined);
    expectOk(await admin.patch(`/page-props/${box.id}`, { after: null }));
    const list = expectOk(await admin.get<{ props: PageProp[] }>(`/workspaces/${wid}/page-props`)).props;
    assert.equal(list[0]!.id, box.id);
    // Deleting a property removes its values.
    expectOk(await admin.del(`/page-props/${text.id}`));
    assert.equal(expectOk(await admin.get<PageOrganization>(`/pages/${page.id}/organization`)).props[text.id], undefined);
    // Clearing a value.
    expectOk(await set(admin, page.id, nb.id, null));
    assert.equal(expectOk(await admin.get<PageOrganization>(`/pages/${page.id}/organization`)).props[nb.id], undefined);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-06 « Toutes les pages »: pagination, filters, sort, grouping, hidden pages', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const tagA = await newTag(admin, wid, 'Alpha');
    const tagB = await newTag(admin, wid, 'Bravo');
    const pages: Page[] = [];
    for (let i = 0; i < 7; i++) pages.push(await createPage(admin, wid, { title: `Page ${String(i).padStart(2, '0')}` }));
    expectOk(await setTags(admin, pages[0]!.id, [tagA.id]));
    expectOk(await setTags(admin, pages[1]!.id, [tagA.id, tagB.id]));
    expectOk(await setTags(admin, pages[2]!.id, [tagB.id]));
    const priv = await createPage(admin, wid, { title: 'Privée tag', visibility: 'private' });
    expectOk(await setTags(admin, priv.id, [tagA.id]));
    const trashed = await createPage(admin, wid, { title: 'Dans la corbeille' });
    expectOk(await admin.post(`/pages/${trashed.id}/trash`, {}));
    const db = await createPage(admin, wid, { title: 'Base', kind: 'database' });
    const row = await createPage(admin, wid, { title: 'Ligne', parentType: 'database', parentId: db.id });
    const sub = await createPage(admin, wid, { title: 'Sous-page', parentType: 'page', parentId: pages[0]!.id });

    // Default listing: no rows, no private page of someone else, no trash; paginated by 3.
    const sortTitle = { field: 'title', dir: 'asc' };
    const p1 = await query(bob, wid, { sort: sortTitle, limit: 3 });
    const all = titles(await query(bob, wid, { sort: sortTitle, limit: 100 }));
    assert(!all.includes('Privée tag') && !all.includes('Dans la corbeille') && !all.includes('Ligne'));
    assert(all.includes('Base') && all.includes('Sous-page'));
    assert.equal(p1.items.length, 3);
    assert.equal(p1.total, all.length);
    assert.equal(p1.hasMore, true);
    const p2 = await query(bob, wid, { sort: sortTitle, limit: 3, offset: 3 });
    assert.deepEqual([...titles(p1), ...titles(p2)], all.slice(0, 6));
    // The admin sees her private page; rows only when asked for.
    assert((titles(await query(admin, wid, { limit: 100 }))).includes('Privée tag'));
    assert((titles(await query(bob, wid, { limit: 100, filter: { match: 'all', conditions: [{ type: 'kind', kinds: ['row'] }] } }))).includes(row.title));

    // Filters: tag any / all / none, title, author, space, kind.
    const f = async (c: Client, conditions: unknown[], match = 'all') => titles(await query(c, wid, { sort: sortTitle, limit: 100, filter: { match, conditions } }));
    assert.deepEqual(await f(bob, [{ type: 'tag', op: 'any', tagIds: [tagA.id, tagB.id] }]), ['Page 00', 'Page 01', 'Page 02']);
    assert.deepEqual(await f(bob, [{ type: 'tag', op: 'all', tagIds: [tagA.id, tagB.id] }]), ['Page 01']);
    assert(!(await f(bob, [{ type: 'tag', op: 'none', tagIds: [tagA.id] }])).includes('Page 00'));
    assert.deepEqual(await f(bob, [{ type: 'title', value: 'PAGE 03' }]), ['Page 03']);
    assert.deepEqual(await f(bob, [{ type: 'title', value: 'écrite' }]), []);
    const accented = await createPage(admin, wid, { title: 'Épisode Éclair' });
    assert.deepEqual(await f(bob, [{ type: 'title', value: 'episode eclair' }]), [accented.title]);
    assert.deepEqual(await f(bob, [{ type: 'title', value: 'ÉPISODE' }]), [accented.title]);
    expectOk(await admin.post(`/pages/${accented.id}/trash`, {}));
    assert.deepEqual(await f(bob, [{ type: 'kind', kinds: ['database'] }]), ['Base']);
    assert.deepEqual(await f(bob, [{ type: 'tag', op: 'any', tagIds: [tagB.id] }, { type: 'title', value: 'sous-' }], 'any'), ['Page 01', 'Page 02', 'Sous-page']);
    assert.deepEqual(await f(admin, [{ type: 'space', space: 'private' }]), ['Privée tag']);
    assert((await f(bob, [{ type: 'space', space: 'private' }])).length === 0);
    assert.deepEqual(await f(bob, [{ type: 'space', space: pages[0]!.id }, { type: 'title', value: 'sous' }]), ['Sous-page']);
    const bobsPage = await createPage(bob, wid, { title: 'Écrite par Bob' });
    assert.deepEqual(await f(admin, [{ type: 'user', by: 'created', userIds: [bobsPage.createdBy] }]), ['Écrite par Bob']);
    assert.deepEqual(await f(admin, [{ type: 'date', field: 'created', lastDays: 1 }, { type: 'user', by: 'created', userIds: [bobsPage.createdBy] }]), ['Écrite par Bob']);
    assert.deepEqual(await f(admin, [{ type: 'date', field: 'created', before: '2001-01-01' }]), []);

    // Grouping by tag: first tag alphabetically, then untagged; counts follow the viewer.
    const grouped = await query(bob, wid, { group: 'tag', sort: sortTitle, limit: 100 });
    const keyOf = (t: string) => grouped.items.find((i) => i.title === t)!.group;
    assert.equal(keyOf('Page 01'), tagA.id);
    assert.equal(keyOf('Page 02'), tagB.id);
    assert.equal(keyOf('Page 05'), '');
    const order = grouped.items.map((i) => i.group);
    assert.deepEqual([...order].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : 0)).length, order.length);
    assert.equal(order.indexOf(''), order.findIndex((g) => g === '')); // untagged are last
    assert(order.slice(order.indexOf('')).every((g) => g === ''));
    // Malformed query bodies are rejected.
    assert.equal((await bob.post(`/workspaces/${wid}/pages/query`, { limit: 5000 })).status, 400);
    assert.equal((await bob.post(`/workspaces/${wid}/pages/query`, { filter: { match: 'all', conditions: [{ type: 'sql', value: '1=1' }] } })).status, 400);
    assert.equal((await bob.post(`/workspaces/${wid}/pages/query`, { sort: { field: 'password', dir: 'asc' } })).status, 400);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-07 listing by workspace property: filter, sort, column values', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const nb = expectOk(await admin.post<PageProp>(`/workspaces/${wid}/page-props`, { name: 'Budget', type: 'number' }), 201);
    const sel = expectOk(await admin.post<PageProp>(`/workspaces/${wid}/page-props`, { name: 'Phase', type: 'select', options: [{ name: 'Idée', color: 'gray' }, { name: 'Tournage', color: 'blue' }] }), 201);
    const a = await createPage(admin, wid, { title: 'Zéta A' });
    const b = await createPage(admin, wid, { title: 'Zéta B' });
    const c = await createPage(admin, wid, { title: 'Zéta C' });
    const secret = await createPage(admin, wid, { title: 'Zéta Secrète', visibility: 'private' });
    const only = { type: 'title', value: 'zéta' };
    for (const [p, v] of [[a, 300], [b, 50], [secret, 1]] as const) expectOk(await admin.put(`/pages/${p.id}/props/${nb.id}`, { value: v }));
    expectOk(await admin.put(`/pages/${a.id}/props/${sel.id}`, { value: sel.options[1]!.id }));
    expectOk(await admin.put(`/pages/${b.id}/props/${sel.id}`, { value: sel.options[0]!.id }));
    const asc = await query(bob, wid, { filter: { match: 'all', conditions: [only] }, sort: { field: { prop: nb.id }, dir: 'asc' }, propIds: [nb.id, sel.id], limit: 50 });
    assert.deepEqual(titles(asc), ['Zéta B', 'Zéta A', 'Zéta C']); // empty values last
    assert.equal(asc.items[0]!.props[nb.id], 50);
    const gt = await query(bob, wid, { filter: { match: 'all', conditions: [only, { type: 'prop', propId: nb.id, op: 'gt', value: 100 }] } });
    assert.deepEqual(titles(gt), ['Zéta A']);
    const empty = await query(bob, wid, { filter: { match: 'all', conditions: [only, { type: 'prop', propId: nb.id, op: 'empty' }] }, sort: { field: 'title', dir: 'asc' } });
    assert.deepEqual(titles(empty), ['Zéta C']);
    const grouped = await query(bob, wid, { filter: { match: 'all', conditions: [only] }, group: { prop: sel.id }, sort: { field: 'title', dir: 'asc' } });
    assert.deepEqual(grouped.items.map((i) => i.group), [sel.options[0]!.id, sel.options[1]!.id, '']); // Idée, Tournage, none
    // The private page never shows: Bob's listing has 3 items, Alice's 4.
    assert.equal((await query(admin, wid, { filter: { match: 'all', conditions: [only] } })).total, 4);
    // A property id of another workspace matches nothing (no error, no data).
    const foreign = await query(bob, wid, { filter: { match: 'all', conditions: [{ type: 'prop', propId: 'inconnue', op: 'not_empty' }] } });
    assert.equal(foreign.total, 0);
    void c;
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-08 smart collections: rules, manual pages, live preview, per-viewer results', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, viewer } = await trio(srv.base);
    const tag = await newTag(admin, wid, 'Montage');
    const open = await createPage(admin, wid, { title: 'Rushes partagés' });
    const secret = await createPage(admin, wid, { title: 'Rushes privés', visibility: 'private' });
    const other = await createPage(admin, wid, { title: 'Divers' });
    expectOk(await setTags(admin, open.id, [tag.id]));
    expectOk(await setTags(admin, secret.id, [tag.id]));
    const rules = { match: 'all', conditions: [{ type: 'tag', op: 'any', tagIds: [tag.id] }] };

    // Preview before saving, then create.
    const preview = expectOk(await admin.post<PageListResponse>(`/workspaces/${wid}/collections/preview`, { rules }));
    assert.deepEqual(titles(preview).sort(), ['Rushes partagés', 'Rushes privés']);
    const col = expectOk(await admin.post<Collection>(`/workspaces/${wid}/collections`, { name: 'Montage en cours', rules }), 201);
    assert.equal((await viewer.post(`/workspaces/${wid}/collections`, { name: 'x' })).status, 403);

    const list = async (c: Client) => titles(await query(c, wid, { collectionId: col.id, sort: { field: 'title', dir: 'asc' } }));
    assert.deepEqual(await list(admin), ['Rushes partagés', 'Rushes privés']);
    assert.deepEqual(await list(bob), ['Rushes partagés']);
    assert.equal(expectOk(await bob.post<PageListResponse>(`/workspaces/${wid}/collections/preview`, { rules })).total, 1);

    // Manual additions and exclusions; a page nobody tagged joins by hand, an excluded one leaves.
    expectOk(await bob.put(`/collections/${col.id}/pages/${other.id}`, { mode: 'include' }));
    expectOk(await bob.put(`/collections/${col.id}/pages/${open.id}`, { mode: 'exclude' }));
    assert.deepEqual(await list(bob), ['Divers']);
    // Bob cannot add (nor learn about) Alice's private page.
    assert.equal((await bob.put(`/collections/${col.id}/pages/${secret.id}`, { mode: 'include' })).status, 404);
    // Alice's include of her private page is recorded, but invisible to Bob everywhere.
    expectOk(await admin.put(`/collections/${col.id}/pages/${secret.id}`, { mode: 'include' }));
    const asBob = expectOk(await bob.get<Collection>(`/collections/${col.id}`));
    assert(!asBob.included.includes(secret.id) && !asBob.excluded.includes(secret.id));
    assert(asBob.included.includes(other.id));
    assert.deepEqual(await list(bob), ['Divers']);
    // Back to the rules' verdict.
    expectOk(await bob.put(`/collections/${col.id}/pages/${open.id}`, { mode: null }));
    assert.deepEqual(await list(bob), ['Divers', 'Rushes partagés']);

    // Without rules nor manual pages the collection is empty (not « everything »).
    const empty = expectOk(await admin.post<Collection>(`/workspaces/${wid}/collections`, { name: 'Vide' }), 201);
    assert.equal(expectOk(await admin.post<PageListResponse>(`/workspaces/${wid}/pages/query`, { collectionId: empty.id })).total, 0);

    // A trashed page leaves the collection; the list endpoint exposes definitions only.
    expectOk(await admin.post(`/pages/${other.id}/trash`, {}));
    assert.deepEqual(await list(bob), ['Rushes partagés']);
    assert.equal(expectOk(await bob.get<CollectionsResponse>(`/workspaces/${wid}/collections`)).collections.length, 2);

    // Editing, deleting: author or admin.
    expectOk(await bob.patch(`/collections/${col.id}`, { name: 'Montage' }));
    const bobs = expectOk(await bob.post<Collection>(`/workspaces/${wid}/collections`, { name: 'À Bob' }), 201);
    const mine = expectOk(await admin.post<Collection>(`/workspaces/${wid}/collections`, { name: 'À Alice' }), 201);
    assert.equal((await bob.del(`/collections/${mine.id}`)).status, 403);
    expectOk(await admin.del(`/collections/${bobs.id}`));
    // Unknown, foreign.
    assert.equal((await bob.get(`/collections/inconnue`)).status, 404);
    const ws2 = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Autre' }));
    const foreign = expectOk(await admin.post<Collection>(`/workspaces/${ws2.id}/collections`, { name: 'Étrangère' }), 201);
    assert.equal((await bob.get(`/collections/${foreign.id}`)).status, 404);
    assert.equal((await bob.post(`/workspaces/${ws2.id}/pages/query`, { collectionId: foreign.id })).status, 404);
    // A collection id of another workspace used with this workspace's listing is refused as well,
    // even for the admin who belongs to both.
    assert.equal((await bob.post(`/workspaces/${wid}/pages/query`, { collectionId: foreign.id })).status, 404);
    assert.equal((await admin.post(`/workspaces/${wid}/pages/query`, { collectionId: foreign.id })).status, 404);
    assert.equal(expectOk(await admin.post<PageListResponse>(`/workspaces/${ws2.id}/pages/query`, { collectionId: foreign.id })).total, 0);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-09 restricted teamspace pages never appear in tags, collections or listings', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const root = await createPage(admin, wid, { title: 'Équipe Étalonnage' });
    const child = await createPage(admin, wid, { title: 'LUT secrètes', parentType: 'page', parentId: root.id });
    expectOk(await admin.post(`/pages/${root.id}/teamspace`, { access: 'private', confirmAccess: true }));
    const tag = await newTag(admin, wid, 'Étalon');
    expectOk(await setTags(admin, child.id, [tag.id]));
    assert.equal((await setTags(bob, child.id, [tag.id])).status, 404);
    assert.equal(expectOk(await bob.get<TagsResponse>(`/workspaces/${wid}/tags`)).tags[0]!.pageCount, 0);
    assert.equal((await query(bob, wid, { filter: { match: 'all', conditions: [{ type: 'tag', op: 'any', tagIds: [tag.id] }] } })).total, 0);
    assert.equal((await query(bob, wid, { filter: { match: 'all', conditions: [{ type: 'space', space: root.id }] } })).total, 0);
    const col = expectOk(await admin.post<Collection>(`/workspaces/${wid}/collections`, { name: 'Étalon', rules: { match: 'all', conditions: [{ type: 'tag', op: 'any', tagIds: [tag.id] }] } }), 201);
    expectOk(await admin.put(`/collections/${col.id}/pages/${child.id}`, { mode: 'include' }));
    assert.equal((await query(bob, wid, { collectionId: col.id })).total, 0);
    assert.equal((await query(admin, wid, { collectionId: col.id })).total, 1);
    assert.equal((await bob.post(`/workspaces/${wid}/collections/preview`, { rules: col.rules, included: [child.id] })).status, 200);
    assert.equal(expectOk(await bob.post<PageListResponse>(`/workspaces/${wid}/collections/preview`, { rules: col.rules, included: [child.id] })).total, 0);
    const bobTree = expectOk(await bob.get<TreeResponse>(`/workspaces/${wid}/tree`));
    assert(!bobTree.nodes.some((n) => n.id === child.id));
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-10 saved views: personal or shared, only the author edits', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const config = { layout: 'grid', filter: { match: 'all', conditions: [] }, group: 'tag', sort: { field: 'title', dir: 'asc' }, columns: ['tags', 'updated'] };
    const mineV = expectOk(await admin.post<SavedPagesView>(`/workspaces/${wid}/page-views`, { name: 'Mes pages', config }), 201);
    const sharedV = expectOk(await admin.post<SavedPagesView>(`/workspaces/${wid}/page-views`, { name: 'Équipe', shared: true, config }), 201);
    const bobList = expectOk(await bob.get<SavedPagesViewsResponse>(`/workspaces/${wid}/page-views`)).views;
    assert.deepEqual(bobList.map((v) => v.name), ['Équipe']);
    assert.equal(bobList[0]!.mine, false);
    // Not shared → 404; shared but not yours → 403.
    assert.equal((await bob.patch(`/page-views/${mineV.id}`, { name: 'x' })).status, 404);
    assert.equal((await bob.del(`/page-views/${mineV.id}`)).status, 404);
    assert.equal((await bob.patch(`/page-views/${sharedV.id}`, { name: 'x' })).status, 403);
    assert.equal((await bob.del(`/page-views/${sharedV.id}`)).status, 403);
    expectOk(await admin.patch(`/page-views/${mineV.id}`, { shared: true }));
    assert.equal(expectOk(await bob.get<SavedPagesViewsResponse>(`/workspaces/${wid}/page-views`)).views.length, 2);
    expectOk(await admin.del(`/page-views/${sharedV.id}`));
    assert.equal((await admin.post(`/workspaces/${wid}/page-views`, { name: 'Mauvaise', config: { ...config, layout: 'cube' } })).status, 400);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-11 batch actions: move and trash use each page\'s own rights', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, viewer } = await trio(srv.base);
    const dest = await createPage(admin, wid, { title: 'Destination' });
    const a = await createPage(bob, wid, { title: 'Lot A' });
    const b = await createPage(bob, wid, { title: 'Lot B' });
    const secret = await createPage(admin, wid, { title: 'Privée lot', visibility: 'private' });
    const r = expectOk(await bob.post<PagesBatchResponse>(`/workspaces/${wid}/pages/batch`, { action: 'move', pageIds: [a.id, b.id, secret.id, 'inconnue'], parentType: 'page', parentId: dest.id }));
    assert.deepEqual(r.done.sort(), [a.id, b.id].sort());
    assert.equal(r.failed.length, 2);
    // The refusal of an invisible page says nothing more than for an unknown id.
    assert.equal(new Set(r.failed.map((f) => f.reason)).size, 1);
    assert.equal((expectOk(await bob.get<{ page: Page }>(`/pages/${a.id}`)).page).parentId, dest.id);
    assert.equal((expectOk(await admin.get<{ page: Page }>(`/pages/${secret.id}`)).page).parentType, 'workspace');
    // Moving into a page the user cannot see: refused per page.
    const bad = expectOk(await bob.post<PagesBatchResponse>(`/workspaces/${wid}/pages/batch`, { action: 'move', pageIds: [a.id], parentType: 'page', parentId: secret.id }));
    assert.equal(bad.done.length, 0);
    // Trash.
    const t = expectOk(await bob.post<PagesBatchResponse>(`/workspaces/${wid}/pages/batch`, { action: 'trash', pageIds: [a.id, secret.id] }));
    assert.deepEqual(t.done, [a.id]);
    assert.equal((expectOk(await admin.get<{ page: Page }>(`/pages/${secret.id}`)).page).trashedAt, null);
    assert.equal((await viewer.post(`/workspaces/${wid}/pages/batch`, { action: 'trash', pageIds: [b.id] })).status, 403);
    assert.equal((await bob.post(`/workspaces/${wid}/pages/batch`, { action: 'delete', pageIds: [b.id] })).status, 400);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-12 folder items: tags and collections in sidebar folders', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const tag = await newTag(admin, wid, 'Dossiers');
    const col = expectOk(await admin.post<Collection>(`/workspaces/${wid}/collections`, { name: 'Col' }), 201);
    const shared = expectOk(await admin.post<{ id: string }>(`/workspaces/${wid}/folders`, { space: 'workspace', name: 'Studio' }));
    const priv = expectOk(await bob.post<{ id: string }>(`/workspaces/${wid}/folders`, { space: 'private', name: 'Perso de Bob' }));
    expectOk(await admin.put(`/folders/${shared.id}/items`, { kind: 'tag', refId: tag.id }));
    expectOk(await admin.put(`/folders/${shared.id}/items`, { kind: 'collection', refId: col.id }));
    const items = expectOk(await bob.get<FolderItemsResponse>(`/workspaces/${wid}/organize/folder-items`)).items;
    assert.equal(items.length, 2);
    // Bob's private folder is invisible (404) to Alice, and the item list never shows it to her.
    assert.equal((await admin.put(`/folders/${priv.id}/items`, { kind: 'tag', refId: tag.id })).status, 404);
    // Bob also files the tag in his private folder: both placements coexist, Alice only sees hers.
    expectOk(await bob.put(`/folders/${priv.id}/items`, { kind: 'tag', refId: tag.id }));
    const aliceItems = expectOk(await admin.get<FolderItemsResponse>(`/workspaces/${wid}/organize/folder-items`)).items;
    assert.deepEqual(aliceItems.filter((i) => i.kind === 'tag').map((i) => i.folderId), [shared.id]);
    const bobTagFolders = expectOk(await bob.get<FolderItemsResponse>(`/workspaces/${wid}/organize/folder-items`)).items.filter((i) => i.kind === 'tag').map((i) => i.folderId);
    assert.deepEqual(bobTagFolders.sort(), [shared.id, priv.id].sort());
    // Unknown target; removal in a folder the user cannot see is a 404.
    assert.equal((await admin.put(`/folders/${shared.id}/items`, { kind: 'tag', refId: 'inconnu' })).status, 404);
    assert.equal((await admin.del(`/folders/${priv.id}/items/tag/${tag.id}`)).status, 404);
    expectOk(await bob.del(`/folders/${priv.id}/items/tag/${tag.id}`));
    assert.equal(expectOk(await admin.get<FolderItemsResponse>(`/workspaces/${wid}/organize/folder-items`)).items.filter((i) => i.kind === 'tag').length, 1);
    // Deleting the folder or the collection cleans up.
    expectOk(await admin.del(`/collections/${col.id}`));
    assert.equal(expectOk(await bob.get<FolderItemsResponse>(`/workspaces/${wid}/organize/folder-items`)).items.filter((i) => i.kind === 'collection').length, 0);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-13 migrations are additive and idempotent; all routes require a session', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid } = await setupAdmin(srv.base);
    const file = path.join(srv.dataDir, 'oriel.db');
    const raw = new DatabaseSync(file);
    try {
      raw.exec('PRAGMA busy_timeout = 2000');
      for (const m of migrations) raw.exec(m.sql); // second application: no error, no change
      const applied = raw.prepare("SELECT id FROM applied_migrations WHERE id LIKE 'org-%' ORDER BY id").all() as Array<{ id: string }>;
      assert.deepEqual(applied.map((a) => a.id), ['org-001-journal', 'org-002-tags-props', 'org-003-collections-views']);
    } finally {
      raw.close();
    }
    const anon = new Client(srv.base);
    for (const [method, url] of [
      ['GET', `/workspaces/${wid}/tags`],
      ['GET', `/workspaces/${wid}/collections`],
      ['GET', `/workspaces/${wid}/page-props`],
      ['GET', `/workspaces/${wid}/page-views`],
      ['GET', `/workspaces/${wid}/journal?month=2026-10`],
      ['POST', `/workspaces/${wid}/pages/query`],
      ['GET', `/workspaces/${wid}/organize/folder-items`],
    ] as const) {
      assert.equal((await anon.req(method, url, method === 'POST' ? {} : undefined)).status, 401, url);
    }
    // CSRF: a foreign Origin is refused on a mutation (core hook), a wrong content-type too.
    assert.equal((await admin.req('POST', `/workspaces/${wid}/tags`, { name: 'Pirate' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await admin.req('POST', `/workspaces/${wid}/tags`, undefined, { rawBody: '{"name":"x"}', contentType: 'text/plain' })).status >= 400, true);
    assert.equal(expectOk(await admin.get<TagsResponse>(`/workspaces/${wid}/tags`)).tags.length, 0);
  } finally {
    await srv.stop();
  }
});

test('QA-ORG-14 GET listing (read-scoped tokens): same visibility rules, bounded paging', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const tag = await newTag(admin, wid, 'Lecture');
    const open = await createPage(admin, wid, { title: 'Visible' });
    const secret = await createPage(admin, wid, { title: 'Cachée', visibility: 'private' });
    for (const p of [open, secret]) expectOk(await setTags(admin, p.id, [tag.id]));
    const asBob = expectOk(await bob.get<PageListResponse>(`/workspaces/${wid}/pages?tagId=${tag.id}`));
    assert.deepEqual(titles(asBob), ['Visible']);
    assert.equal(expectOk(await admin.get<PageListResponse>(`/workspaces/${wid}/pages?tagId=${tag.id}`)).total, 2);
    assert.equal((await bob.get(`/workspaces/${wid}/pages?limit=1000`)).status, 400);
    assert.equal((await bob.get(`/workspaces/${wid}/pages?collectionId=inconnue`)).status, 404);
    // A read-scoped token may list but not tag.
    const tok = expectOk(await admin.post<{ token: string }>('/me/tokens', { name: 'lecture', scope: 'read' }));
    const reader = new Client(srv.base);
    const res = await fetch(`${srv.base}/api/workspaces/${wid}/pages?tagId=${tag.id}`, { headers: { authorization: `Bearer ${tok.token}` } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as PageListResponse).total, 2);
    void reader;
    const denied = await fetch(`${srv.base}/api/pages/${open.id}/tags`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tagIds: [] }),
    });
    assert.equal(denied.status, 403);
  } finally {
    await srv.stop();
  }
});
