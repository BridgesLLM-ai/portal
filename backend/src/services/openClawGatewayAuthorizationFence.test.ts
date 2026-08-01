import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OpenClawGatewayAuthorizationFenceError,
  __openClawGatewayAuthorizationFenceTest,
  createOpenClawGatewayAuthorizationFence,
  type OpenClawGatewayFenceMarkerIdentity,
  type OpenClawRootUserManagerSnapshot,
} from './openClawGatewayAuthorizationFence';
import { getOpenClawApiUrl } from '../config/openclaw';

const CONTROL_GROUP =
  __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_CONTROL_GROUP;
const ROOT_USER_CONTROL_GROUP =
  __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_CONTROL_GROUP;
const ROOT_USER_MANAGER_CONTROL_GROUP =
  __openClawGatewayAuthorizationFenceTest.ROOT_USER_MANAGER_CONTROL_GROUP;
const MARKER: OpenClawGatewayFenceMarkerIdentity = Object.freeze({
  path: '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
  device: '2049',
  inode: '71234',
});

test('the permanent drop-in inhibits starts and converges cgroup-wide termination', () => {
  expect(
    __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN_CONTENT,
  ).toBe([
    '[Unit]',
    'ConditionPathExists=!/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
    '[Service]',
    'KillMode=control-group',
    '',
  ].join('\n'));
  expect(
    __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_DROP_IN_CONTENT,
  ).toBe([
    '[Unit]',
    'ConditionPathExists=!/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
    '[Service]',
    'KillMode=control-group',
    'ExecCondition=/usr/bin/false',
    '',
  ].join('\n'));
});

function snapshot(input: {
  loadState?: string;
  activeState: string;
  subState: string;
  killMode?: string;
  mainPid: number;
  controlGroup?: string;
  fragmentPath?: string;
  dropInPaths?: string;
  needDaemonReload?: string;
  rootUser?: boolean;
}): string {
  const unitPath = input.rootUser
    ? __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH
    : __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_UNIT_PATH;
  const dropInPath = input.rootUser
    ? __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_DROP_IN
    : __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN;
  return [
    `LoadState=${input.loadState ?? 'loaded'}`,
    `ActiveState=${input.activeState}`,
    `SubState=${input.subState}`,
    `KillMode=${input.killMode ?? 'control-group'}`,
    `MainPID=${input.mainPid}`,
    `ControlGroup=${input.controlGroup || ''}`,
    `FragmentPath=${
      input.fragmentPath
      ?? unitPath
    }`,
    `DropInPaths=${
      input.dropInPaths
      ?? dropInPath
    }`,
    `NeedDaemonReload=${input.needDaemonReload ?? 'no'}`,
    '',
  ].join('\n');
}

function rootUserManagerSnapshot(input: {
  loadState?: string;
  activeState: string;
  subState: string;
  mainPid: number;
  controlGroup?: string;
}): string {
  return [
    `LoadState=${input.loadState ?? 'loaded'}`,
    `ActiveState=${input.activeState}`,
    `SubState=${input.subState}`,
    `MainPID=${input.mainPid}`,
    `ControlGroup=${input.controlGroup || ''}`,
    '',
  ].join('\n');
}

const INACTIVE_ROOT_USER_MANAGER: OpenClawRootUserManagerSnapshot =
  Object.freeze({
    available: true,
    active: false,
    activeState: 'inactive',
    subState: 'dead',
    mainPid: 0,
    controlGroup: null,
  });

const ACTIVE_ROOT_USER_MANAGER: OpenClawRootUserManagerSnapshot =
  Object.freeze({
    available: true,
    active: true,
    activeState: 'active',
    subState: 'running',
    mainPid: 1009,
    controlGroup: ROOT_USER_MANAGER_CONTROL_GROUP,
  });

