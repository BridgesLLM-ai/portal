import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  NATIVE_HOST_CLI_RECORD_POLICY,
  nativeHostCliAdmissionRecordsEnabled,
  nativeHostCliRecordVersionRefusal,
  officialNpmTarballUrl,
  parseNativeHostCliAdmissionRecord,
} from './nativeHostCliAdmissionRecord';
import { nativeHostCliCatalogFacts } from './nativeHostCliAdmission';
import {
  buildNativeHostCliAdmissionRecord,
  type InstalledNativeHostCliTree,
  type VerifiedNpmRelease,
} from './nativeHostCliAdmissionRecordStore';

const ROOT = '/usr/lib/node_modules/@openai/codex';
const INTEGRITY = `sha512-${createHash('sha512').update('codex-0.166.0.tgz').digest('base64')}`;
const TREE = {
  treeSha256: 'b'.repeat(64),
  criticalFiles: { 'package.json': 'c'.repeat(64) },
  hardlinkGroups: [] as string[][],
  platformPackageRelative: 'node_modules/@openai/codex-linux-x64',
  platformPackageName: '@openai/codex',
  platformPackageVersion: '0.166.0-linux-x64',
  platformBinRelative: 'vendor/bin/codex',
};
const EXPECTED = { toolId: 'codex' as const, packageName: '@openai/codex', packageRoot: ROOT, platform: 'linux-x64-gnu' };

function installed(version = '0.166.0', tree = TREE): InstalledNativeHostCliTree {
  return { packageName: '@openai/codex', packageRoot: ROOT, version, platform: 'linux-x64-gnu', tree };
}

function release(overrides: Partial<VerifiedNpmRelease> = {}): VerifiedNpmRelease {
  return {
    packageName: '@openai/codex',
    version: '0.166.0',
    tarball: officialNpmTarballUrl('@openai/codex', '0.166.0'),
    integrity: INTEGRITY,
    signatures: 'verified',
    provenance: 'verified',
    stagedTree: TREE,
    ...overrides,
  };
}

function validRecord(): Record<string, any> {
  return JSON.parse(JSON.stringify(buildNativeHostCliAdmissionRecord('codex', release(), installed(), {
    admittedBy: 'run:20261030-1',
    now: new Date('2026-10-30T22:00:00.000Z'),
  })));
}

