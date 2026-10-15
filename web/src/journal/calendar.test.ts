import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, dayLabel, isOpenableDay, monthGrid, monthLabel, parseMonth, shiftMonth } from './calendar';

test('monthGrid starts on a Monday and covers the whole month', () => {
  const grid = monthGrid('2026-10');
  assert.equal(grid.length, 42);
  // 1 Oct 2026 is a Thursday: the grid starts on Monday 28 Sep.
  assert.equal(grid[0]!.day, '2026-09-28');
  assert.equal(grid[0]!.inMonth, false);
  assert.equal(grid[3]!.day, '2026-10-01');
  assert.equal(grid[3]!.inMonth, true);
  assert.equal(grid.filter((c) => c.inMonth).length, 31);
});

test('monthGrid handles a month starting on Monday and February', () => {
  assert.equal(monthGrid('2026-06')[0]!.day, '2026-06-01');
  assert.equal(monthGrid('2028-02').filter((c) => c.inMonth).length, 29);
  assert.deepEqual(monthGrid('nope'), []);
});

test('shiftMonth crosses year boundaries', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-05', 0), '2026-05');
});

test('labels and parsing', () => {
  assert.equal(monthLabel('2026-10'), 'octobre 2026');
  assert.equal(dayLabel('2026-10-15'), 'jeudi 15 octobre 2026');
  assert.equal(dayLabel('2026-03-01'), 'dimanche 1er mars 2026');
  assert.equal(parseMonth('2026-13'), null);
  assert.equal(parseMonth('1999-12'), null);
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(isOpenableDay('2026-10-15'), true);
  assert.equal(isOpenableDay('1999-01-01'), false);
});
