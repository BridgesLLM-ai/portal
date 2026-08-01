import client from './client';
import { agentJobsAPI, type AgentJob } from './agentJobs';

export type AgentToolsRequestOptions = Readonly<{
  timeoutMs?: number;
}>;

export class ToolInstallJobTerminalError extends Error {
  readonly code = 'TOOL_INSTALL_JOB_TERMINAL';

  constructor(readonly terminalStatus: 'error' | 'killed') {
    super(terminalStatus === 'killed' ? 'Tool installation was cancelled' : 'Tool installation failed');
    this.name = 'ToolInstallJobTerminalError';
  }
}

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
  async list(refresh = false, options?: AgentToolsRequestOptions): Promise<{ tools: AgentTool[]; cachedForMs: number }> {
    const timeout = Number.isFinite(options?.timeoutMs) && Number(options?.timeoutMs) > 0
      ? Math.max(1, Math.floor(Number(options?.timeoutMs)))
      : undefined;
    const { data } = await client.get('/agent-tools', {
      params: refresh ? { refresh: 1 } : undefined,
      ...(timeout ? { timeout } : {}),
    });
    return data;
  },
  async install(toolId: string, confirmation: string, options?: AgentToolsRequestOptions): Promise<{ jobId: string; room: string; toolId: string; message: string }> {
    const timeout = Number.isFinite(options?.timeoutMs) && Number(options?.timeoutMs) > 0
      ? Math.max(1, Math.floor(Number(options?.timeoutMs)))
      : undefined;
    const { data } = timeout
      ? await client.post(`/agent-tools/${toolId}/install`, { confirmation }, { timeout })
      : await client.post(`/agent-tools/${toolId}/install`, { confirmation });
    return data;
  },
};

export function toolInstallConfirmationPhrase(toolId: string): string {
  return `INSTALL ${String(toolId || '').trim().toUpperCase()}`;
}

export async function waitForToolInstallJob(
  jobId: string,
  options: { timeoutMs?: number; pollMs?: number; requestTimeoutMs?: number } = {},
): Promise<AgentJob> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = options.pollMs ?? 1500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const callTimeoutMs = Math.max(1, Math.min(requestTimeoutMs, remainingMs));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const job = await Promise.race([
      agentJobsAPI.status(jobId, { timeoutMs: callTimeoutMs }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out while checking the retained tool-installation job.')),
          callTimeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (job.status === 'completed') return job;
    if (job.status === 'error' || job.status === 'killed') {
      throw new ToolInstallJobTerminalError(job.status);
    }
    const sleepMs = Math.max(0, Math.min(pollMs, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  throw new Error('Tool installation is still running; monitor it from Agent Tools → Tasks.');
}