function fixture(
  shows: string[],
  options: {
    cgroupEvents?: string | null;
    listenerPids?: readonly (readonly number[])[];
    listenerControlGroup?: string | null;
    markerSequence?: readonly (OpenClawGatewayFenceMarkerIdentity | null)[];
    markerInitiallyPresent?: boolean;
    gatewayApiUrl?: string;
    rootUserShows?: string[];
    rootUserManagers?: readonly OpenClawRootUserManagerSnapshot[];
    cgroupEventsByControlGroup?: Readonly<Record<string, string | null>>;
  } = {},
) {
  let now = 0;
  let markerPresent = options.markerInitiallyPresent ?? false;
  const markerSequence = [...(options.markerSequence || [])];
  const listenerPids = [...(options.listenerPids || [[]])];
  const systemctl = jest.fn(async (args: readonly string[]) => {
    if (args[0] === 'show') {
      const next = shows.shift();
      if (next === undefined) throw new Error('unexpected systemctl show');
      return next;
    }
    return '';
  });
  const rootUserShows = [...(options.rootUserShows || [])];
  const rootUserSystemctl = jest.fn(async (args: readonly string[]) => {
    if (args[0] === 'show') {
      const next = rootUserShows.length > 1
        ? rootUserShows.shift()
        : rootUserShows[0];
      if (next === undefined) throw new Error('unexpected root user systemctl show');
      return next;
    }
    return '';
  });
  const rootUserManagers = [
    ...(options.rootUserManagers || [INACTIVE_ROOT_USER_MANAGER]),
  ];
  const inspectRootUserManager = jest.fn(async () => (
    rootUserManagers.length > 1
      ? rootUserManagers.shift()!
      : rootUserManagers[0]!
  ));
  const ensureMarker = jest.fn(() => {
    markerPresent = true;
    return MARKER;
  });
  const inspectMarker = jest.fn(() => {
    if (markerSequence.length > 0) return markerSequence.shift() ?? null;
    return markerPresent ? MARKER : null;
  });
  const removeMarker = jest.fn(() => {
    markerPresent = false;
  });
  const attestDropIn = jest.fn(() => {});
  const attestRootUserDropIn = jest.fn(() => {});
  const attestRootUserMask = jest.fn(() => {});
  const listListeningPids = jest.fn(async () => (
    listenerPids.length > 1
      ? listenerPids.shift()!
      : listenerPids[0] || []
  ));
  const readProcessControlGroup = jest.fn(() => (
    options.listenerControlGroup === undefined
      ? CONTROL_GROUP
      : options.listenerControlGroup
  ));
  const getGatewayApiUrl = jest.fn(() => (
    options.gatewayApiUrl || 'http://localhost:18789'
  ));
  return {
    getGatewayApiUrl,
    systemctl,
    rootUserSystemctl,
    inspectRootUserManager,
    ensureMarker,
    inspectMarker,
    removeMarker,
    attestDropIn,
    attestRootUserDropIn,
    attestRootUserMask,
    listListeningPids,
    readProcessControlGroup,
    fence: createOpenClawGatewayAuthorizationFence({
      getGatewayApiUrl,
      systemctl,
      rootUserSystemctl,
      inspectRootUserManager,
      ensureMarker,
      inspectMarker,
      removeMarker,
      attestDropIn,
      attestRootUserDropIn,
      attestRootUserMask,
      listListeningPids,
      readProcessControlGroup,
      readCgroupEvents: jest.fn((controlGroup: string) => (
        options.cgroupEventsByControlGroup
          && Object.prototype.hasOwnProperty.call(
            options.cgroupEventsByControlGroup,
            controlGroup,
          )
          ? options.cgroupEventsByControlGroup[controlGroup]!
          : controlGroup === CONTROL_GROUP
            ? options.cgroupEvents ?? 'populated 0\nfrozen 0\n'
            : 'populated 0\nfrozen 0\n'
      )),
      wait: jest.fn(async () => { now += 100; }),
      now: () => now,
    }),
  };
}

