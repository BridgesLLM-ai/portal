#!/usr/bin/env bash
set -Eeuo pipefail

# Portal-tested native Grok Build runtime. The upstream installer is convenient
# for interactive work, but it does not publish a checksum or provide rollback.
# Portal therefore converges the two supported Linux artifacts directly.
readonly GROK_BUILD_TESTED_VERSION="0.2.112"
readonly GROK_BUILD_SHA256_X86_64="c2867112f7d89366123fe68a55a23dfb027d3602fc5b5b9cd5c080dacb4a2503"
readonly GROK_BUILD_SHA256_AARCH64="d21f1aaaba7f2930db0ef7d5a9dc3f814a94c54af208e091f72a239cac02ba39"
readonly GROK_BUILD_DOWNLOAD_ROOT="https://x.ai/cli"

grok_build_arch() {
  [[ "$(uname -s)" == "Linux" ]] || {
    printf 'Grok Build %s is supported only on Linux.\n' "${GROK_BUILD_TESTED_VERSION}" >&2
    return 1
  }

  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' 'x86_64' ;;
    aarch64|arm64) printf '%s\n' 'aarch64' ;;
    *)
      printf 'Unsupported Grok Build architecture: %s\n' "$(uname -m)" >&2
      return 1
      ;;
  esac
}

grok_build_expected_sha256() {
  case "$1" in
    x86_64) printf '%s\n' "${GROK_BUILD_SHA256_X86_64}" ;;
    aarch64) printf '%s\n' "${GROK_BUILD_SHA256_AARCH64}" ;;
    *) return 1 ;;
  esac
}

grok_build_download() {
  local arch="$1"
  local destination="$2"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    --output "${destination}" \
    "${GROK_BUILD_DOWNLOAD_ROOT}/grok-${GROK_BUILD_TESTED_VERSION}-linux-${arch}"
}

verify_grok_build_checksum() {
  local binary="$1"
  local expected="$2"
  local actual
  actual="$(sha256sum "${binary}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || {
    printf 'Grok Build checksum mismatch (expected %s, received %s).\n' "${expected}" "${actual}" >&2
    return 1
  }
}

grok_build_binary_version() {
  local binary="$1"
  local output semver_pattern
  output="$(GROK_DISABLE_AUTOUPDATER=1 "${binary}" --no-auto-update --version 2>/dev/null)" || return 1
  semver_pattern='(^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?)([^0-9.]|$)'
  [[ "${output}" =~ ${semver_pattern} ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]}"
}

verify_grok_build_binary() {
  local binary="$1"
  [[ -x "${binary}" ]] || return 1
  [[ "$(grok_build_binary_version "${binary}" || true)" == "${GROK_BUILD_TESTED_VERSION}" ]]
}

grok_build_target() {
  printf '%s/grok\n' "${GROK_BIN_DIR:-/usr/local/bin}"
}

grok_build_verify() {
  local target
  target="$(grok_build_target)"
  verify_grok_build_binary "${target}" || {
    printf 'Grok Build is missing or is not the Portal-tested version %s at %s.\n' \
      "${GROK_BUILD_TESTED_VERSION}" "${target}" >&2
    return 1
  }
  printf 'Grok Build %s is verified at %s.\n' "${GROK_BUILD_TESTED_VERSION}" "${target}"
}

grok_build_converge() {
  local bin_dir target arch expected_sha work_dir staged backup had_previous=false
  bin_dir="${GROK_BIN_DIR:-/usr/local/bin}"
  target="${bin_dir}/grok"

  if [[ "${bin_dir}" == "/usr/local/bin" && "${EUID}" -ne 0 ]]; then
    printf 'Installing Grok Build into /usr/local/bin requires root.\n' >&2
    return 1
  fi

  if verify_grok_build_binary "${target}"; then
    printf 'Grok Build %s is already verified at %s.\n' "${GROK_BUILD_TESTED_VERSION}" "${target}"
    return 0
  fi

  arch="$(grok_build_arch)" || return 1
  expected_sha="$(grok_build_expected_sha256 "${arch}")" || return 1
  install -d -m 0755 "${bin_dir}"
  work_dir="$(mktemp -d "${bin_dir}/.grok-build-${GROK_BUILD_TESTED_VERSION}.XXXXXX")"
  staged="${work_dir}/grok.new"
  backup="${work_dir}/grok.previous"

  if ! grok_build_download "${arch}" "${staged}"; then
    printf 'Could not download the pinned Grok Build artifact.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi
  if ! verify_grok_build_checksum "${staged}" "${expected_sha}"; then
    rm -rf -- "${work_dir}"
    return 1
  fi
  chmod 0755 "${staged}"
  if ! verify_grok_build_binary "${staged}"; then
    printf 'Downloaded Grok Build artifact failed exact version verification.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi

  if [[ -e "${target}" || -L "${target}" ]]; then
    cp -a -- "${target}" "${backup}"
    had_previous=true
  fi

  mv -f -- "${staged}" "${target}"
  if ! verify_grok_build_binary "${target}"; then
    printf 'Installed Grok Build failed verification; restoring the previous binary.\n' >&2
    if ${had_previous}; then
      mv -f -- "${backup}" "${target}"
    else
      rm -f -- "${target}"
    fi
    rm -rf -- "${work_dir}"
    return 1
  fi

  rm -rf -- "${work_dir}"
  printf 'Grok Build %s installed and verified at %s.\n' "${GROK_BUILD_TESTED_VERSION}" "${target}"
}

grok_build_main() {
  case "${1:-status}" in
    converge|install|update) grok_build_converge ;;
    verify|status) grok_build_verify ;;
    *)
      printf 'Usage: %s {converge|verify|status}\n' "${0##*/}" >&2
      return 2
      ;;
  esac
}

if [[ "${GROK_BUILD_RUNTIME_SOURCE_ONLY:-0}" != "1" ]]; then
  grok_build_main "$@"
fi
