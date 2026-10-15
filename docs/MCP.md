# Oriel et Claude — serveur MCP et jetons d'API

Le **serveur MCP d’Oriel** permet à Claude (Claude Desktop, Claude Code et, plus tard,
claude.ai) d'utiliser votre espace Oriel **avec vos droits** : chercher et lire des pages,
rédiger ou compléter du contenu, créer des pages et des bases de données, interroger et remplir
des bases (filtres, relations, rollups), commenter, consulter la boîte de réception et le
« Brief du jour ».

Il s'appuie sur des **jetons d'API personnels** (`or_…`) créés dans Oriel. Le serveur MCP est un
petit programme Node.js qui tourne sur votre ordinateur (ou sur un serveur) et parle à Oriel
par son API HTTP.

```
Claude Desktop / Claude Code ──MCP (stdio ou HTTP)──▶ oriel-mcp ──HTTPS + Bearer or_…──▶ Oriel
```

## 1. Créer un jeton d'API

Dans Oriel : **Réglages › API et MCP › Nouveau jeton**.

| Réglage | Conseil |
|---|---|
| **Droits** | *Lecture seule* si Claude doit seulement consulter ; *Lecture et écriture* pour qu'il rédige et modifie. |
| **Espace** | Limitez le jeton à un seul espace quand c'est possible : les autres deviennent invisibles pour lui. |
| **Expiration** | 30 jours, 90 jours, 1 an ou jamais. |

Le jeton n'est **affiché qu'une fois** : la fenêtre qui s'ouvre propose aussi la configuration prête
à coller pour Claude Desktop et Claude Code. Seule son empreinte SHA-256 est conservée sur le
serveur ; la liste « Vos jetons » montre son début (`or_x8Kf2a…`), sa dernière utilisation et permet
de le **révoquer** à tout moment.

## 2. Construire le serveur MCP

Prérequis : Node.js ≥ 22.13 et une copie du dépôt Oriel.

```bash
cd /chemin/vers/Oriel
npm ci
npm run build -w mcp        # → mcp/dist/oriel-mcp.mjs
```

`mcp/dist/oriel-mcp.mjs` regroupe le serveur MCP, mais s'appuie sur des dépendances installées
dans `node_modules` (BlockNote, jsdom, React, Yjs, qui convertissent le contenu des pages) : lancez-le
depuis votre copie du dépôt, sans déplacer le fichier.

Configuration par variables d'environnement :

| Variable | Rôle |
|---|---|
| `ORIEL_URL` | adresse de votre Oriel, ex. `https://notes.mondomaine.fr` |
| `ORIEL_TOKEN` | jeton d'API personnel `or_…` |
| `ORIEL_WORKSPACE` | espace par défaut (id ou nom), facultatif ; sinon le premier espace accessible |

Test rapide : `ORIEL_URL=… ORIEL_TOKEN=… node mcp/dist/oriel-mcp.mjs --help`.

## 3. Claude Desktop

Ouvrez **Réglages › Développeur › Modifier la configuration** (fichier
`~/Library/Application Support/Claude/claude_desktop_config.json` sur macOS,
`%APPDATA%\Claude\claude_desktop_config.json` sur Windows) et ajoutez :

```json
{
  "mcpServers": {
    "oriel": {
      "command": "node",
      "args": ["/chemin/vers/Oriel/mcp/dist/oriel-mcp.mjs"],
      "env": {
        "ORIEL_URL": "https://notes.mondomaine.fr",
        "ORIEL_TOKEN": "or_VOTRE_JETON"
      }
    }
  }
}
```

Redémarrez Claude Desktop : les outils `oriel_…` apparaissent dans le menu des outils. Si `node`
n'est pas trouvé, indiquez son chemin complet (`which node`).

## 4. Claude Code

```bash
claude mcp add oriel \
  --env ORIEL_URL=https://notes.mondomaine.fr \
  --env ORIEL_TOKEN=or_VOTRE_JETON \
  -- node /chemin/vers/Oriel/mcp/dist/oriel-mcp.mjs
```

Ajoutez `--scope user` pour l'avoir dans tous vos projets. Vérifiez avec `claude mcp list`, puis
dans Claude Code : `/mcp`.

## 5. Mode HTTP (serveur MCP distant)

Pour exposer le serveur MCP sur un serveur (le même VPS qu’Oriel par exemple) :

