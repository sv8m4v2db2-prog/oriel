/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileFormula,
  evaluateFormula,
  runFormula,
  formulaValueToText,
  FORMULA_FUNCTIONS,
  type FormulaEnv,
  type FormulaValue,
  type FormulaResult,
} from './formula';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(props: Record<string, FormulaValue> = {}, now?: Date): FormulaEnv {
  const env: FormulaEnv = {
    getProp: (name) => (Object.prototype.hasOwnProperty.call(props, name) ? props[name] : undefined),
  };
  if (now) env.now = () => now;
  return env;
}

function run(source: string, props: Record<string, FormulaValue> = {}, now?: Date): FormulaResult {
  return runFormula(source, makeEnv(props, now));
}

function value(source: string, props: Record<string, FormulaValue> = {}, now?: Date): FormulaValue {
  const r = run(source, props, now);
  assert.equal(r.error, undefined, `unexpected error for ${source}: ${r.error ?? ''}`);
  return r.value;
}

function compileError(source: string): { message: string; position: number } {
  const c = compileFormula(source);
  assert.ok(c.error, `expected a compile error for ${source}`);
  assert.equal(c.ast, null);
  return c.error;
}

function runtimeError(source: string, props: Record<string, FormulaValue> = {}): string {
  const c = compileFormula(source);
  assert.equal(c.error, null, `unexpected compile error for ${source}: ${c.error?.message ?? ''}`);
  const r = evaluateFormula(c, makeEnv(props));
  assert.equal(r.type, 'empty');
  assert.equal(r.value, null);
  assert.ok(r.error, `expected a runtime error for ${source}`);
  return r.error;
}

/** Normalise les espaces insécables (fine ou normale) que peut produire Intl. */
const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');

const D = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m, d, h, min);

// ---------------------------------------------------------------------------
// Compilation : source vide, tokenizer, syntaxe
// ---------------------------------------------------------------------------

describe('compilation', () => {
  test('empty or whitespace-only source', () => {
    for (const src of ['', '   ', '\n\t ']) {
      const c = compileFormula(src);
      assert.equal(c.error, null);
      assert.equal(c.ast, null);
      assert.deepEqual(c.references, []);
      assert.deepEqual(evaluateFormula(c, makeEnv()), { type: 'empty', value: null });
    }
  });

  test('number literals', () => {
    assert.equal(value('12'), 12);
    assert.equal(value('3.5'), 3.5);
    assert.equal(value('.5'), 0.5);
    assert.equal(value('1e3'), 1000);
    assert.equal(value('2.5E-1'), 0.25);
    assert.equal(value('  42  '), 42);
  });

  test('tokenizer errors carry a position', () => {
    assert.deepEqual(compileError('1 # 2'), { message: 'Caractère inattendu : «#»', position: 2 });
    assert.deepEqual(compileError('"abc'), { message: 'Chaîne non terminée', position: 0 });
    assert.deepEqual(compileError("1 + 'abc"), { message: 'Chaîne non terminée', position: 4 });
    assert.deepEqual(compileError('"abc\\'), { message: 'Chaîne non terminée', position: 0 });
    assert.deepEqual(compileError('12abc'), { message: 'Nombre invalide', position: 0 });
    assert.deepEqual(compileError('1 + 1.2.3'), { message: 'Nombre invalide', position: 4 });
    assert.equal(compileError('1e').message, 'Nombre invalide');
    assert.deepEqual(compileError('1 & 2'), { message: 'Caractère inattendu : «&»', position: 2 });
    assert.deepEqual(compileError('1 ; 2'), { message: 'Caractère inattendu : «;»', position: 2 });
  });

  test('syntax errors', () => {
    assert.deepEqual(compileError('(1 + 2'), { message: 'Parenthèse fermante attendue', position: 6 });
    assert.deepEqual(compileError('1 +'), { message: 'Expression attendue', position: 3 });
    assert.deepEqual(compileError('* 2'), { message: 'Expression attendue', position: 0 });
    assert.deepEqual(compileError('1 2'), { message: 'Opérateur attendu', position: 2 });
    assert.deepEqual(compileError('1 + 2)'), { message: 'Parenthèse fermante inattendue', position: 5 });
    assert.deepEqual(compileError('1, 2'), { message: 'Virgule inattendue', position: 1 });
    assert.equal(compileError('if(true, 1, 2').message, 'Parenthèse fermante attendue');
    assert.equal(compileError('concat(1,)').message, 'Expression attendue');
    assert.equal(compileError('now').message, 'Parenthèse ouvrante attendue après now');
    assert.match(compileError('Prix + 1').message, /prop\("Prix"\)/);
    assert.match(compileError('1 + not true').message, /Parenthèses nécessaires/);
  });

  test('a syntax error yields an empty value with the message', () => {
    assert.deepEqual(run('1 +'), { type: 'empty', value: null, error: 'Expression attendue' });
  });

  test('multi-line formulas', () => {
    assert.equal(value('if(\n  true,\n  1,\n  2\n)'), 1);
  });
});

