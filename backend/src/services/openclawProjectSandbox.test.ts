// This suite attests filesystem/container policy through its executor; it does not query a database.
jest.mock('../config/database', () => ({ prisma: {} }));
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import { attestProjectRoot } from './projectIdentity';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  derivePreConfinementProjectEgressPolicyFingerprint,
  type ProjectEgressCommandExecutor,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneHandle,
  type ProjectEgressPlaneSpec,
} from './projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from './projectEgressPolicy';
import { computeOpenClaw92SandboxConfigHash, resolveOpenClawWorkspaceQualifiedRuntime } from './openclawWorkspaceQualifiedIdentity';
import {
  OPENCLAW_PROJECT_KERNEL_RUNTIME,
  OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION,
  OPENCLAW_PROJECT_ACTOR_LABEL,
  OPENCLAW_PROJECT_IDENTITY_LABEL,
  OPENCLAW_PROJECT_AGENT_LABEL,
  OpenClawProjectSandboxError,
  __openClawProjectSandboxTest,
  attestOpenClawProjectContainer,
  buildOpenClawProjectSandboxPlan,
  buildOpenClawProjectSandboxPlanForRuntime,
  computeOpenClawProjectConfigHash,
  deriveOpenClawProjectAgentId,
  deriveOpenClawProjectSessionKey,
  ensureOpenClawProjectSandbox,
  hashOpenClawProjectLabelIdentity,
  slugifyOpenClawProjectSessionKey,
  type OpenClawProjectSandboxPlan,
} from './openclawProjectSandbox';

const RUNTIME_IMAGE = `sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `sha256:${'c'.repeat(64)}`;
const ACTOR_ID = 'actor-user-id';
const PROJECT_ID = 'immutable-project-uuid';
const AGENT_ID = deriveOpenClawProjectAgentId({ userId: ACTOR_ID, projectId: PROJECT_ID });
const SESSION_KEY = deriveOpenClawProjectSessionKey({ userId: ACTOR_ID, projectId: PROJECT_ID });

interface Fixture {
  tempRoot: string;
  projectRoot: string;
  openClawHome: string;
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  spec: ProjectEgressPlaneSpec;
  handle: ProjectEgressPlaneHandle;
  plan: OpenClawProjectSandboxPlan;
}

const tempRoots: string[] = [];

// Mirror of the kernel-owned context policy fingerprint derivation; stale
// reconstruction recomputes this from the inspected image, so fixtures must
// carry the real derivation rather than a placeholder value.
function kernelContextPolicyFingerprint(context: {
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
    provider: 'OPENCLAW',
    runtime: OPENCLAW_PROJECT_KERNEL_RUNTIME,
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

afterEach(() => {
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }
});

function makeFixture(mountFormatVersion: 3 | 4 | 5 = 4): Fixture {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-project-sandbox-'));
  tempRoots.push(tempRoot);
  const projectRoot = path.join(tempRoot, 'projects', 'actor', 'project-a');
  const openClawHome = path.join(tempRoot, 'openclaw-home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(openClawHome, { recursive: true });
  const root = attestProjectRoot(projectRoot);
  // Mirror of the kernel-owned context policy fingerprint derivation; stale
  // reconstruction recomputes this from the inspected image, so the fixture
  // must carry the real derivation rather than a placeholder value.
  const contextSeed = {
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: ACTOR_ID,
    projectId: PROJECT_ID,
    workspaceOwnerId: 'workspace-owner-id',
    projectName: 'project-a',
    canonicalRoot: root.canonicalRoot,
    rootDevice: root.rootDevice,
    rootInode: root.rootInode,
    rootBirthtimeNs: root.rootBirthtimeNs,
    runtimePolicyVersion: OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: RUNTIME_IMAGE,
  } as const;
  const context: ProjectSandboxExecutionContext = Object.freeze({
    ...contextSeed,
    policyFingerprint: kernelContextPolicyFingerprint(contextSeed),
  });
  const egress: ProjectEgressPlaneConfig = {
    identity: {
      actorId: context.userId,
      projectId: context.projectId,
      provider: 'OPENCLAW',
    },
    proxyImage: PROXY_IMAGE,
    token: 'A'.repeat(43),
  };
  const spec = buildProjectEgressPlaneSpec(egress);
  const proxyUrl = `http://portal:${egress.token}@${spec.proxyAlias}:${spec.proxyPort}`;
  const handle: ProjectEgressPlaneHandle = {
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    policyFingerprint: spec.policyFingerprint,
    internalNetworkName: spec.internalNetworkName,
    internalNetworkId: '8'.repeat(64),
    publicNetworkName: spec.publicNetworkName,
    proxyContainerName: spec.proxyContainerName,
    proxyUrl,
    proxyEnvironment: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
    },
  };
  const plan = buildOpenClawProjectSandboxPlan({
    context,
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    openClawHome,
    egressSpec: spec,
    egressHandle: handle,
    mountFormatVersion,
  });
  return { tempRoot, projectRoot, openClawHome, context, egress, spec, handle, plan };
}

function currentNetworkResolver(fixture: Fixture) {
  return jest.fn(async () => Object.freeze({
    networkId: fixture.handle.internalNetworkId,
    generation: 'CURRENT' as const,
  }));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function persistedAgentEntries(agents: Record<string, any>[]): Record<string, Record<string, any>> {
  return Object.fromEntries(agents.map((agent) => {
    const { id, ...entry } = agent;
    return [id, entry];
  }));
}

function explicitAgentRoster(agents: Record<string, any>[]): Record<string, any> {
  return {
    ownership: 'explicit',
    defaults: { systemAgent: { agentId: 'main' } },
    entries: persistedAgentEntries(agents),
  };
}

function makeInspect(
  fixture: Fixture,
  running = false,
): Record<string, any> {
  const { plan, spec } = fixture;
  return {
    Id: 'd'.repeat(64),
    Image: RUNTIME_IMAGE,
    Name: `/${plan.containerName}`,
    Config: {
      Image: RUNTIME_IMAGE,
      User: '1000:1000',
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ...Object.entries(plan.expectedEnvironment).map(([key, value]) => `${key}=${value}`),
      ],
      Cmd: ['sleep', 'infinity'],
      Entrypoint: null,
      Labels: {
        'openclaw.sandbox': '1',
        'openclaw.sessionKey': plan.runtimeScopeKey,
        [OPENCLAW_PROJECT_ACTOR_LABEL]: hashOpenClawProjectLabelIdentity(plan.actorUserId),
        [OPENCLAW_PROJECT_IDENTITY_LABEL]: hashOpenClawProjectLabelIdentity(plan.projectIdentityId),
        [OPENCLAW_PROJECT_AGENT_LABEL]: plan.agentId,
        'openclaw.createdAtMs': '123456789',
        'openclaw.mountFormatVersion': String(plan.mountFormatVersion === 5 ? 4 : plan.mountFormatVersion),
        ...(plan.mountFormatVersion >= 4 ? { 'openclaw.createArgsEpoch': '2026-08-25-container-env-file' } : {}),
        'openclaw.configHash': plan.configHash,
        [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: plan.runtimeFingerprint,
      },
      WorkingDir: plan.mountFormatVersion === 5 ? '/workspace' : '/workspace/project',
      ExposedPorts: null,
      Volumes: null,
    },
    State: {
      Running: running,
      StartedAt: running ? '2026-07-19T16:01:00.000Z' : '0001-01-01T00:00:00Z',
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Init: plan.mountFormatVersion >= 4,
      CapAdd: null,
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges:true',
        'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
        'apparmor=bridgesllm-project-runtime-v1',
      ],
      Binds: [...plan.expectedBinds],
      Mounts: null,
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=67108864',
        '/var/tmp': 'rw,noexec,nosuid,nodev,size=64m',
        '/run': 'rw,noexec,nosuid,nodev,size=16777216',
      },
      PortBindings: null,
      PublishAllPorts: false,
      NetworkMode: plan.networkMode,
      Privileged: false,
      PidMode: '',
      IpcMode: 'private',
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
      Devices: null,
      DeviceRequests: null,
      DeviceCgroupRules: null,
      Dns: null,
      DnsOptions: null,
      DnsSearch: null,
      ExtraHosts: null,
      Links: null,
      VolumesFrom: null,
    },
    AppArmorProfile: 'bridgesllm-project-runtime-v1',
    Mounts: [
      {
        Type: 'bind',
        Source: plan.sandboxWorkspaceDir,
        Destination: '/workspace',
        Mode: plan.mountFormatVersion === 5 ? 'z' : 'ro,z',
        RW: plan.mountFormatVersion === 5,
        Propagation: 'rprivate',
      },
      {
        Type: 'bind',
        Source: plan.projectRoot,
        Destination: '/workspace/project',
        Mode: 'rw',
        RW: true,
        Propagation: 'rprivate',
      },
      ...(plan.mountFormatVersion === 5 ? [{
        Type: 'bind',
        Source: path.join(plan.sandboxWorkspaceDir, 'skills'),
        Destination: '/workspace/skills',
        Mode: 'ro,z',
        RW: false,
        Propagation: 'rprivate',
      }] : []),
    ],
    NetworkSettings: {
      Ports: null,
      Networks: {
        [spec.internalNetworkName]: {
          NetworkID: running ? plan.internalNetworkId : '',
        },
      },
    },
  };
}

function expectSandboxCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OpenClawProjectSandboxError);
    expect((error as OpenClawProjectSandboxError).code).toBe(code);
  }
}

function rpcResult(config: Record<string, any>, hash = 'config-hash') {
  return { ok: true, data: { config, hash } };
}

function legacyPreConfinementFixture(fixture: Fixture): Fixture {
  const desiredDocker: Record<string, any> = {
    ...deepClone(fixture.plan.desiredDocker),
    workdir: '/workspace/project',
    seccompProfile: '',
    apparmorProfile: '',
  };
  const configHash = computeOpenClawProjectConfigHash({
    docker: desiredDocker,
    sandboxWorkspaceDir: fixture.plan.sandboxWorkspaceDir,
    agentWorkspaceDir: fixture.plan.agentWorkspaceDir,
  });
  const runtimeFingerprint = __openClawProjectSandboxTest.stableHash({
    provider: 'OPENCLAW',
    actorId: fixture.context.userId,
    projectId: fixture.context.projectId,
    workspaceOwnerId: fixture.context.workspaceOwnerId,
    policyFingerprint: fixture.context.policyFingerprint,
    runtimePolicyVersion: fixture.context.runtimePolicyVersion,
    egressPolicyVersion: fixture.context.egressPolicyVersion,
    egressPolicyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(fixture.spec),
    runtimeImageDigest: RUNTIME_IMAGE,
    agentId: fixture.plan.agentId,
    sessionKey: fixture.plan.sessionKey,
    configHash,
  });
  return {
    ...fixture,
    plan: {
      ...fixture.plan,
      desiredDocker,
      mountFormatVersion: 3,
      configHash,
      runtimeFingerprint,
      networkMode: fixture.spec.internalNetworkName,
      expectedEnvironment: {
        ...desiredDocker.env,
        OPENCLAW_CLI: '1',
      },
    },
  };
}

function makeLegacyPreConfinementInspect(fixture: Fixture, running = true): Record<string, any> {
  const inspect = makeInspect(legacyPreConfinementFixture(fixture), running);
  inspect.HostConfig.SecurityOpt = ['no-new-privileges:true'];
  inspect.AppArmorProfile = 'docker-default';
  return inspect;
}

function makeCurrentNameModeInspect(
  fixture: Fixture,
  running: boolean,
): Record<string, any> {
  const historical = {
    ...fixture,
    plan: {
      ...fixture.plan,
      networkMode: fixture.spec.internalNetworkName,
    },
  };
  const inspect = makeInspect(historical, running);
  inspect.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
    fixture.handle.internalNetworkId;
  return inspect;
}

class RuntimeInventoryExecutor implements ProjectEgressCommandExecutor {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  readonly runtimes = new Map<string, Record<string, any>>();
  readonly listedIds = new Set<string>();
  readonly desired: Fixture;

  constructor(desired: Fixture) {
    this.desired = desired;
  }

  add(inspect: Record<string, any>, listed = true): void {
    const id = String(inspect.Id || '').toLowerCase();
    this.runtimes.set(id, inspect);
    if (listed) this.listedIds.add(id);
  }

