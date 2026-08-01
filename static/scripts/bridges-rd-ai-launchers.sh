#!/usr/bin/env bash
# Truthful launchers for Portal-managed AI runtimes in BridgesLLM Remote Desktop.
#
# The catalog below is the only runtime identity source. A launcher records its
# Portal runtime intent, interaction mode, authentication boundary, and exact
# resolved target. Consumer websites are not substitutes for Portal CLIs.
#
# Agent Zero is deliberately fail-closed. Its loopback login page cannot be
# handed to the Remote Desktop user with static credentials, and Portal CLI
# OAuth state must never be converted into browser cookies. A future backend
# integration must mint a short-lived, single-use, current-user-bound browser
# exchange at click time. Until that contract exists, an installed Agent Zero
# runtime makes `verify` report a precise readiness blocker and no shortcut is
# emitted.
set -Eeuo pipefail

readonly RD_USER="${BRIDGES_RD_USER:-bridgesrd}"
readonly RD_HOME="${BRIDGES_RD_HOME:-/home/${RD_USER}}"
readonly DESKTOP_DIR="${BRIDGES_RD_DESKTOP_DIR:-${RD_HOME}/Desktop}"
readonly STATE_DIR="${BRIDGES_RD_LAUNCHER_STATE_DIR:-/var/lib/bridgesllm/remote-desktop-ai-launchers}"
readonly MANIFEST="${STATE_DIR}/manifest.tsv"
readonly MUTATION_LOCK="${BRIDGES_RD_LAUNCHER_LOCK_PATH:-${STATE_DIR}.lock}"
readonly PIXMAP_DIR="${BRIDGES_RD_PIXMAP_DIR:-/usr/local/share/pixmaps}"
readonly PROFILE_ROOT="${BRIDGES_RD_PROFILE_ROOT:-${RD_HOME}/.config/bridges-ai-runtime-browser}"
readonly LEGACY_PROFILE_ROOT="${RD_HOME}/.config/bridges-ai-provider-browser"
readonly APPLICATION_DIRS="${BRIDGES_RD_APPLICATION_DIRS:-/usr/local/share/applications:/usr/share/applications:${RD_HOME}/.local/share/applications}"
readonly RUNTIME_BIN_DIRS="${BRIDGES_RD_RUNTIME_BIN_DIRS:-/usr/local/bin:/usr/bin:/bin}"
readonly SELF_PATH="${BRIDGES_RD_AI_LAUNCHER_PATH:-/usr/local/bin/bridges-rd-ai-launchers.sh}"
readonly CATALOG_HEADER='# bridgesllm-ai-runtime-catalog-v1'
readonly CATALOG_COLUMNS='# runtime-id	label	intent	mode	target	args	env	launch-policy	desktop-file	icon-file	debug-port	auth-policy	icon-sha256	comment'
readonly MANIFEST_HEADER='# bridgesllm-ai-runtime-launchers-v2'
readonly MANIFEST_COLUMNS='# runtime-id	label	intent	mode	resolved-target	args	env	launch-policy	desktop-file	icon-file	debug-port	auth-policy	icon-sha256	comment'
readonly LEGACY_MANIFEST_HEADER='# bridgesllm-ai-launchers-v1'

changed=0
mutation_lock_fd=''
install_manifest_temporary=''
install_manifest_temporary_identity=''
install_asset_temporary=''
install_asset_temporary_identity=''
install_asset_temporary_label=''
verification_lock_fd=''
verify_manifest_temporary=''
verify_manifest_temporary_identity=''

usage() {
  printf 'Usage: %s catalog | install --assets-dir DIR | verify | launch RUNTIME | terminal RUNTIME | remove [--purge-profiles]\n' "$0" >&2
  exit 64
}

require_root() {
  if [[ "$(id -u)" != "0" ]]; then
    printf 'AI runtime launcher %s requires root\n' "${1:-operation}" >&2
    exit 77
  fi
}

