import type { AgentProviderName } from '../agents/AgentProvider.interface';
import { AgentRegistry } from '../agents';
import {
  listNativeUserSessions,
  type NativeSessionData,
} from '../agents/providers/NativeSessionStore';
import { prisma } from '../config/database';
import {
  deleteSession as deleteOpenClawSession,
  readGatewaySessionIdentityStrict,
  type DeleteOpenClawSessionOptions,
  type LocalOpenClawSessionIdentity,
} from '../utils/openclawGatewayRpc';
import {
  forgetAppRuntime,
  getAppStatus,
  stopApp,
} from './app-process.service';
import {
  initializeAgentJobsRuntime,
  killAgentJob,
} from './agentJobs';
import {
  AdminUserRetirementIntegrityError,
  type AdminUserRetirementManifestV1,
  type AdminUserRetirementRunnerContext,
  validateAdminUserRetirementManifest,
} from './adminUserRetirementLedger';
import {
  digestAdminUserRetirementSnapshot,
} from './adminUserRetirementManifest';
import {
  assertLegacyOpenClawSessionPrivacyAbsent,
  attestOpenClawRetirementRuntimeFamily,
  buildOpenClawRetirementIdentityAttestation,
  captureLegacyOpenClawSessionPrivacyTarget,
  hardDeleteLegacyOpenClawSessionPrivacyArtifacts,
  resolveLegacyOpenClawSessionPrivacyTarget,
  type LegacyOpenClawSessionPrivacyTarget,
  type OpenClawRetirementSessionIdentity,
  type OpenClawRetirementRuntimeFamily,
} from './openClawLegacySessionPrivacy';
import {
  assertAdminUserManagedPathAbsent,
  digestAdminUserRetirementManagedPathAbsence,
  retireAdminUserManagedPath,
} from './adminUserRetirementManagedPath';
import {
  assertStalwartPrincipalAbsent,
} from './mailboxReconciliation';
import {
  getProjectChatProviderCleanupController,
  isQualifiableProjectProvider,
} from './projectChatProviderRegistry';
import { deleteUserMailboxByUserId } from './userMailService';

const APP_STATE_PREFIX = 'portal.app-process.state.';
const NATIVE_SESSION_PROVIDERS = Object.freeze([
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
  'HERMES',
  'OPENCODE',
] as const satisfies readonly AgentProviderName[]);

type ExternalStateDatabase = typeof prisma;

export type AdminUserRetirementExternalStateDependencies = {
  database?: ExternalStateDatabase;
  initializeJobs?(): Promise<unknown>;
  killJob?(jobId: string, userId: string): Promise<void>;
  listNativeSessions?(provider: AgentProviderName, userId: string): NativeSessionData[];
  terminateNativeSession?(session: NativeSessionData): Promise<void>;
  deleteGatewaySession?(
    sessionKey: string,
    options?: DeleteOpenClawSessionOptions,
  ): Promise<{
    ok: boolean;
    deleted?: boolean;
    archived?: string[];
    error?: string;
  }>;
  readGatewaySession?(sessionKey: string): Promise<LocalOpenClawSessionIdentity | null>;
  attestOpenClawRuntimeFamily?(): Promise<OpenClawRetirementRuntimeFamily>;
  resolveLegacyOpenClawSession?(input: OpenClawRetirementSessionIdentity): LegacyOpenClawSessionPrivacyTarget;
  captureLegacyOpenClawSession?(input: OpenClawRetirementSessionIdentity): LegacyOpenClawSessionPrivacyTarget;
  hardDeleteLegacyOpenClawSession?(input: {
    identity: OpenClawRetirementSessionIdentity;
    archivedPaths: readonly string[];
  }): Promise<void>;
  assertLegacyOpenClawSessionAbsent?(input: OpenClawRetirementSessionIdentity): void;
  forgetApp?(
    appId: string,
    deployId: string,
    identity: {
      actorId: string;
      projectId: string;
      deployPath: string;
      port: number | null;
    },
  ): Promise<void>;
  stopApp?(deployId: string): Promise<void>;
  getAppStatus?(deployId: string): { status: string } | null;
  deleteMailbox?(username: string, userId: string): Promise<void>;
  assertMailboxAbsent?(username: string): Promise<void>;
  retireManagedPath?(target: AdminUserRetirementManifestV1['localTargets']['managedPaths'][number]): Promise<void>;
  assertManagedPathAbsent?(target: AdminUserRetirementManifestV1['localTargets']['managedPaths'][number]): Promise<void>;
};

