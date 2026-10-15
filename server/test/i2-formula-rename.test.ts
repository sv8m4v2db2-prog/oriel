// I2 (formules structurées): renaming a property rewrites page.prop("…") forms that name it, in its own
// database (self-relations) and in the other databases whose formulas walk relations to it.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseResponse, DatabaseSchema, PropertyDef } from '@oriel/shared';
import { Client, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('I2: rename rewrites page.prop() references across relations', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  const byName = (props: PropertyDef[], name: string) => {
    const p = props.find((x) => x.name === name);
    assert.ok(p, `property ${name}`);
    return p;
  };
  const schema = async (did: string) => expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;

  test('own database (self-relation) and a related database', async () => {
    const taches = (await createPage(admin, wid, { kind: 'database', title: 'Tâches', emptyDatabase: true })).id;
    const projets = (await createPage(admin, wid, { kind: 'database', title: 'Projets', emptyDatabase: true })).id;
    const add = async (did: string, property: Record<string, unknown>) =>
      expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties;
    await add(taches, { name: 'Statut', type: 'text' });
    await add(taches, { name: 'Sous-tâches', type: 'relation', relation: { databaseId: taches } });
    await add(taches, { name: 'Fini', type: 'formula', formula: 'prop("Sous-tâches").every(current.prop("Statut") == "Fait")' });
    await add(projets, { name: 'Statut', type: 'text' });
    await add(projets, { name: 'Tâches', type: 'relation', relation: { databaseId: taches } });
    await add(projets, { name: 'États', type: 'formula', formula: 'prop("Statut") + prop("Tâches").map(current.prop("Statut")).join()' });

    const statut = byName(await schema(taches), 'Statut');
    const res = expectOk(await admin.patch<DatabaseSchema>(`/databases/${taches}/properties/${statut.id}`, { name: 'État' }));
    assert.equal(byName(res.properties, 'Fini').formula, 'prop("Sous-tâches").every(current.prop("État") == "Fait")');
    // The project's own « Statut » is untouched; the tasks' one, read through the relation, is renamed.
    assert.equal(byName(await schema(projets), 'États').formula, 'prop("Statut") + prop("Tâches").map(current.prop("État")).join()');
  });
});
