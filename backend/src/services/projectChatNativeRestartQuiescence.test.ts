import crypto from 'crypto';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';

const stopCodex = jest.fn();
const stopNativeCli = jest.fn();
const discoverAgentZero = jest.fn();
const ollamaCleanup = jest.fn();
const loadNativeSession = jest.fn();
const buildContext = jest.fn();
const bindingFind = jest.fn();
const projectIdentityFind = jest.fn();
const egressRun = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    projectIdentity: { findUnique: (...args: unknown[]) => projectIdentityFind(...args) },
    projectChatProviderBinding: { findUnique: (...args: unknown[]) => bindingFind(...args) },
  },
}));
jest.mock('../agents/providers/NativeSessionStore', () => ({
  loadNativeSession: (...args: unknown[]) => loadNativeSession(...args),
}));
jest.mock('../agents/providers/agentZero/AgentZeroProjectSandbox', () => ({
  AGENT_ZERO_PROJECT_ACTOR_LABEL: 'actor-label',
  AGENT_ZERO_PROJECT_ID_LABEL: 'project-label',
  AGENT_ZERO_PROJECT_KEY_LABEL: 'key-label',
  AGENT_ZERO_PROJECT_MANAGED_LABEL: 'managed-label',
  AGENT_ZERO_PROJECT_POLICY_LABEL: 'policy-label',
  AGENT_ZERO_PROJECT_IMAGE_COMMAND: ['/opt/venv-a0/bin/python', '/a0/run_ui.py', '--dockerized=true', '--port=80', '--host=0.0.0.0'],
  AGENT_ZERO_PROJECT_ROOT: '/a0/usr/projects/portal',
  AGENT_ZERO_PROJECT_RUNTIME: 'agent-zero-project-sandbox-v4',
  AGENT_ZERO_PROJECT_RUNTIME_LABEL: 'runtime-label',
}));
jest.mock('../agents/providers/agentZero/AgentZeroProjectCleanup', () => ({
  discoverAgentZeroProjectRuntimeResources: (...args: unknown[]) => discoverAgentZero(...args),
}));
jest.mock('../agents/providers/native/projectSandbox/AntigravityProjectSandbox', () => ({
  ANTIGRAVITY_PROJECT_RUNTIME_PROFILE: { provider: 'GEMINI' },
}));
jest.mock('../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox', () => ({
  CLAUDE_CODE_PROJECT_RUNTIME_PROFILE: { provider: 'CLAUDE_CODE' },
}));
jest.mock('../agents/providers/native/projectSandbox/CodexProjectEgressRuntime', () => ({
  stopCodexProjectRuntimesForRecoveryContext: (...args: unknown[]) => stopCodex(...args),
}));
jest.mock('../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime', () => ({
  stopNativeCliProjectRuntimesForRecoveryContext: (...args: unknown[]) => stopNativeCli(...args),
}));
jest.mock('../agents/providers/ollama/OllamaProjectToolRuntime', () => ({
  stopOllamaProjectRuntimesForRecoveryContext: (...args: unknown[]) => ollamaCleanup(...args),
}));
jest.mock('./projectEgressPlane', () => ({
  projectEgressCommandExecutor: { run: (...args: unknown[]) => egressRun(...args) },
}));
jest.mock('./projectChatKernel', () => ({
  buildUnqualifiedProjectSandboxExecutionContext: (...args: unknown[]) => buildContext(...args),
}));
jest.mock('./projectChatProviderRegistry', () => {
  const runtimes: Record<string, string> = {
    CLAUDE_CODE: 'claude-code-project-adapter',
    CODEX: 'codex-project-adapter',
    AGENT_ZERO: 'agent-zero-project-sandbox-v4',
    GEMINI: 'antigravity-project-adapter',
    OLLAMA: 'ollama-project-coding-agent-v1',
  };
  return {
    getProjectChatProviderRuntimeDescriptor: (provider: string) => ({
      provider,
      runtime: runtimes[provider],
    }),
  };
});

import {
  nativeProjectRestartRecoveryTargetProvider,
  quiesceNativeProjectOperationAfterRestart,
} from './projectChatNativeRestartQuiescence';

