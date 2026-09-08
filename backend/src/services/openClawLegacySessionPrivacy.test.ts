import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OpenClawSetupReadiness } from './openclawSetupReadiness';
import {
  assertLegacyOpenClawSessionPrivacyAbsent,
  captureLegacyOpenClawSessionPrivacyTarget,
  hardDeleteLegacyOpenClawSessionPrivacyArtifacts,
  resolveExactOpenClawRetirementRuntimeFamily,
  type LegacyOpenClawSessionPrivacyOptions,
  type OpenClawRetirementSessionIdentity,
} from './openClawLegacySessionPrivacy';

const SESSION_ID = 'session-privacy-1';
const SESSION_KEY = 'agent:portal:retirement-private';
const ARCHIVE_A = '2026-08-31T12-00-00.000Z';
const ARCHIVE_B = '2026-08-31T12-00-01.000Z';

function readiness(
  family: 'legacy-2026.7.1' | 'current-2026.9.1' | null,
  overrides: Partial<OpenClawSetupReadiness> = {},
): OpenClawSetupReadiness {
  const legacy = family === 'legacy-2026.7.1';
  const version = legacy ? '2026.7.1' : '2026.9.1';
  const core = legacy ? '2026.7.1-2' : '2026.9.1';
  const codex = legacy ? '2026.7.1-1' : '2026.9.1';
  return {
    installed: true,
    version,
    corePackageVersion: core,
    runningVersion: version,
    gatewayRunning: true,
    authenticatedRpc: true,
    gatewayProbeOk: true,
    gatewayProbeError: null,
    gatewayUrl: 'http://127.0.0.1:18789',
    hasToken: true,
    tokenParity: true,
    codexPluginVersion: codex,
    codexPluginInstallSpec: `@openclaw/codex@${codex}`,
    credentialStoreReady: true,
    credentialStoreWritable: true,
    testedCorePackageVersion: '2026.9.1',
    testedRuntimeVersion: '2026.9.1',
    testedCodexPluginVersion: '2026.9.1',
    testedRuntimeFamily: family,
    testedPairReady: family !== null,
    ready: family !== null,
    blockers: [],
    description: 'test',
    ...overrides,
  };
}

