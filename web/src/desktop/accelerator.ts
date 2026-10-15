// Keyboard event → Electron accelerator ("Control+Alt+Space"), for the quick search shortcut field.
// The app re-validates the value (desktop/src/accelerator.ts): this only builds a candidate.

const NAMED: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Candidate accelerator, or null while only modifiers are held / the key is unsupported. */
export function acceleratorFromEvent(e: KeyLike): string | null {
  let key: string | null = null;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit([0-9])$/.exec(e.code);
  const fn = /^F([0-9]{1,2})$/.exec(e.code);
  if (letter) key = letter[1]!;
  else if (digit) key = digit[1]!;
  else if (fn) key = `F${fn[1]}`;
  else key = NAMED[e.code] ?? null;
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

const SYMBOLS: Record<string, string> = {
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
};

/** "Control+Alt+Space" → "⌃⌥Espace". */
export function acceleratorLabel(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => SYMBOLS[part] ?? part)
    .join('');
}
