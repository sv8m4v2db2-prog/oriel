/// <reference types="node" />
// Sample archive in the export format of the previous notes tool (Markdown + CSV, 32-hex ids,
// nested part zip), used by the planner tests and for manual end-to-end import checks:
//   npx tsx web/src/io/fixtures/sampleExport.ts /chemin/vers/exemple.zip
import { strToU8, zipSync } from 'fflate';

/** Deterministic 32-hex id derived from a label. */
export function fakeId(label: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of label) {
    const c = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e37), 0x85ebca6b) >>> 0;
  }
  const part = (n: number) => n.toString(16).padStart(8, '0');
  return part(h1) + part(h2) + part((h1 ^ 0xa5a5a5a5) >>> 0) + part((h2 + 0x1234567) >>> 0);
}

const enc = (s: string) => encodeURIComponent(s).replace(/%2F/g, '/');
const named = (title: string) => `${title} ${fakeId(title)}`;

// 8×8 PNG (ice pattern).
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAHklEQVR4nGO48+G/XMUJIEJjMGAVhUpg1cQwkEYBAAATdXJgx6HzAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

/** Files of the sample export (path → content). */
export function sampleExportFiles(opts: { responsible?: string } = {}): Record<string, Uint8Array> {
  const responsible = opts.responsible ?? 'Alice Martin';
  const projet = named('Projet Oriel ❄️');
  const notes = named('Notes de réunion');
  const taches = named('Tâches');
  const redac = named('Rédiger la doc');
  const deploy = named('Déployer le serveur');
  const qa = named('Q&A « spécial » été');
  const journal = named('Journal 🗓️');
  const contacts = named('Contacts');
  const ancienne = named('Ancienne note');

  const files: Record<string, string | Uint8Array> = {};

  files[`${projet}.md`] = `# Projet Oriel ❄️

Bienvenue dans l'espace **projet** ! Voir les [Notes de réunion](${enc(projet)}/${enc(notes)}.md) pour le suivi, ou la page [Q&A « spécial » été](${enc(qa)}.md).

<aside>
💡 Pensez à mettre à jour les tâches chaque lundi.
</aside>

## Sous-pages

[Notes de réunion](${enc(projet)}/${enc(notes)}.md)

[Tâches](${enc(projet)}/${enc(taches)}.csv)

![Logo de l'équipe](${enc(projet)}/logo%20oriel.png)

[Cahier des charges.pdf](${enc(projet)}/Cahier%20des%20charges.pdf)

- [ ] Préparer la démo
- [x] Installer le serveur
    - Vérifier les sauvegardes

> Une citation inspirante sur la oriel.

| Étape | Date |
| --- | --- |
| Lancement | 13/10/2026 |
| Bilan | 15/12/2026 |

\`\`\`js
console.log('bonjour la oriel');
\`\`\`

Lien externe : [Site officiel](https://example.com/oriel)
`;

  files[`${projet}/${notes}.md`] = `# Notes de réunion

Compte rendu du **13 octobre 2026**.

1. Point sur [Rédiger la doc](${enc(taches)}/${enc(redac)}.md)
2. Retour au [Projet Oriel ❄️](../${enc(projet)}.md)

<details>
<summary>Détails techniques</summary>

Le serveur tourne sur un VPS.

</details>
`;

  files[`${projet}/logo oriel.png`] = PNG;
  files[`${projet}/Cahier des charges.pdf`] = strToU8('%PDF-1.4\n% faux PDF de test\n');

  const header = 'Nom,Statut,Priorité,Échéance,Estimation (h),Budget,Terminé,Étiquettes,Responsable,Site,Contact,Projet lié,Créé le';
  const rowsAll = [
    `Rédiger la doc,En cours,Haute,"October 13, 2026 → October 15, 2026",4,"€1,200.50",No,"doc, interne",${responsible},https://oriel.app/docs,alice@exemple.fr,"Projet Oriel ❄️ (../${enc(projet)}.md)",13/10/2026 14:30`,
    `Déployer le serveur,Terminé,Moyenne,"October 20, 2026",2.5,€300,Yes,"ops, interne",${responsible},https://oriel.app,ops@exemple.fr,,14/10/2026 09:05`,
    `Préparer la démo,Pas commencé,Haute,,1,€0,No,démo,,,,,15/10/2026 18:00`,
  ];
  files[`${projet}/${taches}.csv`] = `﻿${header}\n${rowsAll.slice(0, 2).join('\n')}\n`;
  files[`${projet}/${taches}_all.csv`] = `﻿${header}\n${rowsAll.join('\n')}\n`;

  files[`${projet}/${taches}/${redac}.md`] = `# Rédiger la doc

Statut: En cours
Priorité: Haute
Échéance: October 13, 2026 → October 15, 2026
Étiquettes: doc, interne

Rédiger le guide d'installation, voir les [Notes de réunion](../${enc(notes)}.md).

![Capture](${enc(redac)}/capture.png)
`;
  files[`${projet}/${taches}/${redac}/capture.png`] = PNG;
  files[`${projet}/${taches}/${deploy}.md`] = `# Déployer le serveur

Statut: Terminé
Terminé: Yes

Fait avec Docker.
`;

  files[`${qa}.md`] = `# Q&A « spécial » été

Questions fréquentes. Retour au [Projet Oriel ❄️](${enc(projet)}.md).
`;

  files[`${journal}.md`] = `# Journal 🗓️

Aujourd'hui j'ai travaillé sur [Projet Oriel ❄️](${enc(projet)}.md) et la base [Contacts](${enc(contacts)}.csv).
`;

  files[`${contacts}.csv`] = `﻿Nom,Téléphone,E-mail,Client,Dernier contact,Actif
Marie Curie,+33 6 12 34 56 78,marie@exemple.fr,Oui,13/10/2026,Oui
Paul Émile,+33 7 98 76 54 32,paul@exemple.fr,Non,02/09/2026,Non
Zoé Lambert,01 23 45 67 89,zoe@exemple.fr,Oui,25/12/2025,Oui
`;

  files[`Archives/${ancienne}.md`] = `# Ancienne note

Une note rangée dans un dossier sans page.
`;
  files['__MACOSX/._Archives'] = strToU8('junk');

  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) out[k] = typeof v === 'string' ? strToU8(v) : v;
  return out;
}

/** The sample as the tool delivers it: an outer zip holding an "Export-…-Part-1.zip". */
export function sampleExportZip(opts: { responsible?: string; nested?: boolean } = {}): Uint8Array {
  const inner = zipSync(sampleExportFiles(opts));
  if (opts.nested === false) return inner;
  return zipSync({ [`Export-${fakeId('export')}-Part-1.zip`]: inner });
}

// CLI
const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
if (argv[1] && /sampleExport\.ts$/.test(argv[1])) {
  const target = argv[2] ?? 'exemple-export.zip';
  const responsible = argv[3];
  const fs = await import('node:fs');
  fs.writeFileSync(target, sampleExportZip({ responsible }));
  console.log(`Archive d'exemple écrite : ${target}`);
}
