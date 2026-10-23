// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolActivityGroup } from './ToolActivityGroup';
import { ToolActivityScope, resetToolActivityChoices } from './toolActivityDisclosure';
import { describeActivityTool, type ActivityTool } from './toolActivityModel';
import { ToolCard } from '../toolCards/ToolCard';

type Tool = ActivityTool & { startedAt: number };

const read = (id: string, path = `/workspace/${id}.ts`): Tool => ({ id, name: 'read', status: 'done', startedAt: 1, endedAt: 2, arguments: { path } } as Tool);
const exec = (id: string, command: string, status: Tool['status'] = 'running', result?: string): Tool => ({ id, name: 'exec', status, startedAt: 1, arguments: { command }, ...(result ? { result } : {}) });

const renderMember = (tool: Tool) => <ToolCard tool={tool} />;

function Group({ tools, scope = 'agent:OPENCLAW:session-a', onDisclosureChange }: {
  tools: Tool[];
  scope?: string;
  onDisclosureChange?: () => void;
}) {
  return (
    <ToolActivityScope scope={scope} onDisclosureChange={onDisclosureChange}>
      <ToolActivityGroup
        groupKey={`group:${tools[0].id}`}
        tools={tools}
        surface="agent"
        renderTool={renderMember}
        describeTool={describeActivityTool}
      />
    </ToolActivityScope>
  );
}

function header(): HTMLElement {
  return screen.getByRole('button', { name: /^Tool activity/ });
}

beforeEach(() => resetToolActivityChoices());

describe('ToolActivityGroup', () => {
  it('starts a completed group collapsed with an exact count and opens to each original call', async () => {
    const user = userEvent.setup();
    const tools = [read('a'), read('b'), exec('c', 'git status', 'done', 'clean')];
    const { container } = render(<Group tools={tools} />);

    const toggle = header();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('3 tool calls');
    expect(toggle).toHaveAccessibleName(/^Tool activity: 3 tool calls · /);
    expect(container.querySelector('[data-tool-activity-group="group:a"]')).toHaveAttribute('data-tool-activity-state', 'done');
    expect(container.querySelector('[data-tool-call-id]')).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('group', { name: '3 tool calls' });
    expect(toggle.getAttribute('aria-controls')).toBe(region.id);
    expect([...region.querySelectorAll('[data-tool-call-id]')].map((node) => node.getAttribute('data-tool-call-id'))).toEqual(['a', 'b', 'c']);

    // Then each call opens on its own.
    const card = region.querySelector('[data-tool-call-id="c"] button[aria-expanded]') as HTMLElement;
    await user.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(within(region).getByText('clean')).toBeInTheDocument();
  });

  it('shows the live current call while running and never hides a failure behind quiet success', () => {
    const { rerender, container } = render(<Group tools={[read('a'), exec('b', 'npm test', 'error', 'exit 1'), exec('c', 'npm run lint')]} />);
    const toggle = header();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Tool activity, running now:');
    expect(toggle).toHaveTextContent('Run npm run lint');
    expect(toggle).toHaveTextContent('3 tool calls');
    expect(toggle).toHaveTextContent('1 failed');
    expect(container.querySelector('[data-tool-activity-group]')).toHaveAttribute('data-tool-activity-state', 'running');

    rerender(<Group tools={[read('a'), exec('b', 'npm test', 'error', 'exit 1'), exec('c', 'npm run lint', 'done', 'ok')]} />);
    expect(header()).toHaveTextContent('3 tool calls');
    expect(header()).toHaveTextContent('1 failed');
    expect(header()).not.toHaveTextContent('running now');
    expect(container.querySelector('[data-tool-activity-group]')).toHaveAttribute('data-tool-activity-state', 'failed');
  });

  it('toggles from the keyboard and reports each change so the transcript can re-measure', async () => {
    const user = userEvent.setup();
    const onDisclosureChange = vi.fn();
    render(<Group tools={[read('a'), read('b')]} onDisclosureChange={onDisclosureChange} />);
    const toggle = header();
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(onDisclosureChange).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit choice across stream growth, remounts and new message identities', async () => {
    const user = userEvent.setup();
    const first = render(<Group tools={[read('a'), exec('b', 'npm test')]} />);
    await user.click(header());
    await user.click(first.container.querySelector('[data-tool-call-id="b"] button[aria-expanded]') as HTMLElement);

    // A streamed update appends a call while the group is open.
    first.rerender(<Group tools={[read('a'), exec('b', 'npm test', 'done', 'passed'), exec('c', 'npm run build')]} />);
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(first.container.querySelector('[data-tool-call-id="c"]')).not.toBeNull();
    expect(first.container.querySelector('[data-tool-call-id="b"] button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');

    // Reconnect or history reload remounts the transcript from new objects.
    first.unmount();
    const second = render(<Group tools={[read('a'), exec('b', 'npm test', 'done', 'passed'), exec('c', 'npm run build', 'done', 'built')]} />);
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(second.container.querySelector('[data-tool-call-id="b"] button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');

    await user.click(header());
    second.unmount();
    render(<Group tools={[read('a'), read('b')]} />);
    expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a new group when the reader had already opened its first call', async () => {
    const user = userEvent.setup();
    const view = render(
      <ToolActivityScope scope="agent:OPENCLAW:session-a">
        <ToolCard tool={exec('a', 'npm test', 'done', 'passed')} />
      </ToolActivityScope>,
    );
    await user.click(view.container.querySelector('[data-tool-call-id="a"] button[aria-expanded]') as HTMLElement);
    view.unmount();

    render(<Group tools={[exec('a', 'npm test', 'done', 'passed'), read('b')]} />);
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('passed')).toBeInTheDocument();
  });

  it('does not share choices between conversations', async () => {
    const user = userEvent.setup();
    const view = render(<Group tools={[read('a'), read('b')]} scope="agent:OPENCLAW:session-a" />);
    await user.click(header());
    view.unmount();
    render(<Group tools={[read('a'), read('b')]} scope="agent:OPENCLAW:session-b" />);
    expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  it('bounds a very long open group and reveals earlier calls on request', async () => {
    const user = userEvent.setup();
    const tools = Array.from({ length: 45 }, (_, index) => read(`r${index}`));
    const { container } = render(<Group tools={tools} />);
    await user.click(header());
    expect(container.querySelectorAll('[data-tool-call-id]')).toHaveLength(40);
    expect(container.querySelector('[data-tool-call-id="r44"]')).not.toBeNull();
    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Show earlier calls in this group · 5 hidden' }));
    });
    expect(container.querySelectorAll('[data-tool-call-id]')).toHaveLength(45);
    expect(header()).toHaveTextContent('45 tool calls');
  });
});
