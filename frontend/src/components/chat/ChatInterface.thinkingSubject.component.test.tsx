// @vitest-environment jsdom
import '../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AssistantBubble,
  AssistantThinkingBubble,
  compareActivityTimelineItems,
  isAgentChatStreamingAssistant,
  isAssistantContentRepresentedByTimeline,
} from './ChatInterface';
import { parseHistoryMessages } from '../../contexts/ChatStateProvider';

vi.mock('./MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

describe('Agent Chat thinking subject presentation', () => {
  it('renders the provider subject as a title and streams the reasoning body beneath it', () => {
    render(
      <AssistantThinkingBubble
        subject="Inspecting the runtime"
        content="Reading the relevant files."
        isStreaming
      />,
    );

    expect(screen.getByText('thinking')).toBeInTheDocument();
    expect(screen.getByText('Inspecting the runtime')).toBeInTheDocument();
    expect(screen.getByText('Reading the relevant files.')).toBeInTheDocument();
  });

  it('keeps a subject-only preamble visible while waiting for the first body chunk', () => {
    render(
      <AssistantThinkingBubble
        subject="Preparing the review"
        content=""
        isStreaming
      />,
    );

    expect(screen.getByText('Preparing the review')).toBeInTheDocument();
    expect(screen.queryByText('Reading the relevant files.')).not.toBeInTheDocument();
  });

  it('keeps the active assistant live after a same-run user steer becomes the last message', () => {
    const activeAssistant = {
      id: 'assistant-live',
      role: 'assistant' as const,
      content: '',
      createdAt: new Date(),
    };
    const laterUserSteer = {
      id: 'discord-steer',
      role: 'user' as const,
      content: 'Also check the retry path',
      createdAt: new Date(),
    };

    expect(isAgentChatStreamingAssistant(activeAssistant, activeAssistant.id)).toBe(true);
    expect(isAgentChatStreamingAssistant(laterUserSteer, activeAssistant.id)).toBe(false);

    const agent = {
      name: 'OpenClaw',
      initials: 'OC',
      providerName: 'OPENCLAW',
      color: '',
      bgLight: '',
      borderColor: '',
      avatarBg: '',
      avatarText: '',
      accentRing: '',
      sendBg: '',
      sendHover: '',
      sendShadow: '',
      provenance: 'via OpenClaw',
    };
    const { rerender } = render(
      <AssistantBubble
        agent={agent}
        message={activeAssistant}
        isLast={false}
        isLive
        isStreaming
        liveStatusText="Inspecting the retry path…"
      />,
    );

    expect(screen.getByText('Inspecting the retry path…')).toBeInTheDocument();

    rerender(
      <AssistantBubble
        agent={agent}
        message={{
          ...activeAssistant,
          toolCalls: [{
            id: 'read-after-steer',
            name: 'Read',
            startedAt: Date.now(),
            status: 'running',
          }],
        }}
        isLast={false}
        isLive
        isStreaming
        liveThinkingContent="Reasoning remains visible after the steer"
      />,
    );
    expect(screen.getByText('Reasoning remains visible after the steer')).toBeInTheDocument();
    expect(screen.getByText(/Read/)).toBeInTheDocument();
  });

  it('keeps durable segment/tool chronology when provider clocks are skewed', () => {
    const ordered = [
      { id: 'final', order: 4, ts: 100, fallbackOrder: 4 },
      { id: 'tool-two', order: 3, ts: 50_000, fallbackOrder: 2 },
      { id: 'prefix', order: 0, ts: 40_000, fallbackOrder: 0 },
      { id: 'tool-one', order: 1, ts: 60_000, fallbackOrder: 1 },
      { id: 'middle', order: 2, ts: 90_000, fallbackOrder: 3 },
    ].sort(compareActivityTimelineItems);

    expect(ordered.map(({ id }) => id)).toEqual([
      'prefix',
      'tool-one',
      'middle',
      'tool-two',
      'final',
    ]);
  });

  it('restores every long-run reasoning phase around its tool after a background history reload', () => {
    const phaseCount = 96;
    const segments = Array.from({ length: phaseCount }, (_, index) => ({
      // Model cumulative/sliding provider snapshots: adjacent phases overlap,
      // but a tool boundary makes each one a distinct visible thought.
      text: index === 0
        ? 'Inspecting phase 0'
        : `Inspecting phase ${index - 1} and phase ${index}`,
      subject: 'Long-running audit',
      kind: 'thinking' as const,
      position: 'before' as const,
      order: index * 2,
      // Deliberately reverse provider clocks. Durable order must remain the
      // background/reload authority instead of timestamps or array grouping.
      ts: 500_000 - index,
    }));
    const toolCalls = Array.from({ length: phaseCount }, (_, index) => ({
      id: `tool-${index}`,
      name: 'exec',
      arguments: { command: `check-${index}` },
      result: `ok-${index}`,
      startedAt: 100_000 + index,
      endedAt: 100_500 + index,
      status: 'done' as const,
      order: index * 2 + 1,
    }));

    const [restored] = parseHistoryMessages([{
      id: 'restored-long-run',
      role: 'assistant',
      content: 'Long run complete.',
      timestamp: '2026-08-10T17:59:53.286Z',
      segments,
      toolCalls,
    }]);

    expect(restored.segments).toHaveLength(phaseCount);
    expect(restored.toolCalls).toHaveLength(phaseCount);
    expect(restored.thinkingContent).toBeUndefined();

    const restoredTimeline = [
      ...(restored.segments || []).map((segment, index) => ({
        id: `reasoning-${index}`,
        kind: 'reasoning',
        order: segment.order ?? null,
        ts: segment.ts ?? 0,
        fallbackOrder: index * 2,
      })),
      ...(restored.toolCalls || []).map((tool, index) => ({
        id: tool.id,
        kind: 'tool',
        order: tool.order ?? null,
        ts: tool.startedAt,
        fallbackOrder: index * 2 + 1,
      })),
    ].sort(compareActivityTimelineItems);

    expect(restoredTimeline).toHaveLength(phaseCount * 2);
    expect(restoredTimeline.map(({ kind }) => kind)).toEqual(
      Array.from({ length: phaseCount }, () => ['reasoning', 'tool']).flat(),
    );
    expect(restoredTimeline.slice(0, 4).map(({ id }) => id)).toEqual([
      'reasoning-0',
      'tool-0',
      'reasoning-1',
      'tool-1',
    ]);
    expect(restoredTimeline.slice(-2).map(({ id }) => id)).toEqual([
      `reasoning-${phaseCount - 1}`,
      `tool-${phaseCount - 1}`,
    ]);
  });

  it('hides an aggregate multi-tool final already represented by ordered residual segments', () => {
    const segments = [
      { text: 'A', kind: 'text' as const, order: 0, ts: 5_000 },
      { text: 'B', kind: 'text' as const, order: 2, ts: 1_000 },
      { text: 'C', kind: 'text' as const, order: 4, ts: 3_000 },
    ];

    expect(isAssistantContentRepresentedByTimeline('A B C', segments)).toBe(true);
    expect(isAssistantContentRepresentedByTimeline('Independent final', segments)).toBe(false);
  });
});
