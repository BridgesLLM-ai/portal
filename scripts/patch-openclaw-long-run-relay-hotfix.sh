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
HEARTBEAT_DETECTOR_FILE="${HEARTBEAT_EVENTS_FILTER:-$HEARTBEAT_RUNNER}"
GEMINI_PARSER_TARGET="${CLAUDE_LIVE_SESSION:-$EXECUTE_RUNTIME}"

if [[ -n "$HEARTBEAT_DETECTOR_FILE" ]]; then
python3 - "$HEARTBEAT_DETECTOR_FILE" <<'PY'
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
python3 - "$HEARTBEAT_RUNNER" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old_relay = '\tconst canRelayToUser = Boolean(visibility.showAlerts && delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct"));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
new_relay = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && (delivery.to || delivery.channel === "webchat" && entry?.chatType === "direct") || delivery.channel === "none" && isDirectWebchatSession));\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({'
current_relay = '\tconst responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {\n\t\tchannel: delivery.channel !== "none" ? delivery.channel : void 0,\n\t\taccountId: delivery.accountId\n\t}).responsePrefix;\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser: Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts),\n\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, agentId),\n\t\tstartedAt,\n\t\theartbeatFileContent: preflight.heartbeatFileContent\n\t});'
current_relay_new = '\tconst responsePrefix = resolveEffectiveMessagesConfig(cfg, agentId, {\n\t\tchannel: delivery.channel !== "none" ? delivery.channel : void 0,\n\t\taccountId: delivery.accountId\n\t}).responsePrefix;\n\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser: Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession)),\n\t\tworkspaceDir: resolveAgentWorkspaceDir(cfg, agentId),\n\t\tstartedAt,\n\t\theartbeatFileContent: preflight.heartbeatFileContent\n\t});'
current_relay_v202655 = '\tconst canRelayToUser = Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts);\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
current_relay_v202655_new = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession));\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
current_relay_v202668 = '\tconst canRelayToUser = Boolean(delivery.channel !== "none" && delivery.to && visibility.showAlerts);\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry,\n\t\tchatType: delivery.chatType\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
current_relay_v202668_new = '\tconst entryDeliveryChannel = entry?.deliveryContext?.channel ?? entry?.lastChannel ?? entry?.origin?.surface ?? entry?.origin?.provider;\n\tconst isDirectWebchatSession = entry?.chatType === "direct" && entryDeliveryChannel === "webchat";\n\tconst canRelayToUser = Boolean(visibility.showAlerts && (delivery.channel !== "none" && delivery.to || delivery.channel === "none" && isDirectWebchatSession));\n\tconst workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);\n\tconst useHeartbeatResponseToolPrompt = shouldUseHeartbeatResponseToolPrompt({\n\t\tcfg,\n\t\tagentId,\n\t\theartbeat,\n\t\tentry,\n\t\tchatType: delivery.chatType\n\t});\n\tconst { prompt, hasExecCompletion, hasRelayableExecCompletion, hasCronEvents, hasDueCommitments, usesHeartbeatResponseTool } = resolveHeartbeatRunPrompt({\n\t\tcfg,\n\t\theartbeat,\n\t\tpreflight,\n\t\tcanRelayToUser,\n\t\tworkspaceDir,\n\t\tstartedAt,\n\t\tdueTasks: dueHeartbeatTasks,'
if new_relay in text or current_relay_new in text or current_relay_v202655_new in text or current_relay_v202668_new in text:
    print(f"relay already patched: {p}")
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
python3 - "$GET_REPLY_FILE" <<'PY'
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
python3 - "$CLI_BACKEND" <<'PY'
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

for old, new, label in replacements:
    if new in text:
        continue
    if old not in text:
        raise SystemExit(f"Missing expected snippet for {label} in {p}")
    text = text.replace(old, new, 1)

