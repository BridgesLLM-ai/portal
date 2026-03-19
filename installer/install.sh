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

readonly VERSION="3.11.1"
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

# Pinned versions (tested 2026-03-15)
readonly PIN_OPENCLAW="2026.3.13"
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
TOTAL_STEPS=8
CURRENT_STEP_NUM=0
INSTALL_START_TIME=""

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

run() {
  if $DRY_RUN; then
    echo "  [dry-run] $*" >> "$LOG_FILE" 2>&1
  else
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

update_dependencies() {
  info "Checking dependencies..."

  # ── Tier 1: Always update (pinned/safe) ──

  # OpenClaw
  if command -v openclaw &>/dev/null; then
    local current_oc
    current_oc="$(openclaw --version 2>/dev/null | head -1 | grep -oP '\d{4}\.\d+\.\d+' || echo '')"
    if [[ -n "${current_oc}" && "${current_oc}" != "${PIN_OPENCLAW}" ]]; then
      spin "Updating OpenClaw (${current_oc} → ${PIN_OPENCLAW})"         "npm install -g openclaw@${PIN_OPENCLAW} 2>/dev/null" || true
    else
      ok "OpenClaw ${current_oc:-unknown} (current)"
    fi
  fi

  # Ollama (curl | sh is idempotent — always installs latest)
  if command -v ollama &>/dev/null; then
    local current_ollama
    current_ollama="$(ollama --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo 'unknown')"
    spin "Updating Ollama (currently ${current_ollama})"       "curl -fsSL https://ollama.ai/install.sh | sh >/dev/null 2>&1" || true
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

# Run a command with a progress indicator — for long operations
spin() {
  local msg="$1"; shift
  if $DRY_RUN; then
    echo "  [dry-run] $*" >> "$LOG_FILE" 2>&1
    return
  fi
  bash -c "$*" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local frame_idx=0
  local start_ts
  start_ts=$(date +%s)

  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      local now
      now=$(date +%s)
      local elapsed=$(( now - start_ts ))
      printf "\r  ${CYAN}${frames[$frame_idx]}${NC} ${msg} ${DIM}%ds${NC}  " "$elapsed"
      frame_idx=$(( (frame_idx + 1) % ${#frames[@]} ))
      sleep 0.25
    done
  else
    echo -e "  ${CYAN}⠿${NC} ${msg}..."
  fi

  wait "$pid"
  local rc=$?
  if [[ -t 1 ]]; then
    printf "\r%-80s\r" ""
  fi
  if [[ $rc -eq 0 ]]; then
    local end_ts
    end_ts=$(date +%s)
    local total=$(( end_ts - start_ts ))
    if (( total > 2 )); then
      ok "${msg} ${DIM}(${total}s)${NC}"
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
BridgesLLM Portal Installer v3.2

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

  echo ""
  print_kv "OS" "${OS_ID^} ${OS_VERSION}" "$WHITE"
  print_kv "CPUs" "${cpus}" "$WHITE"
  print_kv "RAM" "${mem_mb} MB" "$WHITE"
  print_kv "Disk free" "${disk_gb} GB" "$WHITE"
  echo ""

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

  # Core tools
  local missing=""
  for cmd in curl git openssl rsync; do
    command -v "$cmd" &>/dev/null || missing+=" $cmd"
  done
  if [[ -n "$missing" ]]; then
    $APT_AVAILABLE || fail "Missing:${missing} — and apt is not available"
    info "Installing core tools..."
    run "apt-get update -qq && apt-get install -y -qq curl git openssl rsync ca-certificates gnupg lsb-release ffmpeg"
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
    spin "Installing PostgreSQL 16" "apt-get update -qq && apt-get install -y -qq postgresql-16 postgresql-contrib-16"
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
    spin "Installing ClamAV antivirus" "apt-get install -y -qq clamav clamav-daemon"
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
    spin "Installing Ollama (local AI engine)" "curl -fsSL https://ollama.ai/install.sh | sh"
    run "systemctl enable ollama 2>/dev/null || true"
    ok "Ollama — models will be configured in the setup wizard"
  fi

  # OpenClaw
  if $SKIP_OPENCLAW; then
    info "Skipping OpenClaw (--skip-openclaw)"
  elif command -v openclaw &>/dev/null; then
    ok "OpenClaw $(openclaw --version 2>/dev/null | head -1 || echo '')"
  else
    spin "Installing OpenClaw (AI agent framework)" "npm install -g openclaw@${PIN_OPENCLAW}"
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
    spin "Copying portal files from local source" "rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.production' --exclude='/projects' --exclude='/assets' '${RELEASE_FALLBACK_DIR}/' '${PORTAL_DIR}/'"
  elif curl -fsSL --head "${RELEASE_URL}" &>/dev/null 2>&1; then
    spin "Downloading portal release" "mkdir -p /tmp/blp-download && curl -fsSL '${RELEASE_URL}' -o /tmp/blp-download/portal.tar.gz && tar -xzf /tmp/blp-download/portal.tar.gz -C /tmp/blp-download && rsync -a --exclude='/projects' --exclude='/assets' /tmp/blp-download/portal/ '${PORTAL_DIR}/' && rm -rf /tmp/blp-download"
  else
    fail "Cannot find portal source"
  fi

  # Install dependencies (--ignore-scripts skips C++ compilation, we provide prebuilt binaries)
  spin "Installing runtime dependencies" "cd '${PORTAL_DIR}/backend' && npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts"

  # Inject prebuilt node-pty binary for linux-x64 (skips 5+ min node-gyp compile)
  if [[ -d "${PORTAL_DIR}/backend/prebuilts/node-pty/prebuilds/linux-x64" ]]; then
    mkdir -p "${PORTAL_DIR}/backend/node_modules/node-pty/prebuilds/linux-x64"
    cp -f "${PORTAL_DIR}/backend/prebuilts/node-pty/prebuilds/linux-x64/pty.node" \
          "${PORTAL_DIR}/backend/node_modules/node-pty/prebuilds/linux-x64/pty.node"
    ok "Using prebuilt node-pty binary"
  else
    # No prebuilt — compile from source (needs build tools)
    progress "Compiling native terminal module..."
    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
      spin "Installing build tools" "apt-get install -y -qq build-essential python3"
    fi
    spin "Building node-pty from source" "cd '${PORTAL_DIR}/backend' && npm rebuild node-pty 2>&1"
  fi

  # Run postinstall scripts that we actually need (prisma generate)
  spin "Generating database client" "cd '${PORTAL_DIR}/backend' && npx prisma generate 2>/dev/null || true"

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

  # Write .env.production
  local cors_origin="http://${PUBLIC_IP}"
  [[ -n "$DOMAIN" ]] && cors_origin="https://${DOMAIN},https://www.${DOMAIN}"

  cat > "${PORTAL_DIR}/backend/.env.production" << ENVEOF
# Generated by BridgesLLM installer v${VERSION} — $(date)
NODE_ENV=production
PORT=4001

DATABASE_URL="postgresql://blp:${DB_PASSWORD}@127.0.0.1:5432/bridgesllm_portal"
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
  spin "Running database migrations" "cd '${PORTAL_DIR}/backend' && DATABASE_URL='${db_url}' npx prisma migrate deploy"
  spin "Generating database client" "cd '${PORTAL_DIR}/backend' && DATABASE_URL='${db_url}' npx prisma generate"
  ok "Database tables created"

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
# Step 7: Start
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

  echo -n "  "
  local waited=0
  while (( waited < 60 )); do
    if curl -fsS --max-time 2 "http://127.0.0.1:4001/health" &>/dev/null; then
      echo ""
      ok "Portal is healthy"
      return
    fi
    echo -ne "."
    sleep 2
    waited=$((waited + 2))
  done
  echo ""
  warn "Health check timed out — check: journalctl -u bridgesllm-product -n 50"
}

# ═══════════════════════════════════════════════════════════════
# Step 8: Done
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
  openclaw_ver="$(openclaw --version 2>/dev/null | head -1 | head -c 20 || echo '-')"

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
    spin "Downloading update" "mkdir -p /tmp/blp-download && curl -fsSL '${RELEASE_URL}' -o /tmp/blp-download/portal.tar.gz && tar -xzf /tmp/blp-download/portal.tar.gz -C /tmp/blp-download && rsync -a --delete --exclude='/projects' --exclude='/assets' --exclude='.env.production' --exclude='.env' /tmp/blp-download/portal/ '${PORTAL_DIR}/' && rm -rf /tmp/blp-download"
    update_applied=true
  elif [[ -d "${RELEASE_FALLBACK_DIR}" ]] && [[ -f "${RELEASE_FALLBACK_DIR}/backend/dist/server.js" ]]; then
    # Fallback to local source ONLY if it has built artifacts (dist/server.js)
    warn "Download unavailable — falling back to local source at ${RELEASE_FALLBACK_DIR}"
    spin "Syncing updated portal files" "rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.production' --exclude='/projects' --exclude='/assets' '${RELEASE_FALLBACK_DIR}/' '${PORTAL_DIR}/'"
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

  spin "Installing runtime dependencies" "cd '${PORTAL_DIR}/backend' && npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts"

  if [[ -d "${PORTAL_DIR}/backend/prebuilts/node-pty/prebuilds/linux-x64" ]]; then
    mkdir -p "${PORTAL_DIR}/backend/node_modules/node-pty/prebuilds/linux-x64"
    cp -f "${PORTAL_DIR}/backend/prebuilts/node-pty/prebuilds/linux-x64/pty.node" \
          "${PORTAL_DIR}/backend/node_modules/node-pty/prebuilds/linux-x64/pty.node"
  fi

  # Use the existing DATABASE_URL if available, otherwise construct a default
  local db_url="${existing_db_url:-postgresql://blp:${DB_PASSWORD}@127.0.0.1:5432/bridgesllm_portal}"
  spin "Running database migrations" "cd '${PORTAL_DIR}/backend' && DATABASE_URL='${db_url}' npx prisma migrate deploy"
  spin "Generating database client" "cd '${PORTAL_DIR}/backend' && DATABASE_URL='${db_url}' npx prisma generate"

  update_dependencies
  telemetry_event "deps_updated" ",\"installId\":\"${TELEMETRY_INSTALL_ID}\""

  if [[ -f "${PORTAL_DIR}/frontend/dist/index.html" ]] && [[ -f "${PORTAL_DIR}/backend/dist/server.js" ]]; then
    ok "Prebuilt artifacts refreshed"
  else
    spin "Building frontend" "cd '${PORTAL_DIR}/frontend' && npm run build"
    spin "Building backend" "cd '${PORTAL_DIR}/backend' && npm run build"
  fi

  info "Starting portal..."
  systemctl start bridgesllm-product

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
  echo -e "  ${DIM}Database and system packages will NOT be removed.${NC}"
  echo ""

  read -rp "  Type 'yes' to confirm: " yn
  [[ "$yn" == "yes" ]] || { echo "  Cancelled."; exit 0; }

  systemctl stop bridgesllm-product 2>/dev/null || true
  systemctl disable bridgesllm-product 2>/dev/null || true
  rm -f /etc/systemd/system/bridgesllm-product.service
  systemctl daemon-reload

  if [[ -d "${INSTALL_ROOT}/stalwart" ]]; then
    info "Stopping mail server..."
    cd "${INSTALL_ROOT}/stalwart" && docker compose down 2>/dev/null || true
  fi

  rm -rf "${INSTALL_ROOT}"
  ok "BridgesLLM Portal removed"

  echo ""
  echo -e "  ${DIM}Not removed (clean up manually if needed):${NC}"
  echo "    ${BULLET} PostgreSQL database (bridgesllm_portal)"
  echo "    ${BULLET} Caddy (/etc/caddy/Caddyfile)"
  echo "    ${BULLET} Node.js, Docker, ClamAV, Ollama, OpenClaw"
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
  telemetry_event "install_start"
  install_system_packages
  install_ai_tools
  setup_database
  build_portal
  configure_services
  start_portal
  print_success
}

main "$@"