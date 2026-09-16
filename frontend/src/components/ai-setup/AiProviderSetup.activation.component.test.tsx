// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiProviderSetup from './AiProviderSetup';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    delete: mocks.remove,
  },
}));

// The real Claude dialog is covered by its own suite. Here it only needs to
// report a finished login so the shell's post-login handoff can be observed.
vi.mock('./SetupTokenFlow', () => ({
  default: ({ onComplete, onCancel }: { onComplete: () => void; onCancel: () => void }) => (
    <div role="dialog" aria-label="Stub Claude login">
      <button type="button" onClick={() => { onComplete(); onCancel(); }}>Finish stub login</button>
    </div>
  ),
}));

const anthropicProvider = {
  id: 'anthropic',
  name: 'Claude (OpenClaw)',
  icon: 'sparkles',
  tier: 1,
  primaryAuthType: 'setup_token',
  guidedSetup: { status: 'available', authTypes: ['setup_token'] },
  consoleUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  signupUrl: 'https://claude.ai/',
  pricingNote: 'Usage limits follow the account.',
  freeTier: null,
  description: 'Claude for OpenClaw.',
  setupInstructions: [],
  defaultModels: [],
};

const codexProvider = {
  id: 'openai-codex',
  name: 'OpenAI Codex (ChatGPT Subscription)',
  icon: 'code-2',
  tier: 1,
  primaryAuthType: 'oauth',
  guidedSetup: {
    status: 'manual',
    reason: 'Codex subscription sign-in is unavailable from Portal in this release.',
    action: { url: 'https://developers.openai.com/codex/auth', label: 'Review Codex authentication documentation' },
  },
  consoleUrl: 'https://chatgpt.com/',
  signupUrl: 'https://chatgpt.com/',
  pricingNote: 'Uses your ChatGPT subscription.',
  freeTier: null,
  description: 'ChatGPT subscription through OpenClaw.',
  setupInstructions: [],
  defaultModels: [],
};

function statusPayload() {
  return {
    openclawInstalled: true,
    openclawVersion: '2026.9.3',
    gatewayRunning: true,
    providers: [
      {
        id: 'anthropic', status: 'unconfigured', authType: null, profileId: null, currentModel: null, isDefault: false,
        error: null, cooldownUntil: null, lastUsed: null, expiresAt: null,
        nativeProvider: 'CLAUDE_CODE', nativeCliAuthStatus: 'authenticated',
      },
      {
        id: 'openai-codex', status: 'unconfigured', authType: null, profileId: null, currentModel: null, isDefault: false,
        error: null, cooldownUntil: null, lastUsed: null, expiresAt: null,
        nativeProvider: 'CODEX', nativeCliAuthStatus: 'needs_login',
      },
    ],
    defaultModel: null,
    fallbackModels: [],
    configuredProfileCount: 0,
    activeProfiles: [],
  };
}

function mockServer(oauthProviders?: unknown) {
  mocks.get.mockImplementation((url: string) => {
    if (url === '/ai-setup/status') return Promise.resolve({ data: statusPayload() });
    if (url === '/ai-setup/catalog') return Promise.resolve({ data: { source: 'backend', providers: [anthropicProvider, codexProvider] } });
    if (url === '/ai-setup/oauth/providers') {
      return oauthProviders === undefined
        ? Promise.reject({ response: { status: 404 } })
        : Promise.resolve({ data: oauthProviders });
    }
    if (url === '/ai-setup/models') {
      return Promise.resolve({ data: { source: 'native', models: [{ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', readiness: 'ready', registered: false }] } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('AiProviderSetup provider coverage and activation handoff', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.remove.mockReset();
  });

  it('shows the ChatGPT / Codex subscription card and explains why sign-in is unavailable instead of swallowing the click', async () => {
    mockServer();
    render(<AiProviderSetup mode="settings" apiBase="/ai-setup" />);

    const codexCard = await screen.findByRole('button', { name: /ChatGPT \/ Codex/i });
    expect(within(codexCard).getByText(/OpenClaw: not registered · Codex harness: needs login/)).toBeInTheDocument();
    fireEvent.click(codexCard);

    const notice = await screen.findByRole('dialog', { name: /OpenAI Codex \(ChatGPT Subscription\)/i });
    expect(within(notice).getByRole('status')).toHaveTextContent(/Codex subscription sign-in is unavailable from Portal in this release/);
    expect(within(notice).getByRole('link', { name: /Review Codex authentication documentation/i })).toHaveAttribute('href', 'https://developers.openai.com/codex/auth');
    const coverage = within(notice).getByTestId('provider-coverage-openai-codex');
    expect(within(coverage).getByText('Not signed in')).toBeInTheDocument();
    expect(within(coverage).getByText('Needs login')).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('opens the verify → models → default step after a Claude login completes', async () => {
    mockServer();
    render(<AiProviderSetup mode="settings" apiBase="/ai-setup" />);

    fireEvent.click(await screen.findByRole('button', { name: /^OpenClaw\b/ }));
    const picker = await screen.findByRole('dialog', { name: 'All Providers' });
    const subscription = within(picker).getByTestId('provider-group-subscription');
    expect(within(subscription).getByTestId('provider-row-openai-codex')).toHaveTextContent(/Codex subscription sign-in is unavailable/);
    fireEvent.click(within(subscription).getByRole('button', { name: /Claude \(OpenClaw\)/i }));

    fireEvent.click(await screen.findByRole('button', { name: 'Finish stub login' }));

    const activation = await screen.findByRole('dialog', { name: /Verify Claude \(OpenClaw\) and choose a model/i });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/ai-setup/models', { params: { provider: 'anthropic', refresh: '1' } }));
    expect(await within(activation).findByRole('radio', { name: /Claude Opus 5/i })).toBeInTheDocument();
    expect(within(activation).getByText(/same Claude credential store/i)).toBeInTheDocument();
  });

  it('lets the operator change the default model from the status bar and uses the server-reported OAuth support when present', async () => {
    mockServer({ providers: [{ id: 'openai-codex', supported: true, transport: 'native-wizard' }] });
    render(<AiProviderSetup mode="settings" apiBase="/ai-setup" />);

    fireEvent.click(await screen.findByRole('button', { name: /Change default model/i }));
    expect(await screen.findByRole('dialog', { name: /Choose OpenClaw's default model/i })).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/ai-setup/models', { params: { refresh: '1' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Close model activation' }));

    // With server-reported support the Codex card is a real sign-in, not a notice.
    fireEvent.click(screen.getByRole('button', { name: /ChatGPT \/ Codex/i }));
    expect(await screen.findByRole('dialog', { name: /Sign in to OpenAI Codex/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start OpenAI Codex .* sign-in/i })).toBeInTheDocument();
  });
});
