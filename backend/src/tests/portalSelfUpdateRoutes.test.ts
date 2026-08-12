const mockGetPortalUpdatePreparation = jest.fn();
const mockAdmitPortalUpdate = jest.fn();
const mockAdmitPortalUpdateRelease = jest.fn();
const mockLaunchPortalSelfUpdate = jest.fn();
const mockGetUpdateStatus = jest.fn();
const mockCreatePortalSelfUpdateLog = jest.fn();
const mockGetPortalSelfUpdateProgress = jest.fn();
const mockGetPortalSelfUpdateLog = jest.fn();
const mockLogRequestError = jest.fn().mockResolvedValue(undefined);

jest.mock('../config/database', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    nativeOllamaBackendBinding: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/avatars',
  BRANDING_DIR: '/tmp/branding',
  createImageUpload: jest.fn(() => (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next()),
  parseCropParams: jest.fn(() => undefined),
  processImageToTarget: jest.fn(),
  cleanupBasenameVariants: jest.fn(),
  cleanupBasenamePrefixVariants: jest.fn(),
  cleanupFile: jest.fn(),
  classifyImageUploadFailure: jest.fn(() => null),
}));

jest.mock('../services/updatePreparation', () => {
  class PortalSelfUpdateLaunchError extends Error {
    constructor(
      message: string,
      readonly statusCode: 409 | 500,
      readonly code:
        | 'PORTAL_UPDATE_BUSY'
        | 'PORTAL_UPDATE_ATTENTION_REQUIRED'
        | 'PORTAL_UPDATE_LAUNCH_FAILED',
      readonly operationId?: string,
    ) {
      super(message);
      this.name = 'PortalSelfUpdateLaunchError';
    }
  }

  return {
    getPortalUpdatePreparation: mockGetPortalUpdatePreparation,
    admitPortalUpdate: mockAdmitPortalUpdate,
    admitPortalUpdateRelease: mockAdmitPortalUpdateRelease,
    launchPortalSelfUpdate: mockLaunchPortalSelfUpdate,
    PortalSelfUpdateLaunchError,
  };
});

jest.mock('../services/telemetryService', () => ({
  getUpdateStatus: mockGetUpdateStatus,
  checkForUpdatesWithCooldown: jest.fn(),
}));

jest.mock('../services/portalSelfUpdateProgress', () => ({
  createPortalSelfUpdateLog: mockCreatePortalSelfUpdateLog,
  getPortalSelfUpdateProgress: mockGetPortalSelfUpdateProgress,
  getPortalSelfUpdateLog: mockGetPortalSelfUpdateLog,
}));

jest.mock('../utils/errorLogger', () => ({
  logRequestError: mockLogRequestError,
}));

import adminRouter from '../routes/admin';
import { AppError, errorHandler } from '../middleware/errorHandler';
import { PortalSelfUpdateLaunchError } from '../services/updatePreparation';

type SelfUpdateMethod = 'get' | 'post';

