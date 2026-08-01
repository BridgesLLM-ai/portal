#!/usr/bin/env bash
set -Eeuo pipefail

# Managed Agent Zero runtime contract for Portal 4.0.
#
# This script deliberately does not enable the Portal provider. It owns the
# pinned container lifecycle so later setup/streaming work cannot inherit an
# unpinned, unauthenticated, publicly-bound Docker deployment.

readonly A0_VERSION="2.5"
readonly A0_IMAGE_REPOSITORY="agent0ai/agent-zero"
readonly A0_AMD64_DIGEST="sha256:9b48534c1279fb831513b8c970e2d9004e7a2a6708a4d53a91a76d24a4f9f7eb"
readonly A0_ARM64_DIGEST="sha256:da107b689828124369d83f017b9664493c0699c60e57809fbd32f647078de49c"
readonly A0_CONTAINER="bridgesllm-agent-zero"
readonly A0_ROLLBACK_CONTAINER="bridgesllm-agent-zero-rollback"
readonly A0_VOLUME="bridgesllm-agent-zero-usr"
readonly A0_DEFAULT_AUTH_FILE="/etc/bridgesllm/agent-zero.env"
readonly A0_AUTH_FILE="${AGENT_ZERO_AUTH_FILE:-${A0_DEFAULT_AUTH_FILE}}"
readonly A0_HOST="127.0.0.1"
readonly A0_PORT="50001"
readonly A0_STATE_DIR="/var/lib/bridgesllm/agent-zero-runtime"
readonly A0_BACKUP_DIR="/var/backups/bridgesllm/agent-zero"
readonly A0_LATEST_BACKUP_FILE="${A0_STATE_DIR}/latest-backup"
readonly A0_CAPABILITIES_PATH="/api/plugins/_a0_connector/v1/capabilities"
readonly A0_CONNECTOR_VERSION="0.1.0"
# Agent Zero's Codex OAuth model catalog calls the OpenAI Codex upstream
# directly. The v2.5 image does not include the Codex CLI, so its automatic
# version probe resolves to an empty string and the upstream rejects model
# discovery for omitting client_version. Keep this aligned with Portal's tested
# Codex CLI compatibility pin and converge it into the persistent _oauth plugin
# configuration without installing another mutable CLI inside the container.
readonly A0_CODEX_CLIENT_VERSION="0.145.0"

# Official Agent Zero A0 CLI v2.5 host-gateway component. The release has no
# uploaded binary assets, so Portal installs the official source archive into a
# dedicated venv only after verifying the archive and both official hashed
# dependency locks. The provider then verifies this provenance again at runtime.
readonly A0_CLI_VERSION="2.5"
readonly A0_CLI_TAG="v2.5"
readonly A0_CLI_COMMIT="db0e53eba65326ee0792cbb007abfda31114b3f2"
readonly A0_CLI_ARCHIVE_URL="https://github.com/agent0ai/a0-connector/archive/refs/tags/v2.5.tar.gz"
readonly A0_CLI_ARCHIVE_SHA256="97cc0396b55e517775a0790d974d4c81c6534926fead01b02d150807180521b6"
readonly A0_CLI_RUNTIME_CONSTRAINTS_URL="https://raw.githubusercontent.com/agent0ai/a0-connector/refs/tags/v2.5/constraints/a0-runtime.txt"
readonly A0_CLI_RUNTIME_CONSTRAINTS_SHA256="bfe27824fca3f23ffc4a1b06b8b2194d59db48ebaeb05c09ca1e46332075a327"
readonly A0_CLI_BUILD_CONSTRAINTS_URL="https://raw.githubusercontent.com/agent0ai/a0-connector/refs/tags/v2.5/constraints/a0-build.txt"
readonly A0_CLI_BUILD_CONSTRAINTS_SHA256="7ded8dd591c408dfbe552eeffacb5e75dcddb02cd3072c8cec3653494a37aa19"
readonly A0_CLI_ROOT="${A0_STATE_DIR}/a0-cli"
readonly A0_CLI_ROLLBACK_ROOT="${A0_STATE_DIR}/a0-cli-rollback"
readonly A0_CLI_BINARY="${A0_CLI_ROOT}/bin/a0"
readonly A0_CLI_PROVENANCE="${A0_CLI_ROOT}/PROVENANCE"
readonly A0_GATEWAY_HOME="${A0_STATE_DIR}/host-gateway-home"

log() { printf '[Agent Zero] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || die 'This lifecycle command requires root.'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

normalized_architecture() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) die "Unsupported host architecture: $(uname -m)" ;;
  esac
}

image_ref() {
  case "$(normalized_architecture)" in
    amd64) printf '%s@%s\n' "$A0_IMAGE_REPOSITORY" "$A0_AMD64_DIGEST" ;;
    arm64) printf '%s@%s\n' "$A0_IMAGE_REPOSITORY" "$A0_ARM64_DIGEST" ;;
  esac
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

# Clean uninstall must distinguish "not present" from "Docker could not tell
# us." Inspect alone collapses daemon/permission failures into absence, which
# can otherwise let protected host state be deleted while containers survive.
uninstall_container_present() {
  local names
  names="$(docker ps --all --format '{{.Names}}')" || return 2
  grep -Fxq -- "$1" <<<"$names"
}

uninstall_volume_present() {
  local names
  names="$(docker volume ls --format '{{.Name}}')" || return 2
  grep -Fxq -- "$A0_VOLUME" <<<"$names"
}

