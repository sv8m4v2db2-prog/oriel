// Command palette actions (⌘K) and the keyboard shortcuts help dialog (? / ⌘/).
import type { ReactNode } from 'react';
import { Modal } from '@mantine/core';
import {
  FilePlus2,
  House,
  Keyboard,
  LayoutList,
  LayoutTemplate,
  Moon,
  NotebookPen,
  PanelLeft,
  Printer,
  Settings,
  Sun,
  Trash,
} from 'lucide-react';
import { createPage } from '../lib/pages';
import { useStore } from '../lib/store';
import { toggleTheme, useTheme } from '../lib/theme';
import { toggleSidebar } from '../lib/ui';
import { appNavigate, modKey, normalizeText } from '../lib/util';
import { Kbd } from '../components/common';
import { openTemplatePicker } from '../editor/templates';
import { openJournalToday } from '../journal/openJournal';
import { printPage } from '../page/print';
import { currentSection, shortcutsHelpStore } from './shortcuts';

// ---------------------------------------------------------------------------
// Shortcuts help
// ---------------------------------------------------------------------------

export const openShortcutsHelp = () => shortcutsHelpStore.set(true);

const SHORTCUT_GROUPS = (): Array<{ title: string; items: Array<[string, string]> }> => {
  const m = modKey();
  return [
    {
      title: 'Général',
      items: [
        [`${m}K`, 'Rechercher une page ou lancer une action'],
        [`${m}N`, 'Nouvelle page'],
        ['⌥J', 'Ouvrir le journal du jour'],
        [`${m}\\`, 'Afficher / masquer la barre latérale'],
        [`${m}⇧L`, 'Thème clair / sombre'],
        [`${m}[  ${m}]`, 'Page précédente / suivante'],
        ['⌥ clic', 'Ouvrir le lien dans le panneau voisin (vue scindée)'],
        [`?  ${m}/`, 'Afficher cette aide'],
      ],
    },
    {
      title: 'Éditeur',
      items: [
        ['/', 'Insérer un bloc (titre, liste, colonnes, intégration…)'],
        ['@  [[', 'Mentionner une page'],
        [`${m}D`, 'Dupliquer le bloc'],
        ['Tab  ⇧Tab', 'Imbriquer / désimbriquer'],
        [`${m}⇧↑  ${m}⇧↓`, 'Monter / descendre le bloc'],
        [`${m}⌥0…3`, 'Texte, titre 1 à 3'],
        [`${m}B  ${m}I  ${m}U`, 'Gras, italique, souligné'],
        [`${m}Z  ${m}⇧Z`, 'Annuler / rétablir'],
        ['Clic droit', 'Menu du bloc (dupliquer, transformer, couleur, lien…)'],
        ['Maj + clic droit', 'Menu du navigateur (orthographe)'],
      ],
    },
    {
      title: 'Markdown',
      items: [
        ['#  ##  ###', 'Titres'],
        ['-  *', 'Liste à puces'],
        ['1.', 'Liste numérotée'],
        ['[]', 'Case à cocher'],
        ['>', 'Citation'],
        ['```', 'Bloc de code'],
      ],
    },
  ];
};

export function ShortcutsHelp() {
  const open = useStore(shortcutsHelpStore);
  return (
    <Modal opened={open} onClose={() => shortcutsHelpStore.set(false)} title="Raccourcis clavier" size={560} radius="lg" centered>
      <div className="shortcuts-help">
        {SHORTCUT_GROUPS().map((g) => (
          <section key={g.title} className="shortcuts-help__group">
            <h3 className="shortcuts-help__title">{g.title}</h3>
            <dl>
              {g.items.map(([keys, label]) => (
                <div key={label} className="shortcuts-help__row">
                  <dt>{label}</dt>
                  <dd>
                    {keys.split('  ').map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Command palette actions
// ---------------------------------------------------------------------------

export interface CommandAction {
  id: string;
  title: string;
  keywords: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

export function useCommandActions(opts: { workspaceId: string; canEdit: boolean; pageId?: string }): CommandAction[] {
  const theme = useTheme();
  const { workspaceId, canEdit, pageId } = opts;
  const m = modKey();
  const section = () => currentSection(workspaceId, pageId);
  const list: Array<CommandAction | false> = [
    canEdit && {
      id: 'new-page',
      title: 'Nouvelle page',
      keywords: 'creer ajouter page document',
      icon: <FilePlus2 size={17} />,
      shortcut: `${m}N`,
      run: () => void createPage({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility: section() }).catch(() => undefined),
    },
    canEdit && {
      id: 'new-from-template',
      title: 'Nouvelle page depuis un modèle…',
      keywords: 'modele template creer',
      icon: <LayoutTemplate size={17} />,
      run: () => openTemplatePicker(workspaceId, { parentType: 'workspace', parentId: workspaceId, visibility: section() }),
    },
    canEdit && {
      id: 'journal-today',
      title: 'Journal du jour',
      keywords: 'journal quotidien aujourd hui jour agenda notes',
      icon: <NotebookPen size={17} />,
      shortcut: '⌥J',
      run: () => void openJournalToday(workspaceId),
    },
    {
      id: 'all-pages',
      title: 'Toutes les pages',
      keywords: 'toutes pages liste tags collections filtres tri',
      icon: <LayoutList size={17} />,
      run: () => appNavigate(`/w/${workspaceId}/all-pages`),
    },
    {
      id: 'theme',
      title: theme.resolved === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre',
      keywords: 'theme sombre clair dark light apparence couleur',
      icon: theme.resolved === 'dark' ? <Sun size={17} /> : <Moon size={17} />,
      shortcut: `${m}⇧L`,
      run: toggleTheme,
    },
    { id: 'home', title: 'Aller à l’accueil', keywords: 'accueil home recents', icon: <House size={17} />, run: () => appNavigate(`/w/${workspaceId}`) },
    {
      id: 'settings',
      title: 'Aller à Réglages',
      keywords: 'reglages parametres preferences compte membres settings',
      icon: <Settings size={17} />,
      run: () => appNavigate(`/w/${workspaceId}/settings`),
    },
    { id: 'trash', title: 'Ouvrir la corbeille', keywords: 'corbeille supprimees restaurer trash', icon: <Trash size={17} />, run: () => appNavigate(`/w/${workspaceId}/trash`) },
    {
      id: 'sidebar',
      title: 'Afficher / masquer la barre latérale',
      keywords: 'barre laterale sidebar menu',
      icon: <PanelLeft size={17} />,
      shortcut: `${m}\\`,
      run: toggleSidebar,
    },
    !!pageId && { id: 'print', title: 'Exporter la page en PDF', keywords: 'pdf imprimer impression export', icon: <Printer size={17} />, run: () => printPage() },
    {
      id: 'shortcuts',
      title: 'Raccourcis clavier',
      keywords: 'aide raccourcis clavier touches help',
      icon: <Keyboard size={17} />,
      shortcut: '?',
      run: openShortcutsHelp,
    },
  ];
  return list.filter((a): a is CommandAction => !!a);
}

export function filterActions(actions: CommandAction[], query: string): CommandAction[] {
  const q = normalizeText(query.replace(/^>\s*/, ''));
  if (!q) return actions;
  const words = q.split(/\s+/).filter(Boolean);
  return actions.filter((a) => {
    const hay = normalizeText(`${a.title} ${a.keywords}`);
    return words.every((w) => hay.includes(w));
  });
}
