import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { isOwnerRole } from '../utils/authz';
import { isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import fs from 'fs';
import path from 'path';
import { exec as cpExec } from 'child_process';
import {
  getProjectRuntimeImageRepairStatus,
  launchProjectRuntimeImageRepair,
  PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
  ProjectRuntimeImageRepairLaunchError,
} from '../services/projectRuntimeImageRepair';

type StepResult = { step: string; ok: boolean; message: string };

type SystemRemediationContract = {
  feature: 'terminal' | 'fileManager' | 'agentTools' | 'projectRuntimeImage';
  ownerOnly: true;
  confirmationPhrase: string;
  changesSystem: boolean;
};

const SYSTEM_REMEDIATION_CONTRACTS: Record<SystemRemediationContract['feature'], SystemRemediationContract> = {
  terminal: {
    feature: 'terminal',
    ownerOnly: true,
    confirmationPhrase: 'REPAIR TERMINAL',
    changesSystem: true,
  },
  fileManager: {
    feature: 'fileManager',
    ownerOnly: true,
    confirmationPhrase: 'REPAIR FILE MANAGER',
    changesSystem: true,
  },
  agentTools: {
    feature: 'agentTools',
    ownerOnly: true,
    confirmationPhrase: 'VERIFY AGENT TOOLS',
    changesSystem: false,
  },
  projectRuntimeImage: {
    feature: 'projectRuntimeImage',
    ownerOnly: true,
    confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
    changesSystem: true,
  },
};

const router = Router();
router.use(authenticateToken);
router.use(requireAdmin);
router.use(requireOwner);

export function getSystemRemediationContract(feature: string): SystemRemediationContract | null {
  return SYSTEM_REMEDIATION_CONTRACTS[feature as SystemRemediationContract['feature']] || null;
}

export function systemRemediationCanRun(role: string | null | undefined): boolean {
  return isOwnerRole(role);
}

export function systemRemediationConfirmationValid(
  contract: Pick<SystemRemediationContract, 'confirmationPhrase'>,
  confirmation: unknown,
): boolean {
  return isTypedConfirmationMatch(contract.confirmationPhrase, confirmation);
}

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

  const projectsDir = path.resolve(
    process.env.PORTAL_PROJECTS_ROOT
      || path.join(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal', 'projects'),
  );
  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    steps.push({ step: 'Ensure projects directory', ok: true, message: `Exists: ${projectsDir}` });
  } catch (error: any) {
    steps.push({
      step: 'Ensure projects directory',
      ok: false,
      message: error?.message || `Failed to create ${projectsDir}`,
    });
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

const PROJECT_RUNTIME_IMAGE_PENDING_AUDIT_RESULTS = new Set([
  'requested',
  'started',
  'already-running',
]);

async function reconcileProjectRuntimeImageRepairAudit(
  status: Awaited<ReturnType<typeof getProjectRuntimeImageRepairStatus>>,
): Promise<void> {
  const imageIsAuthoritativelyMissing = status.state === 'unavailable'
    && status.unavailableReason === 'image-missing';
  if (status.state !== 'ready' && status.state !== 'failed' && !imageIsAuthoritativelyMissing) return;
  const result = status.state === 'ready' ? 'succeeded' : 'failed';
  const completedAt = new Date().toISOString();
  for (const admissionResult of PROJECT_RUNTIME_IMAGE_PENDING_AUDIT_RESULTS) {
    // JSON-path predicates make this a database-side compare-and-set across
    // every pending request. A concurrent terminal writer no longer matches,
    // and duplicate Owner requests cannot strand older rows behind a page cap.
    await prisma.activityLog.updateMany({
      where: {
        action: 'PROJECT_RUNTIME_IMAGE_REPAIR_REQUESTED',
        resource: 'system-remediation',
        resourceId: 'projectRuntimeImage',
        AND: [
          { metadata: { path: ['feature'], equals: 'projectRuntimeImage' } },
          { metadata: { path: ['result'], equals: admissionResult } },
        ],
      },
      data: {
        severity: result === 'succeeded' ? 'INFO' : 'ERROR',
        metadata: {
          feature: 'projectRuntimeImage',
          admissionResult,
          result,
          terminalState: status.state,
          ...(imageIsAuthoritativelyMissing ? { terminalReason: 'image-missing' } : {}),
          completedAt,
        },
      },
    });
  }
}

async function countPendingProjectRuntimeImageRepairAudits(): Promise<number> {
  return prisma.activityLog.count({
    where: {
      action: 'PROJECT_RUNTIME_IMAGE_REPAIR_REQUESTED',
      resource: 'system-remediation',
      resourceId: 'projectRuntimeImage',
      AND: [
        { metadata: { path: ['feature'], equals: 'projectRuntimeImage' } },
        {
          OR: [...PROJECT_RUNTIME_IMAGE_PENDING_AUDIT_RESULTS].map((result) => ({
            metadata: { path: ['result'], equals: result },
          })),
        },
      ],
    },
  });
}

let projectRuntimeImageRepairLane = Promise.resolve();

async function withProjectRuntimeImageRepairLane<T>(operation: () => Promise<T>): Promise<T> {
  const previous = projectRuntimeImageRepairLane;
  let release!: () => void;
  projectRuntimeImageRepairLane = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

router.get('/projectRuntimeImage/status', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const status = await withProjectRuntimeImageRepairLane(async () => {
      const current = await getProjectRuntimeImageRepairStatus();
      await reconcileProjectRuntimeImageRepairAudit(current).catch((auditError) => {
        console.warn('[System Remediation] Project runtime image terminal audit reconciliation failed:',
          auditError instanceof Error ? auditError.message : 'unknown audit error');
      });
      return current;
    });
    res.json(status);
  } catch {
    res.status(503).json({
      state: 'unavailable',
      confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
  }
});

router.post('/:feature/auto-setup', async (req: Request, res: Response) => {
  try {
    const feature = String(req.params.feature || '').trim();
    const contract = getSystemRemediationContract(feature);
    if (!contract) {
      res.status(400).json({ ok: false, message: `Auto-setup not implemented for feature: ${feature}`, steps: [] });
      return;
    }
    if (!systemRemediationConfirmationValid(contract, req.body?.confirmation)) {
      res.status(400).json({
        ok: false,
        error: `Type ${contract.confirmationPhrase} to confirm this owner-only remediation.`,
        message: 'Typed confirmation is required.',
        confirmationPhrase: contract.confirmationPhrase,
        steps: [],
      });
      return;
    }

    if (feature === 'terminal') {
      res.json({ ...await remediateTerminal(), contract });
      return;
    }

    if (feature === 'fileManager') {
      res.json({ ...await remediateFileManager(), contract });
      return;
    }

    if (feature === 'agentTools') {
      res.json({ ...await remediateAgentTools(), contract });
      return;
    }

    if (feature === 'projectRuntimeImage') {
      await withProjectRuntimeImageRepairLane(async () => {
      // Establish one unresolved fixed-unit generation at a time. Explicit
      // ready/failed state settles the previous generation before a new one
      // can be admitted. An unavailable lane with a pending audit is
      // intentionally fail-closed: without authoritative unit state, a retry
      // could make an older failure look like the newer attempt's success.
      let preflight: Awaited<ReturnType<typeof getProjectRuntimeImageRepairStatus>>;
      try {
        preflight = await getProjectRuntimeImageRepairStatus();
        await reconcileProjectRuntimeImageRepairAudit(preflight);
        if (
          preflight.state === 'unavailable'
          && await countPendingProjectRuntimeImageRepairAudits() > 0
        ) {
          res.status(409).json({
            ok: false,
            code: 'PROJECT_RUNTIME_IMAGE_REPAIR_AUDIT_INDETERMINATE',
            message: 'Portal cannot verify the outcome of the previous runtime image repair. Review server maintenance before starting another repair.',
            steps: [],
          });
          return;
        }
        if (
          preflight.state === 'unavailable'
          && preflight.unavailableReason !== 'image-missing'
        ) {
          res.status(409).json({
            ok: false,
            code: 'PROJECT_RUNTIME_IMAGE_REPAIR_STATE_UNAVAILABLE',
            message: 'Portal cannot safely verify Docker or repair-service state. Review server maintenance before starting a repair.',
            steps: [],
          });
          return;
        }
      } catch {
        res.status(503).json({
          ok: false,
          code: 'PROJECT_RUNTIME_IMAGE_REPAIR_AUDIT_UNAVAILABLE',
          message: 'Portal could not reconcile the previous Owner repair audit, so no host repair was started.',
          steps: [],
        });
        return;
      }
      // Audit admission before launching the root-scoped transient unit. If
      // the durable audit store is unavailable, fail closed without starting
      // a host mutation. A post-launch audit update is best-effort: the
      // original attributable request row remains even if that update fails.
      const audit = await (async () => {
        try {
          return await prisma.activityLog.create({
            data: {
              userId: req.user!.userId,
              action: 'PROJECT_RUNTIME_IMAGE_REPAIR_REQUESTED',
              resource: 'system-remediation',
              resourceId: 'projectRuntimeImage',
              severity: 'WARNING',
              metadata: {
                feature: 'projectRuntimeImage',
                result: 'requested',
              },
            },
          });
        } catch {
          return null;
        }
      })();
      if (!audit) {
        res.status(503).json({
          ok: false,
          code: 'PROJECT_RUNTIME_IMAGE_REPAIR_AUDIT_UNAVAILABLE',
          message: 'Portal could not record the Owner repair request, so no host repair was started.',
          steps: [],
        });
        return;
      }
      let repair: Awaited<ReturnType<typeof launchProjectRuntimeImageRepair>>;
      try {
        repair = await launchProjectRuntimeImageRepair({
          allowFailedRetry: preflight.state === 'failed',
        });
      } catch (error) {
        if (
          error instanceof ProjectRuntimeImageRepairLaunchError
          && error.code === 'PROJECT_RUNTIME_IMAGE_REPAIR_LAUNCH_FAILED'
        ) {
          await prisma.activityLog.update({
            where: { id: audit.id },
            data: {
              severity: 'ERROR',
              metadata: {
                feature: 'projectRuntimeImage',
                admissionResult: 'requested',
                result: 'launch-failed',
                terminalState: 'launch-failed',
                completedAt: new Date().toISOString(),
              },
            },
          }).catch(() => undefined);
        }
        throw error;
      }
      const auditResult = repair.state === 'ready'
        ? 'succeeded'
        : repair.started
          ? 'started'
          : 'already-running';
      await prisma.activityLog.update({
        where: { id: audit.id },
        data: {
          ...(repair.state === 'ready' ? { severity: 'INFO' as const } : {}),
          metadata: {
            feature: 'projectRuntimeImage',
            ...(repair.state === 'ready' ? {
              admissionResult: repair.started ? 'started' : 'requested',
              terminalState: 'ready',
              completedAt: new Date().toISOString(),
            } : {}),
            result: auditResult,
          },
        },
      }).catch((auditError) => {
        console.warn('[System Remediation] Project runtime image result audit update failed:',
          auditError instanceof Error ? auditError.message : 'unknown audit error');
      });
      res.status(repair.state === 'ready' ? 200 : 202).json({
        ok: true,
        ...repair,
        contract,
      });
      return;
      });
      return;
    }
  } catch (error: any) {
    if (error instanceof ProjectRuntimeImageRepairLaunchError) {
      res.status(error.statusCode).json({ ok: false, message: error.message, code: error.code, steps: [] });
      return;
    }
    res.status(500).json({ ok: false, message: error?.message || 'Feature remediation failed', steps: [] });
  }
});

export default router;
