// I2 — formules structurées : listes, pages, personnes, variables locales, parcours de relations.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, PropertyDef } from '@oriel/shared';
import { compileFormula, formulaValueToText, runFormula, type FormulaEnv, type FormulaValue } from './formula';
import { applySorts } from './sort';
import {
  createRowContext,
  formulaKind,
  getFormulaResult,
  getText,
  isEmptyValue,
  type RelatedResolver,
  type RowContext,
} from './values';
import { makeRow, NOW, USERS } from './testFixtures';

const env: FormulaEnv = { getProp: () => undefined };
const value = (src: string, e: FormulaEnv = env): FormulaValue => {
  const r = runFormula(src, e);
  assert.equal(r.error, undefined, `${src} : ${r.error ?? ''}`);
  return r.value;
};
const text = (src: string, e: FormulaEnv = env) => formulaValueToText(value(src, e));
const error = (src: string, e: FormulaEnv = env): string => {
  const r = runFormula(src, e);
  assert.ok(r.error, `erreur attendue pour ${src}`);
  return r.error;
};
const compileError = (src: string): string => {
  const c = compileFormula(src);
  assert.ok(c.error, `erreur de syntaxe attendue pour ${src}`);
  return c.error.message;
};
const items = (v: FormulaValue): FormulaValue[] => {
  assert.ok(v && typeof v === 'object' && !(v instanceof Date) && v.kind === 'list', 'liste attendue');
  return [...v.items];
};

describe('listes', () => {
  test('littéraux, map, filter, index', () => {
    assert.deepEqual(items(value('[1, 2, 3].map(current * 2)')), [2, 4, 6]);
    assert.deepEqual(items(value('map([1, 2, 3], current + index)')), [1, 3, 5]);
    assert.deepEqual(items(value('[1, 2, 3, 4].filter(current % 2 == 0)')), [2, 4]);
    assert.deepEqual(items(value('[]')), []);
    assert.equal(value('[1, 2, 3].map(current * 2).filter(current > 2).length()'), 2);
  });

  test('find, findIndex, some, every', () => {
    assert.equal(value('[3, 8, 12].find(current > 5)'), 8);
    assert.equal(value('[3, 8, 12].find(current > 50)'), null);
    assert.equal(value('[3, 8, 12].findIndex(current > 5)'), 1);
    assert.equal(value('[3, 8, 12].findIndex(current > 50)'), -1);
    assert.equal(value('[3, 8].some(current > 5)'), true);
    assert.equal(value('[3, 8].every(current > 5)'), false);
    assert.equal(value('[].every(current > 5)'), true);
  });

  test('at, first, last, slice', () => {
    assert.equal(value('["a", "b", "c"].at(1)'), 'b');
    assert.equal(value('["a", "b", "c"].at(-1)'), 'c');
    assert.equal(value('["a", "b", "c"].at(5)'), null);
    assert.equal(value('["a", "b"].first()'), 'a');
    assert.equal(value('["a", "b"].last()'), 'b');
    assert.equal(value('[].first()'), null);
    assert.deepEqual(items(value('[1, 2, 3, 4].slice(1, 3)')), [2, 3]);
    assert.deepEqual(items(value('[1, 2, 3, 4].slice(-2)')), [3, 4]);
  });

  test('sort, reverse, unique, flat', () => {
    assert.deepEqual(items(value('[3, 1, 2].sort()')), [1, 2, 3]);
    assert.deepEqual(items(value('["b", "a", "C"].sort()')), ['a', 'b', 'C']);
    assert.deepEqual(items(value('[3, 1, 2].sort().reverse()')), [3, 2, 1]);
    assert.deepEqual(items(value('["bb", "a", "ccc"].sort(length(current))')), ['a', 'bb', 'ccc']);
    assert.deepEqual(items(value('[1, 2, 1, "1", 2].unique()')), [1, 2, '1']);
    assert.deepEqual(items(value('[[1, 2], 3, [4]].flat()')), [1, 2, 3, 4]);
  });

  test('join, includes, length, sum, min, max, empty, format', () => {
    assert.equal(value('[1, 2, 3].join(" + ")'), '1 + 2 + 3');
    assert.equal(value('["a", "b"].join()'), 'a, b');
    assert.equal(value('[1, 2].includes(2)'), true);
    assert.equal(value('[1, 2].includes("2")'), false);
    assert.equal(value('length([1, 2, 3])'), 3);
    assert.equal(value('[1, 2, 3].sum()'), 6);
    assert.equal(value('sum([1, 2], 3, [])'), 6);
    assert.equal(value('sum([])'), 0);
    assert.equal(value('[4, 9, 2].max()'), 9);
    assert.equal(value('min([4, 9], 2)'), 2);
    assert.equal(value('empty([])'), true);
    assert.equal(value('empty([0])'), false);
    assert.equal(value('format([1, "a", true])'), '1, a, vrai');
    assert.equal(value('if([], "plein", "vide")'), 'vide');
  });

  test('erreurs de liste', () => {
    assert.match(error('(5).map(current)'), /une liste attendue/);
    assert.match(error('[1, "a"].sum()'), /nombres attendus/);
    assert.match(error('[1].at("x")'), /position entière/);
  });
});

