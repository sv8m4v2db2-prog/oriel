/// <reference types="node" />
// QA-G8 — file importers read hostile files: XXE / entity bombs, zip bombs, archive paths, nesting,
// page counts, remote images. Bounds are lowered temporarily to keep the tests fast.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { Vfs } from '../vfs';
import { IMPORT_LIMITS, ImportError, isSafeArchivePath } from './limits';
import { parseXml } from './xml';
import { parseHtml } from './html';
import { HtmlConverter } from './htmlToBlocks';
import { openBoundedZip } from './safeZip';
import { PlanBuilder } from './builder';
import { docxToBlocks } from './docx';
import { readWorkbook } from './xlsx';
import { planTrello, planAsana } from './tasks';
import { planEnex } from './enex';
import { md5Hex } from './md5';

const L = IMPORT_LIMITS as unknown as Record<string, number>;
const saved = { ...L };
afterEach(() => Object.assign(L, saved));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const docx = (body: string, extra: Record<string, string> = {}) =>
  zipSync({
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });

describe('XML : pas de résolution d’entités ni de DTD (XXE)', () => {
  test('une entité externe n’est jamais lue ni développée', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>';
    const root = parseXml(xml);
    assert.equal(root.children.join(''), '&x;');
  });
  test('une bombe d’entités n’est pas développée', () => {
    const xml = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><l>&b;</l>';
    assert.equal(parseXml(xml).children.join(''), '&b;');
  });
  test('les références numériques invalides sont retirées', () => {
    assert.equal(parseXml('<a>&#0;&#x110000;ok&#65;</a>').children.join(''), 'okA');
  });
  test('profondeur d’imbrication bornée', () => {
    assert.throws(() => parseXml('<a>'.repeat(300) + '</a>'.repeat(300)), ImportError);
    assert.throws(() => parseHtml('<div>'.repeat(300)), ImportError);
  });
  test('nombre d’éléments borné', () => {
    L.maxNodes = 50;
    assert.throws(() => parseXml('<a>' + '<b/>'.repeat(100) + '</a>'), ImportError);
  });
});

describe('archives : bornes', () => {
  test('chemins avec .. ou absolus refusés', async () => {
    assert.equal(isSafeArchivePath('../x.xml'), false);
    assert.equal(isSafeArchivePath('/etc/passwd'), false);
    assert.equal(isSafeArchivePath('C:\\x'), false);
    assert.equal(isSafeArchivePath('word/document.xml'), true);
    const zip = zipSync({ '../evil.xml': strToU8('x'), 'ok.xml': strToU8('y') });
    const z = await openBoundedZip(zip, 'test.zip');
    assert.equal(z.has('ok.xml'), true);
    assert.equal(z.has('../evil.xml'), false);
    assert.ok(z.warnings.some((w) => /refusé/.test(w)));
  });
  test('nombre d’entrées borné', async () => {
    L.maxZipEntries = 3;
    const zip = zipSync(Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`f${i}.txt`, strToU8('x')])));
    await assert.rejects(openBoundedZip(zip, 'trop.zip'), ImportError);
  });
  test('taux de compression anormal refusé', async () => {
    L.ratioFloorBytes = 1024 * 1024;
    L.maxZipRatio = 100;
    const zip = zipSync({ 'bombe.xml': [new Uint8Array(8 * 1024 * 1024), { level: 9 }] });
    const z = await openBoundedZip(zip, 'bombe.zip');
    assert.equal(z.has('bombe.xml'), false);
    assert.ok(z.warnings.some((w) => /compression/.test(w)));
  });
  test('taille décompressée par partie bornée', async () => {
    const zip = zipSync({ 'a.xml': [new Uint8Array(2 * 1024 * 1024), { level: 9 }] });
    const z = await openBoundedZip(zip, 'a.zip');
    await assert.rejects(z.read('a.xml', 1024 * 1024));
  });
  test('budget décompressé total borné', async () => {
    const { InflateBudget } = await import('./safeZip');
    const zip = zipSync({ 'a.txt': [new Uint8Array(600_000).fill(1), { level: 0 }], 'b.txt': [new Uint8Array(600_000).fill(2), { level: 0 }] });
    const z = await openBoundedZip(zip, 'a.zip', new InflateBudget(1_000_000));
    await z.read('a.txt');
    await assert.rejects(z.read('b.txt'));
  });
  test('docx corrompu ou sans document.xml refusé', async () => {
    await assert.rejects(docxToBlocks(zipSync({ 'x.txt': strToU8('x') }), 'a.docx', new Vfs(), 'a.medias'), ImportError);
    await assert.rejects(docxToBlocks(strToU8('pas un zip'), 'a.docx', new Vfs(), 'a.medias'), ImportError);
  });
});

