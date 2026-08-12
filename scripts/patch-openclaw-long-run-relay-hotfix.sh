#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/usr/lib/node_modules/openclaw/dist}"
STRICT_MODE="${PORTAL_OPENCLAW_HOTFIX_STRICT:-0}"
REQUIRED_PACKAGE_VERSION="${PORTAL_REQUIRED_OPENCLAW_PACKAGE_VERSION:-2026.7.1-2}"

case "${STRICT_MODE}" in
  0|1) ;;
  *)
    echo "invalid PORTAL_OPENCLAW_HOTFIX_STRICT value: ${STRICT_MODE}" >&2
    exit 2
    ;;
esac

[[ -d "${ROOT}" ]] || { echo "OpenClaw dist directory not found: ${ROOT}" >&2; exit 1; }

python3 - "${ROOT}" "${REQUIRED_PACKAGE_VERSION}" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
expected = sys.argv[2]
package_json = root.parent / "package.json"
try:
    package = json.loads(package_json.read_text())
except Exception as error:
    raise SystemExit(f"could not read OpenClaw package metadata at {package_json}: {error}")
if package.get("name") != "openclaw" or package.get("version") != expected:
    raise SystemExit(
        f"refusing to patch untested package {package.get('name')}@{package.get('version')}; "
        f"expected openclaw@{expected}"
    )
PY

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
RUNS_BUNDLE="$(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
for candidate in sorted(root.glob('runs-*.js'), key=lambda p: (p.stat().st_size, p.name), reverse=True):
    try:
        text = candidate.read_text()
    except Exception:
        continue
    if (
        'function queueEmbeddedAgentMessageWithOutcomeAsync(' in text
        and 'function setActiveEmbeddedRun(' in text
        and 'ACTIVE_EMBEDDED_RUNS.get(sessionId)' in text
    ):
        print(candidate)
        break
PY
)"
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

require_strict_bundle() {
  local label="$1" target="$2"
  if [[ "${STRICT_MODE}" == "1" && ( -z "${target}" || ! -f "${target}" ) ]]; then
    FAILED_PATCHES+=("missing-${label}")
  fi
}

require_strict_bundle "compaction-tools" "${COMPACT_TOOLS_BUNDLE}"
require_strict_bundle "agent-runner-runtime" "${AGENT_RUNNER_RUNTIME}"
require_strict_bundle "embedded-runs" "${RUNS_BUNDLE}"
require_strict_bundle "heartbeat-detector" "${HEARTBEAT_DETECTOR_FILE:-${HEARTBEAT_EVENTS_FILTER:-${HEARTBEAT_RUNNER}}}"
require_strict_bundle "heartbeat-runner" "${HEARTBEAT_RUNNER}"
require_strict_bundle "reply-routing" "${GET_REPLY_FILE}"
require_strict_bundle "claude-permission" "${CLAUDE_CLI_SHARED}"
require_strict_bundle "gemini-cli-backend" "${CLI_BACKEND}"
require_strict_bundle "gemini-parser" "${GEMINI_PARSER_TARGET:-${CLAUDE_LIVE_SESSION:-${EXECUTE_RUNTIME}}}"
require_strict_bundle "execute-runtime" "${EXECUTE_RUNTIME}"

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

# OpenClaw 2026.7.1-2: a generic gateway chat.send steer supplies a
# userTurnTranscriptRecorder but no Portal-only onTurnAdopted callback. The
# stock conditional therefore returns before the active embedded runtime owns
# the new user turn. Gateway fallback persistence can then append the same turn
# externally, and the next tool yield fails with EmbeddedAttemptSessionTakeoverError.
# Wait for the recorder commit whenever either ownership finalizer is present.
if [[ -n "$AGENT_RUNNER_RUNTIME" && -f "$AGENT_RUNNER_RUNTIME" ]]; then
python3 - "$AGENT_RUNNER_RUNTIME" "$STRICT_MODE" <<'PY' || FAILED_PATCHES+=("active-steer-transcript-commit")
from pathlib import Path
import sys

