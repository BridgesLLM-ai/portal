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
current_old_detector = 'return normalizeLowercaseStringOrEmpty(evt).includes("exec finished");'
current_new_detector = 'return normalizeLowercaseStringOrEmpty(evt).includes("exec finished") || normalizeLowercaseStringOrEmpty(evt).includes("exec completed");'
if new_detector in text or current_new_detector in text:
    print(f"detector already patched: {p}")
elif old_detector in text:
    text = text.replace(old_detector, new_detector, 1)
    print(f"patched detector: {p}")
elif current_old_detector in text:
    text = text.replace(current_old_detector, current_new_detector, 1)
    print(f"patched detector (current bundle): {p}")
else:
    raise SystemExit(f"detector block not found in {p}")
old_relay = '\tconst canRelayToUser = Boolean(visibility.showAlerts && delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct"));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
new_relay = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct") || delivery.channel === "none" && isDirectWebchatSession));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
current_relay = '\tconst responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {\n\t\tchannel: delivery.channel !== "none" ? delivery.channel : void 0,\n\t\taccountId: delivery.accountId\n\t}).responsePrefix;\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser: Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts),\n\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, agentId),\n\t\tstartedAt,\n\t\theartbeatFileContent: preflight.heartbeatFileContent\n\t});'
current_relay_new = '\tconst responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {\n\t\tchannel: delivery.channel !== "none" ? delivery.channel : void 0,\n\t\taccountId: delivery.accountId\n\t}).responsePrefix;\n\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser: Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession)),\n\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, agentId),\n\t\tstartedAt,\n\t\theartbeatFileContent: preflight.heartbeatFileContent\n\t});'
if new_relay in text or current_relay_new in text:
    print(f"relay already patched: {p}")
elif old_relay in text:
    text = text.replace(old_relay, new_relay, 1)
    print(f"patched relay routing: {p}")
elif current_relay in text:
    text = text.replace(current_relay, current_relay_new, 1)
    print(f"patched relay routing (current bundle): {p}")
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
current_old = 'const hasEstablishedExternalRouteForTo = isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);\n\tif (params.isInterSession && hasEstablishedExternalRouteForTo && params.persistedLastTo) return params.persistedLastTo;\n\tif (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.originatingToRaw || params.toRaw;'
current_new = 'const hasEstablishedExternalRouteForTo = isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);\n\tconst normalizedIncomingTo = String(params.toRaw || "").trim().toLowerCase();\n\tif (params.isInterSession && hasEstablishedExternalRouteForTo && params.persistedLastTo) return params.persistedLastTo;\n\tif (normalizedIncomingTo === "heartbeat" && params.persistedLastTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.persistedLastTo;\n\tif (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.originatingToRaw || params.toRaw;'
if 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' in text:
    print(f"already patched: {p}")
elif old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched: {p}")
elif current_old in text:
    p.write_text(text.replace(current_old, current_new, 1))
    print(f"patched current reply bundle: {p}")
else:
    raise SystemExit(f"target block not found in {p}")
PY

grep -n "exec finished\|exec completed\|isDirectWebchatSession\|canRelayToUser" "$HEARTBEAT_RUNNER"
grep -n 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' "$REPLY_FILE"

echo "Hotfix complete. Restart OpenClaw gateway for changes to take effect."
