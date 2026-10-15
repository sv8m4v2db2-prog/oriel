/// <reference types="node" />
// QA (security review) of the advanced editor blocks, client side.
//  - QA-EDT-01: a button's « Ajouter une ligne » / « Modifier des lignes » action named its database
//    by an id of the shared document, and ran it with the rights of whoever clicked: a forged button
//    could create or change rows of a database of ANOTHER workspace of the clicker.
//  - QA-EDT-05: same workspace, but the clicker's PRIVATE database named by a button of a shared page
//    (refused by the server, `viaButtonOn`; buttonDatabaseProblem only pre-checks).
//  - QA-EDT-03: the HTML block told readers its code had no network access, while its frame may load
//    images and fonts from any https address (exfiltration of what is typed in it, reader's address).
//  - QA-EDT-04: KaTeX's `maxExpand` counts macro expansions, not the tokens they produce: a user
//    macro pasting its argument k times, applied twice, gave k² copies (≈200 characters froze every
//    reader's tab for 30 s). Macro definitions are refused before KaTeX runs (texRefusal).
//  - « vérifié » tests: hypotheses checked and ruled out (KaTeX output, `$…$` scanning cost, button
//    URLs and recorded blocks).
// Run: node --test --import tsx web/src/editor/qa-advanced-blocks.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { BUTTON_MAX_INSERT_BLOCKS, type Page } from '@oriel/shared';
import { buttonDatabaseProblem, countBlocks, parseButtonActions, sanitizeButtonAction } from './buttonActions';
import { HTML_FRAME_SANDBOX, HTML_RUN_NOTICE } from './htmlFrameLogic';
import { KATEX_OPTIONS, MAX_TEX, protectMarkdownMath, splitInlineMath, texRefusal } from './mathMarkdown';

const database = (over: Partial<Page> = {}) => ({ workspaceId: 'w-1', kind: 'database' as const, trashedAt: null, ...over });

describe('QA-EDT-01: button row actions stay within the workspace of the page', () => {
  test('a database of another workspace is refused, whatever the clicker can access', () => {
    assert.equal(buttonDatabaseProblem(database(), 'w-1'), null);
    assert.match(buttonDatabaseProblem(database({ workspaceId: 'w-2' }), 'w-1') ?? '', /autre espace/);
    assert.match(buttonDatabaseProblem(database(), null) ?? '', /autre espace/, 'no workspace (public page, preview): nothing runs');
    assert.match(buttonDatabaseProblem(database({ kind: 'page' }), 'w-1') ?? '', /pas une base/);
    assert.match(buttonDatabaseProblem(database({ trashedAt: Date.now() }), 'w-1') ?? '', /corbeille/);
  });

  test('QA-EDT-05: a button of a shared page cannot change rows of the private database of whoever clicks it (pre-check; the server decides, qa-g-button)', () => {
    // The clicker's own private database, named by a button a colleague put on a shared page.
    const privateDb = database({ visibility: 'private', ownerId: 'clicker' });
    assert.match(buttonDatabaseProblem(privateDb, 'w-1', { visibility: 'workspace', ownerId: 'colleague' }) ?? '', /base privée/);
    assert.match(buttonDatabaseProblem(privateDb, 'w-1', { visibility: 'teamspace', ownerId: 'colleague' }) ?? '', /base privée/);
    // The clicker's own private page may name his private database.
    assert.equal(buttonDatabaseProblem(privateDb, 'w-1', { visibility: 'private', ownerId: 'clicker' }), null);
    // A restricted teamspace's database from a page of the whole workspace.
    assert.match(buttonDatabaseProblem(database({ visibility: 'teamspace' }), 'w-1', { visibility: 'workspace', ownerId: 'x' }) ?? '', /espace d’équipe/);
    // A shared database from anywhere.
    assert.equal(buttonDatabaseProblem(database({ visibility: 'workspace' }), 'w-1', { visibility: 'workspace', ownerId: 'x' }), null);
  });

  test('forged ids never reach a request path unchecked (shape of the stored id)', () => {
    for (const databaseId of ['../../auth/logout', 'a/b', 'x?y=1', 'x#y', '', 'é', 'a'.repeat(65), { id: 'x' }]) {
      assert.equal(sanitizeButtonAction({ type: 'addRow', databaseId, values: {} }), null, JSON.stringify(databaseId));
      assert.equal(sanitizeButtonAction({ type: 'editRows', databaseId, filter: null, values: {} }), null, JSON.stringify(databaseId));
    }
    for (const pageId of ['../x', 'a/b', '?x', 'a'.repeat(65)]) {
      assert.equal(sanitizeButtonAction({ type: 'open', pageId }), null, pageId);
    }
  });
});

