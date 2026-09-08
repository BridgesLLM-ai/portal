// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceCodeFlow from './DeviceCodeFlow';
import NativeCliSetupFlow from './NativeCliSetupFlow';
import OAuthSetupFlow from './OAuthSetupFlow';
import SetupTokenFlow from './SetupTokenFlow';
import { cancelOAuthSession } from './oauthCancellation';
import type { ProviderUIConfig } from './providerConfig';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
  },
}));

const baseProvider: Omit<ProviderUIConfig, 'id' | 'name' | 'primaryAuthType' | 'guidedSetup'> = {
  tier: 1,
  icon: 'sparkles',
  consoleUrl: 'https://example.com/console',
  signupUrl: 'https://example.com/signup',
  pricingNote: 'Test pricing',
  freeTier: null,
  description: 'Test provider',
  setupInstructions: [],
  defaultModels: [{ id: 'test/model', name: 'Test Model', tier: 'balanced', description: 'Test model' }],
};

const anthropicProvider: ProviderUIConfig = {
  ...baseProvider,
  id: 'anthropic',
  name: 'Claude (OpenClaw)',
  primaryAuthType: 'setup_token',
  guidedSetup: { status: 'available', authTypes: ['setup_token'] },
};

const googleProvider: ProviderUIConfig = {
  ...baseProvider,
  id: 'google-gemini-cli',
  name: 'Google Gemini CLI (OpenClaw)',
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth'] },
};

const xaiProvider: ProviderUIConfig = {
  ...baseProvider,
  id: 'xai',
  name: 'xAI (Grok)',
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth'] },
};

function installReadMocks() {
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return { data: { defaultModel: null } };
    if (url.includes('/oauth/status/')) return { data: { status: 'awaiting_callback' } };
    if (url.includes('/native-cli/status/')) return { data: { status: 'starting' } };
    if (url.endsWith('/models')) return { data: { models: [] } };
    throw new Error(`Unexpected GET ${url}`);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function installCancellationRace(startResponse: (url: string) => unknown) {
  let cancellationAttempts = 0;
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/oauth/cancel')) {
      cancellationAttempts += 1;
      if (cancellationAttempts === 1) {
        throw {
          response: {
            status: 409,
            data: {
              success: false,
              status: 'cancelled',
              cleanupPending: true,
              error: 'The provider login process is still stopping.',
            },
          },
        };
      }
      return { data: { success: true, status: 'cancelled' }, status: 200 };
    }
    return { data: startResponse(url) };
  });
}

function installRejectedStartRecovery(startSuffix: string, sessionId: string) {
  let cancellationAttempts = 0;
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith(startSuffix)) {
      throw {
        response: {
          status: 500,
          data: {
            success: false,
            error: 'Portal is still stopping and reconciling this login process.',
            sessionId,
            cleanupPending: true,
            credentialState: 'indeterminate',
          },
        },
      };
    }
    if (url.endsWith('/oauth/cancel')) {
      cancellationAttempts += 1;
      if (cancellationAttempts === 1) {
        throw {
          response: {
            status: 409,
            data: {
              success: false,
              status: 'error',
              cleanupPending: true,
              credentialState: 'indeterminate',
              error: 'Credential cleanup is still indeterminate.',
            },
          },
        };
      }
      return { data: { success: true, status: 'cancelled' }, status: 200 };
    }
    throw new Error(`Unexpected POST ${url}`);
  });
}

function installCommittedStart(startSuffix: string, sessionId: string) {
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith(startSuffix)) {
      throw {
        response: {
          status: 500,
          data: {
            success: false,
            error: 'A provider credential changed during cleanup; review it before retrying.',
            sessionId,
            credentialState: 'committed',
          },
        },
      };
    }
    throw new Error(`Unexpected POST ${url}`);
  });
}

