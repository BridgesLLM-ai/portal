const mockReadEmbedSecurityPolicyState = jest.fn();
const mockUpdateEmbedSecurityPolicy = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findUnique: jest.fn(), findMany: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}));

jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/avatars',
  BRANDING_DIR: '/tmp/branding',
  createImageUpload: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.mock('../services/embedSecurityPolicy', () => {
  class EmbedSecurityPolicyRevisionConflictError extends Error {}
  class EmbedSecurityPolicyValidationError extends Error {}
  return {
    EmbedSecurityPolicyRevisionConflictError,
    EmbedSecurityPolicyValidationError,
    MAX_CUSTOM_EMBED_ORIGINS: 32,
    MAX_EMBED_ORIGIN_BYTES: 512,
    readEmbedSecurityPolicyState: mockReadEmbedSecurityPolicyState,
    updateEmbedSecurityPolicy: mockUpdateEmbedSecurityPolicy,
  };
});

import {
  EmbedSecurityPolicyRevisionConflictError,
  EmbedSecurityPolicyValidationError,
} from '../services/embedSecurityPolicy';
import adminRouter from '../routes/admin';

function route(method: 'get' | 'put') {
  const layer = (adminRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/security/embed-origins'
    && candidate.route?.methods?.[method] === true
  ));
  if (!layer) throw new Error(`${method} embed-origin route not found`);
  return layer.route.stack as Array<{ handle: (...args: any[]) => any }>;
}

function responseCapture() {
  const capture = { statusCode: 200, body: undefined as any };
  const res = {
    status(statusCode: number) {
      capture.statusCode = statusCode;
      return res;
    },
    json(body: unknown) {
      capture.body = body;
      return res;
    },
  };
  return { capture, res };
}

const state = {
  version: 1,
  revision: 'a'.repeat(64),
  status: 'ready',
  entries: [],
  defaultOrigins: ['https://www.youtube.com'],
  limits: { maxOrigins: 32, maxOriginBytes: 512, maxPolicyBytes: 8192 },
  updatedAt: null,
};

describe('Owner embed-origin admin routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadEmbedSecurityPolicyState.mockResolvedValue(state);
    mockUpdateEmbedSecurityPolicy.mockResolvedValue(state);
  });

  test.each(['get', 'put'] as const)('%s route requires the Owner middleware', (method) => {
    expect(route(method).map((layer) => layer.handle.name)).toContain('requireOwner');
  });

  test('returns the current policy without exposing generic settings', async () => {
    const handler = route('get').at(-1)!.handle;
    const { capture, res } = responseCapture();
    const next = jest.fn();
    await handler({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(capture).toEqual({ statusCode: 200, body: state });
    expect(mockReadEmbedSecurityPolicyState).toHaveBeenCalledTimes(1);
  });

  test('passes a frozen replacement policy and bounded request metadata to the service', async () => {
    const handler = route('put').at(-1)!.handle;
    const { capture, res } = responseCapture();
    const next = jest.fn();
    const entries = [{
      origin: 'https://video.example.com',
      camera: true,
      microphone: false,
    }];
    await handler({
      body: { expectedRevision: 'a'.repeat(64), entries },
      user: { userId: 'owner-1', role: 'OWNER' },
      ip: '203.0.113.8',
      get: () => 'agent'.repeat(200),
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockUpdateEmbedSecurityPolicy).toHaveBeenCalledWith({
      expectedRevision: 'a'.repeat(64),
      entries,
      actorUserId: 'owner-1',
      ipAddress: '203.0.113.8',
      userAgent: expect.any(String),
    });
    expect(mockUpdateEmbedSecurityPolicy.mock.calls[0][0].userAgent).toHaveLength(512);
    expect(capture).toEqual({ statusCode: 200, body: state });
  });

  test('returns a bounded 409 with the current safe policy on stale revision', async () => {
    const conflict = new EmbedSecurityPolicyRevisionConflictError();
    conflict.message = 'stale';
    mockUpdateEmbedSecurityPolicy.mockRejectedValueOnce(conflict);
    const handler = route('put').at(-1)!.handle;
    const { capture, res } = responseCapture();
    const next = jest.fn();
    await handler({
      body: { expectedRevision: 'b'.repeat(64), entries: [] },
      user: { userId: 'owner-1', role: 'OWNER' },
      ip: '',
      get: () => '',
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(capture).toEqual({
      statusCode: 409,
      body: {
        code: 'EMBED_SECURITY_POLICY_REVISION_CONFLICT',
        error: 'stale',
        current: state,
      },
    });
  });

  test('returns a specific 400 for semantic origin validation', async () => {
    mockUpdateEmbedSecurityPolicy.mockRejectedValueOnce(
      new EmbedSecurityPolicyValidationError('Origin must use HTTPS'),
    );
    const handler = route('put').at(-1)!.handle;
    const { capture, res } = responseCapture();
    const next = jest.fn();
    await handler({
      body: { expectedRevision: 'a'.repeat(64), entries: [] },
      user: { userId: 'owner-1', role: 'OWNER' },
      ip: '',
      get: () => '',
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(capture).toEqual({
      statusCode: 400,
      body: {
        code: 'INVALID_EMBED_SECURITY_POLICY',
        error: 'Origin must use HTTPS',
      },
    });
  });

  test('rejects unknown fields before any policy mutation', async () => {
    const handler = route('put').at(-1)!.handle;
    const { res } = responseCapture();
    const next = jest.fn();
    await handler({
      body: { expectedRevision: 'a'.repeat(64), entries: [], overwrite: true },
      user: { userId: 'owner-1', role: 'OWNER' },
      ip: '',
      get: () => '',
    }, res, next);
    expect(mockUpdateEmbedSecurityPolicy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZodError' }));
  });
});
