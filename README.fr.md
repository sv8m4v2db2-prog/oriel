# Oriel

*[English version](README.md)*

**Oriel est un espace de travail collaboratif open-source et auto-hébergeable.** Rédigez des pages
composées de blocs, organisez-les en arborescence, construisez des bases de données dont chaque ligne
est une page, et éditez à plusieurs en temps réel. Oriel tourne sur votre propre serveur (un petit
VPS suffit) et en application macOS, avec un mode local facultatif qui se passe de serveur.

L'interface est en français. Oriel est distribué sous [licence GNU AGPL-3.0 ou ultérieure](LICENSE).

![Une page avec des blocs variés](docs/screenshots/page.png)

## Fonctionnalités

- **Pages et blocs** : titres, listes, cases à cocher, blocs dépliables, encadrés, citations, code
  coloré, tableaux, colonnes, onglets, équations, images, vidéos, fichiers, intégrations, signets,
  table des matières, blocs synchronisés, boutons ; menu `/`, raccourcis Markdown, glisser-déposer,
  mentions de pages, de personnes et de dates.
- **Collaboration en temps réel** : fusion sans conflit (CRDT Yjs), présence et curseurs, copie hors
  ligne dans le navigateur.
- **Bases de données dont chaque ligne est une page** : plus de 20 types de propriétés (sélection,
  statut, date, personne, relation, rollup, formule, ID unique, lieu, fichiers…), filtres, tris,
  regroupements et calculs.
- **Vues** : tableau, Kanban, liste, galerie, calendrier, chronologie, fil d'actualité, graphiques
  (barres, courbes, anneau, nombre), tableau de bord, carte et formulaire (partageable publiquement).
- **Commentaires et mentions**, boîte de réception et notifications par e-mail (immédiates ou en
  résumé quotidien).
- **Historique des versions** avec comparaison bloc par bloc et restauration sélective, corbeille
  (30 jours).
- **Recherche** dans les titres et les contenus, navigation rapide, favoris, espaces d'équipe, pages
  privées.
- **Lecture** : mode présentation, mode focus, recherche dans la page.
- **Équipes et sécurité** : espaces de travail, rôles, liens d'invitation, double authentification
  (TOTP) et clés d'accès, politique imposant la double authentification, authentification unique
  (OpenID Connect), domaines vérifiés.
- **Partage et import / export** : pages publiques, export Markdown et HTML, import d'exports
  Markdown et CSV d'autres outils, de fichiers Word et Excel.
- **App macOS** : se connecte à votre serveur avec onglets, recherche rapide globale et pastille du
  Dock, ou fonctionne en mode local.
- **Intégration de Claude (MCP)** : jetons d'API personnels et serveur MCP pour que Claude Desktop ou
  Claude Code lisent, rédigent et interrogent vos pages avec vos droits ; Brief du jour par IA,
  facultatif.

## Captures d'écran

| | |
|---|---|
| ![Vue tableau](docs/screenshots/database-table.png) Tableau | ![Vue Kanban](docs/screenshots/database-board.png) Kanban |
| ![Vue calendrier](docs/screenshots/database-calendar.png) Calendrier | ![Vue chronologie](docs/screenshots/database-timeline.png) Chronologie |
| ![Vue galerie](docs/screenshots/database-gallery.png) Galerie | ![Vue graphique](docs/screenshots/database-chart.png) Graphique |
| ![Tableau de bord](docs/screenshots/database-dashboard.png) Tableau de bord | ![Vue carte](docs/screenshots/database-map.png) Carte |
| ![Vue formulaire](docs/screenshots/database-form.png) Formulaire | ![Commentaires et mentions](docs/screenshots/comments.png) Commentaires et mentions |
| ![Recherche](docs/screenshots/search.png) Recherche | ![Historique des versions](docs/screenshots/history.png) Historique des versions et comparaison |
| ![Mode présentation](docs/screenshots/presentation.png) Mode présentation | ![Réglages de sécurité](docs/screenshots/security.png) Double authentification |
| ![Page en thème sombre](docs/screenshots/dark-page.png) Thème sombre | ![Kanban en thème sombre](docs/screenshots/dark-board.png) Thème sombre |
| ![Tableau de bord en thème sombre](docs/screenshots/dark-dashboard.png) Thème sombre | |

Les captures montrent un espace de démonstration fictif.

## Démarrage rapide

Sur un serveur Debian ou Ubuntu vers lequel pointe déjà votre nom de domaine :

```bash
git clone <url-du-dépôt> oriel && cd oriel
sudo ./deploy/install.sh
```

Le script installe Docker, demande le domaine et un e-mail pour le certificat HTTPS (Caddy et Let's
Encrypt), puis démarre Oriel. Ouvrez `https://votre-domaine` : **le premier compte créé devient
administrateur** ; les autres personnes rejoignent par lien d'invitation.

Pour l'essayer en local (Node.js ≥ 22.13) :

```bash
npm ci
npm run build
PORT=3000 HOST=127.0.0.1 DATA_DIR=$(mktemp -d) node server/dist/server.cjs
```

puis ouvrez `http://127.0.0.1:3000`.

## Documentation

| Guide | Contenu |
|---|---|
| [Installation](docs/INSTALL.fr.md) ([English](docs/INSTALL.md)) | Docker et Caddy, nginx et systemd, app macOS, développement, variables d'environnement, SMTP, IA, cartes, SSO, double authentification, sauvegardes, mises à jour, MCP, dépannage |
| [DEPLOY.md](docs/DEPLOY.md) | Déploiement sur serveur en détail |
| [DESKTOP.md](docs/DESKTOP.md) | Application macOS |
| [MCP.md](docs/MCP.md) | Serveur MCP pour Claude |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md), [SPEC.md](docs/SPEC.md) | Architecture et spécification fonctionnelle |

## Développement

```bash
npm ci
npm run dev            # API sur 127.0.0.1:3001 + client web sur http://localhost:5173
npm test -w server     # tests du serveur
npm run build          # web/dist + server/dist/server.cjs
```

| Dossier | Contenu |
|---|---|
| `shared/` | contrat TypeScript commun à tous les paquets |
| `server/` | Fastify, SQLite (`node:sqlite`, FTS5), Hocuspocus (Yjs) |
| `web/` | React 19, Mantine, TanStack Query, éditeur BlockNote |
| `desktop/` | application Electron pour macOS |
| `mcp/` | serveur MCP |
| `deploy/` | Docker Compose, Caddy, scripts d'installation, de sauvegarde et de restauration |

## Réimplémentation « salle propre »

Oriel est une implémentation indépendante, écrite à partir de descriptions fonctionnelles selon une
procédure « salle propre » décrite dans [CLEAN_ROOM.fr.md](CLEAN_ROOM.fr.md). Elle n'est ni affiliée ni
approuvée par un autre éditeur de logiciel.

## Licence

[GNU AGPL-3.0 ou ultérieure](LICENSE). Vous pouvez utiliser, modifier et redistribuer Oriel ; si vous
proposez une version modifiée à d'autres personnes via un réseau, vous devez leur donner accès à son
code source. Les dépendances sont sous licences libres (MIT, MPL-2.0 pour BlockNote, GPL-3.0 pour ses
modules colonnes et exports).
