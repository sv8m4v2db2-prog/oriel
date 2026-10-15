// Footnotes (H5): Markdown export / import, bounded notes, the pure list rules.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FOOTNOTE_MAX_LENGTH } from '@oriel/shared';
import { clampNote, encodeFootnoteBlocks, mayHoldFootnote, protectMarkdownFootnotes, restoreMarkdownFootnotes } from './footnoteMarkdown';
import { prepareMarkdownExport } from './advancedMarkdown';
import { parseMarkdownWithMath } from './mathMarkdown';
import { collectFootnotes, footnoteEndingAt, relocateFootnote, type PmDocLike, type PmNodeLike } from './footnoteLogic';

const fn = (note: string) => ({ type: 'footnote', props: { note } });
const text = (t: string) => ({ type: 'text', text: t, styles: {} });
const para = (...content: unknown[]) => ({ type: 'paragraph', props: {}, content, children: [] });

/** A fake ProseMirror document: a flat list of nodes visited in order, each with a position. */
function fakeDoc(nodes: Array<{ name: string; note?: unknown; children?: number }>): PmDocLike {
  return {
    descendants(visit) {
      let pos = 0;
      for (const n of nodes) {
        const node: PmNodeLike = { type: { name: n.name }, attrs: n.note === undefined ? {} : { note: n.note } };
        visit(node, pos);
        pos += 1;
      }
    },
  };
}

describe('footnote Markdown export', () => {
  test('references are numbered in document order, definitions follow', () => {
    const { blocks, decode } = encodeFootnoteBlocks([para(text('A'), fn('première')), para(text('B'), fn('seconde'))]);
    const md = blocks.map((b) => (b.content as Array<{ text: string }>).map((c) => c.text).join('')).join('\n\n');
    assert.equal(decode(md), 'A[^1]\n\nB[^2]\n\n[^1]: première\n[^2]: seconde\n');
  });

  test('a document without footnote is untouched', () => {
    const { blocks, decode } = encodeFootnoteBlocks([para(text('rien'))]);
    assert.equal(blocks.length, 1);
    assert.equal(decode('rien'), 'rien');
  });

  test('a note with line breaks is exported on one line and bounded', () => {
    const long = 'x'.repeat(FOOTNOTE_MAX_LENGTH + 500);
    assert.equal(clampNote('a\nb'), 'a b');
    assert.equal(clampNote(long).length, FOOTNOTE_MAX_LENGTH);
    assert.equal(clampNote({ toString: () => 'x' }), '');
  });

  test('page export chain: numbering is global, nested blocks and tables are visited', () => {
    const blocks = [
      para(text('un'), fn('n1')),
      { type: 'bulletListItem', props: {}, content: [text('deux'), fn('n2')], children: [para(text('trois'), fn('n3'))] },
    ];
    const prepared = prepareMarkdownExport(blocks as never[]);
    const texts: string[] = [];
    const visit = (list: Array<{ content?: unknown; children?: unknown[] }>) =>
      list.forEach((b) => {
        for (const c of (b.content as Array<{ text?: string }>) ?? []) if (c.text) texts.push(c.text);
        visit((b.children as never[]) ?? []);
      });
    visit(prepared.blocks as never[]);
    // Each call became a placeholder text item between the words.
    assert.equal(texts.length, 6);
    const md = prepared.finish(texts.join(' '));
    assert.match(md, /\[\^1\].*\[\^2\].*\[\^3\]/);
    assert.match(md, /\[\^3\]: n3\n$/);
  });
});

