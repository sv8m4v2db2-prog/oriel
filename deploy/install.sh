#!/usr/bin/env bash
# Oriel — installation sur un VPS Debian / Ubuntu.
#
#   git clone <url-du-dépôt> oriel && cd oriel
#   sudo ./deploy/install.sh
#
# Le script :
#   1. vérifie le système (Debian/Ubuntu, mémoire, disque, ports 80/443) ;
#   2. installe Docker Engine + le plugin Compose depuis le dépôt APT officiel de Docker ;
#   3. demande le nom de domaine et l'e-mail Let's Encrypt, écrit deploy/.env ;
#   4. configure le pare-feu ufw (optionnel) et une sauvegarde quotidienne (optionnel) ;
#   5. lance « docker compose up -d --build », attend qu’Oriel soit en bonne santé et affiche l'URL.
#
# Il peut être relancé sans risque : Docker n'est pas réinstallé, deploy/.env est conservé
# (seules les valeurs demandées sont mises à jour), les règles et tâches sont réécrites à l'identique.
#
# Options :
#   --domain NOM          nom de domaine (sinon demandé)
#   --email ADRESSE       e-mail pour Let's Encrypt (sinon demandé)
#   --signup MODE         first-user | invite | open
#   --firewall / --no-firewall        configurer ufw sans poser la question / ne pas y toucher
#   --backup-cron / --no-backup-cron  programmer (ou non) la sauvegarde quotidienne
#   -y, --yes             aucune question : valeurs existantes ou par défaut
#   -h, --help            cette aide
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

ARG_DOMAIN=""
ARG_EMAIL=""
ARG_SIGNUP=""
FIREWALL="ask"
BACKUP_CRON="ask"
ASSUME_YES=0
ORIG_ARGS=("$@")

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' BLUE=$'\e[34m' RESET=$'\e[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" RESET=""
fi

info() { printf '%s==>%s %s\n' "$BLUE$BOLD" "$RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2
  exit 1
}
trap 'die "Échec inattendu ligne $LINENO : $BASH_COMMAND"' ERR

usage() {
  sed -n '2,/^set -Eeuo/p' "$SCRIPT_PATH" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) ARG_DOMAIN="${2:-}"; shift 2 ;;
    --domain=*) ARG_DOMAIN="${1#*=}"; shift ;;
    --email) ARG_EMAIL="${2:-}"; shift 2 ;;
    --email=*) ARG_EMAIL="${1#*=}"; shift ;;
    --signup) ARG_SIGNUP="${2:-}"; shift 2 ;;
    --signup=*) ARG_SIGNUP="${1#*=}"; shift ;;
    --firewall) FIREWALL="yes"; shift ;;
    --no-firewall) FIREWALL="no"; shift ;;
    --backup-cron) BACKUP_CRON="yes"; shift ;;
    --no-backup-cron) BACKUP_CRON="no"; shift ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help) usage ;;
    *) die "Option inconnue : $1 (voir --help)" ;;
  esac
done

# Root obligatoire (APT, Docker, pare-feu) : relance via sudo si besoin.
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "Lancez ce script en tant que root."
  info "Droits administrateur nécessaires, relance avec sudo…"
  exec sudo -E bash "$SCRIPT_PATH" "${ORIG_ARGS[@]}"
fi

# --- Saisie ------------------------------------------------------------------------------------

can_prompt() {
  [[ $ASSUME_YES -eq 0 ]] && { true </dev/tty; } 2>/dev/null
}

# ask VAR "Question" "défaut"
ask() {
  local __var=$1 prompt=$2 default=${3-} reply=""
  if ! can_prompt; then
    printf -v "$__var" '%s' "$default"
    return 0
  fi
  [[ -n $default ]] && prompt+=" ${DIM}[$default]${RESET}"
  read -r -p "$prompt : " reply </dev/tty || true
  printf -v "$__var" '%s' "${reply:-$default}"
}

# confirm "Question" o|n  → code 0 si oui
confirm() {
  local prompt=$1 default=${2:-o} reply=""
  if ! can_prompt; then
    [[ $default == o ]]
    return
  fi
  local hint="[O/n]"
  [[ $default == n ]] && hint="[o/N]"
  read -r -p "$prompt $hint " reply </dev/tty || true
  reply=${reply:-$default}
  [[ $reply =~ ^[oOyY] ]]
}

# --- .env ---------------------------------------------------------------------------------------