function fail(message: string): never {
  throw new AdminUserRetirementIntegrityError(message);
}

async function withRetirementLease<T>(
  context: AdminUserRetirementRunnerContext,
  operation: () => Promise<T>,
): Promise<T> {
  await context.assertHeld();
  const result = await operation();
  await context.assertHeld();
  return result;
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function exactStringSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
  options: { allowMissing?: boolean } = {},
): void {
  const actualValues = uniqueSorted(actual);
  const expectedValues = uniqueSorted(expected);
  const unexpected = actualValues.filter((value) => !expectedValues.includes(value));
  const missing = expectedValues.filter((value) => !actualValues.includes(value));
  if (unexpected.length > 0 || (!options.allowMissing && missing.length > 0)) {
    fail(`${label} changed after the immutable retirement manifest was sealed`);
  }
}

function providerName(value: string): AgentProviderName {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'GROK_BUILD') return 'GROK';
  if ([
    'OPENCLAW',
    'CLAUDE_CODE',
    'CODEX',
    'GROK',
    'AGENT_ZERO',
    'GEMINI',
    'OLLAMA',
    'HERMES',
    'OPENCODE',
  ].includes(normalized)) {
    return normalized as AgentProviderName;
  }
  fail(`Agent provider ${normalized || '(empty)'} has no retirement adapter`);
}

function nativeSessionIdentityDigest(session: NativeSessionData): string {
  return digestAdminUserRetirementSnapshot({
    sessionId: session.sessionId,
    provider: session.provider,
    userId: session.userId,
    executionContext: session.executionContext || null,
  });
}

function localGatewayIdentityFromManifest(
  session: AdminUserRetirementManifestV1['agentSessions'][number],
): OpenClawRetirementSessionIdentity {
  if (
    session.provider !== 'OPENCLAW'
    || !session.localAgentId
    || !session.localSessionId
    || !session.localIdentityDigest
  ) {
    fail(`OpenClaw session ${session.id} has no sealed privacy identity`);
  }
  return Object.freeze({
    agentId: session.localAgentId,
    sessionKey: session.externalId,
    sessionId: session.localSessionId,
  });
}

function assertLocalGatewayIdentityMatchesManifest(
  session: AdminUserRetirementManifestV1['agentSessions'][number],
  current: LocalOpenClawSessionIdentity | null,
  family: OpenClawRetirementRuntimeFamily,
  resolveLegacySession: (identity: OpenClawRetirementSessionIdentity) => LegacyOpenClawSessionPrivacyTarget,
): OpenClawRetirementSessionIdentity {
  const expected = localGatewayIdentityFromManifest(session);
  if (current && (
    current.agentId !== expected.agentId
    || current.sessionKey !== expected.sessionKey
    || current.sessionId !== expected.sessionId
  )) fail(`OpenClaw session ${session.id} local identity changed after manifest`);
  const legacySessionFile = family === 'legacy-2026.7.1'
    ? resolveLegacySession(expected).sessionFile
    : undefined;
  const identityDigest = digestAdminUserRetirementSnapshot(
    buildOpenClawRetirementIdentityAttestation({
      identity: expected,
      family,
      ...(legacySessionFile ? { legacySessionFile } : {}),
    }),
  );
  if (identityDigest !== session.localIdentityDigest) {
    fail(`OpenClaw session ${session.id} runtime family or privacy identity changed after manifest`);
  }
  return expected;
}

async function verifyOpenClawSessionAbsent(
  session: AdminUserRetirementManifestV1['agentSessions'][number],
  dependencies: Required<Pick<
    AdminUserRetirementExternalStateDependencies,
    'readGatewaySession'
  >>,
): Promise<void> {
  let current: LocalOpenClawSessionIdentity | null;
  try {
    current = await dependencies.readGatewaySession(session.externalId);
  } catch {
    fail(`OpenClaw session ${session.id} absence could not be verified`);
  }
  if (current) fail(`OpenClaw session ${session.id} is still present`);
}

