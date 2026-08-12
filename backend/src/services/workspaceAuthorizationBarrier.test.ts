import { EventEmitter } from 'events';
import {
  admitWorkspaceAuthorizationMutation,
  acquireWorkspaceAuthorizationMutationLease,
  admitWorkspaceAuthorizationRequest,
  closeGlobalWorkspaceAuthorizationAdmission,
  closeGlobalWorkspaceAuthorizationAdmissionExcludingRequest,
  closeWorkspaceAuthorizationAdmission,
  settleWorkspaceAuthorizationRequest,
  settleWorkspaceAuthorizationRequestIfResponseEnded,
  subscribeToGlobalWorkspaceAuthorizationFence,
  withGlobalWorkspaceAuthorizationFence,
  withWorkspaceAuthorizationFence,
  workspaceAuthorizationBarrierSnapshot,
} from './workspaceAuthorizationBarrier';

function request(method: string, path = '/api/files'): any {
  return { method, originalUrl: path, path };
}

function response(): any {
  const events = new EventEmitter();
  const res: any = {
    destroyed: false,
    statusCode: 200,
    body: undefined,
    once: events.once.bind(events),
    emit: events.emit.bind(events),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      events.emit('finish');
      return res;
    },
    end() {
      events.emit('finish');
      return res;
    },
    destroy() {
      res.destroyed = true;
      events.emit('close');
    },
  };
  return res;
}

