// Oriel custom blocks and inline content (names/props from EDITOR_TYPES in shared).
import { useState, type MouseEvent } from 'react';
import { createReactBlockSpec, createReactInlineContentSpec, useEditorChange } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { ArrowUpRight, ListTree } from 'lucide-react';
import { EDITOR_TYPES } from '@oriel/shared';
import { DatabaseView } from '../database';
import { EmojiPickerPopover } from '../components/EmojiPicker';
import { ErrorBoundary, PageIcon } from '../components/common';
import { openPageRef, pageRefHref, useEditorEnv, usePageRef } from './env';
import { UNTITLED } from '../lib/util';
import { propString } from '../lib/props';
import { pendingDatabaseCopies } from './databaseCopy';
import { tocHeadingLevel } from './safeProps';

// ---------------------------------------------------------------------------
// Page reference card (sub-page and link to page)
// ---------------------------------------------------------------------------

function PageRefCard({ pageId, variant }: { pageId: string; variant: 'subpage' | 'link' }) {
  const env = useEditorEnv();
  const ref = usePageRef(pageId);
  // A sub-page is always in the sidebar tree: absent means trashed or not accessible.
  // A link may target a database row (not in the tree): keep it usable.
  const missing = ref.status === 'missing' && (variant === 'subpage' || !pageId);
  const unknown = ref.status === 'missing' && !missing;
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!missing) openPageRef(env, pageId, e);
  };
  return (
    <a
      href={pageRefHref(env, pageId)}
      className={`or-pageref or-pageref--${variant}${missing ? ' is-missing' : ''}`}
      contentEditable={false}
      draggable={false}
      onClick={onClick}
      data-page-id={pageId}
    >
      <span className="or-pageref__icon">
        <PageIcon icon={missing ? null : ref.icon} kind={ref.kind} size={18} />
        {variant === 'link' && (
          <span className="or-pageref__arrow">
            <ArrowUpRight size={10} strokeWidth={2.5} />
          </span>
        )}
      </span>
      <span className="or-pageref__title">
        {ref.status === 'loading' ? '…' : missing ? 'Page introuvable ou inaccessible' : unknown ? 'Page' : ref.title || UNTITLED}
      </span>
    </a>
  );
}

function ExternalPageLink({ pageId, prefix }: { pageId: string; prefix?: string }) {
  const env = useEditorEnv();
  const ref = usePageRef(pageId);
  const href = `${location.origin}${pageRefHref(env, pageId)}`;
  return (
    <p>
      <a href={href}>
        {prefix ?? ''}
        {ref.icon ? `${ref.icon} ` : ''}
        {ref.title || UNTITLED}
      </a>
    </p>
  );
}

export const SubpageBlock = createReactBlockSpec(
  { type: EDITOR_TYPES.subpage, propSchema: { pageId: { default: '' } }, content: 'none' },
  {
    render: ({ block }) => <PageRefCard pageId={block.props.pageId} variant="subpage" />,
    toExternalHTML: ({ block }) => <ExternalPageLink pageId={block.props.pageId} />,
  },
);

export const PageLinkBlock = createReactBlockSpec(
  { type: EDITOR_TYPES.pageLink, propSchema: { pageId: { default: '' } }, content: 'none' },
  {
    render: ({ block }) => <PageRefCard pageId={block.props.pageId} variant="link" />,
    toExternalHTML: ({ block }) => <ExternalPageLink pageId={block.props.pageId} prefix="→ " />,
  },
);

// ---------------------------------------------------------------------------
// Inline database
// ---------------------------------------------------------------------------

function InlineDatabase({ blockId, databaseId }: { blockId: string; databaseId: string }) {
  const env = useEditorEnv();
  if (!databaseId) {
    const copying = pendingDatabaseCopies.has(blockId);
    return <div className="or-db-block or-db-block--empty">{copying ? 'Duplication de la base de données…' : 'Base de données introuvable'}</div>;
  }
  return (
    <div className="or-db-block" contentEditable={false} data-database-id={databaseId}>
      <ErrorBoundary
        fallback={(_e, reset) => (
          <div className="or-db-block--empty">
            La base de données n’a pas pu s’afficher.{' '}
            <button type="button" className="link-button" onClick={reset}>
              Réessayer
            </button>
          </div>
        )}
      >
        <DatabaseView
          databaseId={databaseId}
          hostPageId={env.pageId || undefined}
          inline
          readOnly={!env.canEdit || env.mode !== 'app'}
          publicMode={env.mode === 'public'}
        />
      </ErrorBoundary>
    </div>
  );
}

export const DatabaseBlock = createReactBlockSpec(
  { type: EDITOR_TYPES.database, propSchema: { databaseId: { default: '' } }, content: 'none' },
  {
    meta: { selectable: false },
    render: ({ block }) => <InlineDatabase blockId={block.id} databaseId={block.props.databaseId} />,
    toExternalHTML: ({ block }) => <ExternalPageLink pageId={block.props.databaseId} prefix="Base de données : " />,
  },
);

