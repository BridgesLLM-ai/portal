const mockReadNativeOllamaBinding = jest.fn();
const mockRemoveNativeOllamaBinding = jest.fn();
const mockAcknowledgeNativeOllamaLegacyHelperRetirement = jest.fn();
const mockReadLegacyOllamaBindingPresence = jest.fn();
const mockListCurrentAttestedTailscalePeers = jest.fn();
const mockConnectNativeOllamaBackend = jest.fn();
const mockReverifyNativeOllamaBackend = jest.fn();
const mockDiagnoseNativeOllamaBackend = jest.fn();
const mockListNativeOllamaInstalledModels = jest.fn();
const mockSelectNativeOllamaBackendModel = jest.fn();
const mockTestNativeOllamaBackendModel = jest.fn();
const mockWithOllamaAuthorityMutationFence = jest.fn();
const mockReadTailnetServerNetworkStatus = jest.fn();
const mockInstallTailscaleOnServer = jest.fn();
const mockConnectServerWithAuthKey = jest.fn();
const mockStartServerLoginFlow = jest.fn();
const mockPullStart = jest.fn();
const mockPullList = jest.fn();
const mockPullGet = jest.fn();
const mockPullCancel = jest.fn();

jest.mock('../middleware/auth', () => ({
  authenticateToken: function authenticateToken(
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) {
    next();
  },
}));

jest.mock('../middleware/requireAdmin', () => ({
  requireAdmin: function requireAdmin(
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) {
    next();
  },
  requireOwner: function requireOwner(
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) {
    next();
  },
}));

jest.mock('../services/nativeOllamaBinding', () => ({
  NATIVE_OLLAMA_SERVE_PORT: 11435,
  NativeOllamaBindingError: class NativeOllamaBindingError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly httpStatus = 409,
    ) {
      super(message);
    }
  },
  readNativeOllamaBinding: mockReadNativeOllamaBinding,
  removeNativeOllamaBinding: mockRemoveNativeOllamaBinding,
  acknowledgeNativeOllamaLegacyHelperRetirement:
    mockAcknowledgeNativeOllamaLegacyHelperRetirement,
}));

jest.mock('../services/legacyOllamaBindingRead', () => ({
  readLegacyOllamaBindingPresence: mockReadLegacyOllamaBindingPresence,
}));

jest.mock('../services/nativeOllamaBackend', () => ({
  NativeOllamaBackendError: class NativeOllamaBackendError extends Error {
    readonly httpStatus: number;

    constructor(
      readonly code: string,
      readonly statusCode = 503,
    ) {
      super(code === 'AUTHORITY_CHANGED'
        ? 'The native Remote GPU authority changed; refresh and retry.'
        : code);
      this.httpStatus = statusCode;
    }
  },
  exactNativeOllamaGrantForPeer: (
    portalAddress: string | null,
    gpuAddress: string,
  ) => {
    if (!portalAddress) return null;
    const template = JSON.stringify({
      grants: [{
        src: [portalAddress],
        dst: [gpuAddress],
        ip: ['tcp:11435'],
      }],
    }, null, 2);
    return {
      template,
      templateHash: `sha256:${'f'.repeat(64)}`,
    };
  },
  renderNativeOllamaGrantTemplate: (portalAddress: string | null) => (
    JSON.stringify({
      grants: [{
        src: [portalAddress ?? '__BRIDGESLLM_PORTAL_TAILSCALE_IP__'],
        dst: ['__BRIDGESLLM_GPU_TAILSCALE_IP__'],
        ip: ['tcp:11435'],
      }],
    }, null, 2)
  ),
  connectNativeOllamaBackend: mockConnectNativeOllamaBackend,
  diagnoseNativeOllamaBackend: mockDiagnoseNativeOllamaBackend,
  listNativeOllamaInstalledModels: mockListNativeOllamaInstalledModels,
  reverifyNativeOllamaBackend: mockReverifyNativeOllamaBackend,
  selectNativeOllamaBackendModel: mockSelectNativeOllamaBackendModel,
  testNativeOllamaBackendModel: mockTestNativeOllamaBackendModel,
}));

jest.mock('../services/tailscalePeerAttestor', () => ({
  TailscalePeerAttestationError:
    class TailscalePeerAttestationError extends Error {
      readonly code: string;

      constructor(code = 'TAILSCALE_UNAVAILABLE') {
        super('The Portal server could not read its current Tailscale network map.');
        this.code = code;
      }
    },
  listCurrentAttestedTailscalePeers:
    mockListCurrentAttestedTailscalePeers,
}));

