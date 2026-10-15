# Rapport QA — revue de sécurité défensive et chasse aux bugs

**Dates :** 14 octobre 2026 (première passe), 15 octobre 2026 (seconde passe : vues de bases, blocs
avancés de l'éditeur, MCP et jetons, changements du cœur) et 15 octobre 2026 au soir (troisième passe :
code de la vague G, §3.6) · **Version :** Oriel 0.1.0 (HEAD `e989bfe`
+ travail non commité)
**Cible :** instances Oriel lancées en local uniquement (127.0.0.1, dossier de données jetable).

## 1. Synthèse

| | Critique | Élevée | Moyenne | Faible | Total |
|---|---|---|---|---|---|
| Problèmes confirmés par un test | 0 | 3 | 33 | 69 | **105** |
| Corrigés (avec test de non-régression) | — | **3** | 33 | 68 | **104** |
| Acceptés comme compromis (test `todo`) | — | 0 | 0 | 1 | **1** |

Détail par passe :

| Passe | Confirmés | Corrigés | Ouverts |
|---|---|---|---|
| 14/10 (§3.1 à §3.3) | 49 (É 3, M 19, F 27) | 48, dont 8 traités après le premier rapport (§3.4) | 1 : QA-HTTP-06 (F), accepté comme compromis par l'utilisateur |
| 15/10 (§3.5) | 22 (M 4, F 18) | 22, dont QA-CORE-09 et QA-TOK-03 fermés par la vague G et QA-EDT-05 sur décision de l'utilisateur (§3.6) | 0 |
| 15/10 soir, vague G (§3.6) | 34 (M 10, F 24) | 34 : 28 d'emblée, 6 sur décision de l'utilisateur (§3.6, dernière partie) | 0 |

Les constats signalés sans test le 14/10 (QA-WEB-08 reste, 11, 12, 14) sont désormais corrigés et testés.
QA-WEB-13 (Info) reste un choix voulu.

- **Aucune faille critique ni élevée dans le nouveau code.** Aucune lecture ou écriture entre espaces sans authentification, aucune exécution de code, aucune injection SQL ou FTS5 exploitable.
- **Les 3 failles élevées de la première passe sont corrigées :**
  - empoisonnement des liens d'e-mail par l'en-tête `Host`, qui permettait de prendre le compte d'un admin par la réinitialisation du mot de passe ;
  - deux failles des relations entre bases : fuite des titres de pages invisibles, et destruction d'une propriété dans la base privée d'autrui.
