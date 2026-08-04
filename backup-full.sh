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
import os
import re
import stat
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

if [[ -e "$PORTAL_ENV_FILE" || -L "$PORTAL_ENV_FILE" ]]; then
  assert_env_file_unambiguous "$PORTAL_ENV_FILE" \
    || { printf 'ERROR: Portal environment authority is unsafe or ambiguous\n' >&2; exit 1; }
fi

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

set_backup_postgresql_client_toolchain || {
  printf 'ERROR: No trusted PostgreSQL client toolchain satisfies the supported security floor\n' >&2
  exit 1
}

DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"
MONTHLY_KEEP="${MONTHLY_KEEP:-3}"
COMPREHENSIVE_KEEP="${COMPREHENSIVE_KEEP:-4}"

STATUS_FILE="${BACKUP_STATE_DIR}/status.json"
OUTPUT_FILE="${BACKUP_STATE_DIR}/current.log"
LOCK_FILE="${BACKUP_STATE_DIR}/backup.lock"
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
STAGING_DIR=""
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
BACKUP_DATABASE_TRANSACTIONS_ROOT="${BACKUP_RECOVERY_STATE_DIR}/database-transactions"
BACKUP_CONTAINER_FENCE_HELPER="${PORTAL_DIR}/installer/backup-container-fence.py"
BACKUP_DATABASE_FENCE_MODE=""
BACKUP_LOCK_GUARD_PID=""
BACKUP_LOCK_GUARD_STARTTIME=""
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
  if $RUN_ACTIVE; then
    RUN_ERROR_DETAIL="$(printf '%s' "${detail}" | sanitize_status_detail 2>/dev/null \
      || printf '%s' 'Backup failed while sanitizing its diagnostic detail')"
    detail="${RUN_ERROR_DETAIL}"
  fi
  log "ERROR: ${detail}"
  exit 1
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

for name in ("daily", "weekly", "monthly", "comprehensive", "logs"):
    child = os.path.join(root, name)
    if not os.path.lexists(child):
        os.mkdir(child, mode=0o700)
        created.append(child)
    info = os.lstat(child)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit("Backup subdirectory is not securely owned")

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
  STATUS_RUN_ID="$RUN_ID" \
  STATUS_RUN_TYPE="$RUN_TYPE" \
  STATUS_VALUE="$status" \
  STATUS_STARTED_AT="$RUN_STARTED_AT" \
  STATUS_COMPLETED_AT="$completed_at" \
  STATUS_PID="$$" \
  STATUS_EXIT_CODE="$exit_code" \
  STATUS_ARCHIVE_PATH="$RUN_ARCHIVE_PATH" \
  STATUS_ERROR="$error_message" \
  STATUS_PHASE="$RUN_PHASE" \
  STATUS_PHASE_LABEL="$RUN_PHASE_LABEL" \
  STATUS_PHASE_INDEX="$RUN_PHASE_INDEX" \
  STATUS_PHASE_TOTAL="$RUN_PHASE_TOTAL" \
  python3 - "$STATUS_FILE" <<'PY'
import json
import os
import tempfile
import sys

target = sys.argv[1]

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
if os.environ.get("STATUS_PHASE"):
    payload["phase"] = os.environ["STATUS_PHASE"]
if os.environ.get("STATUS_PHASE_LABEL"):
    payload["phaseLabel"] = utf8_prefix(os.environ["STATUS_PHASE_LABEL"], 160)
if os.environ.get("STATUS_PHASE_INDEX") and os.environ.get("STATUS_PHASE_TOTAL"):
    payload["phaseIndex"] = int(os.environ["STATUS_PHASE_INDEX"])
    payload["phaseTotal"] = int(os.environ["STATUS_PHASE_TOTAL"])

directory = os.path.dirname(target)
os.makedirs(directory, mode=0o700, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix="status.", dir=directory, text=True)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
    os.chmod(target, 0o600)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
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

sweep_stale_backup_artifacts() {
  python3 - "$BACKUP_BASE" <<'PY'
import os
import pathlib
import re
import shutil
import stat
import sys

backup_root = pathlib.Path(sys.argv[1])
directory_pattern = re.compile(
    r"^bridgesllm-backup-(?:daily|weekly|monthly|comprehensive)-[A-Za-z0-9]+$"
)
file_pattern = re.compile(
    r"^(?:bridgesllm-backup-(?:verify|checksums)-[A-Za-z0-9]+"
    r"|bridgesllm-backup-running-containers\.[A-Za-z0-9]+)$"
)

def safe_root_owned(path: pathlib.Path, expect_directory: bool) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
        return False
    return stat.S_ISDIR(info.st_mode) if expect_directory else stat.S_ISREG(info.st_mode)

def contains_mount(path: pathlib.Path) -> bool:
    root = str(path)
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8") as handle:
            for line in handle:
                fields = line.split()
                if len(fields) < 5:
                    continue
                mountpoint = fields[4].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
                if mountpoint == root or mountpoint.startswith(root + os.sep):
                    return True
    except OSError:
        return True
    return False

tmp = pathlib.Path("/tmp")
for candidate in tmp.iterdir():
    if directory_pattern.fullmatch(candidate.name):
        if not safe_root_owned(candidate, True) or contains_mount(candidate):
            raise SystemExit("unsafe stale backup staging artifact")
        shutil.rmtree(candidate)
    elif file_pattern.fullmatch(candidate.name):
        if not safe_root_owned(candidate, False):
            raise SystemExit("unsafe stale backup helper artifact")
        candidate.unlink()

for kind in ("daily", "weekly", "monthly", "comprehensive"):
    directory = backup_root / kind
    if not directory.is_dir() or directory.is_symlink():
        continue
    for candidate in directory.iterdir():
        if ".partial-" not in candidate.name:
            continue
        if not re.fullmatch(r"portal-[A-Za-z0-9.-]+\.tar\.gz\.partial-[A-Za-z0-9._-]{1,128}", candidate.name):
            continue
        if not safe_root_owned(candidate, False):
            raise SystemExit("unsafe stale partial backup archive")
        candidate.unlink()
PY
}

assert_backup_disk_admission() {
  local reserve_bytes="${BACKUP_RECOVERY_RESERVE_BYTES:-536870912}"
  local database_bytes=""
  [[ "${reserve_bytes}" =~ ^[0-9]+$ \
    && "${reserve_bytes}" -ge 67108864 \
    && "${reserve_bytes}" -le 8589934592 ]] \
    || die "BACKUP_RECOVERY_RESERVE_BYTES must be between 64 MiB and 8 GiB"
  database_bytes="$(database_dump_admission_bytes)" \
    || die "Configured database size could not be measured for disk admission"
  [[ "${database_bytes}" =~ ^[1-9][0-9]*$ ]] \
    || die "Configured database size was invalid during disk admission"
  python3 - "${BACKUP_BASE}" "${reserve_bytes}" "${database_bytes}" \
    "${PORTAL_DIR}" "${APP_FILES_DIR}" "${PORTAL_APP_SOURCES_DIR}" \
    "${PORTAL_FILES_DIR}" "${UPLOAD_FILES_DIR}" \
    "${PROJECTS_DIR}" "${PORTAL_BACKEND_STATE_DIR}" "${PORTAL_STATE_DIR}" \
    "${PORTAL_ASSETS_DIR}" "${OPENCLAW_DIR}" "${STALWART_DIR}" \
    "${STALWART_MAIL_DIR}" "${STALWART_INSTALL_DIR}" \
    "${LEGACY_APP_FILES_DIR}" "${LEGACY_PORTAL_FILES_DIR}" "${RUNTIME_ROOT}" <<'PY'
import os
import pathlib
import stat
import sys

backup_root = pathlib.Path(sys.argv[1])
reserve = int(sys.argv[2])
database_bytes = int(sys.argv[3])
raw_roots = [pathlib.Path(value) for value in sys.argv[4:]]
roots = []
for candidate in raw_roots:
    try:
        if not candidate.is_dir() or candidate.is_symlink():
            continue
        canonical = pathlib.Path(os.path.realpath(candidate))
    except OSError:
        raise SystemExit("backup source topology could not be inspected")
    roots.append(canonical)

source_bytes = 0
metadata_bytes = 0
for root in roots:
    # Each source root is written to its own nested archive. A hard link that
    # crosses component roots therefore consumes space once per component.
    seen = set()
    for directory, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        base = pathlib.Path(directory)
        dirnames[:] = sorted(name for name in dirnames if not (base / name).is_symlink())
        metadata_bytes += 4096 * (1 + len(dirnames))
        for name in filenames:
            path = base / name
            try:
                info = os.lstat(path)
            except FileNotFoundError:
                raise SystemExit("backup source changed during disk admission")
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                metadata_bytes += 4096
                continue
            metadata_bytes += 4096
            identity = (info.st_dev, info.st_ino)
            if identity in seen:
                continue
            seen.add(identity)
            source_bytes += max(info.st_size, info.st_blocks * 512)
            if source_bytes + metadata_bytes > 2 * 1024**4:
                raise SystemExit("backup source inventory is unbounded")

# Plain pg_dump can expand bytea/text escaping beyond the database's physical
# size. Five times the measured database size plus fixed framing headroom is a
# conservative bound for the staged SQL.
database_dump_bound = database_bytes * 5 + 16 * 1024**2
payload_bound = source_bytes + metadata_bytes + database_dump_bound
if payload_bound > 2 * 1024**4:
    raise SystemExit("backup payload estimate is unbounded")

staging_anchor = pathlib.Path("/tmp")
locations = {
    # Staging and verify_archive's extracted copy coexist on /tmp.
    os.stat(staging_anchor).st_dev: {"path": staging_anchor, "required": payload_bound * 2},
}
backup_device = os.stat(backup_root).st_dev
if backup_device in locations:
    # The outer archive coexists with both /tmp copies when devices are shared.
    locations[backup_device]["required"] += payload_bound
else:
    locations[backup_device] = {"path": backup_root, "required": payload_bound}
for entry in locations.values():
    free = os.statvfs(entry["path"]).f_bavail * os.statvfs(entry["path"]).f_frsize
    required = entry["required"] + reserve
    if free < required:
        raise SystemExit(
            f"backup disk admission failed for {entry['path']}: "
            f"free={free} required={required} sourceBytes={source_bytes} "
            f"databaseBytes={database_bytes} payloadBound={payload_bound} reserve={reserve}"
        )
print(
    f"Backup disk admission passed: sourceBytes={source_bytes} "
    f"databaseBytes={database_bytes} payloadBound={payload_bound} "
    f"reserve={reserve} devices={len(locations)}"
)
PY
}