  find(reference: string): Record<string, any> | null {
    const direct = this.runtimes.get(reference.toLowerCase());
    if (direct) return direct;
    return [...this.runtimes.values()].find((inspect) => (
      String(inspect.Name || '').replace(/^\//, '') === reference
    )) || null;
  }

  async run(command: string, args: readonly string[]): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    this.calls.push({ command, args });
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      return { stdout: [...this.listedIds].sort().join('\n'), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      const inspect = this.find(String(args[2]));
      return inspect
        ? { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: `No such container: ${String(args[2])}`, exitCode: 1 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
      const inspect = makeInspect(this.desired, false);
      this.add(inspect);
      return { stdout: `${String(inspect.Id)}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
      const inspect = this.find(String(args.at(-1)));
      if (inspect) inspect.State.Running = false;
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'start') {
      const inspect = this.find(String(args.at(-1)));
      if (inspect) {
        inspect.State.Running = true;
        inspect.NetworkSettings.Networks[this.desired.spec.internalNetworkName].NetworkID =
          this.desired.handle.internalNetworkId;
      }
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
      const inspect = this.find(String(args.at(-1)));
      if (inspect) {
        const id = String(inspect.Id || '').toLowerCase();
        this.runtimes.delete(id);
        this.listedIds.delete(id);
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

describe('OpenClaw Project sandbox desired policy', () => {
  test('builds one project-writable bind, a pinned image, proxy-only networking, and no host web/media tools', () => {
    const fixture = makeFixture();
    const { plan, spec } = fixture;

    expect(plan.desiredDocker.image).toBe(RUNTIME_IMAGE);
    expect(plan.desiredDocker.network).toBe(spec.internalNetworkName);
    expect(plan.desiredDocker.readOnlyRoot).toBe(true);
    expect(plan.desiredDocker.capDrop).toEqual(['ALL']);
    expect(plan.desiredDocker.binds).toEqual([`${plan.projectRoot}:/workspace/project:rw`]);
    expect(plan.expectedBinds.filter((bind) => bind.endsWith(':rw'))).toEqual([
      `${plan.projectRoot}:/workspace/project:rw`,
    ]);
    expect(plan.desiredAgent.sandbox).toMatchObject({
      mode: 'all',
      backend: 'docker',
      workspaceAccess: 'none',
      scope: 'session',
      browser: { enabled: false, allowHostControl: false, autoStart: false },
    });
    expect(plan.desiredAgent.model).toEqual({ fallbacks: [] });
    expect(plan.desiredAgent.models).toMatchObject({
      'openai/*': { agentRuntime: { id: 'openclaw' } },
      'anthropic/*': { agentRuntime: { id: 'openclaw' } },
      'google/*': { agentRuntime: { id: 'openclaw' } },
      'google-antigravity/*': { agentRuntime: { id: 'openclaw' } },
      'xai/*': { agentRuntime: { id: 'openclaw' } },
    });
    expect(plan.desiredAgent.tools.allow).toEqual([
      'exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'ask_user', 'request_user_input',
    ]);
    expect(plan.desiredAgent.tools.deny).toEqual(expect.arrayContaining([
      'group:web', 'group:media', 'web_search', 'web_fetch', 'image', 'browser', 'gateway',
    ]));
    expect(plan.desiredAgent.tools.deny).not.toContain('group:plugins');
    expect(plan.desiredAgent.tools.elevated).toEqual({ enabled: false });
    expect(plan.desiredAgent.tools.exec).toMatchObject({ host: 'sandbox', security: 'full', ask: 'off' });
    expect(plan.desiredAgent.tools.sandbox.tools).toEqual({
      allow: ['exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'ask_user', 'request_user_input'],
      deny: plan.desiredAgent.tools.deny,
    });
    expect(plan.expectedEnvironment.HTTP_PROXY).toContain('portal-project-egress');
    expect(plan.expectedEnvironment.NO_PROXY).toBe('');
  });

  test('current sandbox hash includes 9.x epochs and the automatic workspace mount cannot duplicate the project bind', () => {
    const fixture = makeFixture(4);
    const plan = fixture.plan;
    const destinations = [plan.desiredDocker.workdir, ...plan.desiredDocker.binds.map((bind: string) => bind.split(':')[1])];
    expect(destinations).toEqual(['/workspace', '/workspace/project']);
    expect(new Set(destinations).size).toBe(destinations.length);
    const args = __openClawProjectSandboxTest.buildContainerCreateArgs(plan, 123);
    expect(args).toContain('--init');
    expect(args).toContain('openclaw.mountFormatVersion=4');
    expect(args).toContain('openclaw.createArgsEpoch=2026-08-25-container-env-file');
    expect(args.filter((arg: string, i: number) => args[i - 1] === '-v')).toEqual([
      `${plan.sandboxWorkspaceDir}:/workspace:ro,z`, `${plan.projectRoot}:/workspace/project:rw`,
    ]);
    const legacy = makeFixture(3).plan;
    const legacyArgs = __openClawProjectSandboxTest.buildContainerCreateArgs(legacy, 123);
    expect(legacyArgs).not.toContain('--init');
    expect(legacyArgs).toContain('openclaw.mountFormatVersion=3');
    expect(legacy.mountFormatVersion).toBe(3);
  });

  (process.env.PORTAL_OPENCLAW_CONTRACT_DIST ? test : test.skip)('matches the installed current OpenClaw hash and automatic mount builder', () => {
    const plan = makeFixture(4).plan;
    const script = `
      import fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
      const root = process.env.PORTAL_OPENCLAW_CONTRACT_DIST;
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      const dockerFile = fs.readdirSync(root).find(n => /^docker-.*\\.js$/.test(n) && fs.readFileSync(path.join(root,n),'utf8').includes('mountFormatVersion: 4'));
      if (!dockerFile) throw new Error('No current sandbox contract found');
      const docker = fs.readFileSync(path.join(root,dockerFile),'utf8');
      const hashFile = docker.match(/from "(\\.\\/sanitize-env-vars-[^"]+)"/)[1];
      const mountsFile = docker.match(/from "(\\.\\/workspace-mounts-[^"]+)"/)[1];
      const h = await import(pathToFileURL(path.resolve(root,hashFile)).href);
      const m = await import(pathToFileURL(path.resolve(root,mountsFile)).href);
      const inputState = { docker: input.docker, dockerEnvPolicyEpoch: h.t(input.docker.env), workspaceAccess:'none', workspaceDir:input.workspace, agentWorkspaceDir:input.agentWorkspace, mountFormatVersion:4, createArgsEpoch:'2026-08-25-container-env-file', readOnlyWorkspaceSkillMounts:[] };
      const args=[]; m.n({args,workspaceDir:input.workspace,agentWorkspaceDir:input.agentWorkspace,workdir:input.docker.workdir,workspaceAccess:'none',readOnlyWorkspaceSkillMounts:[]});
      process.stdout.write(JSON.stringify({hash:h.o(inputState),mounts:args.filter((v,i)=>args[i-1]==='-v').concat(input.docker.binds).map(v=>v.split(':')[1])}));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], {
      input: JSON.stringify({docker:plan.desiredDocker,workspace:plan.sandboxWorkspaceDir,agentWorkspace:plan.agentWorkspaceDir}), encoding:'utf8', timeout:15000,
    }));
    expect(result.hash).toBe(plan.configHash);
    expect(result.mounts).toEqual(['/workspace', '/workspace/project']);
  });

  test('matches OpenClaw 2026.7.1 slug and stable config-hash behavior', () => {
    const fixture = makeFixture();
    const expectedSlugHash = crypto.createHash('sha256').update(SESSION_KEY).digest('hex').slice(0, 8);
    const expectedSlugPrefix = SESSION_KEY.toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    expect(slugifyOpenClawProjectSessionKey(SESSION_KEY)).toBe(
      `${expectedSlugPrefix}-${expectedSlugHash}`,
    );
    expect(computeOpenClawProjectConfigHash({
      docker: fixture.plan.desiredDocker,
      sandboxWorkspaceDir: fixture.plan.sandboxWorkspaceDir,
      agentWorkspaceDir: fixture.plan.agentWorkspaceDir,
      mountFormatVersion: fixture.plan.mountFormatVersion,
    })).toBe(fixture.plan.configHash);
    expect(fixture.plan.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.plan.containerName.length).toBeLessThanOrEqual(63);
    // Known parity vector from OpenClaw 2026.7.1's computeSandboxConfigHash.
    expect(__openClawProjectSandboxTest.stableHash({
      docker: { env: { HTTP_PROXY: 'x', http_proxy: 'x', NO_PROXY: '', no_proxy: '' } },
      workspaceAccess: 'none',
    })).toBe('f51ca5cc888178a3a7c010d80e7ca6418b95f97ffc81f7a7209f2bbfb5014591');
  });

  test('builds an OpenClaw-compatible hardened Docker create invocation', () => {
    const fixture = makeFixture();
    const args = __openClawProjectSandboxTest.buildContainerCreateArgs(fixture.plan, 123456789);
    expect(args.slice(0, 4)).toEqual(['container', 'create', '--name', fixture.plan.containerName]);
    expect(args).toEqual(expect.arrayContaining([
      '--read-only',
      '--security-opt', 'no-new-privileges:true',
      '--cap-drop', 'ALL',
      '--network', fixture.handle.internalNetworkId,
      '--user', '1000:1000',
      '-v', `${fixture.plan.sandboxWorkspaceDir}:/workspace:ro,z`,
      '-v', `${fixture.plan.projectRoot}:/workspace/project:rw`,
      RUNTIME_IMAGE,
      'sleep',
      'infinity',
    ]));
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--add-host');
  });

  test.each([
    ['unqualified image', (fixture: Fixture) => ({ ...fixture.context, runtimeImageDigest: 'unqualified:openclaw' }), 'UNPINNED_RUNTIME_IMAGE'],
    ['wrong runtime policy', (fixture: Fixture) => ({ ...fixture.context, runtimePolicyVersion: 'old' }), 'RUNTIME_POLICY_VERSION'],
    ['wrong egress policy', (fixture: Fixture) => ({ ...fixture.context, egressPolicyVersion: 'old' }), 'EGRESS_POLICY_VERSION'],
    ['invalid fingerprint', (fixture: Fixture) => ({ ...fixture.context, policyFingerprint: 'short' }), 'POLICY_FINGERPRINT'],
  ])('rejects %s before producing a plan', (_label, mutate, code) => {
    const fixture = makeFixture();
    expectSandboxCode(() => buildOpenClawProjectSandboxPlan({
      context: mutate(fixture) as ProjectSandboxExecutionContext,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egressSpec: fixture.spec,
      egressHandle: fixture.handle,
    }), code);
  });

  test('rechecks immutable project root identity', () => {
    const fixture = makeFixture();
    const moved = `${fixture.projectRoot}-old`;
    fs.renameSync(fixture.projectRoot, moved);
    fs.mkdirSync(fixture.projectRoot);
    expectSandboxCode(() => buildOpenClawProjectSandboxPlan({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egressSpec: fixture.spec,
      egressHandle: fixture.handle,
    }), 'PROJECT_ROOT_IDENTITY');
  });

  test('rejects a session owned by another agent and runtime paths overlapping Project data', () => {
    const fixture = makeFixture();
    expectSandboxCode(() => buildOpenClawProjectSandboxPlan({
      context: fixture.context,
      agentId: 'another-agent',
      sessionKey: 'agent:another-agent:portal-project',
      openClawHome: fixture.openClawHome,
      egressSpec: fixture.spec,
      egressHandle: fixture.handle,
    }), 'AGENT_IDENTITY');
    expectSandboxCode(() => buildOpenClawProjectSandboxPlan({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: 'agent:another-agent:session',
      openClawHome: fixture.openClawHome,
      egressSpec: fixture.spec,
      egressHandle: fixture.handle,
    }), 'INVALID_SESSION_KEY');
    expectSandboxCode(() => buildOpenClawProjectSandboxPlan({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: `agent:${AGENT_ID}:another-session`,
      openClawHome: fixture.openClawHome,
      egressSpec: fixture.spec,
      egressHandle: fixture.handle,
    }), 'SESSION_IDENTITY');
    const overlappingHome = path.join(fixture.projectRoot, '.openclaw');
    expectSandboxCode(() => buildOpenClawProjectSandboxPlan({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: overlappingHome,
      egressSpec: fixture.spec,
      egressHandle: fixture.handle,
    }), 'RUNTIME_PROJECT_OVERLAP');
    expect(fs.existsSync(overlappingHome)).toBe(false);
  });
});

