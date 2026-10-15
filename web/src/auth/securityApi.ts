// HTTP client of account security (contract: shared/src/security.ts). Errors with a recovery handler
// (re-authentication, lib/api.ts onApiErrorCode) retry the request once, like the main client.
import type {
  AdminUserSecurity,
  ApiErrorBody,
  LoginResponse,
  MfaVerifyRequest,
  PasskeyOptionsResponse,
  ReauthOptionsResponse,
  ReauthRequest,
  RecoveryCodesResponse,
  SecurityLogEntry,
  SecurityStatus,
  SessionResponse,
  TotpSetupResponse,
  TransfersResponse,
  UpdateWorkspaceSecurityRequest,
  User,
  VerifiedDomain,
  WebAuthnJson,
  WorkspaceSecurityPolicy,
  WorkspaceTransfer,
} from '@oriel/shared';
import { ApiError, assertApiPath, recoverApiError } from '../lib/api';
import { apiPath } from '../lib/apiPath';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, retried = false): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'network', 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    const error = new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur ${res.status}`);
    if (!retried && (await recoverApiError(error))) return request<T>(method, path, body, true);
    throw error;
  }
  return data as T;
}

/** Request without the recovery handlers (used by the re-authentication dialog itself). */
const raw = <T>(method: Method, path: string, body?: unknown) => request<T>(method, path, body, true);

export const securityKeys = {
  status: ['security', 'status'] as const,
  log: ['security', 'log'] as const,
  transfers: ['security', 'transfers'] as const,
  policy: (wid: string) => ['security', 'policy', wid] as const,
  domains: (wid: string) => ['security', 'domains', wid] as const,
  adminUsers: ['security', 'admin-users'] as const,
};

export const securityApi = {
  // sign-in
  loginMfa: (body: MfaVerifyRequest) => raw<SessionResponse>('POST', '/auth/login/mfa', body),
  loginMfaPasskeyOptions: (ticket?: string) => raw<PasskeyOptionsResponse>('POST', '/auth/login/mfa/passkey-options', { ticket }),
  passkeyOptions: () => raw<PasskeyOptionsResponse>('POST', '/auth/passkey/options', {}),
  passkeyLogin: (ticket: string, response: WebAuthnJson) => raw<SessionResponse>('POST', '/auth/passkey/login', { ticket, response }),
  oidcStart: (mode: 'login' | 'link' | 'reauth', next: string) => request<{ url: string }>('POST', '/auth/oidc/start', { mode, next }),
  // re-authentication
  reauthOptions: () => raw<ReauthOptionsResponse>('GET', '/auth/reauth'),
  reauthPasskeyOptions: () => raw<PasskeyOptionsResponse>('POST', '/auth/reauth/passkey-options', {}),
  reauth: (body: ReauthRequest) => raw<ReauthOptionsResponse>('POST', '/auth/reauth', body),
  // account
  status: () => request<SecurityStatus>('GET', '/me/security'),
  log: () => request<{ entries: SecurityLogEntry[] }>('GET', '/me/security/log'),
  totpSetup: () => request<TotpSetupResponse>('POST', '/me/security/totp/setup', {}),
  totpConfirm: (code: string) => request<RecoveryCodesResponse>('POST', '/me/security/totp/confirm', { code }),
  totpDisable: () => request<{ ok: true }>('DELETE', '/me/security/totp'),
  recoveryCodes: () => request<RecoveryCodesResponse>('POST', '/me/security/recovery-codes', {}),
  passkeyRegisterOptions: () => request<PasskeyOptionsResponse>('POST', '/me/security/passkeys/options', {}),
  passkeyRegister: (ticket: string, response: WebAuthnJson, name: string) => request<{ id: string }>('POST', '/me/security/passkeys', { ticket, response, name }),
  passkeyRename: (id: string, name: string) => request<{ ok: true }>('PATCH', apiPath`/me/security/passkeys/${id}`, { name }),
  passkeyRemove: (id: string) => request<{ ok: true }>('DELETE', apiPath`/me/security/passkeys/${id}`),
  unlinkIdentity: (issuer: string) => request<{ ok: true }>('DELETE', `/me/security/identities?issuer=${encodeURIComponent(issuer)}`),
  changeEmail: (email: string) => request<{ user: User }>('POST', '/me/email', { email }),
  // transfers
  transfers: () => request<TransfersResponse>('GET', '/me/transfers'),
  proposeTransfer: (wid: string, toUserId: string) => request<WorkspaceTransfer>('POST', apiPath`/workspaces/${wid}/transfer`, { toUserId }),
  cancelTransfer: (wid: string) => request<{ ok: true }>('DELETE', apiPath`/workspaces/${wid}/transfer`),
  acceptTransfer: (id: string) => request<{ ok: true }>('POST', apiPath`/transfers/${id}/accept`, {}),
  declineTransfer: (id: string) => request<{ ok: true }>('POST', apiPath`/transfers/${id}/decline`, {}),
  // workspace
  policy: (wid: string) => request<WorkspaceSecurityPolicy>('GET', apiPath`/workspaces/${wid}/security`),
  setPolicy: (wid: string, body: UpdateWorkspaceSecurityRequest) => request<WorkspaceSecurityPolicy>('PUT', apiPath`/workspaces/${wid}/security`, body),
  domains: (wid: string) => request<{ domains: VerifiedDomain[] }>('GET', apiPath`/workspaces/${wid}/domains`),
  addDomain: (wid: string, domain: string) => request<VerifiedDomain>('POST', apiPath`/workspaces/${wid}/domains`, { domain }),
  verifyDomain: (wid: string, domain: string) => request<VerifiedDomain>('POST', apiPath`/workspaces/${wid}/domains/${domain}/verify`, {}),
  updateDomain: (wid: string, domain: string, body: { autoJoin?: boolean; joinRole?: 'member' | 'viewer' }) =>
    request<VerifiedDomain>('PATCH', apiPath`/workspaces/${wid}/domains/${domain}`, body),
  removeDomain: (wid: string, domain: string) => request<{ ok: true }>('DELETE', apiPath`/workspaces/${wid}/domains/${domain}`),
  // instance administration
  adminUsers: () => request<{ users: AdminUserSecurity[] }>('GET', '/admin/security/users'),
  adminReset: (uid: string) => request<{ ok: true }>('POST', apiPath`/admin/users/${uid}/security/reset`, {}),
};

export type { LoginResponse };
