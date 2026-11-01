#!/usr/bin/env bash
set -Eeuo pipefail

# Portal-qualified Hermes ACP runtime. The upstream convenience installer tracks
# main and can install optional components lazily. Portal instead installs one
# exact release-commit source tree, one exact uv release, one exact Python
# patch, and the repository's frozen dependency lock into a versioned root.
readonly HERMES_TESTED_VERSION="0.22.2"
readonly HERMES_TESTED_TAG="v0.22.2"
readonly HERMES_TESTED_COMMIT="d923a5eb487a17c0a68801bba9ef0f56c81040a8"
readonly HERMES_SOURCE_URL="https://api.github.com/repos/NousResearch/hermes-agent/tarball/d923a5eb487a17c0a68801bba9ef0f56c81040a8"
# GitHub regenerates auto-generated tag/commit tarballs: the gzip bytes and
# root directory can change while the exact commit tree remains identical.
# Pin a canonical SHA-256 over every regular file's relative path, executable
# mode, size and bytes instead of a mutable transport archive hash.
readonly HERMES_SOURCE_TREE_SHA256="6bd8d88ce4758357d926967676130eff96427515163608a7c51e4f459891cc89"
readonly HERMES_SOURCE_MAX_BYTES=$((96 * 1024 * 1024))
readonly HERMES_SOURCE_MAX_EXPANDED_BYTES=$((512 * 1024 * 1024))
# Members (files and directories) of the source tarball; toolctl's
# HERMES_SOURCE_MAX_ENTRIES is the same number. v0.22.5 (bf0203a794a0) has
# 22,045 (20,799 files, 87 MB compressed, 232 MB expanded). 60,000 is 2.7x that,
# so the byte limits above stay the first limit a growing release meets, while
# the archive's member index and the unpacked tree stay small.
readonly HERMES_SOURCE_MAX_ENTRIES=60000

readonly HERMES_UV_VERSION="0.12.5"
readonly HERMES_UV_SHA256_X86_64="68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2"
readonly HERMES_UV_SHA256_AARCH64="9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31"
readonly HERMES_UV_URL_X86_64="https://github.com/astral-sh/uv/releases/download/0.12.5/uv-x86_64-unknown-linux-gnu.tar.gz"
readonly HERMES_UV_URL_AARCH64="https://github.com/astral-sh/uv/releases/download/0.12.5/uv-aarch64-unknown-linux-gnu.tar.gz"
readonly HERMES_UV_MAX_BYTES=$((64 * 1024 * 1024))
readonly HERMES_PYTHON_VERSION="3.14.7"
readonly HERMES_PYTHON_BUILD="20260901"
readonly HERMES_PYTHON_SHA256_X86_64="0ab3305457051cd3e7c031857e005f1bda17c218a1990567dacaaac6dd1d14f0"
readonly HERMES_PYTHON_SHA256_AARCH64="30f1cc489be654477d895b441e196bb080738bf0456da82080ad4ab66a22d80f"
readonly HERMES_PYTHON_MAX_BYTES=$((160 * 1024 * 1024))
readonly HERMES_ATTESTATION_NAME=".portal-runtime-attestation-v1"

hermes_arch() {
  [[ "$(uname -s)" == "Linux" ]] || {
    printf 'Hermes %s is supported only on Linux.\n' "${HERMES_TESTED_VERSION}" >&2
    return 1
  }
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' 'x86_64' ;;
    aarch64|arm64) printf '%s\n' 'aarch64' ;;
    *) printf 'Unsupported Hermes architecture: %s\n' "$(uname -m)" >&2; return 1 ;;
  esac
}

hermes_uv_url() {
  case "$1" in
    x86_64) printf '%s\n' "${HERMES_UV_URL_X86_64}" ;;
    aarch64) printf '%s\n' "${HERMES_UV_URL_AARCH64}" ;;
    *) return 1 ;;
  esac
}

hermes_uv_sha256() {
  case "$1" in
    x86_64) printf '%s\n' "${HERMES_UV_SHA256_X86_64}" ;;
    aarch64) printf '%s\n' "${HERMES_UV_SHA256_AARCH64}" ;;
    *) return 1 ;;
  esac
}

hermes_uv_member() {
  case "$1" in
    x86_64) printf '%s\n' 'uv-x86_64-unknown-linux-gnu/uv' ;;
    aarch64) printf '%s\n' 'uv-aarch64-unknown-linux-gnu/uv' ;;
    *) return 1 ;;
  esac
}

