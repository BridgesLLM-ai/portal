#!/usr/bin/env bash
set -Eeuo pipefail

# Managed host-side model bridge for isolated Agent Zero Project runtimes.
#
# Project containers never receive Agent Zero's global OAuth proxy token. Each
# receives one short-lived project bearer; this service validates its protected
# hash record and forwards only the three fixed OpenAI-compatible operations to
# Agent Zero's loopback-only official OAuth proxy.

readonly BRIDGE_SERVICE='bridgesllm-agent-zero-project-model-bridge.service'
readonly BRIDGE_USER='bridgesllm-a0-bridge'
readonly BRIDGE_GROUP='bridgesllm-a0-bridge'
readonly BRIDGE_PORT='18991'
readonly BRIDGE_STATE_ROOT='/var/lib/bridgesllm/agent-zero-project-model-bridge'
readonly BRIDGE_CREDENTIAL_ROOT="${BRIDGE_STATE_ROOT}/credentials"
readonly BRIDGE_ENV_FILE='/etc/bridgesllm/agent-zero-project-model-bridge.env'
readonly BRIDGE_UNIT_FILE="/etc/systemd/system/${BRIDGE_SERVICE}"
readonly BRIDGE_ENTRYPOINT='/opt/bridgesllm/portal/backend/dist/agents/providers/agentZero/AgentZeroProjectModelBridge.js'
readonly BRIDGE_CREDENTIAL_MODULE='/opt/bridgesllm/portal/backend/dist/agents/providers/agentZero/AgentZeroProjectModelBridgeCredential.js'
readonly A0_CONTAINER='bridgesllm-agent-zero'
readonly A0_LOOPBACK_PORT='50001'
# Keep in lockstep with Portal's tested Codex CLI pin and the managed Agent Zero
# runtime lifecycle. Agent Zero v2.5 has no Codex binary from which to infer it.
readonly A0_CODEX_CLIENT_VERSION='0.145.0'

