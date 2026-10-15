// Which database's relation schema is open (D29). A tiny external store: the menu item that opens it
// lives in a popover that closes at once, the modal is rendered by <RelationGraphHost>.
import { useSyncExternalStore } from 'react';

let openId: string | null = null;
const listeners = new Set<() => void>();

export function openRelationGraph(databaseId: string | null): void {
  openId = databaseId;
  for (const l of listeners) l();
}

export function useOpenRelationGraph(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => openId,
  );
}
