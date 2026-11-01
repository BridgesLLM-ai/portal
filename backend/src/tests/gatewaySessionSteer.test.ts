const assertOpenClawExecutionAdmittedMock = jest.fn();

jest.mock('../services/openClawExecutionAdmission', () => ({
  ...jest.requireActual('../services/openClawExecutionAdmission'),
  assertOpenClawExecutionAdmitted: assertOpenClawExecutionAdmittedMock,
}));

import gatewayRouter from '../routes/gateway';
import * as persistentGatewayWs from '../agents/providers/PersistentGatewayWs';
import { prisma } from '../config/database';
import { OpenClawExecutionAdmissionError } from '../services/openClawExecutionAdmission';

const userId = '00000000-0000-4000-8000-000000000001';
const sessionKey = `agent:main:portal-${userId}-chat`;

function routeHandler(route = '/session-steer'): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === route);
  if (!layer) throw new Error('gateway /session-steer route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseDouble() {
  const response: any = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('Agent Chat exact-run steering route', () => {
  beforeEach(() => {
    assertOpenClawExecutionAdmittedMock.mockReset().mockResolvedValue({
      state: 'ready',
      ready: true,
    });
    jest.spyOn(prisma.agentSession, 'findFirst').mockResolvedValue({
      id: 'owned-steer-session',
      userId,
    } as any);
    jest.spyOn(prisma.agentSession, 'update').mockResolvedValue({} as any);
    for (const delegate of [
      prisma.projectChatProviderBinding,
      prisma.projectChatSession,
      prisma.projectChatMessage,
      prisma.projectChatTurn,
      prisma.legacyOpenClawProjectImport,
      prisma.legacyOpenClawProjectQuarantine,
    ] as any[]) {
      jest.spyOn(delegate, 'findFirst').mockResolvedValue(null);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(['/session-steer', '/answer-user-input', '/chat/inject'])('refuses photo markers on the text-only %s lane', async route => {
    const response = responseDouble();
    const photo = '[portal-chat-image:{"fileId":"11111111-1111-4111-8111-111111111111","revision":"2026-10-20T12:00:00.000Z"}]';
    await routeHandler(route)({ body: { session: sessionKey, expectedRunId: 'run-r1', runId: 'run-r1',
      requestId: 'r1', message: photo, text: photo }, user: { userId, role: 'OWNER' } }, response);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IMAGE_NEW_TURN_REQUIRED' }));
    expect(assertOpenClawExecutionAdmittedMock).not.toHaveBeenCalled();
  });

  test('requires the browser-observed run identity', async () => {
    const steer = jest.spyOn(persistentGatewayWs, 'steerSessionMessage');
    const response = responseDouble();

    await routeHandler()({
      body: {
        session: sessionKey,
        message: 'Keep investigating.',
        requestId: 'steer-r1',
      },
      user: { userId, role: 'OWNER' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'message and expectedRunId are required',
    });
    expect(steer).not.toHaveBeenCalled();
    expect(assertOpenClawExecutionAdmittedMock).not.toHaveBeenCalled();
  });

  test('steers the exact active run after positive OpenClaw execution admission', async () => {
    const steer = jest.spyOn(persistentGatewayWs, 'steerSessionMessage').mockResolvedValue({
      mode: 'exact-run',
      interruptedActiveRun: false,
      replayed: false,
      requestId: 'steer-r1',
      runId: 'run-r1',
    });
    const response = responseDouble();

    await routeHandler()({
      body: {
        session: sessionKey,
        expectedRunId: 'run-r1',
        message: 'Keep investigating.',
        requestId: 'steer-r1',
      },
      user: { userId, role: 'OWNER' },
    }, response);

    expect(assertOpenClawExecutionAdmittedMock).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(
      sessionKey,
      'run-r1',
      'Keep investigating.',
      'steer-r1',
      true, // an Owner keeps OpenClaw chat-command authority
    );
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      ok: true,
      sessionKey,
      mode: 'exact-run',
      interruptedActiveRun: false,
      replayed: false,
      requestId: 'steer-r1',
      runId: 'run-r1',
    });
  });

  test('reports stock chat.send steering as unconfirmed, without claiming the observed run', async () => {
    jest.spyOn(persistentGatewayWs, 'steerSessionMessage').mockResolvedValue({
      mode: 'native-steer',
      outcome: 'unconfirmed',
      interruptedActiveRun: false,
      replayed: false,
      requestId: 'steer-r2',
      steerRunId: 'oc-run-r2',
    });
    const response = responseDouble();

    await routeHandler()({
      body: {
        session: sessionKey,
        expectedRunId: 'run-r1',
        message: 'Use the newer file.',
        requestId: 'steer-r2',
      },
      user: { userId, role: 'OWNER' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ ok: true, mode: 'native-steer', outcome: 'unconfirmed', steerRunId: 'oc-run-r2' });
    expect(body).not.toHaveProperty('runId');
  });

  test('fails closed before steering while supervised maintenance is active', async () => {
    assertOpenClawExecutionAdmittedMock.mockRejectedValueOnce(
      new OpenClawExecutionAdmissionError({
        state: 'maintenance',
        ready: false,
        reason: 'OpenClaw execution is paused while supervised host maintenance is active.',
        checkedAt: '2026-08-22T21:00:00.000Z',
        evidence: {
          authorizationFence: 'absent',
          maintenanceMarker: 'present',
          hostMutationJournal: 'absent',
        },
        readinessBlockers: [],
      }),
    );
    const steer = jest.spyOn(persistentGatewayWs, 'steerSessionMessage');
    const response = responseDouble();

    await routeHandler()({
      body: {
        session: sessionKey,
        expectedRunId: 'run-r1',
        message: 'Keep investigating.',
        requestId: 'steer-r1',
      },
      user: { userId, role: 'OWNER' },
    }, response);

    expect(steer).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'OPENCLAW_EXECUTION_MAINTENANCE',
      retryable: true,
    }));
  });
});
