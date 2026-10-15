/// <reference types="node" />
// Button block: validation of the stored actions (shared document = untrusted), values, row filter.
// Run: node --test --import tsx web/src/editor/buttonActions.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTON_MAX_ACTIONS, BUTTON_MAX_INSERT_BLOCKS, type Page, type PropertyDef } from '@oriel/shared';
import {
  BUTTON_MAX_JSON,
  buttonUpdate,
  buttonValue,
  countBlocks,
  filterRows,
  parseButtonActions,
  sanitizeButtonAction,
  sanitizeInsertBlocks,
  serializeButtonActions,
} from './buttonActions';

describe('parseButtonActions', () => {
  test('valid actions are kept', () => {
    const actions = [
      { type: 'confirm', message: 'Sûr ?' },
      { type: 'insert', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bonjour', styles: {} }] }] },
      { type: 'addRow', databaseId: 'db-1', values: { title: 'Nouvelle tâche', abcd: 'En cours' } },
      { type: 'editRows', databaseId: 'db-1', filter: { propertyId: 'abcd', value: 'À faire' }, values: { abcd: 'Fait' } },
      { type: 'editRows', databaseId: 'db-1', filter: null, values: {} },
      { type: 'open', pageId: '0f8b2c1e-1111-4222-8333-444455556666' },
      { type: 'open', url: 'https://exemple.fr/a?b=1' },
    ];
    assert.deepEqual(parseButtonActions(JSON.stringify(actions)), actions);
    assert.deepEqual(parseButtonActions(actions), actions);
  });

  test('garbage, unknown types and invalid fields are dropped', () => {
    assert.deepEqual(parseButtonActions('nope'), []);
    assert.deepEqual(parseButtonActions('{"type":"confirm"}'), []);
    assert.deepEqual(parseButtonActions(null), []);
    assert.deepEqual(parseButtonActions(42), []);
    assert.deepEqual(
      parseButtonActions([
        null,
        'x',
        { type: 'delete', pageId: 'p' },
        { type: 'addRow', databaseId: '../../admin' },
        { type: 'addRow', databaseId: { id: 1 } },
        { type: 'editRows', databaseId: 'd', filter: { propertyId: 'a b', value: 'x' }, values: [] },
        { type: 'open' },
        { type: 'open', pageId: 'a/b' },
        { type: 'confirm', message: 3 },
      ]),
      [
        { type: 'editRows', databaseId: 'd', filter: null, values: {} },
        { type: 'confirm', message: 'Continuer ?' },
      ],
    );
  });

  test('URLs limited to safe schemes', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' java\tscript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://a/b', '/relative', '']) {
      assert.equal(sanitizeButtonAction({ type: 'open', url }), null, url);
    }
    assert.deepEqual(sanitizeButtonAction({ type: 'open', url: 'mailto:a@b.fr' }), { type: 'open', url: 'mailto:a@b.fr' });
    assert.deepEqual(sanitizeButtonAction({ type: 'open', url: 'HTTPS://Exemple.fr' }), { type: 'open', url: 'https://exemple.fr/' });
  });

  test('values: property ids checked, lengths bounded, prototype keys ignored', () => {
    const values = JSON.parse('{"__proto__": "x", "ok": "' + 'v'.repeat(3000) + '", "bad id": "y", "num": 3}');
    const a = sanitizeButtonAction({ type: 'addRow', databaseId: 'd', values });
    assert.deepEqual(Object.keys((a as { values: object }).values), ['ok']);
    assert.equal((a as { values: Record<string, string> }).values.ok!.length, 2000);
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, 'v']));
    assert.equal(Object.keys((sanitizeButtonAction({ type: 'addRow', databaseId: 'd', values: many }) as { values: object }).values).length, 50);
  });

  test('bounds: number of actions, size of the JSON, confirmation message', () => {
    const list = Array.from({ length: 40 }, () => ({ type: 'confirm', message: 'ok' }));
    assert.equal(parseButtonActions(list).length, BUTTON_MAX_ACTIONS);
    assert.deepEqual(parseButtonActions(' '.repeat(BUTTON_MAX_JSON + 1)), []);
    assert.equal((sanitizeButtonAction({ type: 'confirm', message: 'm'.repeat(900) }) as { message: string }).message.length, 500);
  });
});

