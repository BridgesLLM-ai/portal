import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(new URL('./ChatInterface.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../../contexts/ChatStateProvider.tsx', import.meta.url), 'utf8');

describe('Main Agent Chat history pagination contract', () => {
  it('loads a bounded initial page and requests older rows with the server cursor', () => {
    expect(stateSource).toContain('const INITIAL_CHAT_HISTORY_PAGE_SIZE = 80');
    expect(stateSource).toContain("limit: String(INITIAL_CHAT_HISTORY_PAGE_SIZE)");
    expect(stateSource).toContain('before: beforeCursor');
    expect(stateSource).toContain('historyBeforeCursorRef.current = nextCursor');
    expect(stateSource).toContain('historyHasMoreBeforeRef.current = hasMore');
  });

  it('prepends and deduplicates older pages without replacing reconnect/live state', () => {
    expect(stateSource).toContain('normalizeLoadedHistoryMessages([...olderPage, ...messagesRef.current])');
    expect(stateSource).toContain('historyGenRef.current !== expectedGeneration');
    expect(stateSource).toContain('historyOlderPagesLoadedRef.current = true');
    expect(stateSource).toContain('preserveActiveAssistant: isStreamActiveRef.current');
    expect(stateSource).toContain('const firstLatestOverlapIndex = messagesRef.current.findIndex');
    expect(stateSource).toContain('messagesRef.current.slice(0, firstLatestOverlapIndex)');
  });

  it('anchors the viewport and exposes loading, retry, and end states', () => {
    expect(chatSource).toContain('container.scrollTop = anchoredScrollTop(anchor, container.scrollHeight)');
    expect(chatSource).toContain('onScroll={handleChatScroll}');
    expect(chatSource).toContain('Loading earlier messages…');
    expect(chatSource).toContain('Couldn’t load earlier messages:');
    expect(chatSource).toContain('Beginning of chat');
    expect(chatSource).toContain('Load earlier messages');
  });

  it('pages a complete export without expanding the rendered chat state', () => {
    expect(stateSource).toContain('getCompleteHistory: () => Promise<ChatMessage[]>');
    expect(stateSource).toContain("limit: '100'");
    expect(stateSource).toContain('const seenCursors = new Set<string>()');
    expect(stateSource).toContain('complete = normalizeLoadedHistoryMessages([...olderPage, ...complete])');
    expect(chatSource).toContain("parsed.command.command === '/export'");
    expect(chatSource).toContain('const completeHistory = await chatState.getCompleteHistory()');
    expect(chatSource).toContain('downloadChatMarkdown(completeHistory)');
  });

  it('routes both submit surfaces through the synchronous local-command coordinator', () => {
    expect(chatSource).toContain('createLocalSlashCommandCoordinator');
    expect(chatSource).toContain('This intentionally returns a boolean synchronously');
    expect(chatSource.match(/if \(maybeExecuteSlashCommand\(e\)\) \{/g)).toHaveLength(2);
    expect(chatSource).not.toContain('if (await maybeExecuteSlashCommand())');
    expect(chatSource).not.toContain('onClick={async (e) => {');
  });

  it('blocks the assistant-ui send callback whenever an attachment is pending', () => {
    expect(chatSource).not.toContain('pendingAttachments.length > 0 && handleSendWithAttachments');
    expect(chatSource.match(/if \(pendingAttachments.length > 0\) \{/g)).toHaveLength(2);
  });
});
