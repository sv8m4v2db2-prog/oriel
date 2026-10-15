// Pure logic of the canvas (H1): mind map layout and operations, outline import/export,
// geometry (connectors, snapping, alignment, resizing) and object validation.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_LIMITS, sanitizeCanvasObject, type CanvasObject, type MindNode } from '@oriel/shared';
import { layoutMindmap, countDescendants } from './mindmap/layout';
import { addChild, addSibling, clean, countNodes, findNode, fromOutline, looksLikeOutline, neighbour, removeNode, setText, toOutline, toggleCollapsed } from './mindmap/ops';
import { alignRects, boundaryPoint, connectorRoute, distributeRects, objectBounds, resizeRect, scaleObject, snapRect, strokeFromPoints } from './geometry';

const tree = (): MindNode => ({
  id: 'r',
  text: 'Film',
  children: [
    { id: 'a', text: 'Écriture', children: [{ id: 'a1', text: 'Synopsis', children: [] }, { id: 'a2', text: 'Continuité', children: [] }] },
    { id: 'b', text: 'Tournage', children: [{ id: 'b1', text: 'Repérages', children: [] }] },
    { id: 'c', text: 'Montage', children: [] },
    { id: 'd', text: 'Diffusion', children: [] },
  ],
});

describe('mind map layout', () => {
  test('right: every child is right of its parent, siblings do not overlap, parent centred on its children', () => {
    const l = layoutMindmap(tree(), { layout: 'right', style: 'classic' });
    for (const link of l.links) {
      const p = l.byId.get(link.from)!;
      const c = l.byId.get(link.to)!;
      assert.ok(c.x >= p.x + p.w, `${c.id} right of ${p.id}`);
      assert.equal(link.side, 1);
    }
    const kids = ['a', 'b', 'c', 'd'].map((id) => l.byId.get(id)!);
    for (let i = 1; i < kids.length; i++) assert.ok(kids[i]!.y >= kids[i - 1]!.y + kids[i - 1]!.h, 'stacked without overlap');
    const a = l.byId.get('a')!;
    const center = (b: { y: number; h: number }) => b.y + b.h / 2;
    assert.ok(Math.abs(center(a) - (center(l.byId.get('a1')!) + center(l.byId.get('a2')!)) / 2) < 0.001);
    assert.equal(l.boxes.length, 8);
  });

  test('left mirrors right; balanced puts the first children right and the others left', () => {
    const left = layoutMindmap(tree(), { layout: 'left', style: 'outline' });
    for (const link of left.links) {
      const p = left.byId.get(link.from)!;
      const c = left.byId.get(link.to)!;
      assert.ok(c.x + c.w <= p.x, `${c.id} left of ${p.id}`);
    }
    const bal = layoutMindmap(tree(), { layout: 'balanced', style: 'classic' });
    const sides = ['a', 'b', 'c', 'd'].map((id) => bal.byId.get(id)!.side);
    assert.equal(sides[0], 1);
    assert.equal(sides[sides.length - 1], -1);
    assert.ok(sides.includes(1) && sides.includes(-1));
    // Grandchildren follow their branch's side.
    assert.equal(bal.byId.get('a1')!.side, bal.byId.get('a')!.side);
  });

  test('collapsed branches hide their descendants and report how many', () => {
    const t = toggleCollapsed(tree(), 'a');
    const l = layoutMindmap(t, { layout: 'right', style: 'minimal' });
    assert.equal(l.byId.has('a1'), false);
    assert.equal(l.byId.get('a')!.hidden, 2);
    assert.equal(countDescendants(t), 7);
  });

  test('branch colours: one per first-level branch, inherited below, overridable', () => {
    const t = tree();
    t.children[1]!.color = 'red';
    const l = layoutMindmap(t, { layout: 'right', style: 'classic' });
    assert.notEqual(l.byId.get('a')!.color, l.byId.get('c')!.color);
    assert.equal(l.byId.get('a1')!.color, l.byId.get('a')!.color);
    assert.equal(l.byId.get('b')!.color, 'red');
    assert.equal(l.byId.get('b1')!.color, 'red');
  });

  test('bounds contain every box; custom measure is used', () => {
    const l = layoutMindmap(tree(), { layout: 'balanced', style: 'org', measure: () => ({ w: 100, h: 30 }) });
    for (const b of l.boxes) {
      assert.equal(b.w, 100);
      assert.ok(b.x >= l.bounds.x && b.x + b.w <= l.bounds.x + l.bounds.w);
      assert.ok(b.y >= l.bounds.y && b.y + b.h <= l.bounds.y + l.bounds.h);
    }
  });
});

