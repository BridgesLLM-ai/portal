import {
  quiesceAgentJobsForProjectDependencyPromotion,
  type AgentJobAuthorizationQuiescence,
} from './agentJobs';
import {
  quiesceHostAgentRunsForProjectDependencyPromotion,
  type HostAgentRunQuiescence,
} from './hostAgentRunJournal';
import {
  quiesceOpenClawHostRunsForProjectDependencyPromotion,
  type OpenClawHostRunQuiescence,
} from './openClawHostRunJournal';
import {
  attestProjectChatsQuiescentForProjectDependencyPromotion,
  type ProjectChatDependencyPromotionQuiescence,
} from './projectChatDependencyPromotionQuiescence';
import { quiesceProjectNativeRunsForProjectDependencyPromotion } from './projectNativeRunBroker';
import { quiesceTerminalSystemdScopesForProjectDependencyPromotion } from './terminalSystemdScopeBoundary';
import type { WorkspaceAuthorizationFenceController } from './workspaceAuthorizationBarrier';

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const SAFE_DIAGNOSTIC_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_OPENCLAW_SESSION_KEY = /^agent:[A-Za-z0-9_-]+:[^\u0000-\u001f\u007f]{1,1980}$/;

const WRITER_SUBSYSTEMS = [
  'terminalScopes',
  'agentJobs',
  'hostAgentRuns',
  'openClawHostRuns',
  'projectNativeRuns',
  'durableProjectChat',
  'mutationDrain',
] as const;

export type ProjectDependencyPromotionWriterSubsystem = typeof WRITER_SUBSYSTEMS[number];

export interface ProjectDependencyPromotionWriterFenceDiagnostic {
  subsystem?: ProjectDependencyPromotionWriterSubsystem | null;
  causeCode?: string | null;
  causeMessage?: string | null;
  sessionKey?: string | null;
}

export interface ProjectDependencyPromotionStartupDiagnostic {
  code: string;
  message: string;
  subsystem: ProjectDependencyPromotionWriterSubsystem | null;
  causeCode: string | null;
  causeMessage: string | null;
  sessionKey: string | null;
}

function boundedDiagnosticText(value: unknown, fallback: string): string {
  return String(value || fallback)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 1_024) || fallback;
}

function boundedDiagnosticCode(value: unknown, fallback: string): string {
  const candidate = String(value || '').trim();
  return SAFE_DIAGNOSTIC_CODE.test(candidate) ? candidate : fallback;
}

function writerSubsystem(value: unknown): ProjectDependencyPromotionWriterSubsystem | null {
  return (WRITER_SUBSYSTEMS as readonly unknown[]).includes(value)
    ? value as ProjectDependencyPromotionWriterSubsystem
    : null;
}

function diagnosticSessionKey(value: unknown): string | null {
  return typeof value === 'string'
    && value.length <= 2_048
    && SAFE_OPENCLAW_SESSION_KEY.test(value)
    ? value
    : null;
}

export const PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_CODE =
  'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN';
export const PROJECT_DEPENDENCY_PROMOTION_CONTAINED_CODE =
  'PROJECT_DEPENDENCY_PROMOTION_CONTAINED';
export const PROJECT_DEPENDENCY_PROMOTION_FENCE_BUSY_CODE =
  'PROJECT_DEPENDENCY_PROMOTION_FENCE_BUSY';

export type ProjectDependencyPromotionWriterFenceErrorCode =
  | typeof PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_CODE
  | typeof PROJECT_DEPENDENCY_PROMOTION_CONTAINED_CODE
  | typeof PROJECT_DEPENDENCY_PROMOTION_FENCE_BUSY_CODE;

export class ProjectDependencyPromotionWriterFenceError extends Error {
  public readonly subsystem: ProjectDependencyPromotionWriterSubsystem | null;
  public readonly causeCode: string | null;
  public readonly causeMessage: string | null;
  public readonly sessionKey: string | null;

  constructor(
    message: string,
    public readonly fenceRetained = true,
    public readonly code: ProjectDependencyPromotionWriterFenceErrorCode =
      PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_CODE,
    public readonly statusCode = 503,
    diagnostic: ProjectDependencyPromotionWriterFenceDiagnostic = {},
  ) {
    super(message);
    this.name = 'ProjectDependencyPromotionWriterFenceError';
    this.fenceRetained = fenceRetained;
    this.subsystem = writerSubsystem(diagnostic.subsystem);
    this.causeCode = diagnostic.causeCode
      ? boundedDiagnosticCode(diagnostic.causeCode, 'UnknownError')
      : null;
    this.causeMessage = diagnostic.causeMessage
      ? boundedDiagnosticText(diagnostic.causeMessage, 'Writer quiescence failed')
      : null;
    this.sessionKey = diagnosticSessionKey(diagnostic.sessionKey);
  }
}

