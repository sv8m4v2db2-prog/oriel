/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceleratorFromEvent, acceleratorLabel } from './accelerator';

const ev = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test('accélérateur depuis un événement clavier', () => {
  assert.equal(acceleratorFromEvent(ev('Space', { ctrlKey: true, altKey: true })), 'Control+Alt+Space');
  assert.equal(acceleratorFromEvent(ev('KeyK', { metaKey: true, shiftKey: true })), 'Command+Shift+K');
  assert.equal(acceleratorFromEvent(ev('Digit5', { altKey: true })), 'Alt+5');
  assert.equal(acceleratorFromEvent(ev('F7', { ctrlKey: true })), 'Control+F7');
  assert.equal(acceleratorFromEvent(ev('ControlLeft', { ctrlKey: true })), null);
  assert.equal(acceleratorFromEvent(ev('NumpadAdd')), null);
});

test('libellé affiché', () => {
  assert.equal(acceleratorLabel('Control+Alt+Space'), '⌃⌥Espace');
  assert.equal(acceleratorLabel('Command+Shift+K'), '⌘⇧K');
});