```bash
ORIEL_URL=https://notes.mondomaine.fr node mcp/dist/oriel-mcp.mjs --http --port 3333
# options : --host 127.0.0.1 (défaut) | --host 0.0.0.0
```

Le serveur écoute en **Streamable HTTP** sur `/mcp` (et `GET /health`). Chaque requête doit porter
`Authorization: Bearer or_…` :

- **avec `ORIEL_TOKEN`** défini, seul ce jeton est accepté (serveur personnel) ;
- **sans `ORIEL_TOKEN`**, chaque client présente **son propre** jeton Oriel, vérifié auprès de
  Oriel à l'ouverture de la session et utilisé pour ses appels (serveur partagé par l'équipe :
  chacun garde ses droits). Une session reste liée au jeton qui l'a ouverte.

Placez-le derrière le reverse proxy HTTPS (ex. Caddy : `mcp.mondomaine.fr { reverse_proxy 127.0.0.1:3333 }`),
jamais en HTTP clair sur Internet. Côté Claude Code :

```bash
claude mcp add --transport http oriel https://mcp.mondomaine.fr/mcp \
  --header "Authorization: Bearer or_VOTRE_JETON"
```

*claude.ai* : les connecteurs personnalisés de claude.ai demandent en général une authentification
OAuth, que ce serveur ne fournit pas encore ; le mode HTTP en est la base.

## 6. Outils disponibles

| Outil | Rôle |
|---|---|
| `oriel_whoami` | compte, droits du jeton, espaces, espace par défaut |
| `oriel_list_workspaces`, `oriel_list_members` | espaces ; membres (pour les personnes et mentions) |
| `oriel_search` | recherche plein texte (titres et contenus) |
| `oriel_list_pages` | arborescence (à plat avec niveaux, paginée), éventuellement sous une page |
| `oriel_read_page` | titre, icône, chemin, propriétés d'une ligne, contenu Markdown (ou blocs JSON), sous-pages, rétroliens |
| `oriel_create_page` | page à la racine, sous-page (carte ajoutée dans le parent) ou ligne de base (propriétés, modèle) |
| `oriel_update_page` | titre, icône, couverture, options d'affichage, propriétés |
| `oriel_write_page_content` | écrire le contenu : `append` (défaut) ou `replace` (**destructif**) |
| `oriel_move_page`, `oriel_duplicate_page` | déplacer, dupliquer (copie profonde) |
| `oriel_trash_page`, `oriel_restore_page` | corbeille (**destructif**, restaurable 30 jours), restauration |
| `oriel_get_database` | schéma (propriétés, options, relations, rollups, formules), vues avec leurs réglages, modèles |
| `oriel_query_database` | lignes avec valeurs lisibles, filtres par nom de propriété, tris, vue, pagination |
| `oriel_create_database` | base avec propriétés : sélections, statut, dates, personnes, relations (bidirectionnelles, `self`), rollups, formules, ID unique ; intégrée ou pleine page |
| `oriel_update_database_schema` | propriétés : ajouter, renommer, changer de type, supprimer (**destructif**), options… ; vues : `add_view`, `update_view`, `delete_view` (**destructif**) |
| `oriel_create_rows`, `oriel_update_rows` | jusqu'à 100 lignes par appel, valeurs lisibles |
| `oriel_list_comments`, `oriel_add_comment` | discussions d'une page ; commentaire de page ou réponse, avec mentions |
| `oriel_list_notifications` | boîte de réception |
| `oriel_get_latest_brief` | dernier « Brief du jour » (IA) en Markdown |
| `oriel_list_tags` | tags de l'espace avec le nombre de pages visibles (lecture) |
| `oriel_list_collections` | collections intelligentes : règles, pages ajoutées / exclues (lecture) |
| `oriel_query_pages` | pages d'un tag ou d'une collection, par titre, paginé (lecture) |

### Contenu en Markdown

Le contenu des pages est échangé en Markdown (GFM). Les éléments propres à Oriel utilisent des
liens `oriel://`, que Claude recopie tels quels :

