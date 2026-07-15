#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/usr/lib/node_modules/openclaw/dist}"

resolve_bundle() {
  python3 - "$ROOT" "$@" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
prefixes = sys.argv[2:]
matches = []
for prefix in prefixes:
    matches.extend(root.glob(f"{prefix}*.js"))
if not matches:
    raise SystemExit(1)
matches = sorted(set(matches), key=lambda p: (p.stat().st_size, p.name), reverse=True)
print(matches[0])
PY
}

resolve_optional_bundle() {
  resolve_bundle "$@" 2>/dev/null || true
}

HEARTBEAT_EVENTS_FILTER="$(resolve_optional_bundle heartbeat-events-filter-)"
HEARTBEAT_RUNNER="$(resolve_optional_bundle heartbeat-runner-)"
GET_REPLY_FILE="$(resolve_optional_bundle get-reply- reply-)"
CLAUDE_LIVE_SESSION="$(resolve_optional_bundle claude-live-session-)"
EXECUTE_RUNTIME="$(resolve_optional_bundle execute.runtime-)"
AGENT_RUNNER_RUNTIME="$(resolve_optional_bundle agent-runner.runtime-)"
COMPACT_TOOLS_BUNDLE="$(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for candidate in sorted(root.glob('compact-*.js'), key=lambda p: (p.stat().st_size, p.name), reverse=True):
    try:
        text = candidate.read_text()
    except Exception:
        continue
    if 'createOpenClawCodingTools({' in text:
        print(candidate)
        break
PY
)"
CLI_BACKEND_BUNDLE="$(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for candidate in sorted(root.glob('cli-backend-*.js'), key=lambda p: (p.stat().st_size, p.name), reverse=True):
    try:
        text = candidate.read_text()
    except Exception:
        continue
    if 'id: "google-gemini-cli"' in text or 'const GEMINI_CLI_DEFAULT_MODEL_REF' in text:
        print(candidate)
        break
PY
)"
CLI_BACKEND_WRAPPER="$ROOT/extensions/google/cli-backend.js"
if [[ -n "$CLI_BACKEND_BUNDLE" ]]; then
  CLI_BACKEND="$CLI_BACKEND_BUNDLE"
elif [[ -f "$CLI_BACKEND_WRAPPER" ]]; then
  CLI_BACKEND="$CLI_BACKEND_WRAPPER"
else
  CLI_BACKEND=""
fi
CLAUDE_CLI_SHARED="$(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for candidate in sorted(root.glob('cli-shared-*.js'), key=lambda p: (p.stat().st_size, p.name), reverse=True):
    try:
        text = candidate.read_text()
    except Exception:
        continue
    if 'function resolveClaudePermissionMode(context)' in text and 'CLAUDE_BYPASS_PERMISSION_MODE' in text:
        print(candidate)
        break
PY
)"
FAILED_PATCHES=()

HEARTBEAT_DETECTOR_FILE="${HEARTBEAT_EVENTS_FILTER:-$HEARTBEAT_RUNNER}"
GEMINI_PARSER_TARGET="${CLAUDE_LIVE_SESSION:-$EXECUTE_RUNTIME}"

if [[ -n "$COMPACT_TOOLS_BUNDLE" && -f "$COMPACT_TOOLS_BUNDLE" ]]; then
python3 - "$COMPACT_TOOLS_BUNDLE" <<'PY' || FAILED_PATCHES+=("compaction-flush-metadata")
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
text = p.read_text()

if 'memoryFlushWritePath: params.memoryFlushWritePath' in text:
    print(f"memory flush compaction tool metadata already patched: {p}")
    raise SystemExit(0)

old = 'const toolsRaw = createOpenClawCodingTools({\n\t\t\texec: {'
new = 'const toolsRaw = createOpenClawCodingTools({\n\t\t\ttrigger: params.trigger,\n\t\t\tmemoryFlushWritePath: params.memoryFlushWritePath,\n\t\t\texec: {'
if old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched memory flush compaction tool metadata: {p}")
    raise SystemExit(0)

# OpenClaw 2026.7.1 gates the same call site behind toolsEnabled but still
# omits trigger/memoryFlushWritePath forwarding.
old_2026_7 = 'const toolsRaw = toolsEnabled ? createOpenClawCodingTools({\n\t\t\texec: {'
new_2026_7 = 'const toolsRaw = toolsEnabled ? createOpenClawCodingTools({\n\t\t\ttrigger: params.trigger,\n\t\t\tmemoryFlushWritePath: params.memoryFlushWritePath,\n\t\t\texec: {'
if old_2026_7 in text:
    p.write_text(text.replace(old_2026_7, new_2026_7, 1))
    print(f"patched memory flush compaction tool metadata (2026.7.1 bundle): {p}")
    raise SystemExit(0)

pattern = re.compile(r'(const toolsRaw = createOpenClawCodingTools\(\{\n)(?P<indent>\s*)exec: \{')
match = pattern.search(text)
if not match:
    raise SystemExit(f"memory flush compaction tool block not found in {p}")