test('parses only the installer-owned loaded unit with the persistent drop-in', () => {
  expect(__openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'active',
    subState: 'running',
    mainPid: 4312,
    controlGroup: CONTROL_GROUP,
  }))).toMatchObject({
    installed: true,
    active: true,
    mainPid: 4312,
    controlGroup: CONTROL_GROUP,
    fragmentPath: __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_UNIT_PATH,
    dropInPaths: [
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN,
    ],
  });

  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'active',
    subState: 'running',
    mainPid: 0,
  }))).toThrow('process identity is incomplete');
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'active',
    subState: 'running',
    killMode: 'process',
    mainPid: 4312,
    controlGroup: CONTROL_GROUP,
  }))).toThrow('lacks control-group termination');
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'active',
    subState: 'running',
    mainPid: 4312,
    controlGroup: CONTROL_GROUP,
    dropInPaths: '/etc/systemd/system/openclaw-gateway.service.d/10-other.conf',
  }))).toThrow('authorization fence is not the final effective drop-in');
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'active',
    subState: 'running',
    mainPid: 4312,
    controlGroup: CONTROL_GROUP,
    dropInPaths: [
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN,
      '/etc/systemd/system/openclaw-gateway.service.d/99-reset-condition.conf',
    ].join(' '),
  }))).toThrow('authorization fence is not the final effective drop-in');
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'active',
    subState: 'running',
    mainPid: 4312,
    controlGroup: '/user.slice/user-0.slice/openclaw-gateway.service',
  }))).toThrow('cgroup identity is invalid');
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
    activeState: 'inactive',
    subState: 'dead',
    mainPid: 0,
    needDaemonReload: 'yes',
  }))).toThrow('systemd manager has stale unit state');
});

test('attests the canonical root user manager and gateway unit identities', () => {
  expect(
    __openClawGatewayAuthorizationFenceTest.parseRootUserManagerShow(
      rootUserManagerSnapshot({
        activeState: 'active',
        subState: 'running',
        mainPid: 1009,
        controlGroup: ROOT_USER_MANAGER_CONTROL_GROUP,
      }),
    ),
  ).toEqual(ACTIVE_ROOT_USER_MANAGER);
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseRootUserManagerShow(
      rootUserManagerSnapshot({
        activeState: 'active',
        subState: 'running',
        mainPid: 1009,
        controlGroup: '/user.slice/user-1000.slice/user@1000.service',
      }),
    )
  )).toThrow('identity is inconsistent');

  expect(
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 2201,
      controlGroup: ROOT_USER_CONTROL_GROUP,
      rootUser: true,
    })),
  ).toMatchObject({
    installed: true,
    active: true,
    mainPid: 2201,
    controlGroup: ROOT_USER_CONTROL_GROUP,
    fragmentPath:
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH,
  });
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
      rootUser: true,
      dropInPaths:
        __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN,
    }))
  )).toThrow('root user systemd authorization fence');
});

test('accepts only an inactive exact root user mask identity', () => {
  expect(
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      loadState: 'masked',
      activeState: 'inactive',
      subState: 'dead',
      killMode: '',
      mainPid: 0,
      rootUser: true,
      dropInPaths: '',
    })),
  ).toMatchObject({
    installed: true,
    masked: true,
    active: false,
    mainPid: 0,
    fragmentPath:
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_UNIT_PATH,
    dropInPaths: [],
  });
  expect(
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      loadState: 'masked',
      activeState: 'inactive',
      subState: 'dead',
      killMode: '',
      mainPid: 0,
      rootUser: true,
      needDaemonReload: 'yes',
    })),
  ).toMatchObject({
    masked: true,
    needDaemonReload: true,
    dropInPaths: [
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_DROP_IN,
    ],
  });
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      loadState: 'masked',
      activeState: 'active',
      subState: 'running',
      killMode: '',
      mainPid: 2201,
      controlGroup: ROOT_USER_CONTROL_GROUP,
      rootUser: true,
      dropInPaths: '',
    }))
  )).toThrow('masked identity is inconsistent');
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      loadState: 'masked',
      activeState: 'inactive',
      subState: 'dead',
      killMode: '',
      mainPid: 0,
      rootUser: true,
      fragmentPath: '/root/.config/systemd/user/foreign.service',
      dropInPaths: '',
    }))
  )).toThrow('unit path is not installer-owned');
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseRootUserSystemctlShow(snapshot({
      loadState: 'masked',
      activeState: 'inactive',
      subState: 'dead',
      killMode: '',
      mainPid: 0,
      rootUser: true,
      dropInPaths:
        '/root/.config/systemd/user/openclaw-gateway.service.d/99-foreign.conf',
    }))
  )).toThrow('masked identity is inconsistent');
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(snapshot({
      loadState: 'masked',
      activeState: 'inactive',
      subState: 'dead',
      killMode: '',
      mainPid: 0,
      dropInPaths: '',
    }))
  )).toThrow('not in a loaded state');
});

