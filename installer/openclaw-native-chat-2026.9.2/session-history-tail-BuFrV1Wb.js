import { d as asPositiveSafeInteger } from "./number-coercion-CLj0HTDM.js";
import { a as asOptionalRecord } from "./record-coerce-DItp3I4t.js";
import { j as SessionTranscriptProjectionUnavailableError } from "./session-accessor-YsytfDtG.js";
import { d as resolveTranscriptReadTarget, h as readSessionTranscriptHistoryAnchorPage, p as toTranscriptReadScope, x as projectTranscriptEntryMessage, E as projectChatDisplayMessagesWithState, O as dropPreSessionStartAnnouncePairs, S as resolveCurrentUserProfileDisplay, c as readSessionMessagesPageWithStatsAsync, k as isHeartbeatHistoryTurnBoundaryMessage, n as readRecentSessionMessagesWithStatsAsync } from "./session-transcript-readers-CYDRQsH5.js";
//#region src/gateway/session-history-tail.ts
const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES = 8e3;
const SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES = 100;
const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES = 400;
function readChatHistoryMessageId(message) {
	const id = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
	return typeof id === "string" && id ? id : void 0;
}
function readChatHistoryMessageSeq(message) {
	const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
	return asPositiveSafeInteger(metadata?.seq);
}
function capOffsetChatHistoryProjectedMessages(messages, max) {
	if (messages.length <= max) return messages;
	const start = Math.max(0, messages.length - max);
	const boundarySeq = readChatHistoryMessageSeq(messages[start]);
	if (boundarySeq === void 0) return messages.slice(start);
	let safeStart = start;
	while (safeStart > 0 && readChatHistoryMessageSeq(messages[safeStart - 1]) === boundarySeq) safeStart--;
	return messages.slice(safeStart);
}
function dropChatHistoryOverreadContextMessage(messages, contextMessage) {
	if (contextMessage === void 0) return messages;
	const index = messages.indexOf(contextMessage);
	return index < 0 ? messages : [...messages.slice(0, index), ...messages.slice(index + 1)];
}
/** One-sided active-history page; identity and cursor are checked in the native snapshot. */
async function readChatHistoryBeforeMessages(params) {
	const target = resolveTranscriptReadTarget(params.readScope);
	const page = readSessionTranscriptHistoryAnchorPage(toTranscriptReadScope(target), {
		direction: "before",
		messageId: params.anchorId,
		maxMessages: params.limit,
		displaySource: params.displaySource
	});
	return page.events.flatMap((entry) => {
		const message = projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
		return message === void 0 ? [] : [message];
	});
}
/** Scans indexed transcript records until one bounded visible history page is filled. */
async function readIncrementalChatHistoryTail(params) {
	const offset = params.offset ?? 0;
	const rawHistoryWindowMessages = Math.max(1, Math.floor(params.max)) * 20 + 20;
	const initialMessages = params.preserveProjectionContext && offset === 0 ? rawHistoryWindowMessages : Math.min(rawHistoryWindowMessages, Math.max(1, offset === 0 ? params.max * 3 : params.max));
	const readPage = offset === 0 ? await readRecentSessionMessagesWithStatsAsync(params.readScope, {
		maxMessages: initialMessages + 1,
		maxLines: initialMessages + 1,
		maxBytes: Math.max(params.maxBytes * 2, 1048576),
		allowResetArchiveFallback: true
	}) : await readSessionMessagesPageWithStatsAsync(params.readScope, {
		offset,
		maxMessages: initialMessages + 1,
		allowResetArchiveFallback: true
	});
	const sessionStartedAt = typeof params.entry?.sessionStartedAt === "number" ? params.entry.sessionStartedAt : void 0;
	let rawPageMessages = Math.min(initialMessages, Math.max(readPage.messages.length, readPage.totalMessages > offset ? 1 : 0));
	let overreadContextMessage = readPage.messages.length > initialMessages ? readPage.messages[0] : void 0;
	let rawMessages = dropChatHistoryOverreadContextMessage(readPage.messages, overreadContextMessage);
	const project = (messages = rawMessages, contextMessage = overreadContextMessage, resolveProfileDisplay = true) => {
		const filteredRawMessages = sessionStartedAt === void 0 ? messages : dropChatHistoryOverreadContextMessage(dropPreSessionStartAnnouncePairs(contextMessage === void 0 ? messages : [contextMessage, ...messages], sessionStartedAt), contextMessage);
		const projection = projectChatDisplayMessagesWithState(filteredRawMessages, {
			includeCommentaryFallbacks: true,
			maxChars: params.effectiveMaxChars,
			...resolveProfileDisplay ? { resolveCurrentUserProfileDisplay } : {},
			turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(contextMessage)
		});
		return {
			filteredRawMessages,
			projected: offset === 0 ? projection.messages.length > params.max ? projection.messages.slice(-params.max) : projection.messages : capOffsetChatHistoryProjectedMessages(projection.messages, params.max),
			projection
		};
	};
	let result = project();
	let estimatedVisibleMessages = result.projected.length;
	let projectionDirty = false;
	let scanLimit = rawHistoryWindowMessages;
	let scannedBytes = 0;
	let keysetStarted = false;
	let nextChunkMessages = SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES;
	while (offset + rawPageMessages < readPage.totalMessages) {
		if (projectionDirty && estimatedVisibleMessages >= params.max) {
			result = project();
			projectionDirty = false;
			estimatedVisibleMessages = result.projected.length;
		}
		if (result.projected.length >= params.max) break;
		if (rawPageMessages >= rawHistoryWindowMessages) scanLimit = rawHistoryWindowMessages + SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES;
		if (rawPageMessages >= scanLimit) break;
		const chunkMessages = Math.min(nextChunkMessages, scanLimit - rawPageMessages);
		const oldestId = readChatHistoryMessageId(rawMessages[0]);
		const keysetAnchorId = oldestId?.trim();
		const useKeyset = readPage.transcriptSource === "active" && Boolean(keysetAnchorId);
		// A prior yield makes newest-relative offsets unsafe after cursor loss.
		if (keysetStarted && !useKeyset) throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
		if (useKeyset) {
			keysetStarted = true;
			await new Promise((resolve) => setImmediate(resolve));
		}
		const page = useKeyset ? {
			...readPage,
			messages: await readChatHistoryBeforeMessages({
				anchorId: keysetAnchorId,
				limit: chunkMessages + 1,
				readScope: params.readScope,
				displaySource: readPage.displaySource
			})
		} : await readSessionMessagesPageWithStatsAsync(params.readScope, {
			offset: offset + rawPageMessages,
			maxMessages: chunkMessages + 1,
			allowResetArchiveFallback: true
		});
		if (page.displaySource !== readPage.displaySource) throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
		if (page.messages.length === 0) break;
		const contextMessage = page.messages.length > chunkMessages ? page.messages[0] : void 0;
		const chunkRawMessages = dropChatHistoryOverreadContextMessage(page.messages, contextMessage);
		rawPageMessages += chunkRawMessages.length;
		rawMessages = chunkRawMessages.concat(rawMessages);
		overreadContextMessage = contextMessage;
		estimatedVisibleMessages += project(chunkRawMessages, contextMessage, false).projection.messages.length;
		projectionDirty = true;
		scannedBytes += Buffer.byteLength(JSON.stringify(page.messages), "utf8");
		if (rawPageMessages > rawHistoryWindowMessages && scannedBytes >= params.maxBytes) break;
		nextChunkMessages = Math.min(nextChunkMessages * 2, SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES);
	}
	if (projectionDirty) result = project();
	return {
		overreadContextMessage,
		projected: result.projected,
		projection: result.projection,
		rawMessages: result.filteredRawMessages,
		rawPageMessages,
		readPage
	};
}
//#endregion
export { readChatHistoryMessageSeq as n, readIncrementalChatHistoryTail as r, dropChatHistoryOverreadContextMessage as t };