// ---------------------------------------------------------------------------
// Opérateurs
// ---------------------------------------------------------------------------

describe('operators', () => {
  test('precedence and associativity', () => {
    assert.equal(value('1 + 2 * 3'), 7);
    assert.equal(value('-2 * 3'), -6);
    assert.equal(value('not true and false'), false);
    assert.equal(value('1 < 2 and 3 > 2'), true);
    assert.equal(value('(1 + 2) * 3'), 9);
    assert.equal(value('10 - 2 - 3'), 5);
    assert.equal(value('2 * 3 % 4'), 2);
    assert.equal(value('1 + 2 == 3'), true);
    assert.equal(value('true or false and false'), true);
    assert.equal(value('not 1 == 2'), true);
    assert.equal(value('2 * -3'), -6);
    assert.equal(value('- -4'), 4);
    assert.equal(value('+5'), 5);
  });

  test('operator aliases and case-insensitive keywords', () => {
    assert.equal(value('1 = 1'), true);
    assert.equal(value('true && false'), false);
    assert.equal(value('false || true'), true);
    assert.equal(value('!false'), true);
    assert.equal(value('1 <> 2'), true);
    assert.equal(value('TRUE AND not FALSE'), true);
  });

  test('strings and escapes', () => {
    assert.equal(value(String.raw`"a\"b"`), 'a"b');
    assert.equal(value(String.raw`'it\'s'`), "it's");
    assert.equal(value(String.raw`"x\\y"`), 'x\\y');
    assert.equal(value(String.raw`"l1\nl2"`), 'l1\nl2');
    assert.equal(value(String.raw`"a\tb"`), 'a\tb');
    assert.equal(value(String.raw`"C:\dossier"`), 'C:\\dossier');
    assert.equal(value(`'"double" ici'`), '"double" ici');
    assert.equal(value('"émoji 😀"'), 'émoji 😀');
  });

  test('+ concatenates as soon as one operand is text', () => {
    assert.equal(value('"a" + 1'), 'a1');
    assert.equal(value('"x" + 3.5'), 'x3,5');
    assert.equal(value('1 + "a"'), '1a');
    assert.equal(value('"v: " + true'), 'v: vrai');
    assert.equal(value('"Le " + prop("D")', { D: D(2024, 0, 5) }), 'Le 5 janv. 2024');
    assert.deepEqual(run('"" + prop("Vide")', { Vide: null }), { type: 'string', value: '' });
  });

  test('empty values propagate through arithmetic', () => {
    const props = { Vide: null };
    assert.deepEqual(run('prop("Vide") + 1', props), { type: 'empty', value: null });
    assert.deepEqual(run('2 * prop("Vide")', props), { type: 'empty', value: null });
    assert.deepEqual(run('prop("Vide") - 1', props), { type: 'empty', value: null });
    assert.deepEqual(run('-prop("Vide")', props), { type: 'empty', value: null });
  });

  test('arithmetic type errors', () => {
    assert.match(runtimeError('prop("D") + 1', { D: D(2024, 0, 1) }), /« \+ »/);
    assert.match(runtimeError('true * 2'), /« \* »/);
    assert.match(runtimeError('"a" - 1'), /« - »/);
    assert.match(runtimeError('-"a"'), /« - »/);
  });

  test('division by zero and non-finite results', () => {
    assert.equal(runtimeError('1 / 0'), 'Division par zéro');
    assert.equal(runtimeError('5 % 0'), 'Division par zéro');
    assert.equal(runtimeError('1e308 * 10'), 'Résultat numérique invalide');
    assert.equal(value('7 % 3'), 1);
    assert.equal(value('-7 % 3'), -1);
    assert.equal(value('7 / 2'), 3.5);
  });

  test('comparisons', () => {
    const props = { Vide: null, D1: D(2024, 5, 1), D2: D(2024, 0, 1), D1bis: D(2024, 5, 1) };
    assert.equal(value('2 >= 2'), true);
    assert.equal(value('2 <= 1'), false);
    assert.equal(value('"é" < "f"'), true, 'French collation, not code units');
    assert.equal(value('"a" == "a"'), true);
    assert.equal(value('"a" == "A"'), false);
    assert.equal(value('1 == "1"'), false);
    assert.equal(value('1 != "1"'), true);
    assert.equal(value('true == true'), true);
    assert.equal(value('true != false'), true);
    assert.equal(value('true < false'), false);
    assert.equal(value('prop("Vide") == prop("Vide")', props), true);
    assert.equal(value('prop("Vide") == 0', props), false);
    assert.equal(value('prop("Vide") > 0', props), false);
    assert.equal(value('prop("Vide") < 0', props), false);
    assert.equal(value('1 < "2"'), false);
    assert.equal(value('prop("D1") > prop("D2")', props), true);
    assert.equal(value('prop("D1") == prop("D1bis")', props), true);
    assert.equal(value('prop("D1") <= prop("D1bis")', props), true);
  });

  test('truthiness, and/or return booleans and short-circuit', () => {
    const props = { Vide: null, D: D(2024, 0, 1) };
    assert.equal(value('not 0'), true);
    assert.equal(value('not ""'), true);
    assert.equal(value('not "a"'), false);
    assert.equal(value('not prop("D")', props), false);
    assert.equal(value('not prop("Vide")', props), true);
    assert.deepEqual(run('1 and "a"'), { type: 'boolean', value: true });
    assert.deepEqual(run('0 or ""'), { type: 'boolean', value: false });
    assert.equal(value('false and 1 / 0'), false);
    assert.equal(value('true or prop("Absente")'), true);
  });
});

