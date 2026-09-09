#!/usr/bin/env bash
set -Eeuo pipefail

# Portal-tested OpenCode runtime. Portal installs immutable upstream release
# archives directly; it never runs the mutable npm/npx installer path.
readonly OPENCODE_TESTED_VERSION="1.18.29"
# The x64 baseline build is intentional: it trades newer CPU instructions for
# a wider host compatibility floor. Its archive is distinct from the ordinary
# opencode-linux-x64.tar.gz asset even though both contain one `opencode`
# binary and have nearly identical sizes.
readonly OPENCODE_ASSET_X86_64="opencode-linux-x64-baseline.tar.gz"
readonly OPENCODE_ASSET_AARCH64="opencode-linux-arm64.tar.gz"
readonly OPENCODE_SHA256_X86_64="03a3f2f063e23477e3e4c3a738eb389f56c5a6ecf54d6a5a6d91caab557f042d"
readonly OPENCODE_SHA256_AARCH64="70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0"
readonly OPENCODE_BINARY_SHA256_X86_64="ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650"
readonly OPENCODE_BINARY_SHA256_AARCH64="e94d9ebec16ce2611eae94026afe8ec87f2e2dcc66db40bc4f889955b026eb75"
readonly OPENCODE_URL_X86_64="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_TESTED_VERSION}/${OPENCODE_ASSET_X86_64}"
readonly OPENCODE_URL_AARCH64="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_TESTED_VERSION}/${OPENCODE_ASSET_AARCH64}"
readonly OPENCODE_MAX_ARCHIVE_BYTES=$((128 * 1024 * 1024))

opencode_arch() {
  [[ "$(uname -s)" == "Linux" ]] || {
    printf 'OpenCode %s is supported only on Linux.\n' "${OPENCODE_TESTED_VERSION}" >&2
    return 1
  }
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' 'x86_64' ;;
    aarch64|arm64) printf '%s\n' 'aarch64' ;;
    *) printf 'Unsupported OpenCode architecture: %s\n' "$(uname -m)" >&2; return 1 ;;
  esac
}

opencode_url() {
  case "$1" in
    x86_64) printf '%s\n' "${OPENCODE_URL_X86_64}" ;;
    aarch64) printf '%s\n' "${OPENCODE_URL_AARCH64}" ;;
    *) return 1 ;;
  esac
}

opencode_sha256() {
  case "$1" in
    x86_64) printf '%s\n' "${OPENCODE_SHA256_X86_64}" ;;
    aarch64) printf '%s\n' "${OPENCODE_SHA256_AARCH64}" ;;
    *) return 1 ;;
  esac
}

opencode_binary_sha256() {
  case "$1" in
    x86_64) printf '%s\n' "${OPENCODE_BINARY_SHA256_X86_64}" ;;
    aarch64) printf '%s\n' "${OPENCODE_BINARY_SHA256_AARCH64}" ;;
    *) return 1 ;;
  esac
}

