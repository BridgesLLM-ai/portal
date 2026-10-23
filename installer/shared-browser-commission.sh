#!/usr/bin/env bash
# Explicit opt-in commissioning only; sourced by install.sh for this operation.
shared_browser_units() {
  printf '%s\n' bridges-shared-browser-cdp.service bridges-shared-desktop.service \
    bridges-shared-chrome.service
}

shared_browser_owner_state() {
  local owner="$1" log_target="$2" env_file="${PORTAL_DIR}/backend/.env.production" database_url
  database_url="$(read_env_value "${env_file}" DATABASE_URL 2>/dev/null)" || return 1
  [[ -n "${database_url}" && -f "${PORTAL_DIR}/backend/dist/config/database.js" ]] || return 1
  # The user ID and database URL travel in the environment of this one child, never argv.
  ( cd "${PORTAL_DIR}/backend" && DATABASE_URL="${database_url}" SHARED_BROWSER_OWNER_ID="${owner}" node -e '
const { prisma } = require("./dist/config/database");
prisma.user.findUnique({ where: { id: process.env.SHARED_BROWSER_OWNER_ID },
  select: { role: true, accountStatus: true, isActive: true } })
  .then((row) => process.stdout.write(row ? `${row.role}:${row.accountStatus}:${row.isActive}` : "absent"))
  .catch(() => { process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
' 2>> "${log_target}" )
}

# Read-only admission shared by the dry run and the real operation. Prints one line per
# check; returns non-zero when any blocking check fails.
shared_browser_preflight() {
  local owner="$1" log_target="$2" status=0 tool state configured pin
  local env_file="${PORTAL_DIR}/backend/.env.production" config=/root/.openclaw/openclaw.json
  local composer="${PORTAL_DIR}/installer/shared-browser-config.py"
  local helper="${PORTAL_DIR}/installer/shared-browser.sh"
  shared_browser_check_line() { printf '  %-5s %s\n' "$1" "$2"; [[ "$1" == PASS ]] || status=1; }
  if [[ -f "${helper}" && ! -L "${helper}" && -f "${composer}" && ! -L "${composer}" \
    && -f "${PORTAL_DIR}/installer/shared-browser-owner.py" \
    && -f "${PORTAL_DIR}/installer/openclaw-shared-browser-plugin/index.js" \
    && -f "${PORTAL_DIR}/static/scripts/bridges-shared-chrome.sh" ]]; then
    shared_browser_check_line PASS "signed shared-browser helper, composer, plugin and launcher are installed"
  else
    shared_browser_check_line FAIL "the installed Portal does not carry the signed shared-browser files"
  fi
  if [[ -e "${OPENCLAW_MIGRATION_TRANSACTION_ROOT}" || -L "${OPENCLAW_MIGRATION_TRANSACTION_ROOT}" \
    || -e "${OPENCLAW_GATEWAY_AUTHORIZATION_FENCE_MARKER}" || -L "${OPENCLAW_GATEWAY_AUTHORIZATION_FENCE_MARKER}" ]]; then
    shared_browser_check_line FAIL "an OpenClaw maintenance transaction or gateway fence is open; finish it with --recover first"
  else
    shared_browser_check_line PASS "no OpenClaw maintenance transaction or gateway fence is open"
  fi
  if command -v openclaw >/dev/null 2>&1 && [[ -f "${config}" && ! -L "${config}" ]]; then
    shared_browser_check_line PASS "product OpenClaw runtime and ${config} are present"
  else
    shared_browser_check_line FAIL "the product OpenClaw runtime or ${config} is missing"
  fi
  for tool in Xtigervnc xauth nft systemd-tmpfiles curl; do
    if command -v "${tool}" >/dev/null 2>&1; then shared_browser_check_line PASS "${tool} is available"
    else shared_browser_check_line FAIL "${tool} is required and is not installed"; fi
  done
  if command -v google-chrome-stable >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1 \
    || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
    shared_browser_check_line PASS "Chrome/Chromium is available"
  else
    shared_browser_check_line FAIL "Chrome/Chromium is required and is not installed"
  fi
  state="$(shared_browser_owner_state "${owner}" "${log_target}" || true)"
  case "${state}" in
    OWNER:ACTIVE:true|SUB_ADMIN:ACTIVE:true) shared_browser_check_line PASS "owner ${owner} is an active ${state%%:*} Portal account" ;;
    absent) shared_browser_check_line FAIL "owner ${owner} is not an existing Portal account" ;;
    '') shared_browser_check_line FAIL "the Portal database could not confirm owner ${owner}" ;;
    *) shared_browser_check_line FAIL "owner ${owner} is not an active OWNER or SUB_ADMIN account (${state})" ;;
  esac
  configured="$(read_env_value "${env_file}" SHARED_INTERACTIVE_BROWSER_OWNER_ID 2>/dev/null || true)"
  if [[ -n "${configured}" && "${configured,,}" != "${owner}" ]]; then
    shared_browser_check_line FAIL "this instance is commissioned for another owner; reassignment needs the dedicated-profile reset (cookies never transfer)"
  else
    shared_browser_check_line PASS "no different shared-browser owner is configured"
  fi
  if [[ -e "/var/lib/bridges-shared-browser/profile-owner.json" || -L "/var/lib/bridges-shared-browser/profile-owner.json" ]]; then
    pin="$(python3 -I -c 'import json, sys; value = json.load(open(sys.argv[1])); print(value if isinstance(value, str) else "")' \
      /var/lib/bridges-shared-browser/profile-owner.json 2>/dev/null || true)"
    if [[ "${pin}" == "${owner}" ]]; then shared_browser_check_line PASS "the persistent profile is pinned to this owner"
    else shared_browser_check_line FAIL "the persistent profile is pinned to another owner; the dedicated-profile reset is required first"; fi
  else
    if systemctl is-active --quiet bridges-shared-chrome.service || systemctl is-active --quiet bridges-shared-desktop.service; then
      shared_browser_check_line FAIL "an unowned dedicated browser is active; stop it before explicit commissioning"
    fi
    if [[ -L /home/bridgesbrowser/.config/portal-shared/profile ]] \
      || [[ -d /home/bridgesbrowser/.config/portal-shared/profile && -n "$(ls -A /home/bridgesbrowser/.config/portal-shared/profile)" ]]; then
      shared_browser_check_line FAIL "unowned existing profile data requires an explicit dedicated-profile reset"
    else
      shared_browser_check_line PASS "no persistent profile owner or cookies exist yet"
    fi
  fi
  if [[ -f "${composer}" && -f "${config}" ]] \
    && python3 -I "${composer}" patch /usr/local/lib/bridges-shared-browser/plugin "${SHARED_BROWSER_AGENTS[@]}" \
      < "${config}" > /dev/null 2>> "${log_target}"; then
    shared_browser_check_line PASS "agents ${SHARED_BROWSER_AGENTS[*]} are explicit product agents and no deny rule blocks the browser"
  else
    shared_browser_check_line FAIL "the product configuration refused the shared-browser grant (see the log); nothing is guessed"
  fi
  if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:18801/json/version 2>/dev/null; then
    shared_browser_check_line FAIL "the legacy Shared Chrome (127.0.0.1:18801) is open; close it in Remote Desktop first (it is never killed here)"
  else
    shared_browser_check_line PASS "the legacy Shared Chrome is not running"
  fi
  if ! systemctl is-active --quiet bridges-shared-desktop.service \
    && [[ -e /tmp/.X2-lock || -e /tmp/.X11-unix/X2 ]]; then
    shared_browser_check_line FAIL "X display :2 is already used by another desktop"
  else
    shared_browser_check_line PASS "X display :2 is free or already the dedicated desktop"
  fi
  return "${status}"
}

