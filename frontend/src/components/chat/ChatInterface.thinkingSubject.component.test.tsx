// @vitest-environment jsdom
import '../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AssistantThinkingBubble,
  compareActivityTimelineItems,
  isAssistantContentRepresentedByTimeline,
} from './ChatInterface';

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
