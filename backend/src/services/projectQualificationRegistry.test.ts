import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import { AgentRegistry } from '../agents';
import type { AgentProvider } from '../agents/AgentProvider.interface';
import type { ProjectEgressCommandExecutor, ProjectEgressCommandResult } from './projectEgressPlane';
import { buildProjectEgressPlaneSpec } from './projectEgressPlane';
import type { CodexProjectEgressRuntimeHandle } from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  CODEX_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import { NativeProviderDiagnosticError } from '../agents/providers/native/NativeProviderDiagnostics';
import { ensureProjectChatProviderBinding } from './projectChatKernel';
import { withOllamaAuthorityMutationFence } from './ollamaAuthorityBarrier';
import * as projectProviderRegistry from './projectChatProviderRegistry';
import {
  CODEX_PROJECT_QUALIFICATION_VERSION,
  CLAUDE_CODE_PROJECT_QUALIFICATION_VERSION,
  ANTIGRAVITY_PROJECT_QUALIFICATION_VERSION,
  AGENT_ZERO_PROJECT_QUALIFICATION_VERSION,
  OLLAMA_PROJECT_QUALIFICATION_REQUIRED_PROBES,
  OLLAMA_PROJECT_QUALIFICATION_VERSION,
  OPENCLAW_PROJECT_QUALIFICATION_VERSION,
  __projectQualificationRegistryTest,
  assertCodexProjectQualificationGrant,
  assertOpenClawProjectQualificationGrant,
  getCodexProjectQualificationStatus,
  getOpenClawProjectQualificationStatus,
  getProjectQualificationStatus,
  listProjectQualificationLanes,
  qualificationMacDomainFor,
  qualifyCodexProject,
  qualifyOpenClawProject,
  qualifyProjectProvider,
  requireProjectQualification,
  assertProjectQualificationGrant,
  requireCodexProjectQualification,
  requireOpenClawProjectQualification,
} from './openclawProjectQualification';

const ACTOR = 'provider-qualification-user';
const PROJECT_ID = '8cf97148-0606-41ab-b0ee-2aece221a936';
const RUNTIME_IMAGE = `sha256:${'1'.repeat(64)}`;
const PROXY_IMAGE = `sha256:${'2'.repeat(64)}`;
const SECRET = Buffer.alloc(32, 17).toString('base64url');
const NOW = new Date('2026-07-20T02:00:00.000Z');

let root: string;
let projectRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-provider-qualification-'));
  projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function context(
  overrides: Partial<ReturnType<typeof createProjectSandboxExecutionContext>> = {},
) {
  const stat = fs.statSync(projectRoot, { bigint: true });
  return createProjectSandboxExecutionContext({
    userId: ACTOR,
    projectId: PROJECT_ID,
    workspaceOwnerId: ACTOR,
    projectName: 'alpha',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: 'portal-project-sandbox-v2',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: RUNTIME_IMAGE,
    policyFingerprint: '3'.repeat(64),
    ...overrides,
  });
}