env_get() {
  [[ -f $ENV_FILE ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

env_set() {
  local key=$1 value=$2 tmp
  tmp="$(mktemp)"
  if [[ -f $ENV_FILE ]] && grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" >"$tmp"
  else
    { [[ -f $ENV_FILE ]] && cat "$ENV_FILE"; printf '%s=%s\n' "$key" "$value"; } >"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}

# --- Étapes -------------------------------------------------------------------------------------

DOCKER_DISTRO=""
CODENAME=""
ARCH=""

check_system() {
  info "Vérification du système"
  [[ -r /etc/os-release ]] || die "Système non reconnu (/etc/os-release absent)."
  local id id_like codename ubuntu_codename debian_codename pretty
  id="$(. /etc/os-release && echo "${ID:-}")"
  id_like="$(. /etc/os-release && echo "${ID_LIKE:-}")"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  ubuntu_codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-}")"
  debian_codename="$(. /etc/os-release && echo "${DEBIAN_CODENAME:-}")"
  pretty="$(. /etc/os-release && echo "${PRETTY_NAME:-inconnu}")"
  case "$id" in
    debian | ubuntu) DOCKER_DISTRO="$id"; CODENAME="$codename" ;;
    *)
      if [[ " $id_like " == *" ubuntu "* ]]; then
        DOCKER_DISTRO="ubuntu"; CODENAME="${ubuntu_codename:-$codename}"
      elif [[ " $id_like " == *" debian "* ]]; then
        DOCKER_DISTRO="debian"; CODENAME="${debian_codename:-$codename}"
      else
        die "Ce script prend en charge Debian et Ubuntu (système détecté : $pretty)."
      fi
      ;;
  esac
  [[ -n $CODENAME ]] || die "Impossible de déterminer la version de $pretty."
  command -v dpkg >/dev/null 2>&1 || die "dpkg introuvable : système Debian/Ubuntu attendu."
  ARCH="$(dpkg --print-architecture)"
  ok "$pretty ($ARCH)"
  case "$ARCH" in
    amd64 | arm64) ;;
    *) warn "Architecture $ARCH non testée : l'installation peut échouer." ;;
  esac

  [[ -f "$REPO_DIR/Dockerfile" && -f $COMPOSE_FILE ]] ||
    die "Lancez ce script depuis une copie complète du dépôt Oriel (Dockerfile introuvable dans $REPO_DIR)."

  local mem_kb swap_kb free_kb
  mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  swap_kb="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)"
  if ((mem_kb < 1900000 && swap_kb < 1000000)); then
    warn "Mémoire : $((mem_kb / 1024)) Mo sans fichier d'échange. La construction de l'image peut en manquer."
    if confirm "Créer un fichier d'échange de 2 Go (/swapfile) ?" o; then
      create_swap
    fi
  else
    ok "Mémoire : $((mem_kb / 1024)) Mo (+ $((swap_kb / 1024)) Mo d'échange)"
  fi

  free_kb="$(df -Pk / | awk 'NR == 2 { print $4 }')"
  if ((free_kb < 4000000)); then
    warn "Espace disque libre : $((free_kb / 1024)) Mo. Prévoyez au moins 4 Go (images Docker + données)."
  else
    ok "Espace disque libre : $((free_kb / 1024 / 1024)) Go"
  fi
}

create_swap() {
  if [[ -e /swapfile ]]; then
    swapon --show=NAME --noheadings 2>/dev/null | grep -qx /swapfile || swapon /swapfile || true
  else
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  ok "Fichier d'échange /swapfile actif"
}

check_ports() {
  command -v ss >/dev/null 2>&1 || return 0
  local port users
  for port in 80 443; do
    users="$(ss -Hltnp "sport = :$port" 2>/dev/null | grep -v -e docker-proxy -e '"caddy"' || true)"
    if [[ -n $users ]]; then
      warn "Le port $port est déjà utilisé par un autre service :"
      printf '    %s\n' "$users" >&2
      warn "Arrêtez-le (ex. systemctl disable --now apache2 nginx) ou utilisez votre propre proxy (docs/DEPLOY.md)."
      confirm "Continuer malgré tout ?" n || exit 1
    fi
  done
}