describe('OpenClaw Project runtime attestation', () => {
  test('accepts only the complete stopped/running desired runtime', () => {
    const fixture = makeFixture();
    expect(() => attestOpenClawProjectContainer({
      plan: fixture.plan,
      spec: fixture.spec,
      inspect: makeInspect(fixture, false),
      requireRunning: false,
    })).not.toThrow();
    expect(() => attestOpenClawProjectContainer({
      plan: fixture.plan,
      spec: fixture.spec,
      inspect: makeInspect(fixture, true),
      requireRunning: true,
    })).not.toThrow();
  });

  const drifts: Array<[string, (inspect: Record<string, any>, fixture: Fixture) => void, string]> = [
    ['image', (inspect) => { inspect.Image = `sha256:${'d'.repeat(64)}`; }, 'RUNTIME_IMAGE'],
    ['state', (inspect) => { inspect.State.Running = true; }, 'RUNTIME_STATE'],
    ['config hash', (inspect) => { inspect.Config.Labels['openclaw.configHash'] = 'bad'; }, 'RUNTIME_LABELS'],
    ['runtime fingerprint', (inspect) => { inspect.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = 'bad'; }, 'RUNTIME_LABELS'],
    ['root user', (inspect) => { inspect.Config.User = '0'; }, 'RUNTIME_USER'],
    ['writable rootfs', (inspect) => { inspect.HostConfig.ReadonlyRootfs = false; }, 'RUNTIME_ROOTFS'],
    ['missing capability drop', (inspect) => { inspect.HostConfig.CapDrop = []; }, 'RUNTIME_CAP_DROP'],
    ['added capability', (inspect) => { inspect.HostConfig.CapAdd = ['SYS_ADMIN']; }, 'RUNTIME_CAP_ADD'],
    ['missing no-new-privileges', (inspect) => { inspect.HostConfig.SecurityOpt = []; }, 'RUNTIME_NO_NEW_PRIVILEGES'],
    ['wrong seccomp profile', (inspect) => {
      inspect.HostConfig.SecurityOpt[1] = 'seccomp=/tmp/foreign.json';
    }, 'RUNTIME_CONFINEMENT'],
    ['wrong AppArmor profile', (inspect) => {
      inspect.AppArmorProfile = 'docker-default';
    }, 'RUNTIME_CONFINEMENT'],
    ['unconfined profile', (inspect) => { inspect.HostConfig.SecurityOpt.push('seccomp=unconfined'); }, 'RUNTIME_UNCONFINED'],
    ['privileged mode', (inspect) => { inspect.HostConfig.Privileged = true; }, 'RUNTIME_PRIVILEGED'],
    ['host pid namespace', (inspect) => { inspect.HostConfig.PidMode = 'host'; }, 'RUNTIME_HOST_NAMESPACE'],
    ['container pid namespace', (inspect) => { inspect.HostConfig.PidMode = `container:${'e'.repeat(64)}`; }, 'RUNTIME_HOST_NAMESPACE'],
    ['container ipc namespace', (inspect) => { inspect.HostConfig.IpcMode = `container:${'e'.repeat(64)}`; }, 'RUNTIME_HOST_NAMESPACE'],
    ['container uts namespace', (inspect) => { inspect.HostConfig.UTSMode = `container:${'e'.repeat(64)}`; }, 'RUNTIME_HOST_NAMESPACE'],
    ['container user namespace', (inspect) => { inspect.HostConfig.UsernsMode = `container:${'e'.repeat(64)}`; }, 'RUNTIME_HOST_NAMESPACE'],
    ['container cgroup namespace', (inspect) => { inspect.HostConfig.CgroupnsMode = `container:${'e'.repeat(64)}`; }, 'RUNTIME_HOST_NAMESPACE'],
    ['restart policy', (inspect) => { inspect.HostConfig.RestartPolicy.Name = 'always'; }, 'RUNTIME_RESTART_POLICY'],
    ['resource limit', (inspect) => { inspect.HostConfig.Memory = 0; }, 'RUNTIME_RESOURCE_POLICY'],
    ['ulimit', (inspect) => { inspect.HostConfig.Ulimits[0].Soft = 4096; }, 'RUNTIME_ULIMITS'],
    ['tmpfs', (inspect) => { delete inspect.HostConfig.Tmpfs['/run']; }, 'RUNTIME_TMPFS'],
    ['extra tmpfs', (inspect) => {
      inspect.HostConfig.Tmpfs['/dev/shm'] = 'rw,noexec,nosuid,nodev,size=16m';
    }, 'RUNTIME_TMPFS'],
    ['conflicting tmpfs options', (inspect) => {
      inspect.HostConfig.Tmpfs['/tmp'] += ',exec';
    }, 'RUNTIME_TMPFS'],
    ['device', (inspect) => { inspect.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; }, 'RUNTIME_DEVICES'],
    ['published port', (inspect) => { inspect.HostConfig.PortBindings = { '80/tcp': [{}] }; }, 'RUNTIME_PORT_BINDINGS'],
    ['custom DNS', (inspect) => { inspect.HostConfig.Dns = ['8.8.8.8']; }, 'RUNTIME_DNS'],
    ['custom hosts', (inspect) => { inspect.HostConfig.ExtraHosts = ['host.docker.internal:host-gateway']; }, 'RUNTIME_EXTRA_HOSTS'],
    ['host network', (inspect) => { inspect.HostConfig.NetworkMode = 'host'; }, 'RUNTIME_NETWORK_MODE'],
    ['extra network', (inspect) => { inspect.NetworkSettings.Networks.bridge = {}; }, 'RUNTIME_NETWORK_ATTACHMENTS'],
    ['extra bind', (inspect) => { inspect.HostConfig.Binds.push('/etc:/host:ro'); }, 'RUNTIME_BINDS'],
    ['extra mount', (inspect) => { inspect.Mounts.push({ Type: 'bind', Source: '/etc', Destination: '/host', RW: false }); }, 'RUNTIME_MOUNTS'],
    ['writable sandbox workspace', (inspect) => { inspect.Mounts[0].RW = true; }, 'RUNTIME_WORKSPACE_MOUNT'],
    ['readonly project', (inspect) => { inspect.Mounts[1].RW = false; }, 'RUNTIME_PROJECT_MOUNT'],
    ['wrong proxy', (inspect) => {
      const index = inspect.Config.Env.findIndex((entry: string) => entry.startsWith('HTTP_PROXY='));
      inspect.Config.Env[index] = 'HTTP_PROXY=http://wrong';
    }, 'RUNTIME_ENVIRONMENT'],
    ['duplicate env', (inspect) => { inspect.Config.Env.push('HOME=/tmp'); }, 'RUNTIME_ENVIRONMENT_DUPLICATE'],
    ['host proxy', (inspect) => { inspect.Config.Env.push('ALL_PROXY=http://host:3128'); }, 'RUNTIME_ENVIRONMENT_ESCAPE'],
    ['credential env', (inspect) => { inspect.Config.Env.push('OPENAI_API_KEY=secret'); }, 'RUNTIME_ENVIRONMENT_SECRET'],
  ];

  test.each(drifts)('fails closed on %s drift', (_label, mutate, code) => {
    const fixture = makeFixture();
    const inspect = deepClone(makeInspect(fixture, false));
    mutate(inspect, fixture);
    expectSandboxCode(() => attestOpenClawProjectContainer({
      plan: fixture.plan,
      spec: fixture.spec,
      inspect,
      requireRunning: false,
    }), code);
  });
});

describe('OpenClaw config convergence', () => {
  test('preserves the 2026.7.1 list contract and uses an explicit whole-array replacement', async () => {
    const fixture = makeFixture(3);
    const staleAgent = deepClone(fixture.plan.desiredAgent);
    staleAgent.tools.deny.push('stale-deny-entry');
    const expectedList = [{ id: 'main', default: true }, fixture.plan.desiredAgent];
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcResult({
        agents: { defaults: {}, list: [{ id: 'main' }, staleAgent] },
      }, 'before'))
      .mockResolvedValueOnce({ ok: true, data: { hash: 'after' } })
      .mockResolvedValueOnce(rpcResult({
        agents: { defaults: {}, list: expectedList },
      }, 'after'));

    await __openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc);

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenNthCalledWith(2, 'config.patch', {
      raw: JSON.stringify({ agents: { list: expectedList } }),
      baseHash: 'before',
      replacePaths: ['agents.list'],
    }, 15_000);
  });

  test('patches the entire agent, then synchronously re-reads and verifies effective global policy', async () => {
    const fixture = makeFixture();
    const staleAgent = deepClone(fixture.plan.desiredAgent);
    staleAgent.tools.deny.push('stale-deny-entry');
    staleAgent.tools.sandbox.tools.deny.push('stale-sandbox-deny-entry');
    const beforeAgents = {
      ...explicitAgentRoster([{ id: 'main' }, staleAgent]),
      futureAgentSetting: { opaque: true },
    };
    // OpenClaw 2026.9.1 attaches `agents.list` to config.get results as a
    // non-enumerable compatibility projection. It is readable at runtime but
    // must never be copied into the persisted merge patch.
    Object.defineProperty(beforeAgents, 'list', {
      configurable: true,
      enumerable: false,
      value: [{ id: 'main' }, staleAgent],
    });
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcResult({
        agents: beforeAgents,
      }, 'before'))
      .mockResolvedValueOnce({ ok: true, data: { hash: 'after' } })
      .mockResolvedValueOnce(rpcResult({
        agents: {
          ...explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
          futureAgentSetting: { opaque: true },
        },
      }, 'after'));

    await __openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc);

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[1][0]).toBe('config.patch');
    expect(rpc.mock.calls[1][1].baseHash).toBe('before');
    expect(rpc.mock.calls[1][1].replacePaths).toEqual(expect.arrayContaining([
      `agents.entries.${AGENT_ID}.tools.deny`,
      `agents.entries.${AGENT_ID}.tools.sandbox.tools.deny`,
    ]));
    const raw = JSON.parse(rpc.mock.calls[1][1].raw);
    expect(raw.agents.entries[AGENT_ID].tools.deny).toEqual(fixture.plan.desiredAgent.tools.deny);
    expect(raw.agents.entries[AGENT_ID].tools.sandbox.tools.deny)
      .toEqual(fixture.plan.desiredAgent.tools.sandbox.tools.deny);
    expect(raw.agents.entries[AGENT_ID]).not.toHaveProperty('id');
    expect(raw.agents).not.toHaveProperty('list');
    expect(raw.agents).not.toHaveProperty('futureAgentSetting');
  });

  test('migrates legacy main ownership while preserving an exact keyed Project agent', async () => {
    const fixture = makeFixture();
    const main = { id: 'main', default: true, name: 'Host main' };
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcResult({
        agents: { entries: persistedAgentEntries([fixture.plan.desiredAgent, main]) },
      }, 'before'))
      .mockResolvedValueOnce({ ok: true, data: { hash: 'after' } })
      .mockResolvedValueOnce(rpcResult({
        agents: {
          ...explicitAgentRoster([{ id: 'main', name: 'Host main' }, fixture.plan.desiredAgent]),
        },
      }, 'after'));

    await __openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc);

    expect(rpc.mock.calls[1][0]).toBe('config.patch');
    const raw = JSON.parse(rpc.mock.calls[1][1].raw);
    expect(raw.agents).toMatchObject({
      ownership: 'explicit',
      defaults: { systemAgent: { agentId: 'main' } },
      entries: { main: { default: null } },
    });
    expect(raw.agents).not.toHaveProperty('list');
  });

  test('does not patch an already exact keyed agent with explicit host ownership', async () => {
    const fixture = makeFixture();
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));
    await __openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('config.get', {}, 15_000);
  });

  test('restores the implicit main agent before an exact lone Project agent can capture default routing', async () => {
    const fixture = makeFixture();
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcResult({
        agents: { entries: persistedAgentEntries([fixture.plan.desiredAgent]) },
      }, 'before'))
      .mockResolvedValueOnce({ ok: true, data: { hash: 'after' } })
      .mockResolvedValueOnce(rpcResult({
        agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
      }, 'after'));

    await __openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc);

    const raw = JSON.parse(rpc.mock.calls[1][1].raw);
    expect(raw.agents).toMatchObject({
      ownership: 'explicit',
      defaults: { systemAgent: { agentId: 'main' } },
      entries: { main: {} },
    });
    expect(raw.agents.entries[AGENT_ID]).toBeUndefined();
  });

  test.each([
    ['get failure', [{ ok: false, error: 'offline' }], 'CONFIG_GET_FAILED'],
    ['invalid get', [{ ok: true, data: { config: {} } }], 'CONFIG_GET_INVALID'],
    ['patch failure', [rpcResult({ agents: explicitAgentRoster([{ id: 'main' }]) }), { ok: false, error: 'rejected' }], 'CONFIG_PATCH_FAILED'],
    ['reread mismatch', [rpcResult({ agents: explicitAgentRoster([{ id: 'main' }]) }), { ok: true }, rpcResult({ agents: explicitAgentRoster([{ id: 'main' }]) })], 'CONFIG_REREAD_MISMATCH'],
  ])('fails closed on %s', async (_label, responses, code) => {
    const fixture = makeFixture();
    const rpc = jest.fn();
    for (const response of responses) rpc.mockResolvedValueOnce(response);
    await expect(__openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc))
      .rejects.toMatchObject({ code });
  });

  test('retains bounded structured gateway detail when config.patch is rejected', async () => {
    const fixture = makeFixture();
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }]) }, 'before'))
      .mockResolvedValueOnce({
        ok: false,
        error: 'legacy flattened message',
        errorCode: 'INVALID_REQUEST',
        errorMessage: `config.patch would remove entries from array path(s): agents.entries.${AGENT_ID}.tools.deny`,
      });

    await expect(__openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc))
      .rejects.toMatchObject({
        code: 'CONFIG_PATCH_FAILED',
        gatewayErrorCode: 'INVALID_REQUEST',
        gatewayErrorMessage: `config.patch would remove entries from array path(s): agents.entries.${AGENT_ID}.tools.deny`,
      });
  });

  test('rejects global binds/env/ulimits that alter the effective agent container', async () => {
    const fixture = makeFixture();
    for (const docker of [
      { binds: ['/etc:/host:ro'] },
      { env: { HOST_SECRET: 'leak' } },
      { ulimits: { core: { soft: 1, hard: 1 } } },
      { gpus: 'all' },
    ]) {
      const rpc = jest.fn().mockResolvedValue(rpcResult({
        agents: {
          ...explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
          defaults: {
            systemAgent: { agentId: 'main' },
            sandbox: { docker },
          },
        },
      }));
      await expect(__openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc))
        .rejects.toMatchObject({ code: 'GLOBAL_CONFIG_DRIFT' });
    }
  });

  test('rejects case-normalized duplicate keyed agent identities', async () => {
    const fixture = makeFixture();
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: {
        ownership: 'explicit',
        entries: {
          [AGENT_ID]: persistedAgentEntries([fixture.plan.desiredAgent])[AGENT_ID],
          [AGENT_ID.toUpperCase()]: persistedAgentEntries([fixture.plan.desiredAgent])[AGENT_ID],
        },
      },
    }));
    await expect(__openClawProjectSandboxTest.ensureExactOpenClawAgentConfig(fixture.plan, rpc))
      .rejects.toMatchObject({ code: 'CONFIG_AGENT_ENTRIES_INVALID' });
  });
});

