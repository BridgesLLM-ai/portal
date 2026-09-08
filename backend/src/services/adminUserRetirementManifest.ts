import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Prisma } from '@prisma/client';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import {
  listNativeUserSessions,
  type NativeSessionData,
} from '../agents/providers/NativeSessionStore';
import { prisma } from '../config/database';
import { AGENT_JOBS_DIR } from './agentJobs';
import {
  ADMIN_USER_RETIREMENT_CONTRACT_VERSION,
  AdminUserRetirementIntegrityError,
  type AdminUserRetirementManifestV1,
  validateAdminUserRetirementManifest,
} from './adminUserRetirementLedger';
import {
  captureAdminUserRetirementManagedPath,
  type AdminUserRetirementManagedPath,
  type AdminUserRetirementManagedPathKind,
} from './adminUserRetirementManagedPath';
import { AVATARS_DIR } from './imageAssets';
import {
  readGatewaySessionIdentityStrict,
} from '../utils/openclawGatewayRpc';
import {
  attestOpenClawRetirementRuntimeFamily,
  buildOpenClawRetirementIdentityAttestation,
  captureLegacyOpenClawSessionPrivacyTarget,
  type LegacyOpenClawSessionPrivacyTarget,
  type OpenClawRetirementRuntimeFamily,
} from './openClawLegacySessionPrivacy';

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

export type AdminUserRetirementManifestRoots = {
  projectsRoot: string;
  uploadsRoot: string;
  mediaMirrorRoot: string;
  appSourceRoot: string;
  deployRoot: string;
  jobsRoot: string;
  avatarsRoot: string;
};

type ManifestDatabase = typeof prisma | Prisma.TransactionClient;
const USER_AVATAR_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

export type AdminUserRetirementManifestDependencies = {
  database?: ManifestDatabase;
  roots?: Partial<AdminUserRetirementManifestRoots>;
  listNativeSessions?(
    provider: AgentProviderName,
    userId: string,
  ): NativeSessionData[];
  captureManagedPath?(input: {
    targetUserId: string;
    managedRoot: string;
    targetPath: string;
    kind: AdminUserRetirementManagedPathKind;
  }): AdminUserRetirementManagedPath;
  readLocalOpenClawSession?(
    sessionKey: string,
  ): ReturnType<typeof readGatewaySessionIdentityStrict>;
  attestOpenClawRuntimeFamily?(): Promise<OpenClawRetirementRuntimeFamily>;
  captureLegacyOpenClawSession?(input: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
  }): LegacyOpenClawSessionPrivacyTarget;
};

function fail(message: string): never {
  throw new AdminUserRetirementIntegrityError(message);
}

function normalizedAbsolute(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (
    !normalized
    || !path.isAbsolute(normalized)
    || path.resolve(normalized) !== normalized
    || normalized.length > 4096
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(`${label} is not an absolute normalized path`);
  }
  return normalized;
}

