import { EventEmitter } from 'events';
import type { IPty, IPtyForkOptions } from 'node-pty';
import {
  TerminalSystemdScopeError,
  __terminalSystemdScopeBoundaryTest,
  createTerminalSystemdScopeBoundary,
  type TerminalSystemdScopeDependencies,
  type TerminalSystemdScopeIdentity,
} from './terminalSystemdScopeBoundary';

const BOOT_ID = '01234567-89ab-4cde-8fab-0123456789ab';
const NEXT_BOOT_ID = 'fedcba98-7654-4321-8fed-cba987654321';
const UUID = '12345678-9abc-4def-8abc-123456789abc';
const UNIT = 'bridgesllm-terminal-123456789abc4def8abc123456789abc.scope';
const TAG = 'ab'.repeat(32);
const DESCRIPTION = `BridgesLLM privileged terminal tag=${TAG}`;
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
  bindsTo?: string;
  after?: string;
} = {}): string {
  const loadState = input.loadState || 'loaded';
  return [
    `LoadState=${loadState}`,
    `ActiveState=${input.activeState || (loadState === 'not-found' ? 'inactive' : 'active')}`,
    `SubState=${input.subState || (loadState === 'not-found' ? 'dead' : 'running')}`,
    `Description=${input.description ?? (loadState === 'not-found' ? UNIT : DESCRIPTION)}`,
    `InvocationID=${input.invocationId ?? (loadState === 'not-found' ? '' : INVOCATION_ID)}`,
    `ControlGroup=${input.controlGroup ?? (loadState === 'not-found' ? '' : CONTROL_GROUP)}`,
    `KillMode=${input.killMode ?? (loadState === 'not-found' ? '' : 'control-group')}`,
    `TimeoutStopUSec=${input.timeoutStopUsec ?? (loadState === 'not-found' ? '' : '5s')}`,
    `BindsTo=${input.bindsTo ?? (loadState === 'not-found' ? '' : 'bridgesllm-product.service')}`,
    `After=${input.after ?? (loadState === 'not-found' ? '' : 'system.slice bridgesllm-product.service')}`,
    '',
  ].join('\n');
}

class FakePty implements IPty {
  readonly pid = 4321;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = 'systemd-run';
  handleFlowControl = false;
  private readonly emitter = new EventEmitter();
  readonly write = jest.fn();
  readonly resize = jest.fn();
  readonly clear = jest.fn();
  readonly pause = jest.fn();
  readonly resume = jest.fn();
  readonly kill = jest.fn((_signal?: string) => {
    queueMicrotask(() => this.emitExit(137, 9));
  });

  readonly onData = (listener: (data: string) => any) => {
    this.emitter.on('data', listener);
    return { dispose: () => this.emitter.off('data', listener) };
  };

  readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => any,
  ) => {
    this.emitter.on('exit', listener);
    return { dispose: () => this.emitter.off('exit', listener) };
  };

  emitData(data: string): void {
    this.emitter.emit('data', data);
  }

  emitExit(exitCode: number, signal?: number): void {
    this.emitter.emit('exit', { exitCode, signal });
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    command: '/bin/bash',
    args: ['-l'],
    cwd: '/root',
    env: {
      PATH: '/custom/bin',
      HOME: '/root',
      TERM: 'xterm-256color',
    },
    cols: 80,
    rows: 24,
    terminalName: 'xterm-256color',
    ...overrides,
  } as any;
}

