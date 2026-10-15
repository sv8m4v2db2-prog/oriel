# Oriel — Architecture technique

Complète [`SPEC.md`](SPEC.md) (le *quoi*) par le *comment*. Les types TypeScript de
`shared/src/` font foi pour tous les échanges (API HTTP, événements temps réel, noms de blocs).

## 1. Vue d'ensemble

```
┌──────────── Navigateur / App macOS (Electron) ────────────┐
│  React 19 + Vite  ·  TanStack Query  ·  Mantine 9          │
│  Éditeur BlockNote 0.55 (ProseMirror) + Yjs                │
│     │ HTTP JSON (/api/*)   │ WS /api/events │ WS /collab   │
└─────┼──────────────────────┼────────────────┼──────────────┘
      ▼                      ▼                ▼
┌──────────────────── Serveur Node ≥ 22.13 (un seul process) ┐
│ Fastify 5 (REST, cookies, multipart, fichiers statiques)    │
│ Bus d'invalidation (ws)       Hocuspocus 4 (Yjs, /collab)   │
│ SQLite via node:sqlite (WAL, FTS5)   Fichiers : DATA_DIR/   │
└─────────────────────────────────────────────────────────────┘
```

Principes retenus de l'analyse (idées, pas de code) et choix d’Oriel :

