/// <reference types="node" />
// QA-WEB-G5-02 — drawing block: `strokes` comes from the shared document; it must stay bounded and
// can never inject markup into the rendered SVG.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAWING_MAX_LENGTH, DRAWING_MAX_POINTS, DRAWING_MAX_STROKES } from '@oriel/shared';
import { drawingSvg, parseStrokes, serializeStrokes, simplifyPoints, strokeAt, strokePath } from './drawingLogic';

describe('QA-WEB-G5-02: drawing strokes are bounded and rebuilt', () => {
  test('forged values never throw and give no stroke', () => {
    for (const raw of [undefined, null, 3, {}, '', 'x', '{}', '[1,2]', '[null]', '[{"c":"red","w":2,"p":[1,2]}]', `[{"c":"#000000","w":"2","p":[1,2,3,4]}]`]) {
      assert.deepEqual(parseStrokes(raw), [], String(raw));
    }
  });

  test('colors are #rrggbb only: nothing else reaches the SVG', () => {
    const svg = drawingSvg('[{"c":"#ff0000\\" onload=\\"alert(1)","w":2,"p":[1,2,3,4]},{"c":"#00ff00","w":2,"p":[1,2,3,4]}]', '"><script>');
    assert.equal(/onload|script|alert/.test(svg), false);
    assert.equal((svg.match(/<path/g) ?? []).length, 1);
  });

  test('coordinates and widths are clamped, non finite points skipped', () => {
    const [s] = parseStrokes('[{"c":"#000000","w":9999,"p":[-50,2000,"a",3,10.4,20.6,1e400,1]}]');
    assert.deepEqual(s!.p, [0, 600, 10, 21]);
    assert.equal(s!.w, 24);
  });

  test('limits: strokes, points, serialized size', () => {
    const many = Array.from({ length: DRAWING_MAX_STROKES + 50 }, () => ({ c: '#000000', w: 2, p: [1, 1, 2, 2] }));
    assert.equal(parseStrokes(JSON.stringify(many)).length, DRAWING_MAX_STROKES);
    const long = [{ c: '#000000', w: 2, p: Array.from({ length: DRAWING_MAX_POINTS * 4 }, (_, i) => i % 900) }];
    assert.equal(parseStrokes(JSON.stringify(long))[0]!.p.length, DRAWING_MAX_POINTS * 2);
    const huge = Array.from({ length: DRAWING_MAX_STROKES }, () => ({ c: '#000000', w: 2, p: Array.from({ length: 400 }, (_, i) => i % 900) }));
    assert.ok(serializeStrokes(huge).length <= DRAWING_MAX_LENGTH);
    assert.deepEqual(parseStrokes('x'.repeat(DRAWING_MAX_LENGTH + 1)), []);
  });

  test('writing is bounded too (pointer outside the canvas)', () => {
    const out = JSON.parse(serializeStrokes([{ c: '#000000', w: 99, p: [-5, 10, 1283, 795] }]));
    assert.deepEqual(out, [{ c: '#000000', w: 24, p: [0, 10, 1000, 600] }]);
  });

  test('eraser finds the topmost stroke near a point; paths are numeric', () => {
    const strokes = parseStrokes('[{"c":"#000000","w":4,"p":[0,0,100,0]},{"c":"#ff0000","w":4,"p":[50,-10,50,10]}]');
    assert.equal(strokeAt(strokes, 50, 0, 3), 1);
    assert.equal(strokeAt(strokes, 20, 0, 3), 0);
    assert.equal(strokeAt(strokes, 20, 100, 3), -1);
    assert.match(strokePath(strokes[0]!), /^M[\dQL .]+$/);
  });

  test('simplifyPoints keeps ends and thins dense points', () => {
    const dense = Array.from({ length: 100 }, (_, i) => [i * 0.5, 0]).flat();
    const out = simplifyPoints(dense, 2);
    assert.deepEqual(out.slice(0, 2), [0, 0]);
    assert.deepEqual(out.slice(-2), [49.5, 0]);
    assert.ok(out.length < dense.length / 3);
  });
});
