/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isMultiDay, layoutWeek } from './calendarLayout';

const d = (day: number, month = 10) => new Date(2026, month - 1, day);
const monday = d(12); // Monday 12 Oct 2026

describe('calendar layout', () => {
  test('single-day items are not bars', () => {
    assert.equal(isMultiDay({ id: 'a', start: d(12), end: d(12) }), false);
    assert.equal(isMultiDay({ id: 'a', start: d(12), end: d(13) }), true);
  });
  test('bars are clipped to the week and packed into lanes', () => {
    const { spans, lanes } = layoutWeek(monday, [
      { id: 'long', start: d(8), end: d(14) },
      { id: 'mid', start: d(14), end: d(16) },
      { id: 'late', start: d(15), end: d(22) },
      { id: 'other-week', start: d(1), end: d(3) },
      { id: 'single', start: d(13), end: d(13) },
    ]);
    assert.equal(lanes, 2);
    assert.deepEqual(
      spans.map((s) => [s.id, s.from, s.to, s.lane, s.continuesLeft, s.continuesRight]),
      [
        ['long', 0, 2, 0, true, false],
        ['mid', 2, 4, 1, false, false],
        ['late', 3, 6, 0, false, true],
      ],
    );
  });
});