const ACTOR = 'actor-uuid';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTEXT = Object.freeze({
  scope: 'PROJECT_SANDBOX' as const,
  source: 'PORTAL_SERVER' as const,
  userId: ACTOR,
  projectId: PROJECT,
  workspaceOwnerId: ACTOR,
  projectName: 'demo',
  canonicalRoot: `/portal/projects/${ACTOR}/demo`,
  rootDevice: '1',
  rootInode: '2',
  rootBirthtimeNs: '3',
  runtimePolicyVersion: 'runtime-v1',
  egressPolicyVersion: 'egress-v1',
  runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
  policyFingerprint: 'b'.repeat(64),
});

const MATRIX = [
  ['CLAUDE_CODE', 'claude-code-project-adapter', 'container-stopped'],
  ['CODEX', 'codex-project-adapter', 'container-stopped'],
  ['AGENT_ZERO', 'agent-zero-project-sandbox-v4', 'runtime-absent'],
  ['GEMINI', 'antigravity-project-adapter', 'container-stopped'],
  ['OLLAMA', 'ollama-project-coding-agent-v1', 'container-stopped'],
] as const;

function agentZeroInspect(
  containerId: string,
  running: unknown,
  context: ProjectSandboxExecutionContext = CONTEXT,
): Record<string, unknown> {
  const key = crypto.createHash('sha256').update(JSON.stringify({
    runtime: 'agent-zero-project-sandbox-v4',
    policy: context.runtimePolicyVersion,
    userId: context.userId,
    projectId: context.projectId,
    canonicalRoot: context.canonicalRoot,
    policyFingerprint: context.policyFingerprint,
  })).digest('hex');
  return {
    Id: containerId,
    Image: context.runtimeImageDigest,
    Name: `/bridgesllm-a0p-${key.slice(0, 24)}`,
    Config: {
      Image: context.runtimeImageDigest,
      User: '1000:1000',
      WorkingDir: '/a0',
      Entrypoint: [],
      Cmd: ['/opt/venv-a0/bin/python', '/a0/run_ui.py', '--dockerized=true', '--port=80', '--host=0.0.0.0'],
      Labels: {
        'managed-label': 'agent-zero-project',
        'runtime-label': 'agent-zero-project-sandbox-v4',
        'policy-label': context.runtimePolicyVersion,
        'key-label': key,
        'project-label': context.projectId,
        'actor-label': context.userId,
      },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: `bridgesllm-a0p-${key.slice(0, 24)}-usr`,
        Destination: '/a0/usr',
        RW: true,
      },
      {
        Type: 'bind',
        Source: context.canonicalRoot,
        Destination: '/a0/usr/projects/portal',
        RW: true,
        Propagation: 'rprivate',
      },
    ],
    State: { Running: running },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  projectIdentityFind.mockResolvedValue({
    id: PROJECT,
    workspaceOwnerId: ACTOR,
    projectName: 'demo',
    canonicalRoot: CONTEXT.canonicalRoot,
    lifecycleStatus: 'ACTIVE',
  });
  buildContext.mockReturnValue(CONTEXT);
  stopCodex.mockResolvedValue(['c'.repeat(64)]);
  stopNativeCli.mockResolvedValue(['d'.repeat(64)]);
  discoverAgentZero.mockResolvedValue([]);
  ollamaCleanup.mockResolvedValue(['o'.repeat(64)]);
});

