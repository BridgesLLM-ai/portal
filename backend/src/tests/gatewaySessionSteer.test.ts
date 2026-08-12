import gatewayRouter from '../routes/gateway';
import * as persistentGatewayWs from '../agents/providers/PersistentGatewayWs';

const userId = '00000000-0000-4000-8000-000000000001';
const sessionKey = `agent:portal-${userId.slice(0, 8)}-test:portal-${userId}-chat`;

function routeHandler(): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/session-steer');
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
  afterEach(() => {
    jest.restoreAllMocks();
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
      user: { userId, role: 'USER' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'message and expectedRunId are required',
    });
    expect(steer).not.toHaveBeenCalled();
  });

  test('forwards R1 unchanged even when a replacement run is current by delivery time', async () => {
    const currentRunIdAtDelivery = 'run-r2';
    const steer = jest.spyOn(persistentGatewayWs, 'steerSessionMessage')
      .mockImplementation(async (_session, expectedRunId, _message, requestId) => {
        expect(currentRunIdAtDelivery).toBe('run-r2');
        expect(expectedRunId).toBe('run-r1');
        return {
          interruptedActiveRun: false,
          replayed: false,
          requestId: requestId!,
          runId: String(expectedRunId),
        };
      });
    const response = responseDouble();

    await routeHandler()({
      body: {
        session: sessionKey,
        expectedRunId: 'run-r1',
        message: 'Keep investigating.',
        requestId: 'steer-r1',
      },
      user: { userId, role: 'USER' },
    }, response);

    expect(steer).toHaveBeenCalledWith(
      sessionKey,
      'run-r1',
      'Keep investigating.',
      'steer-r1',
    );
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      ok: true,
      sessionKey,
      interruptedActiveRun: false,
      replayed: false,
      requestId: 'steer-r1',
      runId: 'run-r1',
    });
  });
});
