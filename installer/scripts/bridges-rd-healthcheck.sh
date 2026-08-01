#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Out-of-process Remote Desktop recovery. The VNC service's semantic guard
# catches a locked/dead XFCE session while it is running; this timer also
# recovers a service that exhausted its own restart limit during boot.

readonly MUTATION_LOCK='/run/bridgesllm-remote-desktop.lock'
readonly STATE_ROOT='/run/bridges-rd'
readonly HEALTH_LOCK="${STATE_ROOT}/healthcheck.lock"
readonly STATE_FILE="${STATE_ROOT}/health-state.json"
readonly HISTORY_FILE="${STATE_ROOT}/restart-history"
readonly SUPPRESSION_FILE="${STATE_ROOT}/suppressed-until"
readonly LAST_RECOVERY_FILE="${STATE_ROOT}/last-recovery-at"
readonly SESSION_GUARD='/usr/local/bin/bridges-rd-session-guard.sh'
readonly VNC_SERVICE='bridges-rd-xtigervnc.service'
readonly WEB_SERVICE='bridges-rd-websockify.service'
readonly MAX_RESTARTS=3
readonly RESTART_WINDOW_SECONDS=600
readonly SUPPRESSION_SECONDS=900
readonly MAX_HISTORY_BYTES=65536
readonly MUTATION_LOCK_MAX_BYTES=8192
readonly GUARD_TIMEOUT_SECONDS=30

mutation_token=''
scratch_file=''

log() {
  printf '[bridges-rd-healthcheck] %s\n' "$*" >&2
}

require_root_state_directory() {
  if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
    [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] \
      || { log "refusing unsafe state path: ${STATE_ROOT}"; return 1; }
    [[ "$(stat -c '%U:%G' "$STATE_ROOT" 2>/dev/null || true)" == 'root:root' ]] \
      || { log "state directory is not owned by root:root: ${STATE_ROOT}"; return 1; }
    chmod 0755 "$STATE_ROOT"
  else
    install -d -m 0755 -o root -g root "$STATE_ROOT"
  fi
}

cleanup() {
  if [[ -n "$scratch_file" && "$scratch_file" == "${STATE_ROOT}/"* ]]; then
    rm -f -- "$scratch_file"
  fi
  release_mutation_lock
}

