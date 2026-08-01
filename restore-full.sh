#!/usr/bin/env bash
# BridgesLLM Portal root-only offline restore transaction.
#
# Usage:
#   restore-full.sh --verify-archive /absolute/portal-comprehensive-....tar.gz
#   restore-full.sh --restore /absolute/portal-comprehensive-....tar.gz
#   restore-full.sh --recover

set -Eeuo pipefail
umask 077

PORTAL_DIR="${PORTAL_ROOT:-/opt/bridgesllm/portal}"
PORTAL_ENV_FILE="${PORTAL_DIR}/backend/.env.production"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
AUTHORITY_ROOT="${SCRIPT_DIR}"
BACKUP_SCRIPT="${AUTHORITY_ROOT}/backup-full.sh"
ARCHIVE_HELPER="${AUTHORITY_ROOT}/installer/portal-recovery-archive.py"
STATE_ROOT="${BRIDGESLLM_RESTORE_STATE_ROOT:-/var/lib/bridgesllm-restore}"
TRANSACTIONS_ROOT="${STATE_ROOT}/transactions"
ACTIVE_JOURNAL="${STATE_ROOT}/active-restore.json"
RECOVERY_LAUNCHER="${STATE_ROOT}/recover-current"
DATABASE_EXCLUSION_FILE=""
OPERATION_LOCK="${BRIDGESLLM_PORTAL_OPERATION_LOCK:-/run/lock/bridgesllm-portal-installer.lock}"
BACKUP_RECOVERY_STATE_DIR="${BRIDGESLLM_BACKUP_RECOVERY_STATE_DIR:-/var/lib/bridgesllm/backup-recovery}"
PENDING_BACKUP_QUIESCENCE="${BACKUP_RECOVERY_STATE_DIR}/quiescence.json"
RESTORE_TRUST_ROOT="${BRIDGESLLM_RESTORE_TRUST_ROOT:-/var/lib/bridgesllm/backup-trust}"
RESTORE_HMAC_KEY="${RESTORE_TRUST_ROOT}/archive-hmac.key"
INSTALLER_STATE_ROOT="${BRIDGESLLM_RESTORE_INSTALLER_STATE_ROOT:-/var/lib/bridgesllm-installer}"
PENDING_UPDATE_JOURNAL="${INSTALLER_STATE_ROOT}/active-update.json"
PENDING_CUTOVER_JOURNAL="${INSTALLER_STATE_ROOT}/cutover-update.json"
PENDING_UNINSTALL_JOURNAL="${INSTALLER_STATE_ROOT}/uninstall/active-uninstall.json"
SYSTEMD_ROOT="${BRIDGESLLM_RESTORE_SYSTEMD_ROOT:-/etc/systemd/system}"
BOOT_FENCE_NAME="30-restore-transaction-fence.conf"
RESTORE_UNITS=(
  bridgesllm-product.service
  openclaw-gateway.service
  stalwart-mail.service
  stalwart-cert-sync.service
  stalwart-cert-sync.path
  stalwart-cert-sync.timer
)
RESTORE_PORT="${BRIDGESLLM_RESTORE_VALIDATION_PORT:-4198}"
RESERVE_BYTES="${BRIDGESLLM_RESTORE_RESERVE_BYTES:-1073741824}"
RESTORE_SYSTEMCTL_BIN="/usr/bin/systemctl"
RESTORE_DOCKER_BIN="/usr/bin/docker"
RESTORE_SYSTEMD_RUN_BIN="/usr/bin/systemd-run"
RESTORE_CURL_BIN="/usr/bin/curl"
RESTORE_PG_DUMP_BIN="/usr/bin/pg_dump"
RESTORE_PG_RESTORE_BIN="/usr/bin/pg_restore"
RESTORE_PSQL_BIN="/usr/bin/psql"
RESTORE_INITDB_BIN="/usr/lib/postgresql/16/bin/initdb"
RESTORE_POSTGRES_BIN="/usr/lib/postgresql/16/bin/postgres"
RESTORE_NPX_BIN="/usr/bin/npx"

TRANSACTION_ID=""
TRANSACTION_DIR=""
ADMISSION_FILE=""
ARCHIVE=""
RECOVERY_ACTIVE=false
PREAUTH_ARCHIVE_IDENTITY=""
unset RESTORE_OPERATION_NONCE
unset RESTORE_OPERATION_NONCE_SUPPLIED
unset RESTORE_PHASE_GATE_DIR
unset RESTORE_PHASE_GATE
unset RESTORE_PHASE_GATE_IDENTITY
RESTORE_OPERATION_NONCE=""
RESTORE_OPERATION_NONCE_SUPPLIED=false
RESTORE_PHASE_GATE_DIR=""
RESTORE_PHASE_GATE=""
RESTORE_PHASE_GATE_IDENTITY=""

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Offline restore must run as root"
}

valid_restore_phase_gate_phase() {
  case "$1" in
    prepared|fenced|quiesced|database_exclusion_pending|database_excluded|\
    staging_pending|staged|rollback_snapshot_pending|\
    rollback_snapshot_complete|database_restore_pending|database_restored|\
    files_restore_pending|files_restored|openclaw_restore_pending|\
    openclaw_restored|stalwart_restore_pending|stalwart_restored|\
    migration_pending|migrated|verification_pending|verified|committed|\
    committed_exclusion_release_pending|committed_exclusion_released)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_restore_phase_gate_directory() {
  local directory="$1" nonce="$2" phase="$3"
  [[ "${directory}" == /* && "${nonce}" =~ ^[a-f0-9]{64}$ ]] || return 1
  valid_restore_phase_gate_phase "${phase}" || return 1
  python3 - "${directory}" 3<<<"${nonce}" 4<<<"${phase}" <<'PY'
import json
import os
import pathlib
import stat
import sys

directory = sys.argv[1]
nonce = os.fdopen(3, "r", encoding="ascii").read().strip()
phase = os.fdopen(4, "r", encoding="ascii").read().strip()
if (
    os.geteuid() != 0
    or not os.path.isabs(directory)
    or os.path.normpath(directory) != directory
    or os.path.realpath(directory) != directory
):
    raise SystemExit(1)
if (
    len(nonce) != 64
    or any(character not in "0123456789abcdef" for character in nonce)
):
    raise SystemExit(1)
allowed_phases = {
    "prepared",
    "fenced",
    "quiesced",
    "database_exclusion_pending",
    "database_excluded",
    "staging_pending",
    "staged",
    "rollback_snapshot_pending",
    "rollback_snapshot_complete",
    "database_restore_pending",
    "database_restored",
    "files_restore_pending",
    "files_restored",
    "openclaw_restore_pending",
    "openclaw_restored",
    "stalwart_restore_pending",
    "stalwart_restored",
    "migration_pending",
    "migrated",
    "verification_pending",
    "verified",
    "committed",
    "committed_exclusion_release_pending",
    "committed_exclusion_released",
}
if phase not in allowed_phases:
    raise SystemExit(1)

current = pathlib.Path("/")
for component in pathlib.Path(directory).parts[1:]:
    current /= component
    info = os.lstat(current)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or (
            info.st_mode & 0o022
            and not (
                current == pathlib.Path("/tmp")
                and stat.S_IMODE(info.st_mode) == 0o1777
            )
        )
    ):
        raise SystemExit(1)

flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | os.O_NOFOLLOW
)
descriptor = os.open(directory, flags)
try:
    info = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise SystemExit(1)
    if set(os.listdir(descriptor)) != {"binding.json"}:
        raise SystemExit(1)
    binding_descriptor = os.open(
        "binding.json",
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        dir_fd=descriptor,
    )
    try:
        binding_info = os.fstat(binding_descriptor)
        if (
            not stat.S_ISREG(binding_info.st_mode)
            or binding_info.st_uid != 0
            or binding_info.st_gid != 0
            or binding_info.st_nlink != 1
            or stat.S_IMODE(binding_info.st_mode) != 0o600
            or binding_info.st_size <= 0
            or binding_info.st_size > 4096
        ):
            raise SystemExit(1)
        with os.fdopen(
            binding_descriptor, "r", encoding="utf-8", closefd=False
        ) as handle:
            binding = json.load(handle)
    finally:
        os.close(binding_descriptor)
    expected = {
        "schema": "bridgesllm.restore-phase-gate-binding.v1",
        "operationNonce": nonce,
        "phase": phase,
    }
    if binding != expected:
        raise SystemExit(1)
    print(f"{info.st_dev}:{info.st_ino}")
finally:
    os.close(descriptor)
PY
}

enter_private_mount_namespace() {
  local self_namespace init_namespace token parent_namespace
  local requested_nonce="" requested_gate_dir="" requested_gate_phase=""
  local nonce_supplied=false gate_dir_supplied=false gate_phase_supplied=false
  if [[ -n "${BRIDGESLLM_RESTORE_OPERATION_NONCE+x}" ]]; then
    nonce_supplied=true
    requested_nonce="${BRIDGESLLM_RESTORE_OPERATION_NONCE}"
  fi
  if [[ -n "${BRIDGESLLM_RESTORE_PHASE_GATE_DIR+x}" ]]; then
    gate_dir_supplied=true
    requested_gate_dir="${BRIDGESLLM_RESTORE_PHASE_GATE_DIR}"
  fi
  if [[ -n "${BRIDGESLLM_RESTORE_PHASE_GATE+x}" ]]; then
    gate_phase_supplied=true
    requested_gate_phase="${BRIDGESLLM_RESTORE_PHASE_GATE}"
  fi
  unset BRIDGESLLM_RESTORE_OPERATION_NONCE
  unset BRIDGESLLM_RESTORE_PHASE_GATE_DIR
  unset BRIDGESLLM_RESTORE_PHASE_GATE
  case "${1:-}" in
    --restore)
      if [[ "${gate_dir_supplied}" == "true" \
        || "${gate_phase_supplied}" == "true" ]]; then
        [[ "${nonce_supplied}" == "true" \
          && "${gate_dir_supplied}" == "true" \
          && "${gate_phase_supplied}" == "true" ]] || return 1
      fi
      if [[ "${nonce_supplied}" == "true" ]]; then
        [[ "${requested_nonce}" =~ ^[a-f0-9]{64}$ ]] || return 1
      fi
      ;;
    --recover)
      [[ "${nonce_supplied}" == "false" \
        && "${gate_dir_supplied}" == "false" \
        && "${gate_phase_supplied}" == "false" ]] || return 1
      ;;
    *)
      return 1
      ;;
  esac
  self_namespace="$(readlink /proc/self/ns/mnt 2>/dev/null)" || return 1
  init_namespace="$(readlink /proc/1/ns/mnt 2>/dev/null)" || return 1
  token="${BRIDGESLLM_RESTORE_PRIVATE_MOUNT_TOKEN:-}"
  parent_namespace="${BRIDGESLLM_RESTORE_PARENT_MOUNT_NAMESPACE:-}"
  if [[ -n "${token}" || -n "${parent_namespace}" ]]; then
    [[ "${token}" =~ ^[a-f0-9]{64}$ \
      && "${parent_namespace}" =~ ^mnt:\[[0-9]+\]$ \
      && "${parent_namespace}" == "${init_namespace}" \
      && "${self_namespace}" != "${parent_namespace}" \
      && "${self_namespace}" != "${init_namespace}" ]] || return 1
    unset BRIDGESLLM_RESTORE_PRIVATE_MOUNT_TOKEN
    unset BRIDGESLLM_RESTORE_PARENT_MOUNT_NAMESPACE
    if [[ "${1}" == "--restore" ]]; then
      if [[ "${nonce_supplied}" == "true" ]]; then
        RESTORE_OPERATION_NONCE="${requested_nonce}"
        RESTORE_OPERATION_NONCE_SUPPLIED=true
      else
        RESTORE_OPERATION_NONCE="$(openssl rand -hex 32)" || return 1
        [[ "${RESTORE_OPERATION_NONCE}" =~ ^[a-f0-9]{64}$ ]] || return 1
        RESTORE_OPERATION_NONCE_SUPPLIED=false
      fi
      if [[ "${gate_dir_supplied}" == "true" ]]; then
        RESTORE_PHASE_GATE_DIR="${requested_gate_dir}"
        RESTORE_PHASE_GATE="${requested_gate_phase}"
        RESTORE_PHASE_GATE_IDENTITY="$(
          validate_restore_phase_gate_directory \
            "${RESTORE_PHASE_GATE_DIR}" "${RESTORE_OPERATION_NONCE}" \
            "${RESTORE_PHASE_GATE}"
        )" || return 1
        [[ "${RESTORE_PHASE_GATE_IDENTITY}" =~ ^[0-9]+:[0-9]+$ ]] \
          || return 1
      fi
    fi
    python3 - /proc/self/mountinfo "${self_namespace}" "$$" <<'PY'
import os
import pathlib
import sys

mountinfo, expected_namespace, shell_pid_raw = sys.argv[1:]
shell_pid = int(shell_pid_raw)
if os.readlink("/proc/self/ns/mnt") != expected_namespace:
    raise SystemExit(1)
for line in open(mountinfo, "r", encoding="utf-8"):
    fields = line.split()
    try:
        separator = fields.index("-")
    except ValueError:
        raise SystemExit(1)
    optional = fields[6:separator]
    if any(
        item.startswith(("shared:", "master:", "propagate_from:"))
        for item in optional
    ):
        raise SystemExit(1)
for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdigit():
        continue
    pid = int(entry.name)
    if pid in {os.getpid(), shell_pid}:
        continue
    try:
        namespace = os.readlink(entry / "ns/mnt")
    except OSError:
        continue
    if namespace == expected_namespace:
        raise SystemExit(1)
PY
    return
  fi
  [[ -z "${token}" && -z "${parent_namespace}" ]] || return 1
  [[ "${self_namespace}" == "${init_namespace}" ]] || return 1
  python3 - <<'PY' || return 1
import os
import pathlib
import stat

flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | os.O_NOFOLLOW
)
root = os.open("/", flags)
host = os.open("/proc/1/root/.", flags)
try:
    root_info = os.fstat(root)
    host_info = os.fstat(host)
    def mount_id(descriptor):
        values = [
            line.partition(":")[2].strip()
            for line in pathlib.Path(
                f"/proc/self/fdinfo/{descriptor}"
            ).read_text(encoding="ascii").splitlines()
            if line.startswith("mnt_id:")
        ]
        if len(values) != 1 or not values[0].isdigit():
            raise SystemExit(1)
        return int(values[0])
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or not stat.S_ISDIR(host_info.st_mode)
        or (root_info.st_dev, root_info.st_ino)
            != (host_info.st_dev, host_info.st_ino)
        or mount_id(root) != mount_id(host)
    ):
        raise SystemExit(1)
finally:
    os.close(root)
    os.close(host)
PY
  [[ -x /usr/bin/unshare && -f /usr/bin/unshare && ! -L /usr/bin/unshare \
    && "$(stat -c '%u:%g' /usr/bin/unshare 2>/dev/null)" == "0:0" \
    && $((8#$(stat -c '%a' /usr/bin/unshare) & 0022)) -eq 0 ]] || return 1
  token="$(openssl rand -hex 32)" || return 1
  [[ "${token}" =~ ^[a-f0-9]{64}$ ]] || return 1
  if [[ "${gate_dir_supplied}" == "true" ]]; then
    validate_restore_phase_gate_directory \
      "${requested_gate_dir}" "${requested_nonce}" "${requested_gate_phase}" \
      >/dev/null || return 1
    BRIDGESLLM_RESTORE_OPERATION_NONCE="${requested_nonce}" \
    BRIDGESLLM_RESTORE_PHASE_GATE_DIR="${requested_gate_dir}" \
    BRIDGESLLM_RESTORE_PHASE_GATE="${requested_gate_phase}" \
    BRIDGESLLM_RESTORE_PRIVATE_MOUNT_TOKEN="${token}" \
    BRIDGESLLM_RESTORE_PARENT_MOUNT_NAMESPACE="${self_namespace}" \
      exec /usr/bin/unshare --mount --propagation private -- \
        /bin/bash "${BASH_SOURCE[0]}" "$@"
  fi
  if [[ "${1}" == "--restore" ]]; then
    if [[ "${nonce_supplied}" == "true" ]]; then
      BRIDGESLLM_RESTORE_OPERATION_NONCE="${requested_nonce}" \
      BRIDGESLLM_RESTORE_PRIVATE_MOUNT_TOKEN="${token}" \
      BRIDGESLLM_RESTORE_PARENT_MOUNT_NAMESPACE="${self_namespace}" \
        exec /usr/bin/unshare --mount --propagation private -- \
          /bin/bash "${BASH_SOURCE[0]}" "$@"
    fi
    BRIDGESLLM_RESTORE_PRIVATE_MOUNT_TOKEN="${token}" \
    BRIDGESLLM_RESTORE_PARENT_MOUNT_NAMESPACE="${self_namespace}" \
      exec /usr/bin/unshare --mount --propagation private -- \
        /bin/bash "${BASH_SOURCE[0]}" "$@"
  fi
  BRIDGESLLM_RESTORE_PRIVATE_MOUNT_TOKEN="${token}" \
  BRIDGESLLM_RESTORE_PARENT_MOUNT_NAMESPACE="${self_namespace}" \
    exec /usr/bin/unshare --mount --propagation private -- \
      /bin/bash "${BASH_SOURCE[0]}" "$@"
}

# Service and container lifecycle commands may be redirected ONLY into a
# sealed validator fixture: the fixture root must match the attested test
# pattern, every configurable path must live inside it, and each override
# must be a root-owned 0700 regular executable inside the same fixture. This
# is the boundary that keeps a validator run from ever stopping host
# services.
configure_restore_test_commands() {
  local test_root="${BRIDGESLLM_RESTORE_TEST_ROOT:-}"
  local requested_systemctl="${BRIDGESLLM_RESTORE_SYSTEMCTL_BIN:-}"
  local requested_docker="${BRIDGESLLM_RESTORE_DOCKER_BIN:-}"
  local requested_systemd_run="${BRIDGESLLM_RESTORE_SYSTEMD_RUN_BIN:-}"
  local requested_curl="${BRIDGESLLM_RESTORE_CURL_BIN:-}"
  local requested_pg_dump="${BRIDGESLLM_RESTORE_PG_DUMP_BIN:-}"
  local requested_pg_restore="${BRIDGESLLM_RESTORE_PG_RESTORE_BIN:-}"
  local requested_psql="${BRIDGESLLM_RESTORE_PSQL_BIN:-}"
  local requested_initdb="${BRIDGESLLM_RESTORE_INITDB_BIN:-}"
  local requested_postgres="${BRIDGESLLM_RESTORE_POSTGRES_BIN:-}"
  local requested_npx="${BRIDGESLLM_RESTORE_NPX_BIN:-}"
  local requested_installer_state_root="${BRIDGESLLM_RESTORE_INSTALLER_STATE_ROOT:-}"
  local requested_trust_root="${BRIDGESLLM_RESTORE_TRUST_ROOT:-}"
  if [[ -z "${test_root}" ]]; then
    [[ -z "${requested_systemctl}" && -z "${requested_docker}" \
      && -z "${requested_systemd_run}" && -z "${requested_curl}" \
      && -z "${requested_pg_dump}" && -z "${requested_pg_restore}" \
      && -z "${requested_psql}" && -z "${requested_initdb}" \
      && -z "${requested_postgres}" && -z "${requested_npx}" \
      && -z "${requested_installer_state_root}" \
      && -z "${requested_trust_root}" ]] \
      || die "restore command overrides require an attested test root"
    return
  fi
  [[ ( "${test_root}" == /root/bridgesllm-installer-data-test-*/restore-fixture \
      || "${test_root}" =~ ^/4[A-Za-z0-9]{3}$ ) \
    && "${test_root}" == "$(realpath -e -- "${test_root}" 2>/dev/null)" ]] \
    || die "restore test root is not an attested validator fixture"
  local path
  for path in \
    "${PORTAL_DIR}" "${STATE_ROOT}" "${OPERATION_LOCK}" "${SYSTEMD_ROOT}" \
    "${BACKUP_RECOVERY_STATE_DIR}" "${INSTALLER_STATE_ROOT}" \
    "${RESTORE_TRUST_ROOT}"; do
    [[ "${path}" == "$(realpath -m -- "${path}" 2>/dev/null)" \
      && ( "${path}" == "${test_root}" || "${path}" == "${test_root}/"* ) ]] \
      || die "restore test path escaped its fixture root: ${path}"
  done
  local command_path
  for command_path in \
    "${requested_systemctl}" "${requested_docker}" "${requested_systemd_run}" \
    "${requested_curl}" "${requested_pg_dump}" "${requested_pg_restore}" \
    "${requested_psql}" "${requested_initdb}" "${requested_postgres}" \
    "${requested_npx}"; do
    [[ -n "${command_path}" && "${command_path}" == "${test_root}/"* \
      && -f "${command_path}" && ! -L "${command_path}" && -x "${command_path}" \
      && "$(stat -c '%u:%g:%a' "${command_path}" 2>/dev/null)" == '0:0:700' ]] \
      || die "restore test command is not a sealed fixture executable"
  done
  RESTORE_SYSTEMCTL_BIN="${requested_systemctl}"
  RESTORE_DOCKER_BIN="${requested_docker}"
  RESTORE_SYSTEMD_RUN_BIN="${requested_systemd_run}"
  RESTORE_CURL_BIN="${requested_curl}"
  RESTORE_PG_DUMP_BIN="${requested_pg_dump}"
  RESTORE_PG_RESTORE_BIN="${requested_pg_restore}"
  RESTORE_PSQL_BIN="${requested_psql}"
  RESTORE_INITDB_BIN="${requested_initdb}"
  RESTORE_POSTGRES_BIN="${requested_postgres}"
  RESTORE_NPX_BIN="${requested_npx}"
}

configure_restore_test_commands

if [[ -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]]; then
  RESTORE_VALIDATION_RUNTIME_ROOT="${BRIDGESLLM_RESTORE_TEST_ROOT}/validation-runtime"
  RESTORE_VALIDATION_STATE_ROOT="${BRIDGESLLM_RESTORE_TEST_ROOT}/validation-state/private"
  RESTORE_VALIDATION_STATE_ALIAS_ROOT="${BRIDGESLLM_RESTORE_TEST_ROOT}/validation-state"
  RESTORE_VALIDATION_STORAGE_PROBE="${BRIDGESLLM_RESTORE_TEST_ROOT}"
else
  RESTORE_VALIDATION_RUNTIME_ROOT="/run"
  RESTORE_VALIDATION_STATE_ROOT="/var/lib/private"
  RESTORE_VALIDATION_STATE_ALIAS_ROOT="/var/lib"
  RESTORE_VALIDATION_STORAGE_PROBE="/var/lib"
fi

resolve_postgresql_client_toolchain() {
  local requested_major="${1:-}"
  python3 - "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" "${requested_major}" \
    "${RESTORE_PSQL_BIN}" "${RESTORE_PG_DUMP_BIN}" \
    "${RESTORE_PG_RESTORE_BIN}" <<'PY'
import os
import pathlib
import re
import stat
import subprocess
import sys

(
    test_root,
    requested_major_raw,
    configured_psql,
    configured_dump,
    configured_restore,
) = sys.argv[1:]
floors = {14: 23, 15: 18, 16: 14, 17: 10, 18: 4}
requested_major = None
if requested_major_raw:
    if not requested_major_raw.isdigit():
        raise SystemExit(1)
    requested_major = int(requested_major_raw)
    if requested_major not in floors:
        raise SystemExit(1)

def safe_parent_chain(path: pathlib.Path) -> None:
    if not path.is_absolute() or os.path.normpath(str(path)) != str(path):
        raise SystemExit(1)
    current = pathlib.Path("/")
    root_info = os.lstat(current)
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or stat.S_ISLNK(root_info.st_mode)
        or root_info.st_uid != 0
        or root_info.st_gid != 0
        or root_info.st_mode & 0o022
    ):
        raise SystemExit(1)
    for part in path.parts[1:-1]:
        current /= part
        info = os.lstat(current)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
        ):
            raise SystemExit(1)

def safe_regular(path: pathlib.Path) -> None:
    safe_parent_chain(path)
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or not info.st_mode & 0o100
    ):
        raise SystemExit(1)

def attest_wrapper(path: pathlib.Path) -> None:
    seen = set()
    for _ in range(8):
        safe_parent_chain(path)
        info = os.lstat(path)
        identity = (info.st_dev, info.st_ino)
        if identity in seen or info.st_uid != 0 or info.st_gid != 0:
            raise SystemExit(1)
        seen.add(identity)
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            path = pathlib.Path(
                os.path.normpath(
                    target if os.path.isabs(target)
                    else os.path.join(path.parent, target)
                )
            )
            continue
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_mode & 0o022
            or not info.st_mode & 0o100
        ):
            raise SystemExit(1)
        return
    raise SystemExit(1)

def version(path: pathlib.Path, name: str) -> tuple[int, int]:
    safe_regular(path)
    try:
        result = subprocess.run(
            [str(path), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=10,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SystemExit(1)
    if result.returncode != 0 or len(result.stdout) > 4096 or result.stderr:
        raise SystemExit(1)
    try:
        lines = result.stdout.decode("ascii").splitlines()
    except UnicodeDecodeError:
        raise SystemExit(1)
    if len(lines) != 1:
        raise SystemExit(1)
    match = re.fullmatch(
        rf"{re.escape(name)} \(PostgreSQL\) ([0-9]+)\.([0-9]+)"
        rf"(?:[ \t][ -~]*)?",
        lines[0],
    )
    if match is None:
        raise SystemExit(1)
    major, minor = map(int, match.groups())
    if major not in floors or minor < floors[major]:
        raise SystemExit(1)
    return major, minor

names = ("psql", "pg_dump", "pg_restore")
if test_root:
    paths = tuple(
        pathlib.Path(value)
        for value in (
            configured_psql,
            configured_dump,
            configured_restore,
        )
    )
    versions = tuple(version(path, name) for path, name in zip(paths, names))
    if len(set(versions)) != 1:
        raise SystemExit(1)
    major, minor = versions[0]
    if requested_major is not None and major != requested_major:
        raise SystemExit(1)
else:
    for name in names:
        attest_wrapper(pathlib.Path("/usr/bin") / name)
    candidates = (
        [requested_major]
        if requested_major is not None
        else sorted(floors, reverse=True)
    )
    selection = None
    for major in candidates:
        root = pathlib.Path("/usr/lib/postgresql") / str(major) / "bin"
        paths = tuple(root / name for name in names)
        try:
            versions = tuple(
                version(path, name) for path, name in zip(paths, names)
            )
        except (OSError, SystemExit):
            if requested_major is not None:
                raise
            continue
        if len(set(versions)) == 1 and versions[0][0] == major:
            selection = (paths, versions[0])
            break
    if selection is None:
        raise SystemExit(1)
    paths, (major, minor) = selection
print(
    "\t".join(
        [*(str(path) for path in paths), str(major), str(minor)]
    )
)
PY
}

set_postgresql_client_toolchain() {
  local requested_major="${1:-}" result psql_path dump_path restore_path
  local major minor extra
  result="$(resolve_postgresql_client_toolchain "${requested_major}")" \
    || return 1
  IFS=$'\t' read -r psql_path dump_path restore_path major minor extra \
    <<<"${result}"
  [[ -z "${extra}" && "${major}" =~ ^(14|15|16|17|18)$ \
    && "${minor}" =~ ^[0-9]+$ ]] || return 1
  RESTORE_PSQL_BIN="${psql_path}"
  RESTORE_PG_DUMP_BIN="${dump_path}"
  RESTORE_PG_RESTORE_BIN="${restore_path}"
  RESTORE_POSTGRESQL_CLIENT_MAJOR="${major}"
  RESTORE_POSTGRESQL_CLIENT_MINOR="${minor}"
}

set_postgresql_client_toolchain \
  || die "No trusted PostgreSQL client toolchain satisfies the supported security floor"

select_validation_postgresql_server_toolchain() {
  local initdb="${RESTORE_INITDB_BIN}" postgres="${RESTORE_POSTGRES_BIN}"
  if [[ -z "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]]; then
    initdb="/usr/lib/postgresql/${RESTORE_POSTGRESQL_CLIENT_MAJOR}/bin/initdb"
    postgres="/usr/lib/postgresql/${RESTORE_POSTGRESQL_CLIENT_MAJOR}/bin/postgres"
  fi
  python3 - "${initdb}" "${postgres}" \
    "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    "${RESTORE_POSTGRESQL_CLIENT_MINOR}" <<'PY' || return 1
import os
import pathlib
import re
import stat
import subprocess
import sys

initdb, postgres, major, minor = sys.argv[1:]
for path_raw, name in ((initdb, "initdb"), (postgres, "postgres")):
    path = pathlib.Path(path_raw)
    info = os.lstat(path)
    if (
        not path.is_absolute()
        or not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or not info.st_mode & 0o100
    ):
        raise SystemExit(1)
    result = subprocess.run(
        [str(path), "--version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=10,
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
    if result.returncode or result.stderr:
        raise SystemExit(1)
    line = result.stdout.decode("ascii").strip()
    match = re.fullmatch(
        rf"{name} \(PostgreSQL\) ([0-9]+)\.([0-9]+)(?:[ \t][ -~]*)?",
        line,
    )
    if match is None or match.groups() != (major, minor):
        raise SystemExit(1)
PY
  RESTORE_INITDB_BIN="${initdb}"
  RESTORE_POSTGRES_BIN="${postgres}"
}

[[ "${RESTORE_PORT}" =~ ^[0-9]+$ \
  && "${RESTORE_PORT}" -ge 1024 && "${RESTORE_PORT}" -le 65535 ]] \
  || die "Restore validation port must be between 1024 and 65535"

portal_version() {
  local root="${1:-${PORTAL_DIR}}"
  python3 - "${root}/backend/package.json" <<'PY'
import json
import re
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        value = json.load(handle).get("version", "")
except (OSError, ValueError):
    raise SystemExit(1)
if not isinstance(value, str) or not re.fullmatch(
    r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", value
):
    raise SystemExit(1)
print(value)
PY
}

read_env_value() {
  local file="$1" key="$2"
  python3 - "${file}" "${key}" <<'PY'
import os
import re
import stat
import sys

path, requested = sys.argv[1:]
info = os.lstat(path)
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0 or info.st_nlink != 1
        or info.st_mode & 0o022 or info.st_size <= 0 or info.st_size > 1024 * 1024):
    raise SystemExit(1)
text = open(path, "r", encoding="utf-8").read()
if "\x00" in text or "\r" in text:
    raise SystemExit(1)
assignment = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
values = {}
for raw in text.split("\n"):
    if not raw or raw.lstrip().startswith(("#", ";")):
        continue
    match = assignment.fullmatch(raw)
    if match is None:
        raise SystemExit(1)
    name, value = match.groups()
    if name in values or "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SystemExit(1)
    if value[:1] in {"'", '"'}:
        quote = value[0]
        if len(value) < 2 or value[-1] != quote or quote in value[1:-1]:
            raise SystemExit(1)
        value = value[1:-1]
    elif any(char in value for char in "\"'") or value != value.strip(" \t"):
        raise SystemExit(1)
    values[name] = value
if requested in values:
    print(values[requested])
PY
}

database_authority_environment() {
  local authority="${TRANSACTION_DIR}/database-authority.env"
  [[ -n "${TRANSACTION_DIR}" \
    && "${TRANSACTION_DIR}" == "${TRANSACTIONS_ROOT}/"* \
    && -f "${authority}" && ! -L "${authority}" \
    && "$(stat -c '%u:%g:%a:%h' "${authority}" 2>/dev/null)" == "0:0:600:1" ]] \
    || return 1
  printf '%s\n' "${authority}"
}

seal_database_authority_environment() {
  local authority="${TRANSACTION_DIR}/database-authority.env"
  [[ -f "${PORTAL_ENV_FILE}" && ! -L "${PORTAL_ENV_FILE}" ]] || return 1
  [[ ! -e "${authority}" && ! -L "${authority}" ]] || return 1
  install -m 600 -o root -g root -- "${PORTAL_ENV_FILE}" "${authority}" \
    || return 1
  cmp -s -- "${PORTAL_ENV_FILE}" "${authority}" || return 1
  sync -f -- "${authority}" || return 1
  fsync_directory "${TRANSACTION_DIR}"
}

restore_database_peer_fields() {
  local authority="${1:-${TRANSACTION_DIR}/database-exclusion.json}"
  python3 - "${authority}" "${RESTORE_PSQL_BIN}" "${RESTORE_PG_DUMP_BIN}" \
    "${RESTORE_PG_RESTORE_BIN}" "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    "${RESTORE_POSTGRESQL_CLIENT_MINOR}" <<'PY'
import json
import hashlib
import os
import re
import stat
import sys

(
    path,
    current_psql,
    current_dump,
    current_restore,
    current_major,
    current_minor,
) = sys.argv[1:]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
    or info.st_size <= 0
    or info.st_size > 128 * 1024
):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
required = {
    "schema", "operationId", "guardToken", "topology", "topologySha256",
    "testMode", "osUser", "osUid", "osGid", "socketDirectory", "port",
    "peerRoleName", "peerRoleOid", "databaseName", "databaseOid",
    "portalRoleName", "portalRoleOid", "originalConnectionLimit",
    "originalPortalCanLogin", "databaseControlContract",
    "databaseControlContractSha256", "databaseControlSnapshot",
    "databaseControlSnapshotSha256", "postgresqlToolchain",
    "postgresqlToolchainSha256",
}
topology = document.get("topology")
control = document.get("databaseControlContract")
snapshot = document.get("databaseControlSnapshot")
toolchain = document.get("postgresqlToolchain")
if (
    document.get("schema") != "bridgesllm.database-exclusivity.v1"
    or set(document) != required
    or not isinstance(topology, dict)
    or topology.get("schema") != "bridgesllm-update-database-topology-v1"
    or document.get("topologySha256") != hashlib.sha256(
        json.dumps(topology, sort_keys=True, separators=(",", ":")).encode("ascii")
    ).hexdigest()
    or topology.get("databaseName") != document.get("databaseName")
    or topology.get("databaseOid") != document.get("databaseOid")
    or topology.get("serverPort") != document.get("port")
    or not re.fullmatch(
        r"[1-9][0-9]{0,31}", str(topology.get("systemIdentifier", ""))
    )
    or document.get("originalPortalCanLogin") is not True
    or control != {
        "databaseAclDefault": True,
        "databaseScopedSettings": 0,
        "membershipEdges": 0,
        "portalBypassRls": False,
        "portalCanLogin": True,
        "portalConnectionLimit": -1,
        "portalCreateDb": False,
        "portalCreateRole": False,
        "portalGlobalSettings": 0,
        "portalInherit": True,
        "portalPasswordScram": True,
        "portalReplication": False,
        "portalSuperuser": False,
        "portalValidUntilNull": True,
    }
    or document.get("databaseControlContractSha256")
        != hashlib.sha256(
            json.dumps(control, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
    or not isinstance(snapshot, dict)
    or set(snapshot) != {
        "databaseAcl",
        "databaseScopedSettings",
        "portalPasswordVerifier",
        "portalRoleSettings",
        "portalValidUntil",
    }
    or document.get("databaseControlSnapshotSha256")
        != hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
    or not isinstance(snapshot.get("databaseAcl"), list)
    or not isinstance(snapshot.get("databaseScopedSettings"), list)
    or not isinstance(snapshot.get("portalRoleSettings"), list)
    or snapshot.get("portalValidUntil") is not None
    or (
        snapshot.get("portalPasswordVerifier") is not None
        and not re.fullmatch(
            r"SCRAM-SHA-256\$[1-9][0-9]*:"
            r"[A-Za-z0-9+/]+={0,2}\$"
            r"[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}",
            snapshot["portalPasswordVerifier"],
        )
    )
    or not isinstance(toolchain, dict)
    or set(toolchain) != {"binaries", "major", "minor"}
    or toolchain.get("major") != int(current_major)
    or toolchain.get("minor") != int(current_minor)
    or set(toolchain.get("binaries", {})) != {"psql", "pg_dump", "pg_restore"}
    or document.get("postgresqlToolchainSha256")
        != hashlib.sha256(
            json.dumps(toolchain, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
):
    raise SystemExit(1)
for name, current in zip(
    ("psql", "pg_dump", "pg_restore"),
    (current_psql, current_dump, current_restore),
):
    record = toolchain["binaries"].get(name)
    if (
        not isinstance(record, dict)
        or set(record) != {"path", "sha256"}
        or record.get("path") != current
        or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))
    ):
        raise SystemExit(1)
    binary_info = os.lstat(current)
    if (
        not stat.S_ISREG(binary_info.st_mode)
        or stat.S_ISLNK(binary_info.st_mode)
        or binary_info.st_uid != 0
        or binary_info.st_gid != 0
        or binary_info.st_nlink != 1
        or binary_info.st_mode & 0o022
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    with open(current, "rb", buffering=0) as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != record["sha256"]:
        raise SystemExit(1)
values = [
    document["osUser"],
    str(document["osUid"]),
    str(document["osGid"]),
    document["socketDirectory"],
    str(document["port"]),
    document["peerRoleName"],
    document["databaseName"],
    document["portalRoleName"],
    "true" if document["testMode"] else "false",
]
if any(
    not isinstance(value, str)
    or not value
    or "\t" in value
    or "\n" in value
    or any(ord(char) < 32 or ord(char) == 127 for char in value)
    for value in values
):
    raise SystemExit(1)
print("\t".join(values))
PY
}

run_with_restore_peer_internal() {
  local authority="$1" executable="$2" inherited_source="$3"
  shift 3
  local expected_parent="${BASHPID}"
  # Keep fd 0 attached to the requested command. Several psql operations feed
  # transactional SQL on stdin; using the runner itself as a stdin heredoc
  # would silently replace that SQL before execve().
  python3 /dev/fd/3 "${expected_parent}" "${authority}" \
    "${executable}" "${inherited_source}" "$@" 3<<'PY'
import ctypes
import json
import os
import pwd
import signal
import stat
import sys

os.close(3)
expected_parent_raw, authority, executable, inherited_source, *arguments = (
    sys.argv[1:]
)
try:
    expected_parent = int(expected_parent_raw)
except ValueError:
    raise SystemExit(1)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise SystemExit(1)
if os.getppid() != expected_parent:
    os.kill(os.getpid(), signal.SIGKILL)
info = os.lstat(authority)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
):
    raise SystemExit(1)
document = json.load(open(authority, "r", encoding="utf-8"))
if (
    document.get("schema") != "bridgesllm.database-exclusivity.v1"
    or not os.path.isabs(executable)
    or not os.path.isfile(executable)
):
    raise SystemExit(1)
source_descriptor = -1
marker = "@BRIDGESLLM_SOURCE_FD@"
if inherited_source:
    source_info = os.lstat(inherited_source)
    if (
        not os.path.isabs(inherited_source)
        or os.path.normpath(inherited_source) != inherited_source
        or not stat.S_ISREG(source_info.st_mode)
        or stat.S_ISLNK(source_info.st_mode)
        or source_info.st_uid != 0
        or source_info.st_gid != 0
        or source_info.st_nlink != 1
        or stat.S_IMODE(source_info.st_mode) != 0o600
        or source_info.st_size <= 5
        or arguments.count(marker) != 1
    ):
        raise SystemExit(1)
    source_descriptor = os.open(
        inherited_source,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    )
    opened_info = os.fstat(source_descriptor)
    if (
        (opened_info.st_dev, opened_info.st_ino, opened_info.st_size)
        != (source_info.st_dev, source_info.st_ino, source_info.st_size)
    ):
        raise SystemExit(1)
    os.set_inheritable(source_descriptor, True)
    arguments[arguments.index(marker)] = f"/proc/self/fd/{source_descriptor}"
elif marker in arguments:
    raise SystemExit(1)
uid = document.get("osUid")
gid = document.get("osGid")
name = document.get("osUser")
test_mode = document.get("testMode")
if (
    not isinstance(uid, int)
    or isinstance(uid, bool)
    or uid < 0
    or not isinstance(gid, int)
    or isinstance(gid, bool)
    or gid < 0
    or not isinstance(name, str)
    or not name
    or not isinstance(test_mode, bool)
):
    raise SystemExit(1)
environment = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
    "PGOPTIONS": "-c synchronous_commit=on",
}
if not test_mode:
    record = pwd.getpwnam(name)
    if record.pw_uid != uid or record.pw_gid != gid or uid == 0:
        raise SystemExit(1)
    environment["HOME"] = record.pw_dir
    os.initgroups(name, gid)
    os.setgid(gid)
    os.setuid(uid)
    # Linux clears the parent-death signal across credential changes.
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise SystemExit(1)
if os.getppid() != expected_parent:
    os.kill(os.getpid(), signal.SIGKILL)
os.execve(executable, [executable, *arguments], environment)
PY
}

run_with_restore_peer() {
  local authority="$1" executable="$2"
  shift 2
  run_with_restore_peer_internal "${authority}" "${executable}" "" "$@"
}

run_with_restore_peer_source() {
  local authority="$1" executable="$2" source="$3"
  shift 3
  run_with_restore_peer_internal \
    "${authority}" "${executable}" "${source}" "$@"
}

run_restore_peer_psql() {
  local authority="${RESTORE_DATABASE_PEER_AUTHORITY_OVERRIDE:-${TRANSACTION_DIR}/database-exclusion.json}"
  local target="${1:-target}"
  shift || true
  local fields os_user os_uid os_gid socket_dir port peer_role database portal_role test_mode
  fields="$(restore_database_peer_fields "${authority}")" || return 1
  IFS=$'\t' read -r os_user os_uid os_gid socket_dir port peer_role database \
    portal_role test_mode <<<"${fields}"
  local connect_database="${database}"
  [[ "${target}" == "target" || "${target}" == "control" ]] || return 1
  [[ "${target}" != "control" ]] || connect_database="postgres"
  run_with_restore_peer "${authority}" "${RESTORE_PSQL_BIN}" \
    --host="${socket_dir}" --port="${port}" --username="${peer_role}" \
    --dbname="${connect_database}" --no-psqlrc --set=ON_ERROR_STOP=1 "$@"
}

restore_peer_role_sql() {
  local fields os_user os_uid os_gid socket_dir port peer_role database portal_role test_mode
  fields="$(restore_database_peer_fields)" || return 1
  IFS=$'\t' read -r os_user os_uid os_gid socket_dir port peer_role database \
    portal_role test_mode <<<"${fields}"
  printf 'SET ROLE %s;\n' "$(sql_identifier "${portal_role}")"
}

run_restore_peer_pg_dump() {
  local fields os_user os_uid os_gid socket_dir port peer_role database portal_role test_mode
  fields="$(restore_database_peer_fields)" || return 1
  IFS=$'\t' read -r os_user os_uid os_gid socket_dir port peer_role database \
    portal_role test_mode <<<"${fields}"
  run_with_restore_peer \
    "${TRANSACTION_DIR}/database-exclusion.json" "${RESTORE_PG_DUMP_BIN}" \
    --host="${socket_dir}" --port="${port}" --username="${peer_role}" \
    --dbname="${database}" --role="${portal_role}" "$@"
}

run_restore_peer_pg_restore() {
  local source="$1"
  shift
  local fields os_user os_uid os_gid socket_dir port peer_role database portal_role test_mode
  fields="$(restore_database_peer_fields)" || return 1
  IFS=$'\t' read -r os_user os_uid os_gid socket_dir port peer_role database \
    portal_role test_mode <<<"${fields}"
  run_with_restore_peer_source \
    "${TRANSACTION_DIR}/database-exclusion.json" "${RESTORE_PG_RESTORE_BIN}" \
    "${source}" \
    --host="${socket_dir}" --port="${port}" --username="${peer_role}" \
    --dbname="${database}" --role="${portal_role}" \
    "$@" "@BRIDGESLLM_SOURCE_FD@"
}

restore_peer_database_url() {
  local fields os_user os_uid os_gid socket_dir port peer_role database portal_role test_mode
  fields="$(restore_database_peer_fields)" || return 1
  IFS=$'\t' read -r os_user os_uid os_gid socket_dir port peer_role database \
    portal_role test_mode <<<"${fields}"
  python3 - "${peer_role}" "${database}" "${socket_dir}" "${port}" \
    "${portal_role}" <<'PY'
import sys
from urllib.parse import quote, urlencode
peer, database, socket_directory, port, portal_role = sys.argv[1:]
query = urlencode({
    "host": socket_directory,
    "options": f"-c role={portal_role} -c synchronous_commit=on",
})
print(
    f"postgresql://{quote(peer, safe='')}@localhost:{int(port)}/"
    f"{quote(database, safe='')}?{query}"
)
PY
}

sql_identifier() {
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
    raise SystemExit(1)
print('"' + value.replace('"', '""') + '"')
PY
}

sql_literal() {
  python3 - "$1" <<'PY'
import sys
value = sys.argv[1]
if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
    raise SystemExit(1)
print("'" + value.replace("'", "''") + "'")
PY
}

capture_restore_database_peer_authority() {
  local target="${TRANSACTION_DIR}/database-exclusion.json"
  local temporary="${TRANSACTION_DIR}/.database-exclusion-${TRANSACTION_ID}"
  local database_url authority storage bytes topology relation_count extra
  local database_name portal_role token observed
  [[ ! -e "${target}" && ! -L "${target}" \
    && ! -e "${temporary}" && ! -L "${temporary}" ]] || return 1
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  storage="$(database_storage_admission)" || return 1
  IFS='|' read -r bytes topology relation_count extra <<<"${storage}"
  [[ "${bytes}" =~ ^[1-9][0-9]*$ \
    && "${relation_count}" =~ ^[1-9][0-9]*$ \
    && -n "${topology}" && -z "${extra}" ]] || return 1
  read -r database_name portal_role < <(
    python3 - "${database_url}" <<'PY'
import sys
from urllib.parse import unquote, urlsplit
parsed = urlsplit(sys.argv[1])
database = unquote((parsed.path or "").lstrip("/"), errors="strict")
role = unquote(parsed.username or "", errors="strict")
if (
    parsed.scheme not in {"postgres", "postgresql"}
    or not database
    or not role
    or any(char.isspace() for value in (database, role) for char in value)
):
    raise SystemExit(1)
print(database, role)
PY
  ) || return 1
  token="$(openssl rand -hex 32)" || return 1
  [[ "${token}" =~ ^[a-f0-9]{64}$ ]] || return 1
  python3 - "${temporary}" "${topology}" "${database_name}" "${portal_role}" \
    "${TRANSACTION_ID}" "${token}" "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" \
    "${RESTORE_PSQL_BIN}" "${RESTORE_PG_DUMP_BIN}" \
    "${RESTORE_PG_RESTORE_BIN}" "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    "${RESTORE_POSTGRESQL_CLIENT_MINOR}" <<'PY' \
    || return 1
import hashlib
import json
import os
import pathlib
import pwd
import re
import socket
import stat
import sys

(
    target,
    topology_raw,
    database,
    portal_role,
    operation_id,
    token,
    test_root,
    psql_path,
    dump_path,
    restore_path,
    client_major_raw,
    client_minor_raw,
) = sys.argv[1:]
topology = json.loads(topology_raw)
if (
    topology.get("schema") != "bridgesllm-update-database-topology-v1"
    or topology.get("databaseName") != database
    or not re.fullmatch(r"[1-9][0-9]{0,31}", str(topology.get("systemIdentifier", "")))
    or not isinstance(topology.get("databaseOid"), int)
    or isinstance(topology.get("databaseOid"), bool)
    or not 1 <= topology["databaseOid"] <= 4_294_967_295
    or not isinstance(topology.get("serverPort"), int)
    or not 1 <= topology["serverPort"] <= 65535
):
    raise SystemExit(1)
test_mode = bool(test_root)
if test_mode:
    root = pathlib.Path(test_root).resolve(strict=True)
    data = pathlib.Path(topology["dataDirectory"]).resolve(strict=True)
    if root != data and root not in data.parents:
        raise SystemExit(1)
    os_user = "root"
    os_uid = 0
    os_gid = 0
    socket_directory = str(root / "postgres-socket")
else:
    data = pathlib.Path(topology["dataDirectory"])
    data_info = os.lstat(data)
    pidfile = data / "postmaster.pid"
    pid_info = os.lstat(pidfile)
    if (
        not stat.S_ISDIR(data_info.st_mode)
        or stat.S_ISLNK(data_info.st_mode)
        or data_info.st_uid == 0
        or data_info.st_mode & 0o022
        or not stat.S_ISREG(pid_info.st_mode)
        or stat.S_ISLNK(pid_info.st_mode)
        or pid_info.st_uid != data_info.st_uid
        or pid_info.st_gid != data_info.st_gid
        or pid_info.st_nlink != 1
        or pid_info.st_mode & 0o022
        or pid_info.st_size <= 0
        or pid_info.st_size > 64 * 1024
    ):
        raise SystemExit(1)
    lines = pidfile.read_text(encoding="utf-8").splitlines()
    if len(lines) < 5 or not lines[0].isdigit() or not lines[3].isdigit():
        raise SystemExit(1)
    postmaster_pid = int(lines[0])
    if (
        pathlib.Path(lines[1]).resolve(strict=True) != data.resolve(strict=True)
        or int(lines[3]) != topology["serverPort"]
        or os.stat(f"/proc/{postmaster_pid}").st_uid != data_info.st_uid
    ):
        raise SystemExit(1)
    status = pathlib.Path(f"/proc/{postmaster_pid}/status").read_text(
        encoding="ascii"
    ).splitlines()
    uid_lines = [line for line in status if line.startswith("Uid:")]
    if len(uid_lines) != 1 or int(uid_lines[0].split()[1]) != data_info.st_uid:
        raise SystemExit(1)
    record = pwd.getpwuid(data_info.st_uid)
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", record.pw_name):
        raise SystemExit(1)
    candidates = [
        item.strip()
        for item in lines[4].split(",")
        if item.strip().startswith("/")
    ]
    socket_directory = ""
    for candidate in candidates:
        directory = pathlib.Path(candidate)
        endpoint = directory / f".s.PGSQL.{topology['serverPort']}"
        try:
            directory_info = os.lstat(directory)
            endpoint_info = os.lstat(endpoint)
        except OSError:
            continue
        if (
            stat.S_ISDIR(directory_info.st_mode)
            and not stat.S_ISLNK(directory_info.st_mode)
            and stat.S_ISSOCK(endpoint_info.st_mode)
            and endpoint_info.st_uid == data_info.st_uid
        ):
            socket_directory = str(directory)
            break
    if not socket_directory:
        raise SystemExit(1)
    os_user = record.pw_name
    os_uid = record.pw_uid
    os_gid = record.pw_gid
control_contract = {
    "databaseAclDefault": True,
    "databaseScopedSettings": 0,
    "membershipEdges": 0,
    "portalBypassRls": False,
    "portalCanLogin": True,
    "portalConnectionLimit": -1,
    "portalCreateDb": False,
    "portalCreateRole": False,
    "portalGlobalSettings": 0,
    "portalInherit": True,
    "portalPasswordScram": True,
    "portalReplication": False,
    "portalSuperuser": False,
    "portalValidUntilNull": True,
}
control_snapshot = {
    "databaseAcl": [],
    "databaseScopedSettings": [],
    "portalPasswordVerifier": None,
    "portalRoleSettings": [],
    "portalValidUntil": None,
}
toolchain_binaries = {}
for name, raw_path in (
    ("psql", psql_path),
    ("pg_dump", dump_path),
    ("pg_restore", restore_path),
):
    path = pathlib.Path(raw_path)
    info = os.lstat(path)
    if (
        not path.is_absolute()
        or not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    toolchain_binaries[name] = {
        "path": str(path),
        "sha256": digest.hexdigest(),
    }
toolchain = {
    "major": int(client_major_raw),
    "minor": int(client_minor_raw),
    "binaries": toolchain_binaries,
}
payload = {
    "schema": "bridgesllm.database-exclusivity.v1",
    "operationId": operation_id,
    "guardToken": token,
    "topology": topology,
    "topologySha256": hashlib.sha256(
        json.dumps(topology, sort_keys=True, separators=(",", ":")).encode("ascii")
    ).hexdigest(),
    "testMode": test_mode,
    "osUser": os_user,
    "osUid": os_uid,
    "osGid": os_gid,
    "socketDirectory": socket_directory,
    "port": topology["serverPort"],
    "peerRoleName": os_user,
    "peerRoleOid": 0,
    "databaseName": database,
    "databaseOid": topology["databaseOid"],
    "portalRoleName": portal_role,
    "portalRoleOid": 0,
    "originalConnectionLimit": 0,
    "originalPortalCanLogin": True,
    "databaseControlContract": control_contract,
    "databaseControlContractSha256": hashlib.sha256(
        json.dumps(
            control_contract,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
    ).hexdigest(),
    "databaseControlSnapshot": control_snapshot,
    "databaseControlSnapshotSha256": hashlib.sha256(
        json.dumps(
            control_snapshot,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
    ).hexdigest(),
    "postgresqlToolchain": toolchain,
    "postgresqlToolchainSha256": hashlib.sha256(
        json.dumps(toolchain, sort_keys=True, separators=(",", ":")).encode(
            "ascii"
        )
    ).hexdigest(),
}
descriptor = os.open(
    target,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    os.write(descriptor, encoded)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  local observed_file="${TRANSACTION_DIR}/.database-control-observed-${TRANSACTION_ID}"
  [[ ! -e "${observed_file}" && ! -L "${observed_file}" ]] || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! RESTORE_DATABASE_PEER_AUTHORITY_OVERRIDE="${temporary}" \
    run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'databaseName', d.datname,
  'databaseOid', d.oid::bigint,
  'portalRoleName', owner.rolname,
  'portalRoleOid', owner.oid::bigint,
  'portalRoleSuperuser', owner.rolsuper,
  'portalRoleCanLogin', owner.rolcanlogin,
  'portalRoleCreateDb', owner.rolcreatedb,
  'portalRoleCreateRole', owner.rolcreaterole,
  'portalRoleReplication', owner.rolreplication,
  'portalRoleBypassRls', owner.rolbypassrls,
  'portalRoleInherit', owner.rolinherit,
  'portalRoleConnectionLimit', owner.rolconnlimit,
  'portalRoleValidUntilNull', owner.rolvaliduntil IS NULL,
  'portalRolePasswordScram',
    COALESCE(owner.rolpassword LIKE 'SCRAM-SHA-256$%', false),
  'databaseControlSnapshot', json_build_object(
    'portalPasswordVerifier', owner.rolpassword,
    'portalValidUntil', owner.rolvaliduntil::text,
    'portalRoleSettings', COALESCE((
      SELECT to_jsonb(setting.setconfig)
      FROM pg_db_role_setting setting
      WHERE setting.setdatabase = 0
        AND setting.setrole = owner.oid
    ), '[]'::jsonb),
    'databaseScopedSettings', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'roleOid', canonical.setrole::bigint,
          'settings', canonical.settings
        )
        ORDER BY canonical.setrole
      )
      FROM (
        SELECT setting.setrole,
               to_jsonb(ARRAY(
                 SELECT item
                 FROM unnest(setting.setconfig) item
                 ORDER BY item
               )) AS settings
        FROM pg_db_role_setting setting
        WHERE setting.setdatabase = d.oid
      ) canonical
    ), '[]'::jsonb),
    'databaseAcl', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'grantor', acl.grantor::bigint,
          'grantee', acl.grantee::bigint,
          'privilegeType', acl.privilege_type,
          'grantable', acl.is_grantable
        )
        ORDER BY acl.grantor, acl.grantee, acl.privilege_type,
                 acl.is_grantable
      )
      FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    ), '[]'::jsonb)
  ),
  'membershipEdges', (
    SELECT count(*) FROM pg_auth_members membership
    WHERE membership.roleid = owner.oid OR membership.member = owner.oid
  ),
  'databaseAclDefault', NOT EXISTS (
    (SELECT * FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba)))
     EXCEPT ALL
     SELECT * FROM aclexplode(acldefault('d', d.datdba)))
    UNION ALL
    (SELECT * FROM aclexplode(acldefault('d', d.datdba))
     EXCEPT ALL
     SELECT * FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))))
  ),
  'databaseScopedSettings', (
    SELECT count(*) FROM pg_db_role_setting setting
    WHERE setting.setdatabase = d.oid
  ),
  'portalGlobalSettings', (
    SELECT count(*) FROM pg_db_role_setting setting
    WHERE setting.setdatabase = 0 AND setting.setrole = owner.oid
  ),
  'peerRoleName', session_user,
  'peerRoleOid', peer.oid::bigint,
  'peerRoleSuperuser', peer.rolsuper,
  'originalConnectionLimit', d.datconnlimit,
  'allowConnections', d.datallowconn,
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'fsyncEnabled', current_setting('fsync') = 'on',
  'fullPageWritesEnabled', current_setting('full_page_writes') = 'on',
  'synchronousCommit', current_setting('synchronous_commit')
)::text
FROM pg_database d
JOIN pg_authid owner ON owner.oid = d.datdba
JOIN pg_roles peer ON peer.rolname = session_user
WHERE d.datname = current_database();
" >"${observed_file}"
  then
    rm -f -- "${temporary}" "${observed_file}"
    return 1
  fi
  chmod 600 "${observed_file}" || {
    rm -f -- "${temporary}" "${observed_file}"
    return 1
  }
  if ! python3 - "${temporary}" "${observed_file}" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

path, observed_path = sys.argv[1:]
document = json.load(open(path, "r", encoding="utf-8"))
observed_info = os.lstat(observed_path)
if (
    not stat.S_ISREG(observed_info.st_mode)
    or stat.S_ISLNK(observed_info.st_mode)
    or observed_info.st_uid != 0
    or observed_info.st_gid != 0
    or observed_info.st_nlink != 1
    or stat.S_IMODE(observed_info.st_mode) != 0o600
    or observed_info.st_size <= 0
    or observed_info.st_size > 128 * 1024
):
    raise SystemExit(1)
observed = json.load(open(observed_path, "r", encoding="utf-8"))
snapshot = observed.get("databaseControlSnapshot")
if (
    observed.get("databaseName") != document["databaseName"]
    or observed.get("databaseOid") != document["topology"]["databaseOid"]
    or observed.get("portalRoleName") != document["portalRoleName"]
    or observed.get("peerRoleName") != document["peerRoleName"]
    or observed.get("systemIdentifier")
        != str(document["topology"]["systemIdentifier"])
    or observed.get("portalRoleSuperuser") is not False
    or observed.get("portalRoleCanLogin") is not True
    or observed.get("portalRoleCreateDb") is not False
    or observed.get("portalRoleCreateRole") is not False
    or observed.get("portalRoleReplication") is not False
    or observed.get("portalRoleBypassRls") is not False
    or observed.get("portalRoleInherit") is not True
    or observed.get("portalRoleConnectionLimit") != -1
    or observed.get("portalRoleValidUntilNull") is not True
    or observed.get("portalRolePasswordScram") is not True
    or observed.get("membershipEdges") != 0
    or observed.get("databaseAclDefault") is not True
    or observed.get("databaseScopedSettings") != 0
    or observed.get("portalGlobalSettings") != 0
    or observed.get("peerRoleSuperuser") is not True
    or observed.get("allowConnections") is not True
    or observed.get("fsyncEnabled") is not True
    or observed.get("fullPageWritesEnabled") is not True
    or observed.get("synchronousCommit") != "on"
    or not isinstance(snapshot, dict)
    or set(snapshot) != {
        "databaseAcl",
        "databaseScopedSettings",
        "portalPasswordVerifier",
        "portalRoleSettings",
        "portalValidUntil",
    }
    or not re.fullmatch(
        r"SCRAM-SHA-256\$[1-9][0-9]*:"
        r"[A-Za-z0-9+/]+={0,2}\$"
        r"[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}",
        str(snapshot.get("portalPasswordVerifier", "")),
    )
    or snapshot.get("portalValidUntil") is not None
    or snapshot.get("portalRoleSettings") != []
    or snapshot.get("databaseScopedSettings") != []
    or not isinstance(snapshot.get("databaseAcl"), list)
    or not snapshot["databaseAcl"]
    or not isinstance(observed.get("databaseOid"), int)
    or not 1 <= observed["databaseOid"] <= 4_294_967_295
    or not isinstance(observed.get("portalRoleOid"), int)
    or not 1 <= observed["portalRoleOid"] <= 4_294_967_295
    or not isinstance(observed.get("peerRoleOid"), int)
    or not 1 <= observed["peerRoleOid"] <= 4_294_967_295
    or not isinstance(observed.get("originalConnectionLimit"), int)
    or isinstance(observed.get("originalConnectionLimit"), bool)
    or not -1 <= observed["originalConnectionLimit"] <= 2_147_483_647
):
    raise SystemExit(1)
for key in (
    "databaseOid", "portalRoleOid", "peerRoleOid", "originalConnectionLimit"
):
    document[key] = observed[key]
document["originalPortalCanLogin"] = observed["portalRoleCanLogin"]
document["databaseControlSnapshot"] = snapshot
document["databaseControlSnapshotSha256"] = hashlib.sha256(
    json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode("ascii")
).hexdigest()
descriptor = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
try:
    encoded = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
    os.write(descriptor, encoded)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  then
    rm -f -- "${temporary}" "${observed_file}"
    return 1
  fi
  rm -f -- "${observed_file}"
  mv -f -- "${temporary}" "${target}" || return 1
  fsync_directory "${TRANSACTION_DIR}"
}

restore_database_exclusion_values() {
  python3 - "${TRANSACTION_DIR}/database-exclusion.json" \
    "${RESTORE_PSQL_BIN}" "${RESTORE_PG_DUMP_BIN}" \
    "${RESTORE_PG_RESTORE_BIN}" "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    "${RESTORE_POSTGRESQL_CLIENT_MINOR}" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

(
    path,
    current_psql,
    current_dump,
    current_restore,
    current_major,
    current_minor,
) = sys.argv[1:]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
topology = document.get("topology")
required = {
    "schema", "operationId", "guardToken", "topology", "topologySha256",
    "testMode", "osUser", "osUid", "osGid", "socketDirectory", "port",
    "peerRoleName", "peerRoleOid", "databaseName", "databaseOid",
    "portalRoleName", "portalRoleOid", "originalConnectionLimit",
    "originalPortalCanLogin", "databaseControlContract",
    "databaseControlContractSha256", "databaseControlSnapshot",
    "databaseControlSnapshotSha256", "postgresqlToolchain",
    "postgresqlToolchainSha256",
}
control = document.get("databaseControlContract")
snapshot = document.get("databaseControlSnapshot")
toolchain = document.get("postgresqlToolchain")
if (
    document.get("schema") != "bridgesllm.database-exclusivity.v1"
    or set(document) != required
    or document.get("operationId") != os.environ.get("BRIDGESLLM_TRANSACTION_ID")
    or not re.fullmatch(r"[a-f0-9]{64}", str(document.get("guardToken", "")))
    or not isinstance(topology, dict)
    or topology.get("schema") != "bridgesllm-update-database-topology-v1"
    or document.get("topologySha256") != hashlib.sha256(
        json.dumps(topology, sort_keys=True, separators=(",", ":")).encode("ascii")
    ).hexdigest()
    or topology.get("databaseName") != document.get("databaseName")
    or topology.get("databaseOid") != document.get("databaseOid")
    or topology.get("serverPort") != document.get("port")
    or not re.fullmatch(
        r"[1-9][0-9]{0,31}", str(topology.get("systemIdentifier", ""))
    )
    or document.get("originalPortalCanLogin") is not True
    or control != {
        "databaseAclDefault": True,
        "databaseScopedSettings": 0,
        "membershipEdges": 0,
        "portalBypassRls": False,
        "portalCanLogin": True,
        "portalConnectionLimit": -1,
        "portalCreateDb": False,
        "portalCreateRole": False,
        "portalGlobalSettings": 0,
        "portalInherit": True,
        "portalPasswordScram": True,
        "portalReplication": False,
        "portalSuperuser": False,
        "portalValidUntilNull": True,
    }
    or document.get("databaseControlContractSha256")
        != hashlib.sha256(
            json.dumps(control, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
    or not isinstance(snapshot, dict)
    or set(snapshot) != {
        "databaseAcl",
        "databaseScopedSettings",
        "portalPasswordVerifier",
        "portalRoleSettings",
        "portalValidUntil",
    }
    or document.get("databaseControlSnapshotSha256")
        != hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
    or not re.fullmatch(
        r"SCRAM-SHA-256\$[1-9][0-9]*:"
        r"[A-Za-z0-9+/]+={0,2}\$"
        r"[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}",
        str(snapshot.get("portalPasswordVerifier", "")),
    )
    or snapshot.get("portalValidUntil") is not None
    or snapshot.get("portalRoleSettings") != []
    or snapshot.get("databaseScopedSettings") != []
    or not isinstance(snapshot.get("databaseAcl"), list)
    or not snapshot["databaseAcl"]
    or not isinstance(toolchain, dict)
    or set(toolchain) != {"binaries", "major", "minor"}
    or toolchain.get("major") != int(current_major)
    or toolchain.get("minor") != int(current_minor)
    or set(toolchain.get("binaries", {})) != {"psql", "pg_dump", "pg_restore"}
    or document.get("postgresqlToolchainSha256")
        != hashlib.sha256(
            json.dumps(toolchain, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
    or not isinstance(document.get("databaseOid"), int)
    or not 1 <= document["databaseOid"] <= 4_294_967_295
    or not isinstance(document.get("portalRoleOid"), int)
    or not 1 <= document["portalRoleOid"] <= 4_294_967_295
    or not isinstance(document.get("peerRoleOid"), int)
    or not 1 <= document["peerRoleOid"] <= 4_294_967_295
    or not isinstance(document.get("originalConnectionLimit"), int)
    or isinstance(document.get("originalConnectionLimit"), bool)
    or not -1 <= document["originalConnectionLimit"] <= 2_147_483_647
):
    raise SystemExit(1)
for name, current in zip(
    ("psql", "pg_dump", "pg_restore"),
    (current_psql, current_dump, current_restore),
):
    record = toolchain["binaries"].get(name)
    if (
        not isinstance(record, dict)
        or set(record) != {"path", "sha256"}
        or record.get("path") != current
        or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))
    ):
        raise SystemExit(1)
    binary_info = os.lstat(current)
    if (
        not stat.S_ISREG(binary_info.st_mode)
        or stat.S_ISLNK(binary_info.st_mode)
        or binary_info.st_uid != 0
        or binary_info.st_gid != 0
        or binary_info.st_nlink != 1
        or binary_info.st_mode & 0o022
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    with open(current, "rb", buffering=0) as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != record["sha256"]:
        raise SystemExit(1)
values = (
    document["databaseName"],
    str(document["databaseOid"]),
    document["portalRoleName"],
    str(document["portalRoleOid"]),
    document["peerRoleName"],
    str(document["peerRoleOid"]),
    str(document["originalConnectionLimit"]),
    document["guardToken"],
    str(document["topology"]["systemIdentifier"]),
)
if any(
    not isinstance(value, str)
    or not value
    or "\t" in value
    or "\n" in value
    for value in values
):
    raise SystemExit(1)
print("\t".join(values))
PY
}

restore_database_toolchain_major() {
  local authority="${TRANSACTION_DIR}/database-exclusion.json"
  python3 - "${authority}" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

path = sys.argv[1]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
    or info.st_size <= 0
    or info.st_size > 128 * 1024
):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
toolchain = document.get("postgresqlToolchain")
if (
    document.get("schema") != "bridgesllm.database-exclusivity.v1"
    or not isinstance(toolchain, dict)
    or set(toolchain) != {"binaries", "major", "minor"}
    or toolchain.get("major") not in {14, 15, 16, 17, 18}
    or not isinstance(toolchain.get("minor"), int)
    or isinstance(toolchain.get("minor"), bool)
    or toolchain["minor"] < 0
    or set(toolchain.get("binaries", {})) != {"psql", "pg_dump", "pg_restore"}
    or document.get("postgresqlToolchainSha256")
        != hashlib.sha256(
            json.dumps(toolchain, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
):
    raise SystemExit(1)
for record in toolchain["binaries"].values():
    if (
        not isinstance(record, dict)
        or set(record) != {"path", "sha256"}
        or not isinstance(record.get("path"), str)
        or not os.path.isabs(record["path"])
        or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))
    ):
        raise SystemExit(1)
    binary_info = os.lstat(record["path"])
    if (
        not stat.S_ISREG(binary_info.st_mode)
        or stat.S_ISLNK(binary_info.st_mode)
        or binary_info.st_uid != 0
        or binary_info.st_gid != 0
        or binary_info.st_nlink != 1
        or binary_info.st_mode & 0o022
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    with open(record["path"], "rb", buffering=0) as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != record["sha256"]:
        raise SystemExit(1)
print(toolchain["major"])
PY
}

reselect_recovery_postgresql_toolchain() {
  local authority="${TRANSACTION_DIR}/database-exclusion.json" major
  if [[ -e "${authority}" || -L "${authority}" ]]; then
    major="$(restore_database_toolchain_major)" || return 1
  elif [[ -f "${TRANSACTION_DIR}/validation-database-authority.json" \
    && ! -L "${TRANSACTION_DIR}/validation-database-authority.json" ]]; then
    major="$(python3 - \
      "${TRANSACTION_DIR}/validation-database-authority.json" <<'PY'
import json
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
if document.get("schema") != "bridgesllm.validation-cluster-authority.v1":
    raise SystemExit(1)
print(document["postgresMajor"])
PY
    )" || return 1
  else
    return 0
  fi
  set_postgresql_client_toolchain "${major}" || return 1
  if [[ -e "${authority}" || -L "${authority}" ]]; then
    restore_database_peer_fields "${authority}" >/dev/null
  fi
}

assert_restore_database_crash_durability() {
  local result
  result="$(run_restore_peer_psql target -qAt --command="
SELECT json_build_object(
  'fsyncEnabled', current_setting('fsync') = 'on',
  'fullPageWritesEnabled', current_setting('full_page_writes') = 'on',
  'synchronousCommit', current_setting('synchronous_commit')
)::text;
")" || return 1
  python3 - "${result}" <<'PY'
import json
import sys
observed = json.loads(sys.argv[1])
expected = {
    "fsyncEnabled": True,
    "fullPageWritesEnabled": True,
    "synchronousCommit": "on",
}
raise SystemExit(0 if observed == expected else 1)
PY
}

force_restore_database_checkpoint() {
  assert_restore_database_crash_durability || return 1
  run_restore_peer_psql control -qAt --command="CHECKPOINT;" >/dev/null \
    || return 1
  assert_restore_database_crash_durability
}

assert_restore_database_control_snapshot() {
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local portal_role_literal observed_file
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  observed_file="$(mktemp \
    "${TRANSACTION_DIR}/.database-control-current.XXXXXX")" || return 1
  if ! run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'portalPasswordVerifier', owner.rolpassword,
  'portalValidUntil', owner.rolvaliduntil::text,
  'portalRoleSettings', COALESCE((
    SELECT to_jsonb(setting.setconfig)
    FROM pg_db_role_setting setting
    WHERE setting.setdatabase = 0
      AND setting.setrole = owner.oid
  ), '[]'::jsonb),
  'databaseScopedSettings', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'roleOid', canonical.setrole::bigint,
        'settings', canonical.settings
      )
      ORDER BY canonical.setrole
    )
    FROM (
      SELECT setting.setrole,
             to_jsonb(ARRAY(
               SELECT item
               FROM unnest(setting.setconfig) item
               ORDER BY item
             )) AS settings
      FROM pg_db_role_setting setting
      WHERE setting.setdatabase = d.oid
        AND NOT (
          setting.setrole = 0
          AND setting.setconfig =
            ARRAY['bridgesllm.exclusive_guard=${token}']::text[]
        )
    ) canonical
  ), '[]'::jsonb),
  'databaseAcl', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'grantor', acl.grantor::bigint,
        'grantee', acl.grantee::bigint,
        'privilegeType', acl.privilege_type,
        'grantable', acl.is_grantable
      )
      ORDER BY acl.grantor, acl.grantee, acl.privilege_type,
               acl.is_grantable
    )
    FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
  ), '[]'::jsonb)
)::text
FROM pg_database d
JOIN pg_authid owner ON owner.oid = d.datdba
WHERE d.datname = current_database()
  AND d.oid = ${database_oid}
  AND owner.rolname = ${portal_role_literal}
  AND owner.oid = ${portal_role_oid};
" >"${observed_file}"
  then
    rm -f -- "${observed_file}"
    return 1
  fi
  if ! python3 - "${TRANSACTION_DIR}/database-exclusion.json" \
    "${observed_file}" <<'PY'
import hashlib
import json
import os
import stat
import sys

authority_path, observed_path = sys.argv[1:]
for path in (authority_path, observed_path):
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 128 * 1024
    ):
        raise SystemExit(1)
authority = json.load(open(authority_path, "r", encoding="utf-8"))
expected = authority.get("databaseControlSnapshot")
if (
    not isinstance(expected, dict)
    or authority.get("databaseControlSnapshotSha256")
        != hashlib.sha256(
            json.dumps(expected, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
):
    raise SystemExit(1)
observed = json.load(open(observed_path, "r", encoding="utf-8"))
raise SystemExit(0 if observed == expected else 1)
PY
  then
    rm -f -- "${observed_file}"
    return 1
  fi
  rm -f -- "${observed_file}"
}

replay_restore_database_secret_control() {
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  if ! python3 - "${TRANSACTION_DIR}/database-exclusion.json" \
    "${portal_role}" <<'PY' \
    | run_restore_peer_psql control -qAt >/dev/null 2>/dev/null
import hashlib
import json
import os
import re
import stat
import sys

path, role = sys.argv[1:]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
snapshot = document.get("databaseControlSnapshot")
if (
    document.get("portalRoleName") != role
    or not isinstance(snapshot, dict)
    or document.get("databaseControlSnapshotSha256")
        != hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
):
    raise SystemExit(1)
verifier = snapshot.get("portalPasswordVerifier")
if not isinstance(verifier, str) or not re.fullmatch(
    r"SCRAM-SHA-256\$[1-9][0-9]*:"
    r"[A-Za-z0-9+/]+={0,2}\$"
    r"[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}",
    verifier,
):
    raise SystemExit(1)
identifier = '"' + role.replace('"', '""') + '"'
literal = "'" + role.replace("'", "''") + "'"
print("BEGIN;")
print("SET LOCAL synchronous_commit = on;")
print(
    "CREATE TEMP TABLE pg_temp.bridgesllm_restore_secret "
    "(verifier text NOT NULL) ON COMMIT DROP;"
)
print("COPY pg_temp.bridgesllm_restore_secret (verifier) FROM STDIN;")
print(verifier)
print(r"\.")
print("DO $bridgesllm$")
print("DECLARE restored_verifier text;")
print("BEGIN")
print(
    "  SELECT verifier INTO STRICT restored_verifier "
    "FROM pg_temp.bridgesllm_restore_secret;"
)
print(
    "  IF restored_verifier !~ "
    "'^SCRAM-SHA-256\\$[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}"
    "\\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$' THEN"
)
print("    RAISE EXCEPTION 'sealed password verifier is malformed';")
print("  END IF;")
print(
    "  EXECUTE format('ALTER ROLE %I PASSWORD %L', "
    f"{literal}, restored_verifier);"
)
print("END")
print("$bridgesllm$;")
print("COMMIT;")
PY
  then
    return 1
  fi
  force_restore_database_checkpoint \
    && assert_restore_database_control_snapshot
}

assert_restore_database_exclusion() {
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local result portal_role_literal
  assert_restore_database_crash_durability || return 1
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  result="$(run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'databaseName', current_database(),
  'databaseOid', (SELECT oid::bigint FROM pg_database
                  WHERE datname = current_database()),
  'databaseOwnerOid', (SELECT datdba::bigint FROM pg_database
                       WHERE datname = current_database()),
  'portalRoleOid', (SELECT oid::bigint FROM pg_roles
                    WHERE rolname = ${portal_role_literal}),
  'portalRoleCanLogin', (SELECT rolcanlogin FROM pg_roles
                         WHERE rolname = ${portal_role_literal}),
  'portalRoleCreateDb', (SELECT rolcreatedb FROM pg_roles
                         WHERE rolname = ${portal_role_literal}),
  'portalRoleCreateRole', (SELECT rolcreaterole FROM pg_roles
                           WHERE rolname = ${portal_role_literal}),
  'portalRoleReplication', (SELECT rolreplication FROM pg_roles
                            WHERE rolname = ${portal_role_literal}),
  'portalRoleBypassRls', (SELECT rolbypassrls FROM pg_roles
                          WHERE rolname = ${portal_role_literal}),
  'portalRoleInherit', (SELECT rolinherit FROM pg_roles
                        WHERE rolname = ${portal_role_literal}),
  'portalRoleConnectionLimit', (SELECT rolconnlimit FROM pg_roles
                                WHERE rolname = ${portal_role_literal}),
  'portalRoleValidUntilNull', (SELECT rolvaliduntil IS NULL FROM pg_authid
                               WHERE rolname = ${portal_role_literal}),
  'portalRolePasswordScram', (SELECT COALESCE(
      rolpassword LIKE 'SCRAM-SHA-256$%', false
    ) FROM pg_authid WHERE rolname = ${portal_role_literal}),
  'membershipEdges', (SELECT count(*) FROM pg_auth_members
                      WHERE roleid = ${portal_role_oid}
                         OR member = ${portal_role_oid}),
  'databaseAclDefault', (SELECT NOT EXISTS (
      (SELECT * FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba)))
       EXCEPT ALL
       SELECT * FROM aclexplode(acldefault('d', d.datdba)))
      UNION ALL
      (SELECT * FROM aclexplode(acldefault('d', d.datdba))
       EXCEPT ALL
       SELECT * FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))))
    ) FROM pg_database d WHERE d.datname = current_database()),
  'databaseScopedSettingsExact', (SELECT
      count(*) = 1 AND bool_and(
        setrole = 0
        AND setconfig = ARRAY['bridgesllm.exclusive_guard=${token}']::text[]
      )
    FROM pg_db_role_setting
    WHERE setdatabase = ${database_oid}),
  'portalGlobalSettings', (SELECT count(*) FROM pg_db_role_setting
                           WHERE setdatabase = 0
                             AND setrole = ${portal_role_oid}),
  'peerRoleOid', (SELECT oid::bigint FROM pg_roles
                  WHERE rolname = session_user),
  'peerRoleSuperuser', (SELECT rolsuper FROM pg_roles
                        WHERE rolname = session_user),
  'connectionLimit', (SELECT datconnlimit FROM pg_database
                      WHERE datname = current_database()),
  'guardToken', current_setting('bridgesllm.exclusive_guard', true),
  'targetClients', (SELECT count(*) FROM pg_stat_activity
                    WHERE datid = ${database_oid}
                      AND backend_type = 'client backend'
                      AND pid <> pg_backend_pid()),
  'portalRoleSessions', (SELECT count(*) FROM pg_stat_activity
                         WHERE usesysid = ${portal_role_oid}
                           AND pid <> pg_backend_pid()),
  'memberLoginRoles', (
    SELECT count(*) FROM pg_roles role
    WHERE role.oid <> ${portal_role_oid}
      AND role.rolcanlogin
      AND NOT role.rolsuper
      AND pg_has_role(role.oid, ${portal_role_oid}, 'MEMBER')
  ),
  'preparedTransactions', (SELECT count(*) FROM pg_prepared_xacts
                           WHERE database = current_database()
                              OR owner = ${portal_role_literal})
)::text;
")" || return 1
  python3 - "${result}" "${database}" "${database_oid}" "${portal_role_oid}" \
    "${peer_role_oid}" "${token}" "${system_identifier}" <<'PY'
import json
import sys
(
    raw,
    database,
    database_oid,
    portal_role_oid,
    peer_role_oid,
    token,
    system_identifier,
) = sys.argv[1:]
observed = json.loads(raw)
if observed != {
    "systemIdentifier": system_identifier,
    "databaseName": database,
    "databaseOid": int(database_oid),
    "databaseOwnerOid": int(portal_role_oid),
    "portalRoleOid": int(portal_role_oid),
    "portalRoleCanLogin": False,
    "portalRoleCreateDb": False,
    "portalRoleCreateRole": False,
    "portalRoleReplication": False,
    "portalRoleBypassRls": False,
    "portalRoleInherit": True,
    "portalRoleConnectionLimit": -1,
    "portalRoleValidUntilNull": True,
    "portalRolePasswordScram": True,
    "membershipEdges": 0,
    "databaseAclDefault": True,
    "databaseScopedSettingsExact": True,
    "portalGlobalSettings": 0,
    "peerRoleOid": int(peer_role_oid),
    "peerRoleSuperuser": True,
    "connectionLimit": 0,
    "guardToken": token,
    "targetClients": 0,
    "portalRoleSessions": 0,
    "memberLoginRoles": 0,
    "preparedTransactions": 0,
}:
    raise SystemExit(1)
PY
  assert_restore_database_control_snapshot
}

normalize_restore_database_control_contract() {
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local database_identifier portal_role_identifier
  local database_literal portal_role_literal
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  database_identifier="$(sql_identifier "${database}")" || return 1
  portal_role_identifier="$(sql_identifier "${portal_role}")" || return 1
  database_literal="$(sql_literal "${database}")" || return 1
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  run_restore_peer_psql control -qAt <<SQL >/dev/null || return 1
SET search_path TO pg_catalog;
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '60s';
SET LOCAL synchronous_commit = on;
DO \$bridgesllm\$
DECLARE
  setting record;
  membership record;
BEGIN
  IF (pg_control_system()).system_identifier::text <> '${system_identifier}'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_database d
       JOIN pg_authid owner ON owner.oid = d.datdba
       WHERE d.datname = ${database_literal}
         AND d.oid = ${database_oid}
         AND owner.rolname = ${portal_role_literal}
         AND owner.oid = ${portal_role_oid}
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_db_role_setting scoped
       CROSS JOIN LATERAL unnest(scoped.setconfig) item
       WHERE scoped.setdatabase = ${database_oid}
         AND scoped.setrole = 0
         AND item = 'bridgesllm.exclusive_guard=${token}'
     ) THEN
    RAISE EXCEPTION 'database control normalization authority changed';
  END IF;
  FOR setting IN
    SELECT scoped.setrole, role.rolname
    FROM pg_db_role_setting scoped
    LEFT JOIN pg_roles role ON role.oid = scoped.setrole
    WHERE scoped.setdatabase = ${database_oid}
  LOOP
    IF setting.setrole = 0 THEN
      EXECUTE format('ALTER DATABASE %I RESET ALL', ${database_literal});
    ELSIF setting.rolname IS NULL THEN
      RAISE EXCEPTION 'database-scoped setting references a missing role';
    ELSE
      EXECUTE format(
        'ALTER ROLE %I IN DATABASE %I RESET ALL',
        setting.rolname,
        ${database_literal}
      );
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_db_role_setting
    WHERE setdatabase = 0 AND setrole = ${portal_role_oid}
  ) THEN
    EXECUTE format('ALTER ROLE %I RESET ALL', ${portal_role_literal});
  END IF;
  FOR membership IN
    SELECT granted.rolname AS granted_name, member.rolname AS member_name
    FROM pg_auth_members edge
    JOIN pg_roles granted ON granted.oid = edge.roleid
    JOIN pg_roles member ON member.oid = edge.member
    WHERE edge.roleid = ${portal_role_oid}
       OR edge.member = ${portal_role_oid}
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I',
      membership.granted_name,
      membership.member_name
    );
  END LOOP;
END
\$bridgesllm\$;
ALTER ROLE ${portal_role_identifier}
  NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE
  NOLOGIN NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;
SET LOCAL ROLE ${portal_role_identifier};
REVOKE ALL PRIVILEGES ON DATABASE ${database_identifier} FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE ${database_identifier}
  FROM ${portal_role_identifier};
GRANT CONNECT, TEMPORARY ON DATABASE ${database_identifier} TO PUBLIC;
GRANT ALL PRIVILEGES ON DATABASE ${database_identifier}
  TO ${portal_role_identifier};
RESET ROLE;
ALTER DATABASE ${database_identifier} CONNECTION LIMIT 0;
ALTER DATABASE ${database_identifier}
  SET bridgesllm.exclusive_guard TO '${token}';
COMMIT;
SQL
  replay_restore_database_secret_control \
    && assert_restore_database_exclusion
}

assert_restore_database_released() {
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local portal_role_literal result
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  result="$(run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'databaseName', current_database(),
  'databaseOid', d.oid::bigint,
  'databaseOwnerOid', d.datdba::bigint,
  'portalRoleOid', owner.oid::bigint,
  'portalRoleCanLogin', owner.rolcanlogin,
  'portalRoleSuperuser', owner.rolsuper,
  'portalRoleCreateDb', owner.rolcreatedb,
  'portalRoleCreateRole', owner.rolcreaterole,
  'portalRoleReplication', owner.rolreplication,
  'portalRoleBypassRls', owner.rolbypassrls,
  'portalRoleInherit', owner.rolinherit,
  'portalRoleConnectionLimit', owner.rolconnlimit,
  'portalRoleValidUntilNull', owner.rolvaliduntil IS NULL,
  'membershipEdges', (SELECT count(*) FROM pg_auth_members
                      WHERE roleid = owner.oid OR member = owner.oid),
  'databaseAclDefault', NOT EXISTS (
    (SELECT * FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba)))
     EXCEPT ALL
     SELECT * FROM aclexplode(acldefault('d', d.datdba)))
    UNION ALL
    (SELECT * FROM aclexplode(acldefault('d', d.datdba))
     EXCEPT ALL
     SELECT * FROM aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))))
  ),
  'databaseScopedSettings', (SELECT count(*) FROM pg_db_role_setting
                             WHERE setdatabase = d.oid),
  'portalGlobalSettings', (SELECT count(*) FROM pg_db_role_setting
                           WHERE setdatabase = 0
                             AND setrole = owner.oid),
  'peerRoleOid', peer.oid::bigint,
  'peerRoleSuperuser', peer.rolsuper,
  'connectionLimit', d.datconnlimit,
  'guardToken', COALESCE(
    current_setting('bridgesllm.exclusive_guard', true), ''
  ),
  'preparedTransactions', (SELECT count(*) FROM pg_prepared_xacts
                           WHERE database = current_database()
                              OR owner = ${portal_role_literal})
)::text
FROM pg_database d
JOIN pg_authid owner ON owner.oid = d.datdba
JOIN pg_roles peer ON peer.rolname = session_user
WHERE d.datname = current_database();
")" || return 1
  python3 - "${result}" "${database}" "${database_oid}" \
    "${portal_role_oid}" "${peer_role_oid}" "${original_limit}" \
    "${system_identifier}" <<'PY' || return 1
import json
import sys
(
    raw,
    database,
    database_oid,
    portal_role_oid,
    peer_role_oid,
    original_limit,
    system_identifier,
) = sys.argv[1:]
observed = json.loads(raw)
expected = {
    "systemIdentifier": system_identifier,
    "databaseName": database,
    "databaseOid": int(database_oid),
    "databaseOwnerOid": int(portal_role_oid),
    "portalRoleOid": int(portal_role_oid),
    "portalRoleCanLogin": True,
    "portalRoleSuperuser": False,
    "portalRoleCreateDb": False,
    "portalRoleCreateRole": False,
    "portalRoleReplication": False,
    "portalRoleBypassRls": False,
    "portalRoleInherit": True,
    "portalRoleConnectionLimit": -1,
    "portalRoleValidUntilNull": True,
    "membershipEdges": 0,
    "databaseAclDefault": True,
    "databaseScopedSettings": 0,
    "portalGlobalSettings": 0,
    "peerRoleOid": int(peer_role_oid),
    "peerRoleSuperuser": True,
    "connectionLimit": int(original_limit),
    "guardToken": "",
    "preparedTransactions": 0,
}
raise SystemExit(0 if observed == expected else 1)
PY
  assert_restore_database_control_snapshot
}

settle_restore_database_exclusion() {
  local path="${TRANSACTION_DIR}/database-exclusion.json"
  [[ -e "${path}" || -L "${path}" ]] || return 0
  cleanup_restore_validation_database || return 1
  if assert_restore_database_released; then
    return 0
  fi
  normalize_restore_database_control_contract || return 1
  assert_restore_database_crash_durability || return 1
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local database_literal portal_role_literal peer_role_literal state disposition
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  database_literal="$(sql_literal "${database}")" || return 1
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  peer_role_literal="$(sql_literal "${peer_role}")" || return 1
  state="$(run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'databaseName', current_database(),
  'databaseOid', (SELECT oid::bigint FROM pg_database
                  WHERE datname = current_database()),
  'databaseOwnerOid', (SELECT datdba::bigint FROM pg_database
                       WHERE datname = current_database()),
  'portalRoleOid', (SELECT oid::bigint FROM pg_roles
                    WHERE rolname = ${portal_role_literal}),
  'portalRoleCanLogin', (SELECT rolcanlogin FROM pg_roles
                         WHERE rolname = ${portal_role_literal}),
  'peerRoleOid', (SELECT oid::bigint FROM pg_roles
                  WHERE rolname = session_user),
  'peerRoleSuperuser', (SELECT rolsuper FROM pg_roles
                        WHERE rolname = session_user),
  'connectionLimit', (SELECT datconnlimit FROM pg_database
                      WHERE datname = current_database()),
  'guardToken', COALESCE(
    current_setting('bridgesllm.exclusive_guard', true), ''
  )
)::text;
")" || return 1
  disposition="$(python3 - "${state}" "${database}" "${database_oid}" \
    "${portal_role_oid}" "${peer_role_oid}" "${original_limit}" "${token}" \
    "${system_identifier}" <<'PY'
import json
import sys
(
    raw,
    database,
    database_oid,
    portal_role_oid,
    peer_role_oid,
    original_limit,
    token,
    system_identifier,
) = sys.argv[1:]
observed = json.loads(raw)
common = {
    "systemIdentifier": system_identifier,
    "databaseName": database,
    "databaseOid": int(database_oid),
    "databaseOwnerOid": int(portal_role_oid),
    "portalRoleOid": int(portal_role_oid),
    "peerRoleOid": int(peer_role_oid),
    "peerRoleSuperuser": True,
}
if observed == {
    **common,
    "portalRoleCanLogin": True,
    "connectionLimit": int(original_limit),
    "guardToken": "",
}:
    print("restored")
elif observed == {
    **common,
    "portalRoleCanLogin": False,
    "connectionLimit": 0,
    "guardToken": token,
}:
    print("held")
else:
    raise SystemExit(1)
PY
  )" || return 1
  [[ "${disposition}" == "held" ]] || [[ "${disposition}" == "restored" ]]
  if [[ "${disposition}" == "restored" ]]; then
    return 0
  fi
  run_restore_peer_psql control -qAt <<SQL >/dev/null || return 1
SET search_path TO pg_catalog;
DO \$bridgesllm\$
DECLARE
  deadline timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  IF (pg_control_system()).system_identifier::text <> '${system_identifier}'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_database d
       JOIN pg_roles owner ON owner.oid = d.datdba
       JOIN pg_roles peer ON peer.rolname = session_user
       WHERE d.datname = ${database_literal}
         AND d.oid = ${database_oid}
         AND d.datconnlimit = 0
         AND d.datallowconn
         AND owner.rolname = ${portal_role_literal}
         AND owner.oid = ${portal_role_oid}
         AND NOT owner.rolcanlogin
         AND peer.rolname = ${peer_role_literal}
         AND peer.oid = ${peer_role_oid}
         AND peer.rolsuper
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_db_role_setting setting
       CROSS JOIN LATERAL unnest(setting.setconfig) item
       WHERE setting.setdatabase = ${database_oid}
         AND setting.setrole = 0
         AND item = 'bridgesllm.exclusive_guard=${token}'
     )
     OR EXISTS (
       SELECT 1 FROM pg_roles role
       WHERE role.oid <> ${portal_role_oid}
         AND role.rolcanlogin
         AND NOT role.rolsuper
         AND pg_has_role(role.oid, ${portal_role_oid}, 'MEMBER')
     )
     OR EXISTS (
       SELECT 1 FROM pg_prepared_xacts
       WHERE database = ${database_literal}
          OR owner = ${portal_role_literal}
     ) THEN
    RAISE EXCEPTION 'database exclusion changed while settling clients';
  END IF;
  LOOP
    PERFORM pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE (
        usesysid = ${portal_role_oid}
        OR (datid = ${database_oid} AND backend_type = 'client backend')
      )
      AND pid <> pg_backend_pid();
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE (
          usesysid = ${portal_role_oid}
          OR (datid = ${database_oid} AND backend_type = 'client backend')
        )
        AND pid <> pg_backend_pid()
    );
    IF clock_timestamp() >= deadline THEN
      RAISE EXCEPTION 'database clients did not settle';
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
\$bridgesllm\$;
SQL
  assert_restore_database_exclusion
}

acquire_restore_database_exclusion() {
  capture_restore_database_peer_authority || return 1
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local database_identifier portal_role_identifier
  local database_literal portal_role_literal peer_role_literal
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  database_identifier="$(sql_identifier "${database}")" || return 1
  portal_role_identifier="$(sql_identifier "${portal_role}")" || return 1
  database_literal="$(sql_literal "${database}")" || return 1
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  peer_role_literal="$(sql_literal "${peer_role}")" || return 1
  run_restore_peer_psql control -qAt <<SQL >/dev/null || return 1
SET search_path TO pg_catalog;
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '60s';
SET LOCAL synchronous_commit = on;
DO \$bridgesllm\$
BEGIN
  IF (pg_control_system()).system_identifier::text <> '${system_identifier}'
     OR current_setting('fsync') <> 'on'
     OR current_setting('full_page_writes') <> 'on'
     OR current_setting('synchronous_commit') <> 'on' THEN
    RAISE EXCEPTION 'database cluster identity changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_database d
    JOIN pg_authid owner ON owner.oid = d.datdba
    JOIN pg_roles peer ON peer.rolname = session_user
    WHERE d.datname = ${database_literal}
      AND d.oid = ${database_oid}
      AND owner.rolname = ${portal_role_literal}
      AND owner.oid = ${portal_role_oid}
      AND NOT owner.rolsuper
      AND owner.rolcanlogin
      AND NOT owner.rolcreatedb
      AND NOT owner.rolcreaterole
      AND NOT owner.rolreplication
      AND NOT owner.rolbypassrls
      AND owner.rolinherit
      AND owner.rolconnlimit = -1
      AND owner.rolvaliduntil IS NULL
      AND owner.rolpassword LIKE 'SCRAM-SHA-256$%'
      AND peer.rolname = ${peer_role_literal}
      AND peer.oid = ${peer_role_oid}
      AND peer.rolsuper
      AND d.datallowconn
      AND d.datconnlimit = ${original_limit}
  ) THEN
    RAISE EXCEPTION 'database exclusivity admission changed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    WHERE setting.setdatabase = ${database_oid}
       OR (setting.setdatabase = 0 AND setting.setrole = ${portal_role_oid})
  ) THEN
    RAISE EXCEPTION 'managed database or Portal role settings are not empty';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
    WHERE membership.roleid = ${portal_role_oid}
       OR membership.member = ${portal_role_oid}
  ) THEN
    RAISE EXCEPTION 'Portal role membership graph is not empty';
  END IF;
  IF EXISTS (
    (SELECT * FROM aclexplode((
       SELECT COALESCE(datacl, acldefault('d', datdba))
       FROM pg_database WHERE oid = ${database_oid}
     ))
     EXCEPT ALL
     SELECT * FROM aclexplode(acldefault('d', ${portal_role_oid})))
    UNION ALL
    (SELECT * FROM aclexplode(acldefault('d', ${portal_role_oid}))
     EXCEPT ALL
     SELECT * FROM aclexplode((
       SELECT COALESCE(datacl, acldefault('d', datdba))
       FROM pg_database WHERE oid = ${database_oid}
     )))
  ) THEN
    RAISE EXCEPTION 'Portal database ACL is not the semantic default';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_prepared_xacts
    WHERE database = ${database_literal}
       OR owner = ${portal_role_literal}
  ) THEN
    RAISE EXCEPTION 'prepared transactions prevent database exclusivity';
  END IF;
END
\$bridgesllm\$;
ALTER ROLE ${portal_role_identifier} NOLOGIN;
ALTER DATABASE ${database_identifier} CONNECTION LIMIT 0;
ALTER DATABASE ${database_identifier}
  SET bridgesllm.exclusive_guard TO '${token}';
COMMIT;
SQL
  force_restore_database_checkpoint \
    && settle_restore_database_exclusion \
    && assert_restore_database_exclusion
}

release_restore_database_exclusion() {
  local path="${TRANSACTION_DIR}/database-exclusion.json"
  [[ -e "${path}" || -L "${path}" ]] || return 0
  settle_restore_database_exclusion || return 1
  local values database database_oid portal_role portal_role_oid
  local peer_role peer_role_oid original_limit token system_identifier
  local database_identifier portal_role_identifier
  local database_literal portal_role_literal peer_role_literal state disposition
  values="$(BRIDGESLLM_TRANSACTION_ID="${TRANSACTION_ID}" \
    restore_database_exclusion_values)" || return 1
  IFS=$'\t' read -r database database_oid portal_role portal_role_oid \
    peer_role peer_role_oid original_limit token system_identifier <<<"${values}"
  database_identifier="$(sql_identifier "${database}")" || return 1
  portal_role_identifier="$(sql_identifier "${portal_role}")" || return 1
  database_literal="$(sql_literal "${database}")" || return 1
  portal_role_literal="$(sql_literal "${portal_role}")" || return 1
  peer_role_literal="$(sql_literal "${peer_role}")" || return 1
  state="$(run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'exclusionState', 'database-exclusion-v1',
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'databaseName', current_database(),
  'databaseOid', (SELECT oid::bigint FROM pg_database
                  WHERE datname = current_database()),
  'databaseOwnerOid', (SELECT datdba::bigint FROM pg_database
                       WHERE datname = current_database()),
  'portalRoleOid', (SELECT oid::bigint FROM pg_roles
                    WHERE rolname = ${portal_role_literal}),
  'portalRoleCanLogin', (SELECT rolcanlogin FROM pg_roles
                         WHERE rolname = ${portal_role_literal}),
  'peerRoleOid', (SELECT oid::bigint FROM pg_roles
                  WHERE rolname = session_user),
  'peerRoleSuperuser', (SELECT rolsuper FROM pg_roles
                        WHERE rolname = session_user),
  'connectionLimit', (SELECT datconnlimit FROM pg_database
                      WHERE datname = current_database()),
  'guardToken', COALESCE(
    current_setting('bridgesllm.exclusive_guard', true), ''
  ),
  'targetClients', (SELECT count(*) FROM pg_stat_activity
                    WHERE datid = ${database_oid}
                      AND backend_type = 'client backend'
                      AND pid <> pg_backend_pid()),
  'portalRoleSessions', (SELECT count(*) FROM pg_stat_activity
                         WHERE usesysid = ${portal_role_oid}
                           AND pid <> pg_backend_pid()),
  'memberLoginRoles', (
    SELECT count(*) FROM pg_roles role
    WHERE role.oid <> ${portal_role_oid}
      AND role.rolcanlogin
      AND NOT role.rolsuper
      AND pg_has_role(role.oid, ${portal_role_oid}, 'MEMBER')
  ),
  'preparedTransactions', (SELECT count(*) FROM pg_prepared_xacts
                           WHERE database = current_database()
                              OR owner = ${portal_role_literal})
)::text;
")" || return 1
  disposition="$(python3 - "${state}" "${database}" "${database_oid}" \
    "${portal_role_oid}" "${peer_role_oid}" "${original_limit}" "${token}" \
    "${system_identifier}" <<'PY'
import json
import sys
(
    raw,
    database,
    database_oid,
    portal_role_oid,
    peer_role_oid,
    original_limit,
    token,
    system_identifier,
) = sys.argv[1:]
observed = json.loads(raw)
common = {
    "exclusionState": "database-exclusion-v1",
    "systemIdentifier": system_identifier,
    "databaseName": database,
    "databaseOid": int(database_oid),
    "databaseOwnerOid": int(portal_role_oid),
    "portalRoleOid": int(portal_role_oid),
    "peerRoleOid": int(peer_role_oid),
    "peerRoleSuperuser": True,
}
held = {
    **common,
    "portalRoleCanLogin": False,
    "connectionLimit": 0,
    "guardToken": token,
    "targetClients": 0,
    "portalRoleSessions": 0,
    "memberLoginRoles": 0,
    "preparedTransactions": 0,
}
restored = {
    **common,
    "portalRoleCanLogin": True,
    "connectionLimit": int(original_limit),
    "guardToken": "",
}
expected_keys = set(held)
if set(observed) != expected_keys:
    raise SystemExit(1)
if observed == held:
    print("held")
elif all(observed.get(key) == value for key, value in restored.items()):
    print("restored")
else:
    raise SystemExit(1)
PY
  )" || return 1
  if [[ "${disposition}" == "restored" ]]; then
    return 0
  fi
  [[ "${disposition}" == "held" ]] || return 1
  run_restore_peer_psql control -qAt <<SQL >/dev/null || return 1
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '60s';
SET LOCAL synchronous_commit = on;
DO \$bridgesllm\$
BEGIN
  IF (pg_control_system()).system_identifier::text <> '${system_identifier}'
     OR current_setting('fsync') <> 'on'
     OR current_setting('full_page_writes') <> 'on'
     OR current_setting('synchronous_commit') <> 'on'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_database d
       JOIN pg_roles owner ON owner.oid = d.datdba
       JOIN pg_roles peer ON peer.rolname = session_user
       WHERE d.datname = ${database_literal}
         AND d.oid = ${database_oid}
         AND d.datconnlimit = 0
         AND d.datallowconn
         AND owner.rolname = ${portal_role_literal}
         AND owner.oid = ${portal_role_oid}
         AND NOT owner.rolcanlogin
         AND peer.rolname = ${peer_role_literal}
         AND peer.oid = ${peer_role_oid}
         AND peer.rolsuper
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_db_role_setting setting
       CROSS JOIN LATERAL unnest(setting.setconfig) item
       WHERE setting.setdatabase = ${database_oid}
         AND setting.setrole = 0
         AND item = 'bridgesllm.exclusive_guard=${token}'
     )
     OR EXISTS (
       SELECT 1 FROM pg_stat_activity
       WHERE usesysid = ${portal_role_oid}
          OR (datid = ${database_oid} AND backend_type = 'client backend')
     )
     OR EXISTS (
       SELECT 1 FROM pg_prepared_xacts
       WHERE database = ${database_literal}
          OR owner = ${portal_role_literal}
     )
     OR EXISTS (
       SELECT 1 FROM pg_roles role
       WHERE role.oid <> ${portal_role_oid}
         AND role.rolcanlogin
         AND NOT role.rolsuper
         AND pg_has_role(role.oid, ${portal_role_oid}, 'MEMBER')
     ) THEN
    RAISE EXCEPTION 'database exclusion changed before release';
  END IF;
END
\$bridgesllm\$;
ALTER DATABASE ${database_identifier} RESET bridgesllm.exclusive_guard;
ALTER DATABASE ${database_identifier} CONNECTION LIMIT ${original_limit};
ALTER ROLE ${portal_role_identifier} LOGIN;
COMMIT;
SQL
  force_restore_database_checkpoint || return 1
  state="$(run_restore_peer_psql target -qAt --command="
SET search_path TO pg_catalog;
SELECT json_build_object(
  'exclusionState', 'database-exclusion-v1',
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'databaseName', current_database(),
  'databaseOid', (SELECT oid::bigint FROM pg_database
                  WHERE datname = current_database()),
  'databaseOwnerOid', (SELECT datdba::bigint FROM pg_database
                       WHERE datname = current_database()),
  'portalRoleOid', (SELECT oid::bigint FROM pg_roles
                    WHERE rolname = ${portal_role_literal}),
  'portalRoleCanLogin', (SELECT rolcanlogin FROM pg_roles
                         WHERE rolname = ${portal_role_literal}),
  'peerRoleOid', (SELECT oid::bigint FROM pg_roles
                  WHERE rolname = session_user),
  'peerRoleSuperuser', (SELECT rolsuper FROM pg_roles
                        WHERE rolname = session_user),
  'connectionLimit', (SELECT datconnlimit FROM pg_database
                      WHERE datname = current_database()),
  'guardToken', COALESCE(
    current_setting('bridgesllm.exclusive_guard', true), ''
  ),
  'targetClients', (SELECT count(*) FROM pg_stat_activity
                    WHERE datid = ${database_oid}
                      AND backend_type = 'client backend'
                      AND pid <> pg_backend_pid()),
  'portalRoleSessions', (SELECT count(*) FROM pg_stat_activity
                         WHERE usesysid = ${portal_role_oid}
                           AND pid <> pg_backend_pid()),
  'memberLoginRoles', (
    SELECT count(*) FROM pg_roles role
    WHERE role.oid <> ${portal_role_oid}
      AND role.rolcanlogin
      AND NOT role.rolsuper
      AND pg_has_role(role.oid, ${portal_role_oid}, 'MEMBER')
  ),
  'preparedTransactions', (SELECT count(*) FROM pg_prepared_xacts
                           WHERE database = current_database()
                              OR owner = ${portal_role_literal})
)::text;
")" || return 1
  python3 - "${state}" "${database}" "${database_oid}" "${portal_role_oid}" \
    "${peer_role_oid}" "${original_limit}" "${system_identifier}" <<'PY'
import json
import sys
(
    raw,
    database,
    database_oid,
    portal_role_oid,
    peer_role_oid,
    original_limit,
    system_identifier,
) = sys.argv[1:]
observed = json.loads(raw)
expected = {
    "exclusionState": "database-exclusion-v1",
    "systemIdentifier": system_identifier,
    "databaseName": database,
    "databaseOid": int(database_oid),
    "databaseOwnerOid": int(portal_role_oid),
    "portalRoleOid": int(portal_role_oid),
    "portalRoleCanLogin": True,
    "peerRoleOid": int(peer_role_oid),
    "peerRoleSuperuser": True,
    "connectionLimit": int(original_limit),
    "guardToken": "",
}
expected_keys = set(expected) | {
    "targetClients",
    "portalRoleSessions",
    "memberLoginRoles",
    "preparedTransactions",
}
if (
    set(observed) != expected_keys
    or any(observed.get(key) != value for key, value in expected.items())
):
    raise SystemExit(1)
PY
  assert_restore_database_released
}

activate_sealed_recovery_authority() {
  local runtime="${TRANSACTION_DIR}/recovery-runtime"
  [[ -d "${runtime}" && ! -L "${runtime}" \
    && "$(stat -c '%u:%g:%a' "${runtime}" 2>/dev/null)" == "0:0:700" \
    && -d "${runtime}/installer" && ! -L "${runtime}/installer" \
    && "$(stat -c '%u:%g:%a' "${runtime}/installer" 2>/dev/null)" == "0:0:700" \
    && -f "${runtime}/restore-full.sh" && ! -L "${runtime}/restore-full.sh" \
    && -f "${runtime}/backup-full.sh" && ! -L "${runtime}/backup-full.sh" \
    && -f "${runtime}/installer/install.sh" \
    && ! -L "${runtime}/installer/install.sh" \
    && -f "${runtime}/installer/portal-recovery-archive.py" \
    && ! -L "${runtime}/installer/portal-recovery-archive.py" ]] || return 1
  AUTHORITY_ROOT="${runtime}"
  BACKUP_SCRIPT="${AUTHORITY_ROOT}/backup-full.sh"
  ARCHIVE_HELPER="${AUTHORITY_ROOT}/installer/portal-recovery-archive.py"
}

assert_sealed_recovery_authority() {
  activate_sealed_recovery_authority || return 1
  python3 - "${ADMISSION_FILE}" "${AUTHORITY_ROOT}" \
    "${TRANSACTION_DIR}/database-authority.env" "${RECOVERY_LAUNCHER}" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

admission_path, authority_root, sealed_env, launcher = sys.argv[1:]
document = json.load(open(admission_path, "r", encoding="utf-8"))
authority = document.get("recoveryAuthority")
expected_paths = {
    "restore-full.sh",
    "backup-full.sh",
    "backend/.env.production",
    "installer/install.sh",
    "installer/portal-recovery-archive.py",
}
if (
    document.get("schema") != "bridgesllm.restore-admission.v2"
    or not isinstance(authority, dict)
    or set(authority) != expected_paths
):
    raise SystemExit(1)

def digest_regular(path: pathlib.Path, *, executable: bool = False) -> str:
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or (executable and not info.st_mode & 0o100)
        or info.st_size <= 0
        or info.st_size > 32 * 1024 * 1024
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

root = pathlib.Path(authority_root)
for relative, expected in authority.items():
    if (
        not isinstance(expected, str)
        or len(expected) != 64
        or any(character not in "0123456789abcdef" for character in expected)
    ):
        raise SystemExit(1)
    path = pathlib.Path(sealed_env) if relative == "backend/.env.production" else root / relative
    actual = digest_regular(
        path,
        executable=relative in {
            "restore-full.sh", "backup-full.sh", "installer/install.sh"
        },
    )
    if actual != expected:
        raise SystemExit(1)
launcher_info = os.lstat(launcher)
if (
    not stat.S_ISREG(launcher_info.st_mode)
    or stat.S_ISLNK(launcher_info.st_mode)
    or launcher_info.st_uid != 0
    or launcher_info.st_gid != 0
    or launcher_info.st_nlink != 1
    or stat.S_IMODE(launcher_info.st_mode) != 0o700
    or launcher_info.st_size <= 0
    or launcher_info.st_size > 64 * 1024
):
    raise SystemExit(1)
PY
}

seal_recovery_authority() {
  local runtime="${TRANSACTION_DIR}/recovery-runtime"
  local launcher_temporary=""
  local -a launcher_environment=(
    PORTAL_ROOT "${PORTAL_DIR}"
    BRIDGESLLM_RESTORE_STATE_ROOT "${STATE_ROOT}"
    BRIDGESLLM_PORTAL_OPERATION_LOCK "${OPERATION_LOCK}"
    BRIDGESLLM_BACKUP_RECOVERY_STATE_DIR "${BACKUP_RECOVERY_STATE_DIR}"
    BRIDGESLLM_RESTORE_TRUST_ROOT "${RESTORE_TRUST_ROOT}"
    BRIDGESLLM_RESTORE_SYSTEMD_ROOT "${SYSTEMD_ROOT}"
    BRIDGESLLM_RESTORE_VALIDATION_PORT "${RESTORE_PORT}"
    BRIDGESLLM_RESTORE_RESERVE_BYTES "${RESERVE_BYTES}"
  )
  if [[ -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]]; then
    launcher_environment+=(
      BRIDGESLLM_RESTORE_TEST_ROOT "${BRIDGESLLM_RESTORE_TEST_ROOT}"
      BRIDGESLLM_RESTORE_INSTALLER_STATE_ROOT "${INSTALLER_STATE_ROOT}"
      BRIDGESLLM_RESTORE_SYSTEMCTL_BIN "${RESTORE_SYSTEMCTL_BIN}"
      BRIDGESLLM_RESTORE_DOCKER_BIN "${RESTORE_DOCKER_BIN}"
      BRIDGESLLM_RESTORE_SYSTEMD_RUN_BIN "${RESTORE_SYSTEMD_RUN_BIN}"
      BRIDGESLLM_RESTORE_CURL_BIN "${RESTORE_CURL_BIN}"
      BRIDGESLLM_RESTORE_PG_DUMP_BIN "${RESTORE_PG_DUMP_BIN}"
      BRIDGESLLM_RESTORE_PG_RESTORE_BIN "${RESTORE_PG_RESTORE_BIN}"
      BRIDGESLLM_RESTORE_PSQL_BIN "${RESTORE_PSQL_BIN}"
      BRIDGESLLM_RESTORE_NPX_BIN "${RESTORE_NPX_BIN}"
    )
  fi
  [[ ! -e "${runtime}" && ! -L "${runtime}" \
    && ! -e "${RECOVERY_LAUNCHER}" && ! -L "${RECOVERY_LAUNCHER}" ]] \
    || return 1
  install -d -m 700 -o root -g root "${runtime}" "${runtime}/installer" \
    || return 1
  install -m 700 -o root -g root -- \
    "${SCRIPT_DIR}/restore-full.sh" "${runtime}/restore-full.sh" \
    || return 1
  install -m 700 -o root -g root -- \
    "${SCRIPT_DIR}/backup-full.sh" "${runtime}/backup-full.sh" \
    || return 1
  install -m 700 -o root -g root -- \
    "${SCRIPT_DIR}/installer/install.sh" "${runtime}/installer/install.sh" \
    || return 1
  install -m 600 -o root -g root -- \
    "${SCRIPT_DIR}/installer/portal-recovery-archive.py" \
    "${runtime}/installer/portal-recovery-archive.py" \
    || return 1
  sync -f -- \
    "${runtime}/restore-full.sh" \
    "${runtime}/backup-full.sh" \
    "${runtime}/installer/install.sh" \
    "${runtime}/installer/portal-recovery-archive.py" \
    || return 1
  fsync_directory "${runtime}/installer" \
    && fsync_directory "${runtime}" \
    && fsync_directory "${TRANSACTION_DIR}" \
    || return 1
  launcher_temporary="${STATE_ROOT}/.recover-current-${TRANSACTION_ID}"
  [[ ! -e "${launcher_temporary}" && ! -L "${launcher_temporary}" ]] \
    || return 1
  if ! python3 - "${launcher_temporary}" "${runtime}/restore-full.sh" \
      "${launcher_environment[@]}" <<'PY'
import os
import shlex
import stat
import sys

target, runtime, *pairs = sys.argv[1:]
if (
    len(pairs) % 2
    or not os.path.isabs(target)
    or not os.path.isabs(runtime)
    or os.path.normpath(target) != target
    or os.path.normpath(runtime) != runtime
):
    raise SystemExit(1)
environment = {}
for index in range(0, len(pairs), 2):
    name, value = pairs[index:index + 2]
    if (
        not name
        or not name.replace("_", "").isalnum()
        or not name[0].isalpha()
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise SystemExit(1)
    if value:
        environment[name] = value
lines = [
    "#!/bin/bash",
    "set -Eeuo pipefail",
    "exec /usr/bin/env -i " + " ".join(
        [
            "PATH=/usr/bin:/bin",
            "LANG=C",
            "LC_ALL=C",
            *[
                f"{name}={shlex.quote(value)}"
                for name, value in sorted(environment.items())
            ],
        ]
    ) + " /bin/bash " + shlex.quote(runtime) + " --recover",
    "",
]
descriptor = os.open(
    target,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
    ):
        raise SystemExit(1)
    os.fchmod(descriptor, 0o700)
    payload = "\n".join(lines).encode("utf-8")
    written = 0
    while written < len(payload):
        count = os.write(descriptor, payload[written:])
        if count <= 0:
            raise OSError("short recovery launcher write")
        written += count
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  then
    rm -f -- "${launcher_temporary}"
    return 1
  fi
  [[ "$(stat -c '%u:%g:%a:%h' "${launcher_temporary}" 2>/dev/null)" \
    == "0:0:700:1" ]] || { rm -f -- "${launcher_temporary}"; return 1; }
  mv -f -- "${launcher_temporary}" "${RECOVERY_LAUNCHER}" || return 1
  fsync_directory "${STATE_ROOT}" || return 1
  activate_sealed_recovery_authority
}

prepare_operation_lock() {
  python3 - "${OPERATION_LOCK}" <<'PY'
import errno
import os
import stat
import sys

path = sys.argv[1]
if not os.path.isabs(path) or os.path.normpath(path) != path or os.geteuid() != 0:
    raise SystemExit(1)
current = os.path.sep
for component in os.path.dirname(path).strip(os.path.sep).split(os.path.sep):
    if not component:
        continue
    current = os.path.join(current, component)
    info = os.lstat(current)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
        raise SystemExit(1)
    if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
        raise SystemExit(1)
flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
try:
    descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    descriptor = os.open(path, flags)
info = os.fstat(descriptor)
if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
        or info.st_nlink != 1 or info.st_size != 0 or info.st_mode & 0o022):
    raise SystemExit(1)
os.fchmod(descriptor, 0o600)
os.close(descriptor)
PY
}

acquire_operation_lock() {
  prepare_operation_lock || die "Portal operation lock is unsafe"
  exec 9<>"${OPERATION_LOCK}" || die "Portal operation lock could not be opened"
  flock -n 9 || die "Another Portal install, update, uninstall, backup, or restore is running"
}

assert_no_foreign_restore_transactions() {
  [[ ! -e "${PENDING_BACKUP_QUIESCENCE}" \
    && ! -L "${PENDING_BACKUP_QUIESCENCE}" ]] \
    || die "An interrupted backup must recover its quiesced runtime state before restore can mutate the host"
  local pending_installer_journal
  for pending_installer_journal in \
    "${PENDING_UPDATE_JOURNAL}" \
    "${PENDING_CUTOVER_JOURNAL}" \
    "${PENDING_UNINSTALL_JOURNAL}"; do
    [[ ! -e "${pending_installer_journal}" \
      && ! -L "${pending_installer_journal}" ]] \
      || die "An interrupted install, update, or uninstall must recover before restore can mutate the host"
  done
}

fsync_directory() {
  local directory="$1"
  python3 - "${directory}" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
info = os.lstat(path)
if (
    not os.path.isabs(path)
    or os.path.normpath(path) != path
    or not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise SystemExit(1)
descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

durably_unlink_owned_file() {
  local path="$1" expected_parent="$2"
  python3 - "${path}" "${expected_parent}" <<'PY'
import os
import stat
import sys

path, expected_parent = sys.argv[1:]
if (
    not os.path.isabs(path)
    or os.path.normpath(path) != path
    or os.path.dirname(path) != expected_parent
):
    raise SystemExit(1)
parent = os.lstat(expected_parent)
if (
    not stat.S_ISDIR(parent.st_mode)
    or stat.S_ISLNK(parent.st_mode)
    or parent.st_uid != 0
    or parent.st_gid != 0
    or parent.st_mode & 0o022
):
    raise SystemExit(1)
try:
    info = os.lstat(path)
except FileNotFoundError:
    info = None
if info is not None:
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
    os.unlink(path)
descriptor = os.open(expected_parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

sync_tree() {
  local root="$1"
  [[ -e "${root}" && ! -L "${root}" ]] || return 1
  sync -f -- "${root}"
}

seal_restore_archive() {
  local source="$1"
  local destination="${TRANSACTION_DIR}/source-archive.tar.gz"
  [[ -n "${PREAUTH_ARCHIVE_IDENTITY}" ]] || return 1
  python3 - "${source}" "${destination}" "${TRANSACTION_DIR}" "${RESERVE_BYTES}" \
    "${PREAUTH_ARCHIVE_IDENTITY}" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

source, destination, transaction_dir, reserve_text, identity_raw = sys.argv[1:]
if (
    not os.path.isabs(source)
    or os.path.normpath(source) != source
    or os.path.dirname(destination) != transaction_dir
    or not reserve_text.isdigit()
):
    raise SystemExit(1)
identity = json.loads(identity_raw)
if (
    set(identity) != {
        "schema", "dev", "ino", "size", "mtimeNs", "ctimeNs", "sha256",
    }
    or identity.get("schema") != "bridgesllm.authenticated-archive.v1"
    or any(
        not isinstance(identity.get(key), int)
        or isinstance(identity.get(key), bool)
        or identity[key] <= 0
        for key in ("dev", "ino", "size", "mtimeNs", "ctimeNs")
    )
    or re.fullmatch(r"[a-f0-9]{64}", str(identity.get("sha256", ""))) is None
):
    raise SystemExit(1)
reserve = int(reserve_text)
source_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
source_descriptor = os.open(source, source_flags)
destination_descriptor = None
published = False
try:
    source_info = os.fstat(source_descriptor)
    if (
        not stat.S_ISREG(source_info.st_mode)
        or source_info.st_uid != 0
        or source_info.st_gid != 0
        or source_info.st_nlink != 1
        or source_info.st_mode & 0o022
        or source_info.st_size <= 0
        or source_info.st_size > 2 * 1024**4
    ):
        raise OSError("restore source archive inode is unsafe")
    if (
        source_info.st_dev,
        source_info.st_ino,
        source_info.st_size,
        source_info.st_mtime_ns,
        source_info.st_ctime_ns,
    ) != (
        identity["dev"],
        identity["ino"],
        identity["size"],
        identity["mtimeNs"],
        identity["ctimeNs"],
    ):
        raise OSError("restore source archive differs from authenticated inode")
    stats = os.statvfs(transaction_dir)
    if stats.f_bavail * stats.f_frsize < source_info.st_size + reserve:
        raise OSError("restore source archive cannot be sealed within the disk reserve")
    destination_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | os.O_NOFOLLOW
    )
    destination_descriptor = os.open(destination, destination_flags, 0o600)
    digest = hashlib.sha256()
    copied = 0
    while True:
        chunk = os.read(source_descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        view = memoryview(chunk)
        while view:
            written = os.write(destination_descriptor, view)
            if written <= 0:
                raise OSError("restore archive sealing made no progress")
            view = view[written:]
        copied += len(chunk)
    final_source = os.fstat(source_descriptor)
    if (
        copied != source_info.st_size
        or digest.hexdigest() != identity["sha256"]
        or (final_source.st_dev, final_source.st_ino, final_source.st_size,
            final_source.st_mtime_ns, final_source.st_ctime_ns)
        != (source_info.st_dev, source_info.st_ino, source_info.st_size,
            source_info.st_mtime_ns, source_info.st_ctime_ns)
    ):
        raise OSError("restore source archive changed while it was being sealed")
    os.fsync(destination_descriptor)
    destination_info = os.fstat(destination_descriptor)
    if (
        not stat.S_ISREG(destination_info.st_mode)
        or destination_info.st_uid != 0
        or destination_info.st_gid != 0
        or destination_info.st_nlink != 1
        or stat.S_IMODE(destination_info.st_mode) != 0o600
        or destination_info.st_size != copied
    ):
        raise OSError("sealed restore archive metadata is unsafe")
    os.close(destination_descriptor)
    destination_descriptor = None
    directory_descriptor = os.open(
        transaction_dir,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
    published = True
    print(digest.hexdigest())
finally:
    os.close(source_descriptor)
    if destination_descriptor is not None:
        os.close(destination_descriptor)
    if not published:
        try:
            os.unlink(destination)
        except FileNotFoundError:
            pass
PY
}

discard_unjournaled_transaction() {
  [[ -n "${TRANSACTION_ID}" \
    && "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ \
    && "${TRANSACTION_DIR}" == "${TRANSACTIONS_ROOT}/${TRANSACTION_ID}" \
    && -d "${TRANSACTION_DIR}" && ! -L "${TRANSACTION_DIR}" ]] || return 1
  local sealed="${TRANSACTION_DIR}/source-archive.tar.gz"
  if [[ -e "${sealed}" || -L "${sealed}" ]]; then
    durably_unlink_owned_file "${sealed}" "${TRANSACTION_DIR}" || return 1
  fi
  rmdir -- "${TRANSACTION_DIR}" || return 1
  fsync_directory "${TRANSACTIONS_ROOT}"
}

authenticate_archive_before_transaction() {
  local archive="$1" identity
  [[ "${archive}" == /* ]] || return 1
  assert_restore_archive_trust || return 1
  [[ -f "${ARCHIVE_HELPER}" && ! -L "${ARCHIVE_HELPER}" ]] || return 1
  identity="$(python3 "${ARCHIVE_HELPER}" authenticate \
    --archive "${archive}" \
    --hmac-key "${RESTORE_HMAC_KEY}")" || return 1
  [[ "${#identity}" -le 1024 ]] || return 1
  python3 - "${identity}" <<'PY' || return 1
import json
import re
import sys
document = json.loads(sys.argv[1])
if (
    set(document) != {
        "schema", "dev", "ino", "size", "mtimeNs", "ctimeNs", "sha256",
    }
    or document.get("schema") != "bridgesllm.authenticated-archive.v1"
    or any(
        not isinstance(document.get(key), int)
        or isinstance(document.get(key), bool)
        or document[key] <= 0
        for key in ("dev", "ino", "size", "mtimeNs", "ctimeNs")
    )
    or re.fullmatch(r"[a-f0-9]{64}", str(document.get("sha256", ""))) is None
):
    raise SystemExit(1)
PY
  PREAUTH_ARCHIVE_IDENTITY="${identity}"
}

verify_archive() {
  local archive="$1" version database_authority="${PORTAL_ENV_FILE}"
  local -a helper_test_args=()
  local -a protected_args=()
  [[ "${archive}" == /* ]] || die "Archive path must be absolute"
  [[ -f "${ARCHIVE_HELPER}" && ! -L "${ARCHIVE_HELPER}" ]] \
    || die "The signed recovery archive helper is unavailable"
  assert_restore_archive_trust \
    || die "Backup trust key is missing or unsafe; unsigned and plaintext-SQL backups are unsupported"
  version="$(portal_version)" || die "Installed Portal version could not be identified"
  if [[ -n "${TRANSACTION_DIR}" \
    && -f "${TRANSACTION_DIR}/database-authority.env" \
    && ! -L "${TRANSACTION_DIR}/database-authority.env" ]]; then
    database_authority="${TRANSACTION_DIR}/database-authority.env"
  fi
  select_postgresql_toolchain_for_authority "${database_authority}" \
    || die "PostgreSQL server/client major or supported security floor admission failed"
  local temporary admission_root cleanup_root=""
  if [[ -n "${TRANSACTION_DIR}" && -d "${TRANSACTION_DIR}" && ! -L "${TRANSACTION_DIR}" ]]; then
    admission_root="${TRANSACTION_DIR}"
  elif [[ -z "${ADMISSION_FILE}" ]]; then
    admission_root="$(mktemp -d /tmp/bridgesllm-restore-verify.XXXXXX)"
    chmod 700 "${admission_root}"
    cleanup_root="${admission_root}"
  else
    die "Restore transaction boundary is unavailable for archive admission"
  fi
  temporary="${admission_root}/.admission-${TRANSACTION_ID:-verify}.json"
  [[ ! -e "${temporary}" && ! -L "${temporary}" ]] \
    || die "Restore admission temporary path already exists"
  if [[ -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]]; then
    helper_test_args=(--test-root "${BRIDGESLLM_RESTORE_TEST_ROOT}")
  fi
  local protected_path
  for protected_path in \
    "${STATE_ROOT}" \
    "${OPERATION_LOCK}" \
    "${SYSTEMD_ROOT}" \
    "${BACKUP_RECOVERY_STATE_DIR}" \
    "${RESTORE_TRUST_ROOT}" \
    "${INSTALLER_STATE_ROOT}"; do
    protected_args+=(--protected-control-path "${protected_path}")
  done
  for protected_path in \
    "${SCRIPT_DIR}/restore-full.sh" \
    "${SCRIPT_DIR}/backup-full.sh" \
    "${PORTAL_ENV_FILE}" \
    "${SCRIPT_DIR}/installer/install.sh" \
    "${SCRIPT_DIR}/installer/portal-recovery-archive.py"; do
    protected_args+=(--protected-authority-path "${protected_path}")
  done
  python3 "${ARCHIVE_HELPER}" inspect \
    --archive "${archive}" \
    --hmac-key "${RESTORE_HMAC_KEY}" \
    --pg-restore "${RESTORE_PG_RESTORE_BIN}" \
    --postgres-major "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    --expected-version "${version}" \
    --current-env "${PORTAL_ENV_FILE}" \
    --output "${temporary}" \
    "${helper_test_args[@]}" \
    "${protected_args[@]}" \
    || {
      rm -f -- "${temporary}"
      [[ -z "${cleanup_root}" ]] || rmdir -- "${cleanup_root}"
      die "Archive version, profile, environment, database, or target admission failed"
    }
  if [[ -n "${ADMISSION_FILE}" ]]; then
    mv -f -- "${temporary}" "${ADMISSION_FILE}"
    fsync_directory "$(dirname -- "${ADMISSION_FILE}")" \
      || die "Restore admission was not committed durably"
  else
    rm -f -- "${temporary}"
    [[ -z "${cleanup_root}" ]] || rmdir -- "${cleanup_root}"
  fi
}

wait_for_restore_phase_gate() {
  local phase="$1"
  [[ -n "${RESTORE_PHASE_GATE_DIR}" ]] || return 0
  [[ "${phase}" == "${RESTORE_PHASE_GATE}" ]] || return 0
  [[ "${RESTORE_OPERATION_NONCE}" =~ ^[a-f0-9]{64}$ \
    && "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ \
    && "${RESTORE_PHASE_GATE_IDENTITY}" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  python3 - "${RESTORE_PHASE_GATE_DIR}" "${ACTIVE_JOURNAL}" \
    "${RESTORE_PHASE_GATE_IDENTITY}" "${OPERATION_LOCK}" \
    3<<<"${RESTORE_OPERATION_NONCE}" 4<<<"${phase}" \
    5<<<"${TRANSACTION_ID}" 6<<<"$$" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys
import time

gate_path, journal_path, expected_identity, operation_lock = sys.argv[1:]
nonce = os.fdopen(3, "r", encoding="ascii").read().strip()
phase = os.fdopen(4, "r", encoding="ascii").read().strip()
transaction_id = os.fdopen(5, "r", encoding="ascii").read().strip()
worker_pid_raw = os.fdopen(6, "r", encoding="ascii").read().strip()

def reject(stage):
    raise SystemExit(f"restore phase gate rejected at {stage}")

if (
    not re.fullmatch(r"[a-f0-9]{64}", nonce)
    or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", phase)
    or not re.fullmatch(r"[a-f0-9]{32}", transaction_id)
    or not worker_pid_raw.isdigit()
):
    reject("input")
worker_pid = int(worker_pid_raw)
if worker_pid <= 0 or worker_pid != os.getppid():
    reject("worker-parent")
try:
    expected_device, expected_inode = (
        int(value) for value in expected_identity.split(":", 1)
    )
except (TypeError, ValueError):
    reject("directory-identity-input")

def safe_regular_at(directory_descriptor, name, maximum_size):
    descriptor = os.open(
        name,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        dir_fd=directory_descriptor,
    )
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > maximum_size
    ):
        os.close(descriptor)
        reject(f"unsafe-{name}")
    return descriptor

def load_json_at(directory_descriptor, name, maximum_size):
    descriptor = safe_regular_at(directory_descriptor, name, maximum_size)
    try:
        with os.fdopen(
            descriptor, "r", encoding="utf-8", closefd=False
        ) as handle:
            return json.load(handle)
    finally:
        os.close(descriptor)

def assert_gate_path_identity():
    info = os.lstat(gate_path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
        or (info.st_dev, info.st_ino)
            != (expected_device, expected_inode)
    ):
        reject("directory-identity")

assert_gate_path_identity()
flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | os.O_NOFOLLOW
)
gate_descriptor = os.open(gate_path, flags)
try:
    gate_info = os.fstat(gate_descriptor)
    if (
        gate_info.st_uid != 0
        or gate_info.st_gid != 0
        or stat.S_IMODE(gate_info.st_mode) != 0o700
        or (gate_info.st_dev, gate_info.st_ino)
            != (expected_device, expected_inode)
        or set(os.listdir(gate_descriptor)) != {"binding.json"}
    ):
        reject("directory-contents")
    expected_binding = {
        "schema": "bridgesllm.restore-phase-gate-binding.v1",
        "operationNonce": nonce,
        "phase": phase,
    }
    if load_json_at(gate_descriptor, "binding.json", 4096) != expected_binding:
        reject("binding")

    journal_info = os.lstat(journal_path)
    if (
        not stat.S_ISREG(journal_info.st_mode)
        or stat.S_ISLNK(journal_info.st_mode)
        or journal_info.st_uid != 0
        or journal_info.st_gid != 0
        or journal_info.st_nlink != 1
        or stat.S_IMODE(journal_info.st_mode) != 0o600
        or journal_info.st_size <= 0
        or journal_info.st_size > 65536
    ):
        reject("journal-file")
    with open(journal_path, "rb", buffering=0) as handle:
        journal_bytes = handle.read()
    journal = json.loads(journal_bytes.decode("utf-8"))
    expected_journal_keys = {
        "schema",
        "transactionId",
        "operationNonce",
        "transactionDir",
        "archive",
        "archiveSha256",
        "admission",
        "phase",
        "startedAt",
    }
    if (
        set(journal) != expected_journal_keys
        or journal.get("schema") != "bridgesllm.restore-transaction.v2"
        or journal.get("transactionId") != transaction_id
        or journal.get("operationNonce") != nonce
        or journal.get("phase") != phase
    ):
        reject("journal-binding")
    journal_sha256 = hashlib.sha256(journal_bytes).hexdigest()

    stat_contents = pathlib.Path(
        f"/proc/{worker_pid}/stat"
    ).read_text(encoding="ascii")
    fields = stat_contents.rsplit(") ", 1)
    if len(fields) != 2:
        reject("worker-stat-shape")
    trailing = fields[1].split()
    if len(trailing) < 20 or not trailing[19].isdigit():
        reject("worker-start-ticks-shape")
    worker_start_ticks = int(trailing[19])
    if worker_start_ticks <= 0:
        reject("worker-start-ticks")
    lock_info = os.stat(operation_lock, follow_symlinks=False)
    worker_lock_info = os.stat(f"/proc/{worker_pid}/fd/9")
    if (
        not stat.S_ISREG(lock_info.st_mode)
        or lock_info.st_uid != 0
        or lock_info.st_gid != 0
        or lock_info.st_nlink != 1
        or lock_info.st_mode & 0o022
        or (lock_info.st_dev, lock_info.st_ino)
            != (worker_lock_info.st_dev, worker_lock_info.st_ino)
    ):
        reject("operation-lock")

    receipt = {
        "schema": "bridgesllm.restore-phase-gate.v1",
        "operationNonce": nonce,
        "phase": phase,
        "transactionId": transaction_id,
        "workerPid": worker_pid,
        "workerStartTicks": worker_start_ticks,
        "activeJournalSha256": journal_sha256,
    }
    payload = (
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    temporary = f".ready.{os.getpid()}.{secrets.token_hex(8)}"
    temporary_descriptor = -1
    try:
        temporary_descriptor = os.open(
            temporary,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | os.O_NOFOLLOW,
            0o600,
            dir_fd=gate_descriptor,
        )
        os.fchmod(temporary_descriptor, 0o600)
        os.write(temporary_descriptor, payload)
        os.fsync(temporary_descriptor)
        os.close(temporary_descriptor)
        temporary_descriptor = -1
        os.rename(
            temporary,
            "ready.json",
            src_dir_fd=gate_descriptor,
            dst_dir_fd=gate_descriptor,
        )
        temporary = ""
        os.fsync(gate_descriptor)
    finally:
        if temporary_descriptor >= 0:
            os.close(temporary_descriptor)
        if temporary:
            try:
                os.unlink(temporary, dir_fd=gate_descriptor)
            except FileNotFoundError:
                pass

    while True:
        assert_gate_path_identity()
        entries = set(os.listdir(gate_descriptor))
        if not entries.issubset(
            {"binding.json", "ready.json", "release.json"}
        ) or "binding.json" not in entries or "ready.json" not in entries:
            reject("wait-directory-contents")
        if load_json_at(gate_descriptor, "binding.json", 4096) != expected_binding:
            reject("wait-binding")
        if load_json_at(gate_descriptor, "ready.json", 4096) != receipt:
            reject("wait-ready")
        if "release.json" in entries:
            if load_json_at(gate_descriptor, "release.json", 4096) != receipt:
                reject("release")
            os.unlink("release.json", dir_fd=gate_descriptor)
            os.unlink("ready.json", dir_fd=gate_descriptor)
            os.fsync(gate_descriptor)
            break
        time.sleep(0.05)
finally:
    os.close(gate_descriptor)
PY
}

write_journal() {
  local phase="$1"
  python3 - "${ACTIVE_JOURNAL}" "${TRANSACTION_ID}" "${TRANSACTION_DIR}" \
    "${ARCHIVE}" "${ADMISSION_FILE}" "${phase}" \
    3<<<"${RESTORE_OPERATION_NONCE}" <<'PY'
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

target, transaction_id, transaction_dir, archive, admission, phase = sys.argv[1:]
operation_nonce = os.fdopen(3, "r", encoding="ascii").read().strip()
if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
    raise SystemExit(1)
if not re.fullmatch(r"[a-f0-9]{64}", operation_nonce):
    raise SystemExit(1)
if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", phase):
    raise SystemExit(1)
digest = hashlib.sha256()
if phase == "preparing":
    if os.path.lexists(archive):
        raise SystemExit(1)
else:
    with open(archive, "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
expected_keys = {
    "schema",
    "transactionId",
    "operationNonce",
    "transactionDir",
    "archive",
    "archiveSha256",
    "admission",
    "phase",
    "startedAt",
}
if phase == "preparing":
    if os.path.lexists(target):
        raise SystemExit(1)
    document = {
        "schema": "bridgesllm.restore-transaction.v2",
        "transactionId": transaction_id,
        "operationNonce": operation_nonce,
        "transactionDir": transaction_dir,
        "archive": archive,
        "archiveSha256": digest.hexdigest(),
        "admission": admission,
        "phase": phase,
        "startedAt": datetime.datetime.now(
            datetime.timezone.utc
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
else:
    info = os.lstat(target)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or info.st_size <= 0
        or info.st_size > 65536
    ):
        raise SystemExit(1)
    document = json.load(open(target, "r", encoding="utf-8"))
    started_at = document.get("startedAt")
    try:
        parsed_started_at = datetime.datetime.fromisoformat(
            str(started_at).replace("Z", "+00:00")
        )
    except ValueError:
        raise SystemExit(1)
    if (
        set(document) != expected_keys
        or document.get("schema") != "bridgesllm.restore-transaction.v2"
        or document.get("transactionId") != transaction_id
        or document.get("operationNonce") != operation_nonce
        or document.get("transactionDir") != transaction_dir
        or document.get("archive") != archive
        or document.get("archiveSha256") != digest.hexdigest()
        or document.get("admission") != admission
        or document.get("phase") != "preparing"
        or parsed_started_at.tzinfo is None
    ):
        raise SystemExit(1)
    document["phase"] = phase
directory = os.path.dirname(target)
info = os.lstat(directory)
if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022):
    raise SystemExit(1)
descriptor, temporary = tempfile.mkstemp(prefix=".active-restore.", dir=directory)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    temporary = ""
    os.chmod(target, 0o600)
    directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if temporary:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
}

bind_sealed_archive_to_preparing_journal() {
  python3 - "${ACTIVE_JOURNAL}" "${TRANSACTION_ID}" "${TRANSACTION_DIR}" \
    "${ARCHIVE}" "${ADMISSION_FILE}" \
    3<<<"${RESTORE_OPERATION_NONCE}" <<'PY'
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

journal_path, transaction_id, transaction_dir, archive_path, admission_path = sys.argv[1:]
operation_nonce = os.fdopen(3, "r", encoding="ascii").read().strip()
if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
    raise SystemExit(1)
if not re.fullmatch(r"[a-f0-9]{64}", operation_nonce):
    raise SystemExit(1)

def load_control_document(path, maximum_size):
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or info.st_size <= 0
        or info.st_size > maximum_size
    ):
        raise SystemExit(1)
    return json.load(open(path, "r", encoding="utf-8"))

archive_info = os.lstat(archive_path)
if (
    not stat.S_ISREG(archive_info.st_mode)
    or stat.S_ISLNK(archive_info.st_mode)
    or archive_info.st_uid != 0
    or archive_info.st_gid != 0
    or archive_info.st_nlink != 1
    or archive_info.st_mode & 0o022
    or archive_info.st_size <= 0
):
    raise SystemExit(1)

digest = hashlib.sha256()
with open(archive_path, "rb", buffering=0) as handle:
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
archive_digest = digest.hexdigest()

journal = load_control_document(journal_path, 65536)
admission = load_control_document(admission_path, 4 * 1024 * 1024)
expected_journal_keys = {
    "schema",
    "transactionId",
    "operationNonce",
    "transactionDir",
    "archive",
    "archiveSha256",
    "admission",
    "phase",
    "startedAt",
}
empty_digest = hashlib.sha256().hexdigest()
started_at = journal.get("startedAt")
try:
    parsed_started_at = datetime.datetime.fromisoformat(
        str(started_at).replace("Z", "+00:00")
    )
except ValueError:
    raise SystemExit(1)
if (
    set(journal) != expected_journal_keys
    or journal.get("schema") != "bridgesllm.restore-transaction.v2"
    or journal.get("transactionId") != transaction_id
    or journal.get("operationNonce") != operation_nonce
    or journal.get("transactionDir") != transaction_dir
    or journal.get("archive") != archive_path
    or journal.get("admission") != admission_path
    or journal.get("phase") != "preparing"
    or journal.get("archiveSha256") not in {empty_digest, archive_digest}
    or parsed_started_at.tzinfo is None
    or admission.get("schema") != "bridgesllm.restore-admission.v2"
    or admission.get("archive") != archive_path
    or admission.get("archiveSha256") != archive_digest
):
    raise SystemExit(1)

journal["archiveSha256"] = archive_digest
directory = os.path.dirname(journal_path)
directory_info = os.lstat(directory)
if (
    not stat.S_ISDIR(directory_info.st_mode)
    or stat.S_ISLNK(directory_info.st_mode)
    or directory_info.st_uid != 0
    or directory_info.st_gid != 0
    or directory_info.st_mode & 0o022
):
    raise SystemExit(1)
descriptor, temporary = tempfile.mkstemp(prefix=".active-restore.", dir=directory)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(journal, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, journal_path)
    temporary = ""
    os.chmod(journal_path, 0o600)
    directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if temporary:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
}

journal_field() {
  local field="$1"
  python3 - "${ACTIVE_JOURNAL}" "${field}" <<'PY'
import json
import os
import re
import stat
import sys

path, field = sys.argv[1:]
info = os.lstat(path)
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1
        or info.st_mode & 0o022 or info.st_size <= 0 or info.st_size > 65536):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
expected_keys = {
    "schema",
    "transactionId",
    "operationNonce",
    "transactionDir",
    "archive",
    "archiveSha256",
    "admission",
    "phase",
    "startedAt",
}
if (
    set(document) != expected_keys
    or document.get("schema") != "bridgesllm.restore-transaction.v2"
    or not re.fullmatch(
        r"[a-f0-9]{32}", str(document.get("transactionId", ""))
    )
    or not re.fullmatch(
        r"[a-f0-9]{64}", str(document.get("operationNonce", ""))
    )
    or not re.fullmatch(
        r"[a-f0-9]{64}", str(document.get("archiveSha256", ""))
    )
    or not re.fullmatch(
        r"[a-z][a-z0-9_]{0,63}", str(document.get("phase", ""))
    )
):
    raise SystemExit(1)
value = document.get(field)
if value is None:
    print("")
elif isinstance(value, (str, int, bool)):
    print(str(value).lower() if isinstance(value, bool) else value)
else:
    raise SystemExit(1)
PY
}

restore_test_fault_point() {
  local phase="$1" requested="${BRIDGESLLM_RESTORE_TEST_FAIL_AFTER:-}"
  [[ -n "${requested}" ]] || return 0
  [[ -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]] \
    || die "Restore fault injection is restricted to an attested test fixture"
  case "${requested}" in
    fenced|quiesced|database_exclusion_pending|database_excluded|staged|\
    rollback_snapshot_pending|rollback_snapshot_complete|database_restored|\
    files_restored|openclaw_restored|stalwart_restored|migrated|verified|committed) ;;
    *) die "Restore fault-injection phase is invalid" ;;
  esac
  if [[ "${phase}" == "${requested}" ]]; then
    die "Injected restore fixture failure after phase ${phase}"
  fi
}

advance_phase() {
  local expected="$1" next="$2"
  python3 - "${ACTIVE_JOURNAL}" "${expected}" "${next}" \
    3<<<"${RESTORE_OPERATION_NONCE}" <<'PY'
import json
import os
import re
import stat
import sys
import tempfile

path, expected, next_phase = sys.argv[1:]
operation_nonce = os.fdopen(3, "r", encoding="ascii").read().strip()
if (
    not re.fullmatch(r"[a-f0-9]{64}", operation_nonce)
    or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", expected)
    or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", next_phase)
):
    raise SystemExit(1)
info = os.lstat(path)
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1
        or info.st_mode & 0o022 or info.st_size <= 0 or info.st_size > 65536):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
expected_keys = {
    "schema",
    "transactionId",
    "operationNonce",
    "transactionDir",
    "archive",
    "archiveSha256",
    "admission",
    "phase",
    "startedAt",
}
if (
    set(document) != expected_keys
    or document.get("schema") != "bridgesllm.restore-transaction.v2"
    or document.get("operationNonce") != operation_nonce
    or not re.fullmatch(
        r"[a-f0-9]{32}", str(document.get("transactionId", ""))
    )
    or not re.fullmatch(
        r"[a-f0-9]{64}", str(document.get("archiveSha256", ""))
    )
    or document.get("phase") != expected
):
    raise SystemExit(1)
document["phase"] = next_phase
directory = os.path.dirname(path)
descriptor, temporary = tempfile.mkstemp(prefix=".active-restore.", dir=directory)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    temporary = ""
    directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if temporary:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
  wait_for_restore_phase_gate "${next}" || return 1
  restore_test_fault_point "${next}"
}

install_boot_fences() {
  local expected="[Unit]
ConditionPathExists=!/
"
  local plan="${TRANSACTION_DIR}/fence-plan.json"
  [[ -f "${plan}" && ! -L "${plan}" \
    && "$(stat -c '%u:%g:%a:%h' "${plan}")" == "0:0:600:1" ]] \
    || die "Restore boot-fence ownership plan is missing or unsafe"
  local unit directory target
  for unit in "${RESTORE_UNITS[@]}"; do
    directory="${SYSTEMD_ROOT}/${unit}.d"
    target="${directory}/${BOOT_FENCE_NAME}"
    python3 - "${plan}" "${unit}" "${directory}" "${BOOT_FENCE_NAME}" <<'PY' \
      || die "Restore boot-fence directory changed for ${unit}"
import json
import os
import stat
import sys

plan_path, unit, directory, fence_name = sys.argv[1:]
document = json.load(open(plan_path, "r", encoding="utf-8"))
record = (document.get("units") or {}).get(unit)
if (
    document.get("schema") != "bridgesllm.restore-fence-plan.v1"
    or not isinstance(record, dict)
    or record.get("directory") != directory
    or record.get("target") != os.path.join(directory, fence_name)
):
    raise SystemExit(1)
try:
    info = os.lstat(directory)
except FileNotFoundError:
    if record.get("existed") is not False:
        raise SystemExit(1)
    os.mkdir(directory, 0o755)
    info = os.lstat(directory)
if (
    not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise SystemExit(1)
if record.get("existed") is True and (
    info.st_dev != record.get("device")
    or info.st_ino != record.get("inode")
    or stat.S_IMODE(info.st_mode) != record.get("mode")
):
    raise SystemExit(1)
PY
    fsync_directory "${SYSTEMD_ROOT}" \
      || die "Restore boot-fence directory was not committed durably for ${unit}"
    python3 - "${target}" "${expected}" <<'PY'
import os
import stat
import sys
import tempfile

target, expected = sys.argv[1:]
directory = os.path.dirname(target)
info = os.lstat(directory)
if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022):
    raise SystemExit(1)
try:
    current = os.lstat(target)
except FileNotFoundError:
    current = None
if current is not None:
    if (not stat.S_ISREG(current.st_mode) or stat.S_ISLNK(current.st_mode)
            or current.st_uid != 0 or current.st_gid != 0 or current.st_nlink != 1
            or current.st_mode & 0o022 or current.st_size > 4096):
        raise SystemExit(1)
    if open(target, "r", encoding="utf-8").read() == expected:
        raise SystemExit(0)
    raise SystemExit(1)
descriptor, temporary = tempfile.mkstemp(prefix=".restore-fence.", dir=directory)
try:
    os.fchmod(descriptor, 0o644)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(expected)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    temporary = ""
    directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if temporary:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
  done
  "${RESTORE_SYSTEMCTL_BIN}" daemon-reload >/dev/null 2>&1 \
    || die "Systemd did not accept the restore boot fences"
}

prove_boot_fences_effective() {
  local expected="[Unit]
ConditionPathExists=!/
"
  local unit load_state active_state condition_result directory target configuration
  for unit in "${RESTORE_UNITS[@]}"; do
    directory="${SYSTEMD_ROOT}/${unit}.d"
    target="${directory}/${BOOT_FENCE_NAME}"
    load_state="$("${RESTORE_SYSTEMCTL_BIN}" show \
      --property=LoadState --value "${unit}" 2>/dev/null)" || return 1
    if [[ "${load_state}" == "not-found" ]]; then
      continue
    fi
    [[ "${load_state}" == "loaded" ]] || return 1
    "${RESTORE_SYSTEMCTL_BIN}" reset-failed "${unit}" >/dev/null 2>&1 || true
    "${RESTORE_SYSTEMCTL_BIN}" start "${unit}" >/dev/null 2>&1 || true
    active_state="$("${RESTORE_SYSTEMCTL_BIN}" show \
      --property=ActiveState --value "${unit}" 2>/dev/null)" || return 1
    condition_result="$("${RESTORE_SYSTEMCTL_BIN}" show \
      --property=ConditionResult --value "${unit}" 2>/dev/null)" || return 1
    configuration="$(
      SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat \
        "${RESTORE_SYSTEMCTL_BIN}" cat --no-pager "${unit}" 2>/dev/null
    )" || return 1
    printf '%s' "${configuration}" \
      | python3 /dev/fd/3 "${target}" "${expected}" 3<<'PY' \
      || return 1
import sys
target, expected = sys.argv[1:]
payload = sys.stdin.read().rstrip("\n")
suffix = (f"# {target}\n" + expected).rstrip("\n")
if not payload.endswith(suffix):
    raise SystemExit(1)
PY
    "${RESTORE_SYSTEMCTL_BIN}" stop "${unit}" >/dev/null 2>&1 || true
    [[ "${active_state}" == "inactive" || "${active_state}" == "failed" ]] \
      || return 1
    [[ "${condition_result}" == "no" ]] || return 1
  done
}

prepare_boot_fence_plan() {
  local plan="${TRANSACTION_DIR}/fence-plan.json"
  python3 - "${plan}" "${SYSTEMD_ROOT}" "${BOOT_FENCE_NAME}" \
    "${RESTORE_UNITS[@]}" <<'PY'
import json
import os
import stat
import sys
import tempfile

plan_path, systemd_root, fence_name, *units = sys.argv[1:]
if (
    not units
    or len(units) != len(set(units))
    or os.path.lexists(plan_path)
):
    raise SystemExit(1)
root = os.lstat(systemd_root)
if (
    not stat.S_ISDIR(root.st_mode)
    or stat.S_ISLNK(root.st_mode)
    or root.st_uid != 0
    or root.st_gid != 0
    or root.st_mode & 0o022
):
    raise SystemExit(1)
records = {}
for unit in units:
    directory = os.path.join(systemd_root, f"{unit}.d")
    target = os.path.join(directory, fence_name)
    if os.path.lexists(target):
        raise SystemExit("reserved restore fence path already exists")
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        record = {
            "directory": directory,
            "target": target,
            "existed": False,
        }
    else:
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
        ):
            raise SystemExit(1)
        record = {
            "directory": directory,
            "target": target,
            "existed": True,
            "device": info.st_dev,
            "inode": info.st_ino,
            "mode": stat.S_IMODE(info.st_mode),
        }
    records[unit] = record
document = {
    "schema": "bridgesllm.restore-fence-plan.v1",
    "units": records,
}
parent = os.path.dirname(plan_path)
descriptor, temporary = tempfile.mkstemp(prefix=".fence-plan.", dir=parent)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, plan_path)
    temporary = ""
    directory_fd = os.open(
        parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if temporary:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
}

preflight_reserved_boot_fence_paths() {
  python3 - "${SYSTEMD_ROOT}" "${BOOT_FENCE_NAME}" "${RESTORE_UNITS[@]}" <<'PY'
import fcntl
import os
import stat
import struct
import sys

systemd_root, fence_name, *units = sys.argv[1:]
if not units or len(units) != len(set(units)):
    raise SystemExit(1)

FS_IOC_GETFLAGS = (
    (2 << 30)
    | (struct.calcsize("@L") << 16)
    | (ord("f") << 8)
    | 1
)
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020

def assert_mutable_control_directory(path, expected):
    descriptor = os.open(
        path,
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != expected.st_dev
            or opened.st_ino != expected.st_ino
            or stat.S_IFMT(opened.st_mode) != stat.S_IFMT(expected.st_mode)
        ):
            raise SystemExit(1)
        encoded = bytearray(struct.calcsize("@L"))
        try:
            fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, encoded, True)
        except OSError:
            raise SystemExit(1)
        inode_flags = struct.unpack("@L", encoded)[0]
    finally:
        os.close(descriptor)
    if inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        raise SystemExit(1)

root = os.lstat(systemd_root)
if (
    not stat.S_ISDIR(root.st_mode)
    or stat.S_ISLNK(root.st_mode)
    or root.st_uid != 0
    or root.st_gid != 0
    or root.st_mode & 0o022
):
    raise SystemExit(1)
assert_mutable_control_directory(systemd_root, root)
for unit in units:
    directory = os.path.join(systemd_root, f"{unit}.d")
    target = os.path.join(directory, fence_name)
    if os.path.lexists(target):
        raise SystemExit("reserved restore fence path already exists")
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        continue
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
    assert_mutable_control_directory(directory, info)
PY
}

remove_boot_fences() {
  local plan="${TRANSACTION_DIR}/fence-plan.json"
  if [[ ! -e "${plan}" && ! -L "${plan}" ]]; then
    return 0
  fi
  [[ -f "${plan}" && ! -L "${plan}" \
    && "$(stat -c '%u:%g:%a:%h' "${plan}")" == "0:0:600:1" ]] || return 1
  local expected="[Unit]
ConditionPathExists=!/
"
  local unit directory target existed
  for unit in "${RESTORE_UNITS[@]}"; do
    directory="${SYSTEMD_ROOT}/${unit}.d"
    target="${directory}/${BOOT_FENCE_NAME}"
    if [[ ! -e "${directory}" && ! -L "${directory}" ]]; then
      continue
    fi
    [[ -d "${directory}" && ! -L "${directory}" \
      && "$(stat -c '%u:%g' "${directory}")" == "0:0" \
      && $((8#$(stat -c '%a' "${directory}") & 0022)) -eq 0 ]] || return 1
    existed="$(python3 - "${plan}" "${unit}" "${directory}" "${target}" <<'PY'
import json
import os
import stat
import sys
plan_path, unit, directory, target = sys.argv[1:]
document = json.load(open(plan_path, "r", encoding="utf-8"))
record = (document.get("units") or {}).get(unit)
info = os.lstat(directory)
if (
    document.get("schema") != "bridgesllm.restore-fence-plan.v1"
    or not isinstance(record, dict)
    or record.get("directory") != directory
    or record.get("target") != target
    or record.get("existed") not in {True, False}
    or not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise SystemExit(1)
if record["existed"] and (
    info.st_dev != record.get("device")
    or info.st_ino != record.get("inode")
    or stat.S_IMODE(info.st_mode) != record.get("mode")
):
    raise SystemExit(1)
print("true" if record["existed"] else "false")
PY
)" || return 1
    if [[ -e "${target}" || -L "${target}" ]]; then
      [[ -f "${target}" && ! -L "${target}" \
        && "$(stat -c '%u:%g:%a:%h' "${target}")" == "0:0:644:1" \
        && "$(<"${target}")"$'\n' == "${expected}" ]] || return 1
      durably_unlink_owned_file "${target}" "${directory}" || return 1
    fi
    if [[ "${existed}" == "false" ]]; then
      rmdir -- "${directory}" || return 1
      fsync_directory "${SYSTEMD_ROOT}" || return 1
    fi
  done
  "${RESTORE_SYSTEMCTL_BIN}" daemon-reload >/dev/null 2>&1
}

assert_disk_admission() {
  local admission_phase="${1:-pre-downtime}"
  [[ "${admission_phase}" == "pre-downtime" \
    || "${admission_phase}" == "post-snapshot" ]] \
    || die "Restore disk admission phase is invalid"
  [[ "${RESERVE_BYTES}" =~ ^[0-9]+$ \
    && "${RESERVE_BYTES}" -ge 67108864 \
    && "${RESERVE_BYTES}" -le 8589934592 ]] \
    || die "Restore reserve must be between 64 MiB and 8 GiB"
  local database_admission database_bytes database_topology
  local database_relation_count database_extra
  database_admission="$(database_storage_admission)" \
    || die "Restore database storage admission could not be measured"
  IFS='|' read -r database_bytes database_topology database_relation_count \
    database_extra <<<"${database_admission}"
  [[ "${database_bytes}" =~ ^[1-9][0-9]*$ \
    && -n "${database_topology}" \
    && "${database_relation_count}" =~ ^[1-9][0-9]*$ \
    && "${database_relation_count}" -le 100000000 \
    && -z "${database_extra}" ]] \
    || die "Restore database storage admission was invalid"
  python3 - "${ADMISSION_FILE}" "${TRANSACTION_DIR}" "${RESERVE_BYTES}" \
    "${database_bytes}" "${database_topology}" "${admission_phase}" \
    "${database_relation_count}" "${SYSTEMD_ROOT}" <<'PY'
import json
import os
import pathlib
import stat
import sys

admission = json.load(open(sys.argv[1], "r", encoding="utf-8"))
transaction_dir = pathlib.Path(sys.argv[2])
reserve = int(sys.argv[3])
database_bytes = int(sys.argv[4])
admission_phase = sys.argv[6]
current_database_relation_count = int(sys.argv[7])
systemd_root = pathlib.Path(sys.argv[8])
if admission_phase not in {"pre-downtime", "post-snapshot"}:
    raise SystemExit("restore disk admission phase is invalid")
try:
    database_topology = json.loads(sys.argv[5])
except ValueError:
    raise SystemExit("restore database storage topology is invalid")
if (
    database_bytes <= 0
    or current_database_relation_count <= 0
    or current_database_relation_count > 100_000_000
    or not isinstance(database_topology, dict)
    or database_topology.get("schema")
        != "bridgesllm-update-database-topology-v1"
    or not isinstance(database_topology.get("dataDirectory"), str)
    or not isinstance(database_topology.get("walDirectory"), str)
    or not isinstance(database_topology.get("tablespaces"), list)
):
    raise SystemExit("restore database storage topology is invalid")
if (
    not systemd_root.is_absolute()
    or os.path.normpath(str(systemd_root)) != str(systemd_root)
    or not systemd_root.is_dir()
    or systemd_root.is_symlink()
):
    raise SystemExit("restore systemd control root is invalid")
database_path_records = [
    (
        database_topology["dataDirectory"],
        database_topology.get("dataDevice"),
    ),
    (
        database_topology["walDirectory"],
        database_topology.get("walDevice"),
    ),
] + [
    (entry.get("path"), entry.get("stDev"))
    for entry in database_topology["tablespaces"]
    if isinstance(entry, dict)
]
database_paths = []
for raw_path, expected_device in database_path_records:
    if (
        not isinstance(raw_path, str)
        or not isinstance(expected_device, int)
        or isinstance(expected_device, bool)
    ):
        raise SystemExit("restore database storage topology is invalid")
    path = pathlib.Path(raw_path)
    if (
        not path.is_absolute()
        or os.path.normpath(raw_path) != raw_path
        or os.path.realpath(path) != raw_path
        or not path.is_dir()
        or path.is_symlink()
        or os.stat(path).st_dev != expected_device
    ):
        raise SystemExit("restore database storage topology changed")
    database_paths.append(path)
outer_bytes = int(admission["outerExpandedBytes"])
nested_bytes = int(admission["nestedExpandedBytes"])
outer_inodes = int(admission["outerExpandedInodes"])
nested_inodes = int(admission["nestedExpandedInodes"])
database_dump_bytes = int(admission["databaseDumpBytes"])
incoming_database_bytes = int(admission["databaseLogicalBytes"])
database_relation_count = int(admission["databaseRelationCount"])
if (
    min(
        outer_bytes,
        nested_bytes,
        outer_inodes,
        nested_inodes,
        database_dump_bytes,
        incoming_database_bytes,
        database_relation_count,
    ) < 0
    or database_dump_bytes == 0
    or incoming_database_bytes == 0
    or database_relation_count == 0
    or database_relation_count > 100_000_000
):
    raise SystemExit("restore archive storage admission is invalid")
expanded = outer_bytes + nested_bytes
targets = sorted({pathlib.Path(item["target"]) for item in admission["components"]})
for target in targets:
    for database_path in database_paths:
        if (
            target == database_path
            or target.is_relative_to(database_path)
            or database_path.is_relative_to(target)
        ):
            raise SystemExit(
                "restore target overlaps PostgreSQL storage topology"
            )

def tree_usage(root):
    entry_overhead = 64 * 1024
    if not os.path.lexists(root):
        return 0, 0
    info = os.lstat(root)
    if stat.S_ISREG(info.st_mode):
        return max(info.st_size, info.st_blocks * 512) + entry_overhead, 1
    if not stat.S_ISDIR(info.st_mode):
        return entry_overhead, 1
    total = entry_overhead
    inodes = 1
    seen = set()
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        base = pathlib.Path(directory)
        retained = []
        for name in dirnames:
            path = base / name
            item = os.lstat(path)
            total += entry_overhead
            inodes += 1
            if not stat.S_ISLNK(item.st_mode):
                retained.append(name)
        dirnames[:] = retained
        for name in filenames:
            path = base / name
            item = os.lstat(path)
            if stat.S_ISREG(item.st_mode) and not stat.S_ISLNK(item.st_mode):
                identity = (item.st_dev, item.st_ino)
                total += entry_overhead
                if identity not in seen:
                    seen.add(identity)
                    total += max(item.st_size, item.st_blocks * 512)
            else:
                total += entry_overhead
            inodes += 1
    return total, inodes

maximal = []
for target in sorted(targets, key=lambda item: (len(item.parts), str(item))):
    if any(target == existing or target.is_relative_to(existing) for existing in maximal):
        continue
    maximal.append(target)
rollback_usage = [tree_usage(target) for target in maximal]
rollback = sum(item[0] for item in rollback_usage)
requirements = {}
state_device = os.stat(transaction_dir).st_dev
if admission_phase == "pre-downtime":
    requirements[state_device] = {
        "path": transaction_dir,
        # Keep a conservative allowance for the plain rollback dump plus its
        # temporary predecessor while it is durably published.
        "bytes": (
            expanded
            + rollback
            + (database_bytes * 5 + 16 * 1024**2) * 2
        ),
        "inodes": outer_inodes + nested_inodes + len(maximal) + 64,
    }
else:
    # The source archive, expanded staging tree, and rollback snapshot already
    # consume their real blocks at this point. Charge only remaining mutation
    # work so the final gate is strict without double-counting durable assets.
    requirements[state_device] = {
        "path": transaction_dir,
        "bytes": 64 * 1024**2,
        "inodes": 256,
    }
for target in maximal:
    parent = target.parent
    while not parent.exists():
        parent = parent.parent
    device = os.stat(parent).st_dev
    requirements.setdefault(device, {"path": parent, "bytes": 0, "inodes": 0})
target_devices = {
    os.stat(next(parent for parent in (target, *target.parents) if parent.exists())).st_dev
    for target in maximal
}
for device in target_devices:
    # The staged copy and one promoted copy can coexist. The admission format
    # currently records one aggregate nested size, so charge that aggregate
    # once per destination filesystem rather than once per component.
    requirements[device]["bytes"] += nested_bytes
    requirements[device]["inodes"] += nested_inodes
database_requirement = max(
    incoming_database_bytes * 2,
    database_dump_bytes * 8 + 64 * 1024**2,
)
if admission_phase == "post-snapshot":
    rollback_dump = transaction_dir / "rollback" / "database.dump"
    rollback_info = os.lstat(rollback_dump)
    if (
        not stat.S_ISREG(rollback_info.st_mode)
        or stat.S_ISLNK(rollback_info.st_mode)
        or rollback_info.st_uid != 0
        or rollback_info.st_gid != 0
        or rollback_info.st_nlink != 1
        or rollback_info.st_mode & 0o022
        or rollback_info.st_size <= 0
    ):
        raise SystemExit("restore rollback database snapshot is unsafe")
    rollback_database_requirement = max(
        database_bytes * 2,
        rollback_info.st_size * 8 + 64 * 1024**2,
    )
    database_requirement += rollback_database_requirement
database_inode_requirement = (
    database_relation_count * 16
    + (incoming_database_bytes + 16 * 1024**2 - 1) // (16 * 1024**2)
    + 8192
)
if admission_phase == "post-snapshot":
    database_inode_requirement += (
        current_database_relation_count * 16
        + (database_bytes + 16 * 1024**2 - 1) // (16 * 1024**2)
        + 8192
    )
missing_ancestors = set()
for target in targets:
    parent = target.parent
    while not parent.exists():
        missing_ancestors.add(parent)
        parent = parent.parent
for ancestor in missing_ancestors:
    existing = ancestor.parent
    while not existing.exists():
        existing = existing.parent
    device = os.stat(existing).st_dev
    requirements.setdefault(
        device,
        {"path": existing, "bytes": 0, "inodes": 0},
    )
    requirements[device]["bytes"] += 64 * 1024
    requirements[device]["inodes"] += 1
seen_database_devices = set()
for database_path in database_paths:
    database_stats = os.statvfs(database_path)
    if database_stats.f_flag & getattr(os, "ST_RDONLY", 1):
        raise SystemExit(
            f"restore database filesystem is read-only: {database_path}"
        )
    database_device = os.stat(database_path).st_dev
    if database_device in seen_database_devices:
        continue
    seen_database_devices.add(database_device)
    requirements.setdefault(
        database_device,
        {"path": database_path, "bytes": 0, "inodes": 0},
    )
    # Charge the full restore+WAL allowance on every filesystem PostgreSQL is
    # permitted to use. This deliberately over-admits rather than guessing
    # which relation or temporary write will land on which device.
    requirements[database_device]["bytes"] += database_requirement
    requirements[database_device]["inodes"] += database_inode_requirement
for entry in requirements.values():
    stats = os.statvfs(entry["path"])
    if stats.f_flag & getattr(os, "ST_RDONLY", 1):
        raise SystemExit(
            f"restore destination filesystem is read-only: {entry['path']}"
        )
    free = stats.f_bavail * stats.f_frsize
    required = entry["bytes"] + reserve
    free_inodes = stats.f_favail
    required_inodes = entry["inodes"] + 1024
    inode_limited = stats.f_files != 0
    if free < required or (inode_limited and free_inodes < required_inodes):
        raise SystemExit(
            f"restore disk admission failed: path={entry['path']} "
            f"free={free} required={required} "
            f"freeInodes={free_inodes} requiredInodes={required_inodes}"
        )
systemd_stats = os.statvfs(systemd_root)
if systemd_stats.f_flag & getattr(os, "ST_RDONLY", 1):
    raise SystemExit("restore systemd control filesystem is read-only")
print(
    f"Restore disk admission passed: phase={admission_phase} "
    f"expanded={expanded} rollback={rollback} "
    f"archiveInodes={outer_inodes + nested_inodes} database={database_bytes} "
    f"reserve={reserve} devices={len(requirements)}"
)
PY
}

quiesce_sources() {
  local mode="${1:-stop}"
  [[ "${mode}" == "capture" || "${mode}" == "stop" ]] || return 1
  local state_file="${TRANSACTION_DIR}/service-state.json"
  if [[ "${mode}" == "capture" ]]; then
  python3 - "${state_file}" "${RESTORE_SYSTEMCTL_BIN}" "${RESTORE_DOCKER_BIN}" \
    "${RESTORE_UNITS[@]}" <<'PY'
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

output, systemctl, docker, *unit_names = sys.argv[1:]
if not unit_names or len(unit_names) != len(set(unit_names)):
    raise RuntimeError("restore mutator unit inventory is invalid")

def command(arguments, *, allowed=(0,)):
    result = subprocess.run(
        arguments, check=False, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=90,
        env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
             "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
    )
    if result.returncode not in allowed:
        raise RuntimeError("quiescence command failed")
    return result.stdout.strip()

units = {}
for unit in unit_names:
    load = command(
        [systemctl, "show", "--property=LoadState", "--value", unit]
    )
    active = command(
        [systemctl, "show", "--property=ActiveState", "--value", unit]
    )
    if load not in {"loaded", "not-found", "masked"}:
        raise RuntimeError("service load state is ambiguous")
    if active not in {"active", "inactive"}:
        raise RuntimeError("service is failed or transitioning during restore admission")
    if active == "active" and load != "loaded":
        raise RuntimeError("active service is not loaded")
    if unit == "stalwart-cert-sync.service" and active == "active":
        for _ in range(60):
            time.sleep(1)
            active = command(
                [systemctl, "show", "--property=ActiveState", "--value", unit]
            )
            if active == "inactive":
                break
        if active != "inactive":
            raise RuntimeError("transient certificate sync did not settle")
    units[unit] = {"loadState": load, "activeState": active}

selectors = {
    "com.bridgesllm.project-egress.policy": {"portal-project-egress-v1"},
    "com.bridgesllm.project-workload.policy": {"portal-project-workload-v1"},
    "com.bridgesllm.ollama-project.policy": {"portal-ollama-project-sandbox-v1"},
    "com.bridgesllm.project-runtime": {"true"},
    "com.bridgesllm.project-git": {"true"},
    "com.bridgesllm.codex-project.policy": {
        "portal-project-sandbox-v2",
        "portal-project-sandbox-v3",
    },
    "com.bridgesllm.native-cli-project.policy": {
        "portal-claude-code-project-sandbox-v1",
        "portal-antigravity-project-sandbox-v1",
    },
    "io.bridgesllm.agent-zero.managed": {"true"},
}
project_containers = []
stalwart_container = None

def restart_policy(container):
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    name = policy.get("Name")
    retries = policy.get("MaximumRetryCount")
    if name not in {"no", "always", "unless-stopped", "on-failure"}:
        raise RuntimeError("container restart policy is invalid")
    if not isinstance(retries, int) or retries < 0 or retries > 2_147_483_647:
        raise RuntimeError("container restart retry count is invalid")
    if name != "on-failure" and retries != 0:
        raise RuntimeError("container restart policy is contradictory")
    return {"name": name, "maximumRetryCount": retries}

if os.path.exists(docker):
    identifiers = command(
        [docker, "container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]
    ).splitlines()
    if len(identifiers) > 100_000:
        raise RuntimeError("Docker inventory is unbounded")
    seen_identifiers = set()
    for identifier in identifiers:
        if (
            not re.fullmatch(r"[a-f0-9]{64}", identifier)
            or identifier in seen_identifiers
        ):
            raise RuntimeError("Docker identity is invalid")
        seen_identifiers.add(identifier)
        payload = json.loads(command([docker, "container", "inspect", identifier]))
        if not isinstance(payload, list) or len(payload) != 1:
            raise RuntimeError("Docker inspection is ambiguous")
        container = payload[0]
        name = str(container.get("Name") or "").lstrip("/")
        labels = ((container.get("Config") or {}).get("Labels") or {})
        claims = [(key, labels.get(key)) for key in selectors if key in labels]
        if claims and any(value not in selectors[key] for key, value in claims):
            raise RuntimeError("managed Project labels contradict their contract")
        runtime_fingerprint = labels.get("com.bridgesllm.project-egress.runtime-fingerprint")
        openclaw_identity = labels.get("com.bridgesllm.openclaw-project.identity")
        if runtime_fingerprint is not None:
            if not isinstance(runtime_fingerprint, str) or not re.fullmatch(
                r"[a-f0-9]{64}", runtime_fingerprint
            ):
                raise RuntimeError("Project runtime fingerprint is invalid")
            claims.append(("com.bridgesllm.project-egress.runtime-fingerprint", runtime_fingerprint))
        if openclaw_identity is not None:
            if (
                not isinstance(openclaw_identity, str)
                or not re.fullmatch(r"[a-f0-9]{64}", openclaw_identity)
                or labels.get("openclaw.sandbox") != "1"
                or not re.fullmatch(
                    r"p4oc-[a-f0-9]{16}-[a-z0-9._-]{1,32}-[a-f0-9]{8}",
                    name,
                )
            ):
                raise RuntimeError("OpenClaw Project runtime identity is invalid")
            claims.extend((
                ("com.bridgesllm.openclaw-project.identity", openclaw_identity),
                ("openclaw.sandbox", "1"),
            ))
        is_running = bool((container.get("State") or {}).get("Running"))
        record = {
            "id": identifier,
            "name": name,
            "restartPolicy": restart_policy(container),
            "wasRunning": is_running,
        }
        if claims:
            if name == "stalwart-mail":
                raise RuntimeError("Stalwart cannot also claim a Project runtime contract")
            record["claims"] = dict(sorted(claims))
            project_containers.append(record)
            if len(project_containers) > 4096:
                raise RuntimeError("managed Project recovery inventory is unbounded")
        if name == "stalwart-mail":
            if stalwart_container is not None:
                raise RuntimeError("Stalwart container identity is ambiguous")
            stalwart_container = record

document = {
    "schema": "bridgesllm.restore-service-state.v2",
    "units": units,
    "projectContainers": sorted(project_containers, key=lambda entry: entry["id"]),
    "stalwartContainer": stalwart_container,
}
encoded = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")
if len(encoded) > 900 * 1024:
    raise RuntimeError("restore service-state journal is unbounded")
parent = os.path.dirname(output)
info = os.lstat(parent)
if (
    not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise RuntimeError("restore transaction directory is unsafe")
if os.path.lexists(output):
    raise RuntimeError("restore service-state journal already exists")
descriptor, temporary = tempfile.mkstemp(prefix=".service-state.", dir=parent)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    descriptor = -1
    os.replace(temporary, output)
    temporary = ""
finally:
    if descriptor >= 0:
        os.close(descriptor)
    if temporary:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
directory_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
    return
  fi
  [[ -f "${state_file}" && ! -L "${state_file}" \
    && "$(stat -c '%u:%g:%a:%h' "${state_file}")" == "0:0:600:1" ]] \
    || die "Restore service prestate is missing or unsafe"
  python3 - "${state_file}" "${RESTORE_SYSTEMCTL_BIN}" "${RESTORE_UNITS[@]}" <<'PY'
import json
import subprocess
import sys

state_path, systemctl, *unit_names = sys.argv[1:]
document = json.load(open(state_path, "r", encoding="utf-8"))
units = document.get("units")
if (
    document.get("schema") != "bridgesllm.restore-service-state.v2"
    or not isinstance(units, dict)
    or set(units) != set(unit_names)
):
    raise SystemExit(1)
for unit in unit_names:
    expected = units[unit]
    load = subprocess.run(
        [systemctl, "show", "--property=LoadState", "--value", unit],
        check=True, text=True, capture_output=True, timeout=30,
    ).stdout.strip()
    active = subprocess.run(
        [systemctl, "show", "--property=ActiveState", "--value", unit],
        check=True, text=True, capture_output=True, timeout=30,
    ).stdout.strip()
    if (load, active) != (expected.get("loadState"), expected.get("activeState")):
        raise RuntimeError("systemd state changed after durable capture")
PY
  "${RESTORE_SYSTEMCTL_BIN}" stop "${RESTORE_UNITS[@]}" >/dev/null 2>&1 || true
  local unit state
  for unit in "${RESTORE_UNITS[@]}"; do
    state="$("${RESTORE_SYSTEMCTL_BIN}" show --property=ActiveState --value "${unit}" 2>/dev/null)" \
      || die "Service ${unit} could not be re-inspected"
    [[ "${state}" == "inactive" || "${state}" == "failed" ]] \
      || die "Service ${unit} did not quiesce"
  done
  python3 - "${state_file}" "${RESTORE_DOCKER_BIN}" <<'PY'
import json
import re
import subprocess
import sys

state = json.load(open(sys.argv[1], "r", encoding="utf-8"))
docker = sys.argv[2]

def command(arguments):
    result = subprocess.run(
        arguments, check=True, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=90,
    )
    return result.stdout.strip()

def inspect_record(record, project):
    identifier = record.get("id")
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{64}", identifier):
        raise RuntimeError("recorded Docker identity is invalid")
    payload = json.loads(command([docker, "container", "inspect", identifier]))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("recorded Docker identity is ambiguous")
    container = payload[0]
    if str(container.get("Id") or "") != identifier:
        raise RuntimeError("Docker immutable identity changed")
    if str(container.get("Name") or "").lstrip("/") != record.get("name"):
        raise RuntimeError("Docker container name changed")
    if project:
        labels = ((container.get("Config") or {}).get("Labels") or {})
        if {key: labels.get(key) for key in record["claims"]} != record["claims"]:
            raise RuntimeError("managed Project ownership labels changed")
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    if (
        policy.get("Name") != record["restartPolicy"]["name"]
        or policy.get("MaximumRetryCount") != record["restartPolicy"]["maximumRetryCount"]
    ):
        raise RuntimeError("Docker restart policy changed before quiescence")
    return container

records = [(entry, True) for entry in state["projectContainers"]]
if state.get("stalwartContainer") is not None:
    records.append((state["stalwartContainer"], False))
for record, project in records:
    container = inspect_record(record, project)
    running = bool((container.get("State") or {}).get("Running"))
    if running != record["wasRunning"]:
        raise RuntimeError("container state changed after durable capture")
    if record["restartPolicy"]["name"] != "no":
        command([docker, "container", "update", "--restart=no", record["id"]])
    if running:
        command([docker, "container", "stop", "--time", "30", record["id"]])
    payload = json.loads(command([docker, "container", "inspect", record["id"]]))[0]
    policy = ((payload.get("HostConfig") or {}).get("RestartPolicy") or {})
    if bool((payload.get("State") or {}).get("Running")) or policy.get("Name") != "no":
        raise RuntimeError("container did not remain boot-neutral and stopped")
PY
}

restore_service_state() {
  local state_file="${TRANSACTION_DIR}/service-state.json"
  [[ -f "${state_file}" && ! -L "${state_file}" ]] || return 0
  python3 - "${state_file}" "${RESTORE_SYSTEMCTL_BIN}" "${RESTORE_DOCKER_BIN}" \
    "${RESTORE_UNITS[@]}" <<'PY'
import json
import os
import re
import stat
import subprocess
import sys

state_path = sys.argv[1]
info = os.lstat(state_path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or info.st_mode & 0o022
    or info.st_size <= 0
    or info.st_size > 1024 * 1024
):
    raise SystemExit(1)
state = json.load(open(state_path, "r", encoding="utf-8"))
systemctl, docker, *unit_order = sys.argv[2:]
if state.get("schema") != "bridgesllm.restore-service-state.v2":
    raise SystemExit(1)
units = state.get("units")
unit_names = set(unit_order)
if (
    not unit_order
    or len(unit_order) != len(unit_names)
    or not isinstance(units, dict)
    or set(units) != unit_names
    or not all(
        isinstance(value, dict)
        and set(value) == {"loadState", "activeState"}
        and value["loadState"] in {"loaded", "not-found", "masked"}
        and value["activeState"] in {"active", "inactive"}
        and not (
            value["activeState"] == "active"
            and value["loadState"] != "loaded"
        )
        for value in units.values()
    )
):
    raise SystemExit(1)
containers = state.get("projectContainers")
stalwart = state.get("stalwartContainer")
if not isinstance(containers, list) or (stalwart is not None and not isinstance(stalwart, dict)):
    raise SystemExit(1)

def command(arguments, timeout=90):
    result = subprocess.run(
        arguments, check=True, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=timeout,
    )
    return result.stdout.strip()

def validate_record(record, project):
    if not isinstance(record, dict) or set(record) != (
        {"id", "name", "restartPolicy", "wasRunning", "claims"}
        if project else {"id", "name", "restartPolicy", "wasRunning"}
    ):
        raise RuntimeError("recorded Docker state is invalid")
    identifier = record["id"]
    policy = record["restartPolicy"]
    if (
        not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or not isinstance(record["name"], str)
        or not record["name"]
        or not isinstance(record["wasRunning"], bool)
        or not isinstance(policy, dict)
        or set(policy) != {"name", "maximumRetryCount"}
        or policy["name"] not in {"no", "always", "unless-stopped", "on-failure"}
        or not isinstance(policy["maximumRetryCount"], int)
        or policy["maximumRetryCount"] < 0
        or (policy["name"] != "on-failure" and policy["maximumRetryCount"] != 0)
    ):
        raise RuntimeError("recorded Docker state is invalid")
    if project and (
        not isinstance(record["claims"], dict)
        or not record["claims"]
        or not all(isinstance(key, str) and isinstance(value, str)
                   for key, value in record["claims"].items())
    ):
        raise RuntimeError("recorded Project ownership claims are invalid")
    return identifier

records = [(entry, True) for entry in containers]
if stalwart is not None:
    records.append((stalwart, False))
identifiers = [validate_record(record, project) for record, project in records]
if len(set(identifiers)) != len(identifiers):
    raise RuntimeError("recorded Docker identities are duplicated")

for record, project in records:
    payload = json.loads(command([docker, "container", "inspect", record["id"]]))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("recorded Docker identity is ambiguous")
    container = payload[0]
    if str(container.get("Id") or "") != record["id"]:
        raise RuntimeError("Docker immutable identity changed")
    if str(container.get("Name") or "").lstrip("/") != record["name"]:
        raise RuntimeError("Docker container name changed")
    if project:
        labels = ((container.get("Config") or {}).get("Labels") or {})
        if {key: labels.get(key) for key in record["claims"]} != record["claims"]:
            raise RuntimeError("managed Project ownership labels changed")
    policy = record["restartPolicy"]
    restart = policy["name"]
    if restart == "on-failure" and policy["maximumRetryCount"]:
        restart = f"{restart}:{policy['maximumRetryCount']}"
    command([docker, "container", "update", f"--restart={restart}", record["id"]])
    payload = json.loads(command([docker, "container", "inspect", record["id"]]))[0]
    actual = ((payload.get("HostConfig") or {}).get("RestartPolicy") or {})
    if (
        actual.get("Name") != policy["name"]
        or actual.get("MaximumRetryCount") != policy["maximumRetryCount"]
    ):
        raise RuntimeError("Docker restart policy did not restore exactly")
    running = bool((payload.get("State") or {}).get("Running"))
    if record["wasRunning"] and not running:
        command([docker, "container", "start", record["id"]])
    elif not record["wasRunning"] and running:
        raise RuntimeError("a previously stopped container started during recovery")

restore_order = [
    unit for unit in unit_order
    if unit != "bridgesllm-product.service"
] + ["bridgesllm-product.service"]
for unit in restore_order:
    if units[unit]["activeState"] == "active":
        command([systemctl, "start", unit], timeout=120)
for unit, expected in units.items():
    load = command(
        [systemctl, "show", "--property=LoadState", "--value", unit],
        timeout=30,
    )
    active = command(
        [systemctl, "show", "--property=ActiveState", "--value", unit],
        timeout=30,
    )
    if (load, active) != (expected["loadState"], expected["activeState"]):
        raise RuntimeError("systemd service state did not restore exactly")
for record, project in records:
    payload = json.loads(command([docker, "container", "inspect", record["id"]]))[0]
    if str(payload.get("Id") or "") != record["id"]:
        raise RuntimeError("Docker immutable identity changed after restart")
    if str(payload.get("Name") or "").lstrip("/") != record["name"]:
        raise RuntimeError("Docker container name changed after restart")
    if project:
        labels = ((payload.get("Config") or {}).get("Labels") or {})
        if {key: labels.get(key) for key in record["claims"]} != record["claims"]:
            raise RuntimeError("managed Project ownership labels changed after restart")
    actual = ((payload.get("HostConfig") or {}).get("RestartPolicy") or {})
    expected = record["restartPolicy"]
    if (
        bool((payload.get("State") or {}).get("Running")) != record["wasRunning"]
        or actual.get("Name") != expected["name"]
        or actual.get("MaximumRetryCount") != expected["maximumRetryCount"]
    ):
        raise RuntimeError("Docker runtime state did not restore exactly")
PY
}

extract_archive() {
  local stage="${TRANSACTION_DIR}/stage"
  python3 - "${ARCHIVE}" "${ADMISSION_FILE}" "${ACTIVE_JOURNAL}" \
    "${TRANSACTION_ID}" "${TRANSACTION_DIR}" \
    3<<<"${RESTORE_OPERATION_NONCE}" <<'PY' \
    || die "Sealed archive, admission, and journal binding changed before extraction"
import hashlib
import json
import os
import re
import stat
import sys

archive, admission_path, journal_path, transaction_id, transaction_dir = sys.argv[1:]
operation_nonce = os.fdopen(3, "r", encoding="ascii").read().strip()
if (
    not re.fullmatch(r"[a-f0-9]{32}", transaction_id)
    or not re.fullmatch(r"[a-f0-9]{64}", operation_nonce)
):
    raise SystemExit(1)
info = os.lstat(archive)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_nlink != 1
    or info.st_mode & 0o022
):
    raise SystemExit(1)
admission = json.load(open(admission_path, "r", encoding="utf-8"))
journal = json.load(open(journal_path, "r", encoding="utf-8"))
digest = hashlib.sha256()
with open(archive, "rb", buffering=0) as handle:
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
actual = digest.hexdigest()
expected_journal_keys = {
    "schema",
    "transactionId",
    "operationNonce",
    "transactionDir",
    "archive",
    "archiveSha256",
    "admission",
    "phase",
    "startedAt",
}
if (
    admission.get("schema") != "bridgesllm.restore-admission.v2"
    or set(journal) != expected_journal_keys
    or journal.get("schema") != "bridgesllm.restore-transaction.v2"
    or journal.get("transactionId") != transaction_id
    or journal.get("operationNonce") != operation_nonce
    or journal.get("transactionDir") != transaction_dir
    or admission.get("archive") != archive
    or journal.get("archive") != archive
    or journal.get("admission") != admission_path
    or journal.get("phase") != "preparing"
    or admission.get("archiveSha256") != actual
    or journal.get("archiveSha256") != actual
):
    raise SystemExit(1)
PY
  python3 "${ARCHIVE_HELPER}" extract \
    --archive "${ARCHIVE}" \
    --hmac-key "${RESTORE_HMAC_KEY}" \
    --destination "${stage}" \
    || die "Verified outer archive could not be staged safely"
  mkdir -p "${TRANSACTION_DIR}/components"
  local components_file
  components_file="$(mktemp "${TRANSACTION_DIR}/.admitted-components.extract.XXXXXX")" \
    || die "Recovery component inventory could not be materialized"
  if ! admitted_components > "${components_file}"; then
    rm -f -- "${components_file}"
    die "Recovery component inventory could not be materialized"
  fi
  [[ -s "${components_file}" ]] || {
    rm -f -- "${components_file}"
    die "Recovery component inventory is empty"
  }
  while IFS=$'\t' read -r component payload target kind; do
    [[ "${kind}" == "directory" ]] || continue
    python3 "${ARCHIVE_HELPER}" extract-component \
      --archive "${stage}/${payload}" \
      --destination "${TRANSACTION_DIR}/components/${component}" \
      --target "${target}" \
      --component "${component}" \
      || die "Nested recovery component could not be staged safely: ${component}"
  done < "${components_file}"
  rm -f -- "${components_file}"
  sync_tree "${TRANSACTION_DIR}" \
    || die "Staged recovery payloads were not committed durably"
}

admitted_components() {
  python3 - "${ADMISSION_FILE}" <<'PY'
import json
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
if document.get("schema") != "bridgesllm.restore-admission.v2":
    raise SystemExit(1)
for entry in document["components"]:
    values = [entry["id"], entry["payload"], entry["target"], entry["kind"]]
    if any("\t" in value or "\n" in value for value in values):
        raise SystemExit(1)
    print("\t".join(values))
PY
}

assert_crash_persistent_control_filesystems() {
  python3 - /proc/1/mountinfo /proc/1/root \
    /proc/self/mountinfo /proc/self/root \
    "${STATE_ROOT}" "${SYSTEMD_ROOT}" "${RESTORE_TRUST_ROOT}" <<'PY'
import os
import pathlib
import re
import sys

(
    host_mountinfo_path,
    host_root,
    self_mountinfo_path,
    self_root,
    state_root,
    systemd_root,
    trust_root,
) = sys.argv[1:]

volatile_types = {
    "autofs",
    "bpf",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devtmpfs",
    "efivarfs",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "nsfs",
    "proc",
    "pstore",
    "ramfs",
    "securityfs",
    "sysfs",
    "tmpfs",
    "tracefs",
}

def decode_mount_path(value):
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )

def parse_mounts(path):
    try:
        lines = pathlib.Path(path).read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError:
        raise SystemExit(1)
    records = []
    for line in lines:
        fields = line.split()
        try:
            separator = fields.index("-")
        except ValueError:
            raise SystemExit(1)
        if separator < 6 or len(fields) < separator + 3:
            raise SystemExit(1)
        mountpoint = pathlib.Path(decode_mount_path(fields[4]))
        mount_root = decode_mount_path(fields[3])
        source = decode_mount_path(fields[separator + 2])
        fs_type = fields[separator + 1]
        if (
            not mountpoint.is_absolute()
            or not re.fullmatch(r"[0-9]+:[0-9]+", fields[2])
            or not mount_root
            or not source
            or not fs_type
            or len(mount_root) > 4096
            or len(source) > 4096
            or any(
                ord(char) < 32 or ord(char) == 127
                for value in (str(mountpoint), mount_root, source, fs_type)
                for char in value
            )
        ):
            raise SystemExit(1)
        records.append({
            "majorMinor": fields[2],
            "mountRoot": mount_root,
            "mountPoint": str(mountpoint),
            "fsType": fs_type,
            "source": source,
        })
    return records

def mount_for(target, mounts):
    matches = [
        record
        for record in mounts
        if (
            pathlib.Path(record["mountPoint"]) == pathlib.Path("/")
            or target == pathlib.Path(record["mountPoint"])
            or target.is_relative_to(pathlib.Path(record["mountPoint"]))
        )
    ]
    points = [record["mountPoint"] for record in matches]
    if not matches or len(points) != len(set(points)):
        raise SystemExit(1)
    matches.sort(
        key=lambda record: (
            len(pathlib.Path(record["mountPoint"]).parts),
            record["mountPoint"],
        )
    )
    return matches[-1]

def namespace_path(root, path):
    return pathlib.Path(root) / path.relative_to("/")

host_mounts = parse_mounts(host_mountinfo_path)
self_mounts = parse_mounts(self_mountinfo_path)
for raw_target in (state_root, systemd_root, trust_root):
    target = pathlib.Path(raw_target)
    if (
        not target.is_absolute()
        or os.path.normpath(raw_target) != raw_target
    ):
        raise SystemExit(1)
    host_record = mount_for(target, host_mounts)
    self_record = mount_for(target, self_mounts)
    if host_record != self_record:
        raise SystemExit(
            f"control filesystem diverged from PID1: {target}"
        )
    if host_record["fsType"].lower() in volatile_types:
        raise SystemExit(
            f"control filesystem is not crash-persistent: {target}"
        )
    mountpoint = pathlib.Path(host_record["mountPoint"])
    for namespace_root in (host_root, self_root):
        stats = os.statvfs(namespace_path(namespace_root, mountpoint))
        if stats.f_flag & getattr(os, "ST_RDONLY", 1):
            raise SystemExit(
                f"control filesystem is read-only: {target}"
            )
PY
}

assert_restore_archive_trust() {
  assert_crash_persistent_control_filesystems || return 1
  python3 - "${RESTORE_TRUST_ROOT}" "${RESTORE_HMAC_KEY}" \
    "${PORTAL_DIR}" "${STATE_ROOT}" "${SYSTEMD_ROOT}" \
    "${BACKUP_RECOVERY_STATE_DIR}" "${INSTALLER_STATE_ROOT}" <<'PY'
import fcntl
import os
import pathlib
import stat
import struct
import sys

raw_root, raw_key, *protected_raw = sys.argv[1:]
root = pathlib.Path(raw_root)
key = pathlib.Path(raw_key)
if (
    not root.is_absolute()
    or os.path.normpath(raw_root) != raw_root
    or root == pathlib.Path("/")
    or key != root / "archive-hmac.key"
    or any(ord(char) < 32 or ord(char) == 127 for char in raw_root)
):
    raise SystemExit(1)
for raw in protected_raw:
    protected = pathlib.Path(raw)
    if (
        not protected.is_absolute()
        or os.path.normpath(raw) != raw
        or root == protected
        or root.is_relative_to(protected)
        or protected.is_relative_to(root)
    ):
        raise SystemExit(1)

directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
current_fd = os.open("/", directory_flags)
try:
    for index, component in enumerate(root.parts[1:]):
        child_fd = os.open(component, directory_flags, dir_fd=current_fd)
        info = os.fstat(child_fd)
        final = index == len(root.parts[1:]) - 1
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
            or (final and stat.S_IMODE(info.st_mode) != 0o700)
        ):
            os.close(child_fd)
            raise SystemExit(1)
        os.close(current_fd)
        current_fd = child_fd
    trust_fd = current_fd
    current_fd = -1
finally:
    if current_fd >= 0:
        os.close(current_fd)

FS_IOC_GETFLAGS = (
    (2 << 30)
    | (struct.calcsize("@L") << 16)
    | (ord("f") << 8)
    | 1
)
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020

def mutable_flags(descriptor):
    encoded = bytearray(struct.calcsize("@L"))
    try:
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, encoded, True)
    except OSError:
        raise SystemExit(1)
    if struct.unpack("@L", encoded)[0] & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        raise SystemExit(1)

try:
    mutable_flags(trust_fd)
    key_fd = os.open(
        "archive-hmac.key",
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
        dir_fd=trust_fd,
    )
    try:
        info = os.fstat(key_fd)
        payload = os.read(key_fd, 33)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size != 32
            or len(payload) != 32
        ):
            raise SystemExit(1)
        mutable_flags(key_fd)
    finally:
        os.close(key_fd)
finally:
    os.close(trust_fd)
PY
}

seal_restore_mount_authority() {
  local temporary="${TRANSACTION_DIR}/.mount-authority-${TRANSACTION_ID}"
  [[ ! -e "${temporary}" && ! -L "${temporary}" ]] || return 1
  python3 - "${ADMISSION_FILE}" "${temporary}" /proc/1/mountinfo \
    /proc/1/root "${PORTAL_DIR}" "${PORTAL_ENV_FILE}" \
    "${STATE_ROOT}" "${SYSTEMD_ROOT}" "${BACKUP_RECOVERY_STATE_DIR}" \
    "${INSTALLER_STATE_ROOT}" <<'PY'
import json
import os
import pathlib
import re
import stat
import sys

(
    admission_path,
    temporary,
    mountinfo_path,
    host_root,
    portal_root,
    portal_env,
    state_root,
    systemd_root,
    backup_state_root,
    installer_state_root,
) = sys.argv[1:]
info = os.lstat(admission_path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
):
    raise SystemExit(1)
document = json.load(open(admission_path, "r", encoding="utf-8"))
components = document.get("components")
if (
    document.get("schema") != "bridgesllm.restore-admission.v2"
    or not isinstance(components, list)
    or "mountAuthority" in document
):
    raise SystemExit(1)
writable_targets = {
    pathlib.Path(value)
    for value in (
        portal_root,
        portal_env,
        state_root,
        systemd_root,
    )
}
targets = writable_targets | {
    pathlib.Path(value)
    for value in (
        backup_state_root,
        installer_state_root,
    )
}
for entry in components:
    target = entry.get("target") if isinstance(entry, dict) else None
    if (
        not isinstance(target, str)
        or not target.startswith("/")
        or os.path.normpath(target) != target
    ):
        raise SystemExit(1)
    target_path = pathlib.Path(target)
    targets.add(target_path)
    writable_targets.add(target_path)
maximal = []
for target in sorted(targets, key=lambda item: (len(item.parts), str(item))):
    if any(target == root or target.is_relative_to(root) for root in maximal):
        continue
    maximal.append(target)

def decode_mount_path(value):
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )

def parse_mounts():
    try:
        lines = pathlib.Path(mountinfo_path).read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError:
        raise SystemExit(1)
    result = []
    for line in lines:
        fields = line.split()
        try:
            separator = fields.index("-")
        except ValueError:
            raise SystemExit(1)
        if separator < 6 or len(fields) < separator + 3:
            raise SystemExit(1)
        mountpoint = pathlib.Path(decode_mount_path(fields[4]))
        mount_root = decode_mount_path(fields[3])
        source = decode_mount_path(fields[separator + 2])
        if (
            not mountpoint.is_absolute()
            or not re.fullmatch(r"[0-9]+:[0-9]+", fields[2])
            or not mount_root
            or len(mount_root) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in mount_root)
            or not source
            or len(source) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in source)
        ):
            raise SystemExit(1)
        result.append({
            "_majorMinor": fields[2],
            "_source": source,
            "mountRoot": mount_root,
            "mountPoint": str(mountpoint),
            "fsType": fields[separator + 1],
        })
    return result

mounts = parse_mounts()
host_prefix = pathlib.Path(host_root)

def host_path(path):
    return host_prefix / path.relative_to("/")

def host_path_info(path):
    candidate = host_path(path)
    if path != pathlib.Path("/"):
        return os.lstat(candidate)
    # /proc/1/root is a kernel-owned namespace link. For the namespace root
    # itself it is the final pathname component, so lstat() observes the link
    # instead of the directory it authoritatively names. Open it as a
    # directory and bind the underlying root inode without weakening
    # no-follow checks for any ordinary restore anchor.
    descriptor = os.open(
        candidate,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        return os.fstat(descriptor)
    finally:
        os.close(descriptor)

def source_identity(entry):
    major_raw, minor_raw = entry["_majorMinor"].split(":", 1)
    major, minor = int(major_raw), int(minor_raw)
    sys_device = host_prefix / "sys/dev/block" / entry["_majorMinor"]
    if sys_device.exists():
        matches = []
        uuid_root = host_prefix / "dev/disk/by-uuid"
        if uuid_root.is_dir():
            for candidate in uuid_root.iterdir():
                try:
                    info = os.stat(candidate)
                except OSError:
                    continue
                if stat.S_ISBLK(info.st_mode) and os.major(info.st_rdev) == major \
                    and os.minor(info.st_rdev) == minor:
                    matches.append(candidate.name)
        if len(matches) > 1:
            raise SystemExit("block filesystem has ambiguous UUID identity")
        if not matches:
            raise SystemExit(
                "block filesystem lacks a persistent UUID restore identity"
            )
        return "block-uuid:" + matches[0]
    return "source:" + entry["_source"]

def mount_chain(target):
    chain = [
        entry
        for entry in mounts
        if (
            pathlib.Path(entry["mountPoint"]) == pathlib.Path("/")
            or target == pathlib.Path(entry["mountPoint"])
            or target.is_relative_to(pathlib.Path(entry["mountPoint"]))
        )
    ]
    points = [entry["mountPoint"] for entry in chain]
    if not chain or len(points) != len(set(points)):
        raise SystemExit("stacked host mounts are unsupported for restore targets")
    chain.sort(
        key=lambda entry: (
            len(pathlib.Path(entry["mountPoint"]).parts),
            entry["mountPoint"],
        )
    )
    enriched = []
    for entry in chain:
        current = {
            key: value
            for key, value in entry.items()
            if not key.startswith("_")
        }
        current["sourceIdentity"] = source_identity(entry)
        enriched.append(current)
    return enriched

def anchor_for(target):
    anchor = target.parent
    while any(anchor == root or anchor.is_relative_to(root) for root in maximal):
        if anchor == anchor.parent:
            raise SystemExit(1)
        anchor = anchor.parent
    while not os.path.lexists(host_path(anchor)):
        if anchor == anchor.parent:
            raise SystemExit(1)
        anchor = anchor.parent
    anchor_info = host_path_info(anchor)
    if (
        not stat.S_ISDIR(anchor_info.st_mode)
        or stat.S_ISLNK(anchor_info.st_mode)
        or anchor_info.st_uid != 0
        or anchor_info.st_gid != 0
        or anchor_info.st_mode & 0o022
    ):
        raise SystemExit("restore mount anchor is unsafe")
    return {
        "path": str(anchor),
        "stIno": anchor_info.st_ino,
        "mode": stat.S_IMODE(anchor_info.st_mode),
    }

records = []
for target in sorted(targets, key=str):
    chain = mount_chain(target)
    if target in writable_targets:
        mountpoint = pathlib.Path(chain[-1]["mountPoint"])
        stats = os.statvfs(host_path(mountpoint))
        if stats.f_flag & getattr(os, "ST_RDONLY", 1):
            raise SystemExit(
                f"restore target filesystem is read-only: {target}"
            )
    for entry in mounts:
        mountpoint = pathlib.Path(entry["mountPoint"])
        if mountpoint == target or mountpoint.is_relative_to(target):
            raise SystemExit(
                f"host mount exists at or below restore target: {target}"
            )
    records.append({
        "target": str(target),
        "anchor": anchor_for(target),
        "mountChain": chain,
    })
document["mountAuthority"] = {
    "schema": "bridgesllm.restore-mount-authority.v1",
    "records": records,
}
flags = (
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
)
descriptor = os.open(temporary, flags, 0o600)
try:
    payload = (
        json.dumps(document, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    written = 0
    while written < len(payload):
        count = os.write(descriptor, payload[written:])
        if count <= 0:
            raise OSError("short mount authority write")
        written += count
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, admission_path)
directory = os.open(
    os.path.dirname(admission_path),
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

assert_host_restore_target_mounts_clear() {
  [[ -f "${ADMISSION_FILE}" && ! -L "${ADMISSION_FILE}" ]] || return 1
  python3 - "${ADMISSION_FILE}" /proc/1/mountinfo \
    /proc/1/root /proc/self/mountinfo /proc/self/root \
    "${PORTAL_DIR}" "${PORTAL_ENV_FILE}" "${STATE_ROOT}" "${SYSTEMD_ROOT}" \
    "${BACKUP_RECOVERY_STATE_DIR}" "${INSTALLER_STATE_ROOT}" \
    "$(dirname -- "${OPERATION_LOCK}")" <<'PY'
import json
import os
import pathlib
import re
import stat
import sys

(
    admission_path,
    host_mountinfo_path,
    host_root,
    self_mountinfo_path,
    self_root,
    portal_root,
    portal_env,
    state_root,
    systemd_root,
    backup_state_root,
    installer_state_root,
    operation_lock_parent,
) = sys.argv[1:]
info = os.lstat(admission_path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or info.st_mode & 0o022
):
    raise SystemExit(1)
document = json.load(open(admission_path, "r", encoding="utf-8"))
components = document.get("components")
authority = document.get("mountAuthority")
if (
    document.get("schema") != "bridgesllm.restore-admission.v2"
    or not isinstance(components, list)
    or not isinstance(authority, dict)
    or authority.get("schema") != "bridgesllm.restore-mount-authority.v1"
    or not isinstance(authority.get("records"), list)
):
    raise SystemExit(1)
writable_targets = {
    pathlib.Path(value)
    for value in (
        portal_root,
        portal_env,
        state_root,
        systemd_root,
    )
}
targets = writable_targets | {
    pathlib.Path(value)
    for value in (
        backup_state_root,
        installer_state_root,
    )
}
for entry in components:
    target = entry.get("target") if isinstance(entry, dict) else None
    if (
        not isinstance(target, str)
        or not target.startswith("/")
        or os.path.normpath(target) != target
    ):
        raise SystemExit(1)
    target_path = pathlib.Path(target)
    targets.add(target_path)
    writable_targets.add(target_path)

def decode_mount_path(value):
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )

def parse_mounts(path):
    try:
        lines = pathlib.Path(path).read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError:
        raise SystemExit(1)
    result = []
    for line in lines:
        fields = line.split()
        try:
            separator = fields.index("-")
        except ValueError:
            raise SystemExit(1)
        if separator < 6 or len(fields) < separator + 3:
            raise SystemExit(1)
        mountpoint = pathlib.Path(decode_mount_path(fields[4]))
        mount_root = decode_mount_path(fields[3])
        source = decode_mount_path(fields[separator + 2])
        if (
            not mountpoint.is_absolute()
            or not re.fullmatch(r"[0-9]+:[0-9]+", fields[2])
            or not mount_root
            or len(mount_root) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in mount_root)
            or not source
            or len(source) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in source)
        ):
            raise SystemExit(1)
        result.append({
            "_majorMinor": fields[2],
            "_source": source,
            "mountRoot": mount_root,
            "mountPoint": str(mountpoint),
            "fsType": fields[separator + 1],
        })
    return result

def namespace_path(root, path):
    return pathlib.Path(root) / path.relative_to("/")

def namespace_path_info(root, path):
    candidate = namespace_path(root, path)
    if path != pathlib.Path("/"):
        return os.lstat(candidate)
    # /proc/{1,self}/root is intentionally a namespace link. Only the root
    # anchor receives this directory-open treatment; every non-root anchor
    # remains lstat-bound and rejects symlinks.
    descriptor = os.open(
        candidate,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        return os.fstat(descriptor)
    finally:
        os.close(descriptor)

def source_identity(entry, namespace_root):
    major_raw, minor_raw = entry["_majorMinor"].split(":", 1)
    major, minor = int(major_raw), int(minor_raw)
    root = pathlib.Path(namespace_root)
    sys_device = root / "sys/dev/block" / entry["_majorMinor"]
    if sys_device.exists():
        matches = []
        uuid_root = root / "dev/disk/by-uuid"
        if uuid_root.is_dir():
            for candidate in uuid_root.iterdir():
                try:
                    info = os.stat(candidate)
                except OSError:
                    continue
                if stat.S_ISBLK(info.st_mode) and os.major(info.st_rdev) == major \
                    and os.minor(info.st_rdev) == minor:
                    matches.append(candidate.name)
        if len(matches) > 1:
            raise SystemExit(1)
        if not matches:
            raise SystemExit(1)
        return "block-uuid:" + matches[0]
    return "source:" + entry["_source"]

def current_record(
    target,
    anchor_path,
    mounts,
    namespace_root,
    allow_sticky_anchor=False,
    include_live_fsid=False,
    require_writable=False,
):
    chain = [
        entry
        for entry in mounts
        if (
            pathlib.Path(entry["mountPoint"]) == pathlib.Path("/")
            or target == pathlib.Path(entry["mountPoint"])
            or target.is_relative_to(pathlib.Path(entry["mountPoint"]))
        )
    ]
    points = [entry["mountPoint"] for entry in chain]
    if not chain or len(points) != len(set(points)):
        raise SystemExit(1)
    chain.sort(
        key=lambda entry: (
            len(pathlib.Path(entry["mountPoint"]).parts),
            entry["mountPoint"],
        )
    )
    if require_writable:
        stats = os.statvfs(
            namespace_path(
                namespace_root,
                pathlib.Path(chain[-1]["mountPoint"]),
            )
        )
        if stats.f_flag & getattr(os, "ST_RDONLY", 1):
            raise SystemExit(1)
    enriched = []
    for entry in chain:
        current = {
            key: value
            for key, value in entry.items()
            if not key.startswith("_")
        }
        if include_live_fsid:
            current["liveFsId"] = os.statvfs(
                namespace_path(namespace_root, pathlib.Path(entry["mountPoint"]))
            ).f_fsid
        current["sourceIdentity"] = source_identity(entry, namespace_root)
        enriched.append(current)
    anchor_info = namespace_path_info(namespace_root, anchor_path)
    if (
        not stat.S_ISDIR(anchor_info.st_mode)
        or stat.S_ISLNK(anchor_info.st_mode)
        or anchor_info.st_uid != 0
        or anchor_info.st_gid != 0
        or (
            anchor_info.st_mode & 0o022
            and not (
                allow_sticky_anchor
                and anchor_info.st_mode & stat.S_ISVTX
            )
        )
    ):
        raise SystemExit(1)
    anchor = {
        "path": str(anchor_path),
        "stIno": anchor_info.st_ino,
        "mode": stat.S_IMODE(anchor_info.st_mode),
    }
    if include_live_fsid:
        anchor["liveFsId"] = os.statvfs(
            namespace_path(namespace_root, anchor_path)
        ).f_fsid
    return {
        "target": str(target),
        "anchor": anchor,
        "mountChain": enriched,
    }

host_mounts = parse_mounts(host_mountinfo_path)
self_mounts = parse_mounts(self_mountinfo_path)
expected_by_target = {}
for record in authority["records"]:
    if not isinstance(record, dict) or set(record) != {
        "target", "anchor", "mountChain"
    }:
        raise SystemExit(1)
    target_value = record.get("target")
    anchor = record.get("anchor")
    if (
        not isinstance(target_value, str)
        or not isinstance(anchor, dict)
        or set(anchor) != {"path", "stIno", "mode"}
        or target_value in expected_by_target
    ):
        raise SystemExit(1)
    expected_by_target[target_value] = record
if set(expected_by_target) != {str(target) for target in targets}:
    raise SystemExit(1)
for target in targets:
    if (
        not target.is_absolute()
        or os.path.normpath(str(target)) != str(target)
    ):
        raise SystemExit(1)
    expected = expected_by_target[str(target)]
    anchor_path = pathlib.Path(expected["anchor"]["path"])
    if (
        not anchor_path.is_absolute()
        or os.path.normpath(str(anchor_path)) != str(anchor_path)
        or target == anchor_path
        or not target.is_relative_to(anchor_path)
    ):
        raise SystemExit(1)
    for label, mounts, namespace_root in (
        ("host", host_mounts, host_root),
        ("restore namespace", self_mounts, self_root),
    ):
        actual = current_record(
            target,
            anchor_path,
            mounts,
            namespace_root,
            False,
            False,
            target in writable_targets,
        )
        if actual != expected:
            raise SystemExit(
                f"{label} mount authority changed for restore target: {target}"
            )
        for entry in mounts:
            mountpoint = pathlib.Path(entry["mountPoint"])
            if mountpoint == target or mountpoint.is_relative_to(target):
                raise SystemExit(
                    f"{label} mount appeared at or below restore target: {target}"
                )
    host_live = current_record(
        target,
        anchor_path,
        host_mounts,
        host_root,
        False,
        True,
        target in writable_targets,
    )
    self_live = current_record(
        target,
        anchor_path,
        self_mounts,
        self_root,
        False,
        True,
        target in writable_targets,
    )
    if host_live != self_live:
        raise SystemExit(
            f"live mount authority diverged from PID1 for restore target: {target}"
        )
volatile_target = pathlib.Path(operation_lock_parent)
if (
    not volatile_target.is_absolute()
    or os.path.normpath(str(volatile_target)) != str(volatile_target)
):
    raise SystemExit(1)
host_volatile = current_record(
    volatile_target,
    volatile_target,
    host_mounts,
    host_root,
    True,
    True,
    True,
)
self_volatile = current_record(
    volatile_target,
    volatile_target,
    self_mounts,
    self_root,
    True,
    True,
    True,
)
if host_volatile != self_volatile:
    raise SystemExit("operation-lock mount authority diverged from PID1")
for label, mounts in (("host", host_mounts), ("restore namespace", self_mounts)):
    for entry in mounts:
        mountpoint = pathlib.Path(entry["mountPoint"])
        if (
            mountpoint != volatile_target
            and mountpoint.is_relative_to(volatile_target)
        ):
            raise SystemExit(
                f"{label} mount appeared below the operation-lock root"
            )
PY
}

assert_restore_runtime_bindings() {
  python3 - "${ADMISSION_FILE}" "${PORTAL_DIR}" "${PORTAL_ENV_FILE}" \
    "${AUTHORITY_ROOT}" "${TRANSACTION_DIR}" <<'PY'
import json
import hashlib
import os
import pathlib
import stat
import sys

admission_path, portal_root, portal_env, authority_root, transaction_dir = sys.argv[1:]
document = json.load(open(admission_path, "r", encoding="utf-8"))
if document.get("schema") != "bridgesllm.restore-admission.v2":
    raise SystemExit(1)
by_id = {}
for entry in document.get("components", []):
    component_id = entry.get("id")
    if component_id in by_id:
        raise SystemExit(1)
    by_id[component_id] = entry
portal_entry = by_id.get("portal-install")
environment_entry = by_id.get("portal-environment")
authority = document.get("recoveryAuthority")
authority_paths = {
    "restore-full.sh",
    "backup-full.sh",
    "backend/.env.production",
    "installer/install.sh",
    "installer/portal-recovery-archive.py",
}
if (
    not isinstance(portal_entry, dict)
    or set(portal_entry) != {
        "id", "payload", "target", "kind", "expandedBytes", "expandedInodes"
    }
    or any(portal_entry.get(key) != value for key, value in {
        "id": "portal-install",
        "payload": "portal-install.tar.gz",
        "target": portal_root,
        "kind": "directory",
    }.items())
    or not isinstance(portal_entry.get("expandedBytes"), int)
    or portal_entry["expandedBytes"] <= 0
    or not isinstance(portal_entry.get("expandedInodes"), int)
    or portal_entry["expandedInodes"] <= 0
    or environment_entry != {
        "id": "portal-environment",
        "payload": "configs/portal-backend.env.production",
        "target": portal_env,
        "kind": "file",
    }
    or portal_env != os.path.join(portal_root, "backend", ".env.production")
    or pathlib.Path(authority_root)
        != pathlib.Path(transaction_dir) / "recovery-runtime"
    or not isinstance(authority, dict)
    or set(authority) != authority_paths
):
    raise SystemExit(1)
for relative, expected_digest in authority.items():
    path = pathlib.Path(portal_root) / relative
    try:
        info = os.lstat(path)
    except OSError:
        raise SystemExit(1)
    if (
        not isinstance(expected_digest, str)
        or len(expected_digest) != 64
        or any(char not in "0123456789abcdef" for char in expected_digest)
        or not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or info.st_size <= 0
        or info.st_size > 32 * 1024 * 1024
    ):
        raise SystemExit(1)
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    if digest.hexdigest() != expected_digest:
        raise SystemExit(1)
    if relative == "backend/.env.production":
        sealed = pathlib.Path(admission_path).parent / "database-authority.env"
        try:
            sealed_info = os.lstat(sealed)
        except OSError:
            raise SystemExit(1)
        if (
            not stat.S_ISREG(sealed_info.st_mode)
            or stat.S_ISLNK(sealed_info.st_mode)
            or sealed_info.st_uid != 0
            or sealed_info.st_gid != 0
            or sealed_info.st_nlink != 1
            or stat.S_IMODE(sealed_info.st_mode) != 0o600
        ):
            raise SystemExit(1)
        sealed_digest = hashlib.sha256()
        with sealed.open("rb", buffering=0) as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                sealed_digest.update(chunk)
        if sealed_digest.hexdigest() != expected_digest:
            raise SystemExit(1)
    else:
        runtime_path = pathlib.Path(authority_root) / relative
        try:
            runtime_info = os.lstat(runtime_path)
        except OSError:
            raise SystemExit(1)
        if (
            not stat.S_ISREG(runtime_info.st_mode)
            or stat.S_ISLNK(runtime_info.st_mode)
            or runtime_info.st_uid != 0
            or runtime_info.st_gid != 0
            or runtime_info.st_nlink != 1
            or runtime_info.st_mode & 0o022
            or runtime_info.st_size != info.st_size
        ):
            raise SystemExit(1)
        runtime_digest = hashlib.sha256()
        with runtime_path.open("rb", buffering=0) as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                runtime_digest.update(chunk)
        if runtime_digest.hexdigest() != expected_digest:
            raise SystemExit(1)
PY
}

database_command_identity_from_authority() {
  local authority="$1"
  local database_url
  database_url="$(read_env_value "${authority}" DATABASE_URL)" \
    || return 1
  printf '%s' "${database_url}" | python3 /dev/fd/3 3<<'PY'
import sys
from urllib.parse import unquote, urlsplit, urlunsplit

raw = sys.stdin.read()
try:
    parsed = urlsplit(raw)
    credentials, separator, host_part = parsed.netloc.rpartition("@")
    username_raw = credentials.split(":", 1)[0] if separator else ""
    host = unquote(parsed.hostname or "", errors="strict")
    user = unquote(parsed.username or "", errors="strict")
    database = unquote((parsed.path or "").lstrip("/"), errors="strict")
    port = parsed.port or 5432
    decoded_host_part = unquote(host_part, errors="strict")
except (UnicodeDecodeError, ValueError):
    raise SystemExit(1)
if (
    parsed.scheme not in {"postgres", "postgresql"}
    or parsed.fragment
    or not all((separator, username_raw, host, user, database))
    or not 1 <= port <= 65535
    or "," in decoded_host_part
    or any(ord(char) < 32 or ord(char) == 127
           for value in (host, user, database) for char in value)
):
    raise SystemExit(1)
identity_keys = {
    "password", "sslpassword", "passfile", "service", "servicefile",
    "host", "hostaddr", "port", "user", "dbname", "database",
}
query = []
for pair in parsed.query.split("&") if parsed.query else ():
    key = unquote(pair.partition("=")[0], errors="strict").lower()
    if key in identity_keys:
        raise SystemExit(1)
    if key not in {"schema", "connection_limit", "pool_timeout", "pgbouncer",
                   "statement_cache_size", "socket_timeout"}:
        query.append(pair)
print(urlunsplit((parsed.scheme, f"{username_raw}@{host_part}", parsed.path, "&".join(query), "")))
PY
}

database_command_identity() {
  local authority
  authority="$(database_authority_environment)" || return 1
  database_command_identity_from_authority "${authority}"
}

restore_pgpass_runner_python() {
  cat <<'PY'
import ctypes
import os
import signal
import stat
import sys
from urllib.parse import unquote, urlsplit

try:
    expected_parent = int(sys.argv[1])
except (IndexError, ValueError):
    raise SystemExit(1)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise SystemExit(1)
if os.getppid() != expected_parent:
    os.kill(os.getpid(), signal.SIGKILL)

executable = sys.argv[2]
if not os.path.isabs(executable) or any(
    ord(char) < 32 or ord(char) == 127 for char in executable
):
    raise SystemExit(1)
resolved = os.path.realpath(executable)
info = os.stat(resolved)
if (
    not stat.S_ISREG(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise SystemExit(1)

parts = []
size = 0
while True:
    chunk = os.read(3, min(65536, 131073 - size))
    if not chunk:
        break
    parts.append(chunk)
    size += len(chunk)
    if size > 131072:
        raise SystemExit(1)
os.close(3)
try:
    raw = b"".join(parts).decode("utf-8")
except UnicodeDecodeError:
    raise SystemExit(1)
if not raw or any(ord(char) < 32 or ord(char) == 127 for char in raw):
    raise SystemExit(1)
try:
    parsed = urlsplit(raw)
    _, separator, host_part = parsed.netloc.rpartition("@")
    host = unquote(parsed.hostname or "", errors="strict")
    user = unquote(parsed.username or "", errors="strict")
    password = unquote(parsed.password or "", errors="strict")
    database = unquote((parsed.path or "").lstrip("/"), errors="strict")
    port_number = parsed.port or 5432
    decoded_host_part = unquote(host_part, errors="strict")
except (UnicodeDecodeError, ValueError):
    raise SystemExit(1)
identity_keys = {
    "password", "sslpassword", "passfile", "service", "servicefile",
    "host", "hostaddr", "port", "user", "dbname", "database",
}
for pair in parsed.query.split("&") if parsed.query else ():
    try:
        key = unquote(pair.partition("=")[0], errors="strict").lower()
    except UnicodeDecodeError:
        raise SystemExit(1)
    if (
        not key
        or key in identity_keys
        or any(ord(char) < 32 or ord(char) == 127 for char in key)
    ):
        raise SystemExit(1)
if (
    parsed.scheme not in {"postgres", "postgresql"}
    or parsed.fragment
    or not separator
    or not 1 <= port_number <= 65535
    or "," in decoded_host_part
):
    raise SystemExit(1)
values = (host, str(port_number), database, user, password)
if not all(values) or any(
    ord(char) < 32 or ord(char) == 127 for value in values for char in value
):
    raise SystemExit(1)
escape = lambda value: value.replace("\\", "\\\\").replace(":", "\\:")
try:
    descriptor = os.memfd_create("bridgesllm-restore-pgpass", 0)
    os.fchmod(descriptor, 0o600)
    payload = (":".join(escape(value) for value in values) + "\n").encode()
    written = 0
    while written < len(payload):
        count = os.write(descriptor, payload[written:])
        if count <= 0:
            raise OSError("short pgpass write")
        written += count
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.set_inheritable(descriptor, True)
except (AttributeError, OSError):
    raise SystemExit(1)
environment = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
    "PGPASSFILE": f"/proc/self/fd/{descriptor}",
    "PGOPTIONS": "-c synchronous_commit=on",
}
os.execve(resolved, [executable, *sys.argv[3:]], environment)
PY
}

run_with_restore_pgpass() {
  local database_url="$1" executable="$2"
  shift 2
  local runner
  runner="$(restore_pgpass_runner_python)" || return 1
  env -i \
    PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    python3 -c "${runner}" "${BASHPID}" "${executable}" "$@" \
      3< <(printf '%s' "${database_url}")
}

restore_database_identity_sql() {
  if (( RESTORE_POSTGRESQL_CLIENT_MAJOR >= 15 )); then
    cat <<'SQL'
SELECT json_build_object(
  'schema', 'bridgesllm.postgresql-database-identity.v1',
  'postgresMajor', current_setting('server_version_num')::integer / 10000,
  'encoding', pg_encoding_to_char(encoding),
  'lcCollate', datcollate,
  'lcCtype', datctype,
  'localeProvider', CASE to_jsonb(database_row)->>'datlocprovider'
    WHEN 'c' THEN 'libc'
    WHEN 'i' THEN 'icu'
    WHEN 'b' THEN 'builtin'
    ELSE 'unsupported'
  END,
  'providerLocale', CASE to_jsonb(database_row)->>'datlocprovider'
    WHEN 'i' THEN COALESCE(
      to_jsonb(database_row)->>'datlocale',
      to_jsonb(database_row)->>'daticulocale'
    )
    WHEN 'b' THEN to_jsonb(database_row)->>'datlocale'
    ELSE NULL
  END,
  'icuRules', to_jsonb(database_row)->>'daticurules',
  'collationVersion', to_jsonb(database_row)->>'datcollversion',
  'collationActualVersion',
    pg_database_collation_actual_version(oid)
)::text
FROM pg_catalog.pg_database AS database_row
WHERE datname = current_database();
SQL
  else
    cat <<'SQL'
SELECT json_build_object(
  'schema', 'bridgesllm.postgresql-database-identity.v1',
  'postgresMajor', current_setting('server_version_num')::integer / 10000,
  'encoding', pg_encoding_to_char(encoding),
  'lcCollate', datcollate,
  'lcCtype', datctype,
  'localeProvider', 'libc',
  'providerLocale', NULL,
  'icuRules', NULL,
  'collationVersion', NULL,
  'collationActualVersion', NULL
)::text
FROM pg_catalog.pg_database
WHERE datname = current_database();
SQL
  fi
}

current_restore_database_identity() {
  local authority database_url uri query observed
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  query="$(restore_database_identity_sql)" || return 1
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || return 1
    observed="$(run_restore_peer_psql target -qAt \
      --command="${query}")" || return 1
  else
    observed="$(run_with_restore_pgpass "${database_url}" \
      "${RESTORE_PSQL_BIN}" --dbname="${uri}" --no-psqlrc \
      --set=ON_ERROR_STOP=1 -qAt --command="${query}")" || return 1
  fi
  python3 - "${observed}" "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" <<'PY'
import json
import sys

document = json.loads(sys.argv[1])
major = int(sys.argv[2])
required = {
    "schema", "postgresMajor", "encoding", "lcCollate", "lcCtype",
    "localeProvider", "providerLocale", "icuRules", "collationVersion",
    "collationActualVersion",
}

def safe_text(value, maximum):
    return (
        isinstance(value, str)
        and value
        and len(value.encode("utf-8")) <= maximum
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )

provider = document.get("localeProvider")
if (
    not isinstance(document, dict)
    or set(document) != required
    or document.get("schema")
        != "bridgesllm.postgresql-database-identity.v1"
    or document.get("postgresMajor") != major
    or document.get("encoding") != "UTF8"
    or not safe_text(document.get("lcCollate"), 256)
    or not safe_text(document.get("lcCtype"), 256)
    or provider not in {"libc", "icu", "builtin"}
    or (provider == "libc" and document.get("providerLocale") is not None)
    or (
        provider in {"icu", "builtin"}
        and not safe_text(document.get("providerLocale"), 1024)
    )
    or (
        document.get("icuRules") is not None
        and (
            provider != "icu"
            or not safe_text(document["icuRules"], 4096)
        )
    )
    or (
        document.get("collationVersion") is not None
        and not safe_text(document["collationVersion"], 256)
    )
    or (
        document.get("collationActualVersion") is not None
        and not safe_text(document["collationActualVersion"], 256)
    )
    or document.get("collationVersion")
        != document.get("collationActualVersion")
):
    raise SystemExit(1)
print(json.dumps(document, sort_keys=True, separators=(",", ":")))
PY
}

assert_source_database_identity_matches_target() {
  local observed
  observed="$(current_restore_database_identity)" || return 1
  python3 - "${ADMISSION_FILE}" "${observed}" <<'PY'
import json
import os
import stat
import sys

path, observed_raw = sys.argv[1:]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
):
    raise SystemExit(1)
admission = json.load(open(path, "r", encoding="utf-8"))
source = admission.get("sourceDatabaseIdentity")
observed = json.loads(observed_raw)
if (
    admission.get("schema") != "bridgesllm.restore-admission.v2"
    or not isinstance(source, dict)
    or source != observed
):
    raise SystemExit(1)
PY
}

select_postgresql_toolchain_for_authority() {
  local authority="$1" database_url uri version_num major minor floor selected
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity_from_authority "${authority}")" || return 1
  version_num="$(
    run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
      --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      --command="SELECT current_setting('server_version_num');"
  )" || return 1
  version_num="$(tr -d '\r\n' <<<"${version_num}")"
  [[ "${version_num}" =~ ^[0-9]{6}$ ]] || return 1
  major="$((10#${version_num} / 10000))"
  [[ "${major}" =~ ^(14|15|16|17|18)$ ]] || return 1
  minor="$((10#${version_num} % 10000))"
  case "${major}" in
    14) floor=23 ;;
    15) floor=18 ;;
    16) floor=14 ;;
    17) floor=10 ;;
    18) floor=4 ;;
    *) return 1 ;;
  esac
  (( minor >= floor )) || return 1
  set_postgresql_client_toolchain "${major}" || return 1
  selected="$(
    run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
      --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      --command="SELECT current_setting('server_version_num');"
  )" || return 1
  selected="$(tr -d '\r\n' <<<"${selected}")"
  [[ "${selected}" == "${version_num}" \
    && "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" == "${major}" ]]
}

database_storage_admission() {
  local database_url uri storage bytes relation_count extra topology authority
  local installer="${AUTHORITY_ROOT}/installer/install.sh"
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || return 1
    storage="$(
      {
        restore_peer_role_sql
        printf '%s\n' "SET search_path TO pg_catalog;
SELECT pg_database_size(current_database())::text
  || '|' ||
  (SELECT count(*)::text FROM pg_class
   WHERE relkind IN ('r','i','S','t','m'));"
      } | run_restore_peer_psql target -qAt
    )" || return 1
    topology="$(python3 - "${TRANSACTION_DIR}/database-exclusion.json" <<'PY'
import json
import os
import stat
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
topology = document.get("topology")
if not isinstance(topology, dict):
    raise SystemExit(1)
for key in ("dataDirectory", "walDirectory"):
    path = topology.get(key)
    if not isinstance(path, str) or not os.path.isabs(path):
        raise SystemExit(1)
    info = os.stat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
        raise SystemExit(1)
for entry in topology.get("tablespaces", []):
    path = entry.get("path") if isinstance(entry, dict) else None
    if not isinstance(path, str) or not os.path.isabs(path):
        raise SystemExit(1)
    info = os.stat(path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_mode & 0o022
        or info.st_dev != entry.get("stDev")
    ):
        raise SystemExit(1)
print(json.dumps(topology, sort_keys=True, separators=(",", ":")))
PY
    )" || return 1
  else
    storage="$(run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
      --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      --command="SET search_path TO pg_catalog;
SELECT pg_database_size(current_database())::text
  || '|' ||
  (SELECT count(*)::text FROM pg_class
   WHERE relkind IN ('r','i','S','t','m'));")" \
      || return 1
  fi
  storage="$(tr -d '\r\n' <<<"${storage}")"
  IFS='|' read -r bytes relation_count extra <<<"${storage}"
  [[ "${bytes}" =~ ^[1-9][0-9]*$ \
    && "${relation_count}" =~ ^[1-9][0-9]*$ \
    && "${relation_count}" -le 100000000 \
    && -z "${extra}" ]] || return 1
  [[ -f "${installer}" && ! -L "${installer}" \
    && "$(stat -c '%u:%g' "${installer}")" == "0:0" \
    && $((8#$(stat -c '%a' "${installer}") & 0022)) -eq 0 ]] || return 1
  if [[ -z "${topology:-}" && -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]]; then
    topology="$(
      env \
        PATH="$(dirname -- "${RESTORE_PSQL_BIN}"):/usr/bin:/bin" \
        LANG=C LC_ALL=C \
        BRIDGESLLM_INSTALLER_SOURCE_ONLY=1 \
        BRIDGESLLM_UPDATE_TRANSACTION_TEST_ROOT="${BRIDGESLLM_RESTORE_TEST_ROOT}" \
        /bin/bash -c '
          set -Eeuo pipefail
          installer="$1"
          IFS= read -r database_url <&3 || [[ -n "${database_url}" ]]
          source "${installer}"
          canonical_update_database_topology "${database_url}"
        ' restore-db-topology "${installer}" 3< <(printf '%s' "${database_url}")
    )" || return 1
  elif [[ -z "${topology:-}" ]]; then
    topology="$(
      env -i \
        PATH=/usr/bin:/bin LANG=C LC_ALL=C \
        BRIDGESLLM_INSTALLER_SOURCE_ONLY=1 \
        /bin/bash -c '
          set -Eeuo pipefail
          installer="$1"
          IFS= read -r database_url <&3 || [[ -n "${database_url}" ]]
          source "${installer}"
          canonical_update_database_topology "${database_url}"
        ' restore-db-topology "${installer}" 3< <(printf '%s' "${database_url}")
    )" || return 1
  fi
  [[ -n "${topology}" && "${#topology}" -le 65536 && "${topology}" != *"|"* ]] \
    || return 1
  printf '%s|%s|%s\n' "${bytes}" "${topology}" "${relation_count}"
}

capture_database_contract_sql() {
  local installer="${AUTHORITY_ROOT}/installer/install.sh"
  local target="${TRANSACTION_DIR}/database-ownership-contract.sql"
  local temporary
  if [[ -e "${target}" || -L "${target}" ]]; then
    [[ -s "${target}" && -f "${target}" && ! -L "${target}" \
      && "$(stat -c '%u:%g:%a:%h' "${target}")" == "0:0:600:1" \
      && "$(stat -c '%s' "${target}")" -le 262144 ]]
    return
  fi
  [[ -f "${installer}" && ! -L "${installer}" \
    && "$(stat -c '%u:%g' "${installer}")" == "0:0" \
    && $((8#$(stat -c '%a' "${installer}") & 0022)) -eq 0 ]] || return 1
  temporary="$(mktemp "${TRANSACTION_DIR}/.database-contract.XXXXXX")" || return 1
  if ! BRIDGESLLM_INSTALLER_SOURCE_ONLY=1 /bin/bash -c \
    'source "$1"; update_database_ownership_violations_sql' \
    restore-database-contract "${installer}" > "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  [[ -s "${temporary}" && "$(stat -c '%s' "${temporary}")" -le 262144 ]] || {
    rm -f -- "${temporary}"
    return 1
  }
  chmod 600 "${temporary}"
  sync -f -- "${temporary}" || { rm -f -- "${temporary}"; return 1; }
  mv -f -- "${temporary}" "${target}" || return 1
  fsync_directory "${TRANSACTION_DIR}"
}

database_contract_variant() {
  local path="${TRANSACTION_DIR}/database-contract-variant"
  [[ -f "${path}" && ! -L "${path}" \
    && "$(stat -c '%u:%g:%a:%h:%s' "${path}")" =~ ^0:0:600:1:[1-9][0-9]?$ ]] \
    || return 1
  local variant
  IFS= read -r variant < "${path}" || return 1
  [[ "${variant}" == "owner-null" || "${variant}" == "pg-database-owner-default" ]] \
    || return 1
  printf '%s\n' "${variant}"
}

admitted_database_contract_variant() {
  python3 - "${ADMISSION_FILE}" <<'PY'
import json
import sys

document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
variant = document.get("databaseContractVariant")
if (
    document.get("schema") != "bridgesllm.restore-admission.v2"
    or variant not in {"owner-null", "pg-database-owner-default"}
):
    raise SystemExit(1)
print(variant)
PY
}

attest_restore_database_contract() {
  local record="${1:-false}"
  local sql="${TRANSACTION_DIR}/database-ownership-contract.sql"
  local database_url uri result violations variant extra authority
  [[ -s "${sql}" && -f "${sql}" && ! -L "${sql}" \
    && "$(stat -c '%u:%g:%a:%h' "${sql}")" == "0:0:600:1" ]] || return 1
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || return 1
    result="$(
      {
        restore_peer_role_sql
        cat -- "${sql}"
      } | run_restore_peer_psql target -qAt
    )" || return 1
  else
    result="$(run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
      --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt < "${sql}")" \
      || return 1
  fi
  result="$(tr -d '[:space:]' <<<"${result}")"
  IFS='|' read -r violations variant extra <<<"${result}"
  [[ "${violations}" == "0" \
    && ( "${variant}" == "owner-null" || "${variant}" == "pg-database-owner-default" ) \
    && -z "${extra}" ]] || return 1
  if [[ "${record}" == "true" ]]; then
    [[ "${variant}" == "$(admitted_database_contract_variant)" ]] || return 1
    local target="${TRANSACTION_DIR}/database-contract-variant"
    local temporary
    temporary="$(mktemp "${TRANSACTION_DIR}/.database-contract-variant.XXXXXX")" || return 1
    printf '%s\n' "${variant}" > "${temporary}"
    chmod 600 "${temporary}"
    sync -f -- "${temporary}" || { rm -f -- "${temporary}"; return 1; }
    mv -f -- "${temporary}" "${target}" || return 1
    fsync_directory "${TRANSACTION_DIR}" || return 1
  else
    [[ "${variant}" == "$(database_contract_variant)" ]] || return 1
  fi
}

attest_restore_database_authority() {
  local database_url uri violations authority sql
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  sql="
SET search_path TO pg_catalog;
SELECT (
  (SELECT count(*) FROM pg_database d
   JOIN pg_roles r ON r.oid = d.datdba
   WHERE d.datname = current_database() AND r.rolname <> current_user)
  +
  (SELECT count(*) FROM pg_namespace n
   JOIN pg_roles r ON r.oid = n.nspowner
   WHERE n.nspname = 'public'
     AND r.rolname NOT IN (current_user, 'pg_database_owner'))
  +
  GREATEST((SELECT count(*) FROM pg_namespace WHERE nspname = 'public') - 1, 0)
)::text;
"
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || return 1
    violations="$(
      {
        restore_peer_role_sql
        printf '%s\n' "${sql}"
      } | run_restore_peer_psql target -qAt
    )" || return 1
  else
    violations="$(run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
      --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      --command="${sql}")" || return 1
  fi
  violations="$(tr -d '[:space:]' <<<"${violations}")"
  [[ "${violations}" == "0" ]]
}

attest_restore_database_tablespace_contract() {
  local database_url uri violations authority sql
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  sql="SET search_path TO pg_catalog;
SELECT (
  (SELECT count(*) FROM pg_database
   WHERE datname = current_database()
     AND dattablespace <> (
       SELECT oid FROM pg_tablespace WHERE spcname = 'pg_default'
     ))
  + (SELECT count(*) FROM pg_class
     WHERE NOT relisshared AND reltablespace <> 0)
  + CASE WHEN current_setting('default_tablespace') = '' THEN 0 ELSE 1 END
  + CASE WHEN current_setting('temp_tablespaces') = '' THEN 0 ELSE 1 END
)::text;"
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || return 1
    violations="$(
      {
        restore_peer_role_sql
        printf '%s\n' "${sql}"
      } | run_restore_peer_psql target -qAt
    )" || return 1
  else
    violations="$(run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
      --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      --command="${sql}")" || return 1
  fi
  violations="$(tr -d '[:space:]' <<<"${violations}")"
  [[ "${violations}" == "0" ]]
}

run_pg_dump_secure() {
  local target="$1" database_url uri temporary authority
  attest_restore_database_contract false || return 1
  attest_restore_database_tablespace_contract || return 1
  database_storage_admission >/dev/null || return 1
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  temporary="$(mktemp "${TRANSACTION_DIR}/.database-rollback.XXXXXX")" || return 1
  local dump_status=0
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || dump_status=1
    if [[ "${dump_status}" -eq 0 ]]; then
      run_restore_peer_pg_dump \
        --format=custom --compress=0 \
        --no-owner --no-privileges --no-tablespaces \
        > "${temporary}" || dump_status=$?
    fi
  else
    run_with_restore_pgpass "${database_url}" "${RESTORE_PG_DUMP_BIN}" \
      --dbname="${uri}" --format=custom --compress=0 \
      --no-owner --no-privileges --no-tablespaces \
      > "${temporary}" || dump_status=$?
  fi
  if [[ "${dump_status}" -ne 0 ]]; then
    rm -f -- "${temporary}"
    return 1
  fi
  [[ -s "${temporary}" ]] || { rm -f -- "${temporary}"; return 1; }
  chmod 600 "${temporary}"
  validate_pg_dump_custom_file "${temporary}" \
    || { rm -f -- "${temporary}"; return 1; }
  sync -f -- "${temporary}" || { rm -f -- "${temporary}"; return 1; }
  mv -f -- "${temporary}" "${target}" || return 1
  fsync_directory "$(dirname -- "${target}")"
}

validate_pg_dump_custom_file() {
  local source="$1"
  python3 - "${source}" "${RESTORE_PG_RESTORE_BIN}" \
    "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" <<'PY'
import os
import re
import stat
import subprocess
import sys
import tempfile

path, pg_restore, postgres_major_raw = sys.argv[1:]
postgres_major = int(postgres_major_raw)
floors = {14: 23, 15: 18, 16: 14, 17: 10, 18: 4}
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or info.st_mode & 0o022
    or info.st_size <= 5
):
    raise SystemExit(1)
with open(path, "rb", buffering=0) as handle:
    if handle.read(5) != b"PGDMP":
        raise SystemExit(1)
command_info = os.lstat(pg_restore)
if (
    not os.path.isabs(pg_restore)
    or not stat.S_ISREG(command_info.st_mode)
    or stat.S_ISLNK(command_info.st_mode)
    or command_info.st_uid != 0
    or command_info.st_gid != 0
    or command_info.st_nlink != 1
    or command_info.st_mode & 0o022
    or not command_info.st_mode & 0o100
    or postgres_major not in floors
):
    raise SystemExit(1)
environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
try:
    version_result = subprocess.run(
        [pg_restore, "--version"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        timeout=10,
        check=False,
    )
    if (
        version_result.returncode != 0
        or version_result.stderr
        or len(version_result.stdout) > 4096
    ):
        raise SystemExit(1)
    version_lines = version_result.stdout.decode("ascii").splitlines()
    version_match = re.fullmatch(
        r"pg_restore \(PostgreSQL\) ([0-9]+)\.([0-9]+)(?:[ \t][ -~]*)?",
        version_lines[0] if len(version_lines) == 1 else "",
    )
    if version_match is None:
        raise SystemExit(1)
    client_major, client_minor = map(int, version_match.groups())
    if (
        client_major != postgres_major
        or client_minor < floors[client_major]
    ):
        raise SystemExit(1)
    with tempfile.TemporaryFile() as inventory:
        list_result = subprocess.run(
            [pg_restore, "--list", path],
            stdin=subprocess.DEVNULL,
            stdout=inventory,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=300,
            check=False,
        )
        inventory.flush()
        size = inventory.tell()
        if list_result.returncode != 0 or size <= 0 or size > 64 * 1024 * 1024:
            raise SystemExit(1)
        inventory.seek(0)
        header = inventory.read(min(size, 1024 * 1024)).decode("utf-8")
    source_matches = re.findall(
        r"^;[ \t]+Dumped from database version: "
        r"([0-9]+)\.([0-9]+)(?:\.[0-9]+)?(?:[ \t][^\r\n]*)?$",
        header,
        flags=re.MULTILINE,
    )
    producer_matches = re.findall(
        r"^;[ \t]+Dumped by pg_dump version: "
        r"([0-9]+)\.([0-9]+)(?:\.[0-9]+)?(?:[ \t][^\r\n]*)?$",
        header,
        flags=re.MULTILINE,
    )
    if len(source_matches) != 1 or len(producer_matches) != 1:
        raise SystemExit(1)
    source_major, source_minor = map(int, source_matches[0])
    producer_major, producer_minor = map(int, producer_matches[0])
    if (
        source_major != postgres_major
        or source_minor < floors[source_major]
        or producer_major != postgres_major
        or producer_minor < floors[producer_major]
    ):
        raise SystemExit(1)
    result = subprocess.run(
        [
            pg_restore,
            "--format=custom",
            "--file=/dev/null",
            "--no-owner",
            "--no-privileges",
            path,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=environment,
        timeout=300,
        check=False,
    )
except (
    OSError,
    UnicodeDecodeError,
    subprocess.TimeoutExpired,
):
    raise SystemExit(1)
if result.returncode != 0:
    raise SystemExit(1)
PY
}

run_pg_restore_secure() {
  local source="$1" mode="${2:-forward}" database_url uri variant status=0
  [[ "${mode}" == "forward" || "${mode}" == "rollback" ]] || return 1
  [[ -s "${source}" && -f "${source}" && ! -L "${source}" \
    && "$(stat -c '%u:%g' "${source}")" == "0:0" ]] || return 1
  validate_pg_dump_custom_file "${source}" || return 1
  if [[ "${mode}" == "forward" ]]; then
    attest_restore_database_contract false || return 1
  else
    # A failed forward restore may have introduced extra current-role-owned
    # objects that intentionally violate the clean product contract. Recovery
    # still proceeds only while the configured role owns the database and no
    # foreign role took over the public schema. Replacing only that schema
    # avoids revoking unrelated privileges or changing foreign schemas.
    attest_restore_database_authority || return 1
  fi
  variant="$(database_contract_variant)" || return 1
  local authority
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  if [[ -f "${TRANSACTION_DIR}/database-exclusion.json" \
    && ! -L "${TRANSACTION_DIR}/database-exclusion.json" ]]; then
    assert_restore_database_exclusion || return 1
    {
      restore_peer_role_sql
      cat <<'SQL'
SET LOCAL synchronous_commit = on;
SET search_path TO pg_catalog;
DROP SCHEMA IF EXISTS public CASCADE;
SQL
      if [[ "${variant}" == "owner-null" ]]; then
        printf '%s\n' 'CREATE SCHEMA public AUTHORIZATION CURRENT_USER;'
      else
        cat <<'SQL'
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT ALL PRIVILEGES ON SCHEMA public TO pg_database_owner;
SQL
      fi
    } | run_restore_peer_psql target --single-transaction >/dev/null \
      || status=$?
    if [[ "${status}" -eq 0 ]]; then
      run_restore_peer_pg_restore "${source}" \
        --format=custom --exit-on-error --single-transaction \
        --no-owner --no-privileges --no-tablespaces --clean --if-exists \
        >/dev/null || status=$?
    fi
  else
    {
      cat <<'SQL'
SET LOCAL synchronous_commit = on;
SET search_path TO pg_catalog;
DROP SCHEMA IF EXISTS public CASCADE;
SQL
      if [[ "${variant}" == "owner-null" ]]; then
        printf '%s\n' 'CREATE SCHEMA public AUTHORIZATION CURRENT_USER;'
      else
        cat <<'SQL'
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT ALL PRIVILEGES ON SCHEMA public TO pg_database_owner;
SQL
      fi
    } | run_with_restore_pgpass "${database_url}" "${RESTORE_PSQL_BIN}" \
        --dbname="${uri}" --no-psqlrc --set=ON_ERROR_STOP=1 \
        --single-transaction >/dev/null || status=$?
    if [[ "${status}" -eq 0 ]]; then
      run_with_restore_pgpass "${database_url}" "${RESTORE_PG_RESTORE_BIN}" \
        --dbname="${uri}" --format=custom --exit-on-error \
        --single-transaction --no-owner --no-privileges --no-tablespaces \
        --clean --if-exists "${source}" >/dev/null || status=$?
    fi
  fi
  [[ "${status}" -eq 0 ]] || return 1
  normalize_restore_database_control_contract || return 1
  attest_restore_database_contract false
}

rollback_roots() {
  python3 - "${ADMISSION_FILE}" <<'PY'
import json
import pathlib
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
targets = sorted(
    {pathlib.Path(entry["target"]) for entry in document["components"]},
    key=lambda item: (len(item.parts), str(item)),
)
roots = []
for target in targets:
    if any(target == root or target.is_relative_to(root) for root in roots):
        continue
    roots.append(target)
for root in roots:
    print(root)
PY
}

assert_rollback_snapshot_inode_types() {
  local target="$1"
  python3 - "${target}" <<'PY'
import os
import pathlib
import stat
import sys
import array
import errno
import fcntl

root = pathlib.Path(sys.argv[1])
if not root.is_absolute():
    raise SystemExit(1)

FS_IOC_GETFLAGS = 0x80086601
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020

def assert_mutable_inode(path, expected):
    descriptor_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | os.O_NOFOLLOW
    )
    if stat.S_ISDIR(expected.st_mode):
        descriptor_flags |= getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, descriptor_flags)
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != expected.st_dev
            or opened.st_ino != expected.st_ino
            or stat.S_IFMT(opened.st_mode) != stat.S_IFMT(expected.st_mode)
        ):
            raise SystemExit(1)
        flags = array.array("l", [0])
        try:
            fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, flags, True)
        except OSError as error:
            if error.errno not in {
                errno.EINVAL,
                errno.ENOTTY,
                errno.EOPNOTSUPP,
            }:
                raise
        else:
            if flags[0] & (FS_IMMUTABLE_FL | FS_APPEND_FL):
                raise SystemExit(1)
    finally:
        os.close(descriptor)

ancestor = root.parent
while True:
    try:
        ancestor_info = os.lstat(ancestor)
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISDIR(ancestor_info.st_mode):
            raise SystemExit(1)
        assert_mutable_inode(ancestor, ancestor_info)
    if ancestor == ancestor.parent:
        break
    ancestor = ancestor.parent

try:
    root_info = os.lstat(root)
except FileNotFoundError:
    raise SystemExit(0)
if not (
    stat.S_ISREG(root_info.st_mode)
    or stat.S_ISDIR(root_info.st_mode)
):
    raise SystemExit(1)
assert_mutable_inode(root, root_info)
if stat.S_ISREG(root_info.st_mode):
    raise SystemExit(0)
root_device = root_info.st_dev
for current, directories, files in os.walk(
    root,
    topdown=True,
    followlinks=False,
):
    current_info = os.lstat(current)
    if (
        not stat.S_ISDIR(current_info.st_mode)
        or current_info.st_dev != root_device
    ):
        raise SystemExit(1)
    assert_mutable_inode(pathlib.Path(current), current_info)
    for name in directories + files:
        entry = pathlib.Path(current) / name
        info = os.lstat(entry)
        if info.st_dev != root_device:
            raise SystemExit(1)
        if not (
            stat.S_ISDIR(info.st_mode)
            or stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
        ):
            raise SystemExit(1)
        if not stat.S_ISLNK(info.st_mode):
            assert_mutable_inode(entry, info)
PY
}

snapshot_rollback() {
  local rollback_dir="${TRANSACTION_DIR}/rollback"
  mkdir -p "${rollback_dir}/files"
  capture_database_contract_sql \
    || die "Installed database ownership contract could not be sealed"
  attest_restore_database_contract true \
    || die "Restore database is not exclusively owned by the configured Portal role"
  run_pg_dump_secure "${rollback_dir}/database.dump" \
    || die "Pre-restore database rollback snapshot failed"
  : > "${rollback_dir}/roots.tsv"
  chmod 600 "${rollback_dir}/roots.tsv"
  local roots_file
  roots_file="$(mktemp "${rollback_dir}/.roots.XXXXXX")" \
    || die "Rollback root inventory could not be materialized"
  if ! rollback_roots > "${roots_file}"; then
    rm -f -- "${roots_file}"
    die "Rollback root inventory could not be materialized"
  fi
  python3 - "${ADMISSION_FILE}" "${roots_file}" <<'PY' \
    || die "Rollback root inventory does not exactly cover restore targets"
import json
import pathlib
import sys

admission_path, roots_path = sys.argv[1:]
document = json.load(open(admission_path, "r", encoding="utf-8"))
if document.get("schema") != "bridgesllm.restore-admission.v2":
    raise SystemExit(1)
targets = sorted(
    {pathlib.Path(entry["target"]) for entry in document["components"]},
    key=lambda item: (len(item.parts), str(item)),
)
expected = []
for target in targets:
    if any(target == root or target.is_relative_to(root) for root in expected):
        continue
    expected.append(target)
raw = pathlib.Path(roots_path).read_text(encoding="utf-8").splitlines()
if (
    not raw
    or any(not value or "\t" in value for value in raw)
    or len(raw) != len(set(raw))
    or raw != [str(value) for value in expected]
):
    raise SystemExit(1)
PY
  local target index=0 kind snapshot
  while IFS= read -r target; do
    [[ -n "${target}" ]] || die "Rollback root inventory contains an empty target"
    index=$((index + 1))
    snapshot="${rollback_dir}/files/${index}.tar.gz"
    ensure_safe_parent_directory "${target}" either false \
      || die "Rollback target changed topology before snapshot: ${target}"
    assert_rollback_snapshot_inode_types "${target}" \
      || die "Rollback target or ancestor contains a special, cross-device, immutable, or append-only inode: ${target}"
    if [[ -d "${target}" && ! -L "${target}" ]]; then
      tar --format=pax --sparse --one-file-system --check-links \
        --acls --xattrs --xattrs-include='*' --selinux \
        --pax-option=delete=atime,delete=ctime \
        -czpf "${snapshot}" \
        -C "$(dirname -- "${target}")" -- "$(basename -- "${target}")" \
        || die "Rollback snapshot failed for ${target}"
      kind="directory"
    elif [[ -f "${target}" && ! -L "${target}" ]]; then
      tar --format=pax --sparse --one-file-system --check-links \
        --acls --xattrs --xattrs-include='*' --selinux \
        --pax-option=delete=atime,delete=ctime \
        -czpf "${snapshot}" \
        -C "$(dirname -- "${target}")" -- "$(basename -- "${target}")" \
        || die "Rollback snapshot failed for ${target}"
      kind="file"
    elif [[ ! -e "${target}" && ! -L "${target}" ]]; then
      kind="absent"
      snapshot=""
    else
      die "Rollback target changed into a linked or special inode: ${target}"
    fi
    printf '%s\t%s\t%s\n' "${target}" "${kind}" "${snapshot}" >> "${rollback_dir}/roots.tsv"
  done < "${roots_file}"
  python3 - "${rollback_dir}/roots.tsv" "${roots_file}" <<'PY'
import os
import pathlib
import stat
import sys

path, roots_path = map(pathlib.Path, sys.argv[1:])
broad = {
    pathlib.Path(value)
    for value in (
        "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
        "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv",
        "/sys", "/tmp", "/usr", "/var",
    )
}
expected_targets = roots_path.read_text(encoding="utf-8").splitlines()
rows = [
    raw.split("\t", 2)
    for raw in path.read_text(encoding="utf-8").splitlines()
]
if (
    len(rows) != len(expected_targets)
    or [row[0] for row in rows] != expected_targets
):
    raise SystemExit(1)
targets = []
for index, (target, kind, snapshot) in enumerate(rows, start=1):
    target_path = pathlib.Path(target)
    if kind in {"directory", "file"}:
        expected_snapshot = path.parent / "files" / f"{index}.tar.gz"
        if pathlib.Path(snapshot) != expected_snapshot:
            raise SystemExit(1)
        info = os.lstat(expected_snapshot)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
            or info.st_size <= 0
        ):
            raise SystemExit(1)
    elif kind == "absent":
        if snapshot:
            raise SystemExit(1)
    else:
        raise SystemExit(1)
    targets.append(target_path)
missing = set()
for target in targets:
    parent = target.parent
    while not os.path.lexists(parent):
        if parent in broad or parent == parent.parent:
            raise SystemExit(1)
        missing.add(parent)
        parent = parent.parent
    info = os.lstat(parent)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
with path.open("a", encoding="utf-8") as handle:
    for parent in sorted(missing, key=lambda item: (-len(item.parts), str(item))):
        handle.write(f"{parent}\tabsent-ancestor\t\n")
PY
  rm -f -- "${roots_file}"
  sync_tree "${rollback_dir}" \
    || die "Rollback snapshot was not committed durably"
}

component_source_root() {
  local component="$1" target="$2"
  local root="${TRANSACTION_DIR}/components/${component}"
  [[ -d "${root}" && ! -L "${root}" ]] || return 1
  local entries_file
  entries_file="$(mktemp "${TRANSACTION_DIR}/.component-entries.XXXXXX")" \
    || return 1
  if ! find "${root}" -mindepth 1 -maxdepth 1 -print0 > "${entries_file}"; then
    rm -f -- "${entries_file}"
    return 1
  fi
  local -a entries=()
  mapfile -d '' -t entries < "${entries_file}"
  rm -f -- "${entries_file}"
  [[ "${#entries[@]}" -eq 1 && -d "${entries[0]}" && ! -L "${entries[0]}" \
    && "$(basename -- "${entries[0]}")" == "$(basename -- "${target}")" ]] \
    || return 1
  printf '%s\n' "${entries[0]}"
}

ensure_safe_parent_directory() {
  local target="$1" expected="${2:-either}" create_missing="${3:-true}"
  python3 - "${target}" "${expected}" "${create_missing}" <<'PY'
import os
import pathlib
import stat
import sys

target = pathlib.Path(sys.argv[1])
expected = sys.argv[2]
create_missing = sys.argv[3]
if not target.is_absolute() or os.path.normpath(target) != str(target):
    raise SystemExit(1)
broad = {
    pathlib.Path(value)
    for value in (
        "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
        "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv",
        "/sys", "/tmp", "/usr", "/var",
    )
}
if (
    target in broad
    or expected not in {"directory", "file", "either"}
    or create_missing not in {"true", "false"}
):
    raise SystemExit(1)
parent = target.parent
current = pathlib.Path("/")
for part in parent.parts[1:]:
    current /= part
    try:
        info = os.lstat(current)
    except FileNotFoundError:
        if create_missing == "false":
            break
        os.mkdir(current, 0o700)
        info = os.lstat(current)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
if os.path.lexists(target):
    info = os.lstat(target)
    if (
        stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
        or (expected == "directory" and not stat.S_ISDIR(info.st_mode))
        or (expected == "file" and not stat.S_ISREG(info.st_mode))
        or (
            expected == "either"
            and not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
        )
    ):
        raise SystemExit(1)
try:
    mount_lines = pathlib.Path("/proc/self/mountinfo").read_text(
        encoding="utf-8"
    ).splitlines()
except OSError:
    raise SystemExit(1)
target_value = str(target)
for line in mount_lines:
    fields = line.split()
    if len(fields) < 5:
        continue
    mountpoint = fields[4].replace("\\040", " ").replace(
        "\\011", "\t"
    ).replace("\\134", "\\")
    if mountpoint == target_value or mountpoint.startswith(target_value + os.sep):
        raise SystemExit(1)
PY
}

restore_component_set() {
  local category="$1"
  local component payload target kind source inventory sorted_inventory
  assert_host_restore_target_mounts_clear \
    || die "Host mount topology changed before component promotion"
  inventory="$(mktemp "${TRANSACTION_DIR}/.admitted-components.${category}.XXXXXX")" \
    || die "Recovery component inventory could not be materialized"
  sorted_inventory="$(mktemp "${TRANSACTION_DIR}/.sorted-components.${category}.XXXXXX")" \
    || {
      rm -f -- "${inventory}"
      die "Recovery component order could not be materialized"
    }
  if ! admitted_components > "${inventory}" || [[ ! -s "${inventory}" ]]; then
    rm -f -- "${inventory}" "${sorted_inventory}"
    die "Recovery component inventory could not be materialized"
  fi
  if ! python3 - "${inventory}" "${sorted_inventory}" <<'PY'
import pathlib
import sys

source, target = map(pathlib.Path, sys.argv[1:])
rows = [
    line.split("\t")
    for line in source.read_text(encoding="utf-8").splitlines()
    if line
]
if not rows or any(len(row) != 4 for row in rows):
    raise SystemExit(1)
priority = {
    "portal-install": 0,
    "legacy-portal-runtime": 1,
    # This required unfiltered component is authoritative over both historical
    # runtime locations and must be promoted after any parent runtime tree.
    "portal-app-sources": 20,
}
rows.sort(key=lambda row: (priority.get(row[0], 10), row[0]))
target.write_text(
    "".join("\t".join(row) + "\n" for row in rows),
    encoding="utf-8",
)
PY
  then
    rm -f -- "${inventory}" "${sorted_inventory}"
    die "Recovery component inventory could not be ordered exactly"
  fi
  rm -f -- "${inventory}"
  while IFS=$'\t' read -r component payload target kind; do
    case "${category}:${component}" in
      files:portal-install|files:hosted-apps|files:portal-app-sources|\
      files:portal-files|files:upload-storage|\
      files:projects|files:portal-backend-state|files:portal-state|files:portal-assets|\
      files:legacy-hosted-apps|files:legacy-portal-files|files:legacy-portal-runtime) ;;
      openclaw:openclaw-state) ;;
      stalwart:stalwart-data|stalwart:stalwart-mail-data|stalwart:stalwart-install) ;;
      *) continue ;;
    esac
    if [[ "${kind}" == "absent" ]]; then
      safe_remove_target "${target}" \
        || die "Recovery absence could not be enforced safely: ${component}"
      continue
    fi
    [[ "${kind}" == "directory" ]] \
      || die "Recovery component kind is invalid: ${component}"
    source="$(component_source_root "${component}" "${target}")" \
      || die "Staged recovery component has the wrong root identity: ${component}"
    ensure_safe_parent_directory "${target}" directory \
      || die "Recovery target changed topology before promotion: ${target}"
    if [[ ! -e "${target}" ]]; then
      install -d -m 700 -o root -g root "${target}" \
        || die "Recovery target could not be created: ${target}"
    fi
    ensure_safe_parent_directory "${target}" directory \
      || die "Recovery target changed topology during promotion: ${target}"
    rsync -aHAXScI --numeric-ids --delete --one-file-system "${source}/" "${target}/" \
      || die "Recovery component promotion failed: ${component}"
    local comparison
    comparison="$(mktemp "${TRANSACTION_DIR}/.promotion-check.XXXXXX")" \
      || die "Recovery component comparison could not be materialized"
    if ! rsync -aHAXScni --numeric-ids --delete --one-file-system \
        "${source}/" "${target}/" > "${comparison}" \
      || [[ -s "${comparison}" ]]; then
      rm -f -- "${comparison}"
      die "Recovery component promotion is not metadata/content exact: ${component}"
    fi
    rm -f -- "${comparison}"
    python3 - "${source}" "${target}" <<'PY' \
      || die "Recovery component sparse-file contract was not preserved: ${component}"
import os
import pathlib
import stat
import sys

source, target = map(pathlib.Path, sys.argv[1:])
for directory, _, filenames in os.walk(source, followlinks=False):
    relative = pathlib.Path(directory).relative_to(source)
    for name in filenames:
        source_path = pathlib.Path(directory) / name
        source_info = os.lstat(source_path)
        if (
            not stat.S_ISREG(source_info.st_mode)
            or stat.S_ISLNK(source_info.st_mode)
            or source_info.st_size < 1024 * 1024
            or source_info.st_blocks * 512 >= source_info.st_size // 2
        ):
            continue
        target_info = os.lstat(target / relative / name)
        if (
            not stat.S_ISREG(target_info.st_mode)
            or stat.S_ISLNK(target_info.st_mode)
            or target_info.st_size != source_info.st_size
            or target_info.st_blocks * 512 >= target_info.st_size // 2
        ):
            raise SystemExit(1)
PY
    ensure_safe_parent_directory "${target}" directory \
      || die "Recovery target became unsafe after promotion: ${target}"
    sync_tree "${target}" \
      || die "Recovery component was not committed durably: ${component}"
  done < "${sorted_inventory}"
  rm -f -- "${sorted_inventory}"
}

restore_environment_file() {
  local staged="${TRANSACTION_DIR}/stage/configs/portal-backend.env.production"
  [[ -f "${staged}" && ! -L "${staged}" ]] || die "Staged Portal environment is missing"
  ensure_safe_parent_directory "${PORTAL_ENV_FILE}" file \
    || die "Portal environment parent is unsafe"
  local temporary
  temporary="$(mktemp "$(dirname -- "${PORTAL_ENV_FILE}")/.env.production.restore.XXXXXX")"
  install -m 600 -o root -g root -- "${staged}" "${temporary}"
  sync -f -- "${temporary}" \
    || die "Restored Portal environment content was not committed durably"
  mv -f -- "${temporary}" "${PORTAL_ENV_FILE}"
  fsync_directory "$(dirname -- "${PORTAL_ENV_FILE}")" \
    || die "Restored Portal environment was not committed durably"
}

stop_restore_migration() {
  [[ "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ ]] || return 1
  local unit="bridgesllm-restore-migration-${TRANSACTION_ID}.service"
  "${RESTORE_SYSTEMCTL_BIN}" stop "${unit}" >/dev/null 2>&1 || true
  local load_state active_state
  load_state="$("${RESTORE_SYSTEMCTL_BIN}" show \
    --property=LoadState --value "${unit}" 2>/dev/null)" || return 1
  active_state="$("${RESTORE_SYSTEMCTL_BIN}" show \
    --property=ActiveState --value "${unit}" 2>/dev/null)" || return 1
  [[ "${load_state}" == "loaded" || "${load_state}" == "not-found" ]] \
    || return 1
  [[ "${active_state}" == "inactive" || "${active_state}" == "failed" ]] \
    || return 1
  "${RESTORE_SYSTEMCTL_BIN}" reset-failed "${unit}" >/dev/null 2>&1 || true
}

restore_database_inaccessible_paths() {
  python3 - "${TRANSACTION_DIR}/database-exclusion.json" <<'PY'
import json
import os
import pathlib
import stat
import sys

document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
topology = document.get("topology")
if not isinstance(topology, dict):
    raise SystemExit(1)
raw = [topology.get("dataDirectory"), topology.get("walDirectory")]
for entry in topology.get("tablespaces", []):
    if not isinstance(entry, dict):
        raise SystemExit(1)
    raw.append(entry.get("path"))
paths = []
for value in raw:
    if (
        not isinstance(value, str)
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise SystemExit(1)
    path = pathlib.Path(value)
    info = os.lstat(path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
    if value not in paths:
        paths.append(value)
if not paths:
    raise SystemExit(1)
sys.stdout.buffer.write(b"".join(
    value.encode("utf-8") + b"\0" for value in paths
))
PY
}

restore_prevalidation_inaccessible_paths() {
  local admission bytes topology relation_count extra authority database_url
  local uri socket_directories
  admission="$(database_storage_admission)" || return 1
  IFS='|' read -r bytes topology relation_count extra <<<"${admission}"
  [[ "${bytes}" =~ ^[1-9][0-9]*$ \
    && "${relation_count}" =~ ^[1-9][0-9]*$ \
    && -n "${topology}" && -z "${extra}" ]] || return 1
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  uri="$(database_command_identity)" || return 1
  socket_directories="$(run_with_restore_pgpass "${database_url}" \
    "${RESTORE_PSQL_BIN}" --dbname="${uri}" --no-psqlrc \
    --set=ON_ERROR_STOP=1 -qAt \
    --command="SELECT current_setting('unix_socket_directories');")" \
    || return 1
  python3 - "${topology}" "${socket_directories}" <<'PY'
import json
import os
import pathlib
import stat
import sys

document = json.loads(sys.argv[1])
raw = [document.get("dataDirectory"), document.get("walDirectory")]
raw.extend(
    entry.get("path")
    for entry in document.get("tablespaces", [])
    if isinstance(entry, dict)
)
port = document.get("serverPort")
if not isinstance(port, int):
    raise SystemExit(1)
for candidate in sys.argv[2].split(","):
    candidate = candidate.strip()
    if not candidate.startswith("/"):
        continue
    endpoint = pathlib.Path(candidate) / f".s.PGSQL.{port}"
    try:
        endpoint_info = os.lstat(endpoint)
    except OSError:
        continue
    if stat.S_ISSOCK(endpoint_info.st_mode):
        raw.append(candidate)
paths = []
for value in raw:
    if (
        not isinstance(value, str)
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
    ):
        raise SystemExit(1)
    info = os.lstat(value)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise SystemExit(1)
    if value not in paths:
        paths.append(value)
sys.stdout.buffer.write(
    b"".join(value.encode("utf-8") + b"\0" for value in paths)
)
PY
}

capture_restore_prevalidation_inaccessible_paths() {
  local destination_name="$1" temporary
  [[ "${destination_name}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ \
    && -d "${TRANSACTION_DIR}" && ! -L "${TRANSACTION_DIR}" \
    && "$(stat -c '%u:%g:%a' "${TRANSACTION_DIR}" 2>/dev/null)" == "0:0:700" ]] \
    || return 1
  local -n destination="${destination_name}"
  destination=()
  temporary="$(mktemp "${TRANSACTION_DIR}/.prevalidation-paths.XXXXXX")" \
    || return 1
  chmod 600 "${temporary}"
  if ! restore_prevalidation_inaccessible_paths > "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! mapfile -d '' -t destination < "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  rm -f -- "${temporary}"
  (( ${#destination[@]} > 0 ))
}

# Restored code never touches the host cluster. It runs only against a
# disposable matching-major PostgreSQL cluster whose data is disk-backed in a
# systemd StateDirectory and whose socket lives in a RuntimeDirectory.
capture_restore_validation_database_authority() {
  local target="${TRANSACTION_DIR}/validation-database-authority.json"
  local authority database_url uri locale_contract
  local target_database target_role
  [[ ! -e "${target}" && ! -L "${target}" ]] || return 1
  authority="$(database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  read -r target_database target_role < <(
    python3 /dev/fd/3 3<<'PY' <<<"${database_url}"
import sys
from urllib.parse import unquote, urlsplit
parsed = urlsplit(sys.stdin.read())
database = unquote((parsed.path or "").lstrip("/"))
role = unquote(parsed.username or "")
if not database or not role or any(char.isspace() for value in (database, role) for char in value):
    raise SystemExit(1)
print(database, role)
PY
  ) || return 1
  uri="$(database_command_identity)" || return 1
  if (( RESTORE_POSTGRESQL_CLIENT_MAJOR >= 15 )); then
    locale_contract="$(run_with_restore_pgpass "${database_url}" \
      "${RESTORE_PSQL_BIN}" --dbname="${uri}" --no-psqlrc \
      --set=ON_ERROR_STOP=1 -qAt --command="
SELECT json_build_object(
  'encoding', pg_encoding_to_char(encoding),
  'collate', datcollate,
  'ctype', datctype,
  'provider', datlocprovider::text,
  'icuLocale', daticulocale,
  'collationVersion', datcollversion,
  'collationActualVersion', pg_database_collation_actual_version(oid)
)::text
FROM pg_database WHERE datname = current_database();
")" || return 1
  else
    locale_contract="$(run_with_restore_pgpass "${database_url}" \
      "${RESTORE_PSQL_BIN}" --dbname="${uri}" --no-psqlrc \
      --set=ON_ERROR_STOP=1 -qAt --command="
SELECT json_build_object(
  'encoding', pg_encoding_to_char(encoding),
  'collate', datcollate,
  'ctype', datctype,
  'provider', 'c',
  'icuLocale', NULL,
  'collationVersion', NULL,
  'collationActualVersion', NULL
)::text
FROM pg_database WHERE datname = current_database();
")" || return 1
  fi
  python3 - "${ADMISSION_FILE}" "${target}" \
    "${TRANSACTION_ID}" "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    "${RESTORE_POSTGRESQL_CLIENT_MINOR}" "${locale_contract}" \
    "${target_database}" "${target_role}" \
    "${RESTORE_VALIDATION_RUNTIME_ROOT}" \
    "${RESTORE_VALIDATION_STATE_ROOT}" \
    "${RESTORE_VALIDATION_STATE_ALIAS_ROOT}" <<'PY'
import json
import os
import secrets
import stat
import sys

(
    admission_path,
    target,
    operation_id,
    major_raw,
    minor_raw,
    locale_raw,
    target_database,
    target_role,
    runtime_root,
    state_root,
    state_alias_root,
) = sys.argv[1:]
admission = json.load(open(admission_path, "r", encoding="utf-8"))
logical_bytes = admission.get("databaseLogicalBytes")
relation_count = admission.get("databaseRelationCount")
locale_contract = json.loads(locale_raw)
def safe_text(value, maximum):
    return (
        isinstance(value, str)
        and value
        and len(value.encode("utf-8")) <= maximum
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )
if (
    admission.get("schema") != "bridgesllm.restore-admission.v2"
    or not isinstance(logical_bytes, int)
    or isinstance(logical_bytes, bool)
    or logical_bytes <= 0
    or not isinstance(relation_count, int)
    or isinstance(relation_count, bool)
    or relation_count <= 0
    or not isinstance(locale_contract, dict)
    or set(locale_contract) != {
        "encoding", "collate", "ctype", "provider", "icuLocale",
        "collationVersion", "collationActualVersion",
    }
    or not safe_text(locale_contract.get("encoding"), 32)
    or not safe_text(locale_contract.get("collate"), 256)
    or not safe_text(locale_contract.get("ctype"), 256)
    or not safe_text(locale_contract.get("provider"), 32)
    or locale_contract["encoding"] != "UTF8"
    or locale_contract["provider"] != "c"
    or locale_contract["icuLocale"] is not None
    or (
        locale_contract["collationVersion"] is not None
        and (
            not safe_text(locale_contract["collationVersion"], 256)
        )
    )
    or (
        locale_contract["collationActualVersion"] is not None
        and not safe_text(locale_contract["collationActualVersion"], 256)
    )
    or locale_contract["collationVersion"]
        != locale_contract["collationActualVersion"]
):
    raise SystemExit(1)
application_password = secrets.token_urlsafe(48)
suffix = operation_id[:24]
runtime_name = f"bridgesllm-restore-postgres-{operation_id}"
document = {
    "schema": "bridgesllm.validation-cluster-authority.v1",
    "operationId": operation_id,
    "unit": runtime_name,
    "runtimeDirectoryName": runtime_name,
    "runtimeDirectory": f"{runtime_root}/{runtime_name}",
    "stateDirectoryName": runtime_name,
    "stateDirectory": f"{state_root}/{runtime_name}",
    "stateDirectoryAlias": f"{state_alias_root}/{runtime_name}",
    "socketDirectory": f"{runtime_root}/{runtime_name}/socket",
    "port": 5432,
    "adminRole": f"bridgesllm_validation_admin_{suffix}",
    "applicationRole": target_role,
    "applicationPassword": application_password,
    "database": target_database,
    "logicalBytes": logical_bytes,
    "relationCount": relation_count,
    "locale": locale_contract,
    "postgresMajor": int(major_raw),
    "postgresMinor": int(minor_raw),
}
payload = (
    json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n"
).encode("utf-8")
temporary = target + f".tmp-{operation_id}"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, target)
PY
  sync -f -- "${target}" || return 1
  fsync_directory "${TRANSACTION_DIR}"
}

restore_validation_database_fields() {
  python3 - "${TRANSACTION_DIR}/validation-database-authority.json" \
    "${TRANSACTION_ID}" "${RESTORE_POSTGRESQL_CLIENT_MAJOR}" \
    "${RESTORE_POSTGRESQL_CLIENT_MINOR}" \
    "${RESTORE_VALIDATION_RUNTIME_ROOT}" \
    "${RESTORE_VALIDATION_STATE_ROOT}" \
    "${RESTORE_VALIDATION_STATE_ALIAS_ROOT}" <<'PY'
import json
import os
import re
import stat
import sys

(
    path,
    operation_id,
    major_raw,
    minor_raw,
    runtime_root,
    state_root,
    state_alias_root,
) = sys.argv[1:]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
def safe_text(value, maximum):
    return (
        isinstance(value, str)
        and value
        and len(value.encode("utf-8")) <= maximum
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )
required = {
    "schema", "operationId", "unit", "runtimeDirectoryName",
    "runtimeDirectory", "stateDirectoryName", "stateDirectory",
    "stateDirectoryAlias", "socketDirectory", "port", "adminRole", "applicationRole",
    "applicationPassword", "database", "logicalBytes", "postgresMajor",
    "postgresMinor", "relationCount", "locale",
}
suffix = operation_id[:24]
unit = f"bridgesllm-restore-postgres-{operation_id}"
if (
    set(document) != required
    or document.get("schema") != "bridgesllm.validation-cluster-authority.v1"
    or document.get("operationId") != operation_id
    or document.get("unit") != unit
    or document.get("runtimeDirectoryName") != unit
    or document.get("runtimeDirectory") != f"{runtime_root}/{unit}"
    or document.get("stateDirectoryName") != unit
    or document.get("stateDirectory") != f"{state_root}/{unit}"
    or document.get("stateDirectoryAlias") != f"{state_alias_root}/{unit}"
    or document.get("socketDirectory") != f"{runtime_root}/{unit}/socket"
    or document.get("port") != 5432
    or document.get("adminRole") != f"bridgesllm_validation_admin_{suffix}"
    or not isinstance(document.get("applicationRole"), str)
    or not document["applicationRole"]
    or not isinstance(document.get("database"), str)
    or not document["database"]
    or any(
        character.isspace()
        for value in (document["applicationRole"], document["database"])
        for character in value
    )
    or document.get("postgresMajor") != int(major_raw)
    or document.get("postgresMinor") != int(minor_raw)
    or not isinstance(document.get("logicalBytes"), int)
    or document["logicalBytes"] <= 0
    or not isinstance(document.get("relationCount"), int)
    or document["relationCount"] <= 0
    or not isinstance(document.get("locale"), dict)
    or set(document["locale"]) != {
        "encoding", "collate", "ctype", "provider", "icuLocale",
        "collationVersion", "collationActualVersion",
    }
    or document["locale"].get("encoding") != "UTF8"
    or not safe_text(document["locale"].get("collate"), 256)
    or not safe_text(document["locale"].get("ctype"), 256)
    or document["locale"].get("provider") != "c"
    or document["locale"].get("icuLocale") is not None
    or (
        document["locale"].get("collationVersion") is not None
        and not safe_text(document["locale"]["collationVersion"], 256)
    )
    or (
        document["locale"].get("collationActualVersion") is not None
        and not safe_text(
            document["locale"]["collationActualVersion"], 256
        )
    )
    or document["locale"].get("collationVersion")
        != document["locale"].get("collationActualVersion")
    or not re.fullmatch(
        r"[A-Za-z0-9_-]{64}", str(document.get("applicationPassword", ""))
    )
):
    raise SystemExit(1)
values = (
    document["database"],
    document["applicationRole"],
    document["socketDirectory"],
    str(document["port"]),
    document["unit"],
    document["adminRole"],
    str(document["logicalBytes"]),
)
if any("\t" in value or "\n" in value for value in values):
    raise SystemExit(1)
print("\t".join(values))
PY
}

run_restore_validation_admin_psql() {
  local target_database="$1"
  shift
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    PGOPTIONS="-c synchronous_commit=on" \
    "${RESTORE_PSQL_BIN}" --host="${socket_dir}" --port="${port}" \
      --username="${admin_role}" --dbname="${target_database}" \
      --no-psqlrc --set=ON_ERROR_STOP=1 "$@"
}

run_restore_peer_pg_restore_validation() {
  local source="$1"
  shift
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    "${RESTORE_PG_RESTORE_BIN}" --host="${socket_dir}" --port="${port}" \
      --username="${admin_role}" --dbname="${database}" \
      --role="${application_role}" "$@" "${source}"
}

attest_restore_validation_database_identity() {
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes query observed
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  query="$(restore_database_identity_sql)" || return 1
  observed="$(run_restore_validation_admin_psql "${database}" -qAt \
    --command="${query}")" || return 1
  python3 - "${ADMISSION_FILE}" "${observed}" <<'PY'
import json
import sys

admission = json.load(open(sys.argv[1], "r", encoding="utf-8"))
observed = json.loads(sys.argv[2])
if (
    admission.get("schema") != "bridgesllm.restore-admission.v2"
    or admission.get("sourceDatabaseIdentity") != observed
):
    raise SystemExit(1)
PY
}

attest_restore_validation_database_contract() {
  local sql="${TRANSACTION_DIR}/database-ownership-contract.sql"
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes result violations variant extra
  [[ -s "${sql}" && -f "${sql}" && ! -L "${sql}" \
    && "$(stat -c '%u:%g:%a:%h' "${sql}")" == "0:0:600:1" ]] || return 1
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  result="$(
    {
      printf 'SET ROLE %s;\n' "$(sql_identifier "${application_role}")"
      cat -- "${sql}"
    } | run_restore_validation_admin_psql "${database}" -qAt
  )" || return 1
  result="$(tr -d '[:space:]' <<<"${result}")"
  IFS='|' read -r violations variant extra <<<"${result}"
  [[ "${violations}" == "0" && -z "${extra}" \
    && "${variant}" == "$(admitted_database_contract_variant)" ]]
}

validation_schema_fingerprint() {
  local mode="$1" target="${TRANSACTION_DIR}/validation-schema.sha256"
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes temporary digest
  [[ "${mode}" == "record" || "${mode}" == "check" ]] || return 1
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  temporary="$(mktemp "${TRANSACTION_DIR}/.validation-schema.XXXXXX")" \
    || return 1
  if ! env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    "${RESTORE_PG_DUMP_BIN}" --host="${socket_dir}" --port="${port}" \
      --username="${admin_role}" --dbname="${database}" \
      --role="${application_role}" --schema-only --no-owner \
      --no-privileges --no-tablespaces --file="${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  digest="$(sha256sum "${temporary}" | cut -d' ' -f1)" || {
    rm -f -- "${temporary}"
    return 1
  }
  rm -f -- "${temporary}"
  [[ "${digest}" =~ ^[a-f0-9]{64}$ ]] || return 1
  if [[ "${mode}" == "record" ]]; then
    [[ ! -e "${target}" && ! -L "${target}" ]] || return 1
    printf '%s\n' "${digest}" > "${target}"
    chmod 600 "${target}"
    sync -f -- "${target}"
  else
    [[ -f "${target}" && ! -L "${target}" \
      && "$(stat -c '%u:%g:%a:%h' "${target}")" == "0:0:600:1" \
      && "$(<"${target}")" == "${digest}" ]]
  fi
}

attest_restore_validation_migration_ledger() {
  local mode="${1:-check}"
  local sealed="${TRANSACTION_DIR}/validation-migration-ledger.json"
  local staged_portal fields database application_role socket_dir port unit
  local admin_role logical_bytes observed
  [[ "${mode}" == "record" || "${mode}" == "check" ]] || return 1
  staged_portal="$(component_source_root portal-install "${PORTAL_DIR}")" \
    || return 1
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  observed="$(run_restore_validation_admin_psql "${database}" -qAt --command="
SET search_path TO public, pg_catalog;
SELECT COALESCE(json_agg(json_build_object(
  'id', id,
  'name', migration_name,
  'checksum', checksum,
  'startedAt', started_at::text,
  'finishedAt', finished_at::text,
  'rolledBackAt', rolled_back_at::text,
  'steps', applied_steps_count
) ORDER BY started_at, id), '[]'::json)::text
FROM public._prisma_migrations;
")" || return 1
  python3 - "${staged_portal}/backend/prisma/migrations" "${observed}" \
    "${sealed}" "${mode}" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
observed_raw, sealed_raw, mode = sys.argv[2:]
if len(observed_raw.encode("utf-8")) > 1024 * 1024:
    raise SystemExit(1)
observed = json.loads(observed_raw)
root_info = os.lstat(root)
if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
    raise SystemExit(1)
expected = {}
for entry in sorted(root.iterdir(), key=lambda item: item.name):
    info = os.lstat(entry)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or not re.fullmatch(r"[0-9]{14}_[A-Za-z0-9_]+", entry.name)
    ):
        raise SystemExit(1)
    migration = entry / "migration.sql"
    migration_info = os.lstat(migration)
    if (
        not stat.S_ISREG(migration_info.st_mode)
        or stat.S_ISLNK(migration_info.st_mode)
        or migration_info.st_nlink != 1
        or migration_info.st_size <= 0
    ):
        raise SystemExit(1)
    expected[entry.name] = hashlib.sha256(migration.read_bytes()).hexdigest()
if not expected or not isinstance(observed, list):
    raise SystemExit(1)
active = []
for row in observed:
    if (
        not isinstance(row, dict)
        or set(row) != {
            "id", "name", "checksum", "startedAt", "finishedAt",
            "rolledBackAt", "steps",
        }
        or not isinstance(row["id"], str)
        or not row["id"]
        or row["name"] not in expected
        or not isinstance(row["checksum"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", row["checksum"])
        or not isinstance(row["startedAt"], str)
        or not row["startedAt"]
        or not isinstance(row["steps"], int)
        or isinstance(row["steps"], bool)
        or row["steps"] not in {0, 1}
    ):
        raise SystemExit(1)
    if row["rolledBackAt"] is None:
        if (
            row["checksum"] != expected[row["name"]]
            or row["finishedAt"] is None
            or row["steps"] != 1
        ):
            raise SystemExit(1)
        active.append((row["name"], row["checksum"]))
    elif not isinstance(row["rolledBackAt"], str):
        raise SystemExit(1)
expected_active = sorted(expected.items())
if sorted(active) != expected_active or len(active) != len(expected_active):
    raise SystemExit(1)
canonical = (
    json.dumps(observed, sort_keys=True, separators=(",", ":")) + "\n"
).encode("utf-8")
sealed = pathlib.Path(sealed_raw)
if mode == "record":
    descriptor = os.open(
        sealed,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.write(descriptor, canonical)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
else:
    info = os.lstat(sealed)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or sealed.read_bytes() != canonical
    ):
        raise SystemExit(1)
PY
}

prepare_restore_validation_environment() {
  local application="$1"
  local target="${TRANSACTION_DIR}/${application}.env"
  [[ "${application}" =~ ^bridgesllm-restore-(migration|candidate)-[a-f0-9]{32}$ \
    && ! -e "${target}" && ! -L "${target}" ]] || return 1
  python3 - "${TRANSACTION_DIR}/stage/configs/portal-backend.env.production" \
    "${TRANSACTION_DIR}/validation-database-authority.json" \
    "${target}" "${application}" <<'PY'
import json
import os
import re
import sys
from urllib.parse import parse_qs, quote, urlencode, urlsplit

source, authority_path, target, application = sys.argv[1:]
authority = json.load(open(authority_path, "r", encoding="utf-8"))
assignment = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
lines = []
seen = False
for raw in open(source, "r", encoding="utf-8").read().splitlines():
    match = assignment.fullmatch(raw)
    if match and (
        match.group(1).startswith("PG")
        or match.group(1).startswith("POSTGRES")
        or (
            match.group(1) != "DATABASE_URL"
            and "DATABASE_URL" in match.group(1)
        )
    ):
        continue
    if match and match.group(1) == "DATABASE_URL":
        if seen:
            raise SystemExit(1)
        seen = True
        value = match.group(2)
        if value[:1] in {"'", '"'}:
            if len(value) < 2 or value[-1] != value[0]:
                raise SystemExit(1)
            value = value[1:-1]
        original_query = parse_qs(
            urlsplit(value).query, keep_blank_values=True
        )
        query = {
            "host": authority["socketDirectory"],
            "application_name": application,
            "sslmode": "disable",
            "schema": original_query.get("schema", ["public"])[-1],
            "connection_limit": "1",
        }
        rewritten = (
            "postgresql://"
            + quote(authority["applicationRole"], safe="")
            + ":"
            + quote(authority["applicationPassword"], safe="")
            + "@localhost:"
            + str(authority["port"])
            + "/"
            + quote(authority["database"], safe="")
            + "?"
            + urlencode(query)
        )
        lines.append("DATABASE_URL=" + rewritten)
    else:
        lines.append(raw)
if not seen:
    raise SystemExit(1)
descriptor = os.open(
    target,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    os.write(descriptor, ("\n".join(lines) + "\n").encode("utf-8"))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  sync -f -- "${target}" || return 1
  printf '%s\n' "${target}"
}

prepare_restore_validation_database() {
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes source database_identifier
  local application_role_identifier free_bytes required_bytes
  local free_inodes required_inodes relation_count
  local locale_values locale_encoding locale_collate locale_ctype
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  source="${TRANSACTION_DIR}/stage/database.dump"
  [[ -f "${source}" && ! -L "${source}" \
    && "$(stat -c '%u:%g:%a:%h' "${source}")" == "0:0:600:1" ]] || return 1
  free_bytes="$(df --output=avail -B1 "${RESTORE_VALIDATION_STORAGE_PROBE}" \
    | tail -1 | tr -d ' ')" \
    || return 1
  free_inodes="$(df --output=iavail "${RESTORE_VALIDATION_STORAGE_PROBE}" \
    | tail -1 | tr -d ' ')" \
    || return 1
  relation_count="$(python3 - \
    "${TRANSACTION_DIR}/validation-database-authority.json" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], "r", encoding="utf-8"))["relationCount"])
PY
  )" || return 1
  locale_values="$(python3 - \
    "${TRANSACTION_DIR}/validation-database-authority.json" <<'PY'
import json
import sys
locale = json.load(open(sys.argv[1], "r", encoding="utf-8"))["locale"]
print(
    locale["encoding"] + "\t"
    + locale["collate"] + "\t"
    + locale["ctype"]
)
PY
  )" || return 1
  IFS=$'\t' read -r locale_encoding locale_collate locale_ctype \
    <<<"${locale_values}"
  [[ "${free_bytes}" =~ ^[0-9]+$ && "${free_inodes}" =~ ^[0-9]+$ \
    && "${relation_count}" =~ ^[1-9][0-9]*$ ]] || return 1
  required_bytes="$(( logical_bytes * 3 + RESERVE_BYTES ))"
  required_inodes="$(( relation_count * 8 + 100000 ))"
  (( free_bytes >= required_bytes && free_inodes >= required_inodes )) \
    || return 1
  local -a database_paths=()
  capture_restore_prevalidation_inaccessible_paths database_paths \
    || return 1
  local -a properties=(
    --property=Type=exec
    --property=Restart=no
    --property=KillMode=control-group
    --property=RuntimeMaxSec=14400
    --property=TimeoutStopSec=30
    --property=DynamicUser=yes
    --property="RuntimeDirectory=${unit}"
    --property=RuntimeDirectoryMode=0755
    --property=RuntimeDirectoryPreserve=no
    --property="StateDirectory=${unit}"
    --property=StateDirectoryMode=0700
    --property=NoNewPrivileges=yes
    --property=CapabilityBoundingSet=
    --property=AmbientCapabilities=
    --property=RestrictSUIDSGID=yes
    --property=ProtectSystem=strict
    --property=ProtectHome=yes
    --property=PrivateTmp=yes
    --property=PrivateDevices=yes
    --property=PrivateNetwork=yes
    --property=ProtectKernelTunables=yes
    --property=ProtectKernelModules=yes
    --property=ProtectControlGroups=yes
    --property=ProtectProc=invisible
    --property=ProcSubset=pid
    --property=InaccessiblePaths=-/run/docker.sock
    --property=InaccessiblePaths=-/var/run/docker.sock
    --property=RestrictAddressFamilies=AF_UNIX
    --property=LockPersonality=yes
    --property=SystemCallArchitectures=native
    --property=UMask=0077
  )
  local database_path
  for database_path in "${database_paths[@]}"; do
    properties+=(--property="InaccessiblePaths=${database_path}")
  done
  stop_restore_validation_cluster || return 1
  "${RESTORE_SYSTEMD_RUN_BIN}" \
    --unit="${unit}" \
    --description="BridgesLLM disposable restore validation database ${TRANSACTION_ID}" \
    --quiet "${properties[@]}" \
    /bin/bash -c '
set -Eeuo pipefail
data="${STATE_DIRECTORY}/data"
socket="${RUNTIME_DIRECTORY}/socket"
install -d -m 700 "${data}"
install -d -m 755 "${socket}"
"$1" --pgdata="${data}" --username="$3" \
  --auth-local=reject --auth-host=reject \
  --encoding="$7" --lc-collate="$8" --lc-ctype="$9" >/dev/null
cat >"${data}/pg_hba.conf" <<EOF
local replication all reject
local "$4" "$5" scram-sha-256
local "$4" "$3" peer map=bridgesllm_restore_admin
local postgres "$3" peer map=bridgesllm_restore_admin
local all all reject
EOF
cat >"${data}/pg_ident.conf" <<EOF
bridgesllm_restore_admin root "$3"
EOF
chmod 600 "${data}/pg_hba.conf"
chmod 600 "${data}/pg_ident.conf"
exec "$2" --pgdata="${data}" -h "" -k "${socket}" -p "$6" \
  -c unix_socket_permissions=0777 -c fsync=on \
  -c full_page_writes=on -c synchronous_commit=on -c jit=off \
  -c max_prepared_transactions=0
' bridgesllm-validation \
      "${RESTORE_INITDB_BIN}" "${RESTORE_POSTGRES_BIN}" "${admin_role}" \
      "${database}" "${application_role}" "${port}" \
      "${locale_encoding}" "${locale_collate}" "${locale_ctype}" >/dev/null \
    || return 1
  local receipt_waited receipt_ready=false
  for receipt_waited in $(seq 1 200); do
    if seal_restore_validation_state_receipt 2>/dev/null; then
      receipt_ready=true
      break
    fi
    sleep 0.05
  done
  [[ "${receipt_ready}" == "true" ]] || {
    stop_restore_validation_cluster || true
    return 1
  }
  local waited
  for waited in $(seq 1 200); do
    if run_restore_validation_admin_psql postgres -qAt \
      --command="SELECT 1;" 2>/dev/null | grep -qx 1; then
      break
    fi
    sleep 0.05
  done
  (( waited < 200 )) || {
    stop_restore_validation_cluster || true
    return 1
  }
  local boundary
  boundary="$(run_restore_validation_admin_psql postgres -qAt --command="
SELECT json_build_object(
  'prepared', current_setting('max_prepared_transactions'),
  'listen', current_setting('listen_addresses'),
  'hbaErrors', (SELECT count(*) FROM pg_hba_file_rules
                WHERE error IS NOT NULL),
  'identErrors', (SELECT count(*) FROM pg_ident_file_mappings
                  WHERE error IS NOT NULL),
  'hba', pg_read_file('pg_hba.conf'),
  'ident', pg_read_file('pg_ident.conf')
)::text;
")" || { stop_restore_validation_cluster || true; return 1; }
  python3 - "${boundary}" "${database}" "${application_role}" \
    "${admin_role}" <<'PY' \
    || { stop_restore_validation_cluster || true; return 1; }
import json
import sys
raw, database, application_role, admin_role = sys.argv[1:]
observed = json.loads(raw)
expected_hba = (
    "local replication all reject\n"
    f'local "{database}" "{application_role}" scram-sha-256\n'
    f'local "{database}" "{admin_role}" peer map=bridgesllm_restore_admin\n'
    f'local postgres "{admin_role}" peer map=bridgesllm_restore_admin\n'
    "local all all reject\n"
)
expected_ident = (
    f'bridgesllm_restore_admin root "{admin_role}"\n'
)
expected = {
    "prepared": "0",
    "listen": "",
    "hbaErrors": 0,
    "identErrors": 0,
    "hba": expected_hba,
    "ident": expected_ident,
}
raise SystemExit(0 if observed == expected else 1)
PY
  database_identifier="$(sql_identifier "${database}")" || return 1
  application_role_identifier="$(sql_identifier "${application_role}")" \
    || return 1
  if ! python3 - \
    "${TRANSACTION_DIR}/validation-database-authority.json" <<'PY' \
    | run_restore_validation_admin_psql postgres -qAt >/dev/null 2>/dev/null
import json
import re
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
role = document["applicationRole"]
password = document["applicationPassword"]
if not re.fullmatch(r"[A-Za-z0-9_-]{64}", password):
    raise SystemExit(1)
role_literal = "'" + role.replace("'", "''") + "'"
print("BEGIN;")
print("CREATE TEMP TABLE pg_temp.secret (password text NOT NULL) ON COMMIT DROP;")
print("COPY pg_temp.secret (password) FROM STDIN;")
print(password)
print(r"\.")
print("DO $bridgesllm$")
print("DECLARE value text; BEGIN")
print("SELECT password INTO STRICT value FROM pg_temp.secret;")
print(
    "EXECUTE format("
    "'CREATE ROLE %I LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE "
    "NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 PASSWORD %L', "
    f"{role_literal}, value);"
)
print("END $bridgesllm$;")
print("COMMIT;")
PY
  then
    stop_restore_validation_cluster || true
    return 1
  fi
  run_restore_validation_admin_psql postgres -qAt <<SQL >/dev/null \
    || { stop_restore_validation_cluster || true; return 1; }
CREATE DATABASE ${database_identifier}
  OWNER ${application_role_identifier}
  TEMPLATE template0;
ALTER DATABASE ${database_identifier} CONNECTION LIMIT 1;
SQL
  local locale_state
  if (( RESTORE_POSTGRESQL_CLIENT_MAJOR >= 15 )); then
    locale_state="$(run_restore_validation_admin_psql "${database}" -qAt \
      --command="
SELECT json_build_object(
  'encoding', pg_encoding_to_char(encoding),
  'collate', datcollate, 'ctype', datctype,
  'provider', datlocprovider::text, 'icuLocale', daticulocale,
  'collationVersion', datcollversion,
  'collationActualVersion', pg_database_collation_actual_version(oid)
)::text FROM pg_database WHERE datname = current_database();
")" || { stop_restore_validation_cluster || true; return 1; }
  else
    locale_state="$(run_restore_validation_admin_psql "${database}" -qAt \
      --command="
SELECT json_build_object(
  'encoding', pg_encoding_to_char(encoding),
  'collate', datcollate, 'ctype', datctype,
  'provider', 'c', 'icuLocale', NULL,
  'collationVersion', NULL,
  'collationActualVersion', NULL
)::text FROM pg_database WHERE datname = current_database();
")" || { stop_restore_validation_cluster || true; return 1; }
  fi
  python3 - "${TRANSACTION_DIR}/validation-database-authority.json" \
    "${locale_state}" <<'PY' \
    || { stop_restore_validation_cluster || true; return 1; }
import json
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
raise SystemExit(0 if json.loads(sys.argv[2]) == document["locale"] else 1)
PY
  attest_restore_validation_database_identity \
    || { stop_restore_validation_cluster || true; return 1; }
  local variant
  variant="$(admitted_database_contract_variant)" \
    || { stop_restore_validation_cluster || true; return 1; }
  {
    printf '%s\n' 'DROP SCHEMA IF EXISTS public CASCADE;'
    if [[ "${variant}" == "owner-null" ]]; then
      printf 'CREATE SCHEMA public AUTHORIZATION %s;\n' \
        "${application_role_identifier}"
    else
      cat <<'SQL'
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT ALL PRIVILEGES ON SCHEMA public TO pg_database_owner;
SQL
    fi
  } | run_restore_validation_admin_psql "${database}" -qAt >/dev/null \
    || { stop_restore_validation_cluster || true; return 1; }
  run_restore_peer_pg_restore_validation "${source}" \
    --format=custom --exit-on-error --single-transaction \
    --no-owner --no-privileges --no-tablespaces >/dev/null \
    || { stop_restore_validation_cluster || true; return 1; }
  attest_restore_validation_database_contract \
    && attest_restore_validation_migration_ledger record \
    && validation_schema_fingerprint record \
    || { stop_restore_validation_cluster || true; return 1; }
}

seal_restore_validation_state_receipt() {
  local target="${TRANSACTION_DIR}/validation-state-receipt.json"
  local temporary="${target}.tmp-${TRANSACTION_ID}"
  local unit="bridgesllm-restore-postgres-${TRANSACTION_ID}"
  local runtime="${RESTORE_VALIDATION_RUNTIME_ROOT}/${unit}"
  local state="${RESTORE_VALIDATION_STATE_ROOT}/${unit}"
  local alias="${RESTORE_VALIDATION_STATE_ALIAS_ROOT}/${unit}"
  [[ ! -e "${target}" && ! -L "${target}" \
    && ! -e "${temporary}" && ! -L "${temporary}" ]] || return 1
  python3 - "${temporary}" "${target}" "${TRANSACTION_ID}" "${unit}" \
    "${runtime}" "${state}" "${alias}" <<'PY' || return 1
import json
import os
import pathlib
import stat
import sys

temporary_raw, target_raw, operation_id, unit, runtime_raw, state_raw, alias_raw = (
    sys.argv[1:]
)
temporary = pathlib.Path(temporary_raw)
target = pathlib.Path(target_raw)
runtime = pathlib.Path(runtime_raw)
state = pathlib.Path(state_raw)
alias = pathlib.Path(alias_raw)
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | os.O_NOFOLLOW
)
path_flags = (
    getattr(os, "O_PATH", os.O_RDONLY)
    | getattr(os, "O_CLOEXEC", 0)
    | os.O_NOFOLLOW
)

def mount_id(descriptor):
    values = [
        line.partition(":")[2].strip()
        for line in pathlib.Path(
            f"/proc/self/fdinfo/{descriptor}"
        ).read_text(encoding="ascii").splitlines()
        if line.startswith("mnt_id:")
    ]
    if len(values) != 1 or not values[0].isdigit():
        raise SystemExit(1)
    return int(values[0])

def safe_parent(path):
    descriptor = os.open("/", directory_flags)
    try:
        for component in path.parts[1:]:
            child = os.open(
                component, directory_flags, dir_fd=descriptor
            )
            info = os.fstat(child)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != 0
                or info.st_gid != 0
                or info.st_mode & 0o022
            ):
                os.close(child)
                raise SystemExit(1)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def directory_receipt(path, mode, expected_owner=None):
    parent = safe_parent(path.parent)
    descriptor = None
    try:
        descriptor = os.open(
            path.name, directory_flags, dir_fd=parent
        )
        info = os.fstat(descriptor)
        current = os.stat(
            path.name, dir_fd=parent, follow_symlinks=False
        )
        parent_info = os.fstat(parent)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(current.st_mode)
            or (info.st_dev, info.st_ino)
                != (current.st_dev, current.st_ino)
            or info.st_dev != parent_info.st_dev
            or mount_id(descriptor) != mount_id(parent)
            or stat.S_IMODE(info.st_mode) != mode
            or info.st_uid == 0
            or info.st_gid == 0
            or (
                expected_owner is not None
                and (info.st_uid, info.st_gid) != expected_owner
            )
        ):
            raise SystemExit(1)
        return {
            "path": str(path),
            "dev": info.st_dev,
            "ino": info.st_ino,
            "mountId": mount_id(descriptor),
            "uid": info.st_uid,
            "gid": info.st_gid,
            "mode": stat.S_IMODE(info.st_mode),
        }
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)

state_record = directory_receipt(state, 0o700)
owner = (state_record["uid"], state_record["gid"])
runtime_record = directory_receipt(runtime, 0o755, owner)
alias_parent = safe_parent(alias.parent)
alias_descriptor = None
try:
    alias_info = os.stat(
        alias.name, dir_fd=alias_parent, follow_symlinks=False
    )
    alias_descriptor = os.open(
        alias.name, path_flags, dir_fd=alias_parent
    )
    opened_alias = os.fstat(alias_descriptor)
    expected_target = f"private/{unit}"
    if (
        not stat.S_ISLNK(alias_info.st_mode)
        or (opened_alias.st_dev, opened_alias.st_ino)
            != (alias_info.st_dev, alias_info.st_ino)
        or alias_info.st_uid != 0
        or alias_info.st_gid != 0
        or alias_info.st_dev != os.fstat(alias_parent).st_dev
        or mount_id(alias_descriptor) != mount_id(alias_parent)
        or os.readlink(alias.name, dir_fd=alias_parent) != expected_target
    ):
        raise SystemExit(1)
    alias_record = {
        "path": str(alias),
        "dev": alias_info.st_dev,
        "ino": alias_info.st_ino,
        "mountId": mount_id(alias_descriptor),
        "uid": alias_info.st_uid,
        "gid": alias_info.st_gid,
        "mode": stat.S_IMODE(alias_info.st_mode),
        "target": expected_target,
    }
finally:
    if alias_descriptor is not None:
        os.close(alias_descriptor)
    os.close(alias_parent)

document = {
    "schema": "bridgesllm.validation-state-receipt.v1",
    "operationId": operation_id,
    "unit": unit,
    "dynamicUid": owner[0],
    "dynamicGid": owner[1],
    "runtime": runtime_record,
    "state": state_record,
    "alias": alias_record,
}
payload = (
    json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n"
).encode("utf-8")
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.replace(temporary, target)
PY
  sync -f -- "${target}" || return 1
  fsync_directory "${TRANSACTION_DIR}"
}

remove_restore_validation_paths_from_receipt() {
  local receipt="${TRANSACTION_DIR}/validation-state-receipt.json"
  local unit="bridgesllm-restore-postgres-${TRANSACTION_ID}"
  local runtime="${RESTORE_VALIDATION_RUNTIME_ROOT}/${unit}"
  local state="${RESTORE_VALIDATION_STATE_ROOT}/${unit}"
  local alias="${RESTORE_VALIDATION_STATE_ALIAS_ROOT}/${unit}"
  python3 - "${receipt}" "${TRANSACTION_ID}" "${unit}" \
    "${runtime}" "${state}" "${alias}" <<'PY'
import json
import os
import pathlib
import stat
import sys

receipt_raw, operation_id, unit, runtime_raw, state_raw, alias_raw = sys.argv[1:]
receipt = pathlib.Path(receipt_raw)
runtime = pathlib.Path(runtime_raw)
state = pathlib.Path(state_raw)
alias = pathlib.Path(alias_raw)
receipt_info = os.lstat(receipt)
if (
    not stat.S_ISREG(receipt_info.st_mode)
    or stat.S_ISLNK(receipt_info.st_mode)
    or receipt_info.st_uid != 0
    or receipt_info.st_gid != 0
    or receipt_info.st_nlink != 1
    or stat.S_IMODE(receipt_info.st_mode) != 0o600
    or receipt_info.st_size <= 0
    or receipt_info.st_size > 16384
):
    raise SystemExit(1)
document = json.load(open(receipt, "r", encoding="utf-8"))
if (
    set(document) != {
        "schema", "operationId", "unit", "dynamicUid", "dynamicGid",
        "runtime", "state", "alias",
    }
    or document.get("schema") != "bridgesllm.validation-state-receipt.v1"
    or document.get("operationId") != operation_id
    or document.get("unit") != unit
    or not isinstance(document.get("dynamicUid"), int)
    or isinstance(document.get("dynamicUid"), bool)
    or document["dynamicUid"] <= 0
    or not isinstance(document.get("dynamicGid"), int)
    or isinstance(document.get("dynamicGid"), bool)
    or document["dynamicGid"] <= 0
):
    raise SystemExit(1)
dynamic_owner = (document["dynamicUid"], document["dynamicGid"])
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | os.O_NOFOLLOW
)
path_flags = (
    getattr(os, "O_PATH", os.O_RDONLY)
    | getattr(os, "O_CLOEXEC", 0)
    | os.O_NOFOLLOW
)

def mount_id(descriptor):
    values = [
        line.partition(":")[2].strip()
        for line in pathlib.Path(
            f"/proc/self/fdinfo/{descriptor}"
        ).read_text(encoding="ascii").splitlines()
        if line.startswith("mnt_id:")
    ]
    if len(values) != 1 or not values[0].isdigit():
        raise SystemExit(1)
    return int(values[0])

def inode_identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))

def safe_parent(path):
    descriptor = os.open("/", directory_flags)
    try:
        for component in path.parts[1:]:
            child = os.open(
                component, directory_flags, dir_fd=descriptor
            )
            info = os.fstat(child)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != 0
                or info.st_gid != 0
                or info.st_mode & 0o022
            ):
                os.close(child)
                raise SystemExit(1)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def validate_record(record, path, mode, *, alias_record=False):
    required = {"path", "dev", "ino", "mountId", "uid", "gid", "mode"}
    if alias_record:
        required.add("target")
    if (
        not isinstance(record, dict)
        or set(record) != required
        or record.get("path") != str(path)
        or record.get("mode") != mode
        or any(
            not isinstance(record.get(key), int)
            or isinstance(record.get(key), bool)
            or record[key] < 0
            for key in ("dev", "ino", "mountId", "uid", "gid")
        )
    ):
        raise SystemExit(1)

validate_record(document["runtime"], runtime, 0o755)
validate_record(document["state"], state, 0o700)
validate_record(document["alias"], alias, 0o777, alias_record=True)
if (
    (document["runtime"]["uid"], document["runtime"]["gid"]) != dynamic_owner
    or (document["state"]["uid"], document["state"]["gid"]) != dynamic_owner
    or (document["alias"]["uid"], document["alias"]["gid"]) != (0, 0)
    or document["alias"]["target"] != f"private/{unit}"
):
    raise SystemExit(1)

opened = {}
parents = {}
try:
    for name, path in (("runtime", runtime), ("state", state)):
        parent = safe_parent(path.parent)
        parents[name] = parent
        try:
            descriptor = os.open(
                path.name, directory_flags, dir_fd=parent
            )
        except FileNotFoundError:
            opened[name] = None
            continue
        info = os.fstat(descriptor)
        record = document[name]
        if (
            not stat.S_ISDIR(info.st_mode)
            or (info.st_dev, info.st_ino) != (record["dev"], record["ino"])
            or mount_id(descriptor) != record["mountId"]
            or (info.st_uid, info.st_gid) != dynamic_owner
            or stat.S_IMODE(info.st_mode) != record["mode"]
            or info.st_dev != os.fstat(parent).st_dev
            or mount_id(descriptor) != mount_id(parent)
        ):
            os.close(descriptor)
            raise SystemExit(1)
        opened[name] = descriptor

    alias_parent = safe_parent(alias.parent)
    parents["alias"] = alias_parent
    try:
        alias_descriptor = os.open(
            alias.name, path_flags, dir_fd=alias_parent
        )
    except FileNotFoundError:
        opened["alias"] = None
    else:
        alias_info = os.fstat(alias_descriptor)
        record = document["alias"]
        if (
            not stat.S_ISLNK(alias_info.st_mode)
            or (alias_info.st_dev, alias_info.st_ino)
                != (record["dev"], record["ino"])
            or mount_id(alias_descriptor) != record["mountId"]
            or (alias_info.st_uid, alias_info.st_gid) != (0, 0)
            or stat.S_IMODE(alias_info.st_mode) != record["mode"]
            or os.readlink(alias.name, dir_fd=alias_parent)
                != record["target"]
            or alias_info.st_dev != os.fstat(alias_parent).st_dev
            or mount_id(alias_descriptor) != mount_id(alias_parent)
        ):
            os.close(alias_descriptor)
            raise SystemExit(1)
        opened["alias"] = alias_descriptor

    def remove_contents(descriptor, root_device, root_mount):
        info = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_dev != root_device
            or mount_id(descriptor) != root_mount
            or (info.st_uid, info.st_gid) != dynamic_owner
        ):
            raise SystemExit(1)
        for name in os.listdir(descriptor):
            entry = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if (
                entry.st_dev != root_device
                or (entry.st_uid, entry.st_gid) != dynamic_owner
            ):
                raise SystemExit(1)
            if stat.S_ISDIR(entry.st_mode):
                child = os.open(name, directory_flags, dir_fd=descriptor)
                try:
                    opened_info = os.fstat(child)
                    if (
                        inode_identity(opened_info) != inode_identity(entry)
                        or opened_info.st_dev != root_device
                        or mount_id(child) != root_mount
                    ):
                        raise SystemExit(1)
                    remove_contents(child, root_device, root_mount)
                    current = os.stat(
                        name, dir_fd=descriptor, follow_symlinks=False
                    )
                    if inode_identity(current) != inode_identity(opened_info):
                        raise SystemExit(1)
                    os.rmdir(name, dir_fd=descriptor)
                finally:
                    os.close(child)
            elif (
                stat.S_ISREG(entry.st_mode)
                or stat.S_ISLNK(entry.st_mode)
                or stat.S_ISSOCK(entry.st_mode)
            ):
                entry_descriptor = os.open(
                    name, path_flags, dir_fd=descriptor
                )
                try:
                    opened_info = os.fstat(entry_descriptor)
                    if (
                        inode_identity(opened_info) != inode_identity(entry)
                        or opened_info.st_dev != root_device
                        or mount_id(entry_descriptor) != root_mount
                        or (opened_info.st_uid, opened_info.st_gid)
                            != dynamic_owner
                    ):
                        raise SystemExit(1)
                    current = os.stat(
                        name, dir_fd=descriptor, follow_symlinks=False
                    )
                    if inode_identity(current) != inode_identity(opened_info):
                        raise SystemExit(1)
                    os.unlink(name, dir_fd=descriptor)
                finally:
                    os.close(entry_descriptor)
            else:
                raise SystemExit(1)
        os.fsync(descriptor)

    for name in ("runtime", "state"):
        descriptor = opened[name]
        if descriptor is None:
            continue
        record = document[name]
        remove_contents(descriptor, record["dev"], record["mountId"])
        current = os.stat(
            (runtime if name == "runtime" else state).name,
            dir_fd=parents[name],
            follow_symlinks=False,
        )
        if inode_identity(current) != inode_identity(os.fstat(descriptor)):
            raise SystemExit(1)
        os.rmdir(
            (runtime if name == "runtime" else state).name,
            dir_fd=parents[name],
        )
        os.fsync(parents[name])

    if opened["alias"] is not None:
        current = os.stat(
            alias.name, dir_fd=parents["alias"], follow_symlinks=False
        )
        if inode_identity(current) != inode_identity(
            os.fstat(opened["alias"])
        ):
            raise SystemExit(1)
        os.unlink(alias.name, dir_fd=parents["alias"])
        os.fsync(parents["alias"])
finally:
    for descriptor in opened.values():
        if descriptor is not None:
            os.close(descriptor)
    for descriptor in parents.values():
        os.close(descriptor)
PY
}

stop_restore_validation_cluster() {
  [[ "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ \
    && "${TRANSACTION_DIR}" == "${TRANSACTIONS_ROOT}/${TRANSACTION_ID}" ]] \
    || return 1
  local unit="bridgesllm-restore-postgres-${TRANSACTION_ID}"
  local runtime="${RESTORE_VALIDATION_RUNTIME_ROOT}/${unit}"
  local state="${RESTORE_VALIDATION_STATE_ROOT}/${unit}"
  local alias="${RESTORE_VALIDATION_STATE_ALIAS_ROOT}/${unit}"
  if [[ ! -e "${runtime}" && ! -L "${runtime}" \
    && ! -e "${state}" && ! -L "${state}" \
    && ! -e "${alias}" && ! -L "${alias}" ]]; then
    "${RESTORE_SYSTEMCTL_BIN}" reset-failed "${unit}.service" \
      >/dev/null 2>&1 || true
    return 0
  fi
  "${RESTORE_SYSTEMCTL_BIN}" stop "${unit}.service" >/dev/null 2>&1 || true
  local active
  active="$("${RESTORE_SYSTEMCTL_BIN}" show \
    --property=ActiveState --value "${unit}.service" 2>/dev/null)" || return 1
  [[ "${active}" == "inactive" || "${active}" == "failed" ]] || return 1
  "${RESTORE_SYSTEMCTL_BIN}" clean --what=state,runtime \
    "${unit}.service" >/dev/null 2>&1 || true
  if [[ -e "${runtime}" || -L "${runtime}" \
    || -e "${state}" || -L "${state}" \
    || -e "${alias}" || -L "${alias}" ]]; then
    # StateDirectory survives a cold boot even after transient unit metadata
    # is gone. Only the exact inode/mount/owner receipt captured post-start is
    # accepted by the fd-relative, same-filesystem cleanup path.
    remove_restore_validation_paths_from_receipt || return 1
  fi
  "${RESTORE_SYSTEMCTL_BIN}" reset-failed "${unit}.service" \
    >/dev/null 2>&1 || true
  [[ ! -e "${runtime}" && ! -L "${runtime}" \
    && ! -e "${state}" && ! -L "${state}" \
    && ! -e "${alias}" && ! -L "${alias}" ]] \
    || return 1
}

cleanup_restore_validation_database() {
  if [[ ! "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ ]]; then
    [[ "${TRANSACTION_ID}" =~ ^[A-Za-z0-9._-]{1,128}$ \
      && "${TRANSACTION_DIR}" == "${TRANSACTIONS_ROOT}/${TRANSACTION_ID}" ]] \
      || return 1
    local unit="bridgesllm-restore-postgres-${TRANSACTION_ID}"
    local runtime="${RESTORE_VALIDATION_RUNTIME_ROOT}/${unit}"
    local state="${RESTORE_VALIDATION_STATE_ROOT}/${unit}"
    local alias="${RESTORE_VALIDATION_STATE_ALIAS_ROOT}/${unit}"
    [[ ! -e "${runtime}" && ! -L "${runtime}" \
      && ! -e "${state}" && ! -L "${state}" \
      && ! -e "${alias}" && ! -L "${alias}" \
      && ! -e "${TRANSACTION_DIR}/validation-database-authority.json" \
      && ! -L "${TRANSACTION_DIR}/validation-database-authority.json" \
      && ! -e "${TRANSACTION_DIR}/validation-state-receipt.json" \
      && ! -L "${TRANSACTION_DIR}/validation-state-receipt.json" ]] \
      || return 1
    return 0
  fi
  stop_restore_validation_cluster
}

assert_restore_validation_socket() {
  local fields database application_role socket_dir port unit admin_role
  local logical_bytes
  fields="$(restore_validation_database_fields)" || return 1
  IFS=$'\t' read -r database application_role socket_dir port unit admin_role \
    logical_bytes <<<"${fields}"
  python3 - "${socket_dir}" "${port}" <<'PY'
import os
import pathlib
import stat
import sys

directory = pathlib.Path(sys.argv[1])
port = int(sys.argv[2])
directory_info = os.lstat(directory)
socket_info = os.lstat(directory / f".s.PGSQL.{port}")
if (
    not stat.S_ISDIR(directory_info.st_mode)
    or stat.S_ISLNK(directory_info.st_mode)
    or directory_info.st_uid == 0
    or stat.S_IMODE(directory_info.st_mode) != 0o755
    or not stat.S_ISSOCK(socket_info.st_mode)
    or socket_info.st_uid != directory_info.st_uid
    or socket_info.st_gid != directory_info.st_gid
    or stat.S_IMODE(socket_info.st_mode) != 0o777
):
    raise SystemExit(1)
PY
}

run_migrations() {
  local unit="bridgesllm-restore-migration-${TRANSACTION_ID}"
  local runner_pid="" migration_status=0 validation_environment=""
  local staged_portal=""
  local -a database_paths=()
  local -a sandbox_properties=(
    --property=NoNewPrivileges=yes
    --property=CapabilityBoundingSet=
    --property=AmbientCapabilities=
    --property=RestrictSUIDSGID=yes
    --property=ProtectSystem=strict
    --property=PrivateTmp=yes
    --property=PrivateDevices=yes
    --property=ProtectKernelTunables=yes
    --property=ProtectKernelModules=yes
    --property=ProtectControlGroups=yes
    --property=ProtectProc=invisible
    --property=ProcSubset=pid
    --property=InaccessiblePaths=-/run/docker.sock
    --property=InaccessiblePaths=-/var/run/docker.sock
    --property=DynamicUser=yes
    --property=PrivateNetwork=yes
  )
  staged_portal="$(component_source_root portal-install "${PORTAL_DIR}")" \
    || die "Staged Portal root is unavailable before validation migrations"
  capture_restore_prevalidation_inaccessible_paths database_paths \
    || die "Migration PostgreSQL storage boundary is unavailable"
  (( ${#database_paths[@]} > 0 )) \
    || die "Migration PostgreSQL storage boundary is unavailable"
  local database_path
  for database_path in "${database_paths[@]}"; do
    sandbox_properties+=(
      --property="InaccessiblePaths=${database_path}"
    )
  done
  stop_restore_migration \
    || die "A prior restore migration unit could not be quiesced"
  prepare_restore_validation_database \
    || die "Isolated validation database could not be prepared"
  assert_restore_validation_socket \
    || {
      cleanup_restore_validation_database || true
      die "Isolated validation socket identity is unsafe"
    }
  validation_environment="$(prepare_restore_validation_environment "${unit}")" \
    || {
      cleanup_restore_validation_database || true
      die "Isolated migration database authority could not be prepared"
    }
  "${RESTORE_SYSTEMD_RUN_BIN}" \
    --unit="${unit}" \
    --description="BridgesLLM offline restore migrations ${TRANSACTION_ID}" \
    --working-directory="${PORTAL_DIR}/backend" \
    --wait --collect --quiet \
    --property=Type=exec \
    --property=Restart=no \
    --property=KillMode=control-group \
    --property=RuntimeMaxSec=1800 \
    --property=TimeoutStopSec=30 \
    --property="EnvironmentFile=${validation_environment}" \
    --property="BindReadOnlyPaths=${staged_portal}:${PORTAL_DIR}" \
    "${sandbox_properties[@]}" \
    /usr/bin/env \
      "PGAPPNAME=${unit}" HOME=/tmp \
      npm_config_cache=/tmp/bridgesllm-npm-cache \
      npm_config_offline=true npm_config_yes=false \
      CHECKPOINT_DISABLE=1 DO_NOT_TRACK=1 \
      "${RESTORE_NPX_BIN}" --offline --no-install \
        prisma migrate deploy >/dev/null &
  runner_pid=$!
  wait "${runner_pid}" || migration_status=$?
  [[ "${migration_status}" -eq 0 ]] || {
    stop_restore_migration || true
    cleanup_restore_validation_database || true
    die "Restored database migrations did not converge in isolation"
  }
  stop_restore_migration \
    || die "Restore migration unit did not stop cleanly"
  # A comprehensive archive is an exact quiesced code/database pair.
  # Deploy is a compatibility smoke test only: any schema or complete Prisma
  # ledger change means the archive was captured at a mixed version and must
  # be rejected before the real database or services are touched.
  validation_schema_fingerprint check \
    && attest_restore_validation_migration_ledger \
    && attest_restore_validation_database_contract \
    || {
      cleanup_restore_validation_database || true
      die "Archive migrations were not a no-op against the sealed database"
    }
}

stop_validation_candidate() {
  [[ "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ ]] || return 1
  local unit="bridgesllm-restore-candidate-${TRANSACTION_ID}.service"
  "${RESTORE_SYSTEMCTL_BIN}" stop "${unit}" >/dev/null 2>&1 || true
  local load_state active_state
  load_state="$("${RESTORE_SYSTEMCTL_BIN}" show \
    --property=LoadState --value "${unit}" 2>/dev/null)" || return 1
  active_state="$("${RESTORE_SYSTEMCTL_BIN}" show \
    --property=ActiveState --value "${unit}" 2>/dev/null)" || return 1
  [[ "${load_state}" == "loaded" || "${load_state}" == "not-found" ]] \
    || return 1
  [[ "${active_state}" == "inactive" || "${active_state}" == "failed" ]] \
    || return 1
  "${RESTORE_SYSTEMCTL_BIN}" reset-failed "${unit}" >/dev/null 2>&1 || true
}

quiesce_recovery_mutators() {
  stop_restore_migration || return 1
  stop_validation_candidate || return 1
  stop_restore_validation_cluster || return 1
  local state_file="${TRANSACTION_DIR}/service-state.json"
  [[ -e "${state_file}" || -L "${state_file}" ]] || return 0
  [[ -f "${state_file}" && ! -L "${state_file}" ]] || return 1
  "${RESTORE_SYSTEMCTL_BIN}" stop "${RESTORE_UNITS[@]}" >/dev/null 2>&1 || true
  local unit state
  for unit in "${RESTORE_UNITS[@]}"; do
    state="$("${RESTORE_SYSTEMCTL_BIN}" show --property=ActiveState --value "${unit}" 2>/dev/null)" \
      || return 1
    [[ "${state}" == "inactive" || "${state}" == "failed" ]] || return 1
  done
  python3 - "${state_file}" "${RESTORE_DOCKER_BIN}" <<'PY'
import json
import os
import re
import stat
import subprocess
import sys

path, docker = sys.argv[1:]
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or info.st_mode & 0o022
):
    raise SystemExit(1)
document = json.load(open(path, "r", encoding="utf-8"))
if document.get("schema") != "bridgesllm.restore-service-state.v2":
    raise SystemExit(1)
records = [(entry, True) for entry in document.get("projectContainers", [])]
stalwart = document.get("stalwartContainer")
if stalwart is not None:
    records.append((stalwart, False))

def command(arguments):
    result = subprocess.run(
        arguments,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
    )
    return result.stdout.strip()

seen = set()
for record, project in records:
    if not isinstance(record, dict):
        raise RuntimeError("recorded Docker state is invalid")
    identifier = record.get("id")
    name = record.get("name")
    if (
        not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or identifier in seen
        or not isinstance(name, str)
        or not name
    ):
        raise RuntimeError("recorded Docker identity is invalid")
    seen.add(identifier)
    payload = json.loads(command([docker, "container", "inspect", identifier]))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("recorded Docker identity is ambiguous")
    container = payload[0]
    if (
        str(container.get("Id") or "") != identifier
        or str(container.get("Name") or "").lstrip("/") != name
    ):
        raise RuntimeError("recorded Docker identity changed")
    if project:
        claims = record.get("claims")
        labels = ((container.get("Config") or {}).get("Labels") or {})
        if (
            not isinstance(claims, dict)
            or not claims
            or {key: labels.get(key) for key in claims} != claims
        ):
            raise RuntimeError("recorded Project ownership labels changed")
    command([docker, "container", "update", "--restart=no", identifier])
    if bool((container.get("State") or {}).get("Running")):
        command([docker, "container", "stop", "--time", "30", identifier])
    after = json.loads(command([docker, "container", "inspect", identifier]))[0]
    policy = ((after.get("HostConfig") or {}).get("RestartPolicy") or {})
    if bool((after.get("State") or {}).get("Running")) or policy.get("Name") != "no":
        raise RuntimeError("recorded container did not quiesce")
PY
}

assert_validation_port_unused() {
  [[ -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]] && return 0
  python3 - "${RESTORE_PORT}" <<'PY'
import socket
import sys
port = int(sys.argv[1])
handle = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    handle.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    handle.bind(("127.0.0.1", port))
finally:
    handle.close()
PY
}

assert_candidate_listener_owner() {
  local unit="$1"
  [[ -n "${BRIDGESLLM_RESTORE_TEST_ROOT:-}" ]] && return 0
  local main_pid
  main_pid="$("${RESTORE_SYSTEMCTL_BIN}" show \
    --property=MainPID --value "${unit}")" || return 1
  [[ "${main_pid}" =~ ^[1-9][0-9]*$ && "${main_pid}" -gt 1 ]] || return 1
  python3 - "${main_pid}" "${RESTORE_PORT}" "${unit}.service" <<'PY'
import os
import pathlib
import socket
import stat
import sys

pid = int(sys.argv[1])
port = int(sys.argv[2])
unit = sys.argv[3]
status = pathlib.Path(f"/proc/{pid}/status").read_text(encoding="ascii")
if "\nState:\tZ" in status:
    raise SystemExit(1)
cgroup = pathlib.Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8")
if unit not in cgroup:
    raise SystemExit(1)
wanted = f"{int.from_bytes(socket.inet_aton('127.0.0.1'), 'little'):08X}:{port:04X}"
inodes = set()
for table in (f"/proc/{pid}/net/tcp", f"/proc/{pid}/net/tcp6"):
    try:
        lines = pathlib.Path(table).read_text(encoding="ascii").splitlines()[1:]
    except OSError:
        raise SystemExit(1)
    for line in lines:
        fields = line.split()
        if len(fields) >= 10 and fields[1].upper() == wanted and fields[3] == "0A":
            inodes.add(fields[9])
if len(inodes) != 1:
    raise SystemExit(1)
owned = set()
for descriptor in pathlib.Path(f"/proc/{pid}/fd").iterdir():
    try:
        target = os.readlink(descriptor)
    except OSError:
        continue
    if target.startswith("socket:[") and target.endswith("]"):
        owned.add(target[8:-1])
if inodes != owned.intersection(inodes):
    raise SystemExit(1)
PY
}

candidate_private_health() {
  local candidate_unit="$1"
  local probe_unit="${candidate_unit}-health"
  "${RESTORE_SYSTEMD_RUN_BIN}" \
    --unit="${probe_unit}" \
    --description="BridgesLLM isolated candidate health probe ${TRANSACTION_ID}" \
    --wait --collect --quiet --pipe \
    --property=Type=oneshot \
    --property=Restart=no \
    --property=RuntimeMaxSec=15 \
    --property=NoNewPrivileges=yes \
    --property=CapabilityBoundingSet= \
    --property=AmbientCapabilities= \
    --property=DynamicUser=yes \
    --property=PrivateNetwork=yes \
    --property=ProtectProc=invisible \
    --property=ProcSubset=pid \
    --property=InaccessiblePaths=-/run/docker.sock \
    --property=InaccessiblePaths=-/var/run/docker.sock \
    --property="JoinsNamespaceOf=${candidate_unit}.service" \
    "${RESTORE_CURL_BIN}" -fsS --max-time 5 \
      "http://127.0.0.1:${RESTORE_PORT}/health"
}

verify_candidate() {
  local unit="bridgesllm-restore-candidate-${TRANSACTION_ID}"
  local validation_environment="" staged_portal=""
  local -a database_paths=()
  local -a sandbox_properties=(
    --property=NoNewPrivileges=yes
    --property=CapabilityBoundingSet=
    --property=AmbientCapabilities=
    --property=RestrictSUIDSGID=yes
    --property=ProtectSystem=strict
    --property=PrivateTmp=yes
    --property=PrivateDevices=yes
    --property=ProtectKernelTunables=yes
    --property=ProtectKernelModules=yes
    --property=ProtectControlGroups=yes
    --property=ProtectProc=invisible
    --property=ProcSubset=pid
    --property=InaccessiblePaths=-/run/docker.sock
    --property=InaccessiblePaths=-/var/run/docker.sock
    --property=DynamicUser=yes
    --property=PrivateNetwork=yes
  )
  assert_validation_port_unused \
    || die "Restore validation port is already owned by another process"
  staged_portal="$(component_source_root portal-install "${PORTAL_DIR}")" \
    || die "Staged Portal root is unavailable before candidate validation"
  capture_restore_prevalidation_inaccessible_paths database_paths \
    || die "Candidate PostgreSQL storage boundary is unavailable"
  (( ${#database_paths[@]} > 0 )) \
    || die "Candidate PostgreSQL storage boundary is unavailable"
  local database_path
  for database_path in "${database_paths[@]}"; do
    sandbox_properties+=(
      --property="InaccessiblePaths=${database_path}"
    )
  done
  assert_restore_validation_socket \
    || {
      cleanup_restore_validation_database || true
      die "Isolated candidate validation socket identity is unsafe"
    }
  validation_environment="$(prepare_restore_validation_environment "${unit}")" \
    || {
      cleanup_restore_validation_database || true
      die "Isolated candidate database authority could not be prepared"
    }
  "${RESTORE_SYSTEMD_RUN_BIN}" \
    --unit="${unit}" \
    --description="BridgesLLM offline restore candidate ${TRANSACTION_ID}" \
    --working-directory="${PORTAL_DIR}/backend" \
    --property=Type=exec \
    --property=Restart=no \
    --property=KillMode=control-group \
    --property=RuntimeMaxSec=600 \
    --property=TimeoutStopSec=30 \
    --property="EnvironmentFile=${validation_environment}" \
    --property="BindReadOnlyPaths=${staged_portal}:${PORTAL_DIR}" \
    "${sandbox_properties[@]}" \
    /usr/bin/env "PGAPPNAME=${unit}" HOME=/tmp \
      HOST=127.0.0.1 PORT="${RESTORE_PORT}" PORTAL_UPDATE_VALIDATION_MODE=1 \
      /usr/bin/node dist/server.js >/dev/null \
    || {
      cleanup_restore_validation_database || true
      die "Restored Portal validation candidate could not start"
    }
  local waited status="" expected_version
  expected_version="$(portal_version "${staged_portal}")" \
    || die "Staged Portal version could not be read"
  for waited in $(seq 1 60); do
    if "${RESTORE_SYSTEMCTL_BIN}" is-failed --quiet "${unit}"; then
      stop_validation_candidate || true
      cleanup_restore_validation_database || true
      die "Restored Portal validation candidate failed"
    fi
    status="$(candidate_private_health "${unit}" 2>/dev/null || true)"
    if [[ -n "${status}" ]] \
      && printf '%s' "${status}" | python3 -c '
import json, sys
document = json.load(sys.stdin)
expected = sys.argv[1]
raise SystemExit(0 if document.get("status") == "ok" and document.get("version") == expected else 1)
' "${expected_version}"; then
      assert_candidate_listener_owner "${unit}" \
        || {
          stop_validation_candidate || true
          die "Restore validation response was not owned by the candidate unit"
        }
      stop_validation_candidate \
        || die "Restored Portal validation candidate did not stop cleanly"
      validation_schema_fingerprint check \
        && attest_restore_validation_migration_ledger \
        && attest_restore_validation_database_contract \
        || {
          cleanup_restore_validation_database || true
          die "Validation candidate changed the sealed schema/ownership contract"
        }
      cleanup_restore_validation_database \
        || die "Isolated validation database did not clean up exactly"
      return 0
    fi
    sleep 1
  done
  stop_validation_candidate || true
  cleanup_restore_validation_database || true
  die "Restored Portal validation candidate did not become healthy"
}

safe_remove_target() {
  local target="$1"
  python3 - "${target}" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
broad = {pathlib.Path(value) for value in (
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/media",
    "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp",
    "/usr", "/var",
)}
if path in broad or not path.is_absolute() or os.path.normpath(path) != str(path):
    raise SystemExit(1)

directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | os.O_NOFOLLOW
)

def mount_id(descriptor):
    try:
        lines = pathlib.Path(f"/proc/self/fdinfo/{descriptor}").read_text(
            encoding="ascii"
        ).splitlines()
    except OSError:
        raise SystemExit(1)
    values = [
        line.partition(":")[2].strip()
        for line in lines
        if line.startswith("mnt_id:")
    ]
    if len(values) != 1 or not values[0].isdigit():
        raise SystemExit(1)
    return int(values[0])

def identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))

parent_descriptor = os.open("/", directory_flags)
try:
    for component in path.parent.parts[1:]:
        try:
            child_descriptor = os.open(
                component,
                directory_flags,
                dir_fd=parent_descriptor,
            )
        except FileNotFoundError:
            raise SystemExit(0)
        info = os.fstat(child_descriptor)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
        ):
            os.close(child_descriptor)
            raise SystemExit(1)
        os.close(parent_descriptor)
        parent_descriptor = child_descriptor

    target_name = path.name
    parent_info = os.fstat(parent_descriptor)
    parent_device = parent_info.st_dev
    parent_mount = mount_id(parent_descriptor)
    try:
        target_info = os.stat(
            target_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        raise SystemExit(0)
    if (
        stat.S_ISLNK(target_info.st_mode)
        or target_info.st_uid != 0
        or target_info.st_gid != 0
        or target_info.st_mode & 0o022
    ):
        raise SystemExit(1)

    if stat.S_ISREG(target_info.st_mode):
        file_descriptor = os.open(
            target_name,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
            dir_fd=parent_descriptor,
        )
        try:
            opened = os.fstat(file_descriptor)
            if (
                identity(opened) != identity(target_info)
                or opened.st_dev != parent_device
                or mount_id(file_descriptor) != parent_mount
            ):
                raise SystemExit(1)
            current = os.stat(
                target_name,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
            if identity(current) != identity(opened):
                raise SystemExit(1)
            os.unlink(target_name, dir_fd=parent_descriptor)
        finally:
            os.close(file_descriptor)
        os.fsync(parent_descriptor)
        raise SystemExit(0)
    if not stat.S_ISDIR(target_info.st_mode):
        raise SystemExit(1)

    root_descriptor = os.open(
        target_name,
        directory_flags,
        dir_fd=parent_descriptor,
    )
    try:
        root_info = os.fstat(root_descriptor)
        if identity(root_info) != identity(target_info):
            raise SystemExit(1)
        if (
            root_info.st_dev != parent_device
            or mount_id(root_descriptor) != parent_mount
        ):
            raise SystemExit(1)
        root_device = root_info.st_dev
        root_mount = mount_id(root_descriptor)

        def remove_directory_contents(descriptor):
            directory_info = os.fstat(descriptor)
            if (
                not stat.S_ISDIR(directory_info.st_mode)
                or directory_info.st_dev != root_device
                or mount_id(descriptor) != root_mount
            ):
                raise SystemExit(1)
            for name in os.listdir(descriptor):
                entry = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISDIR(entry.st_mode):
                    child = os.open(name, directory_flags, dir_fd=descriptor)
                    try:
                        opened = os.fstat(child)
                        if (
                            identity(opened) != identity(entry)
                            or opened.st_dev != root_device
                            or mount_id(child) != root_mount
                        ):
                            raise SystemExit(1)
                        remove_directory_contents(child)
                        current = os.stat(
                            name,
                            dir_fd=descriptor,
                            follow_symlinks=False,
                        )
                        if identity(current) != identity(opened):
                            raise SystemExit(1)
                    finally:
                        os.close(child)
                    os.rmdir(name, dir_fd=descriptor)
                elif stat.S_ISREG(entry.st_mode) or stat.S_ISLNK(entry.st_mode):
                    os.unlink(name, dir_fd=descriptor)
                else:
                    raise SystemExit(1)
            os.fsync(descriptor)

        remove_directory_contents(root_descriptor)
        current_target = os.stat(
            target_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if identity(current_target) != identity(root_info):
            raise SystemExit(1)
    finally:
        os.close(root_descriptor)
    os.rmdir(target_name, dir_fd=parent_descriptor)
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)
PY
}

safe_remove_created_ancestor() {
  local target="$1"
  ensure_safe_parent_directory "${target}" directory false || return 1
  if [[ ! -e "${target}" && ! -L "${target}" ]]; then
    return 0
  fi
  [[ -d "${target}" && ! -L "${target}" ]] || return 1
  rmdir -- "${target}" || return 1
  fsync_directory "$(dirname -- "${target}")"
}

rollback_transaction() {
  log "Rolling the interrupted restore back to its pre-restore snapshot"
  quiesce_recovery_mutators || return 1
  settle_restore_database_exclusion || return 1
  assert_restore_database_exclusion || return 1
  assert_host_restore_target_mounts_clear || return 1
  if [[ -s "${TRANSACTION_DIR}/rollback/database.dump" ]]; then
    run_pg_restore_secure "${TRANSACTION_DIR}/rollback/database.dump" rollback \
      || return 1
  fi
  local target kind snapshot
  if [[ -f "${TRANSACTION_DIR}/rollback/roots.tsv" \
    && ! -L "${TRANSACTION_DIR}/rollback/roots.tsv" \
    && "$(stat -c '%u:%g:%a:%h' "${TRANSACTION_DIR}/rollback/roots.tsv")" == "0:0:600:1" ]]; then
    while IFS=$'\t' read -r target kind snapshot; do
      [[ -n "${target}" ]] || continue
      case "${kind}" in
        absent)
          safe_remove_target "${target}" || return 1
          ;;
        absent-ancestor)
          safe_remove_created_ancestor "${target}" || return 1
          ;;
        directory|file)
          safe_remove_target "${target}" || return 1
          [[ -s "${snapshot}" && -f "${snapshot}" && ! -L "${snapshot}" ]] || return 1
          ensure_safe_parent_directory "${target}" "${kind}" || return 1
          tar --acls --xattrs --xattrs-include='*' --selinux \
            --same-owner -xzpf "${snapshot}" \
            -C "$(dirname -- "${target}")" || return 1
          tar --acls --xattrs --xattrs-include='*' --selinux \
            --compare -zpf "${snapshot}" \
            -C "$(dirname -- "${target}")" >/dev/null || return 1
          ensure_safe_parent_directory "${target}" "${kind}" || return 1
          sync_tree "${target}" || return 1
          ;;
        *) return 1 ;;
      esac
    done < "${TRANSACTION_DIR}/rollback/roots.tsv"
  fi
  local phase
  phase="$(journal_field phase)" || return 1
  advance_phase "${phase}" rollback_complete || return 1
  advance_phase rollback_complete rollback_exclusion_release_pending || return 1
  release_restore_database_exclusion || return 1
  advance_phase rollback_exclusion_release_pending \
    rollback_exclusion_released || return 1
  finish_recovered_service_state
}

cleanup_transaction() {
  local phase
  phase="$(journal_field phase)" || return 1
  if [[ "${phase}" != "cleanup_pending" ]]; then
    if [[ -f "${ADMISSION_FILE}" && ! -L "${ADMISSION_FILE}" \
      && -f "${RECOVERY_LAUNCHER}" && ! -L "${RECOVERY_LAUNCHER}" ]]; then
      assert_sealed_recovery_authority \
        && assert_restore_runtime_bindings \
        || return 1
    fi
    # cleanup_pending is the durable authority handoff. Before this phase the
    # transaction runtime is complete and hash-bound (when it was published);
    # after it, teardown is monotonic and must tolerate any partial deletion.
    advance_phase "${phase}" cleanup_pending || return 1
  fi
  if [[ -e "${TRANSACTION_DIR}" || -L "${TRANSACTION_DIR}" ]]; then
    [[ "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ \
      && "${TRANSACTION_DIR}" == "${TRANSACTIONS_ROOT}/${TRANSACTION_ID}" \
      && -d "${TRANSACTION_DIR}" && ! -L "${TRANSACTION_DIR}" \
      && "$(stat -c '%u:%g' "${TRANSACTION_DIR}")" == "0:0" ]] || return 1
    rm -rf --one-file-system -- "${TRANSACTION_DIR}" || return 1
    fsync_directory "${TRANSACTIONS_ROOT}" || return 1
  fi
  local recovery_path
  for recovery_path in \
    "${STATE_ROOT}/.recover-current-${TRANSACTION_ID}" \
    "${RECOVERY_LAUNCHER}"; do
    if [[ -e "${recovery_path}" || -L "${recovery_path}" ]]; then
      durably_unlink_owned_file "${recovery_path}" "${STATE_ROOT}" || return 1
    fi
  done
  local unit directory target
  for unit in "${RESTORE_UNITS[@]}"; do
    directory="${SYSTEMD_ROOT}/${unit}.d"
    target="${directory}/${BOOT_FENCE_NAME}"
    [[ ! -e "${target}" && ! -L "${target}" ]] || return 1
  done
  # Final commit point: no rollback state or fence is removed after this
  # durable unlink. A surviving journal always remains sufficient to retry.
  durably_unlink_owned_file "${ACTIVE_JOURNAL}" "${STATE_ROOT}" || return 1
}

verify_restored_service_health() {
  local state_file="${TRANSACTION_DIR}/service-state.json"
  [[ -f "${state_file}" && ! -L "${state_file}" ]] || return 0
  if python3 - "${state_file}" <<'PY'
import json
import sys
document = json.load(open(sys.argv[1], "r", encoding="utf-8"))
raise SystemExit(
    0
    if document.get("schema") == "bridgesllm.restore-service-state.v2"
    and document.get("units", {}).get(
        "bridgesllm-product.service", {}
    ).get("activeState") == "active"
    else 1
)
PY
  then
    local waited status="" expected_version
    expected_version="$(portal_version)" || return 1
    for waited in $(seq 1 60); do
      status="$("${RESTORE_CURL_BIN}" -fsS --max-time 5 \
        http://127.0.0.1:4001/health 2>/dev/null || true)"
      if [[ -n "${status}" ]] \
        && printf '%s' "${status}" | python3 -c '
import json, sys
document = json.load(sys.stdin)
raise SystemExit(
    0 if document.get("status") == "ok" and document.get("version") == sys.argv[1] else 1
)
' "${expected_version}"; then
        return 0
      fi
      sleep 1
    done
    return 1
  fi
}

verify_final_restored_state() {
  local state_file="${TRANSACTION_DIR}/service-state.json"
  [[ -f "${state_file}" && ! -L "${state_file}" ]] || return 0
  python3 - "${state_file}" "${RESTORE_SYSTEMCTL_BIN}" "${RESTORE_DOCKER_BIN}" \
    "${RESTORE_UNITS[@]}" <<'PY'
import json
import re
import subprocess
import sys

state_path, systemctl, docker, *unit_names = sys.argv[1:]
document = json.load(open(state_path, "r", encoding="utf-8"))
units = document.get("units")
if (
    document.get("schema") != "bridgesllm.restore-service-state.v2"
    or not isinstance(units, dict)
    or set(units) != set(unit_names)
):
    raise SystemExit(1)

def run(arguments):
    result = subprocess.run(
        arguments,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    return result.stdout.strip()

for unit in unit_names:
    expected = units.get(unit)
    if not isinstance(expected, dict):
        raise SystemExit(1)
    actual = (
        run([systemctl, "show", "--property=LoadState", "--value", unit]),
        run([systemctl, "show", "--property=ActiveState", "--value", unit]),
    )
    if actual != (expected.get("loadState"), expected.get("activeState")):
        raise RuntimeError("systemd state drifted during Portal readiness")

records = [(entry, True) for entry in document.get("projectContainers", [])]
stalwart = document.get("stalwartContainer")
if stalwart is not None:
    records.append((stalwart, False))
seen = set()
for record, project in records:
    identifier = record.get("id") if isinstance(record, dict) else None
    if (
        not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or identifier in seen
    ):
        raise RuntimeError("recorded Docker state is invalid")
    seen.add(identifier)
    payload = json.loads(run([docker, "container", "inspect", identifier]))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("Docker identity is ambiguous")
    container = payload[0]
    labels = ((container.get("Config") or {}).get("Labels") or {})
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    if (
        container.get("Id") != identifier
        or str(container.get("Name") or "").lstrip("/") != record.get("name")
        or bool((container.get("State") or {}).get("Running"))
            != record.get("wasRunning")
        or policy.get("Name") != (record.get("restartPolicy") or {}).get("name")
        or policy.get("MaximumRetryCount")
            != (record.get("restartPolicy") or {}).get("maximumRetryCount")
        or (
            project
            and {
                key: labels.get(key)
                for key in (record.get("claims") or {})
            } != record.get("claims")
        )
    ):
        raise RuntimeError("Docker state drifted during Portal readiness")
PY
}

finish_recovered_service_state() {
  local phase
  phase="$(journal_field phase)" || return 1
  if [[ "${phase}" != "preparing" ]]; then
    [[ -f "${ADMISSION_FILE}" && ! -L "${ADMISSION_FILE}" ]] || return 1
    assert_host_restore_target_mounts_clear || return 1
  fi
  release_restore_database_exclusion || return 1
  remove_boot_fences || return 1
  restore_service_state || return 1
  verify_restored_service_health || return 1
  verify_final_restored_state || return 1
  cleanup_transaction
}

finish_committed_transaction() {
  quiesce_recovery_mutators || return 1
  local phase
  phase="$(journal_field phase)" || return 1
  if [[ "${phase}" == "committed" ]]; then
    settle_restore_database_exclusion || return 1
    assert_restore_database_exclusion || return 1
    advance_phase committed committed_exclusion_release_pending || return 1
    phase="committed_exclusion_release_pending"
  fi
  if [[ "${phase}" == "committed_exclusion_release_pending" ]]; then
    release_restore_database_exclusion || return 1
    advance_phase committed_exclusion_release_pending \
      committed_exclusion_released || return 1
  elif [[ "${phase}" != "committed_exclusion_released" ]]; then
    return 1
  fi
  finish_recovered_service_state
}

recover_transaction() {
  assert_crash_persistent_control_filesystems || return 1
  [[ -f "${ACTIVE_JOURNAL}" && ! -L "${ACTIVE_JOURNAL}" ]] || return 0
  unset BRIDGESLLM_RESTORE_OPERATION_NONCE
  unset BRIDGESLLM_RESTORE_PHASE_GATE_DIR
  unset BRIDGESLLM_RESTORE_PHASE_GATE
  RESTORE_PHASE_GATE_DIR=""
  RESTORE_PHASE_GATE=""
  RESTORE_PHASE_GATE_IDENTITY=""
  RESTORE_OPERATION_NONCE_SUPPLIED=false
  RESTORE_OPERATION_NONCE="$(journal_field operationNonce)" || return 1
  TRANSACTION_ID="$(journal_field transactionId)" || return 1
  TRANSACTION_DIR="$(journal_field transactionDir)" || return 1
  ARCHIVE="$(journal_field archive)" || return 1
  ADMISSION_FILE="$(journal_field admission)" || return 1
  [[ "${RESTORE_OPERATION_NONCE}" =~ ^[a-f0-9]{64}$ \
    && "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ \
    && "${TRANSACTION_DIR}" == "${TRANSACTIONS_ROOT}/${TRANSACTION_ID}" \
    && "${ADMISSION_FILE}" == "${TRANSACTION_DIR}/admission.json" ]] || return 1
  local phase
  phase="$(journal_field phase)" || return 1
  if [[ "${phase}" == "cleanup_pending" ]]; then
    remove_boot_fences || return 1
    cleanup_transaction
    return
  fi
  [[ -d "${TRANSACTION_DIR}" && ! -L "${TRANSACTION_DIR}" ]] || return 1
  reselect_recovery_postgresql_toolchain || return 1
  case "${phase}" in
    prepared|fenced|quiesced|database_exclusion_pending|database_excluded|\
    staging_pending|staged|rollback_snapshot_pending|\
    rollback_snapshot_complete|database_restore_pending|database_restored|\
    files_restore_pending|files_restored|openclaw_restore_pending|\
    openclaw_restored|stalwart_restore_pending|stalwart_restored|\
    migration_pending|migrated|verification_pending|verified|\
    rollback_complete|rollback_exclusion_release_pending|\
    rollback_exclusion_released|committed|\
    committed_exclusion_release_pending|committed_exclusion_released)
      assert_sealed_recovery_authority || return 1
      ;;
  esac
  case "${phase}" in
    prepared|fenced|quiesced|database_exclusion_pending|database_excluded|\
    staging_pending|staged|rollback_snapshot_pending|\
    rollback_snapshot_complete|database_restore_pending|database_restored|\
    files_restore_pending|files_restored|openclaw_restore_pending|\
    openclaw_restored|stalwart_restore_pending|stalwart_restored|\
    migration_pending|migrated|verification_pending|verified|\
    rollback_complete|rollback_exclusion_release_pending|\
    rollback_exclusion_released|committed|\
    committed_exclusion_release_pending|committed_exclusion_released)
      assert_host_restore_target_mounts_clear || return 1
      ;;
  esac
  case "${phase}" in
    preparing|prepared|fenced|quiesced)
      quiesce_recovery_mutators || return 1
      finish_recovered_service_state
      ;;
    database_exclusion_pending|database_excluded|staging_pending|staged|\
    rollback_snapshot_pending)
      quiesce_recovery_mutators || return 1
      release_restore_database_exclusion || return 1
      finish_recovered_service_state
      ;;
    rollback_snapshot_complete|database_restore_pending|database_restored|\
    files_restore_pending|files_restored|openclaw_restore_pending|openclaw_restored|\
    stalwart_restore_pending|stalwart_restored|migration_pending|migrated|\
    verification_pending|verified)
      rollback_transaction
      ;;
    rollback_complete|rollback_exclusion_release_pending)
      quiesce_recovery_mutators || return 1
      release_restore_database_exclusion || return 1
      if [[ "${phase}" == "rollback_complete" ]]; then
        advance_phase rollback_complete rollback_exclusion_release_pending \
          || return 1
      fi
      advance_phase rollback_exclusion_release_pending \
        rollback_exclusion_released || return 1
      finish_recovered_service_state
      ;;
    rollback_exclusion_released)
      quiesce_recovery_mutators || return 1
      finish_recovered_service_state
      ;;
    committed|committed_exclusion_release_pending|committed_exclusion_released)
      finish_committed_transaction
      ;;
    *) return 1 ;;
  esac
}

start_transaction() {
  local archive="$1"
  local sealed_digest=""
  [[ "${RESTORE_OPERATION_NONCE}" =~ ^[a-f0-9]{64}$ \
    && ( "${RESTORE_OPERATION_NONCE_SUPPLIED}" == "true" \
      || "${RESTORE_OPERATION_NONCE_SUPPLIED}" == "false" ) \
    && -z "${BRIDGESLLM_RESTORE_OPERATION_NONCE+x}" \
    && -z "${BRIDGESLLM_RESTORE_PHASE_GATE_DIR+x}" \
    && -z "${BRIDGESLLM_RESTORE_PHASE_GATE+x}" ]] \
    || die "Restore operation identity was not captured into private state"
  assert_crash_persistent_control_filesystems \
    || die "Restore journal and boot-fence filesystems must be writable and crash-persistent"
  [[ ! -e "${RECOVERY_LAUNCHER}" && ! -L "${RECOVERY_LAUNCHER}" ]] \
    || die "A stale or unsafe restore recovery launcher already exists"
  preflight_reserved_boot_fence_paths \
    || die "A reserved restore boot-fence path already exists or is unsafe"
  authenticate_archive_before_transaction "${archive}" \
    || die "Archive authentication failed before transaction start; unsigned and plaintext-SQL backups are unsupported, and cross-host restore requires the separately supplied trust key"
  TRANSACTION_ID="$(openssl rand -hex 16)"
  [[ "${TRANSACTION_ID}" =~ ^[a-f0-9]{32}$ ]] || die "Restore transaction identity failed"
  TRANSACTION_DIR="${TRANSACTIONS_ROOT}/${TRANSACTION_ID}"
  install -d -m 700 -o root -g root "${STATE_ROOT}" "${TRANSACTIONS_ROOT}" "${TRANSACTION_DIR}"
  [[ "$(stat -c '%u:%g:%a' "${STATE_ROOT}")" == "0:0:700" \
    && "$(stat -c '%u:%g:%a' "${TRANSACTIONS_ROOT}")" == "0:0:700" \
    && "$(stat -c '%u:%g:%a' "${TRANSACTION_DIR}")" == "0:0:700" ]] \
    || die "Restore transaction state directories are unsafe"
  fsync_directory "${TRANSACTION_DIR}" \
    && fsync_directory "${TRANSACTIONS_ROOT}" \
    && fsync_directory "${STATE_ROOT}" \
    && fsync_directory "$(dirname -- "${STATE_ROOT}")" \
    || die "Restore transaction directory was not committed durably"
  ARCHIVE="${TRANSACTION_DIR}/source-archive.tar.gz"
  ADMISSION_FILE="${TRANSACTION_DIR}/admission.json"
  if ! write_journal preparing; then
    if [[ -f "${ACTIVE_JOURNAL}" && ! -L "${ACTIVE_JOURNAL}" ]]; then
      RECOVERY_ACTIVE=true
      die "Restore preparation journal was published but not committed durably; recovery is required"
    fi
    discard_unjournaled_transaction \
      || die "Restore preparation journal failed and its empty transaction could not be cleaned"
    die "Restore preparation journal could not be published"
  fi
  RECOVERY_ACTIVE=true
  seal_database_authority_environment \
    || die "Installed database authority could not be sealed durably"
  sealed_digest="$(seal_restore_archive "${archive}")" \
    || die "Restore source archive could not be sealed into the root-only transaction"
  [[ "${sealed_digest}" =~ ^[a-f0-9]{64}$ ]] \
    || die "Sealed restore archive digest is invalid"
  verify_archive "${ARCHIVE}"
  bind_sealed_archive_to_preparing_journal \
    || die "Sealed restore archive could not be bound to its durable journal"
  assert_source_database_identity_matches_target \
    || die "Archive PostgreSQL encoding, locale, provider, or collation identity differs from the target"
  seal_restore_mount_authority \
    || die "Restore target mount authority could not be sealed durably"
  assert_host_restore_target_mounts_clear \
    || die "A host mount exists at or below a restore target"
  seal_recovery_authority \
    || die "Transaction-bound restore recovery authority could not be sealed durably"
  assert_restore_runtime_bindings \
    || die "Restore runtime paths do not match the admitted Portal targets"
  assert_disk_admission || die "Restore disk admission failed before downtime"
  extract_archive
  select_validation_postgresql_server_toolchain \
    || die "A matching trusted PostgreSQL validation server runtime is unavailable"
  capture_restore_validation_database_authority \
    || die "Disposable validation cluster authority could not be sealed"
  capture_database_contract_sql \
    || die "Installed database ownership contract could not be sealed before validation"
  run_migrations
  verify_candidate
  write_journal prepared \
    || die "Restore admission journal could not be committed durably"
  wait_for_restore_phase_gate prepared \
    || die "Restore cooperative phase gate rejected its release receipt"

  quiesce_sources capture
  assert_crash_persistent_control_filesystems \
    || die "Restore journal or boot-fence filesystem changed before fencing"
  prepare_boot_fence_plan \
    || die "Restore boot-fence ownership plan could not be committed durably"
  install_boot_fences
  advance_phase prepared fenced
  quiesce_sources stop
  advance_phase fenced quiesced
  prove_boot_fences_effective \
    || die "Systemd boot fences are not effective after drop-in merging"

  advance_phase quiesced database_exclusion_pending
  acquire_restore_database_exclusion \
    || die "PostgreSQL exclusivity could not be acquired durably"
  advance_phase database_exclusion_pending database_excluded

  advance_phase database_excluded staging_pending
  advance_phase staging_pending staged

  advance_phase staged rollback_snapshot_pending
  assert_host_restore_target_mounts_clear \
    || die "Host mount topology changed before rollback snapshot"
  snapshot_rollback
  assert_restore_runtime_bindings \
    || die "Restore authority or runtime paths changed before mutation"
  assert_disk_admission post-snapshot \
    || die "Restore disk admission failed after the durable rollback snapshot"
  advance_phase rollback_snapshot_pending rollback_snapshot_complete
  MUTATION_STARTED=true

  advance_phase rollback_snapshot_complete database_restore_pending
  assert_source_database_identity_matches_target \
    || die "Target PostgreSQL identity changed after exclusion and before mutation"
  run_pg_restore_secure "${TRANSACTION_DIR}/stage/database.dump" \
    || die "Database restore failed"
  advance_phase database_restore_pending database_restored

  advance_phase database_restored files_restore_pending
  restore_component_set files
  restore_environment_file
  advance_phase files_restore_pending files_restored

  advance_phase files_restored openclaw_restore_pending
  restore_component_set openclaw
  advance_phase openclaw_restore_pending openclaw_restored

  advance_phase openclaw_restored stalwart_restore_pending
  restore_component_set stalwart
  advance_phase stalwart_restore_pending stalwart_restored

  advance_phase stalwart_restored migration_pending
  advance_phase migration_pending migrated

  advance_phase migrated verification_pending
  assert_host_restore_target_mounts_clear \
    || die "Host mount topology changed before restored Portal verification"
  advance_phase verification_pending verified

  assert_restore_database_exclusion \
    || die "PostgreSQL exclusivity changed before restore commit"
  advance_phase verified committed
  finish_committed_transaction \
    || die "Restore committed but canonical service state did not finish; rerun --recover"
  RECOVERY_ACTIVE=false
  log "Offline restore completed and the restored Portal passed migrations and health verification"
}

on_exit() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [[ "${status}" -ne 0 && "${RECOVERY_ACTIVE}" == "true" \
    && -f "${ACTIVE_JOURNAL}" && ! -L "${ACTIVE_JOURNAL}" ]]; then
    log "Restore failed; applying the durable recovery policy"
    if ! recover_transaction; then
      log "ERROR: automatic recovery did not converge; Portal remains boot-fenced and the root-only journal was preserved" >&2
    fi
  fi
  exit "${status}"
}

usage() {
  cat <<'EOF'
Usage:
  restore-full.sh --verify-archive /absolute/portal-comprehensive-....tar.gz
  restore-full.sh --restore /absolute/portal-comprehensive-....tar.gz
  restore-full.sh --recover

Restore is root-only and offline. It accepts only an exact-version,
service-and-database-quiesced comprehensive archive whose profile, environment,
database authority, source roots, checksums, and nested members match this
installation.

An interruption controller may bind --restore to an exact operation and durable
phase by supplying BRIDGESLLM_RESTORE_OPERATION_NONCE (64 lowercase hex),
BRIDGESLLM_RESTORE_PHASE_GATE_DIR, and BRIDGESLLM_RESTORE_PHASE_GATE together
through a root-only environment. The gate directory must be root-owned mode
0700 and contain only a root-owned mode 0600 binding.json for that nonce and
phase. Ordinary restores omit all three variables. Recovery always derives the
operation nonce from the root-only journal and accepts none of these variables.
EOF
}

main() {
  require_root
  [[ $# -ge 1 ]] || { usage >&2; exit 2; }
  case "$1" in
    --restore|--recover) ;;
    *)
      if [[ -n "${BRIDGESLLM_RESTORE_OPERATION_NONCE+x}" \
        || -n "${BRIDGESLLM_RESTORE_PHASE_GATE_DIR+x}" \
        || -n "${BRIDGESLLM_RESTORE_PHASE_GATE+x}" ]]; then
        unset BRIDGESLLM_RESTORE_OPERATION_NONCE
        unset BRIDGESLLM_RESTORE_PHASE_GATE_DIR
        unset BRIDGESLLM_RESTORE_PHASE_GATE
        die "Restore operation identity is accepted only by --restore"
      fi
      ;;
  esac
  case "$1" in
    --restore|--recover)
      enter_private_mount_namespace "$@" \
        || die "A private restore mount namespace could not be established"
      ;;
  esac
  case "$1" in
    --verify-archive)
      [[ $# -eq 2 && "$2" == /* ]] || { usage >&2; exit 2; }
      verify_archive "$2"
      log "Archive passed exact restore admission: $2"
      ;;
    --recover)
      [[ $# -eq 1 ]] || { usage >&2; exit 2; }
      acquire_operation_lock
      local had_restore_journal=false
      if [[ -e "${ACTIVE_JOURNAL}" || -L "${ACTIVE_JOURNAL}" ]]; then
        had_restore_journal=true
        recover_transaction || die "Interrupted restore recovery did not converge"
      fi
      assert_no_foreign_restore_transactions
      [[ "${had_restore_journal}" == "true" ]] \
        || die "No interrupted restore transaction exists"
      log "Interrupted restore transaction recovered"
      ;;
    --restore)
      [[ $# -eq 2 && "$2" == /* ]] || { usage >&2; exit 2; }
      acquire_operation_lock
      if [[ -e "${ACTIVE_JOURNAL}" || -L "${ACTIVE_JOURNAL}" ]]; then
        if [[ "${RESTORE_OPERATION_NONCE_SUPPLIED}" == "true" ]]; then
          local active_operation_nonce
          active_operation_nonce="$(journal_field operationNonce)" \
            || die "Existing restore journal is invalid"
          [[ "${active_operation_nonce}" == "${RESTORE_OPERATION_NONCE}" ]] \
            || die "Existing restore operation nonce differs from this restore request"
        fi
        recover_transaction || die "Existing interrupted restore did not converge"
        assert_no_foreign_restore_transactions
        log "Recovered the prior restore transaction. Run --restore again to begin a new one."
        exit 0
      fi
      assert_no_foreign_restore_transactions
      trap on_exit EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      start_transaction "$2"
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

# Validators source this file to unit-test its functions without executing a
# restore; anything else always dispatches through main.
if [[ -z "${BRIDGESLLM_RESTORE_SOURCE_ONLY:-}" ]]; then
  main "$@"
fi
