const userFindUnique = jest.fn();
const userUpdate = jest.fn();
const mockAuthenticateToken = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const getOpenClawExecutionAdmissionMock = jest.fn();

const mockPrisma = {
  user: {
    findUnique: userFindUnique,
    update: userUpdate,
  },
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../middleware/auth', () => ({ authenticateToken: mockAuthenticateToken }));
jest.mock('../services/openClawExecutionAdmission', () => ({
  ...jest.requireActual('../services/openClawExecutionAdmission'),
  getOpenClawExecutionAdmission: getOpenClawExecutionAdmissionMock,
}));
jest.mock('../services/imageAssets', () => ({
  AVATARS_DIR: '/tmp/avatars',
  createImageUpload: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  parseCropParams: jest.fn(),
  processImageToTarget: jest.fn(),
  cleanupBasenameVariants: jest.fn(),
  cleanupFile: jest.fn(),
  classifyImageUploadFailure: jest.fn(() => null),
}));

import usersRouter, { defaultHarnessCanBeNewSelection, registeredImplementedDefaultHarness } from '../routes/users';
import { authenticateToken } from '../middleware/auth';

function routeHandlers(path: string, method: 'get' | 'patch') {
  const layer = (usersRouter as any).stack.find((entry: any) => (
    entry.route?.path === path && entry.route?.methods?.[method] === true
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} route not found`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

function responseCapture() {
  const capture = { statusCode: 200, body: undefined as unknown };
  const res = {
    setHeader: jest.fn().mockReturnThis(),
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

describe('per-user default Agent Chat harness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOpenClawExecutionAdmissionMock.mockResolvedValue({ state: 'ready', ready: true });
    userFindUnique.mockResolvedValue({
      defaultAgentHarness: 'OPENCLAW',
      defaultAgentHarnessRevision: 0,
    });
    userUpdate.mockResolvedValue({
      defaultAgentHarness: 'HERMES',
      defaultAgentHarnessRevision: 2,
    });
  });

  test('accepts only registered, implemented, selectable harness identities', async () => {
    expect(registeredImplementedDefaultHarness('OPENCLAW')).toBe('OPENCLAW');
    expect(registeredImplementedDefaultHarness('CODEX')).toBe('CODEX');
    expect(registeredImplementedDefaultHarness('HERMES')).toBe('HERMES');
    expect(registeredImplementedDefaultHarness('OPENCODE')).toBe('OPENCODE');
    expect(registeredImplementedDefaultHarness('DEEPSEEK_HARNESS')).toBeNull();
    expect(registeredImplementedDefaultHarness('openai/gpt-5.6')).toBeNull();
    await expect(defaultHarnessCanBeNewSelection('OPENCLAW')).resolves.toBe(true);
    await expect(defaultHarnessCanBeNewSelection('CODEX')).resolves.toBe(true);
    await expect(defaultHarnessCanBeNewSelection('CLAUDE_CODE')).resolves.toBe(true);
    await expect(defaultHarnessCanBeNewSelection('HERMES')).resolves.toBe(true);
    expect(getOpenClawExecutionAdmissionMock).toHaveBeenCalledTimes(1);
  });

  test.each(['get', 'patch'] as const)('%s endpoint authenticates before preference access', (method) => {
    expect(routeHandlers('/me/agent-harness-preference', method)[0]).toBe(authenticateToken);
  });

  test('returns a private, server-validated preference', async () => {
    const handler = routeHandlers('/me/agent-harness-preference', 'get').at(-1);
    const response = responseCapture();

    await handler({ user: { userId: 'user-1' } }, response.res);

    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { defaultAgentHarness: true, defaultAgentHarnessRevision: true },
    });
    expect(response.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0');
    expect(response.capture).toEqual({
      statusCode: 200,
      body: { defaultHarness: 'OPENCLAW', revision: 0 },
    });
  });

  test('fails closed when a stored identity is no longer registered and implemented', async () => {
    userFindUnique.mockResolvedValueOnce({
      defaultAgentHarness: 'DEEPSEEK_HARNESS',
      defaultAgentHarnessRevision: 7,
    });
    const handler = routeHandlers('/me/agent-harness-preference', 'get').at(-1);
    const response = responseCapture();

    await handler({ user: { userId: 'user-1' } }, response.res);

    expect(response.capture.statusCode).toBe(409);
    expect(response.capture.body).toEqual(expect.objectContaining({
      code: 'DEFAULT_AGENT_HARNESS_INVALID',
    }));
  });

  test('returns a preexisting managed default without rewriting it', async () => {
    userFindUnique.mockResolvedValueOnce({
      defaultAgentHarness: 'CODEX',
      defaultAgentHarnessRevision: 7,
    });
    const handler = routeHandlers('/me/agent-harness-preference', 'get').at(-1);
    const response = responseCapture();

    await handler({ user: { userId: 'user-1' } }, response.res);

    expect(response.capture).toEqual({
      statusCode: 200,
      body: { defaultHarness: 'CODEX', revision: 7 },
    });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test('normalizes and atomically revisions an allowed preference', async () => {
    const handler = routeHandlers('/me/agent-harness-preference', 'patch').at(-1);
    const response = responseCapture();

    await handler({
      user: { userId: 'user-1' },
      body: { harnessId: 'hermes' },
    }, response.res);

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        defaultAgentHarness: 'HERMES',
        defaultAgentHarnessRevision: { increment: 1 },
      },
      select: { defaultAgentHarness: true, defaultAgentHarnessRevision: true },
    });
    expect(response.capture.body).toEqual({ defaultHarness: 'HERMES', revision: 2 });
  });

  test.each(['CODEX', 'CLAUDE_CODE'] as const)('allows supervised native host default %s without probing mutable runtime state', async (harnessId) => {
    userUpdate.mockResolvedValueOnce({
      defaultAgentHarness: harnessId,
      defaultAgentHarnessRevision: 3,
    });
    const handler = routeHandlers('/me/agent-harness-preference', 'patch').at(-1);
    const response = responseCapture();

    await handler({ user: { userId: 'user-1' }, body: { harnessId } }, response.res);

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        defaultAgentHarness: harnessId,
        defaultAgentHarnessRevision: { increment: 1 },
      },
      select: { defaultAgentHarness: true, defaultAgentHarnessRevision: true },
    });
    expect(response.capture).toEqual({
      statusCode: 200,
      body: { defaultHarness: harnessId, revision: 3 },
    });
  });

  test('allows OpenClaw as a new default only after dynamic execution admission', async () => {
    userUpdate.mockResolvedValueOnce({
      defaultAgentHarness: 'OPENCLAW',
      defaultAgentHarnessRevision: 3,
    });
    const handler = routeHandlers('/me/agent-harness-preference', 'patch').at(-1);
    const response = responseCapture();

    await handler({ user: { userId: 'user-1' }, body: { harnessId: 'OPENCLAW' } }, response.res);

    expect(getOpenClawExecutionAdmissionMock).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        defaultAgentHarness: 'OPENCLAW',
        defaultAgentHarnessRevision: { increment: 1 },
      },
      select: { defaultAgentHarness: true, defaultAgentHarnessRevision: true },
    });
    expect(response.capture).toEqual({
      statusCode: 200,
      body: { defaultHarness: 'OPENCLAW', revision: 3 },
    });
  });

  test('rejects OpenClaw as a new default when dynamic execution admission is unavailable', async () => {
    getOpenClawExecutionAdmissionMock.mockResolvedValueOnce({
      state: 'maintenance',
      ready: false,
    });
    const handler = routeHandlers('/me/agent-harness-preference', 'patch').at(-1);
    const response = responseCapture();

    await handler({ user: { userId: 'user-1' }, body: { harnessId: 'OPENCLAW' } }, response.res);

    expect(response.capture.statusCode).toBe(409);
    expect(response.capture.body).toEqual(expect.objectContaining({
      code: 'DEFAULT_AGENT_HARNESS_RUNTIME_UNAVAILABLE',
      error: 'OpenClaw is not ready for Agent Chat execution on this host. Recover any retained maintenance state and verify the tested runtime before selecting it.',
    }));
    expect(userUpdate).not.toHaveBeenCalled();
  });

  test.each(['DEEPSEEK_HARNESS', 'unknown'])(
    'rejects unsupported default %s without writing',
    async (harnessId) => {
      const handler = routeHandlers('/me/agent-harness-preference', 'patch').at(-1);
      const response = responseCapture();
      await handler({ user: { userId: 'user-1' }, body: { harnessId } }, response.res);
      expect(response.capture.statusCode).toBe(400);
      expect(response.capture.body).toEqual(expect.objectContaining({
        code: 'DEFAULT_AGENT_HARNESS_UNSUPPORTED',
      }));
      expect(userUpdate).not.toHaveBeenCalled();
    },
  );

  test('rejects ambiguous preference payloads', async () => {
    const handler = routeHandlers('/me/agent-harness-preference', 'patch').at(-1);
    const response = responseCapture();
    await handler({
      user: { userId: 'user-1' },
      body: { harnessId: 'CODEX', provider: 'OPENCLAW' },
    }, response.res);
    expect(response.capture.statusCode).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
