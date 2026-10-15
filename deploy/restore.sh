#!/usr/bin/env bash
# Oriel — restauration d'une archive créée par deploy/backup.sh.
#
#   sudo ./deploy/restore.sh deploy/backups/oriel-20261013-031500.tar.gz
#   sudo ./deploy/restore.sh --data-dir /var/lib/oriel <archive>     # installation sans Docker
#
# Déroulement :
#   1. vérifie l'archive et l'intégrité de la base qu'elle contient ;
#   2. arrête Oriel ;
#   3. met de côté la base actuelle dans <données>/pre-restore-AAAAMMJJ-HHMMSS/ (rien n'est effacé) ;
#   4. copie la base de l'archive et y ajoute ses fichiers envoyés (les fichiers existants sont gardés) ;
#   5. redémarre Oriel et attend /api/health.
#
# Options :
#   --data-dir DIR    restaure une installation sans Docker (DATA_DIR du service systemd)
#   --service NOM     service systemd à arrêter/redémarrer avec --data-dir (défaut : oriel)
#   -y, --yes         ne pas demander de confirmation
#   -h, --help        cette aide
#
# deploy/.env n'est jamais modifié ; la configuration sauvegardée est dans le fichier « env » de l'archive.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
NATIVE_DATA_DIR=""
SERVICE="oriel"
ASSUME_YES=0
ARCHIVE=""
NODE_BIN="${NODE_BIN:-node}"

die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}
log() { printf '==> %s\n' "$*"; }
trap 'die "Échec ligne $LINENO : $BASH_COMMAND"' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) NATIVE_DATA_DIR="${2:-}"; shift 2 ;;
    --data-dir=*) NATIVE_DATA_DIR="${1#*=}"; shift ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --service=*) SERVICE="${1#*=}"; shift ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help) sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Option inconnue : $1 (voir --help)" ;;
    *)
      [[ -z $ARCHIVE ]] || die "Une seule archive à la fois."
      ARCHIVE="$1"
      shift
      ;;
  esac
done
[[ -n $ARCHIVE ]] || die "Indiquez l'archive à restaurer (voir --help)."
[[ -f $ARCHIVE ]] || die "Archive introuvable : $ARCHIVE"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

# Contrôle de la base restaurée (exécuté avec le Node.js d’Oriel).
CHECK_JS="$(
  cat <<'JS'
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(process.argv[1], { readOnly: true });
  const check = Object.values(db.prepare("PRAGMA integrity_check").get())[0];
  if (check !== "ok") throw new Error("contrôle d'intégrité : " + check);
  const { n } = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'workspaces', 'pages')")
    .get();
  if (n < 3) throw new Error("ce fichier ne ressemble pas à une base Oriel");
  db.close();
} catch (err) {
  console.error("Base illisible : " + err.message);
  process.exit(3);
}
console.log("ok");
JS
)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oriel-restore.XXXXXX")"
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT

log "Lecture de l'archive $(basename "$ARCHIVE")"
tar -C "$WORK" -xzf "$ARCHIVE"
shopt -s nullglob
dirs=("$WORK"/oriel-*/)
shopt -u nullglob
((${#dirs[@]} == 1)) || die "Archive inattendue : un dossier oriel-AAAAMMJJ-HHMMSS/ est attendu."
SRC="${dirs[0]%/}"
SRC_DB="oriel.db"
[[ -f "$SRC/$SRC_DB" ]] || die "L'archive ne contient pas oriel.db."
[[ -f "$SRC/MANIFEST" ]] && sed 's/^/    /' "$SRC/MANIFEST"

confirm() {
  ((ASSUME_YES)) && return 0
  { true </dev/tty; } 2>/dev/null || die "Confirmation impossible sans terminal : relancez avec --yes."
  local reply=""
  read -r -p "$1 [o/N] " reply </dev/tty || true
  [[ $reply =~ ^[oOyY] ]]
}

STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -z $NATIVE_DATA_DIR ]]; then
  # --- Instance Docker ------------------------------------------------------------------------
  command -v docker >/dev/null 2>&1 || die "Docker est introuvable (utilisez --data-dir pour une installation sans Docker)."
  compose() {
    # docker-compose.override.yml (ex. variante Nginx, docs/DEPLOY.md) est pris en compte s'il existe.
    local files=(-f "$COMPOSE_FILE")
    if [[ -f "$SCRIPT_DIR/docker-compose.override.yml" ]]; then files+=(-f "$SCRIPT_DIR/docker-compose.override.yml"); fi
    docker compose --project-directory "$SCRIPT_DIR" "${files[@]}" "$@"
  }
  # Conteneur ponctuel (image Oriel, volume oriel-data monté sur /data, archive en lecture seule).
  oneshot() {
    compose run --rm --no-deps -T --user root -v "$SRC:/restore:ro" -e CHECK_JS="$CHECK_JS" -e STAMP="$STAMP" -e SRC_DB="$SRC_DB" \
      --entrypoint sh oriel -c "$1"
  }

  log "Vérification de la base sauvegardée"
  oneshot 'cp "/restore/$SRC_DB" /tmp/check.db && node --disable-warning=ExperimentalWarning -e "$CHECK_JS" /tmp/check.db' >/dev/null ||
    die "La base contenue dans l'archive est invalide : restauration annulée, rien n'a été modifié."

  confirm "Remplacer les données actuelles d’Oriel par cette sauvegarde ?" || die "Restauration annulée."

  log "Arrêt d’Oriel"
  compose stop oriel

  log "Restauration (base actuelle conservée dans /data/pre-restore-$STAMP/)"
  oneshot '
    set -e
    keep="/data/pre-restore-$STAMP"
    mkdir -p "$keep"
    for f in oriel.db oriel.db-wal oriel.db-shm; do
      if [ -e "/data/$f" ]; then mv "/data/$f" "$keep/"; fi
    done
    cp "/restore/$SRC_DB" /data/oriel.db
    if [ -d /restore/uploads ]; then
      mkdir -p /data/uploads
      cp -R /restore/uploads/. /data/uploads/
    fi
    chown -R node:node /data/oriel.db /data/uploads "$keep" 2>/dev/null || chown node:node /data/oriel.db
  '

  log "Redémarrage d’Oriel"
  compose up -d oriel
  for ((i = 0; i < 60; i++)); do
    cid="$(compose ps -q oriel)"
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo inconnu)"
    if [[ $status == healthy ]]; then
      log "Restauration terminée : Oriel est en bonne santé."
      exit 0
    fi
    sleep 2
  done
  compose logs --tail=40 oriel >&2 || true
  die "Oriel ne répond pas après la restauration (état : $status). L'ancienne base est dans /data/pre-restore-$STAMP/."