test('configured endpoint parsing honors API and gateway overrides with exact loopback ports', () => {
  const previousApiUrl = process.env.OPENCLAW_API_URL;
  const previousGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  try {
    process.env.OPENCLAW_API_URL = 'http://127.0.0.1:20444';
    process.env.OPENCLAW_GATEWAY_URL = 'https://[::1]:20555';
    expect(
      __openClawGatewayAuthorizationFenceTest.parseConfiguredGatewayEndpoint(
        getOpenClawApiUrl(),
      ),
    ).toEqual({
      apiUrl: 'http://127.0.0.1:20444/',
      port: 20_444,
    });

    delete process.env.OPENCLAW_API_URL;
    expect(
      __openClawGatewayAuthorizationFenceTest.parseConfiguredGatewayEndpoint(
        getOpenClawApiUrl(),
      ),
    ).toEqual({
      apiUrl: 'https://[::1]:20555/',
      port: 20_555,
    });
  } finally {
    if (previousApiUrl === undefined) delete process.env.OPENCLAW_API_URL;
    else process.env.OPENCLAW_API_URL = previousApiUrl;
    if (previousGatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousGatewayUrl;
  }
});

test.each([
  'ws://127.0.0.1:18789',
  'http://10.0.0.2:18789',
  'http://localhost:18789/api',
  'http://user@localhost:18789',
  'http://localhost:18789?port=19999',
  ' http://localhost:18789',
])('configured endpoint parsing rejects remote, non-HTTP, or ambiguous URL %s', (url) => {
  expect(() => (
    __openClawGatewayAuthorizationFenceTest.parseConfiguredGatewayEndpoint(url)
  )).toThrow();
});

test('stop establishes and reattests the marker before proving no listener remains', async () => {
  const {
    fence,
    systemctl,
    ensureMarker,
    inspectMarker,
    attestDropIn,
    attestRootUserDropIn,
  } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ]);

  await expect(fence.stop()).resolves.toEqual(expect.objectContaining({
    stopped: true,
    priorActive: true,
    priorMainPid: 4312,
    priorControlGroup: CONTROL_GROUP,
    observedMainPid: 0,
    cgroupEmpty: true,
    listenerPort: 18_789,
    listenersAbsent: true,
    markerPath: MARKER.path,
    markerDevice: MARKER.device,
    markerInode: MARKER.inode,
    rootUserManagerActive: false,
    rootUserUnitInstalled: false,
    rootUserCgroupEmpty: true,
  }));
  expect(ensureMarker).toHaveBeenCalledTimes(1);
  expect(inspectMarker).toHaveBeenCalledTimes(1);
  expect(attestDropIn).toHaveBeenCalledTimes(2);
  expect(attestRootUserDropIn).toHaveBeenCalledTimes(2);
  expect(systemctl).toHaveBeenCalledWith(['daemon-reload']);
  expect(systemctl).toHaveBeenCalledWith(['stop', 'openclaw-gateway.service']);
  expect(systemctl).toHaveBeenCalledWith(['start', 'openclaw-gateway.service']);
});

test('stop fences and quiesces the canonical root user gateway authority', async () => {
  const {
    fence,
    rootUserSystemctl,
    inspectRootUserManager,
  } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ], {
    rootUserManagers: [
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
    ],
    rootUserShows: [
      snapshot({
        activeState: 'active',
        subState: 'running',
        mainPid: 2201,
        controlGroup: ROOT_USER_CONTROL_GROUP,
        rootUser: true,
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
    ],
  });

  await expect(fence.stop()).resolves.toMatchObject({
    rootUserManagerActive: true,
    rootUserUnitInstalled: true,
    rootUserUnitPriorActive: true,
    rootUserUnitObservedActiveState: 'inactive',
    rootUserUnitObservedMainPid: 0,
    rootUserCgroupEmpty: true,
    rootUserDropInPath:
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_ROOT_USER_DROP_IN,
  });
  expect(rootUserSystemctl).toHaveBeenCalledWith(['daemon-reload']);
  expect(rootUserSystemctl).toHaveBeenCalledWith([
    'stop',
    'openclaw-gateway.service',
  ]);
  expect(rootUserSystemctl).toHaveBeenCalledWith([
    'start',
    'openclaw-gateway.service',
  ]);
  expect(inspectRootUserManager).toHaveBeenCalledTimes(2);
});

