/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FormConfig, PropertyDef } from '@oriel/shared';
import {
  availableQuestionProperties,
  buildSubmission,
  conditionCandidates,
  conditionChoices,
  conditionMatches,
  initialDraft,
  moveQuestion,
  newQuestionId,
  normalizeUrl,
  publicRestriction,
  removeQuestion,
  resolveQuestions,
  validateAnswers,
  visibleQuestions,
} from './form';
import { prop, SCHEMA } from './testFixtures';

const schema: PropertyDef[] = [
  ...SCHEMA,
  { id: 'mail', name: 'E-mail', type: 'email' },
  { id: 'tel', name: 'Téléphone', type: 'phone' },
  { id: 'lieu', name: 'Lieu', type: 'place' },
];

const form: FormConfig = {
  questions: [
    { id: 'q1', propertyId: 'title', required: true, label: 'Votre nom' },
    { id: 'q2', propertyId: 'cat' },
    { id: 'q3', propertyId: 'notes', showIf: { questionId: 'q2', value: 'o2' } },
    { id: 'q4', propertyId: 'fait' },
    { id: 'q5', propertyId: 'mail', required: true, showIf: { questionId: 'q4', value: 'false' } },
    { id: 'q6', propertyId: 'resp' },
    { id: 'q7', propertyId: 'lieu' },
    { id: 'q8', propertyId: 'total' },
    { id: 'q9', propertyId: 'ghost' },
    { id: 'q10', propertyId: 'qte' },
    { id: 'q11', propertyId: 'site' },
  ],
  acceptResponses: true,
};

