// Offline conversions: Markdown ⇄ blocks ⇄ Yjs with Oriel blocks, round-trips and URL safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, HTML_BLOCK_MAX_LENGTH } from '@oriel/shared';
import { blocksToMarkdown, markdownToBlocks, sanitizeBlocks, type ImportContext, type ResolvedPage } from '../src/content/markdown.js';
import { blocksToUpdate, updateToBlocks, type Blk } from '../src/content/editor.js';
import { formatRef, pageIdFrom, parseRef } from '../src/content/links.js';

const PAGES: Record<string, ResolvedPage> = {
  child1: { id: 'child1', kind: 'page', parentType: 'page', parentId: 'P' },
  other: { id: 'other', kind: 'page', parentType: 'workspace', parentId: 'W' },
  db1: { id: 'db1', kind: 'database', parentType: 'page', parentId: 'P' },
};
const TITLES: Record<string, string> = { child1: 'Sous-page', other: 'Autre page', db1: 'Tâches' };
/** Synced block of the page's workspace; any other id is unknown (other workspace, invisible owner…). */
const SYNCED_OK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SYNCED_ELSEWHERE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ictx: ImportContext = {
  pageId: 'P',
  currentUserId: 'u1',
  serverOrigin: 'https://notes.example.fr',
  resolvePage: async (id) => PAGES[id] ?? null,
  isMember: async (id) => id === 'u1',
  resolveSynced: async (id) => id === SYNCED_OK,
};
const ectx = { title: (id: string) => TITLES[id], userName: (id: string) => (id === 'u1' ? 'Alice' : undefined) };

const types = (blocks: Blk[]): string[] => blocks.flatMap((b) => [b.type, ...types(b.children ?? [])]);

async function roundTrip(md: string) {
  const { blocks, warnings } = await markdownToBlocks(md, ictx);
  const back = updateToBlocks(blocksToUpdate(blocks));
  assert.deepEqual(back.unknown, []);
  const out = await blocksToMarkdown(back.blocks, ectx);
  return { blocks, back: back.blocks, markdown: out.markdown, warnings };
}

const SAMPLE = `# Titre

Texte avec **gras**, *italique*, \`code\`, [lien](https://example.com), [Autre page](oriel://page/other), [@Alice](oriel://user/u1) et [📅 15 oct. 2026](oriel://date/2026-10-15?reminder=1&user=u1).

[Sous-page](oriel://page/child1)

[Autre page](oriel://page/other)

[🗃 Tâches](oriel://database/db1)

[🗃 Tâches (vue liée)](oriel://database/db1?view=link-1)

> 🔥 Encadré **important**

[Table des matières](oriel://toc)

[▶ Intégration youtube : https://www.youtube.com/watch?v=dQw4w9WgXcQ](oriel://embed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&provider=youtube)

[🔖 Exemple](oriel://bookmark?url=https%3A%2F%2Fexample.com&title=Exemple)

[📄 doc.pdf](oriel://pdf?url=%2Fapi%2Ffiles%2Fabc%2Fdoc.pdf&name=doc.pdf)

<details>
<summary>Dépliable</summary>

Contenu caché

<details>
<summary>Imbriqué</summary>

Profond

</details>

</details>

<details>
<summary><h2>Titre dépliable</h2></summary>

Dedans

</details>

<!-- oriel:columns -->

<!-- oriel:column -->

Colonne A

<!-- oriel:column width=1.5 -->

Colonne B

<!-- /oriel:columns -->

* [ ] tâche
* [x] faite

1. un
2. deux

\`\`\`javascript
console.log(1)
\`\`\`

| a | b |
| - | - |
| 1 | 2 |`;

