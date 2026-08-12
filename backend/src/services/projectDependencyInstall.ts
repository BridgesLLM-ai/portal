import type { ChildProcess } from 'child_process';
import { canUseInteractivePortal } from '../utils/authz';
import type { JwtPayload } from '../utils/jwt';
import {
  establishLongLivedAccessAuthorization,
  type AuthorizedAccessIdentity,
  type EstablishedLongLivedAccessResult,
  type LongLivedAccessAuthorizationDependencies,
  type LongLivedAccessRevocationReason,
} from './accessTokenAuthorization';
import {
  createProjectLifecycleWorkspace,
  prepareProjectLifecycleArtifactPromotion,
  spawnProjectLifecycleCommand,
  verifyProjectDependencyPromotionManifestAllNew,
  type PreparedProjectLifecycleArtifactPromotion,
  type ProjectLifecycleCommand,
  type ProjectLifecycleProcess,
  type ProjectLifecycleWorkspace,
  type ProjectLifecycleArtifactPromotionProjectProof,
} from './project-lifecycle.service';
import {
  authorizeProjectDependencyPromotion,
  attestProjectDependencyPromotionFenceReleaseState,
  deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup,
  markProjectDependencyPromotionApplied,
  quarantineProjectDependencyPromotion,
  ProjectDependencyPromotionDecisionIndeterminateError,
  type ProjectDependencyPromotionDecisionDatabase,
} from './projectDependencyPromotionDecision';
import {
  acquireProjectDeletionLock,
  assertHeldExpectedPreparedProjectPromotionLock,
  createExpectedPreparedProjectPromotionLockHandoff,
  projectDeletionLockKey,
  reacquireExpectedPreparedProjectPromotionLock,
  type ExpectedPreparedProjectPromotionLock,
  type ExpectedPreparedProjectPromotionLockHandoff,
  type ProjectDeletionLockLease,
} from './projectDeletionLock';
import {
  closeProjectDependencyPromotionWriterFence,
  PROJECT_DEPENDENCY_PROMOTION_CONTAINED_CODE,
  ProjectDependencyPromotionWriterFenceError,
  type ProjectDependencyPromotionWriterFence,
  type ProjectDependencyPromotionWriterFenceDependencies,
  type ProjectDependencyPromotionWriterFenceProof,
} from './projectDependencyPromotionWriterFence';
import type { WorkspaceAuthorizationFenceController } from './workspaceAuthorizationBarrier';

const PROJECT_DEPENDENCY_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const PYTHON_VENV_TIMEOUT_MS = 60_000;

export type ProjectDependencyInstallLanguage = 'python' | 'node';

export type ProjectDependencyInstallEvent =
  | { event: 'log'; data: { text: string; type: 'stdout' | 'stderr' } }
  | {
    event: 'progress';
    data: {
      text: string;
      progress: number;
      installed: number;
      total: number;
    };
  };

export type ProjectDependencyInstallResult =
  | { status: 'completed' }
  | {
    status: 'authorization_denied';
    reason: Extract<EstablishedLongLivedAccessResult, { ok: false }>['reason'];
  }
  | {
    status: 'cancelled';
    reason: 'client_closed' | 'authority_revoked';
    revocationReason?: LongLivedAccessRevocationReason;
  }
  | {
    status: 'failed';
    message: string;
    output?: string;
  };

