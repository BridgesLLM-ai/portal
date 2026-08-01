import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __legacyOpenClawProjectRetirementTest,
  assertNoLegacyOpenClawProjectCreationCollision,
  discoverLegacyOpenClawProjectAgents,
  LegacyOpenClawProjectCreationCollisionError,
  LegacyOpenClawProjectMigrationActiveError,
  LegacyOpenClawProjectRetirementError,
  retireLegacyOpenClawProjectAgentsAtStartup as inspectLegacyOpenClawProjectAgentsAtStartup,
  shouldRetryLegacyOpenClawProjectMigration,
  type LegacyOpenClawProjectRetirementDependencies,
  type LegacyOpenClawProjectRetirementDatabase,
  type LegacyRetirementCommandResult,
} from './legacyOpenClawProjectRetirement';
import { attestProjectRoot } from './projectIdentity';

const USER_ID = '11111111-2222-4333-8444-555555555555';
const AGENT_ID = 'portal-11111111-demo';
const CONTAINER_ID = 'a'.repeat(64);
const retireLegacyOpenClawProjectAgentsAtStartup =
  inspectLegacyOpenClawProjectAgentsAtStartup;

interface SessionRow {
  key: string;
  sessionId?: string;
  lifecycleRevision?: string;
  updatedAt?: number;
  archived?: boolean;
}

class RetirementFixture {
  readonly calls: Array<{ kind: 'rpc' | 'docker'; name: string; params: any }> = [];
  readonly logs: string[] = [];
  readonly sessions = new Map<string, SessionRow[]>();
  readonly histories = new Map<string, any[]>();
  readonly rawHistories = new Map<string, Array<any | null>>();
  readonly containers = new Map<string, Record<string, any>>();
  configAgents: Record<string, any>[] = [];
  localConfigAgents: Record<string, any>[] | null | undefined;
  dockerIsAvailable = true;
  failAgentDelete = false;
  failContainerRemoveOnce = false;
  failTransactionalLeaseAt: number | null = null;
  transactionalLeaseChecks = 0;
  historyPageSize = Number.POSITIVE_INFINITY;
  mutateDescriptions = false;
  omitDescriptionUpdatedAt = false;
  omitDescriptionKey = false;
  materializeTranscriptArtifacts = true;
  openClawHomePath = '';
  projectSourcePath = '';
  private describeCount = 0;
  private identityCounter = 0;
  private journalCounter = 0;
  readonly identities: any[] = [];
  readonly messages: any[] = [];
  readonly chatSessions: any[] = [];
  readonly providerBindings: any[] = [];
  readonly quarantines: any[] = [];
  readonly journals: any[] = [];
  pendingDestructiveReset = false;
  pendingDestructiveResetJournal = false;
  clearedLegacyProject = false;