write_state() {
  local status="$1" note="$2" checked_at="$3" last_recovery_at="$4" suppressed_until="$5"
  local temporary="${STATE_ROOT}/.health-state.tmp.$$.$RANDOM"
  python3 - "$temporary" "$STATE_FILE" "$STATE_ROOT" \
    "$status" "$note" "$checked_at" "$last_recovery_at" "$suppressed_until" <<'PY'
import json
import os
import sys

temporary, target, state_root, status, note, checked_at, last_recovery_at, suppressed_until = sys.argv[1:]
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW

payload = {
    "schema": 1,
    "status": status[:32],
    "note": note[:500],
    "checkedAt": int(checked_at),
    "lastRecoveryAt": int(last_recovery_at) if last_recovery_at else None,
    "suppressedUntil": int(suppressed_until) if suppressed_until else None,
}
encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
if len(encoded) > 2048:
    raise RuntimeError("health state exceeded its bounded payload size")

fd = None
try:
    fd = os.open(temporary, flags, 0o644)
    view = memoryview(encoded)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while persisting Remote Desktop health state")
        view = view[written:]
    os.fsync(fd)
    os.fchmod(fd, 0o644)
    os.close(fd)
    fd = None
    os.replace(temporary, target)
    directory_fd = os.open(state_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if fd is not None:
        os.close(fd)
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

atomic_write_private_text() {
  local target="$1" content="$2"
  scratch_file="$(mktemp "${STATE_ROOT}/.$(basename "$target").tmp.XXXXXX")"
  printf '%s\n' "$content" >"$scratch_file"
  chmod 0600 "$scratch_file"
  mv -fT -- "$scratch_file" "$target"
  scratch_file=''
}

# Return 0 and print a small, root-owned regular file, 1 when absent, or 2
# when present but unsafe/malformed. Callers fail closed on status 2.
read_secure_small_file() {
  local target="$1" max_bytes="$2" metadata
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 1
  fi
  [[ -f "$target" && ! -L "$target" ]] || return 2
  metadata="$(stat -c '%U:%G:%a:%s:%h' "$target" 2>/dev/null || true)"
  [[ "$metadata" =~ ^root:root:(600|644):([0-9]+):1$ ]] || return 2
  (( BASH_REMATCH[2] <= max_bytes )) || return 2
  cat -- "$target"
}

read_optional_epoch() {
  local target="$1" value result
  if value="$(read_secure_small_file "$target" 32)"; then
    [[ "$value" =~ ^[0-9]{1,12}$ ]] || return 2
    printf '%s' "$value"
    return 0
  else
    result=$?
    return "$result"
  fi
}

last_recovery_at() {
  local value result
  if value="$(read_optional_epoch "$LAST_RECOVERY_FILE")"; then
    printf '%s' "$value"
    return 0
  else
    result=$?
    if (( result == 1 )); then
      return 0
    fi
    return 2
  fi
}

guard_is_trusted() {
  local metadata
  [[ -f "$SESSION_GUARD" && ! -L "$SESSION_GUARD" && -x "$SESSION_GUARD" ]] || return 1
  metadata="$(stat -c '%U:%G:%a:%h' "$SESSION_GUARD" 2>/dev/null || true)"
  [[ "$metadata" =~ ^root:root:(700|750|755):1$ ]]
}

run_guard() {
  timeout --signal=TERM --kill-after=5s "${GUARD_TIMEOUT_SECONDS}s" \
    "$SESSION_GUARD" "$@" >/dev/null 2>&1
}

unit_property() {
  local unit="$1" property="$2" value
  value="$(systemctl show "$unit" --property="$property" --value 2>/dev/null)" || return 1
  [[ -n "$value" && "$value" != *$'\n'* ]] || return 1
  printf '%s' "$value"
}

read_unit_states() {
  VNC_LOAD_STATE="$(unit_property "$VNC_SERVICE" LoadState)" || return 1
  VNC_ACTIVE_STATE="$(unit_property "$VNC_SERVICE" ActiveState)" || return 1
  WEB_LOAD_STATE="$(unit_property "$WEB_SERVICE" LoadState)" || return 1
  WEB_ACTIVE_STATE="$(unit_property "$WEB_SERVICE" ActiveState)" || return 1
}

units_are_transitioning() {
  case "${VNC_ACTIVE_STATE}:${WEB_ACTIVE_STATE}" in
    *activating*|*deactivating*|*reloading*|*refreshing*) return 0 ;;
    *) return 1 ;;
  esac
}

release_mutation_lock() {
  [[ -n "$mutation_token" ]] || return 0
  python3 - "$MUTATION_LOCK" "$mutation_token" "$MUTATION_LOCK_MAX_BYTES" <<'PY' >/dev/null 2>&1 || true
import json
import os
import stat
import sys

path, token, max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
        raise SystemExit(0)
    with open(path, "r", encoding="utf-8") as handle:
        record = json.load(handle)
    if not isinstance(record, dict) or record.get("token") != token:
        raise SystemExit(0)
    current = os.lstat(path)
    if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
        raise SystemExit(0)
    os.unlink(path)
except (FileNotFoundError, OSError, UnicodeError, ValueError, json.JSONDecodeError):
    pass
PY
  mutation_token=''
}

