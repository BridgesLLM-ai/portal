import fs from 'fs';
import path from 'path';

const projectsSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
const filesSource = fs.readFileSync(path.resolve(__dirname, '../routes/files.ts'), 'utf8');
const appProcessSource = fs.readFileSync(
  path.resolve(__dirname, '../services/app-process.service.ts'),
  'utf8',
);
const lifecycleSource = fs.readFileSync(
  path.resolve(__dirname, '../services/project-lifecycle.service.ts'),
  'utf8',
);

function block(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Project mutation admission side-door contract', () => {
  test('the entire Git route acquires exact lifecycle admission before resolving the Project', () => {
    const route = block(
      projectsSource,
      "router.post('/:name/git'",
      "router.post('/upload-zip'",
    );
    const lock = route.indexOf('releaseProjectFileMutationLock = await acquireProjectDeletionLock(');
    const resolution = route.indexOf('const projectDir = getProjectPath(ownerId, req.params.name)');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(resolution);
    expect(route.slice(lock, resolution)).toContain(
      'projectDeletionLockKey(ownerId, req.params.name)',
    );
    expect(route).not.toContain('PROJECT_GIT_WORKTREE_MUTATION_ACTIONS');
    expect(route).toContain('releaseProjectFileMutationLock?.()');
  });

  test('documentation update holds lifecycle admission through writes and Git commit', () => {
    const route = block(
      projectsSource,
      "router.post('/:name/doc-update'",
      "router.post('/:name/share'",
    );
    const lock = route.indexOf('releaseProjectFileMutationLock = await acquireProjectDeletionLock(');
    const resolution = route.indexOf('const projectDir = getProjectPath(ownerId, req.params.name)');
    const write = route.indexOf("writeProjectRuntimeTextFile(projectDir, 'NOTES.md'");
    const release = route.indexOf('releaseProjectFileMutationLock?.()');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(resolution);
    expect(resolution).toBeLessThan(write);
    expect(write).toBeLessThan(release);
  });

  test('copy-to-project enters the shared lifecycle guard before destination mutation', () => {
    const route = block(
      filesSource,
      "router.post('/:id/copy-to-project'",
      '// POST /api/files/sync',
    );
    const admission = route.indexOf('await withProjectDeletionLock({');
    const directory = route.indexOf('ensureProjectRuntimeOwnedDirectory(projectDir, relativeDestDir)');
    const copy = route.indexOf('fs.copyFileSync(sourcePath, destPath');
    expect(admission).toBeGreaterThanOrEqual(0);
    expect(admission).toBeLessThan(directory);
    expect(directory).toBeLessThan(copy);

    const missingOwner = lifecycleSource.indexOf('if (!fs.existsSync(ownerRoot)) {');
    expect(missingOwner).toBeGreaterThanOrEqual(0);
    expect(lifecycleSource.slice(missingOwner, missingOwner + 320)).toContain(
      'await assertLifecycleAdmissionOpen();',
    );
  });

  test('public App starts require a held exact Project lease and one ACTIVE joined identity read', () => {
    const attestation = block(
      appProcessSource,
      'async function assertExactStartAppBinding',
      '/**\n * Start a full-stack app process',
    );
    expect(attestation).toContain('assertHeldProjectDeletionLockLease(input.lifecycleLock, lockKey)');
    expect(attestation).toContain("lifecycleStatus: 'ACTIVE'");
    expect(attestation).toContain('generation: input.projectGeneration');
    expect(attestation).toContain('projectIdentity: {');
    expect(attestation).toContain('const binding = await prisma.app.findFirst({');

    for (const start of [
      block(appProcessSource, 'export async function startApp(', '/**\n * Restart a full-stack app'),
      block(appProcessSource, 'export async function restartApp(', '/**\n * Stop an app process'),
    ]) {
      const reattest = start.indexOf('await assertExactStartAppBinding({');
      const launch = start.indexOf('return startAppUnlocked(', reattest);
      expect(reattest).toBeGreaterThanOrEqual(0);
      expect(launch).toBeGreaterThan(reattest);
      expect(start.slice(reattest, launch)).toContain('lifecycleLock: identity.lifecycleLock');
    }

    const bootRecovery = block(
      appProcessSource,
      'export async function restoreRunningApps()',
      '/**\n * Idempotent Portal-start hook',
    );
    expect(bootRecovery).toContain('startAppUnlocked(');
    expect(bootRecovery).not.toContain('await startApp(');
  });
});
