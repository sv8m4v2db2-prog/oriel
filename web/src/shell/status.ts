// Connectivity status shared by the save indicator and the offline banner.
import { collabSocketStatus, collabUnsyncedStore } from '../lib/collab';
import { eventsStatusStore } from '../lib/events';
import { createStore, useStore } from '../lib/store';

/** True when the browser is offline or both realtime connections have been down for a while. */
const offlineStore = createStore(typeof navigator !== 'undefined' ? !navigator.onLine : false);

let timer: ReturnType<typeof setTimeout> | null = null;

function recompute() {
  const browserOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  const socket = collabSocketStatus.get();
  const ev = eventsStatusStore.get();
  const down = (ev === 'closed' && socket !== 'connected') || (socket === 'disconnected' && ev !== 'open');
  if (browserOffline) {
    if (timer) clearTimeout(timer);
    timer = null;
    offlineStore.set(true);
    return;
  }
  if (!down) {
    if (timer) clearTimeout(timer);
    timer = null;
    offlineStore.set(false);
    return;
  }
  // Short disconnections (reconnects) are not worth a banner.
  if (!timer && !offlineStore.get()) {
    timer = setTimeout(() => {
      timer = null;
      recompute2();
    }, 4000);
  }
}

function recompute2() {
  const socket = collabSocketStatus.get();
  const ev = eventsStatusStore.get();
  const down = (ev === 'closed' && socket !== 'connected') || (socket === 'disconnected' && ev !== 'open');
  offlineStore.set(down || (typeof navigator !== 'undefined' && !navigator.onLine));
}

if (typeof window !== 'undefined') {
  collabSocketStatus.subscribe(recompute);
  eventsStatusStore.subscribe(recompute);
  window.addEventListener('online', recompute);
  window.addEventListener('offline', recompute);
}

export function useOffline(): boolean {
  return useStore(offlineStore);
}

export type SaveStatus = 'saved' | 'saving' | 'offline';

export function useSaveStatus(): SaveStatus {
  const offline = useOffline();
  const unsynced = useStore(collabUnsyncedStore);
  if (offline) return 'offline';
  return unsynced > 0 ? 'saving' : 'saved';
}
