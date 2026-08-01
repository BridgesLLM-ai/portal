import {
  createOllamaAuthorityBarrier,
  OLLAMA_AUTHORITY_BUSY_CODE,
  OLLAMA_AUTHORITY_BUSY_MESSAGE,
  OllamaAuthorityBarrierBusyError,
} from './ollamaAuthorityBarrier';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Ollama authority barrier', () => {
  test('admits run leases synchronously and holds them until exact settlement', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstRun = barrier.withRunLease(() => first.promise);
    const secondRun = barrier.withRunLease(() => second.promise);
    const mutation = jest.fn(async () => 'mutated');

    await expect(barrier.withMutationFence(mutation)).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');
    await expect(barrier.withMutationFence(mutation)).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
    await expect(barrier.withMutationFence(mutation)).resolves.toBe('mutated');
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  test('an exclusive mutation blocks new runs and concurrent mutations until settlement', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const pending = deferred<void>();
    const mutation = barrier.withMutationFence(() => pending.promise);
    const run = jest.fn(async () => 'ran');
    const nextMutation = jest.fn(async () => 'mutated');

    await expect(barrier.withRunLease(run)).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    await expect(barrier.withMutationFence(nextMutation)).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    expect(run).not.toHaveBeenCalled();
    expect(nextMutation).not.toHaveBeenCalled();

    pending.resolve();
    await mutation;
    await expect(barrier.withRunLease(run)).resolves.toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('a deferred revocation blocks new admissions before waiting for existing runs', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const existing = deferred<void>();
    const existingRun = barrier.withRunLease(() => existing.promise);
    const mutation = jest.fn(async () => 'disconnected');
    const deferredMutation = barrier.deferMutationUntilRunsSettle(mutation);
    const rejectedRun = jest.fn(async () => 'unsafe');

    await expect(barrier.withRunLease(rejectedRun)).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    await expect(barrier.withMutationFence(async () => 'overtook-pending'))
      .rejects.toMatchObject({
        code: OLLAMA_AUTHORITY_BUSY_CODE,
        statusCode: 409,
      });
    expect(rejectedRun).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();

    existing.resolve();
    await existingRun;
    await expect(deferredMutation).resolves.toBe('disconnected');
    expect(mutation).toHaveBeenCalledTimes(1);
    await expect(barrier.withRunLease(async () => 'safe')).resolves.toBe('safe');
  });

  test('an exclusive mutation may use authority request helpers without opening the fence', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const nestedRun = jest.fn(async () => 'nested-run');
    const nestedMutation = jest.fn(async () => 'nested-mutation');

    await expect(barrier.withMutationFence(async () => ({
      run: await barrier.withRunLease(nestedRun),
      mutation: await barrier.withMutationFence(nestedMutation),
    }))).resolves.toEqual({
      run: 'nested-run',
      mutation: 'nested-mutation',
    });
    expect(nestedRun).toHaveBeenCalledTimes(1);
    expect(nestedMutation).toHaveBeenCalledTimes(1);
  });

  test('an unawaited nested authority mutation keeps the outer fence closed until settlement', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const nestedSettlement = deferred<void>();
    let nested!: Promise<void>;
    let outerSettled = false;
    const outer = barrier.withMutationFence(async () => {
      nested = barrier.withMutationFence(() => nestedSettlement.promise);
      return 'outer-complete';
    }).finally(() => {
      outerSettled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outerSettled).toBe(false);
    await expect(barrier.withRunLease(async () => 'unsafe')).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });

    nestedSettlement.resolve();
    await expect(nested).resolves.toBeUndefined();
    await expect(outer).resolves.toBe('outer-complete');
    await expect(barrier.withRunLease(async () => 'safe')).resolves.toBe('safe');
  });

  test('an unawaited nested run helper also remains owned by the outer mutation fence', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const nestedSettlement = deferred<void>();
    let nested!: Promise<void>;
    const outer = barrier.withMutationFence(async () => {
      nested = barrier.withRunLease(() => nestedSettlement.promise);
      return 'outer-complete';
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(barrier.withRunLease(async () => 'unsafe')).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    nestedSettlement.resolve();
    await nested;
    await expect(outer).resolves.toBe('outer-complete');
  });

  test('a revocation scheduled inside a mutation remains fenced until its own settlement', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const finishOuter = deferred<void>();
    const finishRevocation = deferred<void>();
    const revocationStarted = jest.fn();
    let revocation!: Promise<void>;
    const outer = barrier.withMutationFence(async () => {
      revocation = barrier.deferMutationUntilRunsSettle(async () => {
        revocationStarted();
        await finishRevocation.promise;
      });
      await finishOuter.promise;
    });

    expect(revocationStarted).not.toHaveBeenCalled();
    finishOuter.resolve();
    await outer;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(revocationStarted).toHaveBeenCalledTimes(1);
    await expect(barrier.withRunLease(async () => 'unsafe')).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });

    finishRevocation.resolve();
    await revocation;
    await expect(barrier.withRunLease(async () => 'safe')).resolves.toBe('safe');
  });

  test('drains successful deferred mutations in FIFO order', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const active = deferred<void>();
    const activeRun = barrier.withRunLease(() => active.promise);
    const order: string[] = [];
    const first = barrier.deferMutationUntilRunsSettle(async () => {
      order.push('first');
      return 'first-settled';
    });
    const second = barrier.deferMutationUntilRunsSettle(async () => {
      order.push('second');
      return 'second-settled';
    });

    active.resolve();
    await activeRun;
    await expect(first).resolves.toBe('first-settled');
    await expect(second).resolves.toBe('second-settled');
    expect(order).toEqual(['first', 'second']);
    await expect(barrier.withRunLease(async () => 'recovered')).resolves.toBe('recovered');
  });

  test('keeps the admission latch closed when a deferred revocation rejects', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const active = deferred<void>();
    const activeRun = barrier.withRunLease(() => active.promise);
    const secondMutation = jest.fn(async () => 'unsafe');
    const first = barrier.deferMutationUntilRunsSettle(async () => {
      throw new Error('durable revocation rejected');
    });
    void barrier.deferMutationUntilRunsSettle(secondMutation);

    active.resolve();
    await activeRun;
    await expect(first).rejects.toThrow('durable revocation rejected');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondMutation).not.toHaveBeenCalled();
    await expect(barrier.withRunLease(async () => 'unsafe')).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
    await expect(barrier.withMutationFence(async () => 'unsafe')).rejects.toMatchObject({
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      statusCode: 409,
    });
  });

  test('releases both lease kinds after synchronous throws and async rejection', async () => {
    const barrier = createOllamaAuthorityBarrier();
    const failure = new Error('settled failure');

    await expect(barrier.withRunLease(() => {
      throw failure;
    })).rejects.toBe(failure);
    await expect(barrier.withMutationFence(async () => 'after-run-failure'))
      .resolves.toBe('after-run-failure');

    await expect(barrier.withMutationFence(() => Promise.reject(failure)))
      .rejects.toBe(failure);
    await expect(barrier.withRunLease(async () => 'after-mutation-failure'))
      .resolves.toBe('after-mutation-failure');
  });

  test('busy errors are fixed 409 payloads without barrier state', () => {
    const error = new OllamaAuthorityBarrierBusyError();
    expect(error.toJSON()).toEqual({
      name: 'OllamaAuthorityBarrierBusyError',
      code: OLLAMA_AUTHORITY_BUSY_CODE,
      message: OLLAMA_AUTHORITY_BUSY_MESSAGE,
      statusCode: 409,
    });
    expect(JSON.stringify(error)).not.toMatch(/activeRuns|mutationFenced|count/i);
  });
});
