import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import multer from 'multer';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { Prisma, type App, type ProjectChatTurn } from '@prisma/client';
import { authenticateToken, browserAuthRedirect } from '../middleware/auth';
import { projectPathSandbox } from '../middleware/pathSandbox';
import { requireApproved } from '../middleware/requireApproved';
import { requireOwner } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { nanoid } from 'nanoid';
import {
  getSessionInfo,
  listGatewayModels,
} from '../utils/openclawGatewayRpc';
import { steerActiveRun } from '../agents/providers/PersistentGatewayWs';
import {
  detectDeployType,
  allocatePort,
  startApp,
  restartApp,
  stopApp,
  forgetAppRuntime,
  getAppStatus,
  ProjectRuntimeStateAttestationError,
  type ProjectAppStartIdentity,
} from '../services/app-process.service';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import { desktopExec, desktopExecManaged } from '../utils/desktopEnv';
import {
  createProjectLifecycleWorkspace,
  assertProjectRuntimeImageAvailable,
  copyDesktopRuntimeDeploymentTree,
  copyStaticDeploymentTree,
  prepareFullstackDeploymentTree,
  ProjectDeploymentReplayStaleError,
  ProjectLifecycleWorkspacePreparationError,
  ProjectRuntimeImageUnavailableError,
  runProjectLifecycleCommand,
  attestQuarantinedProjectDependencyPromotionRepairable,
  type ProjectDeploymentPromotion,
} from '../services/project-lifecycle.service';
import {
  acquireLockedProjectDependencyInstallTarget,
  runAuthorizedProjectDependencyInstall,
} from '../services/projectDependencyInstall';
import {
  assertProjectRuntimeLifecycleMutable,
  projectExternalRuntimeConflict,
  projectInvalidRuntimeBindingConflict,
  ProjectExternalRuntimeLifecycleError,
  ProjectInvalidRuntimeBindingError,
  PROJECT_EXTERNAL_RUNTIME_ERROR_CODE,
  PROJECT_EXTERNAL_RUNTIME_LIMITATION,
  PROJECT_INVALID_RUNTIME_BINDING_ERROR_CODE,
  PROJECT_INVALID_RUNTIME_BINDING_LIMITATION,
  probeExternalLoopbackRuntime,
  projectRuntimeManagement,
  projectRuntimeStatusSource,
  projectSupportedLifecycleActions,
} from '../services/projectRuntimeManagement';
import {
  advanceProjectDeploymentLifecycleRevision,
  claimProjectRuntimeRecoveryProof,
  completeProjectRuntimeRecovery,
  failProjectRuntimeRecovery,
  issueProjectRuntimeRecoveryProof,
  readProjectDeploymentLifecycleRevision,
  readProjectRuntimeRecoveryStatus,
  ProjectRuntimeRecoveryReplayError,
  type ProjectRuntimeRecoveryResponse,
  type ProjectRuntimeRecoveryScope,
  type ProjectRuntimeRecoveryStatus,
} from '../services/projectRuntimeRecoveryReplay';
import {
  assertSafeProjectGitUrl,
  runPreparedProjectGitCommand,
  runProjectGitCommand,
} from '../services/project-git.service';
import { getDefaultModel, getProviderStatusesAsync } from '../services/openclawConfigManager';
import { canonicalizeProviderModelId, normalizePortalModelId } from '../utils/openclawCli';
import { scanFile } from '../services/virusScan';
import { PROJECT_ZIP_LIMITS, safeExtractZipToNewDirectory } from '../services/safeZipExtraction';
import {
  ContainedPathError,
  ensureContainedDirectory,
  resolveContainedPath,
} from '../services/containedPath';
import { removeToolMirror, resolveFilePath } from './files';
import {
  parseShareLinkOptions,
  shareCredentialStateIsValid,
  shareLinkAvailability,
  validateSharePassword,
} from '../utils/shareAccessSecurity';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';
import { portalFeatureUnavailableResponse } from '../utils/portalFeatureCapabilities';
import {
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_METADATA_MAX_BYTES,
  ProjectFilePolicyError,
  ProjectRangeError,
  parseProjectByteRange,
  readProjectTextFile,
  safeProjectDownloadName,
  statProjectRegularFile,
  writeProjectRuntimeTextFile,
} from '../services/projectSurfacePolicy';
import {
  assignProjectRuntimeOwnership,
  ensureProjectRuntimeOwnedDirectory,
  ProjectRuntimeOwnershipError,
  writeProjectRuntimeOwnedFileAtomic,
} from '../services/projectRuntimeOwnership';
import { ensureProjectChatWorkspaceOwnership } from '../services/projectChatWorkspaceOwnership';
import type { AgentProviderName, ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import {
  deleteNativeSession,
  listNativeProjectSessions,
  loadNativeSession,
  nativeSessionArtifactsPresent,
  saveNativeSession,
  updateNativeSessionModel,
} from '../agents/providers/NativeSessionStore';
import { executionContextsMatch } from '../agents/executionScope';
import { canUseDesktopRuntimeDeployment } from '../utils/authz';
import {
  NATIVE_CLI_PROJECT_CONTAINER_ROOT,
} from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import { presentProjectQualificationError } from '../services/projectQualificationErrorPresentation';
import { writeProjectSessionProjectionBestEffort } from '../services/projectSessionProjection';
import {
  ProjectMemoryAccessError,
  ensureProjectMemory,
  readProjectMemory,
} from '../services/projectMemory';
import {
  abortProjectNativeRun,
  clearProjectNativeRun,
  getProjectNativeRunSnapshot,
  PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
  quiesceProjectNativeRunForDestructiveReset,
  startProjectNativeRun,
  waitForProjectNativeRunSettlement,
  type ProjectNativeRunEvent,
} from '../services/projectNativeRunBroker';
import {
  acquireWorkspaceAuthorizationMutationLease,
  closeGlobalWorkspaceAuthorizationAdmissionExcludingRequest,
  settleWorkspaceAuthorizationRequest,
  closeGlobalWorkspaceAuthorizationAdmission,
} from '../services/workspaceAuthorizationBarrier';
import {
  closeProjectDependencyPromotionWriterFence,
  ProjectDependencyPromotionWriterFenceError,
  type ProjectDependencyPromotionWriterFence,
} from '../services/projectDependencyPromotionWriterFence';
import {
  attestProjectDependencyRepairBackupFingerprint,
  attestProjectDependencyRepairBackupLock,
  authorizeProjectDependencyForceForward,
  createOrAttestProjectDependencyRepairBackupLock,
  discardPreparedProjectDependencyRepairEvidence,
  executeProjectDependencyForceForward,
  inspectProjectDependencyRepairStatus,
  listActiveProjectDependencyRepairsForOwner,
  normalizeProjectDependencyRepairBackup,
  prepareProjectDependencyRepairEvidence,
  ProjectDependencyRepairError,
  releaseProjectDependencyRepairBackupLock,
  releaseProjectDependencyRepairBackupLockSnapshot,
  PROJECT_DEPENDENCY_REPAIR_ACTION,
  type ProjectDependencyRepairRecord,
} from '../services/projectDependencyRepair';
import {
  acquireBackupMutationLock,
  assertBackupMutationLockLease,
  type BackupMutationLockLease,
} from '../services/backup.service';
import {
  attestProjectDependencyPromotionFenceReleaseState,
} from '../services/projectDependencyPromotionDecision';
import {
  inspectMaintenanceBackupAdmission,
  verifyMaintenanceBackupArchive,
  type MaintenanceBackupCandidate,
} from './system-maintenance';
import { isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import {
  buildProjectChatMessagePresentation,
  parseProjectChatMessagePresentation,
  retainNewestProjectChatPresentationEvents,
  shouldRepairProjectChatPresentation,
} from '../services/projectChatPresentation';
import {
  OpenClawProjectModelVerificationError,
  isOpenClawProjectEmbeddedModel,
  listAvailableOpenClawProjectModels,
  readVerifiedOpenClawSessionModel,
  resolveAllowedOpenClawProjectModel,
  verifyThenPersistOpenClawProjectModel,
} from '../services/openclawProjectModel';
import {
  assertNoTransientProjectStateStaged,
  isTransientProjectStatePath,
  projectGitAddAllArgs,
  runProjectCheckpointBoundary,
  shelveTransientProjectState,
} from '../services/projectCheckpoint';
import {
  ProjectSearchCapacityError,
  runProjectWorkspaceSearch,
} from '../services/projectSearch';
import {
  ProjectChatBindingReadError,
  readExistingProjectChatBinding,
} from '../services/projectChatBindingRead';
import {
  CodexProjectModelSelectionError,
  codexCliModelId,
  resolveAllowedCodexProjectModel,
} from '../services/codexProjectModel';
import {
  ClaudeCodeProjectModelSelectionError,
  claudeCodeCliModelId,
  resolveAllowedClaudeCodeProjectModel,
} from '../services/claudeCodeProjectModel';
import {
  AntigravityProjectModelSelectionError,
  resolveAllowedAntigravityProjectModel,
} from '../services/antigravityProjectModel';
import {
  OllamaProjectModelSelectionError,
  parseOllamaProjectModelBinding,
  resolveAllowedOllamaProjectModel,
  type OllamaProjectModelSelection,
} from '../services/ollamaProjectModel';
import {
  OllamaAuthorityBarrierBusyError,
  withOllamaAuthorityRunLease,
} from '../services/ollamaAuthorityBarrier';
import {
  AgentZeroProjectModelSelectionError,
  agentZeroProjectModelBindingValue,
  parseAgentZeroProjectModelBinding,
  resolveAllowedAgentZeroProjectModel,
} from '../services/agentZeroProjectModel';
import type {
  AgentZeroProjectModelSelection,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';
import {
  AgentZeroOAuthError,
  getDefaultAgentZeroOAuthClient,
} from '../agents/providers/agentZero/AgentZeroOAuthControl';
import {
  filterAgentZeroOAuthModelsForProjectQualification,
} from '../agents/providers/agentZero/AgentZeroOAuthModelCatalog';
import { normalizeAntigravityProjectModel } from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';
import {
  UnsupportedProjectChatProviderError,
  buildProjectChatCapabilityResponse,
  buildProjectChatProviderHandoff,
  buildQualifiedProjectChatProviderCapability,
  buildDiscoveryProjectSandboxExecutionContext,
  buildUnqualifiedProjectSandboxExecutionContext,
  ensureProjectChatProviderBinding,
  getProjectChatProviderCapability,
  listProjectChatBindings,
  listProjectChatProviderCapabilities,
  normalizeProjectChatProvider,
  planProjectChatProviderSwitch,
  resolveProjectChatQualificationMatrix,
  serializeProjectSandboxContext,
} from '../services/projectChatKernel';
import {
  abandonProjectIdentityRenameBeforeCleanup,
  attestProjectRoot,
  assertProjectIdentityNameAvailable,
  beginProjectIdentityRename,
  beginProjectIdentityDeletion,
  cancelProjectIdentityRename,
  createCurrentProjectIdentity,
  ensureProjectIdentity,
  finalizeCurrentProjectIdentityCreation,
  isInternalProjectDirectoryName,
  markProjectIdentityRenameCleanupStarted,
  markProjectIdentityRenameRuntimeCleaned,
  moveAttestedDirectoryNoReplace,
  readProjectIdentityRenameDeployIdentity,
  readCompletedProjectIdentityRename,
  readProjectIdentity,
  readProjectIdentityRenameJournal,
  beginOrphanedProjectIdentityDeletion,
  recoverInterruptedProjectIdentityRename,
  projectLifecycleBlockedMessage,
  renameProjectIdentity,
  renewProjectIdentityRenameLease,
  ProjectIdentityLifecycleError,
  ProjectIdentityMismatchError,
  type AttestedDirectoryIdentity,
  type AttestedProjectRoot,
  type ProjectIdentityRecord,
  type ProjectIdentityDatabase,
} from '../services/projectIdentity';
import {
  ProjectRuntimeCleanupError,
  cleanupProjectRuntime,
  type ProjectRuntimeCleanupScope,
  type ProjectRuntimeResource,
} from '../services/projectRuntimeCleanup';
import { createDefaultProjectRuntimeCleanupAdapters } from '../services/projectRuntimeCleanupAdapters';
import { createProjectEgressCleanupAdapter } from '../services/projectEgressCleanupAdapter';
import {
  migrateLegacyProjectChatState,
} from '../services/projectChatLegacyMigration';
import {
  PROJECT_QUALIFICATION_WINDOW_MS,
  projectQualificationRateLimitKey,
  projectQualificationRetryAt,
  type ProjectQualificationRateLimitIdentity,
} from '../services/projectQualificationRateLimit';
import {
  prepareProjectLegacyAdoptionStaging,
  ProjectLegacyAdoptionError,
  verifyProjectLegacyAdoptionManifestSummary,
} from '../services/projectLegacyAdoption';
import {
  beginProjectAppRebindOperation,
  beginProjectCopyOperation,
  assertProjectMigrationTargetOwnedByOperation,
  bindProjectAppRebindTarget,
  ProjectAppIdentityRebindError,
  readProjectAppRebindOperation,
  recordProjectAppRebindManifest,
  rebindLegacyProjectAppToCurrentCopy,
} from '../services/projectAppIdentityRebind';
import {
  assertNoLegacyOpenClawProjectCreationCollision,
  assertNoLegacyOpenClawProjectEvidence,
  assertLegacyOpenClawProjectMigrationInactive,
  LegacyOpenClawProjectCreationCollisionError,
  LegacyOpenClawProjectCreationScanCapacityError,
  LegacyOpenClawProjectMigrationActiveError,
} from '../services/legacyOpenClawProjectRetirement';
import { LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE } from '../services/legacyOpenClawRetirementPolicy';
import { retireLegacyOpenClawProjectRuntime } from '../services/projectChatLegacyRuntimeCleanup';
import {
  deriveOpenClawProjectAgentId,
  deriveOpenClawProjectSessionKey,
  ensureOpenClawProjectSandbox,
} from '../services/openclawProjectSandbox';
import { buildProjectEgressConfig } from '../services/projectEgressCredentials';
import {
  QUALIFIABLE_PROJECT_PROVIDERS,
  getProjectQualificationStatus,
  qualifyProjectProvider,
  removeProjectQualificationEvidenceForProject,
  requireProjectQualification,
  type QualifiableProjectProvider,
} from '../services/projectQualificationRegistry';
import {
  ProjectChatProviderRuntimeUnavailableError,
  getProjectChatProviderAdapter,
  getProjectChatProviderRuntimeDescriptor,
  isQualifiableProjectProvider,
  projectChatProviderDisplayName,
  rebindAgentZeroProjectSessionModel,
} from '../services/projectChatProviderRegistry';
import {
  PortalProjectWorkloadError,
  removePortalProjectWorkloadsForProject,
} from '../services/projectWorkloadRuntime';
import {
  acquireProjectDeletionLock,
  acquireProjectDeletionLockWithoutGuard,
  projectDeletionLockKey,
  type ProjectDeletionLockLease,
  withProjectDeletionLock,
} from '../services/projectDeletionLock';
import {
  resolveProjectStoragePaths,
  type ProjectStorageOptions,
} from '../services/projectStoragePaths';
import {
  buildProjectDesktopRuntimeIdentity,
  ensureSecureProjectDesktopRuntimeRoot,
  projectDesktopRuntimeAppState,
  projectDesktopRuntimeCleanupDirectories,
} from '../services/projectDesktopRuntime';
import {
  ProjectChatLeaseError,
  PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX,
  PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
  PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED,
  acquireProjectChatRuntimeAdmission,
  appendProjectChatTurnEvent,
  confirmProjectChatTurnAbort,
  createProjectChatDispatchPersistenceGate,
  ensureProjectChatState,
  finishProjectChatRuntimeAdmission,
  finishProjectChatTurn,
  markProjectChatTurnProviderDispatchAccepted,
  promoteProjectChatRuntimeAdmissionToTurn,
  projectChatBindingNeedsHandoff,
  projectChatTurnDispatchStage,
  reconcileLegacyProjectChatTerminalHandoff,
  readProjectChatCoordinationState,
  readProjectChatTurnReplay,
  isProjectChatRuntimeAdmissionTurn,
  renewProjectChatTurnLease,
  requestProjectChatTurnAbort,
  withProjectChatRuntimeAdmission,
  type ProjectChatPersistedProvider,
  type ProjectChatAssistantProjection,
} from '../services/projectChatTurnLease';
import {
  assertProjectChatDestructiveResetInactive,
  commitProjectChatDestructiveReset,
  markProjectChatDestructiveResetStarted,
  ProjectChatDestructiveResetActiveError,
  recoverExpiredProjectChatRuntimeAdmissionForDestructiveReset,
  requireConfirmedProjectChatAbortForReset,
} from '../services/projectChatDestructiveReset';
import { readProjectChatProviderHandoffSuffix } from '../services/projectChatHandoff';
import {
  isProjectNativeSettlementFailure,
  matchingProjectNativeSnapshot,
  resolveProjectChatReplayLineCount,
  visibleProjectChatActiveTurn,
} from '../services/projectChatReplayPolicy';
import { resolveAskUserQuestionRunOwner } from '../services/askUserQuestionSessionOwner';

/** Shell-escape a filename for safe use in execSync commands */
function shellEscape(s: string): string {
  // Replace single quotes with escaped version, then wrap in single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function processLookupReportedAbsent(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { status?: unknown }).status === 1;
}

function desktopRuntimeProcessIds(marker: string): number[] {
  try {
    execFileSync('id', ['-u', 'bridgesrd'], { timeout: 3_000, stdio: 'ignore' });
  } catch (error) {
    if (processLookupReportedAbsent(error)) return [];
    throw error;
  }
  let output: string;
  try {
    output = execFileSync('pgrep', ['-u', 'bridgesrd'], {
      timeout: 3_000,
      encoding: 'utf8',
    });
  } catch (error) {
    if (processLookupReportedAbsent(error)) return [];
    throw error;
  }
  const ids = output.split(/\s+/).filter(Boolean);
  if (ids.some((value) => !/^[1-9][0-9]*$/.test(value))) {
    throw new Error('Remote Desktop process discovery returned an invalid process identity');
  }
  const shellPathToken = path.isAbsolute(marker) ? shellEscape(marker) : null;
  return ids.flatMap((value) => {
    const processId = Number(value);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(`/proc/${processId}/cmdline`);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const args = raw.toString('utf8').split('\0').filter(Boolean);
    const matches = shellPathToken
      ? args.some((argument) => argument === marker || argument.includes(shellPathToken))
      : args.includes(marker);
    return matches ? [processId] : [];
  });
}

function stopDesktopRuntimeProcess(marker: string): void {
  const signal = (processIds: readonly number[], name: 'SIGTERM' | 'SIGKILL') => {
    for (const processId of processIds) {
      try {
        process.kill(processId, name);
      } catch (error: any) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  };
  signal(desktopRuntimeProcessIds(marker), 'SIGTERM');
  if (isDesktopRuntimeProcessRunning(marker)) {
    signal(desktopRuntimeProcessIds(marker), 'SIGKILL');
  }
  if (isDesktopRuntimeProcessRunning(marker)) {
    throw new Error('Remote Desktop Project runtime remained after its exact process stop');
  }
}

function isDesktopRuntimeProcessRunning(processMarker: string): boolean {
  return desktopRuntimeProcessIds(processMarker).length > 0;
}

function desktopRuntimeUnitProperty(unitName: string, property: string): string {
  return execFileSync('systemctl', [
    'show',
    unitName,
    `--property=${property}`,
    '--value',
  ], {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
}

function desktopRuntimeCgroupHasProcesses(controlGroup: string): boolean {
  if (!controlGroup) return false;
  if (!controlGroup.startsWith('/system.slice/') || controlGroup.includes('..')) {
    throw new ProjectIdentityLifecycleError('Managed Remote Desktop cgroup identity is invalid');
  }
  const cgroupRoot = path.resolve('/sys/fs/cgroup', `.${controlGroup}`);
  if (!cgroupRoot.startsWith('/sys/fs/cgroup/system.slice/')) {
    throw new ProjectIdentityLifecycleError('Managed Remote Desktop cgroup escaped system.slice');
  }
  if (!managedPathExists(cgroupRoot)) return false;
  const pending = [cgroupRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const processesPath = path.join(current, 'cgroup.procs');
    if (managedPathExists(processesPath) && fs.readFileSync(processesPath, 'utf8').trim()) return true;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

function stopManagedDesktopRuntimeUnit(unitName: string): void {
  const loadState = desktopRuntimeUnitProperty(unitName, 'LoadState');
  if (loadState === 'not-found') return;
  execFileSync('systemctl', ['stop', unitName], { timeout: 20_000 });
  const activeState = desktopRuntimeUnitProperty(unitName, 'ActiveState');
  const controlGroup = desktopRuntimeUnitProperty(unitName, 'ControlGroup');
  if (
    !['inactive', 'failed'].includes(activeState)
    || desktopRuntimeCgroupHasProcesses(controlGroup)
  ) {
    throw new ProjectIdentityLifecycleError(
      'Managed Remote Desktop Project process tree remained after cgroup stop',
    );
  }
  try {
    execFileSync('systemctl', ['reset-failed', unitName], { timeout: 5000 });
  } catch {
    // A collected transient unit may disappear immediately after stop.
  }
}

function isManagedDesktopRuntimeUnitRunning(unitName: string): boolean {
  const loadState = desktopRuntimeUnitProperty(unitName, 'LoadState');
  return loadState !== 'not-found'
    && ['active', 'activating'].includes(desktopRuntimeUnitProperty(unitName, 'ActiveState'));
}

function managedPathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sameAttestedDirectoryIdentity(
  expected: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>,
  actual: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>,
): boolean {
  return expected.rootDevice === actual.rootDevice
    && expected.rootInode === actual.rootInode
    && expected.rootBirthtimeNs === actual.rootBirthtimeNs;
}

function lifecycleQuarantineRoot(parent: string): string {
  const resolvedParent = path.resolve(parent);
  const parentIdentity = attestProjectRoot(resolvedParent);
  if (parentIdentity.canonicalRoot !== resolvedParent) {
    throw new ProjectIdentityLifecycleError(
      'Project lifecycle quarantine parent resolved through an unexpected path',
    );
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  let trustedAnchor = resolvedParent;
  while (true) {
    const entry = fs.lstatSync(trustedAnchor);
    const identity = attestProjectRoot(trustedAnchor);
    if (
      identity.canonicalRoot === trustedAnchor
      && identity.rootDevice === parentIdentity.rootDevice
      && entry.uid === currentUid
      && (entry.mode & 0o022) === 0
    ) {
      break;
    }
    const next = path.dirname(trustedAnchor);
    if (next === trustedAnchor) {
      throw new ProjectIdentityLifecycleError(
        'No server-owned same-filesystem Project lifecycle quarantine anchor exists',
      );
    }
    const nextIdentity = attestProjectRoot(next);
    if (nextIdentity.rootDevice !== parentIdentity.rootDevice) {
      throw new ProjectIdentityLifecycleError(
        'Project lifecycle quarantine cannot cross a filesystem boundary',
      );
    }
    trustedAnchor = next;
  }
  const quarantineRoot = path.join(trustedAnchor, '.bridgesllm-lifecycle-quarantine');
  try {
    fs.mkdirSync(quarantineRoot, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const entry = fs.lstatSync(quarantineRoot);
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || entry.uid !== currentUid
    || (entry.mode & 0o077) !== 0
  ) {
    throw new ProjectIdentityLifecycleError('Project lifecycle quarantine root is not server-private');
  }
  if (attestProjectRoot(quarantineRoot).canonicalRoot !== quarantineRoot) {
    throw new ProjectIdentityLifecycleError(
      'Project lifecycle quarantine root resolved through an unexpected path',
    );
  }
  return quarantineRoot;
}

async function removeDirectoryThroughAttestedQuarantine(input: {
  sourceRoot: string;
  quarantineKey: string;
  expectedIdentity?: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>;
  sourceMustBeAbsent?: boolean;
}): Promise<boolean> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const sourceParent = path.dirname(sourceRoot);
  if (!managedPathExists(sourceParent)) {
    if (input.expectedIdentity) {
      throw new ProjectIdentityLifecycleError(
        'Attested managed directory parent disappeared before lifecycle quarantine',
      );
    }
    return false;
  }
  const quarantineRoot = lifecycleQuarantineRoot(sourceParent);
  const quarantineName = crypto.createHash('sha256')
    .update(`project-lifecycle\0${input.quarantineKey}\0${sourceRoot}`)
    .digest('hex');
  const quarantinedRoot = path.join(quarantineRoot, quarantineName);
  const receiptPath = `${quarantinedRoot}.receipt`;
  const readReceipt = (): AttestedDirectoryIdentity | null => {
    if (!managedPathExists(receiptPath)) return null;
    const entry = fs.lstatSync(receiptPath);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || entry.uid !== currentUid
      || (entry.mode & 0o077) !== 0
    ) {
      throw new ProjectIdentityLifecycleError('Lifecycle quarantine receipt is not server-private');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch {
      throw new ProjectIdentityLifecycleError('Lifecycle quarantine receipt is malformed');
    }
    const record = parsed as Partial<AttestedDirectoryIdentity> & { version?: unknown };
    if (
      record.version !== 1
      || typeof record.rootDevice !== 'string'
      || typeof record.rootInode !== 'string'
      || typeof record.rootBirthtimeNs !== 'string'
    ) {
      throw new ProjectIdentityLifecycleError('Lifecycle quarantine receipt is incomplete');
    }
    return Object.freeze({
      canonicalRoot: quarantinedRoot,
      rootDevice: record.rootDevice,
      rootInode: record.rootInode,
      rootBirthtimeNs: record.rootBirthtimeNs,
    });
  };
  const persistReceipt = (identity: AttestedDirectoryIdentity): void => {
    const existing = readReceipt();
    if (existing) {
      if (!sameAttestedDirectoryIdentity(existing, identity)) {
        throw new ProjectIdentityLifecycleError(
          'Lifecycle quarantine receipt conflicts with its attested directory',
        );
      }
      return;
    }
    const temporaryPath = path.join(
      quarantineRoot,
      `.${quarantineName}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify({
        version: 1,
        rootDevice: identity.rootDevice,
        rootInode: identity.rootInode,
        rootBirthtimeNs: identity.rootBirthtimeNs,
      }));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temporaryPath, receiptPath);
      const directoryDescriptor = fs.openSync(quarantineRoot, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  };
  const sourceExists = managedPathExists(sourceRoot);
  const quarantineExists = managedPathExists(quarantinedRoot);
  if (input.sourceMustBeAbsent && sourceExists) {
    throw new ProjectIdentityLifecycleError(
      'A managed directory appeared after lifecycle cleanup recorded its absence',
    );
  }
  if (sourceExists && quarantineExists) {
    throw new ProjectIdentityLifecycleError('Managed directory and its lifecycle quarantine both exist');
  }
  if (!sourceExists && !quarantineExists) {
    if (!input.expectedIdentity) return false;
    const receipt = readReceipt();
    if (receipt && sameAttestedDirectoryIdentity(input.expectedIdentity, receipt)) return true;
    throw new ProjectIdentityLifecycleError(
      'Attested managed directory disappeared without a durable quarantine receipt',
    );
  }
  const attested = sourceExists
    ? moveAttestedDirectoryNoReplace({
        sourceRoot,
        targetRoot: quarantinedRoot,
        expectedIdentity: input.expectedIdentity,
      })
    : attestProjectRoot(quarantinedRoot);
  if (input.expectedIdentity && !sameAttestedDirectoryIdentity(input.expectedIdentity, attested)) {
    throw new ProjectIdentityLifecycleError('Lifecycle quarantine no longer matches its attested directory');
  }
  persistReceipt(attested);
  await fs.promises.rm(quarantinedRoot, { recursive: true, force: false });
  if (managedPathExists(quarantinedRoot)) {
    throw new ProjectIdentityLifecycleError('Lifecycle quarantine remained after recursive removal');
  }
  return true;
}

const router = Router();

// Clear History and assistant reset still need the unresolved legacy retirement
// primitives. Project rename/delete have a narrower safe lane for identities
// born at the Portal 4 creation boundary and are admitted below by immutable ID.
const PORTAL_4_DESTRUCTIVE_CHAT_RESET_ROUTES_ENABLED = false as const;
const PROJECT_DESTRUCTIVE_RETIREMENT_PENDING_RESPONSE = Object.freeze({
  error: LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE,
  code: 'LEGACY_OPENCLAW_PROJECT_RETIREMENT_PENDING',
  retryable: false,
});

function rejectDestructiveProjectChatResetRouteForRelease(res: Response): boolean {
  if (PORTAL_4_DESTRUCTIVE_CHAT_RESET_ROUTES_ENABLED) return false;
  res.status(409).json(PROJECT_DESTRUCTIVE_RETIREMENT_PENDING_RESPONSE);
  return true;
}
const PROJECT_RUNTIME_CLEANUP_ADAPTERS = createDefaultProjectRuntimeCleanupAdapters();
const PROJECT_EGRESS_CLEANUP_ADAPTER = createProjectEgressCleanupAdapter();
const PROJECT_CHAT_LEASE_HOST = process.env.HOSTNAME || 'portal';
const PROJECT_CHAT_LEASE_OWNER = `${PROJECT_CHAT_LEASE_HOST}:${process.pid}:${crypto.randomUUID()}`;
const PROJECT_CHAT_LEASE_DURATION_MS = 5 * 60_000;
const PROJECT_CHAT_LEASE_RENEW_INTERVAL_MS = 30_000;
const PROJECT_CHAT_PRESENTATION_EVENT_LIMIT = 2_000;
const PROJECT_CHAT_ROUTE_PROVIDERS = Object.freeze([
  'OPENCLAW',
  'CODEX',
  'CLAUDE_CODE',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
] as const);
type ProjectChatRouteProvider = typeof PROJECT_CHAT_ROUTE_PROVIDERS[number];
type NativeProjectChatRouteProvider = Exclude<ProjectChatRouteProvider, 'OPENCLAW'>;
const PROJECT_CHAT_ROUTE_PROVIDER_SET = new Set<AgentProviderName>(PROJECT_CHAT_ROUTE_PROVIDERS);

function projectChatRuntimeOperationId(base: string, ...identityParts: unknown[]): string {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(identityParts))
    .digest('hex')
    .slice(0, 24);
  return `${base}-${digest}`;
}

function projectChatLeaseOwnerIsInactive(leaseOwner: string): boolean {
  const segments = String(leaseOwner || '').split(':');
  if (segments.length < 3) return false;
  const processId = Number(segments.at(-2));
  const host = segments.slice(0, -2).join(':');
  if (host !== PROJECT_CHAT_LEASE_HOST || !Number.isSafeInteger(processId) || processId < 2) return false;
  if (processId === process.pid) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error: any) {
    return error?.code === 'ESRCH';
  }
}

function projectChatLeaseOwnerCanBeRecoveredByDestructiveReset(leaseOwner: string): boolean {
  const segments = String(leaseOwner || '').split(':');
  if (segments.length < 3) return false;
  const host = segments.slice(0, -2).join(':');
  // A different host is the backup/restore case. Reset does not claim that
  // process is dead; it first terminates every attested provider session and
  // only then retires the exact expired admission transactionally.
  return host !== PROJECT_CHAT_LEASE_HOST || projectChatLeaseOwnerIsInactive(leaseOwner);
}

function isProjectChatRouteProvider(provider: AgentProviderName): provider is ProjectChatRouteProvider {
  return PROJECT_CHAT_ROUTE_PROVIDER_SET.has(provider);
}

function isNativeProjectChatRouteProvider(
  provider: AgentProviderName,
): provider is NativeProjectChatRouteProvider {
  return provider !== 'OPENCLAW' && isProjectChatRouteProvider(provider);
}

function requireProjectChatRouteProvider(provider: AgentProviderName): ProjectChatRouteProvider {
  if (!isProjectChatRouteProvider(provider)) {
    throw new UnsupportedProjectChatProviderError(
      provider,
      'No qualified central Project Chat route is enabled for this provider.',
    );
  }
  return provider;
}

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw');
const MAIN_AGENT_DIR = path.join(OPENCLAW_HOME, 'agents', 'main', 'agent');
const MAIN_AUTH_PROFILES_PATH = path.join(MAIN_AGENT_DIR, 'auth-profiles.json');
const MAIN_MODELS_PATH = path.join(MAIN_AGENT_DIR, 'models.json');

export { resolveProjectStoragePaths, type ProjectStorageOptions };

const projectStoragePaths = resolveProjectStoragePaths();
export const PROJECTS_DIR = projectStoragePaths.projectsDir;
export const DEPLOY_DIR = projectStoragePaths.deployDir;
export const ZIPS_DIR = projectStoragePaths.zipsDir;
export const UPLOAD_TEMP_DIR = projectStoragePaths.uploadTempDir;

const PROJECT_CREATION_STAGING_DIRECTORY = '.bridgesllm-project-creation-staging';

function ensureProjectCreationStagingRoot(projectsDir = PROJECTS_DIR): string {
  const projectsRoot = attestProjectRoot(projectsDir);
  if (projectsRoot.canonicalRoot !== path.resolve(projectsDir)) {
    throw new ProjectIdentityLifecycleError('Project creation staging parent is not canonical');
  }
  const stagingRoot = path.join(projectsRoot.canonicalRoot, PROJECT_CREATION_STAGING_DIRECTORY);
  ensureRuntimeDirectory(stagingRoot, { mode: 0o700, enforceMode: true });
  const entry = fs.lstatSync(stagingRoot);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || entry.uid !== currentUid
    || (entry.mode & 0o077) !== 0
    || attestProjectRoot(stagingRoot).canonicalRoot !== stagingRoot
  ) {
    throw new ProjectIdentityLifecycleError('Project creation staging root is not server-private');
  }
  return stagingRoot;
}

function createProjectCreationStagingDirectory(): string {
  const stagingRoot = ensureProjectCreationStagingRoot();
  const staged = fs.mkdtempSync(path.join(stagingRoot, 'create-'));
  fs.chmodSync(staged, 0o700);
  const identity = attestProjectRoot(staged);
  if (path.dirname(identity.canonicalRoot) !== stagingRoot) {
    throw new ProjectIdentityLifecycleError('Project creation staging directory escaped its root');
  }
  return identity.canonicalRoot;
}

function projectAppRebindStagingDirectory(operationId: string): string {
  if (!/^[a-f0-9]{32}$/.test(operationId)) {
    throw new ProjectIdentityLifecycleError('Project App rebind staging identity is invalid');
  }
  const stagingRoot = ensureProjectCreationStagingRoot();
  return path.join(stagingRoot, `app-rebind-${operationId}`);
}

function createProjectAppRebindStagingDirectory(operationId: string): string {
  const stagingRoot = ensureProjectCreationStagingRoot();
  const staged = projectAppRebindStagingDirectory(operationId);
  if (managedPathExists(staged)) {
    throw new ProjectIdentityLifecycleError('Project App rebind staging root already exists');
  }
  fs.mkdirSync(staged, { mode: 0o700 });
  const identity = attestProjectRoot(staged);
  if (path.dirname(identity.canonicalRoot) !== stagingRoot) {
    throw new ProjectIdentityLifecycleError('Project App rebind staging directory escaped its root');
  }
  return identity.canonicalRoot;
}

async function removeAttestedProjectCreationDirectory(
  directory: string,
  expected: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>,
): Promise<void> {
  const current = attestProjectRoot(directory);
  if (!sameAttestedDirectoryIdentity(expected, current)) {
    throw new ProjectIdentityLifecycleError('Project creation directory changed before cleanup');
  }
  await fs.promises.rm(directory, { recursive: true, force: false });
  if (managedPathExists(directory)) {
    throw new ProjectIdentityLifecycleError('Project creation directory remained after cleanup');
  }
}

export async function discardFailedCurrentProjectCreation(input: {
  projectIdentityId?: string;
  directory?: string;
  expectedDirectoryIdentity?: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>;
}, options: {
  removeWorkloads?: (projectIdentityId: string) => Promise<unknown>;
  database?: Pick<typeof prisma, 'projectIdentity'>;
} = {}): Promise<'discarded' | 'published'> {
  const removeWorkloads = options.removeWorkloads || removePortalProjectWorkloadsForProject;
  const database = options.database || prisma;
  if (!input.projectIdentityId) {
    if (!input.directory) return 'discarded';
    if (!input.expectedDirectoryIdentity) {
      throw new ProjectIdentityLifecycleError('Failed Project creation has no directory attestation');
    }
    await removeAttestedProjectCreationDirectory(input.directory, input.expectedDirectoryIdentity);
    return 'discarded';
  }
  const identity = await database.projectIdentity.findUnique({
    where: { id: input.projectIdentityId },
  });
  if (!identity) {
    // Portal versions that still cascaded ProjectIdentity from User could
    // erase the database claim while this request was constructing the hidden
    // root. The request still holds the inode attestation captured before any
    // content was written, so it may remove exactly that root. Never infer or
    // recursively sweep some other unclaimed directory.
    if (!input.directory || !input.expectedDirectoryIdentity) {
      throw new ProjectIdentityLifecycleError('Failed Project creation identity disappeared before reconciliation');
    }
    await removeAttestedProjectCreationDirectory(input.directory, input.expectedDirectoryIdentity);
    return 'discarded';
  }
  if (identity.lifecycleStatus === 'ACTIVE') {
    if (
      identity.legacyOpenClawMigrationStatus !== 'CURRENT'
      || !input.directory
      || !managedPathExists(input.directory)
      || !sameAttestedDirectoryIdentity(identity, attestProjectRoot(input.directory))
    ) {
      throw new ProjectIdentityLifecycleError('Published Project creation could not be reconciled safely');
    }
    return 'published';
  }
  if (
    identity.lifecycleStatus !== 'CREATING'
    || identity.legacyOpenClawMigrationStatus !== 'CURRENT'
  ) {
    throw new ProjectIdentityLifecycleError('Failed Project creation is not cleanup-eligible');
  }
  const claimed = await database.projectIdentity.updateMany({
    where: {
      id: identity.id,
      lifecycleStatus: 'CREATING',
      legacyOpenClawMigrationStatus: 'CURRENT',
      canonicalRoot: identity.canonicalRoot,
      rootDevice: identity.rootDevice,
      rootInode: identity.rootInode,
      rootBirthtimeNs: identity.rootBirthtimeNs,
    },
    data: { lifecycleStatus: 'CREATION_CLEANUP' },
  });
  if (claimed.count !== 1) {
    throw new ProjectIdentityLifecycleError('Failed Project creation changed before cleanup admission');
  }
  await removeWorkloads(identity.id);
  if (input.directory) {
    await removeAttestedProjectCreationDirectory(input.directory, identity);
  }
  const deleted = await database.projectIdentity.deleteMany({
    where: {
      id: identity.id,
      lifecycleStatus: 'CREATION_CLEANUP',
      legacyOpenClawMigrationStatus: 'CURRENT',
    },
  });
  if (deleted.count !== 1) {
    throw new ProjectIdentityLifecycleError('Failed Project creation cleanup claim changed before discard');
  }
  return 'discarded';
}

async function reconcileFailedCurrentProjectCreation(input: {
  projectIdentityId?: string;
  directory?: string;
  expectedDirectoryIdentity?: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>;
}, cleanupFailureLabel: string): Promise<'discarded' | 'published' | 'failed'> {
  try {
    return await discardFailedCurrentProjectCreation(input);
  } catch (cleanupError) {
    console.error(cleanupFailureLabel, cleanupError);
    return 'failed';
  }
}

export function initializeProjectStorage(options: ProjectStorageOptions = {}): ReturnType<typeof resolveProjectStoragePaths> {
  const paths = Object.keys(options).length > 0 ? resolveProjectStoragePaths(options) : projectStoragePaths;
  ensureRuntimeDirectory(paths.projectsDir, { mode: 0o755 });
  ensureProjectCreationStagingRoot(paths.projectsDir);
  ensureRuntimeDirectory(paths.deployDir, { mode: 0o755 });
  ensureRuntimeDirectory(paths.zipsDir, { mode: 0o700, enforceMode: true });
  ensureRuntimeDirectory(paths.uploadTempDir, { mode: 0o700, enforceMode: true });
  return paths;
}

/**
 * Converge only server-owned CREATING identities after a process restart.
 * A staging inode was never published and is discarded; a matching final
 * inode proves the no-replace move completed after construction and can be
 * finalized. Ambiguous or replaced paths stop startup rather than guessing.
 */
export async function recoverInterruptedCurrentProjectCreations(options: {
  projectsDir?: string;
  database?: Pick<typeof prisma, 'projectIdentity'>;
  removeWorkloads?: (projectIdentityId: string) => Promise<unknown>;
  collisionProof?: typeof assertNoLegacyOpenClawProjectCreationCollision;
  finalizeCreation?: typeof finalizeCurrentProjectIdentityCreation;
} = {}): Promise<{
  finalized: number;
  discarded: number;
  orphanStagingDirectories: number;
  preservedOrphanStagingDirectories: number;
}> {
  const projectsDir = path.resolve(options.projectsDir || PROJECTS_DIR);
  const database = options.database || prisma;
  const removeWorkloads = options.removeWorkloads || removePortalProjectWorkloadsForProject;
  const collisionProof = options.collisionProof || assertNoLegacyOpenClawProjectCreationCollision;
  const finalizeCreation = options.finalizeCreation || finalizeCurrentProjectIdentityCreation;
  const stagingRoot = ensureProjectCreationStagingRoot(projectsDir);
  const creations = await database.projectIdentity.findMany({
    where: { lifecycleStatus: { in: ['CREATING', 'CREATION_CLEANUP'] } },
    orderBy: { createdAt: 'asc' },
  });
  const claimedStagingRoots = new Set<string>();
  let finalized = 0;
  let discarded = 0;
  for (const creation of creations) {
    if (creation.legacyOpenClawMigrationStatus !== 'CURRENT') {
      throw new ProjectIdentityLifecycleError('Interrupted Project creation lost CURRENT provenance');
    }
    const stagedRoot = path.resolve(creation.canonicalRoot);
    if (path.dirname(stagedRoot) !== stagingRoot) {
      throw new ProjectIdentityLifecycleError('Interrupted Project creation escaped the staging root');
    }
    claimedStagingRoots.add(stagedRoot);
    if (
      !/^[a-zA-Z0-9_-]+$/.test(creation.workspaceOwnerId)
      || !creation.projectName
      || path.basename(creation.projectName) !== creation.projectName
      || creation.projectName.includes('\\')
    ) {
      throw new ProjectIdentityLifecycleError('Interrupted Project creation has an invalid final name');
    }
    const finalRoot = path.join(projectsDir, creation.workspaceOwnerId, creation.projectName);
    const stagedExists = managedPathExists(stagedRoot);
    const finalExists = managedPathExists(finalRoot);
    if (stagedExists && finalExists) {
      throw new ProjectIdentityLifecycleError('Interrupted Project creation has both staged and final roots');
    }
    await removeWorkloads(creation.id);
    if (creation.lifecycleStatus === 'CREATION_CLEANUP') {
      const cleanupRoot = finalExists ? finalRoot : stagedExists ? stagedRoot : null;
      if (cleanupRoot) {
        const cleanupIdentity = attestProjectRoot(cleanupRoot);
        if (!sameAttestedDirectoryIdentity(creation, cleanupIdentity)) {
          throw new ProjectIdentityLifecycleError('Interrupted Project cleanup root changed before recovery');
        }
        await removeAttestedProjectCreationDirectory(cleanupRoot, creation);
      }
      const deleted = await database.projectIdentity.deleteMany({
        where: {
          id: creation.id,
          lifecycleStatus: 'CREATION_CLEANUP',
          legacyOpenClawMigrationStatus: 'CURRENT',
        },
      });
      if (deleted.count !== 1) {
        throw new ProjectIdentityLifecycleError('Interrupted Project cleanup claim changed before recovery');
      }
      discarded += 1;
      continue;
    }
    if (finalExists) {
      const finalIdentity = attestProjectRoot(finalRoot);
      if (!sameAttestedDirectoryIdentity(creation, finalIdentity)) {
        throw new ProjectIdentityLifecycleError('Interrupted Project final root changed before recovery');
      }
      // The pre-move scan may be arbitrarily old after downtime. Re-prove
      // scoped legacy absence before making the recovered project ACTIVE.
      await collisionProof({
        workspaceOwnerId: creation.workspaceOwnerId,
        projectName: creation.projectName,
        projectRoot: finalRoot,
      });
      await finalizeCreation({
        projectIdentityId: creation.id,
        projectRoot: finalRoot,
      });
      finalized += 1;
      continue;
    }
    if (stagedExists) {
      await removeAttestedProjectCreationDirectory(stagedRoot, creation);
    }
    const deleted = await database.projectIdentity.deleteMany({
      where: {
        id: creation.id,
        lifecycleStatus: 'CREATING',
        legacyOpenClawMigrationStatus: 'CURRENT',
      },
    });
    if (deleted.count !== 1) {
      throw new ProjectIdentityLifecycleError('Interrupted Project creation changed before discard');
    }
    discarded += 1;
  }

  let orphanStagingDirectories = 0;
  let preservedOrphanStagingDirectories = 0;
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    const candidate = path.join(stagingRoot, entry.name);
    if (claimedStagingRoots.has(candidate)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProjectIdentityLifecycleError('Unknown entry exists in Project creation staging');
    }
    // Empty roots are the ordinary pre-insert crash window. Older Portal
    // versions could also lose a claim through User cascade while content was
    // being written. Preserve those nonempty roots rather than guessing their
    // ownership, but do not let ambiguous residue boot-loop the Portal.
    try {
      fs.rmdirSync(candidate);
      orphanStagingDirectories += 1;
    } catch (error: any) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error;
      preservedOrphanStagingDirectories += 1;
      console.warn('[Project Creation] Preserving nonempty unclaimed staging directory:', entry.name);
    }
  }
  return {
    finalized,
    discarded,
    orphanStagingDirectories,
    preservedOrphanStagingDirectories,
  };
}

function syncProjectAgentRuntimeFiles(agentId: string) {
  try {
    const targetDir = path.join(OPENCLAW_HOME, 'agents', agentId, 'agent');
    fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(MAIN_AUTH_PROFILES_PATH)) {
      fs.copyFileSync(MAIN_AUTH_PROFILES_PATH, path.join(targetDir, 'auth-profiles.json'));
    }
    if (fs.existsSync(MAIN_MODELS_PATH)) {
      fs.copyFileSync(MAIN_MODELS_PATH, path.join(targetDir, 'models.json'));
    }
  } catch (error) {
    console.warn(`[ensureProjectAgent] Failed to sync runtime files for ${agentId}:`, error);
  }
}

// Multer for ZIP uploads
const zipStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      initializeProjectStorage();
      cb(null, ZIPS_DIR);
    } catch (error: any) {
      cb(error, ZIPS_DIR);
    }
  },
  filename: (_req, _file, cb) => cb(null, `${nanoid(24)}.zip`),
});
const zipUpload = multer({
  storage: zipStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});
// Multer for general file uploads to projects (any file type)
const fileUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      initializeProjectStorage();
      cb(null, UPLOAD_TEMP_DIR);
    } catch (error: any) {
      cb(error, UPLOAD_TEMP_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const safeName = path.posix.basename(file.originalname.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'file';
    cb(null, `${nanoid(24)}-${safeName}`);
  },
});
const fileUpload = multer({
  storage: fileUploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
});

const PROJECT_EDIT_MAX_BYTES = 10 * 1024 * 1024;
const PROJECT_RAW_MAX_BYTES = 100 * 1024 * 1024;
type ProjectIdentityMeta = {
  version: 2;
  projectInstanceId: string;
  workspaceOwnerId: string;
  stableSlug: string;
  createdAt: string;
};

type ProjectIdentityProof = {
  id: string;
  generation: number;
};

type ProjectDeleteIdentityRequest =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; proof: ProjectIdentityProof };

const PROJECT_MOVE_REQUIRED_CODE = 'PROJECT_MOVE_REQUIRED';
const PROJECT_DESTRUCTIVE_MOVE_REQUIRED_MESSAGE =
  'Move this older project into a new Portal project before renaming or deleting it.';
const PROJECT_CHAT_MOVE_REQUIRED_MESSAGE =
  'Portal can make a verified Portal 4 copy for Project Chat while leaving this legacy project, its links, and older agent state untouched.';

class ProjectMoveRequiredError extends Error {
  readonly code = PROJECT_MOVE_REQUIRED_CODE;

  constructor(message = PROJECT_DESTRUCTIVE_MOVE_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'ProjectMoveRequiredError';
  }
}

function serializeProjectIdentityProof(identity: { id: string; generation: number }): ProjectIdentityProof {
  if (!identity.id || !Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new Error('Project identity proof is invalid');
  }
  return { id: identity.id, generation: identity.generation };
}

function parseProjectDeleteIdentityRequest(body: unknown): ProjectDeleteIdentityRequest {
  if (body === undefined || body === null) return { kind: 'absent' };
  if (typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid' };

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return { kind: 'absent' };
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(record, 'projectIdentityId')
    || !Object.prototype.hasOwnProperty.call(record, 'projectGeneration')
  ) return { kind: 'invalid' };

  const projectIdentityId = record.projectIdentityId;
  const projectGeneration = record.projectGeneration;
  if (
    typeof projectIdentityId !== 'string'
    || projectIdentityId.length < 1
    || projectIdentityId.length > 128
    || projectIdentityId.trim() !== projectIdentityId
    || /[\u0000-\u001f\u007f]/.test(projectIdentityId)
    || typeof projectGeneration !== 'number'
    || !Number.isSafeInteger(projectGeneration)
    || projectGeneration < 1
  ) return { kind: 'invalid' };

  return {
    kind: 'valid',
    proof: { id: projectIdentityId, generation: projectGeneration },
  };
}

function projectDeleteIdentityMatches(
  identity: Pick<ProjectIdentityRecord, 'id' | 'generation'>,
  proof: ProjectIdentityProof,
): boolean {
  return identity.id === proof.id && identity.generation === proof.generation;
}

function sendProjectDeleteIdentityMismatch(res: Response): void {
  res.status(409).json({
    error: 'The Project identity changed before deletion admission. Refresh Projects before trying again.',
    code: 'PROJECT_DELETE_IDENTITY_MISMATCH',
    status: 'not_admitted',
    admitted: false,
    retryable: false,
  });
}

function projectDestructiveActionCapability(identity: ProjectIdentityRecord) {
  const allowed = identity.legacyOpenClawMigrationStatus === 'CURRENT';
  return {
    allowed,
    reason: allowed ? null : PROJECT_DESTRUCTIVE_MOVE_REQUIRED_MESSAGE,
  };
}

function requireCurrentProjectDestructiveIdentity(identity: ProjectIdentityRecord | null): ProjectIdentityRecord {
  if (!identity || identity.legacyOpenClawMigrationStatus !== 'CURRENT') {
    throw new ProjectMoveRequiredError();
  }
  return identity;
}

function sendProjectRenameNotAdmitted(
  res: Response,
  statusCode: number,
  attemptId: string | null,
  code: string,
  error: string,
): void {
  console.error('[ProjectLifecycle]', JSON.stringify({
    route: 'project-rename',
    code,
    status: statusCode,
    detail: error,
    ...(attemptId ? { attemptId } : {}),
  }));
  res.status(statusCode).json({
    error,
    code,
    status: 'not_admitted',
    admitted: false,
    ...(attemptId ? { attemptId } : {}),
  });
}

function normalizeProjectSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'project';
}

function getProjectAgentId(actorUserId: string, projectInstanceId: string) {
  const digest = crypto.createHash('sha256').update(`agent\0${actorUserId}\0${projectInstanceId}`).digest('hex');
  return `portal-project-${digest.slice(0, 40)}`;
}

function getProjectSessionId(actorUserId: string, projectInstanceId: string) {
  const digest = crypto.createHash('sha256').update(`session\0${actorUserId}\0${projectInstanceId}`).digest('hex');
  return `portal-project-${digest}`;
}

interface ProjectGitPorcelainEntry {
  status: string;
  path: string;
}

function parseProjectGitPorcelain(output: string): ProjectGitPorcelainEntry[] {
  const records = output.split('\0');
  const entries: ProjectGitPorcelainEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    entries.push({ status, path: filePath });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return entries;
}

interface ProjectWorkloadScope {
  actorId: string;
  projectId: string;
}

async function listDirtyProjectPaths(projectDir: string, scope: ProjectWorkloadScope, signal?: AbortSignal) {
  const statusOutput = await runProjectGitCommand({
    ...scope,
    workspace: projectDir,
    args: ['status', '--porcelain=v1', '-z', '-uall'],
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
    signal,
  });
  return parseProjectGitPorcelain(statusOutput).map((entry) => entry.path);
}

async function withTransientProjectStateShelved<T>(
  projectDir: string,
  scope: ProjectWorkloadScope,
  fn: () => Promise<T>,
  opts?: { timeout?: number; signal?: AbortSignal },
): Promise<T> {
  const git = (args: string[]) => runProjectGitCommand({
    ...scope,
    workspace: projectDir,
    args,
    timeoutMs: opts?.timeout || 30_000,
    signal: opts?.signal,
  });
  const cleanupGit = (args: string[]) => runProjectGitCommand({
    ...scope,
    workspace: projectDir,
    args,
    timeoutMs: opts?.timeout || 30_000,
    nameHint: 'project-git-cleanup',
  });
  const dirtyPaths = await listDirtyProjectPaths(projectDir, scope, opts?.signal);
  const blockingPaths = Array.from(new Set(dirtyPaths.filter((filePath) => !isTransientProjectStatePath(filePath))));
  if (blockingPaths.length > 0) {
    const preview = blockingPaths.slice(0, 6).join(', ');
    const suffix = blockingPaths.length > 6 ? ` (+${blockingPaths.length - 6} more)` : '';
    throw new Error(`Working tree has uncommitted changes: ${preview}${suffix}`);
  }

  const transientPaths = Array.from(new Set(dirtyPaths.filter(isTransientProjectStatePath)));
  let stashed = false;
  const stashMessage = 'portal-transient-project-state';

  if (transientPaths.length > 0) {
    await git(['stash', 'push', '-u', '-m', stashMessage, '--', ...transientPaths]);
    stashed = true;
  }

  try {
    return await fn();
  } catch (error) {
    try { await cleanupGit(['revert', '--abort']); } catch {}
    throw error;
  } finally {
    if (stashed) {
      try {
        await cleanupGit(['stash', 'pop', '--index']);
      } catch (restoreError) {
        console.warn(`[projects] Failed to restore transient project state for ${projectDir}:`, restoreError);
      }
    }
  }
}

async function ensureProjectAssistantIdentity(
  projectDir: string,
  actorUserId: string,
  projectName: string,
  options?: { workspaceOwnerId?: string }
): Promise<ProjectIdentityMeta & { legacySlug: string; agentId: string; sessionId: string; sessionKey: string }> {
  const workspaceOwnerId = options?.workspaceOwnerId || actorUserId;
  const legacySlug = normalizeProjectSlug(projectName);
  const identity = await ensureProjectIdentity({ workspaceOwnerId, projectName, projectRoot: projectDir });
  const stableSlug = `p-${crypto.createHash('sha256')
    .update(`slug\0${actorUserId}\0${identity.id}`)
    .digest('hex')
    .slice(0, 32)}`;
  const meta: ProjectIdentityMeta = {
    version: 2,
    projectInstanceId: identity.id,
    workspaceOwnerId,
    stableSlug,
    createdAt: identity.createdAt.toISOString(),
  };
  const agentId = getProjectAgentId(actorUserId, stableSlug);
  const sessionId = getProjectSessionId(actorUserId, stableSlug);
  return {
    ...meta,
    legacySlug,
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
  };
}

async function listProjectLifecycleActorIds(input: {
  projectIdentityId: string;
  workspaceOwnerId: string;
  authenticatedActorId: string;
}): Promise<readonly string[]> {
  const [bindings, sessions, messages, states, turns] = await Promise.all([
    prisma.projectChatProviderBinding.findMany({
      where: { projectId: input.projectIdentityId },
      select: { userId: true },
    }),
    prisma.projectChatSession.findMany({
      where: { projectId: input.projectIdentityId },
      select: { userId: true },
    }),
    prisma.projectChatMessage.findMany({
      where: { projectId: input.projectIdentityId },
      select: { userId: true },
    }),
    prisma.projectChatState.findMany({
      where: { projectIdentityId: input.projectIdentityId },
      select: { actorUserId: true },
    }),
    prisma.projectChatTurn.findMany({
      where: { projectIdentityId: input.projectIdentityId },
      select: { actorUserId: true },
    }),
  ]);
  return Object.freeze(Array.from(new Set([
    input.authenticatedActorId,
    input.workspaceOwnerId,
    ...bindings.map((entry) => entry.userId),
    ...sessions.map((entry) => entry.userId),
    ...messages.map((entry) => entry.userId),
    ...states.map((entry) => entry.actorUserId),
    ...turns.map((entry) => entry.actorUserId),
  ])));
}

function projectAppAssociationWhere(input: {
  workspaceOwnerId: string;
  projectIdentityId: string;
  projectName: string;
  deployPath: string;
}): Prisma.AppWhereInput {
  const desktopRuntimePaths = projectDesktopRuntimeCleanupDirectories({
    projectId: input.projectIdentityId,
    projectName: input.projectName,
  });
  return {
    userId: input.workspaceOwnerId,
    OR: [
      { projectIdentityId: input.projectIdentityId },
      {
        projectIdentityId: null,
        name: input.projectName,
        OR: [
          { zipPath: input.deployPath },
          { deployType: 'runtime', zipPath: { in: desktopRuntimePaths } },
        ],
      },
    ],
  };
}

async function findProjectAppForIdentity(input: {
  workspaceOwnerId: string;
  projectIdentityId: string;
  projectName: string;
  deployPath: string;
}): Promise<App | null> {
  const apps = await prisma.app.findMany({
    where: projectAppAssociationWhere(input),
    take: 2,
  });
  if (apps.length > 1) {
    throw new ProjectIdentityLifecycleError(
      'More than one App claims the same immutable Project identity',
    );
  }
  return apps[0] || null;
}

async function findProjectAppBeforeIdentityMutation(input: {
  workspaceOwnerId: string;
  projectName: string;
  deployPath: string;
}): Promise<App | null> {
  const storedIdentity = await prisma.projectIdentity.findUnique({
    where: {
      workspaceOwnerId_projectName: {
        workspaceOwnerId: input.workspaceOwnerId,
        projectName: input.projectName,
      },
    },
  });
  const apps = await prisma.app.findMany({
    where: storedIdentity
      ? projectAppAssociationWhere({
        workspaceOwnerId: input.workspaceOwnerId,
        projectIdentityId: storedIdentity.id,
        projectName: input.projectName,
        deployPath: input.deployPath,
      })
      : {
        userId: input.workspaceOwnerId,
        projectIdentityId: null,
        name: input.projectName,
        zipPath: input.deployPath,
      },
    take: 2,
  });
  if (apps.length > 1) {
    throw new ProjectIdentityLifecycleError(
      'More than one App claims the same Project deployment before identity enrollment',
    );
  }
  return apps[0] || null;
}

function sendExternalRuntimeConflict(
  res: Response,
  action: string,
): void {
  res.status(409).json(projectExternalRuntimeConflict(
    new ProjectExternalRuntimeLifecycleError(action),
  ));
}

function sendInvalidRuntimeBindingConflict(
  res: Response,
  action: string,
): void {
  res.status(503).json(projectInvalidRuntimeBindingConflict(
    new ProjectInvalidRuntimeBindingError(action),
  ));
}

type ProjectDeployType = 'static' | 'fullstack' | 'runtime';

function boundedProjectDeployType(value: unknown): ProjectDeployType {
  if (value === 'static' || value === 'fullstack' || value === 'runtime') return value;
  throw new ProjectIdentityLifecycleError('The stored Project deployment type is invalid');
}

function sendProjectDeployTypeTransitionConflict(
  res: Response,
  priorDeployType: ProjectDeployType,
  nextDeployType: ProjectDeployType,
): void {
  res.status(409).json({
    code: 'PROJECT_DEPLOY_TYPE_TRANSITION_REQUIRES_UNDEPLOY',
    error: `This Project is already deployed as ${priorDeployType}. Remove the current deployment before deploying it as ${nextDeployType}.`,
    detail: 'Removing the deployment stops and clears its current runtime while preserving the Project source. You can then deploy the new type.',
    priorDeployType,
    nextDeployType,
    recoveryAction: 'UNDEPLOY_CURRENT_DEPLOYMENT',
    retryable: false,
  });
}

function sendDeployTypeTransitionConflictIfNeeded(
  res: Response,
  app: App | null | undefined,
  nextDeployType: ProjectDeployType,
): boolean {
  if (!app) return false;
  const priorDeployType = boundedProjectDeployType(app.deployType);
  if (priorDeployType === nextDeployType) return false;
  sendProjectDeployTypeTransitionConflict(
    res,
    priorDeployType,
    nextDeployType,
  );
  return true;
}

function sendRuntimeOwnershipMutationConflict(
  res: Response,
  app: App | null | undefined,
  action: string,
): boolean {
  if (!app) return false;
  const management = projectRuntimeManagement(app);
  if (management === 'invalid-external-binding') {
    sendInvalidRuntimeBindingConflict(res, action);
    return true;
  }
  if (management === 'external-loopback') {
    sendExternalRuntimeConflict(res, action);
    return true;
  }
  return false;
}

async function sendExternalRuntimeStatus(
  res: Response,
  app: App,
): Promise<void> {
  const status = await probeExternalLoopbackRuntime(app);
  res.json({
    status,
    persistedStatus: app.processStatus || null,
    statusSource: 'external-binding',
    recoveryRequired: false,
    deployType: app.deployType,
    runtimeManagement: 'external-loopback',
    supportedActions: [],
    logs: [],
    restartCount: 0,
    limitation: 'Portal routes this App to an externally managed loopback service but cannot inspect or control that service process.',
  });
}

function isProjectRuntimeImageUnavailable(error: unknown): boolean {
  return error instanceof ProjectRuntimeImageUnavailableError
    || (error as { code?: unknown } | null)?.code === 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE';
}

type ProjectRuntimeRecoveryReplayAction = 'deploy' | 'start' | 'restart';

type ProjectRuntimeRecoveryReplayProof = Readonly<{
  proof: string;
  action: ProjectRuntimeRecoveryReplayAction;
  projectIdentity: ProjectIdentityProof;
  expectedAppId: string | null;
  expectedDeployType?: 'fullstack';
  sourceDigest?: string;
}>;

class ProjectRuntimeRecoveryReplayValidationError extends Error {
  readonly code = 'PROJECT_RUNTIME_RECOVERY_REPLAY_INVALID';
}

function parseProjectRuntimeRecoveryReplay(
  value: unknown,
  expectedAction: ProjectRuntimeRecoveryReplayAction,
): ProjectRuntimeRecoveryReplayProof | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectRuntimeRecoveryReplayValidationError('Runtime recovery replay proof is malformed');
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'proof',
    'action',
    'projectIdentity',
    'expectedAppId',
    'expectedDeployType',
    'sourceDigest',
  ]);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key))
    || typeof record.proof !== 'string'
    || !/^v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(record.proof)
    || record.action !== expectedAction
  ) {
    throw new ProjectRuntimeRecoveryReplayValidationError('Runtime recovery replay proof is malformed');
  }
  if (!record.projectIdentity || typeof record.projectIdentity !== 'object' || Array.isArray(record.projectIdentity)) {
    throw new ProjectRuntimeRecoveryReplayValidationError('Runtime recovery Project identity is malformed');
  }
  const identity = record.projectIdentity as Record<string, unknown>;
  if (
    Object.keys(identity).some((key) => key !== 'id' && key !== 'generation')
    || typeof identity.id !== 'string'
    || !identity.id
    || identity.id.length > 128
    || identity.id.trim() !== identity.id
    || !Number.isSafeInteger(identity.generation)
    || (identity.generation as number) < 1
    || (record.expectedAppId !== null && (
      typeof record.expectedAppId !== 'string'
      || !record.expectedAppId
      || record.expectedAppId.length > 128
      || record.expectedAppId.trim() !== record.expectedAppId
    ))
  ) {
    throw new ProjectRuntimeRecoveryReplayValidationError('Runtime recovery replay proof is malformed');
  }
  if (
    expectedAction === 'deploy'
      ? record.expectedDeployType !== 'fullstack'
        || typeof record.sourceDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.sourceDigest)
      : record.expectedDeployType !== undefined
        || record.sourceDigest !== undefined
        || record.expectedAppId === null
  ) {
    throw new ProjectRuntimeRecoveryReplayValidationError('Runtime recovery replay proof is malformed');
  }
  return Object.freeze({
    proof: record.proof,
    action: expectedAction,
    projectIdentity: Object.freeze({
      id: identity.id,
      generation: identity.generation as number,
    }),
    expectedAppId: record.expectedAppId as string | null,
    ...(expectedAction === 'deploy' ? {
      expectedDeployType: 'fullstack' as const,
      sourceDigest: record.sourceDigest as string,
    } : {}),
  });
}

function projectRuntimeRecoveryReplayScope(
  ownerUserId: string,
  replay: ProjectRuntimeRecoveryReplayProof,
): ProjectRuntimeRecoveryScope & { proof: string } {
  return {
    proof: replay.proof,
    ownerUserId,
    projectIdentityId: replay.projectIdentity.id,
    projectIdentityGeneration: replay.projectIdentity.generation,
    action: replay.action,
    expectedAppId: replay.expectedAppId,
    expectedFullstack: true,
    sourceDigest: replay.sourceDigest || null,
  };
}

function assertProjectRuntimeRecoveryRouteIdentity(
  replay: ProjectRuntimeRecoveryReplayProof,
  projectIdentity: { id: string; generation: number },
): void {
  if (
    replay.projectIdentity.id !== projectIdentity.id
    || replay.projectIdentity.generation !== projectIdentity.generation
  ) {
    throw new ProjectDeploymentReplayStaleError();
  }
}

function assertProjectRuntimeRecoveryRouteApp(
  replay: ProjectRuntimeRecoveryReplayProof,
  app: Pick<App, 'id'> | null | undefined,
): void {
  if (replay.expectedAppId !== (app?.id || null)) {
    throw new ProjectDeploymentReplayStaleError();
  }
}

function sendProjectRuntimeRecoveryStatus(
  res: Response,
  status: ProjectRuntimeRecoveryStatus,
): boolean {
  if (status.kind === 'issued' || status.kind === 'claimed') return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (status.kind === 'completed') {
    res.status(status.result.statusCode).json(status.result.body);
    return true;
  }
  if (status.kind === 'running') {
    res.status(409).json({
      code: 'PROJECT_RUNTIME_RECOVERY_IN_PROGRESS',
      error: 'The recovered Project action is still reconciling.',
      detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
      retryable: false,
    });
    return true;
  }
  res.status(409).json({
    code: 'PROJECT_RUNTIME_RECOVERY_FAILED',
    error: 'The recovered Project action did not complete.',
    detail: 'Refresh this Project and use its current Deployment controls.',
    failureCode: status.failureCode,
    retryable: false,
  });
  return true;
}

function sendProjectRuntimeRecoveryReplayError(
  res: Response,
  error: unknown,
): boolean {
  if (!(error instanceof ProjectRuntimeRecoveryReplayError)) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  const stale = [
    'PROJECT_RUNTIME_RECOVERY_PROOF_EXPIRED',
    'PROJECT_RUNTIME_RECOVERY_PROOF_MISMATCH',
    'PROJECT_RUNTIME_RECOVERY_STALE',
  ].includes(error.code);
  const invalid = error.code === 'PROJECT_RUNTIME_RECOVERY_INVALID_INPUT'
    || error.code === 'PROJECT_RUNTIME_RECOVERY_PROOF_INVALID';
  res.status(invalid ? 400 : stale ? 409 : error.httpStatus).json({
    code: invalid
      ? 'PROJECT_RUNTIME_RECOVERY_REPLAY_INVALID'
      : stale
        ? 'PROJECT_RUNTIME_RECOVERY_REPLAY_STALE'
        : error.code,
    error: invalid
      ? 'Runtime recovery replay proof is invalid.'
      : stale
        ? 'This recovered Project action is stale and was not executed.'
        : 'Portal could not safely reconcile the recovered Project action.',
    detail: stale
      ? 'Refresh this Project and use its current Deployment controls.'
      : 'Refresh Deployment status before retrying.',
    retryable: false,
  });
  return true;
}

async function completeProjectRuntimeRecoveryOrThrow(
  ownerUserId: string,
  replay: ProjectRuntimeRecoveryReplayProof | null,
  response: ProjectRuntimeRecoveryResponse,
): Promise<void> {
  if (!replay) return;
  await completeProjectRuntimeRecovery({
    ...projectRuntimeRecoveryReplayScope(ownerUserId, replay),
    response,
  });
}

async function failProjectRuntimeRecoveryOrThrow(
  ownerUserId: string,
  replay: ProjectRuntimeRecoveryReplayProof | null,
  failureCode: string,
): Promise<void> {
  if (!replay) return;
  await failProjectRuntimeRecovery({
    ...projectRuntimeRecoveryReplayScope(ownerUserId, replay),
    failureCode,
  });
}

async function issueProjectRuntimeRecoveryReplay(input: Readonly<{
  ownerUserId: string;
  action: ProjectRuntimeRecoveryReplayAction;
  projectIdentity: ProjectIdentityProof;
  expectedAppId: string | null;
  expectedDeploymentRevision: string;
  sourceDigest?: string;
}>): Promise<ProjectRuntimeRecoveryReplayProof> {
  const issued = await issueProjectRuntimeRecoveryProof({
    ownerUserId: input.ownerUserId,
    projectIdentityId: input.projectIdentity.id,
    projectIdentityGeneration: input.projectIdentity.generation,
    action: input.action,
    expectedAppId: input.expectedAppId,
    expectedDeploymentRevision: input.expectedDeploymentRevision,
    expectedFullstack: true,
    sourceDigest: input.sourceDigest || null,
  });
  return Object.freeze({
    proof: issued.proof,
    action: input.action,
    projectIdentity: input.projectIdentity,
    expectedAppId: input.expectedAppId,
    ...(input.action === 'deploy' ? {
      expectedDeployType: 'fullstack' as const,
      sourceDigest: input.sourceDigest,
    } : {}),
  });
}

function projectRuntimeRecoveryCompletion(input: Readonly<{
  replay: ProjectRuntimeRecoveryReplayProof;
  deploymentRevision: string;
  appId: string;
}>): ProjectRuntimeRecoveryResponse {
  return {
    statusCode: 200,
    body: {
      success: true,
      action: input.replay.action,
      projectIdentityId: input.replay.projectIdentity.id,
      projectIdentityGeneration: input.replay.projectIdentity.generation,
      appId: input.appId,
      deploymentRevision: input.deploymentRevision,
    },
  };
}

function sendProjectRuntimeImageUnavailable(
  res: Response,
  recoveryReplay: ProjectRuntimeRecoveryReplayProof,
): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(503).json({
    code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
    error: 'The Project runtime image is unavailable. Repair it, then try this action again.',
    retryable: true,
    recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
    recoveryReplay,
  });
}

async function stopProjectDesktopRuntimesForLifecycle(input: {
  workspaceOwnerId: string;
  projectIdentityId: string;
  projectName: string;
}): Promise<{
  runtimeDir: string;
  identity: AttestedDirectoryIdentity | null;
}> {
  ensureSecureProjectDesktopRuntimeRoot();
  const desktopIdentity = buildProjectDesktopRuntimeIdentity(
    input.projectIdentityId,
    input.projectName,
  );
  // This marker is immutable across rename. Stop it even if a failed deploy
  // created the process/directory before its App row committed.
  const currentRuntimeIdentity = managedPathExists(desktopIdentity.runtimeDir)
    ? attestProjectRoot(desktopIdentity.runtimeDir)
    : null;
  stopManagedDesktopRuntimeUnit(desktopIdentity.systemdUnit);
  stopDesktopRuntimeProcess(desktopIdentity.processMarker);
  if (currentRuntimeIdentity) {
    const current = attestProjectRoot(desktopIdentity.runtimeDir);
    if (!sameAttestedDirectoryIdentity(currentRuntimeIdentity, current)) {
      throw new ProjectIdentityLifecycleError(
        'Remote Desktop Project runtime directory changed while its process stopped',
      );
    }
  } else if (managedPathExists(desktopIdentity.runtimeDir)) {
    throw new ProjectIdentityLifecycleError(
      'A Remote Desktop Project runtime directory appeared while its process stopped',
    );
  }
  const runtimeApps = await prisma.app.findMany({
    where: {
      AND: [
        projectAppAssociationWhere({
          ...input,
          deployPath: path.join(DEPLOY_DIR, `${input.workspaceOwnerId}-${input.projectName}`),
        }),
        { deployType: 'runtime' },
      ],
    },
    select: { id: true, zipPath: true },
    take: 2,
  });
  if (runtimeApps.length > 1) {
    throw new ProjectIdentityLifecycleError(
      'More than one Remote Desktop App claims the same immutable Project identity',
    );
  }
  const sameProjectAppIds = runtimeApps.map((entry) => entry.id);
  const legacyDirectories = new Set(
    projectDesktopRuntimeCleanupDirectories({
      projectId: input.projectIdentityId,
      projectName: input.projectName,
    }).filter((candidate) => candidate !== desktopIdentity.runtimeDir),
  );
  for (const runtimeApp of runtimeApps) {
    for (const candidate of projectDesktopRuntimeCleanupDirectories({
      projectId: input.projectIdentityId,
      projectName: input.projectName,
      recordedRuntimeDir: runtimeApp.zipPath,
    })) {
      if (candidate !== desktopIdentity.runtimeDir) legacyDirectories.add(candidate);
    }
  }
  const recordedUnmanagedRuntime = runtimeApps.some((runtimeApp) => (
    legacyDirectories.has(path.resolve(runtimeApp.zipPath))
  ));
  if (
    recordedUnmanagedRuntime
    || Array.from(legacyDirectories).some((runtimeDirectory) => managedPathExists(runtimeDirectory))
  ) {
    throw new ProjectIdentityLifecycleError(
      'A legacy Remote Desktop runtime cannot be proven stopped without a managed cgroup; lifecycle cleanup remains pending',
    );
  }
  for (const runtimeDirectory of legacyDirectories) {
    const sharedLegacyReferences = await prisma.app.count({
      where: {
        ...(sameProjectAppIds.length > 0 ? { id: { notIn: sameProjectAppIds } } : {}),
        deployType: 'runtime',
        zipPath: runtimeDirectory,
      },
    });
    if (sharedLegacyReferences > 0) continue;
    const initialIdentity = managedPathExists(runtimeDirectory)
      ? attestProjectRoot(runtimeDirectory)
      : null;
    stopDesktopRuntimeProcess(runtimeDirectory);
    await removeDirectoryThroughAttestedQuarantine({
      sourceRoot: runtimeDirectory,
      quarantineKey: `desktop-legacy:${input.projectIdentityId}`,
      expectedIdentity: initialIdentity || undefined,
      sourceMustBeAbsent: !initialIdentity,
    });
  }
  return Object.freeze({
    runtimeDir: desktopIdentity.runtimeDir,
    identity: currentRuntimeIdentity,
  });
}

async function retargetProjectAppsForRename(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceOwnerId: string;
    projectIdentityId: string;
    oldProjectName: string;
    newProjectName: string;
    oldDeployPath: string;
    newDeployPath: string;
  },
): Promise<void> {
  if (await transaction.app.count({
    where: { userId: input.workspaceOwnerId, name: input.newProjectName },
  }) > 0) {
    throw new ProjectIdentityLifecycleError('Rename target already has an App identity');
  }
  const desktopRuntimeDir = buildProjectDesktopRuntimeIdentity(
    input.projectIdentityId,
    input.newProjectName,
  ).runtimeDir;
  const projectApps = await transaction.app.findMany({
    where: projectAppAssociationWhere({
      workspaceOwnerId: input.workspaceOwnerId,
      projectIdentityId: input.projectIdentityId,
      projectName: input.oldProjectName,
      deployPath: input.oldDeployPath,
    }),
    take: 2,
  });
  if (projectApps.length > 1) {
    throw new ProjectIdentityLifecycleError(
      'More than one App claims the same immutable Project identity',
    );
  }
  const projectApp = projectApps[0];
  if (projectApp) {
    assertProjectRuntimeLifecycleMutable(projectApp, 'rename-project');
    await transaction.app.update({
      where: { id: projectApp.id },
      data: {
        projectIdentityId: input.projectIdentityId,
        name: input.newProjectName,
        processStatus: 'stopped',
        ...(projectApp.deployType === 'runtime'
          ? { zipPath: desktopRuntimeDir }
          : projectApp.zipPath === input.oldDeployPath
            ? { zipPath: input.newDeployPath }
            : {}),
      },
    });
  }
  if (await transaction.app.count({
    where: {
      projectIdentityId: input.projectIdentityId,
      name: { not: input.newProjectName },
    },
  }) > 0) {
    throw new ProjectIdentityLifecycleError('A Project App row remained under the old rename identity');
  }
}

function convergeInterruptedProjectDeployment(input: {
  mode: 'cancel' | 'complete' | 'continue';
  identity: ProjectIdentityRecord;
  oldDeployPath: string;
  newDeployPath: string;
}): 'absent' | 'old' | 'new' {
  const expected = readProjectIdentityRenameDeployIdentity(input.identity);
  const oldExists = managedPathExists(input.oldDeployPath);
  const newExists = managedPathExists(input.newDeployPath);
  if (!expected) {
    if (oldExists || newExists) {
      throw new ProjectIdentityLifecycleError(
        'A deployment directory appeared after Project rename started',
      );
    }
    return 'absent';
  }
  if (oldExists === newExists) {
    throw new ProjectIdentityLifecycleError(
      'Interrupted Project rename has ambiguous deployment directories',
    );
  }
  const actual = attestProjectRoot(oldExists ? input.oldDeployPath : input.newDeployPath);
  if (!sameAttestedDirectoryIdentity(expected, actual)) {
    throw new ProjectIdentityLifecycleError(
      'Interrupted Project rename deployment no longer matches its durable identity',
    );
  }
  if (input.mode === 'complete') {
    if (oldExists) {
      throw new ProjectIdentityLifecycleError(
        'Interrupted Project rename moved its root before its deployment directory',
      );
    }
    return 'new';
  }
  if (input.mode === 'continue') {
    return oldExists ? 'old' : 'new';
  }
  if (newExists) {
    moveAttestedDirectoryNoReplace({
      sourceRoot: input.newDeployPath,
      targetRoot: input.oldDeployPath,
      expectedIdentity: expected,
    });
  }
  return 'old';
}

async function completeInterruptedProjectRenameWithApps(input: {
  workspaceOwnerId: string;
  projectIdentityId: string;
  oldProjectName: string;
  newProjectName: string;
  newProjectRoot: string;
  oldDeployPath: string;
  newDeployPath: string;
}) {
  const projectApp = await findProjectAppForIdentity({
    workspaceOwnerId: input.workspaceOwnerId,
    projectIdentityId: input.projectIdentityId,
    projectName: input.oldProjectName,
    deployPath: input.oldDeployPath,
  });
  assertProjectRuntimeLifecycleMutable(projectApp, 'rename-project');
  return prisma.$transaction(async (transaction) => {
    const recovered = await recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: input.workspaceOwnerId,
      projectName: input.newProjectName,
      projectRoot: input.newProjectRoot,
    }, transaction as unknown as ProjectIdentityDatabase);
    if (!recovered || recovered.id !== input.projectIdentityId) return null;
    await retargetProjectAppsForRename(transaction, input);
    return recovered;
  });
}

async function retireLegacyOpenClawRuntimesForProject(input: {
  actorUserIds: readonly string[];
  projectIdentityId: string;
  legacyProjectName: string;
  legacyProjectOwnerId: string;
  targetCanonicalRoot: string;
  preserveTranscriptFiles?: boolean;
}): Promise<void> {
  // CURRENT identities are issued only by the Portal 4 create/clone/upload
  // boundary and by contract never adopt name-keyed 3.x OpenClaw state, so
  // there is nothing legacy to retire for them. The global retirement service
  // stays behind the sticky migration gate for every other lineage; routing a
  // CURRENT project through it would let unrelated preserved 3.x evidence veto
  // this project's own rename/delete forever.
  const identity = await prisma.projectIdentity.findUnique({
    where: { id: input.projectIdentityId },
    select: { legacyOpenClawMigrationStatus: true },
  });
  if (identity?.legacyOpenClawMigrationStatus === 'CURRENT') {
    await assertLegacyOpenClawProjectMigrationInactive(input.projectIdentityId);
    return;
  }
  for (const actorUserId of input.actorUserIds) {
    const stableSlug = `p-${crypto.createHash('sha256')
      .update(`slug\0${actorUserId}\0${input.projectIdentityId}`)
      .digest('hex')
      .slice(0, 32)}`;
    const legacyAgentId = getProjectAgentId(actorUserId, stableSlug);
    const legacySessionId = getProjectSessionId(actorUserId, stableSlug);
    try {
      await retireLegacyOpenClawProjectRuntime({
        actorUserId,
        targetProjectIds: actorUserId === input.legacyProjectOwnerId
          ? [input.projectIdentityId, input.legacyProjectName]
          : [input.projectIdentityId],
        targetCanonicalRoot: input.targetCanonicalRoot,
        exactServerOwnedSessionKeys: [
          `agent:${legacyAgentId}:${legacySessionId}`,
          `agent:portal:${legacySessionId}`,
        ],
        adapterOwnedSessionKeys: [deriveOpenClawProjectSessionKey({
          userId: actorUserId,
          projectId: input.projectIdentityId,
        })],
        preserveTranscriptFiles: input.preserveTranscriptFiles,
        retireRootAttestedConfigOnlyAgents: true,
      });
    } catch (error) {
      const cleanupError = new ProjectRuntimeCleanupError(
        'CLEANUP_FAILED',
        'Legacy OpenClaw Project runtime cleanup could not be verified',
        'OPENCLAW',
      );
      (cleanupError as Error & { cause?: unknown }).cause = error;
      throw cleanupError;
    }
  }
}

interface ProjectRenameConvergenceResult {
  projectName: string;
  projectDir: string;
  recovered: boolean;
  renamedTo?: string;
}

/**
 * Destructive chat resets without a proven CURRENT identity need both release
 * gates. Rename/delete pass their immutable CURRENT identity into convergence
 * and use the scoped branch below instead.
 */
async function assertLegacyOpenClawProjectDestructiveMutationSafe(): Promise<void> {
  await assertLegacyOpenClawProjectMigrationInactive();
  await assertNoLegacyOpenClawProjectEvidence();
}

/**
 * Destructive operations must not silently cancel a partially cleaned rename.
 * An expired old-root journal is claimed, fully cleaned again, and cancelled;
 * an expired target-root journal is completed only after callback/app/legacy
 * absence is reasserted. A caller holding the current name lock never crosses
 * over and mutates a differently named target without owning its lock.
 */
async function convergeInterruptedProjectRenameForDestructiveOperation(input: {
  actorUserId: string;
  workspaceOwnerId: string;
  projectName: string;
  currentProjectIdentityId?: string;
}): Promise<ProjectRenameConvergenceResult> {
  const assertMutationSafe = async (projectIdentityId = input.currentProjectIdentityId) => {
    if (input.currentProjectIdentityId) {
      if (projectIdentityId !== input.currentProjectIdentityId) {
        throw new ProjectIdentityLifecycleError(
          'Interrupted Project rename belongs to a different immutable identity',
        );
      }
      await assertLegacyOpenClawProjectMigrationInactive(input.currentProjectIdentityId);
      return;
    }
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
  };
  await assertMutationSafe();
  const journal = await readProjectIdentityRenameJournal({
    workspaceOwnerId: input.workspaceOwnerId,
    projectName: input.projectName,
  });
  const currentProjectDir = getProjectPath(input.workspaceOwnerId, input.projectName);
  if (!journal) {
    return { projectName: input.projectName, projectDir: currentProjectDir, recovered: false };
  }
  const journalApp = await findProjectAppForIdentity({
    workspaceOwnerId: input.workspaceOwnerId,
    projectIdentityId: journal.id,
    projectName: journal.projectName,
    deployPath: path.join(DEPLOY_DIR, `${input.workspaceOwnerId}-${journal.projectName}`),
  });
  assertProjectRuntimeLifecycleMutable(journalApp, 'rename-project');
  await assertMutationSafe(journal.id);
  await assertProjectChatDestructiveResetInactive(journal.id);
  await assertLegacyOpenClawProjectMigrationInactive(journal.id);
  if (!(journal.renameLeaseExpiresAt instanceof Date)
    || journal.renameLeaseExpiresAt.getTime() > Date.now()) {
    throw new ProjectIdentityLifecycleError('Project rename is still in progress');
  }
  const targetName = String(journal.renameTargetName || '');
  const targetDir = getProjectPath(input.workspaceOwnerId, targetName);
  const oldDir = path.resolve(journal.canonicalRoot);
  const oldExists = fs.existsSync(oldDir);
  const targetExists = fs.existsSync(targetDir);
  if (oldExists === targetExists) {
    throw new ProjectIdentityLifecycleError(
      'Interrupted Project rename has ambiguous filesystem state and cannot be changed safely',
    );
  }
  if (targetExists && input.projectName !== targetName) {
    return {
      projectName: input.projectName,
      projectDir: currentProjectDir,
      recovered: false,
      renamedTo: targetName,
    };
  }

  if (targetExists) {
    if (!(journal.renameRuntimeCleanedAt instanceof Date)) {
      throw new ProjectIdentityLifecycleError(
        'Interrupted Project rename moved its root before runtime cleanup was durably recorded',
      );
    }
    const actorUserIds = await listProjectLifecycleActorIds({
      projectIdentityId: journal.id,
      workspaceOwnerId: input.workspaceOwnerId,
      authenticatedActorId: input.actorUserId,
    });
    await assertMutationSafe(journal.id);
    for (const actorUserId of actorUserIds) {
      if (actorUserId === input.workspaceOwnerId) {
        await migrateLegacyProjectChatState({
          actorUserId,
          legacyProjectId: journal.projectName,
          immutableProjectId: journal.id,
        });
      }
      await quiesceProjectChatBrokerCallbacksForDestructiveReset({
        actorUserId,
        projectIdentityId: journal.id,
      });
    }
    await retireLegacyOpenClawRuntimesForProject({
      actorUserIds,
      projectIdentityId: journal.id,
      legacyProjectName: journal.projectName,
      legacyProjectOwnerId: input.workspaceOwnerId,
      targetCanonicalRoot: journal.canonicalRoot,
      preserveTranscriptFiles: true,
    });
    await removePortalProjectWorkloadsForProject(journal.id);
    await stopApp(`${input.workspaceOwnerId}-${journal.projectName}`);
    await stopProjectDesktopRuntimesForLifecycle({
      workspaceOwnerId: input.workspaceOwnerId,
      projectIdentityId: journal.id,
      projectName: journal.projectName,
    });
    const oldDeployPath = path.join(DEPLOY_DIR, `${input.workspaceOwnerId}-${journal.projectName}`);
    const newDeployPath = path.join(DEPLOY_DIR, `${input.workspaceOwnerId}-${targetName}`);
    convergeInterruptedProjectDeployment({
      mode: 'complete',
      identity: journal,
      oldDeployPath,
      newDeployPath,
    });
    const recovered = await completeInterruptedProjectRenameWithApps({
      workspaceOwnerId: input.workspaceOwnerId,
      projectIdentityId: journal.id,
      oldProjectName: journal.projectName,
      newProjectName: targetName,
      newProjectRoot: targetDir,
      oldDeployPath,
      newDeployPath,
    });
    if (!recovered || recovered.projectName !== targetName) {
      throw new ProjectIdentityLifecycleError('Interrupted Project rename target could not be verified');
    }
    return { projectName: targetName, projectDir: targetDir, recovered: true };
  }

  await assertMutationSafe(journal.id);
  const grant = await beginProjectIdentityRename({
    workspaceOwnerId: input.workspaceOwnerId,
    oldProjectName: journal.projectName,
    newProjectName: targetName,
    oldProjectRoot: oldDir,
    newProjectRoot: targetDir,
    deployRootIdentity: readProjectIdentityRenameDeployIdentity(journal),
  });
  let timer: NodeJS.Timeout | null = null;
  let renewal: Promise<void> = Promise.resolve();
  let renewalFailure: unknown = null;
  const queueRenewal = () => {
    if (renewalFailure) return;
    renewal = renewal.then(async () => {
      await renewProjectIdentityRenameLease({
        projectIdentityId: grant.identity.id,
        leaseToken: grant.leaseToken,
      });
    }).catch((error) => { renewalFailure = error; });
  };
  timer = setInterval(queueRenewal, 30_000);
  timer.unref?.();
  try {
    await markProjectIdentityRenameCleanupStarted({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
    });
    await assertMutationSafe(journal.id);
    const actorUserIds = await listProjectLifecycleActorIds({
      projectIdentityId: journal.id,
      workspaceOwnerId: input.workspaceOwnerId,
      authenticatedActorId: input.actorUserId,
    });
    for (const actorUserId of actorUserIds) {
      if (actorUserId === input.workspaceOwnerId) {
        await migrateLegacyProjectChatState({
          actorUserId,
          legacyProjectId: journal.projectName,
          immutableProjectId: journal.id,
        });
      }
      await quiesceProjectChatBrokerCallbacksForDestructiveReset({
        actorUserId,
        projectIdentityId: journal.id,
      });
    }
    await cleanupProjectRuntime({
      authenticatedActorId: input.actorUserId,
      workspaceOwnerId: input.workspaceOwnerId,
      projectIdentity: grant.identity,
      lifecycleReason: 'rename',
    }, {
      adapters: PROJECT_RUNTIME_CLEANUP_ADAPTERS,
      egressAdapter: PROJECT_EGRESS_CLEANUP_ADAPTER,
    });
    await retireLegacyOpenClawRuntimesForProject({
      actorUserIds,
      projectIdentityId: journal.id,
      legacyProjectName: journal.projectName,
      legacyProjectOwnerId: input.workspaceOwnerId,
      targetCanonicalRoot: journal.canonicalRoot,
      preserveTranscriptFiles: true,
    });
    await removePortalProjectWorkloadsForProject(journal.id);
    await stopApp(`${input.workspaceOwnerId}-${journal.projectName}`);
    await stopProjectDesktopRuntimesForLifecycle({
      workspaceOwnerId: input.workspaceOwnerId,
      projectIdentityId: journal.id,
      projectName: journal.projectName,
    });
    clearInterval(timer);
    timer = null;
    await renewal;
    if (renewalFailure) throw renewalFailure;
    await renewProjectIdentityRenameLease({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
    });
    await prisma.$transaction(async (transaction) => {
      const projectRows = {
        OR: [
          { projectId: journal.id },
          { userId: input.workspaceOwnerId, projectId: journal.projectName },
        ],
      };
      await transaction.projectChatProviderBinding.deleteMany({ where: projectRows });
      await transaction.projectChatSession.deleteMany({ where: projectRows });
      const activeState = await transaction.projectChatState.findFirst({
        where: { projectIdentityId: journal.id, activeTurnId: { not: null } },
        select: { id: true },
      });
      if (activeState) {
        throw new ProjectIdentityLifecycleError(
          'Interrupted Project rename still has an active Project Chat turn',
        );
      }
      await transaction.projectChatState.updateMany({
        where: { projectIdentityId: journal.id, activeTurnId: null },
        data: { version: { increment: 1 } },
      });
      await markProjectIdentityRenameRuntimeCleaned({
        projectIdentityId: journal.id,
        leaseToken: grant.leaseToken,
      }, transaction as unknown as ProjectIdentityDatabase);
    });
    for (const provider of QUALIFIABLE_PROJECT_PROVIDERS) {
      removeProjectQualificationEvidenceForProject(provider, journal.id);
    }
    convergeInterruptedProjectDeployment({
      mode: 'cancel',
      identity: journal,
      oldDeployPath: path.join(DEPLOY_DIR, `${input.workspaceOwnerId}-${journal.projectName}`),
      newDeployPath: path.join(DEPLOY_DIR, `${input.workspaceOwnerId}-${targetName}`),
    });
    await prisma.$transaction(async (transaction) => {
      await cancelProjectIdentityRename({
        projectIdentityId: journal.id,
        leaseToken: grant.leaseToken,
        oldProjectRoot: oldDir,
      }, transaction as unknown as ProjectIdentityDatabase);
      await transaction.app.updateMany({
        where: projectAppAssociationWhere({
          workspaceOwnerId: input.workspaceOwnerId,
          projectIdentityId: journal.id,
          projectName: journal.projectName,
          deployPath: path.join(
            DEPLOY_DIR,
            `${input.workspaceOwnerId}-${journal.projectName}`,
          ),
        }),
        data: { processStatus: 'stopped' },
      });
    });
    return { projectName: journal.projectName, projectDir: oldDir, recovered: true };
  } finally {
    if (timer) clearInterval(timer);
    await renewal.catch(() => undefined);
  }
}

/** one structured line per project lifecycle decision that is not a 2xx. */
function logProjectLifecycleDecision(input: {
  route: string;
  code: string;
  status: number;
  workspaceOwnerId?: string;
  projectName?: string;
  projectIdentityId?: string | null;
  detail?: string;
}): void {
  console.error('[ProjectLifecycle]', JSON.stringify(input));
}

const lifecycleResidueRecoveryState = new Map<string, { at: number; running: boolean }>();
const LIFECYCLE_RESIDUE_RECOVERY_COOLDOWN_MS = 20_000;

/**
 * expired RENAMING/DELETING journals resolve themselves shortly after
 * the next touching request instead of waiting for operator surgery. Runs
 * detached from the triggering request; the deletion-lock keys serialize it
 * against real rename/delete traffic and a per-owner cooldown bounds load.
 * A journal whose lease is still live is never touched.
 */
async function recoverProjectLifecycleResidueForOwner(input: {
  actorUserId: string;
  workspaceOwnerId: string;
}): Promise<void> {
  const residues = await prisma.projectIdentity.findMany({
    where: {
      workspaceOwnerId: input.workspaceOwnerId,
      lifecycleStatus: { in: ['RENAMING', 'DELETING'] },
    },
  });
  for (const identity of residues) {
    try {
      if (identity.lifecycleStatus === 'RENAMING') {
        const expiry = identity.renameLeaseExpiresAt;
        if (expiry instanceof Date && expiry.getTime() > Date.now()) continue;
        const releases: Array<() => void> = [];
        try {
          const lockNames = Array.from(new Set([
            identity.projectName,
            ...(identity.renameTargetName ? [identity.renameTargetName] : []),
          ]));
          for (const key of lockNames
            .map((name) => projectDeletionLockKey(input.workspaceOwnerId, name))
            .sort()) {
            releases.push(await acquireProjectDeletionLock(key));
          }
          const converged = await convergeInterruptedProjectRenameForDestructiveOperation({
            actorUserId: input.actorUserId,
            workspaceOwnerId: input.workspaceOwnerId,
            projectName: identity.projectName,
            currentProjectIdentityId: identity.id,
          });
          logProjectLifecycleDecision({
            route: 'lifecycle-residue-recovery',
            code: converged.recovered
              ? 'PROJECT_RENAME_RESIDUE_RECOVERED'
              : 'PROJECT_RENAME_RESIDUE_UNCHANGED',
            status: 200,
            workspaceOwnerId: input.workspaceOwnerId,
            projectName: identity.projectName,
            projectIdentityId: identity.id,
            detail: converged.renamedTo
              ? `completed as ${converged.renamedTo}`
              : `active as ${converged.projectName}`,
          });
        } finally {
          for (const release of releases.reverse()) release();
        }
      } else {
        // DELETING is durable, already-admitted intent; finishing it is the
        // only terminal state that does not resurrect a half-deleted project.
        const release = await acquireProjectDeletionLock(
          projectDeletionLockKey(input.workspaceOwnerId, identity.projectName),
        );
        try {
          const current = await prisma.projectIdentity.findUnique({ where: { id: identity.id } });
          if (!current || current.lifecycleStatus !== 'DELETING') continue;
          await completeAdmittedProjectDeletion({
            actorUserId: input.actorUserId,
            ownerId: input.workspaceOwnerId,
            projectName: current.projectName,
            projectDir: getProjectPath(input.workspaceOwnerId, current.projectName),
            projectIdentity: current as unknown as ProjectIdentityRecord,
          });
          logProjectLifecycleDecision({
            route: 'lifecycle-residue-recovery',
            code: 'PROJECT_DELETE_RESIDUE_COMPLETED',
            status: 200,
            workspaceOwnerId: input.workspaceOwnerId,
            projectName: current.projectName,
            projectIdentityId: current.id,
          });
        } finally {
          release();
        }
      }
    } catch (error) {
      logProjectLifecycleDecision({
        route: 'lifecycle-residue-recovery',
        code: 'PROJECT_LIFECYCLE_RESIDUE_RECOVERY_FAILED',
        status: 500,
        workspaceOwnerId: input.workspaceOwnerId,
        projectName: identity.projectName,
        projectIdentityId: identity.id,
        detail: String((error as Error)?.message || error).slice(0, 300),
      });
    }
  }
}

function scheduleProjectLifecycleResidueRecovery(input: {
  actorUserId: string;
  workspaceOwnerId: string;
}): void {
  const entry = lifecycleResidueRecoveryState.get(input.workspaceOwnerId);
  const now = Date.now();
  if (entry && (entry.running || now - entry.at < LIFECYCLE_RESIDUE_RECOVERY_COOLDOWN_MS)) return;
  let releaseAuthorizationLease: () => void;
  try {
    // Acquire before detaching. Otherwise the GET response can release its
    // admission, an ownership/sandbox change can commit, and this old-scope
    // recovery can still rename or delete workspace state afterward.
    releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(input.actorUserId);
  } catch {
    return;
  }
  lifecycleResidueRecoveryState.set(input.workspaceOwnerId, { at: now, running: true });
  try {
    setImmediate(() => {
      recoverProjectLifecycleResidueForOwner(input)
        .catch(() => undefined)
        .finally(() => {
          lifecycleResidueRecoveryState.set(input.workspaceOwnerId, { at: Date.now(), running: false });
          releaseAuthorizationLease();
        });
    });
  } catch {
    lifecycleResidueRecoveryState.set(input.workspaceOwnerId, { at: Date.now(), running: false });
    releaseAuthorizationLease();
  }
}

async function ensureOpenClawProjectChatBinding(input: {
  actorUserId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectDir: string;
  executionContext: ProjectSandboxExecutionContext;
  model?: string | null;
}) {
  await assertLegacyOpenClawProjectMigrationInactive(input.executionContext.projectId);
  const qualificationGrant = requireProjectQualification('OPENCLAW', {
    context: input.executionContext,
    egress: buildProjectEgressConfig({
      context: input.executionContext,
      provider: 'OPENCLAW',
    }),
  });
  const agentId = deriveOpenClawProjectAgentId(input.executionContext);
  const sessionKey = deriveOpenClawProjectSessionKey(input.executionContext);
  const identity = {
    version: 2 as const,
    projectInstanceId: input.executionContext.projectId,
    workspaceOwnerId: input.workspaceOwnerId,
    stableSlug: `p-${input.executionContext.projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`,
    createdAt: new Date().toISOString(),
    legacySlug: normalizeProjectSlug(input.projectName),
    agentId,
    // Portal database rows use the full immutable session key. It is globally
    // unique; the provider-specific suffix alone is deliberately not.
    sessionId: sessionKey,
    sessionKey,
  };
  const portalTranscriptCursor = await prisma.projectChatMessage.count({
    where: { userId: input.actorUserId, projectId: input.executionContext.projectId },
  });
  const binding = await ensureProjectChatProviderBinding({
      userId: input.actorUserId,
      projectId: input.executionContext.projectId,
      provider: 'OPENCLAW',
      executionContext: input.executionContext,
      sessionKey: identity.sessionKey,
      legacySessionKey: null,
      externalSessionId: identity.sessionKey,
      model: input.model,
      qualificationGrant,
    });
  return {
    identity,
    needsBootstrap: projectChatBindingNeedsHandoff(binding, portalTranscriptCursor),
    handoffCursor: binding.handoffCursor,
    handoffVersion: binding.handoffVersion,
    binding,
  };
}

async function ensureOpenClawProjectAgentCatalogScope(
  executionContext: ProjectSandboxExecutionContext,
) {
  const agentId = deriveOpenClawProjectAgentId(executionContext);
  const sessionKey = deriveOpenClawProjectSessionKey(executionContext);
  // Keep the copied credential/model files in place both before container
  // convergence and after the exact agent is registered in OpenClaw config.
  syncProjectAgentRuntimeFiles(agentId);
  const sandbox = await ensureOpenClawProjectSandbox({
    context: executionContext,
    agentId,
    sessionKey,
    egress: buildProjectEgressConfig({
      context: executionContext,
      provider: 'OPENCLAW',
    }),
  });
  syncProjectAgentRuntimeFiles(agentId);
  return { agentId, sessionKey, sandbox };
}

async function ensureOpenClawProjectRuntime(input: Parameters<typeof ensureOpenClawProjectChatBinding>[0]) {
  const resolved = await ensureOpenClawProjectChatBinding(input);
  const { sandbox } = await ensureOpenClawProjectAgentCatalogScope(input.executionContext);
  return { ...resolved, sandbox };
}

async function verifyAndPersistOpenClawProjectModel(input: {
  actorUserId: string;
  projectId: string;
  portalSessionKey: string;
  providerSessionKey: string;
  desiredModel: string;
}) {
  // External runtime mutation happens before either Portal model column is
  // touched. If patching or readback fails, the last verified binding remains
  // intact and the surrounding admission/switch operation fails closed.
  const result = await verifyThenPersistOpenClawProjectModel({
    sessionKey: input.providerSessionKey,
    desiredModel: input.desiredModel,
    persistVerifiedModel: async (verifiedModel) => {
      const now = new Date();
      const [binding] = await prisma.$transaction([
        prisma.projectChatProviderBinding.update({
          where: {
            userId_projectId_provider: {
              userId: input.actorUserId,
              projectId: input.projectId,
              provider: 'OPENCLAW',
            },
          },
          data: {
            model: verifiedModel,
            status: 'active',
            lastActivity: now,
          },
        }),
        prisma.projectChatSession.updateMany({
          where: {
            userId: input.actorUserId,
            projectId: input.projectId,
            sessionKey: input.portalSessionKey,
          },
          data: {
            model: verifiedModel,
            status: 'active',
            lastActivity: now,
          },
        }),
      ]);
      return binding;
    },
    failProviderClosed: async () => {
      const now = new Date();
      await prisma.$transaction([
        prisma.projectChatProviderBinding.updateMany({
          where: {
            userId: input.actorUserId,
            projectId: input.projectId,
            provider: 'OPENCLAW',
          },
          data: {
            status: 'error',
            lastActivity: now,
          },
        }),
        prisma.projectChatSession.updateMany({
          where: {
            userId: input.actorUserId,
            projectId: input.projectId,
            sessionKey: input.portalSessionKey,
          },
          data: {
            status: 'error',
            lastActivity: now,
          },
        }),
      ]);
    },
  });
  return {
    binding: result.persisted,
    verified: result.verified,
  };
}

async function ensureNativeProjectChatBinding(input: {
  actorUserId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectDir: string;
  provider: NativeProjectChatRouteProvider;
  executionContext: ProjectSandboxExecutionContext;
  model?: string | null;
}) {
  if (input.provider === 'OLLAMA') {
    return withOllamaAuthorityRunLease(
      () => ensureNativeProjectChatBindingWithAuthorityLease(input),
    );
  }
  return ensureNativeProjectChatBindingWithAuthorityLease(input);
}

async function ensureNativeProjectChatBindingWithAuthorityLease(input: {
  actorUserId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectDir: string;
  provider: NativeProjectChatRouteProvider;
  executionContext: ProjectSandboxExecutionContext;
  model?: string | null;
}) {
  const descriptor = getProjectChatProviderRuntimeDescriptor(input.provider);
  const existingBinding = await prisma.projectChatProviderBinding.findUnique({
    where: {
      userId_projectId_provider: {
        userId: input.actorUserId,
        projectId: input.executionContext.projectId,
        provider: input.provider,
      },
    },
  });
  const qualificationInput = {
    context: input.executionContext,
    egress: buildProjectEgressConfig({
      context: input.executionContext,
      provider: input.provider,
    }),
  };
  let qualificationGrant = requireProjectQualification(input.provider, qualificationInput);
  let agentZeroModelSelection: AgentZeroProjectModelSelection | undefined;
  if (input.provider === 'AGENT_ZERO') {
    const evidencedSelection: AgentZeroProjectModelSelection = {
      providerId: String(qualificationGrant.modelProviderId || '') as AgentZeroProjectModelSelection['providerId'],
      model: String(qualificationGrant.modelId || ''),
    };
    const requestedBinding = String(input.model || '').trim();
    const requestedSelection = requestedBinding
      ? parseAgentZeroProjectModelBinding(requestedBinding)
      : evidencedSelection;
    agentZeroModelSelection = await resolveAllowedAgentZeroProjectModel(requestedSelection);
    if (agentZeroModelSelection.providerId !== evidencedSelection.providerId
      || agentZeroModelSelection.model !== evidencedSelection.model) {
      throw new AgentZeroProjectModelSelectionError(
        'The connected Agent Zero OAuth model no longer matches this project qualification. Qualify the selected model again.',
      );
    }
    qualificationGrant = requireProjectQualification('AGENT_ZERO', {
      ...qualificationInput,
      agentZeroModelSelection,
    });
  }
  let ollamaModelSelection: OllamaProjectModelSelection | undefined;
  if (input.provider === 'OLLAMA') {
    const evidencedModel = String(qualificationGrant.modelId || '').trim();
    const requestedModel = String(input.model || '').trim() || evidencedModel;
    if (!requestedModel || !qualificationGrant.modelDigest) {
      throw new OllamaProjectModelSelectionError(
        'Ollama Project qualification did not retain an exact model digest.',
      );
    }
    ollamaModelSelection = await resolveAllowedOllamaProjectModel(
      [evidencedModel],
      requestedModel,
    );
    if (
      ollamaModelSelection.model !== evidencedModel
      || ollamaModelSelection.digest !== qualificationGrant.modelDigest
      || ollamaModelSelection.backendKind !== qualificationGrant.ollamaBackendKind
      || ollamaModelSelection.backendFingerprint !== qualificationGrant.ollamaBackendFingerprint
      || ollamaModelSelection.backendGeneration !== qualificationGrant.ollamaBackendGeneration
    ) {
      throw new OllamaProjectModelSelectionError(
        'The Ollama backend or installed model no longer matches this project qualification. Qualify the selected model again.',
      );
    }
  }
  const identity = await ensureProjectAssistantIdentity(input.projectDir, input.actorUserId, input.projectName, {
    workspaceOwnerId: input.workspaceOwnerId,
  });
  const portalTranscriptCursor = await prisma.projectChatMessage.count({
    where: { userId: input.actorUserId, projectId: input.executionContext.projectId },
  });
  const modelCandidates = [input.model, existingBinding?.model];
  const selectedModel = input.provider === 'CODEX'
    ? await resolveAllowedCodexProjectModel(modelCandidates, input.model)
    : input.provider === 'CLAUDE_CODE'
      ? await resolveAllowedClaudeCodeProjectModel(modelCandidates, input.model)
      : input.provider === 'GEMINI'
        ? await resolveAllowedAntigravityProjectModel(modelCandidates, input.model)
        : input.provider === 'AGENT_ZERO'
          ? agentZeroProjectModelBindingValue(agentZeroModelSelection!)
          : ollamaModelSelection!.model;
  if (input.provider === 'AGENT_ZERO'
    && existingBinding?.sessionKey
    && existingBinding.externalSessionId
    && existingBinding.sessionKey !== existingBinding.externalSessionId) {
    throw new ProjectChatBindingReadError(
      'The existing Agent Zero Project binding contains conflicting remote context identities.',
    );
  }
  const persistedProviderSessionId = String(
    existingBinding?.sessionKey || existingBinding?.externalSessionId || '',
  ).trim();
  const loadedNativeSession = persistedProviderSessionId
    ? loadNativeSession(input.provider, persistedProviderSessionId)
    : null;
  let nativeSession = loadedNativeSession;
  if (
    !nativeSession
    || nativeSession.userId !== input.actorUserId
    || !nativeSession.executionContext
    || !executionContextsMatch(nativeSession.executionContext, input.executionContext)
  ) {
    nativeSession = null;
  }
  if (input.provider === 'OLLAMA' && nativeSession) {
    const metadataHasBackendIdentity = (
      nativeSession.metadata?.ollamaBackendKind !== undefined
      || nativeSession.metadata?.ollamaBackendFingerprint !== undefined
      || nativeSession.metadata?.ollamaBackendGeneration !== undefined
    );
    const sessionBackendKind = metadataHasBackendIdentity
      ? nativeSession.metadata?.ollamaBackendKind
      : 'LOCAL';
    const sessionBackendFingerprint = metadataHasBackendIdentity
      ? nativeSession.metadata?.ollamaBackendFingerprint
      : 'local-ollama-v1:127.0.0.1:11434';
    const sessionBackendGeneration = metadataHasBackendIdentity
      ? nativeSession.metadata?.ollamaBackendGeneration
      : null;
    if (
      nativeSession.model !== ollamaModelSelection!.model
      || nativeSession.metadata?.ollamaModelDigest !== ollamaModelSelection!.digest
      || nativeSession.metadata?.ollamaToolQualified !== true
      || nativeSession.metadata?.ollamaRuntimeQuarantined === true
      || sessionBackendKind !== ollamaModelSelection!.backendKind
      || sessionBackendFingerprint !== ollamaModelSelection!.backendFingerprint
      || sessionBackendGeneration !== ollamaModelSelection!.backendGeneration
    ) {
      throw new ProjectChatBindingReadError(
        'The existing Ollama Project session no longer matches the qualified backend and model. Clear it before creating a replacement.',
      );
    }
  }
  if (input.provider === 'AGENT_ZERO' && nativeSession) {
    if (nativeSession.metadata?.agentZeroRuntimeQuarantined === true
      || String(nativeSession.metadata?.agentZeroActiveRunId || '').trim()) {
      throw new ProjectChatBindingReadError(
        'The existing Agent Zero Project context is active or quarantined and cannot change models.',
      );
    }
    if (nativeSession.model !== agentZeroModelSelection!.model
      || nativeSession.metadata?.agentZeroOAuthProviderId !== agentZeroModelSelection!.providerId
      || nativeSession.metadata?.agentZeroModel !== agentZeroModelSelection!.model) {
      await rebindAgentZeroProjectSessionModel({
        sessionId: nativeSession.sessionId,
        selection: agentZeroModelSelection!,
      });
      nativeSession = loadNativeSession('AGENT_ZERO', nativeSession.sessionId);
      if (!nativeSession
        || nativeSession.model !== agentZeroModelSelection!.model
        || nativeSession.metadata?.agentZeroOAuthProviderId !== agentZeroModelSelection!.providerId
        || nativeSession.metadata?.agentZeroModel !== agentZeroModelSelection!.model
        || nativeSession.metadata?.agentZeroRuntimeQuarantined === true) {
        throw new ProjectChatBindingReadError(
          'Agent Zero did not persist the exact newly qualified OAuth model binding.',
        );
      }
    }
  }
  if (input.provider === 'AGENT_ZERO' && persistedProviderSessionId && !loadedNativeSession) {
    throw new ProjectChatBindingReadError(
      'The existing Agent Zero Project context is missing locally, so its remote cleanup cannot be verified.',
    );
  }
  if (input.provider === 'AGENT_ZERO' && loadedNativeSession && !nativeSession
    && loadNativeSession('AGENT_ZERO', loadedNativeSession.sessionId)) {
    // If the loaded record failed actor/context validation, it is not safe to
    // mutate through this request. A deliberate cleanup path must resolve
    // ownership first.
    throw new ProjectChatBindingReadError(
      'The existing Agent Zero Project context does not match this actor and project.',
    );
  }
  if (input.provider === 'OLLAMA' && loadedNativeSession && !nativeSession
    && loadNativeSession('OLLAMA', loadedNativeSession.sessionId)) {
    throw new ProjectChatBindingReadError(
      'The existing Ollama Project context does not match this actor and project. Clear it before creating a replacement.',
    );
  }
  const replacingNativeSession = Boolean(
    existingBinding
    && !nativeSession
    && (
      existingBinding.sessionKey
      || existingBinding.externalSessionId
      || existingBinding.handoffCursor > 0
    )
  );

  const cliModel = input.provider === 'CODEX'
    ? codexCliModelId(selectedModel)
    : input.provider === 'CLAUDE_CODE'
      ? claudeCodeCliModelId(selectedModel)
      : input.provider === 'GEMINI'
        ? normalizeAntigravityProjectModel(selectedModel) || undefined
        : input.provider === 'AGENT_ZERO'
          ? agentZeroModelSelection!.model
          : selectedModel;
  let sessionKey = nativeSession?.sessionId || '';
  let createdNativeSession = false;
  if (!sessionKey) {
    await ensureProjectChatWorkspaceOwnership(input.executionContext, input.projectDir);
    sessionKey = await getProjectChatProviderAdapter(input.provider).startSession(input.actorUserId, {
      executionContext: input.executionContext,
      ...(cliModel ? { model: cliModel } : {}),
      metadata: {
        cwd: input.executionContext.canonicalRoot,
        title: `${input.projectName} · ${descriptor.displayName}`,
        projectId: input.executionContext.projectId,
        projectName: input.projectName,
        workspaceOwnerId: input.workspaceOwnerId,
        projectRuntime: descriptor.runtime,
        ...(agentZeroModelSelection
          ? { agentZeroOAuthProviderId: agentZeroModelSelection.providerId }
          : {}),
        ...(ollamaModelSelection
          ? {
              ollamaBackendKind: ollamaModelSelection.backendKind,
              ollamaBackendFingerprint: ollamaModelSelection.backendFingerprint,
              ollamaBackendGeneration: ollamaModelSelection.backendGeneration,
            }
          : {}),
      },
    });
    createdNativeSession = true;
    if (input.provider === 'OLLAMA') {
      const createdSession = loadNativeSession('OLLAMA', sessionKey);
      if (
        !createdSession
        || createdSession.metadata?.ollamaModelDigest !== ollamaModelSelection!.digest
        || createdSession.metadata?.ollamaToolQualified !== true
        || createdSession.metadata?.ollamaBackendKind !== ollamaModelSelection!.backendKind
        || createdSession.metadata?.ollamaBackendFingerprint !== ollamaModelSelection!.backendFingerprint
        || createdSession.metadata?.ollamaBackendGeneration !== ollamaModelSelection!.backendGeneration
      ) {
        deleteNativeSession('OLLAMA', sessionKey);
        throw new OllamaProjectModelSelectionError(
          'Ollama changed while the Project session was being admitted. Qualify the model again.',
        );
      }
    }
  } else if (input.provider !== 'OLLAMA'
    && input.provider !== 'AGENT_ZERO'
    && cliModel
    && nativeSession?.model !== cliModel) {
    updateNativeSessionModel(input.provider, sessionKey, cliModel);
  }

  let binding;
  try {
    binding = await ensureProjectChatProviderBinding({
      userId: input.actorUserId,
      projectId: input.executionContext.projectId,
      provider: input.provider,
      executionContext: input.executionContext,
      sessionKey,
      legacySessionKey: identity.sessionId,
      externalSessionId: sessionKey,
      model: selectedModel,
      ...(agentZeroModelSelection ? { agentZeroModelSelection } : {}),
      ...(ollamaModelSelection ? { ollamaModelSelection } : {}),
      qualificationGrant,
      resetHandoff: replacingNativeSession,
    });
  } catch (error) {
    if (createdNativeSession) {
      if (input.provider === 'AGENT_ZERO') {
        try {
          // Agent Zero owns a remote context as well as the local session
          // record. A binding CAS failure must prove that remote context was
          // deleted; deleting only the Portal record would orphan an
          // independently runnable project context.
          await getProjectChatProviderAdapter('AGENT_ZERO').terminateSession(sessionKey);
        } catch (cleanupError) {
          const cleanupFailure = new Error(
            'Agent Zero Project binding failed and remote context cleanup could not be verified; the project remains quarantined.',
          );
          (cleanupFailure as Error & { cause?: unknown }).cause = cleanupError;
          throw cleanupFailure;
        }
      } else {
        deleteNativeSession(input.provider, sessionKey);
      }
    } else if (nativeSession) {
      // Binding persistence and the native invocation model are one logical
      // operation. Restore the preexisting file exactly if the database CAS
      // fails so a later read cannot observe split configuration.
      saveNativeSession(nativeSession);
    }
    throw error;
  }
  return {
    identity,
    binding,
    sessionKey,
    agentId: `${input.provider.toLowerCase().replace('_', '-')}-project`,
    created: createdNativeSession,
    needsBootstrap: projectChatBindingNeedsHandoff(binding, portalTranscriptCursor),
    handoffCursor: binding.handoffCursor,
    handoffVersion: binding.handoffVersion,
    configuredModel: selectedModel,
  };
}

async function ensureSelectedProjectChatBinding(input: {
  actorUserId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectDir: string;
  provider: AgentProviderName;
  executionContext: ProjectSandboxExecutionContext;
  model?: string | null;
}) {
  let resolved;
  if (input.provider === 'OPENCLAW') {
    const openClaw = await ensureOpenClawProjectChatBinding(input);
    resolved = {
      ...openClaw,
      sessionKey: openClaw.binding.sessionKey || openClaw.identity.sessionKey,
      agentId: openClaw.identity.agentId,
      created: false,
    };
  } else if (isNativeProjectChatRouteProvider(input.provider)) {
    resolved = await ensureNativeProjectChatBinding({ ...input, provider: input.provider });
  } else {
    throw new UnsupportedProjectChatProviderError(input.provider, 'No Project Sandbox broker is implemented for this provider.');
  }
  return resolved;
}

function isTextPreviewableFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const baseName = path.basename(normalized);
  const ext = path.extname(normalized);
  const previewableExts = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.json', '.jsonl', '.md', '.txt', '.xml', '.svg',
    '.py', '.sh', '.bash', '.zsh', '.fish', '.yml', '.yaml',
    '.sql', '.rs', '.go', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
    '.vue', '.svelte', '.toml', '.ini', '.conf', '.cfg', '.log',
  ]);
  const previewableNames = new Set(['dockerfile', '.gitignore', '.npmrc', '.gitattributes', '.editorconfig']);
  if (previewableExts.has(ext)) return true;
  if (previewableNames.has(baseName) || baseName.startsWith('.env')) return true;
  return false;
}

function listProjectRootRegularFiles(projectDir: string): string[] {
  return fs.readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function readProjectPackageJson(projectDir: string): Record<string, any> | null {
  const raw = readProjectTextFile(projectDir, 'package.json', {
    optional: true,
    maxBytes: PROJECT_METADATA_MAX_BYTES,
  });
  if (raw === null) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectFilePolicyError('NOT_REGULAR', 'package.json must contain a JSON object');
  }
  return parsed;
}

function getUserProjectDir(userId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid project owner');
  const directory = ensureContainedDirectory(PROJECTS_DIR, userId);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function getProjectPath(userId: string, projectName: string) {
  const userDir = getUserProjectDir(userId);
  if (!projectName || path.basename(projectName) !== projectName || projectName.includes('\\')) {
    throw new Error('Invalid project name');
  }
  return resolveContainedPath(userDir, projectName, { mustExist: false });
}

function getExistingProjectPathReadOnly(userId: string, projectName: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid project owner');
  if (!projectName || path.basename(projectName) !== projectName || projectName.includes('\\')) {
    throw new Error('Invalid project name');
  }
  return resolveContainedPath(PROJECTS_DIR, `${userId}/${projectName}`, {
    mustExist: true,
    kind: 'directory',
  });
}

/**
 * Project Chat is always scoped to the authenticated actor's own project tree.
 *
 * The broader Projects surface may intentionally map a SUB_ADMIN into the
 * Owner workspace for host-operator compatibility. That mapping is never a
 * valid sandbox principal: passing it into a provider would let one user's
 * agent mount another user's project. Keep this resolver separate from
 * getScopedOwnerId() so every Project Chat entry point fails closed.
 */
function resolveActorProjectChatWorkspace(req: Request, projectName: string) {
  const actorUserId = req.user?.userId;
  if (!actorUserId) throw new Error('Authenticated Project Chat actor is required');
  return {
    actorUserId,
    workspaceOwnerId: actorUserId,
    projectDir: getProjectPath(actorUserId, projectName),
  };
}

function sendProjectFileMutationError(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : fallback;
  if (error instanceof ProjectRuntimeOwnershipError) {
    res.status(503).json({
      error: 'Project storage is temporarily unavailable. Try again.',
      code: error.code,
      retryable: error.retryable,
    });
    return;
  }
  if (error instanceof ProjectFilePolicyError || error instanceof ContainedPathError) {
    const status = error instanceof ProjectFilePolicyError && error.code === 'TOO_LARGE'
      || /exceeds the configured limit/i.test(message)
      ? 413
      : /already exists/i.test(message)
        ? 409
        : 400;
    res.status(status).json({ error: message });
    return;
  }
  res.status(500).json({ error: fallback });
}

async function resolveProjectChatOperationContext(
  actorUserId: string,
  workspaceOwnerId: string,
  projectName: string,
  projectDir: string,
  requestedProvider: unknown,
  options: { requireQualification?: boolean; readOnly?: boolean } = {},
): Promise<{
  provider: ProjectChatRouteProvider;
  executionContext: ProjectSandboxExecutionContext;
  projectIdentity: ProjectIdentityRecord;
}> {
  const provider = requireProjectChatRouteProvider(normalizeProjectChatProvider(requestedProvider));
  const projectIdentity = options.readOnly
    ? await readProjectIdentity({
        workspaceOwnerId,
        projectName,
        projectRoot: projectDir,
      })
    : await ensureProjectIdentity({
    workspaceOwnerId,
    projectName,
    projectRoot: projectDir,
  });
  if (!projectIdentity) throw new ProjectChatUninitializedError();
  if (!options.readOnly) {
    // All providers share one visible transcript. Native turns must not race a
    // pending OpenClaw import or they can appear ahead of unimported history.
    // Unrelated projects remain available because the gate is identity-scoped.
    await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);
    await migrateLegacyProjectChatState({
      actorUserId,
      legacyProjectId: projectName,
      immutableProjectId: projectIdentity.id,
    });
  }
  const unqualifiedContextInput = {
        actorUserId,
        workspaceOwnerId,
        projectName,
        projectIdentity,
        projectDir,
        projectsRoot: PROJECTS_DIR,
      };
  const executionContext = buildUnqualifiedProjectSandboxExecutionContext(
    provider,
    unqualifiedContextInput,
  );
  if (options.requireQualification !== false) {
    requireProjectQualification(provider, {
      context: executionContext,
      egress: buildProjectEgressConfig({ context: executionContext, provider }),
    });
  }
  return { provider, executionContext, projectIdentity };
}

class ProjectChatUninitializedError extends Error {
  readonly code = 'PROJECT_CHAT_UNINITIALIZED';
  constructor() {
    super('Project Chat has not been initialized for this project.');
    this.name = 'ProjectChatUninitializedError';
  }
}

function sendProjectChatProviderError(
  res: Response,
  error: unknown,
  extra: Record<string, unknown> = {},
): boolean {
  if (error instanceof ProjectRuntimeOwnershipError) {
    res.status(503).json({
      error: 'Project storage is temporarily unavailable. Try again.',
      code: error.code,
      retryable: error.retryable,
      ...extra,
    });
    return true;
  }
  if (error instanceof ProjectLifecycleWorkspacePreparationError) {
    res.status(503).json({
      error: 'Portal could not prepare this project workspace for its provider. Retry after the current filesystem operation finishes.',
      code: error.code,
      retryable: error.retryable,
      ...extra,
    });
    return true;
  }
  if (error instanceof ProjectMemoryAccessError) {
    res.status(error.httpStatus).json({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      ...extra,
    });
    return true;
  }
  if (error instanceof OllamaAuthorityBarrierBusyError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      provider: 'OLLAMA',
      ...extra,
    });
    return true;
  }
  if (error instanceof LegacyOpenClawProjectMigrationActiveError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      ...extra,
    });
    return true;
  }
  if (sendProjectChatQualificationError(res, error, null, extra)) return true;
  // An optional provider runtime that is not installed is an ordinary,
  // actionable state, not a failed sandbox attestation. Reporting it as the
  // latter sent people hunting a security problem that was not there.
  if (error instanceof ProjectChatProviderRuntimeUnavailableError) {
    res.status(409).json({
      error: error.message,
      code: 'PROJECT_PROVIDER_RUNTIME_UNAVAILABLE',
      provider: error.provider,
      ...extra,
    });
    return true;
  }
  if (error instanceof ProjectChatUninitializedError) {
    res.status(409).json({ error: error.message, code: error.code, ...extra });
    return true;
  }
  if (error instanceof ProjectChatBindingReadError) {
    res.status(409).json({
      error: 'The existing Project provider session could not be verified. Start a new provider session before sending another turn.',
      code: error.code,
      ...extra,
    });
    return true;
  }
  if (error instanceof CodexProjectModelSelectionError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      provider: 'CODEX',
      ...extra,
    });
    return true;
  }
  if (error instanceof ClaudeCodeProjectModelSelectionError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      provider: 'CLAUDE_CODE',
      ...extra,
    });
    return true;
  }
  if (error instanceof AntigravityProjectModelSelectionError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      provider: 'GEMINI',
      ...extra,
    });
    return true;
  }
  if (error instanceof AgentZeroProjectModelSelectionError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      provider: 'AGENT_ZERO',
      ...extra,
    });
    return true;
  }
  if (error instanceof OllamaProjectModelSelectionError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      provider: 'OLLAMA',
      ...extra,
    });
    return true;
  }
  if (error instanceof OpenClawProjectModelVerificationError) {
    const rejected = error.code === 'MODEL_INVALID'
      || error.code === 'MODEL_UNAVAILABLE'
      || error.code === 'MODEL_PATCH_REJECTED'
      || (error.code === 'MODEL_READBACK_MISMATCH' && error.rollbackStatus === 'CONFIRMED');
    console.error(`[OpenClaw Project Model] ${error.code}:`, error.causeDetail || error.message);
    res.status(rejected ? 409 : 503).json({
      error: error.message,
      code: rejected ? 'PROJECT_MODEL_SWITCH_REJECTED' : 'PROJECT_MODEL_VERIFICATION_FAILED',
      provider: 'OPENCLAW',
      previousModelRestored: error.rollbackStatus === 'CONFIRMED',
      ...extra,
    });
    return true;
  }
  if (!(error instanceof UnsupportedProjectChatProviderError)) return false;
  res.status(409).json({
    error: error.message,
    code: 'PROJECT_PROVIDER_UNSUPPORTED',
    provider: error.provider,
    ...extra,
  });
  return true;
}

function sendProjectChatQualificationError(
  res: Response,
  error: unknown,
  provider: QualifiableProjectProvider | null = null,
  extra: Record<string, unknown> = {},
  includeOperatorDiagnostic = false,
): boolean {
  const presented = presentProjectQualificationError(error, provider, {
    includeOperatorDiagnostic,
  });
  if (!presented) return false;
  res.status(presented.status).json({ ...presented.body, provider, ...extra });
  return true;
}

function toPersistedProjectChatProvider(provider: AgentProviderName): ProjectChatPersistedProvider {
  return provider === 'GROK' ? 'GROK_BUILD' : provider;
}

function fromPersistedProjectChatProvider(provider: ProjectChatPersistedProvider): AgentProviderName {
  return provider === 'GROK_BUILD' ? 'GROK' : provider;
}

function projectChatClientModel(
  provider: AgentProviderName,
  bindingModel: string | null | undefined,
  nativeModel?: string | null,
): string | null {
  const persisted = String(bindingModel || '').trim();
  if (provider === 'OLLAMA') {
    if (persisted) return parseOllamaProjectModelBinding(persisted).model;
    const runtimeModel = String(nativeModel || '').trim();
    return runtimeModel || null;
  }
  return persisted || String(nativeModel || '').trim() || null;
}

function sendProjectChatCoordinationError(
  res: Response,
  error: unknown,
  extra: Record<string, unknown> = {},
): boolean {
  if (!(error instanceof ProjectChatLeaseError)) return false;
  res.status(error.httpStatus).json({
    error: error.message,
    code: `PROJECT_CHAT_${error.code}`,
    ...extra,
  });
  return true;
}

async function requireSelectedProjectChatState(input: {
  actorUserId: string;
  projectIdentityId: string;
  provider: AgentProviderName;
  expectedVersion: unknown;
}) {
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new ProjectChatLeaseError(
      'INVALID_INPUT',
      'A current Project Chat state version is required',
      400,
    );
  }
  await ensureProjectChatState({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
    initialProvider: toPersistedProjectChatProvider(input.provider),
  });
  const coordination = await readProjectChatCoordinationState({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
  });
  if (!coordination.state) {
    throw new ProjectChatLeaseError('STATE_NOT_FOUND', 'Project Chat state was not found', 404);
  }
  if (coordination.state.version !== expectedVersion) {
    throw new ProjectChatLeaseError(
      'VERSION_CONFLICT',
      'Project Chat state changed; refresh before continuing',
    );
  }
  if (coordination.state.selectedProvider !== toPersistedProjectChatProvider(input.provider)) {
    throw new ProjectChatLeaseError(
      'PROVIDER_MISMATCH',
      'The requested provider is not the server-selected Project Chat provider',
    );
  }
  return coordination;
}

async function findProjectChatRequestReplay(input: {
  actorUserId: string;
  projectIdentityId: string;
  provider: AgentProviderName;
  messageId: string | null;
  message: string;
}) {
  if (!input.messageId) return null;
  const persistedMessage = await prisma.projectChatMessage.findFirst({
    where: {
      userId: input.actorUserId,
      projectId: input.projectIdentityId,
      messageId: input.messageId,
    },
    select: { id: true, role: true, content: true, provider: true },
  });
  if (!persistedMessage) return null;
  if (
    persistedMessage.role !== 'user'
    || persistedMessage.content !== input.message
    || persistedMessage.provider !== input.provider
  ) {
    throw new ProjectChatLeaseError(
      'REQUEST_REPLAY',
      'Project Chat message identity was already used for different content',
    );
  }
  const turn = await prisma.projectChatTurn.findUnique({
    where: {
      actorUserId_projectIdentityId_requestId: {
        actorUserId: input.actorUserId,
        projectIdentityId: input.projectIdentityId,
        requestId: persistedMessage.id,
      },
    },
  });
  if (!turn) return null;
  if (turn.provider !== toPersistedProjectChatProvider(input.provider)) {
    throw new ProjectChatLeaseError('PROVIDER_MISMATCH', 'Durable Project Chat replay belongs to another provider');
  }
  const coordination = await readProjectChatCoordinationState({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
  });
  if (!coordination.state || coordination.state.selectedProvider !== turn.provider) {
    throw new ProjectChatLeaseError('STATE_CORRUPT', 'Durable Project Chat replay is detached from provider state', 500);
  }
  return { turn, state: coordination.state };
}

function startProjectChatLeaseHeartbeat(input: {
  actorUserId: string;
  projectIdentityId: string;
  turnId: string;
  leaseToken: string;
  providerSessionId?: () => string | null;
  onLeaseLost: (error: unknown) => Promise<void> | void;
}) {
  let stopped = false;
  let renewing = false;
  let lossReported = false;
  const timer = setInterval(() => {
    if (stopped || renewing || lossReported) return;
    renewing = true;
    void renewProjectChatTurnLease({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      leaseDurationMs: PROJECT_CHAT_LEASE_DURATION_MS,
      providerSessionId: input.providerSessionId?.() || null,
    }).catch((error) => {
      lossReported = true;
      clearInterval(timer);
      void Promise.resolve(input.onLeaseLost(error)).catch((callbackError) => {
        console.error('[Project Chat] Lease-loss callback failed:', callbackError);
      });
    }).finally(() => {
      renewing = false;
    });
  }, PROJECT_CHAT_LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function resolveExistingProjectEntry(projectDir: string, requestedPath: unknown, kind: 'file' | 'directory' | 'any' = 'any') {
  return resolveContainedPath(projectDir, requestedPath, { mustExist: true, kind });
}

function resolveProjectTarget(projectDir: string, requestedPath: unknown) {
  return resolveContainedPath(projectDir, requestedPath, { mustExist: false });
}

function readProjectGitHead(projectDir: string): string {
  try {
    const dotGit = path.join(projectDir, '.git');
    const headPath = path.join(dotGit, 'HEAD');
    const gitEntry = fs.lstatSync(dotGit);
    if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) return '';
    const headEntry = fs.lstatSync(headPath);
    if (headEntry.isSymbolicLink() || !headEntry.isFile() || headEntry.size > 4096) return '';
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (/^ref: refs\/heads\/[a-zA-Z0-9_./-]+$/.test(head)) return head.slice('ref: refs/heads/'.length);
    if (/^[a-f0-9]{40,64}$/i.test(head)) return head.slice(0, 12);
  } catch {}
  return '';
}

async function getScopedOwnerId(req: Request): Promise<string> {
  return getWorkspaceOwnerId(req.user!);
}

async function getAssistantName(): Promise<string> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'appearance.assistantName' } });
    return row?.value?.trim() || 'Assistant';
  } catch {
    return 'Assistant';
  }
}
// Template definitions
const TEMPLATES: Record<string, { files: Record<string, string> }> = {
  'static-html': {
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My App</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <h1>Hello <span>World</span></h1>
    <p>Edit this page to get started</p>
  </div>
  <script src="script.js"></script>
</body>
</html>`,
      'style.css': `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: #0a0e27; color: #f0f4f8; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.container { text-align: center; }
h1 { font-size: 3rem; margin-bottom: 1rem; }
h1 span { color: #10b981; }
p { color: #94a3b8; }`,
      'script.js': `console.log('Hello from BridgesLLM!');`,
      'README.md': '# My App\n\nA static HTML app created on BridgesLLM Portal.\n',
    },
  },
  'react': {
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React App</title>
</head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" src="app.jsx"></script>
</body>
</html>`,
      'app.jsx': `function App() {
  const [count, setCount] = React.useState(0);
  return (
    <div style={{ fontFamily: 'system-ui', background: '#0a0e27', color: '#f0f4f8', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <h1>React App</h1>
        <p>Count: {count}</p>
        <button onClick={() => setCount(c => c + 1)} style={{ padding: '8px 24px', background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '16px' }}>
          Click me
        </button>
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<App />);`,
      'style.css': '',
      'README.md': '# React App\n\nA React app using CDN imports.\n',
    },
  },
  'node-api': {
    files: {
      'index.js': `const http = require('http');
const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from Node.js API!', timestamp: new Date().toISOString() }));
});
server.listen(port, host, () => console.log(\`Server running at http://\${host}:\${port}\`));`,
      'package.json': JSON.stringify({ name: 'node-api', version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2),
      'README.md': '# Node.js API\n\nRun with `npm start`\n',
    },
  },
  'python': {
    files: {
      'main.py': `print("Hello from BridgesLLM!")

name = input("What is your name? ")
print(f"Nice to meet you, {name}!")
`,
      'requirements.txt': `# Add your Python dependencies here
# e.g., requests
# e.g., flask
`,
      'README.md': '# Python Project\n\nRun with `python main.py`\n',
    },
  },
  'cpp': {
    files: {
      'main.cpp': `#include <iostream>

int main() {
    std::cout << "Hello from BridgesLLM!" << std::endl;
    return 0;
}
`,
      'Makefile': `CXX = g++
CFLAGS = -Wall -std=c++17

all: main

main: main.cpp
\t$(CXX) $(CFLAGS) -o main main.cpp

clean:
\trm -f main
`,
      'README.md': '# C++ Project\n\nBuild with `make` and run `./main`\n',
    },
  },
};

// GET /api/projects - list projects
router.get('/', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const userDir = getUserProjectDir(ownerId);
    const entries = fs.readdirSync(userDir, { withFileTypes: true });
    let lifecycleResidueSeen = false;
    const blockedProject = (
      projectName: string,
      projectDir: string,
      identity: ProjectIdentityRecord,
      availability: Readonly<{
        code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED'
          | 'PROJECT_LIFECYCLE_RECONCILIATION_REQUIRED'
          | 'PROJECT_LIFECYCLE_RECOVERY_PENDING'
          | 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED';
        message: string;
        action: 'RECONCILE_PROJECT_IDENTITY' | 'RECONCILE_PROJECT_LIFECYCLE' | 'RETRY';
        retryable: boolean;
      }>,
    ) => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(projectDir);
      } catch (error: any) {
        // The directory snapshot can race a rename/delete that completed
        // after readdir. A vanished entry is no longer inventory; it must not
        // turn every otherwise healthy Project into a list-level 500.
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      return {
        name: projectName,
        hasGit: fs.existsSync(path.join(projectDir, '.git')),
        currentBranch: '',
        deployedUrl: '',
        deployment: null,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        identity: serializeProjectIdentityProof(identity),
        availability: {
          available: false,
          ...availability,
        },
        destructiveActions: {
          allowed: false,
          reason: availability.message,
        },
      };
    };
    const projects = await Promise.all(entries
      // Dot-prefixed entries are the Portal's internal lifecycle namespace
      // (quarantine staging), never projects; listing one here once adopted
      // it as a permanent ghost project.
      .filter(e => e.isDirectory() && !isInternalProjectDirectoryName(e.name))
      .map(async e => {
        const pDir = path.join(userDir, e.name);
        const storedIdentity = await prisma.projectIdentity.findUnique({
          where: {
            workspaceOwnerId_projectName: {
              workspaceOwnerId: ownerId,
              projectName: e.name,
            },
          },
        });
        // A no-replace move can make the final directory visible for the few
        // milliseconds before its CREATING->ACTIVE CAS. Never fail the whole
        // project list or expose that partially published lifecycle row.
        if (storedIdentity && storedIdentity.lifecycleStatus === 'CREATING') return null;
        if (storedIdentity && storedIdentity.lifecycleStatus !== 'ACTIVE') {
          // A wedged rename/delete must not make the project vanish from the
          // list. Surface it with its controls disabled and one honest
          // sentence; recovery runs detached from this request.
          lifecycleResidueSeen = true;
          const message = projectLifecycleBlockedMessage(storedIdentity);
          return blockedProject(e.name, pDir, storedIdentity, {
            code: storedIdentity.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
              ? 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED'
              : 'PROJECT_LIFECYCLE_RECOVERY_PENDING',
            message,
            action: storedIdentity.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
              ? 'RECONCILE_PROJECT_LIFECYCLE'
              : 'RETRY',
            retryable: storedIdentity.lifecycleStatus !== 'DEPENDENCY_QUARANTINED',
          });
        }
        try {
          const stat = fs.statSync(pDir);
          const detectedDeployType = detectDeployType(pDir);
          const identity = await ensureProjectIdentity({
            workspaceOwnerId: ownerId,
            projectName: e.name,
            projectRoot: pDir,
          });
          const hasGit = fs.existsSync(path.join(pDir, '.git'));
          let currentBranch = '';
          let deployedUrl = '';

          if (hasGit) {
            currentBranch = readProjectGitHead(pDir);
          }

          // Resolve deployment through the immutable Project association. A
          // leftover directory without a matching App row is residue, not a
          // supported deployment.
          const deployId = `${ownerId}-${e.name}`;
          const deployPath = path.join(DEPLOY_DIR, deployId);
          const app = await findProjectAppForIdentity({
            workspaceOwnerId: ownerId,
            projectIdentityId: identity.id,
            projectName: e.name,
            deployPath,
          });
          if (app?.isActive && app.deployType !== 'runtime' && fs.existsSync(deployPath)) {
            deployedUrl = `/hosted/${deployId}/`;
          }
          const identityDestructiveActions = projectDestructiveActionCapability(identity);
          const authoritativeRuntimeManagement = app ? projectRuntimeManagement(app) : null;
          const invalidRuntimeBinding = authoritativeRuntimeManagement === 'invalid-external-binding';
          const runtimeManagement = invalidRuntimeBinding
            ? 'external-loopback' as const
            : authoritativeRuntimeManagement;
          const destructiveActions = (
            authoritativeRuntimeManagement === 'external-loopback'
            || invalidRuntimeBinding
          )
            ? {
              allowed: false,
              reason: identityDestructiveActions.allowed
                ? invalidRuntimeBinding
                  ? PROJECT_INVALID_RUNTIME_BINDING_LIMITATION
                  : PROJECT_EXTERNAL_RUNTIME_LIMITATION
                : `${identityDestructiveActions.reason} ${invalidRuntimeBinding
                  ? PROJECT_INVALID_RUNTIME_BINDING_LIMITATION
                  : PROJECT_EXTERNAL_RUNTIME_LIMITATION}`,
              code: invalidRuntimeBinding
                ? PROJECT_INVALID_RUNTIME_BINDING_ERROR_CODE
                : PROJECT_EXTERNAL_RUNTIME_ERROR_CODE,
            }
            : identityDestructiveActions;

          return {
            name: e.name,
            hasGit,
            currentBranch,
            detectedDeployType,
            deployedUrl,
            deployment: app ? {
              appId: app.id,
              deployType: app.deployType,
              processStatus: app.processStatus,
              port: app.port,
              isActive: app.isActive,
              runtimeManagement,
              statusSource: projectRuntimeStatusSource(app),
              ...(invalidRuntimeBinding ? {
                bindingStatus: 'invalid',
                configurationCode: PROJECT_INVALID_RUNTIME_BINDING_ERROR_CODE,
                limitation: PROJECT_INVALID_RUNTIME_BINDING_LIMITATION,
              } : {}),
              supportedLifecycleActions: projectSupportedLifecycleActions(
                app,
                detectedDeployType,
                identityDestructiveActions.allowed,
              ),
            } : null,
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            identity: serializeProjectIdentityProof(identity),
            destructiveActions,
          };
        } catch (error: any) {
          if (error?.code === 'ENOENT') {
            console.warn('[Projects] Project inventory entry disappeared during listing', {
              projectName: e.name,
            });
            return null;
          }
          if (
            !(error instanceof ProjectIdentityMismatchError)
            && !(error instanceof ProjectIdentityLifecycleError)
          ) {
            throw error;
          }

          const blockedIdentity = storedIdentity || await prisma.projectIdentity.findFirst({
            where: {
              workspaceOwnerId: ownerId,
              lifecycleStatus: 'RENAMING',
              renameTargetName: e.name,
            },
          });
          // Never invent an immutable identity merely to keep the list shape
          // valid. An unbound directory is an unexpected server failure and
          // remains fail-closed until it can be authoritatively identified.
          if (!blockedIdentity) throw error;

          const identityMismatch = error instanceof ProjectIdentityMismatchError;
          const renameRecoveryPending = !storedIdentity
            && blockedIdentity.lifecycleStatus === 'RENAMING';
          const code = identityMismatch
            ? 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED' as const
            : renameRecoveryPending
              ? 'PROJECT_LIFECYCLE_RECOVERY_PENDING' as const
              : 'PROJECT_LIFECYCLE_RECONCILIATION_REQUIRED' as const;
          console.warn('[Projects] Project inventory entry is unavailable', {
            projectName: e.name,
            code,
          });
          if (renameRecoveryPending) lifecycleResidueSeen = true;
          return blockedProject(e.name, pDir, blockedIdentity, identityMismatch ? {
            code,
            message: 'This project directory changed outside Portal. Its files are preserved, but Project actions are disabled until its identity is reconciled.',
            action: 'RECONCILE_PROJECT_IDENTITY',
            retryable: false,
          } : renameRecoveryPending ? {
            code,
            message: 'This project has an interrupted lifecycle operation. Its files are preserved while Portal restores the operation.',
            action: 'RETRY',
            retryable: true,
          } : {
            code,
            message: 'Portal found conflicting lifecycle records for this project. Its files are preserved, but Project actions are disabled until the records are reconciled.',
            action: 'RECONCILE_PROJECT_LIFECYCLE',
            retryable: false,
          });
        }
      }));
    if (lifecycleResidueSeen) {
      scheduleProjectLifecycleResidueRecovery({
        actorUserId: req.user!.userId,
        workspaceOwnerId: ownerId,
      });
    }
    res.json({ projects: projects.filter((project) => project !== null) });
  } catch (error) {
    console.error('List projects error:', error);
    res.status(500).json({
      error: 'Failed to list projects',
      code: 'PROJECT_LIST_FAILED',
      retryable: true,
    });
  }
});

const projectSearchLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Too many Project searches. Refine the query and try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/projects/search - bounded project and nested-file search
router.get('/search', authenticateToken, requireApproved, projectSearchLimiter, async (req: Request, res: Response) => {
  const abortController = new AbortController();
  const abortIfDisconnected = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.once('close', abortIfDisconnected);
  try {
    const query = String(req.query.q || '').trim();
    if (!query) {
      res.status(400).json({ error: 'q required' });
      return;
    }
    if (query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) {
      res.status(400).json({ error: 'Project search query is invalid or too long' });
      return;
    }

    const requestedLimit = Number(req.query.limit || 24);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
      res.status(400).json({ error: 'Project search limit is invalid' });
      return;
    }

    // Match the Files and Projects workspace contract: ordinary users and
    // sandboxed operators stay in their own actor workspace; an explicitly
    // shared elevated workspace resolves through getWorkspaceOwnerId.
    const ownerId = await getScopedOwnerId(req);
    const userDir = getUserProjectDir(ownerId);
    const response = await runProjectWorkspaceSearch(userDir, {
      query,
      limit: Math.min(requestedLimit, 50),
      signal: abortController.signal,
    });
    res.json(response);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' && abortController.signal.aborted) return;
    if (error instanceof ProjectSearchCapacityError) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Project search is busy. Try again shortly.' });
      return;
    }
    console.error('Project search error:', error);
    res.status(500).json({ error: 'Failed to search projects' });
  } finally {
    res.off('close', abortIfDisconnected);
  }
});

// POST /api/projects - create from template
router.post('/', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let createdProjectDir: string | undefined;
  let createdProjectRootIdentity: AttestedProjectRoot | undefined;
  let createdProjectIdentityId: string | undefined;
  let creationSuccessResponse:
    | { name: string; template: string; identity: ProjectIdentityProof }
    | undefined;
  let releaseProjectNameLock: (() => void) | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name, template = 'static-html' } = req.body;
    if (typeof name !== 'string' || !name.trim()) { res.status(400).json({ error: 'name required' }); return; }
    if (typeof template !== 'string' || !Object.prototype.hasOwnProperty.call(TEMPLATES, template)) {
      res.status(400).json({ error: 'Unknown project template' });
      return;
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'project';
    const projectDir = getProjectPath(ownerId, safeName);

    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, safeName),
    );
    await assertProjectIdentityNameAvailable({ workspaceOwnerId: ownerId, projectName: safeName });

    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    const stagingDir = createProjectCreationStagingDirectory();
    createdProjectDir = stagingDir;
    createdProjectRootIdentity = attestProjectRoot(stagingDir);
    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    const projectIdentity = await createCurrentProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    createdProjectIdentityId = projectIdentity.id;
    const gitScope = { actorId: req.user!.userId, projectId: projectIdentity.id };

    const tmpl = TEMPLATES[template];
    for (const [fname, content] of Object.entries(tmpl.files)) {
      writeProjectRuntimeOwnedFileAtomic(stagingDir, fname, content);
    }

    // Init git
    try {
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['init'], timeoutMs: 10_000 });
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['add', '-A'], timeoutMs: 10_000 });
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['commit', '-m', 'Initial commit'], timeoutMs: 10_000 });
    } catch {}

    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    moveAttestedDirectoryNoReplace({
      sourceRoot: stagingDir,
      targetRoot: projectDir,
      expectedIdentity: projectIdentity,
    });
    createdProjectDir = projectDir;
    creationSuccessResponse = {
      name: safeName,
      template,
      identity: serializeProjectIdentityProof(projectIdentity),
    };
    await finalizeCurrentProjectIdentityCreation({
      projectIdentityId: projectIdentity.id,
      projectRoot: projectDir,
    });

    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_CREATE',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: { projectName: safeName, template },
      },
    }).catch((error) => {
      console.warn('[Project Create] Failed to record activity:', error);
    });

    res.status(201).json(creationSuccessResponse);
    createdProjectDir = undefined;
    createdProjectRootIdentity = undefined;
    createdProjectIdentityId = undefined;
  } catch (error) {
    const reconciliation = await reconcileFailedCurrentProjectCreation({
      projectIdentityId: createdProjectIdentityId,
      directory: createdProjectDir,
      expectedDirectoryIdentity: createdProjectRootIdentity,
    }, '[Project Create] Staging cleanup failed:');
    if (reconciliation === 'published') {
      console.warn('[Project Create] Publication committed before a later operation failed:', error);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.status(201).json(creationSuccessResponse!);
      }
      return;
    }
    console.error('Create project error:', error);
    if (error instanceof LegacyOpenClawProjectCreationCollisionError) {
      res.status(409).json({ error: error.message, code: error.code, retryable: false });
      return;
    }
    if (error instanceof LegacyOpenClawProjectCreationScanCapacityError) {
      res.status(503).json({ error: error.message, code: error.code, retryable: true });
      return;
    }
    if (error instanceof ProjectIdentityLifecycleError || (error as any)?.code === 'P2002') {
      res.status(409).json({ error: 'Project name is already owned or reserved' });
      return;
    }
    res.status(500).json({ error: 'Failed to create project', detail: (error as any)?.message });
  } finally {
    releaseProjectNameLock?.();
  }
});

// POST /api/projects/clone - clone git repo
router.post('/clone', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const abortController = new AbortController();
  let createdProjectDir: string | undefined;
  let createdProjectRootIdentity: AttestedProjectRoot | undefined;
  let createdProjectIdentityId: string | undefined;
  let creationSuccessResponse:
    | { name: string; clonedFrom: string; identity: ProjectIdentityProof }
    | undefined;
  let releaseProjectNameLock: (() => void) | null = null;
  const abort = () => abortController.abort();
  req.once('aborted', abort);
  const close = () => { if (!res.writableEnded) abort(); };
  res.once('close', close);
  try {
    const ownerId = await getScopedOwnerId(req);
    const { url, name } = req.body;
    if (typeof url !== 'string' || !url.trim()) { res.status(400).json({ error: 'url required' }); return; }

    const safeName = String(name || url.split('/').pop()?.replace('.git', '') || 'repo')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120) || 'repo';
    const projectDir = getProjectPath(ownerId, safeName);

    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, safeName),
    );
    await assertProjectIdentityNameAvailable({ workspaceOwnerId: ownerId, projectName: safeName });

    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    let safeUrl = '';
    try {
      safeUrl = assertSafeProjectGitUrl(url);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
      return;
    }

    const stagingDir = createProjectCreationStagingDirectory();
    createdProjectDir = stagingDir;
    createdProjectRootIdentity = attestProjectRoot(stagingDir);
    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    const projectIdentity = await createCurrentProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    createdProjectIdentityId = projectIdentity.id;
    await runProjectGitCommand({
      actorId: req.user!.userId,
      projectId: projectIdentity.id,
      workspace: stagingDir,
      args: ['clone', '--depth', '1', safeUrl, '.'],
      timeoutMs: 120_000,
      network: true,
      signal: abortController.signal,
    });

    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    moveAttestedDirectoryNoReplace({
      sourceRoot: stagingDir,
      targetRoot: projectDir,
      expectedIdentity: projectIdentity,
    });
    createdProjectDir = projectDir;
    creationSuccessResponse = {
      name: safeName,
      clonedFrom: safeUrl,
      identity: serializeProjectIdentityProof(projectIdentity),
    };
    await finalizeCurrentProjectIdentityCreation({
      projectIdentityId: projectIdentity.id,
      projectRoot: projectDir,
    });

    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_CLONE',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: { projectName: safeName, clonedFrom: safeUrl },
      },
    }).catch((error) => {
      console.warn('[Project Clone] Failed to record activity:', error);
    });

    res.status(201).json(creationSuccessResponse);
    createdProjectDir = undefined;
    createdProjectRootIdentity = undefined;
    createdProjectIdentityId = undefined;
  } catch (error: any) {
    const reconciliation = await reconcileFailedCurrentProjectCreation({
      projectIdentityId: createdProjectIdentityId,
      directory: createdProjectDir,
      expectedDirectoryIdentity: createdProjectRootIdentity,
    }, '[Project Clone] Staging cleanup failed:');
    if (reconciliation === 'published') {
      console.warn('[Project Clone] Publication committed before a later operation failed:', error);
      if (
        !res.headersSent
        && !res.writableEnded
        && !res.destroyed
        && !abortController.signal.aborted
      ) {
        res.status(201).json(creationSuccessResponse!);
      }
      return;
    }
    console.error('Clone error:', error);
    if (!res.headersSent && !abortController.signal.aborted) {
      if (error instanceof LegacyOpenClawProjectCreationCollisionError) {
        res.status(409).json({ error: error.message, code: error.code, retryable: false });
      } else if (error instanceof LegacyOpenClawProjectCreationScanCapacityError) {
        res.status(503).json({ error: error.message, code: error.code, retryable: true });
      } else if (error instanceof ProjectIdentityLifecycleError || error?.code === 'P2002') {
        res.status(409).json({ error: 'Project name is already owned or reserved' });
      } else {
        res.status(500).json({ error: 'Failed to clone repository', detail: error.message });
      }
    }
  } finally {
    releaseProjectNameLock?.();
    req.off('aborted', abort);
    res.off('close', close);
  }
});

// GET /api/projects/models/available - List available models from gateway catalog
// NOTE: This MUST be defined BEFORE /:name routes to avoid matching "models" as a project name
router.get('/models/available', authenticateToken, requireApproved, async (_req: Request, res: Response) => {
  try {
    const result = await listGatewayModels();
    const providerStatus = new Map((await getProviderStatusesAsync()).map((p) => [p.id, p]));
    const defaultModel = getDefaultModel();

    if (result.ok && result.models) {
      const models = result.models.flatMap((m: any) => {
        if (m?.available === false || m?.missing === true) return [];
        const rawModel = String(m?.key || m?.id || m?.model || '').trim();
        const provider = String(m?.provider || '').trim();
        const id = rawModel.includes('/')
          ? normalizePortalModelId(rawModel)
          : canonicalizeProviderModelId(provider, rawModel);
        if (!id) return [];
        return [{
          id,
          name: m.name || rawModel,
          provider: provider || id.split('/')[0] || '',
          reasoning: m.reasoning || false,
          contextWindow: m.contextWindow,
          cost: m.cost,
        }];
      });

      models.sort((a, b) => {
        const aStatus = a.provider ? providerStatus.get(a.provider) : undefined;
        const bStatus = b.provider ? providerStatus.get(b.provider) : undefined;
        const aHealthy = aStatus ? (aStatus.status === 'configured' || aStatus.status === 'cooldown') : false;
        const bHealthy = bStatus ? (bStatus.status === 'configured' || bStatus.status === 'cooldown') : false;
        if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;
        const aIsDefault = a.id === defaultModel;
        const bIsDefault = b.id === defaultModel;
        if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
        return 0;
      });

      res.json({ models, verified: true });
    } else {
      res.status(503).json({
        error: 'The live OpenClaw model catalog is unavailable.',
        code: 'PROJECT_MODEL_CATALOG_UNAVAILABLE',
        models: [],
        verified: false,
      });
    }
  } catch (error) {
    console.error('[Project Models] Live catalog failed:', error);
    res.status(503).json({
      error: 'The live OpenClaw model catalog is unavailable.',
      code: 'PROJECT_MODEL_CATALOG_UNAVAILABLE',
      models: [],
      verified: false,
    });
  }
});

// GET /api/projects/:name/tree - file tree with git status
router.get('/:name/tree', authenticateToken, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });
    const subPath = (req.query.path as string) || '';
    let resolved: string;
    try {
      resolved = subPath
        ? resolveExistingProjectEntry(projectDir, subPath, 'directory')
        : fs.realpathSync(projectDir);
    } catch {
      res.status(404).json({ error: 'Path not found' });
      return;
    }

    // Get git status for all files
    const gitStatusMap: Record<string, string> = {};
    const hasGit = fs.existsSync(path.join(projectDir, '.git'));
    if (hasGit) {
      try {
        const statusOutput = await runProjectGitCommand({
          actorId: req.user!.userId,
          projectId: projectIdentity.id,
          workspace: projectDir,
          args: ['status', '--porcelain=v1', '-z', '-uall'],
          timeoutMs: 5000,
        });
        for (const entry of parseProjectGitPorcelain(statusOutput)) {
          const status = entry.status.trim();
          const filePath = entry.path;
          if (isTransientProjectStatePath(filePath)) continue;
          // Map git status codes
          let statusLabel = 'modified';
          if (status === '??') statusLabel = 'untracked';
          else if (status === 'M' || status === 'MM') statusLabel = 'modified';
          else if (status === 'D') statusLabel = 'deleted';
          else if (status === 'R') statusLabel = 'renamed';
          else if (status === 'A') statusLabel = 'added';
          gitStatusMap[filePath] = statusLabel;
        }
      } catch {}
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const tree = entries
      .filter(e => !e.isSymbolicLink())
      .filter(e => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.agent-memory.md')
      .map(e => {
        const entryPath = subPath ? `${subPath}/${e.name}` : e.name;
        let gitStatus: string | undefined = undefined;

        if (e.isFile()) {
          gitStatus = gitStatusMap[entryPath];
        } else if (e.isDirectory()) {
          // Check if any file in this directory has changes
          const hasChanges = Object.keys(gitStatusMap).some(fp => fp.startsWith(entryPath + '/'));
          if (hasChanges) gitStatus = 'modified';
        }

        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          path: entryPath,
          size: e.isFile() ? fs.lstatSync(path.join(resolved, e.name)).size : undefined,
          gitStatus,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({
      tree,
      currentPath: subPath,
      identity: serializeProjectIdentityProof(projectIdentity),
    });
  } catch (error) {
    console.error('Tree error:', error);
    res.status(500).json({ error: 'Failed to get file tree' });
  }
});

// GET /api/projects/:name/raw - serve raw file with correct MIME type (for media preview)
// Cookies are sent automatically by browsers so <img>/<audio>/<video> elements work fine
router.get('/:name/raw', browserAuthRedirect, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  let rawFd: number | undefined;
  const closeRawFile = () => {
    if (rawFd === undefined) return;
    try { fs.closeSync(rawFd); } catch {}
    rawFd = undefined;
  };
  try {
    const ownerId = await getScopedOwnerId(req);
    const userId = ownerId;
    const projectDir = getProjectPath(userId, req.params.name);
    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    let resolved: string;
    try {
      resolved = resolveExistingProjectEntry(projectDir, filePath, 'file');
    } catch {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const expectedStat = fs.lstatSync(resolved);
    try {
      rawFd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const stat = fs.fstatSync(rawFd);
    if (!stat.isFile() || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) {
      closeRawFile();
      res.status(404).json({ error: 'File changed while it was being opened' });
      return;
    }
    if (stat.size > PROJECT_RAW_MAX_BYTES) {
      closeRawFile();
      res.status(413).json({ error: 'File too large (max 100MB)' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      // Images
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
      '.avif': 'image/avif',
      // Audio
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.flac': 'audio/flac', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
      // Video
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
      // Web
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.xml': 'text/xml',
      // Documents
      '.pdf': 'application/pdf',
      // Fonts
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    };

    const mode = String(req.query.mode || '').toLowerCase();
    const forceText = mode === 'text';
    if (forceText && !isTextPreviewableFile(filePath)) {
      closeRawFile();
      res.status(400).json({ error: 'This file cannot be previewed as text' });
      return;
    }

    const activeContent = ['.html', '.htm', '.svg', '.xml'].includes(ext);
    const mime = forceText
      ? 'text/plain; charset=utf-8'
      : activeContent
        ? 'application/octet-stream'
        : (mimeMap[ext] || 'application/octet-stream');
    let range: ReturnType<typeof parseProjectByteRange> = null;
    try {
      range = parseProjectByteRange(req.headers.range, stat.size);
    } catch (error) {
      if (error instanceof ProjectRangeError) {
        closeRawFile();
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.status(416).end();
        return;
      }
      throw error;
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : stat.size);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    if (activeContent && !forceText) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath).replace(/[\r\n"\\]/g, '_')}"`);
    }

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    }
    const stream = fs.createReadStream(resolved, {
      ...(range || {}),
      fd: rawFd,
      autoClose: true,
    });
    rawFd = undefined; // The stream owns the descriptor from this point onward.
    stream.once('error', (streamError) => {
      console.error('Raw file stream error:', streamError);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
      else res.destroy(streamError);
    });
    stream.pipe(res);
  } catch (error) {
    closeRawFile();
    console.error('Raw file error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
    else res.destroy(error instanceof Error ? error : undefined);
  }
});

// GET /api/projects/:name/file - read file content
router.get('/:name/file', authenticateToken, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    let content: string;
    try {
      content = readProjectTextFile(projectDir, filePath, { maxBytes: PROJECT_EDIT_MAX_BYTES }) || '';
    } catch (error: any) {
      if (error instanceof ProjectFilePolicyError && error.code === 'TOO_LARGE') {
        res.status(413).json({ error: 'File too large to edit (max 10MB)' });
      } else {
        res.status(404).json({ error: 'File not found' });
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
      '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown',
      '.py': 'python', '.sh': 'shell', '.yml': 'yaml', '.yaml': 'yaml',
      '.xml': 'xml', '.sql': 'sql', '.rs': 'rust', '.go': 'go',
      '.rb': 'ruby', '.php': 'php', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
      '.h': 'c', '.hpp': 'cpp', '.vue': 'html', '.svelte': 'html',
      '.toml': 'toml', '.ini': 'ini', '.env': 'shell', '.dockerfile': 'dockerfile',
    };

    res.json({ content, language: langMap[ext] || 'plaintext', path: filePath, size: Buffer.byteLength(content, 'utf8') });
  } catch (error) {
    console.error('Read file error:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// PUT /api/projects/:name/file - write file content
router.put('/:name/file', authenticateToken, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { path: filePath, content } = req.body;
    if (!filePath || typeof content !== 'string') { res.status(400).json({ error: 'path and string content required' }); return; }

    await withProjectDeletionLock({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
    }, async () => {
      const projectDir = getProjectPath(ownerId, req.params.name);
      if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
      writeProjectRuntimeOwnedFileAtomic(projectDir, filePath, content, { maxBytes: PROJECT_EDIT_MAX_BYTES });

      res.json({ message: 'File saved', path: filePath });
    });
  } catch (error) {
    console.error('Write file error:', error);
    sendProjectFileMutationError(res, error, 'Failed to write file');
  }
});

// POST /api/projects/:name/file - create new file
router.post('/:name/file', authenticateToken, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { path: filePath, content = '' } = req.body;
    if (!filePath || typeof content !== 'string') { res.status(400).json({ error: 'path and string content required' }); return; }

    await withProjectDeletionLock({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
    }, async () => {
      const projectDir = getProjectPath(ownerId, req.params.name);
      if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
      try {
        writeProjectRuntimeOwnedFileAtomic(projectDir, filePath, content, { exclusive: true, maxBytes: PROJECT_EDIT_MAX_BYTES });
      } catch (error: any) {
        if (/already exists/i.test(error?.message || '')) {
          res.status(409).json({ error: 'File already exists' });
          return;
        }
        throw error;
      }
      res.status(201).json({ message: 'File created', path: filePath });
    });
  } catch (error) {
    sendProjectFileMutationError(res, error, 'Failed to create file');
  }
});

// DELETE /api/projects/:name/file
router.delete('/:name/file', authenticateToken, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    await withProjectDeletionLock({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
    }, async () => {
      const projectDir = getProjectPath(ownerId, req.params.name);
      if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
      let resolved: string;
      try {
        resolved = resolveExistingProjectEntry(projectDir, filePath, 'any');
      } catch {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      res.json({ message: 'Deleted' });
    });
  } catch {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

function isSafeProjectGitRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && !value.startsWith('-')
    && !value.includes('..')
    && !value.includes('@{')
    && !value.endsWith('.')
    && !value.endsWith('/')
    && !value.includes('//')
    && /^[a-zA-Z0-9_./-]+$/.test(value);
}

function resolveSafeProjectGitFile(projectDir: string, file: unknown): string | null {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\0')) return null;
  const root = path.resolve(projectDir);
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

// POST /api/projects/:name/git - isolated Git operations
router.post('/:name/git', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const abortController = new AbortController();
  let releaseProjectFileMutationLock: ProjectDeletionLockLease | null = null;
  const abort = () => abortController.abort();
  req.once('aborted', abort);
  const close = () => { if (!res.writableEnded) abort(); };
  res.once('close', close);

  try {
    const ownerId = await getScopedOwnerId(req);
    // Every Git action shares one lifecycle admission boundary. Read-shaped
    // Git operations can still update indexes, refs, credential helpers, or
    // provider-owned worktree state and must not overlap rename/delete or
    // dependency promotion.
    releaseProjectFileMutationLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, req.params.name),
    );
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });
    const gitScope = { actorId: req.user!.userId, projectId: projectIdentity.id };

    const { action, message, branch, file } = req.body;
    const git = (args: string[], options?: { timeoutMs?: number; network?: boolean; maxOutputBytes?: number }) => runProjectGitCommand({
      ...gitScope,
      workspace: projectDir,
      args,
      timeoutMs: options?.timeoutMs || 30_000,
      network: options?.network,
      maxOutputBytes: options?.maxOutputBytes,
      signal: abortController.signal,
      nameHint: `${ownerId}:${req.params.name}:${action}`,
    });
    const commandError = (error: any, fallback: string) => (
      error?.stdout?.toString().trim()
      || error?.stderr?.toString().trim()
      || error?.message
      || fallback
    );
    let output = '';

    switch (action) {
      case 'status': {
        const raw = await git(['status', '--porcelain=v1', '-z', '-uall']);
        let currentBranch = 'main';
        try { currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* no commits yet */ }
        let ahead = 0;
        let behind = 0;
        try {
          const counts = (await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/);
          ahead = parseInt(counts[0], 10) || 0;
          behind = parseInt(counts[1], 10) || 0;
        } catch {}
        const files = parseProjectGitPorcelain(raw)
          .filter((entry) => !isTransientProjectStatePath(entry.path))
          .map((entry) => {
            const xy = entry.status;
            let status = 'modified';
            if (xy === '??') status = 'untracked';
            else if (xy.includes('A')) status = 'added';
            else if (xy.includes('D')) status = 'deleted';
            else if (xy.includes('R')) status = 'renamed';
            return { path: entry.path, status, raw: xy };
          });
        res.json({ branch: currentBranch, ahead, behind, files, clean: files.length === 0 });
        return;
      }

      case 'log': {
        const limit = Math.max(1, Math.min(Number.parseInt(String(req.body.limit || 50), 10) || 50, 100));
        const branchFilter = req.body.branch;
        if (branchFilter && !isSafeProjectGitRef(branchFilter)) { res.status(400).json({ error: 'Valid branch name required' }); return; }
        const raw = await git([
          'log',
          branchFilter || '--all',
          '--format={"hash":"%H","short":"%h","author":"%an","email":"%ae","date":"%aI","relativeDate":"%ar","message":"%s","refs":"%D","parent":"%P"}',
          `-${limit}`,
        ]);
        const commits = raw.split('\n').filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        res.json({ commits });
        return;
      }

      case 'log-enhanced': {
        const limit = Math.max(1, Math.min(Number.parseInt(String(req.body.limit || 30), 10) || 30, 100));
        const branchFilter = req.body.branch;
        if (branchFilter && !isSafeProjectGitRef(branchFilter)) { res.status(400).json({ error: 'Valid branch name required' }); return; }
        const raw = await git([
          'log', branchFilter || '--all',
          '--format=COMMIT_START%n%H|%h|%an|%ae|%aI|%ar|%s|%D|%P',
          '--stat', '--no-ext-diff', '--no-textconv', `-${limit}`,
        ], { maxOutputBytes: 5 * 1024 * 1024 });
        const blocks = raw.split('COMMIT_START\n').filter(Boolean);
        const enhancedCommits = blocks.map((block) => {
          const lines = block.trim().split('\n');
          const parts = lines[0].split('|');
          if (parts.length < 7) return null;
          const [hash, short, author, email, date, relativeDate, ...rest] = parts;
          const remaining = rest.join('|');
          const lastPipe = remaining.lastIndexOf('|');
          const secondLast = lastPipe > 0 ? remaining.lastIndexOf('|', lastPipe - 1) : -1;
          const commitMessage = secondLast > 0 ? remaining.slice(0, secondLast) : remaining;
          const refs = secondLast > 0 ? remaining.slice(secondLast + 1, lastPipe) : '';
          const parent = lastPipe > 0 ? remaining.slice(lastPipe + 1) : '';
          const files: Array<{ path: string; additions: number; deletions: number }> = [];
          let totalInsertions = 0;
          let totalDeletions = 0;
          for (const statLine of lines.slice(1)) {
            const fileMatch = statLine.match(/^\s+(.+?)\s+\|\s+(\d+)\s*([+-]*)\s*$/);
            if (fileMatch) {
              const plus = (fileMatch[3].match(/\+/g) || []).length;
              const minus = (fileMatch[3].match(/-/g) || []).length;
              const total = parseInt(fileMatch[2], 10);
              const changes = plus + minus;
              const additions = changes ? Math.round(total * plus / changes) : total;
              files.push({ path: fileMatch[1].trim(), additions, deletions: total - additions });
            }
            const binary = statLine.match(/^\s+(.+?)\s+\|\s+Bin/);
            if (binary) files.push({ path: binary[1].trim(), additions: 0, deletions: 0 });
            const insertions = statLine.match(/(\d+) insertion/);
            const deletions = statLine.match(/(\d+) deletion/);
            if (insertions) totalInsertions = parseInt(insertions[1], 10);
            if (deletions) totalDeletions = parseInt(deletions[1], 10);
          }
          return {
            hash, short, author, email, date, relativeDate,
            message: commitMessage.trim(), refs: refs.trim(), parentHash: parent.trim(),
            stats: {
              filesChanged: files.length,
              insertions: totalInsertions || files.reduce((sum, entry) => sum + entry.additions, 0),
              deletions: totalDeletions || files.reduce((sum, entry) => sum + entry.deletions, 0),
              files,
            },
          };
        }).filter(Boolean);
        res.json({ commits: enhancedCommits });
        return;
      }

      case 'revert': {
        const hash = req.body.hash;
        if (!hash || !/^[a-f0-9]{7,40}$/.test(hash)) { res.status(400).json({ error: 'Valid commit hash required' }); return; }
        try {
          const revertResult = await withTransientProjectStateShelved(projectDir, gitScope, async () => {
            await git(['cat-file', '-t', hash]);
            const commitMsg = (await git(['log', '-1', '--format=%s', hash])).trim();
            const revertOutput = (await git(['revert', hash, '--no-edit'])).trim();
            const newHash = (await git(['rev-parse', 'HEAD'])).trim();
            return { output: revertOutput, commitMsg, newHash };
          }, { timeout: 30_000, signal: abortController.signal });
          await prisma.activityLog.create({
            data: {
              userId: ownerId,
              action: 'PROJECT_GIT_REVERT',
              resource: 'project',
              resourceId: projectIdentity.id,
              severity: 'INFO',
              metadata: { projectName: req.params.name, revertedHash: hash, revertedMessage: revertResult.commitMsg, newHash: revertResult.newHash },
            },
          }).catch((activityError) => {
            console.warn('[Project Git] Failed to record revert activity:', activityError);
          });
          res.json({ output: revertResult.output, newHash: revertResult.newHash, revertedMessage: revertResult.commitMsg });
        } catch (error: any) {
          const details = commandError(error, 'Revert failed');
          if (details.toLowerCase().includes('conflict')) {
            try { await git(['revert', '--abort']); } catch {}
            res.status(409).json({ error: 'Revert failed due to conflicts. The revert has been aborted.', details });
          } else if (details.includes('Working tree has uncommitted changes:')) {
            res.status(409).json({ error: 'Revert blocked by uncommitted project changes.', details, hint: 'Commit, discard, or move the listed files before reverting. Portal session scratch files are ignored automatically now.' });
          } else {
            res.status(500).json({ error: 'Revert failed', details });
          }
        }
        return;
      }

      case 'diff': {
        if (file) {
          const resolvedFile = resolveSafeProjectGitFile(projectDir, file);
          if (!resolvedFile) { res.status(400).json({ error: 'Valid project file required' }); return; }
          output = await git(['diff', '--no-ext-diff', '--no-textconv', '--', file]);
          if (!output.trim()) output = await git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', file]);
          if (!output.trim()) {
            try {
              const entry = fs.lstatSync(resolvedFile);
              if (!entry.isSymbolicLink() && entry.isFile() && entry.size <= 1024 * 1024) {
                const content = fs.readFileSync(resolvedFile, 'utf8');
                output = `--- /dev/null\n+++ b/${file}\n${content.split('\n').map((line) => `+${line}`).join('\n')}`;
              }
            } catch {}
          }
        } else {
          output = await git(['diff', '--no-ext-diff', '--no-textconv']);
          const cached = await git(['diff', '--cached', '--no-ext-diff', '--no-textconv']);
          if (cached.trim()) output += `\n${cached}`;
        }
        break;
      }

      case 'diff-commit': {
        const hash = req.body.hash;
        if (!hash || !/^[a-f0-9]{7,40}$/.test(hash)) { res.status(400).json({ error: 'Valid commit hash required' }); return; }
        output = await git(['show', hash, '--format=', '--stat', '--no-ext-diff', '--no-textconv']);
        const fullDiff = await git(['show', hash, '--format=', '--no-ext-diff', '--no-textconv']);
        res.json({ output: output.trim(), diff: fullDiff.trim() });
        return;
      }

      case 'add':
        output = await git(projectGitAddAllArgs());
        break;

      case 'commit': {
        await git(projectGitAddAllArgs());
        const commitMessage = typeof message === 'string' && message.trim() ? message.trim().slice(0, 4096) : 'Update';
        output = await git(['commit', '-m', commitMessage]);
        const commitHash = (await git(['rev-parse', '--short', 'HEAD'])).trim();
        const commitBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        let linesAdded = 0;
        let linesRemoved = 0;
        let commitFilesChanged = 0;
        try {
          const statOutput = (await git(['diff', 'HEAD~1', '--shortstat', '--no-ext-diff', '--no-textconv'], { timeoutMs: 5000 })).trim();
          commitFilesChanged = parseInt(statOutput.match(/(\d+) file/)?.[1] || '0', 10);
          linesAdded = parseInt(statOutput.match(/(\d+) insertion/)?.[1] || '0', 10);
          linesRemoved = parseInt(statOutput.match(/(\d+) deletion/)?.[1] || '0', 10);
        } catch {}
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_COMMIT', resource: 'project', resourceId: projectIdentity.id, severity: 'INFO', metadata: { projectName: req.params.name, message: commitMessage, hash: commitHash, branch: commitBranch, filesChanged: commitFilesChanged, linesAdded, linesRemoved } },
        }).catch((activityError) => {
          console.warn('[Project Git] Failed to record commit activity:', activityError);
        });
        break;
      }

      case 'branches': {
        const local = (await git(['branch'])).split('\n').filter(Boolean).map((entry) => ({
          name: entry.replace('* ', '').trim(), current: entry.startsWith('*'), remote: false,
        }));
        let remoteBranches: Array<{ name: string; current: boolean; remote: boolean }> = [];
        try {
          remoteBranches = (await git(['branch', '-r'])).split('\n').filter(Boolean)
            .filter((entry) => !entry.includes('HEAD'))
            .map((entry) => ({ name: entry.trim(), current: false, remote: true }));
        } catch {}
        res.json({ branches: [...local, ...remoteBranches] });
        return;
      }

      case 'checkout':
      case 'checkout-new': {
        if (!isSafeProjectGitRef(branch)) { res.status(400).json({ error: 'Valid branch name required' }); return; }
        output = action === 'checkout'
          ? await git(['checkout', branch])
          : await git(['checkout', '-b', branch]);
        await prisma.activityLog.create({
          data: {
            userId: ownerId,
            action: action === 'checkout' ? 'PROJECT_GIT_CHECKOUT' : 'PROJECT_GIT_BRANCH_CREATE',
            resource: 'project', resourceId: projectIdentity.id, severity: 'INFO', metadata: { projectName: req.params.name, branch },
          },
        }).catch((activityError) => {
          console.warn('[Project Git] Failed to record branch activity:', activityError);
        });
        break;
      }

      case 'pull': {
        try {
          output = await git(['pull', '--ff-only'], { timeoutMs: 120_000, network: true });
        } catch (error: any) {
          if (abortController.signal.aborted) throw error;
          res.status(409).json({
            error: 'Git pull failed',
            details: commandError(error, 'No remote is configured or the remote rejected the pull'),
          });
          return;
        }
        let pullBranch = 'unknown';
        try { pullBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch {}
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_PULL', resource: 'project', resourceId: projectIdentity.id, severity: 'INFO', metadata: { projectName: req.params.name, branch: pullBranch } },
        }).catch((activityError) => {
          console.warn('[Project Git] Failed to record pull activity:', activityError);
        });
        break;
      }

      case 'push': {
        try {
          output = await git(['push'], { timeoutMs: 120_000, network: true });
        } catch (error: any) {
          if (abortController.signal.aborted) throw error;
          try {
            const currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            if (!isSafeProjectGitRef(currentBranch)) throw new Error('Unsafe current branch');
            output = await git(['push', '-u', 'origin', currentBranch], { timeoutMs: 120_000, network: true });
          } catch (fallbackError: any) {
            res.status(409).json({
              error: 'Git push failed',
              details: commandError(fallbackError, commandError(error, 'No remote is configured or the remote rejected the push')),
            });
            return;
          }
        }
        let pushBranch = 'unknown';
        try { pushBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch {}
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_PUSH', resource: 'project', resourceId: projectIdentity.id, severity: 'INFO', metadata: { projectName: req.params.name, branch: pushBranch } },
        }).catch((activityError) => {
          console.warn('[Project Git] Failed to record push activity:', activityError);
        });
        break;
      }

      case 'remote':
        try { output = await git(['remote', '-v']); } catch { output = 'No remotes configured'; }
        break;

      case 'remote-add': {
        const remoteName = req.body.remote || 'origin';
        if (typeof remoteName !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(remoteName)) {
          res.status(400).json({ error: 'Invalid remote name' });
          return;
        }
        let safeUrl = '';
        try { safeUrl = assertSafeProjectGitUrl(req.body.url); }
        catch (error: any) { res.status(400).json({ error: error.message }); return; }
        try { await git(['remote', 'remove', remoteName]); } catch {}
        await git(['remote', 'add', remoteName, safeUrl]);
        output = `Remote '${remoteName}' added: ${safeUrl}`;
        break;
      }

      case 'stash':
        output = await git(['stash']);
        break;
      case 'stash-pop':
        output = await git(['stash', 'pop']);
        break;
      case 'reset-file': {
        if (!resolveSafeProjectGitFile(projectDir, file)) { res.status(400).json({ error: 'Valid project file required' }); return; }
        output = await git(['checkout', '--', file]);
        output = `Reset: ${file}`;
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown git action' });
        return;
    }

    res.json({ output: output.toString().trim() });
  } catch (error: any) {
    if (!res.headersSent && !abortController.signal.aborted) {
      res.status(500).json({ output: error?.stdout?.toString() || error?.stderr?.toString() || error.message });
    }
  } finally {
    releaseProjectFileMutationLock?.();
    req.off('aborted', abort);
    res.off('close', close);
  }
});

// POST /api/projects/upload-zip - upload ZIP as project
router.post('/upload-zip', authenticateToken, requireApproved, zipUpload.single('file'), async (req: Request, res: Response) => {
  let promotedProjectDir: string | undefined;
  let promotedProjectRootIdentity: AttestedProjectRoot | undefined;
  let createdProjectIdentityId: string | undefined;
  let creationSuccessResponse: { name: string; detectedType: string; suggestedCommand: string } | undefined;
  let releaseProjectNameLock: (() => void) | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    if (!req.file) {
      res.status(400).json({ error: 'No zip file provided' });
      return;
    }

    const name = (req.body.name || path.basename(req.file.originalname, '.zip')).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'project';
    const projectDir = getProjectPath(ownerId, name);

    const scanResult = await scanFile(req.file.path);
    if (!scanResult.clean) {
      res.status(scanResult.scannerAvailable ? 400 : 503).json({
        error: scanResult.scannerAvailable
          ? `ZIP rejected: malware detected (${scanResult.threat})`
          : 'Project ZIP upload is temporarily unavailable because malware scanning could not complete',
      });
      return;
    }

    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, name),
    );
    await assertProjectIdentityNameAvailable({ workspaceOwnerId: ownerId, projectName: name });
    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    const stagingDir = createProjectCreationStagingDirectory();
    promotedProjectDir = stagingDir;
    promotedProjectRootIdentity = attestProjectRoot(stagingDir);
    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: name,
      projectRoot: stagingDir,
    });
    const projectIdentity = await createCurrentProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: name,
      projectRoot: stagingDir,
    });
    createdProjectIdentityId = projectIdentity.id;
    await safeExtractZipToNewDirectory(req.file.path, stagingDir, {
      limits: PROJECT_ZIP_LIMITS,
      collapseSingleRoot: true,
      existingEmptyDirectory: true,
    });
    const gitScope = { actorId: req.user!.userId, projectId: projectIdentity.id };

    // Auto-detect project type
    let detectedType = 'unknown';
    let suggestedCommand = '';
    const files = listProjectRootRegularFiles(stagingDir);
    if (files.includes('package.json')) {
      detectedType = 'node';
      try {
        const pkg = readProjectPackageJson(stagingDir);
        suggestedCommand = pkg?.scripts?.start ? 'npm start' : pkg?.scripts?.dev ? 'npm run dev' : 'node index.js';
      } catch { suggestedCommand = 'npm start'; }
    } else if (files.includes('requirements.txt')) {
      detectedType = 'python';
      suggestedCommand = files.includes('app.py') ? 'python app.py' : 'python main.py';
    } else if (files.includes('Cargo.toml')) {
      detectedType = 'rust'; suggestedCommand = 'cargo run';
    } else if (files.includes('index.html')) {
      detectedType = 'static'; suggestedCommand = 'npx serve .';
    } else if (files.includes('go.mod')) {
      detectedType = 'go'; suggestedCommand = 'go run .';
    } else if (files.includes('Dockerfile')) {
      detectedType = 'docker'; suggestedCommand = 'docker build -t app .';
    }

    // Init git
    try {
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['init'], timeoutMs: 10_000 });
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['add', '-A'], timeoutMs: 10_000 });
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['commit', '-m', 'Initial commit from ZIP upload'], timeoutMs: 10_000 });
    } catch {}

    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: name,
      projectRoot: stagingDir,
    });
    moveAttestedDirectoryNoReplace({
      sourceRoot: stagingDir,
      targetRoot: projectDir,
      expectedIdentity: projectIdentity,
    });
    promotedProjectDir = projectDir;
    creationSuccessResponse = { name, detectedType, suggestedCommand };
    await finalizeCurrentProjectIdentityCreation({
      projectIdentityId: projectIdentity.id,
      projectRoot: projectDir,
    });

    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_UPLOAD_ZIP',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: { projectName: name },
      },
    }).catch((error) => {
      console.warn('[Project ZIP Upload] Failed to record activity:', error);
    });

    res.status(201).json(creationSuccessResponse);
    promotedProjectDir = undefined;
    promotedProjectRootIdentity = undefined;
    createdProjectIdentityId = undefined;
  } catch (error: any) {
    const reconciliation = await reconcileFailedCurrentProjectCreation({
      projectIdentityId: createdProjectIdentityId,
      directory: promotedProjectDir,
      expectedDirectoryIdentity: promotedProjectRootIdentity,
    }, '[Project ZIP Upload] Staging cleanup failed:');
    if (reconciliation === 'published') {
      console.warn('[Project ZIP Upload] Publication committed before a later operation failed:', error);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.status(201).json(creationSuccessResponse!);
      }
      return;
    }
    console.error('ZIP upload error:', error);
    if (error instanceof LegacyOpenClawProjectCreationCollisionError) {
      res.status(409).json({ error: error.message, code: error.code, retryable: false });
    } else if (error instanceof LegacyOpenClawProjectCreationScanCapacityError) {
      res.status(503).json({ error: error.message, code: error.code, retryable: true });
    } else if (error instanceof ProjectIdentityLifecycleError || error?.code === 'P2002') {
      res.status(409).json({ error: 'Project name is already owned or reserved' });
    } else {
      res.status(500).json({ error: 'Failed to upload ZIP: ' + (error.message || 'unknown error') });
    }
  } finally {
    releaseProjectNameLock?.();
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  }
});

// POST /api/projects/create-from-upload - create project from a chunked-uploaded file
router.post('/create-from-upload', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let promotedProjectDir: string | undefined;
  let promotedProjectRootIdentity: AttestedProjectRoot | undefined;
  let createdProjectIdentityId: string | undefined;
  let creationSuccessResponse: { name: string; detectedType: string; suggestedCommand: string } | undefined;
  let releaseProjectNameLock: (() => void) | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name, filePath: uploadedFilePath } = req.body;
    if (!name || !uploadedFilePath) {
      res.status(400).json({ error: 'name and filePath required' });
      return;
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'project';
    const projectDir = getProjectPath(ownerId, safeName);

    const uploadedName = path.basename(String(uploadedFilePath));
    const fileRecord = await prisma.file.findFirst({ where: { userId: ownerId, path: uploadedName } });
    const fullPath = fileRecord ? resolveFilePath(ownerId, fileRecord.path) : null;
    if (!fileRecord || !fullPath) {
      res.status(404).json({ error: 'Uploaded file not found' });
      return;
    }

    const scanResult = await scanFile(fullPath);
    if (!scanResult.clean) {
      res.status(scanResult.scannerAvailable ? 400 : 503).json({
        error: scanResult.scannerAvailable
          ? `ZIP rejected: malware detected (${scanResult.threat})`
          : 'Project ZIP import is temporarily unavailable because malware scanning could not complete',
      });
      return;
    }

    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, safeName),
    );
    await assertProjectIdentityNameAvailable({ workspaceOwnerId: ownerId, projectName: safeName });
    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    const stagingDir = createProjectCreationStagingDirectory();
    promotedProjectDir = stagingDir;
    promotedProjectRootIdentity = attestProjectRoot(stagingDir);
    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    const projectIdentity = await createCurrentProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    createdProjectIdentityId = projectIdentity.id;
    await safeExtractZipToNewDirectory(fullPath, stagingDir, {
      limits: PROJECT_ZIP_LIMITS,
      collapseSingleRoot: true,
      existingEmptyDirectory: true,
    });
    const gitScope = { actorId: req.user!.userId, projectId: projectIdentity.id };

    // Auto-detect project type
    let detectedType = 'unknown';
    let suggestedCommand = '';
    const files = listProjectRootRegularFiles(stagingDir);
    if (files.includes('package.json')) {
      detectedType = 'node';
      try {
        const pkg = readProjectPackageJson(stagingDir);
        suggestedCommand = pkg?.scripts?.start ? 'npm start' : pkg?.scripts?.dev ? 'npm run dev' : 'node index.js';
      } catch { suggestedCommand = 'npm start'; }
    } else if (files.includes('requirements.txt')) {
      detectedType = 'python';
      suggestedCommand = files.includes('app.py') ? 'python app.py' : 'python main.py';
    } else if (files.includes('Cargo.toml')) {
      detectedType = 'rust'; suggestedCommand = 'cargo run';
    } else if (files.includes('index.html')) {
      detectedType = 'static'; suggestedCommand = 'npx serve .';
    } else if (files.includes('go.mod')) {
      detectedType = 'go'; suggestedCommand = 'go run .';
    } else if (files.includes('Dockerfile')) {
      detectedType = 'docker'; suggestedCommand = 'docker build -t app .';
    }

    // Init git
    try {
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['init'], timeoutMs: 10_000 });
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['add', '-A'], timeoutMs: 10_000 });
      await runProjectGitCommand({ ...gitScope, workspace: stagingDir, args: ['commit', '-m', 'Initial commit from ZIP upload'], timeoutMs: 10_000 });
    } catch {}

    await assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: ownerId,
      projectName: safeName,
      projectRoot: stagingDir,
    });
    moveAttestedDirectoryNoReplace({
      sourceRoot: stagingDir,
      targetRoot: projectDir,
      expectedIdentity: projectIdentity,
    });
    promotedProjectDir = projectDir;
    creationSuccessResponse = { name: safeName, detectedType, suggestedCommand };
    await finalizeCurrentProjectIdentityCreation({
      projectIdentityId: projectIdentity.id,
      projectRoot: projectDir,
    });

    // Consume the source upload only after the project is complete. If the DB
    // mutation fails, restore the source so Files never points at a missing path.
    const quarantine = path.join(path.dirname(fullPath), `.portal-import-${fileRecord.id}-${nanoid(8)}.part`);
    try {
      fs.renameSync(fullPath, quarantine);
      try {
        await prisma.file.delete({ where: { id: fileRecord.id } });
      } catch (error) {
        fs.renameSync(quarantine, fullPath);
        throw error;
      }
      removeToolMirror(ownerId, fileRecord.path);
      try { fs.unlinkSync(quarantine); } catch {}
    } catch (error) {
      console.warn('[create-from-upload] Project created, but source upload cleanup was rolled back:', error);
    }

    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_UPLOAD_ZIP',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: { projectName: safeName },
      },
    }).catch(() => {});

    res.status(201).json(creationSuccessResponse);
    promotedProjectDir = undefined;
    promotedProjectRootIdentity = undefined;
    createdProjectIdentityId = undefined;
  } catch (error: any) {
    const reconciliation = await reconcileFailedCurrentProjectCreation({
      projectIdentityId: createdProjectIdentityId,
      directory: promotedProjectDir,
      expectedDirectoryIdentity: promotedProjectRootIdentity,
    }, '[Create From Upload] Staging cleanup failed:');
    if (reconciliation === 'published') {
      console.warn('[Create From Upload] Publication committed before a later operation failed:', error);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.status(201).json(creationSuccessResponse!);
      }
      return;
    }
    console.error('Create from upload error:', error);
    if (error instanceof LegacyOpenClawProjectCreationCollisionError) {
      res.status(409).json({ error: error.message, code: error.code, retryable: false });
    } else if (error instanceof LegacyOpenClawProjectCreationScanCapacityError) {
      res.status(503).json({ error: error.message, code: error.code, retryable: true });
    } else if (error instanceof ProjectIdentityLifecycleError || error?.code === 'P2002') {
      res.status(409).json({ error: 'Project name is already owned or reserved' });
    } else {
      res.status(500).json({ error: 'Failed to create project: ' + (error.message || 'unknown error') });
    }
  } finally {
    releaseProjectNameLock?.();
  }
});

// POST /api/projects/:name/assistant/attachments - materialize one Project Chat
// attachment inside the exact attested project workspace. This endpoint never
// returns a host path or a signed Portal file URL: Project providers receive
// only the project-relative path visible through their sandbox mount.
router.post(
  '/:name/assistant/attachments',
  authenticateToken,
  requireApproved,
  projectPathSandbox,
  fileUpload.single('file'),
  async (req: Request, res: Response) => {
    const uploadedFile = req.file as Express.Multer.File | undefined;
    let attachmentDir: string | null = null;
    let materializedPath: string | null = null;
    let attachmentCommitted = false;
    let releaseProjectNameLock: ProjectDeletionLockLease | null = null;
    try {
      if (!uploadedFile) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }
      const { actorUserId, workspaceOwnerId, projectDir } = resolveActorProjectChatWorkspace(
        req,
        req.params.name,
      );
      if (!fs.existsSync(projectDir)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const { provider, executionContext, projectIdentity } = await resolveProjectChatOperationContext(
        actorUserId,
        workspaceOwnerId,
        req.params.name,
        projectDir,
        req.body?.provider,
        { readOnly: true },
      );
      if (!getProjectChatProviderCapability(provider).supportsAttachments) {
        throw new UnsupportedProjectChatProviderError(
          provider,
          'This Project provider does not expose a server-verified attachment path.',
        );
      }
      const coordination = await requireSelectedProjectChatState({
        actorUserId,
        projectIdentityId: executionContext.projectId,
        provider,
        expectedVersion: req.body?.stateVersion,
      });
      if (coordination.activeTurn) {
        throw new ProjectChatLeaseError(
          'TURN_ACTIVE',
          'Project attachments cannot change while a Project Chat turn is active',
        );
      }

      const safeOriginalName = path.posix.basename(uploadedFile.originalname.replace(/\\/g, '/'))
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .slice(0, 180);
      if (!safeOriginalName || safeOriginalName === '.' || safeOriginalName === '..') {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }
      const scanResult = await scanFile(uploadedFile.path);
      if (!scanResult.clean) {
        res.status(scanResult.scannerAvailable ? 422 : 503).json({
          error: scanResult.scannerAvailable
            ? 'Project attachment was rejected by malware scanning'
            : 'Project attachment is temporarily unavailable because malware scanning could not complete',
        });
        return;
      }

      // Malware scanning can be slow and does not touch the Project, so keep it
      // outside the lifecycle lane. Once scanning succeeds, acquire the exact
      // owner/name lock and distrust every pre-scan path, identity, and chat
      // observation before creating even the first .portal directory.
      releaseProjectNameLock = await acquireProjectDeletionLock(
        projectDeletionLockKey(workspaceOwnerId, req.params.name),
      );
      const lockedWorkspace = resolveActorProjectChatWorkspace(req, req.params.name);
      if (
        lockedWorkspace.actorUserId !== actorUserId
        || lockedWorkspace.workspaceOwnerId !== workspaceOwnerId
        || path.resolve(lockedWorkspace.projectDir) !== path.resolve(projectDir)
      ) {
        throw new ProjectIdentityMismatchError(
          'The Project workspace changed while the attachment was being scanned.',
        );
      }
      if (!fs.existsSync(lockedWorkspace.projectDir)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const lockedContext = await resolveProjectChatOperationContext(
        lockedWorkspace.actorUserId,
        lockedWorkspace.workspaceOwnerId,
        req.params.name,
        lockedWorkspace.projectDir,
        req.body?.provider,
      );
      if (
        lockedContext.provider !== provider
        || lockedContext.projectIdentity.id !== projectIdentity.id
        || lockedContext.projectIdentity.generation !== projectIdentity.generation
        || lockedContext.projectIdentity.canonicalRoot !== projectIdentity.canonicalRoot
        || lockedContext.projectIdentity.rootDevice !== projectIdentity.rootDevice
        || lockedContext.projectIdentity.rootInode !== projectIdentity.rootInode
        || lockedContext.projectIdentity.rootBirthtimeNs !== projectIdentity.rootBirthtimeNs
        || lockedContext.executionContext.projectId !== executionContext.projectId
      ) {
        throw new ProjectIdentityMismatchError(
          'The Project identity changed while the attachment was being scanned.',
        );
      }
      const admittedCoordination = await requireSelectedProjectChatState({
        actorUserId: lockedWorkspace.actorUserId,
        projectIdentityId: lockedContext.executionContext.projectId,
        provider: lockedContext.provider,
        expectedVersion: coordination.state!.version,
      });
      if (admittedCoordination.activeTurn) {
        throw new ProjectChatLeaseError(
          'TURN_ACTIVE',
          'Project attachments cannot change while a Project Chat turn is active',
        );
      }

      const attachmentSubdirectory = path.posix.join('.portal', 'attachments', crypto.randomUUID());
      attachmentDir = ensureProjectRuntimeOwnedDirectory(
        lockedWorkspace.projectDir,
        attachmentSubdirectory,
      );
      const destination = resolveContainedPath(attachmentDir, safeOriginalName, { mustExist: false });
      fs.copyFileSync(uploadedFile.path, destination, fs.constants.COPYFILE_EXCL);
      materializedPath = destination;
      assignProjectRuntimeOwnership(lockedWorkspace.projectDir, destination, 'file');
      fs.unlinkSync(uploadedFile.path);
      const confirmedCoordination = await requireSelectedProjectChatState({
        actorUserId: lockedWorkspace.actorUserId,
        projectIdentityId: lockedContext.executionContext.projectId,
        provider: lockedContext.provider,
        expectedVersion: admittedCoordination.state!.version,
      });
      if (confirmedCoordination.activeTurn) {
        throw new ProjectChatLeaseError(
          'TURN_ACTIVE',
          'Project attachments cannot change while a Project Chat turn is active',
        );
      }
      const projectPath = path.relative(lockedWorkspace.projectDir, destination).split(path.sep).join('/');
      await prisma.activityLog.create({
        data: {
          userId: lockedWorkspace.actorUserId,
          action: 'PROJECT_CHAT_ATTACHMENT_UPLOAD',
          resource: 'project',
          resourceId: lockedContext.executionContext.projectId,
          severity: 'INFO',
          metadata: {
            projectName: req.params.name,
            projectPath,
            fileName: safeOriginalName,
            fileSize: uploadedFile.size,
            provider: lockedContext.provider,
          },
        },
      });
      attachmentCommitted = true;
      attachmentDir = null;
      res.status(201).json({
        name: safeOriginalName,
        size: uploadedFile.size,
        projectPath,
        provider: lockedContext.provider,
        stateVersion: confirmedCoordination.state!.version,
      });
    } catch (error: any) {
      if (sendProjectChatProviderError(res, error)) return;
      if (sendProjectChatCoordinationError(res, error)) return;
      if (error instanceof ProjectIdentityMismatchError || error instanceof ProjectIdentityLifecycleError) {
        res.status(409).json({
          error: error.message,
          code: error.code,
          retryable: true,
        });
        return;
      }
      console.error('[Project Chat Attachment] Error:', error?.message || error);
      res.status(500).json({ error: 'Failed to attach file to Project Chat' });
    } finally {
      if (uploadedFile) {
        try { fs.unlinkSync(uploadedFile.path); } catch {}
      }
      if (!attachmentCommitted && materializedPath) {
        try { fs.unlinkSync(materializedPath); } catch {}
      }
      if (attachmentDir) {
        try { fs.rmdirSync(attachmentDir); } catch {}
      }
      releaseProjectNameLock?.();
    }
  },
);

// POST /api/projects/:name/upload - upload files to existing project
router.post('/:name/upload', authenticateToken, requireApproved, projectPathSandbox, fileUpload.array('files', 50), async (req: Request, res: Response) => {
  const uploadedFiles = req.files as Express.Multer.File[];
  let releaseProjectFileMutationLock: (() => void) | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    const userId = ownerId;
    releaseProjectFileMutationLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, req.params.name),
    );
    const projectDir = getProjectPath(userId, req.params.name);
    if (!fs.existsSync(projectDir)) {
      // Clean up temp files
      if (uploadedFiles) uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });

    if (!uploadedFiles || uploadedFiles.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }
    const aggregateSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(aggregateSize) || aggregateSize > 500 * 1024 * 1024) {
      uploadedFiles.forEach(file => { try { fs.unlinkSync(file.path); } catch {} });
      res.status(413).json({ error: 'Combined upload exceeds 500MB' });
      return;
    }

    // Target subdirectory within the project (default to root)
    const targetSubPath = (req.query.path as string) || '';
    let resolvedTarget: string;
    try {
      resolvedTarget = targetSubPath
        ? ensureProjectRuntimeOwnedDirectory(projectDir, targetSubPath)
        : fs.realpathSync(projectDir);
    } catch (error) {
      uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      if (error instanceof ProjectRuntimeOwnershipError) throw error;
      res.status(403).json({ error: 'Path traversal detected' });
      return;
    }

    const results: Array<{ name: string; path: string; size: number }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of uploadedFiles) {
      try {
        const safeOriginalName = path.posix.basename(file.originalname.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_');
        if (!safeOriginalName || safeOriginalName === '.' || safeOriginalName === '..') {
          throw new Error('Invalid filename');
        }
        const scanResult = await scanFile(file.path);
        if (!scanResult.clean) {
          throw new Error(scanResult.scannerAvailable
            ? `Malware detected (${scanResult.threat})`
            : 'Malware scanning unavailable');
        }
        const resolvedDest = resolveContainedPath(resolvedTarget, safeOriginalName, { mustExist: false });
        fs.copyFileSync(file.path, resolvedDest, fs.constants.COPYFILE_EXCL);
        assignProjectRuntimeOwnership(projectDir, resolvedDest, 'file');
        fs.unlinkSync(file.path);
        results.push({ name: safeOriginalName, path: path.relative(projectDir, resolvedDest).split(path.sep).join('/'), size: file.size });
      } catch (err: any) {
        if (err instanceof ProjectRuntimeOwnershipError) {
          try {
            const failedDestination = resolveContainedPath(
              resolvedTarget,
              path.posix.basename(file.originalname.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_'),
              { mustExist: false },
            );
            fs.unlinkSync(failedDestination);
          } catch {}
          throw err;
        }
        errors.push({ name: file.originalname, error: err.message || 'Failed to copy' });
        // Clean up temp file
        try { fs.unlinkSync(file.path); } catch {}
      }
    }

    if (results.length === 0 && errors.length > 0 && errors.every(item => item.error === 'Malware scanning unavailable')) {
      res.status(503).json({ error: 'Project upload is temporarily unavailable because malware scanning could not complete' });
      return;
    }

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'PROJECT_FILE_UPLOAD',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: {
          projectName: req.params.name,
          targetPath: targetSubPath || '/',
          fileCount: results.length,
          totalSize: results.reduce((s, f) => s + f.size, 0),
          fileNames: results.map(f => f.name),
        },
      },
    }).catch((error) => {
      console.warn('[Project Upload] Failed to record activity:', error);
    });

    res.json({
      message: `Uploaded ${results.length} file(s)`,
      uploaded: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    console.error('File upload error:', error);
    // Clean up any remaining temp files
    if (uploadedFiles) uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    if (error instanceof ProjectRuntimeOwnershipError) {
      res.status(503).json({
        error: 'Project storage is temporarily unavailable. Try again.',
        code: error.code,
        retryable: error.retryable,
      });
      return;
    }
    res.status(500).json({ error: 'Failed to upload files' });
  } finally {
    releaseProjectFileMutationLock?.();
  }
});

// GET /api/projects/:name/activity - project activity feed
router.get('/:name/activity', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });
    const parsedLimit = Number.parseInt(String(req.query.limit || '20'), 10);
    const limit = Math.max(1, Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 20, 100));
    // Get app record for this project
    const app = await prisma.app.findFirst({
      where: { userId: ownerId, name: req.params.name },
    });

    const logs = await prisma.activityLog.findMany({
      where: {
        userId: ownerId,
        resource: 'project',
        resourceId: { in: [projectIdentity.id, ...(app?.id ? [app.id] : [])] },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({ logs });
  } catch {
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

/**
 * Everything after deletion admission (DELETING committed) through durable row
 * removal. Idempotent by construction — quarantine receipts, absence markers,
 * and guarded deletes let a crashed deletion resume here, both from a client
 * retry of the DELETE route and from automatic lifecycle-residue recovery.
 */
async function completeAdmittedProjectDeletion(input: {
  actorUserId: string;
  ownerId: string;
  projectName: string;
  projectDir: string;
  projectIdentity: ProjectIdentityRecord;
  actorIdsBeforeBarrier?: readonly string[];
}): Promise<Record<string, unknown>> {
  const { actorUserId, ownerId, projectName, projectDir, projectIdentity } = input;
  const externalProjectApp = await findProjectAppForIdentity({
    workspaceOwnerId: ownerId,
    projectIdentityId: projectIdentity.id,
    projectName,
    deployPath: path.join(DEPLOY_DIR, `${ownerId}-${projectName}`),
  });
  // Defense in depth for startup residue recovery and already-admitted older
  // deletions. New requests are rejected before the DELETING barrier below.
  assertProjectRuntimeLifecycleMutable(externalProjectApp, 'delete-project');
  // Re-read after DELETING closes admission so an actor that admitted in the
  // narrow discovery/barrier interval cannot retain an in-process callback.
  const actorIds = Array.from(new Set([
    ...(input.actorIdsBeforeBarrier || [actorUserId, ownerId]),
    ...await listProjectLifecycleActorIds({
      projectIdentityId: projectIdentity.id,
      workspaceOwnerId: ownerId,
      authenticatedActorId: actorUserId,
    }),
  ]));
  for (const actorId of actorIds) {
    if (actorId === ownerId) {
      await migrateLegacyProjectChatState({
        actorUserId: actorId,
        legacyProjectId: projectName,
        immutableProjectId: projectIdentity.id,
      });
    }
    await quiesceProjectChatBrokerCallbacksForDestructiveReset({
      actorUserId: actorId,
      projectIdentityId: projectIdentity.id,
    });
  }

  const deployId = `${ownerId}-${projectName}`;
  const deployPath = path.join(DEPLOY_DIR, deployId);
  const initialDeployAttestation = managedPathExists(deployPath)
    ? attestProjectRoot(deployPath)
    : null;
  if (externalProjectApp?.deployType === 'fullstack') {
    await forgetAppRuntime(externalProjectApp.id, deployId, {
      actorId: ownerId,
      projectId: projectIdentity.id,
      deployPath: externalProjectApp.zipPath,
      port: externalProjectApp.port,
    }, { settleStatus: 'stopped' });
  } else {
    await stopApp(deployId);
  }
  const removedProjectWorkloads = await removePortalProjectWorkloadsForProject(projectIdentity.id);

  const cleanup = await cleanupProjectRuntime({
    authenticatedActorId: actorUserId,
    workspaceOwnerId: ownerId,
    projectIdentity,
  }, {
    adapters: PROJECT_RUNTIME_CLEANUP_ADAPTERS,
    egressAdapter: PROJECT_EGRESS_CLEANUP_ADAPTER,
  });
  await retireLegacyOpenClawRuntimesForProject({
    actorUserIds: actorIds,
    projectIdentityId: projectIdentity.id,
    legacyProjectName: projectName,
    legacyProjectOwnerId: ownerId,
    targetCanonicalRoot: projectIdentity.canonicalRoot,
  });
  const removedQualificationEvidenceByProvider = Object.fromEntries(
    QUALIFIABLE_PROJECT_PROVIDERS.map((provider) => [
      provider,
      removeProjectQualificationEvidenceForProject(provider, projectIdentity.id),
    ]),
  );
  const removedQualificationEvidence = Object.values(removedQualificationEvidenceByProvider)
    .reduce((total, count) => total + count, 0);

  const desktopRuntime = await stopProjectDesktopRuntimesForLifecycle({
    workspaceOwnerId: ownerId,
    projectIdentityId: projectIdentity.id,
    projectName,
  });
  await removeDirectoryThroughAttestedQuarantine({
    sourceRoot: desktopRuntime.runtimeDir,
    quarantineKey: `desktop-current:${projectIdentity.id}`,
    expectedIdentity: desktopRuntime.identity || undefined,
    sourceMustBeAbsent: !desktopRuntime.identity,
  });

  if (!initialDeployAttestation && managedPathExists(deployPath)) {
    throw new ProjectIdentityLifecycleError(
      'A deployment directory appeared after Project deletion started',
    );
  }
  await removeDirectoryThroughAttestedQuarantine({
    sourceRoot: deployPath,
    quarantineKey: `deploy:${projectIdentity.id}`,
    expectedIdentity: initialDeployAttestation || undefined,
    sourceMustBeAbsent: !initialDeployAttestation,
  });
  await removeDirectoryThroughAttestedQuarantine({
    sourceRoot: projectDir,
    quarantineKey: `project:${projectIdentity.id}`,
    expectedIdentity: projectIdentity,
  });

  await prisma.$transaction(async (transaction) => {
    const legacyOrImmutable = {
      OR: [
        { projectId: projectIdentity.id },
        { userId: ownerId, projectId: projectName },
      ],
    };
    await transaction.projectChatMessage.deleteMany({ where: legacyOrImmutable });
    await transaction.projectChatProviderBinding.deleteMany({ where: legacyOrImmutable });
    await transaction.projectChatSession.deleteMany({ where: legacyOrImmutable });
    await transaction.app.deleteMany({
      where: projectAppAssociationWhere({
        workspaceOwnerId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectName,
        deployPath,
      }),
    });
    const deleted = await transaction.projectIdentity.deleteMany({
      where: { id: projectIdentity.id, lifecycleStatus: 'DELETING' },
    });
    if (deleted.count !== 1) throw new Error('Project identity deletion barrier changed before commit');
  });

  const runtimeCleanup = {
    ...cleanup,
    removedProjectWorkloads,
    removedQualificationEvidence,
    removedQualificationEvidenceByProvider,
  };
  await prisma.activityLog.create({
    data: {
      userId: actorUserId,
      action: 'PROJECT_DELETE',
      resource: 'project',
      resourceId: projectIdentity.id,
      severity: 'INFO',
      metadata: {
        projectName,
        projectIdentityId: projectIdentity.id,
        runtimeCleanup,
      },
    },
  }).catch((activityError) => {
    console.warn('[Project Delete] Failed to record activity:', activityError);
  });
  return runtimeCleanup;
}

// DELETE /api/projects/:name - delete project
router.delete('/:name', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseDeletionLock: (() => void) | null = null;
  try {
    const identityRequest = parseProjectDeleteIdentityRequest(req.body);
    if (identityRequest.kind === 'invalid') {
      res.status(400).json({
        error: 'An exact immutable Project identity proof requires projectIdentityId and projectGeneration.',
        code: 'PROJECT_DELETE_IDENTITY_REQUIRED',
        status: 'not_admitted',
        admitted: false,
        retryable: false,
      });
      return;
    }
    const deletionIdentityProof = identityRequest.kind === 'valid'
      ? identityRequest.proof
      : null;
    const ownerId = await getScopedOwnerId(req);
    const identityAtRequest = await prisma.projectIdentity.findUnique({
      where: {
        workspaceOwnerId_projectName: {
          workspaceOwnerId: ownerId,
          projectName: req.params.name,
        },
      },
    });
    if (!identityAtRequest && deletionIdentityProof) {
      res.json({ message: 'Project deleted', alreadyAbsent: true });
      return;
    }
    const requestedIdentity = requireCurrentProjectDestructiveIdentity(identityAtRequest);
    if (
      deletionIdentityProof
      && !projectDeleteIdentityMatches(requestedIdentity, deletionIdentityProof)
    ) {
      sendProjectDeleteIdentityMismatch(res);
      return;
    }
    await assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id);
    releaseDeletionLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, req.params.name),
    );
    const actorUserId = req.user!.userId;
    const currentRequestedIdentity = await prisma.projectIdentity.findUnique({
      where: { id: requestedIdentity.id },
    });
    if (!currentRequestedIdentity) {
      if (deletionIdentityProof) {
        const replacementIdentity = await prisma.projectIdentity.findUnique({
          where: {
            workspaceOwnerId_projectName: {
              workspaceOwnerId: ownerId,
              projectName: req.params.name,
            },
          },
        });
        if (
          replacementIdentity
          && !projectDeleteIdentityMatches(replacementIdentity, deletionIdentityProof)
        ) {
          sendProjectDeleteIdentityMismatch(res);
          return;
        }
      }
      res.json({ message: 'Project deleted', alreadyAbsent: true });
      return;
    }
    if (
      deletionIdentityProof
      && (
        currentRequestedIdentity.workspaceOwnerId !== ownerId
        || currentRequestedIdentity.projectName !== req.params.name
        || !projectDeleteIdentityMatches(currentRequestedIdentity, deletionIdentityProof)
      )
    ) {
      sendProjectDeleteIdentityMismatch(res);
      return;
    }
    requireCurrentProjectDestructiveIdentity(
      currentRequestedIdentity as unknown as ProjectIdentityRecord,
    );
    const currentProjectApp = await findProjectAppForIdentity({
      workspaceOwnerId: ownerId,
      projectIdentityId: currentRequestedIdentity.id,
      projectName: currentRequestedIdentity.projectName,
      deployPath: path.join(
        DEPLOY_DIR,
        `${ownerId}-${currentRequestedIdentity.projectName}`,
      ),
    });
    if (sendRuntimeOwnershipMutationConflict(res, currentProjectApp, 'delete-project')) return;
    if (currentRequestedIdentity.lifecycleStatus === 'DELETING') {
      const runtimeCleanup = await completeAdmittedProjectDeletion({
        actorUserId,
        ownerId,
        projectName: currentRequestedIdentity.projectName,
        projectDir: getProjectPath(ownerId, currentRequestedIdentity.projectName),
        projectIdentity: currentRequestedIdentity as unknown as ProjectIdentityRecord,
      });
      res.json({ message: 'Project deleted', runtimeCleanup, resumed: true });
      return;
    }
    const renameConvergence = await convergeInterruptedProjectRenameForDestructiveOperation({
      actorUserId,
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      currentProjectIdentityId: requestedIdentity.id,
    });
    if (renameConvergence.renamedTo) {
      res.status(409).json({
        error: 'This Project finished renaming. Retry deletion using its current name.',
        code: 'PROJECT_RENAMED',
        newName: renameConvergence.renamedTo,
        retryable: true,
      });
      return;
    }
    const projectName = renameConvergence.projectName;
    const projectDir = renameConvergence.projectDir;
    const projectExists = fs.existsSync(projectDir);
    await assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id);
    const identityBeforeBarrier = projectExists
      ? await ensureProjectIdentity({
        workspaceOwnerId: ownerId,
        projectName,
        projectRoot: projectDir,
      })
      : await prisma.projectIdentity.findUnique({
        where: {
          workspaceOwnerId_projectName: {
            workspaceOwnerId: ownerId,
            projectName,
          },
        },
      });
    if (identityBeforeBarrier) {
      requireCurrentProjectDestructiveIdentity(identityBeforeBarrier);
      if (
        deletionIdentityProof
        && !projectDeleteIdentityMatches(identityBeforeBarrier, deletionIdentityProof)
      ) {
        sendProjectDeleteIdentityMismatch(res);
        return;
      }
      if (identityBeforeBarrier.id !== requestedIdentity.id) {
        throw new ProjectIdentityLifecycleError('Project identity changed before deletion admission');
      }
      await assertProjectChatDestructiveResetInactive(identityBeforeBarrier.id);
      await assertLegacyOpenClawProjectMigrationInactive(identityBeforeBarrier.id);
    }
    const actorIdsBeforeBarrier = identityBeforeBarrier
      ? await listProjectLifecycleActorIds({
        projectIdentityId: identityBeforeBarrier.id,
        workspaceOwnerId: ownerId,
        authenticatedActorId: actorUserId,
      })
      : Object.freeze([actorUserId, ownerId]);
    await assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id);
    const projectIdentity = projectExists
      ? await beginProjectIdentityDeletion({
        workspaceOwnerId: ownerId,
        projectName,
        projectRoot: projectDir,
      })
      : await beginOrphanedProjectIdentityDeletion({ workspaceOwnerId: ownerId, projectName });
    // Deletion is idempotent: a repeat request (or a double-click that raced
    // the first) for an already-removed project is a success, not an error.
    if (!projectIdentity && !projectExists) {
      res.json({ message: 'Project deleted', alreadyAbsent: true });
      return;
    }
    if (!projectIdentity) { res.status(404).json({ error: 'Project not found' }); return; }
    await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);

    const runtimeCleanup = await completeAdmittedProjectDeletion({
      actorUserId,
      ownerId,
      projectName,
      projectDir,
      projectIdentity,
      actorIdsBeforeBarrier,
    });

    res.json({ message: 'Project deleted', runtimeCleanup });
  } catch (error) {
    logProjectLifecycleDecision({
      route: 'project-delete',
      code: String((error as any)?.code || (error as any)?.name || 'UNKNOWN'),
      status: 0,
      projectName: req.params.name,
      detail: String((error as any)?.message || error).slice(0, 300),
    });
    if (error instanceof ProjectMoveRequiredError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: false,
      });
      return;
    }
    if (error instanceof ProjectExternalRuntimeLifecycleError) {
      res.status(409).json(projectExternalRuntimeConflict(error));
      return;
    }
    if (error instanceof ProjectInvalidRuntimeBindingError) {
      res.status(503).json(projectInvalidRuntimeBindingConflict(error));
      return;
    }
    if (error instanceof ProjectRuntimeStateAttestationError) {
      res.status(409).json({
        code: error.code,
        error: error.message,
        retryable: error.retryable,
        recoveryAction: 'REVIEW_RUNTIME_STATE',
      });
      return;
    }
    if (error instanceof ProjectChatDestructiveResetActiveError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: true,
      });
      return;
    }
    if (error instanceof LegacyOpenClawProjectMigrationActiveError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      });
      return;
    }
    if (error instanceof PortalProjectWorkloadError) {
      res.status(503).json({
        error: 'Project deletion is paused until Portal-owned Git, build, and app runtimes are proven clean.',
        code: error.code,
        retryable: true,
      });
      return;
    }
    if (error instanceof ProjectRuntimeCleanupError) {
      // TURN_STILL_ACTIVE clears itself when the held lease lapses, so calling
      // it non-retryable was wrong: the delete was reported as a dead end and
      // then completed on its own moments later, which is what made deleting a
      // project feel broken. Rename already treated this class as retryable.
      const retryable = [
        'ENUMERATION_FAILED',
        'CLEANUP_FAILED',
        'TURN_ABORT_FAILED',
        'TURN_STILL_ACTIVE',
      ].includes(error.code);
      const stillRunning = error.code === 'TURN_STILL_ACTIVE';
      if (stillRunning && error.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      }
      res.status(retryable ? 503 : 409).json({
        error: stillRunning
          ? 'This Project is still finishing a chat turn. Deletion will be accepted as soon as it settles.'
          : 'Project deletion is paused until its isolated runtime can be proven clean.',
        code: error.code,
        provider: error.provider,
        retryable,
        ...(stillRunning && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      });
      return;
    }
    if (error instanceof ProjectIdentityLifecycleError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: true,
      });
      return;
    }
    res.status(500).json({ error: 'Failed to delete project' });
  } finally {
    releaseDeletionLock?.();
  }
});

// PATCH /api/projects/:name/rename - rename a project
// `attemptId` correlates this response with one browser-owned admission. This
// route does not claim durable server-side replay/idempotency; an uncertain
// caller must reconcile list/tree identity and must not resubmit the PATCH.
router.patch('/:name/rename', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const releaseLocks: ProjectDeletionLockLease[] = [];
  const lifecycleLocksByKey = new Map<string, ProjectDeletionLockLease>();
  let renameGrant: Awaited<ReturnType<typeof beginProjectIdentityRename>> | null = null;
  let renameLeaseTimer: NodeJS.Timeout | null = null;
  let renameLeaseRenewal: Promise<void> = Promise.resolve();
  let renameLeaseFailure: unknown = null;
  let runtimeCleanupCommitted = false;
  let projectPathMoved = false;
  let deployPathMoved = false;
  let identityCommitted = false;
  let attemptId: string | null = null;
  let requestedProjectIdentityId = '';
  let requestedProjectGeneration = 0;
  let ownerId = '';
  let targetProjectName = '';
  let oldDir = '';
  let newDir = '';
  let oldDeployPath = '';
  let newDeployPath = '';
  let oldDeployId = '';
  let oldDeployAttestation: AttestedDirectoryIdentity | null = null;
  let restartFullstackApp = false;
  let app: Awaited<ReturnType<typeof prisma.app.findFirst>> | null = null;

  const requireHeldRenameLifecycleLock = (projectName: string): ProjectDeletionLockLease => {
    const lifecycleLock = lifecycleLocksByKey.get(projectDeletionLockKey(ownerId, projectName));
    if (!lifecycleLock?.isHeld()) {
      throw new ProjectIdentityLifecycleError(
        'Project rename lost its exact lifecycle admission before runtime start',
      );
    }
    return lifecycleLock;
  };

  const queueLeaseRenewal = () => {
    if (!renameGrant || renameLeaseFailure) return;
    renameLeaseRenewal = renameLeaseRenewal.then(async () => {
      if (!renameGrant) return;
      await renewProjectIdentityRenameLease({
        projectIdentityId: renameGrant.identity.id,
        leaseToken: renameGrant.leaseToken,
      });
    }).catch((error) => {
      renameLeaseFailure = error;
    });
  };

  const stopLeaseHeartbeat = async (refreshBeforeMove = false) => {
    if (renameLeaseTimer) clearInterval(renameLeaseTimer);
    renameLeaseTimer = null;
    await renameLeaseRenewal;
    if (renameLeaseFailure) throw renameLeaseFailure;
    if (refreshBeforeMove && renameGrant) {
      await renewProjectIdentityRenameLease({
        projectIdentityId: renameGrant.identity.id,
        leaseToken: renameGrant.leaseToken,
      });
    }
  };

  try {
    const { newName, attemptId: rawAttemptId, projectIdentityId, projectGeneration } = req.body;
    attemptId = typeof rawAttemptId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(rawAttemptId)
      ? rawAttemptId
      : null;
    if (!attemptId) {
      sendProjectRenameNotAdmitted(res, 400, null, 'PROJECT_RENAME_ATTEMPT_REQUIRED', 'A valid rename attempt ID is required');
      return;
    }
    if (!newName || typeof newName !== 'string') {
      sendProjectRenameNotAdmitted(res, 400, attemptId, 'PROJECT_RENAME_NAME_REQUIRED', 'newName is required');
      return;
    }
    if (
      typeof projectIdentityId !== 'string'
      || !projectIdentityId
      || !Number.isSafeInteger(projectGeneration)
      || projectGeneration < 1
    ) {
      sendProjectRenameNotAdmitted(
        res,
        400,
        attemptId,
        'PROJECT_RENAME_IDENTITY_REQUIRED',
        'An immutable project identity proof is required',
      );
      return;
    }
    requestedProjectIdentityId = projectIdentityId;
    requestedProjectGeneration = projectGeneration;

    const sanitized = newName.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized !== newName) {
      sendProjectRenameNotAdmitted(res, 400, attemptId, 'PROJECT_RENAME_NAME_INVALID', 'Invalid project name');
      return;
    }
    if (sanitized === req.params.name) {
      sendProjectRenameNotAdmitted(
        res,
        409,
        attemptId,
        'PROJECT_RENAME_NAME_UNCHANGED',
        'The rename target must differ from the current project name',
      );
      return;
    }

    ownerId = await getScopedOwnerId(req);
    targetProjectName = sanitized;
    const requestedIdentity = await prisma.projectIdentity.findUnique({
      where: { id: requestedProjectIdentityId },
    });
    if (
      !requestedIdentity
      || requestedIdentity.workspaceOwnerId !== ownerId
    ) {
      sendProjectRenameNotAdmitted(
        res,
        409,
        attemptId,
        'PROJECT_RENAME_IDENTITY_CHANGED',
        'The project identity changed before rename admission',
      );
      return;
    }
    requireCurrentProjectDestructiveIdentity(requestedIdentity);
    const requestedIdentityMatchesSource = (
      ['ACTIVE', 'RENAMING'].includes(requestedIdentity.lifecycleStatus || 'ACTIVE')
      && requestedIdentity.projectName === req.params.name
      && requestedIdentity.generation === requestedProjectGeneration
    );
    const requestedIdentityMatchesCompletedRename = (
      requestedProjectGeneration < Number.MAX_SAFE_INTEGER
      && (requestedIdentity.lifecycleStatus || 'ACTIVE') === 'ACTIVE'
      && requestedIdentity.projectName === sanitized
      && requestedIdentity.generation === requestedProjectGeneration + 1
      && requestedIdentity.lastRenameSourceName === req.params.name
      && requestedIdentity.lastRenameCompletedAt instanceof Date
    );
    if (!requestedIdentityMatchesSource && !requestedIdentityMatchesCompletedRename) {
      sendProjectRenameNotAdmitted(
        res,
        409,
        attemptId,
        'PROJECT_RENAME_IDENTITY_CHANGED',
        'The project identity changed before rename admission',
      );
      return;
    }
    await assertLegacyOpenClawProjectMigrationInactive(requestedIdentity.id);

    oldDir = getProjectPath(ownerId, req.params.name);
    newDir = getProjectPath(ownerId, sanitized);
    oldDeployId = `${ownerId}-${req.params.name}`;
    const newDeployId = `${ownerId}-${sanitized}`;
    oldDeployPath = path.join(DEPLOY_DIR, oldDeployId);
    newDeployPath = path.join(DEPLOY_DIR, newDeployId);

    for (const lockKey of Array.from(new Set([
      projectDeletionLockKey(ownerId, req.params.name),
      projectDeletionLockKey(ownerId, sanitized),
    ])).sort()) {
      const lifecycleLock = await acquireProjectDeletionLock(lockKey);
      releaseLocks.push(lifecycleLock);
      lifecycleLocksByKey.set(lockKey, lifecycleLock);
    }

    if (!requestedIdentityMatchesCompletedRename) {
      const lifecycleApp = await findProjectAppForIdentity({
        workspaceOwnerId: ownerId,
        projectIdentityId: requestedIdentity.id,
        projectName: req.params.name,
        deployPath: oldDeployPath,
      });
      if (sendRuntimeOwnershipMutationConflict(res, lifecycleApp, 'rename-project')) return;
    }

    if (!managedPathExists(oldDir)) {
      if (!managedPathExists(newDir)) {
        sendProjectRenameNotAdmitted(
          res,
          404,
          attemptId,
          'PROJECT_RENAME_SOURCE_NOT_FOUND',
          'Project not found',
        );
        return;
      }
      const interrupted = await readProjectIdentityRenameJournal({
        workspaceOwnerId: ownerId,
        projectName: sanitized,
      });
      if (
        interrupted
        && (
          interrupted.projectName !== req.params.name
          || interrupted.renameTargetName !== sanitized
        )
      ) {
        res.status(409).json({
          error: 'Rename target is participating in a different Project rename.',
        });
        return;
      }
      if (interrupted && (
        interrupted.id !== requestedProjectIdentityId
        || interrupted.generation !== requestedProjectGeneration
      )) {
        res.status(409).json({
          error: 'Interrupted Project rename belongs to a different immutable identity.',
          code: 'PROJECT_RENAME_IDENTITY_CHANGED',
          retryable: true,
        });
        return;
      }
      if (!interrupted) {
        const completed = await readCompletedProjectIdentityRename({
          workspaceOwnerId: ownerId,
          oldProjectName: req.params.name,
          newProjectName: sanitized,
          newProjectRoot: newDir,
        });
        if (!completed) {
          res.status(409).json({ error: 'Rename target belongs to a different Project.' });
          return;
        }
        if (
          completed.id !== requestedProjectIdentityId
          || completed.generation !== requestedProjectGeneration + 1
        ) {
          res.status(409).json({
            error: 'Completed Project rename does not match the submitted immutable identity proof.',
            code: 'PROJECT_RENAME_IDENTITY_CHANGED',
            retryable: true,
          });
          return;
        }
        res.json({
          name: sanitized,
          attemptId,
          status: 'committed',
          alreadyRenamed: true,
          identity: serializeProjectIdentityProof(completed),
        });
        return;
      }
      await assertLegacyOpenClawProjectMigrationInactive(interrupted.id);
      await assertProjectChatDestructiveResetInactive(interrupted.id);
      await assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId);
      await stopProjectDesktopRuntimesForLifecycle({
        workspaceOwnerId: ownerId,
        projectIdentityId: interrupted.id,
        projectName: req.params.name,
      });
      convergeInterruptedProjectDeployment({
        mode: 'complete',
        identity: interrupted,
        oldDeployPath,
        newDeployPath,
      });
      const recovered = await completeInterruptedProjectRenameWithApps({
        workspaceOwnerId: ownerId,
        projectIdentityId: interrupted.id,
        oldProjectName: req.params.name,
        newProjectName: sanitized,
        newProjectRoot: newDir,
        oldDeployPath,
        newDeployPath,
      });
      if (
        !recovered
        || recovered.projectName !== sanitized
        || recovered.id !== requestedProjectIdentityId
        || recovered.generation !== requestedProjectGeneration + 1
      ) {
        res.status(409).json({ error: 'Project rename recovery could not verify the target.' });
        return;
      }
      res.json({
        name: sanitized,
        attemptId,
        status: 'committed',
        identity: serializeProjectIdentityProof(recovered),
        recovered: true,
        warning: 'The interrupted rename was recovered with its app runtime stopped. Start it again when ready.',
      });
      return;
    }
    const pendingRename = await readProjectIdentityRenameJournal({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
    });
    if (managedPathExists(newDir)) {
      if (!pendingRename) {
        sendProjectRenameNotAdmitted(
          res,
          409,
          attemptId,
          'PROJECT_RENAME_TARGET_EXISTS',
          'A project with that name already exists',
        );
      } else {
        res.status(409).json({
          error: 'Interrupted Project rename has ambiguous source and target roots.',
          code: 'PROJECT_RENAME_CONFLICT',
          retryable: true,
        });
      }
      return;
    }
    if (await prisma.app.count({ where: { userId: ownerId, name: sanitized } }) > 0) {
      res.status(409).json({ error: 'An app with the new project name already exists' });
      return;
    }
    if (pendingRename) {
      await assertProjectChatDestructiveResetInactive(pendingRename.id);
      await assertLegacyOpenClawProjectMigrationInactive(pendingRename.id);
    } else {
      await assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId);
      const renameMigrationIdentity = await ensureProjectIdentity({
        workspaceOwnerId: ownerId,
        projectName: req.params.name,
        projectRoot: oldDir,
      });
      await assertProjectChatDestructiveResetInactive(renameMigrationIdentity.id);
      await assertLegacyOpenClawProjectMigrationInactive(renameMigrationIdentity.id);
    }
    if (
      pendingRename
      && (
        pendingRename.projectName !== req.params.name
        || pendingRename.renameTargetName !== sanitized
      )
    ) {
      res.status(409).json({ error: 'A different Project rename is already pending.' });
      return;
    }
    if (pendingRename) {
      oldDeployAttestation = readProjectIdentityRenameDeployIdentity(pendingRename);
      await assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId);
      const deployLocation = convergeInterruptedProjectDeployment({
        mode: 'continue',
        identity: pendingRename,
        oldDeployPath,
        newDeployPath,
      });
      deployPathMoved = deployLocation === 'new';
    } else {
      oldDeployAttestation = managedPathExists(oldDeployPath)
        ? attestProjectRoot(oldDeployPath)
        : null;
      if (managedPathExists(newDeployPath)) {
        sendProjectRenameNotAdmitted(
          res,
          409,
          attemptId,
          'PROJECT_RENAME_DEPLOYMENT_TARGET_EXISTS',
          'A deployment with the new project name already exists',
        );
        return;
      }
    }

    const identityBeforeRenameBarrier = await prisma.projectIdentity.findUnique({
      where: {
        workspaceOwnerId_projectName: {
          workspaceOwnerId: ownerId,
          projectName: req.params.name,
        },
      },
    });
    if (
      !identityBeforeRenameBarrier
      || identityBeforeRenameBarrier.id !== requestedProjectIdentityId
      || identityBeforeRenameBarrier.generation !== requestedProjectGeneration
    ) {
      if (!pendingRename) {
        sendProjectRenameNotAdmitted(
          res,
          409,
          attemptId,
          'PROJECT_RENAME_IDENTITY_CHANGED',
          'The project identity changed before rename admission',
        );
      } else {
        res.status(409).json({
          error: 'Pending Project rename does not match the submitted immutable identity proof.',
          code: 'PROJECT_RENAME_IDENTITY_CHANGED',
          retryable: true,
        });
      }
      return;
    }
    const actorsBeforeRenameBarrier = identityBeforeRenameBarrier
      ? await listProjectLifecycleActorIds({
        projectIdentityId: identityBeforeRenameBarrier.id,
        workspaceOwnerId: ownerId,
        authenticatedActorId: req.user!.userId,
      })
      : Object.freeze([req.user!.userId, ownerId]);

    await assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId);
    renameGrant = await beginProjectIdentityRename({
      workspaceOwnerId: ownerId,
      oldProjectName: req.params.name,
      newProjectName: sanitized,
      oldProjectRoot: oldDir,
      newProjectRoot: newDir,
      deployRootIdentity: oldDeployAttestation,
    });
    const projectIdentity = renameGrant.identity;

    // Rename is not an implicit "cancel chat" action. The durable identity
    // barrier closes new admission first, then this read detects a turn that
    // was already admitted. A barrier created by this request has made no
    // provider/filesystem mutation yet, so it can be rolled back exactly and
    // the Project remains usable. The durable cleanup-start marker—not process
    // memory or lease age—distinguishes that case from a genuinely partial
    // attempt that must remain RENAMING for explicit recovery.
    const [activeDurableTurn, activeDurableState] = await Promise.all([
      prisma.projectChatTurn.findFirst({
        where: {
          projectIdentityId: projectIdentity.id,
          status: { in: ['RUNNING', 'ABORTING'] },
        },
        select: { id: true },
      }),
      prisma.projectChatState.findFirst({
        where: { projectIdentityId: projectIdentity.id, activeTurnId: { not: null } },
        select: { id: true },
      }),
    ]);
    if ((activeDurableTurn || activeDurableState) && !renameGrant.resumed) {
      const cleanupMayHaveStarted = renameGrant.identity.renameCleanupStartedAt instanceof Date
        || renameGrant.identity.renameRuntimeCleanedAt instanceof Date;
      if (!cleanupMayHaveStarted) {
        await abandonProjectIdentityRenameBeforeCleanup({
          projectIdentityId: projectIdentity.id,
          leaseToken: renameGrant.leaseToken,
          oldProjectRoot: oldDir,
        });
        renameGrant = null;
      }
      res.status(409).json({
        error: cleanupMayHaveStarted
          ? 'Project rename recovery is paused until the active Project Chat turn finishes.'
          : 'Finish or stop the active Project Chat turn before renaming this Project.',
        code: 'PROJECT_RENAME_TURN_ACTIVE',
        retryable: true,
      });
      return;
    }

    // A resumed lease owns an expired journal from a process that can no longer
    // finish its callback. Keep RENAMING closed and let deletion-grade cleanup
    // abort/re-attest that stale durable turn under the new lease. Reopening
    // ACTIVE here would strand a cleanup-started journal forever.

    renameLeaseTimer = setInterval(queueLeaseRenewal, 30_000);
    renameLeaseTimer.unref?.();

    const projectApps = await prisma.app.findMany({
      where: projectAppAssociationWhere({
        workspaceOwnerId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectName: req.params.name,
        deployPath: oldDeployPath,
      }),
      take: 2,
    });
    if (projectApps.length > 1) {
      throw new ProjectIdentityLifecycleError(
        'More than one App claims the same immutable Project identity',
      );
    }
    app = projectApps[0] || null;
    restartFullstackApp = app?.deployType === 'fullstack'
      && app.processStatus !== 'stopped'
      && app.processStatus !== 'error'
      && Boolean(app.port);

    const renameActorIds = Array.from(new Set([
      ...actorsBeforeRenameBarrier,
      ...await listProjectLifecycleActorIds({
        projectIdentityId: projectIdentity.id,
        workspaceOwnerId: ownerId,
        authenticatedActorId: req.user!.userId,
      }),
    ]));
    await assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId);
    await markProjectIdentityRenameCleanupStarted({
      projectIdentityId: projectIdentity.id,
      leaseToken: renameGrant.leaseToken,
    });
    await assertLegacyOpenClawProjectMigrationInactive(requestedProjectIdentityId);
    for (const actorUserId of renameActorIds) {
      if (actorUserId === ownerId) {
        await migrateLegacyProjectChatState({
          actorUserId,
          legacyProjectId: req.params.name,
          immutableProjectId: projectIdentity.id,
        });
      }
      await quiesceProjectChatBrokerCallbacksForDestructiveReset({
        actorUserId,
        projectIdentityId: projectIdentity.id,
      });
    }

    // RENAMING is a durable project-wide admission barrier. With that row
    // closed, the deletion-grade cleanup adapters can abort any admitted turn
    // and retire every UUID/root-attested provider resource without consulting
    // current OAuth or model readiness. The Portal transcript remains in DB.
    await cleanupProjectRuntime({
      authenticatedActorId: req.user!.userId,
      workspaceOwnerId: ownerId,
      projectIdentity: renameGrant.identity,
      lifecycleReason: 'rename',
    }, {
      adapters: PROJECT_RUNTIME_CLEANUP_ADAPTERS,
      egressAdapter: PROJECT_EGRESS_CLEANUP_ADAPTER,
    });

    await retireLegacyOpenClawRuntimesForProject({
      actorUserIds: renameActorIds,
      projectIdentityId: projectIdentity.id,
      legacyProjectName: req.params.name,
      legacyProjectOwnerId: ownerId,
      targetCanonicalRoot: projectIdentity.canonicalRoot,
      preserveTranscriptFiles: true,
    });

    // Portal app/build/git workloads are outside provider adapters but can
    // still retain the old root or deployment identity. Prove them stopped
    // before the durable cleanup marker, so crash recovery never reopens a
    // half-renamed project with a live old-path app.
    await removePortalProjectWorkloadsForProject(projectIdentity.id);
    if (app?.deployType === 'fullstack') {
      await forgetAppRuntime(app.id, oldDeployId, {
        actorId: ownerId,
        projectId: projectIdentity.id,
        deployPath: app.zipPath,
        port: app.port,
      }, { settleStatus: 'stopped' });
    }
    await stopProjectDesktopRuntimesForLifecycle({
      workspaceOwnerId: ownerId,
      projectIdentityId: projectIdentity.id,
      projectName: req.params.name,
    });

    // Reset provider bindings before moving the inode. This transaction is the
    // crash-recovery marker: once present, no old-root session identity remains
    // and a later qualified provider can rehydrate from the preserved shared
    // transcript with a freshly computed root/policy fingerprint.
    await prisma.$transaction(async (transaction) => {
      const projectRows = {
        OR: [
          { projectId: projectIdentity.id },
          { userId: ownerId, projectId: req.params.name },
        ],
      };
      await transaction.projectChatProviderBinding.deleteMany({
        where: projectRows,
      });
      await transaction.projectChatSession.deleteMany({
        where: projectRows,
      });
      const activeState = await transaction.projectChatState.findFirst({
        where: { projectIdentityId: projectIdentity.id, activeTurnId: { not: null } },
        select: { id: true },
      });
      if (activeState) {
        throw new ProjectIdentityLifecycleError(
          'Project rename still has an active Project Chat turn after runtime cleanup',
        );
      }
      await transaction.projectChatState.updateMany({
        where: { projectIdentityId: projectIdentity.id, activeTurnId: null },
        data: { version: { increment: 1 } },
      });
      await markProjectIdentityRenameRuntimeCleaned({
        projectIdentityId: projectIdentity.id,
        leaseToken: renameGrant!.leaseToken,
      }, transaction as unknown as ProjectIdentityDatabase);
    });
    runtimeCleanupCommitted = true;

    for (const provider of QUALIFIABLE_PROJECT_PROVIDERS) {
      removeProjectQualificationEvidenceForProject(provider, projectIdentity.id);
    }

    await stopLeaseHeartbeat(true);

    // Rename deployment state and retarget the durable App row atomically from
    // the Portal's perspective. The workload identity itself remains the
    // immutable ProjectIdentity UUID + App UUID, never the mutable name.
    if (!deployPathMoved && oldDeployAttestation) {
      moveAttestedDirectoryNoReplace({
        sourceRoot: oldDeployPath,
        targetRoot: newDeployPath,
        expectedIdentity: oldDeployAttestation,
      });
      deployPathMoved = true;
    } else if (!deployPathMoved && managedPathExists(oldDeployPath)) {
      throw new ProjectIdentityLifecycleError(
        'A deployment directory appeared after Project rename started',
      );
    }
    moveAttestedDirectoryNoReplace({
      sourceRoot: oldDir,
      targetRoot: newDir,
      expectedIdentity: projectIdentity,
    });
    projectPathMoved = true;
    convergeInterruptedProjectDeployment({
      mode: 'complete',
      identity: projectIdentity,
      oldDeployPath,
      newDeployPath,
    });

    const renamedIdentity = await prisma.$transaction(async (transaction) => {
      const committedIdentity = await renameProjectIdentity({
        workspaceOwnerId: ownerId,
        oldProjectName: req.params.name,
        newProjectName: sanitized,
        newProjectRoot: newDir,
        leaseToken: renameGrant!.leaseToken,
      }, transaction as unknown as ProjectIdentityDatabase);
      await retargetProjectAppsForRename(transaction, {
        workspaceOwnerId: ownerId,
        projectIdentityId: projectIdentity.id,
        oldProjectName: req.params.name,
        newProjectName: sanitized,
        oldDeployPath,
        newDeployPath,
      });
      return committedIdentity;
    });
    if (app) {
      app = {
        ...app,
        name: sanitized,
        processStatus: 'stopped',
        zipPath: app.deployType === 'runtime'
          ? buildProjectDesktopRuntimeIdentity(projectIdentity.id, sanitized).runtimeDir
          : app.zipPath === oldDeployPath ? newDeployPath : app.zipPath,
      };
    }
    identityCommitted = true;

    let runtimeWarning: string | null = null;
    if (app) {
      if (restartFullstackApp && app.port) {
        try {
          await startApp(app.id, newDeployId, newDeployPath, app.port, {
            actorId: ownerId,
            projectId: projectIdentity.id,
            projectGeneration: renamedIdentity.generation,
            appName: sanitized,
            lifecycleLock: requireHeldRenameLifecycleLock(sanitized),
          });
        } catch {
          await prisma.app.update({ where: { id: app.id }, data: { processStatus: 'error' } });
          runtimeWarning = 'The project was renamed, but its app runtime needs to be started again.';
        }
      }
    }

    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_RENAME',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: { oldName: req.params.name, newName: sanitized },
      },
    }).catch((activityError) => {
      console.warn('[Project Rename] Failed to record activity:', activityError);
    });

    if (
      renamedIdentity.id !== requestedProjectIdentityId
      || renamedIdentity.generation !== requestedProjectGeneration + 1
    ) {
      throw new ProjectIdentityLifecycleError(
        'Project rename committed without the expected immutable identity generation',
      );
    }
    res.json({
      name: sanitized,
      attemptId,
      status: 'committed',
      identity: serializeProjectIdentityProof(renamedIdentity),
      ...(runtimeWarning ? { warning: runtimeWarning } : {}),
    });
  } catch (error: any) {
    if (error instanceof ProjectMoveRequiredError) {
      sendProjectRenameNotAdmitted(res, 409, attemptId, error.code, error.message);
      return;
    }
    logProjectLifecycleDecision({
      route: 'project-rename',
      code: String(error?.code || error?.name || 'UNKNOWN'),
      status: 0,
      workspaceOwnerId: ownerId || undefined,
      projectName: req.params.name,
      projectIdentityId: requestedProjectIdentityId || null,
      detail: String(error?.message || error).slice(0, 300),
    });
    if (renameLeaseTimer) clearInterval(renameLeaseTimer);
    renameLeaseTimer = null;
    await renameLeaseRenewal.catch(() => undefined);

    let rollbackAuthorized = false;
    if (!identityCommitted && renameGrant && runtimeCleanupCommitted) {
      try {
        const currentIdentity = await prisma.projectIdentity.findUnique({
          where: { id: renameGrant.identity.id },
        });
        if (
          currentIdentity?.lifecycleStatus === 'ACTIVE'
          && currentIdentity.projectName === targetProjectName
          && currentIdentity.lastRenameSourceName === req.params.name
        ) {
          const completed = await readCompletedProjectIdentityRename({
            workspaceOwnerId: ownerId,
            oldProjectName: req.params.name,
            newProjectName: targetProjectName,
            newProjectRoot: newDir,
          });
          if (
            !completed
            || completed.id !== renameGrant.identity.id
            || completed.id !== requestedProjectIdentityId
            || completed.generation !== requestedProjectGeneration + 1
          ) {
            throw new ProjectIdentityLifecycleError(
              'Project rename commit receipt could not be verified',
            );
          }
          convergeInterruptedProjectDeployment({
            mode: 'complete',
            identity: renameGrant.identity,
            oldDeployPath,
            newDeployPath,
          });
          identityCommitted = true;
          res.json({
            name: targetProjectName,
            attemptId,
            status: 'committed',
            identity: serializeProjectIdentityProof(completed),
            recovered: true,
            warning: 'The rename committed, but its original response was interrupted.',
          });
          return;
        }
        rollbackAuthorized = currentIdentity?.lifecycleStatus === 'RENAMING'
          && currentIdentity.renameLeaseTokenHash === renameGrant.identity.renameLeaseTokenHash;
      } catch (commitProbeError) {
        console.error('[Project Rename] Commit outcome could not be verified:', commitProbeError);
      }
    }

    if (!identityCommitted && renameGrant && runtimeCleanupCommitted && rollbackAuthorized) {
      let filesystemRolledBack = true;
      try {
        if (projectPathMoved) {
          if (!managedPathExists(newDir) || managedPathExists(oldDir)) {
            throw new ProjectIdentityLifecycleError(
              'Project root changed before rename rollback',
            );
          }
          moveAttestedDirectoryNoReplace({
            sourceRoot: newDir,
            targetRoot: oldDir,
            expectedIdentity: renameGrant.identity,
          });
          projectPathMoved = false;
        }
        convergeInterruptedProjectDeployment({
          mode: 'cancel',
          identity: renameGrant.identity,
          oldDeployPath,
          newDeployPath,
        });
        deployPathMoved = false;
      } catch (rollbackError) {
        filesystemRolledBack = false;
        console.error('[Project Rename] Filesystem rollback failed:', rollbackError);
      }
      if (
        filesystemRolledBack
        && !projectPathMoved
        && !deployPathMoved
        && managedPathExists(oldDir)
        && !managedPathExists(newDir)
      ) {
        try {
          await prisma.$transaction(async (transaction) => {
            await cancelProjectIdentityRename({
              projectIdentityId: renameGrant!.identity.id,
              leaseToken: renameGrant!.leaseToken,
              oldProjectRoot: oldDir,
            }, transaction as unknown as ProjectIdentityDatabase);
            await transaction.app.updateMany({
              where: projectAppAssociationWhere({
                workspaceOwnerId: ownerId,
                projectIdentityId: renameGrant!.identity.id,
                projectName: req.params.name,
                deployPath: oldDeployPath,
              }),
              data: { processStatus: 'stopped' },
            });
          });
          if (restartFullstackApp && app?.port) {
            await startApp(app.id, oldDeployId, oldDeployPath, app.port, {
              actorId: app.userId,
              projectId: renameGrant.identity.id,
              projectGeneration: renameGrant.identity.generation,
              appName: req.params.name,
              lifecycleLock: requireHeldRenameLifecycleLock(req.params.name),
            });
          }
        } catch (rollbackError) {
          console.error('[Project Rename] Durable rollback failed:', rollbackError);
        }
      }
    }

    if (error instanceof ProjectChatDestructiveResetActiveError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: true,
      });
      return;
    }
    if (error instanceof ProjectExternalRuntimeLifecycleError) {
      res.status(409).json(projectExternalRuntimeConflict(error));
      return;
    }
    if (error instanceof ProjectInvalidRuntimeBindingError) {
      res.status(503).json(projectInvalidRuntimeBindingConflict(error));
      return;
    }
    if (error instanceof LegacyOpenClawProjectMigrationActiveError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      });
      return;
    }
    if (error instanceof ProjectRuntimeCleanupError) {
      res.status(503).json({
        error: 'Project rename is paused until every Project Chat runtime is proven stopped.',
        code: error.code,
        provider: error.provider,
        retryable: true,
      });
      return;
    }
    if (error instanceof PortalProjectWorkloadError) {
      res.status(503).json({
        error: 'Project rename is paused until Portal-owned app, build, and Git workloads are proven stopped.',
        code: error.code,
        retryable: true,
      });
      return;
    }
    if (error instanceof ProjectIdentityLifecycleError || error?.code === 'P2002') {
      res.status(409).json({
        error: error instanceof ProjectIdentityLifecycleError
          ? error.message
          : 'A Project rename already reserved that name.',
        code: 'PROJECT_RENAME_CONFLICT',
        retryable: true,
      });
      return;
    }
    console.error('[Project Rename] Error:', error);
    res.status(500).json({ error: 'Failed to rename project' });
  } finally {
    if (renameLeaseTimer) clearInterval(renameLeaseTimer);
    await renameLeaseRenewal.catch(() => undefined);
    for (const release of releaseLocks.reverse()) release();
  }
});

// POST /api/projects/:name/check - syntax/compile check for runtime projects
router.post('/:name/check', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });

    let language = 'unknown';
    let checkCommand: { command: string; args: string[] } | null = null;
    let output = '';
    const errors: string[] = [];

    const files = listProjectRootRegularFiles(projectDir);

    // Detect project type and set check command
    if (files.includes('main.py') || files.includes('requirements.txt')) {
      language = 'python';
      // Find all .py files and check them
      const pyFiles = files.filter(f => f.endsWith('.py')).slice(0, PROJECT_DEPENDENCY_SCAN_MAX_FILES);
      if (pyFiles.length > 0) {
        checkCommand = { command: 'python3', args: ['-m', 'py_compile', ...pyFiles] };
      }
    } else if (files.includes('main.cpp') || (files.includes('Makefile') && !files.includes('package.json'))) {
      language = 'cpp';
      const cppFiles = files.filter(f => f.endsWith('.cpp') || f.endsWith('.c')).slice(0, PROJECT_DEPENDENCY_SCAN_MAX_FILES);
      if (cppFiles.length > 0) {
        checkCommand = { command: 'g++', args: ['-fsyntax-only', '-Wall', ...cppFiles] };
      }
    } else if (files.includes('package.json')) {
      language = 'node';
      // Find main JS file
      let mainFile = 'index.js';
      try {
        const pkg = readProjectPackageJson(projectDir);
        if (typeof pkg?.main === 'string'
          && pkg.main.length <= 240
          && path.posix.basename(pkg.main) === pkg.main
          && !pkg.main.includes('\\')) {
          mainFile = pkg.main;
        }
      } catch {}
      if (files.includes(mainFile)) {
        checkCommand = { command: 'node', args: ['--check', mainFile] };
      }
    } else if (files.includes('index.html')) {
      language = 'html';
      // HTML doesn't need compile check
      res.json({ ok: true, language: 'html', output: 'HTML files do not require syntax checking.', errors: [] });
      return;
    }

    if (!checkCommand) {
      res.json({ ok: true, language, output: 'No checkable files found.', errors: [] });
      return;
    }

    const checkWorkspace = createProjectLifecycleWorkspace(projectDir);
    try {
      output = await runProjectLifecycleCommand({
        actorId: req.user!.userId,
        projectId: projectIdentity.id,
        workspace: checkWorkspace.path,
        command: checkCommand.command,
        args: checkCommand.args,
        timeoutMs: 30_000,
        nameHint: `${ownerId}:${req.params.name}:syntax-check`,
      });
      // If we get here without error, syntax check passed
      res.json({ ok: true, language, output: output || 'No syntax errors found.', errors: [] });
    } catch (e: any) {
      // Command failed - parse stderr for error messages
      const errorOutput = e.stderr?.toString() || e.stdout?.toString() || e.message || 'Unknown error';
      
      // Parse error lines
      const lines = errorOutput.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        if (line.includes('error') || line.includes('Error') || line.includes('SyntaxError') || line.includes('warning')) {
          errors.push(line.trim());
        }
      }
      
      if (errors.length === 0 && errorOutput.trim()) {
        errors.push(errorOutput.trim());
      }
      
      res.json({ ok: false, language, output: errorOutput, errors });
    } finally {
      checkWorkspace.cleanup();
    }
  } catch (error: any) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Failed to check project', detail: error.message });
  }
});

// ─── Dependency Detection & Installation ─────────────────────────────────────

// Common Python module → pip package mappings
const COMMON_PIP_MAPPINGS: Record<string, string> = {
  'cv2': 'opencv-python',
  'PIL': 'Pillow',
  'sklearn': 'scikit-learn',
  'skimage': 'scikit-image',
  'yaml': 'pyyaml',
  'bs4': 'beautifulsoup4',
  'dotenv': 'python-dotenv',
  'jwt': 'pyjwt',
  'serial': 'pyserial',
  'usb': 'pyusb',
  'dateutil': 'python-dateutil',
  'magic': 'python-magic',
  'gi': 'pygobject',
  'MySQLdb': 'mysqlclient',
  'psycopg2': 'psycopg2-binary',
  'cv': 'opencv-python',
  'faiss': 'faiss-cpu',
  'telegram': 'python-telegram-bot',
  'discord': 'discord.py',
  'aiohttp': 'aiohttp',
  'websockets': 'websockets',
  'pygame': 'pygame',
  'numpy': 'numpy',
  'pandas': 'pandas',
  'matplotlib': 'matplotlib',
  'seaborn': 'seaborn',
  'requests': 'requests',
  'flask': 'flask',
  'django': 'django',
  'fastapi': 'fastapi',
  'uvicorn': 'uvicorn',
  'sqlalchemy': 'sqlalchemy',
  'transformers': 'transformers',
  'torch': 'torch',
  'tensorflow': 'tensorflow',
  'keras': 'keras',
  'scipy': 'scipy',
  'nltk': 'nltk',
  'spacy': 'spacy',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'langchain': 'langchain',
  'gradio': 'gradio',
  'streamlit': 'streamlit',
  'plotly': 'plotly',
  'bokeh': 'bokeh',
  'httpx': 'httpx',
  'pydantic': 'pydantic',
  'cryptography': 'cryptography',
  'bcrypt': 'bcrypt',
  'redis': 'redis',
  'celery': 'celery',
  'boto3': 'boto3',
  'google': 'google-cloud-core',
};

// Common C++ includes → apt package mappings
const COMMON_APT_MAPPINGS: Record<string, string> = {
  'SDL2/SDL.h': 'libsdl2-dev',
  'SDL.h': 'libsdl2-dev',
  'SDL2/SDL_image.h': 'libsdl2-image-dev',
  'SDL2/SDL_ttf.h': 'libsdl2-ttf-dev',
  'SDL2/SDL_mixer.h': 'libsdl2-mixer-dev',
  'ncurses.h': 'libncurses-dev',
  'curses.h': 'libncurses-dev',
  'GL/gl.h': 'libgl1-mesa-dev',
  'GL/glut.h': 'freeglut3-dev',
  'GLFW/glfw3.h': 'libglfw3-dev',
  'opencv2/opencv.hpp': 'libopencv-dev',
  'opencv2/core.hpp': 'libopencv-dev',
  'boost/': 'libboost-all-dev',
  'pthread.h': 'libc6-dev',
  'curl/curl.h': 'libcurl4-openssl-dev',
  'openssl/ssl.h': 'libssl-dev',
  'sqlite3.h': 'libsqlite3-dev',
  'mysql/mysql.h': 'libmysqlclient-dev',
  'pq-fe.h': 'libpq-dev',
  'json/json.h': 'libjsoncpp-dev',
  'zlib.h': 'zlib1g-dev',
  'png.h': 'libpng-dev',
  'jpeglib.h': 'libjpeg-dev',
  'portaudio.h': 'portaudio19-dev',
};

// Standard library modules that don't need installation
const PYTHON_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'time', 'datetime', 'math', 'random', 'collections',
  'itertools', 'functools', 'pathlib', 'typing', 'dataclasses', 'enum', 'abc',
  'io', 'struct', 'copy', 'pickle', 'shelve', 'csv', 'configparser', 'argparse',
  'logging', 'warnings', 'traceback', 'unittest', 'doctest', 'pdb', 'profile',
  'timeit', 'threading', 'multiprocessing', 'subprocess', 'socket', 'http',
  'urllib', 'email', 'html', 'xml', 'hashlib', 'hmac', 'base64', 'binascii',
  'codecs', 'unicodedata', 'locale', 'gettext', 'textwrap', 'difflib', 'ast',
  'dis', 'inspect', 'importlib', 'pkgutil', 'modulefinder', 'platform', 'errno',
  'ctypes', 'contextlib', 'decimal', 'fractions', 'statistics', 'cmath', 'array',
  'bisect', 'heapq', 'queue', 'weakref', 'types', 'operator', 'string', 'shutil',
  'glob', 'fnmatch', 'linecache', 'tempfile', 'gzip', 'bz2', 'lzma', 'zipfile',
  'tarfile', 'getpass', 'netrc', 'pty', 'tty', 'termios', 'curses', 'select',
  'selectors', 'asyncio', 'concurrent', 'sched', 'signal', 'mmap', 'readline',
  'rlcompleter', 'code', 'codeop', 'zipimport', 'runpy', 'token', 'keyword',
  'tokenize', 'tabnanny', 'pyclbr', 'formatter', 'ssl', 'ftplib', 'poplib',
  'imaplib', 'smtplib', 'uuid', 'socketserver', 'xmlrpc', 'ipaddress', 'cgi',
  'cgitb', 'wsgiref', 'webbrowser', 'turtle', 'cmd', 'pprint', '__future__',
  'builtins', '_thread', 'gc', 'site', 'secrets', 'graphlib', 'zoneinfo',
]);

// Standard C++ headers that don't need apt packages
const CPP_STDLIB = new Set([
  'iostream', 'fstream', 'sstream', 'string', 'vector', 'map', 'set', 'list',
  'queue', 'stack', 'deque', 'array', 'unordered_map', 'unordered_set', 'algorithm',
  'cmath', 'cstdlib', 'cstdio', 'cstring', 'ctime', 'cctype', 'climits', 'cfloat',
  'cassert', 'cerrno', 'clocale', 'csignal', 'csetjmp', 'cstdarg', 'cstddef',
  'memory', 'functional', 'utility', 'tuple', 'type_traits', 'chrono', 'thread',
  'mutex', 'condition_variable', 'future', 'atomic', 'random', 'regex', 'iterator',
  'stdexcept', 'exception', 'limits', 'numeric', 'iomanip', 'bitset', 'complex',
  'valarray', 'ratio', 'initializer_list', 'any', 'optional', 'variant', 'filesystem',
  'span', 'ranges', 'concepts', 'coroutine', 'source_location', 'compare', 'version',
  'new', 'typeinfo', 'typeindex', 'format', 'charconv', 'bit', 'numbers',
  'stdio.h', 'stdlib.h', 'string.h', 'math.h', 'time.h', 'ctype.h', 'limits.h',
  'float.h', 'assert.h', 'errno.h', 'locale.h', 'signal.h', 'setjmp.h', 'stdarg.h',
  'stddef.h', 'stdint.h', 'inttypes.h', 'stdbool.h', 'stdnoreturn.h',
]);

interface DependencyCheckResult {
  needsInstall: boolean;
  language: 'python' | 'cpp' | 'node' | null;
  packages: string[];
  installedPackages?: string[];
  command?: string;
}

const PROJECT_DEPENDENCY_SCAN_MAX_FILES = 200;
const PROJECT_DEPENDENCY_SCAN_MAX_FILE_BYTES = 256 * 1024;
const PROJECT_DEPENDENCY_MAX_PACKAGES = 256;

async function detectDependencies(projectDir: string): Promise<DependencyCheckResult> {
  const files = listProjectRootRegularFiles(projectDir);
  
  // Check for Python project
  if (files.some(f => f.endsWith('.py')) || files.includes('requirements.txt')) {
    return await detectPythonDeps(projectDir, files);
  }
  
  // Check for C++ project
  if (files.some(f => f.endsWith('.cpp') || f.endsWith('.c') || f.endsWith('.h') || f.endsWith('.hpp'))) {
    return detectCppDeps(projectDir, files);
  }
  
  // Check for Node.js project
  if (files.includes('package.json')) {
    return detectNodeDeps(projectDir);
  }
  
  return { needsInstall: false, language: null, packages: [] };
}

async function detectPythonDeps(projectDir: string, files: string[]): Promise<DependencyCheckResult> {
  const requiredPackages = new Set<string>();
  
  // Check requirements.txt first
  const requirements = readProjectTextFile(projectDir, 'requirements.txt', {
    optional: true,
    maxBytes: PROJECT_METADATA_MAX_BYTES,
  });
  if (requirements !== null) {
    const content = requirements;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
        // Extract package name (before ==, >=, <=, ~=, etc.)
        const pkgName = trimmed.split(/[=<>~!]/)[0].trim().toLowerCase();
        if (pkgName && pkgName.length <= 200) requiredPackages.add(pkgName);
        if (requiredPackages.size > PROJECT_DEPENDENCY_MAX_PACKAGES) {
          throw new ProjectFilePolicyError('TOO_LARGE', 'requirements.txt declares too many packages');
        }
      }
    }
  } else {
    // Scan Python files for imports
    for (const file of files.filter((name) => name.endsWith('.py')).slice(0, PROJECT_DEPENDENCY_SCAN_MAX_FILES)) {
      if (!file.endsWith('.py')) continue;
      try {
        const content = readProjectTextFile(projectDir, file, {
          maxBytes: PROJECT_DEPENDENCY_SCAN_MAX_FILE_BYTES,
        }) || '';
        // Match: import X, from X import Y
        const importRegex = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const module = match[1];
          if (!PYTHON_STDLIB.has(module)) {
            // Map to pip package name
            const pipPkg = COMMON_PIP_MAPPINGS[module] || module.toLowerCase();
            requiredPackages.add(pipPkg);
            if (requiredPackages.size > PROJECT_DEPENDENCY_MAX_PACKAGES) {
              throw new ProjectFilePolicyError('TOO_LARGE', 'Project imports too many dependency candidates');
            }
          }
        }
      } catch (error) {
        if (error instanceof ProjectFilePolicyError) throw error;
        // Ignore transient read errors; containment/policy errors fail closed.
      }
    }
  }
  
  if (requiredPackages.size === 0) {
    return { needsInstall: false, language: 'python', packages: [] };
  }
  
  // Never execute a project-owned .venv/bin/pip to inspect dependencies: that
  // path is user-controlled and can itself be a malicious script. The route's
  // dependency hash marker is the trusted installation cache; without a valid
  // marker, reinstall all declared packages inside the project container.
  const installedPackages: string[] = [];
  const missingPackages = Array.from(requiredPackages);
  
  return {
    needsInstall: missingPackages.length > 0,
    language: 'python',
    packages: missingPackages,
    installedPackages,
    command: missingPackages.length > 0 ? `pip install ${missingPackages.join(' ')}` : undefined,
  };
}

function detectCppDeps(projectDir: string, files: string[]): DependencyCheckResult {
  const requiredPackages = new Set<string>();
  
  // Check if g++ is installed
  try {
    execSync('which g++', { encoding: 'utf-8' });
  } catch {
    requiredPackages.add('g++');
  }
  
  // Scan C++ files for includes
  for (const file of files
    .filter((name) => /\.(?:cpp|c|h|hpp)$/.test(name))
    .slice(0, PROJECT_DEPENDENCY_SCAN_MAX_FILES)) {
    if (!file.endsWith('.cpp') && !file.endsWith('.c') && !file.endsWith('.h') && !file.endsWith('.hpp')) continue;
    try {
      const content = readProjectTextFile(projectDir, file, {
        maxBytes: PROJECT_DEPENDENCY_SCAN_MAX_FILE_BYTES,
      }) || '';
      // Match: #include <...> or #include "..."
      const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
      let match;
      while ((match = includeRegex.exec(content)) !== null) {
        const header = match[1];
        // Check if it's a standard header
        const baseName = path.basename(header);
        if (!CPP_STDLIB.has(header) && !CPP_STDLIB.has(baseName)) {
          // Try to map to apt package
          for (const [pattern, pkg] of Object.entries(COMMON_APT_MAPPINGS)) {
            if (header.startsWith(pattern) || header === pattern) {
              requiredPackages.add(pkg);
              break;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof ProjectFilePolicyError) throw error;
      // Ignore transient read errors; containment/policy errors fail closed.
    }
  }
  
  if (requiredPackages.size === 0) {
    return { needsInstall: false, language: 'cpp', packages: [] };
  }
  
  const packages = Array.from(requiredPackages);
  return {
    needsInstall: true,
    language: 'cpp',
    packages,
    command: 'System package installation is disabled in the project sandbox',
  };
}

function detectNodeDeps(projectDir: string): DependencyCheckResult {
  if (readProjectTextFile(projectDir, 'package.json', {
    optional: true,
    maxBytes: PROJECT_METADATA_MAX_BYTES,
  }) === null) {
    return { needsInstall: false, language: 'node', packages: [] };
  }
  
  const nodeModulesPath = path.join(projectDir, 'node_modules');
  
  // Check if node_modules exists
  let nodeModulesIsDirectory = false;
  try {
    const nodeModulesEntry = fs.lstatSync(nodeModulesPath);
    nodeModulesIsDirectory = !nodeModulesEntry.isSymbolicLink() && nodeModulesEntry.isDirectory();
  } catch {}
  if (!nodeModulesIsDirectory) {
    return {
      needsInstall: true,
      language: 'node',
      packages: ['(npm install)'],
      command: 'npm install',
    };
  }
  
  // Check if package-lock.json is newer than node_modules
  const lockStat = statProjectRegularFile(projectDir, 'package-lock.json', {
    optional: true,
  });
  if (lockStat !== null) {
    const nmStat = fs.lstatSync(nodeModulesPath);
    if (lockStat.mtimeMs > nmStat.mtimeMs) {
      return {
        needsInstall: true,
        language: 'node',
        packages: ['(npm install - lock file updated)'],
        command: 'npm install',
      };
    }
  }
  
  return { needsInstall: false, language: 'node', packages: [] };
}

// Hash dependencies for caching
function hashDependencies(packages: string[]): string {
  const sorted = [...packages].sort().join(',');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

// Check if dependencies are already installed (cached)
function checkDepsCache(projectDir: string, packages: string[]): boolean {
  try {
    const cached = readProjectTextFile(projectDir, '.deps-installed', {
      optional: true,
      maxBytes: 256,
    })?.trim();
    if (!cached) return false;
    const currentHash = hashDependencies(packages);
    return cached === currentHash;
  } catch {
    return false;
  }
}

// Write deps cache marker
function writeDepsCache(projectDir: string, packages: string[]): void {
  const hash = hashDependencies(packages);
  writeProjectRuntimeTextFile(projectDir, '.deps-installed', hash, 256);
}

const projectDependencyRepairMutationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 12,
  keyGenerator: (req) => req.user?.userId || 'unauthenticated',
  message: {
    error: 'Too many dependency repair requests. Wait before retrying.',
    code: 'PROJECT_DEPENDENCY_REPAIR_RATE_LIMITED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const projectDependencyRepairStatusLimiter = rateLimit({
  windowMs: 60 * 60_000,
  // The bounded client reconciliation loop permits up to 180 reads.
  max: 240,
  keyGenerator: (req) => req.user?.userId || 'unauthenticated',
  message: {
    error: 'Too many dependency repair status checks. Wait before retrying.',
    code: 'PROJECT_DEPENDENCY_REPAIR_STATUS_RATE_LIMITED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

type DependencyRepairStartupHandoffState = {
  terminalHandoffTimer: NodeJS.Timeout | null;
  restartRequired: boolean;
};

type ActiveDependencyRepairFence = DependencyRepairStartupHandoffState & {
  fence: ProjectDependencyPromotionWriterFence;
  running: Promise<void> | null;
  retryTimer: NodeJS.Timeout | null;
  retryAttempts: number;
  backupLease: BackupMutationLockLease;
  releaseBackupLease(): Promise<void>;
};

type PreGoDependencyRepairHandoff = DependencyRepairStartupHandoffState & {
  fence: ProjectDependencyPromotionWriterFence;
  backupLease: BackupMutationLockLease;
  releaseBackupLease(): Promise<void>;
};

const activeDependencyRepairFences = new Map<string, ActiveDependencyRepairFence>();
const preGoDependencyRepairHandoffs = new Map<string, PreGoDependencyRepairHandoff>();
const PROJECT_DEPENDENCY_REPAIR_MAX_LIVE_RETRIES = 6;
let dependencyRepairTerminateProcess: (pid: number, signal: NodeJS.Signals) => void = (
  pid,
  signal,
) => { process.kill(pid, signal); };

function scheduleProjectDependencyRepairStartupHandoff(
  fenceState: DependencyRepairStartupHandoffState,
  reason: string,
): void {
  fenceState.restartRequired = true;
  if (fenceState.terminalHandoffTimer) return;
  console.error(`[Projects] Owner dependency repair requires startup reconciliation: ${reason}`);
  fenceState.terminalHandoffTimer = setTimeout(() => {
    fenceState.terminalHandoffTimer = null;
    try {
      dependencyRepairTerminateProcess(process.pid, 'SIGTERM');
    } catch (error) {
      console.error('[Projects] Owner dependency repair could not request startup reconciliation:',
        error instanceof Error ? error.message : 'unknown error');
    }
  }, 1_000);
  fenceState.terminalHandoffTimer.unref?.();
}

function scheduleProjectDependencyRepairStartupHandoffAfterResponse(
  res: Response,
  handoff: DependencyRepairStartupHandoffState,
  reason: string,
): void {
  handoff.restartRequired = true;
  let scheduled = false;
  const afterFlush = () => {
    if (scheduled) return;
    scheduled = true;
    res.removeListener('finish', afterFlush);
    res.removeListener('close', afterFlush);
    scheduleProjectDependencyRepairStartupHandoff(handoff, reason);
  };
  res.once('finish', afterFlush);
  res.once('close', afterFlush);
  // A client can disconnect while the long admission drain is still running.
  // In that case `close` may have fired before this handoff exists and
  // `writableFinished` remains false forever. Treat the already-destroyed
  // transport as flushed for startup-handoff purposes.
  if (res.writableFinished || res.destroyed) afterFlush();
}

function dependencyRepairConfirmation(projectName: string): string {
  return `FORCE FORWARD ${projectName}`;
}

async function dependencyRepairBackupAfter(quarantinedAt: Date) {
  return inspectMaintenanceBackupAdmission({ createdAfterMs: quarantinedAt.getTime() });
}

function dependencyRepairBackupFingerprint(backup: NonNullable<Awaited<ReturnType<
  typeof inspectMaintenanceBackupAdmission
>>['backup']>) {
  return normalizeProjectDependencyRepairBackup({
    path: backup.path,
    filename: backup.filename,
    device: backup.device,
    inode: backup.inode,
    size: String(backup.size),
    mtimeNs: backup.mtimeNs,
    receiptDigest: backup.receiptDigest,
    fingerprintDigest: backup.fingerprintDigest,
  });
}

async function reverifyDependencyRepairBackup(
  record: Pick<ProjectDependencyRepairRecord, 'backup'>,
): Promise<boolean> {
  if (!attestProjectDependencyRepairBackupFingerprint(record.backup)) return false;
  const mtimeMs = Number(BigInt(record.backup.mtimeNs) / 1_000_000n);
  const candidate: MaintenanceBackupCandidate = {
    filename: record.backup.filename,
    fullPath: record.backup.path,
    size: Number(record.backup.size),
    mtimeMs,
    mtimeNs: record.backup.mtimeNs,
    dev: record.backup.device,
    ino: record.backup.inode,
    type: 'comprehensive',
    completeness: 'complete',
    degradedComponents: [],
    classificationAuthenticated: true,
  };
  return verifyMaintenanceBackupArchive(candidate);
}

async function quiesceExactProjectForDependencyRepair(input: {
  actorUserId: string;
  ownerId: string;
  projectIdentity: ProjectIdentityRecord;
}): Promise<void> {
  const actorIds = Array.from(new Set([
    input.actorUserId,
    input.ownerId,
    ...await listProjectLifecycleActorIds({
      projectIdentityId: input.projectIdentity.id,
      workspaceOwnerId: input.ownerId,
      authenticatedActorId: input.actorUserId,
    }),
  ]));
  for (const actorUserId of actorIds) {
    await quiesceProjectChatBrokerCallbacksForDestructiveReset({
      actorUserId,
      projectIdentityId: input.projectIdentity.id,
    });
  }
  await cleanupProjectRuntime({
    authenticatedActorId: input.actorUserId,
    workspaceOwnerId: input.ownerId,
    projectIdentity: input.projectIdentity,
    lifecycleReason: 'dependency_repair',
  }, {
    adapters: PROJECT_RUNTIME_CLEANUP_ADAPTERS,
    egressAdapter: PROJECT_EGRESS_CLEANUP_ADAPTER,
  });
  await retireLegacyOpenClawRuntimesForProject({
    actorUserIds: actorIds,
    projectIdentityId: input.projectIdentity.id,
    legacyProjectName: input.projectIdentity.projectName,
    legacyProjectOwnerId: input.ownerId,
    targetCanonicalRoot: input.projectIdentity.canonicalRoot,
    preserveTranscriptFiles: true,
  });
  await removePortalProjectWorkloadsForProject(input.projectIdentity.id);
  const deployId = `${input.ownerId}-${input.projectIdentity.projectName}`;
  const deployPath = path.join(DEPLOY_DIR, deployId);
  const app = await findProjectAppForIdentity({
    workspaceOwnerId: input.ownerId,
    projectIdentityId: input.projectIdentity.id,
    projectName: input.projectIdentity.projectName,
    deployPath,
  });
  assertProjectRuntimeLifecycleMutable(app, 'repair-project-dependencies');
  if (app?.deployType === 'fullstack') {
    await forgetAppRuntime(app.id, deployId, {
      actorId: input.ownerId,
      projectId: input.projectIdentity.id,
      deployPath: app.zipPath,
      port: app.port,
    }, { settleStatus: 'stopped' });
  } else {
    await stopApp(deployId);
  }
  await stopProjectDesktopRuntimesForLifecycle({
    workspaceOwnerId: input.ownerId,
    projectIdentityId: input.projectIdentity.id,
    projectName: input.projectIdentity.projectName,
  });
}

function projectDependencyRepairResponse(input: {
  state: 'QUARANTINED' | 'PROMOTING' | 'COMPLETE' | 'NOT_QUARANTINED' | 'UNAVAILABLE';
  projectName: string;
  lifecycle: any | null;
  decision: Awaited<ReturnType<typeof inspectProjectDependencyRepairStatus>>['decision'];
  repair: ProjectDependencyRepairRecord | null;
  backup?: Awaited<ReturnType<typeof inspectMaintenanceBackupAdmission>>;
  backupPinned?: boolean;
  restartRequired?: boolean;
}) {
  const promotion = input.decision ? {
    operationId: input.decision.operationId,
    manifestDigest: input.decision.manifestDigest,
    status: input.decision.status,
  } : input.repair ? {
    operationId: input.repair.promotionOperationId,
    manifestDigest: input.repair.manifestDigest,
    status: input.repair.status,
  } : null;
  const pinnedBackup = input.repair ? {
    filename: input.repair.backup.filename,
    createdAt: new Date(Number(BigInt(input.repair.backup.mtimeNs) / 1_000_000n)).toISOString(),
  } : null;
  return {
    state: input.state,
    ownerOnly: true,
    action: PROJECT_DEPENDENCY_REPAIR_ACTION,
    confirmationPhrase: dependencyRepairConfirmation(input.projectName),
    project: input.lifecycle ? {
      id: String(input.lifecycle.id),
      name: String(input.lifecycle.projectName),
      generation: Number(input.lifecycle.generation),
    } : null,
    promotion,
    repair: input.repair ? {
      repairId: input.repair.repairId,
      status: input.repair.status,
      phase: input.repair.phase,
      startedAt: input.repair.startedAt.toISOString(),
      completedAt: input.repair.completedAt?.toISOString() || null,
    } : null,
    backup: {
      requiredAfter: input.repair?.quarantinedAt
        ? input.repair.quarantinedAt.toISOString()
        : input.lifecycle?.dependencyQuarantinedAt
          ? new Date(input.lifecycle.dependencyQuarantinedAt).toISOString()
        : null,
      // Eligible means a fresh archive just passed admission for a new
      // force-forward. A durable pin is reported separately and never
      // overstates that the archive or retained kernel lease is still usable.
      eligible: Boolean(input.backup?.backup),
      pinned: input.backupPinned === true,
      ...(pinnedBackup || (input.backup?.backup ? {
        filename: input.backup.backup.filename,
        createdAt: input.backup.backup.createdAt,
      } : {})),
    },
    retryable: input.state === 'QUARANTINED' && input.restartRequired !== true,
    statusRetryable: (input.state === 'PROMOTING' || input.state === 'UNAVAILABLE')
      && input.restartRequired !== true,
    restartRequired: input.restartRequired === true,
  };
}

function requireDurableDependencyRepairSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user?.sessionId || !req.user.sessionExpiresAt
    || req.user.sessionExpiresAt.getTime() <= Date.now()) {
    res.status(401).json({
      error: 'A live durable Owner session is required for dependency repair.',
      code: 'AUTH_SESSION_REVOKED',
    });
    return;
  }
  next();
}

function dependencyRepairRuntimeTruth(repair: ProjectDependencyRepairRecord | null): {
  backupPinned: boolean;
  restartRequired: boolean;
} {
  if (!repair) return { backupPinned: false, restartRequired: false };
  const fenceState = activeDependencyRepairFences.get(repair.repairId);
  let leaseHeld = false;
  if (fenceState) {
    try {
      assertBackupMutationLockLease(fenceState.backupLease);
      leaseHeld = true;
    } catch {}
  }
  const backupPinned = attestProjectDependencyRepairBackupFingerprint(repair.backup)
    && attestProjectDependencyRepairBackupLock({
      repairId: repair.repairId,
      backup: repair.backup,
      lock: repair.backupLock,
    });
  const active = repair.status !== 'APPLIED' || repair.phase !== 'COMPLETE';
  return {
    backupPinned,
    restartRequired: active && (!fenceState || !leaseHeld || fenceState.restartRequired),
  };
}

export const __projectDependencyRepairRouteTest = {
  scheduleStartupHandoff: scheduleProjectDependencyRepairStartupHandoff,
  scheduleStartupHandoffAfterResponse: scheduleProjectDependencyRepairStartupHandoffAfterResponse,
  response: projectDependencyRepairResponse,
  requireDurableSession: requireDurableDependencyRepairSession,
  preGoHandoffs: preGoDependencyRepairHandoffs,
  setTerminateProcess(terminate: (pid: number, signal: NodeJS.Signals) => void): void {
    dependencyRepairTerminateProcess = terminate;
  },
  resetTerminateProcess(): void {
    dependencyRepairTerminateProcess = (pid, signal) => { process.kill(pid, signal); };
  },
  resetState(): void {
    for (const state of [
      ...activeDependencyRepairFences.values(),
      ...preGoDependencyRepairHandoffs.values(),
    ]) {
      if (state.terminalHandoffTimer) clearTimeout(state.terminalHandoffTimer);
    }
    for (const state of activeDependencyRepairFences.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
    }
    activeDependencyRepairFences.clear();
    preGoDependencyRepairHandoffs.clear();
  },
};

function scheduleProjectDependencyRepairRetry(input: {
  record: ProjectDependencyRepairRecord;
  fenceState: ActiveDependencyRepairFence;
}): void {
  if (input.fenceState.running || input.fenceState.retryTimer || input.fenceState.restartRequired) return;
  try {
    assertBackupMutationLockLease(input.fenceState.backupLease);
  } catch {
    scheduleProjectDependencyRepairStartupHandoff(
      input.fenceState,
      'the retained backup exclusion lease was lost',
    );
    return;
  }
  if (input.fenceState.retryAttempts >= PROJECT_DEPENDENCY_REPAIR_MAX_LIVE_RETRIES) {
    scheduleProjectDependencyRepairStartupHandoff(
      input.fenceState,
      'bounded live retries were exhausted',
    );
    return;
  }
  input.fenceState.retryAttempts += 1;
  input.fenceState.retryTimer = setTimeout(() => {
    input.fenceState.retryTimer = null;
    void acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(input.record.workspaceOwnerId, input.record.projectName),
    ).then((retryLock) => {
      const started = scheduleProjectDependencyRepair({
        record: input.record,
        lifecycleLock: retryLock,
        fenceState: input.fenceState,
      });
      if (!started) retryLock();
    }).catch((retryError) => {
      console.error('[Projects] Owner dependency repair retry admission failed:',
        retryError instanceof Error ? retryError.message : 'unknown error');
      scheduleProjectDependencyRepairRetry(input);
    });
  }, 5_000);
  input.fenceState.retryTimer.unref?.();
}

function scheduleProjectDependencyRepair(input: {
  record: ProjectDependencyRepairRecord;
  lifecycleLock: ProjectDeletionLockLease;
  fenceState: ActiveDependencyRepairFence;
}): boolean {
  if (input.fenceState.running || input.fenceState.restartRequired) return false;
  if (input.fenceState.retryTimer) {
    clearTimeout(input.fenceState.retryTimer);
    input.fenceState.retryTimer = null;
  }
  input.fenceState.running = (async () => {
    let safelyReleased = false;
    try {
      assertBackupMutationLockLease(input.fenceState.backupLease);
      await executeProjectDependencyForceForward({
        repairId: input.record.repairId,
        lifecycleLock: input.lifecycleLock,
        reverifyBackup: reverifyDependencyRepairBackup,
        assertExclusiveLease: () => assertBackupMutationLockLease(input.fenceState.backupLease),
      });
      assertBackupMutationLockLease(input.fenceState.backupLease);
      const completed = await inspectProjectDependencyRepairStatus({
        workspaceOwnerId: input.record.workspaceOwnerId,
        projectName: input.record.projectName,
      });
      if (!completed.repair || completed.repair.status !== 'APPLIED'
        || completed.repair.phase !== 'COMPLETE') {
        throw new Error('Completed dependency repair receipt is unavailable');
      }
      await input.fenceState.fence.releaseAfterSafeState(async () => {
        const identity = await prisma.projectIdentity.findUnique({
          where: { id: input.record.projectIdentityId },
          select: {
            canonicalRoot: true,
            rootDevice: true,
            rootInode: true,
            rootBirthtimeNs: true,
          },
        });
        if (!identity) throw new Error('Completed dependency repair lost its Project identity');
        await attestProjectDependencyPromotionFenceReleaseState({
          operationId: input.record.promotionOperationId,
          manifestDigest: input.record.manifestDigest,
          projectIdentityId: input.record.projectIdentityId,
          projectIdentityGeneration: input.record.projectIdentityGeneration,
          workspaceOwnerId: input.record.workspaceOwnerId,
          projectName: input.record.projectName,
          destinationCanonicalRoot: identity.canonicalRoot,
          destinationRootDevice: identity.rootDevice,
          destinationRootInode: identity.rootInode,
          destinationRootBirthtimeNs: identity.rootBirthtimeNs,
          expectedState: 'ACTIVE',
        });
        releaseProjectDependencyRepairBackupLock({
          record: completed.repair!,
          lease: input.fenceState.backupLease,
        });
      });
      activeDependencyRepairFences.delete(input.record.repairId);
      if (input.fenceState.terminalHandoffTimer) {
        clearTimeout(input.fenceState.terminalHandoffTimer);
        input.fenceState.terminalHandoffTimer = null;
      }
      input.fenceState.restartRequired = false;
      safelyReleased = true;
      await prisma.activityLog.updateMany({
        where: {
          action: 'PROJECT_DEPENDENCY_REPAIR_REQUESTED',
          resource: 'project',
          resourceId: input.record.repairId,
        },
        data: {
          severity: 'INFO',
          metadata: {
            action: PROJECT_DEPENDENCY_REPAIR_ACTION,
            result: 'completed',
            projectIdentityId: input.record.projectIdentityId,
            projectIdentityGeneration: input.record.projectIdentityGeneration,
            promotionOperationId: input.record.promotionOperationId,
            manifestDigest: input.record.manifestDigest,
          },
        },
      }).catch(() => undefined);
    } catch (error) {
      console.error('[Projects] Owner dependency repair retained containment:',
        error instanceof Error ? error.message : 'unknown error');
      input.fenceState.running = null;
      // A dead kernel-lock holder cannot be retried in-process. Otherwise the
      // retained global fence and ordered kernel locks own bounded self-retry.
      scheduleProjectDependencyRepairRetry({
        record: input.record,
        fenceState: input.fenceState,
      });
      await prisma.activityLog.updateMany({
        where: {
          action: 'PROJECT_DEPENDENCY_REPAIR_REQUESTED',
          resource: 'project',
          resourceId: input.record.repairId,
        },
        data: { severity: 'ERROR' },
      }).catch(() => undefined);
    } finally {
      input.lifecycleLock();
      // Keep the ordered host-operation and backup flocks for a same-process
      // retry while the global writer fence remains held. Releasing them here
      // would let the retry mutate without exclusion and reacquiring after the
      // global fence would invert the installer lock order. Process exit still
      // releases the kernel locks for startup reconciliation.
      if (safelyReleased) await input.fenceState.releaseBackupLease();
    }
  })();
  return true;
}

// GET /api/projects/dependency-repair/active
// Owner-only, bounded discovery intentionally remains outside the global
// workspace fence so a browser reload can reattach to an exact durable repair.
router.get(
  '/dependency-repair/active',
  authenticateToken,
  requireApproved,
  requireOwner,
  requireDurableDependencyRepairSession,
  projectDependencyRepairStatusLimiter,
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const ownerId = await getScopedOwnerId(req);
      const active = await listActiveProjectDependencyRepairsForOwner({
        workspaceOwnerId: ownerId,
        limit: 20,
      });
      const repairs = await Promise.all(active.map(async (record) => {
        const status = await inspectProjectDependencyRepairStatus({
          workspaceOwnerId: ownerId,
          projectName: record.projectName,
        });
        if (!status.repair || status.repair.repairId !== record.repairId
          || status.lifecycle?.lifecycleStatus !== 'DEPENDENCY_PROMOTING') {
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
            'An active dependency repair lost its exact Project binding.',
            503,
          );
        }
        const runtime = dependencyRepairRuntimeTruth(status.repair);
        return projectDependencyRepairResponse({
          state: 'PROMOTING',
          projectName: record.projectName,
          lifecycle: status.lifecycle,
          decision: status.decision,
          repair: status.repair,
          ...runtime,
        });
      }));
      res.status(200).json({ repairs, count: repairs.length, unavailable: false });
    } catch (error) {
      console.error('[Projects] Active dependency repair discovery failed:', error);
      res.status(200).json({ repairs: [], count: 0, unavailable: true });
    }
  },
);

// GET /api/projects/:name/dependency-repair/status
router.get(
  '/:name/dependency-repair/status',
  authenticateToken,
  requireApproved,
  requireOwner,
  requireDurableDependencyRepairSession,
  projectDependencyRepairStatusLimiter,
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const ownerId = await getScopedOwnerId(req);
      const status = await inspectProjectDependencyRepairStatus({
        workspaceOwnerId: ownerId,
        projectName: req.params.name,
      });
      let state: 'QUARANTINED' | 'PROMOTING' | 'COMPLETE' | 'NOT_QUARANTINED' | 'UNAVAILABLE';
      if (status.repair?.status === 'APPLIED' && status.repair.phase === 'COMPLETE') state = 'COMPLETE';
      else if (status.lifecycle?.lifecycleStatus === 'DEPENDENCY_QUARANTINED') state = 'QUARANTINED';
      else if (status.lifecycle?.lifecycleStatus === 'DEPENDENCY_PROMOTING' && status.repair) state = 'PROMOTING';
      else state = 'NOT_QUARANTINED';
      const quarantinedAt = status.lifecycle?.dependencyQuarantinedAt
        ? new Date(status.lifecycle.dependencyQuarantinedAt)
        : null;
      const preGoHandoff = preGoDependencyRepairHandoffs.get(
        projectDeletionLockKey(ownerId, req.params.name),
      );
      const backup = state === 'QUARANTINED' && quarantinedAt && !preGoHandoff
        ? await dependencyRepairBackupAfter(quarantinedAt)
        : undefined;
      const runtime = dependencyRepairRuntimeTruth(status.repair);
      res.status(200).json(projectDependencyRepairResponse({
        state,
        projectName: req.params.name,
        lifecycle: status.lifecycle,
        decision: status.decision,
        repair: status.repair,
        backup,
        ...runtime,
        restartRequired: runtime.restartRequired || Boolean(preGoHandoff?.restartRequired),
      }));
    } catch (error) {
      console.error('[Projects] Dependency repair status failed:', error);
      res.status(200).json(projectDependencyRepairResponse({
        state: 'UNAVAILABLE',
        projectName: req.params.name,
        lifecycle: null,
        decision: null,
        repair: null,
      }));
    }
  },
);

// POST /api/projects/:name/dependency-repair/force-forward
router.post(
  '/:name/dependency-repair/force-forward',
  authenticateToken,
  requireApproved,
  requireOwner,
  requireDurableDependencyRepairSession,
  projectDependencyRepairMutationLimiter,
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    let lifecycleLock: ProjectDeletionLockLease | null = null;
    let writerFence: ProjectDependencyPromotionWriterFence | null = null;
    let prepared: ReturnType<typeof prepareProjectDependencyRepairEvidence> | null = null;
    let authorized: ProjectDependencyRepairRecord | null = null;
    let preparedEvidenceCleanupFailed = false;
    let backupMutationLock: Awaited<ReturnType<typeof acquireBackupMutationLock>> | null = null;
    let selectedBackup: ReturnType<typeof dependencyRepairBackupFingerprint> | null = null;
    let createdBackupLock: ReturnType<typeof createOrAttestProjectDependencyRepairBackupLock> | null = null;
    let requestedRepairId = '';
    let requestedPromotionOperationId = '';
    let requestedManifestDigest = '';
    let requestedOwnerId = '';
    let preGoHandoff: PreGoDependencyRepairHandoff | null = null;
    // This flag is request-local and is set only after an exact durable repair
    // receipt proves that startup—not an API retry—owns reconciliation.
    let activeRepairRestartRequired = false;
    try {
      if (!isTypedConfirmationMatch(
        dependencyRepairConfirmation(req.params.name),
        req.body?.confirmation,
      )) {
        res.status(400).json({
          error: `Type ${dependencyRepairConfirmation(req.params.name)} to confirm this Owner repair.`,
          code: 'PROJECT_DEPENDENCY_REPAIR_CONFIRMATION_REQUIRED',
          confirmationPhrase: dependencyRepairConfirmation(req.params.name),
        });
        return;
      }
      const repairId = String(req.body?.repairId || '').trim().toLowerCase();
      requestedRepairId = repairId;
      const ownerId = await getScopedOwnerId(req);
      requestedOwnerId = ownerId;
      const retainedPreGoHandoff = preGoDependencyRepairHandoffs.get(
        projectDeletionLockKey(ownerId, req.params.name),
      );
      if (retainedPreGoHandoff) {
        res.status(503).json({
          error: 'Dependency repair requires startup reconciliation before another mutation can be admitted.',
          code: 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
          retryable: false,
          restartRequired: true,
        });
        return;
      }
      const current = await inspectProjectDependencyRepairStatus({
        workspaceOwnerId: ownerId,
        projectName: req.params.name,
      });
      const expected = {
        projectIdentityId: String(req.body?.expectedProjectIdentityId || ''),
        projectIdentityGeneration: Number(req.body?.expectedProjectIdentityGeneration),
        operationId: String(req.body?.expectedPromotionOperationId || '').toLowerCase(),
        manifestDigest: String(req.body?.expectedManifestDigest || '').toLowerCase(),
      };
      requestedPromotionOperationId = expected.operationId;
      requestedManifestDigest = expected.manifestDigest;
      if (current.repair) {
        if (!current.lifecycle
          || current.lifecycle.id !== expected.projectIdentityId
          || Number(current.lifecycle.generation) !== expected.projectIdentityGeneration
          || current.repair.repairId !== repairId
          || current.repair.projectIdentityId !== expected.projectIdentityId
          || current.repair.projectIdentityGeneration !== expected.projectIdentityGeneration
          || current.repair.promotionOperationId !== expected.operationId
          || current.repair.manifestDigest !== expected.manifestDigest) {
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_BUSY',
            'Another exact repair request already owns this quarantined generation.',
          );
        }
        if (current.repair.status === 'APPLIED' && current.repair.phase === 'COMPLETE') {
          // A crash may occur after the durable COMPLETE transaction and
          // journal cleanup but before the live request removes its pin. Join
          // the canonical host-operation -> backup lock order and retire only
          // the exact completed receipt's repair-owned marker.
          backupMutationLock = await acquireBackupMutationLock();
          const refreshed = await inspectProjectDependencyRepairStatus({
            workspaceOwnerId: ownerId,
            projectName: req.params.name,
          });
          if (!refreshed.repair
            || refreshed.repair.repairId !== current.repair.repairId
            || refreshed.repair.status !== 'APPLIED'
            || refreshed.repair.phase !== 'COMPLETE'
            || refreshed.lifecycle?.lifecycleStatus !== 'ACTIVE'
            || refreshed.decision) {
            throw new ProjectDependencyRepairError(
              'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
              'The completed repair receipt changed before backup pin retirement.',
              503,
            );
          }
          releaseProjectDependencyRepairBackupLock({
            record: refreshed.repair,
            lease: backupMutationLock.lease,
          });
          res.status(200).json({
            accepted: true,
            completed: true,
            ...projectDependencyRepairResponse({
              state: 'COMPLETE', projectName: req.params.name, lifecycle: current.lifecycle,
              decision: null, repair: current.repair,
            }),
          });
          return;
        }
        if (!current.decision
          || current.decision.operationId !== expected.operationId
          || current.decision.manifestDigest !== expected.manifestDigest) {
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_STALE',
            'The Project or staged dependency generation changed. Reload repair status.',
          );
        }
        const fenceState = activeDependencyRepairFences.get(repairId);
        if (!fenceState) {
          activeRepairRestartRequired = true;
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
            'The durable repair requires startup reconciliation before it can resume.',
            503,
          );
        }
        if (!fenceState.running) {
          if (fenceState.restartRequired) {
            activeRepairRestartRequired = true;
            throw new ProjectDependencyRepairError(
              'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
              'The repair requires a Portal restart for startup reconciliation.',
              503,
            );
          }
          try {
            assertBackupMutationLockLease(fenceState.backupLease);
          } catch {
            activeRepairRestartRequired = true;
            throw new ProjectDependencyRepairError(
              'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
              'The repair exclusion lease was lost; restart Portal to run startup reconciliation.',
              503,
            );
          }
          lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
            projectDeletionLockKey(ownerId, req.params.name),
          );
          const started = scheduleProjectDependencyRepair({
            record: current.repair,
            lifecycleLock,
            fenceState,
          });
          if (started) lifecycleLock = null;
        }
        res.status(202).json({
          accepted: true,
          completed: false,
          ...projectDependencyRepairResponse({
            state: 'PROMOTING', projectName: req.params.name, lifecycle: current.lifecycle,
            decision: current.decision, repair: current.repair,
            ...dependencyRepairRuntimeTruth(current.repair),
          }),
        });
        return;
      }
      if (!current.lifecycle
        || !current.decision
        || current.lifecycle.id !== expected.projectIdentityId
        || Number(current.lifecycle.generation) !== expected.projectIdentityGeneration
        || current.decision.operationId !== expected.operationId
        || current.decision.manifestDigest !== expected.manifestDigest) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_STALE',
          'The Project or staged dependency generation changed. Reload repair status.',
        );
      }
      if (current.lifecycle.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
        || !current.lifecycle.dependencyQuarantinedAt) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_STALE',
          'Only an exact quarantined dependency promotion can be force-forwarded.',
        );
      }
      const quarantinedAt = new Date(current.lifecycle.dependencyQuarantinedAt);
      const backupAdmission = await dependencyRepairBackupAfter(quarantinedAt);
      if (!backupAdmission.backup) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
          'Create and strictly verify a complete comprehensive backup after quarantine.',
        );
      }
      const backup = dependencyRepairBackupFingerprint(backupAdmission.backup);
      selectedBackup = backup;
      if (!attestProjectDependencyRepairBackupFingerprint(backup)) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
          'The selected comprehensive backup changed before repair admission.',
        );
      }
      // Lock order is host operation -> backup mutation -> global writer fence
      // -> exact Project lock, matching backup-full and the installer.
      backupMutationLock = await acquireBackupMutationLock();

      lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
        projectDeletionLockKey(ownerId, req.params.name),
      );
      // Backup admission happened before the host-operation lock. A parallel
      // exact retry can therefore wait here while the winning request carries
      // the Project all the way back to ACTIVE. Re-read under both the backup
      // mutation lock and the exact Project lock before erecting the global
      // writer fence; stale quarantine truth must never create a needless
      // retained-fence restart handoff.
      const serialized = await inspectProjectDependencyRepairStatus({
        workspaceOwnerId: ownerId,
        projectName: req.params.name,
      });
      if (serialized.repair?.repairId === repairId
        && serialized.repair.status === 'APPLIED'
        && serialized.repair.phase === 'COMPLETE'
        && serialized.repair.projectIdentityId === expected.projectIdentityId
        && serialized.repair.projectIdentityGeneration === expected.projectIdentityGeneration
        && serialized.repair.promotionOperationId === expected.operationId
        && serialized.repair.manifestDigest === expected.manifestDigest
        && serialized.lifecycle?.lifecycleStatus === 'ACTIVE'
        && !serialized.decision) {
        res.status(200).json({
          accepted: true,
          completed: true,
          ...projectDependencyRepairResponse({
            state: 'COMPLETE', projectName: req.params.name, lifecycle: serialized.lifecycle,
            decision: null, repair: serialized.repair,
          }),
        });
        return;
      }
      if (!serialized.lifecycle
        || serialized.repair
        || !serialized.decision
        || serialized.lifecycle.id !== expected.projectIdentityId
        || Number(serialized.lifecycle.generation) !== expected.projectIdentityGeneration
        || serialized.lifecycle.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
        || !serialized.lifecycle.dependencyQuarantinedAt
        || new Date(serialized.lifecycle.dependencyQuarantinedAt).getTime() !== quarantinedAt.getTime()
        || serialized.decision.operationId !== expected.operationId
        || serialized.decision.manifestDigest !== expected.manifestDigest) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_STALE',
          'The exact quarantined dependency generation changed while repair admission was serialized.',
        );
      }
      writerFence = closeProjectDependencyPromotionWriterFence({
        // Repair routes are explicitly outside request-level workspace
        // admission so status/retry stay reachable while this global fence is
        // held; there is no self lease to exclude here.
        closeAdmissionAndSettleInstaller: closeGlobalWorkspaceAuthorizationAdmission,
        releaseProjectLease: () => {
          lifecycleLock?.();
          lifecycleLock = null;
        },
      });
      await writerFence.proveQuiescent();
      lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
        projectDeletionLockKey(ownerId, req.params.name),
      );
      const refreshedIdentity = await prisma.projectIdentity.findUnique({
        where: { id: serialized.lifecycle.id },
      });
      if (!refreshedIdentity
        || refreshedIdentity.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
        || refreshedIdentity.generation !== expected.projectIdentityGeneration
        || refreshedIdentity.dependencyQuarantinedAt?.getTime() !== quarantinedAt.getTime()) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_STALE',
          'The exact Project containment changed while writers drained.',
        );
      }
      await quiesceExactProjectForDependencyRepair({
        actorUserId: req.user!.userId,
        ownerId,
        projectIdentity: refreshedIdentity as unknown as ProjectIdentityRecord,
      });
      // Draining tracked writers and Project runtimes can take minutes. The
      // exact signed archive selected before that drain must still be the same
      // strictly restorable file immediately before PREPARED evidence and the
      // serializable Q→P go-bit.
      if (!attestProjectDependencyRepairBackupFingerprint(backup)
        || !await reverifyDependencyRepairBackup({ backup })
        || !attestProjectDependencyRepairBackupFingerprint(backup)) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
          'The pinned comprehensive backup changed or failed strict verification while writers drained.',
        );
      }
      attestQuarantinedProjectDependencyPromotionRepairable(serialized.decision.manifest);
      const backupLock = createOrAttestProjectDependencyRepairBackupLock({
        repairId,
        backup,
        binding: {
          projectIdentityId: expected.projectIdentityId,
          projectIdentityGeneration: expected.projectIdentityGeneration,
          workspaceOwnerId: ownerId,
          projectName: req.params.name,
          promotionOperationId: expected.operationId,
          manifestDigest: expected.manifestDigest,
        },
        lease: backupMutationLock.lease,
      });
      createdBackupLock = backupLock;
      prepared = prepareProjectDependencyRepairEvidence({
        repairId,
        decision: serialized.decision,
        quarantinedAt,
        backup,
        backupLock,
      });
      const audit = await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: 'PROJECT_DEPENDENCY_REPAIR_REQUESTED',
          resource: 'project',
          resourceId: repairId,
          severity: 'WARNING',
          metadata: {
            action: PROJECT_DEPENDENCY_REPAIR_ACTION,
            result: 'requested',
            projectIdentityId: expected.projectIdentityId,
            projectIdentityGeneration: expected.projectIdentityGeneration,
            promotionOperationId: expected.operationId,
            manifestDigest: expected.manifestDigest,
          },
        },
      });
      if (!audit) throw new Error('Dependency repair audit did not commit');
      const admission = await authorizeProjectDependencyForceForward({
        repairId,
        actor: req.user!,
        decision: serialized.decision,
        quarantinedAt,
        backup,
        repairBindingDigest: prepared.repairBindingDigest,
      });
      authorized = admission.record;
      const retainedBackupMutationLock = backupMutationLock;
      const fenceState: ActiveDependencyRepairFence = {
        fence: writerFence,
        running: null,
        retryTimer: null,
        terminalHandoffTimer: null,
        restartRequired: false,
        retryAttempts: 0,
        backupLease: retainedBackupMutationLock.lease,
        releaseBackupLease: retainedBackupMutationLock.release,
      };
      activeDependencyRepairFences.set(repairId, fenceState);
      const started = scheduleProjectDependencyRepair({
        record: admission.record,
        lifecycleLock,
        fenceState,
      });
      if (started) lifecycleLock = null;
      else scheduleProjectDependencyRepairRetry({ record: admission.record, fenceState });
      writerFence = null;
      backupMutationLock = null;
      res.status(202).json({
        accepted: true,
        completed: false,
        ...projectDependencyRepairResponse({
          state: 'PROMOTING', projectName: req.params.name, lifecycle: refreshedIdentity,
          decision: serialized.decision, repair: admission.record,
          ...dependencyRepairRuntimeTruth(admission.record),
        }),
      });
    } catch (error: any) {
      const evidenceIsIndeterminate = error instanceof ProjectDependencyRepairError
        && (error.code === 'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT'
          || error.code === 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE');
      if (prepared && !authorized && !evidenceIsIndeterminate) {
        let definitivePreGoBit = false;
        try {
          const ownerId = await getScopedOwnerId(req);
          const status = await inspectProjectDependencyRepairStatus({
            workspaceOwnerId: ownerId,
            projectName: req.params.name,
          });
          definitivePreGoBit = !status.repair
            && status.lifecycle?.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
            && status.decision?.operationId === prepared.journal.promotionOperationId
            && status.decision?.manifestDigest === prepared.journal.manifestDigest;
        } catch {}
        if (definitivePreGoBit) {
          try {
            discardPreparedProjectDependencyRepairEvidence(prepared.journal);
            if (createdBackupLock && selectedBackup && backupMutationLock) {
              releaseProjectDependencyRepairBackupLockSnapshot({
                repairId: prepared.journal.repairId,
                backup: selectedBackup,
                backupLock: createdBackupLock,
                lease: backupMutationLock.lease,
              });
              createdBackupLock = null;
            }
          } catch (cleanupError) {
            preparedEvidenceCleanupFailed = true;
            console.error('[Projects] Dependency repair preparation cleanup failed; retaining writer fence:',
              cleanupError instanceof Error ? cleanupError.message : 'unknown error');
          }
        } else {
          preparedEvidenceCleanupFailed = true;
        }
      }
      // Preparation can fail before returning its journal handle. Retire the
      // just-created repair pin only after a fresh database read proves that
      // no go-bit exists and the same exact promotion remains quarantined.
      if (createdBackupLock && selectedBackup && backupMutationLock
        && !prepared && !authorized && !evidenceIsIndeterminate) {
        try {
          const ownerId = await getScopedOwnerId(req);
          const status = await inspectProjectDependencyRepairStatus({
            workspaceOwnerId: ownerId,
            projectName: req.params.name,
          });
          if (!status.repair
            && status.lifecycle?.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
            && status.decision?.operationId === requestedPromotionOperationId
            && status.decision?.manifestDigest === requestedManifestDigest) {
            releaseProjectDependencyRepairBackupLockSnapshot({
              repairId: requestedRepairId,
              backup: selectedBackup,
              backupLock: createdBackupLock,
              lease: backupMutationLock.lease,
            });
            createdBackupLock = null;
          }
        } catch {
          // Any uncertainty intentionally over-retains the pin for startup or
          // an exact Owner retry; it must never be guessed away.
        }
      }
      if (writerFence?.isHeld() && !authorized && !preparedEvidenceCleanupFailed && !evidenceIsIndeterminate) {
        try {
          const ownerId = await getScopedOwnerId(req);
          const status = await inspectProjectDependencyRepairStatus({
            workspaceOwnerId: ownerId,
            projectName: req.params.name,
          });
          if (status.lifecycle?.lifecycleStatus === 'DEPENDENCY_QUARANTINED' && status.decision) {
            await writerFence.releaseAfterSafeState(() => attestProjectDependencyPromotionFenceReleaseState({
              operationId: status.decision!.operationId,
              manifestDigest: status.decision!.manifestDigest,
              projectIdentityId: status.decision!.projectIdentityId,
              projectIdentityGeneration: status.decision!.projectIdentityGeneration,
              workspaceOwnerId: status.decision!.workspaceOwnerId,
              projectName: status.decision!.projectName,
              destinationCanonicalRoot: status.decision!.destinationCanonicalRoot,
              destinationRootDevice: status.decision!.destinationRootDevice,
              destinationRootInode: status.decision!.destinationRootInode,
              destinationRootBirthtimeNs: status.decision!.destinationRootBirthtimeNs,
              expectedState: 'DEPENDENCY_QUARANTINED',
            }));
          }
        } catch {}
      }
      if (writerFence?.isHeld() && !authorized && requestedOwnerId && backupMutationLock) {
        const handoffKey = projectDeletionLockKey(requestedOwnerId, req.params.name);
        const retainedBackupMutationLock = backupMutationLock;
        preGoHandoff = {
          fence: writerFence,
          terminalHandoffTimer: null,
          restartRequired: true,
          backupLease: retainedBackupMutationLock.lease,
          releaseBackupLease: retainedBackupMutationLock.release,
        };
        preGoDependencyRepairHandoffs.set(handoffKey, preGoHandoff);
        // The global writer fence and ordered kernel locks stay owned until
        // process exit; startup alone may reconcile indeterminate PREPARED
        // evidence. Do not let finally release either exclusion primitive.
        writerFence = null;
        backupMutationLock = null;
        scheduleProjectDependencyRepairStartupHandoffAfterResponse(
          res,
          preGoHandoff,
          'a retained pre-go-bit writer fence requires startup reconciliation',
        );
      }
      const repairError = error instanceof ProjectDependencyRepairError ? error : null;
      const fenceError = error instanceof ProjectDependencyPromotionWriterFenceError ? error : null;
      const statusCode = repairError?.statusCode || fenceError?.statusCode || 503;
      const restartRequired = Boolean(preGoHandoff) || activeRepairRestartRequired;
      res.status(statusCode).json({
        error: repairError?.message || fenceError?.message || 'Dependency repair could not be admitted safely.',
        code: repairError?.code || fenceError?.code || 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
        retryable: !restartRequired && (statusCode === 409 || statusCode === 503),
        restartRequired,
      });
    } finally {
      lifecycleLock?.();
      await backupMutationLock?.release();
    }
  },
);

// GET /api/projects/:name/check-deps - check dependencies without installing
router.get('/:name/check-deps', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const result = await detectDependencies(projectDir);

    // Check cache
    if (result.needsInstall && result.packages.length > 0) {
      if (checkDepsCache(projectDir, result.packages)) {
        res.json({ ...result, needsInstall: false, cached: true });
        return;
      }
    }

    res.json(result);
  } catch (error: any) {
    console.error('Check deps error:', error);
    res.status(500).json({ error: 'Failed to check dependencies', detail: error.message });
  }
});

// POST /api/projects/:name/install-deps - install dependencies with SSE streaming
router.post('/:name/install-deps', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseProjectNameLock: ProjectDeletionLockLease | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    let lockedTarget: Awaited<ReturnType<typeof acquireLockedProjectDependencyInstallTarget<ProjectIdentityRecord>>>;
    try {
      lockedTarget = await acquireLockedProjectDependencyInstallTarget({
        ownerId,
        projectName: req.params.name,
        resolveProjectDir: () => getExistingProjectPathReadOnly(ownerId, req.params.name),
        resolveIdentity: (projectDir) => ensureProjectIdentity({
          workspaceOwnerId: ownerId,
          projectName: req.params.name,
          projectRoot: projectDir,
        }),
      });
    } catch (error: any) {
      if (error instanceof ContainedPathError || error?.code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      throw error;
    }
    releaseProjectNameLock = lockedTarget.release;
    const projectDir = lockedTarget.projectDir;
    const projectIdentity = lockedTarget.identity;
    const lifecycleScope = { actorId: req.user!.userId, projectId: projectIdentity.id };

    const result = await detectDependencies(projectDir);

    if (!result.needsInstall || !result.command || result.packages.length === 0) {
      res.json({ success: true, message: 'No dependencies to install', packages: [] });
      return;
    }

    // Check cache
    if (checkDepsCache(projectDir, result.packages)) {
      res.json({ success: true, message: 'Dependencies already installed (cached)', packages: result.packages, cached: true });
      return;
    }

    if (result.language === 'cpp') {
      res.status(422).json({
        error: 'System package installation is disabled for project sandboxes',
        detail: 'Project requests cannot run apt or sudo on the Portal host. Use dependencies already included in the project runtime image.',
        packages: result.packages,
      });
      return;
    }
    if (result.language !== 'python' && result.language !== 'node') {
      res.status(422).json({ error: 'Unknown project dependency language' });
      return;
    }

    const sendEvent = (event: string, data: any) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const installResult = await runAuthorizedProjectDependencyInstall({
      payload: req.user!,
      ownerId,
      projectName: req.params.name,
      projectId: lifecycleScope.projectId,
      projectDir,
      lifecycleLock: lockedTarget.lifecycleLock,
      closeGlobalAdmissionAndSettleRequest: () => (
        closeGlobalWorkspaceAuthorizationAdmissionExcludingRequest(req)
      ),
      releaseLifecycleLock: (expectedLock) => {
        if (releaseProjectNameLock !== expectedLock || !expectedLock.isHeld()) {
          throw new Error('Install dependency Project lock ownership changed before release');
        }
        releaseProjectNameLock = null;
        expectedLock();
      },
      adoptLifecycleLock: (nextLock) => {
        if (releaseProjectNameLock || !nextLock.isHeld()) {
          throw new Error('Install dependency Project lock ownership changed before reacquire');
        }
        releaseProjectNameLock = nextLock;
      },
      projectProof: {
        projectIdentityId: projectIdentity.id,
        projectIdentityGeneration: projectIdentity.generation,
        workspaceOwnerId: ownerId,
        projectName: req.params.name,
        canonicalRoot: projectIdentity.canonicalRoot,
        rootDevice: projectIdentity.rootDevice,
        rootInode: projectIdentity.rootInode,
        rootBirthtimeNs: projectIdentity.rootBirthtimeNs,
      },
      language: result.language,
      packages: result.packages,
      onAuthorized: (identity) => {
        req.user = identity;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'private, no-store, no-transform, max-age=0');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        sendEvent('start', {
          language: result.language,
          packages: result.packages,
          command: result.command,
        });
      },
      onEvent: sendEvent,
      onAuthorityLost: () => {
        if (!res.destroyed) res.destroy();
      },
      subscribeClientClose: (listener) => {
        res.once('close', listener);
        return () => res.removeListener('close', listener);
      },
      isClientClosed: () => res.destroyed || res.writableEnded,
      writeDependencyCache: (targetProjectDir) => writeDepsCache(targetProjectDir, result.packages),
    });

    if (installResult.status === 'cancelled') return;
    if (installResult.status === 'authorization_denied') {
      if (res.destroyed || res.writableEnded) return;
      const status = installResult.reason === 'session_revoked'
        ? 401
        : installResult.reason === 'account_denied'
          ? 403
          : 409;
      res.status(status).json({
        error: installResult.reason === 'session_revoked'
          ? 'This sign-in session is no longer active'
          : installResult.reason === 'account_denied'
            ? 'Account is not permitted to install project dependencies'
            : 'Workspace authorization changed before dependency installation began',
        code: installResult.reason === 'session_revoked'
          ? 'AUTH_SESSION_REVOKED'
          : 'WORKSPACE_SCOPE_CHANGED',
      });
      return;
    }
    if (installResult.status === 'failed') {
      sendEvent('error', {
        success: false,
        message: installResult.message,
        ...(installResult.output ? { output: installResult.output } : {}),
      });
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }

    sendEvent('complete', {
      success: true,
      message: 'Dependencies installed successfully',
      packages: result.packages,
    });
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Install deps error:', error);
    if (res.destroyed || res.writableEnded) {
      return;
    }
    if (error instanceof ProjectDependencyPromotionWriterFenceError) {
      const payload = {
        error: 'Dependency promotion could not prove a safe workspace boundary.',
        code: error.code,
        retained: error.fenceRetained,
      };
      if (!res.headersSent) {
        res.status(error.statusCode).json(payload);
      } else {
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to install dependencies', detail: error.message });
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    }
  } finally {
    settleWorkspaceAuthorizationRequest(req);
    releaseProjectNameLock?.();
  }
});

// POST /api/projects/:name/deploy - deploy with build support (static + fullstack + runtime)
router.post('/:name/deploy', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseProjectNameLock: ProjectDeletionLockLease | null = null;
  let fullstackPromotion: ProjectDeploymentPromotion | null = null;
  let previousFullstackApp: App | null = null;
  let projectIdentityForRecovery: ProjectIdentityProof | null = null;
  let fullstackSourceDigestForRecovery: string | null = null;
  let fullstackAppRecordMutated = false;
  let fullstackAppIdForRecovery: string | null = null;
  let fullstackStartAttempted = false;
  let deployIdForRecovery: string | null = null;
  let deployPathForRecovery: string | null = null;
  let lifecycleScopeForRecovery: ProjectAppStartIdentity | null = null;
  let recoveryReplay: ProjectRuntimeRecoveryReplayProof | null = null;
  let recoveryOwnerId: string | null = null;
  let recoveryClaimedRevision: string | null = null;
  let originalDeploymentRevision: string | null = null;
  try {
    if (req.body?.recoveryReplay !== undefined) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    const ownerId = await getScopedOwnerId(req);
    recoveryOwnerId = ownerId;
    try {
      recoveryReplay = parseProjectRuntimeRecoveryReplay(req.body?.recoveryReplay, 'deploy');
    } catch (error) {
      if (error instanceof ProjectRuntimeRecoveryReplayValidationError) {
        res.status(400).json({ code: error.code, error: error.message, retryable: false });
        return;
      }
      throw error;
    }
    let projectDir: string;
    try {
      projectDir = getExistingProjectPathReadOnly(ownerId, req.params.name);
    } catch (error: any) {
      if (error instanceof ContainedPathError || error?.code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      throw error;
    }

    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, req.params.name),
    );
    try {
      projectDir = getExistingProjectPathReadOnly(ownerId, req.params.name);
    } catch (error: any) {
      if (error instanceof ContainedPathError || error?.code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      throw error;
    }

    // Remote Desktop runtimes stay available in private/local profiles because
    // they never serve untrusted content through the Portal origin. Hosted
    // static/full-stack deployment fails before identity, DB, build, or copy
    // mutation when the required isolated app-content origin is unavailable.
    const deployType = detectDeployType(projectDir);
    if (!recoveryReplay && deployType !== 'runtime') {
      const unavailable = portalFeatureUnavailableResponse('appHosting');
      if (unavailable) {
        res.status(409).json(unavailable);
        return;
      }
    }

    const appName = req.params.name;
    const deployId = `${ownerId}-${appName}`;
    const deployPath = path.join(DEPLOY_DIR, deployId);
    const preflightProjectApp = await findProjectAppBeforeIdentityMutation({
      workspaceOwnerId: ownerId,
      projectName: appName,
      deployPath,
    });
    if (preflightProjectApp && !recoveryReplay) {
      const preflightManagement = projectRuntimeManagement(preflightProjectApp);
      if (preflightManagement === 'invalid-external-binding') {
        sendInvalidRuntimeBindingConflict(res, 'redeploy');
        return;
      }
      if (
        preflightManagement === 'external-loopback'
        && !(preflightProjectApp.deployType === 'static' && deployType === 'static')
      ) {
        sendExternalRuntimeConflict(res, 'redeploy');
        return;
      }
      if (sendDeployTypeTransitionConflictIfNeeded(
        res,
        preflightProjectApp,
        deployType,
      )) return;
    }

    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });
    projectIdentityForRecovery = serializeProjectIdentityProof(projectIdentity);
    const lifecycleScope = { actorId: req.user!.userId, projectId: projectIdentity.id };
    const appRuntimeIdentity: ProjectAppStartIdentity = {
      actorId: ownerId,
      projectId: projectIdentity.id,
      projectGeneration: projectIdentity.generation,
      appName,
      lifecycleLock: releaseProjectNameLock,
    };

    deployIdForRecovery = deployId;
    deployPathForRecovery = deployPath;
    lifecycleScopeForRecovery = appRuntimeIdentity;
    const existingProjectApp = await findProjectAppForIdentity({
      workspaceOwnerId: ownerId,
      projectIdentityId: projectIdentity.id,
      projectName: appName,
      deployPath,
    });
    if (recoveryReplay) {
      assertProjectRuntimeRecoveryRouteIdentity(recoveryReplay, projectIdentity);
      const status = await readProjectRuntimeRecoveryStatus(
        projectRuntimeRecoveryReplayScope(ownerId, recoveryReplay),
      );
      if (sendProjectRuntimeRecoveryStatus(res, status)) return;
      assertProjectRuntimeRecoveryRouteApp(recoveryReplay, existingProjectApp);
      if (deployType !== recoveryReplay.expectedDeployType) {
        throw new ProjectDeploymentReplayStaleError();
      }
      const unavailable = portalFeatureUnavailableResponse('appHosting');
      if (unavailable) {
        res.status(409).json(unavailable);
        return;
      }
    }
    if (existingProjectApp) {
      const existingManagement = projectRuntimeManagement(existingProjectApp);
      if (existingManagement === 'invalid-external-binding') {
        sendInvalidRuntimeBindingConflict(res, 'redeploy');
        return;
      }
      if (
        existingManagement === 'external-loopback'
        && !(existingProjectApp.deployType === 'static' && deployType === 'static')
      ) {
        sendExternalRuntimeConflict(res, 'redeploy');
        return;
      }
      if (sendDeployTypeTransitionConflictIfNeeded(
        res,
        existingProjectApp,
        deployType,
      )) return;
    }
    if (!existingProjectApp && await prisma.app.count({
      where: { userId: ownerId, name: appName },
    }) > 0) {
      res.status(409).json({
        error: 'A standalone App already uses this Project name and cannot be adopted implicitly.',
      });
      return;
    }
    
    if (deployType === 'runtime' && !canUseDesktopRuntimeDeployment(
      req.user?.role,
      req.user?.accountStatus,
      undefined,
    )) {
      res.status(403).json({
        error: 'Remote Desktop runtime deployment requires an Owner or Sub-Admin because it executes project code in the shared host desktop session.',
      });
      return;
    }
    if (!recoveryReplay) {
      originalDeploymentRevision = (await readProjectDeploymentLifecycleRevision({
        ownerUserId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectIdentityGeneration: projectIdentity.generation,
      })).deploymentRevision;
    }
    let buildOutput = '';
    let sourceDir = projectDir;
    
    // For static apps: build if needed, copy dist
    if (deployType === 'static') {
      await advanceProjectDeploymentLifecycleRevision({
        ownerUserId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectIdentityGeneration: projectIdentity.generation,
        expectedDeploymentRevision: originalDeploymentRevision!,
      });
      const packageJson = readProjectPackageJson(projectDir);
      let buildWorkspace: ReturnType<typeof createProjectLifecycleWorkspace> | null = null;
      try {
        if (packageJson?.scripts?.build) {
            buildWorkspace = createProjectLifecycleWorkspace(projectDir);
            buildOutput += await runProjectLifecycleCommand({
              ...lifecycleScope,
              workspace: buildWorkspace.path,
              command: 'npm',
              args: ['install', '--include=dev', '--no-audit', '--no-fund'],
              timeoutMs: 180_000,
              nameHint: `${deployId}:static-install`,
              network: true,
            });
            buildOutput += '\n' + await runProjectLifecycleCommand({
              ...lifecycleScope,
              workspace: buildWorkspace.path,
              command: 'npm',
              args: ['run', 'build'],
              timeoutMs: 180_000,
              nameHint: `${deployId}:static-build`,
              network: false,
            });

            const buildDirs = ['dist', 'build', 'out', 'public', '.next/static'];
            sourceDir = '';
            for (const dir of buildDirs) {
              const buildDir = path.join(buildWorkspace.path, dir);
              if (fs.existsSync(buildDir) && fs.existsSync(path.join(buildDir, 'index.html'))) {
                sourceDir = buildDir;
                break;
              }
            }
            if (!sourceDir) throw new Error('Build completed without a supported index.html output directory');
        }

        // Copy only inert build output (or a no-build static project) to the hosted directory.
        copyStaticDeploymentTree(sourceDir, deployPath);
      } finally {
        buildWorkspace?.cleanup();
      }
      
    }
    
    // For fullstack apps: copy everything, assign port, start process
    if (deployType === 'fullstack') {
      previousFullstackApp = existingProjectApp;
      fullstackPromotion = prepareFullstackDeploymentTree(
        projectDir,
        deployPath,
        recoveryReplay?.sourceDigest,
      );
      fullstackSourceDigestForRecovery = fullstackPromotion.sourceDigest;
      // Staging has produced the exact replay digest, but no App row or live
      // manager has changed yet. Fail here so rollback restores only the
      // staged deployment tree and a currently running prior App stays live.
      await assertProjectRuntimeImageAvailable();
      if (recoveryReplay) {
        const claim = await claimProjectRuntimeRecoveryProof(
          projectRuntimeRecoveryReplayScope(ownerId, recoveryReplay),
        );
        if (claim.kind !== 'claimed') {
          fullstackPromotion.rollback();
          fullstackPromotion = null;
          if (sendProjectRuntimeRecoveryStatus(res, claim)) return;
          throw new ProjectRuntimeRecoveryReplayError(
            'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
            'Project runtime recovery claim returned an invalid state',
            503,
          );
        }
        recoveryClaimedRevision = claim.deploymentRevision;
      } else {
        await advanceProjectDeploymentLifecycleRevision({
          ownerUserId: ownerId,
          projectIdentityId: projectIdentity.id,
          projectIdentityGeneration: projectIdentity.generation,
          expectedDeploymentRevision: originalDeploymentRevision!,
        });
      }
      fullstackPromotion.promote();
    }
    
    // For runtime apps: copy to bridgesrd user's projects directory and launch in xterm
    if (deployType === 'runtime') {
      await advanceProjectDeploymentLifecycleRevision({
        ownerUserId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectIdentityGeneration: projectIdentity.generation,
        expectedDeploymentRevision: originalDeploymentRevision!,
      });
      const desktopIdentity = buildProjectDesktopRuntimeIdentity(projectIdentity.id, appName);
      const runtimeDir = desktopIdentity.runtimeDir;
      const files = listProjectRootRegularFiles(projectDir);

      // Stop the exact immutable runtime before replacing its files. This
      // cannot collide with a same-named project in another workspace.
      stopManagedDesktopRuntimeUnit(desktopIdentity.systemdUnit);
      stopDesktopRuntimeProcess(desktopIdentity.processMarker);

      // Runtime children are bridgesrd-owned, but the parent remains
      // server-owned so a desktop process cannot rename sibling Projects.
      ensureSecureProjectDesktopRuntimeRoot();
      if (managedPathExists(runtimeDir)) {
        const entry = fs.lstatSync(runtimeDir);
        const identity = attestProjectRoot(runtimeDir);
        if (entry.isSymbolicLink() || !entry.isDirectory() || identity.canonicalRoot !== runtimeDir) {
          throw new ProjectIdentityLifecycleError(
            'Remote Desktop Project runtime path is not a real managed directory',
          );
        }
      } else {
        fs.mkdirSync(runtimeDir, { mode: 0o755 });
      }
      
      // Replace the complete runtime source tree. The shared deployment-tree
      // policy excludes container-built .venv/node_modules artifacts, rejects
      // included symlinks, and prevents deleted source files from surviving a
      // redeploy as stale host-executed code.
      copyDesktopRuntimeDeploymentTree(projectDir, runtimeDir);
      execSync(`chown -R bridgesrd:bridgesrd ${shellEscape(runtimeDir)}`, { timeout: 5000 });
      
      // Determine project type and run command
      let runCommand = '';
      let installCommand = '';
      let runtimePreparationError: string | null = null;
      
      if (files.includes('main.py') || files.includes('requirements.txt')) {
        // Python project — always use venv (PEP 668 on Ubuntu 24.04 blocks system pip)
        const runtimeVenv = path.join(runtimeDir, '.venv');
        const runtimeVenvPython = path.join(runtimeVenv, 'bin', 'python');
        // The lifecycle sandbox and host may use different Python versions.
        // Build a fresh host venv after the clean tree promotion; a promoted
        // container venv is not relocatable and must never be trusted here.
        try {
          desktopExec(`python3 -m venv ${shellEscape(runtimeVenv)}`, { timeout: 30000 });
        } catch (e: any) {
          runtimePreparationError = `Failed to create the Remote Desktop Python environment: ${e.message}`;
          buildOutput += `\n${runtimePreparationError}`;
        }
        if (files.includes('requirements.txt')) {
          installCommand = `${shellEscape(runtimeVenvPython)} -m pip install -r requirements.txt 2>&1`;
        }
        const mainFile = files.includes('main.py') ? 'main.py' : files.find(f => f.endsWith('.py')) || 'main.py';
        runCommand = `${shellEscape(runtimeVenvPython)} ${shellEscape(mainFile)}`;
        buildOutput += '\nDetected: Python project';
      } else if (files.includes('main.cpp') || files.includes('Makefile')) {
        // C++ project
        if (files.includes('Makefile')) {
          installCommand = `make 2>&1`;
        } else {
          installCommand = `g++ -o main main.cpp 2>&1`;
        }
        runCommand = './main';
        buildOutput += '\nDetected: C++ project';
      } else if (files.includes('package.json')) {
        // Node CLI project
        installCommand = `npm install 2>&1`;
        const pkg = readProjectPackageJson(projectDir);
        const requestedMain = typeof pkg?.main === 'string' ? pkg.main : 'index.js';
        const mainFile = requestedMain.length <= 240
          && path.posix.basename(requestedMain) === requestedMain
          && !requestedMain.includes('\\')
          && files.includes(requestedMain)
          ? requestedMain
          : 'index.js';
        runCommand = `node ${shellEscape(mainFile)}`;
        buildOutput += '\nDetected: Node.js CLI project';
      }
      
      if (!runCommand) {
        await fs.promises.rm(runtimeDir, { recursive: true, force: true });
        res.status(422).json({
          error: 'No supported Python, C++, or Node runtime entry point was found.',
          deployType: 'runtime',
        });
        return;
      }

      let runtimeError: string | null = runtimePreparationError;

      // Run install/build as bridgesrd user
      if (installCommand && !runtimeError) {
        try {
          desktopExec(installCommand, { cwd: runtimeDir, timeout: 120000 });
          buildOutput += '\nDependencies installed';
        } catch (e: any) {
          runtimeError = `Dependency installation or compilation failed: ${e.message}`;
          buildOutput += `\n${runtimeError}`;
        }
      }

      // Launch in xterm on the VNC desktop (fully detached via setsid so execSync returns immediately)
      if (!runtimeError) {
        try {
          const terminalCommand = `cd ${shellEscape(runtimeDir)} && ${runCommand}; status=$?; echo; echo "Process exited with status $status"; echo "Press Enter to close..."; read`;
          const xtermCmd = [
            'xterm',
            '-name', shellEscape(desktopIdentity.processMarker),
            '-title', shellEscape(desktopIdentity.windowTitle),
            '-fa', 'Monospace',
            '-fs', '12',
            '-e', 'bash', '-lc', shellEscape(terminalCommand),
          ].join(' ');
          desktopExecManaged(desktopIdentity.systemdUnit, xtermCmd);
          await new Promise(resolve => setTimeout(resolve, 750));
          if (
            !isManagedDesktopRuntimeUnitRunning(desktopIdentity.systemdUnit)
            || !isDesktopRuntimeProcessRunning(desktopIdentity.processMarker)
          ) {
            throw new Error('Remote Desktop terminal did not remain running');
          }
          buildOutput += '\nRunning on Remote Desktop';
        } catch (e: any) {
          runtimeError = `Failed to launch Remote Desktop terminal: ${e.message}`;
          buildOutput += `\n${runtimeError}`;
        }
      }
      
      // Create or update App record for runtime
      const runtimeAppState = projectDesktopRuntimeAppState(runtimeError);
      let app = existingProjectApp;

      if (app) {
        app = await prisma.app.update({
          where: { id: app.id },
          data: { 
            projectIdentityId: projectIdentity.id,
            zipPath: runtimeDir, 
            isActive: runtimeAppState.isActive,
            deployType: 'runtime',
            port: null,
            processStatus: runtimeAppState.processStatus,
            updatedAt: new Date(),
          },
        });
      } else {
        app = await prisma.app.create({
          data: {
            userId: ownerId,
            projectIdentityId: projectIdentity.id,
            name: appName,
            description: `Runtime project ${appName}`,
            zipPath: runtimeDir,
            isActive: runtimeAppState.isActive,
            deployType: 'runtime',
            port: null,
            processStatus: runtimeAppState.processStatus,
          },
        });
      }

      await prisma.activityLog.create({
        data: {
          userId: ownerId,
          action: 'PROJECT_DEPLOY',
          resource: 'project',
          resourceId: projectIdentity.id,
          severity: runtimeError ? 'ERROR' : 'INFO',
          metadata: {
            projectName: appName,
            deployType: 'runtime',
            appId: app.id,
            status: runtimeError ? 'error' : 'running',
          },
        },
      });

      if (runtimeError) {
        res.status(500).json({
          error: runtimeError,
          appId: app.id,
          name: appName,
          deployType: 'runtime',
          buildOutput: buildOutput || undefined,
        });
        return;
      }

      res.json({
        message: 'Running on Remote Desktop',
        appId: app.id,
        name: appName,
        deployType: 'runtime',
        buildOutput: buildOutput || undefined,
      });
      return;
    }

    // Create or update App record (for static/fullstack)
    let app = deployType === 'fullstack'
      ? previousFullstackApp
      : existingProjectApp;

    let port: number | null = null;
    if (deployType === 'fullstack') {
      // Reuse existing port or allocate new one
      port = app?.port || await allocatePort();
    }

    if (app) {
      app = await prisma.app.update({
        where: { id: app.id },
        data: { 
          projectIdentityId: projectIdentity.id,
          zipPath: deployPath, 
          isActive: true, 
          deployType,
          port,
          processStatus: deployType === 'fullstack' ? 'starting' : 'stopped',
          updatedAt: new Date(),
        },
      });
      fullstackAppRecordMutated = deployType === 'fullstack';
      if (deployType === 'fullstack') fullstackAppIdForRecovery = app.id;
    } else {
      app = await prisma.app.create({
        data: {
          userId: ownerId,
          projectIdentityId: projectIdentity.id,
          name: appName,
          description: `Deployed from project ${appName}`,
          zipPath: deployPath,
          isActive: true,
          deployType,
          port,
          processStatus: deployType === 'fullstack' ? 'starting' : 'stopped',
        },
      });
      fullstackAppRecordMutated = deployType === 'fullstack';
      if (deployType === 'fullstack') fullstackAppIdForRecovery = app.id;
    }

    // Start the process for fullstack apps
    if (deployType === 'fullstack' && port) {
      try {
        fullstackStartAttempted = true;
        await startApp(app.id, deployId, deployPath, port, appRuntimeIdentity);
        buildOutput += `\nFullstack app started on internal port ${port}`;
        fullstackPromotion?.finalize();
        fullstackPromotion = null;
      } catch (e: any) {
        buildOutput += `\nProcess start failed: ${e.message}`;
        await prisma.app.update({ where: { id: app.id }, data: { processStatus: 'error' } });
        if (isProjectRuntimeImageUnavailable(e)) throw e;
        throw new Error(`Fullstack app failed to start: ${e.message}`);
      }
    }

    await prisma.activityLog.create({
      data: { userId: ownerId, action: 'PROJECT_DEPLOY', resource: 'project', resourceId: projectIdentity.id, severity: 'INFO', metadata: { projectName: appName, deployType, appId: app.id } },
    }).catch((activityError) => {
      console.warn('[Project Deploy] Failed to record activity:', activityError);
    });

    if (recoveryReplay) {
      if (!recoveryClaimedRevision) {
        throw new ProjectRuntimeRecoveryReplayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project runtime recovery completed without a durable claim',
          503,
        );
      }
      try {
        await completeProjectRuntimeRecoveryOrThrow(
          ownerId,
          recoveryReplay,
          projectRuntimeRecoveryCompletion({
            replay: recoveryReplay,
            deploymentRevision: recoveryClaimedRevision,
            appId: app.id,
          }),
        );
      } catch (completionError) {
        console.error('[Project Deploy] Recovery receipt completion failed:', completionError);
        res.status(503).json({
          code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE',
          error: 'The Project deployment finished, but Portal could not confirm its recovery receipt.',
          detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
          retryable: false,
        });
        return;
      }
    }

    const hostedUrl = `/hosted/${deployId}/`;
    res.json({ 
      message: 'Deployed', 
      appId: app.id, 
      name: appName, 
      url: hostedUrl,
      deployType,
      port: port || undefined,
      buildOutput: buildOutput || undefined,
    });
  } catch (error: any) {
    let recoveryError: Error | null = null;
    if (fullstackPromotion && deployIdForRecovery && deployPathForRecovery && lifecycleScopeForRecovery) {
      if (fullstackStartAttempted && !isProjectRuntimeImageUnavailable(error)) {
        try {
          await stopApp(deployIdForRecovery);
        } catch (stopError: any) {
          recoveryError = new Error(`Failed to stop the replacement app: ${stopError.message}`);
        }
      }

      let deploymentRestored = false;
      try {
        fullstackPromotion.rollback();
        deploymentRestored = true;
      } catch (rollbackError: any) {
        recoveryError = new Error([
          recoveryError?.message,
          `Failed to restore the prior deployment: ${rollbackError.message}`,
        ].filter(Boolean).join('; '));
      }

      if (deploymentRestored && fullstackAppRecordMutated) {
        try {
          if (previousFullstackApp) {
            await prisma.app.update({
              where: { id: previousFullstackApp.id },
              data: {
                zipPath: previousFullstackApp.zipPath,
                isActive: previousFullstackApp.isActive,
                deployType: previousFullstackApp.deployType,
                port: previousFullstackApp.port,
                processStatus: previousFullstackApp.processStatus,
                updatedAt: previousFullstackApp.updatedAt,
              },
            });
          } else if (fullstackAppIdForRecovery) {
            await prisma.app.deleteMany({ where: { id: fullstackAppIdForRecovery } });
          }
        } catch (databaseError: any) {
          recoveryError = new Error([
            recoveryError?.message,
            `Failed to restore the prior app record: ${databaseError.message}`,
          ].filter(Boolean).join('; '));
        }
      }

      const shouldRestartPriorApp = deploymentRestored
        && fullstackStartAttempted
        && !isProjectRuntimeImageUnavailable(error)
        && previousFullstackApp?.deployType === 'fullstack'
        && previousFullstackApp.isActive
        && previousFullstackApp.port !== null
        && ['running', 'starting'].includes(previousFullstackApp.processStatus);
      if (shouldRestartPriorApp && previousFullstackApp?.port) {
        try {
          await startApp(
            previousFullstackApp.id,
            deployIdForRecovery,
            deployPathForRecovery,
            previousFullstackApp.port,
            lifecycleScopeForRecovery,
          );
        } catch (restartError: any) {
          recoveryError = new Error([
            recoveryError?.message,
            `Failed to restart the prior app: ${restartError.message}`,
          ].filter(Boolean).join('; '));
        }
      }
    }
    if (recoveryReplay && recoveryOwnerId && recoveryClaimedRevision) {
      try {
        await failProjectRuntimeRecoveryOrThrow(
          recoveryOwnerId,
          recoveryReplay,
          isProjectRuntimeImageUnavailable(error)
            ? 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE'
            : recoveryError
              ? 'PROJECT_DEPLOY_RECOVERY_FAILED'
              : 'PROJECT_DEPLOY_FAILED',
        );
      } catch (receiptError) {
        console.error('[Project Deploy] Recovery receipt failure settlement failed:', receiptError);
        res.status(503).json({
          code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE',
          error: 'The recovered Project deployment stopped without a durable terminal receipt.',
          detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
          retryable: false,
        });
        return;
      }
    }
    console.error('Deploy error:', error);
    if (recoveryError) console.error('Deploy recovery error:', recoveryError);
    if (sendProjectRuntimeRecoveryReplayError(res, error)) return;
    if (error instanceof ProjectDeploymentReplayStaleError) {
      res.status(409).json({
        code: error.code,
        error: error.message,
        detail: 'Refresh this Project and use its current Deployment controls.',
        retryable: false,
      });
      return;
    }
    if (isProjectRuntimeImageUnavailable(error)) {
      if (recoveryReplay) {
        res.status(503).json({
          code: 'PROJECT_RUNTIME_RECOVERY_FAILED',
          error: 'The Project runtime image became unavailable while replaying the recovered deployment.',
          detail: 'Refresh Deployment status and run the repair again before taking another action.',
          retryable: false,
        });
        return;
      }
      if (recoveryError) {
        res.status(500).json({
          code: 'PROJECT_RUNTIME_RECOVERY_PROOF_UNAVAILABLE',
          error: 'Portal could not safely restore the prior deployment after the runtime image failure.',
          detail: 'Review Activity Logs and the current Deployment state before taking another action.',
          retryable: false,
        });
        return;
      }
      if (
        !projectIdentityForRecovery
        || !fullstackSourceDigestForRecovery
        || !lifecycleScopeForRecovery
        || originalDeploymentRevision === null
      ) {
        res.status(500).json({
          code: 'PROJECT_RUNTIME_RECOVERY_PROOF_UNAVAILABLE',
          error: 'Portal could not bind runtime repair to the failed Project action.',
          detail: 'Refresh this Project and try Deploy again.',
          retryable: true,
        });
        return;
      }
      const currentRecoveryApp = await prisma.app.findFirst({
        where: {
          userId: lifecycleScopeForRecovery.actorId,
          projectIdentityId: projectIdentityForRecovery.id,
        },
        select: { id: true },
      });
      if (
        previousFullstackApp
          ? !currentRecoveryApp || currentRecoveryApp.id !== previousFullstackApp.id
          : currentRecoveryApp !== null
      ) {
        res.status(500).json({
          code: 'PROJECT_RUNTIME_RECOVERY_PROOF_UNAVAILABLE',
          error: 'Portal could not bind runtime repair to the recovered Project deployment.',
          detail: 'Refresh this Project and review its current Deployment state before retrying.',
          retryable: true,
        });
        return;
      }
      try {
        const proof = await issueProjectRuntimeRecoveryReplay({
          ownerUserId: lifecycleScopeForRecovery.actorId,
          action: 'deploy',
          projectIdentity: projectIdentityForRecovery,
          expectedAppId: currentRecoveryApp?.id || null,
          expectedDeploymentRevision: originalDeploymentRevision,
          sourceDigest: fullstackSourceDigestForRecovery,
        });
        sendProjectRuntimeImageUnavailable(res, proof);
      } catch (proofError) {
        console.error('[Project Deploy] Failed to issue runtime recovery proof:', proofError);
        res.status(500).json({
          code: 'PROJECT_RUNTIME_RECOVERY_PROOF_UNAVAILABLE',
          error: 'Portal could not bind runtime repair to the failed Project action.',
          detail: 'Refresh this Project and try Deploy again.',
          retryable: true,
        });
      }
      return;
    }
    res.status(500).json({
      code: 'PROJECT_DEPLOY_FAILED',
      error: 'Failed to deploy',
      detail: recoveryError
        ? 'Deployment failed and the previous deployment could not be fully restored. Review Activity Logs before retrying.'
        : 'Review the Project build and runtime configuration, then try again.',
      retryable: !recoveryError,
    });
  } finally {
    releaseProjectNameLock?.();
  }
});

// DELETE /api/projects/:name/deploy — remove only the Project deployment.
// Source, Git history, Project Chat, and immutable Project identity remain.
router.delete('/:name/deploy', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseProjectNameLock: (() => void) | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    const appName = req.params.name;
    let projectDir: string;
    try {
      projectDir = getExistingProjectPathReadOnly(ownerId, appName);
    } catch (error: any) {
      if (error instanceof ContainedPathError || error?.code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      throw error;
    }

    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, appName),
    );
    try {
      projectDir = getExistingProjectPathReadOnly(ownerId, appName);
    } catch (error: any) {
      if (error instanceof ContainedPathError || error?.code === 'ENOENT') {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      throw error;
    }

    const deployId = `${ownerId}-${appName}`;
    const deployPath = path.join(DEPLOY_DIR, deployId);
    const preflightProjectApp = await findProjectAppBeforeIdentityMutation({
      workspaceOwnerId: ownerId,
      projectName: appName,
      deployPath,
    });
    if (sendRuntimeOwnershipMutationConflict(res, preflightProjectApp, 'undeploy')) return;

    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: appName,
      projectRoot: projectDir,
    });
    const app = await findProjectAppForIdentity({
      workspaceOwnerId: ownerId,
      projectIdentityId: projectIdentity.id,
      projectName: appName,
      deployPath,
    });
    if (sendRuntimeOwnershipMutationConflict(res, app, 'undeploy')) return;
    const deployIdentity = managedPathExists(deployPath)
      ? attestProjectRoot(deployPath)
      : null;

    if (!app && !deployIdentity) {
      res.status(404).json({ error: 'Project deployment not found' });
      return;
    }

    const undeployRevision = await readProjectDeploymentLifecycleRevision({
      ownerUserId: ownerId,
      projectIdentityId: projectIdentity.id,
      projectIdentityGeneration: projectIdentity.generation,
    });
    await advanceProjectDeploymentLifecycleRevision({
      ownerUserId: ownerId,
      projectIdentityId: projectIdentity.id,
      projectIdentityGeneration: projectIdentity.generation,
      expectedDeploymentRevision: undeployRevision.deploymentRevision,
    });

    if (app?.deployType === 'fullstack') {
      await forgetAppRuntime(app.id, deployId, {
        actorId: ownerId,
        projectId: projectIdentity.id,
        deployPath: app.zipPath,
        port: app.port,
      }, { settleStatus: 'stopped' });
    } else {
      await stopApp(deployId);
    }

    let runtimeDirectoryRemoved = false;
    if (app?.deployType === 'runtime') {
      const desktopRuntime = await stopProjectDesktopRuntimesForLifecycle({
        workspaceOwnerId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectName: appName,
      });
      await removeDirectoryThroughAttestedQuarantine({
        sourceRoot: desktopRuntime.runtimeDir,
        quarantineKey: `undeploy-desktop:${projectIdentity.id}`,
        expectedIdentity: desktopRuntime.identity || undefined,
        sourceMustBeAbsent: !desktopRuntime.identity,
      });
      runtimeDirectoryRemoved = Boolean(desktopRuntime.identity);
    }

    await removeDirectoryThroughAttestedQuarantine({
      sourceRoot: deployPath,
      quarantineKey: `undeploy-hosted:${projectIdentity.id}`,
      expectedIdentity: deployIdentity || undefined,
      sourceMustBeAbsent: !deployIdentity,
    });

    if (app) {
      const deleted = await prisma.app.deleteMany({
        where: {
          id: app.id,
          projectIdentityId: projectIdentity.id,
          userId: ownerId,
        },
      });
      if (deleted.count !== 1) {
        throw new ProjectIdentityLifecycleError(
          'Project deployment identity changed before undeploy committed',
        );
      }
    }

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'PROJECT_UNDEPLOY',
        resource: 'project',
        resourceId: projectIdentity.id,
        severity: 'INFO',
        metadata: {
          projectName: appName,
          projectIdentityId: projectIdentity.id,
          appId: app?.id || null,
          deployType: app?.deployType || null,
          removedHostedDirectory: Boolean(deployIdentity),
          removedRuntimeDirectory: runtimeDirectoryRemoved,
        },
      },
    }).catch((activityError) => {
      console.warn('[Project Undeploy] Failed to record activity:', activityError);
    });

    res.json({
      message: 'Project deployment removed',
      projectName: appName,
      projectIdentityId: projectIdentity.id,
      appId: app?.id || null,
      deployType: app?.deployType || null,
      sourcePreserved: true,
    });
  } catch (error: any) {
    console.error('Project undeploy error:', error);
    if (error instanceof ProjectRuntimeStateAttestationError) {
      res.status(409).json({
        code: error.code,
        error: error.message,
        retryable: error.retryable,
        recoveryAction: 'REVIEW_RUNTIME_STATE',
      });
      return;
    }
    if (error instanceof ProjectExternalRuntimeLifecycleError) {
      res.status(409).json(projectExternalRuntimeConflict(error));
      return;
    }
    if (error instanceof ProjectInvalidRuntimeBindingError) {
      res.status(503).json(projectInvalidRuntimeBindingConflict(error));
      return;
    }
    if (error instanceof ProjectIdentityLifecycleError) {
      res.status(409).json({
        code: error.code,
        error: error.message,
        retryable: true,
      });
      return;
    }
    res.status(500).json({
      code: 'PROJECT_UNDEPLOY_FAILED',
      error: 'Failed to remove the Project deployment.',
      detail: 'Refresh the Project and try again. No external service was stopped.',
      retryable: true,
    });
  } finally {
    releaseProjectNameLock?.();
  }
});

// POST /api/projects/:name/app-process — manage fullstack app process (start/stop/restart/status/logs)
router.post('/:name/app-process', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseProjectNameLock: ProjectDeletionLockLease | null = null;
  try {
    if (req.body?.recoveryReplay !== undefined) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    const ownerId = await getScopedOwnerId(req);
    const appName = req.params.name;
    const deployId = `${ownerId}-${appName}`;
    const { action } = req.body;
    const acceptedActions = ['start', 'stop', 'restart', 'status', 'logs'] as const;
    if (!acceptedActions.includes(action)) {
      res.status(400).json({
        error: 'Invalid action. Use: start, stop, restart, status, logs',
      });
      return;
    }
    let recoveryReplay: ProjectRuntimeRecoveryReplayProof | null = null;
    if (req.body?.recoveryReplay !== undefined) {
      if (action !== 'start' && action !== 'restart') {
        res.status(400).json({
          code: 'PROJECT_RUNTIME_RECOVERY_REPLAY_INVALID',
          error: 'Runtime recovery replay is supported only for Start or Restart.',
          retryable: false,
        });
        return;
      }
      try {
        recoveryReplay = parseProjectRuntimeRecoveryReplay(req.body.recoveryReplay, action);
      } catch (error) {
        if (error instanceof ProjectRuntimeRecoveryReplayValidationError) {
          res.status(400).json({ code: error.code, error: error.message, retryable: false });
          return;
        }
        throw error;
      }
    }
    let projectDir = getProjectPath(ownerId, appName);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const mutatingAction = action === 'start' || action === 'stop' || action === 'restart';
    if (mutatingAction) {
      releaseProjectNameLock = await acquireProjectDeletionLock(
        projectDeletionLockKey(ownerId, appName),
      );
      projectDir = getProjectPath(ownerId, appName);
      if (!fs.existsSync(projectDir)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
    }
    const deployPath = path.join(DEPLOY_DIR, deployId);
    const preflightProjectApp = await findProjectAppBeforeIdentityMutation({
      workspaceOwnerId: ownerId,
      projectName: appName,
      deployPath,
    });
    if (preflightProjectApp && !recoveryReplay) {
      const preflightManagement = projectRuntimeManagement(preflightProjectApp);
      if (preflightManagement === 'invalid-external-binding') {
        sendInvalidRuntimeBindingConflict(res, action);
        return;
      }
      if (preflightManagement === 'external-loopback') {
        if (action === 'status' || action === 'logs') {
          await sendExternalRuntimeStatus(res, preflightProjectApp);
        } else {
          sendExternalRuntimeConflict(res, action);
        }
        return;
      }
    }

    const projectIdentity = mutatingAction
      ? await ensureProjectIdentity({
        workspaceOwnerId: ownerId,
        projectName: appName,
        projectRoot: projectDir,
      })
      : null;
    const app = projectIdentity
      ? await findProjectAppForIdentity({
        workspaceOwnerId: ownerId,
        projectIdentityId: projectIdentity.id,
        projectName: appName,
        deployPath,
      })
      : preflightProjectApp;
    
    if (!app) {
      res.status(404).json({ error: 'Project deployment not found' });
      return;
    }
    if (recoveryReplay) {
      const mutationIdentity = projectIdentity;
      if (!mutationIdentity) {
        throw new ProjectDeploymentReplayStaleError();
      }
      assertProjectRuntimeRecoveryRouteIdentity(recoveryReplay, mutationIdentity);
      const status = await readProjectRuntimeRecoveryStatus(
        projectRuntimeRecoveryReplayScope(ownerId, recoveryReplay),
      );
      if (sendProjectRuntimeRecoveryStatus(res, status)) return;
      assertProjectRuntimeRecoveryRouteApp(recoveryReplay, app);
    }
    const runtimeManagement = projectRuntimeManagement(app);
    if (runtimeManagement === 'invalid-external-binding') {
      sendInvalidRuntimeBindingConflict(res, action);
      return;
    }
    if (runtimeManagement === 'external-loopback') {
      if (action === 'status' || action === 'logs') {
        await sendExternalRuntimeStatus(res, app);
      } else {
        sendExternalRuntimeConflict(res, action);
      }
      return;
    }

    const managerStatus = app.deployType === 'fullstack'
      ? getAppStatus(deployId)
      : null;
    const recoveryRequired = app.deployType === 'fullstack'
      && !managerStatus
      && ['running', 'starting'].includes(app.processStatus);
    const supportedActions = app.deployType !== 'fullstack'
      ? []
      : managerStatus
        ? [...acceptedActions]
        : recoveryRequired
          ? ['start', 'stop', 'status']
          : ['start', 'status'];

    if (app.deployType !== 'fullstack') {
      if (action === 'status') {
        res.json({
          status: app.deployType === 'runtime' ? app.processStatus : 'deployed',
          persistedStatus: app.processStatus || null,
          statusSource: projectRuntimeStatusSource(app),
          recoveryRequired: false,
          deployType: app.deployType,
          runtimeManagement,
          supportedActions: [],
          logs: [],
          restartCount: 0,
          limitation: app.deployType === 'runtime'
            ? 'Remote Desktop Project runtimes are launched as desktop sessions and do not support web process controls.'
            : 'Static deployments have no application process to control.',
        });
        return;
      }
      res.status(409).json({
        code: 'PROJECT_PROCESS_CONTROL_UNSUPPORTED',
        error: app.deployType === 'runtime'
          ? 'Remote Desktop Project runtimes do not support start, stop, restart, or log controls.'
          : 'Static Project deployments do not have a controllable application process.',
        deployType: app.deployType,
        runtimeManagement,
        supportedActions: [],
      });
      return;
    }

    const requireRuntimeMutationIdentity = () => {
      if (!projectIdentity) {
        throw new ProjectIdentityLifecycleError(
          'Project runtime mutation did not retain its immutable Project identity',
        );
      }
      return projectIdentity;
    };

    const originalProcessRevision = mutatingAction && !recoveryReplay && projectIdentity
      ? (await readProjectDeploymentLifecycleRevision({
          ownerUserId: ownerId,
          projectIdentityId: projectIdentity.id,
          projectIdentityGeneration: projectIdentity.generation,
        })).deploymentRevision
      : null;

    const ensureRuntimeImageForProcessAction = async (
      replayAction: 'start' | 'restart',
      mutationIdentity: NonNullable<typeof projectIdentity>,
    ): Promise<boolean> => {
      try {
        await assertProjectRuntimeImageAvailable();
        return true;
      } catch (error) {
        if (!isProjectRuntimeImageUnavailable(error)) throw error;
        if (recoveryReplay) {
          sendProjectRuntimeImageUnavailable(res, recoveryReplay);
          return false;
        }
        if (originalProcessRevision === null) {
          throw new ProjectRuntimeRecoveryReplayError(
            'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
            'Project runtime recovery was not bound to a deployment revision',
            503,
          );
        }
        const proof = await issueProjectRuntimeRecoveryReplay({
          ownerUserId: ownerId,
          action: replayAction,
          projectIdentity: serializeProjectIdentityProof(mutationIdentity),
          expectedAppId: app.id,
          expectedDeploymentRevision: originalProcessRevision,
        });
        sendProjectRuntimeImageUnavailable(res, proof);
        return false;
      }
    };

    const admitProcessAction = async (): Promise<{
      responded: boolean;
      recoveryRevision: string | null;
    }> => {
      const mutationIdentity = requireRuntimeMutationIdentity();
      if (recoveryReplay) {
        const claim = await claimProjectRuntimeRecoveryProof(
          projectRuntimeRecoveryReplayScope(ownerId, recoveryReplay),
        );
        if (claim.kind !== 'claimed') {
          return {
            responded: sendProjectRuntimeRecoveryStatus(res, claim),
            recoveryRevision: null,
          };
        }
        return { responded: false, recoveryRevision: claim.deploymentRevision };
      }
      if (originalProcessRevision === null) {
        throw new ProjectRuntimeRecoveryReplayError(
          'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
          'Project process mutation was not bound to a deployment revision',
          503,
        );
      }
      await advanceProjectDeploymentLifecycleRevision({
        ownerUserId: ownerId,
        projectIdentityId: mutationIdentity.id,
        projectIdentityGeneration: mutationIdentity.generation,
        expectedDeploymentRevision: originalProcessRevision,
      });
      return { responded: false, recoveryRevision: null };
    };
    
    if (action === 'stop') {
      const mutationIdentity = requireRuntimeMutationIdentity();
      const admission = await admitProcessAction();
      if (admission.responded) return;
      await forgetAppRuntime(app.id, deployId, {
        actorId: ownerId,
        projectId: mutationIdentity.id,
        deployPath: app.zipPath,
        port: app.port,
      }, { settleStatus: 'stopped' });
      res.json({
        message: 'Stopped',
        status: 'stopped',
        persistedStatus: 'stopped',
        statusSource: 'persisted-app',
        recoveryRequired: false,
        deployType: 'fullstack',
        runtimeManagement,
        supportedActions: ['start', 'status'],
        logs: [],
        restartCount: 0,
      });
      return;
    }
    
    if (action === 'start') {
      const mutationIdentity = requireRuntimeMutationIdentity();
      if (!app.port || !app.zipPath) {
        res.status(400).json({ error: 'App not properly configured (missing port or path)' });
        return;
      }
      if (!await ensureRuntimeImageForProcessAction('start', mutationIdentity)) return;
      const admission = await admitProcessAction();
      if (admission.responded) return;
      try {
        await startApp(app.id, deployId, app.zipPath, app.port, {
          actorId: ownerId,
          projectId: mutationIdentity.id,
          projectGeneration: mutationIdentity.generation,
          appName: app.name,
          lifecycleLock: releaseProjectNameLock!,
        });
        const responseBody = {
          ...(getAppStatus(deployId) || { logs: [], restartCount: 0 }),
          message: 'Running',
          status: 'running',
          persistedStatus: 'running',
          statusSource: 'portal-manager',
          recoveryRequired: false,
          port: app.port,
          deployType: 'fullstack',
          runtimeManagement,
          supportedActions: [...acceptedActions],
        };
        if (recoveryReplay) {
          if (!admission.recoveryRevision) {
            throw new ProjectRuntimeRecoveryReplayError(
              'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
              'Project runtime recovery completed without a durable claim',
              503,
            );
          }
          try {
            await completeProjectRuntimeRecoveryOrThrow(
              ownerId,
              recoveryReplay,
              projectRuntimeRecoveryCompletion({
                replay: recoveryReplay,
                deploymentRevision: admission.recoveryRevision,
                appId: app.id,
              }),
            );
          } catch (completionError) {
            console.error('[Project Runtime] Start receipt completion failed:', completionError);
            res.status(503).json({
              code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE',
              error: 'The Project runtime started, but Portal could not confirm its recovery receipt.',
              detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
              retryable: false,
            });
            return;
          }
        }
        res.json(responseBody);
      } catch (e: any) {
        if (recoveryReplay && admission.recoveryRevision) {
          try {
            await failProjectRuntimeRecoveryOrThrow(
              ownerId,
              recoveryReplay,
              isProjectRuntimeImageUnavailable(e)
                ? 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE'
                : 'PROJECT_RUNTIME_START_FAILED',
            );
          } catch (receiptError) {
            console.error('[Project Runtime] Start failure receipt settlement failed:', receiptError);
            res.status(503).json({
              code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE',
              error: 'The recovered Start action stopped without a durable terminal receipt.',
              detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
              retryable: false,
            });
            return;
          }
        }
        console.error('Project runtime start failed:', e);
        res.status(500).json({
          code: 'PROJECT_RUNTIME_START_FAILED',
          error: 'Failed to start the Project runtime.',
          detail: 'Check the Project start command and runtime logs, then try again.',
          retryable: true,
        });
      }
      return;
    }

    if (action === 'restart') {
      const mutationIdentity = requireRuntimeMutationIdentity();
      if (!managerStatus) {
        res.status(409).json({
          code: 'PROJECT_RUNTIME_RECOVERY_REQUIRED',
          error: 'Portal no longer has a live manager record for this Project runtime.',
          detail: 'Use Start to rebuild the Portal runtime, or Stop to clear its saved running state.',
          runtimeManagement,
          persistedStatus: app.processStatus || null,
          recoveryRequired,
          supportedActions,
          retryable: true,
        });
        return;
      }
      if (!app.port || !app.zipPath) {
        res.status(400).json({ error: 'App not properly configured (missing port or path)' });
        return;
      }
      if (!await ensureRuntimeImageForProcessAction('restart', mutationIdentity)) return;
      const admission = await admitProcessAction();
      if (admission.responded) return;
      try {
        await restartApp(app.id, deployId, app.zipPath, app.port, {
          actorId: ownerId,
          projectId: mutationIdentity.id,
          projectGeneration: mutationIdentity.generation,
          appName: app.name,
          lifecycleLock: releaseProjectNameLock!,
        });
        const responseBody = {
          ...(getAppStatus(deployId) || { logs: [], restartCount: 0 }),
          message: 'Restarted',
          status: 'running',
          persistedStatus: 'running',
          statusSource: 'portal-manager',
          recoveryRequired: false,
          port: app.port,
          deployType: 'fullstack',
          runtimeManagement,
          supportedActions: [...acceptedActions],
        };
        if (recoveryReplay) {
          if (!admission.recoveryRevision) {
            throw new ProjectRuntimeRecoveryReplayError(
              'PROJECT_RUNTIME_RECOVERY_STATE_INVALID',
              'Project runtime recovery completed without a durable claim',
              503,
            );
          }
          try {
            await completeProjectRuntimeRecoveryOrThrow(
              ownerId,
              recoveryReplay,
              projectRuntimeRecoveryCompletion({
                replay: recoveryReplay,
                deploymentRevision: admission.recoveryRevision,
                appId: app.id,
              }),
            );
          } catch (completionError) {
            console.error('[Project Runtime] Restart receipt completion failed:', completionError);
            res.status(503).json({
              code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE',
              error: 'The Project runtime restarted, but Portal could not confirm its recovery receipt.',
              detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
              retryable: false,
            });
            return;
          }
        }
        res.json(responseBody);
      } catch (e: any) {
        if (recoveryReplay && admission.recoveryRevision) {
          try {
            await failProjectRuntimeRecoveryOrThrow(
              ownerId,
              recoveryReplay,
              isProjectRuntimeImageUnavailable(e)
                ? 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE'
                : 'PROJECT_RUNTIME_RESTART_FAILED',
            );
          } catch (receiptError) {
            console.error('[Project Runtime] Restart failure receipt settlement failed:', receiptError);
            res.status(503).json({
              code: 'PROJECT_RUNTIME_RECOVERY_INDETERMINATE',
              error: 'The recovered Restart action stopped without a durable terminal receipt.',
              detail: 'Refresh Deployment status before taking another action. Portal will not execute this recovery twice.',
              retryable: false,
            });
            return;
          }
        }
        console.error('Project runtime restart failed:', e);
        res.status(500).json({
          code: 'PROJECT_RUNTIME_RESTART_FAILED',
          error: 'Failed to restart the Project runtime.',
          detail: 'Check the Project start command and runtime logs, then try again.',
          retryable: true,
        });
      }
      return;
    }
    
    if (action === 'status' || action === 'logs') {
      const persistedFallbackStatus = recoveryRequired
        ? 'unknown'
        : app.processStatus === 'error'
          ? 'error'
          : app.processStatus === 'stopped'
            ? 'stopped'
            : 'unknown';
      res.json({
        ...(managerStatus || {
          status: persistedFallbackStatus,
          logs: [],
          restartCount: 0,
        }),
        persistedStatus: app.processStatus || null,
        statusSource: managerStatus ? 'portal-manager' : 'persisted-app',
        recoveryRequired,
        deployType: 'fullstack',
        runtimeManagement,
        supportedActions,
      });
      return;
    }
  } catch (error: any) {
    console.error('App process error:', error);
    if (sendProjectRuntimeRecoveryReplayError(res, error)) return;
    if (error instanceof ProjectDeploymentReplayStaleError) {
      res.status(409).json({
        code: error.code,
        error: error.message,
        detail: 'Refresh this Project and use its current Deployment controls.',
        retryable: false,
      });
      return;
    }
    if (error instanceof ProjectRuntimeStateAttestationError) {
      res.status(409).json({
        code: error.code,
        error: error.message,
        retryable: error.retryable,
        recoveryAction: 'REVIEW_RUNTIME_STATE',
      });
      return;
    }
    res.status(500).json({
      code: 'PROJECT_RUNTIME_REQUEST_FAILED',
      error: 'The Project runtime request could not be completed.',
      detail: 'Refresh the Project and try the action again.',
      retryable: true,
    });
  } finally {
    releaseProjectNameLock?.();
  }
});
// POST /api/projects/:name/doc-update - auto-update documentation
router.post('/:name/doc-update', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseProjectFileMutationLock: ProjectDeletionLockLease | null = null;
  try {
    const ownerId = await getScopedOwnerId(req);
    releaseProjectFileMutationLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, req.params.name),
    );
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });
    const gitScope = { actorId: req.user!.userId, projectId: projectIdentity.id };

    const { type, description, details } = req.body;
    const allowedTypes = new Set(['fix', 'feature', 'deployment', 'note']);
    if (!allowedTypes.has(type)) {
      res.status(400).json({ error: 'type must be fix, feature, deployment, or note' });
      return;
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 2000) {
      res.status(400).json({ error: 'description must be between 1 and 2000 characters' });
      return;
    }
    if (details !== undefined && (typeof details !== 'string' || details.length > 20_000)) {
      res.status(400).json({ error: 'details must be a string of at most 20000 characters' });
      return;
    }
    
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `\n## ${type === 'fix' ? '🔧 Fix' : type === 'feature' ? '✨ Feature' : type === 'deployment' ? '🚀 Deployment' : '📝 Note'} - ${timestamp}\n\n${description.trim()}\n${details?.trim() ? `\n${details.trim()}\n` : ''}`;
    
    // Update NOTES.md
    let notesContent = readProjectTextFile(projectDir, 'NOTES.md', {
      optional: true,
      maxBytes: PROJECT_DOCUMENT_MAX_BYTES,
    }) || `# ${req.params.name} - Development Notes\n`;
    notesContent += entry;

    // Update README.md changelog section if exists
    let readmeContent = readProjectTextFile(projectDir, 'README.md', {
      optional: true,
      maxBytes: PROJECT_DOCUMENT_MAX_BYTES,
    });
    if (readmeContent !== null) {
      const changelogHeader = '## Changelog';
      if (!readmeContent.includes(changelogHeader)) {
        readmeContent += `\n\n${changelogHeader}\n`;
      }
      const changelogLine = `\n- **${timestamp}** - ${type}: ${description.trim()}`;
      readmeContent = readmeContent.replace(changelogHeader, changelogHeader + changelogLine);
    }

    for (const [fileName, content] of [
      ['NOTES.md', notesContent],
      ...(readmeContent === null ? [] : [['README.md', readmeContent]]),
    ] as Array<[string, string]>) {
      if (Buffer.byteLength(content, 'utf8') > PROJECT_DOCUMENT_MAX_BYTES) {
        throw new ProjectFilePolicyError(
          'TOO_LARGE',
          `${fileName} would exceed the ${PROJECT_DOCUMENT_MAX_BYTES}-byte document limit`,
        );
      }
    }

    // All final sizes and both existing files are preflighted before writing.
    // Each replacement is atomic and rejects repository-controlled links.
    writeProjectRuntimeTextFile(projectDir, 'NOTES.md', notesContent, PROJECT_DOCUMENT_MAX_BYTES);
    if (readmeContent !== null) {
      writeProjectRuntimeTextFile(projectDir, 'README.md', readmeContent, PROJECT_DOCUMENT_MAX_BYTES);
    }
    
    // Auto-commit the doc changes
    const hasGit = fs.existsSync(path.join(projectDir, '.git'));
    if (hasGit) {
      try {
        await runProjectGitCommand({ ...gitScope, workspace: projectDir, args: ['add', '--', 'NOTES.md', 'README.md'], timeoutMs: 5000 });
        await runProjectGitCommand({
          ...gitScope,
          workspace: projectDir,
          args: ['commit', '-m', `docs: ${type} - ${(description || '').substring(0, 50)}`],
          timeoutMs: 5000,
        });
      } catch {}
    }
    
    res.json({ message: 'Documentation updated' });
  } catch (error) {
    console.error('Doc update error:', error);
    sendProjectFileMutationError(res, error, 'Failed to update documentation');
  } finally {
    releaseProjectFileMutationLock?.();
  }
});

// POST /api/projects/:name/share - create share link for project
router.post('/:name/share', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const unavailable = portalFeatureUnavailableResponse('appHosting');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
      projectRoot: projectDir,
    });

    // Ensure deployed
    const deployId = `${ownerId}-${req.params.name}`;
    const deployPath = path.join(DEPLOY_DIR, deployId);
    if (!fs.existsSync(deployPath)) {
      res.status(400).json({ error: 'Deploy the project first before sharing' });
      return;
    }

    // Find or create App record
    let app = await findProjectAppForIdentity({
      workspaceOwnerId: ownerId,
      projectIdentityId: projectIdentity.id,
      projectName: req.params.name,
      deployPath,
    });
    if (!app && await prisma.app.count({
      where: { userId: ownerId, name: req.params.name },
    }) > 0) {
      res.status(409).json({
        error: 'A standalone App already uses this Project name and cannot be shared implicitly.',
      });
      return;
    }

    if (!app) {
      app = await prisma.app.create({
        data: {
          userId: ownerId,
          projectIdentityId: projectIdentity.id,
          name: req.params.name,
          description: `Project ${req.params.name}`,
          zipPath: deployPath,
          isActive: true,
        },
      });
    } else if (app.projectIdentityId !== projectIdentity.id) {
      app = await prisma.app.update({
        where: { id: app.id },
        data: { projectIdentityId: projectIdentity.id },
      });
    }

    const token = nanoid(21);
    const isPublic = req.body.isPublic !== false; // default true
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    let shareOptions;
    try {
      shareOptions = parseShareLinkOptions(req.body || {});
    } catch (error: any) {
      res.status(400).json({ error: error.message });
      return;
    }

    // Validate password if password-protected
    let passwordHash: string | null = null;
    if (!isPublic && password) {
      try {
        validateSharePassword(password);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
        return;
      }
      passwordHash = await bcrypt.hash(password, 12);
    } else if (!isPublic && !password) {
      res.status(400).json({ error: 'Password required for password-protected links' });
      return;
    } else if (password) {
      res.status(400).json({
        error: 'A share password requires a private link. Send isPublic: false with the password.',
        code: 'SHARE_PASSWORD_REQUIRES_PRIVATE_LINK',
      });
      return;
    }

    const shareLink = await prisma.appShareLink.create({
      data: {
        appId: app.id,
        userId: ownerId,
        token,
        expiresAt: shareOptions.expiresAt,
        maxUses: shareOptions.maxUses,
        rateLimitMaxRequests: shareOptions.rateLimitMaxRequests,
        rateLimitWindowSeconds: shareOptions.rateLimitWindowSeconds,
        isPublic,
        passwordHash,
      },
    });

    // Don't leak passwordHash to frontend
    const { passwordHash: _, ...safeLinkData } = shareLink;

    res.status(201).json({ 
      shareLink: safeLinkData, 
      url: `/share/${token}`,
      hostedUrl: `/hosted/${deployId}/`,
    });
  } catch (error) {
    console.error('Create share link error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// GET /api/projects/:name/shares - list share links
router.get('/:name/shares', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const app = await prisma.app.findFirst({
      where: { userId: ownerId, name: req.params.name },
      include: { shareLinks: { orderBy: { createdAt: 'desc' } } },
    });

    // Strip passwordHash from response
    const shares = (app?.shareLinks || []).map(({ passwordHash: _passwordHash, ...rest }) => rest);
    res.json({ shares });
  } catch {
    res.status(500).json({ error: 'Failed to list shares' });
  }
});

async function findOwnedShareLink(ownerId: string, projectName: string, linkId: string) {
  return prisma.appShareLink.findFirst({
    where: {
      id: linkId,
      userId: ownerId,
      app: {
        userId: ownerId,
        name: projectName,
      },
    },
  });
}

// PATCH /api/projects/:name/share/:linkId - update share link (public ↔ secure, active toggle)
router.patch('/:name/share/:linkId', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { isPublic, password, isActive } = req.body;
    if (password !== undefined && isPublic !== false) {
      res.status(400).json({
        error: 'A share password requires a private link. Send isPublic: false with the password.',
        code: 'SHARE_PASSWORD_REQUIRES_PRIVATE_LINK',
      });
      return;
    }
    const cleanupOnly = isActive === false && isPublic === undefined && password === undefined;
    if (!cleanupOnly) {
      const unavailable = portalFeatureUnavailableResponse('appHosting');
      if (unavailable) {
        res.status(409).json(unavailable);
        return;
      }
    }
    const ownerId = await getScopedOwnerId(req);
    const existingLink = await findOwnedShareLink(ownerId, req.params.name, req.params.linkId);
    if (!existingLink) {
      res.status(404).json({ error: 'Share link not found' });
      return;
    }

    const updateData: any = {};

    if (typeof isActive === 'boolean') {
      updateData.isActive = isActive;
    }

    if (isPublic === true) {
      updateData.isPublic = true;
      updateData.passwordHash = null;
    } else if (isPublic === false) {
      try {
        validateSharePassword(password);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
        return;
      }
      updateData.isPublic = false;
      updateData.passwordHash = await bcrypt.hash(password, 12);
    }

    const prospectiveCredentialState = {
      isPublic: updateData.isPublic ?? existingLink.isPublic,
      passwordHash: updateData.passwordHash !== undefined
        ? updateData.passwordHash
        : existingLink.passwordHash,
    };
    if (!shareCredentialStateIsValid(prospectiveCredentialState)) {
      res.status(409).json({
        error: 'Share link credential state is invalid; choose public or set a new private-link password',
        code: 'SHARE_CREDENTIAL_STATE_INVALID',
      });
      return;
    }

    const link = await prisma.appShareLink.update({
      where: { id: existingLink.id },
      data: updateData,
    });

    const { passwordHash: _, ...safeLink } = link;
    res.json({ shareLink: safeLink });
  } catch {
    res.status(500).json({ error: 'Failed to update share link' });
  }
});

// DELETE /api/projects/:name/share/:linkId - delete share link permanently
router.delete('/:name/share/:linkId', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { permanent } = req.query;
    const existingLink = await findOwnedShareLink(ownerId, req.params.name, req.params.linkId);
    if (!existingLink) {
      res.status(404).json({ error: 'Share link not found' });
      return;
    }

    if (permanent === 'true') {
      await prisma.appShareLink.delete({
        where: { id: existingLink.id },
      });
      res.json({ message: 'Share link deleted permanently' });
    } else {
      await prisma.appShareLink.update({
        where: { id: existingLink.id },
        data: { isActive: false },
      });
      res.json({ message: 'Share link revoked' });
    }
  } catch {
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

// POST /api/projects/:name/share/:linkId/email - send share link via email
router.post('/:name/share/:linkId/email', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const hostingUnavailable = portalFeatureUnavailableResponse('appHosting');
    if (hostingUnavailable) {
      res.status(409).json(hostingUnavailable);
      return;
    }
    const mailUnavailable = portalFeatureUnavailableResponse('mail');
    if (mailUnavailable) {
      res.status(409).json(mailUnavailable);
      return;
    }
    const ownerId = await getScopedOwnerId(req);
    const { recipientEmail } = req.body;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'password')) {
      res.status(400).json({ error: 'Share passwords are never accepted by email endpoints; send them through a separate channel' });
      return;
    }
    if (!recipientEmail || typeof recipientEmail !== 'string' || recipientEmail.length > 320) {
      res.status(400).json({ error: 'recipientEmail is required' }); return;
    }
    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      res.status(400).json({ error: 'Invalid email address' }); return;
    }

    const link = await findOwnedShareLink(ownerId, req.params.name, req.params.linkId);
    if (!link) {
      res.status(404).json({ error: 'Share link not found' }); return;
    }
    const availability = shareLinkAvailability(link);
    if (availability !== 'active') {
      res.status(409).json({ error: `Share link is ${availability}. Create a new active link before emailing it.` });
      return;
    }

    const siteUrl = process.env.PORTAL_URL || 'https://localhost';
    const shareUrl = `${siteUrl}/share/${link.token}`;

    const senderEmail = req.user!.email;
    const senderUser = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { username: true },
    });
    const senderUsername = senderUser?.username?.trim() || 'Portal User';

    const { sendShareLinkEmail } = await import('../services/notificationService');
    const { getUserMailCredentials } = await import('../services/userMailService');
    const mailCreds = await getUserMailCredentials(ownerId);
    await sendShareLinkEmail(
      {
        senderName: senderUsername,
        senderEmail,
        recipientEmail,
        appName: req.params.name,
        shareUrl,
        isPasswordProtected: !link.isPublic,
      },
      mailCreds,
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Share link email error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// POST /api/projects/:name/rename-file - rename/move file
router.post('/:name/rename-file', authenticateToken, requireApproved, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

    await withProjectDeletionLock({
      workspaceOwnerId: ownerId,
      projectName: req.params.name,
    }, async () => {
      const projectDir = getProjectPath(ownerId, req.params.name);
      if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
      let resolvedOld: string;
      let resolvedNew: string;
      try {
        resolvedOld = resolveExistingProjectEntry(projectDir, oldPath, 'any');
        resolvedNew = resolveProjectTarget(projectDir, newPath);
      } catch (error) {
        if (error instanceof ProjectRuntimeOwnershipError) throw error;
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (fs.existsSync(resolvedNew)) { res.status(409).json({ error: 'Destination already exists' }); return; }

      const oldEntry = fs.lstatSync(resolvedOld);
      if (oldEntry.isDirectory() && resolvedNew.startsWith(`${resolvedOld}${path.sep}`)) {
        res.status(400).json({ error: 'A folder cannot be moved inside itself' });
        return;
      }

      try {
        const newParent = path.posix.dirname(String(newPath).replace(/\\/g, '/'));
        if (newParent !== '.') ensureProjectRuntimeOwnedDirectory(projectDir, newParent);
        resolvedNew = resolveProjectTarget(projectDir, newPath);
      } catch (error) {
        if (error instanceof ProjectRuntimeOwnershipError) throw error;
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      assignProjectRuntimeOwnership(
        projectDir,
        resolvedOld,
        oldEntry.isDirectory() ? 'directory' : 'file',
      );
      fs.renameSync(resolvedOld, resolvedNew);
      res.json({ message: 'Renamed' });
    });
  } catch (error) {
    sendProjectFileMutationError(res, error, 'Failed to rename');
  }
});

// --- Provider-neutral Project Chat kernel ---

// POST /api/projects/:name/app/rebind-current - recover an existing CURRENT
// copy whose App association was safely quarantined during continuity repair.
router.post('/:name/app/rebind-current', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const releaseProjectLocks: Array<() => void> = [];
  try {
    const workspaceOwnerId = await getScopedOwnerId(req);
    const targetName = String(req.params.name || '');
    const appId = typeof req.body?.appId === 'string' ? req.body.appId.trim() : '';
    const sourceProjectIdentityId = typeof req.body?.sourceProjectId === 'string'
      ? req.body.sourceProjectId.trim()
      : '';
    const targetProjectIdentityId = typeof req.body?.targetProjectId === 'string'
      ? req.body.targetProjectId.trim()
      : '';
    if (
      !appId
      || appId.length > 160
      || !sourceProjectIdentityId
      || sourceProjectIdentityId.length > 160
      || !targetProjectIdentityId
      || targetProjectIdentityId.length > 160
      || /[\u0000-\u001f\u007f]/.test(`${appId}${sourceProjectIdentityId}${targetProjectIdentityId}`)
    ) {
      res.status(400).json({
        code: 'PROJECT_APP_REBIND_INPUT_INVALID',
        error: 'Exact appId, sourceProjectId, and targetProjectId are required.',
        retryable: false,
      });
      return;
    }
    const initialSourceIdentity = await prisma.projectIdentity.findUnique({
      where: { id: sourceProjectIdentityId },
    });
    if (
      !initialSourceIdentity
      || initialSourceIdentity.workspaceOwnerId !== workspaceOwnerId
    ) throw new ProjectAppIdentityRebindError('The source was not the exact active legacy Project.');
    const lockKeys = Array.from(new Set([
      projectDeletionLockKey(workspaceOwnerId, initialSourceIdentity.projectName),
      projectDeletionLockKey(workspaceOwnerId, targetName),
    ])).sort();
    for (const key of lockKeys) releaseProjectLocks.push(await acquireProjectDeletionLock(key));

    const targetProjectRoot = getProjectPath(workspaceOwnerId, targetName);
    if (!fs.existsSync(targetProjectRoot)) {
      res.status(404).json({ error: 'Target Project not found' });
      return;
    }
    const targetIdentity = await ensureProjectIdentity({
      workspaceOwnerId,
      projectName: targetName,
      projectRoot: targetProjectRoot,
    });
    if (
      targetIdentity.id !== targetProjectIdentityId
      || targetIdentity.legacyOpenClawMigrationStatus !== 'CURRENT'
      || targetIdentity.lifecycleStatus !== 'ACTIVE'
    ) throw new ProjectAppIdentityRebindError('The target was not the exact active CURRENT Project.');
    const sourceIdentity = await prisma.projectIdentity.findUnique({
      where: { id: sourceProjectIdentityId },
    });
    if (
      !sourceIdentity
      || sourceIdentity.workspaceOwnerId !== workspaceOwnerId
      || sourceIdentity.projectName !== initialSourceIdentity.projectName
      || sourceIdentity.legacyOpenClawMigrationStatus === 'CURRENT'
      || sourceIdentity.lifecycleStatus !== 'ACTIVE'
    ) throw new ProjectAppIdentityRebindError('The source was not the exact active legacy Project.');
    const sourceProjectRoot = sourceIdentity.canonicalRoot;
    const sourceDeployPath = path.join(
      DEPLOY_DIR,
      `${workspaceOwnerId}-${sourceIdentity.projectName}`,
    );
    const targetDeployPath = path.join(DEPLOY_DIR, `${workspaceOwnerId}-${targetName}`);
    const journal = readProjectAppRebindOperation({
      workspaceOwnerId,
      sourceProjectIdentityId: sourceIdentity.id,
      sourceProjectName: sourceIdentity.projectName,
      sourceProjectRoot,
    });
    if (!journal || journal.operationKind !== 'PROJECT_APP_REBIND') {
      throw new ProjectAppIdentityRebindError(
        'No durable Project migration receipt authorizes this App rebind.',
      );
    }
    assertProjectMigrationTargetOwnedByOperation(journal, targetIdentity);
    const app = await prisma.app.findUnique({ where: { id: appId } });
    if (
      !app
      || app.userId !== workspaceOwnerId
      || (journal !== null && journal.appId !== app.id)
    ) throw new ProjectAppIdentityRebindError('The App did not match the exact source or quarantined target state.');
    const management = projectRuntimeManagement(app);
    if (management === 'desktop-session' || management === 'invalid-external-binding') {
      throw new ProjectAppIdentityRebindError('The App runtime ownership was not eligible for rebind.');
    }
    const rebound = await rebindLegacyProjectAppToCurrentCopy({
      workspaceOwnerId,
      appId: app.id,
      sourceProjectIdentityId: sourceIdentity.id,
      sourceProjectName: sourceIdentity.projectName,
      sourceAppName: journal.sourceAppName,
      sourceProjectRoot,
      sourceDeployPath: journal.sourceDeployPath,
      targetProjectIdentityId: targetIdentity.id,
      targetProjectName: targetName,
      targetProjectRoot,
      targetDeployPath,
    });
    await prisma.activityLog.create({
      data: {
        userId: workspaceOwnerId,
        action: 'PROJECT_APP_IDENTITY_REBIND',
        resource: 'app',
        resourceId: rebound.appId,
        severity: 'INFO',
        metadata: {
          sourceProjectId: sourceIdentity.id,
          targetProjectId: targetIdentity.id,
          targetProjectName: targetName,
          shareLinksPreserved: rebound.shareLinksPreserved,
        },
      },
    }).catch((activityError) => {
      console.warn('[ProjectAppRebind] Failed to record activity:', activityError);
    });
    res.json({
      rebound: true,
      appId: rebound.appId,
      sourceProjectId: sourceIdentity.id,
      targetProjectId: targetIdentity.id,
      targetProjectName: targetName,
      shareLinksPreserved: rebound.shareLinksPreserved,
    });
  } catch (error) {
    const rebindError = error instanceof ProjectAppIdentityRebindError ? error : null;
    console.error('[ProjectAppRebind]', JSON.stringify({
      route: 'project-app-rebind-current',
      projectName: req.params.name,
      code: rebindError?.code || 'PROJECT_APP_REBIND_FAILED',
      detail: rebindError?.message || 'App identity rebind failed',
    }));
    res.status(rebindError ? 409 : 503).json({
      code: rebindError?.code || 'PROJECT_APP_REBIND_FAILED',
      error: rebindError?.message || 'Portal could not safely rebind this App.',
      retryable: false,
    });
  } finally {
    while (releaseProjectLocks.length > 0) releaseProjectLocks.pop()?.();
  }
});

// POST /api/projects/:name/chat/migrate-legacy - publish a verified CURRENT copy
router.post('/:name/chat/migrate-legacy', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let createdProjectDir: string | undefined;
  let createdProjectRootIdentity: AttestedProjectRoot | undefined;
  let createdProjectIdentityId: string | undefined;
  let appRebindCommitted = false;
  const releaseProjectLocks: Array<() => void> = [];
  let successResponse: {
    migrated: true;
    projectId: string;
    projectName: string;
    sourceProjectId: string;
    sourceProjectName: string;
    generation: number;
    alreadyCurrent: false;
    integrity: {
      fileCount: number;
      totalBytes: number;
      manifestSha256: string;
    };
    appRebind?: {
      appId: string;
      shareLinksPreserved: number;
    };
  } | undefined;
  try {
    const { name } = req.params;
    const {
      workspaceOwnerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const initialProjectIdentity = await ensureProjectIdentity({
      workspaceOwnerId,
      projectName: name,
      projectRoot: projectDir,
    });
    if (initialProjectIdentity.legacyOpenClawMigrationStatus === 'CURRENT') {
      res.status(409).json({
        error: 'This Project is already prepared for Portal 4 Project Chat.',
        code: 'PROJECT_ALREADY_CURRENT',
        retryable: false,
      });
      return;
    }
    let operation = readProjectAppRebindOperation({
      workspaceOwnerId,
      sourceProjectIdentityId: initialProjectIdentity.id,
      sourceProjectName: name,
      sourceProjectRoot: projectDir,
    });
    const safeSourceName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 86) || 'project';
    const sourceSuffix = initialProjectIdentity.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'legacy';
    let targetName = operation?.targetProjectName || '';
    let targetRoot = operation?.targetProjectRoot || '';
    const releaseAllProjectLocks = () => {
      while (releaseProjectLocks.length > 0) releaseProjectLocks.pop()?.();
    };
    const acquireProjectPair = async (candidate: string) => {
      const keys = Array.from(new Set([
        projectDeletionLockKey(workspaceOwnerId, name),
        projectDeletionLockKey(workspaceOwnerId, candidate),
      ])).sort();
      for (const key of keys) releaseProjectLocks.push(await acquireProjectDeletionLock(key));
    };
    if (operation) {
      if (targetRoot !== getProjectPath(workspaceOwnerId, targetName)) {
        throw new ProjectAppIdentityRebindError('The durable target Project path changed.');
      }
      await acquireProjectPair(targetName);
    } else {
      for (let attempt = 1; attempt <= 100; attempt += 1) {
        const attemptSuffix = attempt === 1 ? '' : `_${attempt}`;
        const candidate = `${safeSourceName}_Portal4_${sourceSuffix}${attemptSuffix}`.slice(0, 120);
        const candidateRoot = getProjectPath(workspaceOwnerId, candidate);
        await acquireProjectPair(candidate);
        const lockedSource = await prisma.projectIdentity.findUnique({
          where: { id: initialProjectIdentity.id },
        });
        if (
          !lockedSource
          || lockedSource.workspaceOwnerId !== workspaceOwnerId
          || lockedSource.projectName !== name
          || lockedSource.canonicalRoot !== projectDir
          || lockedSource.lifecycleStatus !== 'ACTIVE'
          || lockedSource.legacyOpenClawMigrationStatus === 'CURRENT'
        ) throw new ProjectAppIdentityRebindError('The source Project changed before migration admission.');
        let available = !fs.existsSync(candidateRoot);
        if (available) {
          try {
            await assertProjectIdentityNameAvailable({ workspaceOwnerId, projectName: candidate });
          } catch (error) {
            if (error instanceof ProjectIdentityLifecycleError) available = false;
            else throw error;
          }
        }
        if (available) {
          targetName = candidate;
          targetRoot = candidateRoot;
          break;
        }
        releaseAllProjectLocks();
      }
    }
    if (!targetName || !targetRoot || releaseProjectLocks.length === 0) {
      throw new ProjectLegacyAdoptionError(
        'Portal could not reserve a safe name for the Project Chat copy.',
        'MIGRATION_BUSY',
        true,
      );
    }
    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId,
      projectName: name,
      projectRoot: projectDir,
    });
    if (
      projectIdentity.id !== initialProjectIdentity.id
      || projectIdentity.legacyOpenClawMigrationStatus === 'CURRENT'
      || projectIdentity.lifecycleStatus !== 'ACTIVE'
    ) throw new ProjectAppIdentityRebindError('The source Project changed before migration admission.');

    operation = readProjectAppRebindOperation({
      workspaceOwnerId,
      sourceProjectIdentityId: projectIdentity.id,
      sourceProjectName: name,
      sourceProjectRoot: projectDir,
    });
    if (operation && (
      operation.targetProjectName !== targetName
      || operation.targetProjectRoot !== targetRoot
    )) throw new ProjectAppIdentityRebindError('Another durable App rebind target won admission.');

    // An App transfer is explicit and identity-scoped. Once admitted, retries
    // follow the journal's immutable App id even after the row has been rebound.
    const sourceAppRows = operation?.operationKind === 'PROJECT_APP_REBIND'
      ? [await prisma.app.findUnique({ where: { id: operation.appId! } })].filter(Boolean)
      : await prisma.app.findMany({
        where: { userId: workspaceOwnerId, name },
        orderBy: { id: 'asc' },
        take: 3,
      });
    if (sourceAppRows.length > 1) {
      throw new ProjectAppIdentityRebindError('More than one App claimed the legacy Project name.');
    }
    const sourceApp = sourceAppRows[0] || null;
    if (operation?.operationKind === 'PROJECT_APP_REBIND' && !sourceApp) {
      throw new ProjectAppIdentityRebindError('The admitted App disappeared before rebind recovery.');
    }
    if (operation?.operationKind === 'PROJECT_COPY' && sourceApp) {
      throw new ProjectAppIdentityRebindError('An App appeared after the Project-only migration was admitted.');
    }
    const exactSourceDeployPath = path.join(DEPLOY_DIR, `${workspaceOwnerId}-${name}`);
    if (!operation && sourceApp && (
      sourceApp.userId !== workspaceOwnerId
      || sourceApp.zipPath !== exactSourceDeployPath
      || sourceApp.name !== name
      || (sourceApp.projectIdentityId !== null && sourceApp.projectIdentityId !== projectIdentity.id)
    )) throw new ProjectAppIdentityRebindError('The same-name App did not match the exact legacy Project.');
    if (sourceApp) {
      const sourceAppManagement = projectRuntimeManagement(sourceApp);
      if (
        sourceAppManagement === 'desktop-session'
        || sourceAppManagement === 'invalid-external-binding'
      ) throw new ProjectAppIdentityRebindError('The App runtime ownership was not eligible for migration.');
    }
    if (!operation) {
      const operationInput = {
        workspaceOwnerId,
        sourceProjectIdentityId: projectIdentity.id,
        sourceProjectName: name,
        sourceProjectRoot: projectDir,
        sourceDeployPath: sourceApp?.zipPath || exactSourceDeployPath,
        targetProjectName: targetName,
        targetProjectRoot: targetRoot,
        targetDeployPath: path.join(DEPLOY_DIR, `${workspaceOwnerId}-${targetName}`),
      };
      operation = sourceApp
        ? beginProjectAppRebindOperation({
          ...operationInput,
          appId: sourceApp.id,
          sourceAppName: sourceApp.name,
        })
        : beginProjectCopyOperation(operationInput);
    }

    let currentIdentity: ProjectIdentityRecord | null = await prisma.projectIdentity.findUnique({
      where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName: targetName } },
    });
    if (currentIdentity) {
      if (
        currentIdentity.workspaceOwnerId !== workspaceOwnerId
        || currentIdentity.projectName !== targetName
        || currentIdentity.legacyOpenClawMigrationStatus !== 'CURRENT'
      ) throw new ProjectIdentityLifecycleError('The reserved target Project identity changed.');
      if (operation) assertProjectMigrationTargetOwnedByOperation(operation, currentIdentity);
      if (currentIdentity.lifecycleStatus === 'CREATING') {
        const stagedExists = managedPathExists(currentIdentity.canonicalRoot);
        const finalExists = managedPathExists(targetRoot);
        if (stagedExists && finalExists) {
          throw new ProjectIdentityLifecycleError('Interrupted Project creation has both staged and final roots');
        }
        if (finalExists) {
          const finalIdentity = attestProjectRoot(targetRoot);
          if (!sameAttestedDirectoryIdentity(currentIdentity, finalIdentity)) {
            throw new ProjectIdentityLifecycleError('Interrupted Project final root changed before recovery');
          }
          await assertNoLegacyOpenClawProjectCreationCollision({
            workspaceOwnerId,
            projectName: targetName,
            projectRoot: targetRoot,
          });
          currentIdentity = await finalizeCurrentProjectIdentityCreation({
            projectIdentityId: currentIdentity.id,
            projectRoot: targetRoot,
          });
        } else if (
          stagedExists
          && operation?.projectManifest
          && currentIdentity.id === operation.operationId
          && currentIdentity.canonicalRoot === projectAppRebindStagingDirectory(operation.operationId)
        ) {
          const stagedIdentity = attestProjectRoot(currentIdentity.canonicalRoot);
          if (!sameAttestedDirectoryIdentity(currentIdentity, stagedIdentity)) {
            throw new ProjectIdentityLifecycleError('Interrupted Project staging identity changed before recovery');
          }
          verifyProjectLegacyAdoptionManifestSummary(
            currentIdentity.canonicalRoot,
            operation.projectManifest,
          );
          await assertNoLegacyOpenClawProjectCreationCollision({
            workspaceOwnerId,
            projectName: targetName,
            projectRoot: currentIdentity.canonicalRoot,
          });
          moveAttestedDirectoryNoReplace({
            sourceRoot: currentIdentity.canonicalRoot,
            targetRoot,
            expectedIdentity: currentIdentity,
          });
          currentIdentity = await finalizeCurrentProjectIdentityCreation({
            projectIdentityId: currentIdentity.id,
            projectRoot: targetRoot,
          });
        } else {
          await discardFailedCurrentProjectCreation({
            projectIdentityId: currentIdentity.id,
            ...(stagedExists ? {
              directory: currentIdentity.canonicalRoot,
              expectedDirectoryIdentity: currentIdentity,
            } : {}),
          });
          currentIdentity = null;
        }
      } else if (currentIdentity.lifecycleStatus === 'ACTIVE') {
        const verified = await ensureProjectIdentity({
          workspaceOwnerId,
          projectName: targetName,
          projectRoot: targetRoot,
        });
        if (verified.id !== currentIdentity.id) {
          throw new ProjectIdentityLifecycleError('The target Project identity changed during recovery');
        }
        currentIdentity = verified;
        if (!operation?.projectManifest) {
          throw new ProjectIdentityLifecycleError('The target Project has no durable copy manifest.');
        }
        verifyProjectLegacyAdoptionManifestSummary(targetRoot, operation.projectManifest);
      } else {
        throw new ProjectIdentityLifecycleError('The target Project is not recoverable for App rebind');
      }
    }

    let manifest = operation?.projectManifest || null;
    if (!currentIdentity) {
      if (managedPathExists(targetRoot)) {
        throw new ProjectIdentityLifecycleError('The reserved target Project root is already occupied');
      }
      if (operation) {
        const claimedStagingRoot = projectAppRebindStagingDirectory(operation.operationId);
        const stagingOwner = await prisma.projectIdentity.findFirst({
          where: { workspaceOwnerId, canonicalRoot: claimedStagingRoot },
        });
        if (stagingOwner) {
          throw new ProjectIdentityLifecycleError(
            'The Project App rebind staging root is owned by another immutable identity',
          );
        }
      }
      const durableStagingRoot = operation
        ? projectAppRebindStagingDirectory(operation.operationId)
        : null;
      let durableStagingExisted = Boolean(
        durableStagingRoot && managedPathExists(durableStagingRoot),
      );
      if (
        durableStagingExisted
        && durableStagingRoot
        && !operation?.projectManifest
      ) {
        const interrupted = attestProjectRoot(durableStagingRoot);
        if (interrupted.canonicalRoot !== durableStagingRoot) {
          throw new ProjectIdentityLifecycleError('Interrupted Project copy staging is unsafe');
        }
        fs.rmSync(durableStagingRoot, { recursive: true, force: false });
        durableStagingExisted = false;
      }
      const stagingRoot = durableStagingRoot && durableStagingExisted
        ? attestProjectRoot(durableStagingRoot).canonicalRoot
        : operation
          ? createProjectAppRebindStagingDirectory(operation.operationId)
          : createProjectCreationStagingDirectory();
      createdProjectDir = stagingRoot;
      manifest = prepareProjectLegacyAdoptionStaging({
        sourceRoot: projectDir,
        stagingRoot,
        stagedCopyExisted: durableStagingExisted,
        durableManifest: operation?.projectManifest,
      });
      if (operation && !operation.projectManifest) {
        const manifestSummary = {
          fileCount: manifest.fileCount,
          totalBytes: manifest.totalBytes,
          sha256: manifest.sha256,
        };
        operation = recordProjectAppRebindManifest({
          sourceProjectIdentityId: projectIdentity.id,
          manifest: manifestSummary,
        });
      }
      createdProjectRootIdentity = attestProjectRoot(stagingRoot);
      await assertNoLegacyOpenClawProjectCreationCollision({
        workspaceOwnerId,
        projectName: targetName,
        projectRoot: stagingRoot,
      });
      const copiedIdentity = await createCurrentProjectIdentity({
        workspaceOwnerId,
        projectName: targetName,
        projectRoot: stagingRoot,
        ...(operation ? { projectIdentityId: operation.operationId } : {}),
      });
      createdProjectIdentityId = copiedIdentity.id;
      await assertNoLegacyOpenClawProjectCreationCollision({
        workspaceOwnerId,
        projectName: targetName,
        projectRoot: stagingRoot,
      });
      moveAttestedDirectoryNoReplace({ sourceRoot: stagingRoot, targetRoot, expectedIdentity: copiedIdentity });
      createdProjectDir = targetRoot;
      currentIdentity = await finalizeCurrentProjectIdentityCreation({
        projectIdentityId: copiedIdentity.id,
        projectRoot: targetRoot,
      });
    }
    if (!currentIdentity) {
      throw new ProjectIdentityLifecycleError('The target Project identity was not recovered');
    }
    if (!manifest) {
      throw new ProjectAppIdentityRebindError('The durable Project copy manifest is unavailable.');
    }
    if (operation && operation.targetProjectIdentityId !== currentIdentity.id) {
      operation = bindProjectAppRebindTarget({
        sourceProjectIdentityId: projectIdentity.id,
        targetProjectIdentityId: currentIdentity.id,
      });
    }
    if (operation?.projectManifest) {
      verifyProjectLegacyAdoptionManifestSummary(targetRoot, operation.projectManifest);
    }
    let appRebind: { appId: string; shareLinksPreserved: number } | undefined;
    if (sourceApp) {
      if (!operation || operation.operationKind !== 'PROJECT_APP_REBIND' || !operation.appId) {
        throw new ProjectAppIdentityRebindError('The App rebind journal is unavailable.');
      }
      appRebind = await rebindLegacyProjectAppToCurrentCopy({
        workspaceOwnerId,
        appId: operation.appId,
        sourceProjectIdentityId: projectIdentity.id,
        sourceProjectName: name,
        sourceAppName: operation.sourceAppName,
        sourceProjectRoot: projectDir,
        sourceDeployPath: operation.sourceDeployPath,
        targetProjectIdentityId: currentIdentity.id,
        targetProjectName: targetName,
        targetProjectRoot: targetRoot,
        targetDeployPath: operation.targetDeployPath,
      });
      appRebindCommitted = true;
    }
    successResponse = {
      migrated: true,
      projectId: currentIdentity.id,
      projectName: targetName,
      sourceProjectId: projectIdentity.id,
      sourceProjectName: name,
      generation: currentIdentity.generation,
      alreadyCurrent: false,
      integrity: {
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        manifestSha256: manifest.sha256,
      },
      ...(appRebind ? { appRebind } : {}),
    };
    console.info('[ProjectLegacyAdoption]', JSON.stringify({
      sourceProjectIdentityId: projectIdentity.id,
      projectIdentityId: currentIdentity.id,
      projectName: targetName,
      generation: currentIdentity.generation,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      manifestSha256: manifest.sha256,
      appId: appRebind?.appId,
      shareLinksPreserved: appRebind?.shareLinksPreserved,
    }));
    await prisma.activityLog.create({
      data: {
        userId: workspaceOwnerId,
        action: 'PROJECT_LEGACY_COPY',
        resource: 'project',
        resourceId: currentIdentity.id,
        severity: 'INFO',
        metadata: {
          sourceProjectId: projectIdentity.id,
          sourceProjectName: name,
          projectName: targetName,
          manifestSha256: manifest.sha256,
        },
      },
    }).catch((error) => {
      console.warn('[ProjectLegacyAdoption] Failed to record activity:', error);
    });
    res.json(successResponse);
    createdProjectDir = undefined;
    createdProjectRootIdentity = undefined;
    createdProjectIdentityId = undefined;
  } catch (error: any) {
    if (appRebindCommitted && successResponse) {
      console.warn('[ProjectLegacyAdoption] App rebind committed before a later response task failed:', error);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) res.json(successResponse);
      return;
    }
    const reconciliation = await reconcileFailedCurrentProjectCreation({
      projectIdentityId: createdProjectIdentityId,
      directory: createdProjectDir,
      expectedDirectoryIdentity: createdProjectRootIdentity,
    }, '[ProjectLegacyAdoption] Staging cleanup failed:');
    if (reconciliation === 'published' && successResponse) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) res.json(successResponse);
      return;
    }
    const adoptionError = error instanceof ProjectLegacyAdoptionError ? error : null;
    const collisionError = error instanceof LegacyOpenClawProjectCreationCollisionError ? error : null;
    const scanError = error instanceof LegacyOpenClawProjectCreationScanCapacityError ? error : null;
    const lifecycleError = error instanceof ProjectIdentityLifecycleError ? error : null;
    const rebindError = error instanceof ProjectAppIdentityRebindError ? error : null;
    const status = adoptionError?.code === 'MIGRATION_BUSY' || collisionError || lifecycleError || rebindError
      ? 409
      : 503;
    const message = adoptionError?.message
      || collisionError?.message
      || scanError?.message
      || lifecycleError?.message
      || rebindError?.message
      || 'Portal could not finish preparing this project. Its original files remain unchanged.';
    const code = adoptionError?.code
      || collisionError?.code
      || scanError?.code
      || (lifecycleError ? 'PROJECT_COPY_NOT_ADMITTED' : 'MIGRATION_FAILED');
    const responseCode = rebindError?.code || code;
    const retryable = adoptionError?.retryable ?? Boolean(scanError);
    console.error('[ProjectLegacyAdoption]', JSON.stringify({
      route: 'project-legacy-adoption',
      projectName: req.params.name,
      code,
      retryable,
      detail: message,
    }));
    res.status(status).json({
      error: message,
      code: responseCode,
      retryable,
    });
  } finally {
    while (releaseProjectLocks.length > 0) releaseProjectLocks.pop()?.();
  }
});

// GET /api/projects/:name/chat/providers - Project-safe provider capabilities
router.get('/:name/chat/providers', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId: actorId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const projectIdentity = await ensureProjectIdentity({
      workspaceOwnerId: ownerId,
      projectName: name,
      projectRoot: projectDir,
    });
    if (projectIdentity.legacyOpenClawMigrationStatus !== 'CURRENT') {
      res.json({
        migration: {
          required: true,
          projectId: projectIdentity.id,
          title: 'Prepare this project for Project Chat',
          message: PROJECT_CHAT_MOVE_REQUIRED_MESSAGE,
        },
      });
      return;
    }
    // Provider discovery creates coordination state below. Fence legacy
    // identities before qualification reads or name-keyed state migration so
    // preserved 3.x evidence cannot be made visible by merely opening Chat.
    await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);
    const contextInput = {
      actorUserId: actorId,
      workspaceOwnerId: ownerId,
      projectName: name,
      projectIdentity,
      projectDir,
      projectsRoot: PROJECTS_DIR,
    };
    const qualifications = resolveProjectChatQualificationMatrix(
      PROJECT_CHAT_ROUTE_PROVIDERS,
      (provider) => {
        const context = buildUnqualifiedProjectSandboxExecutionContext(provider, contextInput);
        return getProjectQualificationStatus(provider, {
          context,
          egress: buildProjectEgressConfig({ context, provider }),
        });
      },
    );
    await migrateLegacyProjectChatState({
      actorUserId: actorId,
      legacyProjectId: name,
      immutableProjectId: projectIdentity.id,
    });
    const bindings = await listProjectChatBindings(actorId, projectIdentity.id);
    // Qualification attests the sandbox and embedded execution provider.
    // Within that provider, the server-persisted binding is the authoritative
    // metadata patch; browser-local preferences are never trusted.
    const qualifiedModels = Object.fromEntries(
      PROJECT_CHAT_ROUTE_PROVIDERS.map((provider) => {
        if (!qualifications[provider].selectable) return [provider, null];
        const context = buildUnqualifiedProjectSandboxExecutionContext(provider, contextInput);
        const grant = requireProjectQualification(provider, {
          context,
          egress: buildProjectEgressConfig({ context, provider }),
        });
        if (provider !== 'OPENCLAW') return [provider, grant.modelId];
        const bindingModel = normalizePortalModelId(
          bindings.find((binding) => binding.provider === 'OPENCLAW')?.model || '',
        );
        const bindingProvider = bindingModel.split('/')[0] || '';
        return [
          provider,
          bindingModel
            && isOpenClawProjectEmbeddedModel(bindingModel)
            && bindingProvider === grant.executionProviderId
            ? bindingModel
            : grant.modelId,
        ];
      }),
    );
    const providers = listProjectChatProviderCapabilities().map((capability) => (
      isProjectChatRouteProvider(capability.provider)
        ? qualifications[capability.provider].selectable
          ? buildQualifiedProjectChatProviderCapability(
              capability.provider,
              qualifications[capability.provider].reason,
            )
          : { ...capability, reason: qualifications[capability.provider].reason }
        : capability
    ));
    const portalSession = await prisma.projectChatSession.findFirst({
      where: { userId: actorId, projectId: projectIdentity.id },
      orderBy: { lastActivity: 'desc' },
    });
    const initialProviderCandidate = normalizeProjectChatProvider(
      portalSession?.activeProvider
      || [...bindings]
        .filter((binding) => isProjectChatRouteProvider(binding.provider as AgentProviderName))
        .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())[0]?.provider
      // A genuinely fresh project has no preference or binding. Start on the
      // first provider whose existing, non-mutating qualification evidence is
      // usable instead of durably selecting an unavailable OpenClaw lane.
      || PROJECT_CHAT_ROUTE_PROVIDERS.find((provider) => qualifications[provider].selectable)
      || 'OPENCLAW',
    );
    const initialProvider = isProjectChatRouteProvider(initialProviderCandidate)
      ? initialProviderCandidate
      : 'OPENCLAW';
    await ensureProjectChatState({
      actorUserId: actorId,
      projectIdentityId: projectIdentity.id,
      initialProvider: toPersistedProjectChatProvider(initialProvider),
    });
    const coordination = await readProjectChatCoordinationState({
      actorUserId: actorId,
      projectIdentityId: projectIdentity.id,
    });
    if (!coordination.state) throw new Error('Project Chat coordination state is unavailable');
    const activeProvider = requireProjectChatRouteProvider(fromPersistedProjectChatProvider(
      coordination.state.selectedProvider as ProjectChatPersistedProvider,
    ));
    // A selected provider whose runtime is not installed must not brick
    // discovery, or the picker that is the only way off it is unreachable.
    const discovery = buildDiscoveryProjectSandboxExecutionContext(
      activeProvider,
      PROJECT_CHAT_ROUTE_PROVIDERS,
      contextInput,
    );
    const executionContext = discovery.context;
    const runtimeUnavailable = discovery.unavailable;
    const activeUserTurn = visibleProjectChatActiveTurn(coordination.activeTurn);
    res.json({
      ...buildProjectChatCapabilityResponse({
      activeProvider,
      bindings,
      executionContext,
      providers,
      }),
      qualifications,
      qualifiedModels,
      // Tells the client the selected provider cannot run here and which
      // provider vouched for the project identity instead, so the panel can
      // say so plainly rather than presenting a lane that will fail on send.
      activeProviderRuntime: {
        provider: activeProvider,
        available: !runtimeUnavailable,
        reason: runtimeUnavailable?.message || null,
        identityProvider: discovery.provider,
      },
      coordination: {
        stateVersion: coordination.state.version,
        selectedProvider: activeProvider,
        transcriptCursor: coordination.state.transcriptCursor,
        activeTurn: activeUserTurn ? {
          id: activeUserTurn.id,
          provider: fromPersistedProjectChatProvider(
            activeUserTurn.provider as ProjectChatPersistedProvider,
          ),
          status: activeUserTurn.status,
          requestId: activeUserTurn.requestId,
          leaseExpiresAt: activeUserTurn.leaseExpiresAt.toISOString(),
        } : null,
        runtimeTransitionActive: Boolean(coordination.activeTurn && !activeUserTurn),
      },
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[Project Chat Providers] Error:', error?.message || error);
    res.status(503).json({
      error: 'Project provider discovery is temporarily unavailable. Try again.',
      code: 'PROJECT_PROVIDER_DISCOVERY_FAILED',
      retryable: true,
    });
  }
});

const projectOpenClawModelCatalogLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => crypto.createHash('sha256').update([
    req.user?.userId || 'unauthenticated',
    String(req.params.name || ''),
  ].join('\0')).digest('hex'),
  message: {
    error: 'Too many OpenClaw Project model catalog requests. Try again later.',
    code: 'PROJECT_MODEL_CATALOG_RATE_LIMITED',
  },
});

// GET /api/projects/:name/chat/models - Models available to this exact Project agent
router.get(
  '/:name/chat/models',
  authenticateToken,
  requireApproved,
  projectOpenClawModelCatalogLimiter,
  async (req: Request, res: Response) => {
  try {
    const provider = requireProjectChatRouteProvider(
      normalizeProjectChatProvider(req.query.provider || 'OPENCLAW'),
    );
    if (provider !== 'OPENCLAW') {
      res.status(400).json({
        error: 'This Project-scoped model catalog is available only for OpenClaw.',
        code: 'PROJECT_MODEL_PROVIDER_UNSUPPORTED',
      });
      return;
    }
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const { executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      workspaceOwnerId,
      name,
      projectDir,
      provider,
      { readOnly: true },
    );
    const models = await listAvailableOpenClawProjectModels(
      deriveOpenClawProjectAgentId(executionContext),
    );
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.vary('Authorization');
    res.vary('Cookie');
    res.json({
      provider,
      models: models.map((id) => ({
        id,
        alias: null,
        displayName: id.split('/').slice(1).join('/') || id,
        provider: id.split('/')[0] || 'openclaw',
        source: 'dynamic',
      })),
    });
  } catch (error) {
    if (sendProjectChatProviderError(res, error)) return;
    console.error(
      '[Project Chat Models] Error:',
      error instanceof Error ? error.message : error,
    );
    res.status(503).json({
      error: 'The dedicated OpenClaw Project agent model catalog is unavailable.',
      code: 'MODEL_CATALOG_UNAVAILABLE',
    });
  }
  },
);

const PROJECT_QUALIFICATION_RATE_LIMIT_IDENTITY = Symbol(
  'projectQualificationRateLimitIdentity',
);

type ProjectQualificationRateLimitRequest = Request & {
  [PROJECT_QUALIFICATION_RATE_LIMIT_IDENTITY]?: Readonly<ProjectQualificationRateLimitIdentity>;
  rateLimit?: { resetTime?: Date };
};

function requireProjectQualificationRateLimitIdentity(
  req: Request,
): Readonly<ProjectQualificationRateLimitIdentity> {
  const admitted = (req as ProjectQualificationRateLimitRequest)[
    PROJECT_QUALIFICATION_RATE_LIMIT_IDENTITY
  ];
  if (!admitted || admitted.actorUserId !== req.user?.userId) {
    throw new Error('Project qualification immutable identity admission is unavailable');
  }
  return admitted;
}

/**
 * Resolve and attest the existing Project identity before the limiter. This is
 * deliberately read-only: qualification must not create an identity merely to
 * obtain a rate-limit key, and a rename cannot create a fresh attempt budget.
 */
async function admitProjectQualificationRateLimitIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const projectName = String(req.params.name || '');
    const actorUserId = req.user?.userId;
    if (!actorUserId) {
      res.status(401).json({ error: 'Authentication is required' });
      return;
    }
    const workspaceOwnerId = actorUserId;
    const projectDir = getExistingProjectPathReadOnly(workspaceOwnerId, projectName);
    const projectIdentity = await readProjectIdentity({
      workspaceOwnerId,
      projectName,
      projectRoot: projectDir,
    });
    if (!projectIdentity) {
      res.status(409).json({
        error: 'Project identity has not been initialized. Refresh Project Chat before preparing a provider.',
        code: 'PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE',
        retryable: true,
      });
      return;
    }
    (req as ProjectQualificationRateLimitRequest)[
      PROJECT_QUALIFICATION_RATE_LIMIT_IDENTITY
    ] = Object.freeze({
      actorUserId,
      workspaceOwnerId,
      projectIdentityId: projectIdentity.id,
    });
    next();
  } catch (error) {
    if (error instanceof ContainedPathError && error.message === 'Path does not exist') {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const policyFailure = error instanceof ContainedPathError
      || error instanceof ProjectIdentityLifecycleError;
    console.error(
      '[Project Provider Qualification] Immutable identity admission failed:',
      error instanceof Error ? error.message : error,
    );
    res.status(policyFailure ? 409 : 503).json({
      error: policyFailure
        ? 'Project identity could not be safely verified for provider preparation.'
        : 'Project identity verification is temporarily unavailable.',
      code: 'PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE',
      retryable: !policyFailure,
    });
  }
}

function projectQualificationLimiter(provider: ProjectChatRouteProvider) {
  return rateLimit({
    windowMs: PROJECT_QUALIFICATION_WINDOW_MS,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    // Each provider gets an independent budget for the authenticated actor
    // and project. A normal first-time setup can therefore qualify every
    // enabled provider without one provider consuming another provider's gate.
    keyGenerator: (req) => projectQualificationRateLimitKey({
      provider,
      identity: requireProjectQualificationRateLimitIdentity(req),
    }),
    handler: (req, res) => {
      res.status(429).json({
        error: 'Too many Project provider qualification attempts. Try again after the preparation window resets.',
        code: 'PROJECT_QUALIFICATION_RATE_LIMITED',
        retryable: true,
        retryAt: projectQualificationRetryAt(
          (req as ProjectQualificationRateLimitRequest).rateLimit?.resetTime,
        ),
      });
    },
  });
}

const projectAgentZeroModelCatalogLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => crypto.createHash('sha256').update([
    req.user?.userId || 'unauthenticated',
    String(req.params.name || ''),
  ].join('\0')).digest('hex'),
  message: {
    error: 'Too many Agent Zero model catalog requests. Try again later.',
    code: 'AGENT_ZERO_MODEL_CATALOG_RATE_LIMITED',
  },
});

// Project members must be able to make an explicit model choice before
// qualification, but the owner-only Agent Runtime OAuth surface also exposes
// account labels. Return only the connected, bounded model identifiers needed
// by this actor's own Project Chat UI.
router.get(
  '/:name/chat/providers/agent-zero/models',
  authenticateToken,
  requireApproved,
  projectAgentZeroModelCatalogLimiter,
  async (req: Request, res: Response) => {
    try {
      const { projectDir } = resolveActorProjectChatWorkspace(req, req.params.name);
      if (!fs.existsSync(projectDir)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const catalog = await getDefaultAgentZeroOAuthClient().modelCatalog();
      res.json({
        available: true,
        checkedAt: catalog.checkedAt,
        providers: catalog.providers
          .filter((provider) => provider.connectionState === 'connected')
          .flatMap((provider) => {
            const models = filterAgentZeroOAuthModelsForProjectQualification(
              provider.providerId,
              provider.models,
            ).map((model) => ({
              id: model.id,
              displayName: model.displayName,
            }));
            return models.length > 0
              ? [{
                  providerId: provider.providerId,
                  displayName: provider.displayName,
                  connectionState: 'connected' as const,
                  models,
                }]
              : [];
          }),
      });
    } catch (error) {
      if (error instanceof AgentZeroOAuthError) {
        const status = error.code === 'AUTHENTICATION'
          ? 409
          : error.code === 'INVALID_REQUEST'
            ? 400
            : error.code === 'UPSTREAM_REJECTED'
              ? 502
              : 503;
        res.status(status).json({
          error: error.message,
          code: `AGENT_ZERO_MODEL_CATALOG_${error.code}`,
        });
        return;
      }
      console.error('[Agent Zero Project Model Catalog] Error:', error);
      res.status(503).json({
        error: 'Agent Zero OAuth models could not be verified.',
        code: 'AGENT_ZERO_MODEL_CATALOG_UNAVAILABLE',
      });
    }
  },
);

// These are the only routes permitted to construct unqualified provider
// contexts. Evidence is written only after the provider-specific runtime and
// egress attestation, complete positive/negative probe matrix, and a real
// authenticated model challenge all succeed.
function qualifyProjectChatProviderRoute(provider: ProjectChatRouteProvider) {
  return async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const rateLimitIdentity = requireProjectQualificationRateLimitIdentity(req);
      const actorUserId = req.user!.userId;
      const workspaceOwnerId = actorUserId;
      const projectDir = getExistingProjectPathReadOnly(workspaceOwnerId, name);
      const projectIdentity = await readProjectIdentity({
        workspaceOwnerId,
        projectName: name,
        projectRoot: projectDir,
      });
      if (
        !projectIdentity
        || rateLimitIdentity.actorUserId !== actorUserId
        || rateLimitIdentity.workspaceOwnerId !== workspaceOwnerId
        || rateLimitIdentity.projectIdentityId !== projectIdentity.id
      ) {
        throw new ProjectIdentityLifecycleError(
          'Project identity changed after qualification rate-limit admission',
        );
      }
      // Every provider shares one transcript and may bridge name-keyed 3.x
      // state. Gate all qualification lanes before that migration, not just
      // the OpenClaw lane that owns the preserved Gateway history.
      await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);
      await migrateLegacyProjectChatState({
        actorUserId,
        legacyProjectId: name,
        immutableProjectId: projectIdentity.id,
      });
      await ensureProjectChatState({
        actorUserId,
        projectIdentityId: projectIdentity.id,
        initialProvider: 'OPENCLAW',
      });
      const coordination = await readProjectChatCoordinationState({
        actorUserId,
        projectIdentityId: projectIdentity.id,
      });
      if (!coordination.state) throw new Error('Project Chat coordination state is unavailable');
      const contextInput = {
        actorUserId,
        workspaceOwnerId,
        projectName: name,
        projectIdentity,
        projectDir,
        projectsRoot: PROJECTS_DIR,
      };
      const executionContext = buildUnqualifiedProjectSandboxExecutionContext(provider, contextInput);
      const descriptor = getProjectChatProviderRuntimeDescriptor(provider);
      const admitted = await withProjectChatRuntimeAdmission({
        actorUserId,
        actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
        projectIdentityId: projectIdentity.id,
        // Explicit preparation selects the qualified provider only in the
        // same successful admission-completion CAS. A failed qualification
        // leaves the prior provider and version untouched.
        provider: coordination.state.selectedProvider as ProjectChatPersistedProvider,
        runtime: descriptor.runtime,
        operation: projectChatRuntimeOperationId(
          `qualify-${provider.toLowerCase()}`,
          req.body?.model || null,
          req.body?.modelSelection || null,
        ),
        leaseOwner: PROJECT_CHAT_LEASE_OWNER,
        expectedVersion: coordination.state.version,
        recoveryExecutionContext: executionContext,
        leaseDurationMs: PROJECT_CHAT_LEASE_DURATION_MS,
        requestedProviderAfterSuccess: toPersistedProjectChatProvider(provider),
      }, async () => {
        await repairTerminalProjectChatPresentations({
          actorUserId,
          projectIdentityId: projectIdentity.id,
          limit: 100,
        });
        await ensureProjectChatWorkspaceOwnership(executionContext, projectDir);
        if (provider === 'OPENCLAW') {
          // A genuinely new Project agent is absent from OpenClaw config.
          // Register and converge that exact identity before asking the pinned
          // CLI for its agent-scoped auth/model status.
          await ensureOpenClawProjectAgentCatalogScope(executionContext);
        }
        const ollamaModelSelection = provider === 'OLLAMA'
          ? await resolveAllowedOllamaProjectModel(
              [],
              typeof req.body?.model === 'string' ? req.body.model : null,
            )
          : undefined;
        const agentZeroModelSelection = provider === 'AGENT_ZERO'
          ? await resolveAllowedAgentZeroProjectModel(
              typeof req.body?.model === 'string'
                ? parseAgentZeroProjectModelBinding(req.body.model)
                : req.body?.modelSelection,
            )
          : undefined;
        let openClawModel: string | undefined;
        if (provider === 'OPENCLAW') {
          const requestedModel = normalizePortalModelId(
            typeof req.body?.model === 'string' ? req.body.model : '',
          );
          const existingBinding = await prisma.projectChatProviderBinding.findUnique({
            where: {
              userId_projectId_provider: {
                userId: actorUserId,
                projectId: executionContext.projectId,
                provider: 'OPENCLAW',
              },
            },
          });
          openClawModel = (await resolveAllowedOpenClawProjectModel(
            deriveOpenClawProjectAgentId(executionContext),
            [
            requestedModel,
            existingBinding?.model || '',
            getDefaultModel() || '',
            ],
            requestedModel,
          )).model;
        }
        return qualifyProjectProvider(provider, {
          context: executionContext,
          egress: buildProjectEgressConfig({ context: executionContext, provider }),
          sender: {
            label: req.user!.email,
            userId: actorUserId,
            role: req.user!.role,
          },
          ...(openClawModel ? { openClawModel } : {}),
          ...(agentZeroModelSelection ? { agentZeroModelSelection } : {}),
          ...(ollamaModelSelection ? { ollamaModelSelection } : {}),
        });
      });
      res.json({
        provider,
        qualification: admitted.result,
        stateVersion: admitted.state.version,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
    } catch (error) {
      if (sendProjectChatQualificationError(
        res,
        error,
        provider,
        {},
        req.user?.role === 'OWNER' || req.user?.role === 'SUB_ADMIN',
      )) return;
      if (sendProjectChatProviderError(res, error)) return;
      if (sendProjectChatCoordinationError(res, error)) return;
      console.error(`[${provider} Project Qualification] Failed:`, error instanceof Error ? error.message : error);
      res.status(503).json({
        error: 'Project provider qualification did not complete. The provider remains unavailable.',
        code: 'PROJECT_QUALIFICATION_FAILED',
        provider,
      });
    }
  };
}

router.post(
  '/:name/chat/providers/openclaw/qualify',
  authenticateToken,
  requireApproved,
  admitProjectQualificationRateLimitIdentity,
  projectQualificationLimiter('OPENCLAW'),
  qualifyProjectChatProviderRoute('OPENCLAW'),
);

router.post(
  '/:name/chat/providers/codex/qualify',
  authenticateToken,
  requireApproved,
  admitProjectQualificationRateLimitIdentity,
  projectQualificationLimiter('CODEX'),
  qualifyProjectChatProviderRoute('CODEX'),
);

router.post(
  '/:name/chat/providers/claude-code/qualify',
  authenticateToken,
  requireApproved,
  admitProjectQualificationRateLimitIdentity,
  projectQualificationLimiter('CLAUDE_CODE'),
  qualifyProjectChatProviderRoute('CLAUDE_CODE'),
);

router.post(
  '/:name/chat/providers/antigravity/qualify',
  authenticateToken,
  requireApproved,
  admitProjectQualificationRateLimitIdentity,
  projectQualificationLimiter('GEMINI'),
  qualifyProjectChatProviderRoute('GEMINI'),
);

router.post(
  '/:name/chat/providers/agent-zero/qualify',
  authenticateToken,
  requireApproved,
  admitProjectQualificationRateLimitIdentity,
  projectQualificationLimiter('AGENT_ZERO'),
  qualifyProjectChatProviderRoute('AGENT_ZERO'),
);

router.post(
  '/:name/chat/providers/ollama/qualify',
  authenticateToken,
  requireApproved,
  admitProjectQualificationRateLimitIdentity,
  projectQualificationLimiter('OLLAMA'),
  qualifyProjectChatProviderRoute('OLLAMA'),
);

// POST /api/projects/:name/chat/provider - Select/resume one provider binding
router.post('/:name/chat/provider', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId: actorId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorId,
      ownerId,
      name,
      projectDir,
      req.body?.provider,
    );
    const currentBindings = await listProjectChatBindings(actorId, executionContext.projectId);
    const portalSession = await prisma.projectChatSession.findFirst({
      where: { userId: actorId, projectId: executionContext.projectId },
      orderBy: { lastActivity: 'desc' },
    });
    const initialProvider = normalizeProjectChatProvider(portalSession?.activeProvider || 'OPENCLAW');
    await ensureProjectChatState({
      actorUserId: actorId,
      projectIdentityId: executionContext.projectId,
      initialProvider: toPersistedProjectChatProvider(initialProvider),
    });
    const coordination = await readProjectChatCoordinationState({
      actorUserId: actorId,
      projectIdentityId: executionContext.projectId,
    });
    if (!coordination.state) throw new Error('Project Chat coordination state is unavailable');
    const currentProvider = fromPersistedProjectChatProvider(
      coordination.state.selectedProvider as ProjectChatPersistedProvider,
    );
    const switchPlan = planProjectChatProviderSwitch({
      activeProvider: currentProvider,
      requestedProvider: provider,
      boundProviders: currentBindings.map((entry) => entry.provider),
      qualifiedCapability: buildQualifiedProjectChatProviderCapability(
        provider,
        requireProjectQualification(provider, {
          context: executionContext,
          egress: buildProjectEgressConfig({ context: executionContext, provider }),
        }).reason,
      ),
    });
    const bindingInput = {
      actorUserId: actorId,
      workspaceOwnerId: ownerId,
      projectName: name,
      projectDir,
      provider,
      executionContext,
      model: typeof req.body?.model === 'string' ? normalizePortalModelId(req.body.model) : null,
    };
    const existingRequestedBinding = currentBindings.find((entry) => entry.provider === provider) || null;
    const admitted = await withProjectChatRuntimeAdmission({
      actorUserId: actorId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      projectIdentityId: executionContext.projectId,
      provider: coordination.state.selectedProvider as ProjectChatPersistedProvider,
      runtime: getProjectChatProviderRuntimeDescriptor(provider).runtime,
      operation: projectChatRuntimeOperationId('switch-provider', provider, bindingInput.model),
      leaseOwner: PROJECT_CHAT_LEASE_OWNER,
      expectedVersion: req.body?.stateVersion,
      recoveryExecutionContext: executionContext,
      leaseDurationMs: PROJECT_CHAT_LEASE_DURATION_MS,
      requestedProviderAfterSuccess: toPersistedProjectChatProvider(provider),
    }, async () => {
      await repairTerminalProjectChatPresentations({
        actorUserId: actorId,
        projectIdentityId: executionContext.projectId,
        limit: 100,
      });
      let selectedBinding: Awaited<ReturnType<typeof ensureSelectedProjectChatBinding>>;
      if (provider === 'OPENCLAW') {
        await ensureProjectChatWorkspaceOwnership(executionContext, projectDir);
        const catalogScope = await ensureOpenClawProjectAgentCatalogScope(executionContext);
        const openClawModelResolution = await resolveAllowedOpenClawProjectModel(
          catalogScope.agentId,
          [
            bindingInput.model || '',
            existingRequestedBinding?.model || '',
            getDefaultModel() || '',
          ],
          bindingInput.model || '',
        );
        const resolved = await ensureOpenClawProjectRuntime({
          ...bindingInput,
          model: existingRequestedBinding?.model || null,
        });
        const modelVerification = await verifyAndPersistOpenClawProjectModel({
          actorUserId: actorId,
          projectId: executionContext.projectId,
          portalSessionKey: resolved.identity.sessionId,
          providerSessionKey: resolved.identity.sessionKey,
          desiredModel: openClawModelResolution.model,
        });
        selectedBinding = {
          ...resolved,
          binding: modelVerification.binding,
          sessionKey: resolved.identity.sessionKey,
          agentId: resolved.identity.agentId,
          created: false,
        };
      } else {
        selectedBinding = await ensureSelectedProjectChatBinding(bindingInput);
      }
      const { identity, binding } = selectedBinding;
      await prisma.projectChatSession.upsert({
        where: { sessionKey: identity.sessionId },
        update: {
          activeProvider: provider,
          runtime: binding.runtime,
          model: binding.model,
          status: 'active',
          lastActivity: new Date(),
        },
        create: {
          userId: actorId,
          projectId: executionContext.projectId,
          sessionKey: identity.sessionId,
          activeProvider: provider,
          runtime: binding.runtime,
          model: binding.model,
          status: 'active',
        },
      });
      return selectedBinding;
    });
    const { binding, sessionKey, agentId } = admitted.result;

    res.json({
      provider,
      runtime: binding.runtime,
      sessionKey,
      agentId,
      externalSessionId: binding.externalSessionId || sessionKey,
      model: projectChatClientModel(provider, binding.model),
      modelValidated: true,
      modelVerified: provider === 'OPENCLAW' ? true : undefined,
      modelConfigured: isNativeProjectChatRouteProvider(provider) ? true : undefined,
      modelWarning: null,
      resumed: switchPlan.action === 'resume',
      preservePortalTranscript: switchPlan.preservePortalTranscript,
      stateVersion: admitted.state.version,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[Project Chat Provider Switch] Error:', error?.message || error);
    res.status(503).json({
      error: 'Project provider change did not complete. The previous provider remains selected.',
      code: 'PROJECT_PROVIDER_SWITCH_FAILED',
      retryable: true,
    });
  }
});

// --- Portal-owned Project Chat transcript routes ---

function toPresentationTerminalStatus(status: ProjectChatTurn['status']) {
  return status === 'COMPLETED'
    ? 'completed' as const
    : status === 'ABORTED'
      ? 'aborted' as const
      : status === 'EXPIRED'
        ? 'expired' as const
        : 'error' as const;
}

async function readDurableProjectPresentationEvents(turn: ProjectChatTurn): Promise<{
  events: ProjectNativeRunEvent[];
  truncated: boolean;
}> {
  const newestFirst = await prisma.projectChatTurnEvent.findMany({
    where: { turnId: turn.id },
    // Keep the terminal edge when a very long turn exceeds the bounded
    // projection window. Final tool results and status are more important to
    // restart repair than the oldest streaming deltas.
    orderBy: { seq: 'desc' },
    take: PROJECT_CHAT_PRESENTATION_EVENT_LIMIT + 1,
  });
  const retained = retainNewestProjectChatPresentationEvents(
    newestFirst,
    PROJECT_CHAT_PRESENTATION_EVENT_LIMIT,
  );
  return {
    truncated: retained.truncated,
    events: retained.events.map((event) => {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    return {
      ...payload,
      seq: event.seq,
      ts: event.createdAt.getTime(),
      runId: turn.id,
    } as unknown as ProjectNativeRunEvent;
    }),
  };
}

function terminalProjectTurnContent(
  turn: ProjectChatTurn,
  events: readonly ProjectNativeRunEvent[],
  preferredContent?: string | null,
  presentation?: ReturnType<typeof buildProjectChatMessagePresentation>,
): string {
  const preferred = String(preferredContent || '').trim();
  if (preferred) return preferred;
  const terminal = [...events].reverse().find((event) => (
    (event.type === 'done' || event.type === 'error')
    && typeof event.content === 'string'
    && event.content.trim()
  ));
  if (terminal?.content) return String(terminal.content);
  // Presentation projection understands provider snapshot/replace semantics.
  // Reuse it rather than concatenating raw deltas, which can duplicate an
  // answer when history repairs after a Portal restart.
  const text = (presentation?.segments || [])
    .filter((segment) => segment.kind === 'text')
    .sort((a, b) => a.order - b.order || a.ts - b.ts)
    .map((segment) => segment.text)
    .join('\n\n');
  if (text.trim()) return text;
  if (turn.errorMessage) return turn.errorMessage;
  if (turn.status === 'ABORTED') return 'Turn cancelled.';
  if (turn.status === 'EXPIRED') return 'Turn interrupted when the Portal lease expired.';
  return '';
}

/**
 * Materialize a terminal assistant record from the durable replay log. This is
 * intentionally idempotent. Restart repair runs only from a mutating provider
 * admission; history/status/poll routes remain strict read-only projections.
 */
async function materializeTerminalProjectChatAssistant(input: {
  turn: ProjectChatTurn;
  preferredContent?: string | null;
  sessionKey?: string | null;
  terminalStatus?: 'COMPLETED' | 'ERROR' | 'ABORTED' | 'EXPIRED';
  expectedHandoffVersion?: number;
}): Promise<boolean> {
  const terminalStatus = input.terminalStatus || input.turn.status;
  if (!['COMPLETED', 'ERROR', 'ABORTED', 'EXPIRED'].includes(terminalStatus)) return false;
  if (isProjectChatRuntimeAdmissionTurn(input.turn)) return false;
  const durableReplay = await readDurableProjectPresentationEvents(input.turn);
  const presentation = buildProjectChatMessagePresentation(durableReplay.events, {
    terminalStatus: toPresentationTerminalStatus(terminalStatus as ProjectChatTurn['status']),
    sourceTruncated: durableReplay.truncated,
  });
  const terminalTurn = terminalStatus === input.turn.status
    ? input.turn
    : { ...input.turn, status: terminalStatus as ProjectChatTurn['status'] };
  const content = terminalProjectTurnContent(
    terminalTurn,
    durableReplay.events,
    input.preferredContent,
    presentation,
  );
  const deterministicMessageId = `project-turn:${input.turn.id}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(async (transaction) => {
        const [currentTurn, binding, existingSession] = await Promise.all([
          transaction.projectChatTurn.findUnique({ where: { id: input.turn.id } }),
          transaction.projectChatProviderBinding.findUnique({
            where: {
              userId_projectId_provider: {
                userId: input.turn.actorUserId,
                projectId: input.turn.projectIdentityId,
                provider: input.turn.provider,
              },
            },
            select: { status: true, handoffVersion: true },
          }),
          input.sessionKey
            ? Promise.resolve(null)
            : transaction.projectChatSession.findFirst({
                where: { userId: input.turn.actorUserId, projectId: input.turn.projectIdentityId },
                orderBy: { lastActivity: 'desc' },
                select: { sessionKey: true },
              }),
        ]);
        // The durable turn row is the reset tombstone. A successful reset
        // deletes every prior turn and increments every provider generation in
        // the same Serializable transaction. Replayed settlement and repair
        // must therefore prove that both the turn and captured generation are
        // still current before they may publish an assistant row.
        if (
          !currentTurn
          || currentTurn.actorUserId !== input.turn.actorUserId
          || currentTurn.projectIdentityId !== input.turn.projectIdentityId
          || currentTurn.provider !== input.turn.provider
          || binding?.status === 'reset'
          || (
            input.expectedHandoffVersion != null
            && binding?.handoffVersion !== input.expectedHandoffVersion
          )
        ) return false;

        const sessionKey = String(
          input.sessionKey
          || existingSession?.sessionKey
          || input.turn.providerSessionId
          || `project-turn:${input.turn.id}`,
        );
        const legacyProjection = await transaction.projectChatMessage.findFirst({
          where: {
            userId: input.turn.actorUserId,
            projectId: input.turn.projectIdentityId,
            role: 'assistant',
            messageId: deterministicMessageId,
            turnId: null,
          },
          select: { id: true },
        });
        if (legacyProjection) {
          await transaction.projectChatMessage.update({
            where: { id: legacyProjection.id },
            data: {
              turnId: input.turn.id,
              content,
              presentation: presentation ? presentation as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
              model: input.turn.model,
              providerSessionId: input.turn.providerSessionId,
            },
          });
          return true;
        }
        await transaction.projectChatMessage.upsert({
          where: { turnId: input.turn.id },
          update: {
            content,
            presentation: presentation ? presentation as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
            model: input.turn.model,
            providerSessionId: input.turn.providerSessionId,
          },
          create: {
            projectId: input.turn.projectIdentityId,
            userId: input.turn.actorUserId,
            sessionKey,
            role: 'assistant',
            content,
            messageId: deterministicMessageId,
            turnId: input.turn.id,
            presentation: presentation ? presentation as unknown as Prisma.InputJsonValue : undefined,
            provider: input.turn.provider,
            runtime: input.turn.runtime,
            model: input.turn.model,
            providerSessionId: input.turn.providerSessionId,
          },
        });
        return true;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError)
        || error.code !== 'P2034'
        || attempt === 4
      ) throw error;
    }
  }
  return false;
}

async function markProjectTurnPresentationMaterialized(turn: ProjectChatTurn): Promise<void> {
  const metadata = turn.resultMetadata && typeof turn.resultMetadata === 'object' && !Array.isArray(turn.resultMetadata)
    ? turn.resultMetadata as Record<string, unknown>
    : {};
  await prisma.projectChatTurn.update({
    where: { id: turn.id },
    data: {
      resultMetadata: {
        ...metadata,
        presentationMaterialized: true,
      } as Prisma.InputJsonValue,
    },
  });
}

async function repairTerminalProjectChatPresentations(input: {
  actorUserId: string;
  projectIdentityId: string;
  limit: number;
}): Promise<void> {
  const turns = await prisma.projectChatTurn.findMany({
    where: {
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      status: { in: ['COMPLETED', 'ERROR', 'ABORTED', 'EXPIRED'] },
      NOT: { requestId: { startsWith: PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX } },
    },
    orderBy: { createdAt: 'desc' },
    take: input.limit,
  });
  if (turns.length === 0) return;
  const existing = await prisma.projectChatMessage.findMany({
    where: { turnId: { in: turns.map((turn) => turn.id) } },
    select: { turnId: true, content: true, sessionKey: true, presentation: true },
  });
  const materialized = new Map(
    existing
      .filter((message): message is typeof message & { turnId: string } => Boolean(message.turnId))
      .map((message) => [message.turnId, message]),
  );
  for (const turn of turns.reverse()) {
    const message = materialized.get(turn.id);
    const presentation = parseProjectChatMessagePresentation(message?.presentation);
    if (shouldRepairProjectChatPresentation({
      resultMetadata: turn.resultMetadata,
      presentation,
    })) {
      const repaired = await materializeTerminalProjectChatAssistant({
        turn,
        preferredContent: message?.content,
        sessionKey: message?.sessionKey,
      });
      if (repaired) await markProjectTurnPresentationMaterialized(turn);
    }
  }
}

async function settleProjectChatTurnWithPresentation(input: {
  turn: ProjectChatTurn;
  leaseToken: string;
  providerStatus: 'completed' | 'error' | 'aborted';
  providerSessionId: string;
  providerError?: string | null;
  providerDispatchObserved?: boolean;
  durableEventFailure?: unknown;
  durableEventCount: number;
  sessionKey: string;
  preferredContent?: string | null;
  handoff: {
    expectedCursor: number;
    expectedHandoffVersion: number;
  };
}): Promise<void> {
  const requestedStatus = input.durableEventFailure
    ? 'ERROR' as const
    : input.providerStatus === 'completed'
      ? 'COMPLETED' as const
      : input.providerStatus === 'aborted'
      ? 'ABORTED' as const
      : 'ERROR' as const;
  let assistantProjection: ProjectChatAssistantProjection;
  let projectionPreparationFailed = false;
  try {
    const durableReplay = await readDurableProjectPresentationEvents(input.turn);
    const presentation = buildProjectChatMessagePresentation(durableReplay.events, {
      terminalStatus: toPresentationTerminalStatus(requestedStatus),
      sourceTruncated: durableReplay.truncated,
    });
    assistantProjection = {
      sessionKey: input.sessionKey,
      messageId: `project-turn:${input.turn.id}`,
      content: terminalProjectTurnContent(
        { ...input.turn, status: requestedStatus },
        durableReplay.events,
        input.preferredContent,
        presentation,
      ),
      presentation: presentation as unknown as Prisma.InputJsonValue,
    };
  } catch (error) {
    projectionPreparationFailed = true;
    console.error('[Project Chat] Terminal projection preparation failed:', error);
    assistantProjection = {
      sessionKey: input.sessionKey,
      messageId: `project-turn:${input.turn.id}`,
      content: PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
    };
  }

  const settlementStatus = input.durableEventFailure || projectionPreparationFailed ? 'ERROR' : requestedStatus;
  const settlementError = input.durableEventFailure
    ? 'Project Chat replay persistence failed before the provider turn completed.'
    : projectionPreparationFailed
      ? 'Project Chat terminal presentation could not be materialized; history recovery will retry.'
      : input.providerError || null;
  let durableSettlementStatus: string = settlementStatus;
  try {
    const settled = await finishProjectChatTurn({
      actorUserId: input.turn.actorUserId,
      projectIdentityId: input.turn.projectIdentityId,
      turnId: input.turn.id,
      leaseToken: input.leaseToken,
      status: settlementStatus,
      providerSessionId: input.providerSessionId,
      assistantProjection,
      resultMetadata: {
        durableEventCount: input.durableEventCount,
        providerStatus: input.providerStatus,
        presentationMaterialized: true,
        ...(input.providerDispatchObserved ? {
          providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
          providerDispatchAcceptedAt: new Date().toISOString(),
        } : {}),
      },
      errorCode: input.durableEventFailure
        ? 'REPLAY_PERSISTENCE_FAILED'
        : projectionPreparationFailed
          ? 'PRESENTATION_PERSISTENCE_FAILED'
          : input.providerStatus === 'error'
            ? 'PROVIDER_ERROR'
            : null,
      errorMessage: settlementError,
      handoff: {
        provider: input.turn.provider as ProjectChatPersistedProvider,
        expectedHandoffVersion: input.handoff.expectedHandoffVersion,
        expectedCursor: input.handoff.expectedCursor,
      },
    });
    durableSettlementStatus = settled.status;
  } catch (error) {
    console.error('[Project Chat] Durable settlement failed; attempting terminal reconciliation:', error);
    try {
      const reconciled = await finishProjectChatTurn({
        actorUserId: input.turn.actorUserId,
        projectIdentityId: input.turn.projectIdentityId,
        turnId: input.turn.id,
        leaseToken: input.leaseToken,
        status: 'ERROR',
        providerSessionId: input.providerSessionId,
        assistantProjection: {
          sessionKey: input.sessionKey,
          messageId: `project-turn:${input.turn.id}`,
          content: PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
        },
        handoff: {
          provider: input.turn.provider as ProjectChatPersistedProvider,
          expectedHandoffVersion: input.handoff.expectedHandoffVersion,
          expectedCursor: input.handoff.expectedCursor,
        },
        resultMetadata: {
          durableEventCount: input.durableEventCount,
          providerStatus: input.providerStatus,
          presentationMaterialized: true,
          settlementReconciled: true,
          ...(input.providerDispatchObserved ? {
            providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
            providerDispatchAcceptedAt: new Date().toISOString(),
          } : {}),
        },
        errorCode: 'SETTLEMENT_PERSISTENCE_FAILED',
        errorMessage: PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
      });
      durableSettlementStatus = reconciled.status;
    } catch (reconciliationError) {
      console.error('[Project Chat] Terminal settlement reconciliation failed:', reconciliationError);
      throw new Error(PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE);
    }
  }

  if (input.providerStatus === 'completed' && durableSettlementStatus !== 'COMPLETED') {
    throw new Error(PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE);
  }
}

// GET /api/projects/:name/chat/history - Load persisted chat messages for this project+user
router.get('/:name/chat/history', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId: userId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      userId,
      ownerId,
      name,
      projectDir,
      req.query.provider,
      { requireQualification: false, readOnly: true },
    );
    // Preview-era UUID rows can still contain unmatched Portal 3.x SQL residue.
    // Do not expose any transcript until the authoritative Gateway import has
    // either quarantined that ambiguity or proven the identity unaffected.
    await assertLegacyOpenClawProjectMigrationInactive(executionContext.projectId);
    const bindingRead = await readExistingProjectChatBinding({
      actorUserId: userId,
      provider,
      executionContext,
      allowStaleContext: true,
    });
    const { binding, staleBinding, staleReason } = bindingRead;

    const requestedLimit = req.query.limit == null ? 100 : Number(req.query.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      res.status(400).json({ error: 'Project Chat history limit must be between 1 and 100' });
      return;
    }
    const beforeId = String(req.query.before || '').trim() || null;
    if (beforeId) {
      const cursor = await prisma.projectChatMessage.findFirst({
        where: { id: beforeId, userId, projectId: executionContext.projectId },
        select: { id: true },
      });
      if (!cursor) { res.status(400).json({ error: 'Project Chat history cursor is invalid' }); return; }
    }

    const historyPage = await prisma.projectChatMessage.findMany({
      where: { userId, projectId: executionContext.projectId },
      orderBy: [{ timestamp: 'desc' }, { sourceSortKey: 'desc' }, { id: 'desc' }],
      take: requestedLimit + 1,
      ...(beforeId ? { cursor: { id: beforeId }, skip: 1 } : {}),
    });
    const hasMore = historyPage.length > requestedLimit;
    const messages = historyPage.slice(0, requestedLimit).reverse();

    // Get session status
    const session = bindingRead.portalSession;

    res.json({
      messages: messages.map((m) => {
        const presentation = parseProjectChatMessagePresentation(m.presentation);
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp.toISOString(),
          messageId: m.messageId,
          provider: m.provider,
          runtime: m.runtime,
          model: projectChatClientModel(
            normalizeProjectChatProvider(m.provider || provider),
            m.model,
          ),
          providerSessionId: m.providerSessionId,
          turnId: m.turnId,
          ...(presentation?.thinkingContent ? { thinkingContent: presentation.thinkingContent } : {}),
          ...(presentation?.toolCalls ? { toolCalls: presentation.toolCalls } : {}),
          ...(presentation?.segments ? { segments: presentation.segments } : {}),
          ...(presentation?.truncated ? { presentationTruncated: true } : {}),
        };
      }),
      pagination: {
        hasMore,
        nextCursor: hasMore ? messages[0]?.id || null : null,
        limit: requestedLimit,
      },
      session: staleBinding ? {
        status: 'stale',
        model: projectChatClientModel(provider, staleBinding.model),
        activeProvider: provider,
        runtime: staleBinding.runtime,
        lastActivity: staleBinding.lastActivity.toISOString(),
        requiresPreparation: true,
        staleReason,
      } : session ? {
        status: session.status,
        model: projectChatClientModel(provider, session.model),
        activeProvider: session.activeProvider,
        runtime: session.runtime,
        lastActivity: session.lastActivity.toISOString(),
      } : binding ? {
        status: binding.status,
        model: projectChatClientModel(provider, binding.model),
        activeProvider: provider,
        runtime: binding.runtime,
        lastActivity: binding.lastActivity.toISOString(),
      } : {
        status: 'uninitialized',
        model: null,
        activeProvider: provider,
        runtime: null,
        lastActivity: null,
      },
      activeBinding: binding ? {
        provider,
        runtime: binding.runtime,
        sessionKey: binding.sessionKey,
        externalSessionId: binding.externalSessionId,
        model: projectChatClientModel(provider, binding.model),
      } : staleBinding ? {
        provider,
        runtime: staleBinding.runtime,
        model: projectChatClientModel(provider, staleBinding.model),
        status: 'stale',
        requiresPreparation: true,
        staleReason,
      } : null,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    console.error('[Chat History] Error:', error.message);
    res.status(500).json({ error: 'Failed to load chat history' });
  }
});

// These browser-written transcript endpoints predate durable Project turns.
// They bypassed the state-version CAS and provider runtime admission, so they
// are fixed tombstones rather than compatibility write paths. User messages
// are persisted only by /assistant/send when admission is promoted atomically.
router.post('/:name/chat/message', authenticateToken, requireApproved, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Direct Project Chat transcript writes are retired. Send through /assistant/send.',
    code: 'PROJECT_CHAT_DIRECT_TRANSCRIPT_WRITE_RETIRED',
  });
});

router.post('/:name/chat/messages', authenticateToken, requireApproved, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Direct Project Chat transcript writes are retired. Send through /assistant/send.',
    code: 'PROJECT_CHAT_DIRECT_TRANSCRIPT_WRITE_RETIRED',
  });
});

function projectChatResetNotQuiescent(message: string): ProjectChatLeaseError {
  return new ProjectChatLeaseError('TURN_ACTIVE', message, 409);
}

async function quiesceProjectChatBrokerCallbacksForDestructiveReset(input: {
  actorUserId: string;
  projectIdentityId: string;
}): Promise<void> {
  for (const provider of QUALIFIABLE_PROJECT_PROVIDERS) {
    const result = await quiesceProjectNativeRunForDestructiveReset({
      userId: input.actorUserId,
      projectId: input.projectIdentityId,
      provider,
    });
    if (!result.quiescent) {
      throw projectChatResetNotQuiescent(
        `The ${projectChatProviderDisplayName(provider)} Project callback boundary is still active; no data was cleared.`,
      );
    }
  }
}

const PROJECT_CHAT_RESET_ACTORLESS_RESOURCE_KINDS = new Set([
  'AGENT_ZERO_NETWORK',
  'AGENT_ZERO_FIREWALL',
  'AGENT_ZERO_CREDENTIAL',
]);

function assertProjectRuntimeCleanupResourcesForReset(input: {
  provider: ProjectChatRouteProvider;
  actorUserId: string;
  projectIdentityId: string;
  resources: readonly ProjectRuntimeResource[];
}): void {
  for (const resource of input.resources) {
    const exactProjectGlobal = resource.actorUserId === null
      && PROJECT_CHAT_RESET_ACTORLESS_RESOURCE_KINDS.has(resource.kind);
    if (
      resource.provider !== input.provider
      || resource.projectIdentityId !== input.projectIdentityId
      || (resource.actorUserId !== input.actorUserId && !exactProjectGlobal)
    ) {
      throw projectChatResetNotQuiescent(
        `${projectChatProviderDisplayName(input.provider)} cleanup crossed the authenticated Project boundary.`,
      );
    }
  }
}

async function cleanupProjectRuntimeAdapterMatrixForDestructiveReset(input: {
  actorUserId: string;
  cleanupScope: ProjectRuntimeCleanupScope;
  providers: readonly ProjectChatRouteProvider[];
  snapshots?: ReadonlyMap<ProjectChatRouteProvider, readonly ProjectRuntimeResource[]>;
}): Promise<ReadonlyMap<ProjectChatRouteProvider, readonly ProjectRuntimeResource[]>> {
  const snapshots = new Map<ProjectChatRouteProvider, readonly ProjectRuntimeResource[]>();
  const enumerated = input.snapshots
    ? input.providers.map((provider) => ({
      provider,
      resources: input.snapshots!.get(provider) || [],
    }))
    : await Promise.all(input.providers.map(async (provider) => ({
      provider,
      resources: await PROJECT_RUNTIME_CLEANUP_ADAPTERS[provider].enumerate(input.cleanupScope),
    })));
  // Attest every provider snapshot before the first external mutation. A
  // malformed later provider can therefore never leave an earlier provider
  // partially deleted under a cleanup scope that was not fully proven.
  for (const entry of enumerated) {
    assertProjectRuntimeCleanupResourcesForReset({
      provider: entry.provider,
      actorUserId: input.actorUserId,
      projectIdentityId: input.cleanupScope.projectIdentity.id,
      resources: entry.resources,
    });
    snapshots.set(entry.provider, entry.resources);
  }
  for (const provider of input.providers) {
    const adapter = PROJECT_RUNTIME_CLEANUP_ADAPTERS[provider];
    await adapter.cleanup(input.cleanupScope, snapshots.get(provider) || []);
    const remaining = await adapter.verifyClean(input.cleanupScope);
    if (remaining.length !== 0) {
      throw projectChatResetNotQuiescent(
        `${projectChatProviderDisplayName(provider)} runtime cleanup could not be verified.`,
      );
    }
  }
  return snapshots;
}

async function convergeProjectChatTurnForDestructiveReset(input: {
  actorUserId: string;
  projectIdentityId: string;
  executionContext: ProjectSandboxExecutionContext;
  coordination: Awaited<ReturnType<typeof requireSelectedProjectChatState>>;
}) {
  const activeTurn = input.coordination.activeTurn;
  if (!activeTurn) return input.coordination.state!;
  if (isProjectChatRuntimeAdmissionTurn(activeTurn)) {
    if (
      activeTurn.leaseExpiresAt.getTime() > Date.now()
      || !projectChatLeaseOwnerCanBeRecoveredByDestructiveReset(activeTurn.leaseOwner)
    ) {
      throw projectChatResetNotQuiescent(
        'Another Project Chat runtime operation is still active; retry reset after it finishes.',
      );
    }
    const legacyIdentity = await ensureProjectAssistantIdentity(
      input.executionContext.canonicalRoot,
      input.actorUserId,
      input.executionContext.projectName,
      { workspaceOwnerId: input.executionContext.workspaceOwnerId },
    );
    await terminateProjectChatBindingsForDestructiveReset({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      legacyProjectId: input.executionContext.projectName,
      executionContext: input.executionContext,
      exactServerOwnedOpenClawSessionKeys: [
        legacyIdentity.sessionKey,
        `agent:portal:${legacyIdentity.sessionId}`,
      ],
    });
    await recoverExpiredProjectChatRuntimeAdmissionForDestructiveReset({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      turnId: activeTurn.id,
      expectedVersion: input.coordination.state!.version,
    });
    const recovered = await readProjectChatCoordinationState({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      recoverStale: false,
    });
    if (!recovered.state || recovered.activeTurn) {
      throw projectChatResetNotQuiescent(
        'Expired Project Chat runtime admission did not converge after provider termination.',
      );
    }
    return recovered.state;
  }
  const provider = fromPersistedProjectChatProvider(activeTurn.provider as ProjectChatPersistedProvider);
  if (!isQualifiableProjectProvider(provider)) {
    throw projectChatResetNotQuiescent('The active Project provider cannot prove a safe abort path.');
  }
  const binding = await prisma.projectChatProviderBinding.findUnique({
    where: {
      userId_projectId_provider: {
        userId: input.actorUserId,
        projectId: input.projectIdentityId,
        provider: activeTurn.provider,
      },
    },
  });
  const boundSessions = new Set(
    [binding?.sessionKey, binding?.externalSessionId]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  if (
    !binding
    || binding.runtime !== activeTurn.runtime
    || !activeTurn.providerSessionId
    || !boundSessions.has(activeTurn.providerSessionId)
  ) {
    throw projectChatResetNotQuiescent(
      'The active Project turn does not match an attested provider session; reset was not attempted.',
    );
  }
  const activeProviderSessionId = activeTurn.providerSessionId;

  await requestProjectChatTurnAbort({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
    turnId: activeTurn.id,
    expectedProvider: activeTurn.provider as ProjectChatPersistedProvider,
  });

  const rawSnapshot = getProjectNativeRunSnapshot({
    userId: input.actorUserId,
    projectId: input.projectIdentityId,
    provider,
  });
  const snapshot = matchingProjectNativeSnapshot(activeTurn, rawSnapshot);
  if (rawSnapshot?.active && !snapshot) {
    throw projectChatResetNotQuiescent(
      'The process-local Project callback belongs to a different durable turn; no data was cleared.',
    );
  }
  await requireConfirmedProjectChatAbortForReset({
    hasExactBrokerRun: Boolean(snapshot?.runId),
    abortBroker: () => abortProjectNativeRun({
      userId: input.actorUserId,
      projectId: input.projectIdentityId,
      provider,
    }),
    waitForBrokerSettlement: () => snapshot?.runId
      ? waitForProjectNativeRunSettlement({
        userId: input.actorUserId,
        projectId: input.projectIdentityId,
        provider,
        runId: snapshot.runId,
      })
      : Promise.resolve(false),
    abortProvider: async () => {
      if (!snapshot?.runId) {
        // After a process crash no process-local callback can prove whether a
        // provider request is still alive (including legacy turns without a
        // dispatch-stage marker). Destructive reset already intends to retire
        // this exact attested binding, so terminating that session is the only
        // truthful absence proof that can release the quarantine. Every
        // provider goes through its immutable-label cleanup adapter: deleting
        // a session record alone cannot stop a Gateway/CLI process after a
        // backend restart.
        const legacyIdentity = await ensureProjectAssistantIdentity(
          input.executionContext.canonicalRoot,
          input.actorUserId,
          input.executionContext.projectName,
          { workspaceOwnerId: input.executionContext.workspaceOwnerId },
        );
        await terminateProjectChatBindingsForDestructiveReset({
          actorUserId: input.actorUserId,
          projectIdentityId: input.projectIdentityId,
          legacyProjectId: input.executionContext.projectName,
          executionContext: input.executionContext,
          exactServerOwnedOpenClawSessionKeys: [
            legacyIdentity.sessionKey,
            `agent:portal:${legacyIdentity.sessionId}`,
          ],
        });
        return true;
      }
      return await getProjectChatProviderAdapter(provider).abortActiveRun?.(
        activeProviderSessionId,
        activeTurn.id,
      ) === true;
    },
    isTurnStillActive: async () => Boolean((await readProjectChatCoordinationState({
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      recoverStale: false,
    })).activeTurn),
  });

  await confirmProjectChatTurnAbort({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
    turnId: activeTurn.id,
    expectedProvider: activeTurn.provider as ProjectChatPersistedProvider,
    providerSessionId: activeProviderSessionId,
  });
  const quiescent = await readProjectChatCoordinationState({
    actorUserId: input.actorUserId,
    projectIdentityId: input.projectIdentityId,
    recoverStale: false,
  });
  if (!quiescent.state || quiescent.activeTurn) {
    throw projectChatResetNotQuiescent(
      'Project Chat cancellation did not release its durable turn; no data was cleared.',
    );
  }
  return quiescent.state;
}

async function terminateProjectChatBindingsForDestructiveReset(input: {
  actorUserId: string;
  projectIdentityId: string;
  legacyProjectId: string;
  executionContext: ProjectSandboxExecutionContext;
  exactServerOwnedOpenClawSessionKeys: readonly string[];
}) {
  const projectIds = Array.from(new Set([
    input.projectIdentityId,
    input.legacyProjectId,
  ]));
  const bindings = await prisma.projectChatProviderBinding.findMany({
    where: { userId: input.actorUserId, projectId: { in: projectIds } },
  });
  const sessions = await prisma.projectChatSession.findMany({
    where: { userId: input.actorUserId, projectId: { in: projectIds } },
  });
  const projectIdentity = await prisma.projectIdentity.findUnique({
    where: { id: input.projectIdentityId },
  });
  if (
    !projectIdentity
    || projectIdentity.lifecycleStatus !== 'ACTIVE'
    || projectIdentity.workspaceOwnerId !== input.executionContext.workspaceOwnerId
    || projectIdentity.projectName !== input.executionContext.projectName
    || projectIdentity.canonicalRoot !== input.executionContext.canonicalRoot
    || projectIdentity.rootDevice !== input.executionContext.rootDevice
    || projectIdentity.rootInode !== input.executionContext.rootInode
    || projectIdentity.rootBirthtimeNs !== input.executionContext.rootBirthtimeNs
  ) {
    throw projectChatResetNotQuiescent(
      'The immutable Project identity changed before provider cleanup; no data was cleared.',
    );
  }
  const openClawSessionKey = deriveOpenClawProjectSessionKey(input.executionContext);
  const nativeQuery = {
    projectIdentityId: input.executionContext.projectId,
    canonicalRoot: input.executionContext.canonicalRoot,
    rootDevice: input.executionContext.rootDevice,
    rootInode: input.executionContext.rootInode,
    rootBirthtimeNs: input.executionContext.rootBirthtimeNs,
  };
  const nativeSessions = new Map<NativeProjectChatRouteProvider, ReturnType<typeof listNativeProjectSessions>>();
  // Enumerate and attest every allowed identity before the first external
  // mutation. A corrupt binding must never be able to point reset at another
  // actor/project's provider session.
  for (const provider of PROJECT_CHAT_ROUTE_PROVIDERS) {
    if (provider === 'OPENCLAW') continue;
    const sessions = listNativeProjectSessions(provider, nativeQuery);
    if (sessions.some((session) => session.userId !== input.actorUserId)) {
      throw projectChatResetNotQuiescent(
        `The ${projectChatProviderDisplayName(provider)} Project session actor does not match reset ownership.`,
      );
    }
    nativeSessions.set(provider, sessions);
  }
  const cleanupScope: ProjectRuntimeCleanupScope = Object.freeze({
    authenticatedActorId: input.actorUserId,
    workspaceOwnerId: input.executionContext.workspaceOwnerId,
    projectIdentity: Object.freeze(projectIdentity),
    knownActorIds: Object.freeze([input.actorUserId]),
    bindings: Object.freeze(bindings.map((binding) => ({
      id: binding.id,
      userId: binding.userId,
      projectId: binding.projectId,
      provider: binding.provider,
      runtime: binding.runtime,
      sessionKey: binding.sessionKey,
      externalSessionId: binding.externalSessionId,
      status: binding.status,
    }))),
    sessions: Object.freeze(sessions.map((session) => ({
      id: session.id,
      userId: session.userId,
      projectId: session.projectId,
      sessionKey: session.sessionKey,
      activeProvider: session.activeProvider,
      runtime: session.runtime,
      status: session.status,
    }))),
    activeTurns: Object.freeze([]),
  });
  // Enumerate the full provider matrix before the first mutation. Session-file
  // deletion is not a stop proof after a backend restart; these adapters also
  // attest and remove Gateway runs, persistent CLI containers, credentials,
  // and provider singleton reservations.
  const cleanupSnapshots = new Map<ProjectChatRouteProvider, readonly ProjectRuntimeResource[]>();
  const enumerated = await Promise.all(PROJECT_CHAT_ROUTE_PROVIDERS.map(async (provider) => ({
    provider,
    resources: await PROJECT_RUNTIME_CLEANUP_ADAPTERS[provider].enumerate(cleanupScope),
  })));
  for (const entry of enumerated) {
    assertProjectRuntimeCleanupResourcesForReset({
      provider: entry.provider,
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      resources: entry.resources,
    });
    cleanupSnapshots.set(entry.provider, entry.resources);
  }

  for (const session of sessions) {
    const provider = fromPersistedProjectChatProvider(session.activeProvider as ProjectChatPersistedProvider);
    if (!isQualifiableProjectProvider(provider) || !isProjectChatRouteProvider(provider)) {
      throw projectChatResetNotQuiescent(
        `The ${session.activeProvider} legacy Project session has no qualified termination path.`,
      );
    }
    if (session.runtime !== getProjectChatProviderRuntimeDescriptor(provider).runtime) {
      throw projectChatResetNotQuiescent(
        `The ${projectChatProviderDisplayName(provider)} legacy Project session runtime does not match reset ownership.`,
      );
    }
  }

  for (const binding of bindings) {
    const provider = fromPersistedProjectChatProvider(binding.provider as ProjectChatPersistedProvider);
    if (!isQualifiableProjectProvider(provider) || !isProjectChatRouteProvider(provider)) {
      throw projectChatResetNotQuiescent(
        `The ${binding.provider} Project binding has no qualified termination path.`,
      );
    }
    if (binding.runtime !== getProjectChatProviderRuntimeDescriptor(provider).runtime) {
      throw projectChatResetNotQuiescent(
        `The ${projectChatProviderDisplayName(provider)} Project binding runtime does not match reset ownership.`,
      );
    }
    const sessionIds = Array.from(new Set(
      [binding.sessionKey, binding.externalSessionId]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ));
    if (provider === 'OPENCLAW') continue;
    const allowedSessionIds = new Set(
      (nativeSessions.get(provider) || []).map((session) => session.sessionId),
    );
    const unattestedSessionIds = sessionIds.filter((sessionId) => !allowedSessionIds.has(sessionId));
    const safelyAbsentNativeIds = unattestedSessionIds
      .filter((sessionId) => !nativeSessionArtifactsPresent(provider, sessionId));
    const safelyAbsent = new Set(safelyAbsentNativeIds);
    if (unattestedSessionIds.some((sessionId) => !safelyAbsent.has(sessionId))) {
      throw projectChatResetNotQuiescent(
        `The ${projectChatProviderDisplayName(provider)} Project binding session does not match immutable reset ownership.`,
      );
    }
  }
  try {
    await retireLegacyOpenClawProjectRuntime({
      actorUserId: input.actorUserId,
      targetProjectIds: projectIds,
      targetCanonicalRoot: input.executionContext.canonicalRoot,
      exactServerOwnedSessionKeys: Array.from(new Set([
        openClawSessionKey,
        ...input.exactServerOwnedOpenClawSessionKeys,
      ])),
      adapterOwnedSessionKeys: [openClawSessionKey],
    });
  } catch {
    throw projectChatResetNotQuiescent(
      'Legacy OpenClaw Project runtime cleanup could not be safely verified.',
    );
  }
  await cleanupProjectRuntimeAdapterMatrixForDestructiveReset({
    actorUserId: input.actorUserId,
    cleanupScope,
    providers: PROJECT_CHAT_ROUTE_PROVIDERS,
    snapshots: cleanupSnapshots,
  });
  for (const provider of nativeSessions.keys()) {
    for (const session of nativeSessions.get(provider) || []) {
      if (nativeSessionArtifactsPresent(provider, session.sessionId)) {
        throw projectChatResetNotQuiescent(
          `The ${projectChatProviderDisplayName(provider)} Project session artifacts remain after runtime cleanup.`,
        );
      }
    }
    if (listNativeProjectSessions(provider, nativeQuery).length !== 0) {
      throw projectChatResetNotQuiescent(
        `The ${projectChatProviderDisplayName(provider)} Project session cleanup could not be verified.`,
      );
    }
  }
  return { bindings, sessions };
}

async function performProjectChatDestructiveReset(input: {
  actorUserId: string;
  actorAuthorizationVersion: number;
  workspaceOwnerId: string;
  projectName: string;
  projectDir: string;
  provider: AgentProviderName;
  executionContext: ProjectSandboxExecutionContext;
  expectedVersion: unknown;
}) {
  // Clear retires exact OpenClaw registrations even when a native provider is
  // currently selected, so every provider path must honor the import gate.
  await assertLegacyOpenClawProjectDestructiveMutationSafe();
  await assertLegacyOpenClawProjectMigrationInactive(input.executionContext.projectId);
  const coordination = await requireSelectedProjectChatState({
    actorUserId: input.actorUserId,
    projectIdentityId: input.executionContext.projectId,
    provider: input.provider,
    expectedVersion: input.expectedVersion,
  });
  await convergeProjectChatTurnForDestructiveReset({
    actorUserId: input.actorUserId,
    projectIdentityId: input.executionContext.projectId,
    executionContext: input.executionContext,
    coordination,
  });
  // Durable recovery can detach or expire a turn before its provider promise
  // finishes onComplete/onError/onSettled. Quiesce every exact in-memory run,
  // not merely the turn still named by ProjectChatState.activeTurnId.
  await quiesceProjectChatBrokerCallbacksForDestructiveReset({
    actorUserId: input.actorUserId,
    projectIdentityId: input.executionContext.projectId,
  });
  const quiescentCoordination = await readProjectChatCoordinationState({
    actorUserId: input.actorUserId,
    projectIdentityId: input.executionContext.projectId,
    recoverStale: false,
  });
  if (!quiescentCoordination.state || quiescentCoordination.activeTurn) {
    throw projectChatResetNotQuiescent(
      'Project Chat callbacks did not converge to an idle durable state; no data was cleared.',
    );
  }
  const quiescentState = quiescentCoordination.state;
  if (!isQualifiableProjectProvider(input.provider)) {
    throw new UnsupportedProjectChatProviderError(
      input.provider,
      'This Project provider has no qualified destructive reset path.',
    );
  }
  const descriptor = getProjectChatProviderRuntimeDescriptor(input.provider);
  const completed = await withProjectChatRuntimeAdmission({
    actorUserId: input.actorUserId,
    actorAuthorizationVersion: input.actorAuthorizationVersion,
    projectIdentityId: input.executionContext.projectId,
    provider: toPersistedProjectChatProvider(input.provider),
    runtime: descriptor.runtime,
    operation: projectChatRuntimeOperationId('destructive-reset', input.provider),
    leaseOwner: PROJECT_CHAT_LEASE_OWNER,
    expectedVersion: quiescentState.version,
    recoveryExecutionContext: input.executionContext,
  }, async (admission) => {
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    const identity = await ensureProjectAssistantIdentity(
      input.projectDir,
      input.actorUserId,
      input.projectName,
      { workspaceOwnerId: input.workspaceOwnerId },
    );
    await markProjectChatDestructiveResetStarted({
      actorUserId: input.actorUserId,
      projectIdentityId: input.executionContext.projectId,
      legacyProjectId: input.projectName,
      admission,
    });
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    const terminated = await terminateProjectChatBindingsForDestructiveReset({
      actorUserId: input.actorUserId,
      projectIdentityId: input.executionContext.projectId,
      legacyProjectId: input.projectName,
      executionContext: input.executionContext,
      exactServerOwnedOpenClawSessionKeys: [
        identity.sessionKey,
        `agent:portal:${identity.sessionId}`,
      ],
    });
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    // This legacy history file is a write-only, database-derived projection.
    // Empty it atomically before the authoritative DB commit so a crash after
    // commit cannot retain transcript plaintext. It is never used to decide
    // provider/session state, so a failed commit leaves the live database and
    // non-transcript session projection authoritative.
    writeProjectRuntimeTextFile(
      input.projectDir,
      '.agent-history.json',
      JSON.stringify({ messages: [], model: '' }),
      PROJECT_METADATA_MAX_BYTES,
    );
    const reset = await commitProjectChatDestructiveReset({
      actorUserId: input.actorUserId,
      projectIdentityId: input.executionContext.projectId,
      legacyProjectId: input.projectName,
      admission,
    });
    // Unlike the history projection, this compatibility file describes
    // session status. Change it only after the database reset commits so a
    // failed transaction cannot falsely advertise an uninitialized session.
    // A post-commit write failure is safely retryable because DB bindings and
    // transcript state remain the sole authority.
    writeProjectSessionProjectionBestEffort(input.projectDir, {
      initialized: false,
      stableSlug: identity.stableSlug,
    });
    for (const binding of terminated.bindings) {
      const boundProvider = fromPersistedProjectChatProvider(binding.provider as ProjectChatPersistedProvider);
      if (isQualifiableProjectProvider(boundProvider)) {
        clearProjectNativeRun({
          userId: input.actorUserId,
          projectId: input.executionContext.projectId,
          provider: boundProvider,
        });
      }
    }
    return reset;
  });
  return {
    ...completed.result,
    stateVersion: completed.state.version,
    runtime: descriptor.runtime,
  };
}

// DELETE /api/projects/:name/chat/history - Clear chat history for this project
router.delete('/:name/chat/history', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let releaseProjectNameLock: (() => void) | null = null;
  try {
    if (rejectDestructiveProjectChatResetRouteForRelease(res)) return;
    const { name } = req.params;
    const {
      actorUserId: userId,
      workspaceOwnerId: ownerId,
      projectDir: requestedProjectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, name),
    );
    const renameConvergence = await convergeInterruptedProjectRenameForDestructiveOperation({
      actorUserId: userId,
      workspaceOwnerId: ownerId,
      projectName: name,
    });
    if (renameConvergence.renamedTo) {
      res.status(409).json({
        error: 'This Project finished renaming. Reopen Project Chat using its current name.',
        code: 'PROJECT_RENAMED',
        newName: renameConvergence.renamedTo,
        retryable: true,
      });
      return;
    }
    const projectName = renameConvergence.projectName;
    const projectDir = renameConvergence.projectDir || requestedProjectDir;
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      userId,
      ownerId,
      projectName,
      projectDir,
      req.query.provider || req.body?.provider,
      { requireQualification: false, readOnly: true },
    );
    if (!getProjectChatProviderCapability(provider).supportsReset) {
      throw new UnsupportedProjectChatProviderError(
        provider,
        'This Project provider does not expose a server-verified reset path.',
      );
    }
    const reset = await performProjectChatDestructiveReset({
      actorUserId: userId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      workspaceOwnerId: ownerId,
      projectName,
      projectDir,
      provider,
      executionContext,
      expectedVersion: req.query.stateVersion ?? req.body?.stateVersion,
    });
    res.json({
      success: true,
      provider,
      ...reset,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    if (error instanceof ProjectIdentityLifecycleError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: true,
      });
      return;
    }
    res.status(500).json({ error: 'Failed to clear history' });
  } finally {
    releaseProjectNameLock?.();
  }
});

// GET /api/projects/:name/chat/session-status - Check if gateway session is still active
router.get('/:name/chat/session-status', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId: userId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      userId,
      ownerId,
      name,
      projectDir,
      req.query.provider,
      { requireQualification: false, readOnly: true },
    );
    const existing = await readExistingProjectChatBinding({
      actorUserId: userId,
      provider,
      executionContext,
      allowStaleContext: true,
    });
    if (existing.staleBinding) {
      res.json({
        active: false,
        running: false,
        runStatus: 'idle',
        model: null,
        modelValidated: false,
        modelVerified: false,
        configuredModel: projectChatClientModel(provider, existing.staleBinding.model),
        dbStatus: 'stale',
        sessionKey: null,
        provider,
        runtime: existing.staleBinding.runtime,
        stateVersion: null,
        requiresPreparation: true,
        staleReason: existing.staleReason,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    if (!existing.binding) {
      res.json({
        active: false,
        running: false,
        runStatus: 'idle',
        model: null,
        modelValidated: false,
        modelVerified: false,
        configuredModel: null,
        dbStatus: 'uninitialized',
        sessionKey: null,
        provider,
        runtime: null,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    if (isNativeProjectChatRouteProvider(provider)) {
      const coordination = await readProjectChatCoordinationState({
        actorUserId: userId,
        projectIdentityId: executionContext.projectId,
      });
      const snapshot = getProjectNativeRunSnapshot({
        userId,
        projectId: executionContext.projectId,
        provider,
      });
      res.json({
        active: Boolean(existing.nativeSession),
        running: Boolean(snapshot?.active),
        runStatus: snapshot?.status || 'idle',
        // Native Project adapters have no idle-session model readback contract.
        // Keep configured state separate instead of presenting it as active.
        model: null,
        modelValidated: Boolean(existing.binding.model || existing.nativeSession?.model),
        modelVerified: false,
        configuredModel: projectChatClientModel(
          provider,
          existing.binding.model,
          existing.nativeSession?.model,
        ),
        dbStatus: existing.portalSession?.status || existing.binding.status,
        sessionKey: existing.providerSessionKey,
        provider,
        runtime: existing.binding.runtime,
        stateVersion: coordination.state?.version ?? null,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    const binding = existing.binding;
    const sessionKey = existing.providerSessionKey;
    if (!sessionKey) {
      throw new ProjectChatBindingReadError('The OpenClaw Project binding has no existing session.');
    }
    const result = await getSessionInfo(sessionKey);
    const dbSession = existing.portalSession;

    if (!result.ok) {
      if (/session not found/i.test(String(result.error || ''))) {
        res.json({
          active: false,
          model: null,
          modelVerified: false,
          dbStatus: dbSession ? 'expired' : 'none',
          provider,
          runtime: binding.runtime,
          executionContext: serializeProjectSandboxContext(executionContext),
        });
        return;
      }
      throw new OpenClawProjectModelVerificationError(
        'SESSION_INSPECTION_FAILED',
        'OpenClaw could not verify the active Project session.',
        String(result.error || ''),
      );
    }
    if (!result.data || result.data.stale) {
      throw new OpenClawProjectModelVerificationError(
        result.data?.stale ? 'SESSION_INSPECTION_STALE' : 'SESSION_INSPECTION_FAILED',
        'OpenClaw could not verify the active Project session.',
        String(result.data?.staleReason || 'Session metadata was unavailable'),
      );
    }
    const activeModel = readVerifiedOpenClawSessionModel(result.data);
    if (!activeModel) {
      throw new OpenClawProjectModelVerificationError(
        'MODEL_READBACK_FAILED',
        'OpenClaw did not report an active Project model.',
      );
    }

    res.json({
      active: true,
      model: activeModel,
      modelVerified: true,
      dbStatus: dbSession?.status || 'none',
      provider,
      runtime: binding.runtime,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    console.error('[Project Chat Session Status] Failed:', error?.message || error);
    res.status(503).json({ active: false, error: 'Project provider session status is temporarily unavailable.' });
  }
});

// --- Assistant Chat Routes ---

// Helper: detect project type
function detectProjectType(projectDir: string): string {
  const hasPackageJson = fs.existsSync(path.join(projectDir, 'package.json'));
  const hasIndexHtml = fs.existsSync(path.join(projectDir, 'index.html'));
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'React';
      if (pkg.dependencies?.vue) return 'Vue';
      if (pkg.dependencies?.next) return 'Next.js';
      if (pkg.dependencies?.svelte) return 'Svelte';
      return 'Node.js';
    } catch {}
  }
  if (fs.existsSync(path.join(projectDir, 'requirements.txt'))) return 'Python';
  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) return 'Rust';
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) return 'Go';
  if (hasIndexHtml) return 'Static HTML';
  return 'Unknown';
}

// Auto-commit helper: commits any changes in project dir after assistant edits files
function getModelDisplayName(model: string): string {
  const names: Record<string, string> = {
    'anthropic/claude-fable-5': 'Claude Fable 5',
    'anthropic/claude-opus-5': 'Claude Opus 5',
    'anthropic/claude-opus-4-8': 'Claude Opus 4.8',
    'anthropic/claude-opus-4-6': 'Claude Opus 4.6',
    'anthropic/claude-opus-4-5-20251101': 'Claude Opus 4.5',
    'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'anthropic/claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'anthropic/claude-haiku-4-1': 'Claude Haiku 4.1',
    'anthropic/claude-haiku-4-20250514': 'Claude Haiku 4',
    'anthropic/claude-haiku-4-5': 'Claude Haiku 4.5',
    'ollama/qwen2.5-coder:3b': 'Qwen Coder 3B',
    'ollama/qwen2.5-coder:7b': 'Qwen Coder 7B',
    'ollama/qwen3:1.7b': 'Qwen3 1.7B',
    'ollama/qwen3:4b': 'Qwen3 4B',
    'ollama/qwen3:8b': 'Qwen3 8B',
    'ollama/qwen3.5:0.8b': 'Qwen 3.5 0.8B',
    'ollama/qwen3.5:2b': 'Qwen 3.5 2B',
    'ollama/qwen3.5:4b': 'Qwen 3.5 4B',
    'ollama/qwen3.5:9b': 'Qwen 3.5 9B',
    'ollama/qwen3.6:27b': 'Qwen 3.6 27B',
    'ollama/qwen3.6:35b': 'Qwen 3.6 35B',
    'ollama/gemma4:e2b': 'Gemma 4 E2B',
    'ollama/gemma4:e4b': 'Gemma 4 E4B',
    'ollama/gemma4:12b': 'Gemma 4 12B',
    'openai/gpt-5.6-sol': 'GPT-5.6 Sol',
    'openai/gpt-5.6-terra': 'GPT-5.6 Terra',
    'openai/gpt-5.6-luna': 'GPT-5.6 Luna',
    'openai/gpt-5.5': 'GPT-5.5',
    'codex/gpt-5.5': 'GPT-5.5',
    'openai/gpt-5.4': 'GPT-5.4 Codex',
    'openai/gpt-5.4-mini': 'GPT-5.4 Mini',
    'openai/gpt-5.1': 'GPT-5.1',
    'openai-codex/gpt-5.1': 'GPT-5.1',
    'openai/gpt-5.2': 'GPT-5.2',
    'openai-codex/gpt-5.2': 'GPT-5.2',
    'openai/gpt-5.3-codex': 'Codex (5.3)',
    'openai-codex/gpt-5.3-codex': 'Codex (5.3)',
    'openai-codex/gpt-5.4': 'GPT-5.4 Codex',
  };
  return names[model] || model.replace(/^(anthropic|ollama|codex|openai-codex|openai)\//, '');
}

async function autoCommitProjectChanges(
  projectDir: string,
  actorId: string,
  projectId: string,
  workspaceOwnerId: string,
  projectName: string,
  summary?: string,
  model?: string,
) {
  let transientShelved = false;
  const git = (args: string[], timeoutMs = 15_000) => runPreparedProjectGitCommand({
    actorId,
    projectId,
    workspace: projectDir,
    args,
    timeoutMs,
    nameHint: `${actorId}:${projectName}:auto-commit`,
  });

  try {
    // Ensure git repo exists
    try { await git(['rev-parse', '--git-dir']); } catch {
      await git(['init']);
    }

    const initialStatus = await git(['status', '--porcelain=v1', '-z', '-uall']);
    if (!initialStatus) return null;

    const initialPaths = Array.from(new Set(
      parseProjectGitPorcelain(initialStatus).map((entry) => entry.path).filter(Boolean),
    ));
    const transientPaths = initialPaths.filter(isTransientProjectStatePath);

    transientShelved = await shelveTransientProjectState(git, transientPaths);

    const status = await git(['status', '--porcelain=v1', '-z', '-uall']);
    if (!status) return null;

    const changedFiles = Array.from(new Set(
      parseProjectGitPorcelain(status)
        .map((entry) => entry.path)
        .filter(Boolean)
        .filter((filePath) => !isTransientProjectStatePath(filePath))
    ));
    if (!changedFiles.length) return null;

    await git(projectGitAddAllArgs());

    const stagedNames = await git(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv'], 5000);
    const stagedFiles = stagedNames.split('\0').filter(Boolean);
    assertNoTransientProjectStateStaged(stagedFiles);
    if (!stagedFiles.length) return null;

    let commitMsg = summary ? `Assistant: ${summary}` : '';
    if (!summary) {
      try {
        const diff = (await git(['diff', '--cached', '--stat', '--no-ext-diff', '--no-textconv'], 5000)).trim();
        const diffLines = diff.split('\n').filter(Boolean);
        const fileChanges: { file: string; added: number; removed: number }[] = [];
        for (const line of diffLines) {
          const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)/);
          if (match) {
            const [, file, _changes, plusMinus] = match;
            const added = (plusMinus.match(/\+/g) || []).length;
            const removed = (plusMinus.match(/-/g) || []).length;
            fileChanges.push({ file: file.trim(), added, removed });
          }
        }

        if (fileChanges.length === 1) {
          const fc = fileChanges[0];
          const action = fc.added > 0 && fc.removed === 0 ? 'Added' : fc.removed > 0 && fc.added === 0 ? 'Removed' : 'Updated';
          commitMsg = `Assistant: ${action} ${fc.file}`;
        } else if (fileChanges.length > 1 && fileChanges.length <= 3) {
          const fileList = fileChanges.map((fc) => fc.file).join(', ');
          commitMsg = `Assistant: Updated ${fileList}`;
        } else if (fileChanges.length > 3) {
          const totalAdded = fileChanges.reduce((sum, fc) => sum + fc.added, 0);
          const totalRemoved = fileChanges.reduce((sum, fc) => sum + fc.removed, 0);
          commitMsg = `Assistant: Updated ${fileChanges.length} files (+${totalAdded}/-${totalRemoved})`;
        }
      } catch {
        // ignore and fall back below
      }

      if (!commitMsg) {
        commitMsg = `Assistant update: ${stagedFiles.slice(0, 5).join(', ')}${stagedFiles.length > 5 ? ` (+${stagedFiles.length - 5} more)` : ''}`;
      }
    }

    const authorName = model ? `Assistant AI (${getModelDisplayName(model)})` : 'Assistant AI';
    const authorEmail = (process.env.GIT_AUTHOR_EMAIL || 'admin@localhost').replace(/[\r\n<>]/g, '').slice(0, 254);
    const author = `${authorName.replace(/[\r\n<>]/g, '').slice(0, 200)} <${authorEmail}>`;

    await git(['commit', `--author=${author}`, '-m', commitMsg.slice(0, 4096)]);
    const hash = (await git(['rev-parse', '--short', 'HEAD'])).trim();
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    let linesAdded = 0;
    let linesRemoved = 0;
    try {
      const statLine = (await git(['diff', 'HEAD~1', '--shortstat', '--no-ext-diff', '--no-textconv'], 5000)).trim();
      const addM = statLine.match(/(\d+) insertion/);
      const delM = statLine.match(/(\d+) deletion/);
      linesAdded = addM ? parseInt(addM[1]) : 0;
      linesRemoved = delM ? parseInt(delM[1]) : 0;
    } catch {}

    console.log(`[Agent] Auto-commit ${hash}: ${commitMsg}`);

    try {
      const app = await prisma.app.findFirst({ where: { userId: workspaceOwnerId, name: projectName } });
      await prisma.activityLog.create({
        data: {
          userId: actorId,
          action: 'PROJECT_GIT_COMMIT',
          resource: 'project',
          resourceId: app?.id,
          severity: 'INFO',
          metadata: { projectName, hash, message: commitMsg, filesChanged: stagedFiles.length, branch, linesAdded, linesRemoved },
        },
      });
    } catch {}

    return { hash, message: commitMsg, filesChanged: stagedFiles.length };
  } catch (err: any) {
    console.error('[Agent] Auto-commit error:', err.message);
    throw err;
  } finally {
    if (transientShelved) {
      try {
        await git(['stash', 'pop', '--index']);
      } catch (restoreError) {
        console.warn('[Agent] Failed to restore transient project state after auto-commit:', restoreError);
      }
    }
  }
}

async function autoCommitProjectChangesWithRetry(
  ...input: Parameters<typeof autoCommitProjectChanges>
): Promise<{ commit: Awaited<ReturnType<typeof autoCommitProjectChanges>>; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return {
        commit: await autoCommitProjectChanges(...input),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Project checkpoint failed');
}

async function persistProjectCheckpointNotice(input: {
  actorUserId: string;
  projectId: string;
  sessionKey: string;
  turnId: string;
  provider: string;
  runtime: string;
  model?: string | null;
  content: string;
}): Promise<void> {
  const messageId = `project-checkpoint:${input.turnId}`;
  await prisma.projectChatMessage.upsert({
    where: {
      userId_projectId_messageId: {
        userId: input.actorUserId,
        projectId: input.projectId,
        messageId,
      },
    },
    update: {
      content: input.content,
      model: input.model || null,
    },
    create: {
      projectId: input.projectId,
      userId: input.actorUserId,
      sessionKey: input.sessionKey,
      role: 'system',
      content: input.content,
      messageId,
      provider: input.provider,
      runtime: input.runtime,
      model: input.model || null,
    },
  });
}

async function checkpointProjectAfterProviderTurn(input: {
  projectDir: string;
  actorUserId: string;
  projectId: string;
  workspaceOwnerId: string;
  projectName: string;
  sessionKey: string;
  turnId: string;
  provider: string;
  runtime: string;
  model?: string | null;
}): Promise<void> {
  await runProjectCheckpointBoundary({
    createCheckpoint: () => autoCommitProjectChangesWithRetry(
      input.projectDir,
      input.actorUserId,
      input.projectId,
      input.workspaceOwnerId,
      input.projectName,
      undefined,
      input.model || undefined,
    ),
    persistNotice: (content) => persistProjectCheckpointNotice({
      actorUserId: input.actorUserId,
      projectId: input.projectId,
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      provider: input.provider,
      runtime: input.runtime,
      model: input.model,
      content,
    }),
    successNotice: (checkpoint) => (
      `${checkpoint.attempts > 1 ? 'Checkpoint retry succeeded. ' : ''}`
      + `Committed ${checkpoint.commit!.hash}: ${checkpoint.commit!.message}`
    ),
    failureNotice: 'Project checkpoint failed after one automatic retry. Your file changes remain in the project; retry from the Project Git controls.',
    logError: (message, error) => console.error(`[Project Chat] ${message}:`, error),
  });
}

// ========================================
// Session Management (rotation to prevent 200K token overflow)
// ========================================

// --- Legacy backward-compat: .assistant-* / .marcus-* → .agent-* ---
// Auto-migrate known legacy internal files on first access.

router.use(authenticateToken, requireApproved);

// GET /api/projects/:name/assistant/resume-session - Read-only active-turn handshake.
//
// A browser refresh during a tool call must not compete for the single active
// turn slot by running ensure-session again. This route authenticates the
// exact durable turn and its existing provider binding without mutating the
// runtime, model, binding, or coordination version.
router.get('/:name/assistant/resume-session', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const requestedTurnId = String(req.query.turnId || '').trim();
    if (!requestedTurnId || requestedTurnId.length > 512 || requestedTurnId.includes('\u0000')) {
      res.status(400).json({ error: 'A valid active Project turn ID is required.' });
      return;
    }
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.query.provider,
      { requireQualification: false, readOnly: true },
    );
    const coordination = await readProjectChatCoordinationState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
    });
    if (!coordination.state) {
      throw new ProjectChatLeaseError('STATE_NOT_FOUND', 'Project Chat state was not found', 404);
    }
    const activeTurn = visibleProjectChatActiveTurn(coordination.activeTurn);
    if (!activeTurn || activeTurn.id !== requestedTurnId) {
      throw new ProjectChatLeaseError('TURN_NOT_ACTIVE', 'The requested Project Chat turn is no longer active');
    }
    if (activeTurn.provider !== toPersistedProjectChatProvider(provider)) {
      throw new ProjectChatLeaseError('PROVIDER_MISMATCH', 'The active Project Chat turn belongs to another provider');
    }

    const bindingRead = await readExistingProjectChatBinding({
      actorUserId,
      provider,
      executionContext,
      requireActive: true,
      requireProviderSession: true,
    });
    const binding = bindingRead.binding;
    const sessionKey = String(activeTurn.providerSessionId || '').trim();
    const bindingSessions = new Set(
      [binding?.sessionKey, binding?.externalSessionId].map((value) => String(value || '').trim()).filter(Boolean),
    );
    if (
      !binding
      || binding.status !== 'active'
      || binding.runtime !== activeTurn.runtime
      || binding.sandboxRoot !== executionContext.canonicalRoot
      || binding.policyFingerprint !== executionContext.policyFingerprint
      || !sessionKey
      || !bindingSessions.has(sessionKey)
    ) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'The active Project Chat turn no longer matches its verified provider binding',
        503,
      );
    }
    const boundModel = normalizePortalModelId(activeTurn.model || binding.model || '');
    if (!boundModel || (binding.model && normalizePortalModelId(binding.model) !== boundModel)) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'The active Project model is not validated against its provider binding',
        503,
      );
    }

    res.json({
      resumed: true,
      turnId: activeTurn.id,
      sessionKey,
      agentId: `${provider.toLowerCase().replace('_', '-')}-project`,
      provider,
      runtime: activeTurn.runtime,
      model: projectChatClientModel(provider, boundModel),
      modelValidated: true,
      ...(provider === 'OPENCLAW' ? { modelVerified: true } : {}),
      ...(isNativeProjectChatRouteProvider(provider) ? { modelConfigured: true } : {}),
      stateVersion: coordination.state.version,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[resume-session] Error:', error?.message || error);
    res.status(500).json({ error: 'Failed to resume active Project turn' });
  }
});

// POST /api/projects/:name/assistant/ensure-session - Create/verify agent + session, return keys for WS chat
router.post('/:name/assistant/ensure-session', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.body?.provider,
    );
    const coordination = await requireSelectedProjectChatState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      provider,
      expectedVersion: req.body?.stateVersion,
    });

    const admitted = await withProjectChatRuntimeAdmission({
      actorUserId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      projectIdentityId: executionContext.projectId,
      provider: toPersistedProjectChatProvider(provider),
      runtime: getProjectChatProviderRuntimeDescriptor(provider).runtime,
      operation: projectChatRuntimeOperationId('ensure-session', provider, req.body?.model || null),
      leaseOwner: PROJECT_CHAT_LEASE_OWNER,
      expectedVersion: coordination.state!.version,
      recoveryExecutionContext: executionContext,
      leaseDurationMs: PROJECT_CHAT_LEASE_DURATION_MS,
    }, async () => {
      await repairTerminalProjectChatPresentations({
        actorUserId,
        projectIdentityId: executionContext.projectId,
        limit: 100,
      });
      // Validate or create provider-owned memory before runtime preparation so
      // the workspace ownership pass includes a newly created regular file.
      ensureProjectMemory(projectDir, name);
      if (isNativeProjectChatRouteProvider(provider)) {
        const requestedModel = normalizePortalModelId(req.body?.model || '');
        const resolved = await ensureNativeProjectChatBinding({
          actorUserId,
          workspaceOwnerId: ownerId,
          projectName: name,
          projectDir,
          provider,
          executionContext,
          model: requestedModel || null,
        });
        writeProjectSessionProjectionBestEffort(projectDir, {
          initialized: true,
          model: resolved.configuredModel,
          modelConfigured: true,
          lastActivity: new Date().toISOString(),
          stableSlug: resolved.identity.stableSlug,
        });
        return {
          sessionKey: resolved.sessionKey,
          agentId: resolved.agentId,
          model: resolved.configuredModel,
          modelValidated: true,
          modelConfigured: true,
          modelWarning: null,
          initialized: true,
          provider,
          runtime: resolved.binding.runtime,
          bindingId: resolved.binding.id,
          executionContext: serializeProjectSandboxContext(executionContext),
        };
      }

      const requestedModel = normalizePortalModelId(req.body?.model || '');
      const existingBinding = await prisma.projectChatProviderBinding.findUnique({
        where: {
          userId_projectId_provider: {
            userId: actorUserId,
            projectId: executionContext.projectId,
            provider: 'OPENCLAW',
          },
        },
      });

      // Ownership preparation never follows project-created symlinks. The same
      // numeric identity is used by lifecycle, Git, and every Project provider.
      await ensureProjectChatWorkspaceOwnership(executionContext, projectDir);
      const catalogScope = await ensureOpenClawProjectAgentCatalogScope(executionContext);
      const modelResolution = await resolveAllowedOpenClawProjectModel(
        catalogScope.agentId,
        [
          requestedModel,
          existingBinding?.model || '',
          getDefaultModel() || '',
        ],
        requestedModel,
      );
      const selectedModel = modelResolution.model;
      const resolved = await ensureOpenClawProjectRuntime({
        actorUserId,
        workspaceOwnerId: ownerId,
        projectName: name,
        projectDir,
        executionContext,
        // Do not write the requested model into the binding until the gateway
        // has both accepted it and reported it back as the live session model.
        model: existingBinding?.model || null,
      });
      const { identity } = resolved;
      const sessionKey = identity.sessionKey;
      const modelVerification = await verifyAndPersistOpenClawProjectModel({
        actorUserId,
        projectId: executionContext.projectId,
        portalSessionKey: identity.sessionId,
        providerSessionKey: sessionKey,
        desiredModel: selectedModel,
      });
      const binding = modelVerification.binding;
      const verifiedModel = modelVerification.verified.model;

      writeProjectSessionProjectionBestEffort(projectDir, {
        initialized: true,
        model: verifiedModel,
        lastActivity: new Date().toISOString(),
        stableSlug: identity.stableSlug,
      });

      return {
        sessionKey,
        agentId: identity.agentId,
        model: verifiedModel,
        modelValidated: true,
        modelVerified: true,
        modelWarning: modelResolution.warning || null,
        initialized: true,
        provider,
        runtime: binding.runtime,
        bindingId: binding.id,
        executionContext: serializeProjectSandboxContext(executionContext),
      };
    });
    res.json({ ...admitted.result, stateVersion: admitted.state.version });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[ensure-session] Error:', error.message);
    res.status(500).json({ error: 'Failed to ensure Project provider session' });
  }
});

// Legacy client-written transcript storage is intentionally retired. Project
// Chat history now lives in ProjectChatMessage, where assistant/tool/system
// provenance can only be written by the server-owned provider runner.
router.get('/:name/assistant/history', authenticateToken, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Legacy Project Chat history is retired. Use /chat/history.',
    code: 'PROJECT_CHAT_LEGACY_HISTORY_RETIRED',
  });
});

router.post('/:name/assistant/history', authenticateToken, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Client-written Project Chat transcripts are not accepted. Send through /assistant/send.',
    code: 'PROJECT_CHAT_LEGACY_HISTORY_RETIRED',
  });
});

// GET /api/projects/:name/assistant/active-model - Get the ACTUAL active model for this project's session
router.get('/:name/assistant/active-model', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.query.provider,
      { requireQualification: false, readOnly: true },
    );
    const existing = await readExistingProjectChatBinding({
      actorUserId,
      provider,
      executionContext,
    });
    if (!existing.binding) {
      res.json({
        activeModel: null,
        modelProvider: null,
        model: null,
        configuredModel: null,
        verified: false,
        isOverridden: false,
        sessionKey: null,
        provider,
        runtime: null,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    if (isNativeProjectChatRouteProvider(provider)) {
      const configuredModel = projectChatClientModel(
        provider,
        existing.binding.model,
        existing.nativeSession?.model,
      ) || '';
      res.json({
        // The persisted native invocation choice is not a live provider readback.
        // Do not label it as the active model until that adapter exposes an
        // authoritative challenge/readback contract.
        activeModel: null,
        modelProvider: null,
        model: null,
        configuredModel,
        verified: false,
        isOverridden: false,
        sessionKey: existing.providerSessionKey,
        provider,
        runtime: existing.binding.runtime,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    const binding = existing.binding;
    const sessionKey = existing.providerSessionKey;
    if (!sessionKey) {
      throw new ProjectChatBindingReadError('The OpenClaw Project binding has no existing session.');
    }
    const result = await getSessionInfo(sessionKey);
    if (result.ok && result.data && !result.data.stale) {
      const session = result.data;
      const activeModel = readVerifiedOpenClawSessionModel(session);
      if (!activeModel) {
        throw new OpenClawProjectModelVerificationError(
          'MODEL_READBACK_FAILED',
          'OpenClaw did not report an active Project model.',
        );
      }
      const [modelProvider, ...modelParts] = activeModel.split('/');
      const model = modelParts.join('/');
      const configuredDefault = normalizePortalModelId(getDefaultModel() || '');
      
      res.json({ 
        activeModel,
        modelProvider,
        model,
        verified: true,
        isOverridden: Boolean(configuredDefault && activeModel !== configuredDefault),
        sessionKey,
        provider,
        runtime: binding.runtime,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
    } else {
      throw new OpenClawProjectModelVerificationError(
        result.data?.stale ? 'SESSION_INSPECTION_STALE' : 'SESSION_INSPECTION_FAILED',
        'OpenClaw could not verify the active Project model.',
        String(result.data?.staleReason || result.error || ''),
      );
    }
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    console.error('[Agent] Active model check error:', error.message);
    res.status(503).json({
      error: 'Project model verification failed.',
      code: 'PROJECT_MODEL_VERIFICATION_FAILED',
    });
  }
});

// GET /api/projects/:name/assistant/memory - Load project memory
router.get('/:name/assistant/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      req.params.name,
      projectDir,
      req.query.provider,
    );

    const content = readProjectMemory(projectDir);
    res.json({ content, executionContext: serializeProjectSandboxContext(executionContext) });
  } catch (error) {
    if (sendProjectChatProviderError(res, error)) return;
    res.status(500).json({ error: 'Failed to load memory' });
  }
});

// POST /api/projects/:name/assistant/reset - Reset assistant session (for clear chat)
router.post('/:name/assistant/reset', authenticateToken, async (req: Request, res: Response) => {
  let releaseProjectNameLock: (() => void) | null = null;
  try {
    if (rejectDestructiveProjectChatResetRouteForRelease(res)) return;
    const requestedProjectName = req.params.name;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir: requestedProjectDir,
    } = resolveActorProjectChatWorkspace(req, requestedProjectName);
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    releaseProjectNameLock = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, requestedProjectName),
    );
    const renameConvergence = await convergeInterruptedProjectRenameForDestructiveOperation({
      actorUserId,
      workspaceOwnerId: ownerId,
      projectName: requestedProjectName,
    });
    if (renameConvergence.renamedTo) {
      res.status(409).json({
        error: 'This Project finished renaming. Reopen Project Chat using its current name.',
        code: 'PROJECT_RENAMED',
        newName: renameConvergence.renamedTo,
        retryable: true,
      });
      return;
    }
    const projectName = renameConvergence.projectName;
    const projectDir = renameConvergence.projectDir || requestedProjectDir;
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    await assertLegacyOpenClawProjectDestructiveMutationSafe();
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      projectName,
      projectDir,
      req.body?.provider,
      { requireQualification: false, readOnly: true },
    );
    if (!getProjectChatProviderCapability(provider).supportsReset) {
      throw new UnsupportedProjectChatProviderError(
        provider,
        'This Project provider does not expose a server-verified reset path.',
      );
    }
    const reset = await performProjectChatDestructiveReset({
      actorUserId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      workspaceOwnerId: ownerId,
      projectName,
      projectDir,
      provider,
      executionContext,
      expectedVersion: req.body?.stateVersion,
    });
    res.json({
      success: true,
      provider,
      ...reset,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    if (error instanceof ProjectIdentityLifecycleError) {
      res.status(409).json({
        error: error.message,
        code: error.code,
        retryable: true,
      });
      return;
    }
    console.error('[Agent Reset] Error:', error);
    res.status(500).json({ error: 'Failed to reset session' });
  } finally {
    releaseProjectNameLock?.();
  }
});

// The browser used to own a second completion commit, racing the provider
// runner and producing .git/index.lock failures. Keep the legacy URL explicit
// but permanently retired so cached 4.0 preview bundles cannot revive it.
router.post('/:name/assistant/auto-commit', authenticateToken, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Project checkpoints are created once by the server after the provider turn completes.',
    code: 'PROJECT_CHECKPOINT_SERVER_OWNED',
  });
});

// Project memory is provider-owned runtime state. The browser write endpoint
// had no state-version CAS, size bound, or atomic provider admission, and no
// current UI consumes it. Keep a fixed tombstone so cached preview bundles
// cannot race an active provider by writing .agent-memory.md directly.
router.post('/:name/assistant/memory', authenticateToken, (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Direct Project memory writes are retired. Ask the active Project provider to update memory.',
    code: 'PROJECT_MEMORY_PROVIDER_OWNED',
  });
});

// Reconciles a browser-owned stable message ID without returning transcript
// content or searching outside the authenticated actor/project/provider tuple.
router.post('/:name/assistant/message-status', authenticateToken, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { name } = req.params;
    const { actorUserId, workspaceOwnerId, projectDir } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const messageId = String(req.body?.messageId || '').trim();
    const messageFingerprint = String(req.body?.messageFingerprint || '').trim().toLowerCase();
    if (!messageId || messageId.length > 512 || !/^[a-f0-9]{64}$/.test(messageFingerprint)) {
      res.status(400).json({
        error: 'A stable message ID and SHA-256 payload fingerprint are required.',
        code: 'PROJECT_CHAT_MESSAGE_STATUS_INPUT_INVALID',
      });
      return;
    }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      workspaceOwnerId,
      name,
      projectDir,
      req.body?.provider,
      { requireQualification: false, readOnly: true },
    );
    const persistedMessage = await prisma.projectChatMessage.findFirst({
      where: { userId: actorUserId, projectId: executionContext.projectId, messageId },
      select: { id: true, role: true, content: true, provider: true },
    });
    const coordination = await readProjectChatCoordinationState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      recoverStale: false,
    });
    if (!persistedMessage) {
      res.json({
        found: false,
        status: 'absent',
        provider,
        messageId,
        projectId: executionContext.projectId,
        stateVersion: coordination.state?.version ?? null,
      });
      return;
    }
    const actualFingerprint = crypto.createHash('sha256').update(persistedMessage.content, 'utf8').digest();
    const expectedFingerprint = Buffer.from(messageFingerprint, 'hex');
    if (
      persistedMessage.role !== 'user'
      || persistedMessage.provider !== provider
      || expectedFingerprint.length !== actualFingerprint.length
      || !crypto.timingSafeEqual(actualFingerprint, expectedFingerprint)
    ) {
      throw new ProjectChatLeaseError(
        'REQUEST_REPLAY',
        'Project Chat message identity was already used for different content',
      );
    }
    const turn = await prisma.projectChatTurn.findUnique({
      where: {
        actorUserId_projectIdentityId_requestId: {
          actorUserId,
          projectIdentityId: executionContext.projectId,
          requestId: persistedMessage.id,
        },
      },
    });
    if (!turn || turn.provider !== toPersistedProjectChatProvider(provider)) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'Project Chat message admission is incomplete; clear Project Chat before retrying',
        409,
      );
    }
    const terminal = ['COMPLETED', 'ERROR', 'ABORTED', 'EXPIRED'].includes(turn.status);
    const dispatchStage = projectChatTurnDispatchStage(turn);
    const recoveryRequired = dispatchStage === PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED
      || (!terminal && dispatchStage === null);
    res.json({
      found: true,
      status: terminal ? 'terminal' : dispatchStage === PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED ? 'active' : 'admitted',
      turnStatus: turn.status.toLowerCase(),
      dispatchStatus: dispatchStage === PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED
        ? 'accepted'
        : dispatchStage === PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED
          ? 'unconfirmed'
          : 'unknown',
      recoveryRequired,
      provider,
      messageId,
      turnId: turn.id,
      projectId: executionContext.projectId,
      stateVersion: coordination.state?.version ?? null,
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[Project Chat Message Status] Error:', error?.message || error);
    res.status(500).json({ error: 'Failed to reconcile Project Chat message status' });
  }
});

// Rate limiter for assistant poll endpoint (prevent aggressive polling)
const assistantPollLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 360, // Four foreground tabs at the supported 750ms cadence, plus wake-up headroom.
  // A completed turn, another project, or another authenticated actor must
  // not consume the active turn's replay budget. The broad /api limiter still
  // caps aggregate traffic, so rotating turn IDs cannot bypass the host guard.
  keyGenerator: (req) => {
    let provider = 'INVALID';
    try {
      const normalized = normalizeProjectChatProvider(req.query.provider);
      provider = isProjectChatRouteProvider(normalized) ? normalized : 'INVALID';
    } catch {
      // Invalid provider identities share one bounded bucket.
    }
    const requestedTurnId = String(req.query.turnId || '').trim();
    const turnId = requestedTurnId && requestedTurnId.length <= 512 && !requestedTurnId.includes('\u0000')
      ? requestedTurnId
      : 'NO_VALID_TURN';
    return crypto.createHash('sha256').update([
      req.user?.userId || 'unauthenticated',
      String(req.params.name || ''),
      provider,
      turnId,
    ].join('\0')).digest('hex');
  },
  message: {
    error: 'Too many Project replay polling requests. Please slow down.',
    code: 'PROJECT_REPLAY_RATE_LIMITED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/projects/:name/assistant/poll - Poll for new messages from gateway session JSONL
// This replaces SSE streaming for long-running sessions (Cloudflare-compatible)
router.get('/:name/assistant/poll', authenticateToken, assistantPollLimiter, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    const afterLine = parseInt(req.query.after as string) || 0;
    const requestedTurnId = String(req.query.turnId || '').trim() || null;
    if (requestedTurnId && (requestedTurnId.length > 512 || requestedTurnId.includes('\u0000'))) {
      res.status(400).json({ error: 'Invalid Project Chat turn ID' });
      return;
    }
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.query.provider,
      { requireQualification: false, readOnly: true },
    );
    if (isProjectChatRouteProvider(provider)) {
      const coordination = await readProjectChatCoordinationState({
        actorUserId,
        projectIdentityId: executionContext.projectId,
      });
      if (!coordination.state) {
        throw new ProjectChatLeaseError('STATE_NOT_FOUND', 'Project Chat state was not found', 404);
      }
      const activeUserTurn = visibleProjectChatActiveTurn(coordination.activeTurn);
      const activeProviderTurn = activeUserTurn?.provider === toPersistedProjectChatProvider(provider)
        ? activeUserTurn
        : null;
      const latestTurn = await prisma.projectChatTurn.findFirst({
        where: {
          actorUserId,
          projectIdentityId: executionContext.projectId,
          provider,
          ...(requestedTurnId ? { id: requestedTurnId } : {}),
          NOT: { requestId: { startsWith: PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX } },
        },
        orderBy: { createdAt: 'desc' },
      });
      const selectedTurn = requestedTurnId
        ? latestTurn
        : activeProviderTurn || latestTurn;
      if (requestedTurnId && !selectedTurn) {
        throw new ProjectChatLeaseError('TURN_NOT_FOUND', 'Project Chat turn was not found', 404);
      }
      const selectedTurnActive = Boolean(
        activeProviderTurn
        && selectedTurn
        && activeProviderTurn.id === selectedTurn.id,
      );
      const bindingRead = await readExistingProjectChatBinding({
        actorUserId,
        provider,
        executionContext,
        // Terminal replay is durable and remains readable after a provider
        // session is cleaned up. An active run, however, must still be bound
        // to the exact native session before its cursor can be exposed.
        requireActive: selectedTurnActive,
        requireProviderSession: selectedTurnActive,
      });
      if (selectedTurn) {
        const binding = bindingRead.binding;
        const providerSessionId = String(selectedTurn.providerSessionId || '').trim();
        const boundSessions = new Set(
          [binding?.sessionKey, binding?.externalSessionId]
            .map((value) => String(value || '').trim())
            .filter(Boolean),
        );
        if (
          !binding
          || binding.runtime !== selectedTurn.runtime
          || !providerSessionId
          || !boundSessions.has(providerSessionId)
        ) {
          throw new ProjectChatBindingReadError(
            'The selected durable Project turn no longer matches its provider binding.',
          );
        }
      }
      const durableReplay = selectedTurn
        ? await readProjectChatTurnReplay({
            actorUserId,
            projectIdentityId: executionContext.projectId,
            turnId: selectedTurn.id,
            afterSeq: afterLine,
            limit: 1_000,
          })
        : null;
      const durableEvents: ProjectNativeRunEvent[] = (durableReplay?.events || []).map((event) => {
        const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        return {
          ...payload,
          seq: event.seq,
          ts: event.createdAt.getTime(),
          runId: selectedTurn?.id,
        } as unknown as ProjectNativeRunEvent;
      });
      const snapshot = matchingProjectNativeSnapshot(selectedTurn, getProjectNativeRunSnapshot({
        userId: actorUserId,
        projectId: executionContext.projectId,
        provider,
        afterSeq: afterLine,
      }));
      const brokerSettlementFailure = isProjectNativeSettlementFailure(snapshot);
      const baseReplayEvents = durableEvents.length > 0 ? durableEvents : snapshot?.events || [];
      const brokerSettlementTerminal = brokerSettlementFailure
        ? snapshot?.events.find((event) => (
            event.type === 'error'
            && event.content === PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE
          ))
        : undefined;
      const replayEvents = brokerSettlementTerminal
        && !baseReplayEvents.some((event) => event.seq === brokerSettlementTerminal.seq)
        && brokerSettlementTerminal.seq === (baseReplayEvents.at(-1)?.seq ?? afterLine) + 1
        ? [...baseReplayEvents, brokerSettlementTerminal]
        : baseReplayEvents;
      const activeToolCall = replayEvents
        .filter((event) => event.type === 'tool_start' || event.type === 'tool_update')
        .map((event) => event.toolName)
        .filter((toolName): toolName is string => typeof toolName === 'string' && toolName.length > 0)
        .at(-1) || null;
      const latestAssistant = snapshot?.text || !selectedTurn
        ? null
        : await prisma.projectChatMessage.findFirst({
            where: {
              userId: actorUserId,
              projectId: executionContext.projectId,
              provider,
              role: 'assistant',
              turnId: selectedTurn.id,
            },
            select: { content: true },
          });
      const terminal = brokerSettlementFailure || (selectedTurn
        ? ['COMPLETED', 'ERROR', 'ABORTED', 'EXPIRED'].includes(selectedTurn.status)
        : false);
      const replayLineCount = resolveProjectChatReplayLineCount({
        durableLastEventSeq: selectedTurn?.lastEventSeq,
        snapshotLastSeq: snapshot?.lastSeq,
        replayEvents,
      });
      const replayActive = selectedTurnActive && !brokerSettlementFailure;
      res.json({
        messages: [],
        events: replayEvents,
        lineCount: replayLineCount,
        active: replayActive,
        sessionActive: replayActive,
        complete: terminal || snapshot?.complete || false,
        isProcessing: replayActive,
        activeToolCall,
        recentTools: [],
        lastActivity: snapshot ? new Date(snapshot.updatedAt).toISOString() : null,
        idleMs: snapshot ? Math.max(0, Date.now() - snapshot.updatedAt) : null,
        text: snapshot?.text || latestAssistant?.content || '',
        status: brokerSettlementFailure
          ? 'error'
          : selectedTurn?.status.toLowerCase() || snapshot?.status || 'idle',
        error: brokerSettlementFailure
          ? PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE
          : selectedTurn?.errorMessage || snapshot?.error || null,
        runId: selectedTurn?.id || null,
        sessionKey: snapshot?.sessionId || bindingRead.providerSessionKey,
        provider,
        runtime: bindingRead.binding?.runtime || null,
        stateVersion: coordination.state.version,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    throw new UnsupportedProjectChatProviderError(
      provider,
      'No qualified durable Project Chat poll transport is available.',
    );
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[Agent Poll] Error:', error.message);
    res.status(503).json({ messages: [], lineCount: 0, sessionActive: false, complete: false, error: 'Project replay is temporarily unavailable.' });
  }
});

// POST /api/projects/:name/assistant/abort - Stop a provider-owned Project Sandbox run
router.post('/:name/assistant/abort', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.body?.provider,
      { requireQualification: false, readOnly: true },
    );
    const coordination = await requireSelectedProjectChatState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      provider,
      expectedVersion: req.body?.stateVersion,
    });
    if (!getProjectChatProviderCapability(provider).supportsAbort) {
      res.status(409).json({ error: 'This provider does not have a qualified Project Sandbox abort path.' });
      return;
    }
    const activeUserTurn = visibleProjectChatActiveTurn(coordination.activeTurn);
    const runtime = activeUserTurn?.runtime
      || getProjectChatProviderRuntimeDescriptor(provider).runtime;
    if (!activeUserTurn) {
      res.json({
        aborted: false,
        provider,
        runtime,
        stateVersion: coordination.state!.version,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    const bindingRead = await readExistingProjectChatBinding({
      actorUserId,
      provider,
      executionContext,
      requireActive: true,
      requireProviderSession: true,
    });
    const boundSessions = new Set(
      [bindingRead.binding?.sessionKey, bindingRead.binding?.externalSessionId]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    if (
      !bindingRead.binding
      || bindingRead.binding.runtime !== activeUserTurn.runtime
      || !activeUserTurn.providerSessionId
      || !boundSessions.has(activeUserTurn.providerSessionId)
    ) {
      throw new ProjectChatBindingReadError('The active Project turn does not match its provider binding.');
    }
    // Capture the exact process-local run before changing durable state. A
    // stale broker entry for another turn is not provider-stop evidence and
    // must never be cleared as a side effect of this abort.
    const rawSnapshot = getProjectNativeRunSnapshot({
      userId: actorUserId,
      projectId: executionContext.projectId,
      provider,
    });
    const exactSnapshot = matchingProjectNativeSnapshot(activeUserTurn, rawSnapshot);
    if (rawSnapshot?.active && !exactSnapshot) {
      throw new ProjectChatLeaseError(
        'STATE_CORRUPT',
        'The process-local Project run does not match the durable active turn; cancellation remains quarantined',
        409,
      );
    }
    await requestProjectChatTurnAbort({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      turnId: activeUserTurn.id,
      expectedProvider: toPersistedProjectChatProvider(provider),
    });
    await requireConfirmedProjectChatAbortForReset({
      hasExactBrokerRun: Boolean(exactSnapshot?.runId),
      abortBroker: () => exactSnapshot?.active
        ? abortProjectNativeRun({
            userId: actorUserId,
            projectId: executionContext.projectId,
            provider,
          })
        : Promise.resolve(false),
      waitForBrokerSettlement: () => exactSnapshot?.runId
        ? waitForProjectNativeRunSettlement({
            userId: actorUserId,
            projectId: executionContext.projectId,
            provider,
            runId: exactSnapshot.runId,
          })
        : Promise.resolve(false),
      abortProvider: async () => (
        exactSnapshot?.complete && !exactSnapshot.active
          ? true
          : await getProjectChatProviderAdapter(provider).abortActiveRun?.(
              activeUserTurn.providerSessionId!,
              activeUserTurn.id,
            ) === true
      ),
      isTurnStillActive: async () => Boolean((await readProjectChatCoordinationState({
        actorUserId,
        projectIdentityId: executionContext.projectId,
        recoverStale: false,
      })).activeTurn),
    });
    const confirmedTurn = await confirmProjectChatTurnAbort({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      turnId: activeUserTurn.id,
      expectedProvider: toPersistedProjectChatProvider(provider),
      providerSessionId: activeUserTurn.providerSessionId,
    });
    if (exactSnapshot) {
      clearProjectNativeRun({ userId: actorUserId, projectId: executionContext.projectId, provider });
    }
    const confirmedState = await readProjectChatCoordinationState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      recoverStale: false,
    });
    res.json({
      aborted: confirmedTurn.status === 'ABORTED',
      provider,
      runtime,
      turnId: confirmedTurn.id,
      stateVersion: confirmedState.state?.version ?? coordination.state!.version,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    console.error('[Project Chat Abort] Failed:', error?.message || error);
    res.status(500).json({ error: 'Failed to abort project turn' });
  }
});

const PROJECT_ACTIVE_INPUT_MAX_TEXT = 4_096;
const PROJECT_ACTIVE_INPUT_MAX_REQUEST_ID = 128;

function projectActiveInputField(
  value: unknown,
  label: 'request ID' | 'turn ID',
  maxLength: number,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength || /[\u0000-\u001F\u007F]/.test(text)) {
    throw new ProjectChatLeaseError('INVALID_INPUT', `A valid ${label} is required`, 400);
  }
  return text;
}

function projectActiveInputText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (
    !text
    || text.length > PROJECT_ACTIVE_INPUT_MAX_TEXT
    || /[\u0000\u000B\u000C\u000E-\u001F\u007F]/.test(text)
  ) {
    throw new ProjectChatLeaseError(
      'INVALID_INPUT',
      `An answer of at most ${PROJECT_ACTIVE_INPUT_MAX_TEXT} characters is required`,
      400,
    );
  }
  return text;
}

function projectActiveInputMessageMatches(
  message: {
    role: string;
    content: string;
    provider: string;
    runtime: string;
    sessionKey: string;
    providerSessionId: string | null;
    turnId: string | null;
  },
  expected: { content: string; runtime: string; sessionKey: string },
): boolean {
  return message.role === 'user'
    && message.content === expected.content
    && message.provider === 'OPENCLAW'
    && message.runtime === expected.runtime
    && message.sessionKey === expected.sessionKey
    && message.providerSessionId === expected.sessionKey
    && message.turnId === null;
}

// Deliberately steer the exact same live Project turn. Native Codex
// request_user_input prompts are answered through the owner-scoped broker
// routes instead. This never calls /assistant/send: that path rejects an
// active turn and can race into a second turn after settlement.
router.post('/:name/assistant/answer-input', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const requestId = projectActiveInputField(
      req.body?.requestId,
      'request ID',
      PROJECT_ACTIVE_INPUT_MAX_REQUEST_ID,
    );
    const requestedTurnId = projectActiveInputField(req.body?.turnId, 'turn ID', 512);
    const message = projectActiveInputText(req.body?.message);
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.body?.provider,
      { requireQualification: false, readOnly: true },
    );
    if (provider !== 'OPENCLAW') {
      throw new ProjectChatLeaseError(
        'PROVIDER_MISMATCH',
        'Only the active OpenClaw Project turn accepts live user input',
      );
    }

    const durableMessageId = `active-input:${requestedTurnId}:${requestId}`;
    const replayMessage = await prisma.projectChatMessage.findFirst({
      where: {
        userId: actorUserId,
        projectId: executionContext.projectId,
        messageId: durableMessageId,
      },
      select: {
        id: true,
        role: true,
        content: true,
        provider: true,
        runtime: true,
        sessionKey: true,
        providerSessionId: true,
        turnId: true,
      },
    });
    if (replayMessage) {
      const replayTurn = await prisma.projectChatTurn.findFirst({
        where: {
          id: requestedTurnId,
          actorUserId,
          projectIdentityId: executionContext.projectId,
          provider: 'OPENCLAW',
        },
        select: { id: true, runtime: true, providerSessionId: true },
      });
      if (
        !replayTurn?.providerSessionId
        || !projectActiveInputMessageMatches(replayMessage, {
          content: message,
          runtime: replayTurn.runtime,
          sessionKey: replayTurn.providerSessionId,
        })
      ) {
        throw new ProjectChatLeaseError(
          'REQUEST_REPLAY',
          'Project live-input identity was already used for different content',
        );
      }
      const replayState = await readProjectChatCoordinationState({
        actorUserId,
        projectIdentityId: executionContext.projectId,
        recoverStale: false,
      });
      res.json({
        accepted: true,
        idempotentReplay: true,
        requestId,
        messageId: replayMessage.id,
        turnId: replayTurn.id,
        sessionKey: replayTurn.providerSessionId,
        provider,
        stateVersion: replayState.state?.version ?? null,
      });
      return;
    }

    const coordination = await requireSelectedProjectChatState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      provider,
      expectedVersion: req.body?.stateVersion,
    });
    const activeTurn = visibleProjectChatActiveTurn(coordination.activeTurn);
    if (
      !activeTurn
      || activeTurn.id !== requestedTurnId
      || activeTurn.status !== 'RUNNING'
      || activeTurn.provider !== 'OPENCLAW'
      || !activeTurn.providerSessionId
    ) {
      throw new ProjectChatLeaseError(
        'TURN_NOT_FOUND',
        'That OpenClaw Project turn is no longer accepting input',
        409,
      );
    }

    const snapshot = matchingProjectNativeSnapshot(activeTurn, getProjectNativeRunSnapshot({
      userId: actorUserId,
      projectId: executionContext.projectId,
      provider,
    }));
    if (!snapshot?.active || snapshot.complete || snapshot.sessionId !== activeTurn.providerSessionId) {
      throw new ProjectChatLeaseError(
        'TURN_NOT_FOUND',
        'The exact OpenClaw Project run is no longer accepting input',
        409,
      );
    }

    const authority = await resolveAskUserQuestionRunOwner({
      sessionKey: activeTurn.providerSessionId,
      runId: `portal-${activeTurn.id}`,
      toolCallId: requestId,
    });
    if (
      authority.ownerUserId !== actorUserId
      || authority.surface !== 'project-chat'
      || authority.authorityId !== activeTurn.id
      || authority.projectIdentityId !== executionContext.projectId
    ) {
      res.status(404).json({ error: 'Active Project input request not found' });
      return;
    }

    const expectedMessage = {
      content: message,
      runtime: activeTurn.runtime,
      sessionKey: activeTurn.providerSessionId,
    };
    const existing = await prisma.projectChatMessage.findFirst({
      where: {
        userId: actorUserId,
        projectId: executionContext.projectId,
        messageId: durableMessageId,
      },
      select: {
        id: true,
        role: true,
        content: true,
        provider: true,
        runtime: true,
        sessionKey: true,
        providerSessionId: true,
        turnId: true,
      },
    });
    if (existing) {
      if (!projectActiveInputMessageMatches(existing, expectedMessage)) {
        throw new ProjectChatLeaseError(
          'REQUEST_REPLAY',
          'Project live-input identity was already used for different content',
        );
      }
      res.json({
        accepted: true,
        idempotentReplay: true,
        requestId,
        messageId: existing.id,
        turnId: activeTurn.id,
        sessionKey: activeTurn.providerSessionId,
        provider,
        stateVersion: coordination.state!.version,
      });
      return;
    }

    const accepted = await steerActiveRun(
      activeTurn.providerSessionId,
      `portal-${activeTurn.id}`,
      requestId,
      message,
    );
    if (accepted?.accepted !== true) {
      throw new ProjectChatLeaseError(
        'TURN_NOT_FOUND',
        'The OpenClaw Project run stopped accepting input before delivery',
        409,
      );
    }

    const persisted = await prisma.projectChatMessage.upsert({
      where: {
        userId_projectId_messageId: {
          userId: actorUserId,
          projectId: executionContext.projectId,
          messageId: durableMessageId,
        },
      },
      update: {},
      create: {
        projectId: executionContext.projectId,
        userId: actorUserId,
        sessionKey: activeTurn.providerSessionId,
        role: 'user',
        content: message,
        messageId: durableMessageId,
        provider: 'OPENCLAW',
        runtime: activeTurn.runtime,
        model: activeTurn.model,
        providerSessionId: activeTurn.providerSessionId,
      },
      select: {
        id: true,
        role: true,
        content: true,
        provider: true,
        runtime: true,
        sessionKey: true,
        providerSessionId: true,
        turnId: true,
      },
    });
    if (!projectActiveInputMessageMatches(persisted, expectedMessage)) {
      throw new ProjectChatLeaseError(
        'REQUEST_REPLAY',
        'Project live-input identity was already used for different content',
      );
    }
    const current = await readProjectChatCoordinationState({
      actorUserId,
      projectIdentityId: executionContext.projectId,
      recoverStale: false,
    });
    res.json({
      accepted: true,
      idempotentReplay: accepted.idempotentReplay === true,
      requestId,
      messageId: persisted.id,
      turnId: activeTurn.id,
      sessionKey: activeTurn.providerSessionId,
      provider,
      stateVersion: current.state?.version ?? coordination.state!.version,
    });
  } catch (error: any) {
    if (sendProjectChatProviderError(res, error)) return;
    if (sendProjectChatCoordinationError(res, error)) return;
    const statusCode = Number(error?.statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
      res.status(statusCode === 403 ? 404 : statusCode).json({
        error: statusCode === 403
          ? 'Active Project input request not found'
          : String(error?.message || 'Project input was rejected'),
        code: String(error?.code || 'PROJECT_ACTIVE_INPUT_REJECTED'),
      });
      return;
    }
    console.error('[Project Chat Active Input] Failed:', error?.message || error);
    res.status(503).json({
      error: 'Project input could not be delivered to the active OpenClaw turn',
      code: 'PROJECT_ACTIVE_INPUT_UNAVAILABLE',
    });
  }
});

// POST /api/projects/:name/assistant/send - Fire-and-forget message send (non-streaming)
// Returns immediately after dispatching to gateway. Frontend polls for response.
router.post('/:name/assistant/send', authenticateToken, async (req: Request, res: Response) => {
  let runtimeAdmission: Awaited<ReturnType<typeof acquireProjectChatRuntimeAdmission>> | null = null;
  let runtimeAdmissionPromoted = false;
  let runtimeAdmissionFinalizedAfterFailure = false;
  let stopRuntimeAdmissionHeartbeat: (() => void) | null = null;
  try {
    const { name } = req.params;
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, name);
    const { message, model } = req.body;
    const messageId = typeof req.body?.messageId === 'string' && req.body.messageId.trim()
      ? req.body.messageId.trim()
      : null;
    if (!message) {
      res.status(400).json({
        error: 'message required',
        admissionOutcome: 'not_admitted',
        admissionStatus: 'never_admitted',
        recoveryRequired: false,
      });
      return;
    }
    if (!messageId) {
      res.status(400).json({
        error: 'A stable Project Chat message ID is required for exactly-once delivery.',
        code: 'PROJECT_CHAT_MESSAGE_ID_REQUIRED',
        admissionOutcome: 'not_admitted',
        admissionStatus: 'never_admitted',
        recoveryRequired: false,
      });
      return;
    }

    if (!fs.existsSync(projectDir)) {
      res.status(404).json({
        error: 'Project not found',
        admissionOutcome: 'not_admitted',
        admissionStatus: 'never_admitted',
        recoveryRequired: false,
      });
      return;
    }
    const { provider, executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      name,
      projectDir,
      req.body?.provider,
    );
    const replay = await findProjectChatRequestReplay({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      provider,
      messageId,
      message,
    });
    if (replay) {
      const complete = ['COMPLETED', 'ERROR', 'ABORTED', 'EXPIRED'].includes(replay.turn.status);
      const dispatchStage = projectChatTurnDispatchStage(replay.turn);
      if (
        dispatchStage === PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED
        || (!complete && dispatchStage === null)
      ) {
        res.status(409).json({
          error: 'Provider delivery could not be confirmed after an interrupted dispatch. Clear Project Chat before retrying this message.',
          code: dispatchStage === PROJECT_CHAT_DISPATCH_STAGE_UNCONFIRMED
            ? 'PROJECT_CHAT_DISPATCH_UNCONFIRMED'
            : 'PROJECT_CHAT_DISPATCH_UNKNOWN',
          provider,
          turnId: replay.turn.id,
          stateVersion: replay.state.version,
          recoveryRequired: true,
          admissionOutcome: 'unknown',
          admissionStatus: 'unknown',
        });
        return;
      }
      res.json({
        sent: true,
        idempotentReplay: true,
        sessionKey: replay.turn.providerSessionId,
        runId: replay.turn.id,
        turnId: replay.turn.id,
        status: replay.turn.status.toLowerCase(),
        complete,
        model: projectChatClientModel(provider, replay.turn.model),
        modelValidated: true,
        ...(provider === 'OPENCLAW' ? { modelVerified: true } : { modelConfigured: true }),
        provider,
        runtime: replay.turn.runtime,
        stateVersion: replay.state.version,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }
    const coordination = await requireSelectedProjectChatState({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      provider,
      expectedVersion: req.body?.stateVersion,
    });
    if (isNativeProjectChatRouteProvider(provider)) {
      const currentRun = getProjectNativeRunSnapshot({
        userId: req.user!.userId,
        projectId: executionContext.projectId,
        provider,
      });
      if (currentRun?.active) {
        res.status(409).json({
          error: `${projectChatProviderDisplayName(provider)} already has an active turn for this project.`,
          code: 'PROJECT_PROVIDER_RUN_ACTIVE',
          provider,
          runId: currentRun.runId,
          admissionOutcome: 'not_admitted',
          admissionStatus: 'never_admitted',
          recoveryRequired: false,
        });
        return;
      }
    }
    runtimeAdmission = await acquireProjectChatRuntimeAdmission({
      actorUserId: req.user!.userId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      projectIdentityId: executionContext.projectId,
      provider: toPersistedProjectChatProvider(provider),
      runtime: getProjectChatProviderRuntimeDescriptor(provider).runtime,
      operation: projectChatRuntimeOperationId('send', provider, messageId),
      leaseOwner: PROJECT_CHAT_LEASE_OWNER,
      expectedVersion: coordination.state!.version,
      recoveryExecutionContext: executionContext,
      leaseDurationMs: PROJECT_CHAT_LEASE_DURATION_MS,
    });
    stopRuntimeAdmissionHeartbeat = startProjectChatLeaseHeartbeat({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      turnId: runtimeAdmission.turn.id,
      leaseToken: runtimeAdmission.leaseToken,
      onLeaseLost: (error) => {
        console.error('[Project Chat] Runtime admission lease was lost before provider dispatch:', error);
      },
    });
    // Legacy terminal projection repair is a mutation and therefore runs only
    // while this request owns the exact project-wide runtime admission. Both
    // OpenClaw and native sends pass through this shared boundary.
    await repairTerminalProjectChatPresentations({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      limit: 100,
    });
    // Memory is repository-controlled input. Attest it before either provider
    // can be admitted, then include a newly created file in ownership repair.
    ensureProjectMemory(projectDir, name);
    await ensureProjectChatWorkspaceOwnership(executionContext, projectDir);

    if (isNativeProjectChatRouteProvider(provider)) {
      const selectedModel = normalizePortalModelId(model || '');
      let resolved = await ensureNativeProjectChatBinding({
        actorUserId: req.user!.userId,
        workspaceOwnerId: ownerId,
        projectName: name,
        projectDir,
        provider,
        executionContext,
        model: selectedModel || null,
      });
      const reconciledBinding = await reconcileLegacyProjectChatTerminalHandoff({
        actorUserId: req.user!.userId,
        projectIdentityId: executionContext.projectId,
        provider: toPersistedProjectChatProvider(provider),
        admission: runtimeAdmission,
      });
      const handoffSuffix = await readProjectChatProviderHandoffSuffix({
        actorUserId: req.user!.userId,
        projectIdentityId: executionContext.projectId,
        handoffCursor: reconciledBinding.handoffCursor,
      });
      resolved = {
        ...resolved,
        binding: reconciledBinding,
        needsBootstrap: projectChatBindingNeedsHandoff(
          reconciledBinding,
          handoffSuffix.transcriptCursor,
        ),
        handoffCursor: reconciledBinding.handoffCursor,
        handoffVersion: reconciledBinding.handoffVersion,
      };
      const priorMessages = resolved.needsBootstrap ? handoffSuffix.messages : [];
      const handoff = buildProjectChatProviderHandoff(priorMessages);
      const fullMessage = resolved.needsBootstrap
        ? `[PORTAL PROJECT CONTEXT]
You are working only inside the Portal project "${name}".
Your visible workspace root is ${NATIVE_CLI_PROJECT_CONTAINER_ROOT}.
The Portal enforces the exact ${projectChatProviderDisplayName(provider)} Project Sandbox runtime and policy.
Do not request broader filesystem access, additional directories, or host-operator authority.

[END CONTEXT]

${handoff ? `${handoff}\n\n` : ''}[CURRENT USER REQUEST]
${message}`
        : message;
      const now = new Date();
      await prisma.projectChatSession.upsert({
        where: { sessionKey: resolved.identity.sessionId },
        update: {
          lastActivity: now,
          model: resolved.binding.model,
          status: 'active',
          activeProvider: provider,
          runtime: resolved.binding.runtime,
        },
        create: {
          userId: req.user!.userId,
          projectId: executionContext.projectId,
          sessionKey: resolved.identity.sessionId,
          model: resolved.binding.model,
          status: 'active',
          activeProvider: provider,
          runtime: resolved.binding.runtime,
        },
      });
      stopRuntimeAdmissionHeartbeat();
      stopRuntimeAdmissionHeartbeat = null;
      const turnLease = await promoteProjectChatRuntimeAdmissionToTurn({
        actorUserId: req.user!.userId,
        projectIdentityId: executionContext.projectId,
        turnId: runtimeAdmission.turn.id,
        leaseToken: runtimeAdmission.leaseToken,
        runtime: resolved.binding.runtime,
        providerSessionId: resolved.sessionKey,
        model: resolved.binding.model,
        userMessage: {
          sessionKey: resolved.identity.sessionId,
          content: message,
          messageId,
        },
      });
      runtimeAdmissionPromoted = true;

      let currentProviderSessionId = resolved.sessionKey;
      let durableEventSeq = turnLease.turn.lastEventSeq;
      let durableEventFailure: unknown = null;
      const durableEventPersistenceGate = createProjectChatDispatchPersistenceGate();
      // The native broker emits its initial status synchronously. Hold the
      // corresponding row write until the DISPATCH_ACCEPTED CAS has finished,
      // otherwise both Serializable transactions contend on this turn.
      let durableEventChain: Promise<void> = durableEventPersistenceGate.waitUntilAccepted;
      const presentationEvents: ProjectNativeRunEvent[] = [];
      const persistDurableEvent = (event: ProjectNativeRunEvent) => {
        presentationEvents.push(event);
        if (presentationEvents.length > PROJECT_CHAT_PRESENTATION_EVENT_LIMIT) {
          presentationEvents.splice(0, presentationEvents.length - PROJECT_CHAT_PRESENTATION_EVENT_LIMIT);
        }
        durableEventChain = durableEventChain.then(async () => {
          const payload = JSON.parse(JSON.stringify(event));
          const persisted = await appendProjectChatTurnEvent({
            actorUserId: req.user!.userId,
            projectIdentityId: executionContext.projectId,
            turnId: turnLease.turn.id,
            leaseToken: turnLease.leaseToken,
            expectedSeq: durableEventSeq,
            eventType: String(payload.type || 'status'),
            payload,
          });
          durableEventSeq = persisted.seq;
        }).catch((error) => {
          durableEventFailure = error;
          console.error('[Project Chat] Durable replay persistence failed:', error);
        });
      };
      const stopLeaseHeartbeat = startProjectChatLeaseHeartbeat({
        actorUserId: req.user!.userId,
        projectIdentityId: executionContext.projectId,
        turnId: turnLease.turn.id,
        leaseToken: turnLease.leaseToken,
        providerSessionId: () => currentProviderSessionId,
        onLeaseLost: async (error) => {
          console.error('[Project Chat] Durable turn lease was lost:', error);
          await abortProjectNativeRun({
            userId: req.user!.userId,
            projectId: executionContext.projectId,
            provider,
          });
        },
      });

      // Warm sends never traverse the repository. Portal mutation boundaries
      // and provider preparation own the exact runtime-ownership contract.
      let run;
      let dispatchAcceptanceFailed = false;
      let dispatchQuiescedAfterAcceptanceFailure = false;
      let providerRunStarted = false;
      let releaseWorkspaceMutationLease: (() => void) | null =
        acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
      const releaseWorkspaceMutation = () => {
        releaseWorkspaceMutationLease?.();
        releaseWorkspaceMutationLease = null;
      };
      try {
        run = startProjectNativeRun({
          userId: req.user!.userId,
          projectId: executionContext.projectId,
          provider,
          runId: turnLease.turn.id,
          runtime: resolved.binding.runtime,
          sessionId: resolved.sessionKey,
          message: fullMessage,
          model: resolved.binding.model,
          sender: {
            label: req.user!.email,
            userId: req.user!.userId,
            role: req.user!.role,
            requestId: turnLease.turn.id,
          },
          onSessionResolved: async (sessionId) => {
            if (sessionId !== resolved.sessionKey) {
              throw new ProjectChatBindingReadError(
                `${projectChatProviderDisplayName(provider)} attempted to replace the Portal-native Project session key.`,
              );
            }
            currentProviderSessionId = sessionId;
            await renewProjectChatTurnLease({
              actorUserId: req.user!.userId,
              projectIdentityId: executionContext.projectId,
              turnId: turnLease.turn.id,
              leaseToken: turnLease.leaseToken,
              leaseDurationMs: PROJECT_CHAT_LEASE_DURATION_MS,
              providerSessionId: sessionId,
            });
          },
          onEvent: persistDurableEvent,
          onComplete: async () => {
            // Assistant projection is committed exactly once by terminal
            // settlement after it re-attests the durable turn generation.
            // Writing it here allowed a delayed callback to resurrect a row
            // after destructive reset had already returned.
            await prisma.projectChatSession.update({
              where: { sessionKey: resolved.identity.sessionId },
              data: { status: 'active', lastActivity: new Date() },
            });
            await checkpointProjectAfterProviderTurn({
              projectDir,
              actorUserId: req.user!.userId,
              projectId: executionContext.projectId,
              workspaceOwnerId: ownerId,
              projectName: name,
              sessionKey: resolved.identity.sessionId,
              turnId: turnLease.turn.id,
              provider,
              runtime: resolved.binding.runtime,
              model: resolved.binding.model,
            });
          },
          onError: async () => {
            await prisma.projectChatSession.update({
              where: { sessionKey: resolved.identity.sessionId },
              data: { status: 'error', lastActivity: new Date() },
            });
          },
          onSettled: async ({ status, sessionId, error, fullText }) => {
            try {
              stopLeaseHeartbeat();
              await durableEventChain;
              await settleProjectChatTurnWithPresentation({
                turn: turnLease.turn,
                leaseToken: turnLease.leaseToken,
                providerStatus: status,
                providerDispatchObserved: true,
                providerSessionId: sessionId,
                providerError: error,
                durableEventFailure,
                durableEventCount: durableEventSeq,
                sessionKey: resolved.identity.sessionId,
                preferredContent: status === 'completed' ? fullText : null,
                handoff: {
                  expectedCursor: resolved.handoffCursor,
                  expectedHandoffVersion: resolved.handoffVersion,
                },
              });
            } finally {
              releaseWorkspaceMutation();
            }
          },
        });
        providerRunStarted = true;
        try {
          await durableEventPersistenceGate.releaseAfter(markProjectChatTurnProviderDispatchAccepted({
            actorUserId: req.user!.userId,
            projectIdentityId: executionContext.projectId,
            turnId: turnLease.turn.id,
            leaseToken: turnLease.leaseToken,
          }));
        } catch (acceptanceError) {
          dispatchAcceptanceFailed = true;
          try {
            await abortProjectNativeRun({
              userId: req.user!.userId,
              projectId: executionContext.projectId,
              provider,
            });
          } catch {
            // Exact semantic settlement below remains the authority.
          }
          dispatchQuiescedAfterAcceptanceFailure = await waitForProjectNativeRunSettlement({
            userId: req.user!.userId,
            projectId: executionContext.projectId,
            provider,
            runId: String(run.runId || turnLease.turn.id),
          });
          const recoveryError = new ProjectChatLeaseError(
            'TURN_ACTIVE',
            dispatchQuiescedAfterAcceptanceFailure
              ? 'Provider delivery state could not be recorded. The turn was stopped; clear Project Chat before retrying.'
              : 'Provider delivery state could not be recorded and its callback is still active. Abort or clear Project Chat before retrying.',
            409,
          );
          (recoveryError as Error & { cause?: unknown }).cause = acceptanceError;
          throw recoveryError;
        }
      } catch (error) {
        durableEventPersistenceGate.release();
        if (!providerRunStarted) releaseWorkspaceMutation();
        stopLeaseHeartbeat();
        await durableEventChain;
        // Never race an independent terminal write against a provider whose
        // exact broker callback boundary is still live. The durable
        // DISPATCH_UNCONFIRMED row remains quarantined for abort/reset.
        if (dispatchAcceptanceFailed && !dispatchQuiescedAfterAcceptanceFailure) throw error;
        await settleProjectChatTurnWithPresentation({
          turn: turnLease.turn,
          leaseToken: turnLease.leaseToken,
          providerSessionId: currentProviderSessionId,
          providerStatus: 'error',
          providerDispatchObserved: dispatchAcceptanceFailed,
          providerError: error instanceof Error ? error.message : 'Project provider failed to start',
          durableEventFailure,
          durableEventCount: durableEventSeq,
          sessionKey: resolved.identity.sessionId,
          handoff: {
            expectedCursor: resolved.handoffCursor,
            expectedHandoffVersion: resolved.handoffVersion,
          },
        });
        throw error;
      }

      writeProjectSessionProjectionBestEffort(projectDir, {
        initialized: true,
        model: resolved.configuredModel,
        modelConfigured: true,
        lastActivity: now.toISOString(),
        stableSlug: resolved.identity.stableSlug,
      });

      res.json({
        sent: true,
        sessionKey: resolved.sessionKey,
        runId: run.runId,
        model: resolved.configuredModel,
        modelValidated: true,
        modelConfigured: true,
        modelWarning: null,
        provider,
        runtime: resolved.binding.runtime,
        stateVersion: turnLease.state.version,
        turnId: turnLease.turn.id,
        executionContext: serializeProjectSandboxContext(executionContext),
      });
      return;
    }

    if (provider !== 'OPENCLAW') {
      throw new UnsupportedProjectChatProviderError(provider, 'No qualified Project Sandbox transport is available.');
    }

    const requestedModel = normalizePortalModelId(model || '');
    const existingOpenClawBinding = await prisma.projectChatProviderBinding.findUnique({
      where: {
        userId_projectId_provider: {
          userId: req.user!.userId,
          projectId: executionContext.projectId,
          provider: 'OPENCLAW',
        },
      },
    });

    // Provider preparation owns legacy-tree normalization. Warm OpenClaw
    // sends do not recursively traverse or chown the Project workspace.
    const catalogScope = await ensureOpenClawProjectAgentCatalogScope(executionContext);
    const modelResolution = await resolveAllowedOpenClawProjectModel(
      catalogScope.agentId,
      [
        requestedModel,
        existingOpenClawBinding?.model || '',
        getDefaultModel() || '',
      ],
      requestedModel,
    );
    let selectedModel = modelResolution.model;
    let resolved = await ensureOpenClawProjectRuntime({
      actorUserId: req.user!.userId,
      workspaceOwnerId: ownerId,
      projectName: name,
      projectDir,
      executionContext,
      model: existingOpenClawBinding?.model || null,
    });
    const sessionKey = resolved.identity.sessionKey;
    const modelVerification = await verifyAndPersistOpenClawProjectModel({
      actorUserId: req.user!.userId,
      projectId: executionContext.projectId,
      portalSessionKey: resolved.identity.sessionId,
      providerSessionKey: sessionKey,
      desiredModel: selectedModel,
    });
    selectedModel = modelVerification.verified.model;
    const reconciledBinding = await reconcileLegacyProjectChatTerminalHandoff({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      provider: 'OPENCLAW',
      admission: runtimeAdmission,
    });
    const handoffSuffix = await readProjectChatProviderHandoffSuffix({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      handoffCursor: reconciledBinding.handoffCursor,
    });
    resolved = {
      ...resolved,
      binding: reconciledBinding,
      needsBootstrap: projectChatBindingNeedsHandoff(
        reconciledBinding,
        handoffSuffix.transcriptCursor,
      ),
      handoffCursor: reconciledBinding.handoffCursor,
      handoffVersion: reconciledBinding.handoffVersion,
    };

    const priorMessages = resolved.needsBootstrap ? handoffSuffix.messages : [];
    const handoff = buildProjectChatProviderHandoff(priorMessages);
    const assistantName = await getAssistantName();
    const fullMessage = resolved.needsBootstrap
      ? `[PORTAL PROJECT CONTEXT]
You are ${assistantName}, an AI coding assistant working only on the Portal project "${name}".
Project Type: ${detectProjectType(projectDir)}
Project Directory: /workspace/project

The Portal enforces the project filesystem and public-only network boundary. You cannot access sibling projects, other users, host files, private services, or server administration.
Use exec inside /workspace/project for file operations and commands. Public HTTPS, Git, package registries, and asset downloads are available through the Portal egress proxy; private, local, metadata, and lateral destinations are denied.
Read and update .agent-memory.md when durable project context changes. Never request broader mounts, host access, or a bypass of the Project Sandbox.

[END CONTEXT]

${handoff ? `${handoff}\n\n` : ''}[CURRENT USER REQUEST]
${message}`
      : message;

    const now = new Date();
    await prisma.projectChatSession.upsert({
      where: { sessionKey: resolved.identity.sessionId },
      update: {
        lastActivity: now,
        model: selectedModel,
        status: 'active',
        activeProvider: provider,
        runtime: resolved.binding.runtime,
      },
      create: {
        userId: req.user!.userId,
        projectId: executionContext.projectId,
        sessionKey: resolved.identity.sessionId,
        model: selectedModel,
        status: 'active',
        activeProvider: provider,
        runtime: resolved.binding.runtime,
      },
    });
    stopRuntimeAdmissionHeartbeat();
    stopRuntimeAdmissionHeartbeat = null;
    const turnLease = await promoteProjectChatRuntimeAdmissionToTurn({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      turnId: runtimeAdmission.turn.id,
      leaseToken: runtimeAdmission.leaseToken,
      runtime: resolved.binding.runtime,
      providerSessionId: sessionKey,
      model: selectedModel,
      userMessage: {
        sessionKey: resolved.identity.sessionId,
        content: message,
        messageId,
      },
    });
    runtimeAdmissionPromoted = true;

    let durableEventSeq = turnLease.turn.lastEventSeq;
    let durableEventFailure: unknown = null;
    const durableEventPersistenceGate = createProjectChatDispatchPersistenceGate();
    // The native broker emits its initial status synchronously. Hold the
    // corresponding row write until the DISPATCH_ACCEPTED CAS has finished,
    // otherwise both Serializable transactions contend on this turn.
    let durableEventChain: Promise<void> = durableEventPersistenceGate.waitUntilAccepted;
    const presentationEvents: ProjectNativeRunEvent[] = [];
    const persistDurableEvent = (event: ProjectNativeRunEvent) => {
      presentationEvents.push(event);
      if (presentationEvents.length > PROJECT_CHAT_PRESENTATION_EVENT_LIMIT) {
        presentationEvents.splice(0, presentationEvents.length - PROJECT_CHAT_PRESENTATION_EVENT_LIMIT);
      }
      durableEventChain = durableEventChain.then(async () => {
        const payload = JSON.parse(JSON.stringify(event));
        const persisted = await appendProjectChatTurnEvent({
          actorUserId: req.user!.userId,
          projectIdentityId: executionContext.projectId,
          turnId: turnLease.turn.id,
          leaseToken: turnLease.leaseToken,
          expectedSeq: durableEventSeq,
          eventType: String(payload.type || 'status'),
          payload,
        });
        durableEventSeq = persisted.seq;
      }).catch((error) => {
        durableEventFailure = error;
        console.error('[Project Chat] OpenClaw replay persistence failed:', error);
      });
    };
    const stopLeaseHeartbeat = startProjectChatLeaseHeartbeat({
      actorUserId: req.user!.userId,
      projectIdentityId: executionContext.projectId,
      turnId: turnLease.turn.id,
      leaseToken: turnLease.leaseToken,
      providerSessionId: () => sessionKey,
      onLeaseLost: async (error) => {
        console.error('[Project Chat] OpenClaw durable turn lease was lost:', error);
        await abortProjectNativeRun({
          userId: req.user!.userId,
          projectId: executionContext.projectId,
          provider: 'OPENCLAW',
        });
      },
    });

    let run;
    let dispatchAcceptanceFailed = false;
    let dispatchQuiescedAfterAcceptanceFailure = false;
    let providerRunStarted = false;
    let releaseWorkspaceMutationLease: (() => void) | null =
      acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
    const releaseWorkspaceMutation = () => {
      releaseWorkspaceMutationLease?.();
      releaseWorkspaceMutationLease = null;
    };
    try {
      run = startProjectNativeRun({
        userId: req.user!.userId,
        projectId: executionContext.projectId,
        provider: 'OPENCLAW',
        runId: turnLease.turn.id,
        runtime: resolved.binding.runtime,
        sessionId: sessionKey,
        message: fullMessage,
        model: selectedModel,
        sender: {
          label: req.user!.email,
          userId: req.user!.userId,
          role: req.user!.role,
          requestId: turnLease.turn.id,
        },
      onEvent: persistDurableEvent,
      onComplete: async () => {
          await prisma.projectChatSession.update({
            where: { sessionKey: resolved.identity.sessionId },
            data: { status: 'active', lastActivity: new Date() },
          });
          await checkpointProjectAfterProviderTurn({
            projectDir,
            actorUserId: req.user!.userId,
            projectId: executionContext.projectId,
            workspaceOwnerId: ownerId,
            projectName: name,
            sessionKey: resolved.identity.sessionId,
            turnId: turnLease.turn.id,
            provider,
            runtime: resolved.binding.runtime,
            model: selectedModel,
          });
        },
        onError: async () => {
          await prisma.projectChatSession.update({
            where: { sessionKey: resolved.identity.sessionId },
            data: { status: 'error', lastActivity: new Date() },
          });
        },
      onSettled: async ({ status, sessionId, error, fullText }) => {
        try {
          stopLeaseHeartbeat();
          await durableEventChain;
          await settleProjectChatTurnWithPresentation({
              turn: turnLease.turn,
              leaseToken: turnLease.leaseToken,
              providerStatus: status,
              providerDispatchObserved: true,
              providerSessionId: sessionId,
              providerError: error,
              durableEventFailure,
              durableEventCount: durableEventSeq,
              sessionKey: resolved.identity.sessionId,
              preferredContent: status === 'completed' ? fullText : null,
              handoff: {
                expectedCursor: resolved.handoffCursor,
                expectedHandoffVersion: resolved.handoffVersion,
              },
            });
        } finally {
          releaseWorkspaceMutation();
        }
        },
      });
      providerRunStarted = true;
      try {
        await durableEventPersistenceGate.releaseAfter(markProjectChatTurnProviderDispatchAccepted({
          actorUserId: req.user!.userId,
          projectIdentityId: executionContext.projectId,
          turnId: turnLease.turn.id,
          leaseToken: turnLease.leaseToken,
        }));
      } catch (acceptanceError) {
        dispatchAcceptanceFailed = true;
        try {
          await abortProjectNativeRun({
            userId: req.user!.userId,
            projectId: executionContext.projectId,
            provider: 'OPENCLAW',
          });
        } catch {
          // Exact semantic settlement below remains the authority.
        }
        dispatchQuiescedAfterAcceptanceFailure = await waitForProjectNativeRunSettlement({
          userId: req.user!.userId,
          projectId: executionContext.projectId,
          provider: 'OPENCLAW',
          runId: String(run.runId || turnLease.turn.id),
        });
        const recoveryError = new ProjectChatLeaseError(
          'TURN_ACTIVE',
          dispatchQuiescedAfterAcceptanceFailure
            ? 'Provider delivery state could not be recorded. The turn was stopped; clear Project Chat before retrying.'
            : 'Provider delivery state could not be recorded and its callback is still active. Abort or clear Project Chat before retrying.',
          409,
        );
        (recoveryError as Error & { cause?: unknown }).cause = acceptanceError;
        throw recoveryError;
      }
    } catch (error) {
      durableEventPersistenceGate.release();
      if (!providerRunStarted) releaseWorkspaceMutation();
      stopLeaseHeartbeat();
      await durableEventChain;
      if (dispatchAcceptanceFailed && !dispatchQuiescedAfterAcceptanceFailure) throw error;
      await settleProjectChatTurnWithPresentation({
        turn: turnLease.turn,
        leaseToken: turnLease.leaseToken,
        providerSessionId: sessionKey,
        providerStatus: 'error',
        providerDispatchObserved: dispatchAcceptanceFailed,
        providerError: error instanceof Error ? error.message : 'OpenClaw provider failed to start',
        durableEventFailure,
        durableEventCount: durableEventSeq,
        sessionKey: resolved.identity.sessionId,
        handoff: {
          expectedCursor: resolved.handoffCursor,
          expectedHandoffVersion: resolved.handoffVersion,
        },
      });
      throw error;
    }

    writeProjectSessionProjectionBestEffort(projectDir, {
      initialized: true,
      model: selectedModel,
      lastActivity: now.toISOString(),
      stableSlug: resolved.identity.stableSlug,
    });

    res.json({
      sent: true,
      sessionKey,
      runId: run.runId,
      model: selectedModel,
      modelValidated: true,
      modelVerified: true,
      modelWarning: modelResolution.warning || null,
      provider,
      runtime: resolved.binding.runtime,
      stateVersion: turnLease.state.version,
      turnId: turnLease.turn.id,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error: any) {
    let responseError: any = error;
    stopRuntimeAdmissionHeartbeat?.();
    stopRuntimeAdmissionHeartbeat = null;
    if (runtimeAdmission && !runtimeAdmissionPromoted) {
      try {
        await finishProjectChatRuntimeAdmission({
          actorUserId: runtimeAdmission.turn.actorUserId,
          projectIdentityId: runtimeAdmission.turn.projectIdentityId,
          turnId: runtimeAdmission.turn.id,
          leaseToken: runtimeAdmission.leaseToken,
          status: 'ERROR',
          errorCode: 'RUNTIME_ADMISSION_OPERATION_FAILED',
          errorMessage: error instanceof Error ? error.message : 'Project send preparation failed',
        });
        runtimeAdmissionFinalizedAfterFailure = true;
      } catch (finalizationError) {
        responseError = finalizationError;
      }
    }
    const admissionMetadata = !runtimeAdmission
      || (!runtimeAdmissionPromoted && runtimeAdmissionFinalizedAfterFailure)
      ? {
          admissionOutcome: 'not_admitted',
          admissionStatus: 'never_admitted',
          recoveryRequired: false,
        }
      : {
          admissionOutcome: 'unknown',
          admissionStatus: 'unknown',
          recoveryRequired: true,
        };
    if (sendProjectChatProviderError(res, responseError, admissionMetadata)) return;
    if (sendProjectChatCoordinationError(res, responseError, admissionMetadata)) return;
    console.error('[Agent Send] Error:', responseError?.message || responseError);
    res.status(500).json({ error: 'Failed to send message', ...admissionMetadata });
  }
});

// POST /api/projects/:name/assistant/read-file - Read a project file (for assistant context)
router.post('/:name/assistant/read-file', authenticateToken, projectPathSandbox, async (req: Request, res: Response) => {
  try {
    const {
      actorUserId,
      workspaceOwnerId: ownerId,
      projectDir,
    } = resolveActorProjectChatWorkspace(req, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }
    const { executionContext } = await resolveProjectChatOperationContext(
      actorUserId,
      ownerId,
      req.params.name,
      projectDir,
      req.body?.provider,
    );

    const { filePath } = req.body;
    if (!filePath) { res.status(400).json({ error: 'filePath required' }); return; }

    let resolved: string;
    try {
      resolved = resolveExistingProjectEntry(projectDir, filePath, 'file');
    } catch {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.lstatSync(resolved);
    if (stat.size > PROJECT_EDIT_MAX_BYTES) {
      res.status(413).json({ error: 'File too large (max 10MB)' });
      return;
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({
      content,
      path: filePath,
      size: stat.size,
      executionContext: serializeProjectSandboxContext(executionContext),
    });
  } catch (error) {
    if (sendProjectChatProviderError(res, error)) return;
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/projects/:name/download - Download project as ZIP
router.get('/:name/download', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  let snapshotRoot: string | undefined;
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const mode = (req.query.mode as string) || 'clean'; // full | clean | stripped
    if (!['full', 'clean', 'stripped'].includes(mode)) {
      res.status(400).json({ error: 'mode must be full, clean, or stripped' });
      return;
    }
    
    const projectDir = getProjectPath(ownerId, name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Files to always exclude
    const alwaysExclude = [
      '.assistant-*',
      '.agent-*',
      '.marcus-*',
      '.portal-project.json',
      '.portal/attachments/**',
      '.git/**',
      'node_modules/**',
      '.venv/**',
      '.deps-installed',
      '.env',
      '.env.local',
      '.env.*.local',
      '__pycache__/**',
      '*.pyc',
      '.pytest_cache/**',
      '.DS_Store',
      'Thumbs.db',
      '.cache/**',
      '.turbo/**',
    ];

    // Additional excludes for clean modes (clean & stripped - not full)
    const cleanExclude = [
      ...alwaysExclude,
      'dist/**',
      'build/**',
      '.next/**',
      '.nuxt/**',
      'coverage/**',
      '.vscode/**',
      '.idea/**',
      'Agent.md',           // Agent documentation
      'agent.md',           // Lowercase variant
      'README.md',          // Markdown readme
      'readme.md',          // Lowercase markdown readme
      'Readme.md',          // Mixed case variant
      // Note: readme.txt is NOT excluded (kept in clean exports)
    ];

    const excludePatterns = (mode === 'full') ? alwaysExclude : cleanExclude;
    const stripComments = (mode === 'stripped');
    const isExcludedArchivePath = (relativePath: string): boolean => {
      for (const pattern of excludePatterns) {
        const patternPath = pattern.replace(/\/\*\*$/, '');
        const entryName = path.basename(relativePath);
        if (relativePath === patternPath
            || relativePath.startsWith(`${patternPath}/`)
            || (pattern.includes('**') && relativePath.includes(patternPath.replace('/**', '')))
            || (pattern.endsWith('*') && !pattern.includes('/') && entryName.startsWith(pattern.slice(0, -1)))) {
          return true;
        }
      }
      return false;
    };

    // Archive an inert snapshot. Project workloads can mutate their workspace
    // concurrently; copying without dereferencing links ensures the later ZIP
    // walk cannot be raced into reading a host path.
    snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-download-'));
    const snapshotDir = path.join(snapshotRoot, 'project');
    fs.cpSync(projectDir, snapshotDir, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) => {
        const relativePath = path.relative(projectDir, sourcePath).split(path.sep).join('/');
        return !relativePath || !isExcludedArchivePath(relativePath);
      },
    });
    const snapshotEntry = fs.lstatSync(snapshotDir);
    if (snapshotEntry.isSymbolicLink() || !snapshotEntry.isDirectory()) {
      throw new Error('Project changed while the download snapshot was being created');
    }

    // Set response headers
    const filename = safeProjectDownloadName(name, mode);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Import archiver
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });
    const abortArchive = () => {
      if (!res.writableEnded) archive.abort();
    };
    res.once('close', abortArchive);

    archive.on('error', (err: Error) => {
      console.error('[Download] Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      } else res.destroy(err);
    });

    // Pipe archive to response
    archive.pipe(res);

    // Helper: Strip comments from text files (safe regex approach)
    function stripCommentsFromCode(content: string, filePath: string): string {
      const ext = path.extname(filePath).toLowerCase();
      
      // JavaScript/TypeScript
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        // Remove single-line comments (but not URLs like http://example.com)
        content = content.replace(/([^:])\/\/.*/g, '$1');
        // Remove multi-line comments (but preserve JSDoc if it has @)
        content = content.replace(/\/\*(?![\s\S]*?@)[\s\S]*?\*\//g, '');
      }
      
      // CSS
      if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
        content = content.replace(/\/\*[\s\S]*?\*\//g, '');
      }
      
      // HTML
      if (['.html', '.htm'].includes(ext)) {
        content = content.replace(/<!--[\s\S]*?-->/g, '');
      }
      
      // Python
      if (ext === '.py') {
        // Remove single-line comments
        content = content.replace(/^\s*#.*/gm, '');
        // Remove docstrings (but keep first one if at top of file)
        const lines = content.split('\n');
        let inDocstring = false;
        let docstringChar = '';
        let firstDocstringSeen = false;
        const result: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          
          if (!inDocstring) {
            if ((trimmed.startsWith('"""') || trimmed.startsWith("'''")) && !firstDocstringSeen) {
              // Keep first docstring
              result.push(line);
              firstDocstringSeen = true;
              if (!trimmed.endsWith('"""') && !trimmed.endsWith("'''")) {
                inDocstring = true;
                docstringChar = trimmed.startsWith('"""') ? '"""' : "'''";
              }
            } else if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
              // Remove subsequent docstrings
              docstringChar = trimmed.startsWith('"""') ? '"""' : "'''";
              if (!trimmed.endsWith(docstringChar) || trimmed.length <= 3) {
                inDocstring = true;
              }
            } else {
              result.push(line);
            }
          } else {
            if (!firstDocstringSeen) {
              result.push(line);
              if (trimmed.endsWith(docstringChar)) {
                inDocstring = false;
                firstDocstringSeen = true;
              }
            } else {
              if (trimmed.endsWith(docstringChar)) {
                inDocstring = false;
              }
            }
          }
        }
        content = result.join('\n');
      }
      
      return content;
    }

    // Walk directory and add files
    function addDirectory(dirPath: string, zipPath: string = '') {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        const entryStat = fs.lstatSync(fullPath);

        // Project ZIP exports never follow links or include special files. A
        // project agent can create those inside its sandbox, but the host-side
        // exporter must not turn them into reads from elsewhere on the server.
        if (entryStat.isSymbolicLink() || (!entryStat.isDirectory() && !entryStat.isFile())) continue;
        
        if (isExcludedArchivePath(relPath)) continue;
        
        if (entryStat.isDirectory()) {
          addDirectory(fullPath, relPath);
        } else {
          const stat = entryStat;
          
          // Detect if file is text or binary
          const ext = path.extname(entry.name).toLowerCase();
          const textExtensions = [
            '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.scss', '.sass', '.less',
            '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php',
            '.md', '.txt', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf',
            '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
          ];
          
          const isBinary = !textExtensions.includes(ext);
          
          if (stripComments && !isBinary && stat.size < 5 * 1024 * 1024) {
            // Text file < 5MB: strip comments
            try {
              let content = fs.readFileSync(fullPath, 'utf-8');
              content = stripCommentsFromCode(content, entry.name);
              archive.append(content, { name: relPath });
            } catch {
              // If UTF-8 read fails, treat as binary
              archive.file(fullPath, { name: relPath });
            }
          } else {
            // Binary file or large file: add as-is
            archive.file(fullPath, { name: relPath });
          }
        }
      }
    }

    addDirectory(snapshotDir);

    try {
      await archive.finalize();
    } finally {
      res.off('close', abortArchive);
    }
    
    console.log(`[Download] ${name} (${mode}) → ${archive.pointer()} bytes`);
  } catch (error: any) {
    console.error('[Download] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed: ' + error.message });
    }
  } finally {
    if (snapshotRoot) {
      try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); } catch {}
    }
  }
});


export default router;