| Élément Oriel | Markdown |
|---|---|
| carte de sous-page / lien vers une page | `[Titre](oriel://page/<id>)` seul sur sa ligne |
| mention de page | `[Titre](oriel://page/<id>)` dans une phrase |
| mention de personne | `[@Nom](oriel://user/<id>)` |
| date (avec rappel) | `[📅 15 oct. 2026](oriel://date/2026-10-15)` (`?reminder=1`) |
| encadré | `> 💡 texte` |
| bloc dépliable, titre dépliable | `<details><summary>Titre</summary> … </details>` (`<summary><h2>…</h2></summary>`) |
| base intégrée, vue liée | `[🗃 Titre](oriel://database/<id>)`, `…?view=<id>` |
| colonnes | `<!-- oriel:columns -->`, `<!-- oriel:column -->` (`width=1.5`), `<!-- /oriel:columns -->` |
| table des matières | `[Table des matières](oriel://toc)` |
| intégration, signet, PDF | `oriel://embed?url=…`, `oriel://bookmark?url=…`, `oriel://pdf?url=/api/files/…` |
| titres 1 à 4 | `#` à `####` (titre dépliable 4 : `<summary><h4>…</h4></summary>`) |
| équation (bloc), équation en ligne | `$$…$$` seul dans son paragraphe (sur une ou plusieurs lignes), `$…$` dans le texte |
| note de bas de page | `[^1]` dans le texte et `[^1]: texte` (une ligne, 1 000 caractères au plus) ; numérotation par ordre d'apparition |
| fil d'Ariane | `[Fil d’Ariane](oriel://breadcrumb)` seul sur sa ligne |
| bloc synchronisé | `[🔁 Bloc synchronisé](oriel://synced/<id>)` seul sur sa ligne |
| onglets | `<!-- oriel:tabs -->`, `<!-- oriel:tab title="Titre" -->` (`&quot;` pour un guillemet), `<!-- /oriel:tabs -->` |
| bloc HTML | bloc de code ` ```oriel-html ` |
| bouton | bloc de code ` ```oriel-button ` contenant `{ "label", "icon", "actions" }` (JSON des actions de l'éditeur) |
| couleur de texte ou de fond, dans le texte | `<span data-text-color="red" data-background-color="yellow">texte **gras**</span>` |
| couleur d'un bloc | `<!-- oriel:color text=red background=yellow -->` à la fin du texte du bloc |

**Couleurs.** Les noms de couleur sont ceux de l'éditeur : `gray`, `brown`, `orange`, `yellow`,
`green`, `blue`, `purple`, `pink`, `red` (un autre nom est ignoré, avec un avertissement). Les deux
attributs du `<span>` sont facultatifs, et le Markdown reste actif à l'intérieur (gras, liens…). La
couleur d'un bloc (paragraphe, titre, élément de liste, citation, encadré, bloc dépliable) s'écrit
par un commentaire en fin de texte, par exemple `## Budget <!-- oriel:color background=yellow -->` ;
pour un encadré, seule la couleur de fond existe. Lire puis réécrire une page redonne exactement les
mêmes couleurs. Dans le code (bloc ou `` `code` ``), ces balises restent du texte.

En écriture, le serveur MCP vérifie que les pages et personnes référencées existent dans l'espace
(sinon le lien devient du texte, avec un avertissement) et refuse les adresses dangereuses
(`javascript:`, `data:`…) : liens `http(s)`, `mailto:`, `tel:` et chemins d’Oriel uniquement ;
médias en `http(s)` ou fichiers envoyés sur Oriel. Les mêmes règles valent en JSON (`blocks`), et
pour les nouveaux blocs :
- **bloc synchronisé** : identifiant strict, bloc du même espace que la page et page propriétaire
  visible par le titulaire du jeton (vérifié auprès du serveur), sinon il est retiré. Le MCP ne lit
  ni n'écrit le **contenu** d'un bloc synchronisé (document Yjs `synced:<id>`) : seule la référence
  apparaît, y compris sur la page propriétaire ; le contenu se consulte et se modifie dans l'éditeur web ;
- **bouton** : actions relues comme par l'éditeur (types connus, bornes, adresses `http(s)`,
  `mailto:`, `tel:`) ; les bases et pages visées doivent être dans l'espace ; les blocs enregistrés
  d'une action « insérer » passent par les mêmes contrôles ; libellé limité à 120 caractères ;
- **bloc HTML** : 200 Ko au plus (au-delà, il reste un bloc de code `html`, inerte) ;
- **équations** : 4 000 caractères au plus (au-delà, tronquées avec un avertissement).

Le Markdown ne conserve pas tout : le **soulignement**, les couleurs des tableaux, des médias et des
blocs de code, la mise en forme des mentions et des équations dans le titre d'un bloc dépliable, et
les **ancrages de commentaires** disparaissent lors d'un remplacement complet (l'ancienne version
reste dans l'historique de la page). Les colonnes et les onglets ne sont reconnus qu'au premier
niveau du document ou dans une colonne ou un onglet (pas dans un bloc dépliable ni une liste : dans
une liste, chaque onglet devient un titre en gras suivi de son contenu). Pour une modification
fidèle, `oriel_read_page` avec `format: "blocks"` renvoie le JSON BlockNote, que
`oriel_write_page_content` accepte en entrée (`blocks`).

