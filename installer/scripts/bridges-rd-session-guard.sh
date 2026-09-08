#!/usr/bin/env bash
set -Eeuo pipefail

# Bridges Remote Desktop session guard
#
# The Remote Desktop account intentionally has no usable password. Any screen
# locker or graphical greeter on display :1 is therefore an unrecoverable UI
# dead end for the operator. This helper prevents that state, verifies the real
# XFCE session (not merely the VNC socket), and lets systemd restart the stack
# when the desktop itself has died.

ACTION="${1:-check}"
VNC_PID="${2:-}"
XFCE_PID="${3:-}"
RD_USER="${RD_USER:-bridgesrd}"
RD_HOME="${RD_HOME:-/home/${RD_USER}}"
DISPLAY_NUM="${DISPLAY_NUM:-:1}"
XAUTHORITY_FILE="${XAUTHORITY_FILE:-${RD_HOME}/.Xauthority}"
CHECK_INTERVAL_SECONDS="${BRIDGES_RD_GUARD_INTERVAL_SECONDS:-10}"
FAILURES_BEFORE_RESTART="${BRIDGES_RD_GUARD_FAILURES_BEFORE_RESTART:-2}"
AUTOSTART_DIR="${RD_HOME}/.config/autostart"

export DISPLAY="$DISPLAY_NUM"
export XAUTHORITY="$XAUTHORITY_FILE"

log() {
  printf '[bridges-rd-session-guard] %s\n' "$*"
}

process_has_display() {
  local pid="$1" entry
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/${pid}/environ" ]] || return 1
  # /proc environment records are NUL-delimited. Builtin reads avoid a tr/grep
  # process pair for every inspected desktop process under installation load.
  while IFS= read -r -d '' entry; do
    [[ "$entry" == "DISPLAY=${DISPLAY_NUM}" || "$entry" == "DISPLAY=${DISPLAY_NUM}.0" ]] && return 0
  done < "/proc/${pid}/environ"
  return 1
}

process_on_display() {
  local process_name="$1" pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    process_has_display "$pid" && return 0
  done < <(pgrep -u "$RD_USER" -x "$process_name" 2>/dev/null || true)
  return 1
}

desktop_session_pid() {
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    process_has_display "$pid" || continue
    printf '%s\n' "$pid"
    return 0
  done < <(pgrep -u "$RD_USER" -x xfce4-session 2>/dev/null || true)
  return 1
}

desktop_session_env_value() {
  local key="$1" pid entry
  pid="$(desktop_session_pid || true)"
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/${pid}/environ" ]] || return 1
  while IFS= read -r -d '' entry; do
    if [[ "$entry" == "${key}="* ]]; then
      printf '%s' "${entry#*=}"
      return 0
    fi
  done < "/proc/${pid}/environ"
  return 1
}

run_desktop_bus_command() {
  local dbus_address xdg_runtime
  dbus_address="$(desktop_session_env_value DBUS_SESSION_BUS_ADDRESS || true)"
  xdg_runtime="$(desktop_session_env_value XDG_RUNTIME_DIR || true)"
  [[ -n "$dbus_address" ]] || return 1
  runuser -u "$RD_USER" -- env \
    HOME="$RD_HOME" \
    DISPLAY="$DISPLAY_NUM" \
    XAUTHORITY="$XAUTHORITY_FILE" \
    DBUS_SESSION_BUS_ADDRESS="$dbus_address" \
    XDG_RUNTIME_DIR="${xdg_runtime:-/tmp/bridges-rd-runtime}" \
    "$@"
}

run_xfconf() {
  run_desktop_bus_command xfconf-query "$@"
}

known_locker_running() {
  ps -ww -u "$RD_USER" -o args= 2>/dev/null \
    | grep -Eq '(^|/)(xfce4-screensaver|light-locker|xscreensaver|xss-lock)( |$)'
}

foreign_greeter_on_display() {
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    process_has_display "$pid" && return 0
  done < <(pgrep -f '(^|/)(lightdm-gtk-greeter|slick-greeter)( |$)' 2>/dev/null || true)
  return 1
}

