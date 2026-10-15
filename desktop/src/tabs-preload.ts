// Preload of the tab bar page (local file, one per app window). Sandboxed, context-isolated.
// The main process re-checks the sender (that window's tab bar) and every argument.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type TabsState } from './ipc';

contextBridge.exposeInMainWorld(
  'orielTabs',
  Object.freeze({
    get: (): Promise<TabsState> => ipcRenderer.invoke(IPC.tabsGet),
    onState: (callback: (state: TabsState) => void): void => {
      ipcRenderer.on(IPC.tabsState, (_event, state: TabsState) => callback(state));
    },
    select: (id: string): void => ipcRenderer.send(IPC.tabsSelect, String(id)),
    close: (id: string): void => ipcRenderer.send(IPC.tabsClose, String(id)),
    newTab: (): void => ipcRenderer.send(IPC.tabsNew),
    move: (id: string, index: number): void => ipcRenderer.send(IPC.tabsMove, String(id), Number(index)),
    detach: (id: string, screenX: number, screenY: number): void =>
      ipcRenderer.send(IPC.tabsDetach, String(id), Number(screenX), Number(screenY)),
    menu: (id: string): void => ipcRenderer.send(IPC.tabsMenu, String(id)),
  }),
);
