import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  __nativeHostCliAdmissionTest,
  attestNativeHostCli,
  NativeHostCliAdmissionError,
  type NativeHostCliId,
} from './nativeHostCliAdmission';

const execFileAsync = promisify(execFile);
const ROOT_PACKAGE = '{"name":"@openai/codex","version":"0.145.0","bin":{"codex":"bin/codex.js"}}\n';
const PLATFORM_PACKAGE = '{"name":"@openai/codex","version":"0.145.0-linux-x64","os":["linux"],"cpu":["x64"]}\n';
const LAUNCHER = '#!/usr/bin/env node\nconsole.log("fixture");\n';
const PAYLOAD = 'fixture-native-payload\n';
const TREE_SHA256 = '234b97cbe57fb505bebf82257ef82677483a2b13a40472e22deee3d7dafb5d28';
const ROOT_PACKAGE_SHA256 = '1c6bb4ff70a7dedbe32c9fc004921b3c4607e499e9b2206974109d5a46ec8461';
const LAUNCHER_SHA256 = 'b40603f2f42a6a42223d70666134319f863373865a9badee5e08082a6209afd1';
const PLATFORM_PACKAGE_SHA256 = '0776bf59cdab1d46ad5ab0704f15ab975c011be3d93c4f1b17807a73c1491d1b';
const PAYLOAD_SHA256 = 'fed22b173c790cf294616802afdf42dc6fc70e80fafe0a7b24346d9b1d07fcdc';

type TestContext = Parameters<typeof __nativeHostCliAdmissionTest.attestWithContext>[0];

type Fixture = Readonly<{
  base: string;
  executablePath: string;
  packageRoot: string;
  launcherPath: string;
  platformRoot: string;
  payloadPath: string;
  context: TestContext;
}>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function mkdirSafe(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  await fs.chmod(directory, 0o755);
}

async function writeFixtureFile(filePath: string, bytes: string, mode: number): Promise<void> {
  await mkdirSafe(path.dirname(filePath));
  await fs.writeFile(filePath, bytes, { mode });
  await fs.chmod(filePath, mode);
}

