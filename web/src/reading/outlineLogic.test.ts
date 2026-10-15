import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeHeadingIndex, collectFiles, collectHeadings, inlineText, isViewableUrl, tocVisible } from './outlineLogic';

const doc = [
  { id: 'a', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Titre ' }, { type: 'link', content: [{ type: 'text', text: 'lien' }] }], children: [] },
  { id: 'b', type: 'toggleListItem', content: [], children: [{ id: 'c', type: 'heading', props: { level: 9 }, content: [{ type: 'text', text: 'Imbriqué' }], children: [] }] },
  { id: 'd', type: 'image', props: { url: '/api/files/abc/photo.png', name: '', caption: 'Légende' }, children: [] },
  { id: 'e', type: 'pdf', props: { url: 'javascript:alert(1)', name: 'x.pdf' }, children: [] },
  { id: 'f', type: 'file', props: { url: '' }, children: [] },
];

test('headings: order, nesting, level clamped, link text kept', () => {
  assert.deepEqual(collectHeadings(doc), [
    { id: 'a', level: 1, text: 'Titre lien' },
    { id: 'c', level: 4, text: 'Imbriqué' },
  ]);
  assert.deepEqual(collectHeadings(null), []);
  assert.equal(inlineText([{ type: 'userMention', props: {} }, { type: 'text', text: 'x' }]), 'x');
});

test('files: kinds, names from the URL, empty addresses skipped', () => {
  const files = collectFiles(doc);
  assert.deepEqual(files.map((f) => [f.blockId, f.kind, f.name]), [
    ['d', 'image', 'photo.png'],
    ['e', 'pdf', 'x.pdf'],
  ]);
  assert.equal(files[0]!.caption, 'Légende');
});

test('viewable urls are http(s) or relative', () => {
  assert.equal(isViewableUrl('/api/files/abc/x.png'), true);
  assert.equal(isViewableUrl('https://exemple.org/a.pdf'), true);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'blob:http://a/b', 'file:///etc/passwd']) assert.equal(isViewableUrl(bad), false, bad);
});

test('toc visibility and active heading', () => {
  assert.equal(tocVisible(undefined, 2, 'full'), false);
  assert.equal(tocVisible(undefined, 3, 'full'), true);
  assert.equal(tocVisible(undefined, 5, 'peek'), false);
  assert.equal(tocVisible(true, 1, 'peek'), true);
  assert.equal(tocVisible(false, 9, 'full'), false);
  assert.equal(activeHeadingIndex([-300, -20, 50, 400], 100), 2);
  assert.equal(activeHeadingIndex([40, 300], 10), 0);
  assert.equal(activeHeadingIndex([null, 300], 10), 1);
  assert.equal(activeHeadingIndex([null, null], 10), -1);
});
