#!/usr/bin/env bash
set -Eeuo pipefail

# Portal-qualified Hermes ACP runtime. The upstream convenience installer tracks
# main and can install optional components lazily. Portal instead installs one
# exact release-commit source tree, one exact uv release, one exact Python
# patch, and the repository's frozen dependency lock into a versioned root.
readonly HERMES_TESTED_VERSION="0.21.1"
readonly HERMES_TESTED_TAG="v2026.9.7"
readonly HERMES_TESTED_COMMIT="2237be355906fbe6065ce1815711eee52b2d646e"
readonly HERMES_SOURCE_URL="https://api.github.com/repos/NousResearch/hermes-agent/tarball/2237be355906fbe6065ce1815711eee52b2d646e"
# GitHub regenerates auto-generated tag/commit tarballs: the gzip bytes and
# root directory can change while the exact commit tree remains identical.
# Pin a canonical SHA-256 over every regular file's relative path, executable
# mode, size and bytes instead of a mutable transport archive hash.
readonly HERMES_SOURCE_TREE_SHA256="77aa1e1cabc237bb62b291e77927d99977ac356484a9d16f897bb66cda248773"
readonly HERMES_SOURCE_MAX_BYTES=$((96 * 1024 * 1024))
readonly HERMES_SOURCE_MAX_EXPANDED_BYTES=$((512 * 1024 * 1024))

readonly HERMES_UV_VERSION="0.12.5"
readonly HERMES_UV_SHA256_X86_64="68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2"
readonly HERMES_UV_SHA256_AARCH64="9bf43b4d1a07665bf64d4c4e710930b382321a785e0eb10aac07f46471f86a31"
readonly HERMES_UV_URL_X86_64="https://github.com/astral-sh/uv/releases/download/0.12.5/uv-x86_64-unknown-linux-gnu.tar.gz"
readonly HERMES_UV_URL_AARCH64="https://github.com/astral-sh/uv/releases/download/0.12.5/uv-aarch64-unknown-linux-gnu.tar.gz"
readonly HERMES_UV_MAX_BYTES=$((64 * 1024 * 1024))
readonly HERMES_PYTHON_VERSION="3.11.15"
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
  printf '%s\n' "${HERMES_RUNTIME_ROOT:-/opt/bridgesllm/tools/hermes}"
}

hermes_version_root() {
  printf '%s/%s\n' "$(hermes_root)" "${HERMES_TESTED_VERSION}"
}

hermes_target() {
  printf '%s/hermes\n' "${HERMES_BIN_DIR:-/usr/local/bin}"
}

