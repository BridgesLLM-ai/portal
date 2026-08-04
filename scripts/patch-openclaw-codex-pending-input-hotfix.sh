#!/usr/bin/env bash
set -Eeuo pipefail

dist_root="${1:-/usr/lib/node_modules/openclaw/dist}"
readonly expected_package_name="${PORTAL_REQUIRED_OPENCLAW_PACKAGE_NAME:-openclaw}"
readonly expected_package_version="${PORTAL_REQUIRED_OPENCLAW_PACKAGE_VERSION:-2026.7.1-2}"
readonly strict_mode="${PORTAL_OPENCLAW_PENDING_INPUT_STRICT:-1}"

case "${expected_package_name}" in
  openclaw|@openclaw/codex) ;;
  *)
    printf 'unsupported PORTAL_REQUIRED_OPENCLAW_PACKAGE_NAME value: %s\n' \
      "${expected_package_name}" >&2
    exit 2
    ;;
esac

case "${strict_mode}" in
  0|1) ;;
  *)
    printf 'invalid PORTAL_OPENCLAW_PENDING_INPUT_STRICT value: %s\n' \
      "${strict_mode}" >&2
    exit 2
    ;;
esac

[[ -d "${dist_root}" ]] || {
  printf 'OpenClaw dist directory not found: %s\n' "${dist_root}" >&2
  exit 1
}

python3 - \
  "${dist_root}" \
  "${expected_package_name}" \
  "${expected_package_version}" \
  "${strict_mode}" <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


dist = Path(sys.argv[1]).resolve()
expected_name = sys.argv[2]
expected_version = sys.argv[3]
strict = sys.argv[4] == "1"
package_path = dist.parent / "package.json"


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


try:
    package = json.loads(package_path.read_text(encoding="utf-8"))
except Exception as error:
    fail(f"could not read OpenClaw package metadata at {package_path}: {error}")

observed_name = package.get("name")
observed_version = package.get("version")
if observed_name != expected_name or observed_version != expected_version:
    fail(
        "refusing to patch untested OpenClaw package "
        f"{observed_name}@{observed_version}; expected {expected_name}@{expected_version}"
    )

runtime_symbol_name = (
    "bridgesllm.openclaw.pending-input.codex-plugin.v1"
    if expected_name == "@openclaw/codex"
    else "bridgesllm.openclaw.pending-input.v1"
)
runtime_log_name = "embeddedAgentLog" if expected_name == "@openclaw/codex" else "log"

structural_markers = (
    "function createCodexUserInputBridge(params) {",
    'request.method === "item/tool/requestUserInput"',
    "const activeSteeringQueue = createCodexSteeringQueue({",
    "setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);",
    "clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);",
)
matches: list[Path] = []
for candidate in sorted(dist.glob("run-attempt-*.js")):
    try:
        candidate_text = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        continue
    if all(marker in candidate_text for marker in structural_markers):
        matches.append(candidate)

if len(matches) != 1:
    names = ", ".join(path.name for path in matches) or "none"
    message = (
        "could not identify exactly one tested Codex run-attempt bundle by structural "
        f"markers (found {len(matches)}: {names})"
    )
    if strict:
        fail(message)
    print(f"skipping pending-input hotfix: {message}", file=sys.stderr)
    raise SystemExit(0)