# Acquire the same schema-1 O_EXCL JSON lease used by the Portal backend.
# Output from the Python helper is deliberately restricted to one status token.
acquire_mutation_lock() {
  local process_stat rest process_start_ticks candidate_token result
  local -a fields
  process_stat="$(<"/proc/$$/stat")" || return 1
  rest="${process_stat##*) }"
  read -r -a fields <<<"$rest"
  process_start_ticks="${fields[19]:-}"
  [[ "$process_start_ticks" =~ ^[0-9]+$ ]] || return 1
  candidate_token="$(printf '%s' "$$:${process_start_ticks}:$(date +%s%N):${RANDOM}" \
    | sha256sum | awk '{ print $1 }')"

  result="$(python3 - "$MUTATION_LOCK" "$$" "$process_start_ticks" "$candidate_token" \
    "$MUTATION_LOCK_MAX_BYTES" <<'PY'
import datetime
import errno
import json
import os
import stat
import sys
import time

path, owner_pid_raw, owner_ticks, token, max_bytes_raw = sys.argv[1:]
owner_pid = int(owner_pid_raw)
max_bytes = int(max_bytes_raw)
record = {
    "schema": 1,
    "token": token,
    "pid": owner_pid,
    "operation": "automatic Remote Desktop recovery",
    "acquiredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "processStartTicks": owner_ticks,
}
encoded = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")

def process_start_ticks(pid):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
            process_stat = handle.read()
        closing_paren = process_stat.rfind(")")
        if closing_paren < 0:
            return None
        fields = process_stat[closing_paren + 2:].strip().split()
        value = fields[19]
        return value if value.isdigit() else None
    except (FileNotFoundError, IndexError, OSError, UnicodeError):
        return None

def process_is_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True

def acquired_at_is_valid(value):
    if not isinstance(value, str):
        return False
    try:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False

def record_is_valid(value):
    return (
        isinstance(value, dict)
        and type(value.get("schema")) is int
        and value.get("schema") == 1
        and isinstance(value.get("token"), str)
        and type(value.get("pid")) is int
        and abs(value["pid"]) <= 9_007_199_254_740_991
        and isinstance(value.get("operation"), str)
        and isinstance(value.get("acquiredAt"), str)
        and isinstance(value.get("processStartTicks"), str)
        and value["processStartTicks"].isdigit()
    )

def stale_existing_lock():
    try:
        existing_stat = os.lstat(path)
    except FileNotFoundError:
        return True, None
    if not stat.S_ISREG(existing_stat.st_mode):
        return False, existing_stat
    malformed = False
    try:
        if existing_stat.st_size > max_bytes:
            malformed = True
            existing = None
        else:
            with open(path, "r", encoding="utf-8") as handle:
                existing = json.load(handle)
            malformed = not record_is_valid(existing)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        malformed = True
        existing = None
    if malformed:
        return (time.time() - existing_stat.st_mtime >= 30), existing_stat
    if not acquired_at_is_valid(existing["acquiredAt"]):
        return True, existing_stat
    current_ticks = process_start_ticks(existing["pid"])
    if current_ticks is not None:
        return current_ticks != existing["processStartTicks"], existing_stat
    return not process_is_alive(existing["pid"]), existing_stat

def create_lock():
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        view = memoryview(encoded)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write while acquiring Remote Desktop mutation lock")
            view = view[written:]
        os.fsync(fd)
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)

for attempt in range(2):
    try:
        create_lock()
        print("acquired:" + token)
        raise SystemExit(0)
    except FileExistsError:
        stale, prior_stat = stale_existing_lock()
        if not stale or attempt > 0 or prior_stat is None:
            print("busy")
            raise SystemExit(0)
        try:
            current = os.lstat(path)
            if (prior_stat.st_dev, prior_stat.st_ino) != (current.st_dev, current.st_ino):
                print("busy")
                raise SystemExit(0)
            os.unlink(path)
        except FileNotFoundError:
            pass
        except OSError:
            print("error")
            raise SystemExit(0)
    except OSError as error:
        if error.errno == errno.EEXIST:
            print("busy")
        else:
            print("error")
        raise SystemExit(0)
