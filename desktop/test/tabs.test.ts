import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex, indexAfterClose, indexForShortcut, moveItem, neighbourIndex, tabLabel } from '../src/tabsLogic';
import { isDownloadAllowed, safeFileName } from '../src/urls';

test('réordonnancement', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b'], 1, 99), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b']);
});

test('⌘1…⌘9 : 9 vise le dernier onglet', () => {
  assert.equal(indexForShortcut(1, 3), 0);
  assert.equal(indexForShortcut(3, 3), 2);
  assert.equal(indexForShortcut(4, 3), null);
  assert.equal(indexForShortcut(9, 3), 2);
  assert.equal(indexForShortcut(9, 12), 11);
  assert.equal(indexForShortcut(0, 3), null);
  assert.equal(indexForShortcut(1, 0), null);
});

test('onglet précédent / suivant circulaires', () => {
  assert.equal(neighbourIndex(2, 3, 1), 0);
  assert.equal(neighbourIndex(0, 3, -1), 2);
  assert.equal(neighbourIndex(1, 3, 1), 2);
});

test('onglet actif après fermeture', () => {
  assert.equal(indexAfterClose(0, 3), 0);
  assert.equal(indexAfterClose(2, 3), 1);
  assert.equal(indexAfterClose(0, 1), -1);
});

test('libellé et dépôt', () => {
  assert.equal(tabLabel('  Mon   plan '), 'Mon plan');
  assert.equal(tabLabel(''), 'Oriel');
  assert.equal(tabLabel(null), 'Oriel');
  const slots = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
  ];
  assert.equal(dropIndex(10, slots), 0);
  assert.equal(dropIndex(160, slots), 1);
  assert.equal(dropIndex(999, slots), 2);
});

test('téléchargements : uniquement l’instance configurée', () => {
  const origin = 'https://notes.exemple.fr';
  assert.equal(isDownloadAllowed([`${origin}/api/files/1`], origin), true);
  assert.equal(isDownloadAllowed([`blob:${origin}/uuid`], origin), true);
  assert.equal(isDownloadAllowed(['https://evil.example/f.zip'], origin), false);
  assert.equal(isDownloadAllowed([`${origin}/a`, 'https://evil.example/b'], origin), false); // redirection
  assert.equal(isDownloadAllowed(['data:text/plain,hi'], origin), false);
  assert.equal(isDownloadAllowed([`${origin}/a`], null), false);
  assert.equal(isDownloadAllowed([], origin), false);
});

test('nom de fichier proposé', () => {
  assert.equal(safeFileName('rapport.pdf'), 'rapport.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a\\b\\c.txt'), 'c.txt');
  assert.equal(safeFileName('.hidden'), 'hidden');
  assert.equal(safeFileName('\u0000'), 'téléchargement');
});
