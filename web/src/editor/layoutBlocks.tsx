// Layout blocks: breadcrumb ("Fil d'Ariane", live ancestors of the page) and tabs ("Onglets").
//
// Tabs: a `tabs` block whose children are `tab` blocks (title in props), each holding its content as
// children. Every tab stays in the document (search, export and the AI reader see all of them); only
// the active tab is displayed, through a <style> scoped to the block ids (ProseMirror owns the blocks'
// DOM). Drag, copy/paste and collaboration work on ordinary nested blocks.
import { Fragment, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { EDITOR_BLOCK_TYPES, type Crumb, type PageDetailResponse, type PublicPageResponse, type TreeResponse } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { queryClient } from '../lib/queryClient';
import { useTree } from '../lib/tree';
import { confirmDialog, promptDialog } from '../lib/ui';
import { pageTitle } from '../lib/util';
import { PageIcon } from '../components/common';
import { openContextMenu } from '../components/ContextMenu';
import { editorApi } from './editorApi';
import { openPageRef, pageRefHref, useEditorEnv } from './env';

type AnyEditor = BlockNoteEditor<any, any, any>;
interface AnyBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: AnyBlock[];
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function useCrumbs(): Crumb[] {
  const env = useEditorEnv();
  const isPublic = env.mode === 'public';
  const tree = useTree(isPublic ? undefined : (env.workspaceId ?? undefined));
  const detail = useQuery({
    queryKey: qk.page(env.pageId),
    queryFn: () => editorApi.pageInfo(env.pageId),
    enabled: !isPublic && !!env.pageId && !!env.workspaceId,
    staleTime: 30_000,
  });
  const publicPage = useQuery({
    queryKey: qk.publicPage(env.pageId),
    queryFn: () => api.public.page(env.pageId),
    enabled: isPublic && !!env.pageId,
    retry: false,
    staleTime: 60_000,
  });
  const source = isPublic ? publicPage.data : detail.data;
  if (!source) return [];
  const current: Crumb = { id: source.page.id, title: source.page.title, icon: source.page.icon, kind: source.page.kind };
  // Live titles and icons from the sidebar tree when available.
  return [...source.ancestors, current].map((c) => {
    const node = tree.index.byId.get(c.id);
    return node ? { ...c, title: node.title, icon: node.icon } : c;
  });
}

/** Page shown by each mounted editor (the export of a breadcrumb has no editor environment). */
const editorPages = new WeakMap<object, string>();

/** « A / B / Page » from the query cache (no request, no hook): page export, copy. */
export function breadcrumbText(pageId: string): string {
  if (!pageId) return '';
  const source =
    queryClient.getQueryData<PageDetailResponse>(qk.page(pageId)) ?? queryClient.getQueryData<PublicPageResponse>(qk.publicPage(pageId));
  if (!source) return '';
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(source.page.workspaceId));
  const titleOf = (c: { id: string; title: string }) => pageTitle(tree?.nodes.find((n) => n.id === c.id)?.title ?? c.title);
  return [...source.ancestors, source.page].map(titleOf).join(' / ');
}

function BreadcrumbView({ editor }: { editor: AnyEditor }) {
  const env = useEditorEnv();
  const crumbs = useCrumbs();
  if (env.pageId) editorPages.set(editor, env.pageId);
  return (
    <nav className="or-breadcrumb-block" contentEditable={false} aria-label="Fil d’Ariane">
      {crumbs.length === 0 ? (
        <span className="or-breadcrumb-block__empty">Fil d’Ariane</span>
      ) : (
        crumbs.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 && <span className="or-breadcrumb-block__sep">/</span>}
            <a
              className={`or-breadcrumb-block__item${i === crumbs.length - 1 ? ' is-current' : ''}`}
              href={pageRefHref(env, c.id)}
              onClick={(e) => {
                e.preventDefault();
                if (c.id !== env.pageId) openPageRef(env, c.id, e);
              }}
            >
              <PageIcon icon={c.icon} kind={c.kind} size={15} />
              <span>{pageTitle(c.title)}</span>
            </a>
          </Fragment>
        ))
      )}
    </nav>
  );
}