p = Path(sys.argv[1])
strict = sys.argv[2] == "1"
text = p.read_text()

call_marker = "const steerOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(steerSessionId, followupRun.prompt, {"
recorder_forwarding = "...followupRun.userTurnTranscriptRecorder ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder } : {}"
hotfix_marker = "bridgesllm-openclaw-active-steer-transcript-commit-v1"
old_line = "\t\t\t...opts?.onTurnAdopted ? { waitForTranscriptCommit: true } : {},"
patched_line = "\t\t\t...opts?.onTurnAdopted || followupRun.userTurnTranscriptRecorder ? { waitForTranscriptCommit: true } : {},"
native_lines = (
    patched_line,
    "\t\t\t...(opts?.onTurnAdopted || followupRun.userTurnTranscriptRecorder) ? { waitForTranscriptCommit: true } : {},",
    "\t\t\t...followupRun.userTurnTranscriptRecorder || opts?.onTurnAdopted ? { waitForTranscriptCommit: true } : {},",
    "\t\t\twaitForTranscriptCommit: Boolean(opts?.onTurnAdopted || followupRun.userTurnTranscriptRecorder),",
    "\t\t\twaitForTranscriptCommit: Boolean(followupRun.userTurnTranscriptRecorder || opts?.onTurnAdopted),",
)

call_count = text.count(call_marker)
if call_count != 1:
    message = f"active steer transcript-commit call site drifted in {p} (found {call_count})"
    if strict:
        raise SystemExit(message)
    print(f"skipping active steer transcript-commit patch: {message}")
    raise SystemExit(0)

call_start = text.index(call_marker)
call_end = text.find("\n\t\t});", call_start)
if call_end < 0:
    raise SystemExit(f"active steer transcript-commit options block is incomplete in {p}")
block = text[call_start:call_end]
if recorder_forwarding not in block:
    raise SystemExit(f"active steer transcript recorder forwarding drifted in {p}")

marker_count = text.count(hotfix_marker)
if marker_count:
    if marker_count != 1 or hotfix_marker not in block or block.count(patched_line) != 1:
        raise SystemExit(f"active steer transcript-commit marker is partial or duplicated in {p}")
    print(f"active steer transcript-commit already patched: {p}")
    raise SystemExit(0)

native_matches = [line for line in native_lines if line in block]
if native_matches:
    if len(native_matches) != 1 or block.count(native_matches[0]) != 1 or old_line in block:
        raise SystemExit(f"active steer transcript-commit native contract is ambiguous in {p}")
    print(f"active steer transcript-commit already native: {p}")
    raise SystemExit(0)

if text.count(old_line) != 1 or old_line not in block:
    message = f"active steer transcript-commit target not found in {p}"
    if strict:
        raise SystemExit(message)
    print(f"skipping active steer transcript-commit patch: {message}")
    raise SystemExit(0)

replacement = f'\t\t\t// {hotfix_marker}\n{patched_line}'
p.write_text(text.replace(old_line, replacement, 1))
print(f"patched active steer transcript-commit wait: {p}")
PY
else
  echo "skipping active steer transcript-commit patch: agent runner runtime bundle not found under $ROOT"
fi

# Portal's exact-run steer RPC must work for every embedded provider, not only
# the separately patched Codex app-server extension. The stock public SDK queue
# API is deliberately insufficient: it is session-only, fire-and-forget, and
# cannot attest asynchronous rejection. Install one process-local adapter next
# to the authoritative active-run map instead. It verifies the expected run id
# and resolves only after the embedded handle confirms queue acceptance and the
# matching user message reaches the transcript.
if [[ -n "$RUNS_BUNDLE" && -f "$RUNS_BUNDLE" ]]; then
python3 - "$RUNS_BUNDLE" <<'PY' || FAILED_PATCHES+=("provider-neutral-exact-run-steer")
from pathlib import Path
import sys

p = Path(sys.argv[1])
text = p.read_text()
marker = 'bridgesllm-openclaw-provider-neutral-exact-run-steer-v1'
symbol = 'bridgesllm.openclaw.active-run-steer.v1'
anchor = 'function prepareEmbeddedAgentQueueMessage(sessionId, text, options) {'