// ---------------------------------------------------------------------------
// prop() et références
// ---------------------------------------------------------------------------

describe('prop()', () => {
  test('resolves property values', () => {
    const props = { Prix: 10, Quantité: 3 };
    assert.equal(value('prop("Prix") * prop("Quantité")', props), 30);
    assert.equal(value("prop('Prix')", props), 10);
  });

  test('missing property is a runtime error', () => {
    assert.equal(runtimeError('prop("Prix") + 1'), 'Propriété introuvable : «Prix»');
  });

  test('prop() requires one quoted name', () => {
    const msg = "prop() attend le nom d'une propriété entre guillemets";
    assert.deepEqual(compileError('prop(Prix)'), { message: msg, position: 5 });
    assert.deepEqual(compileError('prop("a", "b")'), { message: msg, position: 8 });
    assert.equal(compileError('prop()').message, msg);
    assert.equal(compileError('prop(1)').message, msg);
    assert.equal(compileError('prop("a" + "b")').message, msg);
  });

  test('references are deduplicated in order of appearance', () => {
    const c = compileFormula('prop("A") + prop("B") * prop("A") + if(prop("C"), 1, 2)');
    assert.equal(c.error, null);
    assert.deepEqual(c.references, ['A', 'B', 'C']);
    assert.deepEqual(compileFormula('prop("A") +').references, []);
    assert.deepEqual(compileFormula('1 + 2').references, []);
  });
});

