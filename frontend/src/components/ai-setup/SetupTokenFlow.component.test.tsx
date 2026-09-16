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
  await user.click(screen.getByRole('button', { name: 'Paste an existing setup-token' }));
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

  it('offers the process-free browser sign-in first and existing-token entry second, without host Claude execution', async () => {
    render(
      <SetupTokenFlow
        provider={anthropicProvider}
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Set up Claude' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('What this sign-in does')).toBeInTheDocument();
    expect(screen.getByText(/never launches Claude Code on the host/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenClaw's Claude CLI runtime and Portal Claude Code sessions share that login/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with your Claude account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paste an existing setup-token' })).toBeInTheDocument();
    expect(screen.queryByText(/Project Sandbox/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Claude' })).not.toBeInTheDocument();
    expect(screen.queryByText(/extra usage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/check your Claude account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Anthropic can change those terms/i)).not.toBeInTheDocument();
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('runs the process-free browser sign-in and completes with a pasted authorization code', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const onComplete = vi.fn();
    const startBodies: Array<Record<string, unknown>> = [];
    const callbackBodies: Array<Record<string, unknown>> = [];
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      if (url.includes('/native-cli/status/')) {
        return { data: { id: 'native-claude-openclaw', provider: 'claude-code', status: 'awaiting_callback' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/native-cli/start')) {
        startBodies.push(body);
        return {
          data: {
            success: true,
            sessionId: 'native-claude-openclaw',
            status: 'awaiting_callback',
            authUrl: 'https://claude.com/cai/oauth/authorize?state=openclaw-test',
          },
        };
      }
      if (url.endsWith('/native-cli/callback')) {
        callbackBodies.push(body);
        return {
          data: {
            success: true,
            finalized: true,
            warning: 'Credential saved. Host Agent Chat will re-check both the credential and admitted CLI before the next turn.',
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Sign in with your Claude account' }));
    expect(await screen.findByText(/Claude sign-in opened in a new tab/i)).toBeInTheDocument();
    expect(startBodies).toEqual([{ provider: 'claude-code' }]);
    expect(open).toHaveBeenCalledWith('https://claude.com/cai/oauth/authorize?state=openclaw-test', '_blank', 'noopener,noreferrer');

    await user.click(screen.getByRole('button', { name: /I have the code/i }));
    await user.type(await screen.findByRole('textbox', { name: 'Claude authorization code' }), 'pasted-code#state');
    await user.click(screen.getByRole('button', { name: 'Complete Sign-In' }));

    expect(await screen.findByText('Claude is signed in on this server')).toBeInTheDocument();
    expect(callbackBodies).toEqual([{ sessionId: 'native-claude-openclaw', callbackUrl: 'pasted-code#state' }]);
    expect(screen.getByText(/Host Agent Chat will re-check/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenClaw's Claude CLI runtime and Portal Claude Code sessions use this login/i)).toBeInTheDocument();
    expect(mocks.clientPost.mock.calls.some(([url]) => String(url).includes('/claude/'))).toBe(false);
    expect(mocks.clientPost.mock.calls.some(([url]) => String(url).includes('/save-setup-token'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Choose a model' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('ends the sign-in on a rejected authorization code and cancels the session before a fresh start', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const cancelBodies: Array<Record<string, unknown>> = [];
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      if (url.includes('/native-cli/status/')) {
        return { data: { id: 'native-claude-rejected', provider: 'claude-code', status: 'awaiting_callback' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/native-cli/start')) {
        return {
          data: {
            success: true,
            sessionId: 'native-claude-rejected',
            status: 'awaiting_callback',
            authUrl: 'https://claude.com/cai/oauth/authorize?state=rejected-test',
          },
        };
      }
      if (url.endsWith('/native-cli/callback')) {
        return { data: { success: false, error: 'Claude token exchange failed: invalid_grant' } };
      }
      if (url.endsWith('/oauth/cancel')) {
        cancelBodies.push(body);
        return { data: { success: true, status: 'cancelled' } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Sign in with your Claude account' }));
    await user.click(await screen.findByRole('button', { name: /I have the code/i }));
    await user.type(await screen.findByRole('textbox', { name: 'Claude authorization code' }), 'stale-code');
    await user.click(screen.getByRole('button', { name: 'Complete Sign-In' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Claude token exchange failed: invalid_grant'));
    expect(screen.getByText('Setup failed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(cancelBodies).toEqual([{ sessionId: 'native-claude-rejected' }]));
    expect(await screen.findByRole('button', { name: 'Sign in with your Claude account' })).toBeInTheDocument();
    open.mockRestore();
  });

  it('keeps the rejected-code error stable while the server reports the ended session, then cancels once', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const cancelBodies: Array<Record<string, unknown>> = [];
    let rejected = false;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      if (url.includes('/native-cli/status/')) {
        return rejected
          ? { data: { id: 'native-claude-ended', provider: 'claude-code', status: 'error', cleanupPending: true, error: 'Claude token exchange failed: invalid_grant' } }
          : { data: { id: 'native-claude-ended', provider: 'claude-code', status: 'awaiting_callback' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/native-cli/start')) {
        return { data: { success: true, sessionId: 'native-claude-ended', status: 'awaiting_callback', authUrl: 'https://claude.com/cai/oauth/authorize?state=ended' } };
      }
      if (url.endsWith('/native-cli/callback')) {
        rejected = true;
        return { data: { success: false, error: 'Claude token exchange failed: invalid_grant' } };
      }
      if (url.endsWith('/oauth/cancel')) {
        cancelBodies.push(body);
        return { data: { success: true, status: 'cancelled' } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in with your Claude account' }));
    await user.click(await screen.findByRole('button', { name: /I have the code/i }));
    await user.type(await screen.findByRole('textbox', { name: 'Claude authorization code' }), 'stale-code');
    await user.click(screen.getByRole('button', { name: 'Complete Sign-In' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Claude token exchange failed: invalid_grant'));

    // Let the error-step poll observe the server's ended session at least once.
    await waitFor(() => expect(mocks.clientGet.mock.calls.filter(([url]) => String(url).includes('/native-cli/status/')).length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(screen.getByRole('alert')).toHaveTextContent('Claude token exchange failed: invalid_grant');
    expect(screen.getByText('Setup failed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(cancelBodies).toEqual([{ sessionId: 'native-claude-ended' }]));
    expect(await screen.findByRole('button', { name: 'Sign in with your Claude account' })).toBeInTheDocument();
    expect(cancelBodies).toHaveLength(1);
    open.mockRestore();
  });

  it('moves an unattended sign-in that the server expired onto the error step and cancels before a fresh start', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const cancelBodies: Array<Record<string, unknown>> = [];
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      if (url.includes('/native-cli/status/')) {
        return { data: { id: 'native-claude-expired', provider: 'claude-code', status: 'expired', cleanupPending: true, error: 'Claude sign-in expired before the authorization code was submitted.' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/native-cli/start')) {
        return { data: { success: true, sessionId: 'native-claude-expired', status: 'awaiting_callback', authUrl: 'https://claude.com/cai/oauth/authorize?state=expired' } };
      }
      if (url.endsWith('/oauth/cancel')) {
        cancelBodies.push(body);
        return { data: { success: true, status: 'cancelled' } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in with your Claude account' }));
    expect(await screen.findByText(/Claude sign-in opened in a new tab/i)).toBeInTheDocument();

    expect(await screen.findByText('Setup failed', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/expired before the authorization code/i);
    expect(screen.queryByText(/Claude sign-in opened in a new tab/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(cancelBodies).toEqual([{ sessionId: 'native-claude-expired' }]));
    expect(await screen.findByRole('button', { name: 'Sign in with your Claude account' })).toBeInTheDocument();
    open.mockRestore();
  });

  it('recovers to the signed-in screen when the callback response is lost but the server finalized the login', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const onComplete = vi.fn();
    let callbackAttempted = false;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      if (url.includes('/native-cli/status/')) {
        return callbackAttempted
          ? { data: { id: 'native-claude-lost', provider: 'claude-code', status: 'complete', finalized: true, credentialState: 'committed', finalizationWarning: 'Credential saved. Host Agent Chat will re-check both the credential and admitted CLI before the next turn.' } }
          : { data: { id: 'native-claude-lost', provider: 'claude-code', status: 'awaiting_callback' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/native-cli/start')) {
        return { data: { success: true, sessionId: 'native-claude-lost', status: 'awaiting_callback', authUrl: 'https://claude.com/cai/oauth/authorize?state=lost' } };
      }
      if (url.endsWith('/native-cli/callback')) {
        callbackAttempted = true;
        throw new Error('Network Error');
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in with your Claude account' }));
    await user.click(await screen.findByRole('button', { name: /I have the code/i }));
    await user.type(await screen.findByRole('textbox', { name: 'Claude authorization code' }), 'real-code#state');
    await user.click(screen.getByRole('button', { name: 'Complete Sign-In' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network Error'));

    expect(await screen.findByText('Claude is signed in on this server', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/Host Agent Chat will re-check/i)).toBeInTheDocument();
    expect(mocks.clientPost.mock.calls.some(([url]) => String(url).includes('/oauth/cancel'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Choose a model' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('reuses a verified login and closes into model selection without an auth write', async () => {
    const user = userEvent.setup();
    const callbacks: string[] = [];
    const status = { id: 'anthropic', nativeCliAuthStatus: 'authenticated' } as React.ComponentProps<typeof SetupTokenFlow>['status'];
    render(<SetupTokenFlow provider={anthropicProvider} status={status} apiBase="/ai-setup"
      onComplete={() => callbacks.push('complete')} onCancel={() => callbacks.push('close')} />);
    await user.click(screen.getByRole('button', { name: 'Use existing login and choose a model' }));
    expect(callbacks).toEqual(['complete', 'close']);
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('requires acknowledging replacement when a Claude login already exists on the server', async () => {
    const user = userEvent.setup();
    const existingLogin = {
      id: 'anthropic',
      status: 'unconfigured',
      authType: 'setup_token',
      profileId: null,
      currentModel: null,
      isDefault: false,
      error: null,
      cooldownUntil: null,
      lastUsed: null,
      expiresAt: null,
      nativeProvider: 'CLAUDE_CODE',
      nativeCliAuthStatus: 'authenticated',
    } as unknown as React.ComponentProps<typeof SetupTokenFlow>['status'];
    render(
      <SetupTokenFlow provider={anthropicProvider} status={existingLogin} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText(/A Claude login already exists on this server/i)).toBeInTheDocument();
    const replace = screen.getByRole('button', { name: 'Replace the Claude login on this server' });
    expect(replace).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(replace).toBeEnabled();
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('refuses to open a non-Anthropic authorization URL from the start response', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: 'anthropic/claude-fable-5' } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/native-cli/start')) {
        return { data: { success: true, sessionId: 'native-claude-phish', status: 'awaiting_callback', authUrl: 'https://claude-login.example/cai/oauth/authorize?state=x' } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in with your Claude account' }));
    expect(await screen.findByText('Setup failed')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete Claude sign-in start response/i);
    expect(screen.getByRole('button', { name: 'Close and review provider status' })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
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
    const primary = screen.getByRole('button', { name: 'Sign in with your Claude account' });
    const close = screen.getByRole('button', { name: 'Close Claude setup' });
    const last = screen.getByRole('button', { name: 'Paste an existing setup-token' });

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

  it('moves to existing-token entry without calling any sign-in start route', async () => {
    const user = userEvent.setup();
    render(
      <SetupTokenFlow
        provider={anthropicProvider}
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Paste an existing setup-token' }));
    const step = screen.getByTestId('claude-setup-step');
    await waitFor(() => expect(step).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Paste a Claude setup token manually.');
    expect(screen.getByRole('textbox', { name: 'Claude setup token' })).toBeInTheDocument();
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('announces existing-token save failures assertively and keeps focus inside the failed step', async () => {
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

    await openManualTokenAndEnter(user, 'test-existing-token');
    await user.click(screen.getByRole('button', { name: 'Save Token' }));
    const step = screen.getByTestId('claude-setup-step');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Claude CLI unavailable'));
    expect(screen.getByRole('alert')).toHaveTextContent('Claude CLI unavailable');
    expect(step).toContainElement(document.activeElement as HTMLElement);
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
