import { EventEmitter, once } from 'events';
import fs, { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const jobsRoot = mkdtempSync(path.join(os.tmpdir(), 'portal-agent-jobs-test-'));
process.env.PORTAL_AGENT_JOBS_ROOT = jobsRoot;
process.env.PORTAL_AGENT_JOBS_DISABLE_PTY = '1';

const findManyMock = jest.fn();
const findUniqueMock = jest.fn();
const createMock = jest.fn();
const updateMock = jest.fn();
const updateManyMock = jest.fn();
const findFirstMock = jest.fn();
const userFindUniqueMock = jest.fn();
const transitionFindFirstMock = jest.fn();
const transactionMock = jest.fn();
const sendJobFailedAlertMock = jest.fn();
const spawnMock = jest.fn();
const activationGateReleaseMock = jest.fn();
const scopeStopMock = jest.fn();
const scopeStopIdentityMock = jest.fn();
const jobRecords = new Map<string, any>();
let nextJobId = 1;

class MockChild extends EventEmitter {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    writable: true,
    write: jest.fn((_input: string, callback?: () => void) => {
      callback?.();
      return true;
    }),
  };
  kill = jest.fn(() => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

const spawnedChildren: MockChild[] = [];

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: spawnMock,
}));

jest.mock('../config/database', () => ({
  prisma: {
    $transaction: transactionMock,
    user: {
      findUnique: userFindUniqueMock,
    },
    projectAuthorizationTransition: {
      findFirst: transitionFindFirstMock,
    },
    agentJob: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
      create: createMock,
      update: updateMock,
      updateMany: updateManyMock,
    },
  },
}));

jest.mock('../services/email', () => ({
  sendJobFailedAlert: sendJobFailedAlertMock,
}));

// Throwing from the factory makes the service exercise its spawn fallback.
jest.mock('node-pty', () => {
  throw new Error('PTY disabled in lifecycle tests');
});

const agentJobs = require('../services/agentJobs') as typeof import('../services/agentJobs');
const authorizationChangeBus = require('../services/authorizationChangeBus') as
  typeof import('../services/authorizationChangeBus');

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function completeTermination<T>(promise: Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) await flushAsyncWork();
  jest.advanceTimersByTime(agentJobs.AGENT_JOB_LIMITS.terminateGraceMs);
  for (let attempt = 0; attempt < 20; attempt += 1) await flushAsyncWork();
  jest.advanceTimersByTime(300);
  for (let attempt = 0; attempt < 20; attempt += 1) await flushAsyncWork();
  return promise;
}

async function startMockJob() {
  const job = await agentJobs.startAgentJob({
    userId: 'user-1',
    actorAuthorizationVersion: 7,
    toolId: 'shell',
    title: 'Lifecycle job',
    command: 'sleep 30',
  });
  return { job, child: spawnedChildren[spawnedChildren.length - 1] };
}

