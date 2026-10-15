// CLI entry point. In the CJS bundle (dist/server.cjs) this module:
//  - starts the server when executed directly (`node server.cjs`, Electron utilityProcess.fork);
//  - only exports `startServer` when require()d.
import './util/warnings.js';
import { startServer, type RunningServer, type ServerOptions } from './app.js';

export { startServer };
export type { RunningServer, ServerOptions };

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data?: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function isMainModule(): boolean {
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main !== undefined) {
    return require.main === module;
  }
  // ESM (tsx in development): started as `tsx src/index.ts`.
  const entry = process.argv[1] ?? '';
  return /[\\/]src[\\/]index\.(ts|js|mjs)$/.test(entry);
}

async function main(): Promise<void> {
  let server: RunningServer;
  try {
    server = await startServer();
  } catch (err) {
    console.error('[oriel] impossible de démarrer le serveur :', err);
    process.exit(1);
  }
  parentPort?.postMessage({ type: 'ready', port: server.port });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await server.close();
    } catch (err) {
      console.error(`[oriel] erreur pendant l'arrêt (${signal}) :`, err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  parentPort?.on('message', (event) => {
    const data = (event?.data ?? event) as { type?: string } | undefined;
    if (data?.type === 'shutdown') void stop('shutdown');
  });
}

if (isMainModule() || parentPort) void main();
