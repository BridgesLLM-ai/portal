jest.mock('../config/database', () => ({ prisma: {} }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { JwtPayload } from '../utils/jwt';
import {
  buildProjectDependencyPromotionManifest,
  type ProjectDependencyPromotionManifest,
} from './projectDependencyPromotionManifest';
import {
  attestProjectDependencyPromotionFenceReleaseState,
  authorizeProjectDependencyPromotion,
  deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup,
  markProjectDependencyPromotionApplied,
  quarantineProjectDependencyPromotion,
  type ProjectDependencyPromotionDecisionDatabase,
} from './projectDependencyPromotionDecision';
import {
  acquireProjectDeletionLockWithoutGuard,
  projectDeletionLockKey,
} from './projectDeletionLock';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'owner-1';
const ACTOR_ID = OWNER_ID;
const PROJECT_ID = 'project-1';
const ORIGINAL_PROJECTS_ROOT = process.env.PORTAL_PROJECTS_ROOT;
const TEST_PROJECTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-decision-'));
process.env.PORTAL_PROJECTS_ROOT = TEST_PROJECTS_ROOT;
fs.mkdirSync(path.join(TEST_PROJECTS_ROOT, OWNER_ID), { recursive: true });
const DESTINATION = path.join(TEST_PROJECTS_ROOT, OWNER_ID, 'project-a');
const NOW = new Date('2026-08-12T12:00:00.000Z');

function queryText(query: any): string {
  return Array.from(query.strings || []).join(' ');
}

function actor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    userId: ACTOR_ID,
    sessionId: 'session-1',
    email: 'actor@example.test',
    authorizationVersion: 7,
    role: 'USER',
    accountStatus: 'ACTIVE',
    ...overrides,
  };
}

function manifest(): ProjectDependencyPromotionManifest {
  const ownerStat = fs.lstatSync(path.join(TEST_PROJECTS_ROOT, OWNER_ID), { bigint: true });
  return buildProjectDependencyPromotionManifest({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    workspaceOwnerId: OWNER_ID,
    projectName: 'project-a',
    destinationCanonicalRoot: DESTINATION,
    destinationIdentity: {
      device: '11', inode: '22', kind: 'directory', mode: 0o700, uid: 0, gid: 0, birthtimeNs: '123456789',
    },
    stagingCanonicalRoot: path.join(
      TEST_PROJECTS_ROOT,
      OWNER_ID,
      `.bridgesllm-project-promotion-${OPERATION_ID}`,
    ),
    stagingIdentity: {
      device: '11', inode: '33', kind: 'directory', mode: 0o700, uid: 0, gid: 0, birthtimeNs: '2',
    },
    entries: [{
      artifact: 'node_modules',
      originalIdentity: { device: '11', inode: '44', kind: 'directory', mode: 0o755, uid: 0, gid: 0, birthtimeNs: '3' },
      stagedIdentity: { device: '11', inode: '55', kind: 'directory', mode: 0o755, uid: 0, gid: 0, birthtimeNs: '4' },
      stagedTreeDigest: 'a'.repeat(64),
    }],
    projectIdentityId: PROJECT_ID,
    projectIdentityGeneration: 3,
    projectRootBirthtimeNs: '123456789',
    operationParentCanonicalRoot: path.join(TEST_PROJECTS_ROOT, OWNER_ID),
    operationParentIdentity: {
      device: ownerStat.dev.toString(),
      inode: ownerStat.ino.toString(),
      kind: 'directory',
      mode: Number(ownerStat.mode & 0o777n),
      uid: Number(ownerStat.uid),
      gid: Number(ownerStat.gid),
      birthtimeNs: ownerStat.birthtimeNs.toString(),
    },
  });
}

const DIGEST = manifest().manifestDigest;

function input(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION_ID,
    actor: actor(),
    projectIdentityId: PROJECT_ID,
    projectIdentityGeneration: 3,
    workspaceOwnerId: OWNER_ID,
    projectName: 'project-a',
    destinationCanonicalRoot: DESTINATION,
    destinationRootDevice: '11',
    destinationRootInode: '22',
    destinationRootBirthtimeNs: '123456789',
    manifest: manifest(),
    ...overrides,
  } as any;
}

