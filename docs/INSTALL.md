# Installing Oriel

*[Version française](INSTALL.fr.md)*

This guide covers every way to run Oriel: on a Linux server (with Docker and Caddy, or with nginx and
systemd), as a macOS application, and on a development machine. It ends with a reference of all
configuration variables and a troubleshooting section.

The user interface is in French. All data of an instance (one SQLite database and the uploaded
files) lives in a single data directory, which keeps backups and moves simple.

```
 Browsers / macOS app
          │  HTTPS (443) + WebSockets
          ▼
 ┌─────────────────┐      ┌───────────────────────────────┐
 │ Reverse proxy   │ ───▶ │ Oriel (Node.js, port 3000)    │
 │ (Caddy, nginx…) │      │ API · real time · web client  │
 └─────────────────┘      └──────────────┬────────────────┘
                                         │
                              data directory (DATA_DIR)
                              oriel.db + uploads/
```

## Contents

1. [Requirements](#1-requirements)
2. [VPS with Docker and Caddy (recommended)](#2-vps-with-docker-and-caddy-recommended)
3. [VPS with nginx and systemd (without Docker)](#3-vps-with-nginx-and-systemd-without-docker)
4. [macOS application](#4-macos-application)
5. [Local development](#5-local-development)
6. [Environment variables](#6-environment-variables)
7. [First administrator account and sign-up modes](#7-first-administrator-account-and-sign-up-modes)
8. [E-mail (SMTP)](#8-e-mail-smtp)
9. [AI key (daily brief)](#9-ai-key-daily-brief)
10. [Maps and geocoding](#10-maps-and-geocoding)
11. [Single sign-on (OIDC)](#11-single-sign-on-oidc)
12. [Two-factor authentication and passkeys](#12-two-factor-authentication-and-passkeys)
13. [Backup and restore](#13-backup-and-restore)
14. [Updating](#14-updating)
15. [MCP server (Claude)](#15-mcp-server-claude)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Requirements

| | Server (VPS) | macOS app / development |
|---|---|---|
| System | Debian 12/13 or Ubuntu 22.04/24.04, x86-64 or ARM64 | macOS (Apple Silicon or Intel) for the app; macOS or Linux for development |
| Resources | 1 vCPU, **2 GB RAM** (1 GB plus a swap file works), 10 GB disk | — |
| Software | Docker Engine + Compose plugin (installed by the script), **or** Node.js ≥ 22.13 (Node 24 LTS recommended) | Node.js ≥ 22.13, `git` |
| Network | A domain name (e.g. `notes.example.com`) with an **A** record (and **AAAA** if the server has IPv6) pointing to the server; ports **80** and **443** open | Internet access for the first `npm ci` |

Create the DNS record **before** installing: the certificate authority checks it. From your computer:

```bash
dig +short notes.example.com
```

The command must print the IP address of the server.

---

## 2. VPS with Docker and Caddy (recommended)

Caddy terminates HTTPS with an automatic Let's Encrypt certificate and forwards requests (WebSockets
included) to Oriel. Only ports 80 and 443 are published; Oriel itself is not reachable from outside.

### 2.1 Quick install

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <repository-url> oriel
cd oriel
sudo ./deploy/install.sh
```

The script can be run again safely. It:

1. checks the system (distribution, memory — it offers a 2 GB swap file when needed —, disk space,
   free ports 80/443);
2. installs **Docker Engine** and the **Compose** plugin from Docker's official APT repository
   (signed packages, no `curl | sh`);
3. asks for the **domain name** and the **Let's Encrypt e-mail**, and writes `deploy/.env` (mode 600);
4. checks that the domain resolves to the server;
5. offers to enable the **ufw** firewall (SSH, 80/tcp, 443/tcp, 443/udp);
6. builds the image and starts the containers (`docker compose up -d --build`);
7. waits until `https://<domain>/api/health` answers;
8. offers a **daily backup** (cron at 3:15, 14 archives kept);
9. prints the URL and the next steps.

Non-interactive install:

```bash
sudo ./deploy/install.sh --domain notes.example.com --email admin@example.com \
  --signup first-user --firewall --backup-cron --yes
```

`./deploy/install.sh --help` lists every option.

Then open `https://notes.example.com` and **create the first account right away** (it becomes the
instance administrator, see [section 7](#7-first-administrator-account-and-sign-up-modes)).

### 2.2 Manual install with Docker

1. Install Docker Engine and the Compose plugin by following Docker's documentation for
   [Debian](https://docs.docker.com/engine/install/debian/) or
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
2. Get the code and configure it:
   ```bash
   git clone <repository-url> oriel && cd oriel
   cp deploy/.env.example deploy/.env
   chmod 600 deploy/.env
   nano deploy/.env            # at least DOMAIN and ACME_EMAIL
   ```
3. Start:
   ```bash
   cd deploy
   sudo docker compose up -d --build
   sudo docker compose ps      # "oriel" must become "healthy"
   curl -fsS https://notes.example.com/api/health
   ```

The first build takes a few minutes. The final image contains only Node.js, the server bundle and the
compiled web client, and runs as the unprivileged `node` user. Data is stored in the Docker volume
`oriel_oriel-data`, mounted on `/data`.

All `docker compose` commands in this guide run from `deploy/` (or from the repository root with
`-f deploy/docker-compose.yml`).

### 2.3 Other reverse proxies with Docker

To use nginx or Traefik instead of Caddy, create `deploy/docker-compose.override.yml`, which
`docker compose`, `backup.sh` and `restore.sh` pick up automatically:

```yaml
services:
  oriel:
    ports:
      - "127.0.0.1:3000:3000"   # local only; the proxy forwards to it
  caddy:
    profiles: ["disabled"]      # Caddy no longer starts
```

Then configure the proxy as in [section 3.3](#33-nginx-and-https). Traefik forwards WebSockets
without extra settings; attach the `oriel` service to the Traefik network and add the usual
`traefik.http.routers…` labels.

---

## 3. VPS with nginx and systemd (without Docker)

### 3.1 Build

On the server (or on another machine with the same architecture):

```bash
git clone <repository-url> oriel && cd oriel
npm ci
npm run build                # → server/dist/server.cjs and web/dist/
```

### 3.2 Install the service

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

The unit (`deploy/oriel.service`) runs `/usr/bin/node /opt/oriel/server.cjs` as the `oriel` user,
listens on `127.0.0.1:3000`, stores data in `/var/lib/oriel` and reads extra variables from
`/etc/oriel/oriel.env` (see [section 6](#6-environment-variables)). It applies systemd sandboxing
(`ProtectSystem=strict`, `NoNewPrivileges`, …). Adjust the `node` path if needed (`which node`).

### 3.3 nginx and HTTPS

Install nginx and certbot, then adapt [`deploy/nginx.conf.example`](../deploy/nginx.conf.example)
(replace `notes.example.com`):

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/oriel
sudo nano /etc/nginx/sites-available/oriel
sudo ln -s /etc/nginx/sites-available/oriel /etc/nginx/sites-enabled/
sudo certbot --nginx -d notes.example.com
sudo nginx -t && sudo systemctl reload nginx
```

What matters in the configuration:

- **WebSockets** on `/collab` (collaborative editing) and `/api/events` (live updates):
  `Upgrade` / `Connection` headers and long timeouts (`proxy_read_timeout 1h`);
- `client_max_body_size` at least equal to `MAX_UPLOAD_MB`;
- `X-Forwarded-Proto $scheme` and `X-Forwarded-For`, trusted thanks to `TRUST_PROXY=true` (set by the
  unit) because nginx runs on the same machine.

---

## 4. macOS application

The macOS app is an Electron shell around the web client. At first launch, choose:

- **Connect to a server**: the app shows your Oriel instance (address such as
  `https://notes.example.com`), with tabs, a global quick search and a Dock badge;
- **Local mode**: an embedded server starts on the Mac (`127.0.0.1` only), with no account and no
  network; data is stored in `~/Library/Application Support/Oriel/data`.

### 4.1 Build the .dmg

Requirements: a Mac with Node.js ≥ 22.13 and `git` (Xcode is not needed).

```bash
git clone <repository-url> oriel && cd oriel
npm ci
npm run desktop:dist
```

The command builds the web client and the server, embeds them in the app and writes to
`desktop/release/`:

| File | For |
|---|---|
| `Oriel-<version>-arm64.dmg` | Apple Silicon Macs |
| `Oriel-<version>-x64.dmg` | Intel Macs |
| `Oriel-<version>-<arch>.zip` | the same apps as archives |

### 4.2 Open an unsigned app (Gatekeeper)

The app is not signed with an Apple Developer ID certificate (only an ad-hoc signature). macOS
therefore blocks the first launch of a **downloaded** copy:

1. Open the `.dmg` and drag **Oriel** to **Applications**.
2. First launch:
   - **macOS 14 and earlier**: in the Finder, **right-click (or Control-click) Oriel › Open**, then
     **Open** in the warning;
   - **macOS 15 and later**: launch the app once (macOS blocks it), then go to **System Settings ›
     Privacy & Security**, section *Security*, click **Open Anyway** and confirm.
3. Alternatively, remove the quarantine attribute:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Oriel.app
   ```

An app you build on your own Mac is not quarantined. Signing and notarization (paid Apple Developer
account) are described in [DESKTOP.md](DESKTOP.md#6-signature-et-notarisation-facultatif).

### 4.3 Local data

| Item | Location |
|---|---|
| Database and uploaded files | `~/Library/Application Support/Oriel/data/` |
| App settings | `~/Library/Application Support/Oriel/config.json` |
| Local server log | `~/Library/Logs/Oriel/server.log` |

Time Machine covers these folders. For a manual copy, quit Oriel first, then copy the `data` folder.
More details (menus, tabs, shortcuts, offline behavior): [DESKTOP.md](DESKTOP.md).

---

## 5. Local development

```bash
git clone <repository-url> oriel && cd oriel
npm ci
npm run dev            # API on 127.0.0.1:3001 + Vite web client on http://localhost:5173
```

The development server stores its data in `.data-dev/` at the repository root. The first account you
create on `http://localhost:5173` becomes the administrator.

| Command | Purpose |
|---|---|
| `npm run build` | web client (`web/dist`) then server bundle (`server/dist/server.cjs`) |
| `npm start` | serves the complete application on port 3000 (after `npm run build`) |
| `npm test -w server` | server tests (`node --test`) |
| `npm test -w mcp`, `npm test -w desktop` | MCP server and desktop tests |
| `npx tsc -p server/tsconfig.json --noEmit` | type checking (also `shared`, `web`, `mcp`, `desktop`) |
| `npm run desktop:dev` | builds, then runs the macOS app from the sources (profile `Oriel (dev)`) |

A disposable instance, useful for testing a build (the AI runs in a simulated mode):

```bash
PORT=3000 HOST=127.0.0.1 DATA_DIR=$(mktemp -d) ORIEL_AI_FAKE=1 node server/dist/server.cjs
```

| Folder | Content |
|---|---|
| `shared/` | TypeScript contract shared by all packages (types, API, events) |
| `server/` | Fastify 5, SQLite (`node:sqlite`, FTS5), Hocuspocus/Yjs |
| `web/` | React 19, Mantine, TanStack Query, BlockNote editor |
| `desktop/` | Electron app for macOS |
| `mcp/` | MCP server for Claude |
| `deploy/` | Docker Compose, Caddy, install, backup and restore scripts, systemd unit, nginx example |

---

## 6. Environment variables

With Docker, set variables in `deploy/.env` and apply them with `docker compose up -d`. With systemd,
use `/etc/oriel/oriel.env` and `sudo systemctl restart oriel`. An invalid value of `TRUST_PROXY`,
`MAP_TILE_*` or `ORIEL_SECRETS_KEY` prevents the server from starting, with an explicit message.

### Server

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | empty (`https://${DOMAIN}` with Docker) | Public address, without trailing slash. Used for invitation and e-mail links, `Secure` cookies, passkeys and SSO. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listening port and address (`127.0.0.1` behind a local proxy). |
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds `oriel.db`, `uploads/` and, by default, `secret.key`. |
| `WEB_DIST` | auto-detected | Folder of the compiled web client. |
| `SIGNUP_MODE` | `first-user` | **Initial** sign-up mode: `first-user`, `invite` or `open`. Afterwards the administrator changes it in the settings (the stored value wins). |
| `MAX_UPLOAD_MB` | `25` | Maximum size of an uploaded file. |
| `TRUST_PROXY` | `true` in Docker and systemd | Which peers may set `X-Forwarded-*`: `true` = loopback and private networks; `false` = none; or a comma-separated list of IPs / CIDR ranges (e.g. `private,173.245.48.0/20`). |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `AUTH_RATE_LIMIT` | `10` | Sign-in and sign-up attempts per minute and per IP address. |
| `ORIEL_EMBED_ORIGINS` | — | Extra `https` origins allowed in generic embed blocks, comma-separated. |
| `ORIEL_SECRETS_KEY` | — (`DATA_DIR/secret.key`) | Encryption key of two-factor secrets, at least 32 characters (see [section 12](#12-two-factor-authentication-and-passkeys)). |
| `ORIEL_LOCAL_MODE` | — | **Reserved for the macOS app.** Never set it on a server: every local request is signed in as administrator. |

Docker only (`deploy/.env`): `DOMAIN` (served by Caddy, required) and `ACME_EMAIL` (Let's Encrypt
account, required). `docker-compose.yml` sets `DATA_DIR=/data`, `WEB_DIST=/app/web`, `HOST=0.0.0.0`,
`PORT=3000` and `NODE_ENV=production`.

### E-mail, AI, maps, SSO

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_URL` | — | Full SMTP URL, e.g. `smtps://user:password@smtp.example.com:465` (takes precedence). `json` prints e-mails to the log instead of sending them (development). |
| `SMTP_HOST` / `SMTP_PORT` | — / `587` | SMTP server when `SMTP_URL` is not used. |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP credentials. |
| `SMTP_SECURE` | `true` on port 465 only | `true` for direct TLS. |
| `MAIL_FROM` | `Oriel <no-reply@<PUBLIC_URL domain>>` | Sender of the e-mails. |
| `ANTHROPIC_API_KEY` | — | API key of the daily brief (overrides the key saved in the settings). |
| `MAP_TILE_URL` | OpenStreetMap standard tiles | Map background: `https://…` or `/…` URL with `{z}`, `{x}`, `{y}`; `off` for maps without background. |
| `MAP_TILE_ATTRIBUTION` | OpenStreetMap credit with the default tiles | Credit shown on the map (plain text). |
| `MAP_TILE_MAX_ZOOM` | `19` | Maximum zoom (1 to 22). |
| `GEOCODER_URL` | — (disabled) | Base URL of a Nominatim-compatible geocoder (the server appends `/search`). |
| `GEOCODER_ALLOW_PRIVATE` | — | `1` allows a geocoder on a private or loopback address. |
| `OIDC_ISSUER` | — (disabled) | Exact OpenID Connect issuer, in `https`. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Confidential client registered at the provider. |
| `OIDC_LABEL` | `SSO` | Label of the "Continuer avec …" sign-in button. |
| `OIDC_SCOPES` | `openid email profile` | Requested scopes (`openid` is always added). |

### MCP server and development

| Variable | Purpose |
|---|---|
| `ORIEL_URL`, `ORIEL_TOKEN`, `ORIEL_WORKSPACE` | MCP server: instance address, personal API token (`or_…`), default workspace. |
| `ORIEL_MCP_PORT`, `ORIEL_MCP_HOST` | MCP server in HTTP mode (defaults `3333`, `127.0.0.1`). |
| `ORIEL_API` | Development: API address used by the Vite proxy (default `http://127.0.0.1:3001`). |
| `ORIEL_AI_FAKE`, `ORIEL_AI_FAKE_DELAY_MS` | Tests and demos: simulated AI, no network call. |

---

## 7. First administrator account and sign-up modes

1. Open the instance address.
2. Create the **first account**: it becomes the **instance administrator** and gets a workspace.
3. Do it right after the installation: until an account exists, the first visitor becomes
   administrator.

Sign-up modes (initial value `SIGNUP_MODE`, then **Réglages › Instance**):

| Mode | Behavior |
|---|---|
| `first-user` (default) | Only the first account can sign up freely; everyone else joins through an invitation link. |
| `invite` | Sign-up always requires an invitation. |
| `open` | Anyone who reaches the instance can create an account (and their own workspace). |

To invite people: **Réglages › Membres › Inviter**, choose the role (administrator, member, reader),
then copy the link (valid 7 days by default, revocable) or send it by e-mail if SMTP is configured.
Links are built from `PUBLIC_URL`.

---

## 8. E-mail (SMTP)

With an SMTP server, Oriel sends invitations by e-mail, "forgot password" links and notifications
(mentions, comments, replies, reminders), either immediately or as a daily digest, as chosen by each
user in **Réglages › Notifications**.

```dotenv
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=Oriel <notes@example.com>
PUBLIC_URL=https://notes.example.com
```

Administrators can check the configuration with **Réglages › Notifications › Envoyer un e-mail de
test** (send a test e-mail).
Without SMTP everything else works: invitations are links to copy, and an administrator creates
password reset links (valid 24 hours, single use) in **Réglages › Instance › Utilisateurs**.

---

## 9. AI key (daily brief)

The optional **daily brief** ("Brief du jour") gives each workspace a scheduled summary: priorities,
overdue items, deadlines of the week, risks and a status per project, based on the project databases
you select. It uses the Anthropic API (default model `claude-opus-5-5`) and reads only the
workspace's shared pages, never private pages or the trash.

- Set `ANTHROPIC_API_KEY` in the environment, **or** let an instance administrator save a key in
  **Réglages › IA** (the environment variable wins).
- Workspace owners and administrators enable the brief, pick the source databases, the model, the
  days and time, and a monthly budget per workspace in the same tab.
- An instance-wide monthly cap (50 USD by default) can be changed by an instance administrator;
  `0` disables the feature on the whole instance.

Without a key, the feature stays inactive. `ORIEL_AI_FAKE=1` simulates the model for tests and
demonstrations.

---

## 10. Maps and geocoding

**Map** views place the rows of a database according to a **Place** property (address and
coordinates). By default, the browser of each reader downloads OpenStreetMap tiles directly from the
OpenStreetMap Foundation, whose [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
targets moderate use. For a large team, use a commercial provider or your own tile server
(`MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `MAP_TILE_MAX_ZOOM`), or `MAP_TILE_URL=off`.

Address search in Place cells is **disabled by default**. To enable it, point `GEOCODER_URL` to a
Nominatim-compatible service (your own instance, or the public service within its usage limits):

```dotenv
GEOCODER_URL=https://nominatim.example.com
```

Requests always go through the Oriel server (never directly from browsers), with a timeout, a size
limit, a rate limit (one request per second overall, a per-user cap) and a 30-day cache; private
addresses are refused unless `GEOCODER_ALLOW_PRIVATE=1`. Without a geocoder, addresses are free text;
coordinates typed by hand (e.g. `48.8566, 2.3522`) still place the row on the map.

---

## 11. Single sign-on (OIDC)

Oriel supports OpenID Connect providers such as Authentik, Keycloak, Google Workspace, Microsoft
Entra ID or Okta. SAML is not supported.

1. At the provider, create a **confidential** client (`client_secret_basic` authentication) with
   the redirect URL `https://notes.example.com/api/auth/oidc/callback`.
2. Configure Oriel:
   ```dotenv
   PUBLIC_URL=https://notes.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/oriel/
   OIDC_CLIENT_ID=oriel
   OIDC_CLIENT_SECRET=change-me
   OIDC_LABEL=Company SSO
   ```
3. Restart. The sign-in page shows a "Continuer avec …" (continue with) button.

Rules: a new identity whose e-mail matches an existing account is refused until that person signs in
with their password and links the identity in **Réglages › Sécurité**. New accounts follow the
sign-up mode, except addresses (verified by the provider) of a **verified domain** with automatic
join: a workspace administrator proves the domain with a DNS TXT record `_oriel.<domain>`
(**Réglages › Sécurité › Domaines vérifiés**).

---

## 12. Two-factor authentication and passkeys

Each user can protect their account in **Réglages › Sécurité**:

- **Authenticator app** (TOTP), with 10 single-use recovery codes;
- **Passkeys** (WebAuthn), available only when `PUBLIC_URL` uses `https` (or `http://localhost` in
  development). The relying-party identifier is the host name of `PUBLIC_URL`: changing the domain
  invalidates the registered passkeys.

Workspace administrators can **require** two-factor authentication for all members, with a grace
period. Instance administrators can reset the second factor of a user who lost it.

TOTP secrets are encrypted at rest with a key derived from `ORIEL_SECRETS_KEY` or, if it is not set,
from `DATA_DIR/secret.key` (created on first use, mode 0600). **Back this key up**: without it,
authenticator apps can no longer be checked (recovery codes and passkeys keep working) and an
administrator must reset the affected accounts. `deploy/backup.sh` does **not** include
`secret.key`; store it separately, or use `ORIEL_SECRETS_KEY`, which is part of the `deploy/.env`
copy included in each archive.

```bash
openssl rand -base64 48      # a suitable value for ORIEL_SECRETS_KEY
```

---

## 13. Backup and restore

### Back up

```bash
sudo ./deploy/backup.sh                             # Docker
sudo ./deploy/backup.sh --data-dir /var/lib/oriel   # systemd install
```

- **Hot and consistent**: the database is copied with `VACUUM INTO` (transactional SQLite snapshot,
  users are not interrupted) and checked with `PRAGMA integrity_check`.
- The archive `deploy/backups/oriel-YYYYMMDD-HHMMSS.tar.gz` contains `oriel.db`, `uploads/`, a copy
  of `deploy/.env` and a `MANIFEST`.
- The last **14** archives are kept (`--keep N`); another folder: `--output DIR`.
- `install.sh` can schedule a daily backup (`/etc/cron.d/oriel-backup`, log
  `/var/log/oriel-backup.log`).

**Copy the archives off the server**, for example from your computer:

```bash
rsync -av user@server:oriel/deploy/backups/ ~/Backups/oriel/
```

### Restore

```bash
sudo ./deploy/restore.sh deploy/backups/oriel-20261013-031500.tar.gz
sudo ./deploy/restore.sh --data-dir /var/lib/oriel <archive>        # systemd install
```

The script checks the archive and the integrity of the database **before** touching anything, asks
for confirmation, stops Oriel, moves the current database to `<data>/pre-restore-<date>/`, copies the
archived database and files, restarts and waits for `/api/health`.

On a **new server**: install Oriel first (same domain), then restore. The original configuration is in
the `env` file of the archive; restore `secret.key` too if you do not use `ORIEL_SECRETS_KEY`.

---

## 14. Updating

With Docker:

```bash
cd oriel
sudo ./deploy/backup.sh
git pull
cd deploy && sudo docker compose up -d --build
sudo docker image prune -f
```

With systemd:

```bash
cd oriel && git pull && npm ci && npm run build
sudo ./deploy/backup.sh --data-dir /var/lib/oriel
sudo cp server/dist/server.cjs /opt/oriel/ && sudo rm -rf /opt/oriel/web && sudo cp -R web/dist /opt/oriel/web
sudo systemctl restart oriel
```

Database migrations run automatically at startup. For the macOS app, build the new `.dmg` and replace
the application; local data is kept.

---

## 15. MCP server (Claude)

The MCP server lets Claude Desktop or Claude Code read, write and query your pages and databases with
your permissions, through a personal API token.

1. In Oriel: **Réglages › API et MCP › Nouveau jeton** (read only, or read and write; optionally
   limited to one workspace and with an expiration). The token (`or_…`) is shown once.
2. Build the server in your copy of the repository:
   ```bash
   npm ci
   npm run build -w mcp        # → mcp/dist/oriel-mcp.mjs (run it from the repository)
   ```
3. Declare it in Claude Code:
   ```bash
   claude mcp add oriel \
     --env ORIEL_URL=https://notes.example.com \
     --env ORIEL_TOKEN=or_YOUR_TOKEN \
     -- node /path/to/oriel/mcp/dist/oriel-mcp.mjs
   ```
   or in Claude Desktop (`claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "oriel": {
         "command": "node",
         "args": ["/path/to/oriel/mcp/dist/oriel-mcp.mjs"],
         "env": { "ORIEL_URL": "https://notes.example.com", "ORIEL_TOKEN": "or_YOUR_TOKEN" }
       }
     }
   }
   ```

An HTTP mode (`--http --port 3333`, behind your HTTPS proxy) serves a whole team, each member using
their own token. Tools, Markdown conventions and security: [MCP.md](MCP.md).

---

## 16. Troubleshooting

**Logs**

```bash
cd deploy && sudo docker compose logs -f oriel    # Docker (one JSON line per event)
sudo docker compose logs -f caddy                 # certificates, proxy
journalctl -u oriel -f                            # systemd
```

For more detail, set `LOG_LEVEL=debug` and restart.

**No HTTPS certificate** (TLS error in the browser): `dig +short <domain>` must return the server's IP
(watch out for a stale AAAA record); ports 80 **and** 443 must be reachable from the Internet
(hosting provider firewall, ufw); `docker compose logs caddy` gives the cause. After repeated
failures Let's Encrypt rate-limits: fix, then wait.

**502 Bad Gateway**: the proxy answers but Oriel does not. Check `docker compose ps` (unhealthy?) or
`systemctl status oriel`, then the logs: full disk, invalid variable.

**Collaborative editing or live updates do not work** ("offline" indicator, other people's changes
appear only after a reload): the proxy must forward **WebSockets** on `/collab` and `/api/events`
with idle timeouts above 60 seconds (automatic with Caddy and Traefik; see the nginx example).
Behind Cloudflare, enable WebSockets, and list Cloudflare's ranges in `TRUST_PROXY` if it reaches
Oriel without a local proxy. Quick check:

```bash
curl -si -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://notes.example.com/api/events | head -1
```

`HTTP/1.1 101` or `401` (not signed in) means the upgrade goes through; `400` or `404` from the proxy
points to its configuration.

**Sign-in does not stick** (back to the sign-in page): `PUBLIC_URL` must use `https://` and match the
address in the browser; `TRUST_PROXY` must cover the proxy.

**Upload refused (413)**: raise `MAX_UPLOAD_MB` and, with nginx, `client_max_body_size`.

**Image build fails (memory)**: add swap (offered by `install.sh`) or build elsewhere.

**ufw and Docker**: ports published by Docker bypass ufw rules. Only 80 and 443 (Caddy) are
published by `docker-compose.yml`; never publish port 3000 on all interfaces.

**Passkeys unavailable**: `PUBLIC_URL` must be an `https` address.

**macOS app**: if the local server does not start, a dialog shows the end of its log
(**Aide › Afficher les journaux dans le Finder** opens the full log). A downloaded app blocked by
Gatekeeper: see [section 4.2](#42-open-an-unsigned-app-gatekeeper).

**Start over** (⚠️ deletes all data, Docker): `sudo docker compose down -v`.
