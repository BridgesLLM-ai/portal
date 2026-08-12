import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface FixturePaths {
  root: string;
  ownerRoot: string;
  workspace: string;
  destination: string;
  stateFile: string;
  backupRoot: string;
  resultFile: string;
  journal: string;
  displacement: string;
  cleanupObservation: string;
  cleanupInitialFiles: number;
}

const REPAIR_ID = '7d7a7f9a-1f50-4c3f-8b35-669fed578b81';
const FIXTURE = path.join(__dirname, 'projectDependencyRepair.crash-fixture.ts');
const BACKEND_ROOT = path.resolve(__dirname, '../..');

function createFixture(deepFiles = 0): FixturePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-dependency-repair-crash-'));
  fs.chmodSync(root, 0o700);
  const ownerRoot = path.join(root, 'owner-a');
  const workspace = path.join(root, 'workspace');
  const destination = path.join(ownerRoot, 'project-a');
  fs.mkdirSync(path.join(workspace, 'node_modules', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'node_modules', 'old-nested'), { recursive: true });
  fs.chmodSync(ownerRoot, 0o700);
  fs.writeFileSync(path.join(workspace, 'node_modules', 'new.js'), 'new-generation\n');
  fs.writeFileSync(path.join(workspace, 'node_modules', 'nested', 'deep.js'), 'new-deep\n');
  fs.writeFileSync(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3,"new":true}\n');
  fs.writeFileSync(path.join(workspace, '.deps-installed'), 'new-generation-digest\n');
  fs.writeFileSync(path.join(destination, 'node_modules', 'old.js'), 'old-generation\n');
  fs.writeFileSync(path.join(destination, 'node_modules', 'old-nested', 'deep.js'), 'old-deep\n');
  fs.writeFileSync(path.join(destination, 'package-lock.json'), '{"lockfileVersion":2,"old":true}\n');
  fs.writeFileSync(path.join(destination, '.deps-installed'), 'old-generation-digest\n');
  for (let index = 0; index < deepFiles; index += 1) {
    const directory = path.join(
      destination,
      'node_modules',
      'bulk-old',
      String(Math.floor(index / 250)).padStart(3, '0'),
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${String(index).padStart(6, '0')}.js`), 'old\n');
  }
  return {
    root,
    ownerRoot,
    workspace,
    destination,
    stateFile: path.join(root, 'durable-database.json'),
    backupRoot: path.join(root, 'backups'),
    resultFile: path.join(root, 'recovery-result.json'),
    journal: path.join(ownerRoot, `.bridgesllm-project-repair-${REPAIR_ID}.journal.json`),
    displacement: path.join(ownerRoot, `.bridgesllm-project-repair-${REPAIR_ID}`),
    cleanupObservation: path.join(root, 'backups', 'cleanup-partial-observation.json'),
    cleanupInitialFiles: deepFiles + 2,
  };
}

function invoke(
  paths: FixturePaths,
  mode: 'crash' | 'recover',
  checkpoint?: string,
  timeout = 60_000,
) {
  return spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', FIXTURE],
    {
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
        PROJECT_DEPENDENCY_REPAIR_CRASH_FIXTURE: JSON.stringify({
          mode,
          checkpoint,
          root: paths.root,
          workspace: paths.workspace,
          destination: paths.destination,
          stateFile: paths.stateFile,
          backupRoot: paths.backupRoot,
          repairId: REPAIR_ID,
          cleanupInitialFiles: paths.cleanupInitialFiles,
          resultFile: paths.resultFile,
        }),
      },
      encoding: 'utf8',
      timeout,
    },
  );
}

function expectKilled(result: ReturnType<typeof invoke>): void {
  expect({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stderr: result.stderr,
  }).toEqual({
    status: null,
    signal: 'SIGKILL',
    error: undefined,
    stderr: '',
  });
}

function expectExactAllNew(paths: FixturePaths): void {
  expect(fs.existsSync(path.join(paths.destination, 'node_modules', 'old.js'))).toBe(false);
  expect(fs.existsSync(path.join(paths.destination, 'node_modules', 'old-nested'))).toBe(false);
  expect(fs.readFileSync(path.join(paths.destination, 'node_modules', 'new.js'), 'utf8'))
    .toBe('new-generation\n');
  expect(fs.readFileSync(path.join(paths.destination, 'node_modules', 'nested', 'deep.js'), 'utf8'))
    .toBe('new-deep\n');
  expect(fs.readFileSync(path.join(paths.destination, 'package-lock.json'), 'utf8'))
    .toBe('{"lockfileVersion":3,"new":true}\n');
  expect(fs.readFileSync(path.join(paths.destination, '.deps-installed'), 'utf8'))
    .toBe('new-generation-digest\n');
}

function expectRecovered(paths: FixturePaths): void {
  const recovered = invoke(paths, 'recover');
  expect({ status: recovered.status, signal: recovered.signal, stderr: recovered.stderr }).toEqual({
    status: 0,
    signal: null,
    stderr: '',
  });
  expectExactAllNew(paths);
  expect(fs.existsSync(paths.journal)).toBe(false);
  expect(fs.existsSync(paths.displacement)).toBe(false);
  const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
  expect(state.decision).toBeNull();
  expect(state.lifecycle).toMatchObject({
    lifecycleStatus: 'ACTIVE',
    dependencyQuarantinedAt: null,
  });
  expect(state.repair).toMatchObject({
    repairId: REPAIR_ID,
    status: 'APPLIED',
    phase: 'COMPLETE',
  });
  const result = JSON.parse(fs.readFileSync(paths.resultFile, 'utf8'));
  expect(result.outcome.held).toBe(0);
  expect(result.after.hasEvidence).toBe(false);
  expect(result.after.unboundEvidence).toEqual([]);
}

describe('Project dependency repair real SIGKILL and startup recovery', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  test.each([
    'after-go-bit',
    'before-displace-target:0',
    'after-displace-target:0',
    'after-promote:0',
    'after-all-new',
    'after-committed-journal',
    'after-phase:ALL_NEW',
    'after-promotion-evidence-cleanup',
    'after-phase:EVIDENCE_CLEAN',
    'after-phase:COMPLETE',
  ])('a fresh process converges the real disk journal after SIGKILL at %s', (checkpoint) => {
    const paths = createFixture();
    roots.push(paths.root);
    const crashed = invoke(paths, 'crash', checkpoint);
    expectKilled(crashed);
    expect(fs.existsSync(paths.stateFile)).toBe(true);
    expect(fs.existsSync(paths.journal)).toBe(true);
    expectRecovered(paths);
  }, 90_000);

  test('a separate watchdog kills during cleanup intent/deep deletion and startup resumes it', () => {
    const paths = createFixture(12_000);
    roots.push(paths.root);
    const crashed = invoke(paths, 'crash', 'external-cleanup-partial', 120_000);
    expectKilled(crashed);
    const journal = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
    expect(journal.phase).toBe('EVIDENCE_CLEAN');
    expect(journal.movePlan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'DISPLACE_TARGET',
        artifact: 'node_modules',
        phase: 'CLEANUP_INTENT',
      }),
    ]));
    expect(fs.existsSync(paths.displacement)).toBe(true);
    const observation = JSON.parse(fs.readFileSync(paths.cleanupObservation, 'utf8'));
    expect(observation.expected).toBe(paths.cleanupInitialFiles);
    expect(observation.rootExists).toBe(true);
    expect(
      (observation.count > 0 && observation.count < observation.expected)
      || observation.changedDuringWalk === true,
    ).toBe(true);
    expectRecovered(paths);
  }, 180_000);

  test('a fresh process fails closed on changed journal bytes and leaves the old generation live', () => {
    const paths = createFixture();
    roots.push(paths.root);
    expectKilled(invoke(paths, 'crash', 'after-go-bit'));
    const journal = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
    journal.manifestDigest = '0'.repeat(64);
    fs.writeFileSync(paths.journal, `${JSON.stringify(journal)}\n`, { mode: 0o600 });

    const recovery = invoke(paths, 'recover');
    expect(recovery.status).toBe(1);
    expect(recovery.signal).toBeNull();
    expect(recovery.stderr).toMatch(/evidence|journal|disagree|conflict/i);
    expect(fs.readFileSync(path.join(paths.destination, 'node_modules', 'old.js'), 'utf8'))
      .toBe('old-generation\n');
    expect(fs.existsSync(path.join(paths.destination, 'node_modules', 'new.js'))).toBe(false);
    expect(fs.existsSync(paths.journal)).toBe(true);
    expect(fs.existsSync(paths.displacement)).toBe(true);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lifecycle.lifecycleStatus).toBe('DEPENDENCY_PROMOTING');
    expect(state.repair).toMatchObject({ status: 'PROMOTING', phase: 'GO_BIT' });
  }, 90_000);
});
