# Procédure « salle propre » (clean-room)

*[English version](CLEAN_ROOM.md)*

Oriel est une **réimplémentation indépendante** des *idées et principes* des outils de prise de
notes et d'espaces de travail par blocs. Aucune ligne de code, aucune ressource graphique, aucun
texte d'interface ni aucune marque d'un produit tiers n'a été copié.

## Séparation des rôles

1. **Analyse**
   - Le fonctionnement d'un produit existant a été observé et étudié, en tant qu'utilisateur
     disposant d'une licence et par son client web servi publiquement, sans compte. Le seul but
     était de comprendre son fonctionnement : modèle de données, principes de synchronisation,
     comportements visibles.
   - C'est ce qu'autorise l'article L122-6-1 III du Code de la propriété intellectuelle,
     transposant l'article 5(3) de la directive 2009/24/CE : observer, étudier ou tester le
     fonctionnement d'un logiciel afin de déterminer les idées et principes qui en sont à la base.
   - Les notes d'analyse sont conservées hors de ce dépôt.
2. **Barrière**
   - L'analyse a été transformée en documents rédigés en langage naturel : une spécification
     fonctionnelle ([`docs/SPEC.md`](docs/SPEC.md)), une architecture originale
     ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), contrat `shared/`) et des listes de
     fonctionnalités manquantes décrites comme des comportements.
   - Ces documents ne contiennent ni code, ni identifiant interne, ni texte d'interface du produit
     étudié. Ils décrivent les choix techniques propres à Oriel : index fractionnaires,
     Yjs/BlockNote, invalidations WebSocket, SQLite…
3. **Implémentation** (`server/`, `web/`, `desktop/`, `mcp/`, `deploy/`)
   - Réalisée par des contributeurs distincts, qui n'ont reçu que ces documents et la
     documentation publique des produits.
   - Il leur était explicitement interdit de consulter le code du produit étudié, son client web,
     son cache local ou les notes d'analyse.
   - Les bibliothèques tierces sont utilisées uniquement sous licences libres (voir `package.json`
     et [`docs/NOTICE-DATA.md`](docs/NOTICE-DATA.md)).

## Ce qui n'est pas repris

- Nom, logo, icônes, illustrations, textes d'interface, palette exacte, gabarits.
- Code, structures de fichiers, identifiants internes, protocole réseau exact : Oriel utilise son
  propre contrat d'API REST et WebSocket (voir `shared/src/api.ts` et `shared/src/events.ts`).

Les fonctions d'import lisent les formats d'export (Markdown, CSV, HTML, ZIP) d'autres outils,
uniquement par souci d'interopérabilité.

> Ce document décrit une démarche ; il ne constitue pas un avis juridique.