quiesce_comprehensive_backup_sources() {
  [[ "${RUN_TYPE}" == "comprehensive" ]] || return 0
  assert_backup_crash_persistent_control_filesystems || return 1
  BACKUP_QUIESCE_ACTIVE=true
  if ! python3 - "${QUIESCENCE_JOURNAL}" "${BACKUP_SYSTEMCTL_BIN}" \
    "${BACKUP_DOCKER_BIN}" "${RUN_ID}" "${PORTAL_DIR}/backend/package.json" \
    "${SYSTEMD_DIR}" "${BACKUP_FENCE_NAME}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time

journal_path, systemctl, docker, run_id, version_path, systemd_root, fence_name, *unit_names = sys.argv[1:]
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

def run(executable, arguments):
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
        raise RuntimeError(f"backup quiescence command failed: {executable}")
    return result.stdout

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
    content = (
        "[Unit]\n"
        f"ConditionPathExists=!{journal_path}\n"
    ).encode("utf-8")
    by_name = {entry["name"]: entry for entry in units}
    for name in unit_names:
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

def inspect_container(identifier):
    payload = json.loads(run(docker, ["container", "inspect", identifier]))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("ambiguous Docker inspection")
    container = payload[0]
    if container.get("Id") != identifier:
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
    runtime_fingerprint = labels.get("com.bridgesllm.project-egress.runtime-fingerprint")
    openclaw_identity = labels.get("com.bridgesllm.openclaw-project.identity")
    if runtime_fingerprint is not None:
        if not isinstance(runtime_fingerprint, str) or not re.fullmatch(
            r"[a-f0-9]{64}", runtime_fingerprint
        ):
            raise RuntimeError("Project runtime fingerprint is invalid")
        claims["com.bridgesllm.project-egress.runtime-fingerprint"] = runtime_fingerprint
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
    _, record = inspect_container(identifier)
    is_stalwart = record["name"] == "stalwart-mail"
    if is_stalwart:
        if stalwart_seen:
            raise RuntimeError("ambiguous Stalwart container identity")
        stalwart_seen = True
    if is_stalwart or record["claims"]:
        containers.append(record)
        if len(containers) > 4096:
            raise RuntimeError("managed Docker recovery inventory is unbounded")

parent = os.path.dirname(journal_path)
parent_info = os.lstat(parent)
if (
    not os.path.isabs(journal_path)
    or os.path.normpath(journal_path) != journal_path
    or not stat.S_ISDIR(parent_info.st_mode)
    or stat.S_ISLNK(parent_info.st_mode)
    or parent_info.st_uid != 0
    or parent_info.st_gid != 0
    or parent_info.st_mode & 0o022
    or os.path.lexists(journal_path)
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
    target = os.path.join(directory, fence_name)
    if os.path.lexists(target):
        raise RuntimeError("reserved backup boot-fence path is already occupied")
    unit["fenceDirectoryExisted"] = existed
journal = {
    "schemaVersion": 2,
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

ensure_fences(allow_existing=False)
for unit in units:
    current = unit_state(unit["name"])
    if current["activeState"] == "active":
        run(systemctl, ["stop", unit["name"]])
    stopped = unit_state(unit["name"])
    if stopped["loadState"] != unit["loadState"] or stopped["activeState"] != "inactive":
        raise RuntimeError("systemd unit did not quiesce")
for record in containers:
    if record["restartPolicy"]["name"] != "no":
        run(docker, ["container", "update", "--restart=no", record["id"]])
    if record["wasRunning"]:
        run(docker, ["container", "stop", "--time", "30", record["id"]])
    _, current = inspect_container(record["id"])
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
  log "Comprehensive backup sources quiesced under the Portal operation lock"
}

restore_backup_runtime_state() {
  local recovery_mode="$1"
  [[ "${recovery_mode}" == "quiesce-only" \
    || "${recovery_mode}" == "restore-recorded" ]] || return 1
  [[ -f "${QUIESCENCE_JOURNAL}" && ! -L "${QUIESCENCE_JOURNAL}" ]] || return 1
  python3 - "${QUIESCENCE_JOURNAL}" "${BACKUP_SYSTEMCTL_BIN}" \
    "${BACKUP_DOCKER_BIN}" "${BACKUP_CURL_BIN}" "${SYSTEMD_DIR}" \
    "${BACKUP_FENCE_NAME}" "${recovery_mode}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

journal_path, systemctl, docker, curl, systemd_root, fence_name, recovery_mode, *unit_names = sys.argv[1:]
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
with open(journal_path, "r", encoding="utf-8") as handle:
    journal = json.load(handle)
if (
    not isinstance(journal, dict)
    or set(journal) != {
        "schemaVersion", "runId", "portalVersion", "units", "containers"
    }
    or journal.get("schemaVersion") != 2
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

def run(executable, arguments):
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
        raise RuntimeError(f"backup recovery command failed: {executable}")
    return result.stdout

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
    content = (
        "[Unit]\n"
        f"ConditionPathExists=!{journal_path}\n"
    ).encode("utf-8")
    by_name = {entry["name"]: entry for entry in journal["units"]}
    for name in unit_names:
        record = by_name[name]
        directory = os.path.join(systemd_root, f"{name}.d")
        if not os.path.lexists(directory):
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
            if (
                not stat.S_ISREG(target_info.st_mode)
                or stat.S_ISLNK(target_info.st_mode)
                or target_info.st_uid != 0
                or target_info.st_gid != 0
                or target_info.st_nlink != 1
                or target_info.st_mode & 0o022
                or open(target, "rb").read() != content
            ):
                raise RuntimeError("backup recovery fence is contradictory")
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
    by_name = {entry["name"]: entry for entry in journal["units"]}
    content = (
        "[Unit]\n"
        f"ConditionPathExists=!{journal_path}\n"
    ).encode("utf-8")
    for name in unit_names:
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

def inspect_record(record):
    if (
        not isinstance(record, dict)
        or set(record) != {
            "id", "name", "claims", "wasRunning", "restartPolicy"
        }
        or not isinstance(record.get("id"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", record["id"])
        or not isinstance(record.get("name"), str)
        or not record["name"]
        or not isinstance(record.get("claims"), dict)
        or not isinstance(record.get("wasRunning"), bool)
        or not isinstance(record.get("restartPolicy"), dict)
    ):
        raise RuntimeError("invalid Docker recovery record")
    payload = json.loads(run(docker, ["container", "inspect", record["id"]]))
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
        container.get("Id") != record["id"]
        or str(container.get("Name") or "").lstrip("/") != record["name"]
        or current_claims != record["claims"]
        or not isinstance(running, bool)
    ):
        raise RuntimeError("Docker recovery identity changed")
    return running, current_policy

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

# Recovery itself is quiescent: stop any recorded unit that is currently
# active before touching recorded containers.
ensure_fences()
for unit in journal["units"]:
    _, active = unit_state(unit["name"])
    if active == "active":
        run(systemctl, ["stop", unit["name"]])
        _, active = unit_state(unit["name"])
        if active != "inactive":
            raise RuntimeError("systemd unit did not quiesce for recovery")

seen = set()
for record in journal["containers"]:
    if record.get("id") in seen:
        raise RuntimeError("duplicate Docker recovery identity")
    seen.add(record.get("id"))
    running, policy = inspect_record(record)
    if policy != {"name": "no", "maximumRetryCount": 0}:
        run(docker, ["container", "update", "--restart=no", record["id"]])
    if running:
        run(docker, ["container", "stop", "--time", "30", record["id"]])
    running, policy = inspect_record(record)
    if running or policy != {"name": "no", "maximumRetryCount": 0}:
        raise RuntimeError("Docker runtime did not quiesce for recovery")

if recovery_mode == "quiesce-only":
    raise SystemExit(0)

for record in journal["containers"]:
    running, policy = inspect_record(record)
    if running or policy != {"name": "no", "maximumRetryCount": 0}:
        raise RuntimeError("Docker runtime changed before restoration")
    if record["wasRunning"]:
        run(docker, ["container", "start", record["id"]])
    if record["restartPolicy"] != {"name": "no", "maximumRetryCount": 0}:
        run(
            docker,
            [
                "container", "update",
                f"--restart={restart_argument(record['restartPolicy'])}",
                record["id"],
            ],
        )
    running, policy = inspect_record(record)
    if running != record["wasRunning"] or policy != record["restartPolicy"]:
        raise RuntimeError("Docker runtime state was not restored")

remove_fences()
for unit in journal["units"]:
    load, active = unit_state(unit["name"])
    if unit["activeState"] == "active":
        if active != "active":
            run(systemctl, ["start", unit["name"]])
        load, active = unit_state(unit["name"])
    if (load, active) != (unit["loadState"], unit["activeState"]):
        raise RuntimeError("systemd unit state was not restored exactly")

# Starting Portal/OpenClaw can itself reconcile Docker runtimes. Re-attest the
# immutable identities, policies, and running intent after every unit has
# returned to its recorded state and before deleting the sole recovery record.
for record in journal["containers"]:
    running, policy = inspect_record(record)
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
for record in journal["containers"]:
    running, policy = inspect_record(record)
    if running != record["wasRunning"] or policy != record["restartPolicy"]:
        raise RuntimeError("Docker runtime drifted during Portal readiness")

os.unlink(journal_path)
parent = os.path.dirname(journal_path)
descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  local status="$?"
  if (( status == 0 )) && [[ "${recovery_mode}" == "restore-recorded" ]]; then
    BACKUP_QUIESCE_ACTIVE=false
  fi
  return "${status}"
}

restore_backup_quiescence() {
  local journal_exists=false
  if [[ -e "${QUIESCENCE_JOURNAL}" || -L "${QUIESCENCE_JOURNAL}" ]]; then
    journal_exists=true
  fi
  if [[ "${journal_exists}" == "false" ]]; then
    assert_no_orphan_backup_database_transactions || return 1
    BACKUP_QUIESCE_ACTIVE=false
    return 0
  fi
  restore_backup_runtime_state quiesce-only || return 1
  recover_backup_database_exclusion || return 1
  restore_backup_runtime_state restore-recorded
}

assert_backup_sources_quiescent() {
  [[ "${RUN_TYPE}" == "comprehensive" ]] || return 0
  python3 - "${QUIESCENCE_JOURNAL}" "${BACKUP_SYSTEMCTL_BIN}" \
    "${BACKUP_DOCKER_BIN}" "${SYSTEMD_DIR}" "${BACKUP_FENCE_NAME}" \
    "${BACKUP_MUTATOR_UNITS[@]}" <<'PY'
import json
import os
import re
import stat
import subprocess
import sys

journal_path, systemctl, docker, systemd_root, fence_name, *unit_names = sys.argv[1:]
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
    journal.get("schemaVersion") != 2
    or not isinstance(journal.get("units"), list)
    or not isinstance(journal.get("containers"), list)
    or {entry.get("name") for entry in journal["units"] if isinstance(entry, dict)}
        != set(unit_names)
):
    raise SystemExit("backup quiescence journal changed before publication")

def run(executable, arguments):
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
        raise RuntimeError("backup publication quiescence query failed")
    return result.stdout.strip()

content = (
    "[Unit]\n"
    f"ConditionPathExists=!{journal_path}\n"
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
        not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or identifier in seen
        or not isinstance(record.get("claims"), dict)
    ):
        raise RuntimeError("backup Docker publication record is invalid")
    seen.add(identifier)
    payload = json.loads(run(docker, ["container", "inspect", identifier]))
    if not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError("backup Docker publication identity is ambiguous")
    container = payload[0]
    labels = ((container.get("Config") or {}).get("Labels") or {})
    policy = ((container.get("HostConfig") or {}).get("RestartPolicy") or {})
    if (
        container.get("Id") != identifier
        or str(container.get("Name") or "").lstrip("/") != record.get("name")
        or {key: labels.get(key) for key in record["claims"]} != record["claims"]
        or bool((container.get("State") or {}).get("Running"))
        or policy.get("Name") != "no"
        or policy.get("MaximumRetryCount") != 0
    ):
        raise RuntimeError("backup Docker source restarted during capture")
PY
}

finish_run() {
  local exit_code="$?"
  local failed_phase="${RUN_PHASE}"
  local failed_phase_label="${RUN_PHASE_LABEL}"
  local failed_phase_index="${RUN_PHASE_INDEX}"
  local recovery_attempted=false
  trap - EXIT HUP INT TERM ERR
  if (( exit_code != 0 )) && [[ -z "${RUN_ERROR_DETAIL}" ]]; then
    RUN_ERROR_DETAIL="Backup process exited unexpectedly with code ${exit_code} during ${RUN_PHASE_LABEL:-backup processing}"
  fi
  if $RUN_ACTIVE && [[ "${RUN_TYPE}" == "comprehensive" ]] \
    && { $BACKUP_QUIESCE_ACTIVE \
      || [[ -e "${QUIESCENCE_JOURNAL}" || -L "${QUIESCENCE_JOURNAL}" ]]; }; then
    recovery_attempted=true
    RUN_PHASE="restoring-services"
    RUN_PHASE_LABEL="Restoring services"
    RUN_PHASE_INDEX="${RUN_PHASE_TOTAL}"
    write_status running "" "" ""
  fi
  if ! restore_backup_quiescence; then
    log "ERROR: one or more services or managed Project containers did not return to their pre-backup running state"
    if [[ -n "${RUN_ERROR_DETAIL}" ]]; then
      RUN_ERROR_DETAIL="${RUN_ERROR_DETAIL}; service recovery also failed"
    else
      RUN_ERROR_DETAIL="One or more services, managed Project containers, or the database fence did not return to their pre-backup state"
    fi
    exit_code=1
  elif $recovery_attempted && (( exit_code != 0 )); then
    RUN_PHASE="${failed_phase}"
    RUN_PHASE_LABEL="${failed_phase_label}"
    RUN_PHASE_INDEX="${failed_phase_index}"
  fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf -- "$STAGING_DIR"
  fi
  if [[ -n "$PARTIAL_ARCHIVE" && -f "$PARTIAL_ARCHIVE" ]]; then
    rm -f -- "$PARTIAL_ARCHIVE"
  fi
  if $RUN_ACTIVE; then
    if (( exit_code == 0 )); then
      RUN_PHASE="completed"
      RUN_PHASE_LABEL="Backup completed"
      RUN_PHASE_INDEX="${RUN_PHASE_TOTAL}"
      write_status completed "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "0" ""
    else
      write_status failed "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$exit_code" \
        "${RUN_ERROR_DETAIL:-Backup process exited with code ${exit_code}}"
    fi
  fi
  if ! release_backup_lock_guard; then
    exit_code=1
    if $RUN_ACTIVE; then
      RUN_ERROR_DETAIL="Backup lock guard did not release cleanly"
      write_status failed "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$exit_code" \
        "${RUN_ERROR_DETAIL}"
    fi
  fi
  exit "$exit_code"
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
    && "${BACKUP_LOCK_GUARD_STARTTIME}" =~ ^[0-9]+$ ]] || return 1
  python3 - "${BACKUP_LOCK_GUARD_PID}" "${BACKUP_LOCK_GUARD_STARTTIME}" \
    "${BASHPID}" "${PORTAL_OPERATION_LOCK_FILE}" "${LOCK_FILE}" <<'PY'
import os
import pathlib
import re
import stat
import sys

pid = int(sys.argv[1])
expected_starttime = sys.argv[2]
expected_parent = int(sys.argv[3])
lock_paths = sys.argv[4:]
if (
    pid <= 1
    or expected_parent <= 1
    or not re.fullmatch(r"[0-9]+", expected_starttime)
    or len(lock_paths) != 2
):
    raise SystemExit(1)
try:
    raw = pathlib.Path(f"/proc/{pid}/stat").read_text(
        encoding="ascii"
    ).strip()
    status = pathlib.Path(f"/proc/{pid}/status").read_text(
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
if (
    len(fields) < 20
    or fields[19] != expected_starttime
    or len(parents) != 1
    or parents[0] != str(expected_parent)
):
    raise SystemExit(1)
for descriptor, path in zip((8, 9), lock_paths):
    try:
        opened = os.stat(f"/proc/{pid}/fd/{descriptor}")
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
  local pid="$1"
  local expected_starttime="$2"
  local expected_parent="$3"
  [[ "${pid}" =~ ^[1-9][0-9]*$ \
    && "${expected_starttime}" =~ ^[0-9]+$ \
    && "${expected_parent}" =~ ^[1-9][0-9]*$ ]] || return 1
  # Open a pidfd before re-reading /proc so a PID that exits and is reused
  # between validation and signalling can never redirect SIGKILL to the new
  # process.  Start time and parent binding also make stale guard state fail
  # closed without signalling anything.
  python3 - "${pid}" "${expected_starttime}" "${expected_parent}" <<'PY'
import os
import pathlib
import re
import signal
import sys

pid = int(sys.argv[1])
expected_starttime = sys.argv[2]
expected_parent = int(sys.argv[3])
if (
    pid <= 1
    or expected_parent <= 1
    or not re.fullmatch(r"[0-9]+", expected_starttime)
):
    raise SystemExit(1)
try:
    descriptor = os.pidfd_open(pid, 0)
except (AttributeError, OSError):
    raise SystemExit(1)
try:
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
    if (
        len(fields) < 20
        or fields[1] != str(expected_parent)
        or fields[19] != expected_starttime
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
  if wait "${pid}" 2>/dev/null; then
    status=0
  else
    status="$?"
  fi
  [[ "${status}" -eq 0 || "${status}" -eq 137 ]]
}

handoff_backup_locks_to_guard() {
  [[ -z "${BACKUP_LOCK_GUARD_PID}" \
    && -z "${BACKUP_LOCK_GUARD_STARTTIME}" ]] || return 1
  local owner_pid="${BASHPID}"
  local ready="" coproc_pid="" read_fd="" write_fd="" starttime=""
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
if expected_parent <= 1:
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
os.write(1, b"READY\n")
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
  if [[ "${coproc_pid}" =~ ^[1-9][0-9]*$ ]]; then
    starttime="$(backup_process_starttime "${coproc_pid}")" || starttime=""
  fi
  read_fd="${BACKUP_LOCK_HOLDER[0]:-}"
  write_fd="${BACKUP_LOCK_HOLDER[1]:-}"
  if [[ ! "${coproc_pid}" =~ ^[1-9][0-9]*$ \
    || ! "${read_fd}" =~ ^[0-9]+$ \
    || ! "${write_fd}" =~ ^[0-9]+$ \
    || ! "${starttime}" =~ ^[0-9]+$ ]]; then
    terminate_backup_lock_guard_process \
      "${coproc_pid}" "${starttime}" "${owner_pid}" || true
    return 1
  fi
  exec {write_fd}>&-
  if ! IFS= read -r -t 10 ready <&"${read_fd}"; then
    exec {read_fd}<&-
    terminate_backup_lock_guard_process \
      "${coproc_pid}" "${starttime}" "${owner_pid}" || true
    return 1
  fi
  exec {read_fd}<&-
  if [[ "${ready}" != "READY" ]]; then
    terminate_backup_lock_guard_process \
      "${coproc_pid}" "${starttime}" "${owner_pid}" || true
    return 1
  fi
  BACKUP_LOCK_GUARD_PID="${coproc_pid}"
  BACKUP_LOCK_GUARD_STARTTIME="${starttime}"
  assert_backup_lock_guard || {
    terminate_backup_lock_guard_process \
      "${coproc_pid}" "${starttime}" "${owner_pid}" || true
    BACKUP_LOCK_GUARD_PID=""
    BACKUP_LOCK_GUARD_STARTTIME=""
    return 1
  }
  exec 8>&-
  exec 9>&-
  assert_backup_lock_guard
}

release_backup_lock_guard() {
  if [[ -z "${BACKUP_LOCK_GUARD_PID}" \
    && -z "${BACKUP_LOCK_GUARD_STARTTIME}" ]]; then
    return 0
  fi
  local pid="${BACKUP_LOCK_GUARD_PID}"
  local starttime="${BACKUP_LOCK_GUARD_STARTTIME}"
  local owner_pid="${BASHPID}"
  local status=0
  if ! assert_backup_lock_guard; then
    status=1
  fi
  terminate_backup_lock_guard_process \
    "${pid}" "${starttime}" "${owner_pid}" || status=1
  BACKUP_LOCK_GUARD_PID=""
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
  actual_operation_lock="$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' /proc/$$/fd/8 2>/dev/null)" \
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
  BACKUP_BASE="$(validate_backup_base)" || die "Backup path validation failed"
  acquire_backup_locks
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before backup recovery"
  assert_backup_crash_persistent_control_filesystems \
    || die "Backup recovery journal and boot-fence filesystems must be writable and crash-persistent"
  restore_backup_quiescence \
    || die "A prior interrupted backup could not restore its quiesced runtime state"
  assert_no_foreign_backup_transactions
  sweep_stale_backup_artifacts \
    || die "Stale backup staging or partial archives could not be removed safely"
  prepare_backup_archive_trust \
    || die "Backup authentication trust key or control directory is unsafe"

  RUN_ID="${BACKUP_JOB_ID:-$(date -u '+%Y%m%dT%H%M%S')-$$}"
  [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "Invalid backup job id"
  RUN_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [[ "${RUN_TYPE}" == "comprehensive" ]]; then
    RUN_PHASE_TOTAL=12
  else
    RUN_PHASE_TOTAL=8
  fi
  RUN_PHASE="preparing"
  RUN_PHASE_LABEL="Preparing backup"
  RUN_PHASE_INDEX=1
  : > "$OUTPUT_FILE"
  chmod 600 "$OUTPUT_FILE"
  RUN_ACTIVE=true
  write_status running "" "" ""
  trap finish_run EXIT
  trap 'capture_backup_error "$?" "$LINENO"' ERR
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
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
  [[ "${RUN_TYPE}" == "comprehensive" ]] || return 0
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
  [[ "${RUN_TYPE}" == "comprehensive" ]] || return 0
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
  [[ "${RUN_TYPE}" == "comprehensive" ]] || return 0
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
import sys
from urllib.parse import unquote, urlsplit, urlunsplit

raw = sys.stdin.read()
if not raw or any(ord(char) < 32 or ord(char) == 127 for char in raw):
    raise SystemExit(1)
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
if (parsed.scheme not in {"postgres", "postgresql"} or parsed.fragment
        or not all((separator, username_raw, host, user, database))
        or not 1 <= port <= 65535 or "," in decoded_host_part
        or any(ord(char) < 32 or ord(char) == 127
               for value in (host, user, database) for char in value)):
    raise SystemExit(1)
prisma_only = {
    "schema",
    "connection_limit",
    "pool_timeout",
    "pgbouncer",
    "statement_cache_size",
    "socket_timeout",
}
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
if parsed.query:
    for raw_pair in parsed.query.split("&"):
        raw_key = raw_pair.partition("=")[0]
        try:
            key = unquote(raw_key, errors="strict").lower()
        except UnicodeDecodeError:
            raise SystemExit(1)
        if not key or any(ord(char) < 32 or ord(char) == 127 for char in key):
            raise SystemExit(1)
        if key in identity_or_secret:
            raise SystemExit(1)
        if key not in prisma_only:
            query.append(raw_pair)

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
    part = os.read(3, min(65536, 131073 - raw_size))
    if not part:
        break
    raw_parts.append(part)
    raw_size += len(part)
    if raw_size > 131072:
        raise SystemExit(1)
os.close(3)
raw_bytes = b"".join(raw_parts)
try:
    raw = raw_bytes.decode("utf-8")
except UnicodeDecodeError:
    raise SystemExit(1)
if not raw or any(ord(char) < 32 or ord(char) == 127 for char in raw):
    raise SystemExit(1)
try:
    parsed = urlsplit(raw)
    _, separator, host_part = parsed.netloc.rpartition("@")
    host = unquote(parsed.hostname or "", errors="strict")
    port_number = parsed.port or 5432
    database = unquote((parsed.path or "").lstrip("/"), errors="strict")
    user = unquote(parsed.username or "", errors="strict")
    password = unquote(parsed.password or "", errors="strict")
    decoded_host_part = unquote(host_part, errors="strict")
except (UnicodeDecodeError, ValueError):
    raise SystemExit(1)
identity_or_secret = {
    "password", "sslpassword", "passfile", "service", "servicefile",
    "host", "hostaddr", "port", "user", "dbname", "database",
}
for raw_pair in parsed.query.split("&") if parsed.query else ():
    try:
        key = unquote(raw_pair.partition("=")[0], errors="strict").lower()
    except UnicodeDecodeError:
        raise SystemExit(1)
    if (not key or key in identity_or_secret
            or any(ord(char) < 32 or ord(char) == 127 for char in key)):
        raise SystemExit(1)
if (parsed.scheme not in {"postgres", "postgresql"} or parsed.fragment
        or not separator or not 1 <= port_number <= 65535
        or "," in decoded_host_part):
    raise SystemExit(1)
port = str(port_number)
values = (host, port, database, user, password)
if not all(values[:4]) or any(ord(char) < 32 or ord(char) == 127 for value in values for char in value):
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

dump_database_consistent() {
  local target="$1"
  local identity_target="$2"
  local database_url="" libpq_url="" runner_source=""
  local work_dir="" fifo="" output="" client_pid="" input_fd=""
  local marker="" snapshot="" logical_bytes="" relation_count=""
  local contract="" violations="" contract_variant="" contract_extra=""
  local tablespace_violations="" identity_before="" identity_after=""
  local identity_marker=""
  local expected_parent="${BASHPID}"
  local status=0
  local guarded=false
  local authority
  authority="$(backup_database_authority_environment)" || return 1
  database_url="$(read_env_value "${authority}" DATABASE_URL)" || return 1
  libpq_url="$(libpq_database_url "${database_url}")" || return 1
  runner_source="$(backup_pg_dump_runner_python)" || return 1
  [[ -x "${BACKUP_PSQL_BIN}" && "${BACKUP_PSQL_BIN}" == /* ]] || return 1
  if [[ "${RUN_TYPE}" == "comprehensive" ]]; then
    assert_backup_database_exclusion || return 1
    guarded=true
  fi
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
    if [[ "${guarded}" == "true" ]]; then
      run_backup_guard_peer_pg_dump "${snapshot}" \
        > "${target}" 2>"${target}.err" || status=$?
    else
      run_backup_pg_dump "${database_url}" "${libpq_url}" "${snapshot}" \
        > "${target}" 2>"${target}.err" || status=$?
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
  rm -f -- "${target}.err" "${fifo}" "${output}" "${work_dir}/error"
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
  shift 3
  python3 - "$source_dir" "$list_file" "$digest_file" "$@" <<'PY'
import fcntl
import fnmatch
import hashlib
import os
import pathlib
import stat
import struct
import sys

source = pathlib.Path(sys.argv[1])
list_path = pathlib.Path(sys.argv[2])
digest_path = pathlib.Path(sys.argv[3])
raw_options = sys.argv[4:]
patterns = []
allow_external_hardlinks = False
overlay_root_raw = None
overlay_relatives = []
for option in raw_options:
    if option == "--allow-external-hardlinks":
        allow_external_hardlinks = True
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
    if (
        not option.startswith("--exclude=")
        or len(option) <= len("--exclude=")
        or "\0" in option
        or "\n" in option
    ):
        raise SystemExit("unsupported recovery archive selection option")
    patterns.append(option.removeprefix("--exclude="))

if (overlay_root_raw is None) != (not overlay_relatives):
    raise SystemExit("recovery archive overlay is incomplete")

if (
    not source.is_absolute()
    or os.path.normpath(source) != str(source)
    or os.path.realpath(source) != str(source)
):
    raise SystemExit("recovery source is not a canonical directory")
root_info = os.lstat(source)
if (
    not stat.S_ISDIR(root_info.st_mode)
    or stat.S_ISLNK(root_info.st_mode)
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

def excluded(relative):
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

overlay_root = None
overlay_paths = []
overlay_root_info = None
if overlay_root_raw is not None:
    overlay_root = pathlib.Path(overlay_root_raw)
    if (
        not overlay_root.is_absolute()
        or os.path.normpath(overlay_root) != str(overlay_root)
        or os.path.realpath(overlay_root) != str(overlay_root)
        or overlay_root.name != source.name
        or len(overlay_relatives) != len(set(overlay_relatives))
        or len(overlay_relatives) > 4096
    ):
        raise SystemExit("recovery archive overlay authority is invalid")
    overlay_root_info = os.lstat(overlay_root)
    if (
        not stat.S_ISDIR(overlay_root_info.st_mode)
        or stat.S_ISLNK(overlay_root_info.st_mode)
        or overlay_root_info.st_uid != 0
        or overlay_root_info.st_gid != 0
        or overlay_root_info.st_mode & 0o022
    ):
        raise SystemExit("recovery archive overlay root is not trusted")
    for overlay_relative in overlay_relatives:
        relative_path = pathlib.PurePosixPath(overlay_relative)
        relative_parts = relative_path.parts
        if (
            not relative_parts
            or relative_path.is_absolute()
            or str(relative_path) != overlay_relative
            or any(part in {"", ".", ".."} for part in relative_parts)
            or "\\" in overlay_relative
            or valid_text(overlay_relative, 4096) is None
            or not excluded(overlay_relative)
        ):
            raise SystemExit("recovery archive overlay authority is invalid")
        current = overlay_root
        for part in relative_parts[:-1]:
            current = current / part
            info = os.lstat(current)
            if (
                not stat.S_ISDIR(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_dev != overlay_root_info.st_dev
                or info.st_uid != 0
                or info.st_gid != 0
                or info.st_mode & 0o022
            ):
                raise SystemExit("recovery archive overlay path is not trusted")
        overlay_paths.append((current / relative_parts[-1], overlay_relative))

FS_IOC_GETFLAGS = (
    (2 << 30)
    | (struct.calcsize("@L") << 16)
    | (ord("f") << 8)
    | 1
)
FS_IMMUTABLE_FL = 0x00000010
FS_APPEND_FL = 0x00000020

def assert_archiveable_inode_flags(path, info):
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    if stat.S_ISDIR(info.st_mode):
        flags |= getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise SystemExit("recovery source inode flags could not be inspected")
    try:
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != info.st_dev
            or opened.st_ino != info.st_ino
            or stat.S_IFMT(opened.st_mode) != stat.S_IFMT(info.st_mode)
        ):
            raise SystemExit("recovery source changed during inode flag inspection")
        encoded = bytearray(struct.calcsize("@L"))
        try:
            fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, encoded, True)
        except OSError:
            raise SystemExit("recovery source inode flags could not be inspected")
        inode_flags = struct.unpack("@L", encoded)[0]
    finally:
        os.close(descriptor)
    if inode_flags & (FS_IMMUTABLE_FL | FS_APPEND_FL):
        raise SystemExit(
            "recovery source contains an immutable or append-only inode"
        )

def sparse_map(path, info):
    if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
        return ()
    if not hasattr(os, "SEEK_DATA") or not hasattr(os, "SEEK_HOLE"):
        return (("unknown", info.st_blocks),)
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    extents = []
    try:
        offset = 0
        while offset < info.st_size:
            try:
                data = os.lseek(descriptor, offset, os.SEEK_DATA)
            except OSError as error:
                if error.errno == 6:  # ENXIO: no more data.
                    break
                if error.errno in {22, 95}:  # EINVAL/EOPNOTSUPP.
                    return (("unknown", info.st_blocks),)
                raise
            hole = os.lseek(descriptor, data, os.SEEK_HOLE)
            if hole < data or hole > info.st_size:
                raise SystemExit("recovery source sparse map is invalid")
            extents.append((data, hole - data))
            offset = hole
    finally:
        os.close(descriptor)
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

def inspect_entry(path, relative, *, apply_exclusions=True, expected_device=None):
    if apply_exclusions and excluded(relative):
        return
    relative_bytes = valid_text(relative or source.name, 4096)
    if relative_bytes is None or any(
        valid_text(part, 256) is None
        for part in (relative.split("/") if relative else [source.name])
    ):
        raise SystemExit("recovery source contains an unsafe path")
    info = os.lstat(path)
    if info.st_dev != (root_info.st_dev if expected_device is None else expected_device):
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
        assert_archiveable_inode_flags(path, info)

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
        target = os.readlink(path)
        target_bytes = valid_text(target, 4096)
        if target_bytes is None:
            raise SystemExit("recovery source contains an unsafe symbolic link")
        add_field(target_bytes)
    else:
        target_bytes = b""
        add_field(b"")

    try:
        names = os.listxattr(path, follow_symlinks=False)
    except OSError:
        raise SystemExit("recovery source xattrs could not be inspected")
    encoded_names = sorted(
        name if isinstance(name, bytes)
        else name.encode("utf-8", "surrogateescape")
        for name in names
    )
    if len(encoded_names) > 1024 or len(encoded_names) != len(set(encoded_names)):
        raise SystemExit("recovery source xattr inventory is invalid")
    xattr_bytes = 0
    xattrs = []
    for name in encoded_names:
        if not name or len(name) > 255 or b"\0" in name or b"." not in name:
            raise SystemExit("recovery source xattr name is unsafe")
        value = os.getxattr(path, name, follow_symlinks=False)
        xattr_bytes += len(name) + len(value)
        if len(value) > 1024 * 1024 or xattr_bytes > 16 * 1024 * 1024:
            raise SystemExit("recovery source xattr inventory is unbounded")
        add_field(name)
        add_field(value)
        xattrs.append((name, value))
    add_field("xattr-end")

    extents = sparse_map(path, info)
    for extent in extents:
        add_field(extent[0])
        add_field(extent[1])
    add_field("sparse-end")
    records.append({
        "name": archive_name,
        "kind": kind,
        "identity": (info.st_dev, info.st_ino),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mode": stat.S_IMODE(info.st_mode),
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "link": target_bytes,
        "xattrs": tuple(xattrs),
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
    if kind == "directory":
        try:
            children = sorted(
                os.scandir(path),
                key=lambda entry: os.fsencode(entry.name),
            )
        except OSError:
            raise SystemExit("recovery source directory could not be enumerated")
        for child in children:
            child_relative = child.name if not relative else relative + "/" + child.name
            inspect_entry(
                path / child.name,
                child_relative,
                apply_exclusions=apply_exclusions,
                expected_device=expected_device,
            )

inspect_entry(source, "")
for overlay_path, overlay_relative in overlay_paths:
    overlay_info = os.lstat(overlay_path)
    if (
        not stat.S_ISREG(overlay_info.st_mode)
        or stat.S_ISLNK(overlay_info.st_mode)
        or overlay_info.st_nlink != 1
        or overlay_info.st_uid != 0
        or overlay_info.st_gid != 0
        or overlay_info.st_mode & 0o022
    ):
        raise SystemExit("recovery archive overlay file is not trusted")
    inspect_entry(
        overlay_path,
        overlay_relative,
        apply_exclusions=False,
        expected_device=overlay_root_info.st_dev,
    )
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

canonical_files = {}
for record in records:
    kind = record["kind"]
    link = record["link"]
    xattrs = record["xattrs"]
    size = record["size"] if kind == "file" else 0
    sparse = record["sparse"]
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

with open(list_path, "xb", buffering=0) as handle:
    for name in members:
        handle.write(name.encode("utf-8") + b"\0")
    os.fsync(handle.fileno())
with open(digest_path, "x", encoding="ascii") as handle:
    handle.write(digest.hexdigest() + "\n")
    handle.write(contract_digest.hexdigest() + "\n")
    handle.flush()
    os.fsync(handle.fileno())
PY
}

assert_archive_matches_source_inventory() {
  local archive="$1"
  local list_file="$2"
  local digest_file="$3"
  python3 - "$archive" "$list_file" "$digest_file" <<'PY'
import decimal
import hashlib
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
    or len(members) <= len(expected)
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
    payload = b"\0".join(members[:-len(expected)]) + b"\0"
    if os.write(descriptor, payload) != len(payload):
        raise SystemExit(1)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

archive_dir() {
  local source_dir="$1"
  local target="$2"
  local diagnostics="${target}.tar-errors"
  local before_list="${target}.source-before"
  local before_digest="${target}.source-before.sha256"
  local after_list="${target}.source-after"
  local after_digest="${target}.source-after.sha256"
  local source_only_list="${target}.source-only"
  shift 2
  # `--check-links` makes tar fail when it cannot archive every link of an
  # inode. For a component that deliberately shares inodes with another
  # backed-up tree, that is the normal state, not a fault. The options here
  # are consumed by the source inventory only; tar itself is driven from the
  # generated file list, so this flag never reaches it.
  local -a hardlink_options=(--check-links)
  local option overlay_root=""
  local -a overlay_relatives=() overlay_members=()
  for option in "$@"; do
    case "${option}" in
      --allow-external-hardlinks) hardlink_options=() ;;
      --overlay-root=*) overlay_root="${option#--overlay-root=}" ;;
      --overlay-relative=*) overlay_relatives+=("${option#--overlay-relative=}") ;;
    esac
  done
  [[ -z "${overlay_root}" && "${#overlay_relatives[@]}" -eq 0 \
    || ( -n "${overlay_root}" && "${#overlay_relatives[@]}" -gt 0 ) ]] || return 1
  for option in "${overlay_relatives[@]}"; do
    overlay_members+=("$(basename "$source_dir")/${option}")
  done
  [[ "$source_dir" == /* && -d "$source_dir" && ! -L "$source_dir" ]] || return 1
  [[ ! -e "$target" && ! -L "$target" \
    && ! -e "$diagnostics" && ! -L "$diagnostics" \
    && ! -e "$before_list" && ! -L "$before_list" \
    && ! -e "$before_digest" && ! -L "$before_digest" \
    && ! -e "$after_list" && ! -L "$after_list" \
    && ! -e "$after_digest" && ! -L "$after_digest" \
    && ! -e "$source_only_list" && ! -L "$source_only_list" ]] || return 1
  if ! materialize_archive_source_inventory \
      "$source_dir" "$before_list" "$before_digest" "$@"; then
    rm -f -- "$before_list" "$before_digest"
    return 1
  fi
  local archive_list="$before_list"
  if [[ -n "${overlay_root}" ]]; then
    if ! materialize_archive_list_without_overlay \
        "$before_list" "$source_only_list" "${overlay_members[@]}"; then
      rm -f -- "$before_list" "$before_digest" "$source_only_list"
      return 1
    fi
    archive_list="$source_only_list"
  fi
  local tar_status=0
  if [[ -n "${overlay_root}" ]]; then
    tar --format=pax --sparse --one-file-system "${hardlink_options[@]}" \
        --acls --xattrs --xattrs-include='*' --selinux \
        --pax-option=delete=atime,delete=ctime \
        --atime-preserve=system --no-recursion --null --verbatim-files-from \
        -czf "$target" -C "$(dirname "$source_dir")" -T "$archive_list" \
        -C "$(dirname "$overlay_root")" "${overlay_members[@]}" \
        2>"${diagnostics}" || tar_status=$?
  else
    tar --format=pax --sparse --one-file-system "${hardlink_options[@]}" \
        --acls --xattrs --xattrs-include='*' --selinux \
        --pax-option=delete=atime,delete=ctime \
        --atime-preserve=system --no-recursion --null --verbatim-files-from \
        -czf "$target" -C "$(dirname "$source_dir")" -T "$archive_list" \
        2>"${diagnostics}" || tar_status=$?
  fi
  if (( tar_status != 0 )); then
    rm -f -- "$target" "$diagnostics" "$before_list" "$before_digest" \
      "$source_only_list"
    return 1
  fi
  if [[ -s "$diagnostics" ]]; then
    rm -f -- "$target" "$diagnostics" "$before_list" "$before_digest" \
      "$source_only_list"
    return 1
  fi
  rm -f -- "$diagnostics"
  if ! tar --compare --numeric-owner --acls --xattrs \
      --xattrs-include='*' --selinux \
      --atime-preserve=system --no-recursion --null --verbatim-files-from \
      -zf "$target" -C "$(dirname "$source_dir")" -T "$archive_list" \
      >"$diagnostics" 2>&1; then
    rm -f -- "$target" "$diagnostics" "$before_list" "$before_digest" \
      "$source_only_list"
    return 1
  fi
  if [[ -n "${overlay_root}" ]] \
    && ! tar --compare --numeric-owner --acls --xattrs \
      --xattrs-include='*' --selinux \
      --atime-preserve=system --no-recursion \
      -zf "$target" -C "$(dirname "$overlay_root")" \
      "${overlay_members[@]}" \
      >>"$diagnostics" 2>&1; then
    rm -f -- "$target" "$diagnostics" "$before_list" "$before_digest" \
      "$source_only_list"
    return 1
  fi
  if [[ -s "$diagnostics" ]]; then
    rm -f -- "$target" "$diagnostics" "$before_list" "$before_digest" \
      "$source_only_list"
    return 1
  fi
  rm -f -- "$diagnostics"
  if ! materialize_archive_source_inventory \
      "$source_dir" "$after_list" "$after_digest" "$@" \
    || ! cmp -s -- "$before_list" "$after_list" \
    || ! cmp -s -- "$before_digest" "$after_digest" \
    || ! assert_archive_matches_source_inventory \
      "$target" "$before_list" "$before_digest"; then
    rm -f -- "$target" "$before_list" "$before_digest" \
      "$after_list" "$after_digest" "$source_only_list"
    return 1
  fi
  rm -f -- "$before_list" "$before_digest" "$after_list" "$after_digest" \
    "$source_only_list"
  [[ -s "$target" && -f "$target" && ! -L "$target" ]]
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
with open(sys.argv[1], "a", encoding="utf-8") as handle:
    json.dump(entry, handle, separators=(",", ":"), sort_keys=True)
    handle.write("\n")
PY
}

archive_required_component() {
  local component_id="$1"
  local source_dir="$2"
  local target="$3"
  shift 3
  if ! archive_dir "$source_dir" "$target" "$@"; then
    die "Required recovery source is missing or could not be archived: ${component_id} (${source_dir})"
  fi
  local capture_method="live-filesystem-tar"
  [[ "${RUN_TYPE:-}" == "comprehensive" ]] && capture_method="service-quiesced-tar"
  record_recovery_component \
    "$component_id" required captured "$(basename "$target")" "$source_dir" "$capture_method"
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
    if (( attempt >= max_attempts )); then
      die "Required recovery source is missing or could not be archived after ${max_attempts} attempts: ${component_id} (${source_dir})"
    fi
    log "Recovery source changed during capture; retrying ${component_id} ($(( attempt + 1 ))/${max_attempts})"
    (( attempt += 1 ))
    sleep 1
  done
  local capture_method="live-filesystem-tar"
  [[ "${RUN_TYPE:-}" == "comprehensive" ]] && capture_method="service-quiesced-tar"
  record_recovery_component \
    "$component_id" required captured "$(basename "$target")" "$source_dir" "$capture_method"
}

snapshot_sqlite_database() {
  local source_database="$1"
  local snapshot_database="$2"
  python3 - "$source_database" "$snapshot_database" <<'PY'
import os
import pathlib
import sqlite3
import stat
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])

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

def attest_source_member(path, parent_device, *, require_nonempty=False):
    info = os.lstat(path)
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
        path,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
    )
    if source_identity(os.fstat(descriptor)) != source_identity(info):
        os.close(descriptor)
        raise ValueError("SQLite source member changed during admission")
    return info, descriptor

created = False
held_descriptors = []
try:
    if (
        not canonical_path(source)
        or not canonical_path(source.parent)
        or not trusted_directory(source.parent)
        or not target.is_absolute()
        or os.path.normpath(target) != str(target)
        or target.exists()
        or target.is_symlink()
        or not canonical_path(target.parent)
        or not trusted_directory(target.parent)
    ):
        raise ValueError("unsafe SQLite snapshot authority")
    parent_info = os.lstat(source.parent)
    before, source_descriptor = attest_source_member(
        source,
        parent_info.st_dev,
        require_nonempty=True,
    )
    held_descriptors.append(source_descriptor)
    sidecar_suffixes = ("-wal", "-shm", "-journal")
    sidecars_before = {}
    for suffix in sidecar_suffixes:
        candidate = pathlib.Path(str(source) + suffix)
        if not os.path.lexists(candidate):
            continue
        info, descriptor = attest_source_member(candidate, parent_info.st_dev)
        sidecars_before[suffix] = info
        held_descriptors.append(descriptor)

    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(target, flags, 0o600)
    os.close(descriptor)
    created = True

    source_connection = sqlite3.connect(
        source.as_uri() + "?mode=ro",
        uri=True,
        timeout=30.0,
    )
    destination_connection = sqlite3.connect(str(target), timeout=30.0)
    try:
        source_connection.execute("PRAGMA query_only=ON")
        source_connection.execute("PRAGMA busy_timeout=30000")
        destination_connection.execute("PRAGMA busy_timeout=30000")
        source_connection.backup(destination_connection, pages=1024, sleep=0.05)
        destination_connection.execute("PRAGMA journal_mode=DELETE")
        destination_connection.commit()
        queue_table = destination_connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_queue_entries'",
        ).fetchone()
        if queue_table:
            # Match pinned OpenClaw's restore contract: queued outbound
            # deliveries are runtime work, not durable state. Replaying them
            # after a restore can resend stale messages to external channels.
            destination_connection.execute("DELETE FROM delivery_queue_entries")
            destination_connection.commit()
            destination_connection.execute("VACUUM")
        if destination_connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite snapshot integrity check failed")
    finally:
        destination_connection.close()
        source_connection.close()

    after = os.lstat(source)
    if (
        source_identity(before) != source_identity(after)
        or source_identity(before) != source_identity(os.fstat(source_descriptor))
    ):
        raise ValueError("SQLite source identity changed")
    sidecars_after = {
        suffix
        for suffix in sidecar_suffixes
        if os.path.lexists(pathlib.Path(str(source) + suffix))
    }
    if sidecars_after != set(sidecars_before):
        raise ValueError("SQLite sidecar set changed")
    for index, suffix in enumerate(sidecars_before, start=1):
        candidate = pathlib.Path(str(source) + suffix)
        after_sidecar = os.lstat(candidate)
        held_sidecar = os.fstat(held_descriptors[index])
        if (
            source_identity(sidecars_before[suffix]) != source_identity(after_sidecar)
            or source_identity(sidecars_before[suffix]) != source_identity(held_sidecar)
        ):
            raise ValueError("SQLite sidecar identity changed")
    os.chmod(target, 0o600)
    final = os.lstat(target)
    if (
        not stat.S_ISREG(final.st_mode)
        or stat.S_ISLNK(final.st_mode)
        or final.st_uid != 0
        or final.st_gid != 0
        or final.st_nlink != 1
        or stat.S_IMODE(final.st_mode) != 0o600
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
except (OSError, sqlite3.Error, ValueError):
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
    for descriptor in held_descriptors:
        try:
            os.close(descriptor)
        except OSError:
            pass
PY
}

materialize_openclaw_codex_database_list() {
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
pattern = re.compile(r"^(goals|memories)_[0-9]+\.sqlite(?:(-wal|-shm|-journal))?$")
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
    if current.name != "codex-home" or current.parent.name != "agent":
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
        match = pattern.fullmatch(name)
        if match is None:
            continue
        relative = (current / name).relative_to(source).as_posix()
        base = relative.removesuffix(match.group(2) or "")
        if match.group(2):
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
    if ! materialize_openclaw_codex_database_list \
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
          --exclude='*/agent/codex-home/goals_*.sqlite*' \
          --exclude='*/agent/codex-home/memories_*.sqlite*' \
          "$@" "${overlay_options[@]}"; then
        if materialize_openclaw_codex_database_list \
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
      fi
    fi
    rm -rf -- "${snapshot_parent}"
    if $attempt_ok; then
      break
    fi
    rm -f -- "$target"
    if (( attempt >= max_attempts )); then
      die "Required recovery source or SQLite snapshot could not be archived after ${max_attempts} attempts: ${component_id} (${source_dir})"
    fi
    log "Recovery source or SQLite snapshot changed during capture; retrying ${component_id} ($(( attempt + 1 ))/${max_attempts})"
    (( attempt += 1 ))
    sleep 1
  done
  local capture_method="live-filesystem-tar"
  [[ "${RUN_TYPE:-}" == "comprehensive" ]] && capture_method="service-quiesced-tar"
  record_recovery_component \
    "$component_id" required captured "$(basename "$target")" "$source_dir" "$capture_method"
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
      die "Optional recovery source was present but could not be archived: ${component_id} (${source_dir})"
    fi
    local capture_method="live-filesystem-tar"
    [[ "${RUN_TYPE:-}" == "comprehensive" ]] && capture_method="service-quiesced-tar"
    record_recovery_component \
      "$component_id" optional captured "$(basename "$target")" "$source_dir" "$capture_method"
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
  RECOVERY_DIRECTORY_CONSISTENCY="$(
    [[ "${backup_type}" == "comprehensive" ]] \
      && printf 'service-database-quiesced-v2' \
      || printf 'live-filesystem-copy'
  )" \
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
    "schema": "bridgesllm.portal-recovery.v2",
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
      rm -f -- "$old_backup"
    fi
  done
  fsync_directory "$dir"
}

verify_recovery_contract() {
  local directory="$1"
  python3 - "$directory" "${BACKUP_PG_RESTORE_BIN}" \
    "${BACKUP_POSTGRESQL_CLIENT_MAJOR}" "${PORTAL_APP_SOURCES_DIR}" <<'PY'
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
        "SCHILY.acl.default" in member.pax_headers
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
    if (
        set(document) != {
            "schema", "backupType", "createdAt", "portalVersion",
            "installationProfile", "directoryConsistency",
            "metadataProfile", "databaseIdentity", "components",
        }
        or document.get("schema") != "bridgesllm.portal-recovery.v2"
    ):
        fail("unsupported recovery manifest schema")
    if document.get("metadataProfile") != "linux-pax-mtime-xattrs-sparse-v1":
        fail("exact Linux recovery metadata contract is missing")
    if document.get("backupType") not in {"daily", "weekly", "monthly", "comprehensive"}:
        fail("invalid backup type")
    if document.get("directoryConsistency") not in {
        "live-filesystem-copy",
        "service-database-quiesced-v2",
    }:
        fail("directory consistency contract is missing")
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
        if requirement not in {"required", "optional"} or status not in {"captured", "not-configured"}:
            fail("invalid recovery component state")
        if requirement == "required" and status != "captured":
            fail("required recovery component was not captured")
        if component_id == "openclaw-state" or component_id.startswith("stalwart-"):
            expected_requirement = "required" if status == "captured" else "optional"
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
            if method not in {"pg-dump-custom", "file-copy", "live-filesystem-tar", "service-quiesced-tar"}:
                fail("invalid recovery capture method")
            consistency = document.get("directoryConsistency")
            if payload.endswith(".tar.gz") and (
                (consistency == "service-database-quiesced-v2"
                 and method != "service-quiesced-tar")
                or (consistency == "live-filesystem-copy" and method != "live-filesystem-tar")
            ):
                fail("recovery capture method conflicts with its consistency contract")
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
                                if (
                                    not isinstance(source_root, str)
                                    or not source_root.startswith("/")
                                    or not any(
                                        isinstance(root, str)
                                        and (
                                            resolved_link == root
                                            or resolved_link.startswith(root + "/")
                                        )
                                        for root in allowed_roots
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
                        explicit_env = root / "configs/portal-backend.env.production"
                        if (
                            nested_env is None
                            or not nested_env.isfile()
                            or nested_env.size <= 0
                            or nested_env.size > 1024 * 1024
                            or nested_env.uid != 0
                            or nested_env.gid != 0
                            or (nested_env.mode & 0o7777) != 0o600
                            or not explicit_env.is_file()
                            or explicit_env.is_symlink()
                            or os.lstat(explicit_env).st_uid != 0
                            or os.lstat(explicit_env).st_gid != 0
                            or (os.lstat(explicit_env).st_mode & 0o7777) != 0o600
                        ):
                            fail("portal archive omits its sealed environment authority")
                        stream = nested.extractfile(nested_env)
                        if stream is None:
                            fail("portal environment authority could not be read")
                        nested_bytes = stream.read(1024 * 1024 + 1)
                        if nested_bytes != explicit_env.read_bytes():
                            fail("portal archive environment differs from its sealed authority")
        else:
            if payload is not None or entry.get("captureMethod") is not None:
                fail("absent recovery component claims a payload")
            reason = entry.get("reason")
            if not isinstance(reason, str) or not reason.strip() or len(reason) > 512:
                fail("optional absence lacks bounded evidence")

        source = entry.get("source")
        if source is not None and (
            not isinstance(source, str)
            or not source
            or len(source.encode("utf-8")) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in source)
        ):
            fail("invalid recovery source description")

    for component_id, expected_payload in core_payloads.items():
        entry = by_id.get(component_id)
        if not entry or entry.get("requirement") != "required" or entry.get("status") != "captured":
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
  verify_recovery_contract "$directory"
}

verify_archive() {
  local archive="$1"
  local expanded_bytes="" reserve_bytes="${BACKUP_RECOVERY_RESERVE_BYTES:-536870912}"
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
  python3 - "${expanded_bytes}" "${reserve_bytes}" <<'PY' || return 1
import os
import sys

expanded, reserve = (int(value) for value in sys.argv[1:])
stats = os.statvfs("/tmp")
free = stats.f_bavail * stats.f_frsize
if expanded + reserve > free:
    raise SystemExit(1)
PY

  local verify_dir
  verify_dir="$(mktemp -d "/tmp/bridgesllm-backup-verify-XXXXXX")"
  local status=0
  if ! tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$verify_dir"; then
    status=1
  elif ! verify_staging_manifest "$verify_dir"; then
    status=1
  fi
  rm -rf -- "$verify_dir"
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
  assert_backup_disk_admission \
    || die "Backup disk admission failed before any source was quiesced"

  local backup_dir="${BACKUP_BASE}/${type}"
  local staging
  staging="$(mktemp -d "/tmp/bridgesllm-backup-${type}-XXXXXX")"
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
  local archive_path
  archive_path="${backup_dir}/$(backup_name_for_type "$type")"
  PARTIAL_ARCHIVE="${archive_path}.partial-${RUN_ID}"

  mkdir -p "$backup_dir" "${BACKUP_BASE}/logs"
  fsync_directory "$backup_dir" \
    || die "Backup type directory could not be made durable"
  fsync_directory "$BACKUP_BASE" \
    || die "Backup base directory could not be made durable"

  log "Starting ${type} backup"
  log "Portal root: ${PORTAL_DIR}"
  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase database-fence-admission "Checking database fence" 2 \
      || die "Backup progress state could not be updated"
    # Nothing is stopped until the fence has been proven possible on this
    # host. A comprehensive backup that cannot fence the database cannot
    # succeed, and stopping the portal to discover that costs real downtime
    # for an archive that was never going to exist.
    assert_backup_database_exclusion_admission \
      || die "A comprehensive backup could not establish a trusted local PostgreSQL fence through either the host peer socket or a uniquely matched loopback Docker container. No services were stopped. Verify the database endpoint, container health, persistent PGDATA mount, and internal PostgreSQL peer socket."
    assert_backup_lock_guard \
      || die "Backup lock guard was lost before source quiescence"
    set_backup_phase quiescing-services "Quiescing Portal services" 3 \
      || die "Backup progress state could not be updated"
    quiesce_comprehensive_backup_sources \
      || die "Comprehensive backup sources could not be quiesced safely"
    assert_backup_disk_admission \
      || die "Backup disk admission changed after sources were quiesced"
    set_backup_phase fencing-database "Fencing database connections" 4 \
      || die "Backup progress state could not be updated"
    acquire_backup_database_exclusion \
      || die "Portal database could not be fenced exclusively for comprehensive capture"
  fi

  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase database-snapshot "Capturing database snapshot" 5 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase database-snapshot "Capturing database snapshot" 2 \
      || die "Backup progress state could not be updated"
  fi
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

  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase portal-data "Archiving Portal data" 6 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase portal-data "Archiving Portal data" 3 \
      || die "Backup progress state could not be updated"
  fi
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
  archive_required_component projects "$PROJECTS_DIR" "${staging}/projects.tar.gz"
  archive_required_component \
    portal-backend-state "$PORTAL_BACKEND_STATE_DIR" "${staging}/portal-backend-state.tar.gz" \
    --exclude='backups/status.json' \
    --exclude='backups/current.log' \
    --exclude='backups/backup.lock'
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

  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase mail-data "Archiving mail data" 7 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase mail-data "Archiving mail data" 4 \
      || die "Backup progress state could not be updated"
  fi
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
      "Stalwart was configured but this data root did not exist at backup time"
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

  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase openclaw-state "Archiving OpenClaw state" 8 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase openclaw-state "Archiving OpenClaw state" 5 \
      || die "Backup progress state could not be updated"
  fi
  log "Archiving OpenClaw state"
  local openclaw_policy="${OPENCLAW_BACKUP_POLICY:-auto}"
  local openclaw_configured=false
  case "$openclaw_policy" in
    auto)
      if [[ -d "$OPENCLAW_DIR" || -f "${SYSTEMD_DIR}/openclaw-gateway.service" ]]; then
        openclaw_configured=true
      fi
      ;;
    required) openclaw_configured=true ;;
    absent)
      if [[ -d "$OPENCLAW_DIR" || -f "${SYSTEMD_DIR}/openclaw-gateway.service" ]]; then
        die "OPENCLAW_BACKUP_POLICY=absent conflicts with installed OpenClaw evidence"
      fi
      ;;
    *) die "OPENCLAW_BACKUP_POLICY must be auto, required, or absent" ;;
  esac
  if $openclaw_configured; then
    # The managed npm project tree is a reproducible runtime cache. Including
    # it adds hundreds of megabytes and stretches a live capture long enough
    # for routine OpenClaw SQLite WAL writes to invalidate the archive. Keep
    # the configuration, sessions, SQLite state, workspaces, skills, and
    # locally installed extensions; the installer recreates managed npm
    # projects from the pinned plugin configuration during restore/update.
    # Each agent also owns a Codex home, and it is a live runtime directory,
    # not durable state. A capture of this component is only valid if nothing
    # under it is written between the pre- and post-inventory, because the
    # inventory digest covers size, mtime and ctime of every member. Measured
    # on a production host: with the paths below excluded, a 75-second window
    # saw zero metadata changes while a Codex workload ran; with only the
    # scratch roots excluded it saw 51 changes per minute, every one of them
    # inside a Codex home. Retrying cannot win that race -- an agent fleet
    # that is busy simply never holds still -- so the volatile and
    # regenerable members are kept out of the archive instead.
    #
    #   .tmp            a full git clone of the remote plugin catalogue,
    #                   re-synced from .tmp/plugins.sha, replicated per agent
    #   sessions        Codex rollout transcripts, rewritten continuously;
    #                   OpenClaw's own transcripts remain the durable record
    #   cache           model/tool discovery caches, refetched on demand
    #   shell_snapshots per-command scratch, written several times a minute
    #   *.sqlite[-wal]  Codex state and log databases plus their WAL sidecars
    #
    # Configuration, installation identity, skills, plugins and the memory and
    # goal databases stay in the archive: they are recovery-critical. Current
    # Codex runtimes do write the goal/memory SQLite WALs during normal work,
    # so those databases are captured with SQLite's online backup API and
    # overlaid exactly like the primary OpenClaw state database below.
    # The live state/openclaw.sqlite database is different: copying its main
    # file while SQLite is writing a WAL can produce a torn or incomplete
    # restore even if tar's metadata inventory happens to remain stable. Take
    # a verified SQLite online backup, exclude every live journal member, and
    # overlay the snapshot at the original archive path. The generic archive
    # contract inventories and compares that overlay exactly like source data.
    archive_openclaw_state_component \
      openclaw-state "$OPENCLAW_DIR" "${staging}/openclaw-state.tar.gz" 3 \
      --allow-external-hardlinks \
      --exclude='npm/*' \
      --exclude='logs/*' \
      --exclude='*/agent/codex-home/tmp' \
      --exclude='*/agent/codex-home/tmp/*' \
      --exclude='*/agent/codex-home/.tmp' \
      --exclude='*/agent/codex-home/.tmp/*' \
      --exclude='*/agent/codex-home/sessions' \
      --exclude='*/agent/codex-home/sessions/*' \
      --exclude='*/agent/codex-home/cache' \
      --exclude='*/agent/codex-home/cache/*' \
      --exclude='*/agent/codex-home/shell_snapshots' \
      --exclude='*/agent/codex-home/shell_snapshots/*' \
      --exclude='*/agent/codex-home/models_cache.json' \
      --exclude='*/agent/codex-home/state_*.sqlite*' \
      --exclude='*/agent/codex-home/logs_*.sqlite*'
  else
    record_absent_component \
      openclaw-state "$OPENCLAW_DIR" \
      "No OpenClaw state root or gateway service unit was found"
  fi

  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase recovery-metadata "Capturing recovery metadata" 9 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase recovery-metadata "Capturing recovery metadata" 6 \
      || die "Backup progress state could not be updated"
  fi
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
    configs/portal-backend.env.production "${PORTAL_ENV_FILE}" file-copy
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
  verify_staging_manifest "$staging" || die "Backup manifest checksum generation failed"

  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase creating-archive "Creating backup archive" 10 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase creating-archive "Creating backup archive" 7 \
      || die "Backup progress state could not be updated"
  fi
  log "Creating archive ${archive_path}"
  [[ ! -e "$PARTIAL_ARCHIVE" && ! -L "$PARTIAL_ARCHIVE" ]] || die "Refusing unsafe partial archive path"
  tar --format=gnu --sort=name --mtime='@0' \
    --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go-rwx' \
    -czf "$PARTIAL_ARCHIVE" -C "$staging" .
  chmod 600 "$PARTIAL_ARCHIVE"
  if [[ "$type" == "comprehensive" ]]; then
    set_backup_phase verifying-archive "Verifying and publishing archive" 11 \
      || die "Backup progress state could not be updated"
  else
    set_backup_phase verifying-archive "Verifying and publishing archive" 8 \
      || die "Backup progress state could not be updated"
  fi
  if ! verify_archive "$PARTIAL_ARCHIVE"; then
    die "Published archive would not satisfy the recovery manifest contract"
  fi

  local file_count
  file_count="$(tar tzf "$PARTIAL_ARCHIVE" | wc -l)"
  if (( file_count < 2 )); then
    die "Archive integrity check failed: only ${file_count} entries"
  fi
  [[ ! -e "$archive_path" && ! -L "$archive_path" ]] || die "Refusing to overwrite an existing backup: ${archive_path}"
  assert_backup_lock_guard \
    || die "Backup lock guard was lost before backup publication"
  assert_backup_database_exclusion \
    || die "Portal database exclusion changed before backup publication"
  fsync_regular_file "$PARTIAL_ARCHIVE" \
    || die "Backup archive content could not be made durable before publication"
  mv "$PARTIAL_ARCHIVE" "$archive_path"
  fsync_directory "$backup_dir" \
    || die "Published backup directory entry could not be made durable"
  if ! assert_backup_database_exclusion; then
    rm -f -- "$archive_path"
    fsync_directory "$backup_dir" || true
    die "Portal database exclusion changed at backup publication"
  fi
  PARTIAL_ARCHIVE=""

  prune_backups "$type"

  local size
  size="$(du -h "$archive_path" | awk '{print $1}')"
  RUN_ARCHIVE_PATH="$archive_path"
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
    verify_backups
    ;;
  --verify-archive)
    [[ $# -eq 2 && "$2" == /* ]] \
      || die "Usage: $0 --verify-archive /absolute/path/to/archive.tar.gz"
    select_backup_postgresql_toolchain_for_authority "${PORTAL_ENV_FILE}" \
      || die "The active PostgreSQL server/toolchain does not satisfy the supported security floor"
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
