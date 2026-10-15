// Editor blocks provided by the database module (owned by the database team):
//  - `linkedDatabase`: a view of an EXISTING database with its own views / filters / sorts
//    (views carry the block's link id on the server). Rows and schema edits apply to the source.
// Also exports the slash-menu entries (`databaseSlashItems`), appended by the editor menus:
//  - « Vue liée d'une base » (block above);
//  - « Base de données – Pleine page »: a database created as a sub-page, shown as a sub-page card.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@mantine/core';
import { createReactBlockSpec, type DefaultReactSuggestionItem } from '@blocknote/react';
import { Database, Search, SquareArrowOutUpRight, Table2 } from 'lucide-react';
import { EDITOR_TYPES, newId } from '@oriel/shared';
import { ErrorBoundary } from '../components/common';
import { useEditorEnv } from '../editor/env';
import { getEditor } from '../editor/registry';
import { navigation } from '../lib/navigation';
import { createPage } from '../lib/pages';
import { useTree } from '../lib/tree';
import { normalizeText } from './logic/text';
import { DatabaseView } from './index';

/** Blocks inserted by the slash menu that should open the database picker once mounted. */
const pendingPick = new Set<string>();

function DatabasePickerModal({
  workspaceId,
  opened,
  onClose,
  onPick,
}: {
  workspaceId: string | null;
  opened: boolean;
  onClose: () => void;
  onPick: (databaseId: string) => void;
}) {
  const tree = useTree(workspaceId ?? undefined);
  const [query, setQuery] = useState('');
  const list = useMemo(() => {
    const q = normalizeText(query.trim());
    const nodes = [...tree.index.byId.values()].filter((n) => n.kind === 'database');
    return nodes
      .filter((n) => !q || normalizeText(n.title || 'Sans titre').includes(q))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'fr'))
      .slice(0, 100);
  }, [tree.index, query]);
  return (
    <Modal opened={opened} onClose={onClose} title="Vue liée d'une base" centered size="md" zIndex={400}>
      <div className="ordb-linked-picker">
        <div className="ordb-search is-open">
          <Search size={15} />
          <input
            className="ordb-search-input"
            placeholder="Rechercher une base de données…"
            aria-label="Rechercher une base de données"
            // Mantine's focus trap focuses the element marked data-autofocus (else the close button).
            data-autofocus
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && list[0]) onPick(list[0].id);
            }}
          />
        </div>
        <div className="ordb-options-list">
          {tree.isLoading && <div className="ordb-menu-empty">Chargement…</div>}
          {!tree.isLoading && list.length === 0 && <div className="ordb-menu-empty">Aucune base de données</div>}
          {list.map((n) => (
            <button type="button" key={n.id} className="ordb-option-row" onClick={() => onPick(n.id)}>
              {n.icon ? <span className="ordb-emoji">{n.icon}</span> : <Database size={14} />}
              <span className="ordb-ellipsis">{n.title || 'Sans titre'}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

interface LinkedBlockProps {
  blockId: string;
  databaseId: string;
  linkId: string;
  update: (props: { databaseId?: string; linkId?: string }) => void;
}

function LinkedDatabase({ blockId, databaseId, linkId, update }: LinkedBlockProps) {
  const env = useEditorEnv();
  const canEdit = env.canEdit && env.mode === 'app';
  const [picking, setPicking] = useState(() => canEdit && !databaseId && pendingPick.has(blockId));

  useEffect(() => {
    pendingPick.delete(blockId);
  }, [blockId]);
  // Blocks created without a link id (e.g. pasted) get their own.
  useEffect(() => {
    if (canEdit && databaseId && !linkId) update({ linkId: newId() });
  }, [canEdit, databaseId, linkId, update]);

  const picker = canEdit ? (
    <DatabasePickerModal
      workspaceId={env.workspaceId}
      opened={picking}
      onClose={() => setPicking(false)}
      onPick={(id) => {
        setPicking(false);
        update({ databaseId: id, linkId: linkId || newId() });
      }}
    />
  ) : null;

  if (!databaseId) {
    return (
      <div className="or-db-block ordb-linked-empty" contentEditable={false}>
        <Database size={16} />
        <span>Vue liée d'une base de données</span>
        {canEdit && (
          <button type="button" className="ordb-btn is-outline is-sm" onClick={() => setPicking(true)}>
            Choisir une base…
          </button>
        )}
        {picker}
      </div>
    );
  }
  return (
    <div className="or-db-block ordb-linked" contentEditable={false} data-database-id={databaseId} data-link-id={linkId}>
      <ErrorBoundary
        fallback={(_e, reset) => (
          <div className="or-db-block--empty">
            La vue liée n’a pas pu s’afficher.{' '}
            <button type="button" className="link-button" onClick={reset}>
              Réessayer
            </button>
          </div>
        )}
      >
        {linkId ? (
          <DatabaseView
            databaseId={databaseId}
            linkId={linkId}
            hostPageId={env.pageId || undefined}
            inline
            readOnly={!env.canEdit || env.mode !== 'app'}
            publicMode={env.mode === 'public'}
          />
        ) : (
          <div className="ordb-skeleton" />
        )}
      </ErrorBoundary>
      {picker}
    </div>
  );
}

export const LinkedDatabaseBlock = createReactBlockSpec(
  {
    type: EDITOR_TYPES.linkedDatabase,
    propSchema: { databaseId: { default: '' }, linkId: { default: '' } },
    content: 'none',
  },
  {
    meta: { selectable: false },
    render: ({ block, editor }) => (
      <LinkedDatabase
        blockId={block.id}
        databaseId={block.props.databaseId}
        linkId={block.props.linkId}
        update={(props) => {
          const current = editor.getBlock(block.id);
          if (current) editor.updateBlock(current, { props: { ...current.props, ...props } } as never);
        }}
      />
    ),
    toExternalHTML: ({ block }) => (
      <p>
        <a href={`#${block.props.databaseId}`}>Vue liée d'une base de données</a>
      </p>
    ),
  },
);

export const databaseBlockSpecs = {
  linkedDatabase: LinkedDatabaseBlock(),
};

/** Minimal editor surface used by the slash item (the OrielEditor satisfies it). */
interface SlashEditor {
  getTextCursorPosition(): { block: { id: string; type: string; content?: unknown; children?: unknown[] } };
  replaceBlocks(toReplace: unknown[], blocks: unknown[]): { insertedBlocks: Array<{ id: string }> };
  insertBlocks(blocks: unknown[], ref: unknown, placement: 'before' | 'after'): Array<{ id: string }>;
  getBlock(id: string): { id: string; type: string; content?: unknown; children?: unknown[] } | undefined;
  document: Array<{ id: string }>;
}

const isEmptyParagraph = (b: { type: string; content?: unknown; children?: unknown[] }) =>
  b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 0 && (!b.children || b.children.length === 0);

/**
 * Page whose editor is `editor`: the slash-menu context has no page id, so the editors mounted for the
 * main page and the side panel are compared with it (editor registry).
 */
function hostPageId(editor: unknown, ctx: { pageId?: string }): string | null {
  if (ctx.pageId) return ctx.pageId;
  const fromPath = /\/p\/([^/?#]+)/.exec(window.location.pathname)?.[1];
  const candidates = [navigation.getState().peekPageId, fromPath ? decodeURIComponent(fromPath) : null];
  return candidates.find((id): id is string => !!id && getEditor(id) === editor) ?? null;
}

/** Creates a full-page database under the page being edited and links it where the menu was opened. */
async function insertFullPageDatabase(ed: SlashEditor, editor: unknown, ctx: { workspaceId: string | null; pageId?: string }) {
  const parentId = hostPageId(editor, ctx);
  if (!ctx.workspaceId || !parentId) return;
  const refId = ed.getTextCursorPosition().block.id;
  try {
    const page = await createPage({
      workspaceId: ctx.workspaceId,
      parentType: 'page',
      parentId,
      kind: 'database',
      isInline: false,
      open: false,
      focusTitle: false,
    });
    const block = { type: EDITOR_TYPES.subpage, props: { pageId: page.id } };
    const ref = ed.getBlock(refId);
    if (ref && isEmptyParagraph(ref)) ed.replaceBlocks([ref], [block]);
    else if (ref) ed.insertBlocks([block], ref, 'after');
    else {
      const last = ed.document[ed.document.length - 1];
      if (last) ed.insertBlocks([block], last, 'after');
    }
  } catch {
    /* createPage already reported the error */
  }
}

/**
 * Slash-menu items of the database module. The editor menus append them to their list, e.g.
 *   const all = [...defaults, ...custom, ...databaseSlashItems(editor, env)];
 * (`ctx`: the editor env — workspace id and edit right.)
 */
export const databaseSlashItems = (
  editor: unknown,
  ctx: { workspaceId: string | null; canEdit?: boolean; pageId?: string },
): DefaultReactSuggestionItem[] => {
  if (!ctx.workspaceId || ctx.canEdit === false) return [];
  const ed = editor as SlashEditor;
  return [
    {
      title: "Vue liée d'une base",
      subtext: 'Affiche une base existante avec ses propres vues et filtres',
      aliases: ['vue liee', 'linked', 'base liee', 'vue', 'lier une base', 'database view', 'base existante'],
      group: 'Pages et bases',
      icon: <SquareArrowOutUpRight size={18} />,
      onItemClick: () => {
        const ref = ed.getTextCursorPosition().block;
        const block = { type: EDITOR_TYPES.linkedDatabase, props: { databaseId: '', linkId: newId() } };
        const inserted = isEmptyParagraph(ref) ? ed.replaceBlocks([ref], [block]).insertedBlocks[0] : ed.insertBlocks([block], ref, 'after')[0];
        if (inserted) pendingPick.add(inserted.id);
      },
    },
    {
      title: 'Base de données – Pleine page',
      subtext: 'Crée une base dans une sous-page et insère un lien vers elle',
      aliases: ['base pleine page', 'pleine page', 'base de donnees', 'database', 'bdd', 'sous-base', 'nouvelle base', 'full page'],
      group: 'Pages et bases',
      icon: <Table2 size={18} />,
      onItemClick: () => void insertFullPageDatabase(ed, editor, ctx),
    },
  ];
};
