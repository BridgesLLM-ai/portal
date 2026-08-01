import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import {
  SystemdHostRunBoundaryError,
  __systemdHostRunBoundaryTest,
  createSystemdHostRunBoundary,
  type SystemdHostRunBoundaryDependencies,
  type SystemdHostRunScopeIdentity,
  type SystemdHostRunScopeReservation,
} from './systemdHostRunBoundary';

const BOOT_ID = '01234567-89ab-4cde-8fab-0123456789ab';
const UUID = '12345678-9abc-4def-8abc-123456789abc';
const UNIT = 'bridgesllm-host-agent-123456789abc4def8abc123456789abc.scope';
const TAG = 'ab'.repeat(32);
const DESCRIPTION = `BridgesLLM host agent run tag=${TAG}`;
const CONTROL_GROUP = `/system.slice/${UNIT}`;
const INVOCATION_ID = '0123456789abcdef0123456789abcdef';

function show(input: {
  loadState?: string;
  activeState?: string;
  subState?: string;
  description?: string;
  invocationId?: string;
  controlGroup?: string;
  killMode?: string;
  timeoutStopUsec?: string;
} = {}): string {
  const loadState = input.loadState || 'loaded';
  return [
    `LoadState=${loadState}`,
    `ActiveState=${input.activeState || (loadState === 'not-found' ? 'inactive' : 'active')}`,
    `SubState=${input.subState || (loadState === 'not-found' ? 'dead' : 'running')}`,
    `Description=${input.description ?? (loadState === 'not-found' ? UNIT : DESCRIPTION)}`,
    `InvocationID=${input.invocationId ?? (loadState === 'not-found' ? '' : INVOCATION_ID)}`,
    `ControlGroup=${input.controlGroup ?? (loadState === 'not-found' ? '' : CONTROL_GROUP)}`,
    `KillMode=${input.killMode || 'control-group'}`,
    `TimeoutStopUSec=${input.timeoutStopUsec || '5s'}`,
    '',
  ].join('\n');
}

function fakeChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    pid: 4321,
    exitCode: null,
    signalCode: null,
    killed: false,
  }) as unknown as ChildProcess;
  child.kill = jest.fn((signal: NodeJS.Signals | number = 'SIGTERM') => {
    (child as any).killed = true;
    (child as any).signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  });
  return child;
}

function reservation(): SystemdHostRunScopeReservation {
  return {
    scopeUnit: UNIT,
    scopeTag: TAG,
    description: DESCRIPTION,
    controlGroup: CONTROL_GROUP,
    bootId: BOOT_ID,
  };
}

function identity(
  overrides: Partial<SystemdHostRunScopeIdentity> = {},
): SystemdHostRunScopeIdentity {
  return {
    ...reservation(),
    invocationId: INVOCATION_ID,
    ...overrides,
  };
}

function fixture(input: {
  shows?: string[];
  cgroupEvents?: Array<string | null>;
  bootIds?: string[];
  stopError?: Error;
  systemdRunVersionOutput?: string;
  systemdRunVersionError?: Error;
} = {}) {
  let now = 0;
  const shows = [...(input.shows || [show()])];
  const cgroupEvents = [...(input.cgroupEvents || ['populated 0\nfrozen 0\n'])];
  const bootIds = [...(input.bootIds || [])];
  const child = fakeChild();
  const spawnImpl = jest.fn<
    ChildProcess,
    [string, readonly string[], SpawnOptions]
  >(() => child);
  const systemdRunVersion = jest.fn(async () => {
    if (input.systemdRunVersionError) throw input.systemdRunVersionError;
    return input.systemdRunVersionOutput || 'systemd 255 (255.4-1ubuntu8.16)\n';
  });
  const systemctl = jest.fn(async (args: readonly string[]) => {
    if (args[0] === 'show') {
      const next = shows.shift();
      if (next === undefined) throw new Error('unexpected systemctl show');
      return next;
    }
    if (args[0] === 'stop' && input.stopError) throw input.stopError;
    return '';
  });
  const readCgroupEvents = jest.fn(async () => {
    const next = cgroupEvents.shift();
    if (next === undefined) throw new Error('unexpected cgroup read');
    return next;
  });
  const readBootId = jest.fn(async () => bootIds.shift() || BOOT_ID);
  const dependencies: Partial<SystemdHostRunBoundaryDependencies> = {
    spawn: spawnImpl,
    systemdRunVersion,
    systemctl,
    readCgroupEvents,
    readBootId,
    randomUUID: () => UUID,
    randomBytes: () => Buffer.from(TAG, 'hex'),
    wait: async (ms) => { now += ms; },
    now: () => now,
  };
  return {
    boundary: createSystemdHostRunBoundary(dependencies),
    child,
    spawnImpl,
    systemdRunVersion,
    systemctl,
    readCgroupEvents,
    readBootId,
  };
}