describe('forms', () => {
  test('questions by mode: anonymous visitors get simple types only', () => {
    const member = resolveQuestions(form, schema, 'member').map((q) => q.question.id);
    assert.deepEqual(member, ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q10', 'q11']);
    const anon = resolveQuestions(form, schema, 'public').map((q) => q.question.id);
    assert.deepEqual(anon, ['q1', 'q2', 'q3', 'q4', 'q5', 'q10', 'q11']);
    assert.equal(resolveQuestions(form, schema, 'member')[0]!.label, 'Votre nom');
    assert.equal(resolveQuestions(form, schema, 'member')[1]!.label, 'Catégorie');
    assert.equal(publicRestriction(prop('resp'))?.includes('Personne'), true);
    assert.equal(publicRestriction(prop('notes')), null);
  });
  test('conditions (same rule as the server)', () => {
    assert.equal(conditionMatches('o2', 'o2'), true);
    assert.equal(conditionMatches(['t1', 't2'], 't2'), true);
    assert.equal(conditionMatches(false, 'false'), true);
    assert.equal(conditionMatches(undefined, 'false'), false);
    assert.equal(conditionMatches(3, '3'), true);
    const qs = resolveQuestions(form, schema, 'member');
    const ids = (a: Record<string, unknown>) => visibleQuestions(qs, a).map((q) => q.question.id);
    assert.equal(ids({ q2: 'o1', q4: true }).includes('q3'), false);
    assert.equal(ids({ q2: 'o2', q4: true }).includes('q3'), true);
    assert.equal(ids({ ...initialDraft(qs) }).includes('q5'), true);
    assert.equal(ids({ q4: true }).includes('q5'), false);
  });
  test('missing or circular conditions hide the question', () => {
    const f: FormConfig = {
      acceptResponses: true,
      questions: [
        { id: 'a', propertyId: 'cat', showIf: { questionId: 'b', value: 'o1' } },
        { id: 'b', propertyId: 'etat', showIf: { questionId: 'a', value: 'o1' } },
        { id: 'c', propertyId: 'notes', showIf: { questionId: 'zz', value: 'x' } },
        { id: 'd', propertyId: 'fait', showIf: { questionId: 'r', value: 'u1' } },
        { id: 'r', propertyId: 'resp' },
      ],
    };
    // In public mode the person question does not exist: what depends on it is hidden.
    const qs = resolveQuestions(f, schema, 'public');
    assert.deepEqual(visibleQuestions(qs, { a: 'o1', b: 'o1' }), []);
  });
  test('validation: required, formats, hidden questions ignored', () => {
    const qs = resolveQuestions(form, schema, 'member');
    const draft = initialDraft(qs);
    assert.deepEqual(Object.keys(validateAnswers(qs, draft)).sort(), ['q1', 'q5']);
    const errs = validateAnswers(qs, { ...draft, q1: 'Ana', q5: 'pas-une-adresse', q10: 'douze', q11: 'exemple.fr' });
    assert.deepEqual(errs, { q5: 'Adresse e-mail invalide.', q10: 'Saisissez un nombre.' });
    // The server refuses non-ASCII addresses and single-letter domains: reported before sending.
    for (const mail of ['repérage@exemple.fr', 'a@b.c', 'a..b@c.fr']) assert.ok(validateAnswers(qs, { ...draft, q1: 'Ana', q5: mail }).q5, mail);
    assert.deepEqual(validateAnswers(qs, { ...draft, q1: 'Ana', q5: "o'brien.lea+cadrage@exemple.fr" }), {});
    // The e-mail question disappears when the box is checked: no longer required.
    assert.deepEqual(validateAnswers(qs, { q1: 'Ana', q4: true }), {});
    const required: FormConfig = { acceptResponses: true, questions: [{ id: 'c', propertyId: 'fait', required: true }] };
    assert.deepEqual(validateAnswers(resolveQuestions(required, schema, 'public'), { c: false }), { c: 'Cette question est obligatoire.' });
  });
  test('submission: visible answered questions, typed values', () => {
    const qs = resolveQuestions(form, schema, 'member');
    const answers = {
      ...initialDraft(qs),
      q1: '  Ana  ',
      q2: 'o1',
      q3: 'caché',
      q5: 'ana@example.test',
      q6: ['u1'],
      q7: { address: '1 rue X', lat: 48.8, lng: 2.3 },
      q10: '1 234,5',
      q11: 'exemple.fr',
    };
    assert.deepEqual(buildSubmission(qs, answers), {
      q1: 'Ana',
      q2: 'o1',
      q4: false,
      q5: 'ana@example.test',
      q6: ['u1'],
      q7: { address: '1 rue X', lat: 48.8, lng: 2.3 },
      q10: 1234.5,
      q11: 'https://exemple.fr',
    });
    assert.equal(normalizeUrl('https://a.b'), 'https://a.b');
    assert.equal(normalizeUrl('  a.b '), 'https://a.b');
  });
  test('builder helpers', () => {
    const qs = resolveQuestions(form, schema, 'member');
    assert.deepEqual(conditionCandidates(form.questions[4]!, qs).map((q) => q.question.id), ['q2', 'q4']);
    assert.deepEqual(conditionChoices(prop('fait')).map((c) => c.value), ['true', 'false']);
    assert.deepEqual(conditionChoices(prop('etat')).map((c) => c.value), ['todo', 'doing', 'done']);
    assert.equal(newQuestionId(form), 'q12');
    assert.equal(newQuestionId({ acceptResponses: true, questions: [{ id: 'q2', propertyId: 'x' }] }), 'q3');
    const free = availableQuestionProperties(form, schema).map((p) => p.id);
    assert.equal(free.includes('cat'), false);
    assert.equal(free.includes('etat'), true);
    assert.equal(free.includes('total'), false);
    const removed = removeQuestion(form, 'q2');
    assert.equal(removed.questions.some((q) => q.id === 'q2'), false);
    assert.equal(removed.questions.find((q) => q.id === 'q3')!.showIf, null);
  });
});

describe('moveQuestion', () => {
  const f: FormConfig = {
    acceptResponses: true,
    questions: [
      { id: 'a', propertyId: 'cat' },
      { id: 'b', propertyId: 'notes', showIf: { questionId: 'a', value: 'o1' } },
      { id: 'c', propertyId: 'title' },
    ],
  };
  test('swaps neighbours and keeps valid conditions', () => {
    const moved = moveQuestion(f, 'c', -1);
    assert.deepEqual(moved.questions.map((q) => q.id), ['a', 'c', 'b']);
    assert.deepEqual(moved.questions[2]!.showIf, { questionId: 'a', value: 'o1' });
  });
  test('drops a condition that would refer to a later question', () => {
    const moved = moveQuestion(f, 'b', -1);
    assert.deepEqual(moved.questions.map((q) => q.id), ['b', 'a', 'c']);
    assert.equal(moved.questions[0]!.showIf, null);
  });
  test('out of range or unknown: unchanged', () => {
    assert.equal(moveQuestion(f, 'a', -1), f);
    assert.equal(moveQuestion(f, 'c', 1), f);
    assert.equal(moveQuestion(f, 'zz', 1), f);
  });
});