async function createFixture(input: {
  toolId?: NativeHostCliId;
  versionAdmission?: 'full' | 'status-only';
  statusReason?: string;
  limits?: Partial<TestContext['limits']>;
  hooks?: TestContext['hooks'];
} = {}): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'native-host-cli-admission-'));
  await fs.chmod(base, 0o755);
  const executablePath = path.join(base, 'bin/codex');
  const packageRoot = path.join(base, 'lib/node_modules/@openai/codex');
  const launcherPath = path.join(packageRoot, 'bin/codex.js');
  const platformRoot = path.join(packageRoot, 'node_modules/@openai/codex-linux-x64');
  const payloadPath = path.join(platformRoot, 'vendor/bin/codex');
  await writeFixtureFile(path.join(packageRoot, 'package.json'), ROOT_PACKAGE, 0o644);
  await writeFixtureFile(launcherPath, LAUNCHER, 0o755);
  await writeFixtureFile(path.join(platformRoot, 'package.json'), PLATFORM_PACKAGE, 0o644);
  await writeFixtureFile(payloadPath, PAYLOAD, 0o755);
  await mkdirSafe(path.dirname(executablePath));
  await fs.symlink('../lib/node_modules/@openai/codex/bin/codex.js', executablePath);

  const versionAdmission = input.versionAdmission ?? 'full';
  const platform = Object.freeze({
    treeSha256: TREE_SHA256,
    criticalFiles: Object.freeze({
      'package.json': ROOT_PACKAGE_SHA256,
      'bin/codex.js': LAUNCHER_SHA256,
      'node_modules/@openai/codex-linux-x64/package.json': PLATFORM_PACKAGE_SHA256,
      'node_modules/@openai/codex-linux-x64/vendor/bin/codex': PAYLOAD_SHA256,
    }),
    hardlinkGroups: Object.freeze([]),
    platformPackageRelative: 'node_modules/@openai/codex-linux-x64',
    platformPackageName: '@openai/codex',
    platformPackageVersion: '0.145.0-linux-x64',
    platformBinRelative: 'vendor/bin/codex',
    sources: Object.freeze([Object.freeze({
      placement: '',
      packageName: '@openai/codex',
      version: '0.145.0',
      tarball: 'https://registry.npmjs.org/@openai/codex/-/codex-0.145.0.tgz',
      integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      sha256: 'a'.repeat(64),
    })]),
  });
  const definition = Object.freeze({
    packageName: '@openai/codex',
    packageRoot,
    binName: 'codex',
    binRelative: 'bin/codex.js',
    executables: Object.freeze({
      [executablePath]: '../lib/node_modules/@openai/codex/bin/codex.js',
    }),
    versions: Object.freeze({
      '0.145.0': Object.freeze({
        admission: versionAdmission,
        ...(versionAdmission === 'status-only'
          ? { statusReason: input.statusReason ?? 'Run Host Tools Maintenance.' }
          : {}),
        rootIntegrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        rootSha256: 'a'.repeat(64),
        platforms: versionAdmission === 'full'
          ? Object.freeze({ 'linux-x64-gnu': platform })
          : Object.freeze({}),
      }),
    }),
  });
  const context: TestContext = Object.freeze({
    toolId: input.toolId ?? 'codex',
    executablePath,
    definition,
    limits: Object.freeze({
      maxEntries: input.limits?.maxEntries ?? 64,
      maxDepth: input.limits?.maxDepth ?? 12,
      maxFileBytes: input.limits?.maxFileBytes ?? 1024 * 1024,
      maxTotalBytes: input.limits?.maxTotalBytes ?? 4 * 1024 * 1024,
    }),
    platformKey: 'linux-x64-gnu',
    requiredUid: process.getuid?.() ?? 0,
    requiredGid: process.getgid?.() ?? 0,
    ancestorFloor: base,
    now: () => new Date('2026-08-27T12:34:56.000Z'),
    hooks: input.hooks,
  });
  return Object.freeze({
    base,
    executablePath,
    packageRoot,
    launcherPath,
    platformRoot,
    payloadPath,
    context,
  });
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await fs.rm(fixture.base, { recursive: true, force: true });
}

async function expectAdmissionCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'NativeHostCliAdmissionError',
    code,
  });
}