- **Seconde passe, les 4 moyennes corrigées :**
  - QA-EDT-01 : un bouton posé dans un espace modifiait les lignes d'une base d'un autre espace avec les droits de celui qui clique ;
  - QA-EDT-04 : une équation à macros (`\gdef`) figeait l'onglet de chaque lecteur, visiteurs anonymes compris ;
  - QA-TOK-01 : le jeton d'API d'un admin d'instance pouvait encore empoisonner les liens d'e-mail (variante de QA-HTTP-01) ;
  - QA-VIEW-04 : un formulaire public exigeait de publier sa base, donc toutes les réponses (décision de l'utilisateur : découpler).
- **Troisième passe (vague G), 10 moyennes corrigées, aucune critique ni élevée :**
  - comptes (G9) : réinitialisation par lien appliquée avant la 2FA (QA-G9-06), SSO accepté comme second facteur pour se réauthentifier (QA-G9-02), lien de réinitialisation admin sans réauthentification (QA-G9-01), membre retiré réintégré à chaque connexion SSO (QA-G9-04) ;
  - droits par propriété (G3) : une relation cachée lue et écrite par appariement `twoWay.pairWith` (QA-G3-05), ou lue par son miroir bidirectionnel (QA-G3-03, sur décision de l'utilisateur) ;
  - teamspaces (G7) : titre d'une page d'un teamspace privé publié dans l'annuaire après une restauration (QA-G7-01) ;
  - historique (G6) : deux requêtes qui bloquaient l'instance plusieurs secondes (QA-G6-02, QA-G6-03) ;
  - app macOS (G10) : fenêtre `about:blank` sans barre d'adresse ouverte par un embed (hameçonnage, QA-G10-01).
- **Tests :**

  | Suite | 14/10 avant | 14/10 après | 15/10 après | 15/10 soir (vague G) |
  |---|---|---|---|---|
  | Serveur | 153 | 280 | 383 (380 réussis, 3 `todo`, **0 échec**) | 496 (495 réussis, 1 `todo`, **0 échec**) |
  | Web | 175 | 199 | 336 (335 réussis, 1 `todo`, **0 échec**) | 535 (535 réussis, **0 échec**) |
  | MCP | — | — | 42 (42 réussis) | 48 (48 réussis) |
  | Desktop | — | — | — | 24 (24 réussis) |

  `tsc --noEmit` est propre sur shared, server, web, mcp et desktop.

> Le seul test `todo` restant est QA-HTTP-06, accepté comme compromis par l'utilisateur (§4). Il échouerait
> s'il était activé.

## 2. Cadre et méthode

- **Périmètre :** serveurs de test en processus (`startTestServer()`, 127.0.0.1, port 0, `DATA_DIR` créé par `mkdtemp`), plus une instance en mode local (API sur le port 3120, Vite sur le port 5120) avec ses données dans le scratchpad. Cette instance a été supprimée après les tests.
- **Ce qui n'a pas été touché :** les serveurs de développement des autres sessions (ports 3000, 3102, 3103, 5102, 5103, 8000).
- **Rien n'est sorti de la machine :**
  - pas de DNS externe : serveurs de fixtures sur 127.0.0.1 et résolveur simulé pour l'aperçu de lien ;
  - pas d'API Anthropic réelle : faux client `ai/fake.ts` ;
  - pas de SMTP réel : `streamTransport` ou capture en mémoire.
- **Pas de déni de service ni de charge :** quelques requêtes par test, avec des limites basses configurées. Les cas de ReDoS ont été mesurés sur de petites entrées puis extrapolés.
- **Règle de preuve :** chaque faille supposée a d'abord fait l'objet d'un test de reproduction, exécuté sur le code d'origine pour confirmer le défaut. Le correctif n'est venu qu'ensuite. Les hypothèses non reproduites sont listées au §6, pas comme failles.
- **Organisation :** 7 revues parallèles (HTTP/auth, injection/SSRF, bases de données, collaboration, intégrité, jetons/IA, client web), chacune avec ses fichiers attribués pour éviter les collisions. Consolidation et vérification finale par le coordinateur.
- **Vérification navigateur (instance locale en mode dev, sans CSP, donc le pire cas) :**
  - page, encadré, mention de date et commentaire en gras : rendus correctement ;
  - base avec 6 niveaux de formules imbriquées (×10 par niveau) : affichée instantanément avec des valeurs exactes ;
  - persistance du contenu après navigation : vérifiée ;
  - signet forgé `javascript:document.title="PWNED"` : rendu en texte, sans `href`, et le clic n'exécute rien ;
  - aucune erreur dans la console ni dans les journaux serveur.

- **Seconde passe (15/10) :**
  - 4 revues parallèles à périmètres de fichiers disjoints : vues de bases (formulaire, géocodage, carte, fil, graphiques, tableaux de bord) ; blocs avancés de l'éditeur (synchronisé, HTML, bouton, équations) ; MCP et jetons (QA-REPORT §5 point par point) ; changements de Codex dans le cœur et constats QA-WEB restants. Les correctifs hors périmètre d'une revue ont été appliqués par le coordinateur, avec un test confirmé en échec sans le correctif.
  - Même règle de preuve, mêmes serveurs de test en processus, rien hors de la machine.
  - Instance jetable (API 3207, Vite 5207, hôte `oriel-audit.localhost`, données dans `mktemp -d`), arrêtée à la fin. Vérifié au navigateur : équation `\gdef` refusée avec son message, `\href{javascript:…}` rendu sans lien ; bloc HTML exécuté au clic dans un cadre `sandbox="allow-scripts"` + `referrerpolicy="no-referrer"`, nouveau texte d'avertissement ; formulaire public anonyme sans la question « personne », champ piège hors écran (`aria-hidden`, `tabIndex=-1`). Par `curl` sans cookie : réponse « personne » et id brut de propriété refusés (400), question obligatoire imposée, champ piège rempli → `{ok:true}` sans ligne créée, et la réponse valide lisible via `/api/public/databases/:did/rows` (QA-VIEW-04).

## 3. Problèmes corrigés

Gravité : **C** critique · **É** élevée · **M** moyenne · **F** faible. Les tests de non-régression sont dans
`server/test/qa-*.test.ts` et `web/src/**/qa-*.test.ts` (nom du test = identifiant).

### 3.1 Élevée

| ID | Problème | Correctif |
|---|---|---|
| **QA-HTTP-01 / QA-COL-01** (É, si `PUBLIC_URL` est vide) | **Liens d'e-mail empoisonnés par `Host` / `X-Forwarded-Host`.**<br>Scénario :<br>1. N'importe quel compte (même un lecteur d'un autre espace) envoie une requête authentifiée avec `Host: evil.example`. L'origine globale des liens d'e-mail devient alors `http://evil.example`.<br>2. Il demande « mot de passe oublié » pour l'admin.<br>3. Le vrai e-mail de l'instance contient `http://evil.example/reset-password/<jeton>`. Le jeton fuit au clic, et l'attaquant prend le compte.<br>Les mentions et les invitations sont touchées de la même façon. | Seules les requêtes d'un **administrateur d'instance** fixent l'origine (`routes/collab.ts` preHandler, `auth/resetRoutes.ts` `requestOrigin`). Recommandation : rendre `PUBLIC_URL` obligatoire dès que le SMTP est configuré. |
| **QA-DB-01** (É) | **La conversion relation → texte ou sélection révélait les titres de pages invisibles** (autres espaces, lignes privées d'autrui). Variante sans deviner d'identifiant : une relation bidirectionnelle vers une base privée expose les identifiants de ses lignes ; une conversion en sélection affiche alors leurs titres en options. | `relationAsText` ne résout que les lignes de la base cible, du même espace et visibles par l'acteur (`services/databases.ts`). |
| **QA-DB-02** (É) | **Supprimer une relation bidirectionnelle avec `?mirror=delete` détruisait la propriété miroir et ses valeurs dans la base privée d'autrui.** | Si la base cible n'est pas visible par l'acteur, le mode `delete` devient `keep` : le miroir devient une relation à sens unique, valeurs conservées (`removeTwoWay`). |

### 3.2 Moyenne

| ID | Problème | Correctif |
|---|---|---|
| QA-HTTP-02 | Contournement des limites de débit (connexion, inscription, mot de passe oublié) en changeant d'adresse IPv6 dans un /64. La forme `::ffff:x.x.x.x` donnait aussi un quota distinct de l'IPv4. | `clientKey()` (`auth/rateLimit.ts`) : IPv4 telle quelle, IPv4 mappée ramenée à l'IPv4, IPv6 regroupée par /64. Utilisée par `auth.ts`, `resetRoutes.ts` et `apiTokens.ts` (QA-AGT-06). |
| QA-AGT-06 | Même contournement pour le quota d'échecs des jetons d'API (`apiTokens.ts`, en cours de développement). | `clientKey(req.ip)`. |
| QA-INJ-01 | **ReDoS de l'aperçu de lien :** les regex `<meta`, `<link` et `<title` étaient quadratiques, soit environ 3 minutes de boucle d'événements bloquée par page piégée de 1 Mo. N'importe quel membre, même lecteur, pouvait rendre le serveur indisponible. | Balayage linéaire (`openingTags`, `firstTitle`), même sémantique (`routes/editor.ts`). |
| QA-INJ-02 | Requête d'aperçu bloquée indéfiniment quand une réponse gzip ou br est coupée en plein corps. La promesse en cours bloquait aussi toutes les requêtes suivantes vers la même URL. | Règlement unique (`settle`), rejet sur `close` si la réponse est incomplète, minuteurs nettoyés sur tous les chemins. |
| QA-INJ-04 | L'aperçu se connectait à n'importe quel port d'une IP publique, y compris celle du serveur. Cela contournait le proxy vers des services en `0.0.0.0` (port 3000, Redis…) et faisait de l'aperçu un oracle de scan de ports. | Politique par défaut `isBlockedEndpoint(ip, port)` : **ports 80 et 443 uniquement**, vérifiés à chaque redirection. |
| QA-DB-03 | Les relations à sens unique acceptaient n'importe quel identifiant (autres espaces, pages simples, modèles), ce qui laissait des références pendantes et rendait QA-DB-01 possible. | Les nouveaux identifiants doivent être des lignes vivantes, visibles, de la base cible et hors modèles. Les liens latents (lignes à la corbeille) sont conservés. Contrôle appliqué à la création, la mise à jour, l'import et la duplication. |
| QA-DB-07 | DoS : convertir un texte de 100 000 caractères en relation bloquait le processus pendant des heures (recherche cubique, regex quadratiques). | Segments bornés par le nombre maximal de virgules dans un titre de la base cible, regex linéaires : environ 30 ms. |
| QA-COL-11 | Les visiteurs anonymes d'une page publiée recevaient la présence des membres (nom, identifiant, avatar, curseur). | La socket transmise à Hocuspocus filtre les trames Awareness des documents ouverts en anonyme (`realtime/collab.ts`). |
| QA-COL-05 | L'extrait d'une notification (texte du commentaire ou du bloc) restait visible, et partait par e-mail dans le résumé, après que la page était devenue illisible (passée en privé, à la corbeille, ou destinataire retiré). | Extrait vidé et e-mail non envoyé quand la page n'est plus lisible (`collab/notify.ts`). |
| QA-INT-03 | Cycle dans l'arbre des pages : sur une chaîne de plus de 10 000 niveaux, le contrôle anti-cycle de `move` (plafonné) laissait passer un déplacement sous un descendant. Le sous-arbre disparaissait alors pour tous. | `isSelfOrDescendant` : CTE remontante sans plafond, qui s'arrête aussi sur un cycle existant (`access.ts`). |
| QA-INT-04 | Écritures acceptées sur des pages et lignes à la corbeille (titre, propriétés, format, restauration d'instantané). | 400 « Restaurez la page avant de la modifier. » (`services/pages.ts`, `routes/pages.ts`). |
| QA-AGT-01 | Les réglages du brief IA, lisibles par tous les membres, révélaient le titre et l'icône actuels d'une base source devenue privée. | Filtre `visibility = 'workspace'` (`ai/settings.ts`). |
| QA-WEB-01 | Coût exponentiel des formules imbriquées : 2,1 millions d'évaluations pour une cellule sur 6 niveaux ×10, soit un DoS de la vue, pages publiques comprises. | Mise en cache des résultats imbriqués (hors cycles) et budget de 10 000 évaluations (`database/logic/values.ts`) : environ 3 ms. |
| QA-WEB-02 | Les URL de signets et d'intégrations étaient passées telles quelles à `window.open` et à « Ouvrir le lien », ce qui contournait le garde-fou `javascript:` de React. Un signet forgé arrive intact aux visiteurs anonymes. L'exécution est bloquée en production par la CSP, mais pas en dev. | `lib/safeUrl.ts` (http, https, mailto, tel uniquement), appliqué aux signets, aux intégrations et au menu contextuel. Vérifié au navigateur. |
| QA-WEB-07 | Un corps de commentaire forgé (type de bloc inconnu) faisait planter tout l'éditeur de la page pour tout le monde, y compris le panneau qui permettrait de le supprimer. | `collab/commentBody.ts` (`safeCommentBody`) reconstruit le corps selon le schéma. |
| QA-WEB-09 | Perte de données : « Déplacer vers… » supprimait les blocs d'origine même si la copie n'avait pas été enregistrée par le serveur. | Les originaux ne sont supprimés qu'après accusé de réception (15 s). Sinon ils sont conservés et un message s'affiche (`editor/blockActions.ts`). |
| QA-WEB-10 | Perte de données : un document quitté depuis 1,5 s était détruit même avec des modifications non synchronisées, et la déconnexion effaçait l'IndexedDB sans prévenir. | Le document reste connecté tant que des modifications sont en attente. Une confirmation est demandée à la déconnexion (`lib/collab.ts`, `shell/WorkspaceSwitcher.tsx`). |

### 3.3 Faible

| ID | Problème | Correctif |
|---|---|---|
| QA-HTTP-04 | Cookie de session sans `Secure` malgré un `PUBLIC_URL` en https, si le proxy n'envoie pas `X-Forwarded-Proto`. | `Secure` dès que `PUBLIC_URL` commence par `https://` (`app.ts`, `http.ts`). |
| QA-HTTP-05 | Un lien de réinitialisation en attente survivait à un changement de mot de passe. | `revokeResetTokens()` dans la même transaction (`routes/auth.ts`). |
| QA-HTTP-07 | Fichiers cachés du dossier de build servis (`GET /.env`). | `dotfiles: 'ignore'`. |
| QA-INJ-03 | L'API de contenu acceptait des types Yjs non XML (`Y.Map`, `Y.Text`) qui rendraient la page impossible à afficher, et une imbrication extrême provoquait des erreurs 500. | `assertXmlTree` : XmlElement et XmlText uniquement, profondeur ≤ 256, ≤ 50 000 enfants, sinon 400 (`io/content.ts`). |
| QA-DB-04 | Modifier une ligne à la corbeille la remettait dans les listes miroir. | Une ligne à la corbeille n'est plus ajoutée aux listes miroir (couvert aussi par QA-INT-04). |
| QA-DB-05 | Une relation vers une base supprimée définitivement ne pouvait plus être modifiée, pas même renommée. | Une cible absente est tolérée si elle est inchangée. |
| QA-DB-06 | Passer une relation en bidirectionnelle gardait des identifiants invalides, ce qui cassait l'invariant miroir. | Ces identifiants sont retirés ; les liens latents sont conservés. |
| QA-DB-08 | Dupliquer une page contenant un bloc de vue liée forgé créait des vues dans la base d'un autre espace (écriture parasite). | Copie seulement si la base est du même espace et visible ; sinon nouveau `linkId`. |
| QA-DB-09 | Dates impossibles acceptées (`2024-02-30`). | `isCalendarDay`. |
| QA-DB-12 | Schéma et vues d'une base à la corbeille encore modifiables. | `requireLiveDatabase` → 400 « La base de données est dans la corbeille. » (`routes/databases.ts`). |
| QA-COL-04 | Une mention d'un identifiant arbitraire révélait le nom de n'importe quel utilisateur de l'instance dans les extraits. | `memberNameLookup` : seuls les membres de l'espace sont résolus. |
| QA-COL-06 | Supprimer une discussion laissait ses notifications et leurs extraits dans les boîtes de réception. | Archivage et invalidation pour les destinataires. |
| QA-INT-01 | Restaurer une page ressuscitait un descendant supprimé à part dans la même milliseconde. | Le CTE de restauration exige `trash_root = 0`. |
| QA-INT-02 | Deux processus démarrant sur le même `DATA_DIR` : le second plantait pendant les migrations. | Chaque étape relit son état dans son propre `BEGIN IMMEDIATE` (`db/index.ts`). |
| QA-AGT-04 | Résultats d'outils de l'agent IA non bornés (4,1 millions de caractères pour un seul appel). | Budget de 80 000 caractères pour les lignes et plafond dur de 150 000 par résultat (`ai/reader.ts`, `ai/tools.ts`). |
| QA-WEB-03 | Injection de formules dans les CSV exportés (`=HYPERLINK(…)`, DDE). | Échappement des formules (les nombres sont épargnés) ; l'import retire l'apostrophe ajoutée. |
| QA-WEB-04 | `?next=/\evil.example` accepté après connexion. React Router bloquait la navigation, donc pas de redirection effective. | `auth/next.ts` rejette les backslashes et les caractères de contrôle. |
| QA-WEB-05 | Bombe zip à l'import (entrée déclarée vide, archives imbriquées sans plafond). | Plafond par entrée, décompression en flux, budget partagé. |
| QA-WEB-06 | Regex quadratiques dans l'import Markdown et CSV (environ 11 s pour 100 000 caractères). | Regex linéaires. |
| QA-WEB-08 | Des props non textuelles dans le document Yjs (`callout.emoji = {…}`) cassaient le rendu, y compris pour les visiteurs publics. | `lib/props.ts` (`propString`, `propNumber`) pour les signets, intégrations, PDF, encadrés et mentions. |

### 3.4 Problèmes de la première passe traités depuis le premier rapport

Ils figuraient en « ouverts » le 14/10. Leur test n'a plus l'option `todo` et passe.

| ID | Problème | Correctif |
|---|---|---|
| **QA-AGT-02** (M) | N'importe quel compte pouvait créer son espace, activer le brief IA et dépenser la clé API de l'instance. | Plafond mensuel global de l'instance, réservé à l'admin d'instance (`meta`, défaut `AI_INSTANCE_DEFAULT_CAP_USD`, 0 = briefs coupés) ; un brief en cours réserve son coût maximal (`ai/runs.ts`, migration `ai-002-instance-cap`, `AiInstanceCapSection`). |
| **QA-HTTP-03** (M) | `TRUST_PROXY=true` faisait confiance à tout pair direct : un serveur exposé sans proxy laissait le client choisir son IP. | Confiance par défaut aux pairs loopback et privés, liste d'IP/CIDR configurable (`util/proxyTrust.ts`, `app.ts`). |
| QA-AGT-03 (F) | Un membre pouvait épuiser le budget du mois par des lancements manuels. | Quota quotidien de lancements manuels et réserve pour les briefs planifiés (`ai/runs.ts`). |
| QA-AGT-05 (F) | Un ancien brief continuait de lister une page devenue privée. | Références re-filtrées à chaque lecture (`ai/brief.ts`, `toBrief`). |
| QA-COL-07 (F) | Un membre programmait des rappels de date pour un autre membre. | Seul l'auteur réel d'une modification récente peut posséder un nouveau rappel (`collab/mentions.ts`, fenêtre d'enregistrement de `realtime/collab.ts`). |
| QA-DB-10 (F) | Les lecteurs voyaient l'e-mail d'anciens membres cités dans les lignes. | `rowsUsers` : e-mail vide hors membres actuels (`services/databases.ts`). |
| QA-DB-11 (F) | Les lignes-modèles d'une base publiée étaient servies au public. | Point d'extension `registerPublicExclusion` (`access.ts`) + `chainHasTemplate` (`services/databases.ts`). |
| QA-INJ-05 (F) | Les codes d'erreur de l'aperçu énuméraient les noms DNS internes. | Un nom qui résout vers une adresse interne répond comme un nom inconnu, cache compris (`routes/editor.ts`). |
| QA-WEB-08 reste (F) | `level` forgé du titre natif (`createElement(\`h${level}\`)`). | `withSafeProps` borne `level` à 1–4 (titre, titre dépliable) ; table des matières bornée par `tocHeadingLevel` (`editor/safeProps.ts`, `blocks.tsx`). Tests `qa-heading-level.test.ts`. |
| QA-WEB-11 (F) | Le bloc PDF encadrait n'importe quel `/api/files/…` : un fichier non PDF se téléchargeait chez chaque lecteur. | 403 pour un fichier non affichable quand `Sec-Fetch-Dest` vaut iframe, frame, embed ou object (`routes/files.ts`). Test dans `qa-http.test.ts`. |
| QA-WEB-12 (F/Info) | Identifiants du contenu insérés sans encodage dans les chemins `/api/...`. | `lib/apiPath.ts` (`apiPath`, `pathSegment`, `assertApiPath`) dans tout le client web ; le client des jetons (`web/src/mcp/api.ts`) complété le 15/10 ; même défaut dans le MCP : QA-MCP-01. |
| QA-WEB-14 (Info) | Une intégration générique de l'origine Oriel elle-même était permise. | `isAppOrigin` dans `embedSource`, avec un message (`qa-frames.test.ts`). |

### 3.5 Seconde passe (15/10) : nouveau code

Identifiants : QA-VIEW (vues de bases), QA-EDT (blocs avancés), QA-TOK (jetons, serveur), QA-MCP (paquet `mcp/`), QA-CORE (changements du cœur). Tests : `server/test/qa-{views,editor-blocks,mcp,core}.test.ts`, `mcp/test/qa-mcp.test.ts`, `web/src/editor/qa-advanced-blocks.test.ts`, `web/src/database/logic/qa-views.test.ts`, `web/src/lib/qa-collab-gate.test.ts`.

**Moyenne**

| ID | Problème | Correctif |
|---|---|---|
| **QA-EDT-01** | **Bouton : actions de lignes vers une base d'un autre espace.** `addRow` et `editRows` prennent le `databaseId` dans le document et s'exécutent avec les droits de celui qui clique. Un membre de l'espace A pose un bouton visant une base de l'espace B ; un collègue éditeur de B clique : jusqu'à 20 lignes de B créées ou modifiées. | `buttonDatabaseProblem` (`editor/buttonActions.ts`) refuse une base d'un autre espace, une cible qui n'est pas une base, une base à la corbeille ; appliqué par `databaseOf` (`buttonBlock.tsx`) aux deux actions. |
| **QA-EDT-04** | **Équation qui fige l'onglet de chaque lecteur.** `maxExpand` compte les expansions, pas les jetons produits : `\gdef\b#1{#1…#1}\b{\b{x…x}}` (219 caractères) prend 31 s et produit 2,8 Mo de HTML ; quelques centaines de caractères se comptent en minutes. Persistant, y compris pour les visiteurs d'une page publiée et pour l'export HTML. | `texRefusal` (`editor/mathMarkdown.ts`) refuse avant KaTeX `\def`, `\gdef`, `\edef`, `\xdef`, `\let`, `\futurelet`, `\global`, `\newcommand`, `\renewcommand`, `\providecommand` (sans confondre `\left`, `\leftarrow`) ; options regroupées dans `KATEX_OPTIONS` ; appliqué à `renderTex` et `renderExportedMath`. |
| **QA-TOK-01** | **Liens d'e-mail empoisonnés par le jeton d'un admin d'instance** (sans `PUBLIC_URL`). Une requête Bearer avec `Host: evil.example` fixait l'origine des liens ; le « mot de passe oublié » suivant envoyait un lien vers `evil.example`. | Aucune requête faite avec un jeton ne fixe l'origine : `routes/collab.ts` (preHandler) et `auth/resetRoutes.ts` (`requestOrigin`). |
| **QA-VIEW-04** | **Les réponses d'un formulaire public étaient publiques.** Le formulaire exigeait une base publiée : toutes les réponses (e-mails, téléphones) étaient lisibles par quiconque avait le lien de la base (`/api/public/databases/:did/rows`). Vérifié en direct sur l'instance jetable. | Décision de l'utilisateur (15/10) : découpler, implémenté par une session dédiée et relu ici. `GET /api/public/forms/:vid` (`routes/forms.ts`, `publicFormDefinition`) reconstruit la définition par liste blanche (textes, questions de types publics, id, nom, type et options de leurs propriétés ; jamais de ligne) ; `publicForm` exige une vue `form` avec `isPublic`, une base vivante hors modèle (`shareableChain`, `access.ts` : comme `publicChain` sans exiger de publication) ; la soumission ne demande plus la publication ; `PublicFormPage` n'utilise que cet endpoint, sans cookie ; `FormView` avertit si la base est publiée. Tests `QA-VIEW-04` (4). |

**Faible**

| ID | Problème | Correctif |
|---|---|---|
| QA-VIEW-01 | Un jeton d'écriture pouvait ouvrir un formulaire aux anonymes (`form.isPublic` par `PATCH /api/views/:vid`, création, changement de type), alors que la publication est réservée au cookie. Dupliquer une vue, une page avec un bloc lié ou une base recopiait aussi un formulaire public en public (nouveaux points d'entrée anonymes, plafonds multipliés). | `assertFormPublication` (`routes/databases.ts`) : 403 quand une vue *devient* un formulaire public avec un jeton ; `withPrivateForm` (`services/databases.ts`) sur les copies : duplication de vue, `relinkCopiedLinkedViews`, duplication de page (`services/pages.ts`). |
| QA-VIEW-02 | Le formulaire membre crée la ligne au nom du propriétaire de la base : les relations répondues par un lecteur étaient vérifiées avec la visibilité du propriétaire. Un lecteur liait une ligne d'une base privée du propriétaire, et y écrivait par le miroir d'une relation bidirectionnelle. | `checkRelationTargets` (`routes/forms.ts`) : lignes vivantes, hors modèles, de la base cible et visibles par la personne qui répond, sinon 400. |
| QA-VIEW-03 | Les aperçus du fil (public et membres) servaient le contenu d'une ligne mise à la corbeille. | `previews` (`routes/databaseExtras.ts`) applique la règle de `rowsResponse` sur `trashed_at`. |
| QA-VIEW-05 | Les vues d'un bloc de base liée sont rattachées à un `linkId` choisi par le client, pas à une page hôte. Depuis QA-VIEW-04, un formulaire public d'une vue liée dont le bloc avait disparu (page hôte supprimée, bloc retiré) ou n'avait jamais existé (vue créée par l'API) restait ouvert aux anonymes sans que la base le liste : personne ne pouvait le voir ni le fermer. Pas d'élévation de droits (il faut être éditeur). | Décision de l'utilisateur : lister et fermer. `GET /api/databases/:did/public-forms` (membres qui voient la base) liste tous les formulaires publics, vues liées comprises ; `POST /api/views/:vid/close-public-form` (droit d'édition, jeton d'API accepté : sens sûr) les réserve aux membres sans toucher aux questions (`routes/databases.ts`). Interface : badge « N formulaires publics » dans la barre d'outils de toute base (pleine page, intégrée ou liée), avec la liste et un bouton « Fermer » (`database/view/PublicFormsButton.tsx`). Test `QA-VIEW-05`. |
| QA-EDT-02 | Une page (ou la page propriétaire d'un bloc synchronisé) à la corbeille restait modifiable par `/collab`, alors que l'API REST la dit en lecture seule (QA-INT-04). | `onAuthenticate` met en lecture seule une page à la corbeille ; `refreshReadOnly` (`realtime/collab.ts`, `CollabControl`) recalcule les connexions ouvertes à la mise en corbeille et à la restauration (`services/pages.ts`), si bien qu'aucune saisie n'est perdue après restauration ; `setReadOnlyForUser` tient compte de la corbeille. |
| QA-EDT-03 | Le texte du bloc HTML promettait « ni au réseau » alors que la CSP imposée permet `img-src` et `font-src https:` : le code peut envoyer à un tiers ce qu'on y tape et l'IP du lecteur. | `HTML_RUN_NOTICE` (`editor/htmlFrameLogic.ts`) : « … sans accès à Oriel ni à vos données. Il peut charger des images depuis Internet : n'y saisissez jamais de mot de passe. » |
| QA-TOK-02 | Un jeton, même limité à un espace, modifiait le profil global (nom, avatar visibles dans tous les espaces) et les préférences de notification. | `COOKIE_ONLY` (`auth/apiTokens.ts`) pour les écritures sur `/api/me` et `/api/me/notification-settings`. |
| QA-MCP-01 | Les ids venant du modèle ou du contenu étaient insérés tels quels dans les chemins : `oriel_restore_page` avec `pageId: "../pages/<id>/trash?x="` mettait la page à la corbeille. | `isSafeApiPath` dans `request()` (`mcp/src/client.ts`, 400 `invalid_path`) et `encodeURIComponent` sur chaque id interpolé (`tools/*.ts`, `databases.ts`). |
| QA-MCP-02 | Résultats d'outils non bornés (page de 314 000 caractères renvoyée entière). | `bounded()` dans `tool()` (`tools/common.ts`) : 200 000 caractères, avec une note qui déconseille un `replace` depuis cette lecture. |
| QA-MCP-03 | `isSafeLinkHref` acceptait `/\evil.example` et `/\t/evil` (redirection ouverte), et `/api/files/../me/tokens` passait pour un média ou un PDF. | `isSafeLinkHref`, `isSafeMediaUrl`, nouvelle `isOrielFileUrl` (`content/links.ts`), utilisées par `content/markdown.ts`. |
| QA-MCP-04 | Les caractères privés U+E000, U+E001, U+E010–E014 d'un texte forgeaient couleurs ou équations à la conversion (corruption, pas injection : seules des valeurs validées étaient reprises). | `stripPlaceholders` / `stripPlaceholderText` (`content/colors.ts`) à l'entrée de `markdownToBlocks` et `blocksToMarkdown`, avec un avertissement. |
| QA-MCP-05 | En mode JSON, couleurs arbitraires (`'red" onmouseover=…'`, objets) et props de tout type (`emoji` objet, `level` 9) enregistrées telles quelles. | `normalizeProps` / `normalizeStyles` dans `sanitizeBlocks` (`content/markdown.ts`), d'après le schéma miroir. |
| QA-MCP-06 | Transport `--http` : pas de protection contre le DNS rebinding (non exploitable sans jeton), sessions illimitées. | `mcp/src/http.ts` : `Origin` non local refusé (403) sur une écoute locale (`Host` laissé libre pour le reverse proxy documenté) ; 10 sessions par jeton, 200 au total. |
| QA-CORE-03 | Une fusion (`PUT /content`, `mode: 'merge'`) qui supprime des blocs ne laissait pas d'instantané, contrairement à `replace` : un script périmé pouvait vider une page sans retour possible. | `mergeDeletesContent` (`io/content.ts`) : instantané `before-restore` quand la fusion supprime un élément visible. |
| QA-CORE-08 | Hors ligne, `PageEditor` ouvrait au bout de 4 s un éditeur modifiable sur une copie locale vide jamais synchronisée : la première frappe créait un second groupe racine, fusionné ensuite avec le contenu du serveur (corruption). Logique confirmée par test ; corruption non reproduite (navigateur requis). | `collabEditorGate` (`lib/collab.ts`, branché dans `editor/PageEditor.tsx`) : un refus du serveur l'emporte ; hors ligne, l'éditeur ne s'ouvre que sur une copie locale non vide, sinon « Contenu indisponible hors ligne ». |

### 3.6 Troisième passe (15/10 au soir) : code de la vague G

**Cadre.** Code ajouté par dix chantiers de développement parallèles (G1 à G10), relu en six revues parallèles à périmètres de fichiers disjoints : (A) droits par propriété, lignes en lot et filtres (G3, G2, G1) ; (B) sécurité des comptes (G9) ; (C) blocs, saisie et importeurs (G5, G8) ; (D) historique et lecture (G6, G4) ; (E) navigation et teamspaces (G7) ; (F) app macOS (G10). Même règle de preuve qu'au §2 : chaque test de constat a échoué sur le code d'origine avant le correctif. Serveurs de test en processus uniquement (`startTestServer()`), Mermaid et abcjs rendus sous jsdom, aucun Electron lancé, aucun serveur durable, rien hors de la machine.

Tests : `server/test/qa-g-{props,accounts,history-reading,navigation}.test.ts`, `web/src/editor/qa-g-blocks.test.ts`, `web/src/io/importers/qa-g-import.test.ts`, `web/src/io/qa-g-import-links.test.ts`, `web/src/history/qa-g-history.test.ts`, `desktop/test/qa-g-desktop.test.ts`.

**Moyenne**

| ID | Problème | Correctif |
|---|---|---|
| **QA-G9-06** | **Réinitialisation par lien d'un compte protégé (2FA) appliquée avant la seconde étape.** Avec la seule boîte mail, un attaquant changeait le mot de passe, fermait toutes les sessions et révoquait les jetons API (intégrations MCP cassées), sans jamais passer la 2FA. | `resetRoutes.ts` consomme le lien mais, pour un compte protégé, ne renvoie qu'un ticket MFA portant l'empreinte du nouveau mot de passe (`mfaChallenge(…, { resetHash })`, `loginFlow.ts`, 5 min) ; `applyPasswordReset` n'est appelé par `/api/auth/login/mfa` qu'après succès (`securityRoutes.ts`). |
| **QA-G9-02** | **La connexion SSO remplaçait le second facteur pour se réauthentifier.** `reauthMethods` proposait `sso` à un compte protégé : la seule session chez le fournisseur (souvent silencieuse) suffisait pour créer un jeton API ou changer l'e-mail sans code TOTP, alors que le mot de passe est refusé dans ce cas (contraire à la SPEC). | `reauthMethods` n'offre `sso` qu'à un compte non protégé (`securityRoutes.ts`) ; `oidc.ts` refuse le démarrage en mode `reauth` (400) et le callback (`sso_error=mismatch`), y compris pour un flux ouvert avant l'activation de la 2FA. Test de G9 `qa-account-sso.test.ts` adapté. |
| **QA-G9-01** | Une session admin volée et ancienne créait un lien de réinitialisation de 24 h pour n'importe quel compte sans 2FA, autre admin compris (prise de compte), alors que la réinitialisation de la 2FA exigeait déjà la réauthentification. | `requireRecentAuth` sur `POST /api/admin/users/:uid/password-reset` (`resetRoutes.ts`) ; rejeu unique après réauthentification dans `web/src/collab/api.ts` (`request`, `recoverApiError`). |
| **QA-G9-04** | Un membre retiré d'un espace (ou parti) y était réintégré à sa connexion SSO suivante par l'adhésion automatique du domaine vérifié (`joinDomainWorkspaces` à chaque connexion). | Migration `sec-002-domain-joins` (table `auth_domain_joins`, `db/features/accountSecurity.ts`) : une seule adhésion automatique par espace et par compte, en transaction (`oidc.ts`). |
| **QA-G3-05** | **Relation cachée lue et écrite par appariement.** Un membre crée dans B une relation vers A avec `twoWay: { pairWith: <id d'une relation cachée de A> }` (id lisible dans `propertyOrder`, QA-G3-06) : `makeTwoWay` recopiait les liens cachés dans la nouvelle relation ; sur une relation en lecture seule, ses valeurs y étaient fusionnées. | `makeTwoWay` (`services/databases.ts`) : relation cachée → 400 (même message qu'une relation inexistante), lecture seule → 403 ; les admins apparient toujours. |
| **QA-G7-01** | **Titre d'une page d'un teamspace privé publié à tout l'espace.** Un simple membre d'un teamspace privé met une page puis son parent à la corbeille, puis restaure la page : placée à la racine en `visibility='teamspace'`, elle devenait un « teamspace fermé » synthétisé, listé dans l'annuaire de tous (titre, icône, propriétaires), avec demande d'accès possible ; c'était aussi un teamspace créé par un non-admin. | `restorePage` (`services/pages.ts`) remet la page sous la racine de son teamspace, ou 409 si cette racine est à la corbeille ; défense en profondeur dans `teamspaceOf` (`services/teamspaces.ts`) : une racine restreinte dont `teamspace_id` n'est pas son propre id est ignorée. |
| **QA-G6-02** | Un seul `POST …/history/restore-blocks` (200 éléments) reconstruisait l'index des blocs de la version et de la page pour chaque élément : 3,9 s de boucle d'événements bloquée pour toute l'instance sur une page de 20 000 blocs (≈ 8 s à 50 000), répétable par tout éditeur. | `restoreChosenBlocks` / `RestoreMaps` (`content/restore.ts`) construisent les index une fois (0,39 s) ; `services/history.ts` passe par ce chemin ; quota de 30 requêtes par minute et par utilisateur (`routes/history.ts`). |
| **QA-G6-03** | `GET …/history/deleted` décodait de façon synchrone jusqu'à 60 versions complètes (≈ 90 ms par version de 2 Mo : 5 s et plus par requête). `scanned` comptait les lignes lues, pas les versions examinées. | `RECOVERY_MAX_BYTES` (16 Mo par requête, au moins une version), taille lue par `length(state)` avant de charger le contenu, `scanned` exact, même quota de 30/min (`services/history.ts`, `routes/history.ts`). |
| **QA-G10-01** | **Fenêtre sans barre d'adresse ouverte par un site intégré.** `setWindowOpenHandler` autorisait `about:blank` depuis n'importe quel cadre ; l'iframe du bloc Embed a `allow-popups allow-popups-to-escape-sandbox` : un site intégré ouvrait une fenêtre Electron et y écrivait un faux écran de connexion Oriel. | Politique pure `windowOpenAction(url, disposition, serverOrigin)` (`desktop/src/urls.ts`) : URL de l'instance → onglet ou fenêtre ; http(s)/mailto/tel → navigateur système ; tout le reste refusé. Branchée dans `guardTab` (`main.ts`), qui ne crée plus de fenêtre enfant (`did-create-window` supprimé). |

**Faible**

| ID | Problème | Correctif |
|---|---|---|
| QA-G9-03 | Réauthentification SSO sans contrôle de `auth_time` : un fournisseur qui réutilise sa session malgré `prompt=login` / `max_age=0` suffisait (poste partagé resté ouvert). | `freshAuthTime` (`oidc.ts`) : connexion chez le fournisseur de moins de 5 min (tolérance 60 s), sinon `sso_error=stale`. |
| QA-G9-05 | Un changement d'e-mail laissait valides les liens de réinitialisation envoyés à l'ancienne adresse. | `revokeResetTokens` dans `POST /api/me/email` (`securityRoutes.ts`). |
| QA-G3-01 | Une date cachée (`readRoles: []`) avec rappel par défaut, recopiée par la duplication d'une ligne ou un modèle, créait un rappel au membre : la notification donnait la date. | `syncPropertyReminders` (`collab/propertyReminders.ts`) : aucun rappel sur une propriété illisible pour la personne. |
| QA-G3-02 | Un rappel créé avant la restriction de la propriété se déclenchait quand même. | `runPropertyReminders` revérifie la définition au déclenchement (existe, type `date`, `canReadProperty`). |
| QA-G3-07 | Un lecteur qui répond à un formulaire membre écrivait le miroir en lecture seule d'une relation bidirectionnelle (la ligne est créée au nom du propriétaire ; le PATCH équivalent est refusé, QA-PROP-15). | `checkRelationTargets` (`routes/forms.ts`) : le miroir doit passer `formProperties` pour le rôle de la personne qui répond, sinon 400. |
| QA-G7-02 | La décision « seuls les admins créent un teamspace » se contournait : un éditeur dissolvait un teamspace ouvert en le déplaçant ; dupliquer une page racine recopiait le marqueur `teamspaceRoot` ; une page marquée ramenée à la racine (déplacement, restauration) redevenait un teamspace. | `services/pages.ts` : `movePage` (sortir un teamspace ouvert de la racine : propriétaire/admin, 403), `duplicatePage` (`withoutTeamspaceMarker`), `movePage`/`restorePage` vers la racine par un non-admin (`dropMarkerUnlessManager`). |
| QA-G7-03 | Un propriétaire de teamspace simple membre de l'espace le rendait « par défaut » (tout l'espace inscrit sans pouvoir le quitter) ou lui retirait ce statut. | `updateTeamspace` (`services/teamspaces.ts`) : changer `is_default` exige propriétaire/admin de l'espace. |
| QA-G7-04 | `/api/events` envoyait à tout l'espace les identifiants et l'activité des pages, bases, vues et commentaires des teamspaces fermés et privés (jamais de titre ni de contenu). | `pageAudience()` (`access.ts`) ; filtre `audience` de `EventBus.publish` (`realtime/events.ts`, événement non envoyé si le filtre échoue) ; branché dans `emitPage`/`emitTrash` (`services/pages.ts`), `publishRows`/`publishDatabase` (`services/databases.ts`), `publishTree` (`services/teamspaces.ts`), `emitDatabase`/`emitView` (`routes/databases.ts`), `emitComments` (`collab/comments.ts`). |
| QA-G6-01 | Une restauration (version entière ou blocs choisis) dépassait `MAX_CONTENT_DEPTH` : `copyNode` partait de la profondeur 1 quel que soit le point d'insertion ; un éditeur obtenait ≈ 507 niveaux (256 au maximum), en contournant `checkCollabUpdate`. Plafonné vers 2 × 256. | `depthOf`, `copyNode(node, exclude, depth)` à la profondeur réelle d'insertion ; un bloc qui perd son contenu est abandonné ; parent de 50 000 enfants refusé (`content/restore.ts`). Test `qa-collab.test.ts` (« server walkers… snapshot restore ») aligné : la chaîne de conteneurs vides trop profonde est désormais abandonnée au lieu d'être tronquée à 256. |
| QA-G6-04 | Les lecteurs voyaient les versions (date, auteur) dans `/pages/:id/activity`, alors que l'historique leur est refusé. | `routes/reading.ts` : versions listées à partir du rôle membre. |
| QA-G6-06 | `HistoryPanel` proposait la restauration sur une page verrouillée (côté client ; voir les risques). | `canRestoreVersions` (`web/src/history/access.ts`), utilisé par `HistoryPanel.tsx`. |
| QA-G5-01 | Collage Office : `isOfficeHtml` (tout collage HTML) et `cleanOfficeHtml` quadratiques : 1 Mo forgé dans le presse-papiers gelait l'onglet 2 à 10 min ; `RangeError` au-delà de ≈ 10 000 niveaux. | `officePaste.ts` : `replaceSections` linéaire, regex bornées, `StartFragment` sans regex paresseuse, profondeur 128 (aplatie au-delà, texte gardé). 1 Mo : 5 à 243 ms ; sortie identique sur du HTML Word ordinaire. |
| QA-G8-01 | Import : la taille déclarée par le répertoire ZIP était crue ; l'entrée était tronquée mais tout le flux décompressé (≈ 1,6 s par Go réel), et les budgets comptaient les tailles déclarées (une entrée « 0 octet » ne coûtait rien). | `inflateBounded` (`web/src/io/zip.ts`) pour toute entrée compressée ; `vfs.ts` et `importers/safeZip.ts` réservent la taille déclarée puis la corrigent par la taille réelle, lecture bornée par le budget restant. |
| QA-G8-02 | `looksLikeGoogleDocs` quadratique sur les 200 premiers Ko de chaque HTML importé (1 à 2,6 s par fichier). | `importers/confluence.ts` : intervalles `[^>]{0,500}`. |
| QA-G8-03 | Le plafond de 50 000 pages valait par fichier, pas par import (10 classeurs → 500 000 lignes). | `mergePlans(plans, maxPages)` (`importers/builder.ts`) lève une `ImportError` ; `combinePlans` (`detect.ts`) passe `Infinity` pour les exports Markdown/CSV, qui n'ont jamais eu de plafond. |
| QA-G8-04 | Un lien `javascript:` (ou `data:`, `file:`, `vbscript:`…) d'un import Markdown ou de fichier était stocké tel quel dans le document Yjs (neutralisé au rendu et au clic, mais livré aux exports, au MCP et à tout autre lecteur). | `resolveHref` (`web/src/io/markdown.ts`) : seules les adresses http(s), mailto et tel restent des liens ; les autres deviennent du texte. |
| QA-G10-02 | Pas de garde `will-redirect` sur les onglets : une redirection 3xx (proxy, passerelle) vers une autre origine affichait la page tierce dans l'app, sans barre d'adresse. | `will-redirect` sur le cadre principal (`main.ts`) : annulée, ouverte dans le navigateur si http(s)/mailto/tel. |
| QA-G10-04 | Liste des raccourcis globaux réservés contournable (`CommandOrControl+Q`, ⌘C/⌘V/⌘Z/⌘A, ⇧⌘3/4/5, ⌃⌘Q, ⌥+lettre) : une instance compromise confisquait ⌘V dans toutes les apps, durablement (config.json). | `isReserved` (`desktop/src/accelerator.ts`) : CommandOrControl traité comme Command ; refus de ⌘ + touche seule (sauf F1–F24), de ⌥(+⇧) + caractère ; liste élargie. ⌃⌥Espace, ⇧⌘K, ⌥F13 restent acceptés. |
| QA-G10-05 | `safeFileName` gardait les caractères bidi (U+202E) : `facture‮fdp.command` s'affichait « facturedmmoc.pdf » (défense en profondeur, Chromium nettoie probablement en amont). | Retrait de `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}` (`desktop/src/urls.ts`). |

Durcissement sans faille : QA-G10-03, `isTrustedAppFrame` exige aussi `senderFrame.origin` = instance sur les canaux du pont (un document de l'instance servi avec une CSP `sandbox` a une origine opaque).

Problèmes ouverts du §4 fermés par cette passe : **QA-CORE-09** (G7 : `updatePage` et `conversionCheck` réservent le marqueur aux admins, test actif ; voies détournées fermées par QA-G7-02) et **QA-TOK-03** (G9 : fenêtre de réauthentification de 10 min sur la création et la révocation de jetons, test reformulé et actif dans `qa-mcp.test.ts`).

**Hypothèses vérifiées et écartées (résumé)**
- **G1, filtres :** le serveur n'évalue aucun filtre (validation zod seulement) ; le MCP réutilise `web/src/database/logic` sur des lignes REST déjà expurgées : évaluation identique, pas d'oracle sur une propriété cachée. `last_visited` est propre au lecteur (`withLastVisits`).
- **G3, sorties :** rollups, formules, graphiques, tableaux de bord, CSV et zip sont calculés dans le client à partir de REST filtré ; `/collab` et l'API de contenu ne portent pas de propriétés ; la recherche FTS n'indexe pas les valeurs ; l'IA lit `visibleProperties(…, null)` ; toutes les routes du MCP sont filtrées par rôle ; l'import renvoie le même message pour une propriété cachée et un id inventé ; `GET /api/files/:id/:name` : aucune liste, l'URL d'un fichier caché n'apparaît que dans des valeurs déjà expurgées.
- **G2 :** `rowsBatch.ts` (auth, droit d'édition, base vivante, chaque id = ligne vivante de la base, 500 lignes, 200 propriétés, transaction unique, miroir vérifié, jetons en lecture → 403, autre espace → 404) ; `web/src/lib/events.ts` dédoublonne à clé exacte dans un `Set` propre à chaque message.
- **G9 :** TOTP (±1 pas, temps constant, rejeu refusé atomiquement, 5 essais par ticket + 10 par compte / 5 min + IP, secret chiffré jamais renvoyé) ; codes de secours (hachés, usage unique atomique, régénération) ; ticket MFA (haché, 5 min, usage unique, aucune session avant la seconde étape ; tous les `createSession` relus) ; passkeys (rpID et origine depuis `PUBLIC_URL`, challenge consommé, userHandle, compteur, UV) ; OIDC (state lié au navigateur, nonce, PKCE S256, iss/aud/exp/iat/azp, algorithmes asymétriques seulement, `fetchJson` sans redirection, borné, émetteur fixé par l'admin, pas de liaison par e-mail, `SIGNUP_MODE`, `safeNextPath`) ; domaines (regex, résolveur avec timeout et cache, un domaine pour un seul espace) ; transfert (revérifications, 404) ; `secretBox` (AES-256-GCM, IV 96 bits, AAD = id, HKDF, `secret.key` 0600) ; CSRF des nouvelles routes.
- **G5 :** assainisseur SVG à liste blanche reconstruit sans DOM, inséré dans un Shadow DOM fermé (charges réelles : `svg:script`, `foreignObject`, `animate`/`set`, `use` externe, `url()` encodé, `@import`, échappements CSS) ; Mermaid 11.17.2 reste `strict` malgré `%%{init}%%`, aucun `on*` ni `javascript:` dans son SVG brut, CSS préfixé par `#id` ; abcjs 6.7.0 ne produit que du texte ; liens et recadrage d'image, dessin, dictée (consentement), EmojiPicker sans réseau.
- **G8 :** XML sans DTD ni entités ; chemins d'archive (`..`, absolus, `C:`, `\\`, NUL) refusés ; zip imbriqués bornés ; aucun `fetch`, DOM ni `innerHTML` pendant l'import ; HTML importé filtré ; regex des autres importeurs linéaires.
- **G6 :** id de version d'une autre page ou d'un autre espace → 404 (lecture, restauration, blocs) ; blocs synchronisés et bases intégrées des versions résolus avec les droits du lecteur ; propriétés cachées filtrées dans `history/properties`.
- **G4 :** aperçu et activité d'une page invisible (privée d'autrui, teamspace fermé, corbeille, autre espace) : même 404 et même corps qu'une page inexistante ; rétroliens par `visiblePageClause` ; rechercher/remplacer côté client seulement, sans blocs synchronisés ; visionneuse http(s) ou relative, PDF encadré seulement si `canFramePdf`.
- **G7 :** plus aucune clause `visibility = 'workspace' OR owner_id = ?` ni `canSeePage` sans `db` ; annuaire (teamspace privé → 404 partout ; fermé : nom, description, propriétaires, nombre de membres, comme la SPEC) ; IDOR → 404 ; consultations enregistrées après `requirePage`, `?visit=0`, statistiques d'une page invisible → 404, `show_readers` réservé aux admins ; raccourcis externes http(s) sans identifiants, `noopener,noreferrer`, cible invisible omise ; profil réservé aux membres.
- **G10 :** toutes les vues en `contextIsolation`, `sandbox`, sans `nodeIntegration` ni `webviewTag` ; chaque canal IPC vérifie l'expéditeur et valide ses arguments ; aucune préférence de sécurité modifiable depuis le web ; session restaurée en chemins internes seulement (10 fenêtres × 40 onglets) ; téléchargements limités à l'instance ; pages locales en `textContent` sous CSP stricte ; `isLoopbackHost` toujours appliqué en mode local.

**Points ouverts traités sur décision de l'utilisateur (15/10 au soir).** Décision citée : « Applique tes recommandations pour les 8 points ouverts de l'audit. » Chaque test a échoué sur le code d'origine (option `todo` retirée, ou test écrit), puis passe.

| ID | Gravité | Problème | Correctif | Test |
|---|---|---|---|---|
| **QA-G3-03** | M | Une relation cachée (ou en lecture seule) d'un côté restait lisible, et affichée comme modifiable, par son miroir bidirectionnel. | `effectiveProperties(db, props)` (`services/propertyAccess.ts`) : les droits d'un miroir sont l'intersection des deux côtés (def appariée chargée une fois par base liée ; droits combinés ni enregistrés ni renvoyés ; admins inchangés). Utilisé par `visibleProperties`, `hiddenPropertyIds`, `redactSchema`, `schemaFor`, `formProperties`, `assertPropertyWrites`, `assertPropertyStructure` (qui prennent désormais `db`) : REST, public, formulaires, IA, historique des propriétés, graphe des relations et MCP en profitent. | `qa-g-props.test.ts` |
| QA-EDT-05 | F | Un bouton posé par un collègue sur une page partagée créait ou modifiait des lignes de la base **privée** de celui qui clique (ou d'une base d'un teamspace restreint depuis une page de tout l'espace). | Le client du cliqueur déclare la page hôte (`viaButtonOn`) sur `POST /api/databases/:did/rows` et `POST …/rows/batch` ; `assertButtonTarget` (`access.ts`) : page hôte invisible ou d'un autre espace → 404 ; le public de la page hôte doit être inclus dans celui de la base (base de l'espace : toujours ; base privée : seulement depuis une page privée du même propriétaire ; base de teamspace restreint : depuis une page du même teamspace ou une page privée), sinon 403. `buttonBlock.tsx` envoie le champ, et « Modifier des lignes » passe par un seul lot (`updateRowsBatch`, tout ou rien) ; `buttonDatabaseProblem` pré-vérifie. | `server/test/qa-g-button.test.ts`, `web/src/editor/qa-advanced-blocks.test.ts` |
| QA-G1-01 / QA-G3-06 | F | Les règles des vues sur une propriété cachée (filtres avec leurs valeurs, tris…) et les ids des propriétés cachées (`propertyOrder`) étaient servis aux membres, aux jetons et aux anonymes. | `redactViewConfig` / `viewsFor` / `viewFor` retirent, pour le lecteur : règles de filtre (un sous-groupe qui contient une règle cachée est retiré entier), tris, regroupement (avec `hiddenGroups`, `collapsedGroups`), `propertyOrder`, `hiddenProperties`, largeurs, calculs, propriétés de date, fin, dépendance et lieu, graphique, widgets, questions de formulaire (et `showIf` qui vise une question retirée). À l'enregistrement, `restoreHiddenViewSettings` rétablit ces réglages clé par clé pour les seules clés envoyées (positions d'origine conservées, id caché deviné ignoré). Branché dans `routes/databases.ts` : `databaseResponse` (membres, jetons, public), création, modification, déplacement, duplication et `close-public-form` des vues. | `qa-g-props.test.ts` |
| QA-G3-04 | F | Restreindre « Créée par », « Modifiée par », « Créée le » ou « Modifiée le » ne cachait rien (`createdBy`, `updatedBy`, `createdAt`, `updatedAt` sont dans `Page`). | `PAGE_METADATA_PROPERTY_TYPES` (`shared/src/constants.ts`) ; `PUT …/access` (`routes/propertyExtras.ts`) → 400 avec un message ; une propriété restreinte convertie vers l'un de ces types perd sa restriction (`updateProperty`). Panneau `PropertyAccessPanel.tsx` : interrupteurs désactivés avec « Ces droits ne s'appliquent pas à cette propriété : l'auteur et les dates de création et de modification figurent sur chaque page. », bouton « Retirer la restriction » pour les données anciennes, et note sur les relations bidirectionnelles. | `qa-g-props.test.ts` |
| QA-G7-05 | F | Tout éditeur qui voyait un teamspace pouvait mettre sa racine, donc tout le teamspace, à la corbeille. | `trashPage` (`services/pages.ts`) : racine de teamspace réservée aux propriétaires du teamspace (`canManageTeamspace`) et aux admins de l'espace, sinon 403 ; ses pages restent à la portée des éditeurs. | `qa-g-navigation.test.ts` |
| QA-G6-07 | F | L'historique des propriétés attribuait une conversion de type, une suppression de propriété ou une numérotation au dernier éditeur de la ligne. | `writeRow(…, actorId)` (`services/databases.ts`) met à jour `updated_by` et `updated_at` quand l'acteur est connu ; passé par `numberExistingRows`, `deletePropertyRaw` (miroir compris) et `writeConverted`. La purge définitive (`relationsBeforeDelete`, sans acteur) garde l'ancien comportement. | `qa-g-props.test.ts` |

Risques résiduels de ces correctifs, à connaître :
- QA-EDT-05 ne protège que le client honnête de celui qui clique (c'est lui qui déclare la page hôte) : c'est la conception retenue, l'attaquant étant l'auteur du bouton et non le cliqueur.
- Si un membre change la conjonction de premier niveau d'un filtre (et/ou), les règles cachées de premier niveau la suivent ; les règles elles-mêmes restent intactes.
- À la création d'une vue par un membre, les réglages par défaut peuvent viser une propriété cachée (regroupement, date) : l'admin la voit, le membre voit `null`.
- Le panneau des droits montre à l'admin le miroir sans restriction alors qu'il hérite de celle de l'autre côté (une note le signale).

**Risques à faire valider par l'utilisateur**
- **Comptes :** changement de mot de passe d'un compte protégé avec le seul mot de passe actuel (ajouter `requireRecentAuth` ?) ; `deploy/backup.sh` ne sauvegarde pas `secret.key` (sans elle, une restauration bloque les comptes TOTP sans codes de secours ; la mettre dans l'archive la place à côté des secrets chiffrés, et il faudrait aussi `restore.sh`) ; en `SIGNUP_MODE=open`, création de compte OIDC sans `email_verified` (pré-détournement ; l'exiger exclurait Entra ID) ; fournisseur sans `auth_time` → réauthentification SSO impossible pour un compte 100 % SSO (à documenter dans DEPLOY.md) ; TOTP limité à 10 essais par compte / 5 min (≈ 0,9 % par jour avec le mot de passe ; verrouillage progressif ?) ; domaine vérifié jamais revérifié ; membres retirés avant `sec-002` réintégrés une dernière fois ; adhésion au domaine avant la seconde étape.
- **Teamspaces :** sortir un teamspace ouvert de la racine et choisir un teamspace par défaut sont désormais réservés aux admins (QA-G7-02, QA-G7-03) ; la SPEC (« Un espace ouvert déplacé ailleurs redevient une page ordinaire ») et le menu « Déplacer vers… » du web, encore proposé aux non-admins (403 explicite), sont à aligner. Info : les auteurs récents des statistiques ne sont pas filtrés par appartenance à l'espace (comme l'historique).
- **Historique :** réservé aux membres (lecteurs exclus ; jetons en lecture acceptés) ; le verrou de page n'est appliqué que dans l'interface (ni `/collab`, ni `PUT /content`, ni la restauration) : ce n'est pas une frontière de sécurité ; pas de quota disque (2 versions complètes par restauration, `history_props` jamais purgée) ; documents déjà trop profonds conservés tels quels.
- **Éditeur et import :** images externes importées ou collées chargées chez chaque lecteur (IP révélée, voulu) ; Mermaid et abcjs rendent dans le DOM vivant avant l'assainissement (on dépend de leurs versions épinglées), coût CPU d'un diagramme lourd non mesuré en navigateur ; diagrammes « journey » sans libellés (`foreignObject` retiré, fonctionnel).
- **App macOS :** une instance derrière une passerelle SSO (Cloudflare Access, Authelia) ou la connexion OIDC s'ouvrent dans le navigateur système et la session ne se crée pas dans l'app (préexistant pour OIDC : autoriser l'origine de l'IdP dans l'onglet demande une décision) ; `tel:` transmis au système ; réponse de la recherche rapide lue en entier avant le contrôle de 1 Mo (serveur choisi par l'utilisateur) ; ⌥+lettre et ⌘+lettre refusés comme raccourci global.

## 4. Problèmes ouverts (décision à prendre)

Tous les problèmes ouverts ont été tranchés par l'utilisateur le 15/10 au soir : les correctifs sont au §3.6 (« Points ouverts traités sur décision de l'utilisateur »). Reste un compromis accepté :

| ID | Gravité | Problème | Statut |
|---|---|---|---|
| QA-HTTP-06 | F | Énumération des comptes à l'inscription (409), seulement avec un lien d'invitation ou en mode ouvert. | **Accepté comme compromis** par l'utilisateur (ergonomie) ; test `todo` conservé dans `qa-http.test.ts`. |

**Info :**
- **QA-WEB-13 :** l'IndexedDB n'est pas effacée sur un 401 (choix voulu pour le hors-ligne). Voisin, relevé le 15/10 : sur un refus d'accès (`permission-denied`), la copie locale `oriel:page:<id>` reste et peut encore s'afficher hors ligne ; les clés ne dépendent pas de l'utilisateur. Recommandation : vider la copie sur `onAuthenticationFailed` / `permission-denied` quand `unsynced === 0`.
- QA-WEB-11 : les navigateurs qui n'envoient pas `Sec-Fetch-Dest` (anciens Safari) téléchargent toujours le fichier.
- `pagePath` et `sharePath` (`web/src/lib/util.ts`) n'encodent pas les identifiants : chemins de navigation, pas `/api`. Appliquer `pathSegment`.
- Formulaire public (QA-VIEW-04) : une base privée reçoit aussi des réponses anonymes si son propriétaire ouvre le formulaire (son choix) ; `GET /api/public/forms/:vid` n'a pas de limite de débit, comme les autres lectures publiques ; l'avertissement de `FormView` ne détecte qu'une base publiée elle-même, pas une publication héritée d'une page parente (le texte d'aide le mentionne) ; le lien `/share/:databaseId/form/:viewId` contient l'id de la base, sans effet (404 partout si elle n'est pas publiée).
- La table `databases_geocode_cache` grossit sans limite (au plus 20 nouvelles requêtes par minute et par utilisateur) : purger les entrées de plus de 30 jours dans un job.
- L'extrait de configuration Claude Code de l'onglet « API et MCP » met le jeton dans `--env`, donc dans l'historique du shell.
- Les réponses anonymes sont enregistrées avec `createdBy` = propriétaire de la base (`formActor`) : pas de fuite, mais l'auteur affiché est trompeur.

**Autres observations Info (14/10) :**
- ~~`/collab` accepte des structures Yjs arbitraires d'un éditeur.~~ Traité : `realtime/updateGuard.ts` (`checkCollabUpdate`) valide chaque mise à jour, documents `synced:` compris.
- Pas de quota disque : envois de fichiers, instantanés `before-restore` à chaque PUT `replace` (et désormais à chaque fusion destructive).
- Duplication d'arbres sans limite de taille.
- Invitations par e-mail sans plafond journalier (relais de spam possible si l'inscription est ouverte).
- scrypt N = 2^14, sous la recommandation OWASP (2^17).
- Jetons d'invitation non hachés en base.
- URL-capacités des fichiers valides après suppression de la page (choix documenté).

## 5. Jetons d'API et MCP : exigences et vérification

**Relecture du 15/10 (jetons branchés, MCP à 23 outils et plus) : verdict pour chaque exigence ci-dessous.**

| Exigence | Verdict | Détail |
|---|---|---|
| 1. Pipeline | Conforme après QA-TOK-01 | `authenticate()` avant le cookie ; jeton invalide, révoqué ou expiré → 401 même avec un cookie valide ; aucun `Set-Cookie` ; `?token=` / `?access_token=` ignorés ; Bearer + cookie garde les contrôles CSRF ; `Authorization` masqué (`redact`, vérifié par lecture). |
| 2. Restriction d'espace | Conforme | 404 testés : favoris, récents, corbeille, recherche, notifications, réglages IA, briefs, modèles, bloc synchronisé, `move`/`duplicate` vers l'autre espace. Requêtes `members` en SQL direct relues : routes réservées au cookie ou paramètres déjà contrôlés. |
| 3. Réservées au cookie | Conforme après QA-TOK-02 et QA-VIEW-01 | Variantes `%61pi`, `%70ublish`, `//`, slash final refusées ; `/API/…` n'est pas une route d'API. Ajoutés : profil, préférences de notification, publication d'un formulaire. |
| 4. Cycle de vie | Conforme, QA-TOK-03 ouvert | 50 jetons, jeton brut une fois, empreinte jamais exposée, validation du corps ; ressaisie du mot de passe à décider. |
| 5. WebSockets | Conforme | `/api/events` : Bearer et `?token=` → 401 ; `/collab` ignore Bearer, `?token=` et un `or_…` dans le message Auth. |
| 6. Journaux | Conforme | Voir point 1. |
| 7. Mode local | Conforme | Documenté (docs/MCP.md) et signalé dans l'interface (« aucune isolation »). |
| 8. MCP en écriture | Conforme après QA-MCP-01 à 05 | Schémas dangereux refusés partout (liens, médias, intégration, signet, PDF, bouton), en Markdown comme en JSON ; ids de pages, bases, mentions et blocs synchronisés vérifiés contre l'espace ; HTML ≤ 200 Ko, équations ≤ 4 000 caractères ; `add_view`/`update_view` ne publient jamais un formulaire ; portée `read` : aucune mutation (8 outils testés). |
| Transport `--http` | Conforme après QA-MCP-06 | 127.0.0.1 par défaut, jeton obligatoire, comparaison en temps constant, session liée à son jeton, pas de CORS, corps ≤ 4 Mo. |
| Interface `web/src/mcp` | Conforme | Jeton affiché une fois dans l'état React, ni `localStorage` ni URL. |

*Exigences formulées le 14/10, avant le branchement :*

Le module `server/src/auth/apiTokens.ts` (alors pas encore branché dans `app.ts`) est sain :
- 256 bits d'entropie, seul le SHA-256 est stocké, recherche par index unique ;
- expiration et révocation fonctionnent ;
- portée `read` → 403 sur toute mutation ;
- routes réservées au cookie, y compris en percent-encodé ;
- restriction d'espace via AsyncLocalStorage.

Ces points sont couverts par `server/test/qa-tokens.test.ts`. À respecter au branchement :

1. **Pipeline :**
   - appeler `authenticate()` dans `onRequest`, avant le cookie ;
   - avec `Bearer or_…`, ignorer totalement le cookie : pas de repli, pas de `Set-Cookie` ;
   - jamais de jeton dans l'URL ;
   - ne pas lever les contrôles CSRF (Origin, Content-Type) sur la seule présence d'un en-tête `Authorization`.
2. **Restriction d'espace dans le contrôle central :**
   - `roleOf` renvoie `null` hors de l'espace du jeton ;
   - l'appliquer aussi à `requireWorkspace`, `pageAccess`, à la liste des espaces de `/api/auth/me` et aux notifications ;
   - auditer les requêtes `members` faites en SQL direct : `routes/workspaces.ts:306`, `routes/collab.ts:87/96/364`, `routes/editor.ts:485`, `routes/auth.ts:133`, `isMember` du bus d'événements ;
   - tester les identifiants passés dans le corps (cible de `move`/`duplicate`, `relation.databaseId`, blocs `linkedDatabase`, import).

   *Le commentaire de `apiTokens.ts` affirme que `access.ts` consulte déjà `workspaceAllowed` : c'est faux aujourd'hui.*
3. **Réservées au cookie, en plus de celles déjà prévues :**
   - `POST /api/invites/:token/accept` ;
   - membres et invitations (un jeton d'admin pourrait sinon créer une invitation admin qui survit à la révocation) ;
   - `POST /api/pages/:pid/publish` ;
   - `PUT /api/workspaces/:wid/ai/settings`.
4. **Cycle de vie :**
   - création par session cookie uniquement, idéalement avec ressaisie du mot de passe ;
   - validation : nom de 1 à 100 caractères sans caractère de contrôle, portée dans l'énumération, `workspaceId` d'un espace dont l'utilisateur est membre, `expiresInDays` entre 1 et 3650 ;
   - 50 jetons actifs au maximum ;
   - le jeton brut n'est renvoyé qu'une fois, `token_hash` jamais ;
   - révocation de tous les jetons à la réinitialisation du mot de passe ;
   - révocation des jetons restreints à un espace quand le membre en est retiré.
5. **WebSockets :** `/collab` et `/api/events` restent en cookie seul.
6. **Journaux :** ne jamais journaliser `Authorization` (`redact`).
7. **Mode local :** les jetons n'y isolent rien (tout processus local obtient une session). À documenter, ou masquer l'interface des jetons dans ce mode.
8. **MCP en écriture :**
   - liste blanche des schémas d'URL (`http`, `https`, `mailto`, `/api/files/`) : le parseur Markdown de BlockNote garde `![x](javascript:…)` et les URL des blocs embed, bookmark et pdf ;
   - valider `pageId`, `databaseId` et `userId` contre l'espace du jeton.

## 6. Hypothèses vérifiées et écartées (résumé)

- **CSRF, CORS, WebSocket cross-site :**
  - origines refusées : autre port, `host.evil`, `null`, multipart et `text/plain` cross-site, corps sans Content-Type ;
  - aucun en-tête `Access-Control-*` ;
  - upgrade `/api/events` et `/collab` refusé pour une origine étrangère.
- **Sessions :**
  - jeton haché, expiration glissante, révocation à la déconnexion et au changement de mot de passe ;
  - course au premier admin : un seul admin ;
  - pas de doublon Unicode d'e-mail.
- **Mode local :**
  - DNS rebinding refusé (HTTP et WebSocket) ;
  - connexion automatique basée sur l'adresse de la socket, pas sur `X-Forwarded-For` ;
  - le compte local ne peut pas se connecter par mot de passe.
- **Desktop (revue statique) :**
  - `contextIsolation`, `sandbox`, sans `nodeIntegration` ;
  - IPC qui vérifie l'émetteur ;
  - `openExternal` limité à http, https, mailto et tel ;
  - permissions accordées à l'origine de l'application seulement.
- **Fichiers :**
  - pas de traversée de chemin ;
  - inline seulement pour image, vidéo, audio et PDF (hors SVG) ;
  - `nosniff` et CSP `sandbox` ;
  - pas de fichier partiel conservé au-delà de la taille maximale.
- **SSRF de l'aperçu :**
  - toutes les plages privées et spéciales bloquées (IPv4 mappée, NAT64, 6to4, Teredo) ;
  - notations d'IP alternatives normalisées ;
  - DNS rebinding : adresse épinglée, en TLS aussi ;
  - redirections revérifiées, 3 au maximum, sans `file:`, `data:` ni `gopher:` ;
  - slowloris et bombe gzip bornés.
- **Injection :**
  - aucune interpolation SQL issue de l'utilisateur ;
  - 35 charges FTS5 testées (filtres de colonne, NEAR, `^`, `*`, NUL…) : 200, sans fuite ;
  - index de recherche filtré au moment de la requête (pages privées, à la corbeille, supprimées).
- **Accès :**
  - toutes les routes `:pid`, `:did`, `:wid`, `:vid` passent par le contrôle central ;
  - IDOR testés sur les vues, `?linkId`, les modèles, l'import, les briefs, les notifications, les discussions : 404 ;
  - pages privées d'autrui invisibles partout (corbeille, favoris, récents, fil d'Ariane, recherche, agent IA).
- **Intégrité :**
  - invariants de l'arbre vérifiés après une longue séquence mixte d'opérations ;
  - suppression définitive sans orphelin ;
  - purge à 30 jours correcte (millisecondes) ;
  - une invitation ne modifie jamais le rôle d'un membre existant.
- **Temps réel :**
  - un membre rétrogradé ou retiré, ou une page passée en privé, coupe l'accès sur une connexion ouverte ;
  - les `Change` ne contiennent ni titre ni contenu ;
  - les messages stateless et le rejeu d'Auth sont sans effet.
- **E-mails :**
  - pas d'injection CR/LF dans les en-têtes ;
  - HTML des modèles entièrement échappé ;
  - aucune route ne renvoie la configuration SMTP.
- **IA :**
  - 5 outils en lecture seule ;
  - clé jamais renvoyée (seulement les 4 derniers caractères, pour l'admin d'instance) ;
  - un seul brief en cours par espace ;
  - périmètre limité aux pages partagées, hors corbeille, du seul espace.
- **Client web :**
  - aucun `dangerouslySetInnerHTML`, `eval` ni `new Function` ;
  - React 19 et BlockNote neutralisent `javascript:` ;
  - formules sans `eval` (`prop("constructor")` est sans effet) ;
  - `noopener` sur tous les `target=_blank` ;
  - noms de fichiers exportés assainis.

- **Seconde passe (15/10) — vues de bases :**
  - formulaire public : personne, relation, fichiers, lieu, formule, `unique_id`, clé `title` forgée et id brut de propriété → 400 ; réponses trop longues refusées ; `__proto__`/`constructor` retirés par l'analyseur JSON ; `showIf` cyclique ignoré, question masquée jamais enregistrée ; base à la corbeille, privée, sous une ligne-modèle, vue d'un autre type → 404 ; cookie ignoré, réponse `{ ok: true }` seule ; aucun e-mail aux adresses saisies, notification au seul propriétaire (extrait ≤ 300 caractères) ; débit par IP, plafonds horaire et journalier, taille, champ piège (déjà testés) ;
  - géocodage : URL admin http(s) sans identifiants ni paramètres, désactivé par défaut ; garde SSRF `isBlockedEndpoint` de l'aperçu, DNS épinglé, pas de redirection suivie ; 5 s, 256 Ko, User-Agent `Oriel/…`, aucun en-tête du client transmis ; 1 requête/s au total, 20/min par utilisateur, cache ; `q` ≤ 200 caractères ; coordonnées finies et bornées, adresse ≤ 300 caractères ; `requireAuth` + `requireWorkspace` ;
  - carte : `MAP_TILE_URL` jamais injectée dans la CSP (`img-src … https:` préexistant), validée (https ou `/…`, sans `//`, `;`, espaces, guillemets, `<>`, identifiants) ; attribution échappée ; popups et infobulles remplies par `textContent` ; lat/lng forgées jamais placées ;
  - aperçus du fil : autre base, modèles, id de la base → rien ; base non publiée → 404 ; pas de nombre de commentaires en public ; 100 ids, 4 000 caractères, 400 caractères par ligne d'extrait ;
  - graphiques et tableaux de bord : agrégation côté client sur les seules lignes autorisées (aucun endpoint d'agrégat) ; ≤ 400 tranches de dates ; 24 widgets, limites bornées, filtres à un niveau, configs validées par zod ; pas de pollution de prototype dans `viewConfig.ts` ;
  - regroupement par relation : titres via `ctx.relationTitle` seulement (id invisible → « Page sans titre ») ; regroupement par texte linéaire (20 000 lignes ≈ 10 ms).
- **Seconde passe — blocs avancés :**
  - bloc synchronisé : propriétaire et espace côté serveur, id UUID v4 strict ; `/collab` refusé à l'anonyme, au non-membre, sans accès à la propriétaire ; lecteur réellement en lecture seule (mémoire et base) ; révocation et rétrogradation en cours de session ; `updateGuard` et filtre de présence dans les deux sens ; référence d'un autre espace jamais résolue (création, collage, duplication, export, brief IA) ; liste des pages sans page privée, à la corbeille ou étrangère ; route publique : hôte et propriétaire publiées, même espace ;
  - bloc HTML : CSP exacte, `nosniff`, `no-store`, aucun paramètre réfléchi, autres méthodes ≠ 200 ; iframe `sandbox="allow-scripts"` seul + `no-referrer` ; `event.source` vérifié, `ready`/`resize` 0–4000 seulement, HTML envoyé une fois ; `targetOrigin '*'` acceptable (destinataire `contentWindow`, origine opaque, message = source déjà visible) ; 200 Ko vérifiés à l'exécution ; exécution au clic, désactivée pour les anonymes ; `frame-src` sans joker ;
  - bouton : droits de celui qui clique, API REST seulement ; `safeLinkUrl` résiste à `java\tscript:`, majuscules, `\u0000`, `//evil`, `data:`, `file:` ; `pageId` `[A-Za-z0-9_-]{1,64}` ; blocs insérés sans id, 50 au plus, profondeur 8, types connus ; JSON > 100 000 caractères ignoré ;
  - KaTeX : `trust: false` effectif (`\href`, `\url`, `\includegraphics`, `\html*` rendus en texte) ; sortie sur liste blanche (ni `href`, `src`, `on*`, `id`, `data-*`, `url(`) ; `maxSize` ; découpage `$…$` linéaire.
- **Seconde passe — cœur :**
  - fusion `merge` : lecteur 403, anonyme 401, page privée d'autrui 404, corbeille 400 ; copie d'un autre document ou d'un historique neuf refusée ; collision d'identifiants Yjs refusée par `checkCollabUpdate` ; types non XML refusés ; groupe racine non supprimable ; 10 Mo ; jeton d'un autre espace → 404 ;
  - verrouillage : protection d'interface, pas une permission (un éditeur peut déverrouiller) ;
  - marqueurs `teamspaceRoot` / `sharedShortcut` : page privée d'autrui ou à la corbeille jamais renvoyée (arbre, recherche) ; marqueur sur une page invisible → 404 ; simples drapeaux, sans cycle.

## 7. Changements de comportement à connaître

- **Aperçu de lien :** seulement les ports 80 et 443. Une URL sur un autre port s'affiche sans aperçu, avec le seul nom d'hôte.
- **Sans `PUBLIC_URL` :** les liens d'e-mail restent sur `http://localhost:<port>` tant qu'aucun admin d'instance n'a fait de requête depuis le démarrage. En mode local, l'utilisateur local est admin.
- **`PUBLIC_URL` en https :** le cookie de session est toujours `Secure`.
- **Corbeille :** les pages, lignes et bases qui s'y trouvent sont en lecture seule (400) ; on peut toujours les publier, les dépublier ou les mettre en favori.
- **Duplication d'une ligne :** elle perd les liens à sens unique vers des lignes à la corbeille, comme c'était déjà le cas pour les relations bidirectionnelles.
- **Relations :** une relation à sens unique n'accepte plus que des lignes vivantes, visibles, de la base cible.
- **« Déplacer vers… » :** attend l'accusé de réception du serveur avant de supprimer les blocs d'origine.
- **Déconnexion :** une confirmation est demandée s'il reste des modifications non synchronisées.
- **CSV exportés :** les cellules commençant par `=`, `+`, `-` ou `@` (hors nombres) sont préfixées d'une apostrophe.

- **Seconde passe (15/10) :**
  - **Jetons d'API :** ouvrir un formulaire aux anonymes → 403 (le fermer reste possible) ; `PATCH /api/me` et `/api/me/notification-settings` → 403 ; les requêtes faites avec un jeton, même d'un admin, ne fixent plus l'origine des liens d'e-mail.
  - **Formulaires :** une vue dupliquée, un bloc lié copié ou une base dupliquée donnent un formulaire réservé aux membres, même si l'original était public. Formulaire membre : une relation vers une ligne invisible, à la corbeille, modèle ou d'une autre base → 400.
  - **Formulaire public (QA-VIEW-04) :** il fonctionne sans publier la base (nouvel endpoint `GET /api/public/forms/:vid`) ; la page publique ne lit plus la base ; le lien partagé n'a plus `?lien=` (les anciens liens restent valides).
  - **Formulaires publics (QA-VIEW-05) :** une base qui a des formulaires ouverts aux personnes sans compte affiche dans sa barre d'outils un badge « N formulaires publics » (membres seulement), avec la liste, vues de blocs liés comprises, et un bouton « Fermer » pour les éditeurs.
  - **Fil d'actualité :** les aperçus n'incluent plus les lignes à la corbeille.
  - **Corbeille :** une page (ou un bloc synchronisé dont la propriétaire est) à la corbeille est aussi en lecture seule par `/collab` ; les connexions ouvertes repassent en écriture à la restauration.
  - **Bouton :** « Ajouter une ligne » et « Modifier des lignes » s'arrêtent sur une base d'un autre espace, une cible qui n'est pas une base ou une base à la corbeille (« Le bouton s'est arrêté : … »).
  - **Équations :** une formule contenant une définition de macro (`\def`, `\newcommand`…) n'est pas rendue (message explicite) ; l'export HTML garde le TeX.
  - **Bloc HTML :** nouveau texte avant exécution (chargement d'images depuis Internet possible).
  - **Table des matières :** un `level` forgé non numérique est listé au niveau 1.
  - **API de contenu :** une fusion qui supprime du contenu ajoute une version `before-restore` à l'historique.
  - **Hors ligne :** une page jamais ouverte sur l'appareil affiche « Contenu indisponible hors ligne » au lieu d'un éditeur vide modifiable.
  - **MCP :** id contenant `..`, `\` ou `#` → « Identifiant invalide » ; liens `/\…` et `/api/files/…` mal formés refusés avec avertissement ; caractères U+E000–U+E014 retirés avec avertissement ; résultats ≤ 200 000 caractères ; props et couleurs des blocs JSON normalisées ; `--http` : `Origin` étranger → 403, sessions plafonnées. Le bundle `mcp/dist/oriel-mcp.mjs` a été recompilé (`npm run build -w mcp`).

- **Troisième passe (vague G, 15/10 au soir) :**
  - **Comptes :** pour un compte protégé (2FA), la réinitialisation par lien ne change le mot de passe qu'après la seconde étape ; la réauthentification d'un compte protégé n'accepte plus le SSO ; une réauthentification SSO exige une connexion chez le fournisseur de moins de 5 min (`sso_error=stale` sinon) ; le lien de réinitialisation créé par un admin demande sa réauthentification ; changer d'e-mail annule les liens de réinitialisation en cours ; l'adhésion automatique par domaine n'a lieu qu'une fois par espace et par compte.
  - **Jetons d'API (QA-TOK-03) :** créer ou révoquer un jeton demande une réauthentification de moins de 10 min.
  - **Teamspaces :** sortir un teamspace ouvert de la racine, le rendre « par défaut » ou lui retirer ce statut : propriétaires et admins de l'espace seulement (403) ; une page dupliquée ou ramenée à la racine par un non-admin perd le marqueur de teamspace ; une page restaurée d'un teamspace restreint retourne sous sa racine (409 si la racine est à la corbeille) ; les invalidations temps réel des pages, bases, vues et commentaires d'un teamspace restreint ne sont envoyées qu'à ses membres.
  - **Propriétés :** apparier une relation cachée → 400, en lecture seule → 403 ; aucun rappel sur une date illisible, et un rappel existant ne se déclenche plus après restriction ; un formulaire membre refuse (400) une relation dont le miroir n'est pas modifiable par la personne qui répond.
  - **Historique :** `restore-blocks` et la liste des blocs supprimés sont limités à 30 requêtes par minute et par utilisateur ; la liste examine au plus 16 Mo de versions par requête ; une restauration abandonne les éléments qui dépasseraient la profondeur maximale à leur point d'insertion ; les lecteurs ne voient plus les versions dans l'activité ; le panneau ne propose plus de restaurer une page verrouillée.
  - **Éditeur et import :** collage HTML de plus de 128 niveaux aplati (texte conservé) ; import limité à 50 000 pages par import (fichiers Word, Excel, Confluence, Evernote, Trello, Asana ; pas les exports Markdown/CSV) ; un lien importé autre que http(s), mailto ou tel devient du texte.
  - **Points tranchés par l'utilisateur :** un bouton ne peut plus viser une base privée (ou d'un teamspace restreint) depuis une page plus largement partagée (403), et « Modifier des lignes » est désormais tout ou rien ; un miroir de relation bidirectionnelle hérite de la restriction de l'autre côté ; les vues servies à un membre ou à un anonyme ne contiennent plus les règles, l'ordre ni les réglages des propriétés qui lui sont cachées, et un membre qui enregistre une vue ne peut plus les effacer ; les droits par propriété sont refusés (400) sur « Créée par », « Modifiée par », « Créée le » et « Modifiée le » ; seuls les propriétaires du teamspace et les admins de l'espace mettent sa racine à la corbeille ; une conversion de type, une suppression de propriété ou une numérotation mettent à jour l'auteur et la date de modification des lignes concernées.
  - **App macOS :** aucune fenêtre `about:` ni d'autre schéma ne s'ouvre depuis le contenu ; une redirection vers une autre origine s'ouvre dans le navigateur ; raccourci global refusé pour ⌘ + touche seule (sauf F1–F24), ⌥(+⇧) + caractère et une liste élargie de raccourcis système ; noms de fichiers téléchargés sans caractères de mise en forme.

## 8. Fichiers modifiés

**Serveur :**
- `app.ts`, `http.ts`, `access.ts`, `db/index.ts`
- `auth/{rateLimit,passwordReset,resetRoutes,apiTokens}.ts`
- `routes/{auth,collab,databases,editor,pages}.ts`
- `services/{databases,pages}.ts`
- `collab/{comments,mailer,mentions,notify}.ts`
- `realtime/collab.ts`, `io/content.ts`
- `ai/{reader,settings,tools}.ts`

**Web :**
- `database/logic/{values,csv}.ts`
- `io/{csv,zip,vfs,markdown}.ts`
- `editor/{mediaBlocks,contextMenu,blocks,blockActions}.tsx|ts`
- `collab/{mentions,threadStore}.ts(x)`
- `lib/collab.ts`, `shell/WorkspaceSwitcher.tsx`, `auth/AuthPages.tsx`
- Nouveaux : `lib/{safeUrl,props,spreadsheet}.ts`, `auth/next.ts`, `collab/commentBody.ts`

**Tests :**
- `server/test/qa-{http,injection,databases,collab,integrity,agents,tokens}.test.ts`
- `web/src/**/qa-*.test.ts` (8 fichiers)

**Seconde passe (15/10) :**
- Serveur : `routes/{forms,databaseExtras,databases,collab}.ts`, `services/{databases,pages}.ts`, `auth/{apiTokens,resetRoutes}.ts`, `realtime/collab.ts`, `context.ts` (`refreshReadOnly`), `io/content.ts`
- Web : `editor/{buttonActions,htmlFrameLogic,mathMarkdown,safeProps}.ts`, `editor/{buttonBlock,htmlBlock,math,blocks,PageEditor}.tsx`, `lib/collab.ts`, `mcp/api.ts`
- MCP : `src/{client,http,databases}.ts`, `src/tools/{common,pages,collab,databases}.ts`, `src/content/{links,markdown,colors}.ts`, `docs/MCP.md` (§ Sécurité)
- Tests créés : `server/test/qa-{views,editor-blocks,mcp,core}.test.ts`, `mcp/test/qa-mcp.test.ts`, `web/src/editor/qa-advanced-blocks.test.ts`, `web/src/database/logic/qa-views.test.ts`, `web/src/lib/qa-collab-gate.test.ts` ; complétés : `web/src/editor/qa-heading-level.test.ts`, `server/test/tokens.test.ts` (le cas `PATCH /me` d'un jeton en lecture remplacé par `POST /pages/:id/duplicate`, à cause de QA-TOK-02)
- QA-VIEW-04 (session dédiée) : `server/src/access.ts` (`shareableChain`), `server/src/routes/forms.ts`, `shared/src/{api,types}.ts`, `web/src/database/api.ts`, `web/src/database/view/PublicFormPage.tsx`, `web/src/database/layouts/FormView.tsx`, `server/test/{qa-views,databases-views}.test.ts` ; QA-VIEW-05 : `server/src/routes/databases.ts` (routes `public-forms`, `close-public-form`), `shared/src/api.ts` (`PublicFormSummary`, `PublicFormsResponse`), `web/src/database/{api.ts,view/Toolbar.tsx,database.css}`, nouveau `web/src/database/view/PublicFormsButton.tsx`, test dans `qa-views.test.ts`
- `.claude/launch.json` : configurations `oriel-audit-api` / `oriel-audit-web` (instance jetable 3207/5207)

**Troisième passe (vague G, 15/10 au soir) :**
- Serveur : `auth/{resetRoutes,securityRoutes,oidc,loginFlow}.ts`, `db/features/accountSecurity.ts` (migration `sec-002-domain-joins`), `collab/{propertyReminders,comments}.ts`, `services/{databases,pages,teamspaces,history}.ts`, `routes/{forms,databases,history,reading}.ts`, `content/restore.ts`, `access.ts` (`pageAudience`), `realtime/events.ts` (filtre `audience`)
- Web : `collab/api.ts` (rejeu après réauthentification), `editor/officePaste.ts`, `io/{zip,vfs,markdown}.ts`, `io/importers/{safeZip,builder,detect,confluence}.ts`, `shell/HistoryPanel.tsx`, nouveau `history/access.ts`
- Desktop : `src/{urls,main,accelerator}.ts`, `docs/DESKTOP.md` (§4.1, §4.2, §8)
- Tests créés : `server/test/qa-g-{props,accounts,history-reading,navigation}.test.ts`, `web/src/editor/qa-g-blocks.test.ts`, `web/src/io/importers/qa-g-import.test.ts`, `web/src/io/qa-g-import-links.test.ts`, `web/src/history/qa-g-history.test.ts`, `desktop/test/qa-g-desktop.test.ts` ; adaptés : `server/test/qa-account-sso.test.ts` (QA-G9-02), `server/test/qa-mcp.test.ts` (QA-TOK-03 actif), `server/test/qa-collab.test.ts` (profondeur après restauration, QA-G6-01)
- Décisions de l'utilisateur (points ouverts) : serveur `services/{propertyAccess,databases,pages,history}.ts`, `routes/{databases,propertyExtras,forms,public,rowsBatch,pages}.ts`, `ai/reader.ts`, `access.ts` (`assertButtonTarget`), `schemas.ts` (`viaButtonOn`) ; shared `constants.ts` (`PAGE_METADATA_PROPERTY_TYPES`), `api.ts` (`viaButtonOn`) ; web `database/row/PropertyAccessPanel.tsx`, `editor/{buttonActions.ts,buttonBlock.tsx}` ; tests `server/test/qa-g-{props,navigation}.test.ts` (`todo` retirés, QA-G6-07 ajouté), nouveau `server/test/qa-g-button.test.ts`, `web/src/editor/qa-advanced-blocks.test.ts` (`todo` QA-EDT-05 retiré)

Rien n'a été commité. Les correctifs se mêlent au travail en cours d'autres sessions dans le même arbre (notamment `server/src/services/databases.ts` et `server/src/auth/apiTokens.ts`). Au moment de commiter, séparer les deux, par exemple avec `git add -p`.