test.each(MATRIX)(
  'quiesces provider-targeted %s runtime admission through its exact restart boundary',
  async (provider, runtime, expectedBoundary) => {
    expect(nativeProjectRestartRecoveryTargetProvider(runtime)).toBe(provider);
    await expect(quiesceNativeProjectOperationAfterRestart({
      id: `admission-${provider}`,
      actorUserId: ACTOR,
      projectIdentityId: PROJECT,
      provider: 'OPENCLAW',
      runtime,
      requestId: `portal-runtime-admission:qualify-${provider.toLowerCase()}:uuid`,
      providerSessionId: null,
    })).resolves.toMatchObject({
      provider,
      boundary: expectedBoundary,
      evidence: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  },
);

test('uses a persisted historical context for a pre-session runtime admission after image drift', async () => {
  const historicalSeed = {
    ...CONTEXT,
    runtimePolicyVersion: 'portal-project-sandbox-v2',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: `sha256:${'7'.repeat(64)}`,
  };
  const historicalContext = Object.freeze({
    ...historicalSeed,
    policyFingerprint: crypto.createHash('sha256').update(JSON.stringify({
      version: historicalSeed.runtimePolicyVersion,
      egressPolicyVersion: historicalSeed.egressPolicyVersion,
      provider: 'CODEX',
      runtime: 'codex-project-adapter',
      runtimeImageDigest: historicalSeed.runtimeImageDigest,
      actorUserId: historicalSeed.userId,
      workspaceOwnerId: historicalSeed.workspaceOwnerId,
      projectId: historicalSeed.projectId,
      projectName: historicalSeed.projectName,
      canonicalRoot: historicalSeed.canonicalRoot,
      rootDevice: historicalSeed.rootDevice,
      rootInode: historicalSeed.rootInode,
      rootBirthtimeNs: historicalSeed.rootBirthtimeNs,
    })).digest('hex'),
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'historical-admission',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'codex-project-adapter',
    requestId: 'portal-runtime-admission:qualify-codex:uuid',
    providerSessionId: null,
    resultMetadata: {
      runtimeAdmissionMetadataVersion: 1,
      recoveryExecutionContext: historicalContext,
    },
  })).resolves.toMatchObject({ provider: 'CODEX', boundary: 'container-stopped' });
  expect(stopCodex).toHaveBeenCalledWith(historicalContext);
});

test('requires a user turn native session to match the current immutable binding before stop', async () => {
  bindingFind.mockResolvedValue({
    runtime: 'codex-project-adapter',
    sessionKey: 'native-session',
    externalSessionId: 'native-session',
    sandboxRoot: CONTEXT.canonicalRoot,
    policyFingerprint: CONTEXT.policyFingerprint,
  });
  loadNativeSession.mockReturnValue({
    provider: 'CODEX',
    userId: ACTOR,
    executionContext: { ...CONTEXT, projectId: 'different-project' },
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'native-turn',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    requestId: 'user-message',
    providerSessionId: 'native-session',
  })).rejects.toThrow('could not re-attest its binding and session');
  expect(stopCodex).not.toHaveBeenCalled();
});

test('uses an exact historical session context to stop a policy-and-image-drifted native turn', async () => {
  const historicalSeed = {
    ...CONTEXT,
    runtimePolicyVersion: 'portal-project-sandbox-v2',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: `sha256:${'9'.repeat(64)}`,
  };
  const historicalContext = Object.freeze({
    ...historicalSeed,
    policyFingerprint: crypto.createHash('sha256').update(JSON.stringify({
      version: historicalSeed.runtimePolicyVersion,
      egressPolicyVersion: historicalSeed.egressPolicyVersion,
      provider: 'CODEX',
      runtime: 'codex-project-adapter',
      runtimeImageDigest: historicalSeed.runtimeImageDigest,
      actorUserId: historicalSeed.userId,
      workspaceOwnerId: historicalSeed.workspaceOwnerId,
      projectId: historicalSeed.projectId,
      projectName: historicalSeed.projectName,
      canonicalRoot: historicalSeed.canonicalRoot,
      rootDevice: historicalSeed.rootDevice,
      rootInode: historicalSeed.rootInode,
      rootBirthtimeNs: historicalSeed.rootBirthtimeNs,
    })).digest('hex'),
  });
  bindingFind.mockResolvedValue({
    status: 'active',
    runtime: 'codex-project-adapter',
    sessionKey: 'native-session',
    externalSessionId: 'native-session',
    sandboxRoot: historicalContext.canonicalRoot,
    policyFingerprint: historicalContext.policyFingerprint,
  });
  loadNativeSession.mockReturnValue({
    sessionId: 'native-session',
    provider: 'CODEX',
    userId: ACTOR,
    executionContext: historicalContext,
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'native-turn',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    requestId: 'user-message',
    providerSessionId: 'native-session',
  })).resolves.toMatchObject({
    provider: 'CODEX',
    boundary: 'container-stopped',
  });
  expect(stopCodex).toHaveBeenCalledWith(historicalContext);
});

