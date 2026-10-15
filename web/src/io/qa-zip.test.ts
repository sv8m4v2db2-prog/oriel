/// <reference types="node" />
// QA-WEB-05 — imported archives come from anywhere (a colleague's "export"): the central directory
// sizes are declarative. An entry claiming 0 bytes (or a wrong size) was inflated without any bound,
// so a few kilobytes of deflate could expand to gigabytes in the tab (zip bomb → tab crash).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { bytesSource, readZipDirectory, readZipEntry, ZipError } from './zip';

/** Archive with one deflated entry whose central-directory "uncompressed size" is replaced. */
function archive(content: Uint8Array, declaredSize?: number): Uint8Array {
  const zip = zipSync({ 'bombe.md': [content, { level: 9 }] });
  if (declaredSize !== undefined) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, declaredSize, true);
        break;
      }
    }
  }
  return zip;
}

const zeros = (n: number) => new Uint8Array(n);

describe('QA-WEB-05: zip entries are inflated within bounds', () => {
  test('an entry that lies about its size cannot expand past the limit', async () => {
    const src = bytesSource(archive(zeros(4 * 1024 * 1024), 0));
    const [entry] = await readZipDirectory(src);
    assert.equal(entry!.size, 0);
    await assert.rejects(readZipEntry(src, entry!, 1024 * 1024), ZipError);
  });

  test('an entry declaring more than the limit is refused before inflating', async () => {
    const src = bytesSource(archive(zeros(64 * 1024), 3 * 1024 * 1024));
    const [entry] = await readZipDirectory(src);
    await assert.rejects(readZipEntry(src, entry!, 1024 * 1024), ZipError);
  });

  test('ordinary entries are read as before', async () => {
    const text = new TextEncoder().encode('# Titre\n\nBonjour '.repeat(1000));
    for (const declared of [undefined, 0]) {
      const src = bytesSource(archive(text, declared));
      const [entry] = await readZipDirectory(src);
      assert.deepEqual(await readZipEntry(src, entry!, 1024 * 1024), text);
    }
  });
});

describe('QA-WEB-05: nested archives share one in-memory budget', () => {
  test('compressed inner archives beyond the budget are skipped with a warning', async () => {
    const { buildVfs } = await import('./vfs');
    // Inner archives store their content (600 KB each once inflated), the outer one deflates them.
    const inner = (name: string) => zipSync({ [`${name}.md`]: [zeros(600 * 1024), { level: 0 }] });
    const outer = zipSync({ 'a.zip': [inner('a'), { level: 9 }], 'b.zip': [inner('b'), { level: 9 }] });
    const vfs = await buildVfs([{ path: 'export.zip', blob: new Blob([outer]) }], 1024 * 1024);
    assert.equal(vfs.list().length, 1);
    assert.ok(vfs.warnings.some((w) => /trop volumineux/.test(w)), vfs.warnings.join(' | '));
  });
});