test('Oriel blocks and inline content survive Markdown → Yjs → Markdown', async () => {
  const { back, markdown, warnings } = await roundTrip(SAMPLE);
  assert.deepEqual(warnings, []);
  const all = types(back);
  for (const t of ['subpage', 'pageLink', 'database', 'linkedDatabase', 'callout', 'toc', 'embed', 'bookmark', 'pdf', 'toggleListItem', 'columnList', 'column', 'checkListItem', 'codeBlock', 'table']) {
    assert.ok(all.includes(t), `bloc ${t}`);
  }
  const para = back.find((b) => b.type === 'paragraph' && JSON.stringify(b.content).includes('pageMention'))!;
  const inline = (para.content as Array<{ type: string; props?: Record<string, unknown> }>).filter((c) => c.type !== 'text' && c.type !== 'link');
  assert.deepEqual(
    inline.map((c) => [c.type, c.props]),
    [
      ['pageMention', { pageId: 'other' }],
      ['userMention', { userId: 'u1' }],
      ['dateMention', { date: '2026-10-15', reminder: true, userId: 'u1' }],
    ],
  );
  const toggleHeading = back.find((b) => b.type === 'heading' && b.props?.isToggleable);
  assert.equal(toggleHeading?.props?.level, 2);
  const columns = back.find((b) => b.type === 'columnList')!;
  assert.deepEqual(columns.children!.map((c) => c.props?.width), [1, 1.5]);
  // Stable: a second pass gives the same Markdown.
  const again = await roundTrip(markdown);
  assert.equal(again.markdown, markdown);
  for (const fragment of ['[Sous-page](oriel://page/child1)', '> 🔥 Encadré **important**', '<summary><h2>Titre dépliable</h2></summary>', '<!-- oriel:column width=1.5 -->', '[@Alice](oriel://user/u1)']) {
    assert.ok(markdown.includes(fragment), `Markdown contient ${fragment}\n${markdown}`);
  }
});

test('blocks JSON round-trip keeps every custom block and prop (lossless path)', async () => {
  const blocks: Blk[] = [
    { type: 'subpage', props: { pageId: 'child1' } },
    { type: 'callout', props: { emoji: '⚠️', backgroundColor: 'yellow' }, content: [{ type: 'text', text: 'Attention', styles: { bold: true, textColor: 'red' } }] },
    { type: 'embed', props: { url: 'https://vimeo.com/1', provider: 'vimeo', height: 360 } },
    { type: 'bookmark', props: { url: 'https://example.com', title: 'T', description: 'D', image: 'https://example.com/i.png', favicon: '' } },
    { type: 'pdf', props: { url: '/api/files/0123/doc.pdf', name: 'doc.pdf', height: 500 } },
    { type: 'linkedDatabase', props: { databaseId: 'db1', linkId: 'l1' } },
    { type: 'columnList', children: [{ type: 'column', props: { width: 2 }, children: [{ type: 'paragraph', content: 'A' }] }, { type: 'column', children: [{ type: 'paragraph', content: 'B' }] }] },
  ];
  const back = updateToBlocks(blocksToUpdate(blocks)).blocks;
  const pick = (b: Blk | undefined) => b && { type: b.type, props: b.props };
  assert.deepEqual(pick(back[1]), { type: 'callout', props: { emoji: '⚠️', backgroundColor: 'yellow' } });
  assert.deepEqual(back[1]!.content, [{ type: 'text', text: 'Attention', styles: { bold: true, textColor: 'red' } }]);
  assert.deepEqual(pick(back[2]), { type: 'embed', props: { url: 'https://vimeo.com/1', provider: 'vimeo', height: 360 } });
  assert.deepEqual(back[4]!.props, { url: '/api/files/0123/doc.pdf', name: 'doc.pdf', height: 500 });
  assert.deepEqual(back[5]!.props, { databaseId: 'db1', linkId: 'l1' });
  assert.equal(back[6]!.children![0]!.props?.width, 2);
});

