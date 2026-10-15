# Données tierces embarquées

| Donnée | Source | Licence | Où |
|---|---|---|---|
| Mots-clés français des emoji (libellés et étiquettes CLDR) | `emojibase-data` 17.0.0, locale `fr` — https://emojibase.dev ; annotations CLDR du Consortium Unicode | MIT (paquet) ; Unicode License v3 (CLDR) — compatibles AGPL-3.0-or-later | `web/src/data/emojiKeywordsFr.ts` (jeu réduit généré, chargé à la demande) |
| Emoji et mots-clés anglais | `@emoji-mart/data` | MIT | dépendance npm |
| Moteur Typst compilé en WebAssembly (aperçu des blocs de code) | `@myriaddreamin/typst.ts`, `@myriaddreamin/typst-ts-web-compiler`, `@myriaddreamin/typst-ts-renderer` 0.7.0 — https://github.com/Myriad-Dreamin/typst.ts ; Typst — https://typst.app | Apache-2.0 | dépendances npm (chargées à la demande, dans un Web Worker) |
| Polices de l'aperçu Typst : Libertinus Serif, New Computer Modern (texte et maths), DejaVu Sans Mono | `@typst-wasm/fonts` 1.0.0 (polices par défaut de Typst) | SIL OFL-1.1 (Libertinus, New Computer Modern) ; licence Bitstream Vera / DejaVu | dépendance npm, servies par l'application elle-même |
