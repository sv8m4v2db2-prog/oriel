// Preload of the quick search window (local file). Sandboxed, context-isolated.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type QuickOpenReply, type QuickSearchReply } from './ipc';

contextBridge.exposeInMainWorld(
  'orielQuick',
  Object.freeze({
    search: (query: string): Promise<QuickSearchReply> => ipcRenderer.invoke(IPC.quickSearch, String(query)),
    open: (workspaceId: string, pageId: string): Promise<QuickOpenReply> =>
      ipcRenderer.invoke(IPC.quickOpen, String(workspaceId), String(pageId)),
    create: (workspaceId: string, title: string): Promise<QuickOpenReply> =>
      ipcRenderer.invoke(IPC.quickCreate, String(workspaceId), String(title)),
    close: (): void => ipcRenderer.send(IPC.quickClose),
    onReset: (callback: () => void): void => {
      ipcRenderer.on(IPC.quickReset, () => callback());
    },
  }),
);
