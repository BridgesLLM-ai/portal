import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

type CrashMode = 'crash' | 'recover';

interface FixtureInput {
  mode: CrashMode;
  root: string;
  workspace: string;
  destination: string;
  stateFile: string;
  backupRoot: string;
  repairId: string;
  checkpoint?: string;
  cleanupInitialFiles?: number;
  resultFile?: string;
}

interface PersistedState {
  schemaVersion: 1;
  actor: {
    userId: string;
    sessionId: string;
    authorizationVersion: number;
  };
  decision: any | null;
  lifecycle: any;
  repair: any | null;
}

const PHASES = ['GO_BIT', 'ALL_NEW', 'APPLIED', 'EVIDENCE_CLEAN', 'COMPLETE'] as const;

function atomicWriteJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function fileDatabase(file: string) {
  const read = (): PersistedState => JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedState;
  const write = (state: PersistedState): void => atomicWriteJson(file, state);

  const query = (state: PersistedState, statement: any): { rows: any[]; mutated: boolean } => {
    const sql = Array.from(statement?.strings || []).join(' ').replace(/\s+/g, ' ').trim();
    const values = Array.from(statement?.values || []) as any[];
    const now = new Date().toISOString();

    if (sql.includes('FROM "User"')) {
      return { rows: [{
        id: state.actor.userId,
        authorizationVersion: state.actor.authorizationVersion,
        role: 'OWNER',
        accountStatus: 'ACTIVE',
        isActive: true,
      }], mutated: false };
    }
    if (sql.includes('FROM "Session"')) {
      return { rows: [{ id: state.actor.sessionId }], mutated: false };
    }
    if (sql.includes('FROM "ProjectDependencyRepairOperation"')) {
      if (!state.repair) return { rows: [], mutated: false };
      if (sql.includes('"status" <> \'APPLIED\'')
        && state.repair.status === 'APPLIED' && state.repair.phase === 'COMPLETE'
        && !values.includes(true)) return { rows: [], mutated: false };
      return { rows: [state.repair], mutated: false };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM "ProjectDependencyPromotionDecision"')) {
      return { rows: state.decision ? [state.decision] : [], mutated: false };
    }
    if (sql.includes('FROM "ProjectIdentity"')) {
      return { rows: state.lifecycle ? [state.lifecycle] : [], mutated: false };
    }

    if (sql.startsWith('UPDATE "ProjectIdentity"')
      && sql.includes('SET "lifecycleStatus" = \'DEPENDENCY_PROMOTING\'')) {
      if (state.lifecycle.lifecycleStatus !== 'DEPENDENCY_QUARANTINED') {
        return { rows: [], mutated: false };
      }
      state.lifecycle.lifecycleStatus = 'DEPENDENCY_PROMOTING';
      state.lifecycle.updatedAt = now;
      return { rows: [{ id: state.lifecycle.id }], mutated: true };
    }
    if (sql.startsWith('UPDATE "ProjectIdentity"')
      && sql.includes('SET "lifecycleStatus" = \'ACTIVE\'')) {
      if (state.lifecycle.lifecycleStatus !== 'DEPENDENCY_PROMOTING') {
        return { rows: [], mutated: false };
      }
      state.lifecycle.lifecycleStatus = 'ACTIVE';
      state.lifecycle.dependencyQuarantinedAt = null;
      state.lifecycle.updatedAt = now;
      return { rows: [{ id: state.lifecycle.id }], mutated: true };
    }

    if (sql.startsWith('INSERT INTO "ProjectDependencyRepairOperation"')) {
      if (state.repair) return { rows: [], mutated: false };
      const v = values;
      state.repair = {
        repairId: String(v[0]),
        action: 'FORCE_FORWARD_STAGED',
        promotionOperationId: String(v[1]),
        manifestDigest: String(v[2]),
        actorUserId: String(v[3]),
        sessionId: String(v[4]),
        authorizationVersion: Number(v[5]),
        projectIdentityId: String(v[6]),
        projectIdentityGeneration: Number(v[7]),
        workspaceOwnerId: String(v[8]),
        projectName: String(v[9]),
        quarantinedAt: new Date(v[10]).toISOString(),
        repairJournalCanonicalPath: String(v[11]),
        displacementCanonicalRoot: String(v[12]),
        repairBindingDigest: String(v[13]),
        backupPath: String(v[14]),
        backupFilename: String(v[15]),
        backupDevice: String(v[16]),
        backupInode: String(v[17]),
        backupSize: String(v[18]),
        backupMtimeNs: String(v[19]),
        backupReceiptDigest: String(v[20]),
        backupFingerprintDigest: String(v[21]),
        backupLockMarkerPath: String(v[22]),
        backupLockMarkerDigest: String(v[23]),
        backupLockOwned: Boolean(v[24]),
        movePlanDigest: String(v[25]),
        cleanupPlanDigest: null,
        status: 'PROMOTING',
        phase: 'GO_BIT',
        startedAt: now,
        allNewAt: null,
        appliedAt: null,
        evidenceCleanedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      return { rows: [state.repair], mutated: true };
    }

    if (sql.startsWith('UPDATE "ProjectDependencyRepairOperation"')
      && sql.includes("'COMPLETE'")) {
      if (!state.repair || state.repair.phase !== 'EVIDENCE_CLEAN') {
        return { rows: [], mutated: false };
      }
      state.repair.status = 'APPLIED';
      state.repair.phase = 'COMPLETE';
      state.repair.completedAt = now;
      state.repair.updatedAt = now;
      return { rows: [{ repairId: state.repair.repairId }], mutated: true };
    }

    if (sql.startsWith('UPDATE "ProjectDependencyRepairOperation"')) {
      if (!state.repair) return { rows: [], mutated: false };
      const to = values.find((value) => PHASES.includes(value));
      if (!to) throw new Error(`Crash fixture could not resolve repair phase SQL: ${sql}`);
      const from = [...values].reverse().find((value) => PHASES.includes(value));
      if (state.repair.phase !== from) return { rows: [], mutated: false };
      state.repair.phase = to;
      state.repair.updatedAt = now;
      if (to === 'ALL_NEW') state.repair.allNewAt = now;
      if (to === 'APPLIED') state.repair.appliedAt = now;
      if (to === 'EVIDENCE_CLEAN') {
        state.repair.evidenceCleanedAt = now;
        state.repair.cleanupPlanDigest = values.find((value) => (
          typeof value === 'string'
          && /^[0-9a-f]{64}$/.test(value)
          && value !== state.repair.repairBindingDigest
        )) || null;
      }
      return { rows: [state.repair], mutated: true };
    }

    if (sql.startsWith('UPDATE "ProjectDependencyPromotionDecision"')) {
      if (!state.decision || state.decision.status !== 'AUTHORIZED') {
        return { rows: [], mutated: false };
      }
      state.decision.status = 'APPLIED';
      state.decision.appliedAt = now;
      state.decision.updatedAt = now;
      return { rows: [state.decision], mutated: true };
    }
    if (sql.startsWith('DELETE FROM "ProjectDependencyPromotionDecision"')) {
      if (!state.decision || state.decision.status !== 'APPLIED') {
        return { rows: [], mutated: false };
      }
      const operationId = state.decision.operationId;
      state.decision = null;
      return { rows: [{ operationId }], mutated: true };
    }
    throw new Error(`Crash fixture received unexpected SQL: ${sql}`);
  };

  const database: any = {
    $queryRaw: async (statement: any) => {
      const state = read();
      const outcome = query(state, statement);
      if (outcome.mutated) write(state);
      return outcome.rows;
    },
    $transaction: async (callback: (transaction: any) => Promise<any>) => {
      const state = read();
      const transaction = {
        $queryRaw: async (statement: any) => query(state, statement).rows,
      };
      const result = await callback(transaction);
      write(state);
      return result;
    },
  };
  return { database, read, write };
}

function createBackup(backupRoot: string) {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupRoot, 0o700);
  const backupPath = path.join(backupRoot, 'portal-comprehensive-backup.tar.gz');
  fs.writeFileSync(backupPath, 'fixture-comprehensive-backup\n', { mode: 0o600 });
  fs.chmodSync(backupPath, 0o600);
  const receipt = Buffer.from('{"schemaVersion":1,"verified":true}\n');
  fs.writeFileSync(`${backupPath}.receipt.json`, receipt, { mode: 0o600 });
  fs.chmodSync(`${backupPath}.receipt.json`, 0o600);
  const stat = fs.lstatSync(backupPath, { bigint: true });
  const base = {
    path: backupPath,
    filename: path.basename(backupPath),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    receiptDigest: crypto.createHash('sha256').update(receipt).digest('hex'),
  };
  return {
    ...base,
    fingerprintDigest: crypto.createHash('sha256').update(JSON.stringify(base), 'utf8').digest('hex'),
  };
}