describe('footnote Markdown import', () => {
  test('references with definitions become footnotes, definitions are removed', () => {
    const p = protectMarkdownFootnotes('Texte[^a] et suite[^b].\n\n[^a]: Note A\n[^b]: Note B\n');
    assert.equal(p.refs.length, 2);
    assert.ok(!p.md.includes('Note A'));
    // The parser returns the placeholders as text: restoring gives footnote items in order.
    const parsed = [{ type: 'paragraph', content: [{ type: 'text', text: p.md.split('\n')[0], styles: {} }], children: [] }];
    const out = restoreMarkdownFootnotes(parsed as never[], p) as Array<{ content: Array<{ type: string; props?: { note: string }; text?: string }> }>;
    const notes = out[0]!.content.filter((c) => c.type === 'footnote').map((c) => c.props!.note);
    assert.deepEqual(notes, ['Note A', 'Note B']);
    assert.equal(out[0]!.content[0]!.text, 'Texte');
  });

  test('a reference without definition stays text; a definition never referenced stays a paragraph', () => {
    const p = protectMarkdownFootnotes('Voir[^x] et[^y]\n\n[^y]: seule\n[^z]: orpheline\n');
    assert.equal(p.refs.length, 1);
    assert.ok(p.md.includes('Voir[^x]'));
    assert.ok(p.md.includes('[^z]: orpheline'));
  });

  test('code is left alone', () => {
    const md = 'Texte `[^a]` ici\n\n```\n[^a]\n[^a]: dans le code\n```\n\n[^a]: vraie note\n';
    const p = protectMarkdownFootnotes(md);
    assert.equal(p.refs.length, 0);
    assert.equal(p.md, md);
  });

  test('definition continuation lines are joined, links flattened, text bounded', () => {
    const p = protectMarkdownFootnotes('Ok[^1]\n\n[^1]: début\n    suite [site](https://exemple.fr)\n');
    assert.equal(p.refs[0]!.note, 'début suite site (https://exemple.fr)');
    const huge = protectMarkdownFootnotes(`Ok[^1]\n\n[^1]: ${'y'.repeat(5000)}\n`);
    assert.equal(huge.refs[0]!.note.length, FOOTNOTE_MAX_LENGTH);
  });

  test('parseMarkdownWithMath handles footnotes and equations together', () => {
    // A stand-in parser: one paragraph per line, the text kept verbatim.
    const parse = (md: string) => md.split('\n').filter(Boolean).map((l) => para(text(l)));
    const blocks = parseMarkdownWithMath('Formule $x^2$ puis[^1]\n\n[^1]: Source\n', parse as never) as Array<{ content: Array<{ type: string }> }>;
    const types = blocks[0]!.content.map((c) => c.type);
    assert.deepEqual(types, ['text', 'inlineEquation', 'text', 'footnote']);
  });

  test('mayHoldFootnote is a cheap pre-test', () => {
    assert.ok(mayHoldFootnote('a[^1]'));
    assert.ok(!mayHoldFootnote('a [ ^ 1 ]'));
  });

  test('pathological input stays fast', () => {
    const started = Date.now();
    protectMarkdownFootnotes(`${'[^a'.repeat(50_000)}\n${'`'.repeat(50_000)}`);
    protectMarkdownFootnotes(`${'[^a]'.repeat(20_000)}\n\n[^a]: n\n`);
    assert.ok(Date.now() - started < 3000);
  });
});

describe('footnote list rules', () => {
  test('collectFootnotes lists the calls in order and bounds the note text', () => {
    const doc = fakeDoc([{ name: 'paragraph' }, { name: 'footnote', note: 'a' }, { name: 'footnote', note: 7 }, { name: 'footnote', note: 'z'.repeat(FOOTNOTE_MAX_LENGTH + 10) }]);
    const entries = collectFootnotes(doc);
    assert.deepEqual(entries.map((e) => [e.index, e.pos]), [[0, 1], [1, 2], [2, 3]]);
    assert.equal(entries[1]!.note, '');
    assert.equal(entries[2]!.note.length, FOOTNOTE_MAX_LENGTH);
  });

  test('a page with thousands of calls is capped', () => {
    const doc = fakeDoc(Array.from({ length: 3000 }, () => ({ name: 'footnote', note: 'n' })));
    assert.equal(collectFootnotes(doc).length, 500);
  });

  test('relocateFootnote follows the note when calls were inserted before it', () => {
    const entries = collectFootnotes(fakeDoc([{ name: 'footnote', note: 'new' }, { name: 'footnote', note: 'a' }, { name: 'footnote', note: 'b' }]));
    assert.equal(relocateFootnote(entries, 0, 'a')!.index, 1);
    assert.equal(relocateFootnote(entries, 2, 'b')!.index, 2);
    assert.equal(relocateFootnote(entries, 1, 'gone'), null);
  });

  test('footnoteEndingAt finds the call just before the cursor', () => {
    const entries = collectFootnotes(fakeDoc([{ name: 'paragraph' }, { name: 'footnote', note: '' }]));
    assert.equal(footnoteEndingAt(entries, 2)!.index, 0);
    assert.equal(footnoteEndingAt(entries, 5), null);
  });
});
