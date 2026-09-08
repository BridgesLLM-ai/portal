import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  AdminUserRetirementIntegrityError,
  type AdminUserRetirementAdmissionEvidence,
  type AdminUserRetirementManifestV1,
  validateAdminUserRetirementManifest,
} from './adminUserRetirementLedger';

type RetirementDatabase = typeof prisma;

function fail(message: string): never {
  throw new AdminUserRetirementIntegrityError(message);
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function assertNoUnexpected(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const unexpected = uniqueSorted(actual).filter((value) => !expectedSet.has(value));
  if (unexpected.length > 0) {
    fail(`${label} contains state created after the immutable retirement manifest`);
  }
}

function validateAdmissionEvidence(
  manifest: AdminUserRetirementManifestV1,
  evidence: AdminUserRetirementAdmissionEvidence,
): void {
  if (
    !evidence
    || !String(evidence.transitionId || '').trim()
    || !Number.isSafeInteger(evidence.closedAuthorizationVersion)
    || evidence.closedAuthorizationVersion <= manifest.target.authorizationVersion
    || !/^[a-f0-9]{64}$/.test(String(evidence.evidenceDigest || ''))
  ) {
    fail('User-retirement admission closure evidence is invalid');
  }
}

async function assertRuntimeActorRowsAbsent(
  targetUserId: string,
  database: any,
): Promise<void> {
  const counts = await Promise.all([
    database.projectIdentity.count({ where: { workspaceOwnerId: targetUserId } }),
    database.projectChatMessage.count({ where: { userId: targetUserId } }),
    database.projectChatSession.count({ where: { userId: targetUserId } }),
    database.projectChatProviderBinding.count({ where: { userId: targetUserId } }),
    database.projectChatState.count({ where: { actorUserId: targetUserId } }),
    database.projectChatTurn.count({ where: { actorUserId: targetUserId } }),
    database.projectChatDestructiveResetJournal.count({ where: { actorUserId: targetUserId } }),
    database.legacyOpenClawProjectImport.count({ where: { actorUserId: targetUserId } }),
    database.legacyOpenClawProjectQuarantine.count({ where: { actorUserId: targetUserId } }),
    database.legacyOpenClawProjectClearTombstone.count({ where: { actorUserId: targetUserId } }),
    database.projectDependencyPromotionDecision.count({ where: { actorUserId: targetUserId } }),
    database.projectDependencyRepairOperation.count({ where: { actorUserId: targetUserId } }),
    database.projectRuntimeCleanupActor.count({ where: { actorUserId: targetUserId } }),
  ]);
  if (counts.some((count) => count !== 0)) {
    fail('Project owner or shared-actor state remains before final User deletion');
  }
}

async function assertFinalCascadeInventory(
  manifest: AdminUserRetirementManifestV1,
  database: any,
): Promise<void> {
  const [
    apps,
    shareLinks,
    files,
    jobs,
    agentSessions,
    authSessions,
    emailCodes,
    twoFactorChallenges,
    passwordResetTokens,
    mailboxes,
    ollamaAttributions,
    nativeOllamaAttributions,
  ] = await Promise.all([
    database.app.findMany({
      where: { userId: manifest.target.id },
      select: {
        id: true,
        name: true,
        projectIdentityId: true,
        deployType: true,
        zipPath: true,
        port: true,
      },
    }),
    database.appShareLink.findMany({
      where: { userId: manifest.target.id },
      select: { id: true },
    }),
    database.file.findMany({
      where: { userId: manifest.target.id },
      select: { id: true, path: true, cloudinaryId: true },
    }),
    database.agentJob.findMany({
      where: { userId: manifest.target.id },
      select: { id: true, transcriptPath: true, status: true },
    }),
    database.agentSession.findMany({
      where: { userId: manifest.target.id },
      select: { id: true, provider: true, externalId: true },
    }),
    database.session.count({ where: { userId: manifest.target.id } }),
    database.emailVerificationCode.count({ where: { userId: manifest.target.id } }),
    database.twoFactorChallenge.count({ where: { userId: manifest.target.id } }),
    database.passwordResetToken.count({ where: { userId: manifest.target.id } }),
    database.mailboxAccount.count({ where: { userId: manifest.target.id } }),
    database.ollamaBackendBinding.count({ where: { configuredByUserId: manifest.target.id } }),
    database.nativeOllamaBackendBinding.count({ where: { configuredByUserId: manifest.target.id } }),
  ]);

  assertNoUnexpected(
    apps.map((app: any) => app.id),
    manifest.apps.map((app) => app.id),
    'Final App inventory',
  );
  const expectedApps = new Map(manifest.apps.map((app) => [app.id, app]));
  for (const app of apps) {
    const expected = expectedApps.get(app.id);
    if (
      !expected
      || app.name !== expected.name
      || app.projectIdentityId !== expected.projectIdentityId
      || app.deployType !== expected.deployType
      || app.zipPath !== expected.sourcePath
      || app.port !== expected.port
    ) {
      fail(`Final App ${app.id} identity changed`);
    }
  }
  assertNoUnexpected(
    shareLinks.map((share: any) => share.id),
    manifest.apps.flatMap((app) => app.shareLinkIds),
    'Final App share inventory',
  );
  assertNoUnexpected(
    files.map((file: any) => file.id),
    manifest.files.map((file) => file.id),
    'Final File inventory',
  );
  const expectedFiles = new Map(manifest.files.map((file) => [file.id, file]));
  for (const file of files) {
    const expected = expectedFiles.get(file.id);
    if (
      !expected
      || file.path !== expected.path
      || file.cloudinaryId !== expected.cloudinaryId
      || file.cloudinaryId !== null
    ) {
      fail(`Final File ${file.id} identity changed`);
    }
  }
  assertNoUnexpected(
    jobs.map((job: any) => job.id),
    manifest.agentJobs.map((job) => job.id),
    'Final Agent job inventory',
  );
  const expectedJobs = new Map(manifest.agentJobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    const expected = expectedJobs.get(job.id);
    if (
      !expected
      || job.transcriptPath !== expected.transcriptPath
      || String(job.status) === 'running'
    ) {
      fail(`Final Agent job ${job.id} identity or runtime state changed`);
    }
  }
  assertNoUnexpected(
    agentSessions.map((session: any) => session.id),
    manifest.agentSessions.map((session) => session.id),
    'Final Agent session inventory',
  );
  const expectedAgentSessions = new Map(
    manifest.agentSessions.map((session) => [session.id, session]),
  );
  for (const session of agentSessions) {
    const expected = expectedAgentSessions.get(session.id);
    if (
      !expected
      || String(session.provider) !== expected.provider
      || session.externalId !== expected.externalId
    ) {
      fail(`Final Agent session ${session.id} identity changed`);
    }
  }
  if (
    authSessions !== 0
    || emailCodes !== 0
    || twoFactorChallenges !== 0
    || passwordResetTokens !== 0
    || mailboxes !== 0
    || ollamaAttributions !== 0
    || nativeOllamaAttributions !== 0
  ) {
    fail('Admission, mailbox, or provider-attribution state remains before final User deletion');
  }
}

/**
 * Final database commit, callable only after the durable retirement journal
 * has persisted external-absence evidence. The closed authorization generation
 * is intentionally an explicit argument and must exactly match the journal's
 * persisted admission-closure evidence.
 */
export async function commitAdminUserDatabaseDeletion(
  candidate: AdminUserRetirementManifestV1,
  admissionEvidence: AdminUserRetirementAdmissionEvidence,
  database: RetirementDatabase = prisma,
): Promise<void> {
  const manifest = validateAdminUserRetirementManifest(candidate);
  validateAdmissionEvidence(manifest, admissionEvidence);

  await database.$transaction(async (transaction) => {
    const target = await transaction.user.findUnique({
      where: { id: manifest.target.id },
      select: {
        id: true,
        role: true,
        isActive: true,
        accountStatus: true,
        authorizationVersion: true,
      },
    });
    if (!target) return;
    if (
      String(target.role) !== manifest.target.role
      || target.isActive !== false
      || String(target.accountStatus) !== 'DISABLED'
      || target.authorizationVersion !== admissionEvidence.closedAuthorizationVersion
    ) {
      fail('User admission closure changed before final database deletion');
    }

    await assertRuntimeActorRowsAbsent(manifest.target.id, transaction);
    await assertFinalCascadeInventory(manifest, transaction);
    const deleted = await transaction.user.deleteMany({
      where: {
        id: manifest.target.id,
        role: manifest.target.role as any,
        isActive: false,
        accountStatus: 'DISABLED',
        authorizationVersion: admissionEvidence.closedAuthorizationVersion,
      },
    });
    if (deleted.count !== 1) {
      fail('User identity changed before final database deletion committed');
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30_000,
  });
}

export async function assertAdminUserDatabaseAbsence(
  targetUserId: string,
  database: RetirementDatabase = prisma,
): Promise<void> {
  const userId = String(targetUserId || '').trim();
  if (!userId) fail('User absence target identity is invalid');
  const [
    user,
    ownedProjects,
    apps,
    shareLinks,
    files,
    jobs,
    agentSessions,
    sessions,
    emailCodes,
    twoFactorChallenges,
    passwordResetTokens,
    mailboxes,
    messages,
    projectSessions,
    bindings,
    states,
    turns,
    resets,
    imports,
    quarantines,
    clears,
    ollamaAttributions,
    nativeOllamaAttributions,
    promotionDecisions,
    repairOperations,
    cleanupActors,
  ] = await Promise.all([
    database.user.count({ where: { id: userId } }),
    database.projectIdentity.count({ where: { workspaceOwnerId: userId } }),
    database.app.count({ where: { userId } }),
    database.appShareLink.count({ where: { userId } }),
    database.file.count({ where: { userId } }),
    database.agentJob.count({ where: { userId } }),
    database.agentSession.count({ where: { userId } }),
    database.session.count({ where: { userId } }),
    database.emailVerificationCode.count({ where: { userId } }),
    database.twoFactorChallenge.count({ where: { userId } }),
    database.passwordResetToken.count({ where: { userId } }),
    database.mailboxAccount.count({ where: { userId } }),
    database.projectChatMessage.count({ where: { userId } }),
    database.projectChatSession.count({ where: { userId } }),
    database.projectChatProviderBinding.count({ where: { userId } }),
    database.projectChatState.count({ where: { actorUserId: userId } }),
    database.projectChatTurn.count({ where: { actorUserId: userId } }),
    database.projectChatDestructiveResetJournal.count({ where: { actorUserId: userId } }),
    database.legacyOpenClawProjectImport.count({ where: { actorUserId: userId } }),
    database.legacyOpenClawProjectQuarantine.count({ where: { actorUserId: userId } }),
    database.legacyOpenClawProjectClearTombstone.count({ where: { actorUserId: userId } }),
    database.ollamaBackendBinding.count({ where: { configuredByUserId: userId } }),
    database.nativeOllamaBackendBinding.count({ where: { configuredByUserId: userId } }),
    database.projectDependencyPromotionDecision.count({ where: { actorUserId: userId } }),
    database.projectDependencyRepairOperation.count({ where: { actorUserId: userId } }),
    database.projectRuntimeCleanupActor.count({ where: { actorUserId: userId } }),
  ]);
  if ([
    user,
    ownedProjects,
    apps,
    shareLinks,
    files,
    jobs,
    agentSessions,
    sessions,
    emailCodes,
    twoFactorChallenges,
    passwordResetTokens,
    mailboxes,
    messages,
    projectSessions,
    bindings,
    states,
    turns,
    resets,
    imports,
    quarantines,
    clears,
    ollamaAttributions,
    nativeOllamaAttributions,
    promotionDecisions,
    repairOperations,
    cleanupActors,
  ].some((count) => count !== 0)) {
    fail('Retired User database state is not fully absent');
  }
}
