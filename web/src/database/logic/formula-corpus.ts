// Corpus of formulas written before structured values (lists, pages, people): their results are frozen
// in formula-regression.test.ts and must not change (I2, formules structurées).
import type { Page, PropertyDef } from '@oriel/shared';
import { format as formatDate } from 'date-fns';
import { createRowContext, getFormulaResult } from './values';
import { makeRow, NOW, RELATED, SCHEMA, USERS } from './testFixtures';

export const CORPUS_SCHEMA: PropertyDef[] = [
  ...SCHEMA,
  { id: 'modif', name: 'Modifié par', type: 'last_edited_by' },
  { id: 'nb', name: 'Nombre', type: 'number' },
];

export const CORPUS_ROWS: Page[] = [
  makeRow('r1', 'Alpha', {
    notes: 'Bonjour le monde',
    prix: 12.5,
    qte: 3,
    cat: 'o1',
    etat: 'doing',
    tags: ['t1', 't2'],
    due: { start: '2026-10-20' },
    fait: true,
    resp: ['u1', 'u2'],
    liens: ['p1', 'p2'],
    pj: [{ url: '/files/a.pdf', name: 'a.pdf' }, { url: '/files/b.png', name: 'b.png' }],
    ref: 7,
    site: 'https://exemple.test',
    nb: 0,
  }),
  makeRow('r2', '', { prix: null, qte: 0, tags: ['t2'], resp: ['u2'], liens: ['p2', 'inconnu'], fait: false }),
  makeRow('r3', 'Gamma', { notes: '', tags: [], resp: [], liens: [], pj: [] }, { createdBy: 'u2', updatedBy: 'zz' }),
];

export const CORPUS: string[] = [
  // Scalaires
  '1 + 2 * 3',
  '"a" + 1 + 2',
  'prop("Prix") * prop("Quantité")',
  'round(prop("Prix") / 7, 2)',
  'if(prop("Fait"), "oui", "non")',
  'if(empty(prop("Notes")), "vide", upper(prop("Notes")))',
  'length(prop("Notes"))',
  'length(prop("Nom"))',
  'concat(prop("Nom"), " — ", prop("Catégorie"), " / ", prop("État"))',
  'dateBetween(prop("Échéance"), now(), "days")',
  'dateAdd(prop("Échéance"), 1, "months")',
  'format(prop("Échéance"))',
  'min(prop("Prix"), prop("Quantité"), prop("Nombre"))',
  'max(prop("Échéance"), now())',
  'toNumber(prop("Réf"))',
  'prop("Réf") + 1',
  'contains(prop("Site"), "EXEMPLE")',
  'prop("Nombre") == 0',
  'not prop("Fait") or prop("Prix") > 10',
  'prop("Total") / 2',
  'format(prop("Créé le"))',
  'floor(-2.5) + ceil(2.1) + abs(-3)',
  '10 % 4 - 1 / 4',
  'lower("ÉTÉ") == "été"',
  // Propriétés multivaluées, lues aujourd'hui comme du texte
  'prop("Liens")',
  'prop("Responsable")',
  'prop("Étiquettes")',
  'prop("Pièces jointes")',
  'prop("Créé par")',
  'prop("Modifié par")',
  'length(prop("Liens"))',
  'length(prop("Responsable"))',
  'length(prop("Étiquettes"))',
  'length(prop("Pièces jointes"))',
  'length(prop("Créé par"))',
  'empty(prop("Liens"))',
  'empty(prop("Responsable"))',
  'empty(prop("Étiquettes"))',
  'not(prop("Liens"))',
  'if(prop("Responsable"), "attribué", "libre")',
  'prop("Liens") and prop("Étiquettes")',
  'contains(prop("Liens"), "alpha")',
  'contains(prop("Étiquettes"), "Client")',
  'contains(prop("Responsable"), "bruno")',
  'prop("Étiquettes") == "Urgent, Client"',
  'prop("Étiquettes") != "Client"',
  'prop("Liens") == "Projet Béta"',
  'prop("Responsable") < "B"',
  'prop("Liens") + " !"',
  '"→ " + prop("Responsable")',
  'concat(prop("Liens"), " | ", prop("Étiquettes"), " | ", prop("Responsable"))',
  'upper(prop("Liens"))',
  'lower(prop("Créé par"))',
  'format(prop("Étiquettes"))',
  'toNumber(prop("Étiquettes"))',
  'min(prop("Liens"))',
  'max(prop("Responsable"), 3)',
  'round(prop("Liens"))',
  'abs(prop("Étiquettes"))',
  'prop("Liens") * 2',
  '-prop("Responsable")',
  'dateAdd(prop("Liens"), 1, "days")',
  'dateBetween(prop("Échéance"), prop("Responsable"), "days")',
  'if(prop("Étiquettes") == "", 0, length(prop("Étiquettes")))',
  'prop("Créé par") == "Alice Martin"',
  'prop("Modifié par") + "."',
  'empty(prop("Modifié par"))',
];

/** Serialized result of every corpus formula on every corpus row: [type, value, error?] (dates in local time). */
export function corpusResults(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const src of CORPUS) {
    const f: PropertyDef = { id: 'f', name: 'F', type: 'formula', formula: src };
    const ctx = createRowContext([...CORPUS_SCHEMA, f], { users: USERS, relationTitle: (id) => RELATED[id], now: () => NOW });
    out[src] = CORPUS_ROWS.map((row) => {
      const r = getFormulaResult(row, f, ctx);
      const v = r.value instanceof Date ? { date: formatDate(r.value, 'yyyy-MM-dd HH:mm') } : r.value;
      return r.error ? [r.type, v, r.error] : [r.type, v];
    });
  }
  return out;
}
