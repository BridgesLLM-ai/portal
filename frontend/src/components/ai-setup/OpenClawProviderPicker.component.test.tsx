// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OpenClawProviderPicker from './OpenClawProviderPicker';
import type { ProviderUIConfig } from './providerConfig';
import type { ProviderStatus } from './ProviderCard';

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
        onDeviceFlow={vi.fn()}
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
        onDeviceFlow={vi.fn()}
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
        onDeviceFlow={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Disconnect unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/OAuth and native credentials are not exact-removable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onRemove).toHaveBeenCalledWith(providers[4]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
