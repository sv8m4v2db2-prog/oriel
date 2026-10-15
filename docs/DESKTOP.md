# Oriel pour macOS

L'application macOS est une coque **Electron** autour du client web d’Oriel. Elle fonctionne de
deux façons, au choix au premier lancement :

| Mode | Principe | Données |
|---|---|---|
| **Distant** | L'app affiche votre serveur Oriel (VPS, voir [DEPLOY.md](DEPLOY.md)) : collaboration en temps réel avec votre équipe | Sur le serveur (+ cache hors ligne local) |
| **Local** | Un serveur Oriel intégré démarre sur le Mac (`127.0.0.1`, invisible depuis le réseau), sans compte ni connexion | `~/Library/Application Support/Oriel/data` |

Code : [`desktop/`](../desktop) (`src/main.ts` processus principal, `src/preload.ts`, pages locales
`src/setup.html`, `src/offline.html`, `src/tabs.html` (barre d'onglets) et `src/quick.html` (recherche
rapide), configuration electron-builder dans `desktop/package.json`). Logique pure testable, sans
Electron : `session.ts`, `accelerator.ts`, `validate.ts`, `tabsLogic.ts`, `urls.ts` (tests dans
`desktop/test/`, `npm test -w desktop`).

---

## 1. Construire le .dmg depuis les sources

Prérequis : un Mac (Apple Silicon ou Intel) avec **Node.js ≥ 22.13** et `git`. Xcode n'est pas
nécessaire. Une connexion internet est requise la première fois (dépendances npm, binaires Electron
pour chaque architecture).

```bash
git clone <url-du-dépôt-oriel> oriel
cd oriel
npm ci
npm run desktop:dist
```

`desktop:dist` compile le client web (`web/dist`) et le serveur (`server/dist/server.cjs`), les
embarque dans l'application, puis produit dans **`desktop/release/`** :

| Fichier | Usage |
|---|---|
| `Oriel-0.1.0-arm64.dmg` | Macs Apple Silicon (M1 et suivants) |
| `Oriel-0.1.0-x64.dmg` | Macs Intel |
| `Oriel-0.1.0-arm64.zip`, `Oriel-0.1.0-x64.zip` | Mêmes applications, en archive |
| `mac-arm64/Oriel.app`, `mac/Oriel.app` | Applications décompressées |

Variantes (depuis `desktop/`, après `npm run build` à la racine) :

```bash
npx electron-builder --mac dmg --arm64       # une seule architecture
npm run pack                                  # .app seule (rapide, pour tester)
```

### Développement

```bash
npm run desktop:dev
```

construit web + serveur puis lance Electron sur `desktop/`. En développement, l'app utilise un profil
séparé, `~/Library/Application Support/Oriel (dev)`, et ne touche jamais aux données de
l'application installée. Les journaux du serveur local s'affichent aussi dans le terminal.

Autres commandes du paquet `desktop` : `npm run build -w desktop` (esbuild → `desktop/dist`),
`npm run typecheck -w desktop`, `npm run icon -w desktop` (régénère `build/icon.png` et
`build/icon.icns` depuis `build/icon.svg`).

---

## 2. Installer et ouvrir une application non signée

Par défaut, l'application n'est **pas signée avec un certificat Apple Developer ID** (elle reçoit
seulement une signature « ad hoc », sans identité). macOS bloque donc son premier lancement s'il a été
téléchargé :

1. Ouvrez le `.dmg` et glissez **Oriel** dans **Applications**.
2. Premier lancement :
   - **macOS 14 et antérieurs** : dans le Finder, **clic droit (ou Ctrl-clic) sur Oriel › Ouvrir**,
     puis **Ouvrir** dans la fenêtre d'avertissement ;
   - **macOS 15 et suivants** : lancez l'app une fois (macOS la bloque), puis
     **Réglages Système › Confidentialité et sécurité**, section Sécurité : **Ouvrir quand même**,
     et confirmez.
