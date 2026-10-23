// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAssistantTurn, AssistantBubble } from './ChatInterface';
import { BoundedProjectToolCalls, ProjectActivityTimeline } from './ProjectChatPanel';
import { ToolActivityScope, resetToolActivityChoices } from './toolActivity/toolActivityDisclosure';
import type { ChatMessage, ToolCall } from '../../contexts/ChatStateProvider';

vi.mock('./MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }));

const agent = { name: 'OpenClaw', initials: 'OC', providerName: 'OPENCLAW', color: '', bgLight: '', borderColor: '', avatarBg: '', avatarText: '', accentRing: '', sendBg: '', sendHover: '', sendShadow: '', provenance: 'via OpenClaw' };
const SCOPE = 'agent:OPENCLAW:agent:main:public-chat';
function call(id: string, name = 'read', status: ToolCall['status'] = 'done', order = 1): ToolCall {
  return { id, name, status, arguments: name === 'exec' ? { command: 'npm test' } : { path: `/workspace/${id}.ts` },
    startedAt: 1000 + order, ...(status === 'running' ? {} : { endedAt: 1001 + order }), order,
    ...(status === 'error' ? { result: 'permission denied' } : {}) };
}
function Turn({ msg, ...props }: Partial<React.ComponentProps<typeof AgentAssistantTurn>> & { msg: ChatMessage }) {
  return <ToolActivityScope scope={SCOPE}><AgentAssistantTurn agent={agent} isStreamingAssistant={false} streamSegments={[]} isRunning={false} isLast {...props} msg={msg} /></ToolActivityScope>;
}
function toggle(container: HTMLElement, id: string) {
  return container.querySelector(`[data-tool-activity-group="group:${id}"] button[aria-controls]`) as HTMLButtonElement;
}
function ids(container: HTMLElement) { return [...container.querySelectorAll('[data-tool-call-id]')].map(node => node.getAttribute('data-tool-call-id')); }
function before(left: Element | null, right: Element | null) { return Boolean(left && right && (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING)); }
const message = (id: string, tools: ToolCall[], content = ''): ChatMessage => ({ id, role: 'assistant', content, createdAt: new Date(1000), toolCalls: tools });
beforeEach(() => { resetToolActivityChoices(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });

describe('grouped tools on actual public transcript render paths', () => {
  it('plain bubble groups ordinary completed calls', () => {
    const view = render(<ToolActivityScope scope={SCOPE}><AssistantBubble agent={agent}
      message={message('plain-complete', [call('a'), call('b')], 'Finished inspection.')}
      isLast isStreaming={false} /></ToolActivityScope>);
    expect(toggle(view.container, 'a')).not.toBeNull();
    expect(toggle(view.container, 'a')).toHaveTextContent('2 tool calls');
    expect(ids(view.container)).toEqual([]);
    fireEvent.click(toggle(view.container, 'a'));
    expect(ids(view.container)).toEqual(['a', 'b']);
    expect(screen.getByText('Finished inspection.')).toBeInTheDocument();
  });

  it('live timeline groups tools around prose and preserves disclosures across growth/reconnect', () => {
    const tools = [call('r1'), call('r2', 'grep', 'done', 2), call('e1', 'exec', 'running', 4), call('e2', 'exec', 'running', 5)];
    const segments = [{ text: 'Start inspection.', ts: 1000, order: 0, kind: 'text' as const }, { text: 'Run checks.', ts: 1003, order: 3, kind: 'text' as const }];
    const view = render(<Turn msg={message('live', tools)} isStreamingAssistant isRunning streamSegments={segments} />);
    expect(toggle(view.container, 'r1')).toHaveAttribute('aria-expanded', 'false');
    expect(before(screen.getByText('Start inspection.'), toggle(view.container, 'r1'))).toBe(true);
    expect(before(toggle(view.container, 'r1'), screen.getByText('Run checks.'))).toBe(true);
    expect(ids(view.container)).toEqual([]);
    fireEvent.click(toggle(view.container, 'e1'));
    expect(ids(view.container)).toEqual(['e1', 'e2']);
    const grown = [...tools, call('e3', 'exec', 'running', 6)];
    view.rerender(<Turn msg={message('live', grown)} isStreamingAssistant isRunning streamSegments={segments} />);
    expect(toggle(view.container, 'e1')).toHaveAttribute('aria-expanded', 'true');
    expect(toggle(view.container, 'e1')).toHaveTextContent('3 tool calls');
    view.unmount();
    const history = { ...message('replayed', grown, 'All checks completed.'), segments: segments.map(segment => ({ ...segment, position: 'before' as const })) };
    const restored = render(<Turn msg={history} />);
    expect(toggle(restored.container, 'e1')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('All checks completed.')).toBeInTheDocument();
  });

  it('position-based history keeps between-tools prose visible and failures counted', () => {
    const msg = { ...message('legacy', [call('a'), call('b'), call('f', 'exec', 'error'), call('c')], 'Stopped safely.'), segments: [
      { text: 'Before tools.', position: 'before' as const, kind: 'text' as const },
      { text: 'After first call.', position: 'between' as const, kind: 'text' as const },
    ] };
    const view = render(<Turn msg={msg} />);
    const first = view.container.querySelector('[data-tool-call-id="a"]');
    expect(before(screen.getByText('Before tools.'), first)).toBe(true);
    expect(before(first, screen.getByText('After first call.'))).toBe(true);
    expect(before(screen.getByText('After first call.'), toggle(view.container, 'b'))).toBe(true);
    expect(toggle(view.container, 'b')).toHaveTextContent('1 failed');
    expect(before(toggle(view.container, 'b'), screen.getByText('Stopped safely.'))).toBe(true);
  });

  it('plain live history keeps unanswered failures and questions standalone', () => {
    const tools = [call('a'), call('b'), call('f', 'exec', 'error'), call('q', 'ask_user_question'), call('p', 'update_plan')];
    const view = render(<Turn msg={message('pending', tools)} isStreamingAssistant isRunning />);
    expect(toggle(view.container, 'a')).toHaveTextContent('2 tool calls');
    expect(ids(view.container)).toEqual(['f', 'q', 'p']);
    for (const id of ids(view.container)) expect(view.container.querySelector(`[data-tool-call-id="${id}"]`)?.closest('[data-tool-activity-group]')).toBeNull();
    expect(view.container.querySelector('[data-tool-call-id="f"]')).toHaveTextContent('Failed');
  });

  it('bounds an expanded 10,000-call Project group and reveals earlier original calls on demand', () => {
    const tools = Array.from({ length: 10_000 }, (_, index) => call(`long-${index}`, 'read', 'done', index));
    const view = render(<ToolActivityScope scope="project:long"><BoundedProjectToolCalls tools={tools} messageKey="long" /></ToolActivityScope>);
    expect(toggle(view.container, 'long-0')).toHaveTextContent('10000 tool calls');
    expect(ids(view.container)).toHaveLength(0);
    fireEvent.click(toggle(view.container, 'long-0'));
    const initialCount = ids(view.container).length;
    expect(initialCount).toBeGreaterThan(0);
    expect(initialCount).toBeLessThanOrEqual(40);
    expect(ids(view.container).slice(-1)).toEqual(['long-9999']);
    fireEvent.click(screen.getByRole('button', { name: /Show earlier calls in this group/ }));
    expect(ids(view.container)).toHaveLength(initialCount * 2);
    expect(ids(view.container).slice(-1)).toEqual(['long-9999']);
  });

  it('Project plain history and ordered timelines share guarded cards without crossing prose', () => {
    const tools = [call('a'), call('b'), call('f', 'exec', 'error')];
    const view = render(<ToolActivityScope scope="project:sample:OPENCLAW:session"><BoundedProjectToolCalls tools={tools} messageKey="plain" /></ToolActivityScope>);
    expect(toggle(view.container, 'a')).toHaveTextContent('2 tool calls');
    expect(ids(view.container)).toEqual(['f']);
    view.rerender(<ToolActivityScope scope="project:sample:OPENCLAW:session"><ProjectActivityTimeline messageId="ordered" projectName="sample" tools={tools}
      segments={[{ text: 'Project summary.', position: 'after', kind: 'text', order: 9, ts: 2000 }]} /></ToolActivityScope>);
    expect(toggle(view.container, 'a')).toHaveTextContent('3 tool calls');
    expect(toggle(view.container, 'a')).toHaveTextContent('1 failed');
    expect(before(toggle(view.container, 'a'), screen.getByText('Project summary.'))).toBe(true);
    fireEvent.click(toggle(view.container, 'a'));
    expect(ids(view.container)).toEqual(['a', 'b', 'f']);
  });
});
