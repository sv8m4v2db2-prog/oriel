/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkHtmlBlocks, cleanOfficeHtml, isOfficeHtml } from './officePaste';

const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{mso-style-parent:"";}</style><!--[if gte mso 9]><xml><w:WordDocument/></xml><![endif]--></head>
<body><!--StartFragment--><h1 class=MsoHeading1><span style='font-family:"Calibri Light"'>Titre</span><o:p></o:p></h1>
<p class=MsoNormal style='margin:0cm'><span style='mso-bidi-font-weight:bold'>Du <b>gras</b> et <span style='font-style:italic'>italique</span> &amp; plus</span><o:p>&nbsp;</o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'>·<span>&nbsp;&nbsp;</span></span><![endif]>Un</p>
<p class=MsoListParagraph style='mso-list:l0 level2 lfo1'><![if !supportLists]><span>o<span>&nbsp;</span></span><![endif]>Sous-élément</p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><![if !supportLists]><span>1.<span>&nbsp;</span></span><![endif]>Premier</p>
<table class=MsoTableGrid><tr><td width=100 style='border:solid'><p class=MsoNormal>A</p></td><td><p class=MsoNormal>B</p></td></tr></table>
<!--EndFragment--></body></html>`;

describe('E19: Office paste', () => {
  test('detects Office HTML only', () => {
    assert.equal(isOfficeHtml(WORD), true);
    assert.equal(isOfficeHtml('<p>Bonjour <b>toi</b></p>'), false);
  });

  test('removes mso styles, conditional comments, o:p and fonts', () => {
    const out = cleanOfficeHtml(WORD);
    for (const bad of ['mso-', 'o:p', 'font-family', 'class=', 'style=', '<!--', 'supportLists', 'Calibri', '<span']) assert.equal(out.includes(bad), false, bad);
  });

  test('headings, bold, italic', () => {
    const out = cleanOfficeHtml(WORD);
    assert.match(out, /<h1>Titre<\/h1>/);
    assert.match(out, /<p>Du <strong>gras<\/strong> et <em>italique<\/em> &amp; plus<\/p>/);
  });

  test('Word lists become nested bullet and numbered lists, markers removed', () => {
    const out = cleanOfficeHtml(WORD);
    assert.match(out, /<ul><li>Un<ul><li>Sous-élément<\/li><\/ul><\/li><\/ul>/);
    assert.match(out, /<ol><li>Premier<\/li><\/ol>/);
    assert.equal(out.includes('·'), false);
  });

  test('simple tables', () => {
    assert.match(cleanOfficeHtml(WORD), /<table><tbody><tr><td>A<\/td><td>B<\/td><\/tr><\/tbody><\/table>/);
  });

  test('empty spacing paragraphs are dropped', () => {
    assert.equal((cleanOfficeHtml(WORD).match(/<p>/g) ?? []).length, 1);
  });

  test('scripts, event handlers and javascript: links never survive', () => {
    const out = cleanOfficeHtml('<p class=MsoNormal onclick="x()"><script>alert(1)</script><a href="javascript:alert(1)">lien</a><img src="file:///C:/x.png"></p>');
    assert.equal(/script|onclick|javascript|file:|<img/.test(out), false);
    assert.match(out, /lien/);
  });

  test('big pastes are cut in slices', () => {
    const html = Array.from({ length: 400 }, (_, i) => `<p>Ligne ${i}</p>`).join('\n');
    const chunks = chunkHtmlBlocks(html, 150);
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join('\n'), html);
  });
});
