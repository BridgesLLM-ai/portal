import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  discardFailedCurrentProjectCreation,
  initializeProjectStorage,
  recoverInterruptedCurrentProjectCreations,
} from '../routes/projects';
import {
  attestProjectRoot,
  finalizeCurrentProjectIdentityCreation,
  type ProjectIdentityRecord,
} from '../services/projectIdentity';

function creationRow(input: {
  id?: string;
  owner?: string;
  name?: string;
  root: string;
  lifecycleStatus?: string;
}): ProjectIdentityRecord {
  const identity = attestProjectRoot(input.root);
  const now = new Date();
  return {
    id: input.id || 'creating-project-id',
    workspaceOwnerId: input.owner || 'owner-1',
    projectName: input.name || 'alpha',
    ...identity,
    generation: 1,
    lifecycleStatus: input.lifecycleStatus || 'CREATING',
    legacyOpenClawMigrationStatus: 'CURRENT',
    createdAt: now,
    updatedAt: now,
  };
}

function lifecycleDatabase(rows: ProjectIdentityRecord[]) {
  const state = new Map(rows.map((row) => [row.id, row]));
  const calls: string[] = [];
  const matchesLifecycle = (row: ProjectIdentityRecord, expected: any) => (
    expected?.in ? expected.in.includes(row.lifecycleStatus) : row.lifecycleStatus === expected
  );
  const delegate = {
    findMany: jest.fn(async (args: any) => [...state.values()]
      .filter((row) => matchesLifecycle(row, args.where.lifecycleStatus))),
    findUnique: jest.fn(async (args: any) => state.get(args.where.id) || null),
    updateMany: jest.fn(async (args: any) => {
      const row = state.get(args.where.id);
      if (!row || !matchesLifecycle(row, args.where.lifecycleStatus)) return { count: 0 };
      calls.push(`update:${String(args.data.lifecycleStatus)}`);
      state.set(row.id, { ...row, ...args.data, updatedAt: new Date() });
      return { count: 1 };
    }),
    deleteMany: jest.fn(async (args: any) => {
      const row = state.get(args.where.id);
      if (!row || !matchesLifecycle(row, args.where.lifecycleStatus)) return { count: 0 };
      calls.push('delete');
      state.delete(row.id);
      return { count: 1 };
    }),
  };
  return { state, calls, database: { projectIdentity: delegate } as any, delegate };
}

