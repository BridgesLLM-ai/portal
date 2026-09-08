import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  AdminUserRetirementIntegrityError,
  type AdminUserRetirementManifestV1,
  type AdminUserRetirementRunnerContext,
  validateAdminUserRetirementManifest,
} from './adminUserRetirementLedger';

type RetirementDatabase = typeof prisma;

type SharedActorInventory = {
  states: Array<{ id: string; projectIdentityId: string }>;
  turns: Array<{
    id: string;
    projectIdentityId: string;
    providerSessionId: string | null;
    status: string;
  }>;
  resetJournals: Array<{
    id: string;
    projectIdentityId: string;
    legacyProjectId: string | null;
  }>;
  providerBindings: Array<{
    id: string;
    projectId: string;
    sessionKey: string | null;
    externalSessionId: string | null;
  }>;
  providerSessions: Array<{
    id: string;
    projectId: string;
    sessionKey: string;
  }>;
  messages: Array<{
    id: string;
    projectId: string;
    sessionKey: string;
    providerSessionId: string | null;
  }>;
  legacyImports: Array<{
    id: string;
    projectIdentityId: string;
    sourceSessionKey: string;
    providerSessionId: string;
  }>;
  legacyQuarantines: Array<{
    id: string;
    projectIdentityId: string;
    originalProjectId: string;
    sessionKey: string;
    providerSessionId: string | null;
  }>;
  legacyClearTombstones: Array<{
    id: string;
    projectIdentityId: string;
  }>;
  completeRepairReceipts: Array<{
    repairId: string;
    actorUserId: string;
    status: string;
    phase: string;
  }>;
  cleanupActors: Array<{
    projectIdentityId: string;
    provider: string;
    actorUserId: string;
    sessionId: string;
  }>;
};

function fail(message: string): never {
  throw new AdminUserRetirementIntegrityError(message);
}

function assertSubset(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  if (
    actual.some((value) => !expectedSet.has(value))
    || new Set(actual).size !== actual.length
  ) {
    fail(`${label} changed after the immutable retirement manifest was sealed`);
  }
}

function assertOptionalLocator(
  value: string | null,
  expected: ReadonlySet<string>,
  label: string,
): void {
  if (value && !expected.has(value)) {
    fail(`${label} changed after the immutable retirement manifest was sealed`);
  }
}

