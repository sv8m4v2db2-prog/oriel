// French wording of an access change (navigation module).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessEffect } from '@oriel/shared';
import { describeEffect } from './access';

const base = (over: Partial<AccessEffect>): AccessEffect => ({
  pageCount: 1,
  from: { visibility: 'workspace', teamspace: null, readers: 3 },
  to: { visibility: 'private', teamspace: null, readers: 1 },
  gain: 0,
  lose: 2,
  widens: false,
  narrows: true,
  ...over,
});

test('accord au singulier et au pluriel', () => {
  assert.equal(describeEffect(base({})), 'Après l’opération, la page deviendra privée : vous seul la verrez. 2 personnes n’y auront plus accès.');
  const many = describeEffect(base({ pageCount: 4, to: { visibility: 'workspace', teamspace: null, readers: 3 }, gain: 1, lose: 0, widens: true, narrows: false }));
  assert.equal(many, 'Après l’opération, les 4 pages (page et sous-pages) seront visibles par tous les membres de l’espace de travail. 1 personne pourra désormais les lire.');
});

test('destination dans un espace d’équipe', () => {
  const t = describeEffect(base({ to: { visibility: 'teamspace', teamspace: { id: 'x', title: 'Dessin', access: 'closed' }, readers: 2 }, lose: 0, narrows: false }));
  assert.match(t, /suivra l’accès de l’espace d’équipe « Dessin » \(fermé\)/);
  assert.match(t, /Personne ne gagne ni ne perd l’accès/);
});
