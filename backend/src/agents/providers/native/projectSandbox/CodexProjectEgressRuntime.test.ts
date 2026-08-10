import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  derivePreConfinementProjectEgressPolicyFingerprint,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneHandle,
  type ProjectEgressPlaneSpec,
} from '../../../../services/projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../../services/projectEgressPolicy';
import {
  CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
  CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
  PROJECT_RUNTIME_APPARMOR_PROFILE,
  PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
} from '../../../../services/projectRuntimeConfinement';
import {
  CODEX_PROJECT_CONTAINER_CODEX_HOME,
  CODEX_PROJECT_CONTAINER_ROOT,
  CODEX_PROJECT_CONTAINER_USER,
  CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
  CODEX_PROJECT_RUNTIME,
  CODEX_PROJECT_RUNTIME_POLICY_VERSION,
  CodexProjectEgressRuntimeError,
  __codexProjectEgressRuntimeTest,
  attestCodexProjectNamespaceFirewall,
  attestCodexProjectRuntimeContainer,
  buildCodexProjectDockerExecArgs,
  buildCodexProjectRuntimePlan,
  buildPreviousCodexProjectExecutionContext,
  codexProjectDockerHostEnvironment,
  ensureCodexProjectEgressRuntime,
  stopCodexProjectRuntimesForContext,
  stopCodexProjectRuntimesForRecoveryContext,
  type CodexProjectRuntimePlan,
} from './CodexProjectEgressRuntime';

const RUNTIME_IMAGE = `sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `sha256:${'b'.repeat(64)}`;
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789_-';
const PREVIOUS_TOKEN = 'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_-zyxwv';
const PROXY_ADDRESS = '172.31.10.2';
const INTERNAL_NETWORK_ID = '8'.repeat(64);

interface Fixture {
  root: string;
  projectRoot: string;
  stateRoot: string;
  authPath: string;
  profilePath: string;
  context: ProjectSandboxExecutionContext;
  previousContext: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  previousEgress: ProjectEgressPlaneConfig;
  spec: ProjectEgressPlaneSpec;
  previousSpec: ProjectEgressPlaneSpec;
  plan: CodexProjectRuntimePlan;
}

// Mirror of the server-owned context policy fingerprint derivation
// (projectChatKernel + codexProjectPolicyFingerprint). Stale-generation
// reconstruction recomputes this from the inspected image, so fixtures must
// carry the real derivation rather than a placeholder value.
function codexContextPolicyFingerprint(context: {
  userId: string;
  projectId: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  runtimePolicyVersion: string;
  egressPolicyVersion: string;
  runtimeImageDigest: string;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider: 'CODEX',
    runtime: CODEX_PROJECT_RUNTIME,
    runtimeImageDigest: context.runtimeImageDigest,
    actorUserId: context.userId,
    workspaceOwnerId: context.workspaceOwnerId,
    projectId: context.projectId,
    projectName: context.projectName,
    canonicalRoot: context.canonicalRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
  })).digest('hex');
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-egress-test-'));
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const authPath = path.join(stateRoot, 'auth.json');
  const profilePath = path.join(stateRoot, 'portal-project.config.toml');
  fs.writeFileSync(authPath, '{}', { mode: 0o400 });
  fs.writeFileSync(profilePath, 'profile', { mode: 0o400 });
  fs.chownSync(authPath, 1000, 1000);
  fs.chownSync(profilePath, 1000, 1000);
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  const contextSeed = {
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: 'actor-full-uuid',
    projectId: 'project-full-uuid',
    workspaceOwnerId: 'owner-full-uuid',
    projectName: 'demo',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: CODEX_PROJECT_RUNTIME_POLICY_VERSION,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: RUNTIME_IMAGE,
  } as const;
  const context: ProjectSandboxExecutionContext = Object.freeze({
    ...contextSeed,
    policyFingerprint: codexContextPolicyFingerprint(contextSeed),
  });
  const egress: ProjectEgressPlaneConfig = {
    identity: { actorId: context.userId, projectId: context.projectId, provider: 'CODEX' },
    proxyImage: PROXY_IMAGE,
    token: TOKEN,
  };
  const spec = buildProjectEgressPlaneSpec(egress);
  const previousContext = buildPreviousCodexProjectExecutionContext(context);
  const previousEgress: ProjectEgressPlaneConfig = {
    ...egress,
    token: PREVIOUS_TOKEN,
  };
  const previousSpec = buildProjectEgressPlaneSpec(previousEgress);
  const plan = buildCodexProjectRuntimePlan({
    context,
    spec,
    proxyAddress: PROXY_ADDRESS,
    internalNetworkId: INTERNAL_NETWORK_ID,
  });
  return {
    root,
    projectRoot,
    stateRoot,
    authPath,
    profilePath,
    context,
    previousContext,
    egress,
    previousEgress,
    spec,
    previousSpec,
    plan,
  };
}

function inspectFor(fixture: Fixture, running = true): any {
  return {
    Id: 'd'.repeat(64),
    Image: fixture.plan.runtimeImage,
    Name: `/${fixture.plan.containerName}`,
    Config: {
      Image: fixture.plan.runtimeImage,
      User: CODEX_PROJECT_CONTAINER_USER,
      Env: [
        ...Object.entries(fixture.plan.expectedEnvironment).map(([key, value]) => `${key}=${value}`),
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
      Cmd: ['-e', __codexProjectEgressRuntimeTest.IDLE_SCRIPT],
      Entrypoint: ['node'],
      Labels: { ...fixture.plan.expectedLabels },
      WorkingDir: CODEX_PROJECT_CONTAINER_ROOT,
      ExposedPorts: {},
      Volumes: {},
    },
    State: {
      Running: running,
      Pid: running ? 4242 : 0,
      StartedAt: running ? '2026-07-19T12:00:00Z' : '0001-01-01T00:00:00Z',
    },
    HostConfig: {
      Init: true,
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges:true',
        `seccomp=${CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
        `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      ],
      Binds: [`${fixture.projectRoot}:${CODEX_PROJECT_CONTAINER_ROOT}:rw,rprivate`],
      Mounts: [],
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=67108864',
        '/run': 'rw,noexec,nosuid,nodev,size=16777216',
        [CODEX_PROJECT_CONTAINER_CODEX_HOME]: 'rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=0700',
      },
      PortBindings: {},
      PublishAllPorts: false,
      NetworkMode: fixture.plan.networkMode,
      Privileged: false,
      PidMode: '',
      IpcMode: '',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: 'private',
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      OomKillDisable: false,
      PidsLimit: 256,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 1024 },
        { Name: 'nproc', Soft: 256, Hard: 256 },
      ],
      Devices: [],
      DeviceRequests: [],
      DeviceCgroupRules: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: [],
      Links: [],
      VolumesFrom: [],
    },
    AppArmorProfile: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
    Mounts: [{
      Type: 'bind',
      Source: fixture.projectRoot,
      Destination: CODEX_PROJECT_CONTAINER_ROOT,
      Mode: 'rw,rprivate',
      RW: true,
      Propagation: 'rprivate',
    }],
    NetworkSettings: {
      Ports: {},
      Networks: {
        [fixture.spec.internalNetworkName]: {
          IPAddress: '172.31.10.3',
          NetworkID: running ? fixture.plan.internalNetworkId : '',
        },
      },
    },
  };
}

function predecessorFixture(fixture: Fixture): Fixture {
  const previousProxyUrl = `http://portal:${PREVIOUS_TOKEN}@${PROXY_ADDRESS}:3128`;
  return {
    ...fixture,
    context: fixture.previousContext,
    egress: fixture.previousEgress,
    spec: fixture.previousSpec,
    plan: {
      ...fixture.plan,
      expectedEnvironment: Object.freeze({
        ...fixture.plan.expectedEnvironment,
        HTTP_PROXY: previousProxyUrl,
        HTTPS_PROXY: previousProxyUrl,
        http_proxy: previousProxyUrl,
        https_proxy: previousProxyUrl,
      }),
      expectedLabels: Object.freeze({
        ...fixture.plan.expectedLabels,
        [__codexProjectEgressRuntimeTest.constants.RUNTIME_POLICY_LABEL]:
          CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
      }),
    },
  };
}

