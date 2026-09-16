import { M as resolveNonNegativeIntegerOption, d as asPositiveSafeInteger, j as resolveIntegerOption, l as asNonNegativeFiniteNumber, s as asFiniteNumber, u as asPositiveFiniteNumber } from "./number-coercion-CLj0HTDM.mjs";
import "./src-DqBJ2aW2.mjs";
import { i as estimateTokensFromChars, n as estimateStringChars } from "./cjk-chars-CGxY6W63.mjs";
import { t as expectDefined } from "./expect-CyE8FADM.mjs";
import { a as asOptionalRecord, c as isRecord } from "./record-coerce-DItp3I4t.mjs";
import { n as safeParseJsonRecord } from "./json-coercion-C7YSvZ9t.mjs";
import { l as normalizeOptionalString, m as readNonBlankString, o as normalizeLowercaseStringOrEmpty } from "./string-coerce-CIXf7egm.mjs";
import { r as truncateUtf16Safe } from "./utf16-slice-D_ngcYKd.mjs";
import { t as escapeRegExp } from "./regexp-BZyMFTlj.mjs";
import { T as parseAgentSessionKey, l as resolveAgentIdFromSessionKey } from "./session-key-DKGa_yQH.mjs";
import { t as pruneMapToMaxSize } from "./map-size-CNcWiFKu.mjs";
import { n as executeSqliteQuerySync, o as prepareSqliteQuerySync, r as executeSqliteQueryTakeFirstSync } from "./kysely-sync-CrjZjQJR.mjs";
import { t as readFileWindowFully } from "./file-read-DtMn74uz.mjs";
import { g as materializeSessionArchiveForRead } from "./artifacts-DtqiwyN1.mjs";
import "./internal-runtime-context-BXjd1Lya.mjs";
import { n as stripUserEnvelopeForDisplay, r as stripEnvelope, t as stripInternalMetadataForDisplay } from "./display-text-sanitize-J8UnEavN.mjs";
import { n as extractInboundSenderLabel } from "./strip-inbound-meta-BZvon-ll.mjs";
import "./gateway-error-details-Brpdn9L1.mjs";
import { r as jsonUtf8Bytes } from "./json-utf8-bytes-fm9i4b7G.mjs";
import { a as hasNonzeroUsage, c as normalizeUsage, r as deriveSessionTotalTokens } from "./usage-BpC2Ujh-.mjs";
import { t as classifyGatewayStorageFailure } from "./sqlite-error-diagnostics-DlXz_pSk.mjs";
import { n as estimateBase64DecodedBytes } from "./base64-Vw7DZYSc.mjs";
import { a as formatProviderRefusalText } from "./assistant-error-format-WGAOiV_E.mjs";
import { a as isContextOverflowError } from "./classify-CVG38hb4.mjs";
import { f as normalizeInputProvenance, l as isCompletionReportInputProvenance, m as stripInterSessionPromptPrefixForDisplay, n as INTER_SESSION_PROMPT_PREFIX_BASE } from "./input-provenance-UMbDpPc3.mjs";
import { t as readTranscriptSenderIdentity } from "./sender-identity-D7Vwbufc.mjs";
import { C as getActiveTranscriptKysely, Ct as MAX_VISIBLE_MESSAGE_MAX_MESSAGES, D as isSessionTranscriptProjectionUnavailableError, E as SessionTranscriptProjectionUnavailableError, M as resolveConcreteSessionStorePath, P as resolveSessionTranscriptReadTarget, S as resolveVisibleMessagePositions, T as withCurrentProjectionSnapshot, _ as hasUnindexedVisibleMessages, b as readVisibleMessageRange, c as readRecentSessionTranscriptMessageEvents, d as readSessionTranscriptBoundedMessageTailPage, g as assertVisibleMessageRangeJson, h as visitSessionTranscriptMessageEvents, p as readSessionTranscriptMessageEvents, v as iterateVisibleMessageRange, vt as createTranscriptRawDeltaCursor, w as readTranscriptProjectionGeneration, y as readVisibleMessageMetadata, yt as readTranscriptRawDelta } from "./session-accessor-CX17Bx59.mjs";
import { G as nestedToolActivityContent, L as resolveSqliteSessionTranscriptReadFence, q as readNestedToolActivity } from "./session-accessor.sqlite-transcript-store-RBMdNdp1.mjs";
import { t as STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared-sKH7NjHK.mjs";
import { a as readSessionTranscriptRunId } from "./transcript-events-BC3ypNYt.mjs";
import { l as selectSessionTranscriptActiveEntries } from "./transcript-tree-BP6KxL69.mjs";
import { a as parseAssistantTextSignature, s as resolveAssistantMessagePhase, t as extractAssistantPhaseText } from "./chat-message-content-CgaQZ9n2.mjs";
import { a as isOpenClawDeliveryMirrorAssistantMessage, s as isTranscriptOnlyOpenClawAssistantMessage } from "./transcript-only-openclaw-assistant-CVgy4bjA.mjs";
import { a as waitForSessionTranscriptProjection } from "./session-transcript-reconcile-B-848si5.mjs";
import { p as getUserProfileDisplay } from "./user-profiles-CPp6vNcy.mjs";
import { t as SessionManager } from "./session-manager-CU7DO_jo.mjs";
import { a as parseInboundMediaUri, n as buildInboundMediaUriFromPath } from "./media-reference-BLvkf0QS.mjs";
import { n as projectAssistantDisplayContent, r as readAssistantDisplayContent } from "./assistant-display-content-pm0dNX7M.mjs";
import { t as streamSessionTranscriptLines } from "./transcript-stream-BsQeU4s0.mjs";
import { n as HEARTBEAT_PROMPT } from "./heartbeat-CO9j0hWl.mjs";
import { t as renderAssistantRequestFailureCopy } from "./assistant-request-failure-copy-C-iNuKly.mjs";
import { n as isHeartbeatOkResponse, r as isHeartbeatUserMessage } from "./heartbeat-filter-Qof5WX1A.mjs";
import { t as flattenMarkdownToPlainText } from "./markdown-plain-text-BIBtRgN0.mjs";
import { n as isSuppressedControlReplyText, r as stripSuppressedControlReplyToken } from "./control-reply-text-BHWdTXsm.mjs";
import { a as resolveSessionTranscriptCandidates, o as resolveSessionTranscriptResetArchiveCandidatesAsync } from "./session-transcript-files.fs-edYnkOdL.mjs";
import { C as shouldPreserveAssistantControlReplyText, D as truncateChatHistoryText, E as takeAssistantManagedMediaUrlsForDisplay, T as stripPrivateToolCallContextForDisplay, _ as isAssistantInternalReasoningContentType, b as isProjectedSessionsSendForwardedMessage, c as messageHasToolResultShape, d as asRoleContentMessage, f as extractAssistantTextForSilentCheck, g as hasTranscriptMediaFacts, h as hasAssistantNonTextContent, i as extractChatHistoryBlockText, l as projectToolResultDetails, m as hasAssistantDisplayableNonTextContent, o as isToolHistoryBlockType, p as extractProjectedText, s as isToolResultHistoryBlockType, u as DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS, v as isAssistantTextContentType, w as stripAssistantMediaDirectivesForDisplay, x as isSessionsSendInterSessionUserMessage, y as isEmptyTextOnlyContent } from "./chat-display-projection.canvas-DHUrTmKK.mjs";
import { a as projectWorkspaceResultConflict } from "./workspace-conflicts-CQVfTI04.mjs";
import { c as buildControlUiUserAvatarPath } from "./control-ui-contract-DWjZVUMo.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sql } from "kysely";
//#region src/sessions/transcript-visible-record.ts
function isVisibleTranscriptRecord(value) {
	const record = asOptionalRecord(value);
	return Boolean(record?.message) || record?.type === "compaction" || record?.type === "reset";
}
//#endregion
//#region src/gateway/chat-sanitize.ts
function extractMessageSenderLabel(entry) {
	if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) return entry.senderLabel.trim();
	if (typeof entry.content === "string") return extractInboundSenderLabel(entry.content);
	if (Array.isArray(entry.content)) for (const item of entry.content) {
		if (!item || typeof item !== "object") continue;
		const text = item.text;
		if (typeof text !== "string") continue;
		const senderLabel = extractInboundSenderLabel(text);
		if (senderLabel) return senderLabel;
	}
	if (typeof entry.text === "string") return extractInboundSenderLabel(entry.text);
	return null;
}
function stripEnvelopeFromContentWithRole(content, role) {
	const stripUserEnvelope = role === "user";
	let next;
	for (let index = 0; index < content.length; index++) {
		const item = content[index];
		if (!item || typeof item !== "object") continue;
		const entry = item;
		if (!(entry.type === "text" || role === "user" && entry.type === "input_text" || role === "assistant" && (entry.type === "input_text" || entry.type === "output_text")) || typeof entry.text !== "string") continue;
		const stripped = stripUserEnvelope ? stripUserEnvelopeForDisplay(entry.text) : stripInternalMetadataForDisplay(entry.text);
		if (stripped === entry.text) continue;
		next ??= content.slice();
		next[index] = {
			...entry,
			text: stripped
		};
	}
	return next ?? content;
}
/** Strips OpenClaw envelope metadata from one display message without mutating it. */
function stripEnvelopeFromMessage(message) {
	if (!message || typeof message !== "object") return message;
	const entry = message;
	const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
	const stripUserEnvelope = role === "user";
	let next;
	const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
	if (senderLabel && entry.senderLabel !== senderLabel) next = {
		...entry,
		senderLabel
	};
	if (typeof entry.content === "string") {
		const stripped = stripUserEnvelope ? stripUserEnvelopeForDisplay(entry.content) : stripInternalMetadataForDisplay(entry.content);
		if (stripped !== entry.content) {
			next ??= { ...entry };
			next.content = stripped;
		}
	} else if (Array.isArray(entry.content)) {
		const updated = stripEnvelopeFromContentWithRole(entry.content, role);
		if (updated !== entry.content) {
			next ??= { ...entry };
			next.content = updated;
		}
	} else if (typeof entry.text === "string") {
		const stripped = stripUserEnvelope ? stripUserEnvelopeForDisplay(entry.text) : stripInternalMetadataForDisplay(entry.text);
		if (stripped !== entry.text) {
			next ??= { ...entry };
			next.text = stripped;
		}
	}
	return next ?? message;
}
/** Strips envelope metadata from a message array, preserving the original array when unchanged. */
function stripEnvelopeFromMessages(messages) {
	let next;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const stripped = stripEnvelopeFromMessage(message);
		if (stripped !== message) {
			next ??= messages.slice();
			next[index] = stripped;
		}
	}
	return next ?? messages;
}
//#endregion
//#region src/gateway/session-display-projection.ts
const SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS = 240;
const SESSION_DISPLAY_PROJECTION_MAX_CHARS = 800;
function extractUserText(message) {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const parts = message.content.flatMap((block) => {
			const entry = asOptionalRecord(block);
			if (!entry) return [];
			return (entry.type === "text" || entry.type === "input_text") && typeof entry.text === "string" ? [entry.text] : [];
		});
		if (parts.length > 0) return parts.join("\n");
	}
	return typeof message.text === "string" ? message.text : void 0;
}
/** Projects text after model-context selection, or applies ordinary display visibility. */
function projectSessionDisplayMessage(message, options = {}) {
	const entry = asOptionalRecord(message);
	if (!entry || options.view !== "model-context" && entry.display === false) return null;
	const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
	if (role !== "user" && role !== "assistant") return null;
	let text = (role === "assistant" ? extractAssistantPhaseText(entry) : extractUserText(entry))?.trim();
	if (!text || role === "assistant" && isSuppressedControlReplyText(text)) return null;
	if (role === "user") text = stripEnvelope(text).trim();
	if (options.flattenMarkdown) text = flattenMarkdownToPlainText(text);
	if (!text) return null;
	const requestedMaxChars = options.maxChars ?? SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS;
	const limit = Math.min(SESSION_DISPLAY_PROJECTION_MAX_CHARS, Math.max(20, Math.floor(requestedMaxChars)));
	return {
		role,
		text: text.length <= limit ? text : `${truncateUtf16Safe(text, limit - 3)}...`
	};
}
//#endregion
//#region src/gateway/session-transcript-derived-readers.ts
function extractTranscriptUsageSnapshot(message, source) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return null;
	const record = message;
	if (source === "artifact" && typeof record.role === "string" && record.role !== "assistant") return null;
	const usageRaw = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage) ? record.usage : void 0;
	const usage = normalizeUsage(usageRaw);
	const normalizedUsage = usage ?? {};
	const legacyCliUsage = (source === "artifact" && typeof record.api === "string" ? record.api.trim() : record.api) === "cli" && usageRaw && usageRaw.contextUsage === void 0;
	const derivedTotalTokens = legacyCliUsage ? void 0 : deriveSessionTotalTokens({ usage });
	const totalTokens = source === "artifact" ? asPositiveFiniteNumber(derivedTotalTokens) : derivedTotalTokens;
	const modelProvider = typeof record.provider === "string" ? record.provider.trim() : void 0;
	const model = typeof record.model === "string" ? record.model.trim() : void 0;
	const costUsd = source === "artifact" ? asNonNegativeFiniteNumber(usageRaw?.cost?.total) : typeof usageRaw?.cost?.total === "number" && Number.isFinite(usageRaw.cost.total) ? usageRaw.cost.total : usageRaw?.costUsd;
	const hasMeaningfulUsage = hasNonzeroUsage(usage) || typeof totalTokens === "number" || typeof costUsd === "number" && Number.isFinite(costUsd) && (source === "artifact" || costUsd > 0);
	const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
	if (!hasMeaningfulUsage && !modelProvider && !model) return null;
	if (isDeliveryMirror && !hasMeaningfulUsage) return null;
	return {
		...!isDeliveryMirror && modelProvider ? { modelProvider } : {},
		...!isDeliveryMirror && model ? { model } : {},
		...typeof normalizedUsage.input === "number" ? { inputTokens: normalizedUsage.input } : {},
		...typeof normalizedUsage.output === "number" ? { outputTokens: normalizedUsage.output } : {},
		...typeof normalizedUsage.cacheRead === "number" ? { cacheRead: normalizedUsage.cacheRead } : {},
		...typeof normalizedUsage.cacheWrite === "number" ? { cacheWrite: normalizedUsage.cacheWrite } : {},
		...legacyCliUsage ? { contextUsage: { state: "unavailable" } } : normalizedUsage.contextUsage ? { contextUsage: normalizedUsage.contextUsage } : {},
		...typeof totalTokens === "number" ? {
			totalTokens,
			totalTokensFresh: true
		} : {},
		...typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}
	};
}
function estimateTranscriptMessageChars(message) {
	if (!isRecord(message)) return 0;
	const content = message.content;
	if (typeof content === "string") return content.trim() ? estimateStringChars(content.trim()) : 0;
	if (!Array.isArray(content)) return 0;
	return content.reduce((total, part) => {
		if (!isRecord(part)) return total;
		const { text, type } = part;
		if (typeof text !== "string" || typeof type === "string" && type !== "text" && type !== "output_text" && type !== "input_text") return total;
		const normalized = text.trim();
		return normalized ? total + estimateStringChars(normalized) : total;
	}, 0);
}
function aggregateSessionTranscriptUsage(messages, source = "sqlite") {
	const aggregate = {};
	let sawUsage = false;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let costUsd = 0;
	let sawInput = false;
	let sawOutput = false;
	let sawCacheRead = false;
	let sawCacheWrite = false;
	let sawCost = false;
	let estimatedTranscriptChars = 0;
	let sawEstimateModelIdentity = false;
	for (const message of messages) {
		if (source === "artifact" && isRecord(message)) {
			const provider = typeof message.provider === "string" ? message.provider.trim() : void 0;
			const model = typeof message.model === "string" ? message.model.trim() : void 0;
			if ((message.role === "user" || message.role === "assistant") && !(message.role === "assistant" && provider === "openclaw" && model === "delivery-mirror")) {
				const estimatedChars = estimateTranscriptMessageChars(message);
				estimatedTranscriptChars += estimatedChars;
				sawEstimateModelIdentity ||= message.role === "assistant" && estimatedChars > 0 && Boolean(provider || model);
			}
		}
		const snapshot = extractTranscriptUsageSnapshot(message, source);
		if (!snapshot) continue;
		sawUsage = true;
		if (snapshot.modelProvider) aggregate.modelProvider = snapshot.modelProvider;
		if (snapshot.model) aggregate.model = snapshot.model;
		if (typeof snapshot.inputTokens === "number") {
			inputTokens += snapshot.inputTokens;
			sawInput = true;
		}
		if (typeof snapshot.outputTokens === "number") {
			outputTokens += snapshot.outputTokens;
			sawOutput = true;
		}
		if (typeof snapshot.cacheRead === "number") {
			cacheRead += snapshot.cacheRead;
			sawCacheRead = true;
		}
		if (typeof snapshot.cacheWrite === "number") {
			cacheWrite += snapshot.cacheWrite;
			sawCacheWrite = true;
		}
		if (snapshot.contextUsage) aggregate.contextUsage = snapshot.contextUsage;
		else if (typeof snapshot.totalTokens === "number") delete aggregate.contextUsage;
		if (snapshot.contextUsage?.state === "unavailable") {
			delete aggregate.totalTokens;
			delete aggregate.totalTokensFresh;
		} else if (typeof snapshot.totalTokens === "number") {
			aggregate.totalTokens = snapshot.totalTokens;
			aggregate.totalTokensFresh = true;
		}
		if (typeof snapshot.costUsd === "number") {
			costUsd += snapshot.costUsd;
			sawCost = true;
		}
	}
	if (!sawUsage) return null;
	if (sawInput) aggregate.inputTokens = inputTokens;
	if (sawOutput) aggregate.outputTokens = outputTokens;
	if (sawCacheRead) aggregate.cacheRead = cacheRead;
	if (sawCacheWrite) aggregate.cacheWrite = cacheWrite;
	if (sawCost) aggregate.costUsd = costUsd;
	if (source === "artifact" && typeof aggregate.totalTokens !== "number" && aggregate.contextUsage?.state !== "unavailable" && estimatedTranscriptChars > 0 && sawEstimateModelIdentity) {
		const estimatedTotalTokens = estimateTokensFromChars(estimatedTranscriptChars);
		if (estimatedTotalTokens > 0) {
			aggregate.totalTokens = estimatedTotalTokens;
			aggregate.totalTokensFresh = true;
		}
	}
	return aggregate;
}
//#endregion
//#region src/sessions/transcript-display-position.ts
/** Keep source namespaces and rewrite generations separate without exposing storage paths. */
function createTranscriptDisplaySource(parts) {
	return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}
