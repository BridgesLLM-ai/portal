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

HEARTBEAT_RUNNER="$(resolve_optional_bundle heartbeat-runner-)"
GET_REPLY_FILE="$(resolve_optional_bundle get-reply- reply-)"
EXECUTE_RUNTIME="$(resolve_optional_bundle execute.runtime-)"
CLI_BACKEND="$ROOT/extensions/google/cli-backend.js"

if [[ -n "$HEARTBEAT_RUNNER" ]]; then
python3 - "$HEARTBEAT_RUNNER" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old_detector = 'return lower.includes("exec finished");'
new_detector = 'return lower.includes("exec finished") || lower.includes("exec completed");'
current_old_detector = 'return normalizeLowercaseStringOrEmpty(evt).includes("exec finished");'
current_new_detector = 'return normalizeLowercaseStringOrEmpty(evt).includes("exec finished") || normalizeLowercaseStringOrEmpty(evt).includes("exec completed");'
regex_detector = 'return /^exec finished(?::|\\s*\\()/.test(normalized) || /^exec (completed|failed) \\([a-z0-9_-]{1,64}, (code -?\\d+|signal [^)]+)\\)( :: .*)?$/.test(normalized);'
if new_detector in text or current_new_detector in text or regex_detector in text:
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

if [[ -f "$CLI_BACKEND" ]]; then
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
  echo "skipping Gemini CLI backend patch: $CLI_BACKEND not found"
fi

if [[ -n "$EXECUTE_RUNTIME" ]]; then
python3 - "$EXECUTE_RUNTIME" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()