function fixture(options: {
  shows?: string[];
  listOutputs?: string[];
  cgroupEvents?: Array<string | null>;
  bootIds?: string[];
  systemdVersion?: string;
  gateReady?: Promise<void>;
} = {}) {
  let now = 0;
  const shows = [...(options.shows || [show()])];
  const listOutputs = [...(options.listOutputs || [''])];
  const cgroupEvents = [...(options.cgroupEvents || [null])];
  const bootIds = [...(options.bootIds || [])];
  const pty = new FakePty();
  const ptySpawn = jest.fn<
    IPty,
    [string, string[], IPtyForkOptions]
  >(() => pty);
  const systemctl = jest.fn(async (args: readonly string[]) => {
    if (args[0] === 'show') {
      const next = shows.shift();
      if (next === undefined) throw new Error('unexpected show');
      return next;
    }
    return '';
  });
  const listTerminalScopeUnits = jest.fn(async () => {
    const next = listOutputs.shift();
    if (next === undefined) return '';
    return next;
  });
  const readCgroupEvents = jest.fn(async () => {
    const next = cgroupEvents.shift();
    if (next === undefined) throw new Error('unexpected cgroup read');
    return next;
  });
  const readBootId = jest.fn(async () => bootIds.shift() || BOOT_ID);
  const gate = {
    socketPath: `/run/bridgesllm/terminal-scopes/gate-${UUID.replace(/-/g, '')}.sock`,
    ready: options.gateReady || Promise.resolve(),
    prepareTargetEnvironment: jest.fn(),
    release: jest.fn(async () => undefined),
    abort: jest.fn(async () => undefined),
  };
  const initializeStorage = jest.fn(() => '/run/bridgesllm/terminal-scopes');
  const scavengeActivationSockets = jest.fn();
  const dependencies: Partial<TerminalSystemdScopeDependencies> = {
    ptySpawn,
    systemdRunVersion: async () => (
      options.systemdVersion || 'systemd 255 (255.4-1ubuntu8.16)\n'
    ),
    systemctl,
    listTerminalScopeUnits,
    readCgroupEvents,
    readBootId,
    randomUUID: () => UUID,
    randomBytes: () => Buffer.from(TAG, 'hex'),
    wait: async (ms) => {
      now += ms;
      await Promise.resolve();
    },
    now: () => now,
    createActivationGate: async () => gate,
    initializeStorage,
    scavengeActivationSockets,
  };
  const boundary = createTerminalSystemdScopeBoundary(dependencies);
  return {
    boundary,
    pty,
    ptySpawn,
    gate,
    systemctl,
    listTerminalScopeUnits,
    readCgroupEvents,
    readBootId,
    initializeStorage,
    scavengeActivationSockets,
  };
}

async function initializedFixture(
  options: Parameters<typeof fixture>[0] = {},
) {
  const result = fixture(options);
  await result.boundary.initialize();
  return result;
}

