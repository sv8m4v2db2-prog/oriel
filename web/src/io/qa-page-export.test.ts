// H5 — page exports and editor finishes: the standalone HTML must hold no active content, the PNG is
// bounded, block metadata is worded without inventing identities, Typst output goes through the
// shared SVG allow-list.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG_MAX_HEIGHT, EXPORT_CSP, isSafeExportUrl, pngScale, sanitizeExportTree, type TreeNode } from './pageExport';
import { describeBlockMeta, formatAbsolute, formatRelative } from '../editor/blockMetaLogic';
import { sanitizeSvg } from '../editor/svgSanitize';
import { codeRenderKind } from '../editor/codeRenderLogic';
import { normalizeCodeLanguage } from '../editor/codeLanguages';
import { typstErrorMessage } from '../editor/typstRender';

/** A tiny element tree with the members sanitizeExportTree uses. */
class El implements TreeNode {
  tagName: string;
  children: El[] = [];
  attrs = new Map<string, string>();
  parent: El | null = null;
  constructor(tag: string, attrs: Record<string, string> = {}, ...children: El[]) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    for (const c of children) {
      c.parent = this;
      this.children.push(c);
    }
  }
  getAttributeNames() {
    return [...this.attrs.keys()];
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  /** Tag names of the descendants, depth first (iterative: the deep-nesting test builds 50 000 levels). */
  tags(): string[] {
    const out: string[] = [];
    const stack = [...this.children].reverse();
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n.tagName);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
    return out;
  }
}

describe('standalone HTML sanitizing', () => {
  test('scripts, frames, objects, forms and templates are removed with their content', () => {
    const root = new El('div', {}, new El('script'), new El('p', {}, new El('iframe', { src: 'https://x' })), new El('object'), new El('embed'), new El('form', {}, new El('input')), new El('template'), new El('link'), new El('meta'), new El('base'), new El('span'));
    const removed = sanitizeExportTree(root);
    assert.deepEqual(root.tags(), ['P', 'SPAN']);
    assert.ok(removed >= 7);
  });

  test('event handlers, srcdoc and active URLs are removed, safe ones kept', () => {
    const a = new El('a', { href: 'javascript:alert(1)', onclick: 'x()', title: 'ok' });
    const b = new El('a', { href: 'ja\nvascript:alert(1)' });
    const c = new El('a', { href: ' JaVaScRiPt:alert(1)' });
    const d = new El('a', { href: 'https://exemple.fr/page', onmouseover: 'x' });
    const e = new El('img', { src: 'data:image/png;base64,AAAA', onerror: 'x()' });
    const f = new El('img', { src: 'data:text/html;base64,PHNjcmlwdD4=' });
    const g = new El('a', { href: 'data:text/html,<script>alert(1)</script>' });
    const h = new El('a', { href: 'vbscript:x' });
    const i = new El('div', { style: 'background:url(javascript:alert(1))' });
    const j = new El('div', { style: 'color: red' });
    const k = new El('a', { href: '#fn-1' });
    const root = new El('div', {}, a, b, c, d, e, f, g, h, i, j, k);
    sanitizeExportTree(root);
    assert.equal(a.attrs.has('href'), false);
    assert.equal(a.attrs.has('onclick'), false);
    assert.equal(a.attrs.get('title'), 'ok');
    assert.equal(b.attrs.has('href'), false);
    assert.equal(c.attrs.has('href'), false);
    assert.equal(d.attrs.get('href'), 'https://exemple.fr/page');
    assert.equal(d.attrs.has('onmouseover'), false);
    assert.equal(e.attrs.get('src'), 'data:image/png;base64,AAAA');
    assert.equal(e.attrs.has('onerror'), false);
    assert.equal(f.attrs.has('src'), false);
    assert.equal(g.attrs.has('href'), false);
    assert.equal(h.attrs.has('href'), false);
    assert.equal(i.attrs.has('style'), false);
    assert.equal(j.attrs.get('style'), 'color: red');
    assert.equal(k.attrs.get('href'), '#fn-1');
  });

  test('deep nesting does not overflow the stack', () => {
    let node = new El('span');
    for (let i = 0; i < 50_000; i++) node = new El('div', {}, node);
    const root = new El('div', {}, node, new El('script'));
    sanitizeExportTree(root);
    assert.ok(!root.tags().includes('SCRIPT'));
  });

  test('URL rules', () => {
    assert.equal(isSafeExportUrl('/api/files/a/b.png', 'src', 'IMG'), true);
    assert.equal(isSafeExportUrl('mailto:a@b.fr', 'href', 'A'), true);
    assert.equal(isSafeExportUrl('file:///etc/passwd', 'href', 'A'), false);
    assert.equal(isSafeExportUrl('blob:https://x/1', 'src', 'IMG'), false);
    assert.equal(isSafeExportUrl('data:image/svg+xml;base64,AAA', 'src', 'IMG'), true);
    assert.equal(isSafeExportUrl('data:image/svg+xml;base64,AAA', 'src', 'IFRAME'), false);
  });

  test('the file carries a CSP that forbids scripts and frames', () => {
    assert.match(EXPORT_CSP, /default-src 'none'/);
    assert.ok(!/script-src/.test(EXPORT_CSP));
    assert.ok(!/'unsafe-eval'/.test(EXPORT_CSP));
    assert.match(EXPORT_CSP, /form-action 'none'/);
  });
});