hermes_root() {
  printf '%s\n' "${HERMES_RUNTIME_ROOT:-/usr/local/lib/bridgesllm-runtimes/hermes}"
}

hermes_version_root() {
  printf '%s/%s\n' "$(hermes_root)" "${HERMES_TESTED_VERSION}"
}

hermes_target() {
  printf '%s/hermes\n' "${HERMES_BIN_DIR:-/usr/local/bin}"
}

hermes_source_url() {
  printf 'https://api.github.com/repos/NousResearch/hermes-agent/tarball/%s\n' "$1"
}

# [version tag commit tree-sha256]: the tested release by default, or one
# generation that Maintenance staged (hermes_stage) and admitted.
hermes_attestation() {
  cat <<EOF
schema=bridgesllm-hermes-runtime-v1
product_version=${1:-${HERMES_TESTED_VERSION}}
upstream_tag=${2:-${HERMES_TESTED_TAG}}
upstream_commit=${3:-${HERMES_TESTED_COMMIT}}
source_tree_sha256=${4:-${HERMES_SOURCE_TREE_SHA256}}
uv_version=${HERMES_UV_VERSION}
python_version=${HERMES_PYTHON_VERSION}
python_build=${HERMES_PYTHON_BUILD}
install_stamp_update_mechanism=external
extras=acp,mcp
EOF
}

verify_hermes_download() {
  local archive="$1" expected="$2" maximum="$3" label="$4" actual size
  size="$(stat -c '%s' "${archive}")"
  (( size > 0 && size <= maximum )) || {
    printf '%s archive size is outside the allowed range.\n' "${label}" >&2
    return 1
  }
  actual="$(sha256sum "${archive}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || {
    printf '%s checksum mismatch (expected %s, received %s).\n' \
      "${label}" "${expected}" "${actual}" >&2
    return 1
  }
}

hermes_source_tree_sha256() {
  local archive="$1"
  python3 - "${archive}" "${HERMES_SOURCE_MAX_EXPANDED_BYTES}" "${HERMES_SOURCE_MAX_ENTRIES}" <<'PY'
import hashlib
import pathlib
import posixpath
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
expanded_limit = int(sys.argv[2])
entry_limit = int(sys.argv[3])
required = {"pyproject.toml", "uv.lock", "hermes", "acp_adapter"}
roots: set[str] = set()
seen: set[str] = set()
canonical_files: list[tuple[str, tarfile.TarInfo]] = []
expanded = 0

with tarfile.open(archive, "r:gz") as tf:
    members = tf.getmembers()
    if not members or len(members) > entry_limit:
        raise SystemExit("Hermes archive entry count is outside the allowed range")
    for member in members:
        name = member.name
        if not name or "\x00" in name or "\\" in name or name.startswith("/"):
            raise SystemExit("Hermes archive contains an unsafe path")
        normalized = posixpath.normpath(name)
        parts = pathlib.PurePosixPath(normalized).parts
        if normalized in (".", "..") or ".." in parts or len(parts) < 1:
            raise SystemExit("Hermes archive contains path traversal")
        if not (member.isfile() or member.isdir()):
            raise SystemExit("Hermes archive contains a non-regular entry")
        roots.add(parts[0])
        if normalized in seen:
            raise SystemExit("Hermes archive contains a duplicate path")
        seen.add(normalized)
        if member.isfile():
            expanded += member.size
            if member.size < 0 or expanded > expanded_limit:
                raise SystemExit("Hermes archive expanded size is outside the allowed range")
            if len(parts) > 1:
                canonical_files.append(("/".join(parts[1:]), member))
        if len(parts) > 1:
            required.discard("/".join(parts[1:]))

    if len(roots) != 1:
        raise SystemExit("Hermes archive must contain exactly one root directory")
    if {"pyproject.toml", "uv.lock", "hermes"} & required:
        raise SystemExit("Hermes archive is missing required runtime files")
    relative_paths = [path for path, _member in canonical_files]
    if not any(path.startswith("acp_adapter/") for path in relative_paths):
        raise SystemExit("Hermes archive is missing its ACP adapter")

    digest = hashlib.sha256()
    for relative_path, member in sorted(canonical_files, key=lambda row: row[0]):
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(oct(member.mode & 0o777).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(member.size).encode("ascii"))
        digest.update(b"\0")
        source = tf.extractfile(member)
        if source is None:
            raise SystemExit("Hermes archive contains an unreadable regular file")
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        digest.update(b"\0")
    print(digest.hexdigest())
PY
}