describe('mind map operations', () => {
  test('Tab adds a child (unfolding), Enter a sibling after, root sibling becomes a child', () => {
    let t = toggleCollapsed(tree(), 'a');
    const child = addChild(t, 'a', 'Dialogues')!;
    t = child.root;
    assert.equal(findNode(t, 'a')!.node.collapsed, undefined);
    assert.equal(findNode(t, 'a')!.node.children.at(-1)!.text, 'Dialogues');
    const sib = addSibling(t, 'b')!;
    assert.deepEqual(findNode(sib.root, 'r')!.node.children.map((c) => c.id), ['a', 'b', sib.id, 'c', 'd']);
    const fromRoot = addSibling(t, 'r')!;
    assert.equal(findNode(fromRoot.root, fromRoot.id)!.parent!.id, 'r');
  });

  test('Delete removes a branch and selects a neighbour; removing the root removes the map', () => {
    const r = removeNode(tree(), 'b');
    assert.equal(findNode(r.root!, 'b1'), null);
    assert.equal(r.next, 'c');
    assert.equal(removeNode(tree(), 'd').next, 'c');
    assert.equal(removeNode(tree(), 'a1').next, 'a2');
    assert.equal(removeNode(tree(), 'r').root, null);
  });

  test('edits are immutable and bounded', () => {
    const t = tree();
    const u = setText(t, 'a1', 'x'.repeat(500));
    assert.equal(findNode(t, 'a1')!.node.text, 'Synopsis');
    assert.equal(findNode(u, 'a1')!.node.text.length, CANVAS_LIMITS.mindmapText);
    assert.strictEqual(u.children[1], t.children[1], 'untouched branches are shared');
    // Node and depth limits.
    let deep: MindNode = { id: 'n0', text: '0', children: [] };
    let last = 'n0';
    for (let i = 0; i < CANVAS_LIMITS.mindmapDepth; i++) {
      const res = addChild(deep, last)!;
      deep = res.root;
      last = res.id;
    }
    assert.equal(addChild(deep, last), null, 'depth limit');
    assert.ok(sanitizeCanvasObject({ id: 'm', type: 'mindmap', x: 0, y: 0, w: 1, h: 1, z: 'a0', layout: 'right', style: 'classic', root: clean(deep) }));
  });

  test('arrow navigation follows the side of the branch', () => {
    const t = tree();
    assert.equal(neighbour(t, 'a', 'ArrowRight', 1), 'a1');
    assert.equal(neighbour(t, 'a1', 'ArrowLeft', 1), 'a');
    assert.equal(neighbour(t, 'a', 'ArrowDown', 1), 'b');
    assert.equal(neighbour(t, 'a', 'ArrowUp', 1), null);
    assert.equal(neighbour(t, 'c', 'ArrowRight', -1), 'r');
    assert.equal(neighbour(t, 'r', 'ArrowLeft', 0), 'a');
  });

  test('outline import: bullets by indentation, headings by level, several roots grouped', () => {
    const md = '# Tournage\n## Équipe\n- Réalisation\n  - Assistant\n- Image\n## Matériel\n* Caméra\n';
    const t = fromOutline(md)!;
    assert.equal(t.text, 'Tournage');
    assert.deepEqual(t.children.map((c) => c.text), ['Équipe', 'Matériel']);
    assert.deepEqual(t.children[0]!.children.map((c) => c.text), ['Réalisation', 'Image']);
    assert.equal(t.children[0]!.children[0]!.children[0]!.text, 'Assistant');
    const several = fromOutline('- **Un**\n- Deux\n\t- Deux.1\n1. Trois')!;
    assert.equal(several.text, 'Idée centrale');
    assert.deepEqual(several.children.map((c) => c.text), ['Un', 'Deux', 'Trois']);
    assert.equal(several.children[1]!.children[0]!.text, 'Deux.1');
    assert.equal(fromOutline('   \n'), null);
    assert.equal(looksLikeOutline('- a\n- b'), true);
    assert.equal(looksLikeOutline('Une phrase.\nUne autre.'), false);
  });

  test('outline import is bounded; export round-trips', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `- item ${i}`).join('\n');
    assert.equal(countNodes(fromOutline(many)!), CANVAS_LIMITS.mindmapNodes);
    const text = toOutline(tree());
    assert.equal(text.split('\n')[0], '- Film');
    assert.ok(text.includes('\n    - Synopsis'));
    const back = fromOutline(text)!;
    assert.deepEqual(toOutline(back), text);
  });
});

