import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutRelationGraph } from './relationGraphLayout';

const db = (id: string) => ({ id, title: id.toUpperCase(), icon: null });
const link = (fromId: string, toId: string, propertyId: string, twoWay = false, mirrorName: string | null = null) => ({
  fromId,
  toId,
  propertyId,
  propertyName: `p-${propertyId}`,
  mirrorName,
  twoWay,
});

test('centre first, others on a circle without overlap, one edge per link', () => {
  const g = layoutRelationGraph({
    databases: [db('a'), db('b'), db('c'), db('d')],
    links: [link('a', 'b', '1', true, 'retour'), link('c', 'a', '2'), link('a', 'c', '3'), link('a', 'a', '4'), link('a', 'zz', '5')],
  });
  assert.equal(g.nodes[0]!.center, true);
  for (const n of g.nodes.slice(1)) assert.ok(Math.hypot(n.x - g.nodes[0]!.x, n.y - g.nodes[0]!.y) >= 149);
  for (const n of g.nodes) assert.ok(n.x > 0 && n.x < g.width && n.y > 0 && n.y < g.height, 'inside the frame');
  assert.equal(g.edges.length, 4, 'link to an unknown database dropped');
  assert.equal(g.edges[0]!.label, 'p-1 ⇄ retour');
  const [ca, ac] = [g.edges[1]!, g.edges[2]!];
  assert.notEqual(ca.path.split('Q')[1], ac.path.split('Q')[1], 'parallel links fan out');
  assert.equal(g.edges[3]!.self, true);
});

test('a lonely database', () => {
  const g = layoutRelationGraph({ databases: [db('a')], links: [] });
  assert.equal(g.nodes.length, 1);
  assert.ok(g.width > 0 && g.height > 0);
  assert.deepEqual(layoutRelationGraph({ databases: [], links: [] }).nodes, []);
});
