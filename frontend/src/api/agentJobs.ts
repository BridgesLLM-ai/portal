import client from './client';

export type AgentJobRequestOptions = Readonly<{
  timeoutMs?: number;
}>;

export type AgentJobStatus = 'running' | 'completed' | 'error' | 'killed';

export type TranscriptEntry = {
  type: 'input' | 'output' | 'system';
  text: string;
  stream?: 'stdout' | 'stderr';
  timestamp: string;
};

export type AgentJob = {
  id: string;
  userId: string;
  toolId: string;
  title?: string | null;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
};

function requestTimeout(options?: AgentJobRequestOptions): { timeout: number } | undefined {
  const timeoutMs = options?.timeoutMs;
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) return undefined;
  return { timeout: Math.max(1, Math.floor(timeoutMs)) };
}

export const agentJobsAPI = {
  async list(options?: AgentJobRequestOptions): Promise<AgentJob[]> {
    const config = requestTimeout(options);
    const { data } = config
      ? await client.get('/agent-jobs', config)
      : await client.get('/agent-jobs');
    return data;
  },
  async get(id: string): Promise<AgentJob & { transcript: TranscriptEntry[]; metadata?: Record<string, unknown> }> {
    const { data } = await client.get(`/agent-jobs/${id}`);
    return data;
  },
  async status(id: string, options?: AgentJobRequestOptions): Promise<AgentJob> {
    const config = requestTimeout(options);
    const { data } = config
      ? await client.get(`/agent-jobs/${id}/status`, config)
      : await client.get(`/agent-jobs/${id}/status`);
    return data;
  },
  async transcript(id: string, entries = 200): Promise<TranscriptEntry[]> {
    const { data } = await client.get(`/agent-jobs/${id}/transcript`, { params: { entries } });
    return Array.isArray(data?.transcript) ? data.transcript : [];
  },
  async start(payload: { toolId: string; title?: string; command: string; cwd?: string; env?: Record<string, string> }) {
    const { data } = await client.post('/agent-jobs', payload);
    return data as AgentJob;
  },
  async input(id: string, input: string) {
    await client.post(`/agent-jobs/${id}/input`, { input });
  },
  async kill(id: string, options?: AgentJobRequestOptions) {
    const config = requestTimeout(options);
    if (config) {
      await client.post(`/agent-jobs/${id}/kill`, undefined, config);
      return;
    }
    await client.post(`/agent-jobs/${id}/kill`);
  },
};
