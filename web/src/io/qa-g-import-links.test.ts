/// <reference types="node" />
// QA-G8-04 — an imported link kept its destination as written ("external"): a `javascript:` link of
// a Markdown export was stored as such in the Yjs document. BlockNote and handleLinkClick neutralize
// it when rendering and clicking, but every other reader of the document (exports, MCP, future
// renderers) would get it: imports keep only web, mail and phone links (defense in depth). Links
// resolved as "anchor" become plain text (importer.ts → 'missing').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHref } from './markdown';

test('QA-G8-04: imported links with a dangerous scheme are not kept as links', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y']) {
    assert.notEqual(resolveHref(href, 'a/b.md').kind, 'external', JSON.stringify(href));
  }
  // A disguised scheme is not a scheme for the import: it is looked up as a path of the archive.
  assert.equal(resolveHref('java\tscript:alert(1)', 'a/b.md').kind, 'path');
});

test('QA-G8-04: web, mail, phone and absolute links stay external', () => {
  for (const href of ['https://example.org/a', 'http://example.org', 'mailto:a@example.org', 'tel:+33100000000', '/w/x/p/y', '//example.org/x']) {
    assert.deepEqual(resolveHref(href, 'a/b.md'), { kind: 'external', url: href });
  }
});
