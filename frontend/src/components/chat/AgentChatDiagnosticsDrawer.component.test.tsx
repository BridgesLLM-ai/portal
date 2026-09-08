// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayAPI } from '../../api/endpoints';
import AgentChatDiagnosticsDrawer, {
  normalizeAgentChatDiagnosticEvents,
} from './AgentChatDiagnosticsDrawer';

describe('AgentChatDiagnosticsDrawer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows bounded safe session events with source timestamps and severity', async () => {
    vi.spyOn(gatewayAPI, 'sessionEvents').mockResolvedValue({
      provider: 'HERMES',
      sessionId: 'hermes-session-1',
      generatedAt: '2026-08-20T12:10:00.000Z',
      truncated: true,
      events: [
        {
          schema: 'bridgesllm.agent-chat-diagnostic.v1',
          id: 'event-1',
          timestamp: '2026-08-20T12:00:00.000Z',
          severity: 'warning',
          category: 'runtime',
          title: 'Harness runtime warning',
          detail: 'The harness reported a recoverable runtime warning.',
          sourceType: 'error',
          presentation: 'rail',
        },
      ],
    });
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentChatDiagnosticsDrawer
        open
        onDismiss={onDismiss}
        session="hermes-session-1"
        provider="HERMES"
        harnessName="Hermes Agent"
      />,
    );

    expect(await screen.findByText('Harness runtime warning')).toBeInTheDocument();
    expect(screen.getByText('The harness reported a recoverable runtime warning.')).toBeInTheDocument();
    expect(screen.getByTitle('2026-08-20T12:00:00.000Z')).toHaveAttribute(
      'dateTime',
      '2026-08-20T12:00:00.000Z',
    );
    expect(screen.getByText('Older events are outside this bounded diagnostic window.')).toBeInTheDocument();
    expect(gatewayAPI.sessionEvents).toHaveBeenCalledWith(
      'hermes-session-1',
      'HERMES',
      expect.objectContaining({ limit: 200, signal: expect.any(AbortSignal) }),
    );

    await user.click(screen.getByRole('button', { name: 'Close session events' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fails closed on malformed rows and never renders omitted raw diagnostics', async () => {
    const normalized = normalizeAgentChatDiagnosticEvents({
      provider: 'OPENCLAW',
      sessionId: 'agent:main:main',
      generatedAt: '2026-08-20T12:10:00.000Z',
      truncated: false,
      events: [
        { id: 'bad', detail: 'token=do-not-render' },
      ],
    });
    expect(normalized).toEqual(expect.objectContaining({ events: [], truncated: true }));

    vi.spyOn(gatewayAPI, 'sessionEvents').mockResolvedValue(normalized!);
    render(
      <AgentChatDiagnosticsDrawer
        open
        onDismiss={vi.fn()}
        session="agent:main:main"
        provider="OPENCLAW"
        harnessName="OpenClaw"
      />,
    );
    await waitFor(() => expect(screen.getByText('No retained session events')).toBeInTheDocument());
    expect(screen.queryByText(/do-not-render/)).not.toBeInTheDocument();
  });

  it('keeps the drawer private and actionable when loading fails', async () => {
    vi.spyOn(gatewayAPI, 'sessionEvents').mockRejectedValue(new Error('host secret details'));
    const user = userEvent.setup();
    render(
      <AgentChatDiagnosticsDrawer
        open
        onDismiss={vi.fn()}
        session="agent:main:main"
        provider="OPENCLAW"
        harnessName="OpenClaw"
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Session events could not be loaded. Retry the audit view.',
    );
    expect(screen.queryByText(/host secret details/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(gatewayAPI.sessionEvents).toHaveBeenCalledTimes(2);
  });
});
