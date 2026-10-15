// Main-thread side of the Typst preview: one lazily created worker (typstWorker.ts), one compilation at
// a time, a hard time limit (the worker is terminated and recreated), bounded output. The SVG it
// returns is NOT trusted: diagramRenderers.ts passes it through sanitizeSvg.
import { TYPST_MAX_SVG_LENGTH, TYPST_TIMEOUT_MS } from '@oriel/shared';
import type { TypstRequest, TypstResponse } from './typstWorker';

export type TypstResult = { ok: true; svg: string } | { ok: false; error: string };

let worker: Worker | null = null;
let nextId = 0;
let chain: Promise<unknown> = Promise.resolve();

function stop() {
  worker?.terminate();
  worker = null;
}

/** French explanation for the engine's English diagnostics that are about missing resources. */
export function typstErrorMessage(message: string): string {
  if (/package|@preview|@local/i.test(message)) return 'Les paquets Typst ne sont pas disponibles (aucun accès au réseau) : seul Typst de base peut être utilisé.';
  if (/file not found|failed to load|access denied|not found/i.test(message) && /image|read|csv|json|yaml|xml|file/i.test(message)) {
    return 'Les fichiers externes ne sont pas disponibles : un bloc Typst ne peut utiliser ni image ni fichier.';
  }
  return message;
}

function run(source: string): Promise<TypstResult> {
  return new Promise((resolve) => {
    let w: Worker;
    try {
      w = worker ??= new Worker(new URL('./typstWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve({ ok: false, error: 'Le moteur Typst n’a pas pu démarrer dans ce navigateur.' });
      return;
    }
    const id = ++nextId;
    let settled = false;
    const finish = (result: TypstResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      resolve(result);
    };
    // First use also downloads the engine (~28 Mo) and the fonts: the limit starts at the first answer
    // of a warm worker, so the cold start gets a longer one.
    const timer = setTimeout(() => {
      if (worker === w) stop();
      finish({ ok: false, error: `La compilation a dépassé ${Math.round(TYPST_TIMEOUT_MS / 1000)} secondes : le document est trop complexe pour l’aperçu.` });
    }, TYPST_TIMEOUT_MS + (warm ? 0 : 30_000));
    const onMessage = (event: MessageEvent<TypstResponse>) => {
      const data = event.data;
      if (!data || data.id !== id) return;
      warm = true;
      if (!data.ok) finish({ ok: false, error: typstErrorMessage(data.error) });
      else if (typeof data.svg !== 'string' || data.svg.length > TYPST_MAX_SVG_LENGTH) {
        finish({ ok: false, error: 'Le résultat est trop volumineux pour être affiché (3 Mo au plus).' });
      } else finish({ ok: true, svg: data.svg });
    };
    const onError = () => {
      if (worker === w) stop();
      finish({ ok: false, error: 'Le moteur Typst n’a pas pu démarrer (chargement interrompu).' });
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, source } satisfies TypstRequest);
  });
}

let warm = false;

/** Compiles a Typst source to one SVG (pages stacked). Calls are serialized. */
export function compileTypst(source: string): Promise<TypstResult> {
  const result = chain.then(
    () => run(source),
    () => run(source),
  );
  chain = result.catch(() => undefined);
  return result;
}