// ---------------------------------------------------------------------------
// Fonctions
// ---------------------------------------------------------------------------

describe('functions', () => {
  test('unknown functions are compile errors (including prototype names)', () => {
    assert.deepEqual(compileError('foo(1)'), { message: 'Fonction inconnue : foo', position: 0 });
    assert.deepEqual(compileError('1 + bar()'), { message: 'Fonction inconnue : bar', position: 4 });
    assert.equal(compileError('constructor(1)').message, 'Fonction inconnue : constructor');
    assert.equal(compileError('toString(1)').message, 'Fonction inconnue : toString');
    assert.equal(compileError('élève(1)').message, 'Fonction inconnue : élève');
  });

  test('arity errors', () => {
    assert.deepEqual(compileError('if(true, 1)'), {
      message: 'if() attend 3 arguments (2 fournis)',
      position: 0,
    });
    assert.equal(compileError('now(1)').message, "now() n'attend aucun argument (1 fourni)");
    assert.equal(compileError('round(1, 2, 3)').message, 'round() attend 1 à 2 arguments (3 fournis)');
    assert.equal(compileError('concat()').message, 'concat() attend au moins 1 argument (0 fourni)');
    assert.match(compileError('min()').message, /^min\(\) attend au moins 1 argument/);
    assert.match(compileError('length(1, 2)').message, /^length\(\) attend 1 argument/);
    assert.equal(compileError('1 + abs()').position, 4);
  });

  test('function names are case-insensitive', () => {
    assert.equal(value('IF(TRUE, "o", "n")'), 'o');
    assert.equal(value('Upper("a")'), 'A');
  });

  test('if() evaluates only the chosen branch', () => {
    assert.equal(value('if(true, 1, 1 / 0)'), 1);
    assert.equal(value('if(false, prop("Absente"), "ok")'), 'ok');
    assert.equal(value('if(prop("Vide"), 1, 2)', { Vide: null }), 2);
    assert.equal(value('if(0, "a", "b")'), 'b');
    assert.equal(value('if("x", "a", "b")'), 'a');
    assert.equal(runtimeError('if(true, 1 / 0, 1)'), 'Division par zéro');
  });

  test('concat, length, lower, upper', () => {
    assert.equal(value('concat("a", 1, true, prop("Vide"), 2.5)', { Vide: null }), 'a1vrai2,5');
    assert.equal(value('length("héllo")'), 5);
    assert.equal(value('length(prop("Vide"))', { Vide: null }), 0);
    assert.equal(value('length(12.5)'), 4);
    assert.equal(value('length("😀a")'), 2);
    assert.equal(value('lower("ÉCOLE")'), 'école');
    assert.equal(value('upper("élève")'), 'ÉLÈVE');
    assert.deepEqual(run('lower(prop("Vide"))', { Vide: null }), { type: 'empty', value: null });
  });

  test('round, floor, ceil, abs', () => {
    assert.equal(value('round(2.5)'), 3);
    assert.equal(value('round(-2.5)'), -3);
    assert.equal(value('round(2.4)'), 2);
    assert.equal(value('round(1.005, 2)'), 1.01);
    assert.equal(value('round(1234.5678, 2)'), 1234.57);
    assert.equal(value('round(1250, -2)'), 1300);
    assert.ok(Object.is(value('round(-0.4)'), 0), 'no negative zero');
    assert.equal(value('round(2.5, prop("Vide"))', { Vide: null }), 3);
    assert.equal(value('floor(-1.5)'), -2);
    assert.equal(value('ceil(1.2)'), 2);
    assert.ok(Object.is(value('ceil(-0.5)'), 0), 'no negative zero');
    assert.equal(value('abs(-3)'), 3);
    assert.deepEqual(run('abs(prop("Vide"))', { Vide: null }), { type: 'empty', value: null });
    assert.deepEqual(run('round(prop("Vide"), 2)', { Vide: null }), { type: 'empty', value: null });
    assert.equal(runtimeError('round("a")'), 'Arguments invalides pour round()');
    assert.equal(runtimeError('round(1, "2")'), 'Arguments invalides pour round()');
    assert.equal(runtimeError('floor(true)'), 'Arguments invalides pour floor()');
  });

  test('min and max', () => {
    const props = { Vide: null, D1: D(2024, 5, 1), D2: D(2024, 0, 1) };
    assert.equal(value('min(3, 1, 2)'), 1);
    assert.equal(value('max(3, 1, 2)'), 3);
    assert.equal(value('min(-1)'), -1);
    assert.equal(value('min(prop("Vide"), 5, prop("Vide"))', props), 5);
    assert.deepEqual(run('max(prop("Vide"), prop("Vide"))', props), { type: 'empty', value: null });
    const earliest = run('min(prop("D1"), prop("D2"))', props);
    assert.equal(earliest.type, 'date');
    assert.equal((earliest.value as Date).getTime(), D(2024, 0, 1).getTime());
    assert.equal((value('max(prop("D1"), prop("D2"))', props) as Date).getTime(), D(2024, 5, 1).getTime());
    assert.match(runtimeError('max(1, prop("D1"))', props), /^Arguments invalides pour max\(\)/);
    assert.match(runtimeError('min("a", 1)'), /^Arguments invalides pour min\(\)/);
  });

  test('now() uses the injected clock and is stable within one evaluation', () => {
    const fixed = D(2024, 4, 20, 9, 15);
    const r = run('now()', {}, fixed);
    assert.equal(r.type, 'date');
    assert.equal((r.value as Date).getTime(), fixed.getTime());
    assert.equal(value('dateBetween(now(), prop("D"), "days")', { D: D(2024, 4, 10) }, fixed), 10);

    let tick = 0;
    const env: FormulaEnv = { getProp: () => undefined, now: () => new Date(2024, 0, 1, 0, 0, tick++) };
    assert.equal(runFormula('now() == now()', env).value, true);
  });

  test('dateBetween() with every unit', () => {
    const props = {
      JanEnd: D(2024, 0, 31),
      JanStart: D(2024, 0, 1),
      Mar15: D(2024, 2, 15),
      Jan10: D(2024, 0, 10),
      Y2026: D(2026, 5, 1),
      Y2024: D(2024, 5, 2),
      H10: D(2024, 0, 1, 10, 30),
      H8: D(2024, 0, 1, 8, 0),
      Jan8Noon: D(2024, 0, 8, 12, 0),
    };
    const v = (src: string): FormulaValue => value(src, props);
    assert.equal(v('dateBetween(prop("JanEnd"), prop("JanStart"), "days")'), 30);
    assert.equal(v('dateBetween(prop("JanStart"), prop("JanEnd"), "days")'), -30);
    assert.equal(v('dateBetween(prop("JanEnd"), prop("JanStart"), "weeks")'), 4);
    assert.equal(v('dateBetween(prop("Mar15"), prop("Jan10"), "months")'), 2);
    assert.equal(v('dateBetween(prop("Y2026"), prop("Y2024"), "years")'), 1);
    assert.equal(v('dateBetween(prop("H10"), prop("H8"), "hours")'), 2);
    assert.equal(v('dateBetween(prop("H10"), prop("H8"), "minutes")'), 150);
    // Troncature vers zéro
    assert.equal(v('dateBetween(prop("Jan8Noon"), prop("JanStart"), "days")'), 7);
    assert.equal(v('dateBetween(prop("Jan8Noon"), prop("JanStart"), "weeks")'), 1);
    assert.equal(v('dateBetween(prop("JanStart"), prop("Jan8Noon"), "weeks")'), -1);
    // Alias français
    assert.equal(v('dateBetween(prop("JanEnd"), prop("JanStart"), "jours")'), 30);
    assert.equal(v('dateBetween(prop("JanEnd"), prop("JanStart"), "semaines")'), 4);
    assert.equal(v('dateBetween(prop("Mar15"), prop("Jan10"), "mois")'), 2);
    assert.equal(v('dateBetween(prop("Y2026"), prop("Y2024"), "années")'), 1);
    assert.equal(v('dateBetween(prop("Y2026"), prop("Y2024"), "annees")'), 1);
    assert.ok(Object.is(v('dateBetween(prop("JanStart"), prop("JanStart"), "days")'), 0));
  });

  test('dateBetween() errors and empty dates', () => {
    const props = { Vide: null, A: D(2024, 0, 2), B: D(2024, 0, 1), U: 'siècles' };
    assert.deepEqual(run('dateBetween(prop("A"), prop("Vide"), "days")', props), { type: 'empty', value: null });
    assert.match(runtimeError('dateBetween(prop("A"), 3, "days")', props), /^Arguments invalides pour dateBetween\(\)/);
    assert.equal(runtimeError('dateBetween(prop("A"), prop("B"), prop("U"))', props), 'Unité invalide pour dateBetween() : «siècles»');
    const err = compileError('dateBetween(now(), now(), "siècles")');
    assert.match(err.message, /^Unité inconnue : «siècles»/);
    assert.equal(err.position, 26);
  });

  test('dateAdd()', () => {
    const props = { Jan31: D(2024, 0, 31), Jan1: D(2024, 0, 1), Vide: null };
    const t = (src: string): number => (value(src, props) as Date).getTime();
    assert.equal(t('dateAdd(prop("Jan31"), 1, "months")'), D(2024, 1, 29).getTime());
    assert.equal(t('dateAdd(prop("Jan1"), 2, "weeks")'), D(2024, 0, 15).getTime());
    assert.equal(t('dateAdd(prop("Jan1"), -1, "years")'), D(2023, 0, 1).getTime());
    assert.equal(t('dateAdd(prop("Jan1"), 3, "jours")'), D(2024, 0, 4).getTime());
    assert.equal(t('dateAdd(prop("Jan1"), 90, "minutes")'), D(2024, 0, 1, 1, 30).getTime());
    assert.deepEqual(run('dateAdd(prop("Vide"), 1, "days")', props), { type: 'empty', value: null });
    assert.match(runtimeError('dateAdd(1, 1, "days")'), /^Arguments invalides pour dateAdd\(\)/);
  });

  test('format() and empty()', () => {
    const props = { Vide: null };
    assert.equal(value('format(3.5)'), '3,5');
    assert.equal(value('format(true)'), 'vrai');
    assert.equal(value('format(prop("Vide"))', props), '');
    assert.equal(value('empty(prop("Vide"))', props), true);
    assert.equal(value('empty("  ")'), true);
    assert.equal(value('empty("")'), true);
    assert.equal(value('empty(0)'), false);
    assert.equal(value('empty(false)'), false);
    assert.equal(value('empty("a")'), false);
  });

  test('extras: not(), toNumber(), contains()', () => {
    const d = D(2024, 0, 1);
    assert.equal(value('not(true)'), false);
    assert.equal(value('not(0)'), true);
    assert.equal(value('not(1 == 2) and true'), true);
    assert.equal(value('toNumber("3,5")'), 3.5);
    assert.equal(value('toNumber(" 1 234,5 ")'), 1234.5);
    assert.equal(value('toNumber("-2.5e1")'), -25);
    assert.deepEqual(run('toNumber("abc")'), { type: 'empty', value: null });
    assert.equal(value('toNumber(true)'), 1);
    assert.equal(value('toNumber(prop("D"))', { D: d }), d.getTime());
    assert.equal(value('contains("Bonjour", "JOUR")'), true);
    assert.equal(value('contains("Élève", "élè")'), true);
    assert.equal(value('contains("abc", "x")'), false);
  });
});

