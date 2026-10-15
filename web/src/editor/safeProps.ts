// QA-WEB-08 (native blocks) — block props come from the shared Yjs document, where any editor can
// store any value: BlockNote does not enforce its propSchema (`values`, types) on attributes read
// from Yjs. The native heading renders `document.createElement(`h${level}`)`: a forged level
// ("1 x", {}, null…) throws InvalidCharacterError and takes the page editor down for every reader,
// anonymous visitors of a published page included. Native blocks are rendered from props made
// valid for their propSchema; the stored document is left untouched.

interface PropSpec {
  default?: unknown;
  values?: readonly unknown[];
  type?: string;
  optional?: boolean;
}

function safeProp(value: unknown, spec: PropSpec): unknown {
  if (value === undefined) return value; // BlockNote applies the default itself
  if (spec.values) {
    if (spec.values.includes(value)) return value;
    // "2" for 2 (a level typed as text): same value, another type.
    if (typeof value === 'string' || typeof value === 'number') {
      const same = spec.values.find((v) => String(v) === String(value).trim());
      if (same !== undefined) return same;
    }
    return spec.default;
  }
  const type = spec.type ?? (spec.default === undefined ? undefined : typeof spec.default);
  if (type === 'string' || type === 'number' || type === 'boolean') {
    if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) return spec.default;
  }
  return value;
}

/** `props` with every value of `propSchema` valid (out-of-list or ill-typed → default); same object when nothing changes. */
export function safeBlockProps<P extends Record<string, unknown>>(props: P, propSchema: Record<string, PropSpec>): P {
  let out: Record<string, unknown> | null = null;
  for (const [name, spec] of Object.entries(propSchema)) {
    const value = props[name];
    const safe = safeProp(value, spec);
    if (safe !== value) (out ??= { ...props })[name] = safe;
  }
  return (out ?? props) as P;
}

type Renderer = (this: unknown, block: never, ...rest: never[]) => unknown;

/**
 * Block spec whose render / toExternalHTML (HTML export, copy, Markdown export) receive a block with
 * safe props. Same wrapping as tolerantCodeBlock (schema.ts): `this` is forwarded.
 */
export function withSafeProps<S extends { config: { propSchema: object }; implementation: Record<string, any> }>(spec: S): S {
  const propSchema = spec.config.propSchema as Record<string, PropSpec>;
  const { render, toExternalHTML } = spec.implementation as { render: Renderer; toExternalHTML?: Renderer };
  const safe = <B extends { props: Record<string, unknown> }>(block: B): B => {
    const props = safeBlockProps(block.props ?? {}, propSchema);
    return props === block.props ? block : { ...block, props };
  };
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      render(this: unknown, block: { props: Record<string, unknown> }, ...rest: never[]) {
        return render.call(this, safe(block) as never, ...rest);
      },
      ...(toExternalHTML
        ? {
            toExternalHTML(this: unknown, block: { props: Record<string, unknown> }, ...rest: never[]) {
              return toExternalHTML.call(this, safe(block) as never, ...rest);
            },
          }
        : {}),
    },
  };
}

/**
 * Level of a heading as listed by the table of contents (TocBlock): the stored value is any value of
 * the shared document, clamped to the schema's levels 1–4.
 */
export function tocHeadingLevel(raw: unknown): 1 | 2 | 3 | 4 {
  const n = typeof raw === 'number' || typeof raw === 'string' ? Math.round(Number(raw)) : NaN;
  return n === 2 || n === 3 || n === 4 ? n : n > 4 ? 4 : 1;
}
