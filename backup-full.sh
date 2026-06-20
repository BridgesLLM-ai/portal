#!/usr/bin/env bash
# BridgesLLM Portal backup runner.
#
# Usage:
#   backup-full.sh daily
#   backup-full.sh weekly
#   backup-full.sh monthly
#   backup-full.sh comprehensive
#   backup-full.sh --list
#   backup-full.sh --verify

set -euo pipefail

BACKUP_BASE="${BACKUP_BASE:-/root/backups}"
PORTAL_DIR="${PORTAL_ROOT:-/opt/bridgesllm/portal}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/bridgesllm}"
APP_FILES_DIR="${APPS_ROOT:-${INSTALL_ROOT}/apps}"
LEGACY_APP_FILES_DIR="${LEGACY_APP_FILES_DIR:-/var/www/bridgesllm-apps}"
PORTAL_FILES_DIR="${PORTAL_FILES_DIR:-/var/portal-files}"
RUNTIME_ROOT="${RUNTIME_ROOT:-/portal}"
OPENCLAW_DIR="${OPENCLAW_DIR:-/root/.openclaw}"
STALWART_DIR="${STALWART_DIR:-/var/stalwart}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
CADDY_CONF="${CADDY_CONF:-/etc/caddy/Caddyfile}"

DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"
MONTHLY_KEEP="${MONTHLY_KEEP:-3}"
COMPREHENSIVE_KEEP="${COMPREHENSIVE_KEEP:-4}"

TIMESTAMP="$(date '+%Y%m%d-%H%M')"
DATE_ONLY="$(date '+%Y%m%d')"
MONTH_ONLY="$(date '+%Y%m')"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

read_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '
    $1 == k {
      value = substr($0, length(k) + 2)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      print value
      exit
    }
  ' "$file"
}

archive_dir() {
  local source_dir="$1"
  local target="$2"
  shift 2
  [[ -d "$source_dir" ]] || return 0
  tar czf "$target" "$@" -C "$(dirname "$source_dir")" "$(basename "$source_dir")"
}

dump_database() {
  local target="$1"
  local env_file="${PORTAL_DIR}/backend/.env.production"
  local database_url=""

  database_url="$(read_env_value "$env_file" DATABASE_URL 2>/dev/null || true)"

  if [[ -n "$database_url" ]] && command -v pg_dump >/dev/null 2>&1; then
    if pg_dump --no-owner --clean --if-exists "$database_url" > "$target" 2>"${target}.err"; then
      rm -f "${target}.err"
      return 0
    fi
    log "WARNING: pg_dump via DATABASE_URL failed; trying container fallbacks"
    sed -n '1,5p' "${target}.err" >&2 || true
    rm -f "${target}.err"
  fi

  if command -v docker >/dev/null 2>&1; then
    if docker exec bridgesllm-product-db pg_isready -U blp -d bridgesllm_product >/dev/null 2>&1; then
      docker exec bridgesllm-product-db pg_dump -U blp -d bridgesllm_product --no-owner --clean --if-exists > "$target"
      return 0
    fi
    if docker exec bridgesllm-db pg_isready -U bridges -d bridgesllm_portal >/dev/null 2>&1; then
      docker exec bridgesllm-db pg_dump -U bridges -d bridgesllm_portal --no-owner --clean --if-exists > "$target"
      return 0
    fi
  fi

  printf '%s\n' '-- Database dump unavailable: no reachable configured Portal database.' > "$target"
  return 1
}

copy_if_exists() {
  local source="$1"
  local target="$2"
  [[ -f "$source" ]] || return 0
  cp "$source" "$target"
}

backup_name_for_type() {
  case "$1" in
    daily) printf 'portal-daily-%s.tar.gz\n' "$TIMESTAMP" ;;
    weekly) printf 'portal-weekly-%s.tar.gz\n' "$DATE_ONLY" ;;
    monthly) printf 'portal-monthly-%s.tar.gz\n' "$MONTH_ONLY" ;;
    comprehensive) printf 'portal-comprehensive-%s.tar.gz\n' "$TIMESTAMP" ;;
    *) die "Unknown backup type: $1" ;;
  esac
}