runtime = r'''// bridgesllm-openclaw-provider-neutral-exact-run-steer-v1
const BRIDGESLLM_ACTIVE_RUN_STEER_SYMBOL = Symbol.for("bridgesllm.openclaw.active-run-steer.v1");
function bridgesllmActiveRunSteerIdentity(value, maxLength) {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001F\u007F]/.test(value) ? value : void 0;
}
function bridgesllmActiveRunSteerText(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 32768 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) ? value : void 0;
}
const bridgesllmActiveRunSteerApi = Object.freeze({
	version: 1,
	read() {
		return null;
	},
	answer(sessionId, expectedRunId) {
		return {
			ok: false,
			code: "NO_PENDING_INPUT",
			...bridgesllmActiveRunSteerIdentity(expectedRunId, 512) ? { runId: expectedRunId } : {}
		};
	},
	dismiss(sessionId, expectedRunId) {
		return {
			ok: false,
			code: "NO_PENDING_INPUT",
			...bridgesllmActiveRunSteerIdentity(expectedRunId, 512) ? { runId: expectedRunId } : {}
		};
	},
	async steer(sessionId, expectedRunId, text) {
		const safeSessionId = bridgesllmActiveRunSteerIdentity(sessionId, 512);
		const safeRunId = bridgesllmActiveRunSteerIdentity(expectedRunId, 512);
		const safeText = bridgesllmActiveRunSteerText(text);
		if (!safeSessionId || !safeRunId || !safeText) return {
			ok: false,
			code: "INVALID_IDENTITY"
		};
		const handle = ACTIVE_EMBEDDED_RUNS.get(safeSessionId);
		if (!handle) return {
			ok: false,
			code: "NO_ACTIVE_RUN"
		};
		if (handle.runId !== safeRunId) return {
			ok: false,
			code: "RUN_MISMATCH"
		};
		if (!isEmbeddedQueueHandleMessageInjectable(safeSessionId, handle)) return {
			ok: false,
			code: "NO_ACTIVE_RUN"
		};
		if (handle.isCompacting()) return {
			ok: false,
			code: "QUEUE_REJECTED",
			runId: safeRunId
		};
		if (handle.supportsTranscriptCommitWait !== true) return {
			ok: false,
			code: "TRANSCRIPT_COMMIT_UNSUPPORTED",
			runId: safeRunId
		};
		try {
			// Dispatch through the one handle whose run id was attested above.
			// Re-entering the session-only queue helper here would perform a second
			// map lookup and could target a replacement run.
			await handle.queueMessage(safeText, {
				steeringMode: "all",
				debounceMs: 0,
				waitForTranscriptCommit: true,
				// bridgesllm-openclaw-active-steer-delivery-timeout-v1
				deliveryTimeoutMs: 10000
			});
			logMessageQueued({
				sessionId: safeSessionId,
				source: "bridgesllm-exact-run-steer"
			});
			return {
				ok: true,
				code: "STEERED",
				runId: safeRunId
			};
		} catch {
			return {
				ok: false,
				code: "QUEUE_REJECTED",
				runId: safeRunId
			};
		}
	}
});
if (globalThis[BRIDGESLLM_ACTIVE_RUN_STEER_SYMBOL] !== void 0) throw new Error("BridgesLLM active-run steering runtime symbol is already registered");
Object.defineProperty(globalThis, BRIDGESLLM_ACTIVE_RUN_STEER_SYMBOL, {
	value: bridgesllmActiveRunSteerApi,
	writable: false,
	configurable: false,
	enumerable: false
});
'''