describe('OpenClaw Project sandbox orchestration', () => {
  test('attests full runtime/config on convergence and again on the healthy-container fast path', async () => {
    const fixture = makeFixture();
    let inspect: Record<string, any> | null = null;
    const calls: string[][] = [];
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'container' && args[1] === 'ls') {
          return { stdout: inspect ? 'd'.repeat(64) : '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
          return inspect
            ? { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 }
            : { stdout: '', stderr: 'No such container', exitCode: 1 };
        }
        if (args[0] === 'container' && args[1] === 'create') {
          inspect = makeInspect(fixture, false);
          return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'start' && inspect) {
          inspect.State.Running = true;
          inspect.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
            fixture.handle.internalNetworkId;
        }
        if (args[0] === 'container' && args[1] === 'stop' && inspect) {
          inspect.State.Running = false;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));
    const constrainRuntime = jest.fn(async () => undefined);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);
    const attestationNow = new Date();
    const overrides = {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
      constrainRuntime,
      now: () => attestationNow,
    };
    const result = await ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, overrides);

    expect(result).toMatchObject({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      containerName: fixture.plan.containerName,
      configHash: fixture.plan.configHash,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
      attestedAt: attestationNow.toISOString(),
    });
    expect(constrainRuntime).toHaveBeenCalledWith({
      spec: fixture.spec,
      runtimeContainerId: 'd'.repeat(64),
      runtimeContainerName: fixture.plan.containerName,
      expectedRuntimeFingerprint: fixture.plan.runtimeFingerprint,
      executor,
    });
    const firstCreate = calls.findIndex((call) => call[1] === 'container' && call[2] === 'create');
    const firstStart = calls.findIndex((call) => call[1] === 'container' && call[2] === 'start');
    expect(firstCreate).toBeGreaterThanOrEqual(0);
    expect(firstStart).toBeGreaterThan(firstCreate);
    expect(calls.some((call) => call[1] === 'container' && call[2] === 'stop')).toBe(false);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, overrides)).resolves.toMatchObject({ containerName: fixture.plan.containerName });
    expect(ensureEgressPlane).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpc.mock.calls.every(([method]) => method === 'config.get')).toBe(true);
    expect(calls.filter((call) => call[1] === 'container' && call[2] === 'create')).toHaveLength(1);
    expect(calls.filter((call) => call[1] === 'container' && call[2] === 'start')).toHaveLength(1);

    // A label/image/running match is insufficient: complete attestation must
    // notice this rootfs drift, fall through, stop it, and refuse availability.
    const driftedInspect = inspect as Record<string, any> | null;
    if (!driftedInspect) throw new Error('fixture runtime was not created');
    driftedInspect.HostConfig.ReadonlyRootfs = false;
    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, overrides)).rejects.toMatchObject({ code: 'RUNTIME_ROOTFS' });
    expect(driftedInspect.State.Running).toBe(true);
  });

  test('fails before config/runtime work when egress identity or attestation mismatches', async () => {
    const fixture = makeFixture();
    const rpc = jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) }));
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async (_command, args) => {
        if (args[0] === 'container' && args[1] === 'ls') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'No such container', exitCode: 1 };
      }),
    };
    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: { ...fixture.egress, identity: { ...fixture.egress.identity, actorId: 'other' } },
    }, { rpc, executor })).rejects.toMatchObject({ code: 'EGRESS_IDENTITY' });
    expect(rpc).not.toHaveBeenCalled();

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: async () => ({ ...fixture.handle, policyFingerprint: 'wrong' }),
    })).rejects.toMatchObject({ code: 'EGRESS_ATTESTATION' });
    expect(rpc.mock.calls.every(([method]) => method === 'config.get')).toBe(true);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: async () => ({
        ...fixture.handle,
        proxyEnvironment: { ...fixture.handle.proxyEnvironment, ALL_PROXY: 'http://host:3128' },
      }),
    })).rejects.toMatchObject({ code: 'EGRESS_PROXY_ENVIRONMENT' });
    expect(rpc.mock.calls.every(([method]) => method === 'config.get')).toBe(true);
  });

  test('leaves an unattested drifted runtime untouched and unavailable', async () => {
    const fixture = makeFixture();
    const inspect = makeInspect(fixture, true);
    inspect.HostConfig.ReadonlyRootfs = false;
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async (_command, args) => {
        if (args[0] === 'container' && args[1] === 'stop') inspect.State.Running = false;
        if (args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    await expect(__openClawProjectSandboxTest.ensureExactRuntime({
      plan: fixture.plan,
      spec: fixture.spec,
      executor,
      constrainRuntime: jest.fn(),
      now: new Date(),
    })).rejects.toMatchObject({ code: 'RUNTIME_ROOTFS' });
    expect(inspect.State.Running).toBe(true);
    expect(executor.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['container', 'stop']));
    expect(executor.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['container', 'start']));
  });

  test.each([
    ['container namespace join', (inspect: Record<string, any>) => {
      inspect.HostConfig.PidMode = `container:${'a'.repeat(64)}`;
    }, 'RUNTIME_HOST_NAMESPACE'],
    ['extra tmpfs target', (inspect: Record<string, any>) => {
      inspect.HostConfig.Tmpfs['/dev/shm'] = 'rw,noexec,nosuid,nodev,size=16m';
    }, 'RUNTIME_TMPFS'],
    ['conflicting tmpfs options', (inspect: Record<string, any>) => {
      inspect.HostConfig.Tmpfs['/tmp'] += ',exec';
    }, 'RUNTIME_TMPFS'],
  ] as Array<[string, (inspect: Record<string, any>) => void, string]>)(
    'does not mutate a current runtime with %s',
    async (_label, mutate, expectedCode) => {
      const fixture = makeFixture();
      const inspect = makeInspect(fixture, true);
      mutate(inspect);
      const executor: ProjectEgressCommandExecutor = {
        run: jest.fn(async (_command, args) => {
          if (args[0] === 'container' && args[1] === 'inspect') {
            return { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 };
          }
          if (args[0] === 'container' && args[1] === 'ls') {
            return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }),
      };
      const constrainRuntime = jest.fn(async () => undefined);

      await expect(__openClawProjectSandboxTest.ensureExactRuntime({
        plan: fixture.plan,
        spec: fixture.spec,
        executor,
        constrainRuntime,
        now: new Date(),
      })).rejects.toMatchObject({ code: expectedCode });
      expect(inspect.State.Running).toBe(true);
      expect(constrainRuntime).not.toHaveBeenCalled();
      expect(executor.run).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['container', 'stop']),
      );
      expect(executor.run).not.toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['container', 'start']),
      );
    },
  );

  test('stops the runtime if immutable project identity changes during attestation', async () => {
    const fixture = makeFixture();
    let inspect: Record<string, any> | null = null;
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async (_command, args) => {
        if (args[0] === 'container' && args[1] === 'ls') {
          return { stdout: inspect ? 'd'.repeat(64) : '', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
          return inspect
            ? { stdout: JSON.stringify([inspect]), stderr: '', exitCode: 0 }
            : { stdout: '', stderr: 'No such container', exitCode: 1 };
        }
        if (args[0] === 'container' && args[1] === 'create') {
          inspect = makeInspect(fixture, false);
          return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'start' && inspect) {
          inspect.State.Running = true;
          inspect.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
            fixture.handle.internalNetworkId;
        }
        if (args[0] === 'container' && args[1] === 'stop' && inspect) inspect.State.Running = false;
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));
    const constrainRuntime = jest.fn(async () => {
      fs.renameSync(fixture.projectRoot, `${fixture.projectRoot}-old`);
      fs.mkdirSync(fixture.projectRoot);
    });

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: async () => fixture.handle,
      constrainRuntime,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'PROJECT_ROOT_IDENTITY' });
    const finalInspect = inspect as Record<string, any> | null;
    expect(finalInspect?.State?.Running).toBe(false);
  });

  test('retires an attached stale-policy generation before egress network convergence', async () => {
    const fixture = makeFixture();
    const previous = legacyPreConfinementFixture(fixture);
    expect(previous.plan.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    const stale = makeLegacyPreConfinementInspect(fixture);
    stale.Id = 'e'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(stale);
    const ensureEgressPlane = jest.fn(async () => {
      // This is the exact ordering regression: ensureProjectEgressPlane would
      // throw STALE_NETWORK_RUNTIME_ATTACHED while this member still exists.
      expect(executor.listedIds.size).toBe(0);
      return fixture.handle;
    });
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    })).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });

    const stopIndex = executor.calls.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ));
    const removeIndex = executor.calls.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ));
    const createIndex = executor.calls.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stopIndex);
    expect(createIndex).toBeGreaterThan(removeIndex);
    expect(executor.calls.some(({ args }) => args.includes('--force'))).toBe(false);
    const listing = executor.calls.find(({ args }) => args[0] === 'container' && args[1] === 'ls');
    expect(listing?.args).toEqual(expect.arrayContaining([
      '--filter', expect.stringContaining(`${OPENCLAW_PROJECT_ACTOR_LABEL}=`),
      '--filter', expect.stringContaining(`${OPENCLAW_PROJECT_IDENTITY_LABEL}=`),
    ]));
    expect(listing?.args).not.toContain('label=openclaw.sandbox=1');
    expect(listing?.args).not.toContain(`label=openclaw.sessionKey=${SESSION_KEY}`);
    expect(listing?.args).not.toContain(`label=${OPENCLAW_PROJECT_AGENT_LABEL}=${AGENT_ID}`);
  });

  function imageVariantFixture(base: Fixture, runtimeImageDigest: string): Fixture {
    const seed = { ...base.context, runtimeImageDigest };
    const context: ProjectSandboxExecutionContext = Object.freeze({
      ...seed,
      policyFingerprint: kernelContextPolicyFingerprint(seed),
    });
    return {
      ...base,
      context,
      plan: buildOpenClawProjectSandboxPlan({
        context,
        agentId: AGENT_ID,
        sessionKey: SESSION_KEY,
        openClawHome: base.openClawHome,
        egressSpec: base.spec,
        egressHandle: base.handle,
        mountFormatVersion: base.plan.mountFormatVersion,
      }),
    };
  }

  test('retires a stale runtime created from a since-rebuilt sandbox image', async () => {
    const fixture = makeFixture();
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    expect(rebuiltAway.plan.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    expect(rebuiltAway.plan.containerName).not.toBe(fixture.plan.containerName);
    const stale = makeInspect(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    stale.Image = `sha256:${'9'.repeat(64)}`;
    stale.Config.Image = stale.Image;
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(stale);
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
      constrainRuntime: jest.fn(async () => undefined),
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    })).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    const stopIndex = executor.calls.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ));
    const removeIndex = executor.calls.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stopIndex);
  });

  test('fails closed when a stale runtime image was swapped after creation', async () => {
    const fixture = makeFixture();
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    const stale = makeInspect(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    // The name prefix and fingerprint labels commit to the creation image; a
    // different inspected image must not reconstruct any recognized shape.
    stale.Image = `sha256:${'7'.repeat(64)}`;
    stale.Config.Image = stale.Image;
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(stale);
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
      constrainRuntime: jest.fn(async () => undefined),
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    })).rejects.toThrow('Managed OpenClaw Project stale runtime name did not match');
    expect(executor.calls.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test.each([
    ['running', true],
    ['stopped', false],
  ])('migrates an exact %s current-fingerprint name-mode runtime once and remains idempotent', async (
    _state,
    running,
  ) => {
    const fixture = makeFixture();
    const stale = makeCurrentNameModeInspect(fixture, running);
    stale.Id = 'e'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(stale);
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));
    const overrides = {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
      constrainRuntime: jest.fn(async () => undefined),
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    };
    const input = {
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    };

    await expect(ensureOpenClawProjectSandbox(input, overrides)).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    await expect(ensureOpenClawProjectSandbox(input, overrides)).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    expect(executor.calls.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(1);
    expect(executor.calls.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ))).toHaveLength(1);
    expect(executor.calls.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(running ? 1 : 0);
  });

  test('does not mutate a current-fingerprint name-mode runtime bound to another network ID', async () => {
    const fixture = makeFixture();
    const counterfeit = makeCurrentNameModeInspect(fixture, true);
    counterfeit.Id = 'e'.repeat(64);
    counterfeit.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
      'f'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(counterfeit);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'RUNTIME_NETWORK_ATTACHMENTS' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('does not mutate a label-matched stale runtime whose full contract does not attest', async () => {
    const fixture = makeFixture();
    const counterfeit = makeLegacyPreConfinementInspect(fixture);
    counterfeit.Id = 'e'.repeat(64);
    counterfeit.Mounts[1].Source = path.join(fixture.tempRoot, 'other-project');
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(counterfeit);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'RUNTIME_PROJECT_MOUNT' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test.each([
    ['container namespace join', (inspect: Record<string, any>) => {
      inspect.HostConfig.PidMode = `container:${'a'.repeat(64)}`;
    }, 'RUNTIME_HOST_NAMESPACE'],
    ['extra tmpfs target', (inspect: Record<string, any>) => {
      inspect.HostConfig.Tmpfs['/dev/shm'] = 'rw,noexec,nosuid,nodev,size=16m';
    }, 'RUNTIME_TMPFS'],
    ['conflicting tmpfs options', (inspect: Record<string, any>) => {
      inspect.HostConfig.Tmpfs['/tmp'] += ',exec';
    }, 'RUNTIME_TMPFS'],
  ] as Array<[string, (inspect: Record<string, any>) => void, string]>)(
    'does not mutate a stale runtime with %s',
    async (_label, mutate, expectedCode) => {
    const fixture = makeFixture();
    const counterfeit = makeLegacyPreConfinementInspect(fixture);
    counterfeit.Id = 'e'.repeat(64);
    mutate(counterfeit);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(counterfeit);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: expectedCode });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
    expect(counterfeit.State.Running).toBe(true);
    },
  );

  test('rejects an arbitrary label-declared generation before any mutation', async () => {
    const fixture = makeFixture();
    const counterfeit = makeLegacyPreConfinementInspect(fixture);
    counterfeit.Id = 'e'.repeat(64);
    counterfeit.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = '8'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(counterfeit);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_GENERATION' });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test.each([
    ['recognized stale sorts before stale counterfeit', 'a', 'f', 'STALE'],
    ['stale counterfeit sorts before recognized stale', 'f', 'a', 'STALE'],
    ['recognized stale sorts before counterfeit current claimant', 'a', 'f', 'CURRENT'],
    ['counterfeit current claimant sorts before recognized stale', 'f', 'a', 'CURRENT'],
  ] as Array<[string, string, string, 'STALE' | 'CURRENT']>)(
    'preflights the complete mixed inventory when %s',
    async (
      _label,
      exactPrefix,
      counterfeitPrefix,
      claimantGeneration,
    ) => {
    const fixture = makeFixture();
    const exactStale = makeLegacyPreConfinementInspect(fixture);
    exactStale.Id = exactPrefix.repeat(64);
    const counterfeit = claimantGeneration === 'CURRENT'
      ? makeInspect(fixture, true)
      : makeLegacyPreConfinementInspect(fixture);
    counterfeit.Id = counterfeitPrefix.repeat(64);
    const expectedCode = claimantGeneration === 'CURRENT'
      ? 'RUNTIME_PRIVILEGED'
      : 'RUNTIME_PROJECT_MOUNT';
    if (claimantGeneration === 'CURRENT') {
      counterfeit.HostConfig.Privileged = true;
    } else {
      counterfeit.Mounts[1].Source = path.join(fixture.tempRoot, 'counterfeit-project');
    }
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(exactStale);
    executor.add(counterfeit);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: expectedCode });
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
    expect(exactStale.State.Running).toBe(true);
      expect(counterfeit.State.Running).toBe(true);
    });

  test('includes a markerless same-project counterfeit in the read-only inventory preflight', async () => {
    const fixture = makeFixture();
    const exactStale = makeLegacyPreConfinementInspect(fixture);
    exactStale.Id = 'a'.repeat(64);
    const markerlessCounterfeit = makeLegacyPreConfinementInspect(fixture);
    markerlessCounterfeit.Id = 'f'.repeat(64);
    delete markerlessCounterfeit.Config.Labels['openclaw.sandbox'];
    delete markerlessCounterfeit.Config.Labels['openclaw.sessionKey'];
    delete markerlessCounterfeit.Config.Labels[OPENCLAW_PROJECT_AGENT_LABEL];
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(exactStale);
    executor.add(markerlessCounterfeit);
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'RUNTIME_LABELS' });
    const listing = executor.calls.find(({ args }) => (
      args[0] === 'container' && args[1] === 'ls'
    ));
    expect(listing?.args).not.toContain('label=openclaw.sandbox=1');
    expect(listing?.args).not.toContain(`label=openclaw.sessionKey=${SESSION_KEY}`);
    expect(listing?.args).not.toContain(`label=${OPENCLAW_PROJECT_AGENT_LABEL}=${AGENT_ID}`);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
    expect(exactStale.State.Running).toBe(true);
    expect(markerlessCounterfeit.State.Running).toBe(true);
    },
  );

  test('does not mutate when identity inventory changes after the read-only attestation phase', async () => {
    const fixture = makeFixture();
    const exactStale = makeLegacyPreConfinementInspect(fixture);
    exactStale.Id = 'a'.repeat(64);
    const concurrentCounterfeit = makeLegacyPreConfinementInspect(fixture);
    concurrentCounterfeit.Id = 'f'.repeat(64);
    concurrentCounterfeit.HostConfig.Privileged = true;
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(exactStale);
    const originalRun = executor.run.bind(executor);
    let listingCount = 0;
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        listingCount += 1;
        if (listingCount === 2) executor.add(concurrentCounterfeit);
      }
      return originalRun(command, args);
    };
    const ensureEgressPlane = jest.fn(async () => fixture.handle);

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane,
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_RACE' });
    expect(listingCount).toBe(2);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
    expect(exactStale.State.Running).toBe(true);
    expect(concurrentCounterfeit.State.Running).toBe(true);
  });

  test('does not remove a same-name replacement that appears after immutable stale-runtime stop', async () => {
    const fixture = makeFixture();
    const stale = makeLegacyPreConfinementInspect(fixture);
    stale.Id = 'e'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(stale);
    const originalRun = executor.run.bind(executor);
    let replacement: Record<string, any> | null = null;
    executor.run = async (command, args) => {
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'stop'
        && args.at(-1) === 'e'.repeat(64)) {
        executor.runtimes.delete('e'.repeat(64));
        executor.listedIds.delete('e'.repeat(64));
        replacement = makeLegacyPreConfinementInspect(fixture, false);
        replacement.Id = 'f'.repeat(64);
        replacement.HostConfig.Privileged = true;
        executor.add(replacement);
      }
      return result;
    };

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc: jest.fn().mockResolvedValue(rpcResult({ agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]) })),
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
    })).rejects.toMatchObject({ code: 'STALE_RUNTIME_RACE' });
    expect(executor.runtimes.get('f'.repeat(64))).toBe(replacement);
    expect(executor.calls.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('never mutates a foreign occupant of the deterministic current runtime name', async () => {
    const fixture = makeFixture();
    const foreign = makeInspect(fixture, true);
    foreign.Id = 'f'.repeat(64);
    foreign.Config.Labels[OPENCLAW_PROJECT_ACTOR_LABEL] = hashOpenClawProjectLabelIdentity('other-actor');
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(foreign, false);
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
    })).rejects.toMatchObject({ code: 'RUNTIME_LABELS' });
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'start'].includes(String(args[1]))
    ))).toBe(false);
    expect(executor.runtimes.get('f'.repeat(64))).toBe(foreign);
  });

  test('anchors a newly created runtime to Docker create output across name substitution', async () => {
    const fixture = makeFixture();
    const createdId = 'd'.repeat(64);
    const replacementId = 'f'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    const originalRun = executor.run.bind(executor);
    let replacement: Record<string, any> | null = null;
    executor.run = async (command, args) => {
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
        executor.runtimes.delete(createdId);
        executor.listedIds.delete(createdId);
        replacement = makeInspect(fixture, false);
        replacement.Id = replacementId;
        executor.add(replacement);
      }
      return result;
    };
    const constrainRuntime = jest.fn(async () => undefined);

    await expect(__openClawProjectSandboxTest.ensureExactRuntime({
      plan: fixture.plan,
      spec: fixture.spec,
      executor,
      constrainRuntime,
      now: new Date('2026-07-24T12:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'RUNTIME_CREATE' });

    const createIndex = executor.calls.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ));
    const firstPostCreateInspect = executor.calls.slice(createIndex + 1).find(({ args }) => (
      args[0] === 'container' && args[1] === 'inspect'
    ));
    expect(firstPostCreateInspect?.args[2]).toBe(createdId);
    expect(constrainRuntime).not.toHaveBeenCalled();
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start'].includes(String(args[1]))
    ))).toBe(false);
    expect(executor.runtimes.get(replacementId)).toBe(replacement);
    const finalReplacement = replacement as Record<string, any> | null;
    expect(finalReplacement?.State?.Running).toBe(false);
  });

  test('fails closed if another identity-matched generation appears before return', async () => {
    const fixture = makeFixture();
    const executor = new RuntimeInventoryExecutor(fixture);
    const originalRun = executor.run.bind(executor);
    const concurrent = makeLegacyPreConfinementInspect(fixture);
    concurrent.Id = 'e'.repeat(64);
    concurrent.Name = '/concurrent-label-matched-runtime';
    executor.run = async (command, args) => {
      const result = await originalRun(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'start') {
        executor.add(concurrent);
      }
      return result;
    };
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));

    await expect(ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 1] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
      constrainRuntime: jest.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_INVENTORY' });
    expect(executor.runtimes.get('e'.repeat(64))).toBe(concurrent);
    expect(executor.calls.some(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ))).toBe(false);
  });
});


