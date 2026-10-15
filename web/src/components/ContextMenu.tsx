// Right-click context menus, shared by every module (editor, databases, sidebar…).
//
//   <div onContextMenu={(e) => openContextMenu(e, [
//     { label: 'Ouvrir', icon: <ExternalLink size={15} />, onClick: open },
//     { label: 'Couleur', icon: <Palette size={15} />, submenu: [{ label: 'Rouge', onClick: red }] },
//     { divider: true },
//     { label: 'Supprimer', icon: <Trash2 size={15} />, danger: true, onClick: remove },
//   ])} />
//
// A single <ContextMenuHost /> (mounted in App) renders the menu at the cursor position.
import { Fragment, useEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Menu } from '@mantine/core';
import { Check } from 'lucide-react';
import { createStore, useStore } from '../lib/store';

export interface ContextMenuAction {
  label: string;
  icon?: ReactNode;
  /** Right-aligned hint, e.g. "⌘D". */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Shows a check mark (current choice in a list). */
  checked?: boolean;
  onClick: () => void;
}
/** Opens a nested menu on hover ("Transformer en ▸"). */
export interface ContextSubmenu {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  submenu: ContextMenuEntry[];
}
export type ContextMenuEntry = ContextMenuAction | ContextSubmenu | { divider: true } | { header: string };
/** Entries may contain falsy placeholders (conditional items), they are skipped. */
export type ContextMenuEntries = Array<ContextMenuEntry | false | null | undefined>;

interface MenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  key: number;
}

const menuStore = createStore<MenuState | null>(null);
let seq = 0;

function compact(entries: ContextMenuEntries): ContextMenuEntry[] {
  const list = entries.filter((e): e is ContextMenuEntry => !!e);
  // Drop leading / trailing / doubled dividers left by conditional items.
  const out: ContextMenuEntry[] = [];
  for (const e of list) {
    if ('divider' in e && (out.length === 0 || 'divider' in out[out.length - 1]!)) continue;
    out.push(e);
  }
  while (out.length && 'divider' in out[out.length - 1]!) out.pop();
  return out;
}

const hasItems = (entries: ContextMenuEntry[]) => entries.some((e) => 'label' in e);

/** Lets a module add entries to any menu opened from a pointer event (split view: « Ouvrir à côté »). */
type ContextMenuDecorator = (event: ReactMouseEvent | MouseEvent, entries: ContextMenuEntry[]) => ContextMenuEntry[];
let decorator: ContextMenuDecorator | null = null;
export function setContextMenuDecorator(fn: ContextMenuDecorator | null): void {
  decorator = fn;
}

/**
 * Opens the context menu at the pointer. Prevents the native menu and stops propagation so the
 * innermost handler wins. Returns without opening when `entries` is empty.
 */
export function openContextMenu(event: ReactMouseEvent | MouseEvent, entries: ContextMenuEntries): void {
  let visible = compact(entries);
  if (!hasItems(visible)) return;
  if (decorator) {
    try {
      visible = decorator(event, visible);
    } catch {
      /* a failing decorator never blocks the menu */
    }
  }
  event.preventDefault();
  event.stopPropagation();
  menuStore.set({ x: event.clientX, y: event.clientY, entries: visible, key: ++seq });
}

/** Opens the menu at a given viewport position (keyboard / programmatic use, e.g. after a paste). */
export function openContextMenuAt(x: number, y: number, entries: ContextMenuEntries): void {
  const visible = compact(entries);
  if (!hasItems(visible)) return;
  menuStore.set({ x, y, entries: visible, key: ++seq });
}

export function closeContextMenu(): void {
  menuStore.set(null);
}

export const isContextMenuOpen = () => menuStore.get() !== null;

/** Renders entries as Mantine menu children (also used by "…" menus so both stay identical). */
export function MenuEntries({ entries, onAction }: { entries: ContextMenuEntry[]; onAction?: () => void }) {
  return (
    <>
      {entries.map((entry, i) => {
        if ('divider' in entry) return <Menu.Divider key={`d${i}`} />;
        if ('header' in entry) return <Menu.Label key={`h${i}`}>{entry.header}</Menu.Label>;
        if ('submenu' in entry) {
          const sub = compact(entry.submenu);
          return (
            <Menu.Sub key={`s${i}`} position="right-start" offset={2}>
              <Menu.Sub.Target>
                <Menu.Sub.Item leftSection={entry.icon} disabled={entry.disabled || !hasItems(sub)}>
                  {entry.label}
                </Menu.Sub.Item>
              </Menu.Sub.Target>
              <Menu.Sub.Dropdown className="context-menu context-menu--sub">
                <MenuEntries entries={sub} onAction={onAction} />
              </Menu.Sub.Dropdown>
            </Menu.Sub>
          );
        }
        return (
          <Fragment key={`i${i}`}>
            <Menu.Item
              leftSection={entry.icon}
              rightSection={
                entry.checked ? (
                  <Check size={14} className="context-menu__check" />
                ) : entry.shortcut ? (
                  <span className="context-menu__shortcut">{entry.shortcut}</span>
                ) : undefined
              }
              color={entry.danger ? 'red' : undefined}
              disabled={entry.disabled}
              onClick={() => {
                onAction?.();
                entry.onClick();
              }}
            >
              {entry.label}
            </Menu.Item>
          </Fragment>
        );
      })}
    </>
  );
}

export function ContextMenuHost() {
  const state = useStore(menuStore);

  useEffect(() => {
    if (!state) return;
    const close = (e: Event) => {
      // Scrolling inside the menu itself (long lists) must not close it.
      if (e.type === 'scroll' && (e.target as Element | null)?.closest?.('.context-menu')) return;
      closeContextMenu();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [state]);

  if (!state) return null;
  return (
    <Menu
      key={state.key}
      opened
      onClose={closeContextMenu}
      position="bottom-start"
      offset={2}
      shadow="md"
      width={240}
      withinPortal
      closeOnItemClick
      returnFocus={false}
    >
      <Menu.Target>
        <div
          aria-hidden
          style={{ position: 'fixed', left: state.x, top: state.y, width: 1, height: 1, pointerEvents: 'none' }}
        />
      </Menu.Target>
      <Menu.Dropdown className="context-menu" onContextMenu={(e) => e.preventDefault()}>
        <MenuEntries entries={state.entries} onAction={closeContextMenu} />
      </Menu.Dropdown>
    </Menu>
  );
}