indent = match.group('indent')
replacement = f"{match.group(1)}{indent}trigger: params.trigger,\n{indent}memoryFlushWritePath: params.memoryFlushWritePath,\n{indent}exec: {{"
text = text[:match.start()] + replacement + text[match.end():]
p.write_text(text)
print(f"patched memory flush compaction tool metadata: {p}")
PY
else
  echo "skipping memory flush compaction tool metadata patch: compact tools bundle not found under $ROOT"
fi

if [[ -n "$AGENT_RUNNER_RUNTIME" && -f "$AGENT_RUNNER_RUNTIME" ]]; then
python3 - "$AGENT_RUNNER_RUNTIME" <<'PY' || FAILED_PATCHES+=("flush-transcript-guard")
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()
marker = 'canAttemptFlush && shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry)'
old = '}) || shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry))) return entry ?? params.sessionEntry;'
new = '}) || canAttemptFlush && shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry))) return entry ?? params.sessionEntry;'
# OpenClaw 2026.7.1 inlined canAttemptFlush (memoryFlushWritable &&
# !params.isHeartbeat && !isCli) and returns a structured skip outcome, but
# the transcript-size OR branch still bypasses that gate.
marker_2026_7 = '!isCli && shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry)'
old_2026_7 = '}) || shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry))) return {'
new_2026_7 = '}) || memoryFlushWritable && !params.isHeartbeat && !isCli && shouldForceFlushByTranscriptSize && entry != null && !hasAlreadyFlushedForCurrentCompaction(entry))) return {'

if marker in text or marker_2026_7 in text:
    print(f"memory flush transcript-size guard already patched: {p}")
elif old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched memory flush transcript-size guard: {p}")
elif old_2026_7 in text:
    p.write_text(text.replace(old_2026_7, new_2026_7, 1))
    print(f"patched memory flush transcript-size guard (2026.7.1 bundle): {p}")
else:
    raise SystemExit(f"memory flush transcript-size guard target not found in {p}")
PY
else
  echo "skipping memory flush transcript-size guard patch: agent runner runtime bundle not found under $ROOT"
fi

if [[ -n "$HEARTBEAT_DETECTOR_FILE" ]]; then
python3 - "$HEARTBEAT_DETECTOR_FILE" <<'PY' || FAILED_PATCHES+=("heartbeat-exec-detector")
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old_detector = 'return lower.includes("exec finished");'
new_detector = 'return lower.includes("exec finished") || lower.includes("exec completed");'
current_old_detector = 'return normalizeLowercaseStringOrEmpty(evt).includes("exec finished");'
current_new_detector = 'return normalizeLowercaseStringOrEmpty(evt).includes("exec finished") || normalizeLowercaseStringOrEmpty(evt).includes("exec completed");'
regex_detector = 'return /^exec finished(?::|\\s*\\()/.test(normalized) || /^exec (completed|failed) \\([a-z0-9_-]{1,64}, (code -?\\d+|signal [^)]+)\\)( :: .*)?$/.test(normalized);'
structured_detector = 'return /^exec finished(?::|\\s*\\()/.test(normalized) || STRUCTURED_EXEC_COMPLETION_EVENT_RE.test(trimmed);'
if new_detector in text or current_new_detector in text or regex_detector in text or structured_detector in text:
    print(f"detector already patched: {p}")
elif old_detector in text:
    text = text.replace(old_detector, new_detector, 1)
    print(f"patched detector: {p}")
elif current_old_detector in text:
    text = text.replace(current_old_detector, current_new_detector, 1)
    print(f"patched detector (current bundle): {p}")
else:
    raise SystemExit(f"detector block not found in {p}")
p.write_text(text)
PY
else
  echo "skipping heartbeat detector patch: detector bundle not found under $ROOT"
fi

if [[ -n "$HEARTBEAT_RUNNER" ]]; then
python3 - "$HEARTBEAT_RUNNER" <<'PY' || FAILED_PATCHES+=("heartbeat-webchat-relay")
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
# OpenClaw 2026.7.1 assigns resolveHeartbeatRunPrompt with let and extra
# params, so patch only the canRelayToUser line itself.
line_old_2026_7 = '\tconst canRelayToUser = Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts);\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tlet useHeartbeatResponseToolPrompt'
line_new_2026_7 = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession));\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tlet useHeartbeatResponseToolPrompt'
old_relay = '\tconst canRelayToUser = Boolean(visibility.showAlerts && delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct"));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
new_relay = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct") || delivery.channel === "none" && isDirectWebchatSession));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
current_relay = '\tconst responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {\n\t\tchannel: delivery.channel !== "none" ? delivery.channel : void 0,\n\t\taccountId: delivery.accountId\n\t}).responsePrefix;\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser: Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts),\n\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, agentId),\n\t\tstartedAt,\n\t\theartbeatFileContent: preflight.heartbeatFileContent\n\t});'
current_relay_new = '\tconst responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {\n\t\tchannel: delivery.channel !== "none" ? delivery.channel : void 0,\n\t\taccountId: delivery.accountId\n\t}).responsePrefix;\n\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser: Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession)),\n\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, agentId),\n\t\tstartedAt,\n\t\theartbeatFileContent: preflight.heartbeatFileContent\n\t});'
current_relay_v202655 = '\tconst canRelayToUser = Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts);\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
current_relay_v202655_new = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession));\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
current_relay_v202668 = '\tconst canRelayToUser = Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts);\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry,\n\t\tchatType: delivery.chatType\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
current_relay_v202668_new = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession));\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry,\n\t\tchatType: delivery.chatType\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
if new_relay in text or current_relay_new in text or current_relay_v202655_new in text or current_relay_v202668_new in text or line_new_2026_7 in text:
    print(f"relay already patched: {p}")