function spawnCleanupWatchdog(input: FixtureInput, journalPath: string): void {
  const observationPath = path.join(input.backupRoot, 'cleanup-partial-observation.json');
  const script = String.raw`
    const fs = require('fs');
    const [journalPath, parentPid, expectedRaw, observationPath] = process.argv.slice(1);
    const expected = Number(expectedRaw);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const countFiles = (root) => {
      let count = 0;
      let changedDuringWalk = false;
      const pending = [root];
      while (pending.length) {
        const next = pending.pop();
        let entries;
        try { entries = fs.readdirSync(next, { withFileTypes: true }); }
        catch {
          changedDuringWalk = true;
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) pending.push(next + '/' + entry.name);
          else count += 1;
        }
      }
      return { count, changedDuringWalk, rootExists: fs.existsSync(root) };
    };
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const step = journal.movePlan.steps.find((candidate) =>
          candidate.kind === 'DISPLACE_TARGET'
          && candidate.artifact === 'node_modules'
          && candidate.phase === 'CLEANUP_INTENT');
        if (step) {
          const observation = countFiles(step.destinationCanonicalPath);
          if (observation.rootExists
            && ((observation.count > 0 && observation.count < expected)
              || observation.changedDuringWalk)) {
            fs.writeFileSync(observationPath, JSON.stringify({ ...observation, expected }) + '\n', {
              flag: 'wx', mode: 0o600,
            });
            process.kill(Number(parentPid), 'SIGKILL');
            process.exit(0);
          }
        }
      } catch {}
      Atomics.wait(sleeper, 0, 0, 1);
    }
    try { process.kill(Number(parentPid), 'SIGKILL'); } catch {}
    process.exit(2);
  `;
  const child = spawn(
    process.execPath,
    [
      '-e', script, journalPath, String(process.pid), String(input.cleanupInitialFiles || 1),
      observationPath,
    ],
    { stdio: 'ignore' },
  );
  child.unref();
}

