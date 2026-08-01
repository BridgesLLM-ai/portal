// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import SetupTokenFlow from './SetupTokenFlow';
import { credentialOperationStorageKey } from './credentialOperationStorage';

const mocks = vi.hoisted(() => ({
  clientGet: vi.fn(),
  clientPost: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: {
    get: mocks.clientGet,
    post: mocks.clientPost,
  },
}));

const anthropicProvider = {
  id: 'anthropic',
  name: 'Claude (OpenClaw)',
  tier: 1 as const,
  icon: 'sparkles',
  primaryAuthType: 'setup_token' as const,
  guidedSetup: { status: 'available' as const, authTypes: ['setup_token' as const] },
  consoleUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  signupUrl: 'https://claude.ai/',
  pricingNote: 'Usage limits follow the connected account.',
  freeTier: null,
  description: 'Reuse a signed-in Claude CLI session.',
  setupInstructions: [],
  defaultModels: [
    {
      id: 'anthropic/claude-fable-5',
      name: 'Claude Fable 5',
      tier: 'frontier' as const,
      description: 'Supported through Claude CLI.',
    },
  ],
};

async function openManualTokenAndEnter(user: ReturnType<typeof userEvent.setup>, token: string) {
  await user.click(screen.getByRole('button', { name: 'Paste a setup-token manually' }));
  await user.type(await screen.findByRole('textbox', { name: 'Claude setup token' }), token);
}

describe('SetupTokenFlow Anthropic guidance', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAuthStore.setState({ user: null, isAuthenticated: false });
    mocks.clientGet.mockReset();
    mocks.clientPost.mockReset();
    mocks.clientGet.mockResolvedValue({ data: { defaultModel: 'anthropic/claude-fable-5' } });
  });

  it('shows neutral Claude CLI guidance without stale Extra Usage warnings', async () => {
    render(
      <SetupTokenFlow
        provider={anthropicProvider}
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Set up Claude' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('How the connection works')).toBeInTheDocument();
    expect(screen.getByText(/Fable 5 is supported through the Claude CLI path/i)).toBeInTheDocument();
    expect(screen.queryByText(/extra usage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/check your Claude account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Anthropic can change those terms/i)).not.toBeInTheDocument();
  });

  it('sets initial focus, traps Tab, closes on Escape, and restores the opener', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open Claude setup</button>
          {open ? (
            <SetupTokenFlow
              provider={anthropicProvider}
              apiBase="/ai-setup"
              onComplete={vi.fn()}
              onCancel={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open Claude setup' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Set up Claude' });
    const primary = screen.getByRole('button', { name: 'Connect Claude' });
    const close = screen.getByRole('button', { name: 'Close Claude setup' });
    const last = screen.getByRole('button', { name: 'Paste a setup-token manually' });

    await waitFor(() => expect(primary).toHaveFocus());
    last.focus();
    await user.tab();
    expect(close).toHaveFocus();
    close.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('moves focus to each async step and announces progress without visual guesswork', async () => {
    let resolveStart!: (value: unknown) => void;
    mocks.clientPost.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve; }));
    const user = userEvent.setup();
    render(
      <SetupTokenFlow
        provider={anthropicProvider}
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Connect Claude' }));
    const step = screen.getByTestId('claude-setup-step');
    await waitFor(() => expect(step).toHaveFocus());
    expect(step).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Starting Claude sign-in.');

    resolveStart({ data: { success: true, sessionId: 'session-1', authUrl: null } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      'Claude sign-in is waiting for browser authorization.',
    ));
    expect(step).toHaveFocus();
    await waitFor(() => expect(step).toHaveAttribute('aria-busy', 'false'));
  });

  it('announces setup failures assertively and keeps focus inside the failed step', async () => {
    mocks.clientPost.mockRejectedValueOnce(new Error('Claude CLI unavailable'));
    const user = userEvent.setup();
    render(
      <SetupTokenFlow
        provider={anthropicProvider}
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Connect Claude' }));
    const step = screen.getByTestId('claude-setup-step');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Claude setup needs attention.'));
    expect(screen.getByRole('alert')).toHaveTextContent('Claude CLI unavailable');
    expect(step).toHaveFocus();
  });

  it('recovers the manual-token UUID after a lost response and closed tab without persisting the token', async () => {
    const user = userEvent.setup();
    const saveRequests: Array<Record<string, unknown>> = [];
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/save-setup-token')) {
        saveRequests.push(body);
        throw { response: { data: { error: `simulated lost response ${saveRequests.length}` } } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const firstTab = render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await openManualTokenAndEnter(user, 'first-setup-token');
    await user.click(screen.getByRole('button', { name: 'Save Token' }));
    await waitFor(() => expect(saveRequests).toHaveLength(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('simulated lost response 1');

    const storageKey = credentialOperationStorageKey('setup:pending', 'setup-token', 'anthropic');
    const firstId = window.localStorage.getItem(storageKey);
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstId).toBe(saveRequests[0].operationId);
    expect(window.localStorage.getItem(storageKey)).not.toContain('first-setup-token');

    firstTab.unmount();
    window.sessionStorage.clear();
    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await openManualTokenAndEnter(user, 'first-setup-token');
    await user.click(screen.getByRole('button', { name: 'Save Token' }));
    await waitFor(() => expect(saveRequests).toHaveLength(2));
    expect(saveRequests[1].operationId).toBe(firstId);
  });

  it('blocks manual-token POST when its durable UUID record is malformed', async () => {
    const user = userEvent.setup();
    const storageKey = credentialOperationStorageKey('setup:pending', 'setup-token', 'anthropic');
    window.localStorage.setItem(storageKey, '{"token":"should-never-be-a-record"}');
    mocks.clientPost.mockRejectedValue(new Error('Manual token POST must remain blocked'));
    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await openManualTokenAndEnter(user, 'never-post-this-token');
    await user.click(screen.getByRole('button', { name: 'Save Token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/malformed durable credential-operation record/i);
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('retires the exact manual-token UUID after success', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const storageKey = credentialOperationStorageKey('setup:pending', 'setup-token', 'anthropic');
    mocks.clientPost.mockResolvedValue({ data: { success: true } });
    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />,
    );
    await openManualTokenAndEnter(user, 'successful-token');
    await user.click(screen.getByRole('button', { name: 'Save Token' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
});
