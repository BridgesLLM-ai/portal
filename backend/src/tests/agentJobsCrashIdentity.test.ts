import fs, { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// hostile crash fixtures. These cover the window where the Portal
// spawns a host job process but crashes before its PID identity is persisted,
// the restart reconciliation that must find and prove-terminate the orphan via
// its durable launch token, and the authorization quiescence that must refuse a
// transition rather than mark a row terminal it cannot prove is dead.

const jobsRoot = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-crash-'));
process.env.PORTAL_AGENT_JOBS_ROOT = jobsRoot;
process.env.PORTAL_AGENT_JOBS_DISABLE_PTY = '1';

const findManyMock = jest.fn();
const findFirstMock = jest.fn();
const updateManyMock = jest.fn();
const jobRecords = new Map<string, any>();

jest.mock('../config/database', () => ({
  prisma: {
    agentJob: {
      findMany: findManyMock,
      findFirst: findFirstMock,
      updateMany: updateManyMock,
    },
  },
}));

jest.mock('../services/email', () => ({
  sendJobFailedAlert: jest.fn().mockResolvedValue(undefined),
}));

const agentJobs = require('../services/agentJobs') as typeof import('../services/agentJobs');
const realChildProcess = jest.requireActual('child_process') as typeof import('child_process');

const linuxOnly = process.platform === 'linux' ? it : it.skip;

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

/**
 * Spawn a detached, session-leading process that carries the launch token in its
 * environment and ignores SIGTERM, forcing the token sweep to escalate to KILL.
 */
function spawnTokenOrphan(launchToken: string, pidFile: string) {
  const script = [
    "process.on('SIGTERM', () => {});",
    'require("fs").writeFileSync(process.env.JOB_PIDFILE, String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = realChildProcess.spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      [agentJobs.__agentJobsTest.LAUNCH_TOKEN_ENV]: launchToken,
      JOB_PIDFILE: pidFile,
    },
  });
  child.unref();
  return child;
}

function persistedRow(overrides: Record<string, any>): Record<string, any> {
  const id = overrides.id as string;
  const transcriptPath = path.join(jobsRoot, `${id}.jsonl`);
  fs.writeFileSync(transcriptPath, '', { mode: 0o600 });
  const row: Record<string, any> = {
    userId: 'user-1',
    actorAuthorizationVersion: 3,
    status: 'running',
    transcriptPath,
    metadata: { command: 'sleep 300' },
    ...overrides,
  };
  jobRecords.set(id, row);
  return row;
}

function persistedHostScopeIdentity() {
  const scopeUnit = 'bridgesllm-host-agent-123456789abc4def8abc123456789abc.scope';
  const scopeTag = 'cd'.repeat(32);
  return {
    kind: 'host-systemd-v1' as const,
    scopeUnit,
    scopeTag,
    description: `BridgesLLM host agent run tag=${scopeTag}`,
    controlGroup: `/system.slice/${scopeUnit}`,
    bootId: '01234567-89ab-4cde-8fab-0123456789ab',
    invocationId: '0123456789abcdef0123456789abcdef',
  };
}