describe('CURRENT Project hidden creation recovery', () => {
  let tempRoot: string;
  let projectsDir: string;
  let stagingRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-creation-'));
    projectsDir = path.join(tempRoot, 'projects');
    initializeProjectStorage({
      projectsDir,
      deployDir: path.join(tempRoot, 'apps'),
      zipsDir: path.join(tempRoot, 'zips'),
      uploadTempDir: path.join(tempRoot, 'uploads'),
    });
    stagingRoot = path.join(projectsDir, '.bridgesllm-project-creation-staging');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function staged(name = 'alpha'): { directory: string; row: ProjectIdentityRecord } {
    const directory = fs.mkdtempSync(path.join(stagingRoot, 'create-'));
    return { directory, row: creationRow({ root: directory, name }) };
  }

  test('discards an interrupted staged identity after workload cleanup', async () => {
    const fixture = staged();
    fs.writeFileSync(path.join(fixture.directory, 'partial.txt'), 'partial');
    const db = lifecycleDatabase([fixture.row]);
    const removeWorkloads = jest.fn(async () => { db.calls.push('workloads'); });

    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: db.database,
      removeWorkloads,
      collisionProof: jest.fn(async () => undefined),
      finalizeCreation: jest.fn() as any,
    })).resolves.toEqual({
      finalized: 0,
      discarded: 1,
      orphanStagingDirectories: 0,
      preservedOrphanStagingDirectories: 0,
    });

    expect(removeWorkloads).toHaveBeenCalledWith(fixture.row.id);
    expect(fs.existsSync(fixture.directory)).toBe(false);
    expect(db.state.size).toBe(0);
  });

  test('restart discards nonempty in-root ZIP scratch left by a simulated SIGKILL', async () => {
    const fixture = staged('zip-crash');
    const extractionScratch = fs.mkdtempSync(path.join(fixture.directory, '.portal-zip-extract-'));
    fs.mkdirSync(path.join(extractionScratch, 'source'), { recursive: true });
    fs.writeFileSync(path.join(extractionScratch, 'source', 'partial.txt'), 'partial');
    const db = lifecycleDatabase([fixture.row]);
    const removeWorkloads = jest.fn(async () => { db.calls.push('workloads'); });

    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: db.database,
      removeWorkloads,
      collisionProof: jest.fn(async () => undefined),
      finalizeCreation: jest.fn() as any,
    })).resolves.toEqual({
      finalized: 0,
      discarded: 1,
      orphanStagingDirectories: 0,
      preservedOrphanStagingDirectories: 0,
    });

    expect(removeWorkloads).toHaveBeenCalledWith(fixture.row.id);
    expect(fs.existsSync(fixture.directory)).toBe(false);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    expect(db.state.size).toBe(0);
  });

  test('rescans and finalizes a completely moved staging inode', async () => {
    const fixture = staged();
    fs.writeFileSync(path.join(fixture.directory, 'complete.txt'), 'complete');
    const ownerDir = path.join(projectsDir, fixture.row.workspaceOwnerId);
    const finalRoot = path.join(ownerDir, fixture.row.projectName);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.renameSync(fixture.directory, finalRoot);
    const db = lifecycleDatabase([fixture.row]);
    const collisionProof = jest.fn(async () => undefined);
    const finalizeCreation = jest.fn(async () => {
      db.state.set(fixture.row.id, {
        ...fixture.row,
        ...attestProjectRoot(finalRoot),
        lifecycleStatus: 'ACTIVE',
      });
      return db.state.get(fixture.row.id)!;
    });

    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: db.database,
      removeWorkloads: jest.fn(async () => undefined),
      collisionProof: collisionProof as any,
      finalizeCreation: finalizeCreation as any,
    })).resolves.toEqual({
      finalized: 1,
      discarded: 0,
      orphanStagingDirectories: 0,
      preservedOrphanStagingDirectories: 0,
    });

    expect(collisionProof).toHaveBeenCalledWith({
      workspaceOwnerId: fixture.row.workspaceOwnerId,
      projectName: fixture.row.projectName,
      projectRoot: finalRoot,
    });
    expect(finalizeCreation).toHaveBeenCalledWith({
      projectIdentityId: fixture.row.id,
      projectRoot: finalRoot,
    });
    expect(db.state.get(fixture.row.id)?.lifecycleStatus).toBe('ACTIVE');
  });

  test('fails closed for ambiguous claimed roots but preserves a nonempty unclaimed root', async () => {
    const both = staged('both');
    const bothFinal = path.join(projectsDir, both.row.workspaceOwnerId, both.row.projectName);
    fs.mkdirSync(bothFinal, { recursive: true });
    const bothDb = lifecycleDatabase([both.row]);
    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: bothDb.database,
      removeWorkloads: jest.fn(async () => undefined),
      collisionProof: jest.fn(async () => undefined),
      finalizeCreation: jest.fn() as any,
    })).rejects.toThrow(/both staged and final roots/i);

    fs.rmSync(bothFinal, { recursive: true });
    fs.rmSync(both.directory, { recursive: true });
    const replacedFinal = path.join(projectsDir, both.row.workspaceOwnerId, both.row.projectName);
    fs.mkdirSync(replacedFinal, { recursive: true });
    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: bothDb.database,
      removeWorkloads: jest.fn(async () => undefined),
      collisionProof: jest.fn(async () => undefined),
      finalizeCreation: jest.fn() as any,
    })).rejects.toThrow(/final root changed/i);

    fs.rmSync(replacedFinal, { recursive: true });
    bothDb.state.clear();
    const orphan = fs.mkdtempSync(path.join(stagingRoot, 'create-'));
    fs.writeFileSync(path.join(orphan, 'unexpected.txt'), 'do not remove implicitly');
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: bothDb.database,
      removeWorkloads: jest.fn(async () => undefined),
      collisionProof: jest.fn(async () => undefined),
      finalizeCreation: jest.fn() as any,
    })).resolves.toEqual({
      finalized: 0,
      discarded: 0,
      orphanStagingDirectories: 0,
      preservedOrphanStagingDirectories: 1,
    });
    warning.mockRestore();
    expect(fs.readFileSync(path.join(orphan, 'unexpected.txt'), 'utf8')).toBe('do not remove implicitly');
  });

  test('claims CREATION_CLEANUP before removing workloads, directory, and row', async () => {
    const fixture = staged();
    fs.writeFileSync(path.join(fixture.directory, 'partial.txt'), 'partial');
    const db = lifecycleDatabase([fixture.row]);
    const removeWorkloads = jest.fn(async () => { db.calls.push('workloads'); });

    await expect(discardFailedCurrentProjectCreation({
      projectIdentityId: fixture.row.id,
      directory: fixture.directory,
      expectedDirectoryIdentity: fixture.row,
    }, { database: db.database, removeWorkloads })).resolves.toBe('discarded');

    expect(db.calls).toEqual(['update:CREATION_CLEANUP', 'workloads', 'delete']);
    expect(fs.existsSync(fixture.directory)).toBe(false);
  });

  test('a cascaded row disappearance cleans only its attested root and restart preserves unrelated residue', async () => {
    const vanished = staged('cascade-lost-row');
    fs.writeFileSync(path.join(vanished.directory, 'partial.txt'), 'partial creation');
    const unrelated = fs.mkdtempSync(path.join(stagingRoot, 'create-'));
    fs.writeFileSync(path.join(unrelated, 'sentinel.txt'), 'unrelated and unclaimed');
    const db = lifecycleDatabase([]);
    const removeWorkloads = jest.fn(async () => undefined);

    await expect(discardFailedCurrentProjectCreation({
      projectIdentityId: vanished.row.id,
      directory: vanished.directory,
      expectedDirectoryIdentity: vanished.row,
    }, { database: db.database, removeWorkloads })).resolves.toBe('discarded');

    expect(removeWorkloads).not.toHaveBeenCalled();
    expect(fs.existsSync(vanished.directory)).toBe(false);
    expect(fs.readFileSync(path.join(unrelated, 'sentinel.txt'), 'utf8')).toBe('unrelated and unclaimed');

    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(recoverInterruptedCurrentProjectCreations({
      projectsDir,
      database: db.database,
      removeWorkloads,
      collisionProof: jest.fn(async () => undefined),
      finalizeCreation: jest.fn() as any,
    })).resolves.toEqual({
      finalized: 0,
      discarded: 0,
      orphanStagingDirectories: 0,
      preservedOrphanStagingDirectories: 1,
    });
    expect(warning).toHaveBeenCalledWith(
      '[Project Creation] Preserving nonempty unclaimed staging directory:',
      path.basename(unrelated),
    );
    warning.mockRestore();
    expect(fs.readFileSync(path.join(unrelated, 'sentinel.txt'), 'utf8')).toBe('unrelated and unclaimed');
  });

  test('a post-CAS read failure reconciles ACTIVE as published without cleanup', async () => {
    const fixture = staged('published');
    const ownerDir = path.join(projectsDir, fixture.row.workspaceOwnerId);
    const finalRoot = path.join(ownerDir, fixture.row.projectName);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.renameSync(fixture.directory, finalRoot);
    let stored = fixture.row;
    let reads = 0;
    const delegate = {
      findUnique: jest.fn(async () => {
        reads += 1;
        if (reads === 2) throw new Error('injected post-CAS read failure');
        return stored;
      }),
      updateMany: jest.fn(async (args: any) => {
        stored = { ...stored, ...args.data, updatedAt: new Date() };
        return { count: 1 };
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    };
    const database = { projectIdentity: delegate } as any;

    await expect(finalizeCurrentProjectIdentityCreation({
      projectIdentityId: stored.id,
      projectRoot: finalRoot,
    }, database)).rejects.toThrow(/post-CAS/);
    expect(stored.lifecycleStatus).toBe('ACTIVE');

    const removeWorkloads = jest.fn(async () => undefined);
    await expect(discardFailedCurrentProjectCreation({
      projectIdentityId: stored.id,
      directory: finalRoot,
      expectedDirectoryIdentity: stored,
    }, { database, removeWorkloads })).resolves.toBe('published');
    expect(removeWorkloads).not.toHaveBeenCalled();
    expect(fs.existsSync(finalRoot)).toBe(true);
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });
});