function installTerminalRejectedStartRecovery(
  startSuffix: string,
  statusFragment: '/oauth/status/' | '/native-cli/status/',
  sessionId: string,
) {
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return { data: { defaultModel: null } };
    if (url.includes(statusFragment)) {
      return { data: { status: 'error', cleanupPending: false, error: 'Terminal status still requires cancellation re-attestation.' } };
    }
    if (url.endsWith('/models')) return { data: { models: [] } };
    throw new Error(`Unexpected GET ${url}`);
  });
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith(startSuffix)) {
      throw {
        response: {
          status: 500,
          data: {
            success: false,
            error: 'Portal is reconciling an interrupted provider start.',
            sessionId,
            cleanupPending: true,
            credentialState: 'indeterminate',
          },
        },
      };
    }
    if (url.endsWith('/oauth/cancel')) {
      return { data: { success: true, status: 'cancelled' }, status: 200 };
    }
    throw new Error(`Unexpected POST ${url}`);
  });
}

async function expectFailClosedThenConfirmedClose(
  closeName: string | RegExp,
  onCancel: ReturnType<typeof vi.fn>,
  user: ReturnType<typeof userEvent.setup>,
) {
  const close = screen.getByRole('button', { name: closeName });
  await user.click(close);
  expect(await screen.findByText(/keep this dialog open and retry cancellation/i)).toBeInTheDocument();
  expect(onCancel).not.toHaveBeenCalled();
  expect(close).toBeInTheDocument();

  await user.click(close);
  await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
}

