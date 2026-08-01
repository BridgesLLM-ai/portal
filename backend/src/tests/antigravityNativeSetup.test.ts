const mockGetNativeProviderReadiness = jest.fn();
const mockInvalidateNativeProviderReadiness = jest.fn();
const mockListAntigravityModelsFromCli = jest.fn();
const mockInvalidateAntigravityModelCache = jest.fn();
const mockListGatewayModels = jest.fn();
const mockStartNativeCliFlow = jest.fn();
const mockCompleteNativeCliFlow = jest.fn();
const mockGetOAuthFlowStatus = jest.fn();
const mockInvalidateNativeCliAuthStatus = jest.fn();

jest.mock('../agents/nativeProviderReadiness', () => ({
  ...jest.requireActual('../agents/nativeProviderReadiness'),
  getNativeProviderReadiness: mockGetNativeProviderReadiness,
  invalidateNativeProviderReadiness: mockInvalidateNativeProviderReadiness,
}));

jest.mock('../agents/antigravityModels', () => ({
  ...jest.requireActual('../agents/antigravityModels'),
  listAntigravityModelsFromCli: mockListAntigravityModelsFromCli,
  invalidateAntigravityModelCache: mockInvalidateAntigravityModelCache,
}));

jest.mock('../utils/openclawGatewayRpc', () => ({
  ...jest.requireActual('../utils/openclawGatewayRpc'),
  listGatewayModels: mockListGatewayModels,
}));

jest.mock('../services/oauthFlowManager', () => ({
  ...jest.requireActual('../services/oauthFlowManager'),
  startNativeCliFlow: mockStartNativeCliFlow,
  completeNativeCliFlow: mockCompleteNativeCliFlow,
  getOAuthFlowStatus: mockGetOAuthFlowStatus,
}));

jest.mock('../agents/nativeCliAuth', () => ({
  ...jest.requireActual('../agents/nativeCliAuth'),
  invalidateNativeCliAuthStatus: mockInvalidateNativeCliAuthStatus,
}));

import { createAiSetupRouter } from '../routes/ai-setup';

function modelsHandler(): any {
  const router = createAiSetupRouter();
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === '/models');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeExactCatalog() {
  const response: any = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  await modelsHandler()({ query: { provider: 'google-antigravity', exact: '1' } }, response);
  return response;
}

