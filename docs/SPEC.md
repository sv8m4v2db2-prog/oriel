# Oriel — Spécification fonctionnelle

> Document de référence de la salle « propre ». Il décrit **ce que fait** le logiciel, en termes
> de comportements observables et de principes. Il ne contient ni ne référence aucun code tiers.
> L'architecture technique et le contrat d'API sont dans [`ARCHITECTURE.md`](ARCHITECTURE.md).

Oriel est un espace de travail collaboratif : des **pages** composées de **blocs**, organisées
en arbre, et des **bases de données** dont chaque ligne est elle-même une page. Il s'installe sur
un serveur (VPS) et s'utilise depuis un navigateur ou depuis l'application macOS.

Langue de l'interface : **français**.

---

## 1. Principes directeurs

1. **Tout est page ou bloc.** Une page a un titre, une icône (emoji), une couverture optionnelle
   et un contenu fait de blocs. Une page peut contenir des sous-pages, sans limite de profondeur.
2. **Une ligne de base de données est une page.** Elle a des valeurs de propriétés *et* un contenu
   libre ; on peut l'ouvrir comme n'importe quelle page.
3. **Collaboration temps réel.** Plusieurs personnes éditent la même page simultanément ; les
   modifications fusionnent sans conflit et les curseurs des autres sont visibles.
4. **Le serveur pousse des invalidations, le client relit.** Quand quelque chose change (arbre,
   propriétés, vues), le serveur notifie les clients concernés qui relisent la donnée via l'API ;
   les contrôles d'accès s'appliquent donc à chaque lecture.
5. **Suppression douce.** Supprimer envoie à la corbeille ; on peut restaurer ou supprimer
   définitivement.
6. **Ordre stable.** Les éléments frères (pages, lignes, vues, propriétés, options) ont un ordre
   explicite que l'utilisateur modifie par glisser-déposer.

---

## 2. Comptes, espaces de travail, membres

### 2.1 Inscription / connexion
- Inscription par e-mail + nom + mot de passe (≥ 8 caractères). Connexion par e-mail + mot de passe.
  Session persistante (cookie) de 30 jours, déconnexion possible.
- **Mode d'inscription** (configuration serveur) :
  - `first-user` (défaut) : seul le tout premier compte peut s'inscrire librement ; il devient
    **administrateur de l'instance** et un espace de travail lui est créé. Ensuite, l'inscription
    n'est possible **que via un lien d'invitation**.
  - `invite` : uniquement par invitation (sauf premier compte).
  - `open` : inscription libre.
- Profil : nom, avatar (image envoyée), changement de mot de passe.

### 2.2 Espaces de travail
- Un utilisateur peut appartenir à plusieurs espaces ; un sélecteur en haut de la barre latérale
  permet d'en changer et d'en créer un nouveau.
