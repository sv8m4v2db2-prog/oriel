// Block selection: a rubber band (marquee) drawn from the page margins or the gaps between
// blocks selects every block it touches (blocks inside columns individually); Escape in a block selects
// it; Shift+↑/↓ and Shift+click on a drag handle extend the range. Selected blocks get a blue highlight
// and the bulk actions: Backspace/Delete, ⌘C/⌘X/⌘V, ⌘D, Tab/Shift+Tab, Enter or typing to edit, ⌘A,
// ↑/↓, Escape, the block right-click menu and the drag handle (moves the whole group).
//
// The selection is kept here (ids of blocks), not as a ProseMirror selection: typing with a range
// selection would replace the blocks, and the set may span several columns. The highlight is drawn in an
// overlay layer (ProseMirror owns the blocks' DOM). The native multi-block selection is only set right
// before a drag of the group, through BlockNote's own selection classes (never import prosemirror-state:
// a second copy breaks the editor in development).
import { useEffect, useRef, type RefObject } from 'react';
import type { Block, BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';
import { isMac } from '../lib/util';
import { normalizeCodeBlocks } from './codeLanguages';
import { insertBlockCopies, stripIds } from './blockActions';
import type { EditorEnv } from './env';
import {
  autoScrollDelta,
  collectUnits,
  contiguousGroups,
  hitTest,
  indexBlocks,
  navigationOrder,
  rangeBetween,
  rectFromPoints,
  removeDescendants,
  sortByOrder,
  stepRange,
  type BlockLike,
  type Rect,
} from './blockSelectionLogic';
import './blockSelection.css';

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = Block<any, any, any>;

/** Where a press may start a marquee: never on controls, text, other editors or the page's widgets. */
const NO_MARQUEE = [
  'input',
  'textarea',
  'select',
  'button',
  'a',
  'label',
  'iframe',
  '[role="button"]',
  '[role="menu"]',
  '[role="dialog"]',
  '.page-cover',
  '.page-row-props',
  '.page-database',
  '.page-backlinks',
  '.trash-banner',
  '.or-db-block',
  '.or-discussion',
  '.or-comments-panel',
  '.bn-side-menu',
  '.bn-formatting-toolbar',
  '.bn-suggestion-menu',
  '.bn-table-handle',
  '.mantine-Menu-dropdown',
  '.mantine-Popover-dropdown',
  '.context-menu',
].join(', ');

/** Menus that act on the selection: pressing in them keeps it. */
const KEEPS_SELECTION = '.context-menu, .mantine-Menu-dropdown, .mantine-Popover-dropdown, .mantine-Modal-root, .toaster';

const ACTIVATION_DISTANCE = 4;

function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p !== document.body) return p;
  }
  return document.scrollingElement as HTMLElement;
}

function isEditableOutside(target: EventTarget | null, editorDom: HTMLElement | undefined): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el || (editorDom && editorDom.contains(el))) return false;
  return el.isContentEditable || !!el.closest('input, textarea, select');
}

const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/**
 * BlockNote's Selection base class (from its own prosemirror-state copy), to build selections by JSON
 * (`{ type: 'text' | 'node', … }`; BlockNote's "multiple-node" selection has no fromJSON).
 */
function selectionBase(editor: AnyEditor): { fromJSON(doc: unknown, json: unknown): unknown } | null {
  let C: any = editor.prosemirrorState.selection.constructor;
  while (C && Object.getPrototypeOf(C)?.fromJSON) C = Object.getPrototypeOf(C);
  return C && typeof C.fromJSON === 'function' ? C : null;
}

/**
 * Text positions spanning the block containers `firstId`…`lastId` (same parent): start of the first
 * block's content, end of the last block's own content. BlockNote's drag handle turns such a selection
 * into a multi-block drag of the whole range.
 */
function textSpan(editor: AnyEditor, firstId: string, lastId: string): { anchor: number; head: number } | null {
  let anchor = -1;
  let head = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (head !== -1) return false;
    if (node.type.name === 'blockContainer') {
      if (node.attrs.id === firstId) anchor = pos + 2;
      if (node.attrs.id === lastId && node.firstChild) head = pos + node.firstChild.nodeSize;
    }
    return true;
  });
  return anchor !== -1 && head >= anchor ? { anchor, head } : null;
}

const hasInlineContent = (b: AnyBlock | undefined) => !!b && Array.isArray(b.content);

