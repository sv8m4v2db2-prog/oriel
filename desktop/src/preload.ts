// Preload of the app windows (sandboxed, context-isolated).
//
// • On Oriel pages: exposes `window.orielDesktop` exactly as specified in ARCHITECTURE §4:
//     { platform: 'darwin', isDesktop: true, mode: 'remote' | 'local', openSetup(): void,
//       hasTabs, setBadge(n), getPrefs(), setPrefs(patch) }
//   The main process re-validates the sender (frame URL = configured server) and every argument.
// • On the local status page (file://, "serveur injoignable" / "démarrage…"): also exposes
//   `window.orielStatus` used by that page's buttons.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopMode, type DesktopPrefs, type PrefsResult, type RetryResult, type StatusInfo } from './ipc';

// The main process passes the mode with BrowserWindow `additionalArguments`.
const modeArg = process.argv.find((arg) => arg.startsWith('--oriel-mode='));
const mode: DesktopMode = modeArg?.slice('--oriel-mode='.length) === 'local' ? 'local' : 'remote';

const desktopBridge = Object.freeze({
    platform: 'darwin' as const,
    isDesktop: true as const,
    mode,
    openSetup: (): void => ipcRenderer.send(IPC.openSetup),
    hasTabs: true as const,
    /** Unread notifications for the Dock icon (integer 0…99999, 0 clears the badge). */
    setBadge: (count: number): void => ipcRenderer.send(IPC.badgeSet, Number(count)),
    getPrefs: (): Promise<DesktopPrefs> => ipcRenderer.invoke(IPC.prefsGet),
    setPrefs: (patch: Partial<DesktopPrefs>): Promise<PrefsResult> => ipcRenderer.invoke(IPC.prefsSet, patch),
});

contextBridge.exposeInMainWorld('orielDesktop', desktopBridge);

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld(
    'orielStatus',
    Object.freeze({
      get: (): Promise<StatusInfo | null> => ipcRenderer.invoke(IPC.statusGet),
      retry: (): Promise<RetryResult> => ipcRenderer.invoke(IPC.statusRetry),
      changeServer: (): void => ipcRenderer.send(IPC.statusChangeServer),
    }),
  );
}
