import { requireHarnessDefinition } from '../agents/harnessCatalog';
import {
  compareOpenClawReleases,
  evaluateOpenClawGatewayContract,
  OPENCLAW_REQUIRED_GATEWAY_EVENTS,
  OPENCLAW_REQUIRED_GATEWAY_METHODS,
  OPENCLAW_RUNTIME_FLOOR,
  openClawRuntimeFamilyForVersion,
  openClawRuntimeMatchesPackage,
  openClawVersionMeetsFloor,
} from './openClawRuntimeContract';

describe('OpenClaw runtime contract', () => {
  test('orders CalVer releases, prereleases before and package republishes after their release', () => {
    expect(compareOpenClawReleases('2026.10.9', '2026.9.36')).toBe(1);
    expect(compareOpenClawReleases('2026.9.9', '2026.9.36')).toBe(-1);
    expect(compareOpenClawReleases('2026.10.10-beta.5', '2026.10.10')).toBe(-1);
    expect(compareOpenClawReleases('2026.10.10-beta.5', '2026.10.9')).toBe(1);
    expect(compareOpenClawReleases('2026.7.1-2', '2026.7.1')).toBe(1);
    expect(compareOpenClawReleases('garbage', OPENCLAW_RUNTIME_FLOOR)).toBe(-1);
  });

  test('admits the floor and everything newer, never older or unparseable versions', () => {
    for (const version of ['2026.9.1', '2026.9.36', '2026.10.9', '2027.1.1']) expect(openClawVersionMeetsFloor(version)).toBe(true);
    for (const version of ['2026.8.30', '2026.9.0', '2026.9.1-beta.1', '', 'v2026.10.9', null]) expect(openClawVersionMeetsFloor(version)).toBe(false);
    expect(openClawRuntimeFamilyForVersion('2026.7.1-2')).toBe('legacy-2026.7.1');
    expect(openClawRuntimeFamilyForVersion('2026.10.9')).toBe('current-2026.9.1');
    expect(openClawRuntimeFamilyForVersion('2026.8.1')).toBeNull();
    expect(openClawRuntimeFamilyForVersion('2026.10.9', { PORTAL_OPENCLAW_STRICT_TUPLES: '1' })).toBeNull();
    expect(openClawRuntimeFamilyForVersion('2026.10.6', { PORTAL_OPENCLAW_STRICT_TUPLES: '1' })).toBe('current-2026.9.1');
  });

  test('keeps CLI and Gateway bound to the installed package', () => {
    expect(openClawRuntimeMatchesPackage('2026.10.9', '2026.10.9')).toBe(true);
    expect(openClawRuntimeMatchesPackage('2026.7.1', '2026.7.1-2')).toBe(true);
    expect(openClawRuntimeMatchesPackage('2026.10.6', '2026.10.9')).toBe(false);
    expect(openClawRuntimeMatchesPackage('2026.9.1-1', '2026.9.1')).toBe(false);
    expect(openClawRuntimeMatchesPackage(null, '2026.10.9')).toBe(false);
  });

  test('requires the core methods, events and an offered protocol, and tolerates additions', () => {
    const hello = {
      protocol: 4,
      methods: [...OPENCLAW_REQUIRED_GATEWAY_METHODS, 'sessions.reactions.list'],
      events: [...OPENCLAW_REQUIRED_GATEWAY_EVENTS, 'session.reaction'],
    };
    expect(evaluateOpenClawGatewayContract(hello)).toMatchObject({ ok: true, issue: null });
    expect(evaluateOpenClawGatewayContract({ ...hello, protocol: 2 }).ok).toBe(false);
    expect(evaluateOpenClawGatewayContract({ ...hello, methods: ['chat.send'] }).missingMethods).toContain('chat.history');
    expect(evaluateOpenClawGatewayContract(null)).toMatchObject({ ok: false, protocol: null });
  });

  test('the OpenClaw harness is floor-pinned instead of exact-pinned', () => {
    expect(requireHarnessDefinition('OPENCLAW').command.versionPolicy).toMatchObject({
      kind: 'floor-pin',
      floorVersion: OPENCLAW_RUNTIME_FLOOR,
    });
  });
});
