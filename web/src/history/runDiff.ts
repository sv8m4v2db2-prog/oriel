// Version history (G6): runs the comparison in a Web Worker for large pages, inline otherwise.
import { compareStates, type DiffOutcome } from './diff';

/** Above this size (base64 characters of both states), the comparison leaves the main thread. */
const WORKER_THRESHOLD = 120_000;

export function runDiff(older: string, newer: string): Promise<DiffOutcome> {
  if (older.length + newer.length < WORKER_THRESHOLD || typeof Worker === 'undefined') {
    return Promise.resolve(compareStates(older, newer));
  }
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(compareStates(older, newer));
      return;
    }
    worker.onmessage = (e: MessageEvent<DiffOutcome>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(compareStates(older, newer));
    };
    worker.postMessage({ older, newer });
  });
}
