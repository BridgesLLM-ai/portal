// @vitest-environment jsdom
import '../../test/setup';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import { SettingsMutationProvider } from './SettingsMutationContext';
import OllamaTailnetSetup from './OllamaTailnetSetup';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  serverNetwork: vi.fn(),
  installServerTailscale: vi.fn(),
  connectServerNetwork: vi.fn(),
  connect: vi.fn(),
  reverifyAuthority: vi.fn(),
  verifyAuthority: vi.fn(),
  removeAuthority: vi.fn(),
  models: vi.fn(),
  catalog: vi.fn(),
  setActiveModel: vi.fn(),
  testModel: vi.fn(),
  acknowledgeLegacyHelperRetirement: vi.fn(),
  startPull: vi.fn(),
  pulls: vi.fn(),
  cancelPull: vi.fn(),
}));

vi.mock('../../api/ollamaTailnet', async () => {
  const actual = await vi.importActual<typeof import('../../api/ollamaTailnet')>(
    '../../api/ollamaTailnet',
  );
  return {
    ...actual,
    ollamaTailnetAPI: {
      status: mocks.status,
      serverNetwork: mocks.serverNetwork,
      installServerTailscale: mocks.installServerTailscale,
      connectServerNetwork: mocks.connectServerNetwork,
      connect: mocks.connect,
      reverifyAuthority: mocks.reverifyAuthority,
      verifyAuthority: mocks.verifyAuthority,
      removeAuthority: mocks.removeAuthority,
      models: mocks.models,
      catalog: mocks.catalog,
      setActiveModel: mocks.setActiveModel,
      testModel: mocks.testModel,
      acknowledgeLegacyHelperRetirement:
        mocks.acknowledgeLegacyHelperRetirement,
      startPull: mocks.startPull,
      pulls: mocks.pulls,
      cancelPull: mocks.cancelPull,
    },
  };
});

const timestamp = '2026-07-26T16:00:00.000Z';
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const peerFingerprintA = '1'.repeat(64);
const peerFingerprintB = '2'.repeat(64);
const peerFingerprintLinux = '3'.repeat(64);
const grantHashA = `sha256:${'4'.repeat(64)}`;
const grantHashB = `sha256:${'5'.repeat(64)}`;
const grantHashLinux = `sha256:${'6'.repeat(64)}`;
const stalePullOperationId = '123e4567-e89b-42d3-a456-426614174000';
const requestedPullOperationId =
  '123e4567-e89b-42d3-a456-426614174001';
const grantTemplateA = JSON.stringify({
  grants: [{
    src: ['100.64.10.20'],
    dst: ['100.64.0.7'],
    ip: ['tcp:11435'],
  }],
}, null, 2);
const grantTemplateB = JSON.stringify({
  grants: [{
    src: ['100.64.10.20'],
    dst: ['100.64.0.10'],
    ip: ['tcp:11435'],
  }],
}, null, 2);

function authority(overrides: Record<string, unknown> = {}) {
  return {
    id: 'binding-1',
    purposeId: 'PRIMARY',
    generation: 7,
    version: 3,
    state: 'ACTIVE',
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable-node-windows',
    nodePublicKey: `nodekey:${'c'.repeat(64)}`,
    address: '100.64.0.7',
    addressFamily: 'IPV4',
    servePort: 11435,
    bindingFingerprint: 'binding-fingerprint-7',
    selectedModel: 'qwen3.5:4b',
    selectedModelDigest: digestA,
    displayName: 'GPU workstation',
    observedAt: timestamp,
    verifiedAt: timestamp,
    activatedAt: timestamp,
    grantAcknowledgedAt: timestamp,
    grantSnapshotState: 'CURRENT',
    legacyHelperRetirementAcknowledgedAt: null,
    legacyHelperRetirementEvidence: null,
    updatedAt: timestamp,
    removedAt: null,
    ...overrides,
  } as const;
}

function pairingStatus(
  active: ReturnType<typeof authority> | null = null,
  overrides: Record<string, unknown> = {},
) {
  return {
    binding: {
      purposeId: 'PRIMARY',
      authority: active,
    },
    tailscale: {
      available: true,
      inventory: {
        tailnetName: 'example.ts.net',
        observedAt: timestamp,
        peers: [{
          tailnetName: 'example.ts.net',
          stableNodeId: 'stable-node-windows',
          nodePublicKey: `nodekey:${'c'.repeat(64)}`,
          address: '100.64.0.7',
          addressFamily: 'IPV4',
          displayName: 'GPU workstation',
          operatingSystem: 'windows',
          observedAt: timestamp,
          fingerprint: peerFingerprintA,
          grantTemplate: grantTemplateA,
          grantTemplateHash: grantHashA,
          online: true,
        }, {
          tailnetName: 'example.ts.net',
          stableNodeId: 'stable-node-windows-b',
          nodePublicKey: `nodekey:${'e'.repeat(64)}`,
          address: '100.64.0.10',
          addressFamily: 'IPV4',
          displayName: 'Backup GPU',
          operatingSystem: 'windows',
          observedAt: timestamp,
          fingerprint: peerFingerprintB,
          grantTemplate: grantTemplateB,
          grantTemplateHash: grantHashB,
          online: true,
        }, {
          tailnetName: 'example.ts.net',
          stableNodeId: 'stable-node-linux',
          nodePublicKey: `nodekey:${'d'.repeat(64)}`,
          address: '100.64.0.8',
          addressFamily: 'IPV4',
          displayName: 'Linux server',
          operatingSystem: 'linux',
          observedAt: timestamp,
          fingerprint: peerFingerprintLinux,
          grantTemplate: JSON.stringify({
            grants: [{
              src: ['100.64.10.20'],
              dst: ['100.64.0.8'],
              ip: ['tcp:11435'],
            }],
          }, null, 2),
          grantTemplateHash: grantHashLinux,
          online: true,
        }],
      },
      error: null,
    },
    setup: {
      servePort: 11435,
      windowsBundle: '/api/ollama/tailnet/setup-bundle.zip',
      serveCommand: 'tailscale serve --bg --tcp=11435 tcp://127.0.0.1:11434',
      removeCommand: 'tailscale serve --tcp=11435 off',
      legacyHelperRetireCommand: 'Start-Here.cmd --retire-legacy-helper',
      grantTemplate: '{ "src": ["tag:portal"], "dst": ["__BRIDGESLLM_GPU_TAILSCALE_IP__:11435"] }',
      grantWarning: 'Apply only this narrow grant.',
    },
    legacyRemoteAuthorityPresent: false,
    legacyHelperRetirement: {
      required: false,
      acknowledgedAt: null,
      evidence: null,
    },
    ...overrides,
  } as const;
}

