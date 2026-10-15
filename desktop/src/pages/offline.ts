// Script of offline.html: "starting" spinner (local mode) or "server unreachable" with automatic
// reconnection (remote mode). Talks to the main process through window.orielStatus (preload.ts).
import type { RetryResult, StatusInfo } from '../ipc';

declare global {
  interface Window {
    orielStatus?: {
      get(): Promise<StatusInfo | null>;
      retry(): Promise<RetryResult>;
      changeServer(): void;
    };
  }
}

/** Seconds between automatic attempts (the last value repeats). */
const RETRY_DELAYS = [5, 10, 20, 30];

const api = window.orielStatus;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const retryBtn = byId<HTMLButtonElement>('retry-btn');
const changeBtn = byId<HTMLButtonElement>('change-btn');
const countdown = byId('countdown');

let info: StatusInfo | null = null;
let attempt = 0;
let remaining = 0;
let ticker: number | undefined;
let busy = false;

function showError(message: string | null, code: string | null): void {
  byId('error-message').textContent = message ?? '';
  byId('error-code').textContent = code ?? '';
  byId('error-detail').hidden = !message && !code;
}

function stopCountdown(): void {
  if (ticker !== undefined) window.clearInterval(ticker);
  ticker = undefined;
}

function scheduleRetry(): void {
  stopCountdown();
  if (info?.mode !== 'remote') {
    countdown.textContent = '';
    return;
  }
  remaining = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]!;
  const render = () => {
    countdown.textContent = `Nouvelle tentative automatique dans ${remaining} s…`;
  };
  render();
  ticker = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) void retry();
    else render();
  }, 1000);
}

async function retry(): Promise<void> {
  if (!api || busy) return;
  busy = true;
  stopCountdown();
  retryBtn.disabled = true;
  retryBtn.classList.add('is-busy');
  countdown.textContent = info?.mode === 'local' ? 'Redémarrage du serveur local…' : 'Connexion en cours…';
  let result: RetryResult;
  try {
    result = await api.retry();
  } catch {
    result = { ok: false };
  }
  busy = false;
  retryBtn.disabled = false;
  retryBtn.classList.remove('is-busy');
  if (result.ok) {
    countdown.textContent = 'Connexion rétablie, chargement…';
    return; // the main process loads Oriel in this window
  }
  attempt += 1;
  if (result.error) showError(result.error, result.errorCode ?? null);
  scheduleRetry();
}

function render(status: StatusInfo): void {
  info = status;
  if (status.kind === 'starting') {
    byId('view-starting').hidden = false;
    byId('view-offline').hidden = true;
    return;
  }
  byId('view-starting').hidden = true;
  byId('view-offline').hidden = false;
  if (status.mode === 'local') {
    byId('offline-title').textContent = 'Serveur local indisponible';
    byId('offline-text').textContent =
      'Le serveur Oriel intégré à l’application ne répond pas. Vos données sont intactes sur ce Mac.';
    byId('hint').hidden = true;
  } else {
    byId('server-label').textContent = status.serverLabel;
  }
  showError(status.error, status.errorCode);
  scheduleRetry();
  retryBtn.focus();
}

retryBtn.addEventListener('click', () => {
  attempt = 0;
  void retry();
});
changeBtn.addEventListener('click', () => api?.changeServer());
// Back online: no need to wait for the countdown.
window.addEventListener('online', () => {
  if (info?.kind === 'offline' && info.mode === 'remote') void retry();
});

if (api) {
  void api.get().then((status) => {
    if (status) render(status);
  });
}
