import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import {
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_RUNTIME,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import {
  PROJECT_CHAT_HANDOFF_MAX_CHARS,
  buildProjectChatProviderHandoff,
  UnsupportedProjectChatProviderError,
  assertProjectChatProviderSelectable,
  buildProjectChatCapabilityResponse,
  buildQualifiedProjectChatProviderCapability,
  buildProjectSandboxExecutionContext,
  buildDiscoveryProjectSandboxExecutionContext,
  buildUnqualifiedProjectSandboxExecutionContext,
  buildUnqualifiedOpenClawProjectSandboxExecutionContext,
  buildUnqualifiedClaudeCodeProjectSandboxExecutionContext,
  buildUnqualifiedAntigravityProjectSandboxExecutionContext,
  buildUnqualifiedAgentZeroProjectSandboxExecutionContext,
  buildUnqualifiedOllamaProjectSandboxExecutionContext,
  ensureProjectChatProviderBinding,
  listProjectChatProviderCapabilities,
  planProjectChatProviderSwitch,
  resolveProjectChatQualificationMatrix,
} from '../services/projectChatKernel';
import { config } from '../config/env';
import {
  CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox';
import {
  ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';
import { OLLAMA_PROJECT_RUNTIME_POLICY_VERSION } from '../agents/providers/ollama/OllamaProjectToolRuntime';
import {
  ProjectChatProviderRuntimeUnavailableError,
  isQualifiableProjectProvider,
  projectChatProviderDisplayName,
} from '../services/projectChatProviderRegistry';

const USER_ID = 'project-owner';
const PROJECT_NAME = 'project-a';
const PROJECT_INSTANCE_ID = '8a3eb1ae-6c20-4b6f-9835-1d76fc88f8a4';

let testRoot: string;
let projectsRoot: string;
let projectRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-chat-kernel-'));
  projectsRoot = path.join(testRoot, 'projects');
  projectRoot = path.join(projectsRoot, USER_ID, PROJECT_NAME);
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function projectIdentity(projectName = PROJECT_NAME, root = projectRoot) {
  const rootStat = fs.statSync(root, { bigint: true });
  return {
    id: PROJECT_INSTANCE_ID,
    workspaceOwnerId: USER_ID,
    projectName,
    canonicalRoot: fs.realpathSync(root),
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
    rootBirthtimeNs: rootStat.birthtimeNs.toString(),
    generation: 1,
    createdAt: new Date('2026-07-19T12:00:00.000Z'),
    updatedAt: new Date('2026-07-19T12:00:00.000Z'),
  };
}

function buildUnqualifiedContext() {
  const identity = projectIdentity();
  return createProjectSandboxExecutionContext({
    userId: USER_ID,
    projectId: identity.id,
    workspaceOwnerId: USER_ID,
    projectName: PROJECT_NAME,
    canonicalRoot: identity.canonicalRoot,
    rootDevice: identity.rootDevice,
    rootInode: identity.rootInode,
    rootBirthtimeNs: identity.rootBirthtimeNs,
    runtimePolicyVersion: 'portal-project-sandbox-v2',
    egressPolicyVersion: 'portal-project-egress-v1',
    runtimeImageDigest: 'unqualified:test-runtime',
    policyFingerprint: 'a'.repeat(64),
  });
}

describe('Project Chat migration contract', () => {
  test('adds provider bindings and transcript identity without dropping legacy data', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20260718_project_chat_provider_bindings/migration.sql',
    );
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE "ProjectChatProviderBinding"');
    expect(migration).toContain('ADD COLUMN "provider" TEXT NOT NULL DEFAULT \'OPENCLAW\'');
    expect(migration).toContain('ADD COLUMN "activeProvider" TEXT NOT NULL DEFAULT \'OPENCLAW\'');
    expect(migration).toContain('ProjectChatProviderBinding_userId_projectId_provider_key');
    expect(migration).toContain('REFERENCES "User"("id") ON DELETE CASCADE');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
  });
});

describe('Project Chat provider capabilities', () => {
  test('fails closed when no Project provider has completed live qualification', () => {
    const response = buildProjectChatCapabilityResponse({
      activeProvider: 'OPENCLAW',
      bindings: [],
      executionContext: null,
    });

    expect(response.supportedProviders).toEqual([]);
    expect(response.providers.filter((entry) => entry.selectable).map((entry) => entry.provider))
      .toEqual([]);
    expect(response.executionContext).toBeNull();
  });

  test('fails closed for every unproven provider, including OpenClaw, Agent Zero, and Grok', () => {
    const unsupportedProviders = listProjectChatProviderCapabilities();

    expect(unsupportedProviders.map((entry) => entry.provider)).toEqual(expect.arrayContaining([
      'OPENCLAW',
      'AGENT_ZERO',
      'GROK',
      'CLAUDE_CODE',
      'CODEX',
      'GEMINI',
      'OLLAMA',
    ]));

    for (const capability of unsupportedProviders) {
      expect(capability.selectable).toBe(false);
      expect(capability.executionScope).toBeNull();
      expect(capability.reason).not.toHaveLength(0);
      expect(() => assertProjectChatProviderSelectable(capability.provider))
        .toThrow(UnsupportedProjectChatProviderError);
    }
    for (const provider of ['OPENCLAW', 'CODEX', 'CLAUDE_CODE', 'GEMINI', 'OLLAMA'] as const) {
      expect(unsupportedProviders.find((entry) => entry.provider === provider)).toMatchObject({
        supportsAttachments: true,
        supportsModelSelection: true,
        supportsAbort: true,
        supportsReset: true,
      });
    }
    expect(unsupportedProviders.find((entry) => entry.provider === 'GROK')).toMatchObject({
      supportsAttachments: false,
      supportsModelSelection: false,
      supportsAbort: false,
      supportsReset: false,
    });
    expect(unsupportedProviders.find((entry) => entry.provider === 'AGENT_ZERO')).toMatchObject({
      runtime: AGENT_ZERO_PROJECT_RUNTIME,
      selectable: false,
      executionScope: null,
      supportsAttachments: false,
      supportsModelSelection: true,
      supportsAbort: true,
      supportsReset: true,
      requiresOAuth: true,
    });
  });

  test('keeps usable provider capability discovery alive when one optional runtime image is unavailable', () => {
    const previousOpenClawImage = config.openclawProjectSandboxImageId;
    const previousAntigravityImage = config.antigravityProjectSandboxImageId;
    config.openclawProjectSandboxImageId = `sha256:${'a'.repeat(64)}`;
    config.antigravityProjectSandboxImageId = '';
    try {
      const input = {
        actorUserId: USER_ID,
        workspaceOwnerId: USER_ID,
        projectName: PROJECT_NAME,
        projectIdentity: projectIdentity(),
        projectDir: projectRoot,
        projectsRoot,
      };
      const inspected: AgentProviderName[] = [];
      const matrix = resolveProjectChatQualificationMatrix(
        ['OPENCLAW', 'GEMINI'] as const,
        (provider) => {
          inspected.push(provider);
          buildUnqualifiedProjectSandboxExecutionContext(provider, input);
          return {
            provider,
            status: 'UNQUALIFIED' as const,
            selectable: false,
            reason: `${provider} needs qualification.`,
            qualifiedAt: null,
            expiresAt: null,
            evidenceFingerprint: null,
          };
        },
      );

      expect(inspected).toEqual(['OPENCLAW', 'GEMINI']);
      expect(matrix.OPENCLAW).toMatchObject({
        provider: 'OPENCLAW',
        status: 'UNQUALIFIED',
        reason: 'OPENCLAW needs qualification.',
      });
      expect(matrix.GEMINI).toMatchObject({
        provider: 'GEMINI',
        status: 'UNAVAILABLE',
        selectable: false,
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      });
      expect(matrix.GEMINI.reason).toMatch(/not installed and attested/i);
    } finally {
      config.openclawProjectSandboxImageId = previousOpenClawImage;
      config.antigravityProjectSandboxImageId = previousAntigravityImage;
    }
  });

  test('does not hide project identity or containment failures as one unavailable provider', () => {
    expect(() => resolveProjectChatQualificationMatrix(
      ['OPENCLAW'] as const,
      () => { throw new Error('project identity drift'); },
    )).toThrow('project identity drift');
  });

  describe('discovery execution context', () => {
    const contextInput = () => ({
      actorUserId: USER_ID,
      workspaceOwnerId: USER_ID,
      projectName: PROJECT_NAME,
      projectIdentity: projectIdentity(),
      projectDir: projectRoot,
      projectsRoot,
    });

    test('still attests project identity when the selected provider runtime is missing', () => {
      // The real wedge: the user's selected provider was Antigravity, its
      // runtime was not installed, and discovery threw. The whole panel then
      // failed, so the picker needed to switch away was never rendered.
      const previousOpenClawImage = config.openclawProjectSandboxImageId;
      const previousAntigravityImage = config.antigravityProjectSandboxImageId;
      config.openclawProjectSandboxImageId = `sha256:${'a'.repeat(64)}`;
      config.antigravityProjectSandboxImageId = '';
      try {
        const discovery = buildDiscoveryProjectSandboxExecutionContext(
          'GEMINI',
          ['OPENCLAW', 'GEMINI'] as const,
          contextInput(),
        );
        expect(discovery.provider).toBe('OPENCLAW');
        expect(discovery.context.scope).toBe('PROJECT_SANDBOX');
        // The client hard-requires a verified project identity; without one it
        // refuses to render regardless of status code.
        expect(discovery.context.projectId).toBeTruthy();
        expect(discovery.unavailable).toBeInstanceOf(ProjectChatProviderRuntimeUnavailableError);
        expect(discovery.unavailable?.provider).toBe('GEMINI');
      } finally {
        config.openclawProjectSandboxImageId = previousOpenClawImage;
        config.antigravityProjectSandboxImageId = previousAntigravityImage;
      }
    });

    test('prefers the selected provider when its runtime is present', () => {
      const previousOpenClawImage = config.openclawProjectSandboxImageId;
      config.openclawProjectSandboxImageId = `sha256:${'a'.repeat(64)}`;
      try {
        const discovery = buildDiscoveryProjectSandboxExecutionContext(
          'OPENCLAW',
          ['OPENCLAW'] as const,
          contextInput(),
        );
        expect(discovery.provider).toBe('OPENCLAW');
        expect(discovery.unavailable).toBeNull();
      } finally {
        config.openclawProjectSandboxImageId = previousOpenClawImage;
      }
    });

    test('reports the unavailable runtime when no provider can attest', () => {
      const previousOpenClawImage = config.openclawProjectSandboxImageId;
      const previousAntigravityImage = config.antigravityProjectSandboxImageId;
      config.openclawProjectSandboxImageId = '';
      config.antigravityProjectSandboxImageId = '';
      try {
        expect(() => buildDiscoveryProjectSandboxExecutionContext(
          'GEMINI',
          ['OPENCLAW', 'GEMINI'] as const,
          contextInput(),
        )).toThrow(ProjectChatProviderRuntimeUnavailableError);
      } finally {
        config.openclawProjectSandboxImageId = previousOpenClawImage;
        config.antigravityProjectSandboxImageId = previousAntigravityImage;
      }
    });

    test('does not swallow identity or containment failures', () => {
      expect(() => buildDiscoveryProjectSandboxExecutionContext(
        'OPENCLAW',
        ['OPENCLAW'] as const,
        { ...contextInput(), projectDir: path.join(projectsRoot, 'does-not-exist') },
      )).toThrow();
    });
  });
});

describe('Project Chat sandbox binding', () => {
  test.each<AgentProviderName>(['OPENCLAW', 'AGENT_ZERO', 'GROK', 'CLAUDE_CODE', 'CODEX', 'GEMINI', 'OLLAMA'])(
    'refuses to mint a %s sandbox context before that runtime is qualified',
    (provider) => {
      const identity = projectIdentity();
      expect(() => buildProjectSandboxExecutionContext({
        actorUserId: USER_ID,
        workspaceOwnerId: USER_ID,
        projectName: PROJECT_NAME,
        projectIdentity: identity,
        projectDir: projectRoot,
        projectsRoot,
        provider,
      })).toThrow(UnsupportedProjectChatProviderError);
    },
  );

  test('rejects a server-owned identity that does not match the requested project', () => {
    expect(() => buildUnqualifiedOpenClawProjectSandboxExecutionContext({
      actorUserId: USER_ID,
      workspaceOwnerId: USER_ID,
      projectName: 'project-b',
      projectIdentity: projectIdentity(PROJECT_NAME, projectRoot),
      projectDir: projectRoot,
      projectsRoot,
    })).toThrow('Server-owned project identity does not match the requested workspace project');
  });

  test('binds native and Agent Zero qualification contexts to their exact immutable image and policy', () => {
    const previousClaudeImage = config.claudeCodeProjectSandboxImageId;
    const previousAntigravityImage = config.antigravityProjectSandboxImageId;
    const previousAgentZeroImage = config.agentZeroProjectSandboxImageId;
    const previousOllamaImage = config.ollamaProjectSandboxImageId;
    config.claudeCodeProjectSandboxImageId = `sha256:${'c'.repeat(64)}`;
    config.antigravityProjectSandboxImageId = `sha256:${'d'.repeat(64)}`;
    config.agentZeroProjectSandboxImageId = `sha256:${'e'.repeat(64)}`;
    config.ollamaProjectSandboxImageId = `sha256:${'f'.repeat(64)}`;
    try {
      const input = {
        actorUserId: USER_ID,
        workspaceOwnerId: USER_ID,
        projectName: PROJECT_NAME,
        projectIdentity: projectIdentity(),
        projectDir: projectRoot,
        projectsRoot,
      };
      const claude = buildUnqualifiedClaudeCodeProjectSandboxExecutionContext(input);
      const antigravity = buildUnqualifiedAntigravityProjectSandboxExecutionContext(input);
      const agentZero = buildUnqualifiedAgentZeroProjectSandboxExecutionContext(input);
      const ollama = buildUnqualifiedOllamaProjectSandboxExecutionContext(input);
      expect(claude).toMatchObject({
        runtimePolicyVersion: CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION,
        runtimeImageDigest: config.claudeCodeProjectSandboxImageId,
      });
      expect(antigravity).toMatchObject({
        runtimePolicyVersion: ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION,
        runtimeImageDigest: config.antigravityProjectSandboxImageId,
      });
      expect(agentZero).toMatchObject({
        runtimePolicyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
        runtimeImageDigest: config.agentZeroProjectSandboxImageId,
      });
      expect(ollama).toMatchObject({
        runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
        runtimeImageDigest: config.ollamaProjectSandboxImageId,
      });
      expect(claude.policyFingerprint).not.toBe(antigravity.policyFingerprint);
      expect(agentZero.policyFingerprint).not.toBe(claude.policyFingerprint);
      expect(ollama.policyFingerprint).not.toBe(agentZero.policyFingerprint);
    } finally {
      config.claudeCodeProjectSandboxImageId = previousClaudeImage;
      config.antigravityProjectSandboxImageId = previousAntigravityImage;
      config.agentZeroProjectSandboxImageId = previousAgentZeroImage;
      config.ollamaProjectSandboxImageId = previousOllamaImage;
    }
  });
});

describe('Project Chat provider bindings', () => {
  test.each<AgentProviderName>(['OPENCLAW', 'AGENT_ZERO', 'GROK', 'CLAUDE_CODE', 'CODEX', 'GEMINI', 'OLLAMA'])(
    'rejects an unqualified %s binding before database access',
    async (provider) => {
      const executionContext = buildUnqualifiedContext();
      const database = {
        projectChatSession: { findUnique: jest.fn(), update: jest.fn() },
        projectChatProviderBinding: { upsert: jest.fn(), findMany: jest.fn() },
      } as unknown as NonNullable<Parameters<typeof ensureProjectChatProviderBinding>[1]>;

      const rejected = expect(ensureProjectChatProviderBinding({
        userId: USER_ID,
        projectId: PROJECT_INSTANCE_ID,
        provider,
        executionContext,
      }, database)).rejects;
      if (isQualifiableProjectProvider(provider)) {
        await rejected.toThrow(new RegExp(
          `server-verified ${projectChatProviderDisplayName(provider)} Project qualification grant`,
          'i',
        ));
      } else {
        await rejected.toThrow(UnsupportedProjectChatProviderError);
      }

      expect(database.projectChatSession.findUnique).not.toHaveBeenCalled();
      expect(database.projectChatProviderBinding.upsert).not.toHaveBeenCalled();
    },
  );

  test('does not serialize the canonical root or authenticated actor into capability responses', () => {
    const executionContext = buildUnqualifiedContext();
    const response = buildProjectChatCapabilityResponse({
      activeProvider: 'OPENCLAW',
      bindings: [],
      executionContext,
    });

    expect(response.executionContext).toEqual({
      scope: 'PROJECT_SANDBOX',
      projectId: PROJECT_INSTANCE_ID,
      projectName: PROJECT_NAME,
      workspaceOwnerId: USER_ID,
      runtimePolicyVersion: 'portal-project-sandbox-v2',
      egressPolicyVersion: 'portal-project-egress-v1',
      policyFingerprint: 'a'.repeat(64),
    });
    expect(response.executionContext).not.toHaveProperty('canonicalRoot');
    expect(response.executionContext).not.toHaveProperty('userId');
    expect(response.executionContext).not.toHaveProperty('runtimeImageDigest');
  });

  test('routes project sends through the sandbox broker and keeps the browser socket receive-only', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const sendRouteStart = routeSource.indexOf("router.post('/:name/assistant/send'");
    const nextRouteStart = routeSource.indexOf("router.post('/:name/assistant/read-file'", sendRouteStart);
    const sendRoute = routeSource.slice(sendRouteStart, nextRouteStart);
    const pollRouteStart = routeSource.indexOf("router.get('/:name/assistant/poll'");
    const abortRouteStart = routeSource.indexOf("router.post('/:name/assistant/abort'", pollRouteStart);
    const pollRoute = routeSource.slice(pollRouteStart, abortRouteStart);
    const panelSource = fs.readFileSync(
      path.resolve(__dirname, '../../../frontend/src/components/chat/ProjectChatPanel.tsx'),
      'utf8',
    );

    expect(sendRouteStart).toBeGreaterThan(-1);
    expect(nextRouteStart).toBeGreaterThan(sendRouteStart);
    expect(sendRoute).toContain('resolveProjectChatOperationContext');
    expect(sendRoute).toContain("executionContext");
    expect(sendRoute).toContain('resolved.needsBootstrap');
    expect(sendRoute).toContain('buildProjectChatProviderHandoff');
    expect(sendRoute.match(/readProjectChatProviderHandoffSuffix/g)).toHaveLength(2);
    expect(sendRoute).not.toContain("orderBy: { timestamp: 'desc' }");
    expect(sendRoute).toContain('ensureOpenClawProjectRuntime');
    expect(sendRoute).toContain('findProjectChatRequestReplay');
    expect(sendRoute).toContain('acquireProjectChatRuntimeAdmission');
    expect(sendRoute).toContain('promoteProjectChatRuntimeAdmissionToTurn');
    expect(sendRoute).toContain("provider: 'OPENCLAW'");
    expect(sendRoute).toContain('startProjectNativeRun');
    expect(sendRoute).toContain('PROJECT_PROVIDER_RUN_ACTIVE');
    expect(sendRoute).not.toContain("network: \"bridge\"");
    expect(sendRoute).not.toContain("gatewayRpcCall('chat.send'");
    expect(sendRoute).not.toContain('requireHostOperatorExecutionContext');
    expect(pollRouteStart).toBeGreaterThan(-1);
    expect(abortRouteStart).toBeGreaterThan(pollRouteStart);
    expect(pollRoute).toContain('readProjectChatTurnReplay');
    expect(pollRoute).toContain('resolveProjectChatReplayLineCount({');
    expect(pollRoute).not.toContain('sessions.json');
    expect(pollRoute).not.toContain('.jsonl');
    expect(pollRoute).not.toContain('chat.history');
    expect(panelSource).toContain('/assistant/send`');
    expect(panelSource).not.toMatch(/manager\.send\(\{\s*type:\s*['"]send['"]/);
  });

  test('serializes initial replay persistence after the provider dispatch acceptance fence', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const sendRouteStart = routeSource.indexOf("router.post('/:name/assistant/send'");
    const nextRouteStart = routeSource.indexOf("router.post('/:name/assistant/read-file'", sendRouteStart);
    const sendRoute = routeSource.slice(sendRouteStart, nextRouteStart);

    expect(sendRoute.match(/createProjectChatDispatchPersistenceGate\(\)/g)).toHaveLength(2);
    expect(sendRoute.match(
      /durableEventPersistenceGate\.waitUntilAccepted/g,
    )).toHaveLength(2);
    expect(sendRoute.match(
      /durableEventPersistenceGate\.releaseAfter\(markProjectChatTurnProviderDispatchAccepted\(/g,
    )).toHaveLength(2);
    expect(sendRoute.match(
      /catch \(error\) \{\s*durableEventPersistenceGate\.release\(\);/g,
    )).toHaveLength(2);
    expect(sendRoute.match(
      /preferredContent: status === 'completed' \? fullText : null/g,
    )).toHaveLength(2);
  });

  test('rate-limits replay per authenticated actor, project, provider, and durable turn', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const limiterStart = routeSource.indexOf('const assistantPollLimiter = rateLimit({');
    const pollRouteStart = routeSource.indexOf("router.get('/:name/assistant/poll'", limiterStart);
    const limiter = routeSource.slice(limiterStart, pollRouteStart);

    expect(limiterStart).toBeGreaterThan(-1);
    expect(pollRouteStart).toBeGreaterThan(limiterStart);
    expect(limiter).toContain('keyGenerator: (req) =>');
    expect(limiter).toContain("req.user?.userId || 'unauthenticated'");
    expect(limiter).toContain("String(req.params.name || '')");
    expect(limiter).toContain('normalizeProjectChatProvider(req.query.provider)');
    expect(limiter).toContain("String(req.query.turnId || '').trim()");
    expect(limiter).toContain("code: 'PROJECT_REPLAY_RATE_LIMITED'");
    expect(routeSource).toContain("authenticateToken, assistantPollLimiter");
    expect(limiter).not.toContain('brokerSettlementFailure');
  });

  test('surfaces an exact broker settlement failure instead of waiting for lease expiry', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const pollStart = routeSource.indexOf("router.get('/:name/assistant/poll'");
    const abortStart = routeSource.indexOf("router.post('/:name/assistant/abort'", pollStart);
    const poll = routeSource.slice(pollStart, abortStart);

    expect(poll).toContain('isProjectNativeSettlementFailure(snapshot)');
    expect(poll).toContain('const replayActive = selectedTurnActive && !brokerSettlementFailure');
    expect(poll).toContain('active: replayActive');
    expect(poll).toContain('isProcessing: replayActive');
    expect(poll).toContain('PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE');
    expect(poll).toContain('brokerSettlementTerminal.seq === (baseReplayEvents.at(-1)?.seq ?? afterLine) + 1');
  });

  test('advances provider handoff only after durable completion and resets it with the provider session', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const settleStart = routeSource.indexOf('async function settleProjectChatTurnWithPresentation');
    const historyStart = routeSource.indexOf("router.get('/:name/chat/history'", settleStart);
    const settlement = routeSource.slice(settleStart, historyStart);
    const resetStart = routeSource.indexOf("router.post('/:name/assistant/reset'");
    const autoCommitStart = routeSource.indexOf("router.post('/:name/assistant/auto-commit'", resetStart);
    const reset = routeSource.slice(resetStart, autoCommitStart);
    const destructiveReset = fs.readFileSync(
      path.resolve(__dirname, '../services/projectChatDestructiveReset.ts'),
      'utf8',
    );

    expect(routeSource).toContain('projectChatBindingNeedsHandoff(binding, portalTranscriptCursor)');
    expect(routeSource).not.toContain('nativeSession.messages.length');
    expect(settlement).toContain('finishProjectChatTurn');
    expect(settlement.match(/finishProjectChatTurn/g)).toHaveLength(2);
    expect(settlement).toContain('handoff: {');
    expect(settlement).not.toContain('advanceProjectChatBindingHandoffAfterSettlement');
    expect(settlement).toContain("errorCode: 'SETTLEMENT_PERSISTENCE_FAILED'");
    expect(settlement).toContain('Terminal settlement reconciliation failed');
    expect(settlement).toContain('settlementStatus');
    expect(reset).toContain('performProjectChatDestructiveReset');
    expect(destructiveReset).toContain('handoffCursor: 0');
    expect(destructiveReset).toContain('handoffVersion: { increment: 1 }');
  });

  test('destructive reset is project-wide, admission-owned, and fails closed on unconfirmed aborts', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const resetService = fs.readFileSync(
      path.resolve(__dirname, '../services/projectChatDestructiveReset.ts'),
      'utf8',
    );
    const helperStart = routeSource.indexOf('async function performProjectChatDestructiveReset');
    const historyRoute = routeSource.indexOf("router.delete('/:name/chat/history'", helperStart);
    const resetRoute = routeSource.indexOf("router.post('/:name/assistant/reset'", historyRoute);
    const helper = routeSource.slice(helperStart, historyRoute);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper.indexOf('convergeProjectChatTurnForDestructiveReset')).toBeLessThan(
      helper.indexOf('quiesceProjectChatBrokerCallbacksForDestructiveReset'),
    );
    expect(helper.indexOf('quiesceProjectChatBrokerCallbacksForDestructiveReset')).toBeLessThan(
      helper.indexOf('withProjectChatRuntimeAdmission'),
    );
    expect(helper.indexOf('withProjectChatRuntimeAdmission')).toBeLessThan(
      helper.indexOf('commitProjectChatDestructiveReset'),
    );
    expect(routeSource).toContain('waitForProjectNativeRunSettlement');
    expect(routeSource).toContain('quiesceProjectNativeRunForDestructiveReset');
    expect(resetService).toContain('The provider process could not confirm cancellation; no Project Chat data was cleared.');
    expect(routeSource).not.toContain('.catch(() => false)');
    expect(routeSource.slice(historyRoute, resetRoute)).toContain('performProjectChatDestructiveReset');
    expect(routeSource.slice(resetRoute)).toContain('performProjectChatDestructiveReset');
    expect(resetService).toContain('projectChatProviderBinding.updateMany');
    expect(resetService).toContain("where: { userId: actorUserId, projectId: projectIdentityId }");
    expect(resetService).toContain('projectChatTurn.deleteMany');
    expect(resetService).toContain('id: { not: admissionTurnId }');
  });

  test('terminal projection and repair honor the reset turn tombstone and captured provider generation', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const materializeStart = routeSource.indexOf('async function materializeTerminalProjectChatAssistant');
    const repairStart = routeSource.indexOf('async function repairTerminalProjectChatPresentations', materializeStart);
    const settleStart = routeSource.indexOf('async function settleProjectChatTurnWithPresentation', repairStart);
    const materialize = routeSource.slice(materializeStart, repairStart);
    const repair = routeSource.slice(repairStart, settleStart);
    const nativeSendStart = routeSource.indexOf('if (isNativeProjectChatRouteProvider(provider))', settleStart);
    const sendEnd = routeSource.indexOf("router.post('/:name/assistant/read-file'", nativeSendStart);
    const send = routeSource.slice(nativeSendStart, sendEnd);

    expect(materialize).toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(materialize).toContain('transaction.projectChatTurn.findUnique');
    expect(materialize).toContain("binding?.status === 'reset'");
    expect(materialize).toContain('binding?.handoffVersion !== input.expectedHandoffVersion');
    expect(materialize.indexOf('if (')).toBeLessThan(materialize.indexOf('projectChatMessage.upsert'));
    expect(repair).toContain('if (repaired) await markProjectTurnPresentationMaterialized(turn)');
    expect(send).not.toMatch(/onComplete:[\s\S]{0,1200}projectChatMessage\.upsert/);
  });

  test('does not recursively traverse the workspace on native Project dispatch', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const sendStart = routeSource.indexOf("router.post('/:name/assistant/send'");
    const nativeStart = routeSource.indexOf('if (isNativeProjectChatRouteProvider(provider))', sendStart);
    const openClawStart = routeSource.indexOf("if (provider !== 'OPENCLAW')", nativeStart);
    const nativeSend = routeSource.slice(nativeStart, openClawStart);
    expect(nativeSend).not.toContain('prepareProjectChatLifecycleWorkspace(projectDir)');
    expect(nativeSend).toContain('Warm sends never traverse the repository');
    expect(nativeSend).toContain('startProjectNativeRun');
  });

  test('claims durable runtime admission before every route operation that can interrupt an active turn', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const routeBlock = (signature: string) => {
      const start = routeSource.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      const next = routeSource.indexOf('\nrouter.', start + signature.length);
      return routeSource.slice(start, next === -1 ? routeSource.length : next);
    };
    const send = routeBlock("router.post('/:name/assistant/send'");
    const ensureSession = routeBlock("router.post('/:name/assistant/ensure-session'");
    const providerSwitch = routeBlock("router.post('/:name/chat/provider'");
    const qualificationStart = routeSource.indexOf('function qualifyProjectChatProviderRoute');
    const qualificationEnd = routeSource.indexOf("router.post(\n  '/:name/chat/providers/openclaw/qualify'", qualificationStart);
    const qualification = routeSource.slice(qualificationStart, qualificationEnd);

    expect(send.indexOf('acquireProjectChatRuntimeAdmission')).toBeLessThan(send.indexOf('ensureNativeProjectChatBinding'));
    expect(send.indexOf('acquireProjectChatRuntimeAdmission')).toBeLessThan(send.indexOf('ensureOpenClawProjectRuntime'));
    expect(send.indexOf('ensureOpenClawProjectRuntime')).toBeLessThan(
      send.lastIndexOf('promoteProjectChatRuntimeAdmissionToTurn'),
    );
    expect(send).not.toContain('acquireProjectChatTurn');

    for (const block of [ensureSession, providerSwitch]) {
      expect(block.indexOf('withProjectChatRuntimeAdmission')).toBeGreaterThan(-1);
      expect(block.indexOf('withProjectChatRuntimeAdmission')).toBeLessThan(block.indexOf('ensureOpenClawProjectRuntime'));
    }
    expect(qualification.indexOf('withProjectChatRuntimeAdmission')).toBeLessThan(
      qualification.indexOf('qualifyProjectProvider'),
    );
    expect(routeSource).toContain("'/:name/chat/providers/codex/qualify'");
    expect(routeSource).toContain("'/:name/chat/providers/claude-code/qualify'");
    expect(routeSource).toContain("'/:name/chat/providers/antigravity/qualify'");
    expect(routeSource).toContain("'/:name/chat/providers/ollama/qualify'");
    expect(qualification).toContain('buildUnqualifiedProjectSandboxExecutionContext(provider, contextInput)');
    expect(qualification).toContain('getProjectChatProviderRuntimeDescriptor(provider)');
  });

  test('qualification attempts are rate-limited per actor, project, and provider without affecting capability reads', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const capabilityStart = routeSource.indexOf("router.get('/:name/chat/providers'");
    const identityAdmissionStart = routeSource.indexOf(
      'async function admitProjectQualificationRateLimitIdentity',
      capabilityStart,
    );
    const qualificationStart = routeSource.indexOf(
      'function projectQualificationLimiter',
      identityAdmissionStart,
    );
    const capabilityRoute = routeSource.slice(capabilityStart, qualificationStart);
    const identityAdmission = routeSource.slice(identityAdmissionStart, qualificationStart);
    const limiterEnd = routeSource.indexOf(
      'const projectAgentZeroModelCatalogLimiter',
      qualificationStart,
    );
    const limiter = routeSource.slice(qualificationStart, limiterEnd);
    const qualificationRouteStart = routeSource.indexOf(
      'function qualifyProjectChatProviderRoute',
      limiterEnd,
    );
    const qualificationRoutesStart = routeSource.indexOf(
      "router.post(\n  '/:name/chat/providers/openclaw/qualify'",
      qualificationRouteStart,
    );
    const qualificationRoute = routeSource.slice(
      qualificationRouteStart,
      qualificationRoutesStart,
    );

    expect(routeSource).toContain('function projectQualificationLimiter(provider: ProjectChatRouteProvider)');
    expect(identityAdmission).toContain('getExistingProjectPathReadOnly(workspaceOwnerId, projectName)');
    expect(identityAdmission).toContain('const projectIdentity = await readProjectIdentity({');
    expect(identityAdmission).not.toContain('ensureProjectIdentity(');
    expect(limiter).toContain('projectQualificationRateLimitKey({');
    expect(limiter).toContain('identity: requireProjectQualificationRateLimitIdentity(req)');
    expect(limiter).not.toContain('req.params.name');
    expect(limiter).toContain(
      '(req as ProjectQualificationRateLimitRequest).rateLimit?.resetTime',
    );
    expect(qualificationRoute).toContain(
      'const rateLimitIdentity = requireProjectQualificationRateLimitIdentity(req)',
    );
    expect(qualificationRoute).toContain(
      'const projectDir = getExistingProjectPathReadOnly(workspaceOwnerId, name)',
    );
    expect(qualificationRoute).not.toContain('resolveActorProjectChatWorkspace(req, name)');
    expect(qualificationRoute).toContain('const projectIdentity = await readProjectIdentity({');
    expect(qualificationRoute).toContain(
      'rateLimitIdentity.projectIdentityId !== projectIdentity.id',
    );
    expect(qualificationRoute).not.toContain('ensureProjectIdentity(');
    expect(routeSource).toContain("code: 'PROJECT_QUALIFICATION_RATE_LIMITED'");
    for (const provider of [
      'OPENCLAW',
      'CODEX',
      'CLAUDE_CODE',
      'GEMINI',
      'AGENT_ZERO',
      'OLLAMA',
    ] as const) {
      const limiterCall = `projectQualificationLimiter('${provider}')`;
      const limiterCallIndex = routeSource.indexOf(limiterCall, limiterEnd);
      const admissionIndex = routeSource.lastIndexOf(
        'admitProjectQualificationRateLimitIdentity',
        limiterCallIndex,
      );
      expect(limiterCallIndex).toBeGreaterThan(limiterEnd);
      expect(admissionIndex).toBeGreaterThan(limiterEnd);
      expect(admissionIndex).toBeLessThan(limiterCallIndex);
    }
    expect(capabilityRoute).not.toContain('projectQualificationLimiter(');
    expect(capabilityRoute).not.toContain('qualifyProjectProvider(');
    expect(capabilityRoute).not.toContain('withProjectChatRuntimeAdmission(');
  });

  test('provider discovery returns the active provider attested immutable project identity', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const capabilityStart = routeSource.indexOf("router.get('/:name/chat/providers'");
    const capabilityEnd = routeSource.indexOf('function projectQualificationLimiter', capabilityStart);
    const capabilityRoute = routeSource.slice(capabilityStart, capabilityEnd);

    expect(capabilityRoute).toContain(
      'const activeProvider = requireProjectChatRouteProvider(fromPersistedProjectChatProvider(',
    );
    // Discovery prefers the active provider but must not fail when its runtime
    // is absent, or the picker that is the only way off it becomes unreachable.
    expect(capabilityRoute).toContain(
      'const discovery = buildDiscoveryProjectSandboxExecutionContext(',
    );
    expect(capabilityRoute).toContain('activeProvider,\n      PROJECT_CHAT_ROUTE_PROVIDERS,\n      contextInput,');
    expect(capabilityRoute).toContain('const executionContext = discovery.context;');
    expect(capabilityRoute).toContain('executionContext,\n      providers,');
    expect(capabilityRoute).not.toContain('executionContext: null');
    // The client is told plainly when the selected lane cannot run here.
    expect(capabilityRoute).toContain('activeProviderRuntime: {');
    expect(capabilityRoute).toContain('available: !runtimeUnavailable,');
  });

  test('fences provider discovery and every qualification lane before legacy state migration', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const capabilityStart = routeSource.indexOf("router.get('/:name/chat/providers'");
    const capabilityEnd = routeSource.indexOf('function projectQualificationLimiter', capabilityStart);
    const capabilityRoute = routeSource.slice(capabilityStart, capabilityEnd);
    const qualificationStart = routeSource.indexOf('function qualifyProjectChatProviderRoute');
    const qualificationEnd = routeSource.indexOf(
      "router.post(\n  '/:name/chat/providers/openclaw/qualify'",
      qualificationStart,
    );
    const qualificationRoute = routeSource.slice(qualificationStart, qualificationEnd);

    for (const block of [capabilityRoute, qualificationRoute]) {
      const gate = block.indexOf('await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);');
      const migration = block.indexOf('await migrateLegacyProjectChatState({');
      expect(gate).toBeGreaterThan(-1);
      expect(migration).toBeGreaterThan(gate);
    }
    expect(capabilityRoute.indexOf('await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);'))
      .toBeLessThan(capabilityRoute.indexOf('resolveProjectChatQualificationMatrix('));
    expect(qualificationRoute.slice(
      0,
      qualificationRoute.indexOf('await migrateLegacyProjectChatState({'),
    )).not.toContain("if (provider === 'OPENCLAW')");
  });

  test('routes Ollama only through its dedicated Project adapter and exact live digest admission', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const bindingStart = routeSource.indexOf('async function ensureNativeProjectChatBinding');
    const bindingEnd = routeSource.indexOf('async function ensureSelectedProjectChatBinding', bindingStart);
    const binding = routeSource.slice(bindingStart, bindingEnd);
    const abortStart = routeSource.indexOf("router.post('/:name/assistant/abort'");
    const sendStart = routeSource.indexOf("router.post('/:name/assistant/send'", abortStart);
    const abort = routeSource.slice(abortStart, sendStart);

    expect(routeSource).toContain("'OLLAMA',\n] as const");
    expect(binding).toContain("if (input.provider === 'OLLAMA')");
    expect(binding.indexOf('withOllamaAuthorityRunLease')).toBeLessThan(
      binding.indexOf('ensureNativeProjectChatBindingWithAuthorityLease'),
    );
    expect(binding).toContain('resolveAllowedOllamaProjectModel');
    expect(binding).toContain('ollamaModelSelection.digest !== qualificationGrant.modelDigest');
    expect(binding).toContain('createdSession.metadata?.ollamaModelDigest !== ollamaModelSelection!.digest');
    expect(binding).toContain('getProjectChatProviderAdapter(input.provider).startSession');
    expect(binding).toContain('ollamaModelSelection');
    expect(binding).not.toContain('AgentRegistry.get');
    expect(abort).toContain('getProjectChatProviderAdapter(provider).abortActiveRun');
    expect(abort).toContain('activeUserTurn.id');
    expect(abort).not.toContain('AgentRegistry.get');
  });

  test('history, status, resume, active-model, and poll never ensure or create provider sessions', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const routeBlock = (signature: string) => {
      const start = routeSource.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      const next = routeSource.indexOf('\nrouter.', start + signature.length);
      return routeSource.slice(start, next === -1 ? routeSource.length : next);
    };
    const reads = [
      routeBlock("router.get('/:name/chat/history'"),
      routeBlock("router.get('/:name/chat/session-status'"),
      routeBlock("router.get('/:name/assistant/resume-session'"),
      routeBlock("router.get('/:name/assistant/active-model'"),
      routeBlock("router.get('/:name/assistant/poll'"),
    ];
    for (const block of reads) {
      expect(block).toContain('readOnly: true');
      expect(block).not.toContain('ensureSelectedProjectChatBinding');
      expect(block).not.toContain('ensureCodexProjectChatBinding');
      expect(block).not.toContain('ensureOpenClawProjectChatBinding');
      expect(block).not.toContain('ensureOpenClawProjectRuntime');
    }
    expect(reads[0]).not.toContain('repairTerminalProjectChatPresentations');
    expect(reads[4]).toContain('readExistingProjectChatBinding');
    expect(reads[4]).toContain('activeProviderTurn');
    expect(reads[4]).toContain('requireProviderSession: selectedTurnActive');
  });

  test('history and session status present stale bindings as recoverable without exposing old session identities', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const routeBlock = (signature: string) => {
      const start = routeSource.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      const next = routeSource.indexOf('\nrouter.', start + signature.length);
      return routeSource.slice(start, next === -1 ? routeSource.length : next);
    };
    const history = routeBlock("router.get('/:name/chat/history'");
    const status = routeBlock("router.get('/:name/chat/session-status'");

    for (const block of [history, status]) {
      expect(block).toContain('allowStaleContext: true');
      expect(block).toContain('requiresPreparation: true');
      expect(block).toContain("staleReason");
    }
    const staleHistoryBinding = history.slice(
      history.indexOf('} : staleBinding ? {'),
      history.indexOf('} : null,', history.indexOf('} : staleBinding ? {')),
    );
    expect(staleHistoryBinding).not.toContain('sessionKey');
    expect(status).toContain('sessionKey: null');
    expect(status).not.toContain('existing.staleBinding.sessionKey');
    expect(status).not.toContain('existing.staleBinding.externalSessionId');
  });

  test('fresh Project Chat selects existing qualified evidence before the OpenClaw fallback', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const providersStart = routeSource.indexOf("router.get('/:name/chat/providers'");
    const providersEnd = routeSource.indexOf('const projectOpenClawModelCatalogLimiter', providersStart);
    const providersRoute = routeSource.slice(providersStart, providersEnd);
    const qualifiedFallback = 'PROJECT_CHAT_ROUTE_PROVIDERS.find((provider) => qualifications[provider].selectable)';

    expect(providersRoute).toContain(qualifiedFallback);
    expect(providersRoute.indexOf(qualifiedFallback)).toBeLessThan(
      providersRoute.indexOf("|| 'OPENCLAW',"),
    );
  });

  test('provider discovery and switching reserve 403 for authorization failures', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const providersStart = routeSource.indexOf("router.get('/:name/chat/providers'");
    const providersEnd = routeSource.indexOf('const projectOpenClawModelCatalogLimiter', providersStart);
    const switchStart = routeSource.indexOf("router.post('/:name/chat/provider'");
    const switchEnd = routeSource.indexOf('// --- Portal-owned Project Chat transcript routes', switchStart);
    const providersRoute = routeSource.slice(providersStart, providersEnd);
    const switchRoute = routeSource.slice(switchStart, switchEnd);

    expect(providersRoute).toContain("code: 'PROJECT_PROVIDER_DISCOVERY_FAILED'");
    expect(providersRoute).toContain('res.status(503).json({');
    expect(providersRoute).not.toContain("res.status(403).json({ error: 'Project sandbox could not be verified' });");
    expect(switchRoute).toContain("code: 'PROJECT_PROVIDER_SWITCH_FAILED'");
    expect(switchRoute).toContain('res.status(503).json({');
    expect(switchRoute).not.toContain("res.status(403).json({ error: 'Project sandbox could not be verified' });");
  });

  test('closes admission and proves zero runtime residue before deleting project data', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const deleteStart = routeSource.indexOf("router.delete('/:name', authenticateToken");
    const renameStart = routeSource.indexOf("router.patch('/:name/rename'", deleteStart);
    const deleteRoute = routeSource.slice(deleteStart, renameStart);
    // The post-admission sequence is shared with automatic lifecycle-residue
    // recovery; both the route and recovery resume the same completion body.
    const completionStart = routeSource.indexOf('async function completeAdmittedProjectDeletion');
    const completion = routeSource.slice(
      completionStart,
      routeSource.indexOf("router.delete('/:name'", completionStart),
    );

    expect(deleteStart).toBeGreaterThan(-1);
    expect(renameStart).toBeGreaterThan(deleteStart);
    expect(completionStart).toBeGreaterThan(-1);
    expect(completionStart).toBeLessThan(deleteStart);
    expect(deleteRoute).toContain('beginProjectIdentityDeletion');
    expect(deleteRoute).toContain('beginOrphanedProjectIdentityDeletion');
    expect(deleteRoute).toContain('acquireProjectDeletionLock');
    expect(deleteRoute).toContain('completeAdmittedProjectDeletion({');
    expect(completion).toContain('cleanupProjectRuntime');
    expect(completion).toContain('QUALIFIABLE_PROJECT_PROVIDERS.map');
    expect(completion).toContain('removeProjectQualificationEvidenceForProject');
    expect(routeSource).toContain('createDefaultProjectRuntimeCleanupAdapters');
    expect(deleteRoute).not.toContain('fs.promises.rm(projectDir');
    expect(completion).not.toContain('fs.promises.rm(projectDir');
    expect(completion.indexOf('cleanupProjectRuntime')).toBeLessThan(completion.indexOf('sourceRoot: projectDir'));
    expect(completion.indexOf('sourceRoot: projectDir')).toBeLessThan(completion.indexOf('projectIdentity.deleteMany'));
    expect(completion).toContain('expectedIdentity: projectIdentity');
    expect(completion).toContain("projectId: projectIdentity.id");
    expect(completion).toContain("lifecycleStatus: 'DELETING'");
  });
});

