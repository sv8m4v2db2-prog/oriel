# Déployer Oriel sur un serveur (VPS)

Ce guide installe Oriel sur un serveur Linux, accessible en HTTPS sur votre propre nom de
domaine. Toutes les données (base SQLite + fichiers envoyés) tiennent dans **un seul volume**, ce qui
rend les sauvegardes et les migrations triviales.

```
 Navigateurs / app macOS
          │  HTTPS (443) + WebSockets
          ▼
 ┌─────────────────┐      ┌───────────────────────────────┐
 │ Caddy           │ ───▶ │ Oriel (Node.js, port 3000)    │
 │ certificat      │      │ API · temps réel · client web │
 │ Let's Encrypt   │      └──────────────┬────────────────┘
 └─────────────────┘                     │
   volumes caddy-data,          volume oriel-data (/data)
   caddy-config                 oriel.db + uploads/
```

Fichiers concernés : [`Dockerfile`](../Dockerfile), [`deploy/`](../deploy) (`docker-compose.yml`,
`Caddyfile`, `.env.example`, `install.sh`, `backup.sh`, `restore.sh`, `oriel.service`,
`nginx.conf.example`).

---

## 1. Prérequis

| Élément | Recommandation |
|---|---|
| Serveur | VPS Debian 12/13 ou Ubuntu 22.04/24.04, x86-64 ou ARM64 |
| Ressources | 1 vCPU, **2 Go de RAM** (1 Go + fichier d'échange suffit), 10 Go de disque |
| Accès | SSH avec un compte `root` ou `sudo` |
| Nom de domaine | Un sous-domaine dédié, par ex. `notes.mondomaine.fr` |
| DNS | Enregistrement **A** (IPv4) — et **AAAA** si le serveur a une IPv6 — pointant vers l'IP du serveur |
| Réseau | Ports **80** et **443** (TCP, + 443/UDP pour HTTP/3) ouverts, y compris dans le pare-feu de l'hébergeur |

Créez l'enregistrement DNS **avant** l'installation : Caddy en a besoin pour obtenir le certificat.
Vérifiez la propagation depuis votre poste :

```bash
dig +short notes.mondomaine.fr      # doit afficher l'IP du serveur
```

---

## 2. Installation rapide (recommandée)

Sur le serveur :

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <url-du-dépôt-oriel> oriel
cd oriel
sudo ./deploy/install.sh
```

Le script, que l'on peut relancer sans risque :

1. vérifie le système (distribution, mémoire — propose un fichier d'échange de 2 Go si besoin —,
   espace disque, ports 80/443 libres) ;
2. installe **Docker Engine** et le plugin **Compose** depuis le dépôt APT officiel
   `download.docker.com` (clé GPG vérifiée, aucun `curl | sh`) ;
3. demande le **nom de domaine** et l'**e-mail** Let's Encrypt, et écrit `deploy/.env` (droits 600) ;
4. contrôle la résolution DNS du domaine ;
5. propose d'activer le pare-feu **ufw** (SSH, 80/tcp, 443/tcp, 443/udp) ;
6. construit l'image et démarre les conteneurs (`docker compose up -d --build`) ;
7. attend qu’Oriel soit en bonne santé puis que `https://<domaine>/api/health` réponde ;
8. propose une **sauvegarde quotidienne** (cron à 3 h 15, 14 archives conservées) ;
9. affiche l'URL et les étapes suivantes.

Installation non interactive :

```bash
sudo ./deploy/install.sh --domain notes.mondomaine.fr --email admin@mondomaine.fr \
  --firewall --backup-cron --yes
```

`./deploy/install.sh --help` liste toutes les options (`--signup`, `--no-firewall`, …).

---

## 3. Installation manuelle avec Docker

1. **Docker Engine + Compose** : suivez la documentation officielle de Docker pour
   [Debian](https://docs.docker.com/engine/install/debian/) ou
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) (paquets `docker-ce`,
   `docker-buildx-plugin`, `docker-compose-plugin`).
2. **Code source** :
   ```bash
   git clone <url-du-dépôt-oriel> oriel && cd oriel
   ```
3. **Configuration** :
   ```bash
   cp deploy/.env.example deploy/.env
   chmod 600 deploy/.env
   nano deploy/.env          # DOMAIN et ACME_EMAIL au minimum
   ```
4. **Démarrage** :
   ```bash
   cd deploy
   sudo docker compose up -d --build
   sudo docker compose ps                     # oriel doit passer « healthy »
   curl -fsS https://notes.mondomaine.fr/api/health
   ```

La première construction prend quelques minutes (installation des dépendances, compilation du
client web). L'image finale ne contient que Node.js, `server.cjs` et le client web compilé ; elle
s'exécute avec l'utilisateur non privilégié `node`.

> Toutes les commandes `docker compose` de ce guide s'exécutent depuis `deploy/`, ou depuis la racine
> du dépôt avec `-f deploy/docker-compose.yml`.

---

## 4. Configuration

Les variables se règlent dans `deploy/.env`, puis s'appliquent avec `docker compose up -d`.

| Variable | Défaut | Rôle |
|---|---|---|
| `DOMAIN` | — (obligatoire) | Nom de domaine servi par Caddy (certificat automatique) |
| `ACME_EMAIL` | — (obligatoire) | E-mail du compte Let's Encrypt (alertes d'expiration) |
| `PUBLIC_URL` | `https://${DOMAIN}` | URL publique : liens d'invitation absolus, cookies `Secure` |
| `SIGNUP_MODE` | `first-user` | Mode d'inscription **initial** : `first-user`, `invite` ou `open` (ensuite modifiable par l'administrateur dans Réglages › Instance, la valeur en base prime) |
| `MAX_UPLOAD_MB` | `25` | Taille maximale d'un fichier envoyé |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `TRUST_PROXY` | `true` | Qui peut fournir les en-têtes `X-Forwarded-*` (IP du client, protocole, hôte). `true` : le proxy doit être sur la machine ou un réseau privé (Caddy du `docker-compose.yml`, Nginx local) ; `false` : aucun proxy (serveur exposé directement) ; ou une liste d'adresses IP / plages CIDR séparées par des virgules, pour un proxy ou un CDN aux adresses publiques (ex. `private,173.245.48.0/20`). Une valeur invalide empêche le démarrage. |

