#!/usr/bin/env bash
# Dedicated persistent instance of Portal Shared Chrome, on the isolated Portal browser desktop.
set -euo pipefail
[[ "$(id -un)" == bridgesbrowser ]] || { echo 'Shared Chrome requires bridgesbrowser' >&2; exit 77; }
[[ ! -e /etc/bridges-shared-chrome.disabled && ! -e /run/bridges-shared-chrome.disabled ]] || exit 75
umask 077
export DISPLAY=:2
export XAUTHORITY=/run/bridges-shared-desktop/transport/Xauthority
PROFILE=/home/bridgesbrowser/.config/portal-shared/profile
[[ ! -L "$PROFILE" ]] || { echo 'Shared profile must not be a symlink' >&2; exit 77; }
mkdir -p "$PROFILE"
chmod 700 "$PROFILE"
BROWSER_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
[[ -n "$BROWSER_BIN" ]] || { echo 'Chrome/Chromium is unavailable' >&2; exit 69; }
# No profile import, deletion, root/no-sandbox execution or node/RDP display fallback.
exec "$BROWSER_BIN" --user-data-dir="$PROFILE" --remote-debugging-address=127.0.0.1   --remote-debugging-port=18901 --no-first-run --no-default-browser-check   --disable-sync --password-store=basic --window-size=1440,900 --window-position=0,0 --start-maximized about:blank