export function describeProjectDependencyPromotionStartupFailure(
  error: unknown,
): ProjectDependencyPromotionStartupDiagnostic {
  const candidate = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  return Object.freeze({
    code: boundedDiagnosticCode(
      candidate.code || candidate.name,
      'UnknownError',
    ),
    message: boundedDiagnosticText(candidate.message, 'Promotion recovery failed'),
    subsystem: writerSubsystem(candidate.subsystem),
    causeCode: candidate.causeCode
      ? boundedDiagnosticCode(candidate.causeCode, 'UnknownError')
      : null,
    causeMessage: candidate.causeMessage
      ? boundedDiagnosticText(candidate.causeMessage, 'Writer quiescence failed')
      : null,
    sessionKey: diagnosticSessionKey(candidate.sessionKey),
  });
}

function wrapWriterSubsystemFailure(
  subsystem: ProjectDependencyPromotionWriterSubsystem,
  error: unknown,
): ProjectDependencyPromotionWriterFenceError {
  const candidate = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  return new ProjectDependencyPromotionWriterFenceError(
    'A Portal-tracked workspace writer could not be proven quiescent before dependency promotion.',
    true,
    PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_CODE,
    503,
    {
      subsystem,
      causeCode: boundedDiagnosticCode(candidate.code || candidate.name, 'UnknownError'),
      causeMessage: boundedDiagnosticText(
        candidate.causeMessage || candidate.message,
        'Writer quiescence failed',
      ),
      sessionKey: diagnosticSessionKey(candidate.sessionKey),
    },
  );
}

async function runWriterSubsystem<T>(
  subsystem: ProjectDependencyPromotionWriterSubsystem,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw wrapWriterSubsystemFailure(subsystem, error);
  }
}

export interface ProjectDependencyPromotionWriterQuiescenceAttempt {
  terminalScopes: Awaited<ReturnType<
    typeof quiesceTerminalSystemdScopesForProjectDependencyPromotion
  >>;
  agentJobs: AgentJobAuthorizationQuiescence;
  hostAgentRuns: HostAgentRunQuiescence;
  openClawHostRuns: OpenClawHostRunQuiescence;
  projectNativeRuns: Awaited<ReturnType<
    typeof quiesceProjectNativeRunsForProjectDependencyPromotion
  >>;
  durableProjectChat: ProjectChatDependencyPromotionQuiescence;
}

export interface ProjectDependencyPromotionWriterFenceProof {
  readonly preDrain: ProjectDependencyPromotionWriterQuiescenceAttempt;
  readonly postDrain: ProjectDependencyPromotionWriterQuiescenceAttempt;
}

export interface ProjectDependencyPromotionWriterFence {
  proveQuiescent(): Promise<ProjectDependencyPromotionWriterFenceProof>;
  assertHeld(proof: ProjectDependencyPromotionWriterFenceProof): void;
  releaseAfterSafeState(attestSafeState: () => Promise<void>): Promise<void>;
  isHeld(): boolean;
}

