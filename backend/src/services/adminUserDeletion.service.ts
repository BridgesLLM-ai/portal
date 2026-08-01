import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { stopApp } from './app-process.service';
import { deleteUserMailboxByUserId } from './userMailService';
import { AVATARS_DIR } from './imageAssets';
import { deleteSession, gatewayRpcCall } from '../utils/openclawGatewayRpc';

const PORTAL_DATA_ROOT = process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal';
const PROJECTS_ROOT = path.resolve(process.env.PORTAL_PROJECTS_ROOT || path.join(PORTAL_DATA_ROOT, 'projects'));
const UPLOADS_ROOT = path.resolve(process.env.PORTAL_FILES_ROOT || '/var/portal-files');
const APP_SOURCE_ROOT = path.resolve(process.env.PORTAL_APPS_ROOT || path.join(PORTAL_DATA_ROOT, 'apps'));
const DEPLOY_ROOT = path.resolve(process.env.APPS_ROOT || '/var/www/bridgesllm-apps');
const OPENCLAW_ROOT = path.join(process.env.HOME || '/root', '.openclaw');
const OPENCLAW_AGENTS_ROOT = path.join(OPENCLAW_ROOT, 'agents');
const OPENCLAW_SANDBOXES_ROOT = path.join(OPENCLAW_ROOT, 'sandboxes');
const NATIVE_SESSIONS_ROOT = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR
  ? path.resolve(process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR)
  : path.join(OPENCLAW_ROOT, 'portal-native-agent-sessions');
