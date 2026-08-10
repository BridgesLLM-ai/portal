process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

const mockActivityCreate = jest.fn();
const mockActivityUpdate = jest.fn();
const mockActivityUpdateMany = jest.fn();
const mockActivityCount = jest.fn();
const mockLaunchProjectRuntimeImageRepair = jest.fn();
const mockGetProjectRuntimeImageRepairStatus = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    activityLog: {
      create: mockActivityCreate,
      update: mockActivityUpdate,
      updateMany: mockActivityUpdateMany,
      count: mockActivityCount,
    },
  },
}));

jest.mock('../services/projectRuntimeImageRepair', () => {
  const actual = jest.requireActual('../services/projectRuntimeImageRepair');
  return {
    ...actual,
    getProjectRuntimeImageRepairStatus: mockGetProjectRuntimeImageRepairStatus,
    launchProjectRuntimeImageRepair: mockLaunchProjectRuntimeImageRepair,
  };
});

import systemRemediationRouter from '../routes/system-remediation';
import { ProjectRuntimeImageRepairLaunchError } from '../services/projectRuntimeImageRepair';

function repairHandler() {
  const layer = (systemRemediationRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/:feature/auto-setup'
    && candidate.route?.methods?.post === true
  ));
  if (!layer) throw new Error('System remediation route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle as (
    req: any,
    res: any,
  ) => Promise<void>;
}

function statusHandler() {
  const layer = (systemRemediationRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/projectRuntimeImage/status'
    && candidate.route?.methods?.get === true
  ));
  if (!layer) throw new Error('System remediation status route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle as (
    req: any,
    res: any,
  ) => Promise<void>;
}