function legacyPreConfinementFixture(fixture: Fixture): Fixture {
  const predecessor = predecessorFixture(fixture);
  const runtimeFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    provider: 'CODEX',
    actorId: predecessor.context.userId,
    projectId: predecessor.context.projectId,
    workspaceOwnerId: predecessor.context.workspaceOwnerId,
    policyFingerprint: predecessor.context.policyFingerprint,
    runtimePolicyVersion: predecessor.context.runtimePolicyVersion,
    egressPolicyVersion: predecessor.context.egressPolicyVersion,
    egressPolicyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(predecessor.spec),
    runtimeImage: predecessor.plan.runtimeImage,
    projectRoot: predecessor.plan.projectRoot,
    user: CODEX_PROJECT_CONTAINER_USER,
  })).digest('hex');
  return {
    ...predecessor,
    plan: {
      ...predecessor.plan,
      containerName: `p4cx-${runtimeFingerprint.slice(0, 24)}`,
      runtimeFingerprint,
      networkMode: predecessor.spec.internalNetworkName,
      expectedLabels: {
        ...predecessor.plan.expectedLabels,
        [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
        [__codexProjectEgressRuntimeTest.constants.RUNTIME_EGRESS_LABEL]:
          derivePreConfinementProjectEgressPolicyFingerprint(predecessor.spec),
      },
    },
  };
}

function legacyPreConfinementInspect(fixture: Fixture, running = true): any {
  const inspect = inspectFor(legacyPreConfinementFixture(fixture), running);
  inspect.HostConfig.SecurityOpt = ['no-new-privileges:true'];
  inspect.AppArmorProfile = 'docker-default';
  return inspect;
}

function sharedV1NoProxyTokenFixture(fixture: Fixture): Fixture {
  const predecessor = predecessorFixture(fixture);
  const runtimeFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    provider: 'CODEX',
    actorId: predecessor.context.userId,
    projectId: predecessor.context.projectId,
    workspaceOwnerId: predecessor.context.workspaceOwnerId,
    policyFingerprint: predecessor.context.policyFingerprint,
    runtimePolicyVersion: predecessor.context.runtimePolicyVersion,
    egressPolicyVersion: predecessor.context.egressPolicyVersion,
    egressPolicyFingerprint: predecessor.spec.policyFingerprint,
    runtimeImage: predecessor.plan.runtimeImage,
    projectRoot: predecessor.plan.projectRoot,
    user: CODEX_PROJECT_CONTAINER_USER,
    confinementSecurityOptions: [
      'no-new-privileges:true',
      `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
      `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
    ],
  })).digest('hex');
  return {
    ...predecessor,
    plan: {
      ...predecessor.plan,
      containerName: `p4cx-${runtimeFingerprint.slice(0, 24)}`,
      runtimeFingerprint,
      networkMode: predecessor.spec.internalNetworkName,
      expectedLabels: {
        ...predecessor.plan.expectedLabels,
        [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
      },
    },
  };
}

function sharedV1NoProxyTokenInspect(fixture: Fixture, running = true): any {
  const inspect = inspectFor(sharedV1NoProxyTokenFixture(fixture), running);
  inspect.HostConfig.SecurityOpt = [
    'no-new-privileges:true',
    `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
    `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
  ];
  inspect.AppArmorProfile = PROJECT_RUNTIME_APPARMOR_PROFILE;
  return inspect;
}

function sharedV1CurrentFixture(fixture: Fixture): Fixture {
  const predecessor = predecessorFixture(fixture);
  const runtimeFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    provider: 'CODEX',
    actorId: predecessor.context.userId,
    projectId: predecessor.context.projectId,
    workspaceOwnerId: predecessor.context.workspaceOwnerId,
    policyFingerprint: predecessor.context.policyFingerprint,
    runtimePolicyVersion: predecessor.context.runtimePolicyVersion,
    egressPolicyVersion: predecessor.context.egressPolicyVersion,
    egressPolicyFingerprint: predecessor.spec.policyFingerprint,
    egressProxyCredentialHash: predecessor.spec.tokenHash,
    runtimeImage: predecessor.plan.runtimeImage,
    projectRoot: predecessor.plan.projectRoot,
    user: CODEX_PROJECT_CONTAINER_USER,
    confinementSecurityOptions: [
      'no-new-privileges:true',
      `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
      `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
    ],
  })).digest('hex');
  return {
    ...predecessor,
    plan: {
      ...predecessor.plan,
      containerName: `p4cx-${runtimeFingerprint.slice(0, 24)}`,
      runtimeFingerprint,
      expectedLabels: {
        ...predecessor.plan.expectedLabels,
        [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
      },
    },
  };
}

function sharedV1CurrentInspect(fixture: Fixture, running = true): any {
  const inspect = inspectFor(sharedV1CurrentFixture(fixture), running);
  inspect.HostConfig.SecurityOpt = [
    'no-new-privileges:true',
    `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
    `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
  ];
  inspect.AppArmorProfile = PROJECT_RUNTIME_APPARMOR_PROFILE;
  return inspect;
}

function currentNameModeInspect(fixture: Fixture, running: boolean): any {
  const historical = {
    ...fixture,
    plan: {
      ...fixture.plan,
      networkMode: fixture.spec.internalNetworkName,
    },
  };
  const inspect = inspectFor(historical, running);
  inspect.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
    INTERNAL_NETWORK_ID;
  return inspect;
}

