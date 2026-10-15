// Escape for popovers whose focus has left the dropdown (a panel switch unmounted the focused
// button, a click on the page…). Mantine only closes a popover on Escape typed inside its dropdown;
// here the most recently opened popover closes instead, one per key press.

export class EscapeStack {
  private entries: Array<() => void> = [];

  /** Registers an open popover; returns the function that unregisters it. */
  push(close: () => void): () => void {
    const entry = () => close();
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
    };
  }

  get size(): number {
    return this.entries.length;
  }

  /** Closes the most recently opened popover; false when none is open. */
  closeTop(): boolean {
    const top = this.entries[this.entries.length - 1];
    if (!top) return false;
    top();
    return true;
  }
}

export interface EscapeKey {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  /** The key was typed in a floating layer (dropdown, menu, modal) that handles its own Escape. */
  inLayer: boolean;
}

/** Handles a key press for `stack`; true when a popover was closed (the caller stops the event). */
export function closeOnOutsideEscape(stack: EscapeStack, e: EscapeKey): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.inLayer) return false;
  return stack.closeTop();
}