export interface ProjectDependencyInstallInput {
  payload: JwtPayload;
  ownerId: string;
  projectName: string;
  projectId: string;
  projectDir: string;
  projectProof: ProjectLifecycleArtifactPromotionProjectProof;
  /** Exact owner/name lifecycle lock held by the route for this whole run. */
  lifecycleLock: ProjectDeletionLockLease;
  /** Atomically close global admission and exclude this exact admitted request. */
  closeGlobalAdmissionAndSettleRequest(): WorkspaceAuthorizationFenceController;
  /** Transfer route ownership away from the exact lease being released. */
  releaseLifecycleLock(lifecycleLock: ProjectDeletionLockLease): void;
  /** Transfer route ownership to the exact post-drain lease. */
  adoptLifecycleLock(lifecycleLock: ProjectDeletionLockLease): void;
  language: ProjectDependencyInstallLanguage;
  packages: string[];
  onAuthorized(identity: AuthorizedAccessIdentity): void;
  onEvent(event: ProjectDependencyInstallEvent['event'], data: ProjectDependencyInstallEvent['data']): void;
  onAuthorityLost(reason: LongLivedAccessRevocationReason): void;
  subscribeClientClose(listener: () => void): () => void;
  isClientClosed(): boolean;
  writeDependencyCache(targetProjectDir: string): void;
}

type SuccessfulAuthorization = Extract<EstablishedLongLivedAccessResult, { ok: true }>;

type EstablishProjectDependencyAuthorization = (
  payload: JwtPayload,
  onRevoke: (reason: LongLivedAccessRevocationReason) => void,
) => Promise<EstablishedLongLivedAccessResult>;

export interface ProjectDependencyInstallDependencies {
  authorization?: LongLivedAccessAuthorizationDependencies;
  establishAuthorization?: EstablishProjectDependencyAuthorization;
  decisionDatabase?: ProjectDependencyPromotionDecisionDatabase;
  authorizePromotion?: typeof authorizeProjectDependencyPromotion;
  markPromotionApplied?: typeof markProjectDependencyPromotionApplied;
  deletePromotionDecision?: typeof deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup;
  quarantinePromotion?: typeof quarantineProjectDependencyPromotion;
  attestFenceReleaseState?: typeof attestProjectDependencyPromotionFenceReleaseState;
  closeWriterFence?: typeof closeProjectDependencyPromotionWriterFence;
  writerFence?: ProjectDependencyPromotionWriterFenceDependencies;
  createLockHandoff?: typeof createExpectedPreparedProjectPromotionLockHandoff;
  reacquireLock?: typeof reacquireExpectedPreparedProjectPromotionLock;
  assertPromotionLock?: typeof assertHeldExpectedPreparedProjectPromotionLock;
  createWorkspace?: (sourceDir: string) => ProjectLifecycleWorkspace;
  spawnCommand?: (options: ProjectLifecycleCommand) => Promise<ProjectLifecycleProcess>;
  preparePromotion?: (
    workspace: string,
    destination: string,
    artifacts: readonly string[],
    projectProof: ProjectLifecycleArtifactPromotionProjectProof,
  ) => Promise<PreparedProjectLifecycleArtifactPromotion>;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  output: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export interface LockedProjectDependencyInstallTarget<TIdentity> {
  projectDir: string;
  identity: TIdentity;
  lifecycleLock: ProjectDeletionLockLease;
  release: ProjectDeletionLockLease;
}

/**
 * Resolve and attest a Project generation only after acquiring the same
 * owner/name lock used by create, delete, rename, and deploy. A queued install
 * therefore observes the replacement generation after delete+recreate instead
 * of retaining a path/identity captured from the retired Project.
 */
export async function acquireLockedProjectDependencyInstallTarget<TIdentity>(input: {
  ownerId: string;
  projectName: string;
  resolveProjectDir(): string;
  recoverProject?: (projectDir: string) => Promise<unknown>;
  resolveIdentity(projectDir: string): Promise<TIdentity>;
}): Promise<LockedProjectDependencyInstallTarget<TIdentity>> {
  const release = await acquireProjectDeletionLock(
    projectDeletionLockKey(input.ownerId, input.projectName),
  );
  try {
    const projectDir = input.resolveProjectDir();
    // acquireProjectDeletionLock's guard has already reconciled this exact
    // owner/name while holding the same lease. The injectable hook exists only
    // for focused tests/diagnostics and must not become a second recovery path.
    if (input.recoverProject) await input.recoverProject(projectDir);
    const identity = await input.resolveIdentity(projectDir);
    return { projectDir, identity, lifecycleLock: release, release };
  } catch (error) {
    release();
    throw error;
  }
}

class ProjectDependencyInstallCancelled extends Error {
  constructor() {
    super('Project dependency installation was cancelled');
    this.name = 'ProjectDependencyInstallCancelled';
  }
}

function waitForProcessExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }) => {
      if (settled) return;
      settled = true;
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      resolve(result);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ code, signal });
    };
    const onError = (error: Error) => {
      finish({ code: null, signal: null, error });
    };
    child.once('close', onClose);
    child.once('error', onError);

    // A short-lived command can settle before the caller resumes from the
    // asynchronous container preparation path. Do not wait for an event that
    // has already fired.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