// ---------------------------------------------------------------------------
// Controller (one per mounted editor)
// ---------------------------------------------------------------------------

let active: BlockSelectionController | null = null;
const controllers = new WeakMap<AnyEditor, BlockSelectionController>();

class BlockSelectionController {
  ids: string[] = [];
  private anchor: string | null = null;
  private head: string | null = null;
  private layer: HTMLDivElement;
  private scroller: HTMLElement;
  private disposers: Array<() => void> = [];
  private paintQueued = false;
  private swallowNextClick = false;
  private marqueeCleanup: (() => void) | null = null;

  constructor(
    readonly editor: AnyEditor,
    readonly wrap: HTMLElement,
    private readonly env: () => EditorEnv,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'or-block-selection-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.scroller = scrollParent(wrap);
  }

  private get canEdit() {
    return this.env().canEdit && this.editor.isEditable;
  }

  mount() {
    this.wrap.appendChild(this.layer);
    const on = <K extends string>(target: EventTarget, type: K, fn: (e: any) => void, capture = true) => {
      target.addEventListener(type, fn, capture);
      this.disposers.push(() => target.removeEventListener(type, fn, capture));
    };
    on(this.scroller, 'mousedown', this.onScrollerMouseDown);
    on(document, 'mousedown', this.onDocumentMouseDown);
    on(document, 'click', this.onDocumentClick);
    on(document, 'keydown', this.onKeyDown);
    on(document, 'copy', this.onCopy);
    on(document, 'cut', this.onCut);
    on(document, 'paste', this.onPaste);
    on(document, 'dragstart', this.onDragStart);
    on(window, 'resize', this.schedulePaint, false);
    const off = this.editor.onChange(() => this.onDocumentChange());
    this.disposers.push(() => {
      if (typeof off === 'function') off();
    });
    const dom = this.editor.domElement;
    if (dom && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(this.schedulePaint);
      ro.observe(dom);
      this.disposers.push(() => ro.disconnect());
    }
    controllers.set(this.editor, this);
  }

  unmount() {
    this.marqueeCleanup?.();
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.layer.remove();
    this.wrap.classList.remove('has-block-selection');
    if (active === this) active = null;
    if (controllers.get(this.editor) === this) controllers.delete(this.editor);
  }

  // --- state ------------------------------------------------------------------------------

  has(id: string) {
    return this.ids.includes(id);
  }

  /** Selects `ids` (sorted into document order unless `ordered`). */
  select(ids: string[], anchor?: string | null, head?: string | null, ordered = false) {
    this.ids = ordered ? [...ids] : sortByOrder(ids, indexBlocks(this.editor.document as BlockLike[]).order);
    this.anchor = anchor ?? this.ids[0] ?? null;
    this.head = head ?? this.ids[this.ids.length - 1] ?? null;
    if (this.ids.length) {
      if (active && active !== this) active.clear();
      active = this;
    } else if (active === this) active = null;
    this.paint();
  }

  clear() {
    if (!this.ids.length && active !== this) return;
    this.ids = [];
    this.anchor = this.head = null;
    if (active === this) active = null;
    this.paint();
  }

  /** Selected blocks, top-most only (a selected block's selected descendants are covered by it). */
  blocks(): AnyBlock[] {
    const { byId, order } = indexBlocks(this.editor.document as BlockLike[]);
    return removeDescendants(sortByOrder(this.ids, order), byId)
      .map((id) => this.editor.getBlock(id))
      .filter((b): b is AnyBlock => !!b);
  }

  private onDocumentChange() {
    if (this.ids.length) {
      const { order } = indexBlocks(this.editor.document as BlockLike[]);
      const kept = sortByOrder(this.ids, order);
      if (kept.length !== this.ids.length) {
        if (kept.length) this.select(kept, kept.includes(this.anchor ?? '') ? this.anchor : null);
        else this.clear();
        return;
      }
    }
    this.schedulePaint();
  }