marker_count = text.count(marker)
if marker_count:
    marker_start = text.index(f'// {marker}')
    marker_end = text.find(anchor, marker_start)
    if marker_end < 0:
        raise SystemExit(f"provider-neutral exact-run steer patch has no closing anchor in {p}")
    marker_block = text[marker_start:marker_end]
    base_contract_invalid = (
        marker_count != 1
        or marker_block.count(f'Symbol.for("{symbol}")') != 1
        or marker_block.count('waitForTranscriptCommit: true') != 1
        or marker_block.count('handle.runId !== safeRunId') != 1
        or marker_block.count('await handle.queueMessage(safeText, {') != 1
    )
    if base_contract_invalid:
        raise SystemExit(f"provider-neutral exact-run steer patch is partial or duplicated in {p}")
    delivery_marker = 'bridgesllm-openclaw-active-steer-delivery-timeout-v1'
    delivery_line = '\t\t\t\tdeliveryTimeoutMs: 10000'
    if delivery_marker not in marker_block:
        old_wait_line = '\t\t\t\twaitForTranscriptCommit: true'
        if (
            marker_block.count(old_wait_line) != 1
            or 'deliveryTimeoutMs:' in marker_block
            or delivery_marker in text
        ):
            raise SystemExit(f"provider-neutral exact-run steer delivery timeout is partial or ambiguous in {p}")
        replacement = (
            old_wait_line + ',\n'
            '\t\t\t\t// ' + delivery_marker + '\n'
            + delivery_line
        )
        upgraded_block = marker_block.replace(old_wait_line, replacement, 1)
        p.write_text(text[:marker_start] + upgraded_block + text[marker_end:])
        print(f"upgraded provider-neutral exact-run steer delivery timeout: {p}")
        raise SystemExit(0)
    if (
        marker_block.count(delivery_marker) != 1
        or marker_block.count(delivery_line) != 1
        or marker_block.count('deliveryTimeoutMs:') != 1
    ):
        raise SystemExit(f"provider-neutral exact-run steer delivery timeout is partial or ambiguous in {p}")
    print(f"provider-neutral exact-run steer already patched: {p}")
    raise SystemExit(0)

if text.count(anchor) != 1:
    raise SystemExit(f"provider-neutral exact-run steer anchor drifted in {p}")
if text.count('const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);') < 1:
    raise SystemExit(f"authoritative active-run lookup drifted in {p}")
if text.count('function isEmbeddedQueueHandleMessageInjectable(') != 1:
    raise SystemExit(f"captured-handle queue eligibility check drifted in {p}")

p.write_text(text.replace(anchor, runtime + anchor, 1))
print(f"patched provider-neutral exact-run steer runtime: {p}")
PY
else
  echo "skipping provider-neutral exact-run steer patch: embedded runs bundle not found under $ROOT"
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
python3 - "$CLI_BACKEND" "$STRICT_MODE" <<'PY' || FAILED_PATCHES+=("gemini-cli-backend")
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
strict = sys.argv[2] == "1"
text = p.read_text()

def arg_block(candidate: str, key: str) -> str:
    marker = f"{key}: ["
    start = candidate.find(marker)
    if start < 0:
        return ""
    end = candidate.find("]", start + len(marker))
    return candidate[start:end + 1] if end >= 0 else ""

def has_stream_json(block: str) -> bool:
    return bool(re.search(r'"--output-format",\s*"stream-json"', block))

def has_noninteractive_approval(block: str) -> bool:
    return (
        '"--yolo"' in block
        or bool(re.search(r'"--approval-mode",\s*"auto_edit"', block))
    )

def contract_failures(candidate: str) -> list[str]:
    failures = []
    fresh_args = arg_block(candidate, "args")
    resume_args = arg_block(candidate, "resumeArgs")
    if not has_stream_json(fresh_args):
        failures.append("fresh stream-json arguments")
    if not has_stream_json(resume_args):
        failures.append("resume stream-json arguments")
    if 'output: "jsonl",' not in candidate:
        failures.append("jsonl output mode")
    if 'jsonlDialect: "gemini-stream-json"' not in candidate:
        failures.append("Gemini stream-json dialect")
    if not has_noninteractive_approval(fresh_args):
        failures.append("fresh non-interactive approval")
    if not has_noninteractive_approval(resume_args):
        failures.append("resume non-interactive approval")
    return failures

if not contract_failures(text):
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

failures = contract_failures(text)
if not failures:
    if changed:
        p.write_text(text)
        print(f"patched gemini cli backend: {p}")
    else:
        print(f"gemini cli backend already patched: {p}")
