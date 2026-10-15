/// <reference types="node" />
// QA-WEB-G5-03 — image block: the link is opened by the reader's click, the crop is read from the
// shared document. Same validation as the links of the text; a forged crop cannot break the layout.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cropAspect, cropImageStyle, dragCrop, imageLink, objectViewBox, parseCrop, serializeCrop } from './imageLogic';

describe('QA-WEB-G5-03: image link', () => {
  test('only http, https, mailto and tel', () => {
    for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y', '', null, 3, {}]) {
      assert.equal(imageLink(bad), null, String(bad));
    }
    assert.equal(imageLink('https://exemple.fr/a?b=1'), 'https://exemple.fr/a?b=1');
    assert.equal(imageLink('mailto:a@b.fr'), 'mailto:a@b.fr');
    assert.equal(imageLink('https://x.fr/' + 'a'.repeat(3000)), null);
  });
});

describe('E15: non destructive crop', () => {
  test('forged values are neutral', () => {
    for (const raw of [undefined, null, 4, '', 'a,b,c,d', '0,0,1', '0,0,1,1,1', '0,0,1,1', 'NaN,0,1,1', 'Infinity,0,1,1', 'x'.repeat(200)]) {
      assert.equal(parseCrop(raw), null, String(raw));
    }
  });

  test('rectangles are clamped inside the image with a minimum size', () => {
    assert.deepEqual(parseCrop('0.1,0.2,0.5,0.5'), { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
    assert.deepEqual(parseCrop('0.8,0.9,0.5,0.5'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    assert.deepEqual(parseCrop('-3,-3,0.001,9'), { x: 0, y: 0, w: 0.05, h: 1 });
  });

  test('round trip and reset', () => {
    assert.equal(serializeCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }), '0.1,0.2,0.5,0.4');
    assert.equal(serializeCrop(null), '');
    assert.equal(serializeCrop({ x: 0, y: 0, w: 1, h: 1 }), '');
  });

  test('dragging keeps the rectangle in the image and above the minimum', () => {
    const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    assert.deepEqual(dragCrop(r, 'move', 5, 5), { x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
    assert.deepEqual(dragCrop(r, 'move', -5, -5), { x: 0, y: 0, w: 0.4, h: 0.4 });
    assert.deepEqual(dragCrop(r, 'se', 5, 5), { x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
    assert.deepEqual(dragCrop(r, 'nw', 5, 5), { x: 0.55, y: 0.55, w: 0.05, h: 0.05 });
    assert.deepEqual(dragCrop(r, 'e', -5, 0), { x: 0.2, y: 0.2, w: 0.05, h: 0.4 });
  });

  test('frame geometry', () => {
    const c = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
    assert.equal(cropAspect(c, 1000, 500), 4);
    assert.deepEqual(cropImageStyle(c), { width: '200%', left: '-50%', top: '-200%' });
    assert.equal(objectViewBox(c), 'inset(50% 25% 25% 25%)');
  });
});