test('stop fails closed if the root user unit starts despite the durable marker', async () => {
  const { fence } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ], {
    rootUserManagers: [
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
    ],
    rootUserShows: [
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
      snapshot({
        activeState: 'active',
        subState: 'running',
        mainPid: 2201,
        controlGroup: ROOT_USER_CONTROL_GROUP,
        rootUser: true,
      }),
    ],
  });

  await expect(fence.stop()).rejects.toThrow(
    'root user gateway did not reach a durably fenced empty state',
  );
});

test('stop preserves and reattests an exact pre-existing root user mask', async () => {
  const {
    fence,
    rootUserSystemctl,
    attestRootUserMask,
  } = fixture([
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
  ], {
    rootUserManagers: [
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
    ],
    rootUserShows: [
      snapshot({
        loadState: 'masked',
        activeState: 'inactive',
        subState: 'dead',
        killMode: '',
        mainPid: 0,
        rootUser: true,
        dropInPaths: '',
      }),
      snapshot({
        loadState: 'masked',
        activeState: 'inactive',
        subState: 'dead',
        killMode: '',
        mainPid: 0,
        rootUser: true,
        dropInPaths: '',
      }),
    ],
  });

  await expect(fence.stop()).resolves.toMatchObject({
    rootUserUnitInstalled: true,
    rootUserUnitMasked: true,
    rootUserUnitPriorActive: false,
    rootUserUnitObservedMainPid: 0,
  });
  expect(attestRootUserMask).toHaveBeenCalledTimes(2);
  expect(rootUserSystemctl).not.toHaveBeenCalledWith([
    'start',
    'openclaw-gateway.service',
  ]);
  expect(rootUserSystemctl).not.toHaveBeenCalledWith([
    'stop',
    'openclaw-gateway.service',
  ]);
});

test('stop fails closed on unsafe root user mask bytes or load-state drift', async () => {
  const unsafe = fixture([
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
  ], {
    rootUserManagers: [ACTIVE_ROOT_USER_MANAGER],
    rootUserShows: [
      snapshot({
        loadState: 'masked',
        activeState: 'inactive',
        subState: 'dead',
        killMode: '',
        mainPid: 0,
        rootUser: true,
        dropInPaths: '',
      }),
    ],
  });
  unsafe.attestRootUserMask.mockImplementation(() => {
    throw new Error('arbitrary symlink or regular-file mask');
  });
  await expect(unsafe.fence.stop()).rejects.toThrow(
    'root user gateway mask could not be attested',
  );

  const drift = fixture([
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
  ], {
    rootUserManagers: [
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
    ],
    rootUserShows: [
      snapshot({
        loadState: 'masked',
        activeState: 'inactive',
        subState: 'dead',
        killMode: '',
        mainPid: 0,
        rootUser: true,
        dropInPaths: '',
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
    ],
  });
  await expect(drift.fence.stop()).rejects.toThrow(
    'root user gateway did not reach a durably fenced empty state',
  );
});

test('stop fails closed when an inactive root user manager cgroup remains populated', async () => {
  const { fence, rootUserSystemctl } = fixture([
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    }),
  ], {
    cgroupEventsByControlGroup: {
      [ROOT_USER_MANAGER_CONTROL_GROUP]: 'populated 1\nfrozen 0\n',
    },
  });

  await expect(fence.stop()).rejects.toThrow(
    'root user systemd authority remained populated',
  );
  expect(rootUserSystemctl).not.toHaveBeenCalled();
});
test('stop proves the configured override port instead of the historical default', async () => {
  const { fence, listListeningPids } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ], {
    gatewayApiUrl: 'http://127.0.0.1:21111',
  });

  await expect(fence.stop()).resolves.toMatchObject({
    listenerPort: 21_111,
    listenersAbsent: true,
  });
  expect(listListeningPids).toHaveBeenCalledWith(21_111);
  expect(listListeningPids).not.toHaveBeenCalledWith(18_789);
});

test('stop rejects a configured non-loopback endpoint before systemd mutation', async () => {
  const { fence, ensureMarker, systemctl } = fixture([], {
    gatewayApiUrl: 'http://192.0.2.20:18789',
  });

  await expect(fence.stop()).rejects.toThrow(
    'not an unambiguous loopback HTTP URL',
  );
  expect(ensureMarker).not.toHaveBeenCalled();
  expect(systemctl).not.toHaveBeenCalled();
});

