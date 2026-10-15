/// <reference types="node" />
// QA-WEB-14 — a generic embed could frame Oriel's own origin (CSP frame-src 'self', sandbox with
// allow-scripts + allow-same-origin): an uploaded HTML file or any app route would then run with
// the reader's session. QA-WEB-11 — the PDF block framed any /api/files/… URL: a non-PDF upload
// (served as an attachment) was downloaded by every reader of the page.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, embedSource } from './embeds';
import { canFramePdf, isAppOrigin, looksLikePdf } from './frameGuards';

const APP = 'https://oriel.example';
const FILE_ID = '0123456789abcdef0123456789abcdef';

describe('QA-WEB-14: the generic embed never frames the app itself', () => {
  test('own origin (any path, case, default port) and relative addresses', () => {
    for (const raw of [
      `${APP}/api/files/${FILE_ID}/page.html`,
      `${APP}/w/1/p/2`,
      'https://ORIEL.example:443/share/x',
      ' https://oriel.example/ ',
      '/api/files/x/y.html',
      'api/files/x',
      '//oriel.example/w/1',
    ]) {
      assert.equal(isAppOrigin(raw, APP), true, raw);
    }
    for (const raw of ['https://exemple.fr/page', 'https://oriel.example.evil.example/', 'https://sub.oriel.example/', 'http://oriel.example/']) {
      assert.equal(isAppOrigin(raw, APP), false, raw);
    }
    assert.equal(isAppOrigin(`${APP}/w/1`, ''), false); // outside a browser: no origin to compare
  });

  test('embedSource refuses the app origin for the generic provider (forged blocks included)', () => {
    assert.equal(embedSource(`${APP}/api/files/${FILE_ID}/page.html`, 'generic', APP), null);
    assert.equal(embedSource('https://oriel.example/w/1/p/2', 'generic', APP), null);
    assert.equal(embedSource('/api/files/x/page.html', 'generic', APP), null); // relative: never framed
    assert.equal(embedSource('https://exemple.fr/page', 'generic', APP), 'https://exemple.fr/page');
    // Known providers are unaffected.
    assert.equal(embedSource('https://youtu.be/dQw4w9WgXcQ', 'youtube', APP), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    // Still a valid link (bookmarks): the refusal is about framing.
    assert.equal(detectProvider(`${APP}/w/1/p/2`)!.provider, 'generic');
  });

  test('own PDFs pasted into an embed go to the PDF viewer instead', () => {
    assert.equal(canFramePdf(`${APP}/api/files/${FILE_ID}/rapport.pdf`, '', APP), true);
    assert.equal(canFramePdf(`${APP}/api/files/${FILE_ID}/page.html`, '', APP), false);
  });
});

describe('QA-WEB-11: the PDF block only frames uploaded PDF files', () => {
  test('uploaded PDFs are framed', () => {
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/rapport.pdf`, 'rapport.pdf', APP), true);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/Rapport%20annuel.PDF`, '', APP), true);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/rapport%C3%A9t%C3%A9.pdf`, '', APP), true);
    // Name only in the block (URL segment without extension).
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/rapport`, 'rapport.pdf', APP), true);
  });

  test('any other file is shown as a link (it would download for every reader)', () => {
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/archive.zip`, 'archive.zip', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/page.html`, '', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/x.pdf.exe`, '', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/x.exe?f=a.pdf`, '', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/x.exe#a.pdf`, '', APP), false);
  });

  test('only uploaded files of this instance', () => {
    assert.equal(canFramePdf('https://exemple.fr/rapport.pdf', 'rapport.pdf', APP), false);
    assert.equal(canFramePdf(`https://exemple.fr/api/files/${FILE_ID}/rapport.pdf`, '', APP), false);
    assert.equal(canFramePdf('/api/files/not-an-id/rapport.pdf', '', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/../../auth/me.pdf`, '', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/a/b.pdf`, '', APP), false);
    assert.equal(canFramePdf('/w/1/p/x.pdf', '', APP), false);
    assert.equal(canFramePdf('javascript:alert(1)//x.pdf', 'x.pdf', APP), false);
    assert.equal(canFramePdf('', 'x.pdf', APP), false);
    assert.equal(canFramePdf(`/api/files/${FILE_ID}/x.pdf`, '', ''), false);
  });

  test('looksLikePdf', () => {
    assert.equal(looksLikePdf('a.pdf'), true);
    assert.equal(looksLikePdf(' A.PDF '), true);
    assert.equal(looksLikePdf('a.pdfx'), false);
    assert.equal(looksLikePdf(''), false);
    assert.equal(looksLikePdf({} as unknown as string), false);
  });
});
