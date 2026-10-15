#!/usr/bin/env bash
# Oriel — sauvegarde à chaud et cohérente (sans arrêter le service).
#
#   sudo ./deploy/backup.sh                                # instance Docker (deploy/docker-compose.yml)
#   sudo ./deploy/backup.sh --data-dir /var/lib/oriel   # installation sans Docker (systemd)
#
# Produit <dossier>/oriel-AAAAMMJJ-HHMMSS.tar.gz contenant un dossier oriel-AAAAMMJJ-HHMMSS/ :
#   oriel.db   copie cohérente de la base SQLite (VACUUM INTO + contrôle d'intégrité)
#   uploads/      fichiers envoyés par les utilisateurs
#   env           copie de deploy/.env (configuration), si présent
#   MANIFEST      date, hôte, version du schéma, tailles
# puis ne conserve que les N archives les plus récentes.
#
# Options :
#   --data-dir DIR   sauvegarde une installation sans Docker (DATA_DIR du service systemd)
#   --output DIR     dossier des archives (défaut : deploy/backups, ou $BACKUP_DIR)
#   --keep N         nombre d'archives conservées (défaut : 14, ou $KEEP)
#   -h, --help       cette aide
#
# Restauration : deploy/restore.sh <archive>. Pensez à copier les archives hors du serveur
# (rsync, rclone, stockage objet…) : une sauvegarde sur la même machine ne protège pas d'une panne disque.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
KEEP="${KEEP:-14}"
NATIVE_DATA_DIR=""
NODE_BIN="${NODE_BIN:-node}"

die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
trap 'die "Échec ligne $LINENO : $BASH_COMMAND"' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) NATIVE_DATA_DIR="${2:-}"; shift 2 ;;
    --data-dir=*) NATIVE_DATA_DIR="${1#*=}"; shift ;;
    --output) BACKUP_DIR="${2:-}"; shift 2 ;;
    --output=*) BACKUP_DIR="${1#*=}"; shift ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --keep=*) KEEP="${1#*=}"; shift ;;
    -h | --help) sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Option inconnue : $1 (voir --help)" ;;
  esac
done
[[ $KEEP =~ ^[0-9]+$ && $KEEP -ge 1 ]] || die "--keep doit être un entier ≥ 1."

# Copie cohérente de la base, exécutée avec le Node.js d’Oriel (node:sqlite, Node ≥ 22.13).
# VACUUM INTO lit un instantané transactionnel : les écritures concurrentes ne sont pas bloquées.
SNAPSHOT_JS="$(
  cat <<'JS'
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const dataDir = process.env.DATA_DIR || "/data";
const source = path.join(dataDir, "oriel.db");
const target = process.env.SNAPSHOT_PATH;
if (!fs.existsSync(source)) {
  console.error("Base introuvable : " + source);
  process.exit(2);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { force: true });
const db = new DatabaseSync(source);
db.exec("PRAGMA busy_timeout = 30000");
db.prepare("VACUUM INTO ?").run(target);
db.close();
const copy = new DatabaseSync(target, { readOnly: true });
const check = Object.values(copy.prepare("PRAGMA integrity_check").get())[0];
let schema = null;
try {
  schema = copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null;
} catch {}
copy.close();
if (check !== "ok") {
  console.error("Contrôle d'intégrité de la copie : " + check);
  process.exit(3);
}
console.log("schema_version=" + schema);
console.log("db_bytes=" + fs.statSync(target).size);
JS
)"

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="oriel-$STAMP"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

# Une seule sauvegarde à la fois.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "Une sauvegarde est déjà en cours."
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oriel-backup.XXXXXX")"
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/$NAME"