validate_managed_paths() {
  [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" == '1' ]] && return 0
  [[ "$RD_USER" == 'bridgesrd'
    && "$RD_HOME" == '/home/bridgesrd'
    && "$DESKTOP_DIR" == '/home/bridgesrd/Desktop'
    && "$STATE_DIR" == '/var/lib/bridgesllm/remote-desktop-ai-launchers'
    && "$MANIFEST" == '/var/lib/bridgesllm/remote-desktop-ai-launchers/manifest.tsv'
    && "$MUTATION_LOCK" == '/var/lib/bridgesllm/remote-desktop-ai-launchers.lock'
    && "$PIXMAP_DIR" == '/usr/local/share/pixmaps'
    && "$PROFILE_ROOT" == '/home/bridgesrd/.config/bridges-ai-runtime-browser'
    && "$APPLICATION_DIRS" == '/usr/local/share/applications:/usr/share/applications:/home/bridgesrd/.local/share/applications'
    && "$RUNTIME_BIN_DIRS" == '/usr/local/bin:/usr/bin:/bin'
    && "$SELF_PATH" == '/usr/local/bin/bridges-rd-ai-launchers.sh' ]] || {
      printf 'AI runtime launcher managed path contract is invalid\n' >&2
      exit 1
    }
}

reject_linked_directory() {
  local directory="$1" cursor="$1"
  [[ ! -e "$directory" || -d "$directory" ]] || {
    printf 'AI runtime launcher directory is not a directory: %s\n' "$directory" >&2
    exit 1
  }
  while [[ "$cursor" != '/' && "$cursor" != '.' && -n "$cursor" ]]; do
    [[ ! -L "$cursor" ]] || {
      printf 'AI runtime launcher directory contains a symbolic-link boundary: %s\n' "$directory" >&2
      exit 1
    }
    cursor="$(dirname -- "$cursor")"
  done
}

acquire_mutation_lock() {
  local lock_parent lock_fd_identity lock_path_identity
  lock_parent="$(dirname -- "$MUTATION_LOCK")"
  reject_linked_directory "$lock_parent"
  if [[ ! -e "$lock_parent" && ! -L "$lock_parent" ]]; then
    if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" == '1' ]]; then
      install -d -m 0755 "$lock_parent"
    else
      install -o root -g root -d -m 0755 "$lock_parent"
    fi
  fi
  reject_linked_directory "$lock_parent"
  if [[ ! -e "$MUTATION_LOCK" && ! -L "$MUTATION_LOCK" ]]; then
    ( umask 077; set -o noclobber; : > "$MUTATION_LOCK" ) 2>/dev/null || true
  fi
  [[ -f "$MUTATION_LOCK" && ! -L "$MUTATION_LOCK"
    && "$(stat -c '%a' "$MUTATION_LOCK")" == '600' ]] \
    || { printf 'AI runtime launcher mutation lock is linked, non-regular, or has an unsafe mode\n' >&2; exit 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    [[ "$(stat -c '%u:%g' "$MUTATION_LOCK")" == '0:0' ]] \
      || { printf 'AI runtime launcher mutation lock is not root-owned and root-grouped\n' >&2; exit 1; }
  fi
  exec {mutation_lock_fd}<>"$MUTATION_LOCK"
  flock -x "$mutation_lock_fd"
  lock_fd_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/${mutation_lock_fd}")"
  lock_path_identity="$(stat -Lc '%d:%i' "$MUTATION_LOCK")"
  [[ -f "$MUTATION_LOCK" && ! -L "$MUTATION_LOCK"
    && "$(stat -c '%a' "$MUTATION_LOCK")" == '600'
    && "$lock_fd_identity" == "$lock_path_identity" ]] \
    || { printf 'AI runtime launcher mutation lock changed while it was acquired\n' >&2; exit 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    [[ "$(stat -c '%u:%g' "$MUTATION_LOCK")" == '0:0' ]] \
      || { printf 'AI runtime launcher mutation lock ownership changed while it was acquired\n' >&2; exit 1; }
  fi
}

acquire_verification_lock() {
  local lock_fd_identity lock_path_identity
  [[ -f "$MUTATION_LOCK" && ! -L "$MUTATION_LOCK"
    && "$(stat -c '%a' "$MUTATION_LOCK")" == '600' ]] \
    || { printf 'AI runtime launcher lifecycle lock is missing or unsafe\n' >&2; return 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    [[ "$(stat -c '%u:%g' "$MUTATION_LOCK")" == '0:0' ]] \
      || { printf 'AI runtime launcher lifecycle lock is not root-owned and root-grouped\n' >&2; return 1; }
  fi
  exec {verification_lock_fd}<"$MUTATION_LOCK"
  flock -s "$verification_lock_fd"
  lock_fd_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/${verification_lock_fd}")"
  lock_path_identity="$(stat -Lc '%d:%i' "$MUTATION_LOCK")"
  [[ -f "$MUTATION_LOCK" && ! -L "$MUTATION_LOCK"
    && "$(stat -c '%a' "$MUTATION_LOCK")" == '600'
    && "$lock_fd_identity" == "$lock_path_identity" ]] \
    || { printf 'AI runtime launcher lifecycle lock changed while verification waited\n' >&2; return 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    [[ "$(stat -c '%u:%g' "$MUTATION_LOCK")" == '0:0' ]] \
      || { printf 'AI runtime launcher lifecycle lock ownership changed while verification waited\n' >&2; return 1; }
  fi
}

ensure_state_directory_under_lock() {
  if [[ ! -e "$STATE_DIR" && ! -L "$STATE_DIR" ]]; then
    if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" == '1' ]]; then
      install -d -m 0755 "$STATE_DIR"
    else
      install -o root -g root -d -m 0755 "$STATE_DIR"
    fi
  fi
  reject_linked_directory "$STATE_DIR"
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" && "$(stat -c '%a' "$STATE_DIR")" == '755' ]] \
    || { printf 'AI runtime launcher state directory is linked, non-directory, or has an unsafe mode\n' >&2; return 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    [[ "$(stat -c '%u:%g' "$STATE_DIR")" == '0:0' ]] \
      || { printf 'AI runtime launcher state directory is not root-owned and root-grouped\n' >&2; return 1; }
  fi
}

cleanup_stale_temporary_path() {
  local target="$1" label="$2" allowed_modes="$3" mode expected_identity
  [[ -f "$target" && ! -L "$target" && "$(stat -c '%h' "$target")" == '1' ]] \
    || { printf 'Refusing unsafe stale AI runtime launcher temporary %s: %s\n' "$label" "$target" >&2; return 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    [[ "$(stat -c '%u:%g' "$target")" == '0:0' ]] \
      || { printf 'Refusing non-root stale AI runtime launcher temporary %s: %s\n' "$label" "$target" >&2; return 1; }
  fi
  mode="$(stat -c '%a' "$target")"
  case ":${allowed_modes}:" in
    *":${mode}:"*) ;;
    *) printf 'Refusing stale AI runtime launcher temporary %s with unsafe mode: %s\n' "$label" "$target" >&2; return 1 ;;
  esac
  expected_identity="$(path_identity "$target")"
  cleanup_temporary_artifact "$target" "$expected_identity" "stale-${label}"
}

cleanup_stale_managed_temporaries() {
  local target runtime_id label intent mode declared_target args_spec env_spec launch_policy
  local desktop_file icon_file debug_port auth_policy icon_sha comment
  while IFS= read -r -d '' target; do
    cleanup_stale_temporary_path "$target" manifest '600:644'
  done < <(
    find "$STATE_DIR" -mindepth 1 -maxdepth 1 \
      \( -name 'manifest.tmp.??????' -o -name 'verify-manifest.tmp.??????' \) -print0
  )
  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    if [[ -d "$DESKTOP_DIR" && ! -L "$DESKTOP_DIR" ]]; then
      while IFS= read -r -d '' target; do
        cleanup_stale_temporary_path "$target" desktop '600:755'
      done < <(find "$DESKTOP_DIR" -mindepth 1 -maxdepth 1 -name "${desktop_file}.tmp.??????" -print0)
    fi
    if [[ -d "$PIXMAP_DIR" && ! -L "$PIXMAP_DIR" ]]; then
      while IFS= read -r -d '' target; do
        cleanup_stale_temporary_path "$target" icon '600:644'
      done < <(find "$PIXMAP_DIR" -mindepth 1 -maxdepth 1 -name "${icon_file}.tmp.??????" -print0)
    fi
  done < <(runtime_catalog)
}

run_test_before_mutation_hook() {
  local operation="$1" target="$2" hook="${BRIDGES_RD_TEST_BEFORE_MUTATION_HOOK:-}"
  [[ -n "$hook" ]] || return 0
  [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" == '1' && -f "$hook" && ! -L "$hook" && -x "$hook" ]] \
    || { printf 'AI runtime launcher mutation test hook is invalid\n' >&2; return 1; }
  "$hook" "$operation" "$target"
}

path_identity() {
  local target="$1"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    printf 'absent\n'
    return 0
  fi
  [[ -f "$target" && ! -L "$target" ]] || return 1
  stat -c '%d:%i' "$target"
}

assert_path_identity() {
  local target="$1" expected="$2" actual
  actual="$(path_identity "$target" || true)"
  [[ -n "$actual" && "$actual" == "$expected" ]] \
    || { printf 'Refusing AI runtime launcher mutation after path identity changed: %s\n' "$target" >&2; return 1; }
}

cleanup_temporary_artifact() {
  local temporary="$1" expected_identity="$2" label="$3" actual_identity
  if [[ ! -e "$temporary" && ! -L "$temporary" ]]; then
    return 0
  fi
  actual_identity="$(path_identity "$temporary" || true)"
  if [[ -z "$expected_identity" || "$actual_identity" != "$expected_identity" ]]; then
    printf 'Preserved replaced AI runtime launcher temporary %s: %s\n' "$label" "$temporary" >&2
    return 1
  fi
  rm -f -- "$temporary" \
    || { printf 'Could not remove AI runtime launcher temporary %s: %s\n' "$label" "$temporary" >&2; return 1; }
}

cleanup_install_manifest_temporary() {
  local temporary="${install_manifest_temporary:-}" expected_identity="${install_manifest_temporary_identity:-}" cleanup_status=0
  [[ -n "$temporary" ]] || return 0
  cleanup_temporary_artifact "$temporary" "$expected_identity" manifest || cleanup_status=1
  install_manifest_temporary=''
  install_manifest_temporary_identity=''
  return "$cleanup_status"
}

cleanup_install_asset_temporary() {
  local temporary="${install_asset_temporary:-}" expected_identity="${install_asset_temporary_identity:-}"
  local label="${install_asset_temporary_label:-asset}" cleanup_status=0
  [[ -n "$temporary" ]] || return 0
  cleanup_temporary_artifact "$temporary" "$expected_identity" "$label" || cleanup_status=1
  install_asset_temporary=''
  install_asset_temporary_identity=''
  install_asset_temporary_label=''
  return "$cleanup_status"
}

cleanup_install_temporaries() {
  local cleanup_status=0
  cleanup_install_asset_temporary || cleanup_status=1
  cleanup_install_manifest_temporary || cleanup_status=1
  return "$cleanup_status"
}

cleanup_verify_manifest_temporary() {
  local temporary="${verify_manifest_temporary:-}" expected_identity="${verify_manifest_temporary_identity:-}" cleanup_status=0
  [[ -n "$temporary" ]] || return 0
  cleanup_temporary_artifact "$temporary" "$expected_identity" verification-manifest || cleanup_status=1
  verify_manifest_temporary=''
  verify_manifest_temporary_identity=''
  return "$cleanup_status"
}

# runtime-id, label, intent, mode, target, args, env, launch-policy,
# desktop-file, icon-file, debug-port, auth-policy, icon-sha256, comment
runtime_catalog() {
  cat <<'CATALOG'
claude-code	Claude Code (Terminal Runtime)	portal-runtime	terminal-tui	claude	-	-	interactive	AI - Claude Code (Terminal Runtime).desktop	bridges-ai-claude-code.svg	-	separate-cli-sign-in	8c8c765d69721d27307a298635243e67189570d3180bf3fa3ff6c70ce05ad8cc	Launch the Portal-tested Claude Code CLI in a terminal; this desktop account signs in separately.
codex	OpenAI Codex (Terminal Runtime)	portal-runtime	terminal-tui	codex	-	-	interactive	AI - OpenAI Codex (Terminal Runtime).desktop	bridges-ai-codex.svg	-	separate-cli-sign-in	220dcafe29c54634a031837ade54f56c800b9d0ec4df8393af455da9d895b127	Launch the Portal-tested Codex CLI in a terminal; this desktop account signs in separately.
grok-build	Grok Build (Terminal Runtime)	portal-runtime	terminal-tui	grok	--no-auto-update	GROK_DISABLE_AUTOUPDATER=1	interactive	AI - Grok Build (Terminal Runtime).desktop	bridges-ai-grok-build.svg	-	separate-cli-sign-in	0ee119300f955f87c36e31f65cba40320f1f467609ca92925c64f956f44efcc6	Launch the Portal-tested Grok Build CLI in a terminal; this desktop account signs in separately.
antigravity	Google Antigravity (Terminal Runtime)	portal-runtime	terminal-tui	agy	-	AGY_CLI_DISABLE_AUTO_UPDATE=1	interactive	AI - Google Antigravity (Terminal Runtime).desktop	bridges-ai-antigravity.svg	-	separate-cli-sign-in	8ef70288b94d1edfd0bb2698af4d445fd6422bf1419d5aa2da51618d4309b004	Launch the Portal-tested Antigravity CLI in a terminal; this desktop account signs in separately.
agent-zero	Agent Zero (Web UI)	portal-runtime	local-web	backend-session-exchange-v2	-	-	backend-session-exchange	AI - Agent Zero (Web UI).desktop	bridges-ai-agent-zero.svg	18815	backend-session-exchange	0e0b4dcf2cb6fecf8083202e79144f6a0dccae9b3b17258fdd72c4391fd9724a	Open the Agent Zero web UI, signed in through a click-time backend session exchange; no credentials touch this desktop.
ollama	Ollama (Local Runtime Terminal)	portal-runtime	terminal-tui	ollama	list	-	status-shell	AI - Ollama (Local Runtime Terminal).desktop	bridges-ai-ollama.svg	-	none	4d01b7f24701b566feebb9a866210a214fc7af681af31089e93ea8169c0e47d1	Inspect the installed local Ollama runtime and continue in a terminal shell.
CATALOG
}

# provider, label, default-url, desktop-file, icon-file, debug-port, icon-sha256
legacy_catalog() {
  cat <<'CATALOG'
chatgpt	ChatGPT	https://chatgpt.com	AI - ChatGPT.desktop	bridges-ai-chatgpt.svg	18811	51ee603939cdd71a24b69ae05e055d78b3b5d9cf4baa176af2b82f119f1c1eb3
claude	Claude	https://claude.ai	AI - Claude.desktop	bridges-ai-claude.svg	18812	908cb4ba6c1a3437df6055056cfdceebbe4af9d15dd0db5ea7465bf3f46505d5
gemini	Google Gemini	https://gemini.google.com	AI - Gemini.desktop	bridges-ai-gemini.svg	18813	ad7ad94f09b2eff9a53ca3e448974fb97cd154f269b60a81060523c2df45ed0e
grok	xAI Grok	https://grok.com	AI - Grok.desktop	bridges-ai-grok.svg	18814	3c045c5b97ac4adc7e3ea37b4b60ac7df614e86330131f3365060faca432ad58
agent-zero	Agent Zero	-	AI - Agent Zero.desktop	bridges-ai-agent-zero.svg	18815	2a3d4c8106672f16c86848b1571d6c25c1b8e26f20ee1f91eb393b50b71c2eba
ollama	Ollama UI	-	AI - Ollama.desktop	bridges-ai-ollama.svg	18816	170ac821a8af3bca3fafc83c8729d1760b363d28020de1e5b010d01840fc4b6f
CATALOG
}

validate_catalog() {
  local runtime_id label intent mode target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment extra row_count=0
  declare -A seen_runtime=() seen_desktop=() seen_icon=() seen_port=()
  while IFS=$'\t' read -r runtime_id label intent mode target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment extra; do
    [[ -n "$runtime_id" ]] || continue
    [[ -z "${extra:-}" ]] || { printf 'AI runtime catalog row has too many columns: %s\n' "$runtime_id" >&2; return 1; }
    [[ "$runtime_id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { printf 'AI runtime catalog id is invalid: %s\n' "$runtime_id" >&2; return 1; }
    [[ -z "${seen_runtime[$runtime_id]:-}" ]] || { printf 'AI runtime catalog id is duplicated: %s\n' "$runtime_id" >&2; return 1; }
    [[ "$intent" == 'portal-runtime' || "$intent" == 'vendor-site' ]] \
      || { printf 'AI runtime catalog intent is invalid for %s\n' "$runtime_id" >&2; return 1; }
    case "$mode" in
      native-gui|local-web|terminal-tui|vendor-site) ;;
      *) printf 'AI runtime catalog mode is invalid for %s: %s\n' "$runtime_id" "$mode" >&2; return 1 ;;
    esac
    [[ "$desktop_file" =~ ^AI\ -\ [A-Za-z0-9][A-Za-z0-9\ \(\)-]*\.desktop$ ]] \
      || { printf 'AI runtime desktop filename is invalid for %s\n' "$runtime_id" >&2; return 1; }
    [[ "$icon_file" =~ ^bridges-ai-[a-z0-9-]+\.svg$ ]] \
      || { printf 'AI runtime icon filename is invalid for %s\n' "$runtime_id" >&2; return 1; }
    [[ "$icon_sha" =~ ^[a-f0-9]{64}$ ]] || { printf 'AI runtime icon digest is invalid for %s\n' "$runtime_id" >&2; return 1; }
    [[ -z "${seen_desktop[$desktop_file]:-}" && -z "${seen_icon[$icon_file]:-}" ]] \
      || { printf 'AI runtime catalog asset is duplicated for %s\n' "$runtime_id" >&2; return 1; }
    if [[ "$debug_port" != '-' ]]; then
      [[ "$debug_port" =~ ^[1-9][0-9]{0,4}$ ]] && (( debug_port <= 65535 )) \
        || { printf 'AI runtime debug port is invalid for %s\n' "$runtime_id" >&2; return 1; }
      [[ -z "${seen_port[$debug_port]:-}" ]] || { printf 'AI runtime debug port is duplicated: %s\n' "$debug_port" >&2; return 1; }
      seen_port["$debug_port"]=1
    fi
    [[ "$args_spec" == '-' || "$args_spec" =~ ^[A-Za-z0-9._/:+=-]+([[:space:]][A-Za-z0-9._/:+=-]+)*$ ]] \
      || { printf 'AI runtime arguments are invalid for %s\n' "$runtime_id" >&2; return 1; }
    [[ "$env_spec" == '-' || "$env_spec" =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9._/:+-]+$ ]] \
      || { printf 'AI runtime environment is invalid for %s\n' "$runtime_id" >&2; return 1; }
    case "$mode" in
      terminal-tui)
        [[ "$intent" == 'portal-runtime' ]] \
          || { printf 'AI terminal catalog intent is invalid for %s\n' "$runtime_id" >&2; return 1; }
        [[ "$target" =~ ^[a-z][a-z0-9-]*$ && "$debug_port" == '-' ]] \
          || { printf 'AI terminal runtime target is invalid for %s\n' "$runtime_id" >&2; return 1; }
        [[ "$label" == *'Terminal'* || "$label" == *'Runtime'* ]] \
          || { printf 'AI terminal runtime label hides its mode for %s\n' "$runtime_id" >&2; return 1; }
        [[ "$launch_policy" == 'interactive' || "$launch_policy" == 'status-shell' ]] \
          || { printf 'AI terminal launch policy is invalid for %s\n' "$runtime_id" >&2; return 1; }
        [[ "$auth_policy" == 'separate-cli-sign-in' || "$auth_policy" == 'none' ]] \
          || { printf 'AI terminal authentication policy is invalid for %s\n' "$runtime_id" >&2; return 1; }
        ;;
      local-web)
        [[ "$intent" == 'portal-runtime' && "$label" == *'Web UI'* && "$launch_policy" == 'backend-session-exchange'
          && "$auth_policy" == 'backend-session-exchange' ]] \
          || { printf 'AI local web catalog entry lacks a backend session-exchange contract for %s\n' "$runtime_id" >&2; return 1; }
        ;;
      vendor-site)
        [[ "$intent" == 'vendor-site' && "$target" =~ ^https://[^[:space:]]+$ && "$label" == *'Website'* && "$label" == *'Sign-in Required'*
          && "$auth_policy" == 'separate-browser-sign-in' ]] \
          || { printf 'AI vendor website entry is not labeled sign-in-required for %s\n' "$runtime_id" >&2; return 1; }
        ;;
      native-gui)
        [[ "$intent" == 'portal-runtime' && "$target" =~ ^(desktop|binary):[A-Za-z0-9._-]+$ && "$auth_policy" != 'one-time-session-exchange' ]] \
          || { printf 'AI native GUI target is invalid for %s\n' "$runtime_id" >&2; return 1; }
        ;;
    esac
    case "$target" in
      *chatgpt.com*|*claude.ai*|*gemini.google.com*|*grok.com*)
        if [[ "$intent" != 'vendor-site' || "$mode" != 'vendor-site' ]]; then
          printf 'AI runtime catalog substitutes a consumer website for %s\n' "$runtime_id" >&2
          return 1
        fi
        ;;
    esac
    seen_runtime["$runtime_id"]=1
    seen_desktop["$desktop_file"]=1
    seen_icon["$icon_file"]=1
    row_count=$((row_count + 1))
  done < <(runtime_catalog)
  (( row_count > 0 )) || { printf 'AI runtime catalog is empty\n' >&2; return 1; }
}