describe('agentJobs crash-identity safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    agentJobs.__agentJobsTest.resetRuntimeState();
    jobRecords.clear();
    for (const file of fs.readdirSync(jobsRoot)) rmSync(path.join(jobsRoot, file), { force: true });

    updateManyMock.mockImplementation(async ({ where, data }: any) => {
      const record = jobRecords.get(where.id);
      if (record && (!where.status || record.status === where.status)) {
        Object.assign(record, data);
        return { count: 1 };
      }
      return { count: 0 };
    });
    findFirstMock.mockImplementation(async ({ where }: any) => (
      [...jobRecords.values()].find((record) => (
        record.status === 'running'
        && (!where?.userId?.in || where.userId.in.includes(record.userId))
      )) || null
    ));
  });

  afterEach(() => {
    agentJobs.__agentJobsTest.restorePersistedProcessProbe();
    agentJobs.__agentJobsTest.resetRuntimeState();
  });

  afterAll(() => {
    rmSync(jobsRoot, { recursive: true, force: true });
    delete process.env.PORTAL_AGENT_JOBS_ROOT;
    delete process.env.PORTAL_AGENT_JOBS_DISABLE_PTY;
  });

  linuxOnly('reconciles a pre-identity orphan by its launch token and proves termination', async () => {
    const launchToken = `crashtok-${Math.random().toString(16).slice(2)}`;
    const pidFile = path.join(jobsRoot, `${launchToken}.pid`);
    const child = spawnTokenOrphan(launchToken, pidFile);

    const spawnDeadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < spawnDeadline) await delay(20);
    const orphanPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);

    try {
      expect(isLive(orphanPid)).toBe(true);
      // The token sweep can find the orphan even though no PID was ever persisted.
      expect(agentJobs.__agentJobsTest.findProcessesByLaunchToken(launchToken)).toContain(orphanPid);

      const row = persistedRow({
        id: 'crash-preident',
        metadata: {
          command: 'sleep 300',
          // Crash happened after exec but before the PID was persisted: only the
          // durable launch token is present, activated === false.
          runtime: { portalInstanceId: 'dead-portal', launchToken, activated: false },
        },
      });
      findManyMock.mockResolvedValue([row]);

      const result = await agentJobs.reconcilePersistedAgentJobs();

      expect(result).toEqual({ reconciled: 1, signaled: 1 });
      expect(jobRecords.get('crash-preident').status).toBe('error');
      expect(jobRecords.get('crash-preident').metadata.reconciliation.orphanProven).toBe(true);

      const deathDeadline = Date.now() + 4000;
      while (isLive(orphanPid) && Date.now() < deathDeadline) await delay(20);
      expect(isLive(orphanPid)).toBe(false);
    } finally {
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 20000);

  linuxOnly('holds caller code behind the parent-bound gate until durable identity release', async () => {
    const launchToken = `gate-release-${Math.random().toString(16).slice(2)}`;
    const sentinelPath = path.join(jobsRoot, `${launchToken}.ran`);
    const gate = await agentJobs.__agentJobsTest.createAgentJobActivationGate(
      jobsRoot,
      launchToken,
    );
    const wrapped = agentJobs.__agentJobsTest.activationWrapperCommand(
      gate.socketPath,
      launchToken,
      'unset PORTAL_AGENT_JOB_LAUNCH_TOKEN; node -e \'require("fs").writeFileSync(process.env.JOB_GATE_SENTINEL, "ran")\'',
    );
    const child = realChildProcess.spawn(wrapped.executable, wrapped.args, {
      detached: true,
      stdio: 'ignore',
      cwd: jobsRoot,
      env: {
        ...process.env,
        [agentJobs.__agentJobsTest.LAUNCH_TOKEN_ENV]: launchToken,
        JOB_GATE_SENTINEL: sentinelPath,
      },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      await gate.ready;
      await delay(150);
      expect(fs.existsSync(sentinelPath)).toBe(false);

      await gate.release();
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(sentinelPath) && Date.now() < deadline) await delay(20);
      expect(fs.readFileSync(sentinelPath, 'utf8')).toBe('ran');
      await expect(Promise.race([
        exited,
        delay(4000).then(() => ({ code: null, signal: 'SIGALRM' as NodeJS.Signals })),
      ])).resolves.toEqual({ code: 0, signal: null });
    } finally {
      gate.abort();
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15000);

  linuxOnly('exits without running caller code when the parent gate disappears before release', async () => {
    const launchToken = `gate-abort-${Math.random().toString(16).slice(2)}`;
    const sentinelPath = path.join(jobsRoot, `${launchToken}.ran`);
    const gate = await agentJobs.__agentJobsTest.createAgentJobActivationGate(
      jobsRoot,
      launchToken,
    );
    const wrapped = agentJobs.__agentJobsTest.activationWrapperCommand(
      gate.socketPath,
      launchToken,
      'node -e \'require("fs").writeFileSync(process.env.JOB_GATE_SENTINEL, "escaped")\'',
    );
    const child = realChildProcess.spawn(wrapped.executable, wrapped.args, {
      detached: true,
      stdio: 'ignore',
      cwd: jobsRoot,
      env: {
        ...process.env,
        [agentJobs.__agentJobsTest.LAUNCH_TOKEN_ENV]: launchToken,
        JOB_GATE_SENTINEL: sentinelPath,
      },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      await gate.ready;
      gate.abort();
      const outcome = await Promise.race([
        exited,
        delay(4000).then(() => ({ code: null, signal: 'SIGALRM' as NodeJS.Signals })),
      ]);
      expect(outcome).toEqual({ code: 125, signal: null });
      expect(fs.existsSync(sentinelPath)).toBe(false);
    } finally {
      gate.abort();
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15000);

  it('fails closed and fences the row when a token orphan cannot be proven gone', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any);
    agentJobs.__agentJobsTest.setPersistedProcessProbe(() => [999999]);
    try {
      const row = persistedRow({
        id: 'crash-unprovable',
        metadata: { command: 'x', runtime: { launchToken: 'tok-unprovable', activated: false } },
      });
      findManyMock.mockResolvedValue([row]);

      const result = await agentJobs.reconcilePersistedAgentJobs();

      // Nothing is reported terminal because nothing could be proven dead.
      expect(result).toEqual({ reconciled: 0, signaled: 0 });
      expect(jobRecords.get('crash-unprovable').status).toBe('running');
      expect(jobRecords.get('crash-unprovable').metadata.reconciliation.orphanProven).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('refuses an authorization transition when a retained process cannot be proven gone', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any);
    agentJobs.__agentJobsTest.setPersistedProcessProbe(() => [999999]);
    try {
      const row = persistedRow({
        id: 'quiesce-unprovable',
        actorAuthorizationVersion: 5,
        metadata: { command: 'x', runtime: { launchToken: 'tok-refuse', activated: false } },
      });
      findManyMock.mockResolvedValueOnce([]); // startup reconciliation pass sees nothing
      findManyMock.mockResolvedValueOnce([row]); // quiescence query returns the retained job

      await expect(
        agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']),
      ).rejects.toThrow('remained active after authorization cleanup');

      // The row must NOT have been marked terminal on DB status alone.
      expect(jobRecords.get('quiesce-unprovable').status).toBe('running');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('fails closed for a PREPARED row merely lacking an observable token', async () => {
    agentJobs.__agentJobsTest.setPersistedProcessProbe(() => []);
    const row = persistedRow({
      id: 'quiesce-gone',
      actorAuthorizationVersion: 5,
      metadata: { command: 'x', runtime: { launchToken: 'tok-gone', activated: false } },
    });
    findManyMock.mockResolvedValueOnce([]); // startup reconciliation pass
    findManyMock.mockResolvedValueOnce([row]); // quiescence query

    await expect(
      agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']),
    ).rejects.toThrow('remained active after authorization cleanup');

    expect(jobRecords.get('quiesce-gone').status).toBe('running');
  });

  it('quiesces an activated retained row once both PID identity and launch token are absent', async () => {
    agentJobs.__agentJobsTest.setPersistedProcessProbe(() => []);
    const row = persistedRow({
      id: 'quiesce-activated-gone',
      actorAuthorizationVersion: 5,
      metadata: {
        command: 'x',
        runtime: {
          launchToken: 'tok-activated-gone',
          activated: true,
          pid: 999_999,
          processStartTime: '1',
        },
      },
    });
    findManyMock.mockResolvedValueOnce([]); // startup reconciliation pass
    findManyMock.mockResolvedValueOnce([row]); // quiescence query

    const result = await agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']);

    expect(result).toEqual({ jobCount: 1, liveRuntimeCount: 0, persistedRuntimeSignalCount: 0 });
    expect(jobRecords.get('quiesce-activated-gone').status).toBe('killed');
  });

  it('quiesces a retained exact systemd scope even when the target removed its launch token', async () => {
    const identity = persistedHostScopeIdentity();
    const stopIdentity = jest.fn(async () => ({
      scopeUnit: identity.scopeUnit,
      invocationId: identity.invocationId,
      bootId: identity.bootId,
      stopRequested: true,
      cgroupEmpty: true as const,
      finalLoadState: 'not-found',
      finalActiveState: 'inactive',
      finalSubState: 'dead',
    }));
    agentJobs.__agentJobsTest.setPersistedProcessProbe(() => []);
    agentJobs.__agentJobsTest.setSystemdScopeBoundary({
      initialize: async () => undefined,
      prepare: async () => { throw new Error('not used'); },
      stopIdentity,
    });
    const row = persistedRow({
      id: 'quiesce-systemd-tokenless',
      actorAuthorizationVersion: 5,
      metadata: {
        command: 'unset PORTAL_AGENT_JOB_LAUNCH_TOKEN; daemonize',
        runtime: {
          portalInstanceId: 'dead-portal',
          activated: true,
          systemdScope: identity,
        },
      },
    });
    findManyMock.mockResolvedValueOnce([]); // startup reconciliation pass
    findManyMock.mockResolvedValueOnce([row]); // quiescence query

    const result = await agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']);

    expect(result).toEqual({ jobCount: 1, liveRuntimeCount: 0, persistedRuntimeSignalCount: 1 });
    expect(stopIdentity).toHaveBeenCalledWith(identity);
    expect(jobRecords.get(row.id).status).toBe('killed');
  });

  it('keeps a retained systemd row fenced when exact cgroup emptiness is unprovable', async () => {
    const identity = persistedHostScopeIdentity();
    agentJobs.__agentJobsTest.setSystemdScopeBoundary({
      initialize: async () => undefined,
      prepare: async () => { throw new Error('not used'); },
      stopIdentity: async () => { throw new Error('cgroup state unavailable'); },
    });
    const row = persistedRow({
      id: 'quiesce-systemd-unproven',
      actorAuthorizationVersion: 5,
      metadata: {
        command: 'daemonize',
        runtime: {
          portalInstanceId: 'dead-portal',
          activated: true,
          systemdScope: identity,
        },
      },
    });
    findManyMock.mockResolvedValueOnce([]); // startup reconciliation pass
    findManyMock.mockResolvedValueOnce([row]); // quiescence query

    await expect(
      agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']),
    ).rejects.toThrow('remained active after authorization cleanup');
    expect(jobRecords.get(row.id).status).toBe('running');
  });

  it('fails closed for a running row that carries no durable identity at all', async () => {
    await expect(
      agentJobs.__agentJobsTest.terminatePersistedRuntime(undefined),
    ).resolves.toEqual({ matched: false, signaled: false, proven: false });
    await expect(
      agentJobs.__agentJobsTest.terminatePersistedRuntime({ portalInstanceId: 'x' } as any),
    ).resolves.toEqual({ matched: false, signaled: false, proven: false });
  });
});