- Un espace a un nom et une icône (emoji).
- **Rôles** :
  | Rôle | Lire | Éditer contenu | Créer pages/bases | Gérer membres & invitations | Réglages espace | Supprimer l'espace |
  |---|---|---|---|---|---|---|
  | `owner` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
  | `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
  | `member` | ✓ | ✓ | ✓ | — | — | — |
  | `viewer` | ✓ | — | — | — | — | — |
- **Invitations** : un admin génère un lien d'invitation (rôle choisi, expiration 7 jours par
  défaut, révocable). Ouvrir le lien : si non connecté, propose de créer un compte (même si
  l'inscription est fermée) ou de se connecter, puis rejoint l'espace.
- Gestion des membres : liste, changement de rôle, retrait. Il reste toujours au moins un `owner`.

---

## 3. Barre latérale et navigation

- Sections, de haut en bas :
  1. Sélecteur d'espace (nom + icône + menu : réglages, membres, créer un espace, se déconnecter).
  2. Actions : **Rechercher** (⌘K / ⌘P), **Accueil** (pages récentes), **Réglages**.
  3. **Favoris** (par utilisateur, ordonnables) — masquée si vide.
  4. **Espace de travail** : pages partagées avec tous les membres.
  5. **Privé** : pages visibles uniquement par leur propriétaire.
  6. En bas : **Corbeille**, **Nouvelle page**.
- Chaque entrée de l'arbre : flèche dépliable (si enfants), icône, titre (ou « Sans titre »), et au
  survol un bouton « … » (renommer, dupliquer, ajouter aux favoris, déplacer, copier le lien,
  supprimer) et un « + » (créer une sous-page).
- Glisser-déposer d'une page : **avant / après** une autre (même parent) ou **dans** une autre (devient
  enfant). Déplacer entre « Espace de travail » et « Privé » change la visibilité de toute la
  sous-arborescence.
- Les bases de données apparaissent dans l'arbre ; leurs lignes **n'y apparaissent pas**.
- La barre latérale est redimensionnable (200–480 px) et repliable (⌘\\).
- L'URL reflète la page ouverte ; précédent/suivant du navigateur fonctionnent.
- **Fil d'Ariane** en haut de la page (ancêtres cliquables), plus boutons : Partager, Favori,
  « … » (pleine largeur, exporter, historique, dupliquer, déplacer, supprimer).

---

## 4. Pages

### 4.1 En-tête
- **Icône** : emoji choisi dans un sélecteur (recherche, catégories, « aléatoire », « retirer »).
- **Couverture** : image envoyée, ou dégradé/couleur prédéfinie ; repositionnable verticalement ;
  « changer » / « retirer ».
- **Titre** : grand champ texte ; Entrée déplace le curseur au début du contenu.
- Au survol de l'en-tête : « Ajouter une icône », « Ajouter une couverture ».
- Option de page **pleine largeur**.

### 4.2 Éditeur de blocs
Comportements attendus :
- Chaque paragraphe est un bloc. Survol → poignée « ⋮⋮ » pour glisser le bloc et menu du bloc
  (supprimer, dupliquer, transformer en…, couleur), bouton « + » pour insérer un bloc.
- **Menu « / »** : tape `/` pour insérer un type de bloc, filtrage par saisie (libellés français).
- **Raccourcis Markdown** : `#`, `##`, `###` titres ; `-`/`*` puce ; `1.` liste numérotée ;
  `[]` case à cocher ; `>` citation ; ```` ``` ```` code ; `---` séparateur ; `**gras**`,
  `*italique*`, `` `code` ``, `~~barré~~`.
- **Barre de mise en forme** à la sélection : gras, italique, souligné, barré, code, lien, couleur
  de texte / de fond, transformer le bloc.
- Imbrication (Tab / Maj+Tab), annuler/rétablir, copier/coller (y compris Markdown/HTML).
- **Types de blocs** : texte ; titres 1/2/3 ; liste à puces ; liste numérotée ; case à cocher ;
  liste dépliable (toggle) ; titres dépliables ; citation ; **encadré** (callout : emoji + fond
  coloré) ; séparateur ; bloc de code (choix du langage, coloration) ; tableau simple ; image ;
  vidéo ; audio ; fichier ; **sous-page** ; **lien vers une page existante** ; **base de données
  intégrée** (en ligne) ; **table des matières** ; emoji.
- **Mention de page** en ligne : `@` ou `[[` ouvre une recherche de pages ; insère un lien en ligne
  vers la page (titre et icône à jour).
- **Sous-page** : `/page` crée une page enfant et insère un bloc-lien ; cliquer l'ouvre.
- Envoi d'images/fichiers par glisser-déposer, collage, ou sélection ; stockés sur le serveur.
- **Collaboration** : curseurs et sélections des autres participants avec nom et couleur ;
  avatars des personnes présentes en haut de la page.
- Les lecteurs (`viewer`, page publique) voient l'éditeur en lecture seule.
- Sauvegarde automatique continue, indicateur discret « Enregistré » / « Hors ligne ».

### 4.3 Historique des versions
- Le serveur conserve des **instantanés** du contenu (au plus un toutes les 10 minutes d'édition,
  conservés 30 jours, plus un instantané quotidien conservé 1 an).
- Le panneau « Historique » liste les instantanés (date, auteur) ; aperçu en lecture seule ;
  « Restaurer » remplace le contenu courant (l'état remplacé devient lui-même un instantané).
- Comparaison, restauration de blocs choisis, récupération et droits : section « Historique des
  versions : comparaison, restauration, récupération » (vague G6) en fin de document.

### 4.4 Partage public
- Panneau « Partager » : copier le lien interne ; activer **Publier sur le web** ; copier le lien
  public.
- Une page publiée, **et ses sous-pages**, sont visibles sans compte à l'adresse publique, en
  lecture seule (les bases de données intégrées aussi, en lecture seule).

### 4.5 Export / import
- Exporter une page en **Markdown** ou **HTML** (téléchargement).
- Importer un fichier **Markdown** (crée une nouvelle page, titre = premier titre ou nom du fichier).

### 4.6 Corbeille
- Supprimer une page la met à la corbeille **avec ses descendants** ; elle disparaît de l'arbre, de
  la recherche et des bases.
- Corbeille : liste filtrable, « Restaurer » (revient à son emplacement ; si le parent n'existe plus,
  à la racine de sa section), « Supprimer définitivement » (confirmation).
- Purge automatique après 30 jours.
- Une page à la corbeille ouverte par URL affiche un bandeau « Cette page est dans la corbeille »
  avec Restaurer / Supprimer définitivement.

---

## 5. Bases de données

### 5.1 Création
- Pleine page : « Nouvelle base de données » dans le menu « + » de la barre latérale, ou `/base`
  en pleine page vide.
- En ligne : `/base de données` dans une page insère une base intégrée (affichée dans le flux).
- Une base neuve a : une propriété **Nom** (titre), une propriété **Étiquettes** (multi-sélection),
  une vue **Tableau**, et 3 lignes vides.

### 5.2 Propriétés
Chaque base a une liste ordonnée de propriétés ; exactement une est le **titre** (non supprimable).

| Type | Valeur | Édition |
|---|---|---|
| `title` | texte | champ texte |
| `text` | texte | champ multi-ligne |
| `number` | nombre | champ numérique ; format : nombre, nombre avec séparateurs, pourcentage, euro, dollar |
| `select` | une option | liste d'options colorées, création à la volée |
| `multi_select` | plusieurs options | idem, plusieurs |
| `status` | une option, rangée en 3 groupes : *À faire*, *En cours*, *Terminé* | options par défaut « Pas commencé », « En cours », « Terminé » |
| `date` | date ou plage, heure optionnelle | calendrier ; « date de fin » ; « inclure l'heure » |
| `person` | membres de l'espace | sélecteur de membres |
| `checkbox` | booléen | case |
| `url` / `email` / `phone` | texte | champ ; lien cliquable (`mailto:`, `tel:`) |
| `files` | fichiers envoyés | envoi + liste |
| `relation` | lignes d'une autre base (ou de la même) | sélecteur avec recherche |
| `formula` | calculée | expression (voir 5.7) |
| `created_time` / `last_edited_time` | date auto | lecture seule |
| `created_by` / `last_edited_by` | personne auto | lecture seule |
| `unique_id` | numéro auto-incrémenté, préfixe optionnel (ex. `TASK-12`) | lecture seule |

- Menu d'une propriété (clic sur l'en-tête de colonne) : renommer, changer le type (conversion au
  mieux des valeurs), trier croissant/décroissant, filtrer, masquer dans la vue, insérer à
  gauche/droite, dupliquer, supprimer (sauf titre).
- Options (select/multi/status) : renommer, couleur (défaut, gris, marron, orange, jaune, vert,
  bleu, violet, rose, rouge), supprimer, réordonner.

### 5.3 Vues
Une base a une ou plusieurs **vues** (onglets au-dessus de la base) ; chaque vue a son nom, son type
et sa configuration propre (filtres, tris, regroupement, propriétés visibles, largeurs). Ajout,
renommage, duplication, suppression (au moins une vue), réordonnancement des onglets.

- **Tableau** : colonnes = propriétés visibles, redimensionnables et réordonnables par glisser ;
  cellules éditables en place ; ligne « + Nouveau » ; ouverture de la ligne (bouton « Ouvrir » au
  survol du titre) ; sélection de lignes (case) avec suppression groupée ; ligne de pied avec
  **calculs** par colonne (aucun, nombre, valeurs vides/non vides, pourcentage, somme, moyenne,
  min, max, plus tôt/plus tard pour dates, cochées/non cochées).
- **Tableau Kanban (board)** : colonnes = options d'une propriété `select`/`status` (+ « Sans
  valeur ») ; cartes glissables entre colonnes (change la valeur) et dans une colonne (ordre) ;
  « + Nouveau » par colonne (pré-remplit la valeur) ; colonnes masquables.
- **Liste** : une ligne par page avec titre et propriétés visibles en étiquettes à droite.
- **Galerie** : cartes en grille ; aperçu = couverture de la page ou rien ; taille de carte
  (petite/moyenne/grande) ; propriétés visibles sous le titre.
- **Calendrier** : grille mensuelle selon une propriété `date` choisie ; navigation mois
  précédent/suivant/aujourd'hui ; glisser une carte vers un autre jour change la date ; clic sur
  un jour vide crée une ligne à cette date.
- **Chronologie** (timeline) : barres horizontales selon une plage de dates ; échelle semaine/mois ;
  glisser pour décaler. *(Priorité basse.)*

### 5.4 Filtres
- Liste de règles combinées par **ET** ou **OU** (au choix pour l'ensemble).
- Opérateurs selon le type :
  - texte/titre/url/email/phone : est, n'est pas, contient, ne contient pas, commence par,
    se termine par, est vide, n'est pas vide ;
  - nombre : =, ≠, >, <, ≥, ≤, est vide, n'est pas vide ;
  - select/status : est, n'est pas, est vide, n'est pas vide ;
  - multi_select/person/relation/files : contient, ne contient pas, est vide, n'est pas vide ;
  - date/created_time/last_edited_time : est, est avant, est après, au plus tard, au plus tôt,
    est dans (semaine passée, mois passé, semaine prochaine, mois prochain, aujourd'hui), est vide,
    n'est pas vide ;
  - checkbox : est coché, n'est pas coché.
- Les filtres s'appliquent en direct ; une nouvelle ligne créée dans une vue filtrée reçoit si
  possible des valeurs qui la rendent visible.

### 5.5 Tris et regroupement
- Plusieurs tris ordonnés (propriété + sens). Sans tri, l'ordre **manuel** (glisser) s'applique.
- Regroupement (tableau, liste, galerie) par propriété select/status/checkbox/person : sections
  repliables avec compteur.

### 5.6 Recherche dans une base
- Champ de recherche dans la barre d'outils de la vue : filtre les lignes dont le titre contient
  le texte.

### 5.7 Formules (simplifiées)
- Expressions avec : nombres, chaînes `"…"`, booléens, `prop("Nom")`, opérateurs `+ - * / %`,
  comparaisons `== != > < >= <=`, `and`, `or`, `not`, et fonctions `if(c,a,b)`, `concat`,
  `length`, `lower`, `upper`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `now()`,
  `dateBetween(d1,d2,"days"|"weeks"|"months"|"years")`, `format`, `empty`.
- Erreur de syntaxe → message dans l'éditeur de formule ; valeur affichée vide.

### 5.8 Page d'une ligne
- Ouverte en **aperçu latéral** (panneau à droite, fermeture par Échap) ou en pleine page
  (bouton « Ouvrir en pleine page »).
- Sous le titre : la liste des propriétés (nom à gauche, valeur éditable à droite), propriétés
  vides repliables (« n propriétés masquées »), « + Ajouter une propriété ».
- Puis le contenu libre de la page (éditeur de blocs complet).

### 5.9 Propriétés avancées et droits par propriété (vague G, session G3)

**Droits par propriété (D30).** Chaque propriété d'une base peut restreindre, par rôle de l'espace,
qui la **voit** et qui **modifie** ses valeurs. Sans réglage, la propriété suit l'accès à la base
(lecture pour tous ceux qui lisent la base, modification pour tous ceux qui la modifient).
- Réglage (menu de la propriété → « Droits d'accès ») réservé aux propriétaires et administrateurs
  de l'espace, qui voient et modifient toujours toutes les propriétés (ils pourraient de toute façon
  changer la règle).
- « Qui peut voir » : tout le monde ayant accès à la base, ou seulement certains rôles (membres,
  lecteurs ; les administrateurs sont toujours inclus). « Qui peut modifier » : tous ceux qui
  peuvent modifier la base, ou seulement certains rôles (membres ; administrateurs toujours inclus).
  Modifier suppose de voir. Le titre n'est pas restreignable. Il n'existe pas encore de rôle
  « invité » dans Oriel : la liste des rôles s'étendra quand il existera.
- Une propriété **cachée** n'existe pas pour la personne concernée : absente du schéma, des valeurs,
  des vues publiées, des formulaires, des exports CSV et zip, de la recherche, des outils MCP, des
  événements temps réel et de l'historique. Les formules et rollups étant calculés dans le
  navigateur à partir des données envoyées, ils ne peuvent pas la lire non plus. Toute écriture sur
  une propriété cachée est refusée comme si elle n'existait pas (`400`, ou `404` pour une opération
  de structure) ; sur une propriété visible mais non modifiable, refus explicite (`403`). Les
  visiteurs anonymes (pages publiées, formulaires publics) ne voient et n'écrivent que les
  propriétés sans restriction.
- Une propriété en lecture seule pour la personne s'affiche avec un cadenas et n'est pas éditable ;
  ses réglages de structure (renommer, changer le type, options, supprimer) sont aussi refusés.

**Formules (D33).** Les formules lisent les propriétés par leur nom.
- L'éditeur de formule et la cellule signalent une formule qui référence une propriété absente
  (supprimée, renommée, ou cachée pour la personne) : « Propriété introuvable : « Nom » ». Lors d'un
  renommage, le menu de la propriété avertit des formules qui la citent.
- Les formules et rollups qui parcourent des pages liées sont évalués dans le navigateur, avec les
  seules lignes que le serveur accepte de fournir : une base liée illisible (privée, autre espace)
  ou une propriété cachée ne livre aucune valeur, le résultat est vide.

**Propriété de vérification (D21).** Type `verification`. Une ligne peut être marquée « Vérifiée »
par une personne, à une date, avec une expiration : aucune, une semaine, un mois, trois mois, un an,
ou une date précise. Passée l'expiration, l'état affiché devient « À revérifier ». Seules les
personnes qui peuvent modifier la ligne (et la propriété) vérifient ou retirent la vérification ; le
serveur inscrit lui-même l'auteur et la date. États : Vérifiée, À revérifier, Non vérifiée —
filtrables (est / n'est pas) et triables. Visible dans la page de ligne avec l'auteur, la date et
l'échéance.

**Pages liées dans la page de ligne (D31).** Pour chaque propriété relation, un réglage conservé dans
la propriété choisit où l'afficher dans la page de ligne : dans la liste des propriétés (défaut),
dans une **section dédiée** sous les propriétés (liste ou mini-tableau des pages liées avec quelques
propriétés, ajout et retrait rapides), ou masquée.

**Schéma des relations (D29).** Depuis les réglages de la base, « Schéma des relations » ouvre un
diagramme : la base au centre, les bases qu'elle relie (dans les deux sens) autour, et pour chaque
lien le nom des propriétés relation (sens unique ou double). Cliquer sur une base l'ouvre. Seules
les bases que la personne peut lire apparaissent.

---

### 5.10 Grille du tableau : plages de cellules, grandes bases, calculs par groupe (vague G, session G2)

**Plages de cellules (D28).** Dans la vue Tableau, on peut sélectionner un rectangle de cellules.
- **Sélectionner** : appuyer sur une cellule puis glisser jusqu'à une autre ; Maj+clic étend la
  plage depuis la cellule active ; Échap pendant l'édition d'une cellule referme l'éditeur et laisse
  la cellule sélectionnée. Un clic simple garde son comportement (il ouvre l'édition).
- **Clavier** (quand une plage existe) : flèches pour changer de cellule, Maj+flèches pour étendre,
  Tab / Maj+Tab pour aller à droite / à gauche, Entrée pour éditer la cellule active, Suppr ou
  Retour arrière pour effacer les valeurs, ⌘D (Ctrl+D) pour remplir vers le bas, Échap pour quitter.
- **Copier** (⌘C) : la plage part dans le presse-papiers en texte tabulé (une ligne par ligne,
  une tabulation entre colonnes), avec des valeurs lisibles : noms d'options et de personnes, titres
  des pages liées, dates ISO, nombres sans mise en forme. ⌘X copie puis efface.
- **Coller** (⌘V) : un texte tabulé (venant d'un tableur ou d'une copie Oriel) est collé à partir
  de la cellule en haut à gauche de la plage. Une seule valeur collée sur une plage plus grande la
  remplit entièrement. Les colonnes qui dépassent la dernière colonne visible sont abandonnées. Si le
  collage dépasse la dernière ligne, une confirmation propose de créer les lignes manquantes ;
  sinon, le surplus est abandonné.
- **Conversion** : chaque valeur est convertie selon le type de la propriété (nombres « 1 234,5 »,
  « 12 % », dates « 13/10/2026 » ou ISO, cases « oui / non », options et personnes par leur nom,
  pages liées par leur titre). Une cellule vide efface la valeur. Une option inconnue est créée dans
  la propriété. Une valeur impossible à convertir est ignorée. Les propriétés calculées ou en lecture
  seule sont ignorées. Un message résume les cellules ignorées.
- **Remplir vers le bas** : la première ligne de la plage est recopiée dans les lignes suivantes.
- **Effacer** : vide les cellules modifiables de la plage (le titre devient vide).
- **Modifier la propriété…** : depuis la barre de la plage, ouvre la modification en masse sur les
  lignes de la plage, avec la propriété de la première colonne présélectionnée.
- **Écritures groupées** : `POST /api/databases/:did/rows/batch` avec `{ updates: [{ id, title?,
  properties? }] }`, au plus 500 lignes par appel (le client découpe). Il faut pouvoir modifier la
  base ; chaque id doit être une ligne de cette base que la personne peut modifier, sinon 404 ; les
  droits par propriété (§5.9) et `validateValue` s'appliquent à chaque valeur ; tout est fait dans une
  seule transaction (tout ou rien). Le client dédoublonne les invalidations reçues dans un même
  message temps réel : une écriture groupée ne recharge les lignes qu'une fois.

**Grandes bases (D32).** Le tableau n'affiche que les lignes visibles (plus une marge), y compris
dans chaque groupe d'une vue groupée ; le mode « retour à la ligne » (hauteurs variables) garde un
affichage progressif. Au-delà de 5 000 lignes chargées, une mention discrète sous le tableau
indique que la base est volumineuse et suggère de filtrer la vue. La sélection, le glisser-déposer
et les groupes fonctionnent sur les lignes fenêtrées.

**Calculs par groupe (D24).** Dans une vue groupée, chaque groupe affiche dans son pied le nombre de
lignes du groupe et leur part du total de la vue (« 12 lignes · 34,5 % »). Les calculs de colonne
choisis s'appliquent aux lignes de chaque groupe.

---

### 5.G1 Filtres avancés, affichage des nombres, rappels de date, dates en langage naturel
*(Vague G, session G1 — D23, D25, D26, E17. Les filtres enregistrés avant cette version restent valides.)*

**Filtres (D23).** Opérateurs ajoutés ; les existants ne changent pas.
- **Multi-valeurs** (multi-select, personne, relation) : « contient » = au moins une des valeurs
  choisies, **« contient tous »** = toutes, « ne contient pas » = aucune. La valeur est une liste.
- **Personne** : la valeur spéciale **« Moi »** (`@me`) désigne la personne connectée ; sans session
  (vue publique) personne n'est « moi ». « Ne contient pas » existe déjà pour personnes et relations.
- **Dates relatives à une durée** (valeur `{ amount, unit: day|week|month }`, montant entier 0–10 000) :
  « est dans les derniers N… » (aujourd'hui compris), « est dans les prochains N… », « il y a
  exactement N… », « dans exactement N… ». Une ligne dont la plage couvre le jour visé correspond.
  Les mois sont ramenés au dernier jour du mois (31 janv. + 1 mois = 28 fév.).
- **« Hier » et « demain »** s'ajoutent aux bornes de « est dans » (`within`).
- **Rollup « afficher l'original »** : un sélecteur « Valeurs concernées » (`quantifier`) choisit entre
  « Texte des valeurs » (comportement historique, sur le texte joint), « Au moins une valeur » (`any`),
  « Toutes les valeurs » (`every`, faux s'il n'y a aucune valeur) et « Aucune valeur » (`none`). La
  condition porte alors sur chaque valeur liée, avec les opérateurs de sa propriété. « Est vide » et
  « n'est pas vide » restent évalués sur le rollup entier.
- L'évaluation est unique : le serveur ne filtre pas ; le MCP importe la logique web, donc le même
  code. `server/src/schemas.ts` valide les opérateurs et conserve `quantifier`.

**Nombres (D25).** Propriétés de la colonne : `numberPrecision` (0 à 10 décimales, sinon
automatique), `numberFormat` (nombre, séparateurs, pourcentage, EUR, USD, GBP, CHF, CAD, JPY, AUD,
CNY, SEK, NOK, DKK, PLN, CZK, BRL, MXN, INR, KRW — `Intl.NumberFormat` fr-FR), `numberDisplay`
(`number` | `bar` | `ring`), `numberMax` (défaut 100), `numberColor`. La barre et l'anneau se remplissent
de valeur / maximum, borné à 0–100 %, avec le chiffre formaté à côté. L'export CSV garde la valeur brute.

**Rappel par défaut (D26).** Réglage `dateReminder: { mode, time }` d'une propriété date : aucun, le
jour même, la veille, 2 jours avant, une semaine avant, à l'heure choisie (09:00 par défaut, heure de
Paris). Chaque date saisie dans la colonne crée un rappel pour **la personne qui l'a saisie** et
remplace les précédents de la cellule ; l'effacer ou la changer les supprime ; une échéance déjà passée
n'en crée pas. Il est tiré par les tâches collab existantes (notification `reminder`), dans la table
`collab_property_reminders`, distincte des rappels de mentions.

**Dates en langage naturel (E17).** Parseur français sans dépendance (`web/src/lib/naturalDate.ts`),
sur le calendrier local : « demain », « après-demain », « hier », « vendredi prochain », « jeudi
dernier », « ce vendredi », « dans 3 jours », « dans une semaine », « il y a 2 mois », « la semaine
prochaine », « fin du mois », « 12 nov », « 1er mai 2027 », « 12/11 », « le 15 », avec heure (« lundi
14h30 », « demain à 9h », « ce soir », « midi ») et plages (« du 12 au 14 nov », « lundi 14h-16h »).
Un jour de semaine seul = prochaine occurrence, aujourd'hui exclu ; « dans huit jours » = 7 jours (en
lettres), « dans 8 jours » = 8. Sans année : cette année, ou la suivante si la date est passée depuis
plus d'un mois. Utilisé dans l'éditeur de date des cellules (avec aperçu de la date comprise) et dans
les mentions `@` (le jour seulement).

## 6. Recherche globale (⌘K)
- Fenêtre modale : champ de recherche ; résultats instantanés sur titres **et** contenu des pages
  accessibles (pages, bases, lignes), avec icône, titre, fil d'Ariane et extrait surligné.
- Sans saisie : pages récemment consultées.
- Navigation clavier (↑ ↓ Entrée Échap).

## 7. Accueil
- Pages récemment consultées (cartes), favoris, raccourci « Nouvelle page ».

## 8. Réglages
- **Mon compte** : nom, avatar, mot de passe, thème (clair / sombre / système).
- **Espace** : nom, icône ; zone dangereuse (supprimer l'espace — owner).
- **Membres** : liste, rôles, invitations.
- **Instance** (administrateur d'instance) : mode d'inscription, liste des utilisateurs.

## 9. Raccourcis clavier
| Raccourci | Action |
|---|---|
| ⌘K / ⌘P | Recherche |
| ⌘N | Nouvelle page (dans la section courante) |
| ⌘\\ | Afficher/masquer la barre latérale |
| ⌘⇧L | Basculer thème clair/sombre |
| ⌘[ / ⌘] | Précédent / suivant |
| ⌥clic | Ouvrir le lien, la mention, la ligne ou l'entrée de la barre latérale dans le panneau voisin (vue scindée) |
| Échap | Fermer aperçu / menu / modale |

## 10. Application macOS
- Application native (fenêtre avec barre de titre intégrée, boutons « feux » en haut à gauche,
  zone de glissement en haut de la barre latérale).
- **Premier lancement** : écran de choix :
  1. **Se connecter à un serveur** : saisie de l'URL (ex. `https://notes.mondomaine.fr`), test de
     connexion, mémorisation.
  2. **Mode local** : un serveur Oriel embarqué démarre sur la machine (données dans le dossier
     Application Support de l'utilisateur), sans réseau requis.
- Menu natif : Oriel (À propos, Réglages ⌘,, Changer de serveur…, Quitter), Édition (standard),
  Affichage (recharger, zoom, plein écran, outils de développement), Navigation (précédent ⌘[,
  suivant ⌘], recherche ⌘K), Fenêtre, Aide.
- Liens externes ouverts dans le navigateur par défaut ; liens internes dans l'application.
- Mémorise taille et position de fenêtre ; plusieurs fenêtres possibles (⌘⇧N).
- Indicateur hors-ligne si le serveur distant est injoignable, avec reconnexion automatique.

### 10.1 Onglets, recherche rapide, Dock, orthographe (vague G10)

Détail : [DESKTOP.md](DESKTOP.md) §4.1 à §4.5.

- **Onglets** : chaque fenêtre porte une barre d'onglets native ; ⌘T (nouvel onglet), ⌘W (fermer
  l'onglet, puis la fenêtre au dernier), ⌘1…⌘9, ⇧⌘[ et ⇧⌘], ⇧⌘T (rouvrir). ⌘clic sur un lien interne
  l'ouvre dans un nouvel onglet. Les onglets se réordonnent par glisser, portent une couleur, se
  détachent dans une nouvelle fenêtre (glisser hors de la barre ou menu de l'onglet).
- **Restauration** : les fenêtres et onglets ouverts (adresses internes seulement, jamais de jeton)
  sont rouverts au lancement suivant ; réglable.
- **Recherche rapide** : raccourci système configurable (⌃⌥Espace par défaut, désactivable) ; fenêtre
  sans cadre : recherche d'une page, Entrée l'ouvre dans la fenêtre principale, « Créer » crée une
  page privée ; Échap ou perte du focus la ferme.
- **Pastille du Dock** : nombre de notifications non lues, effacée à zéro.
- **Orthographe** : suggestions, ajout au dictionnaire, bascule ; langues seulement hors macOS (le
  correcteur du système détecte la langue).
- **macOS** : définition du mot sélectionné (dictionnaire système) ; téléchargements natifs
  (fenêtre d'enregistrement, progression dans le Dock, Finder) limités à l'instance configurée.

## 11. Déploiement serveur (VPS)
- Une seule commande (`docker compose up -d`) démarre Oriel et un reverse-proxy HTTPS
  automatique (certificat Let's Encrypt) pour un nom de domaine fourni.
- Toutes les données (base SQLite, fichiers) dans un seul volume ; sauvegarde = copie de ce
  dossier (script fourni, à chaud et cohérent).
- Variables de configuration documentées ; journal lisible ; point de santé `/api/health`.
- Mise à jour = `git pull && docker compose up -d --build`.

## 12. Exigences non fonctionnelles
- Sécurité : mots de passe hachés (scrypt), cookies `HttpOnly` + `SameSite=Lax` (+ `Secure` en
  HTTPS), contrôle d'accès sur **toutes** les routes et sur la connexion temps réel, limites de
  taille d'envoi, protection contre l'énumération (réponses génériques à la connexion), en-têtes
  de sécurité, limitation de débit sur la connexion/inscription.
- Performance : ouverture d'une page < 300 ms sur un VPS modeste ; bases jusqu'à 5 000 lignes
  fluides.
- Robustesse : le contenu en cours d'édition n'est jamais perdu lors d'une coupure réseau (cache
  local côté navigateur, resynchronisation à la reconnexion).
- Accessibilité : navigation clavier dans menus et modales, contrastes suffisants, libellés ARIA.
- Thèmes clair et sombre.

## 13. Lecture de page (vague G4 : E09 à E12, E16, E21, E22, N05)
Tout ce qui aide à *lire* une page sans la modifier. Rien de ce qui suit ne change le contenu du
document, sauf « Remplacer » (§13.1) qui édite comme le ferait l'utilisateur.

### 13.1 Rechercher dans la page (⌘F / Ctrl+F)
- ⌘F ouvre une barre en haut à droite de la page courante (le panneau d'aperçu si le focus y est).
  Pour une page sans éditeur (base de données), le raccourci natif du navigateur reste actif.
- La recherche est insensible à la casse et aux accents ; elle couvre le **titre** et le **contenu**.
  Les occurrences sont surlignées, l'occurrence courante d'une autre couleur ; compteur « 3 / 12 ».
- Entrée / Maj+Entrée : occurrence suivante / précédente (en boucle). Échap : ferme et retire les surlignages.
- Une occurrence dans un bloc replié déplie les blocs repliés qui la contiennent, puis défile jusqu'à elle.
- « Remplacer » et « Tout remplacer » n'existent que si l'utilisateur peut modifier la page (page non
  verrouillée, non supprimée). Une occurrence dans un bloc d'une autre page (bloc synchronisé) n'est jamais remplacée.

### 13.2 Sommaire flottant
- Colonne de repères fins dans la marge droite : un repère par titre (niveaux 1 à 4), plus long pour
  les niveaux hauts. Survol : liste des titres complets ; clic : défile jusqu'au titre (en dépliant
  ses parents repliés). Le titre visible est mis en évidence.
- Réglage par page (`format.toc`) : automatique (≥ 3 titres, absent du panneau d'aperçu), toujours, jamais.

### 13.3 Mode présentation
- Plein écran en lecture seule. Découpage en diapositives : à chaque séparateur de premier niveau ; sinon à chaque
  titre de niveau 1 ; sinon à chaque titre de niveau 2 ; sinon une seule diapositive.
- La première diapositive porte le titre et l'icône de la page.
- → ↓ Espace PageSuivante : suivante ; ← ↑ PagePrécédente : précédente ; Début / Fin ; Échap : sortir.
  Compteur « 3 / 12 » et boutons précédent/suivant. Les médias et les bases intégrées sont rendus
  comme dans la page (c'est la page elle-même, mise en forme).

### 13.4 Mode focus
- Masque la barre latérale et la barre du haut. ⌘⇧F bascule ; un bouton discret en haut à droite
  (visible au survol de la zone) permet de quitter. Non enregistré : propre à la session du navigateur.

### 13.5 Personnaliser la page
- Réglages enregistrés dans `pages.format` (donc côté serveur, sous les mêmes droits que toute
  modification de page : édition requise) : `hideBacklinks`, `hideComments` (discussion de la page,
  les commentaires sur un passage restent), `hideProperties` (en-tête des propriétés d'une ligne), `toc`.
- Accessible depuis le menu « Affichage » de la barre du haut. Lecteurs en lecture seule : cases désactivées.

### 13.6 Panneau d'informations (à droite)
- Bouton « Informations » de la barre du haut. Sections : propriétés (ligne de base) ou métadonnées
  (création, dernière modification), rétroliens, activité récente, commentaires ouverts.
- Ancrable : épinglé, il réduit la zone de la page ; non épinglé, il se superpose. Le choix est mémorisé
  dans le navigateur. Il coexiste avec l'aperçu latéral (l'aperçu se place à sa gauche).
- L'activité (`GET /api/pages/:pid/activity`) : création, dernières modifications, versions, commentaires,
  limitée aux 30 derniers événements, sous les droits de lecture de la page.

### 13.7 Aperçu au survol
- Survol (≈ 0,4 s) d'un lien ou d'une mention de page : carte avec icône, titre, début du contenu.
  `GET /api/pages/:pid/preview` ; une page invisible ou inexistante répond 404 : aucune carte n'est affichée,
  rien ne distingue « n'existe pas » de « inaccessible ». Pas d'aperçu sur appareil tactile.

### 13.8 Visionneuse de fichiers
- Double-clic sur une image, une vidéo, un audio, un PDF ou un fichier d'une page (ou entrée « Fichiers de la
  page » du menu Affichage) : visionneuse plein écran, ← → entre les fichiers de la page, Échap pour fermer,
  téléchargement. Seuls les fichiers de cette instance sont intégrés dans un cadre (PDF) ; les autres adresses
  s'ouvrent par un lien.

## Importeurs de fichiers d'export (vague G8 : X01)
Réglages › Import / export › Importer reconnaît automatiquement le format des fichiers déposés. **Tout
se passe dans le navigateur** : aucun service tiers n'est contacté, aucune adresse distante n'est
téléchargée (les images externes restent des liens). Chaque import affiche une **prévisualisation**
(éléments créés, ignorés, avertissements), crée les pages et bases à l'emplacement choisi (espace,
privé ou sous une page), envoie les fichiers liés comme pièces jointes, puis produit un **rapport**
(créés, ignorés, avertissements, erreurs) et un bouton « Mettre l'import à la corbeille ».

| Source | Fichiers acceptés | Résultat |
|---|---|---|
| Word | `.docx` | une page par document : titres (1 à 4), paragraphes, gras, italique, souligné, barré, code, listes à puces et numérotées imbriquées, tableaux simples, liens, images intégrées (pièces jointes), notes de bas de page converties en texte (appels `[n]`, section « Notes » en fin de page) |
| Google Docs | `.docx` ou `.html` (ou `.zip` d'un export HTML) obtenu par *Fichier › Télécharger* | même rendu que Word ; le HTML est converti en blocs, jamais injecté |
| Excel | `.xlsx` | chaque feuille choisie devient une base ; types de colonnes détectés (nombre, date, case à cocher, sélection quand peu de valeurs distinctes, URL, e-mail…) et **aperçu modifiable** (inclure la feuille, renommer et typer les colonnes) ; les formules donnent leur valeur calculée enregistrée dans le fichier |
| Confluence | `.zip` d'un export HTML d'espace | arborescence des pages (fil d'Ariane), pièces jointes, macros courantes réduites à du texte ou à des encadrés (info, note, astuce, avertissement, panneau, sections dépliantes, code) |
| Evernote | `.enex` | une base « notes » par fichier (étiquettes en multi-sélection, dates), carnet = page parente quand plusieurs carnets, contenu ENML converti en blocs, ressources jointes |
| Trello | export JSON du tableau | une base : listes → statut, étiquettes → multi-sélection, échéance, description et checklists dans le contenu de la ligne |
| Asana | export CSV d'un projet | une base de tâches : section, assigné (personne si le membre existe, texte sinon), dates, projets, tâches parentes liées quand c'est possible |

Limites et sécurité : XML lu sans DTD ni résolution d'entités (XXE) ; archives bornées (nombre d'entrées,
taille décompressée par entrée et au total, ratio de compression, chemins `..` ou absolus refusés) ;
profondeur d'imbrication et nombre de pages/lignes plafonnés ; un fichier au-delà de `MAX_UPLOAD_MB`
est refusé par le serveur et signalé dans le rapport ; aucune requête réseau pendant l'import.

## Blocs et saisie de l'éditeur (vague G5 : E13, E14, E15, E18, E19, E23, E24)

### Rendus de blocs de code : Mermaid et partitions ABC (E13)
- Deux langages s'ajoutent au sélecteur d'un bloc de code : **Mermaid** (`mermaid`) et **ABC** (`abc`,
  notation musicale). Le bloc garde son code éditable ; les alias `mmd` et `abcjs` sont reconnus.
- Chaque bloc de ces deux langages affiche une **bascule à trois états**, enregistrée dans la propriété
  `view` du bloc (donc synchronisée en temps réel et conservée au rechargement) : **Code**,
  **Aperçu**, **Les deux** (côte à côte quand la largeur le permet, sinon l'un sous l'autre). Défaut :
  les deux. Les lecteurs (page verrouillée, page publique) voient l'état choisi par l'éditeur.
- L'aperçu se met à jour pendant la frappe (après une courte attente) ; une erreur de syntaxe affiche un
  message en français sous le code sans casser la page. Source limitée à 20 000 caractères ; au-delà,
  l'aperçu est désactivé.
- Les bibliothèques de rendu (Mermaid, abcjs) sont **chargées à la demande**, au premier bloc affiché.
- **Sécurité** : le rendu ne peut ni injecter de HTML ni exécuter de script dans l'origine d’Oriel.
  1. Mermaid tourne en `securityLevel: 'strict'`, sans libellés HTML, avec taille de texte et nombre de
     liens plafonnés ; les directives `%%{init}` ne peuvent pas relâcher ces réglages.
  2. La sortie SVG (Mermaid et abcjs) est **reconstruite à partir d'une liste blanche** d'éléments et
     d'attributs (jamais de `script`, `foreignObject`, `image`, `a`, `animate`, gestionnaires `on*`, URL
     externes), puis insérée dans un **Shadow DOM** : même le CSS du diagramme ne peut pas styler la page.
  3. Les erreurs de rendu ne laissent aucun élément dans le document.
- Export : le code est exporté tel quel (bloc de code Markdown avec le langage) ; l'aperçu n'est pas exporté.
  À l'impression PDF, l'aperçu est imprimé (le mode « Code » seul n'imprime que le code).

### Images : recadrage et lien (E15)
- Le bloc image garde ses réglages (largeur, légende, alignement) et gagne deux propriétés :
  `crop` (rectangle de recadrage, fractions de l'image d'origine : `x,y,largeur,hauteur`) et `link`.
- **Recadrer** (bouton au survol, menu du bloc, clic droit) ouvre l'image d'origine avec un rectangle
  déplaçable et redimensionnable (poignées aux coins et aux côtés, proportions libres, dimension minimale
  5 %). « Appliquer » enregistre le rectangle ; « Réinitialiser » le retire. **Non destructif** : le
  fichier envoyé n'est jamais modifié, le recadrage se rouvre et s'ajuste à volonté.
- **Lien** (bouton au survol) : saisie d'une adresse validée comme les liens du texte (http, https,
  mailto, tel ; `javascript:`, `data:`, `file:`… refusés). Cliquer l'image la suit (nouvel onglet,
  `noopener noreferrer`) ; en édition, un clic sélectionne l'image et ⌘/Ctrl-clic ouvre le lien.
- Copie et export HTML : l'image est enveloppée de son lien ; le recadrage s'exporte en CSS
  (`object-view-box`) là où il est pris en charge, sinon l'image complète. Export Markdown : image
  d'origine (avec son lien).

### Collage depuis Word et Office (E19)
- Un collage HTML issu de Word, Excel, PowerPoint ou Outlook est détecté (balises `o:p`, styles `mso-`,
  commentaires conditionnels, classes `Mso…`) puis **nettoyé avant insertion** :
  - retrait des styles, classes, balises `o:*`/`w:*`/`v:*`, commentaires conditionnels, polices parasites,
    paragraphes vides d'espacement, `<xml>`, `<style>`, images locales `file:` ;
  - titres (`Heading n`, `Titre n`, `Title`) → titres 1 à 4 ; gras et italique portés par des `span` de
    style → balises sémantiques ; souligné et barré conservés ;
  - listes Word (paragraphes `MsoListParagraph` avec numérotation ou puces simulées) → vraies listes à
    puces ou numérotées, imbriquées selon le niveau ;
  - tableaux simples → tableaux (cellules sans mise en forme, un paragraphe par ligne).
- **Gros collages** : au-delà de 150 blocs de premier niveau, le collage est inséré **par tranches**
  entre deux affichages, avec un message « Collage en cours… », pour garder l'éditeur fluide ; un collage
  de plus de 10 000 blocs est refusé avec un message (le contenu en texte brut reste collable).
- Le collage de texte brut et Markdown n'est pas modifié.

### Bloc Dessin (E14)
- Menu `/` › « Dessin » : zone de croquis à main levée (proportions fixes 5:3, pleine largeur du
  contenu). Outils : **stylo** (8 couleurs, 4 épaisseurs), **gomme** (efface les tracés touchés),
  **annuler** et **rétablir** (historique local de la session), **tout effacer**.
- Stockage : propriété `strokes` du bloc, JSON de tracés `{c: couleur, w: épaisseur, p: [x,y,…]}` en
  coordonnées 0–1000 × 0–600. Bornes strictes à la lecture comme à l'écriture : 400 tracés, 2 000
  points par tracé, 100 ko ; couleurs `#rrggbb` ; valeurs hors bornes ignorées. Les tracés sont
  transmis aux autres personnes au relâchement du stylo, comme toute propriété (le dernier écrit gagne).
- Rendu : chemins SVG construits par l'application depuis les nombres, jamais de SVG fourni tel quel.
- Pages en lecture seule : le dessin s'affiche sans outils. Export : image SVG (HTML, Markdown).

### Sélecteur d'emoji : recherche en français (E23)
- Le sélecteur de l'icône de page, des encadrés et de l'insertion d'emoji cherche aussi par **mots-clés
  français** (« chat », « fête », « voiture rouge »), sans accent ni casse, en plus des mots-clés
  anglais. Les données proviennent de CLDR (Unicode, licence permissive) via `emojibase-data` (MIT) ;
  la source est indiquée dans `web/src/data/emojiKeywordsFr.ts` et dans `docs/NOTICE-DATA.md`.

### Sens d'écriture automatique (E18)
- Chaque bloc de texte détermine son **sens d'écriture** d'après son premier caractère à direction
  forte (`dir="auto"`) : un paragraphe arabe ou hébreu s'aligne à droite et s'affiche de droite à gauche
  même dans une page française ; les puces, numéros, cases à cocher, citations (filet) et titres dépliants
  suivent le sens du bloc ; les mélanges arabe/hébreu/français restent lisibles par segment.
- Aucun réglage : la détection est par bloc et se met à jour pendant la frappe.

### Dictée vocale (E24)
- Un bouton micro apparaît en bas de l'éditeur **uniquement** si le navigateur fournit la reconnaissance
  vocale (`SpeechRecognition`) et que la page est modifiable ; il est aussi proposé dans le menu `/`
  (« Dictée vocale »). Il est masqué sinon (aucune erreur).
- Premier usage : un message prévient que **l'audio peut être envoyé au fournisseur du navigateur**
  (par exemple Google pour Chrome) pour être transcrit ; il faut l'accepter une fois (mémorisé dans le
  navigateur). La dictée n'est jamais démarrée sans geste de l'utilisateur.
- Le texte reconnu est inséré **au curseur** au fil de la dictée (le texte provisoire est affiché dans
  une bulle, le texte définitif inséré) ; le bouton arrête la dictée ; Échap aussi. Langue : français par
  défaut, réglable dans le menu du bouton (français, anglais, espagnol, allemand, italien, arabe,
  hébreu). Erreurs (micro refusé, service indisponible, application de bureau) : message en français.

## Historique des versions : comparaison, restauration, récupération (vague G6 : E20)

Complète le §4.3. Une **version** est un instantané du contenu de la page enregistré par le serveur ;
la liste commence toujours par « État actuel » (le contenu en direct, qui n'est pas encore une version).

### Qui voit quoi
- L'historique (liste, aperçu, comparaison, blocs supprimés) est réservé aux personnes dont le
  **rôle dans l'espace est au moins « membre »** et qui voient la page. Un lecteur (`viewer`) voit la
  page mais pas ses anciennes versions : une ancienne version peut contenir un passage retiré
  volontairement. Visiteurs anonymes (pages publiées) : jamais. Une page invisible renvoie 404 ;
  un lecteur reçoit 403 sur les routes d'historique, et le panneau affiche « Historique réservé aux
  membres de l'espace ».
- Restaurer (page entière ou blocs choisis) exige le droit de modifier la page, et une page hors de
  la corbeille.
- Les blocs synchronisés et les bases intégrées d'une ancienne version sont affichés avec les droits
  de la personne qui consulte, et seulement s'ils appartiennent à l'espace de la page : une base ou
  un bloc d'un autre espace, ou illisible, apparaît comme « contenu indisponible ». Le contenu d'un
  bloc synchronisé a son propre historique : la comparaison ne montre que l'ajout, le retrait ou le
  déplacement de la référence.
- Pour une page de ligne de base de données, les propriétés que la personne ne peut pas voir
  (droits par propriété, §5.9) n'apparaissent ni dans les valeurs ni dans les changements.

### Comparaison
- Dans le panneau « Historique », chaque version propose deux onglets : **Aperçu** (lecture seule,
  comme aujourd'hui) et **Comparer**. Par défaut, la version choisie est comparée à **l'état
  actuel** ; un sélecteur « Comparer avec » permet de choisir une autre version (plus ancienne ou
  plus récente : l'ordre est remis dans le sens chronologique).
- Les blocs sont appariés par leur identifiant. Chaque bloc est marqué :
  - **ajouté** (fond vert, filet vert) ; **supprimé** (fond rouge, texte barré, affiché à son ancienne
    place) ; **modifié** (filet orange) ; **déplacé** (badge « Déplacé », à sa nouvelle place ; un
    bloc peut être déplacé et modifié) ; inchangé (atténué).
  - Dans un bloc modifié, les **différences de texte** sont surlignées mot à mot : insertions en
    vert souligné, suppressions en rouge barré. Un changement de type (paragraphe → titre), de
    mise en forme seule ou de réglage (couleur, niveau, case cochée…) est signalé en clair
    (« Type : Paragraphe → Titre 2 », « Mise en forme modifiée », « Cochée : non → oui »).
- Option **« Changements seulement »** (activée par défaut) : les blocs inchangés sont repliés en
  « n blocs inchangés » ; un résumé en tête donne le nombre de blocs ajoutés, supprimés, modifiés et
  déplacés. Navigation « Changement précédent / suivant ».
- En tête : les deux bornes de la comparaison avec leur date et leurs **auteurs** quand ils sont
  connus (personnes ayant modifié la page pendant la période couverte par la version).
- Page de ligne de base de données : une section **Propriétés** liste les changements de titre et de
  valeurs entre les deux bornes (« Statut : En cours → Terminé »), avec auteur et date de la dernière
  modification quand ils sont connus. Les valeurs de propriétés sont historisées par le serveur à
  chaque modification (regroupées par personne sur 10 minutes) ; avant la mise en service de cet
  historique, l'état d'origine n'est pas connu et la section l'indique.
- Le calcul de différence est fait dans le navigateur, hors du fil principal (Web Worker) dès que
  la page dépasse quelques centaines de blocs ; au-delà de 20 000 blocs, la comparaison est refusée
  avec un message (l'aperçu reste disponible).

### Restauration
- **Restaurer la page entière** (bouton de la barre d'outils) : le contenu actuel est ramené à la
  version choisie. La restauration est appliquée **comme une modification collaborative** sur le
  document en cours : les blocs identiques sont conservés tels quels, seuls les blocs différents sont
  modifiés, retirés ou réinsérés, et les textes sont corrigés au caractère près. Les personnes
  connectées voient le changement en direct, sans recharger, et une saisie concurrente dans un autre
  bloc est préservée.
- **Restaurer des blocs choisis** depuis la comparaison :
  - un bloc **supprimé** : « Réinsérer » le remet à la place la plus proche de son ancienne place :
    après son ancien voisin précédent s'il existe encore, sinon avant son ancien voisin suivant, sinon
    en premier enfant de son ancien bloc parent, sinon en fin de page. Ses blocs enfants sont
    réinsérés avec lui, sauf ceux qui existent encore ailleurs (pas de doublon) ;
  - un bloc **modifié** : « Rétablir ce texte » lui rend son type, ses réglages et son texte de
    l'ancienne version, sans toucher à ses blocs enfants ni à sa position ;
  - on peut cocher plusieurs blocs et « Restaurer la sélection ».
  Un bloc qui existe déjà (réinsertion) ou qui n'existe plus (rétablissement) est ignoré et signalé.
- Toute restauration crée **elle-même une nouvelle version** : l'état précédent est enregistré
  (« Avant une restauration »), puis l'état obtenu (« Restauration », avec la date de la version
  d'origine et la personne qui a restauré). L'historique n'est jamais réécrit.

### Récupération des blocs supprimés
- Onglet **« Blocs supprimés »** du panneau : les blocs présents dans les versions des 30 derniers
  jours (au plus 60 versions) et absents de l'état actuel, du plus récent au plus ancien, avec un
  extrait, le type, la dernière version qui les contenait et, quand c'est connu, la période et les
  personnes de la suppression. Les blocs enfants d'un bloc supprimé sont regroupés sous lui. Au plus
  200 blocs.
- « Réinsérer » (un clic) remet le bloc à sa place la plus proche, avec les mêmes règles que
  ci-dessus. Un bloc supprimé depuis la dernière version n'est récupérable que si cette version le
  contenait : la liste le précise.

### Fréquence et rétention des versions
- Politique constatée : une version au plus toutes les **10 minutes d'édition** (enregistrée à la
  première sauvegarde qui suit, avec la liste des personnes ayant modifié la page depuis la version
  précédente), plus une version **du jour** ; les versions automatiques sont gardées 30 jours, les
  versions du jour 1 an, les versions « Avant une restauration » 30 jours.
- Retenu (ne supprime aucune version existante, n'allonge que des durées) : versions
  « Avant une restauration » et « Restauration » gardées **90 jours** ; historique des valeurs de
  propriétés gardé 1 an.
- Proposé, à valider par l'utilisateur avant toute mise en œuvre (cela supprimerait des versions) :
  au-delà de 7 jours, ne garder qu'une version automatique par heure ; au-delà d'un an, une version
  par mois.

## Sécurité des comptes (vague G9 : A05, A06, A07, A08)

### Double authentification (A05)
- **Application d'authentification (TOTP)** : depuis Réglages › Sécurité, « Activer » affiche un QR
  code (généré dans le navigateur, rien n'est envoyé à un service tiers) et la clé en clair. La
  personne saisit un code à 6 chiffres pour confirmer ; Oriel affiche alors **10 codes de
  secours** à usage unique, une seule fois (copier / télécharger). Les codes de secours sont stockés
  hachés ; « Régénérer » remplace toute la série.
- Codes à 6 chiffres, pas de 30 s, tolérance d'un pas avant ou après. Un code déjà accepté (ou un
  code plus ancien) est refusé : pas de réutilisation. Au plus 5 essais par tentative de connexion,
  plus des limites par compte et par adresse IP.
- Le secret est chiffré au repos (AES-256-GCM). La clé est dérivée de `ORIEL_SECRETS_KEY` si elle
  est définie, sinon d'un fichier `secret.key` créé dans le dossier de données avec les droits 0600.
  Perdre cette clé rend les secrets illisibles : l'administrateur doit alors réinitialiser la double
  authentification des comptes.
- **Connexion** : après un mot de passe correct, un compte protégé voit une seconde étape : code de
  l'application, code de secours ou clé d'accès. Aucune session n'existe avant cette étape. Un lien
  de réinitialisation du mot de passe ne contourne pas la seconde étape.
- **Clés d'accès (passkeys)** : ajout (nom libre), liste (date d'ajout, dernière utilisation),
  suppression. Une clé d'accès permet la **connexion sans mot de passe** (« Se connecter avec une clé
  d'accès », vérification de l'utilisateur exigée) et sert aussi de seconde étape. L'identifiant de
  site (rpID) et l'origine sont tirés de `PUBLIC_URL` (https, ou http sur `localhost`) : sans
  `PUBLIC_URL`, les clés d'accès sont indisponibles.
- Un compte est **protégé** s'il a l'application TOTP activée ou au moins une clé d'accès.
- **Politique d'espace** : un propriétaire ou administrateur de l'espace, lui-même protégé, peut
  imposer la double authentification à tous les membres, avec un délai de grâce de 0 à 30 jours.
  Pendant le délai, l'accueil des membres non protégés affiche l'échéance. Ensuite, un compte non
  protégé membre de cet espace ne peut plus rien faire dans Oriel (API, jetons d'API, temps réel)
  hors de la page d'enrôlement, où il active l'application ou une clé d'accès ; ses connexions temps
  réel ouvertes sont fermées. Retirer sa dernière méthode est refusé tant qu'un espace l'impose.
- **Récupération** : un administrateur de l'instance peut réinitialiser la double authentification
  d'un compte (application, codes de secours, clés d'accès supprimés ; toutes ses sessions sont
  fermées). L'action est inscrite au journal de sécurité et la personne est prévenue par e-mail si
  l'envoi d'e-mails est configuré.
- **Journal de sécurité** : chacun voit les événements de son compte (activation, désactivation,
  clés ajoutées ou retirées, réinitialisation par un administrateur, changement d'e-mail, transferts).
- **Mode local de l'app macOS** : un seul utilisateur, connecté automatiquement depuis la machine.
  Double authentification, clés d'accès et SSO y sont sans objet et masqués ; la confirmation
  d'identité n'y est pas demandée.

### Confirmation des actions sensibles (A06)
- Certaines actions exigent une **confirmation d'identité récente** (moins de 10 minutes, connexion
  comprise) : supprimer un espace, proposer ou accepter un transfert de propriété, créer ou révoquer
  un jeton d'API, activer, désactiver ou modifier la double authentification (application, codes de
  secours, clés d'accès), changer d'adresse e-mail ou de mot de passe, promouvoir un membre
  administrateur ou propriétaire, modifier la politique de double authentification d'un espace,
  associer un compte SSO, réinitialiser la double authentification d'autrui.
- Sinon le serveur répond `403` (`reauth_required`) et l'interface ouvre une fenêtre « Confirmez
  votre identité », puis rejoue l'action. Méthodes : clé d'accès ; code de l'application si elle est
  activée ; mot de passe seulement pour un compte sans double authentification ; connexion SSO pour
  un compte qui n'a ni mot de passe ni seconde méthode.
- Le changement de mot de passe accepte toujours le mot de passe actuel comme confirmation.

### Transfert d'un espace (A08)
- Un propriétaire propose de transférer l'espace à un autre membre (Réglages › Sécurité). La
  personne reçoit un e-mail (si configuré) et voit la proposition sur son accueil et dans ses
  réglages : « Accepter » (avec confirmation d'identité) ou « Refuser ». L'auteur peut annuler.
  Une proposition expire au bout de 7 jours ; une nouvelle remplace la précédente.
- À l'acceptation, si l'auteur est toujours propriétaire et le destinataire toujours membre : le
  destinataire devient propriétaire, l'auteur devient administrateur. Les deux sont prévenus et
  l'événement est inscrit à leur journal de sécurité.

### Connexion d'entreprise et domaines (A07)
- **OIDC** (Authentik, Keycloak, Google Workspace…), configuré par l'administrateur du serveur
  (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`), exige `PUBLIC_URL`. La page de
  connexion affiche « Continuer avec <libellé> ». Flux « code » avec PKCE, `state` lié au navigateur,
  `nonce`, vérification de l'émetteur, de l'audience, de la signature et de l'expiration du jeton.
- Une identité SSO déjà associée ouvre la session du compte associé (puis seconde étape si le
  compte a l'application TOTP). Une identité inconnue dont l'adresse correspond à un compte existant
  est **refusée** : on se connecte d'abord par mot de passe, puis on associe le compte SSO depuis
  Réglages › Sécurité. Une identité inconnue sans compte crée un compte si les inscriptions sont
  ouvertes, ou si son adresse (vérifiée par le fournisseur) appartient à un domaine vérifié qui
  accepte l'inscription automatique.
- **Domaines vérifiés** : un propriétaire ou administrateur d'espace déclare un domaine ; Oriel
  donne un enregistrement DNS TXT à créer (`_oriel.<domaine>` = `oriel-verification=…`), puis
  « Vérifier » interroge le résolveur DNS du système (délai limité, résultat mis en cache, nombre
  d'essais limité). Un domaine n'est vérifié que pour un seul espace. Option « inscription
  automatique » avec un rôle (membre ou lecteur) : les personnes dont l'adresse du domaine est
  **vérifiée par le fournisseur SSO** rejoignent l'espace à leur connexion. Une inscription par mot de
  passe ne donne jamais d'adhésion automatique (adresse non vérifiée).
- **SAML** : non disponible pour l'instant.

## Navigation, espaces d'équipe et consultations (vague G7 : N04, N06 à N11, D22)

### Espaces d'équipe (teamspaces)
- Un espace d'équipe est une page racine de l'espace de travail qui regroupe des pages pour une équipe.
  Il a un **mode d'accès** :
  - **ouvert** : tous les membres de l'espace de travail peuvent le voir, lire son contenu et le rejoindre ;
  - **fermé** : il figure dans l'annuaire (nom, icône, description, propriétaires, nombre de membres),
    mais seul un membre de l'équipe lit son contenu ; les autres peuvent demander l'accès ;
  - **privé** : seuls ses membres savent qu'il existe.
- Un espace ouvert peut être **par défaut** : tous les membres de l'espace de travail en font partie
  et ne peuvent pas le quitter. Les espaces d'équipe existants avant cette version sont ouverts et
  par défaut : rien ne change pour eux.
- Rôles dans l'équipe : propriétaire (gère le mode, la description, les membres et les demandes) ou
  membre. Les propriétaires et administrateurs de l'espace de travail gèrent aussi les espaces ouverts
  et fermés. Il reste toujours au moins un propriétaire. Le droit de modifier le contenu reste celui
  du rôle dans l'espace de travail (un lecteur reste lecteur).
- La section « Espaces d'équipe » de la barre latérale montre ceux dont on est membre. Les pages d'un
  espace ouvert non rejoint restent accessibles par la recherche et les liens.
- **Annuaire** (`Espaces d'équipe` dans la navigation) : parcourir les espaces ouverts et fermés,
  rejoindre un espace ouvert, demander l'accès à un espace fermé. Une demande notifie les
  propriétaires de l'équipe (à défaut, ceux de l'espace de travail) dans leur boîte de réception ;
  ils l'acceptent ou la refusent, et le demandeur est notifié en cas d'acceptation.
- Quitter une équipe ou en être retiré ferme immédiatement les pages ouvertes de cette équipe.
- Retirer quelqu'un de l'espace de travail le retire de toutes ses équipes.

### Transformer une page en espace d'équipe, déplacer vers un autre espace
- **Seuls les propriétaires et administrateurs de l'espace de travail** transforment une page en espace
  d'équipe (décision de l'utilisateur, 15/10) : par l'action ci-dessous comme par l'ancien marquage d'une
  page partagée, dans un sens comme dans l'autre. Un autre membre reçoit un refus (403), ou « introuvable »
  (404) s'il ne voit pas la page ; l'action ne lui est pas proposée dans l'interface.
- « Transformer en espace d'équipe » (menu d'une page) : la page et toutes ses sous-pages deviennent un
  espace d'équipe à la racine, dont l'auteur de l'opération est propriétaire. Avant confirmation, une
  fenêtre explique l'effet sur l'accès : nombre de personnes qui gagnent ou perdent l'accès. Par défaut
  le mode est choisi pour ne **rien élargir** : une page privée devient un espace privé, une page
  partagée un espace ouvert.
- Déplacer une page dans un autre espace d'équipe (ou hors d'un espace) donne à toute la
  sous-arborescence l'accès de sa nouvelle place. Si le déplacement élargit l'accès (page privée vers
  une équipe, équipe restreinte vers un espace plus large), la même fenêtre d'explication s'affiche et
  le serveur exige une confirmation explicite. Un rétrécissement est aussi annoncé.
- La racine d'un espace fermé ou privé ne peut pas être placée sous une autre page ni changer d'accès
  par un déplacement ; on la réordonne parmi les autres espaces. Un espace ouvert déplacé ailleurs
  redevient une page ordinaire. Une racine d'espace d'équipe ne se duplique pas.

### Barre latérale personnalisable
- Section **Raccourcis** personnelle : raccourcis vers une page, une vue d'une base, ou un lien externe
  (adresse `http` ou `https` uniquement, ouverte dans un nouvel onglet).
- On crée des **sections nommées** pour les regrouper ; sections et raccourcis se réordonnent par
  glisser-déposer, une section se replie (état mémorisé côté serveur).
- Une **base épinglée** se déplie pour afficher ses vues (un clic ouvre la base sur cette vue), puis ses
  lignes dans l'ordre de la base, chargées seulement à l'ouverture et par paquets de 25.
- Un raccourci dont la cible devient invisible (droits retirés, corbeille, suppression) disparaît, sans
  révéler son titre ; il réapparaît si l'accès revient.
- **Dossiers** : dans « Partagé », « Privé » ou un espace d'équipe, on regroupe des pages racines dans un
  dossier nommé, sans créer de page parente. Le dossier n'a pas de contenu ; chaque page garde ses
  propres droits. Supprimer un dossier remet ses pages à la racine. Les dossiers privés ne sont vus que
  de leur auteur.

### Consultations et statistiques de page
- Chaque ouverture d'une page par un membre enregistre sa **dernière visite** et ajoute une vue au
  compteur du jour (au plus une vue par personne et par demi-heure). Les visiteurs anonymes d'une page
  publiée n'incrémentent qu'un compteur journalier, sans aucune donnée personnelle.
- Le bouton **Statistiques** de la barre du haut montre : vues des 30 derniers jours (dont anonymes),
  lecteurs uniques sur 7 et 30 jours, la liste des lecteurs avec leur dernière visite, et les auteurs
  des dernières modifications. Un réglage d'espace (administrateurs) masque la liste des lecteurs.
- Propriété de base **Dernière consultation** : date de la dernière visite de la ligne par
  l'utilisateur courant (vide s'il ne l'a jamais ouverte). Calculée, non modifiable, propre à chacun.

### Profil d'une personne
- Ouvert depuis un avatar (présence, statistiques) ou une mention de personne : nom, rôle, date
  d'arrivée, ses pages, son activité récente et ses principaux collaborateurs. Tout est filtré par ce
  que le lecteur peut voir : aucune page privée ni d'équipe inaccessible n'y figure, même par son titre.

### Contraste élevé
- Préférence locale « Contraste élevé » (menu de l'espace, onglet Accessibilité) qui s'ajoute au thème
  clair ou sombre : textes, bordures, focus et accent renforcés, contraste WCAG AA (4,5:1 pour le
  texte, 3:1 pour les éléments d'interface) vérifié sur les éléments principaux.

## Journal quotidien et organisation de l'espace (vague H3 : lots C et D)

### Journal quotidien
- Chaque personne a **un journal personnel par espace de travail** : une page par jour, privée
  (visible de son seul auteur), rangée sous une page « Journal » qui apparaît dans la section « Privé ».
  Le conteneur est créé au premier usage ; supprimer une page de jour ne change rien aux autres.
- L'entrée **Journal** de la barre latérale ouvre une page avec un **calendrier mensuel** : les jours qui
  ont une page sont marqués, le jour courant est entouré, un clic ouvre le jour (le crée s'il n'existe pas),
  un bouton « Aujourd'hui » ramène au mois courant. Aucune page n'est créée par la simple consultation
  du calendrier.
- Titre d'une page de jour : « jeudi 15 octobre 2026 », icône 📅. Une seule page par jour et par personne :
  ouvrir deux fois le même jour renvoie la même page (opération idempotente, sûre en concurrence).
  Si la page du jour est à la corbeille, un nouvel appel en crée une autre.
- **Modèle de journal** : réglage personnel (page « Journal » et Réglages › Journal) qui choisit parmi les
  modèles de page existants (`Modèles` de la barre latérale). Une nouvelle page de jour est une copie de ce
  modèle ; sans modèle, la page est vide. Un modèle devenu invisible ou supprimé est ignoré.
- **Raccourci « Journal du jour »** : `⌥J` (`Alt+J`) et entrée de la palette de commandes. Ouvre la page
  d'aujourd'hui (fuseau du navigateur).
- **Mention `@`** : une date en langage naturel (« demain », « vendredi prochain », « 12 nov ») propose,
  en plus de la mention de date, « Journal du … » : ouvre la page de ce jour (la crée si besoin).
- Une journée est une date calendaire `AAAA-MM-JJ` entre 2000 et 2100 ; toute autre valeur → 400.

### Tags d'espace
- Un **tag** est un libellé coloré propre à l'espace de travail (nom unique sans tenir compte de la casse
  ni des accents, 40 caractères, 12 couleurs). Il s'applique à n'importe quelle page non supprimée
  (page, base, ligne), pas aux pages d'un autre espace.
- Qui peut quoi : tout éditeur crée, renomme, recolore et applique un tag à une page qu'il peut
  **modifier** ; seuls l'auteur du tag et les propriétaires/administrateurs le suppriment (il est alors
  retiré de toutes les pages). Un lecteur voit les tags mais ne les modifie pas.
- L'en-tête de la page affiche ses tags et un bouton « + Tag » (choisir, créer à la volée, retirer).
- **Application en lot** : depuis « Toutes les pages », la sélection reçoit ou perd un ou plusieurs tags ;
  les pages que la personne ne peut pas modifier sont comptées comme ignorées, sans préciser pourquoi.
- **Une page par tag** : `/w/:wid/tags/:tagId` liste les pages portant le tag (même moteur que « Toutes
  les pages », avec le tag en filtre). Le nombre de pages d'un tag ne compte que les pages que la personne
  voit : une page privée ou d'un espace d'équipe restreint n'y apparaît jamais, ni dans les nombres.

### Propriétés de page de l'espace (hors bases)
- Définitions communes à l'espace : **texte, nombre, date, case à cocher, sélection** (50 options au plus,
  nom + couleur). Une page, une base ou une ligne peut en porter la valeur ; elles n'ont aucun lien avec
  les propriétés des bases.
- Chaque définition a un **ordre** (réorganisable) et un **affichage** : « toujours » (même vide),
  « masquée si vide » (défaut), « toujours masquée » (reste utilisable comme colonne, filtre ou tri).
- Création et modification : éditeurs ; suppression : propriétaires/administrateurs (les valeurs sont
  supprimées). Valeur modifiable par qui peut modifier la page. Une valeur est validée selon le type
  (nombre fini, date `AAAA-MM-JJ`, option existante) et `null` l'efface.
- Elles s'affichent sous le titre de la page, avec les tags, dans un bloc repliable.

### Collections intelligentes
- Une **collection** est une liste de pages définie par des **règles**, plus des pages **ajoutées** ou
  **exclues** à la main. Elle est partagée par l'espace (nom, icône), mais **ses pages sont toujours
  filtrées par les droits de la personne qui la lit** : chacun voit un résultat différent.
- Règles : « toutes » ou « une au moins » parmi des conditions :
  - **tag** (a l'un de / les tous / aucun de) ;
  - **auteur** (créée par / modifiée en dernier par) ;
  - **date** de création ou de modification (avant, après, entre, ou les N derniers jours) ;
  - **propriété** de l'espace (égale à, contient, plus grand/petit que, vide, non vide, cochée) ;
  - **espace** : Partagé, Privé, ou un espace d'équipe (sous-arbre de la racine) ;
  - **type** : page, base, ligne de base, modèle, journal ;
  - **titre** contient (sans tenir compte de la casse ni des accents).
- Résultat = (pages qui satisfont les règles ∪ ajoutées) − exclues, jamais de page supprimée ni invisible.
  Sans règle ni page ajoutée, la collection est vide.
- **Aperçu en direct** dans l'éditeur de collection : le résultat est recalculé à chaque modification des
  règles (sans enregistrer), paginé.
- Accès à la liste : « Toutes les pages » (barre latérale › Collections) filtre sur la collection.

### Toutes les pages
- Page `/w/:wid/all-pages` : toutes les pages visibles de l'espace, **paginées côté serveur** (50 par
  défaut, 100 au plus). Par défaut : pages et bases hors lignes de bases, hors bases en ligne, hors corbeille.
- **Affichage** : liste (tableau, une ligne par page) ou grille (cartes).
- **Filtres** : les mêmes conditions que les collections (+ « type » qui peut inclure les lignes).
- **Tri** : titre, création, modification, ou une propriété de l'espace ; croissant/décroissant.
- **Regroupement** : aucun, tag (premier tag par ordre alphabétique ; « Sans tag »), auteur, mois de
  création, mois de modification, type, ou une propriété de sélection.
- **Colonnes** au choix : parent, auteur, créée, modifiée, tags, propriétés de l'espace.
- **Vues enregistrées** (mise en page, filtres, regroupement, tri, colonnes) : personnelles, ou partagées
  avec l'espace par leur auteur. Seul l'auteur modifie ou supprime une vue.
- **Actions en lot** sur la sélection (100 pages au plus par appel) : ajouter/retirer des tags, mettre à
  la corbeille, déplacer sous une page ou à la racine. Chaque page est traitée avec ses propres droits ; le
  retour liste les pages traitées et les refus. Pas de transaction globale : un refus n'annule pas le reste.
  Un déplacement qui élargit l'accès exige la confirmation habituelle (`confirmAccess`).

### Barre latérale
- Entrées « Journal » et « Toutes les pages » sous « Accueil ».
- Section « Tags et collections » (repliable) : tags (avec couleur) et collections non rangés dans un dossier.
- Les **dossiers** existants acceptent aussi des tags et des collections (menu de l'élément › « Ranger dans
  un dossier… »). Un dossier privé peut contenir un tag ou une collection de l'espace, sans rien changer pour
  les autres. Un élément peut être rangé dans plusieurs dossiers ; il quitte la section « Tags et collections »
  dès qu'il est dans un dossier que l'on voit. Supprimer un dossier les remet dans la section.

### MCP
- Lecture seule : `oriel_list_tags`, `oriel_list_collections` et `oriel_query_pages` (par tag ou collection, par
  titre, paginé ; route `GET /api/workspaces/:wid/pages`, utilisable avec un jeton en lecture seule). Tout passe
  par le contrôle d'accès du jeton : les pages invisibles n'apparaissent jamais.

## Vue scindée (vague H, session H4 : lot E)

Deux ou trois pages côte à côte dans la zone principale. La page affichée dans le panneau actif reste
**la page de la route** : tout ce qui suit la page courante (barre latérale, titre de l'onglet, raccourcis,
panneau d'informations, recherche dans la page) suit donc le panneau actif sans autre mécanisme.

### État et adresse
- L'état fait partie de l'URL : `/w/:wid/p/:pageId?split=<id1>,<id2>[,<id3>]&active=<n>`.
  - `split` : les pages des panneaux, de gauche à droite (2 ou 3 ; une même page peut y figurer deux fois) ;
  - `active` : rang du panneau actif (0 par défaut) ; `:pageId` est toujours la page de ce panneau.
    Si `:pageId` et `split` se contredisent, la route fait foi.
  - Un identifiant invalide est ignoré ; plus de trois panneaux sont tronqués ; un seul panneau = vue normale.
- Chaque action (ouvrir à côté, fermer, échanger, « garder seul », remplacer un panneau) crée une entrée
  d'historique : précédent/suivant restaure la scission. Activer un autre panneau **remplace** l'entrée
  courante (pas de pollution de l'historique).
- Un rechargement garde la scission. Le lien « Copier le lien » reste celui de la page seule.
- Les largeurs des panneaux (fractions, par nombre de panneaux) sont mémorisées dans le navigateur
  (`oriel:split:widths`) ; chaque panneau garde au moins 280 px.
- **Navigation dans une scission** : un clic sur un lien interne, une mention, une entrée de la barre latérale,
  le fil d'Ariane, la recherche ou un lien de retour **remplace la page du panneau actif**. Une
  navigation qui ne passe pas par ces chemins (adresse sans `split`, arrivée « PUSH » depuis une vue
  scindée) est adoptée de la même façon : elle ne casse pas la scission. Les écrans qui ne sont pas des
  pages (accueil, corbeille, réglages…) quittent la scission.

### Ouvrir dans le panneau voisin
- **⌥clic** (Alt+clic) sur un lien de page, une mention, une carte de sous-page, un lien du fil d'Ariane, une
  entrée de la barre latérale ou une ligne de base de données.
- Menu contextuel **« Ouvrir à côté »** sur les mêmes éléments (et sur un panneau d'aperçu latéral).
- **Glisser-déposer** d'une entrée de la barre latérale sur la zone principale : le bord gauche (25 %) d'un
  panneau insère avant, le bord droit (25 %) insère après, le centre remplace ce panneau. Les zones sont
  surlignées pendant le glissement.
- La page s'insère à droite du panneau actif (ou le remplace si trois panneaux sont déjà ouverts : le
  voisin de droite, sinon de gauche). Le nouveau panneau devient actif.
- Fonctions sans effet sur mobile (< 768 px) : l'action ouvre la page normalement.

### Panneaux
- Chaque panneau a un bandeau : icône et titre (un clic active le panneau), puis les boutons
  **Agrandir/Réduire** (le panneau occupe toute la zone, les autres sont masqués mais restent connectés),
  **Échanger** avec le voisin (celui de droite, sinon de gauche), **Garder seul** (ferme les autres) et **Fermer**.
- Le panneau actif a un repère discret (liseré d'accent en haut du bandeau). La barre du haut (fil d'Ariane,
  partage, favori, historique…) se rapporte à lui.
- Poignée entre deux panneaux : glisser pour redimensionner, flèches ← → au clavier (±2 %), double-clic
  pour répartir à parts égales.
- Esc replie le panneau agrandi. Fermer le dernier panneau supplémentaire revient à la vue normale.
- Une page inaccessible ou supprimée affiche l'état « Page introuvable » dans son panneau ; on le ferme normalement.

### Édition en temps réel
- Chaque panneau a son propre éditeur. Le document Yjs est partagé : **une seule connexion par document**,
  même quand la même page est ouverte deux fois ; les deux éditeurs se mettent à jour mutuellement.

### Cohabitation
- **Aperçu latéral** (lignes de base) : il reste une surcouche à droite, au-dessus de la scission. Son bouton
  « Ouvrir à côté » place la ligne dans un panneau ; « Ouvrir en pleine page » remplace le panneau actif.
- **Panneau d'informations** : ancré à droite, il réduit la zone principale, donc la scission se resserre.
- Mode focus et présentation : inchangés (ils concernent le panneau actif).
- **Mobile** : si l'adresse contient `split`, seule la page de la route (panneau actif) est affichée.
- **App macOS** : chaque onglet a sa propre adresse, donc sa propre scission, restaurée avec la session
  (les onglets mémorisent chemin + paramètres).

## Canevas et cartes mentales (vague H, session H1 : lots A et B)

### Type de page « Canevas »
- Un canevas est une **page** (`kind = 'page'`) dont `format.layout = 'canvas'`, fixé à la création et
  **immuable** (le PATCH de `format` ne le connaît pas). Il a donc exactement les droits, le partage
  public, la corbeille, la duplication, les favoris, le déplacement et les sous-pages d'une page.
  Une ligne de base de données ne peut pas être un canevas.
- Création : barre latérale (« Nouveau canevas » dans le menu « + » d'une section et dans le menu
  de « Nouvelle page ») et menu `/` d'une page (« Sous-page canevas », qui insère un lien de sous-page).
  Icône par défaut 🎨, modifiable comme toute icône.
- Contenu : document Yjs de la page (`page:<id>`), avec une seule racine `Y.Map` nommée `canvas`.
  Chaque clé est l'identifiant d'un objet ; sa valeur est l'objet entier, en JSON simple (le dernier
  écrit gagne, objet par objet). Aucun autre type racine, aucun type Yjs imbriqué.
- Validation serveur avant application (comme pour les pages) : objet reconnu et borné
  (`sanitizeCanvasObject`, partagé avec le client), identifiant de clé = identifiant de l'objet,
  5 000 objets au plus, 64 Ko par objet, 8 Mo de JSON au total. Une mise à jour refusée ferme la
  connexion de ce document, sans rien appliquer.
- Recherche : les textes du canevas (formes, textes, notes, cadres, nœuds de cartes) sont indexés ;
  les cartes de pages liées alimentent les rétroliens. Historique : instantanés comme une page ;
  la restauration remplace les objets par ceux de la version.

### Objets
- **Formes** : rectangle, rectangle arrondi, ellipse, losange, triangle, hexagone ; remplissage,
  contour (couleur, épaisseur, tirets), texte centré, taille de police.
- **Texte** libre : taille, gras, alignement, couleur.
- **Notes** : fond coloré, texte riche simple saisi en Markdown léger (`**gras**`, `*italique*`,
  `~~barré~~`, `` `code` ``, `# titre`, `- puce`, `[ ]`/`[x]` case), rendu sans HTML brut.
- **Connecteurs** droits, coudés ou courbes ; chaque extrémité est libre ou accrochée à un objet
  (le tracé suit l'objet) ; extrémités : aucune, flèche, triangle, point, losange ; étiquette.
- **Stylo** et **surligneur** (tracés lissés, surligneur large et translucide) ; **gomme** qui
  efface les tracés touchés.
- **Images et fichiers** : déposés, collés ou choisis ; envoyés par la route de fichiers de l'espace.
  Seules les adresses `/api/files/<id>/<nom>` sont acceptées.
- **Cartes de pages liées** : titre et icône à jour ; un clic ouvre la page. Une page invisible pour
  le lecteur apparaît comme « Page inaccessible ».
- **Cadres** nommés (voir présentation).
- **Cartes mentales** (lot B, ci-dessous).

### Manipulation
- Outils : sélection (V), main (H, ou espace maintenu), forme (R, O pour ellipse), texte (T),
  note (N), connecteur (C), stylo (P), surligneur (M), gomme (E), cadre (F), carte mentale (K).
- Sélection par clic, Maj+clic, rectangle de sélection ; ⌘A tout sélectionner ; Échap désélectionne.
- Déplacement à la souris ou aux flèches (Maj : pas de 10) ; redimensionnement par 8 poignées
  (Maj : proportions gardées).
- **Aimantation** aux bords et centres des objets voisins, avec repères ; Alt la désactive.
- **Alignement** (gauche, centre, droite, haut, milieu, bas) et **répartition** horizontale/verticale.
- **Ordre** : premier plan / arrière-plan.
- **Groupes** (⌘G, ⌘⇧G pour dégrouper) : un clic sélectionne tout le groupe.
- **Verrouillage** (⌘⇧L) : un objet verrouillé ne se déplace, ne se redimensionne, ne se modifie ni
  ne se supprime plus, et le rectangle de sélection l'ignore ; un clic le sélectionne (cadre en
  pointillés) pour le déverrouiller.
- **Zoom** (molette avec ⌘/Ctrl, pincement, ⌘+ / ⌘−, ⌘0 = 100 %, ⇧1 = tout afficher, ⇧2 = sélection),
  **panoramique** (molette, main, espace) ; mini-commandes de zoom en bas à droite.
- **Annuler/rétablir** (⌘Z, ⌘⇧Z) : UndoManager de Yjs, limité aux modifications locales.
- **Copier/couper/coller/dupliquer** (⌘C, ⌘X, ⌘V, ⌘D) dans le canevas, entre canevas, et coller une
  image ou du texte (une liste à puces collée devient une carte mentale).
- Présence : pointeurs des autres personnes, avec leur nom (jamais pour les visiteurs publics).
- Glisser-déposer de fichiers sur le canevas : images et fichiers envoyés à l'endroit du dépôt.

### Cadres et présentation
- Un cadre est une zone nommée ; déplacer un cadre déplace les objets qu'il contient.
- Panneau « Cadres » : liste ordonnée, renommer, réordonner par glisser ou flèches, aller au cadre.
- **Présentation** : plein écran, un cadre par diapositive dans l'ordre du panneau ; → / espace /
  Page suivante pour avancer, ← / Page précédente pour reculer, Échap pour quitter.
- **Bloc « Cadre de canevas »** (menu `/` d'une page) : choisit un canevas puis un cadre (ou tout le
  canevas) et l'affiche en lecture seule, à jour en temps réel ; un clic ouvre le canevas. Un canevas
  invisible pour le lecteur affiche « Cadre inaccessible ».

### Export
- PNG (×2) et SVG du canevas entier, de la sélection ou d'un cadre. Le SVG est construit par
  l'application à partir des objets (aucun SVG fourni par l'utilisateur), images incluses.

### Modèles de départ
- Canevas vide, **storyboard** (6 plans avec cadre d'image, plan, durée, action), **moodboard**
  (grille d'images et de notes de références), **plan de tournage** (séquences × lieux × horaires),
  **Gantt simple** (semaines × tâches, barres colorées). Proposés tant que le canevas est vide.

### Lecture publique et thèmes
- Un canevas publié se lit sans compte, en lecture seule (zoom, panoramique, présentation).
- Couleurs nommées (`gray`, `blue`…) rendues avec la palette du thème : lisibles en mode sombre.

### Cartes mentales (lot B)
- Objet « carte mentale » : un arbre de nœuds (texte court), positionné par une mise en page pure
  (`layoutMindmap`) : disposition **droite**, **gauche** ou **équilibrée** ; styles : **classique**
  (branches courbes colorées), **contour** (nœuds encadrés, liens droits), **organigramme** (liens
  coudés), **minimal** (texte souligné).
- Clavier, nœud sélectionné : **Tab** ajoute un enfant, **Entrée** un frère, **Suppr/Retour arrière**
  retire le nœud (et sa branche ; la racine supprime la carte), **F2** ou saisie directe modifie le
  texte, **espace** replie/déplie la branche, flèches pour naviguer.
- **Replier** une branche masque ses descendants et affiche leur nombre.
- **Import** : coller une liste à puces ou du Markdown (titres et puces imbriquées) crée une carte.
  **Export** : « Copier en liste » produit une liste Markdown imbriquée.
- Bornes : 500 nœuds, profondeur 12, 200 caractères par nœud.

## Finitions de l'éditeur (vague H, session H5 : lot F)

### Notes de bas de page
- Insertion : menu `/` › « Note de bas de page », ou raccourci **⌘⌥F** (Ctrl+Alt+F). Un appel de note
  (petit chiffre en exposant) est inséré au curseur dans le fil du texte ; le curseur passe dans la
  zone de saisie de la note, en bas de la page.
- **Numérotation automatique, dans l'ordre du document** : l'ajout, la suppression ou le déplacement
  d'un appel renumérote toutes les notes, en direct et chez toutes les personnes connectées.
- Une note est un **texte court** (1 000 caractères au plus, sans mise en forme). Elle est stockée dans
  la propriété `note` de l'appel, donc synchronisée en temps réel comme le reste de la page.
- **Au survol** d'un appel, une bulle affiche le contenu de la note.
- **Liste en bas de page** : visible dès qu'il y a au moins une note, sous le contenu. Chaque ligne
  porte son numéro, son texte et un bouton « ↩ ». Les personnes qui peuvent modifier la page y
  modifient le texte directement ; les autres le lisent (pages publiques et verrouillées comprises).
- **Cliquable dans les deux sens** : un clic sur un appel fait défiler jusqu'à sa note (mise en
  évidence brève) ; « ↩ » ramène à l'appel.
- **Export** : Markdown `[^1]` dans le texte et `[^1]: texte` en fin de document ; HTML : appels
  reliés aux notes d'une section « Notes » ; PDF (impression) : la liste est imprimée sous le contenu.
- **Import / collage Markdown** : `[^id]` et `[^id]: texte` deviennent des notes, numérotées par ordre
  d'apparition ; une référence sans définition reste du texte. Une définition jamais référencée reste
  un paragraphe (rien n'est perdu).
- Limites : au plus 500 notes affichées dans la liste ; pas de note dans un bloc synchronisé (le bloc
  a sa propre zone) ni dans un titre de page.

### Métadonnées par bloc
- Au **survol de la poignée** d'un bloc (et dans son menu), une bulle indique **qui l'a créé et qui l'a
  modifié en dernier, et quand** (« Créé par Sam, le 12/10 à 14:03 · modifié par Léa, il y a 5 min »).
- Les données sont rangées **côté serveur, hors du document Yjs** (le document n'est pas alourdi, un
  export ou une copie ne les emporte pas). Elles sont alimentées par les mises à jour reçues sur le
  canal collaboratif : chaque modification faite par une personne connectée est rattachée à son
  auteur, au plus tard à la prochaine sauvegarde du document.
- Un bloc créé avant l'activation du suivi, ou par un import, apparaît avec « Origine inconnue » tant
  qu'il n'est pas modifié ; seules les modifications ultérieures sont attribuées.
- **Coût borné** : une ligne par bloc de la page au plus (20 000 par page), les lignes des blocs
  supprimés sont retirées à la sauvegarde, au plus 2 000 blocs suivis par fenêtre de sauvegarde, 200
  éléments modifiés examinés par transaction. Dans un groupe de plus de 5 000 blocs frères, les
  créations ne sont pas attribuées (le coût du suivi resterait linéaire). Aucun historique : seules la
  dernière création et la dernière modification sont conservées. Les blocs des blocs synchronisés
  (autre document) et des pages canevas ne sont pas suivis.
- **Confidentialité** : `GET /api/pages/:pid/blocks/:bid/meta` passe par le contrôle d'accès de la
  page (404 si elle n'est pas visible). Les visiteurs d'une page publiée n'y ont pas accès : ni la
  poignée, ni le serveur ne leur donnent d'identité. Le nom affiché est celui du profil de la personne.
- Les modifications de visiteurs anonymes (impossibles : lecture seule) et les opérations serveur
  sans utilisateur ne sont attribuées à personne.

### Aperçu Typst dans les blocs de code
- Un langage **Typst** (`typst`, alias `typ`) s'ajoute au sélecteur des blocs de code, avec la bascule
  **Code / Aperçu / Les deux** de Mermaid et ABC (propriété `view`, synchronisée).
- Le compilateur (WebAssembly, `typst-wasm`) et ses polices sont **chargés à la demande**, au premier
  bloc affiché, et tournent dans un **Web Worker** : un document trop long est interrompu sans figer
  la page.
- **Mise en page** : l'aperçu part d'une page large de 16 cm dont la hauteur suit le contenu (une page
  A4 entière serait presque vide) ; un `#set page(…)` du document l'emporte. Les numéros de ligne des
  erreurs sont ceux du code affiché.
- **Bornes** : source de 20 000 caractères au plus, 8 secondes de compilation (le worker est arrêté
  puis recréé), sortie SVG de 3 Mo au plus. Au-delà, un message en français. Le premier affichage
  télécharge le moteur (environ 28 Mo) et les polices (environ 3 Mo) : il peut prendre quelques secondes.
- **Isolation** : aucun accès réseau ni fichier (`#import "@preview/…"`, `image("…")`, `read` refusés
  avec un message). La sortie SVG est **reconstruite par la liste blanche** commune (aucun script,
  `foreignObject`, lien ni URL externe) et insérée dans un Shadow DOM. Les polices (Libertinus Serif,
  New Computer Modern, DejaVu Sans Mono) sont servies par l'application elle-même.
- Export : le code est exporté tel quel ; l'aperçu est imprimé en PDF et inclus dans l'export HTML.

### Exports d'une page
- Menu « … » de la page › **Exporter** : Markdown, **HTML autonome**, **Image PNG**, PDF.
- **HTML autonome** : un seul fichier, styles intégrés, **aucun script** (le contenu est assaini :
  pas de `<script>`, `<iframe>`, `<object>`, attributs `on*`, URL `javascript:`). Les images envoyées
  dans l'espace sont **incluses** (adresses `data:`) jusqu'à 3 Mo par image et 25 Mo au total ; au-delà
  elles restent **liées** par leur adresse absolue. Équations en MathML, notes de bas de page en liste,
  diagrammes Mermaid / ABC / Typst en SVG assaini.
- **Image PNG** : rendu côté navigateur du même HTML, en thème clair, 800 px de large (densité ×2),
  hauteur limitée à 16 000 px (message si la page est plus longue). Aucun envoi au serveur.
