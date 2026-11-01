/**
 * Cross-language contract: toolctl (Python, installer/tools/bridgesllm-toolctl.py)
 * is the only writer of admission records; this backend only reads them. The
 * fixture record below is the Python writer's output for the shared fixture
 * tree (installer/tools/tests/test_toolctl_npm.py keeps it byte-identical).
 */
import { promises as fs, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { __nativeHostCliAdmissionTest } from './nativeHostCliAdmission';
import { parseNativeHostCliAdmissionRecord } from './nativeHostCliAdmissionRecord';

type TestContext = Parameters<typeof __nativeHostCliAdmissionTest.attestWithContext>[0];
type SpecEntry = Readonly<{ path: string; kind: 'directory' | 'file' | 'hardlink' | 'symlink'; mode?: number; text?: string; target?: string }>;

const FIXTURES = path.resolve(__dirname, '../../../installer/tools/tests/fixtures/npm-admission');
const spec = JSON.parse(readFileSync(path.join(FIXTURES, 'claude-code-tree.json'), 'utf8')) as Readonly<{
  toolId: 'claude-code';
  version: string;
  packageRoot: string;
  platform: string;
  entries: readonly SpecEntry[];
}>;
const recordText = readFileSync(path.join(FIXTURES, 'claude-code.record.json'), 'utf8');
const ORDER: Readonly<Record<SpecEntry['kind'], number>> = { directory: 0, file: 1, hardlink: 2, symlink: 3 };
const EXECUTABLE_LINK = '../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

async function materialize(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.chmod(root, 0o755);
  for (const entry of [...spec.entries].sort((left, right) => ORDER[left.kind] - ORDER[right.kind])) {
    const target = path.join(root, entry.path);
    if (entry.kind === 'directory') {
      await fs.mkdir(target, { recursive: true });
      await fs.chmod(target, entry.mode as number);
    } else if (entry.kind === 'file') {
      await fs.writeFile(target, entry.text as string, 'utf8');
      await fs.chmod(target, entry.mode as number);
    } else if (entry.kind === 'hardlink') {
      await fs.link(path.join(root, entry.target as string), target);
    } else {
      await fs.symlink(entry.target as string, target);
    }
  }
}

async function installedFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'toolctl-record-contract-'));
  await fs.chmod(base, 0o755);
  const packageRoot = path.join(base, 'lib/node_modules/@anthropic-ai/claude-code');
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  for (const directory of ['lib', 'lib/node_modules', 'lib/node_modules/@anthropic-ai']) await fs.chmod(path.join(base, directory), 0o755);
  await materialize(packageRoot);
  const executablePath = path.join(base, 'bin/claude');
  await fs.mkdir(path.dirname(executablePath), { mode: 0o755 });
  await fs.chmod(path.dirname(executablePath), 0o755);
  await fs.symlink(EXECUTABLE_LINK, executablePath);
  // Only the package root differs from the production fixture; the tree facts are untouched.
  const recordRoot = path.join(base, 'admission');
  await fs.mkdir(recordRoot, { mode: 0o700 });
  await fs.chmod(recordRoot, 0o700);
  const recordPath = path.join(recordRoot, 'claude-code.json');
  await fs.writeFile(recordPath, JSON.stringify({ ...JSON.parse(recordText), packageRoot }), { mode: 0o600 });
  await fs.chmod(recordPath, 0o600);
  const context: TestContext = Object.freeze({
    toolId: 'claude-code',
    executablePath,
    definition: Object.freeze({
      packageName: '@anthropic-ai/claude-code',
      packageRoot,
      binName: 'claude',
      binRelative: 'bin/claude.exe',
      executables: Object.freeze({ [executablePath]: EXECUTABLE_LINK }),
      versions: {} as any,
    }),
    limits: __nativeHostCliAdmissionTest.catalog.limits,
    platformKey: spec.platform,
    requiredUid: process.getuid?.() ?? 0,
    requiredGid: process.getgid?.() ?? 0,
    ancestorFloor: base,
    now: () => new Date('2026-10-30T22:45:00.000Z'),
    recordRoot,
  });
  return { base, packageRoot, context };
}

describe('admission records written by toolctl', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it('parses the Python writer output with the strict backend parser', () => {
    const record = parseNativeHostCliAdmissionRecord(JSON.parse(recordText), {
      toolId: 'claude-code',
      packageName: '@anthropic-ai/claude-code',
      packageRoot: spec.packageRoot,
      platform: spec.platform,
    });
    expect(record.version).toBe(spec.version);
    expect(record.admittedBy).toBe('requalify:0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01');
    expect(record.source).toMatchObject({ kind: 'npm-registry', signatures: 'verified', provenance: 'unavailable', verifier: 'npm-audit-signatures' });
    expect(record.hardlinkGroups).toEqual([['bin/claude.exe', 'node_modules/@anthropic-ai/claude-code-linux-x64/claude']]);
  });

  it('hashes the same tree to the digest the Python walker recorded', async () => {
    const { base, packageRoot, context } = await installedFixture();
    cleanup.push(base);
    const snapshot = await __nativeHostCliAdmissionTest.snapshotTree(packageRoot, context.limits, context.requiredUid, context.requiredGid);
    const record = JSON.parse(recordText);
    expect(snapshot.digest).toBe(record.treeSha256);
    for (const [relativePath, digest] of Object.entries(record.criticalFiles)) {
      expect(snapshot.entries.get(relativePath)?.sha256).toBe(digest);
    }
  });

  it('admits the installed tree by the toolctl record, and calls a changed tree drift', async () => {
    const { base, packageRoot, context } = await installedFixture();
    cleanup.push(base);
    const identity = await __nativeHostCliAdmissionTest.attestWithContext(context);
    expect(identity).toMatchObject({ toolId: 'claude-code', version: spec.version, admittedBy: 'admission-record' });

    await fs.appendFile(path.join(packageRoot, 'cli-wrapper.cjs'), '// changed\n');
    await expect(__nativeHostCliAdmissionTest.attestWithContext(context)).rejects.toMatchObject({ code: 'DRIFT_DETECTED' });
  });
});