elif line_old_2026_7 in text:
    text = text.replace(line_old_2026_7, line_new_2026_7, 1)
    print(f"patched relay routing (2026.7.1 bundle): {p}")
elif old_relay in text:
    text = text.replace(old_relay, new_relay, 1)
    print(f"patched relay routing: {p}")
elif current_relay in text:
    text = text.replace(current_relay, current_relay_new, 1)
    print(f"patched relay routing (current bundle): {p}")
elif current_relay_v202655 in text:
    text = text.replace(current_relay_v202655, current_relay_v202655_new, 1)
    print(f"patched relay routing (2026.5.5 bundle): {p}")
elif current_relay_v202668 in text:
    text = text.replace(current_relay_v202668, current_relay_v202668_new, 1)
    print(f"patched relay routing (2026.6.8 bundle): {p}")
else:
    print(f"relay routing patch not needed or unsupported for current bundle: {p}")
p.write_text(text)
PY
else
  echo "skipping relay heartbeat patch: heartbeat-runner bundle not found under $ROOT"
fi

if [[ -n "$GET_REPLY_FILE" ]]; then
python3 - "$GET_REPLY_FILE" <<'PY' || FAILED_PATCHES+=("reply-routing")
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old = 'if (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return incomingToRaw;'
new = 'if (normalizedIncomingTo === "heartbeat" && params.persistedLastTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.persistedLastTo;\n\tif (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return incomingToRaw;'
current_old = 'const hasEstablishedExternalRouteForTo = isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);\n\tif (params.isInterSession && hasEstablishedExternalRouteForTo && params.persistedLastTo) return params.persistedLastTo;\n\tif (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.originatingToRaw || params.toRaw;'
current_new = 'const hasEstablishedExternalRouteForTo = isExternalRoutingChannel(persistedChannel) || isExternalRoutingChannel(sessionKeyChannelHint);\n\tconst normalizedIncomingTo = String(params.toRaw || "").trim().toLowerCase();\n\tif (params.isInterSession && hasEstablishedExternalRouteForTo && params.persistedLastTo) return params.persistedLastTo;\n\tif (normalizedIncomingTo === "heartbeat" && params.persistedLastTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.persistedLastTo;\n\tif (originatingChannel === "webchat" && !hasEstablishedExternalRouteForTo && (isMainSessionKey(params.sessionKey) || isDirectSessionKey(params.sessionKey))) return params.originatingToRaw || params.toRaw;'
if 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' in text:
    print(f"reply routing already patched: {p}")
elif old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched reply routing: {p}")
elif current_old in text:
    p.write_text(text.replace(current_old, current_new, 1))
    print(f"patched current reply bundle: {p}")
else:
    raise SystemExit(f"target block not found in {p}")
PY
else
  echo "skipping reply routing patch: get-reply bundle not found under $ROOT"
fi

if [[ -n "$CLI_BACKEND" && -f "$CLI_BACKEND" ]]; then
python3 - "$CLI_BACKEND" <<'PY' || FAILED_PATCHES+=("gemini-cli-backend")
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()

if 'jsonlDialect: "gemini-stream-json"' in text and '"--output-format",\n\t\t\t\t"stream-json",' in text and '"--yolo",' in text:
    print(f"gemini cli backend already patched: {p}")
    raise SystemExit(0)

replacements = [
    (
        '"--output-format",\n\t\t\t\t"json",\n\t\t\t\t"--prompt"',
        '"--output-format",\n\t\t\t\t"stream-json",\n\t\t\t\t"--yolo",\n\t\t\t\t"--prompt"',
        'cli-backend args output format',
    ),
    (
        '"--resume",\n\t\t\t\t"{sessionId}",\n\t\t\t\t"--output-format",\n\t\t\t\t"json",\n\t\t\t\t"--prompt"',
        '"--resume",\n\t\t\t\t"{sessionId}",\n\t\t\t\t"--output-format",\n\t\t\t\t"stream-json",\n\t\t\t\t"--yolo",\n\t\t\t\t"--prompt"',
        'cli-backend resume output format',
    ),
    (
        'output: "json",',
        'output: "jsonl",\n\t\t\tjsonlDialect: "gemini-stream-json",',
        'cli-backend output mode',
    ),
]

changed = False
missing = []
for old, new, label in replacements:
    if new in text:
        continue
    if old not in text:
        missing.append(label)
        continue
    text = text.replace(old, new, 1)
    changed = True

if changed:
    p.write_text(text)
    if missing:
        print(f"patched gemini cli backend partially; skipped unsupported snippets {missing}: {p}")
    else:
        print(f"patched gemini cli backend: {p}")
