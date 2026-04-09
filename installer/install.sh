#!/usr/bin/env bash
#
# BridgesLLM Portal — One-Command Installer v3.3
# ================================================
# Zero questions. Installs everything. Prints a URL.
#
# Usage:
#   curl -fsSL https://bridgesllm.ai/install.sh | sudo bash
#
# The installer handles infrastructure. Everything configurable
# happens in the browser-based setup wizard.
#
# Supports: Ubuntu 22.04/24.04, Debian 12/13
#
set -Eeuo pipefail

readonly VERSION="3.23.10"
readonly SCRIPT_NAME="$(basename "$0")"
readonly INSTALL_ROOT="/opt/bridgesllm"
readonly PORTAL_DIR="${INSTALL_ROOT}/portal"
readonly LOG_DIR="${INSTALL_ROOT}/logs"
readonly TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly LOG_FILE="${LOG_DIR}/install-${TIMESTAMP}.log"
readonly RELEASE_URL="https://bridgesllm.ai/portal.tar.gz"
readonly RELEASE_FALLBACK_DIR="/root/bridgesllm-product"

readonly MIN_RAM_MB=3500
readonly MIN_DISK_GB=35

# Pinned versions
# OpenClaw: use latest during development; pin to a stable version for releases
readonly PIN_NODE_MAJOR="22"

# Flags
DOMAIN=""
DRY_RUN=false
UPDATE_MODE=false
UNINSTALL_MODE=false
SKIP_OLLAMA=false
SKIP_OPENCLAW=false

# Generated during install
DB_PASSWORD=""
JWT_SECRET=""
JWT_REFRESH_SECRET=""
OPENCLAW_TOKEN=""
SETUP_TOKEN=""
PUBLIC_IP=""
TELEMETRY_INSTALL_ID=""

# State
CURRENT_STEP="startup"
TOTAL_STEPS=9
CURRENT_STEP_NUM=0
INSTALL_START_TIME=""
PACKAGE_MANAGER_REPAIR_ACTIVE=false
PACKAGE_MANAGER_LONG_WAIT_SECONDS=1800

# OS detection
OS_ID=""
OS_VERSION=""
APT_AVAILABLE=false

