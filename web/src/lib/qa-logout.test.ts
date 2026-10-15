/// <reference types="node" />
// QA-WEB-10 (remainder) — logging out deletes the offline copies (IndexedDB). The app menu asked for
// a confirmation when edits had not reached the server, but the logout buttons of the invitation
// page and of the "create your first workspace" screen did not: every logout now goes through
// logoutWithConfirm.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { UNSYNCED_LOGOUT_CONFIRM, logoutWithConfirm } from './logout';
import { collabUnsyncedStore } from './collab';
import { confirmStore } from './ui';

function fakeDeps(unsynced: number, answer: boolean) {
  const log: string[] = [];
  return {
    log,
    deps: {
      unsynced: () => unsynced,
      confirm: async (opts: typeof UNSYNCED_LOGOUT_CONFIRM) => {
        log.push(`confirm:${opts.title}`);
        return answer;
      },
      logout: async () => {
        log.push('logout');
      },
    },
  };
}

describe('QA-WEB-10: logout warns about unsynced edits', () => {
  test('nothing pending: logs out without asking', async () => {
    const { log, deps } = fakeDeps(0, false);
    assert.equal(await logoutWithConfirm(deps), true);
    assert.deepEqual(log, ['logout']);
  });

  test('pending edits: asks, and stays signed in on refusal', async () => {
    const refused = fakeDeps(3, false);
    assert.equal(await logoutWithConfirm(refused.deps), false);
    assert.deepEqual(refused.log, ['confirm:Modifications non enregistrées']);

    const accepted = fakeDeps(1, true);
    assert.equal(await logoutWithConfirm(accepted.deps), true);
    assert.deepEqual(accepted.log, ['confirm:Modifications non enregistrées', 'logout']);
    assert.equal(UNSYNCED_LOGOUT_CONFIRM.danger, true);
  });

  test('default wiring: the app-wide unsynced counter and confirmation dialog', async () => {
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    collabUnsyncedStore.set(2);
    try {
      const pending = logoutWithConfirm();
      const request = confirmStore.get();
      assert.equal(request?.title, UNSYNCED_LOGOUT_CONFIRM.title);
      assert.equal(request?.confirmLabel, 'Se déconnecter quand même');
      request!.resolve(false); // "Annuler"
      confirmStore.set(null);
      assert.equal(await pending, false);
      assert.deepEqual(requests, []); // POST /api/auth/logout was not sent
    } finally {
      collabUnsyncedStore.set(0);
      globalThis.fetch = realFetch;
    }
  });
});
