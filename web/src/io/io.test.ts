/// <reference types="node" />
// Import planning and CSV inference (DOM-free parts of the import/export module).
// Run: node --test --import tsx web/src/io/io.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { cellToValue, detectDecimal, formatCell, inferColumn, parseCsv, parseDateText, parseNumberText } from './csv';
import { extractPropertyHeader, extractTitle, findLinks, relativeHref, resolveHref, segmentMarkdown } from './markdown';
import { parseEntryName, planImport, type PlanDatabase, type PlanPage } from './plan';
import { decodeText, fixMojibake, safeName } from './text';
import { buildVfs } from './vfs';
import { sampleExportZip } from './fixtures/sampleExport';

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

describe('names and text', () => {
  test('entry names with ids', () => {
    assert.deepEqual(parseEntryName('Projet Oriel 0123456789abcdef0123456789abcdef.md'), {
      title: 'Projet Oriel',
      id: '0123456789abcdef0123456789abcdef',
      ext: 'md',
      all: false,
    });
    assert.deepEqual(parseEntryName('Tâches 0123456789ABCDEF0123456789abcdef_all.csv'), {
      title: 'Tâches',
      id: '0123456789abcdef0123456789abcdef',
      ext: 'csv',
      all: true,
    });
    assert.equal(parseEntryName('Sans identifiant.md').id, null);
    assert.equal(parseEntryName('Dossier 0123456789abcdef0123456789abcdef', true).title, 'Dossier');
  });
  test('decoding and repairs', () => {
    assert.equal(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62])), 'a\nb');
    assert.equal(decodeText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])), 'café'); // Windows-1252
    assert.equal(fixMojibake('CafÃ©'), 'Café');
    assert.equal(fixMojibake('Café'), 'Café');
    assert.equal(safeName('a/b: c?'), 'a b c');
    assert.equal(safeName('  '), 'Sans titre');
    assert.equal(safeName('CON'), 'CON_');
  });
});

describe('markdown helpers', () => {
  test('title, property header, links', () => {
    const { title, body } = extractTitle('\n# Ma tâche\n\nStatut: En cours\nNote: x\n\nTexte: libre');
    assert.equal(title, 'Ma tâche');
    const header = extractPropertyHeader(body, (k) => ['statut', 'note'].includes(k.toLowerCase()));
    assert.deepEqual(header.props, [
      ['Statut', 'En cours'],
      ['Note', 'x'],
    ]);
    assert.equal(header.body.trim(), 'Texte: libre');
    const links = findLinks('Voir [A](A%20b.md) ici\n\n[Base](Dossier/Base%20c.csv)\n![img](x/y.png)');
    assert.deepEqual(
      links.map((l) => [l.text, l.href, l.alone, l.image]),
      [
        ['A', 'A%20b.md', false, false],
        ['Base', 'Dossier/Base%20c.csv', true, false],
        ['img', 'x/y.png', true, true],
      ],
    );
    assert.deepEqual(resolveHref('../B%C3%A9b%C3%A9.md', 'Dossier/Page.md'), { kind: 'path', path: 'Bébé.md' });
    assert.equal(resolveHref('https://x.y', 'a.md').kind, 'external');
    assert.equal(relativeHref('A/B/page.md', 'A/C/d e.md'), '../C/d%20e.md');
    assert.equal(relativeHref('page.md', 'fichiers/x.png'), 'fichiers/x.png');
  });
  test('callouts and toggles', () => {
    const segs = segmentMarkdown('Avant\n\n<aside>\n💡 Astuce **utile**\n</aside>\n\n<details>\n<summary>Plus</summary>\n\nCaché\n\n</details>\nAprès');
    assert.deepEqual(
      segs.map((s) => s.type),
      ['markdown', 'callout', 'toggle', 'markdown'],
    );
    assert.deepEqual(segs[1], { type: 'callout', emoji: '💡', text: 'Astuce **utile**' });
    assert.equal(segs[2]!.type === 'toggle' && segs[2]!.summary, 'Plus');
  });
});

