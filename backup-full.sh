#!/usr/bin/env bash
# =============================================================================
# backup-full.sh — Comprehensive BridgesLLM Portal Backup
# =============================================================================
# Backs up: portal database + app files + portal source +
#           secrets + caddy config + systemd units + stalwart mail data
#
# Usage:
#   ./backup-full.sh              # Daily backup (default)
#   ./backup-full.sh daily        # Daily backup (excludes node_modules)
#   ./backup-full.sh weekly       # Weekly backup (includes node_modules)
#   ./backup-full.sh monthly      # Monthly archive
#   ./backup-full.sh --list       # List existing backups
#   ./backup-full.sh --verify     # Verify latest backup
#
# Cron (maintained in /root's crontab):
#   0 2 * * * /root/bridgesllm-product/backup-full.sh daily >> /root/backups/logs/backup.log 2>&1
#   0 3 * * 0 /root/bridgesllm-product/backup-full.sh weekly >> /root/backups/logs/backup.log 2>&1
#   0 4 1 * * /root/bridgesllm-product/backup-full.sh monthly >> /root/backups/logs/backup.log 2>&1
#
# Last updated: 2026-03-28
#               portal backups are now app-agnostic.
# =============================================================================

set -euo pipefail

# --- Configuration ---
BACKUP_BASE="/root/backups"
PORTAL_DIR="/root/bridgesllm-product"
APP_FILES_DIR="/var/www/bridgesllm-apps"
PORTAL_FILES_DIR="/var/portal-files"
OPENCLAW_DIR="/root/.openclaw"
STALWART_DIR="/var/stalwart"
SYSTEMD_DIR="/etc/systemd/system"
CADDY_CONF="/etc/caddy/Caddyfile"

# Primary portal DB (bridgesllm-product stack)
DB_CONTAINER="bridgesllm-product-db"
DB_USER="blp"
DB_NAME="bridgesllm_product"

# Legacy portal DB — decommissioned, no longer exists
# LEGACY_DB_CONTAINER="bridgesllm-db"

# Retention
DAILY_KEEP=7
WEEKLY_KEEP=4
MONTHLY_KEEP=3

# --- Helpers ---
TIMESTAMP=$(date '+%Y%m%d-%H%M')
DATE_ONLY=$(date '+%Y%m%d')
MONTH_ONLY=$(date '+%Y%m')

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

