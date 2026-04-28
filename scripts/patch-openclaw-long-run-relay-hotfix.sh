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
CLI_BACKEND="$ROOT/extensions/google/cli-backend.js"
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

if [[ -n "$GEMINI_PARSER_TARGET" ]]; then
python3 - "$GEMINI_PARSER_TARGET" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()
record_fn = 'isRecord$1' if 'isRecord$1(' in text else 'isRecord'

helper_old = 'function isClaudeCliProvider(providerId) {\n\treturn normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";\n}\nfunction usesClaudeStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);\n}\n'
helper_new = 'function isClaudeCliProvider(providerId) {\n\treturn normalizeLowercaseStringOrEmpty(providerId) === "claude-cli";\n}\nfunction isGeminiCliProvider(providerId) {\n\tconst normalized = normalizeLowercaseStringOrEmpty(providerId);\n\treturn normalized === "google-gemini-cli" || normalized === "gemini-cli";\n}\nfunction usesClaudeStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "claude-stream-json" || isClaudeCliProvider(params.providerId);\n}\nfunction usesGeminiStreamJsonDialect(params) {\n\treturn params.backend.jsonlDialect === "gemini-stream-json" || isGeminiCliProvider(params.providerId);\n}\n'
parser_block = f'''function parseClaudeCliStreamingDelta(params) {{
	if (!usesClaudeStreamJsonDialect(params)) return null;
	if (params.parsed.type !== "stream_event" || !{record_fn}(params.parsed.event)) return null;
	const event = params.parsed.event;
	if (event.type !== "content_block_delta" || !{record_fn}(event.delta)) return null;
	const delta = event.delta;
	if (delta.type !== "text_delta" || typeof delta.text !== "string") return null;
	if (!delta.text) return null;
	return {{
		text: `${{params.textSoFar}}${{delta.text}}`,
		delta: delta.text,
		sessionId: params.sessionId,
		usage: params.usage
	}};
}}
function parseGeminiCliStreamingRecord(params) {{
	if (!usesGeminiStreamJsonDialect(params)) return null;
	if (params.parsed.type === "message" && params.parsed.role === "assistant" && typeof params.parsed.content === "string") {{
		const chunk = params.parsed.content;
		if (!chunk) return null;
		const text = params.parsed.delta === true ? `${{params.textSoFar}}${{chunk}}` : chunk;
		const delta = params.parsed.delta === true ? chunk : text.startsWith(params.textSoFar) ? text.slice(params.textSoFar.length) : text;
		return {{
			kind: "assistant",
			event: {{
				text,
				delta,
				sessionId: params.sessionId,
				usage: params.usage
			}}
		}};
	}}
	if (params.parsed.type === "tool_use" && typeof params.parsed.tool_id === "string") return {{
		kind: "tool",
		event: {{
			phase: "start",
			name: typeof params.parsed.tool_name === "string" ? params.parsed.tool_name : "tool",
			toolCallId: params.parsed.tool_id,
			input: params.parsed.parameters,
			args: params.parsed.parameters
		}}
	}};
	if (params.parsed.type === "tool_result" && typeof params.parsed.tool_id === "string") {{
		const output = typeof params.parsed.output === "string" ? params.parsed.output : collectCliText(params.parsed.output);
		const errorMessage = {record_fn}(params.parsed.error) ? readNestedErrorMessage(params.parsed.error) : typeof params.parsed.error === "string" ? params.parsed.error : void 0;
		return {{
			kind: "tool",
			event: {{
				phase: "result",
				toolCallId: params.parsed.tool_id,
				output: output || errorMessage,
				result: output || errorMessage,
				isError: params.parsed.status === "error" || Boolean(errorMessage)
			}}
		}};
	}}
	return null;
}}
function createCliJsonlStreamingParser(params) {{
	let lineBuffer = "";
	let assistantText = "";
	let sessionId;
	let usage;
	const toolNameById = new Map();
	const handleParsedRecord = (parsed) => {{
		sessionId = pickCliSessionId(parsed, params.backend) ?? sessionId;
		if (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
		usage = readCliUsage(parsed) ?? usage;
		const geminiRecord = parseGeminiCliStreamingRecord({{
			backend: params.backend,
			providerId: params.providerId,
			parsed,
			textSoFar: assistantText,
			sessionId,
			usage
		}});
		if (geminiRecord) {{
			if (geminiRecord.kind === "assistant") {{
				assistantText = geminiRecord.event.text;
				params.onAssistantDelta(geminiRecord.event);
				return;
			}}
			if (geminiRecord.kind === "tool") {{
				const event = {{ ...geminiRecord.event }};
				if (event.phase === "start" && typeof event.name === "string") toolNameById.set(event.toolCallId, event.name);
				else if (!event.name && toolNameById.has(event.toolCallId)) event.name = toolNameById.get(event.toolCallId);
				if (event.phase === "result") {{
					if (!event.name && toolNameById.has(event.toolCallId)) event.name = toolNameById.get(event.toolCallId);
					toolNameById.delete(event.toolCallId);
				}}
				params.onToolEvent?.(event);
				return;
			}}
		}}
		const delta = parseClaudeCliStreamingDelta({{
			backend: params.backend,
			providerId: params.providerId,
			parsed,
			textSoFar: assistantText,
			sessionId,
			usage
		}});
		if (!delta) return;
		assistantText = delta.text;
		params.onAssistantDelta(delta);
	}};
	const flushLines = (flushPartial) => {{
		while (true) {{
			const newlineIndex = lineBuffer.indexOf("\n");
			if (newlineIndex < 0) break;
			const line = lineBuffer.slice(0, newlineIndex).trim();
			lineBuffer = lineBuffer.slice(newlineIndex + 1);
			if (!line) continue;
			for (const parsed of parseJsonRecordCandidates(line)) handleParsedRecord(parsed);
		}}
		if (!flushPartial) return;
		const tail = lineBuffer.trim();
		lineBuffer = "";
		if (!tail) return;
		for (const parsed of parseJsonRecordCandidates(tail)) handleParsedRecord(parsed);
	}};
	return {{
		push(chunk) {{
			if (!chunk) return;
			lineBuffer += chunk;
			flushLines(false);
		}},
		finish() {{
			flushLines(true);
		}}
	}};
}}
'''.replace('{record_fn}', record_fn)
parse_cli_jsonl_block = f'''function parseCliJsonl(raw, backend, providerId) {{
	const lines = raw.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return null;
	let sessionId;
	let usage;
	let assistantText = "";
	let sawStructuredOutput = false;
	const texts = [];
	for (const line of lines) for (const parsed of parseJsonRecordCandidates(line)) {{
		if (!sessionId) sessionId = pickCliSessionId(parsed, backend);
		if (!sessionId && typeof parsed.thread_id === "string") sessionId = parsed.thread_id.trim();
		usage = readCliUsage(parsed) ?? usage;
		const geminiRecord = parseGeminiCliStreamingRecord({{
			backend,
			providerId,
			parsed,
			textSoFar: assistantText,
			sessionId,
			usage
		}});
		if (geminiRecord) {{
			sawStructuredOutput = true;
			if (geminiRecord.kind === "assistant") assistantText = geminiRecord.event.text;
			continue;
		}}
		const claudeResult = parseClaudeCliJsonlResult({{
			backend,
			providerId,
			parsed,
			sessionId,
			usage
		}});
		if (claudeResult) return claudeResult;
		const item = {record_fn}(parsed.item) ? parsed.item : null;
		if (item && typeof item.text === "string") {{
			const type = normalizeLowercaseStringOrEmpty(item.type);
			if (!type || type.includes("message")) {{
				texts.push(item.text);
				sawStructuredOutput = true;
			}}
		}} else if (sessionId || usage) sawStructuredOutput = true;
	}}
	const text = assistantText.trim() || texts.join("\n").trim();
	if (!text && !sawStructuredOutput) return null;
	return {{
		text,
		sessionId,
		usage
	}};
}}
'''.replace('{record_fn}', record_fn)

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
if [[ -f "$CLI_BACKEND" ]]; then
  grep -n 'stream-json\|gemini-stream-json' "$CLI_BACKEND"
fi
if [[ -n "$GEMINI_PARSER_TARGET" ]]; then
  grep -nF 'function isGeminiCliProvider(providerId)' "$GEMINI_PARSER_TARGET"
  grep -nF 'function parseGeminiCliStreamingRecord(params)' "$GEMINI_PARSER_TARGET"
fi
if [[ -n "$EXECUTE_RUNTIME" ]]; then
  grep -nF 'onToolEvent: (event) => {' "$EXECUTE_RUNTIME"
fi

echo "Compatibility hotfix complete. Restart OpenClaw gateway for changes to take effect."