catalog_row() {
  local requested="$1"
  runtime_catalog | awk -F '\t' -v runtime_id="$requested" '$1 == runtime_id { print; found=1; exit } END { if (!found) exit 1 }'
}

print_catalog() {
  validate_catalog
  printf '%s\n%s\n' "$CATALOG_HEADER" "$CATALOG_COLUMNS"
  runtime_catalog
}

find_runtime_binary() {
  local name="$1" directory candidate
  [[ "$name" =~ ^[a-zA-Z0-9._-]+$ ]] || return 1
  IFS=':' read -r -a runtime_dirs <<< "$RUNTIME_BIN_DIRS"
  for directory in "${runtime_dirs[@]}"; do
    [[ "$directory" == /* && -d "$directory" && ! -L "$directory" ]] || continue
    candidate="${directory}/${name}"
    if [[ -x "$candidate" && ! -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

runtime_expected_version() {
  case "$1" in
    claude-code) printf '%s\n' '2.1.220' ;;
    codex) printf '%s\n' '0.145.0' ;;
    grok-build) printf '%s\n' '0.2.112' ;;
    antigravity) printf '%s\n' '1.1.7' ;;
    ollama) printf '%s\n' 'semver' ;;
    *) return 1 ;;
  esac
}

runtime_version_probe() {
  local runtime_id="$1" binary="$2" env_spec="$3"
  local -a clean_env=(
    "HOME=$RD_HOME"
    "USER=$RD_USER"
    "LOGNAME=$RD_USER"
    'SHELL=/bin/bash'
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    'LANG=C.UTF-8'
  )
  local -a version_args=(--version)
  [[ "$env_spec" == '-' ]] || clean_env+=("$env_spec")
  [[ "$runtime_id" != 'grok-build' ]] || version_args=(--no-auto-update --version)
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' && "$(id -u)" == '0' && "$RD_USER" != 'root' ]]; then
    /usr/bin/timeout 3 /usr/bin/setpriv --reuid="$RD_USER" --regid="$RD_USER" --init-groups -- \
      /usr/bin/env -i "${clean_env[@]}" "$binary" "${version_args[@]}" 2>&1
  else
    /usr/bin/timeout 3 /usr/bin/env -i "${clean_env[@]}" "$binary" "${version_args[@]}" 2>&1
  fi
}

verify_runtime_binary_contract() {
  local runtime_id="$1" binary="$2" env_spec="$3" expected output escaped
  expected="$(runtime_expected_version "$runtime_id")" || return 1
  output="$(runtime_version_probe "$runtime_id" "$binary" "$env_spec")" || return 1
  if [[ "$expected" == 'semver' ]]; then
    [[ "$output" =~ (^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+)([^0-9.]|$) ]]
    return
  fi
  escaped="${expected//./\\.}"
  [[ "$output" =~ (^|[^0-9A-Za-z.+-])${escaped}([^0-9A-Za-z.+-]|$) ]]
}

valid_loopback_url() {
  local value="${1:-}" port
  [[ "$value" =~ ^http://(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})(/[^[:space:]]*)?$ ]] || return 1
  port="${BASH_REMATCH[2]}"
  (( port <= 65535 ))
}

AGENT_ZERO_WEB_URL="${BRIDGES_RD_AGENT_ZERO_URL:-http://127.0.0.1:50001}"
PORTAL_LOOPBACK_URL="${BRIDGES_PORTAL_LOOPBACK_URL:-http://127.0.0.1:4001}"
AGENT_ZERO_DESKTOP_SECRET_FILE="${BRIDGES_AGENT_ZERO_DESKTOP_SECRET:-/run/bridgesllm-agent-zero-desktop.secret}"

# Agent Zero ships a Remote Desktop icon that opens its web UI, signed in via a
# click-time backend session exchange. Readiness only requires the managed
# Agent Zero container; the authenticated session is minted at click time so no
# credential is ever stored on the desktop.
resolve_agent_zero_target() {
  local docker_bin names managed_label
  if ! valid_loopback_url "$AGENT_ZERO_WEB_URL"; then
    printf 'blocked\tAgent Zero web URL is not a loopback address\n'
    return 0
  fi
  docker_bin="$(find_runtime_binary docker || true)"
  if [[ -z "$docker_bin" ]]; then
    printf 'absent\tmanaged Agent Zero container is not installed\n'
    return 0
  fi
  # Docker is only reachable to root at install/verify time; the unprivileged
  # desktop account that clicks the icon cannot query it. When we cannot attest
  # (no socket access), trust the install-time manifest and let the click-time
  # backend session exchange be the real gate — it returns a session only when
  # Agent Zero is genuinely set up and authenticated.
  if ! names="$("$docker_bin" ps --all --format '{{.Names}}' 2>/dev/null)"; then
    printf 'ready\t%s\n' "$AGENT_ZERO_WEB_URL"
    return 0
  fi
  if ! grep -Fxq 'bridgesllm-agent-zero' <<< "$names"; then
    printf 'absent\tmanaged Agent Zero container is not installed\n'
    return 0
  fi
  managed_label="$("$docker_bin" inspect --format '{{index .Config.Labels "io.bridgesllm.agent-zero.managed"}}' bridgesllm-agent-zero 2>/dev/null || true)"
  if [[ "$managed_label" != 'true' ]]; then
    printf 'blocked\tAgent Zero container exists but does not satisfy the Portal-managed identity contract\n'
    return 0
  fi
  printf 'ready\t%s\n' "$AGENT_ZERO_WEB_URL"
}

resolve_catalog_target() {
  local runtime_id="$1" mode="$2" declared_target="$3" env_spec="$4" binary app_id directory expected_version
  case "$mode" in
    terminal-tui)
      binary="$(find_runtime_binary "$declared_target" || true)"
      if [[ -z "$binary" ]]; then
        printf 'absent\t%s runtime binary is not installed\n' "$runtime_id"
      elif verify_runtime_binary_contract "$runtime_id" "$binary" "$env_spec"; then
        printf 'ready\t%s\n' "$binary"
      else
        expected_version="$(runtime_expected_version "$runtime_id")"
        [[ "$expected_version" != 'semver' ]] || expected_version='a working semantic version'
        printf 'blocked\t%s runtime binary at %s failed its Portal command/version contract (expected %s)\n' \
          "$runtime_id" "$binary" "$expected_version"
      fi
      ;;
    local-web)
      if [[ "$runtime_id" == 'agent-zero' && "$declared_target" == 'backend-session-exchange-v2' ]]; then
        resolve_agent_zero_target
      else
        printf 'blocked\t%s local-web target has no implemented backend session exchange\n' "$runtime_id"
      fi
      ;;
    vendor-site)
      [[ "$declared_target" =~ ^https://[^[:space:]]+$ ]] \
        && printf 'ready\t%s\n' "$declared_target" \
        || printf 'blocked\t%s vendor-site target is invalid\n' "$runtime_id"
      ;;
    native-gui)
      case "$declared_target" in
        binary:*)
          binary="$(find_runtime_binary "${declared_target#binary:}" || true)"
          [[ -n "$binary" ]] && printf 'ready\t%s\n' "$binary" || printf 'absent\t%s native GUI binary is not installed\n' "$runtime_id"
          ;;
        desktop:*)
          app_id="${declared_target#desktop:}"
          IFS=':' read -r -a application_dirs <<< "$APPLICATION_DIRS"
          for directory in "${application_dirs[@]}"; do
            if [[ -f "${directory}/${app_id}.desktop" && ! -L "${directory}/${app_id}.desktop" ]]; then
              printf 'ready\tdesktop:%s\n' "$app_id"
              return 0
            fi
          done
          printf 'absent\t%s native GUI desktop entry is not installed\n' "$runtime_id"
          ;;
      esac
      ;;
  esac
}

desktop_categories() {
  case "$1" in
    terminal-tui) printf '%s\n' 'Development;Utility;' ;;
    native-gui) printf '%s\n' 'Development;' ;;
    local-web|vendor-site) printf '%s\n' 'Development;Network;WebBrowser;' ;;
  esac
}

desktop_entry_content() {
  local runtime_id="$1" label="$2" intent="$3" mode="$4" desktop_file="$5" icon_file="$6" auth_policy="$7" comment="$8"
  printf '%s' "[Desktop Entry]
Version=1.0
Type=Application
Name=${label}
Comment=${comment}
Exec=${SELF_PATH} launch ${runtime_id}
Icon=${PIXMAP_DIR}/${icon_file}
Terminal=false
Categories=$(desktop_categories "$mode")
StartupNotify=true
X-BridgesLLM-Runtime=${runtime_id}
X-BridgesLLM-Intent=${intent}
X-BridgesLLM-Mode=${mode}
X-BridgesLLM-Auth=${auth_policy}
"
}

manifest_line() {
  local runtime_id="$1" label="$2" intent="$3" mode="$4" resolved_target="$5" args_spec="$6" env_spec="$7" launch_policy="$8"
  local desktop_file="$9" icon_file="${10}" debug_port="${11}" auth_policy="${12}" icon_sha="${13}" comment="${14}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$runtime_id" "$label" "$intent" "$mode" "$resolved_target" "$args_spec" "$env_spec" "$launch_policy" \
    "$desktop_file" "$icon_file" "$debug_port" "$auth_policy" "$icon_sha" "$comment"
}

manifest_row() {
  local requested="$1"
  [[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || return 1
  awk -F '\t' -v runtime_id="$requested" '$1 == runtime_id { print; found=1; exit } END { if (!found) exit 1 }' "$MANIFEST"
}

resolved_target_is_attested() {
  local mode="$1" declared_target="$2" resolved_target="$3" directory app_id
  case "$mode" in
    terminal-tui)
      IFS=':' read -r -a runtime_dirs <<< "$RUNTIME_BIN_DIRS"
      for directory in "${runtime_dirs[@]}"; do
        [[ "$resolved_target" != "${directory}/${declared_target}" ]] || return 0
      done
      return 1
      ;;
    vendor-site)
      [[ "$resolved_target" == "$declared_target" ]]
      ;;
    local-web)
      valid_loopback_url "$resolved_target"
      ;;
    native-gui)
      case "$declared_target" in
        binary:*)
          app_id="${declared_target#binary:}"
          IFS=':' read -r -a runtime_dirs <<< "$RUNTIME_BIN_DIRS"
          for directory in "${runtime_dirs[@]}"; do
            [[ "$resolved_target" != "${directory}/${app_id}" ]] || return 0
          done
          return 1
          ;;
        desktop:*) [[ "$resolved_target" == "$declared_target" ]] ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

current_manifest_row_is_attested() {
  local requested="$1" row catalog
  local runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment extra
  local expected_id expected_label expected_intent expected_mode declared_target expected_args expected_env expected_policy
  local expected_desktop expected_icon expected_port expected_auth expected_sha expected_comment catalog_extra
  row="$(manifest_row "$requested")" || return 1
  IFS=$'\t' read -r runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment extra <<< "$row"
  catalog="$(catalog_row "$requested")" || return 1
  IFS=$'\t' read -r expected_id expected_label expected_intent expected_mode declared_target expected_args expected_env expected_policy \
    expected_desktop expected_icon expected_port expected_auth expected_sha expected_comment catalog_extra <<< "$catalog"
  [[ -z "${extra:-}" && -z "${catalog_extra:-}"
    && "$runtime_id" == "$expected_id"
    && "$label" == "$expected_label"
    && "$intent" == "$expected_intent"
    && "$mode" == "$expected_mode"
    && "$args_spec" == "$expected_args"
    && "$env_spec" == "$expected_env"
    && "$launch_policy" == "$expected_policy"
    && "$desktop_file" == "$expected_desktop"
    && "$icon_file" == "$expected_icon"
    && "$debug_port" == "$expected_port"
    && "$auth_policy" == "$expected_auth"
    && "$icon_sha" == "$expected_sha"
    && "$comment" == "$expected_comment" ]] || return 1
  resolved_target_is_attested "$mode" "$declared_target" "$resolved_target"
}

current_manifest_is_attested() {
  local runtime_id remainder rank last_rank=0 count=0
  declare -A seen=()
  [[ -f "$MANIFEST" && ! -L "$MANIFEST" && "$(stat -c '%a' "$MANIFEST")" == '644'
    && "$(sed -n '1p' "$MANIFEST")" == "$MANIFEST_HEADER"
    && "$(sed -n '2p' "$MANIFEST")" == "$MANIFEST_COLUMNS" ]] || return 1
  while IFS=$'\t' read -r runtime_id remainder; do
    [[ -n "$runtime_id" && "$runtime_id" != \#* && -z "${seen[$runtime_id]:-}" ]] || return 1
    case "$runtime_id" in
      claude-code) rank=1 ;;
      codex) rank=2 ;;
      grok-build) rank=3 ;;
      antigravity) rank=4 ;;
      agent-zero) rank=5 ;;
      ollama) rank=6 ;;
      *) return 1 ;;
    esac
    (( rank > last_rank )) || return 1
    current_manifest_row_is_attested "$runtime_id" || return 1
    seen["$runtime_id"]=1
    last_rank="$rank"
    count=$((count + 1))
  done < <(sed -n '3,$p' "$MANIFEST")
  [[ "$(wc -l < "$MANIFEST")" -eq $((count + 2)) ]]
}

legacy_catalog_row() {
  local requested="$1"
  legacy_catalog | awk -F '\t' -v provider="$requested" '$1 == provider { print; found=1; exit } END { if (!found) exit 1 }'
}

legacy_native_desktop_target_is_attested() {
  local provider="$1" target="$2" candidates candidate
  case "$provider" in
    chatgpt) candidates='com.openai.ChatGPT chatgpt-desktop chatgpt' ;;
    claude) candidates='com.anthropic.Claude claude-desktop' ;;
    gemini) candidates='com.google.Gemini gemini-desktop' ;;
    grok) candidates='ai.x.Grok grok-desktop' ;;
    ollama) candidates='open-webui ollama-ui com.jeffser.Alpaca' ;;
    *) return 1 ;;
  esac
  for candidate in $candidates; do
    [[ "$target" != "$candidate" ]] || return 0
  done
  return 1
}

legacy_native_binary_target_is_attested() {
  local provider="$1" target="$2" expected
  case "$provider" in
    chatgpt) expected='chatgpt-desktop' ;;
    claude) expected='claude-desktop' ;;
    gemini) expected='gemini-desktop' ;;
    grok) expected='grok-desktop' ;;
    ollama) expected='ollama-ui' ;;
    *) return 1 ;;
  esac
  [[ "$target" =~ ^/[A-Za-z0-9._/+:-]+$ && "${target##*/}" == "$expected" ]]
}

legacy_manifest_row_is_attested() {
  local requested="$1" row metadata
  local provider label kind target desktop_file icon_file debug_port extra
  local expected_provider expected_label default_url expected_desktop expected_icon expected_port expected_sha metadata_extra
  row="$(awk -F '\t' -v provider="$requested" '$1 == provider { print; found=1; exit } END { if (!found) exit 1 }' "$MANIFEST")" || return 1
  IFS=$'\t' read -r provider label kind target desktop_file icon_file debug_port extra <<< "$row"
  metadata="$(legacy_catalog_row "$requested")" || return 1
  IFS=$'\t' read -r expected_provider expected_label default_url expected_desktop expected_icon expected_port expected_sha metadata_extra <<< "$metadata"
  [[ -z "${extra:-}" && -z "${metadata_extra:-}"
    && "$provider" == "$expected_provider"
    && "$label" == "$expected_label"
    && "$desktop_file" == "$expected_desktop"
    && "$icon_file" == "$expected_icon"
    && "$debug_port" == "$expected_port" ]] || return 1
  case "$kind" in
    web)
      if [[ "$default_url" == '-' ]]; then
        valid_loopback_url "$target"
      else
        [[ "$target" == "$default_url" ]]
      fi
      ;;
    native-desktop) legacy_native_desktop_target_is_attested "$provider" "$target" ;;
    native-bin) legacy_native_binary_target_is_attested "$provider" "$target" ;;
    *) return 1 ;;
  esac
}