describe('CSV inference', () => {
  test('values', () => {
    assert.deepEqual(parseDateText('October 13, 2026'), { start: '2026-10-13' });
    assert.deepEqual(parseDateText('13 octobre 2026 à 14h30'), { start: '2026-10-13T14:30', includeTime: true });
    assert.deepEqual(parseDateText('October 13, 2026 3:04 PM'), { start: '2026-10-13T15:04', includeTime: true });
    assert.deepEqual(parseDateText('October 13, 2026 → October 15, 2026'), { start: '2026-10-13', end: '2026-10-15' });
    assert.deepEqual(parseDateText('03/04/2026'), { start: '2026-04-03' });
    assert.deepEqual(parseDateText('03/04/2026', false), { start: '2026-03-04' });
    assert.deepEqual(parseDateText('@2026-10-13'), { start: '2026-10-13' });
    assert.equal(parseDateText('31/02/2026'), null);
    assert.equal(parseDateText('bonjour'), null);
    assert.equal(parseNumberText('€1,200.50')!.value, 1200.5);
    assert.equal(parseNumberText('1 200,50 €', ',')!.value, 1200.5);
    assert.equal(parseNumberText('42%')!.percent, true);
    assert.equal(parseNumberText('-3.5')!.value, -3.5);
    assert.equal(parseNumberText('06 12 34 56 78'), null);
    assert.equal(parseNumberText('12 rue'), null);
    assert.equal(detectDecimal(['1,5', '2']), ',');
  });
  test('column types', () => {
    const col = (name: string, values: string[], ctx = {}) => inferColumn(1, name, values, ctx);
    assert.equal(col('Fait', ['Yes', 'No', '']).type, 'checkbox');
    assert.equal(col('Actif', ['Oui', 'Non']).type, 'checkbox');
    assert.equal(col('Échéance', ['October 13, 2026', '', '13 octobre 2026']).type, 'date');
    const n = col('Budget', ['€1,200.50', '€300']);
    assert.deepEqual([n.type, n.numberFormat], ['number', 'euro']);
    assert.equal(col('Taux', ['12%', '50 %']).numberFormat, 'percent');
    assert.equal(col('Site', ['https://a.fr', 'www.b.fr']).type, 'url');
    assert.equal(col('Mail', ['a@b.fr', 'c@d.com']).type, 'email');
    assert.equal(col('Tél', ['+33 6 12 34 56 78', '01 23 45 67 89']).type, 'phone');
    const multi = col('Étiquettes', ['doc, interne', 'ops, interne', 'démo']);
    assert.equal(multi.type, 'multi_select');
    assert.deepEqual(multi.options!.map((o) => o.name), ['doc', 'interne', 'ops', 'démo']);
    const sel = col('Priorité', ['Haute', 'Moyenne', 'Haute']);
    assert.equal(sel.type, 'select');
    assert.equal(sel.options!.length, 2);
    const status = col('Statut', ['En cours', 'Terminé', 'Pas commencé']);
    assert.equal(status.type, 'status');
    assert.deepEqual(status.options!.map((o) => o.group), ['in_progress', 'done', 'todo']);
    assert.equal(col('Notes', ['Une longue note libre', 'Une autre note']).type, 'text');
    assert.equal(col('Lié', ['Projet (../Projet%20abc.md)']).note, 'relation importée comme texte');
    const members = [{ id: 'u1', name: 'Alice Martin', email: 'alice@exemple.fr' }];
    assert.equal(col('Responsable', ['Alice Martin', ''], { members }).type, 'person');
    // Person names that are not all members stay plain text.
    assert.equal(col('Responsable', ['Alice Martin', 'Jean Inconnu'], { members }).type, 'text');
    assert.deepEqual(cellToValue(col('Responsable', ['alice martin'], { members }), 'Alice Martin', undefined, members), ['u1']);
    assert.equal(cellToValue(sel, 'haute', sel.options), sel.options![0]!.id);
    assert.equal(cellToValue(col('Lié', ['x (a.md)']), 'Projet (../Projet%20abc.md)', undefined), 'Projet');
  });
  test('CSV parsing and export cells', () => {
    assert.deepEqual(parseCsv('﻿a;b\n1;"x;y"\n\n'), [
      ['a', 'b'],
      ['1', 'x;y'],
    ]);
    const ctx = {
      userName: () => 'Alice',
      relationTitle: () => 'Cible',
      fileHref: (u: string) => `fichiers/${u.split('/').pop()}`,
      row: { title: 'Ligne', createdAt: 0, updatedAt: 0, createdBy: 'u', updatedBy: 'u' },
    };
    assert.equal(formatCell({ id: 'd', name: 'D', type: 'date' }, { start: '2026-10-13', end: '2026-10-15' }, ctx), '2026-10-13 → 2026-10-15');
    assert.equal(formatCell({ id: 'c', name: 'C', type: 'checkbox' }, true, ctx), 'Oui');
    assert.equal(
      formatCell({ id: 'm', name: 'M', type: 'multi_select', options: [{ id: 'a', name: 'A', color: 'red' }, { id: 'b', name: 'B', color: 'blue' }] }, ['b', 'a'], ctx),
      'B, A',
    );
    assert.equal(formatCell({ id: 'f', name: 'F', type: 'files' }, [{ name: 'x.png', url: '/api/files/1/x.png' }], ctx), 'fichiers/x.png');
    assert.equal(formatCell({ id: 'n', name: 'N', type: 'number', numberFormat: 'percent' }, 42, ctx), '42%');
  });
});