opencode_binary_version() {
  local binary="$1" output
  output="$(OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_SHARE=1 "${binary}" --version 2>/dev/null)" || return 1
  [[ "${output}" =~ ^${OPENCODE_TESTED_VERSION//./\.}([[:space:]]*)$ ]] || return 1
  printf '%s\n' "${OPENCODE_TESTED_VERSION}"
}

verify_opencode_binary() {
  local binary="$1"
  [[ -x "${binary}" ]] || return 1
  [[ "$(opencode_binary_version "${binary}" || true)" == "${OPENCODE_TESTED_VERSION}" ]]
}

opencode_target() {
  printf '%s/opencode\n' "${OPENCODE_BIN_DIR:-/usr/local/bin}"
}

opencode_root() {
  printf '%s\n' "${OPENCODE_RUNTIME_ROOT:-/opt/bridgesllm/tools/opencode}"
}

opencode_version_root() {
  printf '%s/%s\n' "$(opencode_root)" "${OPENCODE_TESTED_VERSION}"
}

opencode_managed_binary() {
  printf '%s/opencode\n' "$(opencode_version_root)"
}

verify_opencode_archive() {
  local archive="$1" expected="$2" actual size
  size="$(stat -c '%s' "${archive}")"
  (( size > 0 && size <= OPENCODE_MAX_ARCHIVE_BYTES )) || {
    printf 'OpenCode archive size is outside the allowed range.\n' >&2
    return 1
  }
  actual="$(sha256sum "${archive}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || {
    printf 'OpenCode checksum mismatch (expected %s, received %s).\n' "${expected}" "${actual}" >&2
    return 1
  }
  python3 - "${archive}" <<'PY'
import pathlib, sys, tarfile

archive = pathlib.Path(sys.argv[1])
with tarfile.open(archive, "r:gz") as tf:
    members = tf.getmembers()
    if len(members) != 1:
        raise SystemExit("OpenCode archive contains unexpected entries")
    member = members[0]
    if member.name != "opencode" or not member.isfile() or member.issym() or member.islnk():
        raise SystemExit("OpenCode archive member is not the expected regular binary")
    if member.size <= 0 or member.size > 256 * 1024 * 1024:
        raise SystemExit("OpenCode binary size is outside the allowed range")
PY
}

verify_opencode_runtime() {
  local target managed resolved arch expected actual
  target="$(opencode_target)"
  managed="$(opencode_managed_binary)"
  [[ -L "${target}" && -x "${managed}" ]] || return 1
  resolved="$(readlink -f -- "${target}" 2>/dev/null || true)"
  [[ "${resolved}" == "${managed}" ]] || return 1
  arch="$(opencode_arch)" || return 1
  expected="$(opencode_binary_sha256 "${arch}")" || return 1
  actual="$(sha256sum "${managed}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || return 1
  verify_opencode_binary "${target}"
}

opencode_verify() {
  local target
  target="$(opencode_target)"
  verify_opencode_runtime || {
    printf 'OpenCode is missing or is not the Portal-tested version %s at %s.\n' \
      "${OPENCODE_TESTED_VERSION}" "${target}" >&2
    return 1
  }
  printf 'OpenCode %s is verified at %s.\n' "${OPENCODE_TESTED_VERSION}" "${target}"
}

opencode_converge() {
  local root version_root managed bin_dir target state_dir arch url expected
  local work_dir archive stage_root staged previous_link="" backup_root=""
  root="$(opencode_root)"
  version_root="$(opencode_version_root)"
  managed="$(opencode_managed_binary)"
  bin_dir="${OPENCODE_BIN_DIR:-/usr/local/bin}"
  target="${bin_dir}/opencode"
  state_dir="${OPENCODE_STATE_DIR:-/var/lib/bridgesllm/opencode}"

  if [[ "${root}" == "/opt/bridgesllm/tools/opencode" || "${bin_dir}" == "/usr/local/bin" || "${state_dir}" == "/var/lib/bridgesllm/opencode" ]]; then
    [[ "${EUID}" -eq 0 ]] || {
      printf 'Installing the system OpenCode runtime requires root.\n' >&2
      return 1
    }
  fi
  if verify_opencode_runtime; then
    printf 'OpenCode %s is already verified at %s.\n' "${OPENCODE_TESTED_VERSION}" "${target}"
    return 0
  fi
  if [[ -e "${target}" && ! -L "${target}" ]]; then
    printf 'Refusing to overwrite the non-symlink OpenCode executable at %s.\n' "${target}" >&2
    return 1
  fi
  if [[ -L "${target}" ]]; then
    previous_link="$(readlink -- "${target}")"
    case "$(readlink -f -- "${target}" 2>/dev/null || true)" in
      "${root}"/*/opencode) ;;
      *)
        printf 'Refusing to replace an unmanaged OpenCode symlink at %s.\n' "${target}" >&2
        return 1
        ;;
    esac
  fi

  arch="$(opencode_arch)" || return 1
  url="$(opencode_url "${arch}")" || return 1
  expected="$(opencode_sha256 "${arch}")" || return 1
  install -d -m 0755 "${root}" "${bin_dir}"
  install -d -m 0700 "${state_dir}"
  work_dir="$(mktemp -d "${root}/.install-${OPENCODE_TESTED_VERSION}.XXXXXX")"
  archive="${work_dir}/opencode.tar.gz"
  stage_root="${work_dir}/runtime"
  staged="${stage_root}/opencode"
  mkdir -p "${stage_root}"

  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --max-filesize "${OPENCODE_MAX_ARCHIVE_BYTES}" --output "${archive}" "${url}"; then
    printf 'Could not download the pinned OpenCode artifact.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi
  if ! verify_opencode_archive "${archive}" "${expected}"; then
    rm -rf -- "${work_dir}"
    return 1
  fi
  tar -xOzf "${archive}" opencode > "${staged}"
  chmod 0755 "${staged}"
  if ! verify_opencode_binary "${staged}"; then
    printf 'Downloaded OpenCode artifact failed exact version verification.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi

  if [[ -e "${version_root}" ]]; then
    backup_root="${work_dir}/previous-runtime"
    mv -- "${version_root}" "${backup_root}"
  fi
  mv -- "${stage_root}" "${version_root}"
  ln -s "${managed}" "${work_dir}/opencode.link"
  mv -Tf -- "${work_dir}/opencode.link" "${target}"
  if ! verify_opencode_runtime; then
    printf 'Installed OpenCode failed verification; restoring the previous runtime.\n' >&2
    if [[ -n "${previous_link}" ]]; then
      ln -s "${previous_link}" "${work_dir}/opencode.rollback"
      mv -Tf -- "${work_dir}/opencode.rollback" "${target}"
    else
      rm -f -- "${target}"
    fi
    rm -rf -- "${version_root}"
    [[ -z "${backup_root}" ]] || mv -- "${backup_root}" "${version_root}"
    rm -rf -- "${work_dir}"
    return 1
  fi

  rm -rf -- "${work_dir}"
  printf 'OpenCode %s installed and verified at %s.\n' "${OPENCODE_TESTED_VERSION}" "${target}"
}

opencode_main() {
  case "${1:-status}" in
    converge|install|update) opencode_converge ;;
    verify|status) opencode_verify ;;
    *) printf 'Usage: %s {converge|verify|status}\n' "${0##*/}" >&2; return 2 ;;
  esac
}

if [[ "${OPENCODE_RUNTIME_SOURCE_ONLY:-0}" != "1" ]]; then
  opencode_main "$@"
fi
