// Desktop module: bridge to the macOS app (Dock badge, app preferences). Everything here is inert
// in a browser: `window.orielDesktop` only exists in the Electron app.
import { Laptop } from 'lucide-react';
import type { ReactNode } from 'react';
import { desktop } from '../lib/desktop';
import { DesktopSettings } from './DesktopSettings';
import './desktop.css';

export { DesktopBridge } from './DesktopBridge';

// The app shows its own tab bar above the page: let the stylesheet drop the traffic-light margins.
if (typeof document !== 'undefined' && desktop?.hasTabs) {
  document.documentElement.classList.add('has-native-tabs');
}

/** Settings tabs added by the app (empty in a browser or with an older app that lacks the preferences API). */
export const desktopSettingsTabs: Array<{ id: string; label: string; icon: ReactNode; render: () => ReactNode }> =
  desktop?.getPrefs && desktop.setPrefs
    ? [{ id: 'desktop', label: 'Application', icon: <Laptop size={16} />, render: () => <DesktopSettings /> }]
    : [];