# --- Main Backup ---
do_backup() {
    local TYPE="${1:-daily}"
    local BACKUP_DIR="${BACKUP_BASE}/${TYPE}"
    local STAGING="/tmp/portal-backup-${TIMESTAMP}"
    local ARCHIVE_NAME

    case "$TYPE" in
        daily)   ARCHIVE_NAME="portal-daily-${TIMESTAMP}.tar.gz" ;;
        weekly)  ARCHIVE_NAME="portal-weekly-${DATE_ONLY}.tar.gz" ;;
        monthly) ARCHIVE_NAME="portal-monthly-${MONTH_ONLY}.tar.gz" ;;
        *)       die "Unknown backup type: $TYPE (use daily/weekly/monthly)" ;;
    esac

    local ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"

    log "========================================="
    log "Starting ${TYPE} backup"
    log "Stack: bridgesllm-product (current production)"
    log "========================================="

    # Create directories
    mkdir -p "$BACKUP_DIR" "$STAGING" "/root/backups/logs"

    # --- 1. Primary Portal DB Dump (bridgesllm-product-db) ---
    log "Step 1a: Dumping primary portal DB (${DB_CONTAINER})..."
    if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
        docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --clean --if-exists \
            > "${STAGING}/database.sql" 2>/dev/null
        local DB_SIZE=$(stat -c %s "${STAGING}/database.sql" 2>/dev/null || echo 0)
        if [ "$DB_SIZE" -lt 100 ]; then
            log "WARNING: Primary DB dump suspiciously small (${DB_SIZE} bytes)"
        else
            log "  Primary portal DB: ${DB_SIZE} bytes ✅"
        fi
    else
        log "WARNING: ${DB_CONTAINER} not reachable — skipping"
        echo "-- PRIMARY DB WAS NOT REACHABLE DURING BACKUP" > "${STAGING}/database.sql"
    fi

    # Legacy DB (bridgesllm-db) — decommissioned, removed.

    # --- 2. App Files (user-uploaded portal apps) ---
    log "Step 2: Backing up app files..."
    if [ -d "$APP_FILES_DIR" ]; then
        tar czf "${STAGING}/app-files.tar.gz" -C "$(dirname "$APP_FILES_DIR")" "$(basename "$APP_FILES_DIR")" 2>/dev/null
        local APP_SIZE=$(stat -c %s "${STAGING}/app-files.tar.gz" 2>/dev/null || echo 0)
        local APP_COUNT=$(ls -1 "$APP_FILES_DIR" 2>/dev/null | wc -l)
        log "  App files: ${APP_SIZE} bytes (${APP_COUNT} apps) ✅"
    else
        log "  App files directory not found at ${APP_FILES_DIR} — skipping"
    fi

    # --- 2b. Portal user-uploaded files ---
    log "Step 2b: Backing up portal user files..."
    if [ -d "$PORTAL_FILES_DIR" ]; then
        tar czf "${STAGING}/portal-files.tar.gz" -C "$(dirname "$PORTAL_FILES_DIR")" "$(basename "$PORTAL_FILES_DIR")" 2>/dev/null
        local PF_SIZE=$(stat -c %s "${STAGING}/portal-files.tar.gz" 2>/dev/null || echo 0)
        log "  Portal user files: ${PF_SIZE} bytes ✅"
    else
        log "  Portal user files directory not found at ${PORTAL_FILES_DIR} — skipping"
    fi

    # --- 3. Portal Source (bridgesllm-product) ---
    log "Step 3: Backing up portal source (bridgesllm-product)..."
    if [ -d "$PORTAL_DIR" ]; then
        if [ "$TYPE" = "daily" ]; then
            tar czf "${STAGING}/portal-source.tar.gz" \
                --exclude='node_modules' \
                --exclude='.next' \
                --exclude='dist' \
                -C "$(dirname "$PORTAL_DIR")" "$(basename "$PORTAL_DIR")" 2>/dev/null
        else
            tar czf "${STAGING}/portal-source.tar.gz" \
                -C "$(dirname "$PORTAL_DIR")" "$(basename "$PORTAL_DIR")" 2>/dev/null
        fi
        local SRC_SIZE=$(stat -c %s "${STAGING}/portal-source.tar.gz" 2>/dev/null || echo 0)
        log "  Portal source: ${SRC_SIZE} bytes ✅"
    else
        log "WARNING: Portal source not found at ${PORTAL_DIR}"
    fi

    # --- 3c. Stalwart Mail Data ---
    log "Step 3c: Backing up Stalwart mail data..."
    if [ -d "$STALWART_DIR" ]; then
        tar czf "${STAGING}/stalwart-data.tar.gz" -C "$(dirname "$STALWART_DIR")" "$(basename "$STALWART_DIR")" 2>/dev/null
        local ST_SIZE=$(stat -c %s "${STAGING}/stalwart-data.tar.gz" 2>/dev/null || echo 0)
        log "  Stalwart mail data: ${ST_SIZE} bytes ✅"
    else
        log "  Stalwart data not found at ${STALWART_DIR} — skipping"
    fi

    # --- 4. Secrets & Config ---
    log "Step 4: Backing up secrets and configs..."
    mkdir -p "${STAGING}/configs"

    # Production .env files
    [ -f "${PORTAL_DIR}/backend/.env.production" ] && cp "${PORTAL_DIR}/backend/.env.production" "${STAGING}/configs/portal-backend.env.production"
    [ -f "${PORTAL_DIR}/backend/.env" ] && cp "${PORTAL_DIR}/backend/.env" "${STAGING}/configs/portal-backend.env"
    [ -f "${PORTAL_DIR}/docker-compose.yml" ] && cp "${PORTAL_DIR}/docker-compose.yml" "${STAGING}/configs/portal-docker-compose.yml"
    [ -f "${PORTAL_DIR}/backend/prisma/schema.prisma" ] && cp "${PORTAL_DIR}/backend/prisma/schema.prisma" "${STAGING}/configs/portal-schema.prisma"

    # Caddy config (critical — controls all routing/SSL)
    [ -f "$CADDY_CONF" ] && cp "$CADDY_CONF" "${STAGING}/configs/Caddyfile"

    # OpenClaw config
    [ -f "${OPENCLAW_DIR}/openclaw.json" ] && cp "${OPENCLAW_DIR}/openclaw.json" "${STAGING}/configs/openclaw.json"
    [ -f "${OPENCLAW_DIR}/env.secrets" ] && cp "${OPENCLAW_DIR}/env.secrets" "${STAGING}/configs/openclaw-env.secrets"

    log "  Configs copied ✅"

    # --- 5. Systemd Units ---
    log "Step 5: Backing up systemd units..."
    mkdir -p "${STAGING}/systemd"
    # Current production units
    for unit in \
        bridgesllm-product \
        caddy \
        ollama \
        ollama-proxy \
        ollama-control-api \
        ollama-cpu-guardian \
        portal-socat-ollama \
        bridgesllm-host-terminal \
        bridgesllm-host-terminal-docker-proxy \
        bridgesllm-guacamole \
        bridgesllm-portal-proxy \
        stalwart-mail; do
        [ -f "${SYSTEMD_DIR}/${unit}.service" ] && cp "${SYSTEMD_DIR}/${unit}.service" "${STAGING}/systemd/"
    done
    local UNIT_COUNT=$(ls "${STAGING}/systemd/" 2>/dev/null | wc -l)
    log "  Systemd units: ${UNIT_COUNT} files ✅"

    # --- 6. Create Manifest ---
    log "Step 6: Creating manifest..."
    cat > "${STAGING}/MANIFEST.txt" <<EOF
