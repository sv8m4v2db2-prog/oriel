import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeIds, diffRows, diffText, diffTrees } from './diff';
import type { HBlock } from './tree';

const b = (id: string, text: string, children: HBlock[] = [], type = 'paragraph', props: Record<string, string> = {}): HBlock => ({
  id,
  type,
  props,
  segs: text ? [{ t: text, m: '' }] : [],
  children,
});

test('diffText: word-level insertions and deletions', () => {
  assert.deepEqual(diffText('le chat dort', 'le chien dort'), [
    { op: 'eq', text: 'le ' },
    { op: 'del', text: 'chat' },
    { op: 'ins', text: 'chien' },
    { op: 'eq', text: ' dort' },
  ]);
  assert.deepEqual(diffText('', 'neuf'), [{ op: 'ins', text: 'neuf' }]);
  assert.deepEqual(diffText('idem', 'idem'), [{ op: 'eq', text: 'idem' }]);
});

test('diffTrees: added, removed at its old place, modified, moved', () => {
  const older = [b('a', 'Un'), b('b', 'Deux'), b('c', 'Trois'), b('d', 'Quatre')];
  const newer = [b('d', 'Quatre'), b('a', 'Un !'), b('c', 'Trois'), b('e', 'Cinq')];
  const { nodes, stats } = diffTrees(older, newer);
  assert.deepEqual(
    nodes.map((n) => [n.id, n.status, n.moved]),
    [
      ['d', 'same', true],
      ['a', 'modified', false],
      ['b', 'removed', false],
      ['c', 'same', false],
      ['e', 'added', false],
    ],
  );
  assert.deepEqual(stats, { added: 1, removed: 1, modified: 1, moved: 1, same: 2 });
});

test('diffTrees: type and props changes, nested removal, format-only change', () => {
  const older = [b('p', 'Titre', [b('k', 'Enfant')]), { ...b('f', 'gras'), segs: [{ t: 'gras', m: '' }] }];
  const newer = [b('p', 'Titre', [], 'heading', { level: '2' }), { ...b('f', 'gras'), segs: [{ t: 'gras', m: 'bold' }] }];
  const { nodes } = diffTrees(older, newer);
  assert.equal(nodes[0]!.oldType, 'paragraph');
  assert.deepEqual(nodes[0]!.props, [{ key: 'level', before: null, after: '2' }]);
  assert.equal(nodes[0]!.children[0]!.status, 'removed');
  assert.equal(nodes[1]!.formatChanged, true);
  assert.equal(nodes[1]!.text, undefined);
});

test('diffRows: unchanged runs collapse into gaps', () => {
  const older = [b('a', '1'), b('b', '2'), b('c', '3')];
  const newer = [b('a', '1'), b('b', '2 bis'), b('c', '3')];
  const rows = diffRows(diffTrees(older, newer).nodes, true);
  assert.deepEqual(
    rows.map((r) => (r.kind === 'gap' ? `gap:${r.count}` : r.node.id)),
    ['gap:1', 'b', 'gap:1'],
  );
  assert.deepEqual(changeIds(rows), ['b']);
});

test('diffText: a space between two changes is folded into one change', () => {
  assert.deepEqual(diffText('caméras et un drone.', 'caméras et une perche son.'), [
    { op: 'eq', text: 'caméras et ' },
    { op: 'del', text: 'un drone' },
    { op: 'ins', text: 'une perche son' },
    { op: 'eq', text: '.' },
  ]);
});
