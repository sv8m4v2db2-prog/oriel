// Discreet exit button of the focus mode (SPEC §13.4).
import { createPortal } from 'react-dom';
import { Minimize2 } from 'lucide-react';
import { useStore } from '../lib/store';
import { focusModeStore } from './store';

export function FocusExit() {
  const on = useStore(focusModeStore);
  if (!on) return null;
  return createPortal(
    <div className="or-focus-exit">
      <button type="button" className="icon-btn" aria-label="Quitter le mode focus" title="Quitter le mode focus (⌘⇧F)" onClick={() => focusModeStore.set(false)}>
        <Minimize2 size={16} />
      </button>
    </div>,
    document.body,
  );
}
