// Slash menu, page-mention suggestions, block drag-handle menu and formatting toolbar.
import type { ReactNode } from 'react';
import {
  BasicTextStyleButton,
  BlockColorsItem,
  DragHandleMenu,
  FormattingToolbar,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorState,
  useExtensionState,
  usePortalElement,
  type DefaultReactSuggestionItem,
} from '@blocknote/react';
import { SideMenuExtension, type SuggestionMenuOptions } from '@blocknote/core/extensions';
import { insertColumnList } from '@blocknote/xl-multi-column';
import {
  Bookmark,
  Columns2,
  Columns3,
  Columns4,
  Copy,
  Database,
  FileText,
  FolderInput,
  Globe,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  LayoutTemplate,
  Lightbulb,
  Link2,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  ListTree,
  MessageSquareText,
  Pilcrow,
  RefreshCw,
  TextQuote,
  Trash2,
} from 'lucide-react';
import { EDITOR_BLOCK_TYPES, type SearchResult, type TreeNode, type TreeResponse } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { queryClient } from '../lib/queryClient';
import { createPage } from '../lib/pages';
import { buildTreeIndex, ancestorsOf } from '../lib/tree';
import { modKey, normalizeText, pageTitle } from '../lib/util';
import { openPagePicker, toast } from '../lib/ui';
import { PageIcon } from '../components/common';
import { useEditorEnv, type EditorEnv } from './env';
import { G_LAYOUT, G_MEDIA, SLASH_GROUP_ORDER, type OrielEditor, type OrielPartialBlock } from './schema';
import {
  TRANSFORM_TARGETS,
  blockCommentAction,
  copyBlockLink,
  duplicateBlocks,
  isCurrentTarget,
  isTransformable,
  pickPageAndMoveBlocks,
  transformBlock,
} from './blockActions';
import { instantiateTemplate, templateNodes } from './templates';
import { getExtraSlashItems } from './extensions';
import { convertToSyncedBlock, syncedSlashItem } from './syncedBlock';
import { htmlSlashItem } from './htmlBlock';
import { advancedSlashItems, headingRank } from './advancedSlash';
import { InlineEquationButton } from './math';
import { actionTargets, clearBlockSelection, duplicateTargets } from './blockSelection';

const G_PAGES = 'Pages et bases';
const G_HEADINGS = 'Titres';
const G_ADVANCED_LABEL = 'Avancé';

/** The "/" menu does not open inside table cells (same guard as BlockNote's default slash menu). */
export const slashMenuShouldOpen: NonNullable<SuggestionMenuOptions['shouldOpen']> = (tr) =>
  !tr.selection.$from.parent.type.isInGroup('tableContent');

// ---------------------------------------------------------------------------
// Block insertion helpers
// ---------------------------------------------------------------------------

export function isEmptyParagraph(block: { type: string; content?: unknown; children?: unknown[] }) {
  return (
    block.type === 'paragraph' &&
    Array.isArray(block.content) &&
    block.content.length === 0 &&
    (!block.children || block.children.length === 0)
  );
}

/** Insert a block where the slash menu was opened (replacing an empty paragraph). */
export function placeBlock(editor: OrielEditor, refBlockId: string, block: OrielPartialBlock) {
  const ref = editor.getBlock(refBlockId);
  let inserted: { id: string } | undefined;
  if (ref && isEmptyParagraph(ref)) {
    inserted = editor.replaceBlocks([ref], [block]).insertedBlocks[0];
  } else if (ref) {
    inserted = editor.insertBlocks([block], ref, 'after')[0];
  } else {
    const last = editor.document[editor.document.length - 1];
    if (last) inserted = editor.insertBlocks([block], last, 'after')[0];
  }
  if (inserted) {
    const next = editor.getNextBlock(inserted.id);
    try {
      if (next) editor.setTextCursorPosition(next, 'start');
    } catch {
      /* non-text block */
    }
  }
  return inserted;
}

async function createChildAndInsert(
  editor: OrielEditor,
  env: EditorEnv,
  kind: 'page' | 'database',
): Promise<void> {
  if (!env.workspaceId) return;
  const refBlockId = editor.getTextCursorPosition().block.id;
  try {
    // Client-generated id + optimistic tree entry (createPage), then the link block.
    const page = await createPage({
      workspaceId: env.workspaceId,
      parentType: 'page',
      parentId: env.pageId,
      kind,
      isInline: kind === 'database',
      open: false,
      focusTitle: false,
    });
    if (kind === 'page') placeBlock(editor, refBlockId, { type: 'subpage', props: { pageId: page.id } });
    else placeBlock(editor, refBlockId, { type: 'database', props: { databaseId: page.id } });
  } catch {
    /* createPage already reported the error */
  }
}