type TestProvider = 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA';
const AGENT_ZERO_SELECTION = Object.freeze({
  providerId: 'codex_oauth' as const,
  model: 'gpt-5.2-codex',
});
const OLLAMA_SELECTION = Object.freeze({
  model: 'qwen3.5:0.8b',
  digest: `sha256:${'c'.repeat(64)}` as const,
  capabilities: Object.freeze(['completion', 'tools']),
  backendKind: 'LOCAL' as const,
  backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
  backendGeneration: null,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function egress(provider: TestProvider, ctx = context()) {
  return {
    identity: { actorId: ctx.userId, projectId: ctx.projectId, provider },
    proxyImage: PROXY_IMAGE,
    token: crypto.createHash('sha256').update(provider).digest('base64url'),
  };
}

function dependencies(provider: TestProvider, evidenceRoot: string, ctx = context()) {
  const spec = buildProjectEgressPlaneSpec(egress(provider, ctx));
  return {
    now: () => new Date(NOW),
    evidenceRoot,
    secret: SECRET,
    ttlMs: 60 * 60_000,
    runProbes: jest.fn(async () => ({
      sandbox: {
        agentId: `qualification-${provider.toLowerCase()}`,
        sessionKey: `qualification:${provider.toLowerCase()}`,
        containerName: `qualified-${provider.toLowerCase()}-runtime`,
        configHash: '4'.repeat(64),
        runtimeFingerprint: '5'.repeat(64),
        egressPolicyFingerprint: spec.policyFingerprint,
        attestedAt: NOW.toISOString(),
      },
      spec,
      runtimeContainerId: '6'.repeat(64),
      runtimeContainerStartedAt: NOW.toISOString(),
      proxyContainerId: '7'.repeat(64),
      internalNetworkId: '8'.repeat(64),
      publicNetworkId: '9'.repeat(64),
      modelId: provider === 'AGENT_ZERO'
        ? AGENT_ZERO_SELECTION.model
        : provider === 'CODEX' ? 'gpt-5.5' : 'openai/gpt-5.5',
      modelProviderId: provider === 'AGENT_ZERO' ? AGENT_ZERO_SELECTION.providerId : null,
      modelDigest: null,
      executionProviderId: provider === 'OPENCLAW' ? 'openai' : null,
      executionRuntimeKind: provider === 'OPENCLAW' ? 'openclaw-embedded' : null,
      modelToolChallengeSha256: provider === 'OPENCLAW' ? 'c'.repeat(64) : null,
      modelResponseSha256: 'a'.repeat(64),
      probes: __projectQualificationRegistryTest.requiredProbesFor(provider).map((id) => ({
        id,
        passed: true as const,
        observedAt: NOW.toISOString(),
        evidenceSha256: 'b'.repeat(64),
      })),
    })),
    attestFinalEvidenceRuntime: jest.fn(async () => undefined),
    resolveAgentZeroModelSelection: jest.fn(async () => AGENT_ZERO_SELECTION),
  };
}

function exactQualificationPlane() {
  return Object.freeze({
    internalNetworkId: '8'.repeat(64),
    publicNetworkId: '9'.repeat(64),
    proxyContainerId: '7'.repeat(64),
    internalNetwork: {},
    publicNetwork: {},
    proxyContainer: {},
  });
}

function qualificationRuntimeOverrides(
  provider: 'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE',
  ctx: ReturnType<typeof context>,
  executor: { run: jest.Mock },
  planeBarrier: jest.Mock,
  identityMethod:
    | 'attestOpenClawIdentityRuntime'
    | 'attestCodexIdentityRuntime'
    | 'attestNativeCliIdentityRuntime',
  identityBarrier: jest.Mock,
): any {
  const egressConfig = egress(provider, ctx);
  const common: any = {
    executor,
    attestEgressPlane: planeBarrier,
    [identityMethod]: identityBarrier,
  };
  if (provider === 'OPENCLAW') {
    common.ensureSandbox = jest.fn(async () => ({
      agentId: 'p4oc-qualified-agent',
      sessionKey: 'agent:p4oc-qualified-agent:portal-project',
      containerId: '6'.repeat(64),
      containerStartedAt: NOW.toISOString(),
      containerName: 'qualified-openclaw-runtime',
      configHash: '4'.repeat(64),
      runtimeFingerprint: '5'.repeat(64),
      egressPolicyFingerprint: buildProjectEgressPlaneSpec(egressConfig).policyFingerprint,
      attestedAt: NOW.toISOString(),
    }));
  } else if (provider === 'CODEX') {
    common.ensureCodexRuntime = jest.fn(async () => ({
      containerId: '6'.repeat(64),
      containerName: 'qualified-codex-runtime',
      runtimeFingerprint: '5'.repeat(64),
      egressPolicyFingerprint: buildProjectEgressPlaneSpec(egressConfig).policyFingerprint,
      proxyAddress: '172.30.0.2',
      proxyEnvironment: {},
      startedAt: NOW.toISOString(),
    }));
  } else {
    common.ensureNativeCliRuntime = jest.fn(async () => ({
      provider: 'CLAUDE_CODE',
      containerId: '6'.repeat(64),
      containerName: 'qualified-claude-runtime',
      runtimeFingerprint: '5'.repeat(64),
      egressPolicyFingerprint: buildProjectEgressPlaneSpec(egressConfig).policyFingerprint,
      proxyAddress: '172.30.0.2',
      proxyEnvironment: {},
      startedAt: NOW.toISOString(),
    }));
  }
  return common;
}

function agentZeroQualificationStatus(
  ctx: ReturnType<typeof context>,
  policyFingerprint: string,
) {
  return {
    ready: true,
    selectable: true,
    qualificationCurrent: true,
    descriptor: {
      actorUserId: ctx.userId,
      projectIdentityId: ctx.projectId,
      canonicalProjectRoot: ctx.canonicalRoot,
      containerName: 'qualified-agent-zero-runtime',
    },
    imageRef: ctx.runtimeImageDigest,
    containerId: '6'.repeat(64),
    containerStartedAt: NOW.toISOString(),
    runtimeFingerprint: '5'.repeat(64),
    egressPolicyFingerprint: policyFingerprint,
    bridgeGatewayIpv4: '172.30.0.1',
    runtimeIpv4: '172.30.0.3',
    modelSelection: AGENT_ZERO_SELECTION,
  };
}

function exactAgentZeroFinalPlane(
  spec: ReturnType<typeof buildProjectEgressPlaneSpec>,
  runtimeName: string,
) {
  return Object.freeze({
    internalNetworkId: '8'.repeat(64),
    publicNetworkId: '9'.repeat(64),
    proxyContainerId: '7'.repeat(64),
    internalNetwork: {
      Containers: {
        ['6'.repeat(64)]: { Name: runtimeName },
        ['7'.repeat(64)]: { Name: spec.proxyContainerName },
      },
    },
    publicNetwork: {
      Containers: {
        ['7'.repeat(64)]: { Name: spec.proxyContainerName },
      },
    },
    proxyContainer: { Image: PROXY_IMAGE },
  });
}

function agentZeroFinalBundle(
  spec: ReturnType<typeof buildProjectEgressPlaneSpec>,
  status: ReturnType<typeof agentZeroQualificationStatus>,
) {
  return {
    sandbox: {
      agentId: 'qualification-agent-zero',
      sessionKey: 'qualification:agent-zero',
      containerName: status.descriptor.containerName,
      configHash: '4'.repeat(64),
      runtimeFingerprint: status.runtimeFingerprint,
      egressPolicyFingerprint: status.egressPolicyFingerprint,
      attestedAt: NOW.toISOString(),
    },
    spec,
    runtimeContainerId: status.containerId,
    runtimeContainerStartedAt: status.containerStartedAt,
    proxyContainerId: '7'.repeat(64),
    internalNetworkId: '8'.repeat(64),
    publicNetworkId: '9'.repeat(64),
    modelId: AGENT_ZERO_SELECTION.model,
    modelProviderId: AGENT_ZERO_SELECTION.providerId,
    modelDigest: null,
    modelResponseSha256: 'a'.repeat(64),
    probes: [],
    opaqueRuntime: { status, modelSelection: AGENT_ZERO_SELECTION },
  };
}

const sender = { label: 'Owner', userId: ACTOR, role: 'OWNER' };

describe('Project qualification provider registry', () => {
  test('publishes provider-separated lanes, versions, MAC domains, and default roots', () => {
    expect(listProjectQualificationLanes()).toEqual([
      {
        provider: 'OPENCLAW',
        displayName: 'OpenClaw',
        qualificationVersion: OPENCLAW_PROJECT_QUALIFICATION_VERSION,
      },
      {
        provider: 'CODEX',
        displayName: 'Codex',
        qualificationVersion: CODEX_PROJECT_QUALIFICATION_VERSION,
      },
      {
        provider: 'CLAUDE_CODE',
        displayName: 'Claude Code',
        qualificationVersion: CLAUDE_CODE_PROJECT_QUALIFICATION_VERSION,
      },
      {
        provider: 'AGENT_ZERO',
        displayName: 'Agent Zero',
        qualificationVersion: AGENT_ZERO_PROJECT_QUALIFICATION_VERSION,
      },
      {
        provider: 'GEMINI',
        displayName: 'Google Antigravity',
        qualificationVersion: ANTIGRAVITY_PROJECT_QUALIFICATION_VERSION,
      },
      {
        provider: 'OLLAMA',
        displayName: 'Ollama',
        qualificationVersion: OLLAMA_PROJECT_QUALIFICATION_VERSION,
      },
    ]);
    expect(new Set([
      qualificationMacDomainFor('OPENCLAW'),
      qualificationMacDomainFor('CODEX'),
      qualificationMacDomainFor('CLAUDE_CODE'),
      qualificationMacDomainFor('AGENT_ZERO'),
      qualificationMacDomainFor('GEMINI'),
      qualificationMacDomainFor('OLLAMA'),
    ])).toHaveProperty('size', 6);

    const previous = process.env.PORTAL_PROJECT_QUALIFICATION_ROOT;
    process.env.PORTAL_PROJECT_QUALIFICATION_ROOT = path.join(root, 'evidence-base');
    try {
      expect(__projectQualificationRegistryTest.defaultEvidenceRoot('OPENCLAW'))
        .toBe(path.join(root, 'evidence-base', 'openclaw'));
      expect(__projectQualificationRegistryTest.defaultEvidenceRoot('CODEX'))
        .toBe(path.join(root, 'evidence-base', 'codex'));
      expect(__projectQualificationRegistryTest.defaultEvidenceRoot('CLAUDE_CODE'))
        .toBe(path.join(root, 'evidence-base', 'claude_code'));
      expect(__projectQualificationRegistryTest.defaultEvidenceRoot('AGENT_ZERO'))
        .toBe(path.join(root, 'evidence-base', 'agent_zero'));
      expect(__projectQualificationRegistryTest.defaultEvidenceRoot('GEMINI'))
        .toBe(path.join(root, 'evidence-base', 'gemini'));
      expect(__projectQualificationRegistryTest.defaultEvidenceRoot('OLLAMA'))
        .toBe(path.join(root, 'evidence-base', 'ollama'));
    } finally {
      if (previous === undefined) delete process.env.PORTAL_PROJECT_QUALIFICATION_ROOT;
      else process.env.PORTAL_PROJECT_QUALIFICATION_ROOT = previous;
    }
  });

  test.each([
    ['OPENCLAW', 'portal-project-sandbox-v2', 'attestOpenClawIdentityRuntime'],
    ['CODEX', CODEX_PROJECT_RUNTIME_POLICY_VERSION, 'attestCodexIdentityRuntime'],
    ['CLAUDE_CODE', 'portal-claude-code-project-sandbox-v1', 'attestNativeCliIdentityRuntime'],
  ] as const)(
    '%s qualification rejects a post-ensure raw runtime identity claimant before evidence',
    async (provider, runtimePolicyVersion, identityMethod) => {
      const ctx = context({ runtimePolicyVersion });
      const egressConfig = egress(provider, ctx);
      const executor = { run: jest.fn() };
      const identityRace = Object.assign(
        new Error('runtime identity inventory changed after ensure'),
        { code: 'RUNTIME_IDENTITY_INVENTORY' },
      );
      let identityRounds = 0;
      const identityBarrier = jest.fn(async () => {
        identityRounds += 1;
        if (identityRounds === 2) throw identityRace;
      });
      const planeBarrier = jest.fn(async () => exactQualificationPlane());
      const overrides = qualificationRuntimeOverrides(
        provider,
        ctx,
        executor,
        planeBarrier,
        identityMethod,
        identityBarrier,
      );
      const deps = __projectQualificationRegistryTest.qualificationDefaults(
        provider,
        overrides,
      );

      await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES[
        provider
      ].attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_INVENTORY' });
      expect(identityBarrier).toHaveBeenCalledWith(expect.objectContaining({
        containerId: '6'.repeat(64),
        spec: expect.objectContaining({
          internalNetworkName: expect.any(String),
        }),
      }));
      expect(identityBarrier).toHaveBeenCalledTimes(2);
      expect(planeBarrier).toHaveBeenCalledTimes(2);
      expect(executor.run).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['OPENCLAW', 'portal-project-sandbox-v2', 'attestOpenClawIdentityRuntime'],
    ['CODEX', CODEX_PROJECT_RUNTIME_POLICY_VERSION, 'attestCodexIdentityRuntime'],
    ['CLAUDE_CODE', 'portal-claude-code-project-sandbox-v1', 'attestNativeCliIdentityRuntime'],
  ] as const)(
    '%s qualification rejects an immutable egress-plane substitution between rounds',
    async (provider, runtimePolicyVersion, identityMethod) => {
      const ctx = context({ runtimePolicyVersion });
      const egressConfig = egress(provider, ctx);
      const executor = { run: jest.fn() };
      const identityBarrier = jest.fn(async () => undefined);
      let planeRounds = 0;
      const planeBarrier = jest.fn(async () => {
        planeRounds += 1;
        const exact = exactQualificationPlane();
        return planeRounds === 1
          ? exact
          : { ...exact, internalNetworkId: 'a'.repeat(64) };
      });
      const deps = __projectQualificationRegistryTest.qualificationDefaults(
        provider,
        qualificationRuntimeOverrides(
          provider,
          ctx,
          executor,
          planeBarrier,
          identityMethod,
          identityBarrier,
        ),
      );

      await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES[
        provider
      ].attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'PLANE_IDENTITY_RACE' });
      expect(planeBarrier).toHaveBeenCalledTimes(2);
      expect(identityBarrier).toHaveBeenCalledTimes(1);
      expect(executor.run).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['OPENCLAW', 'portal-project-sandbox-v2', 'attestOpenClawIdentityRuntime'],
    ['CODEX', CODEX_PROJECT_RUNTIME_POLICY_VERSION, 'attestCodexIdentityRuntime'],
    ['CLAUDE_CODE', 'portal-claude-code-project-sandbox-v1', 'attestNativeCliIdentityRuntime'],
  ] as const)(
    '%s qualification rejects a same-ID runtime restart after its identity barriers',
    async (provider, runtimePolicyVersion, identityMethod) => {
      const ctx = context({ runtimePolicyVersion });
      const egressConfig = egress(provider, ctx);
      const executor = {
        run: jest.fn(async () => ({
          stdout: JSON.stringify([{
            Id: '6'.repeat(64),
            State: {
              Running: true,
              StartedAt: '2026-07-19T13:00:00.000Z',
            },
          }]),
          stderr: '',
          exitCode: 0,
        })),
      };
      const identityBarrier = jest.fn(async () => undefined);
      const planeBarrier = jest.fn(async () => exactQualificationPlane());
      const deps = __projectQualificationRegistryTest.qualificationDefaults(
        provider,
        qualificationRuntimeOverrides(
          provider,
          ctx,
          executor,
          planeBarrier,
          identityMethod,
          identityBarrier,
        ),
      );

      await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES[
        provider
      ].attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_RACE' });
      expect(executor.run).toHaveBeenCalledWith(
        'docker',
        [
          '--host', 'unix:///var/run/docker.sock',
          'container', 'inspect', '6'.repeat(64),
        ],
        { allowExitCodes: [0] },
      );
      expect(identityBarrier).toHaveBeenCalledTimes(2);
      expect(planeBarrier).toHaveBeenCalledTimes(2);
    },
  );

  test('Agent Zero qualification rejects an extra raw runtime claimant after live qualification', async () => {
    const ctx = context();
    const egressConfig = egress('AGENT_ZERO', ctx);
    const spec = buildProjectEgressPlaneSpec(egressConfig);
    const status = agentZeroQualificationStatus(ctx, spec.policyFingerprint);
    const identityRace = Object.assign(
      new Error('Agent Zero raw runtime identity inventory changed'),
      { code: 'RUNTIME_IDENTITY_INVENTORY' },
    );
    let identityRounds = 0;
    const identityBarrier = jest.fn(() => {
      identityRounds += 1;
      if (identityRounds === 2) throw identityRace;
    });
    const planeBarrier = jest.fn(async () => exactQualificationPlane());
    const executor = { run: jest.fn() };
    const deps = __projectQualificationRegistryTest.qualificationDefaults('AGENT_ZERO', {
      executor,
      resolveAgentZeroModelSelection: jest.fn(async () => AGENT_ZERO_SELECTION),
      convergeAgentZeroRuntime: jest.fn(async () => status as any),
      qualifyAgentZeroRuntime: jest.fn(async () => status as any),
      attestEgressPlane: planeBarrier,
      attestAgentZeroIdentityRuntime: identityBarrier,
    });

    await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES
      .AGENT_ZERO.attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        agentZeroModelSelection: AGENT_ZERO_SELECTION,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_INVENTORY' });
    expect(identityBarrier).toHaveBeenCalledWith(expect.objectContaining({
      expectedContainerId: '6'.repeat(64),
      expectedContainerStartedAt: NOW.toISOString(),
      expectedInternalNetworkId: '8'.repeat(64),
    }));
    expect(identityBarrier).toHaveBeenCalledTimes(2);
    expect(planeBarrier).toHaveBeenCalledTimes(2);
    expect(executor.run).not.toHaveBeenCalled();
  });

  test('Agent Zero qualification rejects plane substitution before the immutable runtime snapshot', async () => {
    const ctx = context();
    const egressConfig = egress('AGENT_ZERO', ctx);
    const spec = buildProjectEgressPlaneSpec(egressConfig);
    const status = agentZeroQualificationStatus(ctx, spec.policyFingerprint);
    let planeRounds = 0;
    const planeBarrier = jest.fn(async () => {
      planeRounds += 1;
      const exact = exactQualificationPlane();
      return planeRounds === 1
        ? exact
        : { ...exact, publicNetworkId: 'a'.repeat(64) };
    });
    const identityBarrier = jest.fn(() => undefined);
    const executor = { run: jest.fn() };
    const deps = __projectQualificationRegistryTest.qualificationDefaults('AGENT_ZERO', {
      executor,
      resolveAgentZeroModelSelection: jest.fn(async () => AGENT_ZERO_SELECTION),
      convergeAgentZeroRuntime: jest.fn(async () => status as any),
      qualifyAgentZeroRuntime: jest.fn(async () => status as any),
      attestEgressPlane: planeBarrier,
      attestAgentZeroIdentityRuntime: identityBarrier,
    });

    await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES
      .AGENT_ZERO.attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        agentZeroModelSelection: AGENT_ZERO_SELECTION,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'PLANE_IDENTITY_RACE' });
    expect(identityBarrier).toHaveBeenCalledTimes(1);
    expect(identityBarrier).toHaveBeenCalledWith(expect.objectContaining({
      expectedContainerStartedAt: NOW.toISOString(),
    }));
    expect(planeBarrier).toHaveBeenCalledTimes(2);
    expect(executor.run).not.toHaveBeenCalled();
  });

  test('Agent Zero qualification rejects a missing restart-generation binding', async () => {
    const ctx = context();
    const egressConfig = egress('AGENT_ZERO', ctx);
    const spec = buildProjectEgressPlaneSpec(egressConfig);
    const status = {
      ...agentZeroQualificationStatus(ctx, spec.policyFingerprint),
      containerStartedAt: undefined,
    };
    const identityBarrier = jest.fn();
    const deps = __projectQualificationRegistryTest.qualificationDefaults('AGENT_ZERO', {
      executor: { run: jest.fn() },
      resolveAgentZeroModelSelection: jest.fn(async () => AGENT_ZERO_SELECTION),
      convergeAgentZeroRuntime: jest.fn(async () => status as any),
      qualifyAgentZeroRuntime: jest.fn(async () => status as any),
      attestEgressPlane: jest.fn(async () => exactQualificationPlane()),
      attestAgentZeroIdentityRuntime: identityBarrier,
    });

    await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES
      .AGENT_ZERO.attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        agentZeroModelSelection: AGENT_ZERO_SELECTION,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'RUNTIME_ATTESTATION' });
    expect(identityBarrier).not.toHaveBeenCalled();
  });

  test('Agent Zero qualification rejects a same-ID runtime restart before its final identity barrier', async () => {
    const ctx = context();
    const egressConfig = egress('AGENT_ZERO', ctx);
    const spec = buildProjectEgressPlaneSpec(egressConfig);
    const status = agentZeroQualificationStatus(ctx, spec.policyFingerprint);
    const identityBarrier = jest.fn(() => undefined);
    const executor = {
      run: jest.fn(async () => ({
        stdout: JSON.stringify([{
          Id: '6'.repeat(64),
          State: {
            Running: true,
            StartedAt: '2026-07-19T13:00:00.000Z',
          },
        }]),
        stderr: '',
        exitCode: 0,
      })),
    };
    const deps = __projectQualificationRegistryTest.qualificationDefaults('AGENT_ZERO', {
      executor,
      resolveAgentZeroModelSelection: jest.fn(async () => AGENT_ZERO_SELECTION),
      convergeAgentZeroRuntime: jest.fn(async () => status as any),
      qualifyAgentZeroRuntime: jest.fn(async () => status as any),
      attestEgressPlane: jest.fn(async () => exactQualificationPlane()),
      attestAgentZeroIdentityRuntime: identityBarrier,
    });

    await expect(__projectQualificationRegistryTest.PROJECT_QUALIFICATION_LANES
      .AGENT_ZERO.attestRuntime({
        context: ctx,
        egress: egressConfig,
        sender,
        agentZeroModelSelection: AGENT_ZERO_SELECTION,
        dependencies: deps,
      })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_RACE' });
    expect(identityBarrier).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(__projectQualificationRegistryTest.evidencePath(
      ctx,
      deps.evidenceRoot,
    ))).toBe(false);
  });

  test('production final barrier re-proves Agent Zero immutable IDs and StartedAt after probes', async () => {
    const ctx = context();
    const egressConfig = egress('AGENT_ZERO', ctx);
    const spec = buildProjectEgressPlaneSpec(egressConfig);
    const status = agentZeroQualificationStatus(ctx, spec.policyFingerprint);
    const planeBarrier = jest.fn(async () => (
      exactAgentZeroFinalPlane(spec, status.descriptor.containerName)
    ));
    const identityBarrier = jest.fn(() => undefined);
    const executor = {
      run: jest.fn(async () => ({
        stdout: JSON.stringify([{
          Id: status.containerId,
          Image: ctx.runtimeImageDigest,
          State: { Running: true, StartedAt: status.containerStartedAt },
        }]),
        stderr: '',
        exitCode: 0,
      })),
    };
    const deps = __projectQualificationRegistryTest.qualificationDefaults('AGENT_ZERO', {
      executor,
      attestEgressPlane: planeBarrier,
      attestAgentZeroIdentityRuntime: identityBarrier,
    });

    await expect(deps.attestFinalEvidenceRuntime({
      provider: 'AGENT_ZERO',
      context: ctx,
      egress: egressConfig,
      agentZeroModelSelection: AGENT_ZERO_SELECTION,
      bundle: agentZeroFinalBundle(spec, status) as any,
      dependencies: deps,
    })).resolves.toBeUndefined();
    expect(planeBarrier).toHaveBeenCalledTimes(2);
    expect(identityBarrier).toHaveBeenCalledTimes(2);
    expect(identityBarrier).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedContainerId: status.containerId,
      expectedContainerStartedAt: status.containerStartedAt,
      expectedInternalNetworkId: '8'.repeat(64),
    }));
    expect(executor.run).toHaveBeenCalledTimes(4);
    expect(executor.run).toHaveBeenCalledWith(
      'docker',
      [
        '--host', 'unix:///var/run/docker.sock',
        'container', 'inspect', status.containerId,
      ],
      { allowExitCodes: [0] },
    );
  });

  test.each(['runtime restart', 'plane substitution'] as const)(
    'production final barrier rejects a post-probe %s',
    async (race) => {
      const ctx = context();
      const egressConfig = egress('AGENT_ZERO', ctx);
      const spec = buildProjectEgressPlaneSpec(egressConfig);
      const status = agentZeroQualificationStatus(ctx, spec.policyFingerprint);
      let planeReads = 0;
      const planeBarrier = jest.fn(async () => {
        planeReads += 1;
        const exact = exactAgentZeroFinalPlane(spec, status.descriptor.containerName);
        return race === 'plane substitution' && planeReads === 2
          ? { ...exact, internalNetworkId: 'f'.repeat(64) }
          : exact;
      });
      let runtimeReads = 0;
      const executor = {
        run: jest.fn(async () => {
          runtimeReads += 1;
          return {
            stdout: JSON.stringify([{
              Id: status.containerId,
              Image: ctx.runtimeImageDigest,
              State: {
                Running: true,
                StartedAt: race === 'runtime restart' && runtimeReads === 2
                  ? '2026-07-19T13:00:00.000Z'
                  : status.containerStartedAt,
              },
            }]),
            stderr: '',
            exitCode: 0,
          };
        }),
      };
      const deps = __projectQualificationRegistryTest.qualificationDefaults('AGENT_ZERO', {
        executor,
        attestEgressPlane: planeBarrier,
        attestAgentZeroIdentityRuntime: jest.fn(() => undefined),
      });

      await expect(deps.attestFinalEvidenceRuntime({
        provider: 'AGENT_ZERO',
        context: ctx,
        egress: egressConfig,
        agentZeroModelSelection: AGENT_ZERO_SELECTION,
        bundle: agentZeroFinalBundle(spec, status) as any,
        dependencies: deps,
      })).rejects.toMatchObject({
        code: race === 'runtime restart' ? 'RUNTIME_IDENTITY_RACE' : 'PLANE_IDENTITY_RACE',
      });
    },
  );

  test.each<TestProvider>(['CLAUDE_CODE', 'GEMINI'])(
    'qualifies %s in a provider-separated lane before permitting its binding',
    async (provider) => {
      const ctx = context();
      const evidenceRoot = path.join(root, `${provider.toLowerCase()}-evidence`);
      const deps = dependencies(provider, evidenceRoot, ctx);
      const status = await qualifyProjectProvider(provider, {
        context: ctx,
        egress: egress(provider, ctx),
        sender,
      }, deps);
      expect(status).toMatchObject({ provider, status: 'QUALIFIED', selectable: true });
      const grant = requireProjectQualification(
        provider,
        { context: ctx, egress: egress(provider, ctx) },
        deps,
      );
      expect(assertProjectQualificationGrant(provider, grant, ctx)).toBe(grant);
      expect(() => assertProjectQualificationGrant(
        provider === 'CLAUDE_CODE' ? 'GEMINI' : 'CLAUDE_CODE',
        grant,
        ctx,
      )).toThrow(/qualification grant/i);

      const database = {
        projectChatProviderBinding: {
          upsert: jest.fn(async (args) => args.create),
        },
        projectChatSession: {
          findUnique: jest.fn(async () => null),
          update: jest.fn(),
        },
      } as any;
      const binding = await ensureProjectChatProviderBinding({
        userId: ACTOR,
        projectId: PROJECT_ID,
        provider,
        executionContext: ctx,
        sessionKey: `${provider.toLowerCase()}-session-1`,
        externalSessionId: `${provider.toLowerCase()}-session-1`,
        qualificationGrant: grant,
      }, database);
      expect(binding).toMatchObject({
        provider,
        sessionKey: `${provider.toLowerCase()}-session-1`,
        status: 'active',
      });

      await ensureProjectChatProviderBinding({
        userId: ACTOR,
        projectId: PROJECT_ID,
        provider,
        executionContext: ctx,
        sessionKey: `${provider.toLowerCase()}-session-2`,
        externalSessionId: `${provider.toLowerCase()}-session-2`,
        qualificationGrant: grant,
        resetHandoff: true,
      }, database);
      expect(database.projectChatProviderBinding.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            handoffCursor: 0,
            handoffVersion: { increment: 1 },
          }),
        }),
      );
    },
  );

  test('binds Agent Zero evidence and grants to one exact connected OAuth provider/model pair', async () => {
    const ctx = context();
    const evidenceRoot = path.join(root, 'agent-zero-evidence');
    const deps = dependencies('AGENT_ZERO', evidenceRoot, ctx);
    const status = await qualifyProjectProvider('AGENT_ZERO', {
      context: ctx,
      egress: egress('AGENT_ZERO', ctx),
      sender,
      agentZeroModelSelection: AGENT_ZERO_SELECTION,
    }, deps);
    expect(status).toMatchObject({ provider: 'AGENT_ZERO', status: 'QUALIFIED', selectable: true });
    expect(deps.resolveAgentZeroModelSelection).toHaveBeenCalledWith(AGENT_ZERO_SELECTION);

    // Read-only capability discovery reconstructs the exact OAuth binding
    // from authenticated evidence. It must not require an untrusted caller to
    // resubmit a model merely to decide whether the provider is selectable.
    expect(getProjectQualificationStatus('AGENT_ZERO', {
      context: ctx,
      egress: egress('AGENT_ZERO', ctx),
    }, deps)).toMatchObject({
      provider: 'AGENT_ZERO',
      status: 'QUALIFIED',
      selectable: true,
    });
    const evidencedGrant = requireProjectQualification('AGENT_ZERO', {
      context: ctx,
      egress: egress('AGENT_ZERO', ctx),
    }, deps);
    expect(evidencedGrant).toMatchObject({
      modelProviderId: AGENT_ZERO_SELECTION.providerId,
      modelId: AGENT_ZERO_SELECTION.model,
    });
    expect(assertProjectQualificationGrant(
      'AGENT_ZERO',
      evidencedGrant,
      ctx,
      AGENT_ZERO_SELECTION,
    )).toBe(evidencedGrant);

    const grant = requireProjectQualification('AGENT_ZERO', {
      context: ctx,
      egress: egress('AGENT_ZERO', ctx),
      agentZeroModelSelection: AGENT_ZERO_SELECTION,
    }, deps);
    expect(assertProjectQualificationGrant(
      'AGENT_ZERO',
      grant,
      ctx,
      AGENT_ZERO_SELECTION,
    )).toBe(grant);
    expect(() => assertProjectQualificationGrant('AGENT_ZERO', grant, ctx, {
      providerId: 'codex_oauth',
      model: 'gpt-5.2-codex-mini',
    })).toThrow(/qualification grant/i);

    const database = {
      projectChatProviderBinding: { upsert: jest.fn(async (args) => args.create) },
      projectChatSession: { findUnique: jest.fn(async () => null), update: jest.fn() },
    } as any;
    await expect(ensureProjectChatProviderBinding({
      userId: ACTOR,
      projectId: PROJECT_ID,
      provider: 'AGENT_ZERO',
      executionContext: ctx,
      sessionKey: 'agent-zero-context-1',
      externalSessionId: 'agent-zero-context-1',
      model: 'codex_oauth/gpt-5.2-codex',
      agentZeroModelSelection: AGENT_ZERO_SELECTION,
      qualificationGrant: grant,
    }, database)).resolves.toMatchObject({
      provider: 'AGENT_ZERO',
      model: 'codex_oauth/gpt-5.2-codex',
      sessionKey: 'agent-zero-context-1',
    });
    await expect(ensureProjectChatProviderBinding({
      userId: ACTOR,
      projectId: PROJECT_ID,
      provider: 'AGENT_ZERO',
      executionContext: ctx,
      model: 'gemini_api_oauth/gemini-3.1-pro',
      agentZeroModelSelection: AGENT_ZERO_SELECTION,
      qualificationGrant: grant,
    }, database)).rejects.toThrow(/does not match its qualification grant/i);
  });

  test('binds Ollama evidence and sessions to one exact live model digest', async () => {
    const ctx = context();
    const evidenceRoot = path.join(root, 'ollama-evidence');
    const deps = {
      now: () => new Date(NOW),
      evidenceRoot,
      secret: SECRET,
      ttlMs: 60 * 60_000,
      resolveOllamaModelSelection: jest.fn(async () => OLLAMA_SELECTION),
      runProbes: jest.fn(async () => ({
        sandbox: {
          agentId: 'qualification-ollama',
          sessionKey: 'qualification:ollama',
          containerName: 'qualified-ollama-runtime',
          configHash: '4'.repeat(64),
          runtimeFingerprint: '5'.repeat(64),
          egressPolicyFingerprint: '6'.repeat(64),
          attestedAt: NOW.toISOString(),
        },
        spec: null,
        runtimeContainerId: '7'.repeat(64),
        runtimeContainerStartedAt: null,
        proxyContainerId: null,
        internalNetworkId: null,
        publicNetworkId: null,
        modelId: OLLAMA_SELECTION.model,
        modelProviderId: null,
        modelDigest: OLLAMA_SELECTION.digest,
        ollamaBackendKind: OLLAMA_SELECTION.backendKind,
        ollamaBackendFingerprint: OLLAMA_SELECTION.backendFingerprint,
        ollamaBackendGeneration: OLLAMA_SELECTION.backendGeneration,
        modelResponseSha256: 'a'.repeat(64),
        probes: OLLAMA_PROJECT_QUALIFICATION_REQUIRED_PROBES.map((id) => ({
          id,
          passed: true as const,
          observedAt: NOW.toISOString(),
          evidenceSha256: 'b'.repeat(64),
        })),
      })),
    };
    const ollamaEgress = egress('OLLAMA', ctx);
    await expect(qualifyProjectProvider('OLLAMA', {
      context: ctx,
      egress: ollamaEgress,
      sender,
      ollamaModelSelection: OLLAMA_SELECTION,
    }, deps)).resolves.toMatchObject({
      provider: 'OLLAMA',
      status: 'QUALIFIED',
      selectable: true,
    });

    // Read-only status can authenticate the signed evidence without querying
    // the model daemon. A mutating binding still has to supply a freshly
    // resolved live selection with the same exact digest.
    expect(getProjectQualificationStatus('OLLAMA', {
      context: ctx,
      egress: ollamaEgress,
    }, deps)).toMatchObject({ status: 'QUALIFIED', selectable: true });
    const grant = requireProjectQualification('OLLAMA', {
      context: ctx,
      egress: ollamaEgress,
    }, deps);
    expect(grant).toMatchObject({
      modelId: OLLAMA_SELECTION.model,
      modelDigest: OLLAMA_SELECTION.digest,
    });
    expect(() => assertProjectQualificationGrant('OLLAMA', grant, ctx))
      .toThrow(/qualification grant/i);
    expect(assertProjectQualificationGrant('OLLAMA', grant, ctx, OLLAMA_SELECTION)).toBe(grant);
    expect(() => assertProjectQualificationGrant('OLLAMA', grant, ctx, {
      ...OLLAMA_SELECTION,
      digest: `sha256:${'d'.repeat(64)}`,
    })).toThrow(/qualification grant/i);

    const database = {
      projectChatProviderBinding: { upsert: jest.fn(async (args) => args.create) },
      projectChatSession: { findUnique: jest.fn(async () => null), update: jest.fn() },
    } as any;
    await expect(ensureProjectChatProviderBinding({
      userId: ACTOR,
      projectId: PROJECT_ID,
      provider: 'OLLAMA',
      executionContext: ctx,
      sessionKey: 'ollama-session-1',
      externalSessionId: 'ollama-session-1',
      model: OLLAMA_SELECTION.model,
      ollamaModelSelection: OLLAMA_SELECTION,
      qualificationGrant: grant,
    }, database)).resolves.toMatchObject({
      provider: 'OLLAMA',
      model: `${OLLAMA_SELECTION.model}@${OLLAMA_SELECTION.digest}`,
      sessionKey: 'ollama-session-1',
    });
  });

  test('holds the Ollama authority lease from live model resolution through evidence persistence', async () => {
    const ctx = context();
    const evidenceRoot = path.join(root, 'ollama-authority-lease-evidence');
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    const deps = {
      now: () => new Date(NOW),
      evidenceRoot,
      secret: SECRET,
      ttlMs: 60 * 60_000,
      resolveOllamaModelSelection: jest.fn(async () => OLLAMA_SELECTION),
      runProbes: jest.fn(async () => {
        probeStarted.resolve();
        await releaseProbe.promise;
        return {
          sandbox: {
            agentId: 'qualification-ollama',
            sessionKey: 'qualification:ollama',
            containerName: 'qualified-ollama-runtime',
            configHash: '4'.repeat(64),
            runtimeFingerprint: '5'.repeat(64),
            egressPolicyFingerprint: '6'.repeat(64),
            attestedAt: NOW.toISOString(),
          },
          spec: null,
          runtimeContainerId: '7'.repeat(64),
          runtimeContainerStartedAt: null,
          proxyContainerId: null,
          internalNetworkId: null,
          publicNetworkId: null,
          modelId: OLLAMA_SELECTION.model,
          modelProviderId: null,
          modelDigest: OLLAMA_SELECTION.digest,
          ollamaBackendKind: OLLAMA_SELECTION.backendKind,
          ollamaBackendFingerprint: OLLAMA_SELECTION.backendFingerprint,
          ollamaBackendGeneration: OLLAMA_SELECTION.backendGeneration,
          modelResponseSha256: 'a'.repeat(64),
          probes: OLLAMA_PROJECT_QUALIFICATION_REQUIRED_PROBES.map((id) => ({
            id,
            passed: true as const,
            observedAt: NOW.toISOString(),
            evidenceSha256: 'b'.repeat(64),
          })),
        };
      }),
    };
    const mutation = jest.fn(async () => 'mutated');
    const qualification = qualifyProjectProvider('OLLAMA', {
      context: ctx,
      egress: egress('OLLAMA', ctx),
      sender,
      ollamaModelSelection: OLLAMA_SELECTION,
    }, deps);
    try {
      await probeStarted.promise;
      await expect(withOllamaAuthorityMutationFence(mutation)).rejects.toMatchObject({
        code: 'OLLAMA_AUTHORITY_BUSY',
        statusCode: 409,
      });
      expect(mutation).not.toHaveBeenCalled();
      releaseProbe.resolve();
      await expect(qualification).resolves.toMatchObject({
        provider: 'OLLAMA',
        status: 'QUALIFIED',
      });
      expect(fs.existsSync(__projectQualificationRegistryTest.evidencePath(ctx, evidenceRoot))).toBe(true);
      await expect(withOllamaAuthorityMutationFence(mutation)).resolves.toBe('mutated');
      expect(mutation).toHaveBeenCalledTimes(1);
    } finally {
      releaseProbe.resolve();
      await qualification.catch(() => undefined);
    }
  });

  test('qualifies Codex and permits only the resulting server-issued grant to persist a binding', async () => {
    const ctx = context({ runtimePolicyVersion: CODEX_PROJECT_RUNTIME_POLICY_VERSION });
    const evidenceRoot = path.join(root, 'codex-evidence');
    const deps = dependencies('CODEX', evidenceRoot, ctx);
    const status = await qualifyCodexProject({
      context: ctx,
      egress: egress('CODEX', ctx),
      sender,
    }, deps);

    expect(status).toMatchObject({ provider: 'CODEX', status: 'QUALIFIED', selectable: true });
    expect(deps.runProbes).toHaveBeenCalledWith(expect.objectContaining({ provider: 'CODEX' }));
    expect(getCodexProjectQualificationStatus({ context: ctx, egress: egress('CODEX', ctx) }, deps))
      .toMatchObject({ provider: 'CODEX', status: 'QUALIFIED', selectable: true });
    const grant = requireCodexProjectQualification({ context: ctx, egress: egress('CODEX', ctx) }, deps);
    expect(assertCodexProjectQualificationGrant(grant, ctx)).toBe(grant);
    expect(() => assertOpenClawProjectQualificationGrant(grant, ctx)).toThrow(/OpenClaw Project qualification grant/i);

    const persisted = { id: 'binding-1', runtime: 'codex-project-sandbox-v1' };
    const database = {
      projectChatProviderBinding: {
        upsert: jest.fn(async () => persisted),
      },
      projectChatSession: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(),
      },
    } as any;
    await expect(ensureProjectChatProviderBinding({
      userId: ACTOR,
      projectId: PROJECT_ID,
      provider: 'CODEX',
      executionContext: ctx,
      sessionKey: 'codex-session-1',
      externalSessionId: 'codex-session-1',
      model: 'openai/gpt-5.5',
      qualificationGrant: grant,
    }, database)).resolves.toBe(persisted);
    expect(database.projectChatProviderBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ provider: 'CODEX', sessionKey: 'codex-session-1' }),
    }));
  });

  test('invalidates predecessor Codex evidence without changing OpenClaw v2 evidence', async () => {
    const oldCodex = context({
      runtimePolicyVersion: 'portal-project-sandbox-v2',
      policyFingerprint: '1'.repeat(64),
    });
    const codexEvidenceRoot = path.join(root, 'codex-v2-evidence');
    await qualifyCodexProject({
      context: oldCodex,
      egress: egress('CODEX', oldCodex),
      sender,
    }, dependencies('CODEX', codexEvidenceRoot, oldCodex));

    const currentCodex = context({
      runtimePolicyVersion: CODEX_PROJECT_RUNTIME_POLICY_VERSION,
      policyFingerprint: '2'.repeat(64),
    });
    expect(getCodexProjectQualificationStatus({
      context: currentCodex,
      egress: egress('CODEX', currentCodex),
    }, dependencies('CODEX', codexEvidenceRoot, currentCodex))).toMatchObject({
      provider: 'CODEX',
      status: 'INVALID',
      selectable: false,
    });

    const openClaw = context({
      runtimePolicyVersion: 'portal-project-sandbox-v2',
      policyFingerprint: '3'.repeat(64),
    });
    const openEvidenceRoot = path.join(root, 'openclaw-v2-evidence');
    const openDependencies = dependencies('OPENCLAW', openEvidenceRoot, openClaw);
    await qualifyOpenClawProject({
      context: openClaw,
      egress: egress('OPENCLAW', openClaw),
      sender,
    }, openDependencies);
    expect(getOpenClawProjectQualificationStatus({
      context: openClaw,
      egress: egress('OPENCLAW', openClaw),
    }, openDependencies)).toMatchObject({
      provider: 'OPENCLAW',
      status: 'QUALIFIED',
      selectable: true,
    });
  });

  test('never accepts evidence or grants across provider lanes even with one shared directory', async () => {
    const ctx = context();
    const sharedRoot = path.join(root, 'shared-evidence');
    const openDeps = dependencies('OPENCLAW', sharedRoot, ctx);
    await qualifyOpenClawProject({ context: ctx, egress: egress('OPENCLAW', ctx), sender }, openDeps);
    const openGrant = requireOpenClawProjectQualification(
      { context: ctx, egress: egress('OPENCLAW', ctx) },
      openDeps,
    );
    expect(() => assertCodexProjectQualificationGrant(openGrant, ctx)).toThrow(/Codex Project qualification grant/i);
    expect(getCodexProjectQualificationStatus({ context: ctx, egress: egress('CODEX', ctx) }, {
      evidenceRoot: sharedRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ provider: 'CODEX', status: 'INVALID', selectable: false });

    const codexDeps = dependencies('CODEX', sharedRoot, ctx);
    await qualifyCodexProject({ context: ctx, egress: egress('CODEX', ctx), sender }, codexDeps);
    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egress('OPENCLAW', ctx) }, {
      evidenceRoot: sharedRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ provider: 'OPENCLAW', status: 'INVALID', selectable: false });
  });

  test('rejects a re-signed OpenClaw payload relabeled as Codex because lane context identities differ', async () => {
    const ctx = context();
    const evidenceRoot = path.join(root, 'resigned-evidence');
    const openDeps = dependencies('OPENCLAW', evidenceRoot, ctx);
    await qualifyOpenClawProject({ context: ctx, egress: egress('OPENCLAW', ctx), sender }, openDeps);
    const evidencePath = __projectQualificationRegistryTest.evidencePath(ctx, evidenceRoot);
    const envelope = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    envelope.payload.provider = 'CODEX';
    envelope.payload.qualificationVersion = CODEX_PROJECT_QUALIFICATION_VERSION;
    envelope.mac = __projectQualificationRegistryTest.evidenceMac(envelope.payload, SECRET);
    fs.writeFileSync(evidencePath, JSON.stringify(envelope), { mode: 0o600 });

    expect(getCodexProjectQualificationStatus({ context: ctx, egress: egress('CODEX', ctx) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ provider: 'CODEX', status: 'INVALID', selectable: false });
  });

  test('rejects a Codex qualification request carrying OpenClaw egress identity before probes run', async () => {
    const ctx = context();
    const deps = dependencies('CODEX', path.join(root, 'identity-evidence'), ctx);
    await expect(qualifyCodexProject({
      context: ctx,
      egress: egress('OPENCLAW', ctx),
      sender,
    }, deps)).rejects.toThrow(/Codex Project qualification identity did not match/i);
    expect(deps.runProbes).not.toHaveBeenCalled();
  });
});