function validateInput(input: FixtureInput): string {
  const root = fs.realpathSync.native(input.root);
  if (!path.basename(root).startsWith('project-dependency-repair-crash-')) {
    throw new Error('Dependency repair crash fixture requires an isolated mkdtemp root');
  }
  for (const candidate of [input.workspace, input.destination, input.stateFile, input.backupRoot]) {
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('Dependency repair crash fixture path escapes its isolated root');
    }
  }
  return root;
}

async function main(): Promise<void> {
  const raw = process.env.PROJECT_DEPENDENCY_REPAIR_CRASH_FIXTURE;
  if (!raw) throw new Error('Missing dependency repair crash fixture configuration');
  const input = JSON.parse(raw) as FixtureInput;
  const root = validateInput(input);
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ||= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
  process.env.PORTAL_PROJECTS_ROOT = root;
  process.env.PORTAL_OPERATION_LOCK_FILE = path.join(root, 'locks', 'installer.lock');

  const repair = await import('./projectDependencyRepair');
  const lifecycle = await import('./project-lifecycle.service');
  const deletionLocks = await import('./projectDeletionLock');
  const backups = await import('./backup.service');
  const durable = fileDatabase(input.stateFile);

  const backupLock = await backups.acquireBackupMutationLock({
    operationLockPath: path.join(root, 'locks', 'installer.lock'),
    stateDirectory: path.join(root, 'backup-state'),
    timeoutSeconds: 10,
  });
  try {
    if (input.mode === 'recover') {
      const inspection = await repair.inspectProjectDependencyRepairStartupEvidence({
        projectsRoot: root,
        database: durable.database,
      });
      const outcome = await repair.recoverInterruptedProjectDependencyRepairs({
        expectedInspection: inspection,
        reverifyBackup: async () => true,
        assertExclusiveLease: () => backups.assertBackupMutationLockLease(backupLock.lease),
        database: durable.database,
      });
      const after = await repair.inspectProjectDependencyRepairStartupEvidence({
        projectsRoot: root,
        database: durable.database,
      });
      if (input.resultFile) atomicWriteJson(input.resultFile, { outcome, before: inspection, after });
      return;
    }

    const destinationStat = fs.lstatSync(input.destination, { bigint: true });
    const owner = path.basename(path.dirname(input.destination));
    const projectName = path.basename(input.destination);
    const proof = {
      projectIdentityId: `identity-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}`,
      projectIdentityGeneration: 7,
      workspaceOwnerId: owner,
      projectName,
      canonicalRoot: fs.realpathSync.native(input.destination),
      rootDevice: destinationStat.dev.toString(),
      rootInode: destinationStat.ino.toString(),
      rootBirthtimeNs: destinationStat.birthtimeNs.toString(),
    };
    const promotion = await lifecycle.prepareProjectLifecycleArtifactPromotion(
      input.workspace,
      input.destination,
      ['node_modules', 'package-lock.json', '.deps-installed'],
      proof,
    );
    const quarantinedAt = new Date(Date.now() - 60_000);
    const now = new Date().toISOString();
    const decision = {
      operationId: promotion.manifest.operationId,
      actorUserId: owner,
      sessionId: 'repair-crash-fixture-session',
      authorizationVersion: 1,
      projectIdentityId: proof.projectIdentityId,
      projectIdentityGeneration: proof.projectIdentityGeneration,
      workspaceOwnerId: owner,
      projectName,
      operationParentCanonicalRoot: promotion.manifest.operationParentCanonicalRoot,
      operationParentDevice: promotion.manifest.operationParentIdentity.device,
      operationParentInode: promotion.manifest.operationParentIdentity.inode,
      operationParentBirthtimeNs: promotion.manifest.operationParentIdentity.birthtimeNs,
      operationParentMode: promotion.manifest.operationParentIdentity.mode,
      operationParentUid: promotion.manifest.operationParentIdentity.uid,
      operationParentGid: promotion.manifest.operationParentIdentity.gid,
      destinationCanonicalRoot: promotion.manifest.destinationCanonicalRoot,
      destinationRootDevice: promotion.manifest.destinationIdentity.device,
      destinationRootInode: promotion.manifest.destinationIdentity.inode,
      destinationRootBirthtimeNs: promotion.manifest.destinationIdentity.birthtimeNs,
      manifestDigest: promotion.manifest.manifestDigest,
      manifest: promotion.manifest,
      status: 'AUTHORIZED',
      authorizedAt: now,
      appliedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    durable.write({
      schemaVersion: 1,
      actor: { userId: owner, sessionId: 'repair-crash-fixture-session', authorizationVersion: 1 },
      decision,
      lifecycle: {
        id: proof.projectIdentityId,
        workspaceOwnerId: owner,
        projectName,
        canonicalRoot: proof.canonicalRoot,
        rootDevice: proof.rootDevice,
        rootInode: proof.rootInode,
        rootBirthtimeNs: proof.rootBirthtimeNs,
        generation: proof.projectIdentityGeneration,
        lifecycleStatus: 'DEPENDENCY_QUARANTINED',
        dependencyQuarantinedAt: quarantinedAt.toISOString(),
        createdAt: now,
        updatedAt: now,
      },
      repair: null,
    });

    const backup = createBackup(input.backupRoot);
    const backupPin = repair.createOrAttestProjectDependencyRepairBackupLock({
      repairId: input.repairId,
      backup,
      binding: {
        projectIdentityId: proof.projectIdentityId,
        projectIdentityGeneration: proof.projectIdentityGeneration,
        workspaceOwnerId: owner,
        projectName,
        promotionOperationId: decision.operationId,
        manifestDigest: decision.manifestDigest,
      },
      lease: backupLock.lease,
    });
    const prepared = repair.prepareProjectDependencyRepairEvidence({
      repairId: input.repairId,
      decision,
      quarantinedAt,
      backup,
      backupLock: backupPin,
    });
    await repair.authorizeProjectDependencyForceForward({
      repairId: input.repairId,
      actor: {
        userId: owner,
        email: 'owner@fixture.invalid',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
        authorizationVersion: 1,
        sessionId: 'repair-crash-fixture-session',
      } as any,
      decision,
      quarantinedAt,
      backup,
      repairBindingDigest: prepared.repairBindingDigest,
      database: durable.database,
    });
    if (input.checkpoint === 'after-go-bit') process.kill(process.pid, 'SIGKILL');
    if (input.checkpoint === 'external-cleanup-partial') {
      spawnCleanupWatchdog(input, prepared.journal.repairJournalCanonicalPath);
    }
    const lifecycleLock = await deletionLocks.acquireProjectDeletionLockWithoutGuard(
      deletionLocks.projectDeletionLockKey(owner, projectName),
    );
    try {
      await repair.executeProjectDependencyForceForward({
        repairId: input.repairId,
        lifecycleLock,
        reverifyBackup: async () => true,
        assertExclusiveLease: () => backups.assertBackupMutationLockLease(backupLock.lease),
        checkpoint: (checkpoint) => {
          if (checkpoint === input.checkpoint) process.kill(process.pid, 'SIGKILL');
        },
        database: durable.database,
      });
    } finally {
      lifecycleLock();
    }
  } finally {
    await backupLock.release();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