function responseCapture() {
  const capture = { statusCode: 200, body: undefined as any };
  const res = {
    setHeader: jest.fn(),
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

async function invokeStatus() {
  const { capture, res } = responseCapture();
  await statusHandler()({
    user: { userId: 'owner-1', role: 'OWNER' },
  }, res);
  return capture;
}

async function invokeRepair() {
  const { capture, res } = responseCapture();
  await repairHandler()({
    params: { feature: 'projectRuntimeImage' },
    body: { confirmation: 'REPAIR PROJECT RUNTIME IMAGE' },
    user: { userId: 'owner-1', role: 'OWNER' },
  }, res);
  return capture;
}

describe('Project runtime image repair audit admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActivityCreate.mockReset().mockResolvedValue({ id: 'audit-1' });
    mockActivityUpdate.mockReset().mockResolvedValue({ id: 'audit-1' });
    mockActivityUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockActivityCount.mockReset().mockResolvedValue(0);
    mockLaunchProjectRuntimeImageRepair.mockReset();
    mockGetProjectRuntimeImageRepairStatus.mockReset().mockResolvedValue({
      state: 'unavailable',
      unavailableReason: 'image-missing',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
  });

  test('fails closed before host mutation when durable audit admission is unavailable', async () => {
    mockActivityCreate.mockRejectedValueOnce(new Error('audit store unavailable'));

    const response = await invokeRepair();

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_AUDIT_UNAVAILABLE',
    });
    expect(mockLaunchProjectRuntimeImageRepair).not.toHaveBeenCalled();
    expect(mockActivityUpdate).not.toHaveBeenCalled();
  });

  test('fails closed when an unavailable repair lane still has an unresolved audit generation', async () => {
    mockActivityCount.mockResolvedValueOnce(1);

    const response = await invokeRepair();

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_AUDIT_INDETERMINATE',
    });
    expect(mockActivityCreate).not.toHaveBeenCalled();
    expect(mockLaunchProjectRuntimeImageRepair).not.toHaveBeenCalled();
  });

  test.each(['unit-state-unknown', 'image-state-unknown'] as const)(
    'keeps the prior audit generation pending when readiness is %s',
    async (unavailableReason) => {
      mockGetProjectRuntimeImageRepairStatus.mockResolvedValueOnce({
        state: 'unavailable',
        unavailableReason,
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      });
      mockActivityCount.mockResolvedValueOnce(1);

      const response = await invokeRepair();

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({
        code: 'PROJECT_RUNTIME_IMAGE_REPAIR_AUDIT_INDETERMINATE',
      });
      expect(mockActivityUpdateMany).not.toHaveBeenCalled();
      expect(mockActivityCreate).not.toHaveBeenCalled();
      expect(mockLaunchProjectRuntimeImageRepair).not.toHaveBeenCalled();
    },
  );

  test.each(['unit-state-unknown', 'image-state-unknown'] as const)(
    'rejects an unsafe new repair without creating an audit when readiness is %s',
    async (unavailableReason) => {
      mockGetProjectRuntimeImageRepairStatus.mockResolvedValueOnce({
        state: 'unavailable',
        unavailableReason,
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      });

      const response = await invokeRepair();

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({
        code: 'PROJECT_RUNTIME_IMAGE_REPAIR_STATE_UNAVAILABLE',
      });
      expect(mockActivityUpdateMany).not.toHaveBeenCalled();
      expect(mockActivityCreate).not.toHaveBeenCalled();
      expect(mockLaunchProjectRuntimeImageRepair).not.toHaveBeenCalled();
    },
  );

  test('settles an authoritatively missing-image generation before admitting repair', async () => {
    mockGetProjectRuntimeImageRepairStatus.mockResolvedValueOnce({
      state: 'unavailable',
      unavailableReason: 'image-missing',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    mockLaunchProjectRuntimeImageRepair.mockResolvedValueOnce({ state: 'running', started: true });

    const response = await invokeRepair();

    expect(response.statusCode).toBe(202);
    expect(mockActivityUpdateMany).toHaveBeenCalledTimes(3);
    expect(mockActivityUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        severity: 'ERROR',
        metadata: expect.objectContaining({
          result: 'failed',
          terminalState: 'unavailable',
          terminalReason: 'image-missing',
        }),
      },
    }));
    expect(mockActivityCreate).toHaveBeenCalledTimes(1);
    expect(mockLaunchProjectRuntimeImageRepair).toHaveBeenCalledWith({ allowFailedRetry: false });
  });

  test('settles an explicit failed generation before admitting the next repair', async () => {
    mockGetProjectRuntimeImageRepairStatus.mockResolvedValueOnce({
      state: 'failed',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    mockLaunchProjectRuntimeImageRepair.mockResolvedValueOnce({ state: 'running', started: true });

    const response = await invokeRepair();

    expect(response.statusCode).toBe(202);
    expect(mockActivityUpdateMany).toHaveBeenCalledTimes(3);
    expect(mockActivityCreate).toHaveBeenCalledTimes(1);
    expect(mockLaunchProjectRuntimeImageRepair).toHaveBeenCalledTimes(1);
    expect(mockActivityUpdateMany.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mockActivityCreate.mock.invocationCallOrder[0]);
  });

  test('serializes complete repair admissions across a failed-generation retry', async () => {
    let releaseFirstLaunch!: (value: { state: 'running'; started: true }) => void;
    const firstLaunch = new Promise<{ state: 'running'; started: true }>((resolve) => {
      releaseFirstLaunch = resolve;
    });
    mockGetProjectRuntimeImageRepairStatus
      .mockReset()
      .mockResolvedValueOnce({
        state: 'failed',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      })
      .mockResolvedValueOnce({
        state: 'running',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      });
    mockActivityCreate
      .mockResolvedValueOnce({ id: 'audit-first' })
      .mockResolvedValueOnce({ id: 'audit-second' });
    mockLaunchProjectRuntimeImageRepair
      .mockImplementationOnce(() => firstLaunch)
      .mockResolvedValueOnce({ state: 'running', started: false });

    const first = invokeRepair();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLaunchProjectRuntimeImageRepair).toHaveBeenCalledTimes(1);

    const second = invokeRepair();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockGetProjectRuntimeImageRepairStatus).toHaveBeenCalledTimes(1);
    expect(mockActivityCreate).toHaveBeenCalledTimes(1);
    expect(mockLaunchProjectRuntimeImageRepair).toHaveBeenCalledTimes(1);

    releaseFirstLaunch({ state: 'running', started: true });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);
    expect(mockGetProjectRuntimeImageRepairStatus).toHaveBeenCalledTimes(2);
    expect(mockActivityCreate).toHaveBeenCalledTimes(2);
    expect(mockLaunchProjectRuntimeImageRepair).toHaveBeenNthCalledWith(1, { allowFailedRetry: true });
    expect(mockLaunchProjectRuntimeImageRepair).toHaveBeenNthCalledWith(2, { allowFailedRetry: false });
  });

  test('retains an attributable launch-failed audit result when unit registration fails', async () => {
    mockLaunchProjectRuntimeImageRepair.mockRejectedValueOnce(
      new ProjectRuntimeImageRepairLaunchError(
        'Portal could not start the Project runtime image repair.',
        500,
        'PROJECT_RUNTIME_IMAGE_REPAIR_LAUNCH_FAILED',
      ),
    );

    const response = await invokeRepair();

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_LAUNCH_FAILED',
    });
    expect(mockActivityUpdate).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      data: {
        severity: 'ERROR',
        metadata: {
          feature: 'projectRuntimeImage',
          admissionResult: 'requested',
          result: 'launch-failed',
          terminalState: 'launch-failed',
          completedAt: expect.any(String),
        },
      },
    });
  });

  test('keeps an indeterminate registration audit pending for status reconciliation', async () => {
    mockLaunchProjectRuntimeImageRepair.mockRejectedValueOnce(
      new ProjectRuntimeImageRepairLaunchError(
        'Portal could not confirm whether registration completed.',
        409,
        'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      ),
    );

    const response = await invokeRepair();

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
    });
    expect(mockActivityCreate).toHaveBeenCalledTimes(1);
    expect(mockActivityUpdate).not.toHaveBeenCalled();
  });

  test.each([
    [{ state: 'running', started: true }, 202, 'started'],
    [{ state: 'running', started: false }, 202, 'already-running'],
    [{ state: 'ready', started: false }, 200, 'succeeded'],
    [{ state: 'ready', started: true }, 200, 'succeeded'],
  ] as const)('records the accepted repair result %#', async (result, statusCode, auditResult) => {
    mockLaunchProjectRuntimeImageRepair.mockResolvedValueOnce(result);

    const response = await invokeRepair();

    expect(response.statusCode).toBe(statusCode);
    expect(response.body).toMatchObject({ ok: true, ...result });
    expect(mockActivityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-1',
        action: 'PROJECT_RUNTIME_IMAGE_REPAIR_REQUESTED',
        severity: 'WARNING',
        metadata: { feature: 'projectRuntimeImage', result: 'requested' },
      }),
    });
    expect(mockActivityUpdate).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      data: result.state === 'ready'
        ? {
            severity: 'INFO',
            metadata: {
              feature: 'projectRuntimeImage',
              admissionResult: result.started ? 'started' : 'requested',
              result: auditResult,
              terminalState: 'ready',
              completedAt: expect.any(String),
            },
          }
        : { metadata: { feature: 'projectRuntimeImage', result: auditResult } },
    });
  });

  test.each([
    ['ready', 'succeeded', 'INFO'],
    ['failed', 'failed', 'ERROR'],
  ] as const)('reconciles pending durable audits when status becomes %s', async (
    state,
    result,
    severity,
  ) => {
    mockGetProjectRuntimeImageRepairStatus.mockResolvedValueOnce({
      state,
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    const response = await invokeStatus();

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ state });
    expect(mockActivityUpdateMany).toHaveBeenCalledTimes(3);
    expect(mockActivityUpdateMany).toHaveBeenCalledWith({
      where: {
        action: 'PROJECT_RUNTIME_IMAGE_REPAIR_REQUESTED',
        resource: 'system-remediation',
        resourceId: 'projectRuntimeImage',
        AND: [
          { metadata: { path: ['feature'], equals: 'projectRuntimeImage' } },
          { metadata: { path: ['result'], equals: 'started' } },
        ],
      },
      data: {
        severity,
        metadata: expect.objectContaining({
          feature: 'projectRuntimeImage',
          admissionResult: 'started',
          result,
          terminalState: state,
          completedAt: expect.any(String),
        }),
      },
    });
  });

  test.each(['running', 'unavailable'] as const)(
    'does not terminalize audit rows while status is %s',
    async (state) => {
    mockGetProjectRuntimeImageRepairStatus.mockResolvedValueOnce({
      state,
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });

    const response = await invokeStatus();

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ state });
    expect(mockActivityUpdateMany).not.toHaveBeenCalled();
    },
  );
});