test('stops the exact historical Agent Zero generation without touching a newer policy identity', async () => {
  const historicalSeed = {
    ...CONTEXT,
    runtimePolicyVersion: 'agent-zero-project-isolation-v3',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: `sha256:${'8'.repeat(64)}`,
  };
  const historicalContext = Object.freeze({
    ...historicalSeed,
    policyFingerprint: crypto.createHash('sha256').update(JSON.stringify({
      version: historicalSeed.runtimePolicyVersion,
      egressPolicyVersion: historicalSeed.egressPolicyVersion,
      provider: 'AGENT_ZERO',
      runtime: 'agent-zero-project-sandbox-v4',
      runtimeImageDigest: historicalSeed.runtimeImageDigest,
      actorUserId: historicalSeed.userId,
      workspaceOwnerId: historicalSeed.workspaceOwnerId,
      projectId: historicalSeed.projectId,
      projectName: historicalSeed.projectName,
      canonicalRoot: historicalSeed.canonicalRoot,
      rootDevice: historicalSeed.rootDevice,
      rootInode: historicalSeed.rootInode,
      rootBirthtimeNs: historicalSeed.rootBirthtimeNs,
    })).digest('hex'),
  });
  bindingFind.mockResolvedValue({
    status: 'active',
    runtime: 'agent-zero-project-sandbox-v4',
    sessionKey: 'agent-zero-session',
    externalSessionId: 'agent-zero-session',
    sandboxRoot: historicalContext.canonicalRoot,
    policyFingerprint: historicalContext.policyFingerprint,
  });
  loadNativeSession.mockReturnValue({
    sessionId: 'agent-zero-session',
    provider: 'AGENT_ZERO',
    userId: ACTOR,
    executionContext: historicalContext,
  });
  const containerId = 'e'.repeat(64);
  discoverAgentZero.mockResolvedValue([{
    kind: 'CONTAINER',
    actorUserId: ACTOR,
    dockerId: containerId,
  }]);
  let running = true;
  egressRun.mockImplementation(async (_command: string, args: readonly string[]) => {
    if (args[0] === 'container' && args[1] === 'inspect') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([agentZeroInspect(containerId, running, historicalContext)]),
        stderr: '',
      };
    }
    if (args[0] === 'container' && args[1] === 'stop') {
      running = false;
      return { exitCode: 0, stdout: containerId, stderr: '' };
    }
    throw new Error(`Unexpected Agent Zero recovery command: ${args.join(' ')}`);
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'agent-zero-native-turn',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'AGENT_ZERO',
    runtime: 'agent-zero-project-sandbox-v4',
    requestId: 'user-message',
    providerSessionId: 'agent-zero-session',
  })).resolves.toMatchObject({ provider: 'AGENT_ZERO', boundary: 'container-stopped' });
});

test('does not treat an ambiguous Docker inspect failure as Agent Zero runtime absence', async () => {
  discoverAgentZero.mockResolvedValue([{
    kind: 'CONTAINER',
    actorUserId: ACTOR,
    dockerId: 'e'.repeat(64),
  }]);
  egressRun.mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'agent-zero-admission',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'agent-zero-project-sandbox-v4',
    requestId: 'portal-runtime-admission:qualify-agent-zero:uuid',
    providerSessionId: null,
  })).rejects.toThrow('without proving runtime absence');
  expect(egressRun).toHaveBeenCalledTimes(1);
});

