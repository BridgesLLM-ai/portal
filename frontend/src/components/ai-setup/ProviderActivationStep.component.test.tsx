// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderActivationStep from './ProviderActivationStep';
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

const anthropic: ProviderUIConfig = {
  id: 'anthropic',
  name: 'Claude (OpenClaw)',
  icon: 'sparkles',
  tier: 1,
  primaryAuthType: 'setup_token',
  guidedSetup: { status: 'available', authTypes: ['setup_token', 'api_key'] },
  consoleUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  signupUrl: 'https://claude.ai/',
  pricingNote: 'Usage limits follow the account.',
  freeTier: null,
  description: 'Claude through OpenClaw.',
  setupInstructions: [],
  defaultModels: [],
};

function statusPayload(overrides: { defaultModel?: string | null; anthropicStatus?: 'configured' | 'unconfigured' } = {}) {
  return {
    openclawInstalled: true,
    openclawVersion: '2026.9.3',
    gatewayRunning: true,
    providers: [{
      id: 'anthropic',
      status: overrides.anthropicStatus || 'unconfigured',
      authType: overrides.anthropicStatus === 'configured' ? 'cli' : null,
      profileId: null,
      currentModel: null,
      isDefault: false,
      error: null,
      cooldownUntil: null,
      lastUsed: null,
      expiresAt: null,
      nativeProvider: 'CLAUDE_CODE',
      nativeCliAuthStatus: 'authenticated',
      nativeCliAuthMessage: 'Claude Code is signed in.',
    }],
    defaultModel: overrides.defaultModel ?? null,
    fallbackModels: [],
    configuredProfileCount: 0,
    activeProfiles: [],
  };
}

