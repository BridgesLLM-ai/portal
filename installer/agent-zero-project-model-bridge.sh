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
readonly BRIDGE_RUNTIME_ROOT="${BRIDGE_STATE_ROOT}/runtime"
readonly BRIDGE_ENV_FILE='/etc/bridgesllm/agent-zero-project-model-bridge.env'
readonly BRIDGE_UNIT_FILE="/etc/systemd/system/${BRIDGE_SERVICE}"
readonly BRIDGE_SOURCE_ENTRYPOINT='/opt/bridgesllm/portal/backend/dist/agents/providers/agentZero/AgentZeroProjectModelBridge.js'
readonly BRIDGE_SOURCE_CREDENTIAL_MODULE='/opt/bridgesllm/portal/backend/dist/agents/providers/agentZero/AgentZeroProjectModelBridgeCredential.js'
readonly BRIDGE_RUNTIME_ENTRYPOINT_NAME='AgentZeroProjectModelBridge.js'
readonly BRIDGE_RUNTIME_CREDENTIAL_MODULE_NAME='AgentZeroProjectModelBridgeCredential.js'
readonly BRIDGE_RUNTIME_GENERATION_FILE="${BRIDGE_RUNTIME_ROOT}/active-generation"
readonly BRIDGE_RUNTIME_SOURCE_MAX_BYTES='524288'
readonly BRIDGE_RUNTIME_OWNER_UID='0'
readonly BRIDGE_RUNTIME_SOURCE_GID='0'
# Old content-addressed generations are deliberately retained. The bridge is
# converged before the wider updater transaction commits, so deleting the prior
# generation here could strand rollback or an already-running process. Each
# generation contains exactly two files capped at 512 KiB apiece; clean-slate
# uninstall removes the state tree. Any future GC needs updater-transaction and
# live-process authority rather than a best-effort lifecycle sweep.
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

