// Embedded Oriel server for the local mode, run in an Electron utility process.
//
// Contract (ARCHITECTURE §3.1 / §5): the bundle server.cjs listens on HOST:PORT (PORT=0 → any free
// port) and posts { type: 'ready', port } to process.parentPort once listening.
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { checkHealth } from './health';
import { paths } from './paths';

const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const KEPT_LINES = 300;

/** Environment variables of the desktop process that must not leak into the embedded server. */
const STRIPPED_ENV = new Set([
  'PORT',
  'HOST',
  'DATA_DIR',
  'WEB_DIST',
  'PUBLIC_URL',
  'SIGNUP_MODE',
  'TRUST_PROXY',
  'ORIEL_LOCAL_MODE',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

export type LocalServerFailure = 'missing' | 'exit' | 'timeout';

export class LocalServerError extends Error {
  constructor(
    message: string,
    readonly kind: LocalServerFailure,
    readonly logExcerpt: string,
  ) {
    super(message);
    this.name = 'LocalServerError';
  }
}

export class LocalServer extends EventEmitter<{ crash: [code: number] }> {
  private child: UtilityProcess | null = null;
  private exited: Promise<number> | null = null;
  private stopping = false;
  private lines: string[] = [];
  private partial = new Map<NodeJS.ReadableStream, string>();
  private logStream: fs.WriteStream | null = null;
  private onListeningLine: ((port: number) => void) | null = null;

  /** Port once the server reported it is listening. */
  port: number | null = null;

  /** Listening and ready to serve. */
  get isRunning(): boolean {
    return this.child !== null && this.port !== null;
  }

  /** A process exists (starting or running). */
  get isAlive(): boolean {
    return this.child !== null;
  }

  /** Last lines of the server output, made readable for a dialog. */
  logExcerpt(count = 20): string {
    return this.lines.slice(-count).map(prettifyLogLine).join('\n');
  }

  /** Starts the server; resolves with the listening port. */
  async start(preferredPort?: number): Promise<number> {
    if (this.isRunning && this.port) return this.port;
    if (this.child) throw new Error('Le serveur local est déjà en cours de démarrage.');

    const entry = paths.serverEntry;
    if (!fs.existsSync(entry)) {
      throw new LocalServerError(
        `Le serveur intégré est introuvable :\n${entry}` +
          (app.isPackaged ? '' : '\n\nEn développement, construisez-le d’abord : npm run build -w server'),
        'missing',
        '',
      );
    }
    fs.mkdirSync(paths.dataDir, { recursive: true });
    this.openLog();

    const first = preferredPort && (await isPortFree(preferredPort)) ? preferredPort : 0;
    try {
      return await this.spawn(entry, first);
    } catch (err) {
      // Someone grabbed the preferred port between our check and the server's listen(): use any port.
      if (first !== 0 && err instanceof LocalServerError && err.kind === 'exit') {
        this.append(`[oriel-desktop] le port ${first} est indisponible, nouvel essai sur un port libre`);
        return this.spawn(entry, 0);
      }
      throw err;
    }
  }

  /** Graceful stop (SIGTERM), then SIGKILL if the server does not exit in time. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) return;
    this.stopping = true;
    const exited = this.exited;
    child.kill();
    const done = await Promise.race([exited.then(() => true), delay(STOP_TIMEOUT_MS).then(() => false)]);
    if (!done && child.pid) {
      this.append('[oriel-desktop] arrêt forcé du serveur local');
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await Promise.race([exited, delay(1000)]);
    }
    if (this.child === child) {
      this.child = null;
      this.port = null;
    }
    this.closeLog();
  }

  private spawn(entry: string, port: number): Promise<number> {
    this.append(`[oriel-desktop] démarrage du serveur local (${new Date().toISOString()}, port ${port || 'auto'})`);
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'Oriel Server',
      stdio: 'pipe',
      cwd: paths.dataDir,
      env: this.serverEnv(port),
    });
    this.child = child;
    this.port = null;
    this.stopping = false;
    this.exited = new Promise<number>((resolve) => child.once('exit', resolve));
    if (child.stdout) this.pipe(child.stdout);
    if (child.stderr) this.pipe(child.stderr);

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const settle = (error: LocalServerError | null, readyPort?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('message', onMessage);
        this.onListeningLine = null;
        if (error) {
          reject(error);
        } else {
          this.port = readyPort!;
          this.append(`[oriel-desktop] serveur local prêt sur http://127.0.0.1:${readyPort}`);
          resolve(readyPort!);
        }
      };

      const onMessage = (message: unknown) => {
        const m = message as { type?: unknown; port?: unknown } | null;
        if (m && m.type === 'ready' && Number.isInteger(m.port) && (m.port as number) > 0) settle(null, m.port as number);
      };
      child.on('message', onMessage);

      // Fallback when the ready message is missing: the server logged its address; confirm with /api/health.
      this.onListeningLine = (p) => {
        void checkHealth(`http://127.0.0.1:${p}`, 3000).then((r) => {
          if (r.ok && this.child === child) settle(null, p);
        });
      };

      const timer = setTimeout(() => {
        settle(
          new LocalServerError(
            `Le serveur local n’a pas signalé son démarrage en ${READY_TIMEOUT_MS / 1000} secondes.`,
            'timeout',
            this.logExcerpt(),
          ),
        );
        child.kill();
      }, READY_TIMEOUT_MS);

      child.once('exit', (code) => {
        const wasReady = settled && this.port !== null && this.child === child;
        if (this.child === child) {
          this.child = null;
          this.port = null;
        }
        this.append(`[oriel-desktop] serveur local arrêté (code ${code})`);
        if (!settled) {
          settle(
            new LocalServerError(`Le serveur local s’est arrêté pendant son démarrage (code ${code}).`, 'exit', this.logExcerpt()),
          );
        } else if (wasReady && !this.stopping) {
          this.emit('crash', code);
        }
      });
    });
  }

  private serverEnv(port: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !STRIPPED_ENV.has(key)) env[key] = value;
    }
    return {
      ...env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: paths.dataDir,
      WEB_DIST: paths.webDist,
      ORIEL_LOCAL_MODE: '1',
      TRUST_PROXY: 'false',
      LOG_LEVEL: env.LOG_LEVEL ?? 'info',
    };
  }

  private pipe(stream: NodeJS.ReadableStream): void {
    stream.on('data', (chunk: Buffer | string) => {
      const text = (this.partial.get(stream) ?? '') + chunk.toString();
      const parts = text.split(/\r?\n/);
      this.partial.set(stream, parts.pop() ?? '');
      for (const line of parts) if (line.trim()) this.append(line);
    });
  }

  private append(line: string): void {
    this.lines.push(line);
    if (this.lines.length > KEPT_LINES) this.lines.splice(0, this.lines.length - KEPT_LINES);
    this.logStream?.write(`${line}\n`);
    if (!app.isPackaged) console.log(`[server] ${line}`);
    const listening = /listening (?:at|on) https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i.exec(line);
    if (listening && this.onListeningLine) this.onListeningLine(Number(listening[1]));
  }

  private openLog(): void {
    if (this.logStream) return;
    try {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      const file = paths.serverLog;
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.renameSync(file, path.join(paths.logsDir, 'server.1.log'));
      }
      this.logStream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      this.logStream.on('error', () => {
        this.logStream = null;
      });
    } catch {
      this.logStream = null;
    }
  }

  private closeLog(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'avert.', 50: 'erreur', 60: 'fatal' };

/** JSON log lines (pino) → "12:03:04 erreur message — détail"; other lines unchanged. */
function prettifyLogLine(line: string): string {
  if (!line.startsWith('{')) return line;
  try {
    const entry = JSON.parse(line) as { level?: number; time?: number; msg?: string; err?: { message?: string } };
    const time = entry.time ? new Date(entry.time).toLocaleTimeString('fr-FR') : '';
    const level = (entry.level && LEVELS[entry.level]) || '';
    const detail = entry.err?.message ? ` — ${entry.err.message}` : '';
    return `${time} ${level} ${entry.msg ?? ''}${detail}`.trim();
  } catch {
    return line;
  }
}