async function invokeNativeRoute(
  path: string,
  method: 'get' | 'post',
  request: Record<string, unknown>,
) {
  const router = createAiSetupRouter();
  const layer = (router as any).stack.find((entry: any) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const response: any = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  await handler(request, response);
  return response;
}

async function invokeNativeStart(body: Record<string, unknown>, userId = 'native-owner') {
  return invokeNativeRoute('/native-cli/start', 'post', { body, user: { userId } });
}

describe('Antigravity native setup catalog boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListGatewayModels.mockResolvedValue({ ok: true, models: [{ id: 'openclaw/sentinel-model' }] });
  });

  test('returns only the exact live native catalog and never falls through to OpenClaw', async () => {
    mockGetNativeProviderReadiness.mockResolvedValue({
      provider: 'GEMINI',
      state: 'live_verified',
      usable: true,
      message: 'verified',
    });
    mockListAntigravityModelsFromCli.mockReturnValue([
      { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' },
    ]);

    const response = await invokeExactCatalog();

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      source: 'native-cli',
      exact: true,
      models: [
        { id: 'google-antigravity/gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google-antigravity' },
        { id: 'google-antigravity/gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', provider: 'google-antigravity' },
      ],
    }));
    expect(mockInvalidateAntigravityModelCache).toHaveBeenCalledTimes(1);
    expect(mockGetNativeProviderReadiness).toHaveBeenCalledWith('GEMINI', { force: true });
    expect(mockInvalidateAntigravityModelCache.mock.invocationCallOrder[0])
      .toBeLessThan(mockListAntigravityModelsFromCli.mock.invocationCallOrder[0]);
    expect(mockListGatewayModels).not.toHaveBeenCalled();
  });

  test('fails closed when the native login is not live-verified', async () => {
    mockGetNativeProviderReadiness.mockResolvedValue({
      provider: 'GEMINI',
      state: 'needs_login',
      usable: false,
      message: 'Antigravity needs login.',
    });

    const response = await invokeExactCatalog();

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      source: 'native-cli',
      exact: true,
      error: 'Antigravity needs login.',
    }));
    expect(mockListAntigravityModelsFromCli).not.toHaveBeenCalled();
    expect(mockListGatewayModels).not.toHaveBeenCalled();
  });

  test('fails closed when an authenticated CLI returns no exact models', async () => {
    mockGetNativeProviderReadiness.mockResolvedValue({
      provider: 'GEMINI',
      state: 'live_verified',
      usable: true,
      message: 'verified',
    });
    mockListAntigravityModelsFromCli.mockReturnValue([]);

    const response = await invokeExactCatalog();

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      source: 'native-cli',
      exact: true,
      error: expect.stringContaining('exact model catalog'),
    }));
    expect(mockListGatewayModels).not.toHaveBeenCalled();
  });

  test('finalizes an already-complete start response before the frontend loads models', async () => {
    const sessionId = 'native-antigravity-complete-start';
    mockStartNativeCliFlow.mockResolvedValue({
      sessionId,
      status: 'complete',
      alreadyAuthenticated: true,
      reauthSupported: false,
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
    });
    mockGetOAuthFlowStatus.mockReturnValue({
      id: sessionId,
      provider: 'gemini',
      status: 'complete',
    });

    const response = await invokeNativeStart({ provider: 'gemini', forceReauth: true });

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      sessionId,
      status: 'complete',
      alreadyAuthenticated: true,
    }));
    expect(mockStartNativeCliFlow).toHaveBeenCalledWith('gemini', {
      forceReauth: true,
      ownerId: 'user:native-owner',
    });
    expect(mockGetOAuthFlowStatus).toHaveBeenCalledWith(sessionId, 'user:native-owner');
    expect(mockInvalidateNativeCliAuthStatus).toHaveBeenCalledWith('GEMINI');
    expect(mockInvalidateNativeProviderReadiness).toHaveBeenCalledWith('GEMINI');
    expect(mockInvalidateAntigravityModelCache).toHaveBeenCalled();
  });

  test('returns the durable cleanup session when native startup fails after spawning', async () => {
    const startError = Object.assign(new Error('Native login did not produce instructions.'), {
      sessionId: 'native-start-cleanup-session',
      oauthSessionId: 'native-start-cleanup-session',
      cleanupPending: true,
      credentialState: 'indeterminate',
    });
    mockStartNativeCliFlow.mockRejectedValue(startError);

    const response = await invokeNativeStart({ provider: 'codex' });

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: 'Native login did not produce instructions.',
      sessionId: 'native-start-cleanup-session',
      cleanupPending: true,
      credentialState: 'indeterminate',
    });
  });

  test('binds native status lookup to the authenticated requester', async () => {
    mockGetOAuthFlowStatus.mockReturnValue(null);

    const response = await invokeNativeRoute('/native-cli/status/:sessionId', 'get', {
      params: { sessionId: 'native-owner-session' },
      user: { userId: 'other-owner' },
    });

    expect(mockGetOAuthFlowStatus).toHaveBeenCalledWith('native-owner-session', 'user:other-owner');
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: 'Native CLI session not found' });
  });

  test('binds native callback completion and finalization to the authenticated requester', async () => {
    mockCompleteNativeCliFlow.mockResolvedValue({ success: true });
    mockGetOAuthFlowStatus.mockReturnValue({
      id: 'native-owner-session',
      provider: 'gemini',
      status: 'complete',
    });

    const response = await invokeNativeRoute('/native-cli/callback', 'post', {
      body: { sessionId: 'native-owner-session', callbackUrl: 'authorization-code' },
      user: { userId: 'native-owner' },
    });

    expect(mockCompleteNativeCliFlow).toHaveBeenCalledWith(
      'native-owner-session',
      'authorization-code',
      'user:native-owner',
    );
    expect(mockGetOAuthFlowStatus).toHaveBeenCalledWith('native-owner-session', 'user:native-owner');
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  test('returns not-found for a native callback session rejected by owner binding', async () => {
    mockCompleteNativeCliFlow.mockRejectedValue(new Error('Native CLI session not found'));

    const response = await invokeNativeRoute('/native-cli/callback', 'post', {
      body: { sessionId: 'native-other-owner-session', callbackUrl: 'authorization-code' },
      user: { userId: 'requester' },
    });

    expect(mockCompleteNativeCliFlow).toHaveBeenCalledWith(
      'native-other-owner-session',
      'authorization-code',
      'user:requester',
    );
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: 'Native CLI session not found',
    });
  });
});
