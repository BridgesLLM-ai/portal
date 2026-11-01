// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedProjectToolCalls, ProjectActivityTimeline } from './ProjectChatPanel';
import { ToolActivityScope, resetToolActivityChoices } from './toolActivity/toolActivityDisclosure';
import type { ToolCall } from '../../contexts/ChatStateProvider';

vi.mock('./MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }));

const NOTE = /Inline widgets aren't available in Project Chat, so this widget isn't shown here\./;
const SCOPE = 'project:sample:OPENCLAW:session';

function call(id: string, name: string, args: Record<string, unknown>, order: number): ToolCall {
  return { id, name, status: 'done', arguments: args, startedAt: 1000 + order, endedAt: 1001 + order, order };
}

const tools = [
  call('read-1', 'read', { path: '/workspace/a.ts' }, 1),
  call('widget-1', 'show_widget', { title: 'Build times', html: '<div>chart</div>' }, 2),
  call('read-2', 'read', { path: '/workspace/b.ts' }, 3),
];

beforeEach(() => { resetToolActivityChoices(); });

describe('Project Chat widget boundary', () => {
  it('a show_widget call keeps its row and says the widget is not shown here', () => {
    const view = render(<ToolActivityScope scope={SCOPE}><BoundedProjectToolCalls tools={tools} messageKey="plain" /></ToolActivityScope>);

    const boundary = view.container.querySelector('[data-project-widget-boundary="widget-1"]');
    expect(boundary).not.toBeNull();
    expect(boundary?.querySelector('[data-tool-call-id="widget-1"]')).not.toBeNull();
    expect(boundary).toHaveTextContent('Widget “Build times”:');
    expect(boundary).toHaveTextContent(NOTE);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
    // The widget markup itself is never rendered in Project Chat.
    expect(view.container.innerHTML).not.toContain('<div>chart</div>');
  });

  it('the ordered timeline uses the same boundary, and an untitled widget gets the plain note', () => {
    const untitled = [call('widget-2', 'show_widget', { html: '<p>x</p>' }, 1)];
    const view = render(<ToolActivityScope scope={SCOPE}><ProjectActivityTimeline messageId="ordered" projectName="sample"
      tools={untitled} segments={[{ text: 'Summary.', position: 'after', kind: 'text', order: 9, ts: 2000 }]} /></ToolActivityScope>);

    const boundary = view.container.querySelector('[data-project-widget-boundary="widget-2"]');
    expect(boundary).not.toBeNull();
    expect(boundary).toHaveTextContent(NOTE);
    expect(boundary).not.toHaveTextContent('Widget “');
  });

  it('ordinary tool calls are unchanged', () => {
    const view = render(<ToolActivityScope scope={SCOPE}><BoundedProjectToolCalls tools={[tools[0], tools[2]]} messageKey="plain" /></ToolActivityScope>);

    expect(view.container.querySelector('[data-project-widget-boundary]')).toBeNull();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
