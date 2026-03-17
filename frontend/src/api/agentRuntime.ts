import client from './client';

export type AgentRuntimeStatus = {
  gateway: { connected: boolean; message: string };
  adapters: Array<{ id: string; name: string; available: boolean; version: string | null }>;
  anyAgentAvailable: boolean;
  checkedAt: string;
};

export const agentRuntimeAPI = {
  async status(): Promise<AgentRuntimeStatus> {
    const { data } = await client.get('/agent-runtime/status');
    return data;
  },
};