legacy_manifest_is_attested() {
  local provider remainder rank last_rank=0 count=0
  declare -A seen=()
  [[ -f "$MANIFEST" && ! -L "$MANIFEST" && "$(stat -c '%a' "$MANIFEST")" == '644'
    && "$(sed -n '1p' "$MANIFEST")" == "$LEGACY_MANIFEST_HEADER" ]] || return 1
  while IFS=$'\t' read -r provider remainder; do
    [[ -n "$provider" && "$provider" != \#* && -z "${seen[$provider]:-}" ]] || return 1
    case "$provider" in
      chatgpt) rank=1 ;;
      claude) rank=2 ;;
      gemini) rank=3 ;;
      grok) rank=4 ;;
      agent-zero) rank=5 ;;
      ollama) rank=6 ;;
      *) return 1 ;;
    esac
    (( rank > last_rank )) || return 1
    legacy_manifest_row_is_attested "$provider" || return 1
    seen["$provider"]=1
    last_rank="$rank"
    count=$((count + 1))
  done < <(sed -n '2,$p' "$MANIFEST")
  [[ -n "${seen[chatgpt]:-}" && -n "${seen[claude]:-}" && -n "${seen[gemini]:-}" && -n "${seen[grok]:-}"
    && "$(wc -l < "$MANIFEST")" -eq $((count + 1)) ]]
}