test('comment marks (collab module) do not make text disappear when reading a document', () => {
  const doc = new Y.Doc();
  const update = blocksToUpdate([{ type: 'paragraph', content: 'bonjour le monde' }]);
  Y.applyUpdate(doc, update);
  const group = doc.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
  const para = (group.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  (para.get(0) as Y.XmlText).format(0, 7, { comment: { threadId: 't1', orphan: false } });
  const { blocks, unknown } = updateToBlocks(Y.encodeStateAsUpdate(doc));
  assert.deepEqual(unknown, []);
  assert.deepEqual(blocks[0]!.content, [{ type: 'text', text: 'bonjour le monde', styles: {} }]);
});

test('unknown nodes are reported (they would be lost by a full rewrite)', () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, blocksToUpdate([{ type: 'paragraph', content: 'x' }]));
  const group = doc.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
  const container = new Y.XmlElement('blockContainer');
  container.insert(0, [new Y.XmlElement('futureBlock')]);
  group.insert(group.length, [container]);
  assert.deepEqual(updateToBlocks(Y.encodeStateAsUpdate(doc)).unknown, ['futureBlock']);
});

test('unsafe URLs are refused, unknown references become text, headings are clamped, code languages normalized', async () => {
  const md = [
    '[clic](javascript:alert(1))',
    '',
    '![img](javascript:alert(1))',
    '',
    '[Inconnue](oriel://page/nope)',
    '',
    '[Inconnue aussi](oriel://page/nope2) dans une phrase avec [@Bob](oriel://user/u2).',
    '',
    `[▶](oriel://embed?url=${encodeURIComponent('https://notes.example.fr/w/x/p/y')})`,
    '',
    `[pdf](oriel://pdf?url=${encodeURIComponent('https://evil.example/x.pdf')})`,
    '',
    '##### Petit titre',
    '',
    '```sh',
    'ls',
    '```',
  ].join('\n');
  const { blocks, warnings } = await markdownToBlocks(md, ictx);
  const json = JSON.stringify(blocks);
  assert.ok(!json.includes('javascript:'), json);
  assert.ok(!json.includes('"pageId":"nope'), 'unknown pages are not referenced');
  assert.ok(!json.includes('userMention'), 'non-members are not mentioned');
  assert.ok(!blocks.some((b) => b.type === 'embed'), 'the Oriel origin is never framed');
  assert.ok(!blocks.some((b) => b.type === 'pdf'), 'PDF blocks only show uploaded files');
  assert.ok((blocks.find((b) => b.type === 'heading')?.props?.level ?? 4) as number <= 4, 'heading levels stay within 1–4');
  assert.equal(blocks.find((b) => b.type === 'codeBlock')?.props?.language, 'shellscript');
  assert.ok(warnings.length >= 5, warnings.join('\n'));
});

test('JSON blocks get the same checks as Markdown (ids of the workspace, safe URLs)', async () => {
  const { blocks, warnings } = await sanitizeBlocks(
    [
      { type: 'subpage', props: { pageId: 'child1' } },
      { type: 'subpage', props: { pageId: 'ailleurs' } },
      { type: 'linkedDatabase', props: { databaseId: 'other', linkId: 'l' } },
      { type: 'embed', props: { url: 'https://notes.example.fr/api/files/x/a.html', provider: 'generic', height: 0 } },
      { type: 'image', props: { url: 'javascript:alert(1)' } },
      { type: 'pdf', props: { url: 'https://evil.example/a.pdf', name: 'a.pdf', height: 640 } },
      { type: 'bookmark', props: { url: 'https://example.com', title: 'x', description: '', image: 'http://insecure.example/i.png', favicon: '' } },
      {
        type: 'paragraph',
        content: [
          { type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'clic', styles: {} }] },
          { type: 'userMention', props: { userId: 'u2' } },
          { type: 'userMention', props: { userId: 'u1' } },
          { type: 'dateMention', props: { date: '2026-01-01', reminder: true, userId: 'quelquun' } },
        ],
      },
    ],
    ictx,
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['subpage', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'bookmark', 'paragraph'],
  );
  assert.equal(blocks[6]!.props?.image, '');
  const json = JSON.stringify(blocks);
  assert.ok(!json.includes('javascript:'));
  assert.ok(!json.includes('"u2"'));
  assert.ok(json.includes('"userId":"u1"'));
  assert.ok(json.includes('"reminder":true,"userId":"u1"'), 'reminders are set for the token owner');
  assert.ok(warnings.length >= 6, warnings.join('\n'));
});

