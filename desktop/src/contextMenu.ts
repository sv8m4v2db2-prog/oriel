// Native right-click menu (Electron has none by default): spelling, definition, clipboard, links, images.
import { clipboard, Menu, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { isExternalScheme } from './urls';

export interface SpellHooks {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /**
   * Dictionary choice. Only provided where it has an effect (Windows, Linux): on macOS the system
   * spell checker detects the language by itself and `setSpellCheckerLanguages` is ignored.
   */
  languages?: { current(): string[]; available(): string[]; set(languages: string[]): void };
}

export interface ContextMenuHooks {
  /** True when the URL belongs to the Oriel server shown in the window. */
  isAppUrl(url: string): boolean;
  openInNewWindow(url: string): void;
  openInNewTab?(url: string): void;
  openExternal(url: string): void;
  spell?: SpellHooks;
}

/** `getWindow` is evaluated on each popup: a tab can move to another window. */
export function attachContextMenu(
  contents: WebContents,
  getWindow: () => BrowserWindow | null,
  hooks: ContextMenuHooks,
): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    const section = (entries: MenuItemConstructorOptions[]) => {
      if (entries.length === 0) return;
      if (items.length > 0) items.push({ type: 'separator' });
      items.push(...entries);
    };
    const spell = hooks.spell;

    if (spell && params.isEditable && params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      section([
        ...(suggestions.length > 0
          ? suggestions.map((word): MenuItemConstructorOptions => ({
              label: word,
              click: () => contents.replaceMisspelling(word),
            }))
          : [{ label: 'Aucune suggestion', enabled: false }]),
        {
          label: 'Ajouter au dictionnaire',
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
      ]);
    }

    if (params.linkURL && isExternalScheme(params.linkURL)) {
      const internal = hooks.isAppUrl(params.linkURL);
      const entries: MenuItemConstructorOptions[] = [];
      if (internal) {
        if (hooks.openInNewTab) {
          entries.push({ label: 'Ouvrir dans un nouvel onglet', click: () => hooks.openInNewTab?.(params.linkURL) });
        }
        entries.push({ label: 'Ouvrir dans une nouvelle fenêtre', click: () => hooks.openInNewWindow(params.linkURL) });
      } else {
        entries.push({ label: 'Ouvrir le lien dans le navigateur', click: () => hooks.openExternal(params.linkURL) });
      }
      entries.push({ label: 'Copier l’adresse du lien', click: () => clipboard.writeText(params.linkURL) });
      section(entries);
    }

    if (params.mediaType === 'image' && params.srcURL) {
      const entries: MenuItemConstructorOptions[] = [
        { label: 'Copier l’image', click: () => contents.copyImageAt(params.x, params.y) },
      ];
      // Downloads are limited to the Oriel instance (see downloads.ts).
      if (hooks.isAppUrl(params.srcURL)) {
        entries.push({ label: 'Enregistrer l’image sous…', click: () => contents.downloadURL(params.srcURL) });
      }
      section(entries);
    }

    const flags = params.editFlags;
    if (params.isEditable) {
      section([
        { label: 'Couper', role: 'cut', enabled: flags.canCut },
        { label: 'Copier', role: 'copy', enabled: flags.canCopy },
        { label: 'Coller', role: 'paste', enabled: flags.canPaste },
        { label: 'Coller et adapter le style', role: 'pasteAndMatchStyle', enabled: flags.canPaste },
        { label: 'Tout sélectionner', role: 'selectAll', enabled: flags.canSelectAll },
      ]);
    } else if (params.selectionText.trim()) {
      section([{ label: 'Copier', role: 'copy', enabled: flags.canCopy }]);
    }

    const selection = params.selectionText.trim();
    if (selection && process.platform === 'darwin') {
      const shown = selection.length > 24 ? `${selection.slice(0, 24)}…` : selection;
      section([{ label: `Consulter « ${shown} »`, click: () => contents.showDefinitionForSelection() }]);
    }

    if (spell && params.isEditable) {
      const entries: MenuItemConstructorOptions[] = [
        {
          label: 'Vérifier l’orthographe',
          type: 'checkbox',
          checked: spell.isEnabled(),
          click: () => spell.setEnabled(!spell.isEnabled()),
        },
      ];
      const langs = spell.languages;
      if (langs && spell.isEnabled()) {
        const current = new Set(langs.current());
        entries.push({
          label: 'Langues',
          submenu: langs.available().map((code): MenuItemConstructorOptions => ({
            label: code,
            type: 'checkbox',
            checked: current.has(code),
            click: () => {
              const next = new Set(langs.current());
              if (next.has(code)) next.delete(code);
              else next.add(code);
              if (next.size > 0) langs.set([...next]);
            },
          })),
        });
      }
      section(entries);
    }

    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: getWindow() ?? undefined });
  });
}