attest_manifest_for_mutation() {
  if [[ ! -e "$MANIFEST" && ! -L "$MANIFEST" ]]; then
    printf 'absent\n'
  elif [[ -L "$MANIFEST" || ! -f "$MANIFEST" ]]; then
    printf 'Refusing to replace or remove a linked or non-regular AI runtime manifest: %s\n' "$MANIFEST" >&2
    return 1
  elif current_manifest_is_attested; then
    printf 'current\n'
  elif legacy_manifest_is_attested; then
    printf 'legacy\n'
  else
    printf 'Refusing to replace or remove an unattested AI runtime manifest: %s\n' "$MANIFEST" >&2
    return 1
  fi
}

legacy_desktop_entry_content() {
  local provider="$1" label="$2" icon_file="$3"
  printf '%s' "[Desktop Entry]
Version=1.0
Type=Application
Name=${label}
Comment=Open ${label} using the managed Remote Desktop launcher
Exec=${SELF_PATH} launch ${provider}
Icon=${PIXMAP_DIR}/${icon_file}
Terminal=false
Categories=Development;Network;WebBrowser;
StartupNotify=true
"
}

legacy_icon_digest_for_runtime() {
  local runtime_id="$1" metadata
  case "$runtime_id" in
    agent-zero|ollama) ;;
    *) return 1 ;;
  esac
  metadata="$(legacy_catalog_row "$runtime_id")" || return 1
  printf '%s\n' "$(awk -F '\t' '{ print $7 }' <<< "$metadata")"
}

attest_legacy_desktop_asset() {
  local provider="$1" label="$2" desktop_file="$3" icon_file="$4" target expected
  target="${DESKTOP_DIR}/${desktop_file}"
  [[ -e "$target" || -L "$target" ]] || return 0
  expected="$(legacy_desktop_entry_content "$provider" "$label" "$icon_file")"
  expected+=$'\n'
  [[ -f "$target" && ! -L "$target" ]] && cmp -s <(printf '%s' "$expected") "$target" \
    || { printf 'Refusing to remove foreign or replaced legacy AI desktop entry: %s\n' "$target" >&2; return 1; }
}

attest_legacy_icon_asset() {
  local icon_file="$1" icon_sha="$2" target actual_sha
  target="${PIXMAP_DIR}/${icon_file}"
  [[ -e "$target" || -L "$target" ]] || return 0
  [[ -f "$target" && ! -L "$target" ]] \
    || { printf 'Refusing to remove foreign or replaced legacy AI icon: %s\n' "$target" >&2; return 1; }
  actual_sha="$(sha256sum "$target" | awk '{print $1}')"
  [[ "$actual_sha" == "$icon_sha" ]] \
    || { printf 'Refusing to remove foreign or replaced legacy AI icon: %s\n' "$target" >&2; return 1; }
}

attest_legacy_assets() {
  local provider label default_url desktop_file icon_file debug_port icon_sha extra
  while IFS=$'\t' read -r provider label default_url desktop_file icon_file debug_port icon_sha extra; do
    attest_legacy_desktop_asset "$provider" "$label" "$desktop_file" "$icon_file"
    case "$provider" in agent-zero|ollama) continue ;; esac
    attest_legacy_icon_asset "$icon_file" "$icon_sha"
  done < <(legacy_catalog)
}

remove_legacy_assets() {
  local provider label default_url desktop_file icon_file debug_port icon_sha extra target expected_identity
  attest_legacy_assets
  while IFS=$'\t' read -r provider label default_url desktop_file icon_file debug_port icon_sha extra; do
    target="${DESKTOP_DIR}/${desktop_file}"
    if [[ -e "$target" || -L "$target" ]]; then
      expected_identity="$(path_identity "$target")"
      run_test_before_mutation_hook remove-legacy-desktop "$target"
      attest_legacy_desktop_asset "$provider" "$label" "$desktop_file" "$icon_file"
      assert_path_identity "$target" "$expected_identity"
      rm -f -- "$target"
      changed=1
    fi
    case "$provider" in agent-zero|ollama) continue ;; esac
    target="${PIXMAP_DIR}/${icon_file}"
    if [[ -e "$target" || -L "$target" ]]; then
      expected_identity="$(path_identity "$target")"
      run_test_before_mutation_hook remove-legacy-icon "$target"
      attest_legacy_icon_asset "$icon_file" "$icon_sha"
      assert_path_identity "$target" "$expected_identity"
      rm -f -- "$target"
      changed=1
    fi
  done < <(legacy_catalog)
}

legacy_asset_paths() {
  local provider label default_url desktop_file icon_file debug_port icon_sha extra
  while IFS=$'\t' read -r provider label default_url desktop_file icon_file debug_port icon_sha extra; do
    printf '%s\n' "${DESKTOP_DIR}/${desktop_file}"
    case "$provider" in
      agent-zero|ollama) ;;
      *) printf '%s\n' "${PIXMAP_DIR}/${icon_file}" ;;
    esac
  done < <(legacy_catalog)
}

attest_current_install_assets() {
  local runtime_id="$1" desktop_file="$2" icon_file="$3" icon_sha="$4" content="$5"
  local target actual_sha legacy_sha
  target="${DESKTOP_DIR}/${desktop_file}"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] && cmp -s <(printf '%s' "$content") "$target" \
      || { printf 'Refusing to overwrite foreign or replaced AI desktop entry: %s\n' "$target" >&2; return 1; }
  fi
  target="${PIXMAP_DIR}/${icon_file}"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] \
      || { printf 'Refusing to overwrite foreign or replaced AI icon: %s\n' "$target" >&2; return 1; }
    actual_sha="$(sha256sum "$target" | awk '{print $1}')"
    if [[ "$actual_sha" != "$icon_sha" ]]; then
      legacy_sha="$(legacy_icon_digest_for_runtime "$runtime_id" || true)"
      [[ -n "$legacy_sha" && "$actual_sha" == "$legacy_sha" ]] \
        || { printf 'Refusing to overwrite foreign or replaced AI icon: %s\n' "$target" >&2; return 1; }
    fi
  fi
}

attest_current_removal_assets() {
  local runtime_id="$1" desktop_file="$2" icon_file="$3" icon_sha="$4" content="$5"
  local target actual_sha legacy_sha manifest_owned=false
  current_manifest_row_is_attested "$runtime_id" && manifest_owned=true
  target="${DESKTOP_DIR}/${desktop_file}"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ "$manifest_owned" == 'true' && -f "$target" && ! -L "$target" ]] \
      && cmp -s <(printf '%s' "$content") "$target" \
      || { printf 'Refusing to remove foreign or replaced AI desktop entry: %s\n' "$target" >&2; return 1; }
  fi
  target="${PIXMAP_DIR}/${icon_file}"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] \
      || { printf 'Refusing to remove foreign or replaced AI icon: %s\n' "$target" >&2; return 1; }
    actual_sha="$(sha256sum "$target" | awk '{print $1}')"
    if [[ "$manifest_owned" != 'true' || "$actual_sha" != "$icon_sha" ]]; then
      legacy_sha="$(legacy_icon_digest_for_runtime "$runtime_id" || true)"
      [[ -n "$legacy_sha" && "$actual_sha" == "$legacy_sha" ]] \
        || { printf 'Refusing to remove foreign or replaced AI icon: %s\n' "$target" >&2; return 1; }
    fi
  fi
}

remove_current_runtime_assets() {
  local runtime_id="$1" desktop_file="$2" icon_file="$3" icon_sha="$4" content="$5" target operation expected_identity
  attest_current_removal_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
  for target in "${DESKTOP_DIR}/${desktop_file}" "${PIXMAP_DIR}/${icon_file}"; do
    if [[ -e "$target" || -L "$target" ]]; then
      expected_identity="$(path_identity "$target")"
      if [[ "$target" == "${DESKTOP_DIR}/"* ]]; then
        operation='remove-current-desktop'
      else
        operation='remove-current-icon'
      fi
      run_test_before_mutation_hook "$operation" "$target"
      attest_current_removal_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
      assert_path_identity "$target" "$expected_identity"
      rm -f -- "$target"
      changed=1
    fi
  done
}

install_current_icon() {
  local runtime_id="$1" source="$2" destination="$3" icon_sha="$4" desktop_file="$5" content="$6"
  local temporary expected_identity temporary_identity
  attest_current_install_assets "$runtime_id" "$desktop_file" "${destination##*/}" "$icon_sha" "$content"
  expected_identity="$(path_identity "$destination")"
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  temporary_identity="$(path_identity "$temporary")"
  install_asset_temporary="$temporary"
  install_asset_temporary_identity="$temporary_identity"
  install_asset_temporary_label='icon'
  if ! cp -- "$source" "$temporary" || ! chmod 0644 "$temporary"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  temporary_identity="$(path_identity "$temporary")"
  install_asset_temporary_identity="$temporary_identity"
  if [[ -f "$destination" && ! -L "$destination"
    && "$(stat -c '%a' "$destination")" == '644' ]] && cmp -s "$temporary" "$destination"; then
    cleanup_install_asset_temporary
    return 0
  fi
  if ! run_test_before_mutation_hook install-current-icon "$destination" \
    || ! attest_current_install_assets "$runtime_id" "$desktop_file" "${destination##*/}" "$icon_sha" "$content" \
    || ! assert_path_identity "$destination" "$expected_identity"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  if ! mv -fT -- "$temporary" "$destination"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  cleanup_install_asset_temporary
  changed=1
}

write_current_desktop() {
  local runtime_id="$1" destination="$2" icon_file="$3" icon_sha="$4" content="$5"
  local temporary expected_identity temporary_identity
  attest_current_install_assets "$runtime_id" "${destination##*/}" "$icon_file" "$icon_sha" "$content"
  expected_identity="$(path_identity "$destination")"
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  temporary_identity="$(path_identity "$temporary")"
  install_asset_temporary="$temporary"
  install_asset_temporary_identity="$temporary_identity"
  install_asset_temporary_label='desktop'
  if ! printf '%s' "$content" > "$temporary"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  if ! chmod 0755 "$temporary"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  if [[ -f "$destination" && ! -L "$destination"
    && "$(stat -c '%a' "$destination")" == '755' ]] && cmp -s "$temporary" "$destination"; then
    cleanup_install_asset_temporary
    return 0
  fi
  if ! run_test_before_mutation_hook install-current-desktop "$destination" \
    || ! attest_current_install_assets "$runtime_id" "${destination##*/}" "$icon_file" "$icon_sha" "$content" \
    || ! assert_path_identity "$destination" "$expected_identity"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  if ! mv -fT -- "$temporary" "$destination"; then
    cleanup_install_asset_temporary || true
    return 1
  fi
  cleanup_install_asset_temporary
  changed=1
}