function installedModels(models = [{
  name: 'qwen3.5:4b',
  digest: digestA,
  size: 3_400_000_000,
  modifiedAt: timestamp,
  details: {},
}, {
  name: 'qwen3.5:9b',
  digest: digestB,
  size: 6_600_000_000,
  modifiedAt: timestamp,
  details: {},
}]) {
  return {
    source: 'tailnet',
    models,
    authority: {
      kind: 'TAILNET',
      generation: 7,
      version: 3,
      fingerprint: 'binding-fingerprint-7',
    },
  } as const;
}

function serverNetwork(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    version: '1.98.9',
    daemonActive: true,
    backendState: 'Running',
    running: true,
    tailnetName: 'example.ts.net',
    hostName: 'portal-server',
    tailnetIp: '100.64.10.20',
    loginUrl: null,
    ...overrides,
  } as const;
}

function catalog() {
  return {
    warning: null,
    models: [{
      name: 'qwen3.5:4b',
      description: 'Balanced general model.',
      size: '3.4GB',
      sizeBytes: 3_400_000_000,
      useCase: 'general',
      contextWindow: '256K',
    }, {
      name: 'deepseek-r1:8b',
      description: 'Reasoning model for difficult prompts.',
      size: '5.2GB',
      sizeBytes: 5_200_000_000,
      useCase: 'reasoning',
      contextWindow: '128K',
    }],
  } as const;
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pull-1',
    operationId: stalePullOperationId,
    model: 'deepseek-r1:8b',
    state: 'running',
    phase: 'downloading',
    status: 'pulling layer',
    digest: digestB,
    totalBytes: 1_000,
    completedBytes: 250,
    percent: 25,
    speedBytesPerSecond: 100,
    etaSeconds: 8,
    eventSeq: 4,
    updatedAt: timestamp,
    canCancel: true,
    error: null,
    authority: {
      kind: 'TAILNET',
      generation: 7,
      version: 3,
      fingerprint: 'binding-fingerprint-7',
    },
    ...overrides,
  } as const;
}

function verification(
  binding = authority(),
) {
  return {
    binding,
    evidence: {
      ollamaVersion: '0.11.5',
      selectedModel: binding.selectedModel,
      selectedModelDigest: binding.selectedModelDigest,
      inventoryVerified: true,
      modelToolsVerified: true,
      inferenceVerified: true,
      verifiedAt: timestamp,
      checks: [{
        id: 'inference',
        label: 'Bounded model inference',
        state: 'pass',
        detail: 'The selected model returned one bounded response.',
      }],
    },
  } as const;
}

function SettingsHarness({ children }: { children: ReactNode }) {
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const claim = useCallback((next: string) => {
    if (ownerRef.current) return false;
    ownerRef.current = next;
    setOwner(next);
    return true;
  }, []);
  const release = useCallback((current: string) => {
    if (ownerRef.current !== current) return;
    ownerRef.current = null;
    setOwner(null);
  }, []);
  const value = useMemo(() => ({ owner, claim, release }), [
    claim,
    owner,
    release,
  ]);
  return (
    <SettingsMutationProvider value={value}>
      <button type="button" disabled={Boolean(owner)}>Leave settings</button>
      {children}
    </SettingsMutationProvider>
  );
}

function renderSettings(
  props: React.ComponentProps<typeof OllamaTailnetSetup> = {},
) {
  return render(
    <SettingsHarness>
      <OllamaTailnetSetup {...props} />
    </SettingsHarness>,
  );
}