test('stop fails closed when a descendant remains in the prior gateway cgroup', async () => {
  const { fence } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ], {
    cgroupEvents: 'populated 1\nfrozen 0\n',
  });

  await expect(fence.stop()).rejects.toBeInstanceOf(
    OpenClawGatewayAuthorizationFenceError,
  );
});

test('stop rejects a user-unit or foreground listener even after the system unit stops', async () => {
  const { fence } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ], {
    listenerPids: [[9912]],
    listenerControlGroup: '/user.slice/user-0.slice/openclaw-gateway.service',
  });

  await expect(fence.stop()).rejects.toThrow(
    'durably fenced empty state',
  );
});

test('stop rejects marker replacement during systemd settlement', async () => {
  const replacement = Object.freeze({
    ...MARKER,
    inode: '99888',
  });
  const { fence } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
  ], {
    markerSequence: [replacement],
  });

  await expect(fence.stop()).rejects.toThrow(
    'durably fenced empty state',
  );
});

test('stop fails closed when a later drop-in can reset the effective condition', async () => {
  const { fence } = fixture([
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 4312,
      controlGroup: CONTROL_GROUP,
    }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
      dropInPaths: [
        __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN,
        '/etc/systemd/system/openclaw-gateway.service.d/99-reset-condition.conf',
      ].join(' '),
    }),
  ]);

  await expect(fence.stop()).rejects.toMatchObject({
    code: 'OPENCLAW_GATEWAY_AUTHORIZATION_FENCE_UNAVAILABLE',
    retryable: true,
  });
});

test('release removes the marker, always converges the installed unit, and proves its listener', async () => {
  const { fence, systemctl, removeMarker, readProcessControlGroup } = fixture([
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 9921,
      controlGroup: CONTROL_GROUP,
    }),
  ], {
    markerInitiallyPresent: true,
    listenerPids: [[], [], [9921]],
  });

  await expect(fence.release(false)).resolves.toMatchObject({
    active: true,
    mainPid: 9921,
    controlGroup: CONTROL_GROUP,
  });
  expect(removeMarker).toHaveBeenCalledTimes(1);
  expect(systemctl).toHaveBeenCalledWith(['start', 'openclaw-gateway.service']);
  expect(readProcessControlGroup).toHaveBeenCalledWith(9921);
  expect(removeMarker.mock.invocationCallOrder[0]).toBeLessThan(
    systemctl.mock.invocationCallOrder.find(
      (_, index) => systemctl.mock.calls[index]?.[0]?.[0] === 'start',
    )!,
  );
});

test('release starts only the system unit and rechallenges the permanent root user inhibitor', async () => {
  const {
    fence,
    systemctl,
    rootUserSystemctl,
    removeMarker,
  } = fixture([
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 9921,
      controlGroup: CONTROL_GROUP,
    }),
  ], {
    markerInitiallyPresent: true,
    listenerPids: [[], [], [9921]],
    rootUserManagers: [
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
      ACTIVE_ROOT_USER_MANAGER,
    ],
    rootUserShows: [
      snapshot({
        activeState: 'active',
        subState: 'running',
        mainPid: 2201,
        controlGroup: ROOT_USER_CONTROL_GROUP,
        rootUser: true,
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
      snapshot({
        activeState: 'inactive',
        subState: 'dead',
        mainPid: 0,
        rootUser: true,
      }),
    ],
  });

  await expect(fence.release(true)).resolves.toMatchObject({
    active: true,
    mainPid: 9921,
    controlGroup: CONTROL_GROUP,
  });
  expect(removeMarker).toHaveBeenCalledTimes(1);
  expect(systemctl).toHaveBeenCalledWith(['start', 'openclaw-gateway.service']);
  expect(rootUserSystemctl).toHaveBeenCalledWith([
    'stop',
    'openclaw-gateway.service',
  ]);
  expect(rootUserSystemctl.mock.calls.filter(
    ([args]) => args[0] === 'start',
  )).toHaveLength(2);
  expect(rootUserSystemctl.mock.invocationCallOrder.at(-1)).toBeLessThan(
    systemctl.mock.invocationCallOrder.find(
      (_, index) => systemctl.mock.calls[index]?.[0]?.[0] === 'start',
    )!,
  );
});