// ---------------------------------------------------------------------------
// Résultats, robustesse, limites
// ---------------------------------------------------------------------------

describe('results and safety', () => {
  test('result types', () => {
    assert.equal(run('1').type, 'number');
    assert.equal(run('"a"').type, 'string');
    assert.equal(run('1 < 2').type, 'boolean');
    assert.equal(run('now()', {}, D(2024, 0, 1)).type, 'date');
    assert.equal(run('prop("V")', { V: null }).type, 'empty');
    assert.equal(runtimeError('prop("Bad")', { Bad: new Date(Number.NaN) }), 'Date invalide');
  });

  test('evaluateFormula never throws', () => {
    const throwingEnv: FormulaEnv = {
      getProp: () => {
        throw new Error('boom');
      },
    };
    const r = runFormula('prop("X")', throwingEnv);
    assert.equal(r.type, 'empty');
    assert.equal(r.value, null);
    assert.equal(r.error, 'Erreur lors du calcul de la formule');

    const forged = evaluateFormula({ source: 'x', error: null, ast: { k: 'weird' }, references: [] }, makeEnv());
    assert.deepEqual(forged, { type: 'empty', value: null, error: 'Formule invalide' });
  });

  test('nesting depth limit', () => {
    const ok = `${'('.repeat(64)}1${')'.repeat(64)}`;
    assert.equal(value(ok), 1);
    const tooDeep = `${'('.repeat(65)}1${')'.repeat(65)}`;
    const err = compileError(tooDeep);
    assert.match(err.message, /trop imbriquée/);
    assert.equal(err.position, 64);
    assert.match(compileError(`${'-'.repeat(65)}1`).message, /trop imbriquée/);
    assert.match(compileError(`${'abs('.repeat(65)}1${')'.repeat(65)}`).message, /trop imbriquée/);
  });

  test('source length limit', () => {
    const err = compileError(`"${'a'.repeat(5000)}"`);
    assert.match(err.message, /trop longue/);
    // Une longue chaîne d'additions (≤ 5000 caractères) reste évaluable.
    const longSum = `1${'+1'.repeat(2499)} `;
    assert.equal(longSum.length, 5000);
    assert.equal(value(longSum), 2500);
  });
});

