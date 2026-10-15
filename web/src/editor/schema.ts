import {
  BlockNoteSchema,
  createCodeBlockSpec,
  createHeadingBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  type Dictionary,
} from '@blocknote/core';
import { fr } from '@blocknote/core/locales';
import { codeBlockOptions } from '@blocknote/code-block';
import { CODE_LANGUAGES, normalizeCodeLanguage } from './codeLanguages';
import { codeRenderKind } from './codeRenderLogic';
import { withCodeRender } from './codeRender';
import { locales as multiColumnLocales, withMultiColumn } from '@blocknote/xl-multi-column';
import { CalloutBlock, DatabaseBlock, PageLinkBlock, PageMention, SubpageBlock, TocBlock } from './blocks';
import { BookmarkBlock, EmbedBlock, PdfBlock } from './mediaBlocks';
import { SyncedBlock } from './syncedBlock';
import { HtmlBlock } from './htmlBlock';
import { EquationBlock, InlineEquation } from './math';
import { BreadcrumbBlock, TabBlock, TabsBlock } from './layoutBlocks';
import { ButtonBlock } from './buttonBlock';
import { DrawingBlock } from './drawingBlock';
import { ImageBlock } from './imageBlock';
import { Footnote } from './footnotes';
import { extraBlockSpecs, extraInlineContentSpecs } from './extensions';
import { withSafeProps } from './safeProps';

// --- Code block languages (aliases → canonical keys: see codeLanguages.ts) -------------------

export { normalizeCodeBlocks, normalizeCodeLanguage } from './codeLanguages';

/**
 * BlockNote's code block throws ("Language js is not supported") when a document holds a language that is
 * not a canonical key — e.g. pasted / imported Markdown fences (```js). Normalize when parsing HTML and,
 * for documents that already contain aliases, when rendering.
 */
/** Languages the editor knows but that have no syntax highlighting grammar (the highlighter would throw). */
const UNHIGHLIGHTED = new Set(['abc', 'typst']);

function tolerantCodeBlock<S extends { implementation: Record<string, any> }>(spec: S): S {
  const { render, parse, meta } = spec.implementation;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      meta: meta
        ? {
            ...meta,
            highlight: typeof meta.highlight === 'function' ? (block: unknown) => {
              const language = meta.highlight(block);
              return typeof language === 'string' && UNHIGHLIGHTED.has(language) ? undefined : language;
            } : meta.highlight,
          }
        : meta,
      parse: parse
        ? (el: HTMLElement) => {
            const parsed = parse(el);
            return parsed ? { ...parsed, language: normalizeCodeLanguage(parsed.language) } : parsed;
          }
        : undefined,
      render(this: { renderType?: string }, block: { id: string; props: { language?: unknown } }, editor: unknown) {
        const language = normalizeCodeLanguage(block.props.language);
        const safe = language === block.props.language ? block : { ...block, props: { ...block.props, language } };
        const rendered = render.call(this, safe, editor);
        // Mermaid / ABC: code / preview / both (E13). Only live node views, never serialization.
        const kind = codeRenderKind(language);
        return kind && this?.renderType === 'nodeView' ? withCodeRender(rendered, safe as never, editor as never, kind) : rendered;
      },
    },
  };
}

// Columns (xl-multi-column, GPL-3.0 — compatible with Oriel's AGPL-3.0): `columnList` > `column` > blocks.
/** The `view` prop (code / preview / both) of Mermaid and ABC blocks: ProseMirror reads the attributes
 *  from the config object captured by BlockNote, so the prop schema is extended in place. */
function withCodeViewProp<S extends { config: { propSchema: object } }>(spec: S): S {
  (spec.config.propSchema as Record<string, unknown>).view = { default: 'both', values: ['code', 'preview', 'both'] };
  return spec;
}

export const schema = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      // A forged `level` would make BlockNote's createElement(`h${level}`) throw (QA-WEB-08, safeProps.ts).
      heading: withSafeProps(createHeadingBlockSpec({ levels: [1, 2, 3, 4] })),
      codeBlock: withCodeViewProp(
        tolerantCodeBlock(
          createCodeBlockSpec({
            ...codeBlockOptions,
            defaultLanguage: 'text',
            supportedLanguages: CODE_LANGUAGES,
          }),
        ),
      ),
      subpage: SubpageBlock(),
      pageLink: PageLinkBlock(),
      database: DatabaseBlock(),
      callout: CalloutBlock(),
      toc: TocBlock(),
      embed: EmbedBlock(),
      bookmark: BookmarkBlock(),
      pdf: PdfBlock(),
      syncedBlock: SyncedBlock(),
      html: HtmlBlock(),
      equation: EquationBlock(),
      breadcrumb: BreadcrumbBlock(),
      tabs: TabsBlock(),
      tab: TabBlock(),
      button: ButtonBlock(),
      drawing: DrawingBlock(),
      // Native image + non destructive crop and hyperlink (E15).
      image: ImageBlock(),
      ...extraBlockSpecs,
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      pageMention: PageMention,
      inlineEquation: InlineEquation,
      footnote: Footnote,
      ...extraInlineContentSpecs,
    },
  }),
);

export type OrielSchema = typeof schema;
export type OrielEditor = typeof schema.BlockNoteEditor;
export type OrielBlock = typeof schema.Block;
export type OrielPartialBlock = typeof schema.PartialBlock;