describe('Codex Project live model challenge', () => {
  const runtime: CodexProjectEgressRuntimeHandle = Object.freeze({
    containerId: 'c'.repeat(64),
    containerName: 'p4cx-model-probe',
    runtimeFingerprint: 'd'.repeat(64),
    egressPolicyFingerprint: 'e'.repeat(64),
    proxyAddress: '172.31.0.2',
    proxyEnvironment: Object.freeze({
      HTTP_PROXY: 'http://portal:token@172.31.0.2:3128',
      HTTPS_PROXY: 'http://portal:token@172.31.0.2:3128',
      http_proxy: 'http://portal:token@172.31.0.2:3128',
      https_proxy: 'http://portal:token@172.31.0.2:3128',
      NO_PROXY: '',
      no_proxy: '',
    }),
    startedAt: NOW.toISOString(),
  });

  function executorWithResponse(response: string, options: { tool?: boolean } = {}) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async (command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> => {
        calls.push({ command, args });
        const events = [
          { type: 'thread.started', thread_id: '019f0000-0000-7000-8000-000000000777', model: 'gpt-5.5' },
          ...(options.tool ? [{ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } }] : []),
          { type: 'item.completed', item: { type: 'agent_message', text: response } },
          { type: 'turn.completed' },
        ];
        return { stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, stderr: '', exitCode: 0 };
      }),
    };
    return { executor, calls };
  }

  test('runs an exact confined, ephemeral model roundtrip', async () => {
    const nonce = 'fixed_nonce_123';
    const expected = `PORTAL_CODEX_PROJECT_QUALIFICATION_${nonce}`;
    const { executor, calls } = executorWithResponse(expected);
    const result = await __projectQualificationRegistryTest.runDefaultCodexModelProbe({
      runtime,
      sender,
      nonce,
      executor,
    });

    expect(result).toEqual({
      modelId: 'gpt-5.5',
      responseSha256: crypto.createHash('sha256').update(expected).digest('hex'),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('docker');
    expect(calls[0].args).toEqual(expect.arrayContaining([
      'container', 'exec', runtime.containerId,
      '/usr/bin/timeout', '/usr/bin/codex',
      '--profile', 'portal-project',
      '--strict-config',
      '--sandbox', 'read-only',
      '--cd', '/tmp',
      'exec', '--ephemeral', '--json',
    ]));
    expect(calls[0].args.join('\n')).toContain(expected);
    expect(calls[0].args.join('\n')).not.toContain(ACTOR);
  });

  test('fails closed on a wrong answer or tool attempt without persisting a probe thread', async () => {
    for (const scenario of [
      executorWithResponse('wrong answer'),
      executorWithResponse('PORTAL_CODEX_PROJECT_QUALIFICATION_fixed_nonce_123', { tool: true }),
    ]) {
      await expect(__projectQualificationRegistryTest.runDefaultCodexModelProbe({
        runtime,
        sender,
        nonce: 'fixed_nonce_123',
        executor: scenario.executor,
      })).rejects.toThrow(/challenge|tool/i);
      expect(scenario.calls).toHaveLength(1);
      expect(scenario.calls[0].args).toContain('--ephemeral');
    }
  });

  test('does not leak provider authentication failures through the qualification boundary', async () => {
    const executor: ProjectEgressCommandExecutor = {
      run: jest.fn(async () => {
        throw new Error('upstream bearer sk-secret-material expired');
      }),
    };
    let message = '';
    try {
      await __projectQualificationRegistryTest.runDefaultCodexModelProbe({
        runtime,
        sender,
        nonce: 'fixed_nonce_123',
        executor,
      });
    } catch (error: any) {
      message = String(error?.message || error);
    }
    expect(message).toBe('Codex qualification model roundtrip failed');
    expect(message).not.toContain('sk-secret-material');
  });
});