async function attestManifestOpenClawRuntimeFamily(
  manifest: AdminUserRetirementManifestV1,
  dependencies: ReturnType<typeof productionDependencies>,
): Promise<OpenClawRetirementRuntimeFamily | null> {
  if (!manifest.agentSessions.some((session) => session.provider === 'OPENCLAW')) return null;
  try {
    return await dependencies.attestOpenClawRuntimeFamily();
  } catch {
    fail('OpenClaw retirement runtime family could not be attested exactly');
  }
}

async function assertOpenClawRuntimeFamilyStable(
  expected: OpenClawRetirementRuntimeFamily,
  dependencies: ReturnType<typeof productionDependencies>,
): Promise<void> {
  let current: OpenClawRetirementRuntimeFamily;
  try {
    current = await dependencies.attestOpenClawRuntimeFamily();
  } catch {
    fail('OpenClaw retirement runtime family could not be re-attested exactly');
  }
  if (current !== expected) {
    fail('OpenClaw retirement runtime family changed during retirement');
  }
}

function currentNativeSessions(
  userId: string,
  listNativeSessions: NonNullable<
    AdminUserRetirementExternalStateDependencies['listNativeSessions']
  >,
): NativeSessionData[] {
  return NATIVE_SESSION_PROVIDERS.flatMap((provider) => (
    listNativeSessions(provider, userId)
  ));
}

function assertNativeSessionsMatchManifest(
  manifest: AdminUserRetirementManifestV1,
  current: readonly NativeSessionData[],
): void {
  const expected = new Map(manifest.localTargets.nativeSessions.map((session) => [
    `${session.provider}\u0000${session.sessionId}`,
    session,
  ]));
  for (const session of current) {
    const key = `${session.provider}\u0000${session.sessionId}`;
    const attestation = expected.get(key);
    if (!attestation || nativeSessionIdentityDigest(session) !== attestation.identityDigest) {
      fail(`Native session ${session.sessionId} changed after the retirement manifest was sealed`);
    }
  }
}

function productionDependencies(
  overrides: AdminUserRetirementExternalStateDependencies,
) {
  return {
    database: overrides.database || prisma,
    initializeJobs: overrides.initializeJobs || initializeAgentJobsRuntime,
    killJob: overrides.killJob || killAgentJob,
    listNativeSessions: overrides.listNativeSessions || listNativeUserSessions,
    terminateNativeSession: overrides.terminateNativeSession
      || (async (session: NativeSessionData) => {
        const executionScope = (session.executionContext as { scope?: unknown } | undefined)?.scope;
        if (
          executionScope !== undefined
          && executionScope !== 'HOST_OPERATOR'
          && executionScope !== 'PROJECT_SANDBOX'
        ) {
          fail(`Native session ${session.sessionId} has an invalid execution scope`);
        }
        if (executionScope === 'PROJECT_SANDBOX') {
          if (!isQualifiableProjectProvider(session.provider)) {
            fail(`Project session ${session.sessionId} has no confined cleanup adapter`);
          }
          const controller = getProjectChatProviderCleanupController(session.provider);
          if (controller.providerName !== session.provider) {
            fail(`Project session ${session.sessionId} cleanup adapter identity changed`);
          }
          await controller.terminateSession(session.sessionId);
          return;
        }
        await AgentRegistry.getProviderCleanupController(session.provider)
          .terminateSession(session.sessionId);
      }),
    deleteGatewaySession: overrides.deleteGatewaySession || deleteOpenClawSession,
    readGatewaySession: overrides.readGatewaySession || readGatewaySessionIdentityStrict,
    attestOpenClawRuntimeFamily: overrides.attestOpenClawRuntimeFamily
      || attestOpenClawRetirementRuntimeFamily,
    resolveLegacyOpenClawSession: overrides.resolveLegacyOpenClawSession
      || resolveLegacyOpenClawSessionPrivacyTarget,
    captureLegacyOpenClawSession: overrides.captureLegacyOpenClawSession
      || captureLegacyOpenClawSessionPrivacyTarget,
    hardDeleteLegacyOpenClawSession: overrides.hardDeleteLegacyOpenClawSession
      || hardDeleteLegacyOpenClawSessionPrivacyArtifacts,
    assertLegacyOpenClawSessionAbsent: overrides.assertLegacyOpenClawSessionAbsent
      || assertLegacyOpenClawSessionPrivacyAbsent,
    forgetApp: overrides.forgetApp || forgetAppRuntime,
    stopApp: overrides.stopApp || stopApp,
    getAppStatus: overrides.getAppStatus || getAppStatus,
    deleteMailbox: overrides.deleteMailbox || deleteUserMailboxByUserId,
    assertMailboxAbsent: overrides.assertMailboxAbsent || assertStalwartPrincipalAbsent,
    retireManagedPath: overrides.retireManagedPath || retireAdminUserManagedPath,
    assertManagedPathAbsent: overrides.assertManagedPathAbsent || assertAdminUserManagedPathAbsent,
  };
}

