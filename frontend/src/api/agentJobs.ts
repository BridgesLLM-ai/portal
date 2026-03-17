import client from './client';

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

export const agentJobsAPI = {
  async list(): Promise<AgentJob[]> {
    const { data } = await client.get('/agent-jobs');
    return data;
  },
  async get(id: string): Promise<AgentJob & { transcript: TranscriptEntry[]; metadata?: Record<string, unknown> }> {
    const { data } = await client.get(`/agent-jobs/${id}`);
    return data;
  },
  async start(payload: { toolId: string; title?: string; command: string; cwd?: string; env?: Record<string, string> }) {
    const { data } = await client.post('/agent-jobs', payload);
    return data as AgentJob;
  },
  async input(id: string, input: string) {
    await client.post(`/agent-jobs/${id}/input`, { input });
  },
  async kill(id: string) {
    await client.post(`/agent-jobs/${id}/kill`);
  },
};
