// End-to-end: the MCP tools against a real Oriel server (temporary data directory), through an
// in-memory MCP client, authenticated by personal API tokens.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, type Page } from '@oriel/shared';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { blocksToUpdate } from '../src/content/editor.js';
import { startHttpServer } from '../src/http.js';
import { addMember, connectMcp, createToken, expectOk, setupAdmin, startTestServer, type HttpClient, type Mcp, type TestServer } from './helpers.js';

describe('MCP tools (end-to-end)', () => {
  let srv: TestServer;
  let admin: HttpClient;
  let wid: string;
  let mcp: Mcp;
  let readOnly: Mcp;
  let adminId: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    adminId = expectOk(await admin.get<{ user: { id: string } }>('/auth/me')).user.id;
    expectOk(await admin.patch(`/workspaces/${wid}`, { name: 'Studio' }));
    const write = await createToken(admin, { name: 'Claude (écriture)', scope: 'write' });
    const read = await createToken(admin, { name: 'Claude (lecture)', scope: 'read' });
    mcp = await connectMcp(srv.base, write.token);
    readOnly = await connectMcp(srv.base, read.token);
  });
  after(async () => {
    await mcp?.close();
    await readOnly?.close();
    await srv?.stop();
  });

  test('lists the tools with descriptions and strict input schemas', async () => {
    const { tools } = await mcp.client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const n of [
      'oriel_whoami',
      'oriel_list_workspaces',
      'oriel_search',
      'oriel_list_pages',
      'oriel_read_page',
      'oriel_create_page',
      'oriel_update_page',
      'oriel_write_page_content',
      'oriel_move_page',
      'oriel_trash_page',
      'oriel_duplicate_page',
      'oriel_get_database',
      'oriel_query_database',
      'oriel_create_database',
      'oriel_update_database_schema',
      'oriel_create_rows',
      'oriel_update_rows',
      'oriel_list_comments',
      'oriel_add_comment',
      'oriel_list_notifications',
      'oriel_get_latest_brief',
    ]) {
      assert.ok(names.includes(n), n);
    }
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 30, `${t.name} description`);
      assert.equal((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, `${t.name} strict`);
    }
    assert.match(tools.find((t) => t.name === 'oriel_trash_page')!.description!, /DESTRUCTIF/);
    assert.match(tools.find((t) => t.name === 'oriel_write_page_content')!.description!, /destructif/i);
    assert.equal(tools.find((t) => t.name === 'oriel_trash_page')!.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'oriel_read_page')!.annotations?.readOnlyHint, true);
    // Unknown arguments are refused.
    const bad = await mcp.call('oriel_search', { query: 'x', nope: 1 }, { allowError: true });
    assert.equal(bad.isError, true);
  });

  test('whoami and workspaces', async () => {
    const me = await mcp.json('oriel_whoami');
    assert.equal(me.utilisateur.email, 'admin@oriel.test');
    assert.equal(me.jeton.droits, 'lecture et écriture');
    assert.equal(me.espaceParDefaut.nom, 'Studio');
    const ro = await readOnly.json('oriel_whoami');
    assert.equal(ro.jeton.droits, 'lecture seule');
    const ws = await mcp.json('oriel_list_workspaces');
    assert.deepEqual(ws.espaces.map((w: { nom: string }) => w.nom), ['Studio']);
  });

  test('create a page from Markdown, read it back (identical-ish Markdown), append, search, tree', async () => {
    const md = [
      '# Plan de projet',
      '',
      'Le **cadrage** commence le [📅 15 oct. 2026](oriel://date/2026-10-15).',
      '',
      '> 🎬 Prévoir les autorisations',
      '',
      '* [ ] Réserver le matériel',
      '* [x] Valider le plan',
      '',
      '<details>',
      '<summary>Contacts</summary>',
      '',
      'Régie : 06 00 00 00 00',
      '',
      '</details>',
    ].join('\n');
    const created = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'Projet Aurore', icon: '🎥', markdown: md });
    assert.match(created.lien, /^oriel:\/\/page\//);
    const read = await mcp.call('oriel_read_page', { pageId: created.lien });
    const meta = JSON.parse(read.texts[0]!);
    assert.equal(meta.titre, 'Projet Aurore');
    assert.equal(meta.icone, '🎥');
    assert.equal(read.texts[1], md);

    // A sub-page gets a card in its parent.
    const sub = await mcp.json('oriel_create_page', { parent: { type: 'page', id: created.id }, title: 'Repérages', markdown: 'Lieux à visiter.' });
    const after = await mcp.call('oriel_read_page', { pageId: created.id });
    assert.ok(after.texts[1]!.endsWith(`[Repérages](oriel://page/${sub.id})`), after.texts[1]);
    assert.deepEqual(JSON.parse(after.texts[0]!).sousPages.map((p: { titre: string }) => p.titre), ['Repérages']);

    await mcp.json('oriel_write_page_content', { pageId: sub.id, markdown: '- Gare\n- Port', mode: 'append' });
    const subRead = await mcp.call('oriel_read_page', { pageId: sub.id });
    assert.equal(subRead.texts[1], 'Lieux à visiter.\n\n* Gare\n* Port');
    const subMeta = JSON.parse(subRead.texts[0]!);
    assert.equal(subMeta.chemin, 'Projet Aurore');

    const found = await mcp.json('oriel_search', { query: 'autorisations' });
    assert.equal(found.resultats[0].id, created.id);
    const tree = await mcp.json('oriel_list_pages', {});
    const aurore = tree.pages.find((p: { id: string }) => p.id === created.id);
    assert.ok(aurore);
    assert.ok(tree.pages.some((p: { id: string; niveau: number }) => p.id === sub.id && p.niveau === 2));
  });

  test('replace content, move, duplicate, trash and restore', async () => {
    const a = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'A', markdown: 'Ancien contenu' });
    const b = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'B' });
    await mcp.json('oriel_write_page_content', { pageId: a.id, markdown: 'Nouveau contenu', mode: 'replace' });
    assert.equal((await mcp.call('oriel_read_page', { pageId: a.id })).texts[1], 'Nouveau contenu');
    // The previous content is kept in the history.
    const snaps = expectOk(await admin.get<{ snapshots: Array<{ reason: string }> }>(`/pages/${a.id}/snapshots`));
    assert.ok(snaps.snapshots.some((s) => s.reason === 'before-restore'));
    const moved = await mcp.json('oriel_move_page', { pageId: a.id, parent: { type: 'page', id: b.id } });
    assert.deepEqual(moved.parent, { type: 'page', id: b.id });
    const copy = await mcp.json('oriel_duplicate_page', { pageId: b.id });
    assert.match(copy.titre, /copie/);
    await mcp.json('oriel_trash_page', { pageId: copy.id });
    const trashed = expectOk(await admin.get<{ page: Page }>(`/pages/${copy.id}`)).page;
    assert.ok(trashed.trashedAt);
    await mcp.json('oriel_restore_page', { pageId: copy.id });
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${copy.id}`)).page.trashedAt, null);
  });

  test('databases: create with select/status/date/person/relations/rollup, rows, filtered queries, schema updates', async () => {
    const { client: bob } = await addMember(admin, wid, 'bob@oriel.test', 'Bob Martin', 'member');
    void bob;
    const projects = await mcp.json('oriel_create_database', {
      parent: { type: 'workspace' },
      title: 'Projets',
      icon: '📁',
      properties: [{ name: 'Client', type: 'text' }],
    });
    const tasks = await mcp.json('oriel_create_database', {
      parent: { type: 'workspace' },
      title: 'Tâches',
      titleProperty: 'Tâche',
      properties: [
        { name: 'Statut', type: 'status', options: [{ name: 'À faire', group: 'todo' }, { name: 'En cours', group: 'in_progress' }, { name: 'Fait', group: 'done' }] },
        { name: 'Priorité', type: 'select', options: ['Haute', 'Basse'] },
        { name: 'Échéance', type: 'date' },
        { name: 'Responsable', type: 'person' },
        { name: 'Heures', type: 'number' },
        { name: 'Validé', type: 'checkbox' },
        { name: 'Projet', type: 'relation', relation: { database: 'Projets', twoWay: true, mirrorName: 'Tâches' } },
        { name: 'Bloquée par', type: 'relation', relation: { database: 'self' } },
        { name: 'Client du projet', type: 'rollup', rollup: { relation: 'Projet', property: 'Client', function: 'show_original' } },
      ],
    });
    assert.deepEqual(tasks.avertissements, undefined, JSON.stringify(tasks.avertissements));
    const names = tasks.proprietes.map((p: { nom: string }) => p.nom);
    assert.deepEqual(names, ['Tâche', 'Statut', 'Priorité', 'Échéance', 'Responsable', 'Heures', 'Validé', 'Projet', 'Bloquée par', 'Client du projet']);
    assert.equal(tasks.proprietes.find((p: { nom: string }) => p.nom === 'Projet').relation.bidirectionnelle, true);

    const p = await mcp.json('oriel_create_rows', {
      databaseId: projects.id,
      rows: [
        { title: 'Aurore', properties: { Client: 'Fondation Mer' } },
        { title: 'Boréal', properties: { Client: 'Ville de Brest' } },
      ],
    });
    assert.equal(p.creees.length, 2);
    const rows = await mcp.json('oriel_create_rows', {
      databaseId: tasks.id,
      rows: [
        { title: 'Rédiger le plan', properties: { Statut: 'Fait', Priorité: 'Haute', Échéance: '2026-10-01', Responsable: 'moi', Heures: 12, Validé: true, Projet: 'Aurore' } },
        { title: 'Concevoir', properties: { Statut: 'En cours', Priorité: 'haute', Échéance: '2026-10-20', Responsable: 'bob@oriel.test', Heures: '6,5', Projet: ['Aurore'] } },
        { title: 'Assembler', properties: { Statut: 'À faire', Priorité: 'Moyenne', Échéance: { start: '2026-11-02', end: '2026-11-06' }, Responsable: 'Bob', Projet: 'Boréal', 'Bloquée par': 'Concevoir' } },
      ],
    });
    assert.equal(rows.creees.length, 3, JSON.stringify(rows));
    assert.ok(rows.avertissements.some((w: string) => w.includes('Priorité : Moyenne')), 'missing select option created');

    const all = await mcp.json('oriel_query_database', { databaseId: tasks.id, sorts: [{ property: 'Échéance' }] });
    assert.equal(all.total, 3);
    const first = all.lignes[0];
    assert.equal(first.titre, 'Rédiger le plan');
    assert.equal(first.proprietes.Statut, 'Fait');
    assert.equal(first.proprietes['Échéance'], '2026-10-01');
    assert.deepEqual(first.proprietes.Responsable, ['Alice Admin']);
    assert.equal(first.proprietes.Validé, true);
    assert.equal(first.proprietes.Projet[0].titre, 'Aurore');
    assert.match(String(first.proprietes['Client du projet']), /Fondation Mer/);
    assert.equal(all.lignes[1].proprietes.Heures, 6.5);
    assert.equal(all.lignes[2].proprietes['Échéance'], '2026-11-02 → 2026-11-06');
    assert.equal(all.lignes[2].proprietes['Bloquée par'][0].titre, 'Concevoir');

    const q = (filters: unknown[], extra: Record<string, unknown> = {}) =>
      mcp.json('oriel_query_database', { databaseId: tasks.id, filters, ...extra }).then((r) => r.lignes.map((l: { titre: string }) => l.titre).sort());
    assert.deepEqual(await q([{ property: 'Priorité', operator: 'equals', value: 'Haute' }]), ['Concevoir', 'Rédiger le plan']);
    assert.deepEqual(await q([{ property: 'statut', operator: 'not_equals', value: 'Fait' }]), ['Assembler', 'Concevoir']);
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'before', value: '2026-10-15' }]), ['Rédiger le plan']);
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'on_or_after', value: '2026-10-20' }]), ['Assembler', 'Concevoir']);
    assert.deepEqual(await q([{ property: 'Projet', operator: 'contains', value: 'Aurore' }]), ['Concevoir', 'Rédiger le plan']);
    assert.deepEqual(await q([{ property: 'Responsable', operator: 'contains', value: 'Bob Martin' }]), ['Assembler', 'Concevoir']);
    assert.deepEqual(await q([{ property: 'Validé', operator: 'checked' }]), ['Rédiger le plan']);
    assert.deepEqual(await q([{ property: 'Heures', operator: 'gt', value: 6 }]), ['Concevoir', 'Rédiger le plan']);
    assert.deepEqual(await q([{ property: 'Tâche', operator: 'contains', value: 'conc' }]), ['Concevoir']);
    assert.deepEqual(
      await q([
        { property: 'Priorité', operator: 'equals', value: 'Moyenne' },
        { property: 'Validé', operator: 'checked' },
      ], { match: 'any' }),
      ['Assembler', 'Rédiger le plan'],
    );
    const page = await mcp.json('oriel_query_database', { databaseId: tasks.id, limit: 2, sorts: [{ property: 'Heures', direction: 'desc' }], properties: ['Heures'] });
    assert.equal(page.suivant, 2);
    assert.deepEqual(Object.keys(page.lignes[0].proprietes), ['Heures']);
    const bad = await mcp.call('oriel_query_database', { databaseId: tasks.id, filters: [{ property: 'Priorité', operator: 'equals', value: 'Inconnue' }] }, { allowError: true });
    assert.equal(bad.isError, true);
    assert.match(bad.texts[0]!, /Options : « Haute »/);

    // The mirror relation is filled in the other database.
    const proj = await mcp.json('oriel_query_database', { databaseId: projects.id, filters: [{ property: 'Nom', operator: 'equals', value: 'Aurore' }] });
    assert.deepEqual(proj.lignes[0].proprietes['Tâches'].map((t: { titre: string }) => t.titre).sort(), ['Concevoir', 'Rédiger le plan']);

    // Rows by title.
    const upd = await mcp.json('oriel_update_rows', {
      databaseId: tasks.id,
      updates: [
        { row: 'Concevoir', properties: { Statut: 'Fait', Validé: 'oui', Heures: null } },
        { row: 'assembler', title: 'Assembler le projet', properties: { Responsable: ['moi', 'Bob'] } },
      ],
    });
    assert.equal(upd.modifiees.length, 2);
    const after = await mcp.json('oriel_query_database', { databaseId: tasks.id, filters: [{ property: 'Statut', operator: 'equals', value: 'Fait' }] });
    assert.equal(after.total, 2);
    const concevoir = after.lignes.find((l: { titre: string }) => l.titre === 'Concevoir');
    assert.equal(concevoir.proprietes.Heures, undefined);

    // A row page shows its readable properties.
    const rowRead = await mcp.call('oriel_read_page', { pageId: concevoir.id });
    const rowMeta = JSON.parse(rowRead.texts[0]!);
    assert.equal(rowMeta.type, 'ligne');
    assert.equal(rowMeta.proprietes.Statut, 'Fait');

    // Schema updates.
    const schema = await mcp.json('oriel_update_database_schema', {
      databaseId: tasks.id,
      operations: [
        { action: 'add', property: { name: 'Budget', type: 'number', numberFormat: 'euro' } },
        { action: 'rename', property: 'Heures', name: 'Durée (h)' },
        { action: 'add_options', property: 'Priorité', options: ['Urgente'] },
        { action: 'retype', property: 'Validé', type: 'text' },
        { action: 'delete', property: 'Bloquée par' },
        { action: 'add', property: { name: 'Code', type: 'unique_id', prefix: 'TCH' } },
      ],
    });
    const byName = Object.fromEntries(schema.proprietes.map((x: { nom: string }) => [x.nom, x]));
    assert.equal(byName['Budget'].format, 'euro');
    assert.ok(byName['Durée (h)']);
    assert.ok(!byName['Bloquée par']);
    assert.equal(byName['Validé'].type, 'text');
    assert.ok(byName['Priorité'].options.some((o: { nom: string }) => o.nom === 'Urgente'));
    const codes = await mcp.json('oriel_query_database', { databaseId: tasks.id, properties: ['Code'], sorts: [{ property: 'Code' }] });
    assert.deepEqual(codes.lignes.map((l: { proprietes: { Code: string } }) => l.proprietes.Code), ['TCH-1', 'TCH-2', 'TCH-3']);
    const failing = await mcp.call(
      'oriel_update_database_schema',
      { databaseId: tasks.id, operations: [{ action: 'rename', property: 'Budget', name: 'Coût' }, { action: 'delete', property: 'Nope' }] },
      { allowError: true },
    );
    assert.equal(failing.isError, true);
    assert.match(failing.texts[0]!, /déjà fait/);

    const db = await mcp.json('oriel_get_database', { databaseId: tasks.id });
    assert.equal(db.lignes, 3);
    assert.ok(db.vues.length >= 1);
    assert.equal(db.proprietes.find((x: { nom: string }) => x.nom === 'Projet').relation.base, 'Projets');
  });

  test('inline databases are inserted in their parent page', async () => {
    const host = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'Hôte', markdown: 'Avant' });
    const db = await mcp.json('oriel_create_database', { parent: { type: 'page', id: host.id }, title: 'Inventaire', inline: true });
    const read = await mcp.call('oriel_read_page', { pageId: host.id });
    assert.equal(read.texts[1], `Avant\n\n[🗃 Inventaire](oriel://database/${db.id})`);
  });

  test('content round-trip through the server preserves Oriel blocks and comment marks', async () => {
    const host = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'Riche' });
    const child = await mcp.json('oriel_create_page', { parent: { type: 'page', id: host.id }, title: 'Enfant', addLinkToParent: false });
    const other = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'Ailleurs' });
    const md = [
      `[Enfant](oriel://page/${child.id})`,
      '',
      `Voir [Ailleurs](oriel://page/${other.id}) avec [@Alice Admin](oriel://user/${adminId}).`,
      '',
      '> ⚠️ Attention',
      '',
      '[Table des matières](oriel://toc)',
      '',
      '<!-- oriel:columns -->',
      '',
      '<!-- oriel:column -->',
      '',
      'Gauche',
      '',
      '<!-- oriel:column -->',
      '',
      'Droite',
      '',
      '<!-- /oriel:columns -->',
    ].join('\n');
    await mcp.json('oriel_write_page_content', { pageId: host.id, markdown: md, mode: 'replace' });
    const first = await mcp.call('oriel_read_page', { pageId: host.id });
    assert.equal(first.texts[1], md);
    const blocks = JSON.parse((await mcp.call('oriel_read_page', { pageId: host.id, format: 'blocks' })).texts[1]!);
    assert.deepEqual(blocks.map((b: { type: string }) => b.type).slice(0, 5), ['subpage', 'paragraph', 'callout', 'toc', 'columnList']);
    // Rewriting what was read changes nothing.
    await mcp.json('oriel_write_page_content', { pageId: host.id, markdown: first.texts[1], mode: 'replace' });
    assert.equal((await mcp.call('oriel_read_page', { pageId: host.id })).texts[1], md);
    // Lossless path: blocks JSON.
    await mcp.json('oriel_write_page_content', { pageId: host.id, blocks, mode: 'replace' });
    const again = JSON.parse((await mcp.call('oriel_read_page', { pageId: host.id, format: 'blocks' })).texts[1]!);
    assert.deepEqual(again.map((b: { type: string; props: unknown }) => [b.type, b.props]), blocks.map((b: { type: string; props: unknown }) => [b.type, b.props]));
    // Backlinks of the mentioned page.
    const otherMeta = JSON.parse((await mcp.call('oriel_read_page', { pageId: other.id })).texts[0]!);
    assert.deepEqual(otherMeta.retroliens.map((r: { id: string }) => r.id), [host.id]);

    // A document written by the web editor with a comment mark (collab module): text stays readable.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, blocksToUpdate([{ type: 'paragraph', content: 'Texte commenté ici' }]));
    const group = doc.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
    ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0);
    (((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText).format(0, 5, { comment: { threadId: 'x', orphan: false } });
    expectOk(await admin.put(`/pages/${other.id}/content`, { update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), mode: 'replace' }));
    const commented = await mcp.call('oriel_read_page', { pageId: other.id });
    assert.equal(commented.texts[1], 'Texte commenté ici');
    assert.equal(JSON.parse(commented.texts[0]!).avertissements, undefined);
  });

  test('advanced blocks and colors through the server: equations, tabs, breadcrumb, HTML, synced blocks of the workspace only', async () => {
    const host = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'Blocs avancés' });
    const synced = expectOk(await admin.post<{ id: string }>(`/pages/${host.id}/synced-blocks`, {}));
    const ws2 = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Autre espace' }));
    const foreignPage = expectOk(await admin.post<Page>(`/workspaces/${ws2.id}/pages`, { parentType: 'workspace', parentId: ws2.id, title: 'Ailleurs' }));
    const foreign = expectOk(await admin.post<{ id: string }>(`/pages/${foreignPage.id}/synced-blocks`, {}));
    const md = [
      '#### Titre 4 <!-- oriel:color text=red -->',
      '',
      'Texte <span data-text-color="blue" data-background-color="yellow">coloré **gras**</span> et $E = mc^2$.',
      '',
      'Fond vert <!-- oriel:color background=green -->',
      '',
      '$$\\frac{a}{b}$$',
      '',
      '[Fil d’Ariane](oriel://breadcrumb)',
      '',
      `[🔁 Bloc synchronisé](oriel://synced/${synced.id})`,
      '',
      '<!-- oriel:tabs -->',
      '',
      '<!-- oriel:tab title="Un" -->',
      '',
      'Premier',
      '',
      '<!-- oriel:tab title="Deux" -->',
      '',
      'Second',
      '',
      '<!-- /oriel:tabs -->',
      '',
      '```oriel-html',
      '<b>Bonjour</b>',
      '```',
      '',
      '```oriel-button',
      JSON.stringify({ label: 'Ouvrir', icon: '', actions: [{ type: 'open', url: 'https://example.com/' }] }, null, 2),
      '```',
    ].join('\n');
    const written = await mcp.json('oriel_write_page_content', { pageId: host.id, markdown: `${md}\n\n[🔁 Bloc synchronisé](oriel://synced/${foreign.id})`, mode: 'replace' });
    assert.ok(JSON.stringify(written.avertissements).includes(foreign.id), JSON.stringify(written));
    const read = await mcp.call('oriel_read_page', { pageId: host.id });
    assert.equal(read.texts[1], `${md}\n\n🔁 Bloc synchronisé`);
    const blocks = JSON.parse((await mcp.call('oriel_read_page', { pageId: host.id, format: 'blocks' })).texts[1]!);
    const types = blocks.map((b: { type: string }) => b.type);
    for (const t of ['heading', 'equation', 'breadcrumb', 'syncedBlock', 'tabs', 'html', 'button']) assert.ok(types.includes(t), `${t} dans ${types.join(', ')}`);
    assert.ok(!JSON.stringify(blocks).includes(foreign.id), 'no synced block of another workspace');
    // JSON path: same check.
    const json = await mcp.json('oriel_write_page_content', {
      pageId: host.id,
      mode: 'append',
      blocks: [{ type: 'syncedBlock', props: { syncedId: foreign.id } }, { type: 'syncedBlock', props: { syncedId: synced.id } }],
    });
    assert.ok(JSON.stringify(json.avertissements).includes(foreign.id), JSON.stringify(json));
    const after = JSON.parse((await mcp.call('oriel_read_page', { pageId: host.id, format: 'blocks' })).texts[1]!);
    assert.equal(after.filter((b: { type: string }) => b.type === 'syncedBlock').length, 2);
    assert.ok(!JSON.stringify(after).includes(foreign.id));
  });

  test('databases: place property, and feed / chart / dashboard / map / form views with validated settings', async () => {
    const db = await mcp.json('oriel_create_database', {
      parent: { type: 'workspace' },
      title: 'Chantiers',
      properties: [
        { name: 'Lieu', type: 'place' },
        { name: 'Type', type: 'select', options: ['Intérieur', 'Extérieur'] },
        { name: 'Budget', type: 'number', numberFormat: 'euro' },
        { name: 'Date', type: 'date' },
        { name: 'Confirmé', type: 'checkbox' },
        { name: 'Notes', type: 'text' },
        { name: 'Double', type: 'formula', formula: 'prop("Budget") * 2' },
      ],
    });
    assert.equal(db.proprietes.find((p: { nom: string }) => p.nom === 'Lieu').type, 'place');
    const rows = await mcp.json('oriel_create_rows', {
      databaseId: db.id,
      rows: [
        { title: 'Phare', properties: { Lieu: { adresse: 'Phare du Petit Minou, Plouzané', lat: 48.337, lng: -4.617 }, Type: 'Extérieur', Budget: 1200, Date: '2026-11-03' } },
        { title: 'Studio', properties: { Lieu: '12 rue de Siam, Brest', Type: 'Intérieur', Budget: 800 } },
      ],
    });
    assert.equal(rows.creees.length, 2, JSON.stringify(rows));
    const bad = await mcp.call('oriel_create_rows', { databaseId: db.id, rows: [{ title: 'X', properties: { Lieu: { adresse: 'Nulle part', lat: 120, lng: 0 } } }] }, { allowError: true });
    assert.ok(bad.isError || bad.texts.join('').includes('coordonnées'), bad.texts.join('\n'));
    const q = await mcp.json('oriel_query_database', { databaseId: db.id, sorts: [{ property: 'Budget', direction: 'desc' }] });
    assert.deepEqual(q.lignes.map((r: { proprietes: Record<string, unknown> }) => r.proprietes.Lieu), [
      { adresse: 'Phare du Petit Minou, Plouzané', lat: 48.337, lng: -4.617 },
      { adresse: '12 rue de Siam, Brest' },
    ]);

    const res = await mcp.json('oriel_update_database_schema', {
      databaseId: db.id,
      operations: [
        { action: 'add_view', name: 'Fil', type: 'feed', previewLines: 5 },
        { action: 'add_view', name: 'Budget par type', type: 'chart_bar', chart: { x: 'Type', aggregate: 'sum', value: 'Budget', sort: 'value_desc' } },
        { action: 'add_view', name: 'Par mois', type: 'chart_line', chart: { x: 'Date', xBucket: 'month' } },
        { action: 'add_view', name: 'Total', type: 'chart_number', chart: { aggregate: 'sum', value: 'Double' } },
        {
          action: 'add_view',
          name: 'Tableau de bord',
          type: 'dashboard',
          widgets: [{ type: 'chart_number', title: 'Lieux' }, { type: 'chart_donut', chart: { x: 'Type' } }, { type: 'list', limit: 3, sorts: [{ property: 'Budget', direction: 'desc' }] }],
        },
        { action: 'add_view', name: 'Carte', type: 'map', place: 'Lieu' },
        {
          action: 'add_view',
          name: 'Repérage',
          type: 'form',
          form: {
            title: 'Proposer un lieu',
            questions: [
              { property: 'Nom', required: true },
              { property: 'Type' },
              { property: 'Notes', label: 'Pourquoi dehors ?', showIf: { question: 'Type', value: 'Extérieur' } },
              { property: 'Lieu' },
            ],
            confirmation: 'Merci !',
          },
        },
      ],
    });
    assert.equal(res.fait.length, 7, JSON.stringify(res));
    const views = Object.fromEntries(res.vues.map((v: { nom: string }) => [v.nom, v]));
    assert.equal(views['Fil'].previewLines, 5);
    assert.deepEqual(views['Budget par type'].chart, { x: 'Type', aggregate: 'sum', value: 'Budget', sort: 'value_desc', showLegend: false, showLabels: true, hideEmpty: false });
    assert.equal(views['Par mois'].chart.xBucket, 'month');
    assert.equal(views['Total'].chart.x ?? null, null, 'no X axis (null values are omitted from the answers)');
    assert.deepEqual(views['Tableau de bord'].widgets.map((w: { type: string; w: number; h: number }) => [w.type, w.w, w.h]), [['chart_number', 1, 1], ['chart_donut', 2, 2], ['list', 1, 2]]);
    assert.equal(views['Carte'].place, 'Lieu');
    assert.deepEqual(views['Repérage'].form.questions[2], { property: 'Notes', label: 'Pourquoi dehors ?', required: false, showIf: { question: 'Type', value: 'Extérieur' } });
    assert.equal(views['Repérage'].form.public, false);
    // Described the same way by oriel_get_database.
    const got = await mcp.json('oriel_get_database', { databaseId: db.id });
    assert.deepEqual(got.vues.find((v: { nom: string }) => v.nom === 'Carte'), views['Carte']);

    // Validation against the schema (nothing is written on error).
    for (const [op, expected] of [
      [{ action: 'add_view', name: 'x', type: 'map', place: 'Notes' }, 'lieu'],
      [{ action: 'add_view', name: 'x', type: 'chart_bar', chart: { x: 'Type', aggregate: 'sum', value: 'Notes' } }, 'agrégée'],
      [{ action: 'add_view', name: 'x', type: 'chart_bar', chart: { x: 'Type', xBucket: 'month' } }, 'xBucket'],
      [{ action: 'add_view', name: 'x', type: 'form', form: { questions: [{ property: 'Double' }] } }, 'question'],
      [{ action: 'add_view', name: 'x', type: 'form', form: { questions: [{ property: 'Notes', showIf: { question: 'Type', value: 'Extérieur' } }] } }, 'précédente'],
      [{ action: 'add_view', name: 'x', type: 'table', place: 'Lieu' }, 'map'],
      [{ action: 'update_view', view: 'Repérage', form: { questions: [{ property: 'Type' }, { property: 'Notes', showIf: { question: 'Type', value: 'Plage' } }] } }, 'Plage'],
    ] as const) {
      const r = await mcp.call('oriel_update_database_schema', { databaseId: db.id, operations: [op] }, { allowError: true });
      assert.ok(r.isError && r.texts.join('').includes(expected), `${JSON.stringify(op)} → ${r.texts.join('\n')}`);
    }
    // Updates keep what is not given; isPublic is never set by the MCP.
    expectOk(await admin.patch(`/views/${views['Repérage'].id}`, { config: { form: { title: 'Proposer un lieu', questions: [], acceptResponses: true, isPublic: true } } }));
    const upd = await mcp.json('oriel_update_database_schema', {
      databaseId: db.id,
      operations: [
        { action: 'update_view', view: 'Repérage', form: { questions: [{ property: 'Nom', required: true }], acceptResponses: false } },
        { action: 'update_view', view: 'Budget par type', type: 'chart_number' },
        { action: 'delete_view', view: 'Fil' },
      ],
    });
    const after = Object.fromEntries(upd.vues.map((v: { nom: string }) => [v.nom, v]));
    assert.equal(after['Repérage'].form.public, true, 'publication is left as set in Oriel');
    assert.equal(after['Repérage'].form.acceptResponses, false);
    assert.equal(after['Repérage'].form.title, 'Proposer un lieu');
    assert.equal(after['Budget par type'].chart.x ?? null, null);
    assert.equal(after['Budget par type'].chart.value, 'Budget');
    assert.equal(after['Fil'], undefined);
  });

  test('comments, mentions and notifications', async () => {
    const page = await mcp.json('oriel_create_page', { parent: { type: 'workspace' }, title: 'À commenter' });
    const { client: carol, user } = await addMember(admin, wid, 'carol@oriel.test', 'Carol', 'member');
    const carolToken = await createToken(carol, { name: 'Claude de Carol', scope: 'read' });
    const carolMcp = await connectMcp(srv.base, carolToken.token);
    try {
      const added = await mcp.json('oriel_add_comment', { pageId: page.id, text: `Peux-tu relire, [@Carol](oriel://user/${user.id}) ?` });
      assert.ok(added.discussionId);
      await mcp.json('oriel_add_comment', { pageId: page.id, threadId: added.discussionId, text: 'Merci **beaucoup**' });
      const list = await carolMcp.json('oriel_list_comments', { pageId: page.id });
      assert.equal(list.discussions.length, 1);
      assert.deepEqual(
        list.discussions[0].commentaires.map((c: { auteur: string; texte: string }) => [c.auteur, c.texte]),
        [
          ['Alice Admin', 'Peux-tu relire, @Carol ?'],
          ['Alice Admin', 'Merci beaucoup'],
        ],
      );
      const notifs = await carolMcp.json('oriel_list_notifications', {});
      assert.ok((notifs.notifications ?? []).some((n: { type: string; page?: { id: string } }) => n.type === 'mention dans un commentaire' && n.page?.id === page.id));
      assert.ok(notifs.nonLues >= 1);
    } finally {
      await carolMcp.close();
    }
  });

  test('AI brief: latest brief (none yet)', async () => {
    const { texts } = await mcp.call('oriel_get_latest_brief', {});
    assert.match(texts[0]!, /Aucun brief/);
  });

  test('read-only tokens: reads work, writes are refused with a clear message', async () => {
    const list = await readOnly.json('oriel_list_pages', {});
    assert.ok(list.total > 0);
    for (const [name, args] of [
      ['oriel_create_page', { parent: { type: 'workspace' }, title: 'Non' }],
      ['oriel_create_database', { parent: { type: 'workspace' }, title: 'Non' }],
      ['oriel_trash_page', { pageId: list.pages[0].id }],
      ['oriel_write_page_content', { pageId: list.pages[0].id, markdown: 'x' }],
      ['oriel_add_comment', { pageId: list.pages[0].id, text: 'x' }],
    ] as const) {
      const res = await readOnly.call(name, args as Record<string, unknown>, { allowError: true });
      assert.equal(res.isError, true, name);
      assert.match(res.texts[0]!, /lecture seule/, name);
    }
  });

  test('revoked tokens: clear error', async () => {
    const t = await createToken(admin, { name: 'éphémère', scope: 'read' });
    const m = await connectMcp(srv.base, t.token);
    try {
      expectOk(await admin.del(`/me/tokens/${t.id}`));
      const res = await m.call('oriel_whoami', {}, { allowError: true });
      assert.equal(res.isError, true);
      assert.match(res.texts[0]!, /refusé/);
    } finally {
      await m.close();
    }
  });

  test('Streamable HTTP transport, protected by the bearer token', async () => {
    const t = await createToken(admin, { name: 'http', scope: 'read' });
    const http = await startHttpServer({ url: srv.base, token: t.token, workspace: null, host: '127.0.0.1', port: 0 });
    try {
      const connect = async (token: string) => {
        const client = new SdkClient({ name: 'http-test', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        return client;
      };
      const client = await connect(t.token);
      const res = (await client.callTool({ name: 'oriel_whoami', arguments: {} })) as { content: Array<{ text: string }> };
      assert.equal(JSON.parse(res.content[0]!.text).utilisateur.email, 'admin@oriel.test');
      await client.close();
      await assert.rejects(connect(`or_${'x'.repeat(43)}`));
      const anonymous = await fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(anonymous.status, 401);
    } finally {
      await http.close();
    }
    // Pass-through mode: each client brings its own Oriel token.
    const open = await startHttpServer({ url: srv.base, token: null, workspace: null, host: '127.0.0.1', port: 0 });
    try {
      const client = new SdkClient({ name: 'http-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(open.url), { requestInit: { headers: { authorization: `Bearer ${t.token}` } } }));
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 21);
      await client.close();
      const refused = await fetch(open.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer or_${'y'.repeat(43)}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
      });
      assert.equal(refused.status, 401);
    } finally {
      await open.close();
    }
  });
});