root_protected_release_file() {
  local file="$1" mode size
  [[ -f "$file" && ! -L "$file" ]] || return 1
  mode="$(stat -c '%a' "$file")"
  size="$(stat -c '%s' "$file")"
  [[ "$(stat -c '%u:%g:%h' "$file")" == '0:0:1' \
    && "$size" =~ ^[0-9]+$ \
    && "$size" -gt 0 \
    && "$size" -le "$BRIDGE_RUNTIME_SOURCE_MAX_BYTES" ]] \
    || return 1
  (( (8#${mode} & 0022) == 0 ))
}

bridge_runtime_sources_ready() {
  root_protected_release_file "$BRIDGE_SOURCE_ENTRYPOINT" \
    && root_protected_release_file "$BRIDGE_SOURCE_CREDENTIAL_MODULE"
}

ensure_managed_directory() {
  local directory="$1" mode="$2" owner="$3" group="$4"
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] \
      || die "Managed bridge directory is linked or not a directory: ${directory}"
  fi
  install -d -m "$mode" -o "$owner" -g "$group" "$directory"
  [[ "$(stat -c '%U:%G:%a' "$directory")" == "${owner}:${group}:${mode#0}" ]] \
    || die "Managed bridge directory has unsafe ownership or mode: ${directory}"
}

bridge_runtime_contract() {
  local mode="$1"
  python3 - \
    "$mode" \
    "$BRIDGE_GROUP" \
    "$BRIDGE_RUNTIME_ROOT" \
    "$BRIDGE_RUNTIME_GENERATION_FILE" \
    "$BRIDGE_RUNTIME_SOURCE_MAX_BYTES" \
    "$BRIDGE_RUNTIME_OWNER_UID" \
    "$BRIDGE_RUNTIME_SOURCE_GID" \
    "$BRIDGE_SOURCE_ENTRYPOINT" "$BRIDGE_RUNTIME_ENTRYPOINT_NAME" \
    "$BRIDGE_SOURCE_CREDENTIAL_MODULE" "$BRIDGE_RUNTIME_CREDENTIAL_MODULE_NAME" <<'PY'
import grp
import hashlib
import os
import re
import secrets
import stat
import sys

(
    mode,
    group_name,
    runtime_root,
    generation_file,
    max_bytes_raw,
    owner_uid_raw,
    source_gid_raw,
    *path_values,
) = sys.argv[1:]
if mode not in {"stage", "activate", "verify", "active-root"} or len(path_values) != 4:
    raise SystemExit("invalid bridge runtime convergence arguments")
if not hasattr(os, "O_NOFOLLOW"):
    raise SystemExit("bridge runtime convergence requires O_NOFOLLOW")

max_bytes = int(max_bytes_raw)
owner_uid = int(owner_uid_raw)
source_gid = int(source_gid_raw)
group_gid = grp.getgrnam(group_name).gr_gid
pairs = [
    (path_values[0], path_values[1]),
    (path_values[2], path_values[3]),
]
leaves = [leaf for _, leaf in pairs]
if (
    len(set(leaves)) != len(leaves)
    or any(os.path.basename(leaf) != leaf for leaf in leaves)
    or any(not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", leaf) for leaf in leaves)
):
    raise RuntimeError("bridge runtime filenames are invalid")

def file_identity(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )

def directory_identity(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
    )

def read_descriptor(descriptor, limit):
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(65536, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise RuntimeError("bridge runtime file exceeds its bounded size")
    return b"".join(chunks)

def validate_regular(metadata, expected_uid, expected_gid, expected_mode, label):
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != expected_uid
        or metadata.st_gid != expected_gid
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or metadata.st_size < 0
        or metadata.st_size > max_bytes
    ):
        raise RuntimeError(f"{label} is unsafe")

def read_regular_at(parent_descriptor, leaf, expected_uid, expected_gid, expected_mode, label):
    metadata = os.stat(leaf, dir_fd=parent_descriptor, follow_symlinks=False)
    validate_regular(metadata, expected_uid, expected_gid, expected_mode, label)
    descriptor = os.open(
        leaf,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
        dir_fd=parent_descriptor,
    )
    try:
        opened = os.fstat(descriptor)
        if file_identity(opened) != file_identity(metadata):
            raise RuntimeError(f"{label} changed before open")
        content = read_descriptor(descriptor, max_bytes)
        if file_identity(os.fstat(descriptor)) != file_identity(opened):
            raise RuntimeError(f"{label} changed while reading")
    finally:
        os.close(descriptor)
    if file_identity(os.stat(leaf, dir_fd=parent_descriptor, follow_symlinks=False)) \
            != file_identity(metadata):
        raise RuntimeError(f"{label} changed after reading")
    return metadata, content

def write_staged_file(parent_descriptor, leaf, content):
    descriptor = os.open(
        leaf,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=parent_descriptor,
    )
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise RuntimeError("could not write managed bridge runtime")
            view = view[written:]
        os.fsync(descriptor)
        os.fchown(descriptor, owner_uid, group_gid)
        os.fchmod(descriptor, 0o640)
        os.fsync(descriptor)
        metadata = os.fstat(descriptor)
        validate_regular(metadata, owner_uid, group_gid, 0o640, "staged bridge runtime file")
        if metadata.st_size != len(content):
            raise RuntimeError("staged bridge runtime file has the wrong size")
    finally:
        os.close(descriptor)

runtime_path = os.path.abspath(runtime_root)
generation_path = os.path.abspath(generation_file)
if os.path.dirname(generation_path) != runtime_path \
        or os.path.basename(generation_path) != "active-generation":
    raise RuntimeError("bridge runtime generation receipt escaped its managed directory")
runtime_metadata = os.lstat(runtime_path)
if (
    not stat.S_ISDIR(runtime_metadata.st_mode)
    or stat.S_ISLNK(runtime_metadata.st_mode)
    or runtime_metadata.st_uid != owner_uid
    or runtime_metadata.st_gid != group_gid
    or stat.S_IMODE(runtime_metadata.st_mode) != 0o750
):
    raise RuntimeError("bridge runtime directory is unsafe")

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
runtime_descriptor = os.open(runtime_path, directory_flags)
temporary_files = []
temporary_directories = []
try:
    if directory_identity(os.fstat(runtime_descriptor)) != directory_identity(runtime_metadata):
        raise RuntimeError("bridge runtime directory changed before use")

    sources = []
    for source, leaf in pairs:
        source_metadata = os.lstat(source)
        if (
            not stat.S_ISREG(source_metadata.st_mode)
            or stat.S_ISLNK(source_metadata.st_mode)
            or source_metadata.st_uid != owner_uid
            or source_metadata.st_gid != source_gid
            or source_metadata.st_nlink != 1
            or stat.S_IMODE(source_metadata.st_mode) & 0o022
            or source_metadata.st_size <= 0
            or source_metadata.st_size > max_bytes
        ):
            raise RuntimeError("compiled bridge runtime source is unsafe")
        source_descriptor = os.open(
            source,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
        try:
            opened_metadata = os.fstat(source_descriptor)
            if file_identity(opened_metadata) != file_identity(source_metadata):
                raise RuntimeError("compiled bridge runtime source changed before open")
            content = read_descriptor(source_descriptor, max_bytes)
            if file_identity(os.fstat(source_descriptor)) != file_identity(opened_metadata):
                raise RuntimeError("compiled bridge runtime source changed while reading")
        finally:
            os.close(source_descriptor)
        if file_identity(os.lstat(source)) != file_identity(source_metadata):
            raise RuntimeError("compiled bridge runtime source changed after reading")
        sources.append((leaf, content))

    generation_hash = hashlib.sha256(b"bridgesllm-agent-zero-bridge-runtime-v1\0")
    for leaf, content in sources:
        generation_hash.update(leaf.encode("ascii"))
        generation_hash.update(b"\0")
        generation_hash.update(len(content).to_bytes(8, "big"))
        generation_hash.update(content)
    desired_generation = f"generation-{generation_hash.hexdigest()}"

    def verify_generation(generation, expected_sources=None):
        metadata = os.stat(generation, dir_fd=runtime_descriptor, follow_symlinks=False)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != owner_uid
            or metadata.st_gid != group_gid
            or stat.S_IMODE(metadata.st_mode) != 0o750
        ):
            raise RuntimeError("managed bridge runtime generation is unsafe")
        descriptor = os.open(generation, directory_flags, dir_fd=runtime_descriptor)
        try:
            if directory_identity(os.fstat(descriptor)) != directory_identity(metadata):
                raise RuntimeError("managed bridge runtime generation changed before open")
            if sorted(os.listdir(descriptor)) != sorted(leaves):
                raise RuntimeError("managed bridge runtime generation has unexpected members")
            observed = []
            for leaf in leaves:
                _, content = read_regular_at(
                    descriptor,
                    leaf,
                    owner_uid,
                    group_gid,
                    0o640,
                    "managed bridge runtime generation file",
                )
                observed.append((leaf, content))
            if directory_identity(os.stat(generation, dir_fd=runtime_descriptor, follow_symlinks=False)) \
                    != directory_identity(metadata):
                raise RuntimeError("managed bridge runtime generation changed while reading")
        finally:
            os.close(descriptor)
        if expected_sources is not None and observed != expected_sources:
            raise RuntimeError("managed bridge runtime generation does not match the verified release")

    try:
        verify_generation(desired_generation, sources)
    except FileNotFoundError:
        if mode != "stage":
            raise RuntimeError("managed bridge runtime generation is missing")
        temporary = f".generation.tmp.{secrets.token_hex(16)}"
        temporary_directories.append(temporary)
        os.mkdir(temporary, 0o700, dir_fd=runtime_descriptor)
        descriptor = os.open(temporary, directory_flags, dir_fd=runtime_descriptor)
        try:
            os.fchown(descriptor, owner_uid, group_gid)
            for leaf, content in sources:
                write_staged_file(descriptor, leaf, content)
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o750)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.rename(
            temporary,
            desired_generation,
            src_dir_fd=runtime_descriptor,
            dst_dir_fd=runtime_descriptor,
        )
        temporary_directories.remove(temporary)
        os.fsync(runtime_descriptor)
        verify_generation(desired_generation, sources)

    def read_generation_receipt(required):
        try:
            _, content = read_regular_at(
                runtime_descriptor,
                "active-generation",
                owner_uid,
                group_gid,
                0o640,
                "bridge runtime generation receipt",
            )
        except FileNotFoundError:
            if required:
                raise RuntimeError("bridge runtime generation receipt is missing")
            return None
        try:
            receipt = content.decode("ascii")
        except UnicodeDecodeError as error:
            raise RuntimeError("bridge runtime generation receipt is malformed") from error
        if not re.fullmatch(r"generation-[a-f0-9]{64}\n", receipt):
            raise RuntimeError("bridge runtime generation receipt is malformed")
        return receipt.rstrip("\n")

    if mode == "activate":
        current_generation = read_generation_receipt(required=False)
        if current_generation is not None:
            verify_generation(current_generation)
        if current_generation != desired_generation:
            temporary = f".active-generation.tmp.{secrets.token_hex(16)}"
            temporary_files.append(temporary)
            write_staged_file(
                runtime_descriptor,
                temporary,
                f"{desired_generation}\n".encode("ascii"),
            )
            os.replace(
                temporary,
                "active-generation",
                src_dir_fd=runtime_descriptor,
                dst_dir_fd=runtime_descriptor,
            )
            temporary_files.remove(temporary)
            os.fsync(runtime_descriptor)
    elif mode in {"verify", "active-root"}:
        if read_generation_receipt(required=True) != desired_generation:
            raise RuntimeError("bridge runtime generation receipt is stale")

    if mode in {"activate", "verify", "active-root"}:
        if read_generation_receipt(required=True) != desired_generation:
            raise RuntimeError("bridge runtime generation receipt did not converge")
        verify_generation(desired_generation, sources)

    if mode in {"stage", "active-root"}:
        print(os.path.join(runtime_path, desired_generation))
finally:
    for temporary in temporary_files:
        try:
            os.unlink(temporary, dir_fd=runtime_descriptor)
        except FileNotFoundError:
            pass
    for temporary in temporary_directories:
        try:
            descriptor = os.open(temporary, directory_flags, dir_fd=runtime_descriptor)
        except FileNotFoundError:
            continue
        try:
            for leaf in os.listdir(descriptor):
                os.unlink(leaf, dir_fd=descriptor)
        finally:
            os.close(descriptor)
        os.rmdir(temporary, dir_fd=runtime_descriptor)
    os.close(runtime_descriptor)

if directory_identity(os.lstat(runtime_path)) != directory_identity(runtime_metadata):
    raise RuntimeError("bridge runtime directory changed during convergence")
PY
}

publish_bridge_runtime() {
  local staged_root active_root
  staged_root="$(bridge_runtime_contract stage)" || return 1
  bridge_runtime_service_user_check "$staged_root" || return 1
  bridge_runtime_contract activate || return 1
  active_root="$(bridge_runtime_contract active-root)" || return 1
  [[ "$active_root" == "$staged_root" ]]
}

bridge_runtime_service_user_check() {
  local staged_root="$1"
  runuser --user "$BRIDGE_USER" -- \
    /usr/bin/node --check "${staged_root}/${BRIDGE_RUNTIME_ENTRYPOINT_NAME}" >/dev/null \
    || return 1
  runuser --user "$BRIDGE_USER" -- \
    /usr/bin/node --check "${staged_root}/${BRIDGE_RUNTIME_CREDENTIAL_MODULE_NAME}" >/dev/null \
    || return 1
}

bridge_runtime_active_root() {
  bridge_runtime_contract active-root
}

bridge_runtime_ready() {
  bridge_runtime_sources_ready \
    && bridge_runtime_contract verify
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
  ensure_managed_directory "$BRIDGE_STATE_ROOT" 0750 root "$BRIDGE_GROUP"
  ensure_managed_directory "$BRIDGE_CREDENTIAL_ROOT" 2750 root "$BRIDGE_GROUP"
  ensure_managed_directory "$BRIDGE_RUNTIME_ROOT" 0750 root "$BRIDGE_GROUP"
  ensure_managed_directory /etc/bridgesllm 0750 root root
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
  local temporary="${BRIDGE_UNIT_FILE}.tmp.$$" active_root runtime_entrypoint
  active_root="$(bridge_runtime_active_root)" \
    || die 'Active Agent Zero Project model bridge runtime could not be resolved.'
  runtime_entrypoint="${active_root}/${BRIDGE_RUNTIME_ENTRYPOINT_NAME}"
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
ExecStart=/usr/bin/node ${runtime_entrypoint}
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

bridge_unit_runtime_ready() {
  local active_root expected
  root_protected_file "$BRIDGE_UNIT_FILE" 644 || return 1
  active_root="$(bridge_runtime_active_root)" || return 1
  expected="ExecStart=/usr/bin/node ${active_root}/${BRIDGE_RUNTIME_ENTRYPOINT_NAME}"
  [[ "$(grep -Fxc -- "$expected" "$BRIDGE_UNIT_FILE")" == '1' ]]
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
  for command in curl getent groupadd id install node python3 runuser seq sleep stat systemctl useradd; do
    require_command "$command"
  done
  ensure_identity_and_directories
  bridge_runtime_sources_ready \
    || die 'Compiled Agent Zero Project model bridge runtime is missing or unsafe.'
  publish_bridge_runtime \
    || die 'Compiled Agent Zero Project model bridge runtime could not be published safely.'
  bridge_runtime_ready \
    || die 'Published Agent Zero Project model bridge runtime is missing or unsafe.'
  ensure_bridge_environment
  write_systemd_unit
  bridge_unit_runtime_ready \
    || die 'Agent Zero Project model bridge service unit did not bind the active runtime generation.'
  systemctl daemon-reload
  systemctl enable "$BRIDGE_SERVICE" >/dev/null
  systemctl restart "$BRIDGE_SERVICE"
  wait_bridge_http_ready \
    || die 'Agent Zero Project model bridge failed its fail-closed HTTP readiness check.'
  log 'Installed the managed Agent Zero Project model bridge in fail-closed mode.'
}

status_bridge() {
  require_root
  for command in curl docker getent groupadd id install python3 stat systemctl useradd; do
    require_command "$command"
  done
  ensure_identity_and_directories
  read_env_token >/dev/null
  assert_agent_zero_upstream
  bridge_runtime_ready \
    || die 'Published Agent Zero Project model bridge runtime is missing, stale, or unsafe.'
  bridge_unit_runtime_ready \
    || die 'Agent Zero Project model bridge service is not bound to the active runtime generation.'
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