function validFirewall(proxyAddress = PROXY_ADDRESS): { ipv4: string; ipv6: string } {
  return {
    ipv4: [
      '-P INPUT DROP',
      '-P FORWARD DROP',
      '-P OUTPUT DROP',
      `-A INPUT -s ${proxyAddress}/32 -p tcp -m tcp --sport 3128 -m conntrack --ctstate ESTABLISHED -j ACCEPT`,
      `-A OUTPUT -d ${proxyAddress}/32 -p tcp -m tcp --dport 3128 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT`,
    ].join('\n'),
    ipv6: ['-P INPUT DROP', '-P FORWARD DROP', '-P OUTPUT DROP'].join('\n'),
  };
}

function validEgressHandle(fixture: Fixture): ProjectEgressPlaneHandle {
  const proxyUrl = `http://portal:${encodeURIComponent(fixture.egress.token)}@${fixture.spec.proxyAlias}:3128`;
  return {
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    policyFingerprint: fixture.spec.policyFingerprint,
    internalNetworkName: fixture.spec.internalNetworkName,
    internalNetworkId: INTERNAL_NETWORK_ID,
    publicNetworkName: fixture.spec.publicNetworkName,
    proxyContainerName: fixture.spec.proxyContainerName,
    proxyUrl,
    proxyEnvironment: Object.freeze({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
    }),
  };
}

function currentNetworkBinding() {
  return Object.freeze({
    networkId: INTERNAL_NETWORK_ID,
    generation: 'CURRENT' as const,
  });
}