const readinessModels = {
  source: 'native',
  runtime: 'claude-cli',
  models: [
    { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', readiness: 'ready', registered: false },
    { id: 'anthropic/claude-fable-5-1', name: 'Claude Fable 5.1', readiness: 'unavailable', registered: false, reason: 'Not entitled on this account.' },
  ],
};

function mockServer(options: {
  initialStatus?: unknown;
  models?: unknown;
  readbackStatus?: unknown;
} = {}) {
  let statusCalls = 0;
  let modelCalls = 0;
  mocks.get.mockImplementation((url: string) => {
    if (url === '/ai-setup/status') {
      statusCalls += 1;
      const payload = statusCalls === 1 ? (options.initialStatus ?? statusPayload()) : (options.readbackStatus ?? options.initialStatus ?? statusPayload());
      return Promise.resolve({ data: payload });
    }
    if (url === '/ai-setup/models') {
      modelCalls += 1;
      const data = options.models ?? { ...readinessModels, models: readinessModels.models.map((model) => ({ ...model, registered: modelCalls > 1 })) };
      return Promise.resolve({ data });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ProviderActivationStep', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  it('verifies the login, registers the chosen ready model, sets it as default, and only reports success after the server readback agrees', async () => {
    mockServer({
      readbackStatus: statusPayload({ defaultModel: 'anthropic/claude-opus-5', anthropicStatus: 'configured' }),
    });
    mocks.post.mockResolvedValue({ data: { success: true } });
    const onChanged = vi.fn();

    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} onChanged={onChanged} />);

    expect(await screen.findByRole('dialog', { name: /Verify Claude \(OpenClaw\) and choose a model/i })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/ai-setup/status', { params: { refreshProviderReadiness: '1' } });
    expect(mocks.get).toHaveBeenCalledWith('/ai-setup/models', { params: { provider: 'anthropic', refresh: '1' } });

    // Login and runtime facts stay separate.
    const coverage = await screen.findByTestId('provider-coverage-anthropic');
    expect(within(coverage).getAllByText('Signed in').length).toBeGreaterThanOrEqual(1);
    expect(within(coverage).getByText('Not registered')).toBeInTheDocument();
    expect(screen.getByTestId('activation-current-default')).toHaveTextContent('No default model configured yet');
    expect(screen.getByTestId('activation-model-source')).toHaveTextContent('source: native · runtime: claude-cli');

    const opus = screen.getByRole('radio', { name: /Claude Opus 5/i });
    const fable = screen.getByRole('radio', { name: /Claude Fable 5.1/i });
    expect(fable).toBeDisabled();
    expect(screen.getByText('Not entitled on this account.')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: /Use as default model/i });
    expect(apply).toBeDisabled();

    fireEvent.click(opus);
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    expect(await screen.findByRole('status')).toHaveTextContent('Default model confirmed');
    expect(screen.getByTestId('activation-confirmed-model')).toHaveTextContent("OpenClaw's default model is now anthropic/claude-opus-5. Confirmed by the refreshed server status.");
    expect(mocks.post).toHaveBeenNthCalledWith(1, '/ai-setup/register-models', { provider: 'anthropic', models: ['anthropic/claude-opus-5'] }, { _skipNetworkRetry: true });
    expect(mocks.post).toHaveBeenNthCalledWith(2, '/ai-setup/set-default-model', { model: 'anthropic/claude-opus-5', provider: 'anthropic' }, { _skipNetworkRetry: true });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('refuses to report success when the server accepted the request but the readback default differs', async () => {
    mockServer({ readbackStatus: statusPayload({ defaultModel: null }) });
    mocks.post.mockResolvedValue({ data: { success: true } });

    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Claude Opus 5/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use as default model/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/refreshed default model is not set rather than anthropic\/claude-opus-5\. Nothing is confirmed/i);
    expect(screen.queryByText(/Default model confirmed/i)).not.toBeInTheDocument();
  });

  it('surfaces the exact server rejection for a default-model change instead of a static success', async () => {
    mockServer();
    mocks.post.mockImplementation((url: string) => {
      if (url === '/ai-setup/register-models') return Promise.resolve({ data: { success: true } });
      return Promise.reject({
        response: {
          status: 503,
          data: {
            error: 'This OpenClaw host mutation is unavailable in this release; a crash-recoverable maintenance operation has not shipped.',
            code: 'OPENCLAW_HOST_MUTATION_UNAVAILABLE',
            operationDisposition: 'not_admitted',
          },
        },
      });
    });

    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Claude Opus 5/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use as default model/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/This OpenClaw host mutation is unavailable in this release/);
    expect(alert).toHaveTextContent('(OPENCLAW_HOST_MUTATION_UNAVAILABLE)');
    expect(screen.queryByText(/Default model confirmed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use as default model/i })).toBeDisabled();
  });

  it('keeps a preset-only model list unselectable and says why', async () => {
    mockServer({
      models: { source: 'defaults', models: [{ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }] },
    });

    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} />);

    const opus = await screen.findByRole('radio', { name: /Claude Opus 5/i });
    expect(opus).toBeDisabled();
    expect(within(opus).getByText('Not verified')).toBeInTheDocument();
    expect(screen.getByText(/candidates only: they do not prove the login is usable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use as default model/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Keep current default/i })).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('lists every registered model when choosing a default without a provider and posts without a provider id', async () => {
    mockServer({
      initialStatus: statusPayload({ defaultModel: 'anthropic/claude-opus-5' }),
      models: {
        source: 'gateway',
        models: [
          { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
          { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        ],
      },
      readbackStatus: statusPayload({ defaultModel: 'openai/gpt-5.6-sol' }),
    });
    mocks.post.mockResolvedValue({ data: { success: true } });

    render(<ProviderActivationStep provider={null} apiBase="/ai-setup" mode="default" onClose={vi.fn()} />);

    expect(await screen.findByRole('dialog', { name: /Choose OpenClaw's default model/i })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/ai-setup/models', { params: { refresh: '1' } });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Claude Opus 5/i })).toHaveAttribute('aria-checked', 'true'));
    expect(within(screen.getByRole('radio', { name: /Claude Opus 5/i })).getByText('Current default')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /GPT-5.6 Sol/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use as default model/i }));

    expect(await screen.findByText(/Default model confirmed/i)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/set-default-model', { model: 'openai/gpt-5.6-sol' }, { _skipNetworkRetry: true });
  });
});


describe('model write reconciliation', () => {
  beforeEach(() => { mocks.get.mockReset(); mocks.post.mockReset(); });
  it('does not send a default change after a pending registration or replay it before a re-check', async () => {
    mockServer();
    mocks.post.mockResolvedValue({ status: 202, data: { success: false, code: 'MODEL_ACTIVATION_PENDING' } });
    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Claude Opus 5/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use as default model/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still confirming/);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Use as default model/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(mocks.get.mock.calls.filter(([url]) => url === '/ai-setup/models')).toHaveLength(2));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Default model confirmed')).not.toBeInTheDocument();
  });
  it('does not confirm registration when the refreshed catalog still says unregistered', async () => {
    mockServer({ models: readinessModels });
    mocks.post.mockResolvedValue({ data: { success: true } });
    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Claude Opus 5/i }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Register model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/has not confirmed model registration/);
    expect(screen.queryByText('Model registered')).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('offers a read-only retry when initial discovery fails', async () => {
    mocks.get.mockRejectedValue(new Error('Gateway reconnecting'));
    render(<ProviderActivationStep provider={anthropic} apiBase="/ai-setup" mode="post-login" onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Re-check' })).toBeEnabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
