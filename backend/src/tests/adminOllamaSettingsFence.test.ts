const mockSystemSettingUpsert = jest.fn();
const mockPrisma = {
  systemSetting: {
    findMany: jest.fn(),
  },
  nativeOllamaBackendBinding: {
    findFirst: jest.fn(),
  },
  activityLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};
const mockWithOllamaAuthorityMutationFence = jest.fn();

jest.mock('../config/database', () => ({ prisma: mockPrisma }));

jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/avatars',
  BRANDING_DIR: '/tmp/branding',
  createImageUpload: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.mock('../services/ollamaAuthorityBarrier', () => {
  const actual = jest.requireActual('../services/ollamaAuthorityBarrier');
  return {
    ...actual,
    withOllamaAuthorityMutationFence: mockWithOllamaAuthorityMutationFence,
  };
});

import {
  OllamaAuthorityBarrierBusyError,
} from '../services/ollamaAuthorityBarrier';
import adminRouter from '../routes/admin';

function settingsHandler() {
  const layer = (adminRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/settings'
    && candidate.route?.methods?.put === true
  ));
  if (!layer) throw new Error('Admin settings route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle as (
    req: any,
    res: any,
    next: (error?: unknown) => void,
  ) => Promise<void>;
}

function responseCapture() {
  const capture = {
    statusCode: 200,
    body: undefined as unknown,
  };
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

describe('admin Ollama local-policy settings fence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.systemSetting.findMany.mockResolvedValue([]);
    mockPrisma.nativeOllamaBackendBinding.findFirst.mockResolvedValue(null);
    mockPrisma.activityLog.create.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation(
      async (operation: (transaction: unknown) => Promise<unknown>) => operation({
        systemSetting: { upsert: mockSystemSettingUpsert },
      }),
    );
    mockSystemSettingUpsert.mockResolvedValue({});
    mockWithOllamaAuthorityMutationFence.mockImplementation(
      async (operation: () => Promise<unknown>) => operation(),
    );
  });

  test('wraps the entire atomic settings patch when local authority policy changes', async () => {
    const order: string[] = [];
    mockWithOllamaAuthorityMutationFence.mockImplementation(
      async (operation: () => Promise<unknown>) => {
        order.push('fence-open');
        const value = await operation();
        order.push('fence-close');
        return value;
      },
    );
    mockPrisma.$transaction.mockImplementation(
      async (operation: (transaction: unknown) => Promise<unknown>) => {
        order.push('transaction');
        return operation({ systemSetting: { upsert: mockSystemSettingUpsert } });
      },
    );
    const { capture, res } = responseCapture();
    const next = jest.fn();

    await settingsHandler()({
      body: {
        'ollama.localEnabled': 'false',
        'system.allowTelemetry': 'false',
      },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockWithOllamaAuthorityMutationFence).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['fence-open', 'transaction', 'fence-close']);
    expect(mockSystemSettingUpsert).toHaveBeenCalledTimes(2);
    expect(mockSystemSettingUpsert).toHaveBeenCalledWith({
      where: { key: 'ollama.localEnabled' },
      update: { value: 'false' },
      create: { key: 'ollama.localEnabled', value: 'false' },
    });
    expect(capture.body).toEqual({});
  });

  test('does not fence unrelated settings patches', async () => {
    const { res } = responseCapture();
    const next = jest.fn();

    await settingsHandler()({
      body: { 'system.allowTelemetry': 'false' },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockWithOllamaAuthorityMutationFence).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockSystemSettingUpsert).toHaveBeenCalledWith({
      where: { key: 'system.allowTelemetry' },
      update: { value: 'false' },
      create: { key: 'system.allowTelemetry', value: 'false' },
    });
  });

  test('blocks local-policy edits while a native authority owns the downgrade fence', async () => {
    mockPrisma.nativeOllamaBackendBinding.findFirst.mockResolvedValue({
      id: 'native-authority-1',
    });
    const { capture, res } = responseCapture();
    const next = jest.fn();

    await settingsHandler()({
      body: { 'ollama.localEnabled': 'true' },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockWithOllamaAuthorityMutationFence).toHaveBeenCalledTimes(1);
    expect(mockPrisma.nativeOllamaBackendBinding.findFirst).toHaveBeenCalledWith({
      where: {
        purposeId: 'PRIMARY',
        state: { in: ['ACTIVE', 'DISCONNECTED'] },
      },
      select: { id: true },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(capture).toEqual({
      statusCode: 409,
      body: {
        code: 'NATIVE_OLLAMA_LOCAL_POLICY_LOCKED',
        error:
          'Local Ollama policy cannot change while a native Remote GPU authority exists. Remove the Remote GPU first.',
      },
    });
  });

  test('fails local-policy mutation busy with a bounded 409 before the database transaction', async () => {
    mockWithOllamaAuthorityMutationFence.mockRejectedValue(
      new OllamaAuthorityBarrierBusyError(),
    );
    const { capture, res } = responseCapture();
    const next = jest.fn();

    await settingsHandler()({
      body: { 'ollama.localEnabled': 'true' },
      user: { userId: 'owner-1', role: 'OWNER' },
    }, res, next);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(capture).toEqual({
      statusCode: 409,
      body: {
        code: 'OLLAMA_AUTHORITY_BUSY',
        error: 'The Ollama backend authority is changing or in use. Retry shortly.',
      },
    });
    expect(JSON.stringify(capture.body)).not.toMatch(/activeRuns|mutationFenced|count/i);
  });
});