BridgesLLM Portal Backup
========================
Type: ${TYPE}
Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
Host: $(hostname)
Script: /root/bridgesllm-product/backup-full.sh

Stack Architecture:
  Portal (bridgesllm-product.service, :4001)
  Stalwart Mail (Docker: stalwart-mail, :8580)
  Caddy (reverse proxy + Let's Encrypt, :80/:443)
  (Legacy bridgesllm-db decommissioned)

Contents:
  database.sql                  - Primary portal DB dump (bridgesllm-product-db)
  (legacy DB decommissioned — no longer backed up)
  app-files.tar.gz              - App files from /var/www/bridgesllm-apps/
  portal-files.tar.gz           - User-uploaded portal files (/var/portal-files/)
  portal-source.tar.gz          - Portal source code (bridgesllm-product/)
  stalwart-data.tar.gz          - Stalwart mail data (/var/stalwart/)
  configs/                      - .env files, Caddyfile, prisma schema, openclaw.json
  systemd/                      - Systemd service unit files (${UNIT_COUNT} units)
  MANIFEST.txt                  - This file

Restore: /root/bridgesllm-product/backup-full.sh --verify to inspect archive.
         Manual restore: tar -tzf ${ARCHIVE_PATH} | head -30

File checksums:
$(cd "${STAGING}" && sha256sum * 2>/dev/null || true)
$(cd "${STAGING}" && sha256sum configs/* 2>/dev/null || true)
$(cd "${STAGING}" && sha256sum systemd/* 2>/dev/null || true)
EOF

    # --- 7. Create Final Archive ---
    log "Step 7: Creating archive..."
    tar czf "$ARCHIVE_PATH" -C "$STAGING" . 2>/dev/null
    local FINAL_SIZE=$(stat -c %s "$ARCHIVE_PATH" 2>/dev/null || echo 0)
    local FINAL_SIZE_MB=$((FINAL_SIZE / 1024 / 1024))
    log "  Archive: ${ARCHIVE_PATH} (${FINAL_SIZE_MB}MB) ✅"

    # --- 8. Verify ---
    log "Step 8: Verifying archive integrity..."
    local FILE_COUNT=$(tar tzf "$ARCHIVE_PATH" 2>/dev/null | wc -l)
    if [ "$FILE_COUNT" -gt 5 ]; then
        log "  Integrity check passed: ${FILE_COUNT} files in archive ✅"
    else
        log "WARNING: Archive seems too small (${FILE_COUNT} files)"
    fi

    # --- 9. Cleanup Staging ---
    rm -rf "$STAGING"

    # --- 10. Prune Old Backups ---
    log "Step 9: Pruning old backups..."
    prune_backups "$TYPE"

    # --- Done ---
    log "========================================="
    log "${TYPE} backup COMPLETE: ${ARCHIVE_PATH}"
    log "Size: ${FINAL_SIZE_MB}MB | Files: ${FILE_COUNT}"
    log "========================================="
}

# --- Prune Old Backups ---
prune_backups() {
    local TYPE="$1"
    local DIR="${BACKUP_BASE}/${TYPE}"
    local KEEP

    case "$TYPE" in
        daily)   KEEP=$DAILY_KEEP ;;
        weekly)  KEEP=$WEEKLY_KEEP ;;
        monthly) KEEP=$MONTHLY_KEEP ;;
    esac

    local COUNT=$(ls -1 "${DIR}"/portal-*.tar.gz 2>/dev/null | wc -l)
    if [ "$COUNT" -gt "$KEEP" ]; then
        local TO_DELETE=$((COUNT - KEEP))
        ls -1t "${DIR}"/portal-*.tar.gz | tail -"${TO_DELETE}" | while read -r f; do
            log "  Pruning: $(basename "$f")"
            rm -f "$f"
        done
        log "  Pruned ${TO_DELETE} old backup(s)"
    fi
}

# --- List Backups ---
do_list() {
    echo "=== BridgesLLM Portal Backups ==="
    echo ""
    for type in daily weekly monthly; do
        local dir="${BACKUP_BASE}/${type}"
        echo "--- ${type^^} (${dir}) ---"
        if [ -d "$dir" ] && ls "${dir}"/portal-*.tar.gz > /dev/null 2>&1; then
            ls -lh "${dir}"/portal-*.tar.gz | awk '{print $5, $9}' | while read -r size path; do
                local name=$(basename "$path")
                local mtime=$(stat -c '%y' "$path" 2>/dev/null | cut -d. -f1)
                echo "  ${name}  (${size})  ${mtime}"
            done
        else
            echo "  (none)"
        fi
        echo ""
    done

    echo "Total backup storage:"
    du -sh "${BACKUP_BASE}"/ 2>/dev/null || echo "  (unavailable)"
}

# --- Verify Latest Backup ---
do_verify() {
    local LATEST=""
    for type in daily weekly monthly; do
        local dir="${BACKUP_BASE}/${type}"
        local f
        f=$(ls -1t "${dir}"/portal-*.tar.gz 2>/dev/null | head -1)
        if [ -n "$f" ]; then
            echo "--- Latest ${type}: $(basename "$f") ---"
            local FILE_COUNT
            FILE_COUNT=$(tar tzf "$f" 2>/dev/null | wc -l)
            local SIZE
            SIZE=$(stat -c %s "$f" 2>/dev/null || echo 0)
            local SIZE_MB=$((SIZE / 1024 / 1024))
            echo "  Size: ${SIZE_MB}MB | Files: ${FILE_COUNT}"
            if tar tzf "$f" 2>/dev/null | grep -q "MANIFEST.txt"; then
                echo "  MANIFEST.txt: present ✅"
            fi
            if tar tzf "$f" 2>/dev/null | grep -q "database.sql"; then
                echo "  Primary DB dump: present ✅"
            fi
            echo ""
        fi
    done
}

# --- Entry Point ---
case "${1:-daily}" in
    daily|weekly|monthly) do_backup "$1" ;;
    --list)               do_list ;;
    --verify)             do_verify ;;
    *)                    echo "Usage: $0 [daily|weekly|monthly|--list|--verify]"; exit 1 ;;
esac