describe('systemdHostRunBoundary reservation and launch', () => {
  test('reserves an exact compact-lowercase UUID unit, 256-bit tag, boot, and fixed cgroup', async () => {
    const { boundary } = fixture();

    await expect(boundary.reserve()).resolves.toEqual({
      scopeUnit: UNIT,
      scopeTag: TAG,
      description: DESCRIPTION,
      controlGroup: CONTROL_GROUP,
      bootId: BOOT_ID,
    });
    expect(__systemdHostRunBoundaryTest.SCOPE_UNIT_PATTERN.test(UNIT)).toBe(true);
    expect(__systemdHostRunBoundaryTest.SCOPE_TAG_PATTERN.test(TAG)).toBe(true);
    expect(TAG).toHaveLength(64);
    expect(__systemdHostRunBoundaryTest.SYSTEMD_CGROUP_ROOT).toBe('/sys/fs/cgroup');
  });

  test('rejects malformed randomness instead of manufacturing a weaker identity', async () => {
    const boundary = createSystemdHostRunBoundary({
      randomUUID: () => 'UPPERCASE-OR-NOT-A-UUID',
      randomBytes: () => Buffer.alloc(32),
      readBootId: async () => BOOT_ID,
    });

    await expect(boundary.reserve()).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_INVALID',
      quarantine: false,
    });
  });

  test('compares a persisted boot without inspecting or signaling a potentially reused unit', async () => {
    const nextBootId = 'fedcba98-7654-4321-8fed-cba987654321';
    const { boundary, systemctl, readCgroupEvents } = fixture({
      bootIds: [BOOT_ID, nextBootId],
    });

    await expect(boundary.sameBoot(BOOT_ID)).resolves.toBe(true);
    await expect(boundary.sameBoot(BOOT_ID)).resolves.toBe(false);
    expect(systemctl).not.toHaveBeenCalled();
    expect(readCgroupEvents).not.toHaveBeenCalled();
  });

  test('rejects a malformed expected boot before any systemd lookup', async () => {
    const { boundary, systemctl, readCgroupEvents, readBootId } = fixture();

    await expect(boundary.sameBoot('not-a-boot-id')).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_INVALID',
      quarantine: false,
    });
    expect(readBootId).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(readCgroupEvents).not.toHaveBeenCalled();
  });

  test('launches the exact scope with a fixed loader-safe bootstrap environment', async () => {
    const { boundary, child, spawnImpl } = fixture();

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: ['/opt/bridgesllm/portal/backend/dist/host-wrapper.js', '--gate'],
      cwd: '/var/portal-files/user-1',
    })).resolves.toEqual({
      child,
      identity: {
        ...reservation(),
        invocationId: INVOCATION_ID,
      },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnImpl.mock.calls[0];
    expect(file).toBe('/usr/bin/systemd-run');
    expect(args).toEqual([
      '--system',
      '--scope',
      '--quiet',
      '--collect',
      '--no-ask-password',
      '--expand-environment=no',
      `--unit=${UNIT}`,
      `--description=${DESCRIPTION}`,
      '--property=KillMode=control-group',
      '--property=TimeoutStopSec=5s',
      '--',
      '/usr/bin/node',
      '/opt/bridgesllm/portal/backend/dist/host-wrapper.js',
      '--gate',
    ]);
    expect(options).toMatchObject({
      cwd: '/var/portal-files/user-1',
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    expect(child.stdout).toBeTruthy();
    expect(child.stderr).toBeTruthy();
  });

  test('provides opt-in piped stdin without changing the fixed bootstrap environment', async () => {
    const { boundary, spawnImpl } = fixture();

    await boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: ['/opt/bridgesllm/portal/backend/dist/host-wrapper.js'],
      cwd: '/var/portal-files/user-1',
      stdin: 'pipe',
    });

    expect(spawnImpl.mock.calls[0][2]).toMatchObject({
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  test('waits through systemd transitional metadata without signaling an incomplete identity', async () => {
    const {
      boundary,
      child,
      systemctl,
    } = fixture({
      shows: [
        show({
          activeState: 'inactive',
          subState: 'dead',
          controlGroup: '',
          invocationId: '',
        }),
        show(),
      ],
    });

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: ['/opt/bridgesllm/portal/backend/dist/host-wrapper.js'],
      cwd: '/var/portal-files/user-1',
    })).resolves.toMatchObject({
      identity: {
        invocationId: INVOCATION_ID,
      },
    });
    expect(systemctl.mock.calls.filter(([args]) => args[0] === 'show'))
      .toHaveLength(2);
    expect(child.kill).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test.each([
    ['249', 'systemd 249 (249.11-0ubuntu3.12)\n', false],
    ['252', 'systemd 252 (252.39-1~deb12u2)\n', false],
    ['254', 'systemd 254 (254.5-1)\n', true],
    ['255', 'systemd 255 (255.4-1ubuntu8.16)\n', true],
  ])(
    'preserves hostile argv bytes exactly on systemd %s without relying on service-unit expansion',
    async (_version, systemdRunVersionOutput, expectsNoExpandFlag) => {
      const { boundary, spawnImpl } = fixture({ systemdRunVersionOutput });
      const wrapperCommand = '/opt/bridges$literal/%n/node';
      const wrapperArgs = [
        '$PATH',
        '${PATH}',
        '$$',
        'x$PATH',
        '%n',
        '%i',
        '%%',
        '界',
        'line1\nline2',
        '',
        ' space ',
      ];

      await boundary.launch({
        reservation: reservation(),
        wrapperCommand,
        wrapperArgs,
        cwd: '/tmp',
      });

      const [, args, options] = spawnImpl.mock.calls[0];
      const separator = args.indexOf('--');
      expect(separator).toBeGreaterThan(0);
      expect(args.includes('--expand-environment=no')).toBe(expectsNoExpandFlag);
      expect(args.slice(separator + 1)).toEqual([
        wrapperCommand,
        ...wrapperArgs,
      ]);
      expect(options.env).toEqual({
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      });
    },
  );

  test.each([
    ['malformed', 'not-systemd\n'],
    ['below the supported floor', 'systemd 248 (248.3)\n'],
  ])('fails closed when the systemd-run version is %s', async (_case, output) => {
    const { boundary, spawnImpl } = fixture({
      systemdRunVersionOutput: output,
    });

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      quarantine: true,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('redacts systemd-run version probe failures and never spawns', async () => {
    const secret = 'systemd-version-probe-secret';
    const { boundary, spawnImpl } = fixture({
      systemdRunVersionError: new Error(secret),
    });

    const error = await boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      code: 'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      quarantine: true,
    });
    expect(String(error?.message)).not.toContain(secret);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('settles a launcher with missing pipes and adopts no late exact scope before failing', async () => {
    const { boundary, child, spawnImpl, systemctl, readCgroupEvents } = fixture({
      shows: [show({ loadState: 'not-found' })],
      cgroupEvents: [null],
    });
    (child as any).stdout = null;
    (child as any).stderr = null;

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_LAUNCH_FAILED',
      quarantine: true,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(systemctl).toHaveBeenCalledWith(expect.arrayContaining(['show', UNIT]));
    expect(readCgroupEvents).toHaveBeenCalledWith(CONTROL_GROUP);
  });

  test('waits for systemd registration before returning the attested scope', async () => {
    const { boundary, systemctl } = fixture({
      shows: [
        show({ loadState: 'not-found' }),
        show(),
      ],
    });

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/bin/sh',
      wrapperArgs: ['/run/bridgesllm/host-agent-runs/wrapper.sh'],
      cwd: '/tmp',
    })).resolves.toMatchObject({
      identity: { invocationId: INVOCATION_ID },
    });
    expect(systemctl.mock.calls.filter(([args]) => args[0] === 'show')).toHaveLength(2);
  });

  test.each([
    ['description', show({ description: `BridgesLLM host agent run tag=${'cd'.repeat(32)}` })],
    ['invocation', show({ invocationId: 'A'.repeat(32) })],
    ['cgroup', show({ controlGroup: `/system.slice/${UNIT}.other` })],
    ['kill mode', show({ killMode: 'process' })],
    ['stop timeout', show({ timeoutStopUsec: '1min 30s' })],
  ])('fails closed when the launched scope %s is not exact', async (_field, state) => {
    const { boundary } = fixture({ shows: [state, state] });

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
      quarantine: true,
    });
  });

  test('rejects unsafe wrapper input before spawning systemd-run', async () => {
    const { boundary, spawnImpl, systemctl } = fixture();

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: 'node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_INVALID',
      quarantine: false,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
  });

  test('rejects a child that exits before the scope can be attested', async () => {
    const { boundary, child } = fixture({
      shows: [show({ loadState: 'not-found' })],
    });
    (child as any).exitCode = 1;

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_LAUNCH_FAILED',
      quarantine: true,
    });
  });

  test('settles the launcher and adopts an exact late scope before returning launch failure', async () => {
    const firstSnapshot = show({
      description: `BridgesLLM host agent run tag=${'cd'.repeat(32)}`,
    });
    const { boundary, child, systemctl } = fixture({
      shows: [
        firstSnapshot,
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
      quarantine: true,
    });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('never signals transitional incomplete identity during failed-launch cleanup', async () => {
    const { boundary, child, systemctl } = fixture({
      shows: [
        show({ controlGroup: `/system.slice/${UNIT}.foreign` }),
        show({
          activeState: 'inactive',
          subState: 'dead',
          controlGroup: '',
          invocationId: '',
        }),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });

    await expect(boundary.launch({
      reservation: reservation(),
      wrapperCommand: '/usr/bin/node',
      wrapperArgs: [],
      cwd: '/tmp',
    })).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
      quarantine: true,
    });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });
});

