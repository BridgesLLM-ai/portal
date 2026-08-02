import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  adoptLegacyProjectInPlace,
  buildProjectLegacyAdoptionManifest,
  copyLegacyProjectIntoCurrentStaging,
} from './projectLegacyAdoption';
import {
  attestProjectRoot,
  type ProjectIdentityRecord,
} from './projectIdentity';

function legacyIdentity(projectRoot: string): ProjectIdentityRecord {
  const root = attestProjectRoot(projectRoot);
  return {
    id: '11111111-2222-4333-8444-555555555555',
    workspaceOwnerId: 'owner-1',
    projectName: 'legacy-project',
    canonicalRoot: root.canonicalRoot,
    rootDevice: root.rootDevice,
    rootInode: root.rootInode,
    rootBirthtimeNs: root.rootBirthtimeNs,
    generation: 7,
    lifecycleStatus: 'ACTIVE',
    legacyOpenClawMigrationStatus: 'NONE',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  };
}

describe('in-place legacy Project adoption', () => {
  let temporaryRoot: string;
  let projectRoot: string;
  let identity: ProjectIdentityRecord;
  let database: any;
  let previousAdoptionRoot: string | undefined;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-legacy-adoption-'));
    projectRoot = path.join(temporaryRoot, 'project');
    fs.mkdirSync(path.join(projectRoot, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'hello.txt'), 'hello\n');
    fs.writeFileSync(path.join(projectRoot, 'nested', 'data.json'), '{"ok":true}\n');
    identity = legacyIdentity(projectRoot);
    database = {
      projectIdentity: {
        findUnique: jest.fn(async () => ({ ...identity })),
        updateMany: jest.fn(async (args: any) => {
          if (
            identity.generation !== args.where.generation
            || identity.legacyOpenClawMigrationStatus === 'CURRENT'
          ) return { count: 0 };
          identity = {
            ...identity,
            legacyOpenClawMigrationStatus: 'CURRENT',
            generation: identity.generation + 1,
          };
          return { count: 1 };
        }),
      },
    };
    previousAdoptionRoot = process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT;
    process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT = path.join(temporaryRoot, 'adoption');
  });

  afterEach(() => {
    if (previousAdoptionRoot === undefined) {
      delete process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT;
    } else {
      process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT = previousAdoptionRoot;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test('builds a verified CURRENT-project copy without changing or promoting the legacy source', () => {
    const stagingRoot = path.join(temporaryRoot, 'current-staging');
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    const sourceBefore = buildProjectLegacyAdoptionManifest(projectRoot);

    const copied = copyLegacyProjectIntoCurrentStaging(
      { sourceRoot: projectRoot, stagingRoot },
      { limits: { minimumFreeBytesAfterCopy: 0 } },
    );

    expect(copied).toEqual(sourceBefore);
    expect(buildProjectLegacyAdoptionManifest(stagingRoot)).toEqual(sourceBefore);
    expect(buildProjectLegacyAdoptionManifest(projectRoot)).toEqual(sourceBefore);
    expect(identity.legacyOpenClawMigrationStatus).toBe('NONE');
    expect(database.projectIdentity.updateMany).not.toHaveBeenCalled();
  });

  test('preserves the identity, increments its generation, and parks a hash-identical source snapshot', async () => {
    fs.chmodSync(projectRoot, 0o751);
    fs.chmodSync(path.join(projectRoot, 'nested'), 0o750);
    const emptyDirectory = path.join(projectRoot, 'empty-directory');
    fs.mkdirSync(emptyDirectory, { mode: 0o711 });
    fs.chmodSync(emptyDirectory, 0o711);
    const before = buildProjectLegacyAdoptionManifest(projectRoot);
    const result = await adoptLegacyProjectInPlace(
      { projectIdentity: identity, projectRoot },
      { database },
    );

    expect(result.projectIdentityId).toBe(identity.id);
    expect(result.generation).toBe(8);
    expect(result.manifest).toEqual(before);
    expect(buildProjectLegacyAdoptionManifest(result.parkedRoot)).toEqual(before);
    expect(buildProjectLegacyAdoptionManifest(projectRoot)).toEqual(before);
    expect(result.manifest).toEqual(expect.objectContaining({
      fileCount: 2,
      directoryCount: 2,
      symlinkCount: 0,
      entryCount: 4,
      rootMode: 0o751,
    }));
    expect(fs.lstatSync(result.parkedRoot).mode & 0o777).toBe(0o751);
    expect(fs.lstatSync(path.join(result.parkedRoot, 'nested')).mode & 0o777).toBe(0o750);
    expect(fs.lstatSync(path.join(result.parkedRoot, 'empty-directory')).mode & 0o777).toBe(0o711);
    expect(database.projectIdentity.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: identity.id,
        generation: 7,
        lifecycleStatus: 'ACTIVE',
      }),
      data: {
        legacyOpenClawMigrationStatus: 'CURRENT',
        generation: { increment: 1 },
      },
    }));

    const staleStaging = path.join(
      process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT!,
      identity.id,
      'staging-interrupted-process',
    );
    fs.mkdirSync(staleStaging, { recursive: true });
    fs.writeFileSync(path.join(staleStaging, 'partial'), 'partial');
    const replay = await adoptLegacyProjectInPlace(
      { projectIdentity: { ...identity }, projectRoot },
      { database },
    );
    expect(replay.alreadyCurrent).toBe(true);
    expect(fs.existsSync(staleStaging)).toBe(false);
  });

  test('preserves inert symlink text without following absolute, escaping, dangling, or cyclic targets', async () => {
    const outside = path.join(temporaryRoot, 'outside.txt');
    fs.writeFileSync(outside, 'must never be copied through a link\n');
    fs.symlinkSync(outside, path.join(projectRoot, 'absolute-link'));
    fs.symlinkSync('../outside.txt', path.join(projectRoot, 'escaping-link'));
    fs.symlinkSync('missing-target', path.join(projectRoot, 'dangling-link'));
    fs.symlinkSync('cycle-b', path.join(projectRoot, 'cycle-a'));
    fs.symlinkSync('cycle-a', path.join(projectRoot, 'cycle-b'));
    fs.symlinkSync('nested', path.join(projectRoot, 'directory-link'));
    fs.symlinkSync(Buffer.from([0x6e, 0x6f, 0x6e, 0x2d, 0x75, 0x74, 0x66, 0x38, 0xff]), path.join(projectRoot, 'raw-link'));

    const result = await adoptLegacyProjectInPlace(
      { projectIdentity: identity, projectRoot },
      { database },
    );

    for (const name of [
      'absolute-link',
      'escaping-link',
      'dangling-link',
      'cycle-a',
      'cycle-b',
      'directory-link',
      'raw-link',
    ]) {
      const source = path.join(projectRoot, name);
      const parked = path.join(result.parkedRoot, name);
      expect(fs.lstatSync(parked).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(parked, { encoding: 'buffer' }))
        .toEqual(fs.readlinkSync(source, { encoding: 'buffer' }));
    }
    expect(buildProjectLegacyAdoptionManifest(result.parkedRoot)).toEqual(
      buildProjectLegacyAdoptionManifest(projectRoot),
    );
    expect(fs.existsSync(path.join(result.parkedRoot, 'outside.txt'))).toBe(false);
  });

  test('fails before publication when a symlink target is swapped during the copy', async () => {
    const link = path.join(projectRoot, 'mutable-link');
    fs.symlinkSync('hello.txt', link);
    const originalSymlinkSync = fs.symlinkSync;
    let swapped = false;
    const symlinkSpy = jest.spyOn(fs, 'symlinkSync').mockImplementation((target, destination, type) => {
      const result = originalSymlinkSync(target, destination, type);
      if (!swapped && String(destination).includes('staging-')) {
        swapped = true;
        fs.unlinkSync(link);
        originalSymlinkSync('nested/data.json', link);
      }
      return result;
    });
    try {
      await expect(adoptLegacyProjectInPlace(
        { projectIdentity: identity, projectRoot },
        { database },
      )).rejects.toThrow(/link changed|directory changed/i);
    } finally {
      symlinkSpy.mockRestore();
    }
    expect(identity.legacyOpenClawMigrationStatus).toBe('NONE');
    expect(identity.generation).toBe(7);
  });

  test.each([
    [{ maxEntries: 1 }, /entry limit/i],
    [{ maxBytes: 1 }, /byte limit/i],
  ] as const)('fails before publication when the bounded snapshot exceeds %p', async (limits, message) => {
    await expect(adoptLegacyProjectInPlace(
      { projectIdentity: identity, projectRoot },
      { database, limits },
    )).rejects.toThrow(message);
    expect(identity.legacyOpenClawMigrationStatus).toBe('NONE');
    expect(database.projectIdentity.updateMany).not.toHaveBeenCalled();
  });

  test('fails before copying when verified free space cannot hold the snapshot and reserve', async () => {
    await expect(adoptLegacyProjectInPlace(
      { projectIdentity: identity, projectRoot },
      {
        database,
        limits: { minimumFreeBytesAfterCopy: 0 },
        readAvailableDiskBytes: () => BigInt(0),
      },
    )).rejects.toThrow(/enough verified free space/i);
    expect(identity.legacyOpenClawMigrationStatus).toBe('NONE');
    expect(database.projectIdentity.updateMany).not.toHaveBeenCalled();
  });

  test.each(['COPY', 'PARK', 'COMMIT'] as const)(
    'converges without a second identity after a crash at %s',
    async (faultAfter) => {
      const immutableId = identity.id;
      await expect(adoptLegacyProjectInPlace(
        { projectIdentity: identity, projectRoot },
        { database, faultAfter },
      )).rejects.toThrow(/fault injection/);

      const result = await adoptLegacyProjectInPlace(
        { projectIdentity: { ...identity }, projectRoot },
        { database },
      );
      expect(result.projectIdentityId).toBe(immutableId);
      expect(identity.id).toBe(immutableId);
      expect(identity.legacyOpenClawMigrationStatus).toBe('CURRENT');
      expect(buildProjectLegacyAdoptionManifest(result.parkedRoot)).toEqual(
        buildProjectLegacyAdoptionManifest(projectRoot),
      );
    },
  );

  test('replays a pre-symlink version-1 parked journal without changing its digest contract', async () => {
    const adoptionDirectory = path.join(
      process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT!,
      identity.id,
    );
    const parkedRoot = path.join(adoptionDirectory, 'source-snapshot');
    fs.mkdirSync(path.join(parkedRoot, 'nested'), { recursive: true, mode: 0o700 });
    const relativeFiles = ['hello.txt', 'nested/data.json'];
    const entries = relativeFiles.map((relative) => {
      const source = path.join(projectRoot, ...relative.split('/'));
      const destination = path.join(parkedRoot, ...relative.split('/'));
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, fs.lstatSync(source).mode & 0o777);
      const content = fs.readFileSync(source);
      return {
        path: relative,
        bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        mode: fs.lstatSync(source).mode & 0o777,
      };
    });
    const manifest = {
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      entries,
    };
    fs.writeFileSync(path.join(adoptionDirectory, 'journal.json'), `${JSON.stringify({
      version: 1,
      identityId: identity.id,
      workspaceOwnerId: identity.workspaceOwnerId,
      projectName: identity.projectName,
      generationBefore: identity.generation,
      canonicalRoot: identity.canonicalRoot,
      rootDevice: identity.rootDevice,
      rootInode: identity.rootInode,
      rootBirthtimeNs: identity.rootBirthtimeNs,
      stage: 'VERIFIED',
      manifest,
      parkedRoot,
      startedAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:01:00.000Z',
    })}\n`, { mode: 0o600 });

    const result = await adoptLegacyProjectInPlace(
      { projectIdentity: identity, projectRoot },
      { database },
    );

    expect(result.manifest).toEqual(manifest);
    expect(result.generation).toBe(8);
    expect(JSON.parse(fs.readFileSync(path.join(adoptionDirectory, 'journal.json'), 'utf8')))
      .toEqual(expect.objectContaining({ version: 1, stage: 'COMMITTED' }));
  });

  test('fails before identity publication when the source changes during the verified copy', async () => {
    const originalWriteSync = fs.writeSync;
    let changed = false;
    const copySpy = jest.spyOn(fs, 'writeSync').mockImplementation(((...args: any[]) => {
      const written = (originalWriteSync as any)(...args);
      if (!changed) {
        changed = true;
        fs.appendFileSync(path.join(projectRoot, 'hello.txt'), 'changed\n');
      }
      return written;
    }) as any);
    try {
      await expect(adoptLegacyProjectInPlace(
        { projectIdentity: identity, projectRoot },
        { database },
      )).rejects.toThrow(/changed (during migration|while it was copied)/i);
    } finally {
      copySpy.mockRestore();
    }
    expect(identity.legacyOpenClawMigrationStatus).toBe('NONE');
    expect(identity.generation).toBe(7);
  });
});
