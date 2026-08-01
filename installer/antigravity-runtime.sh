#!/usr/bin/env bash
set -Eeuo pipefail

# Portal-tested Google Antigravity CLI runtime. The upstream bootstrapper uses
# a mutable latest manifest and intentionally leaves an existing binary alone,
# so it cannot converge or roll back a Portal compatibility pair. These URLs
# and SHA-512 values are copied from Google's official release manifest for 1.1.7.
readonly ANTIGRAVITY_TESTED_VERSION="1.1.7"
readonly ANTIGRAVITY_SHA512_X86_64="720d5a7ff256aa5dd6712513cd5eb6fe031cf9e7523a33bcbda7755120ced53bb64ff985b402ce068e5895e0ffb348c2632545039a1dde6daad591f164d5852f"
readonly ANTIGRAVITY_SHA512_AARCH64="6b42366c3926994785301af43e01f595c5b8e43eb521166d98478539368b0daafb3211000fb2280ade6a37da0a6c438ef28abc2c82b6c8263017b245878fc506"
readonly ANTIGRAVITY_URL_X86_64="https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.7-5951805767680000/linux-x64/cli_linux_x64.tar.gz"
readonly ANTIGRAVITY_URL_AARCH64="https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.7-5951805767680000/linux-arm/cli_linux_arm64.tar.gz"
readonly ANTIGRAVITY_MAX_ARCHIVE_BYTES=$((128 * 1024 * 1024))

antigravity_arch() {
  [[ "$(uname -s)" == "Linux" ]] || {
    printf 'Antigravity %s is supported only on Linux.\n' "${ANTIGRAVITY_TESTED_VERSION}" >&2
    return 1
  }
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' 'x86_64' ;;
    aarch64|arm64) printf '%s\n' 'aarch64' ;;
    *)
      printf 'Unsupported Antigravity architecture: %s\n' "$(uname -m)" >&2
      return 1
      ;;
  esac
}

antigravity_url() {
  case "$1" in
    x86_64) printf '%s\n' "${ANTIGRAVITY_URL_X86_64}" ;;
    aarch64) printf '%s\n' "${ANTIGRAVITY_URL_AARCH64}" ;;
    *) return 1 ;;
  esac
}

antigravity_sha512() {
  case "$1" in
    x86_64) printf '%s\n' "${ANTIGRAVITY_SHA512_X86_64}" ;;
    aarch64) printf '%s\n' "${ANTIGRAVITY_SHA512_AARCH64}" ;;
    *) return 1 ;;
  esac
}

antigravity_binary_version() {
  local binary="$1" output
  output="$(AGY_CLI_DISABLE_AUTO_UPDATE=1 "${binary}" --version 2>/dev/null)" || return 1
  printf '%s\n' "${output}" | sed -nE 's/.*(^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)([^0-9].*|$)/\2/p' | head -1
}

verify_antigravity_binary() {
  local binary="$1"
  [[ -x "${binary}" ]] || return 1
  [[ "$(antigravity_binary_version "${binary}" || true)" == "${ANTIGRAVITY_TESTED_VERSION}" ]]
}

antigravity_target() {
  printf '%s/agy\n' "${ANTIGRAVITY_BIN_DIR:-/usr/local/bin}"
}

antigravity_verify() {
  local target
  target="$(antigravity_target)"
  verify_antigravity_binary "${target}" || {
    printf 'Antigravity is missing or is not the Portal-tested version %s at %s.\n' \
      "${ANTIGRAVITY_TESTED_VERSION}" "${target}" >&2
    return 1
  }
  printf 'Antigravity %s is verified at %s.\n' "${ANTIGRAVITY_TESTED_VERSION}" "${target}"
}

verify_antigravity_archive() {
  local archive="$1" expected="$2" actual size members
  size="$(stat -c '%s' "${archive}")"
  (( size > 0 && size <= ANTIGRAVITY_MAX_ARCHIVE_BYTES )) || {
    printf 'Antigravity archive size is outside the allowed range.\n' >&2
    return 1
  }
  actual="$(sha512sum "${archive}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || {
    printf 'Antigravity checksum mismatch (expected %s, received %s).\n' "${expected}" "${actual}" >&2
    return 1
  }
  members="$(tar -tzf "${archive}")" || return 1
  [[ "${members}" == "antigravity" ]] || {
    printf 'Antigravity archive contains unexpected entries.\n' >&2
    return 1
  }
}

antigravity_converge() {
  local bin_dir target arch url expected work_dir archive staged backup had_previous=false
  bin_dir="${ANTIGRAVITY_BIN_DIR:-/usr/local/bin}"
  target="${bin_dir}/agy"

  if [[ "${bin_dir}" == "/usr/local/bin" && "${EUID}" -ne 0 ]]; then
    printf 'Installing Antigravity into /usr/local/bin requires root.\n' >&2
    return 1
  fi
  if verify_antigravity_binary "${target}"; then
    printf 'Antigravity %s is already verified at %s.\n' "${ANTIGRAVITY_TESTED_VERSION}" "${target}"
    return 0
  fi

  arch="$(antigravity_arch)" || return 1
  url="$(antigravity_url "${arch}")" || return 1
  expected="$(antigravity_sha512 "${arch}")" || return 1
  install -d -m 0755 "${bin_dir}"
  work_dir="$(mktemp -d "${bin_dir}/.antigravity-${ANTIGRAVITY_TESTED_VERSION}.XXXXXX")"
  archive="${work_dir}/antigravity.tar.gz"
  staged="${work_dir}/agy.new"
  backup="${work_dir}/agy.previous"

  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --max-filesize "${ANTIGRAVITY_MAX_ARCHIVE_BYTES}" --output "${archive}" "${url}"; then
    printf 'Could not download the pinned Antigravity artifact.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi
  if ! verify_antigravity_archive "${archive}" "${expected}"; then
    rm -rf -- "${work_dir}"
    return 1
  fi
  tar -xOzf "${archive}" antigravity > "${staged}"
  chmod 0755 "${staged}"
  if ! verify_antigravity_binary "${staged}"; then
    printf 'Downloaded Antigravity artifact failed exact version verification.\n' >&2
    rm -rf -- "${work_dir}"
    return 1
  fi

  if [[ -e "${target}" || -L "${target}" ]]; then
    cp -a -- "${target}" "${backup}"
    had_previous=true
  fi
  mv -f -- "${staged}" "${target}"
  if ! verify_antigravity_binary "${target}"; then
    printf 'Installed Antigravity failed verification; restoring the previous binary.\n' >&2
    if ${had_previous}; then mv -f -- "${backup}" "${target}"; else rm -f -- "${target}"; fi
    rm -rf -- "${work_dir}"
    return 1
  fi

  rm -rf -- "${work_dir}"
  printf 'Antigravity %s installed and verified at %s.\n' "${ANTIGRAVITY_TESTED_VERSION}" "${target}"
}

case "${1:-status}" in
  converge|install|update) antigravity_converge ;;
  verify|status) antigravity_verify ;;
  *)
    printf 'Usage: %s {converge|verify|status}\n' "${0##*/}" >&2
    exit 2
    ;;
esac
