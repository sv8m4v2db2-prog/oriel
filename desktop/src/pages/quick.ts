// Script of quick.html. Titles and paths come from other users: they are only ever written with
// textContent, never as HTML.
import type { QuickOpenReply, QuickResult, QuickSearchReply } from '../ipc';

declare global {
  interface Window {
    orielQuick?: {
      search(query: string): Promise<QuickSearchReply>;
      open(workspaceId: string, pageId: string): Promise<QuickOpenReply>;
      create(workspaceId: string, title: string): Promise<QuickOpenReply>;
      close(): void;
      onReset(callback: () => void): void;
    };
  }
}

const api = window.orielQuick;
const input = document.getElementById('query') as HTMLInputElement;
const listEl = document.getElementById('results') as HTMLUListElement;
const messageEl = document.getElementById('message') as HTMLElement;

type Row =
  | { kind: 'page'; result: QuickResult }
  | { kind: 'create'; title: string };

let rows: Row[] = [];
let selected = 0;
let workspaceId: string | null = null;
let ticket = 0;
let timer: number | undefined;

function showMessage(text: string | null): void {
  messageEl.hidden = text === null;
  messageEl.textContent = text ?? '';
}

function clean(snippet: string): string {
  return snippet.replace(/\[\[|\]\]/g, '');
}

function render(): void {
  listEl.textContent = '';
  rows.forEach((row, index) => {
    const li = document.createElement('li');
    li.className = `item${row.kind === 'create' ? ' item--create' : ''}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === selected));
    const icon = document.createElement('span');
    icon.className = 'item__icon';
    const body = document.createElement('span');
    body.className = 'item__body';
    const title = document.createElement('div');
    title.className = 'item__title';
    const sub = document.createElement('div');
    sub.className = 'item__sub';
    if (row.kind === 'create') {
      icon.textContent = '＋';
      title.textContent = `Créer « ${row.title} »`;
      sub.textContent = 'Nouvelle page privée';
    } else {
      icon.textContent = row.result.icon && row.result.icon.length <= 8 ? row.result.icon : '📄';
      title.textContent = row.result.title || 'Sans titre';
      sub.textContent = clean(row.result.snippet) || row.result.path;
    }
    body.append(title, sub);
    li.append(icon, body);
    li.addEventListener('mousemove', () => select(index));
    li.addEventListener('click', () => void activate(index));
    listEl.append(li);
  });
  const current = listEl.children[selected] as HTMLElement | undefined;
  current?.scrollIntoView({ block: 'nearest' });
}

function select(index: number): void {
  if (index === selected || index < 0 || index >= rows.length) return;
  const previous = listEl.children[selected];
  const next = listEl.children[index];
  previous?.setAttribute('aria-selected', 'false');
  next?.setAttribute('aria-selected', 'true');
  selected = index;
}

async function search(): Promise<void> {
  if (!api) return;
  const mine = ++ticket;
  const query = input.value.trim();
  const reply = await api.search(query);
  if (mine !== ticket) return;
  workspaceId = reply.workspaceId;
  if (!reply.ok) {
    rows = [];
    showMessage(reply.error ?? 'Recherche impossible.');
    render();
    return;
  }
  rows = reply.results.map((result): Row => ({ kind: 'page', result }));
  if (query && reply.workspaceId) rows.push({ kind: 'create', title: query });
  showMessage(rows.length === 0 ? (query ? 'Aucune page trouvée.' : 'Aucune page récente.') : null);
  selected = 0;
  render();
}

async function activate(index: number): Promise<void> {
  const row = rows[index];
  if (!api || !row) return;
  const reply =
    row.kind === 'page'
      ? await api.open(row.result.workspaceId, row.result.id)
      : workspaceId
        ? await api.create(workspaceId, row.title)
        : { ok: false, error: 'Aucun espace de travail.' };
  if (!reply.ok) showMessage(reply.error ?? 'Action impossible.');
}

function reset(): void {
  input.value = '';
  rows = [];
  selected = 0;
  showMessage(null);
  render();
  void search();
  input.focus();
}

input.addEventListener('input', () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void search(), 120);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    api?.close();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    select(Math.min(rows.length - 1, selected + 1));
    (listEl.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    select(Math.max(0, selected - 1));
    (listEl.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    void activate(selected);
  }
});
api?.onReset(reset);
reset();