test('references: formatting, parsing and ids from links or web URLs', () => {
  assert.equal(formatRef({ kind: 'page', id: 'abc' }), 'oriel://page/abc');
  assert.deepEqual(parseRef('oriel://database/d1?view=l1'), { kind: 'database', id: 'd1', linkId: 'l1' });
  assert.deepEqual(parseRef('oriel://date/2026-01-02?reminder=1'), { kind: 'date', date: '2026-01-02', reminder: true });
  assert.equal(parseRef('oriel://page/../x'), null);
  assert.equal(parseRef('https://example.com/page/x'), null);
  assert.equal(pageIdFrom('oriel://page/abc'), 'abc');
  assert.equal(pageIdFrom('https://notes.example.fr/w/ws1/p/abc-123?x=1'), 'abc-123');
  assert.equal(pageIdFrom('  abc '), 'abc');
});

const strip = (list: Blk[]): Blk[] => list.map(({ id: _id, ...b }) => ({ ...b, children: strip(b.children ?? []) }));

const COLORED = `#### Titre 4 <!-- oriel:color text=red -->

Texte <span data-text-color="red" data-background-color="yellow">rouge **gras** [lien](https://example.com)</span>, <span data-background-color="blue">fond *bleu*</span> et \`<span data-text-color="red">code</span>\`.

Paragraphe coloré <!-- oriel:color text=green background=gray -->

<!-- oriel:color background=purple -->

* item <span data-text-color="purple">violet</span> <!-- oriel:color background=pink -->
  * sous-item <!-- oriel:color text=brown -->

> 🔥 Encadré <!-- oriel:color background=orange -->

<details>
<summary><span data-text-color="green">Vert</span> <strong>gras</strong> <em>it</em> <u>sou</u> <s>bar</s> <code>c</code> <!-- oriel:color background=red --></summary>

dedans

</details>

| <span data-text-color="blue">a</span> | b |
| - | - |
| 1 | <span data-background-color="yellow">2</span> |`;

test('colors (text and background, inline and on blocks) survive Markdown → Yjs → Markdown unchanged', async () => {
  const { back, markdown, warnings } = await roundTrip(COLORED);
  assert.deepEqual(warnings, []);
  const heading = back.find((b) => b.type === 'heading')!;
  assert.equal(heading.props?.level, 4);
  assert.equal(heading.props?.textColor, 'red');
  const para = back.find((b) => b.type === 'paragraph')!;
  const items = para.content as Array<{ type: string; text?: string; styles?: Record<string, unknown>; content?: Array<{ styles: Record<string, unknown> }> }>;
  assert.deepEqual(items.find((c) => c.text === 'gras')?.styles, { bold: true, textColor: 'red', backgroundColor: 'yellow' });
  assert.deepEqual(items.find((c) => c.type === 'link')?.content?.[0]?.styles, { textColor: 'red', backgroundColor: 'yellow' });
  assert.deepEqual(items.find((c) => c.text === 'bleu')?.styles, { italic: true, backgroundColor: 'blue' });
  assert.deepEqual(items.find((c) => c.styles?.code)?.styles, { code: true }, 'tags inside inline code stay literal');
  const colored = back.find((b) => b.type === 'paragraph' && b.props?.textColor === 'green')!;
  assert.equal(colored.props?.backgroundColor, 'gray');
  assert.deepEqual(colored.content, [{ type: 'text', text: 'Paragraphe coloré', styles: {} }]);
  assert.ok(back.some((b) => b.type === 'paragraph' && b.props?.backgroundColor === 'purple' && (b.content as unknown[]).length === 0), 'empty colored paragraph');
  const item = back.find((b) => b.type === 'bulletListItem')!;
  assert.equal(item.props?.backgroundColor, 'pink');
  assert.equal(item.children?.[0]?.props?.textColor, 'brown');
  assert.deepEqual(pickProps(back.find((b) => b.type === 'callout')), { emoji: '🔥', backgroundColor: 'orange' });
  const toggle = back.find((b) => b.type === 'toggleListItem')!;
  assert.equal(toggle.props?.backgroundColor, 'red');
  assert.deepEqual(
    (toggle.content as Array<{ text: string; styles: Record<string, unknown> }>).filter((c) => c.text.trim()).map((c) => c.styles),
    [{ textColor: 'green' }, { bold: true }, { italic: true }, { underline: true }, { strike: true }, { code: true }],
  );
  assert.ok(JSON.stringify(back.find((b) => b.type === 'table')).includes('"backgroundColor":"yellow"'), 'colors in table cells');
  // Second pass: same blocks and same Markdown.
  const again = await roundTrip(markdown);
  assert.equal(again.markdown, markdown);
  assert.deepEqual(strip(again.back), strip(back));
  for (const fragment of ['<span data-text-color="red" data-background-color="yellow">rouge **gras** [lien](https://example.com)</span>', 'Paragraphe coloré <!-- oriel:color text=green background=gray -->', '#### Titre 4 <!-- oriel:color text=red -->']) {
    assert.ok(markdown.includes(fragment), `Markdown contient ${fragment}\n${markdown}`);
  }
});

