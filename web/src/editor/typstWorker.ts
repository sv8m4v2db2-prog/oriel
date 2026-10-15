/// <reference lib="webworker" />
// Typst compilation (typst.ts, WebAssembly) in a dedicated Web Worker: the page never blocks, and the
// caller can terminate this worker when a document takes too long (typstRender.ts). Nothing here can
// reach the network: the access model is in-memory and the package registry resolves nothing, so
// `#import "@preview/…"`, `image("https://…")` and `read(…)` fail with a compile error.
import { $typst, MemoryAccessModel } from '@myriaddreamin/typst.ts';
import { TypstSnippet } from '@myriaddreamin/typst.ts/contrib/snippet';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';
import libertinus from '@typst-wasm/fonts/LibertinusSerif-Regular.otf?url';
import libertinusBold from '@typst-wasm/fonts/LibertinusSerif-Bold.otf?url';
import libertinusItalic from '@typst-wasm/fonts/LibertinusSerif-Italic.otf?url';
import libertinusBoldItalic from '@typst-wasm/fonts/LibertinusSerif-BoldItalic.otf?url';
import newCmMath from '@typst-wasm/fonts/NewCMMath-Regular.otf?url';
import newCm from '@typst-wasm/fonts/NewCM10-Regular.otf?url';
import dejaVuMono from '@typst-wasm/fonts/DejaVuSansMono.ttf?url';
import dejaVuMonoBold from '@typst-wasm/fonts/DejaVuSansMono-Bold.ttf?url';

export interface TypstRequest {
  id: number;
  source: string;
}
export type TypstResponse = { id: number; ok: true; svg: string } | { id: number; ok: false; error: string };

const FONT_URLS = [libertinus, libertinusBold, libertinusItalic, libertinusBoldItalic, newCmMath, newCm, dejaVuMono, dejaVuMonoBold];
const MAIN = '/tmp/oriel-main.typ';
/**
 * Default page of a preview: a fixed width and the height of the content (the default A4 page would show
 * a mostly empty sheet). Written before the user's source, so that their own `#set page(…)` wins.
 */
const PREAMBLE = '#set page(width: 16cm, height: auto, margin: 10pt)\n';

let ready: Promise<void> | null = null;

function init(): Promise<void> {
  ready ??= (async () => {
    const fonts = await Promise.all(
      FONT_URLS.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error('police Typst introuvable');
        return new Uint8Array(await res.arrayBuffer());
      }),
    );
    $typst.setCompilerInitOptions({ getModule: () => compilerWasm, beforeBuild: [] });
    $typst.setRendererInitOptions({ getModule: () => rendererWasm, beforeBuild: [] });
    $typst.use(
      TypstSnippet.withAccessModel(new MemoryAccessModel()),
      TypstSnippet.withPackageRegistry({ resolve: () => undefined }),
      TypstSnippet.disableDefaultFontAssets(),
      TypstSnippet.preloadFonts(fonts),
    );
  })();
  return ready;
}

interface Diagnostic {
  severity?: string;
  message?: string;
  range?: string;
  path?: string;
}

function describe(diagnostics: unknown): string {
  const list = Array.isArray(diagnostics) ? (diagnostics as Array<Diagnostic | string>) : [];
  const errors = list.filter((d) => typeof d === 'string' || !d.severity || d.severity === 'error');
  const first = errors[0] ?? list[0];
  if (!first) return 'Le document Typst contient une erreur.';
  if (typeof first === 'string') return first.slice(0, 400);
  const line = /^(\d+):/.exec(first.range ?? '');
  // The preamble is one line: positions are given back relative to the user's source.
  const at = line ? Math.max(1, Number(line[1]) - 1) : 0;
  return `${at ? `Ligne ${at} : ` : ''}${String(first.message ?? 'erreur').slice(0, 400)}`;
}

async function compile(source: string): Promise<string> {
  await init();
  await $typst.addSource(MAIN, PREAMBLE + source);
  const compiler = await $typst.getCompiler();
  const result = (await compiler.compile({ mainFilePath: MAIN, diagnostics: 'full' } as never)) as unknown as { result?: Uint8Array; diagnostics?: unknown };
  if (!result.result) throw new Error(describe(result.diagnostics));
  return $typst.svg({ vectorData: result.result });
}

self.onmessage = (event: MessageEvent<TypstRequest>) => {
  const { id, source } = event.data;
  compile(String(source))
    .then((svg) => self.postMessage({ id, ok: true, svg } satisfies TypstResponse))
    .catch((e: unknown) => self.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies TypstResponse));
};
