import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../config/env', () => ({ config: { portalProjectRuntimeImageId: '' } }));
jest.mock('../config/database', () => ({ prisma: {} }));

import {
  prepareProjectLifecycleArtifactPromotion,
  inspectProjectDependencyPromotionStartupEvidence,
  recoverInterruptedProjectLifecycleArtifactPromotion,
  recoverInterruptedProjectLifecycleArtifactPromotions,
  type ProjectLifecycleArtifactPromotionCheckpoint,
  type ProjectLifecycleArtifactPromotionProjectProof,
} from './project-lifecycle.service';
import { buildProjectDependencyPromotionManifest } from './projectDependencyPromotionManifest';

describe('prepared Project lifecycle artifact promotion', () => {
  let testRoot = '';

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-artifact-promotion-test-'));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function fixture() {
    const workspace = path.join(testRoot, 'workspace');
    const destination = path.join(testRoot, 'destination');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(destination, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'new.js'), 'new');
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(workspace, '.deps-installed'), 'new-digest');
    fs.writeFileSync(path.join(destination, 'node_modules', 'old.js'), 'old');
    fs.writeFileSync(path.join(destination, 'package-lock.json'), '{"lockfileVersion":2}');
    fs.writeFileSync(path.join(destination, '.deps-installed'), 'old-digest');
    return { workspace, destination };
  }

  function crashFixture() {
    fs.rmSync(testRoot, { recursive: true, force: true });
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-artifact-promotion-crash-'));
    const ownerName = `owner-${path.basename(testRoot).replace(/[^a-zA-Z0-9]/g, '').slice(-20)}`;
    const ownerRoot = path.join(testRoot, ownerName);
    const workspace = path.join(testRoot, 'workspace');
    const destination = path.join(ownerRoot, 'destination');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(destination, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'new.js'), 'new');
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(workspace, '.deps-installed'), 'new-digest');
    fs.writeFileSync(path.join(destination, 'node_modules', 'old.js'), 'old');
    fs.writeFileSync(path.join(destination, 'package-lock.json'), '{"lockfileVersion":2}');
    fs.writeFileSync(path.join(destination, '.deps-installed'), 'old-digest');
    return {
      ownerRoot,
      workspace,
      destination,
      decisionFile: path.join(ownerRoot, '.promotion-decision.json'),
    };
  }

  const artifacts = ['node_modules', 'package-lock.json', '.deps-installed'];

  function projectProof(destination: string): ProjectLifecycleArtifactPromotionProjectProof {
    const stat = fs.lstatSync(destination, { bigint: true });
    return {
      projectIdentityId: '00000000-0000-4000-8000-000000000099',
      projectIdentityGeneration: 1,
      workspaceOwnerId: path.basename(path.dirname(destination)),
      projectName: path.basename(destination),
      canonicalRoot: fs.realpathSync.native(destination),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      rootBirthtimeNs: stat.birthtimeNs.toString(),
    };
  }

  function runCrashFixture(input: {
    root: string;
    workspace: string;
    destination: string;
    mode: 'prepare' | 'commit' | 'recover-project' | 'recover-startup';
    checkpoint?: ProjectLifecycleArtifactPromotionCheckpoint | 'after-decision';
    decisionFile: string;
  }) {
    const decisionMode = process.env.BRIDGESLLM_PROMOTION_CRASH_POSTGRES === '1'
      ? 'postgres'
      : 'file';
    return spawnSync(process.execPath, [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'projectLifecycleArtifactPromotion.crash-fixture.ts'),
    ], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL
          || 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
        PROJECT_ARTIFACT_PROMOTION_CRASH_FIXTURE: JSON.stringify({
          ...input,
          artifacts,
          decisionMode,
          sessionId: `session-${path.basename(input.root).replace(/[^a-zA-Z0-9]/g, '').slice(-24)}`,
        }),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  function spawnPausedCrashFixture(input: {
    root: string;
    workspace: string;
    destination: string;
    decisionFile: string;
    pauseCheckpoint: ProjectLifecycleArtifactPromotionCheckpoint;
    pauseReadyFile: string;
    pauseReleaseFile: string;
  }) {
    return spawn(process.execPath, [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'projectLifecycleArtifactPromotion.crash-fixture.ts'),
    ], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL
          || 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
        PROJECT_ARTIFACT_PROMOTION_CRASH_FIXTURE: JSON.stringify({
          ...input,
          mode: 'prepare',
          artifacts,
          decisionMode: 'file',
          sessionId: `session-${path.basename(input.root).replace(/[^a-zA-Z0-9]/g, '').slice(-24)}`,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async function waitForPath(file: string, child: ReturnType<typeof spawn>): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(file)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Paused crash fixture exited early: ${JSON.stringify({
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        })}`);
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for paused crash fixture');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForChild(child: ReturnType<typeof spawn>): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }> {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    return new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
  }

  function expectOld(destination: string): void {
    expect(fs.readFileSync(path.join(destination, 'node_modules', 'old.js'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(destination, 'node_modules', 'new.js'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":2}');
    expect(fs.readFileSync(path.join(destination, '.deps-installed'), 'utf8')).toBe('old-digest');
  }

  function expectNew(destination: string): void {
    expect(fs.existsSync(path.join(destination, 'node_modules', 'old.js'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'node_modules', 'new.js'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(destination, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}');
    expect(fs.readFileSync(path.join(destination, '.deps-installed'), 'utf8')).toBe('new-digest');
  }

  function expectSigkill(result: ReturnType<typeof spawnSync>): void {
    if (result.signal !== 'SIGKILL') {
      throw new Error(`Crash fixture did not SIGKILL: ${JSON.stringify({
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stderr: String(result.stderr || '').slice(0, 4_096),
      })}`);
    }
  }

  function emptyDecisionDatabase() {
    const database: any = {
      $queryRaw: jest.fn(async () => []),
    };
    database.$transaction = jest.fn(async (callback: (transaction: any) => Promise<unknown>) => (
      callback(database)
    ));
    return database;
  }

  function inspectionDatabase(input: {
    decisions?: any[];
    lifecycles?: any[];
  } = {}) {
    const database: any = {
      $queryRaw: jest.fn(async (statement: any) => {
        const sql = Array.from(statement?.strings || []).join(' ');
        if (sql.includes('FROM "ProjectDependencyPromotionDecision"')) {
          return input.decisions || [];
        }
        if (sql.includes('FROM "ProjectIdentity"')) return input.lifecycles || [];
        throw new Error(`Unexpected startup inspection SQL: ${sql.slice(0, 160)}`);
      }),
    };
    database.$transaction = jest.fn(async (callback: (transaction: any) => Promise<unknown>) => (
      callback(database)
    ));
    return database;
  }

  function lifecycleRow(
    destination: string,
    status: 'DEPENDENCY_PROMOTING' | 'DEPENDENCY_QUARANTINED' = 'DEPENDENCY_PROMOTING',
  ) {
    const proof = projectProof(destination);
    return {
      id: proof.projectIdentityId,
      workspaceOwnerId: proof.workspaceOwnerId,
      projectName: proof.projectName,
      canonicalRoot: proof.canonicalRoot,
      rootDevice: proof.rootDevice,
      rootInode: proof.rootInode,
      rootBirthtimeNs: proof.rootBirthtimeNs,
      generation: proof.projectIdentityGeneration,
      lifecycleStatus: status,
    };
  }

  function decisionRow(
    manifest: Awaited<ReturnType<typeof prepareProjectLifecycleArtifactPromotion>>['manifest'],
    status: 'AUTHORIZED' | 'APPLIED' = 'APPLIED',
  ) {
    const timestamp = new Date('2026-08-12T00:00:00.000Z');
    return {
      operationId: manifest.operationId,
      actorUserId: manifest.workspaceOwnerId,
      sessionId: 'durable-session-1',
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
      status,
      authorizedAt: timestamp,
      appliedAt: status === 'APPLIED' ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  test('startup evidence inspection is stable and empty without DB or filesystem evidence', async () => {
    const first = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const second = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      hasEvidence: false,
      targets: [],
      containedQuarantines: [],
      unboundEvidence: [],
      uncertainEvidence: [],
    });
    expect(first.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('empty startup evidence remains stable across storage-root timestamp changes', async () => {
    const first = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const timestamp = new Date(Date.now() - 60_000);
    fs.utimesSync(testRoot, timestamp, timestamp);
    const second = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );

    expect(second.snapshotSha256).toBe(first.snapshotSha256);
    expect(second).toEqual(first);
  });

  test('startup evidence digest changes while an added owner namespace remains present', async () => {
    const before = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    fs.mkdirSync(path.join(testRoot, 'owner-added'));
    const added = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const retained = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );

    expect(added.snapshotSha256).not.toBe(before.snapshotSha256);
    expect(retained.snapshotSha256).toBe(added.snapshotSha256);
  });

  test('unbound non-directory namespace metadata churn is not promotion evidence', async () => {
    const unboundNamespace = path.join(testRoot, 'owner-stray-file');
    fs.writeFileSync(unboundNamespace, 'not promotion evidence');
    const first = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const timestamp = new Date(Date.now() - 60_000);
    fs.utimesSync(unboundNamespace, timestamp, timestamp);
    const second = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );

    expect(first.hasEvidence).toBe(false);
    expect(second.snapshotSha256).toBe(first.snapshotSha256);
  });

  test('startup evidence digest changes when namespace permission metadata changes', async () => {
    const originalMode = Number(fs.lstatSync(testRoot, { bigint: true }).mode & 0o777n);
    const before = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    try {
      fs.chmodSync(testRoot, originalMode ^ 0o040);
      const after = await inspectProjectDependencyPromotionStartupEvidence(
        testRoot,
        emptyDecisionDatabase(),
      );
      expect(after.snapshotSha256).not.toBe(before.snapshotSha256);
    } finally {
      fs.chmodSync(testRoot, originalMode);
    }
  });

  test('startup evidence digest changes when the empty storage-root identity is replaced', async () => {
    const displacedRoot = `${testRoot}-displaced`;
    const before = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    fs.renameSync(testRoot, displacedRoot);
    fs.mkdirSync(testRoot);
    try {
      const after = await inspectProjectDependencyPromotionStartupEvidence(
        testRoot,
        emptyDecisionDatabase(),
      );
      expect(after.snapshotSha256).not.toBe(before.snapshotSha256);
    } finally {
      fs.rmSync(displacedRoot, { recursive: true, force: true });
    }
  });

  test('startup evidence inspection binds PREPARED journal, preparation, and staging to one exact Project', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );

    const first = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const second = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(second.snapshotSha256).toBe(first.snapshotSha256);
    expect(first.hasEvidence).toBe(true);
    expect(first.targets).toHaveLength(1);
    expect(first.targets[0]).toMatchObject({
      projectIdentityId: projectProof(destination).projectIdentityId,
      workspaceOwnerId: projectProof(destination).workspaceOwnerId,
      projectName: projectProof(destination).projectName,
      operationIds: [promotion.manifest.operationId],
    });
    expect(first.targets[0].sources.map((source) => source.kind)).toEqual(
      expect.arrayContaining(['journal', 'preparation', 'staging']),
    );
    expect(first.uncertainEvidence).toEqual([]);
    await promotion.cleanup();
  });

  test('PREPARED startup evidence remains stable across owner-directory timestamp changes', async () => {
    const { workspace, destination, ownerRoot } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const first = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const timestamp = new Date(Date.now() - 60_000);
    fs.utimesSync(ownerRoot, timestamp, timestamp);
    const second = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );

    expect(second.snapshotSha256).toBe(first.snapshotSha256);
    await promotion.cleanup();
  });

  test('startup evidence inspection changes digest when an evidence file is rewritten', async () => {
    const { workspace, destination, ownerRoot } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const before = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    const journal = fs.readdirSync(ownerRoot)
      .map((name) => path.join(ownerRoot, name))
      .find((candidate) => candidate.endsWith('.journal.json'))!;
    const content = fs.readFileSync(journal);
    fs.writeFileSync(journal, content);
    const after = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(after.snapshotSha256).not.toBe(before.snapshotSha256);
    await promotion.cleanup();
  });

  test('startup evidence inspection changes digest when nested staged content changes', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const before = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    fs.writeFileSync(
      path.join(promotion.manifest.stagingCanonicalRoot, 'artifacts', 'node_modules', 'new.js'),
      'nested writer changed this generation',
    );
    const after = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(after.snapshotSha256).not.toBe(before.snapshotSha256);
    await promotion.cleanup();
  });

  test('startup evidence inspection fingerprints distinct malformed journal bytes', async () => {
    const { workspace, destination, ownerRoot } = crashFixture();
    await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const journal = fs.readdirSync(ownerRoot)
      .map((name) => path.join(ownerRoot, name))
      .find((candidate) => candidate.endsWith('.journal.json'))!;
    fs.writeFileSync(journal, '{"broken":1}\n', { mode: 0o600 });
    fs.chmodSync(journal, 0o600);
    const first = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    fs.writeFileSync(journal, '{"broken":2}\n', { mode: 0o600 });
    fs.chmodSync(journal, 0o600);
    const second = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(first.uncertainEvidence).toContainEqual(expect.objectContaining({
      code: expect.stringMatching(/^JOURNAL_/),
      canonicalPath: journal,
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(second.snapshotSha256).not.toBe(first.snapshotSha256);
  });

  test('startup evidence inspection binds replacement-resistant staged inode topology', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const stagingRoot = promotion.manifest.stagingCanonicalRoot;
    const displaced = `${stagingRoot}.displaced`;
    const before = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    fs.renameSync(stagingRoot, displaced);
    fs.cpSync(displaced, stagingRoot, { recursive: true, dereference: false });
    const after = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(after.snapshotSha256).not.toBe(before.snapshotSha256);
    expect(after.uncertainEvidence).toContainEqual(expect.objectContaining({
      code: expect.stringMatching(/^STAGING_/),
      canonicalPath: stagingRoot,
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  test('a same-operation journal for another exact Project cannot satisfy an authorized decision', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const otherOwnerRoot = path.join(testRoot, 'owner-other');
    const otherDestination = path.join(otherOwnerRoot, 'other-project');
    fs.mkdirSync(otherDestination, { recursive: true });
    const ownerStat = fs.lstatSync(otherOwnerRoot, { bigint: true });
    const destinationStat = fs.lstatSync(otherDestination, { bigint: true });
    const identity = (stat: fs.BigIntStats, kind: 'directory' | 'file') => ({
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      kind,
      mode: Number(stat.mode & 0o777n),
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      birthtimeNs: stat.birthtimeNs.toString(),
    });
    const conflictingManifest = buildProjectDependencyPromotionManifest({
      ...promotion.manifest,
      workspaceOwnerId: 'owner-other',
      projectName: 'other-project',
      projectIdentityId: '00000000-0000-4000-8000-000000000100',
      operationParentCanonicalRoot: otherOwnerRoot,
      operationParentIdentity: identity(ownerStat, 'directory'),
      destinationCanonicalRoot: otherDestination,
      destinationIdentity: identity(destinationStat, 'directory'),
      projectRootBirthtimeNs: destinationStat.birthtimeNs.toString(),
      stagingCanonicalRoot: path.join(
        otherOwnerRoot,
        `.bridgesllm-project-promotion-${promotion.manifest.operationId}`,
      ),
    });
    const inspection = await inspectProjectDependencyPromotionStartupEvidence(testRoot, inspectionDatabase({
      decisions: [decisionRow(conflictingManifest, 'AUTHORIZED')],
      lifecycles: [lifecycleRow(otherDestination)],
    }));
    expect(inspection.uncertainEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOURNAL_DECISION_SNAPSHOT_CONFLICT' }),
      expect.objectContaining({ code: 'AUTHORIZED_DECISION_WITHOUT_JOURNAL' }),
    ]));
  });

  test('startup evidence inspection identifies a COPYING preparation without guessing by name', async () => {
    const fixture = crashFixture();
    const result = runCrashFixture({
      root: testRoot,
      workspace: fixture.workspace,
      destination: fixture.destination,
      mode: 'prepare',
      checkpoint: 'after-preparation-create',
      decisionFile: fixture.decisionFile,
    });
    expectSigkill(result);

    const inspection = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(inspection.targets).toHaveLength(1);
    expect(inspection.targets[0].sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'preparation', state: 'COPYING' }),
      expect.objectContaining({ kind: 'staging', state: 'COPYING' }),
    ]));
    expect(inspection.uncertainEvidence).toEqual([]);
  });

  test('startup evidence inspection treats APPLIED without a journal as decision-bound evidence', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const manifest = promotion.manifest;
    await promotion.cleanup();
    const inspection = await inspectProjectDependencyPromotionStartupEvidence(testRoot, inspectionDatabase({
      decisions: [decisionRow(manifest, 'APPLIED')],
      lifecycles: [lifecycleRow(destination)],
    }));

    expect(inspection.targets).toHaveLength(1);
    expect(inspection.targets[0]).toMatchObject({
      decisionStatus: 'APPLIED',
      lifecycleStatus: 'DEPENDENCY_PROMOTING',
      operationIds: [manifest.operationId],
    });
    expect(inspection.targets[0].sources.map((source) => source.kind)).toEqual([
      'decision',
      'lifecycle',
      'topology',
    ]);
    expect(inspection.uncertainEvidence).toEqual([]);
  });

  test('startup evidence inspection retains a lifecycle-only fence as an exact unsafe target', async () => {
    const { destination } = crashFixture();
    const inspection = await inspectProjectDependencyPromotionStartupEvidence(testRoot, inspectionDatabase({
      lifecycles: [lifecycleRow(destination, 'DEPENDENCY_QUARANTINED')],
    }));

    expect(inspection.targets).toHaveLength(1);
    expect(inspection.containedQuarantines).toHaveLength(1);
    expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
      code: 'LIFECYCLE_WITHOUT_DECISION',
      canonicalPath: destination,
    }));
  });

  test('startup evidence inspection fingerprints dependency bytes for lifecycle-only containment', async () => {
    const { destination } = crashFixture();
    const database = inspectionDatabase({
      lifecycles: [lifecycleRow(destination, 'DEPENDENCY_QUARANTINED')],
    });
    const before = await inspectProjectDependencyPromotionStartupEvidence(testRoot, database);
    fs.writeFileSync(path.join(destination, 'node_modules', 'old.js'), 'changed-in-place');
    const after = await inspectProjectDependencyPromotionStartupEvidence(testRoot, database);
    expect(after.snapshotSha256).not.toBe(before.snapshotSha256);
  });

  test('startup evidence inspection never attests a DB-bound root outside Project storage', async () => {
    const { destination } = crashFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-outside-root-'));
    const outsideStat = fs.lstatSync(outside, { bigint: true });
    const escapedLifecycle = {
      ...lifecycleRow(destination),
      canonicalRoot: outside,
      rootDevice: outsideStat.dev.toString(),
      rootInode: outsideStat.ino.toString(),
      rootBirthtimeNs: outsideStat.birthtimeNs.toString(),
    };
    try {
      const inspection = await inspectProjectDependencyPromotionStartupEvidence(testRoot, inspectionDatabase({
        lifecycles: [escapedLifecycle],
      }));
      expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
        code: 'BOUND_TARGET_STORAGE_PATH_UNSAFE',
        canonicalPath: outside,
      }));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('startup evidence inspection never reads a corrupt DB-bound root outside Project storage', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const outsideParent = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-outside-unread-'));
    const outside = path.join(outsideParent, 'foreign-project');
    const outsideStaging = path.join(
      outsideParent,
      `.bridgesllm-project-promotion-${promotion.manifest.operationId}`,
    );
    fs.mkdirSync(outside);
    const outsideParentStat = fs.lstatSync(outsideParent, { bigint: true });
    const outsideIdentity = {
      device: outsideParentStat.dev.toString(),
      inode: outsideParentStat.ino.toString(),
      kind: 'directory' as const,
      mode: Number(outsideParentStat.mode & 0o777n),
      uid: Number(outsideParentStat.uid),
      gid: Number(outsideParentStat.gid),
      birthtimeNs: outsideParentStat.birthtimeNs.toString(),
    };
    const outsideFile = path.join(outside, 'secret');
    fs.writeFileSync(outsideFile, 'must-not-be-read');
    const corruptManifest = buildProjectDependencyPromotionManifest({
      ...promotion.manifest,
      operationParentCanonicalRoot: outsideParent,
      operationParentIdentity: outsideIdentity,
      destinationCanonicalRoot: outside,
      stagingCanonicalRoot: outsideStaging,
    });
    const lstatSpy = jest.spyOn(fs, 'lstatSync');
    const openSpy = jest.spyOn(fs, 'openSync');
    try {
      const inspection = await inspectProjectDependencyPromotionStartupEvidence(testRoot, inspectionDatabase({
        decisions: [decisionRow(corruptManifest, 'APPLIED')],
      }));
      expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
        code: 'BOUND_TARGET_STORAGE_PATH_UNSAFE',
        canonicalPath: outside,
      }));
      expect(lstatSpy.mock.calls.some(([candidate]) => String(candidate).startsWith(outside))).toBe(false);
      expect(openSpy.mock.calls.some(([candidate]) => String(candidate).startsWith(outside))).toBe(false);
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
      await promotion.cleanup();
      fs.rmSync(outsideParent, { recursive: true, force: true });
    }
  });

  test('startup evidence inspection reports private unbound staging without assigning an operation or Project', async () => {
    const ownerRoot = path.join(testRoot, 'owner-unbound');
    fs.mkdirSync(ownerRoot, { recursive: true });
    const operationId = '11111111-1111-4111-8111-111111111111';
    const stagingRoot = path.join(ownerRoot, `.bridgesllm-project-promotion-${operationId}`);
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    fs.chmodSync(stagingRoot, 0o700);
    const temporary = path.join(
      stagingRoot,
      `..preparation.json.${process.pid}.22222222-2222-4222-8222-222222222222.tmp`,
    );
    fs.writeFileSync(temporary, '{}\n', { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);

    const inspection = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(inspection.targets).toEqual([]);
    expect(inspection.unboundEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'staging', operationId: null, safeCleanupCandidate: true }),
      expect.objectContaining({ kind: 'preparation_temporary', operationId: null, safeCleanupCandidate: true }),
    ]));
    expect(inspection.uncertainEvidence).toEqual([]);
  });

  test('startup evidence inspection preserves unsafe unbound staging and reports uncertainty', async () => {
    const ownerRoot = path.join(testRoot, 'owner-unsafe');
    fs.mkdirSync(ownerRoot, { recursive: true });
    const stagingRoot = path.join(
      ownerRoot,
      '.bridgesllm-project-promotion-33333333-3333-4333-8333-333333333333',
    );
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    fs.chmodSync(stagingRoot, 0o700);
    fs.writeFileSync(path.join(stagingRoot, 'unexpected'), 'preserve me');

    const inspection = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(inspection.unboundEvidence).toContainEqual(expect.objectContaining({
      kind: 'staging',
      safeCleanupCandidate: false,
    }));
    expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
      code: 'UNBOUND_STAGING_UNSAFE',
    }));
  });

  test('startup evidence inspection never follows a staging symlink', async () => {
    const ownerRoot = path.join(testRoot, 'owner-symlink');
    const outside = path.join(testRoot, 'outside-staging');
    fs.mkdirSync(ownerRoot, { recursive: true });
    fs.mkdirSync(outside, { mode: 0o700 });
    const stagingRoot = path.join(
      ownerRoot,
      '.bridgesllm-project-promotion-44444444-4444-4444-8444-444444444444',
    );
    fs.symlinkSync(outside, stagingRoot);

    const inspection = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(inspection.targets).toEqual([]);
    expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
      canonicalPath: stagingRoot,
      code: expect.stringMatching(/^STAGING_/),
    }));
  });

  test('startup evidence inspection holds on an unbound owner namespace symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-owner-symlink-'));
    const ownerLink = path.join(testRoot, 'owner-symlink');
    fs.symlinkSync(outside, ownerLink);
    try {
      const inspection = await inspectProjectDependencyPromotionStartupEvidence(
        testRoot,
        emptyDecisionDatabase(),
      );
      expect(inspection.hasEvidence).toBe(true);
      expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
        code: 'OWNER_NAMESPACE_SYMLINK',
        canonicalPath: ownerLink,
      }));
    } finally {
      fs.rmSync(ownerLink, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('startup evidence inspection rejects an owner namespace replacement during one sample', async () => {
    const { workspace, destination, ownerRoot } = crashFixture();
    await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const displacedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-owner-swap-'));
    const displacedOwner = path.join(displacedParent, 'displaced-owner');
    const replacementOwner = path.join(displacedParent, 'replacement-owner');
    fs.cpSync(ownerRoot, replacementOwner, { recursive: true, preserveTimestamps: true });
    const originalReaddir = fs.readdirSync.bind(fs);
    let ownerDescriptorPath: string | null = null;
    let ownerDescriptorReads = 0;
    const readdirSpy = jest.spyOn(fs, 'readdirSync').mockImplementation(((candidate: any, options?: any) => {
      const accessPath = String(candidate);
      if (accessPath.startsWith('/proc/self/fd/')) {
        let resolved: string | null = null;
        try {
          resolved = fs.realpathSync.native(accessPath);
        } catch {
          // The production inspection will report a vanished descriptor target.
        }
        if (!ownerDescriptorPath && resolved === ownerRoot) ownerDescriptorPath = accessPath;
        if (ownerDescriptorPath === accessPath) {
          ownerDescriptorReads += 1;
          if (ownerDescriptorReads === 2) {
            fs.renameSync(ownerRoot, displacedOwner);
            fs.renameSync(replacementOwner, ownerRoot);
          }
        }
      }
      return (originalReaddir as any)(candidate, options);
    }) as typeof fs.readdirSync);
    try {
      await expect(inspectProjectDependencyPromotionStartupEvidence(
        testRoot,
        emptyDecisionDatabase(),
      )).rejects.toThrow(/storage root changed during startup inspection/i);
    } finally {
      readdirSpy.mockRestore();
      fs.rmSync(displacedParent, { recursive: true, force: true });
    }
  });

  test('startup evidence inspection rejects replacement of the canonical storage root', async () => {
    const { workspace, destination } = crashFixture();
    await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const originalRoot = testRoot;
    const displacedRoot = `${originalRoot}-displaced`;
    const replacementRoot = `${originalRoot}-replacement`;
    fs.cpSync(originalRoot, replacementRoot, { recursive: true, preserveTimestamps: true });
    const originalReaddir = fs.readdirSync.bind(fs);
    let rootDescriptorPath: string | null = null;
    let rootDescriptorReads = 0;
    const readdirSpy = jest.spyOn(fs, 'readdirSync').mockImplementation(((candidate: any, options?: any) => {
      const accessPath = String(candidate);
      if (accessPath.startsWith('/proc/self/fd/')) {
        let resolved: string | null = null;
        try {
          resolved = fs.realpathSync.native(accessPath);
        } catch {
          // The production inspection will reject the lost canonical binding.
        }
        if (!rootDescriptorPath && resolved === originalRoot) rootDescriptorPath = accessPath;
        if (rootDescriptorPath === accessPath) {
          rootDescriptorReads += 1;
          if (rootDescriptorReads === 2) {
            fs.renameSync(originalRoot, displacedRoot);
            fs.renameSync(replacementRoot, originalRoot);
          }
        }
      }
      return (originalReaddir as any)(candidate, options);
    }) as typeof fs.readdirSync);
    try {
      await expect(inspectProjectDependencyPromotionStartupEvidence(
        originalRoot,
        emptyDecisionDatabase(),
      )).rejects.toThrow(/storage root changed during startup inspection/i);
    } finally {
      readdirSpy.mockRestore();
      fs.rmSync(displacedRoot, { recursive: true, force: true });
      fs.rmSync(replacementRoot, { recursive: true, force: true });
    }
  });

  test('startup evidence inspection never blocks on FIFO evidence', async () => {
    const ownerRoot = path.join(testRoot, 'owner-fifo');
    fs.mkdirSync(ownerRoot, { recursive: true });
    const fifo = path.join(
      ownerRoot,
      '.bridgesllm-project-promotion-77777777-7777-4777-8777-777777777777.journal.json',
    );
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5_000 });
    expect(created.status).toBe(0);
    const inspection = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
      canonicalPath: fifo,
      code: expect.stringMatching(/^JOURNAL_/),
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  test('startup evidence inspection binds copied records to the original owner inode', async () => {
    const { workspace, destination, ownerRoot } = crashFixture();
    await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const copiedOwner = `${ownerRoot}-copy`;
    fs.cpSync(ownerRoot, copiedOwner, { recursive: true, preserveTimestamps: true });
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.renameSync(copiedOwner, ownerRoot);

    const inspection = await inspectProjectDependencyPromotionStartupEvidence(
      testRoot,
      emptyDecisionDatabase(),
    );
    expect(inspection.uncertainEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: expect.stringMatching(/^(JOURNAL|PREPARATION)_TOPOLOGY_/),
        workspaceOwnerId: path.basename(ownerRoot),
      }),
    ]));
  });

  test('startup evidence inspection reports conflicting DB identity snapshots without merging them', async () => {
    const { workspace, destination } = crashFixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const manifest = promotion.manifest;
    await promotion.cleanup();
    const conflictingLifecycle = {
      ...lifecycleRow(destination),
      rootInode: String(BigInt(projectProof(destination).rootInode) + 1n),
    };
    const inspection = await inspectProjectDependencyPromotionStartupEvidence(testRoot, inspectionDatabase({
      decisions: [decisionRow(manifest, 'APPLIED')],
      lifecycles: [conflictingLifecycle],
    }));

    expect(inspection.targets).toHaveLength(2);
    expect(inspection.targets.flatMap((target) => (
      target.sources.map((source) => source.kind)
    ))).toEqual(expect.arrayContaining(['decision', 'lifecycle', 'topology']));
    expect(inspection.uncertainEvidence).toContainEqual(expect.objectContaining({
      code: 'BOUND_TARGET_IDENTITY_CONFLICT',
    }));
  });

  test('recursive copies remain outside the live Project until bounded rename commit', async () => {
    const { workspace, destination } = fixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      ['node_modules', 'package-lock.json', '.deps-installed'],
      projectProof(destination),
    );

    expect(fs.readFileSync(path.join(destination, 'node_modules', 'old.js'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(destination, 'node_modules', 'new.js'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, '.deps-installed'), 'utf8')).toBe('old-digest');
    expect(fs.readdirSync(testRoot).some((entry) => entry.startsWith('.bridgesllm-project-promotion-'))).toBe(true);

    promotion.commit();
    promotion.finalize();
    expect(fs.existsSync(path.join(destination, 'node_modules', 'old.js'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'node_modules', 'new.js'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(destination, 'package-lock.json'), 'utf8')).toContain('lockfileVersion');
    expect(fs.readFileSync(path.join(destination, '.deps-installed'), 'utf8')).toBe('new-digest');

    await promotion.cleanup();
    expect(fs.readdirSync(testRoot).some((entry) => entry.startsWith('.bridgesllm-project-promotion-'))).toBe(false);
  });

  test('predecision cleanup retains the exact prior artifacts and removes staging', async () => {
    const { workspace, destination } = fixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      ['node_modules', 'package-lock.json', '.deps-installed'],
      projectProof(destination),
    );

    await promotion.cleanup();
    expect(fs.readFileSync(path.join(destination, 'node_modules', 'old.js'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(destination, 'node_modules', 'new.js'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":2}');
    expect(fs.readFileSync(path.join(destination, '.deps-installed'), 'utf8')).toBe('old-digest');
  });

  test('final preauthorization re-attestation rejects an externally replaced live artifact', async () => {
    const { workspace, destination } = fixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const target = path.join(destination, 'package-lock.json');
    const replacement = path.join(destination, '.replacement-package-lock');
    fs.writeFileSync(replacement, '{"lockfileVersion":999}');
    fs.renameSync(replacement, target);

    expect(() => promotion.reattest()).toThrow(expect.objectContaining({
      code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED',
    }));
    await promotion.cleanup();
    expect(fs.readFileSync(target, 'utf8')).toBe('{"lockfileVersion":999}');
  });

  test('staging-only cleanup never touches a Project root replaced during writer drain', async () => {
    const { workspace, destination } = fixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    const retired = `${destination}.retired`;
    fs.renameSync(destination, retired);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'replacement.txt'), 'replacement-generation');

    expect(() => promotion.reattest()).toThrow();
    await promotion.cleanupPreparedStagingOnly();

    expect(fs.readFileSync(path.join(destination, 'replacement.txt'), 'utf8'))
      .toBe('replacement-generation');
    expect(fs.existsSync(path.join(destination, 'node_modules'))).toBe(false);
    expect(fs.readdirSync(testRoot).some((entry) => (
      entry.startsWith('.bridgesllm-project-promotion-')
    ))).toBe(false);
  });

  test('staging-only cleanup accepts exact evidence already removed by an older guarded waiter', async () => {
    const { workspace, destination } = fixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    fs.rmSync(promotion.manifest.stagingCanonicalRoot, { recursive: true, force: true });
    for (const candidate of fs.readdirSync(promotion.manifest.operationParentCanonicalRoot)) {
      if (
        candidate.includes(promotion.manifest.operationId)
        && candidate.endsWith('.journal.json')
      ) {
        fs.unlinkSync(path.join(promotion.manifest.operationParentCanonicalRoot, candidate));
      }
    }

    await expect(promotion.cleanupPreparedStagingOnly()).resolves.toBeUndefined();
    expectOld(destination);
  });

  test('COMMITTED filesystem evidence without a database decision is quarantined', async () => {
    const { workspace, destination } = fixture();
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      projectProof(destination),
    );
    promotion.commit();
    promotion.finalize();

    await expect(recoverInterruptedProjectLifecycleArtifactPromotion(
      destination,
      emptyDecisionDatabase(),
    )).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED',
    });
    expectNew(destination);
  });

  test('stale Project root birthtime proof is rejected before evidence publication', async () => {
    const { workspace, destination } = fixture();
    const staleProof = { ...projectProof(destination), rootBirthtimeNs: '0' };
    await expect(prepareProjectLifecycleArtifactPromotion(
      workspace,
      destination,
      artifacts,
      staleProof,
    )).rejects.toMatchObject({ code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED' });
    expectOld(destination);
    expect(fs.readdirSync(testRoot).some((name) => name.startsWith('.bridgesllm-project-promotion-')))
      .toBe(false);
  });

  test.each([
    'after-staging-root',
    'after-preparation-temp',
    'after-preparation-create',
    'after-copy:0',
    'after-copy:1',
    'after-copy:2',
    'after-preparation-ready-temp',
    'after-preparation-ready',
    'after-journal-temp',
    'after-journal-create',
  ] as ProjectLifecycleArtifactPromotionCheckpoint[])(
    'real SIGKILL at preparation seam %s leaves live artifacts old and startup discards residue',
    (checkpoint) => {
      const f = crashFixture();
      const killed = runCrashFixture({ ...f, root: testRoot, mode: 'commit', checkpoint });
      expectSigkill(killed);
      expectOld(f.destination);
      const recovered = runCrashFixture({ ...f, root: testRoot, mode: 'recover-startup' });
      expect({ status: recovered.status, stderr: recovered.stderr }).toEqual({ status: 0, stderr: '' });
      expectOld(f.destination);
      expect(fs.readdirSync(f.ownerRoot).filter((name) => name.startsWith('.bridgesllm-project-promotion-'))).toEqual([]);
    },
  );

  test.each([
    'after-decision',
    'after-backup:0', 'after-promote:0',
    'after-backup:1', 'after-promote:1',
    'after-backup:2', 'after-promote:2',
    'after-swapped',
    'before-committed',
    'after-committed-temp',
  ] as Array<ProjectLifecycleArtifactPromotionCheckpoint | 'after-decision'>)(
    'real SIGKILL at post-decision seam %s converges all-new in a fresh process',
    (checkpoint) => {
      const f = crashFixture();
      const killed = runCrashFixture({ ...f, root: testRoot, mode: 'commit', checkpoint });
      expectSigkill(killed);
      const recovered = runCrashFixture({ ...f, root: testRoot, mode: 'recover-project' });
      expect({ status: recovered.status, stderr: recovered.stderr }).toEqual({ status: 0, stderr: '' });
      expectNew(f.destination);
      expect(fs.readdirSync(f.ownerRoot).filter((name) => name.startsWith('.bridgesllm-project-promotion-'))).toEqual([]);
      expect(fs.existsSync(f.decisionFile)).toBe(false);
    },
  );

  test.each([
    'after-committed',
    'after-staging-cleanup',
    'after-journal-cleanup',
  ] as ProjectLifecycleArtifactPromotionCheckpoint[])(
    'real SIGKILL at post-COMMITTED seam %s preserves all-new and cleans idempotently',
    (checkpoint) => {
      const f = crashFixture();
      const killed = runCrashFixture({ ...f, root: testRoot, mode: 'commit', checkpoint });
      expectSigkill(killed);
      const recovered = runCrashFixture({ ...f, root: testRoot, mode: 'recover-startup' });
      expect({ status: recovered.status, stderr: recovered.stderr }).toEqual({ status: 0, stderr: '' });
      expectNew(f.destination);
      expect(fs.readdirSync(f.ownerRoot).filter((name) => name.startsWith('.bridgesllm-project-promotion-'))).toEqual([]);
      expect(fs.existsSync(f.decisionFile)).toBe(false);
    },
  );

  test('startup removes only exact empty pre-record residue and quarantines unknown contents', async () => {
    const f = crashFixture();
    const operation = path.join(f.ownerRoot, '.bridgesllm-project-promotion-00000000-0000-4000-8000-000000000001');
    fs.mkdirSync(operation, { mode: 0o700 });
    await expect(recoverInterruptedProjectLifecycleArtifactPromotions(
      testRoot,
      emptyDecisionDatabase(),
    )).resolves.toMatchObject({
      discarded: 1,
    });
    fs.mkdirSync(operation, { mode: 0o700 });
    fs.writeFileSync(path.join(operation, 'unknown'), 'keep');
    await expect(recoverInterruptedProjectLifecycleArtifactPromotions(
      testRoot,
      emptyDecisionDatabase(),
    )).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED',
    });
    expect(fs.existsSync(path.join(operation, 'unknown'))).toBe(true);
  });

  test('APPLIED without a journal re-attests the durable manifest and quarantines live drift', async () => {
    const f = crashFixture();
    const proof = projectProof(f.destination);
    const promotion = await prepareProjectLifecycleArtifactPromotion(
      f.workspace,
      f.destination,
      artifacts,
      proof,
    );
    promotion.commit();
    promotion.finalize();
    const manifest = promotion.manifest;
    await promotion.cleanup();
    expect(fs.readdirSync(f.ownerRoot).filter((name) => (
      name.startsWith('.bridgesllm-project-promotion-')
    ))).toEqual([]);
    fs.writeFileSync(path.join(f.destination, 'node_modules', 'new.js'), 'externally changed');

    const now = new Date('2026-08-12T12:00:00.000Z');
    const decision = {
      operationId: manifest.operationId,
      actorUserId: proof.workspaceOwnerId,
      sessionId: 'durable-session',
      authorizationVersion: 1,
      projectIdentityId: proof.projectIdentityId,
      projectIdentityGeneration: proof.projectIdentityGeneration,
      workspaceOwnerId: proof.workspaceOwnerId,
      projectName: proof.projectName,
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
      status: 'APPLIED',
      authorizedAt: now,
      appliedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    let lifecycleStatus = 'DEPENDENCY_PROMOTING';
    let deleted = false;
    const database = {
      $queryRaw: jest.fn(async (statement: any) => {
        const sql = Array.from(statement?.strings || []).join(' ');
        if (sql.includes('FROM "ProjectDependencyPromotionDecision"')) {
          return deleted ? [] : [decision];
        }
        if (sql.includes('FROM "ProjectIdentity"')) return [{
          id: proof.projectIdentityId,
          workspaceOwnerId: proof.workspaceOwnerId,
          projectName: proof.projectName,
          canonicalRoot: proof.canonicalRoot,
          rootDevice: proof.rootDevice,
          rootInode: proof.rootInode,
          rootBirthtimeNs: proof.rootBirthtimeNs,
          generation: proof.projectIdentityGeneration,
          lifecycleStatus,
        }];
        if (sql.includes('UPDATE "ProjectIdentity"')
          && sql.includes("'DEPENDENCY_QUARANTINED'")) {
          lifecycleStatus = 'DEPENDENCY_QUARANTINED';
          return [{
            id: proof.projectIdentityId,
            workspaceOwnerId: proof.workspaceOwnerId,
            projectName: proof.projectName,
            canonicalRoot: proof.canonicalRoot,
            rootDevice: proof.rootDevice,
            rootInode: proof.rootInode,
            rootBirthtimeNs: proof.rootBirthtimeNs,
            generation: proof.projectIdentityGeneration,
            lifecycleStatus,
          }];
        }
        if (sql.includes('DELETE FROM "ProjectDependencyPromotionDecision"')) {
          deleted = true;
          return [{ operationId: manifest.operationId }];
        }
        throw new Error(`Unexpected APPLIED recovery SQL: ${sql}`);
      }),
      $transaction: jest.fn(async (callback: (transaction: any) => Promise<any>) => (
        callback(database)
      )),
    } as any;
    const originalProjectsRoot = process.env.PORTAL_PROJECTS_ROOT;
    process.env.PORTAL_PROJECTS_ROOT = testRoot;
    try {
      await expect(recoverInterruptedProjectLifecycleArtifactPromotion(
        f.destination,
        database,
      )).resolves.toEqual({
        rolledBack: 0,
        committed: 0,
        quarantined: 1,
        discarded: 0,
      });
    } finally {
      if (originalProjectsRoot === undefined) delete process.env.PORTAL_PROJECTS_ROOT;
      else process.env.PORTAL_PROJECTS_ROOT = originalProjectsRoot;
    }
    expect(lifecycleStatus).toBe('DEPENDENCY_QUARANTINED');
    expect(deleted).toBe(false);
  });

  test('Project A recovery preserves Project B paused at an unjournaled journal-temp seam', async () => {
    const f = crashFixture();
    const other = path.join(f.ownerRoot, 'other');
    fs.mkdirSync(other);
    const ready = path.join(testRoot, 'pause-ready');
    const release = path.join(testRoot, 'pause-release');
    const child = spawnPausedCrashFixture({
      ...f,
      root: testRoot,
      pauseCheckpoint: 'after-journal-temp',
      pauseReadyFile: ready,
      pauseReleaseFile: release,
    });
    const childResult = waitForChild(child);
    await waitForPath(ready, child);

    try {
      const evidenceNames = fs.readdirSync(f.ownerRoot)
        .filter((name) => name.includes('bridgesllm-project-promotion-'))
        .sort();
      expect(evidenceNames.some((name) => (
        name.startsWith('..bridgesllm-project-promotion-')
        && name.includes('.journal.json.')
        && name.endsWith('.tmp')
      ))).toBe(true);
      expect(evidenceNames.some((name) => name.endsWith('.journal.json'))).toBe(false);
      const evidenceBefore = evidenceNames.map((name) => {
        const candidate = path.join(f.ownerRoot, name);
        const stat = fs.lstatSync(candidate, { bigint: true });
        return { name, inode: stat.ino.toString(), size: stat.size.toString() };
      });

      await expect(recoverInterruptedProjectLifecycleArtifactPromotion(
        other,
        emptyDecisionDatabase(),
      )).resolves.toEqual({
        rolledBack: 0,
        committed: 0,
        quarantined: 0,
        discarded: 0,
      });
      const evidenceAfter = evidenceNames.map((name) => {
        const candidate = path.join(f.ownerRoot, name);
        const stat = fs.lstatSync(candidate, { bigint: true });
        return { name, inode: stat.ino.toString(), size: stat.size.toString() };
      });
      expect(evidenceAfter).toEqual(evidenceBefore);
    } finally {
      if (!fs.existsSync(release)) {
        fs.writeFileSync(release, 'continue\n', { flag: 'wx', mode: 0o600 });
      }
    }
    await expect(childResult).resolves.toEqual({ code: 0, signal: null, stderr: '' });
    expect(fs.readdirSync(f.ownerRoot).some((name) => name.endsWith('.journal.json'))).toBe(true);
    await expect(recoverInterruptedProjectLifecycleArtifactPromotion(
      f.destination,
      emptyDecisionDatabase(),
    )).resolves.toEqual({ rolledBack: 1, committed: 0, quarantined: 0, discarded: 0 });
    expectOld(f.destination);
    expect(fs.readdirSync(f.ownerRoot).filter((name) => name.startsWith('.bridgesllm-project-promotion-'))).toEqual([]);
  });
});
