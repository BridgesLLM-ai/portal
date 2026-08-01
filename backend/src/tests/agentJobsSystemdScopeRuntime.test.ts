import fs, { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const jobsRoot = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-systemd-job-'));
process.env.PORTAL_AGENT_JOBS_ROOT = jobsRoot;
process.env.PORTAL_AGENT_JOBS_DISABLE_PTY = '1';

const records = new Map<string, any>();
const userFindUniqueMock = jest.fn();
const transitionFindFirstMock = jest.fn();
const createMock = jest.fn();
const updateManyMock = jest.fn();
const findManyMock = jest.fn();
const findUniqueMock = jest.fn();
const findFirstMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    $transaction: transactionMock,
    user: { findUnique: userFindUniqueMock },
    projectAuthorizationTransition: { findFirst: transitionFindFirstMock },
    agentJob: {
      create: createMock,
      updateMany: updateManyMock,
      findMany: findManyMock,
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
    },
  },
}));

jest.mock('../services/email', () => ({
  sendJobFailedAlert: jest.fn().mockResolvedValue(undefined),
}));

const agentJobs = require('../services/agentJobs') as typeof import('../services/agentJobs');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    return commandEnd >= 0 && stat.slice(commandEnd + 2).trim().split(/\s+/)[0] !== 'Z';
  } catch {
    return false;
  }
}

function matchesWhere(record: any, where: any): boolean {
  if (!record) return false;
  if (where?.id !== undefined && record.id !== where.id) return false;
  if (where?.userId?.in && !where.userId.in.includes(record.userId)) return false;
  if (typeof where?.userId === 'string' && record.userId !== where.userId) return false;
  if (where?.actorAuthorizationVersion !== undefined
    && record.actorAuthorizationVersion !== where.actorAuthorizationVersion) return false;
  if (typeof where?.status === 'string' && record.status !== where.status) return false;
  return true;
}

const realSystemdAvailable = (
  process.platform === 'linux'
  && typeof process.getuid === 'function'
  && process.getuid() === 0
  && fs.existsSync('/run/systemd/system')
  && fs.existsSync('/usr/bin/systemd-run')
  && fs.existsSync('/usr/bin/systemctl')
);
const realSystemdOnly = realSystemdAvailable ? it : it.skip;