describe('import planning', () => {
  test('sample export of the previous tool (nested zip, ids, _all.csv, row pages)', async () => {
    const vfs = await buildVfs([{ path: 'Export.zip', blob: blobOf(sampleExportZip()) }]);
    const plan = await planImport(vfs);
    assert.equal(plan.format, 'notion');
    assert.deepEqual(plan.counts, { pages: 6, databases: 2, rows: 6, attachments: 3 });
    assert.deepEqual(
      plan.roots.map((n) => `${n.kind}:${n.title}`),
      ['page:Archives', 'database:Contacts', 'page:Journal 🗓️', 'page:Projet Oriel ❄️', 'page:Q&A « spécial » été'].sort((a, b) =>
        a.split(':')[1]!.localeCompare(b.split(':')[1]!, 'fr'),
      ),
    );
    const projet = plan.roots.find((n) => n.title === 'Projet Oriel ❄️') as PlanPage;
    // Children ordered like the page links them.
    assert.deepEqual(
      projet.children.map((c) => c.title),
      ['Notes de réunion', 'Tâches'],
    );
    const taches = projet.children[1] as PlanDatabase;
    assert.equal(taches.inline, true);
    assert.match(taches.csvPath!, /_all\.csv$/);
    assert.deepEqual(
      taches.rows.map((r) => [r.title, !!r.mdPath]),
      [
        ['Rédiger la doc', true],
        ['Déployer le serveur', true],
        ['Préparer la démo', false],
      ],
    );
    assert.equal(taches.headers[0], 'Nom');
    const contacts = plan.roots.find((n) => n.kind === 'database') as PlanDatabase;
    assert.equal(contacts.inline, false);
    assert.equal(contacts.rows.length, 3);
    // Every page, row page and CSV (both variants) is addressable by path for link rewriting.
    assert.equal(plan.pathIndex.size, 10);
  });

  test('plain markdown files and a lone CSV', async () => {
    const vfs = await buildVfs([
      { path: 'Notes/Idées.md', blob: new Blob(['# Mes idées\n\nTexte']) },
      { path: 'Notes/Idées/Détail.md', blob: new Blob(['Sans titre de niveau 1']) },
      { path: 'Notes/Budget.csv', blob: new Blob(['Poste;Montant\nLoyer;1 200,00\nCafé;3,50\n']) },
    ]);
    const plan = await planImport(vfs);
    assert.equal(plan.format, 'markdown');
    assert.deepEqual(
      plan.roots.map((n) => n.title),
      ['Budget', 'Mes idées'],
    );
    const idees = plan.roots[1] as PlanPage;
    assert.deepEqual(
      idees.children.map((c) => c.title),
      ['Détail'],
    );
    const budget = plan.roots[0] as PlanDatabase;
    const montant = inferColumn(1, budget.headers[1]!, budget.rows.map((r) => r.cells[1]!));
    assert.equal(montant.type, 'number');
    assert.equal(cellToValue(montant, budget.rows[0]!.cells[1]!, undefined), 1200);
  });

  test('stored nested archive is read in place', async () => {
    const inner = sampleExportZip({ nested: false });
    const outer = zipSync({ 'Export-Part-1.zip': [inner, { level: 0 }] });
    const plan = await planImport(await buildVfs([{ path: 'Export.zip', blob: blobOf(outer) }]));
    assert.deepEqual(plan.counts, { pages: 6, databases: 2, rows: 6, attachments: 3 });
  });

  test('Oriel export manifest: sections, icons, exact schemas, inline flags', async () => {
    const manifest = {
      format: 'oriel-export',
      version: 1,
      exportedAt: '2026-10-14T10:00:00Z',
      workspace: { name: 'Test', icon: null },
      entries: [
        { path: 'Secret.md', id: 'p1', kind: 'page', role: 'page', title: 'Secret', icon: '🔒', visibility: 'private' },
        {
          path: 'Secret/Livres.csv',
          id: 'd1',
          kind: 'database',
          role: 'database',
          title: 'Livres',
          icon: '📚',
          isInline: false,
          properties: [
            { id: 'title', name: 'Nom', type: 'title' },
            { id: 'note', name: 'Note', type: 'number', numberFormat: 'percent' },
          ],
          views: [],
        },
      ],
    };
    const zip = zipSync({
      'oriel.json': strToU8(JSON.stringify(manifest)),
      'LISEZMOI.txt': strToU8('lisez-moi'),
      'Secret.md': strToU8('# Secret\n\n[Livres](Secret/Livres.csv)\n\n<details>\n<summary><h2>Plus</h2></summary>\n\nCaché\n\n</details>\n'),
      'Secret/Livres.csv': strToU8('Nom,Note\nDune,90%\n'),
    });
    const plan = await planImport(await buildVfs([{ path: 'b.zip', blob: blobOf(zip) }]));
    assert.equal(plan.format, 'oriel');
    assert.equal(plan.counts.attachments, 0);
    const secret = plan.roots[0] as PlanPage;
    assert.equal(secret.icon, '🔒');
    assert.equal(plan.rootVisibility.get(secret.uid), 'private');
    const livres = secret.children[0] as PlanDatabase;
    assert.equal(livres.inline, false);
    assert.equal(livres.icon, '📚');
    assert.equal(livres.meta?.properties?.[1]?.numberFormat, 'percent');
    const seg = segmentMarkdown('<details>\n<summary><h2>Plus</h2></summary>\n\nCaché\n\n</details>');
    assert.deepEqual(seg, [{ type: 'toggle', summary: 'Plus', text: 'Caché', level: 2 }]);
  });

  test('zip names without the UTF-8 flag', async () => {
    const zip = zipSync({ 'Café.md': strToU8('# Café\n') });
    const vfs = await buildVfs([{ path: 'a.zip', blob: blobOf(zip) }]);
    assert.deepEqual(
      vfs.list().map((f) => f.path),
      ['Café.md'],
    );
  });
});