describe('variables locales', () => {
  test('let et lets', () => {
    assert.equal(value('let(x, 2, x * x)'), 4);
    assert.equal(value('lets(a, 2, b, a + 1, a * b)'), 6);
    assert.equal(value('let(prix, 10, [1, 2].map(current * prix).sum())'), 30);
    // La portée intérieure masque l'extérieure.
    assert.equal(value('let(x, 1, let(x, 2, x) + x)'), 3);
  });

  test('erreurs de syntaxe', () => {
    assert.match(compileError('let(x, 1)'), /expression après la dernière valeur/);
    assert.match(compileError('let(map, 1, map)'), /réservé/);
    assert.match(compileError('let(current, 1, current)'), /réservé/);
    assert.match(compileError('x + 1'), /Nom inconnu/);
    assert.match(compileError('let(x, 1, x) + x'), /Nom inconnu/);
    assert.match(compileError('current + 1'), /ne s'utilise que dans map/);
    assert.match(compileError('[1].map(current).foo()'), /Fonction inconnue : foo/);
    assert.match(compileError('[1, 2'), /Crochet fermant attendu/);
    assert.match(compileError('[1].'), /Nom de fonction attendu/);
    assert.match(compileError('[1].map()'), /map\(\) attend 2 arguments \(1 fourni\)/);
  });

  test('les noms lus par .prop() ne sont pas des propriétés de la ligne', () => {
    assert.deepEqual(compileFormula('prop("Liens").map(current.prop("Statut"))').references, ['Liens']);
  });
});

// ---------------------------------------------------------------------------
// Bases liées : Projets (db1) ↔ Tâches (db2), sous-tâches (relation de db2 vers elle-même).
// ---------------------------------------------------------------------------

const TASKS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'h', name: 'Heures', type: 'number' },
  {
    id: 'statut',
    name: 'Statut',
    type: 'status',
    options: [
      { id: 's1', name: 'À faire', color: 'default', group: 'todo' },
      { id: 's2', name: 'Fait', color: 'green', group: 'done' },
    ],
  },
  { id: 'resp', name: 'Responsable', type: 'person' },
  { id: 'sous', name: 'Sous-tâches', type: 'relation', relation: { databaseId: 'db2' } },
  { id: 'proj', name: 'Projet', type: 'relation', relation: { databaseId: 'db1' } },
  {
    id: 'total',
    name: 'Total',
    type: 'formula',
    formula: 'prop("Heures") + prop("Sous-tâches").map(current.prop("Total")).sum()',
  },
];

const PROJECTS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'taches', name: 'Tâches', type: 'relation', relation: { databaseId: 'db2' } },
];

const task = (id: string, title: string, props: Record<string, unknown>) =>
  makeRow(id, title, props as Page['properties'], { parentId: 'db2' });

