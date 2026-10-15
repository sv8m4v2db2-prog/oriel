import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlides, slideCss } from './slidesLogic';

const p = { type: 'paragraph' };
const h = (level: number) => ({ type: 'heading', props: { level } });
const d = { type: 'divider' };

test('dividers split the page and are not part of the slides', () => {
  assert.deepEqual(computeSlides([p, p, d, p, d, d, h(1), p]), [
    { start: 0, end: 1 },
    { start: 3, end: 3 },
    { start: 6, end: 7 },
  ]);
});

test('without dividers, level 1 headings split; content before the first one is a slide', () => {
  assert.deepEqual(computeSlides([p, h(1), p, p, h(1), h(2), p]), [
    { start: 0, end: 0 },
    { start: 1, end: 3 },
    { start: 4, end: 6 },
  ]);
  assert.deepEqual(computeSlides([h(1), p, h(2), p]), [{ start: 0, end: 3 }]);
});

test('falls back to level 2, then to a single slide', () => {
  assert.deepEqual(computeSlides([h(2), p, h(2), p]), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);
  assert.deepEqual(computeSlides([p, p, h(3)]), [{ start: 0, end: 2 }]);
  assert.deepEqual(computeSlides([]), [{ start: 0, end: -1 }]);
});

test('string levels are understood', () => {
  assert.equal(computeSlides([{ type: 'heading', props: { level: '1' } }, p, { type: 'heading', props: { level: '1' } }]).length, 2);
});

test('slideCss shows the 1-based range', () => {
  const css = slideCss('.root', { start: 2, end: 4 });
  assert.match(css, /nth-child\(n\+3\):nth-child\(-n\+5\)/);
});
