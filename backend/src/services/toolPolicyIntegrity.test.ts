import fs from 'fs';
import os from 'os';
import path from 'path';
import { policyMachine, qualifiedOnThisMachine } from './toolPolicyIntegrity';
import { buildToolsStatus, readToolsSnapshot, type ToolPolicy, type ToolsPaths, type ToolsSnapshot } from './toolsStatus';

const POLICY_PATH = path.resolve(__dirname, '../../../installer/tools/tool-policy.v2.json');
const SRI = `sha512-${'B'.repeat(86)}==`;
const SHA256 = `sha256:${'a'.repeat(64)}`;
const SHA512 = `sha512:${'b'.repeat(128)}`;
const TREE = `sha256-tree:${'c'.repeat(64)}`;

function tool(kind: string, integrity: unknown, status = 'qualified') {
  return { source: { kind }, newestProven: { version: '1.2.3', status, integrity, qualifiedAt: '2026-11-02T10:00:00Z' } };
}

function shippedPolicy(): ToolPolicy {
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
}

/** The shipped policy with every recommended version back to proposed, as installer/tools/tests/tool_policy_fixture.py
 *  makes it: whichever entries the shipped file has qualified, the tests below start from none. */
function unqualifiedPolicy(): ToolPolicy {
  const value = shippedPolicy();
  for (const entry of value.tools) Object.assign(entry.newestProven as any, { status: 'proposed', integrity: null, qualifiedAt: null });
  return value;
}

afterEach(() => jest.restoreAllMocks());

