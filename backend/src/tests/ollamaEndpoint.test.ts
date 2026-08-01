const mockResolveOllamaBackendAuthority = jest.fn();
const mockRequestResolvedOllama = jest.fn();
const mockRequestResolvedOllamaJson = jest.fn();
const mockListNativeOllamaInstalledModels = jest.fn();

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

jest.mock('../services/ollamaBackendAuthority', () => ({
  OllamaBackendAuthorityError: class OllamaBackendAuthorityError extends Error {
    constructor(
      readonly code: string,
      readonly statusCode = 503,
    ) {
      super(code);
    }
  },
  resolveOllamaBackendAuthority: mockResolveOllamaBackendAuthority,
  requestResolvedOllama: mockRequestResolvedOllama,
  requestResolvedOllamaJson: mockRequestResolvedOllamaJson,
}));

jest.mock('../services/nativeOllamaBackend', () => ({
  NativeOllamaBackendError: class NativeOllamaBackendError extends Error {
    readonly httpStatus: number;

    constructor(
      readonly code: string,
      readonly statusCode = 503,
    ) {
      super(code);
      this.httpStatus = statusCode;
    }
  },
  connectNativeOllamaBackend: jest.fn(),
  diagnoseNativeOllamaBackend: jest.fn(),
  listNativeOllamaInstalledModels: mockListNativeOllamaInstalledModels,
  reverifyNativeOllamaBackend: jest.fn(),
  selectNativeOllamaBackendModel: jest.fn(),
  testNativeOllamaBackendModel: jest.fn(),
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
  readNativeOllamaBinding: jest.fn(),
  removeNativeOllamaBinding: jest.fn(),
}));

jest.mock('../services/legacyOllamaBindingRead', () => ({
  readLegacyOllamaBindingPresence: jest.fn(),
}));

jest.mock('../services/tailscalePeerAttestor', () => ({
  TailscalePeerAttestationError:
    class TailscalePeerAttestationError extends Error {
      readonly code = 'TAILSCALE_UNAVAILABLE';
    },
  listCurrentAttestedTailscalePeers: jest.fn(),
}));

jest.mock('../services/ollamaAuthorityBarrier', () => ({
  OllamaAuthorityBarrierBusyError:
    class OllamaAuthorityBarrierBusyError extends Error {
      readonly code = 'OLLAMA_AUTHORITY_BUSY';
      readonly httpStatus = 409;
    },
  withOllamaAuthorityMutationFence: jest.fn(),
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
  connectServerWithAuthKey: jest.fn(),
  installTailscaleOnServer: jest.fn(),
  readTailnetServerNetworkStatus: jest.fn(),
  startServerLoginFlow: jest.fn(),
}));

jest.mock('../services/ollamaPullManager', () => ({
  OllamaPullBusyError: class OllamaPullBusyError extends Error {},
  ollamaPullManager: {
    start: jest.fn(),
    list: jest.fn(() => []),
    get: jest.fn(),
    cancel: jest.fn(),
  },
}));

import ollamaRouter, { normalizeOllamaEndpoint } from '../routes/ollama';
import {
  DEFAULT_LOCAL_OLLAMA_ENDPOINT,
  resolveLocalOllamaEndpoint,
} from '../utils/localOllamaEndpoint';
import { OLLAMA_RECOMMENDATION_CATALOG } from '../utils/ollamaRecommendations';

const timestamp = new Date('2026-07-26T12:00:00.000Z');
const digest = `sha256:${'a'.repeat(64)}`;