// --- French dictionary (BlockNote's `fr` locale with Oriel's own wording) -----------

const G_BASIC = 'Blocs de base';
const G_HEADINGS = 'Titres';
export const G_LAYOUT = 'Mise en page';
export const G_MEDIA = 'Médias';
const G_ADVANCED = 'Avancé';

const sm = fr.slash_menu;
export const dictionary: Dictionary & { multi_column: typeof multiColumnLocales.fr } = {
  ...fr,
  slash_menu: {
    ...sm,
    paragraph: { ...sm.paragraph, title: 'Texte', subtext: 'Un simple paragraphe', aliases: [...(sm.paragraph.aliases ?? []), 'texte', 'p'], group: G_BASIC },
    heading: { ...sm.heading, title: 'Titre 1', subtext: 'Grand titre de section', group: G_HEADINGS },
    heading_2: { ...sm.heading_2, title: 'Titre 2', subtext: 'Titre de section moyen', group: G_HEADINGS },
    heading_3: { ...sm.heading_3, title: 'Titre 3', subtext: 'Petit titre de section', group: G_HEADINGS },
    heading_4: { ...sm.heading_4, title: 'Titre 4', subtext: 'Titre de sous-section', aliases: ['h4', 'titre4', 'titre 4', 'heading4'], group: G_HEADINGS },
    toggle_heading: { ...sm.toggle_heading, aliases: [...(sm.toggle_heading.aliases ?? []), 'depliable', 'titre depliable'], title: 'Titre dépliable 1', subtext: 'Grand titre qui masque son contenu', group: G_HEADINGS },
    toggle_heading_2: { ...sm.toggle_heading_2, aliases: [...(sm.toggle_heading_2.aliases ?? []), 'depliable', 'titre depliable'], title: 'Titre dépliable 2', subtext: 'Titre moyen qui masque son contenu', group: G_HEADINGS },
    toggle_heading_3: { ...sm.toggle_heading_3, aliases: [...(sm.toggle_heading_3.aliases ?? []), 'depliable', 'titre depliable'], title: 'Titre dépliable 3', subtext: 'Petit titre qui masque son contenu', group: G_HEADINGS },
    bullet_list: { ...sm.bullet_list, title: 'Liste à puces', subtext: 'Une liste simple', aliases: [...(sm.bullet_list.aliases ?? []), 'puces', 'liste'], group: G_BASIC },
    numbered_list: { ...sm.numbered_list, title: 'Liste numérotée', subtext: 'Une liste ordonnée', aliases: [...(sm.numbered_list.aliases ?? []), 'numerotee', 'liste'], group: G_BASIC },
    check_list: { ...sm.check_list, title: 'Case à cocher', subtext: 'Une liste de tâches', aliases: [...(sm.check_list.aliases ?? []), 'tache', 'todo', 'case', 'cocher'], group: G_BASIC },
    toggle_list: { ...sm.toggle_list, title: 'Liste dépliable', subtext: 'Masque ou affiche son contenu', aliases: [...(sm.toggle_list.aliases ?? []), 'depliable', 'toggle'], group: G_BASIC },
    quote: { ...sm.quote, title: 'Citation', subtext: 'Mettre une citation en valeur', aliases: [...(sm.quote.aliases ?? []), 'citation', 'quote'], group: G_BASIC },
    divider: { ...sm.divider, title: 'Séparateur', subtext: 'Ligne de séparation horizontale', aliases: [...(sm.divider.aliases ?? []), 'separateur', 'ligne', 'hr', '---'], group: G_BASIC },
    code_block: { ...sm.code_block, title: 'Code', subtext: 'Bloc de code avec coloration', aliases: [...(sm.code_block.aliases ?? []), 'code'], group: G_ADVANCED },
    table: { ...sm.table, title: 'Tableau simple', subtext: 'Un tableau de cellules', aliases: [...(sm.table.aliases ?? []), 'tableau'], group: G_ADVANCED },
    image: { ...sm.image, title: 'Image', subtext: 'Envoyer ou intégrer une image', group: G_MEDIA },
    video: { ...sm.video, title: 'Vidéo', subtext: 'Envoyer ou intégrer une vidéo', aliases: [...(sm.video.aliases ?? []), 'video'], group: G_MEDIA },
    audio: { ...sm.audio, title: 'Audio', subtext: 'Envoyer ou intégrer un son', group: G_MEDIA },
    file: { ...sm.file, title: 'Fichier', subtext: 'Joindre un fichier', aliases: [...(sm.file.aliases ?? []), 'fichier', 'piece jointe'], group: G_MEDIA },
    emoji: { ...sm.emoji, title: 'Emoji', subtext: 'Insérer un emoji', group: G_ADVANCED },
  },
  placeholders: {
    ...fr.placeholders,
    default: 'Écrivez, ou tapez « / » pour insérer un bloc…',
    heading: 'Titre',
    bulletListItem: 'Élément',
    numberedListItem: 'Élément',
    checkListItem: 'Tâche',
    toggleListItem: 'Élément dépliable',
  },
  drag_handle: {
    ...fr.drag_handle,
    delete_menuitem: 'Supprimer',
    colors_menuitem: 'Couleur',
  },
  multi_column: multiColumnLocales.fr,
};

export const SLASH_GROUP_ORDER = [G_BASIC, G_HEADINGS, G_LAYOUT, 'Pages et bases', G_MEDIA, G_ADVANCED];
