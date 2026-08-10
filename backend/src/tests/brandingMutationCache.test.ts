import fs from 'fs';
import path from 'path';

const invalidateEmailBrandingCache = jest.fn();
const systemSettingUpsert = jest.fn();
const transactionUpsert = jest.fn();
const processImageToTarget = jest.fn();
const cleanupBasenamePrefixVariants = jest.fn();
const cleanupFile = jest.fn();

const mockPrisma = {
  systemSetting: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: systemSettingUpsert,
  },
  nativeOllamaBackendBinding: { findFirst: jest.fn() },
  activityLog: { create: jest.fn() },
  $transaction: jest.fn(),
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../middleware/requireAdmin', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireOwner: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../templates/baseTemplate', () => ({
  invalidateEmailBrandingCache,
  isEmailBrandingSettingKey: (key: string) => [
    'appearance.portalName',
    'appearance.logoUrl',
    'appearance.accentColor',
  ].includes(key),
}));
jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/avatars',
  BRANDING_DIR: '/tmp/branding',
  createImageUpload: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  parseCropParams: jest.fn(() => undefined),
  processImageToTarget,
  cleanupBasenameVariants: jest.fn(),
  cleanupBasenamePrefixVariants,
  cleanupFile,
  classifyImageUploadFailure: jest.fn(() => null),
}));

let adminRouter: any;

function routeHandler(routePath: string, method: 'put' | 'post' | 'delete') {
  const layer = (adminRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === routePath && candidate.route?.methods?.[method] === true
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${routePath} route not found`);
  return layer.route.stack.at(-1).handle as (
    req: any,
    res: any,
    next: (error?: unknown) => void,
  ) => Promise<void>;
}

function responseCapture() {
  const capture = { statusCode: 200, body: undefined as unknown };
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

describe('email branding cache mutation wiring', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/portal_test';
    adminRouter = (await import('../routes/admin')).default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.systemSetting.findMany.mockResolvedValue([]);
    mockPrisma.nativeOllamaBackendBinding.findFirst.mockResolvedValue(null);
    mockPrisma.activityLog.create.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(
      async (operation: (transaction: unknown) => Promise<unknown>) => operation({
        systemSetting: { upsert: transactionUpsert },
      }),
    );
    transactionUpsert.mockResolvedValue({});
    systemSettingUpsert.mockResolvedValue({});
    processImageToTarget.mockResolvedValue({ ext: '.gif' });
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test('invalidates after an atomic appearance settings patch but not after unrelated settings', async () => {
    const handler = routeHandler('/settings', 'put');
    const next = jest.fn();

    await handler({
      body: { 'appearance.portalName': 'Tenant Portal' },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, responseCapture().res, next);

    expect(next).not.toHaveBeenCalled();
    expect(invalidateEmailBrandingCache).toHaveBeenCalledTimes(1);
    expect(transactionUpsert.mock.invocationCallOrder[0])
      .toBeLessThan(invalidateEmailBrandingCache.mock.invocationCallOrder[0]);

    invalidateEmailBrandingCache.mockClear();
    await handler({
      body: { 'system.allowTelemetry': 'false' },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, responseCapture().res, next);
    expect(invalidateEmailBrandingCache).not.toHaveBeenCalled();
  });

  test('invalidates after both direct logo upload and delete writes', async () => {
    const upload = routeHandler('/appearance/logo', 'post');
    const remove = routeHandler('/appearance/logo', 'delete');
    const next = jest.fn();

    const uploadResponse = responseCapture();
    await upload({
      file: { path: '/tmp/logo-upload', mimetype: 'image/gif' },
      body: {},
    }, uploadResponse.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(uploadResponse.capture.body).toEqual(expect.objectContaining({
      success: true,
      logoUrl: expect.stringMatching(/^\/static-assets\/branding\/portal-logo-\d+\.gif$/),
    }));
    expect(invalidateEmailBrandingCache).toHaveBeenCalledTimes(1);
    expect(systemSettingUpsert.mock.invocationCallOrder[0])
      .toBeLessThan(invalidateEmailBrandingCache.mock.invocationCallOrder[0]);

    await remove({}, responseCapture().res, next);
    expect(invalidateEmailBrandingCache).toHaveBeenCalledTimes(2);
    expect(systemSettingUpsert).toHaveBeenLastCalledWith({
      where: { key: 'appearance.logoUrl' },
      update: { value: '' },
      create: { key: 'appearance.logoUrl', value: '' },
    });
  });

  test('does not invalidate when a direct branding write fails', async () => {
    const failure = new Error('write failed');
    systemSettingUpsert.mockRejectedValueOnce(failure);
    const next = jest.fn();

    await routeHandler('/appearance/logo', 'delete')({}, responseCapture().res, next);

    expect(next).toHaveBeenCalledWith(failure);
    expect(invalidateEmailBrandingCache).not.toHaveBeenCalled();
    expect(cleanupBasenamePrefixVariants).not.toHaveBeenCalled();
  });

  test('returns committed success when superseded-file cleanup fails', async () => {
    cleanupBasenamePrefixVariants.mockImplementationOnce(() => {
      throw new Error('cleanup failed');
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const next = jest.fn();
    const response = responseCapture();

    await routeHandler('/appearance/logo', 'delete')({}, response.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.capture.body).toEqual({ success: true });
    expect(invalidateEmailBrandingCache).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[branding] Failed to clean up superseded Portal logo files');
    log.mockRestore();
  });

  test('removes a newly processed logo if its settings write fails without deleting the active logo set', async () => {
    const failure = new Error('write failed');
    systemSettingUpsert.mockRejectedValueOnce(failure);
    const next = jest.fn();

    await routeHandler('/appearance/logo', 'post')({
      file: { path: '/tmp/logo-upload', mimetype: 'image/gif' },
      body: {},
    }, responseCapture().res, next);

    expect(next).toHaveBeenCalledWith(failure);
    expect(invalidateEmailBrandingCache).not.toHaveBeenCalled();
    expect(cleanupBasenamePrefixVariants).not.toHaveBeenCalled();
    expect(cleanupFile).toHaveBeenCalledWith(expect.stringMatching(
      /^\/tmp\/branding\/portal-logo-\d+\.gif$/,
    ));
    expect(cleanupFile).toHaveBeenCalledWith('/tmp/logo-upload');
  });

  test('invalidates setup branding only after the owner/settings transaction commits', () => {
    const setupSource = fs.readFileSync(path.resolve(__dirname, '../routes/setup-v3.ts'), 'utf8');
    expect(setupSource).toMatch(
      /transactionCommitted = true;\s*invalidateEmailBrandingCache\(\);/,
    );
    expect(setupSource).toContain("'appearance.portalName': body.portalName");
    expect(setupSource).toContain("'appearance.logoUrl': logoUrl");
    expect(setupSource).toContain("'appearance.accentColor': body.accentColor");
  });
});
