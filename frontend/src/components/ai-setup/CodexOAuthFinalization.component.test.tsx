// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NativeCliSetupFlow from './NativeCliSetupFlow';
import OAuthSetupFlow from './OAuthSetupFlow';
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

const codexProvider: ProviderUIConfig = {
  tier: 1,
  icon: 'sparkles',
  consoleUrl: 'https://chatgpt.com/',
  signupUrl: 'https://chatgpt.com/',
  pricingNote: 'Paid ChatGPT plan',
  freeTier: null,
  description: 'OpenAI Codex',
  setupInstructions: [],
  defaultModels: [{ id: 'openai/gpt-5.5', name: 'GPT-5.5', tier: 'frontier', description: 'Codex model' }],
  id: 'openai-codex',
  name: 'OpenAI Codex',
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth'] },
};

describe('Codex OAuth finalization handoff', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the unified OAuth wizard in finalizing until the backend attests completion', async () => {
    let releaseStatus!: (value: { data: Record<string, unknown> }) => void;
    const finalStatus = new Promise<{ data: Record<string, unknown> }>((resolve) => {
      releaseStatus = resolve;
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/native-cli/start')) {
        return { data: { success: true, sessionId: 'codex-unified', status: 'complete', finalized: false } };
      }
      return { data: { success: true } };
    });
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes('/native-cli/status/')) {
        return finalStatus;
      }
      if (url.endsWith('/status')) return { data: { defaultModel: null } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      return { data: {} };
    });

    render(<OAuthSetupFlow provider={codexProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'OpenAI instructions' })).toHaveAttribute(
      'href',
      'https://developers.openai.com/codex/auth#login-on-headless-devices',
    );
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));

    expect(await screen.findByText(/Verifying the saved OpenAI credential/i)).toBeInTheDocument();
    expect(screen.queryByText(/Signed in successfully/i)).not.toBeInTheDocument();
    releaseStatus({ data: { id: 'codex-unified', provider: 'codex', status: 'complete', finalized: true } });
    expect(await screen.findByText(/Signed in successfully/i)).toBeInTheDocument();
  });

  it('keeps the direct Codex wizard in finalizing until finalized is true', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { success: true, sessionId: 'codex-direct', status: 'complete', finalized: false },
    });
    mocks.get.mockResolvedValue({
      data: { id: 'codex-direct', provider: 'codex', status: 'complete', finalized: true },
    });

    render(<NativeCliSetupFlow provider="codex" apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'OpenAI instructions' })).toHaveAttribute(
      'href',
      'https://developers.openai.com/codex/auth#login-on-headless-devices',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex Login' }));

    expect(await screen.findByText(/Codex is signed in.*registering models/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(
      '/ai-setup/native-cli/status/codex-direct',
      { timeout: 10_000 },
    ), { timeout: 3_000 });
    expect(await screen.findByText(/Codex CLI is now authenticated/i, {}, { timeout: 3_000 })).toBeInTheDocument();
  });

  it('retries a transient native status drop instead of turning it into a fatal Codex failure', async () => {
    let statusCalls = 0;
    vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.post.mockResolvedValueOnce({
      data: {
        success: true,
        sessionId: 'codex-reconnect',
        status: 'polling_device',
        deviceCode: 'SAFE-CODE',
        verificationUrl: 'https://auth.openai.com/codex/device',
      },
    });
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes('/native-cli/status/')) {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error('status request timed out');
        return { data: { id: 'codex-reconnect', provider: 'codex', status: 'complete', finalized: true } };
      }
      if (url.endsWith('/status')) return { data: { defaultModel: null } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      return { data: {} };
    });

    render(<OAuthSetupFlow provider={codexProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));

    expect(await screen.findByText('SAFE-CODE')).toBeInTheDocument();
    expect(screen.queryByText(/Setup failed/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/Signed in successfully/i, {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it('keeps the unified wizard usable when ordinary setup protects an existing login', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.get.mockResolvedValue({ data: { defaultModel: null, models: [] } });
    mocks.post
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            success: false,
            code: 'CODEX_REAUTHENTICATION_REQUIRED',
            error: 'Portal stopped before it could delete the existing Codex credential.',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          sessionId: 'codex-unified-replace',
          status: 'polling_device',
          deviceCode: 'REPLACE-UNIFIED',
          verificationUrl: 'https://auth.openai.com/codex/device',
        },
      });

    render(<OAuthSetupFlow provider={codexProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));

    expect(await screen.findByText(/stopped before it could delete/i)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      '/ai-setup/native-cli/start',
      { provider: 'codex' },
    );
    const replace = screen.getByRole('button', { name: 'Replace existing Codex sign-in' });
    fireEvent.click(replace);

    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      '/ai-setup/native-cli/start',
      { provider: 'codex', forceReauth: true },
    ));
    expect(await screen.findByText('REPLACE-UNIFIED')).toBeInTheDocument();
  });

  it('keeps the direct wizard usable when ordinary setup protects an existing login', async () => {
    mocks.get.mockResolvedValue({ data: {} });
    mocks.post
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            success: false,
            code: 'CODEX_REAUTHENTICATION_REQUIRED',
            error: 'Portal stopped before it could delete the existing Codex credential.',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          sessionId: 'codex-direct-replace',
          status: 'polling_device',
          deviceCode: 'REPLACE-DIRECT',
          verificationUrl: 'https://auth.openai.com/codex/device',
        },
      });

    render(<NativeCliSetupFlow provider="codex" apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex Login' }));

    expect(await screen.findByText(/stopped before it could delete/i)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      '/ai-setup/native-cli/start',
      { provider: 'codex' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Replace existing Codex sign-in' }));

    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      '/ai-setup/native-cli/start',
      { provider: 'codex', forceReauth: true },
    ));
    expect(await screen.findByText('REPLACE-DIRECT')).toBeInTheDocument();
  });

  it('sends a committed unified-login finalization failure to review instead of reauthentication', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { success: true, sessionId: 'codex-committed-unified', status: 'complete', finalized: false },
    });
    mocks.get.mockImplementation(async (url: string) => {
      if (url.includes('/native-cli/status/')) {
        return {
          data: {
            id: 'codex-committed-unified',
            provider: 'codex',
            status: 'error',
            finalized: false,
            credentialState: 'committed',
            cleanupPending: false,
            error: 'The provider credential was saved, but Portal finalization failed.',
          },
        };
      }
      if (url.endsWith('/status')) return { data: { defaultModel: null } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      return { data: {} };
    });

    render(<OAuthSetupFlow provider={codexProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));

    expect(await screen.findByRole('button', { name: /Close and review provider status/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
  });

  it('sends a committed direct-login finalization failure to review instead of reauthentication', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { success: true, sessionId: 'codex-committed-direct', status: 'complete', finalized: false },
    });
    mocks.get.mockResolvedValue({
      data: {
        id: 'codex-committed-direct',
        provider: 'codex',
        status: 'error',
        finalized: false,
        credentialState: 'committed',
        cleanupPending: false,
        error: 'The provider credential was saved, but Portal finalization failed.',
      },
    });

    render(<NativeCliSetupFlow provider="codex" apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex Login' }));

    expect(await screen.findByRole('button', { name: /Close and review provider status/i }, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.queryByText(/Codex CLI is now authenticated/i)).not.toBeInTheDocument();
  });
});