function insertPageLink(editor: OrielEditor, env: EditorEnv) {
  const refBlockId = editor.getTextCursorPosition().block.id;
  openPagePicker({
    title: 'Lien vers une page',
    includeRows: true,
    exclude: new Set([env.pageId]),
    onPick: (target) => {
      if (target.kind !== 'page') return;
      placeBlock(editor, refBlockId, { type: 'pageLink', props: { pageId: target.id } });
    },
  });
}

/** Sub-page created from a template, linked where the slash menu was opened. */
function insertFromTemplate(editor: OrielEditor, env: EditorEnv) {
  if (!env.workspaceId) return;
  const workspaceId = env.workspaceId;
  const templates = templateNodes(workspaceId);
  if (templates.length === 0) {
    toast('Aucun modèle pour l’instant : ouvrez une page puis « Utiliser comme modèle ».');
    return;
  }
  const refBlockId = editor.getTextCursorPosition().block.id;
  const templateIds = new Set(templates.map((t) => t.id));
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  openPagePicker({
    title: 'Sous-page depuis un modèle',
    exclude: new Set((tree?.nodes ?? []).filter((n) => !templateIds.has(n.id)).map((n) => n.id)),
    onPick: (target) => {
      if (target.kind !== 'page') return;
      void instantiateTemplate(workspaceId, target.id, { parentType: 'page', parentId: env.pageId }, { open: false }).then((page) => {
        if (page) placeBlock(editor, refBlockId, { type: 'subpage', props: { pageId: page.id } });
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Slash menu
// ---------------------------------------------------------------------------

const COLUMN_ICONS: Record<number, React.JSX.Element> = {
  2: <Columns2 size={18} />,
  3: <Columns3 size={18} />,
  4: <Columns4 size={18} />,
  5: <Columns4 size={18} />,
};

export function getSlashMenuItems(editor: OrielEditor, env: EditorEnv): DefaultReactSuggestionItem[] {
  const defaults = getDefaultReactSlashMenuItems(editor);
  const here = () => editor.getTextCursorPosition().block.id;
  const columns: DefaultReactSuggestionItem[] = [2, 3, 4, 5].map((n) => ({
    title: `${n} colonnes`,
    subtext: `${n} colonnes côte à côte`,
    aliases: ['colonnes', 'colonne', 'columns', `${n}col`, `${n} col`, 'mise en page', 'cote a cote'],
    group: G_LAYOUT,
    icon: COLUMN_ICONS[n],
    onItemClick: () => insertColumnList(editor, n),
  }));
  const custom: DefaultReactSuggestionItem[] = [
    ...columns,
    {
      title: 'Page',
      subtext: 'Crée une sous-page et insère un lien',
      aliases: ['page', 'sous-page', 'souspage', 'subpage', 'nouvelle page'],
      group: G_PAGES,
      icon: <FileText size={18} />,
      onItemClick: () => void createChildAndInsert(editor, env, 'page'),
    },
    {
      title: 'Page depuis un modèle',
      subtext: 'Sous-page copiée d’un modèle',
      aliases: ['modele', 'template', 'gabarit'],
      group: G_PAGES,
      icon: <LayoutTemplate size={18} />,
      onItemClick: () => insertFromTemplate(editor, env),
    },
    {
      title: 'Lien vers une page',
      subtext: 'Pointe vers une page existante',
      aliases: ['lien', 'link', 'page', 'reference', 'renvoi'],
      group: G_PAGES,
      icon: <Link2 size={18} />,
      onItemClick: () => insertPageLink(editor, env),
    },
    {
      title: 'Base de données',
      subtext: 'Base de données intégrée à la page',
      aliases: ['base', 'base de donnees', 'database', 'bdd', 'db', 'tableau', 'table'],
      group: G_PAGES,
      icon: <Database size={18} />,
      onItemClick: () => void createChildAndInsert(editor, env, 'database'),
    },
    {
      title: 'Intégrer',
      subtext: 'YouTube, Vimeo, Loom, Figma, Google Docs, Maps, Spotify…',
      aliases: ['integrer', 'integration', 'embed', 'iframe', 'youtube', 'vimeo', 'loom', 'figma', 'google', 'maps', 'carte', 'docs', 'sheets', 'slides', 'drive', 'spotify', 'frame.io'],
      group: G_MEDIA,
      icon: <Globe size={18} />,
      onItemClick: () => placeBlock(editor, here(), { type: 'embed' } as OrielPartialBlock),
    },
    {
      title: 'Signet',
      subtext: 'Aperçu d’un lien (titre, description, image)',
      aliases: ['signet', 'bookmark', 'lien', 'apercu', 'url', 'site'],
      group: G_MEDIA,
      icon: <Bookmark size={18} />,
      onItemClick: () => placeBlock(editor, here(), { type: 'bookmark' } as OrielPartialBlock),
    },
    {
      title: 'PDF',
      subtext: 'Afficher un PDF dans la page',
      aliases: ['pdf', 'document', 'visionneuse', 'lecteur pdf'],
      group: G_MEDIA,
      icon: <FileText size={18} />,
      onItemClick: () => placeBlock(editor, here(), { type: 'pdf' } as OrielPartialBlock),
    },
    {
      title: 'Encadré',
      subtext: 'Texte mis en avant avec un emoji',
      aliases: ['encadre', 'callout', 'note', 'info', 'astuce', 'attention'],
      group: G_ADVANCED_LABEL,
      icon: <Lightbulb size={18} />,
      onItemClick: () => {
        const ref = editor.getTextCursorPosition().block;
        if (isEmptyParagraph(ref)) editor.updateBlock(ref, { type: 'callout' });
        else {
          const [b] = editor.insertBlocks([{ type: 'callout' }], ref, 'after');
          if (b) editor.setTextCursorPosition(b, 'end');
        }
      },
    },
    {
      title: 'Table des matières',
      subtext: 'Liste des titres de la page',
      aliases: ['table des matieres', 'sommaire', 'toc', 'plan'],
      group: G_ADVANCED_LABEL,
      icon: <ListTree size={18} />,
      onItemClick: () => placeBlock(editor, here(), { type: 'toc' }),
    },
  ];
  // Synced block and HTML block (syncedBlock.tsx, htmlBlock.tsx).
  const advanced = [syncedSlashItem(editor, env, G_ADVANCED_LABEL), htmlSlashItem(editor, env, G_ADVANCED_LABEL)].filter(
    (item): item is DefaultReactSuggestionItem => item !== null,
  );
  // Titre dépliable 4, equations, breadcrumb, tabs, button (advancedSlash.tsx).
  const blocks = advancedSlashItems(editor, env, placeBlock, { headings: G_HEADINGS, layout: G_LAYOUT, advanced: G_ADVANCED_LABEL });
  const all = [...defaults, ...custom, ...advanced, ...blocks, ...getExtraSlashItems(editor, { workspaceId: env.workspaceId, canEdit: env.canEdit })];
  const order = (g?: string) => {
    const i = SLASH_GROUP_ORDER.indexOf(g ?? '');
    return i === -1 ? SLASH_GROUP_ORDER.length : i;
  };
  // Stable sort by group so each group renders once.
  const rank = (item: DefaultReactSuggestionItem) => (item.group === G_HEADINGS ? headingRank(item) : 0);
  return all
    .map((item, i) => ({ item, i }))
    .sort((a, b) => order(a.item.group) - order(b.item.group) || rank(a.item) - rank(b.item) || a.i - b.i)
    .map((x) => x.item);
}

// ---------------------------------------------------------------------------
// Page mentions (@ and [[)
// ---------------------------------------------------------------------------

interface MentionCandidate {
  id: string;
  title: string;
  icon: string | null;
  kind: TreeNode['kind'];
  path: string;
}

export async function getMentionItems(editor: OrielEditor, env: EditorEnv, query: string): Promise<DefaultReactSuggestionItem[]> {
  if (!env.workspaceId) return [];
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(env.workspaceId));
  const index = buildTreeIndex(tree?.nodes ?? []);
  const q = normalizeText(query);
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  const nodes = [...index.byId.values()]
    .filter((n) => normalizeText(pageTitle(n.title)).includes(q))
    .sort((a, b) => {
      const as = normalizeText(pageTitle(a.title)).startsWith(q) ? 0 : 1;
      const bs = normalizeText(pageTitle(b.title)).startsWith(q) ? 0 : 1;
      // Templates come after regular pages.
      const at = a.isTemplate ? 1 : 0;
      const bt = b.isTemplate ? 1 : 0;
      return at - bt || as - bs || pageTitle(a.title).localeCompare(pageTitle(b.title), 'fr');
    })
    .slice(0, 8);
  for (const n of nodes) {
    seen.add(n.id);
    candidates.push({
      id: n.id,
      title: pageTitle(n.title),
      icon: n.icon,
      kind: n.kind,
      path: ancestorsOf(index, n.id)
        .map((a) => pageTitle(a.title))
        .join(' / '),
    });
  }
  if (q.length >= 2 && candidates.length < 8) {
    try {
      const res = await api.workspaces.search(env.workspaceId, query, 8);
      for (const r of res.results as SearchResult[]) {
        if (seen.has(r.page.id)) continue;
        seen.add(r.page.id);
        candidates.push({
          id: r.page.id,
          title: pageTitle(r.page.title),
          icon: r.page.icon,
          kind: r.page.kind,
          path: r.path.map((c) => pageTitle(c.title)).join(' / '),
        });
      }
    } catch {
      /* offline: local results only */
    }
  }
  return candidates.slice(0, 10).map((c) => ({
    title: c.title,
    subtext: c.path || undefined,
    icon: <PageIcon icon={c.icon} kind={c.kind} size={18} />,
    onItemClick: () => {
      editor.insertInlineContent([{ type: 'pageMention', props: { pageId: c.id } }, ' ']);
    },
  }));
}

// ---------------------------------------------------------------------------
// Drag handle menu: supprimer, dupliquer, transformer en…, couleur, lien, déplacer, commenter
// ---------------------------------------------------------------------------

function useSideMenuBlock() {
  const editor = useBlockNoteEditor<any, any, any>();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  return { editor, block };
}

function ActionItem({
  children,
  icon,
  run,
  show = () => true,
}: {
  children: ReactNode;
  icon?: ReactNode;
  run: (editor: any, block: any) => void;
  show?: (block: any) => boolean;
}) {
  const Components = useComponentsContext()!;
  const { editor, block } = useSideMenuBlock();
  if (!block || !show(block)) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" icon={icon} onClick={() => run(editor, block)}>
      {children}
    </Components.Generic.Menu.Item>
  );
}

const TRANSFORM_ICONS: Record<string, ReactNode> = {
  paragraph: <Pilcrow size={15} />,
  h1: <Heading1 size={15} />,
  h2: <Heading2 size={15} />,
  h3: <Heading3 size={15} />,
  h4: <Heading4 size={15} />,
  th1: <Heading1 size={15} />,
  th2: <Heading2 size={15} />,
  th3: <Heading3 size={15} />,
  th4: <Heading4 size={15} />,
  bullet: <List size={15} />,
  numbered: <ListOrdered size={15} />,
  check: <ListChecks size={15} />,
  toggle: <ListCollapse size={15} />,
  quote: <TextQuote size={15} />,
  callout: <Lightbulb size={15} />,
};

function TransformBlockItem({ children }: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const { editor, block } = useSideMenuBlock();
  if (!block || !isTransformable(block)) return null;
  return (
    <Components.Generic.Menu.Root position="right" sub portalElement={portalElement}>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          {children}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
        {TRANSFORM_TARGETS.map((t) => (
          <Components.Generic.Menu.Item
            key={t.key}
            className="bn-menu-item"
            icon={TRANSFORM_ICONS[t.key]}
            checked={isCurrentTarget(block, t)}
            onClick={() =>
              // The whole block selection when this block is part of it.
              editor.transact(() => {
                for (const b of actionTargets(editor, block)) {
                  const current = editor.getBlock(b.id);
                  if (current && isTransformable(current)) transformBlock(editor, current, t);
                }
              })
            }
          >
            {t.label}
          </Components.Generic.Menu.Item>
        ))}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

function CommentItem() {
  const Components = useComponentsContext()!;
  const env = useEditorEnv();
  const { editor, block } = useSideMenuBlock();
  if (!block || env.mode !== 'app' || !env.canEdit) return null;
  const action = blockCommentAction(editor, block);
  if (!action) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" icon={<MessageSquareText size={15} />} onClick={action}>
      Commenter
    </Components.Generic.Menu.Item>
  );
}

export function OrielDragHandleMenu() {
  const env = useEditorEnv();
  return (
    <DragHandleMenu>
      <ActionItem
        icon={<Trash2 size={15} />}
        run={(editor, block) => {
          const targets = actionTargets(editor, block);
          clearBlockSelection(editor);
          editor.removeBlocks(targets);
        }}
      >
        Supprimer
      </ActionItem>
      <ActionItem
        icon={<Copy size={15} />}
        run={(editor, block) => {
          const targets = actionTargets(editor, block);
          if (targets.length > 1) duplicateTargets(editor, targets);
          else duplicateBlocks(editor, [block]);
        }}
      >
        {`Dupliquer (${modKey()}D)`}
      </ActionItem>
      <TransformBlockItem>Transformer en…</TransformBlockItem>
      <BlockColorsItem>Couleur</BlockColorsItem>
      <CommentItem />
      <ActionItem icon={<Link2 size={15} />} run={(_editor, block) => void copyBlockLink(env, block.id)}>
        Copier le lien du bloc
      </ActionItem>
      {env.mode === 'app' && env.canEdit && (
        <ActionItem icon={<RefreshCw size={15} />} show={(b) => b.type !== EDITOR_BLOCK_TYPES.syncedBlock} run={(editor, block) => void convertToSyncedBlock(editor, env, actionTargets(editor, block))}>
          Transformer en bloc synchronisé
        </ActionItem>
      )}
      {env.mode === 'app' && env.workspaceId && (
        <ActionItem icon={<FolderInput size={15} />} run={(editor, block) => pickPageAndMoveBlocks(editor, env, actionTargets(editor, block))}>
          Déplacer vers…
        </ActionItem>
      )}
    </DragHandleMenu>
  );
}

// ---------------------------------------------------------------------------
// Formatting toolbar (default items + inline code)
// ---------------------------------------------------------------------------

/**
 * Block type select of the formatting toolbar, with the same targets and toggle handling as
 * « Transformer en » (BlockNote's own select resets `isToggleable` and offers levels 4–6).
 */
function OrielBlockTypeSelect() {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor<any, any, any>();
  const blocks = useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed.getSelection()?.blocks ?? [ed.getTextCursorPosition().block]) as any[],
  });
  const first = blocks[0];
  if (!first || !editor.isEditable || !isTransformable(first)) return null;
  const items = TRANSFORM_TARGETS.map((t) => ({
    text: t.label,
    icon: TRANSFORM_ICONS[t.key],
    isSelected: isCurrentTarget(first, t),
    onClick: () => {
      editor.focus();
      editor.transact(() => {
        for (const b of blocks) {
          const current = editor.getBlock(b.id);
          if (current && isTransformable(current)) transformBlock(editor, current, t);
        }
      });
    },
  }));
  if (!items.some((i) => i.isSelected)) return null;
  return <Components.FormattingToolbar.Select className="bn-select" items={items} portalElement={portalElement} />;
}

const LINK_CARD_TYPES = new Set<string>([
  EDITOR_BLOCK_TYPES.embed,
  EDITOR_BLOCK_TYPES.bookmark,
  // Their own bar and editor (the synced block's content has its own formatting toolbar).
  EDITOR_BLOCK_TYPES.syncedBlock,
  EDITOR_BLOCK_TYPES.html,
]);

export function OrielFormattingToolbar() {
  const editor = useBlockNoteEditor<any, any, any>();
  // Embeds and bookmarks have a `url` prop, which makes BlockNote offer its file buttons (replace,
  // download…): they have their own controls and right-click menu instead.
  const linkCard = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const blocks = ed.getSelection()?.blocks ?? [ed.getTextCursorPosition().block];
      return blocks.length === 1 && LINK_CARD_TYPES.has(blocks[0]!.type);
    },
  });
  if (linkCard) return null;
  const items = getFormattingToolbarItems().map((item) =>
    item.key === 'blockTypeSelect' ? <OrielBlockTypeSelect key="blockTypeSelect" /> : item,
  );
  const strikeIndex = items.findIndex((i) => i.key === 'strikeStyleButton');
  items.splice(strikeIndex + 1, 0, <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />, <InlineEquationButton key="inlineEquationButton" />);
  return <FormattingToolbar>{items}</FormattingToolbar>;
}
