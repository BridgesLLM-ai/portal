import { AsyncLocalStorage } from 'async_hooks';

export const OLLAMA_AUTHORITY_BUSY_CODE = 'OLLAMA_AUTHORITY_BUSY' as const;
export const OLLAMA_AUTHORITY_BUSY_MESSAGE =
  'The Ollama backend authority is changing or in use. Retry shortly.';

export class OllamaAuthorityBarrierBusyError extends Error {
  readonly code = OLLAMA_AUTHORITY_BUSY_CODE;
  readonly httpStatus = 409;
  readonly statusCode = 409;

  constructor() {
    super(OLLAMA_AUTHORITY_BUSY_MESSAGE);
    this.name = 'OllamaAuthorityBarrierBusyError';
  }

  toJSON(): Readonly<{
    name: 'OllamaAuthorityBarrierBusyError';
    code: typeof OLLAMA_AUTHORITY_BUSY_CODE;
    message: typeof OLLAMA_AUTHORITY_BUSY_MESSAGE;
    statusCode: 409;
  }> {
    return Object.freeze({
      name: 'OllamaAuthorityBarrierBusyError' as const,
      code: this.code,
      message: OLLAMA_AUTHORITY_BUSY_MESSAGE,
      statusCode: 409 as const,
    });
  }
}

type OllamaAuthorityOperation<T> = () => T | PromiseLike<T>;

export interface OllamaAuthorityBarrier {
  withRunLease<T>(operation: OllamaAuthorityOperation<T>): Promise<T>;
  withMutationFence<T>(operation: OllamaAuthorityOperation<T>): Promise<T>;
  deferMutationUntilRunsSettle<T>(operation: OllamaAuthorityOperation<T>): Promise<T>;
}

interface ActiveMutationScope {
  readonly token: symbol;
  readonly pendingNestedOperations: Set<Promise<unknown>>;
  nestedFailure: unknown;
  hasNestedFailure: boolean;
}

function settleWithExactRelease<T>(
  operation: OllamaAuthorityOperation<T>,
  release: () => void,
): Promise<T> {
  let result: T | PromiseLike<T>;
  try {
    result = operation();
  } catch (error) {
    release();
    return Promise.reject(error);
  }
  return Promise.resolve(result).then(
    (value) => {
      release();
      return value;
    },
    (error) => {
      release();
      throw error;
    },
  );
}