else
  # --- Installation sans Docker -----------------------------------------------------------------
  [[ -d $NATIVE_DATA_DIR ]] || die "Dossier de données introuvable : $NATIVE_DATA_DIR"
  NATIVE_DATA_DIR="$(cd "$NATIVE_DATA_DIR" && pwd)"
  command -v "$NODE_BIN" >/dev/null 2>&1 || die "Node.js est introuvable (NODE_BIN=…)."

  log "Vérification de la base sauvegardée"
  cp "$SRC/$SRC_DB" "$WORK/check.db"
  "$NODE_BIN" --disable-warning=ExperimentalWarning -e "$CHECK_JS" "$WORK/check.db" >/dev/null ||
    die "La base contenue dans l'archive est invalide : restauration annulée, rien n'a été modifié."

  confirm "Remplacer les données de $NATIVE_DATA_DIR par cette sauvegarde ?" || die "Restauration annulée."

  OWNER="$(stat -c %U "$NATIVE_DATA_DIR" 2>/dev/null || stat -f %Su "$NATIVE_DATA_DIR")"
  GROUP="$(stat -c %G "$NATIVE_DATA_DIR" 2>/dev/null || stat -f %Sg "$NATIVE_DATA_DIR")"
  HAS_SYSTEMD=0
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE" >/dev/null 2>&1; then
    HAS_SYSTEMD=1
    log "Arrêt du service $SERVICE"
    systemctl stop "$SERVICE"
  else
    printf '! Service systemd « %s » introuvable : assurez-vous qu’Oriel est arrêté.\n' "$SERVICE" >&2
    confirm "Oriel est-il arrêté ?" || die "Restauration annulée."
  fi

  KEEP_DIR="$NATIVE_DATA_DIR/pre-restore-$STAMP"
  log "Restauration (base actuelle conservée dans $KEEP_DIR/)"
  mkdir -p "$KEEP_DIR"
  for f in oriel.db oriel.db-wal oriel.db-shm; do
    if [[ -e "$NATIVE_DATA_DIR/$f" ]]; then mv "$NATIVE_DATA_DIR/$f" "$KEEP_DIR/"; fi
  done
  cp "$SRC/$SRC_DB" "$NATIVE_DATA_DIR/oriel.db"
  if [[ -d "$SRC/uploads" ]]; then
    mkdir -p "$NATIVE_DATA_DIR/uploads"
    cp -R "$SRC/uploads/." "$NATIVE_DATA_DIR/uploads/"
  fi
  if [[ $EUID -eq 0 ]]; then
    chown -R "$OWNER:$GROUP" "$NATIVE_DATA_DIR/oriel.db" "$KEEP_DIR"
    if [[ -d "$NATIVE_DATA_DIR/uploads" ]]; then chown -R "$OWNER:$GROUP" "$NATIVE_DATA_DIR/uploads"; fi
  fi

  if ((HAS_SYSTEMD)); then
    log "Redémarrage du service $SERVICE"
    systemctl start "$SERVICE"
    sleep 2
    systemctl is-active --quiet "$SERVICE" || die "Le service $SERVICE n'a pas redémarré (journalctl -u $SERVICE)."
  fi
  log "Restauration terminée. L'ancienne base est conservée dans $KEEP_DIR/."
fi