3. Alternative en une commande (retire l'attribut de quarantaine) :
   ```bash
   xattr -dr com.apple.quarantine /Applications/Oriel.app
   ```

Les lancements suivants se font normalement. Une app construite sur votre propre Mac (sans
téléchargement) n'est pas mise en quarantaine.

---

## 3. Premier lancement : choisir le mode

L'écran **Bienvenue dans Oriel** propose deux cartes :

- **Se connecter à un serveur** — saisissez l'adresse (ex. `https://notes.mondomaine.fr` ; le
  `https://` est ajouté si vous l'omettez). **Tester** interroge `<adresse>/api/health` et affiche la
  version du serveur ; **Se connecter** mémorise l'adresse et ouvre l'espace. Les serveurs récents sont
  proposés sous le champ.
- **Mode local** — démarre le serveur intégré. Vous êtes connecté automatiquement (utilisateur « Moi »)
  et un espace de travail est créé au premier démarrage.

Le choix est enregistré ; l'écran ne réapparaît plus au lancement.

### Changer de serveur ou de mode

Menu **Oriel › Changer de serveur…** (ou le Dock, clic droit). Les fenêtres ouvertes se ferment
et rouvrent sur le nouveau serveur. Passer du mode local à un serveur **ne supprime pas** les données
locales : elles réapparaissent si vous revenez au mode local. (Il n'y a pas de synchronisation entre
les données locales et un serveur.)

---

## 4. Utilisation

### Menus

| Menu | Commandes |
|---|---|
| **Oriel** | À propos · **Réglages… ⌘,** (réglages de l'espace courant dans l'app web) · Changer de serveur… · Masquer ⌘H · Quitter ⌘Q |
| **Édition** | Annuler ⌘Z, Rétablir ⇧⌘Z, Couper, Copier, Coller, Coller et adapter le style, Tout sélectionner · **Définition du mot sélectionné ⌃⌘D** · **Vérifier l'orthographe** (bascule) |
| **Affichage** | Recharger ⌘R · Forcer le rechargement ⇧⌘R · Zoom (⌘0, ⌘+, ⌘−) · Plein écran ⌃⌘F · Outils de développement ⌥⌘I |
| **Navigation** | Précédent ⌘[ · Suivant ⌘] · Rechercher ⌘K · **Recherche rapide…** (ouvre la fenêtre de §4.2 sans le raccourci système) |
| **Fenêtre** | **Nouvelle fenêtre ⇧⌘N** · **Nouvel onglet ⌘T** · **Fermer l'onglet ⌘W** · Fermer la fenêtre ⇧⌘W · **Rouvrir l'onglet fermé ⇧⌘T** · Onglet précédent ⇧⌘[ / suivant ⇧⌘] · Aller à l'onglet ⌘1…⌘9 · Déplacer l'onglet dans une nouvelle fenêtre · Placer dans le Dock ⌘M · Dernier téléchargement dans le Finder · liste des fenêtres |
| **Aide** | Documentation · Afficher les données locales / les journaux dans le Finder |

Les raccourcis de l'app web (⌘K, ⌘N nouvelle page, ⌘\\ barre latérale, ⌘⇧L thème…) fonctionnent
comme dans le navigateur. Clic droit : correcteur orthographique, copier/coller, liens, images.

### Fenêtres et liens

- Plusieurs fenêtres possibles (⇧⌘N) ; taille et position sont mémorisées. Chaque fenêtre contient
  des **onglets** (voir §4.1).
- Fermer la dernière fenêtre laisse l'app ouverte dans le Dock (convention macOS) ; un clic sur
  l'icône rouvre une fenêtre. Une seule instance de l'app tourne à la fois.
- Les liens vers d'autres sites s'ouvrent dans votre **navigateur par défaut**. Les liens internes
  s'ouvrent dans la page courante ; **⌘clic** (ou clic droit › « Ouvrir dans un nouvel onglet ») les
  ouvre dans un nouvel onglet, `target="_blank"` aussi. « Ouvrir dans une nouvelle fenêtre » reste
  disponible au clic droit.

### 4.1 Onglets

Chaque fenêtre affiche une **barre d'onglets native** (vue Electron dédiée, au-dessus de la page)
puis la page de l'onglet actif. Les feux tricolores restent à gauche de la barre.

| Geste | Effet |
|---|---|
| ⌘T, bouton **+** | Nouvel onglet, sur l'accueil de l'espace de l'onglet courant |
| ⌘W | Ferme l'onglet ; le dernier onglet d'une fenêtre ferme la fenêtre. ⇧⌘W ferme la fenêtre |
| ⇧⌘T | Rouvre le dernier onglet fermé (25 derniers, adresses internes uniquement) |
| ⌘1 … ⌘8, ⌘9 | Va à l'onglet n° 1…8 ; ⌘9 va au dernier |
| ⇧⌘[ , ⇧⌘] | Onglet précédent / suivant (circulaire) |
| ⌘clic sur un lien interne | Ouvre le lien dans un nouvel onglet en arrière-plan |
| ⌥clic sur un lien interne | Ouvre la page dans le panneau voisin de la **vue scindée** de l'onglet (voir SPEC, « Vue scindée »). La scission fait partie de l'adresse de l'onglet : chaque onglet a la sienne, restaurée avec la session. Aucun pont IPC supplémentaire |
| Glisser un onglet | Le réordonne dans la barre ; le lâcher bien en dehors de la barre le **détache** dans une nouvelle fenêtre |
| Clic droit sur un onglet | Couleur · Dupliquer · Déplacer dans une nouvelle fenêtre · Fermer · Fermer les autres · Fermer les onglets à droite |

La **couleur** (neuf teintes) est un repère visuel mémorisé avec la session ; elle ne change pas la
page. Le titre de l'onglet est celui de la page. Les « groupes d'onglets » ne sont pas implémentés :
la couleur sert de regroupement visuel.

Chaque onglet applique **les mêmes gardes** que l'ancienne fenêtre unique : navigation hors du serveur
→ navigateur par défaut (redirections HTTP comprises), `window.open` : onglet ou fenêtre Oriel
pour le serveur, navigateur pour http(s)/mailto/tel, refus pour tout le reste (aucune fenêtre
enfant, pas même `about:blank`), détection de panne (page « Serveur
injoignable » dans l'onglet), blocage des permissions, `contextIsolation` + `sandbox`, preload limité
aux pages du serveur, pas de `webview`.

**Restauration de la session** : à la fermeture et à chaque changement, l'app mémorise (dans
`config.json`, clé `session`) pour chaque fenêtre les **chemins internes** (`/w/…/p/…`, sans origine,
donc valides si le port du mode local change), l'onglet actif, la couleur et la géométrie. Au
lancement suivant, ces fenêtres et onglets sont rouverts. Ne sont jamais mémorisés : les adresses
d'autres sites, les pages de connexion, d'invitation et de réinitialisation du mot de passe (elles
contiennent des jetons). Une session enregistrée pour un autre serveur ou un autre mode est ignorée.
Désactivable dans **Réglages › Application** (« Restaurer les onglets au lancement »).

### 4.2 Recherche rapide globale

Un **raccourci système** (par défaut **⌃⌥Espace**, modifiable dans Réglages › Application, désactivable)
ouvre une petite fenêtre sans cadre, même si Oriel est en arrière-plan. Sont refusés : ⌘ + une
touche seule (⌘C, ⌘V, ⌘Q…, utilisés par toutes les apps), ⌥ (+ ⇧) + un caractère (touches mortes,
caractères spéciaux) et les raccourcis système (⇧⌘3/4/5, ⌃⌘Q, ⌃Espace…). La fenêtre propose :

- champ de recherche ; sans saisie, les pages récemment visitées ; sinon les pages dont le titre ou
  le contenu correspond (recherche de l'espace de la fenêtre active) ;
- ↑ ↓ pour choisir, **Entrée** ouvre la page dans la fenêtre principale (une fenêtre est créée si
  aucune n'est ouverte) ;
- **Créer « … »** (dernière ligne) crée une page **privée** à la racine de l'espace et l'ouvre ;
- la fenêtre se ferme avec **Échap** ou dès qu'elle perd le focus.

Elle utilise la session de l'app (si vous n'êtes pas connecté, elle l'indique). La recherche est
faite par le processus principal vers le serveur configuré uniquement ; la page de la fenêtre est une
page locale à part, sans accès au réseau ni aux cookies.

### 4.3 Pastille du Dock

L'app web envoie le nombre total de notifications **non lues** (tous espaces confondus) ; l'app
l'affiche sur l'icône du Dock (« 99+ » au-delà de 99) et l'efface à zéro ou à la déconnexion. Le pont
valide l'entier (0 à 99 999) ; il est désactivable dans Réglages › Application.

### 4.4 Correcteur orthographique

La vérification est active dans les zones de saisie et le menu contextuel propose, sur un mot
souligné, jusqu'à cinq **suggestions**, **Ajouter au dictionnaire** et la bascule **Vérifier
l'orthographe** (aussi dans Édition). Sur **macOS**, c'est le correcteur du système qui est utilisé et
il **détecte la langue tout seul** : le choix des langues n'a pas d'effet et n'est donc pas proposé ;
les langues se règlent dans Réglages Système › Clavier › Dictionnaire (et « Corriger l'orthographe
automatiquement »). Sur les autres plateformes (Windows, Linux), le sous-menu **Langues** du clic droit
et la liste de Réglages › Application pilotent les dictionnaires Chromium (`spellLanguages`).

### 4.5 Intégration macOS

- **Définition** : sur une sélection de texte, clic droit › « Consulter « mot » » (ou ⌃⌘D) affiche la
  fenêtre de définition du dictionnaire système (`showDefinitionForSelection`).
- **Téléchargements natifs** : un fichier téléchargé depuis l'app ouvre la **fenêtre d'enregistrement**
  macOS (dossier Téléchargements proposé), la **progression** s'affiche sur l'icône du Dock, l'icône
  rebondit et le fichier apparaît dans la pile Téléchargements à la fin, une notification
  propose **Afficher dans le Finder** (aussi : Fenêtre › Dernier téléchargement dans le Finder).
  **Seules les adresses de l'instance Oriel configurée** (y compris `blob:` créés par ses pages)
  sont téléchargées ; toute autre origine, ou une redirection vers une autre origine, est refusée.

### Hors ligne (mode distant)

Si le serveur est injoignable au chargement (pas de réseau, DNS, certificat, serveur arrêté, erreur
502/503/504 du proxy), l'app affiche **Serveur injoignable** avec la cause, les boutons **Réessayer**
et **Changer de serveur**, et retente automatiquement (5 s, 10 s, 20 s puis toutes les 30 s, et
immédiatement au retour du réseau). Une fois la page chargée, les coupures passagères sont gérées par
l'app web (indicateur « Hors ligne », modifications conservées localement puis synchronisées).

Les certificats auto-signés ne sont pas acceptés : utilisez un certificat valide (Let's Encrypt via
Caddy, voir DEPLOY.md).

---

## 5. Mode local : emplacement des données

| Élément | Emplacement |
|---|---|
| Base SQLite + fichiers envoyés | `~/Library/Application Support/Oriel/data/` (`oriel.db`, `uploads/`) |
| Réglages de l'app | `~/Library/Application Support/Oriel/config.json` |
| Journal du serveur local | `~/Library/Logs/Oriel/server.log` |
| Cache du client (hors ligne, préférences) | `~/Library/Application Support/Oriel/` (dossiers Chromium) |

Le serveur intégré écoute uniquement sur `127.0.0.1`, sur un port choisi au premier démarrage puis
réutilisé (l'adresse locale reste stable, ce qui préserve le cache du client). Il s'arrête proprement
quand vous quittez l'app.

**Sauvegarde** : Time Machine couvre ce dossier. Pour une copie manuelle, **quittez Oriel** puis
copiez `~/Library/Application Support/Oriel/data`.

Si le serveur local ne démarre pas, une boîte de dialogue affiche la fin du journal avec
**Réessayer**, **Changer de mode…** et **Quitter** ; le journal complet est accessible par
**Aide › Afficher les journaux dans le Finder**.

### config.json

```json
{
  "mode": "remote",
  "serverUrl": "https://notes.mondomaine.fr",
  "recentServers": ["https://notes.mondomaine.fr"],
  "localPort": 52814,
  "windowBounds": { "x": 120, "y": 80, "width": 1280, "height": 840 },
  "quickSearch": { "enabled": true, "accelerator": "Control+Alt+Space" },
  "spellcheck": true,
  "dockBadge": true,
  "restoreSession": true,
  "session": {
    "origin": "https://notes.mondomaine.fr",
    "windows": [
      { "active": 0, "tabs": [{ "path": "/w/…/p/…", "color": "blue" }], "bounds": { "x": 120, "y": 80, "width": 1280, "height": 840 } }
    ]
  }
}
```

`session.origin` vaut `local` en mode local. Les clés inconnues ou invalides sont ignorées au chargement.

Supprimer ce fichier (app fermée) ramène à l'écran de premier lancement, sans toucher aux données.

---

## 6. Signature et notarisation (facultatif)

Pour distribuer l'app sans avertissement Gatekeeper, il faut un compte **Apple Developer** (payant)
et un certificat **Developer ID Application**. La configuration contient déjà le *hardened runtime*
et les droits nécessaires à Electron (`desktop/build/entitlements.mac.plist`).

1. Installez le certificat dans le trousseau, ou fournissez-le à electron-builder :
   ```bash
   export CSC_LINK=/chemin/vers/DeveloperID.p12     # ou base64 du .p12
   export CSC_KEY_PASSWORD='…'
   ```
2. Identifiants de notarisation (au choix) :
   ```bash
   # Identifiant Apple + mot de passe pour app
   export APPLE_ID=vous@exemple.fr
   export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
   export APPLE_TEAM_ID=ABCDE12345
   # ou clé d'API App Store Connect
   export APPLE_API_KEY=/chemin/AuthKey_XXXXXXXXXX.p8
   export APPLE_API_KEY_ID=XXXXXXXXXX
   export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
3. Construisez en remplaçant l'identité `null` par la vôtre :
   ```bash
   npm run build
   cd desktop
   node build.mjs --check-resources --minify
   npx electron-builder --mac --publish never \
     -c.mac.identity="Developer ID Application: Votre Nom (ABCDE12345)"
   ```
   electron-builder signe l'app, la soumet au service de notarisation d'Apple et agrafe le ticket.
4. Vérification :
   ```bash
   spctl -a -vvv -t exec desktop/release/mac-arm64/Oriel.app
   xcrun stapler validate desktop/release/mac-arm64/Oriel.app
   ```

---

## 7. Désinstaller

1. Quittez Oriel (⌘Q) et supprimez `/Applications/Oriel.app`.
2. Pour effacer aussi les réglages, le cache et **les données du mode local** (irréversible ;
   sauvegardez `data/` d'abord si besoin) :
   ```bash
   rm -rf ~/Library/Application\ Support/Oriel
   rm -rf ~/Library/Logs/Oriel
   rm -rf ~/Library/Saved\ Application\ State/app.oriel.desktop.savedState
   rm -f ~/Library/Preferences/app.oriel.desktop.plist
   ```

Les données d'un serveur distant ne sont pas concernées.

---

## 8. Pour les développeurs du client web

Le preload expose, sur les pages du serveur Oriel :

```ts
window.orielDesktop = {
  platform: 'darwin',
  isDesktop: true,
  mode: 'remote' | 'local',
  openSetup(): void,   // ouvre l'écran « Changer de serveur »
  // Ajouts « onglets / intégration » (absents d'un preload plus ancien : tester avant d'appeler)
  hasTabs?: true,
  setBadge?(count: number): void,                     // entier 0…99 999, 0 efface la pastille
  getPrefs?(): Promise<DesktopPrefs>,                 // réglages propres à l'app
  setPrefs?(patch: Partial<DesktopPrefs>): Promise<{ ok: boolean; prefs: DesktopPrefs; error?: string }>,
};

interface DesktopPrefs {
  quickSearchEnabled: boolean;
  quickSearchShortcut: string;       // accélérateur Electron, ex. 'Control+Alt+Space'
  dockBadge: boolean;
  spellcheck: boolean;
  restoreSession: boolean;
  spellLanguages: string[] | null;   // null sur macOS (détection automatique)
  availableSpellLanguages: string[]; // vide sur macOS
  platform: string;
}
```

Canaux IPC (tous revérifient l'expéditeur : fenêtre connue, frame principal dont l'**URL et l'origine
réelle** sont celles du serveur configuré (un document à origine opaque, CSP `sandbox`, est refusé),
ou page locale attendue ; chaque argument est typé et borné dans `desktop/src/validate.ts`) :

| Canal | Sens | Appelant autorisé | Argument validé |
|---|---|---|---|
| `oriel:badge:set` | envoi | page du serveur | entier 0…99 999 |
| `oriel:prefs:get` / `:set` | invoke | page du serveur | patch : booléens, accélérateur (touches autorisées, ≥ 1 modificateur), liste de langues `xx-XX` |
| `oriel:tabs:*` (état, sélection, fermeture, création, déplacement, détachement, menu) | invoke/envoi | barre d'onglets de **sa** fenêtre | identifiant d'onglet connu, index entier, coordonnées finies |
| `oriel:quick:*` (recherche, ouvrir, créer, fermer) | invoke/envoi | page locale de la recherche rapide | texte ≤ 200 car., identifiants `[A-Za-z0-9_-]{1,80}` |

Aucun contenu distant n'obtient le preload des pages locales (barre d'onglets, recherche rapide) et
elles ne chargent aucun contenu distant.

- Barre de titre intégrée (`titleBarStyle: 'hiddenInset'`) : les feux tricolores sont placés à
  `x = 16, y = 16` px et occupent environ 70 × 14 px. Prévoir une zone de glissement
  `-webkit-app-region: drag` d'environ 40 px de haut en haut de la barre latérale / barre supérieure,
  une marge gauche d'environ 80 px quand la barre latérale est repliée, et `no-drag` sur les éléments
  interactifs.
- **Oriel › Réglages…** navigue vers `/w/<espace>/settings` (History API + `popstate`).
- **Navigation › Rechercher** envoie un `keydown` ⌘K à la page ; au clavier, ⌘K arrive directement à
  la page. ⌘[ et ⌘] sont gérés par le menu (historique de la fenêtre) : si l'app web les gère aussi,
  elle doit appeler `preventDefault()` pour éviter un double retour arrière.