describe('recorded blocks', () => {
  test('ids stripped everywhere, unknown shapes dropped', () => {
    const blocks = sanitizeInsertBlocks([
      { id: 'b1', type: 'paragraph', props: { textColor: 'red' }, content: [{ type: 'text', text: 'a', styles: {}, id: 'x' }], children: [{ id: 'b2', type: 'bulletListItem', children: [] }] },
      { id: 'b3' },
      'text',
      { type: '' },
    ]);
    assert.deepEqual(blocks, [{ type: 'paragraph', props: { textColor: 'red' }, content: [{ type: 'text', text: 'a', styles: {} }], children: [{ type: 'bulletListItem' }] }]);
    assert.equal(JSON.stringify(blocks).includes('"id"'), false);
  });

  test('at most BUTTON_MAX_INSERT_BLOCKS blocks for the whole button, children included', () => {
    const deep = { type: 'paragraph', children: Array.from({ length: 30 }, () => ({ type: 'paragraph' })) };
    assert.equal(countBlocks(sanitizeInsertBlocks([deep, deep, deep])), BUTTON_MAX_INSERT_BLOCKS);
    const actions = parseButtonActions([
      { type: 'insert', blocks: [deep] },
      { type: 'insert', blocks: [deep] },
      { type: 'insert', blocks: [deep] },
    ]);
    assert.equal(actions.reduce((n, a) => n + (a.type === 'insert' ? countBlocks(a.blocks) : 0), 0), BUTTON_MAX_INSERT_BLOCKS);
  });

  test('nesting bounded; schema filter', () => {
    let nested: Record<string, unknown> = { type: 'paragraph' };
    for (let i = 0; i < 20; i++) nested = { type: 'paragraph', children: [nested] };
    assert.equal(countBlocks(sanitizeInsertBlocks([nested])), 9);
    assert.deepEqual(sanitizeInsertBlocks([{ type: 'evil' }, { type: 'paragraph' }], (t) => t === 'paragraph'), [{ type: 'paragraph' }]);
  });

  test('serialize ↔ parse', () => {
    const actions = [{ type: 'insert' as const, blocks: [{ id: 'z', type: 'paragraph' }] }];
    assert.equal(serializeButtonActions(actions), '[{"type":"insert","blocks":[{"type":"paragraph"}]}]');
  });
});

describe('values and rows', () => {
  const props: PropertyDef[] = [
    { id: 'title', name: 'Nom', type: 'title' },
    { id: 'st', name: 'Statut', type: 'select', options: [{ id: 'o1', name: 'À faire', color: 'gray' }, { id: 'o2', name: 'Fait', color: 'green' }] },
    { id: 'n', name: 'Nombre', type: 'number' },
    { id: 'd', name: 'Échéance', type: 'date' },
    { id: 'c', name: 'Fait ?', type: 'checkbox' },
    { id: 'who', name: 'Responsable', type: 'person' },
    { id: 'f', name: 'Calcul', type: 'formula', formula: '1' },
  ] as PropertyDef[];
  const users = [{ id: 'u1', name: 'Alice Martin', email: 'alice@exemple.fr', avatarUrl: null }] as never[];
  const cx = { users, meId: 'u2', now: new Date(2026, 9, 15, 9, 30) };

  test('text values → property values', () => {
    assert.deepEqual(
      buttonUpdate({ title: ' Tâche ', st: 'fait', n: '3,5', d: 'aujourd’hui', c: 'oui', who: 'moi, alice@exemple.fr', f: '2', zz: 'x' }, props, cx),
      { title: 'Tâche', properties: { st: 'o2', n: 3.5, d: { start: '2026-10-15' }, c: true, who: ['u2', 'u1'] } },
    );
    assert.equal(buttonValue(props[1]!, 'Inconnu', cx), undefined); // unknown option: nothing written
    assert.equal(buttonValue(props[2]!, '', cx), null); // empty: cleared
    assert.deepEqual(buttonValue(props[3]!, 'maintenant', cx), { start: cx.now.toISOString(), includeTime: true });
  });

  test('row filter', () => {
    const row = (id: string, properties: Record<string, unknown>) => ({ id, title: id, properties }) as unknown as Page;
    const rows = [row('a', { st: 'o1', c: true }), row('b', { st: 'o2' }), row('c', {})];
    assert.deepEqual(filterRows(rows, props, { propertyId: 'st', value: 'a faire' }).map((r) => r.id), ['a']);
    assert.deepEqual(filterRows(rows, props, { propertyId: 'st', value: '' }).map((r) => r.id), ['c']);
    assert.deepEqual(filterRows(rows, props, { propertyId: 'c', value: 'oui' }).map((r) => r.id), ['a']);
    assert.deepEqual(filterRows(rows, props, { propertyId: 'c', value: 'non' }).map((r) => r.id), ['b', 'c']);
    assert.deepEqual(filterRows(rows, props, null).map((r) => r.id), ['a', 'b', 'c']);
    assert.deepEqual(filterRows(rows, props, { propertyId: 'missing', value: '' }), []);
  });
});
