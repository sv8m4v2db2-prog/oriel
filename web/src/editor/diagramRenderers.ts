// Mermaid, abcjs and Typst, loaded on demand. Their output is NEVER inserted as is: it goes through
// sanitizeSvg (svgSanitize.ts) and is shown in a Shadow DOM by codeRender.ts.
import { CODE_RENDER_MAX_LENGTH } from '@oriel/shared';
import { sanitizeSvg } from './svgSanitize';
import type { CodeRenderKind } from './codeRenderLogic';

export type DiagramResult = { ok: true; svgs: string[] } | { ok: false; error: string };

let counter = 0;
// Mermaid keeps global state (initialize / render): one render at a time.
let queue: Promise<unknown> = Promise.resolve();

function firstLines(message: string, max = 4): string {
  return message
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i) => l !== '' || i === 0)
    .slice(0, max)
    .join('\n')
    .slice(0, 400);
}

async function renderMermaid(source: string, dark: boolean): Promise<DiagramResult> {
  const mermaid = (await import('mermaid')).default;
  // strict: no HTML in labels, no click handlers; `secure` (default list) forbids `%%{init}` directives
  // from changing securityLevel, maxTextSize, maxEdges, startOnLoad.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: CODE_RENDER_MAX_LENGTH,
    maxEdges: 300,
    suppressErrorRendering: true,
    logLevel: 'fatal',
    fontFamily: 'inherit',
  } as never);
  const id = `ormmd${++counter}`;
  try {
    await mermaid.parse(source);
    const { svg } = await mermaid.render(id, source);
    const safe = sanitizeSvg(svg);
    return safe ? { ok: true, svgs: [safe] } : { ok: false, error: 'Le diagramme n’a pas pu être affiché.' };
  } catch (e) {
    return { ok: false, error: firstLines(e instanceof Error ? e.message : String(e)) };
  } finally {
    // A failed render may leave its temporary container in <body>.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

async function renderAbc(source: string): Promise<DiagramResult> {
  const abcjs = (await import('abcjs')).default ?? (await import('abcjs'));
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:720px;visibility:hidden;pointer-events:none';
  document.body.appendChild(holder);
  try {
    const tunes = abcjs.renderAbc(holder, source, { add_classes: false, staffwidth: 700, paddingleft: 8, paddingright: 8 });
    const warnings = (tunes?.[0] as { warnings?: string[] } | undefined)?.warnings ?? [];
    const svgs = Array.from(holder.querySelectorAll('svg'))
      .map((el) => {
        // Fixed size from abcjs: keep the proportions with a viewBox so that CSS can scale it.
        if (!el.getAttribute('viewBox')) {
          const w = parseFloat(el.getAttribute('width') ?? '');
          const h = parseFloat(el.getAttribute('height') ?? '');
          if (w > 0 && h > 0) el.setAttribute('viewBox', `0 0 ${w} ${h}`);
        }
        return sanitizeSvg(el.outerHTML);
      })
      .filter((s): s is string => !!s);
    if (svgs.length === 0) {
      const detail = warnings.length ? `\n${warnings.slice(0, 3).map((w) => w.replace(/<[^>]*>/g, '')).join('\n')}` : '';
      return { ok: false, error: `Aucune partition à afficher.${detail}` };
    }
    return { ok: true, svgs };
  } catch (e) {
    return { ok: false, error: firstLines(e instanceof Error ? e.message : String(e)) };
  } finally {
    holder.remove();
  }
}

/** Typst compiles in its own worker (typstRender.ts), outside the Mermaid queue below. */
async function renderTypst(source: string): Promise<DiagramResult> {
  const { compileTypst } = await import('./typstRender');
  const compiled = await compileTypst(source);
  if (!compiled.ok) return { ok: false, error: firstLines(compiled.error) };
  const safe = sanitizeSvg(compiled.svg);
  return safe ? { ok: true, svgs: [safe] } : { ok: false, error: 'Le document n’a pas pu être affiché.' };
}

export function renderDiagram(kind: CodeRenderKind, source: string, dark: boolean): Promise<DiagramResult> {
  if (kind === 'typst') return renderTypst(source).catch((e) => ({ ok: false as const, error: firstLines(e instanceof Error ? e.message : String(e)) }));
  const run = () => (kind === 'mermaid' ? renderMermaid(source, dark) : renderAbc(source));
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result.catch((e) => ({ ok: false as const, error: firstLines(e instanceof Error ? e.message : String(e)) }));
}
