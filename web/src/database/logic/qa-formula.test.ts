/// <reference types="node" />
// QA-WEB-01 — formulas are part of the shared database schema: any member allowed to edit it chooses
// what every viewer's browser (public pages included) evaluates. Formulas that refer several times to
// another formula, itself referring several times to another… must not cost an exponential number of
// evaluations (fan^depth per cell froze the view: 10 references × 7 levels ≈ 3 s per row).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, PropertyDef } from '@oriel/shared';
import { createRowContext, getFormulaResult, type RowContext } from './values';

/** N (number) ← F0 ← F1 … ← F{levels}, each formula adding `fan` times the previous one. */
function chain(levels: number, fan: number, cyclic = false): PropertyDef[] {
  const props: PropertyDef[] = [
    { id: 'title', name: 'Nom', type: 'title' },
    { id: 'n', name: 'N', type: 'number' },
    // Cyclic variant: the first formula also refers to the last one (circular definition).
    { id: 'f0', name: 'F0', type: 'formula', formula: cyclic ? `prop("N") + prop("F${levels}")` : 'prop("N")' },
  ];
  for (let i = 1; i <= levels; i++) {
    props.push({ id: `f${i}`, name: `F${i}`, type: 'formula', formula: Array(fan).fill(`prop("F${i - 1}")`).join(' + ') });
  }
  return props;
}

/** Counts the prop("…") lookups made while evaluating (one per evaluated reference). */
function countLookups(ctx: RowContext): () => number {
  const get = ctx.byName.get.bind(ctx.byName);
  let n = 0;
  ctx.byName.get = (name: string) => {
    n++;
    return get(name);
  };
  return () => n;
}

const row = { id: 'r1', title: 'Ligne', properties: { n: 1 }, createdAt: 0, updatedAt: 0 } as unknown as Page;

describe('QA-WEB-01: formula evaluation cost is bounded', () => {
  test('a formula referenced many times is evaluated once per row', () => {
    const props = chain(6, 10);
    const ctx = createRowContext(props);
    const lookups = countLookups(ctx);
    const top = props[props.length - 1]!;
    const started = Date.now();
    assert.deepEqual(getFormulaResult(row, top, ctx), { type: 'number', value: 1_000_000 });
    // 6 levels × 10 references (+1 for N): without memoization, 10^6 + … lookups.
    assert.ok(lookups() <= 100, `${lookups()} lookups`);
    assert.ok(Date.now() - started < 1000);
    // Intermediate formulas are now cached too (same values as a direct evaluation).
    assert.deepEqual(getFormulaResult(row, props[4]!, ctx), { type: 'number', value: 100 });
    assert.equal(lookups() <= 100, true);
  });

  test('a circular definition stays bounded and is reported', () => {
    const props = chain(7, 10, true);
    const ctx = createRowContext(props);
    const lookups = countLookups(ctx);
    const started = Date.now();
    const r = getFormulaResult(row, props[props.length - 1]!, ctx);
    assert.equal(r.type, 'empty');
    assert.ok(r.error, 'an error is reported');
    // Every intermediate result depends on the cycle (not cacheable): the evaluation budget caps the work.
    assert.ok(lookups() < 300_000, `${lookups()} lookups`);
    assert.ok(Date.now() - started < 3000);
  });

  test('values of ordinary formulas are unchanged', () => {
    const props: PropertyDef[] = [
      { id: 'title', name: 'Nom', type: 'title' },
      { id: 'n', name: 'N', type: 'number' },
      { id: 'a', name: 'A', type: 'formula', formula: 'prop("N") * 2' },
      { id: 'b', name: 'B', type: 'formula', formula: 'prop("A") + prop("A") + prop("N")' },
      { id: 'c', name: 'C', type: 'formula', formula: 'if(prop("B") > 4, concat("grand ", prop("B")), "petit")' },
      { id: 'x', name: 'X', type: 'formula', formula: 'prop("Y")' },
      { id: 'y', name: 'Y', type: 'formula', formula: 'prop("X")' },
    ];
    const ctx = createRowContext(props);
    const p = (id: string) => props.find((x) => x.id === id)!;
    assert.deepEqual(getFormulaResult(row, p('c'), ctx), { type: 'string', value: 'grand 5' });
    assert.deepEqual(getFormulaResult(row, p('b'), ctx), { type: 'number', value: 5 });
    assert.deepEqual(getFormulaResult(row, p('a'), ctx), { type: 'number', value: 2 });
    assert.equal(getFormulaResult(row, p('x'), ctx).type, 'empty');
    assert.equal(getFormulaResult(row, p('y'), ctx).type, 'empty');
  });
});

describe('QA-WEB-01: evaluation trees get their own budget', () => {
  test('a nested start (formula editor preview) is not starved by an earlier evaluation', async () => {
    const { toFormulaValue } = await import('./values');
    // Exhaust a budget first (circular definition), then evaluate like the formula editor does.
    const cyclic = chain(7, 10, true);
    getFormulaResult(row, cyclic[cyclic.length - 1]!, createRowContext(cyclic));
    const props = chain(2, 3);
    const ctx = createRowContext(props);
    assert.equal(toFormulaValue(row, props[props.length - 1]!, ctx, ['brouillon']), 9);
  });
});