describe('native host CLI admission', () => {
  test('fails closed before package admission while compatibility maintenance is active', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'native-host-cli-fence-'));
    const fenceRoot = path.join(base, 'native-cli-bundle-v1');
    const previous = process.env.BRIDGESLLM_NATIVE_CLI_BUNDLE_FENCE_ROOT;
    try {
      await fs.mkdir(fenceRoot, { mode: 0o700 });
      process.env.BRIDGESLLM_NATIVE_CLI_BUNDLE_FENCE_ROOT = fenceRoot;
      await expectAdmissionCode(attestNativeHostCli('codex'), 'MAINTENANCE_ACTIVE');
      await fs.rm(fenceRoot, { recursive: true, force: true });
      await fs.writeFile(`${fenceRoot}.terminal-intent.json`, '{}\n', { mode: 0o600 });
      await expectAdmissionCode(attestNativeHostCli('claude-code'), 'MAINTENANCE_ACTIVE');
    } finally {
      if (previous === undefined) delete process.env.BRIDGESLLM_NATIVE_CLI_BUNDLE_FENCE_ROOT;
      else process.env.BRIDGESLLM_NATIVE_CLI_BUNDLE_FENCE_ROOT = previous;
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test('exports stable typed errors and rejects non-catalog executable paths before filesystem access', async () => {
    await expectAdmissionCode(attestNativeHostCli('codex', '/tmp/codex'), 'INVALID_EXECUTABLE_PATH');
    await expect(attestNativeHostCli('codex', '/tmp/codex')).rejects.toMatchObject({
      observedVersion: null,
    });
    const error = new NativeHostCliAdmissionError('ABSENT', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('ABSENT');
    expect(error.observedVersion).toBeNull();
  });

  test('catalog is deeply immutable and carries the exact admitted/status-only version split', () => {
    const catalog = __nativeHostCliAdmissionTest.catalog;
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.tools.codex.versions)).toBe(true);
    expect(Object.keys(catalog.tools.codex.versions).sort()).toEqual(['0.145.0', '0.149.0', '0.153.2']);
    expect(Object.keys(catalog.tools['claude-code'].versions).sort()).toEqual(['2.1.220', '2.1.228', '2.1.260']);
    expect(catalog.tools.clawhub.versions['0.23.1'].admission).toBe('status-only');
    expect(catalog.tools.clawhub.versions['0.23.3'].admission).toBe('full');
    expect(catalog.tools.clawhub.executables).toEqual({
      '/usr/bin/clawdhub': '../lib/node_modules/clawhub/bin/clawdhub.js',
      '/usr/bin/clawhub': '../lib/node_modules/clawhub/bin/clawdhub.js',
    });
  });

  test('admits an exact package and returns an immutable observed identity', async () => {
    const fixture = await createFixture();
    try {
      expect(sha256(ROOT_PACKAGE)).toBe(ROOT_PACKAGE_SHA256);
      expect(sha256(LAUNCHER)).toBe(LAUNCHER_SHA256);
      expect(sha256(PLATFORM_PACKAGE)).toBe(PLATFORM_PACKAGE_SHA256);
      expect(sha256(PAYLOAD)).toBe(PAYLOAD_SHA256);
      const snapshot = await __nativeHostCliAdmissionTest.snapshotTree(
        fixture.packageRoot,
        fixture.context.limits,
        fixture.context.requiredUid,
        fixture.context.requiredGid,
      );
      expect(snapshot.digest).toBe(TREE_SHA256);
      const identity = await __nativeHostCliAdmissionTest.attestWithContext(fixture.context);
      expect(identity).toEqual({
        toolId: 'codex',
        executablePath: fixture.executablePath,
        packageName: '@openai/codex',
        version: '0.145.0',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        checkedAt: '2026-08-27T12:34:56.000Z',
      });
      expect(Object.isFrozen(identity)).toBe(true);
      expect(() => { (identity as { version: string }).version = 'forged'; }).toThrow();
    } finally {
      await removeFixture(fixture);
    }
  });

  test('distinguishes a recognized status-only version from unsupported versions', async () => {
    const statusOnly = await createFixture({ versionAdmission: 'status-only' });
    try {
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(statusOnly.context),
        'STATUS_ONLY_VERSION',
      );
      await expect(
        __nativeHostCliAdmissionTest.attestWithContext(statusOnly.context),
      ).rejects.toMatchObject({ observedVersion: '0.145.0' });
    } finally {
      await removeFixture(statusOnly);
    }

    const unsupported = await createFixture();
    try {
      await fs.writeFile(
        path.join(unsupported.packageRoot, 'package.json'),
        ROOT_PACKAGE.replace('0.145.0', '9.9.9'),
      );
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(unsupported.context),
        'UNSUPPORTED_VERSION',
      );
      await expect(
        __nativeHostCliAdmissionTest.attestWithContext(unsupported.context),
      ).rejects.toMatchObject({ observedVersion: '9.9.9' });
    } finally {
      await removeFixture(unsupported);
    }
  });

  test.each([
    ['package name', (value: string) => value.replace('@openai/codex', '@evil/codex')],
    ['bin mapping', (value: string) => value.replace('bin/codex.js', 'bin/other.js')],
  ])('rejects a forged %s', async (_label, mutate) => {
    const fixture = await createFixture();
    try {
      await fs.writeFile(path.join(fixture.packageRoot, 'package.json'), mutate(ROOT_PACKAGE));
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'DRIFT_DETECTED',
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  test('rejects the wrong platform and forged platform identity', async () => {
    const fixture = await createFixture();
    try {
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext({
          ...fixture.context,
          platformKey: 'linux-arm64-gnu',
        }),
        'UNSUPPORTED_PLATFORM',
      );
      await fs.writeFile(
        path.join(fixture.platformRoot, 'package.json'),
        PLATFORM_PACKAGE.replace('0.145.0-linux-x64', '0.145.0-linux-arm64'),
      );
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'DRIFT_DETECTED',
      );
      await expect(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
      ).rejects.toMatchObject({ observedVersion: '0.145.0' });
    } finally {
      await removeFixture(fixture);
    }
  });

  test.each([
    ['wrong symlink text', async (fixture: Fixture) => {
      await fs.unlink(fixture.executablePath);
      await fs.symlink('../lib/node_modules/@openai/codex/bin/other.js', fixture.executablePath);
    }],
    ['regular executable', async (fixture: Fixture) => {
      await fs.unlink(fixture.executablePath);
      await fs.writeFile(fixture.executablePath, LAUNCHER, { mode: 0o755 });
    }],
    ['writable ancestor', async (fixture: Fixture) => {
      await fs.chmod(path.join(fixture.base, 'lib'), 0o777);
    }],
    ['writable tree file', async (fixture: Fixture) => {
      await fs.chmod(fixture.launcherPath, 0o666);
    }],
    ['changed critical bytes', async (fixture: Fixture) => {
      await fs.writeFile(fixture.launcherPath, `${LAUNCHER}// drift\n`);
      await fs.chmod(fixture.launcherPath, 0o755);
    }],
    ['extra package file', async (fixture: Fixture) => {
      await fs.writeFile(path.join(fixture.packageRoot, 'extra.js'), 'unexpected\n');
    }],
  ])('rejects %s as drift', async (_label, mutate) => {
    const fixture = await createFixture();
    try {
      await mutate(fixture);
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'DRIFT_DETECTED',
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  test('rejects internal symlink escapes and dangling links', async () => {
    const fixture = await createFixture();
    try {
      await fs.symlink('/etc/passwd', path.join(fixture.packageRoot, 'escape'));
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'DRIFT_DETECTED',
      );
      await fs.unlink(path.join(fixture.packageRoot, 'escape'));
      await fs.symlink('../missing', path.join(fixture.packageRoot, 'dangling'));
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'DRIFT_DETECTED',
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  test('rejects FIFOs and Unix sockets without opening them', async () => {
    const fifoFixture = await createFixture();
    try {
      const fifo = path.join(fifoFixture.packageRoot, 'fifo');
      await execFileAsync('mkfifo', [fifo]);
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fifoFixture.context),
        'DRIFT_DETECTED',
      );
    } finally {
      await removeFixture(fifoFixture);
    }

    const socketFixture = await createFixture();
    const socketPath = path.join(socketFixture.packageRoot, 'socket');
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(socketFixture.context),
        'DRIFT_DETECTED',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeFixture(socketFixture);
    }
  });

  test('allows only exact in-tree hardlink groups and rejects external links', async () => {
    const fixture = await createFixture();
    try {
      await fs.unlink(fixture.launcherPath);
      await fs.link(fixture.payloadPath, fixture.launcherPath);
      const snapshot = await __nativeHostCliAdmissionTest.snapshotTree(
        fixture.packageRoot,
        fixture.context.limits,
        fixture.context.requiredUid,
        fixture.context.requiredGid,
      );
      expect(() => __nativeHostCliAdmissionTest.verifyHardlinks(snapshot, [[
        'bin/codex.js',
        'node_modules/@openai/codex-linux-x64/vendor/bin/codex',
      ]])).not.toThrow();
      expect(() => __nativeHostCliAdmissionTest.verifyHardlinks(snapshot, [])).toThrow(
        expect.objectContaining({ code: 'DRIFT_DETECTED' }),
      );
      const external = path.join(fixture.base, 'external-link');
      await fs.link(fixture.payloadPath, external);
      const externallyLinked = await __nativeHostCliAdmissionTest.snapshotTree(
        fixture.packageRoot,
        fixture.context.limits,
        fixture.context.requiredUid,
        fixture.context.requiredGid,
      );
      expect(() => __nativeHostCliAdmissionTest.verifyHardlinks(externallyLinked, [[
        'bin/codex.js',
        'node_modules/@openai/codex-linux-x64/vendor/bin/codex',
      ]])).toThrow(expect.objectContaining({ code: 'DRIFT_DETECTED' }));
    } finally {
      await removeFixture(fixture);
    }
  });

  test.each([
    ['entry count', { maxEntries: 2 }],
    ['depth', { maxDepth: 1 }],
    ['file bytes', { maxFileBytes: 8 }],
    ['total bytes', { maxTotalBytes: 16, maxFileBytes: 16 }],
  ])('fails closed when the %s bound is exceeded', async (_label, limits) => {
    const fixture = await createFixture({ limits });
    try {
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'BOUND_EXCEEDED',
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  test('detects a file change after the initial complete tree scan', async () => {
    let fixture: Fixture;
    fixture = await createFixture({
      hooks: {
        afterInitialTreeScan: async () => {
          await fs.appendFile(fixture.launcherPath, '// raced\n');
        },
      },
    });
    try {
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'RACE_DETECTED',
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  test('detects a new root entry after the initial complete tree scan', async () => {
    let fixture: Fixture;
    fixture = await createFixture({
      hooks: {
        afterInitialTreeScan: async () => {
          await fs.writeFile(path.join(fixture.packageRoot, 'raced-root-entry'), 'raced\n');
        },
      },
    });
    try {
      await expectAdmissionCode(
        __nativeHostCliAdmissionTest.attestWithContext(fixture.context),
        'RACE_DETECTED',
      );
    } finally {
      await removeFixture(fixture);
    }
  });

  test('catalog parser rejects malformed schemas, paths, sources, and status-only claims', () => {
    const base = JSON.parse(JSON.stringify(__nativeHostCliAdmissionTest.catalog));
    for (const mutate of [
      (value: any) => { value.schema = 'wrong'; },
      (value: any) => { value.tools.codex.packageRoot = '../escape'; },
      (value: any) => { value.tools.codex.versions['0.145.0'].platforms['linux-x64-gnu'].treeSha256 = '0'; },
      (value: any) => { value.tools.codex.versions['0.145.0'].platforms['linux-x64-gnu'].sources[0].tarball = 'https://evil.invalid/a.tgz'; },
      (value: any) => {
        value.tools.clawhub.versions['0.23.1'].platforms['linux-x64-gnu'] =
          value.tools.clawhub.versions['0.23.3'].platforms['linux-x64-gnu'];
      },
    ]) {
      const candidate = JSON.parse(JSON.stringify(base));
      mutate(candidate);
      expect(() => __nativeHostCliAdmissionTest.parseCatalog(candidate)).toThrow(
        expect.objectContaining({ code: 'CATALOG_INVALID' }),
      );
    }
  });

  test('runtime module has no child-process, network, package-manager, or mutation API', async () => {
    const source = await fs.readFile(path.join(__dirname, 'nativeHostCliAdmission.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|execFile|spawn|npm\s|from ['"]https?['"]|\bfetch\s*\(|writeFile|chmod|chown|unlink|rename|mkdir|rmSync/);
    expect(source).toContain("startsWith('https://registry.npmjs.org/')");
    expect(source).toContain("from 'fs/promises'");
    expect(source).toContain('O_NOFOLLOW');
  });
});
