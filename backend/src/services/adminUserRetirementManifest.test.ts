import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHostOperatorExecutionContext } from '../agents/executionScope';
import type { NativeSessionData } from '../agents/providers/NativeSessionStore';
import {
  buildAdminUserRetirementManifestSnapshot,
  digestAdminUserRetirementSnapshot,
  type AdminUserRetirementManifestRoots,
} from './adminUserRetirementManifest';
import { buildOpenClawRetirementIdentityAttestation } from './openClawLegacySessionPrivacy';

function delegate(rows: unknown[] = []) {
  return {
    findMany: jest.fn(async () => rows),
  };
}

describe('authoritative admin user retirement manifest builder', () => {
  let sandbox: string;
  let roots: AdminUserRetirementManifestRoots;
  let projectRoot: string;
  let appSource: string;
  let appDeploy: string;
  let jobTranscript: string;
  let avatar: string;
  let database: any;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-retirement-manifest-'));
    roots = {
      projectsRoot: path.join(sandbox, 'projects'),
      uploadsRoot: path.join(sandbox, 'uploads'),
      mediaMirrorRoot: path.join(sandbox, 'mirror'),
      appSourceRoot: path.join(sandbox, 'apps'),
      deployRoot: path.join(sandbox, 'deploy'),
      jobsRoot: path.join(sandbox, 'jobs'),
      avatarsRoot: path.join(sandbox, 'avatars'),
    };
    Object.values(roots).forEach((root) => fs.mkdirSync(root, { recursive: true, mode: 0o700 }));
    projectRoot = path.join(roots.projectsRoot, 'target-user', 'alpha');
    appSource = path.join(roots.appSourceRoot, 'target-user-demo');
    appDeploy = path.join(roots.deployRoot, 'target-user-demo');
    jobTranscript = path.join(roots.jobsRoot, 'job-1.jsonl');
    avatar = path.join(roots.avatarsRoot, 'avatar.png');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(appSource);
    fs.mkdirSync(appDeploy);
    fs.writeFileSync(jobTranscript, '{"private":"job output"}\n', { mode: 0o600 });
    fs.writeFileSync(avatar, 'png', { mode: 0o600 });
    fs.writeFileSync(
      path.join(roots.avatarsRoot, 'user-target-user.webp'),
      'orphaned historical avatar variant',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(roots.avatarsRoot, 'user-target-user.txt'),
      'not an avatar',
      { mode: 0o600 },
    );
    fs.mkdirSync(path.join(roots.uploadsRoot, 'user-target-user', 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(roots.mediaMirrorRoot, 'user-target-user', 'uploads'), { recursive: true });
    const projectStat = fs.lstatSync(projectRoot, { bigint: true });

    database = {
      user: {
        findUnique: jest.fn(async ({ where }: any) => (
          where.id === 'owner-user'
            ? { id: 'owner-user', role: 'OWNER' }
            : {
                id: 'target-user',
                email: 'Target@Example.com',
                username: 'target',
                role: 'USER',
                authorizationVersion: 7,
                avatarPath: 'avatar.png',
              }
        )),
      },
      projectIdentity: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where?.workspaceOwnerId === 'target-user') {
            return [{
              id: 'project-owned',
              workspaceOwnerId: 'target-user',
              projectName: 'alpha',
              canonicalRoot: projectRoot,
              rootDevice: projectStat.dev.toString(),
              rootInode: projectStat.ino.toString(),
              rootBirthtimeNs: projectStat.birthtimeNs.toString(),
              generation: 1,
              lifecycleStatus: 'ACTIVE',
              legacyOpenClawMigrationStatus: 'CURRENT',
            }];
          }
          return [{ id: 'project-shared' }];
        }),
      },
      app: delegate([{
        id: 'app-1',
        userId: 'target-user',
        projectIdentityId: 'project-owned',
        name: 'demo',
        zipPath: appSource,
        deployType: 'static',
        processStatus: 'stopped',
        port: null,
        shareLinks: [{
          id: 'share-1',
          userId: 'target-user',
          token: 'private-share-token',
        }],
      }]),
      appShareLink: delegate([{
        id: 'share-1',
        appId: 'app-1',
      }]),
      file: delegate([{
        id: 'file-1',
        path: 'uploads/private.txt',
        cloudinaryId: null,
      }]),
      agentJob: delegate([{
        id: 'job-1',
        status: 'running',
        transcriptPath: jobTranscript,
        metadata: {
          runtime: { pid: 1234, processStartTime: '999' },
          privateArgument: 'not persisted verbatim',
        },
      }]),
      agentSession: delegate([{
        id: 'agent-session-1',
        provider: 'OPENCLAW',
        externalId: 'agent:portal:host-session',
      }]),
      session: delegate([{ id: 'auth-session-1' }]),
      emailVerificationCode: delegate([{ id: 'email-code-1' }]),
      twoFactorChallenge: delegate([{ id: 'two-factor-1' }]),
      passwordResetToken: delegate([{ id: 'password-reset-1' }]),
      mailboxAccount: delegate([{ username: 'target' }]),
      ollamaBackendBinding: delegate([{ id: 'ollama-1' }]),
      nativeOllamaBackendBinding: delegate([{ id: 'native-ollama-1' }]),
      projectChatState: delegate([{
        id: 'state-1',
        projectIdentityId: 'project-shared',
      }]),
      projectChatTurn: delegate([{
        id: 'turn-1',
        projectIdentityId: 'project-shared',
        providerSessionId: 'codex-session-1',
      }]),
      projectChatDestructiveResetJournal: delegate([]),
      projectChatProviderBinding: delegate([{
        id: 'binding-1',
        projectId: 'project-shared',
        sessionKey: null,
        externalSessionId: 'codex-session-1',
      }]),
      projectChatSession: delegate([{
        id: 'project-session-1',
        projectId: 'legacy-alpha',
        sessionKey: 'agent:portal:legacy-alpha',
      }]),
      projectChatMessage: delegate([{
        id: 'message-1',
        projectId: 'project-shared',
        sessionKey: 'agent:portal:shared',
        providerSessionId: 'codex-session-1',
      }]),
      legacyOpenClawProjectImport: delegate([]),
      legacyOpenClawProjectQuarantine: delegate([]),
      legacyOpenClawProjectClearTombstone: delegate([]),
      projectDependencyRepairOperation: delegate([{
        repairId: '11111111-1111-4111-8111-111111111111',
      }]),
      projectRuntimeCleanupActor: delegate([{
        projectIdentityId: 'project-shared',
        provider: 'OPENCLAW',
        actorUserId: 'target-user',
        sessionId: 'codex-session-1',
      }]),
    };
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('captures every identity class while storing only digests for private tokens and metadata', async () => {
    const nativeSession: NativeSessionData = {
      sessionId: 'codex-target-user-1',
      provider: 'CODEX',
      userId: 'target-user',
      createdAt: '2026-07-29T00:00:00.000Z',
      lastActivityAt: '2026-07-29T00:00:00.000Z',
      cwd: '/workspace',
      executionContext: createHostOperatorExecutionContext('target-user'),
      messages: [],
    };
    const manifest = await buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: (provider) => provider === 'CODEX' ? [nativeSession] : [],
        readLocalOpenClawSession: async (sessionKey) => ({
          agentId: 'portal',
          sessionKey,
          sessionId: 'host-transcript-1',
        }),
        attestOpenClawRuntimeFamily: async () => 'current-2026.9.1',
      },
    );

    expect(manifest.target).toEqual({
      id: 'target-user',
      role: 'USER',
      authorizationVersion: 7,
      emailDigest: digestAdminUserRetirementSnapshot('target@example.com'),
      username: 'target',
      avatarBasename: 'avatar.png',
    });
    expect(manifest.ownedProjects).toEqual([
      expect.objectContaining({
        id: 'project-owned',
        rootPresent: true,
      }),
    ]);
    expect(manifest.actorRuntimeState).toMatchObject({
      projectIdentityIds: ['project-shared'],
      legacyProjectIds: ['legacy-alpha'],
      chatStateIds: ['state-1'],
      turnIds: ['turn-1'],
      providerBindingIds: ['binding-1'],
      providerSessionRowIds: ['project-session-1'],
      providerSessionIds: ['codex-session-1'],
      gatewaySessionKeys: ['agent:portal:legacy-alpha', 'agent:portal:shared'],
    });
    expect(manifest.dependencyEvidence).toEqual({
      completeRepairReceiptIds: ['11111111-1111-4111-8111-111111111111'],
      cleanupActors: [{
        projectIdentityId: 'project-shared',
        provider: 'OPENCLAW',
        actorUserId: 'target-user',
        sessionId: 'codex-session-1',
      }],
    });
    expect(manifest.localTargets.nativeSessions).toEqual([
      expect.objectContaining({
        provider: 'CODEX',
        sessionId: 'codex-target-user-1',
        executionScope: 'HOST_OPERATOR',
        projectIdentityId: null,
      }),
    ]);
    expect(manifest.agentSessions).toEqual([{
      id: 'agent-session-1',
      provider: 'OPENCLAW',
      externalId: 'agent:portal:host-session',
      localAgentId: 'portal',
      localSessionId: 'host-transcript-1',
      localIdentityDigest: digestAdminUserRetirementSnapshot(
        buildOpenClawRetirementIdentityAttestation({
          identity: {
            agentId: 'portal',
            sessionKey: 'agent:portal:host-session',
            sessionId: 'host-transcript-1',
          },
          family: 'current-2026.9.1',
        }),
      ),
    }]);
    expect(manifest.localTargets.managedPaths.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      path.join(roots.projectsRoot, 'target-user'),
      path.join(roots.uploadsRoot, 'user-target-user'),
      path.join(roots.mediaMirrorRoot, 'user-target-user'),
      appSource,
      appDeploy,
      jobTranscript,
      avatar,
      path.join(roots.avatarsRoot, 'user-target-user.webp'),
    ]));
    expect(manifest.localTargets.managedPaths.map((entry) => entry.path)).not.toContain(
      path.join(roots.avatarsRoot, 'user-target-user.txt'),
    );
    expect(manifest.localTargets.managedPaths).toContainEqual(expect.objectContaining({
      path: path.join(roots.projectsRoot, 'target-user'),
      kind: 'CONTAINER_DIRECTORY',
    }));
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('private-share-token');
    expect(serialized).not.toContain('not persisted verbatim');
    expect(manifest.apps[0].shareTokenDigests).toEqual([
      digestAdminUserRetirementSnapshot('private-share-token'),
    ]);
    expect(manifest.agentJobs[0].metadataDigest).toBe(
      digestAdminUserRetirementSnapshot({
        runtime: { pid: 1234, processStartTime: '999' },
        privateArgument: 'not persisted verbatim',
      }),
    );
  });

  test('fails before journaling unsupported cloud state, owner targets, and unbound fullstack runtimes', async () => {
    database.file.findMany.mockResolvedValue([{
      id: 'file-cloud',
      path: 'uploads/cloud.txt',
      cloudinaryId: 'cloud-private-id',
    }]);
    await expect(buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: () => [],
        readLocalOpenClawSession: async () => null,
      },
    )).rejects.toThrow(/Cloudinary identity without a qualified deletion adapter/i);

    database.file.findMany.mockResolvedValue([]);
    database.app.findMany.mockResolvedValue([{
      id: 'app-fullstack',
      userId: 'target-user',
      projectIdentityId: null,
      name: 'legacy-runtime',
      zipPath: appSource,
      deployType: 'fullstack',
      processStatus: 'running',
      port: 4321,
      shareLinks: [],
    }]);
    database.appShareLink.findMany.mockResolvedValue([]);
    await expect(buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: () => [],
        readLocalOpenClawSession: async () => null,
      },
    )).rejects.toThrow(/no immutable Project runtime identity/i);

    database.user.findUnique.mockImplementation(async ({ where }: any) => (
      where.id === 'owner-user'
        ? { id: 'owner-user', role: 'OWNER' }
        : {
            id: 'target-user',
            email: 'owner@example.com',
            username: 'owner',
            role: 'OWNER',
            authorizationVersion: 1,
            avatarPath: null,
          }
    ));
    await expect(buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: () => [],
        readLocalOpenClawSession: async () => null,
      },
    )).rejects.toThrow(/Owner accounts cannot be retired/i);
  });

  test('rejects Project identity drift and non-current lifecycle state', async () => {
    const owned = await database.projectIdentity.findMany({
      where: { workspaceOwnerId: 'target-user' },
    });
    database.projectIdentity.findMany.mockImplementation(async ({ where }: any) => (
      where?.workspaceOwnerId === 'target-user'
        ? [{ ...owned[0], rootInode: `${BigInt(owned[0].rootInode) + 1n}` }]
        : [{ id: 'project-shared' }]
    ));
    await expect(buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: () => [],
        readLocalOpenClawSession: async () => null,
      },
    )).rejects.toThrow(/root identity changed/i);

    database.projectIdentity.findMany.mockImplementation(async ({ where }: any) => (
      where?.workspaceOwnerId === 'target-user'
        ? [{
            ...owned[0],
            lifecycleStatus: 'RENAMING',
          }]
        : [{ id: 'project-shared' }]
    ));
    await expect(buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: () => [],
        readLocalOpenClawSession: async () => null,
      },
    )).rejects.toThrow(/not in a retirement-safe lifecycle state/i);
  });

  test('rejects unmanifested state in the Project Owner container', async () => {
    fs.writeFileSync(
      path.join(roots.projectsRoot, 'target-user', 'unmanifested.txt'),
      'must not be silently deleted',
    );
    await expect(buildAdminUserRetirementManifestSnapshot(
      'target-user',
      'owner-user',
      {
        database,
        roots,
        listNativeSessions: () => [],
        readLocalOpenClawSession: async () => null,
      },
    )).rejects.toThrow(/outside the immutable Project inventory/i);
  });
});
