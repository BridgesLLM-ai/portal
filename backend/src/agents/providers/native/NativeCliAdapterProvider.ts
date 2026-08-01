import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  AgentMessage,
  AgentProvider,
  AgentProviderName,
  AgentSessionConfig,
  AgentSessionId,
  AgentSessionSummary,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
  SenderIdentity,
  AgentSendResult,
} from '../../AgentProvider.interface';
import { AgentAbortError } from '../../AgentProvider.interface';
import { requestNativeCliApproval } from '../../nativeCliApprovals';
import { isElevatedRole } from '../../../utils/authz';
import {
  appendNativeMessage,
  createNativeSession,
  deleteNativeSession,
  listNativeSessions,
  loadNativeSession,
  readAllNativeSessionHistory,
  updateNativeSessionMetadata,
  type NativeSessionData,
} from '../NativeSessionStore';
import type { NativeCliInvocation, NativeCliProviderAdapter, NativeCliTurnContext } from './types';
import { getProviderAvailability } from '../../providerAvailability';
import {
  getNativeProviderReadiness,
  recordNativeProviderAuthFailure,
  type NativeProviderReadiness,
} from '../../nativeProviderReadiness';
import { streamEventBus, type StreamEvent } from '../../../services/StreamEventBus';
import { buildNativeCliEnvironment } from './NativeCliEnvironment';
import {
  appendBoundedNativeDiagnostic,
  classifyNativeProviderError,
  NativeProviderDiagnosticError,
  sanitizeNativeProviderEvent,
  type NativeProviderErrorCode,
} from './NativeProviderDiagnostics';
import {
  assertExecutionContextBinding,
  assertProviderSupportsExecutionScope,
  executionContextsMatch,
} from '../../executionScope';
import { subscribeToAuthorizationChanges } from '../../../services/authorizationChangeBus';
import {
  activateGatedHostAgentRunAttempt,
  beginHostAgentRun,
  quarantineHostAgentRun,
  registerHostAgentRunAbort,
  reserveHostAgentRunAttempt,
  settleHostAgentRun,
  spawnGatedHostAgentRunAttempt,
  terminateHostAgentRunAttempt,
  type HostAgentRunHandle,
} from '../../../services/hostAgentRunJournal';

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

type NativeChildProcess = ReturnType<typeof spawn>;

interface NativeTurnAttempt {
  id: number;
  child: NativeChildProcess | null;
  detached: boolean;
  invocationPromise: Promise<NativeCliInvocation> | null;
  invocationAbortDeadlineTimer: ReturnType<typeof setTimeout> | null;
  onInvocationAbortDeadline: () => void;
  abortInvocation?: () => Promise<void | boolean>;
  abortPromise: Promise<boolean> | null;
  failure: unknown | null;
  terminal: boolean;
  terminationStarted: boolean;
  boundaryTerminationPromise: Promise<boolean> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  closeDeadlineTimer: ReturnType<typeof setTimeout> | null;
  onCloseDeadline: () => void;
  stdoutBuffer: string;
}

interface NativeActiveTurn {
  portalSessionId: AgentSessionId;
  runId: string;
  publishToHostBus: boolean;
  abortController: AbortController;
  aborted: boolean;
  abortPromise: Promise<boolean> | null;
  authoritativeAbortPromise: Promise<boolean> | null;
  cleanupConfirmed: boolean;
  quarantined: boolean;
  currentAttempt: NativeTurnAttempt | null;
  settlePromise: Promise<void> | null;
  completion: Promise<void>;
  resolveCompletion: () => void;
  requestAbortSettlement: () => Promise<void>;
  hostRunHandle: HostAgentRunHandle | null;
  unregisterHostRunAbort: (() => void) | null;
  unsubscribeAuthorization: (() => void) | null;
}

type NativeTurnOutcome =
  | { kind: 'success'; result: AgentSendResult; text: string }
  | { kind: 'abort' }
  | {
      kind: 'error';
      error: unknown;
      diagnostic?: string;
      fallbackCode?: NativeProviderErrorCode;
      persistAssistantError?: boolean;
    };

function isAbortError(error: unknown): boolean {
  return error instanceof AgentAbortError
    || (error instanceof Error && error.name === 'AbortError');
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AgentAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AgentAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const NATIVE_CHILD_SIGKILL_DELAY_MS = 3_000;
const NATIVE_CHILD_CLOSE_DEADLINE_MS = 5_000;
const NATIVE_INVOCATION_ABORT_WAIT_DEADLINE_MS = 5_000;
const NATIVE_PROVIDER_ABORT_DEADLINE_MS = 5_000;

function invokeAttemptAbort(attempt: NativeTurnAttempt): Promise<boolean> {
  if (attempt.abortPromise) return attempt.abortPromise;
  if (!attempt.abortInvocation) {
    attempt.abortPromise = Promise.resolve(true);
    return attempt.abortPromise;
  }
  attempt.abortPromise = new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(confirmed);
    };
    const timeout = setTimeout(() => finish(false), NATIVE_PROVIDER_ABORT_DEADLINE_MS);
    Promise.resolve()
      .then(() => attempt.abortInvocation!())
      .then((confirmed) => finish(confirmed !== false), () => finish(false));
  });
  return attempt.abortPromise;
}