function routeStack(routePath: string, method: SelfUpdateMethod) {
  const layer = (adminRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === routePath
    && candidate.route?.methods?.[method] === true
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${routePath} route not found`);
  return layer.route.stack as Array<{ handle: (...args: any[]) => any }>;
}

function routeHandler(routePath: string, method: SelfUpdateMethod) {
  return routeStack(routePath, method).at(-1)!.handle as (
    req: any,
    res: any,
    next: (error?: unknown) => void,
  ) => Promise<void>;
}

function responseCapture() {
  const capture = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const res = {
    status(statusCode: number) {
      capture.statusCode = statusCode;
      return res;
    },
    setHeader(name: string, value: string) {
      capture.headers[name] = value;
      return res;
    },
    json(body: unknown) {
      capture.body = body;
      return res;
    },
  };
  return { capture, res };
}

async function invokeHandler(
  routePath: string,
  method: SelfUpdateMethod,
  req: Record<string, unknown>,
) {
  const { capture, res } = responseCapture();
  const next = jest.fn();
  await routeHandler(routePath, method)(req, res, next);
  if (next.mock.calls.length) {
    errorHandler(next.mock.calls[0][0] as Error, req as any, res as any, jest.fn());
  }
  return { capture, next };
}

const operationId = '0123456789abcdef0123456789abcdef';
const preparation = {
  confirmationPhrase: 'UPDATE PORTAL',
  backup: {
    state: 'candidate',
    maxAgeHours: 24,
    newestCreatedAt: '2026-08-10T05:00:00.000Z',
    ageHours: 1,
    activeStatus: null,
  },
};
const updateStatus = {
  current: '4.0.13',
  latest: '4.0.14',
  updateAvailable: true,
  details: { version: '4.0.14', provenance: 'signed' },
  detailsStatus: 'verified',
};
const progressSnapshot = {
  schema: 1,
  operationId,
  previousVersion: '4.0.13',
  expectedVersion: '4.0.14',
  status: 'running',
  phase: 'installer-download',
  percent: 5,
  label: 'Downloading versioned installer',
  detail: 'Step 1 of 13',
  startedAt: '2026-08-10T06:00:00.000Z',
  updatedAt: '2026-08-10T06:00:01.000Z',
  finishedAt: null,
  events: [],
  logAvailable: true,
  isCurrent: true,
  admissionBlocked: true,
};

describe('Portal self-update admin routes', () => {
  const originalOriginMode = process.env.ORIGIN_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORIGIN_MODE = 'tailnet';
    mockGetPortalUpdatePreparation.mockResolvedValue(preparation);
    mockAdmitPortalUpdate.mockReturnValue({ ok: true, backupDecision: 'use-current' });
    mockGetUpdateStatus.mockResolvedValue(updateStatus);
    mockAdmitPortalUpdateRelease.mockReturnValue({ ok: true, expectedVersion: '4.0.14' });
    mockCreatePortalSelfUpdateLog.mockReturnValue('/opt/bridgesllm/logs/self-update-safe.log');
    mockLaunchPortalSelfUpdate.mockResolvedValue({ operationId });
    mockGetPortalSelfUpdateProgress.mockResolvedValue(progressSnapshot);
    mockGetPortalSelfUpdateLog.mockReturnValue({ operationId, content: 'safe line one\nsafe line two' });
  });

  afterAll(() => {
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
  });

  test.each([
    ['/self-update', 'post'],
    ['/self-update/progress', 'get'],
    ['/self-update/log', 'get'],
  ] as const)('%s requires Owner authorization and rejects a sub-admin', async (routePath, method) => {
    const ownerLayer = routeStack(routePath, method)
      .find((layer) => layer.handle.name === 'requireOwner');
    expect(ownerLayer).toBeDefined();

    const { capture, res } = responseCapture();
    const next = jest.fn();
    await ownerLayer!.handle({ user: { role: 'SUB_ADMIN' } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(capture).toEqual({
      statusCode: 403,
      body: { error: 'Owner access required' },
      headers: {},
    });
  });

  test('labels normal update status as an authenticated candidate awaiting strict admission verification', async () => {
    const { capture, next } = await invokeHandler('/update-status', 'get', {});

    expect(next).not.toHaveBeenCalled();
    expect(mockGetPortalUpdatePreparation).toHaveBeenCalledWith();
    expect(capture.headers['Cache-Control']).toBe('private, no-store');
    expect(capture.body).toEqual({ ...updateStatus, preparation });
    expect((capture.body as any).preparation.backup.state).toBe('candidate');
  });

  test('returns a durable 202 receipt and forwards only the admitted update inputs', async () => {
    const requestBody = { confirmation: 'UPDATE PORTAL', expectedVersion: '4.0.14' };
    const { capture, next } = await invokeHandler('/self-update', 'post', {
      body: requestBody,
    });

    expect(next).not.toHaveBeenCalled();
    expect(mockGetPortalUpdatePreparation.mock.calls).toEqual([
      [],
      [expect.any(Number), { verifyFreshArchive: true }],
    ]);
    expect(mockAdmitPortalUpdate.mock.calls).toEqual([
      [preparation, requestBody, { allowAuthenticatedCandidate: true }],
      [preparation, requestBody],
    ]);
    expect(mockLaunchPortalSelfUpdate).toHaveBeenCalledWith({
      originMode: 'tailnet',
      domain: '',
      logFile: '/opt/bridgesllm/logs/self-update-safe.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.0.14',
    });
    expect(capture).toEqual({
      statusCode: 202,
      body: {
        ok: true,
        operationId,
        statusUrl: `/api/admin/self-update/progress?operationId=${operationId}`,
      },
      headers: {},
    });
  });

  test('returns the bounded attention conflict without leaking host diagnostics', async () => {
    const launchError = new PortalSelfUpdateLaunchError(
      'A prior Portal update still needs operator attention.',
      409,
      'PORTAL_UPDATE_ATTENTION_REQUIRED',
      operationId,
    ) as PortalSelfUpdateLaunchError & { stderr?: string; diagnostic?: string };
    launchError.stderr = 'journalctl: /root/private/installer.log SECRET-HOST-DIAGNOSTIC';
    launchError.diagnostic = 'systemd unit payload SECRET-HOST-DIAGNOSTIC';
    mockLaunchPortalSelfUpdate.mockRejectedValueOnce(launchError);

    const { capture, next } = await invokeHandler('/self-update', 'post', {
      body: { confirmation: 'UPDATE PORTAL', expectedVersion: '4.0.14' },
    });

    expect(next).not.toHaveBeenCalled();
    expect(capture).toEqual({
      statusCode: 409,
      body: {
        error: 'A prior Portal update still needs operator attention.',
        code: 'PORTAL_UPDATE_ATTENTION_REQUIRED',
        operationId,
      },
      headers: {},
    });
    expect(JSON.stringify(capture.body)).not.toMatch(/SECRET-HOST-DIAGNOSTIC|journalctl|\/root\//);
  });

  test.each([
    ['/self-update/progress', 'get', '../etc/passwd'],
    ['/self-update/log', 'get', 'ABCDEF0123456789ABCDEF0123456789'],
  ] as const)('%s rejects malformed operation identifiers with 400', async (routePath, method, badId) => {
    const { capture, next } = await invokeHandler(routePath, method, {
      query: { operationId: badId },
      method: method.toUpperCase(),
      path: `/api/admin${routePath}`,
    });

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
    expect(capture).toEqual({
      statusCode: 400,
      body: {
        error: 'Invalid Portal update operation identifier.',
        statusCode: 400,
      },
      headers: {},
    });
    expect(mockGetPortalSelfUpdateProgress).not.toHaveBeenCalled();
    expect(mockGetPortalSelfUpdateLog).not.toHaveBeenCalled();
  });

  test('forwards explicit and current progress identities and marks both responses private', async () => {
    const explicit = await invokeHandler('/self-update/progress', 'get', {
      query: { operationId },
    });
    const current = await invokeHandler('/self-update/progress', 'get', {
      query: {},
    });

    expect(mockGetPortalSelfUpdateProgress.mock.calls).toEqual([[operationId], [undefined]]);
    expect(explicit.capture.body).toBe(progressSnapshot);
    expect(current.capture.body).toBe(progressSnapshot);
    expect(explicit.capture.headers['Cache-Control']).toBe('private, no-store');
    expect(current.capture.headers['Cache-Control']).toBe('private, no-store');
  });

  test('returns only the bounded sanitized log shape by operation ID with no-store', async () => {
    const sanitizedContent = Array.from({ length: 200 }, (_, index) => `safe line ${index + 1}`).join('\n');
    mockGetPortalSelfUpdateLog.mockReturnValueOnce({ operationId, content: sanitizedContent });

    const { capture, next } = await invokeHandler('/self-update/log', 'get', {
      query: { operationId },
    });

    expect(next).not.toHaveBeenCalled();
    expect(mockGetPortalSelfUpdateLog).toHaveBeenCalledWith(operationId);
    expect(capture.statusCode).toBe(200);
    expect(capture.headers['Cache-Control']).toBe('private, no-store');
    expect(capture.body).toEqual({ ok: true, operationId, content: sanitizedContent });
    expect(Object.keys(capture.body as object).sort()).toEqual(['content', 'ok', 'operationId']);
    expect((capture.body as { content: string }).content.split('\n')).toHaveLength(200);
    expect((capture.body as { content: string }).content).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    expect(JSON.stringify(capture.body)).not.toMatch(/logFile|\/opt\/bridgesllm|\/var\/lib\/bridgesllm/);
  });
});