describe('systemdHostRunBoundary termination and settlement', () => {
  test('stops only an exactly attested scope and proves its cgroup disappeared', async () => {
    const { boundary, systemctl, readCgroupEvents } = fixture({
      shows: [
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });

    await expect(boundary.stop(identity())).resolves.toEqual({
      scopeUnit: UNIT,
      invocationId: INVOCATION_ID,
      bootId: BOOT_ID,
      stopRequested: true,
      cgroupEmpty: true,
      finalLoadState: 'not-found',
      finalActiveState: 'inactive',
      finalSubState: 'dead',
    });
    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
    expect(readCgroupEvents).toHaveBeenCalledWith(CONTROL_GROUP);
  });

  test('proves an inactive exact scope empty without sending a stop signal', async () => {
    const { boundary, systemctl } = fixture({
      shows: [
        show({ activeState: 'inactive', subState: 'dead' }),
      ],
      cgroupEvents: ['populated 0\n'],
    });

    await expect(boundary.proveEmpty(identity())).resolves.toMatchObject({
      stopRequested: false,
      cgroupEmpty: true,
      finalActiveState: 'inactive',
    });
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('treats an ambiguous systemctl stop error as recoverable only when emptiness is proved', async () => {
    const { boundary, systemctl } = fixture({
      shows: [
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
      stopError: new Error('transport closed after request'),
    });

    await expect(boundary.stop(identity())).resolves.toMatchObject({
      stopRequested: true,
      cgroupEmpty: true,
    });
    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
  });

  test.each([
    ['tag', identity(), show({ description: `BridgesLLM host agent run tag=${'cd'.repeat(32)}` })],
    ['invocation', identity(), show({ invocationId: 'fedcba9876543210fedcba9876543210' })],
    ['cgroup', identity(), show({ controlGroup: `/system.slice/${UNIT}.reused` })],
    ['kill mode', identity(), show({ killMode: 'process' })],
  ])('never signals a scope with a mismatched %s', async (_field, persisted, state) => {
    const { boundary, systemctl } = fixture({ shows: [state] });

    await expect(boundary.stop(persisted)).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
      quarantine: true,
    });
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('never inspects or signals a malformed persisted unit', async () => {
    const { boundary, systemctl } = fixture();

    await expect(boundary.stop(identity({
      scopeUnit: 'bridgesllm-host-agent-../../openclaw-gateway.service',
    }))).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_INVALID',
      quarantine: false,
    });
    expect(systemctl).not.toHaveBeenCalled();
  });

  test('never inspects or signals an identity from another boot', async () => {
    const { boundary, systemctl, readCgroupEvents } = fixture({
      bootIds: ['fedcba98-7654-4321-8fed-cba987654321'],
    });

    await expect(boundary.stop(identity())).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
      quarantine: true,
    });
    expect(systemctl).not.toHaveBeenCalled();
    expect(readCgroupEvents).not.toHaveBeenCalled();
  });

  test('accepts an already-collected unit only when the exact derived cgroup is absent', async () => {
    const { boundary, systemctl, readCgroupEvents } = fixture({
      shows: [show({ loadState: 'not-found' })],
      cgroupEvents: [null],
    });

    await expect(boundary.stop(identity())).resolves.toMatchObject({
      stopRequested: false,
      cgroupEmpty: true,
      finalLoadState: 'not-found',
    });
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
    expect(readCgroupEvents).toHaveBeenCalledWith(CONTROL_GROUP);
  });

  test('quarantines an absent unit whose expected cgroup remains populated', async () => {
    const { boundary, systemctl } = fixture({
      shows: [show({ loadState: 'not-found' })],
      cgroupEvents: ['populated 1\nfrozen 0\n'],
    });

    await expect(boundary.stop(identity())).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
      quarantine: true,
    });
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('waits for populated zero and then returns exact terminal proof', async () => {
    const { boundary, readCgroupEvents } = fixture({
      shows: [
        show(),
        show({ activeState: 'deactivating', subState: 'stop-sigterm' }),
        show({ activeState: 'inactive', subState: 'dead' }),
      ],
      cgroupEvents: [
        'populated 1\nfrozen 0\n',
        'populated 0\nfrozen 0\n',
      ],
    });

    await expect(boundary.stop(identity())).resolves.toMatchObject({
      stopRequested: true,
      cgroupEmpty: true,
      finalActiveState: 'inactive',
    });
    expect(readCgroupEvents).toHaveBeenCalledTimes(2);
  });

  test('fails closed on malformed cgroup.events evidence', async () => {
    const { boundary } = fixture({
      shows: [
        show(),
        show({ activeState: 'inactive', subState: 'dead' }),
      ],
      cgroupEvents: ['frozen 0\n'],
    });

    await expect(boundary.stop(identity())).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
      quarantine: true,
    });
  });

  test('does not accept a populated cgroup merely because the unit is inactive', async () => {
    const shows: string[] = [show()];
    const events: string[] = [];
    for (let index = 0; index < 302; index += 1) {
      shows.push(show({ activeState: 'inactive', subState: 'dead' }));
      events.push('populated 1\n');
    }
    const { boundary } = fixture({
      shows,
      cgroupEvents: events,
    });

    await expect(boundary.stop(identity())).rejects.toMatchObject({
      code: 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
      quarantine: true,
    });
  });
});

test('systemctl show is constrained to the exact unit and required identity properties', async () => {
  const { boundary, systemctl } = fixture();

  await boundary.inspect(UNIT);

  expect(systemctl).toHaveBeenCalledWith([
    'show',
    UNIT,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=Description',
    '--property=InvocationID',
    '--property=ControlGroup',
    '--property=KillMode',
    '--property=TimeoutStopUSec',
    '--no-pager',
  ]);
});

test('boundary errors never expose low-level systemctl diagnostics', async () => {
  const secret = 'provider-secret-that-must-not-leak';
  const boundary = createSystemdHostRunBoundary({
    systemctl: async () => {
      throw new Error(secret);
    },
  });

  const error = await boundary.inspect(UNIT).catch((caught) => caught);
  expect(error).toBeInstanceOf(SystemdHostRunBoundaryError);
  expect(String(error?.message)).not.toContain(secret);
  expect(error).toMatchObject({
    code: 'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
    quarantine: true,
  });
});