verify_hermes_source_archive() {
  local archive="$1" expected="${2:-${HERMES_SOURCE_TREE_SHA256}}" actual size
  size="$(stat -c '%s' "${archive}")"
  (( size > 0 && size <= HERMES_SOURCE_MAX_BYTES )) || {
    printf 'Hermes archive size is outside the allowed range.\n' >&2
    return 1
  }
  actual="$(hermes_source_tree_sha256 "${archive}")" || return 1
  [[ "${actual}" == "${expected}" ]] || {
    printf 'Hermes source tree checksum mismatch (expected %s, received %s).\n' \
      "${expected}" "${actual}" >&2
    return 1
  }
}

verify_hermes_uv_archive() {
  local archive="$1" expected="$2" member="$3"
  verify_hermes_download \
    "${archive}" "${expected}" "${HERMES_UV_MAX_BYTES}" "uv" || return 1
  python3 - "${archive}" "${member}" <<'PY'
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
expected = sys.argv[2]
with tarfile.open(archive, "r:gz") as tf:
    members = tf.getmembers()
    files = [member for member in members if member.isfile()]
    if any(not (member.isfile() or member.isdir()) for member in members):
        raise SystemExit("uv archive contains a non-regular entry")
    if expected not in {member.name for member in files}:
        raise SystemExit("uv archive is missing the expected executable")
    if any(member.name.startswith("/") or ".." in pathlib.PurePosixPath(member.name).parts for member in members):
        raise SystemExit("uv archive contains an unsafe path")
    binary = next(member for member in files if member.name == expected)
    if binary.size <= 0 or binary.size > 128 * 1024 * 1024:
        raise SystemExit("uv executable size is outside the allowed range")
PY
}

hermes_python_url() {
  case "$1" in
    x86_64|aarch64) printf 'https://github.com/astral-sh/python-build-standalone/releases/download/%s/cpython-%s+%s-%s-unknown-linux-gnu-install_only.tar.gz\n' \
      "${HERMES_PYTHON_BUILD}" "${HERMES_PYTHON_VERSION}" "${HERMES_PYTHON_BUILD}" "$1" ;;
    *) return 1 ;;
  esac
}

hermes_python_sha256() {
  case "$1" in
    x86_64) printf '%s\n' "${HERMES_PYTHON_SHA256_X86_64}" ;;
    aarch64) printf '%s\n' "${HERMES_PYTHON_SHA256_AARCH64}" ;;
    *) return 1 ;;
  esac
}

verify_hermes_python_archive() {
  local archive="$1" expected="$2"
  verify_hermes_download "${archive}" "${expected}" "${HERMES_PYTHON_MAX_BYTES}" "Python" || return 1
  python3 - "${archive}" <<'PYTHON'
import pathlib
import posixpath
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as tf:
    members = tf.getmembers()
    if not members or len(members) > 20000:
        raise SystemExit("Python archive entry count is outside the allowed range")
    seen = set()
    expanded = 0
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "python" or "\\" in member.name:
            raise SystemExit("Python archive contains an unsafe path")
        if member.name in seen or not (member.isfile() or member.isdir() or member.issym()):
            raise SystemExit("Python archive contains a duplicate or unsupported entry")
        seen.add(member.name)
        expanded += member.size
        if member.size < 0 or expanded > 768 * 1024 * 1024:
            raise SystemExit("Python archive expanded size is outside the allowed range")
        if member.issym():
            target = pathlib.PurePosixPath(posixpath.normpath(posixpath.join(str(path.parent), member.linkname)))
            if pathlib.PurePosixPath(member.linkname).is_absolute() or not target.parts or target.parts[0] != "python":
                raise SystemExit("Python archive contains an escaping symlink")
    if "python/bin/python3.14" not in seen:
        raise SystemExit("Python archive is missing the interpreter")
PYTHON
}