describe('Codex Project controlled-egress runtime policy', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test('builds a pinned, non-root, proxy-only runtime with exactly one writable Project bind', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    expect(fixture.plan.createArgs).toEqual(expect.arrayContaining([
      '--network', INTERNAL_NETWORK_ID,
      '--user', CODEX_PROJECT_CONTAINER_USER,
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--security-opt', `seccomp=${CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
      '--security-opt', `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      '--init',
      '--volume', `${fixture.projectRoot}:${CODEX_PROJECT_CONTAINER_ROOT}:rw,rprivate`,
      fixture.plan.runtimeImage,
    ]));
    expect(fixture.plan.createArgs).not.toContain('/usr');
    expect(fixture.plan.createArgs).not.toContain('/etc');
    expect(fixture.plan.createArgs).not.toContain(`seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`);
    expect(fixture.plan.createArgs).not.toContain(`apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`);
    expect(fixture.plan.createArgs.join(' ')).not.toContain('/var/run/docker.sock');
    expect(fixture.plan.expectedEnvironment).toMatchObject({
      HTTP_PROXY: `http://portal:${TOKEN}@${PROXY_ADDRESS}:3128`,
      HTTPS_PROXY: `http://portal:${TOKEN}@${PROXY_ADDRESS}:3128`,
      NO_PROXY: '',
      no_proxy: '',
    });
  });

  test('reconstructs the exact v2 context while preserving the shared proxy plane fingerprint', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const expectedFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      version: CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
      egressPolicyVersion: fixture.context.egressPolicyVersion,
      provider: 'CODEX',
      runtime: CODEX_PROJECT_RUNTIME,
      runtimeImageDigest: fixture.context.runtimeImageDigest,
      actorUserId: fixture.context.userId,
      workspaceOwnerId: fixture.context.workspaceOwnerId,
      projectId: fixture.context.projectId,
      projectName: fixture.context.projectName,
      canonicalRoot: fixture.context.canonicalRoot,
      rootDevice: fixture.context.rootDevice,
      rootInode: fixture.context.rootInode,
      rootBirthtimeNs: fixture.context.rootBirthtimeNs,
    })).digest('hex');
    expect(fixture.previousContext).toEqual({
      ...fixture.context,
      runtimePolicyVersion: CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
      policyFingerprint: expectedFingerprint,
    });
    expect(fixture.previousContext.policyFingerprint).not.toBe(fixture.context.policyFingerprint);
    expect(fixture.previousSpec.policyFingerprint).toBe(fixture.spec.policyFingerprint);
    expect(fixture.previousSpec.identityFingerprint).toBe(fixture.spec.identityFingerprint);
    expect(fixture.previousSpec.tokenHash).not.toBe(fixture.spec.tokenHash);
  });

  test('rotates the immutable generation with the proxy credential without exposing it', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const rotatedEgress = { ...fixture.egress, token: 'Z'.repeat(43) };
    const rotatedSpec = buildProjectEgressPlaneSpec(rotatedEgress);
    const rotated = buildCodexProjectRuntimePlan({
      context: fixture.context,
      spec: rotatedSpec,
      proxyAddress: PROXY_ADDRESS,
    });
    expect(rotated.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    expect(rotated.containerName).not.toBe(fixture.plan.containerName);
    expect(JSON.stringify(rotated.expectedLabels)).not.toContain(rotatedEgress.token);
    expect(rotated.containerName).not.toContain(rotatedEgress.token);
  });

  test('attests the exact stopped and running runtime', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    expect(attestCodexProjectRuntimeContainer({
      inspect: inspectFor(fixture, false), plan: fixture.plan, spec: fixture.spec, requireRunning: false,
    })).toMatchObject({ containerId: 'd'.repeat(64), pid: 0 });
    expect(attestCodexProjectRuntimeContainer({
      inspect: inspectFor(fixture, true), plan: fixture.plan, spec: fixture.spec, requireRunning: true,
    })).toMatchObject({ containerId: 'd'.repeat(64), pid: 4242 });

    const dockerSerializedInspect = inspectFor(fixture, true);
    dockerSerializedInspect.HostConfig.Ulimits = [
      { Name: 'nproc', Hard: 256, Soft: 256 },
      { Name: 'nofile', Hard: 1024, Soft: 1024 },
    ];
    expect(attestCodexProjectRuntimeContainer({
      inspect: dockerSerializedInspect,
      plan: fixture.plan,
      spec: fixture.spec,
      requireRunning: true,
    })).toMatchObject({ containerId: 'd'.repeat(64), pid: 4242 });
  });

  test.each([
    ['image', (value: any) => { value.Image = `sha256:${'e'.repeat(64)}`; }],
    ['root user', (value: any) => { value.Config.User = 'root'; }],
    ['missing init subreaper', (value: any) => { value.HostConfig.Init = false; }],
    ['host process', (value: any) => { value.Config.Cmd = ['sh']; }],
    ['mutable root', (value: any) => { value.HostConfig.ReadonlyRootfs = false; }],
    ['capability', (value: any) => { value.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['missing no-new-privileges', (value: any) => { value.HostConfig.SecurityOpt = []; }],
    ['shared seccomp profile', (value: any) => {
      value.HostConfig.SecurityOpt[1] = `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`;
    }],
    ['shared AppArmor profile', (value: any) => {
      value.HostConfig.SecurityOpt[2] = `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`;
      value.AppArmorProfile = PROJECT_RUNTIME_APPARMOR_PROFILE;
    }],
    ['duplicate seccomp profile', (value: any) => {
      value.HostConfig.SecurityOpt.push(`seccomp=${CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`);
    }],
    ['wrong AppArmor profile', (value: any) => { value.AppArmorProfile = 'docker-default'; }],
    ['host namespace', (value: any) => { value.HostConfig.PidMode = 'host'; }],
    ['container namespace join', (value: any) => { value.HostConfig.IpcMode = `container:${'f'.repeat(64)}`; }],
    ['extra capability drop', (value: any) => { value.HostConfig.CapDrop = ['ALL', 'SYS_ADMIN']; }],
    ['restart policy', (value: any) => { value.HostConfig.RestartPolicy.Name = 'always'; }],
    ['resource limit', (value: any) => { value.HostConfig.Memory = 0; }],
    ['weak tmpfs', (value: any) => { value.HostConfig.Tmpfs['/tmp'] = 'rw'; }],
    ['conflicting tmpfs flag', (value: any) => { value.HostConfig.Tmpfs['/tmp'] += ',exec'; }],
    ['device', (value: any) => { value.HostConfig.Devices = [{}]; }],
    ['published port', (value: any) => { value.HostConfig.PortBindings = { '80/tcp': [{}] }; }],
    ['host DNS', (value: any) => { value.HostConfig.Dns = ['8.8.8.8']; }],
    ['sibling mount', (value: any) => { value.Mounts.push({ Type: 'bind', Source: '/other', Destination: '/other', RW: true }); }],
    ['read-only Project', (value: any) => { value.Mounts[0].RW = false; }],
    ['host network', (value: any) => { value.HostConfig.NetworkMode = 'host'; }],
    ['container network mode', (value: any) => { value.HostConfig.NetworkMode = `container:${'f'.repeat(64)}`; }],
    ['lateral network', (value: any) => { value.NetworkSettings.Networks.bridge = {}; }],
    ['missing proxy', (value: any) => { value.Config.Env = value.Config.Env.filter((item: string) => !item.startsWith('HTTPS_PROXY=')); }],
    ['NO_PROXY bypass', (value: any) => {
      value.Config.Env = value.Config.Env.map((item: string) => item === 'NO_PROXY=' ? 'NO_PROXY=localhost' : item);
    }],
    ['host credential', (value: any) => { value.Config.Env.push('AWS_SECRET_ACCESS_KEY=secret'); }],
    ['runtime label', (value: any) => { value.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = 'wrong'; }],
  ])('fails closed for runtime drift: %s', (_label, mutate) => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const inspect = inspectFor(fixture, true);
    mutate(inspect);
    expect(() => attestCodexProjectRuntimeContainer({
      inspect, plan: fixture.plan, spec: fixture.spec, requireRunning: true,
    })).toThrow(CodexProjectEgressRuntimeError);
  });

  test('requires an exact namespace firewall that permits only the proxy and drops IPv6', () => {
    const firewall = validFirewall();
    expect(() => attestCodexProjectNamespaceFirewall({ proxyAddress: PROXY_ADDRESS, ...firewall })).not.toThrow();
    expect(() => attestCodexProjectNamespaceFirewall({
      proxyAddress: PROXY_ADDRESS,
      ...firewall,
      ipv4: `${firewall.ipv4}\n-A OUTPUT -d 169.254.169.254/32 -j ACCEPT`,
    })).toThrow('IPv4 namespace firewall');
    expect(() => attestCodexProjectNamespaceFirewall({
      proxyAddress: PROXY_ADDRESS,
      ...firewall,
      ipv6: '-P INPUT ACCEPT\n-P FORWARD DROP\n-P OUTPUT DROP',
    })).toThrow('IPv6 namespace firewall');
  });

  test('builds docker exec with the full immutable ID and exact proxy variables, never inherited host proxy state', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const runtime = {
      containerId: 'd'.repeat(64),
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
      egressPolicyFingerprint: fixture.spec.policyFingerprint,
      proxyAddress: PROXY_ADDRESS,
      proxyEnvironment: Object.freeze({
        HTTP_PROXY: 'http://portal:token@172.31.10.2:3128',
        HTTPS_PROXY: 'http://portal:token@172.31.10.2:3128',
        http_proxy: 'http://portal:token@172.31.10.2:3128',
        https_proxy: 'http://portal:token@172.31.10.2:3128',
        NO_PROXY: '',
        no_proxy: '',
      }),
      startedAt: '2026-07-19T12:00:00Z',
    };
    const args = buildCodexProjectDockerExecArgs({ runtime, command: '/usr/bin/codex', args: ['--version'] });
    expect(args).toEqual(expect.arrayContaining([
      'container', 'exec', '--user', CODEX_PROJECT_CONTAINER_USER,
      '--workdir', CODEX_PROJECT_CONTAINER_ROOT, runtime.containerId, '/usr/bin/codex', '--version',
    ]));
    expect(args.join(' ')).not.toContain('localhost');
    expect(args.join(' ')).not.toContain('host.docker.internal');
    expect(codexProjectDockerHostEnvironment()).toEqual({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/nonexistent',
      DOCKER_CONFIG: '/nonexistent',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    });
  });
});

class RuntimeExecutor implements ProjectEgressCommandExecutor {
  readonly commands: Array<{ command: string; args: readonly string[] }> = [];
  readonly staleRuntimes = new Map<string, any>();
  readonly fixture: Fixture;
  exists = false;
  running = false;
  foreignCurrent: any | null = null;

  constructor(fixture: Fixture) {
    this.fixture = fixture;
  }

  addStaleRuntime(inspect: any): void {
    this.staleRuntimes.set(String(inspect.Id || '').toLowerCase(), inspect);
  }