describe('confined native Project live model challenge', () => {
  const runtime = Object.freeze({
    provider: 'CLAUDE_CODE' as const,
    containerId: 'c'.repeat(64),
    containerName: 'p4cc-model-probe',
    runtimeFingerprint: 'd'.repeat(64),
    egressPolicyFingerprint: 'e'.repeat(64),
    proxyAddress: '172.31.0.2',
    proxyEnvironment: Object.freeze({
      HTTP_PROXY: 'http://portal:token@172.31.0.2:3128',
      HTTPS_PROXY: 'http://portal:token@172.31.0.2:3128',
      http_proxy: 'http://portal:token@172.31.0.2:3128',
      https_proxy: 'http://portal:token@172.31.0.2:3128',
      NO_PROXY: '',
      no_proxy: '',
    }),
    startedAt: NOW.toISOString(),
  });

  test('requires an exact no-tool response and removes the ephemeral Portal/native session', async () => {
    const nonce = 'claude_nonce_123';
    const expected = `PORTAL_CLAUDE_CODE_PROJECT_QUALIFICATION_${nonce}`;
    const terminateSession = jest.fn().mockResolvedValue(undefined);
    const provider: AgentProvider = {
      displayName: 'Claude Code',
      providerName: 'CLAUDE_CODE',
      startSession: jest.fn().mockResolvedValue('claude-qualification-session'),
      sendMessage: jest.fn(async (_sessionId, _message, _onChunk, onStatus) => {
        onStatus?.({ type: 'thinking', content: 'Answering without tools' });
        return { fullText: expected, metadata: { model: 'claude-sonnet-4-5' } };
      }),
      getHistory: jest.fn(),
      listSessions: jest.fn(),
      terminateSession,
      abortActiveRun: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider);

    await expect(__projectQualificationRegistryTest.runDefaultNativeCliModelProbe({
      provider: 'CLAUDE_CODE',
      context: context(),
      runtime,
      sender,
      nonce,
    })).resolves.toEqual({
      modelId: 'claude-sonnet-4-5',
      responseSha256: crypto.createHash('sha256').update(expected).digest('hex'),
    });
    expect(provider.startSession).toHaveBeenCalledWith(ACTOR, expect.objectContaining({
      executionContext: expect.objectContaining({ projectId: PROJECT_ID }),
    }));
    expect(terminateSession).toHaveBeenCalledWith('claude-qualification-session');
  });

  test('fails closed and cleans up when a model attempts a qualification tool call', async () => {
    const terminateSession = jest.fn().mockResolvedValue(undefined);
    const provider: AgentProvider = {
      displayName: 'Claude Code',
      providerName: 'CLAUDE_CODE',
      startSession: jest.fn().mockResolvedValue('claude-tool-session'),
      sendMessage: jest.fn(async (_sessionId, _message, _onChunk, onStatus) => {
        onStatus?.({ type: 'tool_start', toolName: 'Read' });
        return {
          fullText: 'PORTAL_CLAUDE_CODE_PROJECT_QUALIFICATION_tool_nonce',
        };
      }),
      getHistory: jest.fn(),
      listSessions: jest.fn(),
      terminateSession,
      abortActiveRun: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider);

    await expect(__projectQualificationRegistryTest.runDefaultNativeCliModelProbe({
      provider: 'CLAUDE_CODE',
      context: context(),
      runtime,
      sender,
      nonce: 'tool_nonce',
    })).rejects.toThrow(/attempted to use a tool/i);
    expect(terminateSession).toHaveBeenCalledWith('claude-tool-session');
  });

  test('preserves a safe authentication reason without exposing the provider diagnostic', async () => {
    const terminateSession = jest.fn().mockResolvedValue(undefined);
    const provider: AgentProvider = {
      displayName: 'Claude Code',
      providerName: 'CLAUDE_CODE',
      startSession: jest.fn().mockResolvedValue('claude-auth-session'),
      sendMessage: jest.fn().mockRejectedValue(new NativeProviderDiagnosticError(
        'AUTH_REQUIRED',
        'Claude authentication is unavailable. Reconnect it in AI Settings and retry.',
        'safe-diagnostic-id',
      )),
      getHistory: jest.fn(),
      listSessions: jest.fn(),
      terminateSession,
      abortActiveRun: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider);

    await expect(__projectQualificationRegistryTest.runDefaultNativeCliModelProbe({
      provider: 'CLAUDE_CODE',
      context: context(),
      runtime,
      sender,
      nonce: 'auth_nonce',
    })).rejects.toMatchObject({
      code: 'MODEL_PROBE_AUTH',
      message: 'Claude authentication is unavailable. Reconnect it in AI Settings and retry.',
    });
    expect(terminateSession).toHaveBeenCalledWith('claude-auth-session');
  });
});

