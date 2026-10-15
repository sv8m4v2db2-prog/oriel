/// <reference types="node" />
// QA-WEB-08 (remainder) — BlockNote does not enforce the propSchema on attributes read from Yjs: a
// heading stored with a forged `level` reached createElement(`h${level}`), which throws
// InvalidCharacterError, and the page editor crashed for every reader (published pages included).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeadingBlockSpec } from '@blocknote/core';
import { safeBlockProps, tocHeadingLevel, withSafeProps } from './safeProps';

// Same levels as the editor schema (schema.ts): Titre 1 to Titre 4.
const heading = createHeadingBlockSpec({ levels: [1, 2, 3, 4] });
const propSchema = heading.config.propSchema as Record<string, { default?: unknown; values?: readonly unknown[] }>;
const props = (extra: Record<string, unknown>) => ({ textColor: 'default', backgroundColor: 'default', textAlignment: 'left', level: 1, isToggleable: false, ...extra });

/** Just enough DOM for BlockNote's heading toExternalHTML; tag names validated like the real DOM. */
class FakeElement {
  tagName: string;
  className = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: unknown[] = [];
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value);
  }
  appendChild(child: unknown) {
    this.children.push(child);
    return child;
  }
}
function withFakeDocument<T>(run: () => T): T {
  const g = globalThis as { document?: unknown };
  const previous = g.document;
  g.document = {
    createElement(tag: string) {
      if (!/^[A-Za-z][^\s\0/>]*$/.test(tag)) throw new DOMException(`'${tag}' is not a valid tag name.`, 'InvalidCharacterError');
      return new FakeElement(tag);
    },
  };
  try {
    return run();
  } finally {
    g.document = previous;
  }
}
const exportHeading = (spec: typeof heading, blockProps: Record<string, unknown>) =>
  withFakeDocument(() => {
    const out = (spec.implementation.toExternalHTML as (...args: unknown[]) => { dom: FakeElement } | undefined).call(
      { blockContentDOMAttributes: {} },
      { id: 'b1', type: 'heading', props: blockProps, content: [], children: [] },
      {},
      {},
    );
    return (out!.dom.children[0] as FakeElement).tagName;
  });

describe('QA-WEB-08: native block props are made valid before BlockNote renders them', () => {
  test('the bug: BlockNote renders a forged level as is', () => {
    assert.deepEqual(propSchema.level!.values, [1, 2, 3, 4]);
    assert.equal(exportHeading(heading, props({ level: 2 })), 'H2');
    assert.throws(() => exportHeading(heading, props({ level: '1 onclick=alert(1)' })), { name: 'InvalidCharacterError' });
  });

  test('wrapped heading: forged levels fall back to the default level', () => {
    const safe = withSafeProps(heading);
    assert.equal(exportHeading(safe, props({ level: 2 })), 'H2');
    assert.equal(exportHeading(safe, props({ level: '3' })), 'H3'); // same value typed as text
    assert.equal(exportHeading(safe, props({ level: 4 })), 'H4');
    assert.equal(exportHeading(safe, props({ level: ' 4 ' })), 'H4');
    for (const level of ['1 onclick=alert(1)', { x: 1 }, null, 5, 6, 7, 0, -1, 1.5, 4.5, NaN, Infinity, '', '<script>', '4><img', [2]]) {
      assert.equal(exportHeading(safe, props({ level })), 'H1', JSON.stringify(level));
    }
    // The spec keeps everything else (config, node, parse rules…).
    assert.equal(safe.config, heading.config);
    assert.equal(safe.implementation.parse, heading.implementation.parse);
  });

  test('render receives the safe block, `this` forwarded, other arguments untouched', () => {
    const calls: { self: unknown; block: { id: string; props: Record<string, unknown> }; rest: unknown[] }[] = [];
    const fake = {
      config: { propSchema },
      implementation: {
        render(this: unknown, block: never, ...rest: unknown[]) {
          calls.push({ self: this, block, rest });
          return 'ok';
        },
      },
    };
    const safe = withSafeProps(fake);
    const self = { renderType: 'nodeView' };
    const editor = {};
    assert.equal(safe.implementation.render.call(self, { id: 'b1', props: props({ level: 'h1 x' }) } as never, editor as never), 'ok');
    assert.equal(calls[0]!.self, self);
    assert.equal(calls[0]!.block.id, 'b1');
    assert.equal(calls[0]!.block.props.level, 1);
    assert.equal(calls[0]!.rest[0], editor);
    assert.equal('toExternalHTML' in safe.implementation, false); // not added when the spec has none
    // A valid block is passed as the same object.
    const valid = { id: 'b2', props: props({ level: 3 }) };
    safe.implementation.render.call(self, valid as never, editor as never);
    assert.equal(calls[1]!.block, valid);
  });

  test('safeBlockProps', () => {
    const valid = props({ level: 2, textAlignment: 'center' });
    assert.equal(safeBlockProps(valid, propSchema), valid); // unchanged → same object
    assert.deepEqual(safeBlockProps(props({ textAlignment: 'evil', textColor: { a: 1 }, isToggleable: 'yes' }), propSchema), props({}));
    assert.deepEqual(safeBlockProps({ level: undefined }, propSchema), { level: undefined }); // BlockNote applies defaults
    assert.deepEqual(safeBlockProps({ level: 2, unknownProp: { x: 1 } }, propSchema), { level: 2, unknownProp: { x: 1 } });
    assert.deepEqual(safeBlockProps({ width: Infinity, n: 'x' }, { width: { default: 1 }, n: { default: 0 } }), { width: 1, n: 0 });
  });
});

