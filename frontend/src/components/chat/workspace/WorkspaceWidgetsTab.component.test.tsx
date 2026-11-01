// @vitest-environment jsdom
import '../../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ default: mocks }));
import WorkspaceWidgetsTab, { displayToolFindingText } from './WorkspaceWidgetsTab';
import type { ChatWidgetEntry } from './artifacts';

const widgets: ChatWidgetEntry[] = [
  { key: 'board:build-timer', toolCallId: 'v2', title: 'Build timer', mode: 'inline', boardName: 'build-timer', versions: 3 },
  { key: 'call:chart', toolCallId: 'chart', title: 'Chart', mode: 'inline', versions: 1 },
];

describe('Widgets tab', () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ data: { v: 1, html: '<p>newest</p>',
      reference: { schema: 'bridgesllm.widget-ref.v1', toolCallId: 'v3', title: 'Build timer', mode: 'inline', boardName: 'build-timer' } } });
  });

  it('labels a live widget with its update count, others as snapshots, and previews the newest version', async () => {
    render(<WorkspaceWidgetsTab provider="openclaw" session="agent:main:portal-x" widgets={widgets} supported />);
    expect(screen.getByText('Live widget · 3 updates')).toBeInTheDocument();
    expect(screen.getByText('Snapshot')).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/chat-widgets/sessions/agent%3Amain%3Aportal-x/boards/build-timer/document', expect.anything()));
  });

  it('previews a live widget that so far exists only on the session board', async () => {
    render(<WorkspaceWidgetsTab provider="OPENCLAW" session="agent:main:portal-x" supported
      widgets={[{ key: 'board:build-timer', toolCallId: 'p1', title: 'Widget', mode: 'dashboard', boardName: 'build-timer', versions: 1 }]} />);
    expect(screen.getByText('Live widget · 1 update')).toBeInTheDocument();
    expect(screen.queryByText(/no preview here/)).toBeNull();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  });

  it('an empty tab says when the agent\'s own tool policy hides the display tools, and what to change', async () => {
    mocks.get.mockReset().mockResolvedValue({ data: { checked: true, agentId: 'main', findings: [
      { tool: 'show_widget', kind: 'deny', setting: 'tools.deny', entry: 'canvas' },
      { tool: 'ask_user', kind: 'allow', setting: 'agents.entries.main.tools.allow' },
    ] } });
    render(<WorkspaceWidgetsTab provider="OPENCLAW" session="agent:main:portal-x" widgets={[]} supported />);

    const note = await screen.findByRole('note', { name: 'Agent tool policy' });
    expect(note).toHaveTextContent('Widgets (show_widget): hidden because tools.deny lists "canvas". Remove that entry, or deny only the tools you mean.');
    expect(note).toHaveTextContent('Question cards (ask_user): hidden because agents.entries.main.tools.allow does not include it. Add ask_user to that list.');
    expect(note).toHaveTextContent('The Portal never changes tool policy for you.');
    expect(mocks.get).toHaveBeenCalledWith('/agent-workspace/sessions/agent%3Amain%3Aportal-x/widget-policy', expect.anything());
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull();
  });

  it('claims nothing when the policy was not checked, and other harnesses never ask', async () => {
    mocks.get.mockReset().mockResolvedValue({ data: { checked: false, findings: [] } });
    const view = render(<WorkspaceWidgetsTab provider="OPENCLAW" session="agent:main:portal-x" widgets={[]} supported />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('note')).toBeNull();
    view.unmount();

    render(<WorkspaceWidgetsTab provider="CODEX" session="codex-thread" widgets={[]} supported />);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('words an empty allow list as turning every tool off', () => {
    expect(displayToolFindingText({ tool: 'progress_card', kind: 'empty-allow', setting: 'tools.allow' }))
      .toBe('Progress notes (progress_card): hidden because tools.allow is empty, which turns off every tool. List the tools this agent should use, including progress_card.');
  });
});
