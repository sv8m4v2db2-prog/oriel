// "Exporter en PDF": the browser's (or the desktop app's) print dialog, with a print stylesheet that keeps
// only the page header and content (page.css, @media print). Printing always uses the light theme: the
// app theme, Mantine's color scheme and BlockNote's per-editor scheme are switched for the duration of
// the print, then restored exactly.

type Scope = 'page' | 'peek';

let scope: Scope = 'page';
let restore: Array<() => void> = [];

function setAttr(el: Element, name: string, value: string) {
  const previous = el.getAttribute(name);
  if (previous === null || previous === value) return;
  el.setAttribute(name, value);
  restore.push(() => el.setAttribute(name, previous));
}

function beforePrint() {
  const html = document.documentElement;
  restore = [];
  setAttr(html, 'data-theme', 'light');
  setAttr(html, 'data-mantine-color-scheme', 'light');
  document.querySelectorAll('[data-color-scheme="dark"], [data-mantine-color-scheme="dark"]').forEach((el) => {
    if (el.getAttribute('data-color-scheme') === 'dark') setAttr(el, 'data-color-scheme', 'light');
    if (el.getAttribute('data-mantine-color-scheme') === 'dark') setAttr(el, 'data-mantine-color-scheme', 'light');
    if (el.classList.contains('bn-root') && el.classList.contains('dark')) {
      el.classList.replace('dark', 'light');
      restore.push(() => el.classList.replace('light', 'dark'));
    }
  });
  html.classList.add('is-printing');
  if (scope === 'peek') html.classList.add('is-printing-peek');
}

function afterPrint() {
  const html = document.documentElement;
  for (const undo of restore.reverse()) undo();
  restore = [];
  html.classList.remove('is-printing', 'is-printing-peek');
  scope = 'page';
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
}

/** Opens the print dialog for the page shown in the main view, or for the one in the peek panel. */
export function printPage(target: Scope = 'page'): void {
  // Let open menus close before the print snapshot is taken.
  setTimeout(() => {
    scope = target;
    window.print();
  }, 80);
}
