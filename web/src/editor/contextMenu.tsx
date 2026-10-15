// Right-click menus of the editor: blocks (anywhere on a block or on its handle) and page references.
import { useCallback, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Block, BlockNoteEditor } from '@blocknote/core';
import { SideMenuExtension } from '@blocknote/core/extensions';
import {
  ArrowUpRight,
  Bookmark,
  Copy,
  ExternalLink,
  FileText,
  FolderInput,
  Globe,
  Link2,
  MessageSquareText,
  Palette,
  Repeat,
  Trash2,
} from 'lucide-react';
import { COLORS, COLOR_LABELS, EDITOR_BLOCK_TYPES } from '@oriel/shared';
import { openContextMenu, type ContextMenuEntries, type ContextMenuEntry } from '../components/ContextMenu';
import { toast } from '../lib/ui';
import { copyToClipboard, modKey } from '../lib/util';
import { safeWebUrl } from '../lib/safeUrl';
import {
  TRANSFORM_TARGETS,
  blockCommentAction,
  copyBlockLink,
  duplicateBlocks,
  hasBackgroundColor,
  hasTextColor,
  isCurrentTarget,
  isTransformable,
  pickPageAndMoveBlocks,
  removeBlocks,
  setBlockColor,
  transformBlock,
} from './blockActions';
import { detectProvider, isKnownEmbeddable } from './embeds';
import { isPdfUrl } from './mediaBlocks';
import { openPageRef, pageRefHref, type EditorEnv } from './env';
import { clearBlockSelection, duplicateTargets, selectedBlocksOf } from './blockSelection';

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = Block<any, any, any>;

function colorSwatch(color: string, kind: 'text' | 'background') {
  if (kind === 'text') {
    return (
      <span className="or-swatch or-swatch--text" style={{ color: color === 'default' ? 'var(--text)' : `var(--tag-${color}-fg)` }}>
        A
      </span>
    );
  }
  return <span className="or-swatch" style={{ background: color === 'default' ? 'var(--bg)' : `var(--bg-${color})` }} />;
}

function colorEntries(editor: AnyEditor, block: AnyBlock): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  if (hasTextColor(block)) {
    out.push({ header: 'Texte' });
    for (const c of COLORS) {
      out.push({
        label: COLOR_LABELS[c],
        icon: colorSwatch(c, 'text'),
        checked: (block.props.textColor ?? 'default') === c,
        onClick: () => setBlockColor(editor, block, 'text', c),
      });
    }
  }
  if (hasBackgroundColor(block) || block.type === 'callout') {
    out.push({ header: 'Arrière-plan' });
    for (const c of COLORS) {
      out.push({
        label: COLOR_LABELS[c],
        icon: colorSwatch(c, 'background'),
        checked: (block.props.backgroundColor ?? 'default') === c,
        onClick: () => setBlockColor(editor, block, 'background', c),
      });
    }
  }
  return out;
}