disable_locker_autostart() {
  runuser -u "$RD_USER" -- env HOME="$RD_HOME" /bin/bash -c '
    set -Eeuo pipefail
    umask 022
    mkdir -p "$HOME/.config/autostart"
    for entry in xfce4-screensaver.desktop light-locker.desktop xscreensaver.desktop; do
      cat > "$HOME/.config/autostart/$entry" <<EOF
[Desktop Entry]
Type=Application
Name=Remote Desktop locker disabled
Hidden=true
X-GNOME-Autostart-enabled=false
EOF
    done
  '
}

locker_autostart_is_disabled() {
  local entry path line hidden disabled
  for entry in xfce4-screensaver.desktop light-locker.desktop xscreensaver.desktop; do
    path="${AUTOSTART_DIR}/${entry}"
    [[ -f "$path" && ! -L "$path" ]] || return 1
    [[ "$(stat -c '%U:%G:%a' "$path" 2>/dev/null || true)" == "${RD_USER}:${RD_USER}:644" ]] || return 1
    hidden=false; disabled=false
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" == 'Hidden=true' ]] && hidden=true
      [[ "$line" == 'X-GNOME-Autostart-enabled=false' ]] && disabled=true
    done < "$path"
    [[ "$hidden" == true && "$disabled" == true ]] || return 1
  done
}

converge_xfce_lock_policy() {
  # Resolve the session bus and privilege boundary once for all writes, just
  # as for the read-only snapshot. Cold-start repair must not repeatedly pay
  # the environment lookup/PAM cost while XFCE itself is still starting.
  run_desktop_bus_command /bin/sh -c '
    xfconf-query -c xfce4-session -p /general/LockCommand -s /bin/true >/dev/null 2>&1 \
      || xfconf-query -c xfce4-session -p /general/LockCommand --create -t string -s /bin/true >/dev/null 2>&1 \
      || true
    xfconf-query -c xfce4-keyboard-shortcuts -p "/commands/custom/<Primary><Alt>l" -s /bin/true >/dev/null 2>&1 \
      || xfconf-query -c xfce4-keyboard-shortcuts -p "/commands/custom/<Primary><Alt>l" --create -t string -s /bin/true >/dev/null 2>&1 \
      || true
    # Preserve the managed panel layout without an impossible password prompt.
    xfconf-query -c xfce4-panel -p /plugins/plugin-14 -s separator >/dev/null 2>&1 || true
  ' || true
}

xfce_lock_policy_is_disabled() {
  # Resolve the desktop bus and drop privileges once for this read-only
  # snapshot. Repeating the process/environment/PAM setup for each property
  # consumed most of the watchdog budget on a loaded fresh-install host.
  run_desktop_bus_command /bin/sh -c '
    lock_command="$(xfconf-query -c xfce4-session -p /general/LockCommand 2>/dev/null)" || exit 1
    [ "$lock_command" = /bin/true ] || exit 1
    lock_shortcut="$(xfconf-query -c xfce4-keyboard-shortcuts -p "/commands/custom/<Primary><Alt>l" 2>/dev/null)" || exit 1
    [ "$lock_shortcut" = /bin/true ] || exit 1
    actions_plugin="$(xfconf-query -c xfce4-panel -p /plugins/plugin-14 2>/dev/null)" || exit 1
    [ "$actions_plugin" = separator ]
  '
}

prepare_display_lock() {
  local lock_file=/tmp/.X1-lock
  local socket_file=/tmp/.X11-unix/X1
  local owner_pid=''
  if [[ -f "$lock_file" ]]; then
    owner_pid="$(tr -cd '0-9' < "$lock_file" 2>/dev/null || true)"
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    log "display ${DISPLAY_NUM} is already owned by live pid ${owner_pid}; refusing to delete its lock"
    return 1
  fi
  rm -f -- "$lock_file" "$socket_file"
}

terminate_known_lockers() {
  pkill -u "$RD_USER" -f '(^|/)xfce4-screensaver($| )' 2>/dev/null || true
  pkill -u "$RD_USER" -x light-locker 2>/dev/null || true
  pkill -u "$RD_USER" -x xscreensaver 2>/dev/null || true
  pkill -u "$RD_USER" -x xss-lock 2>/dev/null || true
}

