/// <reference types="node" />
// Run: node --test --import tsx web/src/editor/codeLanguages.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_LANGUAGES, normalizeCodeBlocks, normalizeCodeLanguage, normalizeMarkdownFences } from './codeLanguages';

describe('code block languages', () => {
  test('aliases map to canonical keys, unknown to text', () => {
    assert.equal(normalizeCodeLanguage('js'), 'javascript');
    assert.equal(normalizeCodeLanguage('TS'), 'typescript');
    assert.equal(normalizeCodeLanguage('sh'), 'shellscript');
    assert.equal(normalizeCodeLanguage('bash'), 'shellscript');
    assert.equal(normalizeCodeLanguage('py'), 'python');
    assert.equal(normalizeCodeLanguage('yml'), 'yaml');
    assert.equal(normalizeCodeLanguage(' javascript '), 'javascript');
    assert.equal(normalizeCodeLanguage('foobar'), 'text');
    assert.equal(normalizeCodeLanguage(''), 'text');
    assert.equal(normalizeCodeLanguage(undefined), 'text');
    for (const l of ['javascript', 'typescript', 'shellscript', 'python', 'yaml', 'text']) assert.ok(l in CODE_LANGUAGES, l);
  });

  test('parsed blocks are normalized recursively', () => {
    const out = normalizeCodeBlocks([
      { type: 'codeBlock', props: { language: 'js' }, children: [] },
      { type: 'paragraph', props: {}, children: [{ type: 'codeBlock', props: { language: 'nope' }, children: [] }] },
    ]);
    assert.equal(out[0]!.props!.language, 'javascript');
    assert.equal((out[1]!.children![0] as { props: { language: string } }).props.language, 'text');
  });

  test('Markdown fences: opening info strings rewritten, nested fences untouched', () => {
    const md = ['```js', 'const a = 1;', '```', '', '~~~py title=x', 'print(1)', '~~~', '````md', '```sh', 'echo', '```', '````', '```', 'plain', '```'].join('\n');
    assert.equal(
      normalizeMarkdownFences(md),
      ['```javascript', 'const a = 1;', '```', '', '~~~python title=x', 'print(1)', '~~~', '````markdown', '```sh', 'echo', '```', '````', '```', 'plain', '```'].join('\n'),
    );
    assert.equal(normalizeMarkdownFences('```weird\nx\n```'), '```text\nx\n```');
    assert.equal(normalizeMarkdownFences('Texte avec ```inline``` code'), 'Texte avec ```inline``` code');
  });
});