helper_old = 'function isClaudeCliProvider(providerId) {\n\treturn normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";\n}\nfunction usesClaudeStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);\n}\n'
helper_new = 'function isClaudeCliProvider(providerId) {\n\treturn normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";\n}\nfunction isGeminiCliProvider(providerId) {\n\tconst normalized = normalizeLowercaseStringOrEmpty(providerId);\n\treturn normalized === "google-gemini-cli" || normalized === "gemini-cli";\n}\nfunction usesClaudeStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);\n}\nfunction usesGeminiStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "gemini-stream-json" || isGeminiCliProvider(params.providerId);\n}\n'
parser_block = '''function parseClaudeCliStreamingDelta(params) {
\tif (!usesClaudeStreamJsonDialect(params)) return null;
\tif (params.parsed.type !== "stream_event" || !isRecord(params.parsed.event)) return null;
\tconst event = params.parsed.event;
\tif (event.type !== "content_block_delta" || !isRecord(event.delta)) return null;
\tconst delta = event.delta;
\tif (delta.type !== "text_delta" || typeof delta.text !== "string") return null;
\tif (!delta.text) return null;
\treturn {
\t\ttext: `${params.textSoFar}${delta.text}`,
\t\tdelta: delta.text,
\t\tsessionId: params.sessionId,
\t\tusage: params.usage
\t};
}
function parseGeminiCliStreamingRecord(params) {
\tif (!usesGeminiStreamJsonDialect(params)) return null;
\tif (params.parsed.type === "message" && params.parsed.role === "assistant" && typeof params.parsed.content === "string") {
\t\tconst chunk = params.parsed.content;
\t\tif (!chunk) return null;
\t\tconst text = params.parsed.delta === true ? `${params.textSoFar}${chunk}` : chunk;
\t\tconst delta = params.parsed.delta === true ? chunk : text.startsWith(params.textSoFar) ? text.slice(params.textSoFar.length) : text;
\t\treturn {
\t\t\tkind: "assistant",
\t\t\tevent: {
\t\t\t\ttext,
\t\t\t\tdelta,
\t\t\t\tsessionId: params.sessionId,
\t\t\t\tusage: params.usage
\t\t\t}
\t\t};
\t}
\tif (params.parsed.type === "tool_use" && typeof params.parsed.tool_id === "string") return {
\t\tkind: "tool",
\t\tevent: {
\t\t\tphase: "start",
\t\t\tname: typeof params.parsed.tool_name === "string" ? params.parsed.tool_name : "tool",
\t\t\ttoolCallId: params.parsed.tool_id,
\t\t\tinput: params.parsed.parameters,
\t\t\targs: params.parsed.parameters
\t\t}
\t};
\tif (params.parsed.type === "tool_result" && typeof params.parsed.tool_id === "string") {
\t\tconst output = typeof params.parsed.output === "string" ? params.parsed.output : collectCliText(params.parsed.output);
\t\tconst errorMessage = isRecord(params.parsed.error) ? readNestedErrorMessage(params.parsed.error) : typeof params.parsed.error === "string" ? params.parsed.error : void 0;
\t\treturn {
\t\t\tkind: "tool",
\t\t\tevent: {
\t\t\t\tphase: "result",
\t\t\t\ttoolCallId: params.parsed.tool_id,
\t\t\t\toutput: output || errorMessage,
\t\t\t\tresult: output || errorMessage,
\t\t\t\tisError: params.parsed.status === "error" || Boolean(errorMessage)
\t\t\t}
\t\t};
\t}
\treturn null;
}
function createCliJsonlStreamingParser(params) {
\tlet lineBuffer = "";
\tlet assistantText = "";
\tlet sessionId;
\tlet usage;
\tconst toolNameById = new Map();
\tconst handleParsedRecord = (parsed) => {
\t\tsessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
\t\tif (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
\t\tusage = readCliUsage(parsed) ?? usage;
\t\tconst geminiRecord = parseGeminiCliStreamingRecord({
\t\t\tbackend: params.backend,
\t\t\tproviderId: params.providerId,
\t\t\tparsed,
\t\t\ttextSoFar: assistantText,
\t\t\tsessionId,
\t\t\tusage
\t\t});
\t\tif (geminiRecord) {
\t\t\tif (geminiRecord.kind === "assistant") {
\t\t\t\tassistantText = geminiRecord.event.text;
\t\t\t\tparams.onAssistantDelta(geminiRecord.event);
\t\t\t\treturn;
\t\t\t}
\t\t\tif (geminiRecord.kind === "tool") {
\t\t\t\tconst event = { ...geminiRecord.event };
\t\t\t\tif (event.phase === "start" && typeof event.name === "string") toolNameById.set(event.toolCallId, event.name);
\t\t\t\telse if (!event.name && toolNameById.has(event.toolCallId)) event.name = toolNameById.get(event.toolCallId);
\t\t\t\tif (event.phase === "result") {
\t\t\t\t\tif (!event.name && toolNameById.has(event.toolCallId)) event.name = toolNameById.get(event.toolCallId);
\t\t\t\t\ttoolNameById.delete(event.toolCallId);
\t\t\t\t}
\t\t\t\tparams.onToolEvent?.(event);
\t\t\t\treturn;
\t\t\t}
\t\t}
\t\tconst delta = parseClaudeCliStreamingDelta({
\t\t\tbackend: params.backend,
\t\t\tproviderId: params.providerId,
\t\t\tparsed,
\t\t\ttextSoFar: assistantText,
\t\t\tsessionId,
\t\t\tusage
\t\t});
\t\tif (!delta) return;
\t\tassistantText = delta.text;
\t\tparams.onAssistantDelta(delta);
\t};
\tconst flushLines = (flushPartial) => {
\t\twhile (true) {
\t\t\tconst newlineIndex = lineBuffer.indexOf("\\n");
\t\t\tif (newlineIndex < 0) break;
\t\t\tconst line = lineBuffer.slice(0, newlineIndex).trim();
\t\t\tlineBuffer = lineBuffer.slice(newlineIndex + 1);
\t\t\tif (!line) continue;
\t\t\tfor (const parsed of parseJsonRecordCandidates(line)) handleParsedRecord(parsed);
\t\t}
\t\tif (!flushPartial) return;
\t\tconst tail = lineBuffer.trim();
\t\tlineBuffer = "";
\t\tif (!tail) return;
\t\tfor (const parsed of parseJsonRecordCandidates(tail)) handleParsedRecord(parsed);
\t};
\treturn {
\t\tpush(chunk) {
\t\t\tif (!chunk) return;
\t\t\tlineBuffer += chunk;
\t\t\tflushLines(false);
\t\t},
\t\tfinish() {
\t\t\tflushLines(true);
\t\t}
\t};
}
'''
parse_cli_jsonl_block = '''function parseCliJsonl(raw, backend, providerId) {
\tconst lines = raw.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
\tif (lines.length === 0) return null;
\tlet sessionId;
\tlet usage;
\tlet assistantText = "";
\tlet sawStructuredOutput = false;
\tconst texts = [];
\tfor (const line of lines) for (const parsed of parseJsonRecordCandidates(line)) {
\t\tif (!sessionId) sessionId = pickCliSessionId(parsed, backend);
\t\tif (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
\t\tusage = readCliUsage(parsed) ?? usage;
\t\tconst geminiRecord = parseGeminiCliStreamingRecord({
\t\t\tbackend,
\t\t\tproviderId,
\t\t\tparsed,
\t\t\ttextSoFar: assistantText,
\t\t\tsessionId,
\t\t\tusage
\t\t});
\t\tif (geminiRecord) {
\t\t\tsawStructuredOutput = true;
\t\t\tif (geminiRecord.kind === "assistant") assistantText = geminiRecord.event.text;
\t\t\tcontinue;
\t\t}
\t\tconst claudeResult = parseClaudeCliJsonlResult({
\t\t\tbackend,
\t\t\tproviderId,
\t\t\tparsed,
\t\t\tsessionId,
\t\t\tusage
\t\t});
\t\tif (claudeResult) return claudeResult;
\t\tconst item = isRecord(parsed.item) ? parsed.item : null;
\t\tif (item && typeof item.text === "string") {
\t\t\tconst type = normalizeLowercaseStringOrEmpty(item.type);
\t\t\tif (!type || type.includes("message")) {
\t\t\t\ttexts.push(item.text);
\t\t\t\tsawStructuredOutput = true;
\t\t\t}
\t\t} else if (sessionId || usage) sawStructuredOutput = true;
\t}
\tconst text = assistantText.trim() || texts.join("\\n").trim();
\tif (!text && !sawStructuredOutput) return null;
\treturn {
\t\ttext,
\t\tsessionId,
\t\tusage
\t};
}
'''
streaming_old = 'const streamingParser = backend.output === "jsonl" ? createCliJsonlStreamingParser({\n\t\t\t\t\tbackend,\n\t\t\t\t\tproviderId: context.backendResolved.id,\n\t\t\t\t\tonAssistantDelta: ({ text, delta }) => {\n\t\t\t\t\t\temitAgentEvent({\n\t\t\t\t\t\t\trunId: params.runId,\n\t\t\t\t\t\t\tstream: "assistant",\n\t\t\t\t\t\t\tdata: {\n\t\t\t\t\t\t\t\ttext: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),\n\t\t\t\t\t\t\t\tdelta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output)\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n\t\t\t\t}) : null;'
streaming_new = 'const streamingParser = backend.output === "jsonl" ? createCliJsonlStreamingParser({\n\t\t\t\t\tbackend,\n\t\t\t\t\tproviderId: context.backendResolved.id,\n\t\t\t\t\tonAssistantDelta: ({ text, delta }) => {\n\t\t\t\t\t\temitAgentEvent({\n\t\t\t\t\t\t\trunId: params.runId,\n\t\t\t\t\t\t\tstream: "assistant",\n\t\t\t\t\t\t\tdata: {\n\t\t\t\t\t\t\t\ttext: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),\n\t\t\t\t\t\t\t\tdelta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output)\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t});\n\t\t\t\t\t},\n\t\t\t\t\tonToolEvent: (event) => {\n\t\t\t\t\t\temitAgentEvent({\n\t\t\t\t\t\t\trunId: params.runId,\n\t\t\t\t\t\t\tstream: "tool",\n\t\t\t\t\t\t\tdata: event\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n\t\t\t\t}) : null;'


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

