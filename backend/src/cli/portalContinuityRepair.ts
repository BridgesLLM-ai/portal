import fs from 'fs';
import path from 'path';
import { loadProtectedEnvironmentFile } from './projectRuntimeUninstallPreflight';

interface PortalContinuityRepairDependencies {
  repair(expectedPlanToken: string): Promise<{ appsQuarantined: number }>;
  disconnect(): Promise<void>;
}

interface PortalContinuityRepairIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

async function loadDefaultDependencies(): Promise<PortalContinuityRepairDependencies> {
  const [continuityModule, databaseModule] = await Promise.all([
    import('../services/legacyProjectContinuityAdoption'),
    import('../config/database'),
  ]);
  return {
    repair: (expectedPlanToken) => continuityModule.repairLegacyProjectContinuityLinks({
      expectedPlanToken,
    }),
    disconnect: () => databaseModule.prisma.$disconnect(),
  };
}

function parseArguments(args: readonly string[]): { envFile: string; planFile: string } {
  if (
    args.length !== 4
    || args[0] !== '--env-file'
    || !path.isAbsolute(args[1] || '')
    || args[2] !== '--plan-file'
    || !path.isAbsolute(args[3] || '')
  ) throw new Error('INVALID_ARGUMENTS');
  return { envFile: path.resolve(args[1]), planFile: path.resolve(args[3]) };
}

function readProtectedRepairPlan(planFile: string): string {
  let descriptor = -1;
  try {
    const lstat = fs.lstatSync(planFile);
    if (lstat.isSymbolicLink() || !lstat.isFile() || fs.realpathSync.native(planFile) !== planFile) {
      throw new Error('REPAIR_PLAN_UNSAFE');
    }
    descriptor = fs.openSync(planFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.uid !== 0
      || (stat.mode & 0o077) !== 0
      || stat.size < 1
      || stat.size > 4_096
    ) throw new Error('REPAIR_PLAN_UNSAFE');
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
    const token = String(parsed.repairPlanToken || '');
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.repairableStaleLinkedApps)
      || Number(parsed.repairableStaleLinkedApps) < 0
      || !/^[a-f0-9]{64}$/.test(token)
    ) throw new Error('REPAIR_PLAN_INVALID');
    return token;
  } catch (error) {
    if (error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)) throw error;
    throw new Error('REPAIR_PLAN_UNAVAILABLE');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

export async function portalContinuityRepairMain(
  args: readonly string[] = process.argv.slice(2),
  io: PortalContinuityRepairIo = { stdout: process.stdout, stderr: process.stderr },
  hooks: {
    getUid?: () => number;
    loadEnvironment?: (envFile: string) => void;
    readPlan?: (planFile: string) => string;
    loadDependencies?: () => Promise<PortalContinuityRepairDependencies>;
  } = {},
): Promise<number> {
  let dependencies: PortalContinuityRepairDependencies | null = null;
  try {
    if ((hooks.getUid || (() => process.getuid?.() ?? -1))() !== 0) throw new Error('ROOT_REQUIRED');
    const { envFile, planFile } = parseArguments(args);
    (hooks.loadEnvironment || loadProtectedEnvironmentFile)(envFile);
    const expectedPlanToken = (hooks.readPlan || readProtectedRepairPlan)(planFile);
    dependencies = await (hooks.loadDependencies || loadDefaultDependencies)();
    const result = await dependencies.repair(expectedPlanToken);
    io.stdout.write(
      `Portal continuity repair complete: quarantined-app-links=${result.appsQuarantined}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)
      ? error.message
      : 'CONTINUITY_REPAIR_REJECTED';
    io.stderr.write(`Portal continuity repair failed: ${code}\n`);
    return 1;
  } finally {
    if (dependencies) {
      try {
        await dependencies.disconnect();
      } catch {
        // Preserve the authoritative repair result while this one-shot exits.
      }
    }
  }
}

if (require.main === module) {
  void portalContinuityRepairMain().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write('Portal continuity repair failed: CONTINUITY_REPAIR_FAILED\n');
    process.exitCode = 1;
  });
}
