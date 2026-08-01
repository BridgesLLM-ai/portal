import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  abandonProjectIdentityRenameBeforeCleanup,
  attestProjectRoot,
  assertProjectIdentityNameAvailable,
  beginProjectIdentityRename,
  beginProjectIdentityDeletion,
  cancelProjectIdentityRename,
  createCurrentProjectIdentity,
  finalizeCurrentProjectIdentityCreation,
  deleteProjectIdentity,
  ensureProjectIdentity,
  isInternalProjectDirectoryName,
  markProjectIdentityRenameCleanupStarted,
  markProjectIdentityRenameRuntimeCleaned,
  moveAttestedDirectoryNoReplace,
  readCompletedProjectIdentityRename,
  readProjectIdentity,
  readProjectIdentityRenameDeployIdentity,
  readProjectIdentityRenameJournal,
  recoverInterruptedProjectIdentityRename,
  retireInternalProjectIdentityDebris,
  ProjectIdentityLifecycleError,
  ProjectIdentityMismatchError,
  renameProjectIdentity,
  type ProjectIdentityDatabase,
  type ProjectIdentityRecord,
} from './projectIdentity';

function makeDatabase(): ProjectIdentityDatabase {
  const rows = new Map<string, ProjectIdentityRecord>();
  const byName = (workspaceOwnerId: string, projectName: string) =>
    [...rows.values()].find((row) => row.workspaceOwnerId === workspaceOwnerId && row.projectName === projectName) || null;
  const valueMatches = (actual: unknown, expected: any): boolean => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ('gt' in expected) return actual instanceof Date && actual.getTime() > expected.gt.getTime();
      if ('lte' in expected) return actual instanceof Date && actual.getTime() <= expected.lte.getTime();
      if ('in' in expected) return expected.in.includes(actual);
      if ('not' in expected) return actual !== expected.not;
      if ('startsWith' in expected) return typeof actual === 'string' && actual.startsWith(expected.startsWith);
    }
    if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
    return actual === expected;
  };
  const matches = (row: ProjectIdentityRecord, where: any): boolean => {
    if (!where) return true;
    if (Array.isArray(where.OR) && !where.OR.some((entry: any) => matches(row, entry))) return false;
    return Object.entries(where).every(([key, expected]) => {
      if (key === 'OR') return true;
      return valueMatches((row as any)[key], expected);
    });
  };
  const assertUnique = (candidate: ProjectIdentityRecord, exceptId?: string) => {
    for (const row of rows.values()) {
      if (row.id === exceptId || row.workspaceOwnerId !== candidate.workspaceOwnerId) continue;
      const candidateNames = new Set([
        candidate.projectName,
        ...(candidate.renameTargetName ? [candidate.renameTargetName] : []),
      ]);
      const rowNames = [row.projectName, ...(row.renameTargetName ? [row.renameTargetName] : [])];
      if (rowNames.some((name) => candidateNames.has(name)) || row.canonicalRoot === candidate.canonicalRoot) {
        throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      }
    }
  };
  return {
    projectIdentity: {
      async findUnique(args: any) {
        if (args.where?.id) return rows.get(args.where.id) || null;
        const key = args.where?.workspaceOwnerId_projectName;
        return key ? byName(key.workspaceOwnerId, key.projectName) : null;
      },
      async findFirst(args: any) {
        return [...rows.values()].find((row) => matches(row, args.where)) || null;
      },
      async create(args: any) {
        const now = new Date();
        const row: ProjectIdentityRecord = {
          lifecycleStatus: 'ACTIVE',
          legacyOpenClawMigrationStatus: 'NONE',
          renameTargetName: null,
          renameLeaseTokenHash: null,
          renameLeaseExpiresAt: null,
          renameStartedAt: null,
          renameCleanupStartedAt: null,
          renameRuntimeCleanedAt: null,
          lastRenameSourceName: null,
          lastRenameCompletedAt: null,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        assertUnique(row);
        rows.set(row.id, row);
        return row;
      },
      async update(args: any) {
        const current = rows.get(args.where.id);
        if (!current) throw new Error('missing');
        const row = { ...current, ...args.data, updatedAt: new Date() };
        assertUnique(row, current.id);
        rows.set(row.id, row);
        return row;
      },
      async updateMany(args: any) {
        const current = rows.get(args.where.id);
        if (!current) return { count: 0 };
        if (!matches(current, args.where)) return { count: 0 };
        const row = { ...current, ...args.data, updatedAt: new Date() };
        assertUnique(row, current.id);
        rows.set(row.id, row);
        return { count: 1 };
      },
      async delete(args: any) {
        const current = rows.get(args.where.id);
        if (!current) throw new Error('missing');
        rows.delete(current.id);
        return current;
      },
      async deleteMany(args: any) {
        let count = 0;
        for (const row of [...rows.values()]) {
          if (!matches(row, args?.where)) continue;
          rows.delete(row.id);
          count += 1;
        }
        return { count };
      },
    },
  };
}