export function createOllamaAuthorityBarrier(): OllamaAuthorityBarrier {
  let activeRuns = 0;
  let mutationFenced = false;
  let mutationPending = false;
  let activeMutationToken: symbol | null = null;
  const mutationContext = new AsyncLocalStorage<ActiveMutationScope>();
  const pendingMutations: Array<{
    operation: OllamaAuthorityOperation<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  const activeMutationScope = (): ActiveMutationScope | null => {
    const scope = mutationContext.getStore();
    if (!scope) return null;
    if (activeMutationToken !== null && scope.token === activeMutationToken) return scope;
    // AsyncLocalStorage also propagates into detached callbacks. Once their
    // originating fence has settled they may not silently reacquire authority
    // as a fresh operation with stale captured state.
    throw new OllamaAuthorityBarrierBusyError();
  };

  const trackNestedOperation = <T>(
    scope: ActiveMutationScope,
    operation: OllamaAuthorityOperation<T>,
  ): Promise<T> => {
    const pending = settleWithExactRelease(operation, () => undefined);
    scope.pendingNestedOperations.add(pending);
    // Observe every nested settlement even when its immediate caller forgets
    // to await it. The outer fence owns its lifetime and surfaces its first
    // failure instead of reopening admission underneath detached work.
    void pending.then(
      () => {
        scope.pendingNestedOperations.delete(pending);
      },
      (error) => {
        scope.pendingNestedOperations.delete(pending);
        if (!scope.hasNestedFailure) {
          scope.hasNestedFailure = true;
          scope.nestedFailure = error;
        }
      },
    );
    return pending;
  };

  const startMutationFence = (): { release: () => void; token: symbol } => {
    mutationFenced = true;
    const token = Symbol('ollama-authority-mutation');
    activeMutationToken = token;
    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        if (activeMutationToken === token) activeMutationToken = null;
        mutationFenced = false;
      },
    };
  };

  const executeMutationScope = <T>(
    token: symbol,
    release: () => void,
    operation: OllamaAuthorityOperation<T>,
  ): Promise<T> => {
    const scope: ActiveMutationScope = {
      token,
      pendingNestedOperations: new Set(),
      nestedFailure: undefined,
      hasNestedFailure: false,
    };
    return mutationContext.run(
      scope,
      async () => {
        let value!: T;
        let rootFailure: unknown;
        let hasRootFailure = false;
        try {
          try {
            value = await operation();
          } catch (error) {
            hasRootFailure = true;
            rootFailure = error;
          }
          while (scope.pendingNestedOperations.size > 0) {
            await Promise.allSettled([...scope.pendingNestedOperations]);
          }
          if (hasRootFailure) throw rootFailure;
          if (scope.hasNestedFailure) throw scope.nestedFailure;
          return value;
        } finally {
          // Reopen admission only after both the root mutation and every
          // nested authority helper from this exact context have settled.
          release();
        }
      },
    );
  };

  function drainPendingMutations(): void {
    if (activeRuns > 0 || mutationFenced) return;
    const pending = pendingMutations.shift();
    if (!pending) {
      mutationPending = false;
      return;
    }
    const { release, token } = startMutationFence();
    void executeMutationScope(
      token,
      release,
      pending.operation,
    ).then(
      (value) => {
        pending.resolve(value);
        drainPendingMutations();
      },
      (error) => {
        // A failed deferred mutation is an unresolved revocation. Keep the
        // pending latch closed rather than admitting work against uncertain
        // authority state.
        pending.reject(error);
      },
    );
  }

  const acquireRunLease = (): (() => void) => {
    if (mutationFenced || mutationPending) throw new OllamaAuthorityBarrierBusyError();
    activeRuns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRuns -= 1;
      drainPendingMutations();
    };
  };

  const acquireMutationFence = (): { release: () => void; token: symbol } => {
    if (mutationFenced || mutationPending || activeRuns > 0) {
      throw new OllamaAuthorityBarrierBusyError();
    }
    return startMutationFence();
  };

  return Object.freeze({
    withRunLease<T>(operation: OllamaAuthorityOperation<T>): Promise<T> {
      try {
        const scope = activeMutationScope();
        if (scope) return trackNestedOperation(scope, operation);
        const release = acquireRunLease();
        return settleWithExactRelease(operation, release);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    withMutationFence<T>(operation: OllamaAuthorityOperation<T>): Promise<T> {
      try {
        const inheritedScope = activeMutationScope();
        if (inheritedScope) return trackNestedOperation(inheritedScope, operation);
        const { release, token } = acquireMutationFence();
        return executeMutationScope(token, release, operation).finally(drainPendingMutations);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    deferMutationUntilRunsSettle<T>(operation: OllamaAuthorityOperation<T>): Promise<T> {
      mutationPending = true;
      const pending = new Promise<T>((resolve, reject) => {
        pendingMutations.push({
          operation: operation as OllamaAuthorityOperation<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
      drainPendingMutations();
      return pending;
    },
  });
}

const processOllamaAuthorityBarrier = createOllamaAuthorityBarrier();

export function withOllamaAuthorityRunLease<T>(
  operation: OllamaAuthorityOperation<T>,
): Promise<T> {
  return processOllamaAuthorityBarrier.withRunLease(operation);
}

export function withOllamaAuthorityMutationFence<T>(
  operation: OllamaAuthorityOperation<T>,
): Promise<T> {
  return processOllamaAuthorityBarrier.withMutationFence(operation);
}

export function deferOllamaAuthorityMutationUntilRunsSettle<T>(
  operation: OllamaAuthorityOperation<T>,
): Promise<T> {
  return processOllamaAuthorityBarrier.deferMutationUntilRunsSettle(operation);
}