describe('plan : nombre de pages borné', () => {
  test('au-delà du plafond, l’import est refusé', () => {
    L.maxPages = 3;
    const b = new PlanBuilder();
    b.page({ title: 'a' });
    b.page({ title: 'b' });
    b.page({ title: 'c' });
    assert.throws(() => b.page({ title: 'd' }), ImportError);
  });
});

describe('HTML : converti en blocs, jamais injecté', () => {
  const convert = (html: string, warnings: string[] = []) => {
    const root = parseHtml(html);
    return new HtmlConverter(root, { warn: (m) => warnings.push(m) }).convert(root.children);
  };
  test('script et liens javascript: supprimés, image externe conservée comme lien', () => {
    const blocks = convert('<p onclick="x()">Salut <a href="javascript:alert(1)">piège</a></p><script>alert(1)</script><img src="https://exemple.org/a.png" alt="A">');
    const json = JSON.stringify(blocks);
    assert.ok(!json.includes('alert'));
    assert.ok(!json.includes('javascript'));
    const img = blocks.find((b) => b.type === 'image');
    assert.equal(img?.props?.url, 'https://exemple.org/a.png');
  });
  test('titres, listes imbriquées, tableau, code', () => {
    const blocks = convert('<h1>T</h1><ul><li>a<ul><li>b</li></ul></li></ul><table><tr><th>x</th></tr><tr><td>1</td></tr></table><pre class="language-js">let a;</pre>');
    assert.equal(blocks[0]!.type, 'heading');
    assert.equal(blocks[1]!.type, 'bulletListItem');
    assert.equal(blocks[1]!.children![0]!.type, 'bulletListItem');
    assert.equal(blocks[2]!.type, 'table');
    assert.equal(blocks[3]!.props?.language, 'js');
  });
  test('image data: sans gestionnaire : ignorée avec avertissement', () => {
    const w: string[] = [];
    const blocks = convert('<img src="data:image/png;base64,AAAA">', w);
    assert.equal(blocks.length, 0);
    assert.equal(w.length, 1);
  });
});

describe('Word', () => {
  test('styles, listes imbriquées, tableau, lien, note de bas de page', async () => {
    const body = `
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Titre</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:strike/></w:rPr><w:t>fort</w:t></w:r><w:r><w:t xml:space="preserve"> et </w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>un</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>sous</w:t></w:r></w:p>
      <w:p><w:hyperlink r:id="rId9"><w:r><w:t>lien</w:t></w:r></w:hyperlink></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const zip = docx(body, {
      'word/styles.xml': `<w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
      'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId9" Target="https://exemple.org/" TargetMode="External"/></Relationships>`,
      'word/footnotes.xml': `<w:footnotes ${W}><w:footnote w:id="2"><w:p><w:r><w:t>Ma note</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    });
    const r = await docxToBlocks(zip, 'doc.docx', new Vfs(), 'doc.medias');
    assert.equal(r.title, 'Titre');
    const types = r.blocks.map((b) => b.type);
    assert.deepEqual(types.slice(0, 3), ['heading', 'paragraph', 'numberedListItem']);
    const list = r.blocks[2]!;
    assert.equal(list.children![0]!.type, 'bulletListItem');
    const para = r.blocks[1]!.content as Array<{ text?: string; styles?: Record<string, unknown> }>;
    assert.deepEqual(para[0]!.styles, { bold: true, italic: true, underline: true, strike: true });
    assert.ok(JSON.stringify(r.blocks).includes('Ma note'));
    const link = (r.blocks[3]!.content as Array<{ type: string; href?: string }>)[0]!;
    assert.equal(link.href, 'https://exemple.org/');
    assert.ok(r.blocks.some((b) => b.type === 'table'));
  });
  test('XXE dans document.xml : pas d’entité développée', async () => {
    const zip = zipSync({
      'word/document.xml': strToU8(`<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document ${W}><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`),
    });
    const r = await docxToBlocks(zip, 'x.docx', new Vfs(), 'x.medias');
    assert.ok(!JSON.stringify(r.blocks).includes('root:'));
  });
  test('image intégrée : fichier monté, pas de requête distante', async () => {
    const body = `<w:p><w:r><w:drawing><a:blip xmlns:a="a" r:embed="rId5"/></w:drawing></w:r></w:p>`;
    const zip = docx(body, {
      'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId5" Target="media/image1.png"/></Relationships>`,
      'word/media/image1.png': 'PNG',
    });
    const vfs = new Vfs();
    const r = await docxToBlocks(zip, 'doc.docx', vfs, 'doc.medias');
    assert.equal(r.images, 1);
    assert.equal(vfs.size, 1);
    assert.equal(r.blocks[0]!.type, 'image');
  });
});

