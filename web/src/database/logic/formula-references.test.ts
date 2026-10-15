// D33: property references of formulas (rename rewriting, missing references).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFormula, missingFormulaReferences, renameFormulaReference } from './formula';

test('renameFormulaReference rewrites every prop() of the renamed property only', () => {
  const src = 'if(prop("Prix") > 10, prop("Prix") * 2, prop( \'Prix\' )) + length("Prix") + prop("Prix HT")';
  const out = renameFormulaReference(src, 'Prix', 'Tarif "net"');
  assert.equal(out, 'if(prop("Tarif \\"net\\"") > 10, prop("Tarif \\"net\\"") * 2, prop( "Tarif \\"net\\"" )) + length("Prix") + prop("Prix HT")');
  assert.deepEqual(compileFormula(out).references, ['Tarif "net"', 'Prix HT']);
});

test('renameFormulaReference keeps invalid or unrelated sources unchanged', () => {
  assert.equal(renameFormulaReference('prop("Prix', 'Prix', 'X'), 'prop("Prix');
  assert.equal(renameFormulaReference('1 + 2', 'Prix', 'X'), '1 + 2');
  assert.equal(renameFormulaReference('prop("a\\\\b")', 'a\\b', 'c'), 'prop("c")');
});

test('missingFormulaReferences lists deleted, renamed or hidden properties', () => {
  const props = [{ name: 'Prix' }, { name: 'Quantité' }];
  assert.deepEqual(missingFormulaReferences('prop("Prix") * prop("Remise") + prop("Ancien")', props), ['Remise', 'Ancien']);
  assert.deepEqual(missingFormulaReferences('prop("Prix")', props), []);
  assert.deepEqual(missingFormulaReferences(undefined, props), []);
});

// I2 : formes page.prop("…") — la base de la page est déduite des relations.
import type { PropertyDef } from '@oriel/shared';
import { renameFormulaReferences, renameRelatedFormulaReferences } from '@oriel/shared';

const TACHES: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'statut', name: 'État', type: 'select' }, // renommée depuis « Statut »
  { id: 'sous', name: 'Sous-tâches', type: 'relation', relation: { databaseId: 'db2' } },
  { id: 'proj', name: 'Projet', type: 'relation', relation: { databaseId: 'db1' } },
  { id: 'f', name: 'Fini', type: 'formula', formula: 'prop("Statut") == "Fait" and prop("Sous-tâches").every(current.prop("Statut") == "Fait")' },
];
const projets = (formula: string): PropertyDef[] => [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'statut', name: 'Statut', type: 'select' },
  { id: 'taches', name: 'Tâches', type: 'relation', relation: { databaseId: 'db2' } },
  { id: 'f', name: 'F', type: 'formula', formula },
];
const schemas = (db: string) => (db === 'db2' ? TACHES : undefined);

test('renommer dans une base réécrit prop() et current.prop() sur une relation à soi-même', () => {
  const out = renameFormulaReferences(TACHES, 'statut', 'Statut', { databaseId: 'db2', schemaOf: schemas });
  assert.equal(out.find((p) => p.id === 'f')?.formula, 'prop("État") == "Fait" and prop("Sous-tâches").every(current.prop("État") == "Fait")');
  // Sans l'id de la base, seul prop() est réécrit (comportement d'avant).
  const legacy = renameFormulaReferences(TACHES, 'statut', 'Statut');
  assert.equal(legacy.find((p) => p.id === 'f')?.formula, 'prop("État") == "Fait" and prop("Sous-tâches").every(current.prop("Statut") == "Fait")');
});

test('renommer dans une base liée réécrit seulement les .prop() qui la visent', () => {
  const src =
    'lets(t, prop("Tâches"), premier, t.first(), concat(prop("Statut"), t.map(current.prop("Statut")).join(), premier.prop("Statut"), ' +
    'prop("Tâches").map(current.prop("Projet")).flat().map(current.prop("Statut")).join(), if(true, t, t).last().prop("Statut")))';
  const out = renameRelatedFormulaReferences(projets(src), 'db1', 'db2', TACHES, 'statut', 'Statut', schemas);
  assert.ok(out);
  assert.equal(
    out.find((p) => p.id === 'f')?.formula,
    'lets(t, prop("Tâches"), premier, t.first(), concat(prop("Statut"), t.map(current.prop("État")).join(), premier.prop("État"), ' +
      'prop("Tâches").map(current.prop("Projet")).flat().map(current.prop("Statut")).join(), if(true, t, t).last().prop("État")))',
  );
  // Rien à faire : null.
  assert.equal(renameRelatedFormulaReferences(projets('prop("Statut")'), 'db1', 'db2', TACHES, 'statut', 'Statut', schemas), null);
});

test('base inconnue ou source invalide : références .prop() laissées telles quelles', () => {
  // « Autre » vise db3, dont le schéma est inconnu : la base des pages de « Lien » ne peut pas être déduite.
  const schema = [...projets('prop("Autre").map(current.prop("Lien")).flat().map(current.prop("Statut"))'), { id: 'autre', name: 'Autre', type: 'relation' as const, relation: { databaseId: 'db3' } }];
  assert.equal(renameRelatedFormulaReferences(schema, 'db1', 'db2', TACHES, 'statut', 'Statut', schemas), null);
  assert.equal(renameFormulaReference('prop("Statut").map(current.prop("Statut")', 'Statut', 'État'), 'prop("État").map(current.prop("Statut")');
});
