// @vitest-environment jsdom
import '../../test/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentZeroOAuthProviderId,
  AgentZeroOAuthProviderStatus,
  AgentZeroOAuthStatus,
} from '../../api/agentRuntime';
import AgentZeroOAuthPanel from './AgentZeroOAuthPanel';
import {
  getAgentChatProviderModelsCache,
  invalidateAgentChatProviderModelsCache,
  setAgentChatProviderModelsCache,
} from '../../utils/agentChatProviderModelsCache';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  callback: vi.fn(),
  models: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../../api/agentRuntime', () => ({
  agentRuntimeAPI: {
    agentZeroOAuthStatus: mocks.status,
    startAgentZeroOAuth: mocks.start,
    pollAgentZeroOAuth: mocks.poll,
    completeAgentZeroOAuthCallback: mocks.callback,
    agentZeroOAuthModels: mocks.models,
    disconnectAgentZeroOAuth: mocks.disconnect,
  },
}));

const DISCONNECT_PHRASE = 'DISCONNECT AGENT ZERO OAUTH';

function provider(
  providerId: AgentZeroOAuthProviderId,
  overrides: Partial<AgentZeroOAuthProviderStatus> = {},
): AgentZeroOAuthProviderStatus {
  const metadata = {
    codex_oauth: { displayName: 'Codex/ChatGPT', shortName: 'Codex', authFlow: 'device_code' as const },
    github_copilot_oauth: { displayName: 'GitHub Copilot', shortName: 'GitHub Copilot', authFlow: 'device_code' as const },
    gemini_api_oauth: { displayName: 'Google Cloud Gemini', shortName: 'Google Cloud', authFlow: 'browser_pkce' as const },
    xai_grok_oauth: { displayName: 'xAI Grok', shortName: 'Grok', authFlow: 'browser_pkce' as const },
  }[providerId];
  const browser = metadata.authFlow === 'browser_pkce';
  return {
    providerId,
    ...metadata,
    connected: false,
    accountLabel: '',
    warning: '',
    note: '',
    supportsManualCallback: browser,
    supportsEnterpriseDomain: providerId === 'github_copilot_oauth',
    supportsOAuthClientConfig: providerId === 'gemini_api_oauth',
    supportsQuotaProject: providerId === 'gemini_api_oauth',
    defaultModel: '',
    defaultModels: [],
    usageWindows: [],
    ...overrides,
    connectionState: overrides.connectionState || (overrides.connected ? 'connected' : 'disconnected'),
    reconnectRequired: overrides.reconnectRequired || false,
  };
}

function oauthStatus(overrides: Partial<AgentZeroOAuthStatus> = {}): AgentZeroOAuthStatus {
  const providers = overrides.providers || [
    provider('codex_oauth'),
    provider('github_copilot_oauth'),
    provider('gemini_api_oauth', {
      note: 'Requires a Google Cloud OAuth client.',
    }),
    provider('xai_grok_oauth', {
      warning: 'OAuth access may be restricted by tier.',
    }),
  ];
  return {
    available: true,
    routesInstalled: true,
    connectedCount: providers.filter((entry) => entry.connected).length,
    availableCount: providers.filter((entry) => !entry.connected).length,
    providers,
    checkedAt: '2026-07-20T00:00:00.000Z',
    actions: {
      disconnect: { ownerOnly: true, confirmationPhrase: DISCONNECT_PHRASE },
    },
    ...overrides,
  };
}