hermes_write_install_stamp() {  # root [version tag commit]
  local root="$1"
  # An archive nested beneath another checkout must not inherit that checkout's
  # branch/dirty identity. The admitted commit/tree, not ambient Git, is authority.
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    GIT_CEILING_DIRECTORIES="$(dirname "${root}")" \
    "${root}/.portal-tools/python/bin/python3" "${root}/scripts/write_install_stamp.py" \
    --output "${root}/install-stamp.json" --base-version "${2:-${HERMES_TESTED_VERSION}}" \
    --commit "${4:-${HERMES_TESTED_COMMIT}}" --branch "${3:-${HERMES_TESTED_TAG}}" --distance 0 --source local --update-mechanism external
}

verify_hermes_install_stamp() {  # root [version commit]
  python3 - "$1/install-stamp.json" "${2:-${HERMES_TESTED_VERSION}}" "${3:-${HERMES_TESTED_COMMIT}}" <<'PYTHON'
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        stamp = json.load(f)
    valid = (stamp.get("schemaVersion") == 2 and stamp.get("baseVersion") == sys.argv[2]
             and stamp.get("commit") == sys.argv[3] and stamp.get("distance") == 0
             and stamp.get("updateMechanism") == "external" and stamp.get("source") == "local"
             and not stamp.get("dirty"))
except (OSError, ValueError, AttributeError):
    valid = False
raise SystemExit(0 if valid else 1)
PYTHON
}

hermes_binary_version() {  # binary [expected version]
  local binary="$1" expected="${2:-${HERMES_TESTED_VERSION}}" probe output
  [[ -x "${binary}" ]] || return 1
  probe="$(mktemp -d)"
  mkdir -p "${probe}/home" "${probe}/state"
  output="$(
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
    HOME="${probe}/home" \
    HERMES_HOME="${probe}/state" \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_ACP_SKIP_CONFIGURED_MCP=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    timeout 30 "${binary}" acp --version 2>/dev/null
  )" || {
    rm -rf -- "${probe}"
    return 1
  }
  rm -rf -- "${probe}"
  [[ "${output}" =~ ^${expected//./\.}([[:space:]]*)$ ]] || return 1
  printf '%s\n' "${expected}"
}

hermes_acp_check() {
  local binary="$1" probe output
  [[ -x "${binary}" ]] || return 1
  probe="$(mktemp -d)"
  mkdir -p "${probe}/home" "${probe}/state"
  output="$(
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
    HOME="${probe}/home" \
    HERMES_HOME="${probe}/state" \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    HERMES_ACP_SKIP_CONFIGURED_MCP=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    timeout 30 "${binary}" acp --check 2>/dev/null
  )" || {
    rm -rf -- "${probe}"
    return 1
  }
  rm -rf -- "${probe}"
  [[ "${output}" == "Hermes ACP check OK" ]]
}

