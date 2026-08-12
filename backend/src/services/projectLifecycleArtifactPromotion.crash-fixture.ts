import fs from 'fs';
import path from 'path';

type CrashMode = 'prepare' | 'commit' | 'recover-project' | 'recover-startup';

interface DurableDecisionRecord {
  operationId: string;
  actorUserId: string;
  sessionId: string;
  authorizationVersion: number;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  operationParentCanonicalRoot: string;
  operationParentDevice: string;
  operationParentInode: string;
  operationParentBirthtimeNs: string;
  operationParentMode: number;
  operationParentUid: number;
  operationParentGid: number;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  manifestDigest: string;
  manifest: import('./projectDependencyPromotionManifest').ProjectDependencyPromotionManifest;
  lifecycleStatus: 'DEPENDENCY_PROMOTING' | 'DEPENDENCY_QUARANTINED';
  status: 'AUTHORIZED' | 'APPLIED';
  authorizedAt: string;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function durableDecisionDatabase(file: string) {
  const read = (): DurableDecisionRecord | null => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as DurableDecisionRecord;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  const write = (record: DurableDecisionRecord): void => {
    const temporary = `${file}.${process.pid}.tmp`;
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    const parentDescriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  };
  const query = async (statement: any): Promise<any[]> => {
    const sql = Array.from(statement?.strings || []).join(' ');
    const record = read();
    const lifecycleRow = record ? {
      id: record.projectIdentityId,
      workspaceOwnerId: record.workspaceOwnerId,
      projectName: record.projectName,
      canonicalRoot: record.destinationCanonicalRoot,
      rootDevice: record.destinationRootDevice,
      rootInode: record.destinationRootInode,
      rootBirthtimeNs: record.destinationRootBirthtimeNs,
      generation: record.projectIdentityGeneration,
      lifecycleStatus: record.lifecycleStatus,
    } : null;
    if (sql.includes('FROM "ProjectIdentity"')) return lifecycleRow ? [lifecycleRow] : [];
    if (sql.includes('UPDATE "ProjectIdentity"') && sql.includes("'DEPENDENCY_QUARANTINED'")) {
      if (!record || record.lifecycleStatus !== 'DEPENDENCY_PROMOTING') return [];
      const quarantined = { ...record, lifecycleStatus: 'DEPENDENCY_QUARANTINED' as const };
      write(quarantined);
      return [{ ...lifecycleRow, lifecycleStatus: quarantined.lifecycleStatus }];
    }
    if (sql.includes('UPDATE "ProjectIdentity"') && sql.includes("'ACTIVE'")) {
      return [{ id: record?.projectIdentityId || 'retired-project-identity' }];
    }
    if (sql.includes('UPDATE "ProjectDependencyPromotionDecision"')) {
      if (!record || record.status !== 'AUTHORIZED') return [];
      const now = new Date().toISOString();
      const applied = { ...record, status: 'APPLIED' as const, appliedAt: now, updatedAt: now };
      write(applied);
      return [applied];
    }
    if (sql.includes('DELETE FROM "ProjectDependencyPromotionDecision"')) {
      if (!record || record.status !== 'APPLIED') return [];
      fs.unlinkSync(file);
      return [{ operationId: record.operationId }];
    }
    if (sql.includes('FROM "ProjectDependencyPromotionDecision"')) return record ? [record] : [];
    throw new Error('Crash fixture received unexpected promotion-decision SQL');
  };
  return {
    read,
    write,
    database: {
      $queryRaw: query,
      $transaction: async (callback: (database: any) => Promise<any>) => callback({ $queryRaw: query }),
    },
  };
}

async function main(): Promise<void> {
  const raw = process.env.PROJECT_ARTIFACT_PROMOTION_CRASH_FIXTURE;
  if (!raw) throw new Error('Missing Project artifact promotion crash fixture configuration');
  const input = JSON.parse(raw) as {
    root: string;
    workspace: string;
    destination: string;
    artifacts: string[];
    mode: CrashMode;
    checkpoint?: string;
    decisionFile: string;
    decisionMode?: 'file' | 'postgres';
    sessionId?: string;
    pauseCheckpoint?: string;
    pauseReadyFile?: string;
    pauseReleaseFile?: string;
  };
  const root = fs.realpathSync.native(input.root);
  for (const candidate of [input.workspace, input.destination]) {
    const resolved = fs.realpathSync.native(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('Crash fixture path escapes its isolated root');
    }
  }
  if (!path.basename(root).startsWith('project-artifact-promotion-crash-')) {
    throw new Error('Crash fixture requires an isolated mkdtemp root');
  }

  process.env.DATABASE_URL ||= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
  process.env.PORTAL_PROJECTS_ROOT = root;
  const decisions = durableDecisionDatabase(input.decisionFile);
  const lifecycle = await import('./project-lifecycle.service');
  const decisionDatabase = input.decisionMode === 'postgres'
    ? undefined
    : decisions.database as any;
  if (input.mode === 'recover-project') {
    await lifecycle.recoverInterruptedProjectLifecycleArtifactPromotion(
      input.destination,
      decisionDatabase,
    );
    return;
  }
  if (input.mode === 'recover-startup') {
    await lifecycle.recoverInterruptedProjectLifecycleArtifactPromotions(
      root,
      decisionDatabase,
    );
    return;
  }

  const proof = (() => {
    const stat = fs.lstatSync(input.destination, { bigint: true });
    return {
      projectIdentityId: `identity-${path.basename(root).slice(-32)}`,
      projectIdentityGeneration: 1,
      workspaceOwnerId: path.basename(path.dirname(input.destination)),
      projectName: path.basename(input.destination),
      canonicalRoot: fs.realpathSync.native(input.destination),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
    };
  })();
  if (input.decisionMode === 'postgres') {
    const { prisma } = await import('../config/database');
    const suffix = cryptoSafeIdentifier(path.basename(root));
    await prisma.user.create({ data: {
      id: proof.workspaceOwnerId,
      email: `${suffix}@promotion.invalid`,
      username: `promotion-${suffix}`,
      passwordHash: 'not-a-real-password-hash',
      role: 'USER',
      accountStatus: 'ACTIVE',
      isActive: true,
      sandboxEnabled: false,
      authorizationVersion: 1,
    } });
    await prisma.session.create({ data: {
      id: input.sessionId || `session-${suffix}`,
      userId: proof.workspaceOwnerId,
      refreshTokenHash: `refresh-${suffix}`,
      expiresAt: new Date(Date.now() + 60_000),
    } });
    await prisma.projectIdentity.create({ data: {
      id: proof.projectIdentityId,
      workspaceOwnerId: proof.workspaceOwnerId,
      projectName: proof.projectName,
      canonicalRoot: proof.canonicalRoot,
      rootDevice: proof.rootDevice,
      rootInode: proof.rootInode,
      rootBirthtimeNs: proof.rootBirthtimeNs,
      generation: proof.projectIdentityGeneration,
      lifecycleStatus: 'ACTIVE',
    } });
  }
  const promotion = await lifecycle.prepareProjectLifecycleArtifactPromotion(
    input.workspace,
    input.destination,
    input.artifacts,
    proof,
    {
      testCheckpoint: (checkpoint) => {
        if (checkpoint === input.checkpoint) process.kill(process.pid, 'SIGKILL');
        if (checkpoint === input.pauseCheckpoint) {
          if (!input.pauseReadyFile || !input.pauseReleaseFile) {
            throw new Error('Crash fixture pause checkpoint lacks synchronization files');
          }
          fs.writeFileSync(input.pauseReadyFile, `${checkpoint}\n`, { flag: 'wx', mode: 0o600 });
          const deadline = Date.now() + 20_000;
          const sleeper = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(input.pauseReleaseFile)) {
            if (Date.now() >= deadline) throw new Error('Crash fixture pause checkpoint timed out');
            Atomics.wait(sleeper, 0, 0, 25);
          }
        }
      },
    },
  );
  if (input.mode === 'prepare') return;
  const manifest = promotion.manifest;
  const now = new Date().toISOString();
  if (input.decisionMode === 'postgres') {
    const decision = await import('./projectDependencyPromotionDecision');
    const outcome = await decision.authorizeProjectDependencyPromotion({
      operationId: manifest.operationId,
      actor: {
        userId: proof.workspaceOwnerId,
        sessionId: input.sessionId,
        email: `${cryptoSafeIdentifier(path.basename(root))}@promotion.invalid`,
        role: 'USER',
        accountStatus: 'ACTIVE',
        authorizationVersion: 1,
      },
      projectIdentityId: proof.projectIdentityId,
      projectIdentityGeneration: proof.projectIdentityGeneration,
      workspaceOwnerId: proof.workspaceOwnerId,
      projectName: proof.projectName,
      destinationCanonicalRoot: proof.canonicalRoot,
      destinationRootDevice: proof.rootDevice,
      destinationRootInode: proof.rootInode,
      destinationRootBirthtimeNs: proof.rootBirthtimeNs,
      manifest,
    });
    if (outcome.kind !== 'authorized') throw new Error(`Decision denied: ${outcome.reason}`);
  } else {
    decisions.write({
      operationId: manifest.operationId,
      actorUserId: 'crash-fixture-actor',
      sessionId: 'crash-fixture-session',
      authorizationVersion: 1,
      projectIdentityId: manifest.projectIdentityId,
      projectIdentityGeneration: manifest.projectIdentityGeneration,
      workspaceOwnerId: manifest.workspaceOwnerId,
      projectName: manifest.projectName,
      operationParentCanonicalRoot: manifest.operationParentCanonicalRoot,
      operationParentDevice: manifest.operationParentIdentity.device,
      operationParentInode: manifest.operationParentIdentity.inode,
      operationParentBirthtimeNs: manifest.operationParentIdentity.birthtimeNs,
      operationParentMode: manifest.operationParentIdentity.mode,
      operationParentUid: manifest.operationParentIdentity.uid,
      operationParentGid: manifest.operationParentIdentity.gid,
      destinationCanonicalRoot: manifest.destinationCanonicalRoot,
      destinationRootDevice: manifest.destinationIdentity.device,
      destinationRootInode: manifest.destinationIdentity.inode,
      destinationRootBirthtimeNs: manifest.destinationIdentity.birthtimeNs,
      manifestDigest: manifest.manifestDigest,
      manifest,
      lifecycleStatus: 'DEPENDENCY_PROMOTING',
      status: 'AUTHORIZED',
      authorizedAt: now,
      appliedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (input.checkpoint === 'after-decision') process.kill(process.pid, 'SIGKILL');
  promotion.commit();
  promotion.finalize();
  if (input.decisionMode === 'postgres') {
    const decision = await import('./projectDependencyPromotionDecision');
    await decision.markProjectDependencyPromotionApplied({
      operationId: manifest.operationId,
      manifestDigest: manifest.manifestDigest,
    });
  } else {
    const authorized = decisions.read();
    if (!authorized) throw new Error('Crash fixture lost its durable decision');
    const appliedAt = new Date().toISOString();
    decisions.write({ ...authorized, status: 'APPLIED', appliedAt, updatedAt: appliedAt });
  }
  await promotion.cleanup();
  if (input.decisionMode === 'postgres') {
    const locks = await import('./projectDeletionLock');
    const decision = await import('./projectDependencyPromotionDecision');
    const lifecycleLock = await locks.acquireProjectDeletionLockWithoutGuard(
      locks.projectDeletionLockKey(proof.workspaceOwnerId, proof.projectName),
    );
    try {
      await decision.deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
        operationId: manifest.operationId,
        manifestDigest: manifest.manifestDigest,
        lifecycleLock,
        verifyAppliedGeneration: lifecycle.verifyProjectDependencyPromotionManifestAllNew,
      });
    } finally {
      lifecycleLock();
    }
  } else {
    fs.rmSync(input.decisionFile, { force: true });
  }
}

function cryptoSafeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-24) || 'fixture';
}

async function disconnectPostgresFixture(): Promise<void> {
  const raw = process.env.PROJECT_ARTIFACT_PROMOTION_CRASH_FIXTURE;
  if (!raw) return;
  const input = JSON.parse(raw) as { decisionMode?: 'file' | 'postgres' };
  if (input.decisionMode !== 'postgres') return;
  const { prisma } = await import('../config/database');
  await prisma.$disconnect();
}

void main()
  .then(() => disconnectPostgresFixture())
  .catch(async (error) => {
    console.error(error);
    try {
      await disconnectPostgresFixture();
    } catch (disconnectError) {
      console.error(disconnectError);
    }
    process.exitCode = 1;
  });