function strictDescendant(root: string, target: string, label: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} escapes or equals its managed root`);
  }
  return relative;
}

function defaultMediaMirrorRoot(): string {
  const candidates = [
    process.env.OPENCLAW_STATE_DIR?.trim(),
    path.join(os.homedir(), '.openclaw'),
    '/root/.openclaw',
  ].filter((value): value is string => Boolean(value && value.trim()));
  const stateRoot = candidates.find((candidate) => fs.existsSync(path.resolve(candidate)))
    || path.join(os.homedir(), '.openclaw');
  return path.join(path.resolve(stateRoot), 'media', 'portal-files');
}

export function resolveAdminUserRetirementManifestRoots(
  overrides: Partial<AdminUserRetirementManifestRoots> = {},
): AdminUserRetirementManifestRoots {
  const portalDataRoot = path.resolve(
    process.env.PORTAL_DATA_ROOT
    || process.env.PORTAL_ROOT
    || '/portal',
  );
  const values: AdminUserRetirementManifestRoots = {
    projectsRoot: overrides.projectsRoot
      || process.env.PORTAL_PROJECTS_ROOT
      || path.join(portalDataRoot, 'projects'),
    uploadsRoot: overrides.uploadsRoot
      || process.env.PORTAL_FILES_ROOT
      || '/var/portal-files',
    mediaMirrorRoot: overrides.mediaMirrorRoot
      || process.env.PORTAL_OPENCLAW_MEDIA_MIRROR_ROOT
      || defaultMediaMirrorRoot(),
    appSourceRoot: overrides.appSourceRoot
      || process.env.PORTAL_APPS_ROOT
      || path.join(portalDataRoot, 'apps'),
    deployRoot: overrides.deployRoot
      || process.env.APPS_ROOT
      || '/var/www/bridgesllm-apps',
    jobsRoot: overrides.jobsRoot || AGENT_JOBS_DIR,
    avatarsRoot: overrides.avatarsRoot || AVATARS_DIR,
  };
  return Object.freeze(Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      normalizedAbsolute(path.resolve(value), `Retirement ${key}`),
    ]),
  ) as AdminUserRetirementManifestRoots);
}

function canonicalSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 32) fail('Retirement snapshot nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('Retirement snapshot contains a non-integer number');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalSnapshot(entry, depth + 1));
  if (!value || typeof value !== 'object') fail('Retirement snapshot contains a non-JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('Retirement snapshot contains a non-plain object');
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) fail('Retirement snapshot contains undefined');
    result[key] = canonicalSnapshot(child, depth + 1);
  }
  return result;
}

export function digestAdminUserRetirementSnapshot(value: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalSnapshot(value)))
    .digest('hex');
}

function uniqueSorted(values: readonly (string | null | undefined)[]): string[] {
  return Array.from(new Set(
    values.map((value) => String(value || '').trim()).filter(Boolean),
  )).sort();
}

function assertProjectRootSnapshot(input: {
  project: {
    id: string;
    canonicalRoot: string;
    rootDevice: string;
    rootInode: string;
    rootBirthtimeNs: string;
  };
  projectsRoot: string;
  targetUserId: string;
}): boolean {
  const canonicalRoot = normalizedAbsolute(input.project.canonicalRoot, 'Project canonical root');
  strictDescendant(input.projectsRoot, canonicalRoot, 'Project canonical root');
  const expectedOwnerRoot = path.join(input.projectsRoot, input.targetUserId);
  strictDescendant(expectedOwnerRoot, canonicalRoot, 'Project canonical root');
  if (path.dirname(canonicalRoot) !== expectedOwnerRoot) {
    fail(`Project ${input.project.id} root is not a direct child of its Owner container`);
  }
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(canonicalRoot, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev.toString() !== input.project.rootDevice
    || stat.ino.toString() !== input.project.rootInode
    || stat.birthtimeNs.toString() !== input.project.rootBirthtimeNs
    || fs.realpathSync(canonicalRoot) !== canonicalRoot
  ) {
    fail(`Project ${input.project.id} root identity changed before retirement manifest`);
  }
  return true;
}

function assertProjectOwnerContainerInventory(input: {
  projectsRoot: string;
  targetUserId: string;
  projects: readonly {
    id: string;
    canonicalRoot: string;
    rootPresent: boolean;
  }[];
}): void {
  const ownerRoot = path.join(input.projectsRoot, input.targetUserId);
  let ownerStat: fs.BigIntStats;
  try {
    ownerStat = fs.lstatSync(ownerRoot, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      if (input.projects.some((project) => project.rootPresent)) {
        fail('A manifested Project root exists without its Owner container');
      }
      return;
    }
    throw error;
  }
  if (
    !ownerStat.isDirectory()
    || ownerStat.isSymbolicLink()
    || fs.realpathSync(ownerRoot) !== ownerRoot
  ) {
    fail('Project Owner container is unsafe');
  }
  const expected = input.projects
    .filter((project) => project.rootPresent)
    .map((project) => path.basename(project.canonicalRoot))
    .sort();
  const actual = fs.readdirSync(ownerRoot).sort();
  if (
    actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])
  ) {
    fail('Project Owner container contains state outside the immutable Project inventory');
  }
}

function nativeSessionManifestEntry(session: NativeSessionData) {
  const executionScope = session.executionContext?.scope || 'UNBOUND';
  const projectIdentityId = session.executionContext?.scope === 'PROJECT_SANDBOX'
    ? session.executionContext.projectId
    : null;
  return Object.freeze({
    provider: session.provider,
    sessionId: session.sessionId,
    identityDigest: digestAdminUserRetirementSnapshot({
      sessionId: session.sessionId,
      provider: session.provider,
      userId: session.userId,
      executionContext: session.executionContext || null,
    }),
    executionScope,
    projectIdentityId,
  });
}

function managedRootForTarget(
  targetPath: string,
  candidates: readonly string[],
  label: string,
): string {
  const target = normalizedAbsolute(targetPath, label);
  const matches = candidates.filter((root) => {
    const relative = path.relative(root, target);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (matches.length !== 1) fail(`${label} is outside or ambiguous across managed roots`);
  return matches[0];
}

/**
 * Builds a closed, secret-free identity inventory. This function does not by
 * itself close request admission. The production retirement runner binds the
 * persisted snapshot and its digest to the dedicated authorization transition
 * before any destructive adapter is allowed to run.
 */
export async function buildAdminUserRetirementManifestSnapshot(
  targetUserId: string,
  requestedByUserId: string,
  dependencies: AdminUserRetirementManifestDependencies = {},
): Promise<AdminUserRetirementManifestV1> {
  const database = dependencies.database || prisma;
  const roots = resolveAdminUserRetirementManifestRoots(dependencies.roots);
  const listNativeSessions = dependencies.listNativeSessions || listNativeUserSessions;
  const captureManagedPath = dependencies.captureManagedPath
    || captureAdminUserRetirementManagedPath;
  const readLocalOpenClawSession = dependencies.readLocalOpenClawSession
    || readGatewaySessionIdentityStrict;
  const attestOpenClawRuntimeFamily = dependencies.attestOpenClawRuntimeFamily
    || attestOpenClawRetirementRuntimeFamily;
  const captureLegacyOpenClawSession = dependencies.captureLegacyOpenClawSession
    || captureLegacyOpenClawSessionPrivacyTarget;
  let openClawRuntimeFamilyPromise: Promise<OpenClawRetirementRuntimeFamily> | null = null;
  const readOpenClawRuntimeFamily = () => {
    openClawRuntimeFamilyPromise ||= attestOpenClawRuntimeFamily();
    return openClawRuntimeFamilyPromise;
  };
  const targetId = String(targetUserId || '').trim();
  const requesterId = String(requestedByUserId || '').trim();
  if (!targetId || !requesterId || targetId === requesterId) {
    fail('Retirement target and requester identities are invalid');
  }

  const [
    target,
    requester,
    ownedProjects,
    apps,
    files,
    agentJobs,
    agentSessions,
    sessions,
    emailVerificationCodes,
    twoFactorChallenges,
    passwordResetTokens,
    mailboxes,
    ollamaBindings,
    nativeOllamaBindings,
    chatStates,
    chatTurns,
    resetJournals,
    providerBindings,
    providerSessions,
    messages,
    legacyImports,
    legacyQuarantines,
    legacyClearTombstones,
    completeRepairReceipts,
    cleanupActors,
  ] = await Promise.all([
    database.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        authorizationVersion: true,
        avatarPath: true,
        mailPassword: true,
      },
    }),
    database.user.findUnique({
      where: { id: requesterId },
      select: { id: true, role: true },
    }),
    database.projectIdentity.findMany({
      where: { workspaceOwnerId: targetId },
      orderBy: { id: 'asc' },
    }),
    database.app.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      include: {
        shareLinks: {
          orderBy: { id: 'asc' },
          select: { id: true, userId: true, token: true },
        },
      },
    }),
    database.file.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, path: true, cloudinaryId: true },
    }),
    database.agentJob.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, transcriptPath: true, metadata: true },
    }),
    database.agentSession.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, provider: true, externalId: true },
    }),
    database.session.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.emailVerificationCode.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.twoFactorChallenge.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.passwordResetToken.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.mailboxAccount.findMany({
      where: { userId: targetId },
      orderBy: { username: 'asc' },
      select: { username: true },
    }),
    database.ollamaBackendBinding.findMany({
      where: { configuredByUserId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.nativeOllamaBackendBinding.findMany({
      where: { configuredByUserId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }),
    database.projectChatState.findMany({
      where: { actorUserId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true },
    }),
    database.projectChatTurn.findMany({
      where: { actorUserId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true, providerSessionId: true },
    }),
    database.projectChatDestructiveResetJournal.findMany({
      where: { actorUserId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true, legacyProjectId: true },
    }),
    database.projectChatProviderBinding.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectId: true,
        sessionKey: true,
        externalSessionId: true,
      },
    }),
    database.projectChatSession.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, projectId: true, sessionKey: true },
    }),
    database.projectChatMessage.findMany({
      where: { userId: targetId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectId: true,
        sessionKey: true,
        providerSessionId: true,
      },
    }),
    database.legacyOpenClawProjectImport.findMany({
      where: { actorUserId: targetId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectIdentityId: true,
        sourceSessionKey: true,
        providerSessionId: true,
      },
    }),
    database.legacyOpenClawProjectQuarantine.findMany({
      where: { actorUserId: targetId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectIdentityId: true,
        originalProjectId: true,
        sessionKey: true,
        providerSessionId: true,
      },
    }),
    database.legacyOpenClawProjectClearTombstone.findMany({
      where: { actorUserId: targetId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true },
    }),
    database.projectDependencyRepairOperation.findMany({
      where: {
        actorUserId: targetId,
        status: 'APPLIED',
        phase: 'COMPLETE',
      },
      orderBy: { repairId: 'asc' },
      select: { repairId: true },
    }),
    database.projectRuntimeCleanupActor.findMany({
      where: { actorUserId: targetId },
      orderBy: [
        { projectIdentityId: 'asc' },
        { provider: 'asc' },
        { actorUserId: 'asc' },
        { sessionId: 'asc' },
      ],
      select: {
        projectIdentityId: true,
        provider: true,
        actorUserId: true,
        sessionId: true,
      },
    }),
  ]);

  if (!target) fail('User retirement target does not exist');
  if (!requester || String(requester.role) !== 'OWNER') {
    fail('User retirement requester is not the Owner');
  }
  if (String(target.role) === 'OWNER') fail('Owner accounts cannot be retired');

  const manifestProjects = ownedProjects.map((project) => {
    if (
      !['ACTIVE', 'DELETING'].includes(project.lifecycleStatus)
      || project.legacyOpenClawMigrationStatus !== 'CURRENT'
    ) {
      fail(`Project ${project.id} is not in a retirement-safe lifecycle state`);
    }
    return Object.freeze({
      id: project.id,
      projectName: project.projectName,
      canonicalRoot: normalizedAbsolute(project.canonicalRoot, 'Project canonical root'),
      generation: project.generation,
      lifecycleStatus: project.lifecycleStatus,
      rootDevice: project.rootDevice,
      rootInode: project.rootInode,
      rootBirthtimeNs: project.rootBirthtimeNs,
      rootPresent: assertProjectRootSnapshot({
        project,
        projectsRoot: roots.projectsRoot,
        targetUserId: targetId,
      }),
    });
  });
  assertProjectOwnerContainerInventory({
    projectsRoot: roots.projectsRoot,
    targetUserId: targetId,
    projects: manifestProjects,
  });
  const ownedProjectIds = new Set(manifestProjects.map((project) => project.id));
  const targetOwnedShareLinks = await database.appShareLink.findMany({
    where: { userId: targetId },
    orderBy: { id: 'asc' },
    select: { id: true, appId: true },
  });
  const appById = new Map(apps.map((app) => [app.id, app]));
  for (const share of targetOwnedShareLinks) {
    const app = appById.get(share.appId);
    if (!app || !app.shareLinks.some((candidate) => candidate.id === share.id)) {
      fail(`Share link ${share.id} is not bound to an App owned by the retirement target`);
    }
  }
  for (const app of apps) {
    if (app.shareLinks.some((share) => share.userId !== targetId)) {
      fail(`App ${app.id} has a share link owned by a different Portal user`);
    }
  }

  for (const file of files) {
    if (file.cloudinaryId) {
      fail(`File ${file.id} has an external Cloudinary identity without a qualified deletion adapter`);
    }
  }
  for (const app of apps) {
    if (
      app.projectIdentityId
      && !ownedProjectIds.has(app.projectIdentityId)
    ) {
      fail(`App ${app.id} belongs to a Project not owned by the retirement target`);
    }
    if (
      app.deployType === 'fullstack'
      && !app.projectIdentityId
    ) {
      fail(`App ${app.id} has no immutable Project runtime identity`);
    }
  }

  const weakProjectIds = uniqueSorted([
    ...providerBindings.map((entry) => entry.projectId),
    ...providerSessions.map((entry) => entry.projectId),
    ...messages.map((entry) => entry.projectId),
  ]);
  const weakImmutableProjects = weakProjectIds.length > 0
    ? await database.projectIdentity.findMany({
        where: { id: { in: weakProjectIds } },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    : [];
  const weakImmutableIds = new Set(weakImmutableProjects.map((entry) => entry.id));

  const managedTargets = new Map<string, {
    root: string;
    path: string;
    kind: AdminUserRetirementManagedPathKind;
  }>();
  const addManagedTarget = (
    root: string,
    targetPath: string,
    kind: AdminUserRetirementManagedPathKind,
  ) => {
    const normalizedRoot = normalizedAbsolute(root, 'Managed retirement root');
    const normalizedTarget = normalizedAbsolute(targetPath, 'Managed retirement target');
    strictDescendant(normalizedRoot, normalizedTarget, 'Managed retirement target');
    const existing = managedTargets.get(normalizedTarget);
    if (existing && (existing.root !== normalizedRoot || existing.kind !== kind)) {
      fail(`Managed retirement target ${normalizedTarget} has conflicting authority`);
    }
    managedTargets.set(normalizedTarget, { root: normalizedRoot, path: normalizedTarget, kind });
  };

  addManagedTarget(
    roots.projectsRoot,
    path.join(roots.projectsRoot, targetId),
    'CONTAINER_DIRECTORY',
  );
  for (const candidate of [
    path.join(roots.uploadsRoot, targetId),
    path.join(roots.uploadsRoot, `user_${targetId}`),
    path.join(roots.uploadsRoot, `user-${targetId}`),
  ]) {
    addManagedTarget(roots.uploadsRoot, candidate, 'DIRECTORY');
  }
  addManagedTarget(
    roots.mediaMirrorRoot,
    path.join(roots.mediaMirrorRoot, `user-${targetId}`),
    'DIRECTORY',
  );

  const avatarBasenames = new Set<string>();
  if (target.avatarPath) {
    if (
      path.basename(target.avatarPath) !== target.avatarPath
      || !/^[A-Za-z0-9._-]{1,255}$/.test(target.avatarPath)
    ) {
      fail('User avatar target is not a safe basename');
    }
    avatarBasenames.add(target.avatarPath);
  }
  // A failed historical avatar DB update can leave a basename variant that is
  // no longer referenced by User.avatarPath. Inventory every exact per-user
  // variant so retirement deletes and verifies residue, not only the current
  // pointer. Unrelated avatars and assistant/branding assets remain untouched.
  const expectedAvatarStem = `user-${targetId}`;
  for (const entry of fs.readdirSync(roots.avatarsRoot, { withFileTypes: true })) {
    if (
      entry.isFile()
      && path.parse(entry.name).name === expectedAvatarStem
      && USER_AVATAR_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      avatarBasenames.add(entry.name);
    }
  }
  for (const avatarBasename of [...avatarBasenames].sort()) {
    addManagedTarget(
      roots.avatarsRoot,
      path.join(roots.avatarsRoot, avatarBasename),
      'FILE',
    );
  }
  for (const job of agentJobs) {
    if (!job.transcriptPath) continue;
    const transcriptPath = normalizedAbsolute(job.transcriptPath, `Agent job ${job.id} transcript`);
    addManagedTarget(
      managedRootForTarget(transcriptPath, [roots.jobsRoot], `Agent job ${job.id} transcript`),
      transcriptPath,
      'FILE',
    );
  }
  for (const app of apps) {
    const sourcePath = normalizedAbsolute(app.zipPath, `App ${app.id} source`);
    const sourceRoot = managedRootForTarget(
      sourcePath,
      [roots.appSourceRoot, roots.deployRoot],
      `App ${app.id} source`,
    );
    addManagedTarget(sourceRoot, sourcePath, 'DIRECTORY');
    const deployPath = path.join(roots.deployRoot, `${targetId}-${app.name}`);
    addManagedTarget(roots.deployRoot, deployPath, 'DIRECTORY');
  }

  const managedPaths = Array.from(managedTargets.values())
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => captureManagedPath({
      targetUserId: targetId,
      managedRoot: entry.root,
      targetPath: entry.path,
      kind: entry.kind,
    }));
  const nativeSessions = NATIVE_SESSION_PROVIDERS
    .flatMap((provider) => listNativeSessions(provider, targetId))
    .map(nativeSessionManifestEntry)
    .sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || left.sessionId.localeCompare(right.sessionId)
    ));

  const projectIdentityIds = uniqueSorted([
    ...chatStates.map((entry) => entry.projectIdentityId),
    ...chatTurns.map((entry) => entry.projectIdentityId),
    ...resetJournals.map((entry) => entry.projectIdentityId),
    ...legacyImports.map((entry) => entry.projectIdentityId),
    ...legacyQuarantines.map((entry) => entry.projectIdentityId),
    ...legacyClearTombstones.map((entry) => entry.projectIdentityId),
    ...weakImmutableIds,
  ]);
  const legacyProjectIds = uniqueSorted([
    ...resetJournals.map((entry) => entry.legacyProjectId),
    ...providerBindings.map((entry) => (
      weakImmutableIds.has(entry.projectId) ? null : entry.projectId
    )),
    ...providerSessions.map((entry) => (
      weakImmutableIds.has(entry.projectId) ? null : entry.projectId
    )),
    ...messages.map((entry) => (
      weakImmutableIds.has(entry.projectId) ? null : entry.projectId
    )),
    ...legacyQuarantines.map((entry) => entry.originalProjectId),
  ]);

  const manifest: AdminUserRetirementManifestV1 = {
    version: ADMIN_USER_RETIREMENT_CONTRACT_VERSION,
    target: {
      id: target.id,
      role: String(target.role),
      authorizationVersion: target.authorizationVersion,
      emailDigest: digestAdminUserRetirementSnapshot(
        String(target.email).trim().toLowerCase(),
      ),
      username: target.username,
      avatarBasename: target.avatarPath || null,
    },
    requestedByUserId: requesterId,
    ownedProjects: manifestProjects,
    actorRuntimeState: {
      projectIdentityIds,
      legacyProjectIds,
      chatStateIds: chatStates.map((entry) => entry.id),
      turnIds: chatTurns.map((entry) => entry.id),
      resetJournalIds: resetJournals.map((entry) => entry.id),
      providerBindingIds: providerBindings.map((entry) => entry.id),
      providerSessionRowIds: providerSessions.map((entry) => entry.id),
      providerSessionIds: uniqueSorted([
        ...providerBindings.map((entry) => entry.externalSessionId),
        ...messages.map((entry) => entry.providerSessionId),
        ...chatTurns.map((entry) => entry.providerSessionId),
        ...legacyImports.map((entry) => entry.providerSessionId),
        ...legacyQuarantines.map((entry) => entry.providerSessionId),
      ]),
      gatewaySessionKeys: uniqueSorted([
        ...providerBindings.map((entry) => entry.sessionKey),
        ...providerSessions.map((entry) => entry.sessionKey),
        ...messages.map((entry) => entry.sessionKey),
        ...legacyImports.map((entry) => entry.sourceSessionKey),
        ...legacyQuarantines.map((entry) => entry.sessionKey),
      ]),
      messageIds: messages.map((entry) => entry.id),
      legacyImportIds: legacyImports.map((entry) => entry.id),
      legacyQuarantineIds: legacyQuarantines.map((entry) => entry.id),
      legacyClearTombstoneIds: legacyClearTombstones.map((entry) => entry.id),
    },
    dependencyEvidence: {
      completeRepairReceiptIds: completeRepairReceipts
        .map((entry) => entry.repairId)
        .sort((left, right) => left.localeCompare(right)),
      cleanupActors: cleanupActors.map((entry) => ({
        projectIdentityId: entry.projectIdentityId,
        provider: entry.provider,
        actorUserId: entry.actorUserId,
        sessionId: entry.sessionId,
      })).sort((left, right) => (
        left.projectIdentityId.localeCompare(right.projectIdentityId)
        || left.provider.localeCompare(right.provider)
        || left.actorUserId.localeCompare(right.actorUserId)
        || left.sessionId.localeCompare(right.sessionId)
      )),
    },
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      projectIdentityId: app.projectIdentityId,
      deployType: app.deployType,
      processStatus: app.processStatus,
      port: app.port,
      sourcePath: normalizedAbsolute(app.zipPath, `App ${app.id} source`),
      deployPath: path.join(roots.deployRoot, `${targetId}-${app.name}`),
      shareLinkIds: app.shareLinks.map((share) => share.id),
      shareTokenDigests: app.shareLinks.map((share) => (
        digestAdminUserRetirementSnapshot(share.token)
      )),
    })),
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      cloudinaryId: file.cloudinaryId,
    })),
    agentJobs: agentJobs.map((job) => ({
      id: job.id,
      status: String(job.status),
      transcriptPath: job.transcriptPath
        ? normalizedAbsolute(job.transcriptPath, `Agent job ${job.id} transcript`)
        : null,
      metadataDigest: digestAdminUserRetirementSnapshot(job.metadata || {}),
    })),
    agentSessions: await Promise.all(agentSessions.map(async (session) => {
      const provider = String(session.provider);
      const localIdentity = provider === 'OPENCLAW'
        ? await readLocalOpenClawSession(session.externalId)
        : null;
      if (provider === 'OPENCLAW' && (!localIdentity || !localIdentity.sessionId)) {
        fail(`OpenClaw session ${session.id} has no immutable local privacy identity`);
      }
      let localIdentityDigest: string | null = null;
      if (localIdentity?.sessionId) {
        const retirementIdentity = Object.freeze({
          agentId: localIdentity.agentId,
          sessionKey: localIdentity.sessionKey,
          sessionId: localIdentity.sessionId,
        });
        const family = await readOpenClawRuntimeFamily();
        const legacySessionFile = family === 'legacy-2026.7.1'
          ? captureLegacyOpenClawSession(retirementIdentity).sessionFile
          : undefined;
        localIdentityDigest = digestAdminUserRetirementSnapshot(
          buildOpenClawRetirementIdentityAttestation({
            identity: retirementIdentity,
            family,
            ...(legacySessionFile ? { legacySessionFile } : {}),
          }),
        );
      }
      return {
        id: session.id,
        provider,
        externalId: session.externalId,
        localAgentId: localIdentity?.agentId || null,
        localSessionId: localIdentity?.sessionId || null,
        localIdentityDigest,
      };
    })),
    authState: {
      sessionIds: sessions.map((entry) => entry.id),
      emailVerificationCodeIds: emailVerificationCodes.map((entry) => entry.id),
      twoFactorChallengeIds: twoFactorChallenges.map((entry) => entry.id),
      passwordResetTokenIds: passwordResetTokens.map((entry) => entry.id),
    },
    mailboxes: {
      usernames: uniqueSorted([
        ...mailboxes.map((mailbox) => mailbox.username),
        ...(target.mailPassword ? [target.username] : []),
      ]),
    },
    providerAttributions: {
      ollamaBindingIds: ollamaBindings.map((entry) => entry.id),
      nativeOllamaBindingIds: nativeOllamaBindings.map((entry) => entry.id),
    },
    localTargets: {
      managedPaths,
      nativeSessions,
    },
  };
  return validateAdminUserRetirementManifest(manifest);
}
