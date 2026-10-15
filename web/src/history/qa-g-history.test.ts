// QA wave G, review D (G6): restore controls of the history panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRestoreVersions } from './access';

const page = (over: Record<string, unknown> = {}) => ({ kind: 'page' as const, trashedAt: null, format: {}, ...over });

test('QA-G6-06: no restore from the history of a locked page, as in the editor', () => {
  assert.equal(canRestoreVersions({ canEdit: true, page: page() }), true);
  assert.equal(canRestoreVersions({ canEdit: true, page: page({ format: { locked: true } }) }), false);
  assert.equal(canRestoreVersions({ canEdit: true, page: page({ trashedAt: 1 }) }), false);
  assert.equal(canRestoreVersions({ canEdit: false, page: page() }), false);
  assert.equal(canRestoreVersions(undefined), false);
  // The lock of a database page locks its views, not its content (PageView).
  assert.equal(canRestoreVersions({ canEdit: true, page: page({ kind: 'database', format: { locked: true } }) }), true);
});
