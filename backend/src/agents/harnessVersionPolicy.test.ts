import { PORTAL_TOOL_FLOORS, PORTAL_TOOL_RECOMMENDED, PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { requireHarnessDefinition } from './harnessCatalog';
import {
  compareHarnessVersions,
  harnessVersionIsNewerThanTested,
  harnessVersionRefusal,
  parseHarnessVersion,
} from './harnessVersionPolicy';

describe('harness floor policy', () => {
  test('orders semver releases, prereleases before their release, and refuses to order unreadable input', () => {
    expect(compareHarnessVersions('1.19.5', '1.19.4')).toBe(1);
    expect(compareHarnessVersions('0.40.13', '0.40.6')).toBe(1);
    expect(compareHarnessVersions('1.0.62', '1.0.70')).toBe(-1);
    expect(compareHarnessVersions('v1.4.12', '1.4.3')).toBe(1);
    expect(compareHarnessVersions('1.19.5-beta.1', '1.19.5')).toBe(-1);
    expect(compareHarnessVersions('1.19.5-beta.2', '1.19.5-beta.10')).toBe(-1);
    expect(compareHarnessVersions('1.19.5+build.7', '1.19.5')).toBe(0);
    for (const value of ['', 'dev', '1.19', '01.2.3', '1.2.3/../x', null, 7]) {
      expect(parseHarnessVersion(value)).toBeNull();
      expect(compareHarnessVersions(value, '1.0.0')).toBeNull();
    }
  });

  test('admits the floor and newer, refuses older, unreadable and deny-listed versions in plain words', () => {
    expect(harnessVersionRefusal('OPENCODE', '1.19.4', '1.19.4')).toBeNull();
    expect(harnessVersionRefusal('OPENCODE', '1.19.5', '1.19.4')).toBeNull();
    expect(harnessVersionRefusal('OPENCODE', '2.0.0', '1.19.4')).toBeNull();
    expect(harnessVersionRefusal('OPENCODE', '1.19.3', '1.19.4'))
      .toBe("version 1.19.3 is older than the Portal's supported floor 1.19.4");
    expect(harnessVersionRefusal('OPENCODE', '1.19.4-rc.1', '1.19.4')).toMatch(/older than the Portal's supported floor/);
    expect(harnessVersionRefusal('OPENCODE', '', '1.19.4')).toBe('the installed version unknown could not be read');
    expect(harnessVersionRefusal('OPENCODE', 'nightly', '1.19.4')).toBe('the installed version nightly could not be read');
    const denylist = { HERMES: [{ version: '0.22.4', reason: 'its ACP session/load drops tool events' }] };
    expect(harnessVersionRefusal('HERMES', '0.22.4', '0.22.2', denylist))
      .toBe('version 0.22.4 is refused by the Portal: its ACP session/load drops tool events');
    expect(harnessVersionRefusal('HERMES', '0.22.5', '0.22.2', denylist)).toBeNull();
    expect(harnessVersionRefusal('OPENCODE', '0.22.4', '0.22.2', denylist)).toBeNull();
  });

  test('labels versions newer than tested as unproven only when they really are newer', () => {
    expect(harnessVersionIsNewerThanTested('1.19.5', '1.19.4')).toBe(true);
    expect(harnessVersionIsNewerThanTested('1.19.4', '1.19.4')).toBe(false);
    expect(harnessVersionIsNewerThanTested('garbage', '1.19.4')).toBe(false);
    expect(harnessVersionIsNewerThanTested('1.19.5', undefined)).toBe(false);
  });

  test('floors are today\'s tested versions and the recommended versions are recorded as proposed, not proven', () => {
    expect(PORTAL_TOOL_FLOORS).toEqual({
      antigravity: PORTAL_TOOL_VERSIONS.antigravity,
      grokBuild: PORTAL_TOOL_VERSIONS.grokBuild,
      ollama: PORTAL_TOOL_VERSIONS.ollama,
      hermes: PORTAL_TOOL_VERSIONS.hermes,
      openCode: PORTAL_TOOL_VERSIONS.openCode,
    });
    expect(PORTAL_TOOL_RECOMMENDED).toEqual({
      status: 'proposed',
      versions: { openCode: '1.19.5', hermes: '0.22.5', grokBuild: '1.0.70', antigravity: '1.4.12', ollama: '0.40.13' },
    });
    for (const [id, key] of [
      ['GROK', 'grokBuild'], ['GEMINI', 'antigravity'], ['OLLAMA', 'ollama'], ['HERMES', 'hermes'], ['OPENCODE', 'openCode'],
    ] as const) {
      expect(requireHarnessDefinition(id).command.versionPolicy).toMatchObject({
        kind: 'floor-pin',
        floorVersion: PORTAL_TOOL_FLOORS[key],
        testedVersion: PORTAL_TOOL_VERSIONS[key],
        recommended: { version: PORTAL_TOOL_RECOMMENDED.versions[key], status: 'proposed' },
      });
    }
    // Agent Zero's connector contract is not part of this floor change.
    expect(requireHarnessDefinition('AGENT_ZERO').command.versionPolicy.kind).toBe('exact-pin');
  });
});
