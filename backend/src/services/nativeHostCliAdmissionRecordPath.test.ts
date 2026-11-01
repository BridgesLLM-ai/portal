import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { __nativeHostCliAdmissionTest } from './nativeHostCliAdmission';
import { officialNpmTarballUrl, parseNativeHostCliAdmissionRecord } from './nativeHostCliAdmissionRecord';
import { buildNativeHostCliAdmissionRecord, type NativeHostCliTreeFacts } from './nativeHostCliAdmissionRecordStore';

type TestContext = Parameters<typeof __nativeHostCliAdmissionTest.attestWithContext>[0];

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const LAUNCHER = '#!/usr/bin/env node\nconsole.log("fixture");\n';
const PAYLOAD = 'fixture-native-payload\n';
const rootPackage = (version: string) => `{"name":"@openai/codex","version":"${version}","bin":{"codex":"bin/codex.js"}}\n`;
const platformPackage = (version: string) => `{"name":"@openai/codex","version":"${version}-linux-x64","os":["linux"],"cpu":["x64"]}\n`;

async function writeFile(filePath: string, bytes: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  await fs.writeFile(filePath, bytes, { mode });
  await fs.chmod(filePath, mode);
}

/**
 * An installed Codex whose version the fixture catalog does not list (unless
 * `catalog` says otherwise), plus a record directory beside it.
 */
async function createFixture(version: string, catalog: Readonly<Record<string, unknown>> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'native-cli-record-path-'));
  await fs.chmod(base, 0o755);
  const executablePath = path.join(base, 'bin/codex');
  const packageRoot = path.join(base, 'lib/node_modules/@openai/codex');
  const recordRoot = path.join(base, 'admission');
  await writeFile(path.join(packageRoot, 'package.json'), rootPackage(version), 0o644);
  await writeFile(path.join(packageRoot, 'bin/codex.js'), LAUNCHER, 0o755);
  await writeFile(path.join(packageRoot, 'node_modules/@openai/codex-linux-x64/package.json'), platformPackage(version), 0o644);
  await writeFile(path.join(packageRoot, 'node_modules/@openai/codex-linux-x64/vendor/bin/codex'), PAYLOAD, 0o755);
  for (const directory of [path.join(base, 'lib'), path.join(base, 'lib/node_modules'), path.join(base, 'lib/node_modules/@openai'), packageRoot]) {
    await fs.chmod(directory, 0o755);
  }
  await fs.mkdir(path.dirname(executablePath), { mode: 0o755 });
  await fs.symlink('../lib/node_modules/@openai/codex/bin/codex.js', executablePath);
  const context: TestContext = Object.freeze({
    toolId: 'codex',
    executablePath,
    definition: Object.freeze({
      packageName: '@openai/codex',
      packageRoot,
      binName: 'codex',
      binRelative: 'bin/codex.js',
      executables: Object.freeze({ [executablePath]: '../lib/node_modules/@openai/codex/bin/codex.js' }),
      versions: catalog as any,
    }),
    limits: Object.freeze({ maxEntries: 64, maxDepth: 12, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }),
    platformKey: 'linux-x64-gnu',
    requiredUid: process.getuid?.() ?? 0,
    requiredGid: process.getgid?.() ?? 0,
    ancestorFloor: base,
    now: () => new Date('2026-10-30T22:10:00.000Z'),
    recordRoot,
  });
  return { base, packageRoot, recordRoot, executablePath, context };
}

async function treeFacts(context: TestContext, version: string): Promise<NativeHostCliTreeFacts> {
  const snapshot = await __nativeHostCliAdmissionTest.snapshotTree(
    context.definition.packageRoot, context.limits, context.requiredUid, context.requiredGid,
  );
  return {
    treeSha256: snapshot.digest,
    criticalFiles: { 'package.json': sha256(rootPackage(version)), 'bin/codex.js': sha256(LAUNCHER) },
    hardlinkGroups: [],
    platformPackageRelative: 'node_modules/@openai/codex-linux-x64',
    platformPackageName: '@openai/codex',
    platformPackageVersion: `${version}-linux-x64`,
    platformBinRelative: 'vendor/bin/codex',
  };
}