preflight_signed_assets() {
  local assets_dir="$1" runtime_id label intent mode declared_target args_spec env_spec launch_policy
  local desktop_file icon_file debug_port auth_policy icon_sha comment resolution state resolved_target actual_sha
  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    resolution="$(resolve_catalog_target "$runtime_id" "$mode" "$declared_target" "$env_spec")"
    IFS=$'\t' read -r state resolved_target <<< "$resolution"
    [[ "$state" == 'ready' ]] || continue
    [[ -f "${assets_dir}/${icon_file}" && ! -L "${assets_dir}/${icon_file}" ]] \
      || { printf 'Signed icon missing: %s\n' "$icon_file" >&2; return 1; }
    actual_sha="$(sha256sum "${assets_dir}/${icon_file}" | awk '{print $1}')"
    [[ "$actual_sha" == "$icon_sha" ]] \
      || { printf 'Signed icon digest mismatch: %s\n' "$icon_file" >&2; return 1; }
  done < <(runtime_catalog)
}

preflight_current_assets() {
  local runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment
  local resolution state resolved_target content
  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    resolution="$(resolve_catalog_target "$runtime_id" "$mode" "$declared_target" "$env_spec")"
    IFS=$'\t' read -r state resolved_target <<< "$resolution"
    content="$(desktop_entry_content "$runtime_id" "$label" "$intent" "$mode" "$desktop_file" "$icon_file" "$auth_policy" "$comment")"
    content+=$'\n'
    if [[ "$state" == 'ready' ]]; then
      attest_current_install_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
    else
      attest_current_removal_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
    fi
  done < <(runtime_catalog)
}

reload_remote_desktop_icons() {
  local desktop_pid desktop_executable desktop_uid entry
  local display_count=0 runtime_count=0 bus_count=0 session_count=0
  local -a desktop_environment=()

  desktop_pid="$(pgrep -o -u "$RD_USER" -x xfdesktop 2>/dev/null || true)"
  [[ "$desktop_pid" =~ ^[0-9]+$ ]] || return 0
  desktop_executable="$(readlink -f "/proc/${desktop_pid}/exe" 2>/dev/null || true)"
  desktop_uid="$(stat -c '%u' "/proc/${desktop_pid}" 2>/dev/null || true)"
  [[ "$desktop_executable" == '/usr/bin/xfdesktop'
    && -f "$desktop_executable"
    && "$(stat -c '%u:%g' "$desktop_executable" 2>/dev/null || true)" == '0:0'
    && "$desktop_uid" == "$(id -u "$RD_USER")" ]] || return 0

  while IFS= read -r -d '' entry; do
    case "$entry" in
      DISPLAY=*)
        display_count=$((display_count + 1))
        desktop_environment+=("$entry")
        ;;
      XDG_RUNTIME_DIR=*)
        runtime_count=$((runtime_count + 1))
        desktop_environment+=("$entry")
        ;;
      DBUS_SESSION_BUS_ADDRESS=*)
        bus_count=$((bus_count + 1))
        desktop_environment+=("$entry")
        ;;
      SESSION_MANAGER=*)
        session_count=$((session_count + 1))
        desktop_environment+=("$entry")
        ;;
    esac
  done < "/proc/${desktop_pid}/environ" || return 0

  [[ "$display_count" == '1'
    && "$runtime_count" == '1'
    && "$bus_count" == '1'
    && "$session_count" == '1'
    && "$(readlink -f "/proc/${desktop_pid}/exe" 2>/dev/null || true)" == "$desktop_executable"
    && "$(stat -c '%u' "/proc/${desktop_pid}" 2>/dev/null || true)" == "$desktop_uid" ]] || return 0

  {
    timeout --signal=TERM --kill-after=1s 3s \
      runuser -u "$RD_USER" -- env -i \
      HOME="$RD_HOME" USER="$RD_USER" LOGNAME="$RD_USER" PATH=/usr/bin:/bin \
      "${desktop_environment[@]}" "$desktop_executable" --reload || true
  } >/dev/null 2>&1
}

