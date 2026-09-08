// @vitest-environment jsdom
import '../../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentChatProviderModelsCache, invalidateAgentChatProviderModelsCache } from '../../utils/agentChatProviderModelsCache';
import NativeCliSetupFlow from './NativeCliSetupFlow';

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

vi.mock('./HarnessNativeCliTerminal', () => ({
  default: ({ provider, sessionId }: { provider: string; sessionId: string }) => (
    <div role="application" aria-label={`${provider} Portal setup terminal`}>
      Fixed terminal {sessionId}
    </div>
  ),
}));

describe('NativeCliSetupFlow Antigravity model handoff', () => {
  beforeEach(() => {
    mocks.clientGet.mockReset();
    mocks.clientPost.mockReset();
    window.localStorage.clear();
    invalidateAgentChatProviderModelsCache();
  });

  it('fails closed for a stale direct Codex setup entry without posting a host start', () => {
    render(
      <NativeCliSetupFlow
        provider="codex"
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/Interactive host Codex login is unavailable.*Supervised Agent Chat can use an existing attested host credential/i);
    expect(screen.queryByRole('button', { name: /Start Codex|Replace existing Codex/i })).not.toBeInTheDocument();
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('labels Claude as a process-free Project Sandbox authorization', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    mocks.clientPost.mockResolvedValueOnce({
      data: {
        success: true,
        sessionId: 'native-claude-project',
        status: 'awaiting_callback',
        authUrl: 'https://claude.ai/oauth/authorize?state=project-test',
        alreadyAuthenticated: false,
        reauthSupported: true,
      },
    });

    render(
      <NativeCliSetupFlow
        provider="claude-code"
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/process-free credential flow/i)).toBeVisible();
    expect(screen.getByText(/will not launch Claude Code on the host/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize Claude Project Sandbox' }));
    expect(await screen.findByRole('link', { name: /Open Claude Project Sandbox login/i })).toBeVisible();
    expect(mocks.clientPost).toHaveBeenCalledWith('/ai-setup/native-cli/start', { provider: 'claude-code' });
    open.mockRestore();
  });

  it('continues an already-authenticated unsupported re-auth into an exact native model choice', async () => {
    const onComplete = vi.fn();
    const onModelSelected = vi.fn(async () => true);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.clientPost.mockResolvedValueOnce({
      data: {
        success: true,
        sessionId: 'native-antigravity-existing',
        status: 'complete',
        alreadyAuthenticated: true,
        reauthSupported: false,
      },
    });
    mocks.clientGet.mockResolvedValueOnce({
      data: {
        source: 'native-cli',
        exact: true,
        readiness: { state: 'live_verified', usable: true },
        models: [
          { id: 'google-antigravity/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
          { id: 'google-antigravity/gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
        ],
      },
    });

    render(
      <NativeCliSetupFlow
        provider="gemini"
        apiBase="/ai-setup"
        onComplete={onComplete}
        onCancel={vi.fn()}
        onModelSelected={onModelSelected}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect or Re-authenticate Antigravity' }));

    expect(await screen.findByText('Choose the native Agent Chat model')).toBeInTheDocument();
    expect(screen.getByText(/does not expose a supported re-authentication command/i)).toBeInTheDocument();
    expect(screen.getByText(/does not register an OpenClaw provider/i)).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(mocks.clientPost).toHaveBeenCalledWith('/ai-setup/native-cli/start', {
      provider: 'gemini',
      forceReauth: true,
    });
    expect(mocks.clientGet).toHaveBeenCalledWith('/ai-setup/models', {
      params: { provider: 'google-antigravity', exact: '1' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Gemini 3.1 Pro \(High\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Use selected model in Agent Chat' }));

    await waitFor(() => expect(onModelSelected).toHaveBeenCalledWith('GEMINI', 'gemini-3.1-pro-high'));
    expect(window.localStorage.getItem('agentChats.lastModel.GEMINI')).toBe('gemini-3.1-pro-high');
    expect(getAgentChatProviderModelsCache('GEMINI')?.models).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro-high',
    ]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(mocks.clientPost.mock.calls.some(([url]) => String(url).includes('set-default-model'))).toBe(false);
    open.mockRestore();
  });

  it.each([
    { provider: 'hermes' as const, name: 'Hermes', sessionId: 'oauth_hermes_ab12cd' },
    { provider: 'opencode' as const, name: 'OpenCode', sessionId: 'oauth_opencode_ab12cd' },
  ])('opens the fixed $name Portal-profile terminal rather than a credential paste form', async ({
    provider,
    name,
    sessionId,
  }) => {
    mocks.clientPost.mockResolvedValueOnce({
      data: {
        success: true,
        sessionId,
        status: 'starting',
        alreadyAuthenticated: false,
        reauthSupported: true,
      },
    });

    render(
      <NativeCliSetupFlow
        provider={provider}
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/separate from OpenClaw and Remote Desktop auth/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: `Configure Portal ${name}` }));
    expect(await screen.findByRole('application', { name: `${provider} Portal setup terminal` })).toHaveTextContent(sessionId);
    expect(mocks.clientPost).toHaveBeenCalledWith('/ai-setup/native-cli/start', { provider });
    expect(screen.queryByLabelText('Authorization code')).not.toBeInTheDocument();
  });

  it('rejects a fallback/default catalog instead of pretending it came from Antigravity', async () => {
    mocks.clientPost.mockResolvedValueOnce({
      data: {
        success: true,
        sessionId: 'native-antigravity-existing',
        status: 'complete',
        alreadyAuthenticated: true,
        reauthSupported: false,
      },
    });
    mocks.clientGet.mockResolvedValueOnce({
      data: {
        source: 'defaults',
        models: [{ id: 'google-antigravity/fallback', name: 'Fallback' }],
      },
    });

    render(
      <NativeCliSetupFlow
        provider="gemini"
        apiBase="/ai-setup"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect or Re-authenticate Antigravity' }));
    expect(await screen.findByText(/could not verify an exact live model catalog/i)).toBeInTheDocument();
    expect(screen.queryByText('Fallback')).not.toBeInTheDocument();
  });

  it('keeps the dialog open for model selection after a polled login completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onComplete = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    mocks.clientPost.mockResolvedValueOnce({
      data: {
        success: true,
        sessionId: 'native-antigravity-polled',
        status: 'starting',
        authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=portal-test',
        alreadyAuthenticated: false,
        reauthSupported: true,
      },
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.includes('/native-cli/status/')) {
        return { data: { status: 'complete', alreadyAuthenticated: false, reauthSupported: true } };
      }
      if (url.endsWith('/models')) {
        return {
          data: {
            source: 'native-cli',
            exact: true,
            readiness: { state: 'live_verified', usable: true },
            models: [{ id: 'google-antigravity/gemini-3.5-flash', name: 'Gemini 3.5 Flash' }],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    try {
      render(
        <NativeCliSetupFlow
          provider="gemini"
          apiBase="/ai-setup"
          onComplete={onComplete}
          onCancel={vi.fn()}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect or Re-authenticate Antigravity' }));
        await Promise.resolve();
      });
      expect(screen.getByRole('link', { name: /Open Antigravity login/i })).toHaveAttribute('href', expect.stringContaining('accounts.google.com'));
      expect(open).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByText('Choose the native Agent Chat model')).toBeInTheDocument();

      // The old behavior auto-closed 1.5 seconds after auth completion. Model
      // handoff must remain operator-driven even well beyond that window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(onComplete).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Use selected model in Agent Chat' })).toBeInTheDocument();
      expect(mocks.clientPost.mock.calls.some(([url]) => String(url).includes('set-default-model'))).toBe(false);
    } finally {
      open.mockRestore();
      vi.useRealTimers();
    }
  });
});