/** Entries of the block menu (right-click on a block or on its handle). */
export function blockMenuEntries(editor: AnyEditor, env: EditorEnv, block: AnyBlock): ContextMenuEntries {
  const canEdit = env.canEdit && editor.isEditable;
  const linkUrl: string = typeof block.props?.url === 'string' ? block.props.url : '';
  const comment = canEdit && env.mode === 'app' ? blockCommentAction(editor, block) : null;
  const isMediaLink = block.type === EDITOR_BLOCK_TYPES.embed || block.type === EDITOR_BLOCK_TYPES.bookmark;
  const pdfFile = block.type === 'file' && !!linkUrl && isPdfUrl(linkUrl, block.props.name);

  const media: ContextMenuEntries =
    isMediaLink && linkUrl
      ? [
          // linkUrl is a prop of the shared document: only web addresses are opened.
          !!safeWebUrl(linkUrl) && {
            label: 'Ouvrir le lien',
            icon: <ExternalLink size={15} />,
            onClick: () => window.open(safeWebUrl(linkUrl)!, '_blank', 'noopener,noreferrer'),
          },
          {
            label: 'Copier l’adresse du lien',
            icon: <Link2 size={15} />,
            onClick: () => void copyToClipboard(linkUrl).then((ok) => (ok ? toast.success('Adresse copiée') : toast.error('Copie impossible'))),
          },
          canEdit &&
            block.type === EDITOR_BLOCK_TYPES.embed && {
              label: 'Convertir en signet',
              icon: <Bookmark size={15} />,
              onClick: () => {
                editor.updateBlock(block, { type: EDITOR_BLOCK_TYPES.bookmark, props: { url: linkUrl } } as never);
              },
            },
          canEdit &&
            block.type === EDITOR_BLOCK_TYPES.bookmark &&
            isKnownEmbeddable(linkUrl) && {
              label: 'Convertir en intégration',
              icon: <Globe size={15} />,
              onClick: () => {
                const info = detectProvider(linkUrl)!;
                editor.updateBlock(block, {
                  type: EDITOR_BLOCK_TYPES.embed,
                  props: { url: linkUrl, provider: info.provider, height: info.defaultHeight },
                } as never);
              },
            },
          { divider: true },
        ]
      : [];

  return [
    ...media,
    canEdit &&
      pdfFile && {
        label: 'Afficher dans une visionneuse PDF',
        icon: <FileText size={15} />,
        onClick: () => {
          editor.replaceBlocks([block], [{ type: EDITOR_BLOCK_TYPES.pdf, props: { url: linkUrl, name: block.props.name ?? '' } } as never]);
        },
      },
    comment && { label: 'Commenter', icon: <MessageSquareText size={15} />, onClick: comment },
    { label: 'Copier le lien du bloc', icon: <Link2 size={15} />, onClick: () => void copyBlockLink(env, block.id) },
    canEdit && { divider: true },
    canEdit && {
      label: 'Dupliquer',
      icon: <Copy size={15} />,
      shortcut: `${modKey()}D`,
      onClick: () => duplicateBlocks(editor, [block]),
    },
    canEdit &&
      isTransformable(block) && {
        label: 'Transformer en',
        icon: <Repeat size={15} />,
        submenu: TRANSFORM_TARGETS.map((t) => ({
          label: t.label,
          checked: isCurrentTarget(block, t),
          onClick: () => transformBlock(editor, block, t),
        })),
      },
    canEdit &&
      (hasTextColor(block) || hasBackgroundColor(block) || block.type === 'callout') && {
        label: 'Couleur',
        icon: <Palette size={15} />,
        submenu: colorEntries(editor, block),
      },
    canEdit &&
      env.mode === 'app' &&
      !!env.workspaceId && {
        label: 'Déplacer vers…',
        icon: <FolderInput size={15} />,
        onClick: () => pickPageAndMoveBlocks(editor, env, [block]),
      },
    canEdit && { divider: true },
    canEdit && {
      label: 'Supprimer',
      icon: <Trash2 size={15} />,
      shortcut: 'Suppr',
      danger: true,
      onClick: () => removeBlocks(editor, [block]),
    },
  ];
}

/** Colors applied to several blocks at once (checked when they all have it). */
function multiColorEntries(editor: AnyEditor, blocks: AnyBlock[]): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  const apply = (kind: 'text' | 'background', c: string) =>
    editor.transact(() => {
      for (const b of blocks) {
        const current = editor.getBlock(b.id);
        if (current && (kind === 'text' ? hasTextColor(current) : hasBackgroundColor(current) || current.type === 'callout')) {
          setBlockColor(editor, current, kind, c);
        }
      }
    });
  const text = blocks.filter(hasTextColor);
  const background = blocks.filter((b) => hasBackgroundColor(b) || b.type === 'callout');
  if (text.length) {
    out.push({ header: 'Texte' });
    for (const c of COLORS) {
      out.push({
        label: COLOR_LABELS[c],
        icon: colorSwatch(c, 'text'),
        checked: text.every((b) => (b.props.textColor ?? 'default') === c),
        onClick: () => apply('text', c),
      });
    }
  }
  if (background.length) {
    out.push({ header: 'Arrière-plan' });
    for (const c of COLORS) {
      out.push({
        label: COLOR_LABELS[c],
        icon: colorSwatch(c, 'background'),
        checked: background.every((b) => (b.props.backgroundColor ?? 'default') === c),
        onClick: () => apply('background', c),
      });
    }
  }
  return out;
}