install_launchers() {
  require_root install
  validate_managed_paths
  validate_catalog
  local assets_dir='' runtime_id label intent mode declared_target args_spec env_spec launch_policy
  local desktop_file icon_file debug_port auth_policy icon_sha comment resolution state resolved_target actual_sha content manifest_identity
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --assets-dir) [[ $# -ge 2 ]] || usage; assets_dir="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$assets_dir" && -d "$assets_dir" && ! -L "$assets_dir" ]] \
    || { printf 'Signed AI runtime icon directory is missing\n' >&2; exit 1; }
  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    id "$RD_USER" >/dev/null 2>&1 || { printf 'Remote Desktop user %s is missing\n' "$RD_USER" >&2; exit 1; }
  fi
  for directory in "$RD_HOME" "$DESKTOP_DIR" "$STATE_DIR" "$PIXMAP_DIR" "$PROFILE_ROOT"; do
    reject_linked_directory "$directory"
  done
  acquire_mutation_lock
  ensure_state_directory_under_lock
  for directory in "$RD_HOME" "$DESKTOP_DIR" "$STATE_DIR" "$PIXMAP_DIR" "$PROFILE_ROOT"; do
    reject_linked_directory "$directory"
  done
  install -d -m 0755 "$DESKTOP_DIR" "$PIXMAP_DIR"
  install -d -m 0700 "$PROFILE_ROOT"
  cleanup_stale_managed_temporaries
  attest_manifest_for_mutation >/dev/null
  attest_legacy_assets
  preflight_current_assets
  preflight_signed_assets "$assets_dir"
  remove_legacy_assets

  local temporary_manifest
  temporary_manifest="$(mktemp "${STATE_DIR}/manifest.tmp.XXXXXX")"
  install_manifest_temporary="$temporary_manifest"
  install_manifest_temporary_identity="$(path_identity "$temporary_manifest")"
  trap cleanup_install_temporaries EXIT
  printf '%s\n%s\n' "$MANIFEST_HEADER" "$MANIFEST_COLUMNS" > "$temporary_manifest"

  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    resolution="$(resolve_catalog_target "$runtime_id" "$mode" "$declared_target" "$env_spec")"
    IFS=$'\t' read -r state resolved_target <<< "$resolution"
    content="$(desktop_entry_content "$runtime_id" "$label" "$intent" "$mode" "$desktop_file" "$icon_file" "$auth_policy" "$comment")"
    content+=$'\n'
    if [[ "$state" != 'ready' ]]; then
      remove_current_runtime_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
      [[ "$state" != 'blocked' ]] || printf 'AI runtime launcher blocked: %s\n' "$resolved_target" >&2
      continue
    fi
    [[ -f "${assets_dir}/${icon_file}" && ! -L "${assets_dir}/${icon_file}" ]] \
      || { printf 'Signed icon missing: %s\n' "$icon_file" >&2; exit 1; }
    actual_sha="$(sha256sum "${assets_dir}/${icon_file}" | awk '{print $1}')"
    [[ "$actual_sha" == "$icon_sha" ]] \
      || { printf 'Signed icon digest mismatch: %s\n' "$icon_file" >&2; exit 1; }
    install_current_icon "$runtime_id" "${assets_dir}/${icon_file}" "${PIXMAP_DIR}/${icon_file}" "$icon_sha" "$desktop_file" "$content"
    write_current_desktop "$runtime_id" "${DESKTOP_DIR}/${desktop_file}" "$icon_file" "$icon_sha" "$content"
    manifest_line "$runtime_id" "$label" "$intent" "$mode" "$resolved_target" "$args_spec" "$env_spec" "$launch_policy" \
      "$desktop_file" "$icon_file" "$debug_port" "$auth_policy" "$icon_sha" "$comment" >> "$temporary_manifest"
  done < <(runtime_catalog)

  if [[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] && cmp -s "$temporary_manifest" "$MANIFEST"; then
    attest_manifest_for_mutation >/dev/null
    cleanup_install_manifest_temporary
  else
    manifest_identity="$(path_identity "$MANIFEST")"
    if ! run_test_before_mutation_hook install-manifest "$MANIFEST" \
      || ! attest_manifest_for_mutation >/dev/null \
      || ! assert_path_identity "$MANIFEST" "$manifest_identity"; then
      cleanup_install_manifest_temporary || true
      return 1
    fi
    chmod 0644 "$temporary_manifest"
    mv -fT -- "$temporary_manifest" "$MANIFEST"
    cleanup_install_manifest_temporary
    changed=1
  fi

  if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" != '1' ]]; then
    chown -R "$RD_USER:$RD_USER" "$DESKTOP_DIR" "$PROFILE_ROOT"
    while IFS=$'\t' read -r runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
      [[ "$runtime_id" == \#* || -z "$runtime_id" ]] && continue
      runuser -u "$RD_USER" -- env HOME="$RD_HOME" gio set "${DESKTOP_DIR}/${desktop_file}" metadata::trusted true >/dev/null 2>&1 || true
    done < "$MANIFEST"
    reload_remote_desktop_icons
  fi
  cleanup_install_temporaries
  trap - EXIT
  printf '%s\n' "$([[ "$changed" == '1' ]] && printf changed || printf unchanged)"
}

validated_runtime_row() {
  local requested="$1" row catalog
  local runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment
  local resolution state resolved_target expected
  validate_catalog
  catalog="$(catalog_row "$requested")" || return 1
  IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment <<< "$catalog"
  resolution="$(resolve_catalog_target "$runtime_id" "$mode" "$declared_target" "$env_spec")"
  IFS=$'\t' read -r state resolved_target <<< "$resolution"
  [[ "$state" == 'ready' ]] || { printf '%s\n' "$resolved_target" >&2; return 1; }
  row="$(manifest_row "$requested")" || { printf '%s is not currently provisioned\n' "$requested" >&2; return 1; }
  expected="$(manifest_line "$runtime_id" "$label" "$intent" "$mode" "$resolved_target" "$args_spec" "$env_spec" "$launch_policy" \
    "$desktop_file" "$icon_file" "$debug_port" "$auth_policy" "$icon_sha" "$comment")"
  [[ "$row" == "$expected" ]] || { printf '%s launcher intent or target is stale\n' "$requested" >&2; return 1; }
  printf '%s\n' "$row"
}

load_desktop_environment() {
  export HOME="$RD_HOME"
  export USER="$RD_USER"
  export LOGNAME="$RD_USER"
  export SHELL=/bin/bash
  export DISPLAY="${DISPLAY:-:1}"
  export XAUTHORITY="${XAUTHORITY:-${RD_HOME}/.Xauthority}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/bridges-rd-runtime}"
  export PULSE_SERVER="${PULSE_SERVER:-unix:/tmp/bridges-rd-runtime/pulse/native}"
}

launch_browser_target() {
  local runtime_id="$1" label="$2" mode="$3" target="$4" debug_port="$5" chrome_bin profile_dir resolution width height
  local -a chrome_args=()
  if [[ "$mode" == 'local-web' ]]; then
    valid_loopback_url "$target" || { printf 'Authenticated local UI target is invalid\n' >&2; exit 1; }
  else
    [[ "$target" =~ ^https://[^[:space:]]+$ ]] || { printf 'Vendor website target is invalid\n' >&2; exit 1; }
  fi
  for chrome_candidate in google-chrome-stable google-chrome chromium-browser chromium; do
    chrome_bin="$(find_runtime_binary "$chrome_candidate" || true)"
    [[ -z "$chrome_bin" ]] || break
  done
  [[ -n "${chrome_bin:-}" ]] || { printf 'No Chrome/Chromium binary found\n' >&2; exit 1; }
  umask 077
  profile_dir="${PROFILE_ROOT}/${runtime_id}"
  reject_linked_directory "$PROFILE_ROOT"
  reject_linked_directory "$profile_dir"
  mkdir -p "$profile_dir"
  chmod 0700 "$PROFILE_ROOT" "$profile_dir"
  resolution="$(DISPLAY="$DISPLAY" xrandr 2>/dev/null | awk '/\*/ { print $1; exit }' || true)"
  [[ "$resolution" =~ ^[0-9]+x[0-9]+$ ]] || resolution='1280x1024'
  width="${resolution%x*}"
  height="${resolution#*x}"
  chrome_args=(
    --new-window
    "--window-size=${width},${height}"
    --window-position=0,0
    --start-maximized
    --force-device-scale-factor=1
    --high-dpi-support=1
    --no-first-run
    --no-default-browser-check
    "--user-data-dir=${profile_dir}"
  )
  [[ "$debug_port" == '-' ]] \
    || chrome_args+=(--remote-debugging-address=127.0.0.1 "--remote-debugging-port=${debug_port}")
  chrome_args+=("--app=${target}")
  exec "$chrome_bin" "${chrome_args[@]}"
}

# Open the Agent Zero web UI already signed in. The Agent Zero password lives
# only on the server: this reads a per-boot capability secret (root:bridgesrd,
# group-readable) and asks the Portal backend over loopback to mint a fresh
# Agent Zero web session, then plants only the returned session cookies into a
# dedicated Chrome profile via CDP before navigating. On any failure it opens a
# clear message instead of a login page the operator cannot complete.
agent_zero_error_page() {
  local message="$1" chrome_bin="$2" profile_dir="$3"
  local data_url
  data_url="data:text/html,<html><body style=\"font-family:sans-serif;background:#0b0f1a;color:#e2e8f0;padding:40px\"><h2>Agent Zero web UI</h2><p>${message}</p><p style=\"color:#94a3b8\">Agent Zero also runs in the Portal's Agent Chat.</p></body></html>"
  exec "$chrome_bin" --new-window --no-first-run --no-default-browser-check \
    "--user-data-dir=${profile_dir}" "--app=${data_url}"
}

launch_agent_zero_web() {
  local runtime_id="$1" label="$2" target="$3" debug_port="$4"
  local chrome_bin profile_dir secret response resolution width height
  valid_loopback_url "$target" || { printf 'Agent Zero web URL is invalid\n' >&2; exit 1; }
  [[ "$debug_port" =~ ^[1-9][0-9]{0,4}$ ]] || { printf 'Agent Zero launcher requires a debug port\n' >&2; exit 1; }
  for chrome_candidate in google-chrome-stable google-chrome chromium-browser chromium; do
    chrome_bin="$(find_runtime_binary "$chrome_candidate" || true)"
    [[ -z "$chrome_bin" ]] || break
  done
  [[ -n "${chrome_bin:-}" ]] || { printf 'No Chrome/Chromium binary found\n' >&2; exit 1; }
  umask 077
  profile_dir="${PROFILE_ROOT}/${runtime_id}"
  reject_linked_directory "$PROFILE_ROOT"
  reject_linked_directory "$profile_dir"
  mkdir -p "$profile_dir"
  chmod 0700 "$PROFILE_ROOT" "$profile_dir"

  if [[ ! -r "$AGENT_ZERO_DESKTOP_SECRET_FILE" ]]; then
    agent_zero_error_page 'The Portal has not published a desktop launch secret yet. Make sure the Portal service is running, then try again.' "$chrome_bin" "$profile_dir"
  fi
  secret="$(tr -d '\r\n' < "$AGENT_ZERO_DESKTOP_SECRET_FILE" 2>/dev/null || true)"
  [[ -n "$secret" ]] || agent_zero_error_page 'The desktop launch secret is empty. Restart the Portal service and try again.' "$chrome_bin" "$profile_dir"

  # Keep the secret off the process list: curl reads its config (including the
  # header) from stdin, not argv.
  response="$(printf 'url = "%s/api/agent-runtime/agent-zero/desktop-session"\nrequest = "POST"\nsilent\nheader = "X-BridgesLLM-Desktop-Launch-Secret: %s"\nmax-time = 20\n' \
    "$PORTAL_LOOPBACK_URL" "$secret" | curl -K - 2>/dev/null || true)"
  unset secret
  if [[ -z "$response" ]] || ! grep -q '"cookies"' <<< "$response"; then
    agent_zero_error_page 'Could not establish an Agent Zero web session. Confirm Agent Zero is set up and authenticated in the Portal, then try again.' "$chrome_bin" "$profile_dir"
  fi

  resolution="$(DISPLAY="$DISPLAY" xrandr 2>/dev/null | awk '/\*/ { print $1; exit }' || true)"
  [[ "$resolution" =~ ^[0-9]+x[0-9]+$ ]] || resolution='1280x1024'
  width="${resolution%x*}"
  height="${resolution#*x}"

  "$chrome_bin" \
    --new-window "--window-size=${width},${height}" --window-position=0,0 --start-maximized \
    --force-device-scale-factor=1 --high-dpi-support=1 --no-first-run --no-default-browser-check \
    "--user-data-dir=${profile_dir}" \
    --remote-debugging-address=127.0.0.1 "--remote-debugging-port=${debug_port}" \
    "--app=${target}" &
  local chrome_pid=$!

  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:${debug_port}/json/version" >/dev/null 2>&1 && break
    sleep 0.3
  done

  # Plant the session cookies and reload authenticated. Cookies arrive on stdin
  # so they never appear in the process list.
  printf '%s' "$response" | AGENT_ZERO_CDP_PORT="$debug_port" AGENT_ZERO_TARGET="$target" node - <<'AZ_CDP' || true
const http = require('http');
const port = Number(process.env.AGENT_ZERO_CDP_PORT);
const target = String(process.env.AGENT_ZERO_TARGET);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let cookies = [];
  try { cookies = (JSON.parse(raw).cookies || []); } catch { process.exit(0); }
  if (!Array.isArray(cookies) || !cookies.length) process.exit(0);
  http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => body += d);
    res.on('end', () => {
      let wsUrl = '';
      try { wsUrl = JSON.parse(body).webSocketDebuggerUrl; } catch { process.exit(0); }
      if (!wsUrl) process.exit(0);
      const ws = new globalThis.WebSocket(wsUrl);
      let id = 0;
      const done = () => { try { ws.close(); } catch {} process.exit(0); };
      setTimeout(done, 12000);
      ws.addEventListener('open', () => {
        for (const c of cookies) {
          if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
          ws.send(JSON.stringify({
            id: ++id, method: 'Network.setCookie',
            params: { name: c.name, value: c.value, url: target, path: '/', httpOnly: true, sameSite: 'Lax' },
          }));
        }
        ws.send(JSON.stringify({ id: ++id, method: 'Page.navigate', params: { url: target } }));
      });
      let navId = null;
      ws.addEventListener('message', (event) => {
        try {
          const m = JSON.parse(String(event.data));
          if (m.result && m.result.frameId && navId === null) navId = m.id;
        } catch {}
      });
      ws.addEventListener('error', done);
    }).on('error', () => process.exit(0));
  }).on('error', () => process.exit(0));
});
AZ_CDP
  unset response

  wait "$chrome_pid"
}

launch_runtime() {
  local requested="${1:-}" row
  local runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment
  validate_managed_paths
  catalog_row "$requested" >/dev/null || usage
  if [[ "$(id -u)" == '0' && "$(id -un)" != "$RD_USER" ]]; then
    id "$RD_USER" >/dev/null 2>&1 || { printf 'Remote Desktop user is missing\n' >&2; exit 1; }
    exec /usr/bin/setpriv --reuid="$RD_USER" --regid="$RD_USER" --init-groups -- /usr/bin/env -i \
      HOME="$RD_HOME" USER="$RD_USER" LOGNAME="$RD_USER" SHELL=/bin/bash \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG="${LANG:-C.UTF-8}" \
      "$SELF_PATH" launch "$requested"
  fi
  [[ "$(id -un)" == "$RD_USER" ]] || { printf 'AI runtime launchers must run as %s\n' "$RD_USER" >&2; exit 1; }
  row="$(validated_runtime_row "$requested")" || exit 1
  IFS=$'\t' read -r runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment <<< "$row"
  load_desktop_environment
  case "$mode" in
    terminal-tui)
      local terminal_bin
      terminal_bin="$(find_runtime_binary xfce4-terminal || true)"
      [[ -n "$terminal_bin" ]] || { printf 'XFCE terminal is unavailable\n' >&2; exit 1; }
      exec "$terminal_bin" --disable-server "--title=${label}" --execute "$SELF_PATH" terminal "$runtime_id"
      ;;
    native-gui)
      if [[ "$resolved_target" == desktop:* ]]; then
        command -v gtk-launch >/dev/null 2>&1 || { printf 'gtk-launch is unavailable\n' >&2; exit 1; }
        exec gtk-launch "${resolved_target#desktop:}"
      fi
      [[ "$resolved_target" == /* && -x "$resolved_target" ]] || { printf 'Provisioned native app is unavailable\n' >&2; exit 1; }
      exec "$resolved_target"
      ;;
    local-web|vendor-site)
      if [[ "$runtime_id" == 'agent-zero' ]]; then
        launch_agent_zero_web "$runtime_id" "$label" "$resolved_target" "$debug_port"
      else
        launch_browser_target "$runtime_id" "$label" "$mode" "$resolved_target" "$debug_port"
      fi
      ;;
    *) exit 1 ;;
  esac
}

terminal_runtime() {
  local requested="${1:-}" row
  local runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment
  local -a runtime_args=() clean_env=()
  validate_managed_paths
  [[ "$(id -un)" == "$RD_USER" ]] || { printf 'AI runtime terminal must run as %s\n' "$RD_USER" >&2; exit 1; }
  row="$(validated_runtime_row "$requested")" || exit 1
  IFS=$'\t' read -r runtime_id label intent mode resolved_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment <<< "$row"
  [[ "$mode" == 'terminal-tui' ]] || { printf '%s is not a terminal runtime\n' "$requested" >&2; exit 1; }
  [[ "$args_spec" == '-' ]] || read -r -a runtime_args <<< "$args_spec"
  umask 077
  load_desktop_environment
  clean_env=(
    "HOME=$RD_HOME"
    "USER=$RD_USER"
    "LOGNAME=$RD_USER"
    "SHELL=/bin/bash"
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    "LANG=${LANG:-C.UTF-8}"
    "TERM=${TERM:-xterm-256color}"
    "DISPLAY=$DISPLAY"
    "XAUTHORITY=$XAUTHORITY"
    "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
    "PULSE_SERVER=$PULSE_SERVER"
  )
  [[ "$env_spec" == '-' ]] || clean_env+=("$env_spec")
  printf '\n%s\n%s\nAuthentication boundary: %s.\n\n' "$label" "$comment" "$auth_policy"
  case "$launch_policy" in
    interactive)
      exec /usr/bin/env -i "${clean_env[@]}" "$resolved_target" "${runtime_args[@]}"
      ;;
    status-shell)
      local runtime_status
      set +e
      /usr/bin/env -i "${clean_env[@]}" "$resolved_target" "${runtime_args[@]}"
      runtime_status=$?
      set -e
      printf '\nRuntime command exited with status %s. This shell uses the Remote Desktop account only.\n' "$runtime_status"
      if [[ "${BRIDGES_RD_SKIP_SYSTEM:-0}" == '1' && "${BRIDGES_RD_TEST_NO_HOLD:-0}" == '1' ]]; then
        return "$runtime_status"
      fi
      exec /usr/bin/env -i "${clean_env[@]}" /bin/bash --noprofile --norc
      ;;
    *) printf 'Terminal launch policy is invalid\n' >&2; exit 1 ;;
  esac
}

verify_legacy_assets_absent() {
  local target
  while IFS= read -r target; do
    [[ ! -e "$target" && ! -L "$target" ]] || { printf 'Legacy or misleading AI launcher asset is still present: %s\n' "$target" >&2; return 1; }
  done < <(legacy_asset_paths)
}

verify_launchers() {
  validate_managed_paths
  validate_catalog
  local runtime_id label intent mode declared_target args_spec env_spec launch_policy
  local desktop_file icon_file debug_port auth_policy icon_sha comment resolution state resolved_target row expected content actual_sha
  local temporary_manifest
  local -a blockers=()
  acquire_verification_lock
  [[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || { printf 'AI runtime launcher manifest missing\n' >&2; exit 1; }
  [[ "$(stat -c '%a' "$MANIFEST")" == '644' ]] || { printf 'AI runtime launcher manifest mode is invalid\n' >&2; exit 1; }
  temporary_manifest="$(mktemp "${STATE_DIR}/verify-manifest.tmp.XXXXXX")"
  verify_manifest_temporary="$temporary_manifest"
  verify_manifest_temporary_identity="$(path_identity "$temporary_manifest")"
  trap cleanup_verify_manifest_temporary EXIT
  printf '%s\n%s\n' "$MANIFEST_HEADER" "$MANIFEST_COLUMNS" > "$temporary_manifest"

  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    resolution="$(resolve_catalog_target "$runtime_id" "$mode" "$declared_target" "$env_spec")"
    IFS=$'\t' read -r state resolved_target <<< "$resolution"
    if [[ "$state" != 'ready' ]]; then
      row="$(manifest_row "$runtime_id" || true)"
      [[ -z "$row" && ! -e "${DESKTOP_DIR}/${desktop_file}" && ! -L "${DESKTOP_DIR}/${desktop_file}"
        && ! -e "${PIXMAP_DIR}/${icon_file}" && ! -L "${PIXMAP_DIR}/${icon_file}" ]] \
        || { printf 'Unavailable %s launcher is still provisioned\n' "$runtime_id" >&2; exit 1; }
      if [[ "$state" == 'blocked' ]]; then
        blockers+=("$resolved_target")
      fi
      continue
    fi
    expected="$(manifest_line "$runtime_id" "$label" "$intent" "$mode" "$resolved_target" "$args_spec" "$env_spec" "$launch_policy" \
      "$desktop_file" "$icon_file" "$debug_port" "$auth_policy" "$icon_sha" "$comment")"
    printf '%s\n' "$expected" >> "$temporary_manifest"
    row="$(manifest_row "$runtime_id" || true)"
    [[ "$row" == "$expected" ]] || { printf '%s launcher manifest intent, mode, or target is stale\n' "$runtime_id" >&2; exit 1; }
    [[ -f "${DESKTOP_DIR}/${desktop_file}" && ! -L "${DESKTOP_DIR}/${desktop_file}"
      && -f "${PIXMAP_DIR}/${icon_file}" && ! -L "${PIXMAP_DIR}/${icon_file}" ]] \
      || { printf '%s launcher is incomplete\n' "$runtime_id" >&2; exit 1; }
    [[ "$(stat -c '%a' "${DESKTOP_DIR}/${desktop_file}")" == '755' ]] \
      || { printf '%s desktop entry mode is invalid\n' "$runtime_id" >&2; exit 1; }
    [[ "$(stat -c '%a' "${PIXMAP_DIR}/${icon_file}")" == '644' ]] \
      || { printf '%s icon mode is invalid\n' "$runtime_id" >&2; exit 1; }
    content="$(desktop_entry_content "$runtime_id" "$label" "$intent" "$mode" "$desktop_file" "$icon_file" "$auth_policy" "$comment")"
    content+=$'\n'
    cmp -s <(printf '%s' "$content") "${DESKTOP_DIR}/${desktop_file}" \
      || { printf '%s desktop entry does not match its catalog intent and mode\n' "$runtime_id" >&2; exit 1; }
    actual_sha="$(sha256sum "${PIXMAP_DIR}/${icon_file}" | awk '{print $1}')"
    [[ "$actual_sha" == "$icon_sha" ]] || { printf '%s icon identity digest is stale\n' "$runtime_id" >&2; exit 1; }
  done < <(runtime_catalog)

  cmp -s "$temporary_manifest" "$MANIFEST" \
    || { printf 'AI runtime launcher manifest contains missing, extra, or misidentified rows\n' >&2; exit 1; }
  verify_legacy_assets_absent
  cleanup_verify_manifest_temporary
  trap - EXIT
  if (( ${#blockers[@]} > 0 )); then
    printf 'AI runtime launcher readiness blocked:\n' >&2
    printf ' - %s\n' "${blockers[@]}" >&2
    exit 1
  fi
  printf 'verified\n'
}

remove_launchers() {
  require_root remove
  validate_managed_paths
  validate_catalog
  local purge_profiles=0 runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment
  local content manifest_identity
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge-profiles) purge_profiles=1 ;;
      *) usage ;;
    esac
    shift
  done
  for directory in "$RD_HOME" "$DESKTOP_DIR" "$STATE_DIR" "$PIXMAP_DIR" "$PROFILE_ROOT"; do
    reject_linked_directory "$directory"
  done
  acquire_mutation_lock
  ensure_state_directory_under_lock
  for directory in "$RD_HOME" "$DESKTOP_DIR" "$STATE_DIR" "$PIXMAP_DIR" "$PROFILE_ROOT"; do
    reject_linked_directory "$directory"
  done
  cleanup_stale_managed_temporaries
  attest_manifest_for_mutation >/dev/null
  attest_legacy_assets
  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    content="$(desktop_entry_content "$runtime_id" "$label" "$intent" "$mode" "$desktop_file" "$icon_file" "$auth_policy" "$comment")"
    content+=$'\n'
    attest_current_removal_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
  done < <(runtime_catalog)
  while IFS=$'\t' read -r runtime_id label intent mode declared_target args_spec env_spec launch_policy desktop_file icon_file debug_port auth_policy icon_sha comment; do
    content="$(desktop_entry_content "$runtime_id" "$label" "$intent" "$mode" "$desktop_file" "$icon_file" "$auth_policy" "$comment")"
    content+=$'\n'
    remove_current_runtime_assets "$runtime_id" "$desktop_file" "$icon_file" "$icon_sha" "$content"
  done < <(runtime_catalog)
  remove_legacy_assets
  if [[ -e "$MANIFEST" || -L "$MANIFEST" ]]; then
    manifest_identity="$(path_identity "$MANIFEST")"
    run_test_before_mutation_hook remove-manifest "$MANIFEST"
    attest_manifest_for_mutation >/dev/null
    assert_path_identity "$MANIFEST" "$manifest_identity"
    rm -f -- "$MANIFEST"
    changed=1
  fi
  if [[ "$purge_profiles" == '1' && ( -d "$PROFILE_ROOT" || -L "$PROFILE_ROOT" ) ]]; then
    [[ "$PROFILE_ROOT" == "${RD_HOME}/.config/bridges-ai-runtime-browser" || -n "${BRIDGES_RD_PROFILE_ROOT:-}" ]] || exit 1
    rm -rf -- "$PROFILE_ROOT"
  fi
  if [[ "$purge_profiles" == '1' && ( -d "$LEGACY_PROFILE_ROOT" || -L "$LEGACY_PROFILE_ROOT" ) ]]; then
    [[ "$LEGACY_PROFILE_ROOT" == "${RD_HOME}/.config/bridges-ai-provider-browser" ]] || exit 1
    rm -rf -- "$LEGACY_PROFILE_ROOT"
  fi
  rmdir "$STATE_DIR" 2>/dev/null || true
  printf 'removed\n'
}

case "${1:-}" in
  catalog) [[ $# -eq 1 ]] || usage; print_catalog ;;
  install) install_launchers "$@" ;;
  verify) [[ $# -eq 1 ]] || usage; verify_launchers ;;
  launch) [[ $# -eq 2 ]] || usage; launch_runtime "$2" ;;
  terminal) [[ $# -eq 2 ]] || usage; terminal_runtime "$2" ;;
  remove) remove_launchers "$@" ;;
  *) usage ;;
esac