const pickProps = (b: Blk | undefined) => b?.props;

test('colors written as JSON read back as the same Markdown representation', async () => {
  const blocks: Blk[] = [
    { type: 'paragraph', props: { textColor: 'blue', backgroundColor: 'default' }, content: [{ type: 'text', text: 'a', styles: { textColor: 'red' } }, { type: 'text', text: 'b', styles: { bold: true, textColor: 'red' } }, { type: 'text', text: 'c', styles: {} }] },
    { type: 'heading', props: { level: 2, backgroundColor: 'yellow' }, content: 'Titre' },
  ];
  const back = updateToBlocks(blocksToUpdate(blocks)).blocks;
  const { markdown } = await blocksToMarkdown(back, ectx);
  assert.equal(markdown, '<span data-text-color="red">a**b**</span>c <!-- oriel:color text=blue -->\n\n## Titre <!-- oriel:color background=yellow -->');
  const re = await markdownToBlocks(markdown, ictx);
  assert.deepEqual(strip(updateToBlocks(blocksToUpdate(re.blocks)).blocks), strip(back));
});

test('unknown color names are ignored with a warning, other spans are left alone', async () => {
  const { blocks, warnings } = await markdownToBlocks('<span data-text-color="url(x)">a</span> <span class="x">b</span> c <!-- oriel:color text=fuchsia -->', ictx);
  assert.equal(blocks[0]!.props?.textColor, 'default');
  assert.ok(!JSON.stringify(blocks).includes('url(x)'));
  assert.ok(!JSON.stringify(blocks).includes('fuchsia'));
  assert.ok(warnings.some((w) => w.includes('url(x)')) && warnings.some((w) => w.includes('fuchsia')), warnings.join('\n'));
});

const ADVANCED = `# Blocs avancés

Énergie $E = mc^2$ en ligne.

$$
\\int_0^1 x\\,dx = \\frac{1}{2}
$$

[Fil d’Ariane](oriel://breadcrumb)

[🔁 Bloc synchronisé](oriel://synced/${SYNCED_OK})

<!-- oriel:tabs -->

<!-- oriel:tab title="Résumé &quot;court&quot;" -->

Contenu du **premier** onglet

<!-- oriel:columns -->

<!-- oriel:column -->

A

<!-- oriel:column -->

B

<!-- /oriel:columns -->

<!-- oriel:tab title="Détails" -->

* point

<!-- /oriel:tabs -->

\`\`\`oriel-html
<div style="color: red">Salut</div>
<script>document.body.append('ok')</script>
\`\`\`

<details>
<summary><h4>Titre dépliable 4</h4></summary>

Dedans $a+b$

</details>`;