log() { printf '[Agent Zero Project model bridge] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || die 'This lifecycle requires root.'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

root_protected_file() {
  local file="$1" expected_mode="$2"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  [[ "$(stat -c '%u' "$file")" == '0' && "$(stat -c '%a' "$file")" == "$expected_mode" ]]
}

bridge_runtime_sources_ready() {
  root_protected_file "$BRIDGE_ENTRYPOINT" 644 \
    && root_protected_file "$BRIDGE_CREDENTIAL_MODULE" 644
}

ensure_identity_and_directories() {
  if ! getent group "$BRIDGE_GROUP" >/dev/null; then
    groupadd --system "$BRIDGE_GROUP"
  fi
  if ! id -u "$BRIDGE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$BRIDGE_GROUP" --home-dir /nonexistent --no-create-home \
      --shell /usr/sbin/nologin "$BRIDGE_USER"
  fi
  [[ "$(id -gn "$BRIDGE_USER")" == "$BRIDGE_GROUP" ]] \
    || die 'Managed bridge user has an unexpected primary group.'
  install -d -m 0750 -o root -g "$BRIDGE_GROUP" "$BRIDGE_STATE_ROOT"
  install -d -m 2750 -o root -g "$BRIDGE_GROUP" "$BRIDGE_CREDENTIAL_ROOT"
  install -d -m 0750 -o root -g root /etc/bridgesllm
}

generate_upstream_token() {
  python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
}

read_env_token() {
  root_protected_file "$BRIDGE_ENV_FILE" 640 \
    || die 'Bridge environment file is missing or not root-owned mode 640.'
  [[ "$(stat -c '%G' "$BRIDGE_ENV_FILE")" == "$BRIDGE_GROUP" ]] \
    || die 'Bridge environment file has the wrong group.'
  local count token
  count="$(awk -F= '$1 == "AGENT_ZERO_PROJECT_MODEL_BRIDGE_UPSTREAM_TOKEN" { count += 1 } END { print count + 0 }' "$BRIDGE_ENV_FILE")"
  [[ "$count" == '1' ]] || die 'Bridge environment must contain exactly one upstream token.'
  token="$(awk -F= '$1 == "AGENT_ZERO_PROJECT_MODEL_BRIDGE_UPSTREAM_TOKEN" { print substr($0, index($0, "=") + 1) }' "$BRIDGE_ENV_FILE")"
  [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || die 'Bridge upstream token is malformed.'
  printf '%s\n' "$token"
}

write_bridge_environment() {
  local token="$1" temporary
  [[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || die 'Refusing to persist a malformed bridge token.'
  temporary="${BRIDGE_ENV_FILE}.tmp.$$"
  umask 0077
  {
    printf 'AGENT_ZERO_PROJECT_MODEL_BRIDGE_UPSTREAM_TOKEN=%s\n' "$token"
    printf 'AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_ROOT=%s\n' "$BRIDGE_CREDENTIAL_ROOT"
    printf 'AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT=%s\n' "$BRIDGE_PORT"
  } >"$temporary"
  chown root:"$BRIDGE_GROUP" "$temporary"
  chmod 0640 "$temporary"
  mv -f "$temporary" "$BRIDGE_ENV_FILE"
}

ensure_bridge_environment() {
  if [[ ! -e "$BRIDGE_ENV_FILE" ]]; then
    write_bridge_environment "$(generate_upstream_token)"
  fi
  read_env_token >/dev/null
}

assert_agent_zero_upstream() {
  docker container inspect "$A0_CONTAINER" >/dev/null 2>&1 \
    || die 'Managed Agent Zero v2.5 container is unavailable.'
  [[ "$(docker inspect --format '{{.State.Running}}' "$A0_CONTAINER")" == 'true' ]] \
    || die 'Managed Agent Zero v2.5 container is not running.'
  local binding bindings
  bindings="$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$A0_CONTAINER")"
  binding="$(docker inspect --format '{{with (index .HostConfig.PortBindings "80/tcp")}}{{(index . 0).HostIp}}|{{(index . 0).HostPort}}|{{len .}}{{end}}' "$A0_CONTAINER")"
  [[ "$bindings" == '1' && "$binding" == "127.0.0.1|${A0_LOOPBACK_PORT}|1" ]] \
    || die 'Managed Agent Zero OAuth upstream is not loopback-only on the expected port.'
}

configure_agent_zero_proxy_token() {
  local token="$1"
  [[ -z "$token" || "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] \
    || die 'Refusing to configure a malformed Agent Zero proxy token.'
  # The token travels only over stdin. It is never placed in argv, logs, Docker
  # labels, or Portal source. Keep loopback authorization enabled for Agent
  # Zero's own OAuth-backed model calls; the host-side Project bridge still has
  # to present this random token because Docker-forwarded traffic is non-loopback
  # at the Flask boundary. Empty input revokes that host-side token while leaving
  # the official in-container OAuth model path usable.
  if ! printf '%s\n%s' "$token" "$A0_CODEX_CLIENT_VERSION" | docker exec -i --workdir /a0 "$A0_CONTAINER" \
    /opt/venv-a0/bin/python -c '
import hashlib, sys
from helpers import plugins
values = sys.stdin.read().splitlines()
if len(values) != 2:
    raise SystemExit(1)
token = values[0].strip()
codex_version = values[1].strip()
cfg = plugins.get_plugin_config("_oauth") or {}
if not isinstance(cfg, dict):
    raise SystemExit(2)
codex = cfg.get("codex") or {}
if not isinstance(codex, dict):
    raise SystemExit(3)
codex = dict(codex)
codex["require_proxy_token"] = False
codex["proxy_token"] = token
codex["codex_version"] = codex_version
cfg = dict(cfg)
cfg["codex"] = codex
plugins.save_plugin_config("_oauth", "", "", cfg)
saved = plugins.get_plugin_config("_oauth") or {}
saved_codex = saved.get("codex") or {}
ok = (
    isinstance(saved_codex, dict)
    and saved_codex.get("require_proxy_token") is False
    and str(saved_codex.get("proxy_token") or "") == token
    and str(saved_codex.get("codex_version") or "").strip() == codex_version
)
print("configured:" + hashlib.sha256(token.encode()).hexdigest()[:16] if ok else "failed")
raise SystemExit(0 if ok else 4)
' | grep -Eq '^configured:[a-f0-9]{16}$'; then
    log 'Agent Zero official OAuth proxy token could not be configured and verified.'
    return 1
  fi
}

write_systemd_unit() {
  local temporary="${BRIDGE_UNIT_FILE}.tmp.$$"
  cat >"$temporary" <<EOF
[Unit]
Description=BridgesLLM Agent Zero Project model bridge
After=network-online.target docker.service bridgesllm-product.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=${BRIDGE_USER}
Group=${BRIDGE_GROUP}
EnvironmentFile=${BRIDGE_ENV_FILE}
ExecStart=/usr/bin/node ${BRIDGE_ENTRYPOINT}
Restart=on-failure
RestartSec=3
TimeoutStartSec=30
TimeoutStopSec=20
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
RestrictAddressFamilies=AF_INET AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
AmbientCapabilities=
LockPersonality=true
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
  chown root:root "$temporary"
  chmod 0644 "$temporary"
  mv -f "$temporary" "$BRIDGE_UNIT_FILE"
}

bridge_http_ready() {
  local provider status
  for provider in codex github-copilot gemini-api xai-grok; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 \
      "http://127.0.0.1:${BRIDGE_PORT}/oauth/${provider}/v1/models" || true)"
    [[ "$status" == '401' ]] || return 1
  done
}

wait_bridge_http_ready() {
  local attempt
  for attempt in $(seq 1 30); do
    bridge_http_ready && return 0
    sleep 1
  done
  return 1
}

install_bridge_service() {
  require_root
  for command in curl getent groupadd id install node python3 seq sleep stat systemctl useradd; do
    require_command "$command"
  done
  ensure_identity_and_directories
  bridge_runtime_sources_ready \
    || die 'Compiled Agent Zero Project model bridge runtime is missing or unsafe.'
  ensure_bridge_environment
  write_systemd_unit
  systemctl daemon-reload
  systemctl enable "$BRIDGE_SERVICE" >/dev/null
  systemctl restart "$BRIDGE_SERVICE"
  wait_bridge_http_ready \
    || die 'Agent Zero Project model bridge failed its fail-closed HTTP readiness check.'
  log 'Installed the managed Agent Zero Project model bridge in fail-closed mode.'
}

status_bridge() {
  require_root
  require_command curl
  require_command docker
  require_command systemctl
  ensure_identity_and_directories
  read_env_token >/dev/null
  assert_agent_zero_upstream
  bridge_runtime_sources_ready \
    || die 'Compiled Agent Zero Project model bridge runtime is missing or unsafe.'
  systemctl is-active --quiet "$BRIDGE_SERVICE" \
    || die 'Agent Zero Project model bridge service is not active.'
  bridge_http_ready || die 'Agent Zero Project model bridge did not return its fail-closed HTTP contract.'
  printf 'Agent Zero Project model bridge is active on the Docker-host boundary with per-project authentication\n'
}

reconcile_bridge() {
  install_bridge_service
  require_command docker
  assert_agent_zero_upstream
  configure_agent_zero_proxy_token "$(read_env_token)" \
    || die 'Agent Zero official OAuth proxy token convergence failed.'
  wait_bridge_http_ready || die 'Agent Zero Project model bridge failed its fail-closed HTTP readiness check.'
  log 'Reconciled the managed Agent Zero Project model bridge.'
}

rotate_upstream_token() {
  require_root
  for command in curl docker python3 systemctl; do require_command "$command"; done
  ensure_identity_and_directories
  ensure_bridge_environment
  assert_agent_zero_upstream
  local old_token new_token backup
  old_token="$(read_env_token)"
  new_token="$(generate_upstream_token)"
  backup="${BRIDGE_ENV_FILE}.rollback.$$"
  cp --preserve=mode,ownership "$BRIDGE_ENV_FILE" "$backup"
  if ! configure_agent_zero_proxy_token "$new_token"; then
    configure_agent_zero_proxy_token "$old_token" \
      || die 'Agent Zero rejected both the new and prior bridge tokens; protected state was retained for recovery.'
    rm -f "$backup"
    die 'Agent Zero proxy rejected token rotation; the prior token remains active.'
  fi
  if ! write_bridge_environment "$new_token"; then
    configure_agent_zero_proxy_token "$old_token" \
      || die 'Bridge token persistence failed and Agent Zero could not restore the prior token.'
    rm -f "$backup"
    die 'Bridge token persistence failed; the prior upstream token was restored.'
  fi
  if ! systemctl restart "$BRIDGE_SERVICE" || ! wait_bridge_http_ready; then
    mv -f "$backup" "$BRIDGE_ENV_FILE"
    configure_agent_zero_proxy_token "$old_token" \
      || die 'Bridge restart failed and Agent Zero could not restore the prior token.'
    systemctl restart "$BRIDGE_SERVICE" || true
    die 'Bridge token rotation failed readiness and was rolled back.'
  fi
  rm -f "$backup"
  log 'Rotated the host-only Agent Zero OAuth proxy token.'
}

stop_bridge() {
  require_root
  systemctl stop "$BRIDGE_SERVICE"
}

stop_bridge_for_uninstall() {
  systemctl disable --now "$BRIDGE_SERVICE" >/dev/null 2>&1 || true
  systemctl kill --kill-who=all "$BRIDGE_SERVICE" >/dev/null 2>&1 || true
  local load_state active_state
  load_state="$(systemctl show --property=LoadState --value "$BRIDGE_SERVICE" 2>/dev/null)" \
    || die 'Agent Zero Project model bridge load state could not be verified.'
  active_state="$(systemctl show --property=ActiveState --value "$BRIDGE_SERVICE" 2>/dev/null)" \
    || die 'Agent Zero Project model bridge active state could not be verified.'
  case "$active_state" in
    inactive|failed) ;;
    *) die "Agent Zero Project model bridge is still ${active_state:-unknown} (${load_state:-unknown})." ;;
  esac
  if id -u "$BRIDGE_USER" >/dev/null 2>&1 && pgrep -u "$BRIDGE_USER" >/dev/null 2>&1; then
    die 'Agent Zero Project model bridge processes are still running.'
  fi
}

agent_zero_container_present_for_uninstall() {
  local names
  names="$(docker container ls --all --format '{{.Names}}')" \
    || die 'Docker could not authoritatively enumerate Agent Zero before bridge uninstall.'
  grep -Fxq -- "$A0_CONTAINER" <<<"$names"
}

remove_clean_slate_bridge_state() {
  if [[ -e "$BRIDGE_STATE_ROOT" || -L "$BRIDGE_STATE_ROOT" ]]; then
    [[ -d "$BRIDGE_STATE_ROOT" && ! -L "$BRIDGE_STATE_ROOT" ]] \
      || die 'Agent Zero Project model bridge state root is linked or not a directory.'
    [[ "$(stat -c '%U:%G:%a' "$BRIDGE_STATE_ROOT" 2>/dev/null || true)" == "root:${BRIDGE_GROUP}:750" ]] \
      || die 'Agent Zero Project model bridge state root ownership or mode drifted.'
    mountpoint -q "$BRIDGE_STATE_ROOT" \
      && die 'Agent Zero Project model bridge state root is a mount point; clean-slate removal was refused.'
    local unsafe_link=''
    unsafe_link="$(find "$BRIDGE_STATE_ROOT" -xdev -type l -print -quit)" \
      || die 'Agent Zero Project model bridge state could not be traversed safely.'
    [[ -z "$unsafe_link" ]] \
      || die 'Agent Zero Project model bridge state contains a symbolic link; clean-slate removal was refused.'
    rm -rf --one-file-system -- "$BRIDGE_STATE_ROOT" \
      || die 'Agent Zero Project model bridge state could not be removed.'
  fi

  if id -u "$BRIDGE_USER" >/dev/null 2>&1; then
    local passwd_entry account_name _password account_uid account_gid _gecos account_home account_shell
    passwd_entry="$(getent passwd "$BRIDGE_USER")" \
      || die 'Agent Zero Project model bridge account could not be inspected.'
    IFS=: read -r account_name _password account_uid account_gid _gecos account_home account_shell <<<"$passwd_entry"
    [[ "$account_name" == "$BRIDGE_USER" \
      && "$account_uid" =~ ^[0-9]+$ \
      && "$account_gid" =~ ^[0-9]+$ \
      && "$account_uid" -lt 1000 \
      && "$account_home" == '/nonexistent' \
      && "$account_shell" == '/usr/sbin/nologin' \
      && "$(id -gn "$BRIDGE_USER")" == "$BRIDGE_GROUP" ]] \
      || die 'Agent Zero Project model bridge account no longer matches the managed identity contract.'
    userdel "$BRIDGE_USER" \
      || die 'Agent Zero Project model bridge account could not be removed.'
  fi
  if getent group "$BRIDGE_GROUP" >/dev/null 2>&1; then
    [[ "$(getent group "$BRIDGE_GROUP" | awk -F: '{ print $1 ":" $3 ":" $4 }')" =~ ^${BRIDGE_GROUP}:[0-9]+:$ ]] \
      || die 'Agent Zero Project model bridge group no longer matches the managed identity contract.'
    groupdel "$BRIDGE_GROUP" \
      || die 'Agent Zero Project model bridge group could not be removed.'
  fi
}

uninstall_bridge() {
  require_root
  local clean_slate="${1:-false}"
  for command in docker id pgrep systemctl; do require_command "$command"; done
  if [[ "$clean_slate" == 'true' ]]; then
    for command in find getent groupdel mountpoint stat userdel; do require_command "$command"; done
  fi

  # These exact files are installer-owned only when they are ordinary files.
  # A linked or non-regular replacement is an administrator/foreign boundary;
  # fail before stopping or revoking anything rather than silently leaving a
  # live bridge behind and reporting a successful uninstall.
  local managed_file
  for managed_file in "$BRIDGE_UNIT_FILE" "$BRIDGE_ENV_FILE"; do
    if [[ -e "$managed_file" || -L "$managed_file" ]]; then
      [[ -f "$managed_file" && ! -L "$managed_file" ]] \
        || die "Agent Zero Project model bridge managed file is linked or non-regular: ${managed_file}"
    fi
  done
  stop_bridge_for_uninstall
  if agent_zero_container_present_for_uninstall; then
    local running
    running="$(docker inspect --format '{{.State.Running}}' "$A0_CONTAINER" 2>/dev/null)" \
      || die 'Agent Zero container state could not be inspected during bridge uninstall.'
    if [[ "$running" == 'true' ]]; then
      configure_agent_zero_proxy_token '' \
        || die 'Agent Zero upstream token revocation failed; service files were retained.'
    elif [[ "$running" != 'false' ]]; then
      die 'Agent Zero container returned an invalid running state during bridge uninstall.'
    fi
  fi
  if [[ -f "$BRIDGE_UNIT_FILE" ]]; then
    rm -f -- "$BRIDGE_UNIT_FILE"
  fi
  if [[ -f "$BRIDGE_ENV_FILE" ]]; then
    rm -f -- "$BRIDGE_ENV_FILE"
  fi
  [[ ! -e "$BRIDGE_UNIT_FILE" && ! -L "$BRIDGE_UNIT_FILE" \
    && ! -e "$BRIDGE_ENV_FILE" && ! -L "$BRIDGE_ENV_FILE" ]] \
    || die 'Agent Zero Project model bridge service files did not converge to absent.'
  systemctl daemon-reload \
    || die 'Systemd could not forget the Agent Zero Project model bridge unit.'
  if [[ "$clean_slate" == 'true' ]]; then
    remove_clean_slate_bridge_state
    log 'Removed the bridge service, protected state, and dedicated identity after project cleanup.'
  else
    # Per-project records are deliberately retained. Their exact Project cleanup
    # adapter owns revocation so uninstall cannot orphan project deletion state.
    log 'Removed the bridge service and revoked its upstream token; per-project records remain cleanup-owned.'
  fi
}

usage() {
  cat <<'EOF'
Usage: agent-zero-project-model-bridge.sh <command>

Commands:
  install            Install/start the bridge in fail-closed mode (no Agent Zero required)
  status             Verify service, upstream, protected state, and fail-closed HTTP
  reconcile          Install or converge the managed bridge
  token-rotate       Rotate and rollback-test the host-only upstream token
  stop               Stop the bridge without changing credentials
  uninstall          Remove service/upstream token; preserve project cleanup records
  uninstall-clean-slate
                     Remove service/state/identity after project cleanup has converged
EOF
}

case "${1:-}" in
  install) install_bridge_service ;;
  status) status_bridge ;;
  reconcile) reconcile_bridge ;;
  token-rotate) rotate_upstream_token ;;
  stop) stop_bridge ;;
  uninstall) uninstall_bridge ;;
  uninstall-clean-slate) uninstall_bridge true ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