describe('workspace authorization barrier', () => {
  test('aborts admitted reads before committing a scope change', async () => {
    const userId = 'barrier-read-user';
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(request('GET'), res, userId)).toBe(true);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toEqual({
      fenced: false,
      reads: 1,
      mutations: 0,
    });

    const operation = jest.fn(async () => 'committed');
    await expect(withWorkspaceAuthorizationFence(userId, operation)).resolves.toBe('committed');
    expect(res.destroyed).toBe(true);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toEqual({
      fenced: false,
      reads: 0,
      mutations: 0,
    });
  });

  test('holds the fence closed until an admitted old-scope mutation settles', async () => {
    const userId = 'barrier-mutation-user';
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(request('POST'), res, userId)).toBe(true);
    const operation = jest.fn(async () => 'committed');

    const fenced = withWorkspaceAuthorizationFence(userId, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(res.destroyed).toBe(false);
    const blocked = response();
    expect(admitWorkspaceAuthorizationRequest(request('POST'), blocked, userId)).toBe(false);

    res.emit('finish');
    await expect(fenced).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('does not treat a client disconnect as mutation settlement', async () => {
    const userId = 'barrier-disconnected-mutation-user';
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(request('POST'), res, userId)).toBe(true);
    res.destroy();
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toMatchObject({
      mutations: 1,
    });

    const operation = jest.fn(async () => 'committed');
    const fenced = withWorkspaceAuthorizationFence(userId, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    res.end();
    await expect(fenced).resolves.toBe('committed');
  });

  test('lets a disconnected long-lived handler release only from its settlement path', async () => {
    const userId = 'barrier-explicit-settlement-user';
    const req = request('POST', '/api/gateway/send');
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(req, res, userId)).toBe(true);
    res.destroy();

    const operation = jest.fn(async () => 'committed');
    const fenced = withWorkspaceAuthorizationFence(userId, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    settleWorkspaceAuthorizationRequest(req);
    settleWorkspaceAuthorizationRequest(req);
    await expect(fenced).resolves.toBe('committed');
  });

  test('lets asynchronous middleware explicitly settle after observing a disconnected mutation', async () => {
    const userId = 'barrier-ended-middleware-user';
    const req = request('POST', '/api/projects/example/chat/send');
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(req, res, userId)).toBe(true);
    res.destroy();

    const operation = jest.fn(async () => 'committed');
    const fenced = withWorkspaceAuthorizationFence(userId, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    expect(settleWorkspaceAuthorizationRequestIfResponseEnded(req, res)).toBe(true);
    await expect(fenced).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('classifies owner-scoped AI POST reads without blocking the authorization commit', async () => {
    const userId = 'barrier-ai-read-user';
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(
      request('POST', '/api/ai/analyze'),
      res,
      userId,
    )).toBe(true);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toMatchObject({
      reads: 1,
      mutations: 0,
    });

    await expect(withWorkspaceAuthorizationFence(userId, async () => 'committed'))
      .resolves.toBe('committed');
    expect(res.destroyed).toBe(true);
  });

  test('holds an isolated hosted-app mutation open through settlement', async () => {
    const userId = 'barrier-hosted-mutation-user';
    const res = response();
    expect(admitWorkspaceAuthorizationMutation(
      request('POST', '/hosted/example/api/update'),
      res,
      userId,
    )).toBe(true);

    const fenced = withWorkspaceAuthorizationFence(userId, async () => 'safe');
    await Promise.resolve();
    res.emit('finish');
    await expect(fenced).resolves.toBe('safe');
  });

  test('keeps a fire-and-forget workspace mutation fenced through durable settlement', async () => {
    const userId = 'barrier-provider-turn-user';
    const release = acquireWorkspaceAuthorizationMutationLease(userId);

    const fenced = withWorkspaceAuthorizationFence(userId, async () => 'safe');
    await Promise.resolve();
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toEqual({
      fenced: true,
      reads: 0,
      mutations: 1,
    });

    release();
    release();
    await expect(fenced).resolves.toBe('safe');
  });

  test('lets a transition close admission and signal a leased run before waiting for drain', async () => {
    const userId = 'barrier-two-phase-transition-user';
    const releaseRun = acquireWorkspaceAuthorizationMutationLease(userId);

    const fence = closeWorkspaceAuthorizationAdmission([userId]);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toEqual({
      fenced: true,
      reads: 0,
      mutations: 1,
    });

    let drained = false;
    const waitForDrain = fence.waitForMutationDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    const blocked = response();
    expect(admitWorkspaceAuthorizationRequest(request('POST'), blocked, userId)).toBe(false);

    // A durable transition can abort/quiesce the old run here. Its settlement
    // releases the mutation lease and allows the second phase to complete.
    releaseRun();
    await waitForDrain;
    expect(drained).toBe(true);

    fence.release();
    fence.release();
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toEqual({
      fenced: false,
      reads: 0,
      mutations: 0,
    });
  });

  test('rejects new workspace admission while the authorization commit owns the fence', async () => {
    const userId = 'barrier-fenced-user';
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fenced = withWorkspaceAuthorizationFence(userId, async () => pending);
    await Promise.resolve();

    const res = response();
    expect(admitWorkspaceAuthorizationRequest(request('GET', '/api/files/search'), res, userId))
      .toBe(false);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'WORKSPACE_SCOPE_CHANGED' });

    release();
    await fenced;
  });

  test('does not fence unrelated users', async () => {
    const firstUser = 'barrier-first-user';
    const secondUser = 'barrier-second-user';
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fenced = withWorkspaceAuthorizationFence(firstUser, async () => pending);
    await Promise.resolve();

    const res = response();
    expect(admitWorkspaceAuthorizationRequest(request('GET'), res, secondUser)).toBe(true);
    res.emit('finish');
    release();
    await fenced;
  });

  test('globally fences ownership topology changes across every user', async () => {
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(request('GET'), res, 'topology-user')).toBe(true);

    await expect(withGlobalWorkspaceAuthorizationFence(async () => 'transferred'))
      .resolves.toBe('transferred');
    expect(res.destroyed).toBe(true);

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fenced = withGlobalWorkspaceAuthorizationFence(async () => pending);
    await Promise.resolve();
    const blocked = response();
    expect(admitWorkspaceAuthorizationRequest(request('GET'), blocked, 'new-user-during-transfer'))
      .toBe(false);
    expect(blocked.statusCode).toBe(409);
    release();
    await fenced;
  });

  test('keeps exact Owner dependency-repair discovery and controls reachable under the global fence', () => {
    const fence = closeGlobalWorkspaceAuthorizationAdmission();
    try {
      for (const [method, pathname] of [
        ['GET', '/api/projects/dependency-repair/active'],
        ['GET', '/api/projects/dependency-repair/active/'],
        ['GET', '/API/PROJECTS/DEPENDENCY-REPAIR/ACTIVE'],
        ['GET', '/api/projects/Example/dependency-repair/status'],
        ['GET', '/api/projects/Example/dependency-repair/status/'],
        ['GET', '/API/PROJECTS/Example/DEPENDENCY-REPAIR/STATUS'],
        ['POST', '/api/projects/Example/dependency-repair/force-forward'],
        ['POST', '/api/projects/Example/dependency-repair/force-forward/'],
        ['POST', '/API/PROJECTS/Example/DEPENDENCY-REPAIR/FORCE-FORWARD'],
      ]) {
        const res = response();
        expect(admitWorkspaceAuthorizationRequest(
          request(method, pathname),
          res,
          'repair-owner',
        )).toBe(true);
        expect(res.statusCode).toBe(200);
      }
      for (const [method, pathname] of [
        ['GET', '/api/projects'],
        ['POST', '/api/projects/dependency-repair/active'],
        ['POST', '/api/projects/Example/dependency-repair/status'],
        ['GET', '/api/projects/Example/dependency-repair/force-forward'],
        ['GET', '/api/projects/dependency-repair/active/deeper'],
        ['GET', '/api/projects/Example/dependency-repair/status/deeper'],
        ['POST', '/api/projects/Example/dependency-repair/force-forward/deeper'],
      ]) {
        const blocked = response();
        expect(admitWorkspaceAuthorizationRequest(
          request(method, pathname),
          blocked,
          'repair-owner',
        )).toBe(false);
        expect(blocked.statusCode).toBe(409);
      }
    } finally {
      fence.release();
    }
  });

  test('lets a durable global transition quiesce old work before awaiting drain', async () => {
    const releaseFirst = acquireWorkspaceAuthorizationMutationLease('global-first-user');
    const releaseSecond = acquireWorkspaceAuthorizationMutationLease('global-second-user');
    const fence = closeGlobalWorkspaceAuthorizationAdmission();

    const blocked = response();
    expect(admitWorkspaceAuthorizationRequest(
      request('POST', '/api/projects/new-project'),
      blocked,
      'user-created-after-transition',
    )).toBe(false);

    let drained = false;
    const wait = fence.waitForMutationDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirst();
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseSecond();
    await wait;
    expect(drained).toBe(true);

    fence.release();
    const admitted = response();
    expect(admitWorkspaceAuthorizationRequest(
      request('POST', '/api/projects/reopened'),
      admitted,
      'user-created-after-transition',
    )).toBe(true);
    admitted.emit('finish');
  });

  test('closes globally before excluding the exact promotion coordinator from its own drain', async () => {
    const req = request('POST', '/api/projects/Example/install-deps');
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(req, res, 'promotion-coordinator')).toBe(true);
    const releaseOther = acquireWorkspaceAuthorizationMutationLease('other-writer');
    const observedDuringClose: Array<{ mutations: number }> = [];
    const unsubscribe = subscribeToGlobalWorkspaceAuthorizationFence(() => {
      observedDuringClose.push(workspaceAuthorizationBarrierSnapshot('promotion-coordinator'));
    });

    const fence = closeGlobalWorkspaceAuthorizationAdmissionExcludingRequest(req);

    expect(observedDuringClose).toEqual([expect.objectContaining({ mutations: 1 })]);
    expect(workspaceAuthorizationBarrierSnapshot('promotion-coordinator')).toMatchObject({
      mutations: 0,
    });
    let drained = false;
    const wait = fence.waitForMutationDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    const blocked = response();
    expect(admitWorkspaceAuthorizationRequest(
      request('POST', '/api/projects/Other/install-deps'),
      blocked,
      'new-writer',
    )).toBe(false);

    releaseOther();
    await wait;
    expect(drained).toBe(true);
    fence.release();
    unsubscribe();
  });

  test('synchronously revokes subscribers that attach after the global fence closed', () => {
    const fence = closeGlobalWorkspaceAuthorizationAdmission();
    const revoked = jest.fn();

    const unsubscribe = subscribeToGlobalWorkspaceAuthorizationFence(revoked);

    expect(revoked).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    fence.release();
  });

  test('synchronously revokes every live subscriber when the global fence closes', () => {
    const first = jest.fn();
    const second = jest.fn(() => {
      throw new Error('transport teardown failed');
    });
    const unsubscribeFirst = subscribeToGlobalWorkspaceAuthorizationFence(first);
    const unsubscribeSecond = subscribeToGlobalWorkspaceAuthorizationFence(second);

    const fence = closeGlobalWorkspaceAuthorizationAdmission();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    fence.release();
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test('closes the subscribe-versus-fence race across repeated fence generations', () => {
    const revoked = jest.fn();
    const unsubscribe = subscribeToGlobalWorkspaceAuthorizationFence(revoked);

    const firstFence = closeGlobalWorkspaceAuthorizationAdmission();
    expect(revoked).toHaveBeenCalledTimes(1);
    firstFence.release();

    const secondFence = closeGlobalWorkspaceAuthorizationAdmission();
    expect(revoked).toHaveBeenCalledTimes(2);
    secondFence.release();
    unsubscribe();
  });

  test('treats project GET handlers as mutation-capable because they converge durable state', async () => {
    const userId = 'project-get-mutation-user';
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(
      request('GET', '/api/projects/example/chat/providers'),
      res,
      userId,
    )).toBe(true);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toMatchObject({
      reads: 0,
      mutations: 1,
    });

    const fenced = withWorkspaceAuthorizationFence(userId, async () => 'safe');
    await Promise.resolve();
    res.emit('finish');
    await expect(fenced).resolves.toBe('safe');
  });

  test('fences every Gateway control mutation and aborts passive Gateway reads', async () => {
    const userId = 'gateway-operation-user';
    const sendResponse = response();
    const approvalResponse = response();
    expect(admitWorkspaceAuthorizationRequest(
      request('POST', '/api/gateway/send'),
      sendResponse,
      userId,
    )).toBe(true);
    expect(admitWorkspaceAuthorizationRequest(
      request('GET', '/api/gateway/approvals/stream'),
      approvalResponse,
      userId,
    )).toBe(true);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toEqual({
      fenced: false,
      reads: 1,
      mutations: 1,
    });

    const fenced = withWorkspaceAuthorizationFence(userId, async () => 'safe');
    await Promise.resolve();
    expect(approvalResponse.destroyed).toBe(true);
    sendResponse.emit('finish');
    await expect(fenced).resolves.toBe('safe');
  });

  test.each([
    ['POST', '/api/gateway/session-create'],
    ['POST', '/api/gateway/session-model'],
    ['POST', '/api/gateway/session-patch'],
    ['POST', '/api/gateway/chat/abort'],
    ['POST', '/api/gateway/restart'],
    ['POST', '/api/gateway/reconnect'],
    ['POST', '/api/gateway/compatibility-hotfix/apply'],
    ['POST', '/api/gateway/config-path'],
    ['POST', '/api/ai-setup/restart-gateway'],
    ['GET', '/api/ai-setup/native-cli/status/session-1'],
    ['POST', '/api/remote-desktop/auto-setup'],
    ['GET', '/api/remote-desktop/status'],
    ['GET', '/api/gateway/health'],
    ['GET', '/api/gateway/session-info'],
    ['GET', '/api/gateway/history'],
    ['GET', '/api/gateway/stream-status'],
  ])('treats %s %s as a Gateway authorization mutation', (method, path) => {
    const userId = `gateway-mutation-${method}-${path}`;
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(
      request(method, path),
      res,
      userId,
    )).toBe(true);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toMatchObject({
      reads: 0,
      mutations: 1,
    });
    res.emit('finish');
  });

  test.each([
    ['GET', '/api/gateway/status'],
    ['GET', '/api/gateway/providers'],
    ['GET', '/api/gateway/models'],
    ['GET', '/api/gateway/sessions'],
    ['GET', '/api/gateway/approvals/stream'],
  ])('treats %s %s as an abortable Gateway read', (method, path) => {
    const userId = `gateway-read-${method}-${path}`;
    const res = response();
    expect(admitWorkspaceAuthorizationRequest(
      request(method, path),
      res,
      userId,
    )).toBe(true);
    expect(workspaceAuthorizationBarrierSnapshot(userId)).toMatchObject({
      reads: 1,
      mutations: 0,
    });
    res.emit('finish');
  });
});