describe('geometry', () => {
  const rect = (id: string, x: number, y: number, w = 100, h = 50, shape: 'rect' | 'ellipse' = 'rect'): CanvasObject => ({
    id,
    type: 'shape',
    x,
    y,
    w,
    h,
    z: 'a0',
    shape,
    fill: 'none',
    stroke: 'default',
    strokeWidth: 2,
    dash: 'solid',
    text: '',
    fontSize: 'm',
    textColor: 'default',
  });
  const objects = new Map<string, CanvasObject>([
    ['A', rect('A', 0, 0)],
    ['B', rect('B', 300, 0)],
    ['E', rect('E', 0, 300, 100, 100, 'ellipse')],
  ]);
  const get = (id: string) => objects.get(id);

  test('straight connectors leave attached shapes on their boundary and follow them', () => {
    const r = connectorRoute({ from: { id: 'A' }, to: { id: 'B' }, route: 'straight' }, get);
    assert.deepEqual(r.start, { x: 100, y: 25 });
    assert.deepEqual(r.end, { x: 300, y: 25 });
    objects.set('B', rect('B', 300, 200));
    const moved = connectorRoute({ from: { id: 'A' }, to: { id: 'B' }, route: 'straight' }, get);
    assert.ok(moved.end.y > 25);
    objects.set('B', rect('B', 300, 0));
    // Ellipse boundary.
    const p = boundaryPoint({ x: 0, y: 300, w: 100, h: 100 }, { x: 50, y: 0 }, true);
    assert.ok(Math.abs(p.y - 300) < 0.001 && Math.abs(p.x - 50) < 0.001);
  });

  test('elbow connectors are orthogonal; fixed anchors and free ends are honoured', () => {
    const r = connectorRoute({ from: { id: 'A' }, to: { x: 400, y: 200 }, route: 'elbow' }, get);
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!;
      const b = r.points[i]!;
      assert.ok(a.x === b.x || a.y === b.y, 'segment is horizontal or vertical');
    }
    assert.deepEqual(r.end, { x: 400, y: 200 });
    const fixed = connectorRoute({ from: { id: 'A', ax: 0.5, ay: 1 }, to: { id: 'B' }, route: 'curve' }, get);
    assert.deepEqual(fixed.start, { x: 50, y: 50 });
    assert.ok(fixed.d.startsWith('M 50 50 C'));
    // A connector to a missing object degrades gracefully.
    assert.doesNotThrow(() => connectorRoute({ from: { id: 'zz' }, to: { id: 'A' }, route: 'straight' }, get));
  });

  test('snapping aligns edges and centres within the threshold only', () => {
    const s = snapRect({ x: 103, y: 47, w: 50, h: 20 }, [{ x: 0, y: 0, w: 100, h: 50 }], 5);
    assert.equal(s.dx, -3);
    assert.equal(s.dy, 3);
    assert.deepEqual(s.guides, { x: [100], y: [50] });
    assert.deepEqual(snapRect({ x: 120, y: 90, w: 10, h: 10 }, [{ x: 0, y: 0, w: 100, h: 50 }], 5), { dx: 0, dy: 0, guides: { x: [], y: [] } });
  });

  test('align and distribute', () => {
    const rects = new Map([
      ['a', { x: 0, y: 0, w: 10, h: 10 }],
      ['b', { x: 50, y: 30, w: 20, h: 10 }],
      ['c', { x: 200, y: 5, w: 10, h: 40 }],
    ]);
    assert.deepEqual(alignRects(rects, 'right').get('a'), { x: 200, y: 0 });
    assert.deepEqual(alignRects(rects, 'vmiddle').get('b'), { x: 50, y: 17.5 });
    const d = distributeRects(rects, 'x');
    assert.equal(d.get('a')!.x, 0);
    assert.equal(d.get('c')!.x, 200);
    assert.equal(d.get('b')!.x, 95); // gaps of 85 around b (width 20)
  });

  test('resizing: handles, minimum size, proportions; selection scaling', () => {
    assert.deepEqual(resizeRect({ x: 0, y: 0, w: 100, h: 50 }, 'se', 20, 10, false), { x: 0, y: 0, w: 120, h: 60 });
    assert.deepEqual(resizeRect({ x: 0, y: 0, w: 100, h: 50 }, 'w', 150, 0, false), { x: 100, y: 0, w: 50, h: 50 });
    const ratio = resizeRect({ x: 0, y: 0, w: 100, h: 50 }, 'nw', -100, 0, true);
    assert.equal(ratio.w / ratio.h, 2);
    assert.equal(ratio.x + ratio.w, 100);
    const scaled = scaleObject(rect('s', 10, 10, 10, 10), { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 200, h: 50 });
    assert.deepEqual([scaled.x, scaled.y, scaled.w, scaled.h], [20, 5, 20, 5]);
  });

  test('strokes: box from points with the pen size; bounds of a mind map follow its layout', () => {
    const s = strokeFromPoints([{ x: 10, y: 10 }, { x: 30, y: 50 }], 4);
    assert.deepEqual([s.x, s.y, s.w, s.h], [8, 8, 24, 44]);
    assert.deepEqual(s.points, [2, 2, 22, 42]);
    const mm: CanvasObject = { id: 'm', type: 'mindmap', x: 100, y: 100, w: 0, h: 0, z: 'a0', layout: 'left', style: 'classic', root: tree() };
    const b = objectBounds(mm, get);
    assert.ok(b.x < 100, 'left layout extends left of the root');
  });

  test('validation rejects what the server rejects and keeps valid objects intact', () => {
    const ok = rect('ok', 1, 2);
    assert.deepEqual(sanitizeCanvasObject(ok), ok);
    assert.equal(sanitizeCanvasObject({ ...ok, fill: 'url(#x)' }), null);
    assert.equal(sanitizeCanvasObject({ ...ok, x: Number.NaN }), null);
    assert.equal(sanitizeCanvasObject({ id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, z: 'a0', name: 'x', src: '//evil.test/a.png' }), null);
    assert.ok(sanitizeCanvasObject({ id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, z: 'a0', name: 'x', src: `/api/files/${'a'.repeat(32)}/photo%20plan.png` }));
    assert.equal(sanitizeCanvasObject({ ...ok, extra: '<script>' } as never)?.hasOwnProperty('extra'), false);
  });
});
