import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAccelerator, DEFAULT_QUICK_ACCELERATOR, acceleratorLabel } from '../src/accelerator';
import {
  badgeLabel,
  parseBadgeCount,
  parseColor,
  parseCoordinate,
  parseId,
  parseIndex,
  parsePrefsPatch,
  parseQuery,
  parseTitle,
} from '../src/validate';

test('badge : entier borné, tout le reste est refusé', () => {
  assert.equal(parseBadgeCount(0), 0);
  assert.equal(parseBadgeCount(42), 42);
  assert.equal(parseBadgeCount(99_999), 99_999);
  for (const bad of [-1, 100_000, 1.5, NaN, Infinity, '3', null, undefined, {}, [], 2 ** 60]) {
    assert.equal(parseBadgeCount(bad), null, String(bad));
  }
});

test('badge : libellé du Dock', () => {
  assert.equal(badgeLabel(0), '');
  assert.equal(badgeLabel(7), '7');
  assert.equal(badgeLabel(99), '99');
  assert.equal(badgeLabel(100), '99+');
});

test('identifiants, index, couleurs, coordonnées', () => {
  assert.equal(parseId('3f2a-9b_C'), '3f2a-9b_C');
  for (const bad of ['', 'a/b', '../x', 'a b', 'x'.repeat(81), 12, null]) assert.equal(parseId(bad), null);
  assert.equal(parseIndex(0, 3), 0);
  assert.equal(parseIndex(3, 3), 3);
  for (const bad of [-1, 4, 1.2, '1', NaN]) assert.equal(parseIndex(bad, 3), null);
  assert.equal(parseColor('blue'), 'blue');
  assert.equal(parseColor('#ff0000'), null);
  assert.equal(parseCoordinate(12.4), 12);
  assert.equal(parseCoordinate(NaN), null);
  assert.equal(parseCoordinate(1e9), null);
});

test('requête de recherche rapide', () => {
  assert.equal(parseQuery('  plan de projet '), 'plan de projet');
  assert.equal(parseQuery('a\u0000b\nc'), 'a b c');
  assert.equal(parseQuery('x'.repeat(201)), null);
  assert.equal(parseQuery(12), null);
  assert.equal(parseTitle('   '), null);
  assert.equal(parseTitle('Nouvelle idée'), 'Nouvelle idée');
});

test('accélérateur : forme canonique et refus', () => {
  assert.deepEqual(validateAccelerator('ctrl+option+space'), { ok: true, accelerator: 'Control+Alt+Space' });
  assert.deepEqual(validateAccelerator('Shift+Command+K'), { ok: true, accelerator: 'Command+Shift+K' });
  assert.deepEqual(validateAccelerator(DEFAULT_QUICK_ACCELERATOR), { ok: true, accelerator: DEFAULT_QUICK_ACCELERATOR });
  assert.equal(validateAccelerator('Shift+K').ok, false); // aucun modificateur fort
  assert.equal(validateAccelerator('K').ok, false);
  assert.equal(validateAccelerator('Command+Q').ok, false); // réservé
  assert.equal(validateAccelerator('Command+Shift+Fooo').ok, false);
  assert.equal(validateAccelerator('Super+K').ok, false);
  assert.equal(validateAccelerator('Command++').ok, false);
  assert.equal(validateAccelerator(42).ok, false);
  assert.equal(validateAccelerator('Alt+F13').ok, true);
  assert.equal(acceleratorLabel('Control+Alt+Space'), '⌃⌥Espace');
});

test('setPrefs : un champ invalide refuse tout le patch', () => {
  const good = parsePrefsPatch({ dockBadge: false, quickSearchShortcut: 'alt+ctrl+k', spellLanguages: ['fr-FR', 'en-US'] });
  assert.deepEqual(good, {
    ok: true,
    patch: { dockBadge: false, quickSearchShortcut: 'Control+Alt+K', spellLanguages: ['fr-FR', 'en-US'] },
  });
  for (const bad of [
    null,
    [],
    'x',
    { dockBadge: 'oui' },
    { unknown: true },
    { quickSearchShortcut: 'K' },
    { spellLanguages: ['../etc'] },
    { spellLanguages: 'fr' },
    { dockBadge: true, quickSearchEnabled: 1 },
    { __proto__: null, constructor: 1 },
  ]) {
    assert.equal(parsePrefsPatch(bad).ok, false, JSON.stringify(bad));
  }
});