function world(tasks: Page[], projects: Page[] = []) {
  const rows = new Map<string, Page>([...tasks, ...projects].map((r) => [r.id, r]));
  const contexts = new Map<string, RowContext>();
  const resolver: RelatedResolver = {
    row: (id) => rows.get(id),
    context: (db) => {
      const cached = contexts.get(db);
      if (cached) return cached;
      const schema = db === 'db1' ? PROJECTS : db === 'db2' ? TASKS : undefined;
      if (!schema) return undefined;
      const c = createRowContext(schema, { users: USERS, relationTitle: (id) => rows.get(id)?.title, related: resolver, now: () => NOW });
      contexts.set(db, c);
      return c;
    },
  };
  const ctxFor = (schema: PropertyDef[]) =>
    createRowContext(schema, { users: USERS, relationTitle: (id) => rows.get(id)?.title, related: resolver, now: () => NOW });
  return { rows, ctxFor };
}

const formula = (source: string, id = 'f'): PropertyDef => ({ id, name: id, type: 'formula', formula: source });

describe('pages, personnes et parcours de relations', () => {
  const tasks = [
    task('t1', 'Cadrage', { h: 2, statut: 's2', resp: ['u1'], proj: ['p1'] }),
    task('t2', 'Dessin', { h: 5, statut: 's1', resp: ['u1', 'u2'], proj: ['p1'], sous: ['t3', 't4'] }),
    task('t3', 'Croquis', { h: 1, statut: 's2', sous: [] }),
    task('t4', 'Encrage', { h: 3, statut: 's1', sous: ['t5'] }),
    task('t5', 'Couleur', { h: 4, statut: 's1' }),
  ];
  const projects = [makeRow('p1', 'Alpha', { taches: ['t1', 't2'] }, { parentId: 'db1' }), makeRow('p2', 'Béta', { taches: [] }, { parentId: 'db1' })];
  const { ctxFor } = world(tasks, projects);

  const evalOn = (row: Page, source: string, schema = PROJECTS) => {
    const f = formula(source);
    const ctx = ctxFor([...schema, f]);
    return getFormulaResult(row, f, ctx);
  };

  test('map d’une propriété des pages liées', () => {
    const r = evalOn(projects[0]!, 'prop("Tâches").map(current.prop("Statut"))');
    assert.equal(r.type, 'list');
    assert.deepEqual(items(r.value), ['Fait', 'À faire']);
  });

  test('filter sur une relation : résultat en pages', () => {
    const r = evalOn(projects[0]!, 'prop("Tâches").filter(current.prop("Statut") == "Fait")');
    assert.equal(r.type, 'list');
    assert.deepEqual(items(r.value), [{ kind: 'page', id: 't1', title: 'Cadrage' }]);
    assert.equal(formulaValueToText(r.value), 'Cadrage');
  });

  test('une page seule et une personne', () => {
    const page = evalOn(projects[0]!, 'prop("Tâches").first()');
    assert.deepEqual(page, { type: 'page', value: { kind: 'page', id: 't1', title: 'Cadrage' } });
    const person = evalOn(tasks[1]!, 'prop("Responsable").last()', TASKS);
    assert.deepEqual(person, { type: 'person', value: { kind: 'person', id: 'u2', name: 'Bruno Petit', email: 'bruno@example.test' } });
    assert.equal(evalOn(tasks[1]!, 'prop("Responsable").last().name()', TASKS).value, 'Bruno Petit');
    assert.equal(evalOn(tasks[1]!, 'prop("Responsable").map(current.email()).join(" ; ")', TASKS).value, 'alice@example.test ; bruno@example.test');
  });

  test('plusieurs niveaux : projet → tâches → sous-tâches', () => {
    const r = evalOn(projects[0]!, 'prop("Tâches").map(current.prop("Sous-tâches")).flat().map(current.prop("Nom"))');
    assert.deepEqual(items(r.value), ['Croquis', 'Encrage']);
    const back = evalOn(tasks[0]!, 'prop("Projet").first().prop("Tâches").map(current.prop("Heures")).sum()', TASKS);
    assert.equal(back.value, 7);
  });

  test('formule récursive sur une relation à soi-même (pas une référence circulaire)', () => {
    const ctx = ctxFor(TASKS);
    const total = TASKS.find((p) => p.id === 'total')!;
    assert.deepEqual(getFormulaResult(tasks[1]!, total, ctx), { type: 'number', value: 13 });
    assert.deepEqual(getFormulaResult(tasks[3]!, total, ctx), { type: 'number', value: 7 });
    // Lue depuis une autre base.
    assert.equal(evalOn(projects[0]!, 'prop("Tâches").map(current.prop("Total")).sum()').value, 15);
  });

  test('une boucle dans les données est signalée', () => {
    const loop = [task('a', 'A', { h: 1, sous: ['b'] }), task('b', 'B', { h: 1, sous: ['a'] })];
    const w = world(loop);
    const ctx = w.ctxFor(TASKS);
    const total = TASKS.find((p) => p.id === 'total')!;
    const r = getFormulaResult(loop[0]!, total, ctx);
    assert.equal(r.value, null);
    assert.equal(r.error, 'Référence circulaire');
  });

  test('profondeur de parcours bornée', () => {
    const chain = Array.from({ length: 30 }, (_, i) => task(`c${i}`, `C${i}`, { h: 1, sous: i < 29 ? [`c${i + 1}`] : [] }));
    const w = world(chain);
    const ctx = w.ctxFor(TASKS);
    const total = TASKS.find((p) => p.id === 'total')!;
    const r = getFormulaResult(chain[0]!, total, ctx);
    assert.match(r.error ?? '', /Parcours de relations trop profond/);
  });

  test('coût borné', () => {
    const r = runFormula('let(a, [0,1,2,3,4,5,6,7,8,9], a.map(a.map(a.map(a.map(a.map(a.map(1)))))))', env);
    assert.match(r.error ?? '', /trop coûteuse|Liste trop longue/);
  });

  test('propriété inconnue, liste au lieu de page, pages illisibles', () => {
    assert.equal(evalOn(projects[0]!, 'prop("Tâches").map(current.prop("Inconnue"))').error, 'Propriété introuvable : «Inconnue»');
    assert.match(evalOn(projects[0]!, 'prop("Tâches").prop("Nom")').error ?? '', /utilisez map/);
    assert.equal(evalOn(projects[1]!, 'prop("Tâches").first().prop("Nom")').value, null);
    assert.match(error('[1].first().prop("Nom")'), /s'applique à une page/);
    assert.match(
      runFormula('prop("R").first().prop("Nom")', { getProp: () => ({ kind: 'list', items: [{ kind: 'page', id: 'x', title: 'X' }] }) }).error ?? '',
      /pas disponibles/,
    );
  });

  test('forme préfixe historique et forme suffixe sur prop()', () => {
    const row = tasks[1]!;
    // length(prop()) lit l'ancien texte ; prop().length() et les listes calculées comptent les éléments.
    assert.equal(evalOn(row, 'length(prop("Responsable"))', TASKS).value, 'Alice Martin, Bruno Petit'.length);
    assert.equal(evalOn(row, 'prop("Responsable").length()', TASKS).value, 2);
    assert.equal(evalOn(row, 'length(prop("Sous-tâches").filter(true))', TASKS).value, 2);
    assert.equal(evalOn(row, 'prop("Sous-tâches")', TASKS).value, 'Croquis, Encrage');
    assert.equal(evalOn(row, 'prop("Sous-tâches").includes(prop("Sous-tâches").first())', TASKS).value, true);
  });

  test('type, texte, vide et tri des colonnes de formule en liste', () => {
    const f = formula('prop("Tâches").map(current.prop("Nom")).sort()');
    const ctx = ctxFor([...PROJECTS, f]);
    assert.equal(formulaKind(f, projects, ctx), 'text');
    assert.equal(getText(projects[0]!, f, ctx), 'Cadrage, Dessin');
    assert.equal(isEmptyValue(projects[1]!, f, ctx), true);
    assert.equal(isEmptyValue(projects[0]!, f, ctx), false);
    const sorted = applySorts(projects, [{ propertyId: 'f', direction: 'asc' }], ctx);
    assert.deepEqual(sorted.map((r) => r.id), ['p1', 'p2']);
  });
});