function routeHandler(
  routePath: string,
  method: 'get' | 'post',
): (req: any, res: any) => Promise<void> {
  const layer = (ollamaRouter as any).stack.find((entry: any) => (
    entry.route?.path === routePath && entry.route?.methods?.[method]
  ));
  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseCapture() {
  const capture = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
  };
  const res = {
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

function localResolved() {
  return {
    authority: {
      kind: 'LOCAL',
      source: 'local-policy',
      endpoint: DEFAULT_LOCAL_OLLAMA_ENDPOINT,
      generation: null,
      version: null,
      bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      selectedModel: null,
      selectedModelDigest: null,
    },
    bindingView: {
      purposeId: 'PRIMARY',
      authority: null,
      candidate: null,
    },
  };
}

function nativeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'native-binding-1',
    purposeId: 'PRIMARY',
    generation: 7,
    version: 3,
    state: 'ACTIVE',
    tailnetName: 'example.ts.net',
    stableNodeId: 'stable-node-windows',
    nodePublicKey: `nodekey:${'b'.repeat(64)}`,
    observedAddress: '100.64.0.7',
    addressFamily: 'IPV4',
    servePort: 11435,
    bindingFingerprint: 'native-binding-fingerprint',
    selectedModel: 'qwen3.5:4b',
    selectedModelDigest: digest,
    grantAcknowledgedAt: timestamp,
    grantAcknowledgedBy: 'owner-1',
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

function tailnetResolved() {
  return {
    authority: {
      kind: 'TAILNET',
      source: 'tailnet-binding',
      endpoint: null,
      generation: 7,
      version: 3,
      bindingFingerprint: 'native-binding-fingerprint',
      selectedModel: 'qwen3.5:4b',
      selectedModelDigest: digest,
    },
    bindingView: {
      purposeId: 'PRIMARY',
      authority: nativeBinding(),
      candidate: null,
    },
  };
}

function legacyTailnetResolved() {
  return {
    authority: {
      kind: 'TAILNET',
      source: 'tailnet-binding',
      endpoint: null,
      generation: 5,
      version: 11,
      bindingFingerprint: 'legacy-helper-binding-fingerprint',
      selectedModel: 'qwen3.5:4b',
      selectedModelDigest: digest,
    },
    bindingView: {
      purposeId: 'PRIMARY',
      authority: null,
      legacyAuthority: {
        id: 'legacy-helper-binding-1',
        state: 'ACTIVE',
      },
      candidate: null,
    },
  };
}

describe('Ollama endpoint containment and native inventory contract', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveOllamaBackendAuthority.mockResolvedValue(localResolved());
    mockRequestResolvedOllamaJson.mockResolvedValue({
      authority: localResolved().authority,
      value: { models: [] },
    });
    mockRequestResolvedOllama.mockResolvedValue({
      authority: localResolved().authority,
      statusCode: 200,
      headers: {},
      body: Buffer.from('{}'),
      streaming: false,
    });
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('canonicalizes only exact loopback http roots on fixed port 11434', () => {
    expect(normalizeOllamaEndpoint(' http://localhost:11434/ '))
      .toBe(DEFAULT_LOCAL_OLLAMA_ENDPOINT);
    expect(normalizeOllamaEndpoint('HTTP://127.0.0.1'))
      .toBe(DEFAULT_LOCAL_OLLAMA_ENDPOINT);
    expect(normalizeOllamaEndpoint('http://[::1]:11434'))
      .toBe('http://[::1]:11434');
  });

  test.each([
    'http://8.8.8.8:11434',
    'http://10.0.0.2:11434',
    'http://172.16.0.2:11434',
    'http://192.168.1.2:11434',
    'http://169.254.169.254:11434',
    'http://100.64.0.20:11434',
    'http://ollama.internal:11434',
    'http://localhost.example:11434',
    'http://[::ffff:127.0.0.1]:11434',
    'http://[fd7a:115c:a1e0::1]:11434',
    'https://127.0.0.1:11434',
    'http://127.0.0.1:11435',
    'http://user:pass@127.0.0.1:11434',
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:11434?next=http://169.254.169.254',
    'http://127.0.0.1:11434/#fragment',
    'http://127.1:11434',
  ])('rejects non-local or non-canonical endpoint %s', (endpoint) => {
    expect(() => normalizeOllamaEndpoint(endpoint))
      .toThrow(/loopback http endpoint on port 11434/i);
  });

  test('invalid legacy candidates fall back only to fixed loopback', () => {
    expect(resolveLocalOllamaEndpoint(
      'http://100.64.0.20:11434',
      'http://169.254.169.254:11434',
      'https://ollama.internal:11434',
    )).toBe(DEFAULT_LOCAL_OLLAMA_ENDPOINT);
  });

  test('remote connection testing is disabled and never contacts supplied URLs', async () => {
    const { capture, res } = responseCapture();
    await routeHandler('/test-connection', 'post')({
      body: { endpoint: 'http://169.254.169.254:11434' },
    }, res);

    expect(capture).toMatchObject({
      statusCode: 410,
      body: {
        reachable: false,
        code: 'REMOTE_OLLAMA_URLS_DISABLED',
      },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns the active local inventory without exposing its raw endpoint', async () => {
    mockRequestResolvedOllamaJson.mockResolvedValue({
      authority: localResolved().authority,
      value: {
        models: [{
          name: 'qwen3.5:4b',
          size: 1234,
          modified_at: '2026-07-26T12:00:00Z',
          digest,
          details: { family: 'qwen' },
        }],
      },
    });
    const { capture, res } = responseCapture();

    await routeHandler('/models', 'get')({}, res);

    expect(capture).toEqual(expect.objectContaining({
      statusCode: 200,
      body: {
        source: 'local',
        models: [{
          name: 'qwen3.5:4b',
          sizeBytes: 1234,
          modifiedAt: '2026-07-26T12:00:00Z',
          digest,
          details: { family: 'qwen' },
        }],
        authority: {
          kind: 'LOCAL',
          generation: null,
          version: null,
          fingerprint: 'local-ollama-v1:127.0.0.1:11434',
        },
      },
    }));
    expect(JSON.stringify(capture.body)).not.toContain('http://');
  });

  test('preserves the disconnected-authority conflict for model inventory', async () => {
    const { OllamaBackendAuthorityError } = jest.requireMock(
      '../services/ollamaBackendAuthority',
    );
    mockResolveOllamaBackendAuthority.mockRejectedValue(
      new OllamaBackendAuthorityError('REMOTE_DISCONNECTED', 409),
    );
    const { capture, res } = responseCapture();

    await routeHandler('/models', 'get')({}, res);

    expect(capture).toEqual(expect.objectContaining({
      statusCode: 409,
      body: {
        code: 'REMOTE_DISCONNECTED',
        error: 'REMOTE_DISCONNECTED',
      },
    }));
    expect(mockRequestResolvedOllamaJson).not.toHaveBeenCalled();
    expect(mockListNativeOllamaInstalledModels).not.toHaveBeenCalled();
  });

  test('uses the exact native authority CAS for Tailnet model inventory', async () => {
    mockResolveOllamaBackendAuthority.mockResolvedValue(tailnetResolved());
    mockListNativeOllamaInstalledModels.mockResolvedValue({
      binding: nativeBinding(),
      peer: {},
      models: [{
        name: 'qwen3.5:4b',
        digest,
        sizeBytes: 3_400_000_000,
        modifiedAt: '2026-07-26T12:00:00.000Z',
      }],
    });
    const { capture, res } = responseCapture();

    await routeHandler('/models', 'get')({}, res);

    expect(mockListNativeOllamaInstalledModels).toHaveBeenCalledWith({
      generation: 7,
      expectedVersion: 3,
    });
    expect(mockRequestResolvedOllamaJson).not.toHaveBeenCalled();
    expect(capture.body).toEqual({
      source: 'tailnet',
      models: [{
        name: 'qwen3.5:4b',
        digest,
        sizeBytes: 3_400_000_000,
        modifiedAt: '2026-07-26T12:00:00.000Z',
      }],
      authority: {
        kind: 'TAILNET',
        generation: 7,
        version: 3,
        fingerprint: 'native-binding-fingerprint',
      },
    });
  });

  test('keeps legacy helper inventory available until native activation', async () => {
    const resolved = legacyTailnetResolved();
    mockResolveOllamaBackendAuthority.mockResolvedValue(resolved);
    mockRequestResolvedOllamaJson.mockResolvedValue({
      authority: resolved.authority,
      value: {
        models: [{
          name: 'qwen3.5:4b',
          size: 3_400_000_000,
          modified_at: '2026-07-26T12:00:00.000Z',
          digest,
        }],
      },
    });
    const { capture, res } = responseCapture();

    await routeHandler('/models', 'get')({}, res);

    expect(mockListNativeOllamaInstalledModels).not.toHaveBeenCalled();
    expect(mockRequestResolvedOllamaJson).toHaveBeenCalledWith(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: 5_000,
      maxResponseBytes: 2 * 1024 * 1024,
    });
    expect(capture).toEqual(expect.objectContaining({
      statusCode: 200,
      body: {
        source: 'tailnet',
        models: [{
          name: 'qwen3.5:4b',
          sizeBytes: 3_400_000_000,
          modifiedAt: '2026-07-26T12:00:00.000Z',
          digest,
        }],
        authority: {
          kind: 'TAILNET',
          generation: 5,
          version: 11,
          fingerprint: 'legacy-helper-binding-fingerprint',
        },
      },
    }));
  });

  test('marks legacy helper models installed in the curated catalog', async () => {
    const resolved = legacyTailnetResolved();
    mockResolveOllamaBackendAuthority.mockResolvedValue(resolved);
    mockRequestResolvedOllamaJson.mockResolvedValue({
      authority: resolved.authority,
      value: {
        models: [{
          name: 'qwen3.5:4b',
          digest,
        }],
      },
    });
    const { capture, res } = responseCapture();

    await routeHandler('/catalog', 'get')({}, res);

    expect(mockListNativeOllamaInstalledModels).not.toHaveBeenCalled();
    expect(capture.body.models.find(
      (model: { name: string }) => model.name === 'qwen3.5:4b',
    )).toEqual(expect.objectContaining({
      installed: true,
      active: true,
    }));
  });

  test('returns the full curated catalog with installed and active flags', async () => {
    mockResolveOllamaBackendAuthority.mockResolvedValue(tailnetResolved());
    mockListNativeOllamaInstalledModels.mockResolvedValue({
      binding: nativeBinding(),
      peer: {},
      models: [{
        name: 'qwen3.5:4b',
        digest,
        sizeBytes: 3_400_000_000,
        modifiedAt: null,
      }],
    });
    const { capture, res } = responseCapture();

    await routeHandler('/catalog', 'get')({}, res);

    expect(capture.body.models).toHaveLength(
      OLLAMA_RECOMMENDATION_CATALOG.length,
    );
    expect(capture.body.models.find(
      (model: { name: string }) => model.name === 'qwen3.5:4b',
    )).toEqual(expect.objectContaining({
      installed: true,
      active: true,
      recommended: true,
    }));
    expect(capture.body.warning).toMatch(
      /hardware fit is curated guidance only/i,
    );
  });

  test('keeps status compatibility while replacing every endpoint field with null', async () => {
    const responseBody = Buffer.from('sensitive upstream body');
    mockRequestResolvedOllama.mockResolvedValue({
      authority: localResolved().authority,
      statusCode: 200,
      headers: {},
      body: responseBody,
      streaming: false,
    });
    const { capture, res } = responseCapture();

    await routeHandler('/status', 'get')({}, res);

    expect(capture.body).toEqual(expect.objectContaining({
      running: true,
      activeSource: 'local',
      activeEndpoint: null,
      checks: [{
        source: 'local',
        endpoint: null,
        reachable: true,
        status: 200,
      }],
      remoteConfigurationSupported: false,
      nativeTailnetSupported: true,
    }));
    expect(responseBody.equals(Buffer.alloc(responseBody.length))).toBe(true);
    expect(JSON.stringify(capture.body)).not.toContain('http://');
  });
});
