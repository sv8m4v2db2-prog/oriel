// I2 (formules structurées) — non-régression : les formules écrites avant les listes, pages et personnes
// gardent exactement leur résultat (type, valeur, erreur), y compris sur les relations, personnes,
// multi-sélections et fichiers que prop() lisait comme du texte. Résultats figés avec le moteur scalaire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, corpusResults } from './formula-corpus';

const FROZEN: Record<string, unknown[]> = {
  "1 + 2 * 3": [["number",7],["number",7],["number",7]],
  "\"a\" + 1 + 2": [["string","a12"],["string","a12"],["string","a12"]],
  "prop(\"Prix\") * prop(\"Quantité\")": [["number",37.5],["empty",null],["empty",null]],
  "round(prop(\"Prix\") / 7, 2)": [["number",1.79],["empty",null],["empty",null]],
  "if(prop(\"Fait\"), \"oui\", \"non\")": [["string","oui"],["string","non"],["string","non"]],
  "if(empty(prop(\"Notes\")), \"vide\", upper(prop(\"Notes\")))": [["string","BONJOUR LE MONDE"],["string","vide"],["string","vide"]],
  "length(prop(\"Notes\"))": [["number",16],["number",0],["number",0]],
  "length(prop(\"Nom\"))": [["number",5],["number",0],["number",5]],
  "concat(prop(\"Nom\"), \" — \", prop(\"Catégorie\"), \" / \", prop(\"État\"))": [["string","Alpha — Bleu / En cours"],["string"," —  / "],["string","Gamma —  / "]],
  "dateBetween(prop(\"Échéance\"), now(), \"days\")": [["number",6],["empty",null],["empty",null]],
  "dateAdd(prop(\"Échéance\"), 1, \"months\")": [["date",{"date":"2026-11-20 00:00"}],["empty",null],["empty",null]],
  "format(prop(\"Échéance\"))": [["string","20 oct. 2026"],["string",""],["string",""]],
  "min(prop(\"Prix\"), prop(\"Quantité\"), prop(\"Nombre\"))": [["number",0],["number",0],["empty",null]],
  "max(prop(\"Échéance\"), now())": [["date",{"date":"2026-10-20 00:00"}],["date",{"date":"2026-10-13 10:30"}],["date",{"date":"2026-10-13 10:30"}]],
  "toNumber(prop(\"Réf\"))": [["number",7],["empty",null],["empty",null]],
  "prop(\"Réf\") + 1": [["number",8],["empty",null],["empty",null]],
  "contains(prop(\"Site\"), \"EXEMPLE\")": [["boolean",true],["boolean",false],["boolean",false]],
  "prop(\"Nombre\") == 0": [["boolean",true],["boolean",false],["boolean",false]],
  "not prop(\"Fait\") or prop(\"Prix\") > 10": [["boolean",true],["boolean",true],["boolean",true]],
  "prop(\"Total\") / 2": [["number",18.75],["empty",null],["empty",null]],
  "format(prop(\"Créé le\"))": [["string","1 janv. 2026"],["string","1 janv. 2026"],["string","1 janv. 2026"]],
  "floor(-2.5) + ceil(2.1) + abs(-3)": [["number",3],["number",3],["number",3]],
  "10 % 4 - 1 / 4": [["number",1.75],["number",1.75],["number",1.75]],
  "lower(\"ÉTÉ\") == \"été\"": [["boolean",true],["boolean",true],["boolean",true]],
  "prop(\"Liens\")": [["string","Projet Alpha, Projet Béta"],["string","Projet Béta"],["string",""]],
  "prop(\"Responsable\")": [["string","Alice Martin, Bruno Petit"],["string","Bruno Petit"],["string",""]],
  "prop(\"Étiquettes\")": [["string","Urgent, Client"],["string","Client"],["string",""]],
  "prop(\"Pièces jointes\")": [["string","a.pdf, b.png"],["string",""],["string",""]],
  "prop(\"Créé par\")": [["string","Alice Martin"],["string","Alice Martin"],["string","Bruno Petit"]],
  "prop(\"Modifié par\")": [["string","Bruno Petit"],["string","Bruno Petit"],["string",""]],
  "length(prop(\"Liens\"))": [["number",25],["number",11],["number",0]],
  "length(prop(\"Responsable\"))": [["number",25],["number",11],["number",0]],
  "length(prop(\"Étiquettes\"))": [["number",14],["number",6],["number",0]],
  "length(prop(\"Pièces jointes\"))": [["number",12],["number",0],["number",0]],
  "length(prop(\"Créé par\"))": [["number",12],["number",12],["number",11]],
  "empty(prop(\"Liens\"))": [["boolean",false],["boolean",false],["boolean",true]],
  "empty(prop(\"Responsable\"))": [["boolean",false],["boolean",false],["boolean",true]],
  "empty(prop(\"Étiquettes\"))": [["boolean",false],["boolean",false],["boolean",true]],
  "not(prop(\"Liens\"))": [["boolean",false],["boolean",false],["boolean",true]],
  "if(prop(\"Responsable\"), \"attribué\", \"libre\")": [["string","attribué"],["string","attribué"],["string","libre"]],
  "prop(\"Liens\") and prop(\"Étiquettes\")": [["boolean",true],["boolean",true],["boolean",false]],
  "contains(prop(\"Liens\"), \"alpha\")": [["boolean",true],["boolean",false],["boolean",false]],
  "contains(prop(\"Étiquettes\"), \"Client\")": [["boolean",true],["boolean",true],["boolean",false]],
  "contains(prop(\"Responsable\"), \"bruno\")": [["boolean",true],["boolean",true],["boolean",false]],
  "prop(\"Étiquettes\") == \"Urgent, Client\"": [["boolean",true],["boolean",false],["boolean",false]],
  "prop(\"Étiquettes\") != \"Client\"": [["boolean",true],["boolean",false],["boolean",true]],
  "prop(\"Liens\") == \"Projet Béta\"": [["boolean",false],["boolean",true],["boolean",false]],
  "prop(\"Responsable\") < \"B\"": [["boolean",true],["boolean",false],["boolean",true]],
  "prop(\"Liens\") + \" !\"": [["string","Projet Alpha, Projet Béta !"],["string","Projet Béta !"],["string"," !"]],
  "\"→ \" + prop(\"Responsable\")": [["string","→ Alice Martin, Bruno Petit"],["string","→ Bruno Petit"],["string","→ "]],
  "concat(prop(\"Liens\"), \" | \", prop(\"Étiquettes\"), \" | \", prop(\"Responsable\"))": [["string","Projet Alpha, Projet Béta | Urgent, Client | Alice Martin, Bruno Petit"],["string","Projet Béta | Client | Bruno Petit"],["string"," |  | "]],
  "upper(prop(\"Liens\"))": [["string","PROJET ALPHA, PROJET BÉTA"],["string","PROJET BÉTA"],["string",""]],
  "lower(prop(\"Créé par\"))": [["string","alice martin"],["string","alice martin"],["string","bruno petit"]],
  "format(prop(\"Étiquettes\"))": [["string","Urgent, Client"],["string","Client"],["string",""]],
  "toNumber(prop(\"Étiquettes\"))": [["empty",null],["empty",null],["empty",null]],
  "min(prop(\"Liens\"))": [["empty",null,"Arguments invalides pour min() : nombres ou dates attendus"],["empty",null,"Arguments invalides pour min() : nombres ou dates attendus"],["empty",null,"Arguments invalides pour min() : nombres ou dates attendus"]],
  "max(prop(\"Responsable\"), 3)": [["empty",null,"Arguments invalides pour max() : nombres ou dates attendus"],["empty",null,"Arguments invalides pour max() : nombres ou dates attendus"],["empty",null,"Arguments invalides pour max() : nombres ou dates attendus"]],
  "round(prop(\"Liens\"))": [["empty",null,"Arguments invalides pour round()"],["empty",null,"Arguments invalides pour round()"],["empty",null,"Arguments invalides pour round()"]],
  "abs(prop(\"Étiquettes\"))": [["empty",null,"Arguments invalides pour abs()"],["empty",null,"Arguments invalides pour abs()"],["empty",null,"Arguments invalides pour abs()"]],
  "prop(\"Liens\") * 2": [["empty",null,"Opération « * » impossible entre un texte et un nombre"],["empty",null,"Opération « * » impossible entre un texte et un nombre"],["empty",null,"Opération « * » impossible entre un texte et un nombre"]],
  "-prop(\"Responsable\")": [["empty",null,"Opération « - » impossible sur un texte"],["empty",null,"Opération « - » impossible sur un texte"],["empty",null,"Opération « - » impossible sur un texte"]],
  "dateAdd(prop(\"Liens\"), 1, \"days\")": [["empty",null,"Arguments invalides pour dateAdd() : une date et un nombre attendus"],["empty",null,"Arguments invalides pour dateAdd() : une date et un nombre attendus"],["empty",null,"Arguments invalides pour dateAdd() : une date et un nombre attendus"]],
  "dateBetween(prop(\"Échéance\"), prop(\"Responsable\"), \"days\")": [["empty",null,"Arguments invalides pour dateBetween() : deux dates attendues"],["empty",null],["empty",null]],
  "if(prop(\"Étiquettes\") == \"\", 0, length(prop(\"Étiquettes\")))": [["number",14],["number",6],["number",0]],
  "prop(\"Créé par\") == \"Alice Martin\"": [["boolean",true],["boolean",true],["boolean",false]],
  "prop(\"Modifié par\") + \".\"": [["string","Bruno Petit."],["string","Bruno Petit."],["string","."]],
  "empty(prop(\"Modifié par\"))": [["boolean",false],["boolean",false],["boolean",true]],
};

test('le corpus figé couvre toutes les formules du corpus', () => {
  assert.deepEqual(Object.keys(FROZEN).sort(), [...CORPUS].sort());
});

test('les formules historiques gardent exactement leur résultat', () => {
  const now = corpusResults();
  for (const src of CORPUS) assert.deepEqual(now[src], FROZEN[src], src);
});
