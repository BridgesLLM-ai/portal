#!/bin/bash
set -euo pipefail

# Bridges Remote Desktop — Xtigervnc + XFCE wrapper
# Starts Xtigervnc on :1 with no VNC auth (portal JWT handles auth)
# Then launches XFCE desktop as bridgesrd user

DISPLAY_NUM=:1
VNC_PORT=5901
GEOMETRY=1920x1080
DEPTH=24
RD_USER=bridgesrd
XDG_DIR="/tmp/bridges-rd-runtime"
LOG_DIR="/var/log/bridges-rd"

# Create log directory (not in /tmp, avoids protected_regular issues)
mkdir -p "$LOG_DIR"
chown "$RD_USER:$RD_USER" "$LOG_DIR"

# Clean up stale lock files
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# Clean up stale Xvfb/display :99 remnants
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
pkill -u "$RD_USER" -f "Xvfb" 2>/dev/null || true

# Kill any leftover XFCE sessions from this user before starting fresh
pkill -u "$RD_USER" -f "xfce4-session" 2>/dev/null || true

# Ensure XDG_RUNTIME_DIR exists for the desktop user
mkdir -p "$XDG_DIR"
chown "$RD_USER:$RD_USER" "$XDG_DIR"
chmod 700 "$XDG_DIR"

# Start Xtigervnc as root (it manages its own display)
/usr/bin/Xtigervnc "$DISPLAY_NUM" \
  -UseBlacklist=0 \
  -localhost=1 \
  -desktop "BridgesLLM Remote Desktop" \
  -rfbport "$VNC_PORT" \
  -SecurityTypes None \
  -geometry "$GEOMETRY" \
  -depth "$DEPTH" \
  -ac &

VNC_PID=$!

# Wait for the display to become available
for i in $(seq 1 20); do
  if DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
    echo "Display $DISPLAY_NUM is ready (attempt $i)"
    break
  fi
  sleep 0.5
done

# Start PulseAudio for audio support (virtual null sink → browser WebSocket)
su - "$RD_USER" -c "
  export XDG_RUNTIME_DIR=$XDG_DIR
  # Kill stale PulseAudio
  pulseaudio --kill 2>/dev/null || true
  sleep 0.5
  # Start PulseAudio daemon with virtual null sink as default
  pulseaudio --start --exit-idle-time=-1 2>>$LOG_DIR/pulseaudio.log
  sleep 1
  # Configure for audio streaming
  export PULSE_SERVER=unix:$XDG_DIR/pulse/native
  pactl set-default-sink auto_null 2>/dev/null || true
  # CRITICAL: Unload suspend-on-idle so the monitor source always streams
  # Without this, parec blocks when no audio is playing and the browser gets no data
  pactl unload-module module-suspend-on-idle 2>/dev/null || true
  echo 'PulseAudio started (suspend-on-idle disabled)'
" &
PA_PID=$!
wait $PA_PID 2>/dev/null || true
echo "PulseAudio initialized"

# Start XFCE as bridgesrd user on display :1
# Note: redirect is inside su -c to avoid fs.protected_regular issues with /tmp
su - "$RD_USER" -c "
  export DISPLAY=$DISPLAY_NUM
  export XDG_RUNTIME_DIR=$XDG_DIR
  export PULSE_SERVER=unix:$XDG_DIR/pulse/native
  dbus-launch --exit-with-session startxfce4 >>$LOG_DIR/xfce.log 2>&1
" &

XFCE_PID=$!
echo "Xtigervnc PID=$VNC_PID, XFCE PID=$XFCE_PID"

# Wait for XFCE to start, then disable screensaver/blanking
sleep 5
DISPLAY="$DISPLAY_NUM" xset s off 2>/dev/null || true
DISPLAY="$DISPLAY_NUM" xset s noblank 2>/dev/null || true
# Kill screensaver if auto-started by XFCE
pkill -f xfce4-screensaver 2>/dev/null || true
echo "Screensaver disabled"

# Wait for VNC (main process). If it dies, everything should stop.
wait $VNC_PID
