#!/usr/bin/env bash
set -Eeuo pipefail

# OpenClaw's core and separately installed official plugins have independent
# package records. Portal qualifies this exact stable set. ACPX is required for
# the Portal ACP compatibility surface; the other plugins are converged only
# when the operator already has them installed.
readonly OPENCLAW_STABLE_PLUGIN_VERSION="2026.9.1"
readonly OPENCLAW_PLUGIN_MAX_ARCHIVE_BYTES=$((96 * 1024 * 1024))
readonly OPENCLAW_PLUGIN_MAX_EXPANDED_BYTES=$((384 * 1024 * 1024))
openclaw_plugin_managed_entry_bound=250000
openclaw_plugin_managed_byte_bound=$((8 * 1024 * 1024 * 1024))
if [[ "${OPENCLAW_STABLE_PLUGINS_TESTING:-0}" == "1" ]]; then
  openclaw_plugin_managed_entry_bound="${OPENCLAW_PLUGIN_MAX_MANAGED_ENTRIES_TEST_OVERRIDE:-${openclaw_plugin_managed_entry_bound}}"
  openclaw_plugin_managed_byte_bound="${OPENCLAW_PLUGIN_MAX_MANAGED_BYTES_TEST_OVERRIDE:-${openclaw_plugin_managed_byte_bound}}"
fi
[[ "${openclaw_plugin_managed_entry_bound}" =~ ^[1-9][0-9]*$ \
  && "${openclaw_plugin_managed_byte_bound}" =~ ^[1-9][0-9]*$ ]] || {
  printf 'Invalid OpenClaw managed-plugin inventory bound.\n' >&2
  exit 2
}
readonly OPENCLAW_PLUGIN_MAX_MANAGED_ENTRIES="${openclaw_plugin_managed_entry_bound}"
readonly OPENCLAW_PLUGIN_MAX_MANAGED_BYTES="${openclaw_plugin_managed_byte_bound}"
unset openclaw_plugin_managed_entry_bound openclaw_plugin_managed_byte_bound
readonly OPENCLAW_STABLE_PLUGIN_TRANSACTION_SCHEMA="3"

# Plugin activation is a sequence of OpenClaw CLI mutations, so the helper
# publishes every rollback artifact and the intended full set before mutation.
# An atomic attempted-prefix receipt bounds recovery after each hard kill; an
# atomic terminal decision distinguishes a verified commit from a completed
# rollback while either directory is being retired.
#
# OpenClaw 2026.9.1 stores npm plugins in generation-managed projects and keeps
# their active install records in the shared SQLite state database. The outer
# transaction therefore snapshots the complete bounded managed npm root, the
# exact installed-index row, and openclaw.json before invoking any plugin CLI.
# Per-package npm archives remain useful acquisition receipts, but they are not
# rollback authority: npm pack omits ignored bytes, modes, and empty directories.

openclaw_stable_plugin_rows() {
  if [[ "${OPENCLAW_STABLE_PLUGIN_CATALOG:-default}" == "codex" \
    || "${OPENCLAW_STABLE_PLUGIN_CATALOG:-default}" == "portal" ]]; then
    cat <<'EOF'
codex|@openclaw/codex|2026.9.1|sha512-O+HzImle5txYh93pa5CqeFQUA4XHqCpC4bFo7GKrb3WiyPppXtM0JZQ/sVC8E4aeGPGiy3Yx3rI8sl6ceSDH9g==|required
EOF
    [[ "${OPENCLAW_STABLE_PLUGIN_CATALOG}" == "codex" ]] && return
  fi
  [[ "${OPENCLAW_STABLE_PLUGIN_CATALOG:-default}" == "default" \
    || "${OPENCLAW_STABLE_PLUGIN_CATALOG:-default}" == "portal" ]] || return 1
  cat <<'EOF'
acpx|@openclaw/acpx|2026.9.1|sha512-ELP2Fx63XoaKjPuQ66E57rwU7UeRryQ+Lfax9WrVkxcnZohEUxPbJtOlYHf6NRtcPRc8V+c9z8UxEoUNsDkq5A==|required
brave|@openclaw/brave-plugin|2026.9.1|sha512-4+j+eQTToV3k7Cb25MUL6h2uL8cJYyuLytfpd/sJK/HjR43dgKBqKpBsb1+I3w1Jr6PLpnjSf6/I3//3K0cdnA==|existing
discord|@openclaw/discord|2026.9.1|sha512-qNmN2a8A9dET4igPp0RML171sEn8PDMyNCYNp/DqcJ4tn3XTHpacSOTkqBmv5yXTycJRC9rfFP8FT/SdW0Rldg==|existing
voice-call|@openclaw/voice-call|2026.9.1|sha512-Q+YF0SBneLRbX5wyuqxf5Ooo8wSviwUXo+4NrEqFsQ8dLyYdNamg1zUCPlcEUONnQovORtEOQ69Qo9/y80xEsQ==|existing
EOF
}

openclaw_plugin_config_path() {
  if [[ -n "${OPENCLAW_CONFIG_PATH:-}" ]]; then
    printf '%s\n' "${OPENCLAW_CONFIG_PATH}"
  else
    printf '%s/.openclaw/openclaw.json\n' "${HOME}"
  fi
}

openclaw_stable_plugin_details() {
  local id="$1" payload
  payload="$(OPENCLAW_ALLOW_ROOT=1 openclaw plugins inspect "${id}" --json 2>/dev/null)" || return 1
  printf '%s' "${payload}" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const row = JSON.parse(raw);
    if (!row || typeof row !== "object" || Array.isArray(row)) process.exit(1);
    const plugin = row.plugin;
    const install = row.install ?? {};
    if (process.argv[1] === "codex" && (
        plugin?.origin !== "global" || install?.source !== "npm"
        || install?.resolvedName !== "@openclaw/codex")) process.exit(1);
    const values = [
      plugin?.id,
      plugin?.packageName,
      plugin?.version,
      plugin?.rootDir,
      plugin?.source,
      plugin?.trustedOfficialInstall === true ? "true" : "false",
      install?.source,
      install?.resolvedName,
      install?.resolvedVersion,
      install?.resolvedSpec ?? install?.spec,
      install?.integrity,
    ];
    if (values.slice(0, 5).some(value => typeof value !== "string" || !value)) process.exit(1);
    process.stdout.write(values.map(value => typeof value === "string" ? value : "").join("\n") + "\n");
  } catch (_) {
    process.exit(1);
  }
});
' "${id}"
}

openclaw_stable_plugin_present() {
  local id="$1" payload
  payload="$(OPENCLAW_ALLOW_ROOT=1 openclaw plugins list --json 2>/dev/null)" || return 2
  printf '%s' "${payload}" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.plugins)) process.exit(2);
    const matches = parsed.plugins.filter(plugin => plugin?.id === process.argv[1]);
    if (process.argv[1] === "codex" && ["codex", "portal"].includes(process.argv[2])) {
      if (matches.length !== 1) process.exit(matches.length === 0 ? 1 : 2);
      const plugin = matches[0];
      if (plugin?.origin === "bundled" && plugin?.packageName === "@openclaw/codex"
          && plugin?.install == null) process.exit(1);
      process.exit(plugin?.origin === "global" ? 0 : 2);
    }
    process.exit(matches.length === 1 ? 0 : matches.length === 0 ? 1 : 2);
  } catch (_) { process.exit(2); }
});
' "${id}" "${OPENCLAW_STABLE_PLUGIN_CATALOG:-default}"
}

# `plugins list` is tree-derived, so a missing package directory can look the
# same as a complete, operator-authorized uninstall. Before accepting absence,
# require OpenClaw's other two authorities (configuration and installed-index)
# to agree. The Codex catalog is the one exception: a bundled Codex entry may
# remain while the separately managed global package is absent.
openclaw_stable_plugin_absence_unclaimed() {
  local id="$1" config_path database catalog
  config_path="$(openclaw_plugin_config_path)" || return 1
  database="$(openclaw_stable_plugins_database_path)" || return 1
  catalog="${OPENCLAW_STABLE_PLUGIN_CATALOG:-default}"
  python3 - "${id}" "${config_path}" "${database}" \
    "$(id -u)" "${catalog}" <<'PY'
import json
import os
import pathlib
import sqlite3
import stat
import sys
import time

plugin_id, config_raw, database_raw, owner_raw, catalog = sys.argv[1:]
config = pathlib.Path(config_raw)
database = pathlib.Path(database_raw)
owner = int(owner_raw)
if catalog not in {"default", "codex", "portal"}:
    raise SystemExit(1)

def read_regular_json(path, maximum):
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != owner
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or before.st_size <= 0
            or before.st_size > maximum
        ):
            raise SystemExit(1)
        payload = bytearray()
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise SystemExit(1)
            payload.extend(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise SystemExit(1)
        after = os.fstat(descriptor)
        if any(
            getattr(before, field) != getattr(after, field)
            for field in (
                "st_dev", "st_ino", "st_mode", "st_uid", "st_gid",
                "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns",
            )
        ):
            raise SystemExit(1)
        value = json.loads(bytes(payload))
        if not isinstance(value, dict):
            raise SystemExit(1)
        return value
    finally:
        os.close(descriptor)

if os.path.lexists(config):
    document = read_regular_json(config, 16 * 1024 * 1024)
    plugins = document.get("plugins", {})
    if not isinstance(plugins, dict):
        raise SystemExit(1)
    entries = plugins.get("entries", {})
    if not isinstance(entries, dict):
        raise SystemExit(1)
    if not (catalog in {"codex", "portal"} and plugin_id == "codex") and plugin_id in entries:
        raise SystemExit(1)

if not os.path.lexists(database):
    raise SystemExit(0)
if database.is_symlink():
    raise SystemExit(1)
metadata = database.lstat()
if (
    not stat.S_ISREG(metadata.st_mode)
    or metadata.st_uid != owner
    or metadata.st_nlink != 1
    or metadata.st_mode & 0o022
):
    raise SystemExit(1)
connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=5)
try:
    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    if "state_leases" in tables:
        active = connection.execute(
            "SELECT 1 FROM state_leases WHERE "
            "((scope='core:plugin-lifecycle' AND lease_key='global') OR "
            "scope='claw-package-lifecycle') AND expires_at>? LIMIT 1",
            (int(time.time() * 1000),),
        ).fetchone()
        if active:
            raise SystemExit(1)
    if "config_machine_state" not in tables:
        raise SystemExit(0)
    row = connection.execute(
        "SELECT value_json FROM config_machine_state "
        "WHERE state_key='plugins.installedIndex'"
    ).fetchone()
    if row is None:
        raise SystemExit(0)
    value = json.loads(row[0])
    index = value.get("index") if isinstance(value, dict) else None
    if not isinstance(index, dict):
        raise SystemExit(1)
    records = index.get("installRecords", {})
    rows = index.get("plugins", [])
    if not isinstance(records, dict) or not isinstance(rows, list):
        raise SystemExit(1)
    if plugin_id in records:
        raise SystemExit(1)
    for item in rows:
        if not isinstance(item, dict):
            raise SystemExit(1)
        if item.get("pluginId") != plugin_id and item.get("installOwner") != plugin_id:
            continue
        if (
            catalog in {"codex", "portal"}
            and plugin_id == "codex"
            and item.get("pluginId") == plugin_id
            and item.get("origin") == "bundled"
            and item.get("installOwner") in {None, ""}
        ):
            continue
        raise SystemExit(1)
finally:
    connection.close()
PY
}

verify_openclaw_stable_plugin() {
  local id="$1" package="$2" version="$3" details root_real source_real
  local package_name package_version expected_integrity
  local -a fields=()
  details="$(openclaw_stable_plugin_details "${id}")" || return 1
  mapfile -t fields <<< "${details}"
  [[ "${fields[0]:-}" == "${id}" \
    && "${fields[1]:-}" == "${package}" \
    && "${fields[2]:-}" == "${version}" \
    && "${fields[5]:-}" == "true" \
    && "${fields[6]:-}" == "npm" \
    && "${fields[7]:-}" == "${package}" \
    && "${fields[8]:-}" == "${version}" \
    && "${fields[9]:-}" == "${package}@${version}" ]] || return 1
  expected_integrity="$(openclaw_stable_plugins_catalog_integrity "${id}")" \
    || return 1
  [[ "${fields[10]:-}" == "${expected_integrity}" ]] || return 1
  root_real="$(readlink -f -- "${fields[3]:-}" 2>/dev/null || true)"
  source_real="$(readlink -f -- "${fields[4]:-}" 2>/dev/null || true)"
  [[ -n "${root_real}" && -d "${root_real}" \
    && -n "${source_real}" && -f "${source_real}" \
    && "${source_real}" == "${root_real}/"* \
    && -f "${root_real}/package.json" && ! -L "${root_real}/package.json" ]] || return 1
  package_name="$(node -p 'require(process.argv[1]).name' "${root_real}/package.json" 2>/dev/null || true)"
  package_version="$(node -p 'require(process.argv[1]).version' "${root_real}/package.json" 2>/dev/null || true)"
  [[ "${package_name}" == "${package}" && "${package_version}" == "${version}" ]] \
    || return 1
  if [[ "${id}" == "codex" ]]; then
    openclaw_stable_plugins_verify_codex_generation_path \
      "${fields[3]:-}" "${fields[4]:-}"
  fi
}

verify_openclaw_plugin_identity() {
  local id="$1" package="$2" version="$3" details root_real source_real
  local package_name package_version
  local -a fields=()
  details="$(openclaw_stable_plugin_details "${id}")" || return 1
  mapfile -t fields <<< "${details}"
  [[ "${fields[0]:-}" == "${id}" \
    && "${fields[1]:-}" == "${package}" \
    && "${fields[2]:-}" == "${version}" ]] || return 1
  root_real="$(readlink -f -- "${fields[3]:-}" 2>/dev/null || true)"
  source_real="$(readlink -f -- "${fields[4]:-}" 2>/dev/null || true)"
  [[ -n "${root_real}" && -d "${root_real}" \
    && -n "${source_real}" && -f "${source_real}" \
    && "${source_real}" == "${root_real}/"* \
    && -f "${root_real}/package.json" && ! -L "${root_real}/package.json" ]] || return 1
  package_name="$(node -p 'require(process.argv[1]).name' "${root_real}/package.json" 2>/dev/null || true)"
  package_version="$(node -p 'require(process.argv[1]).version' "${root_real}/package.json" 2>/dev/null || true)"
  [[ "${package_name}" == "${package}" && "${package_version}" == "${version}" ]]
}

verify_openclaw_plugin_package_owner() {
  local id="$1" package="$2" details root_real package_name
  local -a fields=()
  details="$(openclaw_stable_plugin_details "${id}")" || return 1
  mapfile -t fields <<< "${details}"
  [[ "${fields[0]:-}" == "${id}" && "${fields[1]:-}" == "${package}" ]] \
    || return 1
  root_real="$(readlink -f -- "${fields[3]:-}" 2>/dev/null || true)"
  [[ -n "${root_real}" && -d "${root_real}" \
    && -f "${root_real}/package.json" && ! -L "${root_real}/package.json" ]] \
    || return 1
  package_name="$(node -p 'require(process.argv[1]).name' \
    "${root_real}/package.json" 2>/dev/null || true)"
  [[ "${package_name}" == "${package}" ]]
}

verify_openclaw_plugin_archive() {
  local archive="$1" expected_package="$2" expected_version="$3" expected_integrity="${4:-}"
  local size actual_integrity
  size="$(stat -c '%s' "${archive}")"
  (( size > 0 && size <= OPENCLAW_PLUGIN_MAX_ARCHIVE_BYTES )) || return 1
  if [[ -n "${expected_integrity}" ]]; then
    actual_integrity="sha512-$(openssl dgst -sha512 -binary "${archive}" | base64 -w0)"
    [[ "${actual_integrity}" == "${expected_integrity}" ]] || return 1
  fi
  python3 - "${archive}" "${expected_package}" "${expected_version}" \
    "${OPENCLAW_PLUGIN_MAX_EXPANDED_BYTES}" <<'PY'
import json
import pathlib
import posixpath
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
expected_name = sys.argv[2]
expected_version = sys.argv[3]
expanded_limit = int(sys.argv[4])
expanded = 0
package_json = None
with tarfile.open(archive, "r:gz") as tf:
    members = tf.getmembers()
    if not members or len(members) > 20000:
        raise SystemExit(1)
    for member in members:
        name = member.name
        normalized = posixpath.normpath(name)
        parts = pathlib.PurePosixPath(normalized).parts
        if not name or "\\" in name or name.startswith("/") or ".." in parts:
            raise SystemExit(1)
        if not (member.isfile() or member.isdir()):
            raise SystemExit(1)
        if not parts or parts[0] != "package":
            raise SystemExit(1)
        if member.isfile():
            expanded += member.size
            if member.size < 0 or expanded > expanded_limit:
                raise SystemExit(1)
        if normalized == "package/package.json":
            handle = tf.extractfile(member)
            if handle is None or member.size > 1024 * 1024:
                raise SystemExit(1)
            package_json = json.loads(handle.read().decode("utf-8"))
if not isinstance(package_json, dict):
    raise SystemExit(1)
if package_json.get("name") != expected_name or package_json.get("version") != expected_version:
    raise SystemExit(1)
PY
}

download_openclaw_stable_plugin() {
  local package="$1" version="$2" integrity="$3" destination="$4"
  local packed_name packed_path
  packed_name="$(npm pack --ignore-scripts --silent --pack-destination "${destination}" \
    "${package}@${version}" 2>/dev/null | tail -1)" || return 1
  packed_path="${destination}/${packed_name}"
  [[ -f "${packed_path}" ]] || return 1
  verify_openclaw_plugin_archive "${packed_path}" "${package}" "${version}" "${integrity}" || return 1
  printf '%s\n' "${packed_path}"
}

pack_openclaw_plugin_baseline() {
  local root="$1" package="$2" version="$3" destination="$4" packed_name packed_path
  packed_name="$(npm pack --ignore-scripts --silent --pack-destination "${destination}" \
    "${root}" 2>/dev/null | tail -1)" || return 1
  packed_path="${destination}/${packed_name}"
  [[ -f "${packed_path}" ]] || return 1
  verify_openclaw_plugin_archive "${packed_path}" "${package}" "${version}" || return 1
  printf '%s\n' "${packed_path}"
}

openclaw_stable_plugins_fault_inject() {
  local transition="$1"
  [[ "${OPENCLAW_STABLE_PLUGINS_TESTING:-0}" == "1" \
    && "${OPENCLAW_STABLE_PLUGIN_CRASH_AT:-}" == "${transition}" ]] || return 0
  kill -KILL "${BASHPID}"
}