/** Simulates a verified official release whose staged tree equals the installed one. */
async function admitByRecord(fixture: Awaited<ReturnType<typeof createFixture>>, version: string, tree?: NativeHostCliTreeFacts) {
  const facts = tree || await treeFacts(fixture.context, version);
  const record = buildNativeHostCliAdmissionRecord('codex', {
    packageName: '@openai/codex',
    version,
    tarball: officialNpmTarballUrl('@openai/codex', version),
    integrity: `sha512-${createHash('sha512').update(`codex-${version}`).digest('base64')}`,
    signatures: 'verified',
    provenance: 'verified',
    stagedTree: facts,
  }, {
    packageName: '@openai/codex', packageRoot: fixture.packageRoot, version, platform: 'linux-x64-gnu', tree: facts,
  }, { admittedBy: 'run:fixture', now: new Date('2026-10-30T22:00:00.000Z') });
  return writeRecordFixture(record, fixture.recordRoot);
}

/** Puts a record where toolctl would (dir 0700, file 0600); the backend itself never writes one. */
async function writeRecordFixture(record: unknown, root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const target = path.join(root, `${(record as { toolId: string }).toolId}.json`);
  await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(target, 0o600);
  return target;
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'NativeHostCliAdmissionError', code });
  if (message) await expect(promise).rejects.toThrow(message);
}

