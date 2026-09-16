// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OpenClawProviderPicker from './OpenClawProviderPicker';
import type { ProviderUIConfig } from './providerConfig';
import type { ProviderStatus } from './ProviderCard';
import { buildProviderCoverageMap } from './providerCoverage';
import type { OAuthProviderSupport } from './openclawAuthWizardContract';

const codexProvider: ProviderUIConfig = {
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
  authOptions: [],
  consoleUrl: 'https://chatgpt.com/',
  signupUrl: 'https://chatgpt.com/',
  pricingNote: 'ChatGPT subscription.',
  freeTier: null,
  description: 'ChatGPT subscription through OpenClaw.',
  setupInstructions: [],
  defaultModels: [],
};

const providers: ProviderUIConfig[] = [
  {
    id: 'google-antigravity',
    name: 'Google Antigravity',
    icon: 'globe',
    tier: 1,
    primaryAuthType: 'native_cli',
    guidedSetup: { status: 'available', authTypes: ['native_cli'] },
    authOptions: [],
    consoleUrl: 'https://gemini.google.com/',
    signupUrl: 'https://gemini.google.com/',
    pricingNote: 'Native subscription path.',
    freeTier: null,
    description: 'Portal-native Gemini harness.',
    setupInstructions: [],
    defaultModels: [],
  },
  {
    id: 'google-gemini-cli',
    name: 'Google Gemini CLI (OpenClaw)',
    icon: 'terminal',
    tier: 1,
    primaryAuthType: 'oauth',
    guidedSetup: { status: 'available', authTypes: ['oauth'] },
    authOptions: [],
    consoleUrl: 'https://gemini.google.com/',
    signupUrl: 'https://gemini.google.com/',
    pricingNote: 'OpenClaw OAuth path.',
    freeTier: null,
    description: 'Separate OpenClaw provider.',
    setupInstructions: [],
    defaultModels: [],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    icon: 'smile',
    tier: 3,
    primaryAuthType: 'api_key',
    guidedSetup: {
      status: 'manual',
      reason: 'Portal does not yet have an authoritative credential-validation and save flow.',
      action: { url: 'https://huggingface.co/docs', label: 'Open Hugging Face documentation' },
    },
    authOptions: [],
    consoleUrl: 'https://huggingface.co/settings/tokens',
    signupUrl: 'https://huggingface.co/join',
    pricingNote: 'Provider pricing.',
    freeTier: null,
    description: 'Manual provider.',
    setupInstructions: [],
    defaultModels: [],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    icon: 'cpu',
    tier: 3,
    primaryAuthType: 'token',
    guidedSetup: {
      status: 'manual',
      reason: 'Portal does not render or validate Cerebras token setup yet.',
      action: { url: 'https://inference-docs.cerebras.ai/', label: 'Open Cerebras documentation' },
    },
    authOptions: [],
    consoleUrl: 'https://inference.cerebras.ai/',
    signupUrl: 'https://inference.cerebras.ai/',
    pricingNote: 'Provider pricing.',
    freeTier: null,
    description: 'Manual provider.',
    setupInstructions: [],
    defaultModels: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: 'route',
    tier: 1,
    primaryAuthType: 'api_key',
    guidedSetup: { status: 'available', authTypes: ['api_key'] },
    authOptions: [],
    consoleUrl: 'https://openrouter.ai/settings/keys',
    signupUrl: 'https://openrouter.ai/',
    pricingNote: 'Provider pricing.',
    freeTier: null,
    description: 'Portal-owned API-key provider.',
    setupInstructions: [],
    defaultModels: [],
  },
];

function providerStatus(id: string, supported: boolean): ProviderStatus {
  return {
    id,
    status: 'configured',
    authType: 'api_key',
    profileId: `${id}:default`,
    currentModel: null,
    isDefault: false,
    error: null,
    cooldownUntil: null,
    lastUsed: null,
    expiresAt: null,
    removal: {
      supported,
      code: supported ? 'PORTAL_OWNED_API_KEY' : 'UNSUPPORTED_CREDENTIAL_SURFACE',
      reason: supported ? 'Exact Portal-owned profile.' : 'OAuth and native credentials are not exact-removable.',
      requiresExactConfirmation: true,
    },
  };
}

