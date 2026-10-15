// Native downloads: save dialog, Dock progress, Finder. Only files served by the configured
// Oriel instance (and `blob:` URLs created by its pages) are accepted; everything else is cancelled.
import { app, BrowserWindow, Notification, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { isDownloadAllowed, safeFileName } from './urls';

export interface DownloadHooks {
  serverOrigin(): string | null;
  /** The app window that owns `contents`, or null when the contents is not one of ours. */
  windowFor(contents: WebContents): BrowserWindow | null;
  /** Reports a refused download to the user (non-blocking). */
  refused(url: string): void;
  /** A download finished and was saved (the menu entry « Dernier téléchargement » becomes available). */
  finished(): void;
}

interface Progress {
  received: number;
  total: number;
}

export class Downloads {
  private readonly active = new Map<object, Progress>();
  lastFile: string | null = null;

  constructor(private readonly hooks: DownloadHooks) {}

  attach(ses: Session): void {
    ses.on('will-download', (event, item, contents) => {
      const chain = item.getURLChain();
      const win = this.hooks.windowFor(contents);
      if (!win || !isDownloadAllowed(chain, this.hooks.serverOrigin())) {
        event.preventDefault();
        this.hooks.refused(chain[0] ?? item.getURL());
        return;
      }
      const filename = safeFileName(item.getFilename());
      // The native save sheet opens (no savePath set), proposing the Downloads folder.
      item.setSaveDialogOptions({
        title: 'Enregistrer le fichier',
        defaultPath: path.join(app.getPath('downloads'), filename),
        buttonLabel: 'Enregistrer',
      });

      const progress: Progress = { received: 0, total: item.getTotalBytes() };
      this.active.set(item, progress);
      item.on('updated', (_e, state) => {
        if (state === 'interrupted') return;
        progress.received = item.getReceivedBytes();
        progress.total = item.getTotalBytes();
        this.paint(win);
      });
      item.once('done', (_e, state) => {
        this.active.delete(item);
        this.paint(win);
        if (state !== 'completed') return;
        const file = item.getSavePath();
        if (!file) return;
        this.lastFile = file;
        this.hooks.finished();
        app.dock?.downloadFinished(file);
        if (Notification.isSupported()) {
          const note = new Notification({
            title: 'Téléchargement terminé',
            body: `${path.basename(file)} — cliquez pour l’afficher dans le Finder.`,
            silent: true,
          });
          note.on('click', () => shell.showItemInFolder(file));
          note.show();
        }
      });
    });
  }

  revealLast(): void {
    if (this.lastFile) shell.showItemInFolder(this.lastFile);
  }

  /** Dock icon progress, aggregated over concurrent downloads (indeterminate when sizes are unknown). */
  private paint(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    if (this.active.size === 0) {
      win.setProgressBar(-1);
      return;
    }
    let received = 0;
    let total = 0;
    for (const p of this.active.values()) {
      received += p.received;
      if (p.total <= 0) {
        win.setProgressBar(2); // > 1 = indeterminate
        return;
      }
      total += p.total;
    }
    win.setProgressBar(Math.min(1, received / total));
  }
}
