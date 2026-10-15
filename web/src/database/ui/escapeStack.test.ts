/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeOnOutsideEscape, EscapeStack } from './escapeStack';

const key = (over: Partial<Parameters<typeof closeOnOutsideEscape>[1]> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  isComposing: false,
  inLayer: false,
  ...over,
});

describe('Escape outside an open popover', () => {
  test('closes the most recently opened popover, one per key press', () => {
    // Regression: a property menu stayed open on Escape once the focus had left it.
    const closed: string[] = [];
    const stack = new EscapeStack();
    const removeA = stack.push(() => closed.push('a'));
    const removeB = stack.push(() => closed.push('b'));
    assert.equal(closeOnOutsideEscape(stack, key()), true);
    assert.deepEqual(closed, ['b']);
    removeB();
    assert.equal(closeOnOutsideEscape(stack, key()), true);
    assert.deepEqual(closed, ['b', 'a']);
    removeA();
    assert.equal(stack.size, 0);
    assert.equal(closeOnOutsideEscape(stack, key()), false);
  });

  test('leaves other keys, handled events and floating layers alone', () => {
    let closed = 0;
    const stack = new EscapeStack();
    stack.push(() => closed++);
    assert.equal(closeOnOutsideEscape(stack, key({ key: 'Enter' })), false);
    assert.equal(closeOnOutsideEscape(stack, key({ defaultPrevented: true })), false);
    assert.equal(closeOnOutsideEscape(stack, key({ isComposing: true })), false);
    // Typed in a dropdown or a modal: that layer closes itself.
    assert.equal(closeOnOutsideEscape(stack, key({ inLayer: true })), false);
    assert.equal(closed, 0);
  });

  test('unregistering a lower popover keeps the top one first', () => {
    const closed: string[] = [];
    const stack = new EscapeStack();
    const removeA = stack.push(() => closed.push('a'));
    stack.push(() => closed.push('b'));
    removeA();
    stack.closeTop();
    assert.deepEqual(closed, ['b']);
  });
});
