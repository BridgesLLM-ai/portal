// @vitest-environment jsdom
import '../../test/setup';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentZeroOAuthProviderId,
  AgentZeroOAuthProviderStatus,
  AgentZeroOAuthStatus,
  AgentZeroSetupStatus,
} from '../../api/agentRuntime';
import AgentZeroSetupPanel from './AgentZeroSetupPanel';
import { SettingsMutationProvider } from './SettingsMutationContext';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  oauthStatus: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  callback: vi.fn(),
  models: vi.fn(),
  disconnect: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('../../api/agentRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../api/agentRuntime')>('../../api/agentRuntime');
  return {
    ...actual,
    agentRuntimeAPI: {
      ...actual.agentRuntimeAPI,
      agentZeroStatus: mocks.status,
      agentZeroOAuthStatus: mocks.oauthStatus,
      startAgentZeroOAuth: mocks.start,
      pollAgentZeroOAuth: mocks.poll,
      completeAgentZeroOAuthCallback: mocks.callback,
      agentZeroOAuthModels: mocks.models,
      disconnectAgentZeroOAuth: mocks.disconnect,
      reconcileAgentZeroRuntime: mocks.reconcile,
    },
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuthStore: (selector: (state: any) => unknown) => selector({
    user: { id: 'owner-1', role: 'OWNER' },
  }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function readyStatus(): AgentZeroSetupStatus {
  return {
    testedVersions: { agentZero: '2.5', connector: '0.1.0', hostBridge: '2.5' },
    credentials: { configured: true, protected: true, reason: 'ready' },
    runtime: {
      installed: true,
      running: true,
      protocolReady: true,
      expectedVersion: '2.5',
      pinnedImage: true,
      loopbackOnly: true,
      persistentData: true,
      protectedAuth: true,
      restartPolicy: true,
      reason: 'ready',
    },
    authentication: { state: 'authenticated', authenticated: true, reason: 'ready' },
    hostGateway: {
      state: 'ready',
      installed: true,
      running: true,
      ready: true,
      expectedCliVersion: '2.5',
      gatewayId: 'bridgesllm-portal-host',
      capabilities: {
        scope: 'HOST_OPERATOR',
        fileRead: true,
        fileWrite: true,
        codeExecution: true,
        browser: false,
        computerUse: false,
      },
      reason: 'ready',
    },
    mainAgentChat: {
      scope: 'HOST_OPERATOR',
      available: true,
      contractReady: true,
      providerEnabled: true,
      reason: 'ready',
      steps: [],
    },
    projectSandbox: {
      scope: 'PROJECT_SANDBOX',
      available: true,
      contractReady: true,
      providerEnabled: true,
      reason: 'ready',
      steps: [],
    },
    actions: {
      provisionCredentials: { ownerOnly: true, confirmationPhrase: 'SAVE AGENT ZERO CREDENTIALS' },
      reconcileRuntime: { ownerOnly: true, confirmationPhrase: 'SET UP AGENT ZERO' },
      verifyAuthentication: { ownerOnly: true, available: true },
    },
    provider: {
      implemented: true,
      usable: true,
      supportedExecutionScopes: ['HOST_OPERATOR', 'PROJECT_SANDBOX'],
    },
    checkedAt: '2026-07-21T00:00:00.000Z',
  };
}

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
    connectionState: 'disconnected',
    reconnectRequired: false,
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
  };
}

function oauthStatus(connected: AgentZeroOAuthProviderId[] = []): AgentZeroOAuthStatus {
  const connectedProviders = new Set(connected);
  const providers = ([
    'codex_oauth',
    'github_copilot_oauth',
    'gemini_api_oauth',
    'xai_grok_oauth',
  ] as AgentZeroOAuthProviderId[]).map((providerId) => provider(providerId, connectedProviders.has(providerId) ? {
    connected: true,
    connectionState: 'connected',
    accountLabel: `${providerId}@example.com`,
  } : {}));
  return {
    available: true,
    routesInstalled: true,
    connectedCount: connected.length,
    availableCount: providers.length - connected.length,
    providers,
    checkedAt: '2026-07-21T00:00:00.000Z',
    actions: {
      disconnect: { ownerOnly: true, confirmationPhrase: 'DISCONNECT AGENT ZERO OAUTH' },
    },
  };
}

