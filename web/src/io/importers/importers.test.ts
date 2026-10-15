/// <reference types="node" />
// Confluence export + detection pipeline (Word, Excel) on generated fixtures.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { buildVfs } from '../vfs';
import { detectImporters } from './detect';

const page = (title: string, crumbs: string[], body: string) =>
  `<html><head><title>ESP : ${title}</title></head><body><ol id="breadcrumbs">${crumbs.map((c) => `<li><a href="${c}">x</a></li>`).join('')}</ol>
  <h1 id="title-heading"><span id="title-text">ESP : ${title}</span></h1><div id="main-content" class="wiki-content group">${body}</div></body></html>`;

describe('détection des importeurs', () => {
  test('Confluence : arborescence, encadré, pièce jointe', async () => {
    const zip = zipSync({
      'export/Accueil_1.html': strToU8(page('Accueil', [], '<p>Bonjour</p>')),
      'export/Enfant_2.html': strToU8(page('Enfant', ['Accueil_1.html'], '<div class="confluence-information-macro confluence-information-macro-note"><div class="confluence-information-macro-body"><p>Attention</p></div></div><p><img src="attachments/2/9.png"></p>')),
      'export/attachments/2/9.png': strToU8('PNG'),
    });
    const vfs = await buildVfs([{ path: 'conf.zip', blob: new Blob([zip as BlobPart]) }]);
    const d = await detectImporters(vfs);
    assert.deepEqual(d.formats, ['confluence']);
    const plan = d.plan!;
    assert.equal(plan.roots.length, 1);
    const root = plan.roots[0]!;
    assert.equal(root.title, 'Accueil');
    assert.equal(root.kind === 'page' && root.children[0]!.title, 'Enfant');
    const child = (root as import('../plan').PlanPage).children[0] as import('../plan').PlanPage;
    assert.equal(child.blocks![0]!.type, 'callout');
    assert.equal(child.blocks![1]!.type, 'image');
    assert.ok(String(child.blocks![1]!.props!.url).endsWith('9.png'));
  });
  test('fichiers inconnus : aucun plan', async () => {
    const vfs = await buildVfs([{ path: 'a.md', blob: new Blob(['# x']) }]);
    const d = await detectImporters(vfs);
    assert.equal(d.plan, null);
  });
});