async function readSharedActorInventory(
  targetUserId: string,
  database: any,
): Promise<SharedActorInventory> {
  const [
    states,
    turns,
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
    database.projectChatState.findMany({
      where: { actorUserId: targetUserId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true },
    }),
    database.projectChatTurn.findMany({
      where: { actorUserId: targetUserId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectIdentityId: true,
        providerSessionId: true,
        status: true,
      },
    }),
    database.projectChatDestructiveResetJournal.findMany({
      where: { actorUserId: targetUserId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true, legacyProjectId: true },
    }),
    database.projectChatProviderBinding.findMany({
      where: { userId: targetUserId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectId: true,
        sessionKey: true,
        externalSessionId: true,
      },
    }),
    database.projectChatSession.findMany({
      where: { userId: targetUserId },
      orderBy: { id: 'asc' },
      select: { id: true, projectId: true, sessionKey: true },
    }),
    database.projectChatMessage.findMany({
      where: { userId: targetUserId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectId: true,
        sessionKey: true,
        providerSessionId: true,
      },
    }),
    database.legacyOpenClawProjectImport.findMany({
      where: { actorUserId: targetUserId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        projectIdentityId: true,
        sourceSessionKey: true,
        providerSessionId: true,
      },
    }),
    database.legacyOpenClawProjectQuarantine.findMany({
      where: { actorUserId: targetUserId },
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
      where: { actorUserId: targetUserId },
      orderBy: { id: 'asc' },
      select: { id: true, projectIdentityId: true },
    }),
    database.projectDependencyRepairOperation.findMany({
      where: { actorUserId: targetUserId },
      orderBy: { repairId: 'asc' },
      select: {
        repairId: true,
        actorUserId: true,
        status: true,
        phase: true,
      },
    }),
    database.projectRuntimeCleanupActor.findMany({
      where: { actorUserId: targetUserId },
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
  return {
    states,
    turns: turns.map((turn: any) => ({ ...turn, status: String(turn.status) })),
    resetJournals,
    providerBindings,
    providerSessions,
    messages,
    legacyImports,
    legacyQuarantines,
    legacyClearTombstones,
    completeRepairReceipts,
    cleanupActors,
  };
}

function cleanupActorKey(row: SharedActorInventory['cleanupActors'][number]): string {
  return JSON.stringify([
    row.projectIdentityId,
    row.provider,
    row.actorUserId,
    row.sessionId,
  ]);
}

function assertSharedActorInventory(
  manifest: AdminUserRetirementManifestV1,
  inventory: SharedActorInventory,
): void {
  const expected = manifest.actorRuntimeState;
  assertSubset(inventory.states.map((row) => row.id), expected.chatStateIds, 'Chat state inventory');
  assertSubset(inventory.turns.map((row) => row.id), expected.turnIds, 'Chat turn inventory');
  assertSubset(
    inventory.resetJournals.map((row) => row.id),
    expected.resetJournalIds,
    'Chat reset inventory',
  );
  assertSubset(
    inventory.providerBindings.map((row) => row.id),
    expected.providerBindingIds,
    'Provider binding inventory',
  );
  assertSubset(
    inventory.providerSessions.map((row) => row.id),
    expected.providerSessionRowIds,
    'Provider session-row inventory',
  );
  assertSubset(inventory.messages.map((row) => row.id), expected.messageIds, 'Message inventory');
  assertSubset(
    inventory.legacyImports.map((row) => row.id),
    expected.legacyImportIds,
    'Legacy import inventory',
  );
  assertSubset(
    inventory.legacyQuarantines.map((row) => row.id),
    expected.legacyQuarantineIds,
    'Legacy quarantine inventory',
  );
  assertSubset(
    inventory.legacyClearTombstones.map((row) => row.id),
    expected.legacyClearTombstoneIds,
    'Legacy clear inventory',
  );
  assertSubset(
    inventory.completeRepairReceipts.map((row) => row.repairId),
    manifest.dependencyEvidence.completeRepairReceiptIds,
    'Completed dependency repair receipt inventory',
  );
  assertSubset(
    inventory.cleanupActors.map(cleanupActorKey),
    manifest.dependencyEvidence.cleanupActors.map(cleanupActorKey),
    'Runtime cleanup actor inventory',
  );
  if (inventory.completeRepairReceipts.some((row) => (
    row.actorUserId !== manifest.target.id
    || row.status !== 'APPLIED'
    || row.phase !== 'COMPLETE'
  ))) {
    fail('A live Project dependency repair operation remains after retirement admission closed');
  }
  if (inventory.cleanupActors.some((row) => row.actorUserId !== manifest.target.id)) {
    fail('Runtime cleanup actor inventory belongs to another user');
  }

  const projectIds = new Set(expected.projectIdentityIds);
  const legacyProjectIds = new Set(expected.legacyProjectIds);
  const gatewayKeys = new Set(expected.gatewaySessionKeys);
  const providerSessionIds = new Set(expected.providerSessionIds);
  for (const row of [
    ...inventory.states,
    ...inventory.turns,
    ...inventory.resetJournals,
    ...inventory.legacyImports,
    ...inventory.legacyQuarantines,
    ...inventory.legacyClearTombstones,
  ]) {
    if (!projectIds.has(row.projectIdentityId)) {
      fail('Shared actor Project identity changed after retirement manifest');
    }
  }
  for (const row of inventory.resetJournals) {
    assertOptionalLocator(row.legacyProjectId, legacyProjectIds, 'Reset legacy Project identity');
  }
  for (const row of inventory.providerBindings) {
    if (!projectIds.has(row.projectId) && !legacyProjectIds.has(row.projectId)) {
      fail('Provider binding Project identity changed after retirement manifest');
    }
    assertOptionalLocator(row.sessionKey, gatewayKeys, 'Provider binding session key');
    assertOptionalLocator(
      row.externalSessionId,
      providerSessionIds,
      'Provider binding external session',
    );
  }
  for (const row of inventory.providerSessions) {
    if (!projectIds.has(row.projectId) && !legacyProjectIds.has(row.projectId)) {
      fail('Provider session Project identity changed after retirement manifest');
    }
    assertOptionalLocator(row.sessionKey, gatewayKeys, 'Provider session key');
  }
  for (const row of inventory.messages) {
    if (!projectIds.has(row.projectId) && !legacyProjectIds.has(row.projectId)) {
      fail('Message Project identity changed after retirement manifest');
    }
    assertOptionalLocator(row.sessionKey, gatewayKeys, 'Message session key');
    assertOptionalLocator(row.providerSessionId, providerSessionIds, 'Message provider session');
  }
  for (const row of inventory.legacyImports) {
    assertOptionalLocator(row.sourceSessionKey, gatewayKeys, 'Legacy import session key');
    assertOptionalLocator(row.providerSessionId, providerSessionIds, 'Legacy import provider session');
  }
  for (const row of inventory.legacyQuarantines) {
    if (!legacyProjectIds.has(row.originalProjectId)) {
      fail('Legacy quarantine Project identity changed after retirement manifest');
    }
    assertOptionalLocator(row.sessionKey, gatewayKeys, 'Legacy quarantine session key');
    assertOptionalLocator(
      row.providerSessionId,
      providerSessionIds,
      'Legacy quarantine provider session',
    );
  }
  if (inventory.turns.some((turn) => ['RUNNING', 'ABORTING'].includes(turn.status))) {
    fail('A shared Project turn remains active after retirement admission closed');
  }
}

async function deleteExactRows(
  delegate: { deleteMany(args: unknown): Promise<{ count: number }> },
  where: Record<string, unknown>,
  expectedCount: number,
  label: string,
): Promise<void> {
  if (expectedCount === 0) return;
  const deleted = await delegate.deleteMany({ where });
  if (deleted.count !== expectedCount) {
    fail(`${label} changed during the retirement database transaction`);
  }
}

async function deleteExactCleanupActors(
  transaction: any,
  rows: SharedActorInventory['cleanupActors'],
): Promise<void> {
  if (rows.length === 0) return;
  const deleted = await transaction.projectRuntimeCleanupActor.deleteMany({
    where: {
      OR: rows.map((row) => ({
        projectIdentityId: row.projectIdentityId,
        provider: row.provider,
        actorUserId: row.actorUserId,
        sessionId: row.sessionId,
      })),
    },
  });
  if (deleted.count !== rows.length) {
    fail('Runtime cleanup actor inventory changed during the retirement database transaction');
  }
}

export async function retireAdminUserSharedActorState(
  candidate: AdminUserRetirementManifestV1,
  context: AdminUserRetirementRunnerContext,
  database: RetirementDatabase = prisma,
): Promise<void> {
  const manifest = validateAdminUserRetirementManifest(candidate);
  const admission = context.readAdmissionEvidence();
  await context.assertHeld();
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
    if (
      !target
      || String(target.role) !== manifest.target.role
      || target.isActive !== false
      || String(target.accountStatus) !== 'DISABLED'
      || target.authorizationVersion !== admission.closedAuthorizationVersion
    ) {
      fail('User admission closure changed before shared actor retirement');
    }

    const inventory = await readSharedActorInventory(manifest.target.id, transaction);
    assertSharedActorInventory(manifest, inventory);
    await deleteExactRows(
      transaction.projectDependencyRepairOperation,
      {
        actorUserId: manifest.target.id,
        repairId: { in: inventory.completeRepairReceipts.map((row) => row.repairId) },
        status: 'APPLIED',
        phase: 'COMPLETE',
      },
      inventory.completeRepairReceipts.length,
      'Completed dependency repair receipt inventory',
    );
    await deleteExactCleanupActors(transaction, inventory.cleanupActors);
    await deleteExactRows(
      transaction.projectChatTurn,
      { actorUserId: manifest.target.id, id: { in: inventory.turns.map((row) => row.id) } },
      inventory.turns.length,
      'Chat turn inventory',
    );
    await deleteExactRows(
      transaction.projectChatDestructiveResetJournal,
      {
        actorUserId: manifest.target.id,
        id: { in: inventory.resetJournals.map((row) => row.id) },
      },
      inventory.resetJournals.length,
      'Chat reset inventory',
    );
    await deleteExactRows(
      transaction.legacyOpenClawProjectImport,
      { actorUserId: manifest.target.id, id: { in: inventory.legacyImports.map((row) => row.id) } },
      inventory.legacyImports.length,
      'Legacy import inventory',
    );
    await deleteExactRows(
      transaction.legacyOpenClawProjectQuarantine,
      {
        actorUserId: manifest.target.id,
        id: { in: inventory.legacyQuarantines.map((row) => row.id) },
      },
      inventory.legacyQuarantines.length,
      'Legacy quarantine inventory',
    );
    await deleteExactRows(
      transaction.legacyOpenClawProjectClearTombstone,
      {
        actorUserId: manifest.target.id,
        id: { in: inventory.legacyClearTombstones.map((row) => row.id) },
      },
      inventory.legacyClearTombstones.length,
      'Legacy clear inventory',
    );
    await deleteExactRows(
      transaction.projectChatMessage,
      { userId: manifest.target.id, id: { in: inventory.messages.map((row) => row.id) } },
      inventory.messages.length,
      'Message inventory',
    );
    await deleteExactRows(
      transaction.projectChatSession,
      {
        userId: manifest.target.id,
        id: { in: inventory.providerSessions.map((row) => row.id) },
      },
      inventory.providerSessions.length,
      'Provider session-row inventory',
    );
    await deleteExactRows(
      transaction.projectChatProviderBinding,
      {
        userId: manifest.target.id,
        id: { in: inventory.providerBindings.map((row) => row.id) },
      },
      inventory.providerBindings.length,
      'Provider binding inventory',
    );
    await deleteExactRows(
      transaction.projectChatState,
      { actorUserId: manifest.target.id, id: { in: inventory.states.map((row) => row.id) } },
      inventory.states.length,
      'Chat state inventory',
    );
    const residue = await readSharedActorInventory(manifest.target.id, transaction);
    if (Object.values(residue).some((rows) => rows.length !== 0)) {
      fail('Shared Project actor state remains after retirement');
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30_000,
  });
  await context.assertHeld();
}

export async function assertAdminUserSharedActorStateAbsent(
  targetUserId: string,
  database: RetirementDatabase = prisma,
): Promise<void> {
  const userId = String(targetUserId || '').trim();
  if (!userId) fail('Shared actor absence target is invalid');
  const inventory = await readSharedActorInventory(userId, database);
  if (Object.values(inventory).some((rows) => rows.length !== 0)) {
    fail('Shared Project actor state is not fully absent');
  }
}
