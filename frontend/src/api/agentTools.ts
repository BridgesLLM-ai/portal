import client from './client';

export type ToolAdapterStatus = {
  installed: boolean;
  version: string | null;
  missing: boolean;
  checkedAt: string;
};

export type ToolCommandPreset = {
  label: string;
  command: string;
  description?: string;
  cwd?: string;
};

export type AgentTool = {
  id: string;
  name: string;
  description: string;
  detect?: { command: string };
  install: Array<{ label: string; command: string; description?: string }>;
  commands: ToolCommandPreset[];
  authRequired: boolean;
  authHint?: string;
  tier: 1 | 2;
  status: ToolAdapterStatus;
};

export const agentToolsAPI = {
  async list(): Promise<{ tools: AgentTool[]; cachedForMs: number }> {
    const { data } = await client.get('/agent-tools');
    return data;
  },
  async install(toolId: string): Promise<{ jobId: string; room: string; toolId: string; message: string }> {
    const { data } = await client.post(`/agent-tools/${toolId}/install`);
    return data;
  },
};