async function loadAndValidateTargetJobs(
  manifest: AdminUserRetirementManifestV1,
  database: ExternalStateDatabase,
): Promise<Array<{
  id: string;
  status: string;
  transcriptPath: string | null;
  metadata: unknown;
}>> {
  const jobs = await database.agentJob.findMany({
    where: { userId: manifest.target.id },
    orderBy: { id: 'asc' },
    select: { id: true, status: true, transcriptPath: true, metadata: true },
  });
  exactStringSet(
    jobs.map((job) => job.id),
    manifest.agentJobs.map((job) => job.id),
    'Agent job inventory',
    { allowMissing: true },
  );
  const expected = new Map(manifest.agentJobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    const attestation = expected.get(job.id)!;
    if (job.transcriptPath !== attestation.transcriptPath) {
      fail(`Agent job ${job.id} transcript identity changed after manifest`);
    }
    if (
      String(job.status) === attestation.status
      && digestAdminUserRetirementSnapshot(job.metadata || {}) !== attestation.metadataDigest
    ) {
      fail(`Agent job ${job.id} metadata changed without a terminal transition`);
    }
    if (String(job.status) === 'running' && attestation.status !== 'running') {
      fail(`Agent job ${job.id} restarted after the retirement manifest was sealed`);
    }
  }
  return jobs.map((job) => ({ ...job, status: String(job.status) }));
}

async function assertDatabaseAgentSessionsMatchManifest(
  manifest: AdminUserRetirementManifestV1,
  database: ExternalStateDatabase,
): Promise<void> {
  const sessions = await database.agentSession.findMany({
    where: { userId: manifest.target.id },
    orderBy: { id: 'asc' },
    select: { id: true, provider: true, externalId: true },
  });
  exactStringSet(
    sessions.map((session) => session.id),
    manifest.agentSessions.map((session) => session.id),
    'Agent session inventory',
  );
  const expected = new Map(manifest.agentSessions.map((session) => [session.id, session]));
  for (const session of sessions) {
    const attestation = expected.get(session.id)!;
    if (
      String(session.provider) !== attestation.provider
      || session.externalId !== attestation.externalId
    ) {
      fail(`Agent session ${session.id} identity changed after manifest`);
    }
  }
}