describe('AgentZeroSetupPanel provider presentation', () => {
  beforeEach(() => {
    mocks.status.mockResolvedValue(readyStatus());
    mocks.oauthStatus.mockResolvedValue(oauthStatus());
    mocks.models.mockResolvedValue({ providerId: 'codex_oauth', models: [] });
    mocks.reconcile.mockReset();
  });

  it('uses a standard provider card and opens the account surface in a body-owned modal', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ transform: 'translateX(1px)' }}>
        <AgentZeroSetupPanel view="providers" />
      </div>,
    );

    const card = await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i });
    expect(card).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByText('Official Agent Zero model OAuth')).not.toBeInTheDocument();

    await user.click(card);
    const dialog = screen.getByRole('dialog', { name: 'Agent Zero model accounts' });
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
    expect(await screen.findByText('Official Agent Zero model OAuth')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close Agent Zero model accounts' }));
    expect(screen.queryByRole('dialog', { name: 'Agent Zero model accounts' })).not.toBeInTheDocument();
  });

  it('keeps the compact Agent Chat entry collapsed until intentionally opened', async () => {
    render(<AgentZeroSetupPanel view="providers" compact />);

    const card = await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i });
    expect(card).toHaveClass('rounded-lg');
    expect(screen.queryByText('Official Agent Zero model OAuth')).not.toBeInTheDocument();
  });

  it('labels a ready runtime with zero OAuth accounts as not connected', async () => {
    render(<AgentZeroSetupPanel view="providers" compact />);

    const card = await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i });
    await waitFor(() => expect(within(card).getByText('No accounts connected')).toBeInTheDocument());
    expect(within(card).getByText(/Self-hosted alternative to OpenClaw · Ready/i)).toBeInTheDocument();
    expect(within(card).queryByText(/^Ready$/i)).not.toBeInTheDocument();
  });

  it('reports the actual connected OAuth account count separately from runtime readiness', async () => {
    mocks.oauthStatus.mockResolvedValue(oauthStatus(['codex_oauth', 'github_copilot_oauth']));
    render(<AgentZeroSetupPanel view="providers" />);

    const card = await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i });
    await waitFor(() => expect(within(card).getByText('2 accounts connected')).toBeInTheDocument());
    expect(within(card).getByText(/Runs on this server/i)).toBeInTheDocument();
  });

  it('claims Settings synchronously before an Agent Zero runtime confirmation can be submitted twice', async () => {
    const user = userEvent.setup();
    const reconciliation = deferred<{ status: AgentZeroSetupStatus; message: string }>();
    mocks.reconcile.mockReturnValue(reconciliation.promise);
    render(
      <SettingsOwnershipHarness>
        <AgentZeroSetupPanel />
      </SettingsOwnershipHarness>,
    );

    await user.click(await screen.findByRole('button', { name: 'Reconcile runtime' }));
    const dialog = screen.getByRole('dialog', { name: 'Install or repair Agent Zero?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Type SET UP AGENT ZERO to continue/i }),
      'SET UP AGENT ZERO',
    );
    const confirm = within(dialog).getByRole('button', { name: 'Reconcile runtime' });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenCalledWith('SET UP AGENT ZERO');
    expect(screen.getByText('Leave Settings').closest('button')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Reconcile runtime' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      reconciliation.resolve({ status: readyStatus(), message: 'Runtime reconciled.' });
      await reconciliation.promise;
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install or repair Agent Zero?' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeEnabled();
  });

  it('keeps one active device attempt owned and locks every outer dismissal path between polls', async () => {
    const user = userEvent.setup();
    mocks.start.mockResolvedValue({
      ok: true,
      providerId: 'codex_oauth',
      flow: 'device_code',
      attemptId: 'attempt-owned-by-codex',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'LOCK-CODE',
      authUrl: '',
      redirectUri: '',
      interval: 60,
      expiresAt: 2_000_000_000,
      message: '',
    });
    render(
      <SettingsOwnershipHarness>
        <AgentZeroSetupPanel view="providers" />
      </SettingsOwnershipHarness>,
    );

    await user.click(await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i }));
    await user.click(await screen.findByRole('button', { name: 'Connect Codex' }));
    expect(await screen.findByText('LOCK-CODE')).toBeInTheDocument();

    const close = screen.getByRole('button', { name: 'Close Agent Zero model accounts' });
    expect(close).toBeDisabled();
    expect(screen.getByText('Leave Settings').closest('button')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect GitHub Copilot' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Runtime setup' })).toHaveAttribute('aria-disabled', 'true');

    await user.keyboard('{Escape}');
    await user.click(document.querySelector('[data-viewport-modal-layer="true"]')!);
    expect(screen.getByRole('dialog', { name: 'Agent Zero model accounts' })).toBeVisible();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('allows dismissal while the read-only account status request is unresolved', async () => {
    const user = userEvent.setup();
    mocks.oauthStatus.mockReturnValue(new Promise(() => {}));
    render(<AgentZeroSetupPanel view="providers" />);

    await user.click(await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i }));
    const close = screen.getByRole('button', { name: 'Close Agent Zero model accounts' });
    expect(close).toBeEnabled();
    expect(screen.getByText(/Loading official OAuth providers/i)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Agent Zero model accounts' })).not.toBeInTheDocument());
  });

  it('allows dismissal while a read-only model catalog request is unresolved', async () => {
    const user = userEvent.setup();
    mocks.oauthStatus.mockResolvedValue(oauthStatus(['codex_oauth']));
    mocks.models.mockReturnValue(new Promise(() => {}));
    render(<AgentZeroSetupPanel view="providers" />);

    await user.click(await screen.findByRole('button', { name: /Agent Zero.*Self-hosted alternative to OpenClaw/i }));
    await user.click(await screen.findByRole('button', { name: 'View models' }));
    const close = screen.getByRole('button', { name: 'Close Agent Zero model accounts' });
    expect(close).toBeEnabled();

    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Agent Zero model accounts' })).not.toBeInTheDocument());
  });
});