describe('OllamaTailnetSetup native Remote GPU panel', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.status.mockResolvedValue(pairingStatus());
    mocks.serverNetwork.mockResolvedValue(serverNetwork());
    mocks.models.mockResolvedValue(installedModels([]));
    mocks.catalog.mockResolvedValue(catalog());
    mocks.pulls.mockResolvedValue([]);
    useAuthStore.setState({
      user: {
        id: 'owner-1',
        email: 'owner@example.com',
        username: 'owner',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
      },
      isAuthenticated: true,
      isLoading: false,
      sessionRestoreError: false,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps setup-handoff mode informational and performs no API work', () => {
    render(<OllamaTailnetSetup mode="setup-handoff" />);

    expect(screen.getByText('Add your Windows GPU after launch')).toBeVisible();
    expect(screen.getByText(/performs no discovery, download, authority, or model API work/i))
      .toBeVisible();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.serverNetwork).not.toHaveBeenCalled();
    expect(mocks.models).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.pulls).not.toHaveBeenCalled();
  });

  it('keeps all Remote GPU API work Owner-only', () => {
    useAuthStore.setState({
      user: {
        id: 'member-1',
        email: 'member@example.com',
        username: 'member',
        role: 'USER',
        accountStatus: 'ACTIVE',
      },
      isAuthenticated: true,
      isLoading: false,
      sessionRestoreError: false,
    });

    render(<OllamaTailnetSetup />);

    expect(screen.getByText('Owner access required')).toBeVisible();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.serverNetwork).not.toHaveBeenCalled();
    expect(mocks.models).not.toHaveBeenCalled();
  });

  it('does not request model inventory for a disconnected authority', async () => {
    mocks.status.mockResolvedValue(pairingStatus(authority({
      state: 'DISCONNECTED',
    })));

    renderSettings();

    const staleInventory = await screen.findByTestId(
      'remote-gpu-inventory-stale',
    );
    expect(staleInventory).toHaveTextContent(
      /Remote GPU is disconnected.*Reverify or reconnect/i,
    );
    expect(within(staleInventory).getByRole('button', {
      name: 'Retry inventory',
    })).toBeDisabled();
    expect(screen.getByRole('button', {
      name: 'Reverify connection',
    })).toBeEnabled();
    expect(mocks.models).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.serverNetwork).toHaveBeenCalledTimes(1);
      expect(mocks.catalog).toHaveBeenCalledTimes(1);
      expect(mocks.pulls).toHaveBeenCalledTimes(1);
    });
  });

  it('installs Tailscale on the Portal server and sends an auth key once', async () => {
    const user = userEvent.setup();
    const disconnected = serverNetwork({
      installed: false,
      version: null,
      daemonActive: false,
      backendState: null,
      running: false,
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
    });
    const installed = serverNetwork({
      running: false,
      backendState: 'NeedsLogin',
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
    });
    mocks.serverNetwork.mockResolvedValue(disconnected);
    mocks.installServerTailscale.mockResolvedValue(installed);
    mocks.connectServerNetwork.mockResolvedValue(serverNetwork());

    renderSettings();

    await user.click(await screen.findByRole('button', {
      name: 'Install Tailscale on this server',
    }));
    await waitFor(() => {
      expect(mocks.installServerTailscale).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole('button', {
      name: 'Get a sign-in link',
    })).toBeVisible();

    await user.click(screen.getByText(
      'Advanced: connect with an auth key instead',
    ));
    const authKey = screen.getByLabelText('Tailscale auth key');
    await user.type(authKey, 'tskey-auth-send-once');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.connectServerNetwork).toHaveBeenCalledWith({
        authKey: 'tskey-auth-send-once',
      });
    });
    expect(authKey).toHaveValue('');
    expect(await screen.findByText(/This Portal server joined example\.ts\.net/i))
      .toBeVisible();
  });

  it('reconciles an interrupted server Tailscale install without replaying it', async () => {
    const user = userEvent.setup();
    const disconnected = serverNetwork({
      installed: false,
      version: null,
      daemonActive: false,
      backendState: null,
      running: false,
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
    });
    const installed = serverNetwork({
      running: false,
      backendState: 'NeedsLogin',
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
    });
    mocks.serverNetwork
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValue(installed);
    mocks.installServerTailscale.mockRejectedValue(
      new Error('connection reset after install commit'),
    );

    renderSettings();
    await user.click(await screen.findByRole('button', {
      name: 'Install Tailscale on this server',
    }));

    expect(await screen.findByText(
      /Tailscale installation succeeded; Portal confirmed it after the original response was interrupted/i,
    )).toBeVisible();
    expect(mocks.installServerTailscale).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', {
      name: 'Get a sign-in link',
    })).toBeVisible();
  });

  it('reconciles an interrupted auth-key connection without replaying the key', async () => {
    const user = userEvent.setup();
    const needsLogin = serverNetwork({
      running: false,
      backendState: 'NeedsLogin',
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
    });
    const connected = serverNetwork();
    mocks.serverNetwork
      .mockResolvedValueOnce(needsLogin)
      .mockResolvedValue(connected);
    mocks.connectServerNetwork.mockRejectedValue(
      new Error('connection reset after tailscale up commit'),
    );

    renderSettings();
    await user.click(await screen.findByText(
      'Advanced: connect with an auth key instead',
    ));
    const authKey = screen.getByLabelText('Tailscale auth key');
    await user.type(authKey, 'tskey-auth-send-once');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(
      /This Portal server joined example\.ts\.net as portal-server; Portal confirmed it after the original response was interrupted/i,
    )).toBeVisible();
    expect(mocks.connectServerNetwork).toHaveBeenCalledTimes(1);
    expect(mocks.connectServerNetwork).toHaveBeenCalledWith({
      authKey: 'tskey-auth-send-once',
    });
    expect(authKey).toHaveValue('');
  });

  it('requests a browser sign-in link and bounds approval polling', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    const needsLogin = serverNetwork({
      running: false,
      backendState: 'NeedsLogin',
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
    });
    const pending = serverNetwork({
      running: false,
      backendState: 'NeedsLogin',
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
      loginUrl: 'https://login.tailscale.com/a/example',
    });
    mocks.serverNetwork
      .mockResolvedValueOnce(needsLogin)
      .mockResolvedValue(pending);
    mocks.connectServerNetwork.mockResolvedValue(pending);

    renderSettings();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', {
      name: 'Get a sign-in link',
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.connectServerNetwork).toHaveBeenCalledWith({});
    expect(screen.getByRole('link', { name: 'Open Tailscale sign-in' }))
      .toHaveAttribute('href', pending.loginUrl);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(mocks.serverNetwork.mock.calls.length).toBeLessThanOrEqual(31);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /did not detect Tailscale approval within five minutes/i,
    );
    const boundedCallCount = mocks.serverNetwork.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.serverNetwork).toHaveBeenCalledTimes(boundedCallCount);
  });

  it('discovers one exact Windows peer, provides one setup zip, and connects with null CAS after narrow Grant acknowledgement', async () => {
    const user = userEvent.setup();
    const connected = authority({
      selectedModel: null,
      selectedModelDigest: null,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus())
      .mockResolvedValue(pairingStatus(connected));
    mocks.connect.mockResolvedValue(connected);
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderSettings();

    await screen.findByRole('heading', { name: 'Choose a Windows PC' });
    const windowsPeer = screen.getByRole('radio', {
      name: /GPU workstation/i,
    });
    const linuxPeer = screen.getByRole('radio', {
      name: /Linux server/i,
    });
    expect(linuxPeer).toBeDisabled();

    await user.click(windowsPeer);
    expect(screen.getByRole('link', { name: 'Download Windows setup' }))
      .toHaveAttribute('href', '/api/ollama/tailnet/setup-bundle.zip');
    expect(screen.getByRole('heading', {
      name: 'Run the Windows setup as Administrator',
    })).toBeVisible();
    expect(screen.getByText(
      /Tailscale says Serve commands should run in an Administrator terminal/i,
    )).toBeVisible();
    expect(screen.getByText(
      /Approve the one UAC prompt when asked/i,
    )).toBeVisible();
    expect(screen.getByText(
      /no helper or background window remains open/i,
    )).toBeVisible();

    await user.click(screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    }));
    await user.click(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    }));

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        stableNodeId: 'stable-node-windows',
        expectedGeneration: null,
        expectedVersion: null,
        expectedPeerAttestationFingerprint: peerFingerprintA,
        expectedGrantTemplateHash: grantHashA,
        grantAcknowledged: true,
      });
    });
    expect(storageSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/download a model now, even if its inventory is empty/i))
      .toBeVisible();
  });

  it('requires a fresh Grant acknowledgement and atomically CAS-replaces an active same-ID peer snapshot', async () => {
    const user = userEvent.setup();
    const active = authority();
    const current = pairingStatus(active);
    const refreshedPeer = {
      ...current.tailscale.inventory.peers[0],
      nodePublicKey: `nodekey:${'9'.repeat(64)}`,
      address: '100.64.0.77',
      fingerprint: '7'.repeat(64),
      grantTemplate: JSON.stringify({
        grants: [{
          src: ['100.64.10.21'],
          dst: ['100.64.0.77'],
          ip: ['tcp:11435'],
        }],
      }, null, 2),
      grantTemplateHash: `sha256:${'8'.repeat(64)}`,
    };
    const drifted = pairingStatus(active, {
      tailscale: {
        ...current.tailscale,
        inventory: {
          ...current.tailscale.inventory,
          peers: [
            refreshedPeer,
            ...current.tailscale.inventory.peers.slice(1),
          ],
        },
      },
    });
    const replacement = authority({
      generation: 8,
      version: 1,
      nodePublicKey: refreshedPeer.nodePublicKey,
      address: refreshedPeer.address,
      selectedModel: null,
      selectedModelDigest: null,
    });
    mocks.status
      .mockResolvedValueOnce(drifted)
      .mockResolvedValue(pairingStatus(replacement));
    mocks.connect.mockResolvedValue(replacement);

    renderSettings();

    await screen.findByText('GPU workstation');
    await user.click(screen.getByRole('button', {
      name: 'Reconnect / change GPU',
    }));
    expect(screen.getByRole('radio', { name: /GPU workstation/i }))
      .toBeChecked();
    const acknowledgement = screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    });
    expect(acknowledgement).not.toBeChecked();
    expect(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    })).toBeDisabled();

    await user.click(acknowledgement);
    await user.click(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    }));

    await waitFor(() => {
      expect(mocks.connect).toHaveBeenCalledWith({
        stableNodeId: 'stable-node-windows',
        expectedGeneration: 7,
        expectedVersion: 3,
        expectedPeerAttestationFingerprint: refreshedPeer.fingerprint,
        expectedGrantTemplateHash: refreshedPeer.grantTemplateHash,
        grantAcknowledged: true,
      });
    });
    await waitFor(() => expect(screen.queryByRole('heading', {
      name: 'Choose a Windows PC',
    })).not.toBeInTheDocument());
    expect(screen.getByText('GPU workstation')).toBeVisible();
  });

  it('cancels reconnect without mutating or hiding the current authority summary', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue(pairingStatus(authority()));

    renderSettings();

    await screen.findByText('GPU workstation');
    await user.click(screen.getByRole('button', {
      name: 'Reconnect / change GPU',
    }));
    expect(screen.getByRole('heading', {
      name: 'Choose a Windows PC',
    })).toBeVisible();

    await user.click(screen.getByRole('button', {
      name: 'Cancel reconnect',
    }));

    expect(screen.queryByRole('heading', {
      name: 'Choose a Windows PC',
    })).not.toBeInTheDocument();
    expect(screen.getByText('GPU workstation')).toBeVisible();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('materializes the Grant for only the selected peer and changes only its exact destination', async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    renderSettings();

    await screen.findByRole('heading', { name: 'Choose a Windows PC' });
    await user.click(screen.getByRole('radio', { name: /GPU workstation/i }));
    await user.click(screen.getByText('Narrow Tailscale Grant template'));
    const accessControls = screen.getByRole('link', {
      name: 'Tailscale Access Controls',
    });
    expect(accessControls)
      .toHaveAttribute('href', 'https://login.tailscale.com/admin/acls');
    expect(accessControls).toHaveAttribute('target', '_blank');
    expect(accessControls).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Never replace your whole policy/i)).toBeVisible();
    expect(screen.getByText(/Save and validate the policy/i)).toBeVisible();

    const firstTemplate = JSON.parse(
      screen.getByTestId('remote-gpu-grant-template').textContent || '{}',
    ) as { grants: Array<{ src: string[]; dst: string[]; ip: string[] }> };
    expect(firstTemplate).toEqual({
      grants: [{
        src: ['100.64.10.20'],
        dst: ['100.64.0.7'],
        ip: ['tcp:11435'],
      }],
    });
    expect(firstTemplate.grants[0].dst).toHaveLength(1);
    expect(firstTemplate.grants[0].dst.join('')).not.toContain('*');

    await user.click(screen.getByRole('button', {
      name: 'Copy Grant template',
    }));
    expect(clipboardWrite).toHaveBeenLastCalledWith(
      grantTemplateA,
    );

    await user.click(screen.getByRole('radio', { name: /Backup GPU/i }));
    const secondTemplate = JSON.parse(
      screen.getByTestId('remote-gpu-grant-template').textContent || '{}',
    ) as { grants: Array<{ src: string[]; dst: string[]; ip: string[] }> };
    expect(secondTemplate).toEqual({
      grants: [{
        src: ['100.64.10.20'],
        dst: ['100.64.0.10'],
        ip: ['tcp:11435'],
      }],
    });
    expect(secondTemplate.grants[0].src)
      .toEqual(firstTemplate.grants[0].src);
    expect(secondTemplate.grants[0].dst).toHaveLength(1);
    expect(secondTemplate.grants[0].dst).not.toContain('100.64.0.7');
    expect(secondTemplate.grants[0].dst.join('')).not.toContain('*');
  });

  it('refuses Grant acknowledgement and connection when the exact peer token is absent', async () => {
    const user = userEvent.setup();
    const invalidStatus = pairingStatus();
    mocks.status.mockResolvedValue({
      ...invalidStatus,
      tailscale: {
        ...invalidStatus.tailscale,
        inventory: {
          ...invalidStatus.tailscale.inventory,
          peers: invalidStatus.tailscale.inventory.peers.map((peer, index) => (
            index === 0
              ? { ...peer, grantTemplate: null, grantTemplateHash: null }
              : peer
          )),
        },
      },
    });

    renderSettings();

    await screen.findByRole('heading', { name: 'Choose a Windows PC' });
    await user.click(screen.getByRole('radio', { name: /GPU workstation/i }));
    await user.click(screen.getByText('Narrow Tailscale Grant template'));
    expect(screen.getByText(/could not materialize an exact Portal-to-GPU Grant/i))
      .toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Grant template' }))
      .toBeDisabled();
    expect(screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    })).toBeDisabled();
    expect(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    })).toBeDisabled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('refuses Grant acknowledgement when the Portal Tailnet IP is unresolved', async () => {
    const user = userEvent.setup();
    const invalidStatus = pairingStatus();
    mocks.status.mockResolvedValue({
      ...invalidStatus,
      tailscale: {
        ...invalidStatus.tailscale,
        inventory: {
          ...invalidStatus.tailscale.inventory,
          peers: invalidStatus.tailscale.inventory.peers.map((peer, index) => (
            index === 0
              ? { ...peer, grantTemplate: null, grantTemplateHash: null }
              : peer
          )),
        },
      },
    });

    renderSettings();

    await screen.findByRole('heading', { name: 'Choose a Windows PC' });
    await user.click(screen.getByRole('radio', { name: /GPU workstation/i }));
    await user.click(screen.getByText('Narrow Tailscale Grant template'));
    expect(screen.getByRole('button', { name: 'Copy Grant template' }))
      .toBeDisabled();
    expect(screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    })).toBeDisabled();
    expect(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    })).toBeDisabled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    {
      change: 'peer key and address',
      peer: {
        nodePublicKey: `nodekey:${'9'.repeat(64)}`,
        address: '100.64.0.77',
        fingerprint: '7'.repeat(64),
        grantTemplate: JSON.stringify({
          grants: [{
            src: ['100.64.10.20'],
            dst: ['100.64.0.77'],
            ip: ['tcp:11435'],
          }],
        }, null, 2),
        grantTemplateHash: `sha256:${'8'.repeat(64)}`,
      },
    },
    {
      change: 'Portal source and exact Grant template',
      peer: {
        grantTemplate: JSON.stringify({
          grants: [{
            src: ['100.64.10.21'],
            dst: ['100.64.0.7'],
            ip: ['tcp:11435'],
          }],
        }, null, 2),
        grantTemplateHash: `sha256:${'9'.repeat(64)}`,
      },
    },
  ])('resets Grant acknowledgement when the refreshed $change changes', async ({
    peer: peerChanges,
  }) => {
    const user = userEvent.setup();
    const initial = pairingStatus();
    const changed = pairingStatus(null, {
      tailscale: {
        ...initial.tailscale,
        inventory: {
          ...initial.tailscale.inventory,
          peers: initial.tailscale.inventory.peers.map((peer, index) => (
            index === 0 ? { ...peer, ...peerChanges } : peer
          )),
        },
      },
    });
    mocks.status
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(changed);

    renderSettings();

    await screen.findByRole('heading', { name: 'Choose a Windows PC' });
    await user.click(screen.getByRole('radio', { name: /GPU workstation/i }));
    const acknowledgement = screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    });
    await user.click(acknowledgement);
    expect(acknowledgement).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(acknowledgement).not.toBeChecked());
    expect(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    })).toBeDisabled();
  });

  it('switches an installed model using its exact digest and authority CAS without reconnecting', async () => {
    const user = userEvent.setup();
    const active = authority();
    const switched = authority({
      version: 4,
      selectedModel: 'qwen3.5:9b',
      selectedModelDigest: digestB,
    });
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.setActiveModel.mockResolvedValue(switched);

    renderSettings();

    await screen.findByText('qwen3.5:9b');
    await user.click(screen.getByRole('button', { name: 'Use model' }));

    await waitFor(() => {
      expect(mocks.setActiveModel).toHaveBeenCalledWith({
        model: 'qwen3.5:9b',
        expectedDigest: digestB,
        generation: 7,
        expectedVersion: 3,
      });
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(screen.getByText(/connection did not need to be rebuilt/i)).toBeVisible();
  });

  it('keeps a committed connection truthful when its inventory refresh fails, then retries', async () => {
    const user = userEvent.setup();
    const connected = authority({
      selectedModel: null,
      selectedModelDigest: null,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus())
      .mockResolvedValue(pairingStatus(connected));
    mocks.models
      .mockResolvedValueOnce(installedModels([{
        name: 'old-authority-only:1b',
        digest: digestA,
        size: 1_000,
        modifiedAt: timestamp,
        details: {},
      }]))
      .mockRejectedValueOnce(new Error('inventory link unavailable'))
      .mockResolvedValue(installedModels([]));
    mocks.connect.mockResolvedValue(connected);

    renderSettings();
    await user.click(await screen.findByRole('radio', {
      name: /GPU workstation/i,
    }));
    await user.click(screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    }));
    await user.click(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    }));

    expect(await screen.findByText(
      /Remote GPU connection succeeded, but installed-model inventory could not be refreshed/i,
    )).toBeVisible();
    expect(screen.getByText(
      /GPU workstation is connected/i,
    )).toBeVisible();
    expect(screen.getByTestId('remote-gpu-inventory-stale')).toBeVisible();
    expect(screen.queryByText('old-authority-only:1b')).not.toBeInTheDocument();
    expect(screen.queryByText(/Portal could not connect to the selected Windows GPU/i))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry inventory' }));
    await waitFor(() => {
      expect(screen.queryByTestId('remote-gpu-inventory-stale'))
        .not.toBeInTheDocument();
    });
    expect(screen.getByText('Installed-model inventory refreshed.')).toBeVisible();
  });

  it('reconciles a committed connection when the mutation response is lost', async () => {
    const user = userEvent.setup();
    const connected = authority({
      selectedModel: null,
      selectedModelDigest: null,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus())
      .mockResolvedValue(pairingStatus(connected));
    mocks.connect.mockRejectedValue(new Error('connection reset after commit'));
    mocks.models.mockResolvedValue(installedModels([]));

    renderSettings();
    await user.click(await screen.findByRole('radio', {
      name: /GPU workstation/i,
    }));
    await user.click(screen.getByRole('checkbox', {
      name: /I applied the narrow Tailscale Grant/i,
    }));
    await user.click(screen.getByRole('button', {
      name: 'Connect GPU workstation',
    }));

    expect(await screen.findByText(
      /connected successfully; Portal confirmed it after the original response was interrupted/i,
    )).toBeVisible();
    expect(screen.queryByText(/Portal could not connect/i)).not.toBeInTheDocument();
  });

  it('keeps a committed model switch truthful when inventory refresh fails', async () => {
    const user = userEvent.setup();
    const active = authority();
    const switched = authority({
      version: 4,
      selectedModel: 'qwen3.5:9b',
      selectedModelDigest: digestB,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValue(pairingStatus(switched));
    mocks.models
      .mockResolvedValueOnce(installedModels())
      .mockRejectedValueOnce(new Error('inventory reread failed'))
      .mockResolvedValue(installedModels());
    mocks.setActiveModel.mockResolvedValue(switched);

    renderSettings();
    await user.click(await screen.findByRole('button', {
      name: 'Use model',
    }));

    expect(await screen.findByText(
      /qwen3\.5:9b is active, but installed-model inventory could not be refreshed/i,
    )).toBeVisible();
    expect(screen.getByText(
      /qwen3\.5:9b passed the bounded one-token test and is now the active Remote GPU model/i,
    )).toBeVisible();
    expect(screen.getByTestId('remote-gpu-inventory-stale')).toBeVisible();
    expect(screen.queryByText(/Portal could not activate qwen3\.5:9b/i))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry inventory' }));
    await waitFor(() => {
      expect(screen.queryByTestId('remote-gpu-inventory-stale'))
        .not.toBeInTheDocument();
    });
  });

  it('reconciles an exact model activation after a lost mutation response', async () => {
    const user = userEvent.setup();
    const active = authority();
    const switched = authority({
      version: 4,
      selectedModel: 'qwen3.5:9b',
      selectedModelDigest: digestB,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValue(pairingStatus(switched));
    mocks.models.mockResolvedValue(installedModels());
    mocks.setActiveModel.mockRejectedValue(
      new Error('socket closed after model commit'),
    );

    renderSettings();
    await user.click(await screen.findByRole('button', {
      name: 'Use model',
    }));

    expect(await screen.findByText(
      /qwen3\.5:9b is active\. Portal confirmed the exact digest after the original response was interrupted/i,
    )).toBeVisible();
    expect(screen.queryByText(/Portal could not activate qwen3\.5:9b/i))
      .not.toBeInTheDocument();
  });

  it('polls through a stale readback and reconciles a committed model activation after a proxy 5xx', async () => {
    const user = userEvent.setup();
    const active = authority();
    const switched = authority({
      version: 4,
      selectedModel: 'qwen3.5:9b',
      selectedModelDigest: digestB,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValue(pairingStatus(switched));
    mocks.models.mockResolvedValue(installedModels());
    mocks.setActiveModel.mockRejectedValue({
      response: {
        status: 503,
        data: { error: 'proxy lost the committed response' },
      },
    });

    renderSettings();
    await user.click(await screen.findByRole('button', {
      name: 'Use model',
    }));

    expect(await screen.findByText(
      /qwen3\.5:9b is active\. Portal confirmed the exact digest after the original response was interrupted/i,
    )).toBeVisible();
    expect(mocks.status).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/proxy lost the committed response/i))
      .not.toBeInTheDocument();
  });

  it('offers an explicit rebind when the selected tag now has a different installed digest', async () => {
    const user = userEvent.setup();
    const active = authority();
    const rebound = authority({
      version: 4,
      selectedModelDigest: digestB,
    });
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels([{
      name: 'qwen3.5:4b',
      digest: digestB,
      size: 3_500_000_000,
      modifiedAt: timestamp,
      details: {},
    }]));
    mocks.setActiveModel.mockResolvedValue(rebound);

    renderSettings();

    expect(await screen.findByText('Updated digest available')).toBeVisible();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Use updated digest',
    }));

    await waitFor(() => {
      expect(mocks.setActiveModel).toHaveBeenCalledWith({
        model: 'qwen3.5:4b',
        expectedDigest: digestB,
        generation: 7,
        expectedVersion: 3,
      });
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('retains the current model when updated-digest verification fails', async () => {
    const user = userEvent.setup();
    const active = authority();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels([{
      name: 'qwen3.5:4b',
      digest: digestB,
      size: 3_500_000_000,
      modifiedAt: timestamp,
      details: {},
    }]));
    mocks.setActiveModel.mockRejectedValue({
      response: {
        status: 422,
        data: { error: 'one-token test failed' },
      },
    });

    renderSettings();

    await user.click(await screen.findByRole('button', {
      name: 'Use updated digest',
    }));

    expect(await screen.findByText('one-token test failed')).toBeVisible();
    expect(screen.getByText('Updated digest available')).toBeVisible();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('opens validated catalog details in a protected new tab', async () => {
    const active = authority();
    const catalogSnapshot = catalog();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.catalog.mockResolvedValue({
      ...catalogSnapshot,
      models: [{
        ...catalogSnapshot.models[1],
        sourceUrl: 'https://ollama.com/library/deepseek-r1',
      }],
    });

    renderSettings();

    const link = await screen.findByRole('link', { name: 'View on Ollama' });
    expect(link).toHaveAttribute(
      'href',
      'https://ollama.com/library/deepseek-r1',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const fullLibrary = screen.getByRole('link', {
      name: 'Browse the full Ollama library',
    });
    expect(fullLibrary).toHaveAttribute('href', 'https://ollama.com/search');
    expect(fullLibrary).toHaveAttribute('target', '_blank');
    expect(fullLibrary).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/paste any exact model tag in the field below/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download exact tag' })).toBeVisible();
  });

  it('shows real determinate pull progress, cancels the exact job, and retries the exact failed model', async () => {
    const user = userEvent.setup();
    const active = authority();
    const running = pull();
    const failed = pull({
      id: 'pull-failed',
      model: 'qwen3.5:9b',
      state: 'failed',
      phase: 'complete',
      status: 'download failed',
      totalBytes: null,
      completedBytes: null,
      percent: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      eventSeq: 8,
      canCancel: false,
      error: 'The Remote GPU ran out of disk space.',
    });
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.pulls.mockResolvedValue([running, failed]);
    mocks.cancelPull.mockResolvedValue({
      ...running,
      state: 'cancelling',
      status: 'cancelling',
      canCancel: false,
      eventSeq: 5,
    });
    mocks.startPull.mockImplementation(async (input) => ({
      ...failed,
      id: 'pull-retry',
      operationId: input.operationId,
      state: 'running',
      phase: 'resolving',
      status: 'resolving model',
      eventSeq: 1,
      canCancel: true,
      error: null,
    }));

    renderSettings();

    const progress = await screen.findByRole('progressbar', {
      name: 'Current layer progress for deepseek-r1:8b',
    });
    expect(progress).toHaveAttribute('aria-valuenow', '25');
    expect(progress).toHaveAttribute(
      'aria-valuetext',
      '25 percent of the current layer',
    );
    expect(screen.getByText(/Current layer: 250 B of 1000 B · 25%/i))
      .toBeVisible();
    expect(screen.getByText('Current layer progress')).toBeVisible();
    expect(screen.getByText('downloading')).toBeVisible();
    expect(screen.getByText(`Layer digest: ${digestB}`)).toBeVisible();
    expect(screen.getAllByText(
      /Percent and ETA describe Ollama's current model layer/i,
    ).length).toBeGreaterThan(0);
    expect(screen.getAllByText(
      /Cancelling or restarting Portal can leave reusable partial layers/i,
    ).length).toBeGreaterThan(0);
    expect(screen.getByText('The Remote GPU ran out of disk space.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(mocks.cancelPull).toHaveBeenCalledWith('pull-1');
    });

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(mocks.startPull).toHaveBeenCalledWith({
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
        model: 'qwen3.5:9b',
        expectedAuthority: {
          kind: 'TAILNET',
          generation: 7,
          version: 3,
          fingerprint: 'binding-fingerprint-7',
        },
      });
    });
  });

  it('does not mistake a retained same-model job for a response-lost pull when initial pull inventory failed', async () => {
    const user = userEvent.setup();
    const active = authority();
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(requestedPullOperationId);
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.pulls
      .mockRejectedValueOnce(new Error('initial pull inventory unavailable'))
      .mockResolvedValueOnce([
        pull({
          id: 'retained-same-model-job',
          operationId: stalePullOperationId,
        }),
      ]);
    mocks.startPull.mockRejectedValue(new Error('response interrupted'));

    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(mocks.startPull).toHaveBeenCalledWith({
        operationId: requestedPullOperationId,
        model: 'deepseek-r1:8b',
        expectedAuthority: {
          kind: 'TAILNET',
          generation: 7,
          version: 3,
          fingerprint: 'binding-fingerprint-7',
        },
      });
    });
    expect(await screen.findByText(
      /could not confirm whether the deepseek-r1:8b download started after the response was interrupted/i,
    )).toBeVisible();
    expect(screen.queryByText(
      /confirmed the pull after the original response was interrupted/i,
    )).not.toBeInTheDocument();
  });

  it('reconciles a response-lost pull only by its exact operation key', async () => {
    const user = userEvent.setup();
    const active = authority();
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(requestedPullOperationId);
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.pulls
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        pull({
          id: 'retained-same-model-job',
          operationId: stalePullOperationId,
        }),
        pull({
          id: 'newly-accepted-job',
          operationId: requestedPullOperationId,
        }),
      ]);
    mocks.startPull.mockRejectedValue(new Error('response interrupted'));

    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Download' }));

    expect(await screen.findByText(
      /Started downloading deepseek-r1:8b; Portal confirmed the pull after the original response was interrupted/i,
    )).toBeVisible();
  });

  it.each([
    {
      state: 'succeeded',
      error: null,
      expected: /deepseek-r1:8b finished downloading before Portal could confirm the cancellation response/i,
    },
    {
      state: 'failed',
      error: 'The Remote GPU ran out of disk space.',
      expected: /deepseek-r1:8b failed before Portal could confirm the cancellation response: The Remote GPU ran out of disk space/i,
    },
    {
      state: 'timed_out',
      error: null,
      expected: /deepseek-r1:8b timed out before Portal could confirm the cancellation response/i,
    },
  ] as const)('reports a naturally $state pull instead of claiming cancellation was accepted', async ({
    state,
    error,
    expected,
  }) => {
    const user = userEvent.setup();
    const active = authority();
    const running = pull();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.pulls
      .mockResolvedValueOnce([running])
      .mockResolvedValueOnce([
        pull({
          state,
          phase: state === 'succeeded' ? 'complete' : 'downloading',
          status: state,
          canCancel: false,
          error,
        }),
      ]);
    mocks.cancelPull.mockRejectedValue(new Error('response interrupted'));

    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.queryByText(
      /Cancellation was accepted for deepseek-r1:8b/i,
    )).not.toBeInTheDocument();
  });

  it('never presents or retries retained pull jobs from a different GPU authority', async () => {
    const active = authority();
    const stale = pull({
      id: 'gpu-a-failed-pull',
      model: 'llama3.2:3b',
      state: 'failed',
      phase: 'complete',
      status: 'download failed on previous GPU',
      canCancel: false,
      error: 'Previous GPU was unavailable.',
      authority: {
        kind: 'TAILNET',
        generation: 6,
        version: 9,
        fingerprint: 'previous-gpu-binding',
      },
    });
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.pulls.mockResolvedValue([stale]);

    renderSettings();

    await waitFor(() => expect(mocks.pulls).toHaveBeenCalled());
    expect(screen.queryByText('llama3.2:3b')).not.toBeInTheDocument();
    expect(screen.queryByText(/Previous GPU was unavailable/i))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' }))
      .not.toBeInTheDocument();
    expect(mocks.startPull).not.toHaveBeenCalled();
  });

  it('uses an honest indeterminate progressbar when Ollama has not reported a total', async () => {
    const active = authority();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.pulls.mockResolvedValue([
      pull({
        totalBytes: null,
        completedBytes: null,
        percent: null,
        speedBytesPerSecond: null,
        etaSeconds: null,
        status: 'pulling manifest',
      }),
    ]);

    renderSettings();

    const progress = await screen.findByRole('progressbar', {
      name: 'Current layer progress for deepseek-r1:8b',
    });
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress).toHaveAttribute(
      'aria-valuetext',
      'Current layer: pulling manifest',
    );
    expect(screen.getByText(
      /Waiting for Ollama to report current-layer byte counters/i,
    ))
      .toBeVisible();
  });

  it('does not expose determinate ARIA progress for inconsistent layer counters', async () => {
    const active = authority();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.pulls.mockResolvedValue([
      pull({
        totalBytes: 1_000,
        completedBytes: 1_001,
        percent: 100,
      }),
    ]);

    renderSettings();

    const progress = await screen.findByRole('progressbar', {
      name: 'Current layer progress for deepseek-r1:8b',
    });
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText(
      /Waiting for Ollama to report current-layer byte counters/i,
    )).toBeVisible();
  });

  it('polls active pulls and refreshes inventory after a successful terminal snapshot', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    const active = authority();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.pulls
      .mockResolvedValueOnce([pull()])
      .mockResolvedValueOnce([
        pull({
          state: 'succeeded',
          phase: 'complete',
          status: 'success',
          completedBytes: 1_000,
          percent: 100,
          speedBytesPerSecond: null,
          etaSeconds: 0,
          eventSeq: 9,
          canCancel: false,
        }),
      ]);

    renderSettings();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.pulls).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(mocks.pulls).toHaveBeenCalledTimes(2);
    expect(mocks.models.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('runs bounded diagnostics against the active CAS', async () => {
    const user = userEvent.setup();
    const active = authority();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.testModel.mockResolvedValue(verification(active));

    renderSettings();

    await screen.findByRole('button', { name: 'Test model' });
    await user.click(screen.getByRole('button', { name: 'Test model' }));

    await waitFor(() => {
      expect(mocks.testModel).toHaveBeenCalledWith({
        generation: 7,
        expectedVersion: 3,
      });
    });
    expect(screen.getByText('Bounded model inference')).toBeVisible();
    expect(screen.getByText(/selected model returned one bounded response/i))
      .toBeVisible();
  });

  it('keeps the legacy helper intact and hides retirement before native activation', async () => {
    mocks.status.mockResolvedValue(pairingStatus(null, {
      legacyRemoteAuthorityPresent: true,
    }));

    renderSettings();

    const transition = await screen.findByTestId(
      'remote-gpu-legacy-transition',
    );
    expect(within(transition).getByText(
      /remains the live Ollama authority while you complete native setup/i,
    )).toBeVisible();
    expect(within(transition).getByText(
      /Native model browsing, downloads with live progress, and model switching become available here after Connect succeeds/i,
    )).toBeVisible();
    expect(within(transition).queryByText(
      'Start-Here.cmd --retire-legacy-helper',
    )).not.toBeInTheDocument();
    expect(within(transition).queryByRole('button', {
      name: 'Copy post-activation cleanup',
    })).not.toBeInTheDocument();
  });

  it('offers the exact legacy cleanup only after native authority is active', async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    mocks.status.mockResolvedValue(pairingStatus(authority(), {
      legacyRemoteAuthorityPresent: true,
      legacyHelperRetirement: {
        required: true,
        acknowledgedAt: null,
        evidence: null,
      },
    }));
    mocks.models.mockResolvedValue(installedModels());

    renderSettings();

    const transition = await screen.findByTestId(
      'remote-gpu-legacy-transition',
    );
    expect(within(transition).getByText(
      /native Remote GPU is active/i,
    )).toBeVisible();
    expect(within(transition).getByText(
      /requests one UAC prompt when needed and never runs cleanup without an Administrator token/i,
    )).toBeVisible();
    expect(within(transition).getByText(
      'Start-Here.cmd --retire-legacy-helper',
    )).toBeVisible();

    await user.click(within(transition).getByRole('button', {
      name: 'Copy post-activation cleanup',
    }));
    expect(clipboardWrite).toHaveBeenLastCalledWith(
      'Start-Here.cmd --retire-legacy-helper',
    );
    expect(within(transition).getByRole('button', {
      name: 'Record completed cleanup',
    })).toBeVisible();
  });

  it('records durable legacy retirement evidence and converges the warning', async () => {
    const user = userEvent.setup();
    const evidence =
      `legacy-helper-retirement:v1:sha256:${'8'.repeat(64)}`;
    const active = authority();
    const acknowledged = authority({
      version: 4,
      legacyHelperRetirementAcknowledgedAt: timestamp,
      legacyHelperRetirementEvidence: evidence,
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active, {
        legacyRemoteAuthorityPresent: true,
        legacyHelperRetirement: {
          required: true,
          acknowledgedAt: null,
          evidence: null,
        },
      }))
      .mockResolvedValue(pairingStatus(acknowledged, {
        legacyRemoteAuthorityPresent: true,
        legacyHelperRetirement: {
          required: false,
          acknowledgedAt: timestamp,
          evidence,
        },
      }));
    mocks.models.mockResolvedValue(installedModels());
    mocks.acknowledgeLegacyHelperRetirement.mockResolvedValue(
      acknowledged,
    );

    renderSettings();

    const transition = await screen.findByTestId(
      'remote-gpu-legacy-transition',
    );
    await user.click(within(transition).getByRole('button', {
      name: 'Record completed cleanup',
    }));

    await waitFor(() => {
      expect(mocks.acknowledgeLegacyHelperRetirement).toHaveBeenCalledWith({
        generation: 7,
        expectedVersion: 3,
        cleanupConfirmed: true,
      });
    });
    const completed = await screen.findByTestId(
      'remote-gpu-legacy-retirement-complete',
    );
    expect(within(completed).getByText(evidence)).toBeVisible();
    expect(screen.queryByTestId('remote-gpu-legacy-transition'))
      .not.toBeInTheDocument();
  });

  it('never presents a stale Grant snapshot as healthy ACTIVE', async () => {
    mocks.status.mockResolvedValue(pairingStatus(authority({
      grantSnapshotState: 'CHANGED',
    })));
    mocks.models.mockResolvedValue(installedModels());

    renderSettings();

    expect(await screen.findByText('RECONNECT REQUIRED')).toBeVisible();
    expect(screen.getByText(/Remote requests are blocked/i)).toBeVisible();
    expect(screen.queryByText(/^ACTIVE$/)).not.toBeInTheDocument();
  });

  it('keeps the exact scoped Serve cleanup visible across refresh without an authority', async () => {
    const user = userEvent.setup();
    mocks.status.mockResolvedValue(pairingStatus());

    renderSettings();

    const cleanup = await screen.findByTestId('remote-gpu-scoped-cleanup');
    expect(within(cleanup).getByText('tailscale serve --tcp=11435 off'))
      .toBeVisible();
    expect(within(cleanup).getByText(
      /not other Tailscale Serve configuration/i,
    )).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect(within(screen.getByTestId('remote-gpu-scoped-cleanup')).getByText(
      'tailscale serve --tcp=11435 off',
    )).toBeVisible();
  });

  it('never exposes Serve-off controls while an authority is live, including after remount', async () => {
    const live = pairingStatus(authority({
      generation: 8,
      version: 1,
      bindingFingerprint: 'binding-fingerprint-8',
    }));
    mocks.status.mockResolvedValue(live);
    mocks.models.mockResolvedValue(installedModels());

    const first = renderSettings();
    expect(await screen.findByTestId('remote-gpu-cleanup-protected'))
      .toBeVisible();
    expect(screen.queryByText('tailscale serve --tcp=11435 off'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy cleanup command' }))
      .not.toBeInTheDocument();

    first.unmount();
    renderSettings();
    expect(await screen.findByTestId('remote-gpu-cleanup-protected'))
      .toBeVisible();
    expect(screen.queryByText('tailscale serve --tcp=11435 off'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy cleanup command' }))
      .not.toBeInTheDocument();
  });

  it('requires typed confirmation for exact-CAS removal and exposes only scoped Serve cleanup', async () => {
    const user = userEvent.setup();
    const active = authority();
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValue(pairingStatus());
    mocks.models.mockResolvedValue(installedModels());
    mocks.removeAuthority.mockResolvedValue(authority({
      state: 'REMOVED',
      removedAt: timestamp,
    }));

    renderSettings();

    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(mocks.removeAuthority).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'REMOVE REMOTE GPU');
    await user.click(within(dialog).getByRole('button', {
      name: 'Remove Remote GPU',
    }));

    await waitFor(() => {
      expect(mocks.removeAuthority).toHaveBeenCalledWith({
        generation: 7,
        expectedVersion: 3,
      });
    });
    expect(await screen.findByText('tailscale serve --tcp=11435 off'))
      .toBeVisible();
    expect(screen.getByText(/not other Tailscale Serve configuration/i))
      .toBeVisible();
  });

  it('reconciles committed removal after the response is lost and keeps old inventory hidden', async () => {
    const user = userEvent.setup();
    const active = authority();
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValue(pairingStatus());
    mocks.models.mockResolvedValue(installedModels());
    mocks.removeAuthority.mockRejectedValue(
      new Error('connection reset after removal commit'),
    );

    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'REMOVE REMOTE GPU');
    await user.click(within(dialog).getByRole('button', {
      name: 'Remove Remote GPU',
    }));

    expect(await screen.findByText(
      /Remote GPU removal succeeded; Portal confirmed it after the original response was interrupted/i,
    )).toBeVisible();
    expect(screen.getByText('tailscale serve --tcp=11435 off')).toBeVisible();
    expect(screen.queryByText('qwen3.5:4b')).not.toBeInTheDocument();
    expect(screen.queryByText(/Remote GPU authority could not be removed/i))
      .not.toBeInTheDocument();
  });

  it('does not instruct Serve cleanup when the same peer reconnects before removal readback', async () => {
    const user = userEvent.setup();
    const active = authority();
    const reconnected = authority({
      generation: 8,
      version: 1,
      bindingFingerprint: 'binding-fingerprint-8',
    });
    mocks.status
      .mockResolvedValueOnce(pairingStatus(active))
      .mockResolvedValue(pairingStatus(reconnected));
    mocks.models.mockResolvedValue(installedModels());
    mocks.removeAuthority.mockRejectedValue(
      new Error('connection reset after removal commit'),
    );

    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'REMOVE REMOTE GPU');
    await user.click(within(dialog).getByRole('button', {
      name: 'Remove Remote GPU',
    }));

    expect(await screen.findByText(
      /same Windows PC is already connected again\. Do not run the Serve cleanup command/i,
    )).toBeVisible();
    expect(screen.queryByText(
      /Run the exact cleanup command only on the removed Windows PC/i,
    )).not.toBeInTheDocument();
    expect(screen.getByTestId('remote-gpu-cleanup-withheld')).toBeVisible();
    expect(screen.queryByText('tailscale serve --tcp=11435 off'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: 'Copy cleanup command',
    })).not.toBeInTheDocument();
  });

  it('withholds Serve cleanup while a lost removal outcome remains unknown', async () => {
    const user = userEvent.setup();
    const active = authority();
    mocks.status.mockResolvedValue(pairingStatus(active));
    mocks.models.mockResolvedValue(installedModels());
    mocks.removeAuthority.mockRejectedValue(
      new Error('connection reset with outcome unknown'),
    );

    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'REMOVE REMOTE GPU');
    await user.click(within(dialog).getByRole('button', {
      name: 'Remove Remote GPU',
    }));

    expect(await screen.findByText(
      /could not confirm the removal outcome after the response was interrupted/i,
      {},
      { timeout: 4_000 },
    )).toBeVisible();
    expect(screen.getByTestId('remote-gpu-cleanup-withheld')).toBeVisible();
    expect(screen.queryByText('tailscale serve --tcp=11435 off'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: 'Copy cleanup command',
    })).not.toBeInTheDocument();
  });
});
