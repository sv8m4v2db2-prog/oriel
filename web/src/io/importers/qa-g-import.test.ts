/// <reference types="node" />
// QA-G8 — file importers (vague G8), run in the browser on files that come from anywhere: sizes
// declared by a ZIP directory, detection regexes, plan limits. Bounds are lowered to keep tests fast.
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { bytesSource, readZipDirectory, readZipEntry, ZipError } from '../zip';
import { buildVfs } from '../vfs';
import { IMPORT_LIMITS, ImportError } from './limits';
import { InflateBudget, openBoundedZip } from './safeZip';
import { looksLikeGoogleDocs } from './confluence';
import { PlanBuilder, mergePlans } from './builder';
import { parseXml } from './xml';
import { parseHtml } from './html';
import { HtmlConverter } from './htmlToBlocks';

const L = IMPORT_LIMITS as unknown as Record<string, number>;
const saved = { ...L };
afterEach(() => Object.assign(L, saved));

/** Deflated archive whose central directory declares `declared[name]` as the uncompressed size. */
function lyingZip(files: Record<string, Uint8Array>, declared: Record<string, number>): Uint8Array {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 9 }]])));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i + 46 <= zip.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(zip.subarray(i + 46, i + 46 + nameLen));
    if (name in declared) view.setUint32(i + 24, declared[name]!, true);
  }
  return zip;
}

const text = (n: number, c = 'a') => strToU8(c.repeat(n));

describe('QA-G8-01: the uncompressed size declared by the archive is not trusted', () => {
  test('an entry larger than declared is not silently truncated', async () => {
    const real = text(5000, 'é');
    const src = bytesSource(lyingZip({ 'note.md': real }, { 'note.md': 10 }));
    const [entry] = await readZipDirectory(src);
    assert.equal(entry!.size, 10);
    assert.deepEqual(await readZipEntry(src, entry!, 1024 * 1024), real);
  });

  test('an entry larger than declared stops at the limit (no inflate of the whole bomb)', async () => {
    // Declared 1 KB, real 32 MB of zeros (32 KB compressed): the preallocated inflate went through
    // the whole stream (≈1.6 s per real GB, a 512 MB file ≈ 500 GB) and returned 1 KB.
    const src = bytesSource(lyingZip({ 'bombe.xml': new Uint8Array(32 * 1024 * 1024) }, { 'bombe.xml': 1024 }));
    const [entry] = await readZipDirectory(src);
    const t = performance.now();
    await assert.rejects(readZipEntry(src, entry!, 1024 * 1024), ZipError);
    assert.ok(performance.now() - t < 200, `${Math.round(performance.now() - t)} ms`);
  });

  test('the total budget of a dropped archive counts the real sizes (vfs)', async () => {
    L.maxTotalInflatedBytes = 1_000_000;
    const zip = lyingZip({ 'a.md': text(600_000), 'b.md': text(600_000), 'c.md': text(600_000) }, { 'a.md': 0, 'b.md': 0, 'c.md': 0 });
    const vfs = await buildVfs([{ path: 'export.zip', blob: new Blob([zip as Uint8Array<ArrayBuffer>]) }]);
    const files = vfs.list();
    assert.equal(files.length, 3);
    await assert.rejects(
      (async () => {
        for (const f of files) await f.read();
      })(),
      ZipError,
    );
  });

  test('the shared budget of OOXML parts counts the real sizes (safeZip)', async () => {
    const zip = lyingZip({ 'a.xml': text(600_000), 'b.xml': text(600_000) }, { 'a.xml': 1, 'b.xml': 1 });
    const z = await openBoundedZip(zip, 'a.docx', new InflateBudget(1_000_000));
    assert.equal((await z.read('a.xml')).length, 600_000);
    await assert.rejects(z.read('b.xml'));
  });

  test('ordinary entries are read as before', async () => {
    const real = text(20_000, 'x');
    for (const declared of [undefined, 0, 20_000, 30_000]) {
      const src = bytesSource(declared === undefined ? zipSync({ 'n.md': real }) : lyingZip({ 'n.md': real }, { 'n.md': declared }));
      const [entry] = await readZipDirectory(src);
      assert.deepEqual(await readZipEntry(src, entry!, 1024 * 1024), real, String(declared));
    }
  });
});

describe('QA-G8-02: HTML detection stays linear', () => {
  test('Google Docs detection on crafted heads', () => {
    for (const s of ['name="generator"'.repeat(12_500), '<style'.repeat(33_000)]) {
      const t = performance.now();
      looksLikeGoogleDocs(s);
      const ms = performance.now() - t;
      assert.ok(ms < 150, `${s.slice(0, 16)}… : ${Math.round(ms)} ms`);
    }
    assert.equal(looksLikeGoogleDocs('<meta name="generator" content="Google Docs">'), true);
    assert.equal(looksLikeGoogleDocs('<style type="text/css">ol.lst-kix_abc{}</style>'), true);
    assert.equal(looksLikeGoogleDocs('<p>Bonjour</p>'), false);
  });
});

describe('QA-G8-03: the page limit holds for the whole import, not per file', () => {
  test('several files cannot add up past the limit', () => {
    L.maxPages = 10;
    const plans = [0, 1, 2].map((k) => {
      const b = new PlanBuilder();
      for (let i = 0; i < 8; i++) b.page({ title: `p${k}-${i}` });
      return b.build('docx');
    });
    assert.throws(() => mergePlans(plans), ImportError);
    assert.equal(mergePlans(plans.slice(0, 1)).counts.pages, 8);
  });
});

describe('QA-G8-04 (écartée): parsers and conversion', () => {
  test('XML attributes cannot pollute prototypes', () => {
    const root = parseXml('<a __proto__="x" constructor="y" toString="z" ok="1"><b/></a>');
    assert.equal(root.attrs.ok, '1');
    assert.equal(Object.prototype.hasOwnProperty.call(root.attrs, '__proto__'), false);
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  test('imported HTML keeps no script, no disguised scheme, no protocol-relative address', () => {
    const html =
      '<p><a href=" javascript:alert(1)">a</a><a href="JaVaScRiPt:alert(2)">b</a><a href="data:text/html,<script>alert(3)</script>">c</a>' +
      '<a href="//evil.example/x">d</a><a href="/\\evil.example">e</a><a href="https://ok.example/">f</a></p>' +
      '<img src="//evil.example/p.png"><img src="javascript:alert(4)"><img src="data:image/svg+xml,<svg onload=alert(5)>">' +
      '<link rel=stylesheet href="https://evil.example/a.css"><style>@import url(https://evil.example/b.css)</style><iframe src="https://evil.example"></iframe>';
    const root = parseHtml(html);
    const json = JSON.stringify(new HtmlConverter(root, { warn: () => undefined }).convert(root.children));
    assert.equal(/javascript|alert|evil\.example|data:/i.test(json), false, json);
    assert.match(json, /https:\/\/ok\.example\//);
  });

  test('deep HTML nesting is refused, not recursed', () => {
    assert.throws(() => parseHtml('<div>'.repeat(10_000)), ImportError);
  });
});