  readonly database: LegacyOpenClawProjectRetirementDatabase = {
    projectIdentity: {
      findUnique: async (args: any) => {
        const composite = args?.where?.workspaceOwnerId_projectName;
        if (composite) {
          return this.identities.find((row) => (
            row.workspaceOwnerId === composite.workspaceOwnerId
            && row.projectName === composite.projectName
          )) || null;
        }
        return this.identities.find((row) => row.id === args?.where?.id) || null;
      },
      findFirst: async (args: any) => this.identities.find((row) => {
        const where = args?.where || {};
        return (!where.workspaceOwnerId || row.workspaceOwnerId === where.workspaceOwnerId)
          && (!where.canonicalRoot || row.canonicalRoot === where.canonicalRoot);
      }) || null,
      findMany: async (args: any) => this.identities.filter((row) => (
        !args?.where?.legacyOpenClawMigrationStatus
        || row.legacyOpenClawMigrationStatus === args.where.legacyOpenClawMigrationStatus
      )).slice(0, args?.take),
      create: async (args: any) => {
        const data = { ...args.data };
        const now = new Date();
        const row = {
          ...data,
          id: data.id || `identity-${++this.identityCounter}`,
          lifecycleStatus: data.lifecycleStatus || 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        };
        this.identities.push(row);
        return row;
      },
    },
    projectChatMessage: {
      findMany: async (args: any) => this.messages
        .filter((row) => this.messageMatchesWhere(row, args?.where || {}))
        .slice(0, args?.take),
      findUnique: async (args: any) => {
        const composite = args?.where?.userId_projectId_messageId;
        if (!composite) return null;
        return this.messages.find((row) => (
          row.userId === composite.userId
          && row.projectId === composite.projectId
          && row.messageId === composite.messageId
        )) || null;
      },
      create: async (args: any) => {
        const row = { id: `message-${this.messages.length + 1}`, ...args.data };
        this.messages.push(row);
        return row;
      },
      update: async (args: any) => {
        const row = this.messages.find((entry) => entry.id === args.where.id);
        if (!row) throw new Error('message not found');
        Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: any) => {
        let count = 0;
        for (const row of this.messages) {
          if (!this.messageMatchesWhere(row, args?.where || {})) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
      deleteMany: async (args: any) => {
        const ids = new Set(args?.where?.id?.in || []);
        const before = this.messages.length;
        for (let index = this.messages.length - 1; index >= 0; index -= 1) {
          if (ids.has(this.messages[index].id)) this.messages.splice(index, 1);
        }
        return { count: before - this.messages.length };
      },
    },
    projectChatSession: {
      findMany: async (args: any) => this.chatSessions.filter((row) => {
        const where = args?.where || {};
        if (where.activeProvider && (row.activeProvider || 'OPENCLAW') !== where.activeProvider) return false;
        if (where.status && (row.status || 'active') !== where.status) return false;
        if (where.userId && row.userId !== where.userId) return false;
        if (typeof where.projectId === 'string' && row.projectId !== where.projectId) return false;
        if (Array.isArray(where.projectId?.in) && !where.projectId.in.includes(row.projectId)) return false;
        return true;
      }),
    },
    projectChatProviderBinding: {
      findMany: async (args: any) => this.providerBindings.filter((row) => {
        const where = args?.where || {};
        if (where.provider && row.provider !== where.provider) return false;
        if (where.userId && row.userId !== where.userId) return false;
        if (typeof where.projectId === 'string' && row.projectId !== where.projectId) return false;
        if (Array.isArray(where.projectId?.in) && !where.projectId.in.includes(row.projectId)) return false;
        return true;
      }).slice(0, args?.take),
    },
    projectChatTurn: {
      findFirst: async () => this.pendingDestructiveReset ? { id: 'reset-admission' } : null,
    },
    projectChatDestructiveResetJournal: {
      findFirst: async () => this.pendingDestructiveResetJournal ? { id: 'reset-journal' } : null,
    },
    legacyOpenClawProjectClearTombstone: {
      findFirst: async () => this.clearedLegacyProject ? { id: 'clear-tombstone' } : null,
    },
    legacyOpenClawProjectImport: {
      findUnique: async (args: any) => {
        const composite = args?.where?.actorUserId_sourceAgentHash_sessionKeyHash
          || args?.where?.actorUserId_projectIdentityId_sessionKeyHash;
        if (!composite) return null;
        return this.journals.find((row) => (
          row.actorUserId === composite.actorUserId
          && (!composite.projectIdentityId || row.projectIdentityId === composite.projectIdentityId)
          && (!composite.sourceAgentHash || row.sourceAgentHash === composite.sourceAgentHash)
          && row.sessionKeyHash === composite.sessionKeyHash
        )) || null;
      },
      findMany: async (args: any) => this.journals.filter((row) => {
        const where = args?.where || {};
        if (where.actorUserId && row.actorUserId !== where.actorUserId) return false;
        if (where.projectIdentityId && row.projectIdentityId !== where.projectIdentityId) return false;
        if (typeof where.projectGeneration === 'number' && row.projectGeneration !== where.projectGeneration) return false;
        if (where.projectGeneration?.lte && row.projectGeneration > where.projectGeneration.lte) return false;
        if (where.sourceAgentHash && row.sourceAgentHash !== where.sourceAgentHash) return false;
        if (typeof where.sourceStatus === 'string' && row.sourceStatus !== where.sourceStatus) return false;
        if (Array.isArray(where.sourceStatus?.in) && !where.sourceStatus.in.includes(row.sourceStatus)) return false;
        if (Array.isArray(where.OR) && !where.OR.some((entry: any) => (
          (!entry.actorUserId || row.actorUserId === entry.actorUserId)
          && (!entry.projectIdentityId || row.projectIdentityId === entry.projectIdentityId)
        ))) return false;
        return true;
      }).slice(0, args?.take),
      create: async (args: any) => {
        const now = new Date();
        const row = {
          id: `journal-${++this.journalCounter}`,
          retiredAt: null,
          updatedAt: now,
          ...args.data,
        };
        this.journals.push(row);
        return row;
      },
      update: async (args: any) => {
        const row = this.journals.find((entry) => entry.id === args.where.id);
        if (!row) throw new Error('journal not found');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
    },
    legacyOpenClawProjectQuarantine: {
      findUnique: async (args: any) => this.quarantines.find((row) => (
        row.originalMessageId === args?.where?.originalMessageId
      )) || null,
      findMany: async (args: any) => this.quarantines.slice(0, args?.take),
      create: async (args: any) => {
        const row = { id: `quarantine-${this.quarantines.length + 1}`, ...args.data };
        this.quarantines.push(row);
        return row;
      },
    },
    $transaction: async (callback: any) => callback(this.database),
  };

  readonly dependencies: LegacyOpenClawProjectRetirementDependencies = {
    readConfig: async () => this.localConfigAgents === null
      ? null
      : { agents: { list: this.localConfigAgents ?? this.configAgents } },
    rpc: async (method, params, timeoutMs) => {
      this.calls.push({ kind: 'rpc', name: method, params: { ...params, timeoutMs } });
      if (method === 'config.get') {
        if (this.materializeTranscriptArtifacts) {
          for (const [agentId, rows] of this.sessions) {
            const sessionsDir = path.join(this.openClawHomePath, 'agents', agentId, 'sessions');
            fs.mkdirSync(sessionsDir, { recursive: true });
            for (const row of rows) {
              const sessionId = row.sessionId || `session-${row.key.replace(/[^a-z0-9]/gi, '-')}`;
              const artifact = path.join(sessionsDir, `${sessionId}.jsonl`);
              if (!fs.existsSync(artifact)) fs.writeFileSync(artifact, '');
            }
          }
        }
        return { ok: true, data: { config: { agents: { list: this.configAgents } } } };
      }
      if (method === 'sessions.list') {
        const sourceRows = typeof params.agentId === 'string'
          ? (this.sessions.get(params.agentId) || [])
          : [...this.sessions.values()].flat();
        const all = sourceRows
          .filter((row) => Boolean(row.archived) === Boolean(params.archived));
        const offset = Number(params.offset || 0);
        const limit = Number(params.limit || all.length);
        const rows = all.slice(offset, offset + limit);
        const nextOffset = offset + rows.length;
        return {
          ok: true,
          data: {
            sessions: rows,
            hasMore: nextOffset < all.length,
            nextOffset: nextOffset < all.length ? nextOffset : null,
          },
        };
      }
      if (method === 'sessions.describe') {
        const row = [...this.sessions.values()].flat().find((entry) => entry.key === params.key);
        this.describeCount += 1;
        return row
          ? {
              ok: true,
              data: {
                session: {
                  ...row,
                  ...(this.omitDescriptionKey ? { key: undefined } : { key: row.key }),
                  sessionId: row.sessionId || `session-${row.key.replace(/[^a-z0-9]/gi, '-')}`,
                  ...(this.omitDescriptionUpdatedAt
                    ? {}
                    : { updatedAt: this.mutateDescriptions ? this.describeCount : (row.updatedAt ?? 1) }),
                },
              },
            }
          : { ok: true, data: { session: null } };
      }
      if (method === 'chat.history') {
        const row = [...this.sessions.values()].flat().find((entry) => entry.key === params.sessionKey);
        if (!row) return { ok: false, error: 'Session not found' };
        const all = this.rawHistories.get(params.sessionKey)
          || this.histories.get(params.sessionKey)
          || [];
        const offset = Number(params.offset || 0);
        const limit = Math.min(Number(params.limit || all.length), this.historyPageSize);
        const end = Math.max(0, all.length - offset);
        const start = Math.max(0, end - limit);
        const rawPage = all.slice(start, end);
        const rootBirthtimeMs = fs.lstatSync(this.projectSourcePath).birthtimeMs;
        const messages = rawPage
          .filter((entry): entry is any => entry !== null)
          .map((entry) => (
            typeof entry.timestamp === 'number' && entry.timestamp < 1_000_000_000_000
              ? { ...entry, timestamp: Math.ceil(rootBirthtimeMs) + entry.timestamp }
              : entry
          ));
        const nextOffset = offset + rawPage.length;
        return {
          ok: true,
          data: {
            sessionKey: params.sessionKey,
            sessionId: row.sessionId || `session-${row.key.replace(/[^a-z0-9]/gi, '-')}`,
            offset,
            totalMessages: all.length,
            messages,
            hasMore: start > 0,
            ...(start > 0 ? { nextOffset } : {}),
          },
        };
      }
      if (method === 'chat.abort') return { ok: true, data: { aborted: true } };
      if (method === 'sessions.delete') {
        const rows = this.sessions.get(params.agentId) || [];
        const before = rows.length;
        this.sessions.set(params.agentId, rows.filter((row) => row.key !== params.key));
        return before === this.sessions.get(params.agentId)!.length
          ? { ok: false, error: 'Session not found' }
          : { ok: true, data: { ok: true } };
      }
      if (method === 'agents.delete') {
        if (this.failAgentDelete) return { ok: false, error: 'simulated config write failure' };
        const before = this.configAgents.length;
        this.configAgents = this.configAgents.filter((agent) => agent.id !== params.agentId);
        this.sessions.delete(params.agentId);
        return before === this.configAgents.length
          ? { ok: false, error: 'Agent not found' }
          : { ok: true, data: { ok: true, agentId: params.agentId } };
      }
      throw new Error(`Unexpected RPC call: ${method}`);
    },
    dockerAvailable: () => this.dockerIsAvailable,
    docker: async (args, timeoutMs) => this.runDocker(args, timeoutMs),
    assertMutationLease: async () => undefined,
    assertMutationLeaseInTransaction: async () => {
      this.transactionalLeaseChecks += 1;
      if (this.failTransactionalLeaseAt === this.transactionalLeaseChecks) {
        throw new LegacyOpenClawProjectRetirementError(
          'MIGRATION_LEASE_LOST',
          'simulated stale migration writer',
        );
      }
    },
    markAffectedProjectIdentities: async (targets) => {
      for (const target of targets) {
        const identity = this.identities.find((row) => row.id === target.id);
        if (identity) identity.legacyOpenClawMigrationStatus = 'PENDING';
      }
    },
    markCompletedProjectIdentities: async (targets) => {
      for (const target of targets) {
        const identity = this.identities.find((row) => row.id === target.id);
        if (identity) identity.legacyOpenClawMigrationStatus = 'COMPLETE';
      }
    },
    log: (message) => this.logs.push(message),
  };

  private messageMatchesWhere(row: any, where: any): boolean {
    if (!where || Object.keys(where).length === 0) return true;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.sessionKey !== undefined && row.sessionKey !== where.sessionKey) return false;
    if (where.sourceKeyHash !== undefined && row.sourceKeyHash !== where.sourceKeyHash) return false;
    if (where.provider !== undefined && row.provider !== where.provider) return false;
    if (where.runtime !== undefined && row.runtime !== where.runtime) return false;
    if (where.legacyImportStatus !== undefined && row.legacyImportStatus !== where.legacyImportStatus) return false;
    if (where.projectId !== undefined) {
      if (typeof where.projectId === 'string' && row.projectId !== where.projectId) return false;
      if (Array.isArray(where.projectId?.in) && !where.projectId.in.includes(row.projectId)) return false;
    }
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.messageId === null && row.messageId !== null) return false;
    if (where.messageId?.startsWith && !String(row.messageId || '').startsWith(where.messageId.startsWith)) {
      return false;
    }
    if (Array.isArray(where.OR) && !where.OR.some((entry: any) => this.messageMatchesWhere(row, entry))) {
      return false;
    }
    if (where.NOT && this.messageMatchesWhere(row, where.NOT)) return false;
    return true;
  }

  private result(stdout = '', exitCode = 0, stderr = ''): LegacyRetirementCommandResult {
    return { stdout, stderr, exitCode };
  }

  private async runDocker(args: readonly string[], timeoutMs: number): Promise<LegacyRetirementCommandResult> {
    this.calls.push({ kind: 'docker', name: args.slice(0, 2).join(' '), params: { args: [...args], timeoutMs } });
    if (args[0] === 'container' && args[1] === 'ls') {
      return this.result([...this.containers.keys()].join('\n'));
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const container = this.containers.get(String(args[2]));
      return container
        ? this.result(JSON.stringify([container]))
        : this.result('', 1, `Error: No such object: ${String(args[2])}`);
    }
    if (args[0] === 'container' && args[1] === 'stop') {
      const id = String(args.at(-1));
      const container = this.containers.get(id);
      if (!container) return this.result('', 1, `Error: No such container: ${id}`);
      container.State.Running = false;
      return this.result(id);
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      const id = String(args[2]);
      if (this.failContainerRemoveOnce) {
        this.failContainerRemoveOnce = false;
        return this.result('', 2, 'simulated container removal failure');
      }
      return this.containers.delete(id)
        ? this.result(id)
        : this.result('', 1, `Error: No such container: ${id}`);
    }
    throw new Error(`Unexpected Docker call: ${args.join(' ')}`);
  }
}

describe('Portal 4.0 legacy OpenClaw Project retirement', () => {
  let root: string;
  let projectsRoot: string;
  let openClawHome: string;
  let projectSource: string;
  let internalWorkspace: string;
  let fixture: RetirementFixture;

  function legacyAgent(generation: 'work' | 'workspace' = 'work'): Record<string, any> {
    const workGeneration = generation === 'work';
    const target = workGeneration ? '/home/user/project' : '/workspace/project';
    return {
      id: AGENT_ID,
      workspace: path.join(openClawHome, 'sandboxes', `${AGENT_ID}-workspace`),
      sandbox: {
        mode: 'all',
        workspaceAccess: workGeneration ? 'none' : 'rw',
        scope: 'session',
        docker: {
          image: __legacyOpenClawProjectRetirementTest.LEGACY_IMAGE,
          workdir: workGeneration ? '/work' : '/workspace',
          network: 'bridge',
          dangerouslyAllowExternalBindSources: true,
          ...(workGeneration ? {} : { dangerouslyAllowReservedContainerTargets: true }),
          binds: [`${projectSource}:${target}:rw`],
        },
      },
    };
  }

  function legacyContainer(overrides: Record<string, any> = {}): Record<string, any> {
    const base = path.basename(internalWorkspace);
    const sessionKey = `agent:${AGENT_ID}:main`;
    const value = {
      Id: CONTAINER_ID,
      Name: `/openclaw-sbx-${base}`,
      Config: {
        Image: __legacyOpenClawProjectRetirementTest.LEGACY_IMAGE,
        User: '0:0',
        WorkingDir: '/work',
        Cmd: ['sleep', 'infinity'],
        Entrypoint: null,
        ExposedPorts: null,
        Volumes: null,
        Labels: {
          'openclaw.sandbox': '1',
          'openclaw.sessionKey': sessionKey,
          'openclaw.configHash': 'b'.repeat(64),
          'openclaw.createdAtMs': '1784161478708',
          'openclaw.mountFormatVersion': __legacyOpenClawProjectRetirementTest.LEGACY_MOUNT_FORMAT,
        },
      },
      State: { Running: true },
      HostConfig: {
        NetworkMode: 'bridge',
        Binds: [
          `${internalWorkspace}:/work:ro,z`,
          `${projectSource}:/home/user/project:rw`,
        ],
        ReadonlyRootfs: true,
        Privileged: false,
        CapAdd: null,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PortBindings: {},
        PublishAllPorts: false,
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        AutoRemove: false,
        Links: null,
        VolumesFrom: null,
        Devices: null,
        DeviceRequests: null,
      },
      Mounts: [
        { Type: 'bind', Source: internalWorkspace, Destination: '/work', Mode: 'ro,z', RW: false },
        { Type: 'bind', Source: projectSource, Destination: '/home/user/project', Mode: 'rw', RW: true },
      ],
      NetworkSettings: { Networks: { bridge: {} }, Ports: {} },
    };
    return { ...value, ...overrides };
  }

  function options() {
    return {
      portalProjectsRoot: projectsRoot,
      openClawHome,
      database: fixture.database,
      dependencies: fixture.dependencies,
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-legacy-retirement-'));
    projectsRoot = path.join(root, 'portal', 'projects');
    openClawHome = path.join(root, 'openclaw');
    projectSource = path.join(projectsRoot, USER_ID, 'Demo');
    internalWorkspace = path.join(openClawHome, 'sandboxes', `agent-${AGENT_ID}-abcd1234`);
    fs.mkdirSync(projectSource, { recursive: true });
    fs.mkdirSync(internalWorkspace, { recursive: true });
    fs.mkdirSync(path.join(openClawHome, 'sandboxes', `${AGENT_ID}-workspace`), { recursive: true });
    fs.mkdirSync(path.join(openClawHome, 'agents', 'portal', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(projectSource, 'sentinel.txt'), 'project source must survive');
    fixture = new RetirementFixture();
    fixture.openClawHomePath = openClawHome;
    fixture.projectSourcePath = projectSource;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('keeps destructive legacy retirement compile-time disabled with no environment override', () => {
    for (const sourceFile of [
      'legacyOpenClawProjectRetirement.ts',
      'projectChatLegacyRuntimeCleanup.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(__dirname, sourceFile), 'utf8');
      expect(source).toContain(
        'LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED = false as const',
      );
      expect(source).not.toMatch(/LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED\s*=\s*process\.env/);
    }
    const startupSource = fs.readFileSync(path.resolve(
      __dirname,
      'legacyOpenClawProjectRetirement.ts',
    ), 'utf8');
    expect(startupSource).not.toContain('retireDestructively:');
    expect(startupSource).not.toMatch(/export\s+(?:async\s+)?function\s+retireLegacyOpenClawProjectAgentsDestructively/);
  });

  test('claims the singleton lease with one DB-clock conditional upsert and no unique-key exception path', async () => {
    const claim = { tokenHash: 'claim-token', owner: 'portal-owner' };
    let query: any;
    const queryRaw = jest.fn(async (input: any) => {
      query = input;
      return [{ leaseTokenHash: claim.tokenHash, leaseOwner: claim.owner }];
    });

    await expect(__legacyOpenClawProjectRetirementTest.claimLegacyMigrationLeaseFromStore(
      { $queryRaw: queryRaw } as any,
      claim,
    )).resolves.toEqual(claim);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = query.strings.join('?');
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
    expect(sql).toContain(
      'WHERE "LegacyOpenClawProjectMigrationLease"."leaseExpiresAt" <= clock_timestamp()::timestamp',
    );
    expect(sql).toContain('RETURNING "leaseTokenHash", "leaseOwner"');
    expect(sql).toContain('clock_timestamp()::timestamp');
    expect(sql).not.toContain('CURRENT_TIMESTAMP');
  });

  test('returns a clean lease miss when the conditional upsert finds a live owner', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);

    await expect(__legacyOpenClawProjectRetirementTest.claimLegacyMigrationLeaseFromStore(
      { $queryRaw: queryRaw } as any,
      { tokenHash: 'contender-token', owner: 'contender-owner' },
    )).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  test('renews from the DB clock without shortening a newer lease deadline', async () => {
    const claim = { tokenHash: 'renew-token', owner: 'renew-owner' };
    let query: any;
    const queryRaw = jest.fn(async (input: any) => {
      query = input;
      return [{ leaseTokenHash: claim.tokenHash, leaseOwner: claim.owner }];
    });

    await expect(__legacyOpenClawProjectRetirementTest.renewLegacyMigrationLeaseFromStore(
      { $queryRaw: queryRaw } as any,
      claim,
      'MIGRATING',
    )).resolves.toBe(true);

    const sql = query.strings.join('?');
    expect(sql).toContain('UPDATE "LegacyOpenClawProjectMigrationLease"');
    expect(sql).toContain('"heartbeatAt" = GREATEST("heartbeatAt", clock_timestamp()::timestamp)');
    expect(sql).toContain('"leaseExpiresAt" = GREATEST(');
    expect(sql).toContain('AND "leaseExpiresAt" > clock_timestamp()::timestamp');
    expect(sql).not.toContain('CURRENT_TIMESTAMP');
    expect(query.values).toContain('MIGRATING');
  });

  test('serializes heartbeat renewals and never schedules another tick before settlement', async () => {
    const timers: Array<{ callback: () => void; unref: jest.Mock }> = [];
    const clear = jest.fn();
    const scheduler = {
      set: jest.fn((callback: () => void) => {
        const timer = { callback, unref: jest.fn() };
        timers.push(timer);
        return timer;
      }),
      clear,
    };
    const settlements: Array<(value: boolean) => void> = [];
    let active = 0;
    let maxActive = 0;
    const renew = jest.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<boolean>((resolve) => {
        settlements.push((value) => {
          active -= 1;
          resolve(value);
        });
      });
    });
    const onLeaseLost = jest.fn();
    const controller = __legacyOpenClawProjectRetirementTest.startSerializedLegacyMigrationLeaseHeartbeat({
      renew,
      onLeaseLost,
      intervalMs: 5,
      scheduler,
    });

    expect(timers).toHaveLength(1);
    expect(timers[0].unref).toHaveBeenCalledTimes(1);
    timers[0].callback();
    timers[0].callback();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    expect(timers).toHaveLength(1);

    settlements[0](true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(2);
    timers[1].callback();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    controller.stop();
    settlements[1](true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(2);
    expect(onLeaseLost).not.toHaveBeenCalled();
  });

  test('atomically revokes both ownership fields so an in-flight stale heartbeat cannot re-extend failure', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const failedClaim = { tokenHash: 'failed-token', owner: 'failed-owner' };
    const revokedClaim = { tokenHash: 'revoked-token', owner: 'released:revoked-owner' };
    const now = new Date('2026-07-22T16:00:00.000Z');

    await __legacyOpenClawProjectRetirementTest.revokeLegacyMigrationLeaseAfterFailure(
      { updateMany } as any,
      failedClaim,
      now,
      revokedClaim,
    );

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'portal-3x-openclaw-project-import-v1',
        leaseTokenHash: failedClaim.tokenHash,
        leaseOwner: failedClaim.owner,
      },
      data: {
        leaseTokenHash: revokedClaim.tokenHash,
        leaseOwner: revokedClaim.owner,
        leaseExpiresAt: now,
        heartbeatAt: now,
      },
    });
    expect(revokedClaim).not.toMatchObject(failedClaim);
  });

  test('treats the compile-time-disabled preservation result as terminal for this process only', () => {
    expect(shouldRetryLegacyOpenClawProjectMigration(
      new LegacyOpenClawProjectRetirementError(
        'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED',
        'preserved',
      ),
    )).toBe(false);
    expect(shouldRetryLegacyOpenClawProjectMigration(
      new LegacyOpenClawProjectRetirementError('PROJECT_IDENTITY', 'retryable discovery fault'),
    )).toBe(true);
    expect(shouldRetryLegacyOpenClawProjectMigration(new Error('database unavailable'))).toBe(true);

    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    const decision = serverSource.indexOf('const shouldRetry = shouldRetryLegacyOpenClawProjectMigration(error);');
    const terminalReturn = serverSource.indexOf('if (!shouldRetry) return;', decision);
    const reschedule = serverSource.indexOf('scheduleLegacyOpenClawProjectMigration(Math.max(', decision);
    expect(decision).toBeGreaterThan(-1);
    expect(terminalReturn).toBeGreaterThan(decision);
    expect(reschedule).toBeGreaterThan(terminalReturn);
  });

  test.each([
    { projectIdentityId: 'current', migrationStatus: 'CURRENT', phase: 'DISCOVERING', active: false },
    { projectIdentityId: 'legacy', migrationStatus: 'NONE', phase: 'DISCOVERING', active: true },
    { projectIdentityId: 'completed', migrationStatus: 'COMPLETE', phase: 'DISCOVERING', active: true },
    { projectIdentityId: 'pending', migrationStatus: 'PENDING', phase: 'MIGRATING', active: true },
    { projectIdentityId: 'unaffected', migrationStatus: 'NONE', phase: 'MIGRATING', active: false },
    { projectIdentityId: undefined, migrationStatus: null, phase: 'DISCOVERING', active: true },
  ])('applies the identity-scoped CURRENT migration gate (%o)', (state) => {
    expect(__legacyOpenClawProjectRetirementTest.legacyOpenClawProjectMigrationGateIsActive({
      projectIdentityId: state.projectIdentityId,
      migrationStatus: state.migrationStatus,
      lease: {
        phase: state.phase,
        leaseExpiresAt: new Date('2026-07-22T18:00:00.000Z'),
      },
      nowMs: new Date('2026-07-22T17:00:00.000Z').getTime(),
    })).toBe(state.active);
  });

  test('reports preserved terminal evidence honestly instead of promising a short retry', () => {
    const error = new LegacyOpenClawProjectMigrationActiveError({ retryable: false });
    expect(error).toMatchObject({
      code: 'LEGACY_OPENCLAW_PROJECT_RETIREMENT_PENDING',
      retryable: false,
    });
    expect(error.message).toMatch(/preserved/i);
  });

  test('allows CURRENT enrollment only after a complete scoped legacy-collision scan', async () => {
    await expect(assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: USER_ID,
      projectName: 'Demo',
      projectRoot: projectSource,
    }, options())).resolves.toBeUndefined();
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
    expect(fixture.calls.some((call) => call.kind === 'docker'
      && ['container stop', 'container rm'].includes(call.name))).toBe(false);
  });