keep_count_for_type() {
  case "$1" in
    daily) printf '%s\n' "$DAILY_KEEP" ;;
    weekly) printf '%s\n' "$WEEKLY_KEEP" ;;
    monthly) printf '%s\n' "$MONTHLY_KEEP" ;;
    comprehensive) printf '%s\n' "$COMPREHENSIVE_KEEP" ;;
    *) die "Unknown backup type: $1" ;;
  esac
}

prune_backups() {
  local type="$1"
  local dir="${BACKUP_BASE}/${type}"
  local keep
  keep="$(keep_count_for_type "$type")"

  [[ -d "$dir" ]] || return 0
  local count
  count="$(find "$dir" -maxdepth 1 -type f -name 'portal-*.tar.gz' ! -name '*.locked' | wc -l)"
  if (( count <= keep )); then
    return 0
  fi

  find "$dir" -maxdepth 1 -type f -name 'portal-*.tar.gz' ! -name '*.locked' -printf '%T@ %p\n' \
    | sort -nr \
    | tail -n +"$((keep + 1))" \
    | cut -d' ' -f2- \
    | while IFS= read -r old_backup; do
        log "Pruning old backup: ${old_backup}"
        rm -f "$old_backup"
      done
}

create_backup() {
  local type="${1:-daily}"
  case "$type" in
    daily|weekly|monthly|comprehensive) ;;
    *) die "Unknown backup type: $type (use daily, weekly, monthly, or comprehensive)" ;;
  esac

  local backup_dir="${BACKUP_BASE}/${type}"
  local staging
  staging="$(mktemp -d "/tmp/bridgesllm-backup-${type}-XXXXXX")"
  local archive_path="${backup_dir}/$(backup_name_for_type "$type")"

  mkdir -p "$backup_dir" "${BACKUP_BASE}/logs"
  trap "rm -rf '${staging}'" EXIT

  log "Starting ${type} backup"
  log "Portal root: ${PORTAL_DIR}"

  log "Dumping Portal database"
  if ! dump_database "${staging}/database.sql"; then
    log "WARNING: database dump was not available"
  fi

  log "Archiving app/runtime data"
  archive_dir "$APP_FILES_DIR" "${staging}/apps.tar.gz" || true
  if [[ -d "$LEGACY_APP_FILES_DIR" && "$LEGACY_APP_FILES_DIR" != "$APP_FILES_DIR" ]]; then
    archive_dir "$LEGACY_APP_FILES_DIR" "${staging}/legacy-apps.tar.gz" || true
  fi
  archive_dir "$PORTAL_FILES_DIR" "${staging}/portal-files.tar.gz" || true
  archive_dir "$RUNTIME_ROOT" "${staging}/portal-runtime.tar.gz" \
    --exclude='*/node_modules' \
    --exclude='*/.git' \
    --exclude='*/tmp' \
    --exclude='*/.cache' || true

  log "Archiving Portal install"
  if [[ -d "$PORTAL_DIR" ]]; then
    portal_excludes=(
      --exclude='.git'
      --exclude='*.log'
      --exclude='*.tar.gz'
      --exclude='backend/.data'
      --exclude='.data'
      --exclude='projects'
      --exclude='upload-temp'
      --exclude='assets/avatars'
    )
    if [[ "$type" == "daily" ]]; then
      portal_excludes+=(--exclude='node_modules' --exclude='frontend/dist' --exclude='backend/dist')
    fi
    archive_dir "$PORTAL_DIR" "${staging}/portal-install.tar.gz" "${portal_excludes[@]}" || true
  fi

  log "Archiving mail data and configuration"
  archive_dir "$STALWART_DIR" "${staging}/stalwart-data.tar.gz" || true

  mkdir -p "${staging}/configs" "${staging}/systemd"
  copy_if_exists "${PORTAL_DIR}/backend/.env.production" "${staging}/configs/portal-backend.env.production"
  copy_if_exists "${PORTAL_DIR}/frontend/.env" "${staging}/configs/portal-frontend.env"
  copy_if_exists "${PORTAL_DIR}/docker-compose.yml" "${staging}/configs/portal-docker-compose.yml"
  copy_if_exists "${PORTAL_DIR}/backend/prisma/schema.prisma" "${staging}/configs/portal-schema.prisma"
  copy_if_exists "$CADDY_CONF" "${staging}/configs/Caddyfile"
  copy_if_exists "${OPENCLAW_DIR}/openclaw.json" "${staging}/configs/openclaw.json"
  copy_if_exists "${OPENCLAW_DIR}/env.secrets" "${staging}/configs/openclaw-env.secrets"
  copy_if_exists "${OPENCLAW_DIR}/.env" "${staging}/configs/openclaw.env"

  for unit in \
    bridgesllm-product.service \
    openclaw-gateway.service \
    caddy.service \
    docker-firewall.service \
    bridges-rd-xtigervnc.service \
    bridges-rd-websockify.service \
    stalwart-mail.service \
    bridgesllm-backup@.service \
    bridgesllm-backup-daily.timer \
    bridgesllm-backup-comprehensive.timer \
    bridgesllm-backup-monthly.timer; do
    copy_if_exists "${SYSTEMD_DIR}/${unit}" "${staging}/systemd/${unit}"
  done

  log "Writing manifest"
  {
    printf 'BridgesLLM Portal Backup\n'
    printf '========================\n'
    printf 'Type: %s\n' "$type"
    printf 'Created: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'Host: %s\n' "$(hostname)"
    printf 'Portal root: %s\n' "$PORTAL_DIR"
    printf 'Backup base: %s\n\n' "$BACKUP_BASE"
    printf 'Contents:\n'
    find "$staging" -mindepth 1 -maxdepth 2 -printf '  %P\n' | sort
    printf '\nChecksums:\n'
    (cd "$staging" && find . -type f -maxdepth 2 -print0 | sort -z | xargs -0 sha256sum 2>/dev/null || true)
  } > "${staging}/MANIFEST.txt"

  log "Creating archive ${archive_path}"
  tar czf "$archive_path" -C "$staging" .

  local file_count
  file_count="$(tar tzf "$archive_path" | wc -l)"
  if (( file_count < 2 )); then
    die "Archive integrity check failed: only ${file_count} entries"
  fi

  prune_backups "$type"

  local size
  size="$(du -h "$archive_path" | awk '{print $1}')"
  log "${type} backup complete: ${archive_path} (${size}, ${file_count} entries)"
}

