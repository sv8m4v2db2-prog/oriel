/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canBoardBy, canGroupBy, computeGroups, NO_VALUE_KEY } from './group';
import { makeContext, makeRow, prop } from './testFixtures';

const ctx = makeContext();
const rows = [
  makeRow('a', 'A', { cat: 'o2', etat: 'done', tags: ['t1', 't2'], fait: true, resp: ['u2', 'u1'] }),
  makeRow('b', 'B', { cat: 'o1', etat: 'todo', tags: ['t2'] }),
  makeRow('c', 'C', { cat: 'unknown', etat: 'doing', resp: ['u1'] }),
  makeRow('d', 'D', { cat: 'o2' }),
];
const summary = (groups: ReturnType<typeof computeGroups>) =>
  groups.map((g) => [g.key, g.rows.map((r) => r.id).join('')]);

describe('grouping', () => {
  test('select: no-value group first, then options in order', () => {
    const groups = computeGroups(rows, prop('cat'), ctx);
    assert.deepEqual(summary(groups), [
      [NO_VALUE_KEY, 'c'],
      ['o1', 'b'],
      ['o2', 'ad'],
      ['o3', ''],
    ]);
    assert.equal(groups[0]!.label, 'Sans valeur');
    assert.equal(groups[0]!.value, null);
    assert.equal(groups[2]!.value, 'o2');
    assert.equal(groups[2]!.color, 'red');
  });
  test('status: options ordered by group', () => {
    const groups = computeGroups(rows, prop('etat'), ctx);
    assert.deepEqual(
      groups.map((g) => [g.key, g.statusGroup ?? null]),
      [
        [NO_VALUE_KEY, null],
        ['todo', 'todo'],
        ['doing', 'in_progress'],
        ['done', 'done'],
      ],
    );
    assert.deepEqual(groups[3]!.rows.map((r) => r.id), ['a']);
  });
  test('checkbox', () => {
    assert.deepEqual(summary(computeGroups(rows, prop('fait'), ctx)), [
      ['true', 'a'],
      ['false', 'bcd'],
    ]);
  });
  test('person: one group per user (sorted by name), rows may repeat', () => {
    const groups = computeGroups(rows, prop('resp'), ctx);
    assert.deepEqual(summary(groups), [
      [NO_VALUE_KEY, 'bd'],
      ['u1', 'ac'],
      ['u2', 'a'],
    ]);
    assert.equal(groups[1]!.label, 'Alice Martin');
    assert.deepEqual(groups[1]!.value, ['u1']);
  });
  test('created by groups are read-only', () => {
    const groups = computeGroups(rows, prop('auteur'), ctx);
    assert.deepEqual(summary(groups), [['u1', 'abcd']]);
    assert.equal(groups[0]!.value, undefined);
  });
  test('multi-select', () => {
    assert.deepEqual(summary(computeGroups(rows, prop('tags'), ctx)), [
      [NO_VALUE_KEY, 'cd'],
      ['t1', 'a'],
      ['t2', 'ab'],
    ]);
  });
  test('eligibility', () => {
    assert.equal(canBoardBy(prop('cat')), true);
    assert.equal(canBoardBy(prop('etat')), true);
    assert.equal(canBoardBy(prop('fait')), false);
    assert.equal(canGroupBy(prop('fait')), true);
    assert.equal(canGroupBy(prop('resp')), true);
    assert.equal(canGroupBy(prop('notes')), true);
  });
  test('relation groups use page ids even when titles coincide, with multi-valued rows in both groups', () => {
    const relation = { id:'proj', name:'Projet', type:'relation' as const };
    const context = { ...ctx, relationTitle: () => 'Même titre' };
    const groups = computeGroups([makeRow('a','A',{proj:['p1','p2']}),makeRow('b','B',{})],relation,context);
    assert.deepEqual(summary(groups),[[NO_VALUE_KEY,'b'],['p1','a'],['p2','a']]);
    assert.deepEqual(groups[1]!.value,['p1']);
    assert.equal(groups[1]!.label,'Même titre');
    assert.equal(canBoardBy(relation),true);
  });
  test('text grouping keeps long distinct values separate and preserves the assigned text', () => {
    const p = prop('notes');const prefix='a'.repeat(200);
    const groups=computeGroups([makeRow('a','A',{notes:prefix+'x'}),makeRow('b','B',{notes:prefix+'y'})],p,ctx);
    assert.equal(groups.length,2);
    assert.equal(groups[0]!.value,prefix+'x');
    assert.deepEqual(summary(groups).map(g=>g[1]),['a','b']);
  });
});
