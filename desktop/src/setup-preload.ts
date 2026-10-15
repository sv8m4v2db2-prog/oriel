// Preload of the setup window (server / local mode chooser). Sandboxed, context-isolated.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ActionResult, type SetupState, type TestResult } from './ipc';

contextBridge.exposeInMainWorld(
  'orielSetup',
  Object.freeze({
    state: (): Promise<SetupState> => ipcRenderer.invoke(IPC.setupState),
    test: (url: string): Promise<TestResult> => ipcRenderer.invoke(IPC.setupTest, String(url)),
    connect: (url: string): Promise<ActionResult> => ipcRenderer.invoke(IPC.setupConnect, String(url)),
    useLocal: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.setupUseLocal),
    cancel: (): void => ipcRenderer.send(IPC.setupCancel),
  }),
);