function createTranscriptDisplayPosition(source, rawSeq, message, entrySeq) {
	return createTranscriptDisplayPositionFromActivity(source, rawSeq, readNestedToolActivity(message)?.details, entrySeq);
}
/** Archive indexes retain validated placement facts without retaining tool input/output. */
function createTranscriptDisplayPositionFromActivity(source, rawSeq, activity, entrySeq) {
	const position = {
		source,
		rawSeq
	};
	if (!activity) return position;
	const { afterEntryId, scopeId, startOrder } = activity;
	const afterRawSeq = afterEntryId === null ? null : entrySeq(afterEntryId);
	if (afterRawSeq === null || afterRawSeq !== void 0 && afterRawSeq < rawSeq) position.activity = {
		afterRawSeq,
		scopeId,
		startOrder
	};
	return position;
}
//#endregion
//#region src/gateway/session-transcript-json.ts
/** Reads a nonblank transcript field while preserving its original whitespace. */
function readNonBlankStringPreservingWhitespace(value) {
	return readNonBlankString(value);
}
const TRANSCRIPT_FIELD_REGEX_CACHE = /* @__PURE__ */ new Map();
function getTranscriptFieldRegexes(field) {
	let cached = TRANSCRIPT_FIELD_REGEX_CACHE.get(field);
	if (!cached) {
		const escapedField = escapeRegExp(field);
		cached = {
			stringRe: new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`),
			nullRe: new RegExp(`"${escapedField}"\\s*:\\s*null`),
			numberRe: new RegExp(`"${escapedField}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`)
		};
		TRANSCRIPT_FIELD_REGEX_CACHE.set(field, cached);
	}
	return cached;
}
function extractJsonStringFieldPrefix(prefix, field) {
	const match = getTranscriptFieldRegexes(field).stringRe.exec(prefix);
	if (!match) return;
	try {
		return readNonBlankStringPreservingWhitespace(JSON.parse(`"${match[1]}"`));
	} catch {
		return;
	}
}
function extractJsonNullableStringFieldPrefix(prefix, field) {
	if (getTranscriptFieldRegexes(field).nullRe.test(prefix)) return null;
	return extractJsonStringFieldPrefix(prefix, field);
}
function extractJsonNumberFieldPrefix(prefix, field) {
	const match = getTranscriptFieldRegexes(field).numberRe.exec(prefix);
	if (!match) return;
	const decoded = Number(match[1]);
	return Number.isFinite(decoded) ? decoded : void 0;
}
//#endregion
//#region src/gateway/session-transcript-record-parser.ts
const MAX_TRANSCRIPT_PARSE_LINE_BYTES = 262144;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 65536;
const OVERSIZED_TRANSCRIPT_METADATA_SUFFIX_CHARS = 65536;
const MAX_OVERSIZED_TRANSCRIPT_RECOVERY_CANDIDATES = 32;
const TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER = "[chat.history omitted: message too large]";
function isOversizedTranscriptLine(line) {
	return Buffer.byteLength(line, "utf8") > MAX_TRANSCRIPT_PARSE_LINE_BYTES;
}
function isJsonObjectFieldToken(source, tokenIndex) {
	for (let index = tokenIndex - 1; index >= 0; index--) {
		const char = source.charAt(index);
		if (/\s/.test(char)) continue;
		return char === "{" || char === ",";
	}
	return true;
}
function extractJsonStringFieldWindow(source, field, startIndex = 0, endIndex = source.length) {
	const fieldToken = JSON.stringify(field);
	let searchIndex = startIndex;
	while (searchIndex < endIndex) {
		const tokenIndex = source.indexOf(fieldToken, searchIndex);
		if (tokenIndex < 0 || tokenIndex >= endIndex) return;
		searchIndex = tokenIndex + fieldToken.length;
		if (!isJsonObjectFieldToken(source, tokenIndex)) continue;
		const match = /^\s*:\s*"((?:\\.|[^"\\])*)"/.exec(source.slice(searchIndex, endIndex));
		if (!match) continue;
		try {
			return readNonBlankStringPreservingWhitespace(JSON.parse(`"${match[1]}"`));
		} catch {
			return;
		}
	}
}
function extractJsonStringFieldSuffix(source, field) {
	return extractJsonStringFieldWindow(source, field, Math.max(0, source.length - OVERSIZED_TRANSCRIPT_METADATA_SUFFIX_CHARS));
}
function recoverOversizedMultimodalTranscriptRecord(line) {
	const markerPrefix = "__openclaw_omitted_image_";
	if (line.includes(markerPrefix)) return;
	const payloads = [];
	const dataPattern = /"data"\s*:\s*"/g;
	let scannedCandidates = 0;
	for (let dataMatch = dataPattern.exec(line); dataMatch; dataMatch = dataPattern.exec(line)) {
		if (!isJsonObjectFieldToken(line, dataMatch.index)) continue;
		if (++scannedCandidates > MAX_OVERSIZED_TRANSCRIPT_RECOVERY_CANDIDATES) return;
		const start = dataMatch.index + dataMatch[0].length;
		let end = start;
		let padding = 0;
		let valid = true;
		for (; end < line.length && line.charCodeAt(end) !== 34; end++) {
			const code = line.charCodeAt(end);
			if (code === 92) {
				valid = false;
				end++;
				continue;
			}
			if (!valid) continue;
			if (code === 61) {
				if (++padding > 2) valid = false;
			} else if (padding > 0 || ((code | 32) < 97 || (code | 32) > 122) && (code < 48 || code > 57) && code !== 43 && code !== 47) valid = false;
		}
		if (end >= line.length) return;
		dataPattern.lastIndex = end + 1;
		if (!valid || (end - start) % 4 !== 0) continue;
		payloads.push({
			start,
			end,
			marker: `${markerPrefix}${payloads.length}__`,
			bytes: (end - start) * 3 / 4 - padding
		});
	}
	if (payloads.length === 0) return;
	try {
		const parseBoundedRedaction = (selected) => {
			const bytes = selected.reduce((remaining, payload) => remaining - (payload.end - payload.start - payload.marker.length), Buffer.byteLength(line, "utf8"));
			if (selected.length === 0 || bytes > 262144) return;
			let cursor = 0;
			const parts = [];
			for (const payload of selected) {
				parts.push(line.slice(cursor, payload.start), payload.marker);
				cursor = payload.end;
			}
			parts.push(line.slice(cursor));
			const markers = new Set(selected.map((payload) => payload.marker));
			const parsed = JSON.parse(parts.join(""), (_key, value) => {
				if (typeof value === "string" && value.startsWith(markerPrefix) && !markers.delete(value)) throw new Error("invalid transcript image recovery marker");
				return value;
			});
			if (markers.size > 0 || !isRecord(parsed)) return;
			return parsed;
		};
		const imageDataOwners = (block) => {
			const source = asOptionalRecord(block.source);
			return source?.type === "base64" ? [block, source] : [block];
		};
		const preview = parseBoundedRedaction(payloads);
		const previewContent = asOptionalRecord(preview?.message)?.content;
		if (!Array.isArray(previewContent)) return;
		const payloadByMarker = new Map(payloads.map((payload) => [payload.marker, payload]));
		const imageMarkers = /* @__PURE__ */ new Set();
		for (const candidate of previewContent) {
			if (!isRecord(candidate) || candidate.type !== "image") continue;
			for (const owner of imageDataOwners(candidate)) {
				if (typeof owner.data !== "string") continue;
				if (!payloadByMarker.has(owner.data) || imageMarkers.has(owner.data)) return;
				imageMarkers.add(owner.data);
			}
		}
		if (imageMarkers.size === 0) return;
		const imagePayloads = payloads.filter((payload) => imageMarkers.has(payload.marker));
		const record = parseBoundedRedaction(imagePayloads);
		const content = asOptionalRecord(record?.message)?.content;
		if (!record || !Array.isArray(content)) return;
		const remaining = new Map(imagePayloads.map((payload) => [payload.marker, payload]));
		for (const block of content) {
			if (!isRecord(block) || block.type !== "image") continue;
			let imageBytes;
			for (const owner of imageDataOwners(block)) {
				if (typeof owner.data !== "string") continue;
				const payload = remaining.get(owner.data);
				if (!payload) return;
				remaining.delete(payload.marker);
				imageBytes ??= payload.bytes;
				delete owner.data;
			}
			if (imageBytes !== void 0) {
				block.omitted = true;
				block.bytes = imageBytes;
			}
		}
		return remaining.size === 0 && jsonUtf8Bytes(record) <= 262144 ? record : void 0;
	} catch {
		return;
	}
}
function parseTranscriptRecord(line) {
	const oversized = isOversizedTranscriptLine(line);
	const recoveredRecord = oversized ? recoverOversizedMultimodalTranscriptRecord(line) : void 0;
	if (!oversized || recoveredRecord) try {
		const record = recoveredRecord ?? JSON.parse(line);
		if (!isRecord(record)) return null;
		const id = readNonBlankStringPreservingWhitespace(record.id);
		return {
			byteLength: Buffer.byteLength(line, "utf8"),
			...id ? { id } : {},
			...recoveredRecord ? { recoveredImageData: true } : {},
			record
		};
	} catch {
		return null;
	}
	const prefix = line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
	const messageMatch = /"message"\s*:/.exec(prefix);
	const recordPrefix = messageMatch ? prefix.slice(0, messageMatch.index) : prefix;
	const id = extractJsonStringFieldPrefix(prefix, "id");
	const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
	const type = extractJsonStringFieldPrefix(prefix, "type");
	const timestamp = extractJsonStringFieldPrefix(recordPrefix, "timestamp") ?? extractJsonNumberFieldPrefix(recordPrefix, "timestamp");
	const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
	const idempotencyKey = extractJsonStringFieldPrefix(prefix, "idempotencyKey") ?? extractJsonStringFieldSuffix(line, "idempotencyKey");
	const record = {
		...type ? { type } : {},
		...id ? { id } : {},
		...parentId !== void 0 ? { parentId } : {},
		...timestamp !== void 0 ? { timestamp } : {},
		message: {
			role,
			...idempotencyKey ? { idempotencyKey } : {},
			content: [{
				type: "text",
				text: TRANSCRIPT_OVERSIZED_MESSAGE_PLACEHOLDER
			}],
			__openclaw: {
				truncated: true,
				reason: "oversized"
			}
		}
	};
	return {
		byteLength: Buffer.byteLength(line, "utf8"),
		...id ? { id } : {},
		record
	};
}
//#endregion
//#region src/gateway/session-transcript-index.fs.ts
const transcriptIndexes = /* @__PURE__ */ new Map();
const MAX_TRANSCRIPT_INDEXES = 256;
const ARCHIVE_READ_BYTES = 65536;
const ARCHIVE_BATCH_BYTES = 1048576;
function transcriptArtifactDisplaySource(filePath, stat) {
	return createTranscriptDisplaySource([
		"archive",
		filePath,
		`${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`
	]);
}
function assertArchiveTranscriptSource(filePath, stat, displaySource, sessionId) {
	if (transcriptArtifactDisplaySource(filePath, stat) !== displaySource) throw new SessionTranscriptProjectionUnavailableError(sessionId);
}
function selectArchiveTranscriptEntries(records, failClosedOnInvalidLeafControl = false) {
	const entries = selectSessionTranscriptActiveEntries({
		entries: records,
		recordOf: (entry) => entry.record,
		failClosedOnInvalidLeafControl
	});
	const boundaryIndex = entries.findLastIndex(({ record }) => {
		return record.type === "compaction" || record.type === "reset";
	});
	if (boundaryIndex < 0 || entries[boundaryIndex]?.record.type !== "reset") return entries;
	const firstKeptEntryId = entries[boundaryIndex]?.record.firstKeptEntryId;
	const firstKeptIndex = typeof firstKeptEntryId === "string" ? entries.findIndex((entry, index) => index < boundaryIndex && entry.id === firstKeptEntryId) : -1;
	return [...firstKeptIndex < 0 ? [] : entries.slice(firstKeptIndex, boundaryIndex).filter(({ record }) => {
		const role = asOptionalRecord(record.message)?.role;
		return role === "user" || role === "assistant";
	}), ...entries.slice(boundaryIndex)];
}
async function* readArchiveLines(filePath, handle) {
	const stream = fs.createReadStream(filePath, {
		fd: handle,
		autoClose: false,
		highWaterMark: ARCHIVE_READ_BYTES
	});
	let offset = 0;
	let length = 0;
	let afterCr = false;
	const fragments = [];
	try {
		for await (const chunk of stream) {
			let start = 0;
			if (afterCr && chunk[0] === 10) {
				start = 1;
				offset++;
			}
			afterCr = false;
			while (start < chunk.length) {
				const lf = chunk.indexOf(10, start);
				const cr = chunk.indexOf(13, start);
				const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
				if (end < 0) {
					fragments.push(chunk.subarray(start));
					length += chunk.length - start;
					break;
				}
				const last = chunk.subarray(start, end);
				length += last.length;
				yield {
					line: (fragments.length ? Buffer.concat([...fragments, last], length) : last).toString("utf8"),
					offset,
					length
				};
				fragments.length = 0;
				offset += length + 1;
				length = 0;
				start = end + 1;
				if (chunk[end] === 13) {
					if (chunk[start] === 10) {
						start++;
						offset++;
					} else afterCr = start === chunk.length;
				}
			}
		}
		if (length > 0) yield {
			line: Buffer.concat(fragments, length).toString("utf8"),
			offset,
			length
		};
	} finally {
		if (!stream.readableEnded) stream.destroy();
	}
}
function archiveNavigationRecord(record) {
	const navigation = {};
	for (const key of [
		"id",
		"type",
		"parentId",
		"targetId",
		"appendParentId",
		"appendMode",
		"firstKeptEntryId"
	]) if (Object.hasOwn(record, key)) {
		const value = record[key];
		navigation[key] = typeof value === "string" || value === null ? value : false;
	}
	const role = asOptionalRecord(record.message)?.role;
	navigation.message = record.message ? { role: role === "user" || role === "assistant" ? role : void 0 } : false;
	return navigation;
}
async function buildSessionTranscriptIndex(filePath, displaySource, sessionId) {
	const records = [];
	const rawSeqById = /* @__PURE__ */ new Map();
	const handle = await fs.promises.open(filePath, "r");
	try {
		assertArchiveTranscriptSource(filePath, await handle.stat(), displaySource, sessionId);
		for await (const { line, offset, length } of readArchiveLines(filePath, handle)) {
			if (!line.trim()) continue;
			const record = parseTranscriptRecord(line);
			if (record) {
				const rawSeq = records.length + 1;
				const activity = readNestedToolActivity(record.record.message)?.details;
				records.push({
					...record,
					record: archiveNavigationRecord(record.record),
					rawSeq,
					offset,
					length,
					...activity ? { activity: {
						afterEntryId: activity.afterEntryId,
						scopeId: activity.scopeId,
						startOrder: activity.startOrder
					} } : {}
				});
				if (record.id) rawSeqById.set(record.id, rawSeq);
			}
		}
		assertArchiveTranscriptSource(filePath, await handle.stat(), displaySource, sessionId);
	} finally {
		await handle.close();
	}
	const entries = selectArchiveTranscriptEntries(records).filter((entry) => isVisibleTranscriptRecord(entry.record)).map((entry, index) => ({
		id: entry.id,
		rawId: typeof entry.record.id === "string" ? entry.record.id : void 0,
		offset: entry.offset,
		length: entry.length,
		seq: index + 1,
		transcriptPosition: createTranscriptDisplayPositionFromActivity(displaySource, entry.rawSeq, entry.activity, (id) => rawSeqById.get(id))
	}));
	return {
		entries,
		byId: new Map(entries.flatMap((entry) => entry.id ? [[entry.id, entry]] : [])),
		displaySource
	};
}
/** Read selected payloads in bounded asynchronous batches; the cache owns no payload objects. */
async function readIndexedTranscriptEntries(filePath, index, selected, sessionId) {
	const handle = await fs.promises.open(filePath, "r");
	try {
		assertArchiveTranscriptSource(filePath, await handle.stat(), index.displaySource, sessionId);
		const physical = selected.map((entry, order) => ({
			entry,
			order
		})).toSorted((left, right) => left.entry.offset - right.entry.offset);
		const result = [];
		for (let start = 0; start < physical.length;) {
			const first = physical[start].entry;
			let end = start + 1;
			let byteEnd = first.offset + first.length;
			while (end < physical.length) {
				const next = physical[end].entry;
				if (next.offset + next.length - first.offset > ARCHIVE_BATCH_BYTES) break;
				byteEnd = Math.max(byteEnd, next.offset + next.length);
				end++;
			}
			const buffer = Buffer.allocUnsafe(byteEnd - first.offset);
			if (await readFileWindowFully(handle, buffer, first.offset) !== buffer.length) throw new SessionTranscriptProjectionUnavailableError(sessionId);
			for (let position = start; position < end; position++) {
				const { entry, order } = physical[position];
				const relative = entry.offset - first.offset;
				const parsed = parseTranscriptRecord(buffer.toString("utf8", relative, relative + entry.length));
				if (!parsed) throw new SessionTranscriptProjectionUnavailableError(sessionId);
				result[order] = {
					...entry,
					...parsed
				};
			}
			start = end;
		}
		assertArchiveTranscriptSource(filePath, await handle.stat(), index.displaySource, sessionId);
		return result;
	} finally {
		await handle.close();
	}
}
async function readSessionTranscriptIndex(filePath, sessionId) {
	const stat = await fs.promises.stat(filePath).catch(() => null);
	if (!stat?.isFile()) {
		transcriptIndexes.delete(filePath);
		return null;
	}
	const identity = transcriptArtifactDisplaySource(filePath, stat);
	let cached = transcriptIndexes.get(filePath);
	if (cached?.identity !== identity) cached = {
		identity,
		value: buildSessionTranscriptIndex(filePath, identity, sessionId)
	};
	transcriptIndexes.delete(filePath);
	transcriptIndexes.set(filePath, cached);
	pruneMapToMaxSize(transcriptIndexes, MAX_TRANSCRIPT_INDEXES);
	try {
		return await cached.value;
	} catch (error) {
		if (transcriptIndexes.get(filePath) === cached) transcriptIndexes.delete(filePath);
		throw error;
	}
}
//#endregion
//#region src/gateway/chat-display-projection.history.ts
function readTtsSupplementMarker(message) {
	const marker = asOptionalRecord(message.openclawTtsSupplement);
	if (!marker) return;
	const textSha256 = typeof marker.textSha256 === "string" && marker.textSha256.trim() ? marker.textSha256.trim() : void 0;
	const spokenText = typeof marker.spokenText === "string" && marker.spokenText.trim() ? marker.spokenText.trim() : void 0;
	return textSha256 || spokenText ? {
		textSha256,
		spokenText
	} : void 0;
}
function readAssistantTtsSupplementMarker(message) {
	const marker = readTtsSupplementMarker(message);
	if (!marker || asRoleContentMessage(message)?.role !== "assistant") return;
	const content = message.content;
	if (!Array.isArray(content)) return;
	let hasSupplementBlock = false;
	for (const block of content) {
		const record = asOptionalRecord(block);
		if (!record) continue;
		if (record.type !== "text") {
			hasSupplementBlock = true;
			continue;
		}
		const text = typeof record.text === "string" ? record.text.trim() : "";
		if (text && text !== "Audio reply") return;
	}
	return hasSupplementBlock ? marker : void 0;
}
function readTtsSupplementTargetText(message) {
	return asRoleContentMessage(message)?.role === "assistant" && !isProjectedSessionsSendForwardedMessage(message) && !readTtsSupplementMarker(message) ? extractProjectedText(message.content ?? message.text).trim() : "";
}
function mergeTtsSupplementContent(target, supplement) {
	const supplementBlocks = Array.isArray(supplement.content) ? supplement.content.filter((block) => {
		const record = asOptionalRecord(block);
		return record !== void 0 && record.type !== "text";
	}) : [];
	if (supplementBlocks.length === 0) return target;
	const targetContent = target.content;
	if (Array.isArray(targetContent)) return {
		...target,
		content: [...targetContent, ...supplementBlocks]
	};
	const targetText = extractProjectedText(targetContent ?? target.text).trim();
	return {
		...target,
		content: [...targetText ? [{
			type: "text",
			text: targetText
		}] : [], ...supplementBlocks]
	};
}
function mergeTtsSupplementMessages(messages) {
	if (!messages.some(readAssistantTtsSupplementMarker)) return messages;
	const targetTexts = [];
	const targetHashes = [];
	const merged = [];
	let changed = false;
	for (const message of messages) {
		const marker = readAssistantTtsSupplementMarker(message);
		if (marker) {
			let targetIndex = -1;
			for (let i = merged.length - 1; i >= 0; i--) {
				const candidate = merged[i];
				if (!candidate) continue;
				const text = targetTexts[i] ??= readTtsSupplementTargetText(candidate);
				if (text && (marker.textSha256 && (targetHashes[i] ??= createHash("sha256").update(text).digest("hex")) === marker.textSha256 || marker.spokenText && text === marker.spokenText)) {
					targetIndex = i;
					break;
				}
			}
			if (targetIndex >= 0) {
				merged[targetIndex] = mergeTtsSupplementContent(expectDefined(merged[targetIndex], "merged entry at target index"), message);
				targetTexts[targetIndex] = targetHashes[targetIndex] = void 0;
				changed = true;
				continue;
			}
		}
		merged.push(message);
	}
	return changed ? merged : messages;
}
function isSubagentAnnounceInterSessionUserMessage(message) {
	const provenance = normalizeInputProvenance(message.provenance);
	if (provenance?.kind === "inter_session" && (provenance.sourceTool === "subagent_announce" || provenance.sourceTool === "subagent_settle")) return true;
	const text = extractProjectedText(message.content ?? message.text);
	return text.includes("[Inter-session message]") && text.includes("sourceTool=subagent_announce");
}
function readChatHistoryRecordTimestampMs(message) {
	const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
	return asFiniteNumber(meta?.recordTimestampMs) ?? asFiniteNumber(asOptionalRecord(message)?.timestamp);
}
function isSubagentAnnounceInterSessionUserChatHistoryMessage(message) {
	const record = asOptionalRecord(message);
	if (!record || record.role !== "user") return false;
	const provenance = normalizeInputProvenance(record.provenance);
	if (provenance?.kind === "inter_session" && (provenance.sourceTool === "subagent_announce" || provenance.sourceTool === "subagent_settle")) return true;
	const text = extractChatHistoryBlockText(record);
	return typeof text === "string" && text.includes("[Inter-session message]") && text.includes("sourceTool=subagent_announce");
}
function isChatHistoryAssistantMessage(message) {
	return asOptionalRecord(message)?.role === "assistant";
}
function dropPreSessionStartAnnouncePairs(messages, sessionStartedAt) {
	if (sessionStartedAt === void 0 || messages.length === 0) return messages;
	let changed = false;
	const kept = [];
	for (let i = 0; i < messages.length; i++) {
		const current = messages[i];
		if (isSubagentAnnounceInterSessionUserChatHistoryMessage(current)) {
			const ts = readChatHistoryRecordTimestampMs(current);
			if (typeof ts === "number" && ts < sessionStartedAt) {
				const next = messages[i + 1];
				const nextTs = readChatHistoryRecordTimestampMs(next);
				if (isChatHistoryAssistantMessage(next) && typeof nextTs === "number" && nextTs < sessionStartedAt) i++;
				changed = true;
				continue;
			}
		}
		kept.push(current);
	}
	return changed ? kept : messages;
}
function isDisplayHiddenProjectedMessage(message) {
	if (message.display === false) return true;
	return message.role === "custom" && message.customType === "openclaw.runtime-context";
}
function shouldHideProjectedHistoryMessage(message, roleContent, heartbeatUser) {
	if (isDisplayHiddenProjectedMessage(message)) return true;
	if (isProjectedSessionsSendForwardedMessage(message)) return false;
	if (!roleContent) return false;
	if (roleContent.role === "user" && isCompletionReportInputProvenance(message.provenance)) return true;
	if (roleContent.role === "user" && isSubagentAnnounceInterSessionUserMessage(message)) return true;
	if (roleContent.role === "user" && isEmptyTextOnlyContent(message.content ?? message.text) && !hasTranscriptMediaFacts(message)) return true;
	if (roleContent.role === "assistant" && isEmptyTextOnlyContent(message.content ?? message.text)) return false;
	return heartbeatUser || isHeartbeatOkResponse(roleContent);
}
/** Identifies the hidden native input that starts a heartbeat-driven turn. */
function isHeartbeatHistoryTurnBoundaryMessage(message) {
	const record = asOptionalRecord(message);
	if (!record || isSessionsSendInterSessionUserMessage(record)) return false;
	const roleContent = asRoleContentMessage(record);
	return roleContent?.role === "user" && isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT);
}
function attachProjectedTurnBoundary(message) {
	const metadata = asOptionalRecord(message["__openclaw"]);
	if (metadata?.turnBoundary === true) return message;
	return {
		...message,
		__openclaw: {
			...metadata,
			turnBoundary: true
		}
	};
}
function canCarryProjectedTurnBoundary(message) {
	return Boolean(message && message.role !== "system" && message.role !== "custom");
}
function openclawAssistantModel(message) {
	return message.role === "assistant" && message.provider === "openclaw" && typeof message.model === "string" ? message.model : void 0;
}
function displayTextForDuplicateCheck(message) {
	const text = extractProjectedText(message.content ?? message.text).trim();
	return text ? text : void 0;
}
function isDuplicateAcpGatewayInjectedMessage(current, previousVisible) {
	if (!previousVisible) return false;
	if (openclawAssistantModel(previousVisible) !== "acp-runtime" || openclawAssistantModel(current) !== "gateway-injected") return false;
	if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) return false;
	const previousText = displayTextForDuplicateCheck(previousVisible);
	const currentText = displayTextForDuplicateCheck(current);
	return Boolean(previousText && currentText && previousText === currentText);
}
function isDuplicateChannelFinalDeliveryMirror(current, previousVisible) {
	if (!previousVisible || !isOpenClawDeliveryMirrorAssistantMessage(current)) return false;
	if (asOptionalRecord(current.openclawDeliveryMirror)?.kind !== "channel-final") return false;
	if (asRoleContentMessage(previousVisible)?.role !== "assistant") return false;
	if (isOpenClawDeliveryMirrorAssistantMessage(previousVisible)) return false;
	if (isProjectedSessionsSendForwardedMessage(previousVisible)) return false;
	const previousMeta = asOptionalRecord(previousVisible["__openclaw"]);
	if (typeof previousMeta?.mirrorIdentity !== "string" || !previousMeta.mirrorIdentity.trim()) return false;
	if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) return false;
	const previousText = displayTextForDuplicateCheck(previousVisible);
	const currentText = displayTextForDuplicateCheck(current);
	return Boolean(previousText && currentText && previousText === currentText);
}
function toProjectedMessages(messages) {
	return messages.flatMap((message) => {
		const record = asOptionalRecord(message);
		return record ? [projectAssistantDisplayContent(record)] : [];
	});
}
function filterVisibleProjectedHistoryMessages(messages, turnBoundaryPending = false) {
	if (messages.length === 0) return {
		messages,
		turnBoundaryPending
	};
	let pendingTurnBoundary = turnBoundaryPending;
	let changed = false;
	const visible = [];
	for (let i = 0; i < messages.length; i++) {
		const current = messages[i];
		if (!current) continue;
		const currentRoleContent = asRoleContentMessage(current);
		const heartbeatUser = Boolean(currentRoleContent && isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT));
		const next = heartbeatUser ? messages[i + 1] : void 0;
		const nextRoleContent = next ? asRoleContentMessage(next) : null;
		if (next && nextRoleContent && isHeartbeatOkResponse(nextRoleContent) && !isProjectedSessionsSendForwardedMessage(next)) {
			changed = true;
			pendingTurnBoundary = true;
			i++;
			continue;
		}
		if (shouldHideProjectedHistoryMessage(current, currentRoleContent, heartbeatUser)) {
			changed = true;
			pendingTurnBoundary ||= heartbeatUser && !isSessionsSendInterSessionUserMessage(current);
			continue;
		}
		if (isDuplicateAcpGatewayInjectedMessage(current, messages[i - 1]) || isDuplicateChannelFinalDeliveryMirror(current, messages[i - 1])) {
			changed = true;
			continue;
		}
		if (pendingTurnBoundary && canCarryProjectedTurnBoundary(currentRoleContent)) {
			visible.push(attachProjectedTurnBoundary(current));
			pendingTurnBoundary = false;
			changed = true;
		} else visible.push(current);
	}
	return {
		messages: changed ? visible : messages,
		turnBoundaryPending: pendingTurnBoundary
	};
}
function stripInterSessionPromptPrefixFromContent(content) {
	if (typeof content === "string") return stripInterSessionPromptPrefixForDisplay(content);
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!block || typeof block !== "object" || Array.isArray(block)) return block;
		const record = block;
		if (typeof record.text !== "string") return block;
		const stripped = stripInterSessionPromptPrefixForDisplay(record.text);
		return stripped === record.text ? block : {
			...record,
			text: stripped
		};
	});
}
function extractPromptPrefixField(text, field) {
	const prefixIndex = text.indexOf(INTER_SESSION_PROMPT_PREFIX_BASE);
	if (prefixIndex === -1) return;
	const lineEnd = text.indexOf("\n", prefixIndex);
	const header = lineEnd === -1 ? text.slice(prefixIndex) : text.slice(prefixIndex, lineEnd);
	const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\s)${escapedField}=([^\\s]+)`).exec(header);
	return normalizeOptionalString(match?.[1]);
}
function resolveSessionsSendForwardedSenderSession(message) {
	const provenance = normalizeInputProvenance(message.provenance);
	const text = extractProjectedText(message.content ?? message.text);
	const sourceSessionKey = provenance?.sourceSessionKey ?? extractPromptPrefixField(text, "sourceSession");
	const agentId = parseAgentSessionKey(sourceSessionKey)?.agentId;
	return sourceSessionKey ? {
		sessionKey: sourceSessionKey,
		...agentId ? { agentId } : {}
	} : void 0;
}
function projectSessionsSendInterSessionMessages(messages) {
	let changed = false;
	const projected = messages.map((message) => {
		if (!isSessionsSendInterSessionUserMessage(message)) return message;
		changed = true;
		const senderSession = resolveSessionsSendForwardedSenderSession(message);
		const next = {
			...message,
			role: "assistant",
			senderLabel: senderSession?.agentId ? `Forwarded from ${senderSession.agentId}` : "Forwarded agent message",
			...senderSession ? { senderSession } : {}
		};
		if ("content" in next) next.content = stripInterSessionPromptPrefixFromContent(next.content);
		if (typeof next.text === "string") next.text = stripInterSessionPromptPrefixForDisplay(next.text);
		return next;
	});
	return changed ? projected : messages;
}
//#endregion
//#region src/gateway/chat-display-projection.message-tool.ts
function normalizeToolHistoryType(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	return normalized ? normalized.replace(/_/g, "") : void 0;
}
function readMaybeJsonRecord(value) {
	if (typeof value === "string") return safeParseJsonRecord(value);
	return asOptionalRecord(value);
}
function readToolBlockName(block) {
	const direct = normalizeOptionalString(block.name) ?? normalizeOptionalString(block.toolName) ?? normalizeOptionalString(block.tool_name) ?? normalizeOptionalString(block.tool);
	if (direct) return direct;
	const fn = asOptionalRecord(block.function);
	return fn ? normalizeOptionalString(fn.name) : void 0;
}
function readToolBlockCallId(block) {
	return normalizeOptionalString(block.id) ?? normalizeOptionalString(block.toolCallId) ?? normalizeOptionalString(block.tool_call_id) ?? normalizeOptionalString(block.callId) ?? normalizeOptionalString(block.call_id);
}
function readToolBlockArguments(block) {
	for (const key of [
		"arguments",
		"input",
		"args",
		"params"
	]) {
		const args = readMaybeJsonRecord(block[key]);
		if (args) return args;
	}
	const fn = asOptionalRecord(block.function);
	if (fn) {
		const args = readMaybeJsonRecord(fn.arguments);
		if (args) return args;
	}
	return {};
}
function hasNonEmptyValue(value) {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(hasNonEmptyValue);
	if (!value || typeof value !== "object") return value != null;
	return Object.values(value).some(hasNonEmptyValue);
}
function hasExplicitMessageToolRoute(args) {
	return [
		"target",
		"targets",
		"to",
		"recipient",
		"recipients",
		"chatId",
		"chat_id",
		"channelId",
		"channel_id",
		"conversationId",
		"conversation_id",
		"threadId",
		"thread_id",
		"roomId",
		"room_id",
		"groupId",
		"group_id"
	].some((field) => hasNonEmptyValue(args[field]));
}
function readMessageToolVisibleText(args) {
	for (const field of [
		"message",
		"text",
		"content",
		"body",
		"caption"
	]) {
		const value = args[field];
		if (typeof value === "string" && value.trim()) return value;
	}
}
function isDryRunMessageToolRecord(record) {
	if (record.dryRun === true || record.dry_run === true) return true;
	return (normalizeOptionalString(record.deliveryStatus) ?? normalizeOptionalString(record.delivery_status) ?? normalizeOptionalString(record.status))?.toLowerCase() === "dry_run";
}
function extractMessageToolVisibleReplies(message) {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const replies = [];
	for (const block of message.content) {
		const record = asOptionalRecord(block);
		if (!record) continue;
		const type = normalizeToolHistoryType(record.type);
		if (type !== "toolcall" && type !== "tooluse") continue;
		if (readToolBlockName(record)?.toLowerCase() !== "message") continue;
		const args = readToolBlockArguments(record);
		if (normalizeOptionalString(args.action)?.toLowerCase() !== "send") continue;
		if (isDryRunMessageToolRecord(args)) continue;
		const requiresSourceRouteConfirmation = hasExplicitMessageToolRoute(args);
		const text = readMessageToolVisibleText(args);
		if (!text?.trim()) continue;
		const toolCallId = readToolBlockCallId(record);
		replies.push({
			...toolCallId ? { toolCallId } : {},
			text,
			requiresSourceRouteConfirmation
		});
	}
	return replies;
}
function isAssistantSilentControlReplyOnly(message) {
	const text = extractAssistantTextForSilentCheck(message);
	return text !== void 0 && isSuppressedControlReplyText(text) && !hasAssistantDisplayableNonTextContent(message);
}
function isRenderableAssistantDisplayMessage(message) {
	if (message.role !== "assistant") return false;
	const text = extractAssistantTextForSilentCheck(message);
	return text !== void 0 && !isSuppressedControlReplyText(text);
}
function readMessageToolResultName(message) {
	return normalizeOptionalString(message.toolName) ?? normalizeOptionalString(message.tool_name) ?? normalizeOptionalString(message.name) ?? normalizeOptionalString(message.tool);
}
function readMessageToolResultCallId(message) {
	return normalizeOptionalString(message.toolCallId) ?? normalizeOptionalString(message.tool_call_id) ?? normalizeOptionalString(message.callId) ?? normalizeOptionalString(message.call_id) ?? normalizeOptionalString(message.id);
}
function readToolResultOkValue(value) {
	if (typeof value === "boolean") return value;
	const record = readMaybeJsonRecord(value);
	if (record && typeof record.ok === "boolean") return record.ok;
	if (Array.isArray(value)) for (const block of value) {
		const blockOk = readToolResultOkValue(block);
		if (blockOk !== void 0) return blockOk;
		const recordBlock = asOptionalRecord(block);
		if (typeof recordBlock?.text === "string") {
			const textOk = readToolResultOkValue(recordBlock.text);
			if (textOk !== void 0) return textOk;
		}
		if (typeof recordBlock?.content === "string") {
			const contentOk = readToolResultOkValue(recordBlock.content);
			if (contentOk !== void 0) return contentOk;
		}
	}
}
function hasDryRunToolResultValue(value) {
	const record = readMaybeJsonRecord(value);
	if (record && isDryRunMessageToolRecord(record)) return true;
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (hasDryRunToolResultValue(block)) return true;
		const recordBlock = asOptionalRecord(block);
		if (typeof recordBlock?.text === "string" && hasDryRunToolResultValue(recordBlock.text)) return true;
		return typeof recordBlock?.content === "string" && hasDryRunToolResultValue(recordBlock.content);
	});
}
function hasSuppressedToolResultValue(value) {
	const record = readMaybeJsonRecord(value);
	if (record) {
		const messageId = normalizeOptionalString(record.messageId)?.toLowerCase();
		const status = (normalizeOptionalString(record.deliveryStatus) ?? normalizeOptionalString(record.delivery_status) ?? normalizeOptionalString(record.status))?.toLowerCase();
		if (record.delivered === false || messageId === "skipped" || messageId === "suppressed" || status === "skipped" || status === "suppressed") return true;
	}
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (hasSuppressedToolResultValue(block)) return true;
		const blockRecord = asOptionalRecord(block);
		return hasSuppressedToolResultValue(blockRecord?.text) || hasSuppressedToolResultValue(blockRecord?.content);
	});
}
function isSuccessfulMessageToolResult(message, pending) {
	const role = typeof message.role === "string" ? message.role.toLowerCase().replace(/_/g, "") : "";
	const toolName = readMessageToolResultName(message)?.toLowerCase();
	if (role !== "toolresult" && role !== "tool" && role !== "function" && toolName !== "message") return false;
	if (toolName && toolName !== "message") return false;
	const resultCallId = readMessageToolResultCallId(message);
	const hasConfirmedSourceRoute = !pending.requiresSourceRouteConfirmation || asOptionalRecord(message.details)?.sourceReplyRoute === "current-source";
	if (pending.toolCallId) return resultCallId === pending.toolCallId && isSuccessfulMessageToolResultPayload(message) && hasConfirmedSourceRoute;
	return isSuccessfulMessageToolResultPayload(message) && hasConfirmedSourceRoute;
}
function isSuccessfulMessageToolResultPayload(message) {
	if (message.isError === true || message.error != null && message.error !== false) return false;
	if (hasDryRunToolResultValue(message.result) || hasDryRunToolResultValue(message.output) || hasDryRunToolResultValue(message.content) || hasDryRunToolResultValue(message.text)) return false;
	if (hasSuppressedToolResultValue(message.details) || hasSuppressedToolResultValue(message.result) || hasSuppressedToolResultValue(message.output) || hasSuppressedToolResultValue(message.content) || hasSuppressedToolResultValue(message.text)) return false;
	return (readToolResultOkValue(message.result) ?? readToolResultOkValue(message.output) ?? readToolResultOkValue(message.content) ?? readToolResultOkValue(message.text)) !== false;
}
function readMessageToolSourceReplySink(message) {
	return asOptionalRecord(message.details)?.sourceReplySink === "internal-ui" ? "internal-ui" : void 0;
}
function buildMessageToolVisibleReplyMirror(pending) {
	const sourceMessageSeq = asPositiveSafeInteger(asOptionalRecord(pending.anchor["__openclaw"])?.seq);
	const deliveryMirror = [pending.deliveryMirrorAnchor, pending.completionAnchor].find((message) => isOpenClawDeliveryMirrorAssistantMessage(message));
	const displayContent = readAssistantDisplayContent(deliveryMirror);
	const mirror = {
		role: "assistant",
		content: displayContent.length > 0 ? displayContent : [{
			type: "text",
			text: pending.text
		}],
		openclawMessageToolMirror: {
			toolName: "message",
			...pending.toolCallId ? { toolCallId: pending.toolCallId } : {},
			...pending.sourceReplySink ? { sourceReplySink: pending.sourceReplySink } : {},
			...pending.sourceReplySink && sourceMessageSeq ? { sourceMessageSeq } : {}
		}
	};
	for (const field of [
		"timestamp",
		"createdAt",
		"agentId"
	]) if (pending.anchor[field] !== void 0) mirror[field] = pending.anchor[field];
	const transcriptMeta = asOptionalRecord((pending.completionAnchor ?? pending.anchor)["__openclaw"]);
	if (transcriptMeta) mirror["__openclaw"] = { ...transcriptMeta };
	return mirror;
}
function readMessageToolDeliveryMirrorText(message) {
	if (!isOpenClawDeliveryMirrorAssistantMessage(message)) return;
	return displayTextForDuplicateCheck(message);
}
function readMessageToolDeliveryMirrorCallId(message) {
	if (!isOpenClawDeliveryMirrorAssistantMessage(message)) return;
	return normalizeOptionalString(asOptionalRecord(message.openclawDeliveryMirror)?.toolCallId);
}
function mirrorMessageToolVisibleReplies(messages) {
	if (messages.length === 0) return messages;
	if (!messages.some((message) => asOptionalRecord(message))) return messages;
	let changed = false;
	const next = [];
	const pending = [];
	const clearPending = () => {
		if (pending.length > 0) pending.length = 0;
	};
	const flushSucceededMirrors = () => {
		for (const item of pending) {
			if (!item.succeeded) continue;
			next.push(buildMessageToolVisibleReplyMirror(item));
			changed = true;
		}
		clearPending();
	};
	const flushSelectedMirrors = (items) => {
		if (items.length === 0) return;
		const selected = new Set(items);
		const remaining = [];
		for (const item of pending) {
			if (selected.has(item) && item.succeeded) {
				next.push(buildMessageToolVisibleReplyMirror(item));
				changed = true;
				continue;
			}
			remaining.push(item);
		}
		pending.length = 0;
		pending.push(...remaining);
	};
	for (const message of messages) {
		const record = asOptionalRecord(message);
		if (!record) {
			next.push(message);
			continue;
		}
		if (record.role === "user" && isSessionsSendInterSessionUserMessage(record) || isProjectedSessionsSendForwardedMessage(record)) {
			next.push(message);
			continue;
		}
		if (record.role === "user") {
			clearPending();
			next.push(message);
			continue;
		}
		const flushAfterCurrentMessage = [];
		const deliveryMirrorText = readMessageToolDeliveryMirrorText(record);
		const deliveryMirrorCallId = readMessageToolDeliveryMirrorCallId(record);
		const exactDeliveryMirrorPending = deliveryMirrorCallId ? pending.filter((item) => item.toolCallId === deliveryMirrorCallId) : [];
		const textMatchingDeliveryMirrorPending = deliveryMirrorText ? pending.filter((item) => item.text.trim() === deliveryMirrorText) : [];
		const matchingDeliveryMirrorPending = deliveryMirrorCallId ? exactDeliveryMirrorPending.length === 1 ? exactDeliveryMirrorPending : [] : textMatchingDeliveryMirrorPending.length === 1 ? textMatchingDeliveryMirrorPending : [];
		const duplicateDeliveryMirror = matchingDeliveryMirrorPending.some((item) => item.succeeded);
		const visibleReplies = extractMessageToolVisibleReplies(record);
		if (visibleReplies.length > 0) for (const reply of visibleReplies) pending.push({
			...reply,
			anchor: record,
			succeeded: false
		});
		else if (pending.length > 0 && deliveryMirrorText === void 0 && isRenderableAssistantDisplayMessage(record)) clearPending();
		if (pending.length > 0) {
			for (const item of pending) if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
				item.succeeded = true;
				const sourceReplySink = readMessageToolSourceReplySink(record);
				if (sourceReplySink) item.sourceReplySink = sourceReplySink;
				item.completionAnchor = item.deliveryMirrorAnchor ?? record;
				if (item.deliveryMirrorAnchor) {
					if (typeof item.deliveryMirrorIndex === "number") next[item.deliveryMirrorIndex] = {
						...item.deliveryMirrorAnchor,
						display: false
					};
					flushAfterCurrentMessage.push(item);
				}
			}
			if (isAssistantSilentControlReplyOnly(record)) flushSucceededMirrors();
		}
		if (duplicateDeliveryMirror) {
			for (const item of matchingDeliveryMirrorPending) item.completionAnchor = record;
			flushSelectedMirrors(matchingDeliveryMirrorPending);
			changed = true;
			continue;
		}
		for (const item of matchingDeliveryMirrorPending) {
			item.deliveryMirrorAnchor = record;
			item.deliveryMirrorIndex = next.length;
		}
		next.push(message);
		flushSelectedMirrors(flushAfterCurrentMessage);
	}
	return changed ? next : messages;
}
//#endregion
//#region src/gateway/chat-display-projection.sanitize.ts
const MEDIA_PRIVATE_FIELDS = [
	"data",
	"blob",
	"path",
	"file",
	"filePath",
	"localPath"
];
const MEDIA_REFERENCE_FIELDS = [
	"url",
	"openUrl",
	"image_url",
	"audio_url",
	"video_url"
];
const MEDIA_FACT_PRIVATE_FIELDS = ["workspaceDir", ...MEDIA_PRIVATE_FIELDS.filter((field) => field !== "path")];
function projectChatHistoryMediaReference(value) {
	if (typeof value !== "string") return;
	const reference = value.trim();
	if (/^\/(?:api\/chat\/media\/outgoing|media|__openclaw__)\//u.test(reference)) return reference.split(/[?#]/u, 1)[0];
	try {
		if (/^media:/iu.test(reference)) return parseInboundMediaUri(reference)?.normalizedSource;
		const url = new URL(reference);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		url.username = url.password = url.search = url.hash = "";
		return url.toString();
	} catch {
		return;
	}
}
function projectChatHistoryMediaBlock(entry, fact = false) {
	if (!fact && (typeof entry.type !== "string" || !/^(?:image|audio|video)$/u.test(entry.type))) return false;
	const media = entry;
	const hasTopLevelPayload = typeof media.data === "string" || typeof media.blob === "string";
	const source = fact ? void 0 : asOptionalRecord(media.source);
	const projectedSource = source ? { ...source } : void 0;
	const records = [media, ...projectedSource ? [projectedSource] : []];
	if (projectedSource) media.source = projectedSource;
	const privateFields = fact ? MEDIA_FACT_PRIVATE_FIELDS : MEDIA_PRIVATE_FIELDS;
	const referenceFields = fact ? ["path", "url"] : MEDIA_REFERENCE_FIELDS;
	const sourceIsReference = !source && (!fact || typeof media.source !== "string" || /^(?:[a-z][a-z0-9+.-]*:|~?[\\/])|[\\/]/iu.test(media.source));
	let encodedPayload;
	for (const record of records) {
		let omitted = false;
		const payload = typeof record.data === "string" ? record.data : record.blob;
		if (encodedPayload === void 0 && typeof payload === "string") encodedPayload = payload;
		for (const field of privateFields) {
			if (!Object.hasOwn(record, field)) continue;
			delete record[field];
			omitted = true;
		}
		const recordReferences = record === media && sourceIsReference ? [...referenceFields, "source"] : referenceFields;
		for (const field of recordReferences) {
			if (!Object.hasOwn(record, field)) continue;
			const projected = (fact ? buildInboundMediaUriFromPath(String(record[field])) : void 0) ?? projectChatHistoryMediaReference(record[field]);
			record[field] = projected;
			if (projected === void 0) {
				delete record[field];
				omitted = true;
			}
		}
		if (!fact && omitted) {
			if (record === media || media.type !== "image") record.omitted = true;
			if (record === media || media.type !== "audio") media.omitted = true;
		}
	}
	if (!fact && encodedPayload !== void 0) (media.type === "audio" && !hasTopLevelPayload && projectedSource ? projectedSource : media).bytes = estimateBase64DecodedBytes(encodedPayload);
	return true;
}
function projectChatHistoryAttachmentBlock(entry) {
	if (entry.type !== "attachment") return false;
	const attachment = asOptionalRecord(entry.attachment);
	if (!attachment) return false;
	const projected = { ...attachment };
	for (const field of MEDIA_PRIVATE_FIELDS) delete projected[field];
	const url = projectChatHistoryMediaReference(projected.url);
	if (!url) delete projected.url;
	else projected.url = url;
	entry.attachment = projected;
	return true;
}
function projectChatHistoryMediaFacts(value) {
	return Array.isArray(value) ? value.map((fact) => {
		const projected = { ...asOptionalRecord(fact) };
		projectChatHistoryMediaBlock(projected, true);
		return projected;
	}) : void 0;
}
function sanitizeChatHistoryContentBlock(block, opts) {
	if (!block || typeof block !== "object") return {
		block,
		changed: false,
		truncated: false
	};
	const entry = { ...block };
	let changed = stripPrivateToolCallContextForDisplay(entry);
	let truncated = false;
	const preserveExactToolPayload = opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
	const maxChars = opts?.maxChars ?? 8e3;
	if (isToolResultHistoryBlockType(entry.type) && "details" in entry) {
		const projectedDetails = projectToolResultDetails(entry.details, maxChars);
		if (projectedDetails.details) entry.details = projectedDetails.details;
		else delete entry.details;
		changed = true;
		truncated ||= projectedDetails.truncated;
	}
	if (typeof entry.text === "string") {
		if (!preserveExactToolPayload) {
			const res = truncateChatHistoryText(entry.text, maxChars);
			entry.text = res.text;
			changed ||= res.truncated;
			truncated ||= res.truncated;
		}
	}
	if (typeof entry.content === "string") {
		if (!preserveExactToolPayload) {
			const res = truncateChatHistoryText(entry.content, maxChars);
			entry.content = res.text;
			changed ||= res.truncated;
			truncated ||= res.truncated;
		}
	}
	if (typeof entry.partialJson === "string" && !preserveExactToolPayload) {
		const res = truncateChatHistoryText(entry.partialJson, maxChars);
		entry.partialJson = res.text;
		changed ||= res.truncated;
		truncated ||= res.truncated;
	}
	if (typeof entry.arguments === "string" && !preserveExactToolPayload) {
		const res = truncateChatHistoryText(entry.arguments, maxChars);
		entry.arguments = res.text;
		changed ||= res.truncated;
		truncated ||= res.truncated;
	}
	if (typeof entry.thinking === "string") {
		const res = truncateChatHistoryText(entry.thinking, maxChars);
		entry.thinking = res.text;
		changed ||= res.truncated;
		truncated ||= res.truncated;
	}
	if ("thinkingSignature" in entry) {
		delete entry.thinkingSignature;
		changed = true;
	}
	if ("openclawReasoningReplay" in entry) {
		delete entry.openclawReasoningReplay;
		changed = true;
	}
	const mediaChanged = projectChatHistoryMediaBlock(entry);
	const attachmentChanged = projectChatHistoryAttachmentBlock(entry);
	changed ||= mediaChanged || attachmentChanged;
	return {
		block: changed ? entry : block,
		changed,
		truncated
	};
}
function sanitizeAssistantPhasedContentBlocks(content) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const entry = block;
		return isAssistantTextContentType(entry.type) && parseAssistantTextSignature(entry)?.phase;
	})) return {
		content,
		changed: false
	};
	const filtered = content.filter((block) => {
		if (!block || typeof block !== "object") return true;
		const entry = block;
		if (!isAssistantTextContentType(entry.type)) return true;
		return parseAssistantTextSignature(entry)?.phase === "final_answer";
	});
	return {
		content: filtered,
		changed: filtered.length !== content.length
	};
}
function projectAssistantMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	let hasVisibleText = false;
	const projectedContent = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (!isAssistantTextContentType(entry.type)) {
			projectedContent.push(block);
			continue;
		}
		if (parseAssistantTextSignature(entry)?.phase === "commentary") continue;
		if (typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(entry.text, maxChars);
		if (truncated.text.trim()) {
			projectedContent.push({
				type: "text",
				text: truncated.text
			});
			hasVisibleText = true;
		}
	}
	return hasVisibleText ? {
		content: projectedContent,
		changed: true
	} : null;
}
function projectAssistantCommentaryFallbacks(message, maxChars) {
	if (!message || typeof message !== "object") return [];
	const entry = asOptionalRecord(message);
	if (!entry || entry.role !== "assistant" || !Array.isArray(entry.content) || entry.stopReason === "error" || typeof entry.errorMessage === "string") return [];
	const transcriptMeta = asOptionalRecord(entry["__openclaw"]);
	return entry.content.flatMap((block) => {
		const content = asOptionalRecord(block);
		if (!content) return [];
		const signature = parseAssistantTextSignature(content);
		const text = typeof content.text === "string" ? content.text : "";
		const itemId = signature?.id?.trim();
		if (!isAssistantTextContentType(content.type) || signature?.phase !== "commentary" || !itemId || !text.trim()) return [];
		const projected = truncateChatHistoryText(text, maxChars);
		const projectedMeta = projected.truncated ? {
			...transcriptMeta,
			truncated: true,
			reason: typeof transcriptMeta?.reason === "string" ? transcriptMeta.reason : "display-cap"
		} : transcriptMeta ? { ...transcriptMeta } : void 0;
		return [{
			role: "assistant",
			content: [{
				type: "text",
				text: projected.text
			}],
			...typeof entry.timestamp === "number" ? { timestamp: entry.timestamp } : {},
			openclawStreamFallback: {
				replacementText: projected.text,
				source: "segment",
				itemId
			},
			...projectedMeta ? { __openclaw: projectedMeta } : {}
		}];
	});
}
function sanitizeCost(raw) {
	if (!raw || typeof raw !== "object") return;
	const c = raw;
	const out = {};
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"total"
	]) {
		const value = asFiniteNumber(c[key]);
		if (value !== void 0) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function sanitizeUsage(raw) {
	if (!raw || typeof raw !== "object") return;
	const u = raw;
	const out = {};
	for (const k of [
		"input",
		"output",
		"total",
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"promptTokens",
		"completionTokens",
		"cacheRead",
		"cacheWrite",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"input_tokens",
		"output_tokens",
		"prompt_tokens",
		"completion_tokens",
		"total_tokens"
	]) {
		const n = asFiniteNumber(u[k]);
		if (n !== void 0) out[k] = n;
	}
	if ("cost" in u && u.cost != null && typeof u.cost === "object") {
		const sanitizedCost = sanitizeCost(u.cost);
		if (sanitizedCost) out.cost = sanitizedCost;
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function projectWorkspaceConflictDetails(entry) {
	if (entry.role !== "custom" || entry.customType !== "cloud-workspace-conflict") return;
	const details = asOptionalRecord(entry.details);
	if (!details || !Array.isArray(details.paths) || details.paths.length === 0 || !details.paths.every((entryPath) => typeof entryPath === "string" && entryPath.length > 0) || typeof details.stagedResultRef !== "string" || !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef) || details.totalCount !== void 0 && (!Number.isSafeInteger(details.totalCount) || details.totalCount < details.paths.length)) return;
	try {
		return projectWorkspaceResultConflict(details.paths, details.stagedResultRef, details.totalCount);
	} catch {
		return;
	}
}
function sanitizeChatHistoryMessage(message, maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS) {
	if (!message || typeof message !== "object") return {
		message,
		changed: false
	};
	const entry = { ...message };
	let changed = false;
	let truncated = false;
	if ("providerReplay" in entry) {
		delete entry.providerReplay;
		changed = true;
	}
	const openClawMeta = asOptionalRecord(entry["__openclaw"]);
	if (openClawMeta && ("upstreamUserText" in openClawMeta || "media" in openClawMeta)) {
		const projectedMeta = { ...openClawMeta };
		delete projectedMeta.upstreamUserText;
		if ("media" in projectedMeta) {
			projectedMeta.media = projectChatHistoryMediaFacts(projectedMeta.media);
			if (projectedMeta.media === void 0) delete projectedMeta.media;
		}
		if (Object.keys(projectedMeta).length > 0) entry["__openclaw"] = projectedMeta;
		else delete entry["__openclaw"];
		changed = true;
	}
	const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
	const managedMedia = takeAssistantManagedMediaUrlsForDisplay(entry, role);
	changed ||= managedMedia.changed;
	const preserveExactToolPayload = role === "toolresult" || role === "tool_result" || role === "tool" || role === "function" || typeof entry.toolName === "string" || typeof entry.tool_name === "string" || typeof entry.toolCallId === "string" || typeof entry.tool_call_id === "string";
	if ("details" in entry) {
		const conflictDetails = projectWorkspaceConflictDetails(entry);
		const toolResultDetails = !conflictDetails && messageHasToolResultShape(entry) ? projectToolResultDetails(entry.details, maxChars) : void 0;
		const projectedDetails = conflictDetails ?? toolResultDetails?.details;
		if (projectedDetails) entry.details = projectedDetails;
		else delete entry.details;
		changed = true;
		truncated ||= toolResultDetails?.truncated === true;
	}
	if (entry.role !== "assistant") {
		if ("usage" in entry) {
			delete entry.usage;
			changed = true;
		}
		if ("cost" in entry) {
			delete entry.cost;
			changed = true;
		}
	} else {
		if ("usage" in entry) {
			const sanitized = sanitizeUsage(entry.usage);
			if (sanitized) entry.usage = sanitized;
			else delete entry.usage;
			changed = true;
		}
		if ("cost" in entry) {
			const sanitized = sanitizeCost(entry.cost);
			if (sanitized) entry.cost = sanitized;
			else delete entry.cost;
			changed = true;
		}
	}
	const stripAssistantControlTokens = role === "assistant" && !shouldPreserveAssistantControlReplyText(entry);
	if (typeof entry.content === "string") {
		const controlStripped = stripAssistantControlTokens ? stripAssistantMediaDirectivesForDisplay(stripSuppressedControlReplyToken(entry.content), managedMedia.urls) : entry.content;
		changed ||= controlStripped !== entry.content;
		if (preserveExactToolPayload) entry.content = controlStripped;
		else {
			const res = truncateChatHistoryText(controlStripped, maxChars);
			entry.content = res.text;
			changed ||= res.truncated;
			truncated ||= res.truncated;
		}
	} else if (Array.isArray(entry.content)) {
		const content = entry.content;
		let updated;
		for (let index = 0; index < content.length; index++) {
			const sanitized = sanitizeChatHistoryContentBlock(content[index], {
				preserveExactToolPayload,
				maxChars
			});
			const contentBlock = stripAssistantControlTokens ? asOptionalRecord(sanitized.block) : void 0;
			if (contentBlock && isAssistantTextContentType(contentBlock.type) && typeof contentBlock.text === "string") {
				const text = stripAssistantMediaDirectivesForDisplay(stripSuppressedControlReplyToken(contentBlock.text), managedMedia.urls);
				if (text !== contentBlock.text) {
					sanitized.block = {
						...contentBlock,
						text
					};
					sanitized.changed = true;
				}
			}
			if (sanitized.changed) {
				updated ??= content.slice();
				updated[index] = sanitized.block;
			}
			truncated ||= sanitized.truncated;
		}
		if (updated) {
			entry.content = updated;
			changed = true;
		}
		if (entry.role === "assistant" && Array.isArray(entry.content)) {
			const mixedToolContent = projectAssistantMixedToolContent(entry.content, maxChars);
			if (mixedToolContent) {
				entry.content = mixedToolContent.content;
				if (entry.phase === "commentary") delete entry.phase;
				changed = true;
			} else {
				const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
				if (sanitizedPhases.changed) {
					entry.content = sanitizedPhases.content;
					changed = true;
				}
			}
		}
	}
	if (typeof entry.text === "string") {
		const controlStripped = stripAssistantControlTokens ? stripAssistantMediaDirectivesForDisplay(stripSuppressedControlReplyToken(entry.text), managedMedia.urls) : entry.text;
		changed ||= controlStripped !== entry.text;
		if (preserveExactToolPayload) entry.text = controlStripped;
		else {
			const res = truncateChatHistoryText(controlStripped, maxChars);
			entry.text = res.text;
			changed ||= res.truncated;
			truncated ||= res.truncated;
		}
	}
	if (truncated) {
		const meta = asOptionalRecord(entry["__openclaw"]);
		entry["__openclaw"] = {
			...meta,
			truncated: true,
			reason: typeof meta?.reason === "string" ? meta.reason : "display-cap"
		};
		changed = true;
	}
	return {
		message: changed ? entry : message,
		changed
	};
}
function hasAssistantMixedToolVisibleText(message) {
	if (!message || typeof message !== "object") return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	let hasToolHistoryBlock = false;
	let hasText = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (isToolHistoryBlockType(entry.type)) hasToolHistoryBlock = true;
		if (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;
	}
	return hasToolHistoryBlock && hasText;
}
function shouldDropAssistantHistoryMessage(message) {
	if (!message || typeof message !== "object") return false;
	const entry = message;
	if (entry.role !== "assistant") return false;
	if (isProjectedSessionsSendForwardedMessage(entry)) return false;
	if (resolveAssistantMessagePhase(message) === "commentary") return !hasAssistantMixedToolVisibleText(message);
	const text = extractAssistantTextForSilentCheck(message);
	if (text === void 0 || !isSuppressedControlReplyText(text)) return false;
	return !hasAssistantDisplayableNonTextContent(message);
}
function sanitizeChatHistoryMessages(messages, maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS, opts) {
	if (messages.length === 0) return messages;
	let changed = false;
	const next = [];
	for (const message of messages) {
		if (opts?.includeCommentaryFallbacks === true) for (const commentary of projectAssistantCommentaryFallbacks(message, maxChars)) {
			const projected = sanitizeChatHistoryMessage(commentary, maxChars);
			next.push(projected.message);
			changed = true;
		}
		if (shouldDropAssistantHistoryMessage(message)) {
			changed = true;
			continue;
		}
		const res = sanitizeChatHistoryMessage(message, maxChars);
		changed ||= res.changed;
		if (res.changed && shouldDropAssistantHistoryMessage(res.message)) {
			changed = true;
			continue;
		}
		next.push(res.message);
	}
	return changed ? next : messages;
}
//#endregion
//#region src/gateway/chat-display-projection.core.ts
/** Keep profile display reads local to one history page or event projection operation. */
function createCurrentUserProfileMessageProjector(resolveDisplay) {
	const displayBySenderId = /* @__PURE__ */ new Map();
	return (message) => {
		if (message.role !== "user") return message;
		const metadata = asOptionalRecord(message["__openclaw"]);
		if (!metadata) return message;
		const identity = readTranscriptSenderIdentity(metadata.senderIdentity);
		if (identity?.type !== "profile") return message;
		const senderId = identity.id;
		let display = displayBySenderId.get(senderId);
		if (!display) {
			display = resolveDisplay(senderId);
			displayBySenderId.set(senderId, display);
		}
		if (display.kind === "unresolved") return message;
		if (metadata.senderProfileAvatarUrl === display.avatarUrl && identity.id === display.profileId) return message;
		return {
			...message,
			__openclaw: {
				...metadata,
				senderIdentity: {
					type: "profile",
					id: display.profileId
				},
				senderProfileAvatarUrl: display.avatarUrl
			}
		};
	};
}
function projectCurrentUserProfileAvatars(messages, resolveDisplay) {
	if (!resolveDisplay) return messages;
	const project = createCurrentUserProfileMessageProjector(resolveDisplay);
	let changed = false;
	const projected = messages.map((message) => {
		const row = project(message);
		changed ||= row !== message;
		return row;
	});
	return changed ? projected : messages;
}
const GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT = "Context overflow: this conversation is too large for the model. Try /compact, use /new to start a fresh session, or retry the command with a tighter output limit.";
function isContextOverflowErrorSignal(value) {
	if (typeof value !== "string") return false;
	return normalizeLowercaseStringOrEmpty(value) === "context_overflow" || isContextOverflowError(value, { providerPlugin: null });
}
function isContextOverflowAssistantError(message) {
	return isContextOverflowErrorSignal(message.errorCode) || isContextOverflowErrorSignal(message.errorType) || isContextOverflowErrorSignal(message.errorMessage);
}
function getAssistantErrorFallbackText(message) {
	return formatProviderRefusalText(message) ?? renderAssistantRequestFailureCopy({ storageFailure: classifyGatewayStorageFailure(message) }) ?? (isContextOverflowAssistantError(message) ? GATEWAY_ASSISTANT_CONTEXT_OVERFLOW_FALLBACK_TEXT : "The agent run failed before producing a reply.");
}
function sanitizeAssistantErrorDisplayMessage(message) {
	const { content, ...envelope } = message;
	const next = sanitizeChatHistoryMessage(envelope, Number.MAX_SAFE_INTEGER).message;
	if (Array.isArray(content)) {
		let firstTextBlock = true;
		next.content = content.flatMap((block) => {
			const sanitized = sanitizeChatHistoryContentBlock(block, { maxChars: Number.MAX_SAFE_INTEGER }).block;
			if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return [sanitized];
			const entry = sanitized;
			if (isAssistantInternalReasoningContentType(entry.type)) return [];
			if (!firstTextBlock || !isAssistantTextContentType(entry.type)) return [sanitized];
			firstTextBlock = false;
			if (typeof entry.text !== "string" || !entry.text.startsWith("[assistant turn failed before producing content]")) return [sanitized];
			const replyText = entry.text.slice(STREAM_ERROR_FALLBACK_TEXT.length);
			return replyText ? [{
				...entry,
				text: replyText
			}] : [];
		});
	} else next.content = typeof content === "string" && content.startsWith("[assistant turn failed before producing content]") ? content.slice(STREAM_ERROR_FALLBACK_TEXT.length) : content;
	if (typeof next.text === "string" && next.text.startsWith("[assistant turn failed before producing content]")) next.text = next.text.slice(STREAM_ERROR_FALLBACK_TEXT.length);
	delete next.diagnostics;
	delete next.errorBody;
	delete next.errorCode;
	delete next.errorMessage;
	delete next.errorType;
	return next;
}
function isPureStreamErrorFallbackAssistantMessage(message) {
	if (message.role !== "assistant" || message.stopReason !== "error") return false;
	const text = extractAssistantTextForSilentCheck(message);
	return text !== void 0 && text.trim() === "[assistant turn failed before producing content]" && !hasAssistantNonTextContent(message) && !hasTranscriptMediaFacts(message);
}
function hasVisibleAssistantDisplayContent(message) {
	if (message.role !== "assistant" || message.display === false || isPureStreamErrorFallbackAssistantMessage(message)) return false;
	const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER).message;
	if (shouldDropAssistantHistoryMessage(sanitized)) return false;
	if (hasAssistantDisplayableNonTextContent(sanitized) || hasTranscriptMediaFacts(sanitized)) return true;
	return hasVisibleAssistantReplyText(sanitized);
}
function hasVisibleAssistantReplyText(message) {
	return [...Array.isArray(message.content) ? message.content.flatMap((block) => {
		const entry = asOptionalRecord(block);
		return isAssistantTextContentType(entry?.type) ? [entry?.text] : [];
	}) : [message.content], message.text].some((text) => {
		if (typeof text !== "string") return false;
		const visible = text.trim();
		return visible.length > 0 && visible !== "[assistant turn failed before producing content]" && !isSuppressedControlReplyText(visible);
	});
}
function isPendingAssistantError(value) {
	const message = asOptionalRecord(value);
	return message?.role === "assistant" && message.stopReason === "error" && (isPureStreamErrorFallbackAssistantMessage(message) || Boolean(readSessionTranscriptRunId(message)) && !hasAssistantDisplayableNonTextContent(message) && !hasVisibleAssistantDisplayContent(message));
}
function projectRecoveredAssistantErrors(messages, initialPending = false) {
	let unseenPending = initialPending;
	let recoveryObserved = false;
	let pendingIndexes = [];
	const repairedIndexes = /* @__PURE__ */ new Set();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "user") {
			unseenPending = false;
			pendingIndexes = [];
			continue;
		}
		if (isPendingAssistantError(message)) {
			pendingIndexes.push(index);
			continue;
		}
		if (!unseenPending && pendingIndexes.length === 0 || !hasVisibleAssistantDisplayContent(message)) continue;
		recoveryObserved ||= unseenPending;
		unseenPending = false;
		const completedRunId = (message.stopReason === "stop" || message.stopReason === "length") && !isTranscriptOnlyOpenClawAssistantMessage(message) ? readSessionTranscriptRunId(message) : void 0;
		pendingIndexes = pendingIndexes.filter((pendingIndex) => {
			const failedRunId = readSessionTranscriptRunId(messages[pendingIndex]);
			if (failedRunId && failedRunId !== completedRunId) return true;
			repairedIndexes.add(pendingIndex);
			recoveryObserved = true;
			return false;
		});
	}
	return {
		messages: repairedIndexes.size > 0 ? messages.filter((_, index) => !repairedIndexes.has(index)) : messages,
		pending: unseenPending || pendingIndexes.length > 0,
		recoveryObserved
	};
}
function projectEmptyAssistantErrorMessages(messages) {
	let changed = false;
	const projected = messages.map((message) => {
		if (message.role !== "assistant" || message.stopReason !== "error") return message;
		if (hasAssistantDisplayableNonTextContent(message) || hasTranscriptMediaFacts(message)) {
			changed = true;
			return sanitizeAssistantErrorDisplayMessage(message);
		}
		const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER).message;
		if (!shouldDropAssistantHistoryMessage(sanitized) && hasVisibleAssistantReplyText(sanitized)) {
			changed = true;
			return sanitizeAssistantErrorDisplayMessage(message);
		}
		changed = true;
		const next = {
			...sanitized,
			content: [{
				type: "text",
				text: getAssistantErrorFallbackText(message)
			}]
		};
		delete next.diagnostics;
		delete next.errorBody;
		delete next.errorCode;
		delete next.errorMessage;
		delete next.errorType;
		delete next.phase;
		delete next.text;
		return next;
	});
	return changed ? projected : messages;
}
const INERT_HIDDEN_ASSISTANT_FIELDS = new Set(["role", "display", "content", "timestamp", "__openclaw"]);
const INERT_HIDDEN_TRANSCRIPT_FIELDS = new Set(["id", "seq", "recordTimestampMs", "transcriptPosition"]);
/** Explicitly hidden plain text cannot add tool mirrors, user boundaries, or assistant errors. */
function isInertHiddenAssistantText(message) {
	if (!message || message.role !== "assistant" || message.display !== false) return false;
	if (Object.keys(message).some((key) => !INERT_HIDDEN_ASSISTANT_FIELDS.has(key))) return false;
	const metadata = message.__openclaw;
	if (metadata !== void 0 && (!asOptionalRecord(metadata) || Object.keys(metadata).some((key) => !INERT_HIDDEN_TRANSCRIPT_FIELDS.has(key)))) return false;
	const content = message.content;
	return typeof content === "string" || Array.isArray(content) && content.every((block) => Boolean(block) && block.type === "text" && typeof block.text === "string" && Object.keys(block).every((key) => key === "type" || key === "text"));
}
function projectChatDisplayMessagesWithState(messages, options) {
	if (messages.length > 0 && messages.every(isInertHiddenAssistantText)) return {
		messages: [],
		turnBoundaryPending: options?.turnBoundaryPending || false,
		assistantErrorPending: options?.assistantErrorPending || false,
		assistantErrorRecoveryObserved: false
	};
	const projectedActivity = messages.map((message) => {
		const activity = readNestedToolActivity(message);
		if (!activity) return message;
		const [call, result] = nestedToolActivityContent(activity);
		const sanitized = sanitizeChatHistoryMessage({
			...result,
			role: "toolResult"
		}, options?.maxChars ?? 8e3).message;
		return {
			...asOptionalRecord(message),
			runId: activity.details.runId,
			__openclaw: {
				...asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]),
				runId: activity.details.runId
			},
			content: [call, sanitized]
		};
	});
	const recoveredErrors = projectRecoveredAssistantErrors(toProjectedMessages(mirrorMessageToolVisibleReplies(options?.stripEnvelope === false ? projectedActivity : stripEnvelopeFromMessages(projectedActivity))), options?.assistantErrorPending);
	const filtered = filterVisibleProjectedHistoryMessages(projectSessionsSendInterSessionMessages(toProjectedMessages(sanitizeChatHistoryMessages(projectEmptyAssistantErrorMessages(recoveredErrors.messages), Number.MAX_SAFE_INTEGER, { includeCommentaryFallbacks: options?.includeCommentaryFallbacks }))), options?.turnBoundaryPending);
	return {
		messages: projectCurrentUserProfileAvatars(sanitizeChatHistoryMessages(mergeTtsSupplementMessages(filtered.messages), options?.maxChars ?? 8e3), options?.resolveCurrentUserProfileDisplay),
		turnBoundaryPending: filtered.turnBoundaryPending,
		assistantErrorPending: recoveredErrors.pending,
		assistantErrorRecoveryObserved: recoveredErrors.recoveryObserved
	};
}
function projectChatDisplayMessages(messages, options) {
	return projectChatDisplayMessagesWithState(messages, options).messages;
}
function projectChatDisplayMessage(message, options) {
	return projectChatDisplayMessages([message], options)[0];
}
//#endregion
//#region src/gateway/current-user-profile-display.ts
function resolveCurrentUserProfileDisplay(senderId) {
	try {
		const profile = getUserProfileDisplay(senderId);
		const label = normalizeOptionalString(profile.displayName);
		return {
			kind: "resolved",
			profileId: profile.id,
			...label ? { label } : {},
			avatarUrl: buildControlUiUserAvatarPath(profile.id, profile.avatarRevision),
			hasUploadedAvatar: profile.hasAvatar
		};
	} catch {
		return { kind: "unresolved" };
	}
}
//#endregion
//#region src/gateway/session-transcript-message.ts
/** Attach OpenClaw metadata to a transcript message without dropping existing metadata. */
function attachOpenClawTranscriptMeta(message, meta) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return message;
	const record = message;
	const existing = record["__openclaw"] && typeof record["__openclaw"] === "object" && !Array.isArray(record["__openclaw"]) ? record["__openclaw"] : {};
	return {
		...record,
		__openclaw: {
			...existing,
			...meta
		}
	};
}
function readTranscriptMessageIdempotencyKey(message) {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	const value = message.idempotencyKey;
	return typeof value === "string" && value.trim() ? value : void 0;
}
function readTranscriptMessageSenderIsOwner(message) {
	const value = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.senderIsOwner;
	return typeof value === "boolean" ? value : void 0;
}
/** Project one transcript message into the exact payload emitted as session.message. */
function projectSessionMessagePayload(params) {
	const idempotencyKey = readTranscriptMessageIdempotencyKey(params.message);
	const senderIsOwner = readTranscriptMessageSenderIsOwner(params.message);
	const rawMessage = attachOpenClawTranscriptMeta(params.message, {
		transcriptPosition: params.transcriptPosition,
		...params.messageId ? { id: params.messageId } : {},
		...idempotencyKey ? { idempotencyKey } : {},
		...params.messageSeq !== void 0 ? { seq: params.messageSeq } : {}
	});
	const projected = params.projectionState ? projectChatDisplayMessagesWithState([rawMessage], {
		assistantErrorPending: params.projectionState.assistantErrorPending,
		turnBoundaryPending: params.projectionState.turnBoundaryPending
	}) : {
		messages: [projectChatDisplayMessage(rawMessage)],
		assistantErrorPending: false,
		turnBoundaryPending: false
	};
	const projectionState = {
		assistantErrorPending: projected.assistantErrorPending,
		turnBoundaryPending: projected.turnBoundaryPending
	};
	const message = projected.messages[0];
	if (!message) return { projectionState };
	const projectCurrentUserProfile = params.projectCurrentUserProfile ?? createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
	return {
		payload: {
			sessionKey: params.sessionKey,
			...senderIsOwner === void 0 ? {} : { senderIsOwner },
			...params.agentId ? { agentId: params.agentId } : {},
			message: projectCurrentUserProfile(message),
			...params.messageId ? { messageId: params.messageId } : {},
			...params.messageSeq !== void 0 ? { messageSeq: params.messageSeq } : {},
			...params.sessionSnapshot,
			...params.runId ? { runId: params.runId } : {}
		},
		projectionState
	};
}
/** Project one stored transcript entry onto the client-visible chat history shape. */
function projectTranscriptEntryMessage(entry, seq, transcriptPosition) {
	if (!isVisibleTranscriptRecord(entry)) return null;
	const record = entry;
	if (record.message) {
		const recordTimestampMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : typeof record.timestamp === "number" ? record.timestamp : NaN;
		const idempotencyKey = readTranscriptMessageIdempotencyKey(record.message);
		return attachOpenClawTranscriptMeta(record.message, {
			...typeof record.id === "string" ? { id: record.id } : {},
			...idempotencyKey ? { idempotencyKey } : {},
			...Number.isFinite(recordTimestampMs) ? { recordTimestampMs } : {},
			transcriptPosition,
			seq
		});
	}
	if (record.type !== "compaction" && record.type !== "reset") return null;
	const kind = record.type;
	const compactionIdentity = kind === "compaction" ? asOptionalRecord(record["__openclaw"]) : void 0;
	const parsedTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
	return {
		role: "system",
		content: [{
			type: "text",
			text: kind === "compaction" ? "Compaction" : "Reset"
		}],
		timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
		__openclaw: {
			kind,
			id: typeof record.id === "string" ? record.id : void 0,
			...typeof compactionIdentity?.runId === "string" ? { runId: compactionIdentity.runId } : {},
			...typeof compactionIdentity?.itemId === "string" ? { itemId: compactionIdentity.itemId } : {},
			transcriptPosition,
			seq
		}
	};
}
//#endregion
//#region src/gateway/session-utils.fs.ts
const RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES = 8388608;
function normalizeRecentSessionReadOptions(opts) {
	const maxMessages = resolveNonNegativeIntegerOption(opts?.maxMessages, 0);
	return {
		maxMessages,
		maxBytes: resolveIntegerOption(opts?.maxBytes, RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES, { min: 1024 }),
		maxLines: resolveIntegerOption(opts?.maxLines, maxMessages * 20 + 20, { min: maxMessages })
	};
}
async function readRecentTranscriptTailLinesAsync(filePath, opts, displaySource, sessionId) {
	const { maxBytes, maxLines } = normalizeRecentSessionReadOptions(opts);
	const handle = await fs.promises.open(filePath, "r");
	try {
		const stat = await handle.stat();
		assertArchiveTranscriptSource(filePath, stat, displaySource, sessionId);
		const readLen = Math.min(stat.size, maxBytes);
		const readStart = Math.max(0, stat.size - readLen);
		const buffer = Buffer.alloc(readLen);
		const bytesRead = await readFileWindowFully(handle, buffer, readStart);
		assertArchiveTranscriptSource(filePath, await handle.stat(), displaySource, sessionId);
		if (bytesRead <= 0) return [];
		return buffer.toString("utf-8", 0, bytesRead).split(/\r?\n/).slice(readStart > 0 ? 1 : 0).filter((line) => line.trim().length > 0).slice(-maxLines);
	} finally {
		await handle.close();
	}
}
function parseRecentTranscriptTailSnapshot(lines, maxMessages, index) {
	const selected = selectArchiveTranscriptEntries(lines.flatMap((line) => {
		const entry = parseTranscriptRecord(line);
		return entry ? [entry] : [];
	}), true);
	const recent = selected.filter((entry) => isVisibleTranscriptRecord(entry.record)).slice(-maxMessages);
	const firstSeq = Math.max(1, index.entries.length - recent.length + 1);
	return {
		messages: recent.flatMap((entry, offset) => {
			const indexed = entry.id ? index.byId.get(entry.id) : void 0;
			const message = projectTranscriptEntryMessage(entry.record, indexed?.seq ?? firstSeq + offset, indexed?.transcriptPosition);
			return message ? [message] : [];
		}),
		transcriptEvents: selected.map((entry) => entry.record)
	};
}
function findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId) {
	return resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((value) => fs.existsSync(value)) ?? null;
}
/** Single owner for bounded reads of live JSONL artifacts and cold reset archives. */
var ArchivedTranscriptReader = class {
	constructor(scope) {
		this.scope = scope;
	}
	activePath() {
		return findExistingTranscriptPath(this.scope.sessionId, this.scope.storePath, this.scope.sessionFile, this.scope.agentId);
	}
	async resolveArtifact(opts) {
		if (opts.resetArchiveOnly !== true) {
			const activePath = this.activePath();
			if (activePath) return {
				path: activePath,
				source: "active"
			};
		}
		if (opts.allowResetArchiveFallback !== true) return null;
		const archives = await resolveSessionTranscriptResetArchiveCandidatesAsync(this.scope.sessionId, this.scope.storePath, this.scope.sessionFile, this.scope.agentId);
		for (const archivePath of archives) {
			if (!(await fs.promises.stat(archivePath).catch(() => null))?.isFile()) continue;
			if (opts.resetArchiveOnly !== true) {
				const activePath = this.activePath();
				if (activePath) return {
					path: activePath,
					source: "active"
				};
			}
			try {
				return {
					path: materializeSessionArchiveForRead(archivePath),
					source: "reset-archive"
				};
			} catch {
				continue;
			}
		}
		return null;
	}
	async read(opts) {
		if (opts.mode === "recent") {
			const snapshot = await this.readRecentWithStats(opts);
			return {
				messages: snapshot.messages,
				transcriptPath: snapshot.transcriptPath
			};
		}
		const artifact = await this.resolveArtifact(opts);
		if (!artifact) return { messages: [] };
		const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
		return {
			messages: index ? (await readIndexedTranscriptEntries(artifact.path, index, index.entries, this.scope.sessionId)).flatMap(indexedTranscriptEntryToMessages) : [],
			transcriptPath: artifact.path
		};
	}
	async readById(messageId, opts) {
		const artifact = await this.resolveArtifact(opts);
		if (!artifact) return {
			oversized: false,
			found: false
		};
		const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
		const selected = index?.byId.get(messageId);
		if (!index || !selected) return {
			oversized: false,
			found: false
		};
		const [entry] = await readIndexedTranscriptEntries(artifact.path, index, [selected], this.scope.sessionId);
		if (!entry) return {
			oversized: false,
			found: false
		};
		if (entry.byteLength > 262144 && (entry.recoveredImageData !== true || jsonUtf8Bytes(entry.record) > 262144)) return {
			oversized: true,
			found: true,
			seq: entry.seq
		};
		return {
			message: indexedTranscriptEntryToMessage(entry),
			seq: entry.seq,
			oversized: false,
			found: true
		};
	}
	async readMessageCandidatesById(messageId, opts) {
		const artifact = await this.resolveArtifact(opts);
		if (!artifact) return [];
		const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
		if (!index) return [];
		return (await readIndexedTranscriptEntries(artifact.path, index, index.entries.filter((entry) => entry.rawId === void 0 || entry.rawId === messageId), this.scope.sessionId)).flatMap(indexedTranscriptEntryToMessages);
	}
	async readRecentWithStats(opts) {
		const artifact = await this.resolveArtifact(opts);
		if (!artifact) return {
			messages: [],
			totalMessages: 0
		};
		const transcriptIndex = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
		const totalMessages = transcriptIndex?.entries.length ?? 0;
		const normalized = normalizeRecentSessionReadOptions(opts);
		const snapshot = normalized.maxMessages === 0 || !transcriptIndex ? {
			messages: [],
			transcriptEvents: []
		} : await readRecentSessionSnapshotFromPathAsync(artifact.path, normalized, transcriptIndex, this.scope.sessionId);
		return {
			displaySource: transcriptIndex?.displaySource,
			messages: snapshot.messages,
			transcriptEvents: snapshot.transcriptEvents,
			totalMessages,
			transcriptPath: artifact.path,
			transcriptSource: artifact.source
		};
	}
	async readPage(opts) {
		const artifact = await this.resolveArtifact(opts);
		if (!artifact) return {
			messages: [],
			totalMessages: 0
		};
		const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
		if (!index) return {
			messages: [],
			totalMessages: 0,
			transcriptPath: artifact.path
		};
		const totalMessages = index.entries.length;
		const offset = Math.min(resolveNonNegativeIntegerOption(opts.offset, 0), totalMessages);
		const endExclusive = Math.max(0, totalMessages - offset);
		const start = Math.max(0, endExclusive - resolveNonNegativeIntegerOption(opts.maxMessages, 0));
		const entries = await readIndexedTranscriptEntries(artifact.path, index, index.entries.slice(start, endExclusive), this.scope.sessionId);
		return {
			displaySource: index.displaySource,
			messages: entries.flatMap(indexedTranscriptEntryToMessages),
			transcriptEvents: entries.map((entry) => entry.record),
			totalMessages,
			transcriptPath: artifact.path,
			transcriptSource: artifact.source
		};
	}
	async readAroundId(opts) {
		const artifacts = [];
		if (opts.resetArchiveOnly !== true) {
			const activePath = this.activePath();
			if (activePath) artifacts.push({
				path: activePath,
				source: "active"
			});
		}
		if (opts.allowResetArchiveFallback === true) for (const archivePath of await resolveSessionTranscriptResetArchiveCandidatesAsync(this.scope.sessionId, this.scope.storePath, this.scope.sessionFile, this.scope.agentId)) try {
			artifacts.push({
				path: materializeSessionArchiveForRead(archivePath),
				source: "reset-archive"
			});
		} catch {}
		let activeTotalMessages = 0;
		let displaySource;
		for (const artifact of artifacts) {
			const index = await readSessionTranscriptIndex(artifact.path, this.scope.sessionId);
			if (!index) continue;
			displaySource ??= index.displaySource;
			if (artifact.source === "active") activeTotalMessages = index.entries.length;
			const anchorIndex = index.entries.findIndex((entry) => entry.id === opts.messageId);
			if (anchorIndex < 0) continue;
			const pageSize = Math.max(1, Math.floor(opts.maxMessages));
			const olderMessages = pageSize - Math.floor(pageSize / 2) - 1;
			const start = Math.min(Math.max(0, anchorIndex - olderMessages), Math.max(0, index.entries.length - pageSize));
			const endExclusive = Math.min(index.entries.length, start + pageSize);
			const readStart = Math.max(0, start - 1);
			const entries = await readIndexedTranscriptEntries(artifact.path, index, index.entries.slice(readStart, endExclusive), this.scope.sessionId);
			return {
				displaySource: index.displaySource,
				found: true,
				hasOverreadContext: readStart < start,
				messages: entries.flatMap(indexedTranscriptEntryToMessages),
				offset: index.entries.length - endExclusive,
				totalMessages: index.entries.length,
				transcriptPath: artifact.path,
				transcriptSource: artifact.source
			};
		}
		return {
			displaySource,
			found: false,
			hasOverreadContext: false,
			messages: [],
			offset: 0,
			totalMessages: activeTotalMessages
		};
	}
};
async function readRecentSessionSnapshotFromPathAsync(filePath, opts, index, sessionId) {
	return parseRecentTranscriptTailSnapshot(await readRecentTranscriptTailLinesAsync(filePath, opts, index.displaySource, sessionId), opts.maxMessages, index);
}
function indexedTranscriptEntryToMessage(entry) {
	return projectTranscriptEntryMessage(entry.record, entry.seq, entry.transcriptPosition);
}
function indexedTranscriptEntryToMessages(entry) {
	const message = indexedTranscriptEntryToMessage(entry);
	return message ? [message] : [];
}
function capArrayByJsonBytes(items, maxBytes, byteLength = jsonUtf8Bytes) {
	if (items.length === 0) return {
		items,
		bytes: 2
	};
	const parts = items.map(byteLength);
	let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
	let start = 0;
	while (bytes > maxBytes && start < items.length - 1) {
		bytes -= expectDefined(parts[start], "parts entry at start") + 1;
		start += 1;
	}
	return {
		items: start > 0 ? items.slice(start) : items,
		bytes
	};
}
async function readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath, sessionFile, agentId) {
	const filePath = findExistingTranscriptPath(sessionId, storePath, sessionFile, agentId);
	if (!filePath) return null;
	try {
		if ((await fs.promises.stat(filePath)).size === 0) return null;
		const messages = [];
		for await (const line of streamSessionTranscriptLines(filePath)) {
			if (isOversizedTranscriptLine(line)) continue;
			try {
				const record = JSON.parse(line);
				if (!record.message || typeof record.message !== "object" || Array.isArray(record.message)) continue;
				const message = record.message;
				const usage = message.usage && typeof message.usage === "object" && !Array.isArray(message.usage) ? message.usage : record.usage;
				messages.push({
					...message,
					...typeof message.provider !== "string" && typeof record.provider === "string" ? { provider: record.provider } : {},
					...typeof message.model !== "string" && typeof record.model === "string" ? { model: record.model } : {},
					...usage && typeof usage === "object" && !Array.isArray(usage) ? { usage } : {}
				});
			} catch {
				continue;
			}
		}
		return aggregateSessionTranscriptUsage(messages, "artifact");
	} catch {
		return null;
	}
}
function buildSessionPreviewItems(messages, maxItems, maxChars, view = "display") {
	const items = [];
	for (const message of messages) {
		const projected = projectSessionDisplayMessage(message, {
			maxChars,
			view
		});
		if (!projected) continue;
		items.push(projected);
	}
	if (items.length <= maxItems) return items;
	return items.slice(-maxItems);
}
//#endregion
//#region src/config/sessions/session-accessor.sqlite-display-position.ts
function readTranscriptDisplaySource(projection) {
	const generation = readTranscriptProjectionGeneration(projection);
	return generation ? createTranscriptDisplaySource([
		"sqlite",
		projection.database.path,
		projection.resolved.agentId,
		projection.resolved.sessionId,
		generation
	]) : void 0;
}
/** Enrich only selected rows, in their existing snapshot; anchor lookups never load payloads. */
function positionTranscriptDisplayEvents(projection, source, events) {
	if (!source || events.length === 0) return events;
	const anchors = [...new Set(events.flatMap(({ event }) => {
		const id = readNestedToolActivity(asOptionalRecord(event)?.message)?.details.afterEntryId;
		return typeof id === "string" ? [id] : [];
	}))];
	const sequences = /* @__PURE__ */ new Map();
	const beforeRawSeq = resolveSqliteSessionTranscriptReadFence({
		database: projection.database,
		...projection.resolved
	})?.beforeRawSeq;
	const maxSeq = Math.min(projection.state.indexedSeq, beforeRawSeq === void 0 ? Infinity : beforeRawSeq - 1);
	const db = getActiveTranscriptKysely(projection.database);
	for (let offset = 0; offset < anchors.length; offset += 500) {
		const rows = executeSqliteQuerySync(projection.database.db, db.selectFrom("transcript_event_identities").select(["event_id", "seq"]).where("session_id", "=", projection.resolved.sessionId).where("event_id", "in", anchors.slice(offset, offset + 500)).where("seq", "<=", maxSeq)).rows;
		for (const row of rows) sequences.set(row.event_id, row.seq);
	}
	return events.map((row) => ({
		...row,
		displayPosition: createTranscriptDisplayPosition(source, row.eventSeq, asOptionalRecord(row.event)?.message, (id) => sequences.get(id))
	}));
}
//#endregion
//#region src/config/sessions/session-accessor.sqlite-history-events.ts
function resolveVisibleHistoryProjection(projection) {
	const displaySource = readTranscriptDisplaySource(projection);
	if (projection.state.activeEventCount === projection.state.activeMessageCount) return {
		boundaries: [],
		displaySource,
		total: projection.state.activeMessageCount
	};
	const visibleMessages = resolveVisibleMessagePositions(projection);
	const db = getActiveTranscriptKysely(projection.database);
	const rows = executeSqliteQuerySync(projection.database.db, db.selectFrom("session_transcript_active_events as active").innerJoin("transcript_event_identities as identity", (join) => join.onRef("identity.session_id", "=", "active.session_id").onRef("identity.seq", "=", "active.event_seq")).innerJoin("transcript_events as event", (join) => join.onRef("event.session_id", "=", "active.session_id").onRef("event.seq", "=", "active.event_seq")).select([
		"identity.event_id",
		"identity.event_type",
		"identity.seq",
		sql`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes")
	]).select((eb) => eb.selectFrom("session_transcript_active_events as next").select("next.message_position").whereRef("next.session_id", "=", "active.session_id").whereRef("next.active_position", ">", "active.active_position").where("next.message_position", "is not", null).orderBy("next.active_position", "asc").limit(1).as("next_message_position")).where("active.session_id", "=", projection.resolved.sessionId).where("identity.event_type", "in", ["compaction", "reset"]).orderBy("active.active_position", "asc")).rows;
	const resetIndex = rows.findLastIndex((row) => row.event_type === "reset");
	const boundaries = rows.slice(Math.max(0, resetIndex)).map((row, index) => {
		const nextMessagePosition = row.next_message_position ?? projection.state.activeMessageCount;
		const messagePosition = visibleMessages.kept.length + Math.max(0, nextMessagePosition - visibleMessages.postStart);
		return {
			displayPosition: messagePosition + index,
			eventId: row.event_id,
			eventSeq: row.seq,
			messagePosition,
			serializedBytes: row.serialized_bytes
		};
	});
	return {
		boundaries,
		displaySource,
		total: visibleMessages.total + boundaries.length
	};
}
function resolveVisibleHistoryRange(history, start, endExclusive) {
	const boundedStart = Math.min(Math.max(0, start), history.total);
	const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), history.total);
	const selectedBoundaries = history.boundaries.filter((boundary) => boundary.displayPosition >= boundedStart && boundary.displayPosition < boundedEnd);
	const boundaries = new Map(selectedBoundaries.map((boundary) => [boundary.displayPosition, boundary]));
	const messageStart = boundedStart - history.boundaries.filter((boundary) => boundary.displayPosition < boundedStart).length;
	return {
		boundedEnd,
		boundedStart,
		boundaries,
		messageEnd: messageStart + boundedEnd - boundedStart - selectedBoundaries.length,
		messageStart
	};
}
function readBoundaryEvents(projection, boundaries) {
	const eventSeqs = Array.from(boundaries, (boundary) => boundary.eventSeq);
	const [firstSeq] = eventSeqs;
	const lastSeq = eventSeqs.at(-1);
	if (firstSeq === void 0 || lastSeq === void 0) return /* @__PURE__ */ new Map();
	const db = getActiveTranscriptKysely(projection.database);
	return new Map(executeSqliteQuerySync(projection.database.db, db.selectFrom("session_transcript_active_events as active").innerJoin("transcript_event_identities as identity", (join) => join.onRef("identity.session_id", "=", "active.session_id").onRef("identity.seq", "=", "active.event_seq")).innerJoin("transcript_events as event", (join) => join.onRef("event.session_id", "=", "active.session_id").onRef("event.seq", "=", "active.event_seq")).select(["event.seq", "event.event_json"]).where("active.session_id", "=", projection.resolved.sessionId).where("identity.event_type", "in", ["compaction", "reset"]).where("identity.seq", ">=", firstSeq).where("identity.seq", "<=", lastSeq)).rows.map((row) => [row.seq, JSON.parse(row.event_json)]));
}
function readVisibleHistoryRange(projection, start, endExclusive, history = resolveVisibleHistoryProjection(projection)) {
	const range = resolveVisibleHistoryRange(history, start, endExclusive);
	if (range.boundedEnd <= range.boundedStart) return [];
	const messages = readVisibleMessageRange(projection, range.messageStart, range.messageEnd);
	const boundaryEvents = readBoundaryEvents(projection, range.boundaries.values());
	return positionTranscriptDisplayEvents(projection, history.displaySource, Array.from(mergeVisibleHistoryEvents(range, messages, boundaryEvents)));
}
function* mergeVisibleHistoryEvents(range, messages, boundaryEvents) {
	const iterator = messages[Symbol.iterator]();
	try {
		for (let displayPosition = range.boundedStart; displayPosition < range.boundedEnd; displayPosition += 1) {
			const boundary = range.boundaries.get(displayPosition);
			if (boundary) {
				const event = boundaryEvents.get(boundary.eventSeq);
				if (event) yield {
					event,
					eventSeq: boundary.eventSeq,
					seq: displayPosition + 1
				};
				continue;
			}
			const message = iterator.next();
			if (!message.done) yield {
				...message.value,
				seq: displayPosition + 1
			};
		}
	} finally {
		iterator.return?.();
	}
}
function resolveRecentHistoryStart(projection, start, endExclusive, history, maxBytes, maxMessages, allowOversizedFirst = true) {
	const { boundedEnd, boundedStart, boundaries, messageEnd, messageStart } = resolveVisibleHistoryRange(history, start, endExclusive);
	const metadataStart = Math.max(messageStart, messageEnd - maxMessages);
	const messageBytes = new Map(readVisibleMessageMetadata(projection, metadataStart, messageEnd).map((row) => [row.logicalPosition, row.serialized_bytes]));
	let messageIndex = messageEnd - 1;
	let selectedStart = boundedEnd;
	let selectedCount = 0;
	let bytes = 0;
	for (let displayPosition = boundedEnd - 1; displayPosition >= boundedStart; displayPosition -= 1) {
		if (selectedCount >= maxMessages) break;
		const boundary = boundaries.get(displayPosition);
		const logicalPosition = boundary ? void 0 : messageIndex--;
		const serializedBytes = boundary?.serializedBytes ?? (logicalPosition === void 0 ? void 0 : messageBytes.get(logicalPosition));
		if (serializedBytes === void 0) continue;
		if ((!allowOversizedFirst || selectedCount > 0) && bytes + serializedBytes > maxBytes) break;
		selectedStart = displayPosition;
		selectedCount += 1;
		bytes += serializedBytes;
	}
	return selectedStart;
}
function readVisibleMessageById(projection, eventId, history) {
	const db = getActiveTranscriptKysely(projection.database);
	const row = executeSqliteQueryTakeFirstSync(projection.database.db, db.selectFrom("transcript_event_identities as identity").innerJoin("session_transcript_active_events as active", (join) => join.onRef("active.session_id", "=", "identity.session_id").onRef("active.event_seq", "=", "identity.seq")).innerJoin("transcript_events as event", (join) => join.onRef("event.session_id", "=", "active.session_id").onRef("event.seq", "=", "active.event_seq")).select([
		"active.event_seq",
		"active.message_position",
		"event.event_json"
	]).where("identity.session_id", "=", projection.resolved.sessionId).where("identity.event_id", "=", eventId).where("active.message_position", "is not", null));
	if (!row || row.message_position === null) return;
	const seq = resolveHistoryMessageSequence(resolveVisibleMessagePositions(projection), history, row.message_position);
	return seq === void 0 ? void 0 : {
		event: JSON.parse(row.event_json),
		eventSeq: row.event_seq,
		seq
	};
}
function resolveHistoryMessageSequence(visible, history, messagePosition) {
	const logicalPosition = messagePosition >= visible.postStart ? visible.kept.length + messagePosition - visible.postStart : visible.kept.indexOf(messagePosition);
	if (logicalPosition < 0) return;
	const precedingBoundaries = history.boundaries.filter((candidate) => candidate.messagePosition <= logicalPosition).length;
	return logicalPosition + 1 + precedingBoundaries;
}
function resolveHistoryEventById(projection, eventId, history = resolveVisibleHistoryProjection(projection)) {
	const boundary = history.boundaries.find((candidate) => candidate.eventId === eventId);
	if (boundary) {
		const event = readBoundaryEvents(projection, [boundary]).get(boundary.eventSeq);
		return event ? {
			event,
			eventSeq: boundary.eventSeq,
			seq: boundary.displayPosition + 1
		} : void 0;
	}
	return readVisibleMessageById(projection, eventId, history);
}
/** Raw cursor progress carries the same reset-relative ordinals as pages and live messages. */
function readTranscriptDisplayDelta(scope, limits = {}) {
	const readLimits = { ...limits };
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const result = readTranscriptRawDelta(scope, readLimits);
		if (result.kind !== "page") return result;
		const history = resolveVisibleHistoryProjection(projection);
		const visible = resolveVisibleMessagePositions(projection);
		const firstSeq = result.events[0]?.seq;
		const lastSeq = result.events.at(-1)?.seq;
		const db = getActiveTranscriptKysely(projection.database);
		const sequences = new Map(firstSeq === void 0 || lastSeq === void 0 ? [] : executeSqliteQuerySync(projection.database.db, db.selectFrom("session_transcript_active_events").select(["event_seq", "message_position"]).where("session_id", "=", projection.resolved.sessionId).where("event_seq", ">=", firstSeq).where("event_seq", "<=", lastSeq).where("message_position", "is not", null)).rows.map((row) => [row.event_seq, row.message_position === null ? void 0 : resolveHistoryMessageSequence(visible, history, row.message_position)]));
		const events = positionTranscriptDisplayEvents(projection, history.displaySource, result.events.map((row) => {
			const messageSeq = sequences.get(row.seq);
			return {
				...row,
				eventSeq: row.seq,
				...messageSeq === void 0 ? {} : { messageSeq }
			};
		}));
		return {
			...result,
			activeLeafEntryId: projection.state.leafEventId,
			events
		};
	});
}
function readSessionTranscriptHistoryEvents(scope) {
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const history = resolveVisibleHistoryProjection(projection);
		return readVisibleHistoryRange(projection, 0, history.total, history);
	});
}
function readRecentSessionTranscriptHistoryEvents(scope, options) {
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const history = resolveVisibleHistoryProjection(projection);
		const generation = readTranscriptProjectionGeneration(projection);
		const deltaCursor = generation ? createTranscriptRawDeltaCursor({
			agentId: projection.resolved.agentId,
			generation,
			lastSeq: projection.state.indexedSeq,
			sessionId: projection.resolved.sessionId
		}) : void 0;
		const maxMessages = Math.min(MAX_VISIBLE_MESSAGE_MAX_MESSAGES, Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)));
		const maxLines = Math.max(0, Math.floor(Number.isFinite(options.maxLines) ? options.maxLines : 0));
		if (maxMessages === 0 || maxLines === 0) return {
			activeLeafEntryId: projection.state.leafEventId,
			...deltaCursor ? { deltaCursor } : {},
			events: [],
			displaySource: history.displaySource,
			totalMessages: history.total
		};
		const maxBytes = Math.max(1024, Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 8388608));
		const selectedStart = resolveRecentHistoryStart(projection, Math.max(0, history.total - maxLines), history.total, history, maxBytes, maxMessages);
		return {
			activeLeafEntryId: projection.state.leafEventId,
			...deltaCursor ? { deltaCursor } : {},
			events: readVisibleHistoryRange(projection, selectedStart, history.total, history),
			displaySource: history.displaySource,
			totalMessages: history.total
		};
	});
}
function readSessionTranscriptHistoryEventPage(scope, options) {
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const history = resolveVisibleHistoryProjection(projection);
		const offset = Math.min(Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)), history.total);
		const maxMessages = Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0));
		const endExclusive = Math.max(0, history.total - offset);
		const requestedStart = Math.max(0, endExclusive - maxMessages);
		const boundedStart = options.maxBytes === void 0 ? requestedStart : resolveRecentHistoryStart(projection, requestedStart, endExclusive, history, Math.max(1024, Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 1048576)), maxMessages, false);
		const omittedOversized = maxMessages > 0 && endExclusive > 0 && boundedStart === endExclusive;
		const consumedStart = omittedOversized ? endExclusive - 1 : boundedStart;
		return {
			activeLeafEntryId: projection.state.leafEventId,
			events: readVisibleHistoryRange(projection, boundedStart, endExclusive, history),
			displaySource: history.displaySource,
			totalMessages: history.total,
			...options.maxBytes !== void 0 && maxMessages > 0 && consumedStart > 0 ? { olderOffset: history.total - consumedStart } : {},
			...omittedOversized ? { omittedOversized: true } : {}
		};
	});
}
function readSessionTranscriptHistoryEventCount(scope) {
	return withCurrentProjectionSnapshot(scope, (projection) => resolveVisibleHistoryProjection(projection).total);
}
function readSessionTranscriptHistoryEventById(scope, eventId) {
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const history = resolveVisibleHistoryProjection(projection);
		const event = resolveHistoryEventById(projection, eventId, history);
		return event ? positionTranscriptDisplayEvents(projection, history.displaySource, [event])[0] : void 0;
	});
}
/** Select ID candidates and projected-history presence from one validated snapshot. */
function readSessionTranscriptHistoryEventLookup(scope, eventId) {
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const history = resolveVisibleHistoryProjection(projection);
		const range = resolveVisibleHistoryRange(history, 0, history.total);
		if (!eventId.trim() || hasUnindexedVisibleMessages(projection, range.messageStart, range.messageEnd)) {
			const events = readVisibleHistoryRange(projection, 0, history.total, history);
			return {
				events,
				hasDisplayMessages: events.some((row) => isVisibleTranscriptRecord(row.event))
			};
		}
		assertVisibleMessageRangeJson(projection, range.messageStart, range.messageEnd);
		const boundaryEvents = readBoundaryEvents(projection, range.boundaries.values());
		let first;
		let hasDisplayMessages = false;
		for (const event of mergeVisibleHistoryEvents(range, iterateVisibleMessageRange(projection, range.messageStart, range.messageEnd), boundaryEvents)) {
			first ??= event;
			if (isVisibleTranscriptRecord(event.event)) {
				hasDisplayMessages = true;
				break;
			}
		}
		const event = resolveHistoryEventById(projection, eventId.trim(), history);
		const positioned = positionTranscriptDisplayEvents(projection, history.displaySource, event ? [event] : first ? [first] : []);
		return {
			events: event ? positioned : [],
			hasDisplayMessages
		};
	});
}
const historyBeforeQueryByDatabase = new WeakMap();
/** Messages-only keyset: select anchor metadata and only older payloads in one indexed query. */
function readVisibleHistoryBeforeMessageRange(projection, history, messageId, maxMessages) {
	let read = historyBeforeQueryByDatabase.get(projection.database.db);
	if (!read) {
		read = prepareSqliteQuerySync(projection.database.db, (parameter) => {
			const db = getActiveTranscriptKysely(projection.database);
			return db.selectFrom("transcript_event_identities as identity")
				.innerJoin("session_transcript_active_events as anchor", (join) => join.onRef("anchor.session_id", "=", "identity.session_id").onRef("anchor.event_seq", "=", "identity.seq"))
				.leftJoin("session_transcript_active_events as older", (join) => join.onRef("older.session_id", "=", "anchor.session_id").onRef("older.message_position", "<", "anchor.message_position").on("older.message_position", ">=", sql`MAX(0, anchor.message_position - ${parameter((params) => params.maxMessages)})`))
				.leftJoin("transcript_events as event", (join) => join.onRef("event.session_id", "=", "older.session_id").onRef("event.seq", "=", "older.event_seq"))
				.select(["anchor.message_position as anchor_position", "older.event_seq", "older.message_position", "event.event_json"])
				.where("identity.session_id", "=", parameter((params) => params.sessionId))
				.where("identity.event_id", "=", parameter((params) => params.messageId))
				.where("anchor.message_position", "is not", null)
				.orderBy("older.message_position", "asc");
		});
		historyBeforeQueryByDatabase.set(projection.database.db, read);
	}
	const rows = read({ sessionId: projection.resolved.sessionId, messageId, maxMessages }).rows;
	if (rows.length === 0) throw new SessionTranscriptProjectionUnavailableError(projection.resolved.sessionId);
	const events = positionTranscriptDisplayEvents(projection, history.displaySource, rows.flatMap((row) => row.message_position === null ? [] : [{
		event: JSON.parse(row.event_json),
		eventSeq: row.event_seq,
		seq: row.message_position + 1
	}]));
	return { events, anchorSeq: rows[0].anchor_position + 1 };
}
/** Resolve an exclusive older-than cursor without loading the anchor payload. */
function readSessionTranscriptHistoryBeforePage(scope, options) {
	return withCurrentProjectionSnapshot(scope, (projection) => {
		// Admission applies even when the selected range contains no payloads.
		resolveSqliteSessionTranscriptReadFence({ database: projection.database, ...projection.resolved });
		const messageId = typeof options.messageId === "string" ? options.messageId.trim() : "";
		if (!messageId) throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
		const history = resolveVisibleHistoryProjection(projection);
		if (!options.displaySource || history.displaySource !== options.displaySource) throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
		const maxMessages = Math.min(MAX_VISIBLE_MESSAGE_MAX_MESSAGES, Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)));
		if (projection.state.activeEventCount === projection.state.activeMessageCount) {
			const { events, anchorSeq } = readVisibleHistoryBeforeMessageRange(projection, history, messageId, maxMessages);
			return { events, found: true, hasOverreadContext: false, offset: history.total - anchorSeq + 1, displaySource: history.displaySource, totalMessages: history.total };
		}
		const boundary = history.boundaries.find((candidate) => typeof candidate.eventId === "string" && candidate.eventId.trim() === messageId);
		let anchorSeq;
		if (boundary) anchorSeq = boundary.displayPosition + 1;
		else {
			const db = getActiveTranscriptKysely(projection.database);
			const row = executeSqliteQueryTakeFirstSync(projection.database.db, db.selectFrom("transcript_event_identities as identity").innerJoin("session_transcript_active_events as active", (join) => join.onRef("active.session_id", "=", "identity.session_id").onRef("active.event_seq", "=", "identity.seq")).select("active.message_position").where("identity.session_id", "=", projection.resolved.sessionId).where("identity.event_id", "=", messageId).where("active.message_position", "is not", null));
			if (row && row.message_position !== null) anchorSeq = resolveHistoryMessageSequence(resolveVisibleMessagePositions(projection), history, row.message_position);
		}
		if (anchorSeq === void 0) throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);

		const endExclusive = anchorSeq - 1;
		return {
			events: readVisibleHistoryRange(projection, Math.max(0, endExclusive - maxMessages), endExclusive, history),
			found: true,
			hasOverreadContext: false,
			offset: history.total - endExclusive,
			displaySource: history.displaySource,
			totalMessages: history.total
		};
	});
}
function readSessionTranscriptHistoryAnchorPage(scope, options) {
	if (options.direction === "before") return readSessionTranscriptHistoryBeforePage(scope, options);
	return withCurrentProjectionSnapshot(scope, (projection) => {
		const history = resolveVisibleHistoryProjection(projection);
		const anchor = resolveHistoryEventById(projection, options.messageId, history);
		if (!anchor) return {
			events: [],
			found: false,
			hasOverreadContext: false,
			offset: 0,
			displaySource: history.displaySource,
			totalMessages: history.total
		};
		const pageSize = Math.max(1, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 1));
		const anchorPosition = anchor.seq - 1;
		const olderMessages = pageSize - Math.floor(pageSize / 2) - 1;
		const latestStart = Math.max(0, history.total - pageSize);
		const start = Math.min(Math.max(0, anchorPosition - olderMessages), latestStart);
		const endExclusive = Math.min(history.total, start + pageSize);
		const readStart = Math.max(0, start - 1);
		return {
			events: readVisibleHistoryRange(projection, readStart, endExclusive, history),
			found: true,
			hasOverreadContext: readStart < start,
			offset: history.total - endExclusive,
			displaySource: history.displaySource,
			totalMessages: history.total
		};
	});
}
//#endregion
//#region src/gateway/session-transcript-readers.ts
function resolveTranscriptReadTarget(scope) {
	const target = resolveSessionTranscriptReadTarget(scope);
	return {
		agentId: target.agentId,
		sessionFile: target.sessionKey ?? target.sessionId,
		sessionId: target.sessionId,
		...target.sessionKey ? { sessionKey: target.sessionKey } : {},
		storePath: target.storePath
	};
}
function toTranscriptReadScope(target) {
	return {
		...target.agentId ? { agentId: target.agentId } : {},
		sessionId: target.sessionId,
		...target.sessionKey ? { sessionKey: target.sessionKey } : {},
		...target.storePath ? { storePath: target.storePath } : {}
	};
}
function archivedTranscriptReader(target) {
	return new ArchivedTranscriptReader({
		agentId: target.agentId,
		sessionId: target.sessionId,
		storePath: target.storePath
	});
}
function extractMessagePayloads(entries) {
	return entries.map((entry) => asOptionalRecord(entry.event)?.message);
}
function projectSqliteHistoryEvents(entries) {
	return entries.flatMap((entry) => {
		const message = projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
		return message ? [message] : [];
	});
}
function normalizeRecentSqliteReadOptions(opts) {
	const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
	const maxBytes = typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes) ? Math.max(1024, Math.floor(opts.maxBytes)) : 8388608;
	const defaultMaxLines = maxMessages * 20 + 20;
	return {
		maxMessages,
		maxBytes,
		maxLines: typeof opts?.maxLines === "number" && Number.isFinite(opts.maxLines) ? Math.max(maxMessages, Math.floor(opts.maxLines)) : defaultMaxLines
	};
}
async function readRecentSqliteMessageRecords(target, opts) {
	const normalized = normalizeRecentSqliteReadOptions(opts);
	const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), normalized);
	return {
		...Object.hasOwn(page, "activeLeafEntryId") ? { activeLeafEntryId: page.activeLeafEntryId } : {},
		...page.deltaCursor ? { deltaCursor: page.deltaCursor } : {},
		displaySource: page.displaySource,
		messages: projectSqliteHistoryEvents(page.events),
		transcriptEvents: page.events.map((entry) => entry.event),
		totalMessages: page.totalMessages
	};
}
function sqliteMessageEventWithSeq(entry) {
	return projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
}
function buildSqlitePreviewItems(target, maxItems, maxChars, view) {
	const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
	const readPreviewPage = (maxEvents, maxBytes) => {
		if (view === "model-context") {
			const { agentId, sessionId, sessionKey, storePath } = target;
			if (!agentId || !sessionKey || !storePath) throw new Error("Model-context preview requires an exact session target");
			let truncated = false;
			return {
				items: buildSessionPreviewItems(SessionManager.openBounded({
					agentId,
					sessionId,
					sessionKey,
					storePath
				}, {
					maxEvents,
					maxBytes,
					onTruncated: () => {
						truncated = true;
					}
				}).buildSessionContext().messages, maxItems, maxChars, view),
				hasOlderEvents: truncated
			};
		}
		const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), {
			maxBytes,
			maxLines: maxEvents,
			maxMessages: maxEvents
		});
		return {
			items: buildSessionPreviewItems(extractMessagePayloads(page.events), maxItems, maxChars),
			hasOlderEvents: page.totalMessages > page.events.length
		};
	};
	const preview = readPreviewPage(initialMaxEvents, 1048576);
	if (preview.items.length >= maxItems || !preview.hasOlderEvents) return preview.items;
	return readPreviewPage(Math.min(2048, Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems))), 8388608).items;
}
/** Reads display messages asynchronously through the reader seam. */
async function readSessionMessagesAsync(scope, opts) {
	return (await readSessionMessagesWithSourceAsync(scope, opts)).messages;
}
/** Reads display messages with source metadata through the reader seam. */
async function readSessionMessagesWithSourceAsync(scope, opts) {
	const target = resolveTranscriptReadTarget(scope);
	const messages = opts.mode === "recent" ? (await readRecentSqliteMessageRecords(target, opts)).messages : projectSqliteHistoryEvents(readSessionTranscriptHistoryEvents(toTranscriptReadScope(target)));
	if (messages.length === 0 && opts.allowResetArchiveFallback === true) return await archivedTranscriptReader(target).read({
		...opts,
		resetArchiveOnly: true
	});
	return {
		messages,
		transcriptPath: target.sessionFile
	};
}
/** Finds one display message by transcript id through the reader seam. */
async function readSessionMessageByIdAsync(scope, messageId, opts) {
	const target = resolveTranscriptReadTarget(scope);
	const foundEvent = readSessionTranscriptHistoryEventById(toTranscriptReadScope(target), messageId);
	if (foundEvent) return {
		found: true,
		message: projectTranscriptEntryMessage(foundEvent.event, foundEvent.seq, foundEvent.displayPosition),
		oversized: false,
		seq: foundEvent.seq
	};
	if (opts?.allowResetArchiveFallback === true) return await archivedTranscriptReader(target).readById(messageId, {
		...opts,
		resetArchiveOnly: true
	});
	return {
		found: false,
		oversized: false
	};
}
/** Read exact membership while retaining full-history validity and empty-only archive fallback. */
async function readSessionMessagesMatchingIdAsync(scope, messageId) {
	const target = resolveTranscriptReadTarget(scope);
	const lookup = readSessionTranscriptHistoryEventLookup(toTranscriptReadScope(target), messageId);
	return (lookup.hasDisplayMessages ? projectSqliteHistoryEvents(lookup.events) : await archivedTranscriptReader(target).readMessageCandidatesById(messageId, {
		allowResetArchiveFallback: true,
		resetArchiveOnly: true
	})).filter((message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id === messageId);
}
/** Visits raw message payloads within the SQLite read snapshot. */
async function visitSessionMessagesAsync(scope, visit) {
	const target = resolveTranscriptReadTarget(scope);
	let count = 0;
	visitSessionTranscriptMessageEvents(toTranscriptReadScope(target), (entry) => {
		const message = asOptionalRecord(entry.event)?.message;
		if (message !== void 0) {
			visit(message, entry.seq);
			count += 1;
		}
	});
	return count;
}
/** Counts display messages asynchronously through the reader seam. */
async function readSessionMessageCountAsync(scope) {
	const transcriptScope = toTranscriptReadScope(resolveTranscriptReadTarget(scope));
	try {
		return readSessionTranscriptHistoryEventCount(transcriptScope);
	} catch (error) {
		if (!isSessionTranscriptProjectionUnavailableError(error)) throw error;
		await waitForSessionTranscriptProjection(transcriptScope);
		return readSessionTranscriptHistoryEventCount(transcriptScope);
	}
}
/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
async function readRecentSessionMessagesWithStatsAsync(scope, opts) {
	const target = resolveTranscriptReadTarget(scope);
	const { activeLeafEntryId, deltaCursor, displaySource, messages, transcriptEvents, totalMessages } = await readRecentSqliteMessageRecords(target, opts);
	if (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) return await archivedTranscriptReader(target).readRecentWithStats({
		...opts,
		resetArchiveOnly: true
	});
	return {
		...activeLeafEntryId !== void 0 ? { activeLeafEntryId } : {},
		...deltaCursor ? { deltaCursor } : {},
		displaySource,
		messages,
		transcriptEvents,
		totalMessages,
		transcriptPath: target.sessionFile,
		transcriptSource: "active"
	};
}
/** Reads one offset page with total-count metadata through the reader seam. */
async function readSessionMessagesPageWithStatsAsync(scope, opts) {
	const target = resolveTranscriptReadTarget(scope);
	const page = readSessionTranscriptHistoryEventPage(toTranscriptReadScope(target), opts);
	if (page.totalMessages === 0 && opts.allowResetArchiveFallback === true) return await archivedTranscriptReader(target).readPage({
		...opts,
		resetArchiveOnly: true
	});
	return {
		...Object.hasOwn(page, "activeLeafEntryId") ? { activeLeafEntryId: page.activeLeafEntryId } : {},
		...page.olderOffset !== void 0 ? { olderOffset: page.olderOffset } : {},
		...page.omittedOversized ? { omittedOversized: true } : {},
		messages: projectSqliteHistoryEvents(page.events),
		transcriptEvents: page.events.map((entry) => entry.event),
		displaySource: page.displaySource,
		totalMessages: page.totalMessages,
		transcriptPath: target.sessionFile,
		transcriptSource: "active"
	};
}
/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
async function readLatestSessionUsageFromTranscriptAsync(scope) {
	const artifactFile = scope.sessionFile?.trim();
	const concreteStorePath = resolveConcreteSessionStorePath(scope.storePath);
	const targetAgentId = scope.agentId?.trim() || resolveAgentIdFromSessionKey(scope.sessionKey);
	if (!Boolean(targetAgentId && scope.sessionKey?.trim() && concreteStorePath) && artifactFile && path.isAbsolute(artifactFile) && artifactFile.endsWith(".jsonl")) return await readLatestSessionUsageFromTranscriptFileAsync(scope.sessionId, concreteStorePath, artifactFile, void 0);
	const target = resolveTranscriptReadTarget(scope);
	return aggregateSessionTranscriptUsage(extractMessagePayloads(readSessionTranscriptMessageEvents(toTranscriptReadScope(target))));
}
/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
function readRecentSessionUsageFromTranscript(scope, maxBytes) {
	const target = resolveTranscriptReadTarget(scope);
	return aggregateSessionTranscriptUsage(extractMessagePayloads(readRecentSessionTranscriptMessageEvents(toTranscriptReadScope(target), {
		maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8388608)),
		maxLines: 1e3,
		maxMessages: 1e3
	}).events));
}
/** Reads the answering model only when the latest visible message belongs to this settled run. */
function readSessionTerminalModelFromTranscript(scope, runId) {
	try {
		const page = readSessionTranscriptBoundedMessageTailPage(scope, {
			maxBytes: 262144,
			maxMessages: 1,
			offset: 0
		});
		const message = asOptionalRecord(asOptionalRecord(page.events[0]?.event)?.message);
		if ((message?.stopReason === "stop" || message?.stopReason === "length") && readSessionTranscriptRunId(message) === runId && projectSessionDisplayMessage(message)?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") return {
			modelProvider: message.provider,
			model: message.model
		};
	} catch (error) {
		if (!isSessionTranscriptProjectionUnavailableError(error)) throw error;
	}
}
/** Reads a bounded display or canonical model-context preview before discarding metadata. */
function readSessionPreviewItemsFromTranscript(scope, maxItems, maxChars, view = "display") {
	return buildSqlitePreviewItems(resolveTranscriptReadTarget(scope), maxItems, maxChars, view);
}
//#endregion
export { dropPreSessionStartAnnouncePairs as A, resolveCurrentUserProfileDisplay as C, projectChatDisplayMessages as D, projectChatDisplayMessage as E, projectSessionDisplayMessage as M, stripEnvelopeFromMessage as N, projectChatDisplayMessagesWithState as O, projectTranscriptEntryMessage as S, isPendingAssistantError as T, readTranscriptDisplayDelta as _, readSessionMessageCountAsync as a, attachOpenClawTranscriptMeta as b, readSessionMessagesPageWithStatsAsync as c, readSessionTerminalModelFromTranscript as d, resolveTranscriptReadTarget as f, readSessionTranscriptHistoryAnchorPage as g, visitSessionMessagesAsync as h, readSessionMessageByIdAsync as i, isHeartbeatHistoryTurnBoundaryMessage as j, sanitizeChatHistoryMessages as k, readSessionMessagesWithSourceAsync as l, toTranscriptReadScope as m, readRecentSessionMessagesWithStatsAsync as n, readSessionMessagesAsync as o, sqliteMessageEventWithSeq as p, readRecentSessionUsageFromTranscript as r, readSessionMessagesMatchingIdAsync as s, readLatestSessionUsageFromTranscriptAsync as t, readSessionPreviewItemsFromTranscript as u, ArchivedTranscriptReader as v, createCurrentUserProfileMessageProjector as w, projectSessionMessagePayload as x, capArrayByJsonBytes as y };