describe('native host CLI admission records', () => {
  test('npm tarball URLs are the registry\'s own, scoped and unscoped', () => {
    expect(officialNpmTarballUrl('@anthropic-ai/claude-code', '2.1.314'))
      .toBe('https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.314.tgz');
    expect(officialNpmTarballUrl('clawhub', '0.24.1')).toBe('https://registry.npmjs.org/clawhub/-/clawhub-0.24.1.tgz');
  });

  test('a record admits only plain releases at or above the floor and not deny-listed', () => {
    expect(NATIVE_HOST_CLI_RECORD_POLICY.codex.floor).toBe('0.163.0');
    expect(NATIVE_HOST_CLI_RECORD_POLICY['claude-code'].floor).toBe('2.1.309');
    expect(NATIVE_HOST_CLI_RECORD_POLICY.clawhub.floor).toBe('0.23.3');
    expect(nativeHostCliRecordVersionRefusal('codex', '0.166.0')).toBeNull();
    expect(nativeHostCliRecordVersionRefusal('claude-code', '2.1.314')).toBeNull();
    expect(nativeHostCliRecordVersionRefusal('claude-code', '2.1.308'))
      .toBe('claude-code 2.1.308 is older than the admission-record floor 2.1.309');
    expect(nativeHostCliRecordVersionRefusal('codex', '0.167.0-alpha.1')).toMatch(/not a plain release version/);
    const policy = {
      ...NATIVE_HOST_CLI_RECORD_POLICY,
      clawhub: { ...NATIVE_HOST_CLI_RECORD_POLICY.clawhub, denylist: [{ version: '0.24.1', reason: 'its inspect output changed shape' }] },
    };
    expect(nativeHostCliRecordVersionRefusal('clawhub', '0.24.1', policy))
      .toBe('clawhub 0.24.1 is refused by the Portal: its inspect output changed shape');
  });

  test('parses a built record and freezes it', () => {
    const record = parseNativeHostCliAdmissionRecord(validRecord(), EXPECTED);
    expect(record).toMatchObject({ toolId: 'codex', version: '0.166.0', source: { provenance: 'verified' } });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.source)).toBe(true);
  });

  test('refuses every field it cannot vouch for', () => {
    const cases: Array<[string, (value: any) => void, RegExp]> = [
      ['extra field', (value) => { value.trusted = true; }, /unexpected or missing fields/],
      ['schema', (value) => { value.schema = 'bridgesllm.tools.admission.v0'; }, /schema is not supported/],
      ['tool', (value) => { value.toolId = 'clawhub'; }, /is for clawhub, not codex/],
      ['package name', (value) => { value.packageName = '@evil/codex'; }, /package name does not match/],
      ['package root', (value) => { value.packageRoot = '/tmp/codex'; }, /package root does not match/],
      ['platform', (value) => { value.platform = 'linux-arm64-gnu'; }, /is for linux-arm64-gnu, not linux-x64-gnu/],
      ['below floor', (value) => { value.version = '0.150.0'; }, /older than the admission-record floor/],
      ['prerelease', (value) => { value.version = '0.167.0-alpha.1'; }, /not a plain release version/],
      ['tree digest', (value) => { value.treeSha256 = 'B'.repeat(64); }, /tree digest is invalid/],
      ['critical path', (value) => { value.criticalFiles['../package.json'] = 'c'.repeat(64); }, /critical file entry is invalid/],
      ['hard-link path', (value) => { value.hardlinkGroups = [['bin/a', '/etc/passwd']]; }, /hard-link group is invalid/],
      ['partial platform', (value) => { value.platformBinRelative = null; }, /platform package authority is incomplete/],
      ['other registry', (value) => { value.source.tarball = 'https://registry.example.invalid/@openai/codex/-/codex-0.166.0.tgz'; }, /not the official npm registry tarball/],
      ['other version tarball', (value) => { value.source.tarball = officialNpmTarballUrl('@openai/codex', '0.165.0'); }, /not the official npm registry tarball/],
      ['integrity', (value) => { value.source.integrity = 'sha1-abc'; }, /not a sha512 digest/],
      ['signatures', (value) => { value.source.signatures = 'skipped'; }, /does not prove verified registry signatures/],
      ['verifier', (value) => { value.source.verifier = 'hand-rolled'; }, /verifier is not supported/],
      ['provenance required', (value) => { value.source.provenance = 'unavailable'; }, /codex publishes provenance/],
      ['source kind', (value) => { value.source.kind = 'github-release'; }, /must be the npm registry/],
      ['time', (value) => { value.admittedAt = 'yesterday'; }, /time is invalid/],
      ['author', (value) => { value.admittedBy = 'someone --flag'; }, /author is invalid/],
    ];
    for (const [label, mutate, reason] of cases) {
      const candidate = validRecord();
      mutate(candidate);
      expect(() => parseNativeHostCliAdmissionRecord(candidate, EXPECTED)).toThrow(reason);
      void label;
    }
    expect(() => parseNativeHostCliAdmissionRecord([], EXPECTED)).toThrow(/not a JSON object/);
  });

  test('Claude Code records may say provenance is unavailable; Codex and ClawHub records may not', () => {
    const claudeRoot = '/usr/lib/node_modules/@anthropic-ai/claude-code';
    const claudeTree = { ...TREE, platformPackageRelative: null, platformPackageName: null, platformPackageVersion: null, platformBinRelative: null };
    const record = buildNativeHostCliAdmissionRecord('claude-code', {
      ...release({
        packageName: '@anthropic-ai/claude-code',
        version: '2.1.314',
        tarball: officialNpmTarballUrl('@anthropic-ai/claude-code', '2.1.314'),
        provenance: 'unavailable',
        stagedTree: claudeTree,
      }),
    }, {
      packageName: '@anthropic-ai/claude-code', packageRoot: claudeRoot, version: '2.1.314', platform: 'linux-x64-gnu', tree: claudeTree,
    }, { admittedBy: 'requalify:p4-b324', now: new Date('2026-10-30T22:00:00.000Z') });
    expect(record.source).toMatchObject({ kind: 'npm-registry', provenance: 'unavailable' });
    expect(() => buildNativeHostCliAdmissionRecord('codex', release({ provenance: 'unavailable' }), installed(), {
      admittedBy: 'run:1', now: new Date(),
    })).toThrow(/codex publishes provenance/);
  });

  test('a record is built only when the installed tree is the staged official tree', () => {
    const now = new Date('2026-10-30T22:00:00.000Z');
    expect(() => buildNativeHostCliAdmissionRecord('codex', release(), installed('0.166.0', { ...TREE, treeSha256: 'd'.repeat(64) }), { admittedBy: 'run:1', now }))
      .toThrow(/files differ from the official release; it is not admitted/);
    expect(() => buildNativeHostCliAdmissionRecord('codex', release(), installed('0.167.0'), { admittedBy: 'run:1', now }))
      .toThrow(/is not the installed @openai\/codex@0\.167\.0/);
    expect(() => buildNativeHostCliAdmissionRecord('codex', release({ tarball: 'https://mirror.invalid/codex-0.166.0.tgz' }), installed(), { admittedBy: 'run:1', now }))
      .toThrow(/official npm registry tarball/);
  });

  test('records are a second accept path with an explicit off switch', () => {
    expect(nativeHostCliAdmissionRecordsEnabled({})).toBe(true);
    expect(nativeHostCliAdmissionRecordsEnabled({ PORTAL_NATIVE_CLI_ADMISSION_RECORDS: '0' })).toBe(false);
  });

  test('the backend has no record writer: toolctl is the only writer', async () => {
    const source = await fs.readFile(path.join(__dirname, 'nativeHostCliAdmissionRecordStore.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]fs|from ['"]fs\/promises|child_process|writeFile|rename|mkdir|\bopen\(/);
    const store = await import('./nativeHostCliAdmissionRecordStore');
    expect(Object.keys(store).sort()).toEqual(['buildNativeHostCliAdmissionRecord']);
  });

  describe('catalog -> record migration (h.3)', () => {
    test('a catalog-sourced record exists only as the migration\'s own output', () => {
      const migrated = validRecord();
      migrated.admittedBy = 'catalog-v1-migration';
      migrated.source = { kind: 'catalog-v1', tarball: migrated.source.tarball, integrity: INTEGRITY, catalogSchema: 'bridgesllm.native-host-cli-admission-catalog.v1' };
      expect(parseNativeHostCliAdmissionRecord(migrated, EXPECTED).source).toEqual(migrated.source);
      for (const [mutate, reason] of [
        [(value: any) => { value.admittedBy = 'run:1'; }, /only the catalog migration may write a catalog-sourced record/],
        [(value: any) => { value.source.catalogSchema = 'v2'; }, /catalog schema is not supported/],
        [(value: any) => { value.source.signatures = 'verified'; }, /unexpected or missing fields/],
      ] as Array<[(value: any) => void, RegExp]>) {
        const candidate = JSON.parse(JSON.stringify(migrated));
        mutate(candidate);
        expect(() => parseNativeHostCliAdmissionRecord(candidate, EXPECTED)).toThrow(reason);
      }
      const forged = validRecord();
      forged.admittedBy = 'catalog-v1-migration';
      expect(() => parseNativeHostCliAdmissionRecord(forged, EXPECTED)).toThrow(/may only write catalog-sourced records/);
    });

    test('reads the shipped catalog read-only and only for fully admitted versions', () => {
      const shipped = nativeHostCliCatalogFacts('codex', '0.163.0', 'linux-x64-gnu');
      expect(shipped).toMatchObject({
        packageName: '@openai/codex',
        rootTarball: officialNpmTarballUrl('@openai/codex', '0.163.0'),
        platformPackageRelative: 'node_modules/@openai/codex-linux-x64',
      });
      expect(shipped?.rootIntegrity).toMatch(/^sha512-/);
      expect(Object.isFrozen(shipped)).toBe(true);
      expect(nativeHostCliCatalogFacts('clawhub', '0.23.1', 'linux-x64-gnu')).toBeNull();
      expect(nativeHostCliCatalogFacts('codex', '0.166.0', 'linux-x64-gnu')).toBeNull();
      expect(nativeHostCliCatalogFacts('codex', '__proto__', 'linux-x64-gnu')).toBeNull();
      expect(nativeHostCliCatalogFacts('codex', '0.163.0', 'linux-riscv64-gnu')).toBeNull();
    });
  });

  test('the record module has no child-process, network or write API', async () => {
    const source = await fs.readFile(path.join(__dirname, 'nativeHostCliAdmissionRecord.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|execFile|spawn|from ['"]https?['"]|\bfetch\s*\(|writeFile|chmod|chown|unlink|rename|mkdir|from ['"]fs/);
  });
});