test('equations, breadcrumb, synced block, tabs and HTML blocks survive Markdown → Yjs → Markdown', async () => {
  const { back, markdown, warnings } = await roundTrip(ADVANCED);
  assert.deepEqual(warnings, []);
  const all = types(back);
  for (const t of ['equation', 'breadcrumb', 'syncedBlock', 'tabs', 'tab', 'columnList', 'html']) assert.ok(all.includes(t), `bloc ${t}`);
  assert.equal(back.find((b) => b.type === 'equation')?.props?.tex, '\\int_0^1 x\\,dx = \\frac{1}{2}');
  const inline = JSON.stringify(back.find((b) => b.type === 'paragraph'));
  assert.ok(inline.includes('{"type":"inlineEquation","props":{"tex":"E = mc^2"}}'), inline);
  assert.deepEqual(back.find((b) => b.type === 'syncedBlock')?.props, { syncedId: SYNCED_OK });
  const tabs = back.find((b) => b.type === 'tabs')!;
  assert.deepEqual(tabs.children!.map((t) => [t.type, t.props?.title]), [['tab', 'Résumé "court"'], ['tab', 'Détails']]);
  assert.deepEqual(types(tabs.children![0]!.children ?? []), ['paragraph', 'columnList', 'column', 'paragraph', 'column', 'paragraph']);
  assert.match(String(back.find((b) => b.type === 'html')?.props?.html), /^<div style="color: red">Salut<\/div>\n<script>/);
  const toggle = back.find((b) => b.type === 'heading' && b.props?.isToggleable)!;
  assert.equal(toggle.props?.level, 4);
  assert.ok(JSON.stringify(toggle.children).includes('inlineEquation'));
  const again = await roundTrip(markdown);
  assert.equal(again.markdown, markdown);
  assert.deepEqual(strip(again.back), strip(back));
  for (const fragment of ['$E = mc^2$', '[Fil d’Ariane](oriel://breadcrumb)', `oriel://synced/${SYNCED_OK}`, '<!-- oriel:tab title="Résumé &quot;court&quot;" -->', '```oriel-html', '<summary><h4>Titre dépliable 4</h4></summary>']) {
    assert.ok(markdown.includes(fragment), `Markdown contient ${fragment}\n${markdown}`);
  }
});

test('writes are bounded: synced blocks of another workspace, oversized HTML and equations', async () => {
  const bigHtml = 'x'.repeat(HTML_BLOCK_MAX_LENGTH + 1);
  const md = [
    `[🔁 Bloc synchronisé](oriel://synced/${SYNCED_ELSEWHERE})`,
    '',
    '[forgé](oriel://synced/not-a-uuid)',
    '',
    '```oriel-html',
    bigHtml,
    '```',
    '',
    `$$${'y'.repeat(5000)}$$`,
  ].join('\n');
  const { blocks, warnings } = await markdownToBlocks(md, ictx);
  const json = JSON.stringify(blocks);
  assert.ok(!json.includes('syncedBlock'), 'no synced block outside the workspace');
  assert.ok(!json.includes(SYNCED_ELSEWHERE));
  assert.ok(!blocks.some((b) => b.type === 'html'), 'oversized HTML is not a live block');
  assert.equal(blocks.find((b) => b.type === 'codeBlock')?.props?.language, 'html');
  assert.equal(String(blocks.find((b) => b.type === 'equation')?.props?.tex).length, 4000);
  assert.ok(warnings.length >= 3, warnings.join('\n'));

  const json2 = await sanitizeBlocks(
    [
      { type: 'syncedBlock', props: { syncedId: SYNCED_ELSEWHERE } },
      { type: 'syncedBlock', props: { syncedId: SYNCED_OK } },
      { type: 'html', props: { html: bigHtml } },
      { type: 'html', props: { html: '<b>ok</b>' } },
      { type: 'equation', props: { tex: 'z'.repeat(4001) } },
      { type: 'paragraph', content: [{ type: 'inlineEquation', props: { tex: 'w'.repeat(4001) } }] },
    ],
    { ...ictx, resolveSynced: undefined },
  );
  assert.deepEqual(
    json2.blocks.map((b) => b.type),
    ['paragraph', 'paragraph', 'codeBlock', 'html', 'equation', 'paragraph'],
    'without a check of the workspace, no synced block is written',
  );
  assert.equal(String(json2.blocks[4]!.props?.tex).length, 4000);
  assert.ok(JSON.stringify(json2.blocks[5]).includes(`"tex":"${'w'.repeat(4000)}"`));
  assert.ok(json2.warnings.length >= 4, json2.warnings.join('\n'));
  const ok = await sanitizeBlocks([{ type: 'syncedBlock', props: { syncedId: SYNCED_OK } }], ictx);
  assert.deepEqual(ok.blocks.map((b) => b.type), ['syncedBlock']);
});