text = replace_exact(text, helper_old, helper_new, 'runtime dialect helpers')
text = replace_between(text, 'function parseClaudeCliStreamingDelta(params) {', 'function parseCliJsonl(raw, backend, providerId) {', parser_block, 'runtime streaming parser block')
text = replace_between(text, 'function parseCliJsonl(raw, backend, providerId) {', 'function parseCliOutput(params) {', parse_cli_jsonl_block, 'runtime parseCliJsonl block')
text = replace_exact(text, streaming_old, streaming_new, 'runtime streaming parser wiring')

p.write_text(text)
print(f"patched gemini execute runtime: {p}")
PY
else
  echo "skipping Gemini runtime patch: execute.runtime bundle not found under $ROOT"
fi

if [[ -n "$HEARTBEAT_RUNNER" ]]; then
  grep -n "exec finished\|exec completed\|isDirectWebchatSession\|canRelayToUser" "$HEARTBEAT_RUNNER"
fi
if [[ -n "$GET_REPLY_FILE" ]]; then
  grep -n 'normalizedIncomingTo === "heartbeat" && params.persistedLastTo' "$GET_REPLY_FILE"
fi
if [[ -f "$CLI_BACKEND" ]]; then
  grep -n 'stream-json\|gemini-stream-json' "$CLI_BACKEND"
fi
if [[ -n "$EXECUTE_RUNTIME" ]]; then
  grep -nF 'function isGeminiCliProvider(providerId)' "$EXECUTE_RUNTIME"
  grep -nF 'function parseGeminiCliStreamingRecord(params)' "$EXECUTE_RUNTIME"
  grep -nF 'onToolEvent: (event) => {' "$EXECUTE_RUNTIME"
fi

echo "Compatibility hotfix complete. Restart OpenClaw gateway for changes to take effect."