// ---------------------------------------------------------------------------
// Callout
// ---------------------------------------------------------------------------

export const CalloutBlock = createReactBlockSpec(
  {
    type: EDITOR_TYPES.callout,
    propSchema: {
      emoji: { default: '💡' },
      backgroundColor: { default: 'default' },
    },
    content: 'inline',
  },
  {
    render: function CalloutRender({ block, editor, contentRef }) {
      const env = useEditorEnv();
      const [open, setOpen] = useState(false);
      return (
        <div className="or-callout" data-callout-color={block.props.backgroundColor}>
          <EmojiPickerPopover
            opened={open}
            onClose={() => setOpen(false)}
            onSelect={(emoji) => editor.updateBlock(block, { props: { emoji } })}
          >
            <button
              type="button"
              className="or-callout__emoji"
              contentEditable={false}
              aria-label="Changer l’emoji"
              disabled={!env.canEdit}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => env.canEdit && setOpen((o) => !o)}
            >
              {propString(block.props.emoji) || '💡'}
            </button>
          </EmojiPickerPopover>
          <div className="or-callout__content" ref={contentRef} />
        </div>
      );
    },
    toExternalHTML: ({ block, contentRef }) => (
      <blockquote>
        <span>{propString(block.props.emoji)} </span>
        <span ref={contentRef} />
      </blockquote>
    ),
  },
);

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

interface HeadingEntry {
  id: string;
  level: number;
  text: string;
}

export function inlineToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => {
      if (c?.type === 'text') return c.text ?? '';
      if (c?.type === 'link') return inlineToText(c.content);
      if (c?.type === EDITOR_TYPES.pageMention) return '@page';
      return '';
    })
    .join('');
}

function collectHeadings(blocks: any[], out: HeadingEntry[] = []): HeadingEntry[] {
  for (const b of blocks) {
    // The stored level comes from the shared document (any value): clamped to the schema's 1–4.
    if (b.type === 'heading') out.push({ id: b.id, level: tocHeadingLevel(b.props?.level), text: inlineToText(b.content) });
    if (Array.isArray(b.children) && b.children.length) collectHeadings(b.children, out);
  }
  return out;
}

function TableOfContents({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const [headings, setHeadings] = useState<HeadingEntry[]>(() => collectHeadings(editor.document));
  useEditorChange(() => setHeadings(collectHeadings(editor.document)), editor);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 4);
  const scrollTo = (id: string) => {
    const el = editor.domElement?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <nav className="or-toc" contentEditable={false} aria-label="Table des matières">
      {headings.length === 0 ? (
        <div className="or-toc__empty">
          <ListTree size={15} /> Ajoutez des titres à la page pour construire la table des matières.
        </div>
      ) : (
        headings.map((h) => (
          <button
            key={h.id}
            type="button"
            className="or-toc__item"
            style={{ paddingLeft: 6 + (h.level - minLevel) * 18 }}
            onClick={() => scrollTo(h.id)}
          >
            {h.text || 'Titre sans texte'}
          </button>
        ))
      )}
    </nav>
  );
}

export const TocBlock = createReactBlockSpec(
  { type: EDITOR_TYPES.toc, propSchema: {}, content: 'none' },
  {
    meta: { selectable: false },
    render: ({ editor }) => <TableOfContents editor={editor as BlockNoteEditor<any, any, any>} />,
    toExternalHTML: () => <div />,
  },
);

// ---------------------------------------------------------------------------
// Inline page mention
// ---------------------------------------------------------------------------

function MentionChip({ pageId }: { pageId: string }) {
  const env = useEditorEnv();
  const ref = usePageRef(pageId);
  const missing = !pageId;
  const unknown = ref.status === 'missing';
  return (
    <a
      href={pageRefHref(env, pageId)}
      className={`or-mention${missing || unknown ? ' is-missing' : ''}`}
      data-page-id={pageId}
      draggable={false}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!missing) openPageRef(env, pageId, e);
      }}
    >
      <PageIcon icon={missing ? null : ref.icon} kind={ref.kind} size={14} />
      <span className="or-mention__title">{missing ? 'Page inaccessible' : unknown ? 'Page' : ref.title || UNTITLED}</span>
    </a>
  );
}

export const PageMention = createReactInlineContentSpec(
  { type: EDITOR_TYPES.pageMention, propSchema: { pageId: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent }) => <MentionChip pageId={inlineContent.props.pageId} />,
    // Also the clipboard / drag-and-drop serialization: the mention attributes go on the root element,
    // which must not be an <a> — the link mark's `a[href]` rule would win when parsing it back (copy,
    // paste or block drag would turn mentions into plain links).
    toExternalHTML: function MentionExport({ inlineContent }) {
      const env = useEditorEnv();
      const ref = usePageRef(inlineContent.props.pageId);
      return (
        <span>
          <a href={`${location.origin}${pageRefHref(env, inlineContent.props.pageId)}`}>{ref.title || UNTITLED}</a>
        </span>
      );
    },
  },
);