export const BreadcrumbBlock = createReactBlockSpec(
  { type: EDITOR_BLOCK_TYPES.breadcrumb, propSchema: {}, content: 'none' },
  {
    render: ({ editor }) => <BreadcrumbView editor={editor as AnyEditor} />,
    // Rendered outside the app's providers (export): query cache only.
    toExternalHTML: ({ editor }) => <p>{breadcrumbText(editorPages.get(editor) ?? '')}</p>,
  },
);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Active tab per tabs block, for this viewer (not shared). */
const activeTabs = new Map<string, string>();

const tabTitle = (b: { props: Record<string, unknown> }, i: number) => (typeof b.props.title === 'string' && b.props.title.trim() ? b.props.title : `Onglet ${i + 1}`);

export const newTab = (title: string) => ({ type: EDITOR_BLOCK_TYPES.tab, props: { title }, children: [{ type: 'paragraph' }] });

/** Default content of a new tabs block (slash menu). */
export const newTabsBlock = () => ({ type: EDITOR_BLOCK_TYPES.tabs, children: [newTab('Onglet 1'), newTab('Onglet 2')] });

/** Scoped CSS: tab containers without indentation, tab rows hidden, inactive tabs hidden. */
function tabsCss(tabsId: string, activeId: string | null): string {
  const root = `.bn-block[data-id="${CSS.escape(tabsId)}"] > .bn-block-group`;
  const rules = [
    `${root} { margin-left: 0; }`,
    `${root} > .bn-block-outer::before { display: none; }`,
    // The tab row itself (its content is wrapped in React's node-view element): everything but its children.
    `${root} > .bn-block-outer > .bn-block > :not(.bn-block-group) { display: none; }`,
    `${root} > .bn-block-outer > .bn-block > .bn-block-group { margin-left: 0; }`,
    `${root} > .bn-block-outer > .bn-block > .bn-block-group > .bn-block-outer::before { display: none; }`,
  ];
  if (activeId) rules.push(`${root} > .bn-block-outer:not([data-id="${CSS.escape(activeId)}"]) { display: none; }`);
  return rules.join('\n');
}

interface TabInfo {
  id: string;
  props: Record<string, unknown>;
}

const tabsOf = (b: AnyBlock): TabInfo[] => b.children.filter((c) => c.type === EDITOR_BLOCK_TYPES.tab).map((c) => ({ id: c.id, props: c.props }));
const sameTabs = (a: TabInfo[], b: TabInfo[]) => a.length === b.length && a.every((t, i) => t.id === b[i]!.id && t.props.title === b[i]!.props.title);

/**
 * Tabs of a tabs block, kept current: BlockNote re-renders a block's view only when its own content
 * changes, not when its children (the tabs) are added, renamed, moved or removed — locally or by a
 * collaborator.
 */
function useLiveTabs(editor: AnyEditor, block: AnyBlock): TabInfo[] {
  const [tabs, setTabs] = useState(() => tabsOf(block));
  useEffect(() => {
    const refresh = () => {
      const fresh = editor.getBlock(block.id) as AnyBlock | undefined;
      if (!fresh) return;
      const next = tabsOf(fresh);
      setTabs((prev) => (sameTabs(prev, next) ? prev : next));
    };
    refresh();
    const off = editor.onChange(refresh);
    return () => {
      if (typeof off === 'function') off();
    };
  }, [editor, block.id]);
  return tabs;
}

