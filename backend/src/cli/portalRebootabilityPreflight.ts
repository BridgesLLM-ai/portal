import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadProtectedEnvironmentFile } from './projectRuntimeUninstallPreflight';
import type { AppApiTargetBindingAuditResult } from '../services/appApiTargetBindingAudit';
import type { LegacyProjectContinuityReadinessAudit } from '../services/legacyProjectContinuityAdoption';

export interface PortalRebootabilityDependencies {
  preflightDependencyContainment(): Promise<{ repairs: number; projects: number; pins: number }>;
  preflightApps(strict: boolean): Promise<{ apps: readonly unknown[] }>;
  preflightContinuity(): Promise<LegacyProjectContinuityReadinessAudit>;
  preflightBindings(): Promise<AppApiTargetBindingAuditResult>;
  disconnect(): Promise<void>;
}

export interface PortalRebootabilityIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

function readStableOwnedPrivateFile(file: string, maximumBytes: number): Buffer {
  const expectedUid = BigInt(typeof process.getuid === 'function' ? process.getuid() : 0);
  const expectedGid = BigInt(typeof process.getgid === 'function' ? process.getgid() : 0);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.uid !== expectedUid || before.gid !== expectedGid
    || (before.mode & 0o777n) !== 0o600n
    || before.size <= 0n || before.size > BigInt(maximumBytes)) {
    throw new Error('unsafe private file');
  }
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeNs !== before.mtimeNs
    || after.nlink !== before.nlink || after.uid !== before.uid
    || after.gid !== before.gid || after.mode !== before.mode) {
    throw new Error('private file changed');
  }
  return bytes;
}

function attestPreflightBackupPin(file: any, marker: any): {
  receiptDigest: string;
  markerDigest: string;
} {
  const expectedUid = BigInt(typeof process.getuid === 'function' ? process.getuid() : 0);
  const expectedGid = BigInt(typeof process.getgid === 'function' ? process.getgid() : 0);
  const archive = fs.lstatSync(file.fullPath, { bigint: true });
  if (!archive.isFile() || archive.isSymbolicLink() || archive.nlink !== 1n
    || archive.uid !== expectedUid || archive.gid !== expectedGid
    || (archive.mode & 0o022n) !== 0n
    || archive.dev.toString() !== file.dev || archive.ino.toString() !== file.ino
    || archive.size !== BigInt(file.size) || archive.mtimeNs.toString() !== file.mtimeNs) {
    throw new Error('backup changed');
  }
  const receipt = readStableOwnedPrivateFile(`${file.fullPath}.receipt.json`, 16_384);
  const markerBytes = readStableOwnedPrivateFile(`${file.fullPath}.locked`, 16_384);
  const after = fs.lstatSync(file.fullPath, { bigint: true });
  if (after.dev !== archive.dev || after.ino !== archive.ino
    || after.size !== archive.size || after.mtimeNs !== archive.mtimeNs
    || after.nlink !== archive.nlink) throw new Error('backup changed');
  const receiptDigest = crypto.createHash('sha256').update(receipt).digest('hex');
  const fingerprintDigest = crypto.createHash('sha256').update(JSON.stringify({
    path: file.fullPath,
    filename: file.filename,
    device: file.dev,
    inode: file.ino,
    size: String(file.size),
    mtimeNs: file.mtimeNs,
    receiptDigest,
  }), 'utf8').digest('hex');
  if (fingerprintDigest !== marker.backupFingerprintDigest) {
    throw new Error('backup fingerprint changed');
  }
  return {
    receiptDigest,
    markerDigest: crypto.createHash('sha256').update(markerBytes).digest('hex'),
  };
}

function repairEvidenceAbsent(ownerRoot: string, repairId: string): boolean {
  const basename = `.bridgesllm-project-repair-${repairId}`;
  if (fs.existsSync(path.join(ownerRoot, basename))
    || fs.existsSync(path.join(ownerRoot, `${basename}.journal.json`))) return false;
  try {
    return !fs.readdirSync(ownerRoot).some((entry) => (
      entry.startsWith(`${basename}.journal.json.`) && entry.endsWith('.tmp')
    ));
  } catch {
    return false;
  }
}