describe('OpenClaw 2026.9.2 workspace-qualified runtime (format 5)', () => {
  test('plans the exact Gateway identity: qualified scope key, workspace slug name, rw workspace + ro skills binds, 9.2 configHash', () => {
    const f = makeFixture(5);
    const { plan } = f;
    const prefix = `p4oc-${f.context.policyFingerprint.slice(0, 16)}-`;
    const identity = resolveOpenClawWorkspaceQualifiedRuntime({
      sessionKey: SESSION_KEY, agentWorkspaceDir: plan.agentWorkspaceDir,
      sandboxWorkspaceRoot: plan.sandboxWorkspaceRoot, containerPrefix: prefix,
    });
    expect(plan.runtimeScopeKey).toBe(identity.scopeKey);
    expect(plan.runtimeScopeKey).toMatch(new RegExp(`^${SESSION_KEY}:workspace:[a-f0-9]{32}$`));
    expect(plan.containerName).toBe(identity.containerName);
    expect(plan.containerName).toHaveLength(63);
    expect(plan.sandboxWorkspaceDir).toBe(identity.sandboxWorkspaceDir);
    expect(fs.lstatSync(path.join(plan.sandboxWorkspaceDir, 'skills')).isDirectory()).toBe(true);
    expect(plan.expectedBinds).toEqual([
      `${plan.sandboxWorkspaceDir}:/workspace:z`,
      `${plan.projectRoot}:/workspace/project:rw`,
      `${plan.sandboxWorkspaceDir}/skills:/workspace/skills:ro,z`,
    ]);
    expect(plan.desiredDocker.workdir).toBe('/workspace');
    expect(plan.configHash).toBe(computeOpenClaw92SandboxConfigHash({
      docker: plan.desiredDocker, workspaceAccess: 'none', workspaceDir: plan.sandboxWorkspaceDir,
      agentWorkspaceDir: plan.agentWorkspaceDir,
      readOnlyWorkspaceSkillMounts: [`${plan.sandboxWorkspaceDir}/skills:/workspace/skills:ro`],
    }));
    const v4Fixture = makeFixture(4);
    const v4 = v4Fixture.plan;
    expect(plan.configHash).not.toBe(v4.configHash);
    expect(plan.runtimeFingerprint).not.toBe(v4.runtimeFingerprint);
    expect(v4.containerName).toBe(`p4oc-${v4Fixture.context.policyFingerprint.slice(0, 16)}-${slugifyOpenClawProjectSessionKey(SESSION_KEY)}`.slice(0, 63));
    expect(v4.runtimeScopeKey).toBe(SESSION_KEY);
  });

  test('create args label the qualified scope key, keep --init and start in /workspace', () => {
    const f = makeFixture(5);
    const args = __openClawProjectSandboxTest.buildContainerCreateArgs(f.plan, 1_700_000_000_000);
    expect(args).toContain(`openclaw.sessionKey=${f.plan.runtimeScopeKey}`);
    expect(args).toContain('openclaw.mountFormatVersion=4');
    expect(args).toContain('openclaw.createArgsEpoch=2026-08-25-container-env-file');
    expect(args).toContain(`openclaw.configHash=${f.plan.configHash}`);
    expect(args).toContain('--init');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/workspace');
    for (const bind of f.plan.expectedBinds) expect(args).toContain(bind);
    expect(args.filter((value) => value === '-v')).toHaveLength(3);
  });

  test('attests the complete format-5 runtime and rejects a format-4 shaped one under the same plan', () => {
    const f = makeFixture(5);
    const inspect = makeInspect(f, true);
    expect(attestOpenClawProjectContainer({ plan: f.plan, spec: f.spec, inspect, requireRunning: true }).containerId).toBe('d'.repeat(64));
    const stale = deepClone(inspect);
    stale.Config.WorkingDir = '/workspace/project';
    expectSandboxCode(() => attestOpenClawProjectContainer({ plan: f.plan, spec: f.spec, inspect: stale, requireRunning: true }), 'RUNTIME_WORKDIR');
    const roWorkspace = deepClone(inspect);
    roWorkspace.Mounts[0].RW = false;
    expectSandboxCode(() => attestOpenClawProjectContainer({ plan: f.plan, spec: f.spec, inspect: roWorkspace, requireRunning: true }), 'RUNTIME_WORKSPACE_MOUNT');
    const noSkills = deepClone(inspect);
    noSkills.Mounts.pop();
    expectSandboxCode(() => attestOpenClawProjectContainer({ plan: f.plan, spec: f.spec, inspect: noSkills, requireRunning: true }), 'RUNTIME_MOUNTS');
    const wrongKey = deepClone(inspect);
    wrongKey.Config.Labels['openclaw.sessionKey'] = SESSION_KEY;
    expectSandboxCode(() => attestOpenClawProjectContainer({ plan: f.plan, spec: f.spec, inspect: wrongKey, requireRunning: true }), 'RUNTIME_LABELS');
  });

  test('selects format 5 only for keyed entries on OpenClaw >= 2026.9.2', () => {
    const { usesWorkspaceQualifiedRuntime } = __openClawProjectSandboxTest;
    expect(usesWorkspaceQualifiedRuntime([2026, 9, 2])).toBe(true);
    expect(usesWorkspaceQualifiedRuntime([2026, 10, 0])).toBe(true);
    expect(usesWorkspaceQualifiedRuntime([2027, 1, 0])).toBe(true);
    expect(usesWorkspaceQualifiedRuntime([2026, 9, 1])).toBe(false);
    expect(usesWorkspaceQualifiedRuntime([2026, 8, 30])).toBe(false);
    expect(usesWorkspaceQualifiedRuntime(null)).toBe(false);
  });

  test('replaces only an unadopted Gateway-provisioned runtime of this exact agent occupying the format-5 name', async () => {
    const fixture = makeFixture(5);
    const executor = new RuntimeInventoryExecutor(fixture);
    const provisioned = makeInspect(fixture, true);
    provisioned.Id = 'e'.repeat(64);
    provisioned.Config.Labels = {
      'openclaw.sandbox': '1',
      'openclaw.sessionKey': fixture.plan.runtimeScopeKey,
      'openclaw.createdAtMs': '1',
      'openclaw.mountFormatVersion': '4',
      'openclaw.createArgsEpoch': '2026-08-25-container-env-file',
      'openclaw.configHash': fixture.plan.configHash,
    };
    executor.add(provisioned, false);
    expect(__openClawProjectSandboxTest.isUnadoptedGatewayProvisionedRuntime(fixture.plan, provisioned)).toBe(true);
    const foreignKey = deepClone(provisioned);
    foreignKey.Config.Labels['openclaw.sessionKey'] = `${SESSION_KEY}:workspace:${'0'.repeat(32)}`;
    expect(__openClawProjectSandboxTest.isUnadoptedGatewayProvisionedRuntime(fixture.plan, foreignKey)).toBe(false);
    const portalLabelled = deepClone(provisioned);
    portalLabelled.Config.Labels[OPENCLAW_PROJECT_ACTOR_LABEL] = hashOpenClawProjectLabelIdentity('other-actor');
    expect(__openClawProjectSandboxTest.isUnadoptedGatewayProvisionedRuntime(fixture.plan, portalLabelled)).toBe(false);
    expect(__openClawProjectSandboxTest.isUnadoptedGatewayProvisionedRuntime(makeFixture(4).plan, provisioned)).toBe(false);

    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));
    const result = await ensureOpenClawProjectSandbox({
      context: fixture.context,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome,
      egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 2] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
      constrainRuntime: jest.fn(async () => undefined) as any,
    });
    expect(result.containerName).toBe(fixture.plan.containerName);
    expect(result.configHash).toBe(fixture.plan.configHash);
    expect(result.containerId).toBe('d'.repeat(64));
    expect(executor.runtimes.has('e'.repeat(64))).toBe(false);
    expect(executor.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64))).toBe(true);
  });

  test('retires the format-4 agent-slug generation when the format-5 plan converges', async () => {
    const fixture = makeFixture(5);
    const plan4 = buildOpenClawProjectSandboxPlan({
      context: fixture.context, agentId: AGENT_ID, sessionKey: SESSION_KEY, openClawHome: fixture.openClawHome,
      egressSpec: fixture.spec, egressHandle: fixture.handle, mountFormatVersion: 4,
    });
    expect(plan4.containerName).not.toBe(fixture.plan.containerName);
    const stale = makeInspect({ ...fixture, plan: plan4 }, true);
    stale.Id = 'a'.repeat(64);
    const executor = new RuntimeInventoryExecutor(fixture);
    executor.add(stale);
    const rpc = jest.fn().mockResolvedValue(rpcResult({
      agents: explicitAgentRoster([{ id: 'main' }, fixture.plan.desiredAgent]),
    }));
    const result = await ensureOpenClawProjectSandbox({
      context: fixture.context, agentId: AGENT_ID, sessionKey: SESSION_KEY,
      openClawHome: fixture.openClawHome, egress: fixture.egress,
    }, {
      rpc,
      executor,
      readRuntimeVersion: () => [2026, 9, 2] as const,
      buildEgressSpec: () => fixture.spec,
      resolveInternalNetworkBinding: currentNetworkResolver(fixture),
      ensureEgressPlane: jest.fn(async () => fixture.handle),
      constrainRuntime: jest.fn(async () => undefined) as any,
    });
    expect(result.containerName).toBe(fixture.plan.containerName);
    expect(result.containerId).toBe('d'.repeat(64));
    expect(executor.runtimes.has('a'.repeat(64))).toBe(false);
    expect(executor.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'a'.repeat(64))).toBe(true);
  });
});