const AGENT_JOBS_ROOT = path.resolve(
  process.env.PORTAL_AGENT_JOBS_ROOT
    || path.join(process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', '.data', 'jobs'),
);
const IMAGE_EXTS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp']);
const NATIVE_PROVIDERS = ['claude_code', 'codex', 'grok', 'gemini', 'ollama', 'agent_zero'] as const;
const LEGACY_PORTAL_AGENT_DIRS = ['portal', 'portal-opus', 'portal-sonnet', 'portal-haiku'] as const;

export type UserDeletionCleanupFailure = {
  step: string;
  target: string;
  error: string;
  blocking: boolean;
};

export type UserDeletionCleanupResult = {
  failures: UserDeletionCleanupFailure[];
  summary: Record<string, number>;
};

export type UserDeletionCleanupPlan = {
  user: { id: string; username: string | null; avatarPath: string | null };
  apps: Array<{ id: string; name: string; zipPath: string }>;
  mailboxUsernames: string[];
  agentJobTranscriptPaths: string[];
};

export const ADMIN_USER_DELETION_RETIREMENT_CODE = 'ADMIN_USER_DELETION_RETIREMENT_PENDING';
export const ADMIN_USER_DELETION_RETIREMENT_MESSAGE =
  'Admin user deletion is unavailable while Portal 4 identity-aware user retirement is pending.';

export class AdminUserDeletionRetirementPendingError extends Error {
  readonly code = ADMIN_USER_DELETION_RETIREMENT_CODE;

  constructor() {
    super(ADMIN_USER_DELETION_RETIREMENT_MESSAGE);
    this.name = 'AdminUserDeletionRetirementPendingError';
  }
}

function safeRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function assertPathInside(baseDir: string, targetPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  throw new Error(`Refusing path outside base: ${resolvedTarget} (base ${resolvedBase})`);
}

function assertExistingPathInside(baseDir: string, targetPath: string): string {
  const resolved = assertPathInside(baseDir, targetPath);
  const real = safeRealpath(resolved);
  if (!real) return resolved;
  return assertPathInside(baseDir, real);
}

function removeDirectoryIfPresent(baseDir: string, targetPath: string): boolean {
  const resolved = assertExistingPathInside(baseDir, targetPath);
  if (resolved === path.resolve(baseDir)) {
    throw new Error(`Refusing to remove managed root: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) return false;
  if (!fs.lstatSync(resolved).isDirectory()) {
    throw new Error(`Expected directory, got non-directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return true;
}

function removeFileIfPresent(baseDir: string, targetPath: string): boolean {
  const resolved = assertExistingPathInside(baseDir, targetPath);
  if (resolved === path.resolve(baseDir)) {
    throw new Error(`Refusing to remove managed root: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) return false;
  if (!fs.lstatSync(resolved).isFile()) {
    throw new Error(`Expected file, got non-file: ${resolved}`);
  }
  fs.unlinkSync(resolved);
  return true;
}

function managedRootForPath(targetPath: string, roots: string[]): string {
  const resolvedTarget = path.resolve(targetPath);
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return resolvedRoot;
    }
  }
  throw new Error(`Refusing app path outside managed roots: ${resolvedTarget}`);
}

function recordFailure(result: UserDeletionCleanupResult, step: string, target: string, error: unknown, blocking = false) {
  const message = error instanceof Error ? error.message : String(error);
  result.failures.push({ step, target, error: message, blocking });
  console.error(`[admin-user-delete] ${step} failed for ${target}: ${message}`);
}

async function bestEffort(result: UserDeletionCleanupResult, step: string, target: string, fn: () => Promise<void> | void) {
  try {
    await fn();
  } catch (error) {
    recordFailure(result, step, target, error, false);
  }
}

async function stopAndDeleteApps(
  userId: string,
  apps: UserDeletionCleanupPlan['apps'],
  result: UserDeletionCleanupResult,
): Promise<void> {
  for (const app of apps) {
    const deployId = `${userId}-${app.name}`;
    await bestEffort(result, 'stop-app', deployId, async () => {
      await stopApp(deployId);
      result.summary.stoppedApps += 1;
    });

    await bestEffort(result, 'remove-app-deploy', deployId, () => {
      const removed = removeDirectoryIfPresent(DEPLOY_ROOT, path.join(DEPLOY_ROOT, deployId));
      if (removed) result.summary.deletedAppDeployDirs += 1;
    });

    await bestEffort(result, 'remove-app-source', app.zipPath, () => {
      const managedRoot = managedRootForPath(app.zipPath, [APP_SOURCE_ROOT, DEPLOY_ROOT]);
      const removed = removeDirectoryIfPresent(managedRoot, app.zipPath);
      if (removed) result.summary.deletedAppSourceDirs += 1;
    });
  }
}

function pruneSessionRegistryEntry(sessionsDir: string, sessionKey: string): boolean {
  const sessionsFile = path.join(sessionsDir, 'sessions.json');
  if (!fs.existsSync(sessionsFile)) return false;

  const resolvedFile = assertExistingPathInside(sessionsDir, sessionsFile);
  const raw = JSON.parse(fs.readFileSync(resolvedFile, 'utf-8'));
  const sessions = raw?.sessions || raw;
  let changed = false;
  let sessionFileId: string | null = null;

  if (Array.isArray(sessions)) {
    const filtered = sessions.filter((entry: any) => {
      const match = entry?.key === sessionKey || entry?.id === sessionKey;
      if (match) {
        sessionFileId = entry?.sessionId || entry?.id || null;
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) {
      if (raw?.sessions && Array.isArray(raw.sessions)) {
        raw.sessions = filtered;
      } else if (Array.isArray(raw)) {
        raw.length = 0;
        raw.push(...filtered);
      }
    }
  } else if (sessions && typeof sessions === 'object') {
    const entry = sessions[sessionKey];
    if (entry) {
      sessionFileId = entry?.sessionId || entry?.id || null;
      delete sessions[sessionKey];
      changed = true;
    }
  }

  const jsonlCandidates = [
    sessionFileId ? path.join(sessionsDir, `${sessionFileId}.jsonl`) : null,
    path.join(sessionsDir, `${sessionKey}.jsonl`),
  ].filter((value): value is string => Boolean(value));

  for (const jsonlPath of jsonlCandidates) {
    if (fs.existsSync(jsonlPath)) {
      removeFileIfPresent(sessionsDir, jsonlPath);
    }
  }

  if (changed) {
    fs.writeFileSync(resolvedFile, JSON.stringify(raw, null, 2), 'utf-8');
  }

  return changed;
}

async function cleanupProjectArtifacts(userId: string, result: UserDeletionCleanupResult): Promise<void> {
  const userProjectsDir = path.join(PROJECTS_ROOT, userId);
  if (!fs.existsSync(userProjectsDir)) return;

  const entries = fs.readdirSync(userProjectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectName = entry.name;
    const normalizedName = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const sessionId = `portal-${userId}-${normalizedName}`;
    const projectAgentId = `portal-${userId.slice(0, 8)}-${normalizedName}`.slice(0, 64);
    const sessionKeys = [
      `agent:${projectAgentId}:${sessionId}`,
      `agent:portal:${sessionId}`,
      ...Array.from({ length: 10 }, (_, index) => `agent:portal:${sessionId}-v${index + 1}`),
    ];

    for (const sessionKey of sessionKeys) {
      await bestEffort(result, 'delete-gateway-session', sessionKey, async () => {
        const deletion = await deleteSession(sessionKey);
        if (!deletion.ok) throw new Error(deletion.error || 'sessions.delete failed');
        result.summary.deletedGatewaySessions += 1;
      });

      await bestEffort(result, 'prune-gateway-session-artifacts', sessionKey, () => {
        for (const legacyAgentDir of [projectAgentId, ...LEGACY_PORTAL_AGENT_DIRS]) {
          const sessionsDir = path.join(OPENCLAW_AGENTS_ROOT, legacyAgentDir, 'sessions');
          if (!fs.existsSync(sessionsDir)) continue;
          const changed = pruneSessionRegistryEntry(sessionsDir, sessionKey);
          if (changed) result.summary.prunedGatewaySessionArtifacts += 1;
        }
      });
    }

    await bestEffort(result, 'remove-project-agent-config', projectAgentId, async () => {
      const cfg = await gatewayRpcCall('config.get', {});
      if (!cfg.ok) throw new Error(cfg.error || 'config.get failed');
      const config = cfg.data?.config || cfg.data?.parsed || {};
      const agents: any[] = Array.isArray(config?.agents?.list) ? config.agents.list : [];
      if (!agents.some((agent) => agent?.id === projectAgentId)) return;
      const updatedAgents = agents.filter((agent) => agent?.id !== projectAgentId);
      const patch = await gatewayRpcCall('config.patch', {
        raw: JSON.stringify({ agents: { list: updatedAgents } }),
        baseHash: cfg.data?.hash || '',
      }, 15000);
      if (!patch.ok) throw new Error(patch.error || 'config.patch failed');
      result.summary.deletedProjectAgentConfigs += 1;
    });

    await bestEffort(result, 'remove-project-agent-sandbox', projectAgentId, () => {
      const removed = removeDirectoryIfPresent(OPENCLAW_SANDBOXES_ROOT, path.join(OPENCLAW_SANDBOXES_ROOT, `${projectAgentId}-workspace`));
      if (removed) result.summary.deletedSandboxWorkspaces += 1;
    });

    await bestEffort(result, 'remove-project-agent-sessions-dir', projectAgentId, () => {
      const removed = removeDirectoryIfPresent(OPENCLAW_AGENTS_ROOT, path.join(OPENCLAW_AGENTS_ROOT, projectAgentId));
      if (removed) result.summary.deletedAgentSessionDirs += 1;
    });
  }

  await bestEffort(result, 'remove-projects-root', userProjectsDir, () => {
    const removed = removeDirectoryIfPresent(PROJECTS_ROOT, userProjectsDir);
    if (removed) result.summary.deletedProjectRoots += 1;
  });
}

function listLegacyUploadDirs(userId: string): string[] {
  const candidates = [
    path.join(UPLOADS_ROOT, userId),
    path.join(UPLOADS_ROOT, `user_${userId}`),
    path.join(UPLOADS_ROOT, `user-${userId}`),
    path.join(UPLOADS_ROOT, `${userId}`),
  ];
  return [...new Set(candidates)];
}

async function cleanupUploads(userId: string, result: UserDeletionCleanupResult): Promise<void> {
  const primaryDir = path.join(UPLOADS_ROOT, `user-${userId}`);
  await bestEffort(result, 'remove-upload-dir', primaryDir, () => {
    const removed = removeDirectoryIfPresent(UPLOADS_ROOT, primaryDir);
    if (removed) result.summary.deletedUploadDirs += 1;
  });

  for (const legacyDir of listLegacyUploadDirs(userId)) {
    if (legacyDir === primaryDir) continue;
    await bestEffort(result, 'remove-legacy-upload-dir', legacyDir, () => {
      const removed = removeDirectoryIfPresent(UPLOADS_ROOT, legacyDir);
      if (removed) result.summary.deletedLegacyUploadDirs += 1;
    });
  }
}

async function cleanupAvatar(avatarPath: string | null | undefined, result: UserDeletionCleanupResult): Promise<void> {
  if (!avatarPath) return;
  await bestEffort(result, 'remove-avatar-file', avatarPath, () => {
    const fileName = path.basename(avatarPath);
    if (fileName !== avatarPath) {
      throw new Error(`Avatar path must be a basename, got ${avatarPath}`);
    }
    const ext = path.extname(fileName).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      throw new Error(`Avatar extension not allowed: ${avatarPath}`);
    }
    const removed = removeFileIfPresent(AVATARS_DIR, path.join(AVATARS_DIR, fileName));
    if (removed) result.summary.deletedAvatarFiles += 1;
  });
}

async function cleanupMailboxes(
  userId: string,
  mailboxUsernames: string[],
  result: UserDeletionCleanupResult,
): Promise<void> {
  for (const mailboxUsername of mailboxUsernames) {
    await bestEffort(result, 'delete-mailbox', mailboxUsername, async () => {
      await deleteUserMailboxByUserId(mailboxUsername, userId);
      result.summary.deletedMailboxes += 1;
    });
  }
}

async function cleanupNativeSessions(userId: string, result: UserDeletionCleanupResult): Promise<void> {
  for (const provider of NATIVE_PROVIDERS) {
    const providerDir = path.join(NATIVE_SESSIONS_ROOT, provider);
    if (!fs.existsSync(providerDir)) continue;
    for (const entry of fs.readdirSync(providerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const sessionId = entry.name.slice(0, -5);
      if (!sessionId.startsWith(`${provider}-${userId}-`)) continue;
      await bestEffort(result, 'remove-native-session-file', sessionId, () => {
        const removed = removeFileIfPresent(providerDir, path.join(providerDir, entry.name));
        if (removed) result.summary.deletedNativeSessionFiles += 1;
      });
    }
  }
}

async function cleanupAgentJobArtifacts(
  transcriptPaths: string[],
  result: UserDeletionCleanupResult,
): Promise<void> {
  for (const transcriptPath of transcriptPaths) {
    if (!transcriptPath) continue;
    await bestEffort(result, 'remove-agent-job-transcript', transcriptPath, () => {
      const removed = removeFileIfPresent(AGENT_JOBS_ROOT, transcriptPath);
      if (removed) result.summary.deletedAgentJobTranscripts += 1;
    });
  }
}

function createCleanupResult(): UserDeletionCleanupResult {
  return {
    failures: [],
    summary: {
      stoppedApps: 0,
      deletedAppDeployDirs: 0,
      deletedAppSourceDirs: 0,
      deletedGatewaySessions: 0,
      prunedGatewaySessionArtifacts: 0,
      deletedProjectAgentConfigs: 0,
      deletedSandboxWorkspaces: 0,
      deletedAgentSessionDirs: 0,
      deletedProjectRoots: 0,
      deletedUploadDirs: 0,
      deletedLegacyUploadDirs: 0,
      deletedAvatarFiles: 0,
      deletedMailboxes: 0,
      deletedNativeSessionFiles: 0,
      deletedAgentJobTranscripts: 0,
    },
  };
}

export async function prepareUserDeletionCleanup(userId: string): Promise<UserDeletionCleanupPlan> {
  const [user, apps, mailboxes, jobs] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, avatarPath: true },
    }),
    prisma.app.findMany({
      where: { userId },
      select: { id: true, name: true, zipPath: true },
    }),
    prisma.mailboxAccount.findMany({
      where: { userId },
      select: { username: true },
    }),
    prisma.agentJob.findMany({
      where: { userId },
      select: { transcriptPath: true },
    }),
  ]);
  if (!user) throw new Error('User not found');

  // Validate every database-controlled deletion path before the user row is
  // committed. Cleanup happens afterward, but an unsafe/tampered target must
  // block the operation before either database or filesystem state changes.
  for (const app of apps) {
    managedRootForPath(app.zipPath, [APP_SOURCE_ROOT, DEPLOY_ROOT]);
    managedRootForPath(path.join(DEPLOY_ROOT, `${userId}-${app.name}`), [DEPLOY_ROOT]);
  }
  if (user.avatarPath) {
    if (path.basename(user.avatarPath) !== user.avatarPath || !IMAGE_EXTS.has(path.extname(user.avatarPath).toLowerCase())) {
      throw new Error(`Unsafe avatar path for user deletion: ${user.avatarPath}`);
    }
  }
  assertPathInside(PROJECTS_ROOT, path.join(PROJECTS_ROOT, userId));
  assertPathInside(UPLOADS_ROOT, path.join(UPLOADS_ROOT, `user-${userId}`));

  const mailboxUsernames = new Set<string>();
  if (user.username?.trim()) mailboxUsernames.add(user.username.trim().toLowerCase());
  for (const mailbox of mailboxes) {
    if (mailbox.username?.trim()) mailboxUsernames.add(mailbox.username.trim().toLowerCase());
  }

  return {
    user,
    apps,
    mailboxUsernames: [...mailboxUsernames],
    agentJobTranscriptPaths: jobs
      .map((job) => job.transcriptPath)
      .filter((value): value is string => Boolean(value)),
  };
}

export async function cleanupUserAfterDelete(plan: UserDeletionCleanupPlan): Promise<UserDeletionCleanupResult> {
  const { user } = plan;
  const result = createCleanupResult();

  await stopAndDeleteApps(user.id, plan.apps, result);
  await cleanupProjectArtifacts(user.id, result);
  await cleanupUploads(user.id, result);
  await cleanupAvatar(user.avatarPath, result);
  await cleanupMailboxes(user.id, plan.mailboxUsernames, result);
  await cleanupNativeSessions(user.id, result);
  await cleanupAgentJobArtifacts(plan.agentJobTranscriptPaths, result);

  return result;
}

export async function deleteUserDataWithCleanup(
  _userId: string,
  _commitDatabaseDeletion: () => Promise<void>,
): Promise<UserDeletionCleanupResult> {
  // Owner and actor identities both own UUID-derived external state. Keep the
  // legacy orchestration entry point terminally disabled so a future route
  // re-import cannot silently restore cascade-based deletion.
  throw new AdminUserDeletionRetirementPendingError();
}
