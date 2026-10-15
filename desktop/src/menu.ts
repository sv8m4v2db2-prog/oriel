// Native macOS menu bar, in French.
import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  openSettings(): void;
  changeServer(): void;
  newWindow(): void;
  reload(): void;
  forceReload(): void;
  goBack(): void;
  goForward(): void;
  search(): void;
  openDocumentation(): void;
  revealData(): void;
  revealLogs(): void;
  newTab(): void;
  /** ⌘W: closes the active tab, then the window; other windows (setup, quick search) just close. */
  closeTab(): void;
  closeWindow(): void;
  reopenTab(): void;
  /** `digit` 1…9 (9 = last tab). */
  selectTab(digit: number): void;
  previousTab(): void;
  nextTab(): void;
  moveTabToNewWindow(): void;
  showDefinition(): void;
  toggleSpellcheck(): void;
  revealLastDownload(): void;
  quickSearch(): void;
}

export interface MenuState {
  mode: 'remote' | 'local' | null;
  spellcheck: boolean;
  hasDownload: boolean;
}

export function buildAppMenu(actions: MenuActions, state: MenuState): Menu {
  const name = app.name;
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { label: `À propos de ${name}`, role: 'about' },
        { type: 'separator' },
        { label: 'Réglages…', accelerator: 'Command+,', click: () => actions.openSettings() },
        { label: 'Changer de serveur…', click: () => actions.changeServer() },
        { type: 'separator' },
        { label: 'Services', role: 'services' },
        { type: 'separator' },
        { label: `Masquer ${name}`, role: 'hide' },
        { label: 'Masquer les autres', role: 'hideOthers' },
        { label: 'Tout afficher', role: 'unhide' },
        { type: 'separator' },
        { label: `Quitter ${name}`, role: 'quit' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { label: 'Annuler', role: 'undo' },
        { label: 'Rétablir', role: 'redo' },
        { type: 'separator' },
        { label: 'Couper', role: 'cut' },
        { label: 'Copier', role: 'copy' },
        { label: 'Coller', role: 'paste' },
        { label: 'Coller et adapter le style', role: 'pasteAndMatchStyle' },
        { label: 'Supprimer', role: 'delete' },
        { label: 'Tout sélectionner', role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Définition du mot sélectionné',
          accelerator: 'Control+Command+D',
          click: () => actions.showDefinition(),
        },
        {
          label: 'Vérifier l’orthographe',
          type: 'checkbox',
          checked: state.spellcheck,
          click: () => actions.toggleSpellcheck(),
        },
        { type: 'separator' },
        {
          label: 'Parole',
          submenu: [
            { label: 'Commencer la lecture', role: 'startSpeaking' },
            { label: 'Arrêter la lecture', role: 'stopSpeaking' },
          ],
        },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Recharger', accelerator: 'Command+R', click: () => actions.reload() },
        { label: 'Forcer le rechargement', accelerator: 'Command+Shift+R', click: () => actions.forceReload() },
        { type: 'separator' },
        { label: 'Taille réelle', role: 'resetZoom' },
        { label: 'Zoom avant', role: 'zoomIn' },
        { label: 'Zoom arrière', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Plein écran', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Outils de développement', role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Précédent', accelerator: 'Command+[', click: () => actions.goBack() },
        { label: 'Suivant', accelerator: 'Command+]', click: () => actions.goForward() },
        { type: 'separator' },
        // The web app owns ⌘K: the accelerator is only displayed (not registered) so the keystroke
        // reaches the page untouched; clicking the item forwards the shortcut to the page.
        { label: 'Rechercher', accelerator: 'Command+K', registerAccelerator: false, click: () => actions.search() },
        { label: 'Recherche rapide…', click: () => actions.quickSearch() },
      ],
    },
    {
      label: 'Fenêtre',
      role: 'window',
      submenu: [
        { label: 'Nouvel onglet', accelerator: 'Command+T', click: () => actions.newTab() },
        { label: 'Nouvelle fenêtre', accelerator: 'Command+Shift+N', click: () => actions.newWindow() },
        { type: 'separator' },
        { label: 'Fermer l’onglet', accelerator: 'Command+W', click: () => actions.closeTab() },
        { label: 'Fermer la fenêtre', accelerator: 'Command+Shift+W', click: () => actions.closeWindow() },
        { label: 'Rouvrir l’onglet fermé', accelerator: 'Command+Shift+T', click: () => actions.reopenTab() },
        { type: 'separator' },
        { label: 'Onglet précédent', accelerator: 'Command+Shift+[', click: () => actions.previousTab() },
        { label: 'Onglet suivant', accelerator: 'Command+Shift+]', click: () => actions.nextTab() },
        {
          label: 'Aller à l’onglet',
          submenu: Array.from({ length: 9 }, (_, i): MenuItemConstructorOptions => ({
            label: i === 8 ? 'Dernier onglet' : `Onglet ${i + 1}`,
            accelerator: `Command+${i + 1}`,
            click: () => actions.selectTab(i + 1),
          })),
        },
        { label: 'Déplacer l’onglet dans une nouvelle fenêtre', click: () => actions.moveTabToNewWindow() },
        { type: 'separator' },
        { label: 'Placer dans le Dock', role: 'minimize' },
        { label: 'Réduire/agrandir', role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Dernier téléchargement dans le Finder',
          enabled: state.hasDownload,
          click: () => actions.revealLastDownload(),
        },
        { type: 'separator' },
        { label: 'Tout ramener au premier plan', role: 'front' },
      ],
    },
    {
      label: 'Aide',
      role: 'help',
      submenu: [
        { label: `Documentation de ${name}`, click: () => actions.openDocumentation() },
        { type: 'separator' },
        {
          label: 'Afficher les données locales dans le Finder',
          enabled: state.mode === 'local',
          click: () => actions.revealData(),
        },
        { label: 'Afficher les journaux dans le Finder', click: () => actions.revealLogs() },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** Dock menu (right click on the Dock icon). */
export function buildDockMenu(actions: Pick<MenuActions, 'newWindow' | 'changeServer'>): Menu {
  return Menu.buildFromTemplate([
    { label: 'Nouvelle fenêtre', click: () => actions.newWindow() },
    { label: 'Changer de serveur…', click: () => actions.changeServer() },
  ]);
}