hermes_uv_version() {
  local binary="$1" output
  [[ -x "${binary}" ]] || return 1
  output="$("${binary}" --version 2>/dev/null)" || return 1
  [[ "${output}" =~ ^uv[[:space:]]${HERMES_UV_VERSION//./\.}([[:space:]]\([^()]+\))?$ ]] || return 1
  printf '%s\n' "${HERMES_UV_VERSION}"
}

# The Desktop user (bridgesrd) runs this CLI through the alias, so the runtime
# must sit outside the private /opt/bridgesllm ancestor and be world read/execute
# whatever the installer's umask. It holds no secrets; state stays private.
hermes_runtime_publicly_executable() {
  local path="$1"
  [[ -x "${path}" ]] || return 1
  while [[ "${path}" != "/" ]]; do
    # Every directory must be traversable and the file readable/executable by others.
    (( ( 0$(stat -c '%a' -- "${path}") & 05 ) == 05 )) || return 1
    path="$(dirname -- "${path}")"
  done
}

# Narrow migration from the previous private layout: only a direct alias to an
# exact legacy managed generation (root-owned regular file) may be replaced. The
# legacy tree is never modified; the alias moves only after a verified install.
hermes_legacy_managed_alias() {
  local target="$1" link resolved rest legacy_root="${HERMES_LEGACY_RUNTIME_ROOT:-/opt/bridgesllm/tools/hermes}"
  link="$(readlink -- "${target}" 2>/dev/null || true)"
  resolved="$(readlink -f -- "${target}" 2>/dev/null || true)"
  [[ -n "${resolved}" && "${link}" == "${resolved}" ]] || return 1
  rest="${resolved#"${legacy_root}/"}"
  [[ "${resolved}" == "${legacy_root}/${rest}" && "${rest}" =~ ^[0-9]+\.[0-9]+\.[0-9]+/\.venv/bin/hermes$ ]] || return 1
  [[ -f "${resolved}" && ! -L "${resolved}" && "$(stat -c '%u' -- "${resolved}")" == "0" ]]
}

# Maintenance (installer/tools/bridgesllm-toolctl.py) stages newer official
# releases into this same layout (hermes_stage), probes them, switches the alias
# and records each one in its admission record. Such a runtime is kept as it is
# instead of being converged back to the tested version, which acts as the floor.
hermes_admission_record() {
  printf '%s\n' "${HERMES_ADMISSION_RECORD:-/var/lib/bridgesllm/tools/admission/hermes.json}"
}

# Prints "<version> <tag> <commit> <tree-sha256>" when the record names exactly
# this alias target (path and sha256) and its generation's attestation (sha256)
# at or above the tested version, from an update that verified the source bytes
# (a re-check record never keeps a non-tested generation); fails otherwise.
hermes_admitted_identity() {
  local resolved="$1" record
  record="$(hermes_admission_record)"
  [[ -f "${record}" && ! -L "${record}" ]] || return 1
  python3 -I - "${record}" "${resolved}" "${HERMES_TESTED_VERSION}" "$(hermes_root)" "${HERMES_ATTESTATION_NAME}" <<'PY'
import hashlib, json, re, sys

record_path, resolved, floor, root, attestation_name = sys.argv[1:6]
key = lambda version: tuple(int(part) for part in version.split("."))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


try:
    with open(record_path, "rb") as handle:
        record = json.loads(handle.read(65536))
    version, entry, source = record["version"], record["executables"]["hermes"], record["source"]
    generation = "%s/%s" % (root, version)
    if record["schema"] != "bridgesllm.tools.harness-admission.v1" or record["toolId"] != "hermes" \
            or not re.fullmatch(r"[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}", version) or key(version) < key(floor) \
            or entry["path"] != resolved or resolved != generation + "/.venv/bin/hermes" or source["tag"] != "v" + version \
            or source.get("bytesVerified") is not True \
            or not re.fullmatch(r"[0-9a-f]{40}", source["commit"]) or not re.fullmatch(r"[0-9a-f]{64}", source["treeSha256"]):
        raise ValueError("record does not admit this runtime")
    if sha256(resolved) != entry["sha256"] or sha256(generation + "/" + attestation_name) != record["attestationSha256"]:
        raise ValueError("runtime differs from the admitted one")
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(1)
print(version, source["tag"], source["commit"], source["treeSha256"])
PY
}

verify_hermes_runtime() {
  local root target resolved identity expected_attestation actual_attestation python_version
  local version="${HERMES_TESTED_VERSION}" tag="${HERMES_TESTED_TAG}" commit="${HERMES_TESTED_COMMIT}" tree="${HERMES_SOURCE_TREE_SHA256}"
  target="$(hermes_target)"
  [[ -L "${target}" ]] || return 1
  resolved="$(readlink -f -- "${target}" 2>/dev/null || true)"
  if [[ "${resolved}" != "$(hermes_version_root)/.venv/bin/hermes" ]]; then
    identity="$(hermes_admitted_identity "${resolved}")" || return 1
    read -r version tag commit tree <<< "${identity}"
  fi
  root="$(hermes_root)/${version}"
  [[ "${resolved}" == "${root}/.venv/bin/hermes" ]] || return 1
  hermes_runtime_publicly_executable "${resolved}" || return 1
  hermes_runtime_publicly_executable "$(readlink -f -- "${root}/.venv/bin/python")" || return 1
  [[ -x "${root}/.portal-tools/uv" && -f "${root}/${HERMES_ATTESTATION_NAME}" ]] || return 1
  expected_attestation="$(hermes_attestation "${version}" "${tag}" "${commit}" "${tree}")"
  actual_attestation="$(<"${root}/${HERMES_ATTESTATION_NAME}")"
  [[ "${actual_attestation}" == "${expected_attestation}" ]] || return 1
  verify_hermes_install_stamp "${root}" "${version}" "${commit}" || return 1
  [[ "$(hermes_uv_version "${root}/.portal-tools/uv" || true)" == "${HERMES_UV_VERSION}" ]] || return 1
  python_version="$("${root}/.venv/bin/python" --version 2>&1 | awk '{print $2}')"
  [[ "${python_version}" == "${HERMES_PYTHON_VERSION}" ]] || return 1
  [[ "$(hermes_binary_version "${target}" "${version}" || true)" == "${version}" ]] || return 1
  hermes_acp_check "${target}"
}

hermes_verify() {
  local target
  target="$(hermes_target)"
  verify_hermes_runtime || {
    printf 'Hermes is missing or is neither the Portal-qualified %s runtime nor an admitted newer release at %s.\n' \
      "${HERMES_TESTED_VERSION}" "${target}" >&2
    return 1
  }
  printf 'Hermes is verified at %s.\n' "${target}"
}

# Downloads into <work_dir> and verifies the source tree of <commit> (canonical
# tree <tree-sha256>), the pinned uv and the pinned Python; unpacks the source
# (<work_dir>/source) and uv (<work_dir>/uv). Shared by converge and stage.
# Callers test its status (set -e does not apply there), so every step checks.
hermes_fetch_artifacts() {
  local work_dir="$1" arch="$2" commit="$3" tree="$4" uv_url uv_sha uv_member
  uv_url="$(hermes_uv_url "${arch}")" || return 1
  uv_sha="$(hermes_uv_sha256 "${arch}")" || return 1
  uv_member="$(hermes_uv_member "${arch}")" || return 1
  mkdir -p "${work_dir}/source" || return 1
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 900 --max-filesize "${HERMES_SOURCE_MAX_BYTES}" \
      --output "${work_dir}/hermes.tar.gz" "$(hermes_source_url "${commit}")" \
    || ! verify_hermes_source_archive "${work_dir}/hermes.tar.gz" "${tree}"; then
    printf 'Could not acquire the pinned Hermes source artifact.\n' >&2
    return 1
  fi
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 600 --max-filesize "${HERMES_UV_MAX_BYTES}" \
      --output "${work_dir}/uv.tar.gz" "${uv_url}" \
    || ! verify_hermes_uv_archive "${work_dir}/uv.tar.gz" "${uv_sha}" "${uv_member}"; then
    printf 'Could not acquire the pinned uv artifact for Hermes.\n' >&2
    return 1
  fi
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 900 --max-filesize "${HERMES_PYTHON_MAX_BYTES}" \
      --output "${work_dir}/python.tar.gz" "$(hermes_python_url "${arch}")" \
    || ! verify_hermes_python_archive "${work_dir}/python.tar.gz" "$(hermes_python_sha256 "${arch}")"; then
    printf 'Could not acquire the pinned Python artifact for Hermes.\n' >&2
    return 1
  fi
  if ! tar --no-same-owner --no-same-permissions -xzf "${work_dir}/hermes.tar.gz" \
      --strip-components=1 -C "${work_dir}/source" \
    || ! tar -xOzf "${work_dir}/uv.tar.gz" "${uv_member}" > "${work_dir}/uv" || ! chmod 0755 "${work_dir}/uv"; then
    printf 'The verified Hermes source or uv archive could not be unpacked.\n' >&2
    return 1
  fi
  [[ "$(hermes_uv_version "${work_dir}/uv" || true)" == "${HERMES_UV_VERSION}" ]] || {
    printf 'Pinned uv artifact failed exact version verification.\n' >&2
    return 1
  }
}

# Turns fetched artifacts into the absent runtime generation <version_root>:
# source, pinned uv and Python, install stamp, frozen-lock venv, attestation,
# then the exact product version and ACP check. Removes it on failure.
hermes_install_generation() {
  local version_root="$1" work_dir="$2" version="$3" tag="$4" commit="$5" tree="$6"
  mv -- "${work_dir}/source" "${version_root}" || return 1
  if ! (
    export UV_CACHE_DIR="${work_dir}/uv-cache"
    export UV_NO_PROGRESS=1
    export UV_NO_CONFIG=1
    install -d -m 0755 "${version_root}/.portal-tools" || exit 1
    install -m 0755 "${work_dir}/uv" "${version_root}/.portal-tools/uv" || exit 1
    tar --no-same-owner --no-same-permissions -xzf "${work_dir}/python.tar.gz" -C "${version_root}/.portal-tools" || exit 1
    [[ "$("${version_root}/.portal-tools/python/bin/python3" --version 2>&1)" == "Python ${HERMES_PYTHON_VERSION}" ]] || exit 1
    hermes_write_install_stamp "${version_root}" "${version}" "${tag}" "${commit}" || exit 1
    verify_hermes_install_stamp "${version_root}" "${version}" "${commit}" || exit 1
    UV_PYTHON_DOWNLOADS=never "${version_root}/.portal-tools/uv" sync \
      --project "${version_root}" \
      --python "${version_root}/.portal-tools/python/bin/python3" \
      --frozen --no-dev --no-default-groups --extra acp --extra mcp --compile-bytecode
  ); then
    printf 'Hermes dependency convergence failed; restoring the previous runtime.\n' >&2
    rm -rf -- "${version_root}"
    return 1
  fi
  if ! hermes_attestation "${version}" "${tag}" "${commit}" "${tree}" > "${version_root}/${HERMES_ATTESTATION_NAME}" \
    || ! chmod 0644 "${version_root}/${HERMES_ATTESTATION_NAME}" || ! chmod -R u+rwX,go+rX,go-w -- "${version_root}" \
    || [[ "$(hermes_binary_version "${version_root}/.venv/bin/hermes" "${version}" || true)" != "${version}" ]] \
    || ! hermes_acp_check "${version_root}/.venv/bin/hermes"; then
    printf 'Installed Hermes failed exact product/ACP verification; restoring the previous runtime.\n' >&2
    rm -rf -- "${version_root}"
    return 1
  fi
}

# Maintenance's candidate build: `stage <dir> <version> <tag> <commit> <tree-sha256>`
# builds the generation exactly like converge does, from the source tree of
# <commit> that toolctl resolved from <tag> and verified (<tree-sha256>), with
# the pinned uv and Python. A venv is not relocatable, so <dir> must be the
# generation's final path <root>/<version> and must not exist yet. The alias and
# every other generation are left alone; toolctl probes <dir> and switches.
hermes_stage() {
  local dir="${1:-}" version="${2:-}" tag="${3:-}" commit="${4:-}" tree="${5:-}" arch work_dir
  if [[ "$#" -ne 5 || ! "${version}" =~ ^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$ || "${tag}" != "v${version}" \
      || ! "${commit}" =~ ^[0-9a-f]{40}$ || ! "${tree}" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'Usage: stage <root>/<x.y.z> <x.y.z> v<x.y.z> <40-hex commit> <64-hex tree sha256>\n' >&2
    return 2
  fi
  if [[ "${dir}" != "$(hermes_root)/${version}" || -e "${dir}" || -L "${dir}" || ! -d "$(hermes_root)" ]]; then
    printf 'Refusing to stage Hermes %s at %s: it must be the absent generation %s/%s.\n' \
      "${version}" "${dir}" "$(hermes_root)" "${version}" >&2
    return 1
  fi
  arch="$(hermes_arch)" || return 1
  work_dir="$(mktemp -d "$(hermes_root)/.install-${version}.XXXXXX")"
  if ! hermes_fetch_artifacts "${work_dir}" "${arch}" "${commit}" "${tree}" \
    || ! hermes_install_generation "${dir}" "${work_dir}" "${version}" "${tag}" "${commit}" "${tree}"; then
    rm -rf -- "${work_dir}"
    printf 'Hermes %s could not be staged at %s.\n' "${version}" "${dir}" >&2
    return 1
  fi
  rm -rf -- "${work_dir}"
  printf 'Hermes %s staged and verified at %s.\n' "${version}" "${dir}"
}

hermes_converge() {
  local root version_root bin_dir target state_dir arch work_dir previous_link="" backup_root=""
  root="$(hermes_root)"
  version_root="$(hermes_version_root)"
  bin_dir="${HERMES_BIN_DIR:-/usr/local/bin}"
  target="${bin_dir}/hermes"
  state_dir="${HERMES_STATE_DIR:-/var/lib/bridgesllm/hermes}"

  if [[ "${root}" == "/usr/local/lib/bridgesllm-runtimes/hermes" || "${bin_dir}" == "/usr/local/bin" || "${state_dir}" == "/var/lib/bridgesllm/hermes" ]]; then
    [[ "${EUID}" -eq 0 ]] || {
      printf 'Installing the system Hermes runtime requires root.\n' >&2
      return 1
    }
  fi
  if verify_hermes_runtime; then
    printf 'Hermes is already verified at %s.\n' "${target}"
    return 0
  fi
  if [[ -e "${target}" && ! -L "${target}" ]]; then
    printf 'Refusing to overwrite the non-symlink Hermes executable at %s.\n' "${target}" >&2
    return 1
  fi
  if [[ -L "${target}" ]]; then
    previous_link="$(readlink -- "${target}")"
    case "$(readlink -f -- "${target}" 2>/dev/null || true)" in
      "${root}"/*/.venv/bin/hermes) ;;
      *)
        if hermes_legacy_managed_alias "${target}"; then
          printf 'Migrating the Hermes alias from the legacy private runtime.\n' >&2
        else
          printf 'Refusing to replace an unmanaged Hermes symlink at %s.\n' "${target}" >&2
          return 1
        fi
        ;;
    esac
  fi

  arch="$(hermes_arch)" || return 1
  hermes_uv_url "${arch}" >/dev/null || return 1
  # Existing ancestors may protect unrelated files; never chmod them.
  # Missing parents follow the umask in some install implementations (uutils 0.8
  # creates them 0700 under umask 077; GNU uses 0755), so only this public creation
  # runs under umask 022. State keeps the caller umask and its explicit 0700.
  local existing_ancestor
  existing_ancestor="$(dirname -- "${root}")"
  while [[ ! -e "${existing_ancestor}" && ! -L "${existing_ancestor}" ]]; do
    existing_ancestor="$(dirname -- "${existing_ancestor}")"
  done
  if ! hermes_runtime_publicly_executable "${existing_ancestor}"; then
    printf 'Refusing the private or inaccessible Hermes runtime ancestor at %s.\n' "${existing_ancestor}" >&2
    return 1
  fi
  ( umask 022; install -d -m 0755 "${root}" "${bin_dir}" )
  install -d -m 0700 "${state_dir}"
  work_dir="$(mktemp -d "${root}/.install-${HERMES_TESTED_VERSION}.XXXXXX")"
  if ! hermes_fetch_artifacts "${work_dir}" "${arch}" "${HERMES_TESTED_COMMIT}" "${HERMES_SOURCE_TREE_SHA256}"; then
    rm -rf -- "${work_dir}"
    return 1
  fi
  if [[ -e "${version_root}" ]]; then
    backup_root="${work_dir}/previous-runtime"
    mv -- "${version_root}" "${backup_root}"
  fi
  if ! hermes_install_generation "${version_root}" "${work_dir}" "${HERMES_TESTED_VERSION}" "${HERMES_TESTED_TAG}" \
      "${HERMES_TESTED_COMMIT}" "${HERMES_SOURCE_TREE_SHA256}"; then
    [[ -z "${backup_root}" ]] || mv -- "${backup_root}" "${version_root}"
    rm -rf -- "${work_dir}"
    return 1
  fi

  ln -s "${version_root}/.venv/bin/hermes" "${work_dir}/hermes.link"
  mv -Tf -- "${work_dir}/hermes.link" "${target}"
  if ! verify_hermes_runtime; then
    printf 'Installed Hermes failed final verification; restoring the previous runtime link.\n' >&2
    if [[ -n "${previous_link}" ]]; then
      ln -s "${previous_link}" "${work_dir}/hermes.rollback"
      mv -Tf -- "${work_dir}/hermes.rollback" "${target}"
    else
      rm -f -- "${target}"
    fi
    rm -rf -- "${version_root}"
    [[ -z "${backup_root}" ]] || mv -- "${backup_root}" "${version_root}"
    rm -rf -- "${work_dir}"
    return 1
  fi

  rm -rf -- "${work_dir}"
  printf 'Hermes %s installed and verified at %s.\n' "${HERMES_TESTED_VERSION}" "${target}"
}

hermes_main() {
  case "${1:-status}" in
    converge|install|update) hermes_converge ;;
    verify|status) hermes_verify ;;
    stage) shift; hermes_stage "$@" ;;
    *) printf 'Usage: %s {converge|verify|status|stage <dir> <version> <tag> <commit> <tree-sha256>}\n' "${0##*/}" >&2; return 2 ;;
  esac
}

if [[ "${HERMES_RUNTIME_SOURCE_ONLY:-0}" != "1" ]]; then
  hermes_main "$@"
fi
