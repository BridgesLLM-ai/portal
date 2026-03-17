import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { config } from '../config/env';
import fs from 'fs';
import path from 'path';
import { exec as cpExec } from 'child_process';

type StepResult = { step: string; ok: boolean; message: string };

const router = Router();
router.use(authenticateToken);
router.use(requireAdmin);

function runShell(cmd: string, timeoutMs = 30000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    cpExec(cmd, { timeout: timeoutMs, shell: '/bin/bash' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

async function remediateTerminal(): Promise<{ ok: boolean; message: string; steps: StepResult[] }> {
  const steps: StepResult[] = [];

  const bash = await runShell('command -v bash >/dev/null 2>&1 && echo ok');
  steps.push({ step: 'Bash shell available', ok: bash.ok, message: bash.ok ? 'bash found' : 'bash missing' });

  const ptyPath = path.join(process.cwd(), 'node_modules', 'node-pty');
  if (fs.existsSync(ptyPath)) {
    steps.push({ step: 'node-pty module', ok: true, message: 'node-pty present' });
  } else {
    const installPty = await runShell('npm i --no-save node-pty', 120000);
    steps.push({ step: 'Install node-pty', ok: installPty.ok, message: installPty.ok ? 'node-pty installed' : (installPty.stderr || 'install failed').slice(0, 220) });
  }

  const projectsDir = path.join(process.env.PORTAL_ROOT || '/portal', 'projects');
  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    steps.push({ step: 'Ensure projects directory', ok: true, message: `Exists: ${projectsDir}` });
  } catch (error: any) {
    steps.push({ step: 'Ensure projects directory', ok: false, message: error?.message || 'Failed to create /portal/projects' });
  }

  const defaults: Array<[string, string]> = [
    ['runners.openclaw.workingDirectory', projectsDir],
    ['runners.codex.workingDirectory', projectsDir],
    ['runners.claudeCode.workingDirectory', projectsDir],
    ['runners.shell.workingDirectory', projectsDir],
  ];

  for (const [key, value] of defaults) {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    if (!row?.value?.trim()) {
      await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
      steps.push({ step: `Set ${key}`, ok: true, message: value });
    } else {
      steps.push({ step: `Set ${key}`, ok: true, message: `Already configured: ${row.value}` });
    }
  }

  const ok = steps.every((s) => s.ok);
  return { ok, message: ok ? 'Terminal remediation complete.' : 'Terminal remediation completed with warnings.', steps };
}

async function remediateFileManager(): Promise<{ ok: boolean; message: string; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  const uploadDir = config.uploadDir;

  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    steps.push({ step: 'Ensure upload directory', ok: true, message: `Exists: ${uploadDir}` });
  } catch (error: any) {
    steps.push({ step: 'Ensure upload directory', ok: false, message: error?.message || 'Failed to create upload directory' });
  }

  try {
    fs.accessSync(uploadDir, fs.constants.R_OK | fs.constants.W_OK);
    steps.push({ step: 'Verify upload directory read/write', ok: true, message: 'Read/write access OK' });
  } catch (error: any) {
    steps.push({ step: 'Verify upload directory read/write', ok: false, message: error?.message || 'Upload directory is not read/write' });
  }

  const ok = steps.every((s) => s.ok);
  return { ok, message: ok ? 'File Manager remediation complete.' : 'File Manager remediation completed with warnings.', steps };
}

async function remediateAgentTools(): Promise<{ ok: boolean; message: string; steps: StepResult[] }> {
  const steps: StepResult[] = [];

  const checks: Array<{ name: string; cmd: string; required: boolean }> = [
    { name: 'OpenClaw CLI', cmd: 'openclaw --version', required: true },
    { name: 'Codex CLI', cmd: 'codex --version', required: false },
    { name: 'Claude CLI', cmd: 'claude --version', required: false },
  ];

  for (const check of checks) {
    const result = await runShell(check.cmd);
    const ok = result.ok || !check.required;
    steps.push({
      step: check.name,
      ok,
      message: result.ok ? (result.stdout || 'available') : (check.required ? 'Missing (required)' : 'Not installed (optional)'),
    });
  }

  const ok = steps.every((s) => s.ok);
  return { ok, message: ok ? 'Agent tools validation complete.' : 'Agent tools validation completed with warnings.', steps };
}

router.post('/:feature/auto-setup', async (req: Request, res: Response) => {
  try {
    const feature = String(req.params.feature || '').trim();

    if (feature === 'terminal') {
      res.json(await remediateTerminal());
      return;
    }

    if (feature === 'fileManager') {
      res.json(await remediateFileManager());
      return;
    }

    if (feature === 'agentTools') {
      res.json(await remediateAgentTools());
      return;
    }

    res.status(400).json({ ok: false, message: `Auto-setup not implemented for feature: ${feature}`, steps: [] });
  } catch (error: any) {
    res.status(500).json({ ok: false, message: error?.message || 'Feature remediation failed', steps: [] });
  }
});

export default router;