describe('qualification reconstructs the attested sandbox recipe', () => {
  test.each([3, 4, 5] as const)('preserves version %s through initial and final qualification', (version) => {
    const f = makeFixture(version);
    const plan = buildOpenClawProjectSandboxPlanForRuntime({ context: f.context,
      agentId: AGENT_ID, sessionKey: SESSION_KEY, openClawHome: f.openClawHome,
      egressSpec: f.spec, egressHandle: f.handle, runtime: f.plan });
    expect(plan).toEqual(f.plan);
  });
  test('refuses mixed or unrecognized attested identities', () => {
    const f = makeFixture(4);
    const input = { context: f.context, agentId: AGENT_ID, sessionKey: SESSION_KEY,
      openClawHome: f.openClawHome, egressSpec: f.spec, egressHandle: f.handle };
    const legacy = buildOpenClawProjectSandboxPlan({ ...input, mountFormatVersion: 3 });
    expectSandboxCode(() => buildOpenClawProjectSandboxPlanForRuntime({ ...input,
      runtime: { configHash: legacy.configHash, runtimeFingerprint: f.plan.runtimeFingerprint } }), 'RUNTIME_FINGERPRINT');
    expectSandboxCode(() => buildOpenClawProjectSandboxPlanForRuntime({ ...input,
      runtime: { configHash: 'unknown', runtimeFingerprint: 'unknown' } }), 'RUNTIME_FINGERPRINT');
  });
});
