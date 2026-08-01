import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentJobsAPI, type AgentJob } from './agentJobs';
import { ToolInstallJobTerminalError, toolInstallConfirmationPhrase, waitForToolInstallJob } from './agentTools';

function job(status: AgentJob['status']): AgentJob {
  return {
    id: 'job-1',
    userId: 'user-1',
    toolId: '_install:codex',
    title: 'Install Codex',
    status,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('Agent Tool install lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the same exact confirmation phrase as the backend contract', () => {
    expect(toolInstallConfirmationPhrase('claude-code')).toBe('INSTALL CLAUDE-CODE');
  });

  it('waits for durable job completion instead of treating HTTP 202 as success', async () => {
    const status = vi.spyOn(agentJobsAPI, 'status')
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('completed'));

    await expect(waitForToolInstallJob('job-1', { pollMs: 0, timeoutMs: 1000 }))
      .resolves.toMatchObject({ status: 'completed' });
    expect(status).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenNthCalledWith(1, 'job-1', { timeoutMs: 1000 });
  });

  it('surfaces failed and cancelled jobs', async () => {
    vi.spyOn(agentJobsAPI, 'status').mockResolvedValueOnce(job('error'));
    const failure = waitForToolInstallJob('job-1', { pollMs: 0, timeoutMs: 1000 });
    await expect(failure).rejects.toMatchObject({
      code: 'TOOL_INSTALL_JOB_TERMINAL',
      terminalStatus: 'error',
    });
    await expect(failure).rejects.toBeInstanceOf(ToolInstallJobTerminalError);

    vi.spyOn(agentJobsAPI, 'status').mockResolvedValueOnce(job('killed'));
    await expect(waitForToolInstallJob('job-2', { pollMs: 0, timeoutMs: 1000 }))
      .rejects.toMatchObject({
        code: 'TOOL_INSTALL_JOB_TERMINAL',
        terminalStatus: 'killed',
      });
  });

  it('bounds each status RPC independently of the overall job deadline', async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = new Promise<AgentJob>(() => undefined);
      const status = vi.spyOn(agentJobsAPI, 'status').mockReturnValue(neverSettles);
      const result = waitForToolInstallJob('job-1', {
        pollMs: 0,
        timeoutMs: 1000,
        requestTimeoutMs: 50,
      });
      const assertion = expect(result).rejects.toThrow(/timed out while checking/i);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(status).toHaveBeenCalledWith('job-1', { timeoutMs: 50 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the overall bound even when every status request responds', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(agentJobsAPI, 'status').mockResolvedValue(job('running'));
      const result = waitForToolInstallJob('job-1', {
        pollMs: 10,
        timeoutMs: 25,
        requestTimeoutMs: 100,
      });
      const assertion = expect(result).rejects.toThrow(/still running/i);
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