function record(status: 'AUTHORIZED' | 'APPLIED' = 'AUTHORIZED') {
  const proof = manifest();
  return {
    operationId: OPERATION_ID,
    actorUserId: ACTOR_ID,
    sessionId: 'session-1',
    authorizationVersion: 7,
    projectIdentityId: PROJECT_ID,
    projectIdentityGeneration: 3,
    workspaceOwnerId: OWNER_ID,
    projectName: 'project-a',
    operationParentCanonicalRoot: proof.operationParentCanonicalRoot,
    operationParentDevice: proof.operationParentIdentity.device,
    operationParentInode: proof.operationParentIdentity.inode,
    operationParentBirthtimeNs: proof.operationParentIdentity.birthtimeNs,
    operationParentMode: proof.operationParentIdentity.mode,
    operationParentUid: proof.operationParentIdentity.uid,
    operationParentGid: proof.operationParentIdentity.gid,
    destinationCanonicalRoot: DESTINATION,
    destinationRootDevice: '11',
    destinationRootInode: '22',
    destinationRootBirthtimeNs: '123456789',
    manifestDigest: DIGEST,
    manifest: proof,
    status,
    authorizedAt: NOW,
    appliedAt: status === 'APPLIED' ? new Date(NOW.getTime() + 1_000) : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function transactionClient(options: {
  actorRole?: string;
  actorSandbox?: boolean;
  primaryOwnerId?: string;
  existing?: ReturnType<typeof record> | null;
  lifecycleStatus?: 'ACTIVE' | 'DEPENDENCY_PROMOTING' | 'DEPENDENCY_QUARANTINED';
} = {}) {
  const identity = (lifecycleStatus = options.lifecycleStatus || 'ACTIVE') => ({
    id: PROJECT_ID,
    workspaceOwnerId: OWNER_ID,
    projectName: 'project-a',
    canonicalRoot: DESTINATION,
    rootDevice: '11',
    rootInode: '22',
    rootBirthtimeNs: '123456789',
    generation: 3,
    lifecycleStatus,
  });
  const query = jest.fn(async (sql: any) => {
    const text = queryText(sql);
    if (text.includes('FROM "User"') && text.includes('clock_timestamp')) {
      return [{
        id: ACTOR_ID,
        authorizationVersion: 7,
        accountStatus: 'ACTIVE',
        isActive: true,
        role: options.actorRole || 'USER',
        sandboxEnabled: options.actorSandbox ?? true,
        createdAt: NOW,
        databaseNow: NOW,
      }];
    }
    if (text.includes('FROM "User"') && text.includes('ORDER BY "createdAt"')) {
      return [{ id: options.primaryOwnerId || OWNER_ID }];
    }
    if (text.includes('FROM "Session"')) {
      return [{ id: 'session-1', expiresAt: new Date(NOW.getTime() + 60_000) }];
    }
    if (text.includes('FROM "ProjectIdentity"')) {
      return [identity()];
    }
    if (text.includes('FROM "ProjectChatTurn"')) return [];
    if (text.includes('UPDATE "ProjectIdentity"') && text.includes("'DEPENDENCY_QUARANTINED'")) {
      return [identity('DEPENDENCY_QUARANTINED')];
    }
    if (text.includes('UPDATE "ProjectIdentity"') && text.includes("'DEPENDENCY_PROMOTING'")) {
      return [identity('DEPENDENCY_PROMOTING')];
    }
    if (text.includes('UPDATE "ProjectIdentity"') && text.includes("'ACTIVE'")) {
      return [{ id: PROJECT_ID }];
    }
    if (text.includes('FROM "ProjectDependencyPromotionDecision"')) {
      return options.existing ? [options.existing] : [];
    }
    if (text.includes('INSERT INTO "ProjectDependencyPromotionDecision"')) return [record()];
    if (text.includes('DELETE FROM "ProjectDependencyPromotionDecision"')) {
      return [{ operationId: OPERATION_ID }];
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
  return { $queryRaw: query };
}

function database(tx = transactionClient()): ProjectDependencyPromotionDecisionDatabase {
  return {
    $transaction: jest.fn(async (callback: any) => callback(tx)),
    $queryRaw: jest.fn(),
  } as any;
}

describe('durable Project dependency promotion decisions', () => {
  afterAll(() => {
    if (ORIGINAL_PROJECTS_ROOT === undefined) delete process.env.PORTAL_PROJECTS_ROOT;
    else process.env.PORTAL_PROJECTS_ROOT = ORIGINAL_PROJECTS_ROOT;
    fs.rmSync(TEST_PROJECTS_ROOT, { recursive: true, force: true });
  });
  test('locks the exact User, Session, and ProjectIdentity and inserts one immutable decision', async () => {
    const tx = transactionClient();
    const db = database(tx);

    await expect(authorizeProjectDependencyPromotion({ ...input(), database: db })).resolves.toEqual({
      kind: 'authorized',
      record: expect.objectContaining({ operationId: OPERATION_ID, manifestDigest: DIGEST, status: 'AUTHORIZED' }),
    });

    const statements = (tx.$queryRaw as jest.Mock).mock.calls.map(([sql]) => queryText(sql));
    expect(statements.filter((text) => text.includes('FOR SHARE'))).toHaveLength(3);
    expect(statements.some((text) => text.includes('INSERT INTO "ProjectDependencyPromotionDecision"'))).toBe(true);
  });

  test.each([
    ['PREDECISION_CLEAN', null, 'ACTIVE'],
    ['ACTIVE', null, 'ACTIVE'],
    ['DEPENDENCY_QUARANTINED', record(), 'DEPENDENCY_QUARANTINED'],
  ] as const)('reopens the global writer gate only for exact %s state', async (
    expectedState,
    existing,
    lifecycleStatus,
  ) => {
    const db = database(transactionClient({ existing, lifecycleStatus }));
    await expect(attestProjectDependencyPromotionFenceReleaseState({
      operationId: OPERATION_ID,
      manifestDigest: DIGEST,
      projectIdentityId: PROJECT_ID,
      projectIdentityGeneration: 3,
      workspaceOwnerId: OWNER_ID,
      projectName: 'project-a',
      destinationCanonicalRoot: DESTINATION,
      destinationRootDevice: '11',
      destinationRootInode: '22',
      destinationRootBirthtimeNs: '123456789',
      expectedState,
      database: db,
    })).resolves.toBeUndefined();
  });

  test('refuses ACTIVE fence release while an exact durable promotion receipt remains', async () => {
    const db = database(transactionClient({
      existing: record('APPLIED'),
      lifecycleStatus: 'ACTIVE',
    }));
    await expect(attestProjectDependencyPromotionFenceReleaseState({
      operationId: OPERATION_ID,
      manifestDigest: DIGEST,
      projectIdentityId: PROJECT_ID,
      projectIdentityGeneration: 3,
      workspaceOwnerId: OWNER_ID,
      projectName: 'project-a',
      destinationCanonicalRoot: DESTINATION,
      destinationRootDevice: '11',
      destinationRootInode: '22',
      destinationRootBirthtimeNs: '123456789',
      expectedState: 'ACTIVE',
      database: db,
    })).rejects.toMatchObject({ code: 'DECISION_STATE_CONFLICT' });
  });

  test('allows a current unsandboxed SUB_ADMIN to target the locked primary owner workspace', async () => {
    const tx = transactionClient({ actorRole: 'SUB_ADMIN', actorSandbox: false });
    const db = database(tx);
    await expect(authorizeProjectDependencyPromotion({ ...input({
      actor: actor({ userId: 'delegate-1', role: 'SUB_ADMIN' }),
    }), database: db })).resolves.toEqual({
      kind: 'authorized', record: expect.objectContaining({ status: 'AUTHORIZED' }),
    });
    expect((tx.$queryRaw as jest.Mock).mock.calls.map(([sql]) => queryText(sql)))
      .toEqual(expect.arrayContaining([expect.stringContaining('ORDER BY "createdAt" ASC, "id" ASC')]));
  });

  test('rejects VIEWER and stale Project identity before INSERT without uncertain-outcome lookup', async () => {
    const viewerTx = transactionClient({ actorRole: 'VIEWER' });
    const viewerDb = database(viewerTx);
    await expect(authorizeProjectDependencyPromotion({ ...input({
      actor: actor({ role: 'VIEWER' }),
      workspaceOwnerId: ACTOR_ID,
      manifest: { ...manifest(), workspaceOwnerId: ACTOR_ID },
    }), database: viewerDb })).resolves.toEqual({ kind: 'denied', reason: 'AUTHORIZATION_CHANGED' });
    expect(viewerDb.$queryRaw).not.toHaveBeenCalled();

    const staleTx = transactionClient();
    (staleTx.$queryRaw as jest.Mock).mockImplementation(async (sql: any) => {
      const text = queryText(sql);
      if (text.includes('FROM "ProjectIdentity"')) return [];
      return transactionClient().$queryRaw(sql);
    });
    const staleDb = database(staleTx);
    await expect(authorizeProjectDependencyPromotion({ ...input(), database: staleDb }))
      .resolves.toEqual({ kind: 'denied', reason: 'PROJECT_IDENTITY_CHANGED' });
    expect(staleDb.$queryRaw).not.toHaveBeenCalled();
  });

  test('recomputes the sole canonical manifest digest and rejects a forged supplied digest', async () => {
    const db = database();
    await expect(authorizeProjectDependencyPromotion({
      ...input({ manifest: { ...manifest(), manifestDigest: 'b'.repeat(64) } }),
      database: db,
    })).resolves.toEqual({ kind: 'denied', reason: 'INVALID_INPUT' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  test('fails closed for a legacy token without an exact durable Session identity', async () => {
    const db = database();
    await expect(authorizeProjectDependencyPromotion({
      ...input({ actor: actor({ sessionId: undefined }) }),
      database: db,
    })).resolves.toEqual({ kind: 'denied', reason: 'AUTHORIZATION_CHANGED' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  test('resolves a lost transaction response by exact operation and manifest digest', async () => {
    const tx = transactionClient();
    const db = database(tx);
    (db.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      await callback(tx);
      throw new Error('connection reset after COMMIT');
    });
    (db.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([record()])
      .mockResolvedValue([{
        id: PROJECT_ID,
        workspaceOwnerId: OWNER_ID,
        projectName: 'project-a',
        canonicalRoot: DESTINATION,
        rootDevice: '11',
        rootInode: '22',
        rootBirthtimeNs: '123456789',
        generation: 3,
        lifecycleStatus: 'DEPENDENCY_PROMOTING',
      }]);

    await expect(authorizeProjectDependencyPromotion({ ...input(), database: db }))
      .resolves.toEqual({
        kind: 'authorized',
        record: expect.objectContaining({ operationId: OPERATION_ID, status: 'AUTHORIZED' }),
      });
  });

  test('reports an unknown outcome when both commit response and exact lookup are unavailable', async () => {
    const db = database();
    (db.$transaction as jest.Mock).mockRejectedValue(new Error('connection reset after COMMIT'));
    (db.$queryRaw as jest.Mock).mockRejectedValue(new Error('database unavailable'));

    await expect(authorizeProjectDependencyPromotion({ ...input(), database: db }))
      .rejects.toMatchObject({ code: 'DECISION_UNKNOWN' });
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
  });

  test('marks APPLIED idempotently after a lost update response and never treats unknown as cleanup-safe', async () => {
    const db = database();
    (db.$queryRaw as jest.Mock)
      .mockRejectedValueOnce(new Error('lost update response'))
      .mockResolvedValueOnce([record('APPLIED')]);
    await expect(markProjectDependencyPromotionApplied({
      operationId: OPERATION_ID, manifestDigest: DIGEST, database: db,
    })).resolves.toEqual(expect.objectContaining({ status: 'APPLIED' }));

    const unavailable = database();
    (unavailable.$queryRaw as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    await expect(markProjectDependencyPromotionApplied({
      operationId: OPERATION_ID, manifestDigest: DIGEST, database: unavailable,
    })).rejects.toMatchObject({ code: 'DECISION_UNKNOWN' });
  });

  test('deletes only an APPLIED receipt after the caller proves evidence cleanup', async () => {
    const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(OWNER_ID, 'project-a'),
    );
    const appliedDb = database(transactionClient({
      existing: record('APPLIED'),
      lifecycleStatus: 'DEPENDENCY_PROMOTING',
    }));
    (appliedDb.$queryRaw as jest.Mock).mockResolvedValueOnce([record('APPLIED')]);
    await expect(deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
      operationId: OPERATION_ID,
      manifestDigest: DIGEST,
      lifecycleLock,
      verifyAppliedGeneration: jest.fn(),
      database: appliedDb,
    })).resolves.toBe(true);
    lifecycleLock();

    const authorizedLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(OWNER_ID, 'project-a'),
    );
    const authorizedDb = database();
    (authorizedDb.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([record()]);
    await expect(deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
      operationId: OPERATION_ID,
      manifestDigest: DIGEST,
      lifecycleLock: authorizedLock,
      verifyAppliedGeneration: jest.fn(),
      database: authorizedDb,
    })).rejects.toMatchObject({ code: 'DECISION_STATE_CONFLICT' });
    authorizedLock();
  });

  test('keeps an APPLIED receipt while exact staging evidence still exists', async () => {
    const staging = path.join(
      TEST_PROJECTS_ROOT,
      OWNER_ID,
      `.bridgesllm-project-promotion-${OPERATION_ID}`,
    );
    fs.mkdirSync(staging, { mode: 0o700 });
    const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(OWNER_ID, 'project-a'),
    );
    try {
      const db = database();
      (db.$queryRaw as jest.Mock).mockResolvedValueOnce([record('APPLIED')]);
      await expect(deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
        operationId: OPERATION_ID,
        manifestDigest: DIGEST,
        lifecycleLock,
        verifyAppliedGeneration: jest.fn(),
        database: db,
      })).rejects.toMatchObject({ code: 'EVIDENCE_NOT_CLEAN' });
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    } finally {
      lifecycleLock();
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  test('never deletes APPLIED or reopens ACTIVE when durable all-new re-attestation fails', async () => {
    const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(OWNER_ID, 'project-a'),
    );
    try {
      const db = database(transactionClient({
        existing: record('APPLIED'),
        lifecycleStatus: 'DEPENDENCY_PROMOTING',
      }));
      (db.$queryRaw as jest.Mock).mockResolvedValueOnce([record('APPLIED')]);
      const mismatch = new Error('all-new tree changed');
      await expect(deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
        operationId: OPERATION_ID,
        manifestDigest: DIGEST,
        lifecycleLock,
        verifyAppliedGeneration: () => { throw mismatch; },
        database: db,
      })).rejects.toBe(mismatch);
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally {
      lifecycleLock();
    }
  });

  test('contains an exact APPLIED receipt without mutating the immutable decision', async () => {
    const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(OWNER_ID, 'project-a'),
    );
    try {
      const tx = transactionClient({
        existing: record('APPLIED'),
        lifecycleStatus: 'DEPENDENCY_PROMOTING',
      });
      const db = database(tx);
      (db.$queryRaw as jest.Mock).mockResolvedValueOnce([record('APPLIED')]);
      await expect(quarantineProjectDependencyPromotion({
        operationId: OPERATION_ID,
        manifestDigest: DIGEST,
        lifecycleLock,
        database: db,
      })).resolves.toMatchObject({ lifecycleStatus: 'DEPENDENCY_QUARANTINED' });
      const statements = (tx.$queryRaw as jest.Mock).mock.calls.map(([sql]) => queryText(sql));
      expect(statements).toEqual(expect.arrayContaining([
        expect.stringContaining('SET "lifecycleStatus" = \'DEPENDENCY_QUARANTINED\''),
      ]));
      expect(statements.some((text) => text.includes('UPDATE "ProjectDependencyPromotionDecision"'))).toBe(false);
    } finally {
      lifecycleLock();
    }
  });

  test('keeps an APPLIED receipt while an exact operation journal temporary remains', async () => {
    const temporary = path.join(
      TEST_PROJECTS_ROOT,
      OWNER_ID,
      `..bridgesllm-project-promotion-${OPERATION_ID}.journal.json.123.22222222-2222-4222-8222-222222222222.tmp`,
    );
    fs.writeFileSync(temporary, '{}\n', { mode: 0o600 });
    const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(OWNER_ID, 'project-a'),
    );
    try {
      const db = database();
      (db.$queryRaw as jest.Mock).mockResolvedValueOnce([record('APPLIED')]);
      await expect(deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
        operationId: OPERATION_ID,
        manifestDigest: DIGEST,
        lifecycleLock,
        verifyAppliedGeneration: jest.fn(),
        database: db,
      })).rejects.toMatchObject({ code: 'EVIDENCE_NOT_CLEAN' });
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    } finally {
      lifecycleLock();
      fs.rmSync(temporary, { force: true });
    }
  });
});