describe('retained OpenClaw 2026.7.1 privacy-safe session retirement', () => {
  let sandbox: string;
  let stateRoot: string;
  let sessionsDir: string;
  let legacySessionsDir: string;
  let registryPath: string;
  let identity: OpenClawRetirementSessionIdentity;
  let options: LegacyOpenClawSessionPrivacyOptions;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-oc71-privacy-'));
    stateRoot = path.join(sandbox, 'state');
    sessionsDir = path.join(stateRoot, 'agents', 'portal', 'sessions');
    legacySessionsDir = path.join(stateRoot, 'sessions');
    registryPath = path.join(sessionsDir, 'sessions.json');
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    for (const directory of [stateRoot, path.join(stateRoot, 'agents'), path.join(stateRoot, 'agents', 'portal'), sessionsDir]) {
      fs.chmodSync(directory, 0o700);
    }
    identity = Object.freeze({
      agentId: 'portal',
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
    });
    options = {
      stateRoot,
      expectedUid: process.getuid?.() ?? 0,
      expectedGid: process.getgid?.() ?? 0,
    };
    writeRegistry({
      [SESSION_KEY]: {
        sessionId: SESSION_ID,
        sessionFile: path.join(sessionsDir, `${SESSION_ID}.jsonl`),
        updatedAt: 100,
      },
      'agent:portal:unrelated': {
        sessionId: 'unrelated-session',
        updatedAt: 200,
      },
    });
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const target = path.join(sessionsDir, name);
    fs.writeFileSync(target, content, { mode: 0o600 });
    return target;
  }

  function transcript(name = `${SESSION_ID}.jsonl`): string {
    return writeFile(name, `${JSON.stringify({ type: 'session', version: 3, id: SESSION_ID })}\n${JSON.stringify({ type: 'message', private: true })}\n`);
  }

  function legacyTranscript(name = `${SESSION_ID}.jsonl`): string {
    fs.mkdirSync(legacySessionsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(legacySessionsDir, 0o700);
    const target = path.join(legacySessionsDir, name);
    fs.writeFileSync(
      target,
      `${JSON.stringify({ type: 'session', version: 3, id: SESSION_ID })}\n${JSON.stringify({ type: 'message', private: true })}\n`,
      { mode: 0o600 },
    );
    return target;
  }

  function trajectory(): string {
    return writeFile(
      `${SESSION_ID}.trajectory.jsonl`,
      `${JSON.stringify({
        traceSchema: 'openclaw-trajectory',
        schemaVersion: 1,
        source: 'runtime',
        sessionId: SESSION_ID,
        type: 'session.started',
      })}\n`,
    );
  }

  function pointer(): string {
    return writeFile(
      `${SESSION_ID}.trajectory-path.json`,
      `${JSON.stringify({
        traceSchema: 'openclaw-trajectory-pointer',
        schemaVersion: 1,
        sessionId: SESSION_ID,
        runtimeFile: path.join(sessionsDir, `${SESSION_ID}.trajectory.jsonl`),
      })}\n`,
    );
  }

  function writeRegistry(value: unknown): void {
    fs.writeFileSync(registryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  function deleteRegistryEntry(): void {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    delete registry[SESSION_KEY];
    writeRegistry(registry);
  }

  test('accepts only exact supported runtime tuples', () => {
    expect(resolveExactOpenClawRetirementRuntimeFamily(readiness('legacy-2026.7.1')))
      .toBe('legacy-2026.7.1');
    expect(resolveExactOpenClawRetirementRuntimeFamily(readiness('current-2026.9.1')))
      .toBe('current-2026.9.1');
    expect(() => resolveExactOpenClawRetirementRuntimeFamily(readiness(null)))
      .toThrow(/exact Portal-qualified/i);
    expect(() => resolveExactOpenClawRetirementRuntimeFamily(readiness(
      'legacy-2026.7.1',
      { runningVersion: '2026.9.1' },
    ))).toThrow(/exact Portal-qualified/i);
    expect(() => resolveExactOpenClawRetirementRuntimeFamily(readiness(
      'current-2026.9.1',
      { corePackageVersion: '2026.7.1-2' },
    ))).toThrow(/exact Portal-qualified/i);
  });

  test('admits 9.2 retirement only when the core, gateway, CLI and plugin match', () => {
    const status = readiness('current-2026.9.1', {
      corePackageVersion: '2026.9.2', version: '2026.9.2', runningVersion: '2026.9.2',
      codexPluginVersion: '2026.9.2', codexPluginInstallSpec: '@openclaw/codex@2026.9.2',
    });
    expect(resolveExactOpenClawRetirementRuntimeFamily(status)).toBe('current-2026.9.1');
    for (const override of [
      { runningVersion: '2026.9.1' }, { codexPluginVersion: '2026.9.1' },
      { codexPluginInstallSpec: '@openclaw/codex@latest' },
      { corePackageVersion: '2026.9.3', version: '2026.9.3', runningVersion: '2026.9.3',
        codexPluginVersion: '2026.9.3', codexPluginInstallSpec: '@openclaw/codex@2026.9.3' },
    ]) expect(() => resolveExactOpenClawRetirementRuntimeFamily({ ...status, ...override }))
      .toThrow(/exact Portal-qualified/i);
  });

  test('deletes canonical, returned archive, reset, checkpoint, and trajectory residue while preserving unrelated bytes', async () => {
    const canonical = transcript();
    transcript(`${SESSION_ID}.jsonl.reset.${ARCHIVE_A}`);
    transcript(`${SESSION_ID}.checkpoint.11111111-1111-4111-8111-111111111111.jsonl`);
    trajectory();
    pointer();
    const unrelatedPath = writeFile(
      'unrelated-session.jsonl',
      `${JSON.stringify({ type: 'session', id: 'unrelated-session' })}\nprivate unrelated bytes\n`,
    );
    const unrelatedBefore = fs.readFileSync(unrelatedPath);
    const registryBefore = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

    expect(captureLegacyOpenClawSessionPrivacyTarget(identity, options).sessionFile)
      .toBe(canonical);
    deleteRegistryEntry();
    const archived = `${canonical}.deleted.${ARCHIVE_B}`;
    fs.renameSync(canonical, archived);
    const legacyArchived = `${legacyTranscript()}.deleted.${ARCHIVE_A}`;
    fs.renameSync(path.join(legacySessionsDir, `${SESSION_ID}.jsonl`), legacyArchived);

    await hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [archived, legacyArchived],
      options,
    });
    assertLegacyOpenClawSessionPrivacyAbsent(identity, options);
    expect(fs.readFileSync(unrelatedPath)).toEqual(unrelatedBefore);
    const registryAfter = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(registryAfter['agent:portal:unrelated']).toEqual(
      registryBefore['agent:portal:unrelated'],
    );
    expect(registryAfter[SESSION_KEY]).toBeUndefined();
  });

  test('converges after the RPC archive boundary and a crash between artifact unlinks', async () => {
    const canonical = transcript();
    transcript(`${SESSION_ID}.jsonl.reset.${ARCHIVE_A}`);
    deleteRegistryEntry();
    const archived = `${canonical}.deleted.${ARCHIVE_B}`;
    fs.renameSync(canonical, archived);
    let crashed = false;
    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [archived],
      options: {
        ...options,
        hooks: {
          afterUnlink: () => {
            if (crashed) return;
            crashed = true;
            throw new Error('simulated crash between unlinks');
          },
        },
      },
    })).rejects.toThrow(/simulated crash/i);

    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [],
      options,
    })).resolves.toBeUndefined();
    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [],
      options,
    })).resolves.toBeUndefined();
    assertLegacyOpenClawSessionPrivacyAbsent(identity, options);
  });

  test('converges after a crash at the durable quarantine boundary', async () => {
    transcript();
    captureLegacyOpenClawSessionPrivacyTarget(identity, options);
    deleteRegistryEntry();
    let crashed = false;
    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [],
      options: {
        ...options,
        hooks: {
          afterQuarantine: () => {
            if (crashed) return;
            crashed = true;
            throw new Error('simulated crash after durable quarantine');
          },
        },
      },
    })).rejects.toThrow(/simulated crash after durable quarantine/i);

    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [],
      options,
    })).resolves.toBeUndefined();
    assertLegacyOpenClawSessionPrivacyAbsent(identity, options);
  });

  test('rejects symlink and hardlink artifacts without deleting their targets', () => {
    const outside = path.join(sandbox, 'outside-private');
    fs.writeFileSync(outside, 'outside', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(sessionsDir, `${SESSION_ID}.jsonl`));
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/non-linked regular file/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');

    fs.unlinkSync(path.join(sessionsDir, `${SESSION_ID}.jsonl`));
    const linked = transcript();
    const secondLink = path.join(sandbox, 'second-link');
    fs.linkSync(linked, secondLink);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/non-linked regular file/i);
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.existsSync(secondLink)).toBe(true);
  });

  test('detects a descriptor/path swap before quarantine and preserves the replacement', async () => {
    transcript();
    captureLegacyOpenClawSessionPrivacyTarget(identity, options);
    deleteRegistryEntry();
    let swapped = false;
    const held = path.join(sandbox, 'held-original');
    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [],
      options: {
        ...options,
        hooks: {
          afterOpen: (filePath) => {
            if (swapped) return;
            swapped = true;
            fs.renameSync(filePath, held);
            fs.writeFileSync(filePath, 'unrelated replacement', { mode: 0o600 });
          },
        },
      },
    })).rejects.toThrow(/path changed after descriptor binding/i);
    expect(fs.readFileSync(path.join(sessionsDir, `${SESSION_ID}.jsonl`), 'utf8'))
      .toBe('unrelated replacement');
    expect(fs.existsSync(held)).toBe(true);
  });

  test('detects a quarantine path swap without unlinking the replacement', async () => {
    transcript();
    captureLegacyOpenClawSessionPrivacyTarget(identity, options);
    deleteRegistryEntry();
    let replacementPath = '';
    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [],
      options: {
        ...options,
        hooks: {
          afterQuarantine: (_sourcePath, quarantinePath) => {
            const held = `${quarantinePath}.held`;
            fs.renameSync(quarantinePath, held);
            fs.writeFileSync(quarantinePath, 'unrelated replacement', { mode: 0o600 });
            replacementPath = quarantinePath;
          },
        },
      },
    })).rejects.toThrow(/changed at the quarantine boundary/i);
    expect(fs.readFileSync(replacementPath, 'utf8')).toBe('unrelated replacement');
  });

  test('rejects malformed, duplicate-key, duplicate-authority, and custom-layout registries', () => {
    fs.writeFileSync(registryPath, '{not-json', { mode: 0o600 });
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/JSON/i);

    fs.writeFileSync(
      registryPath,
      `{"${SESSION_KEY}":{"sessionId":"${SESSION_ID}"},"${SESSION_KEY}":{"sessionId":"${SESSION_ID}"}}`,
      { mode: 0o600 },
    );
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/repeats key/i);

    writeRegistry({
      [SESSION_KEY]: { sessionId: SESSION_ID },
      'agent:portal:alias': { sessionId: SESSION_ID },
    });
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/duplicate transcript authority/i);

    writeRegistry({
      [SESSION_KEY]: {
        sessionId: SESSION_ID,
        sessionFile: path.join(sandbox, 'custom.jsonl'),
      },
    });
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/custom or out-of-root/i);
  });

  test('rejects linked registries before reading or mutating artifacts', () => {
    const realRegistry = path.join(sandbox, 'registry-real.json');
    fs.renameSync(registryPath, realRegistry);
    fs.symlinkSync(realRegistry, registryPath);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/non-linked regular file/i);
    fs.unlinkSync(registryPath);
    fs.linkSync(realRegistry, registryPath);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/non-linked regular file/i);
  });

  test('rejects unrecognized residue, header mismatches, and artifact bounds before deletion', async () => {
    transcript(`${SESSION_ID}.jsonl.pre-doctor-private.bak`);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/unrecognized privacy artifact/i);
    fs.unlinkSync(path.join(sessionsDir, `${SESSION_ID}.jsonl.pre-doctor-private.bak`));

    writeFile(`${SESSION_ID}.jsonl`, `${JSON.stringify({ type: 'session', id: 'other-session' })}\n`);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, options))
      .toThrow(/header does not match/i);
    fs.unlinkSync(path.join(sessionsDir, `${SESSION_ID}.jsonl`));

    transcript();
    transcript(`${SESSION_ID}.jsonl.reset.${ARCHIVE_A}`);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, {
      ...options,
      limits: { maxArtifacts: 1 },
    })).toThrow(/count bound exceeded/i);
    expect(() => captureLegacyOpenClawSessionPrivacyTarget(identity, {
      ...options,
      limits: { maxArtifactBytes: 8 },
    })).toThrow(/bounded root-owned/i);

    deleteRegistryEntry();
    await expect(hardDeleteLegacyOpenClawSessionPrivacyArtifacts({
      identity,
      archivedPaths: [path.join(sessionsDir, 'unrelated-session.jsonl')],
      options,
    })).rejects.toThrow(/unbound transcript archive/i);
    expect(fs.existsSync(path.join(sessionsDir, `${SESSION_ID}.jsonl`))).toBe(true);
  });
});