describe('terminal systemd scope launch and activation', () => {
  test('keeps the target gated until the exact scope and parent binding are attested', async () => {
    const {
      boundary,
      pty,
      ptySpawn,
      gate,
      systemctl,
    } = await initializedFixture({
      shows: [
        show(),
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });

    const session = await boundary.prepare(input());

    expect(gate.prepareTargetEnvironment).toHaveBeenCalledWith({
      PATH: '/custom/bin',
      HOME: '/root',
      TERM: 'xterm-256color',
    });
    expect(gate.release).not.toHaveBeenCalled();
    expect(session.identity).toEqual({
      scopeUnit: UNIT,
      scopeTag: TAG,
      description: DESCRIPTION,
      controlGroup: CONTROL_GROUP,
      bootId: BOOT_ID,
      invocationId: INVOCATION_ID,
    });
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    const [file, args, ptyOptions] = ptySpawn.mock.calls[0];
    expect(file).toBe('/usr/bin/systemd-run');
    expect(args).toEqual(expect.arrayContaining([
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
      '--property=BindsTo=bridgesllm-product.service',
      '--property=After=bridgesllm-product.service',
      '--',
    ]));
    expect(ptyOptions).toMatchObject({
      cwd: '/root',
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
    });
    expect(JSON.stringify(ptyOptions.env)).not.toContain('/custom/bin');
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);

    await session.activate();
    expect(gate.release).toHaveBeenCalledTimes(1);
    await session.stop();
    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  test('waits through systemd transitional metadata without signaling an incomplete identity', async () => {
    const {
      boundary,
      pty,
      systemctl,
    } = await initializedFixture({
      shows: [
        show({
          activeState: 'inactive',
          subState: 'dead',
          controlGroup: '',
          invocationId: '',
        }),
        show(),
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });

    const session = await boundary.prepare(input());
    expect(session.identity.invocationId).toBe(INVOCATION_ID);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);

    await session.stop();
    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
  });

  test.each([
    ['249', 'systemd 249 (249.11-0ubuntu3.12)\n', false],
    ['252', 'systemd 252 (252.39-1~deb12u2)\n', false],
    ['254', 'systemd 254 (254.5-1)\n', true],
    ['255', 'systemd 255 (255.4-1ubuntu8.16)\n', true],
  ])(
    'preserves hostile wrapper argv on systemd %s with the correct compatibility flag',
    async (_version, systemdVersion, expectsNoExpandFlag) => {
      const { boundary, ptySpawn } = await initializedFixture({
        systemdVersion,
        shows: [
          show(),
          show(),
          show({ loadState: 'not-found' }),
        ],
        cgroupEvents: [null],
      });
      const hostile = [
        '$PATH',
        '${PATH}',
        '$$',
        '%n',
        '%i',
        '%%',
        '界',
        'line1\nline2',
        '',
      ];
      const session = await boundary.prepare(input({
        command: '/opt/terminal$literal/%n/bash',
        args: hostile,
      }));

      const args = ptySpawn.mock.calls[0][1];
      expect(args.includes('--expand-environment=no')).toBe(expectsNoExpandFlag);
      const systemdSeparator = args.indexOf('--');
      const wrapperSeparator = args.lastIndexOf('--');
      expect(args.slice(-hostile.length)).toEqual(hostile);
      expect(args[systemdSeparator + 1]).toBe(process.execPath);
      expect(args[wrapperSeparator + 1]).toMatch(
        /^\/run\/bridgesllm\/terminal-scopes\/gate-[0-9a-f]{32}\.sock$/,
      );
      await session.stop();
    },
  );

  test('rejects a parent-service binding mismatch without signaling the unit', async () => {
    const { boundary, systemctl, pty } = await initializedFixture({
      shows: [
        show({ bindsTo: 'some-other.service' }),
        show({ bindsTo: 'some-other.service' }),
      ],
    });

    await expect(boundary.prepare(input())).rejects.toMatchObject({
      code: 'TERMINAL_SCOPE_SETTLEMENT_UNPROVEN',
      settlementProven: false,
    });
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM');
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('never signals transitional incomplete identity during failed-launch cleanup', async () => {
    const { boundary, systemctl, pty } = await initializedFixture({
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

    await expect(boundary.prepare(input())).rejects.toMatchObject({
      code: 'TERMINAL_SCOPE_IDENTITY_MISMATCH',
      settlementProven: true,
    });
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM');
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('a changed boot proves old local processes impossible without inspecting or signaling a reused unit', async () => {
    const {
      boundary,
      systemctl,
      readCgroupEvents,
    } = await initializedFixture({
      shows: [show()],
      bootIds: [BOOT_ID, BOOT_ID, NEXT_BOOT_ID],
    });
    const session = await boundary.prepare(input());

    await expect(session.stop()).resolves.toMatchObject({
      bootChanged: true,
      stopRequested: false,
      cgroupEmpty: true,
    });
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
    expect(readCgroupEvents).not.toHaveBeenCalled();
  });

  test('PTY exit triggers exact recursive scope settlement instead of PTY signaling', async () => {
    const {
      boundary,
      pty,
      systemctl,
    } = await initializedFixture({
      shows: [
        show(),
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });
    const session = await boundary.prepare(input());
    await session.activate();

    pty.emitExit(0);
    await Promise.resolve();
    await Promise.resolve();
    await session.stop();

    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
    expect(pty.kill).not.toHaveBeenCalled();
  });
});

describe('terminal systemd scope recovery and shutdown', () => {
  test('startup recovers only an exact tagged orphan and proves its cgroup empty', async () => {
    const inventory = `${UNIT} loaded active running ${DESCRIPTION}\n`;
    const {
      boundary,
      systemctl,
      listTerminalScopeUnits,
      scavengeActivationSockets,
    } = fixture({
      listOutputs: [inventory, ''],
      shows: [
        show(),
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });

    await expect(boundary.initialize()).resolves.toEqual({ recovered: 1 });
    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
    expect(listTerminalScopeUnits).toHaveBeenCalledTimes(2);
    expect(scavengeActivationSockets).toHaveBeenCalledTimes(1);
  });

  test('startup never signals a prefixed unit with mismatched ownership evidence', async () => {
    const inventory = `${UNIT} loaded active running foreign\n`;
    const { boundary, systemctl } = fixture({
      listOutputs: [inventory],
      shows: [show({ description: 'Foreign terminal scope' })],
    });

    await expect(boundary.initialize()).rejects.toMatchObject({
      code: 'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
      settlementProven: false,
    });
    expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
  });

  test('shutdown stops every active exact scope before completing', async () => {
    const {
      boundary,
      systemctl,
    } = await initializedFixture({
      listOutputs: ['', ''],
      shows: [
        show(),
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });
    await boundary.prepare(input());

    await boundary.shutdown();

    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
    expect(boundary.snapshot()).toMatchObject({
      shuttingDown: true,
      activeSessions: 0,
      activePreparations: 0,
    });
  });

  test('dependency-promotion quiescence stops all tracked scopes without shutting runtime down', async () => {
    const {
      boundary,
      systemctl,
    } = await initializedFixture({
      listOutputs: ['', ''],
      shows: [
        show(),
        show(),
        show({ loadState: 'not-found' }),
      ],
      cgroupEvents: [null],
    });
    await boundary.prepare(input());

    await expect(boundary.quiesceForProjectDependencyPromotion()).resolves.toEqual({
      preparationCount: 0,
      sessionCount: 1,
      recoveredCount: 0,
    });

    expect(systemctl).toHaveBeenCalledWith(['stop', UNIT]);
    expect(boundary.snapshot()).toMatchObject({
      shuttingDown: false,
      activeSessions: 0,
      activePreparations: 0,
    });
  });
});

test('parsers reject malformed inventories and persisted identities', () => {
  expect(() => __terminalSystemdScopeBoundaryTest.parseUnitList(
    'bridgesllm-terminal-../../foreign.service loaded active running bad\n',
  )).toThrow(TerminalSystemdScopeError);
  expect(() => __terminalSystemdScopeBoundaryTest.parseSystemdRunVersion(
    'systemd 248 (248.3)\n',
  )).toThrow(TerminalSystemdScopeError);
  expect(__terminalSystemdScopeBoundaryTest.TERMINAL_ACTIVATION_WRAPPER_SOURCE)
    .not.toContain('process.env');
});

test('stop never signals an exact-looking unit whose invocation identity drifted', async () => {
  const { boundary, systemctl } = await initializedFixture({
    shows: [show({ invocationId: 'fedcba9876543210fedcba9876543210' })],
  });
  const identity: TerminalSystemdScopeIdentity = {
    scopeUnit: UNIT,
    scopeTag: TAG,
    description: DESCRIPTION,
    controlGroup: CONTROL_GROUP,
    bootId: BOOT_ID,
    invocationId: INVOCATION_ID,
  };

  await expect(boundary.stopIdentity(identity)).rejects.toMatchObject({
    code: 'TERMINAL_SCOPE_IDENTITY_MISMATCH',
    settlementProven: false,
  });
  expect(systemctl).not.toHaveBeenCalledWith(['stop', UNIT]);
});