describe('QA-EDT vérifié : button configuration forged in the shared document', () => {
  test('« Ouvrir » keeps http(s), mailto and tel addresses only, after URL normalization', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'blob:https://x/y',
      '//evil.example/x',
      '/w/x/p/y',
      'evil.example',
    ]) {
      assert.equal(sanitizeButtonAction({ type: 'open', url }), null, JSON.stringify(url));
    }
    assert.deepEqual(sanitizeButtonAction({ type: 'open', url: ' HTTPS://Exemple.fr/a ' }), { type: 'open', url: 'https://exemple.fr/a' });
  });

  test('huge or deeply nested configurations are bounded, never thrown', () => {
    const many = JSON.stringify(Array.from({ length: 10_000 }, () => ({ type: 'confirm', message: 'x' })));
    assert.deepEqual(parseButtonActions(many), [], 'over BUTTON_MAX_JSON: ignored');
    const blocks = Array.from({ length: 500 }, () => ({ type: 'paragraph', id: 'fixe', children: [{ type: 'paragraph', id: 'fixe2' }] }));
    const actions = parseButtonActions([{ type: 'insert', blocks }, { type: 'insert', blocks }]);
    const total = actions.reduce((n, a) => n + (a.type === 'insert' ? countBlocks(a.blocks) : 0), 0);
    assert.ok(total <= BUTTON_MAX_INSERT_BLOCKS, String(total));
    assert.ok(!JSON.stringify(actions).includes('"id"'), 'recorded blocks lose their ids');
    let deep: Record<string, unknown> = { type: 'paragraph' };
    for (let i = 0; i < 10_000; i++) deep = { type: 'paragraph', children: [deep] };
    assert.doesNotThrow(() => parseButtonActions([{ type: 'insert', blocks: [deep] }]));
    for (const raw of [null, 42, '{', '"x"', { a: 1 }, [null, 1, 'x', []]]) assert.deepEqual(parseButtonActions(raw), [], JSON.stringify(raw));
  });
});

describe('QA-EDT-03: the HTML block is not presented as cut off from the network', () => {
  test('the notice does not promise what the frame CSP does not enforce', () => {
    // Frame CSP (server/src/routes/editor.ts, audit constraint): img-src / font-src data: https:.
    assert.doesNotMatch(HTML_RUN_NOTICE, /ni au réseau|sans (accès au )?réseau|hors ligne/i);
    assert.match(HTML_RUN_NOTICE, /images/);
    assert.match(HTML_RUN_NOTICE, /mot de passe/);
    assert.equal(HTML_FRAME_SANDBOX, 'allow-scripts');
  });
});

/** Opening tags of an HTML string. */
const tags = (html: string) => html.match(/<[a-z][^>]*>/gi) ?? [];