else:
    if missing:
        print(f"gemini cli backend patch not needed or unsupported for current bundle; missing snippets {missing}: {p}")
    else:
        print(f"gemini cli backend already patched: {p}")
PY
else
  echo "skipping Gemini CLI backend patch: backend bundle not found under $ROOT"
fi

if [[ -n "$CLAUDE_CLI_SHARED" && -f "$CLAUDE_CLI_SHARED" ]]; then
python3 - "$CLAUDE_CLI_SHARED" <<'PY' || FAILED_PATCHES+=("claude-root-permission")
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()
marker = 'process.getuid() === 0'
old = '''function resolveClaudePermissionMode(context) {
\treturn isOpenClawRequestedYolo(context) ? {
\t\tmode: CLAUDE_BYPASS_PERMISSION_MODE,
\t\toverrideExisting: false
\t} : { overrideExisting: false };
}
'''
new = '''function resolveClaudePermissionMode(context) {
\tif (isOpenClawRequestedYolo(context) && typeof process.getuid === "function" && process.getuid() === 0) return {
\t\tmode: CLAUDE_DEFAULT_PERMISSION_MODE,
\t\toverrideExisting: true
\t};
\treturn isOpenClawRequestedYolo(context) ? {
\t\tmode: CLAUDE_BYPASS_PERMISSION_MODE,
\t\toverrideExisting: false
\t} : { overrideExisting: false };
}
'''
if marker in text:
    print(f"claude root permission mode already patched: {p}")
elif old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched claude root permission mode: {p}")
else:
    raise SystemExit(f"Claude permission resolver target not found in {p}")
PY
else
  echo "skipping Claude root permission patch: cli-shared bundle not found under $ROOT"
fi

if [[ -n "$GEMINI_PARSER_TARGET" ]]; then
python3 - "$GEMINI_PARSER_TARGET" <<'PY' || FAILED_PATCHES+=("gemini-stream-parser")
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
text = p.read_text()
record_fn = 'isRecord$1' if 'isRecord$1(' in text else 'isRecord'
missing_optional = []

old_claude_live_root = 'permissionMode: security === "full" && ask === "off" ? "bypassPermissions" : "default"'
new_claude_live_root = 'permissionMode: security === "full" && ask === "off" && !(typeof process.getuid === "function" && process.getuid() === 0) ? "bypassPermissions" : "default"'
if new_claude_live_root not in text and old_claude_live_root in text:
    text = text.replace(old_claude_live_root, new_claude_live_root, 1)

def replace_exact(haystack: str, old: str, new: str, label: str) -> str:
    if new in haystack:
        return haystack
    if old not in haystack:
        missing_optional.append(label)
        return haystack
    return haystack.replace(old, new, 1)

def replace_between(haystack: str, start: str, end: str, replacement: str, label: str) -> str:
    if replacement in haystack:
        return haystack
    start_idx = haystack.find(start)
    if start_idx < 0:
        missing_optional.append(label)
        return haystack
    end_idx = haystack.find(end, start_idx)
    if end_idx < 0:
        missing_optional.append(label)
        return haystack
    return haystack[:start_idx] + replacement + haystack[end_idx:]

def replace_after(haystack: str, section_start: str, old: str, new: str, label: str) -> str:
    if new in haystack:
        return haystack
    start_idx = haystack.find(section_start)
    if start_idx < 0:
        missing_optional.append(label)
        return haystack
    old_idx = haystack.find(old, start_idx)
    if old_idx < 0:
        missing_optional.append(label)
        return haystack
    return haystack[:old_idx] + new + haystack[old_idx + len(old):]

def function_spans(haystack: str, function_name: str) -> list[tuple[int, int, str]]:
    spans = []
    needle = f'function {function_name}('
    search_from = 0
    while True:
        start = haystack.find(needle, search_from)
        if start < 0:
            break
        brace_start = haystack.find('{', start)
        if brace_start < 0:
            break
        depth = 0
        end = None
        for idx in range(brace_start, len(haystack)):
            ch = haystack[idx]
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = idx + 1
                    if end < len(haystack) and haystack[end] == '\n':
                        end += 1
                    break
        if end is None:
            break
        spans.append((start, end, haystack[start:end]))
        search_from = end
    return spans

def remove_duplicate_function_definitions(haystack: str, function_name: str) -> str:
    spans = function_spans(haystack, function_name)
    if len(spans) <= 1:
        return haystack
    preferred = next(
        (span for span in spans if 'isGeminiStreamJsonDialect(params)' in span[2]),
        spans[0],
    )
    remove_ranges = [(start, end) for start, end, _ in spans if (start, end) != (preferred[0], preferred[1])]
    for start, end in sorted(remove_ranges, reverse=True):
        haystack = haystack[:start] + haystack[end:]
    print(f"removed duplicate {function_name} definitions: kept 1, removed {len(remove_ranges)}")
    return haystack

text = remove_duplicate_function_definitions(text, 'parseGeminiCliStreamingDelta')
text = remove_duplicate_function_definitions(text, 'dispatchGeminiCliStreamingToolEvent')