test('repeated release starts an installed inactive unit when the marker is already absent', async () => {
  const { fence, systemctl, removeMarker } = fixture([
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({ activeState: 'inactive', subState: 'dead', mainPid: 0 }),
    snapshot({
      activeState: 'active',
      subState: 'running',
      mainPid: 8122,
      controlGroup: CONTROL_GROUP,
    }),
  ], {
    listenerPids: [[], [], [8122]],
  });

  await expect(fence.release(false)).resolves.toMatchObject({
    active: true,
    mainPid: 8122,
  });
  expect(removeMarker).not.toHaveBeenCalled();
  expect(systemctl).toHaveBeenCalledWith(['start', 'openclaw-gateway.service']);
});

test('repeated release accepts an already-active exact system unit without restarting it', async () => {
  const active = snapshot({
    activeState: 'active',
    subState: 'running',
    mainPid: 8123,
    controlGroup: CONTROL_GROUP,
  });
  const { fence, systemctl, removeMarker } = fixture([active, active], {
    listenerPids: [[8123]],
  });

  await expect(fence.release(true)).resolves.toMatchObject({
    active: true,
    mainPid: 8123,
  });
  expect(removeMarker).not.toHaveBeenCalled();
  expect(systemctl).not.toHaveBeenCalledWith(['start', 'openclaw-gateway.service']);
});

test('assertReleased blocks every automatic restart while the marker exists', async () => {
  const { fence, systemctl } = fixture([], {
    markerInitiallyPresent: true,
  });

  await expect(fence.assertReleased()).rejects.toMatchObject({
    code: 'OPENCLAW_GATEWAY_AUTHORIZATION_FENCE_UNAVAILABLE',
    statusCode: 503,
    retryable: true,
  });
  expect(systemctl).not.toHaveBeenCalled();
});

test('a deliberately absent gateway unit is a valid fenced-empty state', async () => {
  const missing = snapshot({
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    killMode: '',
    mainPid: 0,
    fragmentPath: '',
    dropInPaths: '',
  });
  const { fence, systemctl } = fixture([missing, missing]);

  await expect(fence.stop()).resolves.toMatchObject({
    stopped: true,
    priorActive: false,
    priorMainPid: 0,
    priorControlGroup: null,
    cgroupEmpty: true,
    listenerPort: 18_789,
    listenersAbsent: true,
  });
  expect(systemctl).not.toHaveBeenCalledWith(['stop', 'openclaw-gateway.service']);
});

test('an absent gateway unit fails closed when its expected cgroup remains populated', async () => {
  const missing = snapshot({
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    killMode: '',
    mainPid: 0,
    fragmentPath: '',
    dropInPaths: '',
  });
  const { fence } = fixture([missing, missing], {
    cgroupEvents: 'populated 1\nfrozen 0\n',
  });

  await expect(fence.stop()).rejects.toThrow(
    'durably fenced empty state',
  );
});

test('an absent gateway unit fails closed when the configured port has a listener', async () => {
  const missing = snapshot({
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    killMode: '',
    mainPid: 0,
    fragmentPath: '',
    dropInPaths: '',
  });
  const { fence } = fixture([missing, missing], {
    listenerPids: [[8877]],
  });

  await expect(fence.stop()).rejects.toThrow(
    'durably fenced empty state',
  );
});

test('release keeps a deliberately absent unit absent and is idempotent after marker removal', async () => {
  const missing = snapshot({
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    killMode: '',
    mainPid: 0,
    fragmentPath: '',
    dropInPaths: '',
  });
  const first = fixture([missing, missing], {
    markerInitiallyPresent: true,
    listenerPids: [[], []],
  });

  await expect(first.fence.release(true)).resolves.toMatchObject({
    installed: false,
    active: false,
    mainPid: 0,
  });
  expect(first.removeMarker).toHaveBeenCalledTimes(1);
  expect(first.systemctl).not.toHaveBeenCalledWith([
    'start',
    'openclaw-gateway.service',
  ]);

  const recovery = fixture([missing, missing], {
    listenerPids: [[], []],
  });
  await expect(recovery.fence.release(false)).resolves.toMatchObject({
    installed: false,
    active: false,
    mainPid: 0,
  });
  expect(recovery.removeMarker).not.toHaveBeenCalled();
  expect(recovery.systemctl).not.toHaveBeenCalledWith([
    'start',
    'openclaw-gateway.service',
  ]);
});