  private staleRuntime(reference: string): any | null {
    return this.staleRuntimes.get(reference.toLowerCase())
      || [...this.staleRuntimes.values()].find((inspect) => (
        String(inspect.Name || '').replace(/^\//, '') === reference
      ))
      || null;
  }

  async run(command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> {
    this.commands.push({ command, args });
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      const ids = [
        ...(this.exists ? ['d'.repeat(64)] : []),
        ...this.staleRuntimes.keys(),
      ].sort();
      return { stdout: ids.join('\n'), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      const name = String(args[2]);
      if (name === this.fixture.spec.proxyContainerName) {
        return {
          stdout: JSON.stringify([{
            Id: 'f'.repeat(64),
            NetworkSettings: {
              Networks: { [this.fixture.spec.internalNetworkName]: { IPAddress: PROXY_ADDRESS } },
            },
          }]),
          stderr: '',
          exitCode: 0,
        };
      }
      const stale = this.staleRuntime(name);
      if (stale) return { stdout: JSON.stringify([stale]), stderr: '', exitCode: 0 };
      if (this.foreignCurrent && name === this.fixture.plan.containerName) {
        return { stdout: JSON.stringify([this.foreignCurrent]), stderr: '', exitCode: 0 };
      }
      const current = name === this.fixture.plan.containerName || name === 'd'.repeat(64);
      if (!this.exists || !current) {
        return {
          stdout: '',
          stderr: `Error response from daemon: No such container: ${name}`,
          exitCode: 1,
        };
      }
      return { stdout: JSON.stringify([inspectFor(this.fixture, this.running)]), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
      this.exists = true;
      return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'start') {
      const stale = this.staleRuntime(String(args.at(-1)));
      if (stale) stale.State.Running = true;
      else this.running = true;
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
      const stale = this.staleRuntime(String(args.at(-1)));
      if (stale) {
        stale.State.Running = false;
        stale.State.Pid = 0;
      } else {
        this.running = false;
      }
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
      const stale = this.staleRuntime(String(args.at(-1)));
      if (stale) this.staleRuntimes.delete(String(stale.Id || '').toLowerCase());
    }
    if (command === '/usr/bin/nsenter' && args.includes('-S')) {
      const tool = String(args[4]);
      const firewall = validFirewall();
      return { stdout: tool === 'iptables' ? firewall.ipv4 : firewall.ipv6, stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'exec' && args.includes('node')) {
      const expected = [
        { path: `${CODEX_PROJECT_CONTAINER_CODEX_HOME}/auth.json`, source: this.fixture.authPath },
        { path: `${CODEX_PROJECT_CONTAINER_CODEX_HOME}/${path.basename(this.fixture.profilePath)}`, source: this.fixture.profilePath },
      ];
      return {
        stdout: JSON.stringify(expected.map((entry) => ({
          path: entry.path,
          hash: crypto.createHash('sha256').update(fs.readFileSync(entry.source)).digest('hex'),
          uid: 1000,
          gid: 1000,
          mode: 0o400,
          file: true,
          symlink: false,
        }))),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

describe('Codex Project controlled-egress orchestration', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  test('attests egress, creates stopped, constrains, starts, firewalls, injects state, and reattests', async () => {
    const executor = new RuntimeExecutor(fixture);
    const constrainRuntime = jest.fn(async () => undefined);
    const handle = await ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => ({
        policyVersion: PROJECT_EGRESS_POLICY_VERSION,
        policyFingerprint: fixture.spec.policyFingerprint,
        internalNetworkName: fixture.spec.internalNetworkName,
        internalNetworkId: INTERNAL_NETWORK_ID,
        publicNetworkName: fixture.spec.publicNetworkName,
        proxyContainerName: fixture.spec.proxyContainerName,
        proxyUrl: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
        proxyEnvironment: Object.freeze({
          HTTP_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          HTTPS_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          http_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          https_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          NO_PROXY: '',
          no_proxy: '',
        }),
      })),
      constrainRuntime,
    });
    expect(handle.containerId).toBe('d'.repeat(64));
    expect(handle.proxyEnvironment).toMatchObject({
      HTTP_PROXY: `http://portal:${TOKEN}@${PROXY_ADDRESS}:3128`,
      NO_PROXY: '',
    });
    expect(constrainRuntime).toHaveBeenCalledWith(expect.objectContaining({
      runtimeContainerName: fixture.plan.containerName,
      expectedRuntimeFingerprint: fixture.plan.runtimeFingerprint,
      executor,
    }));
    const createIndex = executor.commands.findIndex(({ args }) => args[1] === 'create');
    const startIndex = executor.commands.findIndex(({ args }) => args[1] === 'start');
    const firewallIndex = executor.commands.findIndex(({ command }) => command === '/usr/bin/nsenter');
    const injectionIndex = executor.commands.findIndex(({ args }) => (
      args[1] === 'exec' && args.includes('--interactive')
    ));
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(createIndex);
    expect(firewallIndex).toBeGreaterThan(startIndex);
    expect(injectionIndex).toBeGreaterThan(firewallIndex);
    expect(executor.commands.some(({ args }) => args[1] === 'cp')).toBe(false);
  });

  test('retires the exact legacy pre-confinement runtime before stale-network convergence', async () => {
    const executor = new RuntimeExecutor(fixture);
    const stale = legacyPreConfinementInspect(fixture, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const ensureEgressPlane = jest.fn(async () => {
      expect(executor.staleRuntimes.size).toBe(0);
      return validEgressHandle(fixture);
    });
    const retirePreviousManagedState = jest.fn((context: ProjectSandboxExecutionContext) => {
      expect(context).toEqual(fixture.previousContext);
      expect(executor.staleRuntimes.size).toBe(0);
      const lastInventory = executor.commands.map(({ args }) => (
        args[0] === 'container' && args[1] === 'ls'
      )).lastIndexOf(true);
      const removal = executor.commands.findIndex(({ args }) => (
        args[0] === 'container' && args[1] === 'rm'
      ));
      expect(lastInventory).toBeGreaterThan(removal);
    });

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
    })).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    const stopIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ));
    const removeIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ));
    const createIndex = executor.commands.findIndex(({ args }) => args[1] === 'create');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stopIndex);
    expect(createIndex).toBeGreaterThan(removeIndex);
    expect(retirePreviousManagedState).toHaveBeenCalledTimes(1);
  });

  function ensureWithDefaults(executor: RuntimeExecutor) {
    return ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => validEgressHandle(fixture)),
      constrainRuntime: jest.fn(async () => undefined),
    });
  }

  function imageVariantFixture(base: Fixture, runtimeImageDigest: string): Fixture {
    const seed = { ...base.context, runtimeImageDigest };
    const context: ProjectSandboxExecutionContext = Object.freeze({
      ...seed,
      policyFingerprint: codexContextPolicyFingerprint(seed),
    });
    return {
      ...base,
      context,
      plan: buildCodexProjectRuntimePlan({
        context,
        spec: base.spec,
        proxyAddress: PROXY_ADDRESS,
        internalNetworkId: INTERNAL_NETWORK_ID,
      }),
    };
  }

  test('retires a stale runtime created from a since-rebuilt sandbox image', async () => {
    const executor = new RuntimeExecutor(fixture);
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    expect(rebuiltAway.plan.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    const stale = inspectFor(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    await expect(ensureWithDefaults(executor)).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    const stopIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ));
    const removeIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ));
    const createIndex = executor.commands.findIndex(({ args }) => args[1] === 'create');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stopIndex);
    expect(createIndex).toBeGreaterThan(removeIndex);
    expect(executor.staleRuntimes.size).toBe(0);
  });

  test('fails closed when a stale runtime reports inconsistent image identities', async () => {
    const executor = new RuntimeExecutor(fixture);
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    const stale = inspectFor(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    stale.Image = `sha256:${'8'.repeat(64)}`;
    executor.addStaleRuntime(stale);
    await expect(ensureWithDefaults(executor))
      .rejects.toThrow('Managed Codex Project stale runtime image did not match');
    expect(executor.staleRuntimes.size).toBe(1);
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('fails closed when a stale runtime image was swapped after creation', async () => {
    const executor = new RuntimeExecutor(fixture);
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    const stale = inspectFor(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    // The fingerprint label commits to the creation image; a different
    // inspected image must not reconstruct any recognized generation.
    stale.Image = `sha256:${'8'.repeat(64)}`;
    stale.Config.Image = stale.Image;
    executor.addStaleRuntime(stale);
    await expect(ensureWithDefaults(executor))
      .rejects.toThrow('Managed Codex Project runtime is not an exact recognized prior generation');
    expect(executor.staleRuntimes.size).toBe(1);
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('never silently retires a current-fingerprint runtime that fails exact attestation', async () => {
    const executor = new RuntimeExecutor(fixture);
    const corrupt = inspectFor(fixture, true);
    corrupt.Id = 'e'.repeat(64);
    corrupt.Config.Env.push('AWS_SECRET_ACCESS_KEY=secret');
    executor.addStaleRuntime(corrupt);
    await expect(ensureWithDefaults(executor)).rejects.toThrow(CodexProjectEgressRuntimeError);
    expect(executor.staleRuntimes.size).toBe(1);
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('retires the exact shared-v1 no-proxy-token generation once before convergence', async () => {
    const executor = new RuntimeExecutor(fixture);
    const staleFixture = sharedV1NoProxyTokenFixture(fixture);
    expect(staleFixture.plan.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    expect(staleFixture.spec.policyFingerprint).toBe(fixture.spec.policyFingerprint);
    const stale = sharedV1NoProxyTokenInspect(fixture, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const ensureEgressPlane = jest.fn(async () => {
      expect(executor.staleRuntimes.size).toBe(0);
      return validEgressHandle(fixture);
    });
    const dependencies = {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
    };
    const input = {
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({
        authPath: fixture.authPath,
        profilePath: fixture.profilePath,
      }),
    };

    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    const removeIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args[2] === 'e'.repeat(64)
    ));
    const ensureIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ));
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(ensureIndex).toBeGreaterThan(removeIndex);
    expect(executor.commands.filter(({ args }) => args[1] === 'rm')).toHaveLength(1);
  });

  test.each([
    ['running', true],
    ['stopped', false],
  ])('retires the exact %s shared-v1 predecessor once and remains idempotent', async (
    _state,
    running,
  ) => {
    const executor = new RuntimeExecutor(fixture);
    const predecessor = sharedV1CurrentFixture(fixture);
    expect(predecessor.plan.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    const stale = sharedV1CurrentInspect(fixture, running);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const ensureEgressPlane = jest.fn(async () => {
      expect(executor.staleRuntimes.size).toBe(0);
      return validEgressHandle(fixture);
    });
    const dependencies = {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
    };
    const input = {
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({
        authPath: fixture.authPath,
        profilePath: fixture.profilePath,
      }),
    };

    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(running ? 1 : 0);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(1);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ))).toHaveLength(1);
  });

  test('does not mutate a shared-v1 fingerprint with Codex-profile substitution', async () => {
    const executor = new RuntimeExecutor(fixture);
    const counterfeit = sharedV1CurrentInspect(fixture, true);
    counterfeit.Id = 'e'.repeat(64);
    counterfeit.HostConfig.SecurityOpt = [
      'no-new-privileges:true',
      `seccomp=${CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
      `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
    ];
    counterfeit.AppArmorProfile = CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE;
    executor.addStaleRuntime(counterfeit);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({
        authPath: fixture.authPath,
        profilePath: fixture.profilePath,
      }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'RUNTIME_CONFINEMENT' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test.each([
    ['running', true],
    ['stopped', false],
  ])('migrates an exact %s current-fingerprint name-mode runtime once and remains idempotent', async (
    _state,
    running,
  ) => {
    const executor = new RuntimeExecutor(fixture);
    const stale = currentNameModeInspect(fixture, running);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const dependencies = {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => validEgressHandle(fixture)),
      constrainRuntime: jest.fn(async () => undefined),
    };
    const input = {
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({
        authPath: fixture.authPath,
        profilePath: fixture.profilePath,
      }),
    };

    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(1);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ))).toHaveLength(1);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(running ? 1 : 0);
  });

  test('does not mutate a current-fingerprint name-mode runtime bound to another network ID', async () => {
    const executor = new RuntimeExecutor(fixture);
    const counterfeit = currentNameModeInspect(fixture, true);
    counterfeit.Id = 'e'.repeat(64);
    counterfeit.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
      'f'.repeat(64);
    executor.addStaleRuntime(counterfeit);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({
        authPath: fixture.authPath,
        profilePath: fixture.profilePath,
      }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'RUNTIME_NETWORK' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('retires an inspected prior proxy-credential generation once and remains idempotent', async () => {
    const previous = fixture;
    const rotatedEgress = { ...previous.egress, token: 'Z'.repeat(43) };
    const rotatedSpec = buildProjectEgressPlaneSpec(rotatedEgress);
    const rotatedPlan = buildCodexProjectRuntimePlan({
      context: previous.context,
      spec: rotatedSpec,
      proxyAddress: PROXY_ADDRESS,
      internalNetworkId: INTERNAL_NETWORK_ID,
    });
    fixture = {
      ...previous,
      egress: rotatedEgress,
      spec: rotatedSpec,
      plan: rotatedPlan,
    };
    const executor = new RuntimeExecutor(fixture);
    const stale = inspectFor(previous, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const dependencies = {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => validEgressHandle(fixture)),
      constrainRuntime: jest.fn(async () => undefined),
    };
    const input = {
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({
        authPath: fixture.authPath,
        profilePath: fixture.profilePath,
      }),
    };

    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerName: rotatedPlan.containerName,
      runtimeFingerprint: rotatedPlan.runtimeFingerprint,
    });
    await expect(ensureCodexProjectEgressRuntime(input, dependencies)).resolves.toMatchObject({
      containerName: rotatedPlan.containerName,
      runtimeFingerprint: rotatedPlan.runtimeFingerprint,
    });
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args[2] === 'e'.repeat(64)
    ))).toHaveLength(1);
    expect(executor.staleRuntimes.size).toBe(0);
  });

  test('does not mutate a legacy pre-confinement runtime whose Project mount drifted', async () => {
    const executor = new RuntimeExecutor(fixture);
    const stale = legacyPreConfinementInspect(fixture, true);
    stale.Id = 'e'.repeat(64);
    stale.Mounts[0].Source = path.join(fixture.root, 'other-project');
    executor.addStaleRuntime(stale);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'RUNTIME_MOUNTS' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1]))))
      .toBe(false);
  });

  test.each([
    ['container namespace join', (value: any) => {
      value.HostConfig.PidMode = `container:${'f'.repeat(64)}`;
    }],
    ['conflicting tmpfs', (value: any) => {
      value.HostConfig.Tmpfs['/tmp'] += ',exec';
    }],
  ])('does not mutate a legacy pre-confinement runtime with hostile %s', async (_label, mutate) => {
    const executor = new RuntimeExecutor(fixture);
    const stale = legacyPreConfinementInspect(fixture, true);
    stale.Id = 'e'.repeat(64);
    mutate(stale);
    executor.addStaleRuntime(stale);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
    })).rejects.toBeInstanceOf(CodexProjectEgressRuntimeError);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1]))))
      .toBe(false);
  });

  test.each([
    ['exact first', 'e', 'f'],
    ['counterfeit first', 'f', 'e'],
  ])('preflights the complete %s mixed stale inventory before mutation', async (
    _label,
    exactPrefix,
    counterfeitPrefix,
  ) => {
    const executor = new RuntimeExecutor(fixture);
    const exact = legacyPreConfinementInspect(fixture, true);
    exact.Id = exactPrefix.repeat(64);
    const counterfeit = legacyPreConfinementInspect(fixture, true);
    counterfeit.Id = counterfeitPrefix.repeat(64);
    counterfeit.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = '8'.repeat(64);
    counterfeit.Name = `/p4cx-${'8'.repeat(24)}`;
    executor.addStaleRuntime(exact);
    executor.addStaleRuntime(counterfeit);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
    })).rejects.toBeInstanceOf(CodexProjectEgressRuntimeError);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1]))))
      .toBe(false);
    expect(executor.staleRuntimes.has(exact.Id)).toBe(true);
  });

  test('does not retire an exact stale runtime when a counterfeit claims the current identity', async () => {
    const executor = new RuntimeExecutor(fixture);
    const exact = legacyPreConfinementInspect(fixture, true);
    exact.Id = 'e'.repeat(64);
    const counterfeitCurrent = inspectFor(fixture, true);
    counterfeitCurrent.Id = 'f'.repeat(64);
    counterfeitCurrent.HostConfig.Privileged = true;
    executor.addStaleRuntime(exact);
    executor.addStaleRuntime(counterfeitCurrent);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
    })).rejects.toBeInstanceOf(CodexProjectEgressRuntimeError);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1]))))
      .toBe(false);
    expect(executor.staleRuntimes.has(exact.Id)).toBe(true);
  });

  test('rejects an arbitrary label-declared stale generation before mutation', async () => {
    const executor = new RuntimeExecutor(fixture);
    const stale = legacyPreConfinementInspect(fixture, true);
    const arbitrary = '8'.repeat(64);
    stale.Id = 'e'.repeat(64);
    stale.Name = `/p4cx-${arbitrary.slice(0, 24)}`;
    stale.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = arbitrary;
    executor.addStaleRuntime(stale);
    const ensureEgressPlane = jest.fn(async () => validEgressHandle(fixture));

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_GENERATION' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1]))))
      .toBe(false);
  });

  test('does not remove a same-name replacement after immutable stale stop', async () => {
    const executor = new RuntimeExecutor(fixture);
    const stale = legacyPreConfinementInspect(fixture, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const originalRun = executor.run.bind(executor);
    let replacement: any = null;
    executor.run = async (command, args) => {
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'stop'
        && args.at(-1) === 'e'.repeat(64)) {
        executor.staleRuntimes.delete('e'.repeat(64));
        replacement = legacyPreConfinementInspect(fixture, false);
        replacement.Id = 'f'.repeat(64);
        replacement.HostConfig.Privileged = true;
        executor.addStaleRuntime(replacement);
      }
      return result;
    };

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => validEgressHandle(fixture)),
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_RACE' });
    expect(executor.staleRuntimes.get('f'.repeat(64))).toBe(replacement);
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('never mutates a foreign occupant of the desired runtime name', async () => {
    const executor = new RuntimeExecutor(fixture);
    const foreign = inspectFor(fixture, true);
    foreign.Id = 'f'.repeat(64);
    foreign.Config.Labels['com.bridgesllm.codex-project.actor'] = '9'.repeat(64);
    executor.foreignCurrent = foreign;

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => validEgressHandle(fixture)),
    })).rejects.toMatchObject({ code: 'RUNTIME_LABELS' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'start'].includes(String(args[1]))
    ))).toBe(false);
    expect(executor.foreignCurrent).toBe(foreign);
  });

  test('never mutates a same-name substitute returned after current runtime creation', async () => {
    const executor = new RuntimeExecutor(fixture);
    const replacement = inspectFor(fixture, false);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    let created = false;
    executor.run = async (command, args) => {
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
        created = true;
      }
      if (created && command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && String(args[2]) === 'd'.repeat(64)) {
        return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
      }
      return result;
    };
    const constrainRuntime = jest.fn(async () => undefined);

    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => validEgressHandle(fixture)),
      constrainRuntime,
    })).rejects.toBeInstanceOf(CodexProjectEgressRuntimeError);
    expect(constrainRuntime).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('stops and fails closed when runtime drift is found before a turn', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && [fixture.plan.containerName, 'd'.repeat(64)].includes(String(args[2]))
        && !executor.running) {
        const inspect = inspectFor(fixture, false);
        inspect.NetworkSettings.Networks.bridge = {};
        return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
      }
      return result;
    };
    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: fixture.egress,
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      buildPreviousEgressConfig: () => fixture.previousEgress,
      resolveInternalNetworkBinding: jest.fn(async () => currentNetworkBinding()),
      ensureEgressPlane: jest.fn(async () => ({
        policyVersion: PROJECT_EGRESS_POLICY_VERSION,
        policyFingerprint: fixture.spec.policyFingerprint,
        internalNetworkName: fixture.spec.internalNetworkName,
        internalNetworkId: INTERNAL_NETWORK_ID,
        publicNetworkName: fixture.spec.publicNetworkName,
        proxyContainerName: fixture.spec.proxyContainerName,
        proxyUrl: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
        proxyEnvironment: {
          HTTP_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          HTTPS_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          http_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          https_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          NO_PROXY: '',
          no_proxy: '',
        },
      })),
      constrainRuntime: jest.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'RUNTIME_NETWORK' });
    expect(executor.running).toBe(false);
  });

  test('discovers and proves stop of only the exact actor/project Codex runtime', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
      }
      return originalRun(command, args);
    };

    await expect(stopCodexProjectRuntimesForContext(fixture.context, executor))
      .resolves.toEqual(['d'.repeat(64)]);
    expect(executor.running).toBe(false);
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'd'.repeat(64)
    ))).toBe(true);
    const listCall = executor.commands.find(({ args }) => args[0] === 'container' && args[1] === 'ls');
    expect(listCall?.args.join('\n')).toContain(`label=com.bridgesllm.codex-project.actor=${fixture.plan.expectedLabels['com.bridgesllm.codex-project.actor']}`);
    expect(listCall?.args.join('\n')).toContain(`label=com.bridgesllm.codex-project.project=${fixture.plan.expectedLabels['com.bridgesllm.codex-project.project']}`);
    expect(listCall?.args.join('\n')).not.toContain('label=com.bridgesllm.codex-project.policy=');
  });

  test('stops an exact persisted Codex generation after policy and image drift', async () => {
    const historicalSeed = {
      ...fixture.context,
      runtimePolicyVersion: CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
      runtimeImageDigest: `sha256:${'9'.repeat(64)}`,
    };
    const historicalContext: ProjectSandboxExecutionContext = Object.freeze({
      ...historicalSeed,
      policyFingerprint: codexContextPolicyFingerprint(historicalSeed),
    });
    const historicalFixture: Fixture = {
      ...fixture,
      context: historicalContext,
      plan: {
        ...fixture.plan,
        runtimeImage: historicalContext.runtimeImageDigest,
        expectedLabels: {
          ...fixture.plan.expectedLabels,
          [__codexProjectEgressRuntimeTest.constants.RUNTIME_POLICY_LABEL]: historicalContext.runtimePolicyVersion,
        },
      },
    };
    const executor = new RuntimeExecutor(historicalFixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
      }
      return originalRun(command, args);
    };

    await expect(stopCodexProjectRuntimesForRecoveryContext(historicalContext, executor))
      .resolves.toEqual(['d'.repeat(64)]);
    expect(executor.running).toBe(false);
  });

  test('pre-attests the full Codex inventory before stopping any mixed generation', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const firstId = 'd'.repeat(64);
    const secondId = 'e'.repeat(64);
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${firstId}\n${secondId}\n`, stderr: '', exitCode: 0 };
      }
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        const inspect = inspectFor(fixture, true);
        inspect.Id = args[2];
        if (args[2] === secondId) {
          inspect.Config.Labels[__codexProjectEgressRuntimeTest.constants.RUNTIME_POLICY_LABEL]
            = CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION;
        }
        return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
      }
      return originalRun(command, args);
    };

    await expect(stopCodexProjectRuntimesForContext(fixture.context, executor))
      .rejects.toMatchObject({ code: 'RUNTIME_STOP_IDENTITY' });
    expect(executor.commands.some(({ args }) => args[0] === 'container' && args[1] === 'stop'))
      .toBe(false);
  });

  test('refuses a label-matched runtime whose Project mount drifted before stop', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
      }
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect' && args[2] === 'd'.repeat(64)) {
        const inspect = inspectFor(fixture, true);
        inspect.Mounts[0].Source = path.join(fixture.root, 'other-project');
        return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
      }
      return result;
    };

    await expect(stopCodexProjectRuntimesForContext(fixture.context, executor))
      .rejects.toMatchObject({ code: 'RUNTIME_MOUNTS' });
    expect(executor.commands.some(({ args }) => args[0] === 'container' && args[1] === 'stop')).toBe(false);
  });

  test('does not treat an ambiguous Docker inspect failure as Codex runtime absence', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
      }
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        await originalRun(command, args);
        return {
          stdout: '',
          stderr: 'Cannot connect to the Docker daemon',
          exitCode: 1,
        };
      }
      return originalRun(command, args);
    };

    await expect(stopCodexProjectRuntimesForContext(fixture.context, executor))
      .rejects.toMatchObject({ code: 'RUNTIME_INSPECT_FAILED' });
    expect(executor.commands.some(({ args }) => args[0] === 'container' && args[1] === 'stop'))
      .toBe(false);
  });

  test('refuses an ambiguous Codex running state before stop', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
      }
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && args[2] === 'd'.repeat(64)) {
        const inspect = inspectFor(fixture, true);
        inspect.State.Running = 'true';
        return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
      }
      return result;
    };

    await expect(stopCodexProjectRuntimesForContext(fixture.context, executor))
      .rejects.toMatchObject({ code: 'RUNTIME_STOP_UNCONFIRMED' });
    expect(executor.commands.some(({ args }) => args[0] === 'container' && args[1] === 'stop'))
      .toBe(false);
  });

  test('refuses an ambiguous Codex running state after stop', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const originalRun = executor.run.bind(executor);
    let runtimeInspectCount = 0;
    executor.run = async (command, args) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'container ls -a') {
        await originalRun(command, args);
        return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
      }
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && args[2] === 'd'.repeat(64)) {
        runtimeInspectCount += 1;
        if (runtimeInspectCount === 2) {
          const inspect = inspectFor(fixture, false);
          delete inspect.State.Running;
          return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
        }
      }
      return result;
    };

    await expect(stopCodexProjectRuntimesForContext(fixture.context, executor))
      .rejects.toMatchObject({ code: 'RUNTIME_STOP_UNCONFIRMED' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'd'.repeat(64)
    ))).toBe(true);
  });

  test.each([
    ['wrong actor', (value: Fixture) => ({ ...value.egress, identity: { ...value.egress.identity, actorId: 'other' } })],
    ['wrong project', (value: Fixture) => ({ ...value.egress, identity: { ...value.egress.identity, projectId: 'other' } })],
    ['wrong provider', (value: Fixture) => ({ ...value.egress, identity: { ...value.egress.identity, provider: 'OPENCLAW' } })],
  ])('rejects %s egress identity before creating a runtime', async (_label, mutate) => {
    const executor = new RuntimeExecutor(fixture);
    await expect(ensureCodexProjectEgressRuntime({
      context: fixture.context,
      egress: mutate(fixture),
      retirePreviousManagedState: () => undefined,
      prepareManagedState: () => ({ authPath: fixture.authPath, profilePath: fixture.profilePath }),
    }, { executor })).rejects.toMatchObject({ code: 'EGRESS_IDENTITY' });
    expect(executor.exists).toBe(false);
  });
});