/** Tag of the heading inside the <details><summary> of an exported toggle heading. */
const exportToggleHeading = (spec: typeof heading, blockProps: Record<string, unknown>) =>
  withFakeDocument(() => {
    const out = (spec.implementation.toExternalHTML as (...args: unknown[]) => { dom: FakeElement } | undefined).call(
      { blockContentDOMAttributes: {} },
      { id: 'b1', type: 'heading', props: blockProps, content: [], children: [] },
      {},
      {},
    );
    const details = out!.dom.children[0] as FakeElement;
    const summary = details.children[0] as FakeElement;
    return { outer: details.tagName, heading: (summary.children[0] as FakeElement).tagName };
  });

describe('QA-WEB-08 (reste) : Titre dépliable 1–4 and table of contents', () => {
  test('toggle headings go through the same safe props (level 1–4, isToggleable boolean)', () => {
    const safe = withSafeProps(heading);
    assert.deepEqual(exportToggleHeading(safe, props({ level: 4, isToggleable: true })), { outer: 'DETAILS', heading: 'H4' });
    for (const level of ['4 onclick=alert(1)', { x: 1 }, 5, 6, 0, NaN, '<script>']) {
      assert.deepEqual(exportToggleHeading(safe, props({ level, isToggleable: true })), { outer: 'DETAILS', heading: 'H1' }, JSON.stringify(level));
    }
    // The bug, for toggle headings too.
    assert.throws(() => exportToggleHeading(heading, props({ level: '2 x', isToggleable: true })), { name: 'InvalidCharacterError' });
    // A forged isToggleable falls back to a plain heading.
    assert.equal(exportHeading(safe, props({ level: 3, isToggleable: 'yes' })), 'H3');
  });

  test('table of contents: any stored level is listed at 1–4', () => {
    assert.equal(tocHeadingLevel(1), 1);
    assert.equal(tocHeadingLevel(3), 3);
    assert.equal(tocHeadingLevel('2'), 2);
    assert.equal(tocHeadingLevel(' 4 '), 4);
    for (const [raw, level] of [
      [5, 4],
      [6, 4],
      [Infinity, 4],
      [1e300, 4],
      [0, 1],
      [-3, 1],
      [-Infinity, 1],
      [NaN, 1],
      ['1 onclick=alert(1)', 1],
      [null, 1],
      [undefined, 1],
      [{ x: 1 }, 1],
      [[3], 1],
      [true, 1],
      [2.4, 2],
    ] as const) {
      assert.equal(tocHeadingLevel(raw), level, String(raw));
    }
  });
});
