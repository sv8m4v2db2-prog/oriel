/// <reference types="node" />
// QA-G5 — blocks and input of the editor (vague G5): Office paste, diagram SVG, image links / crop,
// drawing data. Pure functions only (no DOM); the slow cases are measured on small inputs and must
// stay linear (the original code was quadratic: the thresholds fail it by a wide margin).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOfficeHtml, isOfficeHtml } from './officePaste';
import { sanitizeCss, sanitizeSvg } from './svgSanitize';
import { imageLink, parseCrop, cropImageStyle } from './imageLogic';
import { drawingSvg, parseStrokes } from './drawingLogic';

function fast(label: string, fn: () => unknown, maxMs = 250) {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  assert.ok(ms < maxMs, `${label} : ${Math.round(ms)} ms`);
}

describe('QA-G5-01: Office paste stays linear on crafted clipboard HTML', () => {
  // Any web page can put such HTML in the clipboard: the detection runs on EVERY HTML paste, the
  // cleaning on everything that looks like Office. 1 MB of the first case froze the tab for minutes.
  test('Office detection (every HTML paste)', () => {
    fast('ProgId…', () => isOfficeHtml('ProgId'.repeat(16_000)));
    assert.equal(isOfficeHtml('<meta name=ProgId content=Word.Document>'), true);
    assert.equal(isOfficeHtml('<meta name="ProgId" content="Excel.Sheet">'), true);
    assert.equal(isOfficeHtml('<p>ProgId</p><p>Word</p>'.replace('</p><p>', '\n')), false);
  });

  test('unterminated tags, conditional comments and fragments', () => {
    fast('<a<a<a…', () => cleanOfficeHtml('mso-' + '<a'.repeat(24_000)));
    fast('<!--[if… sans endif', () => cleanOfficeHtml('mso-' + '<!--[if x]>'.repeat(20_000)));
    fast('<![if… sans endif', () => cleanOfficeHtml('mso-' + '<![if x]>'.repeat(24_000)));
    fast('<!-- sans fin', () => cleanOfficeHtml('mso-' + '<!--'.repeat(30_000)));
    fast('StartFragment sans fin', () => cleanOfficeHtml('<!--StartFragment-->'.repeat(16_000)));
    fast('mso-list répété', () => cleanOfficeHtml('<p style="' + 'mso-list:'.repeat(24_000) + '">x</p>'));
  });

  test('deep nesting neither overflows the stack nor loses the text', () => {
    const html = 'mso-' + '<span>'.repeat(20_000) + 'texte profond' + '</span>'.repeat(20_000);
    let out = '';
    assert.doesNotThrow(() => (out = cleanOfficeHtml(html)));
    assert.match(out, /texte profond/);
  });

  test('same output as before on ordinary Office HTML', () => {
    const word =
      '<!--[if gte mso 9]><xml><w:WordDocument/></xml><![endif]--><!--StartFragment--><p class=MsoNormal>Du <b>gras</b></p>' +
      "<p class=MsoListParagraph style='mso-list:l0 level2 lfo1'><![if !supportLists]><span>·<span>&nbsp;</span></span><![endif]>Un</p><!--EndFragment-->";
    assert.equal(cleanOfficeHtml(word), '<p>Du <strong>gras</strong></p>\n<ul><li>Un</li></ul>');
  });

  test('links: only http(s), mailto, tel survive (écartée : déjà sûr)', () => {
    const out = cleanOfficeHtml(
      'mso-<p><a href="javascript:alert(1)">a</a><a href=" java&#x09;script:x">b</a><a href="https://ok.example/?a=1&b=&quot;x">c</a><img src="file:///C:/x.png"><v:shape>vml</v:shape></p>',
    );
    assert.equal(out.includes('javascript'), false);
    assert.equal(/file:|<img|v:shape/.test(out), false);
    assert.match(out, /<a href="https:\/\/ok\.example\/\?a=1&amp;b=&quot;x">c<\/a>/);
  });
});

