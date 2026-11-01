import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  hermesBridgeFeatureGap,
  hermesRuntimeAttestationPath,
  parseHermesRuntimeAttestation,
  readHermesRuntimeAttestation,
} from './hermesRuntimeAttestation';

function attestation(extras: string, version = '0.22.2'): string {
  return [
    'schema=bridgesllm-hermes-runtime-v1',
    `product_version=${version}`,
    'upstream_tag=v2026.10.1',
    'install_stamp_update_mechanism=external',
    `extras=${extras}`,
    '',
  ].join('\n');
}

describe('Hermes runtime attestation (MCP extra)', () => {
  it('admits bridge features only when the pinned runtime carries the mcp extra', () => {
    expect(parseHermesRuntimeAttestation(attestation('acp,mcp'), '0.22.2')).toBe('bridge-ready');
    expect(parseHermesRuntimeAttestation(attestation('acp'), '0.22.2')).toBe('mcp-extra-missing');
    expect(parseHermesRuntimeAttestation(attestation('acp,mcp', '0.21.1'), '0.22.2')).toBe('version-mismatch');
    expect(parseHermesRuntimeAttestation('extras=acp,mcp\n', '0.22.2')).toBe('unreadable');
  });

  it('reads the helper-written file and fails closed on a missing or oversized file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-hermes-attestation-'));
    try {
      const attestationPath = hermesRuntimeAttestationPath(root, '0.22.2');
      expect(attestationPath).toBe(path.join(root, '0.22.2', '.portal-runtime-attestation-v1'));
      expect(readHermesRuntimeAttestation({ attestationPath })).toBe('unreadable');
      fs.mkdirSync(path.dirname(attestationPath), { recursive: true });
      fs.writeFileSync(attestationPath, attestation('acp'));
      expect(readHermesRuntimeAttestation({ attestationPath })).toBe('mcp-extra-missing');
      fs.writeFileSync(attestationPath, attestation('acp,mcp'));
      expect(readHermesRuntimeAttestation({ attestationPath })).toBe('bridge-ready');
      fs.writeFileSync(attestationPath, `${attestation('acp,mcp')}${'#'.repeat(5000)}`);
      expect(readHermesRuntimeAttestation({ attestationPath })).toBe('unreadable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('describes a reduced feature set, not an unusable harness', () => {
    expect(hermesBridgeFeatureGap('bridge-ready')).toBeNull();
    expect(hermesBridgeFeatureGap('mcp-extra-missing')).toBe(
      'The installed Hermes runtime was built without its MCP extra, so interactive questions, widgets and goals are off for Hermes. Run Update Compatible AI Tools to enable them.',
    );
    expect(hermesBridgeFeatureGap('unreadable')).toMatch(/could not read the Hermes runtime attestation/);
  });
  it('stays in step with the installer helper that writes the attestation', () => {
    const helper = fs.readFileSync(path.resolve(__dirname, '../../../installer/hermes-runtime.sh'), 'utf8');
    expect(helper).toContain('readonly HERMES_ATTESTATION_NAME=".portal-runtime-attestation-v1"');
    expect(helper).toContain('${HERMES_RUNTIME_ROOT:-/usr/local/lib/bridgesllm-runtimes/hermes}');
    expect(helper).toMatch(/^schema=bridgesllm-hermes-runtime-v1$/m);
    expect(helper).toMatch(/^product_version=\$\{HERMES_TESTED_VERSION\}$/m);
    expect(helper).toMatch(/^extras=acp,mcp$/m);
    const pinned = helper.match(/^readonly HERMES_TESTED_VERSION="([^"]+)"$/m)?.[1];
    expect(hermesRuntimeAttestationPath('/r', pinned)).toBe(hermesRuntimeAttestationPath('/r'));
  });

  test('reads the attestation of the installed floor-pinned version and refuses a version that cannot name a directory', () => {
    const reads: string[] = [];
    const content = 'schema=bridgesllm-hermes-runtime-v1\nproduct_version=0.22.5\nextras=acp,mcp\n';
    expect(readHermesRuntimeAttestation({
      version: '0.22.5',
      readFile: (filePath) => { reads.push(filePath); return content; },
    })).toBe('bridge-ready');
    expect(reads).toEqual([hermesRuntimeAttestationPath(undefined, '0.22.5')]);
    // The installed version must also be the attested product version.
    expect(readHermesRuntimeAttestation({ version: '0.22.6', readFile: () => content })).toBe('version-mismatch');
    for (const version of ['../0.22.5', '0.22.5/x', 'v0.22.5', '']) {
      expect(readHermesRuntimeAttestation({ version, readFile: () => content })).toBe('unreadable');
    }
  });
});
