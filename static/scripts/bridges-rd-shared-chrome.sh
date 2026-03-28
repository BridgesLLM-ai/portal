#!/usr/bin/env bash
# Shared browser for VNC Remote Desktop
# Always starts clean and matches the active VNC resolution.
set -euo pipefail

USER_URL="${1:-about:blank}"

# Never let root own or mutate the shared browser profile.
if [ "$(id -u)" = "0" ]; then
  if id bridgesrd >/dev/null 2>&1; then
    exec su - bridgesrd -c "DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime PULSE_SERVER=unix:/tmp/bridges-rd-runtime /usr/local/bin/bridges-rd-shared-chrome.sh $(printf '%q' "$USER_URL")"
  fi
  echo "ERROR: Must not run shared browser as root without bridgesrd user" >&2
  exit 1
fi

export DISPLAY="${DISPLAY:-:1}"
export XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime
export PULSE_SERVER=unix:/tmp/bridges-rd-runtime/pulse/native

PROFILE_ROOT="/tmp/bridges-agent-browser"
PROFILE_DIR="${PROFILE_ROOT}/profile"
CDP_PORT=18801

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found" >&2
  exit 1
fi

pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
sleep 1

VNC_RES=$(DISPLAY=:1 xrandr 2>/dev/null | grep -E '\*' | awk '{print $1}' || echo "1280x1024")
VNC_W=$(echo "$VNC_RES" | cut -d'x' -f1)
VNC_H=$(echo "$VNC_RES" | cut -d'x' -f2)

rm -rf "$PROFILE_ROOT" 2>/dev/null || true
mkdir -p "$PROFILE_DIR"

# Write a Preferences file that forces Chrome to use the VNC window size
# instead of its internal 1400x900 default viewport.
mkdir -p "$PROFILE_DIR/Default"
cat > "$PROFILE_DIR/Default/Preferences" <<PREFS
{
  "browser": {
    "window_placement": {
      "bottom": ${VNC_H},
      "left": 0,
      "maximized": true,
      "right": ${VNC_W},
      "top": 0,
      "work_area_bottom": ${VNC_H},
      "work_area_left": 0,
      "work_area_right": ${VNC_W},
      "work_area_top": 0
    }
  }
}
PREFS

"$CHROME_BIN" \
  --window-size="${VNC_W},${VNC_H}" \
  --start-maximized \
  --new-window \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-gpu-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=${CDP_PORT} \
  "$USER_URL" &

CHROME_PID=$!

for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if command -v wmctrl >/dev/null 2>&1; then
  sleep 1
  wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz 2>/dev/null || true
fi

wait $CHROME_PID 2>/dev/null || true
1 20); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if command -v wmctrl >/dev/null 2>&1; then
  sleep 1
  wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz 2>/dev/null || true
fi

wait $CHROME_PID 2>/dev/null || true
