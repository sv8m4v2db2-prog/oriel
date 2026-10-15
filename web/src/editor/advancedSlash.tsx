// Slash-menu items of the advanced blocks: Titre dépliable 4, équations, fil d'Ariane, onglets, bouton.
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { FileText, Heading4, MousePointerClick, PenLine, Mic, Navigation, PanelTop, Sigma, SquareFunction } from 'lucide-react';
import { EDITOR_BLOCK_TYPES } from '@oriel/shared';
import type { EditorEnv } from './env';
import { openNextInlineEquation, openOnMount } from './math';
import { newTabsBlock } from './layoutBlocks';
import { openButtonOnMount } from './buttonBlock';
import { speechRecognitionCtor } from './dictation';
import { insertFootnote } from './footnotes';

type Place = (editor: any, refBlockId: string, block: any) => { id: string } | undefined;

/** Slash items of the advanced blocks; `place` inserts a block where the menu was opened. */
export function advancedSlashItems(editor: any, env: EditorEnv, place: Place, groups: { headings: string; layout: string; advanced: string }): DefaultReactSuggestionItem[] {
  const here = () => editor.getTextCursorPosition().block.id as string;
  const has = (type: string) => type in editor.schema.blockSchema;
  const items: DefaultReactSuggestionItem[] = [
    {
      title: 'Titre dépliable 4',
      subtext: 'Titre de sous-section qui masque son contenu',
      aliases: ['h4', 'titre4', 'titre 4', 'depliable', 'repliable', 'toggle'],
      group: groups.headings,
      icon: <Heading4 size={18} />,
      onItemClick: () => {
        const ref = editor.getTextCursorPosition().block;
        const empty = ref.type === 'paragraph' && Array.isArray(ref.content) && ref.content.length === 0;
        if (empty) editor.updateBlock(ref, { type: 'heading', props: { level: 4, isToggleable: true } });
        else {
          const [b] = editor.insertBlocks([{ type: 'heading', props: { level: 4, isToggleable: true } }], ref, 'after');
          if (b) editor.setTextCursorPosition(b, 'end');
        }
      },
    },
  ];
  if (has(EDITOR_BLOCK_TYPES.equation)) {
    items.push({
      title: 'Équation',
      subtext: 'Formule mathématique centrée (TeX)',
      aliases: ['equation', 'formule', 'maths', 'math', 'latex', 'tex', 'katex', '$$'],
      group: groups.advanced,
      icon: <SquareFunction size={18} />,
      onItemClick: () => {
        const inserted = place(editor, here(), { type: EDITOR_BLOCK_TYPES.equation });
        if (inserted) openOnMount.add(inserted.id);
      },
    });
  }
  if (EDITOR_BLOCK_TYPES.inlineEquation in editor.schema.inlineContentSchema) {
    items.push({
      title: 'Équation en ligne',
      subtext: 'Formule dans le fil du texte',
      aliases: ['equation en ligne', 'formule en ligne', 'maths', 'math', 'latex', 'tex', 'inline'],
      group: groups.advanced,
      icon: <Sigma size={18} />,
      onItemClick: () => {
        openNextInlineEquation();
        editor.insertInlineContent([{ type: EDITOR_BLOCK_TYPES.inlineEquation, props: { tex: '' } }]);
      },
    });
  }
  if (EDITOR_BLOCK_TYPES.footnote in editor.schema.inlineContentSchema) {
    items.push({
      title: 'Note de bas de page',
      subtext: 'Numérotée automatiquement, listée en bas de la page',
      aliases: ['note', 'note de bas de page', 'bas de page', 'reference', 'renvoi', 'footnote', 'annotation'],
      group: groups.advanced,
      icon: <FileText size={18} />,
      onItemClick: () => insertFootnote(editor),
    });
  }
  if (has(EDITOR_BLOCK_TYPES.drawing)) {
    items.push({
      title: 'Dessin',
      subtext: 'Croquis à main levée (stylo, gomme, couleurs)',
      aliases: ['dessin', 'croquis', 'schema', 'sketch', 'stylo', 'draw', 'drawing'],
      group: groups.advanced,
      icon: <PenLine size={18} />,
      onItemClick: () => place(editor, here(), { type: EDITOR_BLOCK_TYPES.drawing }),
    });
  }
  if (speechRecognitionCtor()) {
    items.push({
      title: 'Dictée vocale',
      subtext: 'Dicter du texte avec le micro (audio traité par le navigateur)',
      aliases: ['dictee', 'voix', 'micro', 'dicter', 'vocal', 'speech'],
      group: groups.advanced,
      icon: <Mic size={18} />,
      onItemClick: () => window.dispatchEvent(new CustomEvent('oriel:dictation-start')),
    });
  }
  if (has(EDITOR_BLOCK_TYPES.breadcrumb)) {
    items.push({
      title: 'Fil d’Ariane',
      subtext: 'Chemin de la page parmi ses parents',
      aliases: ['fil d ariane', 'ariane', 'chemin', 'parents', 'navigation', 'breadcrumb'],
      group: groups.layout,
      icon: <Navigation size={18} />,
      onItemClick: () => place(editor, here(), { type: EDITOR_BLOCK_TYPES.breadcrumb }),
    });
  }
  if (has(EDITOR_BLOCK_TYPES.tabs)) {
    items.push({
      title: 'Onglets',
      subtext: 'Contenu réparti en onglets',
      aliases: ['onglets', 'onglet', 'volets', 'tabs', 'mise en page'],
      group: groups.layout,
      icon: <PanelTop size={18} />,
      onItemClick: () => {
        const inserted = place(editor, here(), newTabsBlock());
        const first = inserted ? editor.getBlock(inserted.id)?.children[0]?.children[0] : null;
        try {
          if (first) editor.setTextCursorPosition(first, 'start');
        } catch {
          /* no text cursor */
        }
      },
    });
  }
  if (has(EDITOR_BLOCK_TYPES.button) && env.mode === 'app') {
    items.push({
      title: 'Bouton',
      subtext: 'Insère du contenu, remplit une base ou ouvre une page en un clic',
      aliases: ['bouton', 'button', 'action', 'actions', 'automatisation', 'declencheur'],
      group: groups.advanced,
      icon: <MousePointerClick size={18} />,
      onItemClick: () => {
        const inserted = place(editor, here(), { type: EDITOR_BLOCK_TYPES.button });
        if (inserted) openButtonOnMount.add(inserted.id);
      },
    });
  }
  return items;
}

/** Heading items in reading order: Titre 1–4, then Titre dépliable 1–4 (BlockNote lists 4 last). */
const HEADING_ORDER = ['Titre 1', 'Titre 2', 'Titre 3', 'Titre 4', 'Titre dépliable 1', 'Titre dépliable 2', 'Titre dépliable 3', 'Titre dépliable 4'];
export function headingRank(item: { title: string }): number {
  const i = HEADING_ORDER.indexOf(item.title);
  return i === -1 ? HEADING_ORDER.length : i;
}
