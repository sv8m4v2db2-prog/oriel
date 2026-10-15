// Mantine Popover with the module's defaults: re-flips when its content grows and never exceeds
// the viewport (long menus scroll inside the dropdown). Escape closes it even when the focus has
// left the dropdown.
import { useEffect, useRef } from 'react';
import { Popover, usePopoverContext, type PopoverProps } from '@mantine/core';
import { closeOnOutsideEscape, EscapeStack } from './escapeStack';

const MIN_HEIGHT = 320;

const middlewares: PopoverProps['middlewares'] = {
  flip: true,
  shift: { padding: 8 },
  size: {
    padding: 8,
    apply({ availableHeight, elements }) {
      // Below MIN_HEIGHT we let the dropdown overflow so that `flip` moves it to the roomier side.
      elements.floating.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(availableHeight))}px`;
    },
  },
};

/** Layers that handle their own Escape (dropdowns, menus, modals, editor suggestions). */
const FLOATING_LAYERS = '.mantine-Popover-dropdown, .mantine-Menu-dropdown, .mantine-Modal-root, .bn-suggestion-menu, .context-menu';
const openPopovers = new EscapeStack();

function onWindowKeyDown(e: KeyboardEvent) {
  const inLayer = e.target instanceof Element && !!e.target.closest(FLOATING_LAYERS);
  if (closeOnOutsideEscape(openPopovers, { key: e.key, defaultPrevented: e.defaultPrevented, isComposing: e.isComposing, inLayer })) {
    // Before the page's own Escape (side peek, block selection).
    e.preventDefault();
    e.stopPropagation();
  }
}

function OutsideEscape() {
  const ctx = usePopoverContext();
  const close = useRef(ctx.onClose);
  close.current = ctx.onClose;
  const active = ctx.opened && ctx.closeOnEscape !== false;
  useEffect(() => {
    if (!active) return;
    const remove = openPopovers.push(() => close.current?.());
    if (openPopovers.size === 1) window.addEventListener('keydown', onWindowKeyDown, true);
    return () => {
      remove();
      if (openPopovers.size === 0) window.removeEventListener('keydown', onWindowKeyDown, true);
    };
  }, [active]);
  return null;
}

export function DbPopover({ children, ...props }: PopoverProps) {
  return (
    <Popover shadow="md" preventPositionChangeWhenVisible={false} middlewares={middlewares} {...props}>
      {children}
      <OutsideEscape />
    </Popover>
  );
}

DbPopover.Target = Popover.Target;
DbPopover.Dropdown = Popover.Dropdown;