  test('serializes concurrent Project creation runtime inventories', async () => {
    let activeInventories = 0;
    let maxActiveInventories = 0;
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const dependencies = {
      ...fixture.dependencies,
      readConfig: async () => {
        activeInventories += 1;
        maxActiveInventories = Math.max(maxActiveInventories, activeInventories);
        markStarted();
        await gate;
        activeInventories -= 1;
        return null;
      },
    };
    const scans = Array.from({ length: 3 }, () => assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: USER_ID,
      projectName: 'Demo',
      projectRoot: projectSource,
    }, { ...options(), dependencies }));

    await firstStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(activeInventories).toBe(1);
    releaseFirst();
    await expect(Promise.all(scans)).resolves.toHaveLength(3);
    expect(maxActiveInventories).toBe(1);
  });

  test('rejects CURRENT enrollment when a preserved runtime owns the same actor and root', async () => {
    fixture.configAgents = [legacyAgent()];

    await expect(assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: USER_ID,
      projectName: 'Demo',
      projectRoot: projectSource,
    }, options())).rejects.toBeInstanceOf(LegacyOpenClawProjectCreationCollisionError);
    expect(fixture.configAgents).toHaveLength(1);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
  });

  test('rejects CURRENT enrollment when preserved name-keyed SQL state exists', async () => {
    fixture.chatSessions.push({
      id: 'legacy-name-session',
      userId: USER_ID,
      projectId: 'Demo',
      activeProvider: 'OPENCLAW',
      sessionKey: `agent:${AGENT_ID}:main`,
      status: 'active',
      runtime: 'openclaw-dedicated-project-agent',
    });

    await expect(assertNoLegacyOpenClawProjectCreationCollision({
      workspaceOwnerId: USER_ID,
      projectName: 'Demo',
      projectRoot: projectSource,
    }, options())).rejects.toMatchObject({ code: 'LEGACY_OPENCLAW_PROJECT_NAME_COLLISION' });
    expect(fixture.chatSessions).toHaveLength(1);
  });

  test('release startup performs read-only discovery and preserves every uncertain legacy source', async () => {
    const sessionKey = `agent:${AGENT_ID}:main`;
    fixture.configAgents = [legacyAgent()];
    fixture.sessions.set(AGENT_ID, [{
      key: sessionKey,
      sessionId: 'release-disabled-session',
      lifecycleRevision: 'release-disabled-revision',
      updatedAt: 42,
    }]);
    fixture.containers.set(CONTAINER_ID, legacyContainer());
    fixture.messages.push({
      id: 'uncertain-legacy-sql',
      projectId: 'Demo',
      userId: USER_ID,
      sessionKey,
      role: 'user',
      content: 'must remain byte-for-byte visible',
      timestamp: new Date(1_000),
      messageId: null,
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
      model: null,
      providerSessionId: null,
      legacyImportStatus: null,
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject<Partial<LegacyOpenClawProjectRetirementError>>({
        code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED',
      });

    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(0);
    expect(fixture.quarantines).toHaveLength(0);
    expect(fixture.messages).toEqual([
      expect.objectContaining({
        id: 'uncertain-legacy-sql',
        content: 'must remain byte-for-byte visible',
      }),
    ]);
    expect(fixture.sessions.get(AGENT_ID)).toHaveLength(1);
    expect(fixture.containers.get(CONTAINER_ID)?.State.Running).toBe(true);
    expect(fixture.configAgents).toHaveLength(1);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
    expect(fixture.calls.some((call) => call.kind === 'docker'
      && ['container stop', 'container rm'].includes(call.name))).toBe(false);
  });

  test('release startup returns clean without creating migration state when exact inventories are empty', async () => {
    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options())).resolves.toEqual({
      candidatesFound: 0,
      canonicalSessionsImported: 0,
      messagesImported: 0,
      configuredAgentsRetired: 0,
      sessionsRetired: 0,
      containersRetired: 0,
    });
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(0);
    expect(fixture.quarantines).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
    expect(fixture.calls.some((call) => call.kind === 'docker'
      && ['container stop', 'container rm'].includes(call.name))).toBe(false);
  });

  test('release startup never treats an old per-source proof as a complete empty inventory', async () => {
    fixture.journals.push({
      id: 'historic-per-source-proof',
      actorUserId: USER_ID,
      projectIdentityId: 'historic-project',
      projectGeneration: 1,
      sourceStatus: 'RETIRED',
      updatedAt: new Date(1),
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject<Partial<LegacyOpenClawProjectRetirementError>>({
        code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED',
      });
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(1);
    expect(fixture.quarantines).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
    expect(fixture.calls.some((call) => call.kind === 'docker'
      && ['container stop', 'container rm'].includes(call.name))).toBe(false);
  });

  test('release proof blocks SQL-only legacy content with zero mutation', async () => {
    fixture.messages.push({
      id: 'sql-only-legacy',
      projectId: 'Demo',
      userId: USER_ID,
      sessionKey: `agent:${AGENT_ID}:main`,
      role: 'user',
      content: 'preserve SQL-only residue',
      timestamp: new Date(1_000),
      messageId: null,
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
      model: null,
      providerSessionId: null,
      legacyImportStatus: null,
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fixture.messages).toEqual([expect.objectContaining({ id: 'sql-only-legacy' })]);
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(0);
    expect(fixture.quarantines).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
  });

  test('release proof preserves unattributed SQL provenance without requiring a live Project root', async () => {
    fixture.messages.push({
      id: 'sql-only-missing-root',
      projectId: 'Project-That-No-Longer-Has-A-Root',
      userId: USER_ID,
      sessionKey: `agent:${AGENT_ID}:main`,
      role: 'user',
      content: 'preserve ambiguous SQL provenance',
      timestamp: new Date(1_000),
      messageId: null,
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
      model: null,
      providerSessionId: null,
      legacyImportStatus: null,
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fixture.messages).toEqual([expect.objectContaining({ id: 'sql-only-missing-root' })]);
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(0);
    expect(fixture.quarantines).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.describe', 'sessions.delete', 'agents.delete']
      .includes(call.name))).toBe(false);
  });

  test('release proof dismisses an exact immutable Portal 4 database session without root attribution', async () => {
    const identityId = 'modern-project-identity';
    const identityHash = crypto.createHash('sha256')
      .update(USER_ID)
      .update('\0')
      .update(identityId)
      .digest('hex')
      .slice(0, 40);
    const sessionKey = `agent:p4oc-${identityHash}:portal-project`;
    fixture.identities.push({
      id: identityId,
      workspaceOwnerId: USER_ID,
      projectName: 'Demo',
      canonicalRoot: projectSource,
      generation: 1,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: null,
    });
    fixture.chatSessions.push({
      id: 'modern-project-session',
      userId: USER_ID,
      projectId: identityId,
      activeProvider: 'OPENCLAW',
      sessionKey,
      status: 'active',
      runtime: 'openclaw-dedicated-project-agent',
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options())).resolves.toEqual({
      candidatesFound: 0,
      canonicalSessionsImported: 0,
      messagesImported: 0,
      configuredAgentsRetired: 0,
      sessionsRetired: 0,
      containersRetired: 0,
    });
    expect(fixture.identities).toEqual([expect.objectContaining({ id: identityId })]);
    expect(fixture.chatSessions).toEqual([expect.objectContaining({ id: 'modern-project-session' })]);
    expect(fixture.calls.some((call) => ['sessions.describe', 'sessions.delete', 'agents.delete']
      .includes(call.name))).toBe(false);
  });

  test('release proof blocks an orphan imported message projection with no journal or identity', async () => {
    fixture.messages.push({
      id: 'orphan-imported-projection',
      projectId: 'missing-project-identity',
      userId: USER_ID,
      sessionKey: 'orphaned-imported-session',
      role: 'assistant',
      content: 'preserve imported projection',
      timestamp: new Date(2_000),
      messageId: 'legacy-openclaw:orphaned-projection',
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
      model: null,
      providerSessionId: 'orphaned-provider-session',
      legacyImportStatus: 'IMPORTED',
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fixture.messages).toEqual([
      expect.objectContaining({ id: 'orphan-imported-projection', legacyImportStatus: 'IMPORTED' }),
    ]);
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(0);
    expect(fixture.quarantines).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
  });

  test('release proof blocks a quarantine-only legacy SQL inventory with zero mutation', async () => {
    fixture.quarantines.push({
      id: 'quarantine-only-residue',
      originalMessageId: 'legacy-message-without-visible-projection',
    });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fixture.quarantines).toEqual([
      expect.objectContaining({ id: 'quarantine-only-residue' }),
    ]);
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.journals).toHaveLength(0);
    expect(fixture.messages).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
  });

  test('release proof blocks a container-only legacy runtime with zero mutation', async () => {
    fixture.containers.set(CONTAINER_ID, legacyContainer());

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fixture.containers.get(CONTAINER_ID)?.State.Running).toBe(true);
    expect(fixture.calls.some((call) => call.kind === 'docker'
      && ['container stop', 'container rm'].includes(call.name))).toBe(false);
    expect(fixture.identities).toHaveLength(0);
  });

  test('release proof blocks an unconfigured legacy agent directory with zero mutation', async () => {
    fs.mkdirSync(path.join(openClawHome, 'agents', AGENT_ID, 'sessions'), { recursive: true });

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fs.existsSync(path.join(openClawHome, 'agents', AGENT_ID))).toBe(true);
    expect(fixture.identities).toHaveLength(0);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
  });

  test('release proof globally inventories an orphan legacy session registration', async () => {
    fixture.materializeTranscriptArtifacts = false;
    fixture.sessions.set(AGENT_ID, [{
      key: `agent:${AGENT_ID}:portal-${USER_ID}-demo`,
      sessionId: 'orphan-registration',
      updatedAt: 1,
    }]);

    await expect(inspectLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject({ code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED' });
    expect(fixture.sessions.get(AGENT_ID)).toHaveLength(1);
    expect(fixture.calls.some((call) => ['sessions.delete', 'agents.delete'].includes(call.name))).toBe(false);
  });

  test('attests both historical configured-agent generations', () => {
    for (const generation of ['work', 'workspace'] as const) {
      const discovered = discoverLegacyOpenClawProjectAgents(
        { agents: { list: [legacyAgent(generation)] } },
        { portalProjectsRoot: projectsRoot, openClawHome },
      );
      expect(discovered).toEqual([expect.objectContaining({
        agentId: AGENT_ID,
        projectSource,
        generation: generation === 'work' ? 'legacy-work' : 'legacy-workspace',
      })]);
    }
  });


  test('never selects main, p4oc, display-name matches, or arbitrary portal ids', async () => {
    fixture.configAgents = [
      { id: 'main', name: AGENT_ID, workspace: path.join(openClawHome, 'workspace') },
      { id: `p4oc-${'c'.repeat(40)}`, name: AGENT_ID },
      { id: 'portal-custom-agent', name: AGENT_ID },
    ];
    const protectedId = `p4oc-${'d'.repeat(40)}`;
    fixture.containers.set('e'.repeat(64), {
      Id: 'e'.repeat(64),
      Name: '/p4oc-runtime',
      Config: {
        Image: `sha256:${'f'.repeat(64)}`,
        Labels: { 'openclaw.sandbox': '1', 'openclaw.sessionKey': `agent:${protectedId}:portal-project` },
      },
      HostConfig: { NetworkMode: 'p4e-in-test' },
      Mounts: [{ Source: projectSource, Destination: '/workspace/project', RW: true }],
    });

    await expect(retireLegacyOpenClawProjectAgentsAtStartup(options())).resolves.toEqual({
      candidatesFound: 0,
      canonicalSessionsImported: 0,
      messagesImported: 0,
      configuredAgentsRetired: 0,
      sessionsRetired: 0,
      containersRetired: 0,
    });
    expect(fixture.containers.size).toBe(1);
    expect(fixture.calls.some((call) => call.name === 'agents.delete')).toBe(false);
  });

  test('dormant importer refuses to attach preserved legacy state to a CURRENT identity', async () => {
    const rootIdentity = attestProjectRoot(projectSource);
    fixture.identities.push({
      id: 'current-project-identity',
      workspaceOwnerId: USER_ID,
      projectName: 'Demo',
      ...rootIdentity,
      generation: 1,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: 'CURRENT',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [discovered] = discoverLegacyOpenClawProjectAgents(
      { agents: { list: [legacyAgent()] } },
      { portalProjectsRoot: projectsRoot, openClawHome },
    );
    const candidate = { ...discovered, ...rootIdentity };

    await expect(__legacyOpenClawProjectRetirementTest.resolveLegacyProjectIdentity(
      candidate as any,
      fixture.database as any,
    )).rejects.toMatchObject({ code: 'CURRENT_PROJECT_COLLISION' });
    expect(fixture.identities).toEqual([
      expect.objectContaining({
        id: 'current-project-identity',
        legacyOpenClawMigrationStatus: 'CURRENT',
      }),
    ]);
  });

  test('release proof never invokes configured-agent deletion', async () => {
    fixture.configAgents = [legacyAgent()];
    fixture.sessions.set(AGENT_ID, [{
      key: `agent:${AGENT_ID}:main`,
      sessionId: 'agent-fence-session',
      updatedAt: 1,
    }]);
    fixture.failAgentDelete = true;

    await expect(retireLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject<Partial<LegacyOpenClawProjectRetirementError>>({
        code: 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED',
      });
    expect(fixture.configAgents).toHaveLength(1);
    expect(fixture.sessions.get(AGENT_ID)).toHaveLength(1);
    expect(fixture.calls.some((call) => call.name === 'agents.delete')).toBe(false);
  });

  test('checks the live Gateway and fails closed when Docker is unavailable despite an empty local config', async () => {
    fixture.localConfigAgents = [];
    fixture.configAgents = [legacyAgent()];
    fixture.dockerIsAvailable = false;

    await expect(retireLegacyOpenClawProjectAgentsAtStartup(options()))
      .rejects.toMatchObject<Partial<LegacyOpenClawProjectRetirementError>>({ code: 'DOCKER_UNAVAILABLE' });
    expect(fixture.calls.map((call) => call.name)).toEqual(['config.get']);
    expect(fixture.calls.some((call) => call.name === 'agents.delete')).toBe(false);
  });

  test('claims the migration lease after DB readiness without blocking unrelated startup on completion', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
    const database = serverSource.indexOf('await prisma.$queryRaw`SELECT 1`');
    const lease = serverSource.indexOf(
      'claimedLegacyOpenClawMigrationCoordinator = await beginLegacyOpenClawProjectMigration();',
    );
    const watcher = serverSource.indexOf('initPersistentGatewayWs();', lease);
    const listen = serverSource.indexOf('httpServer.listen(', lease);
    const schedule = serverSource.indexOf('scheduleLegacyOpenClawProjectMigration(1_000);', listen);
    expect(lease).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(-1);
    expect(lease).toBeGreaterThan(database);
    expect(watcher).toBeGreaterThan(lease);
    expect(listen).toBeGreaterThan(lease);
    expect(schedule).toBeGreaterThan(listen);
    expect(serverSource.slice(lease, listen)).not.toContain('await coordinator.completion');
  });

  test('authoritative CURRENT creation always proves scoped legacy absence first', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'projects.ts'), 'utf8');
    const signatures = [
      "router.post('/', authenticateToken",
      "router.post('/clone', authenticateToken",
      "router.post('/upload-zip', authenticateToken",
      "router.post('/create-from-upload', authenticateToken",
    ];
    for (const signature of signatures) {
      const start = routes.indexOf(signature);
      const end = routes.indexOf('\nrouter.', start + signature.length);
      const block = routes.slice(start, end === -1 ? routes.length : end);
      const firstProof = block.indexOf('assertNoLegacyOpenClawProjectCreationCollision({');
      const enrollment = block.indexOf('createCurrentProjectIdentity({');
      const secondProof = block.indexOf(
        'assertNoLegacyOpenClawProjectCreationCollision({',
        firstProof + 1,
      );
      const publish = block.indexOf('moveAttestedDirectoryNoReplace({', secondProof);
      const activation = block.indexOf('finalizeCurrentProjectIdentityCreation({', publish);
      expect(start).toBeGreaterThan(-1);
      expect(firstProof).toBeGreaterThan(-1);
      expect(enrollment).toBeGreaterThan(firstProof);
      expect(secondProof).toBeGreaterThan(enrollment);
      expect(publish).toBeGreaterThan(secondProof);
      expect(activation).toBeGreaterThan(publish);
    }
  });

  test('persists exact recovery locators and fences native message writes during PENDING import', () => {
    const migration = fs.readFileSync(path.resolve(
      __dirname,
      '../../prisma/migrations/20260721_legacy_openclaw_project_import/migration.sql',
    ), 'utf8');
    expect(migration).toContain('"candidateAgentId" TEXT NOT NULL');
    expect(migration).toContain('"candidateAgentHash" TEXT NOT NULL');
    expect(migration).toContain('"artifactInventoryFingerprint" TEXT NOT NULL');
    expect(migration).toContain('CREATE TRIGGER "ProjectChatMessage_fence_legacy_import"');
    expect(migration).toContain('"legacyOpenClawMigrationStatus" = \'PENDING\'');
  });

  test('closes migration admission against detached and pre-atomic Project Chat turns', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'legacyOpenClawProjectRetirement.ts'), 'utf8');
    const transition = source.indexOf('async function transitionLegacyProjectMigrationTargets');
    const statusCommit = source.indexOf('legacyOpenClawMigrationStatus: input.status', transition);
    const block = source.slice(transition, statusCommit);
    expect(block).toContain("status: { in: ['RUNNING', 'ABORTING'] }");
    expect(block).toContain('{ activeProjectKey: target.id }');
    expect(block).toContain("equals: 'DISPATCH_ACCEPTED'");
    expect(block).toContain('atomicSettlementVersion !== 2');
  });

  test('gates persisted transcript reads before selecting any UUID-keyed history rows', () => {
    const projectsSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'projects.ts'), 'utf8');
    const route = projectsSource.indexOf("router.get('/:name/chat/history'");
    const context = projectsSource.indexOf('await resolveProjectChatOperationContext(', route);
    const gate = projectsSource.indexOf(
      'await assertLegacyOpenClawProjectMigrationInactive(executionContext.projectId);',
      context,
    );
    const history = projectsSource.indexOf('const historyPage = await prisma.projectChatMessage.findMany', gate);
    expect(route).toBeGreaterThan(-1);
    expect(context).toBeGreaterThan(route);
    expect(gate).toBeGreaterThan(context);
    expect(history).toBeGreaterThan(gate);
  });
});