target = matches[0]
original = target.read_text(encoding="utf-8")
hotfix_marker = (
    'const BRIDGESLLM_PENDING_INPUT_HOTFIX_MARKER = '
    '"bridgesllm-openclaw-pending-input-v1";'
)
patched_contract = (
    hotfix_marker,
    f'Symbol.for("{runtime_symbol_name}")',
    "bridgesllmRegisterPendingInputRun({",
    "bridgesllmUnregisterPendingInputRun(params.sessionId, params.runId, userInputBridgeRef.current);",
    "answerPending(requestId, text)",
    "dismissPending(requestId)",
    "async steer(sessionId, expectedRunId, text)",
    "steerOnly",
    "expiresAt: current.expiresAt",
)
if hotfix_marker in original:
    missing = [contract for contract in patched_contract if contract not in original]
    if missing:
        fail(
            f"pending-input hotfix marker exists but its contract is incomplete in {target}: "
            + ", ".join(missing)
        )
    if original.count(hotfix_marker) != 1:
        fail(f"pending-input hotfix marker is duplicated in {target}")
    syntax = subprocess.run(
        ["node", "--check", str(target)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if syntax.returncode != 0:
        fail(
            f"existing OpenClaw pending-input hotfix failed node --check for {target}: "
            f"{syntax.stderr.strip()}"
        )
    print(f"OpenClaw Codex pending-input hotfix already applied: {target}")
    raise SystemExit(0)

old_bridge = '''function createCodexUserInputBridge(params) {
\tlet pending;
\tconst resolvePending = (value) => {
\t\tconst current = pending;
\t\tif (!current) return;
\t\tpending = void 0;
\t\tcurrent.cleanup();
\t\tcurrent.resolve(value);
\t};
\treturn {
\t\tasync handleRequest(request) {
\t\t\tconst requestParams = readUserInputParams(request.params);
\t\t\tif (!requestParams) return;
\t\t\tif (requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId) return;
\t\t\tif (requestParams.questions.length === 0) return emptyUserInputResponse();
\t\t\tresolvePending(emptyUserInputResponse());
\t\t\treturn new Promise((resolve) => {
\t\t\t\tconst abortListener = () => resolvePending(emptyUserInputResponse());
\t\t\t\tconst cleanup = () => params.signal?.removeEventListener("abort", abortListener);
\t\t\t\tpending = {
\t\t\t\t\trequestId: request.id,
\t\t\t\t\tthreadId: requestParams.threadId,
\t\t\t\t\tturnId: requestParams.turnId,
\t\t\t\t\titemId: requestParams.itemId,
\t\t\t\t\tquestions: requestParams.questions,
\t\t\t\t\tresolve,
\t\t\t\t\tcleanup
\t\t\t\t};
\t\t\t\tparams.signal?.addEventListener("abort", abortListener, { once: true });
\t\t\t\tif (params.signal?.aborted) {
\t\t\t\t\tresolvePending(emptyUserInputResponse());
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tdeliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch((error) => {
\t\t\t\t\tlog.warn("failed to deliver codex user input prompt", { error });
\t\t\t\t});
\t\t\t});
\t\t},
\t\thandleQueuedMessage(text) {
\t\t\tconst current = pending;
\t\t\tif (!current) return false;
\t\t\tresolvePending(buildUserInputResponse(current.questions, text));
\t\t\treturn true;
\t\t},
\t\thandleNotification(notification) {
\t\t\tif (notification.method !== "serverRequest/resolved" || !pending) return;
\t\t\tconst notificationParams = isJsonObject(notification.params) ? notification.params : void 0;
\t\t\tconst requestId = notificationParams ? readRequestId(notificationParams) : void 0;
\t\t\tif (notificationParams && readString(notificationParams, "threadId") === pending.threadId && requestId !== void 0 && String(requestId) === String(pending.requestId)) resolvePending(emptyUserInputResponse());
\t\t},
\t\tcancelPending() {
\t\t\tresolvePending(emptyUserInputResponse());
\t\t}
\t};
}'''
old_bridge = old_bridge.replace(
    '\t\t\t\t\tlog.warn("failed to deliver codex user input prompt", { error });',
    f'\t\t\t\t\t{runtime_log_name}.warn("failed to deliver codex user input prompt", {{ error }});',
)

runtime_and_bridge = '''const BRIDGESLLM_PENDING_INPUT_HOTFIX_MARKER = "bridgesllm-openclaw-pending-input-v1";
const BRIDGESLLM_PENDING_INPUT_SYMBOL = Symbol.for("bridgesllm.openclaw.pending-input.v1");
const BRIDGESLLM_PENDING_INPUT_TTL_MS = 10 * 60 * 1e3;
const bridgesllmPendingInputRuns = /* @__PURE__ */ new Map();
function bridgesllmPendingInputText(value, maxLength) {
\treturn typeof value === "string" ? value.slice(0, maxLength) : "";
}
function bridgesllmPendingInputIdentity(value, maxLength) {
\treturn typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : void 0;
}
function bridgesllmPendingInputId(value) {
\tif (typeof value !== "string" && typeof value !== "number") return;
\tconst normalized = String(value);
\treturn normalized.length > 0 && normalized.length <= 512 ? normalized : void 0;
}
function bridgesllmSanitizePendingInputQuestions(questions) {
\tif (!Array.isArray(questions)) return [];
\treturn questions.slice(0, 20).map((question) => {
\t\tif (!question || typeof question !== "object") return;
\t\tconst id = bridgesllmPendingInputText(question.id, 256);
\t\tconst header = bridgesllmPendingInputText(question.header, 512);
\t\tconst prompt = bridgesllmPendingInputText(question.question, 8192);
\t\tif (!id || !header || !prompt) return;
\t\tconst options = Array.isArray(question.options) ? question.options.slice(0, 50).map((option) => {
\t\t\tif (!option || typeof option !== "object") return;
\t\t\tconst label = bridgesllmPendingInputText(option.label, 1024);
\t\t\tif (!label) return;
\t\t\treturn {
\t\t\t\tlabel,
\t\t\t\tdescription: bridgesllmPendingInputText(option.description, 4096)
\t\t\t};
\t\t}).filter(Boolean) : [];
\t\treturn {
\t\t\tid,
\t\t\theader,
\t\t\tquestion: prompt,
\t\t\tisOther: question.isOther === true,
\t\t\tisSecret: question.isSecret === true,
\t\t\toptions
\t\t};
\t}).filter(Boolean);
}
function bridgesllmPendingInputRunLookup(sessionId, expectedRunId) {
\tconst normalizedSessionId = bridgesllmPendingInputIdentity(sessionId, 1024);
\tconst normalizedRunId = bridgesllmPendingInputIdentity(expectedRunId, 512);
\tif (!normalizedSessionId || !normalizedRunId) return {
\t\tok: false,
\t\tcode: "INVALID_IDENTITY"
\t};
\tconst current = bridgesllmPendingInputRuns.get(normalizedSessionId);
\tif (!current) return {
\t\tok: false,
\t\tcode: "NO_ACTIVE_RUN"
\t};
\tif (current.runId !== normalizedRunId) return {
\t\tok: false,
\t\tcode: "RUN_MISMATCH"
\t};
\treturn {
\t\tok: true,
\t\trun: current
\t};
}
function bridgesllmRegisterPendingInputRun(params) {
\tconst sessionId = bridgesllmPendingInputIdentity(params?.sessionId, 1024);
\tconst sessionKey = bridgesllmPendingInputIdentity(params?.sessionKey, 2048);
\tconst runId = bridgesllmPendingInputIdentity(params?.runId, 512);
\tif (!sessionId || !sessionKey || !runId || !params?.bridge || typeof params.steer !== "function") throw new Error("invalid BridgesLLM pending-input run identity");
\tconst previous = bridgesllmPendingInputRuns.get(sessionId);
\tif (previous && previous.bridge !== params.bridge) previous.bridge.cancelPending();
\tbridgesllmPendingInputRuns.set(sessionId, {
\t\tsessionId,
\t\tsessionKey,
\t\trunId,
\t\tbridge: params.bridge,
\t\tsteer: params.steer
\t});
}
function bridgesllmUnregisterPendingInputRun(sessionId, expectedRunId, expectedBridge) {
\tconst lookup = bridgesllmPendingInputRunLookup(sessionId, expectedRunId);
\tif (!lookup.ok) return false;
\tif (lookup.run.bridge !== expectedBridge) return false;
\tbridgesllmPendingInputRuns.delete(lookup.run.sessionId);
\treturn true;
}
const bridgesllmPendingInputApi = Object.freeze({
\tversion: 1,
\tread(sessionId, expectedRunId) {
\t\tconst lookup = bridgesllmPendingInputRunLookup(sessionId, expectedRunId);
\t\treturn lookup.ok ? lookup.run.bridge.readPending() : null;
\t},
\tanswer(sessionId, expectedRunId, requestId, text) {
\t\tconst lookup = bridgesllmPendingInputRunLookup(sessionId, expectedRunId);
\t\tif (!lookup.ok) return lookup;
\t\tconst outcome = lookup.run.bridge.answerPending(requestId, text);
\t\treturn {
\t\t\t...outcome,
\t\t\trunId: lookup.run.runId
\t\t};
\t},
\tdismiss(sessionId, expectedRunId, requestId) {
\t\tconst lookup = bridgesllmPendingInputRunLookup(sessionId, expectedRunId);
\t\tif (!lookup.ok) return lookup;
\t\tconst outcome = lookup.run.bridge.dismissPending(requestId);
\t\treturn {
\t\t\t...outcome,
\t\t\trunId: lookup.run.runId
\t\t};
\t},
\tasync steer(sessionId, expectedRunId, text) {
\t\tconst lookup = bridgesllmPendingInputRunLookup(sessionId, expectedRunId);
\t\tif (!lookup.ok) return lookup;
\t\tif (typeof text !== "string" || text.length === 0 || text.length > 65536) return {
\t\t\tok: false,
\t\t\tcode: "INVALID_ANSWER",
\t\t\trunId: lookup.run.runId
\t\t};
\t\tif (lookup.run.bridge.readPending() !== null) return {
\t\t\tok: false,
\t\t\tcode: "PENDING_INPUT",
\t\t\trunId: lookup.run.runId
\t\t};
\t\ttry {
\t\t\tawait lookup.run.steer(text);
\t\t\treturn {
\t\t\t\tok: true,
\t\t\t\tcode: "STEERED",
\t\t\t\trunId: lookup.run.runId
\t\t\t};
\t\t} catch {
\t\t\treturn {
\t\t\t\tok: false,
\t\t\t\tcode: "QUEUE_REJECTED",
\t\t\t\trunId: lookup.run.runId
\t\t\t};
\t\t}
\t}
});
if (globalThis[BRIDGESLLM_PENDING_INPUT_SYMBOL] !== void 0) throw new Error("BridgesLLM pending-input runtime symbol is already registered");
Object.defineProperty(globalThis, BRIDGESLLM_PENDING_INPUT_SYMBOL, {
\tvalue: bridgesllmPendingInputApi,
\twritable: false,
\tconfigurable: false,
\tenumerable: false
});
function createCodexUserInputBridge(params) {
\tlet pending;
\tconst resolvePending = (value) => {
\t\tconst current = pending;
\t\tif (!current) return false;
\t\tpending = void 0;
\t\tcurrent.cleanup();
\t\tcurrent.resolve(value);
\t\treturn true;
\t};
\tconst readPending = () => {
\t\tconst current = pending;
\t\tif (!current) return null;
\t\tif (Date.now() >= current.expiresAt) {
\t\t\tresolvePending(emptyUserInputResponse());
\t\t\treturn null;
\t\t}
\t\treturn {
\t\t\trequestId: current.requestId,
\t\t\tquestions: bridgesllmSanitizePendingInputQuestions(current.questions),
\t\t\tcreatedAt: current.createdAt,
\t\t\texpiresAt: current.expiresAt,
\t\t\trunId: params.paramsForRun.runId
\t\t};
\t};
\tconst matchPending = (requestId) => {
\t\tconst current = pending;
\t\tif (!current) return {
\t\t\tok: false,
\t\t\tcode: "NO_PENDING_INPUT"
\t\t};
\t\tconst normalizedRequestId = bridgesllmPendingInputId(requestId);
\t\tif (!normalizedRequestId) return {
\t\t\tok: false,
\t\t\tcode: "INVALID_REQUEST_ID"
\t\t};
\t\tif (current.requestId !== normalizedRequestId) return {
\t\t\tok: false,
\t\t\tcode: "REQUEST_MISMATCH"
\t\t};
\t\tif (Date.now() >= current.expiresAt) {
\t\t\tresolvePending(emptyUserInputResponse());
\t\t\treturn {
\t\t\t\tok: false,
\t\t\t\tcode: "REQUEST_EXPIRED"
\t\t\t};
\t\t}
\t\treturn {
\t\t\tok: true,
\t\tcurrent
\t\t};
\t};
\treturn {
\t\tasync handleRequest(request) {
\t\t\tconst requestParams = readUserInputParams(request.params);
\t\t\tif (!requestParams) return;
\t\t\tif (requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId) return;
\t\t\tif (requestParams.questions.length === 0) return emptyUserInputResponse();
\t\t\tresolvePending(emptyUserInputResponse());
\t\t\treturn new Promise((resolve) => {
\t\t\t\tconst createdAt = Date.now();
\t\t\t\tconst abortListener = () => resolvePending(emptyUserInputResponse());
\t\t\t\tconst cleanup = () => {
\t\t\t\t\tparams.signal?.removeEventListener("abort", abortListener);
\t\t\t\t\tif (current.expiryTimer) clearTimeout(current.expiryTimer);
\t\t\t\t};
\t\t\t\tconst current = {
\t\t\t\t\trequestId: bridgesllmPendingInputId(request.id),
\t\t\t\t\tthreadId: requestParams.threadId,
\t\t\t\t\tturnId: requestParams.turnId,
\t\t\t\t\titemId: requestParams.itemId,
\t\t\t\t\tquestions: requestParams.questions,
\t\t\t\t\tcreatedAt,
\t\t\t\t\texpiresAt: createdAt + BRIDGESLLM_PENDING_INPUT_TTL_MS,
\t\t\t\t\texpiryTimer: void 0,
\t\t\t\t\tresolve,
\t\t\t\t\tcleanup
\t\t\t\t};
\t\t\t\tif (!current.requestId) {
\t\t\t\t\tresolve(emptyUserInputResponse());
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tpending = current;
\t\t\t\tcurrent.expiryTimer = setTimeout(() => {
\t\t\t\t\tif (pending === current) resolvePending(emptyUserInputResponse());
\t\t\t\t}, BRIDGESLLM_PENDING_INPUT_TTL_MS);
\t\t\t\tcurrent.expiryTimer.unref?.();
\t\t\t\tparams.signal?.addEventListener("abort", abortListener, { once: true });
\t\t\t\tif (params.signal?.aborted) {
\t\t\t\t\tresolvePending(emptyUserInputResponse());
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tdeliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch((error) => {
\t\t\t\t\tlog.warn("failed to deliver codex user input prompt", { error });
\t\t\t\t});
\t\t\t});
\t\t},
\t\treadPending,
\t\tanswerPending(requestId, text) {
\t\t\tif (typeof text !== "string" || text.length === 0 || text.length > 65536) return {
\t\t\t\tok: false,
\t\t\t\tcode: "INVALID_ANSWER"
\t\t\t};
\t\t\tconst match = matchPending(requestId);
\t\t\tif (!match.ok) return match;
\t\t\tresolvePending(buildUserInputResponse(match.current.questions, text));
\t\t\treturn {
\t\t\t\tok: true,
\t\t\t\tcode: "ANSWERED",
\t\t\t\trequestId: match.current.requestId
\t\t\t};
\t\t},
\t\tdismissPending(requestId) {
\t\t\tconst match = matchPending(requestId);
\t\t\tif (!match.ok) return match;
\t\t\tresolvePending(emptyUserInputResponse());
\t\t\treturn {
\t\t\t\tok: true,
\t\t\t\tcode: "DISMISSED",
\t\t\t\trequestId: match.current.requestId
\t\t\t};
\t\t},
\t\thandleQueuedMessage(text) {
\t\t\tconst current = pending;
\t\t\tif (!current) return false;
\t\t\treturn this.answerPending(current.requestId, text).ok;
\t\t},
\t\thandleNotification(notification) {
\t\t\tif (notification.method !== "serverRequest/resolved" || !pending) return;
\t\t\tconst notificationParams = isJsonObject(notification.params) ? notification.params : void 0;
\t\t\tconst requestId = notificationParams ? readRequestId(notificationParams) : void 0;
\t\t\tif (notificationParams && readString(notificationParams, "threadId") === pending.threadId && requestId !== void 0 && String(requestId) === String(pending.requestId)) resolvePending(emptyUserInputResponse());
\t\t},
\t\tcancelPending() {
\t\t\tresolvePending(emptyUserInputResponse());
\t\t}
\t};
}'''
runtime_and_bridge = runtime_and_bridge.replace(
    'Symbol.for("bridgesllm.openclaw.pending-input.v1")',
    f'Symbol.for("{runtime_symbol_name}")',
).replace(
    '\t\t\t\t\tlog.warn("failed to deliver codex user input prompt", { error });',
    f'\t\t\t\t\t{runtime_log_name}.warn("failed to deliver codex user input prompt", {{ error }});',
)

steering_queue_old = '''\treturn {
\t\tasync queue(text, options) {
\t\t\tif (params.answerPendingUserInput(text)) return;
\t\t\treturn await new Promise((resolve, reject) => {
\t\t\t\tbatchedTexts.push({
\t\t\t\t\ttext,
\t\t\t\t\tresolve,
\t\t\t\t\treject
\t\t\t\t});
\t\t\t\tclearBatchTimer();
\t\t\t\tconst debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
\t\t\t\tif (debounceMs === 0) {
\t\t\t\t\tflushBatch().catch(() => void 0);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbatchTimer = setTimeout(() => {
\t\t\t\t\tbatchTimer = void 0;
\t\t\t\t\tflushBatch().catch(() => void 0);
\t\t\t\t}, debounceMs);
\t\t\t});
\t\t},'''
steering_queue_new = '''\tconst steerOnly = async (text, options) => await new Promise((resolve, reject) => {
\t\tbatchedTexts.push({
\t\t\ttext,
\t\t\tresolve,
\t\t\treject
\t\t});
\t\tclearBatchTimer();
\t\tconst debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
\t\tif (debounceMs === 0) {
\t\t\tflushBatch().catch(() => void 0);
\t\t\treturn;
\t\t}
\t\tbatchTimer = setTimeout(() => {
\t\t\tbatchTimer = void 0;
\t\t\tflushBatch().catch(() => void 0);
\t\t}, debounceMs);
\t});
\treturn {
\t\tsteerOnly,
\t\tasync queue(text, options) {
\t\t\tif (params.answerPendingUserInput(text)) return;
\t\t\treturn await steerOnly(text, options);
\t\t},'''

registration_old = (
    "\tsetActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, "
    "params.sessionFile);"
)
registration_new = registration_old + '''
\tbridgesllmRegisterPendingInputRun({
\t\tsessionId: params.sessionId,
\t\tsessionKey: params.sessionKey,
\t\trunId: params.runId,
\t\tbridge: userInputBridgeRef.current,
\t\tsteer: (text) => activeSteeringQueue.steerOnly(text, { debounceMs: 0 })
\t});'''
cleanup_old = "\t\tuserInputBridgeRef.current?.cancelPending();"
cleanup_new = (
    "\t\tbridgesllmUnregisterPendingInputRun(params.sessionId, params.runId, userInputBridgeRef.current);\n"
    + cleanup_old
)

replacement_contracts = (
    (old_bridge, runtime_and_bridge, "Codex user-input bridge"),
    (steering_queue_old, steering_queue_new, "Codex steering-only queue"),
    (registration_old, registration_new, "active-run registration"),
    (cleanup_old, cleanup_new, "matching run cleanup"),
)
patched = original
for old, new, label in replacement_contracts:
    count = patched.count(old)
    if count != 1:
        fail(f"tested {label} source block count is {count}, expected exactly 1 in {target}")
    patched = patched.replace(old, new, 1)

missing_markers = [contract for contract in patched_contract if contract not in patched]
if missing_markers:
    fail("generated hotfix is missing contract markers: " + ", ".join(missing_markers))
if patched.count(hotfix_marker) != 1:
    fail("generated hotfix does not contain exactly one hotfix marker")
if old_bridge in patched:
    fail("generated hotfix retained the unpatched Codex user-input bridge")

backup = target.with_name(target.name + ".bridgesllm-pending-input-v1.bak")
if backup.exists():
    fail(f"refusing to overwrite pre-existing hotfix backup: {backup}")

target_mode = target.stat().st_mode & 0o7777
backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, target_mode)
try:
    with os.fdopen(backup_fd, "wb") as stream:
        stream.write(original.encode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())
except BaseException:
    try:
        backup.unlink()
    except FileNotFoundError:
        pass
    raise
shutil.copystat(target, backup, follow_symlinks=True)

temporary_name = ""
try:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=target.parent,
        prefix=f".{target.name}.bridgesllm-pending-input-",
        suffix=".js",
        delete=False,
    ) as stream:
        temporary_name = stream.name
        stream.write(patched)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary_name, target_mode)
    syntax = subprocess.run(
        ["node", "--check", temporary_name],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if syntax.returncode != 0:
        fail(
            f"generated OpenClaw hotfix failed node --check for {target}: "
            f"{syntax.stderr.strip()}"
        )
    os.replace(temporary_name, target)
    temporary_name = ""
    directory_fd = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    if temporary_name:
        try:
            Path(temporary_name).unlink()
        except FileNotFoundError:
            pass
    raise

print(f"patched OpenClaw Codex pending-input runtime: {target}")
print(f"preserved original bundle: {backup}")
PY
