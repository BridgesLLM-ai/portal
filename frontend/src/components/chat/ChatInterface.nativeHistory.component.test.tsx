// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAssistantTurn } from './ChatInterface';
import { AskQuestionAnswerProvider } from './AskQuestionCard';
import { ToolActivityScope, resetToolActivityChoices } from './toolActivity/toolActivityDisclosure';
import { parseHistoryMessages, type ChatMessage } from '../../contexts/ChatStateProvider';

vi.mock('./MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }));
// The widget card's own route choice is covered in richContent; here only its mount matters.
vi.mock('./richContent/ChatWidgetCard', () => ({
  ChatWidgetCard: ({ tool }: { tool: { id: string; status: string } }) => <div data-testid="widget-card" data-tool-id={tool.id} data-status={tool.status} />,
}));

const agent = { name: 'Claude Code', initials: 'CC', providerName: 'CLAUDE_CODE', color: '', bgLight: '', borderColor: '', avatarBg: '', avatarText: '', accentRing: '', sendBg: '', sendHover: '', sendShadow: '', provenance: 'via Claude Code' };
const widgetRef = JSON.stringify({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'toolu_widget1', title: 'Sales', mode: 'inline' });

/** Rows exactly as `/gateway/history` returns a native transcript (NativePersistedToolCall). */
const nativeHistory = [
  { id: 'n-user-1', role: 'user', content: 'Chart my sales', timestamp: '2026-10-21T20:00:00.000Z' },
  {
    id: 'n-assistant-1', role: 'assistant', content: 'Here is the 2026 chart.', timestamp: '2026-10-21T20:00:09.000Z',
    toolCalls: [
      { id: 'toolu_read1', name: 'Read', status: 'done', arguments: { file_path: '/srv/data/sales.csv' }, result: 'month,total', startedAt: 1_760_000_000_001, endedAt: 1_760_000_000_002 },
      { id: 'toolu_bash1', name: 'Bash', status: 'done', arguments: { command: 'wc -l /srv/data/sales.csv' }, result: '13', startedAt: 1_760_000_000_003, endedAt: 1_760_000_000_004 },
      { id: 'toolu_ask1', name: 'ask_user', status: 'done', arguments: { question: 'Which year?', options: [{ label: '2025' }, { label: '2026' }] }, result: '2026', startedAt: 1_760_000_000_005, endedAt: 1_760_000_000_006 },
      { id: 'toolu_widget1', name: 'show_widget', status: 'done', arguments: { title: 'Sales' }, result: widgetRef, startedAt: 1_760_000_000_007, endedAt: 1_760_000_000_008 },
      { id: 'toolu_write1', name: 'Write', status: 'done', arguments: { __truncated: true, preview: '{"file_path":"/srv/out/report.html","content":"<html>' }, startedAt: 1_760_000_000_009, endedAt: 1_760_000_000_010 },
      { id: 'toolu_ask2', name: 'ask_user', status: 'error', arguments: { questions: [{ question: 'Email it too?' }] }, result: 'The user dismissed the question without answering.', startedAt: 1_760_000_000_011, endedAt: 1_760_000_000_012 },
    ],
  },
];

function toggle(container: HTMLElement, id: string) {
  return container.querySelector(`[data-tool-activity-group="group:${id}"] button[aria-controls]`) as HTMLButtonElement;
}

function Turn({ msg }: { msg: ChatMessage }) {
  return (
    <AskQuestionAnswerProvider value={vi.fn()}>
      <ToolActivityScope scope="agent:CLAUDE_CODE:claude_code-u1-1-a">
        <AgentAssistantTurn agent={agent} isStreamingAssistant={false} streamSegments={[]} isRunning={false} isLast msg={msg} />
      </ToolActivityScope>
    </AskQuestionAnswerProvider>
  );
}

beforeEach(() => { resetToolActivityChoices(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });

describe('native harness tool activity after reload', () => {
  it('maps persisted native tool calls onto the ToolCall shape', () => {
    const [user, assistant] = parseHistoryMessages(nativeHistory);
    expect(user.toolCalls).toBeUndefined();
    expect(assistant.toolCalls?.map((tool) => [tool.id, tool.name, tool.status])).toEqual([
      ['toolu_read1', 'Read', 'done'],
      ['toolu_bash1', 'Bash', 'done'],
      ['toolu_ask1', 'ask_user', 'done'],
      ['toolu_widget1', 'show_widget', 'done'],
      ['toolu_write1', 'Write', 'done'],
      ['toolu_ask2', 'ask_user', 'error'],
    ]);
    expect(assistant.toolCalls?.[0]).toMatchObject({ arguments: { file_path: '/srv/data/sales.csv' }, result: 'month,total', startedAt: 1_760_000_000_001, endedAt: 1_760_000_000_002 });
    expect(assistant.toolCalls?.[3].result).toBe(widgetRef);
    // Oversized arguments keep what the card is titled by.
    expect(assistant.toolCalls?.[4].arguments).toEqual({ file_path: '/srv/out/report.html' });
  });

  it('keeps OpenClaw history arguments untouched', () => {
    const args = { command: 'git status' };
    const [message] = parseHistoryMessages([{ id: 'o1', role: 'assistant', content: 'Clean.', timestamp: '2026-10-21T20:00:00.000Z',
      toolCalls: [{ id: 'call_1', name: 'exec', status: 'done', arguments: args, result: 'clean' }] }]);
    expect(message.toolCalls?.[0].arguments).toBe(args);
  });

  it('renders grouped activity, answered questions and the widget from reloaded history', () => {
    const [, assistant] = parseHistoryMessages(nativeHistory);
    const view = render(<Turn msg={assistant} />);
    expect(toggle(view.container, 'toolu_read1')).toHaveTextContent('2 tool calls');
    fireEvent.click(toggle(view.container, 'toolu_read1'));
    expect(screen.getByText('Read data/sales.csv')).toBeInTheDocument();
    expect(screen.getByText('Run wc -l /srv/data/sales.csv')).toBeInTheDocument();
    expect(screen.getByText('answered')).toBeInTheDocument();
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(screen.getByText('not answered')).toBeInTheDocument();
    expect(screen.getByTestId('widget-card')).toHaveAttribute('data-tool-id', 'toolu_widget1');
    expect(screen.getByTestId('widget-card')).toHaveAttribute('data-status', 'done');
    expect(screen.getByText('Write out/report.html')).toBeInTheDocument();
    expect(screen.getByText('Here is the 2026 chart.')).toBeInTheDocument();
  });
});