describe('Agent Zero Project live model challenge', () => {
  test('uses the dedicated Project adapter, exact OAuth pair, and cleans the temporary context', async () => {
    const terminateSession = jest.fn().mockResolvedValue(undefined);
    const selection = AGENT_ZERO_SELECTION;
    const provider: AgentProvider = {
      displayName: 'Agent Zero (Project Sandbox)',
      providerName: 'AGENT_ZERO',
      startSession: jest.fn().mockResolvedValue('a0-qualification-context'),
      sendMessage: jest.fn(async (_sessionId, message) => {
        const expected = String(message).match(/PORTAL_AGENT_ZERO_PROJECT_QUALIFICATION_[A-Za-z0-9_-]+/)?.[0] || '';
        return {
          fullText: expected,
          metadata: {
            oauthProviderId: selection.providerId,
            model: selection.model,
          },
        };
      }),
      getHistory: jest.fn(),
      listSessions: jest.fn(),
      terminateSession,
      abortActiveRun: jest.fn().mockResolvedValue(true),
    };
    const projectAdapter = jest.spyOn(projectProviderRegistry, 'getProjectChatProviderAdapter')
      .mockReturnValue(provider);
    const globalGet = jest.spyOn(AgentRegistry, 'get');

    await expect(__projectQualificationRegistryTest.runDefaultAgentZeroModelProbe({
      context: context(),
      sender,
      nonce: 'agent_zero_nonce_123',
      modelSelection: selection,
    })).resolves.toEqual({
      modelId: selection.model,
      modelProviderId: selection.providerId,
      responseSha256: crypto.createHash('sha256')
        .update('PORTAL_AGENT_ZERO_PROJECT_QUALIFICATION_agent_zero_nonce_123')
        .digest('hex'),
    });
    expect(projectAdapter).toHaveBeenCalledWith('AGENT_ZERO');
    expect(globalGet).not.toHaveBeenCalled();
    expect(provider.startSession).toHaveBeenCalledWith(ACTOR, expect.objectContaining({
      model: selection.model,
      metadata: expect.objectContaining({
        qualification: true,
        agentZeroOAuthProviderId: selection.providerId,
      }),
    }));
    expect(terminateSession).toHaveBeenCalledWith('a0-qualification-context');
  });

  test('rejects a tool event even when Agent Zero returns the expected text', async () => {
    const terminateSession = jest.fn().mockResolvedValue(undefined);
    const provider: AgentProvider = {
      displayName: 'Agent Zero (Project Sandbox)',
      providerName: 'AGENT_ZERO',
      startSession: jest.fn().mockResolvedValue('a0-tool-context'),
      sendMessage: jest.fn(async (_sessionId, message, _onChunk, onStatus) => {
        onStatus?.({ type: 'tool_start', toolName: 'code_exec' });
        return {
          fullText: String(message).match(/PORTAL_AGENT_ZERO_PROJECT_QUALIFICATION_[A-Za-z0-9_-]+/)?.[0] || '',
          metadata: {
            oauthProviderId: AGENT_ZERO_SELECTION.providerId,
            model: AGENT_ZERO_SELECTION.model,
          },
        };
      }),
      getHistory: jest.fn(),
      listSessions: jest.fn(),
      terminateSession,
      abortActiveRun: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(projectProviderRegistry, 'getProjectChatProviderAdapter').mockReturnValue(provider);
    await expect(__projectQualificationRegistryTest.runDefaultAgentZeroModelProbe({
      context: context(),
      sender,
      nonce: 'tool_nonce',
      modelSelection: AGENT_ZERO_SELECTION,
    })).rejects.toThrow(/attempted to use a tool/i);
    expect(terminateSession).toHaveBeenCalledWith('a0-tool-context');
  });
});
