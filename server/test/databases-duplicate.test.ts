// Duplicating an inline database block (⌘D in the editor) duplicates the database itself through
// POST /api/pages/:dbId/duplicate: same host page, still inline, own schema, views, rows and row content.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { DatabaseResponse, Page, PageContentResponse, RowsResponse, TreeResponse } from '@oriel/shared';
import { createPage, expectOk, setupAdmin, startTestServer, type Client, type TestServer } from './helpers.js';

function paragraphDoc(line: string): string {
  const doc = new Y.Doc();
  doc.transact(() => {
    const group = new Y.XmlElement('blockGroup');
    doc.getXmlFragment('blocknote').insert(0, [group]);
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', crypto.randomUUID());
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, line);
    paragraph.insert(0, [text]);
    container.insert(0, [paragraph]);
    group.insert(0, [container]);
  });
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

async function pageText(client: Client, pageId: string): Promise<string> {
  const { update } = expectOk(await client.get<PageContentResponse>(`/pages/${pageId}/content`));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(update, 'base64'));
  return doc.getXmlFragment('blocknote').toString();
}

describe('duplicating an inline database', () => {
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

  test('the copy is a separate inline database under the same page', async () => {
    const host = await createPage(admin, wid, { title: 'Cadrage' });
    const db = await createPage(admin, wid, { parentType: 'page', parentId: host.id, kind: 'database', title: 'Planning', isInline: true });
    const info = expectOk(await admin.get<DatabaseResponse>(`/databases/${db.id}`));
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${db.id}/rows`)).rows;
    expectOk(await admin.patch(`/pages/${rows[0]!.id}`, { title: 'Repérages' }));
    expectOk(await admin.put(`/pages/${rows[0]!.id}/content`, { update: paragraphDoc('Lieu : quai de Seine'), mode: 'replace' }));
    expectOk(await admin.post(`/databases/${db.id}/views`, { name: 'Calendrier', type: 'calendar' }));

    const copy = expectOk(await admin.post<Page>(`/pages/${db.id}/duplicate`));
    assert.notEqual(copy.id, db.id);
    assert.equal(copy.kind, 'database');
    assert.equal(copy.isInline, true);
    assert.equal(copy.parentType, 'page');
    assert.equal(copy.parentId, host.id);

    const copied = expectOk(await admin.get<DatabaseResponse>(`/databases/${copy.id}`));
    assert.deepEqual(copied.schema.properties, info.schema.properties);
    assert.deepEqual(
      copied.views.map((v) => [v.name, v.type]),
      [
        [info.views[0]!.name, info.views[0]!.type],
        ['Calendrier', 'calendar'],
      ],
    );
    assert.ok(copied.views.every((v) => v.databaseId === copy.id));
    const copiedRows = expectOk(await admin.get<RowsResponse>(`/databases/${copy.id}/rows`)).rows;
    assert.equal(copiedRows.length, rows.length);
    assert.ok(copiedRows.every((r) => r.parentId === copy.id && !rows.some((o) => o.id === r.id)));
    const reperages = copiedRows.find((r) => r.title === 'Repérages')!;
    assert.match(await pageText(admin, reperages.id), /quai de Seine/);

    // Independent: editing the copy leaves the original alone.
    expectOk(await admin.patch(`/pages/${reperages.id}`, { title: 'Repérages (version B)' }));
    const originalRows = expectOk(await admin.get<RowsResponse>(`/databases/${db.id}/rows`)).rows;
    assert.ok(originalRows.some((r) => r.title === 'Repérages'));
    assert.ok(!originalRows.some((r) => r.title === 'Repérages (version B)'));
    const tree = expectOk(await admin.get<TreeResponse>(`/workspaces/${wid}/tree`));
    assert.equal(tree.nodes.filter((p) => p.parentId === host.id && p.kind === 'database').length, 2);
  });
});