describe('QA-G5-02 (écartée): diagram SVG sanitizer with real payloads', () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}<rect width="1"/></svg>`;
  const clean = (inner: string) => sanitizeSvg(svg(inner)) ?? '';

  test('namespaced, upper-case and nested active elements are dropped', () => {
    const out = clean(
      '<svg:script>alert(1)</svg:script><SCRIPT>alert(2)</SCRIPT><html:iframe src="https://evil.example"/>' +
        '<feImage href="https://evil.example/a.png"/><a xlink:href="javascript:alert(3)"><text>t</text></a>' +
        '<g xmlns="http://www.w3.org/1999/xhtml"><rect/></g><g><foreignObject><img src=x onerror=alert(4)></foreignObject></g>' +
        '<animate attributeName="href" to="javascript:alert(5)"/><set attributeName="onclick" to="alert(6)"/><![CDATA[<script>alert(7)</script>]]>',
    );
    assert.equal(/<script|<iframe|feImage|<a |foreignObject|<img|onerror|animate|<set|evil\.example|xhtml|javascript/i.test(out), false, out);
    assert.match(out, /&lt;script&gt;alert\(7\)/); // CDATA text kept as inert text
  });

  test('external references and CSS escapes are refused', () => {
    const out = clean(
      '<use href="https://evil.example/s.svg#x"/><use xlink:href="data:image/svg+xml;base64,PHN2Zz4="/><use href="#ok"/>' +
        '<rect style="fill:u&#114;l(https://evil.example/a)"/><rect style="fill:\\75rl(https://evil.example/b)"/>' +
        '<rect style="fill:u/**/rl(https://evil.example/c)"/><rect filter="url( \'https://evil.example/d\' )"/>' +
        '<style>@import "https://evil.example/e.css";</style><style>.a{fill:red}</style><style>.b{background:-webkit-image-set("https://evil.example/f" 1x)}.c{fill:blue}</style>',
    );
    assert.equal(out.includes('evil.example'), false, out);
    assert.equal((out.match(/<use /g) ?? []).length, 1);
    assert.match(out, /\.a\{fill:red\}/);
    assert.match(out, /\.c\{fill:blue\}/);
    assert.equal(sanitizeCss('fill:&#92;75rl(https://evil.example)'), null);
  });

  test('entities and control characters never rebuild a scheme or break out of an attribute', () => {
    const out = clean('<text aria-label="a&quot; onload=&quot;x" fill="&#0;javascript:x">t</text><text x="1&#x22; onmouseover=&#x22;y">u</text>');
    const names = out.replace(/="[^"]*"/g, '=""');
    assert.equal(/\son\w+=|fill=/.test(names), false, out);
    // The result is well-formed XML (parsed by DOMParser image/svg+xml in the app): no raw quote inside a value.
    for (const m of out.matchAll(/="([^"]*)"/g)) assert.equal(m[1]!.includes('<'), false);
  });
});

describe('QA-G5-03 (écartée): image link and crop come from the shared document', () => {
  test('only http, https, mailto, tel links', () => {
    for (const bad of ['javascript:alert(1)', ' JaVa\tScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example', '/\\evil.example', 'file:///etc/passwd', 'vbscript:x', 'x'.repeat(3000)]) {
      assert.equal(imageLink(bad), null, bad.slice(0, 40));
    }
    assert.equal(imageLink(42), null);
    assert.equal(imageLink('https://exemple.fr/a b'), 'https://exemple.fr/a%20b');
    assert.equal(imageLink('mailto:a@b.fr'), 'mailto:a@b.fr');
  });

  test('crop is always a finite rectangle inside the image, at least 5 %', () => {
    for (const raw of ['0,0,0,0', '-5,-5,99,99', '1e308,1e308,1e-308,1e-308', 'NaN,0,1,1', '0.9,0.9,0.5,0.5', '0,0,1,1,1', '__proto__', '0;0;1;1']) {
      const c = parseCrop(raw);
      if (!c) continue;
      for (const v of [c.x, c.y, c.w, c.h]) assert.ok(Number.isFinite(v), raw);
      assert.ok(c.w >= 0.05 && c.h >= 0.05 && c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, raw);
      for (const v of Object.values(cropImageStyle(c))) assert.match(v, /^-?[\d.]+%$/);
    }
  });
});

describe('QA-G5-04 (écartée): drawing data is rebuilt from numbers', () => {
  test('hostile strokes never reach the SVG text', () => {
    const raw = JSON.stringify([
      { c: '#fff"/><script>alert(1)</script>', w: 2, p: [1, 2, 3, 4] },
      { c: '#ff0000', w: '2" onload="x', p: [1, 2, 3, 4] },
      { c: '#00ff00', w: 1e9, p: [1e9, -1e9, 'x', 5, 6, 7] },
      { c: '#0000ff', w: 4, p: [10, 10, 20, 20], extra: '<svg onload=alert(1)>' },
    ]);
    const svg = drawingSvg(raw, '"><script>');
    assert.equal(/script|onload|alert/.test(svg), false, svg);
    const strokes = parseStrokes(raw);
    assert.equal(strokes.length, 2);
    assert.ok(strokes.every((s) => s.w >= 1 && s.w <= 24 && s.p.every((n) => Number.isInteger(n) && n >= 0)));
  });
});