p.write_text(text)
print(f"patched gemini cli backend: {p}")
PY
else
  echo "skipping Gemini CLI backend patch: backend bundle not found under $ROOT"
fi

if [[ -n "$CLAUDE_CLI_SHARED" && -f "$CLAUDE_CLI_SHARED" ]]; then
python3 - "$CLAUDE_CLI_SHARED" <<'PY'
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
python3 - "$GEMINI_PARSER_TARGET" <<'PY'
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
text = p.read_text()
record_fn = 'isRecord$1' if 'isRecord$1(' in text else 'isRecord'

old_claude_live_root = 'permissionMode: security === "full" && ask === "off" ? "bypassPermissions" : "default"'
new_claude_live_root = 'permissionMode: security === "full" && ask === "off" && !(typeof process.getuid === "function" && process.getuid() === 0) ? "bypassPermissions" : "default"'
if new_claude_live_root not in text and old_claude_live_root in text:
    text = text.replace(old_claude_live_root, new_claude_live_root, 1)

def replace_exact(haystack: str, old: str, new: str, label: str) -> str:
    if new in haystack:
        return haystack
    if old not in haystack:
        raise SystemExit(f"Missing expected snippet for {label} in {p}")
    return haystack.replace(old, new, 1)

def replace_between(haystack: str, start: str, end: str, replacement: str, label: str) -> str:
    if replacement in haystack:
        return haystack
    start_idx = haystack.find(start)
    if start_idx < 0:
        raise SystemExit(f"Missing start marker for {label} in {p}")
    end_idx = haystack.find(end, start_idx)
    if end_idx < 0:
        raise SystemExit(f"Missing end marker for {label} in {p}")
    return haystack[:start_idx] + replacement + haystack[end_idx:]

def replace_after(haystack: str, section_start: str, old: str, new: str, label: str) -> str:
    if new in haystack:
        return haystack
    start_idx = haystack.find(section_start)
    if start_idx < 0:
        raise SystemExit(f"Missing section marker for {label} in {p}")
    old_idx = haystack.find(old, start_idx)
    if old_idx < 0:
        raise SystemExit(f"Missing expected snippet for {label} in {p}")
    return haystack[:old_idx] + new + haystack[old_idx + len(old):]

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

gemini_parser_helpers = f'''function parseGeminiCliStreamingDelta(params) {{
\tif (!usesGeminiStreamJsonDialect(params)) return null;
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
function dispatchGeminiCliStreamingToolEvent(params) {{
\tif (!usesGeminiStreamJsonDialect(params)) return;
\tconst tracker = params.tracker;
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
if 'function parseGeminiCliStreamingDelta(params)' not in text:
    text = text.replace('function createToolUseTracker() {', gemini_parser_helpers + 'function createToolUseTracker() {', 1)

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
python3 - "$EXECUTE_RUNTIME" <<'PY'
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
print(f"patched runtime streaming wiring: {p}")
PY
else
  echo "skipping Gemini runtime wiring patch: execute.runtime bundle not found under $ROOT"
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
  grep -n 'stream-json\|gemini-stream-json' "$CLI_BACKEND"
fi
if [[ -n "$GEMINI_PARSER_TARGET" ]]; then
  grep -nF 'function isGeminiCliProvider(providerId)' "$GEMINI_PARSER_TARGET"
  grep -nF 'function parseGeminiCliStreamingDelta(params)' "$GEMINI_PARSER_TARGET"
  grep -nF 'function dispatchGeminiCliStreamingToolEvent(params)' "$GEMINI_PARSER_TARGET"
fi
if [[ -n "$EXECUTE_RUNTIME" ]]; then
  grep -nF 'onToolUseStart: emitCliToolUseStart' "$EXECUTE_RUNTIME" || grep -nF 'onToolEvent: (event) => {' "$EXECUTE_RUNTIME"
fi

echo "Compatibility hotfix complete. Restart OpenClaw gateway for changes to take effect."
