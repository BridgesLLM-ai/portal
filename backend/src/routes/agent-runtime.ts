import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { authenticateToken } from '../middleware/auth';
import { getOpenClawApiUrl } from '../config/openclaw';
import { TOOL_ADAPTERS } from '../config/toolAdapters';

const router = Router();
const GATEWAY_URL = getOpenClawApiUrl();

type AdapterStatus = {
  id: string;
  name: string;
  available: boolean;
  version: string | null;
};

function checkCommand(command: string): Promise<{ available: boolean; version: string | null }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 2500, shell: '/bin/bash' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ available: false, version: null });
        return;
      }
      const output = `${stdout || ''}\n${stderr || ''}`.trim();
      const semver = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
      resolve({ available: true, version: semver ? semver[0] : output.split(/\r?\n/)[0] || null });
    });
  });
}

router.get('/status', authenticateToken, async (_req: Request, res: Response) => {
  let gateway = { connected: false, message: 'Gateway unreachable' };

  try {
    const probe = await fetch(`${GATEWAY_URL}/`, { signal: AbortSignal.timeout(2500) });
    gateway = probe.ok
      ? { connected: true, message: 'Gateway reachable' }
      : { connected: false, message: `Gateway responded ${probe.status}` };
  } catch (error: any) {
    gateway = { connected: false, message: error?.message || 'Gateway unreachable' };
  }

  const adapterStatuses: AdapterStatus[] = await Promise.all(
    TOOL_ADAPTERS.map(async (adapter) => {
      if (!adapter.detect?.command) {
        return { id: adapter.id, name: adapter.name, available: true, version: null };
      }
      const status = await checkCommand(adapter.detect.command);
      return {
        id: adapter.id,
        name: adapter.name,
        available: status.available,
        version: status.version,
      };
    }),
  );

  res.json({
    gateway,
    adapters: adapterStatuses,
    anyAgentAvailable: adapterStatuses.some((a) => a.available && a.id !== 'shell'),
    checkedAt: new Date().toISOString(),
  });
});

export default router;