/**
 * Run dependency installation under one durable Session authority. The
 * authority is acquired before the disposable workspace is copied and remains
 * live until the exact job/container and workspace have both been cleaned.
 */
export async function runAuthorizedProjectDependencyInstall(
  input: ProjectDependencyInstallInput,
  dependencies: ProjectDependencyInstallDependencies = {},
): Promise<ProjectDependencyInstallResult> {
  // Promotion admission requires a durable Session row. Legacy access tokens
  // cannot prove that an exact logout has not already retired their authority;
  // fail before SSE/workspace/container work so the route can return its
  // actionable 401 sign-in-again response.
  if (typeof input.payload.sessionId !== 'string' || !input.payload.sessionId.trim()) {
    return { status: 'authorization_denied', reason: 'session_revoked' };
  }
  const createWorkspace = dependencies.createWorkspace || createProjectLifecycleWorkspace;
  const spawnCommand = dependencies.spawnCommand || spawnProjectLifecycleCommand;
  const preparePromotion = dependencies.preparePromotion || prepareProjectLifecycleArtifactPromotion;
  const setTimer = dependencies.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer || ((timer) => clearTimeout(timer));
  const establishAuthorization = dependencies.establishAuthorization
    || ((payload, onRevoke) => establishLongLivedAccessAuthorization({
      payload,
      authorize: (identity) => canUseInteractivePortal(
        identity.role,
        identity.accountStatus,
        true,
      ),
      onRevoke,
      dependencies: dependencies.authorization,
    }));
  const authorizePromotion = dependencies.authorizePromotion || authorizeProjectDependencyPromotion;
  const markPromotionApplied = dependencies.markPromotionApplied || markProjectDependencyPromotionApplied;
  const deletePromotionDecision = dependencies.deletePromotionDecision
    || deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup;
  const quarantinePromotion = dependencies.quarantinePromotion
    || quarantineProjectDependencyPromotion;
  const attestFenceReleaseState = dependencies.attestFenceReleaseState
    || attestProjectDependencyPromotionFenceReleaseState;
  const closeWriterFence = dependencies.closeWriterFence
    || closeProjectDependencyPromotionWriterFence;
  const createLockHandoff = dependencies.createLockHandoff
    || createExpectedPreparedProjectPromotionLockHandoff;
  const reacquireLock = dependencies.reacquireLock
    || reacquireExpectedPreparedProjectPromotionLock;
  const assertPromotionLock = dependencies.assertPromotionLock
    || assertHeldExpectedPreparedProjectPromotionLock;

  let authority: SuccessfulAuthorization | null = null;
  let authorityDisposedByRevocation = false;
  let workspace: ProjectLifecycleWorkspace | null = null;
  let preparedPromotion: PreparedProjectLifecycleArtifactPromotion | null = null;
  let lifecycleLock: ProjectDeletionLockLease | null = input.lifecycleLock;
  let lockHandoff: ExpectedPreparedProjectPromotionLockHandoff | null = null;
  let expectedPromotionLock: ExpectedPreparedProjectPromotionLock | null = null;
  let writerFence: ProjectDependencyPromotionWriterFence | null = null;
  let writerFenceProof: ProjectDependencyPromotionWriterFenceProof | null = null;
  let writerFenceSafelyReleased = false;
  let promotionLinearized = false;
  let preservePromotionEvidence = false;
  let currentJob: ProjectLifecycleProcess | null = null;
  let currentJobCancelled = false;
  let unsubscribeClientClose = () => {};
  let clientCloseSubscribed = false;
  let cancelled = false;
  let cancellationReason: 'client_closed' | 'authority_revoked' = 'client_closed';
  let revocationReason: LongLivedAccessRevocationReason | undefined;
  let authorityLossReported = false;

  const attestFenceState = (
    expectedState: 'PREDECISION_CLEAN' | 'ACTIVE' | 'DEPENDENCY_QUARANTINED',
  ): Promise<void> => {
    // The lock handoff retains the immutable binding after private PREPARED
    // evidence is cleared and the prepared object is deliberately discarded.
    const manifest = preparedPromotion?.manifest;
    const operationId = manifest?.operationId || lockHandoff?.operationId;
    const manifestDigest = manifest?.manifestDigest || lockHandoff?.manifestDigest;
    if (!operationId || !manifestDigest) {
      throw new ProjectDependencyPromotionWriterFenceError(
        'Dependency-promotion release lost its immutable operation binding.',
      );
    }
    return attestFenceReleaseState({
      operationId,
      manifestDigest,
      projectIdentityId: input.projectProof.projectIdentityId,
      projectIdentityGeneration: input.projectProof.projectIdentityGeneration,
      workspaceOwnerId: input.ownerId,
      projectName: input.projectName,
      destinationCanonicalRoot: input.projectProof.canonicalRoot,
      destinationRootDevice: input.projectProof.rootDevice,
      destinationRootInode: input.projectProof.rootInode,
      destinationRootBirthtimeNs: input.projectProof.rootBirthtimeNs,
      expectedState,
      database: dependencies.decisionDatabase,
    });
  };

  const releaseWriterFenceAfter = async (
    expectedState: 'PREDECISION_CLEAN' | 'ACTIVE' | 'DEPENDENCY_QUARANTINED',
  ): Promise<void> => {
    if (!writerFence) return;
    const heldFence = writerFence;
    await heldFence.releaseAfterSafeState(() => attestFenceState(expectedState));
    writerFenceSafelyReleased = true;
    writerFence = null;
    writerFenceProof = null;
  };

  const ensurePostDrainLifecycleLock = async (): Promise<void> => {
    if (lifecycleLock) return;
    if (!lockHandoff) {
      throw new ProjectDependencyPromotionWriterFenceError(
        'The prepared dependency promotion lost its exact lock handoff.',
      );
    }
    let reacquired: ExpectedPreparedProjectPromotionLock;
    try {
      reacquired = await reacquireLock(lockHandoff);
    } catch {
      throw new ProjectDependencyPromotionWriterFenceError(
        'The exact Project lock could not be reacquired after writer drain.',
      );
    }
    try {
      input.adoptLifecycleLock(reacquired.lifecycleLock);
    } catch {
      reacquired.lifecycleLock();
      throw new ProjectDependencyPromotionWriterFenceError(
        'The exact Project lock ownership handoff could not be completed.',
      );
    }
    lifecycleLock = reacquired.lifecycleLock;
    expectedPromotionLock = reacquired;
  };

  const assertExactPromotionBoundary = () => {
    if (!preparedPromotion || !writerFence || !writerFenceProof || !expectedPromotionLock) {
      throw new ProjectDependencyPromotionWriterFenceError(
        'Dependency promotion lacks an exact writer-fence or lifecycle-lock proof.',
      );
    }
    writerFence.assertHeld(writerFenceProof);
    assertPromotionLock(
      expectedPromotionLock,
      preparedPromotion.manifest.operationId,
      preparedPromotion.manifest.manifestDigest,
    );
  };

  const cleanPredecisionEvidence = async (releaseFence: boolean): Promise<void> => {
    if (!preparedPromotion || promotionLinearized || preservePromotionEvidence) return;
    await ensurePostDrainLifecycleLock();
    if (!lifecycleLock?.isHeld()) {
      throw new ProjectDependencyPromotionWriterFenceError(
        'Predecision dependency staging cleanup lacks the exact Project lock.',
      );
    }
    let allOldAttested = false;
    try {
      preparedPromotion.reattest();
      allOldAttested = true;
    } catch {
      // A queued old admission may have replaced the Project while the
      // installer released its lock. Only exact private staging is removable
      // in that case; no live target is touched.
    }
    if (allOldAttested) await preparedPromotion.cleanup();
    else await preparedPromotion.cleanupPreparedStagingOnly();
    preparedPromotion = null;
    if (releaseFence) await releaseWriterFenceAfter('PREDECISION_CLEAN');
  };

  const containAuthorizedPromotion = async (): Promise<void> => {
    if (!preparedPromotion || !lifecycleLock?.isHeld() || !writerFence) {
      throw new ProjectDependencyPromotionWriterFenceError(
        'Authorized dependency promotion containment could not be proven; global admission remains closed.',
      );
    }
    try {
      await quarantinePromotion({
        operationId: preparedPromotion.manifest.operationId,
        manifestDigest: preparedPromotion.manifest.manifestDigest,
        lifecycleLock,
        database: dependencies.decisionDatabase,
      });
      await releaseWriterFenceAfter('DEPENDENCY_QUARANTINED');
    } catch {
      throw new ProjectDependencyPromotionWriterFenceError(
        'Authorized dependency promotion containment is indeterminate; global admission remains closed.',
      );
    }
  };

  const cancelCurrentJob = () => {
    if (!currentJob || currentJobCancelled) return;
    currentJobCancelled = true;
    try {
      currentJob.cancel();
    } catch {
      // Cleanup is still awaited below; cancellation must remain fail closed.
    }
  };

  const cancel = (
    reason: 'client_closed' | 'authority_revoked',
    revokedFor?: LongLivedAccessRevocationReason,
  ) => {
    if (!cancelled) {
      cancelled = true;
      cancellationReason = reason;
      revocationReason = revokedFor;
    }
    cancelCurrentJob();
    if (reason === 'authority_revoked' && !authorityLossReported && revokedFor) {
      authorityLossReported = true;
      try {
        input.onAuthorityLost(revokedFor);
      } catch {
        // Revocation and process cancellation must not depend on HTTP teardown.
      }
    }
  };

  const assertActive = () => {
    if (cancelled || input.isClientClosed()) {
      if (!cancelled) cancel('client_closed');
      else cancelCurrentJob();
      throw new ProjectDependencyInstallCancelled();
    }
  };

  const emit = (
    event: ProjectDependencyInstallEvent['event'],
    data: ProjectDependencyInstallEvent['data'],
  ) => {
    if (cancelled || input.isClientClosed()) return;
    try {
      input.onEvent(event, data);
    } catch {
      cancel('client_closed');
    }
  };

  const runCommand = async (
    options: ProjectLifecycleCommand,
    commandOptions: { stream: boolean; timeoutMs?: number },
  ): Promise<CommandResult> => {
    assertActive();
    const job = await spawnCommand(options);
    currentJob = job;
    currentJobCancelled = false;
    assertActive();

    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let installedCount = 0;
    let timedOut = false;
    let outputLimitExceeded = false;

    const collect = (chunk: Buffer | string): string => {
      const value = Buffer.from(chunk);
      outputBytes += value.length;
      if (outputBytes <= PROJECT_DEPENDENCY_OUTPUT_LIMIT_BYTES) {
        outputChunks.push(value);
      } else if (!outputLimitExceeded) {
        outputLimitExceeded = true;
        cancelCurrentJob();
      }
      return value.toString('utf8');
    };
    const onStdout = (chunk: Buffer | string) => {
      const text = collect(chunk);
      if (!commandOptions.stream) return;
      if (input.language === 'python') {
        const output = Buffer.concat(outputChunks).toString('utf8');
        const successMatches = output.match(/Successfully installed/gi);
        if (successMatches) {
          installedCount = Math.min(successMatches.length, input.packages.length);
        }
      }
      const progress = input.packages.length > 0
        ? Math.min(90, (installedCount / input.packages.length) * 90)
        : 50;
      emit('progress', {
        text: text.trim(),
        progress: Math.round(progress),
        installed: installedCount,
        total: input.packages.length,
      });
    };
    const onStderr = (chunk: Buffer | string) => {
      const text = collect(chunk);
      if (commandOptions.stream) emit('log', { text: text.trim(), type: 'stderr' });
    };
    job.process.stdout?.on('data', onStdout);
    job.process.stderr?.on('data', onStderr);

    let timer: NodeJS.Timeout | null = null;
    if (commandOptions.timeoutMs !== undefined) {
      timer = setTimer(() => {
        timedOut = true;
        cancelCurrentJob();
      }, commandOptions.timeoutMs);
      timer.unref?.();
    }

    const exit = await waitForProcessExit(job.process).finally(() => {
      if (timer) clearTimer(timer);
      job.process.stdout?.removeListener('data', onStdout);
      job.process.stderr?.removeListener('data', onStderr);
    });
    assertActive();
    await job.cleanup;
    assertActive();
    currentJob = null;
    currentJobCancelled = false;

    return {
      ...exit,
      output: Buffer.concat(outputChunks).toString('utf8'),
      timedOut,
      outputLimitExceeded,
    };
  };

  try {
    unsubscribeClientClose = input.subscribeClientClose(() => cancel('client_closed'));
    clientCloseSubscribed = true;
    if (input.isClientClosed()) cancel('client_closed');

    const authorization = await establishAuthorization(input.payload, (reason) => {
      authorityDisposedByRevocation = true;
      cancel('authority_revoked', reason);
    });
    assertActive();
    if (!authorization.ok) {
      return { status: 'authorization_denied', reason: authorization.reason };
    }
    authority = authorization;
    input.onAuthorized(authorization.identity);
    assertActive();

    workspace = createWorkspace(input.projectDir);
    assertActive();

    if (input.language === 'python') {
      emit('log', {
        text: 'Creating isolated virtual environment...',
        type: 'stdout',
      });
      const venv = await runCommand({
        actorId: input.payload.userId,
        projectId: input.projectId,
        workspace: workspace.path,
        command: 'python3',
        args: ['-m', 'venv', '.venv'],
        timeoutMs: PYTHON_VENV_TIMEOUT_MS,
        nameHint: `${input.ownerId}:${input.projectName}:venv`,
      }, { stream: false, timeoutMs: PYTHON_VENV_TIMEOUT_MS });
      assertActive();
      if (venv.timedOut) {
        return { status: 'failed', message: 'Virtual environment creation timed out', output: venv.output };
      }
      if (venv.outputLimitExceeded) {
        return { status: 'failed', message: 'Virtual environment creation output limit exceeded', output: venv.output };
      }
      if (venv.error) {
        return { status: 'failed', message: venv.error.message, output: venv.output };
      }
      if (venv.code !== 0) {
        return {
          status: 'failed',
          message: `Virtual environment creation failed with code ${venv.code ?? venv.signal}`,
          output: venv.output,
        };
      }
    }

    const install = await runCommand({
      actorId: input.payload.userId,
      projectId: input.projectId,
      workspace: workspace.path,
      command: input.language === 'python'
        ? '/workspace/project/.venv/bin/pip'
        : 'npm',
      args: input.language === 'python'
        ? ['install', ...input.packages]
        : ['install', '--no-audit', '--no-fund'],
      nameHint: `${input.ownerId}:${input.projectName}:${input.language === 'python' ? 'pip' : 'npm-install'}`,
      network: true,
    }, { stream: true });
    assertActive();
    if (install.outputLimitExceeded) {
      return { status: 'failed', message: 'Dependency installation output limit exceeded', output: install.output };
    }
    if (install.error) {
      return { status: 'failed', message: install.error.message, output: install.output };
    }
    if (install.code !== 0) {
      return {
        status: 'failed',
        message: `Installation failed with code ${install.code ?? install.signal}`,
        output: install.output,
      };
    }

    // Stage both dependency artifacts and the atomic cache marker outside the
    // live Project. Revocation during this async copy cleans staging only.
    assertActive();
    input.writeDependencyCache(workspace.path);
    assertActive();
    preparedPromotion = await preparePromotion(
      workspace.path,
      input.projectDir,
      input.language === 'python'
        ? ['.venv', '.deps-installed']
        : ['node_modules', 'package-lock.json', '.deps-installed'],
      input.projectProof,
    );
    assertActive();

    // Prove the staged generation once while the original exact Project lock
    // is still held, then bind the only permitted post-drain reacquire to this
    // immutable operation and manifest.
    preparedPromotion.reattest();
    lockHandoff = createLockHandoff({
      lifecycleLock: input.lifecycleLock,
      operationId: preparedPromotion.manifest.operationId,
      manifestDigest: preparedPromotion.manifest.manifestDigest,
    });

    // The installer's long-lived authority subscribes to the same global
    // fence used to cancel every other transport. Detach it first so closing
    // its own fence cannot self-cancel. Client-close observation remains live,
    // and the authorization transaction below re-locks the durable User and
    // exact Session immediately before ACTIVE -> PROMOTING.
    authority.dispose();
    authority = null;
    authorityDisposedByRevocation = true;
    writerFence = closeWriterFence({
      closeAdmissionAndSettleInstaller: input.closeGlobalAdmissionAndSettleRequest,
      releaseProjectLease: () => {
        const held = lifecycleLock;
        if (!held || !held.isHeld()) {
          throw new Error('The installer no longer owns its exact Project lock');
        }
        input.releaseLifecycleLock(held);
        lifecycleLock = null;
      },
    }, dependencies.writerFence);
    writerFenceProof = await writerFence.proveQuiescent();
    await ensurePostDrainLifecycleLock();
    assertExactPromotionBoundary();
    assertActive();
    // A queued mutation admitted before global closure may have run while the
    // lock was released. Re-attest the original root and every recursive staged
    // tree now; any mismatch aborts before the DB decision or a live rename.
    preparedPromotion.reattest();
    assertExactPromotionBoundary();

    // The database decision is the linearization point. Its transaction
    // re-locks durable User/Session and the exact Project identity/generation.
    // Filesystem commit follows synchronously while the global fence and exact
    // handoff lock remain held.
    let promotionAuthorization;
    try {
      promotionAuthorization = await authorizePromotion({
        operationId: preparedPromotion.manifest.operationId,
        actor: input.payload,
        projectIdentityId: input.projectProof.projectIdentityId,
        projectIdentityGeneration: input.projectProof.projectIdentityGeneration,
        workspaceOwnerId: input.ownerId,
        projectName: input.projectName,
        destinationCanonicalRoot: input.projectProof.canonicalRoot,
        destinationRootDevice: input.projectProof.rootDevice,
        destinationRootInode: input.projectProof.rootInode,
        destinationRootBirthtimeNs: input.projectProof.rootBirthtimeNs,
        manifest: preparedPromotion.manifest,
        database: dependencies.decisionDatabase,
      });
    } catch (error) {
      if (error instanceof ProjectDependencyPromotionDecisionIndeterminateError) {
        preservePromotionEvidence = true;
        throw new ProjectDependencyPromotionWriterFenceError(
          'The dependency-promotion authorization decision is indeterminate; global admission remains closed.',
        );
      }
      throw error;
    }
    if (promotionAuthorization.kind !== 'authorized') {
      if (promotionAuthorization.reason === 'PROJECT_BUSY') {
        await cleanPredecisionEvidence(true);
        return {
          status: 'failed',
          message: 'Finish or stop the active Project Chat turn before installing dependencies.',
        };
      }
      if (promotionAuthorization.reason !== 'AUTHORIZATION_CHANGED') {
        await cleanPredecisionEvidence(true);
        return {
          status: 'failed',
          message: 'The Project changed before dependency promotion could be authorized.',
        };
      }
      cancel(
        'authority_revoked',
        'authorization_changed',
      );
      assertActive();
    }
    // From here on, revocation/client close affects only the response. The
    // already-authorized filesystem decision must converge all-new.
    promotionLinearized = true;
    try {
      assertExactPromotionBoundary();
      preparedPromotion.commit();
      preparedPromotion.finalize();
      const applied = await markPromotionApplied({
        operationId: preparedPromotion.manifest.operationId,
        manifestDigest: preparedPromotion.manifest.manifestDigest,
        database: dependencies.decisionDatabase,
      });
      if (applied.status !== 'APPLIED') {
        throw new Error('Project dependency promotion decision did not become applied');
      }
      await preparedPromotion.cleanup();
      await deletePromotionDecision({
        operationId: preparedPromotion.manifest.operationId,
        manifestDigest: preparedPromotion.manifest.manifestDigest,
        lifecycleLock: lifecycleLock!,
        verifyAppliedGeneration: verifyProjectDependencyPromotionManifestAllNew,
        database: dependencies.decisionDatabase,
      });
      await releaseWriterFenceAfter('ACTIVE');
    } catch {
      preservePromotionEvidence = true;
      await containAuthorizedPromotion();
      throw new ProjectDependencyPromotionWriterFenceError(
        'Dependency promotion failed after authorization and is durably quarantined.',
        false,
        PROJECT_DEPENDENCY_PROMOTION_CONTAINED_CODE,
      );
    }
    preparedPromotion = null;
    return cancelled
      ? { status: 'cancelled', reason: cancellationReason, ...(revocationReason ? { revocationReason } : {}) }
      : { status: 'completed' };
  } catch (error) {
    if (preparedPromotion && !preservePromotionEvidence && !promotionLinearized) {
      // An unproven root-writer residual is a global hold even though this
      // installer's private PREPARED evidence can be removed safely. Reopening
      // here would erase the exact containment signal reported to the caller.
      const retainFence = error instanceof ProjectDependencyPromotionWriterFenceError
        && error.fenceRetained;
      try {
        await cleanPredecisionEvidence(!retainFence);
      } catch (cleanupError) {
        preservePromotionEvidence = true;
        if (cleanupError instanceof ProjectDependencyPromotionWriterFenceError) throw cleanupError;
        const cleanupFenceRetained = retainFence || Boolean(writerFence?.isHeld());
        throw new ProjectDependencyPromotionWriterFenceError(
          cleanupFenceRetained
            ? 'Predecision dependency staging could not be cleaned safely; global admission remains closed.'
            : 'Predecision dependency staging could not be cleaned safely.',
          cleanupFenceRetained,
        );
      }
    }
    if (error instanceof ProjectDependencyInstallCancelled) {
      return {
        status: 'cancelled',
        reason: cancellationReason,
        ...(revocationReason ? { revocationReason } : {}),
      };
    }
    if (
      error instanceof ProjectDependencyPromotionWriterFenceError
      && writerFenceSafelyReleased
      && error.fenceRetained
    ) {
      throw new ProjectDependencyPromotionWriterFenceError(
        error.message,
        false,
        error.code,
        error.statusCode,
      );
    }
    throw error;
  } finally {
    try {
      const jobToClean = currentJob as ProjectLifecycleProcess | null;
      if (jobToClean) {
        cancelCurrentJob();
        await jobToClean.cleanup.catch(() => undefined);
        currentJob = null;
      }
    } finally {
      try {
        workspace?.cleanup();
        workspace = null;
      } finally {
        if (clientCloseSubscribed) unsubscribeClientClose();
        if (authority && !authorityDisposedByRevocation) authority.dispose();
      }
    }
  }
}
