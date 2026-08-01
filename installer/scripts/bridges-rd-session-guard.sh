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

process_on_display() {
  local process_name="$1"
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null \
      | grep -Eq "^DISPLAY=${DISPLAY_NUM//./\\.}(\\.0)?$"; then
      return 0
    fi
  done < <(pgrep -u "$RD_USER" -x "$process_name" 2>/dev/null || true)
  return 1
}

desktop_session_pid() {
  pgrep -u "$RD_USER" -x xfce4-session 2>/dev/null | head -n 1
}

desktop_session_env_value() {
  local key="$1"
  local pid
  pid="$(desktop_session_pid || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null \
    | sed -n "s/^${key}=//p" \
    | head -n 1
}

run_xfconf() {
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
    xfconf-query "$@"
}

known_locker_running() {
  ps -u "$RD_USER" -o args= 2>/dev/null \
    | grep -Eq '(^|/)(xfce4-screensaver|light-locker|xscreensaver|xss-lock)( |$)'
}

foreign_greeter_on_display() {
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null \
      | grep -Eq "^DISPLAY=${DISPLAY_NUM//./\\.}(\\.0)?$"; then
      return 0
    fi
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
  local entry path
  for entry in xfce4-screensaver.desktop light-locker.desktop xscreensaver.desktop; do
    path="${AUTOSTART_DIR}/${entry}"
    [[ -f "$path" && ! -L "$path" ]] || return 1
    [[ "$(stat -c '%U:%G:%a' "$path" 2>/dev/null || true)" == "${RD_USER}:${RD_USER}:644" ]] || return 1
    grep -Fx 'Hidden=true' "$path" >/dev/null 2>&1 || return 1
    grep -Fx 'X-GNOME-Autostart-enabled=false' "$path" >/dev/null 2>&1 || return 1
  done
}

converge_xfce_lock_policy() {
  run_xfconf -c xfce4-session -p /general/LockCommand -s /bin/true >/dev/null 2>&1 \
    || run_xfconf -c xfce4-session -p /general/LockCommand --create -t string -s /bin/true >/dev/null 2>&1 \
    || true
  run_xfconf -c xfce4-keyboard-shortcuts -p '/commands/custom/<Primary><Alt>l' -s /bin/true >/dev/null 2>&1 \
    || run_xfconf -c xfce4-keyboard-shortcuts -p '/commands/custom/<Primary><Alt>l' --create -t string -s /bin/true >/dev/null 2>&1 \
    || true
  # The stock actions plugin exposes a Lock Screen action. A separator keeps
  # the panel layout stable without offering an impossible password prompt.
  run_xfconf -c xfce4-panel -p /plugins/plugin-14 -s separator >/dev/null 2>&1 || true
}

xfce_lock_policy_is_disabled() {
  [[ "$(run_xfconf -c xfce4-session -p /general/LockCommand 2>/dev/null || true)" == '/bin/true' ]] \
    || return 1
  [[ "$(run_xfconf -c xfce4-keyboard-shortcuts -p '/commands/custom/<Primary><Alt>l' 2>/dev/null || true)" == '/bin/true' ]] \
    || return 1
  [[ "$(run_xfconf -c xfce4-panel -p /plugins/plugin-14 2>/dev/null || true)" == 'separator' ]] \
    || return 1
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
  grep -Eq 'prefer blanking:[[:space:]]+no' <<< "$state" || return 1
  grep -Eq 'timeout:[[:space:]]+0([[:space:]]|$)' <<< "$state" || return 1
  grep -Eq 'DPMS is Disabled|Server does not have the DPMS Extension' <<< "$state" || return 1
}

check_session() {
  DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTHORITY_FILE" xdpyinfo >/dev/null 2>&1 \
    || { log "display ${DISPLAY_NUM} is not responsive"; return 1; }
  process_on_display xfce4-session \
    || { log "xfce4-session is missing from ${DISPLAY_NUM}"; return 1; }
  process_on_display xfwm4 \
    || { log "xfwm4 is missing from ${DISPLAY_NUM}"; return 1; }
  process_on_display xfdesktop \
    || { log "xfdesktop is missing from ${DISPLAY_NUM}"; return 1; }
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

watch_session() {
  [[ "$VNC_PID" =~ ^[0-9]+$ ]] || { log 'watch requires a VNC pid'; return 2; }
  [[ "$XFCE_PID" =~ ^[0-9]+$ ]] || { log 'watch requires an XFCE pid'; return 2; }

  local failures=0
  while kill -0 "$VNC_PID" 2>/dev/null && kill -0 "$XFCE_PID" 2>/dev/null; do
    repair_session
    if check_session; then
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
    repair_session
    check_session
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
