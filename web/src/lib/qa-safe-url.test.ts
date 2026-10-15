/// <reference types="node" />
// QA-WEB-02 — bookmark / embed URLs are block props of the shared document (any editor, pasted HTML
// carrying data-content-type="bookmark", imports): they were passed as-is to window.open(), which
// React's javascript: guard does not cover (only the CSP stood in the way).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLinkUrl, safeWebUrl } from './safeUrl';

const DANGEROUS = [
  'javascript:alert(document.domain)',
  'JAVASCRIPT:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  '\u0001javascript:alert(1)',
  'jav&#x09;ascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://example.com/0f2c',
  '',
  '   ',
];

describe('QA-WEB-02: addresses opened by code', () => {
  test('the URL parser really turns disguised schemes into javascript:', () => {
    // Why a regex on the raw string is not enough: these are what window.open() would receive.
    assert.equal(new URL('java\tscript:alert(1)').protocol, 'javascript:');
    assert.equal(new URL('\u0001JavaScript:alert(1)').protocol, 'javascript:');
  });

  test('only web addresses survive', () => {
    for (const raw of DANGEROUS) {
      assert.equal(safeWebUrl(raw), null, JSON.stringify(raw));
      assert.equal(safeLinkUrl(raw), null, JSON.stringify(raw));
    }
    assert.equal(safeWebUrl(undefined), null);
    assert.equal(safeWebUrl(42), null);
    assert.equal(safeWebUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
    assert.equal(safeWebUrl(' http://example.com '), 'http://example.com/');
    assert.equal(safeWebUrl('mailto:a@b.c'), null);
    assert.equal(safeLinkUrl('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(safeLinkUrl('tel:+33123'), 'tel:+33123');
  });

  test('relative addresses only with a base (uploaded files)', () => {
    assert.equal(safeWebUrl('/api/files/abc/doc.pdf'), null);
    assert.equal(safeWebUrl('/api/files/abc/doc.pdf', 'https://oriel.example/w/1/p/2'), 'https://oriel.example/api/files/abc/doc.pdf');
    assert.equal(safeWebUrl('javascript:alert(1)', 'https://oriel.example/'), null);
    assert.equal(safeWebUrl('//evil.example/x', 'https://oriel.example/'), 'https://evil.example/x');
  });
});
