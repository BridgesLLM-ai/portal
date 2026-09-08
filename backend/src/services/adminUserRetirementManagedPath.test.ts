import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AdminUserRetirementIntegrityError,
} from './adminUserRetirementLedger';
import {
  assertAdminUserManagedPathAbsent,
  captureAdminUserRetirementManagedPath,
  digestAdminUserRetirementManagedPathAbsence,
  retireAdminUserManagedPath,
} from './adminUserRetirementManagedPath';

describe('admin user retirement managed-path authority', () => {
  let sandbox: string;
  let managedRoot: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-user-retirement-path-'));
    managedRoot = path.join(sandbox, 'managed');
    fs.mkdirSync(managedRoot, { mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('retires an exact regular file through deterministic quarantine and proves absence', async () => {
    const target = path.join(managedRoot, 'target.jsonl');
    fs.writeFileSync(target, 'private transcript\n', { mode: 0o600 });
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'FILE',
    });

    await retireAdminUserManagedPath(attestation);
    await expect(assertAdminUserManagedPathAbsent(attestation)).resolves.toBeUndefined();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(attestation.quarantinePath)).toBe(false);
    expect(digestAdminUserRetirementManagedPathAbsence([attestation])).toMatch(/^[a-f0-9]{64}$/);
  });

  test('resumes after a crash between rename and recursive directory removal', async () => {
    const target = path.join(managedRoot, 'user-user-1');
    fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(target, 'nested', 'private.txt'), 'private');
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'DIRECTORY',
    });

    await expect(retireAdminUserManagedPath(attestation, {
      afterRename: () => {
        throw new Error('simulated process crash');
      },
    })).rejects.toThrow('simulated process crash');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(attestation.quarantinePath)).toBe(true);

    await expect(retireAdminUserManagedPath(attestation)).resolves.toBeUndefined();
    expect(fs.existsSync(attestation.quarantinePath)).toBe(false);
  });

  test('rejects a same-path replacement instead of deleting an unmanifested object', async () => {
    const target = path.join(managedRoot, 'avatar.png');
    fs.writeFileSync(target, 'old', { mode: 0o600 });
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'FILE',
    });
    fs.unlinkSync(target);
    fs.writeFileSync(target, 'replacement', { mode: 0o600 });

    await expect(retireAdminUserManagedPath(attestation))
      .rejects.toBeInstanceOf(AdminUserRetirementIntegrityError);
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
  });

  test('rejects unmanifested directory content instead of recursively deleting it', async () => {
    const target = path.join(managedRoot, 'user-user-1');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'manifested.txt'), 'manifested');
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'DIRECTORY',
    });
    fs.writeFileSync(path.join(target, 'late.txt'), 'must remain');

    await expect(retireAdminUserManagedPath(attestation))
      .rejects.toThrow(/directory content changed/i);
    expect(fs.readFileSync(path.join(target, 'late.txt'), 'utf8')).toBe('must remain');
  });

  test('removes a Project-owner container only after it is empty', async () => {
    const target = path.join(managedRoot, 'user-user-1');
    fs.mkdirSync(target);
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'CONTAINER_DIRECTORY',
    });
    fs.writeFileSync(path.join(target, 'unexpected.txt'), 'must remain');
    await expect(retireAdminUserManagedPath(attestation))
      .rejects.toThrow(/container is not empty/i);
    expect(fs.existsSync(target)).toBe(true);

    fs.unlinkSync(path.join(target, 'unexpected.txt'));
    await expect(retireAdminUserManagedPath(attestation)).resolves.toBeUndefined();
    expect(fs.existsSync(target)).toBe(false);
  });

  test('fails closed when state appears at a target attested absent', async () => {
    const target = path.join(managedRoot, 'absent-at-manifest');
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'DIRECTORY',
    });
    expect(attestation.present).toBe(false);
    fs.mkdirSync(target);

    await expect(retireAdminUserManagedPath(attestation))
      .rejects.toThrow(/appeared at a previously absent/i);
    expect(fs.existsSync(target)).toBe(true);
  });

  test('never follows a target or intermediate symlink outside the managed root', async () => {
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'must remain');
    const alias = path.join(managedRoot, 'alias');
    fs.symlinkSync(outside, alias);

    expect(() => captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: path.join(alias, 'sentinel'),
      kind: 'FILE',
    })).toThrow(/symlinked path component/i);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('must remain');
  });

  test('rejects root swaps, source/quarantine ambiguity, and forged quarantine paths', async () => {
    const target = path.join(managedRoot, 'target');
    fs.mkdirSync(target);
    const attestation = captureAdminUserRetirementManagedPath({
      targetUserId: 'user-1',
      managedRoot,
      targetPath: target,
      kind: 'DIRECTORY',
    });

    fs.mkdirSync(path.dirname(attestation.quarantinePath), { mode: 0o700 });
    fs.mkdirSync(attestation.quarantinePath);
    await expect(retireAdminUserManagedPath(attestation))
      .rejects.toThrow(/source and quarantine both exist/i);

    await expect(retireAdminUserManagedPath({
      ...attestation,
      quarantinePath: path.join(managedRoot, 'forged'),
    })).rejects.toThrow(/not deterministic/i);

    fs.rmSync(attestation.quarantinePath, { recursive: true });
    fs.renameSync(managedRoot, `${managedRoot}-old`);
    fs.mkdirSync(managedRoot, { mode: 0o700 });
    await expect(retireAdminUserManagedPath(attestation))
      .rejects.toThrow(/root identity changed/i);
  });
});