| Idée observée | Choix Oriel |
|---|---|
| Tout est enregistrement avec pointeur parent + ordre des enfants | Table `pages` (pages, bases, lignes) avec `parent_type/parent_id` et **index fractionnaire** `position` (au lieu d'un tableau `content` côté parent → pas de contention) |
| Lignes de base = pages | Idem : `pages.properties` (JSON par id de propriété) |
| Schéma de collection séparé + vues avec requête/format | Tables `databases` (schéma JSON) et `views` (type + `config` JSON) |
| Texte de bloc en CRDT | **Tout le contenu d'une page** = un document **Yjs** (BlockNote), synchronisé par Hocuspocus |
| Transactions d'opérations versionnées | Chaque écriture REST incrémente `version`, met à jour `updated_*` et publie un **Change** |
| Invalidation poussée, données tirées | WebSocket `/api/events` : le serveur pousse des `Change` ; le client invalide ses requêtes TanStack et relit |
| Suppression douce (`alive`, corbeille) | `trashed_at/trashed_by`, purge à 30 j |
| Cache SQLite local côté desktop | Mode local de l'app macOS = serveur Oriel embarqué (même code, SQLite local) ; contenu des pages mis en cache dans IndexedDB (y-indexeddb) côté client |

## 2. Arborescence du dépôt

```
shared/   types & contrat (TS pur, pas de build : consommé en source)
server/   API + temps réel + collaboration ; build esbuild → server/dist/server.cjs (fichier unique)
web/      SPA React ; build Vite → web/dist
desktop/  coque Electron macOS ; embarque server.cjs + web/dist pour le mode local
deploy/   docker-compose, Caddyfile, scripts d'installation et de sauvegarde
Dockerfile
docs/     SPEC, ARCHITECTURE, DEPLOY, DESKTOP
```

## 3. Serveur

### 3.1 Démarrage et configuration
- `server/src/app.ts` exporte `startServer(options?: Partial<ServerOptions>): Promise<RunningServer>`
  avec `RunningServer = { port: number; url: string; close(): Promise<void> }`.
  `server/src/index.ts` (entrée CLI) lit l'environnement et appelle `startServer`.
- Le bundle `server/dist/server.cjs` doit **à la fois** démarrer quand il est exécuté directement
  (`node server.cjs`) **et** exporter `startServer` quand il est `require()`-é (Electron).
- Variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port HTTP |
| `HOST` | `0.0.0.0` | interface d'écoute (`127.0.0.1` en mode local desktop) |
| `DATA_DIR` | `./data` | base `oriel.db` + `uploads/` |
| `WEB_DIST` | auto (`../web/dist` relatif au bundle, puis `./web`) | fichiers de la SPA |
| `PUBLIC_URL` | vide | URL publique (liens d'invitation absolus, cookies `Secure` si https) |
| `SIGNUP_MODE` | `first-user` | valeur initiale ; ensuite modifiable par l'admin (stockée en base) |
| `MAX_UPLOAD_MB` | `25` | taille max d'un fichier |
| `TRUST_PROXY` | `true` | en-têtes `X-Forwarded-*` acceptés du seul pair direct, et seulement s'il est un proxy autorisé : `true` = boucle locale + réseaux privés, `false` = jamais, ou liste d'IP / plages CIDR (`loopback`, `private` acceptés) |
| `LOG_LEVEL` | `info` | journalisation Fastify |
| `ORIEL_LOCAL_MODE` | vide | `1` = mode local desktop : connexion automatique de l'utilisateur local, pas d'écran de connexion |

- En mode local (`ORIEL_LOCAL_MODE=1`), le serveur crée au besoin un utilisateur « Moi »
  (`local@oriel.app`) + un espace, et `GET /api/auth/me` ouvre automatiquement une session pour
  lui si aucune n'existe (uniquement si la requête vient de 127.0.0.1).

### 3.2 Schéma SQLite (`DATA_DIR/oriel.db`, WAL, `foreign_keys=ON`)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);            -- schema_version, signup_mode
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  avatar_url TEXT, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 du jeton du cookie (le jeton brut n'est jamais stocké)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, user_agent TEXT);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  joined_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
CREATE TABLE invites (
  token TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pages (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_type TEXT NOT NULL CHECK (parent_type IN ('workspace','page','database')),
  parent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('page','database')),
  title TEXT NOT NULL DEFAULT '', icon TEXT, cover TEXT,              -- cover: JSON
  position TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'workspace', owner_id TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}', format TEXT NOT NULL DEFAULT '{}',
  is_inline INTEGER NOT NULL DEFAULT 0, is_public INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER, trashed_by TEXT, trash_root INTEGER NOT NULL DEFAULT 0, -- 1 = page explicitement supprimée
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX pages_parent ON pages(parent_type, parent_id);
CREATE INDEX pages_ws ON pages(workspace_id, trashed_at);
CREATE TABLE databases (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  properties TEXT NOT NULL,                     -- JSON PropertyDef[]
  next_unique_id INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE views (
  id TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL, position TEXT NOT NULL, config TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE documents (                          -- contenu Yjs d'une page
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  state BLOB NOT NULL, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
  editors TEXT NOT NULL DEFAULT '[]');            -- ids des éditeurs depuis le dernier instantané
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  state BLOB NOT NULL, created_at INTEGER NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL);
CREATE INDEX snapshots_page ON snapshots(page_id, created_at);
CREATE TABLE page_links (                         -- références extraites du contenu (rétroliens)
  source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id));
CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, position TEXT NOT NULL, PRIMARY KEY (user_id, page_id));
CREATE TABLE visits (
  user_id TEXT NOT NULL, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, visited_at INTEGER NOT NULL, PRIMARY KEY (user_id, page_id));
CREATE TABLE files (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, uploader_id TEXT NOT NULL, name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE search USING fts5(page_id UNINDEXED, workspace_id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2');
```
Migrations : tableau ordonné de scripts SQL appliqués au démarrage selon `meta.schema_version`.

**Module « organisation » (vague H3, migrations `org-001` à `org-003`)** — tables additives, aucune table
existante modifiée : `org_journal_settings` / `org_journal_entries` (un journal privé par personne et par
jour), `org_tags` + `org_page_tags` (tags d'espace), `org_page_props` + `org_page_prop_values` (propriétés
de page de l'espace, hors bases), `org_collections` + `org_collection_pages` (règles JSON, ajouts et
exclusions à la main), `org_saved_views` (vues de « Toutes les pages »), `org_folder_items` (tags et
collections rangés dans un dossier de la barre latérale). Le moteur de liste (`services/collections.ts`,
`listPages`) filtre toujours par `visiblePageClause` : un tag, une collection ou « Toutes les pages » ne
révèle jamais une page invisible, ni dans les résultats ni dans les nombres.

### 3.3 Contrôle d'accès (une seule fonction centrale)
- `role(user, workspace)` depuis `members`. `canRead` = membre ; `canEdit` = rôle ≠ `viewer`.
- Page `private` : lisible/éditable **seulement** par `owner_id` (même un admin ne la voit pas).
- La visibilité d'une page est celle de sa **racine** (ancêtre dont `parent_type='workspace'`) ;
  le serveur la recopie sur toute la sous-arborescence à chaque création/déplacement.
- Une page est **publiquement visible** si elle ou un ancêtre a `is_public=1` et qu'aucun n'est à
  la corbeille. L'accès public est en lecture seule (HTTP `/api/public/*` et `/collab`).
- Les lignes d'une base héritent de la base ; les bases en ligne de leur page parente.
- Toute route renvoie `404 not_found` (et non 403) pour une page invisible, afin de ne pas
  divulguer son existence.

### 3.4 Règles métier côté serveur
- **Création** : `position` calculée avec `positionForInsert` (shared). Parent vérifié (même
  espace, non supprimé, lisible+éditable). Une base (`kind='database'`) crée : schéma par défaut
  (`defaultDatabaseProperties`), une vue « Tableau » (`defaultViewConfig('table', …)`) et, sauf
  `emptyDatabase`, 3 lignes vides. Une ligne reçoit les valeurs `unique_id` (compteur
  `next_unique_id`) pour chaque propriété de ce type.
- **Mise à jour des propriétés** : validation de forme selon le type ; refus d'écrire les types
  calculés ; option inconnue → `400`.
- **Déplacement** : interdit de déplacer une page dans elle-même ou un descendant (`400`) ; une
  ligne ne peut changer que d'ordre dans sa base (ou devenir page ordinaire : hors périmètre v1).
- **Corbeille** : `trash` marque la page (`trash_root=1`) et tous ses descendants (`trashed_at`
  identique) ; `restore` rétablit la racine et les descendants portant le même `trashed_at` ; si
  le parent est absent/supprimé → racine de l'espace avec la visibilité courante. `DELETE`
  définitif uniquement si dans la corbeille ; supprime descendants, documents, fichiers orphelins
  non requis (les fichiers sont conservés : simplicité). Tâche périodique (toutes les heures) :
  purge des éléments supprimés depuis > 30 j, des sessions expirées, des instantanés expirés.
- **Changement de type de propriété** : conversion au mieux (texte↔nombre, select↔multi,
  select↔status (options conservées, groupe `todo` par défaut), texte→select (crée les options),
  checkbox↔texte (« Oui »/vide)), sinon valeur effacée.
- **Suppression d'option** : retirée des lignes. **Suppression de propriété** : retirée des lignes
  et des configs de vues (`filter`, `sorts`, `groupBy`, `hiddenProperties`, …).
- **Duplication** : copie profonde (sous-pages, bases avec schéma/vues/lignes, documents Yjs) ;
  titre suffixé « (copie) » sur la racine ; les identifiants `pageId`/`databaseId` présents dans les
  documents Yjs copiés sont **remappés** vers les copies.
- **Favoris** : par utilisateur, ordonnés. **Visites** : `GET /api/pages/:pid` met à jour `visits`.

### 3.5 Temps réel — invalidations (`/api/events`)
- Upgrade WebSocket authentifié par le cookie de session. Messages : `shared/src/events.ts`.
- Le client s'abonne à un espace ; le serveur vérifie l'appartenance.
- Après chaque écriture validée, le serveur publie les `Change` correspondants **après commit** ;
  regroupement par micro-lot (≤ 50 ms) par espace.
- Filtrage : un `Change` sur une page privée n'est envoyé qu'à son propriétaire ; `favorites`
  uniquement à l'utilisateur concerné ; un membre retiré reçoit `revoked`.
- Ping/pong applicatif toutes les 30 s ; le client se reconnecte avec backoff (1 s → 30 s) et
  invalide tout au retour.

### 3.6 Collaboration — Hocuspocus (`/collab`)
- Un `Hocuspocus` (sans son serveur HTTP) ; l'upgrade `ws` est routé manuellement :
  `const conn = hocuspocus.handleConnection(ws, new Request(url, { headers }), context)` puis
  `ws.on('message', d => conn.handleMessage(new Uint8Array(d)))` et
  `ws.on('close', (code, reason) => conn.handleClose({ code, reason: reason.toString() }))`.
- Nom de document : `page:<pageId>` (`collabDocumentName`). Fragment XML : `COLLAB_FRAGMENT`
  (`'blocknote'`).
- `onConnect`/`onAuthenticate` : session depuis le cookie de la requête d'upgrade (ou accès public
  si la page est publiquement visible) ; `readOnly` si l'utilisateur ne peut pas éditer ;
  refus si invisible.
- `onLoadDocument` : charge `documents.state` (Y.applyUpdate). `onStoreDocument` (debounce 2 s,
  max 10 s) : sauvegarde l'état complet, recalcule `documents.text` (texte brut extrait du
  fragment : contenu des `XmlText`, blocs séparés par des sauts de ligne), met à jour l'index
  `search` et `page_links` (attributs `pageId`/`databaseId` des éléments `subpage`, `pageLink`,
  `pageMention`, `database`), ajoute l'auteur à `documents.editors`, crée un **instantané**
  `auto` si le dernier date de > 10 min et que l'état a changé (et `daily` une fois par jour).
- Restauration d'instantané (vague G6, `services/history.ts`, `content/restore.ts`) : via
  `openDirectConnection('page:<id>')`, dans une transaction, **réconciliation** du document en
  direct avec l'instantané (blocs appariés par id, ordre conservé par plus longue sous-suite,
  textes corrigés au caractère, copies bornées pour les insertions) : le groupe racine et les blocs
  identiques ne sont jamais remplacés, ce qui préserve les liaisons des éditeurs ouverts et les
  saisies concurrentes. Restauration partielle : `reinsertBlock` / `revertBlock`. Deux versions sont
  enregistrées : `before-restore` (état précédent) puis `restore` (`snapshots.restored_from`).
- Historique des propriétés des lignes : table `history_props` alimentée par un trigger SQLite sur
  `pages` (feature `history-001`), lue par `GET /api/pages/:pid/history/properties?at=`.

### 3.7 Fichiers
- `POST /api/workspaces/:wid/files` (membre éditeur) : stockage `DATA_DIR/uploads/<id>`,
  nom/mime/taille en base. Limite `MAX_UPLOAD_MB`.
- `GET /api/files/:id/:name` : **URL-capacité** (id aléatoire 128 bits), pas de session requise
  (images visibles dans les pages publiques), `Cache-Control: private, max-age=31536000, immutable`,
  `Content-Disposition` inline pour images/vidéo/audio/pdf, attachment sinon, `X-Content-Type-Options: nosniff`.
  SVG servi en `attachment` (pas d'exécution de script).

### 3.8 Sécurité
- Mots de passe : `scrypt` (N=16384, r=8, p=1, sel 16 o), format `scrypt$N$r$p$salt$hash` (base64).
- Session : jeton aléatoire 32 o (base64url) dans le cookie `oriel_session`
  (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` si requête https), expiration glissante 30 j.
- **CSRF** : toute requête mutante (`POST/PATCH/PUT/DELETE`) doit avoir `Content-Type:
  application/json` ou `multipart/form-data` (ou n'avoir **aucun corps**) **et** un en-tête `Origin` absent ou égal à l'hôte.
- Limitation de débit en mémoire : connexion/inscription 10 req/min/IP.
- En-têtes : `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: SAMEORIGIN`, CSP raisonnable pour la SPA.
- Validation des corps de requête avec `zod`.

### 3.9 SPA et routes statiques
- `@fastify/static` sert `WEB_DIST` ; toute route GET non-API et sans extension renvoie
  `index.html` (routage côté client). `GET /api/health`.

## 4. Client web

- Routes (react-router) : `/login`, `/signup`, `/invite/:token`, `/` (redirige vers le dernier
  espace), `/w/:workspaceId` (accueil), `/w/:workspaceId/p/:pageId`, `/w/:workspaceId/trash`,
  `/w/:workspaceId/settings/:tab?`, `/share/:pageId` (public, sans barre latérale).
- Données : TanStack Query, clés **exclusivement** via `web/src/lib/queryKeys.ts`. Mutations avec
  mise à jour optimiste puis invalidation.
- `web/src/lib/events.ts` : client WebSocket `/api/events` → `queryClient.invalidateQueries` selon
  la table de correspondance :

| Change | Clés invalidées |
|---|---|
| `page` | `page(id)`, `backlinks(id)` ; si `affectsTree` → `tree(ws)`, `recent(ws)`, `favorites(ws)` ; si `databaseId` → `rows(databaseId)` ; si `kind` base → `database(id)` |
| `database` | `database(id)`, `rows(id)` |
| `view` | `database(databaseId)` |
| `workspace` | `workspace(id)`, `workspaces`, `session` |
| `members` | `members(ws)`, `invites(ws)` |
| `favorites` | `favorites(ws)` |
| `trash` | `trash(ws)` |

- Éditeur : BlockNote (`@blocknote/react` + `@blocknote/mantine`), dictionnaire `fr`, schéma
  étendu avec les blocs de `EDITOR_TYPES` (shared). Collaboration : `HocuspocusProvider`
  (`/collab`, document `page:<id>`) partageant **une seule** connexion WebSocket
  (`HocuspocusProviderWebsocket`) pour toutes les pages ouvertes ; persistance locale
  `y-indexeddb` pour le hors-ligne.
- Module base de données (`web/src/database/`) : interface publique **uniquement** via
  `web/src/database/index.tsx` (`DatabaseView`, `RowProperties`). L'ouverture d'une ligne passe par
  `web/src/lib/navigation.ts` (`navigation.openPeek(id)`), le shell affiche le panneau d'aperçu.
- Thème : `web/src/styles/theme.css` (variables CSS) + `MantineProvider` synchronisé
  (`data-theme`).
- Intégration desktop : `window.orielDesktop` (exposé par le preload) →
  `{ platform: 'darwin', isDesktop: true, mode: 'remote' | 'local', openSetup(): void }` ; si
  présent, le shell ajoute la classe `is-desktop` sur `<html>` (zone de glissement
  `-webkit-app-region: drag` sur le haut de la barre latérale/barre supérieure, marge pour les feux
  macOS ; éléments interactifs en `no-drag`).

## 5. Application macOS (Electron 44)

- `desktop/src/main.ts` → `desktop/dist/main.cjs` (esbuild), `desktop/src/preload.ts` →
  `dist/preload.cjs`, écran de configuration `desktop/src/setup.html` (HTML/CSS/JS autonome).
- Configuration dans `app.getPath('userData')/config.json` :
  `{ mode: 'remote' | 'local', serverUrl?: string, windowBounds?: … }`.
- Mode local : `utilityProcess.fork(<server.cjs>, [], { env: { PORT: '0', HOST: '127.0.0.1',
  DATA_DIR: <userData>/data, WEB_DIST: <resources>/web, ORIEL_LOCAL_MODE: '1' } })` ; le
  serveur envoie `process.parentPort.postMessage({ type: 'ready', port })` une fois à l'écoute ;
  la fenêtre charge `http://127.0.0.1:<port>`. Arrêt propre à la fermeture.
- Mode distant : la fenêtre charge `serverUrl` ; si injoignable → page d'erreur locale avec
  « Réessayer » et « Changer de serveur ».
- Fenêtre : `titleBarStyle: 'hiddenInset'`, `trafficLightPosition`, `contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`. Navigation hors origine → `shell.openExternal`.
- Empaquetage `electron-builder` : `.dmg` + `.zip` (arm64 et x64), `extraResources` :
  `server/dist/server.cjs` → `server/`, `web/dist` → `web/`. Non signé par défaut (instructions
  de signature/notarisation dans `docs/DESKTOP.md`).

## 6. Déploiement

- `Dockerfile` multi-étapes (node:24-alpine) : build web + server, image finale = `server.cjs` +
  `web/dist` + utilisateur non-root, `VOLUME /data`, `HEALTHCHECK` sur `/api/health`.
- `deploy/docker-compose.yml` : services `oriel` + `caddy` (HTTPS automatique via
  `DOMAIN` et `ACME_EMAIL` dans `.env`). Volumes `oriel-data`, `caddy-data`, `caddy-config`.
- `deploy/install.sh` : script interactif pour un VPS Debian/Ubuntu neuf (Docker, domaine,
  `.env`, démarrage). `deploy/backup.sh` : sauvegarde cohérente (`VACUUM INTO` + archive des
  uploads, rotation).
