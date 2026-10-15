// Global shortcut ("recherche rapide") validation. Pure. Accepts an Electron accelerator made of
// 1+ modifiers and exactly one key, in canonical form (so that it round-trips through the settings).

export const DEFAULT_QUICK_ACCELERATOR = 'Control+Alt+Space';

const MODIFIER_ALIASES: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift'];

const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  enter: 'Return',
  return: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  plus: 'Plus',
};
const PUNCTUATION = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);

/**
 * Accelerators that would shadow essential macOS shortcuts, in the order Command, Control, Alt,
 * Shift (CommandOrControl is compared as Command: the same key on macOS). Plain ⌘+key and
 * ⌥+character are refused by rule in isReserved (QA-G10-04).
 */
const RESERVED = new Set([
  'Command+Shift+3',
  'Command+Shift+4',
  'Command+Shift+5',
  'Command+Shift+Z',
  'Command+Shift+Tab',
  'Command+Control+Q',
  'Command+Control+Space',
  'Command+Control+F',
  'Command+Alt+Space',
  'Control+Space',
]);

export type AcceleratorCheck = { ok: true; accelerator: string } | { ok: false; error: string };

export function validateAccelerator(value: unknown): AcceleratorCheck {
  if (typeof value !== 'string' || value.length === 0 || value.length > 60) {
    return { ok: false, error: 'Raccourci invalide.' };
  }
  const parts = value.split('+').map((p) => p.trim());
  // "Command++" is not supported: the plus key is spelled "Plus".
  if (parts.some((p) => p === '')) return { ok: false, error: 'Raccourci invalide.' };
  const key = parts[parts.length - 1]!;
  const mods = new Set<string>();
  for (const raw of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[raw.toLowerCase()];
    if (!mod) return { ok: false, error: 'Raccourci invalide.' };
    mods.add(mod);
  }
  const canonicalKey = canonicalKeyOf(key);
  if (!canonicalKey) return { ok: false, error: 'Cette touche ne peut pas servir de raccourci.' };
  const hasStrongModifier = ['CommandOrControl', 'Command', 'Control', 'Alt'].some((m) => mods.has(m));
  const isFunctionKey = /^F\d{1,2}$/.test(canonicalKey);
  if (!hasStrongModifier && !(isFunctionKey && mods.size > 0)) {
    return { ok: false, error: 'Ajoutez au moins une touche ⌘, ⌃ ou ⌥ au raccourci.' };
  }
  const accelerator = [...MODIFIER_ORDER.filter((m) => mods.has(m)), canonicalKey].join('+');
  if (isReserved(mods, canonicalKey, isFunctionKey)) return { ok: false, error: 'Ce raccourci est réservé par le système.' };
  return { ok: true, accelerator };
}

function isReserved(mods: Set<string>, key: string, isFunctionKey: boolean): boolean {
  if (isFunctionKey) return false;
  const normalized = new Set([...mods].map((m) => (m === 'CommandOrControl' ? 'Command' : m)));
  const only = (...list: string[]) => list.length === normalized.size && list.every((m) => normalized.has(m));
  // ⌘Q, ⌘W, ⌘C, ⌘V, ⌘Tab, ⌘Espace, ⌘`… : used by every application or by the system.
  if (only('Command')) return true;
  // ⌥E, ⌥N, ⌥⇧2… : dead keys and special characters of the keyboard layout (⌥Espace stays allowed).
  if ((only('Alt') || only('Alt', 'Shift')) && key !== 'Space') return true;
  return RESERVED.has([...['Command', 'Control', 'Alt', 'Shift'].filter((m) => normalized.has(m)), key].join('+'));
}

function canonicalKeyOf(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  const fn = /^f(\d{1,2})$/i.exec(key);
  if (fn) return Number(fn[1]) >= 1 && Number(fn[1]) <= 24 ? `F${Number(fn[1])}` : null;
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  return PUNCTUATION.has(key) ? key : null;
}

/** "Control+Alt+Space" → "⌃⌥Espace" for display. */
export function acceleratorLabel(accelerator: string): string {
  const symbols: Record<string, string> = {
    CommandOrControl: '⌘',
    Command: '⌘',
    Control: '⌃',
    Alt: '⌥',
    Shift: '⇧',
    Space: 'Espace',
    Return: '↩',
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
    Backspace: '⌫',
    Delete: '⌦',
    Plus: '+',
  };
  return accelerator
    .split('+')
    .map((p) => symbols[p] ?? p)
    .join('');
}