do_commission_shared_browser() {
  local env_file="${PORTAL_DIR}/backend/.env.production" config=/root/.openclaw/openclaw.json
  local composer="${PORTAL_DIR}/installer/shared-browser-config.py"
  local helper="${PORTAL_DIR}/installer/shared-browser.sh"
  local plugin_dir=/usr/local/lib/bridges-shared-browser/plugin
  local owner="${SHARED_BROWSER_OWNER,,}" agent patch_dir="" patch_file waited unit
  local -a units=()
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "Must run shared-browser commissioning as root."
  [[ -f "${env_file}" && ! -L "${env_file}" && -f "${PORTAL_DIR}/backend/package.json" ]] \
    || fail "No installed Portal was found."
  [[ "${owner}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || fail "--shared-browser-owner must be the user ID (UUID) of an existing Portal OWNER or SUB_ADMIN."
  (( ${#SHARED_BROWSER_AGENTS[@]} >= 1 && ${#SHARED_BROWSER_AGENTS[@]} <= 32 )) \
    || fail "Name between 1 and 32 approved agents with --shared-browser-agent."
  for agent in "${SHARED_BROWSER_AGENTS[@]}"; do
    [[ "${agent}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || fail "Invalid --shared-browser-agent ID: ${agent}"
  done
  mapfile -t units < <(shared_browser_units)
  [[ -z "${OPENCLAW_CONFIG_PATH:-}" && -z "${OPENCLAW_STATE_DIR:-}" && -z "${OPENCLAW_PROFILE:-}" ]] \
    || fail "Shared-browser commissioning requires the product OpenClaw configuration, without override variables."
  if $DRY_RUN; then
    banner
    echo ""
    echo -e "  ${BOLD}${WHITE}Shared interactive browser commissioning preflight (read-only)${NC}"
    echo ""
    if shared_browser_preflight "${owner}" /dev/null; then
      echo ""
      echo -e "  ${GREEN}Ready.${NC} Run the same command without --dry-run to commission it."
      return 0
    fi
    echo ""
    echo -e "  ${RED}Not ready.${NC} Resolve the FAIL lines above; nothing was changed."
    return 1
  fi
  mkdir -p "$LOG_DIR"; touch "$LOG_FILE"; chmod 600 "$LOG_FILE"
  acquire_portal_operation_lock
  CURRENT_STEP="shared interactive browser"
  # Re-attest after acquiring maintenance authority; do not recover or borrow a runtime.
  shared_browser_preflight "${owner}" "${LOG_FILE}" >> "${LOG_FILE}" \
    || fail "Shared-browser commissioning preflight refused; nothing was changed. Run it with --dry-run for the checklist. Details: ${LOG_FILE}"

  # 1. Dedicated identity, files and inert units. Nothing is enabled or started yet.
  ( source "${helper}"; shared_browser_install_source "${PORTAL_DIR}" ) >> "${LOG_FILE}" 2>&1 \
    || fail "Dedicated provisioning failed; no services were started. Inspect the inert provisioning files before retrying."
  systemd-tmpfiles --create /etc/tmpfiles.d/bridges-shared-browser.conf >> "${LOG_FILE}" 2>&1 \
    && systemctl daemon-reload >> "${LOG_FILE}" 2>&1 \
    || fail "The shared-browser runtime directories or units could not be registered."

  # 2. Product configuration through OpenClaw's own validating writer, dry run first.
  patch_dir="$(mktemp -d /tmp/bridgesllm-shared-browser.XXXXXX)" \
    || fail "Could not create a private shared-browser configuration directory."
  chmod 700 "${patch_dir}"
  patch_file="${patch_dir}/patch.json"
  if ! python3 -I "${composer}" patch "${plugin_dir}" "${SHARED_BROWSER_AGENTS[@]}" \
      < "${config}" > "${patch_file}" 2>> "${LOG_FILE}" \
    || ! OPENCLAW_CONFIG_PATH="${config}" openclaw config patch --file "${patch_file}" --dry-run >> "${LOG_FILE}" 2>&1; then
    rm -rf -- "${patch_dir}"
    fail "OpenClaw rejected the shared-browser configuration in a dry run; its configuration was not changed."
  fi
  if ! OPENCLAW_CONFIG_PATH="${config}" openclaw config patch --file "${patch_file}" >> "${LOG_FILE}" 2>&1; then
    rm -rf -- "${patch_dir}"
    fail "OpenClaw did not accept the shared-browser configuration."
  fi
  rm -rf -- "${patch_dir}"
  python3 -I "${composer}" verify "${plugin_dir}" "${SHARED_BROWSER_AGENTS[@]}" < "${config}" 2>> "${LOG_FILE}" \
    || fail "The OpenClaw configuration did not retain the shared-browser grant."

  # Pin the dedicated profile before the first browser starts. Existing unowned cookies are refused.
  python3 -I "${PORTAL_DIR}/installer/shared-browser-owner.py" pin "${owner}" \
    || fail "Persistent browser ownership could not be pinned; no browser was started."

  # 3. Root-only CDP policy, isolated display :2 and the persistent dedicated Chrome.
  systemctl enable --now "${units[@]}" >> "${LOG_FILE}" 2>&1 \
    || fail "The dedicated shared-browser services did not start. Check: journalctl -u bridges-shared-chrome -n 50"
  waited=0
  until curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:18901/json/version 2>> "${LOG_FILE}" \
    && [[ -S /run/bridges-shared-desktop/transport/vnc.sock ]]; do
    (( waited >= 60 )) && fail "The dedicated shared browser did not expose its loopback CDP and private desktop within 60 s."
    sleep 2; waited=$((waited + 2))
  done
  for unit in "${units[@]}"; do
    systemctl is-active --quiet "${unit}" || fail "${unit} is not active after start."
  done

  # 4. The Gateway loads the gate plugin; the Portal starts the broker for the named owner.
  restart_openclaw_gateway_with_identity_authority >> "${LOG_FILE}" 2>&1 \
    || fail "The OpenClaw gateway could not restart to load the shared-browser gate."
  waited=0
  until openclaw_gateway_http_ready; do
    (( waited >= 180 )) && fail "The OpenClaw gateway did not become ready after loading the shared-browser gate."
    sleep 3; waited=$((waited + 3))
  done
  set_env_value_atomic "${env_file}" SHARED_INTERACTIVE_BROWSER_OWNER_ID "${owner}" \
    && set_env_value_atomic "${env_file}" SHARED_INTERACTIVE_BROWSER_ENABLED 1 \
    || fail "Could not record the shared-browser owner in the Portal settings."
  systemctl restart bridgesllm-product >> "${LOG_FILE}" 2>&1 || fail "The Portal did not restart."
  waited=0
  until curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:4001/health 2>> "${LOG_FILE}"; do
    (( waited >= 180 )) && fail "The Portal did not become healthy after enabling the shared browser."
    sleep 3; waited=$((waited + 3))
  done
  waited=0
  until [[ -S "/run/bridges-shared-browser/broker.sock" \
    && "$(stat -c '%u:%a' /run/bridges-shared-browser/broker.sock 2>/dev/null)" == "0:600" ]]; do
    (( waited >= 60 )) && fail "The Portal did not start its private shared-browser lease broker. Check: journalctl -u bridgesllm-product | grep shared-browser"
    sleep 2; waited=$((waited + 2))
  done

  # 5. Only now retire the legacy exec-controlled 18801 launchers.
  ( source "${helper}"; shared_browser_retire_legacy_launchers ) >> "${LOG_FILE}" 2>&1 \
    || fail "The legacy Shared Chrome launchers could not be retired."
  ok "Shared interactive browser commissioned for owner ${owner} and agents ${SHARED_BROWSER_AGENTS[*]}."
  info "Agent control stays paused until that owner opens Remote Desktop → Shared interactive browser and selects one owned Agent Chat session."
}