describe('AgentZeroOAuthPanel official account setup', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.status.mockResolvedValue(oauthStatus());
    invalidateAgentChatProviderModelsCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps OAuth owner-only and does not probe before the protected session is ready', () => {
    const { rerender } = render(<AgentZeroOAuthPanel owner={false} ready />);
    expect(screen.getByText(/Only the Portal Owner/i)).toBeInTheDocument();
    expect(mocks.status).not.toHaveBeenCalled();

    rerender(<AgentZeroOAuthPanel owner ready={false} />);
    expect(screen.getByText(/Verify the protected Agent Zero session first/i)).toBeInTheDocument();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('renders the fixed official provider catalog without exposing token-shaped data', async () => {
    mocks.status.mockResolvedValue({
      ...oauthStatus(),
      access_token: 'must-never-render',
    });
    render(<AgentZeroOAuthPanel owner ready />);

    expect(await screen.findByText('Codex/ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('GitHub Copilot')).toBeInTheDocument();
    expect(screen.getByText('Google Cloud Gemini')).toBeInTheDocument();
    expect(screen.getByText('xAI Grok')).toBeInTheDocument();
    expect(screen.getByText(/Portal forwards only fixed setup operations/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('must-never-render');
  });

  it('waits for the provider interval, honors slow-down updates, and finishes device authorization', async () => {
    render(<AgentZeroOAuthPanel owner ready />);
    await screen.findByText('Codex/ChatGPT');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'attempt-1',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      authUrl: '',
      redirectUri: '',
      interval: 5,
      expiresAt: 2_000_000_000,
      message: '',
    });
    const connectedStatus = oauthStatus({
      providers: [
        provider('codex_oauth', { connected: true, accountLabel: 'owner@example.com' }),
        provider('github_copilot_oauth'),
        provider('gemini_api_oauth'),
        provider('xai_grok_oauth'),
      ],
    });
    mocks.poll
      .mockResolvedValueOnce({
        ok: true,
        providerId: 'codex_oauth',
        completed: false,
        expired: false,
        accountLabel: '',
        interval: 12,
        expiresAt: 2_000_000_000,
        warning: '',
      })
      .mockResolvedValueOnce({
        ok: true,
        providerId: 'codex_oauth',
        completed: true,
        expired: false,
        accountLabel: 'owner@example.com',
        interval: 12,
        expiresAt: 2_000_000_000,
        warning: '',
        status: connectedStatus,
      });

    fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open provider/i })).toHaveAttribute(
      'href',
      'https://auth.openai.com/device',
    );
    expect(mocks.poll).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(mocks.poll).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Waiting every 12 seconds/i)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(11_999); });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.poll).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Connected · owner@example.com/i)).toBeInTheDocument();
  });

  it('handles browser PKCE, clears the Google secret, and submits a one-time manual callback', async () => {
    const user = userEvent.setup();
    render(<AgentZeroOAuthPanel owner ready />);
    await screen.findByText('Google Cloud Gemini');

    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'gemini_api_oauth',
      flow: 'browser_pkce',
      attemptId: '',
      verificationUrl: '',
      userCode: '',
      authUrl: 'https://accounts.google.com/o/oauth2/auth?state=safe',
      redirectUri: 'http://127.0.0.1:50001/oauth/gemini-api/callback',
      interval: 5,
      expiresAt: 2_000_000_000,
      message: '',
    });
    const connectedStatus = oauthStatus({
      providers: [
        provider('codex_oauth'),
        provider('github_copilot_oauth'),
        provider('gemini_api_oauth', { connected: true, accountLabel: 'owner@example.com' }),
        provider('xai_grok_oauth'),
      ],
    });
    mocks.callback.mockResolvedValue({
      ok: true,
      providerId: 'gemini_api_oauth',
      completed: true,
      expired: false,
      accountLabel: 'owner@example.com',
      interval: 5,
      expiresAt: 0,
      warning: '',
      status: connectedStatus,
    });

    await user.type(screen.getByLabelText('Google OAuth client ID'), 'client-id');
    await user.type(screen.getByLabelText('Google OAuth client secret'), 'client-secret');
    await user.type(screen.getByLabelText('Google quota project (optional)'), 'quota-project');
    await user.click(screen.getByRole('button', { name: 'Connect Google Cloud' }));

    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({
      providerId: 'gemini_api_oauth',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      quotaProjectId: 'quota-project',
    }));
    expect(screen.getByLabelText('Google OAuth client secret')).toHaveValue('');
    expect(screen.getByRole('link', { name: /Open authorization page/i })).toHaveAttribute(
      'href',
      'https://accounts.google.com/o/oauth2/auth?state=safe',
    );

    const callback = 'http://127.0.0.1:50001/oauth/gemini-api/callback?code=one-use&state=one-use';
    await user.type(screen.getByLabelText('Final callback URL or value'), callback);
    await user.click(screen.getByRole('button', { name: 'Complete connection' }));

    await waitFor(() => expect(mocks.callback).toHaveBeenCalledWith('gemini_api_oauth', callback));
    expect(screen.queryByDisplayValue(callback)).not.toBeInTheDocument();
    expect(screen.getByText(/Connected · owner@example.com/i)).toBeInTheDocument();
  });

  it('owns a browser callback synchronously so duplicate submits and stale stop actions cannot race it', async () => {
    const user = userEvent.setup();
    let resolveCallback!: (value: any) => void;
    const callbackResult = new Promise<any>((resolve) => { resolveCallback = resolve; });
    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      attemptId: 'browser-attempt-1',
      verificationUrl: '',
      userCode: '',
      authUrl: 'https://accounts.x.ai/authorize?state=safe',
      redirectUri: 'http://127.0.0.1:50001/oauth/xai/callback',
      interval: 5,
      expiresAt: 0,
      message: '',
    });
    mocks.callback.mockReturnValue(callbackResult);
    render(<AgentZeroOAuthPanel owner ready />);

    await user.click(await screen.findByRole('button', { name: 'Connect Grok' }));
    const callback = 'http://127.0.0.1:50001/oauth/xai/callback?code=one-use&state=one-use';
    await user.type(await screen.findByLabelText('Final callback URL or value'), callback);
    const complete = screen.getByRole('button', { name: 'Complete connection' });
    const stop = screen.getByRole('button', { name: 'Stop waiting' });

    fireEvent.click(complete);
    fireEvent.click(complete);
    fireEvent.click(stop);

    expect(mocks.callback).toHaveBeenCalledTimes(1);
    expect(mocks.callback).toHaveBeenCalledWith('xai_grok_oauth', callback);
    expect(screen.getByLabelText('Final callback URL or value')).toBeInTheDocument();

    const connectedStatus = oauthStatus({
      providers: [
        provider('codex_oauth'),
        provider('github_copilot_oauth'),
        provider('gemini_api_oauth'),
        provider('xai_grok_oauth', { connected: true, accountLabel: 'owner@x.ai' }),
      ],
    });
    await act(async () => {
      resolveCallback({
        ok: true,
        providerId: 'xai_grok_oauth',
        completed: true,
        expired: false,
        accountLabel: 'owner@x.ai',
        interval: 5,
        expiresAt: 0,
        warning: '',
        status: connectedStatus,
      });
      await callbackResult;
    });

    expect(await screen.findByText(/Connected · owner@x.ai/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Final callback URL or value')).not.toBeInTheDocument();
  });

  it('lets the operator stop an unsubmitted browser attempt without connecting an account', async () => {
    const user = userEvent.setup();
    const onBusyChange = vi.fn();
    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      attemptId: '',
      verificationUrl: '',
      userCode: '',
      authUrl: 'https://accounts.x.ai/authorize?state=safe',
      redirectUri: 'http://127.0.0.1:50001/oauth/xai/callback',
      interval: 5,
      expiresAt: 0,
      message: '',
    });
    render(<AgentZeroOAuthPanel owner ready onBusyChange={onBusyChange} />);

    await user.click(await screen.findByRole('button', { name: 'Connect Grok' }));
    expect(await screen.findByRole('button', { name: 'Stop waiting' })).toBeEnabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));

    expect(await screen.findByText(/No callback was submitted and no account was connected/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Final callback URL or value')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeEnabled();
    expect(mocks.callback).not.toHaveBeenCalled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('automatically releases a browser attempt after the bounded upstream window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    mocks.status
      .mockResolvedValueOnce(oauthStatus())
      .mockRejectedValue(new Error('status unavailable'));
    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      attemptId: '',
      verificationUrl: '',
      userCode: '',
      authUrl: 'https://accounts.x.ai/authorize?state=safe',
      redirectUri: 'http://127.0.0.1:50001/oauth/xai/callback',
      interval: 5,
      expiresAt: 0,
      message: '',
    });
    render(<AgentZeroOAuthPanel owner ready />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole('button', { name: 'Connect Grok' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeInTheDocument();

    // Agent Zero allows ten minutes. Two used to end the attempt here and
    // report it expired while the person was still signing in.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(480_001); });

    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
    expect(screen.getByText(/browser authorization window expired/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeEnabled();
  });

  it('still stops at an upstream expiry that lands before the ceiling', async () => {
    // Upstream stays authoritative: a short window must end the wait early, so
    // raising the local ceiling cannot outlive the real attempt.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    mocks.status
      .mockResolvedValueOnce(oauthStatus())
      .mockRejectedValue(new Error('status unavailable'));
    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'xai_grok_oauth',
      flow: 'browser_pkce',
      attemptId: '',
      verificationUrl: '',
      userCode: '',
      authUrl: 'https://accounts.x.ai/authorize?state=safe',
      redirectUri: 'http://127.0.0.1:50001/oauth/xai/callback',
      interval: 5,
      expiresAt: Date.now() + 30_000,
      message: '',
    });
    render(<AgentZeroOAuthPanel owner ready />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole('button', { name: 'Connect Grok' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });

    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
    expect(screen.getByText(/browser authorization window expired/i)).toBeInTheDocument();
  });

  it('loads models and requires the server-provided phrase before disconnecting', async () => {
    const user = userEvent.setup();
    const onConnectionsChanged = vi.fn();
    const connected = oauthStatus({
      providers: [
        provider('codex_oauth', { connected: true, accountLabel: 'owner@example.com' }),
        provider('github_copilot_oauth'),
        provider('gemini_api_oauth'),
        provider('xai_grok_oauth'),
      ],
    });
    mocks.status.mockResolvedValue(connected);
    mocks.models.mockResolvedValue({
      providerId: 'codex_oauth',
      models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Coding model' }],
    });
    mocks.disconnect.mockResolvedValue({
      ok: true,
      providerId: 'codex_oauth',
      disconnected: true,
      alreadyDisconnected: false,
      status: oauthStatus(),
    });
    render(<AgentZeroOAuthPanel owner ready onConnectionsChanged={onConnectionsChanged} />);
    await screen.findByText(/Connected · owner@example.com/i);

    await user.click(screen.getByRole('button', { name: 'View models' }));
    expect(await screen.findByRole('region', { name: 'Codex/ChatGPT models' })).toHaveTextContent('GPT-5.5');

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Disconnect account' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), DISCONNECT_PHRASE);
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith(
      'codex_oauth',
      DISCONNECT_PHRASE,
    ));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/OAuth credentials were removed/i)).toBeInTheDocument();
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1);
  });

  it('drops cached models and requires reconnection after an expired OAuth refresh', async () => {
    const user = userEvent.setup();
    const connected = oauthStatus({
      providers: [
        provider('codex_oauth', {
          connected: true,
          connectionState: 'connected',
          accountLabel: 'owner@example.com',
        }),
        provider('github_copilot_oauth'),
        provider('gemini_api_oauth'),
        provider('xai_grok_oauth'),
      ],
    });
    mocks.status.mockResolvedValueOnce(connected);
    mocks.models.mockResolvedValue({
      providerId: 'codex_oauth',
      models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', description: '' }],
    });
    render(<AgentZeroOAuthPanel owner ready />);
    await screen.findByText(/Connected · owner@example.com/i);
    await user.click(screen.getByRole('button', { name: 'View models' }));
    expect(await screen.findByRole('region', { name: 'Codex/ChatGPT models' })).toHaveTextContent('GPT-5.5');

    setAgentChatProviderModelsCache('AGENT_ZERO', {
      models: ['codex_oauth/gpt-5.5'],
    });
    expect(getAgentChatProviderModelsCache('AGENT_ZERO')).not.toBeNull();

    mocks.status.mockResolvedValueOnce(oauthStatus({
      providers: [
        provider('codex_oauth', {
          connected: false,
          connectionState: 'expired',
          reconnectRequired: true,
          warning: 'The OAuth session expired.',
        }),
        provider('github_copilot_oauth'),
        provider('gemini_api_oauth'),
        provider('xai_grok_oauth'),
      ],
    }));
    await user.click(screen.getByRole('button', { name: 'Refresh accounts' }));

    expect(await screen.findByText(/OAuth expired · reconnect required/i)).toBeInTheDocument();
    expect(screen.getByText('Reconnect required')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Codex/ChatGPT models' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeEnabled();
    expect(getAgentChatProviderModelsCache('AGENT_ZERO')).toBeNull();
  });
});