function TabsView({ block, editor }: { block: AnyBlock; editor: AnyEditor }) {
  const env = useEditorEnv();
  const tabs = useLiveTabs(editor, block);
  const [active, setActive] = useState<string | null>(() => activeTabs.get(block.id) ?? null);
  const current = tabs.find((t) => t.id === active) ?? tabs[0] ?? null;
  useEffect(() => {
    if (current) activeTabs.set(block.id, current.id);
  }, [block.id, current]);

  const fresh = () => editor.getBlock(block.id) as AnyBlock | undefined;
  const select = (id: string) => setActive(id);

  const add = () => {
    const b = fresh();
    if (!b) return;
    const last = b.children[b.children.length - 1];
    const tab = newTab(`Onglet ${b.children.length + 1}`);
    const inserted = last
      ? (editor.insertBlocks([tab] as never, last.id, 'after')[0] as unknown as AnyBlock | undefined)
      : undefined;
    if (!last) editor.updateBlock(b.id, { children: [tab] } as never);
    const id = inserted?.id ?? (fresh()?.children[0]?.id ?? null);
    if (id) setActive(id);
  };

  const rename = async (tab: TabInfo, i: number) => {
    const title = await promptDialog({ title: 'Renommer l’onglet', label: 'Nom', initialValue: tabTitle(tab, i), confirmLabel: 'Renommer' });
    if (title === null) return;
    const t = editor.getBlock(tab.id);
    if (t) editor.updateBlock(t, { props: { title: title.trim().slice(0, 120) } } as never);
  };

  const move = (tab: TabInfo, dir: -1 | 1) => {
    const b = fresh();
    if (!b) return;
    const i = b.children.findIndex((c) => c.id === tab.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= b.children.length) return;
    const children = [...b.children];
    [children[i], children[j]] = [children[j]!, children[i]!];
    editor.updateBlock(b.id, { children } as never);
  };

  const remove = async (info: TabInfo, i: number) => {
    const tab = editor.getBlock(info.id) as AnyBlock | undefined;
    if (!tab) return;
    const hasContent = tab.children.some((c) => c.children.length > 0 || (Array.isArray((c as unknown as { content?: unknown[] }).content) && ((c as unknown as { content: unknown[] }).content.length > 0)) || c.type !== 'paragraph');
    if (hasContent) {
      const ok = await confirmDialog({
        title: `Supprimer « ${tabTitle(tab, i)} » ?`,
        message: 'Le contenu de l’onglet sera supprimé.',
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (!ok) return;
    }
    const b = fresh();
    const idx = b?.children.findIndex((c) => c.id === tab.id) ?? -1;
    editor.removeBlocks([tab.id]);
    const next = fresh()?.children[Math.max(0, idx - 1)];
    if (next) setActive(next.id);
  };

  const tabMenu = (e: ReactMouseEvent, tab: TabInfo, i: number) => {
    if (!env.canEdit) return;
    openContextMenu(e, [
      { label: 'Renommer', icon: <Pencil size={15} />, onClick: () => void rename(tab, i) },
      i > 0 && { label: 'Déplacer à gauche', icon: <ArrowLeft size={15} />, onClick: () => move(tab, -1) },
      i < tabs.length - 1 && { label: 'Déplacer à droite', icon: <ArrowRight size={15} />, onClick: () => move(tab, 1) },
      { divider: true },
      { label: 'Supprimer l’onglet', icon: <Trash2 size={15} />, danger: true, onClick: () => void remove(tab, i) },
    ]);
  };

  return (
    <div className="or-tabs" contentEditable={false}>
      <style>{tabsCss(block.id, current?.id ?? null)}</style>
      <div className="or-tabs__bar" role="tablist">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === current?.id}
            className={`or-tabs__tab${tab.id === current?.id ? ' is-active' : ''}`}
            onClick={() => select(tab.id)}
            onDoubleClick={() => env.canEdit && void rename(tab, i)}
            onContextMenu={(e) => tabMenu(e, tab, i)}
            title={env.canEdit ? 'Double-clic pour renommer, clic droit pour plus d’options' : undefined}
          >
            {tabTitle(tab, i)}
          </button>
        ))}
        {env.canEdit && (
          <button type="button" className="or-tabs__add" aria-label="Ajouter un onglet" title="Ajouter un onglet" onClick={add}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {tabs.length === 0 && <div className="or-tabs__empty">Aucun onglet.</div>}
    </div>
  );
}

export const TabsBlock = createReactBlockSpec(
  { type: EDITOR_BLOCK_TYPES.tabs, propSchema: {}, content: 'none' },
  {
    render: ({ block, editor }) => <TabsView block={block as unknown as AnyBlock} editor={editor as AnyEditor} />,
    // Markdown / HTML export: each tab becomes a heading followed by its content (the children).
    toExternalHTML: () => <div />,
  },
);

/** A tab: hidden row inside a tabs block (its title is shown in the tab bar); a plain label elsewhere. */
export const TabBlock = createReactBlockSpec(
  { type: EDITOR_BLOCK_TYPES.tab, propSchema: { title: { default: 'Onglet' } }, content: 'none' },
  {
    render: ({ block }) => (
      <div className="or-tab-label" contentEditable={false}>
        {typeof block.props.title === 'string' && block.props.title ? block.props.title : 'Onglet'}
      </div>
    ),
    toExternalHTML: ({ block }) => <h3>{typeof block.props.title === 'string' && block.props.title ? block.props.title : 'Onglet'}</h3>,
  },
);
