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
#   backup-full.sh --verify-archive /absolute/path/to/archive.tar.gz

set -euo pipefail
umask 077

PORTAL_DIR="${PORTAL_ROOT:-/opt/bridgesllm/portal}"
PORTAL_ENV_FILE="${PORTAL_DIR}/backend/.env.production"
BACKUP_CONFIG_ENV_FILE=""

read_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  python3 - "$file" "$key" <<'PY'
import re
import stat
import os
import sys

path, requested = sys.argv[1:]
info = os.lstat(path)
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0 or info.st_nlink != 1
        or info.st_mode & 0o022 or info.st_size <= 0
        or info.st_size > 1024 * 1024):
    raise SystemExit(1)
try:
    text = open(path, "r", encoding="utf-8").read()
except (OSError, UnicodeError):
    raise SystemExit(1)
if "\x00" in text or "\r" in text:
    raise SystemExit(1)
assignment = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
values = {}
for line_number, raw in enumerate(text.split("\n"), start=1):
    if not raw or raw.lstrip().startswith(("#", ";")):
        continue
    match = assignment.fullmatch(raw)
    if match is None:
        raise SystemExit(f"unsupported environment syntax on line {line_number}")
    name, value = match.groups()
    if name in values:
        raise SystemExit(f"duplicate environment authority: {name}")
    if "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SystemExit(f"unsupported environment value on line {line_number}")
    if value[:1] in {"'", '"'}:
        quote = value[0]
        if len(value) < 2 or value[-1] != quote or quote in value[1:-1]:
            raise SystemExit(f"unsupported quoted value on line {line_number}")
        value = value[1:-1]
    elif any(char in value for char in "\"'") or value != value.strip(" \t"):
        raise SystemExit(f"unsupported unquoted value on line {line_number}")
    values[name] = value
if requested in values:
    print(values[requested])
PY
}

assert_env_file_unambiguous() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  read_env_value "$file" "__BRIDGESLLM_VALIDATE_ONLY__" >/dev/null
}

configured_path() {
  local explicit_value="$1"
  local env_key="$2"
  local fallback="$3"
  if [[ -n "$explicit_value" ]]; then
    printf '%s\n' "$explicit_value"
    return
  fi
  local configured_value=""
  local authority_file="${BACKUP_CONFIG_ENV_FILE:-$PORTAL_ENV_FILE}"
  configured_value="$(read_env_value "$authority_file" "$env_key" 2>/dev/null || true)"
  printf '%s\n' "${configured_value:-$fallback}"
}

BACKUP_CONFIG_FILE="${BACKUP_CONFIG_FILE:-${PORTAL_DIR}/backend/.data/backups/backup-base-path}"
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-${PORTAL_DIR}/backend/.data/backups}"
BACKUP_RECOVERY_STATE_DIR="${BRIDGESLLM_BACKUP_RECOVERY_STATE_DIR:-/var/lib/bridgesllm/backup-recovery}"
BACKUP_TRUST_ROOT="${BRIDGESLLM_BACKUP_TRUST_ROOT:-/var/lib/bridgesllm/backup-trust}"
BACKUP_HMAC_KEY="${BACKUP_TRUST_ROOT}/archive-hmac.key"
RESTORE_STATE_ROOT="${BRIDGESLLM_BACKUP_RESTORE_STATE_ROOT:-/var/lib/bridgesllm-restore}"
PENDING_RESTORE_JOURNAL="${RESTORE_STATE_ROOT}/active-restore.json"
INSTALLER_STATE_ROOT="${BRIDGESLLM_BACKUP_INSTALLER_STATE_ROOT:-/var/lib/bridgesllm-installer}"
PENDING_UPDATE_JOURNAL="${INSTALLER_STATE_ROOT}/active-update.json"
PENDING_CUTOVER_JOURNAL="${INSTALLER_STATE_ROOT}/cutover-update.json"
PENDING_UNINSTALL_JOURNAL="${INSTALLER_STATE_ROOT}/uninstall/active-uninstall.json"
BACKUP_BASE="${BACKUP_BASE:-/root/backups}"
if [[ -r "$BACKUP_CONFIG_FILE" ]]; then
  configured_backup_base=""
  IFS= read -r configured_backup_base < "$BACKUP_CONFIG_FILE" || true
  [[ -n "$configured_backup_base" ]] && BACKUP_BASE="$configured_backup_base"
fi
BACKUP_WORK_ROOT=""
INSTALL_ROOT_OVERRIDE="${INSTALL_ROOT:-}"
PORTAL_DATA_ROOT_OVERRIDE="${PORTAL_DATA_ROOT:-}"
APPS_ROOT_OVERRIDE="${APPS_ROOT:-}"
PORTAL_FILES_ROOT_OVERRIDE="${PORTAL_FILES_DIR:-${PORTAL_FILES_ROOT:-}}"
UPLOADS_ROOT_OVERRIDE="${UPLOADS_ROOT:-${UPLOAD_DIR:-}}"
PROJECTS_ROOT_OVERRIDE="${PROJECTS_ROOT:-${PORTAL_PROJECTS_ROOT:-}}"
PORTAL_ASSETS_ROOT_OVERRIDE="${PORTAL_ASSETS_DIR:-${PORTAL_ASSETS_ROOT:-}}"
STALWART_INSTALL_ROOT_OVERRIDE="${STALWART_INSTALL_DIR:-}"
INSTALL_ROOT="$(configured_path "${INSTALL_ROOT_OVERRIDE}" INSTALL_ROOT /opt/bridgesllm)"
PORTAL_DATA_ROOT="$(configured_path "${PORTAL_DATA_ROOT_OVERRIDE}" PORTAL_DATA_ROOT "$PORTAL_DIR")"
APP_FILES_DIR="$(configured_path "${APPS_ROOT_OVERRIDE}" APPS_ROOT "${INSTALL_ROOT}/apps")"
# Standalone uploaded-App source is an independent recovery domain.  Resolve it
# from the Portal environment authority, not from a process-environment
# override, so a backup cannot silently redirect this required component.
PORTAL_APP_DATA_ROOT="$(configured_path "" PORTAL_DATA_ROOT "$PORTAL_DIR")"
PORTAL_APP_SOURCES_DIR="$(
  configured_path "" PORTAL_APPS_ROOT "${PORTAL_APP_DATA_ROOT}/apps"
)"
LEGACY_APP_FILES_DIR="${LEGACY_APP_FILES_DIR:-/var/www/bridgesllm-apps}"
PORTAL_FILES_DIR="$(configured_path "${PORTAL_FILES_ROOT_OVERRIDE}" PORTAL_FILES_ROOT /var/portal-files)"
UPLOAD_FILES_DIR="$(configured_path "${UPLOADS_ROOT_OVERRIDE}" UPLOAD_DIR "${INSTALL_ROOT}/uploads")"
LEGACY_PORTAL_FILES_DIR="${LEGACY_PORTAL_FILES_DIR:-/portal/files}"
PROJECTS_DIR="$(configured_path "${PROJECTS_ROOT_OVERRIDE}" PORTAL_PROJECTS_ROOT "${PORTAL_DATA_ROOT}/projects")"
PORTAL_BACKEND_STATE_DIR="${PORTAL_BACKEND_STATE_DIR:-${PORTAL_DIR}/backend/.data}"
PORTAL_STATE_DIR="${PORTAL_STATE_DIR:-${PORTAL_DIR}/.data}"
PORTAL_ASSETS_DIR="$(configured_path "${PORTAL_ASSETS_ROOT_OVERRIDE}" PORTAL_ASSETS_ROOT "${INSTALL_ROOT}/assets")"
RUNTIME_ROOT="${RUNTIME_ROOT:-/portal}"
OPENCLAW_DIR="${OPENCLAW_DIR:-/root/.openclaw}"
STALWART_DIR="${STALWART_DIR:-/var/stalwart}"
STALWART_MAIL_DIR="${STALWART_MAIL_DIR:-/var/stalwart-mail}"
STALWART_INSTALL_DIR="${STALWART_INSTALL_ROOT_OVERRIDE:-${INSTALL_ROOT}/stalwart}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
CADDY_CONF="${CADDY_CONF:-/etc/caddy/Caddyfile}"
BACKUP_SYSTEMCTL_BIN="/usr/bin/systemctl"
BACKUP_DOCKER_BIN="/usr/bin/docker"
BACKUP_PG_DUMP_BIN="/usr/bin/pg_dump"
BACKUP_PG_RESTORE_BIN="/usr/bin/pg_restore"
BACKUP_PSQL_BIN="/usr/bin/psql"
BACKUP_CURL_BIN="/usr/bin/curl"

configure_backup_test_commands() {
  local test_root="${BRIDGESLLM_BACKUP_TEST_ROOT:-}"
  local requested_systemctl="${BRIDGESLLM_BACKUP_SYSTEMCTL_BIN:-}"
  local requested_docker="${BRIDGESLLM_BACKUP_DOCKER_BIN:-}"
  local requested_pg_dump="${BRIDGESLLM_BACKUP_PG_DUMP_BIN:-}"
  local requested_pg_restore="${BRIDGESLLM_BACKUP_PG_RESTORE_BIN:-}"
  local requested_psql="${BRIDGESLLM_BACKUP_PSQL_BIN:-}"
  local requested_curl="${BRIDGESLLM_BACKUP_CURL_BIN:-}"
  local requested_restore_state_root="${BRIDGESLLM_BACKUP_RESTORE_STATE_ROOT:-}"
  local requested_installer_state_root="${BRIDGESLLM_BACKUP_INSTALLER_STATE_ROOT:-}"
  local requested_trust_root="${BRIDGESLLM_BACKUP_TRUST_ROOT:-}"
  if [[ -z "${test_root}" ]]; then
    [[ -z "${requested_systemctl}" && -z "${requested_docker}" \
      && -z "${requested_pg_dump}" && -z "${requested_pg_restore}" \
      && -z "${requested_psql}" \
      && -z "${requested_curl}" && -z "${requested_restore_state_root}" \
      && -z "${requested_installer_state_root}" \
      && -z "${requested_trust_root}" ]] \
      || { printf 'ERROR: backup command overrides require an attested test root\n' >&2; exit 1; }
    return
  fi

  [[ ( "${test_root}" == /root/bridgesllm-installer-data-test-*/backup-fixture \
      || "${test_root}" == /root/bridgesllm-installer-data-test-*/restore-fixture \
      || "${test_root}" =~ ^/4[A-Za-z0-9]{3}$ ) \
    && "${test_root}" == "$(realpath -e -- "${test_root}" 2>/dev/null)" ]] \
    || { printf 'ERROR: backup test root is not an attested validator fixture\n' >&2; exit 1; }
  local test_tmp="${test_root}/tmp"
  if [[ ! -e "${test_tmp}" && ! -L "${test_tmp}" ]]; then
    mkdir -m 700 -- "${test_tmp}"
  fi
  [[ -d "${test_tmp}" && ! -L "${test_tmp}" \
    && "$(stat -c '%u:%g:%a' "${test_tmp}" 2>/dev/null)" == '0:0:700' ]] \
    || { printf 'ERROR: backup test temporary root is unsafe\n' >&2; exit 1; }
  for path in \
    "${PORTAL_DIR}" "${INSTALL_ROOT}" "${APP_FILES_DIR}" \
    "${PORTAL_APP_SOURCES_DIR}" "${LEGACY_APP_FILES_DIR}" \
    "${PORTAL_FILES_DIR}" "${UPLOAD_FILES_DIR}" "${LEGACY_PORTAL_FILES_DIR}" \
    "${PROJECTS_DIR}" "${PORTAL_BACKEND_STATE_DIR}" "${PORTAL_STATE_DIR}" \
    "${PORTAL_ASSETS_DIR}" "${RUNTIME_ROOT}" "${OPENCLAW_DIR}" \
    "${STALWART_DIR}" "${STALWART_MAIL_DIR}" "${STALWART_INSTALL_DIR}" \
    "${SYSTEMD_DIR}" "${CADDY_CONF}" "${BACKUP_BASE}" "${BACKUP_STATE_DIR}" \
    "${BACKUP_RECOVERY_STATE_DIR}" "${RESTORE_STATE_ROOT}" \
    "${INSTALLER_STATE_ROOT}" "${BACKUP_TRUST_ROOT}"; do
    [[ "${path}" == "$(realpath -m -- "${path}" 2>/dev/null)" \
      && ( "${path}" == "${test_root}" || "${path}" == "${test_root}/"* ) ]] \
      || { printf 'ERROR: backup test path escaped its fixture root: %s\n' "${path}" >&2; exit 1; }
  done
  for command_path in \
    "${requested_systemctl}" "${requested_docker}" "${requested_pg_dump}" \
    "${requested_pg_restore}" "${requested_psql}" "${requested_curl}"; do
    [[ -n "${command_path}" && "${command_path}" == "${test_root}/"* \
      && -f "${command_path}" && ! -L "${command_path}" && -x "${command_path}" \
      && "$(stat -c '%u:%g:%a' "${command_path}" 2>/dev/null)" == '0:0:700' ]] \
      || { printf 'ERROR: backup test command is not a sealed fixture executable\n' >&2; exit 1; }
  done
  BACKUP_SYSTEMCTL_BIN="${requested_systemctl}"
  BACKUP_DOCKER_BIN="${requested_docker}"
  BACKUP_PG_DUMP_BIN="${requested_pg_dump}"
  BACKUP_PG_RESTORE_BIN="${requested_pg_restore}"
  BACKUP_PSQL_BIN="${requested_psql}"
  BACKUP_CURL_BIN="${requested_curl}"
}

configure_backup_test_commands

resolve_backup_postgresql_client_toolchain() {
  local requested_major="${1:-}"
  python3 - "${BRIDGESLLM_BACKUP_TEST_ROOT:-}" "${requested_major}" \
    "${BACKUP_PSQL_BIN}" "${BACKUP_PG_DUMP_BIN}" \
    "${BACKUP_PG_RESTORE_BIN}" <<'PY'
import os
import pathlib
import re
import stat
import subprocess
import sys

test_root, requested_major_raw, configured_psql, configured_dump, configured_restore = (
    sys.argv[1:]
)
floors = {14: 23, 15: 18, 16: 14, 17: 10, 18: 4}
requested_major = None
if requested_major_raw:
    if not requested_major_raw.isdigit():
        raise SystemExit(1)
    requested_major = int(requested_major_raw)
    if requested_major not in floors:
        raise SystemExit(1)

def safe_parent_chain(path):
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

def safe_regular(path):
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

def attest_wrapper(path):
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

def version(path, name):
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
        for value in (configured_psql, configured_dump, configured_restore)
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

set_backup_postgresql_client_toolchain() {
  local requested_major="${1:-}" result psql_path dump_path restore_path
  local major minor extra
  result="$(resolve_backup_postgresql_client_toolchain "${requested_major}")" \
    || return 1
  IFS=$'\t' read -r psql_path dump_path restore_path major minor extra \
    <<<"${result}"
  [[ -z "${extra}" && "${major}" =~ ^(14|15|16|17|18)$ \
    && "${minor}" =~ ^[0-9]+$ ]] || return 1
  BACKUP_PSQL_BIN="${psql_path}"
  BACKUP_PG_DUMP_BIN="${dump_path}"
  BACKUP_PG_RESTORE_BIN="${restore_path}"
  BACKUP_POSTGRESQL_CLIENT_MAJOR="${major}"
  BACKUP_POSTGRESQL_CLIENT_MINOR="${minor}"
}

DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"
MONTHLY_KEEP="${MONTHLY_KEEP:-3}"
COMPREHENSIVE_KEEP="${COMPREHENSIVE_KEEP:-4}"
DEGRADED_KEEP="${DEGRADED_KEEP:-2}"

# A live backup may freeze a bounded set of members that changed while tar was
# reading the source.  The member and byte ceilings are aggregate limits for
# the entire backup run, not per-component allowances.  Exceeding either one
# leaves the affected component degraded instead of turning a busy collection
# of trees into an unbounded staging workload.
LIVE_RECONCILIATION_MAX_MEMBERS=512
LIVE_RECONCILIATION_MAX_BYTES=$((4 * 1024 * 1024 * 1024))
ARCHIVE_EVIDENCE_MAX_BYTES=$((1024 * 1024 * 1024))
ARCHIVE_XATTR_MAX_BYTES=$((16 * 1024 * 1024))
LIVE_RECONCILIATION_MAX_PASSES=3
LIVE_RECONCILIATION_MAX_METADATA_BYTES=32768
LIVE_RECONCILIATION_MAX_SECONDS=900
SQLITE_SNAPSHOT_TIMEOUT_SECONDS=300

STATUS_FILE="${BACKUP_STATE_DIR}/status.json"
OUTPUT_FILE="${BACKUP_STATE_DIR}/current.log"
LOCK_FILE="${BACKUP_STATE_DIR}/backup.lock"
BACKUP_REQUESTS_DIR="${BACKUP_STATE_DIR}/requests"
# A backup must never snapshot the Portal while the installer is replacing the
# runtime or migrating the database.  Take the same host-wide operation lock
# as install/update/uninstall before taking the backup-only lock.  Keeping this
# order (operation first, backup second) prevents a lock inversion with the
# installer, which never waits on the backup-only lock.
PORTAL_OPERATION_LOCK_FILE="${PORTAL_OPERATION_LOCK_FILE:-/run/lock/bridgesllm-portal-installer.lock}"
MAX_OUTPUT_BYTES=65536
RUN_ACTIVE=false
RUN_ID=""
RUN_TYPE=""
RUN_STARTED_AT=""
RUN_ARCHIVE_PATH=""
RUN_PHASE=""
RUN_PHASE_LABEL=""
RUN_PHASE_INDEX=""
RUN_PHASE_TOTAL=""
RUN_ERROR_DETAIL=""
RUN_FAILURE_CODE=""
RUN_DEGRADED=false
RUN_DEGRADED_COMPONENTS=()
ARCHIVE_FAILURE_DETAIL=""
ARCHIVE_LIVE_RECONCILIATION=""
ARCHIVE_CLEANUP_FAILED=false
LIVE_RECONCILIATION_MEMBERS_USED=0
LIVE_RECONCILIATION_BYTES_USED=0
ARCHIVE_DIAGNOSTICS_MAX_BYTES="${ARCHIVE_DIAGNOSTICS_MAX_BYTES:-1048576}"
RUN_CONSECUTIVE_FAILURES=0
STAGING_DIR=""
VERIFY_DIR=""
PARTIAL_ARCHIVE=""
RECOVERY_COMPONENTS_FILE=""
BACKUP_AUTHORITY_ENV_FILE=""
BACKUP_QUIESCE_ACTIVE=false
BACKUP_PORTAL_WAS_ACTIVE=false
BACKUP_OPENCLAW_WAS_ACTIVE=false
BACKUP_STALWART_UNIT_WAS_ACTIVE=false
BACKUP_STALWART_CONTAINER_WAS_RUNNING=false
BACKUP_RUNNING_PROJECT_CONTAINERS_FILE=""
QUIESCENCE_JOURNAL="${BACKUP_RECOVERY_STATE_DIR}/quiescence.json"
QUIESCENCE_BLOCKER="${BACKUP_RECOVERY_STATE_DIR}/quiescence.block"
QUIESCENCE_COMMIT="${BACKUP_RECOVERY_STATE_DIR}/quiescence.commit"
BACKUP_DATABASE_TRANSACTIONS_ROOT="${BACKUP_RECOVERY_STATE_DIR}/database-transactions"
BACKUP_CONTAINER_FENCE_HELPER="${PORTAL_DIR}/installer/backup-container-fence.py"
BACKUP_DATABASE_FENCE_MODE=""
BACKUP_LOCK_GUARD_PID=""
BACKUP_LOCK_GUARD_HOST_PID=""
BACKUP_LOCK_GUARD_STARTTIME=""
BACKUP_CAPACITY_GUARD_PID=""
BACKUP_CAPACITY_GUARD_HOST_PID=""
BACKUP_CAPACITY_GUARD_STARTTIME=""
BACKUP_CAPACITY_GUARD_PLAN=""
BACKUP_CAPACITY_GUARD_LEASES=""
BACKUP_CAPACITY_STATE=""
BACKUP_PUBLICATION_TARGETS=""
BACKUP_ARCHIVE_NAME=""
BACKUP_MAIN_HOST_PID=""
BACKUP_MAIN_HOST_STARTTIME=""
BACKUP_WORK_IMAGE_MOUNTED=false
BACKUP_WORK_IMAGE_DEVICE=""
BACKUP_WORK_IMAGE_MOUNT_ID=""
BACKUP_WORK_IMAGE_LOOP=""
BACKUP_ARCHIVE_CANDIDATE_FD=""
BACKUP_ARCHIVE_CANDIDATE_DEVICE=""
BACKUP_ARCHIVE_CANDIDATE_INODE=""
BACKUP_ARCHIVE_CANDIDATE_BOUND=""
BACKUP_SELECTED_PUBLICATION_ROLE=""
BACKUP_PUBLICATION_COMMITTED=false
RUN_REQUEST_CLAIM_PATH=""
RUN_REQUEST_CLAIM_DEV=""
RUN_REQUEST_CLAIM_INO=""
PENDING_REQUEST_PATH=""
PENDING_REQUEST_ID=""
PENDING_REQUEST_STARTED_AT=""
PENDING_REQUEST_DEV=""
PENDING_REQUEST_INO=""
BACKUP_FENCE_NAME="30-backup-quiescence-fence.conf"
BACKUP_MUTATOR_UNITS=(
  bridgesllm-product.service
  openclaw-gateway.service
  stalwart-mail.service
  stalwart-cert-sync.service
  stalwart-cert-sync.path
  stalwart-cert-sync.timer
)

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

log() {
  local line
  line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  printf '%s\n' "$line"
  if $RUN_ACTIVE; then
    printf '%s\n' "$line" >> "$OUTPUT_FILE"
    if [[ -f "$OUTPUT_FILE" ]] && (( $(stat -c '%s' "$OUTPUT_FILE" 2>/dev/null || echo 0) > MAX_OUTPUT_BYTES )); then
      tail -c "$MAX_OUTPUT_BYTES" "$OUTPUT_FILE" > "${OUTPUT_FILE}.tmp"
      chmod 600 "${OUTPUT_FILE}.tmp"
      mv -f "${OUTPUT_FILE}.tmp" "$OUTPUT_FILE"
    fi
  fi
}

sanitize_status_detail() {
  python3 -c '
import re
import sys
value = sys.stdin.read()
value = re.sub(r"(?i)(postgres(?:ql)?://[^:@/\s]+:)[^@/\s]*(@)", r"\1***\2", value)
value = re.sub(r"(?i)(password|sslpassword|passfile)=([^&\s]+)", r"\1=***", value)
value = "".join(character if ord(character) >= 32 and ord(character) != 127 else " " for character in value)
value = " ".join(value.split()) or "Backup failed without a diagnostic detail"
encoded = value.encode("utf-8")
print(encoded[:1000].decode("utf-8", errors="ignore"))
'
}

die() {
  local detail="$*"
  if $RUN_ACTIVE || [[ -n "${PENDING_REQUEST_ID:-}" ]]; then
    RUN_ERROR_DETAIL="$(printf '%s' "${detail}" | sanitize_status_detail 2>/dev/null \
      || printf '%s' 'Backup failed while sanitizing its diagnostic detail')"
    detail="${RUN_ERROR_DETAIL}"
  fi
  log "ERROR: ${detail}"
  exit 1
}

die_with_code() {
  local code="$1"
  shift
  [[ "${code}" =~ ^BACKUP_[A-Z0-9_]{1,56}$ ]] \
    || code="BACKUP_INTERNAL_FAILURE"
  RUN_FAILURE_CODE="${code}"
  die "$@"
}

capture_backup_error() {
  local exit_code="$1"
  local line_number="$2"
  if $RUN_ACTIVE && [[ -z "${RUN_ERROR_DETAIL}" ]]; then
    RUN_ERROR_DETAIL="Unexpected command failure during ${RUN_PHASE_LABEL:-backup processing} (exit ${exit_code}, line ${line_number})"
  fi
  return 0
}

fsync_regular_file() {
  local path="$1"
  python3 - "${path}" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
if not os.path.isabs(path) or os.path.normpath(path) != path:
    raise SystemExit(1)
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
flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(path, flags)
try:
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
        raise SystemExit(1)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

fsync_directory() {
  local directory="$1"
  python3 - "${directory}" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
if not os.path.isabs(path) or os.path.normpath(path) != path:
    raise SystemExit(1)
info = os.lstat(path)
if (
    not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise SystemExit(1)
flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
descriptor = os.open(path, flags)
try:
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
        raise SystemExit(1)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

prepare_secure_directory() {
  local directory="$1"
  python3 - "${directory}" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
if (
    not os.path.isabs(path)
    or os.path.normpath(path) != path
    or path == os.path.sep
    or any(ord(char) < 32 or ord(char) == 127 for char in path)
):
    raise SystemExit(1)
created = []
current = os.path.sep
for component in path.strip(os.path.sep).split(os.path.sep):
    current = os.path.join(current, component)
    if not os.path.lexists(current):
        os.mkdir(current, 0o700)
        created.append(current)
    info = os.lstat(current)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
os.chmod(path, 0o700)
for directory in reversed(created):
    descriptor = os.open(
        directory,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent = os.path.dirname(directory)
    descriptor = os.open(
        parent,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

assert_backup_crash_persistent_control_filesystems() {
  python3 - /proc/1/mountinfo /proc/1/root \
    /proc/self/mountinfo /proc/self/root \
    "${BACKUP_RECOVERY_STATE_DIR}" "${SYSTEMD_DIR}" "${BACKUP_TRUST_ROOT}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import errno
import fcntl
import os
import pathlib
import re
import stat
import struct
import sys

(
    host_mountinfo_path,
    host_root,
    self_mountinfo_path,
    self_root,
    recovery_root,
    systemd_root,
    trust_root,
    *unit_names,
) = sys.argv[1:]
if (
    not unit_names
    or len(unit_names) != len(set(unit_names))
    or any(
        not name
        or "/" in name
        or len(name.encode("utf-8")) > 255
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
        for name in unit_names
    )
):
    raise SystemExit(1)

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

FS_IOC_GETFLAGS = (
    (2 << 30)
    | (struct.calcsize("@L") << 16)
    | (ord("f") << 8)
    | 1
)
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020

def assert_mutable_control_directory(path):
    info = os.lstat(path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit(
            f"backup systemd control directory is unsafe: {path}"
        )
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
            opened.st_dev != info.st_dev
            or opened.st_ino != info.st_ino
            or stat.S_IFMT(opened.st_mode) != stat.S_IFMT(info.st_mode)
        ):
            raise SystemExit(
                "backup systemd control directory changed during inspection"
            )
        encoded = bytearray(struct.calcsize("@L"))
        try:
            fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, encoded, True)
        except OSError:
            raise SystemExit(
                f"backup systemd inode flags could not be inspected: {path}"
            )
        inode_flags = struct.unpack("@L", encoded)[0]
    finally:
        os.close(descriptor)
    if inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        raise SystemExit(
            f"backup systemd control directory blocks fence mutation: {path}"
        )

host_mounts = parse_mounts(host_mountinfo_path)
self_mounts = parse_mounts(self_mountinfo_path)
for raw_target in (recovery_root, systemd_root, trust_root):
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
            f"backup control filesystem diverged from PID1: {target}"
        )
    if host_record["fsType"].lower() in volatile_types:
        raise SystemExit(
            f"backup control filesystem is not crash-persistent: {target}"
        )
    mountpoint = pathlib.Path(host_record["mountPoint"])
    for namespace_root in (host_root, self_root):
        stats = os.statvfs(namespace_path(namespace_root, mountpoint))
        if stats.f_flag & getattr(os, "ST_RDONLY", 1):
            raise SystemExit(
                f"backup control filesystem is read-only: {target}"
            )
    for label, mounts in (
        ("PID1", host_mounts),
        ("backup namespace", self_mounts),
    ):
        for record in mounts:
            mountpoint = pathlib.Path(record["mountPoint"])
            if mountpoint != target and mountpoint.is_relative_to(target):
                raise SystemExit(
                    f"{label} mount exists below backup control root: {target}"
                )
assert_mutable_control_directory(systemd_root)
for unit_name in unit_names:
    directory = os.path.join(systemd_root, f"{unit_name}.d")
    if os.path.lexists(directory):
        assert_mutable_control_directory(directory)
PY
}

backup_archive_trust_key() {
  local mode="$1"
  [[ "${mode}" == "create" || "${mode}" == "attest" ]] || return 1
  python3 - "${mode}" "${BACKUP_TRUST_ROOT}" "${BACKUP_HMAC_KEY}" \
    "${BACKUP_BASE}" "${PORTAL_DIR}" "${APP_FILES_DIR}" \
    "${PORTAL_APP_SOURCES_DIR}" \
    "${LEGACY_APP_FILES_DIR}" "${PORTAL_FILES_DIR}" "${UPLOAD_FILES_DIR}" \
    "${LEGACY_PORTAL_FILES_DIR}" "${PROJECTS_DIR}" \
    "${PORTAL_BACKEND_STATE_DIR}" "${PORTAL_STATE_DIR}" \
    "${PORTAL_ASSETS_DIR}" "${RUNTIME_ROOT}" "${OPENCLAW_DIR}" \
    "${STALWART_DIR}" "${STALWART_MAIL_DIR}" "${STALWART_INSTALL_DIR}" \
    "${SYSTEMD_DIR}" "${BACKUP_STATE_DIR}" "${BACKUP_RECOVERY_STATE_DIR}" \
    "${RESTORE_STATE_ROOT}" "${INSTALLER_STATE_ROOT}" <<'PY'
import fcntl
import os
import pathlib
import secrets
import stat
import struct
import sys

mode, raw_root, raw_key, *protected_raw = sys.argv[1:]
root = pathlib.Path(raw_root)
key = pathlib.Path(raw_key)
if (
    mode not in {"create", "attest"}
    or not root.is_absolute()
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
    current_path = pathlib.Path("/")
    parts = root.parts[1:]
    for index, component in enumerate(parts):
        final = index == len(parts) - 1
        try:
            child_fd = os.open(component, directory_flags, dir_fd=current_fd)
        except FileNotFoundError:
            if not final or mode != "create":
                raise SystemExit(1)
            os.mkdir(component, 0o700, dir_fd=current_fd)
            os.fsync(current_fd)
            child_fd = os.open(component, directory_flags, dir_fd=current_fd)
        info = os.fstat(child_fd)
        expected_mode = 0o700 if final else None
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
            or (expected_mode is not None and stat.S_IMODE(info.st_mode) != expected_mode)
        ):
            os.close(child_fd)
            raise SystemExit(1)
        os.close(current_fd)
        current_fd = child_fd
        current_path /= component
    if current_path != root:
        raise SystemExit(1)
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
    value = struct.unpack("@L", encoded)[0]
    if value & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        raise SystemExit(1)

try:
    mutable_flags(trust_fd)
    key_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        key_fd = os.open("archive-hmac.key", key_flags, dir_fd=trust_fd)
    except FileNotFoundError:
        if mode != "create":
            raise SystemExit(1)
        temporary = f".archive-hmac.key.{os.getpid()}.{secrets.token_hex(8)}"
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=trust_fd,
        )
        try:
            payload = os.urandom(32)
            if len(payload) != 32 or os.write(temporary_fd, payload) != 32:
                raise SystemExit(1)
            os.fsync(temporary_fd)
        finally:
            os.close(temporary_fd)
        try:
            os.link(
                temporary,
                "archive-hmac.key",
                src_dir_fd=trust_fd,
                dst_dir_fd=trust_fd,
                follow_symlinks=False,
            )
            os.fsync(trust_fd)
        except FileExistsError:
            pass
        finally:
            os.unlink(temporary, dir_fd=trust_fd)
            os.fsync(trust_fd)
        key_fd = os.open("archive-hmac.key", key_flags, dir_fd=trust_fd)
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
        os.fsync(key_fd)
    finally:
        os.close(key_fd)
    os.fsync(trust_fd)
finally:
    os.close(trust_fd)
PY
}

prepare_backup_archive_trust() {
  assert_backup_crash_persistent_control_filesystems \
    && backup_archive_trust_key create
}

assert_backup_archive_trust() {
  assert_backup_crash_persistent_control_filesystems \
    && backup_archive_trust_key attest
}

prepare_portal_operation_lock() {
  local lock_path="$1"
  python3 - "${lock_path}" <<'PY'
import errno
import os
import stat
import sys

path = sys.argv[1]
if not os.path.isabs(path) or path != os.path.normpath(path):
    raise SystemExit("Portal operation lock path must be canonical and absolute")
if os.geteuid() != 0:
    raise SystemExit("Portal operation lock must be acquired by root")

parent = os.path.dirname(path)
current = os.path.sep
for component in parent.strip(os.path.sep).split(os.path.sep):
    if not component:
        continue
    current = os.path.join(current, component)
    info = os.lstat(current)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
        raise SystemExit("Portal operation lock directory boundary is unsafe")
    if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
        raise SystemExit("Portal operation lock directory is writable without sticky-bit protection")

flags = os.O_RDWR
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW

try:
    fd = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    fd = os.open(path, flags)
except OSError as error:
    if error.errno != errno.EEXIST:
        raise
    fd = os.open(path, flags)

try:
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or info.st_nlink != 1 or info.st_size != 0 or info.st_mode & 0o022):
        raise SystemExit("Portal operation lock inode is unsafe")
    os.fchmod(fd, 0o600)
    os.fsync(fd)
    info = os.fstat(fd)
    print(f"{info.st_dev}:{info.st_ino}:{info.st_uid}:{info.st_gid}:{stat.S_IMODE(info.st_mode):o}:{info.st_nlink}:{info.st_size}")
finally:
    os.close(fd)
PY
}

validate_backup_base() {
  python3 - "$BACKUP_BASE" "$PORTAL_DIR" "$APP_FILES_DIR" \
    "$PORTAL_APP_SOURCES_DIR" "$LEGACY_APP_FILES_DIR" \
    "$PORTAL_FILES_DIR" "$UPLOAD_FILES_DIR" "$LEGACY_PORTAL_FILES_DIR" "$PROJECTS_DIR" \
    "$PORTAL_BACKEND_STATE_DIR" "$PORTAL_STATE_DIR" "$PORTAL_ASSETS_DIR" \
    "$RUNTIME_ROOT" "$OPENCLAW_DIR" "$STALWART_DIR" "$STALWART_MAIL_DIR" \
    "$STALWART_INSTALL_DIR" "$SYSTEMD_DIR" "$CADDY_CONF" <<'PY'
import os
import stat
import sys

raw, portal_root, *live_paths = sys.argv[1:]
if not raw or any(ord(char) < 32 or ord(char) == 127 for char in raw) or len(raw.encode("utf-8")) > 1024 or not os.path.isabs(raw):
    raise SystemExit("Backup path must be a bounded absolute path")

root = os.path.abspath(raw)
broad = {"/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var"}
if root in broad:
    raise SystemExit("Backup path must be a dedicated subdirectory")

protected = [
    portal_root,
    *live_paths,
    "/portal",
    "/opt/bridgesllm/apps",
    "/var/www/bridgesllm-apps",
    "/var/portal-files",
    "/root/.openclaw",
    "/var/stalwart",
    "/var/stalwart-mail",
    "/etc/caddy",
]
for item in protected:
    item = os.path.abspath(item)
    if root == item or root.startswith(item + os.sep) or item.startswith(root + os.sep):
        raise SystemExit("Backup path cannot overlap live Portal/app/OpenClaw/mail/configuration data")

expected_uid = os.getuid()
created = []
current = os.path.sep
for segment in root.strip(os.path.sep).split(os.path.sep):
    current = os.path.join(current, segment)
    if not os.path.lexists(current):
        os.mkdir(current, mode=0o700)
        created.append(current)
    info = os.lstat(current)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SystemExit("Backup path contains a symlink or non-directory component")
    if info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit("Backup path must be owner-controlled and not group/world writable")

for name in ("daily", "weekly", "monthly", "comprehensive", "logs", "degraded"):
    child = os.path.join(root, name)
    if not os.path.lexists(child):
        os.mkdir(child, mode=0o700)
        created.append(child)
    info = os.lstat(child)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit("Backup subdirectory is not securely owned")

degraded = os.path.join(root, "degraded")
for name in ("daily", "weekly", "monthly", "comprehensive"):
    child = os.path.join(degraded, name)
    if not os.path.lexists(child):
        os.mkdir(child, mode=0o700)
        created.append(child)
    info = os.lstat(child)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit("Degraded backup subdirectory is not securely owned")

def fsync_directory(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

for directory in reversed(created):
    fsync_directory(directory)
    fsync_directory(os.path.dirname(directory))

print(root)
PY
}

assert_portal_app_sources_root() {
  python3 - "${PORTAL_APP_SOURCES_DIR}" "${PORTAL_DIR}" "${RUNTIME_ROOT}" \
    "${APP_FILES_DIR}" "${LEGACY_APP_FILES_DIR}" \
    "${PORTAL_FILES_DIR}" "${LEGACY_PORTAL_FILES_DIR}" "${UPLOAD_FILES_DIR}" \
    "${PROJECTS_DIR}" "${PORTAL_BACKEND_STATE_DIR}" "${PORTAL_STATE_DIR}" \
    "${PORTAL_ASSETS_DIR}" "${OPENCLAW_DIR}" "${STALWART_DIR}" \
    "${STALWART_MAIL_DIR}" "${STALWART_INSTALL_DIR}" <<'PY'
import os
import pathlib
import stat
import sys

raw_root, raw_portal, raw_runtime, *raw_protected = sys.argv[1:]
root = pathlib.Path(raw_root)
portal = pathlib.Path(raw_portal)
runtime = pathlib.Path(raw_runtime)
broad = {
    pathlib.Path(value)
    for value in (
        "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib",
        "/lib64", "/media", "/mnt", "/opt", "/proc", "/root", "/run",
        "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var",
    )
}

def canonical(path, raw):
    return (
        path.is_absolute()
        and os.path.normpath(raw) == raw
        and os.path.realpath(path) == raw
        and len(raw.encode("utf-8")) <= 4096
        and not any(ord(character) < 32 or ord(character) == 127 for character in raw)
    )

def overlaps(left, right):
    return (
        left == right
        or left.is_relative_to(right)
        or right.is_relative_to(left)
    )

if not canonical(root, raw_root) or root in broad:
    raise SystemExit("standalone App source root is not canonical and bounded")
info = os.lstat(root)
if (
    not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
):
    raise SystemExit("standalone App source root is not root-owned and write-safe")
current = pathlib.Path("/")
for part in root.parts[1:]:
    current /= part
    ancestor = os.lstat(current)
    if (
        not stat.S_ISDIR(ancestor.st_mode)
        or stat.S_ISLNK(ancestor.st_mode)
        or ancestor.st_uid != 0
        or ancestor.st_gid != 0
        or ancestor.st_mode & 0o022
    ):
        raise SystemExit("standalone App source root crosses an unsafe boundary")

# The two historical product bindings are deliberate nested recovery domains.
# Any other overlap would duplicate or delete data through a broader component.
if overlaps(root, portal) and root != portal / "apps":
    raise SystemExit("standalone App source root overlaps the Portal runtime")
if overlaps(root, runtime) and root != runtime / "apps":
    raise SystemExit("standalone App source root overlaps the legacy Portal runtime")
for raw in raw_protected:
    path = pathlib.Path(raw)
    if overlaps(root, path):
        raise SystemExit("standalone App source root overlaps another recovery domain")
PY
}

write_status() {
  local status="$1"
  local completed_at="${2:-}"
  local exit_code="${3:-}"
  local error_message="${4:-}"
  local write_mode="${5:-owned}"
  local status_host_pid="${BACKUP_MAIN_HOST_PID:-}"
  if [[ -z "${status_host_pid}" ]]; then
    local status_namespace_pid="${BASHPID}"
    status_host_pid="$(backup_self_host_pid "${status_namespace_pid}")" \
      || return 1
  fi
  STATUS_RUN_ID="$RUN_ID" \
  STATUS_RUN_TYPE="$RUN_TYPE" \
  STATUS_VALUE="$status" \
  STATUS_STARTED_AT="$RUN_STARTED_AT" \
  STATUS_COMPLETED_AT="$completed_at" \
  STATUS_PID="${status_host_pid}" \
  STATUS_EXIT_CODE="$exit_code" \
  STATUS_ARCHIVE_PATH="$RUN_ARCHIVE_PATH" \
  STATUS_ERROR="$error_message" \
  STATUS_FAILURE_CODE="$RUN_FAILURE_CODE" \
  STATUS_CONSECUTIVE_FAILURES="$RUN_CONSECUTIVE_FAILURES" \
  STATUS_PHASE="$RUN_PHASE" \
  STATUS_PHASE_LABEL="$RUN_PHASE_LABEL" \
  STATUS_PHASE_INDEX="$RUN_PHASE_INDEX" \
  STATUS_PHASE_TOTAL="$RUN_PHASE_TOTAL" \
  STATUS_WRITE_MODE="$write_mode" \
  python3 - "$STATUS_FILE" <<'PY'
import datetime
import json
import os
import pathlib
import re
import stat
import tempfile
import sys

target = sys.argv[1]
mode = os.environ["STATUS_WRITE_MODE"]
if mode not in {"claim", "timer-start", "owned"}:
    raise SystemExit(1)

def utf8_prefix(value, maximum):
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value
    return encoded[:maximum].decode("utf-8", errors="ignore")

payload = {
    "id": os.environ["STATUS_RUN_ID"],
    "type": os.environ["STATUS_RUN_TYPE"],
    "status": os.environ["STATUS_VALUE"],
    "startedAt": os.environ["STATUS_STARTED_AT"],
    "pid": int(os.environ["STATUS_PID"]),
    "consecutiveFailures": int(os.environ["STATUS_CONSECUTIVE_FAILURES"]),
}
if os.environ.get("STATUS_COMPLETED_AT"):
    payload["completedAt"] = os.environ["STATUS_COMPLETED_AT"]
if os.environ.get("STATUS_EXIT_CODE"):
    payload["exitCode"] = int(os.environ["STATUS_EXIT_CODE"])
if os.environ.get("STATUS_ARCHIVE_PATH"):
    payload["archivePath"] = os.environ["STATUS_ARCHIVE_PATH"]
if os.environ.get("STATUS_ERROR"):
    detail = utf8_prefix(os.environ["STATUS_ERROR"], 1000)
    payload["error"] = detail
    payload["failureDetail"] = detail
if os.environ.get("STATUS_FAILURE_CODE"):
    failure_code = os.environ["STATUS_FAILURE_CODE"]
    if not re.fullmatch(r"BACKUP_[A-Z0-9_]{1,56}", failure_code):
        raise SystemExit(1)
    payload["failureCode"] = failure_code
if os.environ.get("STATUS_PHASE"):
    payload["phase"] = os.environ["STATUS_PHASE"]
if os.environ.get("STATUS_PHASE_LABEL"):
    payload["phaseLabel"] = utf8_prefix(os.environ["STATUS_PHASE_LABEL"], 160)
if os.environ.get("STATUS_PHASE_INDEX") and os.environ.get("STATUS_PHASE_TOTAL"):
    payload["phaseIndex"] = int(os.environ["STATUS_PHASE_INDEX"])
    payload["phaseTotal"] = int(os.environ["STATUS_PHASE_TOTAL"])

directory = os.path.dirname(target)
os.makedirs(directory, mode=0o700, exist_ok=True)
directory_info = os.lstat(directory)
if (
    not stat.S_ISDIR(directory_info.st_mode)
    or stat.S_ISLNK(directory_info.st_mode)
    or directory_info.st_uid != 0
    or directory_info.st_gid != 0
    or stat.S_IMODE(directory_info.st_mode) != 0o700
):
    raise SystemExit(1)

current = None
current_identity = None
try:
    current_info = os.lstat(target)
    if (
        not stat.S_ISREG(current_info.st_mode)
        or stat.S_ISLNK(current_info.st_mode)
        or current_info.st_uid != 0
        or current_info.st_gid != 0
        or current_info.st_nlink != 1
        or stat.S_IMODE(current_info.st_mode) != 0o600
        or current_info.st_size <= 0
        or current_info.st_size > 64 * 1024
    ):
        raise SystemExit(1)
    with open(target, "r", encoding="utf-8") as handle:
        current = json.load(handle)
    current_identity = (
        current_info.st_dev,
        current_info.st_ino,
        current_info.st_size,
        current_info.st_mtime_ns,
    )
except FileNotFoundError:
    pass
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)

same_owner = (
    isinstance(current, dict)
    and current.get("id") == payload["id"]
    and current.get("type") == payload["type"]
    and current.get("startedAt") == payload["startedAt"]
)
if mode == "claim" and not (same_owner and current.get("status") == "queued"):
    raise SystemExit(1)
if mode == "owned" and not same_owner:
    raise SystemExit(1)
if mode == "timer-start" and isinstance(current, dict):
    if current.get("status") in {"queued", "running"} and not same_owner:
        stale_timer = False
        if (
            current.get("status") == "queued"
            and current.get("type") == payload["type"]
            and isinstance(current.get("id"), str)
            and re.fullmatch(
                rf"timer-{re.escape(payload['type'])}-[0-9]{{8}}T[0-9]{{6}}-[1-9][0-9]*",
                current["id"],
            ) is not None
            and isinstance(current.get("startedAt"), str)
        ):
            try:
                started = datetime.datetime.fromisoformat(
                    current["startedAt"].replace("Z", "+00:00")
                )
                age = (
                    datetime.datetime.now(datetime.timezone.utc) - started
                ).total_seconds()
            except (TypeError, ValueError):
                age = -1
            pid = current.get("pid")
            live_owner = False
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 1:
                try:
                    command = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(
                        b"\0", b" "
                    )
                except OSError:
                    command = b""
                live_owner = (
                    b"backup-full.sh" in command
                    and payload["type"].encode("ascii") in command
                )
            stale_timer = age >= 120 and not live_owner
        if not stale_timer:
            raise SystemExit(1)

fd, temporary = tempfile.mkstemp(prefix="status.", dir=directory, text=True)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    try:
        latest = os.lstat(target)
        latest_identity = (
            latest.st_dev,
            latest.st_ino,
            latest.st_size,
            latest.st_mtime_ns,
        )
    except FileNotFoundError:
        latest_identity = None
    if latest_identity != current_identity:
        raise SystemExit(1)
    os.replace(temporary, target)
    temporary = ""
    os.chmod(target, 0o600)
    directory_fd = os.open(
        directory,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0),
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

discover_pending_backup_request() {
  local request_type="$1"
  python3 - "${BACKUP_REQUESTS_DIR}" "${request_type}" <<'PY'
import datetime
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
request_type = sys.argv[2]
types = {"daily", "weekly", "monthly", "comprehensive"}
name_pattern = re.compile(
    r"^(daily|weekly|monthly|comprehensive)\."
    r"(request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(pending|claimed)\.json$"
)
timestamp_pattern = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:"
    r"[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
)
if request_type not in types:
    raise SystemExit(1)
root_info = os.lstat(root)
if (
    not stat.S_ISDIR(root_info.st_mode)
    or stat.S_ISLNK(root_info.st_mode)
    or root_info.st_uid != 0
    or root_info.st_gid != 0
    or stat.S_IMODE(root_info.st_mode) != 0o700
):
    raise SystemExit(1)
names = sorted(os.listdir(root))
if len(names) > 32:
    raise SystemExit(1)
candidates = []
for name in names:
    match = name_pattern.fullmatch(name)
    if match is None:
        raise SystemExit(1)
    kind, request_id, state = match.groups()
    path = root / name
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 4096
    ):
        raise SystemExit(1)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(1)
    if (
        not isinstance(payload, dict)
        or set(payload) != {"schema", "id", "type", "requestedAt"}
        or payload.get("schema") != "bridgesllm.backup-request.v1"
        or payload.get("id") != request_id
        or payload.get("type") != kind
        or not isinstance(payload.get("requestedAt"), str)
        or timestamp_pattern.fullmatch(payload["requestedAt"]) is None
    ):
        raise SystemExit(1)
    try:
        requested_at = datetime.datetime.fromisoformat(
            payload["requestedAt"].replace("Z", "+00:00")
        )
    except ValueError:
        raise SystemExit(1)
    age = (datetime.datetime.now(datetime.timezone.utc) - requested_at).total_seconds()
    # Receipt-first publication makes this file the durable request authority.
    # Preserve an otherwise exact UI request across a Portal crash for up to the
    # bounded recovery horizon instead of silently expiring its identity.
    if age < -60 or (state == "pending" and age > 30 * 24 * 60 * 60):
        raise SystemExit(1)
    if kind == request_type and state == "pending":
        candidates.append((path, payload, info))
if len(candidates) > 1:
    raise SystemExit(1)
if candidates:
    path, payload, info = candidates[0]
    print(
        "\t".join(
            (
                str(path),
                payload["id"],
                payload["requestedAt"],
                str(info.st_dev),
                str(info.st_ino),
            )
        )
    )
PY
}

reconcile_stale_backup_request_claims() {
  python3 - "${BACKUP_REQUESTS_DIR}" "${STATUS_FILE}" <<'PY'
import datetime
import json
import os
import pathlib
import re
import stat
import tempfile
import sys

root = pathlib.Path(sys.argv[1])
status_path = pathlib.Path(sys.argv[2])
claim_pattern = re.compile(
    r"^(daily|weekly|monthly|comprehensive)\."
    r"(request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12})\.claimed\.json$"
)

def fsync_directory(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def read_status():
    try:
        info = os.lstat(status_path)
    except FileNotFoundError:
        return None, None
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 64 * 1024
    ):
        raise SystemExit(1)
    try:
        payload = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(1)
    return payload, (
        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns
    )

root_info = os.lstat(root)
if (
    not stat.S_ISDIR(root_info.st_mode)
    or stat.S_ISLNK(root_info.st_mode)
    or root_info.st_uid != 0
    or root_info.st_gid != 0
    or stat.S_IMODE(root_info.st_mode) != 0o700
):
    raise SystemExit(1)
names = sorted(os.listdir(root))
if len(names) > 32:
    raise SystemExit(1)
for name in names:
    match = claim_pattern.fullmatch(name)
    if match is None:
        continue
    request_type, request_id = match.groups()
    claim = root / name
    info = os.lstat(claim)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 4096
    ):
        raise SystemExit(1)
    try:
        receipt = json.loads(claim.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SystemExit(1)
    if (
        not isinstance(receipt, dict)
        or set(receipt) != {"schema", "id", "type", "requestedAt"}
        or receipt.get("schema") != "bridgesllm.backup-request.v1"
        or receipt.get("id") != request_id
        or receipt.get("type") != request_type
        or not isinstance(receipt.get("requestedAt"), str)
    ):
        raise SystemExit(1)

    current, identity = read_status()
    owns_status = (
        isinstance(current, dict)
        and current.get("id") == request_id
        and current.get("type") == request_type
        and current.get("startedAt") == receipt["requestedAt"]
    )
    terminal_status_durable = (
        owns_status
        and current.get("status") in {"completed", "degraded", "failed"}
    )
    if owns_status and current.get("status") in {"queued", "running"}:
        pid = current.get("pid")
        if isinstance(pid, int) and not isinstance(pid, bool) and pid > 1:
            try:
                command = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ")
            except OSError:
                command = b""
            if b"backup-full.sh" in command and request_type.encode() in command:
                raise SystemExit(1)
        current["status"] = "failed"
        current["completedAt"] = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        current["exitCode"] = 1
        current["error"] = "Backup process stopped before completing its claimed request"
        current["failureCode"] = "BACKUP_PROCESS_EXITED"
        current["failureDetail"] = current["error"]
        current["phase"] = current.get("phase") or "preflight"
        current["phaseLabel"] = current.get("phaseLabel") or "Validating backup preflight"
        current["phaseIndex"] = current.get("phaseIndex") or 1
        current["phaseTotal"] = current.get("phaseTotal") or 1
        failures = current.get("consecutiveFailures", 0)
        current["consecutiveFailures"] = min(
            100000,
            failures + 1 if isinstance(failures, int) and failures >= 0 else 1,
        )
        fd, temporary = tempfile.mkstemp(
            prefix="status.reconcile.", dir=status_path.parent, text=True
        )
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(current, handle, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            latest = os.lstat(status_path)
            if (
                latest.st_dev, latest.st_ino, latest.st_size, latest.st_mtime_ns
            ) != identity:
                raise SystemExit(1)
            os.replace(temporary, status_path)
            temporary = ""
            os.chmod(status_path, 0o600)
            fsync_directory(status_path.parent)
            terminal_status_durable = True
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
    if not terminal_status_durable:
        # A claim is durable request authority. Without an exact durable
        # terminal status it must remain for locked recovery.
        raise SystemExit(1)
    latest_claim = os.lstat(claim)
    if (
        (latest_claim.st_dev, latest_claim.st_ino) != (info.st_dev, info.st_ino)
        or latest_claim.st_nlink != 1
    ):
        raise SystemExit(1)
    os.unlink(claim)
    fsync_directory(root)
PY
}

claim_pending_backup_request() {
  local request_type="$1"
  local discovered pending_path request_id requested_at expected_dev expected_ino extra
  discovered="$(discover_pending_backup_request "${request_type}")" || return 1
  [[ -n "${discovered}" ]] || return 0
  IFS=$'\t' read -r pending_path request_id requested_at expected_dev expected_ino extra \
    <<<"${discovered}"
  [[ -z "${extra}" ]] || return 1
  python3 - "${BACKUP_REQUESTS_DIR}" "${request_type}" \
    "${pending_path}" "${request_id}" "${requested_at}" \
    "${expected_dev}" "${expected_ino}" <<'PY'
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
request_type = sys.argv[2]
pending = pathlib.Path(sys.argv[3])
request_id = sys.argv[4]
requested_at = sys.argv[5]
expected_dev = int(sys.argv[6])
expected_ino = int(sys.argv[7])
if (
    pending.parent != root
    or pending.name != f"{request_type}.{request_id}.pending.json"
    or re.fullmatch(
        r"request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
        r"[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        request_id,
    ) is None
):
    raise SystemExit(1)
info = os.lstat(pending)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
    or (info.st_dev, info.st_ino) != (expected_dev, expected_ino)
):
    raise SystemExit(1)
try:
    payload = json.loads(pending.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
if payload != {
    "schema": "bridgesllm.backup-request.v1",
    "id": request_id,
    "type": request_type,
    "requestedAt": requested_at,
}:
    raise SystemExit(1)
claim = root / f"{request_type}.{request_id}.claimed.json"
linked = False
try:
    os.link(pending, claim, follow_symlinks=False)
    linked = True
    pending_after = os.lstat(pending)
    claim_after = os.lstat(claim)
    if (
        (pending_after.st_dev, pending_after.st_ino) != (expected_dev, expected_ino)
        or (claim_after.st_dev, claim_after.st_ino) != (expected_dev, expected_ino)
        or pending_after.st_nlink != 2
        or claim_after.st_nlink != 2
    ):
        raise OSError("backup request identity changed during claim")
    os.unlink(pending)
    linked = False
    directory_fd = os.open(
        root,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    claimed = os.lstat(claim)
    if (
        (claimed.st_dev, claimed.st_ino) != (expected_dev, expected_ino)
        or claimed.st_nlink != 1
    ):
        raise OSError("backup request claim did not converge")
except (FileExistsError, FileNotFoundError, OSError):
    if linked:
        try:
            os.unlink(claim)
        except FileNotFoundError:
            pass
    raise SystemExit(1)
print(
    "\t".join(
        (
            request_id,
            requested_at,
            str(claim),
            str(expected_dev),
            str(expected_ino),
        )
    )
)
PY
}

remove_pending_backup_request_exact() {
  local pending_path="$1"
  local request_id="$2"
  local request_type="$3"
  local requested_at="$4"
  local expected_dev="$5"
  local expected_ino="$6"
  python3 - "${BACKUP_REQUESTS_DIR}" "${pending_path}" "${request_id}" \
    "${request_type}" "${requested_at}" "${expected_dev}" "${expected_ino}" <<'PY'
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
request_id, request_type, requested_at = sys.argv[3:6]
expected = (int(sys.argv[6]), int(sys.argv[7]))
if target.parent != root or target.name != f"{request_type}.{request_id}.pending.json":
    raise SystemExit(1)
try:
    info = os.lstat(target)
except FileNotFoundError:
    raise SystemExit(0)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_nlink != 1
    or info.st_uid != 0
    or info.st_gid != 0
    or stat.S_IMODE(info.st_mode) != 0o600
    or (info.st_dev, info.st_ino) != expected
):
    raise SystemExit(1)
try:
    payload = json.loads(target.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
if payload != {
    "schema": "bridgesllm.backup-request.v1",
    "id": request_id,
    "type": request_type,
    "requestedAt": requested_at,
}:
    raise SystemExit(1)
latest = os.lstat(target)
if (latest.st_dev, latest.st_ino) != expected or latest.st_nlink != 1:
    raise SystemExit(1)
os.unlink(target)
directory_fd = os.open(
    root,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
}

consume_backup_request_claim() {
  [[ -n "${RUN_REQUEST_CLAIM_PATH}" ]] || return 0
  python3 - "${BACKUP_REQUESTS_DIR}" "${RUN_REQUEST_CLAIM_PATH}" \
    "${RUN_ID}" "${RUN_TYPE}" "${RUN_STARTED_AT}" \
    "${RUN_REQUEST_CLAIM_DEV}" "${RUN_REQUEST_CLAIM_INO}" <<'PY'
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
request_id, request_type, requested_at = sys.argv[3:6]
expected = (int(sys.argv[6]), int(sys.argv[7]))
if target.parent != root or target.name != f"{request_type}.{request_id}.claimed.json":
    raise SystemExit(1)
info = os.lstat(target)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_nlink != 1
    or info.st_uid != 0
    or info.st_gid != 0
    or stat.S_IMODE(info.st_mode) != 0o600
    or (info.st_dev, info.st_ino) != expected
):
    raise SystemExit(1)
try:
    payload = json.loads(target.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
if payload != {
    "schema": "bridgesllm.backup-request.v1",
    "id": request_id,
    "type": request_type,
    "requestedAt": requested_at,
}:
    raise SystemExit(1)
latest = os.lstat(target)
if (latest.st_dev, latest.st_ino) != expected or latest.st_nlink != 1:
    raise SystemExit(1)
os.unlink(target)
directory_fd = os.open(
    root,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
  RUN_REQUEST_CLAIM_PATH=""
  RUN_REQUEST_CLAIM_DEV=""
  RUN_REQUEST_CLAIM_INO=""
}

finish_unclaimed_backup_request() {
  local exit_code="$?"
  trap - EXIT HUP INT TERM ERR
  if (( exit_code != 0 )) && [[ -n "${PENDING_REQUEST_ID}" ]]; then
    if assert_backup_lock_guard; then
      RUN_ID="${PENDING_REQUEST_ID}"
      RUN_STARTED_AT="${PENDING_REQUEST_STARTED_AT}"
      RUN_PHASE="preflight"
      RUN_PHASE_LABEL="Preparing backup"
      RUN_PHASE_INDEX=1
      RUN_PHASE_TOTAL=1
      RUN_CONSECUTIVE_FAILURES=1
      RUN_FAILURE_CODE="${RUN_FAILURE_CODE:-BACKUP_PREFLIGHT_FAILED}"
      local detail="${RUN_ERROR_DETAIL:-Backup preflight failed after acquiring its operation locks (exit ${exit_code})}"
      if assert_backup_lock_guard \
        && write_status failed "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        "${exit_code}" "${detail}" claim; then
        if ! assert_backup_lock_guard \
          || ! remove_pending_backup_request_exact \
          "${PENDING_REQUEST_PATH}" "${PENDING_REQUEST_ID}" "${RUN_TYPE}" \
          "${PENDING_REQUEST_STARTED_AT}" "${PENDING_REQUEST_DEV}" \
          "${PENDING_REQUEST_INO}"; then
          log "ERROR: terminal preflight status is durable but its pending request receipt requires recovery"
          exit_code=1
        fi
      fi
    else
      # The EXIT trap may run because either canonical lock was contended or
      # lock handoff failed. Without an attested live guard it has no authority
      # to rewrite status or consume the receipt discovered before locking.
      printf '%s\n' \
        'Backup request authority was preserved because its operation locks were not acquired.' >&2
    fi
  fi
  release_backup_lock_guard || true
  exit "${exit_code}"
}

previous_backup_failure_streak() {
  python3 - "$STATUS_FILE" <<'PY'
import json
import os
import stat
import sys

path = sys.argv[1]
try:
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or info.st_size <= 0
        or info.st_size > 64 * 1024
    ):
        raise SystemExit(1)
    payload = json.loads(open(path, "r", encoding="utf-8").read())
except FileNotFoundError:
    print(0)
    raise SystemExit(0)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
if payload.get("status") not in {"failed", "degraded"}:
    print(0)
    raise SystemExit(0)
value = payload.get("consecutiveFailures", 1)
if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 100000:
    raise SystemExit(1)
print(value)
PY
}

set_backup_phase() {
  local phase="$1"
  local label="$2"
  local index="$3"
  [[ "${phase}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ \
    && -n "${label}" && "${#label}" -le 160 \
    && "${index}" =~ ^[1-9][0-9]*$ \
    && "${RUN_PHASE_TOTAL}" =~ ^[1-9][0-9]*$ \
    && "${index}" -le "${RUN_PHASE_TOTAL}" ]] || return 1
  RUN_PHASE="${phase}"
  RUN_PHASE_LABEL="${label}"
  RUN_PHASE_INDEX="${index}"
  $RUN_ACTIVE && write_status running "" "" ""
  return 0
}

backup_work_root_action() {
  local action="$1"
  local argument="${2:-}"
  [[ "${action}" =~ ^(prepare|attest|create|cleanup|sweep)$ ]] || return 1
  BACKUP_WORK_ROOT="${BACKUP_BASE}/.bridgesllm-work-v1"
  python3 - "${action}" "${BACKUP_BASE}" "${BACKUP_WORK_ROOT}" \
    "${argument}" "${BACKUP_WORK_IMAGE_MOUNTED}" \
    "${BACKUP_WORK_IMAGE_MOUNT_ID}" <<'PY'
import ctypes
import errno
import os
import pathlib
import re
import secrets
import stat
import sys

action, raw_base, raw_work, argument, mounted_raw, expected_mount_raw = sys.argv[1:]
if mounted_raw not in {"true", "false"}:
    raise SystemExit("backup work image state is invalid")
mounted = mounted_raw == "true"
if mounted:
    if not expected_mount_raw.isdigit() or int(expected_mount_raw) <= 0:
        raise SystemExit("backup work image mount authority is invalid")
    expected_image_mount = int(expected_mount_raw)
else:
    if expected_mount_raw:
        raise SystemExit("unmounted backup work root has a mount authority")
    expected_image_mount = None
base = pathlib.Path(raw_base)
work = pathlib.Path(raw_work)
work_name = ".bridgesllm-work-v1"
directory_pattern = re.compile(
    r"^(?:create-(?:daily|weekly|monthly|comprehensive)|verify)-[0-9a-f]{16}$"
)
kind_pattern = re.compile(
    r"^(?:create-(?:daily|weekly|monthly|comprehensive)|verify)$"
)
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
file_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
AT_EMPTY_PATH = 0x1000
AT_SYMLINK_NOFOLLOW = 0x100
STATX_BASIC_STATS = 0x7FF
STATX_MNT_ID = 0x1000
MAX_WORKSPACES = 32
MAX_MEMBERS = 8192
MAX_BYTES = 2 * 1024**4


class StatxTimestamp(ctypes.Structure):
    _fields_ = (
        ("tv_sec", ctypes.c_int64),
        ("tv_nsec", ctypes.c_uint32),
        ("reserved", ctypes.c_int32),
    )


class Statx(ctypes.Structure):
    _fields_ = (
        ("stx_mask", ctypes.c_uint32),
        ("stx_blksize", ctypes.c_uint32),
        ("stx_attributes", ctypes.c_uint64),
        ("stx_nlink", ctypes.c_uint32),
        ("stx_uid", ctypes.c_uint32),
        ("stx_gid", ctypes.c_uint32),
        ("stx_mode", ctypes.c_uint16),
        ("spare0", ctypes.c_uint16 * 1),
        ("stx_ino", ctypes.c_uint64),
        ("stx_size", ctypes.c_uint64),
        ("stx_blocks", ctypes.c_uint64),
        ("stx_attributes_mask", ctypes.c_uint64),
        ("stx_atime", StatxTimestamp),
        ("stx_btime", StatxTimestamp),
        ("stx_ctime", StatxTimestamp),
        ("stx_mtime", StatxTimestamp),
        ("stx_rdev_major", ctypes.c_uint32),
        ("stx_rdev_minor", ctypes.c_uint32),
        ("stx_dev_major", ctypes.c_uint32),
        ("stx_dev_minor", ctypes.c_uint32),
        ("stx_mnt_id", ctypes.c_uint64),
        ("stx_dio_mem_align", ctypes.c_uint32),
        ("stx_dio_offset_align", ctypes.c_uint32),
        ("spare3", ctypes.c_uint64 * 12),
    )


if ctypes.sizeof(Statx) != 0x100:
    raise SystemExit("backup work root statx ABI is unavailable")
libc = ctypes.CDLL(None, use_errno=True)
statx = getattr(libc, "statx", None)
if statx is None:
    raise SystemExit("backup work root requires statx")
statx.argtypes = [
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_uint,
    ctypes.POINTER(Statx),
]
statx.restype = ctypes.c_int


def mount_id(descriptor):
    result = Statx()
    if statx(
        descriptor,
        b"",
        AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
        STATX_BASIC_STATS | STATX_MNT_ID,
        ctypes.byref(result),
    ) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    current = os.fstat(descriptor)
    if (
        not result.stx_mask & STATX_MNT_ID
        or result.stx_mnt_id <= 0
        or result.stx_ino != current.st_ino
        or os.makedev(result.stx_dev_major, result.stx_dev_minor) != current.st_dev
        or stat.S_IFMT(result.stx_mode) != stat.S_IFMT(current.st_mode)
    ):
        raise OSError("backup work root mount identity is ambiguous")
    return int(result.stx_mnt_id)


def attest_mounted_work_filesystem(expected_mount):
    matches = []
    for line in pathlib.Path("/proc/self/mountinfo").read_text(
        encoding="utf-8"
    ).splitlines():
        fields = line.split()
        if (
            len(fields) < 10
            or not fields[0].isdigit()
            or int(fields[0]) != expected_mount
        ):
            continue
        separator = fields.index("-") if "-" in fields else -1
        if separator < 6 or separator + 3 >= len(fields):
            raise OSError("backup work image mount record is malformed")
        options = set(fields[5].split(",")) | set(
            fields[separator + 3].split(",")
        )
        if (
            fields[4] != str(work)
            or fields[separator + 1] != "ext4"
            or re.fullmatch(r"/dev/loop[0-9]+", fields[separator + 2]) is None
            or not {"rw", "nosuid", "nodev", "noexec", "noatime"}.issubset(
                options
            )
            # ext4 reports active online discard as `discard`, but omits the
            # negative/default `nodiscard` token even when it was explicitly
            # supplied. The trusted mount invocation forces nodiscard; this
            # negative attestation proves it did not resolve to discard mode.
            or "discard" in options
        ):
            raise OSError("backup work image mount policy changed")
        matches.append(fields[separator + 2])
    if len(matches) != 1:
        raise OSError("backup work image mount authority is ambiguous")


def safe_directory(info, *, exact_mode=False):
    return (
        stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and info.st_uid == 0
        and info.st_gid == 0
        and (
            stat.S_IMODE(info.st_mode) == 0o700
            if exact_mode
            else not info.st_mode & 0o022
        )
    )


def open_absolute_directory(path):
    if (
        not path.is_absolute()
        or os.path.normpath(str(path)) != str(path)
        or path == pathlib.Path("/")
        or len(str(path).encode("utf-8")) > 1024
        or any(ord(character) < 32 or ord(character) == 127 for character in str(path))
    ):
        raise OSError("backup work root path is not canonical")
    descriptor = os.open("/", directory_flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, directory_flags, dir_fd=descriptor)
            try:
                info = os.fstat(child)
                if not safe_directory(info):
                    raise OSError("backup work root crosses an unsafe directory")
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_work_root():
    if work != base / work_name:
        raise OSError("backup work root escaped its configured root")
    base_fd = open_absolute_directory(base)
    created = False
    try:
        if action == "prepare":
            try:
                os.mkdir(work_name, 0o700, dir_fd=base_fd)
                created = True
            except FileExistsError:
                pass
        work_fd = os.open(work_name, directory_flags, dir_fd=base_fd)
        try:
            info = os.fstat(work_fd)
            if not safe_directory(info, exact_mode=True):
                raise OSError("backup work root ownership or mode is unsafe")
            work_mount = mount_id(work_fd)
            base_mount = mount_id(base_fd)
            if mounted:
                if (
                    action == "prepare"
                    or work_mount != expected_image_mount
                    or work_mount == base_mount
                ):
                    raise OSError("backup work image mount identity changed")
                attest_mounted_work_filesystem(work_mount)
            elif work_mount != base_mount:
                raise OSError("backup work root crosses a mount boundary")
            if created:
                os.fsync(work_fd)
                os.fsync(base_fd)
            return base_fd, work_fd, work_mount
        except BaseException:
            os.close(work_fd)
            raise
    except BaseException:
        os.close(base_fd)
        raise


def open_child_directory(parent_fd, name, expected_mount):
    child_fd = os.open(name, directory_flags, dir_fd=parent_fd)
    try:
        info = os.fstat(child_fd)
        if not safe_directory(info, exact_mode=True) or mount_id(child_fd) != expected_mount:
            raise OSError("backup workspace directory is unsafe")
        return child_fd
    except BaseException:
        os.close(child_fd)
        raise


def attest_tree(directory_fd, expected_mount):
    members = 0
    payload_bytes = 0

    def walk(current_fd):
        nonlocal members, payload_bytes
        entries = sorted(os.scandir(current_fd), key=lambda entry: entry.name)
        for entry in entries:
            members += 1
            if members > MAX_MEMBERS:
                raise OSError("backup workspace member count is unbounded")
            info = entry.stat(follow_symlinks=False)
            if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
                raise OSError("backup workspace member ownership or mode is unsafe")
            if stat.S_ISDIR(info.st_mode):
                child_fd = open_child_directory(current_fd, entry.name, expected_mount)
                try:
                    walk(child_fd)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1:
                    raise OSError("backup workspace contains a linked file")
                file_fd = os.open(entry.name, file_flags, dir_fd=current_fd)
                try:
                    opened = os.fstat(file_fd)
                    if (
                        (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)
                        or mount_id(file_fd) != expected_mount
                    ):
                        raise OSError("backup workspace file identity changed")
                finally:
                    os.close(file_fd)
                payload_bytes += max(info.st_size, info.st_blocks * 512)
                if payload_bytes > MAX_BYTES:
                    raise OSError("backup workspace payload is unbounded")
            else:
                raise OSError("backup workspace contains an unsafe member type")

    walk(directory_fd)


def remove_tree(parent_fd, name, expected_mount):
    child_fd = open_child_directory(parent_fd, name, expected_mount)
    try:
        entries = sorted(os.scandir(child_fd), key=lambda entry: entry.name)
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
                raise OSError("backup workspace changed during cleanup")
            if stat.S_ISDIR(info.st_mode):
                remove_tree(child_fd, entry.name, expected_mount)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                os.unlink(entry.name, dir_fd=child_fd)
            else:
                raise OSError("backup workspace changed during cleanup")
        os.fsync(child_fd)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=parent_fd)
    os.fsync(parent_fd)


base_fd = work_fd = None
try:
    base_fd, work_fd, work_mount = open_work_root()
    names = sorted(os.listdir(work_fd))
    if len(names) > MAX_WORKSPACES or any(directory_pattern.fullmatch(name) is None for name in names):
        raise OSError("backup work root inventory is unsafe or unbounded")
    for name in names:
        child_fd = open_child_directory(work_fd, name, work_mount)
        try:
            # The mounted work image is the disposable bound. Its contents
            # deliberately include source symlinks, hardlinks, sparse files,
            # and trees far larger than the host stale-sweep ceiling. Attest
            # only the exact top-level workspace and mount identity; teardown
            # discards the whole image without traversing attacker-controlled
            # or live-source-shaped members.
            if not mounted:
                attest_tree(child_fd, work_mount)
        finally:
            os.close(child_fd)

    if action in {"prepare", "attest"}:
        if argument:
            raise OSError("backup work root action has an unexpected argument")
        if action == "prepare":
            print(work)
    elif action == "create":
        if kind_pattern.fullmatch(argument) is None:
            raise OSError("backup workspace kind is invalid")
        if len(names) >= MAX_WORKSPACES:
            raise OSError("backup work root has reached its workspace limit")
        for _ in range(128):
            name = f"{argument}-{secrets.token_hex(8)}"
            try:
                os.mkdir(name, 0o700, dir_fd=work_fd)
                break
            except FileExistsError:
                continue
        else:
            raise OSError("backup workspace identity could not be allocated")
        child_fd = open_child_directory(work_fd, name, work_mount)
        try:
            os.fsync(child_fd)
        finally:
            os.close(child_fd)
        os.fsync(work_fd)
        print(work / name)
    elif action == "cleanup":
        target = pathlib.Path(argument)
        if (
            not target.is_absolute()
            or target.parent != work
            or directory_pattern.fullmatch(target.name) is None
        ):
            raise OSError("backup workspace cleanup target is invalid")
        if target.name in names:
            if mounted:
                child_fd = open_child_directory(
                    work_fd, target.name, work_mount
                )
                os.close(child_fd)
            else:
                remove_tree(work_fd, target.name, work_mount)
    elif action == "sweep":
        if argument:
            raise OSError("backup work root sweep has an unexpected argument")
        if mounted:
            raise OSError("mounted backup work images are retired by unmount")
        for name in names:
            remove_tree(work_fd, name, work_mount)
finally:
    if work_fd is not None:
        os.close(work_fd)
    if base_fd is not None:
        os.close(base_fd)
PY
}

prepare_backup_work_root() {
  local prepared=""
  prepared="$(backup_work_root_action prepare)" || return 1
  [[ "${prepared}" == "${BACKUP_BASE}/.bridgesllm-work-v1" ]] || return 1
  BACKUP_WORK_ROOT="${prepared}"
}

create_backup_work_directory() {
  local kind="$1"
  [[ -n "${BACKUP_WORK_ROOT:-}" ]] || return 1
  backup_work_root_action create "${kind}"
}

cleanup_backup_work_directory() {
  local target="$1"
  [[ -n "${target}" && -n "${BACKUP_WORK_ROOT:-}" ]] || return 0
  backup_work_root_action cleanup "${target}"
}

sweep_stale_backup_artifacts() {
  local sweep_scope="${1:-all}"
  [[ "${sweep_scope}" == "all" || "${sweep_scope}" == "temporary-only" ]] \
    || return 1
  backup_work_root_action sweep || return 1
  [[ "${sweep_scope}" == "all" ]] || return 0
  python3 - "$BACKUP_BASE" <<'PY'
import os
import pathlib
import re
import stat
import sys

backup_root = pathlib.Path(sys.argv[1])

def safe_root_owned(path: pathlib.Path, expect_directory: bool) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
        return False
    if expect_directory:
        return stat.S_ISDIR(info.st_mode)
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1

for parent in (backup_root, backup_root / "degraded"):
    for kind in ("daily", "weekly", "monthly", "comprehensive"):
        directory = parent / kind
        if not directory.is_dir() or directory.is_symlink():
            continue
        for candidate in directory.iterdir():
            if candidate.name.endswith(".tar.gz.receipt.json"):
                archive = directory / candidate.name.removesuffix(".receipt.json")
                if not archive.exists() and not archive.is_symlink():
                    if not safe_root_owned(candidate, False):
                        raise SystemExit("unsafe orphaned backup receipt")
                    candidate.unlink()
                continue
            if re.fullmatch(
                r"portal-[A-Za-z0-9.-]+\.tar\.gz\.receipt\.json\.tmp-[A-Za-z0-9._-]+",
                candidate.name,
            ):
                if not safe_root_owned(candidate, False):
                    raise SystemExit("unsafe stale backup receipt temporary")
                candidate.unlink()
                continue
            if ".partial-" not in candidate.name:
                continue
            if not re.fullmatch(r"portal-[A-Za-z0-9.-]+\.tar\.gz\.partial-[A-Za-z0-9._-]{1,128}", candidate.name):
                continue
            if not safe_root_owned(candidate, False):
                raise SystemExit("unsafe stale partial backup archive")
            candidate.unlink()
PY
}

prepare_backup_publication_targets() {
  local type="$1" archive_name="$2" run_id="$3" targets=""
  [[ "${type}" =~ ^(daily|weekly|monthly|comprehensive)$ \
    && "${archive_name}" =~ ^portal-[A-Za-z0-9.-]+\.tar\.gz$ \
    && "${run_id}" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || return 1
  targets="$(python3 - "${BACKUP_BASE}" "${type}" \
    "${archive_name}" "${run_id}" <<'PY'
import ctypes
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
run_type = sys.argv[2]
archive_name = sys.argv[3]
run_id = sys.argv[4]
if run_type not in {"daily", "weekly", "monthly", "comprehensive"}:
    raise SystemExit(1)
flags = (
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0)
)
AT_EMPTY_PATH = 0x1000
AT_SYMLINK_NOFOLLOW = 0x100
STATX_BASIC_STATS = 0x7FF
STATX_MNT_ID = 0x1000

class StatxTimestamp(ctypes.Structure):
    _fields_ = (
        ("tv_sec", ctypes.c_int64),
        ("tv_nsec", ctypes.c_uint32),
        ("reserved", ctypes.c_int32),
    )

class Statx(ctypes.Structure):
    _fields_ = (
        ("stx_mask", ctypes.c_uint32),
        ("stx_blksize", ctypes.c_uint32),
        ("stx_attributes", ctypes.c_uint64),
        ("stx_nlink", ctypes.c_uint32),
        ("stx_uid", ctypes.c_uint32),
        ("stx_gid", ctypes.c_uint32),
        ("stx_mode", ctypes.c_uint16),
        ("spare0", ctypes.c_uint16),
        ("stx_ino", ctypes.c_uint64),
        ("stx_size", ctypes.c_uint64),
        ("stx_blocks", ctypes.c_uint64),
        ("stx_attributes_mask", ctypes.c_uint64),
        ("stx_atime", StatxTimestamp),
        ("stx_btime", StatxTimestamp),
        ("stx_ctime", StatxTimestamp),
        ("stx_mtime", StatxTimestamp),
        ("stx_rdev_major", ctypes.c_uint32),
        ("stx_rdev_minor", ctypes.c_uint32),
        ("stx_dev_major", ctypes.c_uint32),
        ("stx_dev_minor", ctypes.c_uint32),
        ("stx_mnt_id", ctypes.c_uint64),
        ("stx_dio_mem_align", ctypes.c_uint32),
        ("stx_dio_offset_align", ctypes.c_uint32),
        ("spare3", ctypes.c_uint64 * 12),
    )

if ctypes.sizeof(Statx) != 0x100:
    raise SystemExit("backup publication statx ABI is unavailable")
libc = ctypes.CDLL(None, use_errno=True)
statx = getattr(libc, "statx", None)
if statx is None:
    raise SystemExit("backup publication mount identity is unavailable")
statx.argtypes = [
    ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint,
    ctypes.POINTER(Statx),
]
statx.restype = ctypes.c_int

def mount_id(descriptor):
    result = Statx()
    if statx(
        descriptor, b"", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
        STATX_BASIC_STATS | STATX_MNT_ID, ctypes.byref(result),
    ) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    info = os.fstat(descriptor)
    if (
        not result.stx_mask & STATX_MNT_ID
        or result.stx_mnt_id <= 0
        or result.stx_ino != info.st_ino
        or os.makedev(result.stx_dev_major, result.stx_dev_minor) != info.st_dev
    ):
        raise OSError("backup publication mount identity is ambiguous")
    return int(result.stx_mnt_id)

def safe_directory(info, *, exact=False):
    return (
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == 0
        and info.st_gid == 0
        and (stat.S_IMODE(info.st_mode) == 0o700 if exact else not info.st_mode & 0o022)
    )

root_fd = os.open(root, flags)
opened = []
try:
    root_info = os.fstat(root_fd)
    if (
        not root.is_absolute()
        or os.path.normpath(root) != str(root)
        or os.path.realpath(root) != str(root)
        or not safe_directory(root_info)
    ):
        raise OSError("backup publication root is unsafe")
    try:
        os.mkdir("degraded", 0o700, dir_fd=root_fd)
        os.fsync(root_fd)
    except FileExistsError:
        pass
    degraded_fd = os.open("degraded", flags, dir_fd=root_fd)
    opened.append(degraded_fd)
    if not safe_directory(os.fstat(degraded_fd), exact=True):
        raise OSError("degraded backup root is unsafe")
    targets = []
    for role, parent_fd, parent_path in (
        ("complete", root_fd, root),
        ("degraded", degraded_fd, root / "degraded"),
    ):
        try:
            os.mkdir(run_type, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
        descriptor = os.open(run_type, flags, dir_fd=parent_fd)
        opened.append(descriptor)
        info = os.fstat(descriptor)
        if not safe_directory(info, exact=True):
            raise OSError("backup publication target is unsafe")
        os.fsync(descriptor)
        targets.append({
            "role": role,
            "parent": str(parent_path / run_type),
            "device": info.st_dev,
            "inode": info.st_ino,
            "mountId": mount_id(descriptor),
            "partialName": f"{archive_name}.partial-{run_id}",
            "receiptName": f"{archive_name}.receipt.json",
        })
    print(json.dumps({
        "schema": "bridgesllm.backup-publication-targets.v1",
        "targets": targets,
    }, sort_keys=True, separators=(",", ":")))
finally:
    for descriptor in reversed(opened):
        os.close(descriptor)
    os.close(root_fd)
PY
  )" || return 1
  [[ -n "${targets}" ]] || return 1
  BACKUP_PUBLICATION_TARGETS="${targets}"
}

assert_backup_disk_admission() {
  local reserve_bytes="${BACKUP_RECOVERY_RESERVE_BYTES:-536870912}"
  local database_bytes="" capacity_plan="" capacity_summary=""
  local lease_held=false
  [[ "${reserve_bytes}" =~ ^[0-9]+$ \
    && "${reserve_bytes}" -ge 67108864 \
    && "${reserve_bytes}" -le 8589934592 ]] \
    || die "BACKUP_RECOVERY_RESERVE_BYTES must be between 64 MiB and 8 GiB"
  database_bytes="$(database_dump_admission_bytes)" \
    || die "Configured database size could not be measured for disk admission"
  [[ "${database_bytes}" =~ ^[1-9][0-9]*$ ]] \
    || die "Configured database size was invalid during disk admission"
  [[ -n "${BACKUP_WORK_ROOT:-}" ]] \
    || die_with_code BACKUP_WORK_ROOT_UNAVAILABLE \
      "Configured backup storage cannot host its private work root"
  if backup_capacity_guard_state_present; then
    assert_backup_capacity_guard || return 1
    lease_held=true
  fi
  [[ -n "${BACKUP_PUBLICATION_TARGETS:-}" ]] || return 1
  capacity_plan="$(python3 - "${BACKUP_BASE}" "${BACKUP_WORK_ROOT}" \
    "${BACKUP_PUBLICATION_TARGETS}" \
    "${reserve_bytes}" "${database_bytes}" "${lease_held}" \
    "${RUN_TYPE:-}" "${LIVE_RECONCILIATION_MAX_BYTES}" \
    "${ARCHIVE_EVIDENCE_MAX_BYTES}" "${ARCHIVE_XATTR_MAX_BYTES}" \
    "${LIVE_RECONCILIATION_MAX_MEMBERS}" \
    "${PORTAL_DIR}" "${APP_FILES_DIR}" "${PORTAL_APP_SOURCES_DIR}" \
    "${PORTAL_FILES_DIR}" "${UPLOAD_FILES_DIR}" \
    "${PROJECTS_DIR}" "${PORTAL_BACKEND_STATE_DIR}" "${PORTAL_STATE_DIR}" \
    "${PORTAL_ASSETS_DIR}" "${STALWART_DIR}" \
    "${STALWART_MAIL_DIR}" "${STALWART_INSTALL_DIR}" \
    "${LEGACY_APP_FILES_DIR}" "${LEGACY_PORTAL_FILES_DIR}" "${RUNTIME_ROOT}" <<'PY'
import json
import os
import pathlib
import stat
import sys

backup_root = pathlib.Path(sys.argv[1])
work_root = pathlib.Path(sys.argv[2])
publication_document = json.loads(sys.argv[3])
reserve = int(sys.argv[4])
database_bytes = int(sys.argv[5])
lease_held = sys.argv[6] == "true"
if sys.argv[6] not in {"true", "false"}:
    raise SystemExit("backup capacity lease state is invalid")
run_type = sys.argv[7]
live_reconciliation_bytes = int(sys.argv[8])
evidence_bytes = int(sys.argv[9])
xattr_bytes = int(sys.argv[10])
live_reconciliation_members = int(sys.argv[11])
raw_roots = [pathlib.Path(value) for value in sys.argv[12:]]
if (
    run_type not in {"daily", "weekly", "monthly", "comprehensive"}
    or live_reconciliation_bytes <= 0
    or live_reconciliation_bytes > 4 * 1024**3
    or evidence_bytes <= 0
    or evidence_bytes > 1024**3
    or xattr_bytes <= 0
    or xattr_bytes > 16 * 1024**2
    or live_reconciliation_members <= 0
    or live_reconciliation_members > 512
):
    raise SystemExit("backup capacity headroom is invalid")
if (
    not isinstance(publication_document, dict)
    or set(publication_document) != {"schema", "targets"}
    or publication_document.get("schema")
        != "bridgesllm.backup-publication-targets.v1"
    or not isinstance(publication_document.get("targets"), list)
    or len(publication_document["targets"]) != 2
):
    raise SystemExit("backup publication capacity topology is invalid")

for anchor in (backup_root, work_root):
    info = os.lstat(anchor)
    if (
        not anchor.is_absolute()
        or os.path.normpath(anchor) != str(anchor)
        or os.path.realpath(anchor) != str(anchor)
        or not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit("backup capacity anchor is unsafe")
roots = []
for candidate in raw_roots:
    try:
        if not os.path.lexists(candidate):
            continue
        info = os.lstat(candidate)
    except OSError:
        raise SystemExit("backup source topology could not be inspected")
    if (
        not candidate.is_absolute()
        or os.path.normpath(candidate) != str(candidate)
        or os.path.realpath(candidate) != str(candidate)
        or not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
    ):
        raise SystemExit("backup source topology is unsafe")
    roots.append(candidate)

if (
    not hasattr(os, "O_PATH")
    or not hasattr(os, "O_NOFOLLOW")
    or not hasattr(os, "O_DIRECTORY")
):
    raise SystemExit("descriptor-relative capacity inventory is unavailable")

directory_flags = (
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0)
)
path_flags = os.O_PATH | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)

def stable_directory(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_nlink,
        info.st_uid,
        info.st_gid,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )

def identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))

def open_absolute_directory(path):
    parts = path.parts
    if not parts or parts[0] != "/" or len(parts) < 2:
        raise ValueError("backup source root is invalid")
    parent = os.open("/", directory_flags)
    try:
        for component in parts[1:-1]:
            child = os.open(
                component,
                directory_flags,
                dir_fd=parent,
            )
            os.close(parent)
            parent = child
        parent_before = os.fstat(parent)
        descriptor = os.open(parts[-1], directory_flags, dir_fd=parent)
        admitted = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        opened = os.fstat(descriptor)
        if identity(admitted) != identity(opened):
            os.close(descriptor)
            raise ValueError("backup source root changed during admission")
        return descriptor, parent, parent_before, parts[-1]
    except BaseException:
        os.close(parent)
        raise

def measure_component(root):
    root_descriptor, root_parent, parent_before, root_name = (
        open_absolute_directory(root)
    )
    seen = set()
    member_count = 0
    data_bytes = 0
    path_bytes = 1
    expected_device = os.fstat(root_descriptor).st_dev

    # Match only control-file contents excluded by the corresponding capture.
    # Count their inodes/path framing, but not the runner's changing log/status
    # bytes: those bytes will never consume the held archive lease.
    ignored_contents = set()
    if root == raw_roots[0]:
        ignored_contents.update({"backend/.data/backups/status.json", "backend/.data/backups/current.log", "backend/.data/backups/backup.lock"})
    if root == raw_roots[6]:
        ignored_contents.update({"backups/status.json", "backups/current.log", "backups/backup.lock"})

    def walk(directory_descriptor, prefix_bytes, relative=""):
        nonlocal member_count, data_bytes, path_bytes
        before = os.fstat(directory_descriptor)
        if (
            not stat.S_ISDIR(before.st_mode)
            or before.st_dev != expected_device
        ):
            raise ValueError("backup capacity traversal crossed a filesystem")
        member_count += 1
        if member_count > 1_000_000:
            raise ValueError("backup component member inventory is unbounded")
        try:
            names = sorted(
                (entry.name for entry in os.scandir(directory_descriptor)),
                key=os.fsencode,
            )
        except OSError:
            raise ValueError("backup source directory could not be enumerated")
        for name in names:
            relative_name = f"{relative}/{name}" if relative else name
            encoded_name = os.fsencode(name)
            member_path_bytes = prefix_bytes + len(encoded_name)
            path_bytes += member_path_bytes + 1
            if path_bytes > 4 * 1024**3:
                raise ValueError("backup component path inventory is unbounded")
            leaf = os.open(name, path_flags, dir_fd=directory_descriptor)
            try:
                info = os.fstat(leaf)
                if info.st_dev != expected_device:
                    raise ValueError(
                        "backup capacity traversal crossed a filesystem"
                    )
                member_count += 1
                if member_count > 1_000_000:
                    raise ValueError(
                        "backup component member inventory is unbounded"
                    )
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(
                        name,
                        directory_flags,
                        dir_fd=directory_descriptor,
                    )
                    try:
                        if identity(os.fstat(child)) != identity(info):
                            raise ValueError(
                                "backup source member changed during admission"
                            )
                        # The child was already charged above; walk() charges
                        # its directory record, so offset that duplicate here.
                        member_count -= 1
                        walk(child, member_path_bytes + 1, relative_name)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    inode = (info.st_dev, info.st_ino)
                    if inode not in seen and relative_name not in ignored_contents:
                        seen.add(inode)
                        data_bytes += max(info.st_size, info.st_blocks * 512)
                        if data_bytes > 2 * 1024**4:
                            raise ValueError(
                                "backup source inventory is unbounded"
                            )
                elif not stat.S_ISLNK(info.st_mode):
                    raise ValueError(
                        "backup source contains an unsupported inode"
                    )
            finally:
                os.close(leaf)
        if stable_directory(before) != stable_directory(
            os.fstat(directory_descriptor)
        ):
            raise ValueError("backup source changed during capacity traversal")

    try:
        root_info = os.fstat(root_descriptor)
        if (
            root_info.st_uid != 0
            or root_info.st_gid != 0
            or root_info.st_mode & 0o022
        ):
            raise ValueError("backup source root is not root-owned and write-safe")
        walk(root_descriptor, 0)
        admitted = os.stat(
            root_name,
            dir_fd=root_parent,
            follow_symlinks=False,
        )
        if (
            identity(admitted) != identity(os.fstat(root_descriptor))
            or stable_directory(parent_before)
                != stable_directory(os.fstat(root_parent))
        ):
            raise ValueError("backup source root changed during capacity traversal")
        return data_bytes, member_count, path_bytes
    finally:
        os.close(root_descriptor)
        os.close(root_parent)

def gzip_bound(value):
    # DEFLATE's stored-block overhead is far below 1/32. Keep a 3.125%
    # multiplicative margin plus one MiB for gzip/tar stream framing.
    if value < 0 or value > 2 * 1024**4:
        raise ValueError("backup archive input estimate is unbounded")
    return (value * 33 + 31) // 32 + 1024**2

source_bytes = 0
source_members = 0
max_component_members = 0
max_component_evidence_bytes = 0
metadata_bytes = 0
component_archives_bound = 0
component_bounds = []
component_count = len(roots)
live_mode = False  # New Portal-only v3 captures are always quiesced.
planned_member_growth = live_reconciliation_members if live_mode else 0
if not 1 <= component_count <= 64:
    raise SystemExit("backup component capacity inventory is unbounded")
for root in roots:
    # Each source root is written to its own nested archive. A hard link that
    # crosses component roots therefore consumes space once per component.
    try:
        component_source_bytes, component_members, component_path_bytes = (
            measure_component(root)
        )
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
    planned_component_members = component_members + planned_member_growth
    planned_component_path_bytes = (
        component_path_bytes + planned_member_growth * 4096
    )
    if (
        planned_component_members > 1_000_000
        or planned_component_path_bytes > 4 * 1024**3
    ):
        raise SystemExit("backup component growth allowance is unbounded")
    # Per-component xattrs are independently capped by descriptor inventory
    # and staging. Eight times their raw name/value bytes covers PAX key/value
    # encoding, ACL text expansion, length records, and block padding. A fixed
    # 32-KiB member charge covers the ustar/PAX headers, a maximum-length path,
    # link text, sparse-map records, and 512-byte data padding.
    component_metadata_bytes = (
        component_members * 32768
        + xattr_bytes * 8
        + 1024**2
    )
    component_archive_bound = gzip_bound(
        component_source_bytes + component_metadata_bytes
    )
    component_evidence_bytes = min(
        evidence_bytes,
        planned_component_members * 32768
        + planned_component_path_bytes * 2
        + 1024**2,
    )
    source_bytes += component_source_bytes
    source_members += component_members
    max_component_members = max(
        max_component_members, planned_component_members
    )
    max_component_evidence_bytes = max(
        max_component_evidence_bytes, component_evidence_bytes
    )
    metadata_bytes += component_metadata_bytes
    component_archives_bound += component_archive_bound
    component_bounds.append({
        "path": str(root),
        "archiveBytes": component_archive_bound,
        "memberCount": planned_component_members,
        "pathBytes": planned_component_path_bytes,
        "evidenceBytes": component_evidence_bytes,
    })
    if source_bytes + metadata_bytes > 2 * 1024**4:
        raise SystemExit("backup source archive inventory is unbounded")

# Plain pg_dump can expand bytea/text escaping beyond the database's physical
# size. Five times the measured database size plus fixed framing headroom is a
# conservative bound for the staged SQL.
database_dump_bound = database_bytes * 5 + 16 * 1024**2
# The outer archive contains the already-compressed component archives, the
# database dump, and bounded control/evidence files. verify_archive admits at
# most 4096 outer members; charge maximum PAX/path framing for all of them and
# then apply gzip's conservative expansion bound a second time.
outer_tar_input_bound = (
    component_archives_bound
    + database_dump_bound
    + evidence_bytes
    + 4096 * 8192
    + 1024**2
)
base_payload_bound = gzip_bound(outer_tar_input_bound)
per_component_growth = 0
if live_mode:
    nested_growth = gzip_bound(
        live_reconciliation_bytes
        + live_reconciliation_members * 32768
        + 1024**2
    )
    per_component_growth = gzip_bound(nested_growth)
# Runtime spends one aggregate reconciliation allowance across all component
# archives.  The bound already includes the aggregate member ceiling plus
# nested- and outer-gzip framing, so charging it once mirrors that contract.
growth_headroom = per_component_growth
sqlite_scratch = live_reconciliation_bytes if live_mode else 0
payload_bound = base_payload_bound + growth_headroom
if payload_bound > 2 * 1024**4:
    raise SystemExit("backup payload estimate is unbounded")

def descriptor_mount_id(descriptor):
    values = []
    with open(
        f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii"
    ) as handle:
        for line in handle:
            if line.startswith("mnt_id:"):
                values.append(line.partition(":")[2].strip())
    if len(values) != 1 or not values[0].isdigit() or int(values[0]) <= 0:
        raise ValueError("backup capacity mount identity is unavailable")
    return int(values[0])

def directory_identity(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
        ):
            raise ValueError("backup capacity directory is unsafe")
        return info, descriptor_mount_id(descriptor)
    finally:
        os.close(descriptor)

# One archive_dir may retain four inventories plus baseline/reconciliation
# captures, omission/allow lists, unstable-member records, and diagnostics.
# Charge twelve complete per-component evidence generations. The two full
# payload generations are charged separately because they are the staged
# archive input and verification extraction, not evidence scratch.
retained_evidence_generations = 12
retained_evidence_bytes = (
    max_component_evidence_bytes * retained_evidence_generations
)
work_payload = (
    payload_bound * 2 + sqlite_scratch + retained_evidence_bytes
)
# A live component may grow by the full bounded reconciliation member set after
# admission. Charge that allowance into both simultaneously present payload
# generations (private stage plus verification extraction), as well as the
# fixed control/evidence inode allowance.
work_inodes = max_component_members * 2 + 16384
if (
    work_payload <= 0
    or work_payload > 8 * 1024**4
    or work_inodes <= 16384
    or work_inodes > 2_100_000
):
    raise SystemExit("backup work image estimate is unbounded")
# Explicit inode tables, allocation bitmaps, superblock copies, and ext4
# directory metadata must fit without consuming the admitted payload slice.
inode_overhead = work_inodes * 512
filesystem_overhead = max(
    128 * 1024**2,
    (work_payload + inode_overhead + 19) // 20,
)
work_image_bytes = (
    (work_payload + inode_overhead + filesystem_overhead + 4095) // 4096
) * 4096
if work_image_bytes > 8 * 1024**4:
    raise SystemExit("backup work image allocation is unbounded")

work_info, work_mount_id = directory_identity(backup_root)
work_root_info = os.lstat(work_root)
if (
    not stat.S_ISDIR(work_root_info.st_mode)
    or stat.S_ISLNK(work_root_info.st_mode)
    or work_root_info.st_uid != 0
    or work_root_info.st_gid != 0
    or stat.S_IMODE(work_root_info.st_mode) != 0o700
):
    raise SystemExit("backup work mountpoint is unsafe")
work_anchor = {
    "parent": str(backup_root),
    "device": work_info.st_dev,
    "inode": work_info.st_ino,
    "mountId": work_mount_id,
}

publication_targets = []
roles = set()
for target in publication_document["targets"]:
    if not isinstance(target, dict) or set(target) != {
        "role", "parent", "device", "inode", "mountId",
        "partialName", "receiptName",
    }:
        raise SystemExit("backup publication target record is invalid")
    role = target.get("role")
    parent_raw = target.get("parent")
    partial_name = target.get("partialName")
    receipt_name = target.get("receiptName")
    if (
        role not in {"complete", "degraded"}
        or role in roles
        or not isinstance(parent_raw, str)
        or not parent_raw.startswith("/")
        or os.path.normpath(parent_raw) != parent_raw
        or os.path.realpath(parent_raw) != parent_raw
        or not isinstance(partial_name, str)
        or not partial_name.startswith("portal-")
        or ".tar.gz.partial-" not in partial_name
        or "/" in partial_name
        or len(partial_name.encode("utf-8")) > 255
        or not isinstance(receipt_name, str)
        or not receipt_name.startswith("portal-")
        or not receipt_name.endswith(".tar.gz.receipt.json")
        or "/" in receipt_name
        or len(receipt_name.encode("utf-8")) > 255
    ):
        raise SystemExit("backup publication target name is unsafe")
    parent = pathlib.Path(parent_raw)
    info, mount_id = directory_identity(parent)
    if (
        target.get("device") != info.st_dev
        or target.get("inode") != info.st_ino
        or target.get("mountId") != mount_id
    ):
        raise SystemExit("backup publication target changed during admission")
    if not lease_held and (
        os.path.lexists(parent / partial_name)
        or os.path.lexists(parent / receipt_name)
    ):
        raise SystemExit("backup publication candidate path already exists")
    publication_targets.append({
        **target,
        "candidateBytes": payload_bound,
        "receiptBytes": 1024 * 1024,
    })
    roles.add(role)
if roles != {"complete", "degraded"}:
    raise SystemExit("backup publication roles are incomplete")

resources_by_mount = {}
def charge(path, device, mount_id, amount):
    key = (device, mount_id)
    entry = resources_by_mount.setdefault(key, {
        "anchor": str(path), "bytes": 0,
    })
    entry["bytes"] += amount

charge(backup_root, work_info.st_dev, work_mount_id, work_image_bytes)
for target in publication_targets:
    charge(
        pathlib.Path(target["parent"]), target["device"], target["mountId"],
        target["candidateBytes"] + target["receiptBytes"],
    )
for entry in resources_by_mount.values():
    if entry["bytes"] > 8 * 1024**4:
        raise SystemExit("backup per-device resource estimate is unbounded")
    filesystem = os.statvfs(entry["anchor"])
    free = filesystem.f_bavail * filesystem.f_frsize
    required = reserve if lease_held else entry["bytes"] + reserve
    if free < required:
        raise SystemExit(
            f"backup disk admission failed for {entry['anchor']}: "
            f"free={free} required={required} sourceBytes={source_bytes} "
            f"databaseBytes={database_bytes} payloadBound={payload_bound} reserve={reserve}"
        )
plan = {
    "schema": "bridgesllm.backup-capacity-plan.v3",
    "mode": "create",
    "reserveBytes": reserve,
    "componentCount": component_count,
    "perComponentGrowthBytes": per_component_growth,
    "components": component_bounds,
    "databaseDumpBytes": database_dump_bound,
    "basePayloadBytes": base_payload_bound,
    "growthHeadroomBytes": growth_headroom,
    "sqliteScratchBytes": sqlite_scratch,
    "evidenceHeadroomBytes": evidence_bytes,
    "maxComponentEvidenceBytes": max_component_evidence_bytes,
    "retainedEvidenceGenerations": retained_evidence_generations,
    "retainedEvidenceBytes": retained_evidence_bytes,
    "accountedBytes": payload_bound,
    "workPayloadBytes": work_payload,
    "workInodes": work_inodes,
    "workImageBytes": work_image_bytes,
    "workAnchor": work_anchor,
    "workMountPoint": str(work_root),
    "publicationTargets": sorted(
        publication_targets, key=lambda value: value["role"]
    ),
}
print(json.dumps(plan, sort_keys=True, separators=(",", ":")))
PY
)" || return 1
  if ${lease_held}; then
    # Quiescing services may legitimately shrink retained runtime files.  The
    # concrete capacity resources already held remain authoritative; re-admit
    # only when every current source/resource dimension still fits inside that
    # original plan and all topology/policy fields remain exact.
    assert_backup_capacity_revalidation_within_guard "${capacity_plan}" \
      || return 1
    capacity_plan="${BACKUP_CAPACITY_GUARD_PLAN}"
  else
    ensure_backup_capacity_guard "${capacity_plan}" || return 1
  fi
  mount_backup_capacity_work_image || return 1
  capacity_summary="$(python3 - "${capacity_plan}" \
    "${database_bytes}" <<'PY'
import json
import sys

plan = json.loads(sys.argv[1])
database_bytes = int(sys.argv[2])
print(
    "Backup disk admission passed with held capacity: "
    f"payloadBound={plan['accountedBytes']} databaseBytes={database_bytes} "
    f"components={plan['componentCount']} "
    f"perComponentGrowth={plan['perComponentGrowthBytes']} "
    f"growthHeadroom={plan['growthHeadroomBytes']} "
    f"sqliteScratch={plan['sqliteScratchBytes']} "
    f"databaseDump={plan['databaseDumpBytes']} "
    f"evidenceHeadroom={plan['evidenceHeadroomBytes']} "
    f"maxComponentEvidence={plan['maxComponentEvidenceBytes']} "
    f"retainedEvidence={plan['retainedEvidenceBytes']} "
    f"workImage={plan['workImageBytes']} workInodes={plan['workInodes']} "
    f"reservePerDevice={plan['reserveBytes']} "
    f"publicationTargets={len(plan['publicationTargets'])}"
)
PY
  )" || return 1
  log "${capacity_summary}"
}

assert_backup_verification_disk_admission() {
  local expanded_bytes="$1"
  local reserve_bytes="${BACKUP_RECOVERY_RESERVE_BYTES:-536870912}"
  local capacity_plan=""
  [[ "${expanded_bytes}" =~ ^[1-9][0-9]*$ \
    && "${expanded_bytes}" -le 2199023255552 \
    && "${reserve_bytes}" =~ ^[0-9]+$ \
    && "${reserve_bytes}" -ge 67108864 \
    && "${reserve_bytes}" -le 8589934592 \
    && -n "${BACKUP_BASE:-}" \
    && -n "${BACKUP_WORK_ROOT:-}" ]] || return 1
  if backup_capacity_guard_state_present; then
    assert_backup_capacity_guard || return 1
    [[ "${BACKUP_WORK_IMAGE_MOUNTED}" == "true" ]] || return 1
    python3 - "${BACKUP_CAPACITY_GUARD_PLAN}" "${expanded_bytes}" <<'PY'
import json
import sys

plan = json.loads(sys.argv[1])
expanded = int(sys.argv[2])
if (
    plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") != "create"
    or not isinstance(plan.get("accountedBytes"), int)
    or expanded <= 0
    or expanded > plan["accountedBytes"]
):
    raise SystemExit(1)
PY
    return
  fi
  backup_work_root_action attest || return 1
  capacity_plan="$(python3 - "${BACKUP_BASE}" "${BACKUP_WORK_ROOT}" \
    "${expanded_bytes}" "${reserve_bytes}" <<'PY'
import json
import os
import pathlib
import stat
import sys

backup_root = pathlib.Path(sys.argv[1])
work_root = pathlib.Path(sys.argv[2])
expanded = int(sys.argv[3])
reserve = int(sys.argv[4])
def identity(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        info = os.fstat(descriptor)
        values = []
        with open(
            f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii"
        ) as handle:
            for line in handle:
                if line.startswith("mnt_id:"):
                    values.append(line.partition(":")[2].strip())
        if len(values) != 1 or not values[0].isdigit():
            raise SystemExit("backup verification mount identity is unavailable")
        mount_id = int(values[0])
    finally:
        os.close(descriptor)
    if (
        not path.is_absolute()
        or os.path.normpath(path) != str(path)
        or os.path.realpath(path) != str(path)
        or not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit("backup capacity anchor is unsafe")
    return info, mount_id

anchor_info, anchor_mount = identity(backup_root)
work_info = os.lstat(work_root)
if (
    not stat.S_ISDIR(work_info.st_mode)
    or stat.S_ISLNK(work_info.st_mode)
    or work_info.st_uid != 0
    or work_info.st_gid != 0
    or stat.S_IMODE(work_info.st_mode) != 0o700
):
    raise SystemExit("backup verification work mountpoint is unsafe")
work_inodes = 8192
inode_overhead = work_inodes * 512
filesystem_overhead = max(
    128 * 1024**2,
    (expanded + inode_overhead + 19) // 20,
)
image_bytes = (
    (expanded + inode_overhead + filesystem_overhead + 4095) // 4096
) * 4096
if image_bytes <= expanded or image_bytes > 8 * 1024**4:
    raise SystemExit("backup verification work image is unbounded")
stats = os.statvfs(backup_root)
free = stats.f_bavail * stats.f_frsize
if free < image_bytes + reserve:
    raise SystemExit(
        f"backup verification disk admission failed for {backup_root}: "
        f"free={free} required={image_bytes + reserve} "
        f"expandedBytes={expanded} reserve={reserve}"
    )
plan = {
    "schema": "bridgesllm.backup-capacity-plan.v3",
    "mode": "verify",
    "reserveBytes": reserve,
    "componentCount": 0,
    "perComponentGrowthBytes": 0,
    "components": [],
    "databaseDumpBytes": 0,
    "basePayloadBytes": expanded,
    "growthHeadroomBytes": 0,
    "sqliteScratchBytes": 0,
    "evidenceHeadroomBytes": 0,
    "maxComponentEvidenceBytes": 0,
    "retainedEvidenceGenerations": 0,
    "retainedEvidenceBytes": 0,
    "accountedBytes": expanded,
    "workPayloadBytes": expanded,
    "workInodes": work_inodes,
    "workImageBytes": image_bytes,
    "workAnchor": {
        "parent": str(backup_root),
        "device": anchor_info.st_dev,
        "inode": anchor_info.st_ino,
        "mountId": anchor_mount,
    },
    "workMountPoint": str(work_root),
    "publicationTargets": [],
}
print(json.dumps(plan, sort_keys=True, separators=(",", ":")))
PY
)" || return 1
  ensure_backup_capacity_guard "${capacity_plan}" || return 1
  mount_backup_capacity_work_image || return 1
  assert_backup_capacity_guard "${capacity_plan}"
}

quiesce_comprehensive_backup_sources() {
  assert_backup_crash_persistent_control_filesystems || return 1
  BACKUP_QUIESCE_ACTIVE=true
  if ! python3 - "${QUIESCENCE_JOURNAL}" "${QUIESCENCE_BLOCKER}" \
    "${QUIESCENCE_COMMIT}" \
    "${BACKUP_SYSTEMCTL_BIN}" \
    "${BACKUP_DOCKER_BIN}" "${RUN_ID}" "${PORTAL_DIR}/backend/package.json" \
    "${SYSTEMD_DIR}" "${BACKUP_FENCE_NAME}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import ctypes
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time

journal_path, blocker_path, commit_path, systemctl, docker, run_id, version_path, systemd_root, fence_name, *unit_names = sys.argv[1:]
if (
    not unit_names
    or len(unit_names) != len(set(unit_names))
    or not re.fullmatch(r"[A-Za-z0-9.-]{1,128}", fence_name)
):
    raise RuntimeError("backup mutator unit inventory is invalid")
version_info = os.lstat(version_path)
if (
    not stat.S_ISREG(version_info.st_mode)
    or stat.S_ISLNK(version_info.st_mode)
    or version_info.st_uid != 0
    or version_info.st_gid != 0
    or version_info.st_nlink != 1
    or version_info.st_mode & 0o022
    or version_info.st_size <= 0
    or version_info.st_size > 64 * 1024
):
    raise RuntimeError("Portal package version authority is unsafe")
portal_version = json.load(open(version_path, "r", encoding="utf-8")).get("version")
if (
    not isinstance(portal_version, str)
    or not re.fullmatch(
        r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?",
        portal_version,
    )
):
    raise RuntimeError("Portal package version is invalid")
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
WORKLOAD_POLICY = "portal-project-workload-v1"
EGRESS_POLICY = "portal-project-egress-v1"
LABEL_WORKLOAD_POLICY = "com.bridgesllm.project-workload.policy"
LABEL_WORKLOAD_ACTOR = "com.bridgesllm.project-workload.actor-id"
LABEL_WORKLOAD_PROJECT = "com.bridgesllm.project-workload.project-id"
LABEL_WORKLOAD_KIND = "com.bridgesllm.project-workload.kind"
LABEL_WORKLOAD_ID = "com.bridgesllm.project-workload.workload-id"
LABEL_EGRESS_POLICY = "com.bridgesllm.project-egress.policy"
LABEL_EGRESS_IDENTITY = "com.bridgesllm.project-egress.identity"
LABEL_EGRESS_ACTOR = "com.bridgesllm.project-egress.actor-id"
LABEL_EGRESS_PROJECT = "com.bridgesllm.project-egress.project-id"
LABEL_EGRESS_PROVIDER = "com.bridgesllm.project-egress.provider"
LABEL_EGRESS_CONSUMER = "com.bridgesllm.project-egress.consumer-kind"
LABEL_EGRESS_WORKLOAD = "com.bridgesllm.project-egress.workload-id"
LABEL_EGRESS_ROLE = "com.bridgesllm.project-egress.role"
LABEL_EGRESS_FINGERPRINT = "com.bridgesllm.project-egress.fingerprint"
LABEL_RUNTIME_FINGERPRINT = "com.bridgesllm.project-egress.runtime-fingerprint"

def bounded_diagnostic(value, limit=512):
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "?", str(value))
    text = re.sub(r"(?i)\bbearer\s+[^\s,;]+", "Bearer <redacted>", text)
    text = re.sub(
        r"(?i)([\"']?[A-Za-z0-9_.-]*"
        r"(?:token|secret|password|passwd|pwd|authorization|credential|"
        r"api[-_]?key|access[-_]?key)"
        r"[A-Za-z0-9_.-]*[\"']?\s*[:=]\s*)"
        r"(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)",
        r"\1<redacted>",
        text,
    )
    text = re.sub(
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s,;]+", "<redacted-url>", text
    )
    return text if len(text) <= limit else text[:limit] + "..."

def command_failure(label, executable, arguments, result=None, timed_out=False):
    rendered = []
    redact_next = False
    for argument in arguments[:12]:
        original = str(argument)
        sensitive = re.search(
            r"(?i)(token|secret|password|passwd|authorization|credential|"
            r"api[-_]?key|access[-_]?key)",
            original,
        ) is not None
        value = original
        if redact_next or sensitive:
            value = "<redacted>"
        redact_next = (
            sensitive
            and "=" not in original
            and re.fullmatch(r"--?[A-Za-z0-9_.-]+", original) is not None
        )
        rendered.append(bounded_diagnostic(value, 96))
    if len(arguments) > 12:
        rendered.append("...")
    verb = bounded_diagnostic(os.path.basename(executable), 64)
    command = " ".join([verb, *rendered])
    if timed_out:
        return RuntimeError(f"{label} command timed out: {command}")
    stderr = bounded_diagnostic((result.stderr or "").strip(), 512) or "<no stderr>"
    return RuntimeError(
        f"{label} command failed: {command} (exit {result.returncode}): {stderr}"
    )

def execute(executable, arguments):
    # The complete backup runs in a private PID namespace while retaining the
    # host systemd filesystem. Plain systemctl tries to bind to namespace PID
    # 1 and fails before reaching the host manager. The explicit .host
    # transport keeps the systemd authority on the real host without dropping
    # the PID namespace that contains backup descendants after a crash.
    arguments = (
        ["--machine=.host", *arguments]
        if executable == systemctl else list(arguments)
    )
    try:
        return subprocess.run(
            [executable, *arguments], check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
            env={
                "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            },
        )
    except subprocess.TimeoutExpired:
        raise command_failure(
            "backup quiescence", executable, arguments, timed_out=True
        ) from None

def run(executable, arguments):
    result = execute(executable, arguments)
    if result.returncode != 0:
        raise command_failure("backup quiescence", executable, arguments, result)
    return result.stdout

def run_container_inspect(reference, *, allow_absent=False):
    arguments = ["container", "inspect", reference]
    result = execute(docker, arguments)
    if result.returncode == 0:
        return result.stdout
    absent = result.returncode == 1 and any(
        marker in (result.stderr or "").lower()
        for marker in ("no such container", "no such object", "not found")
    )
    if allow_absent and absent:
        return None
    raise command_failure("backup quiescence", docker, arguments, result)

def unit_state(name):
    load = run(
        systemctl, ["show", "--property=LoadState", "--value", name]
    ).strip()
    active = run(
        systemctl, ["show", "--property=ActiveState", "--value", name]
    ).strip()
    if load not in {"loaded", "not-found", "masked"}:
        raise RuntimeError("unsupported systemd load state")
    if active not in {"active", "inactive"}:
        raise RuntimeError("systemd unit is failed or transitioning during backup admission")
    if active == "active" and load != "loaded":
        raise RuntimeError("active systemd unit is not loaded")
    return {"name": name, "loadState": load, "activeState": active}

def fsync_directory(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def install_blocker():
    content = (
        "bridgesllm-backup-quiescence-v1\n"
        f"runId={run_id}\n"
    ).encode("utf-8")
    if os.path.lexists(blocker_path):
        raise RuntimeError("backup quiescence blocker already exists")
    descriptor, temporary = tempfile.mkstemp(prefix=".quiescence-blocker.", dir=parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.lexists(blocker_path):
            raise RuntimeError("backup quiescence blocker appeared concurrently")
        os.replace(temporary, blocker_path)
        temporary = ""
        fsync_directory(parent)
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

def fence_content():
    return (
        "[Unit]\n"
        f"ConditionPathExists=!{blocker_path}\n"
    ).encode("utf-8")

def ensure_fences(*, allow_existing):
    root_info = os.lstat(systemd_root)
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or stat.S_ISLNK(root_info.st_mode)
        or root_info.st_uid != 0
        or root_info.st_gid != 0
        or root_info.st_mode & 0o022
    ):
        raise RuntimeError("backup systemd fence root is unsafe")
    by_name = {entry["name"]: entry for entry in units}
    for name in unit_names:
        content = fence_content()
        record = by_name[name]
        directory = os.path.join(systemd_root, f"{name}.d")
        if not os.path.lexists(directory):
            if record["fenceDirectoryExisted"]:
                raise RuntimeError("backup systemd fence directory disappeared")
            os.mkdir(directory, 0o700)
            fsync_directory(systemd_root)
        directory_info = os.lstat(directory)
        if (
            not stat.S_ISDIR(directory_info.st_mode)
            or stat.S_ISLNK(directory_info.st_mode)
            or directory_info.st_uid != 0
            or directory_info.st_gid != 0
            or directory_info.st_mode & 0o022
        ):
            raise RuntimeError("backup systemd fence directory is unsafe")
        if record["fenceDirectoryExisted"] and (
            directory_info.st_dev != record["fenceDirectoryDevice"]
            or directory_info.st_ino != record["fenceDirectoryInode"]
            or stat.S_IMODE(directory_info.st_mode)
                != record["fenceDirectoryMode"]
        ):
            raise RuntimeError("backup systemd fence directory identity changed")
        target = os.path.join(directory, fence_name)
        if os.path.lexists(target):
            target_info = os.lstat(target)
            if (
                not allow_existing
                or not stat.S_ISREG(target_info.st_mode)
                or stat.S_ISLNK(target_info.st_mode)
                or target_info.st_uid != 0
                or target_info.st_gid != 0
                or target_info.st_nlink != 1
                or target_info.st_mode & 0o022
                or open(target, "rb").read() != content
            ):
                raise RuntimeError("backup systemd fence is unsafe or contradictory")
            continue
        descriptor, temporary = tempfile.mkstemp(prefix=".backup-fence.", dir=directory)
        try:
            os.fchmod(descriptor, 0o644)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            temporary = ""
            fsync_directory(directory)
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
    fsync_directory(systemd_root)
    run(systemctl, ["daemon-reload"])

def require_opaque_label(labels, key):
    value = labels.get(key)
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > 512
        or re.search(r"[\x00-\x1f\x7f]", value)
    ):
        raise RuntimeError("managed Docker identity label is invalid")
    return value

def inspect_container(reference, *, required_id=None, allow_absent=False):
    raw = run_container_inspect(reference, allow_absent=allow_absent)
    if raw is None:
        return None
    payload = json.loads(raw)
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("ambiguous Docker inspection")
    container = payload[0]
    identifier = container.get("Id")
    if (
        not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or (required_id is not None and identifier != required_id)
    ):
        raise RuntimeError("Docker immutable identity changed")
    name = str(container.get("Name") or "").lstrip("/")
    if not name or len(name.encode("utf-8")) > 255:
        raise RuntimeError("invalid Docker container name")
    labels = ((container.get("Config") or {}).get("Labels") or {})
    if not isinstance(labels, dict):
        raise RuntimeError("invalid Docker label map")
    claims = {key: labels.get(key) for key in selectors if key in labels}
    if any(value not in selectors[key] for key, value in claims.items()):
        raise RuntimeError("Project runtime labels contradict the managed contract")
    runtime_fingerprint = labels.get(LABEL_RUNTIME_FINGERPRINT)
    openclaw_identity = labels.get("com.bridgesllm.openclaw-project.identity")
    if runtime_fingerprint is not None:
        if not isinstance(runtime_fingerprint, str) or not re.fullmatch(
            r"[a-f0-9]{64}", runtime_fingerprint
        ):
            raise RuntimeError("Project runtime fingerprint is invalid")
        claims[LABEL_RUNTIME_FINGERPRINT] = runtime_fingerprint
    if labels.get(LABEL_WORKLOAD_POLICY) == WORKLOAD_POLICY:
        actor = require_opaque_label(labels, LABEL_WORKLOAD_ACTOR)
        project = require_opaque_label(labels, LABEL_WORKLOAD_PROJECT)
        kind = require_opaque_label(labels, LABEL_WORKLOAD_KIND)
        workload = require_opaque_label(labels, LABEL_WORKLOAD_ID)
        if kind not in {"PORTAL_GIT", "PORTAL_LIFECYCLE", "PORTAL_APP"}:
            raise RuntimeError("Portal workload kind is invalid")
        discriminator = (
            actor + "\0" + project + "\0" + workload
            if kind == "PORTAL_GIT"
            else actor + "\0" + project + "\0"
                + ("app" if kind == "PORTAL_APP" else "job") + "\0" + workload
        )
        prefix = {
            "PORTAL_GIT": "bridgesllm-project-git",
            "PORTAL_LIFECYCLE": "bridgesllm-project-job",
            "PORTAL_APP": "bridgesllm-project-app",
        }[kind]
        expected_name = prefix + "-" + hashlib.sha256(
            discriminator.encode("utf-8")
        ).hexdigest()[:20]
        if name != expected_name or runtime_fingerprint is None:
            raise RuntimeError("Portal workload durable identity is invalid")
        claims.update({
            LABEL_WORKLOAD_ACTOR: actor,
            LABEL_WORKLOAD_PROJECT: project,
            LABEL_WORKLOAD_KIND: kind,
            LABEL_WORKLOAD_ID: workload,
        })
    if labels.get(LABEL_EGRESS_POLICY) == EGRESS_POLICY:
        identity = require_opaque_label(labels, LABEL_EGRESS_IDENTITY)
        actor = require_opaque_label(labels, LABEL_EGRESS_ACTOR)
        project = require_opaque_label(labels, LABEL_EGRESS_PROJECT)
        provider = require_opaque_label(labels, LABEL_EGRESS_PROVIDER)
        role = require_opaque_label(labels, LABEL_EGRESS_ROLE)
        policy_fingerprint = require_opaque_label(labels, LABEL_EGRESS_FINGERPRINT)
        if (
            not re.fullmatch(r"[a-f0-9]{64}", identity)
            or not re.fullmatch(r"[a-f0-9]{64}", policy_fingerprint)
            or role != "proxy"
            or name != "p4e-proxy-" + identity[:20]
        ):
            raise RuntimeError("Project egress proxy identity is invalid")
        identity_document = {
            "actorId": actor,
            "projectId": project,
            "provider": provider,
        }
        consumer = labels.get(LABEL_EGRESS_CONSUMER)
        workload = labels.get(LABEL_EGRESS_WORKLOAD)
        if provider == "PORTAL_WORKLOAD":
            consumer = require_opaque_label(labels, LABEL_EGRESS_CONSUMER)
            workload = require_opaque_label(labels, LABEL_EGRESS_WORKLOAD)
            if consumer not in {"PORTAL_GIT", "PORTAL_LIFECYCLE", "PORTAL_APP"}:
                raise RuntimeError("Project egress workload identity is invalid")
            identity_document.update({
                "consumerKind": consumer,
                "workloadId": workload,
            })
        elif consumer is not None or workload is not None:
            raise RuntimeError("Provider egress identity carries workload labels")
        encoded_identity = json.dumps(
            identity_document, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if hashlib.sha256(encoded_identity).hexdigest() != identity:
            raise RuntimeError("Project egress identity fingerprint changed")
        claims.update({
            LABEL_EGRESS_IDENTITY: identity,
            LABEL_EGRESS_ACTOR: actor,
            LABEL_EGRESS_PROJECT: project,
            LABEL_EGRESS_PROVIDER: provider,
            LABEL_EGRESS_ROLE: role,
            LABEL_EGRESS_FINGERPRINT: policy_fingerprint,
            **({
                LABEL_EGRESS_CONSUMER: consumer,
                LABEL_EGRESS_WORKLOAD: workload,
            } if provider == "PORTAL_WORKLOAD" else {}),
        })
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
        claims["com.bridgesllm.openclaw-project.identity"] = openclaw_identity
        claims["openclaw.sandbox"] = "1"
    running = (container.get("State") or {}).get("Running")
    if not isinstance(running, bool):
        raise RuntimeError("invalid Docker running state")
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    policy_name = policy.get("Name")
    maximum_retry_count = policy.get("MaximumRetryCount")
    if (
        policy_name not in {"no", "always", "unless-stopped", "on-failure"}
        or not isinstance(maximum_retry_count, int)
        or isinstance(maximum_retry_count, bool)
        or maximum_retry_count < 0
        or (policy_name != "on-failure" and maximum_retry_count != 0)
    ):
        raise RuntimeError("invalid Docker restart policy")
    return container, {
        "id": identifier,
        "name": name,
        "claims": claims,
        "wasRunning": running,
        "restartPolicy": {
            "name": policy_name,
            "maximumRetryCount": maximum_retry_count,
        },
    }

units = []
for name in unit_names:
    state = unit_state(name)
    if name == "stalwart-cert-sync.service" and state["activeState"] == "active":
        for _ in range(60):
            time.sleep(1)
            state = unit_state(name)
            if state["activeState"] == "inactive":
                break
        if state["activeState"] != "inactive":
            raise RuntimeError("transient certificate sync did not settle")
    units.append(state)
containers = []
stalwart_seen = False
identifiers = run(
    docker,
    ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
).splitlines()
if len(identifiers) > 100_000:
    raise RuntimeError("Docker inventory is unbounded")
seen_identifiers = set()
for identifier in identifiers:
    identifier = identifier.strip()
    if not identifier:
        continue
    if not re.fullmatch(r"[a-f0-9]{64}", identifier) or identifier in seen_identifiers:
        raise RuntimeError("invalid Docker identity")
    seen_identifiers.add(identifier)
    inspected = inspect_container(identifier, required_id=identifier)
    if inspected is None:
        raise RuntimeError("listed Docker container disappeared")
    _, record = inspected
    is_stalwart = record["name"] == "stalwart-mail"
    if is_stalwart:
        if stalwart_seen:
            raise RuntimeError("ambiguous Stalwart container identity")
        stalwart_seen = True
    if is_stalwart or record["claims"]:
        containers.append(record)
        if len(containers) > 4096:
            raise RuntimeError("managed Docker recovery inventory is unbounded")

portal_was_active = any(
    unit["name"] == "bridgesllm-product.service"
    and unit["activeState"] == "active"
    for unit in units
)
# Schema v3 separates immutable runtimes from the app resources Portal owns
# through durable database intent. Portal's graceful shutdown removes the
# latter before this process reaches Docker; only fully attested PORTAL_APP
# workloads and their exact egress identities may cross that deletion boundary.
for record in containers:
    record["recoveryStrategy"] = "exact"
if portal_was_active:
    app_records = {}
    proxy_records = {}
    for record in containers:
        claims = record["claims"]
        if (
            claims.get(LABEL_WORKLOAD_POLICY) == WORKLOAD_POLICY
            and claims.get(LABEL_WORKLOAD_KIND) == "PORTAL_APP"
            and record["restartPolicy"] == {"name": "no", "maximumRetryCount": 0}
        ):
            key = (
                claims[LABEL_WORKLOAD_ACTOR],
                claims[LABEL_WORKLOAD_PROJECT],
                claims[LABEL_WORKLOAD_ID],
            )
            if key in app_records:
                raise RuntimeError("duplicate Portal app recovery identity")
            app_records[key] = record
        if (
            claims.get(LABEL_EGRESS_POLICY) == EGRESS_POLICY
            and claims.get(LABEL_EGRESS_PROVIDER) == "PORTAL_WORKLOAD"
            and claims.get(LABEL_EGRESS_CONSUMER) == "PORTAL_APP"
            and record["restartPolicy"] == {"name": "no", "maximumRetryCount": 0}
        ):
            key = (
                claims[LABEL_EGRESS_ACTOR],
                claims[LABEL_EGRESS_PROJECT],
                claims[LABEL_EGRESS_WORKLOAD],
            )
            if key in proxy_records:
                raise RuntimeError("duplicate Portal app egress recovery identity")
            proxy_records[key] = record
    for key, proxy in proxy_records.items():
        app = app_records.get(key)
        proxy_runtime_fingerprint = proxy["claims"].get(
            LABEL_RUNTIME_FINGERPRINT
        )
        if (
            app is None
            or (
                proxy_runtime_fingerprint is not None
                and app["claims"].get(LABEL_RUNTIME_FINGERPRINT)
                    != proxy_runtime_fingerprint
            )
        ):
            raise RuntimeError("Portal app egress has no attested durable owner")
        proxy["recoveryStrategy"] = "portal-reconcile"
    for app in app_records.values():
        app["recoveryStrategy"] = "portal-reconcile"

parent = os.path.dirname(journal_path)
parent_info = os.lstat(parent)
if (
    not os.path.isabs(journal_path)
    or os.path.normpath(journal_path) != journal_path
    or not os.path.isabs(blocker_path)
    or os.path.normpath(blocker_path) != blocker_path
    or not os.path.isabs(commit_path)
    or os.path.normpath(commit_path) != commit_path
    or os.path.dirname(blocker_path) != parent
    or os.path.dirname(commit_path) != parent
    or blocker_path == journal_path
    or commit_path in {journal_path, blocker_path}
    or not stat.S_ISDIR(parent_info.st_mode)
    or stat.S_ISLNK(parent_info.st_mode)
    or parent_info.st_uid != 0
    or parent_info.st_gid != 0
    or parent_info.st_mode & 0o022
    or os.path.lexists(journal_path)
    or os.path.lexists(blocker_path)
    or os.path.lexists(commit_path)
):
    raise RuntimeError("backup quiescence journal boundary is unsafe")
root_info = os.lstat(systemd_root)
if (
    not stat.S_ISDIR(root_info.st_mode)
    or stat.S_ISLNK(root_info.st_mode)
    or root_info.st_uid != 0
    or root_info.st_gid != 0
    or root_info.st_mode & 0o022
):
    raise RuntimeError("backup systemd fence root is unsafe")
for unit in units:
    directory = os.path.join(systemd_root, f"{unit['name']}.d")
    existed = os.path.lexists(directory)
    if existed:
        directory_info = os.lstat(directory)
        if (
            not stat.S_ISDIR(directory_info.st_mode)
            or stat.S_ISLNK(directory_info.st_mode)
            or directory_info.st_uid != 0
            or directory_info.st_gid != 0
            or directory_info.st_mode & 0o022
        ):
            raise RuntimeError("backup systemd fence directory is unsafe")
        unit["fenceDirectoryDevice"] = directory_info.st_dev
        unit["fenceDirectoryInode"] = directory_info.st_ino
        unit["fenceDirectoryMode"] = stat.S_IMODE(directory_info.st_mode)
    else:
        unit["fenceDirectoryDevice"] = None
        unit["fenceDirectoryInode"] = None
        unit["fenceDirectoryMode"] = None
    unit["fenceDirectoryExisted"] = existed

# Install and durably reload every boot fence before publishing the journal.
# The separate blocker is created only after that journal is durable and every
# recorded Docker restart policy has been neutralized, before any source is
# stopped. A crash before the blocker therefore leaves live state and a
# retryable journal; a crash after it cannot auto-start either a fenced unit or
# a recorded container during reboot.
ensure_fences(allow_existing=True)
journal = {
    "schemaVersion": 3,
    "runId": run_id,
    "portalVersion": portal_version,
    "units": units,
    "containers": containers,
}
encoded_journal = (
    json.dumps(journal, sort_keys=True, separators=(",", ":")) + "\n"
).encode("utf-8")
if len(encoded_journal) > 900 * 1024:
    raise RuntimeError("backup quiescence journal is unbounded")
descriptor, temporary = tempfile.mkstemp(prefix=".quiescence.", dir=parent)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encoded_journal)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, journal_path)
    directory_descriptor = os.open(
        parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    )
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
def locate_record(record):
    inspected = inspect_container(
        record["id"], required_id=record["id"],
        allow_absent=record["recoveryStrategy"] == "portal-reconcile",
    )
    if inspected is None and record["recoveryStrategy"] == "portal-reconcile":
        inspected = inspect_container(record["name"], allow_absent=True)
    if inspected is None:
        return None
    _, current = inspected
    if current["name"] != record["name"] or current["claims"] != record["claims"]:
        raise RuntimeError("managed Docker recovery identity changed")
    if record["recoveryStrategy"] == "exact" and current["id"] != record["id"]:
        raise RuntimeError("exact Docker recovery identity changed")
    return current

# Docker restart policies are the container boot fence. Install and attest all
# of them before publishing the blocker that makes the systemd fences active.
# Until that point services and containers remain live, so a crash cannot leave
# a partially quiesced source able to mutate after reboot.
for record in containers:
    current = locate_record(record)
    if current is None:
        continue
    if current["restartPolicy"]["name"] != "no":
        run(docker, ["container", "update", "--restart=no", current["id"]])
    current = locate_record(record)
    if (
        current is None
        or current["name"] != record["name"]
        or current["claims"] != record["claims"]
        or current["restartPolicy"] != {"name": "no", "maximumRetryCount": 0}
    ):
        raise RuntimeError("managed Docker restart fence did not converge")

install_blocker()
for unit in units:
    current = unit_state(unit["name"])
    if current["activeState"] == "active":
        run(systemctl, ["stop", unit["name"]])
    stopped = unit_state(unit["name"])
    if stopped["loadState"] != unit["loadState"] or stopped["activeState"] != "inactive":
        raise RuntimeError("systemd unit did not quiesce")
# Service shutdown may reconcile or remove Portal-owned containers. Before
# stopping any surviving container, re-attest that every recorded runtime still
# present retains restart=no. Database capture cannot begin if that boot fence
# drifted during shutdown.
for record in containers:
    current = locate_record(record)
    if current is None:
        continue
    if current["restartPolicy"] != {"name": "no", "maximumRetryCount": 0}:
        raise RuntimeError("managed Docker restart fence drifted during shutdown")
for record in containers:
    current = locate_record(record)
    if current is None:
        continue
    if current["wasRunning"]:
        run(docker, ["container", "stop", "--time", "30", current["id"]])
    current = locate_record(record)
    if current is None:
        continue
    if (
        current["name"] != record["name"]
        or current["claims"] != record["claims"]
        or current["restartPolicy"] != {"name": "no", "maximumRetryCount": 0}
        or current["wasRunning"]
    ):
        raise RuntimeError("managed Docker runtime did not quiesce")
PY
  then
    return 1
  fi
  log "Portal backup sources quiesced under the Portal operation lock"
}

restore_backup_runtime_state() {
  local recovery_mode="$1"
  [[ "${recovery_mode}" == "quiesce-only" \
    || "${recovery_mode}" == "restore-recorded" ]] || return 1
  [[ -f "${QUIESCENCE_JOURNAL}" && ! -L "${QUIESCENCE_JOURNAL}" ]] || return 1
  python3 - "${QUIESCENCE_JOURNAL}" "${QUIESCENCE_BLOCKER}" \
    "${QUIESCENCE_COMMIT}" \
    "${BACKUP_SYSTEMCTL_BIN}" \
    "${BACKUP_DOCKER_BIN}" "${BACKUP_CURL_BIN}" "${SYSTEMD_DIR}" \
    "${BACKUP_FENCE_NAME}" "${recovery_mode}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

journal_path, blocker_path, commit_path, systemctl, docker, curl, systemd_root, fence_name, recovery_mode, *unit_names = sys.argv[1:]
if recovery_mode not in {"quiesce-only", "restore-recorded"}:
    raise SystemExit("backup recovery mode is invalid")
info = os.lstat(journal_path)
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
    raise SystemExit("backup quiescence journal is unsafe")
with open(journal_path, "rb") as handle:
    journal_raw = handle.read(1024 * 1024 + 1)
if not journal_raw or len(journal_raw) > 1024 * 1024:
    raise SystemExit("backup quiescence journal is unbounded")
try:
    journal = json.loads(journal_raw.decode("utf-8"))
except (UnicodeError, json.JSONDecodeError):
    raise SystemExit("backup quiescence journal is invalid") from None
journal_digest = hashlib.sha256(journal_raw).hexdigest()
schema_version = journal.get("schemaVersion") if isinstance(journal, dict) else None
if (
    not isinstance(journal, dict)
    or set(journal) != {
        "schemaVersion", "runId", "portalVersion", "units", "containers"
    }
    or schema_version not in {2, 3}
    or not isinstance(journal.get("runId"), str)
    or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", journal["runId"])
    or not isinstance(journal.get("portalVersion"), str)
    or not re.fullmatch(
        r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?",
        journal["portalVersion"],
    )
    or not isinstance(journal.get("units"), list)
    or not isinstance(journal.get("containers"), list)
):
    raise SystemExit("backup quiescence journal schema is invalid")
parent = os.path.dirname(journal_path)
try:
    parent_info = os.lstat(parent)
except OSError:
    raise SystemExit("backup quiescence control directory is unavailable")
if (
    not os.path.isabs(journal_path)
    or os.path.normpath(journal_path) != journal_path
    or not os.path.isabs(blocker_path)
    or os.path.normpath(blocker_path) != blocker_path
    or not os.path.isabs(commit_path)
    or os.path.normpath(commit_path) != commit_path
    or os.path.dirname(blocker_path) != parent
    or os.path.dirname(commit_path) != parent
    or blocker_path == journal_path
    or commit_path in {journal_path, blocker_path}
    or not stat.S_ISDIR(parent_info.st_mode)
    or stat.S_ISLNK(parent_info.st_mode)
    or parent_info.st_uid != 0
    or parent_info.st_gid != 0
    or parent_info.st_mode & 0o022
):
    raise SystemExit("backup quiescence control boundary is unsafe")

WORKLOAD_POLICY = "portal-project-workload-v1"
EGRESS_POLICY = "portal-project-egress-v1"
LABEL_WORKLOAD_POLICY = "com.bridgesllm.project-workload.policy"
LABEL_WORKLOAD_ACTOR = "com.bridgesllm.project-workload.actor-id"
LABEL_WORKLOAD_PROJECT = "com.bridgesllm.project-workload.project-id"
LABEL_WORKLOAD_KIND = "com.bridgesllm.project-workload.kind"
LABEL_WORKLOAD_ID = "com.bridgesllm.project-workload.workload-id"
LABEL_EGRESS_POLICY = "com.bridgesllm.project-egress.policy"
LABEL_EGRESS_IDENTITY = "com.bridgesllm.project-egress.identity"
LABEL_EGRESS_ACTOR = "com.bridgesllm.project-egress.actor-id"
LABEL_EGRESS_PROJECT = "com.bridgesllm.project-egress.project-id"
LABEL_EGRESS_PROVIDER = "com.bridgesllm.project-egress.provider"
LABEL_EGRESS_CONSUMER = "com.bridgesllm.project-egress.consumer-kind"
LABEL_EGRESS_WORKLOAD = "com.bridgesllm.project-egress.workload-id"
LABEL_EGRESS_ROLE = "com.bridgesllm.project-egress.role"
LABEL_EGRESS_FINGERPRINT = "com.bridgesllm.project-egress.fingerprint"
LABEL_RUNTIME_FINGERPRINT = "com.bridgesllm.project-egress.runtime-fingerprint"

def bounded_diagnostic(value, limit=512):
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "?", str(value))
    text = re.sub(r"(?i)\bbearer\s+[^\s,;]+", "Bearer <redacted>", text)
    text = re.sub(
        r"(?i)([\"']?[A-Za-z0-9_.-]*"
        r"(?:token|secret|password|passwd|pwd|authorization|credential|"
        r"api[-_]?key|access[-_]?key)"
        r"[A-Za-z0-9_.-]*[\"']?\s*[:=]\s*)"
        r"(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)",
        r"\1<redacted>",
        text,
    )
    text = re.sub(
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s,;]+", "<redacted-url>", text
    )
    return text if len(text) <= limit else text[:limit] + "..."

def command_failure(label, executable, arguments, result=None, timed_out=False):
    rendered = []
    redact_next = False
    for argument in arguments[:12]:
        original = str(argument)
        sensitive = re.search(
            r"(?i)(token|secret|password|passwd|authorization|credential|"
            r"api[-_]?key|access[-_]?key)",
            original,
        ) is not None
        value = original
        if redact_next or sensitive:
            value = "<redacted>"
        redact_next = (
            sensitive
            and "=" not in original
            and re.fullmatch(r"--?[A-Za-z0-9_.-]+", original) is not None
        )
        rendered.append(bounded_diagnostic(value, 96))
    if len(arguments) > 12:
        rendered.append("...")
    command = " ".join([
        bounded_diagnostic(os.path.basename(executable), 64), *rendered
    ])
    if timed_out:
        return RuntimeError(f"{label} command timed out: {command}")
    stderr = bounded_diagnostic((result.stderr or "").strip(), 512) or "<no stderr>"
    return RuntimeError(
        f"{label} command failed: {command} (exit {result.returncode}): {stderr}"
    )

def execute(executable, arguments):
    # Recovery executes under the same private PID namespace as capture. Keep
    # every systemd observation and mutation on the explicit host transport.
    arguments = (
        ["--machine=.host", *arguments]
        if executable == systemctl else list(arguments)
    )
    try:
        return subprocess.run(
            [executable, *arguments], check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
            env={
                "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            },
        )
    except subprocess.TimeoutExpired:
        raise command_failure(
            "backup recovery", executable, arguments, timed_out=True
        ) from None

def run(executable, arguments):
    result = execute(executable, arguments)
    if result.returncode != 0:
        raise command_failure("backup recovery", executable, arguments, result)
    return result.stdout

def run_container_inspect(reference, *, allow_absent=False):
    arguments = ["container", "inspect", reference]
    result = execute(docker, arguments)
    if result.returncode == 0:
        return result.stdout
    absent = result.returncode == 1 and any(
        marker in (result.stderr or "").lower()
        for marker in ("no such container", "no such object", "not found")
    )
    if allow_absent and absent:
        return None
    raise command_failure("backup recovery", docker, arguments, result)

def unit_state(name):
    load = run(
        systemctl, ["show", "--property=LoadState", "--value", name]
    ).strip()
    active = run(
        systemctl, ["show", "--property=ActiveState", "--value", name]
    ).strip()
    if load not in {"loaded", "not-found", "masked"}:
        raise RuntimeError("unsupported systemd load state during backup recovery")
    if active not in {"active", "inactive"}:
        raise RuntimeError("systemd unit is transitioning during backup recovery")
    return load, active

def fsync_directory(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def blocker_content():
    return (
        "bridgesllm-backup-quiescence-v1\n"
        f"runId={journal['runId']}\n"
    ).encode("utf-8")

def validate_blocker():
    info = os.lstat(blocker_path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or open(blocker_path, "rb").read(4096) != blocker_content()
    ):
        raise RuntimeError("backup quiescence blocker is unsafe")

def ensure_blocker():
    if os.path.lexists(blocker_path):
        validate_blocker()
        return
    descriptor, temporary = tempfile.mkstemp(
        prefix=".quiescence-blocker.", dir=parent
    )
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(blocker_content())
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.lexists(blocker_path):
            validate_blocker()
        else:
            os.replace(temporary, blocker_path)
            temporary = ""
            fsync_directory(parent)
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

def remove_blocker():
    validate_blocker()
    os.unlink(blocker_path)
    fsync_directory(parent)

def commit_content():
    return (
        "bridgesllm-backup-recovery-commit-v1\n"
        f"runId={journal['runId']}\n"
        f"journalSha256={journal_digest}\n"
    ).encode("ascii")

def validate_commit():
    commit_info = os.lstat(commit_path)
    if (
        not stat.S_ISREG(commit_info.st_mode)
        or stat.S_ISLNK(commit_info.st_mode)
        or commit_info.st_uid != 0
        or commit_info.st_gid != 0
        or commit_info.st_nlink != 1
        or stat.S_IMODE(commit_info.st_mode) != 0o600
        or open(commit_path, "rb").read(4096) != commit_content()
    ):
        raise RuntimeError("backup recovery commit is unsafe")

def install_commit():
    if os.path.lexists(commit_path):
        validate_commit()
        return
    descriptor, temporary = tempfile.mkstemp(
        prefix=".quiescence-commit.", dir=parent
    )
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(commit_content())
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.lexists(commit_path):
            validate_commit()
        else:
            os.replace(temporary, commit_path)
            temporary = ""
            fsync_directory(parent)
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

def remove_commit():
    validate_commit()
    os.unlink(commit_path)
    fsync_directory(parent)

def fence_content():
    return (
        "[Unit]\n"
        f"ConditionPathExists=!{blocker_path}\n"
    ).encode("utf-8")

def ensure_fences():
    root_info = os.lstat(systemd_root)
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or stat.S_ISLNK(root_info.st_mode)
        or root_info.st_uid != 0
        or root_info.st_gid != 0
        or root_info.st_mode & 0o022
    ):
        raise RuntimeError("backup recovery fence root is unsafe")
    legacy_content = (
        "[Unit]\n"
        f"ConditionPathExists=!{journal_path}\n"
    ).encode("utf-8")
    by_name = {entry["name"]: entry for entry in journal["units"]}
    inspected_targets = []
    for name in unit_names:
        content = fence_content()
        record = by_name[name]
        directory = os.path.join(systemd_root, f"{name}.d")
        if not os.path.lexists(directory):
            if schema_version == 2:
                raise RuntimeError("legacy backup recovery fence disappeared")
            if record["fenceDirectoryExisted"]:
                raise RuntimeError("backup recovery fence directory disappeared")
            os.mkdir(directory, 0o700)
            fsync_directory(systemd_root)
        directory_info = os.lstat(directory)
        if (
            not stat.S_ISDIR(directory_info.st_mode)
            or stat.S_ISLNK(directory_info.st_mode)
            or directory_info.st_uid != 0
            or directory_info.st_gid != 0
            or directory_info.st_mode & 0o022
        ):
            raise RuntimeError("backup recovery fence directory is unsafe")
        if record["fenceDirectoryExisted"] and (
            directory_info.st_dev != record["fenceDirectoryDevice"]
            or directory_info.st_ino != record["fenceDirectoryInode"]
            or stat.S_IMODE(directory_info.st_mode)
                != record["fenceDirectoryMode"]
        ):
            raise RuntimeError("backup recovery fence directory identity changed")
        target = os.path.join(directory, fence_name)
        if os.path.lexists(target):
            target_info = os.lstat(target)
            payload = open(target, "rb").read(4096)
            if (
                not stat.S_ISREG(target_info.st_mode)
                or stat.S_ISLNK(target_info.st_mode)
                or target_info.st_uid != 0
                or target_info.st_gid != 0
                or target_info.st_nlink != 1
                or target_info.st_mode & 0o022
                or (
                    payload != content
                    and not (schema_version == 2 and payload == legacy_content)
                )
            ):
                raise RuntimeError("backup recovery fence is contradictory")
            inspected_targets.append((directory, target, payload, content))
            continue
        if schema_version == 2:
            raise RuntimeError("legacy backup recovery fence disappeared")
        inspected_targets.append((directory, target, None, content))

    # A 4.0 schema-v2 transaction used the journal itself as its Condition
    # marker. Admit only byte-for-byte authentic old drop-ins. Before replacing
    # the first one, durably create the new blocker; old fences remain blocked
    # by the extant journal and each migrated fence is immediately blocked by
    # that marker. Mixed old/new bytes are therefore a retryable partial
    # migration, while missing or foreign bytes remain fail-closed.
    if schema_version == 2 and any(
        payload == legacy_content for _, _, payload, _ in inspected_targets
    ):
        ensure_blocker()

    for directory, target, payload, content in inspected_targets:
        if payload == content:
            continue
        descriptor, temporary = tempfile.mkstemp(prefix=".backup-fence.", dir=directory)
        try:
            os.fchmod(descriptor, 0o644)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            temporary = ""
            fsync_directory(directory)
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
    fsync_directory(systemd_root)
    run(systemctl, ["daemon-reload"])

def remove_fences():
    if (
        not os.path.lexists(journal_path)
        or os.path.lexists(blocker_path)
        or not os.path.lexists(commit_path)
    ):
        raise RuntimeError("backup recovery is not committed for fence cleanup")
    validate_commit()
    by_name = {entry["name"]: entry for entry in journal["units"]}
    for name in unit_names:
        content = fence_content()
        directory = os.path.join(systemd_root, f"{name}.d")
        target = os.path.join(directory, fence_name)
        directory_info = os.lstat(directory)
        if (
            not stat.S_ISDIR(directory_info.st_mode)
            or stat.S_ISLNK(directory_info.st_mode)
            or directory_info.st_uid != 0
            or directory_info.st_gid != 0
            or directory_info.st_mode & 0o022
            or (
                by_name[name]["fenceDirectoryExisted"]
                and (
                    directory_info.st_dev
                        != by_name[name]["fenceDirectoryDevice"]
                    or directory_info.st_ino
                        != by_name[name]["fenceDirectoryInode"]
                    or stat.S_IMODE(directory_info.st_mode)
                        != by_name[name]["fenceDirectoryMode"]
                )
            )
        ):
            raise RuntimeError("backup recovery fence directory changed")
        if os.path.lexists(target):
            target_info = os.lstat(target)
            if (
                not stat.S_ISREG(target_info.st_mode)
                or stat.S_ISLNK(target_info.st_mode)
                or target_info.st_uid != 0
                or target_info.st_gid != 0
                or target_info.st_nlink != 1
                or target_info.st_mode & 0o022
                or open(target, "rb").read() != content
            ):
                raise RuntimeError("backup recovery fence changed")
            os.unlink(target)
            fsync_directory(directory)
        if not by_name[name]["fenceDirectoryExisted"]:
            try:
                os.rmdir(directory)
            except FileNotFoundError:
                pass
            except OSError:
                if not os.path.isdir(directory) or not os.listdir(directory):
                    raise
    fsync_directory(systemd_root)
    run(systemctl, ["daemon-reload"])

def validate_record_shape(record):
    expected_keys = {
        "id", "name", "claims", "wasRunning", "restartPolicy",
        "recoveryStrategy",
    }
    if (
        not isinstance(record, dict)
        or set(record) != expected_keys
        or not isinstance(record.get("id"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", record["id"])
        or not isinstance(record.get("name"), str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", record["name"])
        or not isinstance(record.get("claims"), dict)
        or not isinstance(record.get("wasRunning"), bool)
        or not isinstance(record.get("restartPolicy"), dict)
        or record.get("recoveryStrategy") not in {"exact", "portal-reconcile"}
    ):
        raise RuntimeError("invalid Docker recovery record")
    if (
        len(record["claims"]) > 64
        or any(
            not isinstance(key, str)
            or not isinstance(value, str)
            or not key
            or not value
            or len(key.encode("utf-8")) > 256
            or len(value.encode("utf-8")) > 512
            or re.search(r"[\x00-\x1f\x7f]", key + value)
            for key, value in record["claims"].items()
        )
    ):
        raise RuntimeError("invalid Docker recovery claims")

def parse_inspected_record(record, raw, *, require_immutable_id):
    payload = json.loads(raw)
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("ambiguous Docker recovery identity")
    container = payload[0]
    labels = ((container.get("Config") or {}).get("Labels") or {})
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    current_claims = {key: labels.get(key) for key in record["claims"]}
    current_policy = {
        "name": policy.get("Name"),
        "maximumRetryCount": policy.get("MaximumRetryCount"),
    }
    running = (container.get("State") or {}).get("Running")
    if (
        not isinstance(container.get("Id"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", container["Id"])
        or (require_immutable_id and container["Id"] != record["id"])
        or str(container.get("Name") or "").lstrip("/") != record["name"]
        or current_claims != record["claims"]
        or not isinstance(running, bool)
    ):
        raise RuntimeError("Docker recovery identity changed")
    return running, current_policy, container["Id"]

def inspect_record(record, *, allow_absent=False):
    validate_record_shape(record)
    strategy = record["recoveryStrategy"]
    raw = run_container_inspect(
        record["id"], allow_absent=allow_absent and strategy == "portal-reconcile"
    )
    if raw is not None:
        return parse_inspected_record(
            record, raw, require_immutable_id=strategy == "exact"
        )
    if strategy != "portal-reconcile":
        raise RuntimeError("exact Docker recovery container is missing")
    raw = run_container_inspect(record["name"], allow_absent=True)
    if raw is None:
        return None
    return parse_inspected_record(record, raw, require_immutable_id=False)

def restart_argument(policy):
    name = policy.get("name")
    maximum = policy.get("maximumRetryCount")
    if (
        name not in {"no", "always", "unless-stopped", "on-failure"}
        or not isinstance(maximum, int)
        or isinstance(maximum, bool)
        or maximum < 0
        or (name != "on-failure" and maximum != 0)
    ):
        raise RuntimeError("invalid recorded Docker restart policy")
    return f"{name}:{maximum}" if name == "on-failure" and maximum else name

expected_units = set(unit_names)
if (
    len(journal["units"]) != len(expected_units)
    or {entry.get("name") for entry in journal["units"] if isinstance(entry, dict)}
        != expected_units
):
    raise RuntimeError("backup unit recovery inventory is invalid")
for unit in journal["units"]:
    if (
        set(unit) != {
            "name", "loadState", "activeState", "fenceDirectoryExisted",
            "fenceDirectoryDevice", "fenceDirectoryInode",
            "fenceDirectoryMode"
        }
        or unit["loadState"] not in {"loaded", "not-found", "masked"}
        or unit["activeState"] not in {"active", "inactive"}
        or not isinstance(unit["fenceDirectoryExisted"], bool)
        or (
            unit["fenceDirectoryExisted"]
            and (
                not isinstance(unit["fenceDirectoryDevice"], int)
                or isinstance(unit["fenceDirectoryDevice"], bool)
                or unit["fenceDirectoryDevice"] < 0
                or not isinstance(unit["fenceDirectoryInode"], int)
                or isinstance(unit["fenceDirectoryInode"], bool)
                or unit["fenceDirectoryInode"] <= 0
                or not isinstance(unit["fenceDirectoryMode"], int)
                or isinstance(unit["fenceDirectoryMode"], bool)
                or not 0 <= unit["fenceDirectoryMode"] <= 0o7777
            )
        )
        or (
            not unit["fenceDirectoryExisted"]
            and any(
                unit[key] is not None
                for key in (
                    "fenceDirectoryDevice",
                    "fenceDirectoryInode",
                    "fenceDirectoryMode",
                )
            )
        )
    ):
        raise RuntimeError("backup unit recovery state is invalid")

portal_was_active = any(
    unit["name"] == "bridgesllm-product.service"
    and unit["activeState"] == "active"
    for unit in journal["units"]
)

def portal_app_key_from_workload(record):
    claims = record["claims"]
    expected_claims = {
        LABEL_WORKLOAD_POLICY,
        LABEL_RUNTIME_FINGERPRINT,
        LABEL_WORKLOAD_ACTOR,
        LABEL_WORKLOAD_PROJECT,
        LABEL_WORKLOAD_KIND,
        LABEL_WORKLOAD_ID,
    }
    if (
        set(claims) != expected_claims
        or claims.get(LABEL_WORKLOAD_POLICY) != WORKLOAD_POLICY
        or claims.get(LABEL_WORKLOAD_KIND) != "PORTAL_APP"
        or not re.fullmatch(
            r"[a-f0-9]{64}", claims.get(LABEL_RUNTIME_FINGERPRINT, "")
        )
    ):
        return None
    actor = claims[LABEL_WORKLOAD_ACTOR]
    project = claims[LABEL_WORKLOAD_PROJECT]
    workload = claims[LABEL_WORKLOAD_ID]
    discriminator = actor + "\0" + project + "\0app\0" + workload
    expected_name = "bridgesllm-project-app-" + hashlib.sha256(
        discriminator.encode("utf-8")
    ).hexdigest()[:20]
    if record["name"] != expected_name:
        raise RuntimeError("Portal app recovery name is invalid")
    return actor, project, workload

def portal_app_key_from_proxy(record):
    claims = record["claims"]
    expected_claims = {
        LABEL_EGRESS_POLICY,
        LABEL_EGRESS_IDENTITY,
        LABEL_EGRESS_ACTOR,
        LABEL_EGRESS_PROJECT,
        LABEL_EGRESS_PROVIDER,
        LABEL_EGRESS_CONSUMER,
        LABEL_EGRESS_WORKLOAD,
        LABEL_EGRESS_ROLE,
        LABEL_EGRESS_FINGERPRINT,
    }
    if LABEL_RUNTIME_FINGERPRINT in claims:
        expected_claims.add(LABEL_RUNTIME_FINGERPRINT)
    if (
        set(claims) != expected_claims
        or claims.get(LABEL_EGRESS_POLICY) != EGRESS_POLICY
        or claims.get(LABEL_EGRESS_PROVIDER) != "PORTAL_WORKLOAD"
        or claims.get(LABEL_EGRESS_CONSUMER) != "PORTAL_APP"
        or claims.get(LABEL_EGRESS_ROLE) != "proxy"
        or (
            LABEL_RUNTIME_FINGERPRINT in claims
            and not re.fullmatch(
                r"[a-f0-9]{64}", claims[LABEL_RUNTIME_FINGERPRINT]
            )
        )
        or not re.fullmatch(
            r"[a-f0-9]{64}", claims.get(LABEL_EGRESS_FINGERPRINT, "")
        )
        or not re.fullmatch(r"[a-f0-9]{64}", claims.get(LABEL_EGRESS_IDENTITY, ""))
    ):
        return None
    actor = claims[LABEL_EGRESS_ACTOR]
    project = claims[LABEL_EGRESS_PROJECT]
    workload = claims[LABEL_EGRESS_WORKLOAD]
    identity_document = {
        "actorId": actor,
        "projectId": project,
        "provider": "PORTAL_WORKLOAD",
        "consumerKind": "PORTAL_APP",
        "workloadId": workload,
    }
    identity = hashlib.sha256(json.dumps(
        identity_document, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")).hexdigest()
    if (
        claims[LABEL_EGRESS_IDENTITY] != identity
        or record["name"] != "p4e-proxy-" + identity[:20]
    ):
        raise RuntimeError("Portal app egress recovery identity is invalid")
    return actor, project, workload

def is_legacy_portal_app_candidate(record):
    claims = record["claims"]
    return (
        set(claims) == {LABEL_WORKLOAD_POLICY, LABEL_RUNTIME_FINGERPRINT}
        and claims.get(LABEL_WORKLOAD_POLICY) == WORKLOAD_POLICY
        and re.fullmatch(
            r"[a-f0-9]{64}", claims.get(LABEL_RUNTIME_FINGERPRINT, "")
        ) is not None
        and re.fullmatch(
            r"bridgesllm-project-app-[a-f0-9]{20}", record["name"]
        ) is not None
        and record["restartPolicy"] == {
            "name": "no", "maximumRetryCount": 0,
        }
    )

def is_legacy_portal_proxy_candidate(record):
    claims = record["claims"]
    return (
        claims == {LABEL_EGRESS_POLICY: EGRESS_POLICY}
        and re.fullmatch(r"p4e-proxy-[a-f0-9]{20}", record["name"])
            is not None
        and record["restartPolicy"] == {
            "name": "no", "maximumRetryCount": 0,
        }
    )

legacy_apps = []
legacy_proxy_candidates = []
if schema_version == 2:
    legacy_keys = {"id", "name", "claims", "wasRunning", "restartPolicy"}
    for record in journal["containers"]:
        if not isinstance(record, dict) or set(record) != legacy_keys:
            raise RuntimeError("legacy Docker recovery record is invalid")
        record["recoveryStrategy"] = "exact"
        validate_record_shape(record)
        restart_argument(record["restartPolicy"])
    # 4.0.19 recorded only policy labels (plus the app runtime fingerprint),
    # but it did retain deterministic names and running intent. Upgrade only
    # the exact historical app shape when Portal was recorded active. Stopped
    # hosted Apps are included because Portal shutdown deletes them too.
    # Generic v2 proxy rows cannot distinguish App egress from provider egress,
    # so they remain exact until Portal is stopped below; only IDs that Portal
    # actually removed can then cross the reconciliation boundary. Final
    # readiness must still re-attest every upgraded name, recorded claim,
    # policy, and running state before deletion.
    if portal_was_active:
        legacy_apps = [
            record for record in journal["containers"]
            if is_legacy_portal_app_candidate(record)
        ]
        legacy_proxy_candidates = [
            record for record in journal["containers"]
            if is_legacy_portal_proxy_candidate(record)
        ]
        for record in legacy_apps:
            record["recoveryStrategy"] = "portal-reconcile"

seen_ids = set()
seen_names = set()
portal_apps = {}
portal_proxies = {}
for record in journal["containers"]:
    validate_record_shape(record)
    restart_argument(record["restartPolicy"])
    if record["id"] in seen_ids or record["name"] in seen_names:
        raise RuntimeError("duplicate Docker recovery identity")
    seen_ids.add(record["id"])
    seen_names.add(record["name"])
    if record["recoveryStrategy"] != "portal-reconcile":
        continue
    if not portal_was_active or record["restartPolicy"] != {
        "name": "no", "maximumRetryCount": 0
    }:
        raise RuntimeError("Portal reconciliation recovery authority is invalid")
    if schema_version == 2:
        if not (
            is_legacy_portal_app_candidate(record)
            or is_legacy_portal_proxy_candidate(record)
        ):
            raise RuntimeError("legacy Portal recovery authority is invalid")
        continue
    key = portal_app_key_from_workload(record)
    if key is not None:
        if key in portal_apps:
            raise RuntimeError("duplicate Portal app recovery authority")
        portal_apps[key] = record
        continue
    key = portal_app_key_from_proxy(record)
    if key is None or key in portal_proxies:
        raise RuntimeError("Portal reconciliation record is not durably owned")
    portal_proxies[key] = record
for key, proxy in portal_proxies.items():
    app = portal_apps.get(key)
    proxy_runtime_fingerprint = proxy["claims"].get(LABEL_RUNTIME_FINGERPRINT)
    if (
        app is None
        or (
            proxy_runtime_fingerprint is not None
            and app["claims"].get(LABEL_RUNTIME_FINGERPRINT)
                != proxy_runtime_fingerprint
        )
    ):
        raise RuntimeError("Portal app egress recovery owner is missing")

recovery_committed = os.path.lexists(commit_path)
if recovery_committed:
    validate_commit()

ensure_fences()
if recovery_committed:
    if os.path.lexists(blocker_path):
        validate_blocker()
    # The pre-commit transaction already completed in an earlier process.
    # A direct quiesce-only probe must never stop already-authorized live state;
    # the shell wrapper detects the commit and resumes restore-recorded directly.
    if recovery_mode == "quiesce-only":
        raise SystemExit(0)
else:
    # Neutralize and attest every recorded container restart policy before
    # activating the systemd blocker. This closes the reboot interval in which
    # an always/unless-stopped container could otherwise restart independently
    # of the fenced Portal/OpenClaw/Stalwart units.
    legacy_proxy_ids = {
        record["id"] for record in legacy_proxy_candidates
    }
    def inspect_before_blocker(record):
        if schema_version == 2 and record["id"] in legacy_proxy_ids:
            raw = run_container_inspect(record["id"], allow_absent=True)
            if raw is None:
                return None
            return parse_inspected_record(
                record, raw, require_immutable_id=True
            )
        return inspect_record(record, allow_absent=True)

    for record in journal["containers"]:
        current = inspect_before_blocker(record)
        if current is None:
            continue
        _, policy, current_id = current
        if policy != {"name": "no", "maximumRetryCount": 0}:
            run(docker, ["container", "update", "--restart=no", current_id])
        current = inspect_before_blocker(record)
        if (
            current is None
            or current[1] != {"name": "no", "maximumRetryCount": 0}
        ):
            raise RuntimeError("Docker restart fence did not converge for recovery")

    # Pre-commit is now reboot-safe and strictly quiescent. Systemd remains
    # fenced and every managed Docker runtime remains stopped with restart=no
    # until the commit marker is durably installed.
    ensure_blocker()
    for unit in journal["units"]:
        _, active = unit_state(unit["name"])
        if active == "active":
            run(systemctl, ["stop", unit["name"]])
            _, active = unit_state(unit["name"])
            if active != "inactive":
                raise RuntimeError("systemd unit did not quiesce for recovery")

if schema_version == 2 and legacy_proxy_candidates:
    missing_legacy_proxies = [
        record for record in legacy_proxy_candidates
        if run_container_inspect(record["id"], allow_absent=True) is None
    ]
    expected_proxy_states = sorted(record["wasRunning"] for record in legacy_apps)
    missing_proxy_states = sorted(
        record["wasRunning"] for record in missing_legacy_proxies
    )
    if missing_proxy_states != expected_proxy_states:
        raise RuntimeError("legacy Portal proxy recovery authority is ambiguous")
    for record in missing_legacy_proxies:
        record["recoveryStrategy"] = "portal-reconcile"

if not recovery_committed:
    # Unit shutdown can reconcile Portal-owned resources. Bind the restart
    # fence again across every surviving record before the first container is
    # stopped and before the shell wrapper can recover database exclusion.
    for record in journal["containers"]:
        current = inspect_record(record, allow_absent=True)
        if current is None:
            continue
        if current[1] != {"name": "no", "maximumRetryCount": 0}:
            raise RuntimeError("Docker restart fence drifted during recovery")

    for record in journal["containers"]:
        current = inspect_record(record, allow_absent=True)
        if current is None:
            continue
        running, policy, current_id = current
        if policy != {"name": "no", "maximumRetryCount": 0}:
            run(docker, ["container", "update", "--restart=no", current_id])
        if running:
            run(docker, ["container", "stop", "--time", "30", current_id])
        current = inspect_record(record, allow_absent=True)
        if current is None:
            continue
        running, policy, _ = current
        if running or policy != {"name": "no", "maximumRetryCount": 0}:
            raise RuntimeError("Docker runtime did not quiesce for recovery")

    if recovery_mode == "quiesce-only":
        raise SystemExit(0)

    # Database exclusion has already been recovered by the shell wrapper.
    # This durable marker is the point of no return: retries after it must
    # converge the recorded state, never re-enter the quiescent transaction.
    install_commit()
    recovery_committed = True

if os.path.lexists(blocker_path):
    remove_blocker()

# Post-commit convergence is deliberately idempotent. A crash or reboot may
# leave any prefix of the recorded Docker/service state live; the commit marker
# authorizes that state and the next recovery resumes here without stopping it.
for record in journal["containers"]:
    current = inspect_record(record, allow_absent=True)
    if current is None:
        if record["recoveryStrategy"] == "portal-reconcile":
            continue
        raise RuntimeError("exact Docker runtime disappeared after recovery commit")
    if record["recoveryStrategy"] == "portal-reconcile":
        continue
    running, policy, current_id = current
    if running and not record["wasRunning"]:
        run(docker, ["container", "stop", "--time", "30", current_id])
        running = False
    if policy != record["restartPolicy"]:
        run(
            docker,
            [
                "container", "update",
                f"--restart={restart_argument(record['restartPolicy'])}",
                current_id,
            ],
        )
    if record["wasRunning"] and not running:
        run(docker, ["container", "start", current_id])
    restored = inspect_record(record)
    if restored is None:
        raise RuntimeError("exact Docker runtime disappeared during convergence")
    running, policy, _ = restored
    if running != record["wasRunning"] or policy != record["restartPolicy"]:
        raise RuntimeError("Docker runtime state was not restored")

for unit in journal["units"]:
    load, active = unit_state(unit["name"])
    if unit["activeState"] == "active" and active != "active":
        run(systemctl, ["start", unit["name"]])
        load, active = unit_state(unit["name"])
    elif unit["activeState"] == "inactive" and active == "active":
        run(systemctl, ["stop", unit["name"]])
        load, active = unit_state(unit["name"])
    if (load, active) != (unit["loadState"], unit["activeState"]):
        raise RuntimeError("systemd unit state was not restored exactly")

# Starting Portal/OpenClaw can itself reconcile Docker runtimes. Re-attest the
# immutable identities, policies, and running intent after every unit has
# returned to its recorded state and before deleting the sole recovery record.
for record in journal["containers"]:
    if record["recoveryStrategy"] == "portal-reconcile":
        continue
    restored = inspect_record(record)
    if restored is None:
        raise RuntimeError("exact Docker runtime disappeared after service restoration")
    running, policy, _ = restored
    if running != record["wasRunning"] or policy != record["restartPolicy"]:
        raise RuntimeError("Docker runtime drifted after service restoration")

portal_record = next(
    unit for unit in journal["units"]
    if unit["name"] == "bridgesllm-product.service"
)
if portal_record["activeState"] == "active":
    healthy = False
    for _ in range(60):
        load, active = unit_state("bridgesllm-product.service")
        result = subprocess.run(
            [
                curl, "-fsS", "--max-time", "5",
                "http://127.0.0.1:4001/health",
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            env={
                "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            },
        )
        try:
            payload = json.loads(result.stdout) if result.returncode == 0 else {}
        except json.JSONDecodeError:
            payload = {}
        if (
            load == "loaded"
            and active == "active"
            and payload.get("status") == "ok"
            and payload.get("version") == journal["portalVersion"]
        ):
            healthy = True
            break
        time.sleep(1)
    if not healthy:
        raise RuntimeError("Portal health did not recover after backup")

# Readiness can trigger Portal/OpenClaw reconciliation. Bind final Docker
# state after the health gate, immediately before deleting recovery authority.
for unit in journal["units"]:
    load, active = unit_state(unit["name"])
    if unit["name"] == "stalwart-cert-sync.service" and active == "active":
        for _ in range(60):
            time.sleep(1)
            load, active = unit_state(unit["name"])
            if active == "inactive":
                break
    if (load, active) != (unit["loadState"], unit["activeState"]):
        raise RuntimeError("systemd state drifted during Portal readiness")

def assert_restored_record(record):
    restored = inspect_record(
        record, allow_absent=record["recoveryStrategy"] == "portal-reconcile"
    )
    if restored is None:
        if record["recoveryStrategy"] == "portal-reconcile" and not record["wasRunning"]:
            return
        raise RuntimeError("Portal did not reconcile a recorded app runtime")
    running, policy, _ = restored
    if running != record["wasRunning"] or policy != record["restartPolicy"]:
        if record["recoveryStrategy"] == "portal-reconcile":
            raise RuntimeError("Portal app runtime intent was not reconciled")
        raise RuntimeError("Docker runtime drifted during Portal readiness")

for record in journal["containers"]:
    assert_restored_record(record)

# Retire the fences while the journal and commit still provide their complete
# cleanup authority. Then remove the journal first and the commit last: a crash
# between them leaves an unmistakable post-commit orphan, never a journal that
# could be mistaken for an uncommitted transaction.
remove_fences()
os.unlink(journal_path)
descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
remove_commit()
PY
  local status="$?"
  if (( status == 0 )) && [[ "${recovery_mode}" == "restore-recorded" ]]; then
    BACKUP_QUIESCE_ACTIVE=false
  fi
  return "${status}"
}

cleanup_orphaned_backup_recovery_commit() {
  python3 - "${QUIESCENCE_COMMIT}" "${QUIESCENCE_JOURNAL}" \
    "${QUIESCENCE_BLOCKER}" <<'PY'
import os
import re
import stat
import sys

commit_path, journal_path, blocker_path = sys.argv[1:]
parent = os.path.dirname(commit_path)
if (
    os.path.dirname(journal_path) != parent
    or os.path.dirname(blocker_path) != parent
    or commit_path in {journal_path, blocker_path}
    or os.path.lexists(journal_path)
    or os.path.lexists(blocker_path)
):
    raise SystemExit(1)
parent_info = os.lstat(parent)
commit_info = os.lstat(commit_path)
if (
    not stat.S_ISDIR(parent_info.st_mode)
    or stat.S_ISLNK(parent_info.st_mode)
    or parent_info.st_uid != 0
    or parent_info.st_gid != 0
    or parent_info.st_mode & 0o022
    or not stat.S_ISREG(commit_info.st_mode)
    or stat.S_ISLNK(commit_info.st_mode)
    or commit_info.st_uid != 0
    or commit_info.st_gid != 0
    or commit_info.st_nlink != 1
    or stat.S_IMODE(commit_info.st_mode) != 0o600
    or commit_info.st_size <= 0
    or commit_info.st_size > 512
):
    raise SystemExit(1)
try:
    content = open(commit_path, "rb").read(513).decode("ascii")
except (OSError, UnicodeError):
    raise SystemExit(1) from None
if re.fullmatch(
    r"bridgesllm-backup-recovery-commit-v1\n"
    r"runId=[A-Za-z0-9._-]{1,128}\n"
    r"journalSha256=[a-f0-9]{64}\n",
    content,
) is None:
    raise SystemExit(1)
os.unlink(commit_path)
descriptor = os.open(
    parent,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

restore_backup_quiescence() {
  local journal_exists=false
  local blocker_exists=false
  local commit_exists=false
  if [[ -e "${QUIESCENCE_JOURNAL}" || -L "${QUIESCENCE_JOURNAL}" ]]; then
    journal_exists=true
  fi
  if [[ -e "${QUIESCENCE_BLOCKER}" || -L "${QUIESCENCE_BLOCKER}" ]]; then
    blocker_exists=true
  fi
  if [[ -e "${QUIESCENCE_COMMIT}" || -L "${QUIESCENCE_COMMIT}" ]]; then
    commit_exists=true
  fi
  if [[ "${journal_exists}" == "false" ]]; then
    [[ "${blocker_exists}" == "false" ]] || return 1
    if [[ "${commit_exists}" == "true" ]]; then
      cleanup_orphaned_backup_recovery_commit || return 1
    fi
    assert_no_orphan_backup_database_transactions || return 1
    BACKUP_QUIESCE_ACTIVE=false
    return 0
  fi
  if [[ "${commit_exists}" == "true" ]]; then
    restore_backup_runtime_state restore-recorded
    return $?
  fi
  restore_backup_runtime_state quiesce-only || return 1
  recover_backup_database_exclusion || return 1
  restore_backup_runtime_state restore-recorded
}

assert_backup_sources_quiescent() {
  python3 - "${QUIESCENCE_JOURNAL}" "${QUIESCENCE_BLOCKER}" \
    "${QUIESCENCE_COMMIT}" \
    "${BACKUP_SYSTEMCTL_BIN}" \
    "${BACKUP_DOCKER_BIN}" "${SYSTEMD_DIR}" "${BACKUP_FENCE_NAME}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import json
import os
import re
import stat
import subprocess
import sys

journal_path, blocker_path, commit_path, systemctl, docker, systemd_root, fence_name, *unit_names = sys.argv[1:]
info = os.lstat(journal_path)
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
    raise SystemExit("backup quiescence journal is unsafe at publication")
journal = json.load(open(journal_path, "r", encoding="utf-8"))
if (
    journal.get("schemaVersion") != 3
    or not isinstance(journal.get("units"), list)
    or not isinstance(journal.get("containers"), list)
    or {entry.get("name") for entry in journal["units"] if isinstance(entry, dict)}
        != set(unit_names)
):
    raise SystemExit("backup quiescence journal changed before publication")
blocker_info = os.lstat(blocker_path)
blocker_content = (
    "bridgesllm-backup-quiescence-v1\n"
    f"runId={journal['runId']}\n"
).encode("utf-8")
if (
    os.path.dirname(blocker_path) != os.path.dirname(journal_path)
    or blocker_path == journal_path
    or os.path.dirname(commit_path) != os.path.dirname(journal_path)
    or commit_path in {journal_path, blocker_path}
    or os.path.lexists(commit_path)
    or not stat.S_ISREG(blocker_info.st_mode)
    or stat.S_ISLNK(blocker_info.st_mode)
    or blocker_info.st_uid != 0
    or blocker_info.st_gid != 0
    or blocker_info.st_nlink != 1
    or stat.S_IMODE(blocker_info.st_mode) != 0o600
    or open(blocker_path, "rb").read(4096) != blocker_content
):
    raise SystemExit("backup quiescence blocker changed before publication")
def bounded_diagnostic(value, limit=512):
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "?", str(value))
    text = re.sub(r"(?i)\bbearer\s+[^\s,;]+", "Bearer <redacted>", text)
    text = re.sub(
        r"(?i)([\"']?[A-Za-z0-9_.-]*"
        r"(?:token|secret|password|passwd|pwd|authorization|credential|"
        r"api[-_]?key|access[-_]?key)"
        r"[A-Za-z0-9_.-]*[\"']?\s*[:=]\s*)"
        r"(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)",
        r"\1<redacted>", text,
    )
    text = re.sub(
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s,;]+", "<redacted-url>", text
    )
    return text if len(text) <= limit else text[:limit] + "..."

def run(executable, arguments, *, allow_absent=False):
    # Publication must attest the same host units quiescence controlled. A
    # plain systemctl call in the private PID namespace cannot reach that
    # manager, so use systemd's explicit local-host transport here as well.
    arguments = (
        ["--machine=.host", *arguments]
        if executable == systemctl else list(arguments)
    )
    result = subprocess.run(
        [executable, *arguments], check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
        env={
            "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        },
    )
    if result.returncode != 0:
        absent = (
            allow_absent
            and result.returncode == 1
            and any(
                marker in (result.stderr or "").lower()
                for marker in ("no such container", "no such object", "not found")
            )
        )
        if absent:
            return None
        verb = bounded_diagnostic(os.path.basename(executable), 64)
        args = " ".join(bounded_diagnostic(value, 96) for value in arguments[:12])
        stderr = bounded_diagnostic((result.stderr or "").strip()) or "<no stderr>"
        raise RuntimeError(
            f"backup publication command failed: {verb} {args} "
            f"(exit {result.returncode}): {stderr}"
        )
    return result.stdout.strip()

content = (
    "[Unit]\n"
    f"ConditionPathExists=!{blocker_path}\n"
).encode("utf-8")

for unit in journal["units"]:
    if set(unit) != {
        "name", "loadState", "activeState", "fenceDirectoryExisted",
        "fenceDirectoryDevice", "fenceDirectoryInode", "fenceDirectoryMode",
    }:
        raise RuntimeError("backup source-mutator fence plan is invalid")
    expected_active = unit.get("activeState")
    load = run(
        systemctl, ["show", "--property=LoadState", "--value", unit["name"]]
    )
    active = run(
        systemctl, ["show", "--property=ActiveState", "--value", unit["name"]]
    )
    quiesced_active = "inactive" if expected_active == "active" else expected_active
    if load != unit.get("loadState") or active != quiesced_active:
        raise RuntimeError("backup source-mutating unit restarted during capture")
    fence = os.path.join(systemd_root, f"{unit['name']}.d", fence_name)
    directory = os.path.dirname(fence)
    directory_info = os.lstat(directory)
    if (
        not stat.S_ISDIR(directory_info.st_mode)
        or stat.S_ISLNK(directory_info.st_mode)
        or directory_info.st_uid != 0
        or directory_info.st_gid != 0
        or directory_info.st_mode & 0o022
        or (
            unit["fenceDirectoryExisted"]
            and (
                directory_info.st_dev != unit["fenceDirectoryDevice"]
                or directory_info.st_ino != unit["fenceDirectoryInode"]
                or stat.S_IMODE(directory_info.st_mode)
                    != unit["fenceDirectoryMode"]
            )
        )
    ):
        raise RuntimeError("backup source-mutator fence directory changed")
    fence_info = os.lstat(fence)
    if (
        not stat.S_ISREG(fence_info.st_mode)
        or stat.S_ISLNK(fence_info.st_mode)
        or fence_info.st_uid != 0
        or fence_info.st_gid != 0
        or fence_info.st_nlink != 1
        or fence_info.st_mode & 0o022
        or open(fence, "rb").read() != content
    ):
        raise RuntimeError("backup source-mutator fence changed during capture")

seen = set()
for record in journal["containers"]:
    identifier = record.get("id")
    if (
        not isinstance(record, dict)
        or set(record) != {
            "id", "name", "claims", "wasRunning", "restartPolicy",
            "recoveryStrategy",
        }
        or not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or identifier in seen
        or not isinstance(record.get("name"), str)
        or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]{0,254}", record["name"]
        )
        or not isinstance(record.get("claims"), dict)
        or not isinstance(record.get("wasRunning"), bool)
        or not isinstance(record.get("restartPolicy"), dict)
        or record.get("recoveryStrategy") not in {"exact", "portal-reconcile"}
    ):
        raise RuntimeError("backup Docker publication record is invalid")
    seen.add(identifier)
    strategy = record["recoveryStrategy"]
    raw = run(
        docker, ["container", "inspect", identifier],
        allow_absent=strategy == "portal-reconcile",
    )
    if raw is None and strategy == "portal-reconcile":
        raw = run(
            docker, ["container", "inspect", record.get("name", "")],
            allow_absent=True,
        )
    if raw is None:
        continue
    payload = json.loads(raw)
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("backup Docker publication identity is ambiguous")
    container = payload[0]
    labels = ((container.get("Config") or {}).get("Labels") or {})
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    if (
        (strategy == "exact" and container.get("Id") != identifier)
        or str(container.get("Name") or "").lstrip("/") != record.get("name")
        or {key: labels.get(key) for key in record["claims"]} != record["claims"]
        or bool((container.get("State") or {}).get("Running"))
        or policy.get("Name") != "no"
        or policy.get("MaximumRetryCount") != 0
    ):
        raise RuntimeError("backup Docker source restarted during capture")
PY
}

cleanup_verify_dir() {
  local target="${VERIFY_DIR:-}"
  [[ -n "${target}" ]] || return 0
  if ! cleanup_backup_work_directory "${target}"; then
    log "ERROR: backup verification directory cleanup failed"
    return 1
  fi
  VERIFY_DIR=""
}

prepare_verify_archive_workspace() {
  [[ -z "${VERIFY_DIR:-}" ]] || cleanup_verify_dir
}

cleanup_staging_dir() {
  local target="${STAGING_DIR:-}"
  [[ -n "${target}" ]] || return 0
  if ! cleanup_backup_work_directory "${target}"; then
    log "ERROR: backup creation staging directory cleanup failed"
    return 1
  fi
  STAGING_DIR=""
}

finish_backup_verification() {
  local exit_code="$?"
  trap - EXIT HUP INT TERM
  cleanup_verify_dir || exit_code=1
  release_backup_capacity_guard || exit_code=1
  release_backup_lock_guard || exit_code=1
  exit "${exit_code}"
}

begin_backup_verification() {
  acquire_backup_locks
  trap finish_backup_verification EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before archive verification"
  BACKUP_BASE="$(validate_backup_base)" \
    || die "Backup path validation failed before archive verification"
  prepare_backup_work_root \
    || die "Configured backup storage cannot safely host private verification workspaces"
  sweep_stale_backup_artifacts temporary-only \
    || die "Stale backup verification artifacts could not be removed safely"
}

finish_run() {
  local exit_code="$?"
  local published_degraded=false
  local failed_phase="${RUN_PHASE}"
  local failed_phase_label="${RUN_PHASE_LABEL}"
  local failed_phase_index="${RUN_PHASE_INDEX}"
  local recovery_attempted=false
  local terminal_status_durable=false
  trap - EXIT HUP INT TERM ERR
  if ! assert_backup_lock_guard; then
    printf '%s\n' \
      'Backup terminalization was skipped because its operation lock guard is unavailable.' >&2
    exit 1
  fi
  if (( exit_code != 0 )) && [[ -z "${RUN_ERROR_DETAIL}" ]]; then
    RUN_ERROR_DETAIL="Backup process exited unexpectedly with code ${exit_code} during ${RUN_PHASE_LABEL:-backup processing}"
  fi
  if (( exit_code != 0 )) && [[ -z "${RUN_FAILURE_CODE}" ]]; then
    RUN_FAILURE_CODE="BACKUP_OPERATION_FAILED"
  fi
  if (( exit_code != 0 )) && $RUN_DEGRADED && [[ -n "${RUN_ARCHIVE_PATH}" ]]; then
    published_degraded=true
  fi
  if $RUN_ACTIVE \
    && { $BACKUP_QUIESCE_ACTIVE \
      || [[ -e "${QUIESCENCE_JOURNAL}" || -L "${QUIESCENCE_JOURNAL}" \
        || -e "${QUIESCENCE_BLOCKER}" || -L "${QUIESCENCE_BLOCKER}" \
        || -e "${QUIESCENCE_COMMIT}" || -L "${QUIESCENCE_COMMIT}" ]]; }; then
    recovery_attempted=true
    RUN_PHASE="restoring-services"
    RUN_PHASE_LABEL="Restoring services"
    RUN_PHASE_INDEX="${RUN_PHASE_TOTAL}"
    assert_backup_lock_guard \
      && write_status running "" "" "" owned || true
  fi
  if ! restore_backup_quiescence; then
    log "ERROR: one or more services or managed Project containers did not return to their pre-backup running state"
    if [[ -n "${RUN_ERROR_DETAIL}" ]]; then
      RUN_ERROR_DETAIL="${RUN_ERROR_DETAIL}; service recovery also failed"
    else
      RUN_ERROR_DETAIL="One or more services, managed Project containers, or the database fence did not return to their pre-backup state"
    fi
    exit_code=1
    RUN_FAILURE_CODE="BACKUP_RECOVERY_FAILED"
    published_degraded=false
  elif $recovery_attempted && (( exit_code != 0 )); then
    RUN_PHASE="${failed_phase}"
    RUN_PHASE_LABEL="${failed_phase_label}"
    RUN_PHASE_INDEX="${failed_phase_index}"
  fi
  if ! cleanup_staging_dir; then
    exit_code=1
    published_degraded=false
    RUN_FAILURE_CODE="BACKUP_WORK_CLEANUP_FAILED"
    RUN_ERROR_DETAIL="Private backup creation workspace could not be retired safely"
  fi
  if ! cleanup_verify_dir; then
    exit_code=1
    published_degraded=false
    RUN_FAILURE_CODE="BACKUP_WORK_CLEANUP_FAILED"
    RUN_ERROR_DETAIL="Private backup verification workspace could not be retired safely"
  fi
  # Publication candidates are descriptor-held capacity resources. Their
  # exact-inode retirement belongs exclusively to
  # release_backup_capacity_guard; never unlink a possibly swapped pathname
  # here.
  if ! release_backup_capacity_guard; then
    if (( exit_code == 0 )); then
      RUN_FAILURE_CODE="BACKUP_CAPACITY_LEASE_FAILED"
      RUN_ERROR_DETAIL="Held backup recovery capacity could not be retired with its exact process and inode authority"
    elif [[ -n "${RUN_ERROR_DETAIL}" ]]; then
      RUN_ERROR_DETAIL="${RUN_ERROR_DETAIL}; held backup recovery capacity also failed exact retirement"
    else
      RUN_ERROR_DETAIL="Held backup recovery capacity failed exact retirement"
    fi
    exit_code=1
    published_degraded=false
  fi
  if $RUN_ACTIVE; then
    if (( exit_code == 0 )); then
      RUN_CONSECUTIVE_FAILURES=0
      RUN_PHASE="completed"
      RUN_PHASE_LABEL="Backup completed"
      RUN_PHASE_INDEX="${RUN_PHASE_TOTAL}"
      if assert_backup_lock_guard \
        && write_status completed "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "0" "" owned; then
        terminal_status_durable=true
      fi
    elif $published_degraded; then
      (( RUN_CONSECUTIVE_FAILURES += 1 ))
      if assert_backup_lock_guard \
        && write_status degraded "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$exit_code" \
        "${RUN_ERROR_DETAIL:-Backup archive was published in degraded state}" owned; then
        terminal_status_durable=true
      fi
    else
      (( RUN_CONSECUTIVE_FAILURES += 1 ))
      if assert_backup_lock_guard \
        && write_status failed "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$exit_code" \
        "${RUN_ERROR_DETAIL:-Backup process exited with code ${exit_code}}" owned; then
        terminal_status_durable=true
      fi
    fi
    if ! $terminal_status_durable; then
      exit_code=1
      log "ERROR: terminal backup status could not be committed; exact request authority is retained for recovery"
    fi
  fi
  if $terminal_status_durable \
    && { ! assert_backup_lock_guard || ! consume_backup_request_claim; }; then
    exit_code=1
    RUN_FAILURE_CODE="BACKUP_REQUEST_CLEANUP_FAILED"
    RUN_ERROR_DETAIL="Backup request receipt could not be consumed safely"
    log "ERROR: durable terminal status exists but its exact request receipt requires locked recovery"
  fi
  if ! release_backup_lock_guard; then
    exit_code=1
    if $RUN_ACTIVE; then
      (( RUN_CONSECUTIVE_FAILURES > 0 )) || RUN_CONSECUTIVE_FAILURES=1
      RUN_FAILURE_CODE="BACKUP_LOCK_RELEASE_FAILED"
      RUN_ERROR_DETAIL="Backup lock guard did not release cleanly"
      printf '%s\n' \
        'Backup lock release failed after terminal status publication; no unlocked status rewrite was attempted.' >&2
    fi
  fi
  exit "$exit_code"
}

backup_self_host_pid() {
  local namespace_pid="${1:-}"
  [[ "${namespace_pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  python3 - "${namespace_pid}" <<'PY'
import re
import os
import sys

expected_namespace_pid = int(sys.argv[1])
if expected_namespace_pid <= 0:
    raise SystemExit(1)

# Command substitution introduces a short-lived Bash process between this
# Python helper and the calling shell.  /proc remains mounted from the host
# after entering the private PID namespace, so os.getppid() is an inner PID and
# is never a valid pathname authority there.  Start from status's host PPid,
# resolve at most that one boundary, and bind the result to the caller's
# namespace PID.
try:
    self_status = open(
        "/proc/self/status", "r", encoding="ascii"
    ).read().splitlines()
except OSError:
    raise SystemExit(1)
self_parents = [
    line.partition(":")[2].strip()
    for line in self_status if line.startswith("PPid:")
]
if (
    len(self_parents) != 1
    or re.fullmatch(r"[1-9][0-9]*", self_parents[0]) is None
):
    raise SystemExit(1)
candidate = int(self_parents[0])
for _ in range(2):
    try:
        lines = open(
            f"/proc/{candidate}/status", "r", encoding="ascii"
        ).read().splitlines()
    except OSError:
        raise SystemExit(1)
    pids = [
        line.partition(":")[2].strip()
        for line in lines if line.startswith("Pid:")
    ]
    parents = [
        line.partition(":")[2].strip()
        for line in lines if line.startswith("PPid:")
    ]
    nspids = [
        line.partition(":")[2].split()
        for line in lines if line.startswith("NSpid:")
    ]
    uids = [
        line.partition(":")[2].split()
        for line in lines if line.startswith("Uid:")
    ]
    if (
        pids == [str(candidate)]
        and len(nspids) == 1
        and nspids[0]
        and nspids[0][0] == str(candidate)
        and nspids[0][-1] == str(expected_namespace_pid)
        and all(
            re.fullmatch(r"[1-9][0-9]*", value)
            for value in nspids[0]
        )
        and uids == [["0", "0", "0", "0"]]
    ):
        print(candidate)
        raise SystemExit(0)
    if (
        len(parents) != 1
        or re.fullmatch(r"[1-9][0-9]*", parents[0]) is None
    ):
        raise SystemExit(1)
    candidate = int(parents[0])
raise SystemExit(1)
PY
}

backup_process_starttime() {
  local pid="$1"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  python3 - "${pid}" <<'PY'
import pathlib
import re
import sys

pid = int(sys.argv[1])
try:
    raw = pathlib.Path(f"/proc/{pid}/stat").read_text(
        encoding="ascii"
    ).strip()
except OSError:
    raise SystemExit(1)
closing = raw.rfind(")")
if closing <= 1 or closing + 2 >= len(raw):
    raise SystemExit(1)
fields = raw[closing + 2:].split()
if len(fields) < 20 or not re.fullmatch(r"[0-9]+", fields[19]):
    raise SystemExit(1)
print(fields[19])
PY
}

assert_backup_lock_guard() {
  [[ "${BACKUP_LOCK_GUARD_PID}" =~ ^[1-9][0-9]*$ \
    && "${BACKUP_LOCK_GUARD_HOST_PID}" =~ ^[1-9][0-9]*$ \
    && "${BACKUP_LOCK_GUARD_STARTTIME}" =~ ^[0-9]+$ ]] || return 1
  local owner_pid="${BASHPID}" owner_host_pid=""
  owner_host_pid="$(backup_self_host_pid "${owner_pid}")" || return 1
  python3 - "${BACKUP_LOCK_GUARD_PID}" "${BACKUP_LOCK_GUARD_HOST_PID}" \
    "${BACKUP_LOCK_GUARD_STARTTIME}" "${owner_host_pid}" \
    "${PORTAL_OPERATION_LOCK_FILE}" "${LOCK_FILE}" <<'PY'
import os
import pathlib
import re
import stat
import sys

namespace_pid = int(sys.argv[1])
host_pid = int(sys.argv[2])
expected_starttime = sys.argv[3]
expected_parent = int(sys.argv[4])
lock_paths = sys.argv[5:]
if (
    namespace_pid <= 1
    or host_pid <= 1
    or expected_parent <= 1
    or not re.fullmatch(r"[0-9]+", expected_starttime)
    or len(lock_paths) != 2
):
    raise SystemExit(1)
try:
    raw = pathlib.Path(f"/proc/{host_pid}/stat").read_text(
        encoding="ascii"
    ).strip()
    status = pathlib.Path(f"/proc/{host_pid}/status").read_text(
        encoding="ascii"
    ).splitlines()
except OSError:
    raise SystemExit(1)
closing = raw.rfind(")")
if closing <= 1 or closing + 2 >= len(raw):
    raise SystemExit(1)
fields = raw[closing + 2:].split()
parents = [
    line.partition(":")[2].strip()
    for line in status
    if line.startswith("PPid:")
]
nspids = [
    line.partition(":")[2].split()
    for line in status
    if line.startswith("NSpid:")
]
if (
    len(fields) < 20
    or fields[19] != expected_starttime
    or len(parents) != 1
    or parents[0] != str(expected_parent)
    or len(nspids) != 1
    or not nspids[0]
    or nspids[0][0] != str(host_pid)
    or nspids[0][-1] != str(namespace_pid)
):
    raise SystemExit(1)
for descriptor, path in zip((8, 9), lock_paths):
    try:
        opened = os.stat(f"/proc/{host_pid}/fd/{descriptor}")
        current = os.lstat(path)
    except OSError:
        raise SystemExit(1)
    if (
        not stat.S_ISREG(opened.st_mode)
        or not stat.S_ISREG(current.st_mode)
        or stat.S_ISLNK(current.st_mode)
        or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
        or current.st_uid != 0
        or current.st_gid != 0
        or current.st_nlink != 1
        or current.st_mode & 0o022
    ):
        raise SystemExit(1)
PY
}

terminate_backup_lock_guard_process() {
  local namespace_pid="$1"
  local host_pid="$2"
  local expected_starttime="$3"
  local expected_parent="$4"
  [[ "${namespace_pid}" =~ ^[1-9][0-9]*$ \
    && "${host_pid}" =~ ^[1-9][0-9]*$ \
    && "${expected_starttime}" =~ ^[0-9]+$ \
    && "${expected_parent}" =~ ^[1-9][0-9]*$ ]] || return 1
  # Open a pidfd before re-reading /proc so a PID that exits and is reused
  # between validation and signalling can never redirect SIGKILL to the new
  # process.  Start time and parent binding also make stale guard state fail
  # closed without signalling anything.
  python3 - "${namespace_pid}" "${host_pid}" \
    "${expected_starttime}" "${expected_parent}" <<'PY'
import os
import pathlib
import re
import signal
import sys

namespace_pid = int(sys.argv[1])
host_pid = int(sys.argv[2])
expected_starttime = sys.argv[3]
expected_parent = int(sys.argv[4])
if (
    namespace_pid <= 1
    or host_pid <= 1
    or expected_parent <= 1
    or not re.fullmatch(r"[0-9]+", expected_starttime)
):
    raise SystemExit(1)
try:
    descriptor = os.pidfd_open(namespace_pid, 0)
except (AttributeError, OSError):
    raise SystemExit(1)
try:
    try:
        raw = pathlib.Path(f"/proc/{host_pid}/stat").read_text(
            encoding="ascii"
        ).strip()
        status = pathlib.Path(f"/proc/{host_pid}/status").read_text(
            encoding="ascii"
        ).splitlines()
    except OSError:
        raise SystemExit(1)
    closing = raw.rfind(")")
    if closing <= 1 or closing + 2 >= len(raw):
        raise SystemExit(1)
    fields = raw[closing + 2:].split()
    nspids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("NSpid:")
    ]
    if (
        len(fields) < 20
        or fields[1] != str(expected_parent)
        or fields[19] != expected_starttime
        or len(nspids) != 1
        or not nspids[0]
        or nspids[0][0] != str(host_pid)
        or nspids[0][-1] != str(namespace_pid)
    ):
        raise SystemExit(1)
    try:
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    except (AttributeError, OSError):
        raise SystemExit(1)
finally:
    os.close(descriptor)
PY
  local signal_status="$?"
  (( signal_status == 0 )) || return 1
  local status=0
  if wait "${namespace_pid}" 2>/dev/null; then
    status=0
  else
    status="$?"
  fi
  [[ "${status}" -eq 0 || "${status}" -eq 137 ]]
}

backup_capacity_guard_state_present() {
  [[ -n "${BACKUP_CAPACITY_GUARD_PID:-}" \
    || -n "${BACKUP_CAPACITY_GUARD_HOST_PID:-}" \
    || -n "${BACKUP_CAPACITY_GUARD_STARTTIME:-}" \
    || -n "${BACKUP_CAPACITY_GUARD_PLAN:-}" \
    || -n "${BACKUP_CAPACITY_GUARD_LEASES:-}" \
    || -n "${BACKUP_CAPACITY_STATE:-}" ]]
}

terminate_backup_capacity_guard_process() {
  local namespace_pid="$1" host_pid="$2" expected_starttime="$3"
  local expected_parent="$4"
  [[ "${namespace_pid}" =~ ^[1-9][0-9]*$ \
    && "${host_pid}" =~ ^[1-9][0-9]*$ \
    && "${expected_starttime}" =~ ^[0-9]+$ \
    && "${expected_parent}" =~ ^[1-9][0-9]*$ ]] || return 1
  python3 - "${namespace_pid}" "${host_pid}" \
    "${expected_starttime}" "${expected_parent}" <<'PY'
import os
import pathlib
import select
import signal
import sys

namespace_pid = int(sys.argv[1])
host_pid = int(sys.argv[2])
expected_starttime = sys.argv[3]
expected_parent = int(sys.argv[4])
try:
    descriptor = os.pidfd_open(namespace_pid, 0)
except (AttributeError, OSError):
    raise SystemExit(1)
try:
    try:
        raw = pathlib.Path(f"/proc/{host_pid}/stat").read_text(
            encoding="ascii"
        ).strip()
        status = pathlib.Path(f"/proc/{host_pid}/status").read_text(
            encoding="ascii"
        ).splitlines()
    except OSError:
        raise SystemExit(1)
    closing = raw.rfind(")")
    fields = raw[closing + 2:].split() if closing > 1 else []
    nspids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("NSpid:")
    ]
    parents = [
        line.partition(":")[2].strip()
        for line in status if line.startswith("PPid:")
    ]
    if (
        len(fields) < 20
        or fields[19] != expected_starttime
        or parents != [str(expected_parent)]
        or len(nspids) != 1
        or not nspids[0]
        or nspids[0][0] != str(host_pid)
        or nspids[0][-1] != str(namespace_pid)
    ):
        raise SystemExit(1)
    try:
        signal.pidfd_send_signal(descriptor, signal.SIGUSR1)
    except (AttributeError, OSError):
        raise SystemExit(1)
    poller = select.poll()
    poller.register(descriptor, select.POLLIN)
    if not poller.poll(5000):
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        except (AttributeError, OSError):
            pass
        raise SystemExit(1)
finally:
    os.close(descriptor)
PY
  local signal_status="$?" status=0
  if wait "${namespace_pid}" 2>/dev/null; then
    status=0
  else
    status="$?"
  fi
  (( signal_status == 0 && status == 0 ))
}

assert_backup_capacity_guard() {
  local plan="${1:-${BACKUP_CAPACITY_GUARD_PLAN:-}}"
  [[ "${BACKUP_CAPACITY_GUARD_PID:-}" =~ ^[1-9][0-9]*$ \
    && "${BACKUP_CAPACITY_GUARD_HOST_PID:-}" =~ ^[1-9][0-9]*$ \
    && "${BACKUP_CAPACITY_GUARD_STARTTIME:-}" =~ ^[0-9]+$ \
    && -n "${plan}" && -n "${BACKUP_CAPACITY_GUARD_PLAN:-}" \
    && -n "${BACKUP_CAPACITY_GUARD_LEASES:-}" \
    && "${BACKUP_CAPACITY_STATE:-}" \
      =~ ^(resources-ready|image-mounted|archive-streaming|candidate-settled|verified|receipt-writing|receipt-settled|publishing|published)$ ]] \
    || return 1
  (( $# == 0 )) || [[ "${plan}" == "${BACKUP_CAPACITY_GUARD_PLAN}" ]] \
    || return 1
  local owner_pid="${BASHPID}" owner_host_pid=""
  owner_host_pid="$(backup_self_host_pid "${owner_pid}")" || return 1
  python3 - "${BACKUP_CAPACITY_GUARD_PID}" \
    "${BACKUP_CAPACITY_GUARD_HOST_PID}" \
    "${BACKUP_CAPACITY_GUARD_STARTTIME}" "${owner_host_pid}" \
    "${plan}" "${BACKUP_CAPACITY_GUARD_LEASES}" \
    "${BACKUP_CAPACITY_STATE}" "${BACKUP_SELECTED_PUBLICATION_ROLE:-}" <<'PY'
import json
import os
import pathlib
import re
import signal
import stat
import sys

namespace_pid = int(sys.argv[1])
host_pid = int(sys.argv[2])
expected_starttime = sys.argv[3]
expected_parent = int(sys.argv[4])
plan = json.loads(sys.argv[5])
resources = json.loads(sys.argv[6])
state = sys.argv[7]
selected_role = sys.argv[8]

def integer(value, minimum, maximum):
    return (
        isinstance(value, int) and not isinstance(value, bool)
        and minimum <= value <= maximum
    )

def safe_name(value, marker):
    return (
        isinstance(value, str)
        and value.startswith("portal-")
        and marker in value
        and "/" not in value
        and 1 <= len(value.encode("utf-8")) <= 255
        and all(32 <= ord(character) < 127 for character in value)
    )

plan_keys = {
    "schema", "mode", "reserveBytes", "componentCount",
    "perComponentGrowthBytes", "components", "databaseDumpBytes",
    "basePayloadBytes",
    "growthHeadroomBytes", "sqliteScratchBytes", "evidenceHeadroomBytes",
    "maxComponentEvidenceBytes", "retainedEvidenceGenerations",
    "retainedEvidenceBytes",
    "accountedBytes", "workPayloadBytes", "workInodes", "workImageBytes",
    "workAnchor", "workMountPoint", "publicationTargets",
}
if (
    not isinstance(plan, dict)
    or set(plan) != plan_keys
    or plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") not in {"create", "verify"}
    or not integer(plan.get("reserveBytes"), 64 * 1024**2, 8 * 1024**3)
    or not integer(plan.get("componentCount"), 0, 64)
    or not isinstance(plan.get("components"), list)
    or len(plan["components"]) != plan["componentCount"]
    or not integer(plan.get("perComponentGrowthBytes"), 0, 8 * 1024**3)
    or not integer(plan.get("databaseDumpBytes"), 0, 2 * 1024**4)
    or not integer(plan.get("basePayloadBytes"), 1, 2 * 1024**4)
    or not integer(plan.get("growthHeadroomBytes"), 0, 512 * 1024**3)
    or plan["growthHeadroomBytes"] != plan["perComponentGrowthBytes"]
    or not integer(plan.get("sqliteScratchBytes"), 0, 4 * 1024**3)
    or not integer(plan.get("evidenceHeadroomBytes"), 0, 1024**3)
    or not integer(plan.get("maxComponentEvidenceBytes"), 0, 1024**3)
    or not integer(plan.get("retainedEvidenceGenerations"), 0, 12)
    or not integer(plan.get("retainedEvidenceBytes"), 0, 12 * 1024**3)
    or plan["retainedEvidenceBytes"]
        != plan["maxComponentEvidenceBytes"]
            * plan["retainedEvidenceGenerations"]
    or not integer(plan.get("accountedBytes"), 1, 2 * 1024**4)
    or plan["accountedBytes"]
        != plan["basePayloadBytes"] + plan["growthHeadroomBytes"]
    or not integer(plan.get("workPayloadBytes"), 1, 8 * 1024**4)
    or not integer(plan.get("workInodes"), 8192, 2_100_000)
    or not integer(plan.get("workImageBytes"), 1, 8 * 1024**4)
    or plan["workImageBytes"] <= plan["workPayloadBytes"]
    or not isinstance(plan.get("workMountPoint"), str)
    or not plan["workMountPoint"].startswith("/")
    or os.path.normpath(plan["workMountPoint"]) != plan["workMountPoint"]
    or not isinstance(plan.get("publicationTargets"), list)
):
    raise SystemExit(1)
if plan["mode"] == "create":
    if (
        plan["componentCount"] <= 0
        or plan["databaseDumpBytes"] <= 0
        or plan["evidenceHeadroomBytes"] <= 0
        or plan["maxComponentEvidenceBytes"] <= 0
        or plan["retainedEvidenceGenerations"] != 12
        or len(plan["publicationTargets"]) != 2
        or plan["workPayloadBytes"]
            != plan["accountedBytes"] * 2
                + plan["sqliteScratchBytes"]
                + plan["retainedEvidenceBytes"]
    ):
        raise SystemExit(1)
elif (
    plan["componentCount"] != 0
    or plan["components"]
    or plan["databaseDumpBytes"] != 0
    or plan["perComponentGrowthBytes"] != 0
    or plan["growthHeadroomBytes"] != 0
    or plan["sqliteScratchBytes"] != 0
    or plan["evidenceHeadroomBytes"] != 0
    or plan["maxComponentEvidenceBytes"] != 0
    or plan["retainedEvidenceGenerations"] != 0
    or plan["retainedEvidenceBytes"] != 0
    or plan["workPayloadBytes"] != plan["accountedBytes"]
    or plan["publicationTargets"]
):
    raise SystemExit(1)

for component in plan["components"]:
    if (
        not isinstance(component, dict)
        or set(component) != {
            "path", "archiveBytes", "memberCount", "pathBytes",
            "evidenceBytes",
        }
        or not isinstance(component.get("path"), str)
        or not component["path"].startswith("/")
        or os.path.normpath(component["path"]) != component["path"]
        or not integer(component.get("archiveBytes"), 1, 2 * 1024**4)
        or not integer(component.get("memberCount"), 1, 1_000_000)
        or not integer(component.get("pathBytes"), 1, 4 * 1024**3)
        or not integer(component.get("evidenceBytes"), 1, 1024**3)
        or component["evidenceBytes"] > plan["maxComponentEvidenceBytes"]
    ):
        raise SystemExit(1)
if plan["mode"] == "create" and max(
    component["evidenceBytes"] for component in plan["components"]
) != plan["maxComponentEvidenceBytes"]:
    raise SystemExit(1)

def directory_identity(document):
    if not isinstance(document, dict) or set(document) != {
        "parent", "device", "inode", "mountId"
    }:
        raise SystemExit(1)
    path_raw = document.get("parent")
    if (
        not isinstance(path_raw, str)
        or not path_raw.startswith("/")
        or os.path.normpath(path_raw) != path_raw
        or os.path.realpath(path_raw) != path_raw
        or not integer(document.get("device"), 0, 2**64 - 1)
        or not integer(document.get("inode"), 1, 2**64 - 1)
        or not integer(document.get("mountId"), 1, 2**64 - 1)
    ):
        raise SystemExit(1)
    descriptor = os.open(
        path_raw,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        info = os.fstat(descriptor)
        values = []
        with open(
            f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii"
        ) as handle:
            for line in handle:
                if line.startswith("mnt_id:"):
                    values.append(line.partition(":")[2].strip())
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
            or info.st_dev != document["device"]
            or info.st_ino != document["inode"]
            or len(values) != 1
            or not values[0].isdigit()
            or int(values[0]) != document["mountId"]
        ):
            raise SystemExit(1)
    finally:
        os.close(descriptor)

directory_identity(plan["workAnchor"])
targets = {}
for target in plan["publicationTargets"]:
    if not isinstance(target, dict) or set(target) != {
        "role", "parent", "device", "inode", "mountId",
        "partialName", "receiptName", "candidateBytes", "receiptBytes",
    }:
        raise SystemExit(1)
    role = target.get("role")
    if (
        role not in {"complete", "degraded"}
        or role in targets
        or not safe_name(target.get("partialName"), ".tar.gz.partial-")
        or not safe_name(target.get("receiptName"), ".tar.gz.receipt.json")
        or not integer(target.get("candidateBytes"), 1, 2 * 1024**4)
        or target["candidateBytes"] != plan["accountedBytes"]
        or target.get("receiptBytes") != 1024 * 1024
    ):
        raise SystemExit(1)
    directory_identity({
        key: target[key] for key in ("parent", "device", "inode", "mountId")
    })
    targets[role] = target
if plan["mode"] == "create" and set(targets) != {"complete", "degraded"}:
    raise SystemExit(1)

try:
    pid_descriptor = os.pidfd_open(namespace_pid, 0)
except (AttributeError, OSError):
    raise SystemExit(1)
try:
    raw = pathlib.Path(f"/proc/{host_pid}/stat").read_text(
        encoding="ascii"
    ).strip()
    status = pathlib.Path(f"/proc/{host_pid}/status").read_text(
        encoding="ascii"
    ).splitlines()
    closing = raw.rfind(")")
    fields = raw[closing + 2:].split() if closing > 1 else []
    parents = [
        line.partition(":")[2].strip()
        for line in status if line.startswith("PPid:")
    ]
    nspids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("NSpid:")
    ]
    uids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("Uid:")
    ]
    if (
        len(fields) < 20
        or fields[0] == "Z"
        or fields[19] != expected_starttime
        or parents != [str(expected_parent)]
        or len(nspids) != 1
        or not nspids[0]
        or nspids[0][0] != str(host_pid)
        or nspids[0][-1] != str(namespace_pid)
        or uids != [["0", "0", "0", "0"]]
    ):
        raise SystemExit(1)
    signal.pidfd_send_signal(pid_descriptor, 0)
finally:
    os.close(pid_descriptor)

if (
    not isinstance(resources, dict)
    or set(resources) != {"schema", "reserveBytes", "holderHostPid", "entries"}
    or resources.get("schema") != "bridgesllm.backup-capacity-resources.v2"
    or resources.get("reserveBytes") != plan["reserveBytes"]
    or resources.get("holderHostPid") != host_pid
    or not isinstance(resources.get("entries"), list)
):
    raise SystemExit(1)
expected_count = 1 if plan["mode"] == "verify" else 5
if len(resources["entries"]) != expected_count:
    raise SystemExit(1)
observed_fds = set()
observed_kinds = set()
for entry in resources["entries"]:
    if not isinstance(entry, dict) or set(entry) != {
        "kind", "role", "parent", "pathName", "fd", "device",
        "inode", "mountId", "reservedBytes", "blocks",
    }:
        raise SystemExit(1)
    kind = entry.get("kind")
    role = entry.get("role")
    descriptor = entry.get("fd")
    if (
        kind not in {"work-image", "archive-candidate", "receipt-candidate"}
        or not isinstance(role, str)
        or not integer(descriptor, 3, 1_000_000)
        or descriptor in observed_fds
        or not integer(entry.get("device"), 0, 2**64 - 1)
        or not integer(entry.get("inode"), 1, 2**64 - 1)
        or not integer(entry.get("mountId"), 1, 2**64 - 1)
        or not integer(entry.get("reservedBytes"), 1, 8 * 1024**4)
        or not integer(entry.get("blocks"), 1, 2**63 - 1)
    ):
        raise SystemExit(1)
    if kind == "work-image":
        expected = plan["workAnchor"]
        expected_bytes = plan["workImageBytes"]
        expected_name = ""
        expected_role = "work"
    else:
        if role not in targets:
            raise SystemExit(1)
        expected = targets[role]
        expected_bytes = (
            expected["candidateBytes"]
            if kind == "archive-candidate"
            else expected["receiptBytes"]
        )
        expected_name = (
            expected["partialName"]
            if kind == "archive-candidate"
            else expected["receiptName"]
        )
        expected_role = role
    if (
        role != expected_role
        or entry["parent"] != expected["parent"]
        or entry["device"] != expected["device"]
        or entry["mountId"] != expected["mountId"]
        or entry["pathName"] != expected_name
        or entry["reservedBytes"] != expected_bytes
        or (kind, role) in observed_kinds
    ):
        raise SystemExit(1)
    info = os.stat(f"/proc/{host_pid}/fd/{descriptor}")
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_dev != entry["device"]
        or info.st_ino != entry["inode"]
        or info.st_size <= 0
        or info.st_size > entry["reservedBytes"]
        or info.st_blocks <= 0
        or info.st_blocks * 512 < info.st_size
    ):
        raise SystemExit(1)
    selected_archive = (
        kind == "archive-candidate" and role == selected_role
    )
    selected_receipt = (
        kind == "receipt-candidate" and role == selected_role
    )
    archive_mutable = selected_archive and state in {
        "archive-streaming", "candidate-settled", "verified",
        "receipt-writing", "receipt-settled", "publishing", "published",
    }
    receipt_mutable = selected_receipt and state in {
        "receipt-writing", "receipt-settled", "publishing", "published",
    }
    if not archive_mutable and not receipt_mutable:
        if info.st_size != entry["reservedBytes"]:
            raise SystemExit(1)
    if kind == "work-image":
        if info.st_nlink != 0:
            raise SystemExit(1)
    else:
        if info.st_nlink != 1:
            raise SystemExit(1)
        named_names = [entry["pathName"]]
        if selected_archive and state in {"publishing", "published"}:
            final_name = targets[role]["receiptName"].removesuffix(
                ".receipt.json"
            )
            named_names = (
                [final_name]
                if state == "published"
                else [entry["pathName"], final_name]
            )
        matches = []
        for named_name in named_names:
            try:
                named = os.lstat(
                    pathlib.Path(entry["parent"]) / named_name
                )
            except FileNotFoundError:
                continue
            if (
                not stat.S_ISREG(named.st_mode)
                or stat.S_ISLNK(named.st_mode)
                or (named.st_dev, named.st_ino)
                    != (info.st_dev, info.st_ino)
            ):
                raise SystemExit(1)
            matches.append(named_name)
        if len(matches) != 1:
            raise SystemExit(1)
    observed_fds.add(descriptor)
    observed_kinds.add((kind, role))
expected_kinds = {("work-image", "work")}
if plan["mode"] == "create":
    expected_kinds |= {
        (kind, role)
        for kind in ("archive-candidate", "receipt-candidate")
        for role in ("complete", "degraded")
    }
if observed_kinds != expected_kinds:
    raise SystemExit(1)
actual_fds = {
    int(value) for value in os.listdir(f"/proc/{host_pid}/fd")
    if re.fullmatch(r"[0-9]+", value)
}
if actual_fds != observed_fds:
    raise SystemExit(1)
if selected_role and selected_role not in targets:
    raise SystemExit(1)
if not selected_role and state in {
    "archive-streaming", "candidate-settled", "verified",
    "receipt-writing", "receipt-settled", "publishing", "published",
}:
    raise SystemExit(1)
PY
}

acquire_backup_capacity_guard() {
  local plan="$1"
  backup_capacity_guard_state_present && return 1
  local owner_pid="${BASHPID}" owner_host_pid=""
  local ready="" holder_host_pid="" resources="" extra=""
  local coproc_pid="" read_fd="" write_fd="" starttime=""
  owner_host_pid="$(backup_self_host_pid "${owner_pid}")" || return 1
  coproc BACKUP_CAPACITY_HOLDER {
    exec python3 /dev/fd/3 "${owner_pid}" "${owner_host_pid}" \
      "${plan}" 3<<'PY'
import ctypes
import json
import os
import pathlib
import re
import signal
import stat
import sys

expected_parent_namespace = int(sys.argv[1])
expected_parent_host = int(sys.argv[2])
plan = json.loads(sys.argv[3])
if expected_parent_namespace < 1 or expected_parent_host <= 1:
    raise SystemExit(1)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise SystemExit(1)
if os.getppid() != expected_parent_namespace:
    os.kill(os.getpid(), signal.SIGKILL)
for managed in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(managed, signal.SIG_IGN)

def retire(_number, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGUSR1, retire)
if (
    not hasattr(os, "O_TMPFILE")
    or not hasattr(os, "O_NOFOLLOW")
    or not hasattr(os, "O_DIRECTORY")
    or not hasattr(os, "posix_fallocate")
):
    raise SystemExit("concrete backup capacity resources are unavailable")

def integer(value, minimum, maximum):
    return (
        isinstance(value, int) and not isinstance(value, bool)
        and minimum <= value <= maximum
    )

plan_keys = {
    "schema", "mode", "reserveBytes", "componentCount",
    "perComponentGrowthBytes", "components", "databaseDumpBytes",
    "basePayloadBytes",
    "growthHeadroomBytes", "sqliteScratchBytes", "evidenceHeadroomBytes",
    "maxComponentEvidenceBytes", "retainedEvidenceGenerations",
    "retainedEvidenceBytes",
    "accountedBytes", "workPayloadBytes", "workInodes", "workImageBytes",
    "workAnchor", "workMountPoint", "publicationTargets",
}
if (
    not isinstance(plan, dict)
    or set(plan) != plan_keys
    or plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") not in {"create", "verify"}
    or not integer(plan.get("reserveBytes"), 64 * 1024**2, 8 * 1024**3)
    or not integer(plan.get("databaseDumpBytes"), 0, 2 * 1024**4)
    or not integer(plan.get("maxComponentEvidenceBytes"), 0, 1024**3)
    or not integer(plan.get("retainedEvidenceGenerations"), 0, 12)
    or not integer(plan.get("retainedEvidenceBytes"), 0, 12 * 1024**3)
    or plan["retainedEvidenceBytes"]
        != plan["maxComponentEvidenceBytes"]
            * plan["retainedEvidenceGenerations"]
    or not integer(plan.get("workPayloadBytes"), 1, 8 * 1024**4)
    or not integer(plan.get("workInodes"), 8192, 2_100_000)
    or not integer(plan.get("workImageBytes"), 1, 8 * 1024**4)
    or plan["workImageBytes"] <= plan["workPayloadBytes"]
    or not isinstance(plan.get("publicationTargets"), list)
    or not isinstance(plan.get("workAnchor"), dict)
    or set(plan["workAnchor"]) != {"parent", "device", "inode", "mountId"}
):
    raise SystemExit("backup capacity plan is invalid")
if (
    (plan["mode"] == "create" and len(plan["publicationTargets"]) != 2)
    or (plan["mode"] == "verify" and plan["publicationTargets"])
):
    raise SystemExit("backup capacity publication topology is invalid")

AT_EMPTY_PATH = 0x1000
linkat = libc.linkat
linkat.argtypes = [
    ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
    ctypes.c_int,
]
linkat.restype = ctypes.c_int

def mount_id(descriptor):
    values = []
    with open(
        f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii"
    ) as handle:
        for line in handle:
            if line.startswith("mnt_id:"):
                values.append(line.partition(":")[2].strip())
    if len(values) != 1 or not values[0].isdigit() or int(values[0]) <= 0:
        raise ValueError("backup capacity mount identity is unavailable")
    return int(values[0])

def open_parent(document):
    if (
        not isinstance(document, dict)
        or not {"parent", "device", "inode", "mountId"}.issubset(document)
    ):
        raise ValueError("backup capacity parent record is invalid")
    raw = document["parent"]
    if (
        not isinstance(raw, str)
        or not raw.startswith("/")
        or os.path.normpath(raw) != raw
        or os.path.realpath(raw) != raw
    ):
        raise ValueError("backup capacity parent path is unsafe")
    descriptor = os.open(
        raw,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
            or info.st_dev != document["device"]
            or info.st_ino != document["inode"]
            or mount_id(descriptor) != document["mountId"]
        ):
            raise ValueError("backup capacity parent identity changed")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

resources = []
resource_descriptors = []
linked = []
ready_sent = False

def create_resource(kind, role, parent_document, reserved, path_name=""):
    if (
        kind not in {"work-image", "archive-candidate", "receipt-candidate"}
        or not integer(reserved, 1, 8 * 1024**4)
        or not isinstance(path_name, str)
        or (kind == "work-image") != (path_name == "")
    ):
        raise ValueError("backup capacity resource request is invalid")
    parent_fd = open_parent(parent_document)
    try:
        if path_name:
            if (
                "/" in path_name
                or len(path_name.encode("utf-8")) > 255
                or any(ord(character) < 32 or ord(character) == 127
                       for character in path_name)
            ):
                raise ValueError("backup capacity resource name is unsafe")
            try:
                os.stat(path_name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError("backup capacity publication path exists")
        flags = os.O_RDWR | os.O_TMPFILE | getattr(os, "O_CLOEXEC", 0)
        if kind == "work-image":
            flags |= os.O_EXCL
        descriptor = os.open(".", flags, 0o600, dir_fd=parent_fd)
        resource_descriptors.append(descriptor)
        os.fchmod(descriptor, 0o600)
        created = os.fstat(descriptor)
        if (
            not stat.S_ISREG(created.st_mode)
            or created.st_uid != 0
            or created.st_gid != 0
            or created.st_nlink != 0
            or stat.S_IMODE(created.st_mode) != 0o600
            or created.st_dev != parent_document["device"]
            or created.st_size != 0
        ):
            raise ValueError("backup capacity resource inode is unsafe")
        os.posix_fallocate(descriptor, 0, reserved)
        os.fsync(descriptor)
        if path_name:
            encoded = os.fsencode(path_name)
            if linkat(descriptor, b"", parent_fd, encoded, AT_EMPTY_PATH) != 0:
                number = ctypes.get_errno()
                raise OSError(number, os.strerror(number))
            linked.append((parent_document["parent"], path_name, descriptor))
            os.fsync(parent_fd)
        held = os.fstat(descriptor)
        if (
            held.st_size != reserved
            or held.st_blocks * 512 < reserved
            or held.st_nlink != (1 if path_name else 0)
            or held.st_dev != parent_document["device"]
            or held.st_ino != created.st_ino
        ):
            raise OSError("backup capacity resource is sparse or incomplete")
        resources.append({
            "kind": kind,
            "role": role,
            "parent": parent_document["parent"],
            "pathName": path_name,
            "fd": descriptor,
            "device": held.st_dev,
            "inode": held.st_ino,
            "mountId": parent_document["mountId"],
            "reservedBytes": reserved,
            "blocks": held.st_blocks,
        })
    finally:
        os.close(parent_fd)

try:
    create_resource(
        "work-image", "work", plan["workAnchor"], plan["workImageBytes"]
    )
    roles = set()
    for target in plan["publicationTargets"]:
        if not isinstance(target, dict) or set(target) != {
            "role", "parent", "device", "inode", "mountId",
            "partialName", "receiptName", "candidateBytes", "receiptBytes",
        }:
            raise ValueError("backup capacity target is invalid")
        role = target["role"]
        if role not in {"complete", "degraded"} or role in roles:
            raise ValueError("backup capacity target role is invalid")
        if (
            target["candidateBytes"] != plan["accountedBytes"]
            or target["receiptBytes"] != 1024 * 1024
        ):
            raise ValueError("backup capacity target bytes are invalid")
        create_resource(
            "archive-candidate", role, target,
            target["candidateBytes"], target["partialName"],
        )
        create_resource(
            "receipt-candidate", role, target,
            target["receiptBytes"], target["receiptName"],
        )
        roles.add(role)
    if plan["mode"] == "create" and roles != {"complete", "degraded"}:
        raise ValueError("backup capacity targets are incomplete")

    checked_mounts = set()
    for resource in resources:
        mount_key = (resource["device"], resource["mountId"])
        if mount_key in checked_mounts:
            continue
        stats = os.statvfs(resource["parent"])
        if stats.f_bavail * stats.f_frsize < plan["reserveBytes"]:
            raise OSError("backup recovery reserve was consumed during allocation")
        checked_mounts.add(mount_key)

    if os.getppid() != expected_parent_namespace:
        os.kill(os.getpid(), signal.SIGKILL)
    status = open("/proc/self/status", "r", encoding="ascii").read().splitlines()
    pids = [line.partition(":")[2].strip() for line in status if line.startswith("Pid:")]
    parents = [line.partition(":")[2].strip() for line in status if line.startswith("PPid:")]
    nspids = [line.partition(":")[2].split() for line in status if line.startswith("NSpid:")]
    if (
        len(pids) != 1 or not pids[0].isdigit()
        or parents != [str(expected_parent_host)]
        or len(nspids) != 1 or not nspids[0]
        or nspids[0][0] != pids[0]
        or nspids[0][-1] != str(os.getpid())
    ):
        raise ValueError("backup capacity holder identity is invalid")
    host_pid = int(pids[0])
    document = {
        "schema": "bridgesllm.backup-capacity-resources.v2",
        "reserveBytes": plan["reserveBytes"],
        "holderHostPid": host_pid,
        "entries": sorted(
            resources, key=lambda value: (value["kind"], value["role"])
        ),
    }
    payload = (
        "READY\t" + str(host_pid) + "\t"
        + json.dumps(document, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("ascii")
    if os.write(1, payload) != len(payload):
        raise OSError("backup capacity readiness write was short")
    ready_sent = True
    keep = set(resource_descriptors)
    for raw_descriptor in os.listdir("/proc/self/fd"):
        try:
            candidate = int(raw_descriptor)
        except ValueError:
            continue
        if candidate in keep:
            continue
        try:
            os.close(candidate)
        except OSError:
            pass
    while True:
        signal.pause()
finally:
    if not ready_sent:
        for parent_raw, name, descriptor in reversed(linked):
            try:
                current = os.lstat(pathlib.Path(parent_raw) / name)
                held = os.fstat(descriptor)
                if (current.st_dev, current.st_ino) == (held.st_dev, held.st_ino):
                    os.unlink(pathlib.Path(parent_raw) / name)
            except OSError:
                pass
    for descriptor in resource_descriptors:
        try:
            os.close(descriptor)
        except OSError:
            pass
PY
  }
  coproc_pid="${BACKUP_CAPACITY_HOLDER_PID:-}"
  read_fd="${BACKUP_CAPACITY_HOLDER[0]:-}"
  write_fd="${BACKUP_CAPACITY_HOLDER[1]:-}"
  if [[ ! "${coproc_pid}" =~ ^[1-9][0-9]*$ \
    || ! "${read_fd}" =~ ^[0-9]+$ \
    || ! "${write_fd}" =~ ^[0-9]+$ ]]; then
    [[ ! "${coproc_pid}" =~ ^[1-9][0-9]*$ ]] \
      || { kill -KILL "${coproc_pid}" 2>/dev/null || true; wait "${coproc_pid}" 2>/dev/null || true; }
    return 1
  fi
  exec {write_fd}>&-
  if ! IFS=$'\t' read -r -t 300 \
      ready holder_host_pid resources extra <&"${read_fd}"; then
    exec {read_fd}<&-
    kill -KILL "${coproc_pid}" 2>/dev/null || true
    wait "${coproc_pid}" 2>/dev/null || true
    return 1
  fi
  exec {read_fd}<&-
  if [[ "${ready}" != "READY" \
    || ! "${holder_host_pid}" =~ ^[1-9][0-9]*$ \
    || -z "${resources}" || -n "${extra}" ]]; then
    kill -KILL "${coproc_pid}" 2>/dev/null || true
    wait "${coproc_pid}" 2>/dev/null || true
    return 1
  fi
  starttime="$(backup_process_starttime "${holder_host_pid}")" || starttime=""
  if [[ ! "${starttime}" =~ ^[0-9]+$ ]]; then
    kill -KILL "${coproc_pid}" 2>/dev/null || true
    wait "${coproc_pid}" 2>/dev/null || true
    return 1
  fi
  BACKUP_CAPACITY_GUARD_PID="${coproc_pid}"
  BACKUP_CAPACITY_GUARD_HOST_PID="${holder_host_pid}"
  BACKUP_CAPACITY_GUARD_STARTTIME="${starttime}"
  BACKUP_CAPACITY_GUARD_PLAN="${plan}"
  BACKUP_CAPACITY_GUARD_LEASES="${resources}"
  BACKUP_CAPACITY_STATE="resources-ready"
  BACKUP_SELECTED_PUBLICATION_ROLE=""
  BACKUP_PUBLICATION_COMMITTED=false
  if ! assert_backup_capacity_guard; then
    terminate_backup_capacity_guard_process \
      "${coproc_pid}" "${holder_host_pid}" "${starttime}" \
      "${owner_host_pid}" || true
    BACKUP_CAPACITY_GUARD_PID=""
    BACKUP_CAPACITY_GUARD_HOST_PID=""
    BACKUP_CAPACITY_GUARD_STARTTIME=""
    BACKUP_CAPACITY_GUARD_PLAN=""
    BACKUP_CAPACITY_GUARD_LEASES=""
    BACKUP_CAPACITY_STATE=""
    return 1
  fi
}

ensure_backup_capacity_guard() {
  local plan="$1"
  if ! backup_capacity_guard_state_present; then
    acquire_backup_capacity_guard "${plan}"
    return
  fi
  assert_backup_capacity_guard || return 1
  assert_backup_capacity_guard "${plan}"
}

assert_backup_capacity_revalidation_within_guard() {
  local candidate_plan="$1"
  [[ -n "${candidate_plan}" ]] || return 1
  assert_backup_capacity_guard || return 1
  python3 - "${BACKUP_CAPACITY_GUARD_PLAN}" "${candidate_plan}" <<'PY'
import json
import os
import sys

admitted = json.loads(sys.argv[1])
candidate = json.loads(sys.argv[2])

plan_keys = {
    "schema", "mode", "reserveBytes", "componentCount",
    "perComponentGrowthBytes", "components", "databaseDumpBytes",
    "basePayloadBytes", "growthHeadroomBytes", "sqliteScratchBytes",
    "evidenceHeadroomBytes", "maxComponentEvidenceBytes",
    "retainedEvidenceGenerations", "retainedEvidenceBytes",
    "accountedBytes", "workPayloadBytes", "workInodes", "workImageBytes",
    "workAnchor", "workMountPoint", "publicationTargets",
}
component_keys = {
    "path", "archiveBytes", "memberCount", "pathBytes", "evidenceBytes",
}
target_keys = {
    "role", "parent", "device", "inode", "mountId", "partialName",
    "receiptName", "candidateBytes", "receiptBytes",
}

def integer(value, minimum, maximum):
    return (
        isinstance(value, int) and not isinstance(value, bool)
        and minimum <= value <= maximum
    )

def validate(plan):
    if (
        not isinstance(plan, dict)
        or set(plan) != plan_keys
        or plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
        or plan.get("mode") != "create"
        or not integer(plan.get("reserveBytes"), 64 * 1024**2, 8 * 1024**3)
        or not integer(plan.get("componentCount"), 1, 64)
        or not isinstance(plan.get("components"), list)
        or len(plan["components"]) != plan["componentCount"]
        or not integer(plan.get("perComponentGrowthBytes"), 0, 8 * 1024**3)
        or not integer(plan.get("databaseDumpBytes"), 1, 2 * 1024**4)
        or not integer(plan.get("basePayloadBytes"), 1, 2 * 1024**4)
        or not integer(plan.get("growthHeadroomBytes"), 0, 512 * 1024**3)
        or plan["growthHeadroomBytes"] != plan["perComponentGrowthBytes"]
        or not integer(plan.get("sqliteScratchBytes"), 0, 4 * 1024**3)
        or not integer(plan.get("evidenceHeadroomBytes"), 1, 1024**3)
        or not integer(plan.get("maxComponentEvidenceBytes"), 1, 1024**3)
        or plan.get("retainedEvidenceGenerations") != 12
        or not integer(plan.get("retainedEvidenceBytes"), 1, 12 * 1024**3)
        or plan["retainedEvidenceBytes"]
            != plan["maxComponentEvidenceBytes"]
                * plan["retainedEvidenceGenerations"]
        or not integer(plan.get("accountedBytes"), 1, 2 * 1024**4)
        or plan["accountedBytes"]
            != plan["basePayloadBytes"] + plan["growthHeadroomBytes"]
        or not integer(plan.get("workPayloadBytes"), 1, 8 * 1024**4)
        or plan["workPayloadBytes"]
            != plan["accountedBytes"] * 2
                + plan["sqliteScratchBytes"]
                + plan["retainedEvidenceBytes"]
        or not integer(plan.get("workInodes"), 8192, 2_100_000)
        or not integer(plan.get("workImageBytes"), 1, 8 * 1024**4)
        or plan["workImageBytes"] <= plan["workPayloadBytes"]
        or not isinstance(plan.get("workMountPoint"), str)
        or not plan["workMountPoint"].startswith("/")
        or os.path.normpath(plan["workMountPoint"])
            != plan["workMountPoint"]
        or not isinstance(plan.get("workAnchor"), dict)
        or set(plan["workAnchor"]) != {
            "parent", "device", "inode", "mountId"
        }
        or not isinstance(plan.get("publicationTargets"), list)
        or len(plan["publicationTargets"]) != 2
    ):
        raise ValueError("backup capacity revalidation plan is invalid")

    paths = []
    for component in plan["components"]:
        if (
            not isinstance(component, dict)
            or set(component) != component_keys
            or not isinstance(component.get("path"), str)
            or not component["path"].startswith("/")
            or os.path.normpath(component["path"]) != component["path"]
            or not integer(component.get("archiveBytes"), 1, 2 * 1024**4)
            or not integer(component.get("memberCount"), 1, 1_000_000)
            or not integer(component.get("pathBytes"), 1, 4 * 1024**3)
            or not integer(component.get("evidenceBytes"), 1, 1024**3)
            or component["evidenceBytes"] > plan["maxComponentEvidenceBytes"]
        ):
            raise ValueError("backup capacity component is invalid")
        paths.append(component["path"])
    if (
        len(set(paths)) != len(paths)
        or max(component["evidenceBytes"] for component in plan["components"])
            != plan["maxComponentEvidenceBytes"]
    ):
        raise ValueError("backup capacity component set is invalid")

    roles = set()
    for target in plan["publicationTargets"]:
        if (
            not isinstance(target, dict)
            or set(target) != target_keys
            or target.get("role") not in {"complete", "degraded"}
            or target["role"] in roles
            or target.get("candidateBytes") != plan["accountedBytes"]
            or target.get("receiptBytes") != 1024 * 1024
        ):
            raise ValueError("backup capacity publication target is invalid")
        roles.add(target["role"])
    if roles != {"complete", "degraded"}:
        raise ValueError("backup capacity publication roles are incomplete")

validate(admitted)
validate(candidate)

drift = []

def refuse(kind, name, held_value, current_value):
    # Byte counts, inode counts, and fixed component roots only: the drift
    # report must explain a refused revalidation without echoing archive
    # contents or credentials.
    drift.append(f"{kind} {name}: held={held_value} candidate={current_value}")

exact_fields = (
    "schema", "mode", "reserveBytes", "componentCount",
    "perComponentGrowthBytes", "growthHeadroomBytes", "sqliteScratchBytes",
    "evidenceHeadroomBytes", "retainedEvidenceGenerations", "workAnchor",
    "workMountPoint",
)
for field in exact_fields:
    if candidate[field] != admitted[field]:
        refuse("exact", field, admitted[field], candidate[field])

bounded_fields = (
    "basePayloadBytes", "maxComponentEvidenceBytes", "retainedEvidenceBytes",
    "accountedBytes", "workPayloadBytes", "workInodes", "workImageBytes",
)
for field in bounded_fields:
    if candidate[field] > admitted[field]:
        refuse("bounded", field, admitted[field], candidate[field])

# A final Portal transaction can allocate one or more PostgreSQL pages while
# the services are being stopped.  The database dump bound may therefore grow
# even when the total payload bound shrinks because another quiesced component
# released more space.  The held lease is aggregate storage, not a dedicated
# database partition: basePayloadBytes/accountedBytes remain the authoritative
# fail-closed bounds for that redistribution.

admitted_components = {item["path"]: item for item in admitted["components"]}
candidate_components = {item["path"]: item for item in candidate["components"]}
if list(candidate_components) != list(admitted_components):
    refuse(
        "component-set", "paths",
        sorted(admitted_components), sorted(candidate_components),
    )
else:
    # The backup's own quiescence-phase state writes (progress, log, and
    # request records) live inside measured component roots but are excluded
    # from capture, so a component's raw size bound may grow by a few blocks
    # between admission and revalidation.  Like the database dump bound, a
    # component archive bound may redistribute inside the aggregate lease:
    # basePayloadBytes/accountedBytes above stay fail-closed, and the capture
    # phase still enforces every admitted per-component bound against the
    # bytes actually archived.  Member, path, and evidence inventories remain
    # strict because redistribution cannot mint new members.
    for path, current in candidate_components.items():
        held = admitted_components[path]
        for field in ("memberCount", "pathBytes", "evidenceBytes"):
            if current[field] > held[field]:
                refuse("component", f"{path} {field}", held[field], current[field])

admitted_targets = {
    target["role"]: target for target in admitted["publicationTargets"]
}
candidate_targets = {
    target["role"]: target for target in candidate["publicationTargets"]
}
if set(candidate_targets) != set(admitted_targets):
    refuse(
        "target-set", "roles",
        sorted(admitted_targets), sorted(candidate_targets),
    )
else:
    for role, current in candidate_targets.items():
        held = admitted_targets[role]
        for field in target_keys - {"candidateBytes"}:
            if current[field] != held[field]:
                refuse("target", f"{role} {field}", held[field], current[field])
        if current["candidateBytes"] > held["candidateBytes"]:
            refuse(
                "target", f"{role} candidateBytes",
                held["candidateBytes"], current["candidateBytes"],
            )

if drift:
    for line in drift:
        print(f"capacity revalidation drift: {line}", file=sys.stderr)
    raise SystemExit(1)
PY
}

mount_backup_capacity_work_image() {
  assert_backup_capacity_guard || return 1
  if [[ "${BACKUP_WORK_IMAGE_MOUNTED}" == "true" ]]; then
    [[ "${BACKUP_CAPACITY_STATE}" != "resources-ready" ]] || return 1
    backup_work_root_action attest
    return
  fi
  [[ "${BACKUP_CAPACITY_STATE}" == "resources-ready" \
    && -z "${BACKUP_WORK_IMAGE_DEVICE}" \
    && -z "${BACKUP_WORK_IMAGE_MOUNT_ID}" \
    && -z "${BACKUP_WORK_IMAGE_LOOP}" ]] || return 1
  local image_record="" image_fd="" image_device="" image_inode=""
  local image_bytes="" payload_bytes="" work_inodes="" extra=""
  image_record="$(python3 - "${BACKUP_CAPACITY_GUARD_PLAN}" \
    "${BACKUP_CAPACITY_GUARD_LEASES}" <<'PY'
import json
import sys

plan = json.loads(sys.argv[1])
resources = json.loads(sys.argv[2])
matches = [entry for entry in resources.get("entries", []) if entry.get("kind") == "work-image"]
if len(matches) != 1:
    raise SystemExit(1)
entry = matches[0]
print(
    "\t".join(str(value) for value in (
        entry["fd"], entry["device"], entry["inode"],
        entry["reservedBytes"], plan["workPayloadBytes"],
        plan["workInodes"],
    ))
)
PY
  )" || return 1
  IFS=$'\t' read -r image_fd image_device image_inode image_bytes \
    payload_bytes work_inodes extra <<<"${image_record}"
  [[ "${image_fd}" =~ ^[3-9][0-9]*$ \
    && "${image_device}" =~ ^[0-9]+$ \
    && "${image_inode}" =~ ^[1-9][0-9]*$ \
    && "${image_bytes}" =~ ^[1-9][0-9]*$ \
    && "${payload_bytes}" =~ ^[1-9][0-9]*$ \
    && "${work_inodes}" =~ ^[1-9][0-9]*$ \
    && -z "${extra}" ]] || return 1
  local image_path="/proc/${BACKUP_CAPACITY_GUARD_HOST_PID}/fd/${image_fd}"
  python3 - /usr/sbin/mkfs.ext4 /usr/bin/mount /usr/bin/umount <<'PY'
import os
import pathlib
import stat
import sys

def safe_directory(path):
    info = os.lstat(path)
    return (
        stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and info.st_uid == 0
        and info.st_gid == 0
        and not info.st_mode & 0o022
    )

def safe_chain(path):
    parts = pathlib.Path(path).parts
    current = pathlib.Path(parts[0])
    if not safe_directory(current):
        return False
    for component in parts[1:-1]:
        current /= component
        if not safe_directory(current):
            return False
    return True

for raw in sys.argv[1:]:
    path = pathlib.Path(raw)
    if (
        not path.is_absolute()
        or os.path.normpath(path) != str(path)
        or not safe_chain(path)
    ):
        raise SystemExit(1)
    leaf = os.lstat(path)
    if stat.S_ISLNK(leaf.st_mode):
        if leaf.st_uid != 0 or leaf.st_gid != 0:
            raise SystemExit(1)
        resolved = pathlib.Path(os.path.realpath(path))
        if (
            not resolved.is_absolute()
            or os.path.normpath(resolved) != str(resolved)
            or not safe_chain(resolved)
        ):
            raise SystemExit(1)
    else:
        resolved = path
    info = os.stat(resolved, follow_symlinks=False)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
        or not info.st_mode & 0o111
        or info.st_nlink < 1
    ):
        raise SystemExit(1)
PY
  backup_work_root_action attest || return 1
  local format_inodes=$((work_inodes + 2048))
  /usr/sbin/mkfs.ext4 -q -F -m 0 -T largefile4 \
    -N "${format_inodes}" -O '^has_journal' \
    -E 'nodiscard,lazy_itable_init=0,lazy_journal_init=0' \
    "${image_path}" || return 1
  python3 - "${image_path}" "${image_device}" "${image_inode}" \
    "${image_bytes}" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
device = int(sys.argv[2])
inode = int(sys.argv[3])
reserved = int(sys.argv[4])
descriptor = os.open(path, os.O_RDWR | getattr(os, "O_CLOEXEC", 0))
try:
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_dev != device
        or info.st_ino != inode
        or info.st_nlink != 0
        or info.st_size != reserved
        or info.st_blocks * 512 < reserved
    ):
        raise SystemExit(1)
finally:
    os.close(descriptor)
PY
  /usr/bin/mount -n -t ext4 \
    -o loop,nodev,nosuid,noexec,noatime,nodiscard \
    "${image_path}" "${BACKUP_WORK_ROOT}" || return 1
  /usr/bin/chown 0:0 "${BACKUP_WORK_ROOT}" || return 1
  /usr/bin/chmod 700 "${BACKUP_WORK_ROOT}" || return 1
  /usr/bin/rmdir "${BACKUP_WORK_ROOT}/lost+found" || return 1
  local mount_record="" mounted_device="" mounted_id="" loop_device=""
  mount_record="$(python3 - "${BACKUP_WORK_ROOT}" "${payload_bytes}" \
    "${work_inodes}" <<'PY'
import ctypes
import os
import pathlib
import re
import stat
import sys

path = pathlib.Path(sys.argv[1])
payload = int(sys.argv[2])
inodes = int(sys.argv[3])
descriptor = os.open(
    path,
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0),
)
try:
    info = os.fstat(descriptor)
    values = []
    with open(
        f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii"
    ) as handle:
        for line in handle:
            if line.startswith("mnt_id:"):
                values.append(line.partition(":")[2].strip())
    if len(values) != 1 or not values[0].isdigit():
        raise SystemExit(1)
    mount_id = int(values[0])
    stats = os.fstatvfs(descriptor)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
        or stats.f_bavail * stats.f_frsize < payload
        or stats.f_favail < inodes
    ):
        raise SystemExit(1)
finally:
    os.close(descriptor)
matches = []
for line in pathlib.Path("/proc/self/mountinfo").read_text(
    encoding="utf-8"
).splitlines():
    fields = line.split()
    if len(fields) < 10 or not fields[0].isdigit() or int(fields[0]) != mount_id:
        continue
    separator = fields.index("-") if "-" in fields else -1
    if separator < 6 or separator + 3 > len(fields):
        raise SystemExit(1)
    mount_options = set(fields[5].split(","))
    filesystem = fields[separator + 1]
    source = fields[separator + 2]
    super_options = set(fields[separator + 3].split(","))
    if (
        fields[4] != str(path)
        or filesystem != "ext4"
        or re.fullmatch(r"/dev/loop[0-9]+", source) is None
        or not {"rw", "nosuid", "nodev", "noexec", "noatime"}.issubset(
            mount_options | super_options
        )
        # mountinfo omits ext4's negative/default nodiscard token. The mount
        # call above explicitly forces it, so reject the active discard token.
        or "discard" in (mount_options | super_options)
    ):
        raise SystemExit(1)
    matches.append(source)
if len(matches) != 1:
    raise SystemExit(1)
print(f"{info.st_dev}\t{mount_id}\t{matches[0]}")
PY
  )" || {
    /usr/bin/umount -n "${BACKUP_WORK_ROOT}" 2>/dev/null || true
    return 1
  }
  IFS=$'\t' read -r mounted_device mounted_id loop_device extra \
    <<<"${mount_record}"
  [[ "${mounted_device}" =~ ^[0-9]+$ \
    && "${mounted_id}" =~ ^[1-9][0-9]*$ \
    && "${loop_device}" =~ ^/dev/loop[0-9]+$ \
    && -z "${extra}" \
    && "$(cat "/sys/block/${loop_device##*/}/loop/autoclear" 2>/dev/null)" == "1" ]] \
    || {
      /usr/bin/umount -n "${BACKUP_WORK_ROOT}" 2>/dev/null || true
      return 1
    }
  BACKUP_WORK_IMAGE_MOUNTED=true
  BACKUP_WORK_IMAGE_DEVICE="${mounted_device}"
  BACKUP_WORK_IMAGE_MOUNT_ID="${mounted_id}"
  BACKUP_WORK_IMAGE_LOOP="${loop_device}"
  BACKUP_CAPACITY_STATE="image-mounted"
  backup_work_root_action attest || return 1
  assert_backup_capacity_guard
}

unmount_backup_capacity_work_image() {
  if [[ "${BACKUP_WORK_IMAGE_MOUNTED}" != "true" ]]; then
    [[ -z "${BACKUP_WORK_IMAGE_DEVICE}" \
      && -z "${BACKUP_WORK_IMAGE_MOUNT_ID}" \
      && -z "${BACKUP_WORK_IMAGE_LOOP}" ]]
    return
  fi
  [[ "${BACKUP_WORK_IMAGE_MOUNT_ID}" =~ ^[1-9][0-9]*$ \
    && "${BACKUP_WORK_IMAGE_LOOP}" =~ ^/dev/loop[0-9]+$ ]] || return 1
  backup_work_root_action attest || return 1
  python3 - "${BACKUP_WORK_ROOT}" "${BACKUP_WORK_IMAGE_MOUNT_ID}" <<'PY'
import os
import sys

path = sys.argv[1]
expected_mount = int(sys.argv[2])
descriptor = os.open(
    path,
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0),
)
try:
    values = []
    with open(
        f"/proc/self/fdinfo/{descriptor}", "r", encoding="ascii"
    ) as handle:
        for line in handle:
            if line.startswith("mnt_id:"):
                values.append(line.partition(":")[2].strip())
    if values != [str(expected_mount)]:
        raise SystemExit(1)
finally:
    os.close(descriptor)
PY
  local loop_device="${BACKUP_WORK_IMAGE_LOOP}"
  /usr/bin/umount -n "${BACKUP_WORK_ROOT}" || return 1
  local attempts=0
  while [[ -e "/sys/block/${loop_device##*/}/loop/backing_file" ]] \
    && (( attempts < 100 )); do
    sleep 0.01
    ((attempts += 1))
  done
  [[ ! -e "/sys/block/${loop_device##*/}/loop/backing_file" ]] || return 1
  BACKUP_WORK_IMAGE_MOUNTED=false
  BACKUP_WORK_IMAGE_DEVICE=""
  BACKUP_WORK_IMAGE_MOUNT_ID=""
  BACKUP_WORK_IMAGE_LOOP=""
  backup_work_root_action attest
}

cleanup_backup_capacity_publication_resources() {
  [[ -n "${BACKUP_CAPACITY_GUARD_PLAN:-}" \
    && -n "${BACKUP_CAPACITY_GUARD_LEASES:-}" ]] || return 0
  python3 - "${BACKUP_CAPACITY_GUARD_PLAN}" \
    "${BACKUP_CAPACITY_GUARD_LEASES}" \
    "${BACKUP_SELECTED_PUBLICATION_ROLE:-}" \
    "${BACKUP_PUBLICATION_COMMITTED}" <<'PY'
import json
import os
import pathlib
import stat
import sys

plan = json.loads(sys.argv[1])
resources = json.loads(sys.argv[2])
selected = sys.argv[3]
committed_raw = sys.argv[4]
if committed_raw not in {"true", "false"}:
    raise SystemExit(1)
committed = committed_raw == "true"
targets = {
    target["role"]: target for target in plan.get("publicationTargets", [])
}
if selected and selected not in targets:
    raise SystemExit(1)
changed = set()
for entry in resources.get("entries", []):
    kind = entry.get("kind")
    role = entry.get("role")
    if kind not in {"archive-candidate", "receipt-candidate"}:
        continue
    if role not in targets:
        raise SystemExit(1)
    target = targets[role]
    names = [entry["pathName"]]
    if kind == "archive-candidate" and role == selected:
        names.append(target["receiptName"].removesuffix(".receipt.json"))
    for name in names:
        preserve = (
            committed
            and role == selected
            and (
                kind == "receipt-candidate"
                or name == target["receiptName"].removesuffix(".receipt.json")
            )
        )
        if preserve:
            continue
        path = pathlib.Path(entry["parent"]) / name
        try:
            current = os.lstat(path)
        except FileNotFoundError:
            continue
        held = os.stat(
            f"/proc/{resources['holderHostPid']}/fd/{entry['fd']}"
        )
        if (
            not stat.S_ISREG(current.st_mode)
            or stat.S_ISLNK(current.st_mode)
            or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino)
        ):
            raise SystemExit(1)
        path.unlink()
        changed.add(path.parent)
for parent in changed:
    descriptor = os.open(
        parent,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

release_backup_capacity_guard() {
  if ! backup_capacity_guard_state_present; then
    [[ "${BACKUP_WORK_IMAGE_MOUNTED}" == "false" ]] || return 1
    # A bare return in an EXIT trap inherits the trapped failure status even
    # after a successful test. No lease was acquired, so retirement succeeded.
    return 0
  fi
  local namespace_pid="${BACKUP_CAPACITY_GUARD_PID:-}"
  local host_pid="${BACKUP_CAPACITY_GUARD_HOST_PID:-}"
  local starttime="${BACKUP_CAPACITY_GUARD_STARTTIME:-}"
  local owner_pid="${BASHPID}" owner_host_pid="" status=0 guard_valid=false
  owner_host_pid="$(backup_self_host_pid "${owner_pid}")" || status=1
  if (( status == 0 )) && assert_backup_capacity_guard; then
    guard_valid=true
  else
    status=1
  fi
  if [[ -n "${BACKUP_ARCHIVE_CANDIDATE_FD:-}" ]]; then
    local candidate_fd="${BACKUP_ARCHIVE_CANDIDATE_FD}"
    exec {candidate_fd}>&- || status=1
    BACKUP_ARCHIVE_CANDIDATE_FD=""
  fi
  if ! unmount_backup_capacity_work_image; then
    status=1
  fi
  if ${guard_valid} && ! cleanup_backup_capacity_publication_resources; then
    status=1
  fi
  if ${guard_valid} \
    && [[ "${namespace_pid}" =~ ^[1-9][0-9]*$ \
      && "${host_pid}" =~ ^[1-9][0-9]*$ \
      && "${starttime}" =~ ^[0-9]+$ \
      && "${owner_host_pid}" =~ ^[1-9][0-9]*$ ]]; then
    terminate_backup_capacity_guard_process \
      "${namespace_pid}" "${host_pid}" "${starttime}" \
      "${owner_host_pid}" || status=1
  else
    status=1
  fi
  BACKUP_CAPACITY_GUARD_PID=""
  BACKUP_CAPACITY_GUARD_HOST_PID=""
  BACKUP_CAPACITY_GUARD_STARTTIME=""
  BACKUP_CAPACITY_GUARD_PLAN=""
  BACKUP_CAPACITY_GUARD_LEASES=""
  BACKUP_CAPACITY_STATE=""
  BACKUP_SELECTED_PUBLICATION_ROLE=""
  BACKUP_PUBLICATION_COMMITTED=false
  BACKUP_ARCHIVE_CANDIDATE_DEVICE=""
  BACKUP_ARCHIVE_CANDIDATE_INODE=""
  BACKUP_ARCHIVE_CANDIDATE_BOUND=""
  unset BACKUP_CAPACITY_HOLDER BACKUP_CAPACITY_HOLDER_PID 2>/dev/null || true
  return "${status}"
}

write_bounded_backup_archive() {
  local staging="$1" role="$2" partial_archive="$3"
  [[ "${role}" =~ ^(complete|degraded)$ \
    && "${staging}" == "${STAGING_DIR}" \
    && "${staging}" == "${BACKUP_WORK_ROOT}/"* \
    && "${partial_archive}" == /* \
    && "${BACKUP_CAPACITY_STATE}" == "image-mounted" \
    && "${BACKUP_WORK_IMAGE_MOUNTED}" == "true" \
    && -z "${BACKUP_SELECTED_PUBLICATION_ROLE}" ]] || return 1
  backup_work_root_action attest || return 1
  BACKUP_SELECTED_PUBLICATION_ROLE="${role}"
  BACKUP_CAPACITY_STATE="archive-streaming"
  assert_backup_capacity_guard || return 1

  local written_bytes=""
  if ! written_bytes="$({
    set -o pipefail
    /usr/bin/tar --format=gnu --sort=name --mtime='@0' \
      --owner=0 --group=0 --numeric-owner \
      --mode='u+rwX,go-rwx' \
      -cf - -C "${staging}" . \
      | /usr/bin/gzip -n -c \
      | python3 /dev/fd/3 \
          "${BACKUP_CAPACITY_GUARD_PLAN}" \
          "${BACKUP_CAPACITY_GUARD_LEASES}" \
          "${BACKUP_CAPACITY_GUARD_HOST_PID}" \
          "${role}" "${partial_archive}" 3<<'PY'
import json
import os
import pathlib
import stat
import sys

plan = json.loads(sys.argv[1])
resources = json.loads(sys.argv[2])
holder_host_pid = int(sys.argv[3])
role = sys.argv[4]
partial = pathlib.Path(sys.argv[5])
if (
    plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") != "create"
    or role not in {"complete", "degraded"}
    or not partial.is_absolute()
    or os.path.normpath(partial) != str(partial)
):
    raise SystemExit(1)
targets = [
    target for target in plan.get("publicationTargets", [])
    if target.get("role") == role
]
entries = [
    entry for entry in resources.get("entries", [])
    if entry.get("kind") == "archive-candidate"
    and entry.get("role") == role
]
if len(targets) != 1 or len(entries) != 1:
    raise SystemExit(1)
target = targets[0]
entry = entries[0]
expected_partial = pathlib.Path(target["parent"]) / target["partialName"]
bound = target["candidateBytes"]
if (
    partial != expected_partial
    or bound != plan.get("accountedBytes")
    or entry.get("parent") != target["parent"]
    or entry.get("pathName") != target["partialName"]
    or entry.get("reservedBytes") != bound
    or resources.get("holderHostPid") != holder_host_pid
):
    raise SystemExit(1)
proc_path = f"/proc/{holder_host_pid}/fd/{entry['fd']}"
descriptor = os.open(
    proc_path, os.O_RDWR | getattr(os, "O_CLOEXEC", 0)
)
try:
    initial = os.fstat(descriptor)
    named = os.lstat(partial)
    if (
        not stat.S_ISREG(initial.st_mode)
        or initial.st_uid != 0
        or initial.st_gid != 0
        or stat.S_IMODE(initial.st_mode) != 0o600
        or initial.st_nlink != 1
        or initial.st_dev != entry["device"]
        or initial.st_ino != entry["inode"]
        or initial.st_size != bound
        or initial.st_blocks * 512 < bound
        or not stat.S_ISREG(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or (named.st_dev, named.st_ino)
            != (initial.st_dev, initial.st_ino)
    ):
        raise OSError("backup archive candidate authority changed")
    os.lseek(descriptor, 0, os.SEEK_SET)
    written = 0
    try:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            if written + len(chunk) > bound:
                raise OSError("backup archive exceeded its admitted bound")
            view = memoryview(chunk)
            while view:
                count = os.write(descriptor, view)
                if count <= 0:
                    raise OSError("backup archive candidate write was short")
                written += count
                view = view[count:]
        if written <= 0:
            raise OSError("backup archive candidate was empty")
        os.ftruncate(descriptor, written)
        os.fsync(descriptor)
    except BaseException:
        try:
            os.ftruncate(descriptor, bound)
            os.posix_fallocate(descriptor, 0, bound)
            os.fsync(descriptor)
        except OSError:
            pass
        raise
    settled = os.fstat(descriptor)
    named = os.lstat(partial)
    if (
        settled.st_dev != initial.st_dev
        or settled.st_ino != initial.st_ino
        or settled.st_size != written
        or settled.st_blocks * 512 < written
        or settled.st_nlink != 1
        or not stat.S_ISREG(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or (named.st_dev, named.st_ino)
            != (settled.st_dev, settled.st_ino)
    ):
        raise OSError("backup archive candidate changed while settling")
    print(written)
finally:
    os.close(descriptor)
PY
  } 2>&1)"; then
    printf '%s\n' "${written_bytes}" >&2
    return 1
  fi
  [[ "${written_bytes}" =~ ^[1-9][0-9]*$ ]] || return 1
  BACKUP_CAPACITY_STATE="candidate-settled"
  assert_backup_capacity_guard
}

assert_archive_inventory_capacity_within_guard() {
  local source_dir="$1"
  local records_file="$2"
  local list_file="$3"
  local digest_file="$4"
  local unstable_file="${5:-}"
  assert_backup_capacity_guard || return 1
  python3 - "${source_dir}" "${records_file}" "${list_file}" \
    "${digest_file}" "${unstable_file}" \
    "${BACKUP_CAPACITY_GUARD_PLAN}" \
    "${ARCHIVE_XATTR_MAX_BYTES}" <<'PY'
import json
import os
import pathlib
import stat
import sys

source = pathlib.Path(sys.argv[1])
records_path = pathlib.Path(sys.argv[2])
list_path = pathlib.Path(sys.argv[3])
digest_path = pathlib.Path(sys.argv[4])
unstable_raw = sys.argv[5]
unstable_path = pathlib.Path(unstable_raw) if unstable_raw else None
plan = json.loads(sys.argv[6])
xattr_bytes = int(sys.argv[7])
if (
    not source.is_absolute()
    or os.path.normpath(source) != str(source)
    or os.path.realpath(source) != str(source)
    or not isinstance(plan, dict)
    or plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") != "create"
    or not isinstance(plan.get("components"), list)
    or not isinstance(plan.get("perComponentGrowthBytes"), int)
    or isinstance(plan.get("perComponentGrowthBytes"), bool)
    or plan["perComponentGrowthBytes"] < 0
    or plan["perComponentGrowthBytes"] > 8 * 1024**3
    or xattr_bytes <= 0
    or xattr_bytes > 16 * 1024**2
):
    raise SystemExit(1)
components = [
    component
    for component in plan["components"]
    if isinstance(component, dict) and component.get("path") == str(source)
]
if (
    len(components) != 1
    or set(components[0]) != {
        "path", "archiveBytes", "memberCount", "pathBytes", "evidenceBytes"
    }
):
    raise SystemExit(1)
component = components[0]
for key, minimum, maximum in (
    ("archiveBytes", 1, 2 * 1024**4),
    ("memberCount", 1, 1_000_000),
    ("pathBytes", 1, 4 * 1024**3),
    ("evidenceBytes", 1, 1024**3),
):
    value = component.get(key)
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not minimum <= value <= maximum
    ):
        raise SystemExit(1)
work_inodes = plan.get("workInodes")
if (
    not isinstance(work_inodes, int)
    or isinstance(work_inodes, bool)
    or work_inodes < component["memberCount"] * 2 + 16384
):
    raise SystemExit(1)

def open_evidence(path):
    if (
        not path.is_absolute()
        or os.path.normpath(path) != str(path)
        or os.path.realpath(path) != str(path)
    ):
        raise ValueError("archive capacity evidence path is unsafe")
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        info = os.fstat(descriptor)
        named = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(named.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
            or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)
            or info.st_size < 0
            or info.st_size > 1024**3
        ):
            raise ValueError("archive capacity evidence file is unsafe")
        return descriptor, info
    except BaseException:
        os.close(descriptor)
        raise

evidence_paths = [records_path, list_path, digest_path]
if unstable_path is not None:
    evidence_paths.append(unstable_path)
if len({str(path) for path in evidence_paths}) != len(evidence_paths):
    raise SystemExit(1)
evidence = []
try:
    for path in evidence_paths:
        evidence.append((path, *open_evidence(path)))
except (OSError, ValueError):
    for _path, descriptor, _info in evidence:
        os.close(descriptor)
    raise SystemExit(1)

evidence_bytes = sum(info.st_size for _path, _descriptor, info in evidence)
if evidence_bytes > component["evidenceBytes"]:
    for _path, descriptor, _info in evidence:
        os.close(descriptor)
    raise SystemExit(1)
records_descriptor = next(
    descriptor for path, descriptor, _info in evidence if path == records_path
)
records_initial = next(
    info for path, _descriptor, info in evidence if path == records_path
)

members = 0
path_bytes = 0
serialized_bytes = 0
data_bytes = 0
seen_paths = set()
seen_files = set()
try:
    with os.fdopen(
        os.dup(records_descriptor), "r", encoding="utf-8", newline=""
    ) as handle:
        for line in handle:
            encoded_line = line.encode("utf-8")
            serialized_bytes += len(encoded_line)
            if not line.endswith("\n") or len(encoded_line) > 32768:
                raise ValueError("archive capacity evidence is unbounded")
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError("archive capacity evidence is invalid")
            relative = record.get("relative")
            kind = record.get("kind")
            origin = record.get("origin")
            device = record.get("device")
            inode = record.get("inode")
            size = record.get("size")
            if (
                not isinstance(relative, str)
                or relative in seen_paths
                or len(relative.encode("utf-8")) >= 4096
                or relative.startswith("/")
                or "\\" in relative
                or "\0" in relative
                or "\n" in relative
                or (
                    relative
                    and any(part in {"", ".", ".."} for part in relative.split("/"))
                )
                or kind not in {"directory", "file", "symlink"}
                or origin not in {"source", "overlay"}
                or not isinstance(device, int)
                or isinstance(device, bool)
                or device < 0
                or not isinstance(inode, int)
                or isinstance(inode, bool)
                or inode <= 0
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
            ):
                raise ValueError("archive capacity evidence is invalid")
            seen_paths.add(relative)
            members += 1
            path_bytes += len(relative.encode("utf-8")) + 1
            if (
                members > component["memberCount"]
                or path_bytes > component["pathBytes"]
                or members * 2 + 16384 > work_inodes
            ):
                raise ValueError("archive capacity member bound was exceeded")
            if kind == "file":
                identity = (origin, device, inode)
                if identity not in seen_files:
                    seen_files.add(identity)
                    data_bytes += size
                    if data_bytes > 2 * 1024**4:
                        raise ValueError(
                            "archive capacity payload bound was exceeded"
                        )
    settled = os.fstat(records_descriptor)
    if (
        serialized_bytes != records_initial.st_size
        or (
            settled.st_dev, settled.st_ino, settled.st_size,
            settled.st_mtime_ns, settled.st_ctime_ns,
        ) != (
            records_initial.st_dev, records_initial.st_ino, records_initial.st_size,
            records_initial.st_mtime_ns, records_initial.st_ctime_ns,
        )
    ):
        raise ValueError("archive capacity evidence changed during validation")
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
finally:
    for _path, descriptor, _info in evidence:
        os.close(descriptor)
if members == 0 or path_bytes == 0:
    raise SystemExit(1)

def gzip_bound(value):
    if value < 0 or value > 2 * 1024**4:
        raise ValueError("archive capacity payload is unbounded")
    return (value * 33 + 31) // 32 + 1024**2

current_bound = gzip_bound(
    data_bytes
    + members * 32768
    + xattr_bytes * 8
    + 1024**2
)
if current_bound > component["archiveBytes"] + plan["perComponentGrowthBytes"]:
    raise SystemExit(1)
PY
}

handoff_backup_locks_to_guard() {
  [[ -z "${BACKUP_LOCK_GUARD_PID}" \
    && -z "${BACKUP_LOCK_GUARD_HOST_PID}" \
    && -z "${BACKUP_LOCK_GUARD_STARTTIME}" ]] || return 1
  local owner_pid="${BASHPID}"
  local owner_host_pid="" ready="" guard_host_pid="" extra=""
  local coproc_pid="" read_fd="" write_fd="" starttime=""
  owner_host_pid="$(backup_self_host_pid "${owner_pid}")" || return 1
  coproc BACKUP_LOCK_HOLDER {
    exec python3 /dev/fd/3 "${owner_pid}" 3<<'PY'
import ctypes
import fcntl
import os
import signal
import stat
import sys

os.close(3)
try:
    expected_parent = int(sys.argv[1])
except (IndexError, ValueError):
    raise SystemExit(1)
if expected_parent < 1:
    raise SystemExit(1)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise SystemExit(1)
if os.getppid() != expected_parent:
    os.kill(os.getpid(), signal.SIGKILL)
# systemd normally terminates a service control group as a unit. The backup
# shell must retain both locks through its TERM/HUP/INT cleanup trap, so the
# holder ignores those broadcast signals and exits only when its parent dies
# or the parent explicitly reaps it after cleanup.
for managed_signal in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(managed_signal, signal.SIG_IGN)
identities = []
for descriptor in (8, 9):
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    identities.append((info.st_dev, info.st_ino))
if len(set(identities)) != 2:
    raise SystemExit(1)
if os.getppid() != expected_parent:
    os.kill(os.getpid(), signal.SIGKILL)
status = open("/proc/self/status", "r", encoding="ascii").read().splitlines()
nspid = [line.partition(":")[2].split() for line in status if line.startswith("NSpid:")]
if len(nspid) != 1 or not nspid[0] or nspid[0][-1] != str(os.getpid()):
    raise SystemExit(1)
host_pid = int(nspid[0][0])
os.write(1, f"READY\t{host_pid}\n".encode("ascii"))
for raw_descriptor in os.listdir("/proc/self/fd"):
    try:
        descriptor = int(raw_descriptor)
    except ValueError:
        continue
    if descriptor in {8, 9}:
        continue
    try:
        os.close(descriptor)
    except OSError:
        pass
while True:
    signal.pause()
PY
  }
  coproc_pid="${BACKUP_LOCK_HOLDER_PID:-}"
  read_fd="${BACKUP_LOCK_HOLDER[0]:-}"
  write_fd="${BACKUP_LOCK_HOLDER[1]:-}"
  if [[ ! "${coproc_pid}" =~ ^[1-9][0-9]*$ \
    || ! "${read_fd}" =~ ^[0-9]+$ \
    || ! "${write_fd}" =~ ^[0-9]+$ ]]; then
    [[ ! "${coproc_pid}" =~ ^[1-9][0-9]*$ ]] \
      || { kill -KILL "${coproc_pid}" 2>/dev/null || true; wait "${coproc_pid}" 2>/dev/null || true; }
    return 1
  fi
  exec {write_fd}>&-
  if ! IFS=$'\t' read -r -t 10 ready guard_host_pid extra <&"${read_fd}"; then
    exec {read_fd}<&-
    kill -KILL "${coproc_pid}" 2>/dev/null || true
    wait "${coproc_pid}" 2>/dev/null || true
    return 1
  fi
  exec {read_fd}<&-
  if [[ "${ready}" != "READY" \
    || ! "${guard_host_pid}" =~ ^[1-9][0-9]*$ \
    || -n "${extra}" ]]; then
    kill -KILL "${coproc_pid}" 2>/dev/null || true
    wait "${coproc_pid}" 2>/dev/null || true
    return 1
  fi
  starttime="$(backup_process_starttime "${guard_host_pid}")" || starttime=""
  if [[ ! "${starttime}" =~ ^[0-9]+$ ]]; then
    kill -KILL "${coproc_pid}" 2>/dev/null || true
    wait "${coproc_pid}" 2>/dev/null || true
    return 1
  fi
  BACKUP_LOCK_GUARD_PID="${coproc_pid}"
  BACKUP_LOCK_GUARD_HOST_PID="${guard_host_pid}"
  BACKUP_LOCK_GUARD_STARTTIME="${starttime}"
  assert_backup_lock_guard || {
    terminate_backup_lock_guard_process \
      "${coproc_pid}" "${guard_host_pid}" "${starttime}" \
      "${owner_host_pid}" || true
    BACKUP_LOCK_GUARD_PID=""
    BACKUP_LOCK_GUARD_HOST_PID=""
    BACKUP_LOCK_GUARD_STARTTIME=""
    return 1
  }
  exec 8>&-
  exec 9>&-
  assert_backup_lock_guard
}

release_backup_lock_guard() {
  if [[ -z "${BACKUP_LOCK_GUARD_PID}" \
    && -z "${BACKUP_LOCK_GUARD_HOST_PID}" \
    && -z "${BACKUP_LOCK_GUARD_STARTTIME}" ]]; then
    return 0
  fi
  local pid="${BACKUP_LOCK_GUARD_PID}"
  local host_pid="${BACKUP_LOCK_GUARD_HOST_PID}"
  local starttime="${BACKUP_LOCK_GUARD_STARTTIME}"
  local owner_pid="${BASHPID}" owner_host_pid=""
  owner_host_pid="$(backup_self_host_pid "${owner_pid}")" || return 1
  local status=0
  if ! assert_backup_lock_guard; then
    status=1
  fi
  terminate_backup_lock_guard_process \
    "${pid}" "${host_pid}" "${starttime}" "${owner_host_pid}" || status=1
  BACKUP_LOCK_GUARD_PID=""
  BACKUP_LOCK_GUARD_HOST_PID=""
  BACKUP_LOCK_GUARD_STARTTIME=""
  return "${status}"
}

acquire_backup_locks() {
  prepare_secure_directory "$BACKUP_STATE_DIR" \
    || die "Backup state directory boundary is unsafe"
  prepare_secure_directory "$BACKUP_RECOVERY_STATE_DIR" \
    || die "Backup recovery directory boundary is unsafe"

  local expected_operation_lock actual_operation_lock
  expected_operation_lock="$(prepare_portal_operation_lock "$PORTAL_OPERATION_LOCK_FILE")" \
    || die 'Portal operation lock could not be prepared safely'
  exec 8<> "$PORTAL_OPERATION_LOCK_FILE" \
    || die 'Portal operation lock could not be opened safely'
  actual_operation_lock="$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' /proc/self/fd/8 2>/dev/null)" \
    || die 'Portal operation lock descriptor could not be attested'
  [[ "$actual_operation_lock" == "$expected_operation_lock" ]] \
    || die 'Portal operation lock changed while it was being opened'
  if ! flock -n 8; then
    printf 'Another Portal install, update, uninstall, or backup is already running.\n' >&2
    exit 75
  fi
  exec 9> "$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
  if ! flock -n 9; then
    printf 'Another Portal backup is already running.\n' >&2
    exit 75
  fi
  handoff_backup_locks_to_guard \
    || die "Backup locks could not be transferred to the crash-bound lock guard"
}

assert_no_foreign_backup_transactions() {
  local journal
  for journal in \
    "${PENDING_RESTORE_JOURNAL}" \
    "${PENDING_UPDATE_JOURNAL}" \
    "${PENDING_CUTOVER_JOURNAL}" \
    "${PENDING_UNINSTALL_JOURNAL}"; do
    [[ ! -e "${journal}" && ! -L "${journal}" ]] \
      || die "An interrupted restore, install, update, or uninstall must recover before backup can inspect or quiesce the host"
  done
}

recover_backup_quiescence_command() {
  acquire_backup_locks
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before quiescence recovery"
  assert_backup_crash_persistent_control_filesystems \
    || die "Backup recovery journal and boot-fence filesystems must be writable and crash-persistent"
  restore_backup_quiescence \
    || die "A prior interrupted backup could not restore its quiesced runtime state"
  assert_no_foreign_backup_transactions
  log "Backup quiescence recovery is complete"
  release_backup_lock_guard \
    || die "Backup lock guard did not release after quiescence recovery"
}

begin_run() {
  RUN_TYPE="$1"
  LIVE_RECONCILIATION_MEMBERS_USED=0
  LIVE_RECONCILIATION_BYTES_USED=0
  prepare_secure_directory "$BACKUP_STATE_DIR" \
    || die "Backup state directory boundary is unsafe"
  prepare_secure_directory "$BACKUP_REQUESTS_DIR" \
    || die "Backup request receipt directory boundary is unsafe"

  local pending="" extra=""
  pending="$(discover_pending_backup_request "${RUN_TYPE}")" \
    || die "Pending backup request receipt is unsafe or ambiguous"
  if [[ -n "${pending}" ]]; then
    IFS=$'\t' read -r \
      PENDING_REQUEST_PATH PENDING_REQUEST_ID PENDING_REQUEST_STARTED_AT \
      PENDING_REQUEST_DEV PENDING_REQUEST_INO extra <<<"${pending}"
    [[ -z "${extra}" ]] || die "Pending backup request receipt is malformed"
  fi
  acquire_backup_locks
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before backup recovery"
  trap finish_unclaimed_backup_request EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  reconcile_stale_backup_request_claims \
    || die "A stale claimed backup request could not be reconciled safely"

  local claim="" claim_extra=""
  claim="$(claim_pending_backup_request "${RUN_TYPE}")" \
    || die "Pending backup request could not be claimed safely"
  if [[ -z "${claim}" && -n "${PENDING_REQUEST_ID}" ]]; then
    die "Pending backup request changed before it could be claimed"
  fi
  if [[ -n "${claim}" ]]; then
    IFS=$'\t' read -r \
      RUN_ID RUN_STARTED_AT RUN_REQUEST_CLAIM_PATH \
      RUN_REQUEST_CLAIM_DEV RUN_REQUEST_CLAIM_INO claim_extra <<<"${claim}"
    [[ -z "${claim_extra}" ]] || die "Claimed backup request receipt is malformed"
  else
    [[ "${BACKUP_MAIN_HOST_PID}" =~ ^[1-9][0-9]*$ ]] \
      || die "Backup namespace host PID authority is unavailable"
    RUN_ID="timer-${RUN_TYPE}-$(date -u '+%Y%m%dT%H%M%S')-${BACKUP_MAIN_HOST_PID}"
    RUN_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
  [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "Invalid backup job id"

  PENDING_REQUEST_PATH=""
  PENDING_REQUEST_ID=""
  PENDING_REQUEST_STARTED_AT=""
  PENDING_REQUEST_DEV=""
  PENDING_REQUEST_INO=""
  RUN_PHASE_TOTAL=11
  RUN_PHASE="preflight"
  RUN_PHASE_LABEL="Validating backup preflight"
  RUN_PHASE_INDEX=1
  RUN_CONSECUTIVE_FAILURES="$(previous_backup_failure_streak)" \
    || die "Previous backup failure streak could not be read safely"
  RUN_ACTIVE=true
  trap finish_run EXIT
  trap 'capture_backup_error "$?" "$LINENO"' ERR
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ -n "${RUN_REQUEST_CLAIM_PATH}" ]]; then
    write_status running "" "" "" claim \
      || die "Backup request status ownership changed before preflight"
  else
    write_status running "" "" "" timer-start \
      || die "Another queued or running backup owns the status channel"
  fi
  : > "$OUTPUT_FILE"
  chmod 600 "$OUTPUT_FILE"

  if [[ -e "$PORTAL_ENV_FILE" || -L "$PORTAL_ENV_FILE" ]]; then
    assert_env_file_unambiguous "$PORTAL_ENV_FILE" \
      || die "Portal environment authority is unsafe or ambiguous"
  fi
  set_backup_postgresql_client_toolchain \
    || die "No trusted PostgreSQL client toolchain satisfies the supported security floor"
  BACKUP_BASE="$(validate_backup_base)" || die "Backup path validation failed"
  prepare_backup_work_root \
    || die_with_code BACKUP_WORK_ROOT_UNAVAILABLE \
      "Configured backup storage cannot safely host private backup workspaces"
  assert_backup_crash_persistent_control_filesystems \
    || die "Backup recovery journal and boot-fence filesystems must be writable and crash-persistent"
  restore_backup_quiescence \
    || die "A prior interrupted backup could not restore its quiesced runtime state"
  assert_no_foreign_backup_transactions
  sweep_stale_backup_artifacts \
    || die_with_code BACKUP_WORK_RECOVERY_FAILED \
      "Stale private backup workspaces or partial archives could not be removed safely"
  prepare_backup_archive_trust \
    || die "Backup authentication trust key or control directory is unsafe"
  set_backup_phase preparing "Preparing backup" 1 \
    || die "Backup progress state could not be updated after preflight"
}

backup_database_authority_environment() {
  if [[ -n "${BACKUP_AUTHORITY_ENV_FILE}" ]]; then
    [[ -f "${BACKUP_AUTHORITY_ENV_FILE}" \
      && ! -L "${BACKUP_AUTHORITY_ENV_FILE}" \
      && "$(stat -c '%u:%g:%a:%h' "${BACKUP_AUTHORITY_ENV_FILE}")" \
        == "0:0:600:1" ]] || return 1
    printf '%s\n' "${BACKUP_AUTHORITY_ENV_FILE}"
    return
  fi
  printf '%s\n' "${PORTAL_ENV_FILE}"
}

run_backup_database_guard_action() {
  local action="$1"
  local operation_id="$2"
  local authority_env="$3"
  shift 3
  [[ "${action}" == "probe" || "${action}" == "acquire" \
    || "${action}" == "assert" \
    || "${action}" == "release" || "${action}" == "peer-role-sql" \
    || "${action}" == "peer-psql" || "${action}" == "peer-pg-dump" ]] \
    || return 1
  [[ "${operation_id}" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || return 1
  local restore_script="${PORTAL_DIR}/restore-full.sh"
  [[ -f "${restore_script}" && ! -L "${restore_script}" \
    && "$(stat -c '%u:%g:%h' "${restore_script}" 2>/dev/null)" == "0:0:1" \
    && $((8#$(stat -c '%a' "${restore_script}") & 0022)) -eq 0 ]] || return 1
  [[ -f "${authority_env}" && ! -L "${authority_env}" \
    && "$(stat -c '%u:%g:%a:%h' "${authority_env}" 2>/dev/null)" \
      == "0:0:600:1" ]] || {
    # `probe` must answer under exactly the authority `acquire` will demand.
    # A gate admitted on weaker authority than the operation it guards is not
    # a gate; it is the failure this admission exists to prevent.
    [[ "${action}" != "probe" && "${action}" != "acquire" ]] || return 1
  }
  local -a environment=(
    "PATH=/usr/bin:/bin"
    "LANG=C"
    "LC_ALL=C"
    "BRIDGESLLM_RESTORE_SOURCE_ONLY=1"
    "PORTAL_ROOT=${PORTAL_DIR}"
    "BRIDGESLLM_RESTORE_STATE_ROOT=${BACKUP_RECOVERY_STATE_DIR}/restore-db-shim"
    "BRIDGESLLM_BACKUP_RECOVERY_STATE_DIR=${BACKUP_RECOVERY_STATE_DIR}"
    "BRIDGESLLM_PORTAL_OPERATION_LOCK=${PORTAL_OPERATION_LOCK_FILE}"
    "BRIDGESLLM_RESTORE_SYSTEMD_ROOT=${SYSTEMD_DIR}"
  )
  if [[ -n "${BRIDGESLLM_BACKUP_TEST_ROOT:-}" ]]; then
    local command_root
    command_root="$(dirname -- "${BACKUP_SYSTEMCTL_BIN}")"
    environment+=(
      "BRIDGESLLM_RESTORE_TEST_ROOT=${BRIDGESLLM_BACKUP_TEST_ROOT}"
      "BRIDGESLLM_RESTORE_TRUST_ROOT=${BACKUP_RECOVERY_STATE_DIR}/restore-db-shim-trust"
      "BRIDGESLLM_RESTORE_INSTALLER_STATE_ROOT=${INSTALLER_STATE_ROOT}"
      "BRIDGESLLM_RESTORE_SYSTEMCTL_BIN=${BACKUP_SYSTEMCTL_BIN}"
      "BRIDGESLLM_RESTORE_DOCKER_BIN=${BACKUP_DOCKER_BIN}"
      "BRIDGESLLM_RESTORE_SYSTEMD_RUN_BIN=${command_root}/systemd-run"
      "BRIDGESLLM_RESTORE_CURL_BIN=${BACKUP_CURL_BIN}"
      "BRIDGESLLM_RESTORE_PG_DUMP_BIN=${BACKUP_PG_DUMP_BIN}"
      "BRIDGESLLM_RESTORE_PG_RESTORE_BIN=${BACKUP_PG_RESTORE_BIN}"
      "BRIDGESLLM_RESTORE_PSQL_BIN=${BACKUP_PSQL_BIN}"
      "BRIDGESLLM_RESTORE_INITDB_BIN=${command_root}/initdb"
      "BRIDGESLLM_RESTORE_POSTGRES_BIN=${command_root}/postgres"
      "BRIDGESLLM_RESTORE_NPX_BIN=${command_root}/npx"
    )
  fi
  env -i "${environment[@]}" /bin/bash -c '
set -Eeuo pipefail
source "$1"
TRANSACTIONS_ROOT="$2"
TRANSACTION_ID="$3"
TRANSACTION_DIR="${TRANSACTIONS_ROOT}/${TRANSACTION_ID}"
AUTHORITY_ROOT="$4"
PORTAL_ENV_FILE="$5"
action="$6"
shift 6
case "${action}" in
  probe)
    # Admission for the exclusive database fence, run BEFORE anything is
    # quiesced. `capture_restore_database_peer_authority` only derives what
    # the socket, OS user, and roles would be; deriving is not connecting.
    # A deployment whose database is reachable only over TCP (a container,
    # or any remote server) can satisfy every derived value and still have
    # no peer socket to open, so the fence could only ever fail in
    # `acquire` -- after the portal and gateway were already stopped.
    # Proving the connection here is the whole point of the gate: `control`
    # is the connection `acquire` opens to fence the database, and `target`
    # is the one the dump itself needs.
    seal_database_authority_environment
    capture_restore_database_peer_authority
    # This case lives inside a single-quoted script, so the statement has to
    # be double-quoted here; a single quote would terminate that script.
    run_restore_peer_psql control -qAt --command="SELECT 1" >/dev/null
    run_restore_peer_psql target -qAt --command="SELECT 1" >/dev/null
    ;;
  acquire)
    seal_database_authority_environment
    acquire_restore_database_exclusion
    ;;
  assert)
    settle_restore_database_exclusion
    assert_restore_database_exclusion
    ;;
  release)
    release_restore_database_exclusion
    ;;
  peer-role-sql)
    restore_peer_role_sql
    ;;
  peer-psql)
    run_restore_peer_psql target "$@"
    ;;
  peer-pg-dump)
    run_restore_peer_pg_dump "$@"
    ;;
  *) exit 64 ;;
esac
' bridgesllm-backup-database-guard \
    "${restore_script}" "${BACKUP_DATABASE_TRANSACTIONS_ROOT}" \
    "${operation_id}" "${PORTAL_DIR}" "${authority_env}" "${action}" "$@"
}

prepare_backup_database_transaction() {
  local operation_id="$1"
  local transaction="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${operation_id}"
  prepare_secure_directory "${BACKUP_DATABASE_TRANSACTIONS_ROOT}" || return 1
  [[ ! -e "${transaction}" && ! -L "${transaction}" ]] || return 1
  install -d -m 700 -o root -g root "${transaction}" || return 1
  fsync_directory "${transaction}" \
    && fsync_directory "${BACKUP_DATABASE_TRANSACTIONS_ROOT}"
}

cleanup_backup_database_transaction() {
  local operation_id="$1"
  python3 - "${BACKUP_DATABASE_TRANSACTIONS_ROOT}" "${operation_id}" <<'PY'
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
operation = sys.argv[2]
if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", operation):
    raise SystemExit(1)
transaction = root / operation
root_info = os.lstat(root)
transaction_info = os.lstat(transaction)
if (
    not stat.S_ISDIR(root_info.st_mode)
    or stat.S_ISLNK(root_info.st_mode)
    or root_info.st_uid != 0
    or root_info.st_gid != 0
    or root_info.st_mode & 0o022
    or not stat.S_ISDIR(transaction_info.st_mode)
    or stat.S_ISLNK(transaction_info.st_mode)
    or transaction_info.st_uid != 0
    or transaction_info.st_gid != 0
    or stat.S_IMODE(transaction_info.st_mode) != 0o700
):
    raise SystemExit(1)
allowed = {
    "database-authority.env",
    "database-exclusion.json",
    "database-container.json",
    f".database-exclusion-{operation}",
}
entries = list(transaction.iterdir())
if any(entry.name not in allowed for entry in entries):
    raise SystemExit(1)
for entry in entries:
    info = os.lstat(entry)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        raise SystemExit(1)
    os.unlink(entry)
descriptor = os.open(
    transaction,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW,
)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.rmdir(transaction)
descriptor = os.open(
    root,
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW,
)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

assert_no_orphan_backup_database_transactions() {
  [[ -e "${BACKUP_DATABASE_TRANSACTIONS_ROOT}" \
    || -L "${BACKUP_DATABASE_TRANSACTIONS_ROOT}" ]] || return 0
  python3 - "${BACKUP_DATABASE_TRANSACTIONS_ROOT}" <<'PY'
import os
import pathlib
import stat
import sys
root = pathlib.Path(sys.argv[1])
info = os.lstat(root)
if (
    not stat.S_ISDIR(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_mode & 0o022
    or any(root.iterdir())
):
    raise SystemExit(1)
PY
}

# Answers "can this host be fenced at all?" while every service is still
# running, using a throwaway transaction so nothing is left behind either way.
assert_backup_container_fence_helper() {
  [[ -f "${BACKUP_CONTAINER_FENCE_HELPER}" \
    && ! -L "${BACKUP_CONTAINER_FENCE_HELPER}" \
    && "$(stat -c '%u:%g:%h' "${BACKUP_CONTAINER_FENCE_HELPER}" 2>/dev/null)" == "0:0:1" \
    && $((8#$(stat -c '%a' "${BACKUP_CONTAINER_FENCE_HELPER}") & 0022)) -eq 0 ]]
}

run_backup_container_fence() {
  local action="$1"
  local authority="$2"
  shift 2
  assert_backup_container_fence_helper || return 1
  /usr/bin/python3 "${BACKUP_CONTAINER_FENCE_HELPER}" \
    --docker "${BACKUP_DOCKER_BIN}" "${action}" \
    --authority "${authority}" "$@"
}

discover_backup_container_database() {
  local operation="$1"
  local authority_env="$2"
  local target="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${operation}/database-container.json"
  local database_url
  assert_backup_container_fence_helper || return 1
  database_url="$(read_env_value "${authority_env}" DATABASE_URL)" || return 1
  /usr/bin/python3 "${BACKUP_CONTAINER_FENCE_HELPER}" \
    --docker "${BACKUP_DOCKER_BIN}" discover \
    --database-url-fd 3 \
    --operation "${operation}" \
    --output "${target}" \
    --expected-major "${BACKUP_POSTGRESQL_CLIENT_MAJOR}" \
    3< <(printf '%s' "${database_url}")
}

assert_backup_database_exclusion_admission() {
  local authority operation probe_status=0 cleanup_status=0
  authority="$(backup_database_authority_environment)" || return 1
  operation="${RUN_ID}.admission"
  prepare_backup_database_transaction "${operation}" || return 1
  run_backup_database_guard_action probe "${operation}" "${authority}" \
    || probe_status=$?
  # The probe writes its derived authority into the throwaway transaction.
  # Clear it whether the probe passed or failed; a refusal must not leave
  # state behind that a later run would trip over.
  cleanup_backup_database_transaction "${operation}" || cleanup_status=$?
  if (( probe_status == 0 && cleanup_status == 0 )); then
    BACKUP_DATABASE_FENCE_MODE="local-peer"
    return 0
  fi
  (( cleanup_status == 0 )) || return 1

  # A loopback-published Docker PostgreSQL instance has no usable host peer
  # socket. Bind its immutable container ID, persistent PGDATA mount, internal
  # peer socket, database identity, and original role/database state before
  # any Portal service is stopped.
  probe_status=0
  cleanup_status=0
  prepare_backup_database_transaction "${operation}" || return 1
  discover_backup_container_database "${operation}" "${authority}" \
    || probe_status=$?
  if (( probe_status == 0 )); then
    run_backup_container_fence probe \
      "${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${operation}/database-container.json" \
      || probe_status=$?
  fi
  cleanup_backup_database_transaction "${operation}" || cleanup_status=$?
  if (( probe_status == 0 && cleanup_status == 0 )); then
    BACKUP_DATABASE_FENCE_MODE="docker-peer"
    return 0
  fi
  return 1
}

acquire_backup_database_exclusion() {
  local authority
  authority="$(backup_database_authority_environment)" || return 1
  prepare_backup_database_transaction "${RUN_ID}" || return 1
  if [[ "${BACKUP_DATABASE_FENCE_MODE}" == "docker-peer" ]]; then
    discover_backup_container_database "${RUN_ID}" "${authority}" \
      || return 1
    run_backup_container_fence acquire \
      "${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-container.json"
    return
  fi
  [[ "${BACKUP_DATABASE_FENCE_MODE}" == "local-peer" ]] || return 1
  run_backup_database_guard_action acquire "${RUN_ID}" "${authority}" \
    || return 1
  run_backup_database_guard_action assert "${RUN_ID}" "${authority}"
}

assert_backup_database_exclusion() {
  local container_authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-container.json"
  if [[ -e "${container_authority}" || -L "${container_authority}" ]]; then
    [[ -f "${container_authority}" && ! -L "${container_authority}" ]] \
      || return 1
    run_backup_container_fence assert "${container_authority}"
    return
  fi
  local authority
  authority="$(backup_database_authority_environment)" || return 1
  run_backup_database_guard_action assert "${RUN_ID}" "${authority}"
}

run_backup_guard_peer_psql() {
  local container_authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-container.json"
  if [[ -f "${container_authority}" && ! -L "${container_authority}" ]]; then
    run_backup_container_fence psql "${container_authority}" \
      --target target "$@"
    return
  fi
  local authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-authority.env"
  run_backup_database_guard_action \
    peer-psql "${RUN_ID}" "${authority}" "$@"
}

backup_guard_peer_role_sql() {
  local container_authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-container.json"
  if [[ -f "${container_authority}" && ! -L "${container_authority}" ]]; then
    run_backup_container_fence role-sql "${container_authority}"
    return
  fi
  local authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-authority.env"
  run_backup_database_guard_action \
    peer-role-sql "${RUN_ID}" "${authority}"
}

run_backup_guard_peer_pg_dump() {
  local snapshot="$1"
  [[ "${snapshot}" =~ ^[A-Za-z0-9._:-]{1,256}$ ]] || return 1
  local container_authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-container.json"
  if [[ -f "${container_authority}" && ! -L "${container_authority}" ]]; then
    run_backup_container_fence pg-dump "${container_authority}" \
      --snapshot "${snapshot}"
    return
  fi
  local authority="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${RUN_ID}/database-authority.env"
  run_backup_database_guard_action \
    peer-pg-dump "${RUN_ID}" "${authority}" \
    --no-owner \
    --no-privileges \
    --no-tablespaces \
    --format=custom \
    --compress=0 \
    "--snapshot=${snapshot}"
}

recover_backup_database_exclusion() {
  local operation_id
  operation_id="$(python3 - "${QUIESCENCE_JOURNAL}" <<'PY'
import json
import re
import sys
value = json.load(open(sys.argv[1], "r", encoding="utf-8")).get("runId")
if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value):
    raise SystemExit(1)
print(value)
PY
)" || return 1
  local transaction="${BACKUP_DATABASE_TRANSACTIONS_ROOT}/${operation_id}"
  [[ -e "${transaction}" || -L "${transaction}" ]] || return 0
  [[ -d "${transaction}" && ! -L "${transaction}" ]] || return 1
  local container_authority="${transaction}/database-container.json"
  if [[ -e "${container_authority}" || -L "${container_authority}" ]]; then
    [[ -f "${container_authority}" && ! -L "${container_authority}" ]] \
      || return 1
    run_backup_container_fence release "${container_authority}" || return 1
    cleanup_backup_database_transaction "${operation_id}"
    return
  fi
  run_backup_database_guard_action \
    release "${operation_id}" "${PORTAL_ENV_FILE}" || return 1
  cleanup_backup_database_transaction "${operation_id}"
}

seal_backup_environment() {
  local target="${STAGING_DIR}/configs/portal-backend.env.production"
  install -d -m 700 "${STAGING_DIR}/configs" || return 1
  [[ -f "${PORTAL_ENV_FILE}" && ! -L "${PORTAL_ENV_FILE}" \
    && ! -e "${target}" && ! -L "${target}" ]] || return 1
  install -m 600 -o root -g root -- "${PORTAL_ENV_FILE}" "${target}" \
    || return 1
  cmp -s -- "${PORTAL_ENV_FILE}" "${target}" || return 1
  python3 -B - "${PORTAL_DIR}/installer/portal-recovery-archive.py" "${target}" <<'PYENV' || return 1
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('portal_recovery_filter', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = helper
spec.loader.exec_module(helper)
target = pathlib.Path(sys.argv[2])
payload = helper.filtered_v3_environment(target.read_bytes())
helper.validate_v3_environment(payload)
target.write_bytes(payload)
PYENV
  sync -f -- "${target}" || return 1
  fsync_directory "${STAGING_DIR}/configs" || return 1
  BACKUP_AUTHORITY_ENV_FILE="${target}"
  BACKUP_CONFIG_ENV_FILE="${target}"
}

assert_sealed_backup_bindings() {
  local sealed_install sealed_portal_data sealed_app_data sealed_apps
  local sealed_app_sources sealed_files
  local sealed_uploads sealed_projects sealed_assets sealed_stalwart_install
  sealed_install="$(
    configured_path "${INSTALL_ROOT_OVERRIDE}" INSTALL_ROOT /opt/bridgesllm
  )" || return 1
  sealed_portal_data="$(
    configured_path "${PORTAL_DATA_ROOT_OVERRIDE}" PORTAL_DATA_ROOT "${PORTAL_DIR}"
  )" || return 1
  sealed_apps="$(
    configured_path "${APPS_ROOT_OVERRIDE}" APPS_ROOT "${sealed_install}/apps"
  )" || return 1
  sealed_app_data="$(
    configured_path "" PORTAL_DATA_ROOT "${PORTAL_DIR}"
  )" || return 1
  sealed_app_sources="$(
    configured_path "" PORTAL_APPS_ROOT "${sealed_app_data}/apps"
  )" || return 1
  sealed_files="$(
    configured_path "${PORTAL_FILES_ROOT_OVERRIDE}" PORTAL_FILES_ROOT /var/portal-files
  )" || return 1
  sealed_uploads="$(
    configured_path "${UPLOADS_ROOT_OVERRIDE}" UPLOAD_DIR "${sealed_install}/uploads"
  )" || return 1
  sealed_projects="$(
    configured_path "${PROJECTS_ROOT_OVERRIDE}" PORTAL_PROJECTS_ROOT "${sealed_portal_data}/projects"
  )" || return 1
  sealed_assets="$(
    configured_path "${PORTAL_ASSETS_ROOT_OVERRIDE}" PORTAL_ASSETS_ROOT "${sealed_install}/assets"
  )" || return 1
  sealed_stalwart_install="$(
    if [[ -n "${STALWART_INSTALL_ROOT_OVERRIDE}" ]]; then
      printf '%s\n' "${STALWART_INSTALL_ROOT_OVERRIDE}"
    else
      printf '%s\n' "${sealed_install}/stalwart"
    fi
  )"
  [[ "${INSTALL_ROOT}" == "${sealed_install}" \
    && "${PORTAL_DATA_ROOT}" == "${sealed_portal_data}" \
    && "${APP_FILES_DIR}" == "${sealed_apps}" \
    && "${PORTAL_APP_DATA_ROOT}" == "${sealed_app_data}" \
    && "${PORTAL_APP_SOURCES_DIR}" == "${sealed_app_sources}" \
    && "${PORTAL_FILES_DIR}" == "${sealed_files}" \
    && "${UPLOAD_FILES_DIR}" == "${sealed_uploads}" \
    && "${PROJECTS_DIR}" == "${sealed_projects}" \
    && "${PORTAL_ASSETS_DIR}" == "${sealed_assets}" \
    && "${STALWART_INSTALL_DIR}" == "${sealed_stalwart_install}" ]]
}

libpq_database_url() {
  local db_url="$1"
  printf '%s' "$db_url" | python3 /dev/fd/3 3<<'PY'
import os
import re
import sys
from urllib.parse import unquote, urlsplit, urlunsplit

raw = sys.stdin.read()
if (not raw or len(raw.encode("utf-8")) > 128000 or "#" in raw
        or re.search(r"%(?![0-9A-Fa-f]{2})", raw)
        or any(ord(char) < 32 or ord(char) == 127 for char in raw)):
    raise SystemExit(1)
try:
    parsed = urlsplit(raw)
    credentials, separator, host_part = parsed.netloc.rpartition("@")
    username_raw = credentials.split(":", 1)[0] if separator else ""
    host = unquote(parsed.hostname or "", errors="strict")
    user = unquote(parsed.username or "", errors="strict")
    password = unquote(parsed.password or "", errors="strict")
    database = unquote((parsed.path or "").lstrip("/"), errors="strict")
    port = 5432 if parsed.port is None else parsed.port
    decoded_host_part = unquote(host_part, errors="strict")
    raw_port_suffix = (
        host_part[host_part.find("]") + 1:]
        if host_part.startswith("[")
        else f":{host_part.rsplit(':', 1)[1]}" if ":" in host_part else ""
    )
except (UnicodeDecodeError, ValueError):
    raise SystemExit(1)
if (parsed.scheme not in {"postgres", "postgresql"} or parsed.fragment
        or re.search(r"%(?:23|24|26|2b|2c|2f|3a|3b|3d|3f|40)", parsed.path, re.I)
        or not parsed.path.startswith("/") or parsed.path.count("/") != 1
        or database in {".", ".."} or "/" in database
        or not all((separator, username_raw, host, user, password, database))
        or parsed.netloc.count("@") != 1 or host_part.startswith("[")
        or not 1 <= port <= 65535 or "," in decoded_host_part
        or (raw_port_suffix
            and not re.fullmatch(r":[1-9][0-9]*", raw_port_suffix))
        or "%" in host or "%" in (parsed.hostname or "")
        or re.search(r"[<>\\^|]", host)
        or host_part != host_part.lower() or not host.isascii()
        or any(char.isspace() for char in host)
        or any(ord(char) < 32 or ord(char) == 127
               for value in (host, user, password, database) for char in value)):
    raise SystemExit(1)
prisma_only = {
    "schema",
    "connection_limit",
    "pool_timeout",
    "pgbouncer",
    "statement_cache_size",
    "socket_timeout",
    "max_idle_connection_lifetime",
    "max_connection_lifetime",
}
preserved = {
    "connect_timeout", "sslmode", "sslrootcert", "application_name",
    "fallback_application_name", "options", "client_encoding", "replication",
}
allowed = prisma_only | preserved
identity_or_secret = {
    "password",
    "sslpassword",
    "passfile",
    "service",
    "servicefile",
    "host",
    "hostaddr",
    "port",
    "user",
    "dbname",
    "database",
}
query = []
security = {}
values = {}
seen = set()
if parsed.query:
    for raw_pair in parsed.query.split("&"):
        if "+" in raw_pair:
            raise SystemExit(1)
        raw_key, pair_separator, raw_value = raw_pair.partition("=")
        if "=" in raw_value:
            raise SystemExit(1)
        try:
            decoded_key = unquote(raw_key, errors="strict")
            key = decoded_key.lower()
            decoded_value = unquote(raw_value, errors="strict")
        except UnicodeDecodeError:
            raise SystemExit(1)
        if (not pair_separator or not key
                or any(ord(char) < 32 or ord(char) == 127
                       for value_part in (key, decoded_value)
                       for char in value_part)):
            raise SystemExit(1)
        if key in identity_or_secret:
            raise SystemExit(1)
        if decoded_key != key or key not in allowed or key in seen:
            raise SystemExit(1)
        seen.add(key)
        values[key] = decoded_value
        if key in {"sslmode", "sslrootcert"}:
            security[key] = decoded_value
        if key not in prisma_only:
            query.append(raw_pair)

ssl_mode = security.get("sslmode")
ssl_root_cert = security.get("sslrootcert")
if ssl_mode is not None and ssl_mode not in {
    "disable", "require", "verify-ca", "verify-full"
}:
    raise SystemExit(1)
if ssl_mode is None and host not in {"localhost", "127.0.0.1", "::1"}:
    raise SystemExit(1)
if ssl_root_cert is not None and (
    not ssl_root_cert
    or not os.path.isabs(ssl_root_cert)
    or any(ord(char) < 32 or ord(char) == 127 for char in ssl_root_cert)
):
    raise SystemExit(1)
if ssl_root_cert is not None and ssl_mode not in {
    "require", "verify-ca", "verify-full"
}:
    raise SystemExit(1)
if ssl_mode in {"verify-ca", "verify-full"} and ssl_root_cert is None:
    raise SystemExit(1)

def bounded_integer(name, minimum, maximum, default):
    value = values.get(name)
    if value is None:
        return default
    if not re.fullmatch(r"[0-9]+", value):
        raise SystemExit(1)
    parsed_value = int(value)
    if not minimum <= parsed_value <= maximum:
        raise SystemExit(1)
    return parsed_value

bounded_integer("connection_limit", 1, 1000, None)
connect_timeout = bounded_integer("connect_timeout", 0, 86400, 5)
pool_timeout = bounded_integer("pool_timeout", 0, 86400, 10)
bounded_integer("socket_timeout", 0, 86400, None)
bounded_integer("max_idle_connection_lifetime", 0, 86400, None)
bounded_integer("max_connection_lifetime", 0, 86400, None)
bounded_integer("statement_cache_size", 0, 1000000, None)
if (("connect_timeout" in values or "pool_timeout" in values)
        and connect_timeout != pool_timeout):
    raise SystemExit(1)
if values.get("pgbouncer") not in {None, "true", "false"}:
    raise SystemExit(1)
schema = values.get("schema")
if schema is not None and (not schema or len(schema.encode("utf-8")) > 63
        or any(ord(char) < 32 or ord(char) == 127 for char in schema)):
    raise SystemExit(1)

# pg_dump receives this URI through --dbname, so the password must not appear
# in argv/process listings. Keep the encoded username and endpoint; the secret
# travels through an anonymous inherited pgpass descriptor instead.
netloc = f"{username_raw}@{host_part}"
print(urlunsplit((parsed.scheme, netloc, parsed.path, "&".join(query), "")))
PY
}

backup_pg_dump_runner_python() {
  cat <<'PY'
import ctypes
import os
import re
import signal
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

executable_path, libpq_url = sys.argv[2:4]
command_arguments = sys.argv[4:]
if (
    not os.path.isabs(executable_path)
    or not os.path.isfile(executable_path)
    or any(ord(char) < 32 or ord(char) == 127 for char in executable_path)
    or not libpq_url
    or any(ord(char) < 32 or ord(char) == 127 for char in libpq_url)
    or not command_arguments
    or any(
        not argument
        or any(ord(char) < 32 or ord(char) == 127 for char in argument)
        for argument in command_arguments
    )
):
    raise SystemExit(1)

raw_parts = []
raw_size = 0
while True:
    part = os.read(3, min(65536, 128001 - raw_size))
    if not part:
        break
    raw_parts.append(part)
    raw_size += len(part)
    if raw_size > 128000:
        raise SystemExit(1)
os.close(3)
raw_bytes = b"".join(raw_parts)
try:
    raw = raw_bytes.decode("utf-8")
except UnicodeDecodeError:
    raise SystemExit(1)
if (not raw or len(raw.encode("utf-8")) > 128000 or "#" in raw
        or re.search(r"%(?![0-9A-Fa-f]{2})", raw)
        or any(ord(char) < 32 or ord(char) == 127 for char in raw)):
    raise SystemExit(1)
try:
    parsed = urlsplit(raw)
    _, separator, host_part = parsed.netloc.rpartition("@")
    host = unquote(parsed.hostname or "", errors="strict")
    port_number = 5432 if parsed.port is None else parsed.port
    database = unquote((parsed.path or "").lstrip("/"), errors="strict")
    user = unquote(parsed.username or "", errors="strict")
    password = unquote(parsed.password or "", errors="strict")
    decoded_host_part = unquote(host_part, errors="strict")
    raw_port_suffix = (
        host_part[host_part.find("]") + 1:]
        if host_part.startswith("[")
        else f":{host_part.rsplit(':', 1)[1]}" if ":" in host_part else ""
    )
except (UnicodeDecodeError, ValueError):
    raise SystemExit(1)
identity_or_secret = {
    "password", "sslpassword", "passfile", "service", "servicefile",
    "host", "hostaddr", "port", "user", "dbname", "database",
}
ssl_mode = None
for raw_pair in parsed.query.split("&") if parsed.query else ():
    if "+" in raw_pair:
        raise SystemExit(1)
    raw_key, pair_separator, raw_value = raw_pair.partition("=")
    if "=" in raw_value:
        raise SystemExit(1)
    try:
        key = unquote(raw_key, errors="strict").lower()
        value = unquote(raw_value, errors="strict")
    except UnicodeDecodeError:
        raise SystemExit(1)
    if (not pair_separator or not key or key in identity_or_secret
            or any(ord(char) < 32 or ord(char) == 127
                   for value_part in (key, value) for char in value_part)):
        raise SystemExit(1)
    if key == "sslmode":
        if ssl_mode is not None:
            raise SystemExit(1)
        ssl_mode = value
if (parsed.scheme not in {"postgres", "postgresql"} or parsed.fragment
        or re.search(r"%(?:23|24|26|2b|2c|2f|3a|3b|3d|3f|40)", parsed.path, re.I)
        or not parsed.path.startswith("/") or parsed.path.count("/") != 1
        or database in {".", ".."} or "/" in database
        or not separator or parsed.netloc.count("@") != 1
        or host_part.startswith("[") or not 1 <= port_number <= 65535
        or "," in decoded_host_part or "%" in host
        or "%" in (parsed.hostname or "")
        or (raw_port_suffix
            and not re.fullmatch(r":[1-9][0-9]*", raw_port_suffix))
        or re.search(r"[<>\\^|]", host)
        or host_part != host_part.lower() or not host.isascii()
        or any(char.isspace() for char in host)
        or (ssl_mode is None and host not in {"localhost", "127.0.0.1", "::1"})):
    raise SystemExit(1)
port = str(port_number)
values = (host, port, database, user, password)
if not all(values) or any(ord(char) < 32 or ord(char) == 127 for value in values for char in value):
    raise SystemExit(1)
escape = lambda value: value.replace("\\", "\\\\").replace(":", "\\:")
try:
    fd = os.memfd_create("bridgesllm-backup-pgpass", 0)
    os.fchmod(fd, 0o600)
    payload = (":".join(escape(value) for value in values) + "\n").encode()
    written = 0
    while written < len(payload):
        count = os.write(fd, payload[written:])
        if count <= 0:
            raise OSError("short pgpass write")
        written += count
    os.lseek(fd, 0, os.SEEK_SET)
    os.set_inheritable(fd, True)
except (AttributeError, OSError):
    raise SystemExit(1)

environment = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
    "PGPASSFILE": f"/proc/self/fd/{fd}",
}
os.execve(executable_path, [executable_path, *command_arguments], environment)
PY
}

select_backup_postgresql_toolchain_for_authority() {
  local authority="$1" database_url libpq_url runner_source
  local version_num major selected
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  libpq_url="$(libpq_database_url "${database_url}")" || return 1
  runner_source="$(backup_pg_dump_runner_python)" || return 1
  version_num="$(
    runner_parent="${BASHPID}"
    python3 -c "${runner_source}" "${runner_parent}" \
      "${BACKUP_PSQL_BIN}" "${libpq_url}" \
      "--dbname=${libpq_url}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      "--command=SELECT current_setting('server_version_num');" \
      3< <(printf '%s' "${database_url}")
  )" || return 1
  version_num="$(tr -d '\r\n' <<<"${version_num}")"
  [[ "${version_num}" =~ ^[0-9]{6}$ ]] || return 1
  major="$((10#${version_num} / 10000))"
  case "${major}" in
    14|15|16|17|18) ;;
    *) return 1 ;;
  esac
  # The patched client toolchain below must satisfy the security floor, but
  # an already-running server on an older patch must remain backup-able. That
  # archive is the prerequisite for safely upgrading the server itself.
  set_backup_postgresql_client_toolchain "${major}" || return 1
  selected="$(
    runner_parent="${BASHPID}"
    python3 -c "${runner_source}" "${runner_parent}" \
      "${BACKUP_PSQL_BIN}" "${libpq_url}" \
      "--dbname=${libpq_url}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      "--command=SELECT current_setting('server_version_num');" \
      3< <(printf '%s' "${database_url}")
  )" || return 1
  selected="$(tr -d '\r\n' <<<"${selected}")"
  [[ "${selected}" == "${version_num}" \
    && "${BACKUP_POSTGRESQL_CLIENT_MAJOR}" == "${major}" ]]
}

run_backup_pg_dump() {
  local db_url="$1" libpq_url="$2" snapshot="${3:-}"
  local pg_dump_path="" runner_source="" expected_parent="${BASHPID}"
  local -a dump_args=(
    "--dbname=${libpq_url}"
    --no-owner
    --no-privileges
    --no-tablespaces
    --format=custom
    --compress=0
  )
  if [[ -n "${snapshot}" ]]; then
    [[ "${snapshot}" =~ ^[A-Za-z0-9._:-]{1,256}$ ]] || return 1
    dump_args+=("--snapshot=${snapshot}")
  fi
  pg_dump_path="${BACKUP_PG_DUMP_BIN}"
  [[ -x "${pg_dump_path}" ]] || return 1
  [[ "${pg_dump_path}" == /* ]] || return 1
  runner_source="$(backup_pg_dump_runner_python)" || return 1
  python3 -c "${runner_source}" "${expected_parent}" \
    "${pg_dump_path}" "${libpq_url}" \
    "${dump_args[@]}" \
    3< <(printf '%s' "${db_url}")
}

backup_database_contract_sql() {
  local installer="${PORTAL_DIR}/installer/install.sh"
  [[ -f "${installer}" && ! -L "${installer}" \
    && "$(stat -c '%u:%g' "${installer}" 2>/dev/null)" == "0:0" \
    && $((8#$(stat -c '%a' "${installer}") & 0022)) -eq 0 ]] || return 1
  BRIDGESLLM_INSTALLER_SOURCE_ONLY=1 /bin/bash -c \
    'source "$1"; update_database_ownership_violations_sql' \
    bridgesllm-backup-database-contract "${installer}"
}

backup_database_identity_sql() {
  if (( BACKUP_POSTGRESQL_CLIENT_MAJOR >= 15 )); then
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

write_bounded_backup_stream() {
  local target="$1"
  local maximum_bytes="$2"
  python3 /dev/fd/3 "${target}" "${maximum_bytes}" 3<<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
bound = int(sys.argv[2])
if (
    not path.is_absolute()
    or os.path.normpath(path) != str(path)
    or os.path.realpath(path.parent) != str(path.parent)
    or bound <= 0
    or bound > 2 * 1024**4
):
    raise SystemExit(1)
descriptor = None
initial = None
written = 0
try:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    initial = os.fstat(descriptor)
    if (
        not stat.S_ISREG(initial.st_mode)
        or initial.st_uid != 0
        or initial.st_gid != 0
        or initial.st_nlink != 1
        or stat.S_IMODE(initial.st_mode) != 0o600
        or initial.st_size != 0
    ):
        raise OSError("bounded backup stream target is unsafe")
    while True:
        chunk = sys.stdin.buffer.read(1024 * 1024)
        if not chunk:
            break
        if written + len(chunk) > bound:
            raise OSError("bounded backup stream exceeded its admitted bytes")
        view = memoryview(chunk)
        while view:
            count = os.write(descriptor, view)
            if count <= 0:
                raise OSError("bounded backup stream write was short")
            written += count
            view = view[count:]
    if written <= 0:
        raise OSError("bounded backup stream was empty")
    os.fsync(descriptor)
    settled = os.fstat(descriptor)
    named = os.lstat(path)
    if (
        (settled.st_dev, settled.st_ino)
            != (initial.st_dev, initial.st_ino)
        or (named.st_dev, named.st_ino)
            != (initial.st_dev, initial.st_ino)
        or settled.st_size != written
        or settled.st_nlink != 1
        or not stat.S_ISREG(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
    ):
        raise OSError("bounded backup stream target changed")
    parent = os.open(
        path.parent,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
except BaseException as original_error:
    cleanup_error = None
    if descriptor is not None:
        try:
            current = os.fstat(descriptor)
            named = os.lstat(path)
            if (
                initial is not None
                and (current.st_dev, current.st_ino)
                    == (initial.st_dev, initial.st_ino)
                and (named.st_dev, named.st_ino)
                    == (initial.st_dev, initial.st_ino)
                and stat.S_ISREG(named.st_mode)
                and not stat.S_ISLNK(named.st_mode)
            ):
                os.unlink(path)
        except FileNotFoundError:
            pass
        except OSError as error:
            cleanup_error = error
    if cleanup_error is not None:
        raise OSError(
            "bounded backup stream failed and exact-inode cleanup also failed"
        ) from original_error
    raise
finally:
    if descriptor is not None:
        os.close(descriptor)
print(written)
PY
}

dump_database_consistent() {
  local target="$1"
  local identity_target="$2"
  local database_url="" libpq_url="" runner_source=""
  local work_dir="" fifo="" output="" client_pid="" input_fd=""
  local marker="" snapshot="" logical_bytes="" relation_count=""
  local dump_bytes=""
  local contract="" violations="" contract_variant="" contract_extra=""
  local tablespace_violations="" identity_before="" identity_after=""
  local identity_marker=""
  local database_dump_bound=""
  local expected_parent="${BASHPID}"
  local status=0
  local guarded=false
  local authority
  authority="$(backup_database_authority_environment)" || return 1
  assert_backup_capacity_guard || return 1
  database_dump_bound="$(python3 - \
    "${BACKUP_CAPACITY_GUARD_PLAN}" <<'PY'
import json
import sys

plan = json.loads(sys.argv[1])
value = plan.get("databaseDumpBytes")
if (
    plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") != "create"
    or not isinstance(value, int)
    or isinstance(value, bool)
    or value <= 16 * 1024**2
    or value > 2 * 1024**4
):
    raise SystemExit(1)
print(value)
PY
  )" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  libpq_url="$(libpq_database_url "${database_url}")" || return 1
  runner_source="$(backup_pg_dump_runner_python)" || return 1
  [[ -x "${BACKUP_PSQL_BIN}" && "${BACKUP_PSQL_BIN}" == /* ]] || return 1
  assert_backup_database_exclusion || return 1
  guarded=true
  work_dir="$(mktemp -d "${STAGING_DIR}/.database-snapshot.XXXXXX")" || return 1
  chmod 700 "${work_dir}"
  fifo="${work_dir}/input"
  output="${work_dir}/output"
  mkfifo -m 600 "${fifo}" || { rmdir -- "${work_dir}"; return 1; }
  : > "${output}"
  chmod 600 "${output}"
  if [[ "${guarded}" == "true" ]]; then
    run_backup_guard_peer_psql \
      --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      < "${fifo}" > "${output}" 2>"${work_dir}/error" &
  else
    python3 -c "${runner_source}" "${expected_parent}" \
      "${BACKUP_PSQL_BIN}" "${libpq_url}" \
      "--dbname=${libpq_url}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      3< <(printf '%s' "${database_url}") \
      < "${fifo}" > "${output}" 2>"${work_dir}/error" &
  fi
  client_pid=$!
  exec {input_fd}> "${fifo}" || status=1
  if [[ "${status}" -eq 0 ]]; then
    if [[ "${guarded}" == "true" ]]; then
      backup_guard_peer_role_sql >&"${input_fd}" || status=1
    fi
    printf '%s\n' \
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
      "SELECT 'BRIDGESLLM_BACKUP_SNAPSHOT_V1';" \
      'SELECT pg_export_snapshot();' \
      'SELECT pg_database_size(current_database())::text;' \
      "SELECT count(*)::text FROM pg_catalog.pg_class WHERE relkind IN ('r','i','S','t','m');" \
      >&"${input_fd}" || status=1
    backup_database_identity_sql >&"${input_fd}" || status=1
    backup_database_contract_sql >&"${input_fd}" || status=1
    printf '%s\n' \
      "SET search_path TO pg_catalog;
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
)::text;" >&"${input_fd}" || status=1
  fi
  local attempt
  if [[ "${status}" -eq 0 ]]; then
    for attempt in {1..200}; do
      marker="$(sed -n '1p' "${output}" 2>/dev/null || true)"
      snapshot="$(sed -n '2p' "${output}" 2>/dev/null || true)"
      logical_bytes="$(sed -n '3p' "${output}" 2>/dev/null || true)"
      relation_count="$(sed -n '4p' "${output}" 2>/dev/null || true)"
      identity_before="$(sed -n '5p' "${output}" 2>/dev/null || true)"
      contract="$(sed -n '6p' "${output}" 2>/dev/null || true)"
      tablespace_violations="$(sed -n '7p' "${output}" 2>/dev/null || true)"
      [[ "${marker}" == "BRIDGESLLM_BACKUP_SNAPSHOT_V1" \
        && -n "${snapshot}" && -n "${logical_bytes}" \
        && -n "${relation_count}" && -n "${identity_before}" \
        && -n "${contract}" \
        && -n "${tablespace_violations}" ]] && break
      kill -0 "${client_pid}" 2>/dev/null || break
      sleep 0.05
    done
  fi
  IFS='|' read -r violations contract_variant contract_extra <<<"${contract}"
  [[ "${status}" -eq 0 \
    && "${marker}" == "BRIDGESLLM_BACKUP_SNAPSHOT_V1" \
    && "${snapshot}" =~ ^[A-Za-z0-9._:-]{1,256}$ \
    && "${logical_bytes}" =~ ^[1-9][0-9]*$ \
    && "${relation_count}" =~ ^[1-9][0-9]*$ \
    && "${relation_count}" -le 100000000 \
    && "${violations}" == "0" \
    && ( "${contract_variant}" == "owner-null" \
      || "${contract_variant}" == "pg-database-owner-default" ) \
    && -z "${contract_extra}" \
    && "${tablespace_violations}" == "0" ]] || status=1
  if [[ "${status}" -eq 0 ]]; then
    if ! python3 - "${logical_bytes}" "${database_dump_bound}" <<'PY'
import sys

logical = int(sys.argv[1])
bound = int(sys.argv[2])
if logical <= 0 or logical * 5 + 16 * 1024**2 > bound:
    raise SystemExit(1)
PY
    then
      status=1
    fi
  fi
  if [[ "${status}" -eq 0 ]]; then
    if [[ "${guarded}" == "true" ]]; then
      dump_bytes="$(
        run_archive_diagnostic_command "${target}.err" stderr \
          run_backup_guard_peer_pg_dump "${snapshot}" \
          | write_bounded_backup_stream "${target}" "${database_dump_bound}"
      )" || status=$?
    else
      dump_bytes="$(
        run_archive_diagnostic_command "${target}.err" stderr \
          run_backup_pg_dump "${database_url}" "${libpq_url}" "${snapshot}" \
          | write_bounded_backup_stream "${target}" "${database_dump_bound}"
      )" || status=$?
    fi
    [[ "${status}" -eq 0 && "${dump_bytes}" =~ ^[1-9][0-9]*$ \
      && "${dump_bytes}" -le "${database_dump_bound}" ]] || status=1
  fi
  if [[ "${status}" -eq 0 ]]; then
    if ! python3 - "${target}" "${database_dump_bound}" \
      "${dump_bytes}" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
bound = int(sys.argv[2])
expected = int(sys.argv[3])
info = os.lstat(path)
if (
    not stat.S_ISREG(info.st_mode)
    or stat.S_ISLNK(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
    or info.st_size <= 0
    or info.st_size > bound
    or info.st_size != expected
):
    raise SystemExit(1)
PY
    then
      status=1
    fi
  fi
  if [[ "${status}" -eq 0 ]]; then
    backup_database_identity_sql >&"${input_fd}" || status=1
    printf '%s\n' "SELECT 'BRIDGESLLM_BACKUP_IDENTITY_END_V1';" \
      >&"${input_fd}" || status=1
  fi
  if [[ "${status}" -eq 0 ]]; then
    for attempt in {1..200}; do
      identity_after="$(sed -n '8p' "${output}" 2>/dev/null || true)"
      identity_marker="$(sed -n '9p' "${output}" 2>/dev/null || true)"
      [[ -n "${identity_after}" \
        && "${identity_marker}" == "BRIDGESLLM_BACKUP_IDENTITY_END_V1" ]] \
        && break
      kill -0 "${client_pid}" 2>/dev/null || break
      sleep 0.05
    done
    [[ -n "${identity_after}" \
      && "${identity_marker}" == "BRIDGESLLM_BACKUP_IDENTITY_END_V1" ]] \
      || status=1
  fi
  if [[ -n "${input_fd}" ]]; then
    printf '%s\n' 'ROLLBACK;' '\q' >&"${input_fd}" 2>/dev/null || true
    eval "exec ${input_fd}>&-" || true
  fi
  wait "${client_pid}" 2>/dev/null || {
    [[ "${status}" -ne 0 ]] || status=1
  }
  rm -f -- "${target}.err" "${target}.err.pipe" \
    "${fifo}" "${output}" "${work_dir}/error"
  rmdir -- "${work_dir}" 2>/dev/null || status=1
  if [[ "${status}" -ne 0 || ! -s "${target}" ]]; then
    rm -f -- "${target}" "${identity_target}"
    return 1
  fi
  if ! python3 - "${identity_before}" "${identity_after}" \
      "${identity_target}" "${BACKUP_POSTGRESQL_CLIENT_MAJOR}" <<'PY'
import json
import os
import pathlib
import stat
import sys

before_raw, after_raw, target_raw, major_raw = sys.argv[1:]
before = json.loads(before_raw)
after = json.loads(after_raw)
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

def valid(document):
    provider = document.get("localeProvider")
    return (
        isinstance(document, dict)
        and set(document) == required
        and document.get("schema")
            == "bridgesllm.postgresql-database-identity.v1"
        and document.get("postgresMajor") == int(major_raw)
        and document.get("encoding") == "UTF8"
        and safe_text(document.get("lcCollate"), 256)
        and safe_text(document.get("lcCtype"), 256)
        and provider in {"libc", "icu", "builtin"}
        and (
            (provider == "libc" and document.get("providerLocale") is None)
            or (
                provider in {"icu", "builtin"}
                and safe_text(document.get("providerLocale"), 1024)
            )
        )
        and (
            document.get("icuRules") is None
            or (
                provider == "icu"
                and safe_text(document.get("icuRules"), 4096)
            )
        )
        and (
            document.get("collationVersion") is None
            or safe_text(document.get("collationVersion"), 256)
        )
        and (
            document.get("collationActualVersion") is None
            or safe_text(document.get("collationActualVersion"), 256)
        )
        and document.get("collationVersion")
            == document.get("collationActualVersion")
    )

if not valid(before) or not valid(after) or before != after:
    raise SystemExit(1)
target = pathlib.Path(target_raw)
payload = (
    json.dumps(before, sort_keys=True, separators=(",", ":")) + "\n"
).encode("utf-8")
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
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  then
    rm -f -- "${target}" "${identity_target}"
    return 1
  fi
  if [[ "${guarded}" == "true" ]]; then
    assert_backup_database_exclusion || {
      rm -f -- "${target}" "${identity_target}"
      return 1
    }
  fi
  printf '%s|%s|%s\n' \
    "${logical_bytes}" "${relation_count}" "${contract_variant}"
}

database_dump_admission_bytes() {
  local database_url="" libpq_url="" psql_path="" runner_source="" result=""
  local authority
  authority="$(backup_database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  libpq_url="$(libpq_database_url "${database_url}")" || return 1
  psql_path="${BACKUP_PSQL_BIN}"
  [[ -x "${psql_path}" && "${psql_path}" == /* ]] || return 1
  runner_source="$(backup_pg_dump_runner_python)" || return 1
  result="$(
    runner_parent="${BASHPID}"
    python3 -c "${runner_source}" "${runner_parent}" \
      "${psql_path}" "${libpq_url}" \
      "--dbname=${libpq_url}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      "--command=SELECT pg_database_size(current_database())::text;" \
      3< <(printf '%s' "${database_url}")
  )" || return 1
  result="$(tr -d '\r\n' <<<"${result}")"
  [[ "${result}" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "${result}"
}

database_relation_admission_count() {
  local database_url="" libpq_url="" psql_path="" runner_source="" result=""
  local authority
  authority="$(backup_database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  libpq_url="$(libpq_database_url "${database_url}")" || return 1
  psql_path="${BACKUP_PSQL_BIN}"
  [[ -x "${psql_path}" && "${psql_path}" == /* ]] || return 1
  runner_source="$(backup_pg_dump_runner_python)" || return 1
  result="$(
    runner_parent="${BASHPID}"
    python3 -c "${runner_source}" "${runner_parent}" \
      "${psql_path}" "${libpq_url}" \
      "--dbname=${libpq_url}" --no-psqlrc --set=ON_ERROR_STOP=1 -qAt \
      "--command=SET search_path TO pg_catalog; SELECT count(*)::text FROM pg_class WHERE relkind IN ('r','i','S','t','m');" \
      3< <(printf '%s' "${database_url}")
  )" || return 1
  result="$(tr -d '\r\n' <<<"${result}")"
  [[ "${result}" =~ ^[1-9][0-9]*$ && "${result}" -le 100000000 ]] || return 1
  printf '%s\n' "${result}"
}

materialize_archive_source_inventory() {
  local source_dir="$1"
  local list_file="$2"
  local digest_file="$3"
  local records_file="$4"
  shift 4
  python3 - "$source_dir" "$list_file" "$digest_file" "$records_file" \
    "${ARCHIVE_EVIDENCE_MAX_BYTES:-1073741824}" \
    "${ARCHIVE_XATTR_MAX_BYTES:-16777216}" "$@" <<'PY'
import fcntl
import fnmatch
import hashlib
import json
import errno
import os
import pathlib
import posixpath
import re
import stat
import struct
import sys
import time

source = pathlib.Path(sys.argv[1])
list_path = pathlib.Path(sys.argv[2])
digest_path = pathlib.Path(sys.argv[3])
records_path = pathlib.Path(sys.argv[4])
evidence_max_bytes = int(sys.argv[5])
xattr_max_bytes = int(sys.argv[6])
raw_options = sys.argv[7:]
if evidence_max_bytes != 1024 * 1024 * 1024:
    raise SystemExit("archive evidence bound is invalid")
if xattr_max_bytes != 16 * 1024 * 1024:
    raise SystemExit("archive xattr bound is invalid")
patterns = []
allow_external_hardlinks = False
allow_project_interpreter_symlinks = False
allowed_absolute_symlink_roots = []
overlay_root_raw = None
overlay_relatives = []
reconcile_omit_relatives = []
live_unstable_raw = None
live_inventory_attempts = 1
live_inventory_max_unstable = 0
for option in raw_options:
    if option.startswith("--live-unstable-file="):
        if live_unstable_raw is not None or len(option) <= len("--live-unstable-file="):
            raise SystemExit("duplicate or empty live inventory evidence path")
        live_unstable_raw = option.removeprefix("--live-unstable-file=")
        continue
    if option.startswith("--live-inventory-attempts="):
        raw_value = option.removeprefix("--live-inventory-attempts=")
        if not raw_value.isdigit():
            raise SystemExit("invalid live inventory attempt bound")
        live_inventory_attempts = int(raw_value)
        continue
    if option.startswith("--live-inventory-max-unstable="):
        raw_value = option.removeprefix("--live-inventory-max-unstable=")
        if not raw_value.isdigit():
            raise SystemExit("invalid live inventory instability bound")
        live_inventory_max_unstable = int(raw_value)
        continue
    if option == "--allow-external-hardlinks":
        allow_external_hardlinks = True
        continue
    if option == "--allow-project-interpreter-symlinks":
        if allow_project_interpreter_symlinks:
            raise SystemExit("duplicate Project interpreter symbolic-link policy")
        allow_project_interpreter_symlinks = True
        continue
    if option.startswith("--overlay-root="):
        if overlay_root_raw is not None or len(option) <= len("--overlay-root="):
            raise SystemExit("duplicate or empty recovery archive overlay root")
        overlay_root_raw = option.removeprefix("--overlay-root=")
        continue
    if option.startswith("--overlay-relative="):
        if len(option) <= len("--overlay-relative="):
            raise SystemExit("empty recovery archive overlay path")
        overlay_relatives.append(option.removeprefix("--overlay-relative="))
        continue
    if option.startswith("--reconcile-omit-relative="):
        if len(option) <= len("--reconcile-omit-relative="):
            raise SystemExit("empty live reconciliation omission path")
        reconcile_omit_relatives.append(
            option.removeprefix("--reconcile-omit-relative=")
        )
        continue
    if option.startswith("--allow-absolute-symlink-root="):
        raw_root = option.removeprefix("--allow-absolute-symlink-root=")
        if (
            not raw_root
            or not raw_root.startswith("/")
            or os.path.normpath(raw_root) != raw_root
            or len(raw_root.encode("utf-8")) >= 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in raw_root)
            or raw_root in allowed_absolute_symlink_roots
        ):
            raise SystemExit("invalid allowed recovery symbolic-link root")
        allowed_absolute_symlink_roots.append(raw_root)
        continue
    if (
        not option.startswith("--exclude=")
        or len(option) <= len("--exclude=")
        or "\0" in option
        or "\n" in option
    ):
        raise SystemExit("unsupported recovery archive selection option")
    patterns.append(option.removeprefix("--exclude="))

live_inventory = live_unstable_raw is not None
if live_inventory:
    live_unstable_path = pathlib.Path(live_unstable_raw)
    if (
        not live_unstable_path.is_absolute()
        or os.path.normpath(live_unstable_path) != str(live_unstable_path)
        or os.path.lexists(live_unstable_path)
        or live_inventory_attempts < 1
        or live_inventory_attempts > 3
        or live_inventory_max_unstable < 1
        or live_inventory_max_unstable > 512
    ):
        raise SystemExit("live inventory evidence authority is invalid")
elif live_inventory_attempts != 1 or live_inventory_max_unstable != 0:
    raise SystemExit("live inventory bounds lack an evidence path")

if (overlay_root_raw is None) != (not overlay_relatives):
    raise SystemExit("recovery archive overlay is incomplete")

if (
    not source.is_absolute()
    or os.path.normpath(source) != str(source)
    or os.path.realpath(source) != str(source)
):
    raise SystemExit("recovery source is not a canonical directory")
if (
    not all(hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_PATH"))
    or not pathlib.Path("/proc/self/fd").is_dir()
):
    raise SystemExit("descriptor-authoritative recovery primitives are unavailable")
directory_open_flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
)

def open_absolute_directory(path):
    descriptor = os.open("/", directory_open_flags)
    try:
        for component in path.parts[1:]:
            next_descriptor = os.open(
                component,
                directory_open_flags,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

root_descriptor = open_absolute_directory(source)
try:
    descriptor_scan = os.scandir(root_descriptor)
    descriptor_scan.close()
    os.stat(f"/proc/self/fd/{root_descriptor}")
except (OSError, TypeError):
    os.close(root_descriptor)
    raise SystemExit("descriptor-authoritative recovery traversal is unavailable")
root_info = os.fstat(root_descriptor)
if (
    not stat.S_ISDIR(root_info.st_mode)
    or root_info.st_uid != 0
    or root_info.st_gid != 0
    or root_info.st_mode & 0o022
):
    raise SystemExit("recovery source root is not root-owned and write-safe")

def unescape_mount(value):
    return (
        value.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
    )

try:
    mount_lines = pathlib.Path("/proc/self/mountinfo").read_text(
        encoding="utf-8"
    ).splitlines()
except OSError:
    raise SystemExit("recovery source mount topology is unavailable")
root_text = str(source)
for line in mount_lines:
    fields = line.split()
    if len(fields) < 5:
        raise SystemExit("recovery source mount topology is malformed")
    mountpoint = os.path.normpath(unescape_mount(fields[4]))
    if mountpoint == root_text or mountpoint.startswith(root_text + os.sep):
        raise SystemExit("recovery source contains a mount boundary")

def valid_text(value, maximum):
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if (
        not encoded
        or len(encoded) >= maximum
        or any(byte < 32 or byte == 127 for byte in encoded)
    ):
        return None
    return encoded

def excluded_by_pattern(relative):
    if not relative:
        return False
    parts = relative.split("/")
    for pattern in patterns:
        if "/" not in pattern:
            if any(fnmatch.fnmatchcase(part, pattern) for part in parts):
                return True
            continue
        for index in range(len(parts)):
            if fnmatch.fnmatchcase("/".join(parts[index:]), pattern):
                return True
    return False

def normalized_relative(raw, *, allow_root):
    if raw == "." and allow_root:
        return ""
    relative_path = pathlib.PurePosixPath(raw)
    relative_parts = relative_path.parts
    if (
        not relative_parts
        or relative_path.is_absolute()
        or str(relative_path) != raw
        or any(part in {"", ".", ".."} for part in relative_parts)
        or "\\" in raw
        or valid_text(raw, 4096) is None
    ):
        raise SystemExit("recovery archive member authority is invalid")
    return raw

normalized_overlay_relatives = [
    normalized_relative(value, allow_root=True) for value in overlay_relatives
]
normalized_omit_relatives = [
    normalized_relative(value, allow_root=False)
    for value in reconcile_omit_relatives
]
if (
    len(normalized_overlay_relatives) != len(set(normalized_overlay_relatives))
    or len(normalized_omit_relatives) != len(set(normalized_omit_relatives))
    or set(normalized_overlay_relatives) & set(normalized_omit_relatives)
    or len(normalized_overlay_relatives) + len(normalized_omit_relatives) > 4096
):
    raise SystemExit("live reconciliation member authority is invalid")
exact_overlay_relatives = set(normalized_overlay_relatives)
exact_omit_relatives = set(normalized_omit_relatives)

overlay_root = None
overlay_relatives_to_inspect = []
overlay_root_info = None
overlay_root_descriptor = None
if overlay_root_raw is not None:
    overlay_root = pathlib.Path(overlay_root_raw)
    if (
        not overlay_root.is_absolute()
        or os.path.normpath(overlay_root) != str(overlay_root)
        or os.path.realpath(overlay_root) != str(overlay_root)
        or str(overlay_root) == str(source)
        or str(overlay_root).startswith(str(source) + os.sep)
        or str(source).startswith(str(overlay_root) + os.sep)
        or overlay_root.name != source.name
        or len(normalized_overlay_relatives) > 4096
    ):
        raise SystemExit("recovery archive overlay authority is invalid")
    overlay_root_descriptor = open_absolute_directory(overlay_root)
    overlay_root_info = os.fstat(overlay_root_descriptor)
    if (
        not stat.S_ISDIR(overlay_root_info.st_mode)
        or overlay_root_info.st_uid != 0
        or overlay_root_info.st_gid != 0
        or overlay_root_info.st_mode & 0o022
    ):
        raise SystemExit("recovery archive overlay root is not trusted")
    overlay_relatives_to_inspect.extend(normalized_overlay_relatives)

FS_IOC_GETFLAGS = (
    (2 << 30)
    | (struct.calcsize("@L") << 16)
    | (ord("f") << 8)
    | 1
)
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020

def assert_archiveable_inode_flags(descriptor, info):
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != info.st_dev
            or opened.st_ino != info.st_ino
            or stat.S_IFMT(opened.st_mode) != stat.S_IFMT(info.st_mode)
        ):
            raise MemberChanged(
                "recovery source changed during inode flag inspection"
            )
        encoded = bytearray(struct.calcsize("@L"))
        try:
            fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, encoded, True)
        except OSError:
            raise SystemExit("recovery source inode flags could not be inspected")
        inode_flags = struct.unpack("@L", encoded)[0]
    except OSError:
        raise SystemExit("recovery source inode flags could not be inspected")
    if inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        raise SystemExit(
            "recovery source contains an immutable or append-only inode"
        )

def sparse_map(descriptor, info):
    if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
        return ()
    if not hasattr(os, "SEEK_DATA") or not hasattr(os, "SEEK_HOLE"):
        return (("unknown", info.st_blocks),)
    probe = os.dup(descriptor)
    extents = []
    try:
        offset = 0
        while offset < info.st_size:
            try:
                data = os.lseek(probe, offset, os.SEEK_DATA)
            except OSError as error:
                if error.errno == 6:  # ENXIO: no more data.
                    break
                if error.errno in {22, 95}:  # EINVAL/EOPNOTSUPP.
                    return (("unknown", info.st_blocks),)
                raise
            hole = os.lseek(probe, data, os.SEEK_HOLE)
            if hole < data or hole > info.st_size:
                raise SystemExit("recovery source sparse map is invalid")
            extents.append((data, hole - data))
            offset = hole
    finally:
        os.close(probe)
    return tuple(extents)

digest = hashlib.sha256()
contract_digest = hashlib.sha256()
members = []
hardlinks = {}
records = []

def add_field(value):
    if isinstance(value, str):
        encoded = value.encode("utf-8")
    elif isinstance(value, bytes):
        encoded = value
    else:
        encoded = str(value).encode("ascii")
    digest.update(struct.pack(">Q", len(encoded)))
    digest.update(encoded)

def add_contract_field(value):
    if isinstance(value, str):
        encoded = value.encode("utf-8")
    elif isinstance(value, bytes):
        encoded = value
    else:
        encoded = str(value).encode("ascii")
    contract_digest.update(struct.pack(">Q", len(encoded)))
    contract_digest.update(encoded)

def stable_stat(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_nlink,
        info.st_uid,
        info.st_gid,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
        info.st_blocks,
    )

def inode_identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))

def bounded_xattrs_from_fd(descriptor):
    try:
        names = os.listxattr(descriptor)
    except OSError:
        raise SystemExit("recovery source xattrs could not be inspected")
    encoded_names = sorted(
        name if isinstance(name, bytes)
        else name.encode("utf-8", "surrogateescape")
        for name in names
    )
    if len(encoded_names) > 1024 or len(encoded_names) != len(set(encoded_names)):
        raise SystemExit("recovery source xattr inventory is invalid")
    total = 0
    result = []
    for name in encoded_names:
        if not name or len(name) > 255 or b"\0" in name or b"." not in name:
            raise SystemExit("recovery source xattr name is unsafe")
        value = os.getxattr(descriptor, name)
        total += len(name) + len(value)
        if len(value) > 1024 * 1024 or total > 16 * 1024 * 1024:
            raise SystemExit("recovery source xattr inventory is unbounded")
        result.append((name, value))
    return tuple(result)

def bounded_symlink_state(parent_descriptor, leaf_name, descriptor):
    # Linux does not offer an fgetxattr equivalent for an O_PATH descriptor
    # referring to a symbolic link.  Pin the parent and link inode, and bind
    # the one unavoidable l* operation to an unchanged parent ctime.  Every
    # rename/substitution needed for an ABA changes that ctime irreversibly.
    parent_before = os.fstat(parent_descriptor)
    link_before = os.fstat(descriptor)
    proc_path = f"/proc/self/fd/{parent_descriptor}/{leaf_name}"
    try:
        target = os.readlink(leaf_name, dir_fd=parent_descriptor)
        names = os.listxattr(proc_path, follow_symlinks=False)
        encoded_names = sorted(
            name if isinstance(name, bytes)
            else name.encode("utf-8", "surrogateescape")
            for name in names
        )
        if (
            len(encoded_names) > 1024
            or len(encoded_names) != len(set(encoded_names))
        ):
            raise SystemExit("recovery source xattr inventory is invalid")
        total = 0
        result = []
        for name in encoded_names:
            if not name or len(name) > 255 or b"\0" in name or b"." not in name:
                raise SystemExit("recovery source xattr name is unsafe")
            value = os.getxattr(proc_path, name, follow_symlinks=False)
            total += len(name) + len(value)
            if len(value) > 1024 * 1024 or total > 16 * 1024 * 1024:
                raise SystemExit("recovery source xattr inventory is unbounded")
            result.append((name, value))
        path_after = os.stat(
            leaf_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        raise SystemExit("recovery source symbolic link could not be inspected")
    if (
        inode_identity(link_before) != inode_identity(path_after)
        or stable_stat(link_before) != stable_stat(os.fstat(descriptor))
        or stable_stat(parent_before) != stable_stat(os.fstat(parent_descriptor))
    ):
        raise MemberChanged(
            "recovery source changed during symbolic-link inspection"
        )
    return target, tuple(result)

inventory_member_hook_used = False

def inventory_member_test_pause(relative, bytes_read, source_size, origin):
    global inventory_member_hook_used
    phase = os.environ.get("BRIDGESLLM_BACKUP_INVENTORY_TEST_PHASE", "")
    if not phase or inventory_member_hook_used or origin != "source":
        return
    if phase != "source-content-read":
        raise MemberChanged("inventory member test phase is invalid")
    expected_source = os.environ.get(
        "BRIDGESLLM_BACKUP_INVENTORY_TEST_SOURCE_ROOT", ""
    )
    expected_relative = os.environ.get(
        "BRIDGESLLM_BACKUP_INVENTORY_TEST_HOOK_PATH", ""
    )
    if expected_source != str(source) or expected_relative != relative:
        return
    test_root = pathlib.Path(
        os.environ.get("BRIDGESLLM_BACKUP_TEST_ROOT", "")
    )
    hook = pathlib.Path(
        os.environ.get(
            "BRIDGESLLM_BACKUP_RECONCILIATION_TEST_HOOK_DIR", ""
        )
    )
    for path in (test_root, hook):
        try:
            info = os.lstat(path)
        except OSError as error:
            raise MemberChanged(
                "inventory member test authority is unavailable"
            ) from error
        if (
            not path.is_absolute()
            or os.path.realpath(path) != str(path)
            or not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise MemberChanged("inventory member test authority is unsafe")
    if (
        hook == test_root
        or not str(hook).startswith(str(test_root) + os.sep)
        or source == test_root
        or not str(source).startswith(str(test_root) + os.sep)
        or bytes_read <= 0
        or bytes_read >= source_size
    ):
        raise MemberChanged("inventory member test authority is invalid")
    ready = hook / "inventory-member-ready.json"
    release = hook / "inventory-member-release"
    if os.path.lexists(ready) or os.path.lexists(release):
        try:
            ready_info = os.lstat(ready)
            release_info = os.lstat(release)
            if (
                not stat.S_ISREG(ready_info.st_mode)
                or stat.S_ISLNK(ready_info.st_mode)
                or ready_info.st_uid != 0
                or ready_info.st_gid != 0
                or stat.S_IMODE(ready_info.st_mode) != 0o600
                or ready_info.st_nlink != 1
                or ready_info.st_size > 4096
                or not stat.S_ISREG(release_info.st_mode)
                or stat.S_ISLNK(release_info.st_mode)
                or release_info.st_uid != 0
                or release_info.st_gid != 0
                or release_info.st_mode & 0o022
            ):
                raise MemberChanged(
                    "inventory member test evidence is unsafe"
                )
            ready_descriptor = os.open(
                ready,
                os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
            )
            try:
                raw_ready = os.read(ready_descriptor, 4097)
                if os.read(ready_descriptor, 1):
                    raise MemberChanged(
                        "inventory member test evidence is unbounded"
                    )
            finally:
                os.close(ready_descriptor)
            document = json.loads(raw_ready.decode("utf-8"))
        except (
            OSError,
            UnicodeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            if isinstance(error, MemberChanged):
                raise
            raise MemberChanged(
                "inventory member test evidence is invalid"
            ) from error
        if (
            not isinstance(document, dict)
            or set(document) != {
                "schema", "phase", "sourceRoot", "relative", "pid",
                "namespacePid", "startTimeTicks", "bytesRead", "sourceSize",
            }
            or document.get("schema")
                != "bridgesllm.inventory-member-test.v1"
            or document.get("phase") != phase
            or document.get("sourceRoot") != str(source)
            or document.get("relative") != relative
            or any(
                not isinstance(document.get(key), int)
                or isinstance(document.get(key), bool)
                or document[key] <= 0
                for key in (
                    "pid", "namespacePid", "startTimeTicks", "bytesRead",
                    "sourceSize"
                )
            )
            or document["bytesRead"] >= document["sourceSize"]
        ):
            raise MemberChanged("inventory member test evidence is invalid")
        inventory_member_hook_used = True
        return
    try:
        process_stat = pathlib.Path("/proc/self/stat").read_text(
            encoding="ascii"
        )
        process_status = pathlib.Path("/proc/self/status").read_text(
            encoding="ascii"
        ).splitlines()
        start_time_ticks = int(
            process_stat.rsplit(")", 1)[1].split()[19]
        )
        host_pids = [
            line.partition(":")[2].strip()
            for line in process_status if line.startswith("Pid:")
        ]
        if len(host_pids) != 1 or not host_pids[0].isdigit():
            raise ValueError("host PID is unavailable")
        host_pid = int(host_pids[0])
    except (OSError, UnicodeError, ValueError, IndexError) as error:
        raise MemberChanged(
            "inventory member test process identity is unavailable"
        ) from error
    payload = (
        json.dumps(
            {
                "schema": "bridgesllm.inventory-member-test.v1",
                "phase": phase,
                "sourceRoot": str(source),
                "relative": relative,
                "pid": host_pid,
                "namespacePid": os.getpid(),
                "startTimeTicks": start_time_ticks,
                "bytesRead": bytes_read,
                "sourceSize": source_size,
            },
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
    ).encode("utf-8")
    inventory_member_hook_used = True
    try:
        ready_descriptor = os.open(
            ready,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
            0o600,
        )
        try:
            view = memoryview(payload)
            while view:
                written = os.write(ready_descriptor, view)
                if written <= 0:
                    raise OSError("inventory member attestation write was short")
                view = view[written:]
            os.fsync(ready_descriptor)
        finally:
            os.close(ready_descriptor)
        for _ in range(1000):
            try:
                release_info = os.lstat(release)
            except FileNotFoundError:
                time.sleep(0.005)
                continue
            if (
                stat.S_ISREG(release_info.st_mode)
                and not stat.S_ISLNK(release_info.st_mode)
                and release_info.st_uid == 0
                and release_info.st_gid == 0
                and not release_info.st_mode & 0o022
            ):
                return
            raise MemberChanged("inventory member test release is unsafe")
    except OSError as error:
        raise MemberChanged("inventory member test hook failed") from error
    raise MemberChanged("inventory member test hook timed out")

def file_content_sha256(descriptor, size, relative, origin):
    fingerprint = hashlib.sha256()
    offset = 0
    while offset < size:
        payload = os.pread(descriptor, min(1024 * 1024, size - offset), offset)
        if not payload:
            raise MemberChanged("recovery source file ended during content inventory")
        fingerprint.update(payload)
        offset += len(payload)
        inventory_member_test_pause(relative, offset, size, origin)
    return fingerprint.hexdigest()

class MemberChanged(RuntimeError):
    pass

class DirectoryChanged(MemberChanged):
    pass

unstable_members = set()

def mark_unstable(relative):
    unstable_members.add(relative)
    if len(unstable_members) > live_inventory_max_unstable:
        raise SystemExit("live inventory instability bound was exceeded")

def inspect_entry_once(
    parent_descriptor,
    leaf_name,
    relative,
    *,
    supplied_descriptor=None,
    apply_exclusions=True,
    expected_device=None,
    origin="source",
    recurse=True,
):
    if apply_exclusions and (
        excluded_by_pattern(relative) or relative in exact_omit_relatives
    ):
        return
    overlay_replaces_member = (
        apply_exclusions and relative in exact_overlay_relatives
    )
    relative_bytes = valid_text(relative or source.name, 4096)
    if relative_bytes is None or any(
        valid_text(part, 256) is None
        for part in (relative.split("/") if relative else [source.name])
    ):
        raise SystemExit("recovery source contains an unsafe path")
    descriptor = supplied_descriptor
    parent_before = None
    try:
        if descriptor is None:
            if parent_descriptor is None or not leaf_name:
                raise SystemExit("recovery source descriptor authority is invalid")
            parent_before = os.fstat(parent_descriptor)
            path_descriptor = os.open(
                leaf_name,
                os.O_PATH | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent_descriptor,
            )
            path_info = os.fstat(path_descriptor)
            if stat.S_ISDIR(path_info.st_mode):
                open_flags = directory_open_flags
            elif stat.S_ISREG(path_info.st_mode):
                open_flags = (
                    os.O_RDONLY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_NOFOLLOW", 0)
                    | getattr(os, "O_NOATIME", 0)
                )
            elif stat.S_ISLNK(path_info.st_mode):
                open_flags = None
            else:
                os.close(path_descriptor)
                raise SystemExit("recovery source contains a socket, FIFO, or device")
            if open_flags is None:
                descriptor = path_descriptor
            else:
                descriptor = os.open(
                    leaf_name,
                    open_flags,
                    dir_fd=parent_descriptor,
                )
                info = os.fstat(descriptor)
                os.close(path_descriptor)
                if inode_identity(info) != inode_identity(path_info):
                    raise MemberChanged(
                        "recovery source changed during descriptor admission"
                    )
        info = os.fstat(descriptor)
        admitted_device = root_info.st_dev if expected_device is None else expected_device
        if info.st_dev != admitted_device:
            raise SystemExit("recovery source crossed a filesystem boundary")
        if stat.S_ISDIR(info.st_mode):
            kind = "directory"
        elif stat.S_ISREG(info.st_mode):
            kind = "file"
        elif stat.S_ISLNK(info.st_mode):
            kind = "symlink"
            if info.st_nlink != 1:
                raise SystemExit("recovery source contains a multiply-linked symlink")
        else:
            raise SystemExit("recovery source contains a socket, FIFO, or device")
        if kind in {"directory", "file"}:
            assert_archiveable_inode_flags(descriptor, info)

        if kind == "symlink":
            if parent_descriptor is None or not leaf_name:
                raise SystemExit("recovery source root cannot be a symbolic link")
            target, xattrs = bounded_symlink_state(
                parent_descriptor,
                leaf_name,
                descriptor,
            )
        else:
            target = ""
            xattrs = bounded_xattrs_from_fd(descriptor)
        before_stat = stable_stat(info)
        extents = sparse_map(descriptor, info)
        content_sha256 = (
            file_content_sha256(descriptor, info.st_size, relative, origin)
            if kind == "file"
            else hashlib.sha256(b"").hexdigest()
        )

        if overlay_replaces_member:
            if kind == "directory":
                try:
                    child_names = sorted(os.listdir(descriptor), key=os.fsencode)
                except OSError:
                    raise SystemExit("recovery source directory could not be enumerated")
                for child_name in child_names:
                    child_relative = (
                        child_name if not relative else relative + "/" + child_name
                    )
                    inspect_entry(
                        descriptor,
                        child_name,
                        child_relative,
                        apply_exclusions=apply_exclusions,
                        expected_device=expected_device,
                        origin=origin,
                    )
            if (
                stable_stat(os.fstat(descriptor)) != before_stat
                or (kind != "symlink" and bounded_xattrs_from_fd(descriptor) != xattrs)
            ):
                raise DirectoryChanged(
                    "recovery source changed during descriptor traversal"
                )
            return

        archive_name = source.name + ("/" + relative if relative else "")
        members.append(archive_name)
        add_field(archive_name)
        add_field(kind)
        for value in (
            info.st_dev,
            info.st_ino,
            info.st_nlink,
            info.st_uid,
            info.st_gid,
            stat.S_IMODE(info.st_mode),
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        ):
            add_field(value)
        if kind == "symlink":
            target_bytes = valid_text(target, 4096)
            if target_bytes is None:
                raise SystemExit("recovery source contains an unsafe symbolic link")
            if target.startswith("/"):
                resolved_target = posixpath.normpath(target)
                admitted_roots = [str(source), *allowed_absolute_symlink_roots]
                admitted_interpreter = (
                    allow_project_interpreter_symlinks
                    and re.fullmatch(
                        r"/(?:usr/bin|usr/local/bin)/python3(?:\.[0-9]+)?",
                        resolved_target,
                    ) is not None
                )
                if not admitted_interpreter and not any(
                    resolved_target == root
                    or resolved_target.startswith(root + "/")
                    for root in admitted_roots
                ):
                    raise SystemExit(
                        "recovery source symbolic link escapes its admitted roots"
                    )
            else:
                resolved_target = posixpath.normpath(
                    posixpath.join(posixpath.dirname(archive_name), target)
                )
                if (
                    resolved_target in {"", ".", ".."}
                    or resolved_target.startswith("../")
                    or resolved_target.split("/", 1)[0] != source.name
                ):
                    raise SystemExit(
                        "recovery source symbolic link escapes its component"
                    )
            add_field(target_bytes)
        else:
            target_bytes = b""
            add_field(b"")

        for name, value in xattrs:
            add_field(name)
            add_field(value)
        add_field("xattr-end")
        for extent in extents:
            add_field(extent[0])
            add_field(extent[1])
        add_field("sparse-end")
        add_field(content_sha256)
        xattr_fingerprint = hashlib.sha256()
        for name, value in xattrs:
            for field in (name, value):
                xattr_fingerprint.update(struct.pack(">Q", len(field)))
                xattr_fingerprint.update(field)
        sparse_fingerprint = hashlib.sha256()
        for extent in extents:
            for field in extent:
                encoded = str(field).encode("ascii")
                sparse_fingerprint.update(struct.pack(">Q", len(encoded)))
                sparse_fingerprint.update(encoded)
        header = os.pread(descriptor, 16, 0) if kind == "file" else b""
        sqlite_header = (
            kind == "file"
            and origin == "source"
            and (
                header == b"SQLite format 3\0"
                or (leaf_name or "").lower().endswith((".sqlite", ".sqlite3"))
            )
        )
        records.append({
        "name": archive_name,
        "relative": relative,
        "origin": origin,
        "kind": kind,
        "identity": (info.st_dev, info.st_ino),
        "device": info.st_dev,
        "inode": info.st_ino,
        "links": info.st_nlink,
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mode": stat.S_IMODE(info.st_mode),
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "ctimeNs": info.st_ctime_ns,
        "link": target_bytes,
        "linkText": target_bytes.decode("utf-8") if target_bytes else "",
        "xattrs": tuple(xattrs),
        "xattrSha256": xattr_fingerprint.hexdigest(),
            "sparseSha256": sparse_fingerprint.hexdigest(),
            "contentSha256": content_sha256,
            "sqliteHeader": sqlite_header,
        "extents": extents,
        "sparse": (
            kind == "file"
            and info.st_size > 0
            and info.st_blocks * 512 < info.st_size
        ),
        })
        if kind == "file":
            hardlinks.setdefault((info.st_dev, info.st_ino), []).append(
                (archive_name, info.st_nlink)
            )
        if kind == "directory" and recurse:
            try:
                child_names = sorted(os.listdir(descriptor), key=os.fsencode)
            except OSError:
                raise SystemExit("recovery source directory could not be enumerated")
            for child_name in child_names:
                child_relative = (
                    child_name if not relative else relative + "/" + child_name
                )
                inspect_entry(
                    descriptor,
                    child_name,
                    child_relative,
                    apply_exclusions=apply_exclusions,
                    expected_device=expected_device,
                    origin=origin,
                    recurse=recurse,
                )
        if (
            stable_stat(os.fstat(descriptor)) != before_stat
            or (kind != "symlink" and bounded_xattrs_from_fd(descriptor) != xattrs)
            or (kind == "file" and sparse_map(descriptor, os.fstat(descriptor)) != extents)
        ):
            exception = DirectoryChanged if kind == "directory" else MemberChanged
            raise exception("recovery source changed during descriptor traversal")
        if parent_before is not None and stable_stat(parent_before) != stable_stat(
            os.fstat(parent_descriptor)
        ):
            exception = DirectoryChanged if kind == "directory" else MemberChanged
            raise exception("recovery source ancestry changed during traversal")
    finally:
        if descriptor is not None:
            os.close(descriptor)

def inspect_entry(
    parent_descriptor,
    leaf_name,
    relative,
    *,
    supplied_descriptor=None,
    apply_exclusions=True,
    expected_device=None,
    origin="source",
    recurse=True,
):
    if not live_inventory or origin != "source":
        return inspect_entry_once(
            parent_descriptor,
            leaf_name,
            relative,
            supplied_descriptor=supplied_descriptor,
            apply_exclusions=apply_exclusions,
            expected_device=expected_device,
            origin=origin,
            recurse=recurse,
        )

    held_supplied = supplied_descriptor
    try:
        for attempt in range(1, live_inventory_attempts + 1):
            member_start = len(members)
            record_start = len(records)
            attempt_descriptor = (
                os.dup(held_supplied) if held_supplied is not None else None
            )
            try:
                return inspect_entry_once(
                    parent_descriptor,
                    leaf_name,
                    relative,
                    supplied_descriptor=attempt_descriptor,
                    apply_exclusions=apply_exclusions,
                    expected_device=expected_device,
                    origin=origin,
                    recurse=recurse,
                )
            except DirectoryChanged:
                # Children were already walked through the pinned directory
                # descriptor.  Mark only the directory unstable; replaying its
                # subtree would turn a member retry into a whole-tree retry.
                mark_unstable(relative)
                return
            except MemberChanged:
                # A later retry may obtain a stable record, but the observed
                # churn itself is part of the live reconciliation authority.
                # Preserve that evidence instead of silently normalizing A
                # to the post-mutation state.
                mark_unstable(relative)
                provisional = next(
                    (
                        dict(record)
                        for record in records[record_start:]
                        if record.get("origin") == origin
                        and record.get("relative") == relative
                    ),
                    None,
                )
            except OSError as error:
                if error.errno not in {errno.ENOENT, errno.ESTALE}:
                    raise
                mark_unstable(relative)
                provisional = None
            del members[member_start:]
            del records[record_start:]
            if attempt < live_inventory_attempts:
                continue
            mark_unstable(relative)
            if provisional is not None:
                members.append(provisional["name"])
                records.append(provisional)
            return
    finally:
        if held_supplied is not None:
            os.close(held_supplied)

inspect_entry(
    None,
    None,
    "",
    supplied_descriptor=os.dup(root_descriptor),
)
for overlay_relative in overlay_relatives_to_inspect:
    parts = overlay_relative.split("/") if overlay_relative else []
    if not parts:
        inspect_entry(
            None,
            None,
            overlay_relative,
            supplied_descriptor=os.dup(overlay_root_descriptor),
            apply_exclusions=False,
            expected_device=overlay_root_info.st_dev,
            origin="overlay",
            recurse=False,
        )
        continue
    overlay_parent = os.dup(overlay_root_descriptor)
    try:
        for part in parts[:-1]:
            next_descriptor = os.open(part, directory_open_flags, dir_fd=overlay_parent)
            info = os.fstat(next_descriptor)
            if info.st_dev != overlay_root_info.st_dev:
                os.close(next_descriptor)
                raise SystemExit("recovery archive overlay crossed a filesystem boundary")
            os.close(overlay_parent)
            overlay_parent = next_descriptor
        inspect_entry(
            overlay_parent,
            parts[-1],
            overlay_relative,
            apply_exclusions=False,
            expected_device=overlay_root_info.st_dev,
            origin="overlay",
            recurse=False,
        )
    finally:
        os.close(overlay_parent)
os.close(root_descriptor)
if overlay_root_descriptor is not None:
    os.close(overlay_root_descriptor)

# Failed live attempts may have populated provisional digest/hard-link state.
# Rebuild every emitted contract from the committed stable/provisional records
# only; no failed attempt remains authoritative.
members = [record["name"] for record in records]
if len(members) != len(set(members)):
    raise SystemExit("recovery source member inventory is duplicated")
hardlinks = {}
raw_inode_origins = {}
for record in records:
    if record["kind"] != "file":
        continue
    raw_identity = (record["device"], record["inode"])
    raw_inode_origins.setdefault(raw_identity, set()).add(record["origin"])
    hardlinks.setdefault(raw_identity, []).append(
        (record["name"], record["links"])
    )
if any(len(origins) > 1 for origins in raw_inode_origins.values()):
    raise SystemExit("recovery archive hard link crosses source authorities")

digest = hashlib.sha256()
for record in records:
    for value in (
        record["name"],
        record["kind"],
        record["device"],
        record["inode"],
        record["links"],
        record["uid"],
        record["gid"],
        record["mode"],
        record["size"],
        record["mtimeNs"],
        record["ctimeNs"],
        record["link"],
    ):
        add_field(value)
    for name, value in record["xattrs"]:
        add_field(name)
        add_field(value)
    add_field("xattr-end")
    for extent in record["extents"]:
        add_field(extent[0])
        add_field(extent[1])
    add_field("sparse-end")
    add_field(record["contentSha256"])

for paths in hardlinks.values():
    expected = paths[0][1]
    # `expected` is the inode's link count; `paths` are the links found inside
    # this component. Fewer links here than the inode reports means the file is
    # also linked somewhere outside the component -- which is normal for the
    # components that legitimately share inodes with another backed-up tree.
    # Finding MORE links than the inode reports, or disagreeing link counts, is
    # never legitimate and still fails closed.
    if (
        expected < len(paths)
        or any(value != expected for _, value in paths)
        or (expected != len(paths) and not allow_external_hardlinks)
    ):
        raise SystemExit(
            "recovery source hard link crosses a component or exclusion boundary"
        )
if not members or len(members) > 1_000_000:
    raise SystemExit("recovery source member inventory is empty or unbounded")
aggregate_xattr_bytes = sum(
    len(name) + len(value)
    for record in records
    for name, value in record["xattrs"]
)
if aggregate_xattr_bytes > xattr_max_bytes:
    raise SystemExit("recovery source xattr inventory is unbounded")

contract_digest = hashlib.sha256()
canonical_files = {}
for record in records:
    kind = record["kind"]
    link = record["link"]
    xattrs = record["xattrs"]
    size = record["size"] if kind == "file" else 0
    sparse = record["sparse"]
    content_sha256 = record["contentSha256"]
    if kind == "file":
        canonical = canonical_files.get(record["identity"])
        if canonical is None:
            canonical_files[record["identity"]] = record["name"]
        else:
            kind = "hardlink"
            link = canonical.encode("utf-8")
            xattrs = ()
            size = 0
            sparse = False
    for value in (
        record["name"],
        kind,
        record["uid"],
        record["gid"],
        record["mode"],
        size,
        record["mtimeNs"],
        link,
    ):
        add_contract_field(value)
    for name, value in xattrs:
        add_contract_field(name)
        add_contract_field(value)
    add_contract_field("xattr-end")
    add_contract_field(1 if sparse else 0)
    add_contract_field(content_sha256)

evidence_bytes = 0
with open(list_path, "xb", buffering=0) as handle:
    for name in members:
        payload = name.encode("utf-8") + b"\0"
        evidence_bytes += len(payload)
        if evidence_bytes > evidence_max_bytes:
            raise SystemExit("archive evidence bound was exceeded")
        handle.write(payload)
    os.fsync(handle.fileno())
with open(digest_path, "x", encoding="ascii") as handle:
    digest_payload = (
        digest.hexdigest() + "\n" + contract_digest.hexdigest() + "\n"
    )
    evidence_bytes += len(digest_payload.encode("ascii"))
    if evidence_bytes > evidence_max_bytes:
        raise SystemExit("archive evidence bound was exceeded")
    handle.write(digest_payload)
    handle.flush()
    os.fsync(handle.fileno())
with open(records_path, "x", encoding="utf-8") as handle:
    for record in records:
        serialized = {
            key: record[key]
            for key in (
                "name", "relative", "origin", "kind", "device", "inode",
                "links", "uid", "gid", "mode", "size", "mtimeNs",
                "ctimeNs", "linkText", "xattrSha256", "sparseSha256",
                "contentSha256", "sqliteHeader",
            )
        }
        line = json.dumps(
            serialized,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
        encoded_line = line.encode("utf-8")
        if len(encoded_line) > 32768:
            raise SystemExit("archive evidence record is unbounded")
        evidence_bytes += len(encoded_line)
        if evidence_bytes > evidence_max_bytes:
            raise SystemExit("archive evidence bound was exceeded")
        handle.write(line)
    handle.flush()
    os.fsync(handle.fileno())
if live_inventory:
    unstable_payload = b"".join(
        (relative or ".").encode("utf-8") + b"\0"
        for relative in sorted(unstable_members, key=os.fsencode)
    )
    evidence_bytes += len(unstable_payload)
    if evidence_bytes > evidence_max_bytes:
        raise SystemExit("archive evidence bound was exceeded")
    descriptor = os.open(
        live_unstable_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        0o600,
    )
    try:
        view = memoryview(unstable_payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise SystemExit("live inventory evidence write was short")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

materialize_private_archive_stage() {
  local mode="$1"
  local source_dir="$2"
  local before_records="$3"
  local after_records="$4"
  local stage_root="$5"
  local stage_list="$6"
  local omit_list="$7"
  local allowed_list="$8"
  local metadata_file="$9"
  local unstable_file="${10}"
  local existing_overlay_root="${11}"
  local max_members="${12}"
  local max_bytes="${13}"
  local max_passes="${14}"
  local max_metadata_bytes="${15}"
  local max_seconds="${16}"
  local capture_records_file="${17}"
  local xattr_max_bytes="${18}"
  shift 18
  local -a worker=(
    python3 - "$mode" "$source_dir" "$before_records" "$after_records"
    "$stage_root" "$stage_list" "$omit_list" "$allowed_list"
    "$metadata_file" "$unstable_file" "$existing_overlay_root"
    "$max_members" "$max_bytes" "$max_passes"
    "$max_metadata_bytes" "$max_seconds" "$capture_records_file"
    "$xattr_max_bytes" "$@"
  )
  if [[ "$mode" == "reconcile" ]]; then
    local timeout_uid timeout_gid timeout_mode timeout_links timeout_kind
    IFS=: read -r timeout_uid timeout_gid timeout_mode timeout_links timeout_kind \
      < <(stat -Lc '%u:%g:%a:%h:%F' /usr/bin/timeout 2>/dev/null) \
      || return 1
    [[ "$timeout_uid" == "0" \
      && "$timeout_gid" == "0" \
      && "$timeout_mode" =~ ^[0-7]{3,4}$ \
      && "$timeout_links" =~ ^[1-9][0-9]*$ \
      && "$timeout_kind" == "regular file" \
      && -x /usr/bin/timeout \
      && ! -L /usr/bin/timeout ]] \
      || return 1
    (( (8#$timeout_mode & 0022) == 0 )) || return 1
    worker=(
      /usr/bin/timeout --foreground --signal=TERM --kill-after=2s
      "${max_seconds}s" "${worker[@]}"
    )
  fi
  local worker_status=0
  "${worker[@]}" <<'PY' || worker_status=$?
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import signal
import sqlite3
import stat
import struct
import sys
import tempfile
import time

(
    mode,
    source_raw,
    before_raw,
    after_raw,
    stage_raw,
    stage_list_raw,
    omit_list_raw,
    allowed_list_raw,
    metadata_raw,
    unstable_raw,
    existing_overlay_root_raw,
    max_members_raw,
    max_bytes_raw,
    max_passes_raw,
    max_metadata_raw,
    max_seconds_raw,
    capture_records_raw,
    xattr_max_raw,
    *existing_overlay_raw,
) = sys.argv[1:]
source = pathlib.Path(source_raw)
stage_root = pathlib.Path(stage_raw)
stage_list_path = pathlib.Path(stage_list_raw)
omit_list_path = pathlib.Path(omit_list_raw)
allowed_list_path = pathlib.Path(allowed_list_raw)
metadata_path = pathlib.Path(metadata_raw)
unstable_path = pathlib.Path(unstable_raw)
capture_records_path = pathlib.Path(capture_records_raw)
existing_overlay_root = (
    pathlib.Path(existing_overlay_root_raw)
    if existing_overlay_root_raw
    else None
)
max_members = int(max_members_raw)
max_bytes = int(max_bytes_raw)
max_passes = int(max_passes_raw)
max_metadata_bytes = int(max_metadata_raw)
max_seconds = int(max_seconds_raw)
xattr_max_bytes = int(xattr_max_raw)

if mode not in {"baseline-live", "baseline-strict", "reconcile"}:
    raise SystemExit("private archive stage mode is invalid")
baseline_mode = mode in {"baseline-live", "baseline-strict"}
live_baseline = mode == "baseline-live"

if (
    max_members <= 0
    or max_members > 512
    or max_bytes <= 0
    or max_bytes > 4 * 1024**3
    or max_passes <= 0
    or max_passes > 3
    or max_metadata_bytes <= 0
    or max_metadata_bytes > 32768
    or max_seconds <= 0
    or max_seconds > 900
    or xattr_max_bytes != 16 * 1024 * 1024
):
    raise SystemExit("live reconciliation bounds are invalid")

deadline = None if baseline_mode else time.monotonic() + max_seconds

class ReconciliationBoundError(ValueError):
    pass

def assert_time_budget():
    if deadline is not None and time.monotonic() >= deadline:
        raise ReconciliationBoundError(
            "live reconciliation time bound was exceeded"
        )

def remaining_budget_seconds():
    assert_time_budget()
    if deadline is None:
        raise ReconciliationBoundError(
            "SQLite online capture is unavailable during baseline staging"
        )
    return max(0.001, deadline - time.monotonic())

def clamp_sqlite_busy_timeout(connection):
    milliseconds = max(
        1,
        min(30000, int(remaining_budget_seconds() * 1000)),
    )
    connection.execute(f"PRAGMA busy_timeout={milliseconds}")
    return milliseconds

def sqlite_vm_progress():
    assert_time_budget()
    return 0

record_keys = {
    "name", "relative", "origin", "kind", "device", "inode", "links",
    "uid", "gid", "mode", "size", "mtimeNs", "ctimeNs", "linkText",
    "xattrSha256", "sparseSha256", "contentSha256", "sqliteHeader",
}

def canonical_directory(path, *, private=False):
    info = os.lstat(path)
    return (
        path.is_absolute()
        and os.path.normpath(path) == str(path)
        and os.path.realpath(path) == str(path)
        and stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and info.st_uid == 0
        and info.st_gid == 0
        and not (info.st_mode & 0o022)
        and (not private or stat.S_IMODE(info.st_mode) == 0o700)
    )

if (
    not canonical_directory(source)
    or not canonical_directory(stage_root.parent, private=True)
    or not canonical_directory(stage_root, private=True)
    or str(stage_root) == str(source)
    or str(stage_root).startswith(str(source) + os.sep)
    or str(source).startswith(str(stage_root) + os.sep)
    or stage_root.name != source.name
    or any(os.path.lexists(path) for path in (
        stage_list_path,
        omit_list_path,
        allowed_list_path,
        metadata_path,
        capture_records_path,
    ))
    or (baseline_mode and os.path.lexists(unstable_path))
    or (not baseline_mode and not unstable_path.is_file())
    or (baseline_mode and os.listdir(stage_root))
):
    raise SystemExit("private archive stage authority is unsafe")

if existing_overlay_root is not None:
    if (
        not canonical_directory(existing_overlay_root)
        or existing_overlay_root.name != source.name
        or str(existing_overlay_root) in {str(source), str(stage_root)}
        or str(existing_overlay_root).startswith(str(source) + os.sep)
        or str(source).startswith(str(existing_overlay_root) + os.sep)
        or str(existing_overlay_root).startswith(str(stage_root) + os.sep)
        or str(stage_root).startswith(str(existing_overlay_root) + os.sep)
    ):
        raise SystemExit("existing recovery overlay authority is unsafe")
elif existing_overlay_raw:
    raise SystemExit("existing recovery overlay authority is incomplete")

def load_records(path):
    result = {}
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            assert_time_budget()
            if not line.endswith("\n") or len(line.encode("utf-8")) > 32768:
                raise ValueError("live inventory record is unsafe")
            record = json.loads(line)
            relative = record.get("relative")
            if (
                not isinstance(record, dict)
                or set(record) != record_keys
                or record.get("origin") not in {"source", "overlay"}
                or record.get("kind") not in {"directory", "file", "symlink"}
                or not isinstance(relative, str)
                or relative.startswith("/")
                or "\\" in relative
                or "\0" in relative
                or "\n" in relative
                or (relative and any(part in {"", ".", ".."} for part in relative.split("/")))
                or len(relative.encode("utf-8")) >= 4096
                or any(
                    not isinstance(record[key], int)
                    or isinstance(record[key], bool)
                    or record[key] < 0
                    for key in (
                        "device", "inode", "links", "uid", "gid", "mode",
                        "size", "mtimeNs", "ctimeNs",
                    )
                )
                or record["links"] <= 0
                or record["mode"] & ~0o7777
                or not isinstance(record.get("linkText"), str)
                or not isinstance(record.get("sqliteHeader"), bool)
                or any(
                    not isinstance(record.get(key), str)
                    or len(record[key]) != 64
                    or any(character not in "0123456789abcdef" for character in record[key])
                    for key in ("xattrSha256", "sparseSha256", "contentSha256")
                )
            ):
                raise ValueError("live inventory record is invalid")
            identity = (record["origin"], relative)
            if identity in result:
                raise ValueError("live inventory record is duplicated")
            result[identity] = record
    if not result or len(result) > 1_000_000:
        raise ValueError("live inventory is empty or unbounded")
    return result

try:
    before_all = load_records(pathlib.Path(before_raw))
    after_all = load_records(pathlib.Path(after_raw))
except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
    raise SystemExit(f"live reconciliation inventory is invalid: {error}")

def composed_records(records):
    result = {}
    for (_origin, relative), record in records.items():
        if relative in result:
            raise ValueError("composed recovery inventory is contradictory")
        result[relative] = record
    return result

existing_overlay = set()
for raw in existing_overlay_raw:
    relative = "" if raw == "." else raw
    if (
        relative.startswith("/")
        or "\\" in relative
        or "\0" in relative
        or "\n" in relative
        or (relative and any(part in {"", ".", ".."} for part in relative.split("/")))
        or relative in existing_overlay
    ):
        raise SystemExit("existing recovery overlay inventory is invalid")
    existing_overlay.add(relative)

before_overlay = {
    relative for (origin, relative) in before_all if origin == "overlay"
}
after_overlay = {
    relative for (origin, relative) in after_all if origin == "overlay"
}
if (
    before_overlay != existing_overlay
    or after_overlay != existing_overlay
    or bool(existing_overlay) != (existing_overlay_root is not None)
):
    raise SystemExit("existing recovery overlay inventory is contradictory")

if baseline_mode:
    before = composed_records(before_all)
    after = composed_records(after_all)
else:
    before = {
        relative: record
        for (origin, relative), record in before_all.items()
        if origin == "source"
    }
    after = {
        relative: record
        for (origin, relative), record in after_all.items()
        if origin == "source"
    }

def read_relative_set(path):
    raw = path.read_bytes()
    if raw and not raw.endswith(b"\0"):
        raise ValueError("private stage unstable inventory is malformed")
    values = raw[:-1].split(b"\0") if raw else []
    result = set()
    for encoded in values:
        relative = "" if encoded == b"." else encoded.decode("utf-8")
        if (
            relative in result
            or relative.startswith("/")
            or "\\" in relative
            or "\0" in relative
            or "\n" in relative
            or (
                relative
                and any(part in {"", ".", ".."} for part in relative.split("/"))
            )
        ):
            raise ValueError("private stage unstable inventory is invalid")
        result.add(relative)
    return result

baseline_unstable = set() if baseline_mode else read_relative_set(unstable_path)
unresolved_unstable = set()
if not baseline_mode:
    for relative in baseline_unstable:
        if relative in after:
            continue
        if relative in before:
            # B observed this admitted path but could not settle a complete
            # record.  Retain A's descriptor identity only as provisional
            # recapture authority; successful staging emits a new binding.
            after[relative] = dict(before[relative])
        else:
            # A name enumerated during a live walk may disappear before its
            # descriptor opens.  It is not an omission policy: reconciliation
            # must prove it remains absent or fail closed if it reappears.
            unresolved_unstable.add(relative)

def transition(relative):
    if relative not in before:
        return "added"
    if relative not in after:
        return "removed"
    return "stable" if before[relative] == after[relative] else "changed"

changed = set()
if not baseline_mode:
    changed = {
        relative
        for relative in set(before) | set(after)
        if before.get(relative) != after.get(relative)
    } | baseline_unstable
stage_members = set(after) if baseline_mode else set()
omit_members = set()
allowed_members = set()
events = {}

def add_event(relative, capture, *, forced_transition=None):
    observed_transition = forced_transition or transition(relative)
    current = events.get(relative)
    candidate = {
        "path": relative or ".",
        "transition": observed_transition,
        "capture": capture,
    }
    if current is None:
        events[relative] = candidate
        return
    # SQLite online capture and journal omission are stronger, explicit
    # contracts than a generic descriptor snapshot for the same member.
    priority = {
        "absent-at-attestation": 0,
        "metadata-snapshot": 1,
        "symlink-snapshot": 2,
        "descriptor-snapshot": 3,
        "hardlink-snapshot": 4,
        "sqlite-journal-omitted": 5,
        "sqlite-online-snapshot": 6,
    }
    if priority[capture] >= priority[current["capture"]]:
        events[relative] = candidate

sqlite_mains = {
    relative
    for relative, record in after.items()
    if (
        record["origin"] == "source"
        and record["kind"] == "file"
        and record["sqliteHeader"]
    )
}
sqlite_capture_mains = set()

if baseline_mode:
    if live_baseline:
        for relative in sqlite_mains:
            stage_members.discard(relative)
            omit_members.add(relative)
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar = relative + suffix
                if sidecar in after:
                    stage_members.discard(sidecar)
                    omit_members.add(sidecar)
else:
    allowed_members.update(changed)
    omit_members.update(
        relative for relative in changed if relative not in after
    )
    for relative in sorted(changed, key=os.fsencode):
        if relative not in after:
            add_event(relative, "absent-at-attestation")
            continue
        stage_members.add(relative)
    sqlite_capture_mains = set(sqlite_mains)

def ancestors(relative):
    parts = relative.split("/") if relative else []
    yield ""
    for index in range(1, len(parts)):
        yield "/".join(parts[:index])

for relative in sorted(sqlite_capture_mains, key=os.fsencode):
    record = after[relative]
    if record["links"] != 1:
        raise SystemExit("live SQLite database has unsafe hard links")
    stage_members.add(relative)
    allowed_members.add(relative)
    add_event(relative, "sqlite-online-snapshot")
    for ancestor in ancestors(relative):
        ancestor_record = after.get(ancestor)
        if ancestor_record is None or ancestor_record["kind"] != "directory":
            raise SystemExit("live SQLite database ancestry changed")
        stage_members.add(ancestor)
        allowed_members.add(ancestor)
        add_event(ancestor, "metadata-snapshot")
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = relative + suffix
        sidecar_record = after.get(sidecar)
        if sidecar_record is not None and (
            sidecar_record["kind"] != "file" or sidecar_record["links"] != 1
        ):
            raise SystemExit("live SQLite journal member is unsafe")
        stage_members.discard(sidecar)
        omit_members.add(sidecar)
        allowed_members.add(sidecar)
        add_event(sidecar, "sqlite-journal-omitted")

# If any included link of an inode must be frozen, freeze every included link.
# The staged inode then reproduces the component's complete hard-link graph.
hardlink_groups = {}
for relative, record in after.items():
    if record["kind"] == "file":
        hardlink_groups.setdefault(
            (record["origin"], record["device"], record["inode"]), []
        ).append(relative)
for paths in hardlink_groups.values():
    if len(paths) <= 1 or not stage_members.intersection(paths):
        continue
    if sqlite_capture_mains.intersection(paths):
        raise SystemExit("live SQLite database hard-link topology is unsafe")
    for relative in paths:
        stage_members.add(relative)
        if not baseline_mode:
            allowed_members.add(relative)

if not baseline_mode:
    # Replacing or removing any staged child changes its private parent
    # metadata even when the corresponding live directory stayed stable.
    # Reapply every admitted ancestor deepest-last so the stage remains an
    # exact archive-contract projection rather than a copy-operation trace.
    for relative in sorted(stage_members | omit_members, key=os.fsencode):
        for ancestor in ancestors(relative):
            record = after.get(ancestor)
            if record is None or record["kind"] != "directory":
                raise SystemExit("live reconciliation ancestry changed")
            stage_members.add(ancestor)
            allowed_members.add(ancestor)
            add_event(ancestor, "metadata-snapshot")

if not baseline_mode and existing_overlay & (stage_members | omit_members):
    raise SystemExit("live reconciliation collided with an existing overlay")

for relative in sorted(stage_members, key=os.fsencode):
    record = after.get(relative)
    if record is None:
        raise SystemExit("private stage member disappeared")
    if baseline_mode:
        continue
    if relative in sqlite_capture_mains:
        add_event(relative, "sqlite-online-snapshot")
    elif record["kind"] == "directory":
        add_event(relative, "metadata-snapshot")
    elif record["kind"] == "symlink":
        add_event(relative, "symlink-snapshot")
    else:
        add_event(relative, "descriptor-snapshot")

tracked_members = set(events)
if not baseline_mode and len(tracked_members) > max_members:
    raise SystemExit("live reconciliation member bound was exceeded")

estimated_bytes = 0
estimated_identities = set()
for relative in stage_members:
    record = after[relative]
    if record["kind"] != "file":
        continue
    identity = (record["origin"], record["device"], record["inode"])
    if identity in estimated_identities:
        continue
    estimated_identities.add(identity)
    estimated_bytes += record["size"]
    if not baseline_mode and estimated_bytes > max_bytes:
        raise SystemExit("live reconciliation byte bound was exceeded")

def write_new(path, payload):
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        0o600,
    )
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short reconciliation metadata write")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

if not baseline_mode and not events:
    for path in (
        stage_list_path,
        omit_list_path,
        allowed_list_path,
        metadata_path,
        capture_records_path,
    ):
        write_new(path, b"")
    raise SystemExit(0)

mount_libc = ctypes.CDLL(None, use_errno=True)
mount_call = getattr(mount_libc, "mount", None)
unshare_call = getattr(mount_libc, "unshare", None)
umount2_call = getattr(mount_libc, "umount2", None)
if mount_call is not None:
    mount_call.argtypes = [
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_ulong,
        ctypes.c_void_p,
    ]
    mount_call.restype = ctypes.c_int
if unshare_call is not None:
    unshare_call.argtypes = [ctypes.c_int]
    unshare_call.restype = ctypes.c_int
if umount2_call is not None:
    umount2_call.argtypes = [ctypes.c_char_p, ctypes.c_int]
    umount2_call.restype = ctypes.c_int

CLONE_NEWNS = 0x00020000
MS_REC = 0x00004000
MS_PRIVATE = 0x00040000
MS_BIND = 0x00001000
MNT_DETACH = 0x00000002
mount_namespace_initialized = False

def enter_private_mount_namespace():
    global mount_namespace_initialized
    if mount_namespace_initialized:
        return
    if (
        os.geteuid() != 0
        or mount_call is None
        or unshare_call is None
        or umount2_call is None
    ):
        raise ValueError("live SQLite descriptor-mount authority is unavailable")
    namespace_before = os.stat("/proc/self/ns/mnt")
    if unshare_call(CLONE_NEWNS) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "live SQLite mount namespace could not be isolated")
    namespace_after = os.stat("/proc/self/ns/mnt")
    if (
        namespace_before.st_dev == namespace_after.st_dev
        and namespace_before.st_ino == namespace_after.st_ino
    ):
        raise ValueError("live SQLite mount namespace was not isolated")
    if mount_call(None, b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "live SQLite mount propagation could not be privatized")
    mount_namespace_initialized = True

def mount_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        info.st_nlink,
    )

def placeholder_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_uid,
        info.st_gid,
        info.st_nlink,
        info.st_size,
    )

def attach_descriptor_mount(descriptor, view_descriptor, view, name, mounts):
    source_before = os.fstat(descriptor)
    target_descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o600,
        dir_fd=view_descriptor,
    )
    try:
        os.fchmod(target_descriptor, 0o600)
        placeholder = os.fstat(target_descriptor)
    finally:
        os.close(target_descriptor)
    if (
        not stat.S_ISREG(placeholder.st_mode)
        or placeholder.st_uid != 0
        or placeholder.st_gid != 0
        or placeholder.st_nlink != 1
        or placeholder.st_size != 0
        or stat.S_IMODE(placeholder.st_mode) != 0o600
    ):
        raise ValueError("live SQLite mount placeholder is unsafe")
    target = view / name
    record = {
        "path": target,
        "placeholder": placeholder_identity(placeholder),
        "mounted": False,
    }
    mounts.append(record)
    proc_source = os.fsencode(f"/proc/self/fd/{descriptor}")
    if mount_call(
        proc_source,
        os.fsencode(target),
        None,
        MS_BIND,
        None,
    ) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "live SQLite descriptor mount could not be attached")
    record["mounted"] = True
    observed = os.stat(name, dir_fd=view_descriptor, follow_symlinks=False)
    source_after = os.fstat(descriptor)
    if (
        mount_identity(source_before) != mount_identity(source_after)
        or mount_identity(source_after) != mount_identity(observed)
    ):
        raise ValueError("live SQLite descriptor mount changed inode authority")

def cleanup_sqlite_inode_view(view, mounts, *, strict):
    errors = []
    for record in reversed(mounts):
        target = record["path"]
        if record["mounted"]:
            if umount2_call(os.fsencode(target), MNT_DETACH) != 0:
                error = ctypes.get_errno()
                errors.append(OSError(error, "live SQLite descriptor mount did not detach"))
                continue
            record["mounted"] = False
        try:
            observed = os.lstat(target)
            if placeholder_identity(observed) != record["placeholder"]:
                raise ValueError("live SQLite mount placeholder identity changed")
            os.unlink(target)
        except (OSError, ValueError) as error:
            errors.append(error)
    try:
        os.rmdir(view)
    except OSError as error:
        errors.append(error)
    if strict and errors:
        raise OSError(f"live SQLite descriptor-mount cleanup failed: {errors[0]}")

def create_sqlite_inode_view(main_descriptor, sidecars):
    if not mount_namespace_initialized:
        raise ValueError("live SQLite mount namespace was not initialized")
    view = pathlib.Path(tempfile.mkdtemp(
        prefix=".sqlite-inode-view.",
        dir=stage_root.parent,
    ))
    os.chmod(view, 0o700)
    view_info = os.lstat(view)
    if (
        not stat.S_ISDIR(view_info.st_mode)
        or stat.S_ISLNK(view_info.st_mode)
        or view_info.st_uid != 0
        or view_info.st_gid != 0
        or stat.S_IMODE(view_info.st_mode) != 0o700
    ):
        os.rmdir(view)
        raise ValueError("live SQLite descriptor-mount view is unsafe")
    mounts = []
    try:
        view_descriptor = os.open(
            view,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except BaseException:
        os.rmdir(view)
        raise
    try:
        main = view / "database.sqlite"
        attach_descriptor_mount(
            main_descriptor,
            view_descriptor,
            view,
            main.name,
            mounts,
        )
        for suffix, descriptor in sorted(sidecars.items()):
            sidecar = pathlib.Path(str(main) + suffix)
            attach_descriptor_mount(
                descriptor,
                view_descriptor,
                view,
                sidecar.name,
                mounts,
            )
        return view, main, mounts
    except BaseException:
        cleanup_sqlite_inode_view(view, mounts, strict=True)
        raise
    finally:
        os.close(view_descriptor)

def assert_sqlite_topology(
    relative,
    record,
    parent,
    parent_before,
    name,
    descriptor,
    sidecar_descriptors,
    inode_view,
):
    if stable_stat(os.fstat(parent)) != stable_stat(parent_before):
        raise ValueError("live SQLite parent changed during snapshot")
    main_path_info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (
        identity(main_path_info) != expected_identity(record)
        or identity(os.fstat(descriptor)) != expected_identity(record)
    ):
        raise ValueError("live SQLite identity changed")
    expected_view = {"database.sqlite"}
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar_relative = relative + suffix
        sidecar_record = after.get(sidecar_relative)
        held = sidecar_descriptors.get(suffix)
        try:
            observed = os.stat(
                name + suffix,
                dir_fd=parent,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            if sidecar_record is not None or held is not None:
                raise ValueError("live SQLite journal topology changed")
            continue
        if (
            sidecar_record is None
            or held is None
            or identity(observed) != expected_identity(sidecar_record)
            or identity(os.fstat(held)) != expected_identity(sidecar_record)
        ):
            raise ValueError("live SQLite journal topology changed")
        expected_view.add("database.sqlite" + suffix)
    admitted_suffixes = set(sidecar_descriptors)
    if (
        ("-shm" in admitted_suffixes and "-wal" not in admitted_suffixes)
        or (
            "-journal" in admitted_suffixes
            and bool(admitted_suffixes & {"-wal", "-shm"})
        )
    ):
        raise ValueError("live SQLite admitted journal topology is invalid")
    observed_view = set(os.listdir(inode_view))
    if observed_view != expected_view:
        raise ValueError("live SQLite private view created an unadmitted journal")
    mounted = {
        "database.sqlite": descriptor,
        **{
            "database.sqlite" + suffix: held
            for suffix, held in sidecar_descriptors.items()
        },
    }
    view_descriptor = os.open(
        inode_view,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        for mounted_name, held in mounted.items():
            observed = os.stat(
                mounted_name,
                dir_fd=view_descriptor,
                follow_symlinks=False,
            )
            if mount_identity(observed) != mount_identity(os.fstat(held)):
                raise ValueError("live SQLite private view lost inode authority")
    finally:
        os.close(view_descriptor)

if sqlite_capture_mains:
    # Enter the private namespace before opening the source root.  Descriptors
    # opened before unshare cannot seed descriptor bind mounts in the new view.
    enter_private_mount_namespace()

source_directory_flags = (
    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
def open_absolute_directory(path):
    descriptor = os.open("/", source_directory_flags)
    try:
        for component in path.parts[1:]:
            next_descriptor = os.open(
                component,
                source_directory_flags,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

root_descriptors = {"source": open_absolute_directory(source)}
if existing_overlay_root is not None:
    root_descriptors["overlay"] = open_absolute_directory(
        existing_overlay_root
    )

stage_device = os.lstat(stage_root).st_dev

def split_relative(relative):
    return relative.split("/") if relative else []

def open_source(relative, flags, origin):
    root_descriptor = root_descriptors.get(origin)
    if root_descriptor is None:
        raise ValueError("private stage source origin is unavailable")
    parts = split_relative(relative)
    if not parts:
        return os.dup(root_descriptor), None, None
    parent = os.dup(root_descriptor)
    try:
        for part in parts[:-1]:
            next_descriptor = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent,
            )
            os.close(parent)
            parent = next_descriptor
        member = os.open(
            parts[-1],
            flags | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent,
        )
        return member, parent, parts[-1]
    except BaseException:
        os.close(parent)
        raise

for relative in sorted(unresolved_unstable, key=os.fsencode):
    descriptor = parent = None
    try:
        descriptor, parent, _ = open_source(
            relative,
            os.O_PATH,
            "source",
        )
    except FileNotFoundError:
        continue
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent is not None:
            os.close(parent)
    raise ValueError("unrecorded unstable source member reappeared")

def target_path(relative):
    return stage_root.joinpath(*split_relative(relative))

scaffolded_directories = set()

def ensure_target_parent(relative):
    current = stage_root
    for part in split_relative(relative)[:-1]:
        current = current / part
        created = False
        try:
            current.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        info = os.lstat(current)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_dev != stage_device
        ):
            raise ValueError("live reconciliation overlay ancestry is unsafe")
        if created:
            clean_scaffold_directory(current)
            scaffolded_directories.add(str(current))

def stat_kind(info):
    if stat.S_ISREG(info.st_mode):
        return "file"
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    if stat.S_ISLNK(info.st_mode):
        return "symlink"
    return "unsupported"

def identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat_kind(info),
        info.st_nlink,
    )

def expected_identity(record):
    return (
        record["device"],
        record["inode"],
        record["kind"],
        record["links"],
    )

def stable_stat(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_nlink,
        info.st_uid,
        info.st_gid,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
        info.st_blocks,
    )

def xattrs_from_fd(descriptor):
    names = sorted(
        name if isinstance(name, bytes) else name.encode("utf-8", "surrogateescape")
        for name in os.listxattr(descriptor)
    )
    if len(names) > 1024 or len(names) != len(set(names)):
        raise ValueError("live reconciliation xattrs are unbounded")
    total = 0
    result = []
    for name in names:
        value = os.getxattr(descriptor, name)
        total += len(name) + len(value)
        if not name or len(name) > 255 or len(value) > 1024 * 1024 or total > 16 * 1024 * 1024:
            raise ValueError("live reconciliation xattrs are unbounded")
        result.append((name, value))
    return tuple(result)

def xattrs_from_symlink(path):
    names = sorted(
        name if isinstance(name, bytes) else name.encode("utf-8", "surrogateescape")
        for name in os.listxattr(path, follow_symlinks=False)
    )
    if len(names) > 1024 or len(names) != len(set(names)):
        raise ValueError("live reconciliation symlink xattrs are unbounded")
    total = 0
    result = []
    for name in names:
        value = os.getxattr(path, name, follow_symlinks=False)
        total += len(name) + len(value)
        if not name or len(name) > 255 or len(value) > 1024 * 1024 or total > 16 * 1024 * 1024:
            raise ValueError("live reconciliation symlink xattrs are unbounded")
        result.append((name, value))
    return tuple(result)

def source_symlink_state(parent, name, descriptor):
    parent_before = stable_stat(os.fstat(parent))
    link_before = stable_stat(os.fstat(descriptor))
    proc_path = pathlib.Path(f"/proc/self/fd/{parent}") / name
    link_target = os.readlink(name, dir_fd=parent)
    source_xattrs = xattrs_from_symlink(proc_path)
    path_info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (
        identity(path_info) != identity(os.fstat(descriptor))
        or stable_stat(path_info) != link_before
        or stable_stat(os.fstat(descriptor)) != link_before
        or stable_stat(os.fstat(parent)) != parent_before
    ):
        raise RuntimeError("live symlink changed during descriptor snapshot")
    return link_target, source_xattrs

def replace_fd_xattrs(descriptor, expected):
    expected_map = dict(expected)
    if len(expected_map) != len(expected):
        raise ValueError("live reconciliation xattr inventory is duplicated")
    for name, _value in xattrs_from_fd(descriptor):
        if name not in expected_map:
            os.removexattr(descriptor, name)
    for name, value in expected:
        os.setxattr(descriptor, name, value)
    if xattrs_from_fd(descriptor) != expected:
        raise ValueError("live reconciliation xattrs did not replace exactly")

def replace_symlink_xattrs(path, expected):
    expected_map = dict(expected)
    if len(expected_map) != len(expected):
        raise ValueError("live reconciliation symlink xattrs are duplicated")
    for name, _value in xattrs_from_symlink(path):
        if name not in expected_map:
            os.removexattr(path, name, follow_symlinks=False)
    for name, value in expected:
        os.setxattr(path, name, value, follow_symlinks=False)
    if xattrs_from_symlink(path) != expected:
        raise ValueError("live reconciliation symlink xattrs did not replace exactly")

def clean_scaffold_directory(path):
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fchown(descriptor, 0, 0)
        replace_fd_xattrs(descriptor, ())
        os.fchmod(descriptor, 0o700)
        info = os.fstat(descriptor)
        if (
            info.st_uid != 0
            or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise ValueError("live reconciliation scaffold metadata is unsafe")
    finally:
        os.close(descriptor)

def apply_fd_metadata(descriptor, info, xattrs):
    # Ownership changes can clear capabilities.  Set ownership first, remove
    # every inherited ACL/xattr and apply the exact source set, then settle the
    # requested mode and timestamps and read the whole result back.
    os.fchown(descriptor, info.st_uid, info.st_gid)
    replace_fd_xattrs(descriptor, xattrs)
    os.fchmod(descriptor, stat.S_IMODE(info.st_mode))
    os.utime(descriptor, ns=(info.st_atime_ns, info.st_mtime_ns))
    final = os.fstat(descriptor)
    if (
        final.st_uid != info.st_uid
        or final.st_gid != info.st_gid
        or stat.S_IMODE(final.st_mode) != stat.S_IMODE(info.st_mode)
        or final.st_atime_ns != info.st_atime_ns
        or final.st_mtime_ns != info.st_mtime_ns
        or xattrs_from_fd(descriptor) != xattrs
    ):
        raise ValueError("live reconciliation metadata did not replace exactly")

if baseline_mode:
    # The full stage is private but may inherit default ACLs/xattrs from its
    # parent.  Strip them before creating any child so scaffolding cannot leak
    # metadata into the recovery contract.
    clean_scaffold_directory(stage_root)
    scaffolded_directories.add(str(stage_root))

def sparse_ranges(descriptor, size, *, require_sparse):
    if size == 0:
        return []
    if not hasattr(os, "SEEK_DATA") or not hasattr(os, "SEEK_HOLE"):
        if require_sparse:
            raise ValueError("sparse source cannot be attested on this filesystem")
        return [(0, size)]
    ranges = []
    offset = 0
    while offset < size:
        try:
            data = os.lseek(descriptor, offset, os.SEEK_DATA)
        except OSError as error:
            if error.errno == errno.ENXIO:
                break
            if error.errno in {errno.EINVAL, errno.EOPNOTSUPP}:
                if require_sparse:
                    raise ValueError("sparse source cannot be attested on this filesystem")
                return [(0, size)]
            raise
        hole = os.lseek(descriptor, data, os.SEEK_HOLE)
        if hole < data or hole > size:
            raise ValueError("live reconciliation sparse map is invalid")
        ranges.append((data, hole))
        offset = hole
    return ranges

hook_root_raw = os.environ.get("BRIDGESLLM_BACKUP_TEST_ROOT", "")
hook_dir_raw = os.environ.get("BRIDGESLLM_BACKUP_RECONCILIATION_TEST_HOOK_DIR", "")
hook_relative = os.environ.get("BRIDGESLLM_BACKUP_RECONCILIATION_TEST_HOOK_PATH", "")
hook_phase_selector = os.environ.get(
    "BRIDGESLLM_BACKUP_SQLITE_TEST_PHASE",
    "",
)
stage_hook_phase = os.environ.get(
    "BRIDGESLLM_BACKUP_STAGE_TEST_PHASE",
    "",
)
stage_hook_paths_raw = os.environ.get(
    "BRIDGESLLM_BACKUP_STAGE_TEST_HOOK_PATHS",
    "",
)
baseline_stage_hook_relative = os.environ.get(
    "BRIDGESLLM_BACKUP_STAGE_TEST_HOOK_PATH",
    "",
)
hard_stall_raw = os.environ.get(
    "BRIDGESLLM_BACKUP_SQLITE_TEST_HARD_STALL",
    "",
)
if hard_stall_raw not in {"", "0", "1"}:
    raise SystemExit("live SQLite hard-stall selector is invalid")
hard_stall_enabled = not baseline_mode and hard_stall_raw == "1"
hook_dir = (
    pathlib.Path(hook_dir_raw)
    if not baseline_mode and hook_dir_raw and hook_relative
    else None
)
hook_used = False
if hook_dir is not None:
    hook_root = pathlib.Path(hook_root_raw)
    if (
        not hook_root_raw
        or not hook_root.is_absolute()
        or os.path.realpath(hook_root) != str(hook_root)
        or not hook_dir.is_absolute()
        or os.path.realpath(hook_dir) != str(hook_dir)
        or not str(hook_dir).startswith(str(hook_root) + os.sep)
        or not canonical_directory(hook_dir, private=True)
        or hook_relative not in stage_members
        or hook_phase_selector not in {
            "",
            "sqlite-admission",
            "sqlite-opened",
            "sqlite-backup-step",
            "sqlite-pre-quick-check",
        }
    ):
        raise SystemExit("live reconciliation test hook authority is unsafe")
if hard_stall_enabled and (
    hook_dir is None
    or hook_phase_selector not in {
        "sqlite-backup-step",
        "sqlite-pre-quick-check",
    }
):
    raise SystemExit("live SQLite hard-stall authority is incomplete")

stage_hook_dir = None
stage_hook_paths = {}
stage_hook_used = set()
baseline_stage_hook_dir = None
baseline_stage_hook_started = False
baseline_stage_hook_completed = False
if stage_hook_phase == "baseline-leaf-copy":
    if not baseline_stage_hook_relative or stage_hook_paths_raw:
        raise SystemExit("baseline stage test hook is incomplete")
    if baseline_mode:
        candidate_hook_dir = pathlib.Path(hook_dir_raw)
        candidate_hook_root = pathlib.Path(hook_root_raw)
        relative_path = pathlib.PurePosixPath(baseline_stage_hook_relative)
        source_record = after.get(baseline_stage_hook_relative)
        if (
            not hook_root_raw
            or not hook_dir_raw
            or not candidate_hook_root.is_absolute()
            or os.path.realpath(candidate_hook_root)
                != str(candidate_hook_root)
            or not candidate_hook_dir.is_absolute()
            or os.path.realpath(candidate_hook_dir) != str(candidate_hook_dir)
            or not str(candidate_hook_dir).startswith(
                str(candidate_hook_root) + os.sep
            )
            or not canonical_directory(candidate_hook_root, private=True)
            or not canonical_directory(candidate_hook_dir, private=True)
            or relative_path.is_absolute()
            or str(relative_path) != baseline_stage_hook_relative
            or any(part in {"", ".", ".."} for part in relative_path.parts)
            or "\\" in baseline_stage_hook_relative
            or "\0" in baseline_stage_hook_relative
            or "\n" in baseline_stage_hook_relative
            or len(baseline_stage_hook_relative.encode("utf-8")) >= 4096
            or baseline_stage_hook_relative not in stage_members
            or source_record is None
            or source_record["origin"] != "source"
            or source_record["kind"] != "file"
            or source_record["links"] != 1
            or source_record["size"] <= 0
            or baseline_stage_hook_relative in sqlite_capture_mains
            or any(
                os.path.lexists(candidate_hook_dir / name)
                for name in (
                    "baseline-leaf-copy-ready",
                    "baseline-leaf-copy-release",
                    "baseline-leaf-copy-complete",
                )
            )
        ):
            raise SystemExit("baseline stage test hook is unsafe")
        baseline_stage_hook_dir = candidate_hook_dir
elif baseline_stage_hook_relative:
    raise SystemExit("baseline stage test hook lacks its phase")
if (
    not baseline_mode
    and stage_hook_phase != "baseline-leaf-copy"
    and bool(stage_hook_phase) != bool(stage_hook_paths_raw)
):
    raise SystemExit("private stage metadata test hook is incomplete")
if (
    stage_hook_phase
    and stage_hook_phase != "baseline-leaf-copy"
    and not baseline_mode
):
    candidate_hook_dir = pathlib.Path(hook_dir_raw)
    candidate_hook_root = pathlib.Path(hook_root_raw)
    raw_paths = stage_hook_paths_raw.split(",")
    if (
        stage_hook_phase != "reconciliation-pre-metadata"
        or not hook_root_raw
        or not hook_dir_raw
        or not candidate_hook_root.is_absolute()
        or os.path.realpath(candidate_hook_root)
            != str(candidate_hook_root)
        or not candidate_hook_dir.is_absolute()
        or os.path.realpath(candidate_hook_dir) != str(candidate_hook_dir)
        or not str(candidate_hook_dir).startswith(
            str(candidate_hook_root) + os.sep
        )
        or not canonical_directory(candidate_hook_root, private=True)
        or not canonical_directory(candidate_hook_dir, private=True)
        or not 1 <= len(raw_paths) <= 3
        or len(raw_paths) != len(set(raw_paths))
    ):
        raise SystemExit("private stage metadata test hook is unsafe")
    selected_kinds = set()
    for relative in raw_paths:
        relative_path = pathlib.PurePosixPath(relative)
        if (
            not relative
            or relative_path.is_absolute()
            or str(relative_path) != relative
            or any(part in {"", ".", ".."} for part in relative_path.parts)
            or "\\" in relative
            or "\0" in relative
            or "\n" in relative
            or len(relative.encode("utf-8")) >= 4096
            or relative not in stage_members
            or relative not in after
            or after[relative]["kind"]
                not in {"file", "directory", "symlink"}
            or relative in sqlite_capture_mains
            or after[relative]["kind"] in selected_kinds
        ):
            raise SystemExit("private stage metadata test member is unsafe")
        kind = after[relative]["kind"]
        selected_kinds.add(kind)
        stage_hook_paths[relative] = kind
        if (
            os.path.lexists(
                candidate_hook_dir / f"stage-xattr-{kind}-ready.json"
            )
            or os.path.lexists(
                candidate_hook_dir / f"stage-xattr-{kind}-release"
            )
        ):
            raise SystemExit("private stage metadata test evidence exists")
    stage_hook_dir = candidate_hook_dir

def invoke_stage_metadata_hook(relative, kind):
    if stage_hook_dir is None or relative not in stage_hook_paths:
        return
    if (
        stage_hook_paths[relative] != kind
        or relative in stage_hook_used
    ):
        raise ValueError("private stage metadata test hook was duplicated")
    destination = target_path(relative)
    observed = os.lstat(destination)
    expected_type = {
        "file": stat.S_ISREG,
        "directory": stat.S_ISDIR,
        "symlink": stat.S_ISLNK,
    }[kind]
    if (
        not expected_type(observed.st_mode)
        or observed.st_dev != stage_device
        or stage_root.parent == stage_root
        or not canonical_directory(stage_root.parent, private=True)
        or target_path(relative) != destination
    ):
        raise ValueError("private stage metadata test target is unsafe")
    document = {
        "schema": "bridgesllm.stage-metadata-test.v1",
        "phase": stage_hook_phase,
        "relative": relative,
        "kind": kind,
        "stageRoot": str(stage_root.parent),
        "stagePath": str(destination),
    }
    stage_hook_used.add(relative)
    write_new(
        stage_hook_dir / f"stage-xattr-{kind}-ready.json",
        (
            json.dumps(
                document,
                sort_keys=True,
                separators=(",", ":"),
            ) + "\n"
        ).encode("utf-8"),
    )
    release = stage_hook_dir / f"stage-xattr-{kind}-release"
    while True:
        assert_time_budget()
        try:
            info = os.lstat(release)
        except FileNotFoundError:
            time.sleep(0.005)
            continue
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
        ):
            raise ValueError(
                "private stage metadata test release is unsafe"
            )
        assert_time_budget()
        return

def invoke_baseline_leaf_hook(relative):
    global baseline_stage_hook_started
    if (
        baseline_stage_hook_dir is None
        or relative != baseline_stage_hook_relative
    ):
        return
    if baseline_stage_hook_started:
        raise ValueError("baseline stage test hook was duplicated")
    baseline_stage_hook_started = True
    write_new(
        baseline_stage_hook_dir / "baseline-leaf-copy-ready",
        b"ready\n",
    )
    release = baseline_stage_hook_dir / "baseline-leaf-copy-release"
    for _ in range(2000):
        assert_time_budget()
        try:
            info = os.lstat(release)
        except FileNotFoundError:
            time.sleep(0.005)
            continue
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
        ):
            raise ValueError("baseline stage test release is unsafe")
        assert_time_budget()
        return
    raise ValueError("baseline stage test hook timed out")

def complete_baseline_leaf_hook(relative):
    global baseline_stage_hook_completed
    if (
        baseline_stage_hook_dir is None
        or relative != baseline_stage_hook_relative
    ):
        return
    if not baseline_stage_hook_started or baseline_stage_hook_completed:
        raise ValueError("baseline stage test completion is contradictory")
    write_new(
        baseline_stage_hook_dir / "baseline-leaf-copy-complete",
        b"complete\n",
    )
    baseline_stage_hook_completed = True

def invoke_copy_hook(relative):
    global hook_used
    if hook_dir is None or hook_used or relative != hook_relative:
        return
    hook_used = True
    write_new(hook_dir / "copy-ready", b"ready\n")
    release = hook_dir / "copy-release"
    for _ in range(1000):
        assert_time_budget()
        if release.is_file() and not release.is_symlink():
            return
        time.sleep(0.005)
    raise ValueError("live reconciliation test hook timed out")

def invoke_sqlite_hook(relative, phase):
    if hook_dir is None or relative != hook_relative:
        return
    if phase not in {
        "sqlite-admission",
        "sqlite-opened",
        "sqlite-backup-step",
        "sqlite-pre-quick-check",
    }:
        raise ValueError("live SQLite test hook phase is invalid")
    if hook_phase_selector and phase != hook_phase_selector:
        return
    # Hard-stall probes are emitted only from the operation's actual progress
    # callback.  A marker here would prove merely that the operation was about
    # to run, not that an uncooperative SQLite call is externally bounded.
    if hard_stall_enabled:
        return
    ready = hook_dir / f"{phase}-ready"
    release = hook_dir / f"{phase}-release"
    write_new(ready, b"ready\n")
    while True:
        assert_time_budget()
        try:
            info = os.lstat(release)
        except FileNotFoundError:
            time.sleep(0.005)
            continue
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
        ):
            raise ValueError("live SQLite test hook release is unsafe")
        assert_time_budget()
        return

def invoke_sqlite_hard_stall(relative, phase, operation):
    if (
        not hard_stall_enabled
        or hook_dir is None
        or relative != hook_relative
        or phase != hook_phase_selector
    ):
        return
    expected_operation = {
        "sqlite-backup-step": "Connection.backup",
        "sqlite-pre-quick-check": "PRAGMA quick_check",
    }.get(phase)
    if expected_operation is None or operation != expected_operation:
        raise ValueError("live SQLite hard-stall operation is invalid")
    # Install TERM resistance before publishing the attestation.  The outer
    # trusted timeout remains the authority that escalates to SIGKILL.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raw_stat = pathlib.Path("/proc/self/stat").read_text(encoding="ascii")
    fields = raw_stat.rsplit(")", 1)[1].split()
    raw_status = pathlib.Path("/proc/self/status").read_text(
        encoding="ascii"
    ).splitlines()
    host_pids = [
        line.partition(":")[2].strip()
        for line in raw_status if line.startswith("Pid:")
    ]
    if len(host_pids) != 1 or not host_pids[0].isdigit():
        raise ValueError("live SQLite host PID is unavailable")
    document = {
        "schema": "bridgesllm.sqlite-hard-stall-test.v1",
        "phase": phase,
        "operation": operation,
        "pid": int(host_pids[0]),
        "namespacePid": os.getpid(),
        "startTimeTicks": int(fields[19]),
        "mountNamespace": os.readlink("/proc/self/ns/mnt"),
    }
    write_new(
        hook_dir / f"{phase}-hard-stall.json",
        json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    while True:
        signal.pause()

def remove_unpublished(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass

capture_records = {}
capture_xattr_bytes = {}

def fingerprint_fields(values):
    fingerprint = hashlib.sha256()
    for value in values:
        encoded = (
            value
            if isinstance(value, bytes)
            else str(value).encode("ascii")
        )
        fingerprint.update(struct.pack(">Q", len(encoded)))
        fingerprint.update(encoded)
    return fingerprint.hexdigest()

def fingerprint_xattrs(xattrs):
    return fingerprint_fields(
        field
        for name, value in xattrs
        for field in (name, value)
    )

def fingerprint_ranges(ranges):
    return fingerprint_fields(
        field
        for start, end in ranges
        for field in (start, end - start)
    )

def content_sha256_from_fd(descriptor, size):
    fingerprint = hashlib.sha256()
    offset = 0
    while offset < size:
        payload = os.pread(
            descriptor,
            min(1024 * 1024, size - offset),
            offset,
        )
        if not payload:
            raise RuntimeError("private stage capture record ended early")
        fingerprint.update(payload)
        offset += len(payload)
    return fingerprint.hexdigest()

def bind_capture_record(
    relative,
    source_record,
    info,
    xattrs,
    ranges=(),
    *,
    content_sha256=None,
    link_text="",
    sqlite_capture=False,
    sqlite_header=False,
):
    kind = stat_kind(info)
    if kind not in {"directory", "file", "symlink"}:
        raise ValueError("private stage capture type is unsafe")
    if kind == "file" and content_sha256 is None:
        raise ValueError("private stage file capture lacks content evidence")
    capture_group = None
    if kind == "file":
        capture_group = (
            f"sqlite:{relative}"
            if sqlite_capture
            else "{}:{}:{}".format(
                source_record["origin"],
                source_record["device"],
                source_record["inode"],
            )
        )
    capture_records[relative] = {
        "schema": "bridgesllm.private-stage-capture.v1",
        "name": source_record["name"],
        "relative": relative,
        "kind": kind,
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mode": stat.S_IMODE(info.st_mode),
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "linkText": link_text,
        "xattrSha256": fingerprint_xattrs(xattrs),
        "sparseSha256": fingerprint_ranges(ranges),
        "contentSha256": (
            content_sha256
            if kind == "file"
            else hashlib.sha256(b"").hexdigest()
        ),
        "sqliteHeader": bool(sqlite_capture or sqlite_header),
        "captureGroup": capture_group,
        "sourceOrigin": source_record["origin"],
        "sourceDevice": source_record["device"],
        "sourceInode": source_record["inode"],
    }
    capture_xattr_bytes[relative] = sum(
        len(name) + len(value) for name, value in xattrs
    )

actual_bytes = 0
max_attempt_used = 1
capture_attempts = 1 if baseline_mode else max_passes

def snapshot_regular(relative, record):
    global actual_bytes, max_attempt_used
    destination = target_path(relative)
    ensure_target_parent(relative)
    if os.path.lexists(destination):
        raise ValueError("live reconciliation overlay member already exists")
    last_error = None
    for attempt in range(1, capture_attempts + 1):
        assert_time_budget()
        max_attempt_used = max(max_attempt_used, attempt)
        descriptor = parent = target_descriptor = None
        try:
            descriptor, parent, _ = open_source(
                relative, os.O_RDONLY, record["origin"]
            )
            before_info = os.fstat(descriptor)
            if identity(before_info) != expected_identity(record):
                raise ValueError("live reconciliation file identity changed")
            projected_bytes = actual_bytes + before_info.st_size
            if not baseline_mode and projected_bytes > max_bytes:
                raise ReconciliationBoundError(
                    "live reconciliation byte bound was exceeded"
                )
            before_xattrs = xattrs_from_fd(descriptor)
            ranges = sparse_ranges(
                descriptor,
                before_info.st_size,
                require_sparse=(before_info.st_size > 0 and before_info.st_blocks * 512 < before_info.st_size),
            )
            target_descriptor = os.open(
                destination,
                os.O_RDWR | os.O_CREAT | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
                0o600,
            )
            os.ftruncate(target_descriptor, before_info.st_size)
            hook_invoked = False
            for data, hole in ranges:
                offset = data
                while offset < hole:
                    assert_time_budget()
                    payload = os.pread(descriptor, min(1024 * 1024, hole - offset), offset)
                    if not payload:
                        raise ValueError("live reconciliation source ended early")
                    view = memoryview(payload)
                    written_offset = offset
                    while view:
                        written = os.pwrite(target_descriptor, view, written_offset)
                        if written <= 0:
                            raise ValueError("live reconciliation target write was short")
                        view = view[written:]
                        written_offset += written
                    offset += len(payload)
                    if not hook_invoked:
                        invoke_baseline_leaf_hook(relative)
                        invoke_copy_hook(relative)
                        hook_invoked = True
            after_info = os.fstat(descriptor)
            after_xattrs = xattrs_from_fd(descriptor)
            after_ranges = sparse_ranges(
                descriptor,
                after_info.st_size,
                require_sparse=(after_info.st_size > 0 and after_info.st_blocks * 512 < after_info.st_size),
            )
            if (
                stable_stat(before_info) != stable_stat(after_info)
                or before_xattrs != after_xattrs
                or ranges != after_ranges
            ):
                raise RuntimeError("live reconciliation file changed during descriptor copy")
            invoke_stage_metadata_hook(relative, "file")
            apply_fd_metadata(target_descriptor, after_info, after_xattrs)
            os.fsync(target_descriptor)
            captured_info = os.fstat(target_descriptor)
            captured_ranges = sparse_ranges(
                target_descriptor,
                captured_info.st_size,
                require_sparse=(
                    captured_info.st_size > 0
                    and captured_info.st_blocks * 512 < captured_info.st_size
                ),
            )
            bind_capture_record(
                relative,
                record,
                captured_info,
                xattrs_from_fd(target_descriptor),
                captured_ranges,
                content_sha256=content_sha256_from_fd(
                    target_descriptor,
                    captured_info.st_size,
                ),
                sqlite_header=(
                    os.pread(descriptor, 16, 0) == b"SQLite format 3\0"
                    or pathlib.PurePosixPath(relative).name.lower().endswith(
                        (".sqlite", ".sqlite3")
                    )
                ),
            )
            complete_baseline_leaf_hook(relative)
            projected_bytes = actual_bytes + after_info.st_size
            if not baseline_mode and projected_bytes > max_bytes:
                raise ReconciliationBoundError(
                    "live reconciliation byte bound was exceeded"
                )
            actual_bytes = projected_bytes
            return
        except (OSError, ValueError, RuntimeError) as error:
            last_error = error
            if target_descriptor is not None:
                os.close(target_descriptor)
                target_descriptor = None
            remove_unpublished(destination)
            if isinstance(error, ReconciliationBoundError) or (
                isinstance(error, ValueError) and "identity changed" in str(error)
            ):
                break
        finally:
            if target_descriptor is not None:
                os.close(target_descriptor)
            if descriptor is not None:
                os.close(descriptor)
            if parent is not None:
                os.close(parent)
    raise ValueError(f"live reconciliation file was not stable: {last_error}")

def snapshot_sqlite(relative, record):
    global actual_bytes, max_attempt_used
    destination = target_path(relative)
    ensure_target_parent(relative)
    if os.path.lexists(destination):
        raise ValueError("live SQLite overlay member already exists")
    last_error = None
    for attempt in range(1, capture_attempts + 1):
        assert_time_budget()
        max_attempt_used = max(max_attempt_used, attempt)
        descriptor = parent = None
        sidecar_descriptors = {}
        sidecar_parents = []
        inode_view = inode_main = None
        inode_mounts = []
        source_connection = destination_connection = None
        try:
            descriptor, parent, name = open_source(
                relative, os.O_RDONLY, record["origin"]
            )
            parent_before = os.fstat(parent)
            before_info = os.fstat(descriptor)
            if identity(before_info) != expected_identity(record) or before_info.st_nlink != 1:
                raise ValueError("live SQLite identity changed")
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar_relative = relative + suffix
                sidecar_record = after.get(sidecar_relative)
                try:
                    sidecar_descriptor, sidecar_parent, _ = open_source(
                        sidecar_relative, os.O_RDONLY, "source"
                    )
                except FileNotFoundError:
                    if sidecar_record is not None:
                        raise ValueError("live SQLite journal identity changed")
                    continue
                sidecar_info = os.fstat(sidecar_descriptor)
                if (
                    sidecar_record is None
                    or identity(sidecar_info) != expected_identity(sidecar_record)
                    or not stat.S_ISREG(sidecar_info.st_mode)
                    or sidecar_info.st_nlink != 1
                ):
                    os.close(sidecar_descriptor)
                    os.close(sidecar_parent)
                    raise ValueError("live SQLite journal identity changed")
                sidecar_descriptors[suffix] = sidecar_descriptor
                sidecar_parents.append(sidecar_parent)
            admitted_suffixes = set(sidecar_descriptors)
            if (
                ("-shm" in admitted_suffixes and "-wal" not in admitted_suffixes)
                or (
                    "-journal" in admitted_suffixes
                    and bool(admitted_suffixes & {"-wal", "-shm"})
                )
            ):
                raise ValueError("live SQLite admitted journal topology is invalid")
            inode_view, inode_main, inode_mounts = create_sqlite_inode_view(
                descriptor,
                sidecar_descriptors,
            )
            connection_timeout = min(30.0, remaining_budget_seconds())
            source_connection = sqlite3.connect(
                inode_main.as_uri() + "?mode=ro",
                uri=True,
                timeout=connection_timeout,
            )
            source_connection.set_progress_handler(sqlite_vm_progress, 1000)
            source_connection.execute("PRAGMA query_only=ON")
            clamp_sqlite_busy_timeout(source_connection)
            # Establish the read transaction before publishing the admission
            # hook.  Later WAL writes or pathname substitution therefore
            # cannot silently enter the admitted SQLite snapshot.
            source_connection.execute("BEGIN")
            source_connection.execute("PRAGMA schema_version").fetchone()
            page_size_row = source_connection.execute(
                "PRAGMA page_size"
            ).fetchone()
            page_count_row = source_connection.execute(
                "PRAGMA page_count"
            ).fetchone()
            if (
                page_size_row is None
                or len(page_size_row) != 1
                or not isinstance(page_size_row[0], int)
                or page_size_row[0] < 512
                or page_size_row[0] > 65536
                or page_size_row[0] & (page_size_row[0] - 1)
                or page_count_row is None
                or len(page_count_row) != 1
                or not isinstance(page_count_row[0], int)
                or page_count_row[0] <= 0
            ):
                raise ValueError("live SQLite page admission is invalid")
            admitted_page_size = page_size_row[0]
            admitted_page_count = page_count_row[0]
            admitted_database_bytes = (
                admitted_page_size * admitted_page_count
            )
            remaining_bytes = max_bytes - actual_bytes
            if (
                not baseline_mode
                and (
                    remaining_bytes <= 0
                    or admitted_database_bytes > remaining_bytes
                )
            ):
                raise ReconciliationBoundError(
                    "live reconciliation byte bound was exceeded"
                )
            admitted_info = os.fstat(descriptor)
            admitted_xattrs = xattrs_from_fd(descriptor)
            if (
                identity(admitted_info) != expected_identity(record)
                or admitted_info.st_uid != record["uid"]
                or admitted_info.st_gid != record["gid"]
                or stat.S_IMODE(admitted_info.st_mode) != record["mode"]
                or admitted_info.st_mtime_ns != record["mtimeNs"]
                or fingerprint_xattrs(admitted_xattrs)
                    != record["xattrSha256"]
            ):
                raise ValueError(
                    "live SQLite metadata changed before admission"
                )
            invoke_sqlite_hook(relative, "sqlite-admission")
            invoke_sqlite_hook(relative, "sqlite-opened")
            target_descriptor = os.open(
                destination,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
                0o600,
            )
            os.close(target_descriptor)
            destination_connection = sqlite3.connect(
                str(destination),
                timeout=min(30.0, remaining_budget_seconds()),
            )
            destination_connection.set_progress_handler(
                sqlite_vm_progress, 1000
            )
            clamp_sqlite_busy_timeout(destination_connection)
            destination_connection.execute(
                f"PRAGMA page_size={admitted_page_size}"
            )
            if destination_connection.execute(
                "PRAGMA page_size"
            ).fetchone() != (admitted_page_size,):
                raise ValueError("live SQLite page size was not admitted")
            if not baseline_mode:
                maximum_pages = remaining_bytes // admitted_page_size
                maximum_page_row = destination_connection.execute(
                    f"PRAGMA max_page_count={maximum_pages}"
                ).fetchone()
                if maximum_page_row != (maximum_pages,):
                    raise ReconciliationBoundError(
                        "live SQLite page bound was not enforced"
                    )
            def backup_progress(_status, _remaining, _total):
                invoke_sqlite_hard_stall(
                    relative,
                    "sqlite-backup-step",
                    "Connection.backup",
                )
                assert_time_budget()

            invoke_sqlite_hook(relative, "sqlite-backup-step")
            try:
                source_connection.backup(
                    destination_connection,
                    pages=1024,
                    progress=backup_progress,
                    sleep=0.05,
                )
            except sqlite3.Error as error:
                error_code = getattr(error, "sqlite_errorcode", None)
                if not baseline_mode and (
                    (
                        isinstance(error_code, int)
                        and error_code & 0xFF
                            == getattr(sqlite3, "SQLITE_FULL", 13)
                    )
                    or "database or disk is full" in str(error).lower()
                ):
                    raise ReconciliationBoundError(
                        "live SQLite snapshot exceeded its admitted page bound"
                    ) from error
                raise
            clamp_sqlite_busy_timeout(destination_connection)
            destination_connection.execute("PRAGMA journal_mode=DELETE")
            destination_connection.commit()
            clamp_sqlite_busy_timeout(destination_connection)
            invoke_sqlite_hook(relative, "sqlite-pre-quick-check")
            def quick_check_progress():
                invoke_sqlite_hard_stall(
                    relative,
                    "sqlite-pre-quick-check",
                    "PRAGMA quick_check",
                )
                assert_time_budget()
                return 0
            destination_connection.set_progress_handler(
                quick_check_progress,
                1,
            )
            try:
                if destination_connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise ValueError("live SQLite snapshot integrity check failed")
            finally:
                destination_connection.set_progress_handler(
                    sqlite_vm_progress,
                    1000,
                )
            assert_sqlite_topology(
                relative,
                record,
                parent,
                parent_before,
                name,
                descriptor,
                sidecar_descriptors,
                inode_view,
            )
            destination_connection.set_progress_handler(None, 0)
            source_connection.set_progress_handler(None, 0)
            destination_connection.close()
            destination_connection = None
            source_connection.close()
            source_connection = None
            cleanup_sqlite_inode_view(inode_view, inode_mounts, strict=True)
            inode_view = inode_main = None
            inode_mounts = []
            after_info = os.fstat(descriptor)
            path_info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            observed_xattrs = xattrs_from_fd(descriptor)
            if (
                identity(after_info) != expected_identity(record)
                or identity(path_info) != expected_identity(record)
                or after_info.st_uid != admitted_info.st_uid
                or after_info.st_gid != admitted_info.st_gid
                or stat.S_IMODE(after_info.st_mode)
                    != stat.S_IMODE(admitted_info.st_mode)
                or after_info.st_mtime_ns != admitted_info.st_mtime_ns
                or observed_xattrs != admitted_xattrs
            ):
                raise ValueError("live SQLite metadata changed after admission")
            target_descriptor = os.open(
                destination,
                os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
            )
            try:
                apply_fd_metadata(
                    target_descriptor,
                    admitted_info,
                    admitted_xattrs,
                )
                os.fsync(target_descriptor)
                captured_info = os.fstat(target_descriptor)
                captured_ranges = sparse_ranges(
                    target_descriptor,
                    captured_info.st_size,
                    require_sparse=(
                        captured_info.st_size > 0
                        and captured_info.st_blocks * 512
                            < captured_info.st_size
                    ),
                )
                bind_capture_record(
                    relative,
                    record,
                    captured_info,
                    xattrs_from_fd(target_descriptor),
                    captured_ranges,
                    content_sha256=content_sha256_from_fd(
                        target_descriptor,
                        captured_info.st_size,
                    ),
                    sqlite_capture=True,
                )
            finally:
                os.close(target_descriptor)
            final_info = os.lstat(destination)
            if (
                not stat.S_ISREG(final_info.st_mode)
                or final_info.st_size <= 0
                or any(
                    os.path.lexists(pathlib.Path(str(destination) + suffix))
                    for suffix in ("-wal", "-shm", "-journal")
                )
            ):
                raise ValueError("live SQLite snapshot did not settle safely")
            projected_bytes = actual_bytes + final_info.st_size
            if not baseline_mode and projected_bytes > max_bytes:
                raise ReconciliationBoundError(
                    "live reconciliation byte bound was exceeded"
                )
            actual_bytes = projected_bytes
            return
        except (OSError, sqlite3.Error, ValueError) as error:
            last_error = error
            if destination_connection is not None:
                destination_connection.close()
                destination_connection = None
            if source_connection is not None:
                source_connection.close()
                source_connection = None
            if inode_view is not None:
                cleanup_sqlite_inode_view(inode_view, inode_mounts, strict=True)
                inode_view = inode_main = None
                inode_mounts = []
            remove_unpublished(destination)
            for suffix in ("-wal", "-shm", "-journal"):
                remove_unpublished(pathlib.Path(str(destination) + suffix))
            if isinstance(error, ReconciliationBoundError) or "identity changed" in str(error):
                break
        finally:
            if destination_connection is not None:
                destination_connection.close()
            if source_connection is not None:
                source_connection.close()
            if inode_view is not None:
                cleanup_sqlite_inode_view(inode_view, inode_mounts, strict=True)
            for held in sidecar_descriptors.values():
                try:
                    os.close(held)
                except OSError:
                    pass
            for held in sidecar_parents:
                try:
                    os.close(held)
                except OSError:
                    pass
            if descriptor is not None:
                os.close(descriptor)
            if parent is not None:
                os.close(parent)
    raise ValueError(f"live SQLite database could not be snapshotted: {last_error}")

def snapshot_symlink(relative, record):
    global max_attempt_used
    destination = target_path(relative)
    ensure_target_parent(relative)
    if os.path.lexists(destination):
        raise ValueError("live symlink overlay member already exists")
    last_error = None
    for attempt in range(1, capture_attempts + 1):
        assert_time_budget()
        max_attempt_used = max(max_attempt_used, attempt)
        descriptor = parent = None
        try:
            descriptor, parent, name = open_source(
                relative,
                getattr(os, "O_PATH", os.O_RDONLY),
                record["origin"],
            )
            before_info = os.fstat(descriptor)
            if identity(before_info) != expected_identity(record):
                raise ValueError("live symlink identity changed")
            link_target, source_xattrs = source_symlink_state(
                parent,
                name,
                descriptor,
            )
            after_info = os.fstat(descriptor)
            if stable_stat(before_info) != stable_stat(after_info):
                raise RuntimeError("live symlink changed during snapshot")
            os.symlink(link_target, destination)
            invoke_stage_metadata_hook(relative, "symlink")
            os.lchown(destination, after_info.st_uid, after_info.st_gid)
            replace_symlink_xattrs(destination, source_xattrs)
            os.utime(
                destination,
                ns=(after_info.st_atime_ns, after_info.st_mtime_ns),
                follow_symlinks=False,
            )
            final_source = os.fstat(descriptor)
            final_target = os.lstat(destination)
            if (
                stable_stat(after_info) != stable_stat(final_source)
                or os.readlink(destination) != link_target
                or final_target.st_uid != after_info.st_uid
                or final_target.st_gid != after_info.st_gid
                or final_target.st_mtime_ns != after_info.st_mtime_ns
                or xattrs_from_symlink(destination) != source_xattrs
            ):
                raise RuntimeError("live symlink changed during snapshot")
            bind_capture_record(
                relative,
                record,
                final_target,
                source_xattrs,
                link_text=link_target,
            )
            return
        except (OSError, ValueError, RuntimeError) as error:
            last_error = error
            remove_unpublished(destination)
            if isinstance(error, ReconciliationBoundError) or (
                isinstance(error, ValueError) and "identity changed" in str(error)
            ):
                break
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if parent is not None:
                os.close(parent)
    raise ValueError(f"live symlink was not stable: {last_error}")

def snapshot_directory_metadata(relative, record):
    global max_attempt_used
    destination = target_path(relative)
    if relative:
        ensure_target_parent(relative)
        created = False
        try:
            destination.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        if created:
            clean_scaffold_directory(destination)
            scaffolded_directories.add(str(destination))
    destination_info = os.lstat(destination)
    if not stat.S_ISDIR(destination_info.st_mode) or stat.S_ISLNK(destination_info.st_mode):
        raise ValueError("live directory overlay member is unsafe")
    last_error = None
    for attempt in range(1, capture_attempts + 1):
        assert_time_budget()
        max_attempt_used = max(max_attempt_used, attempt)
        descriptor = parent = target_descriptor = None
        try:
            descriptor, parent, _ = open_source(
                relative,
                os.O_RDONLY | os.O_DIRECTORY,
                record["origin"],
            )
            before_info = os.fstat(descriptor)
            if identity(before_info) != expected_identity(record):
                raise ValueError("live directory identity changed")
            source_xattrs = xattrs_from_fd(descriptor)
            after_info = os.fstat(descriptor)
            if stable_stat(before_info) != stable_stat(after_info):
                raise RuntimeError("live directory changed during metadata snapshot")
            target_descriptor = os.open(
                destination,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            invoke_stage_metadata_hook(relative, "directory")
            apply_fd_metadata(target_descriptor, after_info, source_xattrs)
            os.fsync(target_descriptor)
            if stable_stat(after_info) != stable_stat(os.fstat(descriptor)):
                raise RuntimeError("live directory changed during metadata snapshot")
            bind_capture_record(
                relative,
                record,
                os.fstat(target_descriptor),
                xattrs_from_fd(target_descriptor),
            )
            return
        except (OSError, ValueError, RuntimeError) as error:
            last_error = error
            if isinstance(error, ReconciliationBoundError) or (
                isinstance(error, ValueError) and "identity changed" in str(error)
            ):
                break
        finally:
            if target_descriptor is not None:
                os.close(target_descriptor)
            if descriptor is not None:
                os.close(descriptor)
            if parent is not None:
                os.close(parent)
    raise ValueError(f"live directory metadata was not stable: {last_error}")

def remove_stage_member(relative, desired_record):
    if not relative:
        if desired_record is None or desired_record["kind"] != "directory":
            raise ValueError("private archive stage root transition is invalid")
        return
    destination = target_path(relative)
    try:
        info = os.lstat(destination)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        if desired_record is not None and desired_record["kind"] == "directory":
            return
        os.rmdir(destination)
        return
    os.unlink(destination)

if not baseline_mode:
    replacement_set = stage_members | omit_members
    for relative in sorted(
        replacement_set,
        key=lambda value: (-len(split_relative(value)), os.fsencode(value)),
    ):
        desired = after.get(relative) if relative in stage_members else None
        remove_stage_member(relative, desired)

baseline_failures = set()

def defer_baseline_failure(paths, error):
    if not baseline_mode:
        raise error
    if any(after[relative]["origin"] != "source" for relative in paths):
        raise error
    baseline_failures.update(paths)
    for relative in sorted(
        paths,
        key=lambda value: (-len(split_relative(value)), os.fsencode(value)),
    ):
        capture_records.pop(relative, None)
        capture_xattr_bytes.pop(relative, None)
        if not relative:
            continue
        destination = target_path(relative)
        try:
            info = os.lstat(destination)
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            os.unlink(destination)

try:
    regular_groups = []
    for paths in hardlink_groups.values():
        selected = sorted(stage_members.intersection(paths), key=os.fsencode)
        if selected:
            regular_groups.append(selected)
    regular_groups.sort(key=lambda values: os.fsencode(values[0]))
    emitted_regular = set()
    ordered_stage = []
    for paths in regular_groups:
        try:
            canonical = paths[0]
            record = after[canonical]
            if canonical in sqlite_capture_mains:
                snapshot_sqlite(canonical, record)
            else:
                snapshot_regular(canonical, record)
            emitted_regular.add(canonical)
            ordered_stage.append(canonical)
            for relative in paths[1:]:
                ensure_target_parent(relative)
                destination = target_path(relative)
                if os.path.lexists(destination):
                    raise ValueError("private stage hard-link member already exists")
                os.link(target_path(canonical), destination, follow_symlinks=False)
                capture = dict(capture_records[canonical])
                capture.update({
                    "name": after[relative]["name"],
                    "relative": relative,
                    "sourceOrigin": after[relative]["origin"],
                    "sourceDevice": after[relative]["device"],
                    "sourceInode": after[relative]["inode"],
                })
                capture_records[relative] = capture
                capture_xattr_bytes[relative] = capture_xattr_bytes[canonical]
                emitted_regular.add(relative)
                ordered_stage.append(relative)
                if not baseline_mode:
                    add_event(relative, "hardlink-snapshot")
        except (OSError, ValueError, RuntimeError) as error:
            defer_baseline_failure(paths, error)
    for relative in sorted(stage_members, key=os.fsencode):
        record = after[relative]
        if record["kind"] == "file" and relative not in emitted_regular:
            try:
                if relative in sqlite_capture_mains:
                    snapshot_sqlite(relative, record)
                else:
                    snapshot_regular(relative, record)
                emitted_regular.add(relative)
                ordered_stage.append(relative)
            except (OSError, ValueError, RuntimeError) as error:
                defer_baseline_failure((relative,), error)
    for relative in sorted(stage_members, key=os.fsencode):
        if after[relative]["kind"] != "symlink":
            continue
        try:
            snapshot_symlink(relative, after[relative])
            ordered_stage.append(relative)
        except (OSError, ValueError, RuntimeError) as error:
            defer_baseline_failure((relative,), error)
    directories = sorted(
        (
            relative for relative in stage_members
            if after[relative]["kind"] == "directory"
        ),
        key=lambda value: (-len(split_relative(value)), os.fsencode(value)),
    )
    captured_directories = []
    for relative in directories:
        try:
            snapshot_directory_metadata(relative, after[relative])
            captured_directories.append(relative)
        except (OSError, ValueError, RuntimeError) as error:
            defer_baseline_failure((relative,), error)
    # Directories are placed before their children in the evidence list;
    # --no-recursion keeps the eventual tar inventory authoritative.
    ordered_stage = sorted(
        captured_directories,
        key=lambda value: (len(split_relative(value)), os.fsencode(value)),
    ) + ordered_stage
    if len(ordered_stage) != len(set(ordered_stage)):
        raise ValueError("private archive stage inventory is duplicated")
    if not baseline_mode and set(ordered_stage) != stage_members:
        raise ValueError("private archive stage inventory is contradictory")
    if set(capture_records) != set(ordered_stage):
        raise ValueError("private stage capture evidence is incomplete")
    if (
        set(capture_xattr_bytes) != set(ordered_stage)
        or sum(capture_xattr_bytes.values()) > xattr_max_bytes
    ):
        raise ValueError("private stage xattr evidence is unbounded")
    if (
        stage_hook_dir is not None
        and stage_hook_used != set(stage_hook_paths)
    ):
        raise ValueError("private stage metadata test hook was not exercised")
    if baseline_stage_hook_dir is not None and not (
        baseline_stage_hook_started and baseline_stage_hook_completed
    ):
        raise ValueError("baseline stage test hook was not exercised")

    if baseline_mode:
        metadata = b""
    else:
        event_list = [
            events[relative] for relative in sorted(events, key=os.fsencode)
        ]
        document = {
            "schema": "bridgesllm.live-member-reconciliation.v1",
            "passes": max_attempt_used,
            "memberCount": len(event_list),
            "logicalBytes": actual_bytes,
            "members": event_list,
        }
        metadata = json.dumps(
            document, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if len(metadata) > max_metadata_bytes:
            raise ValueError("live reconciliation metadata bound was exceeded")
    encode_relative = lambda value: (value or ".").encode("utf-8") + b"\0"
    write_new(
        stage_list_path,
        b"".join(encode_relative(value) for value in ordered_stage),
    )
    write_new(
        omit_list_path,
        b"".join(
            encode_relative(value)
            for value in sorted(omit_members, key=os.fsencode)
        ),
    )
    write_new(
        allowed_list_path,
        b"".join(
            encode_relative(value)
            for value in sorted(allowed_members, key=os.fsencode)
        ),
    )
    write_new(metadata_path, metadata)
    capture_descriptor = os.open(
        capture_records_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        0o600,
    )
    try:
        capture_bytes = 0
        for relative in sorted(capture_records, key=os.fsencode):
            payload = (
                json.dumps(
                    capture_records[relative],
                    sort_keys=True,
                    separators=(",", ":"),
                ) + "\n"
            ).encode("utf-8")
            if len(payload) > 32768:
                raise ValueError("private stage capture record is unbounded")
            capture_bytes += len(payload)
            if capture_bytes > 1024 * 1024 * 1024:
                raise ValueError("private stage capture evidence is unbounded")
            view = memoryview(payload)
            while view:
                written = os.write(capture_descriptor, view)
                if written <= 0:
                    raise OSError("private stage capture evidence write was short")
                view = view[written:]
        os.fsync(capture_descriptor)
    finally:
        os.close(capture_descriptor)
    if baseline_mode:
        write_new(
            unstable_path,
            b"".join(
                encode_relative(value)
                for value in sorted(baseline_failures, key=os.fsencode)
            ),
        )
finally:
    for descriptor in root_descriptors.values():
        os.close(descriptor)
PY
  if [[ "$mode" == "reconcile" \
    && ( "$worker_status" -eq 124 || "$worker_status" -eq 137 ) ]]; then
    printf '%s\n' 'live reconciliation hard deadline was exceeded' >&2
    return 1
  fi
  return "$worker_status"
}

assert_live_reconciliation_scope() {
  local admitted_records="$1"
  local observed_records="$2"
  local allowed_list="$3"
  local observed_unstable="$4"
  python3 - "$admitted_records" "$observed_records" "$allowed_list" \
    "$observed_unstable" <<'PY'
import json
import pathlib
import sys

def inventory_records(path):
    result = {}
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            origin = record.get("origin")
            relative = record.get("relative")
            identity = (origin, relative)
            if (
                origin not in {"source", "overlay"}
                or not isinstance(relative, str)
                or identity in result
            ):
                raise ValueError("invalid live reconciliation inventory")
            result[identity] = record
    return result

raw = pathlib.Path(sys.argv[3]).read_bytes()
if raw and not raw.endswith(b"\0"):
    raise SystemExit(1)
allowed = {
    "" if value == b"." else value.decode("utf-8")
    for value in (raw[:-1].split(b"\0") if raw else [])
}
unstable_raw = pathlib.Path(sys.argv[4]).read_bytes()
if unstable_raw and not unstable_raw.endswith(b"\0"):
    raise SystemExit(1)
unstable = {
    "" if value == b"." else value.decode("utf-8")
    for value in (
        unstable_raw[:-1].split(b"\0") if unstable_raw else []
    )
}
if not unstable.issubset(allowed):
    raise SystemExit(1)
before = inventory_records(sys.argv[1])
after = inventory_records(sys.argv[2])
# An unstable directory cannot be scoped safely by admitting that directory
# merely as an ancestor metadata update: a child can appear after enumeration
# and before the final directory stat without ever entering the member list.
# Reject every observed directory instability, and reject an unstable member
# whose type cannot be established from either admitted inventory.
for relative in unstable:
    known = [
        record
        for record in (
            before.get(("source", relative)),
            after.get(("source", relative)),
        )
        if record is not None
    ]
    if not known or any(record.get("kind") == "directory" for record in known):
        raise SystemExit(1)
changed = {
    identity
    for identity in set(before) | set(after)
    if before.get(identity) != after.get(identity)
}
if any(
    origin != "source" or relative not in allowed
    for origin, relative in changed
):
    raise SystemExit(1)
PY
}

assert_private_stage_matches_admitted_inventory() {
  local admitted_records="$1"
  local staged_records="$2"
  local live_mode="$3"
  local baseline_capture_records="$4"
  local reconciliation_capture_records="$5"
  python3 - "$admitted_records" "$staged_records" "$live_mode" \
    "$baseline_capture_records" "$reconciliation_capture_records" <<'PY'
import json
import os
import pathlib
import sys

admitted_path = pathlib.Path(sys.argv[1])
staged_path = pathlib.Path(sys.argv[2])
live_mode = sys.argv[3]
if live_mode not in {"true", "false"}:
    raise SystemExit(1)
live_mode = live_mode == "true"
baseline_capture_path = pathlib.Path(sys.argv[4])
reconciliation_capture_path = pathlib.Path(sys.argv[5])

def load_records(path, *, composed):
    result = {}
    total = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            total += len(line.encode("utf-8"))
            if (
                not line.endswith("\n")
                or len(line.encode("utf-8")) > 32768
                or total > 1024 * 1024 * 1024
            ):
                raise ValueError("private stage evidence is unbounded")
            record = json.loads(line)
            relative = record.get("relative")
            origin = record.get("origin")
            if (
                not isinstance(record, dict)
                or not isinstance(relative, str)
                or origin not in {"source", "overlay"}
                or relative in result
                or (not composed and origin != "source")
            ):
                raise ValueError("private stage evidence is contradictory")
            result[relative] = record
    if not result or len(result) > 1_000_000:
        raise ValueError("private stage evidence is empty or unbounded")
    return result

try:
    admitted = load_records(admitted_path, composed=True)
    staged = load_records(staged_path, composed=False)
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)

capture_keys = {
    "schema", "name", "relative", "kind", "uid", "gid", "mode",
    "size", "mtimeNs", "linkText", "xattrSha256", "sparseSha256",
    "contentSha256", "sqliteHeader", "captureGroup", "sourceOrigin",
    "sourceDevice", "sourceInode",
}

def load_captures(path):
    result = {}
    total = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            encoded = line.encode("utf-8")
            total += len(encoded)
            if (
                not line.endswith("\n")
                or len(encoded) > 32768
                or total > 1024 * 1024 * 1024
            ):
                raise ValueError("private stage capture evidence is unbounded")
            record = json.loads(line)
            relative = record.get("relative")
            kind = record.get("kind")
            capture_group = record.get("captureGroup")
            if (
                not isinstance(record, dict)
                or set(record) != capture_keys
                or record.get("schema")
                    != "bridgesllm.private-stage-capture.v1"
                or not isinstance(relative, str)
                or relative in result
                or kind not in {"directory", "file", "symlink"}
                or record.get("sourceOrigin") not in {"source", "overlay"}
                or any(
                    not isinstance(record.get(key), int)
                    or isinstance(record.get(key), bool)
                    or record[key] < 0
                    for key in (
                        "uid", "gid", "mode", "size", "mtimeNs",
                        "sourceDevice", "sourceInode",
                    )
                )
                or not isinstance(record.get("linkText"), str)
                or not isinstance(record.get("sqliteHeader"), bool)
                or any(
                    not isinstance(record.get(key), str)
                    or len(record[key]) != 64
                    or any(
                        character not in "0123456789abcdef"
                        for character in record[key]
                    )
                    for key in (
                        "xattrSha256", "sparseSha256", "contentSha256"
                    )
                )
                or (
                    kind == "file"
                    and (
                        not isinstance(capture_group, str)
                        or not capture_group
                    )
                )
                or (kind != "file" and capture_group is not None)
            ):
                raise ValueError("private stage capture evidence is invalid")
            result[relative] = record
    return result

try:
    baseline_captures = load_captures(baseline_capture_path)
    reconciliation_captures = (
        load_captures(reconciliation_capture_path) if live_mode else {}
    )
except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
if not live_mode and os.path.lexists(reconciliation_capture_path):
    raise SystemExit(1)

sqlite_mains = {
    relative
    for relative, record in admitted.items()
    if (
        live_mode
        and record.get("origin") == "source"
        and record.get("kind") == "file"
        and record.get("sqliteHeader") is True
    )
}
excluded_sidecars = {
    main + suffix
    for main in sqlite_mains
    for suffix in ("-wal", "-shm", "-journal")
    if (
        main + suffix in admitted
        and admitted[main + suffix].get("origin") == "source"
    )
}
expected_relatives = set(admitted) - excluded_sidecars
if set(staged) != expected_relatives:
    raise SystemExit(1)

captures = {}
for relative in expected_relatives:
    capture = reconciliation_captures.get(
        relative,
        baseline_captures.get(relative),
    )
    if capture is None:
        raise SystemExit(1)
    captures[relative] = capture

common_fields = (
    "name", "kind", "uid", "gid", "mode", "mtimeNs",
    "linkText", "xattrSha256", "sqliteHeader",
)
for relative in sorted(expected_relatives):
    expected = captures[relative]
    actual = staged[relative]
    if any(actual.get(field) != expected.get(field) for field in common_fields):
        raise SystemExit(1)
    if expected.get("kind") == "file" and any(
        actual.get(field) != expected.get(field)
        for field in ("size", "sparseSha256", "contentSha256")
    ):
        raise SystemExit(1)
    admitted_record = admitted[relative]
    if (
        expected.get("sourceOrigin") != admitted_record.get("origin")
        or expected.get("sourceDevice") != admitted_record.get("device")
        or expected.get("sourceInode") != admitted_record.get("inode")
    ):
        raise SystemExit(1)

def capture_partitions(records, relatives):
    groups = {}
    for relative in relatives:
        record = records[relative]
        if record.get("kind") != "file":
            continue
        groups.setdefault(record.get("captureGroup"), []).append(relative)
    return sorted(tuple(sorted(paths)) for paths in groups.values())

def staged_partitions(records, relatives):
    groups = {}
    for relative in relatives:
        record = records[relative]
        if record.get("kind") == "file":
            groups.setdefault(
                (record.get("device"), record.get("inode")),
                [],
            ).append(relative)
    return sorted(tuple(sorted(paths)) for paths in groups.values())

if capture_partitions(captures, expected_relatives) != staged_partitions(
    staged,
    expected_relatives,
):
    raise SystemExit(1)
PY
}

assert_archive_matches_source_inventory() {
  local archive="$1"
  local list_file="$2"
  local digest_file="$3"
  local records_file="$4"
  python3 - "$archive" "$list_file" "$digest_file" "$records_file" <<'PY'
import decimal
import hashlib
import json
import pathlib
import re
import struct
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
raw = pathlib.Path(sys.argv[2]).read_bytes()
digest_lines = pathlib.Path(sys.argv[3]).read_text(
    encoding="ascii"
).splitlines()
records_path = pathlib.Path(sys.argv[4])
if not raw or not raw.endswith(b"\0"):
    raise SystemExit(1)
if (
    len(digest_lines) != 2
    or any(not re.fullmatch(r"[a-f0-9]{64}", line) for line in digest_lines)
):
    raise SystemExit(1)
try:
    expected = [value.decode("utf-8") for value in raw[:-1].split(b"\0")]
except UnicodeDecodeError:
    raise SystemExit(1)
if len(expected) != len(set(expected)) or len(expected) > 1_000_000:
    raise SystemExit(1)
expected_content = {}
with records_path.open("r", encoding="utf-8") as records_handle:
    for line in records_handle:
        record = json.loads(line)
        name = record.get("name")
        content_sha256 = record.get("contentSha256")
        if (
            not isinstance(name, str)
            or name in expected_content
            or not isinstance(content_sha256, str)
            or re.fullmatch(r"[a-f0-9]{64}", content_sha256) is None
        ):
            raise SystemExit(1)
        expected_content[name] = content_sha256
if set(expected_content) != set(expected):
    raise SystemExit(1)

def exact_mtime_ns(member):
    raw_value = member.pax_headers.get("mtime")
    if raw_value is None:
        if (
            not isinstance(member.mtime, int)
            or isinstance(member.mtime, bool)
            or abs(member.mtime) > 10**12
        ):
            raise ValueError("inexact archive mtime")
        return member.mtime * 1_000_000_000
    if not isinstance(raw_value, str) or not re.fullmatch(
        r"-?[0-9]{1,12}(?:\.[0-9]{1,9})?",
        raw_value,
    ):
        raise ValueError("invalid archive mtime")
    value = decimal.Decimal(raw_value) * decimal.Decimal(1_000_000_000)
    if value != value.to_integral_value() or abs(value) > 10**21:
        raise ValueError("invalid archive mtime")
    return int(value)

def decode_xattr_name(value):
    encoded = value.encode("utf-8", "surrogateescape")
    decoded = bytearray()
    offset = 0
    while offset < len(encoded):
        token = encoded[offset:offset + 3]
        if token == b"%3D":
            decoded.append(ord("="))
            offset += 3
        elif token == b"%25":
            decoded.append(ord("%"))
            offset += 3
        else:
            decoded.append(encoded[offset])
            offset += 1
    return bytes(decoded)

def xattrs(member):
    values = {}
    for key, raw_value in member.pax_headers.items():
        if not key.startswith("SCHILY.xattr."):
            continue
        name = decode_xattr_name(key.removeprefix("SCHILY.xattr."))
        value = raw_value.encode("utf-8", "surrogateescape")
        if name in values:
            raise ValueError("duplicate archive xattr")
        values[name] = value
    rht = member.pax_headers.get("RHT.security.selinux")
    if rht is not None:
        text = rht.encode("utf-8", "surrogateescape")
        if (
            not text
            or len(text) > 4095
            or b"\0" in text
            or any(byte < 32 or byte > 126 for byte in text)
            or text.count(b":") < 2
        ):
            raise ValueError("invalid archive SELinux context")
        canonical = text + b"\0"
        if (
            b"security.selinux" in values
            and values[b"security.selinux"] != canonical
        ):
            raise ValueError("contradictory archive SELinux context")
        values[b"security.selinux"] = canonical
    return tuple(sorted(values.items()))

contract = hashlib.sha256()
def add_field(value):
    if isinstance(value, str):
        encoded = value.encode("utf-8")
    elif isinstance(value, bytes):
        encoded = value
    else:
        encoded = str(value).encode("ascii")
    contract.update(struct.pack(">Q", len(encoded)))
    contract.update(encoded)

with tarfile.open(archive, mode="r:gz") as handle:
    actual = []
    archived_content = {}
    for member in handle:
        name = member.name.rstrip("/")
        if not name:
            raise SystemExit(1)
        actual.append(name)
        if member.isfile():
            kind = "file"
        elif member.isdir():
            kind = "directory"
        elif member.issym():
            kind = "symlink"
        elif member.islnk():
            kind = "hardlink"
        else:
            raise SystemExit(1)
        link = (
            member.linkname.encode("utf-8")
            if kind in {"symlink", "hardlink"}
            else b""
        )
        metadata_xattrs = () if kind == "hardlink" else xattrs(member)
        if kind == "file":
            extracted = handle.extractfile(member)
            if extracted is None:
                raise SystemExit(1)
            content = hashlib.sha256()
            total = 0
            while True:
                payload = extracted.read(1024 * 1024)
                if not payload:
                    break
                total += len(payload)
                if total > member.size:
                    raise SystemExit(1)
                content.update(payload)
            if total != member.size:
                raise SystemExit(1)
            content_sha256 = content.hexdigest()
            archived_content[name] = content_sha256
        elif kind == "hardlink":
            content_sha256 = archived_content.get(member.linkname)
            if content_sha256 is None:
                raise SystemExit(1)
            archived_content[name] = content_sha256
        else:
            content_sha256 = hashlib.sha256(b"").hexdigest()
        if content_sha256 != expected_content.get(name):
            raise SystemExit(1)
        for value in (
            name,
            kind,
            member.uid,
            member.gid,
            member.mode & 0o7777,
            member.size if kind == "file" else 0,
            exact_mtime_ns(member),
            link,
        ):
            add_field(value)
        for xattr_name, xattr_value in metadata_xattrs:
            add_field(xattr_name)
            add_field(xattr_value)
        add_field("xattr-end")
        add_field(1 if member.sparse is not None else 0)
        add_field(content_sha256)
if actual != expected:
    raise SystemExit(1)
if contract.hexdigest() != digest_lines[1]:
    raise SystemExit(1)
PY
}

materialize_archive_list_without_overlay() {
  local full_list="$1"
  local source_list="$2"
  shift 2
  python3 - "$full_list" "$source_list" "$@" <<'PY'
import os
import pathlib
import sys

full_path = pathlib.Path(sys.argv[1])
source_path = pathlib.Path(sys.argv[2])
expected = [value.encode("utf-8") for value in sys.argv[3:]]
raw = full_path.read_bytes()
if not raw or not raw.endswith(b"\0"):
    raise SystemExit(1)
members = raw[:-1].split(b"\0")
if (
    not expected
    or len(members) < len(expected)
    or members[-len(expected):] != expected
    or len(members) != len(set(members))
):
    raise SystemExit(1)
descriptor = os.open(
    source_path,
    os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
try:
    source_members = members[:-len(expected)]
    payload = b"\0".join(source_members) + (b"\0" if source_members else b"")
    if os.write(descriptor, payload) != len(payload):
        raise SystemExit(1)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

materialize_archive_list_without_live_sqlite() {
  local records_file="$1"
  local input_list="$2"
  local output_list="$3"
  python3 - "$records_file" "$input_list" "$output_list" <<'PY'
import json
import os
import pathlib
import sys

records_path, input_raw, output_raw = sys.argv[1:]
input_path = pathlib.Path(input_raw)
output_path = pathlib.Path(output_raw)
raw = input_path.read_bytes()
if raw and not raw.endswith(b"\0"):
    raise SystemExit(1)
members = raw[:-1].split(b"\0") if raw else []
sqlite_relatives = set()
source_names = {}
with open(records_path, "r", encoding="utf-8") as handle:
    for line in handle:
        record = json.loads(line)
        if record.get("origin") != "source":
            continue
        relative = record.get("relative")
        name = record.get("name")
        if not isinstance(relative, str) or not isinstance(name, str):
            raise SystemExit(1)
        source_names[relative] = name.encode("utf-8")
        if record.get("kind") == "file" and record.get("sqliteHeader") is True:
            sqlite_relatives.add(relative)
excluded = set()
for relative in sqlite_relatives:
    for candidate in (
        relative,
        relative + "-wal",
        relative + "-shm",
        relative + "-journal",
    ):
        if candidate in source_names:
            excluded.add(source_names[candidate])
filtered = [member for member in members if member not in excluded]
descriptor = os.open(
    output_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    payload = b"\0".join(filtered) + (b"\0" if filtered else b"")
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

collect_archive_diagnostics() {
  local diagnostics="$1"
  local maximum_bytes="$2"
  python3 /dev/fd/3 "${diagnostics}" "${maximum_bytes}" 3<<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
maximum = int(sys.argv[2])
marker = b"\n[archive diagnostics exceeded the configured byte bound]\n"
if (
    not path.is_absolute()
    or os.path.normpath(path) != str(path)
    or maximum < 4096
    or maximum > 16 * 1024**2
    or len(marker) >= maximum
):
    raise SystemExit(1)
descriptor = os.open(
    path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0),
    0o600,
)
initial = os.fstat(descriptor)
overflow = False
retained = 0
payload_limit = maximum - len(marker)
try:
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        available = payload_limit - retained
        if available > 0:
            view = memoryview(chunk[:available])
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("archive diagnostics write was short")
                retained += written
                view = view[written:]
        if len(chunk) > max(0, available):
            overflow = True
    if overflow:
        view = memoryview(marker)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("archive diagnostics marker write was short")
            view = view[written:]
    os.fsync(descriptor)
    settled = os.fstat(descriptor)
    named = os.lstat(path)
    if (
        not stat.S_ISREG(settled.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or settled.st_uid != 0
        or settled.st_gid != 0
        or settled.st_nlink != 1
        or stat.S_IMODE(settled.st_mode) != 0o600
        or (settled.st_dev, settled.st_ino)
            != (initial.st_dev, initial.st_ino)
        or (named.st_dev, named.st_ino)
            != (initial.st_dev, initial.st_ino)
        or settled.st_size > maximum
    ):
        raise OSError("archive diagnostics inode changed")
finally:
    os.close(descriptor)
if overflow:
    raise SystemExit(125)
PY
}

run_archive_diagnostic_command() {
  local diagnostics="$1"
  local mode="$2"
  shift 2
  [[ "${diagnostics}" == /* && $# -gt 0 \
    && "${ARCHIVE_DIAGNOSTICS_MAX_BYTES}" =~ ^[1-9][0-9]*$ \
    && "${mode}" =~ ^(stderr|combined)$ ]] || return 125
  local diagnostics_pipe="${diagnostics}.pipe"
  rm -f -- "${diagnostics}" "${diagnostics_pipe}" || return 125
  mkfifo -m 600 -- "${diagnostics_pipe}" || return 125
  local command_status=0 collector_pid="" collector_status=0
  collect_archive_diagnostics \
    "${diagnostics}" "${ARCHIVE_DIAGNOSTICS_MAX_BYTES}" \
    < "${diagnostics_pipe}" &
  collector_pid="$!"
  if [[ "${mode}" == "stderr" ]]; then
    "$@" 2> "${diagnostics_pipe}" || command_status=$?
  else
    "$@" > "${diagnostics_pipe}" 2>&1 || command_status=$?
  fi
  [[ "${collector_pid}" =~ ^[1-9][0-9]*$ ]] || return 125
  wait "${collector_pid}" || collector_status=$?
  rm -f -- "${diagnostics_pipe}" || return 125
  (( collector_status == 0 )) || return 125
  return "${command_status}"
}

record_archive_failure() {
  local summary="$1"
  local diagnostics="${2:-}"
  local excerpt=""
  if [[ -n "${diagnostics}" && -f "${diagnostics}" && ! -L "${diagnostics}" ]]; then
    excerpt="$(python3 - "${diagnostics}" <<'PY' 2>/dev/null || true
import os
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
    or info.st_mode & 0o022
):
    raise SystemExit(1)
descriptor = os.open(
    path,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
)
try:
    payload = os.read(descriptor, 4097)
finally:
    os.close(descriptor)
payload = payload[:4096]
text = payload.decode("utf-8", errors="replace")
text = " ".join(text.split())
if text:
    print(text)
PY
)"
  fi
  ARCHIVE_FAILURE_DETAIL="${summary}"
  [[ -z "${excerpt}" ]] || ARCHIVE_FAILURE_DETAIL="${ARCHIVE_FAILURE_DETAIL}: ${excerpt}"
  ARCHIVE_FAILURE_DETAIL="$(
    printf '%s' "${ARCHIVE_FAILURE_DETAIL}" | sanitize_status_detail 2>/dev/null \
      || printf '%s' 'Recovery component archive failed without a diagnostic detail'
  )"
  log "WARNING: ${ARCHIVE_FAILURE_DETAIL}"
}

archive_reconciliation_test_pause() {
  local phase="$1"
  local hook_dir="${BRIDGESLLM_BACKUP_RECONCILIATION_TEST_HOOK_DIR:-}"
  local source_dir="${2:-}"
  local digest_file="${3:-}"
  [[ -n "${hook_dir}" ]] || return 0
  if [[ "${phase}" == "post-attestation" \
    && "${BRIDGESLLM_BACKUP_ARCHIVE_TEST_PHASE:-}" != "${phase}" ]]; then
    return 0
  fi
  python3 - "${BRIDGESLLM_BACKUP_TEST_ROOT:-}" "${hook_dir}" \
    "${phase}" "${source_dir}" "${digest_file}" <<'PY'
import json
import os
import pathlib
import stat
import sys
import time

root = pathlib.Path(sys.argv[1])
hook = pathlib.Path(sys.argv[2])
phase = sys.argv[3]
source_raw = sys.argv[4]
digest_raw = sys.argv[5]
if phase not in {"post-capture", "post-attestation"}:
    raise SystemExit(1)
for path in (root, hook):
    info = os.lstat(path)
    if (
        not path.is_absolute()
        or os.path.realpath(path) != str(path)
        or not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise SystemExit(1)
if hook == root or not str(hook).startswith(str(root) + os.sep):
    raise SystemExit(1)
ready = hook / f"{phase}-ready"
release = hook / f"{phase}-release"
if phase == "post-attestation":
    source = pathlib.Path(source_raw)
    digest = pathlib.Path(digest_raw)
    if (
        not source.is_absolute()
        or os.path.realpath(source) != str(source)
        or source == root
        or not str(source).startswith(str(root) + os.sep)
        or not digest.is_absolute()
    ):
        raise SystemExit(1)
    source_info = os.lstat(source)
    digest_info = os.lstat(digest)
    if (
        not stat.S_ISDIR(source_info.st_mode)
        or stat.S_ISLNK(source_info.st_mode)
        or not stat.S_ISREG(digest_info.st_mode)
        or stat.S_ISLNK(digest_info.st_mode)
        or digest_info.st_uid != 0
        or digest_info.st_gid != 0
        or digest_info.st_nlink != 1
        or digest_info.st_mode & 0o022
        or digest_info.st_size > 256
    ):
        raise SystemExit(1)
    digest_descriptor = os.open(
        digest,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    )
    try:
        payload = os.read(digest_descriptor, 257)
        if os.read(digest_descriptor, 1):
            raise SystemExit(1)
    finally:
        os.close(digest_descriptor)
    try:
        digests = payload.decode("ascii").splitlines()
    except UnicodeDecodeError:
        raise SystemExit(1)
    if (
        len(digests) != 2
        or any(
            len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
            for value in digests
        )
    ):
        raise SystemExit(1)
    ready = hook / f"{phase}-ready.json"
    ready_payload = (
        json.dumps(
            {
                "schema": "bridgesllm.archive-phase-test.v1",
                "phase": phase,
                "sourceRoot": str(source),
                "inventorySha256": digests[0],
                "archiveContractSha256": digests[1],
            },
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
    ).encode("utf-8")
else:
    if source_raw or digest_raw:
        raise SystemExit(1)
    ready_payload = b"ready\n"
descriptor = os.open(
    ready,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    view = memoryview(ready_payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
for _ in range(1000):
    if release.is_file() and not release.is_symlink():
        raise SystemExit(0)
    time.sleep(0.005)
raise SystemExit(1)
PY
}

merge_archive_unstable_evidence() {
  local target="$1"
  local maximum="$2"
  shift 2
  python3 - "$target" "$maximum" "$@" <<'PY'
import os
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
maximum = int(sys.argv[2])
if maximum < 1 or maximum > 512 or os.path.lexists(target):
    raise SystemExit(1)
values = set()
for raw_path in sys.argv[3:]:
    path = pathlib.Path(raw_path)
    raw = path.read_bytes()
    if raw and not raw.endswith(b"\0"):
        raise SystemExit(1)
    for encoded in (raw[:-1].split(b"\0") if raw else []):
        relative = "" if encoded == b"." else encoded.decode("utf-8")
        if (
            relative.startswith("/")
            or "\\" in relative
            or "\0" in relative
            or "\n" in relative
            or (
                relative
                and any(part in {"", ".", ".."} for part in relative.split("/"))
            )
        ):
            raise SystemExit(1)
        values.add(relative)
        if len(values) > maximum:
            raise SystemExit(1)
payload = b"".join(
    (value or ".").encode("utf-8") + b"\0"
    for value in sorted(values, key=os.fsencode)
)
descriptor = os.open(
    target,
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
PY
}

cleanup_private_archive_work() {
  local stage_parent="$1"
  local target_parent="$2"
  shift 2
  local cleanup_status=0
  rm -f -- "$@" || cleanup_status=1
  if [[ -n "${stage_parent}" ]]; then
    if [[ "${stage_parent}" != "${target_parent}"/.private-archive-stage.* \
      || ! -d "${stage_parent}" || -L "${stage_parent}" ]]; then
      cleanup_status=1
    elif ! rm -rf -- "${stage_parent}"; then
      cleanup_status=1
    fi
  fi
  if (( cleanup_status != 0 )); then
    ARCHIVE_CLEANUP_FAILED=true
    local original_detail="${ARCHIVE_FAILURE_DETAIL:-Recovery component archive failed}"
    ARCHIVE_FAILURE_DETAIL="$(
      printf '%s' \
        "${original_detail}; private archive cleanup also failed closed" \
        | sanitize_status_detail 2>/dev/null \
        || printf '%s' 'Recovery component archive and cleanup both failed closed'
    )"
    log "WARNING: ${ARCHIVE_FAILURE_DETAIL}"
    return 1
  fi
  return 0
}

read_live_reconciliation_budget_record() {
  local metadata_file="$1"
  local remaining_members="$2"
  local remaining_bytes="$3"
  [[ "$metadata_file" == /* \
    && "$remaining_members" =~ ^[0-9]+$ \
    && "$remaining_bytes" =~ ^[0-9]+$ \
    && "$remaining_members" -le "$LIVE_RECONCILIATION_MAX_MEMBERS" \
    && "$remaining_bytes" -le "$LIVE_RECONCILIATION_MAX_BYTES" ]] \
    || return 1
  python3 - "$metadata_file" "$remaining_members" "$remaining_bytes" \
    "$LIVE_RECONCILIATION_MAX_MEMBERS" \
    "$LIVE_RECONCILIATION_MAX_BYTES" \
    "$LIVE_RECONCILIATION_MAX_PASSES" \
    "$LIVE_RECONCILIATION_MAX_METADATA_BYTES" <<'PY'
import json
import os
import stat
import sys

path = sys.argv[1]
remaining_members = int(sys.argv[2])
remaining_bytes = int(sys.argv[3])
max_members = int(sys.argv[4])
max_bytes = int(sys.argv[5])
max_passes = int(sys.argv[6])
max_metadata_bytes = int(sys.argv[7])
if (
    not os.path.isabs(path)
    or not 0 <= remaining_members <= max_members <= 512
    or not 0 <= remaining_bytes <= max_bytes <= 4 * 1024**3
    or not 1 <= max_passes <= 3
    or not 1 <= max_metadata_bytes <= 32768
):
    raise SystemExit(1)

descriptor = os.open(
    path,
    os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
)
try:
    before = os.fstat(descriptor)
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.geteuid()
        or before.st_gid != os.getegid()
        or before.st_nlink != 1
        or stat.S_IMODE(before.st_mode) != 0o600
        or not 0 <= before.st_size <= max_metadata_bytes
    ):
        raise SystemExit(1)
    chunks = []
    observed = 0
    while True:
        chunk = os.read(descriptor, min(65536, max_metadata_bytes + 1 - observed))
        if not chunk:
            break
        chunks.append(chunk)
        observed += len(chunk)
        if observed > max_metadata_bytes:
            raise SystemExit(1)
    after = os.fstat(descriptor)
    stable_fields = (
        "st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid",
        "st_size", "st_mtime_ns", "st_ctime_ns",
    )
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        raise SystemExit(1)
finally:
    os.close(descriptor)

payload = b"".join(chunks)
if not payload:
    print("0\t0\tnull")
    raise SystemExit(0)
try:
    text = payload.decode("utf-8")
    document = json.loads(text)
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
members = document.get("members") if isinstance(document, dict) else None
if (
    not isinstance(document, dict)
    or set(document) != {
        "schema", "passes", "memberCount", "logicalBytes", "members"
    }
    or document.get("schema") != "bridgesllm.live-member-reconciliation.v1"
    or not isinstance(document.get("passes"), int)
    or isinstance(document.get("passes"), bool)
    or not 1 <= document["passes"] <= max_passes
    or not isinstance(document.get("memberCount"), int)
    or isinstance(document.get("memberCount"), bool)
    or not 0 <= document["memberCount"] <= remaining_members
    or not isinstance(document.get("logicalBytes"), int)
    or isinstance(document.get("logicalBytes"), bool)
    or not 0 <= document["logicalBytes"] <= remaining_bytes
    or not isinstance(members, list)
    or len(members) != document["memberCount"]
):
    raise SystemExit(1)
canonical = json.dumps(document, sort_keys=True, separators=(",", ":"))
if canonical != text:
    raise SystemExit(1)
if document["memberCount"] == 0 and (
    document["logicalBytes"] != 0 or members
):
    raise SystemExit(1)
print(
    f"{document['memberCount']}\t{document['logicalBytes']}\t{canonical}"
)
PY
}

archive_dir() {
  local source_dir="$1"
  local target="$2"
  local target_parent
  target_parent="$(dirname "$target")"
  local diagnostics="${target}.tar-errors"
  local diagnostics_pipe="${diagnostics}.pipe"
  local before_list="${target}.source-before"
  local before_digest="${target}.source-before.sha256"
  local before_records="${target}.source-before.records"
  local before_unstable="${target}.source-before.unstable"
  local after_list="${target}.source-after"
  local after_digest="${target}.source-after.sha256"
  local after_records="${target}.source-after.records"
  local after_unstable="${target}.source-after.unstable"
  local final_list="${target}.source-final"
  local final_digest="${target}.source-final.sha256"
  local final_records="${target}.source-final.records"
  local final_unstable="${target}.source-final.unstable"
  local baseline_list="${target}.stage-baseline"
  local baseline_omit="${target}.stage-baseline-omit"
  local baseline_allowed="${target}.stage-baseline-allowed"
  local baseline_metadata="${target}.stage-baseline.json"
  local baseline_unstable="${target}.stage-baseline-unstable"
  local baseline_capture_records="${target}.stage-baseline-captures"
  local reconciliation_input_unstable="${target}.reconciliation-input-unstable"
  local reconciliation_list="${target}.reconciliation-stage"
  local reconciliation_omit="${target}.reconciliation-omit"
  local reconciliation_allowed="${target}.reconciliation-allowed"
  local reconciliation_metadata="${target}.reconciliation.json"
  local reconciliation_capture_records="${target}.reconciliation-captures"
  local staged_list="${target}.staged"
  local staged_digest="${target}.staged.sha256"
  local staged_records="${target}.staged.records"
  local stage_parent=""
  local stage_root=""
  local live_mode=false
  local baseline_mode=baseline-strict
  local reconciliation_member_limit="$LIVE_RECONCILIATION_MAX_MEMBERS"
  local reconciliation_byte_limit="$LIVE_RECONCILIATION_MAX_BYTES"
  local reconciliation_worker_member_limit="$LIVE_RECONCILIATION_MAX_MEMBERS"
  local reconciliation_worker_byte_limit="$LIVE_RECONCILIATION_MAX_BYTES"
  local reconciliation_member_count=0
  local reconciliation_logical_bytes=0
  local reconciliation_document=""
  local reconciliation_record=""
  local reconciliation_extra=""
  shift 2
  ARCHIVE_FAILURE_DETAIL=""
  ARCHIVE_LIVE_RECONCILIATION=""
  ARCHIVE_CLEANUP_FAILED=false
  if $live_mode; then
    if [[ ! "${LIVE_RECONCILIATION_MEMBERS_USED:-}" =~ ^[0-9]+$ \
      || ! "${LIVE_RECONCILIATION_BYTES_USED:-}" =~ ^[0-9]+$ \
      || "${LIVE_RECONCILIATION_MEMBERS_USED}" -gt "$LIVE_RECONCILIATION_MAX_MEMBERS" \
      || "${LIVE_RECONCILIATION_BYTES_USED}" -gt "$LIVE_RECONCILIATION_MAX_BYTES" ]]; then
      record_archive_failure "Live recovery reconciliation budget state was invalid"
      return 1
    fi
    reconciliation_member_limit=$((
      LIVE_RECONCILIATION_MAX_MEMBERS - LIVE_RECONCILIATION_MEMBERS_USED
    ))
    reconciliation_byte_limit=$((
      LIVE_RECONCILIATION_MAX_BYTES - LIVE_RECONCILIATION_BYTES_USED
    ))
    reconciliation_worker_member_limit="$reconciliation_member_limit"
    reconciliation_worker_byte_limit="$reconciliation_byte_limit"
    (( reconciliation_worker_member_limit > 0 )) \
      || reconciliation_worker_member_limit=1
    (( reconciliation_worker_byte_limit > 0 )) \
      || reconciliation_worker_byte_limit=1
  fi

  local -a hardlink_options=(--check-links)
  local option overlay_root="" source_root_policy=false
  local -a overlay_relatives=() stage_inventory_options=()
  for option in "$@"; do
    case "${option}" in
      --allow-external-hardlinks)
        hardlink_options=()
        ;;
      --overlay-root=*)
        overlay_root="${option#--overlay-root=}"
        ;;
      --overlay-relative=*)
        overlay_relatives+=("${option#--overlay-relative=}")
        ;;
      --allow-project-interpreter-symlinks)
        stage_inventory_options+=("${option}")
        ;;
      --allow-absolute-symlink-root=*)
        stage_inventory_options+=("${option}")
        [[ "${option#--allow-absolute-symlink-root=}" == "$source_dir" ]]           && source_root_policy=true
        ;;
    esac
  done
  if ! { [[ -z "${overlay_root}" && "${#overlay_relatives[@]}" -eq 0 ]]     || [[ -n "${overlay_root}" && "${#overlay_relatives[@]}" -gt 0 ]]; }; then
    record_archive_failure "Recovery archive overlay authority was incomplete"
    return 1
  fi
  if ! $source_root_policy; then
    stage_inventory_options+=("--allow-absolute-symlink-root=$source_dir")
  fi
  if [[ "$source_dir" != /* || ! -d "$source_dir" || -L "$source_dir" ]]; then
    record_archive_failure       "Recovery source is missing, linked, or not an absolute directory"
    return 1
  fi

  local -a work_paths=(
    "$diagnostics" "$diagnostics_pipe"
    "$before_list" "$before_digest" "$before_records"
    "$before_unstable"
    "$after_list" "$after_digest" "$after_records"
    "$after_unstable"
    "$final_list" "$final_digest" "$final_records"
    "$final_unstable"
    "$baseline_list" "$baseline_omit" "$baseline_allowed"
    "$baseline_metadata" "$baseline_unstable"
    "$baseline_capture_records"
    "$reconciliation_input_unstable"
    "$reconciliation_list" "$reconciliation_omit"
    "$reconciliation_allowed" "$reconciliation_metadata"
    "$reconciliation_capture_records"
    "$staged_list" "$staged_digest" "$staged_records"
  )
  local path
  local -a before_inventory_live=()
  local -a after_inventory_live=()
  local -a final_inventory_live=()
  local before_capacity_unstable=""
  local after_capacity_unstable=""
  local final_capacity_unstable=""
  if $live_mode; then
    before_inventory_live=(
      "--live-unstable-file=$before_unstable"
      "--live-inventory-attempts=$LIVE_RECONCILIATION_MAX_PASSES"
      "--live-inventory-max-unstable=$LIVE_RECONCILIATION_MAX_MEMBERS"
    )
    after_inventory_live=(
      "--live-unstable-file=$after_unstable"
      "--live-inventory-attempts=$LIVE_RECONCILIATION_MAX_PASSES"
      "--live-inventory-max-unstable=$LIVE_RECONCILIATION_MAX_MEMBERS"
    )
    final_inventory_live=(
      "--live-unstable-file=$final_unstable"
      "--live-inventory-attempts=$LIVE_RECONCILIATION_MAX_PASSES"
      "--live-inventory-max-unstable=$LIVE_RECONCILIATION_MAX_MEMBERS"
    )
    before_capacity_unstable="$before_unstable"
    after_capacity_unstable="$after_unstable"
    final_capacity_unstable="$final_unstable"
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    record_archive_failure "Recovery archive target was not empty"
    return 1
  fi
  for path in "${work_paths[@]}"; do
    if [[ -e "${path}" || -L "${path}" ]]; then
      record_archive_failure "Recovery archive staging paths were not empty"
      return 1
    fi
  done

  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      materialize_archive_source_inventory \
      "$source_dir" "$before_list" "$before_digest" "$before_records" "$@" \
      "${before_inventory_live[@]}"; then
    record_archive_failure "Recovery source inventory was rejected" "$diagnostics"
    cleanup_private_archive_work "" "$target_parent" "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if declare -F assert_archive_inventory_capacity_within_guard >/dev/null \
    && ! run_archive_diagnostic_command "$diagnostics" stderr \
      assert_archive_inventory_capacity_within_guard \
      "$source_dir" "$before_records" "$before_list" "$before_digest" \
      "$before_capacity_unstable"; then
    record_archive_failure \
      "Recovery source exceeded its held capacity before staging" \
      "$diagnostics"
    cleanup_private_archive_work "" "$target_parent" \
      "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  stage_parent="$(mktemp -d     "$target_parent/.private-archive-stage.XXXXXX")" || {
      record_archive_failure "Private archive stage could not be allocated"
      cleanup_private_archive_work "" "$target_parent" "${work_paths[@]}" || return 1
      return 1
    }
  if ! chown 0:0 "$stage_parent"     || ! chmod 700 "$stage_parent"; then
    record_archive_failure "Private archive stage parent could not be secured"
    cleanup_private_archive_work "$stage_parent" "$target_parent"       "${work_paths[@]}" || return 1
    return 1
  fi
  stage_root="$stage_parent/$(basename "$source_dir")"
  if ! mkdir -m 700 -- "$stage_root"     || ! chown 0:0 "$stage_root"; then
    record_archive_failure "Private archive stage root could not be secured"
    cleanup_private_archive_work "$stage_parent" "$target_parent"       "${work_paths[@]}" || return 1
    return 1
  fi

  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      materialize_private_archive_stage \
      "$baseline_mode" "$source_dir" "$before_records" "$before_records" \
      "$stage_root" "$baseline_list" "$baseline_omit" "$baseline_allowed" \
      "$baseline_metadata" "$baseline_unstable" "$overlay_root" \
      "$LIVE_RECONCILIATION_MAX_MEMBERS" "$LIVE_RECONCILIATION_MAX_BYTES" \
      "$LIVE_RECONCILIATION_MAX_PASSES" \
      "$LIVE_RECONCILIATION_MAX_METADATA_BYTES" \
      "$LIVE_RECONCILIATION_MAX_SECONDS" "$baseline_capture_records" \
      "${ARCHIVE_XATTR_MAX_BYTES:-16777216}" "${overlay_relatives[@]}"; then
    record_archive_failure       "Descriptor-authoritative baseline staging failed closed" "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if ! archive_reconciliation_test_pause post-capture; then
    record_archive_failure "Archive reconciliation test hook did not settle safely"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      materialize_archive_source_inventory \
      "$source_dir" "$after_list" "$after_digest" "$after_records" "$@" \
      "${after_inventory_live[@]}"; then
    record_archive_failure       "Post-baseline recovery source inventory was rejected" "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if declare -F assert_archive_inventory_capacity_within_guard >/dev/null \
    && ! run_archive_diagnostic_command "$diagnostics" stderr \
      assert_archive_inventory_capacity_within_guard \
      "$source_dir" "$after_records" "$after_list" "$after_digest" \
      "$after_capacity_unstable"; then
    record_archive_failure \
      "Recovery source exceeded its held capacity before reconciliation" \
      "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
      "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if ! $live_mode; then
    if [[ -s "$baseline_unstable" ]]       || ! cmp -s -- "$before_list" "$after_list"       || ! cmp -s -- "$before_digest" "$after_digest"; then
      record_archive_failure "Recovery source changed during strict staged capture"
      cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"         "${work_paths[@]}" || return 1
      return 1
    fi
  else
    if ! run_archive_diagnostic_command "$diagnostics" stderr \
        merge_archive_unstable_evidence \
        "$reconciliation_input_unstable" \
        "$LIVE_RECONCILIATION_MAX_MEMBERS" \
        "$before_unstable" "$after_unstable" "$baseline_unstable"; then
      record_archive_failure \
        "Live recovery instability evidence was rejected" "$diagnostics"
      cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
        "${work_paths[@]}" || return 1
      return 1
    fi
    rm -f -- "$diagnostics"
    if ! run_archive_diagnostic_command "$diagnostics" stderr \
        materialize_private_archive_stage \
        reconcile "$source_dir" "$before_records" "$after_records" \
        "$stage_root" "$reconciliation_list" "$reconciliation_omit" \
        "$reconciliation_allowed" "$reconciliation_metadata" \
        "$reconciliation_input_unstable" "$overlay_root" \
        "$reconciliation_worker_member_limit" \
        "$reconciliation_worker_byte_limit" \
        "$LIVE_RECONCILIATION_MAX_PASSES" \
        "$LIVE_RECONCILIATION_MAX_METADATA_BYTES" \
        "$LIVE_RECONCILIATION_MAX_SECONDS" "$reconciliation_capture_records" \
        "${ARCHIVE_XATTR_MAX_BYTES:-16777216}" "${overlay_relatives[@]}"; then
      # A failed worker can have materialized the entire remaining allowance
      # before rejecting its last member.  Debit that worst case so a retry or
      # later component cannot spend the same run-wide budget again.
      LIVE_RECONCILIATION_MEMBERS_USED="$LIVE_RECONCILIATION_MAX_MEMBERS"
      LIVE_RECONCILIATION_BYTES_USED="$LIVE_RECONCILIATION_MAX_BYTES"
      record_archive_failure         "Live recovery member reconciliation failed closed" "$diagnostics"
      cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"         "${work_paths[@]}" || return 1
      return 1
    fi
    rm -f -- "$diagnostics"
    if ! reconciliation_record="$(
        read_live_reconciliation_budget_record \
          "$reconciliation_metadata" "$reconciliation_member_limit" \
          "$reconciliation_byte_limit"
      )"; then
      LIVE_RECONCILIATION_MEMBERS_USED="$LIVE_RECONCILIATION_MAX_MEMBERS"
      LIVE_RECONCILIATION_BYTES_USED="$LIVE_RECONCILIATION_MAX_BYTES"
      record_archive_failure \
        "Live recovery reconciliation exceeded its aggregate run budget"
      cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
        "${work_paths[@]}" || return 1
      return 1
    fi
    IFS=$'\t' read -r reconciliation_member_count \
      reconciliation_logical_bytes reconciliation_document \
      reconciliation_extra <<<"$reconciliation_record"
    if [[ -n "$reconciliation_extra" \
      || ! "$reconciliation_member_count" =~ ^[0-9]+$ \
      || ! "$reconciliation_logical_bytes" =~ ^[0-9]+$ \
      || -z "$reconciliation_document" ]]; then
      LIVE_RECONCILIATION_MEMBERS_USED="$LIVE_RECONCILIATION_MAX_MEMBERS"
      LIVE_RECONCILIATION_BYTES_USED="$LIVE_RECONCILIATION_MAX_BYTES"
      record_archive_failure \
        "Live recovery reconciliation budget evidence was malformed"
      cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
        "${work_paths[@]}" || return 1
      return 1
    fi
    LIVE_RECONCILIATION_MEMBERS_USED=$((
      LIVE_RECONCILIATION_MEMBERS_USED + reconciliation_member_count
    ))
    LIVE_RECONCILIATION_BYTES_USED=$((
      LIVE_RECONCILIATION_BYTES_USED + reconciliation_logical_bytes
    ))
    if (( reconciliation_member_count > 0 )); then
      ARCHIVE_LIVE_RECONCILIATION="$reconciliation_document"
    fi
  fi

  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      materialize_archive_source_inventory \
      "$stage_root" "$staged_list" "$staged_digest" "$staged_records" \
      "${stage_inventory_options[@]}"; then
    record_archive_failure "Private archive stage inventory was rejected" "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"
  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      assert_private_stage_matches_admitted_inventory \
      "$after_records" "$staged_records" "$live_mode" \
      "$baseline_capture_records" "$reconciliation_capture_records"; then
    record_archive_failure       "Private archive stage did not match its admitted source contract"       "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if declare -F assert_archive_inventory_capacity_within_guard >/dev/null \
    && ! run_archive_diagnostic_command "$diagnostics" stderr \
      assert_archive_inventory_capacity_within_guard \
      "$source_dir" "$staged_records" "$staged_list" "$staged_digest" ""; then
    record_archive_failure \
      "Private archive stage exceeded its held capacity before tar" \
      "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
      "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if ! archive_reconciliation_test_pause \
      post-attestation "$source_dir" "$after_digest"; then
    record_archive_failure "Archive post-attestation test hook did not settle safely"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
      "${work_paths[@]}" || return 1
    return 1
  fi

  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      tar --format=pax --sparse --one-file-system "${hardlink_options[@]}" \
      --acls --xattrs --xattrs-include='*' --selinux \
      --pax-option=delete=atime,delete=ctime --atime-preserve=system \
      --no-recursion --null --verbatim-files-from \
      -czf "$target" -C "$stage_parent" -T "$staged_list" \
    || [[ -s "$diagnostics" ]]; then
    record_archive_failure "Tar could not capture the private archive stage"       "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if ! run_archive_diagnostic_command "$diagnostics" combined \
      tar --compare --numeric-owner --acls --xattrs \
      --xattrs-include='*' --selinux --atime-preserve=system \
      --no-recursion --null --verbatim-files-from -zf "$target" \
      -C "$stage_parent" -T "$staged_list" \
    || [[ -s "$diagnostics" ]]; then
    record_archive_failure       "Captured recovery archive did not match the private stage" "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"
  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      assert_archive_matches_source_inventory \
      "$target" "$staged_list" "$staged_digest" "$staged_records"; then
    record_archive_failure \
      "Captured recovery archive contract did not match the private stage" \
      "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
      "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if ! run_archive_diagnostic_command "$diagnostics" stderr \
      materialize_archive_source_inventory \
      "$source_dir" "$final_list" "$final_digest" "$final_records" "$@" \
      "${final_inventory_live[@]}"; then
    record_archive_failure "Final recovery source inventory was rejected"       "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  if declare -F assert_archive_inventory_capacity_within_guard >/dev/null \
    && ! run_archive_diagnostic_command "$diagnostics" stderr \
      assert_archive_inventory_capacity_within_guard \
      "$source_dir" "$final_records" "$final_list" "$final_digest" \
      "$final_capacity_unstable"; then
    record_archive_failure \
      "Final recovery source exceeded its held capacity" "$diagnostics"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target" \
      "${work_paths[@]}" || return 1
    return 1
  fi
  if $live_mode; then
    rm -f -- "$diagnostics"
    if ! run_archive_diagnostic_command "$diagnostics" stderr \
        assert_live_reconciliation_scope \
        "$after_records" "$final_records" "$reconciliation_allowed" \
        "$final_unstable"; then
      record_archive_failure         "Recovery source developed drift outside the reconciled member set"         "$diagnostics"
      cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"         "${work_paths[@]}" || return 1
      return 1
    fi
  elif ! cmp -s -- "$before_list" "$final_list"     || ! cmp -s -- "$before_digest" "$final_digest"; then
    record_archive_failure "Recovery source changed during strict archive emission"
    cleanup_private_archive_work "$stage_parent" "$target_parent" "$target"       "${work_paths[@]}" || return 1
    return 1
  fi
  rm -f -- "$diagnostics"

  if ! cleanup_private_archive_work       "$stage_parent" "$target_parent" "${work_paths[@]}"; then
    if ! rm -f -- "$target"; then
      ARCHIVE_FAILURE_DETAIL="$(
        printf '%s' \
          "${ARCHIVE_FAILURE_DETAIL}; archive target cleanup also failed closed" \
          | sanitize_status_detail 2>/dev/null \
          || printf '%s' 'Private archive cleanup failed closed with residue'
      )"
      log "WARNING: ${ARCHIVE_FAILURE_DETAIL}"
    fi
    return 1
  fi
  if [[ ! -s "$target" || ! -f "$target" || -L "$target" ]]; then
    return 1
  fi
  return 0
}
record_recovery_component() {
  local component_id="$1"
  local requirement="$2"
  local status="$3"
  local payload="$4"
  local source="$5"
  local capture_method="$6"
  local reason="${7:-}"
  local logical_bytes="${8:-}"
  local relation_count="${9:-}"
  local contract_variant="${10:-}"
  local live_reconciliation="${11:-}"
  [[ -n "$RECOVERY_COMPONENTS_FILE" ]] || die "Recovery manifest registry is unavailable"
  COMPONENT_ID="$component_id" \
  COMPONENT_REQUIREMENT="$requirement" \
  COMPONENT_STATUS="$status" \
  COMPONENT_PAYLOAD="$payload" \
  COMPONENT_SOURCE="$source" \
  COMPONENT_CAPTURE_METHOD="$capture_method" \
  COMPONENT_REASON="$reason" \
  COMPONENT_LOGICAL_BYTES="$logical_bytes" \
  COMPONENT_RELATION_COUNT="$relation_count" \
  COMPONENT_CONTRACT_VARIANT="$contract_variant" \
  COMPONENT_LIVE_RECONCILIATION="$live_reconciliation" \
  python3 - "$RECOVERY_COMPONENTS_FILE" <<'PY'
import json
import os
import sys

entry = {
    "id": os.environ["COMPONENT_ID"],
    "requirement": os.environ["COMPONENT_REQUIREMENT"],
    "status": os.environ["COMPONENT_STATUS"],
    "payload": os.environ["COMPONENT_PAYLOAD"] or None,
    "source": os.environ["COMPONENT_SOURCE"] or None,
    "captureMethod": os.environ["COMPONENT_CAPTURE_METHOD"] or None,
}
if os.environ.get("COMPONENT_REASON"):
    entry["reason"] = os.environ["COMPONENT_REASON"]
if os.environ.get("COMPONENT_LOGICAL_BYTES"):
    logical_bytes = os.environ["COMPONENT_LOGICAL_BYTES"]
    if not logical_bytes.isdigit() or int(logical_bytes) <= 0:
        raise SystemExit("invalid recovery component logical size")
    entry["logicalBytes"] = int(logical_bytes)
if os.environ.get("COMPONENT_RELATION_COUNT"):
    relation_count = os.environ["COMPONENT_RELATION_COUNT"]
    if (
        not relation_count.isdigit()
        or int(relation_count) <= 0
        or int(relation_count) > 100_000_000
    ):
        raise SystemExit("invalid recovery component relation count")
    entry["relationCount"] = int(relation_count)
if os.environ.get("COMPONENT_CONTRACT_VARIANT"):
    variant = os.environ["COMPONENT_CONTRACT_VARIANT"]
    if variant not in {"owner-null", "pg-database-owner-default"}:
        raise SystemExit("invalid recovery component database contract")
    entry["databaseContractVariant"] = variant
if os.environ.get("COMPONENT_LIVE_RECONCILIATION"):
    document = json.loads(os.environ["COMPONENT_LIVE_RECONCILIATION"])
    members = document.get("members") if isinstance(document, dict) else None
    if (
        not isinstance(document, dict)
        or set(document) != {
            "schema", "passes", "memberCount", "logicalBytes", "members"
        }
        or document.get("schema")
            != "bridgesllm.live-member-reconciliation.v1"
        or not isinstance(document.get("passes"), int)
        or isinstance(document.get("passes"), bool)
        or document["passes"] <= 0
        or document["passes"] > 3
        or not isinstance(document.get("memberCount"), int)
        or isinstance(document.get("memberCount"), bool)
        or document["memberCount"] <= 0
        or document["memberCount"] > 512
        or not isinstance(document.get("logicalBytes"), int)
        or isinstance(document.get("logicalBytes"), bool)
        or document["logicalBytes"] < 0
        or document["logicalBytes"] > 4 * 1024**3
        or not isinstance(members, list)
        or len(members) != document["memberCount"]
    ):
        raise SystemExit("invalid live reconciliation metadata")
    seen = set()
    for member in members:
        path = member.get("path") if isinstance(member, dict) else None
        if (
            not isinstance(member, dict)
            or set(member) != {"path", "transition", "capture"}
            or not isinstance(path, str)
            or not path
            or len(path.encode("utf-8")) >= 4096
            or path.startswith("/")
            or "\\" in path
            or any(ord(character) < 32 or ord(character) == 127 for character in path)
            or (path != "." and any(part in {"", ".", ".."} for part in path.split("/")))
            or path in seen
            or member.get("transition") not in {
                "stable", "added", "changed", "removed"
            }
            or member.get("capture") not in {
                "descriptor-snapshot", "metadata-snapshot", "symlink-snapshot",
                "hardlink-snapshot", "sqlite-online-snapshot",
                "sqlite-journal-omitted", "absent-at-attestation",
            }
        ):
            raise SystemExit("invalid live reconciliation member metadata")
        seen.add(path)
    entry["liveReconciliation"] = document
with open(sys.argv[1], "a", encoding="utf-8") as handle:
    json.dump(entry, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
}

archive_capture_method() {
  printf '%s\n' 'service-quiesced-tar'
}

archive_required_component() {
  local component_id="$1"
  local source_dir="$2"
  local target="$3"
  shift 3
  if ! archive_dir "$source_dir" "$target" "$@"; then
    if [[ "${ARCHIVE_CLEANUP_FAILED}" == "true" ]]; then
      die "${ARCHIVE_FAILURE_DETAIL:-Private archive cleanup failed closed}"
    fi
    record_degraded_component \
      "$component_id" required "$source_dir" \
      "${ARCHIVE_FAILURE_DETAIL:-Required recovery source was missing or could not be archived}"
    return 0
  fi
  local capture_method
  capture_method="$(archive_capture_method)"
  record_recovery_component \
    "$component_id" required captured "$(basename "$target")" "$source_dir" \
    "$capture_method" "" "" "" "" "${ARCHIVE_LIVE_RECONCILIATION:-}"
}

archive_required_component_with_retries() {
  local component_id="$1"
  local source_dir="$2"
  local target="$3"
  local max_attempts="$4"
  local attempt=1
  shift 4
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] \
    || die "Archive retry count must be a positive integer: ${component_id}"
  while ! archive_dir "$source_dir" "$target" "$@"; do
    if [[ "${ARCHIVE_CLEANUP_FAILED}" == "true" ]]; then
      die "${ARCHIVE_FAILURE_DETAIL:-Private archive cleanup failed closed}"
    fi
    if (( attempt >= max_attempts )); then
      record_degraded_component \
        "$component_id" required "$source_dir" \
        "${ARCHIVE_FAILURE_DETAIL:-Required recovery source could not be archived after ${max_attempts} attempts}"
      return 0
    fi
    log "${ARCHIVE_FAILURE_DETAIL:-Recovery source could not be archived}; retrying ${component_id} ($(( attempt + 1 ))/${max_attempts})"
    (( attempt += 1 ))
    sleep 1
  done
  local capture_method
  capture_method="$(archive_capture_method)"
  record_recovery_component \
    "$component_id" required captured "$(basename "$target")" "$source_dir" \
    "$capture_method" "" "" "" "" "${ARCHIVE_LIVE_RECONCILIATION:-}"
}

snapshot_sqlite_database() {
  local source_database="$1"
  local snapshot_database="$2"
  local snapshot_timeout="${SQLITE_SNAPSHOT_TIMEOUT_SECONDS:-300}"
  [[ "$snapshot_timeout" =~ ^[1-9][0-9]*$ \
    && "$snapshot_timeout" -le 300 ]] || return 1
  [[ "$snapshot_database" == /* \
    && "$snapshot_database" != */ ]] || return 1
  local snapshot_parent="${snapshot_database%/*}"
  [[ -n "$snapshot_parent" ]] || snapshot_parent=/
  local snapshot_parent_uid snapshot_parent_gid snapshot_parent_mode
  local snapshot_parent_kind snapshot_parent_real
  IFS=: read -r snapshot_parent_uid snapshot_parent_gid \
    snapshot_parent_mode snapshot_parent_kind \
    < <(stat -Lc '%u:%g:%a:%F' "$snapshot_parent" 2>/dev/null) \
    || return 1
  snapshot_parent_real="$(readlink -f -- "$snapshot_parent" 2>/dev/null)" \
    || return 1
  [[ "$snapshot_parent_uid" == "0" \
    && "$snapshot_parent_gid" == "0" \
    && "$snapshot_parent_mode" =~ ^[0-7]{3,4}$ \
    && "$snapshot_parent_kind" == "directory" \
    && "$snapshot_parent_real" == "$snapshot_parent" \
    && -d "$snapshot_parent" \
    && ! -L "$snapshot_parent" ]] \
    || return 1
  (( (8#$snapshot_parent_mode & 0022) == 0 )) || return 1

  local timeout_uid timeout_gid timeout_mode timeout_kind
  IFS=: read -r timeout_uid timeout_gid timeout_mode timeout_kind \
    < <(stat -Lc '%u:%g:%a:%F' /usr/bin/timeout 2>/dev/null) \
    || return 1
  [[ "$timeout_uid" == "0" \
    && "$timeout_gid" == "0" \
    && "$timeout_mode" =~ ^[0-7]{3,4}$ \
    && "$timeout_kind" == "regular file" \
    && -x /usr/bin/timeout \
    && ! -L /usr/bin/timeout ]] \
    || return 1
  (( (8#$timeout_mode & 0022) == 0 )) || return 1

  local transaction_root
  transaction_root="$(
    /usr/bin/mktemp -d -- \
      "$snapshot_parent/.sqlite-snapshot-transaction.XXXXXX"
  )" || return 1
  chmod 700 -- "$transaction_root" || return 1
  local transaction_status=0
  {
    /usr/bin/timeout --foreground --signal=TERM --kill-after=2s \
      "${snapshot_timeout}s" \
      python3 - "$source_database" "$snapshot_database" \
        "$snapshot_timeout" "$transaction_root" <<'PY'
import ctypes
import hashlib
import json
import os
import pathlib
import signal
import sqlite3
import stat
import struct
import sys
import tempfile
import time

source = pathlib.Path(sys.argv[1])
published_target = pathlib.Path(sys.argv[2])
timeout_seconds = int(sys.argv[3])
transaction_root = pathlib.Path(sys.argv[4])
target = transaction_root / "snapshot.sqlite"
if timeout_seconds <= 0 or timeout_seconds > 300:
    raise SystemExit(1)
deadline = time.monotonic() + timeout_seconds

def remaining_seconds():
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("SQLite snapshot time bound was exceeded")
    return max(0.001, remaining)

def clamp_busy_timeout(connection):
    milliseconds = max(1, min(30000, int(remaining_seconds() * 1000)))
    connection.execute(f"PRAGMA busy_timeout={milliseconds}")

def vm_progress():
    remaining_seconds()
    return 0

def canonical_path(path):
    return (
        path.is_absolute()
        and os.path.normpath(path) == str(path)
        and os.path.realpath(path) == str(path)
    )

def trusted_directory(path):
    info = os.lstat(path)
    return (
        stat.S_ISDIR(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and info.st_uid == 0
        and info.st_gid == 0
        and not (info.st_mode & 0o022)
    )

def trusted_test_hook_directory():
    root_raw = os.environ.get("BRIDGESLLM_BACKUP_TEST_ROOT", "")
    hook_raw = os.environ.get(
        "BRIDGESLLM_BACKUP_RECONCILIATION_TEST_HOOK_DIR",
        "",
    )
    if not root_raw and not hook_raw:
        return None
    if not root_raw or not hook_raw:
        raise ValueError("SQLite snapshot test hook authority is incomplete")
    root = pathlib.Path(root_raw)
    hook = pathlib.Path(hook_raw)
    if (
        not canonical_path(root)
        or not canonical_path(hook)
        or not trusted_directory(root)
        or not trusted_directory(hook)
        or stat.S_IMODE(os.lstat(root).st_mode) != 0o700
        or stat.S_IMODE(os.lstat(hook).st_mode) != 0o700
        or hook == root
        or not str(hook).startswith(str(root) + os.sep)
    ):
        raise ValueError("SQLite snapshot test hook authority is unsafe")
    return hook

test_hook_directory = trusted_test_hook_directory()
test_hook_phase_selector = os.environ.get(
    "BRIDGESLLM_BACKUP_SQLITE_TEST_PHASE",
    "",
)
test_hard_stall_raw = os.environ.get(
    "BRIDGESLLM_BACKUP_SQLITE_TEST_HARD_STALL",
    "",
)
if test_hard_stall_raw not in {"", "0", "1"}:
    raise ValueError("SQLite snapshot hard-stall selector is invalid")
test_hard_stall_enabled = test_hard_stall_raw == "1"
if test_hook_phase_selector not in {
    "",
    "snapshot-sqlite-backup-step",
    "snapshot-sqlite-pre-vacuum",
    "snapshot-sqlite-pre-quick-check",
    "snapshot-sqlite-post-receipt",
}:
    raise ValueError("SQLite snapshot test phase selector is invalid")
if test_hook_phase_selector and test_hook_directory is None:
    raise ValueError("SQLite snapshot test phase lacks trusted authority")
if test_hard_stall_enabled and (
    test_hook_directory is None
    or test_hook_phase_selector not in {
        "snapshot-sqlite-backup-step",
        "snapshot-sqlite-pre-vacuum",
        "snapshot-sqlite-pre-quick-check",
        "snapshot-sqlite-post-receipt",
    }
):
    raise ValueError("SQLite snapshot hard-stall authority is incomplete")

def write_test_marker(path, payload):
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        0o600,
    )
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("SQLite snapshot test marker write was short")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def invoke_test_phase(phase):
    if test_hook_directory is None:
        return
    if phase not in {
        "snapshot-sqlite-backup-step",
        "snapshot-sqlite-pre-vacuum",
        "snapshot-sqlite-pre-quick-check",
        "snapshot-sqlite-post-receipt",
    }:
        raise ValueError("SQLite snapshot test phase is invalid")
    if test_hook_phase_selector and phase != test_hook_phase_selector:
        return
    # Cooperative pre-operation hooks remain useful for topology/ABA tests,
    # but a hard-stall marker must originate inside SQLite's operation.
    if test_hard_stall_enabled:
        return
    ready = test_hook_directory / f"{phase}-ready"
    release = test_hook_directory / f"{phase}-release"
    write_test_marker(ready, b"ready\n")
    while True:
        remaining_seconds()
        try:
            info = os.lstat(release)
        except FileNotFoundError:
            time.sleep(0.005)
            continue
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
        ):
            raise ValueError("SQLite snapshot test release is unsafe")
        remaining_seconds()
        return

def invoke_hard_stall(phase, operation):
    if (
        not test_hard_stall_enabled
        or test_hook_directory is None
        or phase != test_hook_phase_selector
    ):
        return
    expected_operation = {
        "snapshot-sqlite-backup-step": "Connection.backup",
        "snapshot-sqlite-pre-vacuum": "VACUUM",
        "snapshot-sqlite-pre-quick-check": "PRAGMA quick_check",
        "snapshot-sqlite-post-receipt": "private receipt fsync",
    }.get(phase)
    if expected_operation is None or operation != expected_operation:
        raise ValueError("SQLite snapshot hard-stall operation is invalid")
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raw_stat = pathlib.Path("/proc/self/stat").read_text(encoding="ascii")
    fields = raw_stat.rsplit(")", 1)[1].split()
    raw_status = pathlib.Path("/proc/self/status").read_text(
        encoding="ascii"
    ).splitlines()
    host_pids = [
        line.partition(":")[2].strip()
        for line in raw_status if line.startswith("Pid:")
    ]
    if len(host_pids) != 1 or not host_pids[0].isdigit():
        raise ValueError("SQLite snapshot host PID is unavailable")
    document = {
        "schema": "bridgesllm.sqlite-hard-stall-test.v1",
        "phase": phase,
        "operation": operation,
        "pid": int(host_pids[0]),
        "namespacePid": os.getpid(),
        "startTimeTicks": int(fields[19]),
        "mountNamespace": os.readlink("/proc/self/ns/mnt"),
    }
    write_test_marker(
        test_hook_directory / f"{phase}-hard-stall.json",
        json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    while True:
        signal.pause()

def source_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_uid,
        info.st_gid,
        info.st_nlink,
    )

def directory_stable_state(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_nlink,
        info.st_uid,
        info.st_gid,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )

def bounded_xattrs_from_fd(descriptor):
    names = sorted(
        name if isinstance(name, bytes)
        else name.encode("utf-8", "surrogateescape")
        for name in os.listxattr(descriptor)
    )
    if len(names) > 1024 or len(names) != len(set(names)):
        raise ValueError("SQLite source xattrs are invalid")
    result = []
    total = 0
    for name in names:
        if not name or len(name) > 255 or b"\0" in name or b"." not in name:
            raise ValueError("SQLite source xattr name is unsafe")
        value = os.getxattr(descriptor, name)
        total += len(name) + len(value)
        if len(value) > 1024 * 1024 or total > 16 * 1024 * 1024:
            raise ValueError("SQLite source xattrs are unbounded")
        result.append((name, value))
    return tuple(result)

def replace_fd_xattrs(descriptor, expected):
    expected_map = dict(expected)
    if len(expected_map) != len(expected):
        raise ValueError("SQLite source xattrs are duplicated")
    for name, _value in bounded_xattrs_from_fd(descriptor):
        if name not in expected_map:
            os.removexattr(descriptor, name)
    for name, value in expected:
        os.setxattr(descriptor, name, value)
    if bounded_xattrs_from_fd(descriptor) != expected:
        raise ValueError("SQLite snapshot xattrs were not replaced exactly")

def xattr_receipt_digest(attributes):
    digest = hashlib.sha256()
    for name, value in attributes:
        digest.update(struct.pack(">I", len(name)))
        digest.update(name)
        digest.update(struct.pack(">Q", len(value)))
        digest.update(value)
    return digest.hexdigest()

def snapshot_receipt_identity(info, attributes):
    return {
        "device": info.st_dev,
        "inode": info.st_ino,
        "fileType": stat.S_IFMT(info.st_mode),
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "links": info.st_nlink,
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "xattrSha256": xattr_receipt_digest(attributes),
    }

def apply_snapshot_metadata(path, source_info, source_xattrs):
    descriptor = os.open(
        path,
        os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    )
    try:
        # Ownership first; then remove every inherited ACL/xattr, apply the
        # source set exactly, and only then settle mode and timestamps.
        os.fchown(descriptor, source_info.st_uid, source_info.st_gid)
        replace_fd_xattrs(descriptor, source_xattrs)
        os.fchmod(descriptor, stat.S_IMODE(source_info.st_mode))
        os.utime(
            descriptor,
            ns=(source_info.st_atime_ns, source_info.st_mtime_ns),
        )
        final = os.fstat(descriptor)
        if (
            final.st_uid != source_info.st_uid
            or final.st_gid != source_info.st_gid
            or stat.S_IMODE(final.st_mode) != stat.S_IMODE(source_info.st_mode)
            or final.st_atime_ns != source_info.st_atime_ns
            or final.st_mtime_ns != source_info.st_mtime_ns
            or bounded_xattrs_from_fd(descriptor) != source_xattrs
        ):
            raise ValueError("SQLite snapshot metadata was not applied exactly")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def attest_source_member(parent_descriptor, name, parent_device, *, require_nonempty=False):
    info = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or info.st_dev != parent_device
        or info.st_size < (1 if require_nonempty else 0)
        or info.st_size > 1024**4
    ):
        raise ValueError("unsafe SQLite source member")
    descriptor = os.open(
        name,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
        dir_fd=parent_descriptor,
    )
    if source_identity(os.fstat(descriptor)) != source_identity(info):
        os.close(descriptor)
        raise ValueError("SQLite source member changed during admission")
    return info, descriptor

mount_libc = ctypes.CDLL(None, use_errno=True)
mount_call = getattr(mount_libc, "mount", None)
unshare_call = getattr(mount_libc, "unshare", None)
umount2_call = getattr(mount_libc, "umount2", None)
if mount_call is not None:
    mount_call.argtypes = [
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_ulong,
        ctypes.c_void_p,
    ]
    mount_call.restype = ctypes.c_int
if unshare_call is not None:
    unshare_call.argtypes = [ctypes.c_int]
    unshare_call.restype = ctypes.c_int
if umount2_call is not None:
    umount2_call.argtypes = [ctypes.c_char_p, ctypes.c_int]
    umount2_call.restype = ctypes.c_int

CLONE_NEWNS = 0x00020000
MS_REC = 0x00004000
MS_PRIVATE = 0x00040000
MS_BIND = 0x00001000
MNT_DETACH = 0x00000002
mount_namespace_initialized = False

def enter_private_mount_namespace():
    global mount_namespace_initialized
    if mount_namespace_initialized:
        return
    if (
        os.geteuid() != 0
        or mount_call is None
        or unshare_call is None
        or umount2_call is None
    ):
        raise ValueError("SQLite descriptor-mount authority is unavailable")
    namespace_before = os.stat("/proc/self/ns/mnt")
    if unshare_call(CLONE_NEWNS) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "SQLite mount namespace could not be isolated")
    namespace_after = os.stat("/proc/self/ns/mnt")
    if (
        namespace_before.st_dev == namespace_after.st_dev
        and namespace_before.st_ino == namespace_after.st_ino
    ):
        raise ValueError("SQLite mount namespace was not isolated")
    if mount_call(None, b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "SQLite mount propagation could not be privatized")
    mount_namespace_initialized = True

def mount_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        info.st_nlink,
    )

def placeholder_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_uid,
        info.st_gid,
        info.st_nlink,
        info.st_size,
    )

def attach_descriptor_mount(descriptor, view_descriptor, view, name, mounts):
    source_before = os.fstat(descriptor)
    target_descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o600,
        dir_fd=view_descriptor,
    )
    try:
        os.fchmod(target_descriptor, 0o600)
        placeholder = os.fstat(target_descriptor)
    finally:
        os.close(target_descriptor)
    if (
        not stat.S_ISREG(placeholder.st_mode)
        or placeholder.st_uid != 0
        or placeholder.st_gid != 0
        or placeholder.st_nlink != 1
        or placeholder.st_size != 0
        or stat.S_IMODE(placeholder.st_mode) != 0o600
    ):
        raise ValueError("SQLite mount placeholder is unsafe")
    candidate = view / name
    record = {
        "path": candidate,
        "placeholder": placeholder_identity(placeholder),
        "mounted": False,
    }
    mounts.append(record)
    proc_source = os.fsencode(f"/proc/self/fd/{descriptor}")
    if mount_call(
        proc_source,
        os.fsencode(candidate),
        None,
        MS_BIND,
        None,
    ) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "SQLite descriptor mount could not be attached")
    record["mounted"] = True
    observed = os.stat(name, dir_fd=view_descriptor, follow_symlinks=False)
    source_after = os.fstat(descriptor)
    if (
        mount_identity(source_before) != mount_identity(source_after)
        or mount_identity(source_after) != mount_identity(observed)
    ):
        raise ValueError("SQLite descriptor mount changed inode authority")

def create_inode_view(main_descriptor, sidecars):
    if not mount_namespace_initialized:
        raise ValueError("SQLite mount namespace was not initialized")
    view = pathlib.Path(tempfile.mkdtemp(
        prefix=".sqlite-inode-view.",
        dir=target.parent,
    ))
    os.chmod(view, 0o700)
    view_info = os.lstat(view)
    if (
        not stat.S_ISDIR(view_info.st_mode)
        or stat.S_ISLNK(view_info.st_mode)
        or view_info.st_uid != 0
        or view_info.st_gid != 0
        or stat.S_IMODE(view_info.st_mode) != 0o700
    ):
        os.rmdir(view)
        raise ValueError("SQLite descriptor-mount view is unsafe")
    mounts = []
    try:
        view_descriptor = os.open(
            view,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except BaseException:
        os.rmdir(view)
        raise
    try:
        main = view / "database.sqlite"
        entries = [("", main_descriptor), *sorted(sidecars.items())]
        for suffix, descriptor in entries:
            candidate = pathlib.Path(str(main) + suffix)
            attach_descriptor_mount(
                descriptor,
                view_descriptor,
                view,
                candidate.name,
                mounts,
            )
        return view, main, mounts
    except BaseException:
        cleanup_inode_view(view, mounts, strict=True)
        raise
    finally:
        os.close(view_descriptor)

def cleanup_inode_view(view, mounts, *, strict):
    errors = []
    for record in reversed(mounts):
        candidate = record["path"]
        if record["mounted"]:
            if umount2_call(os.fsencode(candidate), MNT_DETACH) != 0:
                error = ctypes.get_errno()
                errors.append(OSError(error, "SQLite descriptor mount did not detach"))
                continue
            record["mounted"] = False
        try:
            observed = os.lstat(candidate)
            if placeholder_identity(observed) != record["placeholder"]:
                raise ValueError("SQLite mount placeholder identity changed")
            os.unlink(candidate)
        except (OSError, ValueError) as error:
            errors.append(error)
    try:
        os.rmdir(view)
    except OSError as error:
        errors.append(error)
    if strict and errors:
        raise OSError(f"SQLite descriptor-mount cleanup failed: {errors[0]}")

def assert_admitted_sqlite_topology(
    parent_descriptor,
    parent_before,
    source_name,
    main_before,
    main_descriptor,
    sidecars_before,
    sidecar_descriptors,
    inode_view,
):
    if directory_stable_state(os.fstat(parent_descriptor)) != directory_stable_state(
        parent_before
    ):
        raise ValueError("SQLite source parent changed during snapshot")
    main_path = os.stat(
        source_name,
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    if (
        source_identity(main_path) != source_identity(main_before)
        or source_identity(os.fstat(main_descriptor))
        != source_identity(main_before)
    ):
        raise ValueError("SQLite source identity changed")
    expected_view = {"database.sqlite"}
    for suffix in ("-wal", "-shm", "-journal"):
        admitted = sidecars_before.get(suffix)
        held = sidecar_descriptors.get(suffix)
        try:
            observed = os.stat(
                source_name + suffix,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            if admitted is not None or held is not None:
                raise ValueError("SQLite sidecar topology changed")
            continue
        if (
            admitted is None
            or held is None
            or source_identity(observed) != source_identity(admitted)
            or source_identity(os.fstat(held)) != source_identity(admitted)
        ):
            raise ValueError("SQLite sidecar topology changed")
        expected_view.add("database.sqlite" + suffix)
    admitted_suffixes = set(sidecars_before)
    if (
        ("-shm" in admitted_suffixes and "-wal" not in admitted_suffixes)
        or (
            "-journal" in admitted_suffixes
            and bool(admitted_suffixes & {"-wal", "-shm"})
        )
    ):
        raise ValueError("SQLite admitted sidecar topology is invalid")
    if set(os.listdir(inode_view)) != expected_view:
        raise ValueError("SQLite private view created an unadmitted sidecar")
    view_descriptor = os.open(
        inode_view,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        mounted = {
            "database.sqlite": main_descriptor,
            **{
                "database.sqlite" + suffix: held
                for suffix, held in sidecar_descriptors.items()
            },
        }
        for name, held in mounted.items():
            observed = os.stat(
                name,
                dir_fd=view_descriptor,
                follow_symlinks=False,
            )
            if mount_identity(observed) != mount_identity(os.fstat(held)):
                raise ValueError("SQLite private view lost inode authority")
    finally:
        os.close(view_descriptor)

created = False
held_descriptors = []
inode_view = inode_main = None
inode_mounts = []
snapshot_source_info = None
snapshot_source_xattrs = None
try:
    transaction_info = os.lstat(transaction_root)
    published_parent_info = os.lstat(published_target.parent)
    if (
        not canonical_path(source)
        or not canonical_path(source.parent)
        or not trusted_directory(source.parent)
        or not published_target.is_absolute()
        or os.path.normpath(published_target) != str(published_target)
        or os.path.lexists(published_target)
        or not canonical_path(published_target.parent)
        or not trusted_directory(published_target.parent)
        or not canonical_path(transaction_root)
        or not trusted_directory(transaction_root)
        or stat.S_IMODE(transaction_info.st_mode) != 0o700
        or transaction_info.st_nlink != 2
        or transaction_root.parent != published_target.parent
        or transaction_info.st_dev != published_parent_info.st_dev
        or os.listdir(transaction_root)
        or target.parent != transaction_root
        or target.name != "snapshot.sqlite"
    ):
        raise ValueError("unsafe SQLite snapshot authority")
    # Source descriptors must be opened inside the private namespace so the
    # /proc/self/fd bind mounts refer to mount objects admitted in that view.
    enter_private_mount_namespace()
    parent_flags = (
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    parent_descriptor = os.open("/", parent_flags)
    try:
        for component in source.parent.parts[1:]:
            next_descriptor = os.open(
                component,
                parent_flags,
                dir_fd=parent_descriptor,
            )
            os.close(parent_descriptor)
            parent_descriptor = next_descriptor
    except BaseException:
        os.close(parent_descriptor)
        raise
    held_descriptors.append(parent_descriptor)
    parent_info = os.fstat(parent_descriptor)
    parent_before = parent_info
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != 0
        or parent_info.st_gid != 0
        or parent_info.st_mode & 0o022
    ):
        raise ValueError("SQLite source parent is unsafe")
    before, source_descriptor = attest_source_member(
        parent_descriptor,
        source.name,
        parent_info.st_dev,
        require_nonempty=True,
    )
    held_descriptors.append(source_descriptor)
    sidecar_suffixes = ("-wal", "-shm", "-journal")
    sidecars_before = {}
    sidecar_descriptors = {}
    for suffix in sidecar_suffixes:
        candidate_name = source.name + suffix
        try:
            info, descriptor = attest_source_member(
                parent_descriptor,
                candidate_name,
                parent_info.st_dev,
            )
        except FileNotFoundError:
            continue
        sidecars_before[suffix] = info
        sidecar_descriptors[suffix] = descriptor
        held_descriptors.append(descriptor)
    admitted_suffixes = set(sidecars_before)
    if (
        ("-shm" in admitted_suffixes and "-wal" not in admitted_suffixes)
        or (
            "-journal" in admitted_suffixes
            and bool(admitted_suffixes & {"-wal", "-shm"})
        )
    ):
        raise ValueError("SQLite admitted sidecar topology is invalid")

    inode_view, inode_main, inode_mounts = create_inode_view(
        source_descriptor,
        sidecar_descriptors,
    )

    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(target, flags, 0o600)
    os.close(descriptor)
    created = True

    source_connection = sqlite3.connect(
        inode_main.as_uri() + "?mode=ro",
        uri=True,
        timeout=min(30.0, remaining_seconds()),
    )
    destination_connection = sqlite3.connect(
        str(target),
        timeout=min(30.0, remaining_seconds()),
    )
    try:
        source_connection.set_progress_handler(vm_progress, 1000)
        destination_connection.set_progress_handler(vm_progress, 1000)
        source_connection.execute("PRAGMA query_only=ON")
        clamp_busy_timeout(source_connection)
        clamp_busy_timeout(destination_connection)
        source_connection.execute("PRAGMA schema_version").fetchone()
        def backup_progress(_status, _remaining, _total):
            invoke_hard_stall(
                "snapshot-sqlite-backup-step",
                "Connection.backup",
            )
            remaining_seconds()

        invoke_test_phase("snapshot-sqlite-backup-step")
        source_connection.backup(
            destination_connection,
            pages=1024,
            progress=backup_progress,
            sleep=0.05,
        )
        clamp_busy_timeout(destination_connection)
        destination_connection.execute("PRAGMA journal_mode=DELETE")
        destination_connection.commit()
        clamp_busy_timeout(destination_connection)
        queue_table = destination_connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_queue_entries'",
        ).fetchone()
        if queue_table:
            # Match pinned OpenClaw's restore contract: queued outbound
            # deliveries are runtime work, not durable state. Replaying them
            # after a restore can resend stale messages to external channels.
            clamp_busy_timeout(destination_connection)
            destination_connection.execute("DELETE FROM delivery_queue_entries")
            destination_connection.commit()
            clamp_busy_timeout(destination_connection)
            invoke_test_phase("snapshot-sqlite-pre-vacuum")
            def vacuum_progress():
                invoke_hard_stall(
                    "snapshot-sqlite-pre-vacuum",
                    "VACUUM",
                )
                remaining_seconds()
                return 0
            destination_connection.set_progress_handler(vacuum_progress, 1)
            try:
                destination_connection.execute("VACUUM")
            finally:
                destination_connection.set_progress_handler(vm_progress, 1000)
        clamp_busy_timeout(destination_connection)
        invoke_test_phase("snapshot-sqlite-pre-quick-check")
        def quick_check_progress():
            invoke_hard_stall(
                "snapshot-sqlite-pre-quick-check",
                "PRAGMA quick_check",
            )
            remaining_seconds()
            return 0
        destination_connection.set_progress_handler(quick_check_progress, 1)
        try:
            if destination_connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError("SQLite snapshot integrity check failed")
        finally:
            destination_connection.set_progress_handler(vm_progress, 1000)
        assert_admitted_sqlite_topology(
            parent_descriptor,
            parent_before,
            source.name,
            before,
            source_descriptor,
            sidecars_before,
            sidecar_descriptors,
            inode_view,
        )
        snapshot_source_info = os.fstat(source_descriptor)
        snapshot_source_xattrs = bounded_xattrs_from_fd(source_descriptor)
        destination_connection.set_progress_handler(None, 0)
        source_connection.set_progress_handler(None, 0)
    finally:
        destination_connection.close()
        source_connection.close()

    cleanup_inode_view(inode_view, inode_mounts, strict=True)
    inode_view = inode_main = None
    inode_mounts = []

    after = os.stat(
        source.name,
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    if (
        source_identity(before) != source_identity(after)
        or source_identity(before) != source_identity(os.fstat(source_descriptor))
    ):
        raise ValueError("SQLite source identity changed")
    if snapshot_source_info is None or snapshot_source_xattrs is None:
        raise ValueError("SQLite snapshot metadata was not captured")
    apply_snapshot_metadata(
        target,
        snapshot_source_info,
        snapshot_source_xattrs,
    )
    final = os.lstat(target)
    if (
        not stat.S_ISREG(final.st_mode)
        or stat.S_ISLNK(final.st_mode)
        or final.st_nlink != 1
        or final.st_uid != snapshot_source_info.st_uid
        or final.st_gid != snapshot_source_info.st_gid
        or stat.S_IMODE(final.st_mode)
            != stat.S_IMODE(snapshot_source_info.st_mode)
        or final.st_size <= 0
        or any(os.path.lexists(pathlib.Path(str(target) + suffix)) for suffix in sidecar_suffixes)
    ):
        raise ValueError("SQLite snapshot did not settle safely")
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(
        target.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)

    transaction_descriptor = os.open(
        transaction_root,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        observed_transaction = os.fstat(transaction_descriptor)
        transaction_identity = (
            transaction_info.st_dev,
            transaction_info.st_ino,
            transaction_info.st_uid,
            transaction_info.st_gid,
            stat.S_IFMT(transaction_info.st_mode),
            stat.S_IMODE(transaction_info.st_mode),
        )
        if (
            (
                observed_transaction.st_dev,
                observed_transaction.st_ino,
                observed_transaction.st_uid,
                observed_transaction.st_gid,
                stat.S_IFMT(observed_transaction.st_mode),
                stat.S_IMODE(observed_transaction.st_mode),
            ) != transaction_identity
            or set(os.listdir(transaction_descriptor)) != {target.name}
        ):
            raise ValueError("SQLite snapshot transaction authority changed")
        candidate_descriptor = os.open(
            target.name,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=transaction_descriptor,
        )
        try:
            staged = os.fstat(candidate_descriptor)
            staged_xattrs = bounded_xattrs_from_fd(candidate_descriptor)
            receipt_identity = snapshot_receipt_identity(
                staged,
                staged_xattrs,
            )
            if (
                source_identity(staged) != source_identity(final)
                or staged_xattrs != snapshot_source_xattrs
                or receipt_identity
                    != snapshot_receipt_identity(final, snapshot_source_xattrs)
            ):
                raise ValueError("SQLite snapshot transaction member changed")
            receipt_document = {
                "schema": "bridgesllm.sqlite-snapshot-receipt.v1",
                "member": target.name,
                "identity": receipt_identity,
            }
            receipt_payload = (
                json.dumps(
                    receipt_document,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            if len(receipt_payload) > 8192:
                raise ValueError("SQLite snapshot receipt is unbounded")
            receipt_descriptor = os.open(
                "snapshot.receipt.json",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=transaction_descriptor,
            )
            try:
                for name, _value in bounded_xattrs_from_fd(receipt_descriptor):
                    os.removexattr(receipt_descriptor, name)
                os.fchmod(receipt_descriptor, 0o600)
                view = memoryview(receipt_payload)
                while view:
                    written = os.write(receipt_descriptor, view)
                    if written <= 0:
                        raise OSError("SQLite snapshot receipt write was short")
                    view = view[written:]
                os.fsync(receipt_descriptor)
                receipt_info = os.fstat(receipt_descriptor)
                if (
                    not stat.S_ISREG(receipt_info.st_mode)
                    or receipt_info.st_uid != 0
                    or receipt_info.st_gid != 0
                    or receipt_info.st_nlink != 1
                    or stat.S_IMODE(receipt_info.st_mode) != 0o600
                    or receipt_info.st_size != len(receipt_payload)
                    or bounded_xattrs_from_fd(receipt_descriptor)
                ):
                    raise ValueError("SQLite snapshot receipt is unsafe")
            finally:
                os.close(receipt_descriptor)
            if set(os.listdir(transaction_descriptor)) != {
                target.name,
                "snapshot.receipt.json",
            }:
                raise ValueError("SQLite snapshot transaction grew unexpectedly")
            os.fsync(candidate_descriptor)
        finally:
            os.close(candidate_descriptor)
        os.fsync(transaction_descriptor)
        invoke_test_phase("snapshot-sqlite-post-receipt")
        invoke_hard_stall(
            "snapshot-sqlite-post-receipt",
            "private receipt fsync",
        )
        remaining_seconds()
    finally:
        os.close(transaction_descriptor)
except (OSError, sqlite3.Error, ValueError):
    if inode_view is not None:
        try:
            cleanup_inode_view(inode_view, inode_mounts, strict=False)
        except OSError:
            pass
        inode_view = inode_main = None
        inode_mounts = []
    if created:
        for candidate in [target, *(pathlib.Path(str(target) + suffix) for suffix in ("-wal", "-shm", "-journal"))]:
            try:
                candidate.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
    raise SystemExit(1)
finally:
    if inode_view is not None:
        try:
            cleanup_inode_view(inode_view, inode_mounts, strict=False)
        except OSError:
            pass
    for descriptor in held_descriptors:
        try:
            os.close(descriptor)
        except OSError:
            pass
PY
  } 2>/dev/null || transaction_status=$?
  local promotion_status=0
  if (( transaction_status == 0 )); then
    python3 - "$transaction_root" "$snapshot_parent" \
      "$snapshot_database" <<'PY' 2>/dev/null || promotion_status=$?
import ctypes
import hashlib
import json
import os
import pathlib
import stat
import struct
import sys

transaction = pathlib.Path(sys.argv[1])
parent = pathlib.Path(sys.argv[2])
published_target = pathlib.Path(sys.argv[3])
if (
    not transaction.is_absolute()
    or not parent.is_absolute()
    or not published_target.is_absolute()
    or os.path.normpath(transaction) != str(transaction)
    or os.path.normpath(parent) != str(parent)
    or os.path.normpath(published_target) != str(published_target)
    or transaction.parent != parent
    or published_target.parent != parent
    or not published_target.name
    or published_target.name in {".", ".."}
    or not transaction.name.startswith(".sqlite-snapshot-transaction.")
    or len(transaction.name) <= len(".sqlite-snapshot-transaction.")
    or os.path.realpath(parent) != str(parent)
    or os.path.realpath(transaction) != str(transaction)
):
    raise SystemExit(1)

directory_flags = (
    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
file_flags = (
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NOATIME", 0)
)
RENAME_NOREPLACE = 1
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit(1)
renameat2.argtypes = [
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_uint,
]
renameat2.restype = ctypes.c_int

def directory_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_uid,
        info.st_gid,
        info.st_nlink,
    )

def bounded_xattrs_from_fd(descriptor):
    names = sorted(
        name if isinstance(name, bytes)
        else name.encode("utf-8", "surrogateescape")
        for name in os.listxattr(descriptor)
    )
    if len(names) > 1024 or len(names) != len(set(names)):
        raise ValueError("SQLite snapshot xattrs are invalid")
    result = []
    total = 0
    for name in names:
        if not name or len(name) > 255 or b"\0" in name or b"." not in name:
            raise ValueError("SQLite snapshot xattr name is unsafe")
        value = os.getxattr(descriptor, name)
        total += len(name) + len(value)
        if len(value) > 1024 * 1024 or total > 16 * 1024 * 1024:
            raise ValueError("SQLite snapshot xattrs are unbounded")
        result.append((name, value))
    return tuple(result)

def xattr_receipt_digest(attributes):
    digest = hashlib.sha256()
    for name, value in attributes:
        digest.update(struct.pack(">I", len(name)))
        digest.update(name)
        digest.update(struct.pack(">Q", len(value)))
        digest.update(value)
    return digest.hexdigest()

def candidate_receipt_identity(info, attributes):
    return {
        "device": info.st_dev,
        "inode": info.st_ino,
        "fileType": stat.S_IFMT(info.st_mode),
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "links": info.st_nlink,
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "xattrSha256": xattr_receipt_digest(attributes),
    }

def stable_file_state(info):
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        stat.S_IMODE(info.st_mode),
        info.st_uid,
        info.st_gid,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("SQLite snapshot receipt has duplicate keys")
        result[key] = value
    return result

parent_descriptor = None
transaction_descriptor = None
candidate_descriptor = None
published = False
candidate_inode = None
try:
    parent_descriptor = os.open(parent, directory_flags)
    parent_info = os.fstat(parent_descriptor)
    admitted_parent = os.lstat(parent)
    if (
        directory_identity(parent_info) != directory_identity(admitted_parent)
        or not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != 0
        or parent_info.st_gid != 0
        or parent_info.st_mode & 0o022
    ):
        raise ValueError("unsafe SQLite publication parent")
    transaction_descriptor = os.open(
        transaction.name,
        directory_flags,
        dir_fd=parent_descriptor,
    )
    transaction_info = os.fstat(transaction_descriptor)
    admitted_transaction = os.stat(
        transaction.name,
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    if (
        directory_identity(transaction_info)
            != directory_identity(admitted_transaction)
        or not stat.S_ISDIR(transaction_info.st_mode)
        or transaction_info.st_uid != 0
        or transaction_info.st_gid != 0
        or transaction_info.st_nlink != 2
        or stat.S_IMODE(transaction_info.st_mode) != 0o700
        or transaction_info.st_dev != parent_info.st_dev
        or set(os.listdir(transaction_descriptor)) != {
            "snapshot.sqlite",
            "snapshot.receipt.json",
        }
    ):
        raise ValueError("unsafe SQLite publication transaction")

    receipt_descriptor = os.open(
        "snapshot.receipt.json",
        file_flags,
        dir_fd=transaction_descriptor,
    )
    try:
        receipt_before = os.fstat(receipt_descriptor)
        if (
            not stat.S_ISREG(receipt_before.st_mode)
            or receipt_before.st_uid != 0
            or receipt_before.st_gid != 0
            or receipt_before.st_nlink != 1
            or stat.S_IMODE(receipt_before.st_mode) != 0o600
            or receipt_before.st_size <= 0
            or receipt_before.st_size > 8192
            or bounded_xattrs_from_fd(receipt_descriptor)
        ):
            raise ValueError("unsafe SQLite snapshot receipt")
        payload = b""
        while len(payload) <= 8192:
            chunk = os.read(receipt_descriptor, min(8193 - len(payload), 4096))
            if not chunk:
                break
            payload += chunk
        receipt_after = os.fstat(receipt_descriptor)
        if (
            len(payload) != receipt_before.st_size
            or len(payload) > 8192
            or stable_file_state(receipt_after) != stable_file_state(receipt_before)
            or not payload.endswith(b"\n")
        ):
            raise ValueError("SQLite snapshot receipt changed")
    finally:
        os.close(receipt_descriptor)
    document = json.loads(
        payload[:-1].decode("utf-8"),
        object_pairs_hook=unique_object,
    )
    if (
        not isinstance(document, dict)
        or set(document) != {"schema", "member", "identity"}
        or document.get("schema")
            != "bridgesllm.sqlite-snapshot-receipt.v1"
        or document.get("member") != "snapshot.sqlite"
        or not isinstance(document.get("identity"), dict)
    ):
        raise ValueError("SQLite snapshot receipt contract is invalid")
    receipt_identity = document["identity"]
    expected_identity_keys = {
        "device",
        "inode",
        "fileType",
        "mode",
        "uid",
        "gid",
        "links",
        "size",
        "mtimeNs",
        "xattrSha256",
    }
    integer_keys = expected_identity_keys - {"xattrSha256"}
    if (
        set(receipt_identity) != expected_identity_keys
        or any(type(receipt_identity.get(key)) is not int for key in integer_keys)
        or receipt_identity["device"] < 0
        or receipt_identity["inode"] <= 0
        or receipt_identity["fileType"] != stat.S_IFREG
        or receipt_identity["mode"] < 0
        or receipt_identity["mode"] > 0o7777
        or receipt_identity["mode"] & 0o022
        or receipt_identity["uid"] != 0
        or receipt_identity["gid"] != 0
        or receipt_identity["links"] != 1
        or receipt_identity["size"] <= 0
        or receipt_identity["size"] > 1024**4
        or not isinstance(receipt_identity["xattrSha256"], str)
        or len(receipt_identity["xattrSha256"]) != 64
        or any(
            character not in "0123456789abcdef"
            for character in receipt_identity["xattrSha256"]
        )
    ):
        raise ValueError("SQLite snapshot receipt identity is invalid")

    candidate_descriptor = os.open(
        "snapshot.sqlite",
        file_flags,
        dir_fd=transaction_descriptor,
    )
    candidate_info = os.fstat(candidate_descriptor)
    candidate_xattrs = bounded_xattrs_from_fd(candidate_descriptor)
    if (
        not stat.S_ISREG(candidate_info.st_mode)
        or stat.S_ISLNK(candidate_info.st_mode)
        or candidate_info.st_nlink != 1
        or candidate_receipt_identity(candidate_info, candidate_xattrs)
            != receipt_identity
    ):
        raise ValueError("SQLite snapshot candidate does not match receipt")
    candidate_inode = (candidate_info.st_dev, candidate_info.st_ino)
    if set(os.listdir(transaction_descriptor)) != {
        "snapshot.sqlite",
        "snapshot.receipt.json",
    }:
        raise ValueError("SQLite publication transaction changed")
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            os.stat(
                published_target.name + suffix,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            continue
        raise ValueError("SQLite publication target already exists")
    os.fsync(candidate_descriptor)
    if renameat2(
        transaction_descriptor,
        b"snapshot.sqlite",
        parent_descriptor,
        os.fsencode(published_target.name),
        RENAME_NOREPLACE,
    ) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    published = True
    promoted = os.stat(
        published_target.name,
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    sidecars_absent = True
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            os.stat(
                published_target.name + suffix,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            continue
        sidecars_absent = False
        break
    if (
        candidate_receipt_identity(promoted, candidate_xattrs)
            != receipt_identity
        or not sidecars_absent
        or set(os.listdir(transaction_descriptor))
            != {"snapshot.receipt.json"}
    ):
        raise ValueError("SQLite snapshot changed during publication")
    os.fsync(transaction_descriptor)
    os.fsync(parent_descriptor)
except (OSError, ValueError, UnicodeError):
    if published and parent_descriptor is not None and candidate_inode is not None:
        try:
            observed = os.stat(
                published_target.name,
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
            if (observed.st_dev, observed.st_ino) == candidate_inode:
                os.unlink(published_target.name, dir_fd=parent_descriptor)
                os.fsync(parent_descriptor)
        except OSError:
            pass
    raise SystemExit(1)
finally:
    if candidate_descriptor is not None:
        os.close(candidate_descriptor)
    if transaction_descriptor is not None:
        os.close(transaction_descriptor)
    if parent_descriptor is not None:
        os.close(parent_descriptor)
PY
  fi
  local cleanup_status=0
  python3 - "$transaction_root" "$snapshot_parent" <<'PY' || cleanup_status=$?
import os
import pathlib
import stat
import sys

transaction = pathlib.Path(sys.argv[1])
parent = pathlib.Path(sys.argv[2])
if (
    not transaction.is_absolute()
    or not parent.is_absolute()
    or os.path.normpath(transaction) != str(transaction)
    or os.path.normpath(parent) != str(parent)
    or transaction.parent != parent
    or not transaction.name.startswith(".sqlite-snapshot-transaction.")
    or len(transaction.name) <= len(".sqlite-snapshot-transaction.")
    or os.path.realpath(parent) != str(parent)
):
    raise SystemExit(1)

directory_flags = (
    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
parent_descriptor = os.open(parent, directory_flags)
transaction_descriptor = None
try:
    parent_info = os.fstat(parent_descriptor)
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != 0
        or parent_info.st_gid != 0
        or parent_info.st_mode & 0o022
    ):
        raise ValueError("unsafe SQLite transaction parent")
    transaction_descriptor = os.open(
        transaction.name,
        directory_flags,
        dir_fd=parent_descriptor,
    )
    transaction_info = os.fstat(transaction_descriptor)
    admitted = os.stat(
        transaction.name,
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    if (
        (transaction_info.st_dev, transaction_info.st_ino)
        != (admitted.st_dev, admitted.st_ino)
        or transaction_info.st_uid != 0
        or transaction_info.st_gid != 0
        or stat.S_IMODE(transaction_info.st_mode) != 0o700
    ):
        raise ValueError("unsafe SQLite transaction root")

    def remove_children(directory_descriptor):
        entries = list(os.scandir(directory_descriptor))
        for entry in entries:
            entry_info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(entry_info.st_mode):
                child = os.open(
                    entry.name,
                    directory_flags,
                    dir_fd=directory_descriptor,
                )
                try:
                    opened = os.fstat(child)
                    if (opened.st_dev, opened.st_ino) != (
                        entry_info.st_dev,
                        entry_info.st_ino,
                    ):
                        raise ValueError("SQLite transaction child changed")
                    remove_children(child)
                finally:
                    os.close(child)
                os.rmdir(entry.name, dir_fd=directory_descriptor)
            else:
                os.unlink(entry.name, dir_fd=directory_descriptor)

    remove_children(transaction_descriptor)
    os.fsync(transaction_descriptor)
finally:
    if transaction_descriptor is not None:
        os.close(transaction_descriptor)
try:
    os.rmdir(transaction.name, dir_fd=parent_descriptor)
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)
PY
  if (( cleanup_status != 0 )); then
    if (( transaction_status == 0 && promotion_status == 0 )); then
      rm -f -- "$snapshot_database" \
        "$snapshot_database-wal" \
        "$snapshot_database-shm" \
        "$snapshot_database-journal"
    fi
    return 1
  fi
  if (( transaction_status == 124 || transaction_status == 137 )); then
    printf '%s\n' 'SQLite snapshot hard deadline was exceeded' >&2
    return 1
  fi
  (( transaction_status == 0 && promotion_status == 0 ))
}

materialize_openclaw_snapshot_database_list() {
  local source_dir="$1"
  local target="$2"
  python3 - "${source_dir}" "${target}" <<'PY'
import os
import pathlib
import re
import stat
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
if (
    not source.is_absolute()
    or os.path.normpath(source) != str(source)
    or os.path.realpath(source) != str(source)
    or not target.is_absolute()
    or os.path.normpath(target) != str(target)
    or os.path.lexists(target)
):
    raise SystemExit(1)
codex_pattern = re.compile(r"^(goals|memories)_[0-9]+\.sqlite(?:(-wal|-shm|-journal))?$")
agent_pattern = re.compile(r"^openclaw-agent\.sqlite(?:(-wal|-shm|-journal))?$")
safe_agent_id = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
bases = set()
sidecar_bases = set()
for current_raw, directory_names, file_names in os.walk(source, followlinks=False):
    current = pathlib.Path(current_raw)
    # These trees are either globally excluded or cannot contain another
    # Codex home. Pruning keeps discovery bounded on large plugin catalogues.
    directory_names[:] = [
        name for name in directory_names
        if name not in {".tmp", "tmp", "cache", "sessions", "shell_snapshots", "node_modules", ".git"}
    ]
    relative_parts = current.relative_to(source).parts
    is_codex_home = current.name == "codex-home" and current.parent.name == "agent"
    is_agent_home = (
        len(relative_parts) == 3
        and relative_parts[0] == "agents"
        and safe_agent_id.fullmatch(relative_parts[1]) is not None
        and relative_parts[2] == "agent"
    )
    if not is_codex_home and not is_agent_home:
        continue
    info = os.lstat(current)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_mode & 0o022
    ):
        raise SystemExit(1)
    for name in file_names:
        match = (
            codex_pattern.fullmatch(name)
            if is_codex_home
            else agent_pattern.fullmatch(name)
        )
        if match is None:
            continue
        relative = (current / name).relative_to(source).as_posix()
        suffix = match.group(2) if is_codex_home else match.group(1)
        base = relative.removesuffix(suffix or "")
        if suffix:
            sidecar_bases.add(base)
        else:
            bases.add(base)
if not sidecar_bases.issubset(bases) or len(bases) > 4096:
    raise SystemExit(1)
descriptor = os.open(
    target,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
    0o600,
)
try:
    payload = b"".join(value.encode("utf-8") + b"\0" for value in sorted(bases))
    if payload and os.write(descriptor, payload) != len(payload):
        raise SystemExit(1)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

archive_openclaw_state_component() {
  local component_id="$1"
  local source_dir="$2"
  local target="$3"
  local max_attempts="$4"
  shift 4
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] \
    || die "Archive retry count must be a positive integer: ${component_id}"
  local attempt=1
  local source_database="${source_dir}/state/openclaw.sqlite"
  while true; do
    local snapshot_parent overlay_root snapshot_database
    local database_list_before database_list_after relative_database
    snapshot_parent="$(mktemp -d "${STAGING_DIR}/.openclaw-snapshot-XXXXXX")" \
      || die "OpenClaw SQLite snapshot staging could not be allocated"
    chmod 700 "${snapshot_parent}"
    overlay_root="${snapshot_parent}/$(basename "${source_dir}")"
    snapshot_database="${overlay_root}/state/openclaw.sqlite"
    mkdir -p -m 700 "$(dirname "${snapshot_database}")"
    database_list_before="${snapshot_parent}/codex-databases.before"
    database_list_after="${snapshot_parent}/codex-databases.after"
    local snapshot_present=false attempt_ok=false
    local -a overlay_options=()
    if [[ -e "${source_database}" || -L "${source_database}" ]]; then
      if [[ -f "${source_database}" && ! -L "${source_database}" ]] \
        && snapshot_sqlite_database "${source_database}" "${snapshot_database}"; then
        snapshot_present=true
        overlay_options=(
          "--overlay-root=${overlay_root}"
          '--overlay-relative=state/openclaw.sqlite'
        )
      fi
    elif [[ ! -e "${source_database}-wal" && ! -L "${source_database}-wal" \
      && ! -e "${source_database}-shm" && ! -L "${source_database}-shm" \
      && ! -e "${source_database}-journal" && ! -L "${source_database}-journal" ]]; then
      snapshot_present=false
    fi

    local codex_snapshots_ok=true
    local -a codex_databases=()
    if ! materialize_openclaw_snapshot_database_list \
        "${source_dir}" "${database_list_before}"; then
      codex_snapshots_ok=false
    elif [[ -s "${database_list_before}" ]]; then
      mapfile -d '' -t codex_databases < "${database_list_before}"
    fi
    if $codex_snapshots_ok; then
      for relative_database in "${codex_databases[@]}"; do
        mkdir -p -m 700 "$(dirname "${overlay_root}/${relative_database}")"
        if ! snapshot_sqlite_database \
            "${source_dir}/${relative_database}" \
            "${overlay_root}/${relative_database}"; then
          codex_snapshots_ok=false
          break
        fi
        [[ -n "${overlay_options[*]:-}" ]] \
          || overlay_options=("--overlay-root=${overlay_root}")
        overlay_options+=("--overlay-relative=${relative_database}")
      done
    fi

    if $codex_snapshots_ok \
      && { $snapshot_present || [[ ! -e "${source_database}" && ! -L "${source_database}" ]]; }; then
      if archive_dir "$source_dir" "$target" \
          --exclude='state/openclaw.sqlite' \
          --exclude='state/openclaw.sqlite-wal' \
          --exclude='state/openclaw.sqlite-shm' \
          --exclude='state/openclaw.sqlite-journal' \
          --exclude='agents/*/agent/openclaw-agent.sqlite*' \
          --exclude='*/agent/codex-home/goals_*.sqlite*' \
          --exclude='*/agent/codex-home/memories_*.sqlite*' \
          "$@" "${overlay_options[@]}"; then
        if materialize_openclaw_snapshot_database_list \
            "${source_dir}" "${database_list_after}" \
          && cmp -s -- "${database_list_before}" "${database_list_after}" \
          && { $snapshot_present \
          || [[ ! -e "${source_database}" && ! -L "${source_database}" \
            && ! -e "${source_database}-wal" && ! -L "${source_database}-wal" \
            && ! -e "${source_database}-shm" && ! -L "${source_database}-shm" \
            && ! -e "${source_database}-journal" && ! -L "${source_database}-journal" ]]; }; then
          attempt_ok=true
        else
          rm -f -- "$target"
        fi
      elif [[ "${ARCHIVE_CLEANUP_FAILED}" == "true" ]]; then
        local fatal_detail="${ARCHIVE_FAILURE_DETAIL:-Private archive cleanup failed closed}"
        if ! rm -rf -- "${snapshot_parent}"; then
          fatal_detail="${fatal_detail}; OpenClaw snapshot cleanup also failed closed"
        fi
        die "${fatal_detail}"
      fi
    fi
    rm -rf -- "${snapshot_parent}"
    if $attempt_ok; then
      break
    fi
    rm -f -- "$target"
    if (( attempt >= max_attempts )); then
      record_degraded_component \
        "$component_id" required "$source_dir" \
        "Required recovery source or SQLite snapshot could not be archived after ${max_attempts} attempts"
      return 0
    fi
    log "Recovery source or SQLite snapshot changed during capture; retrying ${component_id} ($(( attempt + 1 ))/${max_attempts})"
    (( attempt += 1 ))
    sleep 1
  done
  local capture_method
  capture_method="$(archive_capture_method)"
  record_recovery_component \
    "$component_id" required captured "$(basename "$target")" "$source_dir" \
    "$capture_method" "" "" "" "" "${ARCHIVE_LIVE_RECONCILIATION:-}"
}

record_degraded_component() {
  local component_id="$1"
  local requirement="$2"
  local source="$3"
  local reason="$4"
  record_recovery_component \
    "$component_id" "$requirement" degraded "" "$source" "" "$reason"
  RUN_DEGRADED=true
  RUN_DEGRADED_COMPONENTS+=("$component_id")
  log "WARNING: recovery component is degraded: ${component_id} (${reason})"
}

record_absent_component() {
  local component_id="$1"
  local source_dir="$2"
  local absence_reason="$3"
  [[ ! -e "$source_dir" && ! -L "$source_dir" ]] \
    || die "Recovery source cannot be recorded absent because an inode exists: ${component_id} (${source_dir})"
  record_recovery_component \
    "$component_id" optional not-configured "" "$source_dir" "" "$absence_reason"
}

archive_optional_component() {
  local component_id="$1"
  local source_dir="$2"
  local target="$3"
  local absence_reason="$4"
  shift 4
  if [[ -d "$source_dir" && ! -L "$source_dir" ]]; then
    if ! archive_dir "$source_dir" "$target" "$@"; then
      if [[ "${ARCHIVE_CLEANUP_FAILED}" == "true" ]]; then
        die "${ARCHIVE_FAILURE_DETAIL:-Private archive cleanup failed closed}"
      fi
      record_degraded_component \
        "$component_id" optional "$source_dir" \
        "Optional recovery source was present but could not be archived"
      return 0
    fi
    local capture_method
    capture_method="$(archive_capture_method)"
    record_recovery_component \
      "$component_id" optional captured "$(basename "$target")" "$source_dir" \
      "$capture_method" "" "" "" "" "${ARCHIVE_LIVE_RECONCILIATION:-}"
  else
    record_absent_component "$component_id" "$source_dir" "$absence_reason"
  fi
}

archive_configured_feature_component() {
  local component_id="$1"
  local source_dir="$2"
  local target="$3"
  local absence_reason="$4"
  shift 4
  if [[ -d "$source_dir" && ! -L "$source_dir" ]]; then
    archive_required_component "$component_id" "$source_dir" "$target" "$@"
    return
  fi
  record_absent_component "$component_id" "$source_dir" "$absence_reason"
}

copy_required_component() {
  local component_id="$1"
  local source_file="$2"
  local target="$3"
  [[ "$source_file" == /* && -s "$source_file" && -f "$source_file" && ! -L "$source_file" ]] \
    || die "Required recovery file is missing or unsafe: ${component_id} (${source_file})"
  cp -- "$source_file" "$target"
  [[ -s "$target" && -f "$target" && ! -L "$target" ]] \
    || die "Required recovery file could not be copied: ${component_id} (${source_file})"
  record_recovery_component \
    "$component_id" required captured "${target#"${STAGING_DIR}"/}" "$source_file" file-copy
}

finalize_recovery_manifest() {
  local output="$1"
  local backup_type="$2"
  local database_identity="$3"
  local install_profile=""
  local portal_version=""
  local authority_env=""
  authority_env="$(backup_database_authority_environment)" \
    || die "Sealed backup environment authority is unavailable"
  install_profile="$(read_env_value "$authority_env" INSTALL_PROFILE 2>/dev/null || true)"
  portal_version="$(python3 - "${PORTAL_DIR}/backend/package.json" <<'PY2'
import json
import re
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        value = json.load(handle).get("version", "")
except (OSError, ValueError):
    value = ""
if isinstance(value, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", value):
    print(value)
PY2
)"
  RECOVERY_BACKUP_TYPE="$backup_type" \
  RECOVERY_CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  RECOVERY_INSTALL_PROFILE="${install_profile:-unknown}" \
  RECOVERY_PORTAL_VERSION="${portal_version}" \
  RECOVERY_DIRECTORY_CONSISTENCY="service-database-quiesced-v2" \
  python3 - "$RECOVERY_COMPONENTS_FILE" "$database_identity" "$output" <<'PY'
import json
import os
import pathlib
import re
import stat
import sys

components_path, identity_path_raw, output_path = sys.argv[1:]
with open(components_path, "r", encoding="utf-8") as handle:
    components = [json.loads(line) for line in handle if line.strip()]
identity_path = pathlib.Path(identity_path_raw)
identity_info = os.lstat(identity_path)
if (
    not stat.S_ISREG(identity_info.st_mode)
    or stat.S_ISLNK(identity_info.st_mode)
    or identity_info.st_uid != 0
    or identity_info.st_gid != 0
    or identity_info.st_nlink != 1
    or stat.S_IMODE(identity_info.st_mode) != 0o600
    or identity_info.st_size <= 0
    or identity_info.st_size > 16384
):
    raise SystemExit(1)
database_identity = json.load(open(identity_path, "r", encoding="utf-8"))
if (
    not isinstance(database_identity, dict)
    or database_identity.get("schema")
        != "bridgesllm.postgresql-database-identity.v1"
):
    raise SystemExit(1)
profile = os.environ["RECOVERY_INSTALL_PROFILE"]
if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", profile):
    profile = "custom"
payload = {
    "schema": "bridgesllm.portal-recovery.v3",
    "backupType": os.environ["RECOVERY_BACKUP_TYPE"],
    "createdAt": os.environ["RECOVERY_CREATED_AT"],
    "portalVersion": os.environ["RECOVERY_PORTAL_VERSION"] or None,
    "installationProfile": profile,
    "directoryConsistency": os.environ["RECOVERY_DIRECTORY_CONSISTENCY"],
    "metadataProfile": "linux-pax-mtime-xattrs-sparse-v1",
    "databaseIdentity": database_identity,
    "components": components,
}
with open(output_path, "x", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  rm -f -- "$database_identity"
  rm -f -- "$RECOVERY_COMPONENTS_FILE"
  RECOVERY_COMPONENTS_FILE=""
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
    weekly) printf 'portal-weekly-%s.tar.gz\n' "$TIMESTAMP" ;;
    monthly) printf 'portal-monthly-%s.tar.gz\n' "$TIMESTAMP" ;;
    comprehensive) printf 'portal-comprehensive-%s.tar.gz\n' "$TIMESTAMP" ;;
    *) die "Unknown backup type: $1" ;;
  esac
}

write_backup_publication_receipt() {
  local candidate_archive="$1" published_archive="$2"
  local backup_type="$3" completeness="$4" manifest_record="$5"
  shift 5
  [[ "${BACKUP_CAPACITY_STATE}" == "verified" \
    && "${BACKUP_SELECTED_PUBLICATION_ROLE}" =~ ^(complete|degraded)$ ]] \
    || return 1
  BACKUP_CAPACITY_STATE="receipt-writing"
  assert_backup_capacity_guard || return 1
  if ! python3 - "${candidate_archive}" "${published_archive}" \
    "${BACKUP_HMAC_KEY}" "${backup_type}" "${completeness}" \
    "${manifest_record}" "${BACKUP_CAPACITY_GUARD_PLAN}" \
    "${BACKUP_CAPACITY_GUARD_LEASES}" \
    "${BACKUP_CAPACITY_GUARD_HOST_PID}" \
    "${BACKUP_SELECTED_PUBLICATION_ROLE}" "$@" <<'PY'
import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import sys

(
    candidate_raw,
    published_raw,
    key_raw,
    backup_type,
    completeness,
    manifest_raw,
    plan_raw,
    resources_raw,
    holder_host_pid_raw,
    role,
    *components,
) = sys.argv[1:]
candidate = pathlib.Path(candidate_raw)
published = pathlib.Path(published_raw)
key_path = pathlib.Path(key_raw)
manifest_path = pathlib.Path(manifest_raw)
receipt = pathlib.Path(str(published) + ".receipt.json")
schema = "bridgesllm.backup-publication.v1"
plan = json.loads(plan_raw)
resources = json.loads(resources_raw)
holder_host_pid = int(holder_host_pid_raw)

def safe_regular(path, *, mode=None, maximum=None):
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
        or (maximum is not None and info.st_size > maximum)
    ):
        raise SystemExit(1)
    return info

if (
    plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") != "create"
    or role not in {"complete", "degraded"}
    or not candidate.is_absolute()
    or os.path.normpath(candidate_raw) != candidate_raw
    or not published.is_absolute()
    or os.path.normpath(published_raw) != published_raw
    or not re.fullmatch(r"portal-(daily|weekly|monthly|comprehensive)-[A-Za-z0-9._-]+\.tar\.gz", published.name)
    or backup_type not in {"daily", "weekly", "monthly", "comprehensive"}
    or completeness not in {"complete", "degraded"}
    or len(components) != len(set(components))
    or components != sorted(components)
    or any(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value) is None for value in components)
    or (completeness == "complete" and components)
    or (completeness == "degraded" and not components)
    or (role == "complete") != (completeness == "complete")
):
    raise SystemExit(1)

targets = [
    target for target in plan.get("publicationTargets", [])
    if target.get("role") == role
]
archive_entries = [
    entry for entry in resources.get("entries", [])
    if entry.get("kind") == "archive-candidate"
    and entry.get("role") == role
]
receipt_entries = [
    entry for entry in resources.get("entries", [])
    if entry.get("kind") == "receipt-candidate"
    and entry.get("role") == role
]
if len(targets) != 1 or len(archive_entries) != 1 or len(receipt_entries) != 1:
    raise SystemExit(1)
target = targets[0]
archive_entry = archive_entries[0]
receipt_entry = receipt_entries[0]
expected_candidate = pathlib.Path(target["parent"]) / target["partialName"]
expected_receipt = pathlib.Path(target["parent"]) / target["receiptName"]
expected_published = pathlib.Path(target["parent"]) / target[
    "receiptName"
].removesuffix(".receipt.json")
if (
    candidate != expected_candidate
    or published != expected_published
    or receipt != expected_receipt
    or resources.get("holderHostPid") != holder_host_pid
    or archive_entry.get("parent") != target["parent"]
    or archive_entry.get("pathName") != target["partialName"]
    or archive_entry.get("reservedBytes") != target["candidateBytes"]
    or receipt_entry.get("parent") != target["parent"]
    or receipt_entry.get("pathName") != target["receiptName"]
    or receipt_entry.get("reservedBytes") != target["receiptBytes"]
):
    raise SystemExit(1)

archive_info = safe_regular(candidate, mode=0o600)
key_info = safe_regular(key_path, mode=0o600, maximum=32)
manifest_info = safe_regular(manifest_path, mode=0o600, maximum=16 * 1024)
if archive_info.st_size <= 0 or key_info.st_size != 32 or manifest_info.st_size <= 0:
    raise SystemExit(1)
held_archive = os.stat(
    f"/proc/{holder_host_pid}/fd/{archive_entry['fd']}"
)
if (
    held_archive.st_dev != archive_entry["device"]
    or held_archive.st_ino != archive_entry["inode"]
    or (archive_info.st_dev, archive_info.st_ino)
        != (held_archive.st_dev, held_archive.st_ino)
    or held_archive.st_size != archive_info.st_size
):
    raise SystemExit(1)
key = key_path.read_bytes()
if len(key) != 32:
    raise SystemExit(1)
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
manifest_hmac = manifest.get("manifestHmac")
if not isinstance(manifest_hmac, str) or re.fullmatch(r"[0-9a-f]{64}", manifest_hmac) is None:
    raise SystemExit(1)

fields = [
    schema,
    published.name,
    backup_type,
    completeness,
    str(archive_info.st_size),
    str(archive_info.st_mtime_ns),
    manifest_hmac,
    str(len(components)),
    *components,
]
signed_payload = ("\0".join(fields) + "\0").encode("utf-8")
payload = {
    "schema": schema,
    "archive": published.name,
    "backupType": backup_type,
    "completeness": completeness,
    "archiveSize": archive_info.st_size,
    "archiveMtimeNs": str(archive_info.st_mtime_ns),
    "manifestHmac": manifest_hmac,
    "degradedComponents": components,
    "signature": hmac.new(key, signed_payload, hashlib.sha256).hexdigest(),
}
payload_bytes = (
    json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n"
).encode("ascii")
bound = target["receiptBytes"]
if not payload_bytes or len(payload_bytes) > bound:
    raise SystemExit(1)

parent_descriptor = os.open(
    target["parent"],
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0),
)
descriptor = os.open(
    f"/proc/{holder_host_pid}/fd/{receipt_entry['fd']}",
    os.O_RDWR | getattr(os, "O_CLOEXEC", 0),
)
try:
    parent_info = os.fstat(parent_descriptor)
    mount_ids = []
    with open(
        f"/proc/self/fdinfo/{parent_descriptor}", "r", encoding="ascii"
    ) as handle:
        for line in handle:
            if line.startswith("mnt_id:"):
                mount_ids.append(line.partition(":")[2].strip())
    initial = os.fstat(descriptor)
    named = os.lstat(receipt)
    if (
        parent_info.st_dev != target["device"]
        or parent_info.st_ino != target["inode"]
        or mount_ids != [str(target["mountId"])]
        or not stat.S_ISREG(initial.st_mode)
        or initial.st_uid != 0
        or initial.st_gid != 0
        or stat.S_IMODE(initial.st_mode) != 0o600
        or initial.st_nlink != 1
        or initial.st_dev != receipt_entry["device"]
        or initial.st_ino != receipt_entry["inode"]
        or initial.st_size != bound
        or initial.st_blocks * 512 < bound
        or not stat.S_ISREG(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or (named.st_dev, named.st_ino)
            != (initial.st_dev, initial.st_ino)
    ):
        raise OSError("backup receipt candidate authority changed")
    os.lseek(descriptor, 0, os.SEEK_SET)
    try:
        view = memoryview(payload_bytes)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("backup receipt candidate write was short")
            view = view[written:]
        os.ftruncate(descriptor, len(payload_bytes))
        os.fsync(descriptor)
    except BaseException:
        try:
            os.ftruncate(descriptor, bound)
            os.posix_fallocate(descriptor, 0, bound)
            os.fsync(descriptor)
        except OSError:
            pass
        raise
    settled = os.fstat(descriptor)
    named = os.lstat(receipt)
    if (
        settled.st_dev != initial.st_dev
        or settled.st_ino != initial.st_ino
        or settled.st_size != len(payload_bytes)
        or settled.st_blocks * 512 < len(payload_bytes)
        or settled.st_nlink != 1
        or os.pread(descriptor, len(payload_bytes) + 1, 0) != payload_bytes
        or not stat.S_ISREG(named.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or (named.st_dev, named.st_ino)
            != (settled.st_dev, settled.st_ino)
    ):
        raise OSError("backup receipt candidate changed while settling")
    os.fsync(parent_descriptor)
finally:
    os.close(descriptor)
    os.close(parent_descriptor)
PY
  then
    return 1
  fi
  BACKUP_CAPACITY_STATE="receipt-settled"
  assert_backup_capacity_guard
}

publish_backup_candidate() {
  local candidate_archive="$1" published_archive="$2" role="$3"
  [[ "${BACKUP_CAPACITY_STATE}" == "receipt-settled" \
    && "${BACKUP_SELECTED_PUBLICATION_ROLE}" == "${role}" \
    && "${role}" =~ ^(complete|degraded)$ \
    && "${candidate_archive}" == "${PARTIAL_ARCHIVE}" \
    && "${published_archive}" == /* \
    && "${BACKUP_PUBLICATION_COMMITTED}" == "false" ]] || return 1
  BACKUP_CAPACITY_STATE="publishing"
  assert_backup_capacity_guard || return 1
  if ! python3 - "${candidate_archive}" "${published_archive}" \
    "${BACKUP_CAPACITY_GUARD_PLAN}" \
    "${BACKUP_CAPACITY_GUARD_LEASES}" \
    "${BACKUP_CAPACITY_GUARD_HOST_PID}" "${role}" <<'PY'
import ctypes
import json
import os
import pathlib
import stat
import sys

candidate = pathlib.Path(sys.argv[1])
published = pathlib.Path(sys.argv[2])
plan = json.loads(sys.argv[3])
resources = json.loads(sys.argv[4])
holder_host_pid = int(sys.argv[5])
role = sys.argv[6]
if (
    plan.get("schema") != "bridgesllm.backup-capacity-plan.v3"
    or plan.get("mode") != "create"
    or role not in {"complete", "degraded"}
    or not candidate.is_absolute()
    or os.path.normpath(candidate) != str(candidate)
    or not published.is_absolute()
    or os.path.normpath(published) != str(published)
):
    raise SystemExit(1)
targets = [
    target for target in plan.get("publicationTargets", [])
    if target.get("role") == role
]
archive_entries = [
    entry for entry in resources.get("entries", [])
    if entry.get("kind") == "archive-candidate"
    and entry.get("role") == role
]
receipt_entries = [
    entry for entry in resources.get("entries", [])
    if entry.get("kind") == "receipt-candidate"
    and entry.get("role") == role
]
if len(targets) != 1 or len(archive_entries) != 1 or len(receipt_entries) != 1:
    raise SystemExit(1)
target = targets[0]
archive_entry = archive_entries[0]
receipt_entry = receipt_entries[0]
expected_candidate = pathlib.Path(target["parent"]) / target["partialName"]
expected_published = pathlib.Path(target["parent"]) / target[
    "receiptName"
].removesuffix(".receipt.json")
receipt = pathlib.Path(target["parent"]) / target["receiptName"]
if (
    candidate != expected_candidate
    or published != expected_published
    or resources.get("holderHostPid") != holder_host_pid
):
    raise SystemExit(1)
parent_descriptor = os.open(
    target["parent"],
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    | getattr(os, "O_CLOEXEC", 0),
)
try:
    parent_info = os.fstat(parent_descriptor)
    mount_ids = []
    with open(
        f"/proc/self/fdinfo/{parent_descriptor}", "r", encoding="ascii"
    ) as handle:
        for line in handle:
            if line.startswith("mnt_id:"):
                mount_ids.append(line.partition(":")[2].strip())
    held_archive = os.stat(
        f"/proc/{holder_host_pid}/fd/{archive_entry['fd']}"
    )
    held_receipt = os.stat(
        f"/proc/{holder_host_pid}/fd/{receipt_entry['fd']}"
    )
    named_archive = os.stat(
        target["partialName"],
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    named_receipt = os.stat(
        target["receiptName"],
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    if (
        parent_info.st_dev != target["device"]
        or parent_info.st_ino != target["inode"]
        or mount_ids != [str(target["mountId"])]
        or not stat.S_ISREG(held_archive.st_mode)
        or not stat.S_ISREG(named_archive.st_mode)
        or stat.S_ISLNK(named_archive.st_mode)
        or (held_archive.st_dev, held_archive.st_ino)
            != (archive_entry["device"], archive_entry["inode"])
        or (named_archive.st_dev, named_archive.st_ino)
            != (held_archive.st_dev, held_archive.st_ino)
        or held_archive.st_size <= 0
        or held_archive.st_size > archive_entry["reservedBytes"]
        or not stat.S_ISREG(held_receipt.st_mode)
        or not stat.S_ISREG(named_receipt.st_mode)
        or stat.S_ISLNK(named_receipt.st_mode)
        or (held_receipt.st_dev, held_receipt.st_ino)
            != (receipt_entry["device"], receipt_entry["inode"])
        or (named_receipt.st_dev, named_receipt.st_ino)
            != (held_receipt.st_dev, held_receipt.st_ino)
        or held_receipt.st_size <= 0
        or held_receipt.st_size > receipt_entry["reservedBytes"]
    ):
        raise OSError("backup publication candidate authority changed")
    try:
        os.stat(
            published.name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("backup publication target exists")
    receipt_descriptor = os.open(
        f"/proc/{holder_host_pid}/fd/{receipt_entry['fd']}",
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        raw_receipt = os.pread(
            receipt_descriptor,
            receipt_entry["reservedBytes"] + 1,
            0,
        )
    finally:
        os.close(receipt_descriptor)
    try:
        document = json.loads(raw_receipt)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise OSError("backup publication receipt is invalid")
    if (
        not isinstance(document, dict)
        or document.get("schema") != "bridgesllm.backup-publication.v1"
        or document.get("archive") != published.name
        or document.get("archiveSize") != held_archive.st_size
        or document.get("archiveMtimeNs") != str(held_archive.st_mtime_ns)
    ):
        raise OSError("backup publication receipt does not bind its archive")
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise OSError("renameat2 publication authority is unavailable")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    RENAME_NOREPLACE = 1
    if renameat2(
        parent_descriptor,
        os.fsencode(target["partialName"]),
        parent_descriptor,
        os.fsencode(published.name),
        RENAME_NOREPLACE,
    ) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    os.fsync(parent_descriptor)
    settled = os.stat(
        published.name,
        dir_fd=parent_descriptor,
        follow_symlinks=False,
    )
    if (
        not stat.S_ISREG(settled.st_mode)
        or stat.S_ISLNK(settled.st_mode)
        or (settled.st_dev, settled.st_ino)
            != (held_archive.st_dev, held_archive.st_ino)
    ):
        raise OSError("published backup inode changed")
finally:
    os.close(parent_descriptor)
PY
  then
    return 1
  fi
  BACKUP_CAPACITY_STATE="published"
  assert_backup_capacity_guard || return 1
  BACKUP_PUBLICATION_COMMITTED=true
  assert_backup_capacity_guard
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

remove_backup_with_receipt() {
  local archive="$1"
  python3 - "$archive" <<'PY'
import os
import pathlib
import re
import stat
import sys

archive = pathlib.Path(sys.argv[1])
receipt = pathlib.Path(str(archive) + ".receipt.json")
if (
    not archive.is_absolute()
    or os.path.normpath(str(archive)) != str(archive)
    or re.fullmatch(
        r"portal-(?:daily|weekly|monthly|comprehensive)-[A-Za-z0-9._-]+\.tar\.gz",
        archive.name,
    ) is None
):
    raise SystemExit(1)
parent = archive.parent
parent_info = os.lstat(parent)
if (
    not stat.S_ISDIR(parent_info.st_mode)
    or stat.S_ISLNK(parent_info.st_mode)
    or parent_info.st_uid != 0
    or parent_info.st_gid != 0
    or parent_info.st_mode & 0o022
):
    raise SystemExit(1)

def admitted_file(path):
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
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

archive_identity = admitted_file(archive)
if os.path.lexists(receipt):
    admitted_file(receipt)
    os.unlink(receipt)
    directory_descriptor = os.open(
        parent,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
if admitted_file(archive) != archive_identity:
    raise SystemExit(1)
os.unlink(archive)
directory_descriptor = os.open(
    parent,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0),
)
try:
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)
PY
}

prune_backups() {
  local type="$1"
  local dir="${BACKUP_BASE}/${type}"
  local keep
  keep="$(keep_count_for_type "$type")"

  [[ -d "$dir" ]] || return 0
  local -a candidates=()
  mapfile -t candidates < <(
    find "$dir" -maxdepth 1 -type f -name 'portal-*.tar.gz' -printf '%T@ %p\n' \
      | sort -nr \
      | cut -d' ' -f2-
  )
  local unlocked_seen=0
  local old_backup
  for old_backup in "${candidates[@]}"; do
    [[ -e "${old_backup}.locked" ]] && continue
    ((unlocked_seen += 1))
    if (( unlocked_seen > keep )); then
      log "Pruning old backup: ${old_backup}"
      remove_backup_with_receipt "$old_backup"
    fi
  done
  fsync_directory "$dir"
}

prune_degraded_backups() {
  local type="$1"
  local dir="${BACKUP_BASE}/degraded/${type}"
  [[ "${DEGRADED_KEEP}" =~ ^[0-9]+$ && "${DEGRADED_KEEP}" -le 100 ]] \
    || die "DEGRADED_KEEP must be an integer between 0 and 100"
  [[ -d "$dir" ]] || return 0
  local -a candidates=()
  mapfile -t candidates < <(
    find "$dir" -maxdepth 1 -type f -name 'portal-*.tar.gz' -printf '%T@ %p\n' \
      | sort -nr \
      | cut -d' ' -f2-
  )
  local unlocked_seen=0
  local old_backup
  for old_backup in "${candidates[@]}"; do
    [[ -e "${old_backup}.locked" ]] && continue
    ((unlocked_seen += 1))
    if (( unlocked_seen > DEGRADED_KEEP )); then
      log "Pruning old degraded backup: ${old_backup}"
      remove_backup_with_receipt "$old_backup"
    fi
  done
  fsync_directory "$dir"
}

verify_recovery_contract() {
  local directory="$1"
  local allow_degraded="${2:-false}"
  [[ "$allow_degraded" == "true" || "$allow_degraded" == "false" ]] || return 1
  python3 - "$directory" "${BACKUP_PG_RESTORE_BIN}" \
    "${BACKUP_POSTGRESQL_CLIENT_MAJOR}" "${PORTAL_APP_SOURCES_DIR}" \
    "$allow_degraded" <<'PY'
import decimal
import json
import os
import pathlib
import posixpath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

root = pathlib.Path(sys.argv[1])
pg_restore = pathlib.Path(sys.argv[2])
postgres_major = int(sys.argv[3])
portal_app_sources = pathlib.Path(sys.argv[4])
allow_degraded = sys.argv[5] == "true"
manifest_path = root / "RECOVERY-MANIFEST.json"
core_payloads = {
    "database": "database.dump",
    "portal-install": "portal-install.tar.gz",
    "portal-environment": "configs/portal-backend.env.production",
    "hosted-apps": "apps.tar.gz",
    "portal-app-sources": "portal-app-sources.tar.gz",
    "portal-files": "portal-files.tar.gz",
    "upload-storage": "uploads.tar.gz",
    "projects": "projects.tar.gz",
    "portal-backend-state": "portal-backend-state.tar.gz",
    "portal-state": "portal-state.tar.gz",
    "portal-assets": "portal-assets.tar.gz",
}

def fail(message):
    raise ValueError(message)

def safe_regular_payload(path, maximum, *, exact_mode=None):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or (exact_mode is not None and stat.S_IMODE(before.st_mode) != exact_mode)
            or before.st_size <= 0
            or before.st_size > maximum
        ):
            fail("recovery metadata payload is unsafe")
        chunks = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail("recovery metadata payload ended unexpectedly")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail("recovery metadata payload grew during inspection")
        after = os.fstat(descriptor)
        if any(
            getattr(before, field) != getattr(after, field)
            for field in (
                "st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
                "st_size", "st_mtime_ns", "st_ctime_ns",
            )
        ):
            fail("recovery metadata payload changed during inspection")
        return b"".join(chunks)
    finally:
        os.close(descriptor)

def member_mentions_environment(name, member):
    candidates = [name]
    if member.issym() or member.islnk():
        candidates.append(member.linkname)
    return any(
        part.casefold().startswith(".env")
        for candidate in candidates
        for part in pathlib.PurePosixPath(candidate).parts
    )

def exact_mtime_ns(member):
    raw = member.pax_headers.get("mtime")
    if raw is None:
        if (
            not isinstance(member.mtime, int)
            or isinstance(member.mtime, bool)
            or abs(member.mtime) > 10**12
        ):
            fail("nested recovery member lacks an exact modification time")
        return member.mtime * 1_000_000_000
    if not isinstance(raw, str) or not re.fullmatch(
        r"-?[0-9]{1,12}(?:\.[0-9]{1,9})?",
        raw,
    ):
        fail("nested recovery member lacks an exact PAX modification time")
    value = decimal.Decimal(raw) * decimal.Decimal(1_000_000_000)
    if value != value.to_integral_value() or abs(value) > 10**21:
        fail("nested recovery member has an invalid PAX modification time")
    return int(value)

def decode_gnu_xattr_name(value):
    encoded = value.encode("utf-8", "surrogateescape")
    decoded = bytearray()
    offset = 0
    while offset < len(encoded):
        token = encoded[offset:offset + 3]
        if token == b"%3D":
            decoded.append(ord("="))
            offset += 3
        elif token == b"%25":
            decoded.append(ord("%"))
            offset += 3
        else:
            decoded.append(encoded[offset])
            offset += 1
    return bytes(decoded)

def member_xattr_bytes(member):
    count = 0
    total = 0
    names = set()
    for key, raw_value in member.pax_headers.items():
        if (
            key.startswith("LIBARCHIVE.xattr.")
            or (key.startswith("RHT.") and key != "RHT.security.selinux")
            or (
                key.startswith("SCHILY.acl.")
                and key not in {"SCHILY.acl.access", "SCHILY.acl.default"}
            )
        ):
            fail("nested recovery member uses unsupported security metadata")
        if key in {"SCHILY.acl.access", "SCHILY.acl.default"}:
            if not isinstance(raw_value, str):
                fail("nested recovery member has invalid ACL metadata")
            acl_value = raw_value.encode("utf-8", "surrogateescape")
            total += len(key.encode("ascii")) + len(acl_value)
            if len(acl_value) > 1024 * 1024:
                fail("nested recovery member ACL metadata is unbounded")
        if not key.startswith("SCHILY.xattr."):
            continue
        name_text = key.removeprefix("SCHILY.xattr.")
        if not name_text or not isinstance(raw_value, str):
            fail("nested recovery member has invalid xattr metadata")
        name = decode_gnu_xattr_name(name_text)
        value = raw_value.encode("utf-8", "surrogateescape")
        if (
            not name
            or len(name) > 255
            or b"\0" in name
            or b"." not in name
            or len(value) > 1024 * 1024
            or name in names
        ):
            fail("nested recovery member has unsafe xattr metadata")
        names.add(name)
        count += 1
        total += len(name) + len(value)
        if count > 1024 or total > 16 * 1024 * 1024:
            fail("nested recovery member xattr metadata is unbounded")
    raw_selinux = member.pax_headers.get("RHT.security.selinux")
    if raw_selinux is not None:
        if not isinstance(raw_selinux, str):
            fail("nested recovery member has invalid SELinux metadata")
        text = raw_selinux.encode("utf-8", "surrogateescape")
        if (
            not text
            or len(text) > 4095
            or b"\0" in text
            or any(byte < 32 or byte > 126 for byte in text)
            or text.count(b":") < 2
        ):
            fail("nested recovery member has unsafe SELinux metadata")
        value = text + b"\0"
        existing = None
        for key, candidate in member.pax_headers.items():
            if key == "SCHILY.xattr.security.selinux":
                existing = candidate.encode("utf-8", "surrogateescape")
        if existing is not None and existing != value:
            fail("nested recovery member has contradictory SELinux metadata")
        if existing is None:
            count += 1
            total += len(b"security.selinux") + len(value)
            if count > 1024 or total > 16 * 1024 * 1024:
                fail("nested recovery member SELinux metadata is unbounded")
    if (
        "SCHILY.acl.access" in member.pax_headers
        and b"system.posix_acl_access" not in names
    ) or (
        # GNU tar emits an empty SCHILY.acl.default marker for an
        # access-ACL-bearing directory that has no default ACL. Only a
        # non-empty default ACL has an authoritative binary xattr.
        bool(member.pax_headers.get("SCHILY.acl.default"))
        and b"system.posix_acl_default" not in names
    ):
        fail("nested recovery ACL lacks its authoritative binary xattr")
    return total

def sparse_overhead(member):
    if member.sparse is None:
        return 0
    if (
        not member.isfile()
        or member.pax_headers.get("GNU.sparse.major") != "1"
        or member.pax_headers.get("GNU.sparse.minor") != "0"
        or member.pax_headers.get("GNU.sparse.realsize") != str(member.size)
    ):
        fail("nested recovery member uses an unsupported sparse encoding")
    previous_end = 0
    saw_terminal = False
    extents = 0
    for offset, length in member.sparse:
        if (
            not isinstance(offset, int)
            or isinstance(offset, bool)
            or not isinstance(length, int)
            or isinstance(length, bool)
            or offset < previous_end
            or length < 0
            or offset > member.size
            or length > member.size - offset
        ):
            fail("nested recovery member has an invalid sparse map")
        if length == 0:
            if offset != member.size or saw_terminal:
                fail("nested recovery member has an invalid sparse terminator")
            saw_terminal = True
            continue
        if saw_terminal:
            fail("nested recovery member has sparse data after its terminator")
        previous_end = offset + length
        extents += 1
    if not saw_terminal:
        fail("nested recovery member sparse map is incomplete")
    return extents * 16

def normalized_hardlink_target(raw):
    path = pathlib.PurePosixPath(raw)
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if (
        not raw
        or raw.startswith("/")
        or not parts
        or ".." in parts
        or len(raw.encode("utf-8")) > 4096
        or any(ord(char) < 32 or ord(char) == 127 for char in raw)
    ):
        fail("unsafe nested recovery hard-link target")
    return "/".join(parts)

def resolve_hardlink_target(member_name, members_by_name):
    member_root = member_name.split("/", 1)[0]
    current = member_name
    visited = set()
    links = []
    while True:
        if current in visited:
            fail("nested recovery hard-link cycle")
        visited.add(current)
        member = members_by_name.get(current)
        if member is None:
            fail("nested recovery hard link targets a missing member")
        if member.isfile():
            for link in links:
                if (
                    link.uid != member.uid
                    or link.gid != member.gid
                    or (link.mode & 0o7777) != (member.mode & 0o7777)
                    or exact_mtime_ns(link) != exact_mtime_ns(member)
                ):
                    fail("nested recovery hard-link metadata is contradictory")
            return
        if not member.islnk():
            fail("nested recovery hard link does not resolve to a regular file")
        links.append(member)
        current = normalized_hardlink_target(member.linkname)
        if current.split("/", 1)[0] != member_root:
            fail("nested recovery hard link escapes its component")

def validate_pg_dump_custom(path):
    floors = {14: 23, 15: 18, 16: 14, 17: 10, 18: 4}
    command_info = os.lstat(pg_restore)
    with path.open("rb", buffering=0) as handle:
        prefix = handle.read(5)
    if (
        not pg_restore.is_absolute()
        or not stat.S_ISREG(command_info.st_mode)
        or stat.S_ISLNK(command_info.st_mode)
        or command_info.st_uid != 0
        or command_info.st_gid != 0
        or command_info.st_nlink != 1
        or command_info.st_mode & 0o022
        or not command_info.st_mode & stat.S_IXUSR
        or prefix != b"PGDMP"
    ):
        fail("database recovery payload is not trusted custom pg_dump format")
    if postgres_major not in floors:
        fail("target PostgreSQL major is unsupported")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
    version_result = subprocess.run(
        [str(pg_restore), "--version"],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        env=environment,
    )
    if (
        version_result.returncode != 0
        or version_result.stderr
        or len(version_result.stdout) > 4096
    ):
        fail("trusted pg_restore version output is unsafe")
    try:
        version_lines = version_result.stdout.decode("ascii").splitlines()
    except UnicodeDecodeError:
        fail("trusted pg_restore version output is unsafe")
    version_match = re.fullmatch(
        r"pg_restore \(PostgreSQL\) ([0-9]+)\.([0-9]+)(?:[ \t][ -~]*)?",
        version_lines[0] if len(version_lines) == 1 else "",
    )
    if version_match is None:
        fail("trusted pg_restore version output is unsafe")
    client_major, client_minor = map(int, version_match.groups())
    if (
        client_major != postgres_major
        or client_minor < floors[client_major]
    ):
        fail("trusted pg_restore is below the supported security floor")
    with tempfile.TemporaryFile() as inventory:
        list_result = subprocess.run(
            [str(pg_restore), "--list", str(path)],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=inventory,
            stderr=subprocess.DEVNULL,
            timeout=300,
            env=environment,
        )
        inventory.flush()
        size = inventory.tell()
        if list_result.returncode != 0 or size <= 0 or size > 64 * 1024 * 1024:
            fail("database custom recovery inventory is unsafe")
        inventory.seek(0)
        try:
            header = inventory.read(min(size, 1024 * 1024)).decode("utf-8")
        except UnicodeDecodeError:
            fail("database custom recovery inventory is unsafe")
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
        fail("database custom recovery provenance is missing")
    source_major, source_minor = map(int, source_matches[0])
    producer_major, producer_minor = map(int, producer_matches[0])
    if (
        source_major != postgres_major
        or producer_major != postgres_major
        or producer_minor < floors[producer_major]
    ):
        fail("database custom recovery provenance is unsupported")
    result = subprocess.run(
        [
            str(pg_restore),
            "--format=custom",
            "--file=/dev/null",
            str(path),
        ],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
        env=environment,
    )
    if result.returncode != 0:
        fail("database recovery payload failed trusted pg_restore parsing")

try:
    if not manifest_path.is_file() or manifest_path.is_symlink():
        fail("recovery manifest is missing or unsafe")
    raw = manifest_path.read_bytes()
    if not raw or len(raw) > 1024 * 1024:
        fail("recovery manifest is empty or oversized")
    document = json.loads(raw)
    schema = document.get("schema")
    schema_v2 = "bridgesllm.portal-recovery.v2"
    schema_v3 = "bridgesllm.portal-recovery.v3"
    schema_v4 = "bridgesllm.portal-recovery.v4"
    if (
        set(document) != {
            "schema", "backupType", "createdAt", "portalVersion",
            "installationProfile", "directoryConsistency",
            "metadataProfile", "databaseIdentity", "components",
        }
        or schema not in {schema_v2, schema_v3, schema_v4}
    ):
        fail("unsupported recovery manifest schema")
    explicit_env = root / "configs/portal-backend.env.production"
    explicit_env_bytes = safe_regular_payload(
        explicit_env,
        1024 * 1024,
        exact_mode=0o600,
    )
    try:
        explicit_env_text = explicit_env_bytes.decode("utf-8")
    except UnicodeDecodeError:
        fail("Portal environment recovery payload is not UTF-8")
    assignment = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
    explicit_names = set()
    explicit_lines = []
    for line_number, raw_line in enumerate(explicit_env_text.split("\n"), start=1):
        if not raw_line:
            continue
        if raw_line.lstrip().startswith(("#", ";")):
            if schema == schema_v3:
                fail("Portal recovery v3 environment contains unfiltered comments")
            continue
        match = assignment.fullmatch(raw_line)
        if match is None or match.group(1) in explicit_names:
            fail(f"Portal environment recovery payload is invalid on line {line_number}")
        name, value = match.groups()
        explicit_names.add(name)
        if "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            fail(f"Portal environment recovery payload is invalid on line {line_number}")
        if value[:1] in {"'", '"'}:
            quote = value[0]
            if len(value) < 2 or value[-1] != quote or quote in value[1:-1]:
                fail(f"Portal environment recovery payload is invalid on line {line_number}")
        elif any(char in value for char in "\"'") or value != value.strip(" \t"):
            fail(f"Portal environment recovery payload is invalid on line {line_number}")
        explicit_lines.append(raw_line)
    if schema == schema_v3:
        if any(
            "OPENCLAW" in name.upper() or "CLAWDBOT" in name.upper()
            for name in explicit_names
        ):
            fail("Portal recovery v3 contains an OpenClaw environment assignment")
        canonical_environment = "\n".join(explicit_lines) + "\n"
        if explicit_env_text != canonical_environment:
            fail("Portal recovery v3 environment is not canonical assignment-only data")
        systemd_root = root / "systemd"
        systemd_root_info = os.lstat(systemd_root)
        if (
            not stat.S_ISDIR(systemd_root_info.st_mode)
            or stat.S_ISLNK(systemd_root_info.st_mode)
            or systemd_root_info.st_uid != 0
            or systemd_root_info.st_gid != 0
            or systemd_root_info.st_mode & 0o022
        ):
            fail("Portal recovery v3 systemd metadata root is unsafe")
        if any(os.scandir(systemd_root)):
            fail("Portal recovery v3 systemd metadata directory is not empty")
        config_names = {entry.name for entry in os.scandir(root / "configs")}
        if config_names != {"portal-backend.env.production"}:
            fail("Portal recovery v3 configuration inventory is not minimal")
    if document.get("metadataProfile") != "linux-pax-mtime-xattrs-sparse-v1":
        fail("exact Linux recovery metadata contract is missing")
    backup_type = document.get("backupType")
    if backup_type not in {"daily", "weekly", "monthly", "comprehensive"}:
        fail("invalid backup type")
    consistency = document.get("directoryConsistency")
    supported_consistency = {
        schema_v2: {
            "live-filesystem-copy", "live-member-reconciled-v1",
            "service-database-quiesced-v2",
        },
        schema_v3: {"service-database-quiesced-v2"},
        schema_v4: {"live-member-reconciled-v1", "service-database-quiesced-v2"},
    }[schema]
    if consistency not in supported_consistency:
        fail("directory consistency contract is missing")
    if schema == schema_v4 and (
        (backup_type == "comprehensive")
        != (consistency == "service-database-quiesced-v2")
    ):
        fail("Portal recovery v4 backup type conflicts with directory consistency")
    portal_version = document.get("portalVersion")
    if portal_version is not None and (
        not isinstance(portal_version, str)
        or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", portal_version)
    ):
        fail("invalid Portal version")
    profile = document.get("installationProfile")
    if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", profile):
        fail("invalid installation profile")
    identity = document.get("databaseIdentity")
    identity_keys = {
        "schema", "postgresMajor", "encoding", "lcCollate", "lcCtype",
        "localeProvider", "providerLocale", "icuRules", "collationVersion",
        "collationActualVersion",
    }
    def safe_identity_text(value, maximum):
        return (
            isinstance(value, str)
            and value
            and len(value.encode("utf-8")) <= maximum
            and all(
                ord(character) >= 32 and ord(character) != 127
                for character in value
            )
        )
    if (
        not isinstance(identity, dict)
        or set(identity) != identity_keys
        or identity.get("schema")
            != "bridgesllm.postgresql-database-identity.v1"
        or identity.get("postgresMajor") != postgres_major
        or identity.get("encoding") != "UTF8"
        or not safe_identity_text(identity.get("lcCollate"), 256)
        or not safe_identity_text(identity.get("lcCtype"), 256)
        or identity.get("localeProvider") not in {"libc", "icu", "builtin"}
        or (
            identity["localeProvider"] == "libc"
            and identity.get("providerLocale") is not None
        )
        or (
            identity["localeProvider"] in {"icu", "builtin"}
            and not safe_identity_text(identity.get("providerLocale"), 1024)
        )
        or (
            identity.get("icuRules") is not None
            and (
                identity["localeProvider"] != "icu"
                or not safe_identity_text(identity["icuRules"], 4096)
            )
        )
        or (
            identity.get("collationVersion") is not None
            and not safe_identity_text(identity["collationVersion"], 256)
        )
        or (
            identity.get("collationActualVersion") is not None
            and not safe_identity_text(
                identity["collationActualVersion"], 256
            )
        )
        or identity.get("collationVersion")
            != identity.get("collationActualVersion")
    ):
        fail("database identity contract is invalid")
    components = document.get("components")
    if not isinstance(components, list) or len(components) > 128:
        fail("invalid recovery component list")

    by_id = {}
    reconciliation_member_total = 0
    reconciliation_byte_total = 0

    def validate_live_reconciliation(value):
        members = value.get("members") if isinstance(value, dict) else None
        if (
            not isinstance(value, dict)
            or set(value) != {
                "schema", "passes", "memberCount", "logicalBytes", "members"
            }
            or value.get("schema")
                != "bridgesllm.live-member-reconciliation.v1"
            or not isinstance(value.get("passes"), int)
            or isinstance(value.get("passes"), bool)
            or value["passes"] <= 0
            or value["passes"] > 3
            or not isinstance(value.get("memberCount"), int)
            or isinstance(value.get("memberCount"), bool)
            or value["memberCount"] <= 0
            or value["memberCount"] > 512
            or not isinstance(value.get("logicalBytes"), int)
            or isinstance(value.get("logicalBytes"), bool)
            or value["logicalBytes"] < 0
            or value["logicalBytes"] > 4 * 1024**3
            or not isinstance(members, list)
            or len(members) != value["memberCount"]
        ):
            fail("live reconciliation metadata is invalid")
        seen = set()
        for member in members:
            path = member.get("path") if isinstance(member, dict) else None
            if (
                not isinstance(member, dict)
                or set(member) != {"path", "transition", "capture"}
                or not isinstance(path, str)
                or not path
                or len(path.encode("utf-8")) >= 4096
                or path.startswith("/")
                or "\\" in path
                or any(ord(character) < 32 or ord(character) == 127 for character in path)
                or (path != "." and any(part in {"", ".", ".."} for part in path.split("/")))
                or path in seen
                or member.get("transition") not in {
                    "stable", "added", "changed", "removed"
                }
                or member.get("capture") not in {
                    "descriptor-snapshot", "metadata-snapshot",
                    "symlink-snapshot", "hardlink-snapshot",
                    "sqlite-online-snapshot", "sqlite-journal-omitted",
                    "absent-at-attestation",
                }
            ):
                fail("live reconciliation member metadata is invalid")
            seen.add(path)
        return value["memberCount"], value["logicalBytes"]

    for entry in components:
        if not isinstance(entry, dict):
            fail("invalid recovery component")
        component_id = entry.get("id")
        if not isinstance(component_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", component_id):
            fail("invalid recovery component id")
        if component_id in by_id:
            fail("duplicate recovery component id")
        by_id[component_id] = entry

        requirement = entry.get("requirement")
        status = entry.get("status")
        if requirement not in {"required", "optional"} or status not in {"captured", "not-configured", "degraded"}:
            fail("invalid recovery component state")
        if status == "degraded" and not allow_degraded:
            fail("degraded recovery component is not a complete backup")
        if requirement == "required" and status != "captured" and not (
            allow_degraded and status == "degraded"
        ):
            fail("required recovery component was not captured")
        if (
            (schema in {schema_v2, schema_v4} and component_id == "openclaw-state")
            or component_id.startswith("stalwart-")
        ):
            expected_requirement = "optional" if status == "not-configured" else "required"
            if requirement != expected_requirement:
                fail("installed optional feature must be recovery-required")
        logical_bytes = entry.get("logicalBytes")
        relation_count = entry.get("relationCount")
        contract_variant = entry.get("databaseContractVariant")
        if component_id == "database":
            if (
                not isinstance(logical_bytes, int)
                or isinstance(logical_bytes, bool)
                or logical_bytes <= 0
                or not isinstance(relation_count, int)
                or isinstance(relation_count, bool)
                or relation_count <= 0
                or relation_count > 100_000_000
                or contract_variant not in {
                    "owner-null", "pg-database-owner-default"
                }
            ):
                fail("database recovery component lacks bounded storage metadata")
        elif (
            logical_bytes is not None
            or relation_count is not None
            or contract_variant is not None
        ):
            fail("non-database recovery component claims database storage metadata")

        payload = entry.get("payload")
        live_reconciliation = entry.get("liveReconciliation")
        if "liveReconciliation" in entry and (
            schema not in {schema_v2, schema_v4}
            or consistency != "live-member-reconciled-v1"
            or live_reconciliation is None
        ):
            fail("live reconciliation conflicts with its recovery schema")
        if status == "captured":
            if not isinstance(payload, str):
                fail("captured recovery component has no payload")
            payload_path = pathlib.PurePosixPath(payload)
            parts = tuple(part for part in payload_path.parts if part not in {"", "."})
            if payload.startswith("/") or ".." in parts or not parts:
                fail("unsafe recovery payload path")
            resolved = root.joinpath(*parts)
            if not resolved.is_file() or resolved.is_symlink() or resolved.stat().st_size <= 0:
                fail("recovery payload is missing, empty, or unsafe")
            if component_id == "database":
                validate_pg_dump_custom(resolved)
            method = entry.get("captureMethod")
            if method not in {
                "pg-dump-custom", "file-copy", "v3-sanitized-environment",
                "live-filesystem-tar",
                "live-member-reconciled-tar", "service-quiesced-tar",
            }:
                fail("invalid recovery capture method")
            if component_id == "database" and method != "pg-dump-custom":
                fail("database capture method conflicts with its schema")
            if component_id == "portal-environment" and method != (
                "v3-sanitized-environment" if schema == schema_v3 else "file-copy"
            ):
                fail("Portal environment capture method conflicts with its schema")
            if (
                component_id not in {"database", "portal-environment"}
                and not payload.endswith(".tar.gz")
            ):
                fail("directory recovery component is not a nested archive")
            if payload.endswith(".tar.gz") and (
                (consistency == "service-database-quiesced-v2"
                 and method != "service-quiesced-tar")
                or (
                    consistency == "live-filesystem-copy"
                    and method != "live-filesystem-tar"
                )
                or (
                    consistency == "live-member-reconciled-v1"
                    and method not in {
                        "live-filesystem-tar", "live-member-reconciled-tar"
                    }
                )
            ):
                fail("recovery capture method conflicts with its consistency contract")
            if live_reconciliation is not None:
                if (
                    consistency != "live-member-reconciled-v1"
                    or method != "live-member-reconciled-tar"
                    or not payload.endswith(".tar.gz")
                ):
                    fail("live reconciliation conflicts with its capture contract")
                member_count, logical_bytes = validate_live_reconciliation(
                    live_reconciliation
                )
                reconciliation_member_total += member_count
                reconciliation_byte_total += logical_bytes
                if schema == schema_v4 and (
                    reconciliation_member_total > 512
                    or reconciliation_byte_total > 4 * 1024**3
                ):
                    fail("live reconciliation exceeds its aggregate run budget")
            elif method == "live-member-reconciled-tar":
                fail("reconciled capture lacks member evidence")
            if payload.endswith(".tar.gz"):
                with tarfile.open(resolved, mode="r:gz") as nested:
                    members = nested.getmembers()
                    if not members or len(members) > 1_000_000:
                        fail("nested recovery archive is empty")
                    seen_members = set()
                    members_by_name = {}
                    total_size = 0
                    for member in members:
                        raw_name = member.name
                        path = pathlib.PurePosixPath(raw_name)
                        parts = tuple(part for part in path.parts if part not in {"", "."})
                        if raw_name.startswith("/") or ".." in parts or not parts:
                            fail("unsafe nested recovery member path")
                        normalized = "/".join(parts)
                        if normalized in seen_members:
                            fail("duplicate nested recovery member")
                        seen_members.add(normalized)
                        members_by_name[normalized] = member
                        if not (
                            member.isfile()
                            or member.isdir()
                            or member.issym()
                            or member.islnk()
                        ):
                            fail("unsafe nested recovery member type")
                        if member.uid < 0 or member.uid > 2_147_483_647 \
                                or member.gid < 0 or member.gid > 2_147_483_647:
                            fail("unsafe nested recovery ownership")
                        if member.mode < 0 or member.mode & ~0o7777:
                            fail("unsafe nested recovery mode")
                        if component_id == "portal-install" and member.mode & 0o6000:
                            fail("portal archive contains setuid or setgid metadata")
                        if component_id == "portal-install" and any(
                            key.startswith("SCHILY.xattr.")
                            and decode_gnu_xattr_name(
                                key.removeprefix("SCHILY.xattr.")
                            ) == b"security.capability"
                            for key in member.pax_headers
                        ):
                            fail("portal archive contains file capabilities")
                        exact_mtime_ns(member)
                        total_size += member_xattr_bytes(member)
                        total_size += sparse_overhead(member)
                        if total_size > 2 * 1024**4:
                            fail("nested recovery archive metadata is unbounded")
                        if any(ord(char) < 32 or ord(char) == 127 for char in raw_name):
                            fail("unsafe nested recovery member name")
                        if member.isfile():
                            if member.size < 0:
                                fail("unsafe nested recovery member size")
                            total_size += member.size
                            if total_size > 2 * 1024**4:
                                fail("nested recovery archive is unbounded")
                        elif member.issym():
                            link = member.linkname
                            if (
                                not link
                                or len(link.encode("utf-8")) > 4096
                                or any(ord(char) < 32 or ord(char) == 127 for char in link)
                            ):
                                fail("unsafe nested recovery symbolic-link target")
                            if link.startswith("/"):
                                source_root = entry.get("source")
                                allowed_roots = [source_root]
                                if component_id == "openclaw-state":
                                    allowed_roots.append("/usr/lib/node_modules/openclaw")
                                resolved_link = posixpath.normpath(link)
                                admitted_project_interpreter = (
                                    component_id == "projects"
                                    and re.fullmatch(
                                        r"/(?:usr/bin|usr/local/bin)/python3(?:\.[0-9]+)?",
                                        resolved_link,
                                    ) is not None
                                )
                                if (
                                    not isinstance(source_root, str)
                                    or not source_root.startswith("/")
                                    or (
                                        not admitted_project_interpreter
                                        and not any(
                                            isinstance(root, str)
                                            and (
                                                resolved_link == root
                                                or resolved_link.startswith(root + "/")
                                            )
                                            for root in allowed_roots
                                        )
                                    )
                                ):
                                    fail("nested recovery symbolic link escapes its admitted roots")
                            else:
                                resolved_link = posixpath.normpath(
                                    posixpath.join(posixpath.dirname(normalized), link)
                                )
                                member_root = normalized.split("/", 1)[0]
                                if (
                                    resolved_link in {"", ".", ".."}
                                    or resolved_link.startswith("../")
                                    or resolved_link.split("/", 1)[0] != member_root
                                ):
                                    fail("nested recovery symbolic link escapes its component")
                    top_level = pathlib.PurePosixPath(entry.get("source", "")).name
                    root_member = members_by_name.get(top_level)
                    if (
                        root_member is None
                        or not root_member.isdir()
                        or root_member.uid != 0
                        or root_member.gid != 0
                        or root_member.mode & 0o022
                    ):
                        fail("nested recovery root is not root-owned and write-safe")
                    for normalized, member in members_by_name.items():
                        if member.islnk():
                            resolve_hardlink_target(normalized, members_by_name)
                    if component_id == "portal-install":
                        source_root = entry.get("source")
                        if not isinstance(source_root, str) or not source_root.startswith("/"):
                            fail("portal recovery source is invalid")
                        nested_env_name = (
                            pathlib.PurePosixPath(source_root).name
                            + "/backend/.env.production"
                        )
                        nested_env = members_by_name.get(nested_env_name)
                        if schema == schema_v3:
                            for nested_name, nested_member in members_by_name.items():
                                if member_mentions_environment(
                                    nested_name,
                                    nested_member,
                                ):
                                    fail("Portal recovery v3 embeds environment metadata in the Portal archive")
                        else:
                            if (
                                nested_env is None
                                or not nested_env.isfile()
                                or nested_env.size <= 0
                                or nested_env.size > 1024 * 1024
                                or nested_env.uid != 0
                                or nested_env.gid != 0
                                or (nested_env.mode & 0o7777) != 0o600
                            ):
                                fail("portal archive omits its sealed environment authority")
                            stream = nested.extractfile(nested_env)
                            if stream is None:
                                fail("portal environment authority could not be read")
                            nested_bytes = stream.read(1024 * 1024 + 1)
                            if nested_bytes != explicit_env_bytes:
                                fail("portal archive environment differs from its sealed authority")
        else:
            if (
                payload is not None
                or entry.get("captureMethod") is not None
                or "liveReconciliation" in entry
            ):
                fail("absent recovery component claims a payload")
            reason = entry.get("reason")
            if not isinstance(reason, str) or not reason.strip() or len(reason) > 512:
                fail("uncaptured recovery component lacks bounded evidence")

        source = entry.get("source")
        if source is not None and (
            not isinstance(source, str)
            or not source
            or len(source.encode("utf-8")) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in source)
        ):
            fail("invalid recovery source description")

    if schema == schema_v3 and any(
        "openclaw" in component_id for component_id in by_id
    ):
        fail("Portal recovery v3 must not contain OpenClaw state")

    for component_id, expected_payload in core_payloads.items():
        entry = by_id.get(component_id)
        if not entry or entry.get("requirement") != "required":
            fail(f"required core recovery component is missing: {component_id}")
        if entry.get("status") == "degraded" and allow_degraded:
            continue
        if entry.get("status") != "captured":
            fail(f"required core recovery component is missing: {component_id}")
        if entry.get("payload") != expected_payload:
            fail(f"required core recovery payload is wrong: {component_id}")
    if by_id["portal-app-sources"].get("source") != str(portal_app_sources):
        fail("standalone App source recovery authority changed")
    if (root / "database.dump").stat().st_size <= 5:
        fail("database dump is empty")
except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
    print(f"Recovery contract validation failed: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

write_archive_mac() {
  local directory="$1"
  python3 - "${directory}/MANIFEST.txt" "${directory}/ARCHIVE-MAC.json" \
    "${BACKUP_HMAC_KEY}" <<'PY'
import hashlib
import hmac
import json
import os
import stat
import sys

manifest_path, target, key_path = sys.argv[1:]
key_descriptor = os.open(
    key_path,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
)
try:
    key_info = os.fstat(key_descriptor)
    key = os.read(key_descriptor, 33)
finally:
    os.close(key_descriptor)
if (
    not stat.S_ISREG(key_info.st_mode)
    or key_info.st_uid != 0
    or key_info.st_gid != 0
    or key_info.st_nlink != 1
    or stat.S_IMODE(key_info.st_mode) != 0o600
    or key_info.st_size != 32
    or len(key) != 32
):
    raise SystemExit(1)
manifest_info = os.lstat(manifest_path)
if (
    not stat.S_ISREG(manifest_info.st_mode)
    or stat.S_ISLNK(manifest_info.st_mode)
    or manifest_info.st_uid != 0
    or manifest_info.st_gid != 0
    or manifest_info.st_nlink != 1
    or stat.S_IMODE(manifest_info.st_mode) != 0o600
    or manifest_info.st_size <= 0
    or manifest_info.st_size > 1024 * 1024
    or os.path.lexists(target)
):
    raise SystemExit(1)
manifest = open(manifest_path, "rb", buffering=0).read()
record = {
    "algorithm": "hmac-sha256",
    "keyId": hashlib.sha256(key).hexdigest(),
    "manifest": "MANIFEST.txt",
    "manifestHmac": hmac.new(key, manifest, hashlib.sha256).hexdigest(),
    "schema": "bridgesllm.archive-mac.v1",
}
descriptor = os.open(
    target,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL
    | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
try:
    payload = (
        json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("ascii")
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

verify_staging_manifest() {
  local directory="$1"
  local allow_degraded="${2:-false}"
  assert_backup_archive_trust || return 1
  python3 - "${directory}" "${BACKUP_HMAC_KEY}" <<'PY' || return 1
import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
key_path = pathlib.Path(sys.argv[2])

def safe_regular(path, mode=None, maximum=None):
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
        or (maximum is not None and (info.st_size <= 0 or info.st_size > maximum))
    ):
        raise SystemExit(1)
    return info

key_info = safe_regular(key_path, mode=0o600)
if key_info.st_size != 32:
    raise SystemExit(1)
key = key_path.read_bytes()
if len(key) != 32:
    raise SystemExit(1)
manifest_path = root / "MANIFEST.txt"
mac_path = root / "ARCHIVE-MAC.json"
safe_regular(manifest_path, mode=0o600, maximum=1024 * 1024)
safe_regular(mac_path, mode=0o600, maximum=4096)
manifest = manifest_path.read_bytes()
mac_raw = mac_path.read_bytes()
def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result
record = json.loads(mac_raw, object_pairs_hook=reject_duplicate_keys)
if mac_raw != (
    json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
).encode("ascii"):
    raise SystemExit(1)
if (
    not isinstance(record, dict)
    or set(record) != {
        "schema", "algorithm", "keyId", "manifest", "manifestHmac"
    }
    or record.get("schema") != "bridgesllm.archive-mac.v1"
    or record.get("algorithm") != "hmac-sha256"
    or record.get("keyId") != hashlib.sha256(key).hexdigest()
    or record.get("manifest") != "MANIFEST.txt"
    or not isinstance(record.get("manifestHmac"), str)
    or not hmac.compare_digest(
        record["manifestHmac"],
        hmac.new(key, manifest, hashlib.sha256).hexdigest(),
    )
):
    raise SystemExit(1)
try:
    lines = manifest.decode("utf-8").splitlines()
except UnicodeDecodeError:
    raise SystemExit(1)
markers = [index for index, line in enumerate(lines) if line == "Checksums:"]
if len(markers) != 1 or markers[0] + 1 >= len(lines):
    raise SystemExit(1)
pattern = re.compile(r"([0-9a-f]{64})  \./([A-Za-z0-9][A-Za-z0-9._@/-]{0,4094})")
expected = {}
for line in lines[markers[0] + 1:]:
    match = pattern.fullmatch(line)
    if match is None:
        raise SystemExit(1)
    digest, name = match.groups()
    path = pathlib.PurePosixPath(name)
    if (
        name in {"MANIFEST.txt", "ARCHIVE-MAC.json"}
        or name.startswith("/")
        or ".." in path.parts
        or "." in path.parts
        or name in expected
    ):
        raise SystemExit(1)
    expected[name] = digest
actual = set()
for directory, names, files in os.walk(root, topdown=True, followlinks=False):
    current = pathlib.Path(directory)
    if current.is_symlink():
        raise SystemExit(1)
    for name in names:
        if (current / name).is_symlink():
            raise SystemExit(1)
    for name in files:
        path = current / name
        relative = path.relative_to(root).as_posix()
        safe_regular(path)
        if relative not in {"MANIFEST.txt", "ARCHIVE-MAC.json"}:
            actual.add(relative)
if actual != set(expected):
    raise SystemExit(1)
for relative in sorted(actual):
    digest = hashlib.sha256()
    with (root / relative).open("rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    if not hmac.compare_digest(digest.hexdigest(), expected[relative]):
        raise SystemExit(1)
PY
  [[ -f "${directory}/database.dump" \
    && ! -L "${directory}/database.dump" ]] || return 1
  [[ -f "${directory}/RECOVERY-MANIFEST.json" \
    && ! -L "${directory}/RECOVERY-MANIFEST.json" ]] || return 1
  verify_recovery_contract "$directory" "$allow_degraded"
}

verify_archive() {
  local archive="$1"
  local allow_degraded="${2:-false}"
  local expanded_bytes="" reserve_bytes="${BACKUP_RECOVERY_RESERVE_BYTES:-536870912}"
  local capacity_preexisting=false
  if backup_capacity_guard_state_present; then
    capacity_preexisting=true
  fi
  prepare_verify_archive_workspace || return 1
  [[ -f "$archive" && ! -L "$archive" ]] || return 1
  assert_backup_archive_trust || return 1

  # Authenticate the exact checksum inventory before extracting or parsing
  # any recovery-controlled payload.
  if ! expanded_bytes="$(python3 - "$archive" "${BACKUP_HMAC_KEY}" <<'PY'
import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import sys
import tarfile

archive, key_path = sys.argv[1:]
archive_info = os.lstat(archive)
key_info = os.lstat(key_path)
if (
    not stat.S_ISREG(archive_info.st_mode)
    or stat.S_ISLNK(archive_info.st_mode)
    or archive_info.st_uid != 0
    or archive_info.st_gid != 0
    or archive_info.st_nlink != 1
    or archive_info.st_mode & 0o022
    or archive_info.st_size <= 0
    or not stat.S_ISREG(key_info.st_mode)
    or stat.S_ISLNK(key_info.st_mode)
    or key_info.st_uid != 0
    or key_info.st_gid != 0
    or key_info.st_nlink != 1
    or stat.S_IMODE(key_info.st_mode) != 0o600
    or key_info.st_size != 32
):
    raise SystemExit(1)
key = open(key_path, "rb", buffering=0).read(33)
if len(key) != 32:
    raise SystemExit(1)
total_size = 0
try:
    with tarfile.open(archive, mode="r:gz") as handle:
        members = handle.getmembers()
        if not members or len(members) > 4096:
            raise ValueError("backup member count is empty or unbounded")
        by_name = {}
        root_members = 0
        for member in members:
            raw_name = member.name
            path = pathlib.PurePosixPath(raw_name)
            parts = tuple(part for part in path.parts if part not in {"", "."})
            if (
                raw_name.startswith("/")
                or ".." in parts
                or any(ord(char) < 32 or ord(char) == 127 for char in raw_name)
            ):
                raise ValueError("unsafe backup member path")
            if not parts:
                if (
                    member.name not in {".", "./"}
                    or not member.isdir()
                    or member.uid != 0
                    or member.gid != 0
                    or member.mtime != 0
                    or member.uname not in {"", "root"}
                    or member.gname not in {"", "root"}
                    or member.linkname
                    or member.pax_headers
                    or member.devmajor != 0
                    or member.devminor != 0
                    or stat.S_IMODE(member.mode) != 0o700
                ):
                    raise ValueError("unsafe root member")
                root_members += 1
                total_size += 4096
                continue
            if not (member.isfile() or member.isdir()):
                raise ValueError("unsafe backup member type")
            normalized = "/".join(parts)
            if normalized in by_name:
                raise ValueError("duplicate backup member")
            by_name[normalized] = member
            total_size += 4096
            if (
                member.uid != 0
                or member.gid != 0
                or member.mtime != 0
                or member.uname not in {"", "root"}
                or member.gname not in {"", "root"}
                or member.linkname
                or member.pax_headers
                or member.devmajor != 0
                or member.devminor != 0
                or stat.S_IMODE(member.mode)
                    != (0o600 if member.isfile() else 0o700)
            ):
                raise ValueError("backup member metadata is not canonical")
            if member.isfile():
                total_size += member.size
                if member.size < 0 or total_size > 2 * 1024**4:
                    raise ValueError("backup archive is unbounded")
        directories = {
            name for name, member in by_name.items() if member.isdir()
        }
        if root_members != 1 or directories != {"configs", "systemd"}:
            raise ValueError("backup directory inventory is not exact")
        required = {
            "MANIFEST.txt",
            "ARCHIVE-MAC.json",
            "RECOVERY-MANIFEST.json",
            "database.dump",
        }
        if not required.issubset(by_name):
            raise ValueError("authenticated backup core payload is missing")
        manifest_member = by_name["MANIFEST.txt"]
        mac_member = by_name["ARCHIVE-MAC.json"]
        if (
            not manifest_member.isfile()
            or manifest_member.size <= 0
            or manifest_member.size > 1024 * 1024
            or manifest_member.uid != 0
            or manifest_member.gid != 0
            or stat.S_IMODE(manifest_member.mode) != 0o600
            or not mac_member.isfile()
            or mac_member.size <= 0
            or mac_member.size > 4096
            or mac_member.uid != 0
            or mac_member.gid != 0
            or stat.S_IMODE(mac_member.mode) != 0o600
        ):
            raise ValueError("backup authentication metadata is unsafe")
        manifest_stream = handle.extractfile(manifest_member)
        mac_stream = handle.extractfile(mac_member)
        if manifest_stream is None or mac_stream is None:
            raise ValueError("backup authentication metadata is unreadable")
        manifest = manifest_stream.read(1024 * 1024 + 1)
        mac_raw = mac_stream.read(4097)
        if (
            len(manifest) != manifest_member.size
            or len(mac_raw) != mac_member.size
        ):
            raise ValueError("backup authentication metadata changed")
        def reject_duplicate_keys(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate JSON key")
                result[key] = value
            return result
        record = json.loads(
            mac_raw,
            object_pairs_hook=reject_duplicate_keys,
        )
        if mac_raw != (
            json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("ascii"):
            raise ValueError("backup MAC record is not canonical")
        expected_mac = hmac.new(key, manifest, hashlib.sha256).hexdigest()
        if (
            not isinstance(record, dict)
            or set(record) != {
                "schema", "algorithm", "keyId", "manifest", "manifestHmac"
            }
            or record.get("schema") != "bridgesllm.archive-mac.v1"
            or record.get("algorithm") != "hmac-sha256"
            or record.get("keyId") != hashlib.sha256(key).hexdigest()
            or record.get("manifest") != "MANIFEST.txt"
            or not isinstance(record.get("manifestHmac"), str)
            or not hmac.compare_digest(record["manifestHmac"], expected_mac)
        ):
            raise ValueError("backup authentication failed")
        lines = manifest.decode("utf-8").splitlines()
        markers = [
            index for index, line in enumerate(lines)
            if line == "Checksums:"
        ]
        if len(markers) != 1 or markers[0] + 1 >= len(lines):
            raise ValueError("backup checksum inventory is missing")
        pattern = re.compile(
            r"([0-9a-f]{64})  \./([A-Za-z0-9][A-Za-z0-9._@/-]{0,4094})"
        )
        expected = {}
        for line in lines[markers[0] + 1:]:
            match = pattern.fullmatch(line)
            if match is None:
                raise ValueError("backup checksum inventory is malformed")
            digest, name = match.groups()
            item = pathlib.PurePosixPath(name)
            if (
                name in {"MANIFEST.txt", "ARCHIVE-MAC.json"}
                or name.startswith("/")
                or ".." in item.parts
                or "." in item.parts
                or name in expected
            ):
                raise ValueError("backup checksum inventory is unsafe")
            expected[name] = digest
        regular = {
            name for name, member in by_name.items()
            if member.isfile()
            and name not in {"MANIFEST.txt", "ARCHIVE-MAC.json"}
        }
        if regular != set(expected):
            raise ValueError("backup checksum inventory is not exact")
        for name in sorted(regular):
            stream = handle.extractfile(by_name[name])
            if stream is None:
                raise ValueError("backup payload is unreadable")
            digest = hashlib.sha256()
            remaining = by_name[name].size
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("backup payload ended early")
                digest.update(chunk)
                remaining -= len(chunk)
            if not hmac.compare_digest(digest.hexdigest(), expected[name]):
                raise ValueError("backup payload checksum differs")
except (OSError, tarfile.TarError, ValueError):
    raise SystemExit(1)
print(total_size)
PY
  )"; then
    return 1
  fi
  [[ "${expanded_bytes}" =~ ^[1-9][0-9]*$ \
    && "${reserve_bytes}" =~ ^[0-9]+$ \
    && "${reserve_bytes}" -ge 67108864 \
    && "${reserve_bytes}" -le 8589934592 ]] || return 1
  [[ -n "${BACKUP_WORK_ROOT:-}" ]] || return 1
  assert_backup_verification_disk_admission "${expanded_bytes}" || return 1
  [[ "${BACKUP_WORK_IMAGE_MOUNTED}" == "true" ]] \
    && assert_backup_capacity_guard \
    && backup_work_root_action attest || return 1

  local verify_dir
  verify_dir="$(create_backup_work_directory verify)" || return 1
  VERIFY_DIR="$verify_dir"
  local status=0
  if ! tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$verify_dir"; then
    status=1
  elif ! verify_staging_manifest "$verify_dir" "$allow_degraded"; then
    status=1
  fi
  assert_backup_capacity_guard || status=1
  cleanup_verify_dir || status=1
  if ! ${capacity_preexisting}; then
    release_backup_capacity_guard || status=1
  fi
  return "$status"
}

create_backup() {
  local type="${1:-daily}"
  case "$type" in
    daily|weekly|monthly|comprehensive) ;;
    *) die "Unknown backup type: $type (use daily, weekly, monthly, or comprehensive)" ;;
  esac

  begin_run "$type"
  select_backup_postgresql_toolchain_for_authority "${PORTAL_ENV_FILE}" \
    || die "PostgreSQL server major or client security floor admission failed"
  BACKUP_ARCHIVE_NAME="$(backup_name_for_type "${type}")"
  prepare_backup_publication_targets \
    "${type}" "${BACKUP_ARCHIVE_NAME}" "${RUN_ID}" \
    || die_with_code BACKUP_DISK_ADMISSION_FAILED \
      "Exact complete and degraded backup publication targets are unsafe"
  assert_backup_disk_admission \
    || die_with_code BACKUP_DISK_ADMISSION_FAILED \
      "Backup storage lacks safely admitted capacity for creation and verification"
  assert_backup_capacity_guard \
    || die_with_code BACKUP_DISK_ADMISSION_FAILED \
      "Held backup recovery capacity changed after disk admission"
  [[ "${BACKUP_WORK_IMAGE_MOUNTED}" == "true" ]] \
    && backup_work_root_action attest \
    || die_with_code BACKUP_WORK_ROOT_UNAVAILABLE \
      "Private backup work image was not mounted before capture"

  local complete_backup_dir="${BACKUP_BASE}/${type}"
  local degraded_backup_dir="${BACKUP_BASE}/degraded/${type}"
  local backup_dir="${complete_backup_dir}"
  local staging
  staging="$(create_backup_work_directory "create-${type}")" \
    || die_with_code BACKUP_WORK_ROOT_UNAVAILABLE \
      "Private backup creation workspace could not be allocated"
  STAGING_DIR="$staging"
  RECOVERY_COMPONENTS_FILE="${staging}/.recovery-components.ndjson"
  : > "$RECOVERY_COMPONENTS_FILE"
  seal_backup_environment \
    || die "Portal environment authority could not be sealed for backup"
  assert_sealed_backup_bindings \
    || die "Portal environment-derived backup targets changed before the operation lock was acquired"
  assert_portal_app_sources_root \
    || die "Standalone App source root is unsafe or overlaps another recovery domain"
  select_backup_postgresql_toolchain_for_authority \
    "${BACKUP_AUTHORITY_ENV_FILE}" \
    || die "Sealed PostgreSQL authority or trusted client toolchain changed"
  local archive_name archive_path
  archive_name="${BACKUP_ARCHIVE_NAME}"
  archive_path="${backup_dir}/${archive_name}"
  PARTIAL_ARCHIVE="${archive_path}.partial-${RUN_ID}"

  mkdir -p "${BACKUP_BASE}/logs"
  fsync_directory "$complete_backup_dir" \
    || die "Complete backup type directory could not be made durable"
  fsync_directory "$degraded_backup_dir" \
    || die "Degraded backup type directory could not be made durable"
  fsync_directory "${BACKUP_BASE}/degraded" \
    || die "Degraded backup directory could not be made durable"
  fsync_directory "$BACKUP_BASE" \
    || die "Backup base directory could not be made durable"

  log "Starting ${type} backup"
  log "Portal root: ${PORTAL_DIR}"
  set_backup_phase database-fence-admission "Checking database fence" 2 \
    || die "Backup progress state could not be updated"
  # Nothing is stopped until the fence has been proven possible on this
  # host. A recovery backup that cannot fence the database cannot
  # succeed, and stopping the portal to discover that costs real downtime
  # for an archive that was never going to exist.
  assert_backup_database_exclusion_admission \
    || die "A recovery backup could not establish a trusted local PostgreSQL fence through either the host peer socket or a uniquely matched loopback Docker container. No services were stopped. Verify the database endpoint, container health, persistent PGDATA mount, and internal PostgreSQL peer socket."
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before source quiescence"
  set_backup_phase quiescing-services "Quiescing Portal services" 3 \
    || die "Backup progress state could not be updated"
  quiesce_comprehensive_backup_sources \
    || die "Portal backup sources could not be quiesced safely"
  assert_backup_disk_admission \
    || die_with_code BACKUP_DISK_ADMISSION_FAILED \
      "Backup storage admission changed after source quiescence"
  set_backup_phase fencing-database "Fencing database connections" 4 \
    || die "Backup progress state could not be updated"
  acquire_backup_database_exclusion \
    || die "Portal database could not be fenced exclusively for recovery capture"

  set_backup_phase database-snapshot "Capturing database snapshot" 5 \
    || die "Backup progress state could not be updated"
  log "Dumping Portal database"
  local database_logical_bytes="" database_relation_count=""
  local database_contract_variant="" database_metadata=""
  local database_metadata_path="${staging}/.database-metadata"
  local -a database_metadata_lines=()
  # Keep the snapshot client and pg_dump directly parented by the main backup
  # process.  A command substitution here creates an intermediate Bash process;
  # SIGKILL of the service main PID can then orphan that process and defeat the
  # anonymous credential runner's parent-death fence.
  if ! dump_database_consistent \
      "${staging}/database.dump" "${staging}/.database-identity.json" \
      > "${database_metadata_path}"; then
    die "Database snapshot, metadata, or dump was unavailable"
  fi
  mapfile -t database_metadata_lines < "${database_metadata_path}" \
    || die "Database snapshot metadata could not be read"
  [[ "${#database_metadata_lines[@]}" -eq 1 ]] \
    || die "Database snapshot metadata was invalid"
  database_metadata="${database_metadata_lines[0]}"
  rm -f -- "${database_metadata_path}"
  IFS='|' read -r database_logical_bytes database_relation_count \
    database_contract_variant \
    <<<"${database_metadata}"
  [[ "${database_logical_bytes}" =~ ^[1-9][0-9]*$ \
    && "${database_relation_count}" =~ ^[1-9][0-9]*$ \
    && ( "${database_contract_variant}" == "owner-null" \
      || "${database_contract_variant}" == "pg-database-owner-default" ) ]] \
    || die "Database snapshot metadata was invalid"
  [[ -s "${staging}/database.dump" ]] || die "Database dump was empty; refusing to publish an incomplete backup"
  record_recovery_component \
    database required captured database.dump configured-postgresql-database pg-dump-custom \
    "" "${database_logical_bytes}" "${database_relation_count}" \
    "${database_contract_variant}"

  set_backup_phase portal-data "Archiving Portal data" 6 \
    || die "Backup progress state could not be updated"
  log "Archiving app/runtime data"
  archive_required_component \
    portal-app-sources "${PORTAL_APP_SOURCES_DIR}" \
    "${staging}/portal-app-sources.tar.gz"
  archive_required_component hosted-apps "$APP_FILES_DIR" "${staging}/apps.tar.gz"
  if [[ "$LEGACY_APP_FILES_DIR" != "$APP_FILES_DIR" ]]; then
    archive_optional_component \
      legacy-hosted-apps "$LEGACY_APP_FILES_DIR" "${staging}/legacy-apps.tar.gz" \
      "Legacy app deployment root is not present for this installation profile"
  fi
  # OpenClaw hardlinks its media directory to Portal Files uploads, so these
  # two components share inodes by design. Each archive keeps its own copy of
  # the data; only the link relationship is not preserved across a restore.
  archive_required_component_with_retries \
    portal-files "$PORTAL_FILES_DIR" "${staging}/portal-files.tar.gz" 3 \
    --allow-external-hardlinks
  archive_required_component upload-storage "$UPLOAD_FILES_DIR" "${staging}/uploads.tar.gz"
  if [[ "$LEGACY_PORTAL_FILES_DIR" != "$PORTAL_FILES_DIR" \
    && "$LEGACY_PORTAL_FILES_DIR" != "$UPLOAD_FILES_DIR" ]]; then
    archive_optional_component \
      legacy-portal-files "$LEGACY_PORTAL_FILES_DIR" "${staging}/legacy-portal-files.tar.gz" \
      "Legacy Portal file root is not present for this installation profile"
  fi
  archive_required_component_with_retries \
    projects "$PROJECTS_DIR" "${staging}/projects.tar.gz" 3 \
    --allow-project-interpreter-symlinks
  archive_required_component \
    portal-backend-state "$PORTAL_BACKEND_STATE_DIR" "${staging}/portal-backend-state.tar.gz" \
    --exclude='backups/status.json' \
    --exclude='backups/current.log' \
    --exclude='backups/backup.lock' \
    --exclude='runtime-turn-events/*' \
    --exclude='maintenance-history/*'
  archive_required_component portal-state "$PORTAL_STATE_DIR" "${staging}/portal-state.tar.gz"
  archive_required_component portal-assets "$PORTAL_ASSETS_DIR" "${staging}/portal-assets.tar.gz"
  if [[ "$RUNTIME_ROOT" != "$PROJECTS_DIR" ]]; then
    local -a legacy_runtime_excludes=(
      --exclude='*/node_modules'
      --exclude='*/.git'
      --exclude='*/tmp'
      --exclude='*/.cache'
    )
    if [[ "${PORTAL_APP_SOURCES_DIR}" == "${RUNTIME_ROOT}/apps" ]]; then
      legacy_runtime_excludes+=(--exclude='apps')
    fi
    archive_optional_component \
      legacy-portal-runtime "$RUNTIME_ROOT" "${staging}/legacy-portal-runtime.tar.gz" \
      "Legacy Portal runtime root is not present for this installation profile" \
      "${legacy_runtime_excludes[@]}"
  fi

  log "Archiving Portal install"
  local -a portal_excludes=(
    --exclude='.env*'
    --exclude='.ENV*'
    --exclude='*.env'
    --exclude='*.ENV'
    --exclude='.git'
    --exclude='*.log'
    --exclude='*.tar.gz'
    --exclude='backend/.data'
    --exclude='.data'
    --exclude='projects'
    --exclude='upload-temp'
    --exclude='assets/avatars'
  )
  if [[ "${PORTAL_APP_SOURCES_DIR}" == "${PORTAL_DIR}/apps" ]]; then
    portal_excludes+=(--exclude='apps')
  fi
  if [[ "$type" == "daily" ]]; then
    portal_excludes+=(--exclude='node_modules' --exclude='frontend/dist' --exclude='backend/dist')
  fi
  archive_required_component \
    portal-install "$PORTAL_DIR" "${staging}/portal-install.tar.gz" "${portal_excludes[@]}"

  set_backup_phase mail-data "Archiving mail data" 7 \
    || die "Backup progress state could not be updated"
  log "Archiving mail data and configuration"
  local stalwart_policy="${STALWART_BACKUP_POLICY:-auto}"
  local stalwart_configured=false
  case "$stalwart_policy" in
    auto)
      if [[ -n "$(read_env_value "$(backup_database_authority_environment)" STALWART_ADMIN_PASS 2>/dev/null || true)" \
        || -d "$STALWART_DIR" \
        || -d "$STALWART_MAIL_DIR" \
        || -d "$STALWART_INSTALL_DIR" \
        || -f "${SYSTEMD_DIR}/stalwart-mail.service" ]]; then
        stalwart_configured=true
      fi
      ;;
    required) stalwart_configured=true ;;
    absent)
      if [[ -d "$STALWART_DIR" || -d "$STALWART_MAIL_DIR" || -d "$STALWART_INSTALL_DIR" \
        || -f "${SYSTEMD_DIR}/stalwart-mail.service" ]]; then
        die "STALWART_BACKUP_POLICY=absent conflicts with installed Stalwart evidence"
      fi
      ;;
    *) die "STALWART_BACKUP_POLICY must be auto, required, or absent" ;;
  esac
  if [[ "$STALWART_DIR" == "$STALWART_MAIL_DIR" \
    || "$STALWART_DIR" == "$STALWART_INSTALL_DIR" \
    || "$STALWART_MAIL_DIR" == "$STALWART_INSTALL_DIR" ]]; then
    die "Stalwart recovery roots must be distinct"
  fi
  if $stalwart_configured; then
    local stalwart_sources_captured=0
    if [[ -d "$STALWART_DIR" && ! -L "$STALWART_DIR" ]]; then
      ((stalwart_sources_captured += 1))
    fi
    if [[ -d "$STALWART_MAIL_DIR" && ! -L "$STALWART_MAIL_DIR" ]]; then
      ((stalwart_sources_captured += 1))
    fi
    if [[ -d "$STALWART_INSTALL_DIR" && ! -L "$STALWART_INSTALL_DIR" ]]; then
      ((stalwart_sources_captured += 1))
    fi
    (( stalwart_sources_captured > 0 )) \
      || die "Stalwart is configured but no configured mail data root exists; set STALWART_DIR or STALWART_INSTALL_DIR"
    archive_configured_feature_component \
      stalwart-data "$STALWART_DIR" "${staging}/stalwart-data.tar.gz" \
      "Stalwart was configured but this data root did not exist at backup time" \
      --exclude='logs/*' \
      --exclude='data/LOG' \
      --exclude='data/LOG.old*'
    archive_configured_feature_component \
      stalwart-mail-data "$STALWART_MAIL_DIR" "${staging}/stalwart-mail-data.tar.gz" \
      "Stalwart was configured but this alternate data root did not exist at backup time"
    archive_configured_feature_component \
      stalwart-install "$STALWART_INSTALL_DIR" "${staging}/stalwart-install.tar.gz" \
      "Stalwart was configured but this install root did not exist at backup time"
  else
    record_absent_component \
      stalwart-data "$STALWART_DIR" \
      "No Stalwart credentials, service unit, install root, or data root were found"
    record_absent_component \
      stalwart-mail-data "$STALWART_MAIL_DIR" \
      "No Stalwart credentials, service unit, install root, or data root were found"
    record_absent_component \
      stalwart-install "$STALWART_INSTALL_DIR" \
      "No Stalwart credentials, service unit, install root, or data root were found"
  fi

  # OpenClaw state, sessions, configuration and memory are outside Portal v3.
  # A separate optional export may be added without coupling its failure here.

  set_backup_phase recovery-metadata "Capturing recovery metadata" 8 \
    || die "Backup progress state could not be updated"
  mkdir -p "${staging}/configs" "${staging}/systemd"
  [[ "${BACKUP_AUTHORITY_ENV_FILE}" \
      == "${staging}/configs/portal-backend.env.production" \
    && -f "${BACKUP_AUTHORITY_ENV_FILE}" \
    && ! -L "${BACKUP_AUTHORITY_ENV_FILE}" \
    && "$(stat -c '%u:%g:%a:%h' "${BACKUP_AUTHORITY_ENV_FILE}")" \
      == "0:0:600:1" ]] \
    || die "Sealed Portal environment authority changed during backup"
  record_recovery_component \
    portal-environment required captured \
    configs/portal-backend.env.production "${PORTAL_ENV_FILE}" v3-sanitized-environment

  assert_backup_sources_quiescent \
    || die "Comprehensive backup sources did not remain fenced and quiescent through capture"
  assert_backup_database_exclusion \
    || die "Portal database exclusion changed during comprehensive capture"
  finalize_recovery_manifest "${staging}/RECOVERY-MANIFEST.json" "$type" \
    "${staging}/.database-identity.json"

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
    (cd "$staging" && find . -type f \
      ! -name MANIFEST.txt ! -name ARCHIVE-MAC.json \
      -print0 | sort -z | xargs -0 sha256sum)
  } > "${staging}/MANIFEST.txt"
  chmod 600 "${staging}/MANIFEST.txt"
  sync -f -- "${staging}/MANIFEST.txt" \
    || die "Backup checksum manifest was not committed durably"
  write_archive_mac "$staging" \
    || die "Backup checksum manifest could not be authenticated"
  sync -f -- "${staging}/ARCHIVE-MAC.json" \
    || die "Backup MAC record was not committed durably"
  fsync_directory "$staging" \
    || die "Authenticated backup staging directory was not committed durably"
  verify_staging_manifest "$staging" "$RUN_DEGRADED" \
    || die "Backup manifest checksum generation failed"

  if $RUN_DEGRADED; then
    backup_dir="${degraded_backup_dir}"
    archive_path="${backup_dir}/${archive_name}"
    PARTIAL_ARCHIVE="${archive_path}.partial-${RUN_ID}"
  fi

  set_backup_phase creating-archive "Creating backup archive" 9 \
    || die "Backup progress state could not be updated"
  log "Creating archive ${archive_path}"
  local publication_role="complete"
  $RUN_DEGRADED && publication_role="degraded"
  write_bounded_backup_archive \
    "${staging}" "${publication_role}" "${PARTIAL_ARCHIVE}" \
    || die "Backup archive exceeded or lost its exact held capacity"
  set_backup_phase verifying-archive "Verifying and publishing archive" 10 \
    || die "Backup progress state could not be updated"
  if ! verify_archive "$PARTIAL_ARCHIVE" "$RUN_DEGRADED"; then
    die "Published archive would not satisfy the recovery manifest contract"
  fi
  BACKUP_CAPACITY_STATE="verified"
  assert_backup_capacity_guard \
    || die "Held backup recovery capacity changed during verification"

  local file_count
  file_count="$(tar tzf "$PARTIAL_ARCHIVE" | wc -l)"
  if (( file_count < 2 )); then
    die "Archive integrity check failed: only ${file_count} entries"
  fi
  [[ ! -e "$archive_path" && ! -L "$archive_path" ]] || die "Refusing to overwrite an existing backup: ${archive_path}"
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before backup publication"
  assert_backup_capacity_guard \
    || die "Held backup recovery capacity was lost before backup publication"
  assert_backup_database_exclusion \
    || die "Portal database exclusion changed before backup publication"

  local completeness="complete"
  local -a receipt_components=()
  if $RUN_DEGRADED; then
    completeness="degraded"
    mapfile -t receipt_components < <(printf '%s\n' "${RUN_DEGRADED_COMPONENTS[@]}" | sort -u)
  fi
  if ! write_backup_publication_receipt \
      "$PARTIAL_ARCHIVE" "$archive_path" "$type" "$completeness" \
      "${staging}/ARCHIVE-MAC.json" "${receipt_components[@]}"; then
    die "Backup publication receipt could not be authenticated and settled"
  fi
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before the publication commit"
  assert_backup_capacity_guard \
    || die "Held backup recovery capacity changed before the publication commit"
  assert_backup_database_exclusion \
    || die "Portal database exclusion changed before the publication commit"
  publish_backup_candidate \
    "$PARTIAL_ARCHIVE" "$archive_path" "$publication_role" \
    || die "Backup archive and receipt could not be committed atomically"
  PARTIAL_ARCHIVE=""
  if ! assert_backup_lock_guard \
    || ! assert_backup_database_exclusion \
    || ! assert_backup_capacity_guard; then
    BACKUP_PUBLICATION_COMMITTED=false
    die "Backup authority changed at the publication commit"
  fi

  local size
  size="$(du -h "$archive_path" | awk '{print $1}')"
  RUN_ARCHIVE_PATH="$archive_path"
  if $RUN_DEGRADED; then
    local degraded_list
    degraded_list="$(IFS=,; printf '%s' "${RUN_DEGRADED_COMPONENTS[*]}")"
    RUN_ERROR_DETAIL="Backup archive was published in degraded state; unavailable components: ${degraded_list}"
    log "WARNING: ${RUN_ERROR_DETAIL}: ${archive_path} (${size}, ${file_count} entries)"
    prune_degraded_backups "$type"
    return 1
  fi

  prune_backups "$type"
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
    local degraded_dir="${BACKUP_BASE}/degraded/${type}"
    printf '%s\n' '-- degraded salvage --'
    if [[ -d "$degraded_dir" ]]; then
      find "$degraded_dir" -maxdepth 1 -type f -name 'portal-*.tar.gz' -printf '%TY-%Tm-%Td %TH:%TM %10s %p\n' | sort -r || true
    else
      printf '(none)\n'
    fi
  done
}

verify_backups() {
  local ok=true
  local checked=0
  for type in daily weekly monthly comprehensive; do
    local latest
    latest="$(find "${BACKUP_BASE}/${type}" -maxdepth 1 -type f -name 'portal-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
    [[ -n "$latest" ]] || continue
    ((checked += 1))
    printf '%s: %s\n' "$type" "$latest"
    if ! verify_archive "$latest"; then
      printf '  ERROR: archive structure or manifest checksum validation failed\n'
      ok=false
      continue
    fi
    printf '  OK\n'
  done
  if (( checked == 0 )); then
    printf 'ERROR: no Portal backup archives were found\n'
    return 1
  fi
  $ok
}

ensure_backup_private_execution_namespace() {
  local requested="${1:-daily}"
  case "${requested}" in
    daily|weekly|monthly|comprehensive|--verify|--verify-archive) ;;
    *) return 0 ;;
  esac
  [[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

  if [[ "${BRIDGESLLM_BACKUP_PRIVATE_NAMESPACE:-}" == "established-v1" ]]; then
    python3 - <<'PY'
import os

if (
    os.getppid() != 1
    or os.readlink("/proc/self/ns/mnt") == os.readlink("/proc/1/ns/mnt")
    or os.readlink("/proc/self/ns/pid") == os.readlink("/proc/1/ns/pid")
):
    raise SystemExit("backup private namespace identity changed")
PY
    return
  fi

  if [[ "${BRIDGESLLM_BACKUP_PRIVATE_NAMESPACE:-}" == "v1" ]]; then
    local inherited_script_fd="${BRIDGESLLM_BACKUP_REEXEC_FD:-}"
    local inherited_supervisor_fd="${BRIDGESLLM_BACKUP_SUPERVISOR_FD:-}"
    local namespace_authority="" authority_extra=""
    # Namespace PID 1 does not honor an ordinary default-TERM disposition.
    # Install provisional handlers before the readiness handshake; begin_run
    # and begin_backup_verification replace them with their cleanup traps.
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    namespace_authority="$(python3 - "${BRIDGESLLM_BACKUP_REEXEC_FD:-}" \
      "${BRIDGESLLM_BACKUP_REEXEC_DEV:-}" \
      "${BRIDGESLLM_BACKUP_REEXEC_INO:-}" \
      "${BRIDGESLLM_BACKUP_SUPERVISOR_FD:-}" \
      "${BRIDGESLLM_BACKUP_BASH_DEV:-}" \
      "${BRIDGESLLM_BACKUP_BASH_INO:-}" <<'PY'
import os
import re
import stat
import sys

try:
    script_fd = int(sys.argv[1])
    expected_device = int(sys.argv[2])
    expected_inode = int(sys.argv[3])
    supervisor_fd = int(sys.argv[4])
    expected_bash_device = int(sys.argv[5])
    expected_bash_inode = int(sys.argv[6])
except (IndexError, TypeError, ValueError):
    raise SystemExit("backup private namespace authority is invalid")
if (
    script_fd < 3
    or supervisor_fd < 3
    or script_fd == supervisor_fd
    or expected_bash_device < 0
    or expected_bash_inode <= 0
):
    raise SystemExit("backup private namespace descriptors are invalid")
script = os.fstat(script_fd)
if (
    not stat.S_ISREG(script.st_mode)
    or script.st_uid != 0
    or script.st_gid != 0
    or script.st_nlink < 1
    or script.st_mode & 0o022
    or not script.st_mode & 0o100
    or script.st_dev != expected_device
    or script.st_ino != expected_inode
):
    raise SystemExit("backup reexec descriptor changed")
positive = re.compile(r"[1-9][0-9]*")

def process_record(host_pid):
    if host_pid <= 0:
        raise SystemExit("backup namespace process identity is invalid")
    base = f"/proc/{host_pid}"
    try:
        status = open(
            f"{base}/status", "r", encoding="ascii"
        ).read().splitlines()
        raw_stat = open(
            f"{base}/stat", "r", encoding="ascii"
        ).read().strip()
        mount_identity = os.readlink(f"{base}/ns/mnt")
        pid_identity = os.readlink(f"{base}/ns/pid")
        executable = os.stat(f"{base}/exe")
    except OSError:
        raise SystemExit("backup namespace process identity is unavailable")
    closing = raw_stat.rfind(")")
    fields = raw_stat[closing + 2:].split() if closing > 1 else []
    pids = [
        line.partition(":")[2].strip()
        for line in status if line.startswith("Pid:")
    ]
    parents = [
        line.partition(":")[2].strip()
        for line in status if line.startswith("PPid:")
    ]
    namespace_pids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("NSpid:")
    ]
    uids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("Uid:")
    ]
    gids = [
        line.partition(":")[2].split()
        for line in status if line.startswith("Gid:")
    ]
    if (
        len(fields) < 20
        or fields[0] == "Z"
        or not re.fullmatch(r"[0-9]+", fields[19])
        or pids != [str(host_pid)]
        or len(parents) != 1
        or positive.fullmatch(parents[0]) is None
        or fields[1] != parents[0]
        or len(namespace_pids) != 1
        or len(namespace_pids[0]) < 1
        or namespace_pids[0][0] != str(host_pid)
        or not all(positive.fullmatch(value) for value in namespace_pids[0])
        or uids != [["0", "0", "0", "0"]]
        or gids != [["0", "0", "0", "0"]]
    ):
        raise SystemExit("backup namespace process identity is invalid")
    return {
        "pid": host_pid,
        "parent": int(parents[0]),
        "namespacePids": tuple(namespace_pids[0]),
        "mountNamespace": mount_identity,
        "pidNamespace": pid_identity,
        "starttime": fields[19],
        "executableDevice": executable.st_dev,
        "executableInode": executable.st_ino,
    }

def exact_bash(record):
    return (
        record["executableDevice"] == expected_bash_device
        and record["executableInode"] == expected_bash_inode
    )

def same_private_namespace(record, current):
    return (
        len(record["namespacePids"]) == len(current["namespacePids"])
        and record["mountNamespace"] == current["mountNamespace"]
        and record["pidNamespace"] == current["pidNamespace"]
    )

try:
    current_status = open(
        "/proc/self/status", "r", encoding="ascii"
    ).read().splitlines()
    host_mount_namespace = os.readlink("/proc/1/ns/mnt")
    host_pid_namespace = os.readlink("/proc/1/ns/pid")
except OSError:
    raise SystemExit("backup namespace identity is unavailable")
current_host_pids = [
    line.partition(":")[2].strip()
    for line in current_status if line.startswith("Pid:")
]
if (
    len(current_host_pids) != 1
    or positive.fullmatch(current_host_pids[0]) is None
):
    raise SystemExit("backup private namespace was not established")
current = process_record(int(current_host_pids[0]))
local_parent = os.getppid()
if (
    current["mountNamespace"] == host_mount_namespace
    or current["pidNamespace"] == host_pid_namespace
    or len(current["namespacePids"]) < 2
    or current["namespacePids"][-1] != str(os.getpid())
    or local_parent <= 0
):
    raise SystemExit("backup private namespace was not established")

intermediate = None
if local_parent == 1:
    namespace_pid_one = process_record(current["parent"])
else:
    # Bash normally executes command substitutions in one short-lived process.
    # Admit exactly that one process, bound to its inner/host PIDs, executable,
    # namespaces, ownership, parent, and start time.  A second boundary fails
    # because the admitted intermediate's parent is not namespace PID 1.
    intermediate = process_record(current["parent"])
    if (
        intermediate["namespacePids"][-1] != str(local_parent)
        or not exact_bash(intermediate)
        or not same_private_namespace(intermediate, current)
    ):
        raise SystemExit("backup namespace intermediary is invalid")
    namespace_pid_one = process_record(intermediate["parent"])

if (
    namespace_pid_one["namespacePids"][-1] != "1"
    or not exact_bash(namespace_pid_one)
    or not same_private_namespace(namespace_pid_one, current)
):
    raise SystemExit("backup namespace PID 1 identity is invalid")
supervisor_pid = namespace_pid_one["parent"]
supervisor = process_record(supervisor_pid)
if (
    supervisor["pidNamespace"] != host_pid_namespace
    or supervisor["mountNamespace"] != current["mountNamespace"]
):
    raise SystemExit("backup namespace supervisor identity is invalid")

# Every ancestor is waiting for this helper, so none can exit legitimately.
# Re-read the complete records before publishing readiness to detect any
# unexpected /proc identity change rather than trusting the first observation.
if process_record(namespace_pid_one["pid"]) != namespace_pid_one:
    raise SystemExit("backup namespace PID 1 identity changed")
if intermediate is not None \
    and process_record(intermediate["pid"]) != intermediate:
    raise SystemExit("backup namespace intermediary identity changed")
if process_record(supervisor_pid) != supervisor:
    raise SystemExit("backup namespace supervisor identity changed")
payload = f"READY\t{namespace_pid_one['pid']}\n".encode("ascii")
if os.write(supervisor_fd, payload) != len(payload):
    raise SystemExit("backup namespace supervisor handshake was short")
os.close(supervisor_fd)
print(f"{supervisor_pid}\t{supervisor['starttime']}")
PY
    )" || die "Backup private namespace authority could not be established"
    IFS=$'\t' read -r BACKUP_MAIN_HOST_PID BACKUP_MAIN_HOST_STARTTIME \
      authority_extra <<<"${namespace_authority}"
    [[ "${BACKUP_MAIN_HOST_PID}" =~ ^[1-9][0-9]*$ \
      && "${BACKUP_MAIN_HOST_STARTTIME}" =~ ^[0-9]+$ \
      && -z "${authority_extra}" ]] \
      || die "Backup private namespace process authority is invalid"
    exec {inherited_supervisor_fd}>&-
    exec {inherited_script_fd}<&-
    BRIDGESLLM_BACKUP_PRIVATE_NAMESPACE="established-v1"
    export BRIDGESLLM_BACKUP_PRIVATE_NAMESPACE
    unset BRIDGESLLM_BACKUP_REEXEC_FD BRIDGESLLM_BACKUP_REEXEC_DEV \
      BRIDGESLLM_BACKUP_REEXEC_INO BRIDGESLLM_BACKUP_SUPERVISOR_FD \
      BRIDGESLLM_BACKUP_BASH_DEV BRIDGESLLM_BACKUP_BASH_INO
    return
  fi

  [[ -z "${BRIDGESLLM_BACKUP_PRIVATE_NAMESPACE:-}" \
    && -z "${BRIDGESLLM_BACKUP_REEXEC_FD:-}" \
    && -z "${BRIDGESLLM_BACKUP_REEXEC_DEV:-}" \
    && -z "${BRIDGESLLM_BACKUP_REEXEC_INO:-}" \
    && -z "${BRIDGESLLM_BACKUP_SUPERVISOR_FD:-}" \
    && -z "${BRIDGESLLM_BACKUP_BASH_DEV:-}" \
    && -z "${BRIDGESLLM_BACKUP_BASH_INO:-}" ]] \
    || die "Refusing an unverified backup namespace marker"

  local script_path="" script_fd="" script_identity="" script_dev="" script_ino=""
  script_path="$(realpath -e -- "$0" 2>/dev/null)" \
    || die "Backup runner path could not be resolved for private reexec"
  exec {script_fd}<"${script_path}" \
    || die "Backup runner could not be pinned for private reexec"
  script_identity="$(python3 - "${script_fd}" <<'PY'
import os
import stat
import sys

descriptor = int(sys.argv[1])
info = os.fstat(descriptor)
if (
    not stat.S_ISREG(info.st_mode)
    or info.st_uid != 0
    or info.st_gid != 0
    or info.st_nlink < 1
    or info.st_mode & 0o022
    or not info.st_mode & 0o100
):
    raise SystemExit(1)
print(f"{info.st_dev}\t{info.st_ino}")
PY
  )" || die "Backup runner descriptor is unsafe for private reexec"
  IFS=$'\t' read -r script_dev script_ino <<<"${script_identity}"
  [[ "${script_dev}" =~ ^[0-9]+$ && "${script_ino}" =~ ^[1-9][0-9]*$ ]] \
    || die "Backup runner descriptor identity is invalid"

  exec python3 /dev/fd/3 "${script_fd}" "${script_dev}" "${script_ino}" \
    "${script_path}" "$@" 3<<'PY'
import ctypes
import os
import pathlib
import re
import select
import signal
import stat
import sys
import time

script_fd = int(sys.argv[1])
script_device = int(sys.argv[2])
script_inode = int(sys.argv[3])
script_label = sys.argv[4]
arguments = sys.argv[5:]
if (
    not script_label.startswith("/")
    or os.path.normpath(script_label) != script_label
    or pathlib.Path(script_label).name != "backup-full.sh"
    or len(script_label.encode("utf-8")) > 1024
):
    raise SystemExit("backup supervisor script label is unsafe")
required = (pathlib.Path("/bin/bash"),)
bash_identity = None
for path in required:
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink < 1
        or info.st_mode & 0o022
        or not info.st_mode & 0o100
    ):
        raise SystemExit("backup namespace tool is unsafe")
    bash_identity = (info.st_dev, info.st_ino)
if bash_identity is None:
    raise SystemExit("backup namespace shell identity is unavailable")
script = os.fstat(script_fd)
if (
    not stat.S_ISREG(script.st_mode)
    or script.st_dev != script_device
    or script.st_ino != script_inode
    or script.st_uid != 0
    or script.st_gid != 0
    or script.st_mode & 0o022
):
    raise SystemExit("backup reexec descriptor changed before supervision")

read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
environment = os.environ.copy()
environment.update({
    "BRIDGESLLM_BACKUP_PRIVATE_NAMESPACE": "v1",
    "BRIDGESLLM_BACKUP_REEXEC_FD": str(script_fd),
    "BRIDGESLLM_BACKUP_REEXEC_DEV": str(script_device),
    "BRIDGESLLM_BACKUP_REEXEC_INO": str(script_inode),
    "BRIDGESLLM_BACKUP_SUPERVISOR_FD": str(write_fd),
    "BRIDGESLLM_BACKUP_BASH_DEV": str(bash_identity[0]),
    "BRIDGESLLM_BACKUP_BASH_INO": str(bash_identity[1]),
})
pending_signal = 0

def remember_signal(number, _frame):
    global pending_signal
    if pending_signal == 0:
        pending_signal = number

for managed in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(managed, remember_signal)

libc = ctypes.CDLL(None, use_errno=True)
CLONE_NEWNS = 0x00020000
CLONE_NEWPID = 0x20000000
MS_REC = 16384
MS_PRIVATE = 1 << 18
PR_SET_PDEATHSIG = 1
if libc.unshare(CLONE_NEWNS | CLONE_NEWPID) != 0:
    number = ctypes.get_errno()
    raise OSError(number, os.strerror(number))
libc.mount.argtypes = [
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_ulong,
    ctypes.c_void_p,
]
libc.mount.restype = ctypes.c_int
if libc.mount(None, b"/", None, MS_REC | MS_PRIVATE, None) != 0:
    number = ctypes.get_errno()
    raise OSError(number, os.strerror(number))

supervisor_pid = os.getpid()
child_pid = os.fork()
if child_pid == 0:
    try:
        os.close(read_fd)
        os.setsid()
        if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
            number = ctypes.get_errno()
            raise OSError(number, os.strerror(number))
        status = open(
            "/proc/self/status", "r", encoding="ascii"
        ).read().splitlines()
        parents = [
            line.partition(":")[2].strip()
            for line in status if line.startswith("PPid:")
        ]
        if parents != [str(supervisor_pid)]:
            os.kill(os.getpid(), signal.SIGKILL)
        os.set_inheritable(script_fd, True)
        os.set_inheritable(write_fd, True)
        os.execve(
            "/bin/bash",
            ["/bin/bash", f"/proc/self/fd/{script_fd}", *arguments],
            environment,
        )
    except BaseException:
        os._exit(127)
try:
    child_pidfd = os.pidfd_open(child_pid, 0)
except (AttributeError, OSError):
    try:
        os.kill(child_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(child_pid, 0)
    raise RuntimeError("backup namespace requires pidfd authority")
os.close(write_fd)
inner_host_pid = None
buffer = b""
deadline = time.monotonic() + 30

child_reaped = False

def poll_child():
    global child_reaped
    if child_reaped:
        raise RuntimeError("backup namespace child was already reaped")
    result, status = os.waitpid(child_pid, os.WNOHANG)
    if result == 0:
        return None
    child_reaped = True
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    raise RuntimeError("backup namespace child entered an unsupported state")

def signal_child(number):
    try:
        signal.pidfd_send_signal(child_pidfd, number)
        return True
    except ProcessLookupError:
        return False
    except (AttributeError, OSError):
        raise RuntimeError("backup namespace pidfd signal failed")

try:
    while inner_host_pid is None:
        early_status = poll_child()
        if early_status is not None:
            raise RuntimeError("backup namespace child exited before readiness")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("backup namespace child readiness timed out")
        ready, _, _ = select.select([read_fd], [], [], min(0.25, remaining))
        if ready:
            chunk = os.read(read_fd, 4096)
            if not chunk:
                raise RuntimeError("backup namespace readiness pipe closed")
            buffer += chunk
            if len(buffer) > 128:
                raise RuntimeError("backup namespace readiness was unbounded")
            if b"\n" in buffer:
                line, remainder = buffer.split(b"\n", 1)
                match = re.fullmatch(rb"READY\t([1-9][0-9]*)", line)
                if match is None or remainder:
                    raise RuntimeError("backup namespace readiness was malformed")
                inner_host_pid = int(match.group(1))
                if inner_host_pid != child_pid:
                    raise RuntimeError("backup namespace host PID changed")
                raw_status = pathlib.Path(
                    f"/proc/{inner_host_pid}/status"
                ).read_text(encoding="ascii").splitlines()
                parents = [
                    item.partition(":")[2].strip()
                    for item in raw_status if item.startswith("PPid:")
                ]
                nspid = [
                    item.partition(":")[2].split()
                    for item in raw_status if item.startswith("NSpid:")
                ]
                if (
                    parents != [str(supervisor_pid)]
                    or len(nspid) != 1
                    or len(nspid[0]) < 2
                    or nspid[0][0] != str(inner_host_pid)
                    or nspid[0][-1] != "1"
                ):
                    raise RuntimeError("backup namespace child identity is invalid")
        if pending_signal and inner_host_pid is None:
            # The child gets a short readiness window so its ordinary shell
            # traps, lock handoff, and service-recovery path remain available.
            deadline = min(deadline, time.monotonic() + 5)
    os.close(read_fd)
    read_fd = -1

    forwarded = False
    signal_deadline = None
    return_code = None
    while return_code is None:
        if pending_signal and not forwarded:
            signal_child(pending_signal)
            forwarded = True
            signal_deadline = time.monotonic() + 600
        if signal_deadline is not None and time.monotonic() >= signal_deadline:
            signal_child(signal.SIGKILL)
        time.sleep(0.1)
        return_code = poll_child()
except BaseException:
    if not child_reaped:
        signal_child(signal.SIGKILL)
        try:
            os.waitpid(child_pid, 0)
        except ChildProcessError:
            pass
    raise
finally:
    if read_fd >= 0:
        os.close(read_fd)
    os.close(child_pidfd)
raise SystemExit(return_code)
PY
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ensure_backup_private_execution_namespace "$@"
fi

case "${1:-daily}" in
  daily|weekly|monthly|comprehensive) create_backup "$1" ;;
  --list)
    BACKUP_BASE="$(validate_backup_base)" || die "Backup path validation failed"
    list_backups
    ;;
  --verify)
    BACKUP_BASE="$(validate_backup_base)" || die "Backup path validation failed"
    select_backup_postgresql_toolchain_for_authority "${PORTAL_ENV_FILE}" \
      || die "The active PostgreSQL server/toolchain does not satisfy the supported security floor"
    begin_backup_verification
    verify_backups
    ;;
  --verify-archive)
    [[ $# -eq 2 && "$2" == /* ]] \
      || die "Usage: $0 --verify-archive /absolute/path/to/archive.tar.gz"
    select_backup_postgresql_toolchain_for_authority "${PORTAL_ENV_FILE}" \
      || die "The active PostgreSQL server/toolchain does not satisfy the supported security floor"
    begin_backup_verification
    verify_archive "$2" \
      || die "Archive structure, recovery contract, or manifest checksum validation failed"
    printf 'OK: %s\n' "$2"
    ;;
  --recover-quiescence)
    [[ $# -eq 1 ]] \
      || die "Usage: $0 --recover-quiescence"
    recover_backup_quiescence_command
    ;;
  *) die "Usage: $0 [daily|weekly|monthly|comprehensive|--list|--verify|--verify-archive PATH|--recover-quiescence]" ;;
esac