gemini_dialect_helpers = '''function isGeminiCliProvider(providerId) {
\tconst normalized = normalizeLowercaseStringOrEmpty(providerId);
\treturn normalized === "google-gemini-cli" || normalized === "gemini-cli";
}
function usesGeminiStreamJsonDialect(params) {
\treturn params.backend.jsonlDialect === "gemini-stream-json" || isGeminiCliProvider(params.providerId);
}
'''
if 'function isGeminiCliProvider(providerId)' not in text:
    text, count = re.subn(
        r'(function supportsCliJsonlToolEvents\(params\) \{[\s\S]*?\n\})(\nfunction isClaudeStreamJsonResult\(params\) \{)',
        r'\1\n' + gemini_dialect_helpers + r'\2',
        text,
        count=1,
    )
    if count == 0:
        text = replace_exact(
            text,
            'function usesClaudeStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);\n}\n',
            'function usesClaudeStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);\n}\n' + gemini_dialect_helpers,
            'runtime Gemini dialect helpers',
        )

gemini_dialect_check = '(typeof isGeminiStreamJsonDialect === "function" ? isGeminiStreamJsonDialect(params) : usesGeminiStreamJsonDialect(params))'
gemini_delta_helper = f'''function parseGeminiCliStreamingDelta(params) {{
\tif (!{gemini_dialect_check}) return null;
\tif (params.parsed.type !== "message" || params.parsed.role !== "assistant" || typeof params.parsed.content !== "string") return null;
\tconst chunk = params.parsed.content;
\tif (!chunk) return null;
\tconst text = params.parsed.delta === true ? `${{params.textSoFar}}${{chunk}}` : chunk;
\tconst delta = params.parsed.delta === true ? chunk : text.startsWith(params.textSoFar) ? text.slice(params.textSoFar.length) : text;
\treturn {{
\t\ttext,
\t\tdelta,
\t\tsessionId: params.sessionId,
\t\tusage: params.usage
\t}};
}}
'''
gemini_dispatch_helper = f'''function dispatchGeminiCliStreamingToolEvent(params) {{
\tif (!{gemini_dialect_check}) return;
'''
gemini_dispatch_helper += f'''\tconst tracker = params.tracker;
\tif (params.parsed.type === "tool_use" && typeof params.parsed.tool_id === "string") {{
\t\tconst toolCallId = params.parsed.tool_id.trim();
\t\tconst name = typeof params.parsed.tool_name === "string" && params.parsed.tool_name.trim() ? params.parsed.tool_name.trim() : "tool";
\t\tconst args = {record_fn}(params.parsed.parameters) ? params.parsed.parameters : {{}};
\t\tif (!toolCallId) return;
\t\ttracker.nameById.set(toolCallId, name);
\t\tif (params.onToolUseStart) emitToolStartOnce(tracker, toolCallId, name, args, params.onToolUseStart);
\t\telse params.onToolEvent?.({{ phase: "start", name, toolCallId, input: args, args }});
\t\treturn;
\t}}
\tif (params.parsed.type === "tool_result" && typeof params.parsed.tool_id === "string") {{
\t\tconst toolCallId = params.parsed.tool_id.trim();
\t\tif (!toolCallId) return;
\t\tconst name = tracker.nameById.get(toolCallId) ?? "";
\t\tconst output = typeof params.parsed.output === "string" ? params.parsed.output : collectCliText(params.parsed.output) || collectCliText(params.parsed.result);
\t\tconst errorMessage = {record_fn}(params.parsed.error) ? readNestedErrorMessage(params.parsed.error) : typeof params.parsed.error === "string" ? params.parsed.error : void 0;
\t\tconst result = output || errorMessage;
\t\tconst isError = params.parsed.status === "error" || Boolean(errorMessage);
\t\tif (params.onToolResult) emitToolResultOnce(tracker, toolCallId, isError, result, params.onToolResult);
\t\telse params.onToolEvent?.({{ phase: "result", name, toolCallId, output: result, result, isError }});
\t\ttracker.nameById.delete(toolCallId);
\t}}
}}
'''.replace('{record_fn}', record_fn)
gemini_parser_helpers = gemini_delta_helper
if 'function dispatchGeminiCliStreamingToolEvent(params)' not in text:
    gemini_parser_helpers += gemini_dispatch_helper
if 'function parseGeminiCliStreamingDelta(params)' not in text:
    text = text.replace('function createToolUseTracker() {', gemini_parser_helpers + 'function createToolUseTracker() {', 1)
elif 'function dispatchGeminiCliStreamingToolEvent(params)' not in text:
    text = text.replace('function createToolUseTracker() {', gemini_dispatch_helper + 'function createToolUseTracker() {', 1)