describe('server-owned project identity', () => {
  let root: string;
  let database: ProjectIdentityDatabase;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-identity-'));
    database = makeDatabase();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function project(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  }

  it('marks only authoritative new-project enrollment as CURRENT', async () => {
    const currentRoot = project('current');
    const lazyRoot = project('lazy');

    const current = await createCurrentProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'current',
      projectRoot: currentRoot,
    }, database);
    expect(current).toMatchObject({
      lifecycleStatus: 'CREATING',
      legacyOpenClawMigrationStatus: 'CURRENT',
    });
    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'current',
      projectRoot: currentRoot,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
    const published = await finalizeCurrentProjectIdentityCreation({
      projectIdentityId: current.id,
      projectRoot: currentRoot,
    }, database);
    const lazy = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'lazy',
      projectRoot: lazyRoot,
    }, database);

    expect(published).toMatchObject({
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: 'CURRENT',
    });
    expect(lazy.legacyOpenClawMigrationStatus).toBe('NONE');
  });

  it('never enrolls or lists the Portal-internal directory namespace as a project', async () => {
    // The delete flow stages removals under `.bridgesllm-lifecycle-quarantine`
    // inside the projects root; lazy adoption once registered that directory
    // as a permanent, undeletable ghost project on every box's first delete.
    const quarantine = project('.bridgesllm-lifecycle-quarantine');

    expect(isInternalProjectDirectoryName('.bridgesllm-lifecycle-quarantine')).toBe(true);
    expect(isInternalProjectDirectoryName('.anything-reserved')).toBe(true);
    expect(isInternalProjectDirectoryName('regular-project')).toBe(false);

    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: '.bridgesllm-lifecycle-quarantine',
      projectRoot: quarantine,
    }, database)).rejects.toThrow('Invalid project name');
    await expect(createCurrentProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: '.hidden',
      projectRoot: quarantine,
    }, database)).rejects.toThrow('Invalid project name');
  });

  it('retires internal-directory identity debris and leaves real projects alone', async () => {
    const realRoot = project('real-project');
    const real = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'real-project',
      projectRoot: realRoot,
    }, database);
    // Simulate the pre-fix ghost row adopted by an older Portal.
    await database.projectIdentity.create({
      data: {
        id: 'ghost-row',
        workspaceOwnerId: 'owner-1',
        projectName: '.bridgesllm-lifecycle-quarantine',
        canonicalRoot: path.join(root, '.bridgesllm-lifecycle-quarantine'),
        rootDevice: '1',
        rootInode: '2',
        rootBirthtimeNs: '3',
        generation: 1,
      },
    });

    await expect(retireInternalProjectIdentityDebris(database)).resolves.toBe(1);
    await expect(database.projectIdentity.findUnique({ where: { id: 'ghost-row' } })).resolves.toBeNull();
    await expect(database.projectIdentity.findUnique({ where: { id: real.id } }))
      .resolves.toMatchObject({ projectName: 'real-project' });
    // Idempotent on a clean database.
    await expect(retireInternalProjectIdentityDebris(database)).resolves.toBe(0);
  });

  it('refuses to publish CURRENT when the staged directory identity changes', async () => {
    const stagedRoot = project('staged');
    const current = await createCurrentProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'published',
      projectRoot: stagedRoot,
    }, database);
    fs.renameSync(stagedRoot, path.join(root, 'replaced-staging'));
    fs.mkdirSync(stagedRoot);

    await expect(finalizeCurrentProjectIdentityCreation({
      projectIdentityId: current.id,
      projectRoot: stagedRoot,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityMismatchError);
    await expect(database.projectIdentity.findUnique({ where: { id: current.id } }))
      .resolves.toMatchObject({ lifecycleStatus: 'CREATING' });
  });

  it('never promotes an existing lazy identity to CURRENT', async () => {
    const alpha = project('alpha');
    const lazy = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'alpha',
      projectRoot: alpha,
    }, database);
    const update = jest.spyOn(database.projectIdentity, 'update');
    const updateMany = jest.spyOn(database.projectIdentity, 'updateMany');

    await expect(createCurrentProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'alpha',
      projectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);

    await expect(readProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'alpha',
      projectRoot: alpha,
    }, database)).resolves.toMatchObject({
      id: lazy.id,
      legacyOpenClawMigrationStatus: 'NONE',
    });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not promote a NONE identity that wins the insert race', async () => {
    const alpha = project('alpha');
    const create = database.projectIdentity.create.bind(database.projectIdentity);
    jest.spyOn(database.projectIdentity, 'create').mockImplementationOnce(async () => {
      await create({
        data: {
          id: 'raced-lazy-identity',
          workspaceOwnerId: 'owner-1',
          projectName: 'alpha',
          canonicalRoot: attestProjectRoot(alpha).canonicalRoot,
          rootDevice: attestProjectRoot(alpha).rootDevice,
          rootInode: attestProjectRoot(alpha).rootInode,
          rootBirthtimeNs: attestProjectRoot(alpha).rootBirthtimeNs,
          generation: 1,
        },
      });
      throw Object.assign(new Error('duplicate'), { code: 'P2002' });
    });

    await expect(createCurrentProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'alpha',
      projectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);

    await expect(readProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'alpha',
      projectRoot: alpha,
    }, database)).resolves.toMatchObject({
      id: 'raced-lazy-identity',
      legacyOpenClawMigrationStatus: 'NONE',
    });
  });

  it('does not trust or derive identity from a writable project marker', async () => {
    const alpha = project('alpha');
    const beta = project('beta');
    const forged = JSON.stringify({ version: 1, stableSlug: 'shared-slug' });
    fs.writeFileSync(path.join(alpha, '.portal-project.json'), forged);
    fs.writeFileSync(path.join(beta, '.portal-project.json'), forged);

    const alphaIdentity = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    const betaIdentity = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'beta', projectRoot: beta,
    }, database);

    expect(alphaIdentity.id).not.toBe(betaIdentity.id);
    expect(alphaIdentity.rootInode).not.toBe(betaIdentity.rootInode);
  });

  it('reads and attests existing identity without enrolling an uninitialized project', async () => {
    const alpha = project('alpha');
    const create = jest.spyOn(database.projectIdentity, 'create');
    await expect(readProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();

    const enrolled = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    create.mockClear();
    await expect(readProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).resolves.toEqual(enrolled);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when a project path is replaced behind an existing identity', async () => {
    const alpha = project('alpha');
    await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    fs.renameSync(alpha, path.join(root, 'orphaned-alpha'));
    fs.mkdirSync(alpha);

    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityMismatchError);
  });

  it('preserves the immutable id across a verified filesystem rename', async () => {
    const alpha = project('alpha');
    const before = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    const beta = path.join(root, 'beta');
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
    }, database);
    await markProjectIdentityRenameCleanupStarted({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
    }, database);
    await markProjectIdentityRenameRuntimeCleaned({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
    }, database);
    fs.renameSync(alpha, beta);

    const after = await renameProjectIdentity({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      newProjectRoot: beta,
      leaseToken: grant.leaseToken,
    }, database);

    expect(after.id).toBe(before.id);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.rootInode).toBe(before.rootInode);
    expect(after.projectName).toBe('beta');
    expect(after.lastRenameSourceName).toBe('alpha');
    expect(after.lastRenameCompletedAt).toBeInstanceOf(Date);
    await expect(readCompletedProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      newProjectRoot: beta,
    }, database)).resolves.toMatchObject({ id: before.id, projectName: 'beta' });
  });

  it('supports spaces and hash characters without changing the immutable identity', async () => {
    const oldName = 'alpha project #1';
    const newName = 'beta project #2';
    const alpha = project(oldName);
    const before = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: oldName, projectRoot: alpha,
    }, database);
    const beta = path.join(root, newName);
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: oldName,
      newProjectName: newName,
      oldProjectRoot: alpha,
      newProjectRoot: beta,
    }, database);
    await markProjectIdentityRenameCleanupStarted({
      projectIdentityId: before.id,
      leaseToken: grant.leaseToken,
    }, database);
    await markProjectIdentityRenameRuntimeCleaned({
      projectIdentityId: before.id,
      leaseToken: grant.leaseToken,
    }, database);
    fs.renameSync(alpha, beta);
    const renamed = await renameProjectIdentity({
      workspaceOwnerId: 'owner-1',
      oldProjectName: oldName,
      newProjectName: newName,
      newProjectRoot: beta,
      leaseToken: grant.leaseToken,
    }, database);
    expect(renamed).toMatchObject({ id: before.id, projectName: newName, generation: 2 });
  });

  it('moves only the attested inode and never replaces an occupied target', () => {
    const alpha = project('alpha');
    const expected = attestProjectRoot(alpha);
    const beta = project('beta');
    expect(() => moveAttestedDirectoryNoReplace({
      sourceRoot: alpha,
      targetRoot: beta,
      expectedIdentity: expected,
    })).toThrow(ProjectIdentityLifecycleError);
    expect(fs.existsSync(alpha)).toBe(true);

    fs.rmSync(beta, { recursive: true, force: true });
    const moved = moveAttestedDirectoryNoReplace({
      sourceRoot: alpha,
      targetRoot: beta,
      expectedIdentity: expected,
    });
    expect(fs.existsSync(alpha)).toBe(false);
    expect(moved).toMatchObject({
      canonicalRoot: beta,
      rootDevice: expected.rootDevice,
      rootInode: expected.rootInode,
      rootBirthtimeNs: expected.rootBirthtimeNs,
    });
  });

  it('journals the exact deployment inode for crash-safe rename convergence', async () => {
    const alpha = project('alpha');
    const deploy = project('deploy-alpha');
    const beta = path.join(root, 'beta');
    const deployIdentity = attestProjectRoot(deploy);
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
      deployRootIdentity: deployIdentity,
    }, database);

    expect(readProjectIdentityRenameDeployIdentity(grant.identity)).toEqual({
      rootDevice: deployIdentity.rootDevice,
      rootInode: deployIdentity.rootInode,
      rootBirthtimeNs: deployIdentity.rootBirthtimeNs,
    });
    await expect(readProjectIdentityRenameJournal({
      workspaceOwnerId: 'owner-1',
      projectName: 'alpha',
    }, database)).resolves.toMatchObject({
      renameDeployPresent: true,
      renameDeployDevice: deployIdentity.rootDevice,
      renameDeployInode: deployIdentity.rootInode,
      renameDeployBirthtimeNs: deployIdentity.rootBirthtimeNs,
    });
  });

  it('journals deployment absence rather than accepting a late directory', async () => {
    const alpha = project('alpha');
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: path.join(root, 'beta'),
      deployRootIdentity: null,
    }, database);
    expect(grant.identity.renameDeployPresent).toBe(false);
    expect(readProjectIdentityRenameDeployIdentity(grant.identity)).toBeNull();
  });

  it('reopens a fresh rename barrier when an active turn is rejected before cleanup', async () => {
    const alpha = project('active chat #1');
    const beta = path.join(root, 'renamed later #2');
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'active chat #1',
      newProjectName: 'renamed later #2',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
    }, database);
    expect(grant.resumed).toBe(false);

    const reopened = await abandonProjectIdentityRenameBeforeCleanup({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
      oldProjectRoot: alpha,
    }, database);
    expect(reopened).toMatchObject({
      projectName: 'active chat #1',
      lifecycleStatus: 'ACTIVE',
      renameTargetName: null,
    });
    await expect(assertProjectIdentityNameAvailable({
      workspaceOwnerId: 'owner-1',
      projectName: 'renamed later #2',
    }, database)).resolves.toBeUndefined();
    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1',
      projectName: 'active chat #1',
      projectRoot: alpha,
    }, database)).resolves.toMatchObject({ id: grant.identity.id, lifecycleStatus: 'ACTIVE' });
  });

  it('never reopens a partial rename once runtime cleanup may have started', async () => {
    const alpha = project('alpha');
    const beta = path.join(root, 'beta');
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1', oldProjectName: 'alpha', newProjectName: 'beta',
      oldProjectRoot: alpha, newProjectRoot: beta,
    }, database);
    await markProjectIdentityRenameCleanupStarted({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
    }, database);
    await expect(abandonProjectIdentityRenameBeforeCleanup({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
      oldProjectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
    await expect(readProjectIdentityRenameJournal({
      workspaceOwnerId: 'owner-1', projectName: 'alpha',
    }, database)).resolves.toMatchObject({
      lifecycleStatus: 'RENAMING',
      renameTargetName: 'beta',
      renameCleanupStartedAt: expect.any(Date),
      renameRuntimeCleanedAt: null,
    });
  });

  it('requires a durable cleanup marker and a live owned lease before commit or rollback', async () => {
    const alpha = project('alpha');
    const beta = path.join(root, 'beta');
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
    }, database);
    fs.renameSync(alpha, beta);
    await expect(renameProjectIdentity({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      newProjectRoot: beta,
      leaseToken: grant.leaseToken,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);

    fs.renameSync(beta, alpha);
    await expect(cancelProjectIdentityRename({
      projectIdentityId: grant.identity.id,
      leaseToken: grant.leaseToken,
      oldProjectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
  });

  it('reserves each rename target once per workspace and rejects project creation under it', async () => {
    const alpha = project('alpha');
    const beta = project('beta');
    const target = path.join(root, 'shared target');
    await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'beta', projectRoot: beta,
    }, database);
    await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'shared target',
      oldProjectRoot: alpha,
      newProjectRoot: target,
    }, database);
    await expect(beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'beta',
      newProjectName: 'shared target',
      oldProjectRoot: beta,
      newProjectRoot: target,
    }, database)).rejects.toMatchObject({ code: 'P2002' });
    await expect(assertProjectIdentityNameAvailable({
      workspaceOwnerId: 'owner-1',
      projectName: 'shared target',
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);

    fs.mkdirSync(target);
    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'shared target', projectRoot: target,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
  });

  it('keeps ordinary reads non-mutating while an expired rename awaits explicit recovery', async () => {
    const alpha = project('alpha');
    const beta = path.join(root, 'beta');
    const now = new Date();
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
      now,
    }, database);
    await database.projectIdentity.update({
      where: { id: grant.identity.id },
      data: { renameLeaseExpiresAt: new Date(now.getTime() - 1) },
    });
    const updateMany = jest.spyOn(database.projectIdentity, 'updateMany');
    await expect(readProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
    await expect(readProjectIdentityRenameJournal({
      workspaceOwnerId: 'owner-1', projectName: 'alpha',
    }, database)).resolves.toMatchObject({ id: grant.identity.id, lifecycleStatus: 'RENAMING' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not mistake an unrelated active target for a completed rename', async () => {
    const beta = project('beta');
    await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'beta', projectRoot: beta,
    }, database);

    await expect(recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: 'owner-1', projectName: 'beta', projectRoot: beta,
    }, database)).resolves.toBeNull();
  });

  it('recovers only an expired rename with durable cleanup and unambiguous same-inode state', async () => {
    const alpha = project('alpha');
    const beta = path.join(root, 'beta');
    const now = new Date();
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
      now,
    }, database);
    await database.projectIdentity.update({
      where: { id: grant.identity.id },
      data: { renameLeaseExpiresAt: new Date(now.getTime() - 1) },
    });
    await expect(recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha, now,
    }, database)).rejects.toThrow(/cleanup/i);

    await database.projectIdentity.update({
      where: { id: grant.identity.id },
      data: { renameRuntimeCleanedAt: new Date(now.getTime() - 2) },
    });
    const cancelled = await recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha, now,
    }, database);
    expect(cancelled).toMatchObject({ projectName: 'alpha', lifecycleStatus: 'ACTIVE' });

    const second = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: beta,
      now,
    }, database);
    await database.projectIdentity.update({
      where: { id: second.identity.id },
      data: {
        renameLeaseExpiresAt: new Date(now.getTime() - 1),
        renameRuntimeCleanedAt: new Date(now.getTime() - 2),
      },
    });
    fs.renameSync(alpha, beta);
    const completed = await recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: 'owner-1', projectName: 'beta', projectRoot: beta, now,
    }, database);
    expect(completed).toMatchObject({ projectName: 'beta', lifecycleStatus: 'ACTIVE', generation: 2 });
  });

  it('fails recovery when both roots exist or the moved root was replaced', async () => {
    const alpha = project('alpha');
    const beta = path.join(root, 'beta');
    const now = new Date();
    const grant = await beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1', oldProjectName: 'alpha', newProjectName: 'beta',
      oldProjectRoot: alpha, newProjectRoot: beta, now,
    }, database);
    await database.projectIdentity.update({
      where: { id: grant.identity.id },
      data: {
        renameLeaseExpiresAt: new Date(now.getTime() - 1),
        renameRuntimeCleanedAt: new Date(now.getTime() - 2),
      },
    });
    fs.mkdirSync(beta);
    await expect(recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha, now,
    }, database)).rejects.toThrow(/ambiguous/i);

    fs.rmSync(beta, { recursive: true, force: true });
    fs.renameSync(alpha, beta);
    // Keep the original inode allocated so filesystems with aggressive inode
    // reuse cannot make this replacement fixture accidentally attest.
    fs.renameSync(beta, path.join(root, 'moved-original'));
    fs.mkdirSync(beta);
    await expect(recoverInterruptedProjectIdentityRename({
      workspaceOwnerId: 'owner-1', projectName: 'beta', projectRoot: beta, now,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityMismatchError);
  });

  it('allocates a new immutable id after a verified delete and recreate', async () => {
    const alpha = project('alpha');
    const before = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    await beginProjectIdentityDeletion({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    await deleteProjectIdentity({ workspaceOwnerId: 'owner-1', projectName: 'alpha' }, database);
    fs.rmSync(alpha, { recursive: true, force: true });
    fs.mkdirSync(alpha);
    const after = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    expect(after.id).not.toBe(before.id);
  });

  it('closes Project admission before runtime cleanup and permits idempotent deletion retries', async () => {
    const alpha = project('alpha');
    const active = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    const deleting = await beginProjectIdentityDeletion({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    expect(deleting.id).toBe(active.id);
    expect(deleting.lifecycleStatus).toBe('DELETING');
    await expect(beginProjectIdentityDeletion({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).resolves.toMatchObject({ id: active.id, lifecycleStatus: 'DELETING' });
    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
  });

  it('blocks rename and delete admission while legacy transcript reconciliation is pending', async () => {
    const alpha = project('alpha');
    const identity = await ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database);
    await database.projectIdentity.update({
      where: { id: identity.id },
      data: { legacyOpenClawMigrationStatus: 'PENDING' },
    });

    await expect(beginProjectIdentityDeletion({
      workspaceOwnerId: 'owner-1', projectName: 'alpha', projectRoot: alpha,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
    await expect(beginProjectIdentityRename({
      workspaceOwnerId: 'owner-1',
      oldProjectName: 'alpha',
      newProjectName: 'beta',
      oldProjectRoot: alpha,
      newProjectRoot: path.join(root, 'beta'),
    }, database)).rejects.toBeInstanceOf(ProjectIdentityLifecycleError);
  });

  it('rejects a symlink project root', async () => {
    const target = project('target');
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link);
    await expect(ensureProjectIdentity({
      workspaceOwnerId: 'owner-1', projectName: 'link', projectRoot: link,
    }, database)).rejects.toBeInstanceOf(ProjectIdentityMismatchError);
  });
});
