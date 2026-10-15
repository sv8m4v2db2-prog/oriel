// Mounted once in the shell (through PeekPanel): global shortcuts, body classes and overlays.
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { navigation, useNavigationState } from '../lib/navigation';
import { useStore } from '../lib/store';
import { isMac } from '../lib/util';
import { getEditor } from '../editor/registry';
import { FindBar } from './FindBar';
import { FileViewer } from './FileViewer';
import { FocusExit } from './FocusExit';
import { HoverPreview } from './HoverPreview';
import { InfoPanel } from './InfoPanel';
import { Presentation } from './Present';
import { closeFind, closeFileViewer, fileViewerStore, findStore, focusModeStore, infoPanelStore, openFind, presentStore, toggleFocusMode } from './store';
import { INFO_PANEL_WIDTH } from './store';
import './reading.css';

/** Page a page-level shortcut applies to: the one under the focus (peek or main), else the peek if open. */
function targetPageId(e: KeyboardEvent, routePageId: string | undefined): string | undefined {
  const peekId = navigation.getState().peekPageId;
  const el = e.target as HTMLElement | null;
  if (peekId && el?.closest?.('.peek')) return peekId;
  if (el?.closest?.('.shell__main')) return routePageId;
  return peekId ?? routePageId;
}

export function ReadingHost() {
  const { pageId: routePageId } = useParams();
  const { peekPageId } = useNavigationState();
  const focus = useStore(focusModeStore);
  const info = useStore(infoPanelStore);

  useEffect(() => {
    document.body.classList.toggle('or-focus', focus);
    return () => document.body.classList.remove('or-focus');
  }, [focus]);

  useEffect(() => {
    const on = info.open;
    document.body.classList.toggle('or-info-open', on);
    document.body.classList.toggle('or-info-docked', on && info.docked);
    document.body.style.setProperty('--or-info-w', `${INFO_PANEL_WIDTH}px`);
    return () => {
      document.body.classList.remove('or-info-open', 'or-info-docked');
    };
  }, [info.open, info.docked]);

  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      const key = e.key.toLowerCase();
      if (presentStore.get().pageId || fileViewerStore.get()) return; // those overlays own the keyboard
      if (mod && !e.altKey && key === 'f') {
        if (e.shiftKey) {
          e.preventDefault();
          toggleFocusMode();
          return;
        }
        const id = targetPageId(e, routePageId);
        if (id && getEditor(id)) {
          e.preventDefault();
          openFind(id);
        }
        return;
      }
      if (e.key === 'Escape' && findStore.get().open) {
        e.preventDefault();
        closeFind();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [routePageId]);

  // Double-click on an attachment opens the viewer.
  useEffect(() => {
    const onDbl = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const content = el?.closest<HTMLElement>('.bn-block-content[data-content-type]');
      const type = content?.dataset.contentType;
      if (!type || !['image', 'video', 'audio', 'pdf', 'file'].includes(type)) return;
      const pageId = content!.closest<HTMLElement>('.page')?.dataset.pageId;
      const blockId = content!.closest<HTMLElement>('.bn-block-outer')?.dataset.id ?? null;
      if (pageId && getEditor(pageId)) {
        e.preventDefault();
        closeFileViewer();
        fileViewerStore.set({ pageId, blockId });
      }
    };
    document.addEventListener('dblclick', onDbl);
    return () => document.removeEventListener('dblclick', onDbl);
  }, []);

  return (
    <>
      <FindBar />
      <Presentation />
      <FocusExit />
      <InfoPanel pageId={peekPageId ?? routePageId} />
      <HoverPreview />
      <FileViewer />
    </>
  );
}