describe('agentJobs lifecycle safety', () => {
  let processKillSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    agentJobs.__agentJobsTest.resetRuntimeState();
    activationGateReleaseMock.mockResolvedValue(undefined);
    agentJobs.__agentJobsTest.setRuntimeStartTimeProbe((pid) => String(pid * 10));
    jobRecords.clear();
    spawnedChildren.length = 0;
    nextJobId = 1;
    for (const file of fs.readdirSync(jobsRoot)) rmSync(path.join(jobsRoot, file), { force: true });

    spawnMock.mockImplementation(() => {
      const child = new MockChild(41_000 + spawnedChildren.length);
      spawnedChildren.push(child);
      return child as any;
    });
    const stopProof = (identity: any) => ({
      scopeUnit: identity.scopeUnit,
      invocationId: identity.invocationId,
      bootId: identity.bootId,
      stopRequested: true,
      cgroupEmpty: true,
      finalLoadState: 'not-found',
      finalActiveState: 'inactive',
      finalSubState: 'dead',
    });
    scopeStopMock.mockImplementation(async (identity: any) => stopProof(identity));
    scopeStopIdentityMock.mockImplementation(async (identity: any) => stopProof(identity));
    agentJobs.__agentJobsTest.setSystemdScopeBoundary({
      initialize: async () => undefined,
      prepare: async ({ command, cwd, env }: any) => {
        const child = spawnMock('/bin/bash', ['-lc', command], {
          cwd,
          env,
          stdio: 'pipe',
          detached: true,
        }) as MockChild;
        const suffix = child.pid.toString(16).padStart(32, '0');
        const scopeUnit = `bridgesllm-host-agent-${suffix}.scope`;
        const scopeTag = 'ab'.repeat(32);
        const identity = {
          kind: 'host-systemd-v1' as const,
          scopeUnit,
          scopeTag,
          description: `BridgesLLM host agent run tag=${scopeTag}`,
          controlGroup: `/system.slice/${scopeUnit}`,
          bootId: '01234567-89ab-4cde-8fab-0123456789ab',
          invocationId: suffix,
        };
        return {
          type: 'spawn' as const,
          pid: child.pid,
          child: child as any,
          identity,
          activate: activationGateReleaseMock,
          stop: () => scopeStopMock(identity),
        };
      },
      stopIdentity: scopeStopIdentityMock,
    });
    findManyMock.mockResolvedValue([]);
    findFirstMock.mockResolvedValue(null);
    userFindUniqueMock.mockResolvedValue({
      authorizationVersion: 7,
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
      const record = { id: `job-${nextJobId++}`, ...data };
      jobRecords.set(record.id, record);
      return record;
    });
    updateMock.mockImplementation(async ({ where, data }: any) => {
      const record = jobRecords.get(where.id);
      if (record) Object.assign(record, data);
      return record || { id: where.id, ...data };
    });
    updateManyMock.mockImplementation(async ({ where, data }: any) => {
      const record = jobRecords.get(where.id);
      if (record && (!where.status || record.status === where.status)) {
        Object.assign(record, data);
        return { count: 1 };
      }
      return { count: record ? 0 : 1 };
    });
    findUniqueMock.mockImplementation(async ({ where }: any) => jobRecords.get(where.id) || null);
    sendJobFailedAlertMock.mockResolvedValue(undefined);
    processKillSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any);
  });

  afterEach(() => {
    agentJobs.__agentJobsTest.resetRuntimeState();
    processKillSpy.mockRestore();
    jest.useRealTimers();
  });

  afterAll(() => {
    rmSync(jobsRoot, { recursive: true, force: true });
    delete process.env.PORTAL_AGENT_JOBS_ROOT;
    delete process.env.PORTAL_AGENT_JOBS_DISABLE_PTY;
  });

  it('rejects oversized interactive input before writing to the process or transcript', async () => {
    const { job, child } = await startMockJob();
    const oversized = 'x'.repeat(agentJobs.AGENT_JOB_LIMITS.maxInputBytes + 1);

    await expect(agentJobs.writeToAgentJob(job.id, 'user-1', oversized)).rejects.toMatchObject({
      statusCode: 413,
      code: 'INPUT_TOO_LARGE',
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it('persists the exact actor generation and rejects stale or transition-fenced admission', async () => {
    const current = await startMockJob();
    expect(jobRecords.get(current.job.id)).toEqual(expect.objectContaining({
      actorAuthorizationVersion: 7,
    }));

    userFindUniqueMock.mockResolvedValueOnce({
      authorizationVersion: 8,
      accountStatus: 'ACTIVE',
      isActive: true,
    });
    await expect(agentJobs.startAgentJob({
      userId: 'user-1',
      actorAuthorizationVersion: 7,
      toolId: 'shell',
      command: 'id',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUTHORIZATION_CHANGED',
    });

    transitionFindFirstMock.mockResolvedValueOnce({ id: 'transition-1' });
    await expect(agentJobs.startAgentJob({
      userId: 'user-1',
      actorAuthorizationVersion: 7,
      toolId: 'shell',
      command: 'id',
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'AUTHORIZATION_TRANSITION_ACTIVE',
    });
    expect(spawnedChildren).toHaveLength(1);
  });

  it('uses exact systemd identity when launcher PID start-time metadata is unavailable', async () => {
    agentJobs.__agentJobsTest.setRuntimeStartTimeProbe(() => null);

    const job = await agentJobs.startAgentJob({
      userId: 'user-1',
      actorAuthorizationVersion: 7,
      toolId: 'shell',
      command: 'touch should-never-run',
    });

    expect(activationGateReleaseMock).toHaveBeenCalledTimes(1);
    expect(jobRecords.get(job.id).metadata.runtime).toEqual(expect.objectContaining({
      processStartTime: null,
      systemdScope: expect.objectContaining({
        kind: 'host-systemd-v1',
        invocationId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    }));
    await agentJobs.killAgentJob(job.id, 'user-1');
  });

  it('rejects interactive input when the job owner generation no longer matches', async () => {
    const { job, child } = await startMockJob();
    userFindUniqueMock.mockResolvedValueOnce({
      authorizationVersion: 8,
      accountStatus: 'ACTIVE',
      isActive: true,
    });

    await expect(agentJobs.writeToAgentJob(job.id, 'user-1', 'continue\n')).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUTHORIZATION_CHANGED',
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it('terminates a generation-bound host job when authorization changes', async () => {
    const { job, child } = await startMockJob();
    authorizationChangeBus.publishAuthorizationChanged({
      type: 'authorization_changed',
      userId: 'user-1',
      authorizationVersion: 8,
      reasons: ['role'],
    });

    await flushAsyncWork();
    jest.advanceTimersByTime(agentJobs.AGENT_JOB_LIMITS.terminateGraceMs);
    await flushAsyncWork();
    jest.advanceTimersByTime(300);
    await flushAsyncWork();

    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: child.pid.toString(16).padStart(32, '0') }),
    );
    expect(jobRecords.get(job.id)).toEqual(expect.objectContaining({ status: 'killed' }));
  });

  it('authoritatively quiesces selected live jobs before an authorization commit', async () => {
    const { job, child } = await startMockJob();
    findManyMock.mockResolvedValueOnce([jobRecords.get(job.id)]);
    const quiescence = agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']);
    const result = await completeTermination(quiescence);

    expect(result).toEqual({
      jobCount: 1,
      liveRuntimeCount: 1,
      persistedRuntimeSignalCount: 0,
    });
    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: child.pid.toString(16).padStart(32, '0') }),
    );
    expect(jobRecords.get(job.id)).toEqual(expect.objectContaining({ status: 'killed' }));
  });

  it('quiesces the global live-job inventory before dependency promotion', async () => {
    const { job, child } = await startMockJob();
    findManyMock.mockResolvedValueOnce([jobRecords.get(job.id)]);
    const quiescence = agentJobs.quiesceAgentJobsForProjectDependencyPromotion();
    const result = await completeTermination(quiescence);

    expect(result).toEqual({
      jobCount: 1,
      liveRuntimeCount: 1,
      persistedRuntimeSignalCount: 0,
    });
    expect(findManyMock.mock.calls.at(-1)?.[0]?.where).toEqual({ status: 'running' });
    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: child.pid.toString(16).padStart(32, '0') }),
    );
    expect(jobRecords.get(job.id)).toEqual(expect.objectContaining({ status: 'killed' }));
  });

  it('returns only the requested bounded tail of a retained transcript', async () => {
    const { job } = await startMockJob();
    const transcriptPath = job.transcriptPath as string;
    fs.writeFileSync(transcriptPath, Array.from({ length: 8 }, (_, index) => JSON.stringify({
      type: 'output',
      text: `line-${index + 1}`,
      timestamp: `2026-07-19T12:00:0${index}.000Z`,
    })).join('\n') + '\n', { mode: 0o600 });

    const transcript = await agentJobs.readTranscript(job.id, {
      maxEntries: 3,
      maxReadBytes: 1024,
    });

    expect(transcript.map((entry) => entry.text)).toEqual(['line-6', 'line-7', 'line-8']);
  });

  it('emits a terminal status only after the durable state transition succeeds', async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = agentJobs.onAgentJobStatus((event) => events.push(event));
    const { job, child } = await startMockJob();

    child.emit('exit', 0);
    await flushAsyncWork();

    expect(jobRecords.get(job.id)).toEqual(expect.objectContaining({ status: 'completed', exitCode: 0 }));
    expect(events).toEqual([
      expect.objectContaining({
        jobId: job.id,
        status: 'completed',
        exitCode: 0,
        finishedAt: expect.any(String),
      }),
    ]);

    child.emit('exit', 0);
    await flushAsyncWork();
    expect(events).toHaveLength(1);
    unsubscribe();
  });

  it('keeps a launcher-exited job fenced until its exact scope is proven empty', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { job, child } = await startMockJob();
      scopeStopMock.mockRejectedValueOnce(new Error('cgroup still populated'));

      child.emit('exit', 0);
      await flushAsyncWork();

      expect(jobRecords.get(job.id).status).toBe('running');
      expect(agentJobs.__agentJobsTest.runtimes.has(job.id)).toBe(true);

      findManyMock.mockResolvedValueOnce([jobRecords.get(job.id)]);
      scopeStopIdentityMock.mockRejectedValueOnce(new Error('cgroup still populated'));
      await expect(
        agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']),
      ).rejects.toThrow('cgroup still populated');
      expect(jobRecords.get(job.id).status).toBe('running');
      expect(agentJobs.__agentJobsTest.runtimes.has(job.id)).toBe(true);

      findManyMock.mockResolvedValueOnce([jobRecords.get(job.id)]);
      const result = await agentJobs.quiesceAgentJobsForAuthorizationTransition(['user-1']);
      expect(result).toEqual({
        jobCount: 1,
        liveRuntimeCount: 1,
        persistedRuntimeSignalCount: 0,
      });
      expect(jobRecords.get(job.id).status).toBe('killed');
      expect(agentJobs.__agentJobsTest.runtimes.has(job.id)).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('caps aggregate stdout/stderr, terminates the process group, and keeps the transcript bounded', async () => {
    const { job, child } = await startMockJob();
    child.stdout.emit('data', Buffer.from('normal stdout'));
    child.stderr.emit('data', Buffer.alloc(agentJobs.AGENT_JOB_LIMITS.maxOutputBytes + 1, 0x61));

    await flushAsyncWork();
    jest.advanceTimersByTime(agentJobs.AGENT_JOB_LIMITS.terminateGraceMs);
    await flushAsyncWork();
    jest.advanceTimersByTime(300);
    await flushAsyncWork();

    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: child.pid.toString(16).padStart(32, '0') }),
    );
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: job.id, status: 'running' }),
      data: expect.objectContaining({ status: 'error' }),
    }));
    expect(fs.statSync(job.transcriptPath as string).size).toBeLessThanOrEqual(agentJobs.AGENT_JOB_LIMITS.maxTranscriptBytes);
  });

  it('uses the exact systemd scope proof for cancellation', async () => {
    const { job, child } = await startMockJob();

    await completeTermination(agentJobs.killAgentJob(job.id, 'user-1'));

    expect(scopeStopMock).toHaveBeenCalledTimes(1);
    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: child.pid.toString(16).padStart(32, '0') }),
    );
    expect(jobRecords.get(job.id)).toEqual(expect.objectContaining({ status: 'killed' }));
    expect(agentJobs.__agentJobsTest.runtimes.has(job.id)).toBe(false);

    await expect(agentJobs.killAgentJob(job.id, 'user-1')).resolves.toBeUndefined();
    expect(scopeStopMock).toHaveBeenCalledTimes(1);
  });

  it('cancels every live process tree and persists terminal state during Portal shutdown', async () => {
    const first = await startMockJob();
    const second = await startMockJob();

    await completeTermination(agentJobs.shutdownAgentJobsRuntime());

    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: first.child.pid.toString(16).padStart(32, '0') }),
    );
    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: second.child.pid.toString(16).padStart(32, '0') }),
    );
    expect(jobRecords.get(first.job.id).status).toBe('killed');
    expect(jobRecords.get(second.job.id).status).toBe('killed');
    expect(agentJobs.__agentJobsTest.runtimes.size).toBe(0);
  });

  it('drains an admitted startup before shutdown so no late process escapes cancellation', async () => {
    let releaseCallerCode: (() => void) | undefined;
    activationGateReleaseMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseCallerCode = resolve;
    }));

    const starting = agentJobs.startAgentJob({
      userId: 'user-1',
      actorAuthorizationVersion: 7,
      toolId: 'shell',
      title: 'Startup race',
      command: 'sleep 30',
    });
    for (let attempt = 0; attempt < 100 && !releaseCallerCode; attempt += 1) {
      await Promise.resolve();
    }
    expect(releaseCallerCode).toBeDefined();
    expect(activationGateReleaseMock).toHaveBeenCalledTimes(1);
    const shuttingDown = agentJobs.shutdownAgentJobsRuntime();
    releaseCallerCode?.();
    const job = await starting;

    await completeTermination(shuttingDown);

    const child = spawnedChildren[0];
    expect(scopeStopMock).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: child.pid.toString(16).padStart(32, '0') }),
    );
    expect(jobRecords.get(job.id).status).toBe('killed');
    expect(agentJobs.__agentJobsTest.runtimes.size).toBe(0);
  });

  it('reconciles persisted running jobs after restart and kills only a matching process identity', async () => {
    const transcriptPath = path.join(jobsRoot, 'persisted.jsonl');
    fs.writeFileSync(transcriptPath, '', { mode: 0o600 });
    const pid = process.pid;
    const processStartTime = agentJobs.__agentJobsTest.readProcessStartTime(pid);
    const persisted = {
      id: 'persisted-job',
      status: 'running',
      transcriptPath,
      metadata: {
        command: 'sleep 30',
        runtime: {
          portalInstanceId: 'dead-portal',
          pid,
          processGroupId: pid,
          processStartTime,
          detached: true,
          startedAt: new Date().toISOString(),
        },
      },
    };
    jobRecords.set(persisted.id, persisted);
    findManyMock.mockResolvedValue([persisted]);

    const initialization = agentJobs.initializeAgentJobsRuntime();
    const result = await completeTermination(initialization);

    expect(result).toEqual({ reconciled: 1, signaled: 1 });
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM');
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(jobRecords.get(persisted.id)).toEqual(expect.objectContaining({ status: 'error' }));
    expect(fs.readFileSync(transcriptPath, 'utf8')).toContain('Portal restarted before this job completed');
  });

  it('kills a TERM-ignoring descendant that escaped into a new session', async () => {
    jest.useRealTimers();
    processKillSpy.mockRestore();
    const realChildProcess = jest.requireActual('child_process') as typeof import('child_process');
    const treeDir = mkdtempSync(path.join(os.tmpdir(), 'portal-job-tree-test-'));
    const descendantPath = path.join(treeDir, 'descendant.pid');
    const child = realChildProcess.spawn('/bin/bash', [
      '-lc',
      'setsid "$JOB_TREE_NODE" -e \'const fs=require("fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(process.env.JOB_TREE_PIDFILE,String(process.pid)); setInterval(()=>{},1000)\' & wait',
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, JOB_TREE_PIDFILE: descendantPath, JOB_TREE_NODE: process.execPath },
    });

    const deadline = Date.now() + 3000;
    while (!fs.existsSync(descendantPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const descendantPid = Number.parseInt(fs.readFileSync(descendantPath, 'utf8').trim(), 10);
    const isLive = (pid: number) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = stat.lastIndexOf(') ');
        return commandEnd >= 0 && stat.slice(commandEnd + 2).split(/\s+/)[0] !== 'Z';
      } catch {
        return false;
      }
    };

    try {
      expect(child.pid).toBeDefined();
      expect(isLive(descendantPid)).toBe(true);
      const captured = agentJobs.__agentJobsTest.captureDescendantIdentities(child.pid as number);
      expect(agentJobs.__agentJobsTest.signalProcessTree(child.pid as number, 'SIGTERM')).toBe(true);
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('process tree did not exit')), 3000)),
      ]);
      expect(isLive(descendantPid)).toBe(true);
      expect(agentJobs.__agentJobsTest.signalCapturedProcesses(captured, 'SIGKILL')).toBe(true);
      const descendantDeadline = Date.now() + 2000;
      while (isLive(descendantPid) && Date.now() < descendantDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isLive(descendantPid)).toBe(false);
    } finally {
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch {}
      rmSync(treeDir, { recursive: true, force: true });
      processKillSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any);
    }
  });
});