if [[ -z $NATIVE_DATA_DIR ]]; then
  # --- Instance Docker ------------------------------------------------------------------------
  MODE="docker"
  command -v docker >/dev/null 2>&1 || die "Docker est introuvable (utilisez --data-dir pour une installation sans Docker)."
  compose() {
    # docker-compose.override.yml (ex. variante Nginx, docs/DEPLOY.md) est pris en compte s'il existe.
    local files=(-f "$COMPOSE_FILE")
    if [[ -f "$SCRIPT_DIR/docker-compose.override.yml" ]]; then files+=(-f "$SCRIPT_DIR/docker-compose.override.yml"); fi
    docker compose --project-directory "$SCRIPT_DIR" "${files[@]}" "$@"
  }
  compose ps --status running --services 2>/dev/null | grep -qx oriel ||
    die "Le service oriel n'est pas démarré (docker compose -f $COMPOSE_FILE up -d)."

  log "Copie cohérente de la base (VACUUM INTO /data/backups/$NAME.db)"
  compose exec -T -e SNAPSHOT_PATH="/data/backups/$NAME.db" oriel \
    node --disable-warning=ExperimentalWarning -e "$SNAPSHOT_JS" >"$WORK/snapshot.txt"
  compose exec -T oriel cat "/data/backups/$NAME.db" >"$WORK/$NAME/oriel.db"
  compose exec -T oriel rm -f "/data/backups/$NAME.db"

  log "Archivage des fichiers envoyés"
  if compose exec -T oriel test -d /data/uploads; then
    compose exec -T oriel tar -C /data -cf - uploads | tar -C "$WORK/$NAME" -xf -
  fi
else
  # --- Installation sans Docker -----------------------------------------------------------------
  MODE="native"
  LIVE_DB="oriel.db"
  [[ -f "$NATIVE_DATA_DIR/$LIVE_DB" ]] || die "Base introuvable : $NATIVE_DATA_DIR/oriel.db"
  NATIVE_DATA_DIR="$(cd "$NATIVE_DATA_DIR" && pwd)"
  command -v "$NODE_BIN" >/dev/null 2>&1 || die "Node.js est introuvable (NODE_BIN=…)."
  OWNER="$(stat -c %U "$NATIVE_DATA_DIR/$LIVE_DB" 2>/dev/null || stat -f %Su "$NATIVE_DATA_DIR/$LIVE_DB")"
  # Exécuter en tant que propriétaire de la base : les fichiers -wal/-shm éventuellement créés
  # doivent rester accessibles au service.
  as_owner() {
    if [[ $(id -un) == "$OWNER" ]]; then
      "$@"
    elif [[ $EUID -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
      runuser -u "$OWNER" -- "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo -u "$OWNER" -- "$@"
    else
      die "Lancez ce script en root ou en tant que $OWNER."
    fi
  }
  SNAPSHOT="$NATIVE_DATA_DIR/backups/$NAME.db"
  log "Copie cohérente de la base (VACUUM INTO $SNAPSHOT)"
  as_owner env DATA_DIR="$NATIVE_DATA_DIR" SNAPSHOT_PATH="$SNAPSHOT" \
    "$(command -v "$NODE_BIN")" --disable-warning=ExperimentalWarning -e "$SNAPSHOT_JS" >"$WORK/snapshot.txt"
  cp "$SNAPSHOT" "$WORK/$NAME/oriel.db"
  as_owner rm -f "$SNAPSHOT"
  log "Archivage des fichiers envoyés"
  if [[ -d "$NATIVE_DATA_DIR/uploads" ]]; then
    cp -R "$NATIVE_DATA_DIR/uploads" "$WORK/$NAME/uploads"
  fi
fi

[[ -s "$WORK/$NAME/oriel.db" ]] || die "La copie de la base est vide."
if [[ -f "$SCRIPT_DIR/.env" ]]; then cp "$SCRIPT_DIR/.env" "$WORK/$NAME/env"; fi

UPLOAD_COUNT=0
if [[ -d "$WORK/$NAME/uploads" ]]; then
  UPLOAD_COUNT="$(find "$WORK/$NAME/uploads" -type f | wc -l | tr -d ' ')"
fi
{
  echo "oriel_backup=1"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname)"
  echo "mode=$MODE"
  cat "$WORK/snapshot.txt"
  echo "uploads=$UPLOAD_COUNT"
} >"$WORK/$NAME/MANIFEST"

ARCHIVE="$BACKUP_DIR/$NAME.tar.gz"
tar -C "$WORK" -czf "$ARCHIVE.part" "$NAME"
mv "$ARCHIVE.part" "$ARCHIVE"
log "Sauvegarde créée : $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1), $UPLOAD_COUNT fichier(s))"

# Rotation : les noms contiennent la date, l'ordre alphabétique est chronologique.
shopt -s nullglob
archives=("$BACKUP_DIR"/oriel-*.tar.gz)
shopt -u nullglob
if ((${#archives[@]} > KEEP)); then
  for old in "${archives[@]:0:${#archives[@]}-KEEP}"; do
    rm -f -- "$old"
    log "Ancienne sauvegarde supprimée : $(basename "$old")"
  done
fi