test('buttons: JSON fence round-trip; actions checked (URL schemes, ids of the workspace, recorded blocks)', async () => {
  const actions = [
    { type: 'confirm', message: 'Sûr ?' },
    { type: 'addRow', databaseId: 'db1', values: { title: 'Nouvelle tâche' } },
    { type: 'open', url: 'https://example.com/doc' },
    { type: 'open', pageId: 'other' },
    { type: 'insert', blocks: [{ type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Note ', styles: {} }, { type: 'pageMention', props: { pageId: 'other' } }] }] },
  ];
  const md = ['```oriel-button', JSON.stringify({ label: 'Lancer', icon: '🚀', actions }, null, 2), '```'].join('\n');
  const { back, markdown, warnings } = await roundTrip(md);
  assert.deepEqual(warnings, []);
  assert.equal(back[0]!.type, 'button');
  assert.equal(back[0]!.props?.label, 'Lancer');
  assert.equal(back[0]!.props?.icon, '🚀');
  assert.deepEqual(JSON.parse(String(back[0]!.props?.actions)), actions);
  assert.equal(markdown, md);

  const evil = [
    { type: 'open', url: 'javascript:alert(1)' },
    { type: 'open', url: 'data:text/html,<script>1</script>' },
    { type: 'open', pageId: 'nope' },
    { type: 'addRow', databaseId: 'other', values: {} },
    { type: 'editRows', databaseId: 'ailleurs', filter: null, values: {} },
    { type: 'insert', blocks: [{ type: 'paragraph', content: [{ type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'x', styles: {} }] }, { type: 'pageMention', props: { pageId: 'nope' } }] }, { type: 'syncedBlock', props: { syncedId: SYNCED_ELSEWHERE } }] },
    { type: 'shell', command: 'rm -rf /' },
  ];
  const evilMd = ['```oriel-button', JSON.stringify({ label: 'x'.repeat(500), actions: evil }), '```'].join('\n');
  for (const result of [
    await markdownToBlocks(evilMd, ictx),
    await sanitizeBlocks([{ type: 'button', props: { label: '', icon: '', actions: JSON.stringify(evil) } }], ictx),
  ]) {
    const button = result.blocks.find((b) => b.type === 'button')!;
    const kept = JSON.parse(String(button.props?.actions));
    const json = JSON.stringify(kept);
    assert.ok(!json.includes('javascript:') && !json.includes('data:') && !json.includes('shell'), json);
    assert.ok(!json.includes('"nope"') && !json.includes('"other"') && !json.includes('ailleurs') && !json.includes(SYNCED_ELSEWHERE), json);
    assert.deepEqual(kept.map((a: { type: string }) => a.type), ['insert']);
    assert.ok(String(button.props?.label).length <= 120 && String(button.props?.label).length > 0);
    assert.ok(result.warnings.length >= 4, result.warnings.join('\n'));
  }
  const unreadable = await markdownToBlocks('```oriel-button\n{ pas du json\n```', ictx);
  assert.equal(unreadable.blocks[0]!.type, 'codeBlock');
  assert.ok(unreadable.warnings.length === 1);
});

test('G5 blocks: drawing round-trips bounded, image crop and link and code view survive, forged values are cleaned', async () => {
  const strokes = JSON.stringify([{ c: '#e03131', w: 4, p: [10, 10, 50, 60, 2000, 9000] }, { c: 'red', w: 3, p: [1, 2, 3, 4] }]);
  const blocks: Blk[] = [
    { type: 'drawing', props: { strokes } },
    { type: 'image', props: { url: '/api/files/ab/c.png', crop: '0.1,0.2,0.5,0.5', link: 'javascript:alert(1)' } },
    { type: 'image', props: { url: '/api/files/ab/d.png', crop: '9,9,9,9x', link: 'https://exemple.fr/p' } },
    { type: 'codeBlock', props: { language: 'mermaid', view: 'bogus' }, content: [{ type: 'text', text: 'graph TD; A-->B', styles: {} }] },
  ] as Blk[];
  const clean = (await sanitizeBlocks(blocks, ictx)).blocks;
  const kept = updateToBlocks(blocksToUpdate(clean)).blocks;
  const drawing = kept.find((b) => b.type === 'drawing')!;
  assert.deepEqual(JSON.parse(String(drawing.props!.strokes)), [{ c: '#e03131', w: 4, p: [10, 10, 50, 60, 1000, 600] }]);
  const images = kept.filter((b) => b.type === 'image');
  assert.equal(images[0]!.props!.crop, '0.1,0.2,0.5,0.5');
  assert.equal(images[0]!.props!.link, '');
  assert.equal(images[1]!.props!.crop, '');
  assert.equal(images[1]!.props!.link, 'https://exemple.fr/p');
  assert.equal(kept.find((b) => b.type === 'codeBlock')!.props!.view, 'both');
  // Markdown: the drawing is a reference that comes back as a drawing block.
  const md = (await blocksToMarkdown(kept, ectx)).markdown;
  assert.match(md, /✏ Dessin \(1 tracé\)/);
  const again = (await markdownToBlocks(md, ictx)).blocks;
  assert.ok(types(again).includes('drawing'));
});

// --- H5: footnotes, and the render languages added by the web editor --------------------------------

test('footnotes round-trip through Markdown as [^n] with definitions', async () => {
  const blocks = [
    { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Un fait', styles: {} }, { type: 'footnote', props: { note: 'Source : rapport 2026' } }], children: [] },
    { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Un autre', styles: {} }, { type: 'footnote', props: { note: 'Deuxième' } }], children: [] },
  ] as unknown as Blk[];
  const md = (await blocksToMarkdown(blocks, ectx)).markdown;
  assert.match(md, /Un fait\[\^1\]/);
  assert.match(md, /Un autre\[\^2\]/);
  assert.match(md, /\[\^1\]: Source : rapport 2026/);
  const back = (await markdownToBlocks(md, ictx)).blocks;
  const notes = JSON.stringify(back).match(/"note":"[^"]*"/g);
  assert.deepEqual(notes, ['"note":"Source : rapport 2026"', '"note":"Deuxième"']);
  // The note is bounded when written through the MCP.
  const huge = (await markdownToBlocks(`Texte[^1]\n\n[^1]: ${'x'.repeat(5000)}\n`, ictx)).blocks;
  const note = /"note":"([^"]*)"/.exec(JSON.stringify(huge))![1]!;
  assert.equal(note.length, 1000);
});

test('abc and typst code languages survive the MCP', async () => {
  const { normalizeCodeLanguage } = await import('../src/content/codeLanguages.js');
  assert.equal(normalizeCodeLanguage('typst'), 'typst');
  assert.equal(normalizeCodeLanguage('typ'), 'typst');
  assert.equal(normalizeCodeLanguage('abc'), 'abc');
  assert.equal(normalizeCodeLanguage('inconnu'), 'text');
});
