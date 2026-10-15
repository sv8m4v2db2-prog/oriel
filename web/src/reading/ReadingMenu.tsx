// "Affichage" menu and "Informations" button of the page top bar (SPEC §13).
import { Menu, Switch } from '@mantine/core';
import { Check, Eye, FileImage, Focus, PanelRight, Presentation as PresentIcon, Search } from 'lucide-react';
import type { PageDetailResponse, PageFormat } from '@oriel/shared';
import { updatePage } from '../lib/pages';
import { useStore } from '../lib/store';
import { modKey } from '../lib/util';
import { editorsVersion, getEditor } from '../editor/registry';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { collectFiles } from './outlineLogic';
import { focusModeStore, infoPanelStore, openFileViewer, openFind, startPresentation } from './store';

export function PageReadingControls({ detail }: { detail: PageDetailResponse; compact?: boolean }) {
  const { workspaceId } = useWorkspaceCtx();
  const info = useStore(infoPanelStore);
  useStore(editorsVersion);
  const page = detail.page;
  const editor = page.kind === 'page' ? getEditor(page.id) : undefined;
  const files = editor ? collectFiles(editor.document).length : 0;
  const canEdit = detail.canEdit && !page.trashedAt;
  const isRow = page.parentType === 'database';
  const set = (format: { [K in keyof PageFormat]?: PageFormat[K] | null }) =>
    void updatePage(workspaceId, page.id, { format: format as never }).catch(() => undefined);
  const toc = page.format.toc;

  return (
    <>
      <button
        type="button"
        className={`icon-btn${info.open ? ' is-active' : ''}`}
        aria-pressed={info.open}
        aria-label="Informations de la page"
        title="Informations de la page"
        onClick={() => infoPanelStore.set((s) => ({ ...s, open: !s.open }))}
      >
        <PanelRight size={17} />
      </button>
      <Menu position="bottom-end" width={270} shadow="md" withinPortal>
        <Menu.Target>
          <button type="button" className="icon-btn" aria-label="Affichage de la page" title="Affichage de la page">
            <Eye size={17} />
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          {editor && (
            <Menu.Item leftSection={<Search size={15} />} rightSection={<kbd>{modKey()}F</kbd>} onClick={() => openFind(page.id)}>
              Rechercher dans la page
            </Menu.Item>
          )}
          {editor && (
            <Menu.Item leftSection={<PresentIcon size={15} />} onClick={() => startPresentation(page.id)}>
              Présenter
            </Menu.Item>
          )}
          <Menu.Item leftSection={<Focus size={15} />} rightSection={<kbd>{modKey()}⇧F</kbd>} onClick={() => focusModeStore.set(true)}>
            Mode focus
          </Menu.Item>
          {files > 0 && (
            <Menu.Item leftSection={<FileImage size={15} />} onClick={() => openFileViewer(page.id)}>
              Fichiers de la page ({files})
            </Menu.Item>
          )}
          {page.kind === 'page' && (
            <>
              <Menu.Divider />
              <Menu.Label>Sommaire flottant</Menu.Label>
              {([['Automatique', undefined], ['Toujours affiché', true], ['Masqué', false]] as const).map(([label, value]) => (
                <Menu.Item
                  key={label}
                  disabled={!canEdit}
                  rightSection={toc === value ? <Check size={14} /> : null}
                  onClick={() => set({ toc: value === undefined ? null : value })}
                >
                  {label}
                </Menu.Item>
              ))}
              <Menu.Divider />
              <Menu.Label>Personnaliser la page</Menu.Label>
              <Menu.Item disabled={!canEdit} closeMenuOnClick={false} rightSection={<Switch size="xs" checked={!page.format.hideBacklinks} readOnly tabIndex={-1} />} onClick={() => set({ hideBacklinks: page.format.hideBacklinks ? null : true })}>
                Rétroliens
              </Menu.Item>
              <Menu.Item disabled={!canEdit} closeMenuOnClick={false} rightSection={<Switch size="xs" checked={!page.format.hideComments} readOnly tabIndex={-1} />} onClick={() => set({ hideComments: page.format.hideComments ? null : true })}>
                Commentaires de la page
              </Menu.Item>
              {isRow && (
                <Menu.Item disabled={!canEdit} closeMenuOnClick={false} rightSection={<Switch size="xs" checked={!page.format.hideProperties} readOnly tabIndex={-1} />} onClick={() => set({ hideProperties: page.format.hideProperties ? null : true })}>
                  En-tête des propriétés
                </Menu.Item>
              )}
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
