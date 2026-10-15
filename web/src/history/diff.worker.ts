// Version history (G6): comparison off the main thread (see runDiff.ts).
import { compareStates } from './diff';

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ older: string; newer: string }>) => void) | null; postMessage(v: unknown): void };
scope.onmessage = (e) => {
  scope.postMessage(compareStates(e.data.older, e.data.newer));
};