validate_auth_file() {
  [[ "$A0_AUTH_FILE" = /* && "$A0_AUTH_FILE" != *','* ]] \
    || die 'AGENT_ZERO_AUTH_FILE must be an absolute path without commas.'
  [[ -f "$A0_AUTH_FILE" && ! -L "$A0_AUTH_FILE" ]] \
    || die "Protected Agent Zero auth file is missing: $A0_AUTH_FILE"

  local uid mode
  uid="$(stat -c '%u' "$A0_AUTH_FILE")"
  mode="$(stat -c '%a' "$A0_AUTH_FILE")"
  [[ "$uid" == "0" && "$mode" == "600" ]] \
    || die 'Agent Zero auth file must be root-owned with mode 600.'

  awk -F= '
    function present(raw, first, last) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", raw)
      first = substr(raw, 1, 1)
      last = substr(raw, length(raw), 1)
      if (first == "\"" || first == "\047") {
        if (length(raw) < 2 || last != first) return 0
        raw = substr(raw, 2, length(raw) - 2)
      }
      return length(raw) > 0
    }
    /^[[:space:]]*(#|$)/ { next }
    $1 == "AUTH_LOGIN" {
      login_count += 1
      value = substr($0, index($0, "=") + 1)
      if (present(value)) login = 1
      next
    }
    $1 == "AUTH_PASSWORD" {
      password_count += 1
      value = substr($0, index($0, "=") + 1)
      if (present(value)) password = 1
      next
    }
    { unknown += 1 }
    END { exit !(login_count == 1 && password_count == 1 && login && password && unknown == 0) }
  ' "$A0_AUTH_FILE" || die 'Agent Zero auth file must contain exactly one non-empty AUTH_LOGIN and AUTH_PASSWORD entry.'
}

ensure_runtime_directories() {
  install -d -m 700 -o root -g root "$A0_STATE_DIR" "$A0_BACKUP_DIR" "$A0_GATEWAY_HOME"
}

root_protected_regular_file() {
  local path="$1" executable="${2:-false}" uid mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  uid="$(stat -c '%u' "$path")" || return 1
  mode="$(stat -c '%a' "$path")" || return 1
  [[ "$uid" == "0" ]] || return 1
  (( (8#$mode & 0022) == 0 )) || return 1
  [[ "$executable" != "true" || -x "$path" ]]
}

root_protected_private_directory() {
  local path="$1" uid mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  uid="$(stat -c '%u' "$path")" || return 1
  mode="$(stat -c '%a' "$path")" || return 1
  [[ "$uid" == "0" ]] || return 1
  (( (8#$mode & 0077) == 0 ))
}

host_bridge_provenance_ok() {
  root_protected_regular_file "$A0_CLI_PROVENANCE" || return 1
  [[ "$(stat -c '%a' "$A0_CLI_PROVENANCE")" == "600" ]] || return 1
  [[ "$(grep -Evc '^[[:space:]]*(#|$)' "$A0_CLI_PROVENANCE")" == "6" ]] || return 1
  grep -Fqx "A0_CLI_VERSION=${A0_CLI_VERSION}" "$A0_CLI_PROVENANCE" \
    && grep -Fqx "A0_CLI_TAG=${A0_CLI_TAG}" "$A0_CLI_PROVENANCE" \
    && grep -Fqx "A0_CLI_COMMIT=${A0_CLI_COMMIT}" "$A0_CLI_PROVENANCE" \
    && grep -Fqx "A0_CLI_ARCHIVE_SHA256=${A0_CLI_ARCHIVE_SHA256}" "$A0_CLI_PROVENANCE" \
    && grep -Fqx "A0_CLI_RUNTIME_CONSTRAINTS_SHA256=${A0_CLI_RUNTIME_CONSTRAINTS_SHA256}" "$A0_CLI_PROVENANCE" \
    && grep -Fqx "A0_CLI_BUILD_CONSTRAINTS_SHA256=${A0_CLI_BUILD_CONSTRAINTS_SHA256}" "$A0_CLI_PROVENANCE"
}

host_bridge_contract_ok() {
  [[ -d "$A0_CLI_ROOT" && ! -L "$A0_CLI_ROOT" ]] || return 1
  [[ "$(stat -c '%u' "$A0_CLI_ROOT")" == "0" ]] || return 1
  (( (8#$(stat -c '%a' "$A0_CLI_ROOT") & 0022) == 0 )) || return 1
  root_protected_private_directory "$A0_GATEWAY_HOME" || return 1
  root_protected_regular_file "$A0_CLI_BINARY" true || return 1
  host_bridge_provenance_ok || return 1
  [[ "$(timeout 10s "$A0_CLI_BINARY" --version 2>/dev/null | tr -d '[:space:]' | sed 's/^v//')" == "$A0_CLI_VERSION" ]]
}

write_host_bridge_provenance() {
  local target="$1"
  cat >"$target" <<EOF
A0_CLI_VERSION=${A0_CLI_VERSION}
A0_CLI_TAG=${A0_CLI_TAG}
A0_CLI_COMMIT=${A0_CLI_COMMIT}
A0_CLI_ARCHIVE_SHA256=${A0_CLI_ARCHIVE_SHA256}
A0_CLI_RUNTIME_CONSTRAINTS_SHA256=${A0_CLI_RUNTIME_CONSTRAINTS_SHA256}
A0_CLI_BUILD_CONSTRAINTS_SHA256=${A0_CLI_BUILD_CONSTRAINTS_SHA256}
EOF
  chmod 600 "$target"
}

download_verified_host_bridge_sources() {
  local work_dir="$1" archive runtime_constraints build_constraints
  archive="${work_dir}/a0-v2.5.tar.gz"
  runtime_constraints="${work_dir}/a0-runtime.txt"
  build_constraints="${work_dir}/a0-build.txt"

  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --tlsv1.2 "$A0_CLI_ARCHIVE_URL" --output "$archive"
  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --tlsv1.2 "$A0_CLI_RUNTIME_CONSTRAINTS_URL" --output "$runtime_constraints"
  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --tlsv1.2 "$A0_CLI_BUILD_CONSTRAINTS_URL" --output "$build_constraints"

  printf '%s  %s\n' "$A0_CLI_ARCHIVE_SHA256" "$archive" | sha256sum --check --status \
    || die 'Official A0 CLI v2.5 source archive failed its immutable digest check.'
  printf '%s  %s\n' "$A0_CLI_RUNTIME_CONSTRAINTS_SHA256" "$runtime_constraints" | sha256sum --check --status \
    || die 'Official A0 CLI v2.5 runtime lock failed its immutable digest check.'
  printf '%s  %s\n' "$A0_CLI_BUILD_CONSTRAINTS_SHA256" "$build_constraints" | sha256sum --check --status \
    || die 'Official A0 CLI v2.5 build lock failed its immutable digest check.'
}

build_host_bridge_candidate() {
  local work_dir="$1" candidate archive runtime_constraints build_constraints
  # Python venv entry-point shebangs contain absolute paths. Build directly at
  # the final managed path after moving the previous install to rollback;
  # moving a completed candidate venv would make its `a0` entry point invalid.
  candidate="$A0_CLI_ROOT"
  archive="${work_dir}/a0-v2.5.tar.gz"
  runtime_constraints="${work_dir}/a0-runtime.txt"
  build_constraints="${work_dir}/a0-build.txt"

  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
    || die 'The official A0 CLI v2.5 host gateway requires Python 3.10 or newer.'
  # Boxes installed before python3-venv joined the base package set cannot
  # create a venv with pip (ensurepip is missing). Self-heal instead of dying
  # with an opaque build failure.
  if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
    log 'Installing python3-venv (required for the A0 CLI host gateway).'
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null 2>&1 \
      || die 'python3-venv is missing and could not be installed automatically.'
    python3 -c 'import ensurepip' >/dev/null 2>&1 \
      || die 'python3-venv installation did not provide ensurepip.'
  fi
  python3 -m venv "$candidate"
  "$candidate/bin/python" -m pip install \
    --disable-pip-version-check --no-input --no-deps --require-hashes \
    --requirement "$runtime_constraints" >/dev/null
  "$candidate/bin/python" -m pip install \
    --disable-pip-version-check --no-input --no-deps --require-hashes \
    --requirement "$build_constraints" >/dev/null
  "$candidate/bin/python" -m pip install \
    --disable-pip-version-check --no-input --no-deps --no-build-isolation \
    "$archive" >/dev/null
  [[ "$("$candidate/bin/a0" --version 2>/dev/null | tr -d '[:space:]' | sed 's/^v//')" == "$A0_CLI_VERSION" ]] \
    || die 'Built A0 CLI host-gateway candidate did not report exact version 2.5.'
  write_host_bridge_provenance "$candidate/PROVENANCE"
  chown -R root:root "$candidate"
  chmod -R go-w "$candidate"
}

install_or_update_host_bridge() {
  require_command curl
  require_command python3
  require_command sha256sum
  require_command timeout
  ensure_runtime_directories

  if host_bridge_contract_ok; then
    log "Official A0 CLI ${A0_CLI_VERSION} host gateway already satisfies its immutable contract."
    return 0
  fi

  local work_dir failed_root
  work_dir="$(mktemp -d "${A0_STATE_DIR}/a0-cli-install.XXXXXX")"
  if ! (
    set -Eeuo pipefail
    download_verified_host_bridge_sources "$work_dir"
  ); then
    rm -rf -- "$work_dir"
    die 'Could not download and verify the pinned official A0 CLI v2.5 host gateway.'
  fi

  if [[ -e "$A0_CLI_ROLLBACK_ROOT" ]]; then
    [[ "$A0_CLI_ROLLBACK_ROOT" == "${A0_STATE_DIR}/a0-cli-rollback" ]] \
      || die 'Refusing to clean an unexpected A0 CLI rollback path.'
    rm -rf -- "$A0_CLI_ROLLBACK_ROOT"
  fi
  if [[ -e "$A0_CLI_ROOT" ]]; then
    [[ -d "$A0_CLI_ROOT" && ! -L "$A0_CLI_ROOT" ]] \
      || die 'Refusing to replace an unsafe managed A0 CLI path.'
    mv "$A0_CLI_ROOT" "$A0_CLI_ROLLBACK_ROOT"
  fi

  if ! (
    set -Eeuo pipefail
    build_host_bridge_candidate "$work_dir"
  ); then
    failed_root="${A0_STATE_DIR}/a0-cli-failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    [[ -e "$A0_CLI_ROOT" ]] && mv "$A0_CLI_ROOT" "$failed_root"
    if [[ -d "$A0_CLI_ROLLBACK_ROOT" && ! -L "$A0_CLI_ROLLBACK_ROOT" ]]; then
      mv "$A0_CLI_ROLLBACK_ROOT" "$A0_CLI_ROOT"
    fi
    rm -rf -- "$work_dir"
    die "Could not build the pinned A0 CLI host gateway; failed candidate was preserved at $failed_root"
  fi
  rm -rf -- "$work_dir"

  if ! host_bridge_contract_ok; then
    failed_root="${A0_STATE_DIR}/a0-cli-failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mv "$A0_CLI_ROOT" "$failed_root"
    if [[ -d "$A0_CLI_ROLLBACK_ROOT" && ! -L "$A0_CLI_ROLLBACK_ROOT" ]]; then
      mv "$A0_CLI_ROLLBACK_ROOT" "$A0_CLI_ROOT"
    fi
    die "A0 CLI host-gateway verification failed; failed candidate was preserved at $failed_root"
  fi
  log "Installed immutable official A0 CLI ${A0_CLI_VERSION} host gateway."
}

status_host_bridge() {
  require_command timeout
  host_bridge_contract_ok \
    || die 'Managed official A0 CLI v2.5 host gateway is not installed or violates its immutable contract.'
  printf 'Official A0 CLI %s host gateway is provenance-verified for supervised HOST_OPERATOR use\n' "$A0_CLI_VERSION"
}

rollback_host_bridge() {
  ensure_runtime_directories
  [[ -d "$A0_CLI_ROLLBACK_ROOT" && ! -L "$A0_CLI_ROLLBACK_ROOT" ]] \
    || die 'No managed A0 CLI host-gateway rollback exists.'
  local failed_root
  failed_root="${A0_STATE_DIR}/a0-cli-pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if [[ -e "$A0_CLI_ROOT" ]]; then
    [[ -d "$A0_CLI_ROOT" && ! -L "$A0_CLI_ROOT" ]] \
      || die 'Refusing to replace an unsafe managed A0 CLI path.'
    mv "$A0_CLI_ROOT" "$failed_root"
  fi
  mv "$A0_CLI_ROLLBACK_ROOT" "$A0_CLI_ROOT"
  if ! host_bridge_contract_ok; then
    mv "$A0_CLI_ROOT" "$A0_CLI_ROLLBACK_ROOT"
    [[ -d "$failed_root" ]] && mv "$failed_root" "$A0_CLI_ROOT"
    die 'A0 CLI host-gateway rollback candidate failed verification; current installation was restored.'
  fi
  log "A0 CLI host-gateway rollback completed; replaced installation remains at $failed_root"
}

create_container() {
  local name="$1" host_port="$2" data_volume="$3"
  # host.docker.internal is required by Agent Zero's own provider catalog for
  # every host-local model backend (Ollama, vLLM, the Portal model bridge).
  # Without it the image cannot reach any host-mediated LLM endpoint.
  docker run -d \
    --name "$name" \
    --restart unless-stopped \
    --publish "${A0_HOST}:${host_port}:80" \
    --add-host "host.docker.internal:host-gateway" \
    --mount "type=volume,src=${data_volume},dst=/a0/usr" \
    --mount "type=bind,src=${A0_AUTH_FILE},dst=/a0/.env,readonly" \
    --label "io.bridgesllm.agent-zero.version=${A0_VERSION}" \
    --label "io.bridgesllm.agent-zero.managed=true" \
    "$(image_ref)" >/dev/null
}

connector_protocol_ready() {
  local host_port="$1" payload
  payload="$(curl --fail --silent --show-error --max-time 3 \
    --request POST \
    --header 'Content-Type: application/json' \
    --data '{}' \
    "http://${A0_HOST}:${host_port}${A0_CAPABILITIES_PATH}" 2>/dev/null)" || return 1

  python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
version = str(value.get("agent_zero_version") or "").strip().removeprefix("v")
ok = (
    value.get("protocol") == "a0-connector.v1"
    and str(value.get("version") or "").strip().removeprefix("v") == sys.argv[1]
    and version == "2.5"
    and value.get("auth_required") is True
    and value.get("auth") == ["session"]
    and "http" in (value.get("transports") or [])
    and "websocket" in (value.get("transports") or [])
    and value.get("websocket_namespace") == "/ws"
    and "plugins/_a0_connector/ws_connector" in (value.get("websocket_handlers") or [])
    and "launcher_gateway" in (value.get("features") or [])
    and "launcher_gateway_file_write" in (value.get("features") or [])
    and "connector_login" not in (value.get("features") or [])
)
raise SystemExit(0 if ok else 1)
' "$A0_CONNECTOR_VERSION" <<<"$payload"
}

wait_until_ready() {
  local host_port="$1" attempts="${2:-60}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    connector_protocol_ready "$host_port" && return 0
    sleep 2
  done
  return 1
}

container_contract_ok() {
  local expected image running restart_policy binding binding_count data_mount auth_mount
  local version_label managed_label
  expected="$(image_ref)"
  image="$(docker inspect --format '{{.Config.Image}}' "$A0_CONTAINER" 2>/dev/null)" || return 1
  version_label="$(docker inspect --format '{{index .Config.Labels "io.bridgesllm.agent-zero.version"}}' "$A0_CONTAINER" 2>/dev/null)" || return 1
  managed_label="$(docker inspect --format '{{index .Config.Labels "io.bridgesllm.agent-zero.managed"}}' "$A0_CONTAINER" 2>/dev/null)" || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$A0_CONTAINER")"
  restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$A0_CONTAINER")"
  binding="$(docker inspect --format '{{with (index .HostConfig.PortBindings "80/tcp")}}{{(index . 0).HostIp}}|{{(index . 0).HostPort}}|{{len .}}{{end}}' "$A0_CONTAINER")"
  binding_count="$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$A0_CONTAINER")"
  data_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/a0/usr"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$A0_CONTAINER")"
  auth_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/a0/.env"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$A0_CONTAINER")"

  [[ "$image" == "$expected" \
    && "$version_label" == "$A0_VERSION" \
    && "$managed_label" == 'true' \
    && "$running" == "true" \
    && "$restart_policy" == "unless-stopped" \
    && "$binding_count" == "1" \
    && "$binding" == "${A0_HOST}|${A0_PORT}|1" \
    && "$data_mount" == "volume|${A0_VOLUME}|true" \
    && "$auth_mount" == "bind|${A0_AUTH_FILE}|false" ]]
}

managed_data_volume_ok() {
  local data_mount
  data_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/a0/usr"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$A0_CONTAINER" 2>/dev/null)" || return 1
  [[ "$data_mount" == "volume|${A0_VOLUME}|true" ]]
}

agent_zero_codex_client_version_ok() {
  printf '%s' "$A0_CODEX_CLIENT_VERSION" | docker exec -i --workdir /a0 "$A0_CONTAINER" \
    /opt/venv-a0/bin/python -c '
import sys
from helpers import plugins
expected = sys.stdin.read().strip()
cfg = plugins.get_plugin_config("_oauth") or {}
codex = cfg.get("codex") if isinstance(cfg, dict) else None
ok = isinstance(codex, dict) and str(codex.get("codex_version") or "").strip() == expected
raise SystemExit(0 if ok else 1)
' >/dev/null 2>&1
}

configure_agent_zero_codex_client_version() {
  [[ "$A0_CODEX_CLIENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] \
    || die 'Refusing to configure a malformed Agent Zero Codex client version.'
  if ! printf '%s' "$A0_CODEX_CLIENT_VERSION" | docker exec -i --workdir /a0 "$A0_CONTAINER" \
    /opt/venv-a0/bin/python -c '
import sys
from helpers import plugins
version = sys.stdin.read().strip()
cfg = plugins.get_plugin_config("_oauth") or {}
if not isinstance(cfg, dict):
    raise SystemExit(2)
codex = cfg.get("codex") or {}
if not isinstance(codex, dict):
    raise SystemExit(3)
codex = dict(codex)
codex["codex_version"] = version
cfg = dict(cfg)
cfg["codex"] = codex
plugins.save_plugin_config("_oauth", "", "", cfg)
saved = plugins.get_plugin_config("_oauth") or {}
saved_codex = saved.get("codex") if isinstance(saved, dict) else None
ok = isinstance(saved_codex, dict) and str(saved_codex.get("codex_version") or "").strip() == version
print("configured" if ok else "failed")
raise SystemExit(0 if ok else 4)
' | grep -Fqx 'configured'; then
    log 'Agent Zero Codex OAuth client-version convergence failed.'
    return 1
  fi
}

status_runtime() {
  require_command docker
  require_command curl
  require_command python3
  validate_auth_file
  container_exists "$A0_CONTAINER" || die 'Managed Agent Zero container is not installed.'
  container_contract_ok || die 'Managed container exists but violates the pinned runtime contract.'
  connector_protocol_ready "$A0_PORT" || die 'Agent Zero connector protocol is not ready or outside the tested v2.5 contract.'
  agent_zero_codex_client_version_ok \
    || die 'Agent Zero Codex OAuth model discovery is missing the tested client-version contract.'
  status_host_bridge
  printf 'Agent Zero %s runtime protocol-ready on %s:%s with Codex OAuth model discovery configured; protected session authentication is verified separately\n' "$A0_VERSION" "$A0_HOST" "$A0_PORT"
}

volume_mountpoint() {
  local mountpoint
  mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$A0_VOLUME")"
  [[ -n "$mountpoint" && -d "$mountpoint" ]] || die 'Managed Agent Zero data-volume path is unavailable.'
  printf '%s\n' "$mountpoint"
}

backup_data_volume() {
  ensure_runtime_directories
  local mountpoint stamp temporary snapshot
  mountpoint="$(volume_mountpoint)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  snapshot="${A0_BACKUP_DIR}/a0-usr-${stamp}.tar.gz"
  temporary="${snapshot}.tmp.$$"
  tar -C "$mountpoint" -czf "$temporary" .
  chmod 600 "$temporary"
  mv -f "$temporary" "$snapshot"
  printf '%s\n' "$snapshot" >"${A0_LATEST_BACKUP_FILE}.tmp"
  chmod 600 "${A0_LATEST_BACKUP_FILE}.tmp"
  mv -f "${A0_LATEST_BACKUP_FILE}.tmp" "$A0_LATEST_BACKUP_FILE"
  printf '%s\n' "$snapshot"
}

validated_snapshot() {
  [[ -f "$A0_LATEST_BACKUP_FILE" && ! -L "$A0_LATEST_BACKUP_FILE" ]] \
    || die 'No managed Agent Zero rollback snapshot is recorded.'
  local snapshot canonical
  snapshot="$(<"$A0_LATEST_BACKUP_FILE")"
  canonical="$(realpath -e "$snapshot")"
  [[ "$canonical" == "${A0_BACKUP_DIR}/"* && -f "$canonical" && ! -L "$canonical" ]] \
    || die 'Recorded Agent Zero rollback snapshot is invalid.'
  tar -tzf "$canonical" >/dev/null || die 'Recorded Agent Zero rollback snapshot is corrupt.'
  printf '%s\n' "$canonical"
}

restore_data_snapshot() {
  local snapshot="$1" mountpoint quarantine failed_extract
  mountpoint="$(volume_mountpoint)"
  quarantine="${A0_BACKUP_DIR}/pre-restore-data-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  failed_extract="${A0_BACKUP_DIR}/failed-restore-data-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -m 700 "$quarantine"

  shopt -s dotglob nullglob
  local existing=("${mountpoint}"/*)
  if ((${#existing[@]})); then
    mv -- "${existing[@]}" "$quarantine/"
  fi
  if tar -C "$mountpoint" -xzf "$snapshot"; then
    log "Restored Agent Zero data snapshot; previous data remains recoverable at $quarantine"
    return 0
  fi

  install -d -m 700 "$failed_extract"
  local partial=("${mountpoint}"/*)
  if ((${#partial[@]})); then
    mv -- "${partial[@]}" "$failed_extract/" || true
  fi
  local original=("${quarantine}"/*)
  if ((${#original[@]})); then
    mv -- "${original[@]}" "$mountpoint/"
  fi
  die "Snapshot restore failed; original data was put back and partial output is at $failed_extract"
}

preflight_image() {
  local candidate="${A0_CONTAINER}-preflight-$$"
  local candidate_volume="${A0_VOLUME}-preflight-$$"
  local candidate_port=''

  docker volume create "$candidate_volume" >/dev/null
  cleanup_preflight() {
    docker rm -f "$candidate" >/dev/null 2>&1 || true
    docker volume rm "$candidate_volume" >/dev/null 2>&1 || true
  }

  if ! docker run -d \
    --name "$candidate" \
    --restart no \
    --publish "${A0_HOST}::80" \
    --mount "type=volume,src=${candidate_volume},dst=/a0/usr" \
    --mount "type=bind,src=${A0_AUTH_FILE},dst=/a0/.env,readonly" \
    "$(image_ref)" >/dev/null; then
    cleanup_preflight
    die 'Pinned Agent Zero image could not start for preflight.'
  fi
  candidate_port="$(docker port "$candidate" 80/tcp | awk -F: '$1 == "127.0.0.1" { print $NF; exit }')"
  if [[ ! "$candidate_port" =~ ^[0-9]+$ ]]; then
    cleanup_preflight
    die 'Could not resolve the loopback preflight port.'
  fi
  if ! wait_until_ready "$candidate_port" 60; then
    cleanup_preflight
    die 'Pinned Agent Zero image failed connector protocol preflight.'
  fi
  cleanup_preflight
}

rollback_failed_update() {
  local snapshot="$1"
  log 'Candidate failed readiness; restoring the previous container and data snapshot.'
  docker rm -f "$A0_CONTAINER" >/dev/null 2>&1 || true
  restore_data_snapshot "$snapshot"
  docker rename "$A0_ROLLBACK_CONTAINER" "$A0_CONTAINER"
  docker start "$A0_CONTAINER" >/dev/null
  wait_until_ready "$A0_PORT" 60 || die 'Previous Agent Zero container was restored but did not become ready.'
  configure_agent_zero_codex_client_version \
    || die 'Previous Agent Zero container was restored but its Codex OAuth model-discovery contract could not be converged.'
}

install_or_update() {
  require_command docker
  require_command curl
  require_command python3
  require_command tar
  require_command realpath
  validate_auth_file
  ensure_runtime_directories
  install_or_update_host_bridge

  if container_exists "$A0_CONTAINER" && container_contract_ok && connector_protocol_ready "$A0_PORT"; then
    configure_agent_zero_codex_client_version \
      || die 'Managed Agent Zero runtime is ready but its Codex OAuth model-discovery contract could not be converged.'
    log "Agent Zero $A0_VERSION already satisfies the managed runtime contract."
    return 0
  fi

  log "Pulling immutable Agent Zero $A0_VERSION image for $(normalized_architecture)."
  docker pull "$(image_ref)" >/dev/null
  preflight_image

  if container_exists "$A0_CONTAINER" && ! managed_data_volume_ok; then
    die 'Refusing to replace an existing Agent Zero container whose /a0/usr is not the managed persistent volume. Back it up and migrate it explicitly.'
  fi
  docker volume create \
    --label 'io.bridgesllm.agent-zero.managed=true' \
    "$A0_VOLUME" >/dev/null

  if ! container_exists "$A0_CONTAINER"; then
    create_container "$A0_CONTAINER" "$A0_PORT" "$A0_VOLUME"
    if ! wait_until_ready "$A0_PORT" 60; then
      docker rm -f "$A0_CONTAINER" >/dev/null 2>&1 || true
      die 'Managed Agent Zero installation failed readiness; persistent data volume was retained.'
    fi
    if ! configure_agent_zero_codex_client_version; then
      docker rm -f "$A0_CONTAINER" >/dev/null 2>&1 || true
      die 'Managed Agent Zero installation could not configure Codex OAuth model discovery; persistent data volume was retained.'
    fi
    log "Installed managed Agent Zero $A0_VERSION runtime."
    return 0
  fi

  if container_exists "$A0_ROLLBACK_CONTAINER" \
    && [[ "$(docker inspect --format '{{.State.Running}}' "$A0_ROLLBACK_CONTAINER")" != 'false' ]]; then
    die 'Existing Agent Zero rollback container is unexpectedly running.'
  fi
  docker stop --time 30 "$A0_CONTAINER" >/dev/null
  local snapshot
  if ! snapshot="$(backup_data_volume)"; then
    docker start "$A0_CONTAINER" >/dev/null 2>&1 || true
    die 'Agent Zero data backup failed; the existing container was restarted.'
  fi

  if container_exists "$A0_ROLLBACK_CONTAINER"; then
    docker rm "$A0_ROLLBACK_CONTAINER" >/dev/null
  fi
  docker rename "$A0_CONTAINER" "$A0_ROLLBACK_CONTAINER"

  if ! create_container "$A0_CONTAINER" "$A0_PORT" "$A0_VOLUME" \
    || ! wait_until_ready "$A0_PORT" 60 \
    || ! configure_agent_zero_codex_client_version; then
    rollback_failed_update "$snapshot"
    die 'Agent Zero update failed; the previous runtime was restored.'
  fi
  log "Updated Agent Zero to $A0_VERSION. Rollback container and data snapshot were retained."
}

rollback_runtime() {
  require_command docker
  require_command curl
  require_command python3
  require_command tar
  require_command realpath
  validate_auth_file
  container_exists "$A0_ROLLBACK_CONTAINER" || die 'No managed Agent Zero rollback container exists.'
  local snapshot failed_name
  snapshot="$(validated_snapshot)"
  failed_name="${A0_CONTAINER}-pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)"

  if container_exists "$A0_CONTAINER"; then
    docker stop --time 30 "$A0_CONTAINER" >/dev/null 2>&1 || true
  fi
  restore_data_snapshot "$snapshot"
  if container_exists "$A0_CONTAINER"; then
    docker rename "$A0_CONTAINER" "$failed_name"
  fi
  docker rename "$A0_ROLLBACK_CONTAINER" "$A0_CONTAINER"
  docker start "$A0_CONTAINER" >/dev/null
  wait_until_ready "$A0_PORT" 60 \
    || die "Rollback container did not become ready; pre-rollback container remains at $failed_name"
  configure_agent_zero_codex_client_version \
    || die "Rollback container is ready but Codex OAuth model discovery could not be configured; pre-rollback container remains at $failed_name"
  log "Agent Zero rollback completed. Pre-rollback container remains at $failed_name"
}

reload_credentials() {
  require_command docker
  require_command curl
  require_command python3
  validate_auth_file
  container_exists "$A0_CONTAINER" || die 'Managed Agent Zero container is not installed.'
  managed_data_volume_ok \
    || die 'Refusing to reload credentials for an unmanaged Agent Zero data-volume contract.'

  # The credential file is bind-mounted read-only. Stop/start forces Docker to
  # bind the newly atomically replaced inode before Agent Zero loads its env.
  docker stop --time 30 "$A0_CONTAINER" >/dev/null
  docker start "$A0_CONTAINER" >/dev/null
  wait_until_ready "$A0_PORT" 60 \
    || die 'Agent Zero did not recover after protected credential reload.'
  configure_agent_zero_codex_client_version \
    || die 'Agent Zero recovered after credential reload but Codex OAuth model discovery could not be configured.'
  container_contract_ok \
    || die 'Agent Zero credential reload exposed runtime contract drift.'
  log 'Reloaded protected Agent Zero credentials and re-verified the managed runtime contract.'
}

managed_uninstall_path_ok() {
  local path="$1" expected="$2" expected_type="$3" uid gid mode canonical unsafe_entry
  [[ "$path" == "$expected" && "$path" == /* ]] || return 1
  [[ -e "$path" || -L "$path" ]] || return 0
  [[ ! -L "$path" ]] || return 1
  canonical="$(realpath -e -- "$path" 2>/dev/null)" || return 1
  [[ "$canonical" == "$expected" ]] || return 1
  uid="$(stat -c '%u' -- "$path" 2>/dev/null)" || return 1
  gid="$(stat -c '%g' -- "$path" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' -- "$path" 2>/dev/null)" || return 1
  [[ "$uid" == '0' && "$gid" == '0' ]] || return 1

  case "$expected_type" in
    auth)
      [[ -f "$path" && "$mode" == '600' ]] || return 1
      ;;
    directory)
      [[ -d "$path" && "$mode" == '700' ]] || return 1
      # Top-level entries are lifecycle-owned. Nested A0 CLI virtualenv
      # symlinks are safe to unlink and must not be followed by rm.
      unsafe_entry="$(find "$path" -xdev -mindepth 1 -maxdepth 1 \
        \( -type l -o ! -uid 0 -o ! -gid 0 \) -print -quit 2>/dev/null)" \
        || return 1
      [[ -z "$unsafe_entry" ]] || return 1
      ;;
    *) return 1 ;;
  esac
}

managed_pre_rollback_container_name_ok() {
  [[ "$1" =~ ^${A0_CONTAINER}-pre-rollback-[0-9]{8}T[0-9]{6}Z$ ]]
}

globally_discovered_agent_zero_container_names() {
  local names name
  names="$(docker ps --all --format '{{.Names}}')" || return 1
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if [[ "$name" == "$A0_CONTAINER" || "$name" == "$A0_ROLLBACK_CONTAINER" ]] \
      || managed_pre_rollback_container_name_ok "$name"; then
      printf '%s\n' "$name"
    fi
  done <<<"$names"
}

managed_container_uninstall_contract_ok() {
  local name="$1" expected image version_label managed_label restart_policy running
  local binding binding_count mount_count data_mount auth_mount data_mount_ok='false'
  local retained_pre_rollback='false'
  if [[ "$name" != "$A0_CONTAINER" && "$name" != "$A0_ROLLBACK_CONTAINER" ]]; then
    managed_pre_rollback_container_name_ok "$name" || return 1
    retained_pre_rollback='true'
  fi
  expected="$(image_ref)"
  image="$(docker inspect --format '{{.Config.Image}}' "$name" 2>/dev/null)" || return 1
  version_label="$(docker inspect --format '{{index .Config.Labels "io.bridgesllm.agent-zero.version"}}' "$name" 2>/dev/null)" || return 1
  managed_label="$(docker inspect --format '{{index .Config.Labels "io.bridgesllm.agent-zero.managed"}}' "$name" 2>/dev/null)" || return 1
  running="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" || return 1
  restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null)" || return 1
  binding="$(docker inspect --format '{{with (index .HostConfig.PortBindings "80/tcp")}}{{(index . 0).HostIp}}|{{(index . 0).HostPort}}|{{len .}}{{end}}' "$name" 2>/dev/null)" || return 1
  binding_count="$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$name" 2>/dev/null)" || return 1
  mount_count="$(docker inspect --format '{{len .Mounts}}' "$name" 2>/dev/null)" || return 1
  data_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/a0/usr"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$name" 2>/dev/null)" || return 1
  auth_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/a0/.env"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$name" 2>/dev/null)" || return 1

  if [[ "$retained_pre_rollback" == 'true' ]]; then
    # A compatible timestamped rollback artifact can predate the explicit
    # managed label. Preserve that bounded migration path while rejecting any
    # contradictory label and requiring the retained runtime to be stopped.
    # Reconciliation upgrades every active legacy container to the explicit
    # label before a future rollback can rename it.
    [[ ( "$managed_label" == 'true' || -z "$managed_label" || "$managed_label" == '<no value>' ) \
      && "$running" == 'false' ]] || return 1
    # A retained rollback can outlive a failed volume migration. Its exact
    # timestamped name, image, stopped state, auth mount, port, and complete
    # two-mount shape still establish container ownership. Accept any bounded
    # named Docker volume at /a0/usr, remove only the container, and leave that
    # drifted volume untouched for an operator to inspect.
    [[ "$data_mount" =~ ^volume\|[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\|true$ ]] \
      && data_mount_ok='true'
  else
    [[ "$managed_label" == 'true' || -z "$managed_label" || "$managed_label" == '<no value>' ]] || return 1
    [[ "$data_mount" == "volume|${A0_VOLUME}|true" ]] && data_mount_ok='true'
  fi

  [[ "$image" == "$expected" \
    && "$version_label" == "$A0_VERSION" \
    && "$restart_policy" == 'unless-stopped' \
    && "$binding_count" == '1' \
    && "$binding" == "${A0_HOST}|${A0_PORT}|1" \
    && "$mount_count" == '2' \
    && "$data_mount_ok" == 'true' \
    && "$auth_mount" == "bind|${A0_DEFAULT_AUTH_FILE}|false" ]]
}

attested_uninstall_volume_references() {
  local reference references
  references="$(docker ps --all --filter "volume=${A0_VOLUME}" --format '{{.Names}}')" \
    || die 'Could not enumerate every Agent Zero data-volume reference.'
  while IFS= read -r reference; do
    [[ -z "$reference" ]] && continue
    if [[ "$reference" != "$A0_CONTAINER" && "$reference" != "$A0_ROLLBACK_CONTAINER" ]] \
      && ! managed_pre_rollback_container_name_ok "$reference"; then
      die "Refusing to remove the Agent Zero data volume while a foreign container references it: ${reference}"
    fi
    container_exists "$reference" \
      || die 'Docker reported a stale or uninspectable Agent Zero volume reference.'
    managed_container_uninstall_contract_ok "$reference" \
      || die "Refusing to remove the Agent Zero data volume through an unattested container: ${reference}"
    printf '%s\n' "$reference"
  done <<<"$references"
}

managed_volume_uninstall_contract_ok() {
  local name driver scope labels mountpoint docker_root expected_mountpoint
  name="$(docker volume inspect --format '{{.Name}}' "$A0_VOLUME" 2>/dev/null)" || return 1
  driver="$(docker volume inspect --format '{{.Driver}}' "$A0_VOLUME" 2>/dev/null)" || return 1
  scope="$(docker volume inspect --format '{{.Scope}}' "$A0_VOLUME" 2>/dev/null)" || return 1
  labels="$(docker volume inspect --format '{{json .Labels}}' "$A0_VOLUME" 2>/dev/null)" || return 1
  mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$A0_VOLUME" 2>/dev/null)" || return 1
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || return 1
  [[ "$docker_root" == /* && "$mountpoint" == /* ]] || return 1
  expected_mountpoint="${docker_root%/}/volumes/${A0_VOLUME}/_data"

  [[ "$name" == "$A0_VOLUME" \
    && "$driver" == 'local' \
    && "$scope" == 'local' \
    && ( "$labels" == 'null' || "$labels" == '{}' || "$labels" == '{"io.bridgesllm.agent-zero.managed":"true"}' ) \
    && -d "$mountpoint" \
    && ! -L "$mountpoint" \
    && "$(stat -c '%u:%g' -- "$mountpoint" 2>/dev/null)" == '0:0' \
    && "$(realpath -e -- "$mountpoint" 2>/dev/null)" == "$(realpath -m -- "$expected_mountpoint" 2>/dev/null)" ]]
}

preflight_clean_uninstall() {
  [[ "$A0_AUTH_FILE" == "$A0_DEFAULT_AUTH_FILE" ]] \
    || die 'Clean uninstall only removes the exact installer-managed Agent Zero auth file.'
  managed_uninstall_path_ok "$A0_AUTH_FILE" "$A0_DEFAULT_AUTH_FILE" auth \
    || die 'Refusing to remove an unsafe or drifted Agent Zero auth-file path.'
  if [[ -e "$A0_AUTH_FILE" ]]; then
    validate_auth_file
  fi
  managed_uninstall_path_ok "$A0_STATE_DIR" '/var/lib/bridgesllm/agent-zero-runtime' directory \
    || die 'Refusing to remove an unsafe or drifted Agent Zero runtime-state path.'
  managed_uninstall_path_ok "$A0_BACKUP_DIR" '/var/backups/bridgesllm/agent-zero' directory \
    || die 'Refusing to remove an unsafe or drifted Agent Zero backup path.'

  local name names references presence_status any_exact_volume_container=false
  names="$(globally_discovered_agent_zero_container_names)" \
    || die 'Could not authoritatively enumerate Agent Zero containers before clean uninstall.'
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    managed_container_uninstall_contract_ok "$name" \
      || die "Refusing to remove Agent Zero container ${name}: its managed label, image, port, or mounts drifted."
    [[ "$name" == "$A0_CONTAINER" || "$name" == "$A0_ROLLBACK_CONTAINER" ]] \
      && any_exact_volume_container=true
  done <<<"$names"

  if uninstall_volume_present; then
    managed_volume_uninstall_contract_ok \
      || die 'Refusing to remove an unattested or drifted Agent Zero data volume.'
    references="$(attested_uninstall_volume_references)"
  else
    presence_status=$?
    [[ $presence_status -eq 1 ]] \
      || die 'Could not authoritatively enumerate Docker volumes before Agent Zero clean uninstall.'
    [[ "$any_exact_volume_container" == 'false' ]] \
      || die 'Managed Agent Zero containers exist but their exact data volume is missing.'
  fi
}

quiesce_runtime() {
  require_root
  require_command docker
  local name names running
  names="$(globally_discovered_agent_zero_container_names)" \
    || die 'Could not authoritatively enumerate Agent Zero containers before quiescence.'
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    managed_container_uninstall_contract_ok "$name" \
      || die "Refusing to stop Agent Zero container ${name}: its managed image, label, port, or mount contract drifted."
  done <<<"$names"
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    running="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" \
      || die "Could not re-inspect Agent Zero container before quiescence: ${name}"
    if [[ "$running" == 'true' ]]; then
      docker stop --time 30 "$name" >/dev/null \
        || die "Could not stop the attested Agent Zero container: ${name}"
    elif [[ "$running" != 'false' ]]; then
      die "Agent Zero container returned an invalid running state: ${name}"
    fi
  done <<<"$names"
  names="$(globally_discovered_agent_zero_container_names)" \
    || die 'Could not verify Agent Zero container quiescence.'
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    [[ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" == 'false' ]] \
      || die "Agent Zero container did not remain stopped: ${name}"
  done <<<"$names"
  log 'Stopped the attested Agent Zero runtime while preserving its data volume, auth, state, and rollback artifacts.'
}

runtime_active() {
  require_root
  require_command docker
  local name names running primary_running='false'
  names="$(globally_discovered_agent_zero_container_names)" \
    || die 'Could not authoritatively enumerate Agent Zero containers before recording runtime intent.'
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    managed_container_uninstall_contract_ok "$name" \
      || die "Refusing to report Agent Zero state: the managed contract of ${name} drifted."
    running="$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" \
      || die "Agent Zero container could not be inspected: ${name}"
    [[ "$running" == 'true' || "$running" == 'false' ]] \
      || die "Agent Zero container returned an invalid running state: ${name}"
    if [[ "$name" == "$A0_CONTAINER" ]]; then
      primary_running="$running"
    elif [[ "$running" == 'true' ]]; then
      # Quiesce stops rollback containers too. Refuse to collapse an unusual
      # multi-running state into one boolean that reconnect could not restore.
      die "A non-primary Agent Zero rollback container is running: ${name}"
    fi
  done <<<"$names"
  printf '%s\n' "$primary_running"
}

resume_runtime() {
  require_root
  require_command docker
  if ! docker container inspect "$A0_CONTAINER" >/dev/null 2>&1; then
    log 'No managed Agent Zero container exists; nothing to resume.'
    return 0
  fi
  managed_container_uninstall_contract_ok "$A0_CONTAINER" \
    || die "Refusing to start Agent Zero container ${A0_CONTAINER}: its managed image, label, port, or mount contract drifted."
  local running
  running="$(docker inspect --format '{{.State.Running}}' "$A0_CONTAINER" 2>/dev/null)" \
    || die 'Agent Zero container could not be inspected before resume.'
  if [[ "$running" == 'true' ]]; then
    log 'The attested Agent Zero runtime is already running.'
    return 0
  fi
  [[ "$running" == 'false' ]] \
    || die 'Agent Zero container returned an invalid running state.'
  docker start "$A0_CONTAINER" >/dev/null \
    || die "Could not start the attested Agent Zero container: ${A0_CONTAINER}"
  [[ "$(docker inspect --format '{{.State.Running}}' "$A0_CONTAINER" 2>/dev/null)" == 'true' ]] \
    || die 'Agent Zero container did not stay running after resume.'
  log 'Resumed the attested Agent Zero runtime.'
}

uninstall_runtime() {
  require_root
  local command
  for command in awk docker find realpath rm stat uname; do
    require_command "$command"
  done
  preflight_clean_uninstall

  local name names path references='' presence_status
  if uninstall_volume_present; then
    # Repeat the complete reference attestation immediately before the first
    # destructive operation, then remove only the exact names it approved.
    references="$(attested_uninstall_volume_references)"
  else
    presence_status=$?
    [[ $presence_status -eq 1 ]] \
      || die 'Could not re-enumerate Docker volumes before Agent Zero removal.'
  fi
  names="$(globally_discovered_agent_zero_container_names)" \
    || die 'Could not re-enumerate Agent Zero containers before removal.'
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    managed_container_uninstall_contract_ok "$name" \
      || die "Agent Zero container drifted after uninstall preflight: ${name}"
    docker rm --force "$name" >/dev/null \
      || die "Could not remove the attested Agent Zero container: ${name}"
  done <<<"$names"
  if uninstall_volume_present; then
    managed_volume_uninstall_contract_ok \
      || die 'Agent Zero data volume drifted after uninstall preflight.'
    docker volume rm "$A0_VOLUME" >/dev/null \
      || die 'Could not remove the exact managed Agent Zero data volume.'
  else
    presence_status=$?
    [[ $presence_status -eq 1 ]] \
      || die 'Could not re-enumerate Docker volumes before Agent Zero data-volume removal.'
  fi

  # Prove Docker convergence before deleting the only host-side recovery and
  # authentication material. A daemon failure here leaves the filesystem intact.
  names="$(globally_discovered_agent_zero_container_names)" \
    || die 'Could not verify Agent Zero container removal after Docker mutation.'
  [[ -z "$names" ]] \
    || die "Agent Zero container removal did not converge: ${names%%$'\n'*}"
  if uninstall_volume_present; then
    die 'Agent Zero data-volume removal did not converge.'
  else
    presence_status=$?
    [[ $presence_status -eq 1 ]] \
      || die 'Could not verify Agent Zero data-volume removal after Docker mutation.'
  fi

  if [[ -e "$A0_AUTH_FILE" || -L "$A0_AUTH_FILE" ]]; then
    managed_uninstall_path_ok "$A0_AUTH_FILE" "$A0_DEFAULT_AUTH_FILE" auth \
      || die 'Agent Zero auth file drifted after uninstall preflight.'
    rm -f -- "$A0_AUTH_FILE" \
      || die 'Could not remove the protected Agent Zero auth file.'
  fi
  for path in "$A0_STATE_DIR" "$A0_BACKUP_DIR"; do
    if [[ -e "$path" || -L "$path" ]]; then
      if [[ "$path" == "$A0_STATE_DIR" ]]; then
        managed_uninstall_path_ok "$path" '/var/lib/bridgesllm/agent-zero-runtime' directory \
          || die 'Agent Zero runtime state drifted after uninstall preflight.'
      else
        managed_uninstall_path_ok "$path" '/var/backups/bridgesllm/agent-zero' directory \
          || die 'Agent Zero backup state drifted after uninstall preflight.'
      fi
      rm -rf --one-file-system -- "$path" \
        || die "Could not remove the exact managed Agent Zero path: ${path}"
    fi
  done

  for path in "$A0_AUTH_FILE" "$A0_STATE_DIR" "$A0_BACKUP_DIR"; do
    [[ ! -e "$path" && ! -L "$path" ]] \
      || die "Agent Zero filesystem cleanup did not converge for: ${path}"
  done
  log 'Removed the attested Agent Zero runtime, protected auth, host bridge, data volume, state, and backups.'
}

usage() {
  cat <<'EOF'
Usage: agent-zero-runtime.sh <command>

Commands:
  status                Verify the runtime, connector, and official host bridge
  reconcile             Install/update runtime and immutable A0 host bridge
  rollback              Restore the previous container and data snapshot
  quiesce               Stop only attested managed containers and preserve data
  runtime-active        Print true/false for the attested primary container
  resume                Start the attested primary container if it is stopped
  uninstall             Remove only the attested managed runtime and all data
  credentials-reload    Reload an atomically replaced protected auth file
  host-bridge-status     Verify the immutable official A0 CLI v2.5 bridge
  host-bridge-reconcile  Install/update only the immutable A0 CLI v2.5 bridge
  host-bridge-rollback   Restore the previous A0 CLI host-bridge installation

Before reconcile, create /etc/bridgesllm/agent-zero.env as root with mode 600
and exactly one non-empty AUTH_LOGIN and AUTH_PASSWORD entry.
EOF
}

case "${1:-}" in
  status) status_runtime ;;
  reconcile) install_or_update ;;
  rollback) rollback_runtime ;;
  quiesce) quiesce_runtime ;;
  runtime-active) runtime_active ;;
  resume) resume_runtime ;;
  uninstall) uninstall_runtime ;;
  credentials-reload) reload_credentials ;;
  host-bridge-status) status_host_bridge ;;
  host-bridge-reconcile) install_or_update_host_bridge ;;
  host-bridge-rollback) rollback_host_bridge ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