function resemblesRepairOwnedBackupPin(file: any): boolean {
  if (file.locked !== true) return false;
  try {
    const bytes = readStableOwnedPrivateFile(`${file.fullPath}.locked`, 16_384);
    return bytes.includes(Buffer.from('bridgesllm.project-dependency-repair-backup-pin', 'utf8'));
  } catch {
    // An unsafe/unstable lock cannot be attributed to repair ownership. A DB
    // lookup below still catches every admitted repair whose marker was
    // replaced; ordinary user backup locks intentionally remain nonblocking.
    return false;
  }
}

export async function preflightDependencyContainmentReadOnly(input: {
  database: any;
  backup: any;
}): Promise<{ repairs: number; projects: number; pins: number }> {
  const rows = await input.database.prisma.$queryRaw<Array<{
    repairs: bigint;
    projects: bigint;
  }>>`
    SELECT 0::bigint AS "repairs",
      COUNT(*) FILTER (
        WHERE "lifecycleStatus" IN ('DEPENDENCY_PROMOTING', 'DEPENDENCY_QUARANTINED')
      )::bigint AS "projects"
    FROM "ProjectIdentity"
  `;
  const relation = await input.database.prisma.$queryRaw<Array<{ relation: string | null }>>`
    SELECT to_regclass('"ProjectDependencyRepairOperation"')::text AS "relation"
  `;
  let repairs = Number(rows[0]?.repairs || 0n);
  if (relation[0]?.relation) {
    const repairRows = await input.database.prisma.$queryRaw<Array<{ repairs: bigint }>>`
      SELECT COUNT(*)::bigint AS "repairs"
      FROM "ProjectDependencyRepairOperation"
      WHERE "status" <> 'APPLIED' OR "phase" <> 'COMPLETE'
    `;
    repairs = Number(repairRows[0]?.repairs || 0n);
  }
  const totalProjects = Number(rows[0]?.projects || 0n);
  const safeMarkerOnlyProjectIds = new Set<string>();
  const backupSetting = await input.database.prisma.systemSetting.findUnique({
    where: { key: 'system.backupPath' },
    select: { value: true },
  });
  const backupRoot = input.backup.getConfiguredBackupRootReadOnly(backupSetting?.value);
  const files = input.backup.listBackupFiles(backupRoot, { readOnly: true });
  if (files.length > 10_000) throw new Error('BACKUP_INVENTORY_LIMIT_EXCEEDED');
  let pins = 0;
  for (const file of files) {
    const marker = input.backup.readRepairOwnedBackupLockMarker(file);
    if (!marker) {
      if (resemblesRepairOwnedBackupPin(file)) {
        pins += 1;
      } else if (relation[0]?.relation) {
        const bound = await input.database.prisma.$queryRaw<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM "ProjectDependencyRepairOperation"
            WHERE "backupPath" = ${file.fullPath}
              AND "backupDevice" = ${file.dev}
              AND "backupInode" = ${file.ino}
              AND "backupSize" = ${BigInt(file.size)}
              AND "backupMtimeNs" = ${file.mtimeNs}
              AND "backupLockOwned" = TRUE
          ) AS "exists"
        `;
        if (bound[0]?.exists === true) pins += 1;
      }
      continue;
    }
    if (!relation[0]?.relation) {
      pins += 1;
      continue;
    }
    try {
      const fingerprint = attestPreflightBackupPin(file, marker);
      const repairRows = await input.database.prisma.$queryRaw<any[]>`
        SELECT repair.*, identity."lifecycleStatus", identity."dependencyQuarantinedAt",
          identity."canonicalRoot" AS "identityCanonicalRoot",
          EXISTS (
            SELECT 1 FROM "ProjectDependencyPromotionDecision" decision
            WHERE decision."operationId" = repair."promotionOperationId"
          ) AS "decisionExists"
        FROM "ProjectDependencyRepairOperation" repair
        JOIN "ProjectIdentity" identity ON identity."id" = repair."projectIdentityId"
        WHERE repair."repairId" = ${marker.repairId}::uuid
      `;
      const row = repairRows[0];
      if (row) {
        const ownerRoot = path.dirname(String(row.identityCanonicalRoot));
        const basename = `.bridgesllm-project-repair-${marker.repairId}`;
        const safelyRetirable = row.status === 'APPLIED' && row.phase === 'COMPLETE'
          && String(row.projectIdentityId) === marker.projectIdentityId
          && Number(row.projectIdentityGeneration) === marker.projectIdentityGeneration
          && String(row.workspaceOwnerId) === marker.workspaceOwnerId
          && String(row.projectName) === marker.projectName
          && path.basename(String(row.identityCanonicalRoot)) === marker.projectName
          && String(row.promotionOperationId) === marker.promotionOperationId
          && String(row.manifestDigest) === marker.manifestDigest
          && String(row.backupFingerprintDigest) === marker.backupFingerprintDigest
          && row.backupLockOwned === true
          && String(row.backupLockMarkerPath) === `${file.fullPath}.locked`
          && String(row.backupLockMarkerDigest) === fingerprint.markerDigest
          && String(row.backupPath) === file.fullPath
          && String(row.backupFilename) === file.filename
          && String(row.backupDevice) === file.dev
          && String(row.backupInode) === file.ino
          && BigInt(row.backupSize) === BigInt(file.size)
          && String(row.backupMtimeNs) === file.mtimeNs
          && String(row.backupReceiptDigest) === fingerprint.receiptDigest
          && String(row.repairJournalCanonicalPath) === path.join(ownerRoot, `${basename}.journal.json`)
          && String(row.displacementCanonicalRoot) === path.join(ownerRoot, basename)
          && row.lifecycleStatus === 'ACTIVE'
          && row.dependencyQuarantinedAt === null
          && row.decisionExists === false
          && repairEvidenceAbsent(ownerRoot, marker.repairId);
        if (!safelyRetirable) pins += 1;
        continue;
      }

      const markerOnlyRows = await input.database.prisma.$queryRaw<any[]>`
        SELECT identity."id" AS "projectIdentityId",
          identity."workspaceOwnerId", identity."projectName", identity."generation",
          identity."canonicalRoot", identity."lifecycleStatus", identity."dependencyQuarantinedAt",
          decision."operationId", decision."manifestDigest", decision."status" AS "decisionStatus",
          decision."projectIdentityId" AS "decisionProjectIdentityId",
          decision."projectIdentityGeneration", decision."workspaceOwnerId" AS "decisionWorkspaceOwnerId",
          decision."projectName" AS "decisionProjectName",
          decision."operationParentCanonicalRoot", decision."operationParentDevice",
          decision."operationParentInode", decision."operationParentBirthtimeNs",
          decision."operationParentMode", decision."operationParentUid", decision."operationParentGid"
        FROM "ProjectIdentity" identity
        JOIN "ProjectDependencyPromotionDecision" decision
          ON decision."projectIdentityId" = identity."id"
        WHERE identity."id" = ${marker.projectIdentityId}
          AND decision."operationId" = ${marker.promotionOperationId}::uuid
          AND decision."manifestDigest" = ${marker.manifestDigest}
      `;
      const exact = markerOnlyRows[0];
      const ownerRoot = exact ? path.dirname(String(exact.canonicalRoot)) : '';
      const ownerStat = exact ? fs.lstatSync(ownerRoot, { bigint: true }) : null;
      const safelyRetirable = exact
        && exact.decisionStatus === 'AUTHORIZED'
        && exact.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
        && exact.dependencyQuarantinedAt !== null
        && String(exact.projectIdentityId) === marker.projectIdentityId
        && String(exact.decisionProjectIdentityId) === marker.projectIdentityId
        && Number(exact.generation) === marker.projectIdentityGeneration
        && Number(exact.projectIdentityGeneration) === marker.projectIdentityGeneration
        && String(exact.workspaceOwnerId) === marker.workspaceOwnerId
        && String(exact.decisionWorkspaceOwnerId) === marker.workspaceOwnerId
        && String(exact.projectName) === marker.projectName
        && String(exact.decisionProjectName) === marker.projectName
        && path.basename(String(exact.canonicalRoot)) === marker.projectName
        && String(exact.operationId) === marker.promotionOperationId
        && String(exact.manifestDigest) === marker.manifestDigest
        && String(exact.operationParentCanonicalRoot) === ownerRoot
        && ownerStat?.isDirectory() && !ownerStat.isSymbolicLink()
        && fs.realpathSync.native(ownerRoot) === ownerRoot
        && ownerStat.dev.toString() === String(exact.operationParentDevice)
        && ownerStat.ino.toString() === String(exact.operationParentInode)
        && ownerStat.birthtimeNs.toString() === String(exact.operationParentBirthtimeNs)
        && Number(ownerStat.mode & 0o777n) === Number(exact.operationParentMode)
        && Number(ownerStat.uid) === Number(exact.operationParentUid)
        && Number(ownerStat.gid) === Number(exact.operationParentGid)
        && repairEvidenceAbsent(ownerRoot, marker.repairId);
      if (safelyRetirable) safeMarkerOnlyProjectIds.add(marker.projectIdentityId);
      else pins += 1;
    } catch {
      pins += 1;
    }
  }
  const projects = Math.max(0, totalProjects - safeMarkerOnlyProjectIds.size);
  if (repairs > 0 || projects > 0 || pins > 0) {
    throw new Error('PROJECT_DEPENDENCY_CONTAINMENT_ACTIVE');
  }
  return { repairs, projects, pins };
}

async function loadDefaultDependencies(): Promise<PortalRebootabilityDependencies> {
  const [appProcessModule, continuityModule, bindingAuditModule, databaseModule, backupModule] = await Promise.all([
    import('../services/app-process.service'),
    import('../services/legacyProjectContinuityAdoption'),
    import('../services/appApiTargetBindingAudit'),
    import('../config/database'),
    import('../services/backup.service'),
  ]);
  return {
    preflightDependencyContainment: () => preflightDependencyContainmentReadOnly({
      database: databaseModule,
      backup: backupModule,
    }),
    preflightApps: (strict) => appProcessModule.preflightAppProcessRuntimeRestoration({
      rejectUnsafeRunningApps: strict,
    }),
    preflightContinuity: () => continuityModule.auditLegacyProjectContinuityReadiness(),
    preflightBindings: async () => {
      const apps = await databaseModule.prisma.app.findMany({
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
        take: 10_001,
      });
      if (apps.length > 10_000) throw new Error('APP_API_TARGET_AUDIT_LIMIT_EXCEEDED');
      return bindingAuditModule.auditAppApiTargetBindings(apps, process.env);
    },
    disconnect: () => databaseModule.prisma.$disconnect(),
  };
}

function boundedDiagnosticToken(value: string, maxLength = 180): string {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.:-]/g, '?')
    .slice(0, maxLength) || 'unknown';
}

function reportBindingAudit(
  audit: AppApiTargetBindingAuditResult,
  io: PortalRebootabilityIo,
): boolean {
  const diagnosticLimit = 20;
  for (const warning of audit.warnings.slice(0, diagnosticLimit)) {
    io.stderr.write(
      'Portal rebootability warning: obsolete App API target key '
        + `${boundedDiagnosticToken(warning.obsoleteNameKey)} exists for App `
        + `${boundedDiagnosticToken(warning.appId)}; `
        + `${boundedDiagnosticToken(warning.requiredIdKey)} is authoritative. `
        + 'Remove the obsolete key after verifying the explicit id-keyed binding; no value was copied or inferred.\n',
    );
  }
  if (audit.warnings.length > diagnosticLimit) {
    io.stderr.write(
      `Portal rebootability warning: ${audit.warnings.length - diagnosticLimit} additional obsolete App API target keys were omitted from bounded output.\n`,
    );
  }

  for (const blocker of audit.blockers.slice(0, diagnosticLimit)) {
    if (blocker.kind === 'missing-id-binding') {
      io.stderr.write(
        'Portal rebootability blocked: required App API target key '
          + `${boundedDiagnosticToken(blocker.requiredIdKey)} is missing for App `
          + `${boundedDiagnosticToken(blocker.appId)} while obsolete key `
          + `${boundedDiagnosticToken(blocker.obsoleteNameKey)} exists. `
          + 'Set the intended loopback target explicitly under the id-keyed name, then remove the obsolete key; the installer did not copy or infer a value.\n',
      );
    } else {
      io.stderr.write(
        'Portal rebootability blocked: App API target key '
          + `${boundedDiagnosticToken(blocker.requiredIdKey)} is invalid for App `
          + `${boundedDiagnosticToken(blocker.appId)}. `
          + 'Set an explicit loopback HTTP target or remove the key; its value was not printed.\n',
      );
    }
  }
  if (audit.blockers.length > diagnosticLimit) {
    io.stderr.write(
      `Portal rebootability blocked: ${audit.blockers.length - diagnosticLimit} additional App API target failures were omitted from bounded output.\n`,
    );
  }
  if (audit.blockers.length > 0) {
    io.stderr.write('Portal rebootability preflight failed: APP_API_TARGET_BINDING_MIGRATION_REQUIRED\n');
    return false;
  }
  return true;
}

function parseArguments(args: readonly string[]): { envFile: string; planFile?: string } {
  if (
    (args.length !== 2 && args.length !== 4)
    || args[0] !== '--env-file'
    || !path.isAbsolute(args[1] || '')
    || (args.length === 4 && (args[2] !== '--plan-file' || !path.isAbsolute(args[3] || '')))
  ) {
    throw new Error('INVALID_ARGUMENTS');
  }
  return {
    envFile: path.resolve(args[1]),
    ...(args.length === 4 ? { planFile: path.resolve(args[3]) } : {}),
  };
}

function writeProtectedRepairPlan(planFile: string, audit: LegacyProjectContinuityReadinessAudit): void {
  const parent = path.dirname(planFile);
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink()
    || !parentStat.isDirectory()
    || parentStat.uid !== 0
    || (parentStat.mode & 0o022) !== 0
    || fs.realpathSync.native(parent) !== parent
  ) {
    throw new Error('REPAIR_PLAN_PATH_UNSAFE');
  }
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      planFile,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      repairPlanToken: audit.repairPlanToken,
      repairableStaleLinkedApps: audit.repairableStaleLinkedApps,
    })}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)) throw error;
    throw new Error('REPAIR_PLAN_WRITE_FAILED');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
  const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
}

/**
 * Execute only the read half of startup reconciliation. No App status,
 * container, filesystem, migration, or service mutation is authorized here.
 */
export async function portalRebootabilityPreflightMain(
  args: readonly string[] = process.argv.slice(2),
  io: PortalRebootabilityIo = { stdout: process.stdout, stderr: process.stderr },
  hooks: {
    getUid?: () => number;
    loadEnvironment?: (envFile: string) => void;
    loadDependencies?: () => Promise<PortalRebootabilityDependencies>;
    writePlan?: (planFile: string, audit: LegacyProjectContinuityReadinessAudit) => void;
  } = {},
): Promise<number> {
  let dependencies: PortalRebootabilityDependencies | null = null;
  try {
    if ((hooks.getUid || (() => process.getuid?.() ?? -1))() !== 0) {
      throw new Error('ROOT_REQUIRED');
    }
    const { envFile, planFile } = parseArguments(args);
    (hooks.loadEnvironment || loadProtectedEnvironmentFile)(envFile);
    dependencies = await (hooks.loadDependencies || loadDefaultDependencies)();
    const containment = await dependencies.preflightDependencyContainment();
    const continuity = await dependencies.preflightContinuity();
    const bindingAudit = await dependencies.preflightBindings();
    if (!reportBindingAudit(bindingAudit, io)) return 1;
    // The first pass seals the exact continuity repair plan while the old
    // Portal is live. Defer strict App-startup rejection until the installer
    // applies that plan and reruns this command without --plan-file; otherwise
    // an exactly repairable stale running App could make its own repair
    // unreachable.
    const result = await dependencies.preflightApps(!planFile);
    if (planFile) (hooks.writePlan || writeProtectedRepairPlan)(planFile, continuity);
    io.stdout.write(
      `Portal rebootability preflight complete: full-stack-apps=${result.apps.length}`
        + ` linked-apps=${continuity.linkedApps}`
        + ` repairable-stale-links=${continuity.repairableStaleLinkedApps}`
        + ` app-api-bindings=${bindingAudit.checkedApps}`
        + ` dependency-containment=${containment.repairs + containment.projects + containment.pins}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)
      ? error.message
      : 'STARTUP_STATE_REJECTED';
    io.stderr.write(`Portal rebootability preflight failed: ${code}\n`);
    return 1;
  } finally {
    if (dependencies) {
      try {
        await dependencies.disconnect();
      } catch {
        // The read-only process is exiting. Do not replace the authoritative
        // startup result with an unhelpful disconnect exception.
      }
    }
  }
}

if (require.main === module) {
  void portalRebootabilityPreflightMain().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write('Portal rebootability preflight failed: PREFLIGHT_FAILED\n');
    process.exitCode = 1;
  });
}
