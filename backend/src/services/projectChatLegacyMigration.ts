import { prisma } from '../config/database';
import { LegacyOpenClawProjectMigrationActiveError } from './legacyOpenClawProjectRetirement';

type LegacyBinding = {
  id: string;
  provider: string;
  sessionKey: string | null;
  externalSessionId: string | null;
  model: string | null;
  status: string;
  lastActivity: Date;
};

interface LegacyMigrationTx {
  projectIdentity: {
    findUnique(args: unknown): Promise<{ legacyOpenClawMigrationStatus: string } | null>;
  };
  legacyOpenClawProjectMigrationLease: {
    findUnique(args: unknown): Promise<{ phase: string; leaseExpiresAt: Date } | null>;
  };
  projectChatProviderBinding: {
    findMany(args: unknown): Promise<LegacyBinding[]>;
    findUnique(args: unknown): Promise<(LegacyBinding & { projectId: string }) | null>;
    update(args: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  projectChatSession: { updateMany(args: unknown): Promise<unknown> };
  projectChatMessage: { updateMany(args: unknown): Promise<unknown> };
}

interface LegacyMigrationDatabase {
  $transaction<T>(
    callback: (tx: LegacyMigrationTx) => Promise<T>,
    options?: { isolationLevel?: 'Serializable'; maxWait?: number; timeout?: number },
  ): Promise<T>;
}

function requireId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('\0')) throw new Error(`${label} is required`);
  return normalized;
}

function legacy3OpenClawIdentity(
  actorUserId: string,
  storedSessionId: string,
): { sessionId: string; projectSessionKey: string; portalFallbackSessionKey: string } | null {
  const prefix = `portal-${actorUserId}-`;
  if (!storedSessionId.startsWith(prefix)) return null;
  const stableSlug = storedSessionId.slice(prefix.length);
  if (!/^[a-z0-9_-]{1,48}$/.test(stableSlug)) return null;
  const agentId = `portal-${actorUserId.slice(0, 8)}-${stableSlug}`.slice(0, 64);
  return {
    sessionId: storedSessionId,
    projectSessionKey: `agent:${agentId}:${storedSessionId}`,
    portalFallbackSessionKey: `agent:portal:${storedSessionId}`,
  };
}

/**
 * Turn actor/name-keyed 3.x database provenance into the only legacy
 * OpenClaw gateway identities that destructive reset may touch. Project files
 * are intentionally not trusted: old stable slugs were workspace-writable,
 * while these candidates come from actor-scoped Portal rows.
 */
export function attestLegacyOpenClawProjectSessionKeys(input: {
  actorUserId: string;
  storedSessionIds: readonly string[];
  storedBindingSessionKeys: readonly string[];
  exactServerOwnedSessionKeys: readonly string[];
  adapterOwnedSessionKeys?: readonly string[];
}): readonly string[] {
  const actorUserId = requireId(input.actorUserId, 'Project Chat actor');
  const exactServerOwned = new Set(
    input.exactServerOwnedSessionKeys.map((value) => requireId(value, 'OpenClaw session key')),
  );
  const adapterOwned = new Set(
    (input.adapterOwnedSessionKeys || []).map((value) => requireId(value, 'adapter-owned OpenClaw session key')),
  );
  const cleanupKeys = new Set<string>();
  const attestedLegacyKeys = new Set<string>();

  const addLegacyIdentity = (storedSessionId: string): boolean => {
    const identity = legacy3OpenClawIdentity(actorUserId, storedSessionId);
    if (!identity) return false;
    attestedLegacyKeys.add(identity.sessionId);
    attestedLegacyKeys.add(identity.projectSessionKey);
    attestedLegacyKeys.add(identity.portalFallbackSessionKey);
    cleanupKeys.add(identity.projectSessionKey);
    cleanupKeys.add(identity.portalFallbackSessionKey);
    return true;
  };

  for (const value of input.storedSessionIds) {
    const sessionId = requireId(value, 'Legacy OpenClaw session id');
    if (exactServerOwned.has(sessionId)) continue;
    if (!addLegacyIdentity(sessionId)) {
      throw new Error('Legacy OpenClaw session id did not match its authenticated 3.x actor identity');
    }
  }

  for (const value of input.storedBindingSessionKeys) {
    const candidate = requireId(value, 'Legacy OpenClaw binding session key');
    if (exactServerOwned.has(candidate) || attestedLegacyKeys.has(candidate)) continue;
    if (addLegacyIdentity(candidate)) continue;

    const projectMatch = /^agent:([^:]+):(.+)$/.exec(candidate);
    if (projectMatch) {
      const identity = legacy3OpenClawIdentity(actorUserId, projectMatch[2]);
      if (identity && candidate === identity.projectSessionKey) {
        addLegacyIdentity(identity.sessionId);
        continue;
      }
    }
    const portalMatch = /^agent:portal:(.+)$/.exec(candidate);
    if (portalMatch) {
      const identity = legacy3OpenClawIdentity(actorUserId, portalMatch[1]);
      if (identity && candidate === identity.portalFallbackSessionKey) {
        addLegacyIdentity(identity.sessionId);
        continue;
      }
    }
    throw new Error('Legacy OpenClaw binding session did not match its authenticated 3.x actor identity');
  }

  for (const exactKey of exactServerOwned) {
    if (!adapterOwned.has(exactKey)) cleanupKeys.add(exactKey);
  }
  for (const adapterKey of adapterOwned) cleanupKeys.delete(adapterKey);
  return Object.freeze(Array.from(cleanupKeys).sort());
}

