// @vitest-environment jsdom
import '../../../test/setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentWorkspaceStore } from '../../../stores/agentWorkspaceStore';
import WorkspacePanelButton from './WorkspacePanelButton';

beforeEach(() => {
  window.localStorage.clear();
  useAgentWorkspaceStore.setState({ userId: 'user-a', open: false, tab: 'artifacts', previews: [], closedDuringRun: false,
    closedTabs: [], dismissedTabsDuringRun: [], unreadTab: null });
});

describe('side-panel button activity mark', () => {
  it('shows the mark for unseen agent activity and clears it when the panel opens', () => {
    const view = render(<WorkspacePanelButton />);
    expect(view.container.querySelector('[data-workspace-unread]')).toBeNull();
    act(() => { useAgentWorkspaceStore.setState({ unreadTab: 'browser' }); });
    expect(view.container.querySelector('[data-workspace-unread]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open side panel, new agent activity' }));
    expect(useAgentWorkspaceStore.getState()).toMatchObject({ open: true, tab: 'browser', unreadTab: null });
    expect(view.container.querySelector('[data-workspace-unread]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close side panel' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('never shows the mark while the panel is open', () => {
    useAgentWorkspaceStore.setState({ open: true, tab: 'widgets', unreadTab: 'browser' });
    const view = render(<WorkspacePanelButton />);
    expect(view.container.querySelector('[data-workspace-unread]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close side panel' })).toBeInTheDocument();
  });
});
