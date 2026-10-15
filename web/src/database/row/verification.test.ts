import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryFrom, verificationOptionId, verificationRank, verificationState, verificationText } from './verification';

const v = (expiresAt: string | null) => ({ verifiedBy: 'u1', verifiedAt: '2026-10-15T08:00:00Z', expiresAt });

test('state: verified until the end of the expiry day, then to re-verify', () => {
  assert.equal(verificationState(null, '2026-10-15'), 'none');
  assert.equal(verificationState({ expiresAt: null }, '2026-10-15'), 'none', 'not a stamped value');
  assert.equal(verificationState(v(null), '2030-01-01'), 'verified');
  assert.equal(verificationState(v('2026-10-15'), '2026-10-15'), 'verified');
  assert.equal(verificationState(v('2026-10-15'), '2026-10-16'), 'expired');
  assert.equal(verificationOptionId(v('2026-10-15'), '2026-10-16'), 'expired');
  assert.equal(verificationOptionId(null), null);
  assert.equal(verificationText(v(null)), 'Vérifiée');
  assert.equal(verificationText(null), '');
  assert.deepEqual([verificationRank(v(null)), verificationRank(v('2000-01-01')), verificationRank(null)], [0, 1, null]);
});

test('expiry presets', () => {
  const from = new Date(2026, 0, 31);
  assert.equal(expiryFrom('none', from), null);
  assert.equal(expiryFrom('week', from), '2026-02-07');
  assert.equal(expiryFrom('month', from), '2026-02-28');
  assert.equal(expiryFrom('quarter', from), '2026-04-30');
  assert.equal(expiryFrom('year', new Date(2028, 1, 29)), '2029-02-28');
});