jest.mock('../services/ollamaAuthorityBarrier', () => ({
  OllamaAuthorityBarrierBusyError:
    class OllamaAuthorityBarrierBusyError extends Error {
      readonly code = 'OLLAMA_AUTHORITY_BUSY';
      readonly httpStatus = 409;

      constructor() {
        super('The Ollama backend authority is changing or in use. Retry shortly.');
      }
    },
  withOllamaAuthorityMutationFence:
    mockWithOllamaAuthorityMutationFence,
}));

jest.mock('../services/tailnetServerNetwork', () => ({
  TailnetServerNetworkError: class TailnetServerNetworkError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly statusCode = 502,
    ) {
      super(message);
    }
  },
  connectServerWithAuthKey: mockConnectServerWithAuthKey,
  installTailscaleOnServer: mockInstallTailscaleOnServer,
  readTailnetServerNetworkStatus: mockReadTailnetServerNetworkStatus,
  startServerLoginFlow: mockStartServerLoginFlow,
}));

jest.mock('../services/ollamaBackendAuthority', () => ({
  OllamaBackendAuthorityError: class OllamaBackendAuthorityError extends Error {
    constructor(
      readonly code: string,
      readonly statusCode = 503,
    ) {
      super(code);
    }
  },
  resolveOllamaBackendAuthority: jest.fn(),
  requestResolvedOllama: jest.fn(),
  requestResolvedOllamaJson: jest.fn(),
}));

jest.mock('../services/ollamaPullManager', () => ({
  OllamaPullBusyError: class OllamaPullBusyError extends Error {},
  ollamaPullManager: {
    startBound: mockPullStart,
    list: mockPullList,
    get: mockPullGet,
    cancel: mockPullCancel,
  },
}));

import ollamaRouter from '../routes/ollama';
import { OllamaAuthorityBarrierBusyError } from '../services/ollamaAuthorityBarrier';

const timestamp = new Date('2026-07-26T12:00:00.000Z');
const timestampIso = timestamp.toISOString();
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const pullOperationId = '123e4567-e89b-42d3-a456-426614174000';

function routeLayer(
  routePath: string,
  method: 'get' | 'post' | 'put' | 'delete',
): any {
  const layer = (ollamaRouter as any).stack.find((entry: any) => (
    entry.route?.path === routePath && entry.route?.methods?.[method]
  ));
  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }
  return layer.route;
}

function maybeRouteLayer(
  routePath: string,
  method: 'get' | 'post' | 'put' | 'delete',
): any | null {
  return (ollamaRouter as any).stack.find((entry: any) => (
    entry.route?.path === routePath && entry.route?.methods?.[method]
  ))?.route ?? null;
}

function routeHandler(
  routePath: string,
  method: 'get' | 'post' | 'put' | 'delete',
) {
  const route = routeLayer(routePath, method);
  return route.stack[route.stack.length - 1].handle as (
    req: any,
    res: any,
  ) => Promise<void> | void;
}

function responseCapture() {
  const capture = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
  };
  const res = {
    headersSent: false,
    writableEnded: false,
    status(code: number) {
      capture.statusCode = code;
      return res;
    },
    json(body: any) {
      capture.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      capture.headers[name.toLowerCase()] = value;
      return res;
    },
  };
  return { capture, res };
}

function nativeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'native-binding-1',
    purposeId: 'PRIMARY',
    generation: 4,
    version: 2,
    state: 'ACTIVE',
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable-node-windows',
    nodePublicKey: `nodekey:${'1'.repeat(64)}`,
    observedAddress: '100.72.18.9',
    addressFamily: 'IPV4',
    servePort: 11435,
    bindingFingerprint: 'native-binding-fingerprint',
    selectedModel: 'qwen3.5:4b',
    selectedModelDigest: digestA,
    grantPeerAttestationFingerprint: 'd'.repeat(64),
    grantTemplateHash: `sha256:${'f'.repeat(64)}`,
    grantAcknowledgedAt: timestamp,
    grantAcknowledgedBy: 'owner-1',
    legacyHelperRetirementAcknowledgedAt: null,
    legacyHelperRetirementAcknowledgedBy: null,
    legacyHelperRetirementEvidence: null,
    configuredByUserId: 'owner-1',
    observedAt: timestamp,
    verifiedAt: timestamp,
    activatedAt: timestamp,
    disconnectedAt: null,
    removedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function peer(overrides: Record<string, unknown> = {}) {
  return {
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable-node-windows',
    nodePublicKey: `nodekey:${'1'.repeat(64)}`,
    address: '100.72.18.9',
    observedAddress: '100.72.18.9',
    addressFamily: 'IPV4',
    observedAt: timestampIso,
    displayName: 'GPU workstation',
    operatingSystem: 'windows',
    fingerprint: 'd'.repeat(64),
    ...overrides,
  };
}

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    tailnetName: 'example.ts.net',
    observedAt: timestampIso,
    peers: [peer()],
    ...overrides,
  };
}