Fixées par `docker-compose.yml` / l'image (inutile de les modifier) :

| Variable | Valeur | Rôle |
|---|---|---|
| `DATA_DIR` | `/data` | Base `oriel.db` et dossier `uploads/` (volume `oriel-data`) |
| `WEB_DIST` | `/app/web` | Client web compilé |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Écoute interne (non publiée : seul Caddy est exposé) |
| `NODE_ENV` | `production` | |

Point de santé : `GET /api/health` → `{"ok":true,"version":"…"}` (utilisé par le `HEALTHCHECK` de
l'image).

> ⚠️ **Ne définissez jamais `ORIEL_LOCAL_MODE` sur un serveur.** Cette variable est réservée au
> mode local de l'application macOS : elle connecte automatiquement toute requête locale comme
> administrateur. Derrière un proxy qui réécrit l'en-tête `Host`, tous les visiteurs deviendraient
> administrateurs.

### Cartes et recherche d'adresse (facultatif)

Les vues **Carte** placent les lignes d'une base selon une propriété **Lieu** (adresse et coordonnées).

| Variable | Défaut | Rôle |
|---|---|---|
| `MAP_TILE_URL` | tuiles OpenStreetMap standard (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) | Fond de carte : adresse `https://…` ou chemin `/…` de l'instance, contenant `{z}`, `{x}` et `{y}` (et éventuellement `{s}`, `{r}`). `off` : cartes sans fond. Une valeur invalide empêche le démarrage. |
| `MAP_TILE_ATTRIBUTION` | `© les contributeurs d’OpenStreetMap` avec le fond par défaut, vide sinon | Mention affichée en bas de la carte (texte brut). Renseignez celle qu'exige votre fournisseur. |
| `MAP_TILE_MAX_ZOOM` | `19` | Zoom maximal (entier de 1 à 22). |
| `GEOCODER_URL` | — (désactivé) | Recherche d'adresse dans les cellules **Lieu** : URL de base d'un service compatible Nominatim (le serveur ajoute `/search`). Sans cette variable, les adresses sont saisies librement, sans position sur la carte (sauf coordonnées tapées à la main, ex. `48,8566 ; 2,3522`). |
| `GEOCODER_ALLOW_PRIVATE` | — | `1` : autorise un géocodeur auto-hébergé sur le réseau local (adresse privée ou de bouclage), refusé sinon. |

Confidentialité :
- **Tuiles.** Le navigateur de chaque lecteur télécharge les tuiles directement chez le fournisseur
  configuré. Celui-ci voit l'adresse IP du lecteur, son navigateur, l'adresse de votre instance
  (en-tête `Referer`, réduit à l'origine) et les **zones consultées**. Avec le fond par défaut, ce
  fournisseur est la fondation OpenStreetMap, dont la [politique d'usage des tuiles](https://operations.osmfoundation.org/policies/tiles/)
  vise un usage modéré : pour une équipe nombreuse, préférez un fournisseur commercial ou votre propre
  serveur de tuiles (chemin `/…` servi par votre proxy). La CSP de l'interface autorise déjà les
  images `https:`.
- **Géocodage.** Les recherches passent toujours par le serveur Oriel (jamais directement depuis le
  navigateur) : le géocodeur voit l'adresse IP du serveur et le texte recherché, pas les lecteurs.
  Le serveur limite le débit (une requête par seconde au total, plafond par utilisateur), garde les
  résultats en cache 30 jours et s'identifie par son `User-Agent`. Le service public
  `https://nominatim.openstreetmap.org` impose ces limites et interdit l'usage intensif : pour
  davantage, hébergez votre propre instance.

### Sécurité des comptes : double authentification, clés d'accès, SSO (facultatif)

| Variable | Défaut | Rôle |
|---|---|---|
| `ORIEL_SECRETS_KEY` | — (fichier `secret.key`) | Clé de chiffrement des secrets de double authentification (au moins 32 caractères, ex. `openssl rand -base64 48`). Sans elle, le serveur crée au premier usage `DATA_DIR/secret.key` (32 octets aléatoires, droits `0600`). Une valeur trop courte empêche le démarrage. |
| `OIDC_ISSUER` | — (désactivé) | Émetteur OpenID Connect exact (ex. `https://auth.example.com/application/o/oriel`, `https://accounts.google.com`). Doit être en `https`. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Identifiants du client déclaré chez le fournisseur (client confidentiel, authentification `client_secret_basic`). URL de redirection à déclarer : `${PUBLIC_URL}/api/auth/oidc/callback`. |
| `OIDC_LABEL` | `SSO` | Libellé du bouton « Continuer avec … » de la page de connexion. |
| `OIDC_SCOPES` | `openid email profile` | Portées demandées (`openid` est toujours ajoutée). |

- **Clé de chiffrement.** Perdre la clé (variable changée, `secret.key` supprimé ou non restauré) rend
  illisibles les secrets des applications d'authentification : ces comptes ne peuvent plus valider de
  code (les codes de secours et les clés d'accès restent valables) et un administrateur doit
  réinitialiser leur double authentification (Réglages › Sécurité). **`deploy/backup.sh` ne sauvegarde
  pas `secret.key`** : copiez-le à part, dans un endroit distinct des archives, ou utilisez
  `ORIEL_SECRETS_KEY` (qui, elle, est dans la copie de `deploy/.env` incluse dans l'archive).
- **Clés d'accès (passkeys).** Disponibles seulement si `PUBLIC_URL` est en `https` (ou `http://localhost`
  en développement) : l'identifiant de site est le nom d'hôte de `PUBLIC_URL`. Changer de nom de
  domaine rend les clés d'accès enregistrées inutilisables. Indisponibles dans l'app macOS en mode
  local (un seul utilisateur, connecté automatiquement).
- **SSO (OIDC).** Exige `PUBLIC_URL`. Le serveur contacte uniquement l'émetteur configuré et les
  adresses publiées par son document de découverte (délai et taille limités). Une identité inconnue
  dont l'adresse correspond à un compte existant est refusée : la personne se connecte d'abord avec
  son mot de passe, puis associe son compte dans Réglages › Sécurité. Les nouveaux comptes suivent le
  mode d'inscription, sauf les adresses (vérifiées par le fournisseur) d'un domaine vérifié avec
  inscription automatique. Avec Google Workspace, limitez l'application à votre organisation côté Google.
- **Domaines vérifiés.** La vérification lit l'enregistrement TXT `_oriel.<domaine>` avec le
  résolveur DNS du système du serveur.
- **SAML** : non pris en charge pour l'instant (pas de bibliothèque retenue ; les contournements de
  signature XML sont une classe de failles fréquente). Utilisez OIDC, que proposent Authentik,
  Keycloak, Google Workspace, Entra ID, Okta…
- **Mot de passe oublié :** pour un compte protégé par la double authentification, le lien de
  réinitialisation change le mot de passe mais la connexion demande toujours la seconde étape.

---

## 5. Premier accès

1. Ouvrez `https://<votre-domaine>`.
2. Créez le **premier compte** : il devient **administrateur de l'instance** et un espace de travail
   lui est créé.
3. Avec le mode `first-user` (par défaut), l'inscription libre se ferme ensuite : les comptes suivants
   ne se créent que **par invitation**. L'administrateur peut changer ce mode dans
   **Réglages › Instance** (`invite` ou `open`).

> Faites-le sans attendre après l'installation : tant qu'aucun compte n'existe, la première personne
> qui ouvre l'URL devient administrateur.

## 6. Inviter des membres

1. **Réglages › Membres › Inviter** : choisissez le rôle (`admin`, `member`, `viewer`).
2. Copiez le **lien d'invitation** (valable 7 jours par défaut, révocable) et envoyez-le.
3. La personne ouvre le lien, crée son compte (même si l'inscription est fermée) ou se connecte,
   puis rejoint l'espace.

Les liens sont construits à partir de `PUBLIC_URL` : vérifiez qu'elle correspond bien à l'adresse
publique (`https://…`).

### E-mails (SMTP, facultatif)

Avec un serveur SMTP, Oriel envoie les **invitations par e-mail** (Réglages › Membres › Inviter
par e-mail), les liens de **mot de passe oublié** et les **notifications** (mentions, commentaires,
réponses, rappels) : immédiatement ou en **résumé quotidien vers 8 h** (Europe/Paris), au choix de
chaque utilisateur dans Réglages › Notifications (résumé quotidien par défaut).

| Variable | Rôle |
|---|---|
| `SMTP_URL` | URL complète, ex. `smtps://utilisateur:motdepasse@smtp.example.com:465` (prioritaire) |
| `SMTP_HOST` / `SMTP_PORT` | Serveur et port (défaut `587`) si `SMTP_URL` n'est pas utilisée |
| `SMTP_USER` / `SMTP_PASS` | Identifiants SMTP |
| `SMTP_SECURE` | `true` pour TLS direct (port 465) ; défaut : `true` seulement si le port est 465 |
| `MAIL_FROM` | Expéditeur, ex. `Oriel <oriel@example.com>` (défaut `no-reply@<domaine de PUBLIC_URL>`) |

Vérifiez la configuration avec **Réglages › Notifications › Envoyer un e-mail de test**
(administrateurs). Les liens des e-mails utilisent `PUBLIC_URL` : renseignez-la. En développement,
`SMTP_URL=json` n'envoie rien et affiche les e-mails dans les journaux du serveur.

**Sans SMTP**, tout fonctionne sauf l'envoi : « Mot de passe oublié » indique de s'adresser à un
administrateur, qui crée un **lien de réinitialisation** (valable 24 h, usage unique) depuis
Réglages › Instance › Utilisateurs › Réinitialiser, et les invitations restent des liens à copier.

---

## 7. Mise à jour

```bash
cd oriel
sudo ./deploy/backup.sh                       # par précaution
git pull
cd deploy && sudo docker compose up -d --build
sudo docker image prune -f                    # supprime les anciennes images
```

Les migrations de la base s'appliquent automatiquement au démarrage. Le volume `oriel-data` est
conservé.

---

## 8. Sauvegarde et restauration

### Sauvegarder

```bash
sudo ./deploy/backup.sh
```

- **À chaud et cohérente** : la base est copiée avec `VACUUM INTO` (instantané transactionnel
  SQLite, sans interrompre les utilisateurs), puis vérifiée (`PRAGMA integrity_check`).
- L'archive `deploy/backups/oriel-AAAAMMJJ-HHMMSS.tar.gz` contient `oriel.db`, `uploads/`,
  une copie de `deploy/.env` et un `MANIFEST`.
- Seules les **14** dernières archives sont conservées (`--keep N` ou `KEEP=N`, dossier :
  `--output DIR` ou `BACKUP_DIR=…`).
- `install.sh` peut programmer une sauvegarde quotidienne : `/etc/cron.d/oriel-backup`,
  journal `/var/log/oriel-backup.log`.

**Copiez les archives hors du serveur** : une sauvegarde sur le même disque ne protège pas d'une
panne ou d'une suppression du VPS. Par exemple, depuis votre poste :

```bash
rsync -av --delete utilisateur@serveur:oriel/deploy/backups/ ~/Sauvegardes/oriel/
```

(ou `rclone` vers un stockage objet, à planifier côté serveur).

### Restaurer

```bash
sudo ./deploy/restore.sh deploy/backups/oriel-20261013-031500.tar.gz
```

Le script vérifie l'archive et l'intégrité de la base **avant** de toucher à quoi que ce soit, demande
confirmation, arrête Oriel, met la base actuelle de côté dans `/data/pre-restore-<date>/`, copie la
base de l'archive, ajoute ses fichiers envoyés, redémarre et attend `/api/health`.

Sur un **nouveau serveur** : installez d'abord Oriel (`install.sh`, même domaine), puis restaurez
l'archive. La configuration d'origine est dans le fichier `env` de l'archive.

### Alternative manuelle (à froid)

```bash
cd deploy
sudo docker compose stop oriel
sudo docker run --rm -v oriel_oriel-data:/data -v "$PWD":/out alpine \
  tar -C /data -czf /out/oriel-data.tar.gz .
sudo docker compose start oriel
```

---

## 9. Alternatives à Caddy

### Nginx (+ certbot)

Oriel doit alors écouter en local seulement et Caddy rester éteint. Créez
`deploy/docker-compose.override.yml` (pris en compte automatiquement par `docker compose` lancé
depuis `deploy/`, ainsi que par `backup.sh` et `restore.sh`) :

```yaml
services:
  oriel:
    ports:
      - "127.0.0.1:3000:3000"
  caddy:
    profiles: ["desactive"]   # Caddy ne démarre plus
```

puis :

```bash
cd deploy && sudo docker compose up -d --build
```

Adaptez et installez [`deploy/nginx.conf.example`](../deploy/nginx.conf.example) (certificat via
`sudo certbot --nginx -d notes.mondomaine.fr`). Les points essentiels :

- en-têtes `Upgrade` / `Connection` pour les **WebSockets** `/collab` (édition collaborative) et
  `/api/events` (invalidations temps réel), avec des délais longs (`proxy_read_timeout 1h`) ;
- `client_max_body_size` ≥ `MAX_UPLOAD_MB` ;
- `X-Forwarded-Proto $scheme` pour les cookies `Secure`.

### Traefik

Si un Traefik existant gère déjà vos certificats, désactivez Caddy et ajoutez des labels au service
`oriel` (réseau partagé avec Traefik), toujours dans `deploy/docker-compose.override.yml` :

```yaml
services:
  caddy:
    profiles: ["desactive"]
  oriel:
    labels:
      - traefik.enable=true
      - traefik.http.routers.oriel.rule=Host(`notes.mondomaine.fr`)
      - traefik.http.routers.oriel.entrypoints=websecure
      - traefik.http.routers.oriel.tls.certresolver=letsencrypt
      - traefik.http.services.oriel.loadbalancer.server.port=3000
    networks: [traefik]
networks:
  traefik:
    external: true
```

Traefik relaie les WebSockets sans configuration supplémentaire.

### Sans Docker (systemd)

Nécessite **Node.js ≥ 22.13** (module `node:sqlite`), par exemple Node 24 LTS.

```bash
# Construction (sur le serveur ou ailleurs)
git clone <url-du-dépôt-oriel> oriel && cd oriel
npm ci && npm run build                       # → server/dist/server.cjs et web/dist/

# Installation
sudo useradd --system --home-dir /var/lib/oriel --shell /usr/sbin/nologin oriel
sudo mkdir -p /opt/oriel /etc/oriel
sudo cp server/dist/server.cjs /opt/oriel/
sudo cp -R web/dist /opt/oriel/web
printf 'PUBLIC_URL=https://notes.mondomaine.fr\nSIGNUP_MODE=first-user\n' | sudo tee /etc/oriel/oriel.env
sudo cp deploy/oriel.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now oriel
```

Le service écoute sur `127.0.0.1:3000` (données dans `/var/lib/oriel`) ; placez Nginx (ci-dessus)
ou Caddy devant. Sauvegarde / restauration :
`sudo ./deploy/backup.sh --data-dir /var/lib/oriel` et
`sudo ./deploy/restore.sh --data-dir /var/lib/oriel <archive>`.

---

## 10. Dépannage

**Journaux**

```bash
cd deploy
sudo docker compose logs -f oriel          # serveur Oriel (JSON, une ligne par événement)
sudo docker compose logs -f caddy             # certificats, proxy
sudo docker compose ps                        # état et santé des conteneurs
```

Pour plus de détails : `LOG_LEVEL=debug` dans `.env`, puis `sudo docker compose up -d`. Sans Docker :
`journalctl -u oriel -f`.

**Le certificat HTTPS n'est pas obtenu** (le navigateur affiche une erreur TLS)
- `dig +short <domaine>` doit renvoyer l'IP du serveur (attention à un ancien AAAA erroné).
- Les ports 80 **et** 443 doivent être joignables depuis Internet (pare-feu de l'hébergeur, ufw).
- `docker compose logs caddy` indique la cause ; après trop d'échecs, Let's Encrypt impose une
  attente (limites de fréquence) : corrigez puis patientez.

**502 Bad Gateway**
Caddy répond mais Oriel non : `docker compose ps` (état `unhealthy` ?) et
`docker compose logs oriel`. Causes fréquentes : volume plein, `.env` invalide.

**L'édition collaborative ou les mises à jour en direct ne fonctionnent pas**
(indicateur « Hors ligne », modifications des autres invisibles sans recharger)
- Le proxy doit relayer les **WebSockets** sur `/collab` et `/api/events` (Caddy et Traefik : 
  automatique ; Nginx : voir `nginx.conf.example`).
- Les délais d'inactivité du proxy doivent dépasser 60 s (`proxy_read_timeout`).
- Derrière Cloudflare : activez l'option WebSockets du domaine. Si Cloudflare joint Oriel sans
  proxy local, mettez ses plages d'adresses dans `TRUST_PROXY` (sinon les limites de débit voient
  l'IP de Cloudflare et non celle du visiteur).
- Vérification rapide depuis votre poste :
  ```bash
  curl -si -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://<domaine>/api/events | head -1
  ```
  Une réponse `HTTP/1.1 101` ou `401` (non connecté) prouve que l'upgrade traverse le proxy ;
  `400`/`404` venant du proxy signale un problème de configuration.

**Connexion qui ne « tient » pas, retour permanent à l'écran de connexion**
`PUBLIC_URL` doit être en `https://` et correspondre à l'adresse utilisée ; `TRUST_PROXY=true`
derrière un proxy local ou du même réseau privé, ou la liste des adresses du proxy s'il a une IP
publique (les en-têtes `X-Forwarded-*` d'un autre pair sont ignorés).

**Envoi de fichier refusé (413)**
Augmentez `MAX_UPLOAD_MB` et, avec Nginx, `client_max_body_size`.

**La construction de l'image échoue (mémoire)**
Ajoutez un fichier d'échange (proposé par `install.sh`) ou construisez l'image ailleurs.

**ufw et Docker**
Les ports publiés par Docker contournent les règles ufw. Seuls 80 et 443 (Caddy) sont publiés par
`docker-compose.yml` ; ne publiez pas le port 3000 sur toutes les interfaces.

**Repartir de zéro** (⚠️ efface toutes les données) : `sudo docker compose down -v`.

## Limites des importeurs (Réglages › Import / export)
Les importeurs (Word, Excel, Confluence, Evernote, Trello, Asana, Google Docs) tournent dans le navigateur ;
le serveur ne reçoit que les pages et fichiers créés. Plafonds appliqués par le client
(`web/src/io/importers/limits.ts`) : 512 Mo par fichier, 100 000 entrées par archive, 96 Mo par partie XML/HTML/JSON,
taux de compression 250:1 au-delà de 4 Mo, 4 Go décompressés au total, 50 000 pages et lignes par import,
20 000 lignes et 100 colonnes par feuille, 128 niveaux d'imbrication. Les pièces jointes dépassant
`MAX_UPLOAD_MB` sont refusées par le serveur et signalées dans le rapport d'import.
