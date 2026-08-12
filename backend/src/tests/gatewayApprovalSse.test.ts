import { EventEmitter } from 'events';
import gatewayRouter from '../routes/gateway';
import * as persistentGatewayWs from '../agents/providers/PersistentGatewayWs';
import * as nativeCliApprovals from '../agents/nativeCliApprovals';
import * as authorizationChangeBus from '../services/authorizationChangeBus';
import * as sessionRevocationBus from '../services/sessionRevocationBus';
import { prisma } from '../config/database';

const APPROVAL_STREAM_USER_ID = 'owner-approval-sse';
const APPROVAL_STREAM_SESSION_ID = 'durable-owner-approval-sse';

function approvalsStreamHandler(): (req: any, res: any) => void | Promise<void> {
  const layer = (gatewayRouter as any).stack.find(
    (entry: any) => entry.route?.path === '/approvals/stream',
  );
  if (!layer) throw new Error('gateway /approvals/stream route not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function approvalStreamRequest(): EventEmitter & { user: any } {
  const req = new EventEmitter() as EventEmitter & { user: any };
  req.user = {
    userId: APPROVAL_STREAM_USER_ID,
    sessionId: APPROVAL_STREAM_SESSION_ID,
    email: 'owner@example.com',
    role: 'OWNER',
    authorizationVersion: 1,
    exp: Math.floor((Date.now() + 30 * 60 * 1000) / 1000),
  };
  return req;
}

function approvalStreamResponse(write: jest.Mock = jest.fn()) {
  const res: any = {
    destroyed: false,
    socket: { setNoDelay: jest.fn() },
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write,
    flush: jest.fn(),
  };
  res.destroy = jest.fn(() => {
    res.destroyed = true;
  });
  return res;
}

describe('gateway approval SSE cleanup', () => {
  let durableAccessLookup: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(nativeCliApprovals, 'listPendingNativeCliApprovals').mockReturnValue([]);
    const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    durableAccessLookup = jest.spyOn(prisma.user as any, 'findUnique').mockImplementation(
      async (args: any) => ({
        id: APPROVAL_STREAM_USER_ID,
        email: 'owner@example.com',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: 1,
        sessions: args?.select?.sessions?.where?.id === APPROVAL_STREAM_SESSION_ID
          ? [{ id: APPROVAL_STREAM_SESSION_ID, expiresAt: sessionExpiresAt }]
          : [],
      }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('write failure after setup tears down every timer and subscription exactly once', async () => {
    const persistentRequestUnsubscribe = jest.fn();
    const persistentResolvedUnsubscribe = jest.fn();
    const nativeRequestUnsubscribe = jest.fn();
    const nativeResolvedUnsubscribe = jest.fn();
    const authorizationUnsubscribe = jest.fn();
    const sessionUnsubscribe = jest.fn();
    let emitPersistentRequest: ((approval: any) => void) | undefined;

    jest.spyOn(persistentGatewayWs, 'onApprovalRequest').mockImplementation((listener: any) => {
      emitPersistentRequest = listener;
      return persistentRequestUnsubscribe;
    });
    jest.spyOn(persistentGatewayWs, 'onApprovalResolved').mockImplementation(
      () => persistentResolvedUnsubscribe,
    );
    jest.spyOn(nativeCliApprovals, 'onNativeCliApprovalRequest').mockImplementation(
      () => nativeRequestUnsubscribe,
    );
    jest.spyOn(nativeCliApprovals, 'onNativeCliApprovalResolved').mockImplementation(
      () => nativeResolvedUnsubscribe,
    );
    jest.spyOn(authorizationChangeBus, 'subscribeToAuthorizationChanges').mockImplementation(
      () => authorizationUnsubscribe,
    );
    jest.spyOn(sessionRevocationBus, 'subscribeToSessionRevocations').mockImplementation(
      () => sessionUnsubscribe,
    );

    const req = approvalStreamRequest();
    const res = approvalStreamResponse();
    await approvalsStreamHandler()(req, res);

    // Durable access expiry and the SSE keepalive are both live until teardown.
    expect(jest.getTimerCount()).toBe(2);
    expect(emitPersistentRequest).toBeDefined();
    expect(durableAccessLookup).toHaveBeenCalledTimes(1);
    expect(durableAccessLookup).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: APPROVAL_STREAM_USER_ID },
      select: expect.objectContaining({
        sessions: expect.objectContaining({
          where: expect.objectContaining({ id: APPROVAL_STREAM_SESSION_ID }),
        }),
      }),
    }));

    res.write.mockImplementation(() => {
      throw new Error('socket write failed');
    });
    // The approval delivery path now performs asynchronous ownership checks
    // before writing. Drive the already-registered keepalive instead so this
    // cleanup test remains focused on a post-setup transport failure.
    jest.advanceTimersByTime(15_000);

    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(authorizationUnsubscribe).toHaveBeenCalledTimes(1);
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
    expect(persistentRequestUnsubscribe).toHaveBeenCalledTimes(1);
    expect(persistentResolvedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(nativeRequestUnsubscribe).toHaveBeenCalledTimes(1);
    expect(nativeResolvedUnsubscribe).toHaveBeenCalledTimes(1);

    req.emit('close');
    expect(authorizationUnsubscribe).toHaveBeenCalledTimes(1);
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
    expect(persistentRequestUnsubscribe).toHaveBeenCalledTimes(1);
    expect(persistentResolvedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(nativeRequestUnsubscribe).toHaveBeenCalledTimes(1);
    expect(nativeResolvedUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test('initial write failure retires access authority before registering approval subscriptions', async () => {
    const persistentRequestSpy = jest.spyOn(persistentGatewayWs, 'onApprovalRequest');
    const persistentResolvedSpy = jest.spyOn(persistentGatewayWs, 'onApprovalResolved');
    const nativeRequestSpy = jest.spyOn(nativeCliApprovals, 'onNativeCliApprovalRequest');
    const nativeResolvedSpy = jest.spyOn(nativeCliApprovals, 'onNativeCliApprovalResolved');
    const authorizationSpy = jest.spyOn(
      authorizationChangeBus,
      'subscribeToAuthorizationChanges',
    );
    const authorizationUnsubscribe = jest.fn();
    authorizationSpy.mockImplementation(() => authorizationUnsubscribe);
    const sessionUnsubscribe = jest.fn();
    const sessionSpy = jest.spyOn(
      sessionRevocationBus,
      'subscribeToSessionRevocations',
    ).mockImplementation(() => sessionUnsubscribe);
    const req = approvalStreamRequest();
    const res = approvalStreamResponse(jest.fn(() => {
      throw new Error('socket already closed');
    }));

    await approvalsStreamHandler()(req, res);

    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(durableAccessLookup).toHaveBeenCalledTimes(1);
    expect(persistentRequestSpy).not.toHaveBeenCalled();
    expect(persistentResolvedSpy).not.toHaveBeenCalled();
    expect(nativeRequestSpy).not.toHaveBeenCalled();
    expect(nativeResolvedSpy).not.toHaveBeenCalled();
    expect(authorizationSpy).toHaveBeenCalledTimes(1);
    expect(sessionSpy).toHaveBeenCalledTimes(1);
    expect(authorizationUnsubscribe).toHaveBeenCalledTimes(1);
    expect(sessionUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