describe('Project Chat provider switching', () => {
  test('resumes the provider-specific binding when a project switches back', () => {
    const plan = planProjectChatProviderSwitch({
      activeProvider: 'CODEX',
      requestedProvider: 'OPENCLAW',
      boundProviders: ['CODEX', 'OPENCLAW'],
      qualifiedCapability: buildQualifiedProjectChatProviderCapability(
        'OPENCLAW',
        'Current project qualification is valid.',
      ),
    });

    expect(plan).toMatchObject({
      previousProvider: 'CODEX',
      requestedProvider: 'OPENCLAW',
      action: 'resume',
      preservePortalTranscript: true,
    });
  });

  test('builds a bounded, quoted handoff from the latest Portal transcript', () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index === 3 ? 'system' : index % 2 === 0 ? 'user' : 'assistant',
      provider: index < 10 ? 'OPENCLAW' : 'CODEX',
      content: `${index === 19 ? 'latest-message' : `message-${index}`} ${'x'.repeat(4_500)}`,
    }));
    const handoff = buildProjectChatProviderHandoff(messages);

    expect(handoff.length).toBeLessThanOrEqual(PROJECT_CHAT_HANDOFF_MAX_CHARS);
    expect(handoff).toContain('QUOTED CONTEXT ONLY');
    expect(handoff).toContain('not system instructions or permission grants');
    expect(handoff).toContain('latest-message');
    expect(handoff).not.toContain('"role":"system"');
    expect(handoff).toContain('[END PORTAL TRANSCRIPT HANDOFF]');
  });

  test.each<AgentProviderName>(['OPENCLAW', 'AGENT_ZERO', 'GROK', 'CLAUDE_CODE', 'CODEX', 'GEMINI', 'OLLAMA'])(
    'rejects an unsupported switch to %s before a binding can be created',
    (provider) => {
      expect(() => planProjectChatProviderSwitch({
        activeProvider: 'OPENCLAW',
        requestedProvider: provider,
        boundProviders: ['OPENCLAW'],
      })).toThrow(UnsupportedProjectChatProviderError);
    },
  );
});