print("busy")
PY
)" || return 1

  case "$result" in
    acquired:*)
      mutation_token="${result#acquired:}"
      [[ "$mutation_token" =~ ^[0-9a-f]{64}$ ]] || { mutation_token=''; return 1; }
      return 0
      ;;
    busy) return 75 ;;
    *) return 1 ;;
  esac
}

[[ "$EUID" -eq 0 ]] || { log 'must run as root'; exit 1; }
require_root_state_directory

if [[ -e "$HEALTH_LOCK" || -L "$HEALTH_LOCK" ]]; then
  [[ -f "$HEALTH_LOCK" && ! -L "$HEALTH_LOCK" ]] \
    || { log "refusing unsafe health lock: ${HEALTH_LOCK}"; exit 1; }
  [[ "$(stat -c '%U:%G:%h' "$HEALTH_LOCK" 2>/dev/null || true)" == 'root:root:1' ]] \
    || { log "health lock is not an attested root-owned file: ${HEALTH_LOCK}"; exit 1; }
  chmod 0600 "$HEALTH_LOCK"
else
  install -m 0600 -o root -g root /dev/null "$HEALTH_LOCK"
fi
exec 9<>"$HEALTH_LOCK"
flock -n 9 || exit 0
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

now="$(date +%s)"
last_recovery=''
if ! last_recovery="$(last_recovery_at)"; then
  write_state unhealthy 'Automatic recovery state is unsafe or malformed.' "$now" '' ''
  exit 1
fi

suppressed_until=''
if suppressed_until="$(read_optional_epoch "$SUPPRESSION_FILE")"; then
  if (( now < suppressed_until )); then
    write_state suppressed 'Automatic recovery is rate-limited after repeated failures.' \
      "$now" "$last_recovery" "$suppressed_until"
    exit 0
  fi
  rm -f -- "$SUPPRESSION_FILE"
else
  suppression_result=$?
  if (( suppression_result == 2 )); then
    write_state unhealthy 'Automatic recovery suppression state is unsafe or malformed.' \
      "$now" "$last_recovery" ''
    exit 1
  fi
fi

if ! guard_is_trusted; then
  write_state unhealthy 'The Remote Desktop session guard is missing or unsafe; no restart was attempted.' \
    "$now" "$last_recovery" ''
  exit 1
fi

if ! read_unit_states; then
  write_state unhealthy 'Could not read authoritative Remote Desktop service state.' \
    "$now" "$last_recovery" ''
  exit 1
fi
if [[ "$VNC_LOAD_STATE" != 'loaded' || "$WEB_LOAD_STATE" != 'loaded' ]]; then
  write_state unhealthy 'A managed Remote Desktop systemd unit is unavailable; no restart was attempted.' \
    "$now" "$last_recovery" ''
  exit 1
fi
if units_are_transitioning; then
  write_state recovering 'Remote Desktop services are already changing state; this timer tick did not interfere.' \
    "$now" "$last_recovery" ''
  exit 0
fi

# Repair only known locker/policy drift before considering a disruptive
# service restart. The guard is scoped to the password-disabled desktop user.
if [[ "$VNC_ACTIVE_STATE" == 'active' && "$WEB_ACTIVE_STATE" == 'active' ]] \
  && run_guard repair; then
  write_state healthy 'Remote Desktop services and graphical session are healthy.' \
    "$now" "$last_recovery" ''
  exit 0
fi

# Setup/manual recovery owns the same O_EXCL JSON lease. Skip this timer tick
# rather than racing a human-triggered mutation.
if acquire_mutation_lock; then
  :
else
  mutation_result=$?
  if (( mutation_result == 75 )); then
    write_state busy 'Another Remote Desktop operation owns the recovery lock.' \
      "$now" "$last_recovery" ''
    exit 0
  fi
  write_state unhealthy 'Could not safely acquire the Remote Desktop recovery lock.' \
    "$now" "$last_recovery" ''
  exit 1