describe('OpenClawProviderPicker provider boundaries', () => {
  it('keeps native Antigravity out while retaining the separate Gemini CLI OAuth provider', () => {
    const onSelect = vi.fn();
    render(
      <OpenClawProviderPicker
        providers={providers}
        statusMap={new Map()}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Google Antigravity')).not.toBeInTheDocument();
    const openClawGemini = screen.getByRole('button', { name: /Google Gemini CLI \(OpenClaw\)/i });
    fireEvent.click(openClawGemini);
    expect(onSelect).toHaveBeenCalledWith(providers[1]);
  });

  it('shows unsupported providers as disabled manual entries and never launches a setup flow', () => {
    const onSelect = vi.fn();
    render(
      <OpenClawProviderPicker
        providers={providers}
        statusMap={new Map()}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Advanced / Other'));
    const huggingFace = screen.getByRole('button', { name: /Hugging Face/i });
    const cerebras = screen.getByRole('button', { name: /Cerebras/i });
    expect(huggingFace).toBeDisabled();
    expect(cerebras).toBeDisabled();
    expect(screen.getByText(/does not render or validate Cerebras token setup yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Cerebras documentation/i }))
      .toHaveAttribute('href', 'https://inference-docs.cerebras.ai/');

    fireEvent.click(huggingFace);
    fireEvent.click(cerebras);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders Disconnect only from the backend capability and does not launch reconfiguration', () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <OpenClawProviderPicker
        providers={providers}
        statusMap={new Map([
          ['openrouter', providerStatus('openrouter', true)],
          ['google-gemini-cli', providerStatus('google-gemini-cli', false)],
        ])}
        onSelect={onSelect}
        onRemove={onRemove}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Disconnect unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/OAuth and native credentials are not exact-removable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onRemove).toHaveBeenCalledWith(providers[4]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('lists every subscription provider under Subscription / Sign-in, including ones this server cannot sign in, with the reason visible', () => {
    const onSelect = vi.fn();
    const statusMap = new Map<string, ProviderStatus>([
      ['openai-codex', { ...providerStatus('openai-codex', false), status: 'unconfigured', authType: null, profileId: null, nativeProvider: 'CODEX', nativeCliAuthStatus: 'needs_login' }],
    ]);
    render(
      <OpenClawProviderPicker
        providers={[...providers, codexProvider]}
        statusMap={statusMap}
        coverageMap={buildProviderCoverageMap([...providers, codexProvider], statusMap)}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const subscription = screen.getByTestId('provider-group-subscription');
    const codexRow = within(subscription).getByTestId('provider-row-openai-codex');
    const codexButton = within(codexRow).getByRole('button', { name: /OpenAI Codex/i });
    expect(codexButton).toBeDisabled();
    expect(within(codexRow).getByText(/Codex subscription sign-in is unavailable from Portal in this release/)).toBeInTheDocument();
    expect(within(codexRow).getByRole('link', { name: /Review Codex authentication documentation/i }))
      .toHaveAttribute('href', 'https://developers.openai.com/codex/auth');
    const coverage = within(codexRow).getByTestId('provider-coverage-openai-codex');
    expect(within(coverage).getByText('Not signed in')).toBeInTheDocument();
    expect(within(coverage).getByText('Not registered')).toBeInTheDocument();
    expect(within(coverage).getByText('Needs login')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-group-advanced')).not.toContainElement(codexRow);

    fireEvent.click(codexButton);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('lets server-reported OAuth support override the static catalog in both directions', () => {
    const onSelect = vi.fn();
    const oauthSupport = new Map<string, OAuthProviderSupport>([
      ['openai-codex', { id: 'openai-codex', supported: true, transport: 'native-wizard', authChoice: null, mode: null, code: null, methods: ['oauth'], reason: null, documentationUrl: null }],
      ['google-gemini-cli', { id: 'google-gemini-cli', supported: false, transport: null, authChoice: null, mode: null, code: null, methods: [], reason: 'Gemini CLI is not installed on this server.', documentationUrl: 'https://docs.openclaw.ai/providers/google' }],
    ]);
    render(
      <OpenClawProviderPicker
        providers={[...providers, codexProvider]}
        statusMap={new Map()}
        oauthSupport={oauthSupport}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const subscription = screen.getByTestId('provider-group-subscription');
    fireEvent.click(within(subscription).getByRole('button', { name: /OpenAI Codex/i }));
    expect(onSelect).toHaveBeenCalledWith(codexProvider);

    const gemini = within(subscription).getByRole('button', { name: /Google Gemini CLI \(OpenClaw\)/i });
    expect(gemini).toBeDisabled();
    expect(within(subscription).getByText('Gemini CLI is not installed on this server.')).toBeInTheDocument();
    expect(within(subscription).getByRole('link', { name: /Open provider documentation/i }))
      .toHaveAttribute('href', 'https://docs.openclaw.ai/providers/google');
  });
});