# Earlier versions of this hotfix used a raw Python string for the Gemini
# parser helpers, which wrote literal "\t" sequences into the JS bundle.
# Normalize only line-leading escaped tabs so already-patched bundles recover.
text = re.sub(r'(?m)^(?:\\t)+', lambda match: '\t' * (len(match.group(0)) // 2), text)

streaming_claude_result = '''\t\tconst result = parseClaudeCliJsonlResult({
\t\t\tbackend: params.backend,
\t\t\tproviderId: params.providerId,
\t\t\tparsed,
\t\t\tsessionId,
\t\t\tusage
\t\t});
\t\tif (result) {
\t\t\toutput = result;
\t\t\treturn;
\t\t}
'''
streaming_claude_result_with_gemini = streaming_claude_result + '''\t\tconst geminiDelta = parseGeminiCliStreamingDelta({
\t\t\tbackend: params.backend,
\t\t\tproviderId: params.providerId,
\t\t\tparsed,
\t\t\ttextSoFar: assistantText,
\t\t\tsessionId,
\t\t\tusage
\t\t});
\t\tif (geminiDelta) {
\t\t\tassistantText = geminiDelta.text;
\t\t\tparams.onAssistantDelta(geminiDelta);
\t\t\treturn;
\t\t}
'''
text = replace_exact(text, streaming_claude_result, streaming_claude_result_with_gemini, 'runtime Gemini streaming delta insertion')

streaming_tool_dispatch = '''\t\tif (params.onToolUseStart || params.onToolResult) dispatchClaudeCliStreamingToolEvent({
\t\t\tbackend: params.backend,
\t\t\tproviderId: params.providerId,
\t\t\tparsed,
\t\t\ttracker: toolTracker,
\t\t\tonToolUseStart: params.onToolUseStart,
\t\t\tonToolResult: params.onToolResult
\t\t});
'''
streaming_tool_dispatch_with_gemini = '''\t\tif (params.onToolUseStart || params.onToolResult || params.onToolEvent) {
\t\t\tdispatchGeminiCliStreamingToolEvent({
\t\t\t\tbackend: params.backend,
\t\t\t\tproviderId: params.providerId,
\t\t\t\tparsed,
\t\t\t\ttracker: toolTracker,
\t\t\t\tonToolUseStart: params.onToolUseStart,
\t\t\t\tonToolResult: params.onToolResult,
\t\t\t\tonToolEvent: params.onToolEvent
\t\t\t});
\t\t\tdispatchClaudeCliStreamingToolEvent({
\t\t\t\tbackend: params.backend,
\t\t\t\tproviderId: params.providerId,
\t\t\t\tparsed,
\t\t\t\ttracker: toolTracker,
\t\t\t\tonToolUseStart: params.onToolUseStart,
\t\t\t\tonToolResult: params.onToolResult
\t\t\t});
\t\t}
'''
text = replace_exact(text, streaming_tool_dispatch, streaming_tool_dispatch_with_gemini, 'runtime Gemini tool event insertion')

parse_cli_jsonl_block = f'''function parseCliJsonl(raw, backend, providerId) {{
\tconst lines = normalizeStringEntries(raw.split(/\\r?\\n/g));
\tif (lines.length === 0) return null;
\tlet sessionId;
\tlet usage;
\tlet assistantText = "";
\tlet sawStructuredOutput = false;
\tconst texts = [];
\tfor (const line of lines) for (const parsed of parseJsonRecordCandidates(line)) {{
\t\tsessionId = pickCliSessionId(parsed, backend) ?? sessionId;
\t\tif (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
\t\tconst nextUsage = readCliUsage(parsed);
\t\tif (!isClaudeStreamJsonResult({{
\t\t\tbackend,
\t\t\tproviderId,
\t\t\tparsed
\t\t}}) || !usage) usage = nextUsage ?? usage;
\t\tconst claudeResult = parseClaudeCliJsonlResult({{
\t\t\tbackend,
\t\t\tproviderId,
\t\t\tparsed,
\t\t\tsessionId,
\t\t\tusage
\t\t}});
\t\tif (claudeResult) return claudeResult;
\t\tconst geminiDelta = parseGeminiCliStreamingDelta({{
\t\t\tbackend,
\t\t\tproviderId,
\t\t\tparsed,
\t\t\ttextSoFar: assistantText,
\t\t\tsessionId,
\t\t\tusage
\t\t}});
\t\tif (geminiDelta) {{
\t\t\tassistantText = geminiDelta.text;
\t\t\tsawStructuredOutput = true;
\t\t\tcontinue;
\t\t}}
\t\tconst item = {record_fn}(parsed.item) ? parsed.item : null;
\t\tif (item && typeof item.text === "string") {{
\t\t\tconst type = normalizeLowercaseStringOrEmpty(item.type);
\t\t\tif (!type || type.includes("message")) {{
\t\t\t\ttexts.push(item.text);
\t\t\t\tsawStructuredOutput = true;
\t\t\t}}
\t\t}} else if (sessionId || usage) sawStructuredOutput = true;
\t}}
\tconst text = assistantText.trim() || texts.join("\\n").trim();
\tif (!text && !sawStructuredOutput) return null;
\treturn {{
\t\ttext,
\t\tsessionId,
\t\tusage
\t}};
}}
'''
text = replace_between(text, 'function parseCliJsonl(raw, backend, providerId) {', 'function parseCliOutput(params) {', parse_cli_jsonl_block, 'runtime parseCliJsonl block')

p.write_text(text)
print(f"patched gemini parser target: {p}")
PY
else
  echo "skipping Gemini parser patch: claude-live-session / execute.runtime bundle not found under $ROOT"
fi

if [[ -n "$EXECUTE_RUNTIME" ]]; then
python3 - "$EXECUTE_RUNTIME" <<'PY' || FAILED_PATCHES+=("runtime-streaming-wiring")
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
text = p.read_text()

if 'onToolUseStart: emitCliToolUseStart' in text and 'onToolResult: emitCliToolResult' in text:
    print(f"runtime streaming wiring already native: {p}")
    raise SystemExit(0)

if 'onToolEvent: (event) => {' in text:
    print(f"runtime streaming wiring already patched: {p}")
    raise SystemExit(0)

pattern = re.compile(r'const streamingParser = (?:hasJsonlOutput|backend\.output === "jsonl") \? createCliJsonlStreamingParser\(\{(?P<body>[\s\S]*?)\n\t\t\t\t\}\) : null;')
match = pattern.search(text)
if not match:
    raise SystemExit(f"Missing streaming parser block in {p}")

body = match.group('body')
if 'onAssistantDelta:' not in body:
    raise SystemExit(f"Missing onAssistantDelta callback in streaming parser block in {p}")

insertion = '\n\t\t\t\t\tonToolEvent: (event) => {\n\t\t\t\t\t\temitAgentEvent({\n\t\t\t\t\t\t\trunId: params.runId,\n\t\t\t\t\t\t\tstream: "tool",\n\t\t\t\t\t\t\tdata: event\n\t\t\t\t\t\t});\n\t\t\t\t\t}'
body = body.rstrip() + ',' + insertion
body_start, body_end = match.span('body')
text = text[:body_start] + body + text[body_end:]

p.write_text(text)
if missing_optional:
    print(f"runtime streaming wiring patch not needed or unsupported for current bundle; missing snippets {missing_optional}: {p}")
else:
    print(f"patched runtime streaming wiring: {p}")
PY
else
  echo "skipping Gemini runtime wiring patch: execute.runtime bundle not found under $ROOT"
fi

# OpenClaw 2026.7.1: `openclaw models list` crashes with "Cannot read
# properties of undefined (reading 'input')" when a configured
# anthropic/claude-sonnet-5 declaration has no catalog cost metadata.
# Guard the cost comparison so declared-but-uncatalogued rows adopt the
# resolved Sonnet 5 cost instead of crashing the whole CLI.
REGISTER_RUNTIME_BUNDLE="$(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for candidate in sorted(root.glob('register.runtime-*.js'), key=lambda p: (p.stat().st_size, p.name), reverse=True):
    try:
        text = candidate.read_text()
    except Exception:
        continue
    if 'function applyAnthropicSonnet5Cost' in text:
        print(candidate)
        break
PY
)"
if [[ -n "$REGISTER_RUNTIME_BUNDLE" && -f "$REGISTER_RUNTIME_BUNDLE" ]]; then
python3 - "$REGISTER_RUNTIME_BUNDLE" <<'PY' || FAILED_PATCHES+=("sonnet5-cost-guard")
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()
marker = 'if (params.model.cost && params.model.cost.input === cost.input'
old = 'if (params.model.cost.input === cost.input && params.model.cost.output === cost.output && params.model.cost.cacheRead === cost.cacheRead && params.model.cost.cacheWrite === cost.cacheWrite) return;'
new = 'if (params.model.cost && params.model.cost.input === cost.input && params.model.cost.output === cost.output && params.model.cost.cacheRead === cost.cacheRead && params.model.cost.cacheWrite === cost.cacheWrite) return;'

if marker in text:
    print(f"sonnet5 cost guard already patched: {p}")
elif old in text:
    p.write_text(text.replace(old, new, 1))
    print(f"patched sonnet5 cost guard: {p}")
else:
    print(f"sonnet5 cost guard target not found (bundle may be fixed upstream): {p}")
PY
else
  echo "skipping sonnet5 cost guard patch: register runtime bundle not found under $ROOT"
fi

# Raise the CLI no-output watchdog floors/caps. Claude models with long
# non-streamed reasoning stretches emit zero CLI output for minutes; the stock
# resume profile hard-caps silence at 180s, so healthy turns die with
# "CLI produced no output for 180s and was terminated." A config-level
# cliBackends override is not viable on 2026.7.1 (a sparse entry displaces the
# plugin's backend definition), so patch the default constants instead. The
# effective window stays capped by the run timeout (~runTimeout-1s).
WATCHDOG_DEFAULTS_BUNDLE="$(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for candidate in sorted(root.glob('cli-watchdog-defaults-*.js'), key=lambda p: (p.stat().st_size, p.name), reverse=True):
    try:
        text = candidate.read_text()
    except Exception:
        continue
    if 'CLI_RESUME_WATCHDOG_DEFAULTS' in text:
        print(candidate)
        break
PY
)"
if [[ -n "$WATCHDOG_DEFAULTS_BUNDLE" && -f "$WATCHDOG_DEFAULTS_BUNDLE" ]]; then
python3 - "$WATCHDOG_DEFAULTS_BUNDLE" <<'PY' || FAILED_PATCHES+=("cli-no-output-watchdog")
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()