### Valeurs des propriétés

Les propriétés se désignent par leur **nom** et s'écrivent sous forme lisible : nom d'option (les
options de sélection manquantes sont créées), liste de noms pour une multi-sélection, date
`AAAA-MM-JJ` (`AAAA-MM-JJTHH:MM`, `JJ/MM/AAAA`, `aujourd'hui`, `demain`, `{ "start", "end" }` ou
`2026-11-02 → 2026-11-06`), personne par nom, e-mail ou `moi`, relation par titre de ligne ou id,
`true`/`false`, nombre (`6,5` accepté), `null` pour effacer. Les propriétés calculées (formule,
rollup, dates et auteurs de création/modification, ID unique) sont en lecture seule ; elles sont
calculées par le serveur MCP avec la même logique que l'interface web.

Une propriété **lieu** (`place`) s'écrit sous forme d'adresse (`"12 rue de Siam, Brest"`) ou
d'objet `{ "adresse", "lat", "lng" }` (WGS 84, les deux coordonnées ensemble) et se lit sous la forme
`{ "adresse", "lat", "lng" }`. Le serveur MCP ne géocode pas : une adresse sans coordonnées
n'apparaît sur une carte qu'une fois localisée depuis l'interface.

### Vues

`oriel_update_database_schema` crée (`add_view`), modifie (`update_view`) et supprime
(`delete_view`) des vues. Les propriétés et options sont désignées par leur nom ; chaque réglage est
vérifié avec les règles de l'interface avant d'être envoyé, et `oriel_get_database` décrit les vues
avec les mêmes champs.

