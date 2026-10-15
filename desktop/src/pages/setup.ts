// Script of setup.html (server / local mode chooser). Talks to the main process only through
// window.orielSetup (setup-preload.ts).
import type { ActionResult, SetupState, TestResult } from '../ipc';

declare global {
  interface Window {
    orielSetup: {
      state(): Promise<SetupState>;
      test(url: string): Promise<TestResult>;
      connect(url: string): Promise<ActionResult>;
      useLocal(): Promise<ActionResult>;
      cancel(): void;
    };
  }
}

const api = window.orielSetup;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const form = byId<HTMLFormElement>('remote-form');
const urlInput = byId<HTMLInputElement>('server-url');
const testBtn = byId<HTMLButtonElement>('test-btn');
const connectBtn = byId<HTMLButtonElement>('connect-btn');
const remoteStatus = byId('remote-status');
const recent = byId('recent');
const localBtn = byId<HTMLButtonElement>('local-btn');
const localStatus = byId('local-status');
const cancelBtn = byId<HTMLButtonElement>('cancel-btn');

let state: SetupState | null = null;
let busy = false;

type Tone = 'ok' | 'err' | 'info' | '';

function setStatus(el: HTMLElement, tone: Tone, text: string): void {
  el.className = `status ${tone}`.trim();
  el.textContent = text;
}

/** Disables every action while one is running; shows a spinner on the clicked button. */
function setBusy(button: HTMLButtonElement | null): void {
  busy = button !== null;
  for (const b of [testBtn, connectBtn, localBtn]) {
    b.disabled = busy || (b === localBtn && state?.localAvailable === false);
    b.classList.toggle('is-busy', b === button);
  }
  urlInput.readOnly = busy;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function runTest(): Promise<void> {
  const value = urlInput.value.trim();
  if (!value) {
    setStatus(remoteStatus, 'err', 'Saisissez l’adresse de votre serveur Oriel.');
    urlInput.focus();
    return;
  }
  setBusy(testBtn);
  setStatus(remoteStatus, 'info', 'Test de la connexion…');
  try {
    const result = await api.test(value);
    if (result.ok) {
      if (result.url) urlInput.value = result.url;
      setStatus(
        remoteStatus,
        'ok',
        `Connexion réussie à ${hostOf(result.url ?? value)}${result.version ? ` — Oriel ${result.version}` : ''}.`,
      );
    } else {
      setStatus(remoteStatus, 'err', result.error ?? 'Le serveur est injoignable.');
    }
  } catch {
    setStatus(remoteStatus, 'err', 'Le test a échoué de manière inattendue.');
  } finally {
    setBusy(null);
  }
}

async function connect(): Promise<void> {
  const value = urlInput.value.trim();
  if (!value) {
    setStatus(remoteStatus, 'err', 'Saisissez l’adresse de votre serveur Oriel.');
    urlInput.focus();
    return;
  }
  setBusy(connectBtn);
  setStatus(remoteStatus, 'info', `Connexion à ${hostOf(value)}…`);
  try {
    const result = await api.connect(value);
    if (result.ok) {
      setStatus(remoteStatus, 'ok', 'Connecté. Ouverture de votre espace…');
      return; // the main process closes this window
    }
    setStatus(remoteStatus, 'err', result.error ?? 'Le serveur est injoignable.');
  } catch {
    setStatus(remoteStatus, 'err', 'La connexion a échoué de manière inattendue.');
  }
  setBusy(null);
}

async function useLocal(): Promise<void> {
  setBusy(localBtn);
  setStatus(localStatus, 'info', 'Préparation du mode local…');
  try {
    const result = await api.useLocal();
    if (result.ok) {
      setStatus(localStatus, 'ok', 'Démarrage de votre espace local…');
      return;
    }
    setStatus(localStatus, 'err', result.error ?? 'Le mode local n’a pas pu démarrer.');
  } catch {
    setStatus(localStatus, 'err', 'Le mode local n’a pas pu démarrer.');
  }
  setBusy(null);
}

function renderRecent(servers: string[]): void {
  recent.replaceChildren();
  const others = servers.filter((url) => url !== urlInput.value.trim());
  recent.hidden = others.length === 0;
  for (const url of others) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = hostOf(url);
    chip.title = url;
    chip.addEventListener('click', () => {
      urlInput.value = url;
      setStatus(remoteStatus, '', '');
      renderRecent(servers);
      urlInput.focus();
    });
    recent.append(chip);
  }
}

/** Shows a file path with line-break opportunities after each "/". */
function renderPath(el: HTMLElement, path: string): void {
  el.replaceChildren();
  path.split('/').forEach((part, index, parts) => {
    el.append(index < parts.length - 1 ? `${part}/` : part);
    if (index < parts.length - 1) el.append(document.createElement('wbr'));
  });
}

async function init(): Promise<void> {
  state = await api.state();
  renderPath(byId('data-dir'), state.localDataDir);

  if (!state.firstRun) {
    byId('title').textContent = 'Changer de serveur';
    byId('lede').textContent = 'Connectez-vous à un autre serveur Oriel ou passez en mode local.';
    byId('footer-hint').textContent = `Oriel ${state.version}`;
    cancelBtn.hidden = false;
    if (state.mode === 'remote') {
      byId('card-remote').classList.add('is-current');
      byId('badge-remote').hidden = false;
    } else if (state.mode === 'local') {
      byId('card-local').classList.add('is-current');
      byId('badge-local').hidden = false;
      localBtn.textContent = 'Continuer en mode local';
    }
  }

  urlInput.value = state.serverUrl ?? state.recentServers[0] ?? '';
  renderRecent(state.recentServers);

  if (!state.localAvailable) {
    localBtn.disabled = true;
    setStatus(localStatus, 'err', 'Le serveur intégré est absent de cette version de l’application.');
  }

  urlInput.focus();
  if (urlInput.value) urlInput.select();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!busy) void connect();
});
testBtn.addEventListener('click', () => {
  if (!busy) void runTest();
});
localBtn.addEventListener('click', () => {
  if (!busy) void useLocal();
});
cancelBtn.addEventListener('click', () => api.cancel());
urlInput.addEventListener('input', () => {
  if (remoteStatus.textContent) setStatus(remoteStatus, '', '');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state && !state.firstRun && !busy) api.cancel();
});

void init();