describe('provider setup active-session cancellation', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    installReadMocks();
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a network cancellation failure indeterminate and actionable', async () => {
    mocks.post.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(cancelOAuthSession('/ai-setup', 'network-session')).resolves.toEqual({
      outcome: 'indeterminate',
      confirmed: false,
      error: 'network unavailable Keep this dialog open and retry cancellation.',
    });
  });

  it('treats a missing server session as a fail-closed provider-review state', async () => {
    mocks.post.mockRejectedValueOnce({ response: { status: 404, data: { error: 'OAuth session not found' } } });

    await expect(cancelOAuthSession('/ai-setup', 'lost-session')).resolves.toEqual({
      outcome: 'review_required',
      confirmed: false,
      error: 'Portal no longer has the sign-in session record, so it cannot prove whether a credential was committed. Close this dialog and review the provider before starting another sign-in.',
    });
  });

  it('waits for accepted xAI cleanup instead of reporting the background proof as a failed cancel', async () => {
    mocks.post
      .mockResolvedValueOnce({
        status: 202,
        data: {
          success: false,
          status: 'cancelled',
          provider: 'xai',
          cleanupPending: true,
          credentialState: 'indeterminate',
          error: 'Portal is verifying that xAI did not save a credential.',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, status: 'cancelled' },
      });
    mocks.get.mockResolvedValueOnce({
      status: 200,
      data: {
        provider: 'xai',
        status: 'cancelled',
        cleanupPending: false,
        credentialState: 'absent',
      },
    });

    await expect(cancelOAuthSession('/ai-setup', 'xai-background-proof')).resolves.toEqual({
      outcome: 'cancelled',
      confirmed: true,
    });
    expect(mocks.get).toHaveBeenCalledWith(
      '/ai-setup/oauth/status/xai-background-proof',
      { timeout: 10_000 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      '/ai-setup/oauth/cancel',
      { sessionId: 'xai-background-proof' },
      { timeout: 10_000 },
    );
  });

  it('keeps Claude setup credential-only and closes without creating cancellation authority', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(<SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByText(/accepts an existing Claude setup-token/i)).toBeInTheDocument();
    expect(screen.getByText(/never starts a Claude host process/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Claude' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close Claude setup' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('keeps the GitHub device flow open on 409 and closes only after cancellation is confirmed', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installCancellationRace((url) => {
      if (url.endsWith('/oauth/device/start')) {
        return {
          success: true,
          sessionId: 'github-session',
          verificationUrl: 'https://github.com/login/device',
          deviceCode: 'ABCD-EFGH',
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();

    await expectFailClosedThenConfirmedClose('Close GitHub Copilot login', onCancel, user);
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'github-session' }, { timeout: 10_000 });
  });

  it('cancels every active OpenClaw OAuth provider, not only xAI', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installCancellationRace((url) => {
      if (url.endsWith('/oauth/start')) {
        return {
          success: true,
          sessionId: 'google-session',
          status: 'awaiting_callback',
          authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: /I'm ready/i }));
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText(/A new tab opened/i)).toBeInTheDocument();

    await expectFailClosedThenConfirmedClose('Close provider setup', onCancel, user);
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'google-session' }, { timeout: 10_000 });
  });

  it('does not manufacture native cancellation authority for unavailable host Codex', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(<NativeCliSetupFlow provider="codex" apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Interactive host Codex login is unavailable.*Supervised Agent Chat can use an existing attested host credential/i);
    expect(screen.queryByRole('button', { name: 'Start Codex Login' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close Codex login' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('transitions a credential-committed cancellation race into explicit provider review', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/device/start')) {
        return { data: { success: true, sessionId: 'device-race', verificationUrl: 'https://github.com/login/device', deviceCode: 'RACE-1234' } };
      }
      if (url.endsWith('/oauth/cancel')) {
        throw {
          response: {
            status: 409,
            data: {
              success: false,
              status: 'error',
              credentialState: 'committed',
              error: 'Authorization completed before cancellation reached the provider.',
            },
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    expect(await screen.findByText('RACE-1234')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close GitHub Copilot login' }));

    expect(await screen.findByText(/Authorization completed before cancellation/i)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close GitHub Copilot login' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Close and review provider status/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/cancel'))).toHaveLength(1);
  });

  it('requires explicit provider review after cancellation finds only a missing in-memory session', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/device/start')) {
        return { data: { success: true, sessionId: 'lost-device', verificationUrl: 'https://github.com/login/device', deviceCode: 'LOST-1234' } };
      }
      if (url.endsWith('/oauth/cancel')) {
        throw { response: { status: 404, data: { error: 'OAuth session not found' } } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    await user.click(await screen.findByRole('button', { name: 'Close GitHub Copilot login' }));
    expect(await screen.findByText(/no longer has the sign-in session record/i)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Close and review provider status/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('retains a rejected device-code start session until cleanup is confirmed', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installRejectedStartRecovery('/oauth/device/start', 'device-recovery');

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    expect(await screen.findByText(/retaining this interrupted sign-in/i)).toBeInTheDocument();

    await expectFailClosedThenConfirmedClose('Close GitHub Copilot login', onCancel, user);
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'device-recovery' }, { timeout: 10_000 });
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/device/start'))).toHaveLength(1);
  });

  it('retains a rejected OpenClaw OAuth start session until cleanup is confirmed', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installRejectedStartRecovery('/oauth/start', 'oauth-recovery');

    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: /I'm ready/i }));
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText(/Portal is still stopping and reconciling this login process/i)).toBeInTheDocument();

    await expectFailClosedThenConfirmedClose('Close provider setup', onCancel, user);
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'oauth-recovery' }, { timeout: 10_000 });
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/start'))).toHaveLength(1);
  });

  it('does not release a rejected OpenClaw recovery session from terminal GET status alone', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installTerminalRejectedStartRecovery('/oauth/start', '/oauth/status/', 'oauth-terminal');

    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: /I'm ready/i }));
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText(/Terminal status still requires cancellation/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close provider setup' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'oauth-terminal' }, { timeout: 10_000 });
  });

  it('does not release a rejected device recovery session from terminal GET status alone', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const onCancel = vi.fn();
    installTerminalRejectedStartRecovery('/oauth/device/start', '/oauth/status/', 'device-terminal');

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    await vi.waitFor(() => expect(screen.getByText(/retaining this interrupted sign-in/i)).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(screen.getByText(/Terminal status still requires cancellation/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Close GitHub Copilot login' }));
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'device-terminal' }, { timeout: 10_000 });
  });

  it('blocks a second device-code start after a rejected start committed a credential', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installCommittedStart('/oauth/device/start', 'device-committed');

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    expect(await screen.findByText(/credential changed during cleanup/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Sign-In' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close GitHub Copilot login' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Close and review provider status/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('blocks a second OpenClaw OAuth start after a rejected start committed a credential', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    installCommittedStart('/oauth/start', 'oauth-committed');

    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: /I'm ready/i }));
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText(/credential changed during cleanup/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close provider setup' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Close and review provider status/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a device-code start response is lost', async () => {
    mocks.post.mockRejectedValueOnce(new Error('connection lost after send'));
    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    expect(await screen.findByRole('button', { name: /Close and review provider status/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Sign-In' })).not.toBeInTheDocument();
  });

  it('fails closed when an OpenClaw OAuth start response is lost', async () => {
    mocks.post.mockRejectedValueOnce(new Error('connection lost after send'));
    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByRole('button', { name: /Close and review provider status/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
  });

  it('rejects malformed successful starts without a session across supported session-backed flows', async () => {
    mocks.post.mockResolvedValueOnce({ data: { success: true } });
    const device = render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    expect(await screen.findByRole('button', { name: /Close and review provider status/i })).toBeInTheDocument();
    device.unmount();

    mocks.post.mockResolvedValueOnce({ data: { success: true, status: 'awaiting_callback' } });
    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByRole('button', { name: /Close and review provider status/i })).toBeInTheDocument();
  });

  it('retains a failed OpenClaw start session even when the response omits an error string', async () => {
    mocks.post
      .mockResolvedValueOnce({
        data: {
          success: false,
          sessionId: 'oauth-failed-without-message',
          cleanupPending: true,
          credentialState: 'indeterminate',
        },
      })
      .mockResolvedValueOnce({ data: { success: true, status: 'cancelled' }, status: 200 });
    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));

    expect(await screen.findByText(/Failed to start provider sign-in/i)).toBeInTheDocument();
    expect(screen.queryByText(/A new tab opened/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close provider setup' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      '/ai-setup/oauth/cancel',
      { sessionId: 'oauth-failed-without-message' },
      { timeout: 10_000 },
    ));
  });

  it('retains exact xAI session ownership when immediate completion lacks a profile binding', async () => {
    const onCancel = vi.fn();
    mocks.post
      .mockResolvedValueOnce({
        data: {
          success: true,
          sessionId: 'xai-missing-profile',
          status: 'complete',
          finalized: true,
        },
      })
      .mockResolvedValueOnce({ data: { success: true, status: 'cancelled' }, status: 200 });
    render(<OAuthSetupFlow provider={xaiProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with xAI' }));
    expect(await screen.findByText(/could not bind the exact saved credential/i)).toBeInTheDocument();
    expect(screen.queryByText(/Signed in successfully/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close provider setup' }));
    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith(
        '/ai-setup/oauth/cancel',
        { sessionId: 'xai-missing-profile' },
        { timeout: 10_000 },
      );
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it('admits only one same-frame device-code start request', async () => {
    const pending = deferred<{ data: Record<string, unknown> }>();
    const onCancel = vi.fn();
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/device/start')) return pending.promise;
      throw new Error(`Unexpected POST ${url}`);
    });
    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);

    const start = screen.getByRole('button', { name: 'Start Sign-In' });
    const close = screen.getByRole('button', { name: 'Close GitHub Copilot login' });
    fireEvent.click(start);
    fireEvent.click(start);
    fireEvent.click(close);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/device/start'))).toHaveLength(1);
    expect(onCancel).not.toHaveBeenCalled();

    pending.resolve({ data: { sessionId: 'device-once', verificationUrl: 'https://github.com/login/device', deviceCode: 'ONCE-1234' } });
    expect(await screen.findByText('ONCE-1234')).toBeInTheDocument();
  });

  it('admits only one same-frame OpenClaw OAuth start request', async () => {
    const pending = deferred<{ data: Record<string, unknown> }>();
    const onCancel = vi.fn();
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/start')) return pending.promise;
      throw new Error(`Unexpected POST ${url}`);
    });
    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /I'm ready/i }));

    const start = screen.getByRole('button', { name: 'Sign in with Google' });
    const close = screen.getByRole('button', { name: 'Close provider setup' });
    fireEvent.click(start);
    fireEvent.click(start);
    fireEvent.click(close);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/start'))).toHaveLength(1);
    expect(onCancel).not.toHaveBeenCalled();

    pending.resolve({ data: { success: true, sessionId: 'oauth-once', status: 'awaiting_callback', authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test' } });
    expect(await screen.findByText(/A new tab opened/i)).toBeInTheDocument();
  });

  it('keeps every OpenClaw OAuth provider pending until finalization is authoritative', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    let statusCalls = 0;
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: null } };
      if (url.includes('/oauth/status/')) {
        statusCalls += 1;
        return {
          data: {
            status: 'complete',
            finalized: statusCalls > 1,
            createdProfileId: statusCalls > 1 ? 'google:committed' : null,
          },
        };
      }
      if (url.endsWith('/models')) return { data: { models: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/start')) {
        return { data: { success: true, sessionId: 'google-finalize', status: 'awaiting_callback', authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test' } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    expect(screen.queryByText(/Signed in successfully/i)).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(screen.getByText(/Signed in successfully/i)).toBeInTheDocument());
  });

  it('keeps device-code completion pending until finalization is authoritative', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    let statusCalls = 0;
    const onComplete = vi.fn();
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/status/')) {
        statusCalls += 1;
        return { data: { status: 'complete', finalized: statusCalls > 1, createdProfileId: 'github:device' } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.post.mockResolvedValue({
      data: {
        success: true,
        sessionId: 'device-finalize',
        verificationUrl: 'https://github.com/login/device',
        deviceCode: 'FINAL-1234',
      },
    });

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    await vi.waitFor(() => expect(screen.getByText('FINAL-1234')).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(statusCalls).toBe(1));
    expect(onComplete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(screen.getByText(/verifying the saved credential/i)).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('admits only one same-frame cancellation request', async () => {
    const cancellation = deferred<{ data: Record<string, unknown>; status: number }>();
    const onCancel = vi.fn();
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/device/start')) {
        return Promise.resolve({ data: { success: true, sessionId: 'cancel-once', verificationUrl: 'https://github.com/login/device', deviceCode: 'CANCEL-ONCE' } });
      }
      if (url.endsWith('/oauth/cancel')) return cancellation.promise;
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    const close = await screen.findByRole('button', { name: 'Close GitHub Copilot login' });
    fireEvent.click(close);
    fireEvent.click(close);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/cancel'))).toHaveLength(1);

    cancellation.resolve({ data: { success: true, status: 'cancelled' }, status: 200 });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it('invalidates an in-flight device status response before confirmed cancellation releases', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const status = deferred<{ data: Record<string, unknown> }>();
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    mocks.get.mockImplementation((url: string) => {
      if (url.includes('/oauth/status/')) return status.promise;
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/device/start')) {
        return { data: { success: true, sessionId: 'cancel-stale', verificationUrl: 'https://github.com/login/device', deviceCode: 'STALE-1234' } };
      }
      if (url.endsWith('/oauth/cancel')) return { data: { success: true, status: 'cancelled' }, status: 200 };
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={onComplete} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    await vi.waitFor(() => expect(screen.getByText('STALE-1234')).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Close GitHub Copilot login' }));
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));

    status.resolve({ data: { status: 'complete', finalized: true, createdProfileId: 'github:late' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('admits one supported OAuth callback and finishes credential-only without a model mutation', async () => {
    const callback = deferred<{ data: Record<string, unknown> }>();
    let callbackAccepted = false;
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: null } };
      if (url.includes('/oauth/status/')) {
        return callbackAccepted
          ? { data: { status: 'complete', finalized: true, createdProfileId: 'google:callback' } }
          : { data: { status: 'awaiting_callback' } };
      }
      if (url.endsWith('/models')) return { data: { models: [] } };
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith('/oauth/start')) {
        return Promise.resolve({ data: { success: true, sessionId: 'callback-once', status: 'awaiting_callback', authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test' } });
      }
      if (url.endsWith('/oauth/callback')) {
        return callback.promise.then((response) => {
          callbackAccepted = true;
          return response;
        });
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<OAuthSetupFlow provider={googleProvider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /I'm ready/i }));
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await user.click(await screen.findByRole('button', { name: /I copied the URL/i }));
    await user.type(screen.getByRole('textbox', { name: 'OAuth callback URL' }), 'http://localhost:8085/oauth2callback?code=test');

    const submit = screen.getByRole('button', { name: 'Complete Sign-In' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/oauth/callback'))).toHaveLength(1);
    callback.resolve({ data: { success: true } });
    expect(await screen.findByText(/Signed in successfully/i)).toBeInTheDocument();

    expect(screen.getByText(/did not register models, change the default route, restart the gateway, or probe a host model turn/i)).toBeInTheDocument();
    const finish = screen.getByRole('button', { name: 'Finish' });
    fireEvent.click(finish);
    fireEvent.click(finish);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/set-default-model'))).toHaveLength(0);
  });

  it('admits only one same-frame manual setup-token save', async () => {
    const save = deferred<{ data: Record<string, unknown> }>();
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith('/save-setup-token')) return save.promise;
      throw new Error(`Unexpected POST ${url}`);
    });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<SetupTokenFlow provider={anthropicProvider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Paste an existing setup-token/i }));
    await user.type(screen.getByRole('textbox', { name: 'Claude setup token' }), 'test-token-value');

    const submit = screen.getByRole('button', { name: /Save Token/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/save-setup-token'))).toHaveLength(1);
    expect(mocks.post).toHaveBeenCalledWith(
      '/ai-setup/save-setup-token',
      expect.objectContaining({
        provider: 'anthropic',
        token: 'test-token-value',
        setDefault: false,
        operationId: expect.any(String),
      }),
    );
    expect(mocks.post.mock.calls.some(([url]) => /\/(?:claude\/start|claude\/complete|set-default-model)$/.test(String(url)))).toBe(false);
    save.resolve({ data: { success: true } });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Claude credential saved/i)).toBeInTheDocument();
    expect(screen.getByText(/Host model routing activation is unavailable in this release until a separately supported maintenance operation ships/i)).toBeInTheDocument();
  });

  it('bounds an unresolved Antigravity catalog verification', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const catalog = deferred<{ data: Record<string, unknown> }>();
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith('/models')) return catalog.promise;
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/native-cli/start')) {
        return {
          data: {
            success: true,
            sessionId: 'antigravity-catalog-timeout',
            status: 'complete',
            alreadyAuthenticated: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<NativeCliSetupFlow provider="gemini" apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect or Re-authenticate Antigravity' }));
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledWith(
      '/ai-setup/models',
      { params: { provider: 'google-antigravity', exact: '1' } },
    ));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(screen.getByText(/Timed out while Portal verified the Antigravity model catalog/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Close Antigravity login' })).not.toBeDisabled();
  });

  it('keeps status polling bounded, non-overlapping, and stale-response safe', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const status = deferred<{ data: Record<string, unknown> }>();
    const onComplete = vi.fn();
    mocks.get.mockImplementation((url: string) => {
      if (url.includes('/oauth/status/')) return status.promise;
      throw new Error(`Unexpected GET ${url}`);
    });
    mocks.post.mockResolvedValue({ data: { success: true, sessionId: 'poll-once', verificationUrl: 'https://github.com/login/device', deviceCode: 'POLL-ONCE' } });
    const view = render(<DeviceCodeFlow apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Sign-In' }));
    await vi.waitFor(() => expect(screen.getByText('POLL-ONCE')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.get.mock.calls.filter(([url]) => String(url).includes('/oauth/status/'))).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledWith('/ai-setup/oauth/status/poll-once', { timeout: 10_000 });

    view.unmount();
    status.resolve({ data: { status: 'complete' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