fresh_old = "const CLI_FRESH_WATCHDOG_DEFAULTS = {\n\tnoOutputTimeoutRatio: .8,\n\tminMs: 18e4,\n\tmaxMs: 6e5\n};"
fresh_new = "const CLI_FRESH_WATCHDOG_DEFAULTS = {\n\tnoOutputTimeoutRatio: .8,\n\tminMs: 9e5,\n\tmaxMs: 9e5\n};"
resume_old = "const CLI_RESUME_WATCHDOG_DEFAULTS = {\n\tnoOutputTimeoutRatio: .3,\n\tminMs: 6e4,\n\tmaxMs: 18e4\n};"
resume_new = "const CLI_RESUME_WATCHDOG_DEFAULTS = {\n\tnoOutputTimeoutRatio: .3,\n\tminMs: 9e5,\n\tmaxMs: 9e5\n};"

if fresh_new in text and resume_new in text:
    print(f"cli no-output watchdog already patched: {p}")
elif fresh_old in text and resume_old in text:
    p.write_text(text.replace(fresh_old, fresh_new, 1).replace(resume_old, resume_new, 1))
    print(f"patched cli no-output watchdog defaults: {p}")
else:
    print(f"cli no-output watchdog target not found (bundle may differ upstream): {p}")
PY
else
  echo "skipping cli no-output watchdog patch: defaults bundle not found under $ROOT"