| Type | Réglages |
|---|---|
| `table`, `board`, `list`, `gallery`, `calendar`, `timeline` | `sorts` (réglages par défaut de l'interface) |
| `feed` (fil d'actualité) | `previewLines` : lignes du contenu par publication (0 à 20) |
| `chart_bar`, `chart_hbar`, `chart_line`, `chart_donut`, `chart_number` | `chart` : `x` (propriété regroupée, pas pour `chart_number`), `xBucket` (`day`, `week`, `month`, `year` pour une date), `aggregate` (`count`, `sum`, `average`, `min`, `max`), `value` (propriété nombre, formule ou rollup numérique), `series` (barres et lignes), `sort`, `showLegend`, `showLabels`, `hideEmpty` |
| `dashboard` | `widgets` : `[{ type (chart_* ou list), title, chart, limit, sorts, w (1–4), h (1–3) }]` |
| `map` | `place` : propriété de type lieu |
| `form` | `form` : `title`, `description`, `questions [{ property, label, description, required, showIf: { question, value } }]`, `acceptResponses`, `submitLabel`, `confirmation` |

Une condition `showIf` porte sur une question **précédente** de type sélection, statut,
multi-sélection ou case à cocher (`value` : nom d'option, ou `true` / `false`). Le **partage public**
d'un formulaire ne se règle pas par le MCP : c'est une publication, réservée à l'interface. Le
serveur MCP conserve la valeur en place.

## 7. Sécurité

- **Droits** : un jeton agit avec les droits de son propriétaire, jamais plus. Un jeton *lecture
  seule* reçoit `403` sur toute modification (POST, PUT, PATCH, DELETE).
- **Restriction à un espace** : les autres espaces de l'utilisateur sont invisibles (`404`), y
  compris par les identifiants passés dans le corps des requêtes ; un tel jeton ne peut pas créer
  d'espace.
- **Réservé à la session du navigateur** (refusé aux jetons) : gestion des jetons, mot de passe,
  profil et préférences de notification, connexion/déconnexion, administration de l'instance,
  suppression d'un espace, membres et invitations, publication sur le web (pages, et ouverture d'un
  formulaire aux personnes sans compte), réglages IA. WebSockets (`/collab`, `/api/events`) : session
  du navigateur uniquement. Les requêtes faites avec un jeton ne fixent jamais l'adresse des liens
  envoyés par e-mail, même celles d'un administrateur.
- **Révocation** : manuelle (Réglages › API et MCP) et **automatique** quand le mot de passe change
  (changement ou réinitialisation) et quand le propriétaire quitte l'espace auquel le jeton est
  limité. En cas de doute, révoquez et recréez.
- **Transport** : le jeton circule uniquement dans l'en-tête `Authorization: Bearer` (jamais dans
  l'URL), n'est jamais journalisé (ni par Oriel ni par le serveur MCP) et n'est stocké que sous
  forme d'empreinte SHA-256. Utilisez HTTPS.
- **Limites** : 600 requêtes par minute et par jeton ; 50 jetons actifs par utilisateur.
- **Serveur MCP** :
  - les identifiants reçus de Claude sont encodés dans les chemins de l'API, et tout chemin contenant
    `.`/`..`, une barre oblique inverse ou un caractère de contrôle est refusé : un outil n'atteint que
    la route qu'il annonce ;
  - le contenu écrit n'accepte que les liens `http(s)`, `mailto:`, `tel:` et les chemins d’Oriel
    (pas `/\…`), les médias en `http(s)` ou `/api/files/<id>/<nom>`, les couleurs connues de
    l'éditeur, et des propriétés de blocs du bon type ; les caractères Unicode privés U+E000…U+E014
    (marqueurs internes des couleurs et des équations) sont retirés du texte ;
  - chaque résultat d'outil est limité à 200 000 caractères, avec une note quand il est tronqué
    (ne réécrivez pas une page en mode `replace` à partir d'une lecture tronquée) ;
  - en HTTP (`--http`), sur une adresse locale (par défaut 127.0.0.1), une requête portant un en-tête
    `Origin` étranger (page web, DNS rebinding) est refusée ; les clients MCP n'en envoient pas, et
    l'en-tête `Host` reste libre pour un reverse proxy placé devant ; 10 sessions au plus par jeton
    (la plus ancienne est fermée) et 200 au total ; corps de 4 Mo au plus ; aucun en-tête CORS.
- **CSRF** : les requêtes authentifiées par jeton ne reposent pas sur un cookie ; les protections
  CSRF (Origin, Content-Type) restent appliquées dès qu'un cookie de session accompagne la requête.
- **Mode local de l'app macOS** : tout programme local peut déjà ouvrir une session sur le serveur
  embarqué ; les jetons n'y apportent pas d'isolation (et son port change à chaque lancement).
- **Confidentialité** : ce que Claude lit dans Oriel est envoyé à Anthropic pour être traité,
  comme tout contenu de conversation.

### API HTTP directe

Le jeton fonctionne aussi pour vos scripts, sur toute l'API `/api` (contrat dans `shared/src/`) :

```bash
curl -H "Authorization: Bearer or_VOTRE_JETON" https://notes.mondomaine.fr/api/workspaces
curl -H "Authorization: Bearer or_VOTRE_JETON" https://notes.mondomaine.fr/api/me/current-token
```

## 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| « Jeton d'API refusé » | jeton mal copié, expiré ou révoqué (changement de mot de passe ?) : recréez-en un |
| « lecture seule » | le jeton est en lecture seule : créez un jeton « Lecture et écriture » |
| « Introuvable, ou hors de l'espace autorisé » | page d'un autre espace, page privée d'un autre membre, ou jeton limité à un espace |
| « Impossible de joindre Oriel » | `ORIEL_URL` (avec `https://`, sans `/api`) ou réseau |
| Claude Desktop ne voit pas les outils | chemin du fichier `.mjs`, `npm run build -w mcp` oublié, chemin de `node` ; journaux : `~/Library/Logs/Claude/mcp-server-oriel.log` |

## 9. Développement

```bash
npm run build -w mcp      # mcp/dist/oriel-mcp.mjs
npm test -w mcp           # schéma miroir, conversions, outils de bout en bout (serveur réel)
npm run typecheck -w mcp
npm run dev -w mcp        # tsx src/index.ts (variables d'environnement requises)
```

- `mcp/src/content/schema.ts` reproduit le schéma de l'éditeur web (`web/src/editor/schema.ts`) :
  le test `mcp/test/schema-mirror.test.ts` échoue si un bloc, une mention ou une propriété de bloc
  y est ajouté sans être reporté.
- Les filtres, formules et rollups réutilisent `web/src/database/logic/` (embarqué à la construction).
- Jetons côté serveur : `server/src/auth/apiTokens.ts`, `server/src/routes/tokens.ts`,
  migrations `server/src/db/features/mcp.ts` ; interface : `web/src/mcp/`.
