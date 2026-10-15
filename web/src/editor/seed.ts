// Seed content generated client-side (the server never authors editor content).
import type { UpdatePageRequest } from '@oriel/shared';
import { createPage, updatePage } from '../lib/pages';
import { modKey } from '../lib/util';
import { getEditor } from './registry';
import type { OrielEditor, OrielPartialBlock } from './schema';

const seeded = new Set<string>();

function isDocEmpty(editor: OrielEditor) {
  const doc = editor.document;
  if (doc.length === 0) return true;
  if (doc.length > 1) return false;
  const b = doc[0]!;
  return b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 0 && b.children.length === 0;
}

const p = (text: string): OrielPartialBlock => ({ type: 'paragraph', content: text });
const h2 = (text: string): OrielPartialBlock => ({ type: 'heading', props: { level: 2 }, content: text });
const todo = (text: string): OrielPartialBlock => ({ type: 'checkListItem', content: text });
const bullet = (text: string): OrielPartialBlock => ({ type: 'bulletListItem', content: text });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The editor currently mounted for the page (the instance may be recreated while we wait). */
async function liveEditor(pageId: string): Promise<OrielEditor | null> {
  for (let i = 0; i < 20; i++) {
    const editor = getEditor(pageId);
    if (editor?.domElement?.isConnected) return editor;
    await sleep(150);
  }
  return null;
}

/**
 * Fills the (empty) welcome page of a new workspace with a short getting-started guide, once, then clears
 * the page's `seed` flag so that it is never generated again.
 */
export async function fillWelcomePage(workspaceId: string, pageId: string): Promise<void> {
  const first = getEditor(pageId);
  if (seeded.has(pageId) || !first || !isDocEmpty(first)) return;
  seeded.add(pageId);
  const mod = modKey();
  let example: string | null = null;
  try {
    const page = await createPage({
      workspaceId,
      parentType: 'page',
      parentId: pageId,
      title: 'Exemple : notes de réunion',
      open: false,
      focusTitle: false,
    });
    example = page.id;
  } catch {
    /* offline: no example sub-page */
  }
  const blocks: OrielPartialBlock[] = [
    p('Oriel est votre espace de travail : des pages faites de blocs, des bases de données, et tout se synchronise en temps réel avec votre équipe.'),
    {
      type: 'callout',
      props: { emoji: '💡' },
      content: 'Tapez « / » n’importe où pour insérer un bloc : titre, liste, tableau, base de données, colonnes, vidéo YouTube, maquette Figma…',
    } as OrielPartialBlock,
    h2('Premiers pas'),
    todo('Donner un titre et une icône à une page'),
    todo('Écrire du texte, puis le sélectionner pour le mettre en forme'),
    todo('Taper « / » pour insérer un titre, une liste ou une base de données'),
    todo('Glisser un bloc avec sa poignée ⋮⋮ pour le déplacer, ou à côté d’un autre pour créer des colonnes'),
    todo('Faire un clic droit sur un bloc pour le dupliquer, le transformer ou copier son lien'),
    todo('Mentionner une page avec « @ »'),
    todo('Inviter votre équipe depuis Réglages › Membres'),
    h2('Raccourcis utiles'),
    bullet(`${mod}K : rechercher une page ou lancer une action`),
    bullet(`${mod}N : nouvelle page`),
    bullet(`${mod}D : dupliquer le bloc courant`),
    bullet(`${mod}\\ : afficher ou masquer la barre latérale`),
    bullet('? : tous les raccourcis clavier'),
    h2('Pour aller plus loin'),
    p('Une sous-page se crée avec « /page ». En voici une, prête à être complétée :'),
    ...(example ? [{ type: 'subpage', props: { pageId: example } } as OrielPartialBlock] : []),
    p('Une page réutilisable (compte rendu, fiche projet…) peut devenir un modèle : menu « … » › « Utiliser comme modèle ». Elle apparaît alors dans la section « Modèles » de la barre latérale.'),
  ];
  const editor = await liveEditor(pageId);
  if (!editor) {
    seeded.delete(pageId);
    return;
  }
  if (isDocEmpty(editor)) editor.replaceBlocks(editor.document, blocks);
  try {
    await updatePage(workspaceId, pageId, { format: { seed: null } } as unknown as UpdatePageRequest);
  } catch {
    /* the content exists: a later visit won't refill a non-empty page */
  }
}
