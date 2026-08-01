import fs from 'fs';
import os from 'os';
import path from 'path';

describe('OpenClaw upgrade-state preparation', () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalStandardStateConfirmed = process.env.PORTAL_OPENCLAW_STANDARD_STATE_CONFIRMED;
  let tempDir: string;
  let homeDir: string;
  let openClawHome: string;

  function loadManager() {
    jest.resetModules();
    return require('../services/openclawConfigManager');
  }

  function currentNpmRecord(pluginId: string, packageName: string, version = '2026.5.5') {
    const installPath = path.join(tempDir, 'packages', pluginId);
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, 'package.json'), JSON.stringify({ name: packageName, version }));
    return {
      source: 'npm',
      spec: `${packageName}@${version}`,
      resolvedName: packageName,
      resolvedVersion: version,
      resolvedSpec: `${packageName}@${version}`,
      installPath,
    };
  }

  function writePluginRegistry(records: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const stateDir = path.join(openClawHome, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const database = new DatabaseSync(path.join(stateDir, 'openclaw.sqlite'));
    database.exec(`
      create table installed_plugin_index (
        index_key text primary key,
        version integer not null,
        host_contract_version text not null,
        compat_registry_version text not null,
        migration_version integer not null,
        policy_hash text not null,
        generated_at_ms integer not null,
        refresh_reason text,
        install_records_json text not null,
        plugins_json text not null,
        diagnostics_json text not null,
        warning text,
        updated_at_ms integer not null
      );
    `);
    database.prepare(
      `insert into installed_plugin_index(
        index_key, version, host_contract_version, compat_registry_version,
        migration_version, policy_hash, generated_at_ms, refresh_reason,
        install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'installed-plugin-index', 1, '2026.7.1', 'compat-hash', 1, 'policy-hash', Date.now(), 'startup',
      JSON.stringify(records), '[]', '[]', null, Date.now(),
    );
    database.close();
  }

  function writeLegacyPluginIndex(value: unknown): string {
    const target = path.join(openClawHome, 'plugins', 'installs.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value, null, 2));
    fs.chmodSync(target, 0o600);
    return target;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-upgrade-'));
    homeDir = path.join(tempDir, 'home');
    openClawHome = path.join(homeDir, '.openclaw');
    process.env.HOME = homeDir;
    process.env.OPENCLAW_HOME = openClawHome;
    process.env.PORTAL_OPENCLAW_STANDARD_STATE_CONFIRMED = '1';
    delete process.env.OPENCLAW_STATE_DIR;
    fs.mkdirSync(openClawHome, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
    if (originalOpenClawStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    if (originalStandardStateConfirmed === undefined) delete process.env.PORTAL_OPENCLAW_STANDARD_STATE_CONFIRMED;
    else process.env.PORTAL_OPENCLAW_STANDARD_STATE_CONFIRMED = originalStandardStateConfirmed;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('moves a superseded clawdbot tree without deleting or changing its contents', () => {
    const legacyHome = path.join(homeDir, '.clawdbot');
    const sentinel = path.join(legacyHome, 'secrets', 'legacy.json');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'preserve-me');
    fs.chmodSync(sentinel, 0o600);

    const manager = loadManager();
    const result = manager.prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(true);
    expect(result.legacyStateAction).toBe('quarantined');
    expect(fs.existsSync(legacyHome)).toBe(false);
    expect(fs.readFileSync(path.join(result.legacyStateBackupPath, 'secrets', 'legacy.json'), 'utf8')).toBe('preserve-me');
    expect(fs.statSync(path.join(result.legacyStateBackupPath, 'secrets', 'legacy.json')).mode & 0o777).toBe(0o600);

    expect(manager.prepareOpenClawUpgradeState().legacyStateAction).toBe('absent');
  });

  test('leaves a clawdbot symlink or explicit custom state directory alone', () => {
    const legacyHome = path.join(homeDir, '.clawdbot');
    fs.symlinkSync(openClawHome, legacyHome, 'dir');
    expect(loadManager().prepareOpenClawUpgradeState().legacyStateAction).toBe('already-linked');
    expect(fs.lstatSync(legacyHome).isSymbolicLink()).toBe(true);

    fs.unlinkSync(legacyHome);
    fs.mkdirSync(legacyHome);
    process.env.OPENCLAW_STATE_DIR = path.join(homeDir, 'custom-state');
    delete process.env.PORTAL_OPENCLAW_STANDARD_STATE_CONFIRMED;
    const customResult = loadManager().prepareOpenClawUpgradeState();
    expect(customResult.readyForGatewayStart).toBe(false);
    expect(customResult.legacyStateAction).toBe('failed');
    expect(fs.existsSync(legacyHome)).toBe(true);
  });

  test('refuses to move a clawdbot symlink that targets a different tree', () => {
    const legacyHome = path.join(homeDir, '.clawdbot');
    const otherState = path.join(homeDir, 'other-state');
    fs.mkdirSync(otherState);
    fs.symlinkSync(otherState, legacyHome, 'dir');

    const result = loadManager().prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(false);
    expect(result.legacyStateAction).toBe('failed');
    expect(fs.lstatSync(legacyHome).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyHome)).toBe(fs.realpathSync(otherState));
  });

  test('refuses to rewrite a symlinked legacy plugin index', () => {
    writePluginRegistry({ discord: currentNpmRecord('discord', '@openclaw/discord') });
    const externalIndex = path.join(tempDir, 'external-installs.json');
    const externalContents = JSON.stringify({
      installRecords: {
        discord: { source: 'npm', resolvedName: '@openclaw/discord', resolvedVersion: '2026.5.5' },
      },
    });
    fs.writeFileSync(externalIndex, externalContents);
    const legacyPath = path.join(openClawHome, 'plugins', 'installs.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.symlinkSync(externalIndex, legacyPath);

    const result = loadManager().prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(false);
    expect(result.legacyPluginIndexAction).toBe('failed');
    expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(externalIndex, 'utf8')).toBe(externalContents);
  });

  test('quarantines a synthetic four-plugin conflict while preserving unrelated config and auth', () => {
    const pluginIds = ['alpha', 'bravo', 'charlie', 'delta'];
    const currentRecords = Object.fromEntries(pluginIds.map((pluginId) => [
      pluginId,
      currentNpmRecord(pluginId, `@example/${pluginId}`),
    ]));
    writePluginRegistry(currentRecords);
    const legacyRecords = Object.fromEntries(pluginIds.map((pluginId, index) => {
      const packageName = `@example/${pluginId}`;
      return [pluginId, {
        source: 'npm',
        spec: packageName,
        resolvedName: packageName,
        resolvedVersion: '2026.5.5',
        resolvedSpec: `${packageName}@2026.5.5`,
        version: '2026.5.5',
        integrity: 'sha512-old',
        shasum: String.fromCharCode(97 + index).repeat(40),
        resolvedAt: 'old',
        installedAt: 'old',
      }];
    }));
    const pluginDescriptor = (pluginId: string, installRecord: unknown) => ({
      pluginId,
      installRecord,
      manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
      manifestHash: `manifest-${pluginId}`,
      rootDir: `/plugins/${pluginId}`,
      origin: 'installed',
      enabled: true,
      startup: { sidecar: false, memory: false, deferConfiguredChannelFullLoadUntilAfterListen: false, agentHarnesses: [] },
      compat: [],
    });
    const original = {
      version: 1,
      warning: 'legacy generated index',
      hostContractVersion: '2026.5.27',
      compatRegistryVersion: 'legacy-compat',
      migrationVersion: 1,
      policyHash: 'legacy-policy',
      generatedAtMs: 1,
      refreshReason: 'source-changed',
      installRecords: legacyRecords,
      plugins: Object.entries(legacyRecords).map(([pluginId, record]) => pluginDescriptor(pluginId, record)),
      diagnostics: [],
    };
    const legacyPath = writeLegacyPluginIndex(original);
    const openClawConfigPath = path.join(openClawHome, 'openclaw.json');
    const authPath = path.join(openClawHome, 'agents', 'main', 'agent', 'auth-profiles.json');
    const preservedConfig = { plugins: { entries: { unrelated: { enabled: true, config: { mode: 'synthetic' } } } } };
    fs.writeFileSync(openClawConfigPath, JSON.stringify(preservedConfig));
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, '{"version":2,"profiles":{"openai:manual":{"provider":"openai"}}}');
    const configBefore = fs.readFileSync(openClawConfigPath);
    const authBefore = fs.readFileSync(authPath);

    const result = loadManager().prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(true);
    expect(result.legacyPluginIndexAction).toBe('quarantined-redundant');
    expect(result.removedPluginRecordIds).toEqual(pluginIds);
    expect(result.retainedPluginRecordIds).toEqual([]);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(result.legacyPluginIndexBackupPath, 'utf8'))).toEqual(original);
    expect(fs.statSync(result.legacyPluginIndexBackupPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(openClawConfigPath)).toEqual(configBefore);
    expect(fs.readFileSync(authPath)).toEqual(authBefore);

    const restored = loadManager().restoreOpenClawUpgradeState(result);
    expect(restored.restored).toBe(true);
    expect(restored.legacyPluginIndexRestored).toBe(true);
    expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8'))).toEqual(original);
  });

  test('quarantines a fully redundant ledger and is idempotent', () => {
    const current = currentNpmRecord('discord', '@openclaw/discord');
    writePluginRegistry({ discord: current });
    const legacyPath = writeLegacyPluginIndex({
      installRecords: {
        discord: { source: 'npm', spec: '@openclaw/discord', resolvedName: '@openclaw/discord', resolvedVersion: '2026.5.5' },
      },
      plugins: [],
    });

    const manager = loadManager();
    const result = manager.prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(true);
    expect(result.legacyPluginIndexAction).toBe('quarantined-redundant');
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(result.legacyPluginIndexBackupPath)).toBe(true);
    expect(manager.prepareOpenClawUpgradeState().legacyPluginIndexAction).toBe('absent');
  });

  test('retains a unique plugin record for OpenClaw to import while pruning a proven duplicate', () => {
    writePluginRegistry({ discord: currentNpmRecord('discord', '@openclaw/discord') });
    const original = {
      installRecords: {
        discord: { source: 'npm', spec: '@openclaw/discord', resolvedName: '@openclaw/discord', resolvedVersion: '2026.5.5', resolvedSpec: '@openclaw/discord@2026.5.5' },
        unique: { source: 'npm', spec: '@example/unique', resolvedName: '@example/unique', resolvedVersion: '1.0.0' },
      },
      plugins: [],
    };
    const legacyPath = writeLegacyPluginIndex(original);
    const result = loadManager().prepareOpenClawUpgradeState();
    expect(result.readyForGatewayStart).toBe(true);
    expect(result.legacyPluginIndexAction).toBe('pruned');
    expect(result.removedPluginRecordIds).toEqual(['discord']);
    expect(result.retainedPluginRecordIds).toEqual(['unique']);
    expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).installRecords).toEqual({
      unique: { source: 'npm', spec: '@example/unique', resolvedName: '@example/unique', resolvedVersion: '1.0.0' },
    });
    expect(loadManager().restoreOpenClawUpgradeState(result).restored).toBe(true);
    expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8'))).toEqual(original);
  });

  test('refuses to discard a same-id record whose resolved package identity is not proven', () => {
    writePluginRegistry({ discord: currentNpmRecord('discord', '@openclaw/discord', '2026.5.5') });
    const original = {
      installRecords: {
        discord: { source: 'npm', resolvedName: '@openclaw/discord', resolvedVersion: '2026.4.9' },
      },
      plugins: [],
    };
    const legacyPath = writeLegacyPluginIndex(original);

    const result = loadManager().prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(false);
    expect(result.legacyPluginIndexAction).toBe('failed');
    expect(result.warnings.join(' ')).toContain('discord');
    expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8'))).toEqual(original);
  });

  test('leaves unique records intact when there is no authoritative SQLite registry yet', () => {
    const original = { installRecords: { unique: { source: 'npm', spec: '@example/unique' } }, plugins: [] };
    const legacyPath = writeLegacyPluginIndex(original);

    const result = loadManager().prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(true);
    expect(result.legacyPluginIndexAction).toBe('not-needed');
    expect(result.retainedPluginRecordIds).toEqual(['unique']);
    expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8'))).toEqual(original);
  });

  test('does not trust a structurally invalid SQLite plugin registry row', () => {
    writePluginRegistry({ discord: currentNpmRecord('discord', '@openclaw/discord') });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(path.join(openClawHome, 'state', 'openclaw.sqlite'));
    database.prepare("update installed_plugin_index set plugins_json='{}'").run();
    database.close();
    const original = {
      installRecords: {
        discord: { source: 'npm', spec: '@openclaw/discord', resolvedName: '@openclaw/discord', resolvedVersion: '2026.5.5' },
      },
      plugins: [],
    };
    const legacyPath = writeLegacyPluginIndex(original);
    const result = loadManager().prepareOpenClawUpgradeState();
    expect(result.readyForGatewayStart).toBe(false);
    expect(result.warnings.join(' ')).toContain('structural validation');
    expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8'))).toEqual(original);
  });

  test('refuses an invalid retired plugin index without moving or rewriting it', () => {
    const legacyPath = path.join(openClawHome, 'plugins', 'installs.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{not-json');

    const result = loadManager().prepareOpenClawUpgradeState();

    expect(result.readyForGatewayStart).toBe(false);
    expect(result.legacyPluginIndexAction).toBe('failed');
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{not-json');
  });

  test.each([{}, { plugins: [] }])('refuses structurally invalid plugin metadata %#', (invalid) => {
    const legacyPath = writeLegacyPluginIndex(invalid);
    const result = loadManager().prepareOpenClawUpgradeState();
    expect(result.readyForGatewayStart).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  test('restores clawdbot when a later plugin validation failure aborts preparation', () => {
    const legacyHome = path.join(homeDir, '.clawdbot');
    fs.mkdirSync(legacyHome);
    fs.writeFileSync(path.join(legacyHome, 'sentinel'), 'legacy');
    writeLegacyPluginIndex({});

    const manager = loadManager();
    const prepared = manager.prepareOpenClawUpgradeState();
    expect(prepared.readyForGatewayStart).toBe(false);
    expect(prepared.legacyStateAction).toBe('quarantined');
    expect(fs.existsSync(legacyHome)).toBe(false);

    const restored = manager.restoreOpenClawUpgradeState(prepared);
    expect(restored.restored).toBe(true);
    expect(fs.readFileSync(path.join(legacyHome, 'sentinel'), 'utf8')).toBe('legacy');
  });
});
