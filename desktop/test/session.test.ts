import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClosedTabs,
  isRestorablePath,
  restorablePathOf,
  sanitizeSession,
  sessionKey,
  sessionToRestore,
  MAX_SAVED_WINDOWS,
  MAX_TABS_PER_WINDOW,
} from '../src/session';

const ORIGIN = 'https://notes.exemple.fr';

test('chemins restaurables : internes, sans jeton', () => {
  assert.equal(isRestorablePath('/w/abc/p/def'), true);
  assert.equal(isRestorablePath('/w/abc/p/def?thread=1#x'), true);
  for (const bad of [
    '',
    'w/abc',
    '//evil.example/x',
    '/\\evil',
    '/login',
    '/invite/abcdef',
    '/reset-password/secret',
    '/forgot-password',
    '/signup?x=1',
    '/a\u0000b',
    `/${'a'.repeat(3000)}`,
    42,
    null,
  ]) {
    assert.equal(isRestorablePath(bad), false, String(bad));
  }
  assert.equal(isRestorablePath('/loginx'), true); // préfixe sur segments entiers uniquement
});

test('restorablePathOf : refuse les autres origines et le non restaurable', () => {
  assert.equal(restorablePathOf(`${ORIGIN}/w/1/p/2?a=b#c`, ORIGIN), '/w/1/p/2?a=b#c');
  assert.equal(restorablePathOf('https://evil.example/w/1', ORIGIN), null);
  assert.equal(restorablePathOf(`${ORIGIN}/reset-password/tok`, ORIGIN), null);
  assert.equal(restorablePathOf('file:///app/offline.html', ORIGIN), null);
  assert.equal(restorablePathOf('not a url', ORIGIN), null);
  assert.equal(restorablePathOf(`${ORIGIN}/w/1`, null), null);
});

test('sanitizeSession : fichier édité à la main', () => {
  assert.equal(sanitizeSession(null), undefined);
  assert.equal(sanitizeSession({ origin: 5, windows: [] }), undefined);
  assert.equal(sanitizeSession({ origin: 'local', windows: 'x' }), undefined);

  const out = sanitizeSession({
    origin: 'local',
    windows: [
      {
        active: 5, // hors bornes → 0
        tabs: [
          { path: '/w/1/p/a', color: 'blue' },
          { path: 'https://evil.example/' }, // refusé
          { path: '/invite/zzz' }, // refusé
          { path: '/w/1/p/b', color: 'rainbow' }, // couleur ignorée
          null,
        ],
        bounds: { x: 10.4, y: 20, width: 900.2, height: 700 },
      },
      { tabs: [] }, // ignorée
      { tabs: [{ path: '/x' }], bounds: { width: 5, height: 5 } },
    ],
  });
  assert.deepEqual(out, {
    origin: 'local',
    windows: [
      { tabs: [{ path: '/w/1/p/a', color: 'blue' }, { path: '/w/1/p/b' }], active: 0, bounds: { x: 10, y: 20, width: 900, height: 700 } },
      { tabs: [{ path: '/x' }], active: 0 },
    ],
  });
});

test('sanitizeSession : bornes du nombre de fenêtres et d’onglets', () => {
  const tabs = Array.from({ length: MAX_TABS_PER_WINDOW + 20 }, (_, i) => ({ path: `/w/1/p/${i}` }));
  const windows = Array.from({ length: MAX_SAVED_WINDOWS + 5 }, () => ({ tabs, active: MAX_TABS_PER_WINDOW + 3 }));
  const out = sanitizeSession({ origin: ORIGIN, windows })!;
  assert.equal(out.windows.length, MAX_SAVED_WINDOWS);
  assert.equal(out.windows[0]!.tabs.length, MAX_TABS_PER_WINDOW);
  assert.equal(out.windows[0]!.active, 0);
});

test('restauration : seulement pour le même serveur', () => {
  const session = sanitizeSession({ origin: ORIGIN, windows: [{ tabs: [{ path: '/w/1' }], active: 0 }] })!;
  assert.equal(sessionKey('remote', ORIGIN), ORIGIN);
  assert.equal(sessionKey('local', null), 'local');
  assert.equal(sessionKey(null, null), null);
  assert.equal(sessionToRestore(session, ORIGIN)?.length, 1);
  assert.equal(sessionToRestore(session, 'local'), null);
  assert.equal(sessionToRestore(session, 'https://autre.exemple.fr'), null);
  assert.equal(sessionToRestore(undefined, ORIGIN), null);
  assert.equal(sessionToRestore({ origin: ORIGIN, windows: [] }, ORIGIN), null);
});

test('onglets fermés : pile bornée, le dernier fermé sort en premier', () => {
  const stack = new ClosedTabs(3);
  for (const n of [1, 2, 3, 4]) stack.push({ path: `/w/${n}`, index: n });
  assert.equal(stack.size, 3);
  assert.equal(stack.pop()?.path, '/w/4');
  assert.equal(stack.pop()?.path, '/w/3');
  assert.equal(stack.pop()?.path, '/w/2');
  assert.equal(stack.pop(), undefined);
});
