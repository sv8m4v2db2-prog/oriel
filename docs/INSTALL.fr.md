# Installer Oriel

*[English version](INSTALL.md)*

Ce guide couvre toutes les façons de faire tourner Oriel : sur un serveur Linux (avec Docker et Caddy,
ou avec nginx et systemd), en application macOS et sur un poste de développement. Il se termine par
la référence des variables de configuration et une section de dépannage.

Toutes les données d'une instance (une base SQLite et les fichiers envoyés) tiennent dans un seul
dossier de données : sauvegardes et déménagements restent simples.

```
 Navigateurs / app macOS
          │  HTTPS (443) + WebSockets
          ▼
 ┌─────────────────┐      ┌───────────────────────────────┐
 │ Reverse proxy   │ ───▶ │ Oriel (Node.js, port 3000)    │
 │ (Caddy, nginx…) │      │ API · temps réel · client web │
 └─────────────────┘      └──────────────┬────────────────┘
                                         │
                              dossier de données (DATA_DIR)
                              oriel.db + uploads/
```

## Sommaire

1. [Prérequis](#1-prérequis)
2. [VPS avec Docker et Caddy (recommandé)](#2-vps-avec-docker-et-caddy-recommandé)
3. [VPS avec nginx et systemd (sans Docker)](#3-vps-avec-nginx-et-systemd-sans-docker)
4. [Application macOS](#4-application-macos)
5. [Développement local](#5-développement-local)
6. [Variables d'environnement](#6-variables-denvironnement)
7. [Premier compte administrateur et modes d'inscription](#7-premier-compte-administrateur-et-modes-dinscription)
8. [E-mails (SMTP)](#8-e-mails-smtp)
9. [Clé IA (Brief du jour)](#9-clé-ia-brief-du-jour)
10. [Cartes et géocodage](#10-cartes-et-géocodage)
11. [Authentification unique (OIDC)](#11-authentification-unique-oidc)
12. [Double authentification et clés d'accès](#12-double-authentification-et-clés-daccès)
13. [Sauvegarde et restauration](#13-sauvegarde-et-restauration)
14. [Mise à jour](#14-mise-à-jour)
15. [Serveur MCP (Claude)](#15-serveur-mcp-claude)
16. [Dépannage](#16-dépannage)

---

## 1. Prérequis

| | Serveur (VPS) | App macOS / développement |
|---|---|---|
| Système | Debian 12/13 ou Ubuntu 22.04/24.04, x86-64 ou ARM64 | macOS (Apple Silicon ou Intel) pour l'app ; macOS ou Linux pour le développement |
| Ressources | 1 vCPU, **2 Go de RAM** (1 Go + fichier d'échange suffit), 10 Go de disque | — |
| Logiciels | Docker Engine + plugin Compose (installés par le script), **ou** Node.js ≥ 22.13 (Node 24 LTS conseillé) | Node.js ≥ 22.13, `git` |
| Réseau | Un nom de domaine (ex. `notes.example.com`) avec un enregistrement **A** (et **AAAA** si le serveur a une IPv6) vers le serveur ; ports **80** et **443** ouverts | Accès à internet pour le premier `npm ci` |

Créez l'enregistrement DNS **avant** l'installation : l'autorité de certification le vérifie. Depuis
votre poste :

```bash
dig +short notes.example.com
```

La commande doit afficher l'adresse IP du serveur.

---

## 2. VPS avec Docker et Caddy (recommandé)

Caddy gère le HTTPS avec un certificat Let's Encrypt automatique et relaie les requêtes (WebSockets
compris) vers Oriel. Seuls les ports 80 et 443 sont publiés ; Oriel n'est pas joignable de l'extérieur.

### 2.1 Installation rapide

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <url-du-dépôt> oriel
cd oriel
sudo ./deploy/install.sh
```

Le script peut être relancé sans risque. Il :

1. vérifie le système (distribution, mémoire — il propose un fichier d'échange de 2 Go si besoin —,
   espace disque, ports 80/443 libres) ;
2. installe **Docker Engine** et le plugin **Compose** depuis le dépôt APT officiel de Docker
   (paquets signés, aucun `curl | sh`) ;
3. demande le **nom de domaine** et l'**e-mail Let's Encrypt**, et écrit `deploy/.env` (droits 600) ;
4. vérifie que le domaine pointe vers le serveur ;
5. propose d'activer le pare-feu **ufw** (SSH, 80/tcp, 443/tcp, 443/udp) ;
6. construit l'image et démarre les conteneurs (`docker compose up -d --build`) ;
7. attend que `https://<domaine>/api/health` réponde ;
8. propose une **sauvegarde quotidienne** (cron à 3 h 15, 14 archives conservées) ;
9. affiche l'URL et les étapes suivantes.

Installation non interactive :

```bash
sudo ./deploy/install.sh --domain notes.example.com --email admin@example.com \
  --signup first-user --firewall --backup-cron --yes
```

`./deploy/install.sh --help` liste toutes les options.

Ouvrez ensuite `https://notes.example.com` et **créez tout de suite le premier compte** (il devient
administrateur de l'instance, voir la [section 7](#7-premier-compte-administrateur-et-modes-dinscription)).

### 2.2 Installation manuelle avec Docker

1. Installez Docker Engine et le plugin Compose en suivant la documentation de Docker pour
   [Debian](https://docs.docker.com/engine/install/debian/) ou
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
2. Récupérez le code et configurez :
   ```bash
   git clone <url-du-dépôt> oriel && cd oriel
   cp deploy/.env.example deploy/.env
   chmod 600 deploy/.env
   nano deploy/.env            # au minimum DOMAIN et ACME_EMAIL
   ```
3. Démarrez :
   ```bash
   cd deploy
   sudo docker compose up -d --build
   sudo docker compose ps      # « oriel » doit passer « healthy »
   curl -fsS https://notes.example.com/api/health
   ```

La première construction prend quelques minutes. L'image finale ne contient que Node.js, le serveur
compilé et le client web, et s'exécute avec l'utilisateur non privilégié `node`. Les données sont dans
le volume Docker `oriel_oriel-data`, monté sur `/data`.

Les commandes `docker compose` de ce guide s'exécutent depuis `deploy/` (ou depuis la racine du dépôt
avec `-f deploy/docker-compose.yml`).

### 2.3 Autres reverse proxies avec Docker

Pour remplacer Caddy par nginx ou Traefik, créez `deploy/docker-compose.override.yml`, pris en compte
automatiquement par `docker compose`, `backup.sh` et `restore.sh` :

```yaml
services:
  oriel:
    ports:
      - "127.0.0.1:3000:3000"   # en local seulement ; le proxy relaie vers ce port
  caddy:
    profiles: ["desactive"]     # Caddy ne démarre plus
```

Configurez ensuite le proxy comme à la [section 3.3](#33-nginx-et-https). Traefik relaie les
WebSockets sans réglage particulier : rattachez le service `oriel` au réseau de Traefik et ajoutez les
labels `traefik.http.routers…` habituels.

---

## 3. VPS avec nginx et systemd (sans Docker)

### 3.1 Construction

Sur le serveur (ou sur une autre machine de même architecture) :

```bash
git clone <url-du-dépôt> oriel && cd oriel
npm ci
npm run build                # → server/dist/server.cjs et web/dist/
```

### 3.2 Installation du service

```bash
sudo useradd --system --home-dir /var/lib/oriel --shell /usr/sbin/nologin oriel
sudo mkdir -p /opt/oriel /etc/oriel
sudo cp server/dist/server.cjs /opt/oriel/
sudo cp -R web/dist /opt/oriel/web
printf 'PUBLIC_URL=https://notes.example.com\nSIGNUP_MODE=first-user\n' | sudo tee /etc/oriel/oriel.env
sudo chmod 640 /etc/oriel/oriel.env && sudo chgrp oriel /etc/oriel/oriel.env
sudo cp deploy/oriel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now oriel
systemctl status oriel
```

L'unité (`deploy/oriel.service`) lance `/usr/bin/node /opt/oriel/server.cjs` avec l'utilisateur
`oriel`, écoute sur `127.0.0.1:3000`, range les données dans `/var/lib/oriel` et lit les variables
supplémentaires dans `/etc/oriel/oriel.env` (voir la [section 6](#6-variables-denvironnement)). Elle
applique le cloisonnement de systemd (`ProtectSystem=strict`, `NoNewPrivileges`…). Adaptez le chemin
de `node` si besoin (`which node`).

### 3.3 nginx et HTTPS

Installez nginx et certbot, puis adaptez [`deploy/nginx.conf.example`](../deploy/nginx.conf.example)
(remplacez `notes.example.com`) :

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/oriel
sudo nano /etc/nginx/sites-available/oriel
sudo ln -s /etc/nginx/sites-available/oriel /etc/nginx/sites-enabled/
sudo certbot --nginx -d notes.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Points essentiels de la configuration :

- **WebSockets** sur `/collab` (édition collaborative) et `/api/events` (mises à jour en direct) :
  en-têtes `Upgrade` / `Connection` et délais longs (`proxy_read_timeout 1h`) ;
- `client_max_body_size` au moins égal à `MAX_UPLOAD_MB` ;
- `X-Forwarded-Proto $scheme` et `X-Forwarded-For`, acceptés grâce à `TRUST_PROXY=true` (fixé par
  l'unité) puisque nginx tourne sur la même machine.

---

## 4. Application macOS

L'app macOS est une coque Electron autour du client web. Au premier lancement, choisissez :

- **Se connecter à un serveur** : l'app affiche votre instance Oriel (adresse du type
  `https://notes.example.com`), avec onglets, recherche rapide globale et pastille du Dock ;
- **Mode local** : un serveur intégré démarre sur le Mac (`127.0.0.1` uniquement), sans compte ni
  réseau ; les données sont dans `~/Library/Application Support/Oriel/data`.

### 4.1 Construire le .dmg

Prérequis : un Mac avec Node.js ≥ 22.13 et `git` (Xcode n'est pas nécessaire).

```bash
git clone <url-du-dépôt> oriel && cd oriel
npm ci
npm run desktop:dist
```

La commande compile le client web et le serveur, les intègre à l'app et écrit dans `desktop/release/` :

| Fichier | Pour |
|---|---|
| `Oriel-<version>-arm64.dmg` | Macs Apple Silicon |
| `Oriel-<version>-x64.dmg` | Macs Intel |
| `Oriel-<version>-<arch>.zip` | les mêmes applications, en archive |

### 4.2 Ouvrir une application non signée (Gatekeeper)

L'app n'est pas signée avec un certificat Apple Developer ID (seulement une signature ad hoc). macOS
bloque donc le premier lancement d'une copie **téléchargée** :

1. Ouvrez le `.dmg` et glissez **Oriel** dans **Applications**.
2. Premier lancement :
   - **macOS 14 et antérieurs** : dans le Finder, **clic droit (ou Ctrl-clic) sur Oriel › Ouvrir**,
     puis **Ouvrir** dans l'avertissement ;
   - **macOS 15 et suivants** : lancez l'app une fois (macOS la bloque), puis **Réglages Système ›
     Confidentialité et sécurité**, section *Sécurité* : **Ouvrir quand même**, et confirmez.
3. Ou retirez l'attribut de quarantaine :
   ```bash
   xattr -dr com.apple.quarantine /Applications/Oriel.app
   ```

Une app construite sur votre propre Mac n'est pas mise en quarantaine. Signature et notarisation
(compte Apple Developer payant) : [DESKTOP.md](DESKTOP.md#6-signature-et-notarisation-facultatif).

### 4.3 Données locales

| Élément | Emplacement |
|---|---|
| Base et fichiers envoyés | `~/Library/Application Support/Oriel/data/` |
| Réglages de l'app | `~/Library/Application Support/Oriel/config.json` |
| Journal du serveur local | `~/Library/Logs/Oriel/server.log` |

Time Machine couvre ces dossiers. Pour une copie manuelle, quittez Oriel puis copiez le dossier
`data`. Plus de détails (menus, onglets, raccourcis, hors ligne) : [DESKTOP.md](DESKTOP.md).

---

## 5. Développement local

```bash
git clone <url-du-dépôt> oriel && cd oriel
npm ci
npm run dev            # API sur 127.0.0.1:3001 + client web Vite sur http://localhost:5173
```

Le serveur de développement range ses données dans `.data-dev/` à la racine du dépôt. Le premier
compte créé sur `http://localhost:5173` devient administrateur.

| Commande | Rôle |
|---|---|
| `npm run build` | client web (`web/dist`) puis serveur (`server/dist/server.cjs`) |
| `npm start` | sert l'application complète sur le port 3000 (après `npm run build`) |
| `npm test -w server` | tests du serveur (`node --test`) |
| `npm test -w mcp`, `npm test -w desktop` | tests du serveur MCP et de l'app |
| `npx tsc -p server/tsconfig.json --noEmit` | vérification des types (aussi `shared`, `web`, `mcp`, `desktop`) |
| `npm run desktop:dev` | compile puis lance l'app macOS depuis les sources (profil `Oriel (dev)`) |

Instance jetable, pratique pour tester une version compilée (l'IA y est simulée) :

```bash
PORT=3000 HOST=127.0.0.1 DATA_DIR=$(mktemp -d) ORIEL_AI_FAKE=1 node server/dist/server.cjs
```

| Dossier | Contenu |
|---|---|
| `shared/` | contrat TypeScript commun (types, API, événements) |
| `server/` | Fastify 5, SQLite (`node:sqlite`, FTS5), Hocuspocus/Yjs |
| `web/` | React 19, Mantine, TanStack Query, éditeur BlockNote |
| `desktop/` | application Electron pour macOS |
| `mcp/` | serveur MCP pour Claude |
| `deploy/` | Docker Compose, Caddy, scripts d'installation, de sauvegarde et de restauration, unité systemd, exemple nginx |

---

## 6. Variables d'environnement

Avec Docker, les variables se règlent dans `deploy/.env` et s'appliquent avec `docker compose up -d`.
Avec systemd, dans `/etc/oriel/oriel.env`, puis `sudo systemctl restart oriel`. Une valeur invalide de
`TRUST_PROXY`, `MAP_TILE_*` ou `ORIEL_SECRETS_KEY` empêche le démarrage, avec un message explicite.

### Serveur

| Variable | Défaut | Rôle |
|---|---|---|
| `PUBLIC_URL` | vide (`https://${DOMAIN}` avec Docker) | Adresse publique, sans barre finale. Sert aux liens d'invitation et des e-mails, aux cookies `Secure`, aux clés d'accès et au SSO. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Port et adresse d'écoute (`127.0.0.1` derrière un proxy local). |
| `DATA_DIR` | `./data` (`/data` dans Docker) | Contient `oriel.db`, `uploads/` et, par défaut, `secret.key`. |
| `WEB_DIST` | détecté | Dossier du client web compilé. |
| `SIGNUP_MODE` | `first-user` | Mode d'inscription **initial** : `first-user`, `invite` ou `open`. Ensuite, l'administrateur le change dans les réglages (la valeur en base prime). |
| `MAX_UPLOAD_MB` | `25` | Taille maximale d'un fichier envoyé. |
| `TRUST_PROXY` | `true` avec Docker et systemd | Pairs autorisés à fournir `X-Forwarded-*` : `true` = boucle locale et réseaux privés ; `false` = aucun ; ou une liste d'IP / plages CIDR séparées par des virgules (ex. `private,173.245.48.0/20`). |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `AUTH_RATE_LIMIT` | `10` | Tentatives de connexion et d'inscription par minute et par adresse IP. |
| `ORIEL_EMBED_ORIGINS` | — | Origines `https` supplémentaires autorisées dans les blocs d'intégration génériques, séparées par des virgules. |
| `ORIEL_SECRETS_KEY` | — (`DATA_DIR/secret.key`) | Clé de chiffrement des secrets de double authentification, au moins 32 caractères (voir la [section 12](#12-double-authentification-et-clés-daccès)). |
| `ORIEL_LOCAL_MODE` | — | **Réservée à l'app macOS.** Ne la définissez jamais sur un serveur : toute requête locale serait connectée en administrateur. |

Avec Docker uniquement (`deploy/.env`) : `DOMAIN` (servi par Caddy, obligatoire) et `ACME_EMAIL`
(compte Let's Encrypt, obligatoire). `docker-compose.yml` fixe `DATA_DIR=/data`, `WEB_DIST=/app/web`,
`HOST=0.0.0.0`, `PORT=3000` et `NODE_ENV=production`.

### E-mails, IA, cartes, SSO

| Variable | Défaut | Rôle |
|---|---|---|
| `SMTP_URL` | — | URL SMTP complète, ex. `smtps://utilisateur:motdepasse@smtp.example.com:465` (prioritaire). `json` affiche les e-mails dans le journal au lieu de les envoyer (développement). |
| `SMTP_HOST` / `SMTP_PORT` | — / `587` | Serveur SMTP si `SMTP_URL` n'est pas utilisée. |
| `SMTP_USER` / `SMTP_PASS` | — | Identifiants SMTP. |
| `SMTP_SECURE` | `true` sur le port 465 uniquement | `true` pour TLS direct. |
| `MAIL_FROM` | `Oriel <no-reply@<domaine de PUBLIC_URL>>` | Expéditeur des e-mails. |
| `ANTHROPIC_API_KEY` | — | Clé d'API du Brief du jour (prime sur la clé enregistrée dans les réglages). |
| `MAP_TILE_URL` | tuiles OpenStreetMap standard | Fond de carte : URL `https://…` ou `/…` avec `{z}`, `{x}`, `{y}` ; `off` pour des cartes sans fond. |
| `MAP_TILE_ATTRIBUTION` | mention OpenStreetMap avec le fond par défaut | Mention affichée sur la carte (texte brut). |
| `MAP_TILE_MAX_ZOOM` | `19` | Zoom maximal (1 à 22). |
| `GEOCODER_URL` | — (désactivé) | URL de base d'un géocodeur compatible Nominatim (le serveur ajoute `/search`). |
| `GEOCODER_ALLOW_PRIVATE` | — | `1` autorise un géocodeur sur une adresse privée ou locale. |
| `OIDC_ISSUER` | — (désactivé) | Émetteur OpenID Connect exact, en `https`. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Client confidentiel déclaré chez le fournisseur. |
| `OIDC_LABEL` | `SSO` | Libellé du bouton « Continuer avec … ». |
| `OIDC_SCOPES` | `openid email profile` | Portées demandées (`openid` est toujours ajoutée). |

### Serveur MCP et développement

| Variable | Rôle |
|---|---|
| `ORIEL_URL`, `ORIEL_TOKEN`, `ORIEL_WORKSPACE` | Serveur MCP : adresse de l'instance, jeton d'API personnel (`or_…`), espace par défaut. |
| `ORIEL_MCP_PORT`, `ORIEL_MCP_HOST` | Serveur MCP en mode HTTP (défauts `3333`, `127.0.0.1`). |
| `ORIEL_API` | Développement : adresse de l'API pour le proxy de Vite (défaut `http://127.0.0.1:3001`). |
| `ORIEL_AI_FAKE`, `ORIEL_AI_FAKE_DELAY_MS` | Tests et démonstrations : IA simulée, sans appel réseau. |

---

## 7. Premier compte administrateur et modes d'inscription

1. Ouvrez l'adresse de l'instance.
2. Créez le **premier compte** : il devient **administrateur de l'instance** et reçoit un espace de
   travail.
3. Faites-le juste après l'installation : tant qu'aucun compte n'existe, le premier visiteur devient
   administrateur.

Modes d'inscription (valeur initiale `SIGNUP_MODE`, puis **Réglages › Instance**) :

| Mode | Comportement |
|---|---|
| `first-user` (défaut) | Seul le premier compte s'inscrit librement ; les autres rejoignent par lien d'invitation. |
| `invite` | L'inscription exige toujours une invitation. |
| `open` | Toute personne qui atteint l'instance peut créer un compte (et son propre espace). |

Pour inviter : **Réglages › Membres › Inviter**, choisissez le rôle (administrateur, membre,
lecteur), puis copiez le lien (valable 7 jours par défaut, révocable) ou envoyez-le par e-mail si le
SMTP est configuré. Les liens sont construits à partir de `PUBLIC_URL`.

---

## 8. E-mails (SMTP)

Avec un serveur SMTP, Oriel envoie les invitations par e-mail, les liens de mot de passe oublié et
les notifications (mentions, commentaires, réponses, rappels), immédiatement ou en résumé
quotidien, au choix de chacun dans **Réglages › Notifications**.

```dotenv
SMTP_URL=smtps://utilisateur:motdepasse@smtp.example.com:465
MAIL_FROM=Oriel <notes@example.com>
PUBLIC_URL=https://notes.example.com
```

Les administrateurs vérifient la configuration avec **Réglages › Notifications › Envoyer un e-mail de
test**. Sans SMTP, tout le reste fonctionne : les invitations sont des liens à copier, et un
administrateur crée des liens de réinitialisation de mot de passe (valables 24 h, usage unique) dans
**Réglages › Instance › Utilisateurs**.

---

## 9. Clé IA (Brief du jour)

Le **Brief du jour**, facultatif, donne à chaque espace un résumé programmé : priorités, retards,
échéances de la semaine, risques et point par projet, à partir des bases de projets choisies. Il
utilise l'API d'Anthropic (modèle par défaut `claude-opus-5-5`) et ne lit que les pages partagées de
l'espace, jamais les pages privées ni la corbeille.

- Définissez `ANTHROPIC_API_KEY` dans l'environnement, **ou** laissez un administrateur de l'instance
  enregistrer une clé dans **Réglages › IA** (la variable d'environnement prime).
- Les propriétaires et administrateurs d'un espace activent le brief et choisissent, dans le même
  onglet, les bases sources, le modèle, les jours et l'heure, et un budget mensuel par espace.
- Un plafond mensuel pour toute l'instance (50 USD par défaut) se règle par un administrateur de
  l'instance ; `0` désactive la fonction sur toute l'instance.

Sans clé, la fonction reste inactive. `ORIEL_AI_FAKE=1` simule le modèle pour les tests et les
démonstrations.

---

## 10. Cartes et géocodage

Les vues **Carte** placent les lignes d'une base selon une propriété **Lieu** (adresse et
coordonnées). Par défaut, le navigateur de chaque lecteur télécharge les tuiles directement auprès de
la fondation OpenStreetMap, dont la [politique d'usage des tuiles](https://operations.osmfoundation.org/policies/tiles/)
vise un usage modéré. Pour une équipe nombreuse, utilisez un fournisseur commercial ou votre propre
serveur de tuiles (`MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `MAP_TILE_MAX_ZOOM`), ou `MAP_TILE_URL=off`.

La recherche d'adresse dans les cellules Lieu est **désactivée par défaut**. Pour l'activer, faites
pointer `GEOCODER_URL` vers un service compatible Nominatim (votre propre instance, ou le service
public dans le respect de ses limites) :

```dotenv
GEOCODER_URL=https://nominatim.example.com
```

Les requêtes passent toujours par le serveur Oriel (jamais directement depuis les navigateurs), avec
délai, taille maximale, limite de débit (une requête par seconde au total, plafond par utilisateur) et
cache de 30 jours ; les adresses privées sont refusées sauf `GEOCODER_ALLOW_PRIVATE=1`. Sans
géocodeur, les adresses sont du texte libre ; des coordonnées tapées à la main (ex. `48,8566 ; 2,3522`)
placent quand même la ligne sur la carte.

---

## 11. Authentification unique (OIDC)

Oriel accepte les fournisseurs OpenID Connect comme Authentik, Keycloak, Google Workspace, Microsoft
Entra ID ou Okta. SAML n'est pas pris en charge.

1. Chez le fournisseur, créez un client **confidentiel** (authentification `client_secret_basic`)
   avec l'URL de redirection `https://notes.example.com/api/auth/oidc/callback`.
2. Configurez Oriel :
   ```dotenv
   PUBLIC_URL=https://notes.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/oriel/
   OIDC_CLIENT_ID=oriel
   OIDC_CLIENT_SECRET=a-remplacer
   OIDC_LABEL=SSO de l'entreprise
   ```
3. Redémarrez. La page de connexion affiche un bouton « Continuer avec … ».

Règles : une nouvelle identité dont l'adresse correspond à un compte existant est refusée tant que
cette personne ne s'est pas connectée avec son mot de passe pour l'associer dans **Réglages ›
Sécurité**. Les nouveaux comptes suivent le mode d'inscription, sauf les adresses (vérifiées par le
fournisseur) d'un **domaine vérifié** avec inscription automatique : un administrateur de l'espace
prouve le domaine par un enregistrement DNS TXT `_oriel.<domaine>` (**Réglages › Sécurité ›
Domaines vérifiés**).

---

## 12. Double authentification et clés d'accès

Chacun peut protéger son compte dans **Réglages › Sécurité** :

- **Application d'authentification** (TOTP), avec 10 codes de secours à usage unique ;
- **Clés d'accès** (WebAuthn), disponibles seulement si `PUBLIC_URL` est en `https` (ou
  `http://localhost` en développement). L'identifiant de site est le nom d'hôte de `PUBLIC_URL` :
  changer de domaine rend les clés enregistrées inutilisables.

Les administrateurs d'un espace peuvent **imposer** la double authentification à tous les membres,
avec un délai de grâce. Les administrateurs de l'instance peuvent réinitialiser la seconde étape d'un
utilisateur qui l'a perdue.

Les secrets TOTP sont chiffrés avec une clé dérivée de `ORIEL_SECRETS_KEY` ou, à défaut, de
`DATA_DIR/secret.key` (créé au premier usage, droits 0600). **Sauvegardez cette clé** : sans elle,
les applications d'authentification ne peuvent plus être vérifiées (les codes de secours et les clés
d'accès restent valables) et un administrateur doit réinitialiser les comptes concernés.
`deploy/backup.sh` **n'inclut pas** `secret.key` : conservez-le à part, ou utilisez
`ORIEL_SECRETS_KEY`, qui fait partie de la copie de `deploy/.env` incluse dans chaque archive.

```bash
openssl rand -base64 48      # une valeur adaptée à ORIEL_SECRETS_KEY
```

---

## 13. Sauvegarde et restauration

### Sauvegarder

```bash
sudo ./deploy/backup.sh                             # Docker
sudo ./deploy/backup.sh --data-dir /var/lib/oriel   # installation systemd
```

- **À chaud et cohérente** : la base est copiée avec `VACUUM INTO` (instantané transactionnel
  SQLite, sans interrompre les utilisateurs) et vérifiée par `PRAGMA integrity_check`.
- L'archive `deploy/backups/oriel-AAAAMMJJ-HHMMSS.tar.gz` contient `oriel.db`, `uploads/`, une copie
  de `deploy/.env` et un `MANIFEST`.
- Les **14** dernières archives sont conservées (`--keep N`) ; autre dossier : `--output DIR`.
- `install.sh` peut programmer une sauvegarde quotidienne (`/etc/cron.d/oriel-backup`, journal
  `/var/log/oriel-backup.log`).

**Copiez les archives hors du serveur**, par exemple depuis votre poste :

```bash
rsync -av utilisateur@serveur:oriel/deploy/backups/ ~/Sauvegardes/oriel/
```

### Restaurer

```bash
sudo ./deploy/restore.sh deploy/backups/oriel-20261013-031500.tar.gz
sudo ./deploy/restore.sh --data-dir /var/lib/oriel <archive>        # installation systemd
```

Le script vérifie l'archive et l'intégrité de la base **avant** de toucher à quoi que ce soit, demande
confirmation, arrête Oriel, met la base actuelle de côté dans `<données>/pre-restore-<date>/`, copie
la base et les fichiers de l'archive, redémarre et attend `/api/health`.

Sur un **nouveau serveur** : installez d'abord Oriel (même domaine), puis restaurez. La configuration
d'origine est dans le fichier `env` de l'archive ; restaurez aussi `secret.key` si vous n'utilisez pas
`ORIEL_SECRETS_KEY`.

---

## 14. Mise à jour

Avec Docker :

```bash
cd oriel
sudo ./deploy/backup.sh
git pull
cd deploy && sudo docker compose up -d --build
sudo docker image prune -f
```

Avec systemd :

```bash
cd oriel && git pull && npm ci && npm run build
sudo ./deploy/backup.sh --data-dir /var/lib/oriel
sudo cp server/dist/server.cjs /opt/oriel/ && sudo rm -rf /opt/oriel/web && sudo cp -R web/dist /opt/oriel/web
sudo systemctl restart oriel
```

Les migrations de la base s'appliquent automatiquement au démarrage. Pour l'app macOS, construisez le
nouveau `.dmg` et remplacez l'application ; les données locales sont conservées.

---

## 15. Serveur MCP (Claude)

Le serveur MCP permet à Claude Desktop ou Claude Code de lire, rédiger et interroger vos pages et
bases avec vos droits, grâce à un jeton d'API personnel.

1. Dans Oriel : **Réglages › API et MCP › Nouveau jeton** (lecture seule, ou lecture et écriture ;
   éventuellement limité à un espace et avec une expiration). Le jeton (`or_…`) n'est affiché qu'une
   fois.
2. Construisez le serveur dans votre copie du dépôt :
   ```bash
   npm ci
   npm run build -w mcp        # → mcp/dist/oriel-mcp.mjs (à lancer depuis le dépôt)
   ```
3. Déclarez-le dans Claude Code :
   ```bash
   claude mcp add oriel \
     --env ORIEL_URL=https://notes.example.com \
     --env ORIEL_TOKEN=or_VOTRE_JETON \
     -- node /chemin/vers/oriel/mcp/dist/oriel-mcp.mjs
   ```
   ou dans Claude Desktop (`claude_desktop_config.json`) :
   ```json
   {
     "mcpServers": {
       "oriel": {
         "command": "node",
         "args": ["/chemin/vers/oriel/mcp/dist/oriel-mcp.mjs"],
         "env": { "ORIEL_URL": "https://notes.example.com", "ORIEL_TOKEN": "or_VOTRE_JETON" }
       }
     }
   }
   ```

Un mode HTTP (`--http --port 3333`, derrière votre proxy HTTPS) sert toute une équipe, chacun avec son
propre jeton. Outils, conventions Markdown et sécurité : [MCP.md](MCP.md).

---

## 16. Dépannage

**Journaux**

```bash
cd deploy && sudo docker compose logs -f oriel    # Docker (une ligne JSON par événement)
sudo docker compose logs -f caddy                 # certificats, proxy
journalctl -u oriel -f                            # systemd
```

Pour plus de détails, `LOG_LEVEL=debug` puis redémarrez.

**Pas de certificat HTTPS** (erreur TLS dans le navigateur) : `dig +short <domaine>` doit renvoyer
l'IP du serveur (attention à un ancien enregistrement AAAA) ; les ports 80 **et** 443 doivent être
joignables depuis internet (pare-feu de l'hébergeur, ufw) ; `docker compose logs caddy` donne la
cause. Après plusieurs échecs, Let's Encrypt impose une attente : corrigez, puis patientez.

**502 Bad Gateway** : le proxy répond mais Oriel non. Vérifiez `docker compose ps` (unhealthy ?) ou
`systemctl status oriel`, puis les journaux : disque plein, variable invalide.

**L'édition collaborative ou les mises à jour en direct ne fonctionnent pas** (indicateur « Hors
ligne », modifications des autres visibles seulement après rechargement) : le proxy doit relayer les
**WebSockets** sur `/collab` et `/api/events` avec des délais d'inactivité supérieurs à 60 secondes
(automatique avec Caddy et Traefik ; voir l'exemple nginx). Derrière Cloudflare, activez les
WebSockets, et listez ses plages d'adresses dans `TRUST_PROXY` s'il joint Oriel sans proxy local.
Vérification rapide :

```bash
curl -si -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://notes.example.com/api/events | head -1
```

`HTTP/1.1 101` ou `401` (non connecté) : l'upgrade passe ; `400` ou `404` venant du proxy : sa
configuration est en cause.

**La connexion ne tient pas** (retour à l'écran de connexion) : `PUBLIC_URL` doit être en `https://`
et correspondre à l'adresse du navigateur ; `TRUST_PROXY` doit couvrir le proxy.

**Envoi de fichier refusé (413)** : augmentez `MAX_UPLOAD_MB` et, avec nginx, `client_max_body_size`.

**La construction de l'image échoue (mémoire)** : ajoutez un fichier d'échange (proposé par
`install.sh`) ou construisez ailleurs.

**ufw et Docker** : les ports publiés par Docker contournent les règles ufw. Seuls 80 et 443 (Caddy)
sont publiés par `docker-compose.yml` ; ne publiez jamais le port 3000 sur toutes les interfaces.

**Clés d'accès indisponibles** : `PUBLIC_URL` doit être une adresse `https`.

**App macOS** : si le serveur local ne démarre pas, une boîte de dialogue affiche la fin de son
journal (**Aide › Afficher les journaux dans le Finder** ouvre le journal complet). App téléchargée
bloquée par Gatekeeper : voir la [section 4.2](#42-ouvrir-une-application-non-signée-gatekeeper).

**Repartir de zéro** (⚠️ efface toutes les données, Docker) : `sudo docker compose down -v`.