describe('QA-EDT vérifié : KaTeX output inserted as HTML', () => {
  const render = (tex: string, output: 'htmlAndMathml' | 'mathml' = 'htmlAndMathml') =>
    katex.renderToString(tex.slice(0, MAX_TEX), { ...KATEX_OPTIONS, displayMode: true, output });

  test('effective options: trust off, bounded size and expansions', () => {
    assert.equal(KATEX_OPTIONS.trust, false);
    assert.ok(KATEX_OPTIONS.maxSize > 0 && KATEX_OPTIONS.maxSize <= 50);
    assert.ok(KATEX_OPTIONS.maxExpand > 0 && KATEX_OPTIONS.maxExpand <= 1000);
    assert.equal(KATEX_OPTIONS.throwOnError, true);
  });

  test('links, images, classes, ids, styles and data attributes from TeX never become markup', () => {
    for (const tex of [
      '\\href{javascript:alert(1)}{x}',
      '\\href{https://evil.example}{x}',
      '\\url{javascript:alert(1)}',
      '\\includegraphics{https://evil.example/a.png}',
      '\\htmlClass{or-x}{y}',
      '\\htmlId{root}{y}',
      '\\htmlStyle{background:url(https://evil.example)}{y}',
      '\\htmlData{onclick=alert(1)}{y}',
      '\\text{<img src=x onerror=alert(1)>}',
      '\\color{red;background:url(https://evil.example)}{x}',
      '\\mathrm{"><svg onload=alert(1)>}',
    ]) {
      for (const output of ['htmlAndMathml', 'mathml'] as const) {
        let html: string;
        try {
          html = render(tex, output);
        } catch {
          continue; // refused: the source is shown as text
        }
        for (const tag of tags(html)) {
          assert.doesNotMatch(tag, /\s(href|src|on[a-z]+|id|data-[a-z-]+)=/i, `${tex}: ${tag}`);
          assert.doesNotMatch(tag, /url\(|javascript:|or-x/i, `${tex}: ${tag}`);
          assert.match(tag, /^<(span|math|semantics|mrow|mi|mn|mo|mtext|mstyle|annotation|mpadded|mspace|msup|msub|mfrac|svg|path|line|mover|munder|mtable|mtr|mtd|menclose|mroot|msqrt|mphantom|msubsup|munderover|ms|mglyph)\b/, `${tex}: ${tag}`);
        }
        assert.doesNotMatch(html, /<(img|a|svg on|script|iframe|object|style)\b/i, tex);
      }
    }
  });

  test('huge sizes are clamped, unbalanced sources refused quickly', () => {
    const ruled = render('\\rule{100000em}{100000em}');
    assert.ok(tags(ruled).every((t) => !/100000em/.test(t)), 'size clamped in the markup (the source stays in the annotation)');
    assert.ok(tags(ruled).every((t) => !/(width|height):\s*\d{3,}/.test(t)));
    const t0 = Date.now();
    try {
      render('{'.repeat(MAX_TEX * 10));
    } catch {
      /* unbalanced: refused */
    }
    assert.ok(Date.now() - t0 < 1000);
    const t1 = Date.now();
    assert.throws(() => render('\\def\\a{\\a\\a}\\a'), /Too many expansions/);
    assert.ok(Date.now() - t1 < 500);
  });
});

describe('QA-EDT-04: user macros cannot multiply the work of KaTeX', () => {
  const bomb = (k: number, x: number) => `\\gdef\\b#1{${'#1'.repeat(k)}}\\b{\\b{${'x'.repeat(x)}}}`;

  test('the bug: maxExpand does not bound what expansions produce', () => {
    const tex = bomb(40, 20); // 119 characters, 42 expansions
    assert.ok(tex.length < 150);
    const html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: true });
    assert.ok(html.length > 300_000, `${html.length}`); // ×2 800 (k = 80: 31 s for one equation)
  });

  test('macro definitions are refused before rendering', () => {
    for (const tex of [
      bomb(400, 3000),
      '\\def\\a{x}\\a',
      '\\gdef\\a#1{#1#1}',
      '\\edef\\a{x}',
      '\\xdef\\a{x}',
      '\\global\\def\\a{x}',
      '\\let\\a\\b',
      '\\let\\a=\\b',
      '\\futurelet\\a\\b\\c',
      '\\newcommand{\\a}[1]{#1#1}',
      '\\newcommand\\a{x}',
      '\\renewcommand{\\sqrt}[1]{#1#1}',
      '\\providecommand{\\a}{x}',
      'x + \\def\\y{1}',
      '\\def{}',
      '\\def1',
    ]) {
      assert.match(texRefusal(tex) ?? '', /macros/, tex);
    }
  });

  test('ordinary formulas are not refused', () => {
    for (const tex of [
      'E = mc^2',
      '\\left( \\frac{a}{b} \\right)',
      '\\leftarrow \\Leftarrow \\leftrightarrow \\lefteqn{x}',
      '\\text{define, let, newcommand}',
      '\\delta \\defeq \\deg',
      '\\operatorname{def}(x)',
      '\\tag{1} x',
      '\\letter',
    ]) {
      assert.equal(texRefusal(tex), null, tex);
    }
  });
});

describe('QA-EDT vérifié : `$…$` scanning of imported Markdown is linear', () => {
  const time = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  test('pathological lines (100 000 characters) stay fast', () => {
    const n = 100_000;
    for (const line of [
      '$a'.repeat(n / 2),
      '$a\\$'.repeat(n / 4),
      '$$a'.repeat(n / 3),
      '$ '.repeat(n / 2),
      `$${'a'.repeat(n)}`,
      `$$${'\\$'.repeat(n / 2)}`,
      '`$`'.repeat(n / 3),
      '``$'.repeat(n / 3),
    ]) {
      const ms = time(() => {
        splitInlineMath(line);
        protectMarkdownMath(line);
      });
      assert.ok(ms < 1500, `${JSON.stringify(line.slice(0, 12))}… ${ms.toFixed(0)} ms`);
    }
  });
});