describe('Agent Jobs real systemd scope containment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    records.clear();
    agentJobs.__agentJobsTest.resetRuntimeState();
    userFindUniqueMock.mockResolvedValue({
      authorizationVersion: 11,
      accountStatus: 'ACTIVE',
      isActive: true,
    });
    transitionFindFirstMock.mockResolvedValue(null);
    transactionMock.mockImplementation(async (operation: (transaction: any) => Promise<unknown>) => (
      operation({
        user: { findUnique: userFindUniqueMock },
        projectAuthorizationTransition: { findFirst: transitionFindFirstMock },
        agentJob: {
          create: createMock,
          updateMany: updateManyMock,
        },
      })
    ));
    createMock.mockImplementation(async ({ data }: any) => {
      const record = { id: 'real-systemd-job', ...data };
      records.set(record.id, record);
      return record;
    });
    updateManyMock.mockImplementation(async ({ where, data }: any) => {
      const record = records.get(where.id);
      if (!matchesWhere(record, where)) return { count: 0 };
      Object.assign(record, data);
      return { count: 1 };
    });
    findUniqueMock.mockImplementation(async ({ where }: any) => records.get(where.id) || null);
    findManyMock.mockImplementation(async ({ where }: any) => (
      [...records.values()].filter((record) => matchesWhere(record, where))
    ));
    findFirstMock.mockImplementation(async ({ where }: any) => (
      [...records.values()].find((record) => matchesWhere(record, where)) || null
    ));
  });

  afterEach(() => {
    agentJobs.__agentJobsTest.resetRuntimeState();
  });

  afterAll(() => {
    rmSync(jobsRoot, { recursive: true, force: true });
    delete process.env.PORTAL_AGENT_JOBS_ROOT;
    delete process.env.PORTAL_AGENT_JOBS_DISABLE_PTY;
  });

  realSystemdOnly(
    'blocks transition completion until a tokenless setsid/SIGTERM-ignoring descendant is gone',
    async () => {
      const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-systemd-daemon-'));
      const helperPath = path.join(fixtureRoot, 'daemon.js');
      const pidPath = path.join(fixtureRoot, 'daemon.pid');
      fs.writeFileSync(helperPath, [
        "const fs = require('fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.JOB_DAEMON_PIDFILE, String(process.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n'), { mode: 0o700 });

      let daemonPid = 0;
      let releaseStop!: () => void;
      const stopAllowed = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let announceStop!: () => void;
      const stopEntered = new Promise<void>((resolve) => {
        announceStop = resolve;
      });
      let authoritativeStop: (() => Promise<any>) | null = null;
      let activationSawDurableIdentity = false;

      agentJobs.__agentJobsTest.setSystemdScopeBoundary({
        initialize: async () => undefined,
        prepare: async (input) => {
          const prepared = await agentJobs.__agentJobsTest.prepareHostAgentJobSystemdScope(input);
          authoritativeStop = prepared.stop;
          return {
            ...prepared,
            async activate() {
              const row = records.get('real-systemd-job');
              activationSawDurableIdentity = (
                row?.status === 'running'
                && row?.metadata?.runtime?.activated === true
                && row?.metadata?.runtime?.systemdScope?.scopeUnit === prepared.identity.scopeUnit
                && row?.metadata?.runtime?.systemdScope?.invocationId === prepared.identity.invocationId
              );
              await prepared.activate();
            },
            async stop() {
              announceStop();
              await stopAllowed;
              return prepared.stop();
            },
          };
        },
        stopIdentity: async () => {
          if (!authoritativeStop) throw new Error('exact scope authority is unavailable');
          return authoritativeStop();
        },
      });

      const command = [
        `unset ${agentJobs.__agentJobsTest.LAUNCH_TOKEN_ENV}`,
        `nohup setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)}`
          + ' >/dev/null 2>&1 </dev/null &',
      ].join('; ');

      try {
        const job = await agentJobs.startAgentJob({
          userId: 'user-systemd',
          actorAuthorizationVersion: 11,
          toolId: 'shell',
          title: 'Hostile daemon fixture',
          command,
          env: { JOB_DAEMON_PIDFILE: pidPath },
        });
        expect(activationSawDurableIdentity).toBe(true);

        const deadline = Date.now() + 10_000;
        while (
          (!fs.existsSync(pidPath) || records.get(job.id)?.status !== 'running')
          && Date.now() < deadline
        ) {
          await delay(20);
        }
        await Promise.race([
          stopEntered,
          delay(10_000).then(() => {
            throw new Error('launcher exit did not enter exact scope settlement');
          }),
        ]);
        daemonPid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
        expect(isLive(daemonPid)).toBe(true);
        expect(agentJobs.__agentJobsTest.readProcessLaunchToken(daemonPid)).toBeNull();
        expect(records.get(job.id).status).toBe('running');

        let quiescenceSettled = false;
        const quiescence = agentJobs
          .quiesceAgentJobsForAuthorizationTransition(['user-systemd'])
          .then(
            (result) => {
              quiescenceSettled = true;
              return result;
            },
            (error) => {
              quiescenceSettled = true;
              throw error;
            },
          );
        await delay(200);
        expect(quiescenceSettled).toBe(false);
        expect(records.get(job.id).status).toBe('running');
        expect(isLive(daemonPid)).toBe(true);

        releaseStop();
        await expect(quiescence).resolves.toEqual({
          jobCount: 1,
          liveRuntimeCount: 1,
          persistedRuntimeSignalCount: 0,
        });
        const deathDeadline = Date.now() + 5_000;
        while (isLive(daemonPid) && Date.now() < deathDeadline) await delay(20);
        expect(isLive(daemonPid)).toBe(false);
        expect(records.get(job.id).status).toBe('completed');
        expect(records.get(job.id).metadata.runtime.settlement).toEqual(
          expect.objectContaining({ proven: true }),
        );
      } finally {
        releaseStop();
        if (authoritativeStop) {
          await authoritativeStop().catch(() => undefined);
        }
        if (daemonPid > 1 && isLive(daemonPid)) {
          try { process.kill(daemonPid, 'SIGKILL'); } catch {}
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