describe('PNG bounds', () => {
  test('pngScale refuses pages that are too tall and invalid heights', () => {
    assert.equal(pngScale(PNG_MAX_HEIGHT), 2);
    assert.equal(pngScale(PNG_MAX_HEIGHT + 1), null);
    assert.equal(pngScale(0), null);
    assert.equal(pngScale(Number.NaN), null);
  });
});

describe('block metadata wording', () => {
  const NOW = Date.UTC(2026, 9, 15, 14, 0, 0);
  const user = (id: string, name: string) => ({ id, name, avatarUrl: null });

  test('unknown origin never names anybody', () => {
    assert.deepEqual(describeBlockMeta(null), { created: 'Origine inconnue', modified: null });
    assert.deepEqual(describeBlockMeta({ blockId: 'b', createdBy: null, createdAt: null, modifiedBy: null, modifiedAt: null }), { created: 'Origine inconnue', modified: null });
  });

  test('creation and modification by different people', () => {
    const lines = describeBlockMeta({ blockId: 'b', createdBy: user('1', 'Sam'), createdAt: NOW - 3 * 3600_000, modifiedBy: user('2', 'Léa'), modifiedAt: NOW - 5 * 60_000 }, NOW);
    assert.match(lines.created, /^Créé par Sam, /);
    assert.equal(lines.modified, 'Modifié par Léa, il y a 5 min');
  });

  test('a block never modified after its creation has no second line', () => {
    const lines = describeBlockMeta({ blockId: 'b', createdBy: user('1', 'Sam'), createdAt: NOW, modifiedBy: user('1', 'Sam'), modifiedAt: NOW }, NOW);
    assert.equal(lines.modified, null);
  });

  test('only a modification (older block): creation unknown', () => {
    const lines = describeBlockMeta({ blockId: 'b', createdBy: null, createdAt: null, modifiedBy: user('2', 'Léa'), modifiedAt: NOW - 1000 }, NOW);
    assert.equal(lines.created, 'Création : origine inconnue');
    assert.equal(lines.modified, 'Modifié par Léa, à l’instant');
  });

  test('a removed author is not invented, long names are bounded', () => {
    const lines = describeBlockMeta({ blockId: 'b', createdBy: null, createdAt: NOW, modifiedBy: user('2', 'x'.repeat(500)), modifiedAt: NOW + 1 }, NOW);
    assert.match(lines.created, /un ancien membre/);
    assert.ok(lines.modified!.length < 160);
  });

  test('relative and absolute dates', () => {
    assert.equal(formatRelative(NOW - 10_000, NOW), 'à l’instant');
    assert.equal(formatRelative(NOW - 2 * 3600_000, NOW), 'il y a 2 h');
    assert.equal(formatRelative(NOW - 30 * 3600_000, NOW), 'hier');
    assert.match(formatRelative(NOW - 20 * 86400_000, NOW), /^le /);
    assert.match(formatAbsolute(NOW, NOW), /à/);
  });
});

describe('Typst preview', () => {
  test('typst is a render language with aliases', () => {
    assert.equal(codeRenderKind('typst'), 'typst');
    assert.equal(normalizeCodeLanguage('typ'), 'typst');
    assert.equal(normalizeCodeLanguage('typst'), 'typst');
  });

  test('package and file errors are explained in French', () => {
    assert.match(typstErrorMessage('failed to load package @preview/cetz:0.2.0'), /paquets Typst/);
    assert.match(typstErrorMessage('file not found (searched at image.png) in image'), /fichiers externes/);
    assert.equal(typstErrorMessage('unknown variable: foo'), 'unknown variable: foo');
  });

  test('typst-like SVG: base64 ids with "/" and "+" survive, scripts and external references do not', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<defs><path id="g5t/MrzY+x=" d="M0 0L1 1"/></defs>' +
      '<g class="typst-text" fill="#000"><use x="0" y="0" href="#g5t/MrzY+x="/><use xlink:href="https://evil.example/x.svg#a"/></g>' +
      '<foreignObject><h5:div xmlns:h5="http://www.w3.org/1999/xhtml" onclick="x()">sel</h5:div></foreignObject>' +
      '<script>alert(1)</script><image href="https://evil.example/p.png"/></svg>';
    const out = sanitizeSvg(svg)!;
    assert.match(out, /href="#g5t\/MrzY\+x="/);
    assert.ok(!/evil\.example/.test(out));
    assert.ok(!/script|foreignObject|onclick|<image/i.test(out));
  });
});
