// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentToolsPage from './AgentToolsPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: { get: mocks.get },
}));

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    motion: {
      div: ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          ...domProps
        } = props;
        return <div ref={ref} {...domProps}>{children as React.ReactNode}</div>;
      }),
    },
  };
});

vi.mock('./AutomationsPage', () => ({
  AutomationsContent: ({ agentId }: { agentId?: string }) => (
    <div>Automations for {agentId}</div>
  ),
}));

vi.mock('./UsagePage', () => ({
  UsageContent: ({ agentId }: { agentId?: string }) => (
    <div>Usage for {agentId}</div>
  ),
}));

vi.mock('./SkillsPage', () => ({
  SkillsContent: () => <div>Skills content</div>,
}));

vi.mock('./TasksPage', () => ({
  TasksContent: () => <div>Tasks content</div>,
}));

vi.mock('./ToolsPage', () => ({
  ToolsContent: () => <div>Tools content</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/agent-tools"
          element={(
            <>
              <AgentToolsPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Agent Tools provider scope', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/gateway/agents') {
        return {
          data: {
            agents: [
              { id: 'main', identity: '🤖', model: 'openai/gpt-5.5' },
              { id: 'parity', identity: '🔬', model: 'openai/gpt-5.5-mini' },
            ],
          },
        };
      }
      if (url === '/settings/public') {
        return { data: { assistantName: 'Atlas' } };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it('shows only real OpenClaw agents in a portaled picker and never requests fake provider choices', async () => {
    const user = userEvent.setup();
    renderPage('/agent-tools?tab=automations&agent=main');

    expect(await screen.findByText('Automations for main')).toBeVisible();
    const trigger = screen.getByRole('button', { name: 'Select OpenClaw agent' });
    expect(trigger).toHaveTextContent('Atlas');
    expect(trigger).toHaveTextContent('OpenClaw agent');
    expect(mocks.get).toHaveBeenCalledWith('/gateway/agents');
    expect(mocks.get).not.toHaveBeenCalledWith('/gateway/providers');

    await user.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: 'OpenClaw agents' });
    expect(listbox).toHaveTextContent('OpenClaw agent scope');
    expect(listbox).toHaveTextContent(
      'Agent Tools is OpenClaw-scoped. Agent Chat providers are selected in Agent Chat.',
    );
    expect(listbox.closest('[data-anchored-popover-root="true"]')).not.toBeNull();

    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(2);
    options.forEach((option) => expect(option).toBeEnabled());
    expect(listbox).not.toHaveTextContent(/Codex|Agent Zero|Claude|Gemini|Ollama/i);

    const mainOption = within(listbox).getByRole('option', { name: /Atlas/i });
    const parityOption = within(listbox).getByRole('option', { name: /Parity/i });
    await waitFor(() => expect(mainOption).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(parityOption).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Automations for parity')).toBeVisible();
    expect(trigger).toHaveFocus();
    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('tab=automations');
      expect(screen.getByTestId('location-search')).toHaveTextContent('agent=parity');
      expect(screen.getByTestId('location-search')).not.toHaveTextContent('provider=');
    });
  });

  it('canonicalizes legacy provider URLs into the honest OpenClaw Agent Tools scope', async () => {
    renderPage('/agent-tools?tab=usage&provider=CODEX&agent=parity');

    expect(await screen.findByText('Usage for parity')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Select OpenClaw agent' })).toHaveTextContent('Parity');
    expect(screen.queryByText(/support is not wired into Agent Tools/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('tab=usage');
      expect(screen.getByTestId('location-search')).toHaveTextContent('agent=parity');
      expect(screen.getByTestId('location-search')).not.toHaveTextContent('provider=CODEX');
    });
  });

  it('uses a compact explicit shared scope instead of any selector on instance-wide tabs', async () => {
    renderPage('/agent-tools?tab=tools&provider=AGENT_ZERO&agent=parity');

    expect(await screen.findByText('Tools content')).toBeVisible();
    expect(screen.getByText('Shared host tool inventory')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Select OpenClaw agent' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location-search')).toHaveTextContent('tab=tools');
      expect(screen.getByTestId('location-search')).not.toHaveTextContent('provider=');
      expect(screen.getByTestId('location-search')).not.toHaveTextContent('agent=');
    });
  });
});