function clearAttemptTerminationTimers(attempt: NativeTurnAttempt): void {
  if (attempt.killTimer) clearTimeout(attempt.killTimer);
  if (attempt.closeDeadlineTimer) clearTimeout(attempt.closeDeadlineTimer);
  attempt.killTimer = null;
  attempt.closeDeadlineTimer = null;
}

function clearInvocationAbortDeadline(attempt: NativeTurnAttempt): void {
  if (attempt.invocationAbortDeadlineTimer) clearTimeout(attempt.invocationAbortDeadlineTimer);
  attempt.invocationAbortDeadlineTimer = null;
}

function scheduleInvocationAbortDeadline(attempt: NativeTurnAttempt): void {
  if (attempt.invocationAbortDeadlineTimer || attempt.terminal) return;
  attempt.invocationAbortDeadlineTimer = setTimeout(() => {
    attempt.invocationAbortDeadlineTimer = null;
    if (attempt.terminal) return;
    attempt.onInvocationAbortDeadline();
  }, NATIVE_INVOCATION_ABORT_WAIT_DEADLINE_MS);
}

function signalAttempt(
  attempt: NativeTurnAttempt,
  hostRunHandle: HostAgentRunHandle | null,
  onBoundaryFailure: () => void,
): void {
  const child = attempt.child;
  if (!child || attempt.terminal) return;
  if (attempt.terminationStarted) return;
  attempt.terminationStarted = true;

  if (hostRunHandle) {
    // The ChildProcess is only the systemd-run streaming/exit transport. A
    // journaled host run is terminated exclusively through its exact,
    // persisted systemd scope; PID/process-group signalling is not authority.
    attempt.boundaryTerminationPromise = terminateHostAgentRunAttempt(hostRunHandle)
      .then((confirmed) => {
        if (!confirmed) onBoundaryFailure();
        return confirmed;
      }, () => {
        onBoundaryFailure();
        return false;
      });
    attempt.closeDeadlineTimer = setTimeout(() => {
      attempt.closeDeadlineTimer = null;
      if (attempt.terminal) return;
      attempt.terminal = true;
      onBoundaryFailure();
      attempt.onCloseDeadline();
    }, NATIVE_CHILD_CLOSE_DEADLINE_MS);
    return;
  }

  try {
    if (attempt.detached && typeof child.pid === 'number' && child.pid > 0) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }

  attempt.killTimer = setTimeout(() => {
    attempt.killTimer = null;
    if (attempt.terminal || !attempt.child) return;
    try {
      if (attempt.detached && typeof attempt.child.pid === 'number' && attempt.child.pid > 0) {
        process.kill(-attempt.child.pid, 'SIGKILL');
      } else {
        attempt.child.kill('SIGKILL');
      }
    } catch {
      try { attempt.child.kill('SIGKILL'); } catch {}
    }
  }, NATIVE_CHILD_SIGKILL_DELAY_MS);
  attempt.closeDeadlineTimer = setTimeout(() => {
    attempt.closeDeadlineTimer = null;
    if (attempt.terminal) return;
    attempt.terminal = true;
    if (attempt.killTimer) clearTimeout(attempt.killTimer);
    attempt.killTimer = null;
    attempt.onCloseDeadline();
  }, NATIVE_CHILD_CLOSE_DEADLINE_MS);
}

export abstract class NativeCliAdapterProvider implements AgentProvider {
  readonly displayName: string;
  readonly providerName: AgentProviderName;
  private readonly activeRuns = new Map<AgentSessionId, NativeActiveTurn>();

  protected constructor(protected readonly adapter: NativeCliProviderAdapter) {
    this.displayName = adapter.displayName;
    this.providerName = adapter.providerName;
  }

  private idCounter = 0;

  protected nextId(): string {
    return `${this.adapter.messageIdPrefix}-${Date.now()}-${++this.idCounter}`;
  }

  protected requireSession(sessionId: AgentSessionId): NativeSessionData {
    const session = loadNativeSession(this.adapter.providerName, sessionId);
    if (session) return session;
    throw new Error(`${this.adapter.displayName} session not found: ${sessionId}`);
  }

  async startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId> {
    assertExecutionContextBinding(config.executionContext, userId);
    const availability = getProviderAvailability(this.adapter.providerName);
    assertProviderSupportsExecutionScope(
      this.adapter.providerName,
      availability.capabilities.supportedExecutionScopes,
      config.executionContext,
    );
    if (config.executionContext.scope === 'HOST_OPERATOR') {
      const readiness = await getNativeProviderReadiness(this.adapter.providerName);
      if (!readiness.usable) throw new Error(readiness.message);
    }
    const resolvedConfig = this.adapter.configureSession
      ? await this.adapter.configureSession(userId, config)
      : config;
    assertExecutionContextBinding(resolvedConfig.executionContext, userId);
    if (!executionContextsMatch(config.executionContext, resolvedConfig.executionContext)) {
      throw new Error(`${this.adapter.displayName} attempted to change the server-assigned execution context`);
    }
    return createNativeSession(this.adapter.providerName, userId, resolvedConfig).sessionId;
  }

