import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../agents';
import {
  createHostOperatorExecutionContext,
  createProjectSandboxExecutionContext,
} from '../agents/executionScope';
import type { NativeSessionData } from '../agents/providers/NativeSessionStore';
import type { AdminUserRetirementManifestV1 } from './adminUserRetirementLedger';
import {
  retireAdminUserExternalState,
  verifyAdminUserExternalStateAbsence,
} from './adminUserRetirementExternalState';
import {
  digestAdminUserRetirementSnapshot,
} from './adminUserRetirementManifest';
import { buildOpenClawRetirementIdentityAttestation } from './openClawLegacySessionPrivacy';
import { getProjectChatProviderAdapter } from './projectChatProviderRegistry';
import {
  captureAdminUserRetirementManagedPath,
  retireAdminUserManagedPath,
} from './adminUserRetirementManagedPath';

describe('admin user external-state retirement adapters', () => {
  let sandbox: string;
  let managedRoot: string;
  let managedTarget: string;
  let manifest: AdminUserRetirementManifestV1;
  let database: any;
  let jobs: any[];
  let nativeSessions: NativeSessionData[];
  let mailboxes: string[];
  let authState: Record<string, string[]>;
  let ollamaAttributions: string[];
  let nativeOllamaAttributions: string[];
  let gatewayPresent: boolean;
  let appRuntimePresent: boolean;
  let renewLease: jest.Mock;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-retirement-external-'));
    managedRoot = path.join(sandbox, 'uploads');
    managedTarget = path.join(managedRoot, 'user-target-user');
    fs.mkdirSync(managedTarget, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(managedTarget, 'private.txt'), 'private');
    const managedPath = captureAdminUserRetirementManagedPath({
      targetUserId: 'target-user',
      managedRoot,
      targetPath: managedTarget,
      kind: 'DIRECTORY',
    });
    const nativeContext = createHostOperatorExecutionContext('target-user');
    const nativeSession: NativeSessionData = {
      sessionId: 'codex-target-user-1',
      provider: 'CODEX',
      userId: 'target-user',
      createdAt: '2026-07-29T00:00:00.000Z',
      lastActivityAt: '2026-07-29T00:00:00.000Z',
      cwd: '/workspace',
      executionContext: nativeContext,
      messages: [],
    };
    const localGatewayIdentity = {
      agentId: 'portal',
      sessionKey: 'agent:portal:host-session',
      sessionId: 'gateway-transcript-1',
    };
    manifest = {
      version: 1,
      target: {
        id: 'target-user',
        role: 'USER',
        authorizationVersion: 7,
        emailDigest: 'a'.repeat(64),
        username: 'target',
        avatarBasename: null,
      },
      requestedByUserId: 'owner-user',
      ownedProjects: [{
        id: 'project-owned',
        projectName: 'alpha',
        canonicalRoot: '/portal/projects/target-user/alpha',
        generation: 1,
        lifecycleStatus: 'ACTIVE',
        rootDevice: '8',
        rootInode: '101',
        rootBirthtimeNs: '1000000101',
        rootPresent: false,
      }],
      actorRuntimeState: {
        projectIdentityIds: [],
        legacyProjectIds: [],
        chatStateIds: [],
        turnIds: [],
        resetJournalIds: [],
        providerBindingIds: [],
        providerSessionRowIds: [],
        providerSessionIds: [],
        gatewaySessionKeys: [],
        messageIds: [],
        legacyImportIds: [],
        legacyQuarantineIds: [],
        legacyClearTombstoneIds: [],
      },
      dependencyEvidence: {
        completeRepairReceiptIds: [],
        cleanupActors: [],
      },
      apps: [{
        id: 'app-1',
        name: 'demo',
        projectIdentityId: 'project-owned',
        deployType: 'fullstack',
        processStatus: 'running',
        sourcePath: '/portal/apps/target-user-demo',
        deployPath: '/var/www/bridgesllm-apps/target-user-demo',
        port: 3210,
        shareLinkIds: ['share-1'],
        shareTokenDigests: [digestAdminUserRetirementSnapshot('private-share-token')],
      }],
      files: [{
        id: 'file-1',
        path: 'uploads/private.txt',
        cloudinaryId: null,
      }],
      agentJobs: [{
        id: 'job-1',
        status: 'running',
        transcriptPath: null,
        metadataDigest: digestAdminUserRetirementSnapshot({ runtime: { pid: 123 } }),
      }],
      agentSessions: [{
        id: 'agent-session-1',
        provider: 'OPENCLAW',
        externalId: localGatewayIdentity.sessionKey,
        localAgentId: localGatewayIdentity.agentId,
        localSessionId: localGatewayIdentity.sessionId,
        localIdentityDigest: digestAdminUserRetirementSnapshot(
          buildOpenClawRetirementIdentityAttestation({
            identity: localGatewayIdentity,
            family: 'current-2026.9.1',
          }),
        ),
      }],
      authState: {
        sessionIds: ['auth-1'],
        emailVerificationCodeIds: ['email-1'],
        twoFactorChallengeIds: ['two-factor-1'],
        passwordResetTokenIds: ['password-reset-1'],
      },
      mailboxes: { usernames: ['target'] },
      providerAttributions: {
        ollamaBindingIds: ['ollama-1'],
        nativeOllamaBindingIds: ['native-ollama-1'],
      },
      localTargets: {
        managedPaths: [managedPath],
        nativeSessions: [{
          provider: 'CODEX',
          sessionId: nativeSession.sessionId,
          identityDigest: digestAdminUserRetirementSnapshot({
            sessionId: nativeSession.sessionId,
            provider: nativeSession.provider,
            userId: nativeSession.userId,
            executionContext: nativeSession.executionContext,
          }),
          executionScope: 'HOST_OPERATOR',
          projectIdentityId: null,
        }],
      },
    };

    jobs = [{
      id: 'job-1',
      status: 'running',
      transcriptPath: null,
      metadata: { runtime: { pid: 123 } },
    }];
    nativeSessions = [nativeSession];
    mailboxes = ['target'];
    authState = {
      session: ['auth-1'],
      emailVerificationCode: ['email-1'],
      twoFactorChallenge: ['two-factor-1'],
      passwordResetToken: ['password-reset-1'],
    };
    ollamaAttributions = ['ollama-1'];
    nativeOllamaAttributions = ['native-ollama-1'];
    gatewayPresent = true;
    appRuntimePresent = true;
    renewLease = jest.fn(async () => undefined);

    const authDelegate = (key: keyof typeof authState) => ({
      findMany: jest.fn(async () => authState[key].map((id) => ({ id }))),
      deleteMany: jest.fn(async ({ where }: any) => {
        authState[key] = authState[key].filter((id) => !where.id.in.includes(id));
        return { count: 1 };
      }),
      count: jest.fn(async () => authState[key].length),
    });
    database = {
      app: {
        findMany: jest.fn(async () => [{
          id: 'app-1',
          name: 'demo',
          projectIdentityId: 'project-owned',
          deployType: 'fullstack',
          processStatus: 'running',
          zipPath: '/portal/apps/target-user-demo',
          port: 3210,
          shareLinks: [{ id: 'share-1', token: 'private-share-token' }],
        }]),
      },
      file: {
        findMany: jest.fn(async () => [{
          id: 'file-1',
          path: 'uploads/private.txt',
          cloudinaryId: null,
        }]),
      },
      agentJob: {
        findMany: jest.fn(async () => jobs.map((job) => ({ ...job }))),
      },
      agentSession: {
        findMany: jest.fn(async () => [{
          id: 'agent-session-1',
          provider: 'OPENCLAW',
          externalId: 'agent:portal:host-session',
        }]),
      },
      mailboxAccount: {
        findMany: jest.fn(async () => mailboxes.map((username) => ({ username }))),
        count: jest.fn(async () => mailboxes.length),
      },
      ollamaBackendBinding: {
        findMany: jest.fn(async () => ollamaAttributions.map((id) => ({ id }))),
        updateMany: jest.fn(async () => {
          ollamaAttributions = [];
          return { count: 1 };
        }),
        count: jest.fn(async () => ollamaAttributions.length),
      },
      nativeOllamaBackendBinding: {
        findMany: jest.fn(async () => nativeOllamaAttributions.map((id) => ({ id }))),
        updateMany: jest.fn(async () => {
          nativeOllamaAttributions = [];
          return { count: 1 };
        }),
        count: jest.fn(async () => nativeOllamaAttributions.length),
      },
      session: authDelegate('session'),
      emailVerificationCode: authDelegate('emailVerificationCode'),
      twoFactorChallenge: authDelegate('twoFactorChallenge'),
      passwordResetToken: authDelegate('passwordResetToken'),
      systemSetting: {
        findUnique: jest.fn(async () => null),
      },
    };
    database.$transaction = jest.fn(async (operation: (tx: any) => Promise<unknown>) => (
      operation(database)
    ));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function dependencies(overrides: Record<string, unknown> = {}) {
    return {
      database,
      initializeJobs: jest.fn(async () => undefined),
      killJob: jest.fn(async (jobId: string) => {
        const job = jobs.find((candidate) => candidate.id === jobId);
        job.status = 'killed';
        job.metadata = { reconciled: true };
      }),
      listNativeSessions: jest.fn((provider: string) => (
        nativeSessions.filter((session) => session.provider === provider)
      )),
      terminateNativeSession: jest.fn(async (targetSession: NativeSessionData) => {
        nativeSessions = nativeSessions.filter((session) => session.sessionId !== targetSession.sessionId);
      }),
      deleteGatewaySession: jest.fn(async () => {
        gatewayPresent = false;
        return { ok: true, deleted: true, archived: [] };
      }),
      readGatewaySession: jest.fn(async () => (
        gatewayPresent
          ? {
              agentId: 'portal',
              sessionKey: 'agent:portal:host-session',
              sessionId: 'gateway-transcript-1',
            }
          : null
      )),
      attestOpenClawRuntimeFamily: jest.fn(async () => 'current-2026.9.1' as const),
      forgetApp: jest.fn(async () => {
        appRuntimePresent = false;
      }),
      stopApp: jest.fn(async () => {
        appRuntimePresent = false;
      }),
      getAppStatus: jest.fn(() => appRuntimePresent ? { status: 'running' } : null),
      deleteMailbox: jest.fn(async (username: string) => {
        mailboxes = mailboxes.filter((candidate) => candidate !== username);
      }),
      assertMailboxAbsent: jest.fn(async (username: string) => {
        if (mailboxes.includes(username)) throw new Error('mailbox remains');
      }),
      ...overrides,
    };
  }

  function runnerContext() {
    return {
      retirementId: 'retirement-1',
      manifestDigest: 'e'.repeat(64),
      assertHeld: renewLease,
      renewLease,
      readAdmissionEvidence: () => ({
        transitionId: 'transition-1',
        closedAuthorizationVersion: 8,
        evidenceDigest: 'f'.repeat(64),
      }),
    };
  }

  function bindNativeSession(session: NativeSessionData): void {
    nativeSessions = [session];
    manifest.localTargets.nativeSessions = [{
      provider: session.provider,
      sessionId: session.sessionId,
      identityDigest: digestAdminUserRetirementSnapshot({
        sessionId: session.sessionId,
        provider: session.provider,
        userId: session.userId,
        executionContext: session.executionContext || null,
      }),
      executionScope: session.executionContext?.scope || 'UNBOUND',
      projectIdentityId: session.executionContext?.scope === 'PROJECT_SANDBOX'
        ? session.executionContext.projectId
        : null,
    }];
  }

  test('uses a cleanup-only host controller when the sealed session is HOST_OPERATOR', async () => {
    const terminateSession = jest.fn(async (sessionId: string) => {
      nativeSessions = nativeSessions.filter((session) => session.sessionId !== sessionId);
    });
    const controller = Object.freeze({ providerName: 'CODEX' as const, terminateSession });
    const controllerLookup = jest.spyOn(AgentRegistry, 'getProviderCleanupController')
      .mockReturnValue(controller);
    const deps = dependencies();
    delete (deps as any).terminateNativeSession;

    await expect(retireAdminUserExternalState(manifest, runnerContext(), deps))
      .resolves.toBeUndefined();

    expect(controllerLookup).toHaveBeenCalledWith('CODEX');
    expect(terminateSession).toHaveBeenCalledWith('codex-target-user-1');
    expect(deps.deleteGatewaySession).toHaveBeenCalledWith(
      'agent:portal:host-session',
      expect.objectContaining({
        agentId: 'portal',
        expectedSessionId: 'gateway-transcript-1',
        deleteTranscriptWithoutArchive: true,
      }),
    );
    expect(deps.deleteGatewaySession).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deleteTranscript: true }),
    );
  });

  test('dispatches retained 7.1 through archive-then-hard-delete and keeps 9.1-only fields off the RPC', async () => {
    const legacySessionFile = '/root/.openclaw/agents/portal/sessions/gateway-transcript-1.jsonl';
    const legacyTarget = Object.freeze({
      stateRoot: '/root/.openclaw',
      sessionsDir: '/root/.openclaw/agents/portal/sessions',
      registryPath: '/root/.openclaw/agents/portal/sessions/sessions.json',
      sessionFile: legacySessionFile,
    });
    const legacyIdentity = Object.freeze({
      agentId: 'portal',
      sessionKey: 'agent:portal:host-session',
      sessionId: 'gateway-transcript-1',
    });
    manifest.agentSessions[0].localIdentityDigest = digestAdminUserRetirementSnapshot(
      buildOpenClawRetirementIdentityAttestation({
        identity: legacyIdentity,
        family: 'legacy-2026.7.1',
        legacySessionFile,
      }),
    );
    const archivedPath = `${legacySessionFile}.deleted.2026-08-31T12-00-00.000Z`;
    const captureLegacyOpenClawSession = jest.fn(() => legacyTarget);
    const hardDeleteLegacyOpenClawSession = jest.fn(async () => undefined);
    const assertLegacyOpenClawSessionAbsent = jest.fn(() => undefined);
    const deps = dependencies({
      attestOpenClawRuntimeFamily: jest.fn(async () => 'legacy-2026.7.1' as const),
      resolveLegacyOpenClawSession: jest.fn(() => legacyTarget),
      captureLegacyOpenClawSession,
      hardDeleteLegacyOpenClawSession,
      assertLegacyOpenClawSessionAbsent,
      deleteGatewaySession: jest.fn(async () => {
        gatewayPresent = false;
        return { ok: true, deleted: true, archived: [archivedPath] };
      }),
    });

    await expect(retireAdminUserExternalState(manifest, runnerContext(), deps))
      .resolves.toBeUndefined();

    expect(deps.deleteGatewaySession).toHaveBeenCalledWith(
      legacyIdentity.sessionKey,
      {
        agentId: legacyIdentity.agentId,
        expectedSessionId: legacyIdentity.sessionId,
        deleteTranscript: true,
      },
    );
    expect(hardDeleteLegacyOpenClawSession).toHaveBeenCalledWith({
      identity: legacyIdentity,
      archivedPaths: [archivedPath],
    });
    expect(captureLegacyOpenClawSession).toHaveBeenCalledWith(legacyIdentity);
    expect(assertLegacyOpenClawSessionAbsent).toHaveBeenCalledWith(legacyIdentity);
  });

  test('fails closed on runtime-family drift, an unknown attestation, and a 9.1 archive receipt', async () => {
    const legacyTarget = Object.freeze({
      stateRoot: '/root/.openclaw',
      sessionsDir: '/root/.openclaw/agents/portal/sessions',
      registryPath: '/root/.openclaw/agents/portal/sessions/sessions.json',
      sessionFile: '/root/.openclaw/agents/portal/sessions/gateway-transcript-1.jsonl',
    });
    const driftDependencies = dependencies({
      attestOpenClawRuntimeFamily: jest.fn(async () => 'legacy-2026.7.1' as const),
      resolveLegacyOpenClawSession: jest.fn(() => legacyTarget),
    });
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      driftDependencies,
    )).rejects.toThrow(/runtime family or privacy identity changed/i);
    expect(driftDependencies.deleteGatewaySession).not.toHaveBeenCalled();

    const unknownDependencies = dependencies({
      attestOpenClawRuntimeFamily: jest.fn(async () => {
        throw new Error('mixed tuple');
      }),
    });
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      unknownDependencies,
    )).rejects.toThrow(/could not be attested exactly/i);
    expect(unknownDependencies.deleteGatewaySession).not.toHaveBeenCalled();

    const archiveDependencies = dependencies({
      deleteGatewaySession: jest.fn(async () => {
        gatewayPresent = false;
        return {
          ok: true,
          deleted: true,
          archived: ['/root/.openclaw/agents/portal/sessions/unexpected.deleted'],
        };
      }),
    });
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      archiveDependencies,
    )).rejects.toThrow(/produced an archive during atomic hard deletion/i);
  });

  test('rejects a successful-looking receipt that did not delete the sealed session', async () => {
    const deps = dependencies({
      deleteGatewaySession: jest.fn(async () => ({
        ok: true,
        deleted: false,
        archived: [],
      })),
    });

    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      deps,
    )).rejects.toThrow(/did not confirm the sealed session/i);
  });

  test('routes a sealed Project Agent Zero session through its dedicated confined adapter', async () => {
    const stat = fs.statSync(managedTarget, { bigint: true });
    bindNativeSession({
      sessionId: 'agent-zero-project-target-user-1',
      provider: 'AGENT_ZERO',
      userId: 'target-user',
      createdAt: '2026-07-29T00:00:00.000Z',
      lastActivityAt: '2026-07-29T00:00:00.000Z',
      cwd: managedTarget,
      executionContext: createProjectSandboxExecutionContext({
        userId: 'target-user',
        projectId: 'project-owned',
        workspaceOwnerId: 'target-user',
        projectName: 'owned-project',
        canonicalRoot: fs.realpathSync(managedTarget),
        rootDevice: stat.dev.toString(),
        rootInode: stat.ino.toString(),
        rootBirthtimeNs: stat.birthtimeNs.toString(),
        runtimePolicyVersion: 'portal-project-sandbox-v1',
        egressPolicyVersion: 'portal-project-egress-v1',
        runtimeImageDigest: `sha256:${'a'.repeat(64)}`,
        policyFingerprint: 'b'.repeat(64),
      }),
      messages: [],
    });
    const adapter = getProjectChatProviderAdapter('AGENT_ZERO');
    const terminateSession = jest.spyOn(adapter, 'terminateSession')
      .mockImplementation(async (sessionId: string) => {
        nativeSessions = nativeSessions.filter((session) => session.sessionId !== sessionId);
      });
    const hostController = jest.spyOn(AgentRegistry, 'getProviderCleanupController');
    const deps = dependencies();
    delete (deps as any).terminateNativeSession;

    await expect(retireAdminUserExternalState(manifest, runnerContext(), deps))
      .resolves.toBeUndefined();

    expect(terminateSession).toHaveBeenCalledWith('agent-zero-project-target-user-1');
    expect(hostController).not.toHaveBeenCalled();
  });

  test('resumes after a crash at the durable path rename boundary and emits stable absence evidence', async () => {
    let firstManagedMutation = true;
    const firstDependencies = dependencies({
      retireManagedPath: async (target: any) => {
        await retireAdminUserManagedPath(target, {
          afterRename: () => {
            if (!firstManagedMutation) return;
            firstManagedMutation = false;
            throw new Error('simulated crash after quarantine rename');
          },
        });
      },
    });
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      firstDependencies,
    )).rejects.toThrow('simulated crash after quarantine rename');
    expect(fs.existsSync(managedTarget)).toBe(false);
    expect(fs.existsSync(manifest.localTargets.managedPaths[0].quarantinePath)).toBe(true);
    expect(jobs[0].status).toBe('killed');
    expect(nativeSessions).toEqual([]);
    expect(gatewayPresent).toBe(false);
    expect(mailboxes).toEqual([]);

    const retryDependencies = dependencies();
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      retryDependencies,
    )).resolves.toBeUndefined();
    expect(fs.existsSync(manifest.localTargets.managedPaths[0].quarantinePath)).toBe(false);
    expect(authState).toEqual({
      session: [],
      emailVerificationCode: [],
      twoFactorChallenge: [],
      passwordResetToken: [],
    });
    expect(ollamaAttributions).toEqual([]);
    expect(nativeOllamaAttributions).toEqual([]);

    const firstEvidence = await verifyAdminUserExternalStateAbsence(
      manifest,
      runnerContext(),
      retryDependencies,
    );
    const secondEvidence = await verifyAdminUserExternalStateAbsence(
      manifest,
      runnerContext(),
      retryDependencies,
    );
    expect(firstEvidence.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(secondEvidence).toEqual(firstEvidence);
    expect(renewLease).toHaveBeenCalled();
  });

  test('fails before mutation when a new native session or external file identity appears', async () => {
    nativeSessions.push({
      ...nativeSessions[0],
      sessionId: 'codex-target-user-unmanifested',
    });
    const deps = dependencies();
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      deps,
    )).rejects.toThrow(/Native session .* changed after/i);
    expect(deps.terminateNativeSession).not.toHaveBeenCalled();

    nativeSessions = nativeSessions.slice(0, 1);
    database.file.findMany.mockResolvedValue([{
      id: 'file-1',
      path: 'uploads/private.txt',
      cloudinaryId: 'new-cloud-identity',
    }]);
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      dependencies(),
    )).rejects.toThrow(/File file-1 external identity changed/i);
  });

  test('does not accept an ambiguous Gateway read as session absence', async () => {
    const deps = dependencies({
      deleteGatewaySession: jest.fn(async () => {
        gatewayPresent = false;
        return { ok: true, deleted: true, archived: [] };
      }),
      readGatewaySession: jest.fn()
        .mockResolvedValueOnce({
          agentId: 'portal',
          sessionKey: 'agent:portal:host-session',
          sessionId: 'gateway-transcript-1',
        })
        .mockResolvedValueOnce({
          agentId: 'portal',
          sessionKey: 'agent:portal:host-session',
          sessionId: 'gateway-transcript-1',
        })
        .mockRejectedValue(new Error('WebSocket timeout')),
    });
    await expect(retireAdminUserExternalState(
      manifest,
      runnerContext(),
      deps,
    )).rejects.toThrow(/absence could not be verified/i);
  });
});