openclaw_stable_plugins_fsync_directory() {
  local directory="$1"
  python3 - "${directory}" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(sys.argv[1], flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

openclaw_stable_plugins_fsync_file() {
  local path="$1"
  python3 - "${path}" <<'PY'
import os
import sys

flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(sys.argv[1], flags)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

openclaw_stable_plugins_fsync_tree() {
  local root="$1"
  python3 - "${root}" <<'PY'
import os
import stat
import sys

root = sys.argv[1]
no_follow = getattr(os, "O_NOFOLLOW", 0)
directory_flag = getattr(os, "O_DIRECTORY", 0)
directories = []
for current, names, files in os.walk(root, topdown=True, followlinks=False):
    current_stat = os.lstat(current)
    if not stat.S_ISDIR(current_stat.st_mode):
        raise SystemExit(1)
    directories.append(current)
    for name in names:
        path = os.path.join(current, name)
        mode = os.lstat(path).st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
            raise SystemExit(1)
    for name in files:
        path = os.path.join(current, name)
        mode = os.lstat(path).st_mode
        if stat.S_ISLNK(mode):
            continue
        if not stat.S_ISREG(mode):
            raise SystemExit(1)
        descriptor = os.open(path, os.O_RDONLY | no_follow)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
for directory in reversed(directories):
    descriptor = os.open(directory, os.O_RDONLY | directory_flag | no_follow)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

openclaw_stable_plugins_secure_directory() {
  local directory="$1" owner mode
  [[ -d "${directory}" && ! -L "${directory}" ]] || return 1
  owner="$(stat -c '%u' -- "${directory}" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' -- "${directory}" 2>/dev/null)" || return 1
  [[ "${owner}" == "$(id -u)" && "${mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 077) == 0 ))
}

openclaw_stable_plugins_catalog_package() {
  local wanted_id="$1" id package version integrity policy found=""
  while IFS='|' read -r id package version integrity policy; do
    [[ "${id}" == "${wanted_id}" ]] || continue
    [[ -z "${found}" ]] || return 1
    found="${package}"
  done < <(openclaw_stable_plugin_rows)
  [[ -n "${found}" ]] || return 1
  printf '%s\n' "${found}"
}

openclaw_stable_plugins_catalog_integrity() {
  local wanted_id="$1" id package version integrity policy found=""
  while IFS='|' read -r id package version integrity policy; do
    [[ "${id}" == "${wanted_id}" ]] || continue
    [[ -z "${found}" && "${integrity}" == sha512-* ]] || return 1
    found="${integrity}"
  done < <(openclaw_stable_plugin_rows)
  [[ -n "${found}" ]] || return 1
  printf '%s\n' "${found}"
}

openclaw_stable_plugins_config_path_digest() {
  local config_path="$1"
  printf '%s' "${config_path}" | sha512sum | awk '{print $1}'
}

openclaw_stable_plugins_file_digest() {
  local path="$1"
  sha512sum -- "${path}" | awk '{print $1}'
}

openclaw_stable_plugins_file_integrity() {
  local path="$1"
  printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary "${path}" | base64 -w0)"
}

openclaw_stable_plugins_state_dir() {
  local config_path
  config_path="$(openclaw_plugin_config_path)" || return 1
  [[ "${config_path}" == /* && "${config_path##*/}" == "openclaw.json" ]] \
    || return 1
  dirname -- "${config_path}"
}

openclaw_stable_plugins_managed_root() {
  if [[ "${OPENCLAW_STABLE_PLUGINS_TESTING:-0}" == "1" \
    && -n "${OPENCLAW_PLUGIN_NPM_ROOT:-}" ]]; then
    [[ "${OPENCLAW_PLUGIN_NPM_ROOT}" == /* ]] || return 1
    printf '%s\n' "${OPENCLAW_PLUGIN_NPM_ROOT}"
  else
    printf '%s/npm\n' "$(openclaw_stable_plugins_state_dir)"
  fi
}

openclaw_stable_plugins_database_path() {
  if [[ "${OPENCLAW_STABLE_PLUGINS_TESTING:-0}" == "1" \
    && -n "${OPENCLAW_PLUGIN_STATE_DATABASE:-}" ]]; then
    [[ "${OPENCLAW_PLUGIN_STATE_DATABASE}" == /* ]] || return 1
    printf '%s\n' "${OPENCLAW_PLUGIN_STATE_DATABASE}"
  else
    printf '%s/state/openclaw.sqlite\n' "$(openclaw_stable_plugins_state_dir)"
  fi
}

# Bind Codex to the exact stable or replacement project OpenClaw 9.1 owns.
# readlink(1) alone is insufficient here: an attacker-controlled intermediate
# component can be swapped after resolution.  Keep each directory descriptor
# open with O_NOFOLLOW while walking from the managed npm root to the exact
# package root and dist/index.js entrypoint.
openclaw_stable_plugins_verify_codex_generation_path() {
  local plugin_root="$1" plugin_source="$2" managed_root
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  python3 - "${managed_root}" "${plugin_root}" "${plugin_source}" \
    "$(id -u)" "$(id -g)" <<'PY'
import os
import pathlib
import re
import stat
import sys

managed = pathlib.Path(sys.argv[1])
plugin_root = pathlib.Path(sys.argv[2])
plugin_source = pathlib.Path(sys.argv[3])
owner = int(sys.argv[4])
group = int(sys.argv[5])

if not all(path.is_absolute() for path in (managed, plugin_root, plugin_source)):
    raise SystemExit("Codex managed paths must be absolute")
try:
    relative = plugin_root.relative_to(managed)
except ValueError:
    raise SystemExit("Codex package root escapes the managed npm root")
parts = relative.parts
if len(parts) != 5 or parts[0] != "projects" or parts[2:] != (
        "node_modules", "@openclaw", "codex"):
    raise SystemExit("Codex package root is not a generation-managed project")
generation = parts[1]
generation_pattern = re.compile(
    r"^openclaw-codex-8902d781d4(?:__openclaw-generation__g-[a-f0-9]{16})?$"
)
if not generation_pattern.fullmatch(generation):
    raise SystemExit("Codex generation name is not canonical")
if plugin_source != plugin_root / "dist" / "index.js":
    raise SystemExit("Codex source is not the exact package entrypoint")

directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
fds = []
try:
    descriptor = os.open(managed, directory_flags)
    fds.append(descriptor)
    metadata = os.fstat(descriptor)
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != owner
            or metadata.st_gid != group or stat.S_IMODE(metadata.st_mode) & 0o022):
        raise SystemExit("managed npm root is not owner-controlled")
    for component in (*parts, "dist"):
        descriptor = os.open(component, directory_flags, dir_fd=fds[-1])
        fds.append(descriptor)
        metadata = os.fstat(descriptor)
        if (metadata.st_uid != owner or metadata.st_gid != group
                or stat.S_IMODE(metadata.st_mode) & 0o022):
            raise SystemExit("Codex path component is not owner-controlled")
    file_descriptor = os.open(
        "index.js", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=fds[-1]
    )
    try:
        metadata = os.fstat(file_descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner
                or metadata.st_gid != group or metadata.st_nlink != 1
                or stat.S_IMODE(metadata.st_mode) & 0o022):
            raise SystemExit("Codex entrypoint is not an owner-controlled regular file")
    finally:
        os.close(file_descriptor)
finally:
    for descriptor in reversed(fds):
        os.close(descriptor)
PY
}

openclaw_stable_plugins_require_quiescence() {
  [[ "${OPENCLAW_STABLE_PLUGINS_QUIESCED:-0}" == "1" ]] || {
    printf 'OpenClaw plugin convergence requires the prepared gateway-quiesced boundary.\n' >&2
    return 1
  }
  if [[ "${OPENCLAW_STABLE_PLUGINS_TESTING:-0}" != "1" ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl is-active --quiet openclaw-gateway; then
    printf 'OpenClaw gateway is active; refusing plugin lifecycle mutation.\n' >&2
    return 1
  fi
}

# Write a canonical, root-relative inventory. It is deliberately independent
# from npm manifests so ignored files, modes, empty directories, and absence
# remain rollback facts. npm executable links are accepted only when they stay
# inside their containing node_modules tree. OpenClaw's managed peer link is
# accepted only for the pinned core package. Links are inventoried, never copied
# through or followed during a rollback swap.
openclaw_stable_plugins_write_tree_inventory() {
  local root="$1" output="$2"
  python3 - "${root}" "${output}" "$(id -u)" "$(id -g)" \
    "${OPENCLAW_PLUGIN_MAX_MANAGED_ENTRIES}" \
    "${OPENCLAW_PLUGIN_MAX_MANAGED_BYTES}" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
owner = int(sys.argv[3])
group = int(sys.argv[4])
entry_limit = int(sys.argv[5])
byte_limit = int(sys.argv[6])

def fail(message):
    raise SystemExit(message)

if not root.is_absolute() or not output.is_absolute():
    fail("inventory paths must be absolute")
if root.is_symlink():
    fail("managed npm root must not be a symlink")
if not root.exists():
    payload = {"schema": 1, "present": False, "entries": 0, "bytes": 0, "records": []}
else:
    root_stat = root.lstat()
    if (not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != owner
            or root_stat.st_gid != group or stat.S_IMODE(root_stat.st_mode) & 0o022):
        fail("managed npm root is not an owner-controlled directory")
    root_fd = os.open(
        root,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    held_root_stat = os.fstat(root_fd)
    if (held_root_stat.st_dev, held_root_stat.st_ino) != (root_stat.st_dev, root_stat.st_ino):
        os.close(root_fd)
        fail("managed npm root changed while it was opened")
    records = []
    byte_count = 0
    try:
        for current, directories, files in os.walk(root, topdown=True, followlinks=False):
            directories.sort()
            files.sort()
            current_path = pathlib.Path(current)
            # Real directories are recorded when os.walk visits them. Directory
            # symlinks are not visited with followlinks=False, so record those now.
            names = [None, *[name for name in directories
                             if (current_path / name).is_symlink()], *files]
            for name in names:
                path = current_path if name is None else current_path / name
                relative = "." if path == root else path.relative_to(root).as_posix()
                if len(relative) > 4096 or len(path.relative_to(root).parts) > 64:
                    fail("managed npm path exceeds bounds")
                metadata = path.lstat()
                mode = stat.S_IMODE(metadata.st_mode)
                if (metadata.st_uid != owner or metadata.st_gid != group
                        or (not stat.S_ISLNK(metadata.st_mode) and mode & 0o022)):
                    fail(f"managed npm entry is not owner-controlled: {relative}")
                record = {"path": relative, "mode": mode, "uid": metadata.st_uid,
                          "gid": metadata.st_gid}
                if stat.S_ISDIR(metadata.st_mode):
                    descriptor = os.open(
                        path,
                        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                        | getattr(os, "O_NOFOLLOW", 0),
                    )
                    try:
                        held = os.fstat(descriptor)
                        if (held.st_dev, held.st_ino) != (metadata.st_dev, metadata.st_ino):
                            fail(f"managed npm directory changed while opened: {relative}")
                    finally:
                        os.close(descriptor)
                    record["type"] = "dir"
                elif stat.S_ISREG(metadata.st_mode):
                    if metadata.st_nlink != 1:
                        fail(f"managed npm regular file has ambiguous hardlinks: {relative}")
                    byte_count += metadata.st_size
                    if byte_count > byte_limit:
                        fail("managed npm tree exceeds byte bound")
                    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                    try:
                        held = os.fstat(descriptor)
                        if ((held.st_dev, held.st_ino) != (metadata.st_dev, metadata.st_ino)
                                or held.st_nlink != 1):
                            fail(f"managed npm file changed while opened: {relative}")
                        digest = hashlib.sha512()
                        while True:
                            chunk = os.read(descriptor, 1024 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
                    finally:
                        os.close(descriptor)
                    record.update(type="file", size=metadata.st_size,
                                  sha512=digest.hexdigest())
                elif stat.S_ISLNK(metadata.st_mode):
                    parts = pathlib.PurePosixPath(relative).parts
                    target = os.readlink(path)
                    if not target or "\x00" in target or len(target) > 4096:
                        fail(f"invalid managed npm link: {relative}")
                    try:
                        resolved = path.resolve(strict=True)
                    except (OSError, RuntimeError):
                        fail(f"managed npm link does not resolve safely: {relative}")
                    if len(parts) >= 2 and parts[-2] == ".bin":
                        if os.path.isabs(target):
                            fail(f"managed npm executable link is absolute: {relative}")
                        bin_root = path.parent.parent.resolve(strict=True)
                        try:
                            resolved.relative_to(bin_root)
                        except ValueError:
                            fail(f"managed npm executable link escapes node_modules: {relative}")
                        target_stat = resolved.stat()
                        if (not stat.S_ISREG(target_stat.st_mode)
                                or target_stat.st_uid != owner or target_stat.st_gid != group
                                or stat.S_IMODE(target_stat.st_mode) & 0o022
                                or target_stat.st_nlink != 1):
                            fail(f"managed npm executable link target is ambiguous: {relative}")
                    elif len(parts) >= 2 and parts[-2:] == ("node_modules", "openclaw"):
                        target_stat = resolved.stat()
                        if (not stat.S_ISDIR(target_stat.st_mode)
                                or target_stat.st_uid != owner or target_stat.st_gid != group
                                or stat.S_IMODE(target_stat.st_mode) & 0o022):
                            fail(f"managed npm peer link target is not owner-controlled: {relative}")
                        try:
                            package = json.loads((resolved / "package.json").read_text(encoding="utf-8"))
                        except Exception:
                            fail(f"managed npm peer link target has no valid package manifest: {relative}")
                        if package.get("name") != "openclaw" or package.get("version") != "2026.9.1":
                            fail(f"managed npm peer link target is not the pinned OpenClaw package: {relative}")
                    elif not os.path.isabs(target):
                        try:
                            resolved.relative_to(root.resolve(strict=True))
                        except ValueError:
                            fail(f"managed npm relative link escapes its root: {relative}")
                        target_stat = resolved.stat()
                        if (not (stat.S_ISDIR(target_stat.st_mode)
                                 or stat.S_ISREG(target_stat.st_mode))
                                or target_stat.st_uid != owner or target_stat.st_gid != group
                                or stat.S_IMODE(target_stat.st_mode) & 0o022
                                or (stat.S_ISREG(target_stat.st_mode)
                                    and target_stat.st_nlink != 1)):
                            fail(f"managed npm relative link target is ambiguous: {relative}")
                    else:
                        fail(f"unexpected managed npm symlink: {relative}")
                    record.update(type="symlink", target=target)
                else:
                    fail(f"managed npm tree contains a special file: {relative}")
                records.append(record)
                if len(records) > entry_limit:
                    fail("managed npm tree exceeds entry bound")
    finally:
        os.close(root_fd)
    records.sort(key=lambda row: row["path"])
    payload = {"schema": 1, "present": True, "entries": len(records),
               "bytes": byte_count, "records": records}

temporary = output.with_name(output.name + ".next")
if temporary.exists() or temporary.is_symlink():
    fail("inventory temporary path already exists")
with temporary.open("x", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, output)
PY
}

openclaw_stable_plugins_verify_tree_snapshot() {
  local snapshot="$1" inventory="$2" scratch
  [[ -f "${inventory}" && ! -L "${inventory}" ]] || return 1
  scratch="${inventory}.verify"
  [[ ! -e "${scratch}" && ! -L "${scratch}" ]] || return 1
  openclaw_stable_plugins_write_tree_inventory "${snapshot}" "${scratch}" \
    || { rm -f -- "${scratch}"; return 1; }
  cmp -s -- "${inventory}" "${scratch}" || {
    rm -f -- "${scratch}"
    return 1
  }
  rm -f -- "${scratch}"
}

openclaw_stable_plugins_capture_installed_index() {
  local database="$1" output="$2"
  python3 - "${database}" "${output}" "$(id -u)" <<'PY'
import json
import os
import pathlib
import sqlite3
import stat
import sys

database = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
owner = int(sys.argv[3])
payload = {"schema": 1, "databasePresent": False, "rowPresent": False}
if database.is_symlink():
    raise SystemExit("shared state database must not be a symlink")
if database.exists():
    metadata = database.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner or metadata.st_nlink != 1:
        raise SystemExit("shared state database has ambiguous identity")
    payload["databasePresent"] = True
    uri = f"file:{database}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_machine_state'"
        ).fetchone()
        if table:
            row = connection.execute(
                "SELECT value_json, updated_at_ms FROM config_machine_state "
                "WHERE state_key='plugins.installedIndex'"
            ).fetchone()
            if row:
                parsed = json.loads(row[0])
                if not isinstance(parsed, dict) or not isinstance(row[1], int):
                    raise SystemExit("installed plugin index row is invalid")
                payload.update(rowPresent=True, valueJson=row[0], updatedAtMs=row[1])
    finally:
        connection.close()
temporary = output.with_name(output.name + ".next")
if temporary.exists() or temporary.is_symlink():
    raise SystemExit("installed-index temporary path already exists")
with temporary.open("x", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, output)
PY
}

# Prove that changes outside the planned official package generations did not
# occur after the snapshot. Directory mtimes are intentionally absent from the
# inventory; bytes, modes, owners, empty directories, links, and absence are
# exact. A changed/new/deleted project is authorized only when its own project
# manifest binds it to exactly one planned package.
openclaw_stable_plugins_assert_owned_tree_drift() {
  local baseline_root="$1" baseline_inventory="$2" current_root="$3" manifest="$4"
  python3 - "${baseline_root}" "${baseline_inventory}" "${current_root}" \
    "${manifest}" "$(id -u)" "$(id -g)" "${OPENCLAW_PLUGIN_MAX_MANAGED_ENTRIES}" \
    "${OPENCLAW_PLUGIN_MAX_MANAGED_BYTES}" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

baseline_root = pathlib.Path(sys.argv[1])
baseline = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
current_root = pathlib.Path(sys.argv[3])
manifest_lines = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8").splitlines()
owner = int(sys.argv[5])
group = int(sys.argv[6])
entry_limit = int(sys.argv[7])
byte_limit = int(sys.argv[8])
planned = {}
plan_order = []
for line in manifest_lines:
    fields = line.split("|")
    if fields[0] == "plugin" and len(fields) == 10:
        planned[fields[2]] = {fields[3], fields[7]} - {"-"}
        plan_order.append(fields[2])
if not planned:
    raise SystemExit("transaction has no planned packages")
transaction_root = pathlib.Path(sys.argv[4]).parent
try:
    attempted = int((transaction_root / "attempted").read_text(encoding="utf-8").strip())
    verified = int((transaction_root / "verified").read_text(encoding="utf-8").strip())
except (OSError, UnicodeError, ValueError):
    raise SystemExit("transaction progress receipts are invalid")
if not 0 <= verified <= attempted <= len(plan_order) or attempted - verified > 1:
    raise SystemExit("transaction progress receipts are inconsistent")
unverified_package = plan_order[verified] if attempted == verified + 1 else None

def inventory(root):
    if root.is_symlink():
        raise SystemExit("managed npm root became a symlink")
    if not root.exists():
        return {"present": False, "records": []}
    root_meta = root.lstat()
    if (not stat.S_ISDIR(root_meta.st_mode) or root_meta.st_uid != owner
            or root_meta.st_gid != group or stat.S_IMODE(root_meta.st_mode) & 0o022):
        raise SystemExit("managed npm root has foreign identity")
    root_fd = os.open(
        root,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    if (os.fstat(root_fd).st_dev, os.fstat(root_fd).st_ino) != (
            root_meta.st_dev, root_meta.st_ino):
        os.close(root_fd)
        raise SystemExit("managed npm root changed while opened")
    rows, total = [], 0
    try:
      for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        dirs.sort(); files.sort()
        base = pathlib.Path(current)
        names = [None, *[name for name in dirs if (base / name).is_symlink()], *files]
        for name in names:
            path = base if name is None else base / name
            rel = "." if path == root else path.relative_to(root).as_posix()
            metadata = path.lstat()
            mode = stat.S_IMODE(metadata.st_mode)
            if (metadata.st_uid != owner or metadata.st_gid != group
                    or (not stat.S_ISLNK(metadata.st_mode) and mode & 0o022)):
                raise SystemExit(f"foreign identity in managed npm root: {rel}")
            row = {"path": rel, "mode": mode,
                   "uid": metadata.st_uid, "gid": metadata.st_gid}
            if stat.S_ISDIR(metadata.st_mode):
                descriptor = os.open(
                    path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0)
                )
                try:
                    held = os.fstat(descriptor)
                    if (held.st_dev, held.st_ino) != (metadata.st_dev, metadata.st_ino):
                        raise SystemExit(f"directory changed while opened: {rel}")
                finally:
                    os.close(descriptor)
                row["type"] = "dir"
            elif stat.S_ISREG(metadata.st_mode):
                if metadata.st_nlink != 1: raise SystemExit(f"hardlink in managed npm root: {rel}")
                total += metadata.st_size
                if total > byte_limit: raise SystemExit("managed npm tree exceeds byte bound")
                digest = hashlib.sha512()
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    held = os.fstat(descriptor)
                    if ((held.st_dev, held.st_ino) != (metadata.st_dev, metadata.st_ino)
                            or held.st_nlink != 1):
                        raise SystemExit(f"file changed while opened: {rel}")
                    while True:
                        chunk = os.read(descriptor, 1024 * 1024)
                        if not chunk: break
                        digest.update(chunk)
                finally:
                    os.close(descriptor)
                row.update(type="file", size=metadata.st_size, sha512=digest.hexdigest())
            elif stat.S_ISLNK(metadata.st_mode):
                parts = pathlib.PurePosixPath(rel).parts
                target = os.readlink(path)
                if not target or "\x00" in target or len(target) > 4096:
                    raise SystemExit(f"invalid symlink in managed npm root: {rel}")
                try: resolved = path.resolve(strict=True)
                except (OSError, RuntimeError):
                    raise SystemExit(f"unresolvable symlink in managed npm root: {rel}")
                if len(parts) >= 2 and parts[-2] == ".bin":
                    if os.path.isabs(target):
                        raise SystemExit(f"absolute executable link in managed npm root: {rel}")
                    bin_root = path.parent.parent.resolve(strict=True)
                    try: resolved.relative_to(bin_root)
                    except ValueError:
                        raise SystemExit(f"escaping executable link in managed npm root: {rel}")
                    target_stat = resolved.stat()
                    if (not stat.S_ISREG(target_stat.st_mode)
                            or target_stat.st_uid != owner or target_stat.st_gid != group
                            or stat.S_IMODE(target_stat.st_mode) & 0o022
                            or target_stat.st_nlink != 1):
                        raise SystemExit(f"ambiguous executable link target: {rel}")
                elif len(parts) >= 2 and parts[-2:] == ("node_modules", "openclaw"):
                    target_stat = resolved.stat()
                    if (not stat.S_ISDIR(target_stat.st_mode)
                            or target_stat.st_uid != owner or target_stat.st_gid != group
                            or stat.S_IMODE(target_stat.st_mode) & 0o022):
                        raise SystemExit(f"foreign OpenClaw peer link target: {rel}")
                    try: package = json.loads((resolved / "package.json").read_text(encoding="utf-8"))
                    except Exception: raise SystemExit(f"invalid OpenClaw peer link target: {rel}")
                    if package.get("name") != "openclaw" or package.get("version") != "2026.9.1":
                        raise SystemExit(f"unpinned OpenClaw peer link target: {rel}")
                elif not os.path.isabs(target):
                    try: resolved.relative_to(root.resolve(strict=True))
                    except ValueError:
                        raise SystemExit(f"escaping relative link in managed npm root: {rel}")
                    target_stat = resolved.stat()
                    if (not (stat.S_ISDIR(target_stat.st_mode)
                            or stat.S_ISREG(target_stat.st_mode))
                            or target_stat.st_uid != owner or target_stat.st_gid != group
                            or stat.S_IMODE(target_stat.st_mode) & 0o022
                            or (stat.S_ISREG(target_stat.st_mode)
                                and target_stat.st_nlink != 1)):
                        raise SystemExit(f"ambiguous relative link target: {rel}")
                else:
                    raise SystemExit(f"unexpected symlink in managed npm root: {rel}")
                row.update(type="symlink", target=target)
            else: raise SystemExit(f"special file in managed npm root: {rel}")
            rows.append(row)
            if len(rows) > entry_limit: raise SystemExit("managed npm tree exceeds entry bound")
    finally:
        os.close(root_fd)
    return {"present": True, "records": sorted(rows, key=lambda row: row["path"])}

current = inventory(current_root)
baseline_rows = {row["path"]: row for row in baseline.get("records", [])}
current_rows = {row["path"]: row for row in current.get("records", [])}

generation_pattern = re.compile(r"^[A-Za-z0-9@._-]+__openclaw-generation__g-[a-f0-9]{16}$")
def project_owner(root, project):
    if not generation_pattern.fullmatch(project) and not re.fullmatch(r"[A-Za-z0-9@._-]+", project):
        return None
    try:
        value = json.loads((root / "projects" / project / "package.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    dependencies = value.get("dependencies")
    if not isinstance(dependencies, dict): return None
    matches = [name for name in planned if name in dependencies]
    return matches[0] if len(matches) == 1 else None

authorized_projects = set()
for source in (baseline_root, current_root):
    projects = source / "projects"
    if not projects.is_dir() or projects.is_symlink(): continue
    for entry in projects.iterdir():
        if entry.is_dir() and not entry.is_symlink() and project_owner(source, entry.name):
            authorized_projects.add(entry.name)

def owned_path(path):
    parts = pathlib.PurePosixPath(path).parts
    if len(parts) >= 2 and parts[0] == "projects" and parts[1] in authorized_projects:
        return True
    if len(parts) >= 2 and parts[0] == "node_modules":
        if len(parts) == 2 and parts[1].startswith("@"):
            return any(package.startswith(parts[1] + "/") for package in planned)
        package = "/".join(parts[1:3]) if parts[1].startswith("@") and len(parts) >= 3 else parts[1]
        return package in planned
    return False

for path in sorted(set(baseline_rows) | set(current_rows)):
    if baseline_rows.get(path) == current_rows.get(path): continue
    if path in {".", "projects", "node_modules"}: continue
    if not owned_path(path):
        raise SystemExit(f"foreign managed npm drift: {path}")

for project in authorized_projects:
    for source in (baseline_root, current_root):
        project_dir = source / "projects" / project
        if not project_dir.exists(): continue
        package = project_owner(source, project)
        if package not in planned: raise SystemExit("planned project ownership changed")
        package_dir = project_dir / "node_modules" / pathlib.Path(*package.split("/"))
        if package_dir.exists():
            try: value = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
            except Exception: raise SystemExit("planned plugin package manifest is invalid")
            if (value.get("name") != package or value.get("version") not in planned[package]) \
                    and package != unverified_package:
                raise SystemExit("planned plugin package identity is outside the transaction")

for package, versions in planned.items():
    package_dir = current_root / "node_modules" / pathlib.Path(*package.split("/"))
    if not package_dir.exists():
        continue
    if package_dir.is_symlink() or not package_dir.is_dir():
        raise SystemExit("planned direct plugin package has ambiguous identity")
    try:
        value = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
    except Exception:
        raise SystemExit("planned direct plugin package manifest is invalid")
    if (value.get("name") != package or value.get("version") not in versions) \
            and package != unverified_package:
        raise SystemExit("planned direct plugin package identity is outside the transaction")
PY
}

openclaw_stable_plugins_assert_owned_config_drift() {
  local baseline="$1" baseline_present="$2" current="$3" manifest="$4"
  python3 - "${baseline}" "${baseline_present}" "${current}" "${manifest}" <<'PY'
import copy
import json
import pathlib
import sys

baseline_path, baseline_present, current_path, manifest_path = sys.argv[1:]
projection_path = pathlib.Path(manifest_path).parent / "config-projection"
projection = False
if projection_path.exists() or projection_path.is_symlink():
    if (projection_path.is_symlink()
            or projection_path.read_text(encoding="ascii") not in {"codex-projection\n", "portal-projection\n"}):
        raise SystemExit("invalid Codex config projection marker")
    projection = True
ids = set()
for line in pathlib.Path(manifest_path).read_text(encoding="utf-8").splitlines():
    fields = line.split("|")
    if fields[0] == "plugin" and len(fields) == 10: ids.add(fields[1])

def load(path, present):
    if not present: return None
    value = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict): raise SystemExit("OpenClaw config is not an object")
    return value

baseline = load(baseline_path, baseline_present == "true")
current_exists = pathlib.Path(current_path).is_file() and not pathlib.Path(current_path).is_symlink()
current = load(current_path, current_exists)
if baseline == current: raise SystemExit(0)

def normalized(value):
    value = copy.deepcopy(value)
    plugins = value.get("plugins")
    if isinstance(plugins, dict):
        entries = plugins.get("entries")
        if isinstance(entries, dict):
            for plugin_id in ids: entries.pop(plugin_id, None)
            if not entries: plugins.pop("entries", None)
        allowed = plugins.get("allow")
        if isinstance(allowed, list):
            plugins["allow"] = [entry for entry in allowed if entry not in ids]
            if not plugins["allow"]: plugins.pop("allow", None)
        # The normal stable-plugin transaction owns the aggregate activation
        # switch.  A Codex projection transaction deliberately does not: it
        # owns only Codex's entry/allow membership and deterministic 9.1
        # bookkeeping, so a concurrent owner cannot be silently overwritten.
        if not projection:
            plugins.pop("enabled", None)
        if not plugins: value.pop("plugins", None)
    # A first plugin command may materialize these exact core-owned migration
    # receipts even when openclaw.json was absent. They are deterministic
    # OpenClaw 2026.9.1 bookkeeping, not user configuration.
    meta = value.get("meta")
    if isinstance(meta, dict):
        if meta.get("lastTouchedVersion") == "2026.9.1":
            # The pinned core replaces the previous receipt on its first
            # plugin write. Compare against that exact recorded receipt;
            # dropping only the new value rejects retained-runtime upgrades.
            previous_meta = (baseline or {}).get("meta")
            if isinstance(previous_meta, dict) and "lastTouchedVersion" in previous_meta:
                meta["lastTouchedVersion"] = previous_meta["lastTouchedVersion"]
            else:
                meta.pop("lastTouchedVersion", None)
        migrations = meta.get("migrations")
        if isinstance(migrations, dict):
            if migrations.get("modelPolicyAllowlist") is True:
                migrations.pop("modelPolicyAllowlist", None)
            if not migrations: meta.pop("migrations", None)
        if not meta: value.pop("meta", None)
    return value

if baseline is None:
    if current is not None and normalized(current) == {}:
        raise SystemExit(0)
    raise SystemExit("OpenClaw config creation includes foreign drift")
if current is None:
    raise SystemExit("OpenClaw config disappeared during plugin convergence")
if normalized(baseline) != normalized(current):
    raise SystemExit("foreign OpenClaw config drift")
PY
}

openclaw_stable_plugins_restore_installed_index() {
  local database="$1" baseline="$2" manifest="$3" mode="${4:-restore}"
  [[ "${mode}" == "check" || "${mode}" == "restore" ]] || return 1
  python3 - "${database}" "${baseline}" "${manifest}" "$(id -u)" "${mode}" <<'PY'
import copy
import json
import pathlib
import sqlite3
import stat
import sys
import time

database = pathlib.Path(sys.argv[1])
baseline = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
manifest = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8").splitlines()
owner = int(sys.argv[4])
mode = sys.argv[5]
plans = {}
plan_order = []
for line in manifest:
    fields = line.split("|")
    if fields[0] == "plugin" and len(fields) == 10:
        versions = {fields[3], fields[7]} - {"-"}
        plans[fields[1]] = {"package": fields[2], "versions": versions}
        plan_order.append(fields[1])
ids = set(plans)
transaction_root = pathlib.Path(sys.argv[2]).parent
try:
    attempted = int((transaction_root / "attempted").read_text(encoding="utf-8").strip())
    verified = int((transaction_root / "verified").read_text(encoding="utf-8").strip())
except (OSError, UnicodeError, ValueError):
    raise SystemExit("transaction progress receipts are invalid")
if not 0 <= verified <= attempted <= len(plan_order) or attempted - verified > 1:
    raise SystemExit("transaction progress receipts are inconsistent")
unverified_id = plan_order[verified] if attempted == verified + 1 else None

if database.is_symlink(): raise SystemExit("shared state database became a symlink")
if not database.exists():
    if baseline.get("databasePresent") or baseline.get("rowPresent"):
        raise SystemExit("shared state database disappeared")
    raise SystemExit(0)
metadata = database.lstat()
if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner or metadata.st_nlink != 1:
    raise SystemExit("shared state database has ambiguous identity")

def normalize(raw):
    if raw is None: return None
    value = json.loads(raw)
    if not isinstance(value, dict): raise SystemExit("installed plugin index is invalid")
    value = copy.deepcopy(value)
    value.pop("revision", None)
    index = value.get("index")
    if not isinstance(index, dict): return value
    for key in ("generatedAtMs", "refreshReason", "policyHash"):
        index.pop(key, None)
    records = index.get("installRecords")
    if isinstance(records, dict):
        for key in list(records):
            record = records.get(key)
            plan = plans.get(key)
            if plan is not None and record_is_owned(record, plan, key == unverified_id):
                records.pop(key, None)
    plugins = index.get("plugins")
    if isinstance(plugins, list):
        index["plugins"] = [row for row in plugins if not isinstance(row, dict) or
                            not plugin_row_is_owned(row)]
    diagnostics = index.get("diagnostics")
    if isinstance(diagnostics, list):
        index["diagnostics"] = [row for row in diagnostics if not isinstance(row, dict) or
                                row.get("pluginId") not in ids]
    return value

def valid_version(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        return False
    return value[0].isalnum() and all(character.isalnum() or character in ".+_-"
                                     for character in value)

def record_is_owned(record, plan, allow_unverified=False):
    if not isinstance(record, dict): return False
    package = plan["package"]
    versions = plan["versions"]
    if record.get("resolvedName") != package:
        return False
    observed_versions = [record.get(field) for field in ("version", "resolvedVersion")
                         if record.get(field) is not None]
    allowed_specs = {f"{package}@{version}" for version in versions}
    observed_specs = [record.get(field) for field in ("spec", "resolvedSpec")
                      if record.get(field) is not None]
    if allow_unverified:
        return (bool(observed_versions) and all(valid_version(str(version))
                                                for version in observed_versions)
                and bool(observed_specs)
                and all(isinstance(spec, str) and spec.startswith(package + "@")
                        and valid_version(spec[len(package) + 1:])
                        for spec in observed_specs))
    return (bool(observed_versions)
            and all(str(version) in versions for version in observed_versions)
            and bool(observed_specs)
            and all(str(spec) in allowed_specs for spec in observed_specs))

def plugin_row_is_owned(row):
    plugin_id = row.get("pluginId")
    plan = plans.get(plugin_id)
    if plan is None or row.get("installOwner") != plugin_id:
        return False
    if row.get("origin") not in (None, "global"):
        return False
    if row.get("packageName") != plan["package"]:
        return False
    version = str(row.get("packageVersion", ""))
    return valid_version(version) if plugin_id == unverified_id else version in plan["versions"]

connection = sqlite3.connect(str(database), timeout=10, isolation_level=None)
try:
    connection.execute("PRAGMA busy_timeout=10000")
    connection.execute("BEGIN IMMEDIATE")
    tables = {row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    if "state_leases" in tables:
        now = int(time.time() * 1000)
        active = connection.execute(
            "SELECT scope, lease_key FROM state_leases WHERE "
            "((scope='core:plugin-lifecycle' AND lease_key='global') OR "
            "scope='claw-package-lifecycle') AND expires_at>? LIMIT 1", (now,)
        ).fetchone()
        if active: raise SystemExit("an OpenClaw plugin/package lifecycle lease is active")
    current = None
    if "config_machine_state" in tables:
        row = connection.execute(
            "SELECT value_json FROM config_machine_state "
            "WHERE state_key='plugins.installedIndex'"
        ).fetchone()
        current = row[0] if row else None
    baseline_raw = baseline.get("valueJson") if baseline.get("rowPresent") else None
    if current != baseline_raw:
        if baseline_raw is not None and normalize(current) != normalize(baseline_raw):
            raise SystemExit("foreign installed-plugin index drift")
        if baseline_raw is None and current is not None:
            # A missing row may be materialized by the first managed install.
            # Registry-wide bundled rows are generated cache, but any global
            # install owner or install record outside this exact plan is
            # foreign state and makes deleting the new row unsafe.
            parsed = json.loads(current)
            index = parsed.get("index") if isinstance(parsed, dict) else None
            if not isinstance(index, dict):
                raise SystemExit("materialized installed-plugin index is invalid")
            records = index.get("installRecords", {})
            if not isinstance(records, dict):
                raise SystemExit("materialized install records are invalid")
            for key, record in records.items():
                plan = plans.get(key)
                if plan is None or not record_is_owned(record, plan, key == unverified_id):
                    raise SystemExit("foreign installed-plugin record appeared")
            plugin_rows = index.get("plugins", [])
            if not isinstance(plugin_rows, list):
                raise SystemExit("materialized plugin registry is invalid")
            for row in plugin_rows:
                if not isinstance(row, dict):
                    raise SystemExit("materialized plugin row is invalid")
                install_owner = row.get("installOwner")
                if install_owner not in (None, "") and not plugin_row_is_owned(row):
                    raise SystemExit("foreign installed-plugin owner appeared")
    if mode == "check":
        connection.execute("ROLLBACK")
        raise SystemExit(0)
    if "config_machine_state" not in tables:
        if baseline.get("rowPresent"): raise SystemExit("installed-index table disappeared")
    elif baseline.get("rowPresent"):
        connection.execute(
            "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) "
            "VALUES('plugins.installedIndex',?,?) ON CONFLICT(state_key) DO UPDATE SET "
            "value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms",
            (baseline["valueJson"], baseline["updatedAtMs"]),
        )
    else:
        connection.execute("DELETE FROM config_machine_state WHERE state_key='plugins.installedIndex'")
    connection.execute("COMMIT")
except BaseException:
    try: connection.execute("ROLLBACK")
    except Exception: pass
    raise
finally:
    connection.close()
PY
}

openclaw_stable_plugins_prepare_outer_snapshot() {
  local prepare="$1" managed_root managed_parent database state inventory_digest index_digest
  local managed_path_digest database_path_digest snapshot
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  database="$(openclaw_stable_plugins_database_path)" || return 1
  [[ "${managed_root}" == /* && "${database}" == /* ]] || return 1
  managed_parent="$(dirname -- "${managed_root}")"
  [[ -d "${managed_parent}" && ! -L "${managed_parent}" \
    && ! -e "${managed_parent}/.bridgesllm-stable-plugins-npm-restore" \
    && ! -L "${managed_parent}/.bridgesllm-stable-plugins-npm-restore" \
    && ! -e "${managed_parent}/.bridgesllm-stable-plugins-npm-rollback-current" \
    && ! -L "${managed_parent}/.bridgesllm-stable-plugins-npm-rollback-current" ]] \
    || return 1
  managed_path_digest="$(openclaw_stable_plugins_config_path_digest "${managed_root}")" \
    || return 1
  database_path_digest="$(openclaw_stable_plugins_config_path_digest "${database}")" \
    || return 1

  openclaw_stable_plugins_write_tree_inventory \
    "${managed_root}" "${prepare}/managed-npm.previous.inventory" || return 1
  state="$(python3 - "${prepare}/managed-npm.previous.inventory" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
print("present" if value.get("present") is True else "absent")
print(value.get("entries", -1))
print(value.get("bytes", -1))
PY
)" || return 1
  mapfile -t OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS <<< "${state}"
  [[ ( "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[0]:-}" == "present" \
        || "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[0]:-}" == "absent" ) \
    && "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[1]:-}" =~ ^[0-9]+$ \
    && "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[2]:-}" =~ ^[0-9]+$ ]] || return 1
  if [[ "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[0]}" == "present" ]]; then
    snapshot="${prepare}/managed-npm.previous"
    [[ ! -e "${snapshot}" && ! -L "${snapshot}" ]] || return 1
    cp -a -- "${managed_root}" "${snapshot}" || return 1
    openclaw_stable_plugins_verify_tree_snapshot \
      "${snapshot}" "${prepare}/managed-npm.previous.inventory" || return 1
  fi
  # Independent second inventory closes the copy window before publication.
  openclaw_stable_plugins_verify_tree_snapshot \
    "${managed_root}" "${prepare}/managed-npm.previous.inventory" || return 1
  inventory_digest="$(openclaw_stable_plugins_file_digest \
    "${prepare}/managed-npm.previous.inventory")" || return 1

  openclaw_stable_plugins_capture_installed_index \
    "${database}" "${prepare}/installed-index.previous.json" || return 1
  index_digest="$(openclaw_stable_plugins_file_digest \
    "${prepare}/installed-index.previous.json")" || return 1
  # The installed-index read happens after the tree copy. Re-read the tree so
  # one concurrent lifecycle cannot publish a cross-generation snapshot.
  openclaw_stable_plugins_verify_tree_snapshot \
    "${managed_root}" "${prepare}/managed-npm.previous.inventory" || return 1

  OPENCLAW_PLUGIN_MANAGED_ROOT="${managed_root}"
  OPENCLAW_PLUGIN_MANAGED_PATH_DIGEST="${managed_path_digest}"
  OPENCLAW_PLUGIN_MANAGED_INVENTORY_DIGEST="${inventory_digest}"
  OPENCLAW_PLUGIN_DATABASE_PATH="${database}"
  OPENCLAW_PLUGIN_DATABASE_PATH_DIGEST="${database_path_digest}"
  OPENCLAW_PLUGIN_INDEX_SNAPSHOT_DIGEST="${index_digest}"
}

openclaw_stable_plugins_verify_outer_snapshot_current() {
  local prepare="$1" config_preexisted="$2"
  local managed_root database config_path scratch
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  database="$(openclaw_stable_plugins_database_path)" || return 1
  config_path="$(openclaw_plugin_config_path)" || return 1
  openclaw_stable_plugins_verify_tree_snapshot \
    "${managed_root}" "${prepare}/managed-npm.previous.inventory" || return 1
  scratch="${prepare}/installed-index.current.verify.json"
  [[ ! -e "${scratch}" && ! -L "${scratch}" ]] || return 1
  openclaw_stable_plugins_capture_installed_index "${database}" "${scratch}" \
    || { rm -f -- "${scratch}"; return 1; }
  cmp -s -- "${prepare}/installed-index.previous.json" "${scratch}" || {
    rm -f -- "${scratch}"
    return 1
  }
  rm -f -- "${scratch}" || return 1
  if [[ "${config_preexisted}" == "true" ]]; then
    [[ -f "${config_path}" && ! -L "${config_path}" \
      && -f "${prepare}/openclaw.json.previous" \
      && ! -L "${prepare}/openclaw.json.previous" ]] || return 1
    cmp -s -- "${prepare}/openclaw.json.previous" "${config_path}"
  else
    [[ "${config_preexisted}" == "false" \
      && ! -e "${config_path}" && ! -L "${config_path}" ]]
  fi
}

openclaw_stable_plugins_remove_managed_stage() {
  local path="$1" parent owner
  [[ "${path}" == /* && -d "${path}" && ! -L "${path}" ]] || return 1
  owner="$(stat -c '%u' -- "${path}" 2>/dev/null)" || return 1
  [[ "${owner}" == "$(id -u)" ]] || return 1
  parent="$(dirname -- "${path}")"
  rm -rf -- "${path}" || return 1
  openclaw_stable_plugins_fsync_directory "${parent}"
}

openclaw_stable_plugins_restore_managed_root() {
  local transaction_root="$1" baseline_state="$2"
  local managed_root parent restore quarantine baseline_snapshot inventory
  local current_is_baseline=false
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  parent="$(dirname -- "${managed_root}")"
  restore="${parent}/.bridgesllm-stable-plugins-npm-restore"
  quarantine="${parent}/.bridgesllm-stable-plugins-npm-rollback-current"
  baseline_snapshot="${transaction_root}/managed-npm.previous"
  inventory="${transaction_root}/managed-npm.previous.inventory"
  [[ -d "${parent}" && ! -L "${parent}" \
    && -f "${inventory}" && ! -L "${inventory}" ]] || return 1
  if [[ "${baseline_state}" == "present" ]]; then
    [[ -d "${baseline_snapshot}" && ! -L "${baseline_snapshot}" ]] || return 1
    openclaw_stable_plugins_verify_tree_snapshot \
      "${baseline_snapshot}" "${inventory}" || return 1
  else
    [[ "${baseline_state}" == "absent" \
      && ! -e "${baseline_snapshot}" && ! -L "${baseline_snapshot}" ]] || return 1
  fi

  if [[ "${baseline_state}" == "present" \
    && -d "${managed_root}" && ! -L "${managed_root}" ]] \
    && openclaw_stable_plugins_verify_tree_snapshot "${managed_root}" "${inventory}"; then
    current_is_baseline=true
  elif [[ "${baseline_state}" == "absent" \
    && ! -e "${managed_root}" && ! -L "${managed_root}" ]]; then
    current_is_baseline=true
  fi

  # Resume a previous exact swap before beginning a new one.
  if [[ -e "${quarantine}" || -L "${quarantine}" ]]; then
    [[ -d "${quarantine}" && ! -L "${quarantine}" ]] || return 1
    openclaw_stable_plugins_assert_owned_tree_drift \
      "${baseline_snapshot}" "${inventory}" "${quarantine}" \
      "${transaction_root}/manifest" || return 1
    if ! ${current_is_baseline}; then
      [[ ! -e "${managed_root}" && ! -L "${managed_root}" ]] || return 1
      if [[ "${baseline_state}" == "present" ]]; then
        if [[ ! -e "${restore}" && ! -L "${restore}" ]]; then
          cp -a -- "${baseline_snapshot}" "${restore}" || return 1
        fi
        [[ -d "${restore}" && ! -L "${restore}" ]] || return 1
        openclaw_stable_plugins_verify_tree_snapshot "${restore}" "${inventory}" \
          || return 1
        mv -- "${restore}" "${managed_root}" || return 1
        openclaw_stable_plugins_fsync_directory "${parent}" || return 1
      fi
    fi
    if [[ "${baseline_state}" == "present" ]]; then
      openclaw_stable_plugins_verify_tree_snapshot "${managed_root}" "${inventory}" \
        || return 1
    else
      [[ ! -e "${managed_root}" && ! -L "${managed_root}" ]] || return 1
    fi
    openclaw_stable_plugins_remove_managed_stage "${quarantine}" || return 1
    if [[ -e "${restore}" || -L "${restore}" ]]; then
      [[ -d "${restore}" && ! -L "${restore}" ]] || return 1
      openclaw_stable_plugins_verify_tree_snapshot "${restore}" "${inventory}" \
        || return 1
      openclaw_stable_plugins_remove_managed_stage "${restore}" || return 1
    fi
    return 0
  fi

  if ${current_is_baseline}; then
    if [[ -e "${restore}" || -L "${restore}" ]]; then
      [[ "${baseline_state}" == "present" \
        && -d "${restore}" && ! -L "${restore}" ]] || return 1
      openclaw_stable_plugins_verify_tree_snapshot "${restore}" "${inventory}" \
        || return 1
      openclaw_stable_plugins_remove_managed_stage "${restore}" || return 1
    fi
    return 0
  fi

  [[ ! -e "${restore}" && ! -L "${restore}" ]] || return 1
  openclaw_stable_plugins_assert_owned_tree_drift \
    "${baseline_snapshot}" "${inventory}" "${managed_root}" \
    "${transaction_root}/manifest" || return 1
  if [[ "${baseline_state}" == "present" ]]; then
    cp -a -- "${baseline_snapshot}" "${restore}" || return 1
    openclaw_stable_plugins_verify_tree_snapshot "${restore}" "${inventory}" \
      || return 1
    openclaw_stable_plugins_fsync_tree "${restore}" || return 1
    openclaw_stable_plugins_fsync_directory "${parent}" || return 1
  fi
  openclaw_stable_plugins_fault_inject 'before-managed-root-swap'
  [[ -d "${managed_root}" && ! -L "${managed_root}" ]] || return 1
  mv -- "${managed_root}" "${quarantine}" || return 1
  openclaw_stable_plugins_fsync_directory "${parent}" || return 1
  openclaw_stable_plugins_fault_inject 'after-managed-root-quarantine'
  if [[ "${baseline_state}" == "present" ]]; then
    mv -- "${restore}" "${managed_root}" || return 1
    openclaw_stable_plugins_fsync_directory "${parent}" || return 1
  fi
  openclaw_stable_plugins_fault_inject 'after-managed-root-restore'
  if [[ "${baseline_state}" == "present" ]]; then
    openclaw_stable_plugins_verify_tree_snapshot "${managed_root}" "${inventory}" \
      || return 1
  else
    [[ ! -e "${managed_root}" && ! -L "${managed_root}" ]] || return 1
  fi
  openclaw_stable_plugins_remove_managed_stage "${quarantine}" || return 1
  openclaw_stable_plugins_fault_inject 'after-managed-root-cleanup'
}

openclaw_stable_plugins_acquire_lock() {
  local create_parent="$1" transaction_parent parent_owner parent_mode lock_path
  local created_parent=false
  transaction_parent="${OPENCLAW_PLUGIN_TRANSACTION_ROOT:-/var/lib/bridgesllm-installer}"
  [[ "${transaction_parent}" == /* ]] || return 1
  if [[ ! -e "${transaction_parent}" && ! -L "${transaction_parent}" ]]; then
    [[ "${create_parent}" == "true" ]] || return 2
    install -d -m 0700 "${transaction_parent}" || return 1
    created_parent=true
  fi
  [[ -d "${transaction_parent}" && ! -L "${transaction_parent}" ]] || {
    printf 'OpenClaw plugin transaction parent is not a safe directory: %s\n' \
      "${transaction_parent}" >&2
    return 1
  }
  parent_owner="$(stat -c '%u' -- "${transaction_parent}" 2>/dev/null)" || return 1
  parent_mode="$(stat -c '%a' -- "${transaction_parent}" 2>/dev/null)" || return 1
  [[ "${parent_owner}" == "$(id -u)" && "${parent_mode}" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${parent_mode} & 022) == 0 )) || return 1
  if ${created_parent}; then
    openclaw_stable_plugins_fsync_directory "$(dirname -- "${transaction_parent}")" || return 1
  fi
  OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT="${transaction_parent}"
  lock_path="${transaction_parent}/openclaw-stable-plugins.lock"
  if [[ ! -e "${lock_path}" && ! -L "${lock_path}" ]]; then
    ( umask 077; : > "${lock_path}" ) || return 1
    openclaw_stable_plugins_fsync_file "${lock_path}" || return 1
    openclaw_stable_plugins_fsync_directory "${transaction_parent}" || return 1
  fi
  [[ -f "${lock_path}" && ! -L "${lock_path}" \
    && "$(stat -c '%u' -- "${lock_path}" 2>/dev/null)" == "$(id -u)" \
    && "$(stat -c '%h' -- "${lock_path}" 2>/dev/null)" == "1" ]] || return 1
  chmod 0600 "${lock_path}" || return 1
  exec {OPENCLAW_STABLE_PLUGIN_LOCK_FD}<>"${lock_path}" || return 1
  flock -x "${OPENCLAW_STABLE_PLUGIN_LOCK_FD}" || {
    exec {OPENCLAW_STABLE_PLUGIN_LOCK_FD}<&-
    return 1
  }
}

openclaw_stable_plugins_release_lock() {
  if [[ -n "${OPENCLAW_STABLE_PLUGIN_LOCK_FD:-}" ]]; then
    flock -u "${OPENCLAW_STABLE_PLUGIN_LOCK_FD}" || true
    exec {OPENCLAW_STABLE_PLUGIN_LOCK_FD}<&-
    unset OPENCLAW_STABLE_PLUGIN_LOCK_FD
  fi
}

openclaw_stable_plugins_remove_tree() {
  local tree="$1" parent
  openclaw_stable_plugins_secure_directory "${tree}" || return 1
  parent="$(dirname -- "${tree}")"
  rm -rf -- "${tree}" || return 1
  openclaw_stable_plugins_fsync_directory "${parent}"
}

openclaw_stable_plugins_write_attempted() {
  local transaction_root="$1" attempted="$2"
  local next="${transaction_root}/attempted.next"
  [[ "${attempted}" =~ ^[0-9]+$ && ! -e "${next}" && ! -L "${next}" ]] || return 1
  printf '%s\n' "${attempted}" > "${next}" || return 1
  openclaw_stable_plugins_fsync_file "${next}" || return 1
  openclaw_stable_plugins_fault_inject "after-attempted-temp:${attempted}"
  mv -fT -- "${next}" "${transaction_root}/attempted" || return 1
  openclaw_stable_plugins_fault_inject "after-attempted-rename:${attempted}"
  openclaw_stable_plugins_fsync_directory "${transaction_root}"
}

openclaw_stable_plugins_write_verified() {
  local transaction_root="$1" verified="$2"
  local next="${transaction_root}/verified.next"
  [[ "${verified}" =~ ^[0-9]+$ && ! -e "${next}" && ! -L "${next}" ]] || return 1
  printf '%s\n' "${verified}" > "${next}" || return 1
  openclaw_stable_plugins_fsync_file "${next}" || return 1
  openclaw_stable_plugins_fault_inject "after-verified-temp:${verified}"
  mv -fT -- "${next}" "${transaction_root}/verified" || return 1
  openclaw_stable_plugins_fault_inject "after-verified-rename:${verified}"
  openclaw_stable_plugins_fsync_directory "${transaction_root}"
}

openclaw_stable_plugins_write_decision() {
  local transaction_root="$1" decision="$2" next
  next="${transaction_root}/decision.next"
  [[ "${decision}" == "commit" || "${decision}" == "rolled-back" ]] || return 1
  if [[ -e "${transaction_root}/decision" || -L "${transaction_root}/decision" ]]; then
    [[ -f "${transaction_root}/decision" \
      && ! -L "${transaction_root}/decision" \
      && "$(<"${transaction_root}/decision")" == "${decision}" \
      && ! -e "${next}" && ! -L "${next}" ]] || return 1
    return 0
  fi
  if [[ -e "${next}" || -L "${next}" ]]; then
    [[ -f "${next}" && ! -L "${next}" \
      && "$(<"${next}")" == "${decision}" ]] || return 1
  else
    printf '%s\n' "${decision}" > "${next}" || return 1
    openclaw_stable_plugins_fsync_file "${next}" || return 1
    openclaw_stable_plugins_fault_inject "after-decision-temp:${decision}"
  fi
  mv -fT -- "${next}" "${transaction_root}/decision" || return 1
  openclaw_stable_plugins_fault_inject "after-decision-rename:${decision}"
  openclaw_stable_plugins_fsync_directory "${transaction_root}"
}

openclaw_stable_plugins_write_cleanup_intent() {
  local state_root="$1" active="$2" decision="$3"
  local intent="${state_root}/cleanup-intent"
  openclaw_stable_plugins_fault_inject "before-cleanup-intent:${decision}"
  python3 - "${state_root}" "${active}" "${intent}" "${decision}" <<'PY' || return 1
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

state_root, active, intent = map(Path, sys.argv[1:4])
decision = sys.argv[4]
if decision not in {"commit", "rolled-back"}:
    raise SystemExit(1)
state_info = os.lstat(state_root)
active_info = os.lstat(active)
if (not stat.S_ISDIR(state_info.st_mode) or stat.S_ISLNK(state_info.st_mode)
        or state_info.st_uid != 0 or state_info.st_gid != 0
        or state_info.st_mode & 0o022
        or not stat.S_ISDIR(active_info.st_mode) or stat.S_ISLNK(active_info.st_mode)
        or active_info.st_uid != 0 or active_info.st_gid != 0
        or active_info.st_mode & 0o022
        or (active / "decision").read_text(encoding="ascii") != decision + "\n"):
    raise SystemExit(1)
manifest = active / "manifest"
manifest_info = os.lstat(manifest)
if (not stat.S_ISREG(manifest_info.st_mode) or stat.S_ISLNK(manifest_info.st_mode)
        or manifest_info.st_uid != 0 or manifest_info.st_gid != 0
        or manifest_info.st_nlink != 1):
    raise SystemExit(1)
document = {
    "schema": "bridgesllm-openclaw-stable-plugin-cleanup-intent-v1",
    "decision": decision,
    "transactionDevice": active_info.st_dev,
    "transactionInode": active_info.st_ino,
    "manifestSha512": hashlib.sha512(manifest.read_bytes()).hexdigest(),
}
encoded = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
if os.path.lexists(intent):
    info = os.lstat(intent)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600 or intent.read_bytes() != encoded):
        raise SystemExit(1)
    raise SystemExit(0)
fd, temporary_name = tempfile.mkstemp(prefix=".cleanup-intent.", dir=state_root)
temporary = Path(temporary_name)
try:
    os.fchown(fd, 0, 0); os.fchmod(fd, 0o600)
    os.write(fd, encoded); os.fsync(fd); os.close(fd); fd = -1
    directory = os.open(state_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.replace(temporary.name, intent.name,
                   src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)
    temporary = None
finally:
    if fd >= 0: os.close(fd)
    if temporary is not None:
        try: temporary.unlink()
        except FileNotFoundError: pass
PY
  openclaw_stable_plugins_fault_inject "after-cleanup-intent:${decision}"
}

openclaw_stable_plugins_resume_cleanup_intent() {
  local state_root="$1"
  python3 - "${state_root}" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import sys

state_root = Path(sys.argv[1])
intent_name = "cleanup-intent"
active_name = "active"
retired_name = "retired"

def fault(point):
    if os.environ.get("OPENCLAW_STABLE_PLUGIN_CRASH_AT") == point:
        os.kill(os.getppid(), signal.SIGKILL)
        os.kill(os.getpid(), signal.SIGKILL)

root_fd = os.open(state_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    root_info = os.fstat(root_fd)
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != 0
            or root_info.st_gid != 0 or root_info.st_mode & 0o022):
        raise SystemExit(1)
    intent_fd = os.open(intent_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        intent_info = os.fstat(intent_fd)
        raw = b""
        while True:
            chunk = os.read(intent_fd, 16384)
            if not chunk: break
            raw += chunk
        if (not stat.S_ISREG(intent_info.st_mode) or intent_info.st_uid != 0
                or intent_info.st_gid != 0 or intent_info.st_nlink != 1
                or stat.S_IMODE(intent_info.st_mode) != 0o600):
            raise SystemExit(1)
        document = json.loads(raw.decode("utf-8"))
    finally:
        os.close(intent_fd)
    if (not isinstance(document, dict) or set(document) != {
            "schema", "decision", "transactionDevice", "transactionInode",
            "manifestSha512",
        } or document.get("schema")
            != "bridgesllm-openclaw-stable-plugin-cleanup-intent-v1"
            or document.get("decision") not in {"commit", "rolled-back"}
            or not isinstance(document.get("transactionDevice"), int)
            or not isinstance(document.get("transactionInode"), int)
            or not isinstance(document.get("manifestSha512"), str)
            or len(document["manifestSha512"]) != 128):
        raise SystemExit(1)
    active_exists = True
    retired_exists = True
    try: active_info = os.stat(active_name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError: active_exists = False; active_info = None
    try: retired_info = os.stat(retired_name, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError: retired_exists = False; retired_info = None
    if active_exists and retired_exists:
        raise SystemExit(1)
    expected = (document["transactionDevice"], document["transactionInode"])
    selected = active_info if active_exists else retired_info
    if selected is not None and (selected.st_dev, selected.st_ino) != expected:
        raise SystemExit(1)
    if active_exists:
        transaction_fd = os.open(active_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                 dir_fd=root_fd)
        try:
            manifest_fd = os.open("manifest", os.O_RDONLY | os.O_NOFOLLOW,
                                  dir_fd=transaction_fd)
            try:
                payload = b""
                while True:
                    chunk = os.read(manifest_fd, 1024 * 1024)
                    if not chunk: break
                    payload += chunk
            finally: os.close(manifest_fd)
            if hashlib.sha512(payload).hexdigest() != document["manifestSha512"]:
                raise SystemExit(1)
        finally: os.close(transaction_fd)
        os.rename(active_name, retired_name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        fault(f"after-cleanup-rename:{document['decision']}")
        os.fsync(root_fd)
        retired_exists = True
    if retired_exists:
        retired_fd = os.open(retired_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=root_fd)
        try:
            if (os.fstat(retired_fd).st_dev, os.fstat(retired_fd).st_ino) != expected:
                raise SystemExit(1)
            def remove_children(directory_fd):
                for entry in sorted(os.scandir(directory_fd), key=lambda item: item.name):
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        # Plugin rollback snapshots legitimately contain npm
                        # peer-dependency symlinks. Unlinking the directory entry
                        # through its already-open parent cannot follow the link;
                        # still require the exact root-owned, single-link shape
                        # admitted before retirement.
                        if info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1:
                            raise SystemExit(1)
                        fault(f"before-cleanup-member:{entry.name}")
                        os.unlink(entry.name, dir_fd=directory_fd)
                        fault(f"after-cleanup-member:{entry.name}")
                    elif stat.S_ISDIR(info.st_mode):
                        child_fd = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                           dir_fd=directory_fd)
                        try: remove_children(child_fd)
                        finally: os.close(child_fd)
                        os.rmdir(entry.name, dir_fd=directory_fd)
                    elif stat.S_ISREG(info.st_mode) and info.st_uid == 0 \
                            and info.st_gid == 0 and info.st_nlink == 1:
                        fault(f"before-cleanup-member:{entry.name}")
                        os.unlink(entry.name, dir_fd=directory_fd)
                        fault(f"after-cleanup-member:{entry.name}")
                    else:
                        raise SystemExit(1)
                os.fsync(directory_fd)
            remove_children(retired_fd)
        finally: os.close(retired_fd)
        current = os.stat(retired_name, dir_fd=root_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != expected:
            raise SystemExit(1)
        os.rmdir(retired_name, dir_fd=root_fd)
        fault("after-cleanup-root-unlink")
    os.fsync(root_fd)
    fault("after-cleanup-root-fsync")
    os.unlink(intent_name, dir_fd=root_fd)
    fault("after-cleanup-intent-unlink")
    os.fsync(root_fd)
    fault("after-cleanup-intent-fsync")
finally:
    os.close(root_fd)
PY
}

openclaw_stable_plugins_write_committed_config() {
  local transaction_root="$1" config_path_digest="$2" config_digest="$3" next
  next="${transaction_root}/committed-config.next"
  [[ "${config_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${config_digest}" =~ ^[0-9a-f]{128}$ \
    && ! -e "${transaction_root}/committed-config" \
    && ! -L "${transaction_root}/committed-config" \
    && ! -e "${next}" && ! -L "${next}" ]] || return 1
  printf 'config|%s|%s\n' "${config_path_digest}" "${config_digest}" \
    > "${next}" || return 1
  openclaw_stable_plugins_fsync_file "${next}" || return 1
  mv -fT -- "${next}" "${transaction_root}/committed-config" || return 1
  openclaw_stable_plugins_fsync_directory "${transaction_root}"
}

openclaw_stable_plugins_restore_config_projection() {
  local transaction_root="$1" config_path="$2"
  python3 - "${transaction_root}" "${config_path}" <<'PY'
import copy
import json
import os
import pathlib
import stat
import sys
import tempfile

transaction = pathlib.Path(sys.argv[1])
current_path = pathlib.Path(sys.argv[2])
baseline_path = transaction / "openclaw.json.previous"
marker = transaction / "config-projection"
projection_mode = marker.read_text(encoding="ascii").strip()
if projection_mode not in {"codex-projection", "portal-projection"}:
    raise SystemExit("invalid Codex config projection marker")
ids = []
for line in (transaction / "manifest").read_text(encoding="utf-8").splitlines():
    fields = line.split("|")
    if fields[0] == "plugin" and len(fields) == 10:
        ids.append(fields[1])
allowed_ids = ["codex"] if projection_mode == "codex-projection" else ["codex", "acpx", "brave", "discord", "voice-call"]
if not ids or ids[0] != "codex" or len(set(ids)) != len(ids) or any(item not in allowed_ids for item in ids):
    raise SystemExit("plugin projection journal has an ambiguous plugin set")

def load(path):
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != 0 or metadata.st_gid != 0
            or metadata.st_nlink != 1 or metadata.st_mode & 0o022):
        raise SystemExit("unsafe OpenClaw config projection file")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit("OpenClaw config projection is not an object")
    return value, metadata

baseline, _ = load(baseline_path)
current, current_metadata = load(current_path)

def normalized(value):
    value = copy.deepcopy(value)
    plugins = value.get("plugins")
    if isinstance(plugins, dict):
        entries = plugins.get("entries")
        if isinstance(entries, dict):
            for plugin_id in ids:
                entries.pop(plugin_id, None)
            if not entries:
                plugins.pop("entries", None)
        allowed = plugins.get("allow")
        if isinstance(allowed, list):
            plugins["allow"] = [entry for entry in allowed if entry not in ids]
            if not plugins["allow"]:
                plugins.pop("allow", None)
        if not plugins:
            value.pop("plugins", None)
    meta = value.get("meta")
    if isinstance(meta, dict):
        if meta.get("lastTouchedVersion") == "2026.9.1":
            # The pinned core replaces the previous receipt on its first
            # plugin write. Compare against that exact recorded receipt;
            # dropping only the new value rejects retained-runtime upgrades.
            previous_meta = (baseline or {}).get("meta")
            if isinstance(previous_meta, dict) and "lastTouchedVersion" in previous_meta:
                meta["lastTouchedVersion"] = previous_meta["lastTouchedVersion"]
            else:
                meta.pop("lastTouchedVersion", None)
        migrations = meta.get("migrations")
        if isinstance(migrations, dict):
            if migrations.get("modelPolicyAllowlist") is True:
                migrations.pop("modelPolicyAllowlist", None)
            if not migrations:
                meta.pop("migrations", None)
        if not meta:
            value.pop("meta", None)
    return value

if normalized(baseline) != normalized(current):
    raise SystemExit("foreign OpenClaw config drift blocks Codex projection rollback")

parent_fd = os.open(current_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
temporary_fd = None
temporary_path = None
try:
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix=current_path.name + ".codex-projection.", dir=current_path.parent
    )
    temporary_path = pathlib.Path(temporary_name)
    os.fchown(temporary_fd, current_metadata.st_uid, current_metadata.st_gid)
    os.fchmod(temporary_fd, stat.S_IMODE(current_metadata.st_mode))
    with os.fdopen(temporary_fd, "w", encoding="utf-8") as handle:
        temporary_fd = None
        handle.write(baseline_path.read_text(encoding="utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path.name, current_path.name,
               src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    temporary_path = None
    os.fsync(parent_fd)
finally:
    if temporary_fd is not None:
        os.close(temporary_fd)
    if temporary_path is not None:
        try: temporary_path.unlink()
        except FileNotFoundError: pass
    os.close(parent_fd)
PY
}

openclaw_stable_plugins_restore_config() {
  local transaction_root="$1" config_preexisted="$2" config_path config_parent restore_path
  config_path="$(openclaw_plugin_config_path)"
  [[ "${config_path}" == /* ]] || return 1
  config_parent="$(dirname -- "${config_path}")"
  restore_path="${config_path}.bridgesllm-stable-plugins-restore"

  if [[ -f "${transaction_root}/config-projection" \
    && ! -L "${transaction_root}/config-projection" ]]; then
    [[ "${config_preexisted}" == "true" ]] || return 1
    openclaw_stable_plugins_restore_config_projection \
      "${transaction_root}" "${config_path}"
    return $?
  fi

  if [[ "${config_preexisted}" == "true" ]]; then
    [[ -d "${config_parent}" && ! -L "${config_parent}" \
      && -f "${transaction_root}/openclaw.json.previous" \
      && ! -L "${transaction_root}/openclaw.json.previous" ]] || return 1
    if [[ -e "${restore_path}" || -L "${restore_path}" ]]; then
      [[ -f "${restore_path}" && ! -L "${restore_path}" ]] || return 1
      rm -f -- "${restore_path}" || return 1
    fi
    cp -a -- "${transaction_root}/openclaw.json.previous" "${restore_path}" || return 1
    openclaw_stable_plugins_fsync_file "${restore_path}" || return 1
    if [[ -e "${config_path}" || -L "${config_path}" ]]; then
      [[ -f "${config_path}" && ! -L "${config_path}" ]] || return 1
    fi
    mv -fT -- "${restore_path}" "${config_path}" || return 1
    openclaw_stable_plugins_fsync_directory "${config_parent}" || return 1
    cmp -s -- "${transaction_root}/openclaw.json.previous" "${config_path}"
  else
    [[ ! -e "${restore_path}" && ! -L "${restore_path}" ]] || return 1
    if [[ -e "${config_parent}" || -L "${config_parent}" ]]; then
      [[ -d "${config_parent}" && ! -L "${config_parent}" ]] || return 1
    fi
    if [[ -e "${config_path}" || -L "${config_path}" ]]; then
      [[ -f "${config_path}" && ! -L "${config_path}" ]] || return 1
      rm -f -- "${config_path}" || return 1
    fi
    if [[ -d "${config_parent}" && ! -L "${config_parent}" ]]; then
      openclaw_stable_plugins_fsync_directory "${config_parent}" || return 1
    fi
    [[ ! -e "${config_path}" && ! -L "${config_path}" ]]
  fi
}

openclaw_stable_plugins_finish_active_retirement() {
  local state_root="$1" transition="$2" decision
  local active="${state_root}/active" retired="${state_root}/retired"
  if [[ ! -e "${state_root}/cleanup-intent" \
    && ! -L "${state_root}/cleanup-intent" ]]; then
    [[ -d "${active}" && ! -L "${active}" \
      && ! -e "${retired}" && ! -L "${retired}" \
      && -f "${active}/decision" && ! -L "${active}/decision" ]] || return 1
    decision="$(<"${active}/decision")"
    [[ "${decision}" == "commit" || "${decision}" == "rolled-back" ]] || return 1
    openclaw_stable_plugins_write_cleanup_intent \
      "${state_root}" "${active}" "${decision}" || return 1
  fi
  openclaw_stable_plugins_resume_cleanup_intent "${state_root}" || return 1
  openclaw_stable_plugins_fault_inject "${transition}"
}

openclaw_stable_plugins_retire_active() {
  local state_root="$1" transition="$2" decision="$3"
  local active="${state_root}/active"
  [[ -d "${active}" && ! -L "${active}" ]] || return 1
  openclaw_stable_plugins_write_decision "${active}" "${decision}" || return 1
  openclaw_stable_plugins_fault_inject "after-decision:${decision}"
  openclaw_stable_plugins_finish_active_retirement "${state_root}" "${transition}"
}

openclaw_stable_plugins_expected_set() {
  local transaction_root="$1" verify_state="$2" line kind id package presence version extra
  local catalog_package status
  local -a lines=()
  local -A seen=()
  [[ -f "${transaction_root}/expected" && ! -L "${transaction_root}/expected" ]] \
    || return 1
  mapfile -t lines < "${transaction_root}/expected" || return 1
  (( ${#lines[@]} > 0 )) || return 1
  for line in "${lines[@]}"; do
    IFS='|' read -r kind id package presence version extra <<< "${line}"
    [[ "${kind}" == "expected" && "${id}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ \
      && -z "${seen[${id}]:-}" && -z "${extra}" ]] || return 1
    catalog_package="$(openclaw_stable_plugins_catalog_package "${id}")" || return 1
    [[ "${package}" == "${catalog_package}" ]] || return 1
    seen["${id}"]=true
    if [[ "${presence}" == "present" ]]; then
      [[ "${version}" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$ ]] || return 1
      if [[ "${verify_state}" == "true" ]]; then
        verify_openclaw_stable_plugin "${id}" "${package}" "${version}" || return 1
      fi
    else
      [[ "${presence}" == "absent" && "${version}" == "-" ]] || return 1
      if [[ "${verify_state}" == "true" ]]; then
        if openclaw_stable_plugin_present "${id}"; then
          return 1
        else
          status=$?
          [[ ${status} -eq 1 ]] || return 1
          openclaw_stable_plugin_absence_unclaimed "${id}" || return 1
        fi
      fi
    fi
  done
}

openclaw_stable_plugins_flush_committed_state() {
  local transaction_root="$1" config_path config_parent config_path_digest config_digest
  local line kind id package presence version extra details root_real
  local -a lines=() fields=() present_ids=()
  local -A flushed_roots=()

  openclaw_stable_plugins_expected_set "${transaction_root}" true || return 1
  config_path="$(openclaw_plugin_config_path)"
  [[ "${config_path}" == /* && -f "${config_path}" && ! -L "${config_path}" ]] \
    || return 1
  config_parent="$(dirname -- "${config_path}")"
  [[ -d "${config_parent}" && ! -L "${config_parent}" ]] || return 1
  config_path_digest="$(openclaw_stable_plugins_config_path_digest \
    "${config_path}")" || return 1
  config_digest="$(openclaw_stable_plugins_file_digest "${config_path}")" || return 1

  mapfile -t lines < "${transaction_root}/expected" || return 1
  for line in "${lines[@]}"; do
    IFS='|' read -r kind id package presence version extra <<< "${line}"
    [[ "${kind}" == "expected" && -z "${extra}" ]] || return 1
    [[ "${presence}" == "present" ]] || continue
    verify_openclaw_stable_plugin "${id}" "${package}" "${version}" || return 1
    details="$(openclaw_stable_plugin_details "${id}")" || return 1
    mapfile -t fields <<< "${details}"
    root_real="$(readlink -f -- "${fields[3]:-}" 2>/dev/null || true)"
    [[ -n "${root_real}" && -d "${root_real}" ]] || return 1
    flushed_roots["${id}"]="${root_real}"
    present_ids+=("${id}")
    openclaw_stable_plugins_fsync_tree "${root_real}" || return 1
    openclaw_stable_plugins_fsync_directory "$(dirname -- "${root_real}")" || return 1
  done
  openclaw_stable_plugins_fsync_file "${config_path}" || return 1
  openclaw_stable_plugins_fsync_directory "${config_parent}" || return 1

  openclaw_stable_plugins_expected_set "${transaction_root}" true || return 1
  for id in "${present_ids[@]}"; do
    details="$(openclaw_stable_plugin_details "${id}")" || return 1
    mapfile -t fields <<< "${details}"
    root_real="$(readlink -f -- "${fields[3]:-}" 2>/dev/null || true)"
    [[ "${root_real}" == "${flushed_roots[${id}]}" ]] || return 1
  done
  [[ -f "${config_path}" && ! -L "${config_path}" \
    && "$(openclaw_stable_plugins_file_digest "${config_path}")" \
      == "${config_digest}" ]] || return 1
  openclaw_stable_plugins_write_committed_config \
    "${transaction_root}" "${config_path_digest}" "${config_digest}" || return 1
  openclaw_stable_plugins_verify_committed "${transaction_root}"
}

openclaw_stable_plugins_verify_committed() {
  local transaction_root="$1" kind schema expected_digest extra
  local config_state manifest_config_path_digest config_backup_digest
  local managed_state managed_path_digest inventory_digest managed_entries managed_bytes
  local database_path_digest index_snapshot_digest managed_root database
  local config_path config_path_digest receipt_config_path_digest committed_config_digest
  local actual_config_digest attempted_text verified_text
  local -a lines=() receipt_lines=()
  openclaw_stable_plugins_secure_directory "${transaction_root}" || return 1
  [[ -f "${transaction_root}/manifest" && ! -L "${transaction_root}/manifest" \
    && -f "${transaction_root}/expected" && ! -L "${transaction_root}/expected" \
    && -f "${transaction_root}/attempted" && ! -L "${transaction_root}/attempted" \
    && -f "${transaction_root}/verified" && ! -L "${transaction_root}/verified" \
    && -f "${transaction_root}/committed-config" \
    && ! -L "${transaction_root}/committed-config" \
    && ! -e "${transaction_root}/committed-config.next" \
    && ! -L "${transaction_root}/committed-config.next" ]] \
    || return 1
  attempted_text="$(<"${transaction_root}/attempted")"
  verified_text="$(<"${transaction_root}/verified")"
  [[ "${attempted_text}" =~ ^[1-9][0-9]*$ \
    && "${verified_text}" == "${attempted_text}" ]] || return 1
  mapfile -t lines < "${transaction_root}/manifest" || return 1
  (( ${#lines[@]} >= 6 )) || return 1
  IFS='|' read -r kind schema extra <<< "${lines[0]}"
  [[ "${kind}" == "schema" \
    && "${schema}" == "${OPENCLAW_STABLE_PLUGIN_TRANSACTION_SCHEMA}" \
    && -z "${extra}" ]] || return 1
  IFS='|' read -r kind config_state manifest_config_path_digest \
    config_backup_digest extra <<< "${lines[1]}"
  [[ "${kind}" == "config" \
    && ( "${config_state}" == "present" || "${config_state}" == "absent" ) \
    && "${manifest_config_path_digest}" =~ ^[0-9a-f]{128}$ \
    && ( "${config_backup_digest}" == "-" \
      || "${config_backup_digest}" =~ ^[0-9a-f]{128}$ ) \
    && -z "${extra}" ]] || return 1
  IFS='|' read -r kind managed_state managed_path_digest inventory_digest \
    managed_entries managed_bytes extra <<< "${lines[2]}"
  [[ "${kind}" == "managed-root" \
    && ( "${managed_state}" == "present" || "${managed_state}" == "absent" ) \
    && "${managed_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${inventory_digest}" =~ ^[0-9a-f]{128}$ \
    && "${managed_entries}" =~ ^[0-9]+$ && "${managed_bytes}" =~ ^[0-9]+$ \
    && -z "${extra}" \
    && -f "${transaction_root}/managed-npm.previous.inventory" \
    && ! -L "${transaction_root}/managed-npm.previous.inventory" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/managed-npm.previous.inventory")" == "${inventory_digest}" ]] \
    || return 1
  if [[ "${managed_state}" == "present" ]]; then
    [[ -d "${transaction_root}/managed-npm.previous" \
      && ! -L "${transaction_root}/managed-npm.previous" ]] || return 1
    openclaw_stable_plugins_verify_tree_snapshot \
      "${transaction_root}/managed-npm.previous" \
      "${transaction_root}/managed-npm.previous.inventory" || return 1
  else
    [[ ! -e "${transaction_root}/managed-npm.previous" \
      && ! -L "${transaction_root}/managed-npm.previous" ]] || return 1
  fi
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  [[ "$(openclaw_stable_plugins_config_path_digest "${managed_root}")" \
    == "${managed_path_digest}" ]] || return 1
  IFS='|' read -r kind database_path_digest index_snapshot_digest extra \
    <<< "${lines[3]}"
  [[ "${kind}" == "installed-index" \
    && "${database_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${index_snapshot_digest}" =~ ^[0-9a-f]{128}$ && -z "${extra}" \
    && -f "${transaction_root}/installed-index.previous.json" \
    && ! -L "${transaction_root}/installed-index.previous.json" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/installed-index.previous.json")" == "${index_snapshot_digest}" ]] \
    || return 1
  database="$(openclaw_stable_plugins_database_path)" || return 1
  [[ "$(openclaw_stable_plugins_config_path_digest "${database}")" \
    == "${database_path_digest}" ]] || return 1
  IFS='|' read -r kind expected_digest extra <<< "${lines[4]}"
  [[ "${kind}" == "expected" && "${expected_digest}" =~ ^[0-9a-f]{128}$ \
    && -z "${extra}" \
    && "$(openclaw_stable_plugins_file_digest "${transaction_root}/expected")" \
      == "${expected_digest}" ]] || return 1
  mapfile -t receipt_lines < "${transaction_root}/committed-config" || return 1
  (( ${#receipt_lines[@]} == 1 )) || return 1
  IFS='|' read -r kind receipt_config_path_digest committed_config_digest extra \
    <<< "${receipt_lines[0]}"
  [[ "${kind}" == "config" \
    && "${receipt_config_path_digest}" == "${manifest_config_path_digest}" \
    && "${committed_config_digest}" =~ ^[0-9a-f]{128}$ \
    && -z "${extra}" ]] || return 1
  config_path="$(openclaw_plugin_config_path)"
  [[ "${config_path}" == /* && -f "${config_path}" && ! -L "${config_path}" ]] \
    || return 1
  config_path_digest="$(openclaw_stable_plugins_config_path_digest \
    "${config_path}")" || return 1
  [[ "${config_path_digest}" == "${receipt_config_path_digest}" ]] || return 1
  actual_config_digest="$(openclaw_stable_plugins_file_digest "${config_path}")" \
    || return 1
  if [[ "${actual_config_digest}" != "${committed_config_digest}" ]]; then
    [[ "${openclaw_stable_plugins_commit_action:-false}" == "true" \
      && "${OPENCLAW_STABLE_PLUGIN_CATALOG:-}" == "portal" \
      && "${OPENCLAW_STABLE_PLUGINS_COMMIT_CONFIG_SHA512:-}" =~ ^[0-9a-f]{128}$ \
      && "${actual_config_digest}" == "${OPENCLAW_STABLE_PLUGINS_COMMIT_CONFIG_SHA512}" ]] || return 1
  fi
  openclaw_stable_plugins_expected_set "${transaction_root}" true
}

openclaw_stable_plugins_recover_transaction() {
  local transaction_root="$1" state_root config_path database managed_root
  local kind schema extra config_state config_path_digest config_backup_digest
  local managed_state managed_path_digest inventory_digest managed_entries managed_bytes
  local database_path_digest index_snapshot_digest expected_digest attempted_text verified_text decision
  local line index id package desired_version desired_integrity desired_file baseline_present
  local baseline_version baseline_integrity baseline_file catalog_package
  local -a lines=()
  local -A seen=()
  local plugin_count=0

  openclaw_stable_plugins_secure_directory "${transaction_root}" || return 1
  [[ -f "${transaction_root}/manifest" && ! -L "${transaction_root}/manifest" \
    && -f "${transaction_root}/attempted" && ! -L "${transaction_root}/attempted" \
    && -f "${transaction_root}/verified" && ! -L "${transaction_root}/verified" \
    && -f "${transaction_root}/expected" && ! -L "${transaction_root}/expected" \
    && -f "${transaction_root}/managed-npm.previous.inventory" \
    && ! -L "${transaction_root}/managed-npm.previous.inventory" \
    && -f "${transaction_root}/installed-index.previous.json" \
    && ! -L "${transaction_root}/installed-index.previous.json" ]] || return 1
  for extra in attempted.next verified.next decision decision.next committed-config committed-config.next; do
    if [[ -e "${transaction_root}/${extra}" || -L "${transaction_root}/${extra}" ]]; then
      [[ -f "${transaction_root}/${extra}" && ! -L "${transaction_root}/${extra}" ]] \
        || return 1
    fi
  done
  if [[ -f "${transaction_root}/decision" ]]; then
    decision="$(<"${transaction_root}/decision")"
    [[ "${decision}" == "commit" || "${decision}" == "rolled-back" ]] || return 1
    # Never reinterpret a durable commit as rollback after later drift.
    [[ "${decision}" != "commit" ]] || return 1
  fi

  mapfile -t lines < "${transaction_root}/manifest" || return 1
  (( ${#lines[@]} >= 6 )) || return 1
  IFS='|' read -r kind schema extra <<< "${lines[0]}"
  [[ "${kind}" == "schema" && "${schema}" == "${OPENCLAW_STABLE_PLUGIN_TRANSACTION_SCHEMA}" \
    && -z "${extra}" ]] || return 1
  IFS='|' read -r kind config_state config_path_digest config_backup_digest extra \
    <<< "${lines[1]}"
  [[ "${kind}" == "config" \
    && ( "${config_state}" == "present" || "${config_state}" == "absent" ) \
    && "${config_path_digest}" =~ ^[0-9a-f]{128}$ \
    && ( "${config_backup_digest}" == "-" \
      || "${config_backup_digest}" =~ ^[0-9a-f]{128}$ ) && -z "${extra}" ]] || return 1
  IFS='|' read -r kind managed_state managed_path_digest inventory_digest \
    managed_entries managed_bytes extra <<< "${lines[2]}"
  [[ "${kind}" == "managed-root" \
    && ( "${managed_state}" == "present" || "${managed_state}" == "absent" ) \
    && "${managed_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${inventory_digest}" =~ ^[0-9a-f]{128}$ \
    && "${managed_entries}" =~ ^[0-9]+$ && "${managed_bytes}" =~ ^[0-9]+$ \
    && -z "${extra}" ]] || return 1
  IFS='|' read -r kind database_path_digest index_snapshot_digest extra <<< "${lines[3]}"
  [[ "${kind}" == "installed-index" \
    && "${database_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${index_snapshot_digest}" =~ ^[0-9a-f]{128}$ && -z "${extra}" ]] || return 1
  IFS='|' read -r kind expected_digest extra <<< "${lines[4]}"
  [[ "${kind}" == "expected" && "${expected_digest}" =~ ^[0-9a-f]{128}$ \
    && -z "${extra}" ]] || return 1

  config_path="$(openclaw_plugin_config_path)" || return 1
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  database="$(openclaw_stable_plugins_database_path)" || return 1
  [[ "$(openclaw_stable_plugins_config_path_digest "${config_path}")" \
      == "${config_path_digest}" \
    && "$(openclaw_stable_plugins_config_path_digest "${managed_root}")" \
      == "${managed_path_digest}" \
    && "$(openclaw_stable_plugins_config_path_digest "${database}")" \
      == "${database_path_digest}" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/managed-npm.previous.inventory")" == "${inventory_digest}" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/installed-index.previous.json")" == "${index_snapshot_digest}" \
    && "$(openclaw_stable_plugins_file_digest "${transaction_root}/expected")" \
      == "${expected_digest}" ]] || return 1
  if [[ "${config_state}" == "present" ]]; then
    [[ -f "${transaction_root}/openclaw.json.previous" \
      && ! -L "${transaction_root}/openclaw.json.previous" \
      && "$(openclaw_stable_plugins_file_digest \
        "${transaction_root}/openclaw.json.previous")" == "${config_backup_digest}" ]] \
      || return 1
  else
    [[ "${config_backup_digest}" == "-" \
      && ! -e "${transaction_root}/openclaw.json.previous" \
      && ! -L "${transaction_root}/openclaw.json.previous" ]] || return 1
  fi
  openclaw_stable_plugins_expected_set "${transaction_root}" false || return 1

  for (( index=5; index<${#lines[@]}; index++ )); do
    line="${lines[index]}"
    IFS='|' read -r kind id package desired_version desired_integrity desired_file \
      baseline_present baseline_version baseline_integrity baseline_file extra <<< "${line}"
    [[ "${kind}" == "plugin" && "${id}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ \
      && -z "${seen[${id}]:-}" && -z "${extra}" \
      && "${desired_file}" == "desired-${id}.tgz" \
      && -f "${transaction_root}/${desired_file}" \
      && ! -L "${transaction_root}/${desired_file}" ]] || return 1
    catalog_package="$(openclaw_stable_plugins_catalog_package "${id}")" || return 1
    [[ "${package}" == "${catalog_package}" ]] || return 1
    verify_openclaw_plugin_archive "${transaction_root}/${desired_file}" \
      "${package}" "${desired_version}" "${desired_integrity}" || return 1
    if [[ "${baseline_present}" == "true" ]]; then
      [[ "${baseline_version}" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$ \
        && "${baseline_integrity}" == sha512-* \
        && "${baseline_file}" == "baseline-${id}.tgz" \
        && -f "${transaction_root}/${baseline_file}" \
        && ! -L "${transaction_root}/${baseline_file}" ]] || return 1
      verify_openclaw_plugin_archive "${transaction_root}/${baseline_file}" \
        "${package}" "${baseline_version}" "${baseline_integrity}" || return 1
    else
      [[ "${baseline_present}" == "false" && "${baseline_version}" == "-" \
        && "${baseline_integrity}" == "-" && "${baseline_file}" == "-" ]] || return 1
    fi
    seen["${id}"]=true
    plugin_count=$((plugin_count + 1))
  done
  (( plugin_count > 0 )) || return 1
  attempted_text="$(<"${transaction_root}/attempted")"
  verified_text="$(<"${transaction_root}/verified")"
  [[ "${attempted_text}" =~ ^[0-9]+$ && "${verified_text}" =~ ^[0-9]+$ \
    && $((10#${verified_text})) -le $((10#${attempted_text})) \
    && $((10#${attempted_text})) -le ${plugin_count} \
    && $((10#${attempted_text} - 10#${verified_text})) -le 1 ]] || return 1

  # Config and installed-index foreign-drift checks run before the first
  # rollback mutation. Managed-root restoration performs its tree check at the
  # swap boundary because a resumed swap may legitimately have moved the live
  # root to its sealed quarantine sibling already.
  openclaw_stable_plugins_assert_owned_config_drift \
    "${transaction_root}/openclaw.json.previous" \
    "$([[ "${config_state}" == "present" ]] && printf true || printf false)" \
    "${config_path}" "${transaction_root}/manifest" || return 1
  openclaw_stable_plugins_restore_installed_index \
    "${database}" "${transaction_root}/installed-index.previous.json" \
    "${transaction_root}/manifest" check || return 1

  if [[ -e "${transaction_root}/attempted.next" \
    || -L "${transaction_root}/attempted.next" ]]; then
    rm -f -- "${transaction_root}/attempted.next" || return 1
    openclaw_stable_plugins_fsync_directory "${transaction_root}" || return 1
  fi
  if [[ -e "${transaction_root}/verified.next" \
    || -L "${transaction_root}/verified.next" ]]; then
    rm -f -- "${transaction_root}/verified.next" || return 1
    openclaw_stable_plugins_fsync_directory "${transaction_root}" || return 1
  fi
  openclaw_stable_plugins_restore_managed_root \
    "${transaction_root}" "${managed_state}" || return 1
  openclaw_stable_plugins_fault_inject 'after-managed-state-restore'
  openclaw_stable_plugins_restore_config "${transaction_root}" \
    "$([[ "${config_state}" == "present" ]] && printf true || printf false)" || return 1
  openclaw_stable_plugins_fault_inject 'after-config-restore'
  openclaw_stable_plugins_restore_installed_index \
    "${database}" "${transaction_root}/installed-index.previous.json" \
    "${transaction_root}/manifest" restore || return 1
  openclaw_stable_plugins_fault_inject 'after-installed-index-restore'
  state_root="$(dirname -- "${transaction_root}")"
  openclaw_stable_plugins_retire_active \
    "${state_root}" 'after-recovery-retire' 'rolled-back'
}

openclaw_stable_plugins_assert_clean_state() {
  local transaction_parent="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}" state_root entry
  if find "${transaction_parent}" -mindepth 1 -maxdepth 1 \
      -name '.stable-plugins.*' -print -quit | grep -q .; then
    printf 'A legacy OpenClaw plugin transaction requires manual recovery under %s.\n' \
      "${transaction_parent}" >&2
    return 1
  fi
  state_root="${transaction_parent}/openclaw-stable-plugins"
  [[ ! -e "${state_root}" && ! -L "${state_root}" ]] && return 0
  openclaw_stable_plugins_secure_directory "${state_root}" || return 1
  while IFS= read -r -d '' entry; do
    printf 'An unfinished OpenClaw plugin transaction blocks verification: %s\n' \
      "${entry}" >&2
    return 1
  done < <(find "${state_root}" -mindepth 1 -maxdepth 1 -print0)
}

openclaw_stable_plugins_settle_state() {
  local transaction_parent="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}" state_root
  local active retired entry name decision
  if find "${transaction_parent}" -mindepth 1 -maxdepth 1 \
      -name '.stable-plugins.*' -print -quit | grep -q .; then
    printf 'A legacy OpenClaw plugin transaction requires manual recovery under %s.\n' \
      "${transaction_parent}" >&2
    return 1
  fi
  state_root="${transaction_parent}/openclaw-stable-plugins"
  if [[ ! -e "${state_root}" && ! -L "${state_root}" ]]; then
    install -d -m 0700 "${state_root}" || return 1
    openclaw_stable_plugins_fsync_directory "${transaction_parent}" || return 1
  fi
  openclaw_stable_plugins_secure_directory "${state_root}" || return 1
  active="${state_root}/active"
  retired="${state_root}/retired"
  [[ ! ( ( -e "${active}" || -L "${active}" ) \
    && ( -e "${retired}" || -L "${retired}" ) ) ]] || return 1

  if [[ -e "${state_root}/cleanup-intent" \
    || -L "${state_root}/cleanup-intent" ]]; then
    [[ -f "${state_root}/cleanup-intent" \
      && ! -L "${state_root}/cleanup-intent" ]] || return 1
    openclaw_stable_plugins_resume_cleanup_intent "${state_root}" || return 1
  fi

  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    case "${name}" in
      active|retired|cleanup-intent) ;;
      prepare.*)
        openclaw_stable_plugins_remove_tree "${entry}" || return 1
        ;;
      *)
        printf 'Unknown OpenClaw plugin transaction state entry: %s\n' "${entry}" >&2
        return 1
        ;;
    esac
  done < <(find "${state_root}" -mindepth 1 -maxdepth 1 -print0)

  if [[ -e "${retired}" || -L "${retired}" ]]; then
    openclaw_stable_plugins_secure_directory "${retired}" || return 1
    [[ -f "${retired}/decision" && ! -L "${retired}/decision" ]] || return 1
    decision="$(<"${retired}/decision")"
    [[ "${decision}" == "commit" || "${decision}" == "rolled-back" ]] || return 1
    if [[ "${decision}" == "commit" ]]; then
      if [[ -e "${retired}/decision.next" || -L "${retired}/decision.next" ]] \
        || ! openclaw_stable_plugins_verify_committed "${retired}"; then
        printf 'Committed OpenClaw plugin transaction needs manual review at %s.\n' \
          "${retired}" >&2
        return 1
      fi
      openclaw_stable_plugins_remove_tree "${retired}" || return 1
    else
      mv -- "${retired}" "${active}" || return 1
      openclaw_stable_plugins_fsync_directory "${state_root}" || return 1
    fi
  fi
  if [[ -e "${active}" || -L "${active}" ]]; then
    openclaw_stable_plugins_secure_directory "${active}" || return 1
    if [[ -e "${active}/decision.next" || -L "${active}/decision.next" ]] \
      && [[ ! -e "${active}/decision" && ! -L "${active}/decision" ]]; then
      [[ -f "${active}/decision.next" && ! -L "${active}/decision.next" ]] \
        || return 1
      decision="$(<"${active}/decision.next")"
      [[ "${decision}" == "commit" || "${decision}" == "rolled-back" ]] \
        || return 1
      if [[ "${decision}" == "commit" ]]; then
        openclaw_stable_plugins_verify_committed "${active}" || return 1
      fi
      openclaw_stable_plugins_write_decision "${active}" "${decision}" || return 1
    fi
    if [[ -e "${active}/decision" || -L "${active}/decision" ]]; then
      [[ -f "${active}/decision" && ! -L "${active}/decision" ]] || return 1
      decision="$(<"${active}/decision")"
      [[ "${decision}" == "commit" || "${decision}" == "rolled-back" ]] || return 1
      if [[ "${decision}" == "commit" ]]; then
        if [[ -e "${active}/decision.next" || -L "${active}/decision.next" ]] \
          || ! openclaw_stable_plugins_verify_committed "${active}"; then
          printf 'Committed OpenClaw plugin transaction needs manual review at %s.\n' \
            "${active}" >&2
          return 1
        fi
        openclaw_stable_plugins_finish_active_retirement \
          "${state_root}" 'after-commit-retire' || return 1
      fi
    fi
  fi
  if [[ -e "${active}" || -L "${active}" ]]; then
    if ! openclaw_stable_plugins_recover_transaction "${active}"; then
      printf 'OpenClaw plugin recovery needs manual review at %s.\n' "${active}" >&2
      return 1
    fi
  fi
  openclaw_stable_plugins_fault_inject 'after-state-recovery'
}

openclaw_stable_plugins_verify() {
  local id package version integrity policy status
  while IFS='|' read -r id package version integrity policy; do
    if [[ "${policy}" == "existing" ]]; then
      if openclaw_stable_plugin_present "${id}"; then
        :
      else
        status=$?
        [[ ${status} -eq 1 ]] || return 1
        continue
      fi
    fi
    verify_openclaw_stable_plugin "${id}" "${package}" "${version}" || return 1
  done < <(openclaw_stable_plugin_rows)
}

openclaw_stable_plugins_converge_locked() {
  local transaction_parent="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}"
  local state_root prepare active config_path config_parent config_backup config_digest
  local config_backup_digest="-" baseline_integrity expected_digest
  local config_preexisted=false preparation_ok=true convergence_ok=true
  local id package version integrity policy details status root baseline_version archive
  local index plan_count=0 attempted=0
  local -a fields=() ids=() packages=() versions=() integrities=() policies=()
  local -A baseline_present=() baseline_versions=() baseline_roots=() planned=() catalog_seen=()

  openclaw_stable_plugins_settle_state || return 1
  state_root="${transaction_parent}/openclaw-stable-plugins"
  active="${state_root}/active"

  while IFS='|' read -r id package version integrity policy; do
    [[ "${id}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ \
      && "${package}" =~ ^@[a-z0-9-]+/[a-z0-9-]+$ \
      && "${version}" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$ \
      && "${integrity}" == sha512-* \
      && ( "${policy}" == "required" || "${policy}" == "existing" ) \
      && -z "${catalog_seen[${id}]:-}" ]] || return 1
    catalog_seen["${id}"]=true
    ids+=("${id}"); packages+=("${package}"); versions+=("${version}")
    integrities+=("${integrity}"); policies+=("${policy}")
  done < <(openclaw_stable_plugin_rows)
  (( ${#ids[@]} > 0 )) || return 1

  for (( index=0; index<${#ids[@]}; index++ )); do
    id="${ids[index]}"; package="${packages[index]}"; version="${versions[index]}"
    policy="${policies[index]}"
    if details="$(openclaw_stable_plugin_details "${id}")"; then
      mapfile -t fields <<< "${details}"
      root="${fields[3]:-}"
      baseline_version="${fields[2]:-}"
      [[ "${fields[0]:-}" == "${id}" && "${fields[1]:-}" == "${package}" \
        && "${baseline_version}" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$ \
        && -d "${root}" ]] || {
          printf 'Could not prove the installed %s plugin baseline identity.\n' "${id}" >&2
          return 1
        }
      verify_openclaw_plugin_identity "${id}" "${package}" "${baseline_version}" || {
        printf 'Could not bind the installed %s plugin to its package root.\n' "${id}" >&2
        return 1
      }
      baseline_present["${id}"]=true
      baseline_versions["${id}"]="${baseline_version}"
      baseline_roots["${id}"]="${root}"
      if verify_openclaw_stable_plugin "${id}" "${package}" "${version}" \
        && ! { [[ "${OPENCLAW_STABLE_PLUGINS_PREPARE_ONLY:-0}" == "1" \
          && "${id}" == "codex" ]]; }; then
        continue
      fi
    else
      if openclaw_stable_plugin_present "${id}"; then
        printf 'Could not inspect the present %s plugin baseline.\n' "${id}" >&2
        return 1
      else
        status=$?
        [[ ${status} -eq 1 ]] || {
          printf 'Could not prove whether OpenClaw plugin %s is installed.\n' "${id}" >&2
          return 1
        }
        openclaw_stable_plugin_absence_unclaimed "${id}" || {
          printf 'OpenClaw plugin %s has ambiguous residual install authority.\n' "${id}" >&2
          return 1
        }
      fi
      baseline_present["${id}"]=false
      [[ "${policy}" == "required" ]] || continue
    fi
    planned["${id}"]=true
    plan_count=$((plan_count + 1))
  done

  if (( plan_count == 0 )); then
    openclaw_stable_plugins_verify || return 1
    printf 'OpenClaw stable plugin set verified (0 changed; gateway restart deferred).\n'
    return 0
  fi

  prepare="$(mktemp -d "${state_root}/prepare.XXXXXXXX")" || return 1
  chmod 0700 "${prepare}" || return 1
  for (( index=0; index<${#ids[@]}; index++ )); do
    id="${ids[index]}"; package="${packages[index]}"; version="${versions[index]}"
    integrity="${integrities[index]}"
    [[ "${planned[${id}]:-false}" == "true" ]] || continue
    if [[ "${baseline_present[${id}]}" == "true" ]]; then
      archive="$(pack_openclaw_plugin_baseline \
        "${baseline_roots[${id}]}" "${package}" "${baseline_versions[${id}]}" \
        "${prepare}")" || preparation_ok=false
      if ${preparation_ok}; then
        mv -- "${archive}" "${prepare}/baseline-${id}.tgz" || preparation_ok=false
      fi
    fi
    ${preparation_ok} || break
    archive="$(download_openclaw_stable_plugin \
      "${package}" "${version}" "${integrity}" "${prepare}")" || preparation_ok=false
    if ${preparation_ok}; then
      mv -- "${archive}" "${prepare}/desired-${id}.tgz" || preparation_ok=false
    fi
    ${preparation_ok} || break
  done
  if ! ${preparation_ok}; then
    printf 'Could not preserve baselines and acquire every attested plugin artifact.\n' >&2
    openclaw_stable_plugins_remove_tree "${prepare}" || true
    return 1
  fi

  for (( index=0; index<${#ids[@]}; index++ )); do
    id="${ids[index]}"; package="${packages[index]}"
    [[ "${planned[${id}]:-false}" == "true" ]] || continue
    if [[ "${baseline_present[${id}]}" == "true" ]]; then
      verify_openclaw_plugin_identity \
        "${id}" "${package}" "${baseline_versions[${id}]}" || preparation_ok=false
    elif openclaw_stable_plugin_present "${id}"; then
      preparation_ok=false
    else
      status=$?
      [[ ${status} -eq 1 ]] || preparation_ok=false
      if ${preparation_ok} \
        && ! openclaw_stable_plugin_absence_unclaimed "${id}"; then
        preparation_ok=false
      fi
    fi
    ${preparation_ok} || break
  done
  if ! ${preparation_ok}; then
    printf 'OpenClaw plugin baselines changed while the transaction was prepared.\n' >&2
    openclaw_stable_plugins_remove_tree "${prepare}" || true
    return 1
  fi

  config_path="$(openclaw_plugin_config_path)"
  [[ "${config_path}" == /* ]] || preparation_ok=false
  config_parent="$(dirname -- "${config_path}")"
  config_backup="${prepare}/openclaw.json.previous"
  if [[ ( -e "${config_parent}" || -L "${config_parent}" ) \
    && ! ( -d "${config_parent}" && ! -L "${config_parent}" ) ]]; then
    preparation_ok=false
  fi
  if [[ -f "${config_path}" && ! -L "${config_path}" \
    && -d "${config_parent}" && ! -L "${config_parent}" ]]; then
    cp -a -- "${config_path}" "${config_backup}" || preparation_ok=false
    config_preexisted=true
  elif [[ -e "${config_path}" || -L "${config_path}" ]]; then
    preparation_ok=false
  fi
  if [[ -e "${config_path}.bridgesllm-stable-plugins-restore" \
    || -L "${config_path}.bridgesllm-stable-plugins-restore" ]]; then
    preparation_ok=false
  fi
  if ! ${preparation_ok}; then
    printf 'OpenClaw config cannot be snapshotted without ambiguity: %s\n' "${config_path}" >&2
    openclaw_stable_plugins_remove_tree "${prepare}" || true
    return 1
  fi
  config_digest="$(openclaw_stable_plugins_config_path_digest "${config_path}")" || return 1
  if ${config_preexisted}; then
    config_backup_digest="$(openclaw_stable_plugins_file_digest "${config_backup}")" || return 1
    if [[ "$(openclaw_stable_plugins_file_digest "${config_path}")" \
      != "${config_backup_digest}" ]]; then
      printf 'OpenClaw config changed while its rollback snapshot was prepared.\n' >&2
      openclaw_stable_plugins_remove_tree "${prepare}" || true
      return 1
    fi
  fi
  if [[ "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE:-full}" == "codex-projection" \
    || "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE:-full}" == "portal-projection" ]]; then
    [[ "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE}" == "${OPENCLAW_STABLE_PLUGIN_CATALOG}-projection" \
      && "${config_preexisted}" == "true" ]] || {
      printf 'Codex projection custody requires one preexisting OpenClaw config.\n' >&2
      openclaw_stable_plugins_remove_tree "${prepare}" || true
      return 1
    }
    printf '%s\n' "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE}" > "${prepare}/config-projection" || return 1
  elif [[ "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE:-full}" != "full" ]]; then
    printf 'Unknown OpenClaw plugin config custody mode.\n' >&2
    openclaw_stable_plugins_remove_tree "${prepare}" || true
    return 1
  fi
  if ! openclaw_stable_plugins_prepare_outer_snapshot "${prepare}"; then
    printf 'Could not snapshot the complete managed plugin root and installed-index authority.\n' >&2
    openclaw_stable_plugins_remove_tree "${prepare}" || true
    return 1
  fi
  {
    for (( index=0; index<${#ids[@]}; index++ )); do
      id="${ids[index]}"; package="${packages[index]}"; policy="${policies[index]}"
      if [[ "${policy}" == "required" || "${baseline_present[${id}]}" == "true" ]]; then
        printf 'expected|%s|%s|present|%s\n' \
          "${id}" "${package}" "${versions[index]}"
      else
        printf 'expected|%s|%s|absent|-\n' "${id}" "${package}"
      fi
    done
  } > "${prepare}/expected" || return 1
  expected_digest="$(openclaw_stable_plugins_file_digest "${prepare}/expected")" || return 1
  {
    printf 'schema|%s\n' "${OPENCLAW_STABLE_PLUGIN_TRANSACTION_SCHEMA}"
    printf 'config|%s|%s|%s\n' \
      "$(${config_preexisted} && printf present || printf absent)" \
      "${config_digest}" "${config_backup_digest}"
    printf 'managed-root|%s|%s|%s|%s|%s\n' \
      "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[0]}" \
      "${OPENCLAW_PLUGIN_MANAGED_PATH_DIGEST}" \
      "${OPENCLAW_PLUGIN_MANAGED_INVENTORY_DIGEST}" \
      "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[1]}" \
      "${OPENCLAW_PLUGIN_MANAGED_STATE_FIELDS[2]}"
    printf 'installed-index|%s|%s\n' \
      "${OPENCLAW_PLUGIN_DATABASE_PATH_DIGEST}" \
      "${OPENCLAW_PLUGIN_INDEX_SNAPSHOT_DIGEST}"
    printf 'expected|%s\n' "${expected_digest}"
    for (( index=0; index<${#ids[@]}; index++ )); do
      id="${ids[index]}"; package="${packages[index]}"
      [[ "${planned[${id}]:-false}" == "true" ]] || continue
      if [[ "${baseline_present[${id}]}" == "true" ]]; then
        baseline_integrity="$(openclaw_stable_plugins_file_integrity \
          "${prepare}/baseline-${id}.tgz")" || return 1
        printf 'plugin|%s|%s|%s|%s|desired-%s.tgz|true|%s|%s|baseline-%s.tgz\n' \
          "${id}" "${package}" "${versions[index]}" "${integrities[index]}" "${id}" \
          "${baseline_versions[${id}]}" "${baseline_integrity}" "${id}"
      else
        printf 'plugin|%s|%s|%s|%s|desired-%s.tgz|false|-|-|-\n' \
          "${id}" "${package}" "${versions[index]}" "${integrities[index]}" "${id}"
      fi
    done
  } > "${prepare}/manifest" || return 1
  printf '0\n' > "${prepare}/attempted" || return 1
  printf '0\n' > "${prepare}/verified" || return 1
  if ! openclaw_stable_plugins_verify_outer_snapshot_current \
      "${prepare}" "${config_preexisted}"; then
    printf 'OpenClaw plugin state changed before the transaction was published.\n' >&2
    openclaw_stable_plugins_remove_tree "${prepare}" || true
    return 1
  fi
  openclaw_stable_plugins_fsync_tree "${prepare}" || return 1
  [[ ! -e "${active}" && ! -L "${active}" ]] || return 1
  mv -- "${prepare}" "${active}" || return 1
  openclaw_stable_plugins_fsync_directory "${state_root}" || return 1
  openclaw_stable_plugins_fault_inject 'after-publish'
  if [[ "${OPENCLAW_STABLE_PLUGINS_PREPARE_ONLY:-0}" == "1" ]]; then
    printf 'OpenClaw plugin rollback authority is durable at %s.\n' "${active}"
    return 0
  fi

  for (( index=0; index<${#ids[@]}; index++ )); do
    id="${ids[index]}"; package="${packages[index]}"; version="${versions[index]}"
    [[ "${planned[${id}]:-false}" == "true" ]] || continue
    attempted=$((attempted + 1))
    openclaw_stable_plugins_write_attempted "${active}" "${attempted}" \
      || { convergence_ok=false; break; }
    openclaw_stable_plugins_fault_inject "before-install:${id}"
    if ! OPENCLAW_ALLOW_ROOT=1 openclaw plugins install \
        "${package}@${version}" --force --pin --accept-capabilities \
        >/dev/null 2>&1 \
      || ! verify_openclaw_stable_plugin "${id}" "${package}" "${version}"; then
      printf 'OpenClaw plugin %s failed exact post-install verification.\n' "${id}" >&2
      convergence_ok=false
      break
    fi
    if ! openclaw_stable_plugins_write_verified "${active}" "${attempted}"; then
      convergence_ok=false
      break
    fi
    openclaw_stable_plugins_fault_inject "after-install:${id}"
  done

  if ${convergence_ok} \
    && { ! openclaw_stable_plugins_assert_owned_tree_drift \
          "${active}/managed-npm.previous" \
          "${active}/managed-npm.previous.inventory" \
          "$(openclaw_stable_plugins_managed_root)" "${active}/manifest" \
      || ! openclaw_stable_plugins_assert_owned_config_drift \
          "${active}/openclaw.json.previous" "${config_preexisted}" \
          "$(openclaw_plugin_config_path)" "${active}/manifest" \
      || ! openclaw_stable_plugins_restore_installed_index \
          "$(openclaw_stable_plugins_database_path)" \
          "${active}/installed-index.previous.json" "${active}/manifest" check; }; then
    printf 'OpenClaw plugin convergence observed foreign outer-state drift.\n' >&2
    convergence_ok=false
  fi
  if ${convergence_ok} && ! openclaw_stable_plugins_expected_set "${active}" true; then
    printf 'OpenClaw stable plugin set did not verify after convergence.\n' >&2
    convergence_ok=false
  fi
  if ${convergence_ok}; then
    openclaw_stable_plugins_fault_inject 'after-verify'
    if ! openclaw_stable_plugins_flush_committed_state "${active}"; then
      printf 'OpenClaw committed plugin state could not be flushed and reverified.\n' >&2
      convergence_ok=false
    fi
  fi
  if ! ${convergence_ok}; then
    if ! openclaw_stable_plugins_recover_transaction "${active}"; then
      printf 'OpenClaw plugin rollback needs manual recovery from %s.\n' "${active}" >&2
    fi
    return 1
  fi

  openclaw_stable_plugins_fault_inject 'after-product-flush'
  openclaw_stable_plugins_retire_active \
    "${state_root}" 'after-commit-retire' 'commit' || return 1
  printf 'OpenClaw stable plugin set verified (%s changed; gateway restart deferred).\n' "${plan_count}"
}

openclaw_stable_plugins_require_codex_held_mode() {
  local managed_root database
  [[ ( "${OPENCLAW_STABLE_PLUGIN_CATALOG:-}" == "codex" \
    || "${OPENCLAW_STABLE_PLUGIN_CATALOG:-}" == "portal" ) \
    && "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE:-}" == "${OPENCLAW_STABLE_PLUGIN_CATALOG}-projection" ]] \
    || return 1
  managed_root="$(openclaw_stable_plugins_managed_root)" || return 1
  database="$(openclaw_stable_plugins_database_path)" || return 1
  if [[ "${OPENCLAW_STABLE_PLUGINS_TESTING:-0}" != "1" ]]; then
    [[ "${managed_root}" == "/root/.openclaw/npm" \
      && "${database}" == "/root/.openclaw/state/openclaw.sqlite" ]] || return 1
  fi
}

openclaw_stable_plugins_validate_codex_held_journal() {
  local transaction_root="$1" expected_state="${2:-either}"
  local kind schema extra config_state config_path_digest config_backup_digest
  local managed_state managed_path_digest inventory_digest managed_entries managed_bytes
  local database_path_digest index_snapshot_digest expected_digest
  local id package version integrity desired baseline_present baseline_version
  local baseline_integrity baseline_file attempted verified
  local -a lines=() expected_lines=()

  openclaw_stable_plugins_require_codex_held_mode || return 1
  openclaw_stable_plugins_secure_directory "${transaction_root}" || return 1
  [[ -f "${transaction_root}/config-projection" \
    && ! -L "${transaction_root}/config-projection" \
    && "$(<"${transaction_root}/config-projection")" == "${OPENCLAW_STABLE_PLUGINS_CONFIG_MODE}" \
    && -f "${transaction_root}/manifest" && ! -L "${transaction_root}/manifest" \
    && -f "${transaction_root}/expected" && ! -L "${transaction_root}/expected" \
    && -f "${transaction_root}/attempted" && ! -L "${transaction_root}/attempted" \
    && -f "${transaction_root}/verified" && ! -L "${transaction_root}/verified" \
    && ! -e "${transaction_root}/decision" && ! -L "${transaction_root}/decision" \
    && ! -e "${transaction_root}/decision.next" && ! -L "${transaction_root}/decision.next" ]] \
    || return 1
  mapfile -t lines < "${transaction_root}/manifest" || return 1
  (( ${#lines[@]} >= 6 && ${#lines[@]} <= 10 )) || return 1
  if [[ "${OPENCLAW_STABLE_PLUGIN_CATALOG}" == "codex" ]]; then
    (( ${#lines[@]} == 6 )) || return 1
  fi
  IFS='|' read -r kind schema extra <<< "${lines[0]}"
  [[ "${kind}" == "schema" \
    && "${schema}" == "${OPENCLAW_STABLE_PLUGIN_TRANSACTION_SCHEMA}" \
    && -z "${extra}" ]] || return 1
  IFS='|' read -r kind config_state config_path_digest config_backup_digest extra \
    <<< "${lines[1]}"
  [[ "${kind}" == "config" && "${config_state}" == "present" \
    && "${config_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${config_backup_digest}" =~ ^[0-9a-f]{128}$ && -z "${extra}" \
    && -f "${transaction_root}/openclaw.json.previous" \
    && ! -L "${transaction_root}/openclaw.json.previous" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/openclaw.json.previous")" == "${config_backup_digest}" ]] \
    || return 1
  IFS='|' read -r kind managed_state managed_path_digest inventory_digest \
    managed_entries managed_bytes extra <<< "${lines[2]}"
  [[ "${kind}" == "managed-root" \
    && ( "${managed_state}" == "present" || "${managed_state}" == "absent" ) \
    && "${managed_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${inventory_digest}" =~ ^[0-9a-f]{128}$ \
    && "${managed_entries}" =~ ^[0-9]+$ && "${managed_bytes}" =~ ^[0-9]+$ \
    && -z "${extra}" \
    && -f "${transaction_root}/managed-npm.previous.inventory" \
    && ! -L "${transaction_root}/managed-npm.previous.inventory" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/managed-npm.previous.inventory")" == "${inventory_digest}" ]] \
    || return 1
  if [[ "${managed_state}" == "present" ]]; then
    [[ -d "${transaction_root}/managed-npm.previous" \
      && ! -L "${transaction_root}/managed-npm.previous" ]] || return 1
    openclaw_stable_plugins_verify_tree_snapshot \
      "${transaction_root}/managed-npm.previous" \
      "${transaction_root}/managed-npm.previous.inventory" || return 1
  else
    [[ ! -e "${transaction_root}/managed-npm.previous" \
      && ! -L "${transaction_root}/managed-npm.previous" ]] || return 1
  fi
  IFS='|' read -r kind database_path_digest index_snapshot_digest extra \
    <<< "${lines[3]}"
  [[ "${kind}" == "installed-index" \
    && "${database_path_digest}" =~ ^[0-9a-f]{128}$ \
    && "${index_snapshot_digest}" =~ ^[0-9a-f]{128}$ && -z "${extra}" \
    && -f "${transaction_root}/installed-index.previous.json" \
    && ! -L "${transaction_root}/installed-index.previous.json" \
    && "$(openclaw_stable_plugins_file_digest \
      "${transaction_root}/installed-index.previous.json")" == "${index_snapshot_digest}" ]] \
    || return 1
  IFS='|' read -r kind expected_digest extra <<< "${lines[4]}"
  [[ "${kind}" == "expected" && "${expected_digest}" =~ ^[0-9a-f]{128}$ \
    && -z "${extra}" \
    && "$(openclaw_stable_plugins_file_digest "${transaction_root}/expected")" \
      == "${expected_digest}" ]] || return 1
  mapfile -t expected_lines < "${transaction_root}/expected" || return 1
  local expected_id expected_package expected_version expected_integrity policy index line count=0
  local -A seen=()
  while IFS='|' read -r expected_id expected_package expected_version expected_integrity policy; do
    (( count < ${#expected_lines[@]} )) || return 1
    line="${expected_lines[count]}"
    if [[ "${policy}" == "required" ]]; then
      [[ "${line}" == "expected|${expected_id}|${expected_package}|present|${expected_version}" ]] || return 1
    else
      [[ "${line}" == "expected|${expected_id}|${expected_package}|present|${expected_version}" \
        || "${line}" == "expected|${expected_id}|${expected_package}|absent|-" ]] || return 1
    fi
    count=$((count + 1))
  done < <(openclaw_stable_plugin_rows)
  (( count == ${#expected_lines[@]} )) || return 1
  for (( index=5; index<${#lines[@]}; index++ )); do
    IFS='|' read -r kind id package version integrity desired baseline_present \
      baseline_version baseline_integrity baseline_file extra <<< "${lines[index]}"
    [[ "${kind}" == "plugin" && -z "${seen[${id}]:-}" \
      && "${package}" == "$(openclaw_stable_plugins_catalog_package "${id}")" \
      && "${version}" == "${OPENCLAW_STABLE_PLUGIN_VERSION}" \
      && "${integrity}" == "$(openclaw_stable_plugins_catalog_integrity "${id}")" \
      && "${desired}" == "desired-${id}.tgz" && -z "${extra}" \
      && -f "${transaction_root}/${desired}" && ! -L "${transaction_root}/${desired}" ]] || return 1
    [[ ${index} -ne 5 || "${id}" == "codex" ]] || return 1
    seen["${id}"]=true
    verify_openclaw_plugin_archive "${transaction_root}/${desired}" \
      "${package}" "${version}" "${integrity}" || return 1
    if [[ "${baseline_present}" == "true" ]]; then
      [[ "${baseline_version}" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$ \
        && "${baseline_integrity}" == sha512-* && "${baseline_file}" == "baseline-${id}.tgz" \
        && -f "${transaction_root}/${baseline_file}" && ! -L "${transaction_root}/${baseline_file}" ]] || return 1
      verify_openclaw_plugin_archive "${transaction_root}/${baseline_file}" \
        "${package}" "${baseline_version}" "${baseline_integrity}" || return 1
    else
      [[ "${baseline_present}" == "false" && "${baseline_version}" == "-" \
        && "${baseline_integrity}" == "-" && "${baseline_file}" == "-" ]] || return 1
    fi
  done
  count=$((${#lines[@]} - 5))
  attempted="$(<"${transaction_root}/attempted")"
  verified="$(<"${transaction_root}/verified")"
  [[ "${attempted}" =~ ^[0-5]$ && "${verified}" =~ ^[0-5]$ \
    && $((10#${verified})) -le $((10#${attempted})) \
    && $((10#${attempted})) -le ${count} ]] || return 1
  case "${expected_state}" in
    prepared)
      [[ "${attempted}" == "0" && "${verified}" == "0" \
        && ! -e "${transaction_root}/committed-config" \
        && ! -L "${transaction_root}/committed-config" ]] || return 1
      ;;
    committed)
      [[ "${attempted}" == "${count}" && "${verified}" == "${count}" ]] || return 1
      openclaw_stable_plugins_verify_committed "${transaction_root}" || return 1
      ;;
    either) ;;
    *) return 1 ;;
  esac
}

openclaw_stable_plugins_prepare_held_locked() {
  local state_root active
  openclaw_stable_plugins_require_codex_held_mode || return 1
  openclaw_stable_plugins_assert_clean_state || return 1
  OPENCLAW_STABLE_PLUGINS_PREPARE_ONLY=1 \
    openclaw_stable_plugins_converge_locked || return 1
  state_root="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}/openclaw-stable-plugins"
  active="${state_root}/active"
  openclaw_stable_plugins_validate_codex_held_journal "${active}" prepared
}

openclaw_stable_plugins_apply_held_locked() {
  local state_root active line kind id package version integrity desired
  local baseline_present baseline_version baseline_integrity baseline_file extra
  local attempted verified
  state_root="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}/openclaw-stable-plugins"
  active="${state_root}/active"
  openclaw_stable_plugins_require_codex_held_mode || return 1
  [[ -d "${active}" && ! -L "${active}" \
    && ! -e "${state_root}/retired" && ! -L "${state_root}/retired" ]] || return 1
  if openclaw_stable_plugins_validate_codex_held_journal "${active}" committed; then
    return 0
  fi
  openclaw_stable_plugins_validate_codex_held_journal "${active}" either || return 1
  attempted="$(<"${active}/attempted")"
  verified="$(<"${active}/verified")"
  [[ ! -e "${active}/committed-config" && ! -L "${active}/committed-config" ]] || return 1
  if [[ "${attempted}" == "0" ]]; then
    openclaw_stable_plugins_verify_outer_snapshot_current "${active}" true || return 1
  fi
  local index count
  local -a plan=()
  mapfile -t plan < <(tail -n +6 "${active}/manifest")
  count="${#plan[@]}"
  for (( index=verified; index<count; index++ )); do
    # A killed install may have changed only this journal's package set.
    openclaw_stable_plugins_assert_owned_tree_drift \
      "${active}/managed-npm.previous" "${active}/managed-npm.previous.inventory" \
      "$(openclaw_stable_plugins_managed_root)" "${active}/manifest" || return 1
    openclaw_stable_plugins_assert_owned_config_drift \
      "${active}/openclaw.json.previous" true \
      "$(openclaw_plugin_config_path)" "${active}/manifest" || return 1
    openclaw_stable_plugins_restore_installed_index \
      "$(openclaw_stable_plugins_database_path)" \
      "${active}/installed-index.previous.json" "${active}/manifest" check || return 1
    IFS='|' read -r kind id package version integrity desired baseline_present \
      baseline_version baseline_integrity baseline_file extra <<< "${plan[index]}"
    openclaw_stable_plugins_write_attempted "${active}" "$((index + 1))" || return 1
    openclaw_stable_plugins_fault_inject "before-install:${id}"
    if ! verify_openclaw_stable_plugin "${id}" "${package}" "${version}"; then
      OPENCLAW_ALLOW_ROOT=1 openclaw plugins install \
        "${package}@${version}" --force --pin --accept-capabilities >/dev/null || return 1
    fi
    verify_openclaw_stable_plugin "${id}" "${package}" "${version}" || return 1
    openclaw_stable_plugins_write_verified "${active}" "$((index + 1))" || return 1
    openclaw_stable_plugins_fault_inject "after-install:${id}"
  done
  openclaw_stable_plugins_assert_owned_tree_drift \
    "${active}/managed-npm.previous" "${active}/managed-npm.previous.inventory" \
    "$(openclaw_stable_plugins_managed_root)" "${active}/manifest" || return 1
  openclaw_stable_plugins_assert_owned_config_drift \
    "${active}/openclaw.json.previous" true \
    "$(openclaw_plugin_config_path)" "${active}/manifest" || return 1
  openclaw_stable_plugins_restore_installed_index \
    "$(openclaw_stable_plugins_database_path)" \
    "${active}/installed-index.previous.json" "${active}/manifest" check || return 1
  openclaw_stable_plugins_expected_set "${active}" true || return 1
  openclaw_stable_plugins_fault_inject 'after-verify'
  openclaw_stable_plugins_flush_committed_state "${active}" || return 1
  openclaw_stable_plugins_fault_inject 'after-product-flush'
}

openclaw_stable_plugins_held_binding_locked() {
  local state_root active baseline_present baseline_hash="" attempted verified
  state_root="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}/openclaw-stable-plugins"
  active="${state_root}/active"
  openclaw_stable_plugins_validate_codex_held_journal "${active}" either || return 1
  attempted="$(<"${active}/attempted")"; verified="$(<"${active}/verified")"
  if [[ "${attempted}" != "0" && "${verified}" == "${attempted}" ]]; then
    openclaw_stable_plugins_assert_owned_tree_drift \
      "${active}/managed-npm.previous" "${active}/managed-npm.previous.inventory" \
      "$(openclaw_stable_plugins_managed_root)" "${active}/manifest" || return 1
    openclaw_stable_plugins_assert_owned_config_drift \
      "${active}/openclaw.json.previous" true \
      "$(openclaw_plugin_config_path)" "${active}/manifest" || return 1
    openclaw_stable_plugins_restore_installed_index \
      "$(openclaw_stable_plugins_database_path)" \
      "${active}/installed-index.previous.json" "${active}/manifest" check || return 1
    openclaw_stable_plugins_verify_committed "${active}" || return 1
  elif [[ "${attempted}" != "0" || "${verified}" != "0" ]]; then
    return 1
  fi
  baseline_present="$(sed -n '6p' "${active}/manifest" | cut -d'|' -f7)" || return 1
  if [[ "${baseline_present}" == "true" ]]; then
    baseline_hash="$(openclaw_stable_plugins_file_digest \
      "${active}/baseline-codex.tgz")" || return 1
  elif [[ "${baseline_present}" != "false" ]]; then
    return 1
  fi
  python3 - \
    "$(openclaw_stable_plugins_file_digest "${active}/manifest")" \
    "$(openclaw_stable_plugins_file_digest "${active}/expected")" \
    "$(openclaw_stable_plugins_file_digest "${active}/managed-npm.previous.inventory")" \
    "$(openclaw_stable_plugins_file_digest "${active}/installed-index.previous.json")" \
    "$(openclaw_stable_plugins_file_digest "${active}/openclaw.json.previous")" \
    "$(openclaw_stable_plugins_file_digest "${active}/desired-codex.tgz")" \
    "${baseline_hash}" <<'PY'
import json
import sys

names = (
    "manifestSha512", "expectedSha512", "managedInventorySha512",
    "installedIndexSha512", "configBaselineSha512", "targetArchiveSha512",
)
payload = dict(zip(names, sys.argv[1:7]))
payload["baselineArchiveSha512"] = sys.argv[7] or None
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
PY
}

openclaw_stable_plugins_commit_held_locked() {
  local state_root active retired decision
  state_root="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}/openclaw-stable-plugins"
  active="${state_root}/active"; retired="${state_root}/retired"
  openclaw_stable_plugins_require_codex_held_mode || return 1
  if [[ -e "${state_root}/cleanup-intent" \
    || -L "${state_root}/cleanup-intent" ]]; then
    [[ -f "${state_root}/cleanup-intent" \
      && ! -L "${state_root}/cleanup-intent" ]] || return 1
    openclaw_stable_plugins_resume_cleanup_intent "${state_root}"
    return $?
  fi
  if [[ -d "${active}" && ! -L "${active}" ]]; then
    if [[ -e "${active}/decision.next" || -L "${active}/decision.next" ]] \
      && [[ ! -e "${active}/decision" && ! -L "${active}/decision" ]]; then
      [[ -f "${active}/decision.next" && ! -L "${active}/decision.next" \
        && "$(<"${active}/decision.next")" == "commit" ]] || return 1
      openclaw_stable_plugins_verify_committed "${active}" || return 1
      openclaw_stable_plugins_write_decision "${active}" commit || return 1
    fi
    if [[ -e "${active}/decision" || -L "${active}/decision" ]]; then
      [[ -f "${active}/decision" && ! -L "${active}/decision" \
        && "$(<"${active}/decision")" == "commit" ]] || return 1
      openclaw_stable_plugins_verify_committed "${active}" || return 1
      openclaw_stable_plugins_finish_active_retirement \
        "${state_root}" 'after-commit-retire'
      return $?
    fi
    openclaw_stable_plugins_validate_codex_held_journal "${active}" committed || return 1
    openclaw_stable_plugins_retire_active \
      "${state_root}" 'after-commit-retire' 'commit'
    return $?
  fi
  if [[ -d "${retired}" && ! -L "${retired}" ]]; then
    [[ -f "${retired}/decision" && ! -L "${retired}/decision" ]] || return 1
    decision="$(<"${retired}/decision")"
    [[ "${decision}" == "commit" ]] || return 1
    openclaw_stable_plugins_verify_committed "${retired}" || return 1
    openclaw_stable_plugins_remove_tree "${retired}" || return 1
    return 0
  fi
  [[ ! -e "${state_root}" || ( -d "${state_root}" && ! -L "${state_root}" ) ]]
}

openclaw_stable_plugins_rollback_held_locked() {
  local state_root
  openclaw_stable_plugins_require_codex_held_mode || return 1
  state_root="${OPENCLAW_STABLE_PLUGIN_TRANSACTION_PARENT}/openclaw-stable-plugins"
  if [[ ! -e "${state_root}" && ! -L "${state_root}" ]]; then
    return 0
  fi
  openclaw_stable_plugins_settle_state || return 1
  openclaw_stable_plugins_assert_clean_state
}

openclaw_stable_plugins_held_command() {
  local action="$1" result=0 command_name commit_config_path
  local openclaw_stable_plugins_commit_action=false
  [[ "${action}" != "commit-held" ]] || openclaw_stable_plugins_commit_action=true
  for command_name in openclaw npm node python3 openssl base64 flock sha512sum; do
    command -v "${command_name}" >/dev/null 2>&1 || return 1
  done
  # A verified Portal composite commit retires only the held recovery tree;
  # it must not require stopping the live gateway whose attestation authorized
  # that decision. The locked handler still verifies the exact config, plugin
  # set, journal and cleanup identities. All mutating lifecycle paths stay
  # behind the normal live-gateway refusal.
  if [[ "${action}" == "commit-held" \
    && "${OPENCLAW_STABLE_PLUGIN_CATALOG:-}" == "portal" \
    && "${OPENCLAW_STABLE_PLUGINS_QUIESCED:-0}" == "1" \
    && "${OPENCLAW_STABLE_PLUGINS_COMMIT_CONFIG_SHA512:-}" =~ ^[0-9a-f]{128}$ ]]; then
    openclaw_stable_plugins_require_codex_held_mode || return 1
    commit_config_path="$(openclaw_plugin_config_path)" || return 1
    [[ "$(openclaw_stable_plugins_file_digest "${commit_config_path}")" \
      == "${OPENCLAW_STABLE_PLUGINS_COMMIT_CONFIG_SHA512}" ]] || return 1
  else
    openclaw_stable_plugins_require_quiescence || return 1
  fi
  openclaw_stable_plugins_acquire_lock true || return 1
  case "${action}" in
    prepare-held) openclaw_stable_plugins_prepare_held_locked || result=$? ;;
    apply-held) openclaw_stable_plugins_apply_held_locked || result=$? ;;
    held-binding) openclaw_stable_plugins_held_binding_locked || result=$? ;;
    commit-held) openclaw_stable_plugins_commit_held_locked || result=$? ;;
    rollback-held) openclaw_stable_plugins_rollback_held_locked || result=$? ;;
    *) result=2 ;;
  esac
  openclaw_stable_plugins_release_lock
  return "${result}"
}

openclaw_stable_plugins_converge() {
  local command_name result=0
  for command_name in openclaw npm node python3 openssl base64 flock sha512sum; do
    command -v "${command_name}" >/dev/null 2>&1 || return 1
  done
  openclaw_stable_plugins_require_quiescence || return 1
  openclaw_stable_plugins_acquire_lock true || return 1
  openclaw_stable_plugins_converge_locked || result=$?
  openclaw_stable_plugins_release_lock
  return "${result}"
}

openclaw_stable_plugins_verify_command() {
  local lock_status result=0
  if openclaw_stable_plugins_acquire_lock false; then
    openclaw_stable_plugins_assert_clean_state || result=$?
    if (( result == 0 )); then
      openclaw_stable_plugins_verify || result=$?
    fi
    openclaw_stable_plugins_release_lock
    return "${result}"
  else
    lock_status=$?
    [[ ${lock_status} -eq 2 ]] || return "${lock_status}"
  fi
  openclaw_stable_plugins_verify
}

openclaw_stable_plugins_main() {
  case "${1:-verify}" in
    converge|install|update) openclaw_stable_plugins_converge ;;
    prepare-held|apply-held|held-binding|commit-held|rollback-held)
      openclaw_stable_plugins_held_command "$1"
      ;;
    verify|status) openclaw_stable_plugins_verify_command ;;
    *) printf 'Usage: %s {converge|prepare-held|apply-held|held-binding|commit-held|rollback-held|verify|status}\n' \
         "${0##*/}" >&2; return 2 ;;
  esac
}

if [[ "${OPENCLAW_STABLE_PLUGINS_SOURCE_ONLY:-0}" != "1" ]]; then
  openclaw_stable_plugins_main "$@"
fi