  async sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult> {
    const portalSessionId = sessionId;
    const session = this.requireSession(portalSessionId);
    assertExecutionContextBinding(session.executionContext, session.userId);
    let admittedReadiness: NativeProviderReadiness | undefined;
    // Both scopes gate on the awaited live readiness check. The Project
    // sandbox stages the same host credential this verifies, and the previous
    // sync cached-availability gate raced the background auth recheck: an
    // ambiguous "checking" snapshot failed Project turns and qualification
    // probes closed even though a live verification would have admitted them.
    const readiness = await getNativeProviderReadiness(this.adapter.providerName);
    if (!readiness.usable) throw new Error(readiness.message);
    if (session.executionContext.scope === 'HOST_OPERATOR') {
      admittedReadiness = readiness;
    }
    if (this.activeRuns.has(portalSessionId)) {
      throw new Error(`${this.adapter.displayName} already has an active turn in this session.`);
    }

    const publishToHostBus = session.executionContext.scope === 'HOST_OPERATOR';
    const runId = typeof sender?.requestId === 'string' && sender.requestId.trim()
      ? sender.requestId.trim()
      : randomUUID();
    if (publishToHostBus && sender?.userId && sender.userId !== session.userId) {
      throw new Error(`${this.adapter.displayName} sender does not own this host session`);
    }
    const hostRunHandle = publishToHostBus
      ? await beginHostAgentRun({
          id: runId,
          actorUserId: sender?.userId || session.userId,
          actorAuthorizationVersion: Number(sender?.authorizationVersion),
          provider: this.adapter.providerName,
          sessionId: portalSessionId,
        })
      : null;
    let resolveResult!: (result: AgentSendResult) => void;
    let rejectResult!: (error: unknown) => void;
    let resolveCompletion!: () => void;
    const resultPromise = new Promise<AgentSendResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const turn: NativeActiveTurn = {
      portalSessionId,
      runId,
      publishToHostBus,
      abortController: new AbortController(),
      aborted: false,
      abortPromise: null,
      authoritativeAbortPromise: null,
      cleanupConfirmed: true,
      quarantined: false,
      currentAttempt: null,
      settlePromise: null,
      completion,
      resolveCompletion,
      requestAbortSettlement: async () => undefined,
      hostRunHandle,
      unregisterHostRunAbort: null,
      unsubscribeAuthorization: null,
    };
    let ctx: NativeCliTurnContext | null = null;

    const settleTurn = (outcome: NativeTurnOutcome): Promise<void> => {
      if (turn.settlePromise) return turn.settlePromise;
      let resolveSettlement!: () => void;
      const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
      // Install the guard before any terminal callback or bus publication can
      // synchronously re-enter abort/settlement.
      turn.settlePromise = settlement;
      void (async () => {
        if (outcome.kind === 'abort' && turn.authoritativeAbortPromise) {
          turn.cleanupConfirmed = (await turn.authoritativeAbortPromise) && turn.cleanupConfirmed;
        }

        try {
          if (turn.hostRunHandle) {
            try {
              if (!turn.cleanupConfirmed) {
                await quarantineHostAgentRun(
                  turn.hostRunHandle,
                  `${this.adapter.displayName} process or provider cleanup was not confirmed.`,
                  { outcome: outcome.kind },
                );
              } else {
                await settleHostAgentRun(
                  turn.hostRunHandle,
                  outcome.kind === 'success'
                    ? 'COMPLETED'
                    : outcome.kind === 'abort'
                      ? 'ABORTED'
                      : 'ERROR',
                  outcome.kind === 'success'
                    ? undefined
                    : outcome.kind === 'abort'
                      ? 'The host-native turn was cancelled.'
                      : 'The host-native turn failed.',
                  { outcome: outcome.kind },
                );
              }
            } catch (journalError) {
              turn.cleanupConfirmed = false;
              throw journalError;
            }
          }
          if (outcome.kind === 'success') {
            appendNativeMessage(session, {
              id: this.nextId(),
              role: 'assistant',
              content: outcome.text,
              timestamp: new Date().toISOString(),
            });
            // The terminal event clears status. A blank status callback here
            // would be suppressed by the settlement guard and has no contract.
            if (publishToHostBus) {
              streamEventBus.publish(portalSessionId, {
                type: 'done',
                content: outcome.text,
                model: session.model || null,
                runId,
                metadata: sanitizeNativeProviderEvent(outcome.result.metadata || {}),
              } as StreamEvent);
            }
            resolveResult(outcome.result);
            return;
          }

          if (outcome.kind === 'abort') {
            if (!turn.cleanupConfirmed) {
              const cleanupError = classifyNativeProviderError(
                this.adapter.displayName,
                `${this.adapter.displayName} abort could not confirm provider and local process cleanup.`,
                'RUNTIME_UNAVAILABLE',
              );
              if (publishToHostBus) {
                streamEventBus.publish(portalSessionId, {
                  type: 'error',
                  content: cleanupError.message,
                  terminal: true,
                  code: cleanupError.code,
                  diagnosticId: cleanupError.diagnosticId,
                  runId,
                } as StreamEvent);
              }
              rejectResult(cleanupError);
              return;
            }
            if (publishToHostBus) {
              streamEventBus.publish(portalSessionId, {
                type: 'done',
                content: '',
                runId,
                metadata: { aborted: true },
              } as StreamEvent);
            }
            rejectResult(new AgentAbortError());
            return;
          }

          const errorText = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          const rawDiagnostic = outcome.diagnostic
            || [ctx?.stderr, errorText].filter((entry) => typeof entry === 'string' && entry.trim()).join('\n')
            || `${this.adapter.displayName} could not complete the request.`;
          const safeError = outcome.error instanceof NativeProviderDiagnosticError
            ? outcome.error
            : classifyNativeProviderError(
                this.adapter.displayName,
                rawDiagnostic,
                outcome.fallbackCode,
              );
          recordNativeProviderAuthFailure(
            this.adapter.providerName,
            rawDiagnostic,
            admittedReadiness && {
              credentialFingerprint: admittedReadiness.credentialFingerprint,
              runtimeFingerprint: admittedReadiness.runtimeFingerprint,
            },
            { confirmed: safeError.code === 'AUTH_REQUIRED' },
          );
          if (safeError.code === 'AUTH_REQUIRED') {
            console.warn('[NativeProviderFailure]', {
              provider: this.adapter.providerName,
              code: safeError.code,
              exitCode: ctx?.exitCode ?? null,
              diagnosticId: safeError.diagnosticId,
            });
          }
          if (outcome.persistAssistantError) {
            appendNativeMessage(session, {
              id: this.nextId(),
              role: 'assistant',
              content: `Error: ${safeError.message} Diagnostic ID: ${safeError.diagnosticId}`,
              timestamp: new Date().toISOString(),
            });
          }
          if (publishToHostBus) {
            streamEventBus.publish(portalSessionId, {
              type: 'error',
              content: safeError.message,
              terminal: true,
              code: safeError.code,
              diagnosticId: safeError.diagnosticId,
              runId,
            } as StreamEvent);
          }
          rejectResult(safeError);
        } catch (settlementError) {
          const raw = settlementError instanceof Error ? settlementError.message : String(settlementError);
          const safeError = settlementError instanceof NativeProviderDiagnosticError
            ? settlementError
            : classifyNativeProviderError(this.adapter.displayName, raw);
          if (publishToHostBus) {
            try {
              streamEventBus.publish(portalSessionId, {
                type: 'error',
                content: safeError.message,
                terminal: true,
                code: safeError.code,
                diagnosticId: safeError.diagnosticId,
                runId,
              } as StreamEvent);
            } catch {}
          }
          rejectResult(safeError);
        } finally {
          if (publishToHostBus) {
            try { streamEventBus.softClearStream(portalSessionId, runId); } catch {}
          }
          if (this.activeRuns.get(portalSessionId) === turn) {
            turn.quarantined = !turn.cleanupConfirmed;
            if (!turn.quarantined) {
              this.activeRuns.delete(portalSessionId);
              turn.unregisterHostRunAbort?.();
              turn.unregisterHostRunAbort = null;
              turn.unsubscribeAuthorization?.();
              turn.unsubscribeAuthorization = null;
            }
          }
          turn.resolveCompletion();
          resolveSettlement();
        }
      })();
      return settlement;
    };
    turn.requestAbortSettlement = () => settleTurn({ kind: 'abort' });

    // Reserve the complete logical turn synchronously. The reservation remains
    // in place through invocation construction, approvals, child attempts, and
    // retries; no awaited provider work occurs before this point.
    this.activeRuns.set(portalSessionId, turn);
    if (turn.hostRunHandle) {
      turn.unregisterHostRunAbort = registerHostAgentRunAbort(
        turn.hostRunHandle,
        () => this.abortActiveRun(portalSessionId, runId),
      );
      turn.unsubscribeAuthorization = subscribeToAuthorizationChanges(
        turn.hostRunHandle.actorUserId,
        () => {
          void this.abortActiveRun(portalSessionId, runId).catch(() => false);
        },
      );
    }

    const confirmAttemptCleanup = async (attempt: NativeTurnAttempt): Promise<boolean> => {
      const confirmed = await invokeAttemptAbort(attempt);
      turn.cleanupConfirmed = confirmed && turn.cleanupConfirmed;
      return confirmed;
    };

    const confirmLocalBoundary = async (attempt: NativeTurnAttempt): Promise<boolean> => {
      if (!attempt.boundaryTerminationPromise) return true;
      const confirmed = await attempt.boundaryTerminationPromise;
      turn.cleanupConfirmed = confirmed && turn.cleanupConfirmed;
      return confirmed;
    };

    const failAttempt = (attempt: NativeTurnAttempt, error: unknown): void => {
      if (turn.settlePromise || attempt.terminal || attempt.failure) return;
      attempt.failure = error;
      void invokeAttemptAbort(attempt);
      if (attempt.child) {
        signalAttempt(
          attempt,
          turn.hostRunHandle,
          () => { turn.cleanupConfirmed = false; },
        );
      } else {
        void (async () => {
          await confirmAttemptCleanup(attempt);
          await settleTurn({ kind: 'error', error });
        })();
      }
    };

    const handleAttemptCloseDeadline = async (attempt: NativeTurnAttempt): Promise<void> => {
      if (turn.settlePromise) return;
      // SIGTERM followed by SIGKILL still produced no close event. The local
      // process boundary is therefore unconfirmed regardless of provider-hook
      // success, and the logical turn must remain quarantined.
      turn.cleanupConfirmed = false;
      await confirmLocalBoundary(attempt);
      await confirmAttemptCleanup(attempt);
      if (turn.aborted) {
        await settleTurn({ kind: 'abort' });
        return;
      }
      const error = attempt.failure instanceof Error
        ? attempt.failure
        : new Error(`${this.adapter.displayName} CLI did not close after termination signals`);
      await settleTurn({
        kind: 'error',
        error,
        diagnostic: `${this.adapter.displayName} CLI did not close after SIGTERM and SIGKILL`,
      });
    };

    const handleAttemptClose = async (
      attempt: NativeTurnAttempt,
      code: number | null,
      signal: NodeJS.Signals | null,
    ): Promise<void> => {
      if (attempt.terminal || turn.settlePromise) return;
      attempt.terminal = true;
      clearAttemptTerminationTimers(attempt);
      await confirmLocalBoundary(attempt);
      if (turn.aborted) {
        await settleTurn({ kind: 'abort' });
        return;
      }
      if (attempt.failure) {
        await confirmAttemptCleanup(attempt);
        await settleTurn({ kind: 'error', error: attempt.failure });
        return;
      }
      if (signal) {
        await confirmAttemptCleanup(attempt);
        await settleTurn({
          kind: 'error',
          error: new Error(`${this.adapter.displayName} CLI terminated by signal ${signal}`),
          diagnostic: `${this.adapter.displayName} CLI terminated by signal ${signal}`,
          persistAssistantError: true,
        });
        return;
      }
      if (code === null) {
        await confirmAttemptCleanup(attempt);
        await settleTurn({
          kind: 'error',
          error: new Error(`${this.adapter.displayName} CLI closed without an exit status`),
          diagnostic: `${this.adapter.displayName} CLI closed without an exit status`,
          persistAssistantError: true,
        });
        return;
      }

      try {
        if (!ctx) throw new Error(`${this.adapter.displayName} turn context was not initialized`);
        if (attempt.stdoutBuffer.trim()) {
          if (this.adapter.handleStdoutRemainder) {
            this.adapter.handleStdoutRemainder(attempt.stdoutBuffer, ctx);
          } else {
            const normalized = attempt.stdoutBuffer.replace(/\r$/, '');
            if (normalized.trim()) this.adapter.handleStdoutLine(normalized, ctx);
          }
        }

        ctx.exitCode = code;
        if (this.adapter.finalizeTurn) {
          await raceWithAbort(Promise.resolve(this.adapter.finalizeTurn(ctx)), turn.abortController.signal);
        }
        if (turn.aborted) {
          await settleTurn({ kind: 'abort' });
          return;
        }

        if (ctx.state.retryRequested && !ctx.state.retryStarted) {
          ctx.state.retryStarted = true;
          ctx.state.retryRequested = false;
          ctx.setFullText('');
          ctx.setLastAssistantMessage('');
          ctx.stderr = '';
          await startAttempt();
          return;
        }

        const acceptedExit = code === 0 || this.adapter.acceptedExitCodes?.includes(code) === true;
        if (!acceptedExit) {
          const diagnostic = this.adapter.getErrorMessage?.(ctx)
            || ctx.stderr
            || `${this.adapter.displayName} CLI exited with code ${code}`;
          await settleTurn({
            kind: 'error',
            error: new Error(diagnostic),
            diagnostic,
            persistAssistantError: true,
          });
          return;
        }

        const result = this.adapter.transformResult
          ? await raceWithAbort(Promise.resolve(this.adapter.transformResult(ctx)), turn.abortController.signal)
          : {
              fullText: stripAnsi((this.adapter.getResultText?.(ctx) || ctx.fullText || ctx.lastAssistantMessage)).trim(),
              metadata: this.adapter.getResultMetadata?.(ctx),
            };
        if (turn.aborted) {
          await settleTurn({ kind: 'abort' });
          return;
        }
        const text = stripAnsi(result.fullText || '').trim();

        await settleTurn({
          kind: 'success',
          text,
          result: {
            fullText: text,
            metadata: result.metadata,
          },
        });
      } catch (error) {
        await confirmAttemptCleanup(attempt);
        if (turn.aborted || isAbortError(error)) {
          await settleTurn({ kind: 'abort' });
        } else {
          await settleTurn({ kind: 'error', error });
        }
      }
    };

    const startAttempt = async (): Promise<void> => {
      if (turn.settlePromise) return;
      if (turn.aborted) {
        await settleTurn({ kind: 'abort' });
        return;
      }
      if (!ctx) throw new Error(`${this.adapter.displayName} turn context was not initialized`);

      ctx.state.turnAttempt = Number(ctx.state.turnAttempt || 0) + 1;
      ctx.exitCode = null;
      const attempt: NativeTurnAttempt = {
        id: Number(ctx.state.turnAttempt),
        child: null,
        detached: false,
        invocationPromise: null,
        invocationAbortDeadlineTimer: null,
        onInvocationAbortDeadline: () => undefined,
        abortPromise: null,
        failure: null,
        terminal: false,
        terminationStarted: false,
        boundaryTerminationPromise: null,
        killTimer: null,
        closeDeadlineTimer: null,
        onCloseDeadline: () => undefined,
        stdoutBuffer: '',
      };
      attempt.onInvocationAbortDeadline = () => {
        if (!turn.aborted || turn.settlePromise) return;
        // Invocation construction did not return an abort boundary in time.
        // Settle the caller on a bounded deadline, but retain the attempt so a
        // late invocation can still be terminated through its eventual hook.
        turn.cleanupConfirmed = false;
        turn.authoritativeAbortPromise = Promise.resolve(false);
        void settleTurn({ kind: 'abort' });
      };
      attempt.onCloseDeadline = () => { void handleAttemptCloseDeadline(attempt); };
      turn.currentAttempt = attempt;
      let invocationResolved = false;

      try {
        // Do not race invocation construction against the local AbortSignal.
        // Project adapters can allocate their provider-owned process boundary
        // while building the invocation, and only the resolved invocation can
        // supply the authoritative abort hook for that boundary.
        // Defer the adapter call by one microtask so invocationPromise is
        // installed before a synchronous approval callback can re-enter abort.
        attempt.invocationPromise = Promise.resolve().then(() => this.adapter.buildInvocation(ctx!));
        const invocation = await attempt.invocationPromise;
        clearInvocationAbortDeadline(attempt);
        invocationResolved = true;
        attempt.abortInvocation = invocation.abort;
        if (turn.aborted) {
          if (turn.settlePromise) {
            // The bounded invocation deadline already quarantined this turn.
            // Still invoke a late provider hook exactly once as best-effort
            // cleanup; cleanupConfirmed intentionally remains false.
            await confirmAttemptCleanup(attempt);
          } else {
            turn.authoritativeAbortPromise = invokeAttemptAbort(attempt);
            await settleTurn({ kind: 'abort' });
          }
          attempt.terminal = true;
          return;
        }
        if (turn.settlePromise) {
          await confirmAttemptCleanup(attempt);
          attempt.terminal = true;
          return;
        }

        attempt.detached = publishToHostBus ? true : invocation.options?.detached === true;
        const spawnOptions = {
          cwd: session.cwd,
          stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
          ...(invocation.options || {}),
          env: invocation.options?.env || buildNativeCliEnvironment(this.adapter.providerName),
          detached: attempt.detached,
        };
        const hostRunReservation = turn.hostRunHandle
          ? await reserveHostAgentRunAttempt(turn.hostRunHandle)
          : null;
        const gatedLaunch = turn.hostRunHandle && hostRunReservation
          ? await spawnGatedHostAgentRunAttempt({
              handle: turn.hostRunHandle,
              reservation: hostRunReservation,
              command: invocation.command,
              args: invocation.args,
              options: {
                ...spawnOptions,
                detached: true,
              },
            })
          : null;
        const child = gatedLaunch
          ? gatedLaunch.child
          : spawn(invocation.command, invocation.args, spawnOptions);
        attempt.child = child;

        // Register terminal boundaries before stream parsers. If parser-listener
        // setup itself throws, startAttempt's catch can still wait for close.
        child.on('error', (error) => {
          if (attempt.terminal || turn.settlePromise) return;
          attempt.failure = error;
          void invokeAttemptAbort(attempt);
          if (typeof child.pid === 'number' && child.pid > 0) {
            signalAttempt(
              attempt,
              turn.hostRunHandle,
              () => { turn.cleanupConfirmed = false; },
            );
            return;
          }
          // A spawn error without a pid proves that no local process exists.
          // The provider boundary still requires its own abort acknowledgement.
          attempt.terminal = true;
          clearAttemptTerminationTimers(attempt);
          void (async () => {
            await confirmAttemptCleanup(attempt);
            if (turn.aborted) {
              await settleTurn({ kind: 'abort' });
              return;
            }
            await settleTurn({
              kind: 'error',
              error,
              diagnostic: `${this.adapter.spawnErrorPrefix || `Failed to spawn ${this.adapter.cliCommand} CLI`}: ${error.message}`,
              fallbackCode: 'RUNTIME_UNAVAILABLE',
            });
          })();
        });

        child.on('close', (code, signal) => {
          void handleAttemptClose(attempt, code, signal);
        });

        child.stdout?.on('data', (data: Buffer) => {
          if (attempt.terminal || attempt.failure || turn.settlePromise) return;
          try {
            attempt.stdoutBuffer += data.toString();
            if (Buffer.byteLength(attempt.stdoutBuffer, 'utf8') > 1024 * 1024) {
              ctx!.appendStderr('Native CLI emitted an oversized unterminated stdout record.');
              attempt.stdoutBuffer = Buffer.from(attempt.stdoutBuffer, 'utf8').subarray(-1024 * 1024).toString('utf8');
            }
            let idx: number;
            while ((idx = attempt.stdoutBuffer.indexOf('\n')) >= 0) {
              const line = attempt.stdoutBuffer.slice(0, idx);
              attempt.stdoutBuffer = attempt.stdoutBuffer.slice(idx + 1);
              const normalized = line.replace(/\r$/, '');
              if (normalized.trim()) this.adapter.handleStdoutLine(normalized, ctx!);
            }
          } catch (error) {
            failAttempt(attempt, error);
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          if (attempt.terminal || attempt.failure || turn.settlePromise) return;
          try {
            const text = data.toString();
            ctx!.appendStderr(text);
            this.adapter.handleStderrChunk?.(text, ctx!);
          } catch (error) {
            failAttempt(attempt, error);
          }
        });
        if (gatedLaunch && turn.hostRunHandle) {
          await activateGatedHostAgentRunAttempt(turn.hostRunHandle, gatedLaunch);
        }

      } catch (error) {
        clearInvocationAbortDeadline(attempt);
        if (attempt.child) {
          attempt.failure = attempt.failure || error;
          void invokeAttemptAbort(attempt);
          signalAttempt(
            attempt,
            turn.hostRunHandle,
            () => { turn.cleanupConfirmed = false; },
          );
          return;
        }

        attempt.terminal = true;
        if (invocationResolved) {
          await confirmAttemptCleanup(attempt);
        } else if (turn.aborted) {
          // A build rejection only proves cancellation when the adapter
          // propagated the Portal-owned AbortSignal as an abort error. Any
          // other rejection leaves a possibly allocated provider boundary
          // unaccounted for and therefore quarantines the logical turn.
          turn.cleanupConfirmed = isAbortError(error) && turn.cleanupConfirmed;
          turn.authoritativeAbortPromise = Promise.resolve(turn.cleanupConfirmed);
        } else if (!publishToHostBus) {
          // A Project invocation may have provisioned a confined runtime before
          // rejecting without returning its abort hook. With no cleanup proof,
          // retaining the logical turn is safer than permitting overlap.
          turn.cleanupConfirmed = false;
        }
        if (turn.aborted || isAbortError(error)) {
          await settleTurn({ kind: 'abort' });
        } else {
          await settleTurn({ kind: 'error', error });
        }
      }
    };

    void (async () => {
      try {
        if (publishToHostBus) {
          if (!streamEventBus.startStream(portalSessionId, runId, {
            provenance: `via ${this.adapter.displayName}`,
            model: session.model || undefined,
          })) {
            throw classifyNativeProviderError(
              this.adapter.displayName,
              `${this.adapter.displayName} already has a different active turn for this session.`,
              'RUNTIME_UNAVAILABLE',
            );
          }
        }
        appendNativeMessage(session, {
          id: this.nextId(),
          role: 'user',
          content: message,
          timestamp: new Date().toISOString(),
        });

        ctx = {
          session,
          originalSessionId: portalSessionId,
          message,
          onChunk,
          onStatus,
          onExecApproval,
          fullText: '',
          lastAssistantMessage: '',
          stderr: '',
          exitCode: null,
          state: { portalRunId: runId },
          emitChunk: (chunk) => {
            if (!chunk || turn.settlePromise) return;
            onChunk?.(chunk);
            if (publishToHostBus) {
              streamEventBus.updateStreamPhase(portalSessionId, { phase: 'streaming', runId });
              streamEventBus.publish(portalSessionId, { type: 'text', content: chunk, runId } as StreamEvent);
            }
          },
          emitStatus: (content, extra) => {
            if (turn.settlePromise) return;
            const safeEvent = sanitizeNativeProviderEvent<Record<string, unknown>>({
              type: 'status',
              content,
              ...(extra || {}),
              runId,
            });
            onStatus?.(safeEvent as any);
            if (publishToHostBus) {
              const eventType = typeof safeEvent.type === 'string' ? safeEvent.type : 'status';
              if (eventType === 'tool_start' || eventType === 'tool_update') {
                streamEventBus.updateStreamPhase(portalSessionId, {
                  phase: 'tool',
                  toolName: typeof safeEvent.toolName === 'string' ? safeEvent.toolName : undefined,
                  runId,
                });
              } else if (eventType === 'tool_end' || eventType === 'thinking' || eventType === 'status') {
                streamEventBus.updateStreamPhase(portalSessionId, { phase: 'thinking', runId });
              }
              streamEventBus.publish(portalSessionId, safeEvent as StreamEvent);
            }
          },
          setFullText: (text) => { if (ctx) ctx.fullText = text; },
          appendFullText: (text) => { if (text && ctx) ctx.fullText += text; },
          setLastAssistantMessage: (text) => { if (ctx) ctx.lastAssistantMessage = text; },
          appendStderr: (text) => {
            if (text && ctx) ctx.stderr = appendBoundedNativeDiagnostic(ctx.stderr, text);
          },
          requestApproval: async (approval) => {
            if (turn.abortController.signal.aborted) return 'deny';
            if (sender?.role && !isElevatedRole(sender.role)) {
              ctx?.emitStatus('Command approval is only available to portal admins. This request was denied automatically.');
              return 'deny';
            }
            const decision = await requestNativeCliApproval({
              providerName: this.adapter.providerName,
              sessionId: portalSessionId,
              cwd: session.cwd,
              onRequest: onExecApproval,
              signal: turn.abortController.signal,
              ...approval,
            });
            return turn.abortController.signal.aborted ? 'deny' : decision;
          },
          updateSessionMetadata: (metadata) => {
            session.metadata = {
              ...(session.metadata || {}),
              ...metadata,
            };
            updateNativeSessionMetadata(this.adapter.providerName, portalSessionId, metadata);
          },
          stripAnsi,
        };

        const initialStatus = typeof this.adapter.initialStatus === 'function'
          ? this.adapter.initialStatus(ctx)
          : this.adapter.initialStatus;
        if (initialStatus) ctx.emitStatus(initialStatus);
        await startAttempt();
      } catch (error) {
        if (turn.aborted || isAbortError(error)) {
          await settleTurn({ kind: 'abort' });
        } else {
          await settleTurn({ kind: 'error', error });
        }
      }
    })();

    return resultPromise;
  }

  async abortActiveRun(sessionId: AgentSessionId, expectedRunId?: string): Promise<boolean> {
    const turn = this.activeRuns.get(sessionId);
    if (!turn) return false;
    if (expectedRunId && expectedRunId !== turn.runId) return false;
    if (turn.quarantined) return false;
    if (turn.abortPromise) return turn.abortPromise;
    if (turn.settlePromise) {
      await turn.completion;
      return false;
    }

    turn.abortPromise = (async () => {
      turn.aborted = true;
      turn.abortController.abort();
      const attempt = turn.currentAttempt;
      if (attempt?.child && !attempt.terminal) {
        turn.authoritativeAbortPromise = invokeAttemptAbort(attempt);
        signalAttempt(
          attempt,
          turn.hostRunHandle,
          () => { turn.cleanupConfirmed = false; },
        );
      } else if (attempt?.invocationPromise && !attempt.terminal) {
        // startAttempt owns settlement here. It must await buildInvocation so
        // that a late provider abort hook cannot be skipped. The deadline
        // prevents an adapter that never resolves from hanging abort forever.
        scheduleInvocationAbortDeadline(attempt);
      } else if (attempt) {
        turn.authoritativeAbortPromise = invokeAttemptAbort(attempt);
        await turn.requestAbortSettlement();
      } else {
        turn.authoritativeAbortPromise = Promise.resolve(true);
        await turn.requestAbortSettlement();
      }
      await turn.completion;
      return turn.cleanupConfirmed;
    })();
    return turn.abortPromise;
  }

  async getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]> {
    this.requireSession(sessionId);
    return readAllNativeSessionHistory(this.adapter.providerName, sessionId);
  }

  async listSessions(userId: string): Promise<AgentSessionSummary[]> {
    return listNativeSessions(this.adapter.providerName, userId);
  }

  async terminateSession(sessionId: AgentSessionId): Promise<void> {
    const activeTurn = this.activeRuns.get(sessionId);
    if (activeTurn) {
      const confirmed = await this.abortActiveRun(sessionId, activeTurn.runId);
      if (!confirmed) {
        throw new Error(`${this.adapter.displayName} could not confirm termination of the active turn.`);
      }
      await activeTurn.completion;
    }
    deleteNativeSession(this.adapter.providerName, sessionId);
  }

  hasActiveRun(sessionId: AgentSessionId): boolean {
    return this.activeRuns.has(sessionId);
  }
}