list_backups() {
  for type in daily weekly monthly comprehensive; do
    local dir="${BACKUP_BASE}/${type}"
    printf '\n== %s ==\n' "$type"
    if [[ -d "$dir" ]]; then
      find "$dir" -maxdepth 1 -type f -name 'portal-*.tar.gz' -printf '%TY-%Tm-%Td %TH:%TM %10s %p\n' | sort -r || true
    else
      printf '(none)\n'
    fi
  done
}

verify_backups() {
  local ok=true
  for type in daily weekly monthly comprehensive; do
    local latest
    latest="$(find "${BACKUP_BASE}/${type}" -maxdepth 1 -type f -name 'portal-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
    [[ -n "$latest" ]] || continue
    printf '%s: %s\n' "$type" "$latest"
    if ! tar tzf "$latest" >/dev/null 2>&1; then
      printf '  ERROR: tar integrity check failed\n'
      ok=false
      continue
    fi
    local listing
    listing="$(tar tzf "$latest")"
    grep -Eq '(^|/|[.]/)MANIFEST[.]txt$' <<< "$listing" || { printf '  ERROR: MANIFEST.txt missing\n'; ok=false; }
    grep -Eq '(^|/|[.]/)database[.]sql$' <<< "$listing" || { printf '  ERROR: database.sql missing\n'; ok=false; }
    printf '  OK\n'
  done
  $ok
}

case "${1:-daily}" in
  daily|weekly|monthly|comprehensive) create_backup "$1" ;;
  --list) list_backups ;;
  --verify) verify_backups ;;
  *) die "Usage: $0 [daily|weekly|monthly|comprehensive|--list|--verify]" ;;
esac