export interface ProjectDependencyPromotionWriterFenceDependencies {
  quiesceTerminalScopes?: typeof quiesceTerminalSystemdScopesForProjectDependencyPromotion;
  quiesceAgentJobs?: typeof quiesceAgentJobsForProjectDependencyPromotion;
  quiesceHostAgentRuns?: typeof quiesceHostAgentRunsForProjectDependencyPromotion;
  quiesceOpenClawHostRuns?: typeof quiesceOpenClawHostRunsForProjectDependencyPromotion;
  quiesceProjectNativeRuns?: typeof quiesceProjectNativeRunsForProjectDependencyPromotion;
  attestDurableProjectChat?: typeof attestProjectChatsQuiescentForProjectDependencyPromotion;
  drainTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

const issuedProofs = new WeakMap<
  ProjectDependencyPromotionWriterFenceProof,
  ProjectDependencyPromotionWriterFence
>();

async function waitWithDeadline(
  operation: Promise<void>,
  timeoutMs: number,
  setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout,
  clearTimer: (timer: NodeJS.Timeout) => void,
): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimer(() => reject(new ProjectDependencyPromotionWriterFenceError(
          'Portal-tracked workspace writers did not drain before dependency promotion.',
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

/**
 * Close the process-global Portal writer boundary for one staged dependency
 * promotion. The injected closure must close admission before excluding the
 * installer request; `releaseProjectLease` then lets older queued mutations
 * finish so the global drain cannot wait behind the installer's own lock.
 *
 * This covers Portal-tracked writers only. Exact recursive manifest/inode
 * re-attestation remains the boundary against manual SSH, external cron, or
 * any other writer that never entered Portal admission.
 */
export function closeProjectDependencyPromotionWriterFence(input: {
  closeAdmissionAndSettleInstaller(): WorkspaceAuthorizationFenceController;
  releaseProjectLease(): void;
}, dependencies: ProjectDependencyPromotionWriterFenceDependencies = {}): ProjectDependencyPromotionWriterFence {
  let admission: WorkspaceAuthorizationFenceController;
  try {
    admission = input.closeAdmissionAndSettleInstaller();
  } catch (error: any) {
    throw new ProjectDependencyPromotionWriterFenceError(
      error?.statusCode === 409
        ? 'Another global workspace transition already owns admission.'
        : 'Global workspace admission could not be closed for dependency promotion.',
      false,
      error?.statusCode === 409
        ? PROJECT_DEPENDENCY_PROMOTION_FENCE_BUSY_CODE
        : PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_CODE,
      error?.statusCode === 409 ? 409 : 503,
    );
  }
  try {
    input.releaseProjectLease();
  } catch {
    throw new ProjectDependencyPromotionWriterFenceError(
      'The exact Project lock could not be released after global admission closed.',
    );
  }

  const quiesceTerminalScopes = dependencies.quiesceTerminalScopes
    || quiesceTerminalSystemdScopesForProjectDependencyPromotion;
  const quiesceAgentJobs = dependencies.quiesceAgentJobs
    || quiesceAgentJobsForProjectDependencyPromotion;
  const quiesceHostAgentRuns = dependencies.quiesceHostAgentRuns
    || quiesceHostAgentRunsForProjectDependencyPromotion;
  const quiesceOpenClawHostRuns = dependencies.quiesceOpenClawHostRuns
    || quiesceOpenClawHostRunsForProjectDependencyPromotion;
  const quiesceProjectNativeRuns = dependencies.quiesceProjectNativeRuns
    || quiesceProjectNativeRunsForProjectDependencyPromotion;
  const attestDurableProjectChat = dependencies.attestDurableProjectChat
    || attestProjectChatsQuiescentForProjectDependencyPromotion;
  const setTimer = dependencies.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer || ((timer) => clearTimeout(timer));
  const drainTimeoutMs = Math.min(
    5 * 60_000,
    Math.max(1_000, Number(dependencies.drainTimeoutMs) || DEFAULT_DRAIN_TIMEOUT_MS),
  );
  let held = true;
  let proof: ProjectDependencyPromotionWriterFenceProof | null = null;

  const assertStillHeld = () => {
    if (!held) {
      throw new ProjectDependencyPromotionWriterFenceError(
        'The dependency-promotion writer fence is no longer held.',
        false,
      );
    }
  };
  const quiesceAttempt = async (): Promise<ProjectDependencyPromotionWriterQuiescenceAttempt> => {
    assertStillHeld();
    const terminalScopes = await runWriterSubsystem('terminalScopes', quiesceTerminalScopes);
    const agentJobs = await runWriterSubsystem('agentJobs', quiesceAgentJobs);
    const hostAgentRuns = await runWriterSubsystem('hostAgentRuns', quiesceHostAgentRuns);
    const openClawHostRuns = await runWriterSubsystem('openClawHostRuns', quiesceOpenClawHostRuns);
    const projectNativeRuns = await runWriterSubsystem('projectNativeRuns', quiesceProjectNativeRuns);
    // Broker quiescence waits through provider settlement callbacks. Only then
    // can the durable scan prove there is no orphan RUNNING/ABORTING turn or
    // stale activeTurnId that escaped process-local broker inventory.
    const durableProjectChat = await runWriterSubsystem(
      'durableProjectChat',
      attestDurableProjectChat,
    );
    assertStillHeld();
    return {
      terminalScopes,
      agentJobs,
      hostAgentRuns,
      openClawHostRuns,
      projectNativeRuns,
      durableProjectChat,
    };
  };

  let fence!: ProjectDependencyPromotionWriterFence;
  fence = Object.freeze({
    async proveQuiescent(): Promise<ProjectDependencyPromotionWriterFenceProof> {
      assertStillHeld();
      if (proof) return proof;
      try {
        const preDrain = await quiesceAttempt();
        await runWriterSubsystem('mutationDrain', () => waitWithDeadline(
          admission.waitForMutationDrain(),
          drainTimeoutMs,
          setTimer,
          clearTimer,
        ));
        const postDrain = await quiesceAttempt();
        proof = Object.freeze({ preDrain, postDrain });
        issuedProofs.set(proof, fence);
        return proof;
      } catch (error) {
        if (error instanceof ProjectDependencyPromotionWriterFenceError) throw error;
        throw new ProjectDependencyPromotionWriterFenceError(
          'A Portal-tracked workspace writer could not be proven quiescent before dependency promotion.',
        );
      }
    },
    assertHeld(candidate: ProjectDependencyPromotionWriterFenceProof): void {
      assertStillHeld();
      if (!proof || candidate !== proof || issuedProofs.get(candidate) !== fence) {
        throw new ProjectDependencyPromotionWriterFenceError(
          'Exact dependency-promotion writer quiescence proof is required.',
        );
      }
    },
    async releaseAfterSafeState(attestSafeState: () => Promise<void>): Promise<void> {
      assertStillHeld();
      try {
        await attestSafeState();
      } catch (error) {
        if (error instanceof ProjectDependencyPromotionWriterFenceError) throw error;
        throw new ProjectDependencyPromotionWriterFenceError(
          'Dependency-promotion recovery state could not be proven safe; global admission remains closed.',
        );
      }
      admission.release();
      held = false;
    },
    isHeld: () => held,
  });
  return fence;
}
