// The MCP BlockNote schema must mirror the web editor schema (type names, prop names and defaults,
// content kind), or documents lose nodes / attributes when they go through the MCP server. The web
// sources are parsed statically (TypeScript AST): React components cannot be imported under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as shared from '@oriel/shared';
import { CODE_DEFAULT_LANGUAGE, CUSTOM_BLOCKS, CUSTOM_INLINE, EXTENDED_NATIVE_PROPS, HEADING_LEVELS, MULTI_COLUMN_TYPES, schema } from '../src/content/schema.js';
import { CANONICAL_LANGUAGES } from '../src/content/codeLanguages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webSrc = path.join(root, 'web', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const sourceOf = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Top-level `const NAME = <literal>` of the file being parsed (e.g. a default label). */
let fileConstants = new Map<string, ts.Expression>();

function collectConstants(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
  }
  return out;
}

/** Evaluates literals, file constants and `EDITOR_TYPES.x`-style references to shared constants. */
function evaluate(node: ts.Expression): unknown {
  if (ts.isIdentifier(node) && fileConstants.has(node.text)) return evaluate(fileConstants.get(node.text)!);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const obj = (shared as Record<string, unknown>)[node.expression.text] as Record<string, unknown> | undefined;
    if (obj && node.name.text in obj) return obj[node.name.text];
  }
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  throw new Error(`Valeur non évaluable dans le schéma web : ${node.getText()}`);
}

const propName = (p: ts.ObjectLiteralElementLike) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);

interface FoundSpec {
  file: string;
  type: string;
  props: Record<string, unknown>;
  content: string;
}

function findSpecs(callee: string): FoundSpec[] {
  const out: FoundSpec[] = [];
  for (const file of walk(webSrc)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(callee)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
        const config = node.arguments[0];
        assert.ok(config && ts.isObjectLiteralExpression(config), `${file}: ${callee} sans configuration littérale`);
        let type = '';
        let content = '';
        const props: Record<string, unknown> = {};
        for (const p of config.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const name = propName(p);
          if (name === 'type') type = String(evaluate(p.initializer));
          if (name === 'content') content = String(evaluate(p.initializer));
          if (name === 'propSchema') {
            assert.ok(ts.isObjectLiteralExpression(p.initializer), `${file}: propSchema non littéral`);
            for (const prop of p.initializer.properties) {
              assert.ok(ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer), `${file}: prop non littérale`);
              const def = prop.initializer.properties.find((x) => propName(x) === 'default');
              assert.ok(def && ts.isPropertyAssignment(def), `${file}: prop « ${propName(prop)} » sans valeur par défaut`);
              props[propName(prop)!] = evaluate(def.initializer);
            }
          }
        }
        out.push({ file: path.relative(root, file), type, props, content });
      }
      ts.forEachChild(node, visit);
    };
    const sf = sourceOf(file);
    fileConstants = collectConstants(sf);
    visit(sf);
  }
  return out;
}

/** Keys and spreads of `blockSpecs` / `inlineContentSpecs` in web/src/editor/schema.ts. */
function schemaKeys(key: 'blockSpecs' | 'inlineContentSpecs'): { keys: string[]; spreads: string[] } {
  const sf = sourceOf(path.join(webSrc, 'editor', 'schema.ts'));
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && propName(node) === key && ts.isObjectLiteralExpression(node.initializer)) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(found, `${key} introuvable dans web/src/editor/schema.ts`);
  const keys: string[] = [];
  const spreads: string[] = [];
  for (const p of (found as ts.ObjectLiteralExpression).properties) {
    if (ts.isSpreadAssignment(p)) spreads.push(p.expression.getText());
    else if (propName(p)) keys.push(propName(p)!);
  }
  return { keys, spreads };
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