describe('Excel', () => {
  test('types, dates, booléens, formules en cache', async () => {
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"><f>B2*2</f><v>90000</v></c></row>
      </sheetData></worksheet>`;
    const zip = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Nom</t></si><si><t>Date</t></si><si><t>Ok</t></si><si><t>Double</t></si><si><t>Alpha</t></si></sst>'),
      'xl/styles.xml': strToU8('<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    });
    const { sheets } = await readWorkbook(zip, 'b.xlsx');
    assert.equal(sheets[0]!.name, 'Budget');
    assert.deepEqual(sheets[0]!.headers, ['Nom', 'Date', 'Ok', 'Double']);
    assert.deepEqual(sheets[0]!.rows[0], ['Alpha', '2023-03-15', 'true', '90000']);
  });
  test('lignes et colonnes en trop tronquées', async () => {
    L.maxRowsPerSheet = 2;
    const rows = [1, 2, 3, 4, 5].map((r) => `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`).join('');
    const zip = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>'),
      'xl/worksheets/s.xml': strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`),
    });
    const { sheets } = await readWorkbook(zip, 'b.xlsx');
    assert.equal(sheets[0]!.rows.length, 2);
    assert.ok(sheets[0]!.notes.some((n) => /tronquée/.test(n)));
  });
});

describe('Trello, Asana, Evernote', () => {
  test('Trello : listes en statut, étiquettes, échéance, checklists', () => {
    const b = new PlanBuilder();
    planTrello(
      b,
      {
        name: 'Cadrage',
        lists: [{ id: 'l1', name: 'À faire', pos: 1 }, { id: 'l2', name: 'Archive', closed: true }],
        cards: [
          { id: 'c1', name: 'Repérages', desc: 'Voir lieu', idList: 'l1', due: '2026-03-04T10:00:00.000Z', labels: [{ name: 'Urgent' }], idMembers: [] },
          { id: 'c2', name: 'Vieux', idList: 'l2' },
        ],
        checklists: [{ id: 'k', idCard: 'c1', name: 'Matériel', checkItems: [{ name: 'Caméra', state: 'complete' }] }],
      },
      'x',
    );
    const db = [...b.items.values()].find((i) => i.kind === 'database') as import('../plan').PlanDatabase;
    assert.equal(db.title, 'Cadrage');
    assert.equal(db.rows.length, 1);
    assert.deepEqual(db.rows[0]!.cells, ['Repérages', 'À faire', 'Urgent', '2026-03-04', '']);
    assert.ok(db.rows[0]!.blocks!.some((x) => x.type === 'checkListItem' && x.props?.checked === true));
  });
  test('Trello : un JSON quelconque est refusé', () => {
    assert.throws(() => planTrello(new PlanBuilder(), { a: 1 }, 'x'), ImportError);
  });
  test('Asana : tâches, section, assigné, terminée', () => {
    const csv = 'Task ID,Created At,Completed At,Name,Section/Column,Assignee,Due Date,Tags,Notes,Parent task\n1,2026-01-01,2026-01-05,Monter,Post,Alice,2026-02-01,"a, b",Note,\n';
    const b = new PlanBuilder();
    planAsana(b, csv, 'Projet');
    const db = [...b.items.values()].find((i) => i.kind === 'database') as import('../plan').PlanDatabase;
    assert.equal(db.rows[0]!.cells[3], 'true');
    assert.equal(db.rows[0]!.cells[1], 'Post');
  });
  test('Evernote : notes, étiquettes, pièce jointe par md5, DTD ignorée', () => {
    const data = 'hello';
    const hash = md5Hex(strToU8(data));
    const enex = `<?xml version="1.0"?><!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd"><en-export><note><title>N1</title><created>20260102T030405Z</created><tag>t1</tag><tag>t2</tag><content><![CDATA[<?xml version="1.0"?><en-note><div>Texte</div><en-media type="text/plain" hash="${hash}"/></en-note>]]></content><resource><data encoding="base64">${btoa(data)}</data><mime>text/plain</mime><resource-attributes><file-name>a.txt</file-name></resource-attributes></resource></note></en-export>`;
    const b = new PlanBuilder();
    const vfs = new Vfs();
    planEnex(b, vfs, enex, 'Carnet.enex', '');
    const db = [...b.items.values()].find((i) => i.kind === 'database') as import('../plan').PlanDatabase;
    assert.deepEqual(db.rows[0]!.cells, ['N1', 't1, t2', '2026-01-02', '']);
    assert.ok(db.rows[0]!.blocks!.some((x) => x.type === 'file'));
    assert.equal(vfs.size, 1);
  });
  test('md5', () => {
    assert.equal(md5Hex(strToU8('')), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Hex(strToU8('abc')), '900150983cd24fb0d6963f7d28e17f72');
  });
});
