// Sidebar entry « Journal » and its global shortcut (Alt+J: journal du jour).
import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { NotebookPen } from 'lucide-react';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { openJournalToday } from './openJournal';

export function JournalSidebarLink() {
  const { workspaceId, canEdit } = useWorkspaceCtx();
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      // `code` because Alt+J types a dead character on macOS keyboards.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyJ') {
        if (e.defaultPrevented) return;
        e.preventDefault();
        void openJournalToday(workspaceId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceId, canEdit]);
  return (
    <NavLink to={`/w/${workspaceId}/journal`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
      <NotebookPen size={16} />
      <span className="nav-item__label">Journal</span>
    </NavLink>
  );
}
