/// <reference types="node" />
// Equations in Markdown (import and export) and Markdown export of the advanced blocks.
// Run: node --test --import tsx web/src/editor/mathMarkdown.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMathBlocks, inlineMathMarkdown, mayHoldMath, parseMarkdownWithMath, protectMarkdownMath, splitInlineMath } from './mathMarkdown';
import { flattenAdvancedBlocks, prepareMarkdownExport } from './advancedMarkdown';

interface B {
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: B[];
}

/**
 * Stand-in for BlockNote's Markdown parser: one paragraph per blank-line separated chunk, a "```"
 * fence as a code block, and the backslash escapes of CommonMark applied (what eats TeX sources).
 */
function fakeParse(md: string): B[] {
  const out: B[] = [];
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/;
  for (const chunk of md.split(/\n{2,}/)) {
    const t = chunk.trim();
    if (!t) continue;
    const f = fence.exec(t);
    if (f) out.push({ type: 'codeBlock', content: [{ type: 'text', text: f[1], styles: {} }], children: [] });
    else out.push({ type: 'paragraph', content: [{ type: 'text', text: t.replace(/\\([!-/:-@[-`{-~])/g, '$1'), styles: {} }], children: [] });
  }
  return out;
}

const txt = (text: string, styles = {}) => ({ type: 'text', text, styles });
const ieq = (tex: string) => ({ type: 'inlineEquation', props: { tex } });

describe('splitInlineMath', () => {
  test('Pandoc rules', () => {
    assert.deepEqual(splitInlineMath('soit $x^2$ et $y$.'), [{ text: 'soit ' }, { tex: 'x^2' }, { text: ' et ' }, { tex: 'y' }, { text: '.' }]);
    assert.deepEqual(splitInlineMath('coûte $5 ou $10'), [{ text: 'coûte $5 ou $10' }]);
    assert.deepEqual(splitInlineMath('$ x $'), [{ text: '$ x $' }]);
    assert.deepEqual(splitInlineMath('prix \\$3 et $a$'), [{ text: 'prix \\$3 et ' }, { tex: 'a' }]);
    assert.deepEqual(splitInlineMath('$a$5'), [{ text: '$a$5' }]);
  });
});

describe('import: Markdown → equations', () => {
  test('display equation on one line, on several lines, TeX escapes kept', () => {
    const blocks = parseMarkdownWithMath('Avant\n\n$$\\frac{a}{b} \\{x\\}$$\n\nAprès\n\n$$\n\\begin{aligned} a &= b \\\\\n c &= d\n\\end{aligned}\n$$', fakeParse);
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['paragraph', 'equation', 'paragraph', 'equation'],
    );
    assert.equal(blocks[1]!.props!.tex, '\\frac{a}{b} \\{x\\}');
    assert.equal(blocks[3]!.props!.tex, '\\begin{aligned} a &= b \\\\\n c &= d\n\\end{aligned}');
    assert.equal('content' in blocks[1]!, false);
  });

  test('display equation glued to a paragraph gets its own block', () => {
    const blocks = parseMarkdownWithMath('Texte\n$$\nx_1\n$$\nSuite', fakeParse);
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['paragraph', 'equation', 'paragraph'],
    );
    assert.equal(blocks[1]!.props!.tex, 'x_1');
  });

  test('inline equations, escapes and underscores kept', () => {
    const [p] = parseMarkdownWithMath('Aire $\\pi r_1^2$ et $\\{a\\}$, prix 5 $.', fakeParse);
    assert.deepEqual(p!.content, [txt('Aire '), ieq('\\pi r_1^2'), txt(' et '), ieq('\\{a\\}'), txt(', prix 5 $.')]);
  });

  test('`$$…$$` inside a line becomes an inline equation', () => {
    const [p] = parseMarkdownWithMath('- item $$a+b$$ fin', fakeParse);
    assert.deepEqual(p!.content, [txt('- item '), ieq('a+b'), txt(' fin')]);
  });

  test('code is left alone: fences and inline code spans', () => {
    const blocks = parseMarkdownWithMath('```js\nconst s = `$x$`; // $$y$$\n```\n\nCode `$a$` et ``$`b`$`` puis $c$', fakeParse);
    assert.equal(blocks[0]!.type, 'codeBlock');
    assert.deepEqual(blocks[0]!.content, [txt('const s = `$x$`; // $$y$$')]);
    assert.deepEqual(blocks[1]!.content, [txt('Code `$a$` et ``$`b`$`` puis '), ieq('c')]);
  });

  test('placeholders that end up in code-styled text or links get their source back', () => {
    const p = protectMarkdownMath('voir $x$');
    const parse = (): B[] => [{ type: 'paragraph', content: [{ type: 'link', href: 'https://a', content: [txt(p.md.slice(5))] }, txt(p.md.slice(5), { code: true })], children: [] }];
    const [b] = parseMarkdownWithMath('voir $x$', parse);
    assert.deepEqual(b!.content, [{ type: 'link', href: 'https://a', content: [txt('$x$')] }, txt('$x$', { code: true })]);
  });

  test('unclosed display equation stays text; no `$` → untouched', () => {
    assert.deepEqual(parseMarkdownWithMath('$$\nx', fakeParse)[0]!.content, [txt('$$\nx')]);
    assert.equal(protectMarkdownMath('rien').md, 'rien');
    assert.equal(mayHoldMath('5 $'), false);
    assert.equal(mayHoldMath('$x$'), true);
  });

  test('tables', () => {
    const p = protectMarkdownMath('| $a$ |');
    const parse = (): B[] => [{ type: 'table', content: { type: 'tableContent', rows: [{ cells: [[txt(p.md.slice(2, -2))]] }] }, children: [] }];
    const [t] = parseMarkdownWithMath('| $a$ |', parse);
    assert.deepEqual((t!.content as { rows: Array<{ cells: unknown[] }> }).rows[0]!.cells[0], [ieq('a')]);
  });

  test('TeX source bounded', () => {
    const [b] = parseMarkdownWithMath(`$$${'x'.repeat(5000)}$$`, fakeParse);
    assert.equal((b!.props!.tex as string).length, 4000);
  });
});

describe('export: equations → Markdown', () => {
  /** Stand-in for blocksToMarkdownLossy: paragraph text, children indented as list items. */
  const serialize = (blocks: B[], indent = ''): string =>
    blocks
      .map((b) => {
        const text = Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('') : '';
        const self = b.type === 'heading' ? `${indent}### ${text}` : `${indent}${indent ? '- ' : ''}${text}`;
        return [self, ...(b.children?.length ? [serialize(b.children, indent + '  ')] : [])].join('\n');
      })
      .join('\n\n');

  test('display and inline equations, nested display on one line', () => {
    const { blocks, decode } = encodeMathBlocks<B>([
      { type: 'equation', props: { tex: '\\begin{aligned}a&=b\\\\\nc&=d\\end{aligned}' }, children: [{ type: 'equation', props: { tex: 'x\n+ y' }, children: [] }] },
      { type: 'paragraph', content: [txt('Soit '), ieq(' a_1 '), txt(' et '), ieq('5$')], children: [] },
      { type: 'equation', props: { tex: '' }, children: [] },
    ]);
    const md = decode(serialize(blocks));
    assert.equal(md, '$$\n\\begin{aligned}a&=b\\\\\nc&=d\\end{aligned}\n$$\n  - $$x + y$$\n\nSoit $a_1$ et $5\\$$\n\n');
  });

  test('round trip', () => {
    const source: B[] = [
      { type: 'paragraph', content: [txt('Aire '), ieq('\\pi r^2')], children: [] },
      { type: 'equation', props: { tex: '\\sum_{i=1}^n \\{i\\}' }, children: [] },
    ];
    const { blocks, decode } = encodeMathBlocks(source);
    const back = parseMarkdownWithMath(decode(serialize(blocks)), fakeParse);
    assert.deepEqual(back[0]!.content, source[0]!.content);
    assert.equal(back[1]!.type, 'equation');
    assert.equal(back[1]!.props!.tex, '\\sum_{i=1}^n \\{i\\}');
  });

  test('inlineMathMarkdown escapes dollars', () => {
    assert.equal(inlineMathMarkdown('a $ b'), '$a \\$ b$');
    assert.equal(inlineMathMarkdown('\\$'), '$\\$$');
  });
});

describe('export: tabs, breadcrumb, button', () => {
  const tab = (title: string, ...children: B[]): B => ({ type: 'tab', props: { title }, children });
  const para = (t: string): B => ({ type: 'paragraph', content: [txt(t)], children: [] });

  test('each tab becomes a heading followed by its content', () => {
    const dropped = new Set<string>();
    const out = flattenAdvancedBlocks<B>(
      [
        para('Intro'),
        { type: 'tabs', props: {}, children: [tab('Résumé', para('A'), para('B')), tab('  ', para('C')), para('égaré')] },
        { type: 'button', props: { label: 'Go' }, children: [] },
        { type: 'breadcrumb', props: {}, children: [] },
      ],
      { breadcrumb: () => 'Projets / Page', dropped },
    );
    assert.deepEqual(
      out.map((b) => [b.type, (b.content as Array<{ text: string }> | undefined)?.[0]?.text]),
      [
        ['paragraph', 'Intro'],
        ['heading', 'Résumé'],
        ['paragraph', 'A'],
        ['paragraph', 'B'],
        ['heading', 'Onglet 2'],
        ['paragraph', 'C'],
        ['paragraph', 'égaré'],
        ['paragraph', 'Projets / Page'],
      ],
    );
    assert.deepEqual([...dropped], ['button']);
  });

  test('nested tabs and equations inside a tab', () => {
    const { blocks, finish } = prepareMarkdownExport<B>([{ type: 'tabs', children: [tab('T', { type: 'equation', props: { tex: 'e^{i\\pi}' }, children: [] })] }]);
    assert.equal(blocks[0]!.type, 'heading');
    assert.equal(finish((blocks[1]!.content as Array<{ text: string }>)[0]!.text), '$$e^{i\\pi}$$');
    // Breadcrumb without a known path: nothing.
    assert.deepEqual(flattenAdvancedBlocks<B>([{ type: 'breadcrumb', children: [] }]), []);
  });
});
