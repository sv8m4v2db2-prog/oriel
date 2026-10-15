import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member, PageProp, Tag } from '@oriel/shared';
import { formatPropValue, groupLabel, type ResultsContext } from './logic';

const tag: Tag = { id: 't1', name: 'Épisode', color: 'blue', pageCount: 3, createdBy: null };
const select: PageProp = {
  id: 'p1',
  name: 'Statut',
  type: 'select',
  options: [{ id: 'o1', name: 'En cours', color: 'blue' }],
  display: 'always',
  position: 'a',
};
const check: PageProp = { id: 'p2', name: 'Validé', type: 'checkbox', options: [], display: 'always', position: 'b' };
const ctx: ResultsContext = {
  workspaceId: 'w',
  tags: new Map([[tag.id, tag]]),
  props: new Map([[select.id, select], [check.id, check]]),
  members: new Map([['u1', { user: { id: 'u1', name: 'Alice', email: 'a@x', avatarUrl: null } } as Member]]),
};

test('group labels', () => {
  assert.equal(groupLabel('tag', 't1', ctx), 'Épisode');
  assert.equal(groupLabel('tag', '', ctx), 'Sans tag');
  assert.equal(groupLabel('author', 'u1', ctx), 'Alice');
  assert.equal(groupLabel('author', 'zzz', ctx), 'Auteur inconnu');
  assert.equal(groupLabel('created_month', '2026-10', ctx), 'octobre 2026');
  assert.equal(groupLabel('type', 'row', ctx), 'Ligne de base');
  assert.equal(groupLabel({ prop: 'p1' }, 'o1', ctx), 'En cours');
  assert.equal(groupLabel({ prop: 'p1' }, '', ctx), 'Statut : vide');
  assert.equal(groupLabel({ prop: 'p2' }, '1', ctx), 'Validé : oui');
  assert.equal(groupLabel('none', 'x', ctx), '');
});

test('property values are formatted for display', () => {
  assert.equal(formatPropValue(select, 'o1'), 'En cours');
  assert.equal(formatPropValue(select, 'gone'), '');
  assert.equal(formatPropValue(check, true), 'Oui');
  assert.equal(formatPropValue({ ...check, type: 'date' }, '2026-10-15'), '15/10/2026');
  assert.equal(formatPropValue({ ...check, type: 'number' }, 12.5), '12.5');
  assert.equal(formatPropValue(check, null), '');
});
