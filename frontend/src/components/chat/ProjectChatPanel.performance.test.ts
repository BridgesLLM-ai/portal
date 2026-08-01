import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mergeProjectChatHistoryPages,
  PROJECT_CHAT_HISTORY_PAGE_SIZE,
} from './ProjectChatPanel';
import {
  PROJECT_CHAT_MESSAGE_WINDOW_SIZE as MESSAGE_WINDOW_SIZE,
  PROJECT_CHAT_TOOL_WINDOW_SIZE as TOOL_WINDOW_SIZE,
} from '../../utils/projectChatPerformance';
import { selectNewestWindow } from '../../utils/timelineWindow';

const source = readFileSync(new URL('./ProjectChatPanel.tsx', import.meta.url), 'utf8');

describe('Project Chat long-run browser performance contract', () => {
  it('keeps a multi-day 10,000-message transcript and tool projection bounded', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) => index + 1);
    const tools = Array.from({ length: 10_000 }, (_, index) => index + 1);

    const messageWindow = selectNewestWindow(messages, MESSAGE_WINDOW_SIZE);
    const toolWindow = selectNewestWindow(tools, TOOL_WINDOW_SIZE);

    expect(messageWindow.items).toHaveLength(60);
    expect(messageWindow.hiddenCount).toBe(9_940);
    expect(toolWindow.items).toHaveLength(30);
    expect(toolWindow.hiddenCount).toBe(9_970);
    expect(messages).toHaveLength(10_000);
    expect(tools).toHaveLength(10_000);
  });

  it('uses bounded server pages and deduplicates the pagination seam', () => {
    expect(PROJECT_CHAT_HISTORY_PAGE_SIZE).toBe(100);
    const createdAt = new Date('2026-07-20T00:00:00.000Z');
    const merged = mergeProjectChatHistoryPages(
      [
        { id: 'older', role: 'user', content: 'older', createdAt },
        { id: 'seam', role: 'assistant', content: 'seam', createdAt },
      ],
      [
        { id: 'seam', role: 'assistant', content: 'seam', createdAt },
        { id: 'newer', role: 'assistant', content: 'newer', createdAt },
      ],
    );
    expect(merged.map((message) => message.id)).toEqual(['older', 'seam', 'newer']);
  });

  it('uses bounded projections and coalesced live text/thinking renders', () => {
    expect(source).toContain('selectNewestWindow(messages, PROJECT_CHAT_MESSAGE_WINDOW_SIZE');
    expect(source).toContain('<BoundedProjectToolCalls tools={toolCalls} messageKey={msg.id} />');

    const thinkingHandler = source.slice(
      source.indexOf("case 'thinking':"),
      source.indexOf("case 'compaction_start':"),
    );
    const textHandler = source.slice(
      source.indexOf("case 'text':"),
      source.indexOf("case 'done':"),
    );
    expect(thinkingHandler).toContain('appendThinkingChunk(');
    expect(textHandler).toContain('scheduleTextRender(cid, st)');
    expect(textHandler).not.toContain('setMessages(');
  });

  it('backs off hidden-tab replay, wakes immediately on visibility, and never invents a terminal event', () => {
    expect(source).toContain('getProjectReplayPollDelay({');
    expect(source).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(source).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)");
    expect(source).toContain("if (document.visibilityState === 'visible') requestImmediatePoll()");
    expect(source).not.toContain('*(stream interrupted)*');
    expect(source).toContain('the durable replay cursor remains authoritative');
  });

  it('advances every durable cursor only after its replay page is projected', () => {
    const replayLoops = [...source.matchAll(/for \(const event of replayEvents\) \{/g)];
    expect(replayLoops).toHaveLength(2);

    for (let index = 0; index < replayLoops.length; index += 1) {
      const loopStart = replayLoops[index].index;
      const nextLoopStart = replayLoops[index + 1]?.index ?? source.length;
      const cursorAdvance = source.indexOf('replayCursorRef.current = projectedCursor', loopStart);
      expect(cursorAdvance).toBeGreaterThan(loopStart);
      expect(cursorAdvance).toBeLessThan(nextLoopStart);
    }
  });
});
