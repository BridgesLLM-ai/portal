import crypto from 'crypto';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import {
  loadNativeSession,
} from '../agents/providers/NativeSessionStore';
import {
  AGENT_ZERO_PROJECT_ACTOR_LABEL,
  AGENT_ZERO_PROJECT_ID_LABEL,
  AGENT_ZERO_PROJECT_KEY_LABEL,
  AGENT_ZERO_PROJECT_MANAGED_LABEL,
  AGENT_ZERO_PROJECT_POLICY_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_COMMAND,
  AGENT_ZERO_PROJECT_ROOT,
  AGENT_ZERO_PROJECT_RUNTIME,
  AGENT_ZERO_PROJECT_RUNTIME_LABEL,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import { AGENT_ZERO_DATA_CONTAINER_PATH } from '../agents/providers/agentZero/AgentZeroRuntime';
import { AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER } from '../agents/providers/agentZero/AgentZeroProjectImage';
import {
  discoverAgentZeroProjectRuntimeResources,
} from '../agents/providers/agentZero/AgentZeroProjectCleanup';
import {
  ANTIGRAVITY_PROJECT_RUNTIME_PROFILE,
} from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';
import {
  CLAUDE_CODE_PROJECT_RUNTIME_PROFILE,
} from '../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox';
import {
  stopCodexProjectRuntimesForRecoveryContext,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  stopNativeCliProjectRuntimesForRecoveryContext,
} from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import {
  stopOllamaProjectRuntimesForRecoveryContext,
} from '../agents/providers/ollama/OllamaProjectToolRuntime';
import { prisma } from '../config/database';
import { projectEgressCommandExecutor } from './projectEgressPlane';
import {
  buildUnqualifiedProjectSandboxExecutionContext,
} from './projectChatKernel';
import { PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX } from './projectChatTurnLease';
import {
  getProjectChatProviderRuntimeDescriptor,
  type NativeProjectProvider,
} from './projectChatProviderRegistry';

export const NATIVE_PROJECT_RESTART_RECOVERY_PROVIDERS = Object.freeze([
  'CLAUDE_CODE',
  'CODEX',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
] as const satisfies readonly NativeProjectProvider[]);

const NATIVE_PROVIDER_SET = new Set<string>(NATIVE_PROJECT_RESTART_RECOVERY_PROVIDERS);

export interface NativeProjectRestartRecoveryInput {
  id: string;
  actorUserId: string;
  projectIdentityId: string;
  provider: string;
  runtime: string;
  requestId: string;
  providerSessionId: string | null;
  resultMetadata?: unknown;
}

export interface NativeProjectRestartQuiescenceEvidence {
  provider: NativeProjectProvider;
  boundary: 'container-stopped' | 'container-restarted' | 'runtime-absent';
  evidence: string;
}

function stableEvidence(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRuntimeAdmission(input: NativeProjectRestartRecoveryInput): boolean {
  return input.requestId.startsWith(PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX);
}

export function nativeProjectRestartRecoveryTargetProvider(
  runtimeInput: unknown,
): NativeProjectProvider | null {
  const runtime = String(runtimeInput || '').trim();
  for (const provider of NATIVE_PROJECT_RESTART_RECOVERY_PROVIDERS) {
    if (getProjectChatProviderRuntimeDescriptor(provider).runtime === runtime) return provider;
  }
  return null;
}

function nativeProjectImmutableContextMatches(
  actual: ProjectSandboxExecutionContext,
  expected: ProjectSandboxExecutionContext,
): boolean {
  return actual.scope === 'PROJECT_SANDBOX'
    && actual.source === 'PORTAL_SERVER'
    && actual.userId === expected.userId
    && actual.projectId === expected.projectId
    && actual.workspaceOwnerId === expected.workspaceOwnerId
    && actual.projectName === expected.projectName
    && path.resolve(actual.canonicalRoot) === path.resolve(expected.canonicalRoot)
    && actual.rootDevice === expected.rootDevice
    && actual.rootInode === expected.rootInode
    && actual.rootBirthtimeNs === expected.rootBirthtimeNs;
}

function contextPolicyFingerprint(
  context: ProjectSandboxExecutionContext,
  provider: NativeProjectProvider,
  runtime: string,
): string {
  return stableEvidence({
    version: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider,
    runtime,
    runtimeImageDigest: context.runtimeImageDigest,
    actorUserId: context.userId,
    workspaceOwnerId: context.workspaceOwnerId,
    projectId: context.projectId,
    projectName: context.projectName,
    canonicalRoot: context.canonicalRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
  });
}

function validHistoricalContext(
  context: ProjectSandboxExecutionContext,
  provider: NativeProjectProvider,
  runtime: string,
): boolean {
  return /^[a-z0-9][a-z0-9.-]{2,127}$/.test(context.runtimePolicyVersion)
    && /^[a-z0-9][a-z0-9.-]{2,127}$/.test(context.egressPolicyVersion)
    && /^sha256:[a-f0-9]{64}$/.test(context.runtimeImageDigest)
    && context.policyFingerprint === contextPolicyFingerprint(context, provider, runtime);
}

function persistedRuntimeAdmissionContext(
  metadata: unknown,
): ProjectSandboxExecutionContext | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (
    record.runtimeAdmissionMetadataVersion === undefined
    && record.recoveryExecutionContext === undefined
  ) return null;
  if (
    record.runtimeAdmissionMetadataVersion !== 1
    || !record.recoveryExecutionContext
    || typeof record.recoveryExecutionContext !== 'object'
    || Array.isArray(record.recoveryExecutionContext)
  ) {
    throw new Error('Native Project runtime admission recovery context is malformed');
  }
  const context = record.recoveryExecutionContext as Record<string, unknown>;
  if (context.scope !== 'PROJECT_SANDBOX' || context.source !== 'PORTAL_SERVER') {
    throw new Error('Native Project runtime admission recovery context is malformed');
  }
  try {
    return createProjectSandboxExecutionContext({
      userId: String(context.userId || ''),
      projectId: String(context.projectId || ''),
      workspaceOwnerId: String(context.workspaceOwnerId || ''),
      projectName: String(context.projectName || ''),
      canonicalRoot: String(context.canonicalRoot || ''),
      rootDevice: String(context.rootDevice || ''),
      rootInode: String(context.rootInode || ''),
      rootBirthtimeNs: String(context.rootBirthtimeNs || ''),
      runtimePolicyVersion: String(context.runtimePolicyVersion || ''),
      egressPolicyVersion: String(context.egressPolicyVersion || ''),
      runtimeImageDigest: String(context.runtimeImageDigest || ''),
      policyFingerprint: String(context.policyFingerprint || ''),
    });
  } catch {
    throw new Error('Native Project runtime admission recovery context is malformed');
  }
}

function parseDockerInspect(output: string): Record<string, any> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Agent Zero Project restart inspection returned invalid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Agent Zero Project restart inspection returned an invalid shape');
  }
  if (parsed.length === 0) return null;
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    throw new Error('Agent Zero Project restart inspection returned an invalid shape');
  }
  return parsed[0] as Record<string, any>;
}