reset_idle_policy() {
  DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE" xset s off 2>/dev/null || true
  DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE" xset s noblank 2>/dev/null || true
  # TigerVNC builds without the DPMS extension return a harmless error here.
  DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE" xset -dpms 2>/dev/null || true
}

screen_policy_is_safe() {
  local state
  state="$(DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE" xset q 2>&1)" || return 1
  [[ "$state" =~ prefer\ blanking:[[:space:]]+no ]] || return 1
  [[ "$state" =~ timeout:[[:space:]]+0([[:space:]]|$) ]] || return 1
  [[ "$state" == *'DPMS is Disabled'* || "$state" == *'Server does not have the DPMS Extension'* ]] || return 1
}

check_session() {
  # Exit 2 means the desktop runtime is absent/not responsive, not policy
  # drift. Policy writes cannot start these processes and must not contend
  # with their cold-start work. Both nonzero outcomes remain not-ready.
  DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE" xdpyinfo >/dev/null 2>&1 \
    || { log "display ${DISPLAY_NUM} is not responsive"; return 2; }
  process_on_display xfce4-session \
    || { log "xfce4-session is missing from ${DISPLAY_NUM}"; return 2; }
  process_on_display xfwm4 \
    || { log "xfwm4 is missing from ${DISPLAY_NUM}"; return 2; }
  process_on_display xfdesktop \
    || { log "xfdesktop is missing from ${DISPLAY_NUM}"; return 2; }
  ! known_locker_running \
    || { log "a password locker is running for ${RD_USER}"; return 1; }
  ! foreign_greeter_on_display \
    || { log "a graphical greeter owns ${DISPLAY_NUM}"; return 1; }
  locker_autostart_is_disabled \
    || { log "locker autostart policy is missing or unsafe"; return 1; }
  xfce_lock_policy_is_disabled \
    || { log "XFCE still exposes a lock command"; return 1; }
  screen_policy_is_safe \
    || { log "X blanking or display power policy is unsafe on ${DISPLAY_NUM}"; return 1; }
  return 0
}

repair_session() {
  disable_locker_autostart
  converge_xfce_lock_policy
  terminate_known_lockers
  reset_idle_policy
}

check_or_repair_session() {
  local result=0
  check_session || result=$?
  case "$result" in
    0) return 0 ;;
    2) return 2 ;;
  esac
  repair_session && check_session
}

watch_session() {
  [[ "$VNC_PID" =~ ^[0-9]+$ ]] || { log 'watch requires a VNC pid'; return 2; }
  [[ "$XFCE_PID" =~ ^[0-9]+$ ]] || { log 'watch requires an XFCE pid'; return 2; }

  local failures=0
  while kill -0 "$VNC_PID" 2>/dev/null && kill -0 "$XFCE_PID" 2>/dev/null; do
    # Healthy checks are read-only. Repair only observed drift, and still
    # require the complete semantic check before sending a heartbeat.
    if check_or_repair_session; then
      failures=0
      # The launcher execs this guard after READY, so its PID remains the
      # systemd main PID. Attribute each heartbeat to that stable parent of
      # systemd-notify while rejecting notifications from desktop children.
      if ! systemd-notify --pid=parent --status='Remote Desktop session ready' WATCHDOG=1 2>/dev/null; then
        log 'systemd rejected the Remote Desktop watchdog heartbeat'
        return 1
      fi
    else
      failures=$((failures + 1))
      log "semantic health check failed (${failures}/${FAILURES_BEFORE_RESTART})"
      if (( failures >= FAILURES_BEFORE_RESTART )); then
        return 1
      fi
    fi
    sleep "$CHECK_INTERVAL_SECONDS"
  done

  log 'VNC or XFCE process exited'
  return 1
}

case "$ACTION" in
  prepare)
    prepare_display_lock
    disable_locker_autostart
    terminate_known_lockers
    ;;
  repair)
    # The recovery timer and startup both use this action. Leave an already
    # healthy desktop untouched, then verify any repair before accepting it.
    check_or_repair_session
    ;;
  check)
    check_session
    ;;
  watch)
    watch_session
    ;;
  *)
    printf 'Usage: %s {prepare|repair|check|watch [vnc-pid xfce-pid]}\n' "$0" >&2
    exit 2
    ;;
esac
