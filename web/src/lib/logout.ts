// Logging out deletes the offline copies (IndexedDB): edits the server has not received yet would be
// lost. Every logout button goes through here (QA-WEB-10): app menu, invitation page, workspace
// picker.
import { collabUnsyncedStore } from './collab';
import { logout } from './session';
import { confirmDialog } from './ui';

export const UNSYNCED_LOGOUT_CONFIRM = {
  title: 'Modifications non enregistrées',
  message: 'Certaines modifications n’ont pas encore été envoyées au serveur (connexion interrompue). Elles seront perdues si vous vous déconnectez maintenant.',
  confirmLabel: 'Se déconnecter quand même',
  danger: true,
} as const;

interface LogoutDeps {
  unsynced: () => number;
  confirm: (opts: typeof UNSYNCED_LOGOUT_CONFIRM) => Promise<boolean>;
  logout: () => Promise<void>;
}

const appDeps: LogoutDeps = { unsynced: () => collabUnsyncedStore.get(), confirm: confirmDialog, logout };

/** Logs out, after a confirmation when edits are still unsynced. Resolves false when the user stays signed in. */
export async function logoutWithConfirm(deps: LogoutDeps = appDeps): Promise<boolean> {
  if (deps.unsynced() > 0 && !(await deps.confirm(UNSYNCED_LOGOUT_CONFIRM))) return false;
  await deps.logout();
  return true;
}
