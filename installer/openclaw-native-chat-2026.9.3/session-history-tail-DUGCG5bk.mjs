import { d as asPositiveSafeInteger } from "./number-coercion-CLj0HTDM.mjs";
import { a as asOptionalRecord } from "./record-coerce-DItp3I4t.mjs";
import { E as SessionTranscriptProjectionUnavailableError } from "./session-accessor-CX17Bx59.mjs";
import { A as dropPreSessionStartAnnouncePairs, C as resolveCurrentUserProfileDisplay, O as projectChatDisplayMessagesWithState, S as projectTranscriptEntryMessage, c as readSessionMessagesPageWithStatsAsync, f as resolveTranscriptReadTarget, g as readSessionTranscriptHistoryAnchorPage, j as isHeartbeatHistoryTurnBoundaryMessage, m as toTranscriptReadScope, n as readRecentSessionMessagesWithStatsAsync, v as ArchivedTranscriptReader } from "./session-transcript-readers-DZrB96ki.mjs";
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
async function readAdjacentChatHistoryMessages(params) {
	const page = await readSessionMessagesAroundIdWithStatsAsync(params.readScope, {
		messageId: params.anchorId,
		maxMessages: params.limit * 2 + 1,
		allowResetArchiveFallback: true
	});
	if (!page.found || page.displaySource !== params.displaySource) throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
	const anchorIndex = page.messages.findIndex((message) => readChatHistoryMessageId(message) === params.anchorId);
	if (anchorIndex < 0) throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
	return params.direction === "newer" ? page.messages.slice(anchorIndex + 1, anchorIndex + 1 + params.limit) : page.messages.slice(Math.max(0, anchorIndex - params.limit), anchorIndex);
}
/** Resolve only the newer turn context a historical page needs to classify its pending error. */
async function readChatHistoryRecoveryContext(params) {
	const context = [];
	let anchorId = readChatHistoryMessageId(params.messages.at(-1));
	let scannedBytes = 0;
	while (anchorId && context.length < SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES) {
		const chunkSize = Math.min(SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES, SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES - context.length);
		const newer = await readAdjacentChatHistoryMessages({
			anchorId,
			direction: "newer",
			limit: chunkSize,
			readScope: params.readScope,
			displaySource: params.displaySource
		});
		if (newer.length === 0) break;
		let boundaryReached = false;
		for (const message of newer) {
			scannedBytes += Buffer.byteLength(JSON.stringify(message), "utf8");
			if (scannedBytes > params.maxBytes) return context;
			context.push(message);
			if (asOptionalRecord(message)?.role === "user") {
				boundaryReached = true;
				break;
			}
		}
		if (boundaryReached || !params.project([...params.messages, ...context]).assistantErrorPending) break;
		anchorId = readChatHistoryMessageId(context.at(-1));
	}
	return context;
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
	let recoveryContext = offset === 0 ? [] : void 0;
	const newestPageSeq = readChatHistoryMessageSeq(rawMessages.at(-1));
	const project = (messages = rawMessages, contextMessage = overreadContextMessage, resolveProfileDisplay = true, newerContext = recoveryContext ?? []) => {
		const filteredRawMessages = sessionStartedAt === void 0 ? messages : dropChatHistoryOverreadContextMessage(dropPreSessionStartAnnouncePairs(contextMessage === void 0 ? messages : [contextMessage, ...messages], sessionStartedAt), contextMessage);
		const projection = projectChatDisplayMessagesWithState(newerContext.length > 0 ? [...filteredRawMessages, ...newerContext] : filteredRawMessages, {
			includeCommentaryFallbacks: true,
			maxChars: params.effectiveMaxChars,
			...resolveProfileDisplay ? { resolveCurrentUserProfileDisplay } : {},
			turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(contextMessage)
		});
		if (newerContext.length > 0) projection.messages = projection.messages.filter((message) => (readChatHistoryMessageSeq(message) ?? Infinity) <= (newestPageSeq ?? -1));
		return {
			filteredRawMessages,
			projected: offset === 0 ? projection.messages.length > params.max ? projection.messages.slice(-params.max) : projection.messages : capOffsetChatHistoryProjectedMessages(projection.messages, params.max),
			projection
		};
	};
	const projectWindow = async () => {
		const result = project();
		if (recoveryContext !== void 0 || newestPageSeq === void 0 || !result.projection.assistantErrorPending) return result;
		recoveryContext = await readChatHistoryRecoveryContext({
			messages: result.filteredRawMessages,
			project: (messages) => project(messages, overreadContextMessage, true, []).projection,
			readScope: params.readScope,
			displaySource: readPage.displaySource,
			maxBytes: params.maxBytes
		});
		return project();
	};
	let result = await projectWindow();
	let estimatedVisibleMessages = result.projected.length;
	let projectionDirty = false;
	let scanLimit = rawHistoryWindowMessages;
	let scannedBytes = 0;
	let keysetStarted = false;
	let nextChunkMessages = SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES;
	while (offset + rawPageMessages < readPage.totalMessages) {
		if (projectionDirty && estimatedVisibleMessages >= params.max) {
			result = await projectWindow();
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
		} : offset > 0 && recoveryContext !== void 0 && oldestId ? {
			...readPage,
			messages: await readAdjacentChatHistoryMessages({
				anchorId: oldestId,
				direction: "older",
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
		estimatedVisibleMessages += project(chunkRawMessages, contextMessage, false, []).projection.messages.length;
		projectionDirty = true;
		scannedBytes += Buffer.byteLength(JSON.stringify(page.messages), "utf8");
		if (rawPageMessages > rawHistoryWindowMessages && scannedBytes >= params.maxBytes) break;
		nextChunkMessages = Math.min(nextChunkMessages * 2, SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES);
	}
	if (projectionDirty) result = await projectWindow();
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
export { readIncrementalChatHistoryTail as a, readChatHistoryRecoveryContext as i, readChatHistoryMessageId as n, readSessionMessagesAroundIdWithStatsAsync as o, readChatHistoryMessageSeq as r, dropChatHistoryOverreadContextMessage as t };
