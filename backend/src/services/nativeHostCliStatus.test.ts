jest.mock('./nativeHostCliAdmission', () => ({
  attestNativeHostCli: jest.fn(),
}));

import {
  attestNativeHostCli,
  type NativeHostCliIdentity,
} from './nativeHostCliAdmission';
import {
  __resetNativeHostCliStatusForTests,
  getNativeHostCliStatus,
  invalidateNativeHostCliStatus,
  isNativeHostCliStatusTool,
} from './nativeHostCliStatus';

const mockedAdmission = jest.mocked(attestNativeHostCli);

function identity(toolId: 'codex' | 'claude-code' | 'clawhub'): NativeHostCliIdentity {
  const executablePath = toolId === 'codex'
    ? '/usr/bin/codex'
    : toolId === 'claude-code'
      ? '/usr/bin/claude'
      : '/usr/bin/clawhub';
  return Object.freeze({
    toolId,
    executablePath,
    packageName: toolId === 'codex'
      ? '@openai/codex'
      : toolId === 'claude-code'
        ? '@anthropic-ai/claude-code'
        : 'clawhub',
    version: toolId === 'codex' ? '0.153.2' : toolId === 'claude-code' ? '2.1.260' : '0.23.3',
    fingerprint: 'a'.repeat(64),
    checkedAt: '2026-08-27T12:00:00.000Z',
  });
}

describe('nativeHostCliStatus', () => {
  beforeEach(() => {
    __resetNativeHostCliStatusForTests();
    mockedAdmission.mockReset();
    mockedAdmission.mockImplementation(async (toolId) => identity(toolId));
  });

  test('returns and caches immutable admitted identity without executing a CLI', async () => {
    const first = await getNativeHostCliStatus('codex');
    const second = await getNativeHostCliStatus('codex');

    expect(first).toEqual({
      toolId: 'codex',
      executablePath: '/usr/bin/codex',
      state: 'verified',
      installed: true,
      executionEligible: true,
      checkedAt: '2026-08-27T12:00:00.000Z',
      observedVersion: '0.153.2',
      fingerprint: 'a'.repeat(64),
      reasonCode: null,
    });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(mockedAdmission).toHaveBeenCalledTimes(1);
    expect(mockedAdmission).toHaveBeenCalledWith('codex', '/usr/bin/codex');
  });

  test('force and explicit invalidation re-run admission', async () => {
    await getNativeHostCliStatus('claude-code');
    await getNativeHostCliStatus('claude-code', { force: true });
    invalidateNativeHostCliStatus('claude-code');
    await getNativeHostCliStatus('claude-code');
    expect(mockedAdmission).toHaveBeenCalledTimes(3);
  });

  test('a slower forced scan cannot overwrite a newer authoritative result', async () => {
    let resolveOlder!: (value: ReturnType<typeof identity>) => void;
    let resolveNewer!: (value: ReturnType<typeof identity>) => void;
    const older = new Promise<ReturnType<typeof identity>>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<ReturnType<typeof identity>>((resolve) => { resolveNewer = resolve; });
    mockedAdmission
      .mockImplementationOnce(async () => older)
      .mockImplementationOnce(async () => newer);

    const olderRequest = getNativeHostCliStatus('codex', { force: true });
    const newerRequest = getNativeHostCliStatus('codex', { force: true });
    resolveNewer(Object.freeze({
      ...identity('codex'),
      version: '0.153.2',
      fingerprint: 'b'.repeat(64),
      checkedAt: '2026-08-27T12:00:02.000Z',
    }));
    const authoritative = await newerRequest;
    resolveOlder(Object.freeze({
      ...identity('codex'),
      version: '0.145.0',
      fingerprint: 'c'.repeat(64),
      checkedAt: '2026-08-27T12:00:01.000Z',
    }));
    await olderRequest;

    const cached = await getNativeHostCliStatus('codex');
    expect(cached).toBe(authoritative);
    expect(cached).toMatchObject({
      observedVersion: '0.153.2',
      fingerprint: 'b'.repeat(64),
      checkedAt: '2026-08-27T12:00:02.000Z',
    });
    expect(mockedAdmission).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['ABSENT', 'absent'],
    ['UNSUPPORTED_VERSION', 'unsupported'],
    ['UNSUPPORTED_PLATFORM', 'unsupported'],
    ['STATUS_ONLY_VERSION', 'status_only'],
    ['DRIFT_DETECTED', 'drifted'],
    ['RACE_DETECTED', 'drifted'],
    ['BOUND_EXCEEDED', 'drifted'],
    ['MAINTENANCE_ACTIVE', 'indeterminate'],
    ['CATALOG_INVALID', 'indeterminate'],
    ['INVALID_EXECUTABLE_PATH', 'drifted'],
    ['IO_ERROR', 'indeterminate'],
  ] as const)('maps %s to %s without making it execution-eligible', async (code, state) => {
    mockedAdmission.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    await expect(getNativeHostCliStatus('clawhub', { force: true })).resolves.toMatchObject({
      toolId: 'clawhub',
      state,
      installed: code === 'ABSENT'
        ? false
        : ['UNSUPPORTED_VERSION', 'STATUS_ONLY_VERSION', 'DRIFT_DETECTED', 'RACE_DETECTED', 'BOUND_EXCEEDED'].includes(code)
          ? true
          : null,
      executionEligible: false,
      observedVersion: null,
      fingerprint: null,
      reasonCode: code,
    });
  });

  test('preserves a safely observed unsupported version without making it executable', async () => {
    mockedAdmission.mockRejectedValueOnce(Object.assign(new Error('unsupported'), {
      code: 'UNSUPPORTED_VERSION',
      observedVersion: '9.9.9',
    }));
    await expect(getNativeHostCliStatus('codex', { force: true })).resolves.toMatchObject({
      state: 'unsupported',
      installed: true,
      executionEligible: false,
      observedVersion: '9.9.9',
    });
  });

  test('recognizes only the fixed public tool ids', () => {
    expect(isNativeHostCliStatusTool('codex')).toBe(true);
    expect(isNativeHostCliStatusTool('claude-code')).toBe(true);
    expect(isNativeHostCliStatusTool('clawhub')).toBe(true);
    expect(isNativeHostCliStatusTool('clawdhub')).toBe(false);
    expect(isNativeHostCliStatusTool('../codex')).toBe(false);
  });
});
