// QA (security review) of the new database views: public and member forms, feed previews, geocoding
// proxy, map tiles. Each test reproduces a scenario probed during the review; findings are tagged
// QA-VIEW-xx, hypotheses that did not reproduce are kept as regression tests ("checked").
// Nothing leaves the machine: no geocoder is contacted (unit tests of the parsing / reduction only).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import type { CreatedApiToken, DatabaseResponse, DatabaseSchema, Page, PropertyDef, PublicFormsResponse, RowPreviewsResponse, RowsResponse, View } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type Res, type TestServer } from './helpers.js';
import { formTestHooks } from '../src/routes/forms.js';
import { parseMapTiles } from '../src/routes/databaseExtras.js';
import { parseGeocoderUrl, reduceResults } from '../src/services/geocode.js';

/** Request authenticated by `Authorization: Bearer …` only (no cookie). */
async function bearer<T = any>(base: string, token: string, method: string, url: string, body?: unknown): Promise<Res<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

describe('qa: database views', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let viewer: Client;
  let member: Client;

  before(async () => {
    formTestHooks.ipLimit = 1000;
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: viewer } = await addMember(admin, wid, 'qa-vues-lecteur@oriel.test', 'Lise', 'viewer'));
    ({ client: member } = await addMember(admin, wid, 'qa-vues-membre@oriel.test', 'Max', 'member'));
  });
  after(async () => {
    for (const k of Object.keys(formTestHooks)) delete (formTestHooks as Record<string, unknown>)[k];
    await srv.stop();
  });

  const newDb = async (title: string, extra: Record<string, unknown> = {}, c = admin) =>
    (await createPage(c, wid, { kind: 'database', title, emptyDatabase: true, ...extra })).id;
  const addProp = async (did: string, property: Record<string, unknown>, twoWay?: Record<string, unknown>) => {
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property, ...(twoWay ? { twoWay } : {}) }));
    return s.properties.find((p) => p.name === property.name)!;
  };
  const schemaOf = async (did: string) => expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
  const rowsOf = async (did: string) => expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
  const row = async (did: string, title: string, properties: Record<string, unknown> = {}) =>
    expectOk(await admin.post<Page>(`/databases/${did}/rows`, { title, properties }));
  const formView = async (did: string, questions: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    expectOk(
      await admin.post<View>(`/databases/${did}/views`, {
        name: 'Formulaire',
        type: 'form',
        config: { form: { questions, acceptResponses: true, ...extra } },
      }),
    );
  const viewOf = async (did: string, vid: string) => expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === vid)!;
  const anon = () => new Client(srv.base);

  // -------------------------------------------------------------------------------------------
  // QA-VIEW-01: a write API token could open an anonymous write path (form.isPublic) although
  // publishing a page is reserved to the cookie session (COOKIE_ONLY).
  // -------------------------------------------------------------------------------------------
  test('QA-VIEW-01: an API token cannot make a form public (create, update, duplicate)', async () => {
    const d = await newDb('Formulaires QA-VIEW-01');
    expectOk(await admin.post(`/pages/${d}/publish`, { isPublic: true }));
    const token = expectOk(await admin.post<CreatedApiToken>('/me/tokens', { name: 'qa-vues', scope: 'write' })).token;
    const questions = [{ id: 'nom', propertyId: 'title', required: true }];
    const privateForm = await formView(d, questions);

    // Update: false → true refused, nothing stored, the form stays closed to anonymous visitors.
    const patch = await bearer(srv.base, token, 'PATCH', `/views/${privateForm.id}`, { config: { form: { questions, acceptResponses: true, isPublic: true } } });
    assert.equal(patch.status, 403, `PATCH isPublic via token → ${patch.status}`);
    assert.notEqual((await viewOf(d, privateForm.id)).config.form!.isPublic, true);
    assert.equal((await anon().post(`/public/forms/${privateForm.id}/submit`, { answers: { nom: 'x' } })).status, 404);
    // Creation of an already public form refused too.
    const create = await bearer(srv.base, token, 'POST', `/databases/${d}/views`, {
      name: 'Public',
      type: 'form',
      config: { form: { questions, acceptResponses: true, isPublic: true } },
    });
    assert.equal(create.status, 403, `POST public form via token → ${create.status}`);
    // Other edits of a form stay possible with a token.
    expectOk(await bearer(srv.base, token, 'PATCH', `/views/${privateForm.id}`, { config: { form: { questions, acceptResponses: false, title: 'Brief' } } }));
    expectOk(await bearer(srv.base, token, 'POST', `/databases/${d}/views`, { name: 'Interne', type: 'form', config: { form: { questions, acceptResponses: true } } }));

    // The cookie session publishes; a token may then edit it (stays public) or close it, not re-open it.
    const pub = await formView(d, questions, { isPublic: true });
    expectOk(await bearer(srv.base, token, 'PATCH', `/views/${pub.id}`, { config: { form: { questions, acceptResponses: true, isPublic: true, title: 'Nouveau' } } }));
    assert.equal((await viewOf(d, pub.id)).config.form!.isPublic, true);
    // Duplicating a public form gives a private copy (publication is always an explicit act).
    const dup = expectOk(await bearer<View>(srv.base, token, 'POST', `/views/${pub.id}/duplicate`));
    assert.equal(dup.config.form!.isPublic, false, 'duplicated form is not public');
    assert.equal((await anon().post(`/public/forms/${dup.id}/submit`, { answers: { nom: 'x' } })).status, 404);
    const dupCookie = expectOk(await admin.post<View>(`/views/${pub.id}/duplicate`));
    assert.equal(dupCookie.config.form!.isPublic, false);
    // Closing through a token is allowed (safe direction).
    expectOk(await bearer(srv.base, token, 'PATCH', `/views/${pub.id}`, { config: { form: { questions, acceptResponses: true, isPublic: false } } }));
    assert.equal((await viewOf(d, pub.id)).config.form!.isPublic, false);
    assert.equal((await bearer(srv.base, token, 'PATCH', `/views/${pub.id}`, { config: { form: { questions, acceptResponses: true, isPublic: true } } })).status, 403);
    // Duplicating a page holding a linked block copies the block's views into the database: a public
    // form of the block is copied as a members-only form (no new anonymous endpoint by duplication).
    const linkId = randomUUID();
    expectOk(await admin.get(`/databases/${d}?linkId=${linkId}`));
    expectOk(await admin.post<View>(`/databases/${d}/views`, { name: 'Bloc', type: 'form', linkId, config: { form: { questions, acceptResponses: true, isPublic: true } } }));
    const host = await createPage(admin, wid, { title: 'Hôte du bloc lié' });
    const doc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', randomUUID());
    const block = new Y.XmlElement('linkedDatabase');
    block.setAttribute('databaseId', d);
    block.setAttribute('linkId', linkId);
    container.insert(0, [block]);
    group.insert(0, [container]);
    doc.getXmlFragment('blocknote').insert(0, [group]);
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare("INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, '', ?, '[]')").run(host.id, Y.encodeStateAsUpdate(doc), Date.now());
    } finally {
      raw.close();
    }
    expectOk(await bearer(srv.base, token, 'POST', `/pages/${host.id}/duplicate`));
    const raw2 = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      const copies = raw2
        .prepare("SELECT config FROM views WHERE database_id = ? AND type = 'form' AND link_id IS NOT NULL AND link_id != ?")
        .all(d, linkId) as Array<{ config: string }>;
      assert.equal(copies.length, 1);
      assert.notEqual(JSON.parse(copies[0]!.config).form.isPublic, true, 'linked public form copied as public');
    } finally {
      raw2.close();
    }
    // Duplicating the database page itself copies its native views: the public form is copied closed.
    await formView(d, questions, { isPublic: true });
    const dbCopy = expectOk(await admin.post<{ id: string }>(`/pages/${d}/duplicate`));
    const raw3 = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      const forms = raw3.prepare("SELECT config FROM views WHERE database_id = ? AND type = 'form' AND link_id IS NULL").all(dbCopy.id) as Array<{ config: string }>;
      assert.ok(forms.length > 0);
      for (const f of forms) assert.notEqual(JSON.parse(f.config).form?.isPublic, true, 'duplicated database keeps a public form');
    } finally {
      raw3.close();
    }
    // Changing the layout of a view to "form" with a public form config: refused as well.
    const table = expectOk(await admin.post<View>(`/databases/${d}/views`, { name: 'Table', type: 'table' }));
    assert.equal(
      (await bearer(srv.base, token, 'PATCH', `/views/${table.id}`, { type: 'form', config: { form: { questions, acceptResponses: true, isPublic: true } } })).status,
      403,
    );
  });

  // -------------------------------------------------------------------------------------------
  // QA-VIEW-02: a member who cannot edit (reader) answers a form as the database owner (formActor);
  // relation answers were then checked against the OWNER's visibility: the reader could link (and,
  // through a two-way relation, write into) rows of a database private to the owner.
  // -------------------------------------------------------------------------------------------
  test('QA-VIEW-02: member form answers only link rows the submitter can see', async () => {
    const shared = await newDb('Demandes QA-VIEW-02');
    const priv = await newDb('Privée QA-VIEW-02', { visibility: 'private' });
    const secret = await row(priv, 'Contrat confidentiel');
    const rel = await addProp(shared, { name: 'Lien', type: 'relation', relation: { databaseId: priv } }, { name: 'Demandes liées' });
    const back = (await schemaOf(priv)).find((p) => p.name === 'Demandes liées')!;
    const form = await formView(shared, [
      { id: 'nom', propertyId: 'title', required: true },
      { id: 'lien', propertyId: rel.id },
    ]);
    // Visible to the reader, which cannot see the private database.
    assert.equal((await viewer.get(`/pages/${secret.id}`)).status, 404);
    const res = await viewer.post(`/forms/${form.id}/submit`, { answers: { nom: 'Sonde lecteur', lien: [secret.id] } });
    const created = (await rowsOf(shared)).find((r) => r.title === 'Sonde lecteur');
    const linked = (created?.properties[rel.id] as string[] | undefined) ?? [];
    assert.ok(!linked.includes(secret.id), `reader linked an invisible row (HTTP ${res.status})`);
    const mirror = ((await rowsOf(priv)).find((r) => r.id === secret.id)!.properties[back.id] as string[] | undefined) ?? [];
    assert.deepEqual(mirror, [], 'no write into the private row through the mirror');
    // Same for an editor (submitter is the actor): already filtered by the relation sync.
    await member.post(`/forms/${form.id}/submit`, { answers: { nom: 'Sonde membre', lien: [secret.id] } });
    const m = (await rowsOf(shared)).find((r) => r.title === 'Sonde membre');
    assert.ok(!(((m?.properties[rel.id] as string[] | undefined) ?? []).includes(secret.id)));
    // The owner (who sees the private rows) still links them through the form.
    expectOk(await admin.post(`/forms/${form.id}/submit`, { answers: { nom: 'Par la propriétaire', lien: [secret.id] } }));
    assert.deepEqual((await rowsOf(shared)).find((r) => r.title === 'Par la propriétaire')!.properties[rel.id], [secret.id]);
    // A visible row of the target database is accepted for the reader.
    const visible = await newDb('Partagée QA-VIEW-02');
    const target = await row(visible, 'Projet visible');
    const rel2 = await addProp(shared, { name: 'Projet', type: 'relation', relation: { databaseId: visible } });
    const form2 = await formView(shared, [
      { id: 'nom', propertyId: 'title', required: true },
      { id: 'projet', propertyId: rel2.id },
    ]);
    expectOk(await viewer.post(`/forms/${form2.id}/submit`, { answers: { nom: 'Lecteur ok', projet: [target.id] } }));
    assert.deepEqual((await rowsOf(shared)).find((r) => r.title === 'Lecteur ok')!.properties[rel2.id], [target.id]);
  });

  // -------------------------------------------------------------------------------------------
  // QA-VIEW-03: feed previews served the first lines of TRASHED rows (public route included: a
  // visitor who noted a row id kept reading its content after the row was deleted).
  // -------------------------------------------------------------------------------------------
  test('QA-VIEW-03: feed previews never serve trashed rows (public and members)', async () => {
    const d = await newDb('Fil QA-VIEW-03');
    expectOk(await admin.post(`/pages/${d}/publish`, { isPublic: true }));
    const live = await row(d, 'Vivante');
    const gone = await row(d, 'Supprimée');
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      const put = raw.prepare("INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, ?, ?, '[]')");
      put.run(live.id, new Uint8Array(), 'Ligne publique', Date.now());
      put.run(gone.id, new Uint8Array(), 'Budget secret du chantier', Date.now());
    } finally {
      raw.close();
    }
    expectOk(await admin.post(`/pages/${gone.id}/trash`));
    const pub = expectOk(await anon().get<RowPreviewsResponse>(`/public/databases/${d}/previews?ids=${live.id},${gone.id}`));
    assert.deepEqual(pub.previews[live.id], { text: 'Ligne publique', comments: 0 });
    assert.equal(pub.previews[gone.id], undefined, 'public preview of a trashed row');
    const mem = expectOk(await viewer.get<RowPreviewsResponse>(`/databases/${d}/previews?ids=${live.id},${gone.id}`));
    assert.equal(mem.previews[gone.id], undefined, 'member preview of a trashed row');
    // A database in the trash keeps the previews of the rows trashed with it (its page is still shown).
    expectOk(await admin.post(`/pages/${d}/trash`));
    const inTrash = expectOk(await admin.get<RowPreviewsResponse>(`/databases/${d}/previews?ids=${live.id},${gone.id}`));
    assert.ok(inTrash.previews[live.id]);
    assert.equal(inTrash.previews[gone.id], undefined);
    assert.equal((await anon().get(`/public/databases/${d}/previews?ids=${live.id}`)).status, 404);
  });

  // -------------------------------------------------------------------------------------------
  // QA-VIEW-04 (fixed, user's decision of 2026-10-15): a public form required the database to be
  // published, so every answer (e-mail, phone of the respondents) was readable by anyone who had the
  // database link. A public form now works on an unpublished database, through its own definition
  // endpoint (GET /api/public/forms/:vid), which never carries rows.
  // -------------------------------------------------------------------------------------------
  test('QA-VIEW-04: a public form works without publishing its database; answers stay private', async () => {
    const d = await newDb('Inscriptions QA-VIEW-04');
    const mail = await addProp(d, { name: 'Courriel', type: 'email' });
    const form = await formView(d, [{ id: 'nom', propertyId: 'title', required: true }, { id: 'mail', propertyId: mail.id }], { isPublic: true });
    const def = await anon().get(`/public/forms/${form.id}`);
    assert.equal(def.status, 200, 'public form of an unpublished database');
    assert.deepEqual(expectOk(await anon().post(`/public/forms/${form.id}/submit`, { answers: { nom: 'Candidate', mail: 'candidate@exemple.fr' } })), { ok: true });
    assert.ok((await rowsOf(d)).some((r) => r.properties[mail.id] === 'candidate@exemple.fr'), 'answer stored');
    const row = (await rowsOf(d)).find((r) => r.title === 'Candidate')!;
    for (const url of [`/public/databases/${d}`, `/public/databases/${d}/rows`, `/public/databases/${d}/previews?ids=${row.id}`, `/public/pages/${d}`, `/public/pages/${row.id}`]) {
      const res = await anon().get(url);
      assert.equal(res.status, 404, `${url} → ${res.status}`);
      assert.ok(!JSON.stringify(res.body).includes('candidate@exemple.fr'));
    }
    assert.ok(!JSON.stringify(expectOk(await anon().get(`/public/forms/${form.id}`))).includes('candidate@exemple.fr'), 'answers in the form definition');
  });

  describe('QA-VIEW-04: public form definition (GET /api/public/forms/:vid)', () => {
    let d: string;
    let other: string;
    let props: Record<string, PropertyDef>;
    let form: View;
    before(async () => {
      d = await newDb('Définition publique');
      other = await newDb('Base cible');
      props = {
        statut: await addProp(d, { name: 'Statut', type: 'select', options: [{ id: 'opt1', name: 'Clip', color: 'blue' }, { id: 'opt2', name: 'Photo', color: 'red' }] }),
        mail: await addProp(d, { name: 'Courriel', type: 'email' }),
        cache: await addProp(d, { name: 'Note interne', type: 'text' }),
        personne: await addProp(d, { name: 'Responsable', type: 'person' }),
        relation: await addProp(d, { name: 'Projet lié', type: 'relation', relation: { databaseId: other } }),
        fichiers: await addProp(d, { name: 'Pièces', type: 'files' }),
        lieu: await addProp(d, { name: 'Adresse', type: 'place' }),
        formule: await addProp(d, { name: 'Calcul', type: 'formula', formula: '40 + 2' }),
        num: await addProp(d, { name: 'Numéro', type: 'unique_id', uniqueIdPrefix: 'SECRET' }),
      };
      form = await formView(
        d,
        [
          { id: 'nom', propertyId: 'title', required: true, label: 'Votre nom' },
          { id: 'statut', propertyId: props.statut!.id, description: 'Type de projet' },
          { id: 'mail', propertyId: props.mail!.id, showIf: { questionId: 'statut', value: 'opt1' } },
          { id: 'personne', propertyId: props.personne!.id, label: 'Question personne' },
          { id: 'relation', propertyId: props.relation!.id, label: 'Question relation' },
          { id: 'fichiers', propertyId: props.fichiers!.id, label: 'Question fichiers' },
          { id: 'lieu', propertyId: props.lieu!.id, label: 'Question lieu' },
          { id: 'formule', propertyId: props.formule!.id, label: 'Question formule' },
          { id: 'num', propertyId: props.num!.id, label: 'Question numéro' },
        ],
        { isPublic: true, title: 'Inscription', description: 'Présentez-vous', submitLabel: 'Envoyer', confirmation: 'Merci' },
      );
      await row(d, 'Ligne existante', { [props.mail!.id]: 'deja@exemple.fr', [props.cache!.id]: 'confidentiel' });
    });
    const getDef = (vid: string, c = anon()) => c.get<any>(`/public/forms/${vid}`);

    test('only the form texts, public questions and their properties: no rows, no other property or type', async () => {
      const def = expectOk(await getDef(form.id));
      assert.deepEqual(Object.keys(def).sort(), ['form', 'properties', 'view']);
      assert.deepEqual(def.view, { id: form.id, name: 'Formulaire' });
      assert.deepEqual(def.form, {
        questions: [
          { id: 'nom', propertyId: 'title', required: true, label: 'Votre nom' },
          { id: 'statut', propertyId: props.statut!.id, description: 'Type de projet' },
          { id: 'mail', propertyId: props.mail!.id, showIf: { questionId: 'statut', value: 'opt1' } },
        ],
        acceptResponses: true,
        isPublic: true,
        title: 'Inscription',
        description: 'Présentez-vous',
        submitLabel: 'Envoyer',
        confirmation: 'Merci',
      });
      assert.deepEqual(
        def.properties.map((p: PropertyDef) => [p.id, p.type]),
        [['title', 'title'], [props.statut!.id, 'select'], [props.mail!.id, 'email']],
      );
      assert.deepEqual(def.properties.find((p: PropertyDef) => p.type === 'select').options.map((o: { id: string; name: string }) => [o.id, o.name]), [['opt1', 'Clip'], ['opt2', 'Photo']]);
      const json = JSON.stringify(def);
      for (const leak of ['Ligne existante', 'deja@exemple.fr', 'confidentiel', 'Note interne', other, 'SECRET', '40 + 2', 'Question ', d]) {
        assert.ok(!json.includes(leak), `definition leaks ${leak}`);
      }
      for (const k of ['personne', 'relation', 'fichiers', 'lieu', 'formule', 'num']) {
        assert.ok(!json.includes(`"${props[k]!.id}"`) && !json.includes(props[k]!.name), `${k} property exposed`);
      }
    });

    test('404: unknown, non-form, members-only, trashed, inside a template; cookie of a member ignored', async () => {
      assert.equal((await getDef(randomUUID())).status, 404);
      const table = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views.find((v) => v.type === 'table')!;
      assert.equal((await getDef(table.id)).status, 404, 'table view');
      // Members-only form: 404 for an anonymous visitor and for a logged-in member alike (no session read).
      const internal = await formView(d, [{ id: 'nom', propertyId: 'title' }]);
      assert.equal((await getDef(internal.id)).status, 404);
      assert.equal((await getDef(internal.id, viewer)).status, 404);
      assert.equal((await getDef(internal.id, admin)).status, 404);
      // A public form closed again is 404; a closed (not accepting) one stays visible, its submissions 403.
      const toggled = await formView(d, [{ id: 'nom', propertyId: 'title' }], { isPublic: true });
      assert.equal((await getDef(toggled.id)).status, 200);
      expectOk(await admin.patch(`/views/${toggled.id}`, { config: { form: { questions: [{ id: 'nom', propertyId: 'title' }], acceptResponses: true, isPublic: false } } }));
      assert.equal((await getDef(toggled.id)).status, 404);
      assert.equal((await anon().post(`/public/forms/${toggled.id}/submit`, { answers: { nom: 'x' } })).status, 404);
      const shut = await formView(d, [{ id: 'nom', propertyId: 'title' }], { isPublic: true, acceptResponses: false });
      assert.equal(expectOk(await getDef(shut.id)).form.acceptResponses, false);
      assert.equal((await anon().post(`/public/forms/${shut.id}/submit`, { answers: { nom: 'x' } })).status, 403);
      // Database in the trash, then restored.
      const t = await newDb('Définition corbeille');
      const tf = await formView(t, [{ id: 'nom', propertyId: 'title' }], { isPublic: true });
      assert.equal((await getDef(tf.id)).status, 200);
      expectOk(await admin.post(`/pages/${t}/trash`));
      assert.equal((await getDef(tf.id)).status, 404);
      assert.equal((await anon().post(`/public/forms/${tf.id}/submit`, { answers: { nom: 'x' } })).status, 404);
      // Ancestor in the trash.
      const parent = await createPage(admin, wid, { title: 'Parent corbeille' });
      const nested = (await createPage(admin, wid, { kind: 'database', title: 'Base imbriquée', emptyDatabase: true, parentType: 'page', parentId: parent.id })).id;
      const nf = await formView(nested, [{ id: 'nom', propertyId: 'title' }], { isPublic: true });
      assert.equal((await getDef(nf.id)).status, 200);
      expectOk(await admin.post(`/pages/${parent.id}/trash`));
      assert.equal((await getDef(nf.id)).status, 404);
      assert.equal((await anon().post(`/public/forms/${nf.id}/submit`, { answers: { nom: 'x' } })).status, 404);
      // Database nested in a row template (never public, published tree or not).
      const host = await newDb('Hôte modèle définition');
      const tpl = expectOk(await admin.post<Page>(`/databases/${host}/templates`, { title: 'Modèle' }));
      const inner = (await createPage(admin, wid, { kind: 'database', title: 'Base du modèle', emptyDatabase: true, parentType: 'page', parentId: tpl.id })).id;
      const innerForm = await formView(inner, [{ id: 'nom', propertyId: 'title' }], { isPublic: true });
      assert.equal((await getDef(innerForm.id)).status, 404);
      assert.equal((await anon().post(`/public/forms/${innerForm.id}/submit`, { answers: { nom: 'x' } })).status, 404);
    });

    test('linked database block: its own public form only', async () => {
      const linkId = randomUUID();
      expectOk(await admin.get(`/databases/${d}?linkId=${linkId}`));
      const q = [{ id: 'nom', propertyId: 'title' }];
      const closedLinked = expectOk(await admin.post<View>(`/databases/${d}/views`, { name: 'Bloc interne', type: 'form', linkId, config: { form: { questions: q, acceptResponses: true } } }));
      assert.equal((await getDef(closedLinked.id)).status, 404);
      const openLinked = expectOk(await admin.post<View>(`/databases/${d}/views`, { name: 'Bloc public', type: 'form', linkId, config: { form: { questions: q, acceptResponses: true, isPublic: true } } }));
      assert.equal(expectOk(await getDef(openLinked.id)).view.name, 'Bloc public');
      expectOk(await anon().post(`/public/forms/${openLinked.id}/submit`, { answers: { nom: 'Par le bloc lié' } }));
      assert.ok((await rowsOf(d)).some((r) => r.title === 'Par le bloc lié'));
    });
  });

  // -------------------------------------------------------------------------------------------
  // QA-VIEW-05: views of a linked database block are keyed by a client-chosen linkId and are not
  // tied to a host page. Since QA-VIEW-04 a public form no longer needs a published database: a public
  // form of a linked block whose block is gone (host page deleted, block removed) or never existed
  // (view created through the API) stayed an anonymous write path that the database never listed.
  // Every public form of a database, linked views included, is now listed and can be closed.
  // -------------------------------------------------------------------------------------------
  test('QA-VIEW-05: every public form of a database (linked views included) is listed and can be closed', async () => {
    const d = await newDb('Base QA-VIEW-05');
    const q = [{ id: 'nom', propertyId: 'title' }];
    const linkId = randomUUID(); // no page holds a block with this link
    const hidden = expectOk(
      await admin.post<View>(`/databases/${d}/views`, {
        name: 'Formulaire caché',
        type: 'form',
        linkId,
        config: { form: { questions: q, acceptResponses: true, isPublic: true } },
      }),
    );
    const native = await formView(d, q, { isPublic: true, acceptResponses: false });
    await formView(d, q); // members only: not listed
    expectOk(await anon().post(`/public/forms/${hidden.id}/submit`, { answers: { nom: 'Réponse orpheline' } }));

    // Listed for every member who sees the database (readers included), with the linked block id.
    for (const c of [admin, viewer, member]) {
      const { forms } = expectOk(await c.get<PublicFormsResponse>(`/databases/${d}/public-forms`));
      assert.deepEqual(
        forms.map((f) => [f.id, f.linkId, f.acceptResponses]).sort(),
        [
          [hidden.id, linkId, true],
          [native.id, null, false],
        ].sort(),
      );
    }
    // Invisible database: 404, nothing listed.
    const priv = await newDb('Privée QA-VIEW-05', { visibility: 'private' });
    await formView(priv, q, { isPublic: true });
    assert.equal((await member.get(`/databases/${priv}/public-forms`)).status, 404);
    assert.equal((await anon().get(`/databases/${d}/public-forms`)).status, 401);

    // Closing: edit access required (a reader cannot), invisible view → 404.
    assert.equal((await viewer.post(`/views/${hidden.id}/close-public-form`)).status, 403);
    const privForm = expectOk(await admin.get<PublicFormsResponse>(`/databases/${priv}/public-forms`)).forms[0]!;
    assert.equal((await member.post(`/views/${privForm.id}/close-public-form`)).status, 404);
    const closed = expectOk(await member.post<View>(`/views/${hidden.id}/close-public-form`));
    assert.equal(closed.config.form!.isPublic, false);
    assert.deepEqual(closed.config.form!.questions, q, 'questions kept');
    assert.equal((await anon().get(`/public/forms/${hidden.id}`)).status, 404);
    assert.equal((await anon().post(`/public/forms/${hidden.id}/submit`, { answers: { nom: 'Trop tard' } })).status, 404);
    // Closing is the safe direction: allowed with an API token too; idempotent.
    const token = expectOk(await admin.post<CreatedApiToken>('/me/tokens', { name: 'qa-vues-05', scope: 'write' })).token;
    expectOk(await bearer(srv.base, token, 'POST', `/views/${native.id}/close-public-form`));
    expectOk(await member.post(`/views/${native.id}/close-public-form`));
    assert.deepEqual(expectOk(await admin.get<PublicFormsResponse>(`/databases/${d}/public-forms`)).forms, []);
    assert.ok(!(await rowsOf(d)).some((r) => r.title === 'Trop tard'));
  });

  // -------------------------------------------------------------------------------------------
  // Checked hypotheses (no defect found): kept as regression tests.
  // -------------------------------------------------------------------------------------------
  describe('checked: forms', () => {
    let d: string;
    let props: Record<string, PropertyDef>;
    let form: View;
    let other: string;
    before(async () => {
      d = await newDb('Contrôles formulaires');
      other = await newDb('Autre base');
      props = {
        texte: await addProp(d, { name: 'Texte', type: 'text' }),
        personne: await addProp(d, { name: 'Personne', type: 'person' }),
        relation: await addProp(d, { name: 'Relation', type: 'relation', relation: { databaseId: other } }),
        fichiers: await addProp(d, { name: 'Fichiers', type: 'files' }),
        lieu: await addProp(d, { name: 'Lieu', type: 'place' }),
        formule: await addProp(d, { name: 'Formule', type: 'formula', formula: '1' }),
        num: await addProp(d, { name: 'Numéro', type: 'unique_id' }),
      };
      form = await formView(
        d,
        [
          { id: 'nom', propertyId: 'title', required: true },
          { id: 'texte', propertyId: props.texte!.id },
          { id: 'personne', propertyId: props.personne!.id, required: true },
          { id: 'relation', propertyId: props.relation!.id },
          { id: 'fichiers', propertyId: props.fichiers!.id },
          { id: 'lieu', propertyId: props.lieu!.id },
          { id: 'formule', propertyId: props.formule!.id },
          { id: 'num', propertyId: props.num!.id },
          { id: 'boucle1', propertyId: props.texte!.id, showIf: { questionId: 'boucle2', value: 'x' }, required: true },
          { id: 'boucle2', propertyId: props.texte!.id, showIf: { questionId: 'boucle1', value: 'x' }, required: true },
        ],
        { isPublic: true },
      );
      expectOk(await admin.post(`/pages/${d}/publish`, { isPublic: true }));
    });
    const submit = (answers: Record<string, unknown>, c = anon()) => c.post(`/public/forms/${form.id}/submit`, { answers });

    test('anonymous answers: no people, relations, files, places, computed values, forged keys; cyclic showIf ignored', async () => {
      const before = (await rowsOf(d)).length;
      for (const [key, value] of Object.entries({
        personne: ['x'],
        relation: [crypto.randomUUID()],
        fichiers: [{ name: 'a', url: '/api/files/x/a' }],
        lieu: { address: 'Paris', lat: 1, lng: 2 },
        formule: 'forgé',
        num: 42,
        title: 'Titre forgé',
        [props.texte!.id]: 'clé de propriété',
      })) {
        const res = await anon().post(`/public/forms/${form.id}/submit`, { answers: { nom: 'Sonde', [key]: value } });
        assert.equal(res.status, 400, `${key} accepted from an anonymous visitor`);
      }
      // `__proto__` / `constructor` keys are dropped by the JSON body parser (no answer injected through
      // an inherited key, no prototype pollution).
      const proto = await anon().req('POST', `/public/forms/${form.id}/submit`, undefined, {
        contentType: 'application/json',
        rawBody: '{"answers":{"__proto__":{"nom":"Hérité","texte":"x"},"constructor":{"prototype":{"pollue":1}}}}',
      });
      assert.equal(proto.status, 400, 'required title missing: inherited answers ignored');
      assert.equal(({} as Record<string, unknown>).pollue, undefined);
      // Required person question is not asked anonymously; the cyclic conditional questions are hidden.
      const ok = await submit({ nom: 'Simple', texte: 'ok' });
      assert.deepEqual(ok.body, { ok: true });
      assert.equal((await rowsOf(d)).length, before + 1);
      // Over-long values are refused (no truncation into the database).
      assert.equal((await submit({ nom: 'x', texte: 'y'.repeat(10_001) })).status, 400);
    });

    test('forms of trashed / unpublished / template databases and non-form views are 404', async () => {
      const t = await newDb('Corbeille formulaire');
      const f = await formView(t, [{ id: 'nom', propertyId: 'title' }], { isPublic: true });
      expectOk(await admin.post(`/pages/${t}/publish`, { isPublic: true }));
      expectOk(await anon().post(`/public/forms/${f.id}/submit`, { answers: { nom: 'avant' } }));
      expectOk(await admin.post(`/pages/${t}/trash`));
      assert.equal((await anon().post(`/public/forms/${f.id}/submit`, { answers: { nom: 'après' } })).status, 404);
      assert.equal((await viewer.post(`/forms/${f.id}/submit`, { answers: { nom: 'après' } })).status, 404);
      // A private database (owner only) behind a published parent stays published (owner's choice), but its
      // form is invisible to the other members.
      const p = await newDb('Privée formulaire', { visibility: 'private' });
      const pf = await formView(p, [{ id: 'nom', propertyId: 'title' }]);
      assert.equal((await viewer.post(`/forms/${pf.id}/submit`, { answers: { nom: 'x' } })).status, 404);
      assert.equal((await anon().post(`/public/forms/${pf.id}/submit`, { answers: { nom: 'x' } })).status, 404);
      // A table view of a published database is not a form.
      const table = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views.find((v) => v.type === 'table')!;
      assert.equal((await anon().post(`/public/forms/${table.id}/submit`, { answers: {} })).status, 404);
      // A database nested in a row template is never public, even inside a published tree.
      const host = await newDb('Hôte modèle');
      expectOk(await admin.post(`/pages/${host}/publish`, { isPublic: true }));
      const tpl = expectOk(await admin.post<Page>(`/databases/${host}/templates`, { title: 'Modèle' }));
      const inner = (await createPage(admin, wid, { kind: 'database', title: 'Base du modèle', emptyDatabase: true, parentType: 'page', parentId: tpl.id })).id;
      const innerForm = await formView(inner, [{ id: 'nom', propertyId: 'title' }], { isPublic: true });
      assert.equal((await anon().post(`/public/forms/${innerForm.id}/submit`, { answers: { nom: 'x' } })).status, 404);
    });

    test('public route: bare confirmation, logged-in member not author, no e-mail address answered back', async () => {
      const res = await viewer.post(`/public/forms/${form.id}/submit`, { answers: { nom: 'Par une lectrice' } });
      assert.deepEqual(res.body, { ok: true });
      const r = (await rowsOf(d)).find((x) => x.title === 'Par une lectrice')!;
      const viewerId = expectOk(await viewer.get<{ user: { id: string } }>('/auth/me')).user.id;
      assert.notEqual(r.createdBy, viewerId);
    });
  });

  describe('checked: previews', () => {
    test('ids of other databases, templates and unpublished databases give nothing; ids capped', async () => {
      const d = await newDb('Fil contrôles');
      const o = await newDb('Fil autre');
      expectOk(await admin.post(`/pages/${d}/publish`, { isPublic: true }));
      const r = await row(d, 'Ligne');
      const foreign = await row(o, 'Ligne d’une autre base');
      const tpl = expectOk(await admin.post<Page>(`/databases/${d}/templates`, { title: 'Modèle' }));
      const res = expectOk(await anon().get<RowPreviewsResponse>(`/public/databases/${d}/previews?ids=${r.id},${foreign.id},${tpl.id},${d}`));
      assert.deepEqual(Object.keys(res.previews), [r.id]);
      assert.equal((await anon().get(`/public/databases/${o}/previews?ids=${foreign.id}`)).status, 404);
      // Public previews never carry comment counts.
      assert.equal(res.previews[r.id]!.comments, 0);
      // More than 100 ids (or an over-long list) is refused / truncated.
      const many = [...Array.from({ length: 100 }, () => crypto.randomUUID()), r.id].join(',');
      assert.deepEqual(Object.keys(expectOk(await anon().get<RowPreviewsResponse>(`/public/databases/${d}/previews?ids=${many}`)).previews), []);
      assert.equal((await anon().get(`/public/databases/${d}/previews?ids=${'a'.repeat(4001)}`)).status, 400);
    });
  });

  describe('checked: geocoder and map tiles (unit)', () => {
    test('geocoder answer reduced to bounded text and finite, in-range coordinates', () => {
      const out = reduceResults([
        { display_name: 'ok', lat: '48.85', lon: '2.35' },
        { display_name: 'nan', lat: 'NaN', lon: '2' },
        { display_name: 'inf', lat: 'Infinity', lon: '2' },
        { display_name: 'range', lat: '91', lon: '2' },
        { display_name: { toString: () => 'objet' }, lat: '1', lon: '2' },
        { display_name: 'a\u0000b<script>'.padEnd(1000, 'x'), lat: 1, lon: 2 },
        null,
        'texte',
      ]);
      assert.equal(out.length, 2);
      assert.deepEqual(out[0], { address: 'ok', lat: 48.85, lng: 2.35 });
      assert.equal(out[1]!.address.length, 300);
      assert.ok(!out[1]!.address.includes('\u0000'));
      assert.deepEqual(reduceResults({ not: 'an array' }), []);
      assert.equal(reduceResults(Array.from({ length: 50 }, () => ({ display_name: 'x', lat: 1, lon: 1 }))).length, 5);
    });

    test('GEOCODER_URL: http(s) only, no credentials / query / fragment; the query is encoded', () => {
      assert.equal(parseGeocoderUrl(''), null);
      for (const bad of ['file:///etc/passwd', 'ftp://geo.test', 'https://u:p@geo.test', 'https://geo.test/?key=1', 'https://geo.test/#x', 'pas une url']) {
        assert.throws(() => parseGeocoderUrl(bad), Error, bad);
      }
      assert.equal(parseGeocoderUrl('https://geo.test/nominatim/')!.href, 'https://geo.test/nominatim');
    });

    test('MAP_TILE_URL: https or same-origin path only, no CSP / HTML injection characters', () => {
      for (const bad of [
        'http://tiles.test/{z}/{x}/{y}.png',
        '//tiles.test/{z}/{x}/{y}.png',
        'javascript:alert(1)//{z}{x}{y}',
        'data:image/png;base64,{z}{x}{y}',
        "https://tiles.test/{z}/{x}/{y}.png; script-src 'unsafe-inline'",
        'https://tiles.test/{z}/{x}/{y}.png"><img src=x onerror=alert(1)>',
        'https://tiles.test/{z}/{x}/{y}.png\nimg-src *',
        'https://u:p@tiles.test/{z}/{x}/{y}.png',
        'https://tiles.test/{z}/{x}/{y}/{evil}.png',
        'https://tiles.test/{z}/{x}.png',
      ]) {
        assert.throws(() => parseMapTiles({ url: bad }), Error, bad);
      }
      assert.equal(parseMapTiles({ url: 'off' }), null);
      assert.equal(parseMapTiles({ url: '/tiles/{z}/{x}/{y}.png' })!.url, '/tiles/{z}/{x}/{y}.png');
      // The attribution is plain text (control characters removed, length capped); escaped by the client.
      const t = parseMapTiles({ url: 'https://tiles.test/{z}/{x}/{y}.png', attribution: '<b>x</b>\u0007'.padEnd(500, 'y') })!;
      assert.equal(t.attribution.length, 300);
      assert.throws(() => parseMapTiles({ maxZoom: '1e9' }));
    });
  });
});
