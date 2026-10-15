// Audit de sécurité vague G — app macOS (G10 : onglets, recherche rapide, badge, préférences, session).
// Les modules testés sont purs (aucun import d'Electron) ; le câblage de main.ts est vérifié sur la source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateAccelerator } from '../src/accelerator';
import { isTrustedAppFrame, safeFileName, windowOpenAction } from '../src/urls';

const SERVER = 'https://notes.exemple.fr';
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');

test('QA-G10-01: window.open("about:blank") (iframe d’embed tiers) ne crée pas de fenêtre sans barre d’adresse', () => {
  // Un site intégré (bloc Embed : sandbox allow-popups allow-popups-to-escape-sandbox) ouvrait une
  // fenêtre vierge où il écrit ce qu'il veut (faux écran de connexion Oriel), sans barre d'adresse.
  assert.deepEqual(windowOpenAction('about:blank', 'new-window', SERVER), { kind: 'deny' });
  assert.deepEqual(windowOpenAction('about:blank#x', 'foreground-tab', SERVER), { kind: 'deny' });
  assert.deepEqual(windowOpenAction('about:srcdoc', 'new-window', SERVER), { kind: 'deny' });
  assert.deepEqual(windowOpenAction('javascript:alert(1)', 'new-window', SERVER), { kind: 'deny' });
  assert.deepEqual(windowOpenAction('file:///etc/passwd', 'new-window', SERVER), { kind: 'deny' });
  assert.deepEqual(windowOpenAction('data:text/html,<b>x</b>', 'new-window', SERVER), { kind: 'deny' });
  assert.deepEqual(windowOpenAction('oriel-evil://x', 'new-window', SERVER), { kind: 'deny' });
  // Comportements attendus conservés.
  assert.deepEqual(windowOpenAction(`${SERVER}/w/a/p/b`, 'foreground-tab', SERVER), { kind: 'tab', activate: true });
  assert.deepEqual(windowOpenAction(`${SERVER}/w/a/p/b`, 'background-tab', SERVER), { kind: 'tab', activate: false });
  assert.deepEqual(windowOpenAction(`${SERVER}/w/a`, 'new-window', SERVER), { kind: 'window' });
  assert.deepEqual(windowOpenAction('https://autre.exemple/', 'foreground-tab', SERVER), { kind: 'external' });
  assert.deepEqual(windowOpenAction('mailto:a@b.fr', 'new-window', SERVER), { kind: 'external' });
  // Pas d'origine configurée : rien n'est interne.
  assert.deepEqual(windowOpenAction(`${SERVER}/w/a`, 'new-window', null), { kind: 'external' });
  // main.ts n'autorise plus aucune fenêtre enfant.
  assert.ok(mainSource.includes('windowOpenAction('), 'main.ts doit passer par windowOpenAction');
  assert.ok(!/action:\s*'allow'/.test(mainSource), 'aucun setWindowOpenHandler ne doit renvoyer allow');
});

test('QA-G10-02: une redirection serveur vers une autre origine ne s’affiche pas dans un onglet', () => {
  // will-navigate ne voit pas les redirections HTTP (3xx d'un proxy, d'une passerelle…) : sans
  // will-redirect, la page tierce s'affichait dans l'onglet, sans barre d'adresse.
  const guard = /function guardTab[\s\S]*?\n}\n/.exec(mainSource)?.[0] ?? '';
  assert.ok(guard.includes("'will-redirect'"), 'guardTab doit surveiller will-redirect');
  assert.ok(/isMainFrame/.test(guard), 'seul le cadre principal est concerné');
});

test('QA-G10-03 (durcissement) : le pont exige l’origine réelle du cadre, pas seulement son URL', () => {
  assert.equal(isTrustedAppFrame(`${SERVER}/w/a`, SERVER, SERVER), true);
  // Document servi par l'instance avec une CSP `sandbox` (origine opaque) : même URL, origine "null".
  assert.equal(isTrustedAppFrame(`${SERVER}/api/editor/html-frame`, 'null', SERVER), false);
  assert.equal(isTrustedAppFrame(`${SERVER}/w/a`, 'https://evil.exemple', SERVER), false);
  assert.equal(isTrustedAppFrame('https://evil.exemple/', 'https://evil.exemple', SERVER), false);
  assert.equal(isTrustedAppFrame(`${SERVER}/w/a`, SERVER, null), false);
  assert.equal(isTrustedAppFrame('', '', SERVER), false);
  assert.ok(mainSource.includes('isTrustedAppFrame('), 'main.ts doit vérifier l’origine du cadre');
});

test('QA-G10-04: le raccourci global ne peut pas confisquer les raccourcis essentiels de macOS', () => {
  // ⌘Q était refusé mais pas son alias CommandOrControl+Q (identique sur macOS) ; ⌘C/⌘V/⌘Z…
  // enregistrés en raccourci global cessaient de fonctionner dans toutes les applications.
  for (const bad of [
    'CommandOrControl+Q',
    'CmdOrCtrl+W',
    'Command+C',
    'Command+V',
    'Command+X',
    'Command+Z',
    'Command+A',
    'Command+S',
    'CommandOrControl+V',
    'Command+Shift+Z',
    'Command+Shift+3',
    'Command+Shift+4',
    'Command+Shift+5',
    'Command+Shift+Tab',
    'Control+Command+Q',
    'Control+Command+Space',
    'Command+`',
    'Alt+E', // ⌥E : touche morte des accents
    'Alt+Shift+2',
  ]) {
    assert.equal(validateAccelerator(bad).ok, false, bad);
  }
  // Raccourcis légitimes conservés.
  for (const good of ['Control+Alt+Space', 'Command+Shift+K', 'Command+Shift+Space', 'Alt+Space', 'Alt+F13', 'Control+K', 'Command+Alt+K', 'Command+F5']) {
    assert.equal(validateAccelerator(good).ok, true, good);
  }
});

test('QA-G10-05: nom de fichier proposé : caractères de mise en forme bidirectionnelle retirés', () => {
  // "facture‮fdp.command" s'affiche « facturedmmoc.pdf » dans la fenêtre d'enregistrement.
  assert.equal(safeFileName('facture‮fdp.command'), 'facturefdp.command');
  assert.equal(safeFileName('a⁦b⁩​c﻿.txt'), 'abc.txt');
  assert.equal(safeFileName('ligne deux.txt'), 'lignedeux.txt');
  // Garanties existantes.
  assert.equal(safeFileName('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(safeFileName('..\\..\\x.txt'), 'x.txt');
  assert.equal(safeFileName('...'), 'téléchargement');
  assert.equal(safeFileName('.zshrc'), 'zshrc');
  assert.equal(safeFileName('a\u0000b.txt'), 'ab.txt');
  assert.ok(safeFileName('x'.repeat(500)).length <= 180);
});