test('stops and re-inspects an exact Agent Zero runtime asynchronously', async () => {
  const containerId = 'e'.repeat(64);
  discoverAgentZero.mockResolvedValue([{
    kind: 'CONTAINER',
    actorUserId: ACTOR,
    dockerId: containerId,
  }]);
  let inspectCount = 0;
  egressRun.mockImplementation(async (_command: string, args: readonly string[]) => {
    if (args[0] === 'container' && args[1] === 'inspect') {
      inspectCount += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify([agentZeroInspect(containerId, inspectCount === 1)]),
        stderr: '',
      };
    }
    if (args[0] === 'container' && args[1] === 'stop') {
      return { exitCode: 0, stdout: containerId, stderr: '' };
    }
    throw new Error(`Unexpected Agent Zero recovery command: ${args.join(' ')}`);
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'agent-zero-exact-stop',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'agent-zero-project-sandbox-v4',
    requestId: 'portal-runtime-admission:qualify-agent-zero:uuid',
    providerSessionId: null,
  })).resolves.toMatchObject({
    provider: 'AGENT_ZERO',
    boundary: 'container-stopped',
    evidence: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(egressRun.mock.calls.map(([, args]) => (args as readonly string[]).slice(0, 2)))
    .toEqual([
      ['container', 'inspect'],
      ['container', 'stop'],
      ['container', 'inspect'],
    ]);
});

test('proves Agent Zero runtime absence without issuing a Docker mutation', async () => {
  discoverAgentZero.mockResolvedValue([]);

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'agent-zero-absent',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'agent-zero-project-sandbox-v4',
    requestId: 'portal-runtime-admission:qualify-agent-zero:uuid',
    providerSessionId: null,
  })).resolves.toMatchObject({
    provider: 'AGENT_ZERO',
    boundary: 'runtime-absent',
  });
  expect(egressRun).not.toHaveBeenCalled();
});

test('refuses an ambiguous Agent Zero running state before mutation', async () => {
  const containerId = 'e'.repeat(64);
  discoverAgentZero.mockResolvedValue([{
    kind: 'CONTAINER',
    actorUserId: ACTOR,
    dockerId: containerId,
  }]);
  egressRun.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify([agentZeroInspect(containerId, 'true')]),
    stderr: '',
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'agent-zero-ambiguous-state',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'agent-zero-project-sandbox-v4',
    requestId: 'portal-runtime-admission:qualify-agent-zero:uuid',
    providerSessionId: null,
  })).rejects.toThrow('state is ambiguous');
  expect(egressRun.mock.calls.some(([, args]) => (
    Array.isArray(args) && args[0] === 'container' && args[1] === 'stop'
  ))).toBe(false);
});

test('refuses an Agent Zero recovery container whose provider identity drifted before stop', async () => {
  const containerId = 'e'.repeat(64);
  discoverAgentZero.mockResolvedValue([{
    kind: 'CONTAINER',
    actorUserId: ACTOR,
    dockerId: containerId,
  }]);
  egressRun.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify([{
      Id: containerId,
      Name: '/bridgesllm-a0p-key',
      Config: {
        Labels: {
          'managed-label': 'agent-zero-project',
          'runtime-label': 'different-provider-runtime',
          'policy-label': 'policy-v1',
          'key-label': 'f'.repeat(64),
          'project-label': PROJECT,
          'actor-label': ACTOR,
        },
      },
      State: { Running: true },
    }]),
    stderr: '',
  });

  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'agent-zero-provider-drift',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'agent-zero-project-sandbox-v4',
    requestId: 'portal-runtime-admission:qualify-agent-zero:uuid',
    providerSessionId: null,
  })).rejects.toThrow('lost its immutable identity');
  expect(egressRun.mock.calls.some(([, args]) => (
    Array.isArray(args) && args[0] === 'container' && args[1] === 'stop'
  ))).toBe(false);
});

test('returns no recovery lane for an unrecognized runtime without touching Project state', async () => {
  await expect(quiesceNativeProjectOperationAfterRestart({
    id: 'unknown',
    actorUserId: ACTOR,
    projectIdentityId: PROJECT,
    provider: 'OPENCLAW',
    runtime: 'unknown-runtime',
    requestId: 'portal-runtime-admission:unknown:uuid',
    providerSessionId: null,
  })).resolves.toBeNull();
  expect(projectIdentityFind).not.toHaveBeenCalled();
});
