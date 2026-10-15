/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateValueToRange,
  dayKey,
  moveDateValueToDay,
  parseDateString,
  rangeDayKeys,
  relativeRangeKeys,
  resolveFilterDate,
  serializeDate,
  shiftDateValue,
  toDateString,
} from './dates';
import { NOW } from './testFixtures';

describe('dates', () => {
  test('parses date-only strings as local days', () => {
    const d = parseDateString('2026-03-05')!;
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 2);
    assert.equal(d.getDate(), 5);
    assert.equal(d.getHours(), 0);
    assert.equal(toDateString(d), '2026-03-05');
  });

  test('parses ISO date-times and rejects garbage', () => {
    const iso = new Date(2026, 4, 1, 14, 30).toISOString();
    assert.equal(parseDateString(iso)!.getHours(), 14);
    assert.equal(parseDateString('pas une date'), null);
    assert.equal(parseDateString(''), null);
    assert.equal(parseDateString(null), null);
  });

  test('dayKey is comparable', () => {
    assert.equal(dayKey(new Date(2026, 0, 9)), 20260109);
    assert.ok(dayKey(new Date(2025, 11, 31)) < dayKey(new Date(2026, 0, 1)));
  });

  test('serializeDate keeps date-only values local', () => {
    const d = new Date(2026, 6, 14, 23, 45);
    assert.equal(serializeDate(d, false), '2026-07-14');
    assert.equal(serializeDate(d, true), d.toISOString());
  });

  test('dateValueToRange / rangeDayKeys', () => {
    const r = dateValueToRange({ start: '2026-10-20', end: '2026-10-10' })!;
    assert.deepEqual(rangeDayKeys(r), [20261010, 20261020]);
    assert.equal(dateValueToRange(null), null);
    assert.equal(dateValueToRange({ start: 'xx' }), null);
    assert.equal(dateValueToRange('2026-01-01'), null);
  });

  test('relative ranges around now', () => {
    assert.deepEqual(relativeRangeKeys('today', NOW), [20261013, 20261013]);
    assert.deepEqual(relativeRangeKeys('past_week', NOW), [20261006, 20261013]);
    assert.deepEqual(relativeRangeKeys('next_week', NOW), [20261013, 20261020]);
    assert.deepEqual(relativeRangeKeys('past_month', NOW), [20260913, 20261013]);
    assert.deepEqual(relativeRangeKeys('next_month', NOW), [20261013, 20261113]);
    assert.deepEqual(relativeRangeKeys('next_year', NOW), [20261013, 20271013]);
  });

  test('resolveFilterDate understands relative days', () => {
    assert.equal(toDateString(resolveFilterDate('today', NOW)!), '2026-10-13');
    assert.equal(toDateString(resolveFilterDate('tomorrow', NOW)!), '2026-10-14');
    assert.equal(toDateString(resolveFilterDate('yesterday', NOW)!), '2026-10-12');
    assert.equal(toDateString(resolveFilterDate('2026-01-02', NOW)!), '2026-01-02');
    assert.equal(resolveFilterDate(42, NOW), null);
  });

  test('shiftDateValue moves start and end', () => {
    assert.deepEqual(shiftDateValue({ start: '2026-10-30', end: '2026-11-02' }, 3), {
      start: '2026-11-02',
      end: '2026-11-05',
      includeTime: undefined,
    });
    const withTime = shiftDateValue({ start: new Date(2026, 0, 1, 9, 15).toISOString(), includeTime: true }, -1);
    const d = parseDateString(withTime.start)!;
    assert.equal(toDateString(d), '2025-12-31');
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 15);
  });

  test('moveDateValueToDay keeps the range length', () => {
    const moved = moveDateValueToDay({ start: '2026-10-01', end: '2026-10-03' }, new Date(2026, 9, 10));
    assert.equal(moved.start, '2026-10-10');
    assert.equal(moved.end, '2026-10-12');
    assert.deepEqual(moveDateValueToDay(null, new Date(2026, 1, 3)), { start: '2026-02-03' });
  });
});