install_prerequisites() {
  export DEBIAN_FRONTEND=noninteractive
  local missing=()
  local pkg
  for pkg in ca-certificates curl; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if ((${#missing[@]} > 0)); then
    info "Installation de : ${missing[*]}"
    apt-get update -qq
    apt-get install -y -qq "${missing[@]}" >/dev/null
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then
    ok "$(docker --version), $(docker compose version | head -n 1)"
    systemctl is-active --quiet docker || systemctl enable --now docker
    return 0
  fi

  info "Installation de Docker Engine depuis le dépôt officiel download.docker.com"
  export DEBIAN_FRONTEND=noninteractive

  # Paquets non officiels incompatibles avec docker-ce (procédure documentée par Docker).
  local conflicts=() pkg
  for pkg in docker.io docker-doc docker-compose docker-compose-v2 docker-buildx podman-docker containerd runc; do
    dpkg -s "$pkg" >/dev/null 2>&1 && conflicts+=("$pkg")
  done
  if ((${#conflicts[@]} > 0)); then
    warn "Paquets Docker de la distribution détectés : ${conflicts[*]}"
    confirm "Les remplacer par Docker Engine officiel (images et volumes existants conservés) ?" o ||
      die "Installation interrompue : Docker Compose v2 et buildx sont nécessaires."
    apt-get remove -y -qq "${conflicts[@]}" >/dev/null
  fi

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$ARCH" "$DOCKER_DISTRO" "$CODENAME" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose est introuvable après l'installation."
  ok "$(docker --version), $(docker compose version | head -n 1)"
}

configure_env() {
  info "Configuration"
  if [[ ! -f $ENV_FILE ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    env_set DOMAIN ""
    env_set ACME_EMAIL ""
  fi
  chmod 600 "$ENV_FILE"

  local domain email signup current
  current="$(env_get DOMAIN)"
  [[ $current == "notes.example.com" ]] && current=""
  domain="${ARG_DOMAIN:-}"
  while true; do
    [[ -n $domain ]] || ask domain "Nom de domaine de votre instance (ex. notes.mondomaine.fr)" "$current"
    domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')"
    if [[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$ ]]; then
      break
    fi
    can_prompt || die "Nom de domaine invalide ou manquant (option --domain)."
    warn "« $domain » n'est pas un nom de domaine valide."
    domain=""
  done

  current="$(env_get ACME_EMAIL)"
  [[ $current == "admin@example.com" ]] && current=""
  email="${ARG_EMAIL:-}"
  while true; do
    [[ -n $email ]] || ask email "E-mail pour Let's Encrypt (alertes de certificat)" "$current"
    if [[ $email =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
      break
    fi
    can_prompt || die "Adresse e-mail invalide ou manquante (option --email)."
    warn "« $email » n'est pas une adresse e-mail valide."
    email=""
  done

  signup="${ARG_SIGNUP:-$(env_get SIGNUP_MODE)}"
  signup="${signup:-first-user}"
  case "$signup" in
    first-user | invite | open) ;;
    *) die "Mode d'inscription invalide : $signup (first-user, invite ou open)." ;;
  esac

  env_set DOMAIN "$domain"
  env_set ACME_EMAIL "$email"
  env_set PUBLIC_URL "https://$domain"
  env_set SIGNUP_MODE "$signup"
  [[ -n "$(env_get MAX_UPLOAD_MB)" ]] || env_set MAX_UPLOAD_MB 25
  [[ -n "$(env_get LOG_LEVEL)" ]] || env_set LOG_LEVEL info
  DOMAIN="$domain"
  ok "deploy/.env : DOMAIN=$domain, ACME_EMAIL=$email, SIGNUP_MODE=$signup"
}

check_dns() {
  local resolved local_ips ip match=0
  resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)"
  if [[ -z ${resolved// /} ]]; then
    warn "Le domaine $DOMAIN ne pointe vers aucune adresse IP."
    warn "Créez un enregistrement DNS A (et AAAA en IPv6) vers ce serveur : sans lui, aucun certificat HTTPS."
    confirm "Continuer quand même ?" n || exit 1
    return 0
  fi
  local_ips=" $(hostname -I 2>/dev/null || true) "
  for ip in $resolved; do
    [[ $local_ips == *" $ip "* ]] && match=1
  done
  if ((match)); then
    ok "DNS : $DOMAIN → $resolved"
  else
    warn "DNS : $DOMAIN → $resolved, adresse absente des interfaces de ce serveur."
    warn "C'est normal derrière un NAT ou un proxy ; sinon corrigez l'enregistrement DNS."
  fi
}

configure_firewall() {
  [[ $FIREWALL == no ]] && return 0
  if ! command -v ufw >/dev/null 2>&1; then
    if [[ $FIREWALL == yes ]] || confirm "Installer et activer le pare-feu ufw (SSH, HTTP, HTTPS autorisés) ?" n; then
      apt-get install -y -qq ufw >/dev/null
    else
      return 0
    fi
  elif [[ $FIREWALL == ask ]] && ! confirm "Configurer le pare-feu ufw (SSH, HTTP, HTTPS autorisés) ?" o; then
    return 0
  fi
  local ssh_port
  ssh_port="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
  ssh_port="${ssh_port:-22}"
  ufw allow "$ssh_port/tcp" comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'Oriel HTTP' >/dev/null
  ufw allow 443/tcp comment 'Oriel HTTPS' >/dev/null
  ufw allow 443/udp comment 'Oriel HTTP/3' >/dev/null
  ufw --force enable >/dev/null
  ok "Pare-feu ufw actif : ports $ssh_port/tcp (SSH), 80/tcp, 443/tcp et 443/udp ouverts"
}

compose() {
  # docker-compose.override.yml (ex. variante Nginx, docs/DEPLOY.md) est pris en compte s'il existe.
  local files=(-f "$COMPOSE_FILE")
  if [[ -f "$SCRIPT_DIR/docker-compose.override.yml" ]]; then files+=(-f "$SCRIPT_DIR/docker-compose.override.yml"); fi
  docker compose --project-directory "$SCRIPT_DIR" "${files[@]}" "$@"
}

start_stack() {
  info "Construction de l'image et démarrage (plusieurs minutes la première fois)…"
  compose up -d --build --remove-orphans
}

wait_healthy() {
  info "Attente du démarrage d’Oriel"
  local cid status="inconnu" i
  for ((i = 0; i < 90; i++)); do
    cid="$(compose ps -q oriel 2>/dev/null || true)"
    if [[ -n $cid ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo inconnu)"
      case "$status" in
        healthy)
          ok "Oriel est en bonne santé"
          return 0
          ;;
        unhealthy | exited | dead) break ;;
      esac
    fi
    sleep 2
  done
  warn "Oriel ne répond pas (état : $status). Dernières lignes du journal :"
  compose logs --tail=40 oriel >&2 || true
  return 1
}

check_https() {
  info "Vérification de https://$DOMAIN (obtention du certificat)"
  local i
  for ((i = 0; i < 30; i++)); do
    if curl -fsS --max-time 5 -o /dev/null "https://$DOMAIN/api/health" 2>/dev/null; then
      ok "HTTPS opérationnel"
      return 0
    fi
    sleep 4
  done
  warn "https://$DOMAIN ne répond pas encore. Causes fréquentes : DNS pas encore propagé, ports 80/443"
  warn "fermés chez l'hébergeur. Caddy réessaie tout seul ; journal : docker compose -f deploy/docker-compose.yml logs caddy"
  compose logs --tail=15 caddy >&2 || true
  return 1
}

install_backup_cron() {
  [[ $BACKUP_CRON == no ]] && return 0
  if [[ $BACKUP_CRON == ask ]] && ! confirm "Programmer une sauvegarde quotidienne (3 h 15, 14 conservées) ?" o; then
    return 0
  fi
  if ! command -v cron >/dev/null 2>&1 && [[ ! -d /etc/cron.d ]]; then
    apt-get install -y -qq cron >/dev/null
  fi
  cat >/etc/cron.d/oriel-backup <<EOF
# Oriel — sauvegarde quotidienne (créé par deploy/install.sh). Journal : /var/log/oriel-backup.log
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root "$SCRIPT_DIR/backup.sh" >>/var/log/oriel-backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/oriel-backup
  chmod +x "$SCRIPT_DIR/backup.sh" "$SCRIPT_DIR/restore.sh" 2>/dev/null || true
  ok "Sauvegarde quotidienne programmée (/etc/cron.d/oriel-backup → $SCRIPT_DIR/backups)"
}

summary() {
  local healthy=$1
  local rel_compose="${COMPOSE_FILE#"$REPO_DIR"/}"
  echo
  if ((healthy)); then
    printf '%s%sOriel est en ligne : https://%s%s\n' "$GREEN" "$BOLD" "$DOMAIN" "$RESET"
  else
    printf '%s%sInstallation terminée, mais Oriel ne répond pas encore sur https://%s%s\n' "$YELLOW" "$BOLD" "$DOMAIN" "$RESET"
  fi
  cat <<EOF

Étapes suivantes :
  1. Ouvrez https://$DOMAIN et créez le premier compte : il devient administrateur de l'instance.
  2. Invitez votre équipe : Réglages › Membres › Inviter, puis envoyez le lien d'invitation.
  3. Application macOS : au premier lancement, choisissez « Se connecter à un serveur »
     et saisissez https://$DOMAIN

Commandes utiles (depuis $REPO_DIR) :
  Journaux        sudo docker compose -f $rel_compose logs -f oriel
  Mise à jour     git pull && sudo docker compose -f $rel_compose up -d --build
  Sauvegarde      sudo ./deploy/backup.sh
  Restauration    sudo ./deploy/restore.sh deploy/backups/<archive>.tar.gz
  Configuration   deploy/.env, puis : sudo docker compose -f $rel_compose up -d

Documentation complète : docs/DEPLOY.md
EOF
}

main() {
  printf '\n%sOriel — installation du serveur%s\n\n' "$BOLD" "$RESET"
  check_system
  install_prerequisites
  check_ports
  install_docker
  configure_env
  check_dns
  configure_firewall
  start_stack
  local healthy=1
  wait_healthy || healthy=0
  if ((healthy)); then
    check_https || healthy=0
  fi
  install_backup_cron
  summary "$healthy"
}

main