  /** Hands the keyboard over to the selection: no caret, no text selection, no focused field. */
  private releaseFocus() {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body) el.blur();
    window.getSelection()?.removeAllRanges();
  }

  // --- painting ---------------------------------------------------------------------------

  schedulePaint = () => {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paint();
    });
  };

  private elementOf(id: string): HTMLElement | null {
    return this.editor.domElement?.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(id)}"]`) ?? null;
  }

  paint() {
    this.wrap.classList.toggle('has-block-selection', this.ids.length > 0);
    if (!this.ids.length) {
      this.layer.replaceChildren();
      return;
    }
    const host = this.wrap.getBoundingClientRect();
    const boxes: HTMLElement[] = [];
    for (const id of this.ids) {
      const el = this.elementOf(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const box = document.createElement('div');
      box.className = 'or-block-selection-box';
      box.style.top = `${r.top - host.top}px`;
      box.style.left = `${r.left - host.left - 4}px`;
      box.style.width = `${r.width + 8}px`;
      box.style.height = `${r.height}px`;
      boxes.push(box);
    }
    this.layer.replaceChildren(...boxes);
  }

  // --- marquee ------------------------------------------------------------------------------

  private canStartMarquee(e: MouseEvent): boolean {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !this.scroller.contains(el)) return false;
    // Scroll bar of the container.
    if (el === this.scroller) {
      const r = this.scroller.getBoundingClientRect();
      if (e.clientX >= r.left + this.scroller.clientWidth) return false;
    }
    if (el.closest(NO_MARQUEE)) return false;
    const dom = this.editor.domElement;
    if (dom?.contains(el)) {
      // Inside the editor, only the gaps between blocks (never a block's own content or widgets).
      return !el.closest('.bn-block-content, .ProseMirror-widget');
    }
    // Outside the editor: anywhere else in this page (margins, padding, below the content), but not in
    // another editor (comments) or another page's content.
    if (el.closest('.ProseMirror, [contenteditable="true"]')) return false;
    const page = this.wrap.closest('.page, .public__main');
    return !page || page.contains(el) || el.contains(page);
  }

  private onScrollerMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (!this.canStartMarquee(e)) return;
    // No text selection, and ProseMirror ignores the press (defaultPrevented events don't reach it).
    e.preventDefault();
    this.startMarquee(e);
  };

  private startMarquee(down: MouseEvent) {
    this.marqueeCleanup?.();
    const scroller = this.scroller;
    const start = { x: down.clientX, y: down.clientY + scroller.scrollTop };
    let pointer = { x: down.clientX, y: down.clientY };
    let activated = false;
    let box: HTMLDivElement | null = null;
    let raf = 0;

    const update = () => {
      const marquee = rectFromPoints({ x: start.x, y: start.y - scroller.scrollTop }, pointer);
      if (box) {
        const clip = scroller.getBoundingClientRect();
        const left = Math.max(marquee.left, clip.left);
        const top = Math.max(marquee.top, clip.top);
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${Math.max(0, Math.min(marquee.right, clip.right) - left)}px`;
        box.style.height = `${Math.max(0, Math.min(marquee.bottom, clip.bottom) - top)}px`;
      }
      // Units come in document order: hits are already sorted.
      const units = collectUnits(this.editor.document as BlockLike[]);
      const measured = units.flatMap((unit) => {
        const el = this.elementOf(unit.id);
        return el ? [{ unit, rect: toRect(el.getBoundingClientRect()) }] : [];
      });
      const hits = hitTest(marquee, measured);
      if (hits.length) this.select(hits, hits[0], hits[hits.length - 1], true);
      else this.clear();
    };

    const tick = () => {
      raf = 0;
      if (!activated) return;
      const clip = scroller.getBoundingClientRect();
      const delta = autoScrollDelta(pointer.y, Math.max(clip.top, 0), Math.min(clip.bottom, window.innerHeight));
      if (delta !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop += delta;
        if (scroller.scrollTop !== before) update();
        raf = requestAnimationFrame(tick);
      }
    };

    const onMove = (e: MouseEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!activated) {
        if (Math.hypot(pointer.x - down.clientX, pointer.y - start.y + scroller.scrollTop) < ACTIVATION_DISTANCE) return;
        activated = true;
        this.releaseFocus();
        document.body.classList.add('or-marquee-active');
        box = document.createElement('div');
        box.className = 'or-marquee';
        document.body.appendChild(box);
      }
      e.preventDefault();
      update();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onScroll = () => {
      if (activated) update();
    };
    const finish = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', finish, true);
      window.removeEventListener('blur', finish);
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      box?.remove();
      document.body.classList.remove('or-marquee-active');
      this.marqueeCleanup = null;
      // A drag ends with a click on whatever is under the pointer: don't let it clear the selection.
      if (activated) this.swallowNextClick = true;
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', finish, true);
    window.addEventListener('blur', finish);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    this.marqueeCleanup = finish;
  }

  // --- pointer: clearing, Shift+click on handles ---------------------------------------------

  private sideMenuBlock(): AnyBlock | undefined {
    return (this.editor.getExtension(SideMenuExtension) as any)?.store?.state?.block;
  }

  private onDocumentMouseDown = (e: MouseEvent) => {
    // A click swallowed after a marquee only follows its own mouseup.
    this.swallowNextClick = false;
    const el = e.target instanceof Element ? e.target : null;
    const handle = el?.closest('.bn-side-menu');
    if (handle && this.wrap.contains(handle) && e.shiftKey && e.button === 0) {
      // Shift+click on a drag handle: range from the anchor (selection, or the caret's block).
      const block = this.sideMenuBlock();
      let anchor = this.anchor;
      if (!anchor && this.editor.isFocused()) {
        try {
          anchor = this.editor.getTextCursorPosition().block.id;
        } catch {
          anchor = null;
        }
      }
      if (block) {
        e.preventDefault();
        e.stopPropagation();
        this.swallowNextClick = true;
        const { byId } = indexBlocks(this.editor.document as BlockLike[]);
        const units = collectUnits(this.editor.document as BlockLike[]);
        const order = navigationOrder(anchor ?? block.id, units, byId);
        const ids = anchor && order.includes(block.id) ? rangeBetween(order, anchor, block.id) : [block.id];
        this.releaseFocus();
        this.select(ids, anchor ?? block.id, block.id);
      }
      return;
    }
    if (!this.ids.length) return;
    if (el?.closest(KEEPS_SELECTION)) return;
    if (handle) {
      const block = this.sideMenuBlock();
      if (block && this.has(block.id)) return; // dragging / opening the menu of the selection
    }
    if (e.button === 2 && el && this.ids.some((id) => this.elementOf(id)?.contains(el))) return; // right-click on it
    this.clear();
  };

  private onDocumentClick = (e: MouseEvent) => {
    if (!this.swallowNextClick) return;
    this.swallowNextClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  /** Dragging a selected block's handle moves the whole group (native multi-block selection). */
  private onDragStart = (e: DragEvent) => {
    if (!this.ids.length || !(e.target instanceof Element) || !e.target.closest('.bn-side-menu')) return;
    const block = this.sideMenuBlock();
    if (!block || !this.has(block.id)) return;
    const { byId, order } = indexBlocks(this.editor.document as BlockLike[]);
    const top = removeDescendants(sortByOrder(this.ids, order), byId);
    const groups = contiguousGroups(top, byId, order);
    if (groups.length !== 1 || groups[0]!.length < 2) return;
    const group = groups[0]!;
    const span = textSpan(this.editor, group[0]!, group[group.length - 1]!);
    const Selection = selectionBase(this.editor);
    if (!span || !Selection) return;
    try {
      const sel = Selection.fromJSON(this.editor.prosemirrorState.doc, { type: 'text', ...span });
      this.editor.transact((tr) => tr.setSelection(sel as never));
    } catch (err) {
      console.warn('[Oriel] sélection de blocs (glisser) :', err);
    }
  };

  // --- keyboard ------------------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    const dom = this.editor.domElement;

    if (!this.ids.length) {
      // Escape in a block (caret or text selection): select the block(s).
      if (e.key !== 'Escape' || mod || e.shiftKey || e.altKey) return;
      if (!dom || !(e.target instanceof Node) || !dom.contains(e.target)) return;
      // A field inside a block (bookmark / embed URL, equation, drawing…) handles its own Escape.
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="false"]')) return;
      if (document.querySelector('.bn-suggestion-menu')) return;
      let ids: string[] = [];
      try {
        ids = (this.editor.getSelection()?.blocks ?? [this.editor.getTextCursorPosition().block]).map((b) => b.id);
      } catch {
        return;
      }
      if (!ids.length) return;
      e.preventDefault();
      e.stopPropagation();
      this.releaseFocus();
      this.select(ids);
      return;
    }

    // Keys typed in a field or a dialog (search, page picker…) are not for the selection.
    if (isEditableOutside(e.target, dom) || (e.target instanceof Element && e.target.closest('[role="dialog"]'))) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (key === 'Escape') {
      stop();
      this.clear();
    } else if (key === 'Backspace' || key === 'Delete') {
      stop();
      if (this.canEdit) this.deleteSelection();
    } else if (key === 'Enter') {
      stop();
      this.edit(null);
    } else if (key === 'Tab') {
      stop();
      if (this.canEdit) this.indent(e.shiftKey ? -1 : 1);
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      stop();
      this.step(key === 'ArrowUp' ? -1 : 1, e.shiftKey);
    } else if (mod && !e.altKey && lower === 'a') {
      stop();
      const units = collectUnits(this.editor.document as BlockLike[]).map((u) => u.id);
      this.select(units);
    } else if (mod && !e.altKey && lower === 'd') {
      stop();
      if (this.canEdit) this.duplicate();
    } else if (mod && !e.altKey && (lower === 'z' || lower === 'y')) {
      stop();
      if (!this.canEdit) return;
      this.clear();
      if (lower === 'y' || e.shiftKey) this.editor.redo();
      else this.editor.undo();
      this.editor.focus();
    } else if (mod && !e.altKey && !e.shiftKey && (lower === 'c' || lower === 'x')) {
      // No text selection / focused field here: trigger the clipboard event ourselves (handled below).
      stop();
      document.execCommand(lower === 'c' ? 'copy' : 'cut');
    } else if (!mod && !e.ctrlKey && !e.metaKey && key.length === 1) {
      stop();
      this.edit(key);
    }
  };

  private step(dir: -1 | 1, extend: boolean) {
    const doc = this.editor.document as BlockLike[];
    const { byId } = indexBlocks(doc);
    const units = collectUnits(doc);
    if (extend && this.anchor && this.head) {
      const order = navigationOrder(this.anchor, units, byId);
      const { head, ids } = stepRange(order, this.anchor, this.head, dir);
      this.select(ids, this.anchor, head);
    } else if (this.head) {
      const order = navigationOrder(this.head, units, byId);
      const i = order.indexOf(dir < 0 ? (this.ids[0] ?? this.head) : (this.ids[this.ids.length - 1] ?? this.head));
      const next = order[Math.min(order.length - 1, Math.max(0, i + dir))];
      if (next) this.select([next]);
    }
    this.elementOf(this.head ?? '')?.scrollIntoView({ block: 'nearest' });
  }

  // --- actions -------------------------------------------------------------------------------

  deleteSelection() {
    const blocks = this.blocks();
    if (!blocks.length) return;
    this.clear();
    this.editor.removeBlocks(blocks);
    this.editor.focus();
  }

  /** Duplicates each run of consecutive selected blocks after itself; the copies become the selection. */
  duplicate() {
    const doc = this.editor.document as BlockLike[];
    const { byId, order } = indexBlocks(doc);
    const groups = contiguousGroups(removeDescendants(sortByOrder(this.ids, order), byId), byId, order);
    const copies: string[] = [];
    this.editor.transact(() => {
      for (const group of groups) {
        const blocks = group.map((id) => this.editor.getBlock(id)).filter((b): b is AnyBlock => !!b);
        if (!blocks.length) continue;
        const inserted = insertBlockCopies(this.editor, blocks, blocks[blocks.length - 1]!);
        copies.push(...inserted.map((b) => b.id));
      }
    });
    if (copies.length) this.select(copies);
  }

  /** Tab / Shift+Tab: nest each run into its previous sibling, or move it after its parent block. */
  indent(dir: 1 | -1) {
    const doc = this.editor.document as BlockLike[];
    const { byId, order } = indexBlocks(doc);
    const groups = contiguousGroups(removeDescendants(sortByOrder(this.ids, order), byId), byId, order).reverse();
    const kept = [...this.ids];
    this.editor.transact(() => {
      for (const group of groups) {
        const loc = byId.get(group[0]!);
        if (!loc) continue;
        const blocks = group.map((id) => this.editor.getBlock(id)).filter((b): b is AnyBlock => !!b);
        if (dir > 0) {
          if (loc.index === 0) continue;
          const prev = this.editor.getBlock(loc.siblings[loc.index - 1]!);
          if (!prev || prev.type === 'columnList' || prev.type === 'column') continue;
          this.editor.removeBlocks(blocks);
          this.editor.updateBlock(prev.id, { children: [...prev.children, ...blocks] } as never);
        } else {
          if (loc.parentType !== 'block' || !loc.parentId) continue;
          this.editor.removeBlocks(blocks);
          this.editor.insertBlocks(blocks, loc.parentId, 'after');
        }
      }
    });
    this.select(kept, this.anchor, this.head);
  }

  /** Enter / typing: edit the last selected block (a new paragraph after a block without text). */
  edit(char: string | null) {
    const last = this.blocks().pop();
    this.clear();
    if (!last || !this.canEdit) return;
    try {
      let target: AnyBlock = last;
      if (!hasInlineContent(last)) {
        target = this.editor.insertBlocks([{ type: 'paragraph' } as never], last, 'after')[0] as AnyBlock;
      }
      this.editor.setTextCursorPosition(target, 'end');
      this.editor.focus();
      if (char) this.editor.insertInlineContent(char as never);
    } catch {
      /* block without a text position */
    }
  }

  // --- clipboard -----------------------------------------------------------------------------

  private writeClipboard(data: DataTransfer, blocks: AnyBlock[]) {
    data.setData('blocknote/html', this.editor.blocksToFullHTML(blocks as never));
    data.setData('text/html', this.editor.blocksToHTMLLossy(blocks as never));
    data.setData('text/plain', this.editor.blocksToMarkdownLossy(blocks as never));
  }

  private onCopy = (e: ClipboardEvent) => {
    if (!this.ids.length || !e.clipboardData || isEditableOutside(e.target, this.editor.domElement)) return;
    const blocks = this.blocks();
    if (!blocks.length) return;
    e.preventDefault();
    e.stopPropagation();
    this.writeClipboard(e.clipboardData, blocks);
  };

  private onCut = (e: ClipboardEvent) => {
    if (!this.ids.length || !e.clipboardData || isEditableOutside(e.target, this.editor.domElement)) return;
    const blocks = this.blocks();
    if (!blocks.length) return;
    e.preventDefault();
    e.stopPropagation();
    this.writeClipboard(e.clipboardData, blocks);
    if (this.canEdit) this.deleteSelection();
  };

  /** Paste with blocks selected: the pasted blocks go after the selection and become the selection. */
  private onPaste = (e: ClipboardEvent) => {
    if (!this.ids.length || !e.clipboardData || isEditableOutside(e.target, this.editor.domElement)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.canEdit) return;
    const data = e.clipboardData;
    const internal = data.getData('blocknote/html');
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    let parsed: AnyBlock[] = [];
    try {
      if (internal) parsed = this.editor.tryParseHTMLToBlocks(internal) as AnyBlock[];
      else if (html) parsed = this.editor.tryParseHTMLToBlocks(html) as AnyBlock[];
      else if (text) parsed = this.editor.tryParseMarkdownToBlocks(text) as AnyBlock[];
    } catch (err) {
      console.error('[Oriel] collage de blocs', err);
    }
    const blocks = normalizeCodeBlocks(parsed as never[]).map(stripIds);
    const last = this.blocks().pop();
    if (!blocks.length || !last) return;
    const inserted = this.editor.insertBlocks(blocks as never, last, 'after');
    this.select(inserted.map((b) => b.id));
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Mounts the block selection on an editor (rendered inside `wrapRef`, the `.or-editor-wrap`). */
export function useBlockSelection(editor: AnyEditor, env: EditorEnv, wrapRef: RefObject<HTMLElement | null>): void {
  const envRef = useRef(env);
  envRef.current = env;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const controller = new BlockSelectionController(editor, wrap, () => envRef.current);
    controller.mount();
    return () => controller.unmount();
  }, [editor, wrapRef]);
}

/** Currently selected blocks of `editor` (top-most only), [] when none. */
export function selectedBlocksOf(editor: AnyEditor): AnyBlock[] {
  return controllers.get(editor)?.blocks() ?? [];
}

/** Blocks targeted by an action on `block`: the whole block selection when `block` is part of it. */
export function actionTargets(editor: AnyEditor, block: AnyBlock): AnyBlock[] {
  const c = controllers.get(editor);
  if (!c || !c.has(block.id)) return [block];
  const blocks = c.blocks();
  return blocks.length ? blocks : [block];
}

/** Duplicates the targets (runs of consecutive blocks after themselves) and selects the copies. */
export function duplicateTargets(editor: AnyEditor, blocks: AnyBlock[]): void {
  const c = controllers.get(editor);
  if (c && blocks.length > 1 && blocks.every((b) => c.has(b.id))) c.duplicate();
  else {
    const last = blocks[blocks.length - 1];
    if (last) insertBlockCopies(editor, blocks, last);
  }
}

export function clearBlockSelection(editor: AnyEditor): void {
  controllers.get(editor)?.clear();
}