# ═══════════════════════════════════════════════════════════════
# Terminal styling
# ═══════════════════════════════════════════════════════════════

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly MAGENTA='\033[0;35m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly BOLD='\033[1m'
readonly DIM='\033[2m'
readonly ITALIC='\033[3m'
readonly NC='\033[0m'

readonly BULLET='•'

ok()       { echo -e "  ${GREEN}✓${NC} $*"; }
warn()     { echo -e "  ${YELLOW}⚠${NC} $*"; }
info()     { echo -e "  ${DIM}→${NC} $*"; }
progress() { echo -e "  ${BLUE}${BULLET}${NC} $*"; }

fail() {
  echo ""
  echo -e "  ${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${RED}${BOLD}  ERROR${NC}  ${CYAN}${CURRENT_STEP}${NC}"
  echo ""
  echo -e "  ${WHITE}  $1${NC}"
  echo ""
  echo -e "  ${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  if [[ -f "$LOG_FILE" ]]; then
    echo -e "  ${DIM}Log: ${LOG_FILE}${NC}"
    echo -e "  ${DIM}Last 5 lines:${NC}"
    tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  fi
  echo ""
  exit 1
}

draw_progress_bar() {
  local current=$1
  local total=$2
  local label="${3:-}"
  local bar_width=24
  local filled=$(( (current * bar_width) / total ))
  local empty=$(( bar_width - filled ))
  local pct=$(( (current * 100) / total ))

  local bar=""
  local i
  for ((i = 0; i < filled; i++)); do bar+="█"; done
  for ((i = 0; i < empty; i++)); do bar+="░"; done

  echo -e "  ${CYAN}│${NC} ${CYAN}[${bar}]${NC} ${DIM}${pct}%${NC}  ${DIM}·${NC} ${WHITE}${BOLD}${label}${NC} ${DIM}(${current}/${total})${NC}"
}

step_header() {
  CURRENT_STEP_NUM=$((CURRENT_STEP_NUM + 1))
  local label="$1"

  echo ""
  echo -e "  ${CYAN}┌────────────────────────────────────────────────────${NC}"
  draw_progress_bar "$CURRENT_STEP_NUM" "$TOTAL_STEPS" "$label"
  echo -e "  ${CYAN}└────────────────────────────────────────────────────${NC}"
}

banner() {
  clear 2>/dev/null || true
  echo ""
  echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${WHITE}${BOLD}  B R I D G E S  L L M   Portal${NC}"
  echo -e "  ${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${DIM}Installer v${VERSION}${NC}"
}

print_kv() {
  # Print a key-value pair aligned nicely
  local key="$1" val="$2" color="${3:-$NC}"
  printf "  ${DIM}%-16s${NC} ${color}%s${NC}\n" "${key}" "${val}"
}

elapsed_since_start() {
  if [[ -n "$INSTALL_START_TIME" ]]; then
    local now
    now=$(date +%s)
    local diff=$((now - INSTALL_START_TIME))
    local mins=$((diff / 60))
    local secs=$((diff % 60))
    if ((mins > 0)); then
      echo "${mins}m ${secs}s"
    else
      echo "${secs}s"
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════
# Utilities
# ═══════════════════════════════════════════════════════════════

command_needs_package_manager() {
  local cmd="$*"
  [[ "$cmd" =~ (^|[[:space:]])(apt-get|apt|dpkg)([[:space:]]|$) ]]
}

package_manager_lock_paths() {
  cat <<'EOF'
/var/lib/dpkg/lock-frontend
/var/lib/dpkg/lock
/var/lib/apt/lists/lock
/var/cache/apt/archives/lock
EOF
}

# Active package-manager processes — only ones that actually hold locks.
# Excludes passive daemons like unattended-upgrade-shutdown (--wait-for-signal)
# and packagekitd (idle), and our own detection processes.
package_manager_active_procs() {
  ps -eo pid=,comm=,args= 2>/dev/null | awk '
    # Skip our own detection processes (awk/grep/ps show the pattern text in args)
    $2 == "awk" || $2 == "grep" || $2 == "ps" || $2 == "bash" || $2 == "sh" { next }
    # Only match processes actively doing package work
    /apt-get|aptitude/ { print $2; next }
    /\/usr\/bin\/dpkg/ { print $2; next }
    /\/usr\/bin\/unattended-upgrade($| )/ { print "unattended-upgr"; next }
    /cloud-init.*apt/ { print "cloud-init"; next }
  ' | sort -u
}

package_manager_holder_name() {
  # First: check who actually holds the locks (most accurate)
  if command -v fuser &>/dev/null; then
    local lock holders_found=""
    while IFS= read -r lock; do
      [[ -e "$lock" ]] || continue
      local pids
      pids="$(fuser "$lock" 2>/dev/null | xargs 2>/dev/null || true)"
      if [[ -n "$pids" ]]; then
        for pid in $pids; do
          local name
          name="$(ps -p "$pid" -o comm= 2>/dev/null || echo "pid:$pid")"
          holders_found="${holders_found:+$holders_found, }${name}"
        done
      fi
    done < <(package_manager_lock_paths)
    if [[ -n "$holders_found" ]]; then
      echo "$holders_found"
      return
    fi
  fi

  # Fallback: active process names
  local procs
  procs="$(package_manager_active_procs | head -3)"
  if [[ -n "$procs" ]]; then
    echo "$procs" | paste -sd ', ' -
    return
  fi
  echo "system packages"
}

cloud_init_pending() {
  if command -v cloud-init &>/dev/null; then
    local status
    status="$(cloud-init status 2>/dev/null || true)"
    [[ "$status" != *"status: done"* ]]
  else
    pgrep -af 'cloud-init' >/dev/null 2>&1
  fi
}

package_manager_is_busy() {
  # Primary check: are any lock files actually held?
  if command -v fuser &>/dev/null; then
    local lock
    while IFS= read -r lock; do
      [[ -e "$lock" ]] || continue
      if fuser "$lock" >/dev/null 2>&1; then
        return 0
      fi
    done < <(package_manager_lock_paths)
  fi

  # Secondary check: are active package processes running?
  if package_manager_active_procs | grep -q .; then
    return 0
  fi

  return 1
}

safe_package_manager_repair() {
  $PACKAGE_MANAGER_REPAIR_ACTIVE && return 1
  PACKAGE_MANAGER_REPAIR_ACTIVE=true
  local rc=0
  {
    echo "[$(date -Is)] attempting safe package-manager recovery" >> "$LOG_FILE"
    DEBIAN_FRONTEND=noninteractive dpkg --configure -a >> "$LOG_FILE" 2>&1 || rc=$?
    if [[ $rc -eq 0 ]]; then
      DEBIAN_FRONTEND=noninteractive apt-get -f install -y >> "$LOG_FILE" 2>&1 || rc=$?
    fi
  }
  PACKAGE_MANAGER_REPAIR_ACTIVE=false
  return $rc
}

wait_for_package_manager_ready() {
  local reason="${1:-package manager work}"
  local timeout_seconds="${2:-$PACKAGE_MANAGER_LONG_WAIT_SECONDS}"
  local start_ts now elapsed holder last_notice=-1 tick=0
  start_ts=$(date +%s)

  if ! package_manager_is_busy; then
    return 0
  fi

  echo ""
  echo -e "  ${CYAN}┌────────────────────────────────────────────────────${NC}"
  if cloud_init_pending; then
    echo -e "  ${CYAN}│${NC}  ${YELLOW}⚠${NC}  ${WHITE}${BOLD}Fresh VPS — waiting for system updates${NC}"
    echo -e "  ${CYAN}│${NC}"
    echo -e "  ${CYAN}│${NC}  ${DIM}Your server is installing security patches. This is${NC}"
    echo -e "  ${CYAN}│${NC}  ${DIM}normal on a new VPS and usually takes 2–5 minutes.${NC}"
    echo -e "  ${CYAN}│${NC}  ${DIM}The installer will continue automatically.${NC}"
  else
    echo -e "  ${CYAN}│${NC}  ${YELLOW}⚠${NC}  ${WHITE}${BOLD}Waiting for package manager${NC}"
    echo -e "  ${CYAN}│${NC}"
    echo -e "  ${CYAN}│${NC}  ${DIM}Another package task is running.${NC}"
    echo -e "  ${CYAN}│${NC}  ${DIM}The installer will continue automatically.${NC}"
  fi
  echo -e "  ${CYAN}│${NC}"

  while package_manager_is_busy; do
    now=$(date +%s)
    elapsed=$(( now - start_ts ))
    holder="$(package_manager_holder_name)"

    if [[ -t 1 ]]; then
      # draw_pulse_bar does \r itself, prefix with box line
      local _pw=24 _pframes=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
      local _pf="${_pframes[$(( tick % ${#_pframes[@]} ))]}"
      local _pc=$(( _pw * 2 )) _pp=$(( tick % (_pw * 2) ))
      (( _pp >= _pw )) && _pp=$(( _pc - _pp ))
      local _pb="" _pi
      for ((_pi = 0; _pi < _pw; _pi++)); do
        local _pd=$(( _pi - _pp )); (( _pd < 0 )) && _pd=$(( -_pd ))
        if (( _pd == 0 )); then _pb+="█"; elif (( _pd == 1 )); then _pb+="▓"
        elif (( _pd == 2 )); then _pb+="▒"; else _pb+="░"; fi
      done
      printf "\r  ${CYAN}│${NC}  ${CYAN}${_pf}${NC} ${CYAN}[${_pb}]${NC} ${DIM}$(format_elapsed $elapsed) · ${holder}${NC}                    "
    elif (( elapsed / 30 != last_notice )); then
      echo -e "  ${CYAN}│${NC}  ${DIM}Still waiting ($(format_elapsed $elapsed)) — ${holder}${NC}"
      last_notice=$(( elapsed / 30 ))
    fi
    tick=$(( tick + 1 ))

    if (( elapsed >= timeout_seconds )); then
      if [[ -t 1 ]]; then printf "\r%-120s\r" ""; fi
      echo -e "  ${CYAN}│${NC}"
      echo -e "  ${CYAN}└────────────────────────────────────────────────────${NC}"
      warn "Package manager wait exceeded $((timeout_seconds / 60)) minutes. Checking for a safe recovery..."
      if package_manager_is_busy; then
        fail "Package manager is still actively busy (${holder}). First-boot updates may still be running. Wait a few more minutes and rerun: curl -fsSL https://bridgesllm.ai/install.sh | sudo bash"
      fi
      if safe_package_manager_repair; then
        ok "Recovered interrupted package manager state"
        return 0
      fi
      fail "Package manager appears stuck. Check ${LOG_FILE}, then run: dpkg --configure -a && apt-get -f install"
    fi

    sleep 0.2
  done

  if [[ -t 1 ]]; then printf "\r%-120s\r" ""; fi
  echo -e "  ${CYAN}│${NC}"
  echo -e "  ${CYAN}│${NC}  ${GREEN}✓${NC}  ${WHITE}Package manager ready${NC}"
  echo -e "  ${CYAN}└────────────────────────────────────────────────────${NC}"
  echo ""
}

run() {
  if $DRY_RUN; then
    echo "  [dry-run] $*" >> "$LOG_FILE" 2>&1
  else
    if ! $PACKAGE_MANAGER_REPAIR_ACTIVE && command_needs_package_manager "$*"; then
      wait_for_package_manager_ready "$CURRENT_STEP"
    fi
    bash -c "$*" >> "$LOG_FILE" 2>&1
  fi
}

telemetry_event() {
  local event="$1"
  local extra="${2:-}"
  local os_name; os_name="$(lsb_release -si 2>/dev/null || echo unknown)"
  local os_ver; os_ver="$(lsb_release -sr 2>/dev/null || echo unknown)"
  local payload="{\"event\":\"${event}\",\"version\":\"${VERSION}\",\"os\":\"${os_name}\",\"osVersion\":\"${os_ver}\"${extra}}"
  curl -sf -X POST "https://bridgesllm.ai/api/telemetry/event" \
    -H 'Content-Type: application/json' \
    -d "${payload}" \
    >/dev/null 2>&1 &
}

load_existing_telemetry_install_id() {
  TELEMETRY_INSTALL_ID="$(read_env_value "${PORTAL_DIR}/backend/.env.production" "TELEMETRY_INSTALL_ID" 2>/dev/null || echo "")"
}

ensure_build_tools() {
  if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
    spin "Installing build tools" "apt-get install -y -qq build-essential python3"
  fi
}

install_backend_runtime_dependencies() {
  local backend_dir="${PORTAL_DIR}/backend"
  [[ -d "${backend_dir}" ]] || fail "Backend directory not found at ${backend_dir}"

  spin "Installing runtime dependencies" "cd '${backend_dir}' && npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts"

  local repaired_native_modules=()

  if [[ -d "${backend_dir}/prebuilts/node-pty/prebuilds/linux-x64" ]]; then
    mkdir -p "${backend_dir}/node_modules/node-pty/prebuilds/linux-x64"
    cp -f "${backend_dir}/prebuilts/node-pty/prebuilds/linux-x64/pty.node" \
          "${backend_dir}/node_modules/node-pty/prebuilds/linux-x64/pty.node"
    ok "Using prebuilt node-pty binary"
  else
    ensure_build_tools
    spin "Building node-pty from source" "cd '${backend_dir}' && npm rebuild node-pty"
  fi

  local runtime_modules=(bcrypt sharp)
  local module
  for module in "${runtime_modules[@]}"; do
    if [[ -d "${backend_dir}/node_modules/${module}" ]]; then
      repaired_native_modules+=("${module}")
    fi
  done

  if (( ${#repaired_native_modules[@]} > 0 )); then
    spin "Repairing native runtime modules" "cd '${backend_dir}' && npm rebuild ${repaired_native_modules[*]}"
  fi

  spin "Generating database client" "cd '${backend_dir}' && npx prisma generate 2>/dev/null || true"

  if ! (cd "${backend_dir}" && node <<'NODE' >> "$LOG_FILE" 2>&1
const checks = [
  ['@prisma/client', () => require('@prisma/client')],
  ['bcrypt', () => require('bcrypt')],
  ['sharp', () => require('sharp')],
  ['node-pty', () => require('node-pty')],
];
for (const [name, load] of checks) {
  try {
    load();
    console.log(`[runtime-check] ok ${name}`);
  } catch (error) {
    console.error(`[runtime-check] failed ${name}: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  }
}
NODE
  ); then
    fail "Runtime dependency verification failed — check ${LOG_FILE}"
  fi

  ok "Runtime dependencies verified"
}

run_migrations_safe() {
  local db_url="$1"
  local backend_dir="${PORTAL_DIR}/backend"
  local migration_dir="${backend_dir}/prisma/migrations"

  # ── Pre-flight: ensure migration files exist ──
  local migration_count=0
  if [[ -d "${migration_dir}" ]]; then
    migration_count=$(find "${migration_dir}" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
  fi

  if (( migration_count == 0 )); then
    echo ""
    echo -e "  ${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${RED}${BOLD}  DATABASE SETUP ERROR${NC}"
    echo ""
    echo -e "  ${WHITE}  No migration files found in:${NC}"
    echo -e "  ${DIM}  ${migration_dir}${NC}"
    echo ""
    echo -e "  ${WHITE}  This usually means the release tarball is incomplete.${NC}"
    echo -e "  ${WHITE}  The portal cannot start without database tables.${NC}"
    echo ""
    echo -e "  ${CYAN}  How to fix:${NC}"
    echo -e "  ${WHITE}  1. Re-download the installer and run again:${NC}"
    echo -e "  ${DIM}     curl -fsSL https://bridgesllm.ai/install.sh | sudo bash${NC}"
    echo ""
    echo -e "  ${WHITE}  2. Or manually re-download the portal tarball:${NC}"
    echo -e "  ${DIM}     curl -fsSL https://bridgesllm.ai/portal.tar.gz -o /tmp/portal.tar.gz${NC}"
    echo -e "  ${DIM}     tar xzf /tmp/portal.tar.gz -C /tmp${NC}"
    echo -e "  ${DIM}     cp -r /tmp/portal/backend/prisma/migrations ${migration_dir}${NC}"
    echo -e "  ${DIM}     cd ${backend_dir} && npx prisma migrate deploy${NC}"
    echo -e "  ${DIM}     systemctl restart bridgesllm-product${NC}"
    echo ""
    echo -e "  ${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    fail "No database migrations found — release package may be corrupt"
  fi

  info "Found ${migration_count} migration(s)"

  # ── Run migrations ──
  spin "Running database migrations" "cd '${backend_dir}' && DATABASE_URL='${db_url}' npx prisma migrate deploy"

  # ── Post-flight: verify tables were actually created ──
  # Parse the DATABASE_URL to connect with psql (handles custom ports/db names).
  local table_count=0
  local _db_host _db_port _db_name _db_user _db_pass
  _db_host=$(echo "${db_url}" | sed -n 's#.*@\([^:/]*\).*#\1#p')
  _db_port=$(echo "${db_url}" | sed -n 's#.*:\([0-9]*\)/.*#\1#p')
  _db_name=$(echo "${db_url}" | sed -n 's#.*/\([^?]*\).*#\1#p')
  _db_user=$(echo "${db_url}" | sed -n 's#.*://\([^:]*\):.*#\1#p')
  _db_pass=$(echo "${db_url}" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')
  _db_port="${_db_port:-5432}"

  table_count=$(PGPASSWORD="${_db_pass}" psql -h "${_db_host}" -p "${_db_port}" -U "${_db_user}" -d "${_db_name}" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" \
    2>/dev/null | tr -d '[:space:]' || echo "0")
  table_count="${table_count:-0}"

  # _prisma_migrations table always exists; we need at least a few more
  if (( table_count < 3 )); then
    echo ""
    echo -e "  ${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${RED}${BOLD}  DATABASE MIGRATION FAILED${NC}"
    echo ""
    echo -e "  ${WHITE}  Migrations ran but only ${table_count} table(s) were created.${NC}"
    echo -e "  ${WHITE}  Expected 10+. The database is incomplete.${NC}"
    echo ""
    echo -e "  ${CYAN}  How to fix:${NC}"
    echo -e "  ${WHITE}  1. Check the install log for errors:${NC}"
    echo -e "  ${DIM}     tail -50 ${LOG_FILE}${NC}"
    echo ""
    echo -e "  ${WHITE}  2. Try running migrations manually:${NC}"
    echo -e "  ${DIM}     cd ${backend_dir}${NC}"
    echo -e "  ${DIM}     DATABASE_URL='${db_url}' npx prisma migrate deploy${NC}"
    echo ""
    echo -e "  ${WHITE}  3. If that fails, check your database and retry:${NC}"
    echo -e "  ${DIM}     Verify database exists: psql '${db_url}' -c '\\dt'${NC}"
    echo -e "  ${DIM}     Then restart: systemctl restart bridgesllm-product${NC}"
    echo ""
    echo -e "  ${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    fail "Database migration incomplete — only ${table_count} tables created (expected 10+)"
  fi

  spin "Generating database client" "cd '${backend_dir}' && DATABASE_URL='${db_url}' npx prisma generate"
  ok "Database ready ${DIM}(${table_count} tables, ${migration_count} migrations)${NC}"
}

verify_portal_service_health() {
  local service_name="${1:-bridgesllm-product}"
  local health_url="${2:-http://127.0.0.1:4001/health}"
  local timeout_secs="${3:-60}"
  local waited=0 tick=0

  while (( waited < timeout_secs )); do
    if systemctl is-active --quiet "${service_name}" && curl -fsS --max-time 2 "${health_url}" >> "$LOG_FILE" 2>&1; then
      if [[ -t 1 ]]; then printf "\r%-120s\r" ""; fi
      ok "Portal is healthy"
      return 0
    fi

    if [[ -t 1 ]]; then
      draw_pulse_bar "$tick" "Waiting for portal" "$(format_elapsed $waited)"
    fi
    tick=$(( tick + 3 ))
    sleep 2
    waited=$((waited + 2))
  done

  if [[ -t 1 ]]; then printf "\r%-120s\r" ""; fi
  journalctl -u "${service_name}" -n 50 --no-pager >> "$LOG_FILE" 2>&1 || true
  return 1
}

update_dependencies() {
  info "Checking dependencies..."

  # ── Tier 1: Always update (pinned/safe) ──

  # OpenClaw
  if command -v openclaw &>/dev/null; then
    local current_oc
    current_oc="$(openclaw --version 2>/dev/null | head -1 | grep -oP '\d{4}\.\d+\.\d+' || echo '')"
    local latest_oc
    latest_oc="$(npm view openclaw version 2>/dev/null || echo '')"
    if [[ -n "${latest_oc}" && "${current_oc}" != "${latest_oc}" ]]; then
      spin "Updating OpenClaw (${current_oc} → ${latest_oc})"         "npm install -g openclaw@latest 2>/dev/null" || true
    else
      ok "OpenClaw ${current_oc:-unknown} (current)"
    fi
  fi

  # Ollama (curl | sh is idempotent — always installs latest)
  if command -v ollama &>/dev/null; then
    local current_ollama
    current_ollama="$(ollama --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo 'unknown')"
    spin "Updating Ollama (currently ${current_ollama})"       "curl -fsSL https://ollama.com/install.sh | sh >/dev/null 2>&1" || true
  fi

  # Coding tools — only update if already installed
  local pkg cmd current_ver latest_ver
  for pkg_spec in "@openai/codex:codex" "@anthropic-ai/claude-code:claude" "@google/gemini-cli:gemini"; do
    pkg="${pkg_spec%%:*}"
    cmd="${pkg_spec##*:}"
    if command -v "${cmd}" &>/dev/null; then
      current_ver="$(npm list -g "${pkg}" 2>/dev/null | grep "${pkg}" | grep -oP '\d+\.\d+\.\d+' | head -1 || echo '')"
      latest_ver="$(npm view "${pkg}" version 2>/dev/null || echo '')"
      if [[ -n "${latest_ver}" && "${current_ver}" != "${latest_ver}" ]]; then
        spin "Updating ${cmd} (${current_ver:-?} → ${latest_ver})"           "npm install -g ${pkg}@latest 2>/dev/null" || true
      else
        ok "${cmd} ${current_ver:-unknown} (current)"
      fi
    fi
  done

  # ── Tier 2: Minor/patch only (apt-based) ──

  # Node.js — update within major version
  if command -v node &>/dev/null; then
    local current_node_major
    current_node_major="$(node --version | grep -oP '(?<=v)\d+' || echo '0')"
    if (( current_node_major == PIN_NODE_MAJOR )); then
      spin "Updating Node.js (minor/patch)"         "apt-get update -qq && apt-get install -y -qq --only-upgrade nodejs 2>/dev/null" || true
    fi
  fi

  # Caddy — minor/patch
  if command -v caddy &>/dev/null; then
    spin "Updating Caddy (minor/patch)"       "apt-get install -y -qq --only-upgrade caddy 2>/dev/null" || true
  fi

  # ── Tier 3: Notify only ──
  # PostgreSQL — never auto-update major. Minor via apt is safe but requires restart.
  # Docker — user-managed. Don't touch.

  ok "Dependencies checked"
}

ensure_telemetry_install_id() {
  if [[ -z "${TELEMETRY_INSTALL_ID}" ]]; then
    TELEMETRY_INSTALL_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo "")"
  fi
}

# ── Progress display helpers ──────────────────────────────────

format_elapsed() {
  local secs="$1"
  if (( secs >= 60 )); then
    printf '%dm %ds' $((secs / 60)) $((secs % 60))
  else
    printf '%ds' "$secs"
  fi
}

format_bytes() {
  local bytes="$1"
  if (( bytes >= 1073741824 )); then
    printf '%.1f GB' "$(echo "scale=1; $bytes / 1073741824" | bc 2>/dev/null || echo '?')"
  elif (( bytes >= 1048576 )); then
    printf '%.1f MB' "$(echo "scale=1; $bytes / 1048576" | bc 2>/dev/null || echo '?')"
  elif (( bytes >= 1024 )); then
    printf '%.0f KB' "$(echo "scale=0; $bytes / 1024" | bc 2>/dev/null || echo '?')"
  else
    printf '%d B' "$bytes"
  fi
}

# Render a determinate progress bar (0–100%)
draw_pct_bar() {
  local pct="$1" msg="$2" detail="${3:-}"
  local bar_width=24
  local filled=$(( (pct * bar_width) / 100 ))
  (( filled > bar_width )) && filled=$bar_width
  local empty=$(( bar_width - filled ))

  local bar="" i
  for ((i = 0; i < filled; i++)); do bar+="█"; done
  for ((i = 0; i < empty; i++)); do bar+="░"; done

  if [[ -n "$detail" ]]; then
    printf "\r  ${CYAN}[${bar}]${NC} ${DIM}%3d%%${NC}  ${msg} ${DIM}${detail}${NC}          " "$pct"
  else
    printf "\r  ${CYAN}[${bar}]${NC} ${DIM}%3d%%${NC}  ${msg}          " "$pct"
  fi
}

# Render an indeterminate progress bar (pulsing glow)
draw_pulse_bar() {
  local tick="$1" msg="$2" detail="${3:-}"
  local bar_width=24
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local frame="${frames[$(( tick % ${#frames[@]} ))]}"

  # Pulse: a bright segment that sweeps back and forth
  local cycle=$(( bar_width * 2 ))
  local pos=$(( tick % cycle ))
  if (( pos >= bar_width )); then
    pos=$(( cycle - pos ))
  fi

  local bar="" i
  for ((i = 0; i < bar_width; i++)); do
    local dist=$(( i - pos ))
    (( dist < 0 )) && dist=$(( -dist ))
    if (( dist == 0 )); then
      bar+="█"
    elif (( dist == 1 )); then
      bar+="▓"
    elif (( dist == 2 )); then
      bar+="▒"
    else
      bar+="░"
    fi
  done

  if [[ -n "$detail" ]]; then
    printf "\r  ${CYAN}${frame}${NC} ${CYAN}[${bar}]${NC} ${msg} ${DIM}${detail}${NC}          "
  else
    printf "\r  ${CYAN}${frame}${NC} ${CYAN}[${bar}]${NC} ${msg}          "
  fi
}

# ── Core spin: indeterminate progress with elapsed time ──────

spin() {
  local msg="$1"; shift
  if $DRY_RUN; then
    echo "  [dry-run] $*" >> "$LOG_FILE" 2>&1
    return
  fi
  if ! $PACKAGE_MANAGER_REPAIR_ACTIVE && command_needs_package_manager "$*"; then
    wait_for_package_manager_ready "$msg"
  fi
  bash -c "$*" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  local start_ts tick=0
  start_ts=$(date +%s)

  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      local now elapsed
      now=$(date +%s)
      elapsed=$(( now - start_ts ))
      draw_pulse_bar "$tick" "$msg" "$(format_elapsed $elapsed)"
      tick=$(( tick + 1 ))
      sleep 0.15
    done
  else
    echo -e "  ${CYAN}⠿${NC} ${msg}..."
  fi

  wait "$pid"
  local rc=$?
  if [[ -t 1 ]]; then
    printf "\r%-120s\r" ""
  fi
  if [[ $rc -eq 0 ]]; then
    local end_ts total
    end_ts=$(date +%s)
    total=$(( end_ts - start_ts ))
    if (( total > 2 )); then
      ok "${msg} ${DIM}($(format_elapsed $total))${NC}"
    else
      ok "${msg}"
    fi
  fi
  return $rc
}

# ── Download with real progress (curl + actual bytes) ────────

spin_download() {
  local msg="$1" url="$2" dest="$3"
  if $DRY_RUN; then
    echo "  [dry-run] curl $url → $dest" >> "$LOG_FILE" 2>&1
    return
  fi

  # Get total size via HEAD request for real percentage
  local total_bytes=0
  total_bytes=$(curl -fsSLI "$url" 2>/dev/null | grep -i '^content-length:' | awk '{print $2}' | tr -d '\r' || echo 0)

  # Download in background, track file size for real progress
  curl -fSL "$url" -o "$dest" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  local start_ts tick=0
  start_ts=$(date +%s)

  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      local now elapsed current_bytes=0 pct=0 speed_str=""
      now=$(date +%s)
      elapsed=$(( now - start_ts ))

      if [[ -f "$dest" ]]; then
        current_bytes=$(stat -c%s "$dest" 2>/dev/null || echo 0)
      fi

      if (( total_bytes > 0 && current_bytes > 0 )); then
        pct=$(( (current_bytes * 100) / total_bytes ))
        (( pct > 100 )) && pct=100
        if (( elapsed > 0 )); then
          local speed=$(( current_bytes / elapsed ))
          speed_str="$(format_bytes $current_bytes)/$(format_bytes $total_bytes)  $(format_bytes $speed)/s"
        else
          speed_str="$(format_bytes $current_bytes)/$(format_bytes $total_bytes)"
        fi
        draw_pct_bar "$pct" "$msg" "$speed_str"
      else
        # Indeterminate (no content-length)
        if (( current_bytes > 0 )); then
          draw_pulse_bar "$tick" "$msg" "$(format_bytes $current_bytes)  $(format_elapsed $elapsed)"
        else
          draw_pulse_bar "$tick" "$msg" "$(format_elapsed $elapsed)"
        fi
      fi
      tick=$(( tick + 1 ))
      sleep 0.3
    done
  else
    echo -e "  ${CYAN}⠿${NC} ${msg}..."
  fi

  wait "$pid"
  local rc=$?

  if [[ -t 1 ]]; then
    printf "\r%-120s\r" ""
  fi
  if [[ $rc -eq 0 ]]; then
    local final_size=0
    [[ -f "$dest" ]] && final_size=$(stat -c%s "$dest" 2>/dev/null || echo 0)
    local end_ts total
    end_ts=$(date +%s)
    total=$(( end_ts - start_ts ))
    if (( total > 2 )); then
      ok "${msg} ${DIM}($(format_bytes $final_size), $(format_elapsed $total))${NC}"
    else
      ok "${msg} ${DIM}($(format_bytes $final_size))${NC}"
    fi
  fi
  return $rc
}

# ── Apt install with package counting ────────────────────────

spin_apt() {
  local msg="$1"; shift
  # $@ = list of expected package names
  local expected_pkgs=("$@")
  local total=${#expected_pkgs[@]}

  if $DRY_RUN; then
    echo "  [dry-run] apt install ${expected_pkgs[*]}" >> "$LOG_FILE" 2>&1
    return
  fi
  if ! $PACKAGE_MANAGER_REPAIR_ACTIVE; then
    wait_for_package_manager_ready "$msg"
  fi

  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${expected_pkgs[@]}" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  local start_ts tick=0
  start_ts=$(date +%s)

  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      local now elapsed installed=0 current_pkg=""
      now=$(date +%s)
      elapsed=$(( now - start_ts ))

      # Count how many of our target packages are now installed
      for pkg in "${expected_pkgs[@]}"; do
        if dpkg -s "$pkg" &>/dev/null 2>&1; then
          installed=$(( installed + 1 ))
        fi
      done

      # Try to identify what's being worked on from the log tail
      current_pkg="$(tail -3 "$LOG_FILE" 2>/dev/null | grep -oP '(?:Setting up|Unpacking|Preparing to unpack) \K[^ ]+' | tail -1 || true)"
      current_pkg="${current_pkg%%:*}"  # strip arch suffix

      if (( total > 0 && installed > 0 )); then
        local pct=$(( (installed * 100) / total ))
        local detail="${installed}/${total}"
        [[ -n "$current_pkg" ]] && detail="${detail} · ${current_pkg}"
        draw_pct_bar "$pct" "$msg" "$detail"
      else
        local detail="$(format_elapsed $elapsed)"
        [[ -n "$current_pkg" ]] && detail="${detail} · ${current_pkg}"
        draw_pulse_bar "$tick" "$msg" "$detail"
      fi
      tick=$(( tick + 1 ))
      sleep 0.5
    done
  else
    echo -e "  ${CYAN}⠿${NC} ${msg}..."
  fi

  wait "$pid"
  local rc=$?
  if [[ -t 1 ]]; then
    printf "\r%-120s\r" ""
  fi
  if [[ $rc -eq 0 ]]; then
    local end_ts total_t
    end_ts=$(date +%s)
    total_t=$(( end_ts - start_ts ))
    if (( total_t > 2 )); then
      ok "${msg} ${DIM}(${total} packages, $(format_elapsed $total_t))${NC}"
    else
      ok "${msg}"
    fi
  fi
  return $rc
}

rand_hex()  { openssl rand -hex "${1:-32}"; }
rand_pass() { openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c "${1:-24}"; }

handle_sigint() {
  echo ""
  echo -e "\n  ${YELLOW}⚠  Installation cancelled by user${NC}"
  echo ""
  exit 130
}

handle_err() {
  local exit_code=$?
  local line_no=${1:-unknown}
  fail "Unexpected error (exit ${exit_code}) at line ${line_no}"
}

trap 'handle_err $LINENO' ERR
trap handle_sigint SIGINT

ensure_keyring_from_url() {
  local url="$1"
  local keyring="$2"
  local tmp
  tmp="$(mktemp)"

  if $DRY_RUN; then
    echo "  [dry-run] refresh keyring ${keyring} from ${url}" >> "$LOG_FILE" 2>&1
    rm -f "$tmp"
    return
  fi

  curl -fsSL "${url}" | gpg --dearmor > "${tmp}"
  install -D -m 0644 "${tmp}" "${keyring}"
  rm -f "${tmp}"
}

read_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "${file}" ]] || return 1
  python3 - "${file}" "${key}" <<'PY2'
import sys
from pathlib import Path
file_path, key = sys.argv[1], sys.argv[2]
for raw in Path(file_path).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    if k.strip() != key:
        continue
    v = v.strip()
    if len(v) >= 2 and ((v[0] == v[-1]) and v[0] in {'"', "'"}):
        v = v[1:-1]
    print(v)
    break
PY2
}

write_caddy_config() {
  if [[ -n "$DOMAIN" ]]; then
    cat > /etc/caddy/Caddyfile <<CADDYEOF
# BridgesLLM Portal — managed by installer
${DOMAIN}, www.${DOMAIN} {
  # Show the BridgesLLM splash on the bare root path for first-time visitors.
  # Logged-in users, or users who have chosen to continue to their portal,
  # bypass the splash and go straight to the portal backend.
  @splash {
    path /
    not header_regexp Cookie accessToken=
    not header_regexp Cookie blm_user=
  }
  handle @splash {
    header Cache-Control "no-store"
    root * /var/www/bridgesllm-marketing
    rewrite * /splash.html
    file_server
  }

  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
CADDYEOF
    return
  fi

  if [[ -n "${PUBLIC_IP}" && "${PUBLIC_IP}" != "0.0.0.0" ]]; then
    cat > /etc/caddy/Caddyfile <<CADDYEOF
# BridgesLLM Portal — managed by installer
# Domain will be configured via setup wizard
http://${PUBLIC_IP} {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
CADDYEOF
  else
    cat > /etc/caddy/Caddyfile <<'CADDYEOF'
# BridgesLLM Portal — managed by installer
# Domain will be configured via setup wizard
:80 {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
CADDYEOF
  fi
}

# ═══════════════════════════════════════════════════════════════
# Args
# ═══════════════════════════════════════════════════════════════

usage() {
  cat << 'EOF'
BridgesLLM Portal Installer

Usage:
  curl -fsSL https://bridgesllm.ai/install.sh | sudo bash

Options:
  --domain DOMAIN   Pre-set domain (enables HTTPS immediately)
  --skip-ollama     Don't install Ollama
  --skip-openclaw   Don't install OpenClaw
  --update          Update existing installation
  --uninstall       Remove BridgesLLM portal
  --dry-run         Print actions without executing
  -h, --help        Show this help

Requirements:
  - Ubuntu 22.04/24.04 or Debian 12+
  - Root access
  - 3.5GB+ RAM, 35GB+ disk, 2+ CPUs recommended
  - Ports 80, 443 available
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)         DOMAIN="${2:-}"; shift 2 ;;
      --skip-ollama)    SKIP_OLLAMA=true; shift ;;
      --skip-openclaw)  SKIP_OPENCLAW=true; shift ;;
      --update)         UPDATE_MODE=true; shift ;;
      --uninstall)      UNINSTALL_MODE=true; shift ;;
      --dry-run)        DRY_RUN=true; shift ;;
      -h|--help)        usage; exit 0 ;;
      *)                echo "Unknown option: $1"; usage; exit 1 ;;
    esac
  done
}

# ═══════════════════════════════════════════════════════════════
# Step 1: Preflight
# ═══════════════════════════════════════════════════════════════

preflight() {
  step_header "Checking system requirements"
  CURRENT_STEP="preflight"

  # Root
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Must run as root. Use: sudo bash ${SCRIPT_NAME}"

  # OS
  if [[ -f /etc/os-release ]]; then
    OS_ID="$(grep -oP '^ID=\K.*' /etc/os-release | tr -d '"' || echo unknown)"
    OS_VERSION="$(grep -oP '^VERSION_ID=\K.*' /etc/os-release | tr -d '"' || echo unknown)"
  fi
  command -v apt-get &>/dev/null && APT_AVAILABLE=true

  case "${OS_ID}" in
    ubuntu|debian) ;;
    *) warn "Detected ${OS_ID} ${OS_VERSION} — tested on Ubuntu/Debian only" ;;
  esac

  # RAM
  local mem_mb
  mem_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
  (( mem_mb >= MIN_RAM_MB )) || fail "Need ${MIN_RAM_MB}MB+ RAM (found: ${mem_mb}MB)"

  # Disk
  local disk_gb
  disk_gb=$(df -BG / | awk 'NR==2 {gsub("G",""); print $4}')
  (( disk_gb >= MIN_DISK_GB )) || fail "Need ${MIN_DISK_GB}GB+ disk (found: ${disk_gb}GB)"

  # CPUs
  local cpus
  cpus=$(nproc 2>/dev/null || echo 1)
  (( cpus >= 2 )) || warn "Only ${cpus} CPU — 2+ CPUs recommended for best performance"

  local uptime_min
  uptime_min=$(awk '{print int($1/60)}' /proc/uptime 2>/dev/null || echo 9999)

  echo ""
  print_kv "OS" "${OS_ID^} ${OS_VERSION}" "$WHITE"
  print_kv "CPUs" "${cpus}" "$WHITE"
  print_kv "RAM" "${mem_mb} MB" "$WHITE"
  print_kv "Disk free" "${disk_gb} GB" "$WHITE"
  print_kv "Uptime" "${uptime_min} min" "$WHITE"
  echo ""

  if (( uptime_min < 20 )); then
    warn "Fresh VPS detected. First-boot package tasks may still be running in the background."
    info "If package setup pauses later, the installer will now show what it is waiting on and continue automatically."
  fi

  # Ports
  local blocked=""
  for port in 80 443; do
    if ss -tlnp "sport = :${port}" 2>/dev/null | grep -q ":${port}"; then
      blocked+=" $port"
    fi
  done
  [[ -z "$blocked" ]] && ok "Ports 80, 443 available" || warn "Ports${blocked} in use — Caddy will take them over"

  # Internet
  curl -fsSL --max-time 10 https://www.google.com &>/dev/null || fail "No internet connectivity"

  # Public IP
  PUBLIC_IP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || \
              curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || \
              echo "")
  if [[ -n "$PUBLIC_IP" ]]; then
    print_kv "Public IP" "${PUBLIC_IP}" "$GREEN"
  else
    warn "Could not detect public IP"
    PUBLIC_IP="0.0.0.0"
  fi

  if $APT_AVAILABLE; then
    wait_for_package_manager_ready "system preflight"
  fi

  # Core tools — always ensure lsb-release is present (needed by PostgreSQL repo setup)
  local missing=""
  for cmd in curl git openssl rsync lsb_release; do
    command -v "$cmd" &>/dev/null || missing+=" $cmd"
  done
  if [[ -n "$missing" ]]; then
    $APT_AVAILABLE || fail "Missing:${missing} — and apt is not available"
    info "Installing core tools..."
    run "apt-get update -qq && apt-get install -y -qq curl git openssl rsync ca-certificates gnupg lsb-release ffmpeg python3-venv"
  fi

  ok "System checks passed"
}

# ═══════════════════════════════════════════════════════════════
# Step 2: System packages
# ═══════════════════════════════════════════════════════════════

install_system_packages() {
  step_header "Installing system packages"
  CURRENT_STEP="system packages"

  # Node.js 22
  if command -v node &>/dev/null; then
    local major
    major=$(node -v | sed 's/^v//' | cut -d. -f1)
    if (( major >= PIN_NODE_MAJOR )); then
      ok "Node.js $(node -v)"
    else
      spin "Setting up Node.js ${PIN_NODE_MAJOR} repository" "curl -fsSL https://deb.nodesource.com/setup_${PIN_NODE_MAJOR}.x | bash -"
      spin "Installing Node.js ${PIN_NODE_MAJOR}" "apt-get install -y -qq nodejs"
      ok "Node.js $(node -v)"
    fi
  else
    spin "Setting up Node.js ${PIN_NODE_MAJOR} repository" "curl -fsSL https://deb.nodesource.com/setup_${PIN_NODE_MAJOR}.x | bash -"
    spin "Installing Node.js ${PIN_NODE_MAJOR}" "apt-get install -y -qq nodejs"
    ok "Node.js $(node -v)"
  fi

  # PostgreSQL 16
  if command -v psql &>/dev/null; then
    ok "PostgreSQL $(psql --version | grep -oP '\d+' | head -1)"
  else
    run "apt-get install -y -qq wget"
    run "sh -c 'echo \"deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt \$(lsb_release -cs)-pgdg main\" > /etc/apt/sources.list.d/pgdg.list'"
    progress "Refreshing PostgreSQL signing key..."
    ensure_keyring_from_url "https://www.postgresql.org/media/keys/ACCC4CF8.asc" "/usr/share/keyrings/postgresql-keyring.gpg"
    spin "Installing PostgreSQL 16" "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16 postgresql-contrib-16"
    run "systemctl enable postgresql && systemctl start postgresql"
    ok "PostgreSQL 16"
  fi

  # Caddy
  if command -v caddy &>/dev/null; then
    ok "Caddy web server"
  else
    run "apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https"
    progress "Refreshing Caddy signing key..."
    ensure_keyring_from_url "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    run "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list"
    spin "Installing Caddy web server" "apt-get update -qq && apt-get install -y -qq caddy"
    ok "Caddy web server"
  fi

  # Docker
  if command -v docker &>/dev/null; then
    ok "Docker"
  else
    spin "Installing Docker" "curl -fsSL https://get.docker.com | sh"
    run "systemctl enable docker && systemctl start docker"
    ok "Docker"
  fi

  # ClamAV
  if command -v clamscan &>/dev/null; then
    ok "ClamAV antivirus"
  else
    spin "Installing ClamAV antivirus" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq clamav clamav-daemon"
    run "systemctl stop clamav-freshclam 2>/dev/null || true"
    spin "Updating virus definitions" "freshclam || true"
    run "systemctl enable clamav-daemon clamav-freshclam 2>/dev/null || true"
    run "systemctl start clamav-freshclam 2>/dev/null || true"
    run "systemctl start clamav-daemon 2>/dev/null || true"
    ok "ClamAV antivirus"
  fi

  # UFW
  command -v ufw &>/dev/null || run "apt-get install -y -qq ufw"
  ok "Firewall (UFW)"

  # Remote Desktop packages (VNC + XFCE desktop + PulseAudio)
  local rd_pkgs=(tigervnc-standalone-server novnc websockify xfce4 xfce4-goodies xfce4-terminal dbus-x11 x11-utils xterm firefox pulseaudio pulseaudio-utils librsvg2-common)
  local rd_missing=()
  for pkg in "${rd_pkgs[@]}"; do
    if ! dpkg -s "$pkg" &>/dev/null; then
      rd_missing+=("$pkg")
    fi
  done
  if [[ ${#rd_missing[@]} -eq 0 ]]; then
    ok "Remote Desktop packages"
  else
    run "apt-get update -qq"
    spin_apt "Installing Remote Desktop packages" "${rd_missing[@]}"
    ok "Remote Desktop packages"
  fi

  # Desktop themes (Greybird + elementary icons)
  local theme_pkgs=(greybird-gtk-theme elementary-xfce-icon-theme numix-gtk-theme gnome-themes-extra)
  local themes_missing=()
  for pkg in "${theme_pkgs[@]}"; do
    if ! dpkg -s "$pkg" &>/dev/null; then
      themes_missing+=("$pkg")
    fi
  done
  if [[ ${#themes_missing[@]} -eq 0 ]]; then
    ok "Desktop themes"
  else
    spin_apt "Installing desktop themes" "${themes_missing[@]}" || true
    ok "Desktop themes"
  fi

  # Google Chrome
  if dpkg -s google-chrome-stable &>/dev/null 2>&1; then
    ok "Google Chrome"
  else
    spin_download "Downloading Google Chrome" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" "/tmp/google-chrome.deb"
    spin "Installing Google Chrome" "DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/google-chrome.deb && rm -f /tmp/google-chrome.deb" || true
    ok "Google Chrome"
  fi
}

# ═══════════════════════════════════════════════════════════════
# Step 3: AI tools
# ═══════════════════════════════════════════════════════════════

install_ai_tools() {
  step_header "Installing AI tools"
  CURRENT_STEP="AI tools"

  # Ollama
  if $SKIP_OLLAMA; then
    info "Skipping Ollama (--skip-ollama)"
  elif command -v ollama &>/dev/null; then
    ok "Ollama"
  else
    spin "Installing Ollama (local AI engine)" "curl -fsSL https://ollama.com/install.sh | sh"
    run "systemctl enable ollama 2>/dev/null || true"
    ok "Ollama — models will be configured in the setup wizard"
  fi

  # OpenClaw
  if $SKIP_OPENCLAW; then
    info "Skipping OpenClaw (--skip-openclaw)"
  elif command -v openclaw &>/dev/null; then
    ok "OpenClaw $(openclaw --version 2>/dev/null | head -1 || echo '')"
  else
    spin "Installing OpenClaw (AI agent framework)" "npm install -g openclaw@latest"
    ok "OpenClaw"
  fi

  # Configure OpenClaw gateway with the portal's operator token
  if ! $SKIP_OPENCLAW && command -v openclaw &>/dev/null; then
    local oc_dir="${HOME}/.openclaw"
    local oc_config="${oc_dir}/openclaw.json"
    mkdir -p "${oc_dir}"

    # Generate a token early if we don't have one yet
    [[ -n "${OPENCLAW_TOKEN}" ]] || OPENCLAW_TOKEN="$(rand_hex 24)"

    if [[ -f "${oc_config}" ]]; then
      # Read existing token if set, otherwise inject ours
      local existing_oc_token
      existing_oc_token="$(python3 -c "
import json
try:
    d = json.load(open('${oc_config}'))
    print(d.get('gateway',{}).get('auth',{}).get('token',''))
except: pass
" 2>/dev/null || true)"
      if [[ -n "${existing_oc_token}" ]]; then
        # Use OpenClaw's existing token for the portal
        OPENCLAW_TOKEN="${existing_oc_token}"
      else
        # Inject our token into OpenClaw's config
        python3 -c "
import json
d = json.load(open('${oc_config}'))
d.setdefault('gateway', {}).setdefault('auth', {})['token'] = '${OPENCLAW_TOKEN}'
d['gateway']['auth']['mode'] = 'token'
d['gateway']['port'] = 18789
json.dump(d, open('${oc_config}', 'w'), indent=2)
" 2>/dev/null || true
      fi
    else
      # Create minimal OpenClaw config with gateway token
      cat > "${oc_config}" << OCEOF
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_TOKEN}"
    }
  }
}
OCEOF
      chmod 600 "${oc_config}"
    fi
    ok "OpenClaw gateway configured"
  fi
}

# ═══════════════════════════════════════════════════════════════
# Step 4: Database
# ═══════════════════════════════════════════════════════════════

setup_database() {
  step_header "Setting up database"
  CURRENT_STEP="database"

  if [[ -f "${PORTAL_DIR}/backend/.env.production" ]]; then
    DB_PASSWORD="$(read_env_value "${PORTAL_DIR}/backend/.env.production" "DATABASE_URL" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p' || true)"
    [[ -n "${DB_PASSWORD}" ]] && info "Reusing existing database credentials"
  fi
  [[ -n "${DB_PASSWORD}" ]] || DB_PASSWORD="$(rand_pass 24)"

  # Create user
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='blp'" 2>/dev/null | grep -q 1; then
    run "sudo -u postgres psql -c \"ALTER USER blp WITH PASSWORD '${DB_PASSWORD}';\""
  else
    run "sudo -u postgres psql -c \"CREATE USER blp WITH PASSWORD '${DB_PASSWORD}';\""
  fi

  # Create database
  if ! sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='bridgesllm_portal'" 2>/dev/null | grep -q 1; then
    run "sudo -u postgres psql -c \"CREATE DATABASE bridgesllm_portal OWNER blp;\""
  fi
  run "sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE bridgesllm_portal TO blp;\""

  ok "Database ready ${DIM}(bridgesllm_portal)${NC}"
}

# ═══════════════════════════════════════════════════════════════
# Step 5: Build portal
# ═══════════════════════════════════════════════════════════════

build_portal() {
  step_header "Installing portal"
  CURRENT_STEP="portal build"

  # Create directories
  mkdir -p "${INSTALL_ROOT}" "${PORTAL_DIR}" "${LOG_DIR}"
  mkdir -p "${INSTALL_ROOT}/apps" "${INSTALL_ROOT}/uploads" "${INSTALL_ROOT}/backups"
  mkdir -p "${INSTALL_ROOT}/assets/avatars" "${INSTALL_ROOT}/assets/branding"
  mkdir -p "${INSTALL_ROOT}/assets/branding"
  mkdir -p "${PORTAL_DIR}/projects" "${PORTAL_DIR}/upload-temp"
  chmod 755 "${PORTAL_DIR}/projects" "${PORTAL_DIR}/upload-temp"

  # Download or copy portal
  if [[ -d "${RELEASE_FALLBACK_DIR}" ]] && [[ -f "${RELEASE_FALLBACK_DIR}/backend/package.json" ]]; then
    spin "Copying portal files from local source" "rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.production' --exclude='/projects' --exclude='/assets' --exclude='/upload-temp' --exclude='/.data' '${RELEASE_FALLBACK_DIR}/' '${PORTAL_DIR}/'"
  elif curl -fsSL --head "${RELEASE_URL}" &>/dev/null 2>&1; then
    mkdir -p /tmp/blp-download
    spin_download "Downloading portal" "${RELEASE_URL}" "/tmp/blp-download/portal.tar.gz"
    spin "Extracting portal" "tar -xzf /tmp/blp-download/portal.tar.gz -C /tmp/blp-download && rsync -a --exclude='/projects' --exclude='/assets' --exclude='/.data' /tmp/blp-download/portal/ '${PORTAL_DIR}/' && rm -rf /tmp/blp-download"
  else
    fail "Cannot find portal source"
  fi

  install_backend_runtime_dependencies

  ok "Portal files ready"

  local existing_env="${PORTAL_DIR}/backend/.env.production"
  local existing_database_url=""
  if [[ -f "${existing_env}" ]]; then
    info "Preserving existing secrets"
    existing_database_url="$(read_env_value "${existing_env}" "DATABASE_URL" || true)"
    JWT_SECRET="$(read_env_value "${existing_env}" "JWT_SECRET" || true)"
    JWT_REFRESH_SECRET="$(read_env_value "${existing_env}" "JWT_REFRESH_SECRET" || true)"
    # Only read OPENCLAW_TOKEN from env if not already set by install_ai_tools()
    # (which adopts the token from openclaw.json on fresh installs)
    if [[ -z "${OPENCLAW_TOKEN}" ]]; then
      OPENCLAW_TOKEN="$(read_env_value "${existing_env}" "OPENCLAW_GATEWAY_TOKEN" || true)"
    fi
    SETUP_TOKEN="$(read_env_value "${existing_env}" "SETUP_TOKEN" || true)"
  fi

  [[ -n "${JWT_SECRET}" ]] || JWT_SECRET="$(rand_hex 32)"
  [[ -n "${JWT_REFRESH_SECRET}" ]] || JWT_REFRESH_SECRET="$(rand_hex 32)"
  [[ -n "${OPENCLAW_TOKEN}" ]] || OPENCLAW_TOKEN="$(rand_hex 24)"
  [[ -n "${SETUP_TOKEN}" ]] || SETUP_TOKEN="$(rand_hex 32)"
  ensure_telemetry_install_id

  if [[ -n "${existing_database_url}" ]]; then
    DB_PASSWORD=$(printf '%s' "${existing_database_url}" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')
  fi

  # Build the DATABASE_URL — PRESERVE existing URL on updates to respect
  # custom port/database name. Only construct a new one for fresh installs.
  local final_database_url=""
  if [[ -n "${existing_database_url}" ]]; then
    final_database_url="${existing_database_url}"
    info "Preserving existing DATABASE_URL ($(echo "${existing_database_url}" | sed 's#://[^:]*:[^@]*@#://***:***@#'))"
  else
    [[ -n "${DB_PASSWORD}" ]] || DB_PASSWORD="$(rand_pass 24)"
    final_database_url="postgresql://blp:${DB_PASSWORD}@127.0.0.1:5432/bridgesllm_portal"
  fi

  # Write .env.production
  local cors_origin="http://${PUBLIC_IP}"
  [[ -n "$DOMAIN" ]] && cors_origin="https://${DOMAIN},https://www.${DOMAIN}"

  cat > "${PORTAL_DIR}/backend/.env.production" << ENVEOF
# Generated by BridgesLLM installer v${VERSION} — $(date)
NODE_ENV=production
PORT=4001

DATABASE_URL="${final_database_url}"
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}

PORTAL_ROOT=${PORTAL_DIR}
INSTALL_ROOT=${INSTALL_ROOT}
APPS_ROOT=${INSTALL_ROOT}/apps
UPLOAD_DIR=${INSTALL_ROOT}/uploads

CORS_ORIGIN=${cors_origin}
PUBLIC_IP=${PUBLIC_IP}
DOMAIN=${DOMAIN}

OPENCLAW_API_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_TOKEN}

OLLAMA_API_URL=http://127.0.0.1:11434

# One-time setup token — cleared after wizard completes
SETUP_TOKEN=${SETUP_TOKEN}
TELEMETRY_INSTALL_ID=${TELEMETRY_INSTALL_ID}
ENVEOF
  chmod 600 "${PORTAL_DIR}/backend/.env.production"

  # Create .env symlink so dotenv.config() finds the production env file
  ln -sf .env.production "${PORTAL_DIR}/backend/.env"

  ok "Configuration generated"

  # Frontend env
  printf 'VITE_API_URL=/api\n' > "${PORTAL_DIR}/frontend/.env"

  # Run migrations
  local db_url="postgresql://blp:${DB_PASSWORD}@127.0.0.1:5432/bridgesllm_portal"
  run_migrations_safe "${db_url}"

  # Build
  if [[ -f "${PORTAL_DIR}/frontend/dist/index.html" ]] && [[ -f "${PORTAL_DIR}/backend/dist/server.js" ]]; then
    ok "Prebuilt artifacts detected — no compilation needed"
  else
    info "Packaged build artifacts missing — building from source"
    spin "Building frontend" "cd '${PORTAL_DIR}/frontend' && npm run build"
    spin "Building backend" "cd '${PORTAL_DIR}/backend' && npm run build"
    ok "Build complete"
  fi
}

# ═══════════════════════════════════════════════════════════════
# Step 6: Configure services
# ═══════════════════════════════════════════════════════════════

configure_services() {
  step_header "Configuring services"
  CURRENT_STEP="service configuration"

  $DRY_RUN && { ok "[dry-run] Would create systemd service + Caddy config"; return; }

  # Systemd service
  cat > /etc/systemd/system/bridgesllm-product.service << SVCEOF
[Unit]
Description=BridgesLLM Portal
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=${PORTAL_DIR}/backend
EnvironmentFile=${PORTAL_DIR}/backend/.env.production
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable bridgesllm-product >> "$LOG_FILE" 2>&1
  ok "Portal service created"

  # Caddy
  write_caddy_config
  caddy validate --config /etc/caddy/Caddyfile >> "$LOG_FILE" 2>&1 || fail "Caddy configuration is invalid"
  systemctl enable caddy >> "$LOG_FILE" 2>&1
  systemctl restart caddy >> "$LOG_FILE" 2>&1
  ok "Web server configured"

  # OpenClaw gateway service (if installed)
  if ! $SKIP_OPENCLAW && command -v openclaw &>/dev/null; then
    local oc_bin
    oc_bin="$(which openclaw 2>/dev/null || echo '/usr/bin/openclaw')"
    if [[ ! -f /etc/systemd/system/openclaw-gateway.service ]]; then
      cat > /etc/systemd/system/openclaw-gateway.service << OCSVCEOF
[Unit]
Description=OpenClaw AI Gateway
After=network.target

[Service]
Type=simple
User=root
ExecStart=${oc_bin} gateway run
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
OCSVCEOF
      systemctl daemon-reload
      systemctl enable openclaw-gateway >> "$LOG_FILE" 2>&1
    fi
    ok "OpenClaw gateway service configured"
  fi

  # Firewall
  ufw allow 22/tcp >> "$LOG_FILE" 2>&1
  ufw allow 80/tcp >> "$LOG_FILE" 2>&1
  ufw allow 443/tcp >> "$LOG_FILE" 2>&1
  ufw deny 4001/tcp >> "$LOG_FILE" 2>&1
  ufw --force enable >> "$LOG_FILE" 2>&1 || true
  ok "Firewall configured"
}

# ═══════════════════════════════════════════════════════════════
# Step 7: Remote Desktop
# ═══════════════════════════════════════════════════════════════

setup_remote_desktop() {
  step_header "Setting up Remote Desktop"
  CURRENT_STEP="remote desktop"

  $DRY_RUN && { ok "[dry-run] Would configure Remote Desktop"; return; }

  local RD_USER="bridgesrd"
  local XDG_DIR="/tmp/bridges-rd-runtime"
  local LOG_RD="/var/log/bridges-rd"

  # Create service user
  if id "$RD_USER" &>/dev/null; then
    ok "User $RD_USER exists"
  else
    useradd -r -m -s /bin/bash "$RD_USER"
    ok "Created user $RD_USER"
  fi

  mkdir -p "$XDG_DIR" "$LOG_RD"
  chown "$RD_USER:$RD_USER" "$XDG_DIR" "$LOG_RD"
  chmod 700 "$XDG_DIR"

  # Deploy complete XFCE desktop config (Greybird theme, panel layout, keyboard
  # shortcuts, session settings, etc.) — snapshotted from production.
  # Only deploy if this is a fresh install or the config dir doesn't exist yet.
  local xfce_config_dir="/home/$RD_USER/.config/xfce4"
  local xfce_source="${PORTAL_DIR}/installer/xfce4-config"
  if [[ -d "$xfce_source" ]]; then
    mkdir -p "$xfce_config_dir"
    rsync -a "$xfce_source/" "$xfce_config_dir/"
  fi

  chown -R "$RD_USER:$RD_USER" "/home/$RD_USER/.config"
  ok "Desktop environment configured"

  # Web browser launcher (for noVNC URL bar)
  local web_launcher="/usr/local/bin/bridges-rd-web-open.sh"
  cat > "$web_launcher" << 'WEBEOF'
#!/bin/bash
URL="${1:-about:blank}"
if command -v google-chrome-stable &>/dev/null; then
  exec google-chrome-stable --no-sandbox --disable-gpu --start-maximized "$URL" 2>/dev/null
elif command -v firefox &>/dev/null; then
  exec firefox "$URL" 2>/dev/null
else
  echo "No browser found" >&2
  exit 1
fi
WEBEOF
  chmod 755 "$web_launcher"

  # VNC launcher script (identical to what auto-setup writes)
  local vnc_launcher="/usr/local/bin/bridges-rd-xtigervnc-start.sh"
  cat > "$vnc_launcher" << 'VNCEOF'
#!/bin/bash
set -euo pipefail

DISPLAY_NUM=:1
VNC_PORT=5901
GEOMETRY=1280x1024
DEPTH=24
RD_USER=bridgesrd
XDG_DIR="/tmp/bridges-rd-runtime"
LOG_DIR="/var/log/bridges-rd"

mkdir -p "$LOG_DIR"
chown "$RD_USER:$RD_USER" "$LOG_DIR"

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
pkill -u "$RD_USER" -f "Xvfb" 2>/dev/null || true
pkill -u "$RD_USER" -f "xfce4-session" 2>/dev/null || true

# Clear saved session cache so fresh configs always apply on restart
rm -rf /home/"$RD_USER"/.cache/sessions/* 2>/dev/null || true

mkdir -p "$XDG_DIR"
chown "$RD_USER:$RD_USER" "$XDG_DIR"
chmod 700 "$XDG_DIR"

/usr/bin/Xtigervnc "$DISPLAY_NUM" \
  -UseBlacklist=0 \
  -localhost=1 \
  -desktop "BridgesLLM Remote Desktop" \
  -rfbport "$VNC_PORT" \
  -SecurityTypes None \
  -geometry "$GEOMETRY" \
  -depth "$DEPTH" \
  -ac &

VNC_PID=$!

for i in $(seq 1 20); do
  if DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
    echo "Display $DISPLAY_NUM is ready (attempt $i)"
    break
  fi
  sleep 0.5
done

su - "$RD_USER" -c "
  export XDG_RUNTIME_DIR=$XDG_DIR
  pulseaudio --kill 2>/dev/null || true
  sleep 0.5
  # Retry loop — PulseAudio can fail on cold boot if XDG_RUNTIME_DIR isn't ready
  for attempt in 1 2 3 4 5; do
    if pulseaudio --start --exit-idle-time=-1 2>>$LOG_DIR/pulseaudio.log; then
      echo \"PulseAudio started on attempt \$attempt\"
      break
    fi
    echo \"PulseAudio start failed (attempt \$attempt), retrying...\" >>$LOG_DIR/pulseaudio.log
    sleep 2
  done
  sleep 1
  export PULSE_SERVER=unix:$XDG_DIR/pulse/native
  pactl set-default-sink auto_null 2>/dev/null || true
  pactl unload-module module-suspend-on-idle 2>/dev/null || true
  echo 'PulseAudio configured (suspend-on-idle disabled)'
" &
PA_PID=$!
wait $PA_PID 2>/dev/null || true
echo "PulseAudio initialized"

su - "$RD_USER" -c "
  export DISPLAY=$DISPLAY_NUM
  export XDG_RUNTIME_DIR=$XDG_DIR
  export PULSE_SERVER=unix:$XDG_DIR/pulse/native
  dbus-launch --exit-with-session startxfce4 >>$LOG_DIR/xfce.log 2>&1
" &

XFCE_PID=$!
echo "Xtigervnc PID=$VNC_PID, XFCE PID=$XFCE_PID"

sleep 5
DISPLAY="$DISPLAY_NUM" xset s off 2>/dev/null || true
DISPLAY="$DISPLAY_NUM" xset s noblank 2>/dev/null || true
pkill -f xfce4-screensaver 2>/dev/null || true
echo "Screensaver disabled"

wait $VNC_PID
VNCEOF
  chmod 755 "$vnc_launcher"
  ok "VNC launcher written"

  # Systemd units
  cat > /etc/systemd/system/bridges-rd-xtigervnc.service << VNCSVCEOF
[Unit]
Description=Bridges Remote Desktop Xtigervnc :1
After=network.target
Before=bridges-rd-websockify.service

[Service]
Type=simple
User=root
ExecStartPre=-/bin/bash -c 'rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true'
ExecStart=${vnc_launcher}
ExecStopPost=-/bin/bash -c 'pkill -f "Xtigervnc :1" 2>/dev/null || true'
Restart=always
RestartSec=3
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
VNCSVCEOF

  cat > /etc/systemd/system/bridges-rd-websockify.service << WSSVCEOF
[Unit]
Description=Bridges Remote Desktop noVNC Websockify
After=network.target bridges-rd-xtigervnc.service
Requires=bridges-rd-xtigervnc.service

[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 /usr/bin/websockify 6080 127.0.0.1:5901
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
WSSVCEOF

  systemctl daemon-reload

  # CRITICAL: Disable stock TigerVNC service — it races with ours for display :1
  systemctl disable --now vncserver@1.service 2>/dev/null || true
  systemctl mask vncserver@1.service 2>/dev/null || true
  systemctl mask vncserver@.service 2>/dev/null || true

  # Disable legacy service name if present
  systemctl disable --now bridges-rd-vnc.service 2>/dev/null || true

  systemctl enable bridges-rd-xtigervnc.service bridges-rd-websockify.service >> "$LOG_FILE" 2>&1
  systemctl restart bridges-rd-xtigervnc.service >> "$LOG_FILE" 2>&1
  sleep 2
  systemctl restart bridges-rd-websockify.service >> "$LOG_FILE" 2>&1

  ok "Remote Desktop services started"
}

# ═══════════════════════════════════════════════════════════════
# Step 8: Start
# ═══════════════════════════════════════════════════════════════

start_portal() {
  step_header "Starting portal"
  CURRENT_STEP="startup"

  # Start OpenClaw gateway first (portal connects to it)
  if systemctl is-enabled openclaw-gateway &>/dev/null 2>&1; then
    systemctl start openclaw-gateway >> "$LOG_FILE" 2>&1 || true
    sleep 3  # Let gateway fully initialize and write its config

    # CRITICAL: Sync the gateway token into .env.production
    # OpenClaw may regenerate its token on first start. Read the ACTUAL token
    # from openclaw.json and ensure .env.production matches.
    local oc_config_path="${HOME}/.openclaw/openclaw.json"
    if [[ -f "${oc_config_path}" ]]; then
      local live_token
      live_token="$(python3 -c "
import json
try:
    d = json.load(open('${oc_config_path}'))
    print(d.get('gateway',{}).get('auth',{}).get('token',''))
except: pass
" 2>/dev/null || true)"
      local env_file="${PORTAL_DIR}/backend/.env.production"
      if [[ -n "${live_token}" ]] && [[ -f "${env_file}" ]]; then
        local env_token
        env_token="$(read_env_value "${env_file}" "OPENCLAW_GATEWAY_TOKEN" || true)"
        if [[ "${live_token}" != "${env_token}" ]]; then
          info "Syncing gateway token (openclaw.json → .env.production)"
          sed -i "s/^OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=${live_token}/" "${env_file}"
        fi
      fi
    fi
  fi

  systemctl start bridgesllm-product

  # Auto-approve portal's device pairing with gateway (loopback should auto-approve
  # but some OpenClaw versions require explicit approval for operator-scoped devices)
  if command -v openclaw &>/dev/null; then
    sleep 3  # Wait for portal to attempt first connect
    openclaw devices approve --latest >> "$LOG_FILE" 2>&1 || true
  fi

  if ! verify_portal_service_health "bridgesllm-product" "http://127.0.0.1:4001/health" 60; then
    warn "Portal failed health verification — check: journalctl -u bridgesllm-product -n 50"
  fi
}

# ═══════════════════════════════════════════════════════════════
# Step 9: Done
# ═══════════════════════════════════════════════════════════════

print_success() {
  CURRENT_STEP_NUM=$((CURRENT_STEP_NUM + 1))

  local url
  if [[ -n "$DOMAIN" ]]; then
    url="https://${DOMAIN}/setup?token=${SETUP_TOKEN}"
  else
    if [[ -n "${PUBLIC_IP}" && "${PUBLIC_IP}" != "0.0.0.0" ]]; then
      url="http://${PUBLIC_IP}/setup?token=${SETUP_TOKEN}"
    else
      url="http://<server-ip>/setup?token=${SETUP_TOKEN}"
    fi
  fi

  local elapsed
  elapsed="$(elapsed_since_start)"

  echo ""
  echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  if [[ -n "$elapsed" ]]; then
    echo -e "  ${GREEN}${BOLD}  Installation complete!${NC}  ${DIM}(${elapsed})${NC}"
  else
    echo -e "  ${GREEN}${BOLD}  Installation complete!${NC}"
  fi
  echo ""
  echo -e "  ${WHITE}  Open this URL in your browser to finish setup:${NC}"
  echo ""
  echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}${CYAN}  ${url}${NC}"
  echo ""
  echo -e "  ${YELLOW}  This link contains a one-time security token.${NC}"
  echo -e "  ${DIM}  It will expire after you complete setup.${NC}"
  echo ""

  # What was installed summary
  echo -e "  ${DIM}What was installed:${NC}"
  local node_ver="" pg_ver="" caddy_ver="" docker_ver="" ollama_ver="" openclaw_ver=""
  node_ver="$(node -v 2>/dev/null || echo '?')"
  pg_ver="$(psql --version 2>/dev/null | grep -oP '\d+' | head -1 || echo '?')"
  caddy_ver="$(caddy version 2>/dev/null | head -1 | cut -d' ' -f1 || echo '?')"
  docker_ver="$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || echo '?')"
  ollama_ver="$(ollama --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo '-')"
  openclaw_ver="$(openclaw --version 2>/dev/null | head -1 | grep -oP '\d{4}\.\d+\.\d+(-\d+)?' || echo '-')"

  echo -e "  ${DIM}${BULLET}${NC} Node.js ${node_ver}  ${DIM}${BULLET}${NC} PostgreSQL ${pg_ver}  ${DIM}${BULLET}${NC} Caddy ${caddy_ver}"
  echo -e "  ${DIM}${BULLET}${NC} Docker ${docker_ver}  ${DIM}${BULLET}${NC} Ollama ${ollama_ver}  ${DIM}${BULLET}${NC} OpenClaw ${openclaw_ver}"
  echo ""

  if [[ -z "$DOMAIN" ]]; then
    echo -e "  ${DIM}You'll set up a domain and HTTPS in the setup wizard.${NC}"
  fi
  echo -e "  ${DIM}Log: ${LOG_FILE}${NC}"
  echo ""

  telemetry_event "install_complete" ",\"installId\":\"${TELEMETRY_INSTALL_ID}\""
}


# ═══════════════════════════════════════════════════════════════
# Update & Uninstall
# ═══════════════════════════════════════════════════════════════

do_update() {
  banner
  echo ""
  echo -e "  ${BOLD}${WHITE}Updating BridgesLLM Portal${NC}"
  echo ""
  CURRENT_STEP="update"

  [[ -d "${PORTAL_DIR}" ]] || fail "Portal not installed at ${PORTAL_DIR}"

  info "Backing up configuration..."
  local backup_dir="${INSTALL_ROOT}/backups/pre-update-${TIMESTAMP}"
  mkdir -p "${backup_dir}"
  cp "${PORTAL_DIR}/backend/.env.production" "${backup_dir}/" 2>/dev/null || true
  cp "${PORTAL_DIR}/frontend/.env" "${backup_dir}/" 2>/dev/null || true

  load_existing_telemetry_install_id

  info "Stopping portal..."
  systemctl stop bridgesllm-product 2>/dev/null || true

  # Safety net: if the update fails for ANY reason after stopping the service,
  # always try to restart it so the user doesn't lose their portal.
  trap 'echo ""; echo -e "  ${YELLOW}⚠ Update failed — restarting portal with previous version...${NC}"; systemctl start bridgesllm-product 2>/dev/null || true' ERR

  # Read existing DATABASE_URL directly — do NOT reconstruct it (port may differ)
  local existing_db_url=""
  if [[ -f "${PORTAL_DIR}/backend/.env.production" ]]; then
    existing_db_url="$(grep '^DATABASE_URL=' "${PORTAL_DIR}/backend/.env.production" | sed 's/^DATABASE_URL=//' | tr -d '"' || true)"
    DB_PASSWORD=$(echo "${existing_db_url}" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p' || true)
  fi

  # Download update — always prefer the tarball over local fallback dir.
  # The fallback dir may contain unbuilt source (dev repos), which would nuke
  # the production build via --delete. Only use fallback if download fails.
  local update_applied=false
  if curl -fsSL --head "${RELEASE_URL}" &>/dev/null 2>&1; then
    mkdir -p /tmp/blp-download
    spin_download "Downloading update" "${RELEASE_URL}" "/tmp/blp-download/portal.tar.gz"
    spin "Extracting update" "tar -xzf /tmp/blp-download/portal.tar.gz -C /tmp/blp-download && rsync -a --delete --exclude='/projects' --exclude='/assets' --exclude='/upload-temp' --exclude='/.data' --exclude='.env.production' --exclude='.env' /tmp/blp-download/portal/ '${PORTAL_DIR}/' && rm -rf /tmp/blp-download"
    update_applied=true
  elif [[ -d "${RELEASE_FALLBACK_DIR}" ]] && [[ -f "${RELEASE_FALLBACK_DIR}/backend/dist/server.js" ]]; then
    # Fallback to local source ONLY if it has built artifacts (dist/server.js)
    warn "Download unavailable — falling back to local source at ${RELEASE_FALLBACK_DIR}"
    spin "Syncing updated portal files" "rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.production' --exclude='/projects' --exclude='/assets' --exclude='/upload-temp' --exclude='/.data' '${RELEASE_FALLBACK_DIR}/' '${PORTAL_DIR}/'"
    update_applied=true
  fi

  if ! $update_applied; then
    fail "Cannot find update source (download failed and no local fallback with built artifacts)"
  fi

  # Restore config
  cp "${backup_dir}/.env.production" "${PORTAL_DIR}/backend/" 2>/dev/null || true
  cp "${backup_dir}/.env" "${PORTAL_DIR}/frontend/" 2>/dev/null || true

  # Ensure .env symlink exists (rsync --delete may have removed it)
  ln -sf .env.production "${PORTAL_DIR}/backend/.env"

  # Inject missing env vars introduced in newer versions
  local env_file="${PORTAL_DIR}/backend/.env.production"
  if [[ -f "${env_file}" ]]; then
    # Ensure file ends with a newline before appending
    [[ -s "${env_file}" && "$(tail -c1 "${env_file}")" != "" ]] && echo "" >> "${env_file}"

    # Fix corrupted MAIL_DOMAIN (previous bug concatenated DOMAIN= onto end of line)
    sed -i 's|^\(MAIL_DOMAIN=[^[:space:]]*\)DOMAIN=.*|\1|' "${env_file}"

    grep -q '^INSTALL_ROOT=' "${env_file}" || echo "INSTALL_ROOT=${INSTALL_ROOT}" >> "${env_file}"
    grep -q '^APPS_ROOT=' "${env_file}" || echo "APPS_ROOT=${INSTALL_ROOT}/apps" >> "${env_file}"
    grep -q '^UPLOAD_DIR=' "${env_file}" || echo "UPLOAD_DIR=${INSTALL_ROOT}/uploads" >> "${env_file}"
    if [[ -n "${TELEMETRY_INSTALL_ID}" ]]; then
      if grep -q '^TELEMETRY_INSTALL_ID=' "${env_file}"; then
        sed -i "s|^TELEMETRY_INSTALL_ID=.*|TELEMETRY_INSTALL_ID=${TELEMETRY_INSTALL_ID}|" "${env_file}"
      else
        echo "TELEMETRY_INSTALL_ID=${TELEMETRY_INSTALL_ID}" >> "${env_file}"
      fi
    fi
    # Inject/update DOMAIN if passed via --domain
    if [[ -n "$DOMAIN" ]]; then
      if grep -q '^DOMAIN=' "${env_file}"; then
        sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" "${env_file}"
      else
        echo "DOMAIN=${DOMAIN}" >> "${env_file}"
      fi
    fi

    # Inject JWT_REFRESH_SECRET if missing (old installs may not have it)
    if ! grep -q '^JWT_REFRESH_SECRET=' "${env_file}"; then
      printf '\n' >> "${env_file}"  # ensure trailing newline
      echo "JWT_REFRESH_SECRET=$(rand_hex 32)" >> "${env_file}"
    fi

    # Inject INSTALL_ROOT if missing
    if ! grep -q '^INSTALL_ROOT=' "${env_file}"; then
      echo "INSTALL_ROOT=${INSTALL_ROOT}" >> "${env_file}"
    fi
  fi

  install_backend_runtime_dependencies

  # Use the existing DATABASE_URL if available, otherwise construct a default
  local db_url="${existing_db_url:-postgresql://blp:${DB_PASSWORD}@127.0.0.1:5432/bridgesllm_portal}"
  run_migrations_safe "${db_url}"

  update_dependencies
  telemetry_event "deps_updated" ",\"installId\":\"${TELEMETRY_INSTALL_ID}\""

  if [[ -f "${PORTAL_DIR}/frontend/dist/index.html" ]] && [[ -f "${PORTAL_DIR}/backend/dist/server.js" ]]; then
    ok "Prebuilt artifacts refreshed"
  else
    spin "Building frontend" "cd '${PORTAL_DIR}/frontend' && npm run build"
    spin "Building backend" "cd '${PORTAL_DIR}/backend' && npm run build"
  fi

  # Ensure Remote Desktop is properly set up (packages + services + VNC race fix)
  info "Checking Remote Desktop..."
  setup_remote_desktop

  # Clear the safety-net trap — we're about to start the service ourselves
  trap - ERR

  info "Starting portal..."
  systemctl start bridgesllm-product

  if command -v openclaw &>/dev/null; then
    sleep 3
    openclaw devices approve --latest >> "$LOG_FILE" 2>&1 || true
  fi

  if ! verify_portal_service_health "bridgesllm-product" "http://127.0.0.1:4001/health" 60; then
    fail "Update verification failed — service did not become healthy. Check: journalctl -u bridgesllm-product -n 50"
  fi

  echo ""
  echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${GREEN}${BOLD}  Update complete!${NC}"
  telemetry_event "update_complete" ",\"installId\":\"${TELEMETRY_INSTALL_ID}\""
  echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

do_uninstall() {
  banner
  echo ""
  echo -e "  ${BOLD}${RED}Uninstalling BridgesLLM Portal${NC}"
  echo ""

  warn "This will remove:"
  echo "    ${BULLET} Portal at ${PORTAL_DIR}"
  echo "    ${BULLET} Systemd service"
  echo "    ${BULLET} Stalwart mail container (if installed)"
  echo ""

  # Check if database exists and offer data preservation choice
  local db_exists=false
  if sudo -u postgres psql -lqt 2>/dev/null | grep -qw "bridgesllm_portal"; then
    db_exists=true
  fi

  if $db_exists; then
    echo -e "  ${CYAN}Your database contains your projects, settings, and user accounts.${NC}"
    echo ""
    echo "    1) ${BOLD}Keep my data${NC} — Preserve database, projects, and uploads"
    echo "       ${DIM}(Reinstall later to pick up where you left off)${NC}"
    echo ""
    echo "    2) ${BOLD}Clean slate${NC} — Remove everything including database"
    echo "       ${DIM}(Irreversible — all data will be deleted)${NC}"
    echo ""
    read -rp "  Choose [1/2] (default: 1): " data_choice
    data_choice="${data_choice:-1}"
  fi

  echo ""
  read -rp "  Type 'yes' to confirm uninstall: " yn
  [[ "$yn" == "yes" ]] || { echo "  Cancelled."; exit 0; }

  systemctl stop bridgesllm-product 2>/dev/null || true
  systemctl disable bridgesllm-product 2>/dev/null || true
  rm -f /etc/systemd/system/bridgesllm-product.service
  systemctl daemon-reload

  if [[ -d "${INSTALL_ROOT}/stalwart" ]]; then
    info "Stopping mail server..."
    cd "${INSTALL_ROOT}/stalwart" && docker compose down 2>/dev/null || true
  fi

  # If clean slate, drop the database and remove user files
  if [[ "${data_choice:-1}" == "2" ]]; then
    info "Removing database..."
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS bridgesllm_portal;" 2>/dev/null || true
    # Remove the DB user too so fresh install creates a new one
    sudo -u postgres psql -c "DROP ROLE IF EXISTS blp;" 2>/dev/null || true
    ok "Database removed"

    # Remove user uploads and project files
    if [[ -d "/var/portal-files" ]]; then
      rm -rf /var/portal-files
      ok "User files removed"
    fi
  fi

  rm -rf "${INSTALL_ROOT}"
  ok "BridgesLLM Portal removed"

  echo ""
  if [[ "${data_choice:-1}" == "1" ]] && $db_exists; then
    echo -e "  ${GREEN}Your data has been preserved.${NC}"
    echo -e "  ${DIM}Reinstall to pick up where you left off — the setup wizard${NC}"
    echo -e "  ${DIM}will detect your account and let you set a new password.${NC}"
  else
    echo -e "  ${DIM}Not removed (clean up manually if needed):${NC}"
    echo "    ${BULLET} Caddy (/etc/caddy/Caddyfile)"
    echo "    ${BULLET} Node.js, Docker, ClamAV, Ollama, OpenClaw"
  fi
  echo ""
}

# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

main() {
  parse_args "$@"

  # Uninstall mode
  if $UNINSTALL_MODE; then
    [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Must run as root"
    do_uninstall
    exit 0
  fi

  # Update mode
  if $UPDATE_MODE; then
    [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Must run as root"
    mkdir -p "$LOG_DIR"
    touch "$LOG_FILE"
    chmod 600 "$LOG_FILE"
    do_update
    exit 0
  fi

  # Fresh install
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Must run as root. Use: sudo bash ${SCRIPT_NAME}"

  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"

  INSTALL_START_TIME=$(date +%s)

  banner

  $DRY_RUN && warn "Dry-run mode — no changes will be made"

  preflight
  ensure_telemetry_install_id
  telemetry_event "install_start" ",\"installId\":\"${TELEMETRY_INSTALL_ID}\""
  install_system_packages
  install_ai_tools
  setup_database
  build_portal
  configure_services
  setup_remote_desktop
  start_portal
  print_success
}

main "$@"