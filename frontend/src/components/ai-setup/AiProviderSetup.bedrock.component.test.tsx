// @vitest-environment jsdom
import '../../test/setup';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiProviderSetup from './AiProviderSetup';
import { SettingsMutationProvider } from '../settings/SettingsMutationContext';

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

const bedrockProvider = {
  id: 'amazon-bedrock',
  name: 'Amazon Bedrock',
  tier: 3,
  icon: 'cloud',
  primaryAuthType: 'aws_sdk',
  guidedSetup: {
    status: 'available',
    authTypes: ['aws_sdk'],
  },
  consoleUrl: 'https://console.aws.amazon.com/bedrock',
  signupUrl: 'https://aws.amazon.com/bedrock/',
  pricingNote: 'AWS usage-based billing.',
  freeTier: null,
  description: 'Uses AWS SDK credentials on the OpenClaw gateway host.',
  setupInstructions: [
    {
      stepNumber: 1,
      title: 'Configure AWS credentials',
      detail: 'Configure the AWS SDK default credential chain on the gateway host.',
    },
  ],
  defaultModels: [],
};

function SettingsOwnershipHarness({ children }: { children: ReactNode }) {
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const claim = useCallback((nextOwner: string) => {
    if (ownerRef.current) return false;
    ownerRef.current = nextOwner;
    setOwner(nextOwner);
    return true;
  }, []);
  const release = useCallback((nextOwner: string) => {
    if (ownerRef.current !== nextOwner) return;
    ownerRef.current = null;
    setOwner(null);
  }, []);
  const value = useMemo(() => ({ owner, claim, release }), [claim, owner, release]);
  return (
    <SettingsMutationProvider value={value}>
      <button type="button" disabled={Boolean(owner)}>Leave Settings</button>
      {children}
    </SettingsMutationProvider>
  );
}

describe('AiProviderSetup Amazon Bedrock routing', () => {
  beforeEach(() => {
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/catalog')) {
        return { data: { source: 'backend', providers: [bedrockProvider] } };
      }
      if (url.endsWith('/status')) {
        return {
          data: {
            openclawInstalled: true,
            openclawVersion: '2026.7.1',
            gatewayRunning: true,
            providers: [
              {
                id: 'amazon-bedrock',
                status: 'error',
                authType: 'aws_sdk',
                profileId: null,
                currentModel: null,
                readiness: {
                  state: 'missing_plugin',
                  checkedAt: '2026-07-20T23:00:00.000Z',
                  cached: false,
                  availableModelCount: 0,
                  message: 'The official Amazon Bedrock provider plugin is not installed on this OpenClaw host.',
                },
              },
            ],
            defaultModel: null,
            fallbackModels: [],
            configuredProfileCount: 0,
            activeProfiles: [],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('opens the manual AWS guide and never starts an OAuth request', async () => {
    render(
      <SettingsOwnershipHarness>
        <AiProviderSetup mode="settings" apiBase="/ai-setup" />
      </SettingsOwnershipHarness>,
    );

    const openClaw = await screen.findByRole('button', { name: /OpenClaw/i });
    fireEvent.click(openClaw);
    expect(screen.getByRole('heading', { name: 'All Providers' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Advanced / Other'));
    fireEvent.click(screen.getByRole('button', { name: /Amazon Bedrock/i }));

    expect(
      screen.getByRole('heading', { name: 'Connect Amazon Bedrock' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Amazon Bedrock is not an OAuth provider'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Provider plugin is missing'),
    ).toBeInTheDocument();
    expect(screen.getByText('Leave Settings').closest('button')).toBeDisabled();
    await waitFor(() => expect(mocks.clientGet).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(mocks.clientGet).toHaveBeenCalledWith(
      '/ai-setup/status',
      { params: { refreshProviderReadiness: '1' } },
    ));
    expect(mocks.clientPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Amazon Bedrock setup' }));
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeEnabled();
  });

  it('uses the same manual Bedrock route from the compact Agent Chat sidebar', async () => {
    render(<AiProviderSetup mode="settings" apiBase="/ai-setup" compact />);

    fireEvent.click(await screen.findByRole('button', { name: /OpenClaw/i }));
    fireEvent.click(screen.getByText('Advanced / Other'));
    fireEvent.click(screen.getByRole('button', { name: /Amazon Bedrock/i }));

    expect(
      screen.getByRole('heading', { name: 'Connect Amazon Bedrock' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Provider plugin is missing')).toBeInTheDocument();
    expect(mocks.clientPost).not.toHaveBeenCalled();
  });

  it('mounts the Settings additional provider card while OpenClaw status and catalog remain unresolved', () => {
    mocks.clientGet.mockReturnValue(new Promise(() => {}));

    render(
      <AiProviderSetup
        mode="settings"
        apiBase="/ai-setup"
        additionalProviderCards={<button type="button">Independent Agent Zero settings card</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Independent Agent Zero settings card' })).toBeInTheDocument();
    expect(screen.getByText('Loading provider status…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /OpenClaw/i })).not.toBeInTheDocument();
  });

  it('mounts the compact Agent Chat additional provider card while OpenClaw requests remain unresolved', () => {
    mocks.clientGet.mockReturnValue(new Promise(() => {}));

    render(
      <AiProviderSetup
        mode="settings"
        apiBase="/ai-setup"
        compact
        additionalProviderCards={<button type="button">Independent Agent Zero chat card</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Independent Agent Zero chat card' })).toBeInTheDocument();
    expect(screen.getByText('Loading provider status…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /OpenClaw/i })).not.toBeInTheDocument();
  });
});