/**
 * Move 3.x name-keyed Project Chat records into the 4.0 immutable project UUID
 * namespace. Migration is actor-bound: shared-workspace access never imports
 * the owner's transcript into the acting SUB_ADMIN's conversation.
 */
export async function migrateLegacyProjectChatState(input: {
  actorUserId: string;
  legacyProjectId: string;
  immutableProjectId: string;
}, database: LegacyMigrationDatabase = prisma as unknown as LegacyMigrationDatabase): Promise<void> {
  const actorUserId = requireId(input.actorUserId, 'Project Chat actor');
  const legacyProjectId = requireId(input.legacyProjectId, 'Legacy project id');
  const immutableProjectId = requireId(input.immutableProjectId, 'Immutable project id');
  if (legacyProjectId === immutableProjectId) return;

  await database.$transaction(async (tx) => {
    const identity = await tx.projectIdentity.findUnique({
      where: { id: immutableProjectId },
      select: { legacyOpenClawMigrationStatus: true },
    });
    if (!identity) throw new Error('Immutable Project identity is missing during legacy state migration');
    if (identity.legacyOpenClawMigrationStatus === 'CURRENT') {
      // A current Portal 4 identity is a distinct project instance even when a
      // deleted 3.x project once used the same display name. Never let opening
      // Project Chat adopt that older instance's bindings or sessions.
      return;
    }
    const lease = await tx.legacyOpenClawProjectMigrationLease.findUnique({
      where: { id: 'portal-3x-openclaw-project-import-v1' },
      select: { phase: true, leaseExpiresAt: true },
    });
    if (
      identity.legacyOpenClawMigrationStatus === 'PENDING'
      || lease?.phase === 'DISCOVERING'
    ) {
      throw new LegacyOpenClawProjectMigrationActiveError({
        retryable: identity.legacyOpenClawMigrationStatus === 'PENDING'
          || Boolean(lease && lease.leaseExpiresAt.getTime() > Date.now()),
      });
    }
    const legacyBindings = await tx.projectChatProviderBinding.findMany({
      where: { userId: actorUserId, projectId: legacyProjectId },
      orderBy: { lastActivity: 'asc' },
    });
    for (const legacy of legacyBindings) {
      const current = await tx.projectChatProviderBinding.findUnique({
        where: {
          userId_projectId_provider: {
            userId: actorUserId,
            projectId: immutableProjectId,
            provider: legacy.provider,
          },
        },
      });
      if (!current) {
        await tx.projectChatProviderBinding.update({
          where: { id: legacy.id },
          data: { projectId: immutableProjectId },
        });
        continue;
      }

      const legacyIsNewer = legacy.lastActivity.getTime() > current.lastActivity.getTime();
      await tx.projectChatProviderBinding.update({
        where: { id: current.id },
        data: {
          sessionKey: current.sessionKey || legacy.sessionKey,
          externalSessionId: current.externalSessionId || legacy.externalSessionId,
          model: current.model || legacy.model,
          ...(legacyIsNewer ? {
            status: legacy.status,
            lastActivity: legacy.lastActivity,
          } : {}),
        },
      });
      await tx.projectChatProviderBinding.delete({ where: { id: legacy.id } });
    }

    await tx.projectChatSession.updateMany({
      where: { userId: actorUserId, projectId: legacyProjectId },
      data: { projectId: immutableProjectId },
    });
    // Do not bulk-promote 3.x SQL message residue. In 3.26 the SQL write and
    // Gateway send failed independently, and Clear could delete the Gateway
    // session without leaving a trustworthy SQL tombstone. Startup's bounded
    // transcript importer moves only rows matched to a complete canonical
    // Gateway snapshot and quarantines the remainder. Bulk-moving name-keyed
    // rows here would resurrect explicitly cleared or never-sent private text.
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 15_000 });
}