hermes_attestation() {
  cat <<EOF
schema=bridgesllm-hermes-runtime-v1
product_version=${HERMES_TESTED_VERSION}
upstream_tag=${HERMES_TESTED_TAG}
upstream_commit=${HERMES_TESTED_COMMIT}
source_tree_sha256=${HERMES_SOURCE_TREE_SHA256}
uv_version=${HERMES_UV_VERSION}
python_version=${HERMES_PYTHON_VERSION}
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
  python3 - "${archive}" "${HERMES_SOURCE_MAX_EXPANDED_BYTES}" <<'PY'
import hashlib
import pathlib
import posixpath
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
expanded_limit = int(sys.argv[2])
required = {"pyproject.toml", "uv.lock", "hermes", "acp_adapter"}
roots: set[str] = set()
seen: set[str] = set()
canonical_files: list[tuple[str, tarfile.TarInfo]] = []
expanded = 0

with tarfile.open(archive, "r:gz") as tf:
    members = tf.getmembers()
    if not members or len(members) > 20000:
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
  local archive="$1" actual size
  size="$(stat -c '%s' "${archive}")"
  (( size > 0 && size <= HERMES_SOURCE_MAX_BYTES )) || {
    printf 'Hermes archive size is outside the allowed range.\n' >&2
    return 1
  }
  actual="$(hermes_source_tree_sha256 "${archive}")" || return 1
  [[ "${actual}" == "${HERMES_SOURCE_TREE_SHA256}" ]] || {
    printf 'Hermes source tree checksum mismatch (expected %s, received %s).\n' \
      "${HERMES_SOURCE_TREE_SHA256}" "${actual}" >&2
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

hermes_binary_version() {
  local binary="$1" probe output
  [[ -x "${binary}" ]] || return 1
  probe="$(mktemp -d)"
  mkdir -p "${probe}/home" "${probe}/state"
  output="$(
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
  [[ "${output}" =~ ^${HERMES_TESTED_VERSION//./\.}([[:space:]]*)$ ]] || return 1
  printf '%s\n' "${HERMES_TESTED_VERSION}"
}

hermes_acp_check() {
  local binary="$1" probe output
  [[ -x "${binary}" ]] || return 1
  probe="$(mktemp -d)"
  mkdir -p "${probe}/home" "${probe}/state"
  output="$(
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

verify_hermes_runtime() {
  local root target resolved expected_attestation actual_attestation python_version
  root="$(hermes_version_root)"
  target="$(hermes_target)"
  [[ -L "${target}" ]] || return 1
  resolved="$(readlink -f -- "${target}" 2>/dev/null || true)"
  [[ "${resolved}" == "${root}/.venv/bin/hermes" ]] || return 1
  [[ -x "${root}/.portal-tools/uv" && -f "${root}/${HERMES_ATTESTATION_NAME}" ]] || return 1
  expected_attestation="$(hermes_attestation)"
  actual_attestation="$(<"${root}/${HERMES_ATTESTATION_NAME}")"
  [[ "${actual_attestation}" == "${expected_attestation}" ]] || return 1
  [[ "$(hermes_uv_version "${root}/.portal-tools/uv" || true)" == "${HERMES_UV_VERSION}" ]] || return 1
  python_version="$("${root}/.venv/bin/python" --version 2>&1 | awk '{print $2}')"
  [[ "${python_version}" == "${HERMES_PYTHON_VERSION}" ]] || return 1
  [[ "$(hermes_binary_version "${target}" || true)" == "${HERMES_TESTED_VERSION}" ]] || return 1
  hermes_acp_check "${target}"
}

hermes_verify() {
  local target
  target="$(hermes_target)"
  verify_hermes_runtime || {
    printf 'Hermes is missing or is not the Portal-qualified %s runtime at %s.\n' \
      "${HERMES_TESTED_VERSION}" "${target}" >&2
    return 1
  }
  printf 'Hermes %s is verified at %s.\n' "${HERMES_TESTED_VERSION}" "${target}"
}

hermes_converge() {
  local root version_root bin_dir target state_dir arch uv_url uv_sha uv_member
  local work_dir source_archive uv_archive source_stage uv_binary previous_link="" backup_root=""
  root="$(hermes_root)"
  version_root="$(hermes_version_root)"
  bin_dir="${HERMES_BIN_DIR:-/usr/local/bin}"
  target="${bin_dir}/hermes"
  state_dir="${HERMES_STATE_DIR:-/var/lib/bridgesllm/hermes}"

  if [[ "${root}" == "/opt/bridgesllm/tools/hermes" || "${bin_dir}" == "/usr/local/bin" || "${state_dir}" == "/var/lib/bridgesllm/hermes" ]]; then
    [[ "${EUID}" -eq 0 ]] || {
      printf 'Installing the system Hermes runtime requires root.\n' >&2
      return 1
    }
  fi
  if verify_hermes_runtime; then
    printf 'Hermes %s is already verified at %s.\n' "${HERMES_TESTED_VERSION}" "${target}"
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
        printf 'Refusing to replace an unmanaged Hermes symlink at %s.\n' "${target}" >&2
        return 1
        ;;
    esac
  fi

  arch="$(hermes_arch)" || return 1
  uv_url="$(hermes_uv_url "${arch}")" || return 1
  uv_sha="$(hermes_uv_sha256 "${arch}")" || return 1
  uv_member="$(hermes_uv_member "${arch}")" || return 1
  install -d -m 0755 "${root}" "${bin_dir}"
  install -d -m 0700 "${state_dir}"
  work_dir="$(mktemp -d "${root}/.install-${HERMES_TESTED_VERSION}.XXXXXX")"
  source_archive="${work_dir}/hermes.tar.gz"
  uv_archive="${work_dir}/uv.tar.gz"
  source_stage="${work_dir}/source"
  uv_binary="${work_dir}/uv"
  mkdir -p "${source_stage}"

  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 900 --max-filesize "${HERMES_SOURCE_MAX_BYTES}" \
      --output "${source_archive}" "${HERMES_SOURCE_URL}" \
    || ! verify_hermes_source_archive "${source_archive}"; then
    printf 'Could not acquire the pinned Hermes source artifact.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --max-time 600 --max-filesize "${HERMES_UV_MAX_BYTES}" \
      --output "${uv_archive}" "${uv_url}" \
    || ! verify_hermes_uv_archive "${uv_archive}" "${uv_sha}" "${uv_member}"; then
    printf 'Could not acquire the pinned uv artifact for Hermes.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi
  tar --no-same-owner --no-same-permissions -xzf "${source_archive}" \
    --strip-components=1 -C "${source_stage}"
  tar -xOzf "${uv_archive}" "${uv_member}" > "${uv_binary}"
  chmod 0755 "${uv_binary}"
  [[ "$(hermes_uv_version "${uv_binary}" || true)" == "${HERMES_UV_VERSION}" ]] || {
    printf 'Pinned uv artifact failed exact version verification.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  }

  if [[ -e "${version_root}" ]]; then
    backup_root="${work_dir}/previous-runtime"
    mv -- "${version_root}" "${backup_root}"
  fi
  mv -- "${source_stage}" "${version_root}"
  install -d -m 0755 "${version_root}/.portal-tools"
  install -m 0755 "${uv_binary}" "${version_root}/.portal-tools/uv"

  if ! (
    export UV_CACHE_DIR="${work_dir}/uv-cache"
    export UV_PYTHON_INSTALL_DIR="${version_root}/.portal-tools/python"
    export UV_MANAGED_PYTHON=1
    export UV_NO_PROGRESS=1
    export UV_NO_CONFIG=1
    "${version_root}/.portal-tools/uv" python install \
      "${HERMES_PYTHON_VERSION}" --no-bin --no-registry
    UV_PYTHON_DOWNLOADS=never "${version_root}/.portal-tools/uv" sync \
      --project "${version_root}" \
      --python "${HERMES_PYTHON_VERSION}" \
      --frozen --no-dev --no-default-groups --extra acp --compile-bytecode
  ); then
    printf 'Hermes dependency convergence failed; restoring the previous runtime.\n' >&2
    rm -rf -- "${version_root}"
    [[ -z "${backup_root}" ]] || mv -- "${backup_root}" "${version_root}"
    rm -rf -- "${work_dir}"
    return 1
  fi
  hermes_attestation > "${version_root}/${HERMES_ATTESTATION_NAME}"
  chmod 0644 "${version_root}/${HERMES_ATTESTATION_NAME}"

  if [[ "$(hermes_binary_version "${version_root}/.venv/bin/hermes" || true)" != "${HERMES_TESTED_VERSION}" ]] \
    || ! hermes_acp_check "${version_root}/.venv/bin/hermes"; then
    printf 'Installed Hermes failed exact product/ACP verification; restoring the previous runtime.\n' >&2
    rm -rf -- "${version_root}"
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
    *) printf 'Usage: %s {converge|verify|status}\n' "${0##*/}" >&2; return 2 ;;
  esac
}

if [[ "${HERMES_RUNTIME_SOURCE_ONLY:-0}" != "1" ]]; then
  hermes_main "$@"
fi
