import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../agents';
import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import * as openClawGatewayRpc from '../utils/openclawGatewayRpc';
import { buildProjectEgressPlaneSpec } from './projectEgressPlane';
import {
  __openClawProjectQualificationTest,
  OpenClawProjectQualificationError,
  assertOpenClawProjectQualificationGrant,
  getOpenClawProjectQualificationStatus,
  qualifyOpenClawProject,
  removeOpenClawProjectQualificationEvidenceForProject,
  requireOpenClawProjectQualification,
} from './openclawProjectQualification';

const ACTOR = 'project-qualification-user';
const PROJECT_ID = 'b46ca5b8-8cb1-4dbb-b122-5f09285ca3ad';
const RUNTIME_IMAGE = `sha256:${'1'.repeat(64)}`;
const PROXY_IMAGE = `sha256:${'2'.repeat(64)}`;
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const NOW = new Date('2026-07-19T12:00:00.000Z');

let root: string;
let projectRoot: string;
let evidenceRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-qualification-'));
  projectRoot = path.join(root, 'projects', ACTOR, 'alpha');
  evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<ReturnType<typeof createProjectSandboxExecutionContext>> = {}) {
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

function egress(ctx = context()) {
  return {
    identity: { actorId: ctx.userId, projectId: ctx.projectId, provider: 'OPENCLAW' },
    proxyImage: PROXY_IMAGE,
    token: Buffer.alloc(32, 9).toString('base64url'),
  };
}

function dependencies(ctx = context()) {
  const egressConfig = egress(ctx);
  const spec = buildProjectEgressPlaneSpec(egressConfig);
  return {
    now: () => new Date(NOW),
    evidenceRoot,
    secret: SECRET,
    ttlMs: 60 * 60_000,
    runProbes: jest.fn(async () => ({
      sandbox: {
        agentId: `p4oc-${'4'.repeat(40)}`,
        sessionKey: `agent:p4oc-${'4'.repeat(40)}:portal-project`,
        containerName: 'p4oc-qualified-runtime',
        configHash: '5'.repeat(64),
        runtimeFingerprint: '6'.repeat(64),
        egressPolicyFingerprint: spec.policyFingerprint,
        attestedAt: NOW.toISOString(),
      },
      spec,
      runtimeContainerId: '7'.repeat(64),
      runtimeContainerStartedAt: NOW.toISOString(),
      proxyContainerId: '8'.repeat(64),
      internalNetworkId: '9'.repeat(64),
      publicNetworkId: 'a'.repeat(64),
      modelProviderId: null,
      modelId: 'openai/gpt-5.5',
      modelDigest: null,
      executionProviderId: 'openai',
      executionRuntimeKind: 'openclaw-embedded',
      modelToolChallengeSha256: 'd'.repeat(64),
      modelResponseSha256: 'b'.repeat(64),
      probes: __openClawProjectQualificationTest.REQUIRED_PROBES.map((id) => ({
        id,
        passed: true as const,
        observedAt: NOW.toISOString(),
        evidenceSha256: 'c'.repeat(64),
      })),
    })),
    attestFinalEvidenceRuntime: jest.fn(async () => undefined),
  };
}

async function qualify(ctx = context()) {
  const egressConfig = egress(ctx);
  const deps = dependencies(ctx);
  const status = await qualifyOpenClawProject({
    context: ctx,
    egress: egressConfig,
    sender: { label: 'Owner', userId: ACTOR, role: 'OWNER' },
  }, deps);
  return { status, deps, egressConfig };
}

describe('OpenClaw Project qualification evidence', () => {
  test('is unavailable before the complete live matrix has passed', () => {
    const ctx = context();
    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egress(ctx) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ status: 'UNQUALIFIED', selectable: false });
  });

  test('writes root-private, actor/project-bound, tamper-evident evidence', async () => {
    const ctx = context();
    const { status, egressConfig } = await qualify(ctx);
    expect(status).toMatchObject({ status: 'QUALIFIED', selectable: true });
    expect(status.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const file = __openClawProjectQualificationTest.evidencePath(ctx, evidenceRoot);
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const serialized = fs.readFileSync(file, 'utf8');
    expect(serialized).not.toContain(ACTOR);
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain(egressConfig.token);
    expect(JSON.parse(serialized).payload).toMatchObject({
      runtimeContainerId: '7'.repeat(64),
      runtimeContainerStartedAt: NOW.toISOString(),
    });

    const grant = requireOpenClawProjectQualification({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    });
    expect(assertOpenClawProjectQualificationGrant(grant, ctx)).toBe(grant);
  });

  test('rejects re-signed evidence that omits its exact runtime start identity', async () => {
    const ctx = context();
    const { egressConfig } = await qualify(ctx);
    const file = __openClawProjectQualificationTest.evidencePath(ctx, evidenceRoot);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete envelope.payload.runtimeContainerStartedAt;
    envelope.mac = __openClawProjectQualificationTest.evidenceMac(envelope.payload, SECRET);
    fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });

    expect(() => requireOpenClawProjectQualification({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toThrow(/runtime start identity/i);
  });

  test('rejects forged grant objects even when every public field matches', async () => {
    const ctx = context();
    const { status } = await qualify(ctx);
    expect(() => assertOpenClawProjectQualificationGrant({
      provider: 'OPENCLAW',
      actorUserId: ACTOR,
      projectIdentityId: PROJECT_ID,
      policyFingerprint: ctx.policyFingerprint,
      evidenceFingerprint: status.evidenceFingerprint!,
      modelProviderId: null,
      modelId: null,
      modelDigest: null,
      executionProviderId: null,
      executionRuntimeKind: null,
      reason: 'forged',
    }, ctx)).toThrow(OpenClawProjectQualificationError);
  });

  test('fails closed after evidence tampering', async () => {
    const ctx = context();
    const { egressConfig } = await qualify(ctx);
    const file = __openClawProjectQualificationTest.evidencePath(ctx, evidenceRoot);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.payload.expiresAt = '2030-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });

    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ status: 'INVALID', selectable: false });
    expect(() => requireOpenClawProjectQualification({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toThrow(/authentication failed/i);
  });

  test('rejects authenticated evidence whose exact execution runtime drifts to a host CLI', async () => {
    const ctx = context();
    const { egressConfig } = await qualify(ctx);
    const file = __openClawProjectQualificationTest.evidencePath(ctx, evidenceRoot);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    envelope.payload.executionProviderId = 'claude-cli';
    envelope.payload.executionRuntimeKind = 'claude-cli';
    envelope.mac = __openClawProjectQualificationTest.evidenceMac(envelope.payload, SECRET);
    fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });

    expect(() => requireOpenClawProjectQualification({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toThrow(/external or unknown runtime|embedded model\/runtime proof/i);
  });

  test('accepts only an observed exec challenge that writes the canonical uid-1000 nonce and removes it', () => {
    const ctx = context();
    const nonce = 'A1b2C3d4E5f6G7h8I9j0K1l2';
    const marker = `PORTAL_PROJECT_SANDBOX_EXEC_${nonce}`;
    const command = 'fixed-server-command';
    const destination = path.join(ctx.canonicalRoot, `.portal-openclaw-qualification-${nonce}`);
    fs.writeFileSync(destination, nonce, { mode: 0o600 });
    fs.chownSync(destination, 1000, 1000);

    expect(__openClawProjectQualificationTest.verifyOpenClawModelToolChallenge({
      context: ctx,
      nonce,
      expectedCommand: command,
      expectedMarker: marker,
      events: [
        { type: 'tool_start', toolName: 'exec', toolArgs: { command }, toolCallId: 'call-1' },
        { type: 'tool_end', toolName: 'exec', toolResult: `${marker}\n`, toolCallId: 'call-1', exitCode: 0 },
      ],
    })).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  test('rejects a missing tool event and a phantom host workspace artifact', () => {
    const ctx = context();
    const nonce = 'Z1y2X3w4V5u6T7s8R9q0P1o2';
    const marker = `PORTAL_PROJECT_SANDBOX_EXEC_${nonce}`;
    const command = 'fixed-server-command';
    expect(() => __openClawProjectQualificationTest.verifyOpenClawModelToolChallenge({
      context: ctx,
      nonce,
      expectedCommand: command,
      expectedMarker: marker,
      events: [],
    })).toThrow(/exactly one observable exec/i);

    const phantom = path.join(root, `.portal-openclaw-qualification-${nonce}`);
    fs.writeFileSync(phantom, nonce);
    expect(() => __openClawProjectQualificationTest.verifyOpenClawModelToolChallenge({
      context: ctx,
      nonce,
      expectedCommand: command,
      expectedMarker: marker,
      events: [
        { type: 'tool_start', toolName: 'exec', toolArgs: { command }, toolCallId: 'call-2' },
        { type: 'tool_end', toolName: 'exec', toolResult: marker, toolCallId: 'call-2', exitCode: 0 },
      ],
    })).toThrow(/canonical project artifact/i);
  });

  test('rejects a transient same-name gateway target that lacks the immutable runtime marker', async () => {
    const ctx = context();
    const nonce = 'RuntimeMarkerNonce_123456';
    const runtimeContainerId = 'f'.repeat(64);
    const runtimeContainerStartedAt = NOW.toISOString();
    let privateMarker = '';
    let prompt = '';
    const executor = {
      run: jest.fn(async (_command: string, args: readonly string[]) => {
        if (args[2] === 'container' && args[3] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Id: runtimeContainerId,
              Image: RUNTIME_IMAGE,
              State: { Running: true, StartedAt: runtimeContainerStartedAt },
            }]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[2] === 'container'
          && args[3] === 'exec'
          && String(args[9] || '').includes('os.O_EXCL')) {
          privateMarker = String(args.at(-1) || '');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    jest.spyOn(openClawGatewayRpc, 'patchSessionModel').mockResolvedValue({
      ok: true,
      resolved: {
        modelProvider: 'openai',
        model: 'gpt-5.5',
        agentRuntime: { id: 'openclaw' },
      },
    });
    jest.spyOn(openClawGatewayRpc, 'getSessionInfo').mockResolvedValue({
      ok: true,
      data: {
        modelProvider: 'openai',
        model: 'gpt-5.5',
        agentHarnessId: null,
      },
    });
    jest.spyOn(openClawGatewayRpc, 'deleteSession').mockResolvedValue({ ok: true });
    const provider = {
      sendMessage: jest.fn(async (
        _sessionKey: string,
        message: string,
        _onChunk: unknown,
        onStatus: (event: unknown) => void,
      ) => {
        prompt = message;
        const prefix = 'Use exactly this JSON argument: ';
        const challengeLine = message.split('\n').find((line) => line.startsWith(prefix)) || '';
        const { command } = JSON.parse(challengeLine.slice(prefix.length));
        const destination = path.join(
          ctx.canonicalRoot,
          `.portal-openclaw-qualification-${nonce}`,
        );
        fs.writeFileSync(destination, nonce, { mode: 0o600 });
        fs.chownSync(destination, 1000, 1000);
        onStatus({
          type: 'tool_start',
          toolName: 'exec',
          toolArgs: { command },
          toolCallId: 'counterfeit-call',
        });
        // A counterfeit occupying only the deterministic name can still see
        // the shared project bind, but it cannot read the random marker staged
        // in the original immutable runtime's private /tmp.
        onStatus({
          type: 'tool_end',
          toolName: 'exec',
          toolResult: `PORTAL_PROJECT_SANDBOX_EXEC_${nonce}\n`,
          toolCallId: 'counterfeit-call',
          exitCode: 0,
        });
        return { fullText: `PORTAL_PROJECT_QUALIFICATION_${nonce}` };
      }),
      abortActiveRun: jest.fn(async () => true),
    };
    jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider as any);

    await expect(__openClawProjectQualificationTest.runDefaultModelProbe({
      sessionKey: 'agent:p4oc-runtime-marker:portal-project',
      context: ctx,
      sender: { label: 'Owner', userId: ACTOR, role: 'OWNER' },
      nonce,
      model: 'openai/gpt-5.5',
      runtimeContainerId,
      runtimeContainerStartedAt,
      executor,
    })).rejects.toThrow(/exec tool did not complete successfully/i);
    expect(privateMarker).toMatch(/^[a-f0-9]{64}$/);
    expect(prompt).not.toContain(privateMarker);
    const execCalls = executor.run.mock.calls
      .map((call) => call[1] as readonly string[])
      .filter((args) => args[2] === 'container' && args[3] === 'exec');
    expect(execCalls.length).toBeGreaterThanOrEqual(2);
    expect(execCalls.every((args) => args[6] === runtimeContainerId)).toBe(true);
    expect(fs.existsSync(path.join(
      ctx.canonicalRoot,
      `.portal-openclaw-qualification-${nonce}`,
    ))).toBe(false);
  });

  test('targets every static live probe by the full immutable runtime ID', async () => {
    const executor = {
      run: jest.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
    };
    await expect(__openClawProjectQualificationTest.runContainerCommand({
      executor,
      containerId: 'f'.repeat(64),
      args: ['sh', '-lc', 'true'],
      expectSuccess: true,
      id: 'deny_sibling_host_paths',
      now: NOW,
      displayName: 'OpenClaw',
    })).resolves.toMatchObject({ passed: true });
    expect(executor.run).toHaveBeenCalledWith(
      'docker',
      [
        '--host', 'unix:///var/run/docker.sock',
        'container', 'exec', 'f'.repeat(64),
        'sh', '-lc', 'true',
      ],
      { allowExitCodes: expect.any(Array) },
    );
  });

  test('expires evidence and refuses a changed policy or image', async () => {
    const ctx = context();
    const { egressConfig } = await qualify(ctx);
    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: SECRET,
      now: () => new Date(NOW.getTime() + 2 * 60 * 60_000),
    })).toMatchObject({ status: 'EXPIRED', selectable: false });

    const changed = context({
      runtimeImageDigest: `sha256:${'d'.repeat(64)}`,
      policyFingerprint: 'e'.repeat(64),
    });
    // Evidence filenames remain actor/project bound, so policy drift reaches
    // the authenticated payload check rather than looking like a new actor.
    expect(getOpenClawProjectQualificationStatus({ context: changed, egress: egress(changed) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ status: 'INVALID', selectable: false });
    expect(getOpenClawProjectQualificationStatus({ context: changed, egress: egress(changed) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => new Date(NOW.getTime() + 2 * 60 * 60_000),
    })).toMatchObject({ status: 'EXPIRED', selectable: false });
  });

  test('rejects evidence signed by another secret', async () => {
    const ctx = context();
    const { egressConfig } = await qualify(ctx);
    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egressConfig }, {
      evidenceRoot,
      secret: Buffer.alloc(32, 4).toString('base64url'),
      now: () => NOW,
    })).toMatchObject({ status: 'INVALID', selectable: false });
  });

  test('does not persist partial evidence when a live probe fails', async () => {
    const ctx = context();
    const deps = dependencies(ctx);
    deps.runProbes.mockRejectedValueOnce(new Error('private target became reachable'));
    await expect(qualifyOpenClawProject({
      context: ctx,
      egress: egress(ctx),
      sender: { label: 'Owner', userId: ACTOR, role: 'OWNER' },
    }, deps)).rejects.toThrow('private target became reachable');
    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egress(ctx) }, deps))
      .toMatchObject({ status: 'UNQUALIFIED', selectable: false });
  });

  test.each([
    ['an off-name runtime claimant', 'RUNTIME_IDENTITY_INVENTORY'],
    ['a same-name runtime substitution', 'RUNTIME_IDENTITY_RACE'],
    ['a same-ID runtime restart', 'RUNTIME_IDENTITY_RACE'],
    ['an egress-plane substitution', 'PLANE_IDENTITY_RACE'],
  ])('does not write evidence when the final barrier detects %s', async (_label, code) => {
    const ctx = context();
    const deps = dependencies(ctx);
    const barrierFailure = Object.assign(new Error('final immutable barrier rejected drift'), { code });
    deps.attestFinalEvidenceRuntime.mockRejectedValueOnce(barrierFailure);

    await expect(qualifyOpenClawProject({
      context: ctx,
      egress: egress(ctx),
      sender: { label: 'Owner', userId: ACTOR, role: 'OWNER' },
    }, deps)).rejects.toBe(barrierFailure);

    const destination = __openClawProjectQualificationTest.evidencePath(ctx, evidenceRoot);
    expect(fs.existsSync(destination)).toBe(false);
    expect(deps.runProbes).toHaveBeenCalledTimes(1);
    expect(deps.attestFinalEvidenceRuntime).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'OPENCLAW',
      bundle: expect.objectContaining({
        runtimeContainerId: '7'.repeat(64),
        runtimeContainerStartedAt: NOW.toISOString(),
      }),
    }));
    expect(deps.runProbes.mock.invocationCallOrder[0])
      .toBeLessThan(deps.attestFinalEvidenceRuntime.mock.invocationCallOrder[0]);
  });

  test('revokes previous evidence before an explicit requalification attempt', async () => {
    const ctx = context();
    await qualify(ctx);
    const deps = dependencies(ctx);
    deps.runProbes.mockRejectedValueOnce(new Error('runtime drift detected'));

    await expect(qualifyOpenClawProject({
      context: ctx,
      egress: egress(ctx),
      sender: { label: 'Owner', userId: ACTOR, role: 'OWNER' },
    }, deps)).rejects.toThrow('runtime drift detected');

    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egress(ctx) }, deps))
      .toMatchObject({ status: 'UNQUALIFIED', selectable: false });
  });

  test('refuses a sender that does not own the immutable project context', async () => {
    const ctx = context();
    const deps = dependencies(ctx);
    await expect(qualifyOpenClawProject({
      context: ctx,
      egress: egress(ctx),
      sender: { label: 'Other', userId: 'other-user', role: 'OWNER' },
    }, deps)).rejects.toThrow(/identity did not match/i);
    expect(deps.runProbes).not.toHaveBeenCalled();
  });

  test('rejects a symlinked evidence path', () => {
    const ctx = context();
    const file = __openClawProjectQualificationTest.evidencePath(ctx, evidenceRoot);
    const target = path.join(root, 'attacker.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, file);
    expect(getOpenClawProjectQualificationStatus({ context: ctx, egress: egress(ctx) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ status: 'INVALID', selectable: false });
  });

  test('project cleanup removes every actor grant for only that immutable project', async () => {
    const first = context();
    const second = context({ projectId: '61aca3c7-5f40-48bf-9e4e-1c514a37a8c4' });
    await qualify(first);
    await qualify(second);

    expect(removeOpenClawProjectQualificationEvidenceForProject(PROJECT_ID, { evidenceRoot })).toBe(1);
    expect(getOpenClawProjectQualificationStatus({ context: first, egress: egress(first) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ status: 'UNQUALIFIED', selectable: false });
    expect(getOpenClawProjectQualificationStatus({ context: second, egress: egress(second) }, {
      evidenceRoot,
      secret: SECRET,
      now: () => NOW,
    })).toMatchObject({ status: 'QUALIFIED', selectable: true });
  });
});