async function assertExternalDatabaseInventoryMatchesManifest(
  manifest: AdminUserRetirementManifestV1,
  database: ExternalStateDatabase,
): Promise<void> {
  const [apps, files, mailboxes, ollamaBindings, nativeOllamaBindings] = await Promise.all([
    database.app.findMany({
      where: { userId: manifest.target.id },
      orderBy: { id: 'asc' },
      include: {
        shareLinks: {
          orderBy: { id: 'asc' },
          select: { id: true, token: true },
        },
      },
    }),
    database.file.findMany({
      where: { userId: manifest.target.id },
      orderBy: { id: 'asc' },
      select: { id: true, path: true, cloudinaryId: true },
    }),
    database.mailboxAccount.findMany({
      where: { userId: manifest.target.id },
      orderBy: { username: 'asc' },
      select: { username: true },
    }),
    database.ollamaBackendBinding.findMany({
      where: { configuredByUserId: manifest.target.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.nativeOllamaBackendBinding.findMany({
      where: { configuredByUserId: manifest.target.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
  ]);
  exactStringSet(
    apps.map((app) => app.id),
    manifest.apps.map((app) => app.id),
    'App inventory',
    { allowMissing: true },
  );
  const expectedApps = new Map(manifest.apps.map((app) => [app.id, app]));
  for (const app of apps) {
    const expected = expectedApps.get(app.id)!;
    if (
      app.name !== expected.name
      || app.projectIdentityId !== expected.projectIdentityId
      || app.deployType !== expected.deployType
      || app.port !== expected.port
      || app.zipPath !== expected.sourcePath
    ) {
      fail(`App ${app.id} identity changed after manifest`);
    }
    exactStringSet(
      app.shareLinks.map((share) => share.id),
      expected.shareLinkIds,
      `App ${app.id} share-link inventory`,
    );
    const tokenDigests = app.shareLinks.map((share) => (
      digestAdminUserRetirementSnapshot(share.token)
    ));
    exactStringSet(
      tokenDigests,
      expected.shareTokenDigests,
      `App ${app.id} share-token inventory`,
    );
  }
  exactStringSet(
    files.map((file) => file.id),
    manifest.files.map((file) => file.id),
    'File inventory',
  );
  const expectedFiles = new Map(manifest.files.map((file) => [file.id, file]));
  for (const file of files) {
    const expected = expectedFiles.get(file.id)!;
    if (
      file.path !== expected.path
      || file.cloudinaryId !== expected.cloudinaryId
      || file.cloudinaryId !== null
    ) {
      fail(`File ${file.id} external identity changed after manifest`);
    }
  }
  exactStringSet(
    mailboxes.map((mailbox) => mailbox.username),
    manifest.mailboxes.usernames,
    'Mailbox inventory',
    { allowMissing: true },
  );
  exactStringSet(
    ollamaBindings.map((binding) => binding.id),
    manifest.providerAttributions.ollamaBindingIds,
    'Ollama attribution inventory',
    { allowMissing: true },
  );
  exactStringSet(
    nativeOllamaBindings.map((binding) => binding.id),
    manifest.providerAttributions.nativeOllamaBindingIds,
    'Native Ollama attribution inventory',
    { allowMissing: true },
  );
}

async function retireApps(
  manifest: AdminUserRetirementManifestV1,
  context: AdminUserRetirementRunnerContext,
  dependencies: ReturnType<typeof productionDependencies>,
): Promise<void> {
  const projects = new Map(manifest.ownedProjects.map((project) => [project.id, project]));
  for (const app of manifest.apps) {
    const deployId = `${manifest.target.id}-${app.name}`;
    if (app.projectIdentityId) {
      const project = projects.get(app.projectIdentityId);
      if (!project) fail(`App ${app.id} has no owned Project retirement identity`);
      await withRetirementLease(context, () => dependencies.forgetApp(
        app.id,
        deployId,
        {
          actorId: manifest.target.id,
          projectId: project.id,
          deployPath: app.deployPath,
          port: app.port,
        },
      ));
    } else {
      if (app.deployType !== 'static' || app.processStatus !== 'stopped') {
        fail(`App ${app.id} lacks a qualified immutable runtime identity`);
      }
      await withRetirementLease(context, () => dependencies.stopApp(deployId));
      const persisted = await dependencies.database.systemSetting.findUnique({
        where: { key: `${APP_STATE_PREFIX}${app.id}` },
        select: { key: true },
      });
      if (persisted) {
        fail(`App ${app.id} has unqualified persisted runtime state`);
      }
    }
    if (dependencies.getAppStatus(deployId)) {
      fail(`App ${app.id} remains in the process registry after retirement`);
    }
  }
}

async function retireNativeAndGatewaySessions(
  manifest: AdminUserRetirementManifestV1,
  context: AdminUserRetirementRunnerContext,
  dependencies: ReturnType<typeof productionDependencies>,
  openClawRuntimeFamily: OpenClawRetirementRuntimeFamily | null,
): Promise<void> {
  const current = currentNativeSessions(manifest.target.id, dependencies.listNativeSessions);
  assertNativeSessionsMatchManifest(manifest, current);
  for (const session of current) {
    await withRetirementLease(
      context,
      () => dependencies.terminateNativeSession(session),
    );
  }
  const remaining = currentNativeSessions(manifest.target.id, dependencies.listNativeSessions);
  if (remaining.length !== 0) fail('Native agent sessions remain after retirement');

  await assertDatabaseAgentSessionsMatchManifest(manifest, dependencies.database);
  for (const session of manifest.agentSessions) {
    if (session.provider === 'OPENCLAW') {
      if (!openClawRuntimeFamily) fail('OpenClaw retirement runtime family was not attested');
      await assertOpenClawRuntimeFamilyStable(openClawRuntimeFamily, dependencies);
      const currentLocal = await dependencies.readGatewaySession(session.externalId);
      const expectedLocal = assertLocalGatewayIdentityMatchesManifest(
        session,
        currentLocal,
        openClawRuntimeFamily,
        dependencies.resolveLegacyOpenClawSession,
      );
      if (openClawRuntimeFamily === 'legacy-2026.7.1' && currentLocal) {
        dependencies.captureLegacyOpenClawSession(expectedLocal);
      }
      const deleted = await withRetirementLease(
        context,
        () => dependencies.deleteGatewaySession(session.externalId, {
          agentId: expectedLocal.agentId,
          expectedSessionId: expectedLocal.sessionId,
          ...(openClawRuntimeFamily === 'legacy-2026.7.1'
            ? { deleteTranscript: true }
            : {
                // The Portal-patched 9.1 Gateway performs the transcript
                // removal inside the same CAS-guarded session mutation.
                deleteTranscriptWithoutArchive: true,
              }),
        }),
      );
      if (!deleted.ok && !/session not found|not found/i.test(String(deleted.error || ''))) {
        fail(`OpenClaw session ${session.id} deletion failed`);
      }
      if (
        !deleted.ok
        || typeof deleted.deleted !== 'boolean'
        || !Array.isArray(deleted.archived)
        || deleted.archived.some((entry) => typeof entry !== 'string')
      ) {
        fail(`OpenClaw session ${session.id} returned no verifiable deletion receipt`);
      }
      if (currentLocal && deleted.deleted !== true) {
        fail(`OpenClaw session ${session.id} deletion receipt did not confirm the sealed session`);
      }
      if (openClawRuntimeFamily === 'legacy-2026.7.1') {
        await withRetirementLease(
          context,
          () => dependencies.hardDeleteLegacyOpenClawSession({
            identity: expectedLocal,
            archivedPaths: deleted.archived!,
          }),
        );
      } else if (deleted.archived.length !== 0) {
        fail(`OpenClaw session ${session.id} produced an archive during atomic hard deletion`);
      }
      await assertOpenClawRuntimeFamilyStable(openClawRuntimeFamily, dependencies);
      await verifyOpenClawSessionAbsent(session, dependencies);
      if (openClawRuntimeFamily === 'legacy-2026.7.1') {
        dependencies.assertLegacyOpenClawSessionAbsent(expectedLocal);
      }
      continue;
    }
    const provider = providerName(session.provider);
    if (remaining.some((native) => (
      native.provider === provider && native.sessionId === session.externalId
    ))) {
      fail(`Agent session ${session.id} native runtime remains`);
    }
  }
}

async function retireAuthAndProviderAttribution(
  manifest: AdminUserRetirementManifestV1,
  context: AdminUserRetirementRunnerContext,
  database: ExternalStateDatabase,
): Promise<void> {
  await withRetirementLease(context, () => database.$transaction(async (transaction) => {
    const deleteExact = async (
      delegate: { findMany(args: unknown): Promise<Array<{ id: string }>>; deleteMany(args: unknown): Promise<unknown> },
      ids: readonly string[],
      label: string,
    ) => {
      const current = await delegate.findMany({
        where: { userId: manifest.target.id },
        select: { id: true },
      });
      exactStringSet(
        current.map((entry) => entry.id),
        ids,
        label,
        { allowMissing: true },
      );
      if (ids.length > 0) {
        await delegate.deleteMany({
          where: { userId: manifest.target.id, id: { in: [...ids] } },
        });
      }
    };
    await deleteExact(transaction.session, manifest.authState.sessionIds, 'Refresh session inventory');
    await deleteExact(
      transaction.emailVerificationCode,
      manifest.authState.emailVerificationCodeIds,
      'Email verification inventory',
    );
    await deleteExact(
      transaction.twoFactorChallenge,
      manifest.authState.twoFactorChallengeIds,
      'Two-factor challenge inventory',
    );
    await deleteExact(
      transaction.passwordResetToken,
      manifest.authState.passwordResetTokenIds,
      'Password reset inventory',
    );
    if (manifest.providerAttributions.ollamaBindingIds.length > 0) {
      await transaction.ollamaBackendBinding.updateMany({
        where: {
          id: { in: manifest.providerAttributions.ollamaBindingIds },
          configuredByUserId: manifest.target.id,
        },
        data: { configuredByUserId: null },
      });
    }
    if (manifest.providerAttributions.nativeOllamaBindingIds.length > 0) {
      await transaction.nativeOllamaBackendBinding.updateMany({
        where: {
          id: { in: manifest.providerAttributions.nativeOllamaBindingIds },
          configuredByUserId: manifest.target.id,
        },
        data: { configuredByUserId: null },
      });
    }
  }));
}

/**
 * Production adapters for account-owned state that is independent of the
 * Project authorization transition. Every operation is restart-idempotent and
 * re-attests its immutable inventory. This does not retire shared Project actor
 * state and therefore is intentionally not exported as a complete Runner.
 */
export async function retireAdminUserExternalState(
  candidate: AdminUserRetirementManifestV1,
  context: AdminUserRetirementRunnerContext,
  overrides: AdminUserRetirementExternalStateDependencies = {},
): Promise<void> {
  const manifest = validateAdminUserRetirementManifest(candidate);
  const dependencies = productionDependencies(overrides);
  const openClawRuntimeFamily = await attestManifestOpenClawRuntimeFamily(
    manifest,
    dependencies,
  );

  await assertExternalDatabaseInventoryMatchesManifest(manifest, dependencies.database);
  await assertDatabaseAgentSessionsMatchManifest(manifest, dependencies.database);
  await loadAndValidateTargetJobs(manifest, dependencies.database);
  assertNativeSessionsMatchManifest(
    manifest,
    currentNativeSessions(manifest.target.id, dependencies.listNativeSessions),
  );
  for (const session of manifest.agentSessions) {
    if (session.provider !== 'OPENCLAW') continue;
    if (!openClawRuntimeFamily) fail('OpenClaw retirement runtime family was not attested');
    const current = await dependencies.readGatewaySession(session.externalId);
    const expected = assertLocalGatewayIdentityMatchesManifest(
      session,
      current,
      openClawRuntimeFamily,
      dependencies.resolveLegacyOpenClawSession,
    );
    if (openClawRuntimeFamily === 'legacy-2026.7.1' && current) {
      dependencies.captureLegacyOpenClawSession(expected);
    }
  }
  await retireApps(manifest, context, dependencies);

  await withRetirementLease(context, () => dependencies.initializeJobs());
  let jobs = await loadAndValidateTargetJobs(manifest, dependencies.database);
  for (const job of jobs) {
    if (job.status === 'running') {
      await withRetirementLease(
        context,
        () => dependencies.killJob(job.id, manifest.target.id),
      );
    }
  }
  jobs = await loadAndValidateTargetJobs(manifest, dependencies.database);
  if (jobs.some((job) => job.status === 'running')) {
    fail('Agent job runtime remains active after retirement');
  }
  await retireNativeAndGatewaySessions(
    manifest,
    context,
    dependencies,
    openClawRuntimeFamily,
  );

  for (const username of manifest.mailboxes.usernames) {
    await withRetirementLease(
      context,
      () => dependencies.deleteMailbox(username, manifest.target.id),
    );
    await dependencies.assertMailboxAbsent(username);
  }
  await retireAuthAndProviderAttribution(manifest, context, dependencies.database);

  for (const target of manifest.localTargets.managedPaths) {
    await withRetirementLease(context, () => dependencies.retireManagedPath(target));
  }
  await verifyAdminUserExternalStateAbsence(manifest, context, overrides);
}

export async function verifyAdminUserExternalStateAbsence(
  candidate: AdminUserRetirementManifestV1,
  context: AdminUserRetirementRunnerContext,
  overrides: AdminUserRetirementExternalStateDependencies = {},
): Promise<{ evidenceDigest: string }> {
  const manifest = validateAdminUserRetirementManifest(candidate);
  const dependencies = productionDependencies(overrides);
  const openClawRuntimeFamily = await attestManifestOpenClawRuntimeFamily(
    manifest,
    dependencies,
  );
  const nativeSessions = currentNativeSessions(
    manifest.target.id,
    dependencies.listNativeSessions,
  );
  if (nativeSessions.length !== 0) fail('Native agent sessions remain after retirement');

  const jobs = await loadAndValidateTargetJobs(manifest, dependencies.database);
  if (jobs.some((job) => job.status === 'running')) {
    fail('Agent job runtime remains active after retirement');
  }
  for (const app of manifest.apps) {
    const deployId = `${manifest.target.id}-${app.name}`;
    if (dependencies.getAppStatus(deployId)) fail(`App ${app.id} runtime remains`);
    const persisted = await dependencies.database.systemSetting.findUnique({
      where: { key: `${APP_STATE_PREFIX}${app.id}` },
      select: { key: true },
    });
    if (persisted) fail(`App ${app.id} process state remains`);
  }
  for (const session of manifest.agentSessions) {
    if (session.provider === 'OPENCLAW') {
      if (!openClawRuntimeFamily) fail('OpenClaw retirement runtime family was not attested');
      await assertOpenClawRuntimeFamilyStable(openClawRuntimeFamily, dependencies);
      const expected = assertLocalGatewayIdentityMatchesManifest(
        session,
        null,
        openClawRuntimeFamily,
        dependencies.resolveLegacyOpenClawSession,
      );
      await verifyOpenClawSessionAbsent(session, dependencies);
      if (openClawRuntimeFamily === 'legacy-2026.7.1') {
        dependencies.assertLegacyOpenClawSessionAbsent(expected);
      }
    }
  }
  for (const username of manifest.mailboxes.usernames) {
    await dependencies.assertMailboxAbsent(username);
  }
  for (const target of manifest.localTargets.managedPaths) {
    await dependencies.assertManagedPathAbsent(target);
  }
  const [
    ollamaAttributions,
    nativeOllamaAttributions,
    mailboxRows,
    authSessions,
    emailCodes,
    twoFactorChallenges,
    passwordResetTokens,
  ] = await Promise.all([
    dependencies.database.ollamaBackendBinding.count({
      where: {
        configuredByUserId: manifest.target.id,
      },
    }),
    dependencies.database.nativeOllamaBackendBinding.count({
      where: {
        configuredByUserId: manifest.target.id,
      },
    }),
    dependencies.database.mailboxAccount.count({
      where: { userId: manifest.target.id },
    }),
    dependencies.database.session.count({
      where: { userId: manifest.target.id },
    }),
    dependencies.database.emailVerificationCode.count({
      where: { userId: manifest.target.id },
    }),
    dependencies.database.twoFactorChallenge.count({
      where: { userId: manifest.target.id },
    }),
    dependencies.database.passwordResetToken.count({
      where: { userId: manifest.target.id },
    }),
  ]);
  if (ollamaAttributions !== 0 || nativeOllamaAttributions !== 0) {
    fail('Provider configuration attribution remains bound to the retired user');
  }
  if (mailboxRows !== 0) fail('Mailbox desired-state rows remain after external deletion');
  if (
    authSessions !== 0
    || emailCodes !== 0
    || twoFactorChallenges !== 0
    || passwordResetTokens !== 0
  ) {
    fail('Authentication state remains after admission closure');
  }
  await context.renewLease();
  return {
    evidenceDigest: digestAdminUserRetirementSnapshot({
      contract: 'admin-user-external-absence-v1',
      targetUserId: manifest.target.id,
      managedPaths: digestAdminUserRetirementManagedPathAbsence(
        manifest.localTargets.managedPaths,
      ),
      nativeSessions: manifest.localTargets.nativeSessions.map((session) => ({
        provider: session.provider,
        sessionId: session.sessionId,
        absent: true,
      })),
      agentSessions: manifest.agentSessions.map((session) => ({
        provider: session.provider,
        externalId: session.externalId,
        absent: true,
      })),
      mailboxes: manifest.mailboxes.usernames.map((username) => ({
        username,
        absent: true,
      })),
      appIds: manifest.apps.map((app) => app.id),
      agentJobIds: manifest.agentJobs.map((job) => job.id),
      providerAttributionsCleared: true,
    }),
  };
}
