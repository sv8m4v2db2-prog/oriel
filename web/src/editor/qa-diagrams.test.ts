/// <reference types="node" />
// QA-WEB-G5-01 — diagram renders (Mermaid, ABC). The SVG produced by a third-party renderer from text
// that any collaborator (or anonymous author of a published page) controls must not be able to run
// script, load a remote resource, submit a form, or restyle the page. It is rebuilt from an allow-list.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCss, sanitizeSvg } from './svgSanitize';
import { CODE_RENDER_MAX_LENGTH, codeRenderKind, codeView, renderSourceLimit } from './codeRenderLogic';

const svg = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('QA-WEB-G5-01: sanitizeSvg removes everything active', () => {
  test('script, foreignObject, image, anchors and animations are dropped with their content', () => {
    const out = sanitizeSvg(
      svg(
        '<script>alert(1)</script><foreignObject><div onclick="x()">hi</div><iframe src="https://evil.example"></iframe></foreignObject>' +
          '<image href="https://evil.example/p.png"/><a href="javascript:alert(1)"><text>lien</text></a>' +
          '<animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:x"/>' +
          '<rect width="10" height="10"/>',
      ),
    )!;
    assert.ok(out.includes('<rect'));
    for (const bad of ['script', 'foreignObject', 'iframe', 'image', '<a ', 'animate', '<set', 'alert', 'evil.example', 'onclick']) {
      assert.equal(out.includes(bad), false, bad);
    }
  });

  test('event handlers and unknown attributes are removed whatever their case', () => {
    const out = sanitizeSvg(svg('<rect onload="x()" onClick="y()" ONMOUSEOVER=z() width="1" formaction="x" srcdoc="<b>" data-id="n1"/>'))!;
    assert.match(out, /<rect width="1" data-id="n1"\/>/);
  });

  test('links: only #fragment references survive', () => {
    const out = sanitizeSvg(
      svg(
        '<use href="javascript:alert(1)"/><use xlink:href="data:image/svg+xml,<svg onload=alert(1)>"/><use href="#a"/><path id="a" d="M0 0"/>' +
          '<rect fill="url(https://evil.example/x.svg#f)" width="1"/><rect fill="url(#g)" width="2"/><rect style="fill:url(//evil.example/a)" width="3"/>',
      ),
    )!;
    assert.equal((out.match(/<use /g) ?? []).length, 1);
    assert.ok(out.includes('href="#a"'));
    assert.ok(out.includes('fill="url(#g)"'));
    assert.equal(out.includes('evil.example'), false);
    assert.equal(out.includes('javascript'), false);
  });

  test('disguised schemes (entities, control characters, case) are refused', () => {
    for (const value of ['jav&#x61;script:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', 'vbscript:x', 'data:text/html;base64,PHNjcmlwdD4=']) {
      const out = sanitizeSvg(svg(`<text aria-label="${value}" fill="${value}">t</text>`))!;
      assert.equal(/aria-label|fill=/.test(out), false, value);
    }
  });

  test('style attributes and <style> rules with imports, expressions or remote URLs are dropped', () => {
    assert.equal(sanitizeCss('fill:red;stroke:#000'), 'fill:red;stroke:#000');
    assert.equal(sanitizeCss('background:url(https://evil.example/x)'), null);
    assert.equal(sanitizeCss('@import url(https://evil.example/a.css);'), null);
    assert.equal(sanitizeCss('width:expression(alert(1))'), null);
    assert.equal(sanitizeCss('fill:\\75 rl(https://evil.example)'), null);
    const out = sanitizeSvg(
      svg(
        '<style>.a{fill:red}\n@import url("https://evil.example/x.css");\n.b{background:url(https://evil.example/p.png)}\n.c>rect{stroke:#000}</style><g class="a"/>',
      ),
    )!;
    assert.ok(out.includes('.a{fill:red}'));
    assert.ok(out.includes('.c&gt;rect{stroke:#000}'));
    assert.equal(out.includes('evil.example'), false);
    assert.equal(out.includes('@import'), false);
  });

  test('markup cannot be smuggled through text, CDATA or sloppy nesting', () => {
    const out = sanitizeSvg(
      svg('<text><![CDATA[<script>alert(1)</script>]]></text><text>&lt;img src=x onerror=alert(1)&gt;</text><title>a<b>c</title><g><rect/></svg><script>x()</script>'),
    )!;
    assert.equal(out.includes('<script'), false);
    assert.equal(/<img/.test(out), false);
    assert.ok(out.includes('&lt;script&gt;'));
    // Well formed: every element is closed.
    assert.ok(out.endsWith('</svg>'));
  });

  test('an input without a root <svg> is refused; a second root is ignored; oversize input is refused', () => {
    assert.equal(sanitizeSvg('<div>x</div>'), null);
    assert.equal(sanitizeSvg(''), null);
    assert.equal(sanitizeSvg('<script>alert(1)</script><svg><rect/></svg>')?.startsWith('<svg'), true);
    assert.equal(sanitizeSvg(`<svg>${'a'.repeat(4 * 1024 * 1024)}</svg>`), null);
  });

  test('the root always carries the SVG namespace and nothing else', () => {
    const out = sanitizeSvg('<svg xmlns="https://evil.example/ns" onload="x()" viewBox="0 0 1 1"><rect/></svg>')!;
    assert.match(out, /^<svg viewBox="0 0 1 1" xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  test('a realistic Mermaid-like output keeps its structure', () => {
    const out = sanitizeSvg(
      '<?xml version="1.0"?><svg id="m1" width="100%" viewBox="0 0 200 100" style="max-width: 200px;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<style>#m1{font-family:"trebuchet ms",verdana;font-size:16px}#m1 .node rect{fill:#ECECFF}</style>' +
        '<g><marker id="arrow" refX="6" refY="5" markerWidth="12" markerHeight="12" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></g>' +
        '<g class="nodes"><g class="node default" id="flowchart-A-0" transform="translate(50, 50)"><rect class="basic" x="-30" y="-20" width="60" height="40"/><g class="label"><text><tspan x="0" dy="1em">A &amp; B</tspan></text></g></g></g></svg>',
    )!;
    for (const part of ['<marker id="arrow"', 'transform="translate(50, 50)"', '<tspan x="0" dy="1em">A &amp; B</tspan>', '#m1 .node rect{fill:#ECECFF}', 'max-width: 200px']) {
      assert.ok(out.includes(part), part);
    }
  });
});

describe('E13: block view and limits', () => {
  test('codeRenderKind recognizes Mermaid and ABC, and only those', () => {
    assert.equal(codeRenderKind('mermaid'), 'mermaid');
    assert.equal(codeRenderKind('abc'), 'abc');
    assert.equal(codeRenderKind('javascript'), null);
    assert.equal(codeRenderKind(undefined), null);
    assert.equal(codeRenderKind({ toString: () => 'mermaid' }), null);
  });

  test('a forged view falls back to "both"', () => {
    assert.equal(codeView('code'), 'code');
    assert.equal(codeView('preview'), 'preview');
    for (const v of ['', 'x', null, undefined, 3, {}, 'CODE ']) assert.equal(codeView(v), 'both');
  });

  test('sources beyond the limit are not rendered', () => {
    assert.equal(renderSourceLimit('graph TD; A-->B'), 'ok');
    assert.equal(renderSourceLimit(''), 'empty');
    assert.equal(renderSourceLimit('   \n '), 'empty');
    assert.equal(renderSourceLimit('x'.repeat(CODE_RENDER_MAX_LENGTH + 1)), 'too-large');
  });
});