elif strict:
    details = ", ".join(failures)
    missing_details = f"; unavailable replacements: {', '.join(missing)}" if missing else ""
    raise SystemExit(
        f"Gemini CLI backend compatibility contract is incomplete in {p}: "
        f"{details}{missing_details}"
    )
elif changed:
    p.write_text(text)
    print(
        f"patched gemini cli backend partially; missing contract markers "
        f"{failures}; skipped unsupported snippets {missing}: {p}"
    )
else:
    print(
        f"gemini cli backend patch not needed or unsupported for current bundle; "
        f"missing contract markers {failures}; missing snippets {missing}: {p}"
    )
PY
else
  echo "skipping Gemini CLI backend patch: backend bundle not found under $ROOT"
fi

if [[ -n "$CLAUDE_CLI_SHARED" && -f "$CLAUDE_CLI_SHARED" ]]; then
python3 - "$CLAUDE_CLI_SHARED" <<'PY' || FAILED_PATCHES+=("claude-runtime-normalization")
from pathlib import Path
import os
import subprocess
import sys
import tempfile

p = Path(sys.argv[1])
text = p.read_text()
changed = False

permission_marker = 'process.getuid() === 0'
permission_old = '''function resolveClaudePermissionMode(context) {
\treturn isOpenClawRequestedYolo(context) ? {
\t\tmode: CLAUDE_BYPASS_PERMISSION_MODE,
\t\toverrideExisting: false
\t} : { overrideExisting: false };
}
'''
permission_new = '''function resolveClaudePermissionMode(context) {
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
if permission_marker in text:
    if text.count(permission_marker) != 1:
        raise SystemExit(f"Claude root permission marker is ambiguous in {p}")
elif text.count(permission_old) == 1:
    text = text.replace(permission_old, permission_new, 1)
    changed = True
else:
    raise SystemExit(f"Claude permission resolver target not found in {p}")

# User cliBackends overrides replace the registered backend's args/resumeArgs
# arrays before this normalizer runs. Enforce the native AskUserQuestion deny
# here, after that merge, so no valid override can restore Claude Code's
# headless-only tool. The Portal-owned MCP ask_user_question remains available.
ask_marker = 'const BRIDGESLLM_CLAUDE_ASK_USER_ROUTE_MARKER = "bridgesllm-openclaw-claude-ask-user-route-v2";'
ask_old = '''function normalizeClaudeBackendConfig(config, context) {
\tconst output = config.output ?? "jsonl";
\tconst input = config.input ?? "stdin";
\tconst permission = resolveClaudePermissionMode(context);
\treturn {
\t\t...config,
\t\targs: normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.args), permission),
\t\tresumeArgs: normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.resumeArgs), permission),
\t\toutput,
\t\tliveSession: config.liveSession ?? (output === "jsonl" && input === "stdin" ? "claude-stdio" : void 0),
\t\tinput
\t};
}
'''
ask_new = '''const BRIDGESLLM_CLAUDE_ASK_USER_ROUTE_MARKER = "bridgesllm-openclaw-claude-ask-user-route-v2";
const CLAUDE_DISALLOWED_TOOLS_ARGS = /* @__PURE__ */ new Set([
\tCLAUDE_DISALLOWED_TOOLS_ARG,
\t"--disallowed-tools"
]);
const CLAUDE_ASK_USER_TOOL_NAME = "AskUserQuestion";
function claudeToolListContainsExact(value, toolName) {
\treturn value.split(/[,\\s]+/u).some((entry) => entry === toolName);
}
function ensureClaudeDisallowedTool(args, toolName) {
\tif (!args) return args;
\tconst normalized = [...args];
\tconst sentinelIndex = normalized.indexOf("--");
\tlet scanLimit = sentinelIndex >= 0 ? sentinelIndex : normalized.length;
\tlet foundFlag = false;
\tfor (let i = 0; i < scanLimit; i += 1) {
\t\tconst arg = normalized[i] ?? "";
\t\tconst equalsIndex = arg.indexOf("=");
\t\tconst argName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
\t\tif (!CLAUDE_DISALLOWED_TOOLS_ARGS.has(argName)) continue;
\t\tfoundFlag = true;
\t\tif (equalsIndex > 0) {
\t\t\tconst value = arg.slice(equalsIndex + 1);
\t\t\tif (!claudeToolListContainsExact(value, toolName)) normalized[i] = `${argName}=${value ? `${value},${toolName}` : toolName}`;
\t\t\tcontinue;
\t\t}
\t\tlet valueEnd = i + 1;
\t\tlet containsTool = false;
\t\twhile (valueEnd < scanLimit) {
\t\t\tconst value = normalized[valueEnd] ?? "";
\t\t\tif (value === "--" || value.startsWith("-")) break;
\t\t\tcontainsTool ||= claudeToolListContainsExact(value, toolName);
\t\t\tvalueEnd += 1;
\t\t}
\t\tif (!containsTool) {
\t\t\tnormalized.splice(valueEnd, 0, toolName);
\t\t\tscanLimit += 1;
\t\t}
\t}
\tif (!foundFlag) {
\t\tconst insertAt = normalized.indexOf("--");
\t\tnormalized.splice(insertAt >= 0 ? insertAt : normalized.length, 0, CLAUDE_DISALLOWED_TOOLS_ARG, toolName);
\t}
\treturn normalized;
}
function normalizeClaudeBackendConfig(config, context) {
\tconst output = config.output ?? "jsonl";
\tconst input = config.input ?? "stdin";
\tconst permission = resolveClaudePermissionMode(context);
\treturn {
\t\t...config,
\t\targs: ensureClaudeDisallowedTool(normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.args), permission), CLAUDE_ASK_USER_TOOL_NAME),
\t\tresumeArgs: ensureClaudeDisallowedTool(normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.resumeArgs), permission), CLAUDE_ASK_USER_TOOL_NAME),
\t\toutput,
\t\tliveSession: config.liveSession ?? (output === "jsonl" && input === "stdin" ? "claude-stdio" : void 0),
\t\tinput
\t};
}
'''

if ask_marker in text:
    if (
        text.count(ask_marker) != 1
        or text.count('function ensureClaudeDisallowedTool(args, toolName) {\n\tif (!args) return args;\n\tconst normalized = [...args];') != 1
        or text.count('args: ensureClaudeDisallowedTool(') != 1
        or text.count('resumeArgs: ensureClaudeDisallowedTool(') != 1
        or ask_old in text
    ):
        raise SystemExit(f"Claude CLI ask-user normalization contract is incomplete in {p}")
elif text.count(ask_old) == 1:
    text = text.replace(ask_old, ask_new, 1)
    changed = True
else:
    raise SystemExit(f"Claude CLI ask-user normalization target not found in {p}")

if (
    text.count(permission_marker) != 1
    or text.count(ask_marker) != 1
    or text.count('function ensureClaudeDisallowedTool(args, toolName) {\n\tif (!args) return args;\n\tconst normalized = [...args];') != 1
    or text.count('args: ensureClaudeDisallowedTool(') != 1
    or text.count('resumeArgs: ensureClaudeDisallowedTool(') != 1
):
    raise SystemExit(f"Claude runtime normalization post-patch verification failed in {p}")
if changed:
    if subprocess.run(
        ["node", "--input-type=module", "--check", "-"],
        input=text,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode != 0:
        raise SystemExit(f"generated Claude runtime normalization is not valid JavaScript in {p}")
    temporary_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=p.parent,
            prefix=f".{p.name}.bridgesllm-claude-ask-user-",
            suffix=".js",
            delete=False,
        ) as stream:
            temporary_name = stream.name
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary_name, p.stat().st_mode & 0o7777)
        os.replace(temporary_name, p)
        temporary_name = ""
        directory_fd = os.open(p.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary_name:
            try:
                Path(temporary_name).unlink()
            except FileNotFoundError:
                pass
    print(f"patched Claude runtime normalization: {p}")
else:
    print(f"Claude runtime normalization already patched: {p}")
PY
else
  echo "skipping Claude runtime normalization patch: cli-shared bundle not found under $ROOT"
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
require_strict_bundle "sonnet5-cost-runtime" "${REGISTER_RUNTIME_BUNDLE}"
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
require_strict_bundle "cli-watchdog-defaults" "${WATCHDOG_DEFAULTS_BUNDLE}"
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
  grep -n 'stream-json\|gemini-stream-json' "$CLI_BACKEND" || [[ "${STRICT_MODE}" != "1" ]]
fi
if [[ -n "$CLAUDE_CLI_SHARED" && -f "$CLAUDE_CLI_SHARED" ]]; then
  grep -nF 'bridgesllm-openclaw-claude-ask-user-route-v2' "$CLAUDE_CLI_SHARED" \
    || [[ "${STRICT_MODE}" != "1" ]]
  [[ "$(grep -cF 'ensureClaudeDisallowedTool(' "$CLAUDE_CLI_SHARED")" -eq 3 ]] \
    || [[ "${STRICT_MODE}" != "1" ]]
  grep -nF $'\tif (!args) return args;' "$CLAUDE_CLI_SHARED" \
    || [[ "${STRICT_MODE}" != "1" ]]
fi
if [[ -n "$COMPACT_TOOLS_BUNDLE" && -f "$COMPACT_TOOLS_BUNDLE" ]]; then
  grep -nF 'memoryFlushWritePath: params.memoryFlushWritePath' "$COMPACT_TOOLS_BUNDLE" || true
fi
if [[ -n "$AGENT_RUNNER_RUNTIME" && -f "$AGENT_RUNNER_RUNTIME" ]]; then
  grep -nF 'canAttemptFlush && shouldForceFlushByTranscriptSize' "$AGENT_RUNNER_RUNTIME" || true
fi
if [[ -n "$GEMINI_PARSER_TARGET" ]]; then
  grep -nF 'function isGeminiCliProvider(providerId)' "$GEMINI_PARSER_TARGET" || [[ "${STRICT_MODE}" != "1" ]]
  grep -nF 'function parseGeminiCliStreamingDelta(params)' "$GEMINI_PARSER_TARGET" || [[ "${STRICT_MODE}" != "1" ]]
  grep -nF 'function dispatchGeminiCliStreamingToolEvent(params)' "$GEMINI_PARSER_TARGET" || [[ "${STRICT_MODE}" != "1" ]]
  grep -nF 'parseGeminiCliStreamingDelta({' "$GEMINI_PARSER_TARGET" || [[ "${STRICT_MODE}" != "1" ]]
  grep -nF 'dispatchGeminiCliStreamingToolEvent({' "$GEMINI_PARSER_TARGET" || [[ "${STRICT_MODE}" != "1" ]]
fi
if [[ -n "$EXECUTE_RUNTIME" ]]; then
  grep -nF 'onToolUseStart: emitCliToolUseStart' "$EXECUTE_RUNTIME" || grep -nF 'onToolEvent: (event) => {' "$EXECUTE_RUNTIME" || [[ "${STRICT_MODE}" != "1" ]]
fi
if [[ "${STRICT_MODE}" == "1" ]]; then
  python3 - "$CLI_BACKEND" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()

def arg_block(candidate: str, key: str) -> str:
    marker = f"{key}: ["
    start = candidate.find(marker)
    if start < 0:
        return ""
    end = candidate.find("]", start + len(marker))
    return candidate[start:end + 1] if end >= 0 else ""

def has_stream_json(block: str) -> bool:
    return bool(re.search(r'"--output-format",\s*"stream-json"', block))

def has_noninteractive_approval(block: str) -> bool:
    return (
        '"--yolo"' in block
        or bool(re.search(r'"--approval-mode",\s*"auto_edit"', block))
    )

fresh_args = arg_block(text, "args")
resume_args = arg_block(text, "resumeArgs")
required = {
    "fresh stream-json arguments": has_stream_json(fresh_args),
    "resume stream-json arguments": has_stream_json(resume_args),
    "jsonl output mode": 'output: "jsonl",' in text,
    "Gemini stream-json dialect": 'jsonlDialect: "gemini-stream-json"' in text,
    "fresh non-interactive approval": has_noninteractive_approval(fresh_args),
    "resume non-interactive approval": has_noninteractive_approval(resume_args),
}
missing = [label for label, present in required.items() if not present]
if missing:
    raise SystemExit(
        "Gemini CLI backend post-patch verification failed: " + ", ".join(missing)
    )
PY
  grep -nF 'function isGeminiCliProvider(providerId)' "$GEMINI_PARSER_TARGET"
  grep -nF 'function parseGeminiCliStreamingDelta(params)' "$GEMINI_PARSER_TARGET"
  grep -nF 'function dispatchGeminiCliStreamingToolEvent(params)' "$GEMINI_PARSER_TARGET"
  grep -nF 'parseGeminiCliStreamingDelta({' "$GEMINI_PARSER_TARGET"
  grep -nF 'dispatchGeminiCliStreamingToolEvent({' "$GEMINI_PARSER_TARGET"
  if ! grep -nF 'onToolUseStart: emitCliToolUseStart' "$EXECUTE_RUNTIME"; then
    grep -nF 'onToolEvent: (event) => {' "$EXECUTE_RUNTIME"
  fi
  grep -nF 'process.getuid() === 0' "$CLAUDE_CLI_SHARED"
  grep -nF 'bridgesllm-openclaw-claude-ask-user-route-v2' "$CLAUDE_CLI_SHARED"
  [[ "$(grep -cF 'ensureClaudeDisallowedTool(' "$CLAUDE_CLI_SHARED")" -eq 3 ]]
  grep -nF $'\tif (!args) return args;' "$CLAUDE_CLI_SHARED"
  grep -nF 'params.model.cost && params.model.cost.input === cost.input' "$REGISTER_RUNTIME_BUNDLE"
  grep -nF 'minMs: 9e5' "$WATCHDOG_DEFAULTS_BUNDLE"
  [[ "$(grep -cF 'minMs: 9e5' "$WATCHDOG_DEFAULTS_BUNDLE")" -ge 2 ]]
  python3 - "$AGENT_RUNNER_RUNTIME" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
call_marker = "const steerOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(steerSessionId, followupRun.prompt, {"
call_start = text.index(call_marker)
call_end = text.find("\n\t\t});", call_start)
if call_end < 0:
    raise SystemExit("active steer transcript-commit verification block is incomplete")
block = text[call_start:call_end]
safe_contracts = (
    "\t\t\t...opts?.onTurnAdopted || followupRun.userTurnTranscriptRecorder ? { waitForTranscriptCommit: true } : {},",
    "\t\t\t...(opts?.onTurnAdopted || followupRun.userTurnTranscriptRecorder) ? { waitForTranscriptCommit: true } : {},",
    "\t\t\t...followupRun.userTurnTranscriptRecorder || opts?.onTurnAdopted ? { waitForTranscriptCommit: true } : {},",
    "\t\t\twaitForTranscriptCommit: Boolean(opts?.onTurnAdopted || followupRun.userTurnTranscriptRecorder),",
    "\t\t\twaitForTranscriptCommit: Boolean(followupRun.userTurnTranscriptRecorder || opts?.onTurnAdopted),",
)
matches = [contract for contract in safe_contracts if contract in block]
if len(matches) != 1 or block.count(matches[0]) != 1:
    raise SystemExit("active steer transcript-commit post-patch verification failed")
PY
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

for bundle in "$HEARTBEAT_EVENTS_FILTER" "$HEARTBEAT_RUNNER" "$GET_REPLY_FILE" "$COMPACT_TOOLS_BUNDLE" "$AGENT_RUNNER_RUNTIME" "$CLI_BACKEND" "$CLAUDE_CLI_SHARED" "$GEMINI_PARSER_TARGET" "$EXECUTE_RUNTIME" "$REGISTER_RUNTIME_BUNDLE" "$WATCHDOG_DEFAULTS_BUNDLE"; do
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