test('custom blocks of the web editor are mirrored (type, props and defaults, content)', () => {
  const web = findSpecs('createReactBlockSpec');
  assert.ok(web.length >= 9, 'blocs personnalisés trouvés dans le code web');
  const webTypes = web.map((s) => s.type).sort();
  assert.deepEqual(webTypes, Object.keys(CUSTOM_BLOCKS).sort(), 'mêmes types de blocs personnalisés');
  // Native blocks extended with Oriel props: `image` (crop, link) and `codeBlock` (view).
  const imageSource = readFileSync(path.join(webSrc, 'editor', 'imageBlock.tsx'), 'utf8');
  for (const [prop, def] of Object.entries(EXTENDED_NATIVE_PROPS.image)) {
    assert.match(imageSource, new RegExp(`${prop}:\\s*\\{\\s*default:\\s*'${def}'`), `prop image.${prop}`);
  }
  const schemaSource = readFileSync(path.join(webSrc, 'editor', 'schema.ts'), 'utf8');
  assert.match(schemaSource, /image:\s*ImageBlock\(\)/);
  assert.match(schemaSource, new RegExp(`view = \\{ default: '${EXTENDED_NATIVE_PROPS.codeBlock.view}'`));
  for (const spec of web) {
    const mirror = (CUSTOM_BLOCKS as Record<string, { props: Record<string, unknown>; content: string }>)[spec.type]!;
    assert.deepEqual(sortKeys(spec.props), sortKeys(mirror.props), `props de « ${spec.type} » (${spec.file})`);
    assert.equal(spec.content, mirror.content, `contenu de « ${spec.type} » (${spec.file})`);
  }
});

test('custom inline content (page / person / date mentions) is mirrored', () => {
  const web = findSpecs('createReactInlineContentSpec');
  assert.deepEqual(web.map((s) => s.type).sort(), Object.keys(CUSTOM_INLINE).sort());
  for (const spec of web) {
    const mirror = (CUSTOM_INLINE as Record<string, { props: Record<string, unknown>; content: string }>)[spec.type]!;
    assert.deepEqual(sortKeys(spec.props), sortKeys(mirror.props), `props de « ${spec.type} » (${spec.file})`);
    assert.equal(spec.content, mirror.content);
  }
});

test('the web schema composition (default specs, heading levels, code block, columns) matches', () => {
  const blocks = schemaKeys('blockSpecs');
  assert.ok(blocks.spreads.includes('defaultBlockSpecs'));
  for (const key of blocks.keys) {
    if (key === 'heading' || key === 'codeBlock' || key === 'image') continue;
    assert.ok(key in CUSTOM_BLOCKS, `bloc « ${key} » du schéma web absent du miroir`);
  }
  assert.deepEqual(blocks.spreads.filter((s) => s !== 'defaultBlockSpecs').sort(), ['extraBlockSpecs']);
  const inline = schemaKeys('inlineContentSpecs');
  assert.ok(inline.spreads.includes('defaultInlineContentSpecs'));
  for (const key of inline.keys) assert.ok(key in CUSTOM_INLINE, `contenu en ligne « ${key} » absent du miroir`);
  const text = readFileSync(path.join(webSrc, 'editor', 'schema.ts'), 'utf8');
  const levels = /createHeadingBlockSpec\(\{\s*levels:\s*\[([^\]]*)\]/.exec(text);
  assert.ok(levels, 'niveaux de titres du schéma web');
  assert.deepEqual(levels[1]!.split(',').map((x) => Number(x.trim())), [...HEADING_LEVELS]);
  assert.match(text, new RegExp(`defaultLanguage:\\s*'${CODE_DEFAULT_LANGUAGE}'`));
  assert.match(text, /withMultiColumn\(/, 'colonnes (xl-multi-column) dans le schéma web');
  for (const t of MULTI_COLUMN_TYPES) assert.ok(schema.blockSpecs[t as keyof typeof schema.blockSpecs], `type ${t} dans le miroir`);
  // The mirror itself exposes every custom type.
  for (const t of Object.keys(CUSTOM_BLOCKS)) assert.ok((schema.blockSpecs as Record<string, unknown>)[t], `bloc ${t}`);
  for (const t of Object.keys(CUSTOM_INLINE)) assert.ok((schema.inlineContentSpecs as Record<string, unknown>)[t], `inline ${t}`);
});

test('code block languages are canonical keys of @blocknote/code-block', async () => {
  const { codeBlockOptions } = await import('@blocknote/code-block');
  const keys = new Set(Object.keys(codeBlockOptions.supportedLanguages ?? {}));
  for (const k of CANONICAL_LANGUAGES) assert.ok(keys.has(k), `langage ${k}`);
});
