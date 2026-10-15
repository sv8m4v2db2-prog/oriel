// File locations. Once bundled, this code runs from desktop/dist/main.cjs (or app.asar/dist/main.cjs
// when packaged), so __dirname is the dist folder that also holds the preloads and local pages.
import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';

export const paths = {
  preload: path.join(__dirname, 'preload.cjs'),
  setupPreload: path.join(__dirname, 'setup-preload.cjs'),
  setupPage: path.join(__dirname, 'setup.html'),
  statusPage: path.join(__dirname, 'offline.html'),
  tabsPreload: path.join(__dirname, 'tabs-preload.cjs'),
  tabsPage: path.join(__dirname, 'tabs.html'),
  quickPreload: path.join(__dirname, 'quick-preload.cjs'),
  quickPage: path.join(__dirname, 'quick.html'),

  /** Embedded server bundle (local mode). */
  get serverEntry(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'server', 'server.cjs')
      : path.resolve(__dirname, '../../server/dist/server.cjs');
  },
  /** Built web client served by the embedded server. */
  get webDist(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '../../web/dist');
  },
  /** SQLite database + uploads of the local mode. */
  get dataDir(): string {
    return path.join(app.getPath('userData'), 'data');
  },
  get logsDir(): string {
    return app.getPath('logs');
  },
  get serverLog(): string {
    return path.join(app.getPath('logs'), 'server.log');
  },
};

/** "/Users/me/Library/…" → "~/Library/…" for display. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