fi

# Close the read-to-restart race: if systemd began a transition while the
# semantic repair ran, leave it alone and let the next timer tick reattest it.
if ! read_unit_states; then
  write_state unhealthy 'Could not re-read Remote Desktop service state before recovery.' \
    "$now" "$last_recovery" ''
  exit 1
fi
if [[ "$VNC_LOAD_STATE" != 'loaded' || "$WEB_LOAD_STATE" != 'loaded' ]]; then
  write_state unhealthy 'A managed Remote Desktop unit disappeared before recovery.' \
    "$now" "$last_recovery" ''
  exit 1
fi
if units_are_transitioning; then
  write_state recovering 'Remote Desktop services began changing state; automatic recovery stood down.' \
    "$now" "$last_recovery" ''
  exit 0
fi

history_tmp="$(mktemp "${STATE_ROOT}/.restart-history.tmp.XXXXXX")"
scratch_file="$history_tmp"
if history="$(read_secure_small_file "$HISTORY_FILE" "$MAX_HISTORY_BYTES")"; then
  if ! printf '%s' "$history" \
    | awk -v threshold="$((now - RESTART_WINDOW_SECONDS))" -v current="$now" '
        NF != 1 || $1 !~ /^[0-9]+$/ { exit 2 }
        $1 >= threshold && $1 <= current { print $1 }
      ' >"$history_tmp"; then
    write_state unhealthy 'Automatic recovery history is malformed.' \
      "$now" "$last_recovery" ''
    exit 1
  fi
else
  history_result=$?
  if (( history_result == 2 )); then
    write_state unhealthy 'Automatic recovery history is unsafe or malformed.' \
      "$now" "$last_recovery" ''
    exit 1
  fi
  : >"$history_tmp"
fi
chmod 0600 "$history_tmp"
mv -fT -- "$history_tmp" "$HISTORY_FILE"
scratch_file=''
restart_count="$(wc -l <"$HISTORY_FILE" | tr -d '[:space:]')"
[[ "$restart_count" =~ ^[0-9]+$ ]] || {
  write_state unhealthy 'Could not validate automatic recovery history.' \
    "$now" "$last_recovery" ''
  exit 1
}
if (( restart_count >= MAX_RESTARTS )); then
  suppressed_until="$((now + SUPPRESSION_SECONDS))"
  atomic_write_private_text "$SUPPRESSION_FILE" "$suppressed_until"
  write_state suppressed 'Automatic recovery paused for 15 minutes after three restart attempts.' \
    "$now" "$last_recovery" "$suppressed_until"
  exit 0
fi

history_tmp="$(mktemp "${STATE_ROOT}/.restart-history.tmp.XXXXXX")"
scratch_file="$history_tmp"
{
  cat -- "$HISTORY_FILE"
  printf '%s\n' "$now"
} >"$history_tmp"
chmod 0600 "$history_tmp"
mv -fT -- "$history_tmp" "$HISTORY_FILE"
scratch_file=''

systemctl reset-failed "$VNC_SERVICE" "$WEB_SERVICE" >/dev/null 2>&1 || true
if systemctl restart "$VNC_SERVICE" \
  && systemctl restart "$WEB_SERVICE" \
  && read_unit_states \
  && [[ "$VNC_LOAD_STATE" == 'loaded' && "$WEB_LOAD_STATE" == 'loaded' ]] \
  && [[ "$VNC_ACTIVE_STATE" == 'active' && "$WEB_ACTIVE_STATE" == 'active' ]] \
  && run_guard check; then
  atomic_write_private_text "$LAST_RECOVERY_FILE" "$now"
  write_state recovered 'Remote Desktop was restarted and the graphical session was verified.' \
    "$now" "$now" ''
  exit 0
fi

write_state unhealthy 'Automatic recovery could not restore a verified graphical session.' \
  "$now" "$last_recovery" ''
exit 1