function dockerInspectProvesContainerAbsent(input: {
  stdout: string;
  stderr: string;
}): boolean {
  const text = `${input.stdout}\n${input.stderr}`.toLowerCase();
  return text.includes('no such object')
    || text.includes('no such container')
    || (text.includes('container') && text.includes('not found'))
    || (text.includes('object') && text.includes('not found'));
}

function assertAgentZeroRestartContainer(
  inspect: Record<string, any>,
  context: ProjectSandboxExecutionContext,
  expectedContainerId: string,
): void {
  const containerId = String(inspect.Id || '').toLowerCase();
  const labels = inspect.Config?.Labels || {};
  const key = crypto.createHash('sha256').update(JSON.stringify({
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    policy: context.runtimePolicyVersion,
    userId: context.userId,
    projectId: context.projectId,
    canonicalRoot: context.canonicalRoot,
    policyFingerprint: context.policyFingerprint,
  })).digest('hex');
  const containerName = `bridgesllm-a0p-${key.slice(0, 24)}`;
  const dataVolume = `bridgesllm-a0p-${key.slice(0, 24)}-usr`;
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
  const projectMount = mounts.find((mount: any) => mount?.Destination === AGENT_ZERO_PROJECT_ROOT);
  const dataMount = mounts.find((mount: any) => mount?.Destination === AGENT_ZERO_DATA_CONTAINER_PATH);
  if (
    !/^[a-f0-9]{64}$/.test(containerId)
    || containerId !== expectedContainerId
    || String(inspect.Name || '').replace(/^\//, '') !== containerName
    || String(inspect.Image || '').toLowerCase() !== context.runtimeImageDigest.toLowerCase()
    || String(inspect.Config?.Image || '').toLowerCase() !== context.runtimeImageDigest.toLowerCase()
    || String(inspect.Config?.User || '') !== AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER
    || String(inspect.Config?.WorkingDir || '') !== '/a0'
    || JSON.stringify(inspect.Config?.Entrypoint || []) !== '[]'
    || JSON.stringify(inspect.Config?.Cmd || []) !== JSON.stringify(AGENT_ZERO_PROJECT_IMAGE_COMMAND)
    || labels[AGENT_ZERO_PROJECT_MANAGED_LABEL] !== 'agent-zero-project'
    || labels[AGENT_ZERO_PROJECT_RUNTIME_LABEL] !== AGENT_ZERO_PROJECT_RUNTIME
    || labels[AGENT_ZERO_PROJECT_POLICY_LABEL] !== context.runtimePolicyVersion
    || labels[AGENT_ZERO_PROJECT_KEY_LABEL] !== key
    || labels[AGENT_ZERO_PROJECT_ID_LABEL] !== context.projectId
    || labels[AGENT_ZERO_PROJECT_ACTOR_LABEL] !== context.userId
    || mounts.length !== 2
    || projectMount?.Type !== 'bind'
    || path.resolve(String(projectMount?.Source || '')) !== context.canonicalRoot
    || projectMount?.RW !== true
    || (projectMount?.Propagation && projectMount.Propagation !== 'rprivate')
    || dataMount?.Type !== 'volume'
    || dataMount?.Name !== dataVolume
    || dataMount?.RW !== true
  ) {
    throw new Error('Agent Zero Project restart target lost its immutable identity');
  }
}

async function stopExactAgentZeroRuntime(
  context: ProjectSandboxExecutionContext,
): Promise<readonly string[]> {
  const resources = await discoverAgentZeroProjectRuntimeResources(
    context.projectId,
    { knownActorIds: [context.userId] },
    projectEgressCommandExecutor,
  );
  const containers = resources.filter((entry) => entry.kind === 'CONTAINER');
  if (containers.some((entry) => entry.actorUserId !== context.userId)) {
    throw new Error('Agent Zero Project restart discovery crossed the authenticated actor boundary');
  }
  if (containers.length === 0) return Object.freeze([]);
  if (containers.length > 2) {
    throw new Error('Agent Zero Project restart discovery returned an ambiguous runtime inventory');
  }
  const attested: Array<{ containerId: string; running: boolean }> = [];
  for (const resource of containers) {
    const containerId = String(resource.dockerId || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error('Agent Zero Project restart discovery returned an unsafe container identity');
    }
    const beforeResult = await projectEgressCommandExecutor.run(
      'docker',
      ['container', 'inspect', containerId],
      { allowExitCodes: [0, 1] },
    );
    if (beforeResult.exitCode === 1) {
      if (dockerInspectProvesContainerAbsent(beforeResult)) continue;
      throw new Error(
        'Agent Zero Project restart inspection failed without proving runtime absence',
      );
    }
    const before = parseDockerInspect(beforeResult.stdout);
    if (!before) continue;
    assertAgentZeroRestartContainer(before, context, containerId);
    if (typeof before.State?.Running !== 'boolean') {
      throw new Error('Agent Zero Project restart target state is ambiguous');
    }
    attested.push({ containerId, running: before.State.Running });
  }

  const stopped: string[] = [];
  for (const target of attested) {
    const { containerId } = target;
    if (target.running) {
      await projectEgressCommandExecutor.run(
        'docker',
        ['container', 'stop', '--time', '10', containerId],
        { allowExitCodes: [0, 1] },
      );
    }
    const afterResult = await projectEgressCommandExecutor.run(
      'docker',
      ['container', 'inspect', containerId],
      { allowExitCodes: [0, 1] },
    );
    if (afterResult.exitCode === 0) {
      const after = parseDockerInspect(afterResult.stdout);
      if (!after) throw new Error('Agent Zero Project restart target disappeared ambiguously');
      assertAgentZeroRestartContainer(after, context, containerId);
      if (after.State?.Running !== false) {
        throw new Error('Agent Zero Project runtime remained active after restart recovery stop');
      }
    } else if (!dockerInspectProvesContainerAbsent(afterResult)) {
      throw new Error(
        'Agent Zero Project restart inspection failed without proving stopped runtime absence',
      );
    }
    stopped.push(containerId);
  }
  return Object.freeze(stopped);
}

async function buildExactRecoveryContext(input: NativeProjectRestartRecoveryInput & {
  targetProvider: NativeProjectProvider;
}): Promise<ProjectSandboxExecutionContext> {
  const projectIdentity = await prisma.projectIdentity.findUnique({
    where: { id: input.projectIdentityId },
  });
  if (
    !projectIdentity
    || projectIdentity.lifecycleStatus !== 'ACTIVE'
  ) {
    throw new Error('Native Project restart recovery lost its immutable Project identity');
  }
  const projectDir = path.resolve(projectIdentity.canonicalRoot);
  const workspaceRoot = path.dirname(projectDir);
  const projectsRoot = path.dirname(workspaceRoot);
  const context = buildUnqualifiedProjectSandboxExecutionContext(input.targetProvider, {
    actorUserId: input.actorUserId,
    workspaceOwnerId: projectIdentity.workspaceOwnerId,
    projectName: projectIdentity.projectName,
    projectIdentity,
    projectDir,
    projectsRoot,
  });

  if (!isRuntimeAdmission(input)) {
    if (input.provider !== input.targetProvider || !input.providerSessionId) {
      throw new Error('Native Project restart turn lacks its exact provider session identity');
    }
    const [binding, nativeSession] = await Promise.all([
      prisma.projectChatProviderBinding.findUnique({
        where: {
          userId_projectId_provider: {
            userId: input.actorUserId,
            projectId: input.projectIdentityId,
            provider: input.targetProvider,
          },
        },
      }),
      Promise.resolve(loadNativeSession(input.targetProvider, input.providerSessionId)),
    ]);
    const boundSessions = new Set([
      String(binding?.sessionKey || '').trim(),
      String(binding?.externalSessionId || '').trim(),
    ].filter(Boolean));
    const historicalContext = nativeSession?.executionContext;
    if (
      !binding
      || binding.status !== 'active'
      || binding.runtime !== input.runtime
      || !boundSessions.has(input.providerSessionId)
      || !nativeSession
      || nativeSession.sessionId !== input.providerSessionId
      || nativeSession.provider !== input.targetProvider
      || nativeSession.userId !== input.actorUserId
      || !historicalContext
      || historicalContext.scope !== 'PROJECT_SANDBOX'
      || !nativeProjectImmutableContextMatches(historicalContext, context)
      || !validHistoricalContext(historicalContext, input.targetProvider, input.runtime)
      || binding.sandboxRoot !== historicalContext.canonicalRoot
      || binding.policyFingerprint !== historicalContext.policyFingerprint
    ) {
      throw new Error('Native Project restart turn could not re-attest its binding and session');
    }
    return historicalContext;
  }
  const admissionContext = persistedRuntimeAdmissionContext(input.resultMetadata);
  if (admissionContext) {
    if (
      !nativeProjectImmutableContextMatches(admissionContext, context)
      || !validHistoricalContext(admissionContext, input.targetProvider, input.runtime)
    ) {
      throw new Error('Native Project runtime admission could not re-attest its recovery context');
    }
    return admissionContext;
  }
  return context;
}

/**
 * Terminate the provider process boundary for one expired operation after a
 * Portal restart. The durable CAS/lease checks remain in the caller and are
 * repeated transactionally before release; this function only supplies the
 * provider-specific, exact actor/project quiescence proof.
 */
export async function quiesceNativeProjectOperationAfterRestart(
  input: NativeProjectRestartRecoveryInput,
): Promise<NativeProjectRestartQuiescenceEvidence | null> {
  const targetProvider = nativeProjectRestartRecoveryTargetProvider(input.runtime);
  if (!targetProvider || !NATIVE_PROVIDER_SET.has(targetProvider)) return null;
  const context = await buildExactRecoveryContext({ ...input, targetProvider });
  let boundary: NativeProjectRestartQuiescenceEvidence['boundary'] = 'container-stopped';
  let stoppedIdentities: readonly string[] = [];

  switch (targetProvider) {
    case 'CODEX':
      stoppedIdentities = await stopCodexProjectRuntimesForRecoveryContext(context);
      break;
    case 'CLAUDE_CODE':
      stoppedIdentities = await stopNativeCliProjectRuntimesForRecoveryContext(
        context,
        CLAUDE_CODE_PROJECT_RUNTIME_PROFILE,
      );
      break;
    case 'GEMINI':
      stoppedIdentities = await stopNativeCliProjectRuntimesForRecoveryContext(
        context,
        ANTIGRAVITY_PROJECT_RUNTIME_PROFILE,
      );
      break;
    case 'AGENT_ZERO': {
      stoppedIdentities = await stopExactAgentZeroRuntime(context);
      break;
    }
    case 'OLLAMA': {
      stoppedIdentities = await stopOllamaProjectRuntimesForRecoveryContext(context);
      break;
    }
    default: {
      const exhaustive: never = targetProvider;
      return exhaustive;
    }
  }
  if (stoppedIdentities.length === 0) boundary = 'runtime-absent';
  return Object.freeze({
    provider: targetProvider,
    boundary,
    evidence: stableEvidence({
      version: 1,
      turnId: input.id,
      actorUserId: input.actorUserId,
      projectIdentityId: input.projectIdentityId,
      provider: targetProvider,
      runtime: input.runtime,
      boundary,
      stoppedIdentities,
    }),
  });
}
