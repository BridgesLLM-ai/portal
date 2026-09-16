import { a as asOptionalRecord } from "./record-coerce-DItp3I4t.js";
import { n as normalizeAgentId } from "./agent-id-CeT3w4ap.js";
import { c as resolveAgentConfig } from "./agent-scope-config-DcbEhP0R.js";
import { _ as scopeLegacySessionKeyToAgent } from "./session-key-BnWWjqNc.js";
import { t as isIncognitoSessionKey } from "./incognito-session-key-BwpD1Lwd.js";
import { t as formatErrorMessage } from "./errors-Db3Ymjlb.js";
import { o as measureDiagnosticsTimelineSpan, s as measureDiagnosticsTimelineSpanSync } from "./diagnostics-timeline-CRX1LXmg.js";
import { b as findModelCatalogEntry } from "./model-selection-shared-BlLyx1r2.js";
import { _ as resolveSessionAgentId } from "./agent-scope-DbtJyKUL.js";
import { t as ErrorCodes } from "./gateway-error-details-w0nAGBBp.js";
import { G as validateChatMessageGetParams, J as validateChatStartupParams, K as validateChatMetadataParams, U as validateChatHistoryParams, W as validateChatInjectParams, Y as validateChatToolTitlesParams } from "./src-BiL5aQto.js";
import { d as errorShape } from "./error-codes-Bo8q2D1o.js";
import { n as CHAT_PENDING_INPUT_MESSAGE_PREFIX, t as CHAT_HISTORY_MAX_ENTRIES } from "./chat-history-constants-C-H8nkgi.js";
import { i as jsonUtf8BytesOrInfinity, r as jsonUtf8Bytes } from "./json-utf8-bytes-fm9i4b7G.js";
import "./model-catalog-DOgUhUHe.js";
import { $t as listSessionPendingInputs, M as isSessionTranscriptProjectionUnavailableError, Qt as listSessionPendingInputReceipts, en as readSessionPendingInput, ot as resolveSessionTranscriptActiveLeafEntryId } from "./session-accessor-YsytfDtG.js";
import { v as resolveSessionKeyBySessionId } from "./session-accessor.sqlite-entry-CWk3jL7s.js";
import { n as beginSessionWorkAdmission } from "./session-lifecycle-admission-CS8v45tk.js";
import { a as MAX_PAYLOAD_BYTES, u as getMaxChatHistoryMessagesBytes } from "./server-constants-BrVEC7RW.js";
import { t as resolveConfiguredThinkingDefault } from "./model-thinking-default-1g_x1V4J.js";
import { S as resolveActiveEmbeddedRunOwner, b as resolveActiveEmbeddedRunHandleSessionId } from "./runs-Cb42qain.js";
import "./sessions-9nxpeTwt.js";
import { f as resolveSessionWorkStartError } from "./lifecycle-BaroCBMc.js";
import { A as augmentChatHistoryWithCanvasBlocks, C as createCurrentUserProfileMessageProjector, O as dropPreSessionStartAnnouncePairs, S as resolveCurrentUserProfileDisplay, T as projectChatDisplayMessages, _ as ArchivedTranscriptReader, b as projectSessionMessagePayload, d as resolveTranscriptReadTarget, g as readTranscriptDisplayDelta, h as readSessionTranscriptHistoryAnchorPage, i as readSessionMessageByIdAsync, k as isHeartbeatHistoryTurnBoundaryMessage, o as readSessionMessagesAsync, p as toTranscriptReadScope, v as capArrayByJsonBytes, w as projectChatDisplayMessage, x as projectTranscriptEntryMessage } from "./session-transcript-readers-CYDRQsH5.js";
import { f as resolveEffectiveChatHistoryMaxChars } from "./chat-display-projection.helpers-DYkWC7LH.js";
import { n as resolveSessionModelRef } from "./session-model-ref-CPZiclLt.js";
import { t as getSessionDefaults } from "./session-utils-model-BYAclq2V.js";
import { i as buildGatewaySessionInfo } from "./session-utils-list-B0k8KJn5.js";
import { i as tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent-CCRSEGCB.js";
import { i as loadGatewaySessionEntryReadOnly, r as loadGatewaySessionEntry } from "./session-utils-store-CInT2loy.js";
import "./session-utils-Cai0_C6U.js";
import { i as prepareSessionSharing } from "./session-sharing-B7MI8hNo.js";
import { a as runWithCronCreatorAuthorityCapability, i as createCronCreatorAuthorityCapability } from "./cron-creator-authority-context-CkDgGats.js";
import { d as resolveInFlightRunSnapshot, o as projectInFlightRunSnapshot, r as boundInFlightRunSnapshotForChatHistory } from "./chat-abort-qLn3eFOg.js";
import { t as logLargePayload } from "./diagnostic-payload-B51qzY4j.js";
import { t as formatForLog } from "./ws-log-Dkg9wKNU.js";
import { l as resolveClaudeCliBindingSessionId } from "./cli-session-history.claude-5nFgZ0im.js";
import { n as resolveChatHistoryWithCliSessionImports, t as readChatHistoryCliSessionImportSnapshot } from "./cli-session-history-CfRW-vJa.js";
import { d as resolveRequestedChatAgentId, f as validateChatSelectedAgent, h as sendGlobalAwareNodeChatPayload, m as resolveGlobalAwareNodeChatDeliveryKeys, t as handleChatSend } from "./chat-send-handler-Dpw17Gmy.js";
import { n as readTranscriptDisplayPosition, t as composeTranscriptDisplay } from "./transcript-display-position-3BMmjSOO.js";
import { n as buildGatewaySessionSnapshot } from "./session-event-payload-COi33-eM.js";
import { t as resolveSessionKeyFromResolveParams } from "./sessions-resolve-CjCEkUZ8.js";
import { a as prepareSessionWorkspaceIcon } from "./workspace-icon-http-B9NCfRKP.js";
import { n as readChatHistoryMessageSeq, r as readIncrementalChatHistoryTail, t as dropChatHistoryOverreadContextMessage } from "./session-history-tail-BuFrV1Wb.js";
import { t as ModelAccountConnectAuthorityError } from "./model-account-connect-BqlZBB8r.js";
import { t as resolveAgentIdOrRespondError } from "./agent-id-shared-MLgRqPvR.js";
import { n as resolveAuthenticatedProfileId } from "./users-profile-access-Cefbw_TB.js";
import { t as preparePersonalModelAccountSelection } from "./users-model-account-access-B9iXjlLs.js";
import { t as assertValidParams } from "./validation-pzrlzFvo.js";
import { h as normalizeOptionalChatText } from "./chat-abort-runtime-CKI3fkKr.js";
import { i as resolveVisibleActiveSessionRunState } from "./session-active-runs-CCNuJW7B.js";
import { t as resolveGatewayModelSelectionPolicy } from "./session-model-selection-policy-BiBt__vw.js";
import { n as readSessionPlacementFields } from "./session-placement-read-projection-eZkSl0va.js";
import { t as appendAssistantTranscriptMessage } from "./chat-transcript-persistence-Bo3WmQ0i.js";
import { t as resolveGatewayChatCronCreatorAuthorityAdmission } from "./cron-creator-authority-admission-6ZFDdF9M.js";
//#region src/gateway/server-methods/chat-history-budget.ts
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 131072;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_UNAVAILABLE_SENTINEL = "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";
let chatHistoryOmittedEmitCount = 0;
function createChatHistoryByteCounter() {
	const sizes = /* @__PURE__ */ new Map();
	const messageBytes = (message) => {
		const cached = sizes.get(message);
		if (cached !== void 0) return cached;
		const bytes = jsonUtf8Bytes(message);
		sizes.set(message, bytes);
		return bytes;
	};
	return {
		messageBytes,
		messagesBytes: (messages) => 2 + messages.reduce((bytes, message) => bytes + messageBytes(message), 0) + Math.max(0, messages.length - 1)
	};
}
function buildChatHistoryUnavailableSentinel() {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [{
			type: "text",
			text: CHAT_HISTORY_UNAVAILABLE_SENTINEL
		}]
	};
}
function buildOversizedHistoryPlaceholder(message) {
	const role = message && typeof message === "object" && typeof message.role === "string" ? message.role : "assistant";
	const timestamp = message && typeof message === "object" && typeof message.timestamp === "number" ? message.timestamp : Date.now();
	const rawMetadata = message && typeof message === "object" ? message["__openclaw"] : void 0;
	const metadata = rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata) ? rawMetadata : {};
	const metadataId = typeof metadata.id === "string" ? metadata.id : void 0;
	const metadataSeq = typeof metadata.seq === "number" ? metadata.seq : void 0;
	const metadataIdempotencyKey = typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : void 0;
	const turnBoundary = metadata.turnBoundary === true;
	const transcriptPosition = readTranscriptDisplayPosition(metadata.transcriptPosition);
	return {
		role,
		timestamp,
		content: [{
			type: "text",
			text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER
		}],
		__openclaw: {
			...metadataId ? { id: metadataId } : {},
			...metadataSeq !== void 0 ? { seq: metadataSeq } : {},
			...metadataIdempotencyKey ? { idempotencyKey: metadataIdempotencyKey } : {},
			...turnBoundary ? { turnBoundary: true } : {},
			...transcriptPosition ? { transcriptPosition } : {},
			truncated: true,
			reason: "oversized"
		}
	};
}
function replaceOversizedChatHistoryMessages(params) {
	const { messages, maxSingleMessageBytes } = params;
	const byteCounter = params.byteCounter ?? createChatHistoryByteCounter();
	if (messages.length === 0) return {
		messages,
		replacedCount: 0
	};
	let replacedCount = 0;
	const next = messages.map((message) => {
		if (byteCounter.messageBytes(message) <= maxSingleMessageBytes) return message;
		replacedCount += 1;
		const placeholder = buildOversizedHistoryPlaceholder(message);
		return byteCounter.messageBytes(placeholder) <= maxSingleMessageBytes ? placeholder : buildChatHistoryUnavailableSentinel();
	});
	return {
		messages: replacedCount > 0 ? next : messages,
		replacedCount
	};
}
function reportOmittedChatHistory(params) {
	const { originalMessages, finalMessages, getNormalizedBytes, maxHistoryBytes, logDebug } = params;
	const survivors = new Set(finalMessages);
	let omittedCount = 0;
	for (const message of originalMessages) if (!survivors.has(message)) omittedCount += 1;
	if (omittedCount === 0) return 0;
	chatHistoryOmittedEmitCount += omittedCount;
	logLargePayload({
		surface: "gateway.chat.history",
		action: "truncated",
		bytes: getNormalizedBytes(),
		limitBytes: maxHistoryBytes,
		count: omittedCount,
		reason: "chat_history_budget"
	});
	logDebug(`chat.history omitted oversized payloads count=${omittedCount} total=${chatHistoryOmittedEmitCount}`);
	return omittedCount;
}
//#endregion
//#region src/gateway/server-methods/chat-history-delta.ts
const CHAT_HISTORY_DELTA_MAX_EVENTS = 200;
const CHAT_HISTORY_DELTA_MAX_BYTES = 1e6;
function readMessageEvent(event) {
	const record = asOptionalRecord(event);
	if (!record) return;
	if (record.message === void 0) return;
	return {
		message: record.message,
		...typeof record.id === "string" && record.id ? { messageId: record.id } : {}
	};
}
function containsTranscriptDiscontinuity(result) {
	return result.events.some((row) => {
		const event = asOptionalRecord(row.event);
		if (!event) return false;
		const type = event.type;
		return type === "reset" || type === "compaction";
	});
}
function readChatHistoryDelta(params) {
	const maxBytes = Math.min(params.maxBytes ?? Infinity, CHAT_HISTORY_DELTA_MAX_BYTES);
	const result = readTranscriptDisplayDelta(params.scope, {
		cursor: params.cursor,
		maxBytes,
		maxEvents: CHAT_HISTORY_DELTA_MAX_EVENTS
	});
	if (result.kind !== "page" || result.hasMore || containsTranscriptDiscontinuity(result)) return { kind: "reset" };
	let projectionState = {
		streamErrorFallbackPending: false,
		turnBoundaryPending: false
	};
	const projectCurrentUserProfile = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
	const messages = [];
	let messagesBytes = 2;
	for (const row of result.events) {
		const event = readMessageEvent(row.event);
		if (!event || row.messageSeq === void 0) continue;
		const projected = projectSessionMessagePayload({
			agentId: params.agentId,
			message: event.message,
			...event.messageId ? { messageId: event.messageId } : {},
			messageSeq: row.messageSeq,
			transcriptPosition: row.displayPosition,
			projectionState,
			projectCurrentUserProfile,
			sessionKey: params.sessionKey,
			sessionSnapshot: params.sessionSnapshot
		});
		projectionState = projected.projectionState;
		if (projected.payload) {
			messagesBytes += jsonUtf8BytesOrInfinity(projected.payload) + (messages.length > 0 ? 1 : 0);
			if (messagesBytes > maxBytes) return { kind: "reset" };
			messages.push(projected.payload);
		}
	}
	return {
		activeLeafEntryId: result.activeLeafEntryId,
		deltaCursor: result.cursor,
		kind: "delta",
		messages: composeTranscriptDisplay(messages, (envelope) => envelope.message)
	};
}
//#endregion
//#region src/gateway/session-transcript-anchor-reader.ts
/** Reads one message-id-anchored page from a single transcript snapshot. */
async function readSessionMessagesAroundIdWithStatsAsync(scope, opts) {
	const target = resolveTranscriptReadTarget(scope);
	const sessionFile = !scope.sessionFile && scope.sessionEntry?.sessionId && scope.sessionEntry.sessionId !== scope.sessionId ? void 0 : target.sessionFile;
	const page = readSessionTranscriptHistoryAnchorPage(toTranscriptReadScope(target), opts);
	if (!page.found) {
		if (opts.allowResetArchiveFallback === true) return await new ArchivedTranscriptReader({
			agentId: target.agentId,
			sessionFile,
			sessionId: target.sessionId,
			storePath: target.storePath
		}).readAroundId({
			...opts,
			resetArchiveOnly: true
		});
		return {
			found: false,
			hasOverreadContext: false,
			messages: [],
			offset: 0,
			totalMessages: page.totalMessages,
			transcriptPath: target.sessionFile
		};
	}
	return {
		found: true,
		displaySource: page.displaySource,
		hasOverreadContext: page.hasOverreadContext,
		messages: page.events.flatMap((entry) => {
			const message = projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
			return message === void 0 ? [] : [message];
		}),
		offset: page.offset,
		totalMessages: page.totalMessages,
		transcriptPath: target.sessionFile
	};
}
//#endregion
//#region src/gateway/server-methods/chat-history-pages.ts
function readChatHistoryMessageId(message) {
	const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
	return typeof metadata?.id === "string" ? metadata.id : void 0;
}
function resolveChatHistoryNextOffset(params) {
	const oldestSeq = params.messages.map((message) => readChatHistoryMessageSeq(message)).find((seq) => typeof seq === "number");
	if (oldestSeq === void 0) return params.offset + params.rawPageMessages;
	const recordOffset = params.totalMessages - oldestSeq + 1;
	const replayOffset = recordOffset - 1;
	if (params.replayOldestRecord && replayOffset > params.offset) return replayOffset;
	return Math.max(params.offset + 1, recordOffset);
}
function shouldReplayOldestChatHistoryRecord(params) {
	const oldestSeq = params.bounded.map((message) => readChatHistoryMessageSeq(message)).find((seq) => typeof seq === "number");
	return oldestSeq !== void 0 && params.bounded.filter((message) => readChatHistoryMessageSeq(message) === oldestSeq).length < params.projected.filter((message) => readChatHistoryMessageSeq(message) === oldestSeq).length;
}
function resolveChatHistoryActiveLeafEntryId(readPage) {
	if (readPage.transcriptSource !== "active") return null;
	if (Object.hasOwn(readPage, "activeLeafEntryId")) return readPage.activeLeafEntryId ?? null;
	return resolveSessionTranscriptActiveLeafEntryId(readPage.transcriptEvents ?? []) ?? null;
}
/** Add checkpoint token metrics to the synthetic transcript compaction marker. */
function enrichChatHistoryCompactionMarkers(messages, entry) {
	const checkpoints = entry?.compactionCheckpoints;
	if (!Array.isArray(checkpoints) || checkpoints.length === 0) return messages;
	const checkpointByEntryId = new Map(checkpoints.flatMap((checkpoint) => {
		const entryId = checkpoint.postCompaction?.entryId;
		return typeof entryId === "string" && entryId ? [[entryId, checkpoint]] : [];
	}));
	let changed = false;
	const enriched = messages.map((message) => {
		const record = asOptionalRecord(message);
		const metadata = asOptionalRecord(record?.["__openclaw"]);
		if (metadata?.kind !== "compaction" || typeof metadata.id !== "string") return message;
		const checkpoint = checkpointByEntryId.get(metadata.id);
		if (!checkpoint) return message;
		const tokensBefore = checkpoint.tokensBefore;
		const tokensAfter = checkpoint.tokensAfter;
		if ((typeof tokensBefore !== "number" || !Number.isFinite(tokensBefore)) && (typeof tokensAfter !== "number" || !Number.isFinite(tokensAfter))) return message;
		changed = true;
		return {
			...record,
			__openclaw: {
				...metadata,
				...typeof tokensBefore === "number" && Number.isFinite(tokensBefore) ? { tokensBefore } : {},
				...typeof tokensAfter === "number" && Number.isFinite(tokensAfter) ? { tokensAfter } : {}
			}
		};
	});
	return changed ? enriched : messages;
}
function resolveChatHistoryMessageGroup(messages, index, messageCost) {
	const seq = readChatHistoryMessageSeq(messages[index]);
	let start = index;
	let end = index + 1;
	let cost = messageCost(messages[index]);
	if (seq === void 0) return {
		start,
		end,
		cost
	};
	while (start > 0 && readChatHistoryMessageSeq(messages[start - 1]) === seq) {
		start -= 1;
		cost += messageCost(messages[start]);
	}
	while (end < messages.length && readChatHistoryMessageSeq(messages[end]) === seq) {
		cost += messageCost(messages[end]);
		end += 1;
	}
	return {
		start,
		end,
		cost
	};
}
function capChatHistoryAroundMessage(params) {
	const anchorIndex = params.messages.findIndex((message) => readChatHistoryMessageId(message) === params.messageId);
	if (anchorIndex === -1) return [];
	const messageCost = params.messageCost ?? (() => 1);
	const anchorGroup = resolveChatHistoryMessageGroup(params.messages, anchorIndex, messageCost);
	if (!(anchorGroup.cost <= params.maxCost)) return [params.messages[anchorIndex]];
	let { start, end, cost } = anchorGroup;
	let canGrowOlder = start > 0;
	let canGrowNewer = end < params.messages.length;
	while (canGrowOlder || canGrowNewer) {
		if (canGrowOlder) {
			const olderGroup = resolveChatHistoryMessageGroup(params.messages, start - 1, messageCost);
			if (cost + olderGroup.cost <= params.maxCost) {
				start = olderGroup.start;
				cost += olderGroup.cost;
			} else canGrowOlder = false;
		}
		canGrowOlder &&= start > 0;
		if (canGrowNewer) {
			const newerGroup = resolveChatHistoryMessageGroup(params.messages, end, messageCost);
			if (cost + newerGroup.cost <= params.maxCost) {
				end = newerGroup.end;
				cost += newerGroup.cost;
			} else canGrowNewer = false;
		}
		canGrowNewer &&= end < params.messages.length;
	}
	return params.messages.slice(start, end);
}
async function readChatHistoryPage(params) {
	const { entry, provider, sessionId, storePath, sessionAgentId, canonicalKey, max, maxHistoryBytes, effectiveMaxChars, offset, messageId } = params;
	if (!sessionId || !storePath) {
		if (messageId) return { messages: [] };
		return {
			...(offset ?? 0) === 0 ? { activeLeafEntryId: null } : {},
			messages: [],
			...offset !== void 0 ? { responseOffset: offset } : {},
			pagination: {
				offset: offset ?? 0,
				totalMessages: 0,
				rawPageMessages: 0
			}
		};
	}
	const readScope = {
		agentId: sessionAgentId,
		sessionEntry: entry,
		sessionId,
		sessionKey: canonicalKey,
		storePath
	};
	const cliSessionId = params.ignoreCliSessionImports ? void 0 : resolveClaudeCliBindingSessionId(entry);
	if ((offset !== void 0 || messageId) && !cliSessionId) {
		let pageOffset = offset ?? 0;
		let hasOverreadContext = false;
		let readPage;
		let incrementalTail;
		if (messageId) {
			const anchoredPage = await readSessionMessagesAroundIdWithStatsAsync(readScope, {
				messageId,
				maxMessages: max,
				allowResetArchiveFallback: true
			});
			if (!anchoredPage.found) return { messages: [] };
			pageOffset = anchoredPage.offset;
			hasOverreadContext = anchoredPage.hasOverreadContext;
			readPage = anchoredPage;
		} else {
			incrementalTail = await readIncrementalChatHistoryTail({
				entry,
				readScope,
				effectiveMaxChars,
				max,
				maxBytes: maxHistoryBytes,
				offset: pageOffset
			});
			readPage = incrementalTail.readPage;
		}
		const isTailPage = !messageId && pageOffset === 0;
		const overreadContextMessage = incrementalTail ? incrementalTail.overreadContextMessage : hasOverreadContext || readPage.messages.length > max ? readPage.messages[0] : void 0;
		const localMessages = incrementalTail ? incrementalTail.rawMessages : dropChatHistoryOverreadContextMessage(dropPreSessionStartAnnouncePairs(readPage.messages, typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : void 0), overreadContextMessage);
		const rawPageMessages = incrementalTail ? incrementalTail.rawPageMessages : Math.min(max, Math.max(readPage.messages.length, readPage.totalMessages > pageOffset ? 1 : 0));
		const projected = incrementalTail ? incrementalTail.projected : projectChatDisplayMessages(localMessages, {
			includeCommentaryFallbacks: true,
			maxChars: effectiveMaxChars,
			resolveCurrentUserProfileDisplay,
			turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage)
		});
		const windowed = messageId ? capChatHistoryAroundMessage({
			messages: projected,
			messageId,
			maxCost: max
		}) : projected;
		if (messageId) return { messages: augmentChatHistoryWithCanvasBlocks(windowed) };
		return {
			...isTailPage ? {
				activeLeafEntryId: resolveChatHistoryActiveLeafEntryId(readPage),
				...readPage.transcriptSource === "active" && readPage.deltaCursor ? { deltaCursor: readPage.deltaCursor } : {}
			} : {},
			messages: augmentChatHistoryWithCanvasBlocks(windowed),
			responseOffset: pageOffset,
			pagination: {
				offset: pageOffset,
				totalMessages: readPage.totalMessages,
				rawPageMessages
			}
		};
	}
	const incrementalTail = await readIncrementalChatHistoryTail({
		entry,
		readScope,
		effectiveMaxChars,
		max,
		maxBytes: maxHistoryBytes
	});
	const { readPage } = incrementalTail;
	const activeLeafEntryId = resolveChatHistoryActiveLeafEntryId(readPage);
	const localMessagesWithBoundaryFilter = incrementalTail.rawMessages;
	const importedMessages = params.ignoreCliSessionImports ? [] : await readChatHistoryCliSessionImportSnapshot({
		entry,
		provider,
		localMessages: localMessagesWithBoundaryFilter
	});
	const cliHistory = params.ignoreCliSessionImports ? {
		messages: localMessagesWithBoundaryFilter,
		imported: false
	} : resolveChatHistoryWithCliSessionImports({
		entry,
		provider,
		localMessages: localMessagesWithBoundaryFilter,
		preparedImportedMessages: importedMessages
	});
	if ((offset !== void 0 || messageId) && !cliHistory.imported) return readChatHistoryPage({
		...params,
		ignoreCliSessionImports: true
	});
	if (cliHistory.imported) {
		const completeLocalMessages = dropPreSessionStartAnnouncePairs(await readSessionMessagesAsync(readScope, {
			mode: "full",
			reason: "chat.history CLI import merge",
			allowResetArchiveFallback: true
		}), typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : void 0);
		const completeCliHistory = resolveChatHistoryWithCliSessionImports({
			entry,
			provider,
			localMessages: completeLocalMessages,
			preparedImportedMessages: importedMessages
		});
		if (!completeCliHistory.imported) return readChatHistoryPage({
			...params,
			ignoreCliSessionImports: true
		});
		const mergedMessages = dropPreSessionStartAnnouncePairs(completeCliHistory.messages, typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : void 0);
		const displayMessages = projectChatDisplayMessages(mergedMessages, {
			includeCommentaryFallbacks: true,
			maxChars: effectiveMaxChars,
			resolveCurrentUserProfileDisplay
		});
		if (messageId && !displayMessages.some((message) => readChatHistoryMessageId(message) === messageId)) return { messages: [] };
		return {
			activeLeafEntryId,
			messages: augmentChatHistoryWithCanvasBlocks(displayMessages),
			completeCliImport: true,
			pagination: {
				offset: 0,
				totalMessages: mergedMessages.length,
				rawPageMessages: mergedMessages.length,
				exhausted: true
			}
		};
	}
	return {
		activeLeafEntryId,
		...readPage.transcriptSource === "active" && readPage.deltaCursor ? { deltaCursor: readPage.deltaCursor } : {},
		messages: augmentChatHistoryWithCanvasBlocks(incrementalTail.projected),
		pagination: {
			offset: 0,
			totalMessages: readPage.totalMessages,
			rawPageMessages: incrementalTail.rawPageMessages
		}
	};
}
//#endregion
//#region src/gateway/server-methods/chat-session-read.ts
function prepareChatSessionReadResponse({ sessionKey, agentId, snapshot, client, context, method, respond }) {
	const expectedSessionId = snapshot.entry?.sessionId;
	const expectedKey = snapshot.canonicalKey;
	const expectedStorePath = snapshot.storePath;
	const canRead = (current) => {
		const filter = prepareSessionSharing({
			cfg: context.getRuntimeConfig(),
			client
		}).entryFilter;
		if (filter && (!current.entry || !filter(current.canonicalKey, current.entry))) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, 'Session "' + sessionKey + '" was not found.'));
			return false;
		}
		return true;
	};
	if (!canRead(snapshot)) return;
	return (ok, value, error, meta) => {
		if (ok) {
			// Caller facts and the selected entry must be fresh after asynchronous reads.
			const current = loadGatewaySessionEntryReadOnly(sessionKey, {
				agentId,
				clone: false,
				projection: "list"
			});
			if (!canRead(current)) return;
			if (current.canonicalKey !== expectedKey || current.storePath !== expectedStorePath || current.entry?.sessionId !== expectedSessionId) {
				respondChatHistoryUnavailable(method, respond);
				return;
			}
		}
		respond(ok, value, error, meta);
	};
}
//#endregion
//#region src/gateway/server-methods/chat-metadata-handler.ts
async function handleChatMetadataRequest({ params, respond, context, client, signal }) {
	if (!assertValidParams(params, validateChatMetadataParams, "chat.metadata", respond)) return;
	const metadataParams = params;
	const cfg = context.getRuntimeConfig();
	if (metadataParams.sessionKey) {
		const requested = resolveRequestedChatAgentId({
			cfg,
			requestedSessionKey: metadataParams.sessionKey,
			agentId: metadataParams.agentId
		});
		if (!requested.ok) {
			respond(false, void 0, requested.error);
			return;
		}
		const session = loadGatewaySessionEntryReadOnly(metadataParams.sessionKey, {
			agentId: requested.agentId,
			projection: "list"
		});
		const readRespond = prepareChatSessionReadResponse({
			sessionKey: metadataParams.sessionKey,
			agentId: requested.agentId,
			snapshot: session,
			client,
			context,
			method: "chat.metadata",
			respond
		});
		if (!readRespond) return;
		readRespond(true, await context.readChatMetadata({
			agentId: resolveSessionAgentId({
				sessionKey: metadataParams.sessionKey,
				config: session.cfg,
				agentId: requested.agentId
			}),
			sessionKey: session.canonicalKey,
			sessionEntry: session.entry,
			requesterProfileId: resolveAuthenticatedProfileId(client)
		}));
		return;
	}
	const resolvedAgent = resolveAgentIdOrRespondError({
		rawAgentId: metadataParams.agentId,
		respond,
		cfg,
		normalize: (rawAgentId) => typeof rawAgentId === "string" && rawAgentId.trim() ? normalizeAgentId(rawAgentId) : void 0
	});
	if (!resolvedAgent) return;
	try {
		const draftAccountSelection = metadataParams.authProfileId ? preparePersonalModelAccountSelection({
			client,
			context,
			signal
		}, metadataParams.authProfileId, "operator.read") : void 0;
		const metadata = await context.readChatMetadata({
			agentId: resolvedAgent.agentId,
			requesterProfileId: draftAccountSelection?.owner ?? resolveAuthenticatedProfileId(client),
			...draftAccountSelection ? { draftAccountSelection } : {}
		});
		draftAccountSelection?.assertCurrent();
		respond(true, metadata);
	} catch (error) {
		if (!(error instanceof ModelAccountConnectAuthorityError)) throw error;
		respond(false, void 0, errorShape(ErrorCodes.FORBIDDEN, error.message));
	}
}
//#endregion
//#region src/gateway/server-methods/chat-pending-inputs.ts
const PENDING_INPUT_DISPLAY_MAX_BYTES = 131072;
const PENDING_INPUT_CORRELATION_MAX_CHARS = 256;
function projectPendingInputMessage(input, maxChars) {
	const message = projectChatDisplayMessage(input.message, {
		maxChars,
		resolveCurrentUserProfileDisplay
	});
	if (!message) return;
	const metadata = { ...asOptionalRecord(message["__openclaw"]) };
	delete metadata.idempotencyKey;
	delete metadata.runId;
	return {
		...message,
		timestamp: input.acceptedAt,
		idempotencyKey: void 0,
		__openclaw: {
			...metadata,
			id: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}`
		}
	};
}
function readChatPendingInputs(scope, options) {
	const page = listSessionPendingInputs(scope, {
		before: options.before,
		limit: Math.min(options.limit, 20)
	});
	const visible = page.items.flatMap((input) => {
		const message = projectPendingInputMessage(input, options.maxChars);
		return message ? [{
			input,
			message
		}] : [];
	});
	const messages = replaceOversizedChatHistoryMessages({
		messages: visible.map(({ message }) => message),
		maxSingleMessageBytes: Math.floor(PENDING_INPUT_DISPLAY_MAX_BYTES / Math.max(page.items.length, 1))
	}).messages;
	return {
		...page,
		items: visible.map(({ input: item }, index) => {
			const display = {
				id: item.id,
				acceptedAt: item.acceptedAt,
				state: item.state,
				message: messages[index]
			};
			if (item.runId.length <= PENDING_INPUT_CORRELATION_MAX_CHARS) display.runId = item.runId;
			return display;
		})
	};
}
//#endregion
//#region src/gateway/server-methods/chat-history-handler.ts
function respondChatHistoryUnavailable(method, respond) {
	respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "session history is rebuilding; retry shortly", {
		details: { method },
		retryable: true,
		retryAfterMs: 250
	}));
}
function resolveEmbeddedAgentRunRecoverySnapshot(params) {
	const sessionId = params.sessionId ?? resolveActiveEmbeddedRunHandleSessionId(params.canonicalSessionKey) ?? resolveActiveEmbeddedRunHandleSessionId(params.requestedSessionKey);
	if (!sessionId) return;
	const owner = resolveActiveEmbeddedRunOwner(sessionId);
	if (!owner) return;
	return projectInFlightRunSnapshot({
		chatRunState: params.chatRunState,
		runId: owner.runId,
		startedAtMs: owner.startedAtMs,
		sessionAbortable: true
	});
}
async function handleChatHistoryRequest({ params, respond, client, context, method }) {
	if (!assertValidParams(params, validateChatHistoryParams, method, respond)) return;
	const { sessionKey, limit, offset, cursor, messageId, sessionId: requestedSessionId, maxChars, maxBytes, pendingBefore, inputRunIds } = params;
	if (offset !== void 0 && messageId !== void 0) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "offset and messageId cannot be used together"));
		return;
	}
	if (cursor !== void 0 && (offset !== void 0 || messageId !== void 0)) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "cursor cannot be used with offset or messageId"));
		return;
	}
	if (requestedSessionId !== void 0 && messageId === void 0) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId requires messageId"));
		return;
	}
	const requestConfig = context.getRuntimeConfig();
	const agentIdOverride = normalizeOptionalChatText(params.agentId);
	const requestedAgent = resolveRequestedChatAgentId({
		cfg: requestConfig,
		requestedSessionKey: sessionKey,
		agentId: agentIdOverride
	});
	if (!requestedAgent.ok) {
		respond(false, void 0, requestedAgent.error);
		return;
	}
	const { cfg, storePath, store, entry, canonicalKey } = measureDiagnosticsTimelineSpanSync(`gateway.${method}.session_entry`, () => loadGatewaySessionEntryReadOnly(sessionKey, {
		agentId: requestedAgent.agentId,
		clone: false,
		includeStoreChildEntries: true,
		projection: "list"
	}), {
		config: requestConfig,
		phase: method
	});
	const selectedAgent = validateChatSelectedAgent({
		cfg,
		requestedSessionKey: sessionKey,
		explicitAgentId: agentIdOverride
	});
	if (!selectedAgent.ok) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
		return;
	}
	const sessionAgentId = resolveSessionAgentId({
		sessionKey,
		config: cfg,
		agentId: selectedAgent.agentId
	});
	const readRespond = prepareChatSessionReadResponse({
		sessionKey,
		agentId: sessionAgentId,
		snapshot: { entry, canonicalKey, storePath },
		client,
		context,
		method,
		respond
	});
	if (!readRespond) return;
	respond = readRespond;
	if (requestedSessionId) {
		const transcriptSessionKey = resolveSessionKeyBySessionId({
			agentId: sessionAgentId,
			sessionId: requestedSessionId,
			storePath
		});
		if (!transcriptSessionKey || scopeLegacySessionKeyToAgent({
			sessionKey: transcriptSessionKey,
			agentId: sessionAgentId
		}) !== scopeLegacySessionKeyToAgent({
			sessionKey: canonicalKey,
			agentId: sessionAgentId
		})) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId does not belong to sessionKey"));
			return;
		}
	}
	if (method === "chat.startup") prepareSessionWorkspaceIcon({
		sessionKey,
		agentId: sessionAgentId
	}).catch((error) => {
		context.logGateway.debug(`chat.startup continuing without a workspace icon: ${formatErrorMessage(error)}`);
	});
	const readStartupProjection = () => measureDiagnosticsTimelineSpan(`gateway.${method}.startup_projection`, async () => {
		try {
			return await context.readChatStartupProjection?.({
				agentId: sessionAgentId,
				sessionKey: canonicalKey,
				sessionEntry: entry,
				requesterProfileId: resolveAuthenticatedProfileId(client),
				readPolicy: method === "chat.history" ? "ready" : "current"
			});
		} catch (error) {
			context.logGateway.debug(`${method} continuing without prepared startup projection: ${formatErrorMessage(error)}`);
			return;
		}
	}, {
		config: cfg,
		phase: method,
		attributes: { agentId: sessionAgentId }
	});
	const startupProjectionPromise = entry?.authProfileOverride?.trim() ? readStartupProjection() : void 0;
	const sessionId = requestedSessionId ?? entry?.sessionId;
	const historyEntry = requestedSessionId && requestedSessionId !== entry?.sessionId ? void 0 : entry;
	const resolvedSessionModel = resolveSessionModelRef(cfg, entry, sessionAgentId, { allowPluginNormalization: false });
	const max = Math.min(CHAT_HISTORY_MAX_ENTRIES, typeof limit === "number" ? limit : 200);
	const maxHistoryBytes = Math.min(maxBytes ?? Infinity, getMaxChatHistoryMessagesBytes());
	const effectiveMaxChars = resolveEffectiveChatHistoryMaxChars(cfg, maxChars);
	const pendingInputs = sessionId && sessionId === entry?.sessionId ? readChatPendingInputs({
		agentId: sessionAgentId,
		sessionKey: canonicalKey,
		sessionId,
		storePath
	}, {
		before: pendingBefore,
		limit: max,
		maxChars: effectiveMaxChars
	}) : {
		items: [],
		total: 0
	};
	const inputReceipts = inputRunIds ? !messageId && sessionId && sessionId === entry?.sessionId ? listSessionPendingInputReceipts({
		agentId: sessionAgentId,
		sessionKey: canonicalKey,
		sessionId,
		storePath
	}, { runIds: inputRunIds }) : [] : void 0;
	const inputConsumptions = inputReceipts?.flatMap((receipt) => receipt.state === "consumed" ? [{
		runId: receipt.runId,
		consumedByEventId: receipt.consumedByEventId
	}] : []);
	let historyPage;
	try {
		historyPage = cursor ? { messages: [] } : await measureDiagnosticsTimelineSpan(`gateway.${method}.history_page`, () => readChatHistoryPage({
			entry: historyEntry,
			provider: resolvedSessionModel.provider,
			sessionId,
			storePath,
			sessionAgentId,
			canonicalKey,
			max,
			maxHistoryBytes,
			effectiveMaxChars,
			offset,
			messageId
		}), {
			config: cfg,
			phase: method,
			attributes: {
				limit: max,
				hasMessageId: Boolean(messageId),
				hasOffset: offset !== void 0
			}
		});
	} catch (error) {
		if (!isSessionTranscriptProjectionUnavailableError(error)) throw error;
		respondChatHistoryUnavailable(method, respond);
		return;
	}
	const normalized = enrichChatHistoryCompactionMarkers(historyPage.messages, historyEntry);
	const responseHistoryBytes = historyPage.completeCliImport ? getMaxChatHistoryMessagesBytes() : maxHistoryBytes;
	const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, getMaxChatHistoryMessagesBytes());
	const byteCounter = createChatHistoryByteCounter();
	const replaced = replaceOversizedChatHistoryMessages({
		byteCounter,
		messages: normalized,
		maxSingleMessageBytes: perMessageHardCap
	});
	const capped = messageId ? capChatHistoryAroundMessage({
		messages: replaced.messages,
		messageId,
		maxCost: responseHistoryBytes - 1,
		messageCost: (message) => byteCounter.messageBytes(message) + 1
	}) : capArrayByJsonBytes(replaced.messages, responseHistoryBytes, byteCounter.messageBytes).items;
	const historyBudgetPreserved = replaced.replacedCount === 0 && capped.length === normalized.length && capped.every((message, index) => message === normalized[index]);
	const pagination = historyPage.pagination;
	const candidateNextOffset = pagination === void 0 ? void 0 : resolveChatHistoryNextOffset({
		messages: capped,
		totalMessages: pagination.totalMessages,
		offset: pagination.offset,
		rawPageMessages: pagination.rawPageMessages,
		replayOldestRecord: shouldReplayOldestChatHistoryRecord({
			projected: normalized,
			bounded: capped
		})
	});
	const hasMore = pagination !== void 0 && candidateNextOffset !== void 0 ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages : void 0;
	const nextOffset = hasMore ? candidateNextOffset : void 0;
	reportOmittedChatHistory({
		originalMessages: normalized,
		finalMessages: capped,
		getNormalizedBytes: () => byteCounter.messagesBytes(normalized),
		maxHistoryBytes: responseHistoryBytes,
		logDebug: (message) => context.logGateway.debug(message)
	});
	const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
	const startupProjection = await (startupProjectionPromise ?? readStartupProjection());
	const startupMetadata = method === "chat.startup" ? startupProjection?.metadata : void 0;
	const sessionModelCatalog = startupProjection?.sessionModelCatalog;
	const defaultModelCatalog = startupProjection?.defaultModelCatalog;
	const sessionInfo = measureDiagnosticsTimelineSpanSync(`gateway.${method}.session_info`, () => buildGatewaySessionInfo({
		cfg,
		storePath,
		store,
		key: canonicalKey,
		entry,
		agentId: selectedAgent.agentId,
		modelCatalog: sessionModelCatalog
	}), {
		config: cfg,
		phase: method,
		attributes: { storeEntries: Object.keys(store).length }
	});
	const activeRunAgentId = selectedAgent.agentId;
	const activeRunState = resolveVisibleActiveSessionRunState({
		context,
		requestedKey: sessionKey,
		canonicalKey,
		sessionId,
		...activeRunAgentId ? { agentId: activeRunAgentId } : {},
		defaultAgentId: compatibilityOwnerAgentId,
		includeTerminalPersistence: true
	});
	sessionInfo.hasActiveRun = activeRunState.active;
	if (activeRunState.runIds !== void 0) sessionInfo.activeRunIds = activeRunState.runIds;
	if (activeRunState.active) sessionInfo.status = activeRunState.status ?? "running";
	Object.assign(sessionInfo, readSessionPlacementFields(context, entry?.sessionId));
	const embeddedRecovery = resolveEmbeddedAgentRunRecoverySnapshot({
		chatRunState: context.chatRunState,
		requestedSessionKey: sessionKey,
		canonicalSessionKey: canonicalKey,
		sessionId
	});
	if (Object.hasOwn(historyPage, "activeLeafEntryId")) sessionInfo.activeLeafEntryId = historyPage.activeLeafEntryId ?? null;
	const defaults = cursor === void 0 ? {
		...getSessionDefaults(cfg, defaultModelCatalog, {
			agentId: sessionAgentId,
			allowPluginNormalization: false,
			providerPolicySource: "active"
		}),
		modelSelectionTarget: resolveGatewayModelSelectionPolicy({
			agentId: sessionAgentId,
			callerScopes: client?.connect?.scopes ?? [],
			cfg
		}).target
	} : void 0;
	for (const [projection, catalog] of [[sessionInfo, sessionModelCatalog], [defaults, defaultModelCatalog]]) {
		if (!projection) continue;
		const provider = projection.modelProvider;
		const model = projection.model;
		if (typeof (catalog && provider && model ? findModelCatalogEntry(catalog, {
			provider,
			modelId: model
		}) : void 0)?.reasoning === "boolean") continue;
		delete projection.thinkingLevels;
		delete projection.thinkingOptions;
		projection.thinkingDefault = resolveAgentConfig(cfg, sessionAgentId)?.thinkingDefault ?? (provider && model ? resolveConfiguredThinkingDefault({
			cfg,
			provider,
			model
		}) : cfg.agents?.defaults?.thinkingDefault);
	}
	const thinkingLevel = sessionInfo.thinkingLevel ?? sessionInfo.thinkingDefault;
	const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
	sessionInfo.verboseLevel = verboseLevel;
	const inFlightRun = resolveInFlightRunSnapshot({
		chatAbortControllers: context.chatAbortControllers,
		chatRunState: context.chatRunState,
		requestedSessionKey: sessionKey,
		canonicalSessionKey: canonicalKey,
		agentId: activeRunAgentId,
		defaultAgentId: compatibilityOwnerAgentId
	}) ?? embeddedRecovery;
	if (cursor !== void 0) {
		if (!sessionId || !storePath || resolveClaudeCliBindingSessionId(entry)) {
			respond(true, { kind: "reset" });
			return;
		}
		const sessionSnapshot = buildGatewaySessionSnapshot({
			sessionRow: sessionInfo,
			agentId: sessionAgentId,
			includeSession: true,
			activeRunState
		});
		let delta;
		try {
			delta = readChatHistoryDelta({
				agentId: sessionAgentId,
				cursor,
				maxBytes: maxHistoryBytes,
				scope: {
					agentId: sessionAgentId,
					sessionEntry: entry,
					sessionId,
					sessionKey: canonicalKey,
					storePath
				},
				sessionKey: canonicalKey,
				sessionSnapshot
			});
		} catch (error) {
			if (!isSessionTranscriptProjectionUnavailableError(error)) throw error;
			respondChatHistoryUnavailable(method, respond);
			return;
		}
		if (delta.kind === "reset") {
			respond(true, delta);
			return;
		}
		sessionInfo.activeLeafEntryId = delta.activeLeafEntryId;
		const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
			snapshot: inFlightRun,
			messages: delta.messages,
			maxBytes: maxHistoryBytes
		});
		respond(true, {
			kind: "delta",
			messages: delta.messages,
			deltaCursor: delta.deltaCursor,
			pendingInputs,
			...inputReceipts ? {
				inputReceipts,
				inputConsumptions
			} : {},
			sessionInfo,
			...boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {},
			...startupMetadata ? { metadata: startupMetadata } : {}
		});
		return;
	}
	const boundedInFlightRun = boundInFlightRunSnapshotForChatHistory({
		snapshot: inFlightRun,
		messages: capped,
		maxBytes: responseHistoryBytes
	});
	respond(true, {
		sessionKey,
		sessionId,
		messages: composeTranscriptDisplay(capped),
		pendingInputs,
		...inputReceipts ? {
			inputReceipts,
			inputConsumptions
		} : {},
		...historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {},
		...historyPage.responseOffset !== void 0 ? { offset: historyPage.responseOffset } : {},
		...hasMore ? { nextOffset } : {},
		...hasMore !== void 0 ? { hasMore } : {},
		...pagination !== void 0 ? { totalMessages: pagination.totalMessages } : {},
		...historyPage.completeCliImport && !hasMore && historyBudgetPreserved ? { completeSnapshot: true } : {},
		defaults,
		sessionInfo,
		thinkingLevel,
		fastMode: entry?.fastMode,
		toolOverrides: entry?.toolOverrides,
		verboseLevel,
		...boundedInFlightRun ? { inFlightRun: boundedInFlightRun } : {},
		...startupMetadata ? { metadata: startupMetadata } : {}
	});
}
const chatHistoryHandlers = {
	"chat.history": async (opts) => {
		await handleChatHistoryRequest({
			...opts,
			method: "chat.history"
		});
	},
	"chat.startup": async (opts) => {
		if (!assertValidParams(opts.params, validateChatStartupParams, "chat.startup", opts.respond)) return;
		if ("sessionKey" in opts.params) {
			await handleChatHistoryRequest({
				...opts,
				method: "chat.startup"
			});
			return;
		}
		const connId = opts.client?.connId?.trim();
		if (connId) {
			opts.context.subscribeSessionEvents(connId);
			if (!opts.context.getSessionEventSubscriberConnIds().has(connId)) {
				opts.respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, "connection closed before chat startup"));
				return;
			}
		}
		const { shortId, slugHint, agentId, limit, maxBytes } = opts.params;
		const resolution = await resolveSessionKeyFromResolveParams({
			cfg: opts.context.getRuntimeConfig(),
			client: opts.client,
			p: {
				shortId,
				slugHint,
				agentId,
				allowMissing: true
			}
		});
		if (!resolution.ok) {
			opts.respond(false, void 0, resolution.error);
			return;
		}
		if ("missing" in resolution || "ambiguous" in resolution) {
			opts.respond(true, { resolution: {
				ok: false,
				..."ambiguous" in resolution ? { candidates: resolution.candidates } : {}
			} });
			return;
		}
		await handleChatHistoryRequest({
			...opts,
			params: {
				sessionKey: resolution.key,
				agentId: resolution.agentId,
				limit,
				maxBytes
			},
			method: "chat.startup",
			respond: (ok, payload, error, meta) => opts.respond(ok, ok ? {
				...asOptionalRecord(payload),
				resolution
			} : payload, error, meta)
		});
	},
	"chat.metadata": handleChatMetadataRequest
};
//#endregion
//#region src/gateway/server-methods/chat-message-get-handler.ts
async function isChatMessageIdVisibleAfterHistoryFilters(params) {
	if (params.sessionStartedAt === void 0) return true;
	const { messages } = await readSessionMessagesAroundIdWithStatsAsync({
		agentId: params.agentId,
		sessionEntry: params.sessionEntry,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		storePath: params.storePath
	}, {
		maxMessages: 1,
		messageId: params.messageId,
		...params.allowResetArchiveFallback === true ? { allowResetArchiveFallback: true } : {}
	});
	return dropPreSessionStartAnnouncePairs(messages, params.sessionStartedAt).some((message) => readChatHistoryMessageId(message) === params.messageId);
}
const chatMessageGetHandlers = { "chat.message.get": async ({ params, respond, context, client }) => {
	if (!assertValidParams(params, validateChatMessageGetParams, "chat.message.get", respond)) return;
	const { sessionKey, messageId, maxChars } = params;
	const agentIdOverride = normalizeOptionalChatText(params.agentId);
	const requestedAgent = resolveRequestedChatAgentId({
		cfg: context.getRuntimeConfig?.(),
		requestedSessionKey: sessionKey,
		agentId: agentIdOverride
	});
	if (!requestedAgent.ok) {
		respond(false, void 0, requestedAgent.error);
		return;
	}
	const requestedAgentId = requestedAgent.agentId;
	const { cfg, storePath, entry, canonicalKey } = loadGatewaySessionEntryReadOnly(sessionKey, requestedAgentId ? { agentId: requestedAgentId } : void 0);
	const selectedAgent = validateChatSelectedAgent({
		cfg,
		requestedSessionKey: sessionKey,
		explicitAgentId: agentIdOverride
	});
	if (!selectedAgent.ok) {
		respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
		return;
	}
	const readRespond = prepareChatSessionReadResponse({
		sessionKey,
		agentId: selectedAgent.agentId,
		snapshot: { entry, canonicalKey, storePath },
		client,
		context,
		method: "chat.message.get",
		respond
	});
	if (!readRespond) return;
	respond = readRespond;
	const sessionId = entry?.sessionId;
	if (!sessionId) {
		respond(true, {
			ok: false,
			unavailableReason: "not_found"
		});
		return;
	}
	const sessionAgentId = resolveSessionAgentId({
		sessionKey,
		config: cfg,
		agentId: selectedAgent.agentId
	});
	const effectiveMaxChars = typeof maxChars === "number" ? maxChars : Math.min(MAX_PAYLOAD_BYTES, 1e6);
	if (messageId.startsWith("pending:")) {
		const pending = readSessionPendingInput({
			agentId: sessionAgentId,
			sessionKey: canonicalKey,
			sessionId,
			storePath
		}, messageId.slice(CHAT_PENDING_INPUT_MESSAGE_PREFIX.length));
		if (!pending) {
			respond(true, {
				ok: false,
				unavailableReason: "not_found"
			});
			return;
		}
		const message = projectPendingInputMessage(pending, effectiveMaxChars);
		if (!message) {
			respond(true, {
				ok: false,
				unavailableReason: "not_visible"
			});
			return;
		}
		respond(true, jsonUtf8Bytes(message) > 26213376 ? {
			ok: false,
			unavailableReason: "oversized"
		} : {
			ok: true,
			message
		});
		return;
	}
	const resolved = await readSessionMessageByIdAsync({
		agentId: sessionAgentId,
		sessionEntry: entry,
		sessionId,
		sessionKey,
		storePath
	}, messageId, { allowResetArchiveFallback: true });
	if (!resolved.found) {
		respond(true, {
			ok: false,
			unavailableReason: "not_found"
		});
		return;
	}
	if (!await isChatMessageIdVisibleAfterHistoryFilters({
		sessionId,
		storePath,
		sessionEntry: entry,
		sessionKey,
		agentId: sessionAgentId,
		messageId,
		sessionStartedAt: typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : void 0,
		allowResetArchiveFallback: true
	})) {
		respond(true, {
			ok: false,
			unavailableReason: "not_found"
		});
		return;
	}
	if (resolved.oversized) {
		respond(true, {
			ok: false,
			unavailableReason: "oversized"
		});
		return;
	}
	const projectedMessage = resolved.message ? projectChatDisplayMessage(resolved.message, {
		maxChars: effectiveMaxChars,
		resolveCurrentUserProfileDisplay
	}) : void 0;
	const projected = projectedMessage ? augmentChatHistoryWithCanvasBlocks([projectedMessage])[0] : void 0;
	if (!projected) {
		respond(true, {
			ok: false,
			unavailableReason: "not_visible"
		});
		return;
	}
	respond(true, {
		ok: true,
		message: projected
	});
} };
//#endregion
//#region src/gateway/server-methods/chat-send-external-entry.ts
const externalAuthorityAdmission = {
	resolve: (params) => {
		const authority = resolveGatewayChatCronCreatorAuthorityAdmission({
			runId: params.runId,
			resolvedSessionKey: params.sessionKey,
			spawnedBy: params.spawnedBy,
			client: params.client,
			inputProvenance: params.inputProvenance,
			hasExplicitOrigin: params.hasExplicitOrigin,
			hasRestoredCronContinuation: params.hasRestoredCronContinuation,
			isIncognito: params.isIncognitoEntry || isIncognitoSessionKey(params.sessionKey),
			isReconnectResume: params.isReconnectResume,
			isSystemGenerated: params.isSystemGenerated,
			turnKind: params.turnKind,
			isDirectExternalUser: true
		});
		return authority ? createCronCreatorAuthorityCapability(authority.runId, authority.callerOrigin, authority.controlUiAdmin) : void 0;
	},
	run: (capability, run, signal) => runWithCronCreatorAuthorityCapability(capability, run, signal)
};
/** Authenticated external chat entry; internal re-entry must call handleChatSend directly. */
function handleDirectExternalChatSend(options, onAdmissionOwned) {
	return handleChatSend(options, onAdmissionOwned, externalAuthorityAdmission);
}
//#endregion
//#region src/gateway/server-methods/chat.ts
const chatHandlers = {
	...chatHistoryHandlers,
	...chatMessageGetHandlers,
	"chat.toolTitles": async ({ params, respond }) => {
		if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) return;
		respond(true, {
			titles: {},
			disabled: true
		});
	},
	"chat.send": handleDirectExternalChatSend,
	"chat.inject": async ({ params, respond, context }) => {
		if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) return;
		const p = params;
		const rawSessionKey = p.sessionKey;
		const agentIdOverride = normalizeOptionalChatText(p.agentId);
		const requestedAgent = resolveRequestedChatAgentId({
			cfg: context.getRuntimeConfig?.(),
			requestedSessionKey: rawSessionKey,
			agentId: agentIdOverride
		});
		if (!requestedAgent.ok) {
			respond(false, void 0, requestedAgent.error);
			return;
		}
		const requestedAgentId = requestedAgent.agentId;
		const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : void 0;
		const { cfg, storePath, entry, canonicalKey: sessionKey } = loadGatewaySessionEntry(rawSessionKey, sessionLoadOptions);
		const selectedAgent = validateChatSelectedAgent({
			cfg,
			requestedSessionKey: rawSessionKey,
			explicitAgentId: agentIdOverride
		});
		if (!selectedAgent.ok) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, selectedAgent.error));
			return;
		}
		const sessionId = entry?.sessionId;
		if (!sessionId || !storePath) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
			return;
		}
		const agentId = resolveSessionAgentId({
			sessionKey,
			config: cfg,
			agentId: selectedAgent.agentId
		});
		let appended;
		try {
			const admission = await beginSessionWorkAdmission({
				scope: storePath,
				identities: [sessionKey, sessionId],
				assertAllowed: () => {
					const latestEntry = loadGatewaySessionEntry(rawSessionKey, sessionLoadOptions).entry;
					if (!latestEntry) throw new Error(`Session "${sessionKey}" was deleted while starting work. Retry.`);
					if (latestEntry.sessionId !== sessionId) throw new Error(`Session "${sessionKey}" changed while starting work. Retry.`);
					const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry);
					if (archivedError) throw new Error(archivedError);
				}
			});
			try {
				appended = await admission.run(async () => await appendAssistantTranscriptMessage({
					sessionKey,
					message: p.message,
					label: p.label,
					sessionId,
					storePath,
					agentId,
					createIfMissing: true,
					cfg
				}));
			} finally {
				admission.release();
			}
		} catch (err) {
			respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
			return;
		}
		if (!appended.ok || !appended.messageId || !appended.message) {
			respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${appended.error ?? "unknown error"}`));
			return;
		}
		const message = projectChatDisplayMessage(appended.message, { maxChars: resolveEffectiveChatHistoryMaxChars(cfg) });
		const chatPayload = {
			runId: `inject-${appended.messageId}`,
			sessionKey,
			...agentId ? { agentId } : {},
			seq: 0,
			state: "final",
			message
		};
		context.broadcast("chat", chatPayload, { sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({
			cfg,
			sessionKey,
			agentId
		}) });
		sendGlobalAwareNodeChatPayload({
			context,
			sessionKey,
			agentId,
			event: "chat",
			payload: chatPayload
		});
		respond(true, {
			ok: true,
			messageId: appended.messageId
		});
	}
};
//#endregion
export { readChatHistoryPage as a, CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES as c, enrichChatHistoryCompactionMarkers as i, replaceOversizedChatHistoryMessages as l, handleDirectExternalChatSend as n, resolveChatHistoryNextOffset as o, capChatHistoryAroundMessage as r, shouldReplayOldestChatHistoryRecord as s, chatHandlers as t, reportOmittedChatHistory as u };