describe('newestProven.integrity on this machine', () => {
  test('the machine comes from os.arch()', () => {
    expect(policyMachine('x64')).toBe('x86_64');
    expect(policyMachine('arm64')).toBe('aarch64');
    for (const arch of ['ia32', 'arm', 'ppc64', 's390x', 'riscv64', '']) expect(policyMachine(arch)).toBeNull();
    jest.spyOn(os, 'arch').mockReturnValue('arm64');
    expect(policyMachine()).toBe('aarch64');
  });

  test('string kinds are qualified on every machine when the string has their form', () => {
    for (const [kind, integrity] of [['npm', SRI], ['github-tarball', TREE]]) {
      for (const machine of ['x86_64', 'aarch64', null] as const) {
        expect(qualifiedOnThisMachine(tool(kind, integrity), machine)).toBe(true);
      }
    }
    for (const [kind, integrity] of [['npm', SHA256], ['github-tarball', SHA256], ['github-tarball', { x86_64: TREE }],
      ['npm', { x86_64: SRI }], ['npm', null], ['npm', `${SRI}\n`]] as const) {
      expect(qualifiedOnThisMachine(tool(kind, integrity), 'x86_64')).toBe(false);
    }
  });

  test('object kinds are qualified only on a machine that has an entry', () => {
    // container-image: the per-architecture image digest the Agent Zero helper pins for that machine.
    for (const [kind, digest] of [['github-release', SHA256], ['vendor', SHA256], ['vendor', SHA512],
      ['container-image', SHA256]]) {
      const both = tool(kind, { x86_64: digest, aarch64: digest });
      expect(qualifiedOnThisMachine(both, 'x86_64')).toBe(true);
      expect(qualifiedOnThisMachine(both, 'aarch64')).toBe(true);
      expect(qualifiedOnThisMachine(both, null)).toBe(false);
      const armOnly = tool(kind, { aarch64: digest });
      expect(qualifiedOnThisMachine(armOnly, 'aarch64')).toBe(true);
      expect(qualifiedOnThisMachine(armOnly, 'x86_64')).toBe(false);
    }
    // Values toolctl refuses are never proven.
    for (const integrity of [SHA256, {}, { arm64: SHA256, x86_64: SHA256 }, { x86_64: SRI }, { x86_64: null }, [SHA256]]) {
      expect(qualifiedOnThisMachine(tool('github-release', integrity), 'x86_64')).toBe(false);
    }
    expect(qualifiedOnThisMachine(tool('github-release', { x86_64: SHA512 }), 'x86_64')).toBe(false);
    // A single image string (one architecture or the multi-arch index) is not the contract form.
    for (const integrity of [SHA256, SRI, { x86_64: SHA512 }, {}]) {
      expect(qualifiedOnThisMachine(tool('container-image', integrity), 'x86_64')).toBe(false);
    }
  });

  test('a proposed version or an unknown kind is never proven', () => {
    expect(qualifiedOnThisMachine(tool('npm', SRI, 'proposed'), 'x86_64')).toBe(false);
    expect(qualifiedOnThisMachine(tool('github-release', { x86_64: SHA256 }, 'proposed'), 'x86_64')).toBe(false);
    expect(qualifiedOnThisMachine(tool('ftp', SHA256), 'x86_64')).toBe(false);
    for (const entry of unqualifiedPolicy().tools) expect(qualifiedOnThisMachine(entry, 'x86_64')).toBe(false);
    // The status alone decides: a shipped entry marked proposed is not proven even with its integrity kept.
    for (const entry of shippedPolicy().tools) {
      expect(qualifiedOnThisMachine({ ...entry, newestProven: { ...entry.newestProven, status: 'proposed' } }, 'x86_64')).toBe(false);
    }
  });

  test('the tools status calls a version proven only on a machine it was qualified for', () => {
    const policy = shippedPolicy();
    const opencode = policy.tools.find((entry) => entry.id === 'opencode')!;
    opencode.newestProven = { ...opencode.newestProven, status: 'qualified', integrity: { aarch64: SHA256 }, qualifiedAt: '2026-11-02T10:00:00Z' };
    const snapshot = {
      generatedAtMs: Date.parse('2026-10-30T12:00:00Z'), policy, policySha256: 'a'.repeat(64), policyError: null,
      legacyOpen: [], runs: [], lockOwner: null, history: [],
      installed: { opencode: { version: '1.19.4', admittedAt: null, admission: 'none', source: 'package-json' } },
      runner: { installed: true, reason: null }, bootId: 'boot-1',
    } as unknown as ToolsSnapshot;
    const item = (arch: string) => {
      jest.spyOn(os, 'arch').mockReturnValue(arch as NodeJS.Architecture);
      return buildToolsStatus(snapshot).tools.find((entry) => entry.id === 'opencode')!;
    };
    const onX64 = item('x64');
    expect(onX64.recommended).toEqual({ version: '1.19.5', proven: false });
    expect(onX64.statusReason).toContain('(not yet qualified)');
    const onArm = item('arm64');
    expect(onArm.recommended).toEqual({ version: '1.19.5', proven: true });
    expect(onArm.statusReason).not.toContain('not yet qualified');
  });

  test('an update record for the recommended version is a "proven" admission only on a qualified machine', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-integrity-'));
    try {
      const policy = shippedPolicy();
      const opencode = policy.tools.find((entry) => entry.id === 'opencode')!;
      opencode.newestProven = { ...opencode.newestProven, status: 'qualified', integrity: { aarch64: SHA256 }, qualifiedAt: '2026-11-02T10:00:00Z' };
      const runtimes = path.join(root, 'usr/local/lib/bridgesllm-runtimes');
      const bin = path.join(root, 'usr/local/bin');
      const paths: ToolsPaths = {
        stateRoot: path.join(root, 'var/lib/bridgesllm/tools'), installerStateRoot: path.join(root, 'var/lib/bridgesllm-installer'),
        gatewayFenceMarker: path.join(root, 'var/lib/bridgesllm/fence'), gatewayFencePermit: path.join(root, 'run/permit'),
        openclawStateDir: path.join(root, 'root/.openclaw'), policyPath: path.join(root, 'policy.json'),
        npmGlobalRoot: path.join(root, 'usr/lib/node_modules'), toolctlPath: path.join(root, 'toolctl.py'),
        toolsUnitPaths: [path.join(root, 'bridgesllm-tools@.service')], harnessRuntimeRoot: runtimes, harnessBinDir: bin,
      };
      fs.writeFileSync(paths.policyPath, JSON.stringify(policy));
      fs.mkdirSync(path.join(runtimes, 'opencode', '1.19.5'), { recursive: true });
      fs.writeFileSync(path.join(runtimes, 'opencode', '1.19.5', 'opencode'), '#!/bin/sh\n');
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(path.join(runtimes, 'opencode', '1.19.5', 'opencode'), path.join(bin, 'opencode'));
      fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
      fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'opencode.json'), JSON.stringify({
        schema: 'bridgesllm.tools.harness-admission.v1', version: '1.19.5', admittedAt: '2026-11-02T11:00:00.000Z',
        admittedBy: 'run:0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01',
      }));
      const admission = (arch: string) => {
        jest.spyOn(os, 'arch').mockReturnValue(arch as NodeJS.Architecture);
        return readToolsSnapshot(paths, Date.parse('2026-11-02T12:00:00Z')).installed.opencode?.admission;
      };
      expect(admission('x64')).toBe('verified');
      expect(admission('arm64')).toBe('proven');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
