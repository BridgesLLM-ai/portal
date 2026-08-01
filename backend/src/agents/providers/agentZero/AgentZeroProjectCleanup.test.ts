import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import {
  buildProjectEgressIdentityScope,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
} from '../../../services/projectEgressPlane';
import {
  AgentZeroProjectCleanupError,
  discoverAgentZeroProjectRuntimeResources,
  teardownAgentZeroProjectRuntimeResources,
} from './AgentZeroProjectCleanup';
import {
  AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX,
  AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX,
} from './AgentZeroProjectEgress';
import {
  AGENT_ZERO_PROJECT_ACTOR_LABEL,
  AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE,
  AGENT_ZERO_PROJECT_ID_LABEL,
  AGENT_ZERO_PROJECT_KEY_LABEL,
  AGENT_ZERO_PROJECT_MANAGED_LABEL,
  AGENT_ZERO_PROJECT_POLICY_LABEL,
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_RUNTIME,
  AGENT_ZERO_PROJECT_RUNTIME_LABEL,
  AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL,
  buildAgentZeroProjectRuntimeIdentity,
  type AgentZeroProjectRuntimeDescriptor,
} from './AgentZeroProjectSandbox';
import {
  issueAgentZeroProjectModelBridgeCredential,
  revokeAgentZeroProjectModelBridgeCredential,
} from './AgentZeroProjectModelBridgeCredential';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const ACTOR_ID = 'actor-00000000-0000-4000-8000-000000000001';
const PROJECT_KEY = 'a'.repeat(64);
const CONTAINER_ID = 'b'.repeat(64);
const INTERNAL_NETWORK = 'p4e-in-agent-zero-test';

function context(projectId = PROJECT_ID, actorId = ACTOR_ID): ProjectSandboxExecutionContext {
  return {
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: actorId,
    projectId,
    workspaceOwnerId: actorId,
    projectName: 'cleanup-test',
    canonicalRoot: `/srv/projects/${projectId}`,
    rootDevice: '2049',
    rootInode: '10001',
    rootBirthtimeNs: '1000000001',
    runtimePolicyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    egressPolicyVersion: 'project-egress-v1',
    runtimeImageDigest: `sha256:${'c'.repeat(64)}`,
    policyFingerprint: 'policy-fingerprint',
  };
}

function descriptor(
  stateRoot: string,
  input: ProjectSandboxExecutionContext,
  key = PROJECT_KEY,
): AgentZeroProjectRuntimeDescriptor {
  const stateDir = path.join(stateRoot, key);
  return {
    key,
    actorUserId: input.userId,
    projectIdentityId: input.projectId,
    stateRoot,
    stateDir,
    identityFile: path.join(stateDir, 'identity.json'),
    authFile: path.join(stateDir, 'agent-zero.env'),
    modelBridgeEnvFile: path.join(stateDir, 'model-bridge.env'),
    qualificationFile: path.join(stateDir, 'qualification.json'),
    containerName: `bridgesllm-a0p-${key.slice(0, 24)}`,
    dataVolume: `bridgesllm-a0p-${key.slice(0, 24)}-usr`,
    canonicalProjectRoot: input.canonicalRoot,
  };
}

function writeProtectedFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeState(
  stateRoot: string,
  input: ProjectSandboxExecutionContext = context(),
  key = PROJECT_KEY,
): AgentZeroProjectRuntimeDescriptor {
  const value = descriptor(stateRoot, input, key);
  fs.mkdirSync(value.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(value.stateDir, 0o700);
  writeProtectedFile(
    value.identityFile,
    `${JSON.stringify(buildAgentZeroProjectRuntimeIdentity(input, value), null, 2)}\n`,
  );
  writeProtectedFile(value.authFile, 'AGENT_ZERO_API_KEY=test-only\n');
  writeProtectedFile(value.modelBridgeEnvFile, 'API_KEY_CODEX_OAUTH=test-only\n');
  writeProtectedFile(value.qualificationFile, '{"qualified":true}\n');
  return value;
}

function issueBridgeCredential(
  runtime: AgentZeroProjectRuntimeDescriptor,
  credentialRoot: string,
  tokenCharacter = 'T',
  generation = '22222222-2222-4222-8222-222222222222',
): void {
  issueAgentZeroProjectModelBridgeCredential({
    projectKey: runtime.key,
    actorUserId: runtime.actorUserId,
    projectIdentityId: runtime.projectIdentityId,
  }, {
    providerId: 'codex_oauth',
    model: 'gpt-5.2-codex',
  }, {
    credentialRoot,
    tokenFactory: () => tokenCharacter.repeat(43),
    generationFactory: () => generation,
  });
}

function ownershipLabels(projectId = PROJECT_ID, actorId = ACTOR_ID): Record<string, string> {
  return {
    [AGENT_ZERO_PROJECT_MANAGED_LABEL]: 'agent-zero-project',
    [AGENT_ZERO_PROJECT_RUNTIME_LABEL]: AGENT_ZERO_PROJECT_RUNTIME,
    [AGENT_ZERO_PROJECT_POLICY_LABEL]: AGENT_ZERO_PROJECT_POLICY_VERSION,
    [AGENT_ZERO_PROJECT_KEY_LABEL]: PROJECT_KEY,
    [AGENT_ZERO_PROJECT_ID_LABEL]: projectId,
    [AGENT_ZERO_PROJECT_ACTOR_LABEL]: actorId,
  };
}

function runtimeFirewall(projectId = PROJECT_ID, actorId = ACTOR_ID): {
  chain: string;
  comment: string;
  lines: string[];
} {
  const scope = buildProjectEgressIdentityScope({
    actorId,
    projectId,
    provider: 'AGENT_ZERO',
  });
  const chain = `${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-${scope.identityFingerprint.slice(0, 24).toUpperCase()}`;
  const comment = `${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}:${scope.projectFingerprint}:${scope.identityFingerprint}`;
  return {
    chain,
    comment,
    lines: [
      `-N ${chain}`,
      `-A INPUT -s 172.30.0.3/32 -m comment --comment ${comment} -j ${chain}`,
      `-A DOCKER-USER -s 172.30.0.3/32 -m comment --comment ${comment} -j ${chain}`,
      `-A ${chain} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${comment} -j ACCEPT`,
      `-A ${chain} -d 172.30.0.2/32 -p tcp -m tcp --dport 3128 -m comment --comment ${comment} -j ACCEPT`,
      `-A ${chain} -d 172.30.0.1/32 -p tcp -m tcp --dport 18991 -m comment --comment ${comment} -j ACCEPT`,
      `-A ${chain} -m comment --comment ${comment} -j REJECT --reject-with icmp-port-unreachable`,
    ],
  };
}

function notFound(kind: 'container' | 'volume'): ProjectEgressCommandResult {
  return {
    stdout: '',
    stderr: `Error: No such ${kind}`,
    exitCode: 1,
  };
}

class CleanupExecutor implements ProjectEgressCommandExecutor {
  readonly commands: Array<{ command: string; args: readonly string[] }> = [];
  readonly containers = new Map<string, any>();
  readonly volumes = new Map<string, any>();
  firewall: string[] = [];
  containerInspectCount = 0;
  mutateContainerOnInspect: number | null = null;

  constructor(runtime: AgentZeroProjectRuntimeDescriptor, input: {
    includeContainer?: boolean;
    includeVolume?: boolean;
    includeFirewall?: boolean;
  } = {}) {
    const labels = ownershipLabels(runtime.projectIdentityId, runtime.actorUserId);
    if (input.includeContainer !== false) {
      this.containers.set(runtime.containerName, {
        Id: CONTAINER_ID,
        Name: `/${runtime.containerName}`,
        State: { Running: true, StartedAt: '2026-07-19T12:00:00.000Z' },
        Config: { Labels: labels, Image: `sha256:${'c'.repeat(64)}` },
        HostConfig: { NetworkMode: INTERNAL_NETWORK },
        NetworkSettings: { Networks: { [INTERNAL_NETWORK]: {} } },
        Mounts: [{ Type: 'volume', Name: runtime.dataVolume }],
      });
    }
    if (input.includeVolume !== false) {
      this.volumes.set(runtime.dataVolume, {
        Name: runtime.dataVolume,
        Driver: 'local',
        Scope: 'local',
        Options: null,
        Mountpoint: `/var/lib/docker/volumes/${runtime.dataVolume}/_data`,
        Labels: {
          ...labels,
          [AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL]: AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE,
        },
      });
    }
    if (input.includeFirewall !== false) this.firewall = runtimeFirewall().lines;
  }

  private findContainer(nameOrId: string): any | null {
    return [...this.containers.values()].find((value) => (
      value.Id === nameOrId || String(value.Name).replace(/^\//, '') === nameOrId
    )) || null;
  }

  async run(command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> {
    this.commands.push({ command, args: [...args] });
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      const projectFilter = args.find((value) => value.startsWith(`label=${AGENT_ZERO_PROJECT_ID_LABEL}=`));
      const projectId = projectFilter?.slice(`label=${AGENT_ZERO_PROJECT_ID_LABEL}=`.length);
      const names = [...this.containers.values()]
        .filter((value) => value.Config?.Labels?.[AGENT_ZERO_PROJECT_ID_LABEL] === projectId)
        .map((value) => String(value.Name).replace(/^\//, ''));
      return { stdout: names.join('\n'), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'volume' && args[1] === 'ls') {
      const projectFilter = args.find((value) => value.startsWith(`label=${AGENT_ZERO_PROJECT_ID_LABEL}=`));
      const projectId = projectFilter?.slice(`label=${AGENT_ZERO_PROJECT_ID_LABEL}=`.length);
      const names = [...this.volumes.values()]
        .filter((value) => value.Labels?.[AGENT_ZERO_PROJECT_ID_LABEL] === projectId)
        .map((value) => value.Name);
      return { stdout: names.join('\n'), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      const value = this.findContainer(args[2]);
      if (!value) return notFound('container');
      this.containerInspectCount += 1;
      if (this.mutateContainerOnInspect === this.containerInspectCount) {
        value.State.StartedAt = '2026-07-19T12:00:01.000Z';
      }
      return { stdout: JSON.stringify([value]), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'volume' && args[1] === 'inspect') {
      const value = this.volumes.get(args[2]);
      return value
        ? { stdout: JSON.stringify([value]), stderr: '', exitCode: 0 }
        : notFound('volume');
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
      const value = this.findContainer(args[4]);
      if (!value) return notFound('container');
      value.State.Running = false;
      return { stdout: args[4], stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
      const value = this.findContainer(args[2]);
      if (!value) return notFound('container');
      this.containers.delete(String(value.Name).replace(/^\//, ''));
      return { stdout: args[2], stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'volume' && args[1] === 'rm') {
      if (!this.volumes.delete(args[2])) return notFound('volume');
      return { stdout: args[2], stderr: '', exitCode: 0 };
    }
    if (command === 'iptables' && args[2] === '-S') {
      return { stdout: this.firewall.join('\n'), stderr: '', exitCode: 0 };
    }
    if (command === 'iptables' && args[2] === '-D') {
      const rule = `-A ${args[3]} ${args.slice(4).join(' ')}`;
      const index = this.firewall.indexOf(rule);
      if (index < 0) return { stdout: '', stderr: 'Bad rule', exitCode: 1 };
      this.firewall.splice(index, 1);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command === 'iptables' && args[2] === '-F') {
      this.firewall = this.firewall.filter((line) => !line.startsWith(`-A ${args[3]} `));
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command === 'iptables' && args[2] === '-X') {
      const declaration = `-N ${args[3]}`;
      if (!this.firewall.includes(declaration)) return { stdout: '', stderr: 'No chain', exitCode: 1 };
      this.firewall = this.firewall.filter((line) => line !== declaration);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `Unexpected command: ${command} ${args.join(' ')}`, exitCode: 2 };
  }
}

describe('Agent Zero Project immutable runtime cleanup', () => {
  let stateRoot: string;
  let credentialRoot: string;
  let runtime: AgentZeroProjectRuntimeDescriptor;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgesllm-a0-cleanup-'));
    fs.chmodSync(stateRoot, 0o700);
    credentialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgesllm-a0-bridge-cleanup-'));
    fs.chmodSync(credentialRoot, 0o750);
    runtime = writeState(stateRoot);
    issueBridgeCredential(runtime, credentialRoot);
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(credentialRoot, { recursive: true, force: true });
  });

  test('discovers exact provider-owned state, container, membership, volume, and firewall resources', async () => {
    writeState(
      stateRoot,
      context(OTHER_PROJECT_ID, 'actor-00000000-0000-4000-8000-000000000002'),
      'd'.repeat(64),
    );
    const executor = new CleanupExecutor(runtime);

    const resources = await discoverAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      executor,
    );

    expect(resources.map((value) => value.kind)).toEqual([
      'CONTAINER',
      'CREDENTIAL_FILE',
      'DATA_VOLUME',
      'FIREWALL_CHAIN',
      'MODEL_BRIDGE_CREDENTIAL',
      'MODEL_BRIDGE_ENV_FILE',
      'NETWORK_MEMBERSHIP',
      'QUALIFICATION_FILE',
      'STATE_DIRECTORY',
    ]);
    expect(resources.every((value) => value.projectIdentityId === PROJECT_ID)).toBe(true);
    expect(resources.find((value) => value.kind === 'CONTAINER')).toMatchObject({
      dockerId: CONTAINER_ID,
      actorUserId: ACTOR_ID,
      projectKey: PROJECT_KEY,
    });
  });

  test('rejects deterministic resources that lost labels and bind-backed named volumes', async () => {
    const missingLabelExecutor = new CleanupExecutor(runtime);
    const container = missingLabelExecutor.containers.get(runtime.containerName);
    container.Config.Labels[AGENT_ZERO_PROJECT_ID_LABEL] = OTHER_PROJECT_ID;
    await expect(discoverAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      missingLabelExecutor,
    )).rejects.toMatchObject({ code: 'DOCKER_IDENTITY' });

    const bindVolumeExecutor = new CleanupExecutor(runtime);
    bindVolumeExecutor.volumes.get(runtime.dataVolume).Options = {
      type: 'none',
      o: 'bind',
      device: '/root',
    };
    await expect(discoverAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      bindVolumeExecutor,
    )).rejects.toMatchObject({ code: 'VOLUME_PROVENANCE' });
  });

  test('tears down exact resources, proves final absence, and preserves unrelated state', async () => {
    const unrelated = writeState(
      stateRoot,
      context(OTHER_PROJECT_ID, 'actor-00000000-0000-4000-8000-000000000002'),
      'd'.repeat(64),
    );
    const executor = new CleanupExecutor(runtime);

    await expect(teardownAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      executor,
    )).resolves.toEqual({
      projectIdentityId: PROJECT_ID,
      discoveredResourceCount: 9,
      removedResourceCount: 9,
      alreadyAbsent: false,
    });

    expect(executor.containers.size).toBe(0);
    expect(executor.volumes.size).toBe(0);
    expect(executor.firewall).toEqual([]);
    expect(fs.existsSync(runtime.stateDir)).toBe(false);
    expect(fs.existsSync(unrelated.stateDir)).toBe(true);
    await expect(discoverAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      executor,
    )).resolves.toEqual([]);
  });

  test('aborts before mutation when the double discovery detects a race', async () => {
    const executor = new CleanupExecutor(runtime);
    executor.mutateContainerOnInspect = 2;

    await expect(teardownAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      executor,
    )).rejects.toEqual(expect.objectContaining<Partial<AgentZeroProjectCleanupError>>({
      code: 'CLEANUP_RACE',
    }));

    expect(executor.containers.size).toBe(1);
    expect(executor.volumes.size).toBe(1);
    expect(fs.existsSync(runtime.stateDir)).toBe(true);
    expect(executor.commands.some(({ args }) => args.includes('stop'))).toBe(false);
  });

  test('recovers a detached empty firewall chain only with immutable actor evidence', async () => {
    fs.rmSync(runtime.stateDir, { recursive: true });
    expect(revokeAgentZeroProjectModelBridgeCredential(PROJECT_KEY, { credentialRoot })).toBe(true);
    const executor = new CleanupExecutor(runtime, {
      includeContainer: false,
      includeVolume: false,
      includeFirewall: false,
    });
    const firewall = runtimeFirewall();
    executor.firewall = [`-N ${firewall.chain}`];

    await expect(discoverAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot },
      executor,
    )).rejects.toMatchObject({ code: 'FIREWALL_IDENTITY' });

    await expect(teardownAgentZeroProjectRuntimeResources(
      PROJECT_ID,
      { stateRoot, credentialRoot, knownActorIds: [ACTOR_ID] },
      executor,
    )).resolves.toMatchObject({
      discoveredResourceCount: 1,
      removedResourceCount: 1,
      alreadyAbsent: false,
    });
    expect(executor.firewall).toEqual([]);
  });
});
