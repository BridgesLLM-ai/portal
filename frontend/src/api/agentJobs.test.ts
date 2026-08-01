import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('./client', () => ({ default: clientMocks }));

import { agentJobsAPI } from './agentJobs';

describe('agentJobsAPI request deadlines', () => {
  beforeEach(() => {
    clientMocks.get.mockReset().mockResolvedValue({ data: [] });
    clientMocks.post.mockReset().mockResolvedValue({ data: { success: true } });
  });

  it('applies explicit timeouts to retained-job inventory and status reads', async () => {
    await agentJobsAPI.list({ timeoutMs: 4_500.9 });
    await agentJobsAPI.status('job/one', { timeoutMs: 2_000 });

    expect(clientMocks.get).toHaveBeenNthCalledWith(1, '/agent-jobs', { timeout: 4500 });
    expect(clientMocks.get).toHaveBeenNthCalledWith(2, '/agent-jobs/job/one/status', { timeout: 2000 });
  });

  it('applies an explicit timeout to kill acknowledgement without changing legacy calls', async () => {
    await agentJobsAPI.kill('job-1', { timeoutMs: 3_000 });
    await agentJobsAPI.kill('job-2');

    expect(clientMocks.post).toHaveBeenNthCalledWith(1, '/agent-jobs/job-1/kill', undefined, { timeout: 3000 });
    expect(clientMocks.post).toHaveBeenNthCalledWith(2, '/agent-jobs/job-2/kill');
  });
});