function connection(binding = nativeBinding()) {
  return {
    binding,
    probe: {
      peer: peer(),
      ollamaVersion: '0.11.5',
      models: [{
        name: 'qwen3.5:4b',
        digest: digestA,
        sizeBytes: 3_400_000_000,
        modifiedAt: timestampIso,
      }],
      verifiedAt: timestampIso,
    },
  };
}

function serverNetwork(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    version: '1.98.9',
    daemonActive: true,
    backendState: 'Running',
    running: true,
    tailnetName: 'example.ts.net',
    hostName: 'bridgesllm-portal',
    tailnetIp: '100.64.10.20',
    loginUrl: null,
    ...overrides,
  };
}

function pullSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pull-job-1',
    operationId: pullOperationId,
    model: 'qwen3.5:4b',
    room: 'ollama-pull-pull-job-1',
    state: 'running',
    phase: 'downloading',
    status: 'pulling layer',
    digest: digestA,
    totalBytes: 1_000,
    completedBytes: 250,
    percent: 25,
    speedBytesPerSecond: 100,
    etaSeconds: 8,
    eventSeq: 4,
    startedAt: timestampIso,
    updatedAt: timestampIso,
    error: null,
    canCancel: true,
    outputTruncated: false,
    ...overrides,
  };
}

describe('native Ollama Tailnet routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithOllamaAuthorityMutationFence.mockImplementation(
      async (operation: () => Promise<unknown>) => operation(),
    );
    mockReadNativeOllamaBinding.mockResolvedValue({
      purposeId: 'PRIMARY',
      authority: nativeBinding(),
    });
    mockReadLegacyOllamaBindingPresence.mockResolvedValue({
      hasAuthority: false,
      hasCandidate: false,
    });
    mockListCurrentAttestedTailscalePeers.mockResolvedValue(inventory());
    mockReadTailnetServerNetworkStatus.mockResolvedValue(serverNetwork());
    mockPullList.mockReturnValue([]);
  });

  test.each([
    ['/models', 'get'],
    ['/catalog', 'get'],
    ['/status', 'get'],
    ['/tailnet/server-network', 'get'],
    ['/tailnet/server-network/install', 'post'],
    ['/tailnet/server-network/connect', 'post'],
    ['/tailnet/status', 'get'],
    ['/tailnet/legacy-helper-retirement', 'post'],
    ['/tailnet/setup-bundle.zip', 'get'],
    ['/tailnet/connect', 'post'],
    ['/tailnet/reverify', 'post'],
    ['/tailnet/verify', 'post'],
    ['/tailnet/authority', 'delete'],
    ['/active-model', 'put'],
    ['/model/test', 'post'],
  ] as const)('%s %s is owner-only', (routePath, method) => {
    const handlers = routeLayer(routePath, method)
      .stack
      .map((entry: any) => entry.handle.name);
    expect(handlers).toContain('requireOwner');
  });

  test('removes every helper, secret-import, candidate, and cleanup route', () => {
    for (const [routePath, method] of [
      ['/tailnet/helper-bundle.zip', 'get'],
      ['/tailnet/helper/:file', 'get'],
      ['/tailnet/pairing', 'get'],
      ['/tailnet/pairing/import', 'post'],
      ['/tailnet/pairing/probe', 'post'],
      ['/tailnet/pairing/activate', 'post'],
      ['/tailnet/pairing/candidate', 'delete'],
      ['/tailnet/pairing/authority', 'delete'],
      ['/tailnet/pairing/cleanup/acknowledge', 'post'],
    ] as const) {
      expect(maybeRouteLayer(routePath, method)).toBeNull();
    }
  });

  test('returns only native binding state, server-attested inventory, and narrow setup instructions', async () => {
    mockReadLegacyOllamaBindingPresence.mockResolvedValue({
      hasAuthority: false,
      hasCandidate: true,
    });
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/status', 'get')({}, res);

    expect(capture.statusCode).toBe(200);
    expect(capture.headers['cache-control']).toBe('private, no-store');
    expect(capture.body.binding).toEqual({
      purposeId: 'PRIMARY',
      authority: expect.objectContaining({
        generation: 4,
        version: 2,
        address: '100.72.18.9',
        servePort: 11435,
        displayName: 'GPU workstation',
        grantSnapshotState: 'CURRENT',
      }),
    });
    expect(capture.body.binding.authority).not.toHaveProperty(
      'observedAddress',
    );
    expect(capture.body.tailscale).toEqual({
      available: true,
      inventory: {
        tailnetName: 'example.ts.net',
        observedAt: timestampIso,
        peers: [expect.objectContaining({
          stableNodeId: 'stable-node-windows',
          address: '100.72.18.9',
          displayName: 'GPU workstation',
          grantTemplateHash: `sha256:${'f'.repeat(64)}`,
          online: true,
        })],
      },
      error: null,
    });
    expect(JSON.parse(
      capture.body.tailscale.inventory.peers[0].grantTemplate,
    )).toEqual({
      grants: [{
        src: ['100.64.10.20'],
        dst: ['100.72.18.9'],
        ip: ['tcp:11435'],
      }],
    });
    expect(capture.body.setup).toEqual(expect.objectContaining({
      servePort: 11435,
      windowsBundle: '/api/ollama/tailnet/setup-bundle.zip',
      serveCommand:
        'tailscale serve --bg --tcp=11435 tcp://127.0.0.1:11434',
      removeCommand: 'tailscale serve --tcp=11435 off',
      legacyHelperRetireCommand:
        'Start-Here.cmd --retire-legacy-helper',
    }));
    expect(JSON.parse(capture.body.setup.grantTemplate)).toEqual({
      grants: [{
        src: ['100.64.10.20'],
        dst: ['__BRIDGESLLM_GPU_TAILSCALE_IP__'],
        ip: ['tcp:11435'],
      }],
    });
    expect(capture.body.setup.grantWarning).toMatch(/does not verify/i);
    expect(capture.body.setup.grantWarning).toMatch(/additive/i);
    expect(capture.body.legacyRemoteAuthorityPresent).toBe(true);
    expect(capture.body.legacyHelperRetirement).toEqual({
      required: true,
      acknowledgedAt: null,
      evidence: null,
    });
    expect(capture.body).not.toHaveProperty('cleanup');
    expect(capture.body).not.toHaveProperty('helper');
    expect(JSON.stringify(capture.body)).not.toMatch(
      /pairingSecret|helperId|configuredByUserId|grantAcknowledgedBy|http:\/\//i,
    );
  });

  test('adds a display name only for one exact current peer identity match', async () => {
    mockListCurrentAttestedTailscalePeers.mockResolvedValue(inventory({
      peers: [peer({
        nodePublicKey: `nodekey:${'2'.repeat(64)}`,
        displayName: 'Different identity',
      })],
    }));
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/status', 'get')({}, res);

    expect(capture.body.binding.authority.displayName).toBeNull();
    expect(capture.body.binding.authority.address).toBe('100.72.18.9');
    expect(capture.body.binding.authority.grantSnapshotState).toBe('CHANGED');
  });

  test('bounds an unavailable inventory without leaking command output', async () => {
    mockListCurrentAttestedTailscalePeers.mockRejectedValue(
      new Error('private tailscale stderr'),
    );
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/status', 'get')({}, res);

    expect(capture.body.tailscale).toEqual({
      available: false,
      inventory: null,
      error: {
        code: 'TAILSCALE_UNAVAILABLE',
        message: 'The current Tailnet inventory is unavailable.',
      },
    });
    expect(capture.body.binding.authority.grantSnapshotState).toBe(
      'UNAVAILABLE',
    );
    expect(JSON.stringify(capture.body)).not.toContain(
      'private tailscale stderr',
    );
  });

  test('surfaces a changed Grant snapshot instead of presenting the stored ACTIVE row as healthy', async () => {
    mockListCurrentAttestedTailscalePeers.mockResolvedValue(inventory({
      peers: [peer({ fingerprint: 'e'.repeat(64) })],
    }));
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/status', 'get')({}, res);

    expect(capture.body.binding.authority).toEqual(
      expect.objectContaining({
        state: 'ACTIVE',
        grantSnapshotState: 'CHANGED',
      }),
    );
  });

  test('converges legacy helper retirement status while retaining rollback-safe rows', async () => {
    const evidence =
      `legacy-helper-retirement:v1:sha256:${'9'.repeat(64)}`;
    mockReadNativeOllamaBinding.mockResolvedValue({
      purposeId: 'PRIMARY',
      authority: nativeBinding({
        version: 3,
        legacyHelperRetirementAcknowledgedAt: timestamp,
        legacyHelperRetirementAcknowledgedBy: 'owner-1',
        legacyHelperRetirementEvidence: evidence,
      }),
    });
    mockReadLegacyOllamaBindingPresence.mockResolvedValue({
      hasAuthority: true,
      hasCandidate: true,
    });
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/status', 'get')({}, res);

    expect(capture.body.legacyRemoteAuthorityPresent).toBe(true);
    expect(capture.body.legacyHelperRetirement).toEqual({
      required: false,
      acknowledgedAt: timestampIso,
      evidence,
    });
    expect(capture.body.binding.authority).toEqual(
      expect.objectContaining({
        legacyHelperRetirementAcknowledgedAt: timestampIso,
        legacyHelperRetirementEvidence: evidence,
      }),
    );
    expect(capture.body.binding.authority).not.toHaveProperty(
      'legacyHelperRetirementAcknowledgedBy',
    );
  });

  test('records exact legacy helper retirement through an Owner-only fenced CAS', async () => {
    const evidence =
      `legacy-helper-retirement:v1:sha256:${'8'.repeat(64)}`;
    const acknowledged = nativeBinding({
      version: 3,
      legacyHelperRetirementAcknowledgedAt: timestamp,
      legacyHelperRetirementAcknowledgedBy: 'owner-1',
      legacyHelperRetirementEvidence: evidence,
    });
    mockReadLegacyOllamaBindingPresence.mockResolvedValue({
      hasAuthority: true,
      hasCandidate: false,
    });
    mockAcknowledgeNativeOllamaLegacyHelperRetirement.mockResolvedValue(
      acknowledged,
    );
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/legacy-helper-retirement', 'post')({
      body: {
        generation: 4,
        expectedVersion: 2,
        cleanupConfirmed: true,
      },
      user: {
        userId: 'owner-1',
        role: 'OWNER',
      },
    }, res);

    expect(mockWithOllamaAuthorityMutationFence).toHaveBeenCalledTimes(1);
    expect(
      mockAcknowledgeNativeOllamaLegacyHelperRetirement,
    ).toHaveBeenCalledWith({
      generation: 4,
      expectedVersion: 2,
      acknowledgedBy: 'owner-1',
    });
    expect(capture.statusCode).toBe(200);
    expect(capture.body.binding).toEqual(expect.objectContaining({
      version: 3,
      legacyHelperRetirementAcknowledgedAt: timestampIso,
      legacyHelperRetirementEvidence: evidence,
    }));
    expect(capture.body.binding).not.toHaveProperty(
      'legacyHelperRetirementAcknowledgedBy',
    );
  });

  test('rejects legacy retirement without exact confirmation or rollback-safe rows', async () => {
    const missingConfirmation = responseCapture();
    await routeHandler('/tailnet/legacy-helper-retirement', 'post')({
      body: {
        generation: 4,
        expectedVersion: 2,
        cleanupConfirmed: false,
      },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, missingConfirmation.res);
    expect(missingConfirmation.capture.statusCode).toBe(400);

    mockReadLegacyOllamaBindingPresence.mockResolvedValue({
      hasAuthority: false,
      hasCandidate: false,
    });
    const noLegacyRows = responseCapture();
    await routeHandler('/tailnet/legacy-helper-retirement', 'post')({
      body: {
        generation: 4,
        expectedVersion: 2,
        cleanupConfirmed: true,
      },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, noLegacyRows.res);
    expect(noLegacyRows.capture.statusCode).toBe(409);
    expect(
      mockAcknowledgeNativeOllamaLegacyHelperRetirement,
    ).not.toHaveBeenCalled();
  });

  test('does not issue an acknowledgeable Grant snapshot without the Portal Tailnet IP', async () => {
    mockReadTailnetServerNetworkStatus.mockResolvedValue(serverNetwork({
      running: false,
      tailnetIp: null,
    }));
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/status', 'get')({}, res);

    const [currentPeer] = capture.body.tailscale.inventory.peers;
    expect(currentPeer.grantTemplate).toBeNull();
    expect(currentPeer.grantTemplateHash).toBeNull();
    expect(capture.body.setup.grantTemplate).toContain(
      '__BRIDGESLLM_PORTAL_TAILSCALE_IP__',
    );
  });

  test('connects one stable node with exact nullable CAS and an honest Grant acknowledgement', async () => {
    mockConnectNativeOllamaBackend.mockResolvedValue(connection());
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/connect', 'post')({
      body: {
        stableNodeId: 'stable-node-windows',
        expectedGeneration: null,
        expectedVersion: null,
        expectedPeerAttestationFingerprint: 'd'.repeat(64),
        expectedGrantTemplateHash: `sha256:${'f'.repeat(64)}`,
        grantAcknowledged: true,
      },
      user: {
        userId: 'owner-1',
        role: 'OWNER',
      },
    }, res);

    expect(mockConnectNativeOllamaBackend).toHaveBeenCalledWith({
      stableNodeId: 'stable-node-windows',
      expectedAuthorityGeneration: null,
      expectedAuthorityVersion: null,
      expectedPeerAttestationFingerprint: 'd'.repeat(64),
      expectedGrantTemplateHash: `sha256:${'f'.repeat(64)}`,
      grantAcknowledged: true,
      configuredByUserId: 'owner-1',
    });
    expect(capture.statusCode).toBe(201);
    expect(capture.body.binding).toEqual(expect.objectContaining({
      address: '100.72.18.9',
      displayName: 'GPU workstation',
      grantAcknowledgedAt: timestampIso,
    }));
    expect(capture.body.evidence).toEqual(expect.objectContaining({
      ollamaVersion: '0.11.5',
      inventoryVerified: true,
      verifiedAt: timestampIso,
    }));
    expect(JSON.stringify(capture.body)).not.toMatch(
      /configuredByUserId|grantAcknowledgedBy|observedAddress/i,
    );
  });

  test('rejects absent acknowledgement and incomplete connect CAS before probing', async () => {
    const missingGrant = responseCapture();
    await routeHandler('/tailnet/connect', 'post')({
      body: {
        stableNodeId: 'stable-node-windows',
        expectedGeneration: null,
        expectedVersion: null,
        grantAcknowledged: false,
      },
      user: { userId: 'owner-1' },
    }, missingGrant.res);
    expect(missingGrant.capture.statusCode).toBe(400);

    const incompleteCas = responseCapture();
    await routeHandler('/tailnet/connect', 'post')({
      body: {
        stableNodeId: 'stable-node-windows',
        expectedGeneration: 4,
        expectedVersion: null,
        grantAcknowledged: true,
      },
      user: { userId: 'owner-1' },
    }, incompleteCas.res);
    expect(incompleteCas.capture.statusCode).toBe(400);

    const malformedSnapshot = responseCapture();
    await routeHandler('/tailnet/connect', 'post')({
      body: {
        stableNodeId: 'stable-node-windows',
        expectedGeneration: null,
        expectedVersion: null,
        expectedPeerAttestationFingerprint: 'not-a-fingerprint',
        expectedGrantTemplateHash: 'sha256:not-a-hash',
        grantAcknowledged: true,
      },
      user: { userId: 'owner-1' },
    }, malformedSnapshot.res);
    expect(malformedSnapshot.capture.statusCode).toBe(400);
    expect(mockConnectNativeOllamaBackend).not.toHaveBeenCalled();
  });

  test('reverifies a disconnected authority and diagnoses an active authority with exact CAS', async () => {
    mockReverifyNativeOllamaBackend.mockResolvedValue(
      connection(nativeBinding({ state: 'ACTIVE', version: 3 })),
    );
    mockDiagnoseNativeOllamaBackend.mockResolvedValue({
      binding: nativeBinding(),
      peer: peer(),
      runningModels: [{
        name: 'qwen3.5:4b',
        digest: digestA,
        sizeBytes: 1,
        sizeVramBytes: 1,
        expiresAt: null,
      }],
    });

    const reverify = responseCapture();
    await routeHandler('/tailnet/reverify', 'post')({
      body: { generation: 4, expectedVersion: 2 },
    }, reverify.res);
    expect(mockReverifyNativeOllamaBackend).toHaveBeenCalledWith({
      generation: 4,
      expectedVersion: 2,
    });
    expect(reverify.capture.body.binding.version).toBe(3);
    expect(reverify.capture.body.evidence.inventoryVerified).toBe(true);

    const verify = responseCapture();
    await routeHandler('/tailnet/verify', 'post')({
      body: { generation: 4, expectedVersion: 2 },
    }, verify.res);
    expect(mockDiagnoseNativeOllamaBackend).toHaveBeenCalledWith({
      generation: 4,
      expectedVersion: 2,
    });
    expect(verify.capture.body.evidence).toEqual(expect.objectContaining({
      selectedModel: 'qwen3.5:4b',
      selectedModelDigest: digestA,
      verifiedAt: timestampIso,
    }));
    expect(verify.capture.body.evidence).not.toHaveProperty(
      'inferenceVerified',
    );
  });

  test('removes only the exact native authority behind the mutation fence', async () => {
    mockRemoveNativeOllamaBinding.mockResolvedValue(nativeBinding({
      state: 'REMOVED',
      version: 3,
      removedAt: timestamp,
    }));
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/authority', 'delete')({
      body: { generation: 4, expectedVersion: 2 },
    }, res);

    expect(mockWithOllamaAuthorityMutationFence).toHaveBeenCalledTimes(1);
    expect(mockRemoveNativeOllamaBinding).toHaveBeenCalledWith({
      generation: 4,
      expectedVersion: 2,
    });
    expect(capture.body.binding).toEqual(expect.objectContaining({
      state: 'REMOVED',
      version: 3,
    }));
    expect(capture.body).not.toHaveProperty('helperRemovalCommand');
  });

  test('returns a bounded conflict when authority removal cannot acquire the fence', async () => {
    mockWithOllamaAuthorityMutationFence.mockRejectedValue(
      new OllamaAuthorityBarrierBusyError(),
    );
    const { capture, res } = responseCapture();

    await routeHandler('/tailnet/authority', 'delete')({
      body: { generation: 4, expectedVersion: 2 },
    }, res);

    expect(capture).toMatchObject({
      statusCode: 409,
      body: {
        code: 'OLLAMA_AUTHORITY_BUSY',
        error:
          'The Ollama backend authority is changing or in use. Retry shortly.',
      },
    });
    expect(JSON.stringify(capture.body)).not.toMatch(
      /activeRuns|mutationFenced|count/i,
    );
  });

  test('selects an installed model only with its canonical digest and exact CAS', async () => {
    mockSelectNativeOllamaBackendModel.mockResolvedValue({
      binding: nativeBinding({
        version: 3,
        selectedModel: 'qwen3.5:9b',
        selectedModelDigest: digestB,
      }),
      model: {
        name: 'qwen3.5:9b',
        digest: digestB,
        sizeBytes: 1,
        modifiedAt: timestampIso,
      },
      inspection: {},
    });
    const { capture, res } = responseCapture();

    await routeHandler('/active-model', 'put')({
      body: {
        generation: 4,
        expectedVersion: 2,
        model: 'qwen3.5:9b',
        expectedDigest: digestB,
      },
    }, res);

    expect(mockSelectNativeOllamaBackendModel).toHaveBeenCalledWith({
      generation: 4,
      expectedVersion: 2,
      model: 'qwen3.5:9b',
      expectedDigest: digestB,
    });
    expect(capture.body.binding).toEqual(expect.objectContaining({
      selectedModel: 'qwen3.5:9b',
      selectedModelDigest: digestB,
    }));

    const invalid = responseCapture();
    await routeHandler('/active-model', 'put')({
      body: {
        generation: 4,
        expectedVersion: 2,
        model: 'qwen3.5:9b',
        expectedDigest: digestB.toUpperCase(),
      },
    }, invalid.res);
    expect(invalid.capture.statusCode).toBe(400);
    expect(mockSelectNativeOllamaBackendModel).toHaveBeenCalledTimes(1);
  });

  test('runs a bounded selected-model test only against the exact authority snapshot', async () => {
    mockTestNativeOllamaBackendModel.mockResolvedValue({
      model: 'qwen3.5:4b',
      digest: digestA,
      response: 'O',
      evalCount: 1,
      totalDurationNs: 42,
    });
    const { capture, res } = responseCapture();

    await routeHandler('/model/test', 'post')({
      body: { generation: 4, expectedVersion: 2 },
    }, res);

    expect(mockTestNativeOllamaBackendModel).toHaveBeenCalledWith({
      generation: 4,
      expectedVersion: 2,
    });
    expect(capture.body.binding).toEqual(expect.objectContaining({
      generation: 4,
      version: 2,
    }));
    expect(capture.body.evidence).toEqual(expect.objectContaining({
      selectedModel: 'qwen3.5:4b',
      selectedModelDigest: digestA,
      inferenceVerified: true,
    }));
    expect(JSON.stringify(capture.body)).not.toContain('"response":"O"');
  });

  test('preserves server-network GET/install/connect and scrubs send-once auth keys', async () => {
    mockInstallTailscaleOnServer.mockResolvedValue(serverNetwork());
    mockConnectServerWithAuthKey.mockResolvedValue(serverNetwork());

    const read = responseCapture();
    await routeHandler('/tailnet/server-network', 'get')({}, read.res);
    expect(read.capture.body).toEqual(serverNetwork());

    const install = responseCapture();
    await routeHandler('/tailnet/server-network/install', 'post')(
      {},
      install.res,
    );
    expect(mockInstallTailscaleOnServer).toHaveBeenCalledTimes(1);

    const body = {
      authKey: 'tskey-auth-private-material',
      hostname: 'bridgesllm-portal',
    };
    const connect = responseCapture();
    await routeHandler('/tailnet/server-network/connect', 'post')(
      { body },
      connect.res,
    );
    expect(mockConnectServerWithAuthKey).toHaveBeenCalledWith({
      authKey: 'tskey-auth-private-material',
      hostname: 'bridgesllm-portal',
    });
    expect(body.authKey).toBe('');
    expect(JSON.stringify(connect.capture.body)).not.toContain('tskey-auth');
  });

  test('streams immutable pull snapshots and returns cancellable manager state', async () => {
    const progress = pullSnapshot();
    const finished = pullSnapshot({
      state: 'succeeded',
      phase: 'complete',
      status: 'success',
      completedBytes: 1_000,
      percent: 100,
      speedBytesPerSecond: 0,
      etaSeconds: 0,
      canCancel: false,
      finishedAt: timestampIso,
    });
    mockPullStart.mockImplementation(
      (
        _model: string,
        _expectedAuthority: Record<string, unknown>,
        _operationId: string,
        callbacks: Record<string, (job: unknown) => void>,
      ) => {
        callbacks.onProgress(progress);
        callbacks.onDone(finished);
        return progress;
      },
    );
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const of = jest.fn(() => ({ to }));
    const { capture, res } = responseCapture();

    await routeHandler('/pull', 'post')({
      body: {
        operationId: pullOperationId,
        model: 'qwen3.5:4b',
        expectedAuthority: {
          kind: 'TAILNET',
          generation: 7,
          version: 11,
          fingerprint: 'native-ollama-v1:peer-7',
        },
      },
      app: { get: () => ({ of }) },
    }, res);

    expect(capture.statusCode).toBe(202);
    expect(mockPullStart).toHaveBeenCalledWith(
      'qwen3.5:4b',
      {
        kind: 'TAILNET',
        generation: 7,
        version: 11,
        fingerprint: 'native-ollama-v1:peer-7',
      },
      pullOperationId,
      expect.objectContaining({
        onProgress: expect.any(Function),
        onDone: expect.any(Function),
      }),
    );
    expect(capture.body).toEqual(expect.objectContaining({
      accepted: true,
      id: 'pull-job-1',
      operationId: pullOperationId,
      percent: 25,
      canCancel: true,
    }));
    expect(of).toHaveBeenCalledWith('/ws/agent-jobs');
    expect(to).toHaveBeenCalledWith('ollama-pull-pull-job-1');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][1]).toEqual(expect.objectContaining({
      pull: progress,
      done: false,
      state: 'running',
    }));
    expect(emit.mock.calls[1][1]).toEqual(expect.objectContaining({
      pull: finished,
      done: true,
      state: 'succeeded',
    }));
    expect(JSON.stringify(emit.mock.calls)).not.toContain('exitCode');
  });

  test('rejects a missing or malformed pull operation ID before manager admission', async () => {
    for (const operationId of [undefined, 'not-a-uuid']) {
      const response = responseCapture();
      await routeHandler('/pull', 'post')({
        body: {
          operationId,
          model: 'qwen3.5:4b',
          expectedAuthority: {
            kind: 'TAILNET',
            generation: 7,
            version: 11,
            fingerprint: 'native-ollama-v1:peer-7',
          },
        },
        app: { get: () => undefined },
      }, response.res);
      expect(response.capture).toMatchObject({
        statusCode: 400,
        body: { code: 'REQUEST_INVALID' },
      });
    }
    expect(mockPullStart).not.toHaveBeenCalled();
  });

  test('reserves every Settings pull surface for the Owner role', () => {
    for (const [routePath, method] of [
      ['/pull', 'post'],
      ['/pulls', 'get'],
      ['/pull/:jobId', 'get'],
      ['/pull/:jobId', 'delete'],
    ] as const) {
      const middlewareNames = routeLayer(routePath, method).stack
        .slice(0, -1)
        .map((entry: any) => entry.handle.name);
      expect(middlewareNames).toContain('requireOwner');
      expect(middlewareNames).not.toContain('requireAdmin');
    }
  });

  test('lists, reads, and requests cancellation using current pull snapshots', async () => {
    const running = pullSnapshot();
    const cancelling = pullSnapshot({
      state: 'cancelling',
      status: 'Cancelling download…',
      canCancel: false,
    });
    mockPullList.mockReturnValue([running]);
    mockPullGet.mockReturnValue(running);
    mockPullCancel.mockReturnValue(cancelling);

    const listed = responseCapture();
    routeHandler('/pulls', 'get')({}, listed.res);
    expect(listed.capture.body).toEqual({ pulls: [running] });

    const read = responseCapture();
    routeHandler('/pull/:jobId', 'get')({
      params: { jobId: 'pull-job-1' },
    }, read.res);
    expect(mockPullGet).toHaveBeenCalledWith('pull-job-1');
    expect(read.capture.body).toEqual(running);

    const cancelled = responseCapture();
    routeHandler('/pull/:jobId', 'delete')({
      params: { jobId: 'pull-job-1' },
    }, cancelled.res);
    expect(mockPullCancel).toHaveBeenCalledWith('pull-job-1');
    expect(cancelled.capture.body).toEqual(cancelling);
  });
});