fi

if [[ -n "$HEARTBEAT_DETECTOR_FILE" ]]; then
  grep -n "exec finished\|exec completed" "$HEARTBEAT_DETECTOR_FILE"
fi
if [[ -n "$HEARTBEAT_RUNNER" ]]; then
  grep -n "isDirectWebchatSession\|canRelayToUser" "$HEARTBEAT_RUNNER"
fi
if [[ -n "$GET_REPLY_FILE" ]]; then
  grep -n 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' "$GET_REPLY_FILE"
fi
if [[ -n "$CLI_BACKEND" && -f "$CLI_BACKEND" ]]; then
  grep -n 'stream-json\|gemini-stream-json' "$CLI_BACKEND" || true
fi
if [[ -n "$COMPACT_TOOLS_BUNDLE" && -f "$COMPACT_TOOLS_BUNDLE" ]]; then
  grep -nF 'memoryFlushWritePath: params.memoryFlushWritePath' "$COMPACT_TOOLS_BUNDLE" || true
fi
if [[ -n "$AGENT_RUNNER_RUNTIME" && -f "$AGENT_RUNNER_RUNTIME" ]]; then
  grep -nF 'canAttemptFlush && shouldForceFlushByTranscriptSize' "$AGENT_RUNNER_RUNTIME" || true
fi
if [[ -n "$GEMINI_PARSER_TARGET" ]]; then
  grep -nF 'function isGeminiCliProvider(providerId)' "$GEMINI_PARSER_TARGET" || true
  grep -nF 'function parseGeminiCliStreamingDelta(params)' "$GEMINI_PARSER_TARGET" || true
  grep -nF 'function dispatchGeminiCliStreamingToolEvent(params)' "$GEMINI_PARSER_TARGET" || true
fi
if [[ -n "$EXECUTE_RUNTIME" ]]; then
  grep -nF 'onToolUseStart: emitCliToolUseStart' "$EXECUTE_RUNTIME" || grep -nF 'onToolEvent: (event) => {' "$EXECUTE_RUNTIME" || true
fi

validate_js_bundle() {
  local file="$1"
  [[ -n "$file" && -f "$file" ]] || return 0
  node --input-type=module --check < "$file" >/dev/null
}

validate_no_duplicate_function() {
  local file="$1"
  local fn="$2"
  [[ -n "$file" && -f "$file" ]] || return 0
  local count
  count="$(grep -cF "function ${fn}(" "$file" || true)"
  if [[ "$count" -gt 1 ]]; then
    echo "duplicate ${fn} definitions remain in ${file}: ${count}" >&2
    return 1
  fi
}

for bundle in "$HEARTBEAT_EVENTS_FILTER" "$HEARTBEAT_RUNNER" "$GET_REPLY_FILE" "$COMPACT_TOOLS_BUNDLE" "$AGENT_RUNNER_RUNTIME" "$CLI_BACKEND" "$CLAUDE_CLI_SHARED" "$GEMINI_PARSER_TARGET" "$EXECUTE_RUNTIME"; do
  validate_js_bundle "$bundle"
done
validate_no_duplicate_function "$GEMINI_PARSER_TARGET" "parseGeminiCliStreamingDelta"
validate_no_duplicate_function "$GEMINI_PARSER_TARGET" "dispatchGeminiCliStreamingToolEvent"

if (( ${#FAILED_PATCHES[@]} > 0 )); then
  echo "Compatibility hotfix finished with failed patches: ${FAILED_PATCHES[*]}" >&2
  echo "All other patches were still attempted; review the log above for details." >&2
  exit 1
fi

echo "Compatibility hotfix complete. Restart OpenClaw gateway for changes to take effect."