test('missing-unit parsing rejects an inconsistent live identity', () => {
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(
    snapshot({
      loadState: 'not-found',
      activeState: 'active',
      subState: 'running',
      mainPid: 8001,
      controlGroup: CONTROL_GROUP,
      fragmentPath: '',
      dropInPaths: '',
    }),
  )).toThrow('absent systemd identity is inconsistent');
});

test('missing-unit parsing rejects a later drop-in that would bypass a future marker', () => {
  expect(() => __openClawGatewayAuthorizationFenceTest.parseSystemctlShow(
    snapshot({
      loadState: 'not-found',
      activeState: 'inactive',
      subState: 'dead',
      killMode: '',
      mainPid: 0,
      fragmentPath: '',
      dropInPaths: [
        __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_DROP_IN,
        '/etc/systemd/system/openclaw-gateway.service.d/99-reset-condition.conf',
      ].join(' '),
    }),
  )).toThrow('authorization fence is not the final effective drop-in');
});

test('listener parser deduplicates IPv4/IPv6 ownership and fails closed without process data', () => {
  expect(__openClawGatewayAuthorizationFenceTest.parseListeningPids([
    'LISTEN 0 511 127.0.0.1:18789 0.0.0.0:* users:(("node",pid=4312,fd=33))',
    'LISTEN 0 511 [::1]:18789 [::]:* users:(("node",pid=4312,fd=34))',
    '',
  ].join('\n'))).toEqual([4312]);
  expect(() => __openClawGatewayAuthorizationFenceTest.parseListeningPids(
    'LISTEN 0 511 127.0.0.1:18789 0.0.0.0:*\n',
  )).toThrow('ownership could not be attested');
});

test('marker inspection recovers the exact hard-kill cut after publication', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openclaw-gateway-fence-marker-'),
  );
  const marker = path.join(
    directory,
    'openclaw-gateway-authorization-fence.v1',
  );
  const temporary = path.join(
    directory,
    `.openclaw-gateway-authorization-fence.${process.pid}.${'a'.repeat(32)}`,
  );
  try {
    fs.writeFileSync(
      temporary,
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
      { mode: 0o600 },
    );
    fs.chmodSync(temporary, 0o600);
    fs.linkSync(temporary, marker);
    const before = fs.lstatSync(marker);
    expect(before.nlink).toBe(2);

    expect(
      __openClawGatewayAuthorizationFenceTest.recoverInterruptedMarkerPublication({
        markerPath: marker,
        expectedContent:
          __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
      }),
    ).toMatchObject({
      device: String(before.dev),
      inode: String(before.ino),
    });
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.lstatSync(marker).nlink).toBe(1);
    expect(fs.readFileSync(marker, 'utf8')).toBe(
      __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('marker hard-kill recovery rejects ambiguous or drifted publication identities', () => {
  for (const scenario of ['unexpected-name', 'wrong-content', 'unsafe-mode'] as const) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-gateway-fence-${scenario}-`),
    );
    const marker = path.join(
      directory,
      'openclaw-gateway-authorization-fence.v1',
    );
    const temporary = path.join(
      directory,
      scenario === 'unexpected-name'
        ? `.openclaw-gateway-authorization-fence.0.${'b'.repeat(32)}`
        : `.openclaw-gateway-authorization-fence.${process.pid}.${'b'.repeat(32)}`,
    );
    try {
      fs.writeFileSync(
        temporary,
        scenario === 'wrong-content'
          ? 'foreign\n'
          : __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
        { mode: scenario === 'unsafe-mode' ? 0o644 : 0o600 },
      );
      fs.chmodSync(temporary, scenario === 'unsafe-mode' ? 0o644 : 0o600);
      fs.linkSync(temporary, marker);
      expect(() => (
        __openClawGatewayAuthorizationFenceTest.recoverInterruptedMarkerPublication({
          markerPath: marker,
          expectedContent:
            __openClawGatewayAuthorizationFenceTest.OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
        })
      )).toThrow();
      expect(fs.lstatSync(marker).nlink).toBe(2);
      expect(fs.existsSync(temporary)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