/** Entries of the menu of a block selection (several blocks selected with the rubber band / keyboard). */
export function selectionMenuEntries(editor: AnyEditor, env: EditorEnv, blocks: AnyBlock[]): ContextMenuEntries {
  const canEdit = env.canEdit && editor.isEditable;
  const first = blocks[0];
  if (!first) return [];
  const comment = canEdit && env.mode === 'app' ? blockCommentAction(editor, first) : null;
  const transformable = blocks.filter(isTransformable);
  const colorable = blocks.filter((b) => hasTextColor(b) || hasBackgroundColor(b) || b.type === 'callout');
  return [
    { header: `${blocks.length} blocs sélectionnés` },
    comment && {
      label: 'Commenter',
      icon: <MessageSquareText size={15} />,
      onClick: () => {
        clearBlockSelection(editor);
        comment();
      },
    },
    canEdit && {
      label: 'Dupliquer',
      icon: <Copy size={15} />,
      shortcut: `${modKey()}D`,
      onClick: () => duplicateTargets(editor, blocks),
    },
    canEdit &&
      transformable.length > 0 && {
        label: 'Transformer en',
        icon: <Repeat size={15} />,
        submenu: TRANSFORM_TARGETS.map((t) => ({
          label: t.label,
          checked: transformable.every((b) => isCurrentTarget(b, t)),
          onClick: () =>
            editor.transact(() => {
              for (const b of transformable) {
                const current = editor.getBlock(b.id);
                if (current) transformBlock(editor, current, t);
              }
            }),
        })),
      },
    canEdit &&
      colorable.length > 0 && {
        label: 'Couleur',
        icon: <Palette size={15} />,
        submenu: multiColorEntries(editor, colorable),
      },
    canEdit &&
      env.mode === 'app' &&
      !!env.workspaceId && {
        label: 'Déplacer vers…',
        icon: <FolderInput size={15} />,
        onClick: () => pickPageAndMoveBlocks(editor, env, blocks),
      },
    canEdit && { divider: true },
    canEdit && {
      label: 'Supprimer',
      icon: <Trash2 size={15} />,
      shortcut: 'Suppr',
      danger: true,
      onClick: () => {
        clearBlockSelection(editor);
        removeBlocks(editor, blocks);
      },
    },
  ];
}

/** Entries for a page link, a page mention or a sub-page card. */
export function pageRefEntries(env: EditorEnv, pageId: string): ContextMenuEntries {
  if (!pageId) return [];
  const href = `${location.origin}${pageRefHref(env, pageId)}`;
  return [
    { label: 'Ouvrir', icon: <ArrowUpRight size={15} />, onClick: () => openPageRef(env, pageId) },
    { label: 'Ouvrir dans un nouvel onglet', icon: <ExternalLink size={15} />, onClick: () => window.open(href, '_blank', 'noopener') },
    {
      label: 'Copier le lien',
      icon: <Link2 size={15} />,
      onClick: () => void copyToClipboard(href).then((ok) => (ok ? toast.success('Lien copié') : toast.error('Copie impossible'))),
    },
  ];
}

/**
 * Handlers for the editor wrapper. A text selection keeps the browser's menu (spell checking, copy…)
 * when the right click lands inside it; Maj + clic droit always opens the browser's menu.
 */
export function useEditorContextMenu(editor: AnyEditor, env: EditorEnv) {
  const hadSelectionUnderPointer = useRef(false);

  const onPointerDownCapture = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 2) return;
    const sel = window.getSelection();
    hadSelectionUnderPointer.current = !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.containsNode(e.target as Node, true);
  }, []);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      if (e.shiftKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      // Form fields (embed URL inputs…) and inline databases (own menus) keep their behavior.
      if (target.closest('input, textarea, select, .or-db-block, .bn-suggestion-menu, .mantine-Menu-dropdown')) return;

      const refEl = target.closest<HTMLElement>('.or-pageref, .or-mention');
      if (refEl?.dataset.pageId) {
        const blockEl = refEl.closest<HTMLElement>('[data-node-type="blockContainer"]');
        const block = refEl.classList.contains('or-pageref') && blockEl?.dataset.id ? editor.getBlock(blockEl.dataset.id) : undefined;
        const blockPart = block ? blockMenuEntries(editor, env, block).filter((x) => x && !('label' in x && x.label === 'Copier le lien du bloc')) : [];
        openContextMenu(e, [...pageRefEntries(env, refEl.dataset.pageId), ...(blockPart.length ? [{ divider: true } as const, ...blockPart] : [])]);
        return;
      }

      // Right-click on a block of a multi-block selection: the menu acts on all of them.
      const selection = selectedBlocksOf(editor);
      if (selection.length > 1) {
        const handleBlock = target.closest('.bn-side-menu') ? editor.getExtension(SideMenuExtension)?.store.state?.block : undefined;
        const onSelection = handleBlock
          ? selection.some((b) => b.id === handleBlock.id)
          : selection.some((b) => target.closest(`[data-node-type="blockContainer"][data-id="${CSS.escape(b.id)}"]`));
        if (onSelection) {
          openContextMenu(e, selectionMenuEntries(editor, env, selection));
          return;
        }
      }

      let block: AnyBlock | undefined;
      if (target.closest('.bn-side-menu')) {
        block = editor.getExtension(SideMenuExtension)?.store.state?.block;
      } else {
        if (hadSelectionUnderPointer.current) return;
        const el = target.closest<HTMLElement>('[data-node-type="blockContainer"]');
        if (el?.dataset.id) block = editor.getBlock(el.dataset.id);
      }
      hadSelectionUnderPointer.current = false;
      if (!block) return;
      openContextMenu(e, blockMenuEntries(editor, env, block));
    },
    [editor, env],
  );

  return { onPointerDownCapture, onContextMenu };
}
