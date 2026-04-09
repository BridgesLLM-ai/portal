#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/usr/lib/node_modules/openclaw/dist}"

resolve_bundle() {
  local prefix="$1"
  python3 - "$ROOT" "$prefix" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
prefix = sys.argv[2]
matches = sorted(root.glob(f"{prefix}*.js"))
if not matches:
    raise SystemExit(f"bundle not found for prefix {prefix!r} in {root}")
print(matches[0])
PY
}

HEARTBEAT_RUNNER="$(resolve_bundle heartbeat-runner-)"
REPLY_FILE="$(resolve_bundle reply-)"

python3 - "$HEARTBEAT_RUNNER" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old_detector = 'return lower.includes("exec finished");'
new_detector = 'return lower.includes("exec finished") || lower.includes("exec completed");'
if new_detector in text:
    print(f"detector already patched: {p}")
elif old_detector in text:
    text = text.replace(old_detector, new_detector, 1)
    print(f"patched detector: {p}")
else:
    raise SystemExit(f"detector block not found in {p}")
old_relay = '\tconst canRelayToUser = Boolean(visibility.showAlerts && delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct"));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
new_relay = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct") || delivery.channel === "none" && isDirectWebchatSession));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
if new_relay in text:
    print(f"relay already patched: {p}")
elif old_relay in text:
    text = text.replace(old_relay, new_relay, 1)
    print(f"patched relay routing: {p}")
else:
    raise SystemExit(f"relay block not found in {p}")
p.write_text(text)
PY

python3 - "$REPLY_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old = 'if (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return incomingToRaw;'
new = 'if (normalizedIncomingTo === "heartbeat" && params.persistedLastTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.persistedLastTo;\n\tif (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return incomingToRaw;'
if 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' in text:
    print(f"already patched: {p}")
elif old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched: {p}")
else:
    raise SystemExit(f"target block not found in {p}")
PY

grep -n "exec finished\|exec completed\|isDirectWebchatSession\|canRelayToUser" "$HEARTBEAT_RUNNER"
grep -n 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' "$REPLY_FILE"

echo "Hotfix complete. Restart OpenClaw gateway for changes to take effect."