// ---------------------------------------------------------------------------
// Conversion en texte et catalogue
// ---------------------------------------------------------------------------

describe('formulaValueToText', () => {
  test('scalars', () => {
    assert.equal(formulaValueToText(null), '');
    assert.equal(formulaValueToText('abc'), 'abc');
    assert.equal(formulaValueToText(true), 'vrai');
    assert.equal(formulaValueToText(false), 'faux');
    assert.equal(norm(formulaValueToText(3.5)), '3,5');
    assert.equal(norm(formulaValueToText(1234567.25)), '1234567,25');
    assert.equal(norm(formulaValueToText(-2)), '-2');
    assert.equal(norm(formulaValueToText(0.1 + 0.2)), '0,3');
    assert.equal(formulaValueToText(-0), '0');
  });

  test('dates', () => {
    assert.equal(norm(formulaValueToText(D(2024, 0, 5))), '5 janv. 2024');
    assert.equal(norm(formulaValueToText(D(2024, 0, 5, 14, 30))), '5 janv. 2024 14:30');
    assert.equal(formulaValueToText(new Date(Number.NaN)), '');
  });
});

describe('FORMULA_FUNCTIONS', () => {
  test('lists every function once with a French description', () => {
    const names = FORMULA_FUNCTIONS.map((f) => f.name);
    const expected = [
      'prop', 'if', 'concat', 'length', 'lower', 'upper', 'round', 'floor', 'ceil', 'abs', 'min', 'max',
      'now', 'dateBetween', 'dateAdd', 'format', 'empty', 'not', 'toNumber', 'contains',
      // I2 : listes, personnes et variables
      'sum', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'at', 'first', 'last', 'slice', 'sort',
      'reverse', 'unique', 'flat', 'join', 'includes', 'name', 'email', 'let', 'lets',
    ];
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.equal(new Set(names).size, names.length);
    for (const f of FORMULA_FUNCTIONS) {
      // Préfixe f(…) ou suffixe liste.f(…) pour les fonctions de liste.
      assert.ok(f.signature.startsWith(`${f.name}(`) || f.signature.includes(`.${f.name}(`), f.signature);
      assert.ok(f.description.length > 0);
    }
    assert.equal(FORMULA_FUNCTIONS.find((f) => f.name === 'if')?.signature, 'if(condition, siVrai, siFaux)');
  });
});
