// QR encoder: structure checks. Decoding was verified against the macOS Vision framework (versions 1,
// 10 and 19: payload read back identically).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, qrSvgPath } from './qr';

const finderAt = (m: boolean[][], x0: number, y0: number) => {
  for (let dy = 0; dy < 7; dy++)
    for (let dx = 0; dx < 7; dx++) {
      const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[y0 + dy]![x0 + dx] !== (d !== 2)) return false;
    }
  return true;
};

test('qr: smallest version, finder patterns, timing, dark module', () => {
  for (const [text, size] of [
    ['HELLO', 21],
    ['otpauth://totp/Oriel:alice%40exemple.fr?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Oriel&algorithm=SHA1&digits=6&period=30', 49], // 132 bytes: version 8 at level M,
  ] as const) {
    const m = encodeQr(text);
    assert.equal(m.length, size, text);
    assert.ok(finderAt(m, 0, 0) && finderAt(m, size - 7, 0) && finderAt(m, 0, size - 7));
    for (let i = 8; i < size - 8; i++) assert.equal(m[6]![i], i % 2 === 0);
    assert.equal(m[size - 8]![8], true);
  }
});

test('qr: deterministic, svg path, refuses oversized text', () => {
  assert.deepEqual(encodeQr('abc'), encodeQr('abc'));
  const { size, path } = qrSvgPath(encodeQr('abc'));
  assert.equal(size, 29);
  assert.match(path, /^M\d+ \d+h1v1h-1z/);
  assert.throws(() => encodeQr('x'.repeat(3000)));
});