describe('native host CLI admission by record (second accept path)', () => {
  const fixtures: string[] = [];
  async function fixture(version: string, catalog?: Readonly<Record<string, unknown>>) {
    const created = await createFixture(version, catalog);
    fixtures.push(created.base);
    return created;
  }
  afterEach(async () => {
    for (const base of fixtures.splice(0)) await fs.rm(base, { recursive: true, force: true });
  });

  test('admits a version the catalog does not list when its record proves the installed tree', async () => {
    const installed = await fixture('0.166.0');
    await admitByRecord(installed, '0.166.0');
    const identity = await __nativeHostCliAdmissionTest.attestWithContext(installed.context);
    expect(identity).toEqual({
      toolId: 'codex',
      executablePath: installed.executablePath,
      packageName: '@openai/codex',
      version: '0.166.0',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      checkedAt: '2026-10-30T22:10:00.000Z',
      admittedBy: 'admission-record',
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  test('refuses in plain words without a record, with records off, or below the record floor', async () => {
    const installed = await fixture('0.166.0');
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'UNSUPPORTED_VERSION',
      /codex 0\.166\.0 is not an admitted version yet: it is not in the Portal's catalog and has not been checked against its official release\. Run Re-check for it in Maintenance\./);
    await admitByRecord(installed, '0.166.0');
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext({ ...installed.context, recordRoot: null }), 'UNSUPPORTED_VERSION',
      /^codex 0\.166\.0 is not an admitted version\.$/);
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext({ ...installed.context, recordRoot: undefined }), 'UNSUPPORTED_VERSION');

    const old = await fixture('0.150.0');
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(old.context), 'UNSUPPORTED_VERSION',
      /codex 0\.150\.0 is not an admitted version: codex 0\.150\.0 is older than the admission-record floor 0\.163\.0\./);
  });

  test('any byte, mode or entry change after admission is drift, and so is a version change', async () => {
    const installed = await fixture('0.166.0');
    await admitByRecord(installed, '0.166.0');
    await fs.appendFile(path.join(installed.packageRoot, 'bin/codex.js'), '// patched\n');
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'DRIFT_DETECTED',
      /codex 0\.166\.0 files changed since they were last checked\. Run Re-check for it in Maintenance to re-qualify them\./);

    const bumped = await fixture('0.166.0');
    await admitByRecord(bumped, '0.166.0');
    await fs.writeFile(path.join(bumped.packageRoot, 'package.json'), rootPackage('0.167.0'));
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(bumped.context), 'DRIFT_DETECTED',
      /codex changed to 0\.167\.0 since it was last checked \(0\.166\.0\)\. Run Re-check for it in Maintenance to re-qualify it\./);
  });

  test('refuses an unsafe or malformed record as an invalid admission authority', async () => {
    const installed = await fixture('0.166.0');
    const recordPath = await admitByRecord(installed, '0.166.0');
    const good = await fs.readFile(recordPath, 'utf8');

    await fs.chmod(recordPath, 0o644);
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'CATALOG_INVALID', /readable or writable by other users/);
    await fs.chmod(recordPath, 0o600);

    await fs.link(recordPath, path.join(installed.recordRoot, 'second-link.json'));
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'CATALOG_INVALID', /more than one hard link/);
    await fs.rm(path.join(installed.recordRoot, 'second-link.json'));

    await fs.rename(recordPath, path.join(installed.recordRoot, 'elsewhere.json'));
    await fs.symlink('elsewhere.json', recordPath);
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'CATALOG_INVALID', /not a regular file/);
    await fs.rm(recordPath);

    for (const [mutate, reason] of [
      [(value: any) => { value.source.provenance = 'unavailable'; }, /codex publishes provenance/],
      [(value: any) => { value.source.tarball = 'https://registry.example.invalid/codex-0.166.0.tgz'; }, /official npm registry tarball/],
      [(value: any) => { value.packageRoot = '/tmp/other'; }, /package root does not match/],
    ] as Array<[(value: any) => void, RegExp]>) {
      const value = JSON.parse(good);
      mutate(value);
      await fs.writeFile(recordPath, JSON.stringify(value), { mode: 0o600 });
      await fs.chmod(recordPath, 0o600);
      await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'CATALOG_INVALID', reason);
    }
    await fs.writeFile(recordPath, '{not json', { mode: 0o600 });
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'CATALOG_INVALID', /not valid JSON/);

    await fs.chmod(installed.recordRoot, 0o777);
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'CATALOG_INVALID',
      /admission record is unsafe: its directory .* is not a safe root-owned path/);
    await fs.chmod(installed.recordRoot, 0o700);
  });

  test('never widens the catalog: listed versions are judged by the catalog even when a record exists', async () => {
    const statusOnly = await fixture('0.166.0', {
      '0.166.0': { admission: 'status-only', statusReason: 'Run Host Tools Maintenance.', rootIntegrity: 'x', rootSha256: 'x', platforms: {} },
    });
    await admitByRecord(statusOnly, '0.166.0');
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(statusOnly.context), 'STATUS_ONLY_VERSION');

    const drifted = await fixture('0.166.0');
    const facts = await treeFacts(drifted.context, '0.166.0');
    const catalogged = await fixture('0.166.0', {
      '0.166.0': {
        admission: 'full',
        rootIntegrity: 'x',
        rootSha256: 'x',
        platforms: { 'linux-x64-gnu': { ...facts, treeSha256: '0'.repeat(64), sources: [] } },
      },
    });
    await admitByRecord(catalogged, '0.166.0', facts);
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(catalogged.context), 'DRIFT_DETECTED',
      /files differ from the release the Portal lists for this version\. Run Re-check for it in Maintenance/);
  });

  test('a migrated catalog record keeps a version admitted once the catalog stops listing it', async () => {
    const installed = await fixture('0.166.0');
    const facts = await treeFacts(installed.context, '0.166.0');
    const record = parseNativeHostCliAdmissionRecord({
      schema: 'bridgesllm.tools.admission.v1',
      toolId: 'codex',
      packageName: '@openai/codex',
      version: '0.166.0',
      platform: 'linux-x64-gnu',
      packageRoot: installed.packageRoot,
      ...facts,
      source: {
        kind: 'catalog-v1',
        tarball: officialNpmTarballUrl('@openai/codex', '0.166.0'),
        integrity: `sha512-${createHash('sha512').update('codex-0.166.0').digest('base64')}`,
        catalogSchema: 'bridgesllm.native-host-cli-admission-catalog.v1',
      },
      admittedAt: '2026-10-30T22:00:00.000Z',
      admittedBy: 'catalog-v1-migration',
    }, { toolId: 'codex', packageName: '@openai/codex', packageRoot: installed.packageRoot, platform: 'linux-x64-gnu' });
    await writeRecordFixture(record, installed.recordRoot);
    await expect(__nativeHostCliAdmissionTest.attestWithContext(installed.context))
      .resolves.toMatchObject({ version: '0.166.0', admittedBy: 'admission-record' });
    await fs.appendFile(path.join(installed.packageRoot, 'bin/codex.js'), '// patched\n');
    await expectCode(__nativeHostCliAdmissionTest.attestWithContext(installed.context), 'DRIFT_DETECTED');
  });
});
