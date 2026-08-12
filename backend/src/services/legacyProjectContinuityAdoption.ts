import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import {
  attestProjectRoot,
  ensureProjectIdentity,
  isInternalProjectDirectoryName,
  readProjectIdentityRenameDeployIdentity,
  PROJECT_IDENTITY_RECORD_SELECT,
  type AttestedProjectRoot,
  type ProjectIdentityDatabase,
  type ProjectIdentityRecord,
} from './projectIdentity';
import {
  projectRuntimeManagement,
  type ProjectRuntimeManagement,
} from './projectRuntimeManagement';

const MAX_CONTINUITY_PROJECTS = 2_048;
const MAX_CONTINUITY_APPS = 100_000;

type ContinuityApp = Readonly<{
  id: string;
  userId: string;
  projectIdentityId: string | null;
  name: string;
  zipPath: string;
  deployType: string;
  processStatus: string;
}>;

interface ContinuityStore extends ProjectIdentityDatabase {
  user: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
  };
  app: {
    findMany(args: unknown): Promise<ContinuityApp[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

interface ContinuityDatabase extends ContinuityStore {
  $transaction<T>(
    callback: (transaction: ContinuityStore) => Promise<T>,
    options?: { isolationLevel?: 'Serializable'; maxWait?: number; timeout?: number },
  ): Promise<T>;
}

type ContinuityProject = Readonly<{
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
  identity: ProjectIdentityRecord;
}>;

type AppBackfillCandidate = Readonly<{
  app: ContinuityApp;
  project: ContinuityProject;
  deploymentIdentity: AttestedProjectRoot;
}>;

type StaleLinkedAppCandidate = Readonly<{
  app: ContinuityApp;
  identity: ProjectIdentityRecord | null;
  identityTopologySnapshot: string;
}>;

type RepairableStaleLinkedAppCandidate = Readonly<{
  app: ContinuityApp;
  identity: ProjectIdentityRecord | null;
  identityTopologySnapshot: string;
  runtimeManagement: ProjectRuntimeManagement;
}>;

export interface LegacyProjectContinuityReadinessAudit {
  linkedApps: number;
  staleLinkedApps: number;
  repairableStaleLinkedApps: number;
  repairPlanToken: string;
}

export class LegacyProjectContinuityAdoptionError extends Error {
  readonly code = 'LEGACY_PROJECT_CONTINUITY_INTEGRITY';

  constructor(message: string) {
    super(message);
    this.name = 'LegacyProjectContinuityAdoptionError';
  }
}

function continuityFailure(message: string): never {
  throw new LegacyProjectContinuityAdoptionError(message);
}

function continuityRoots(options: {
  projectsRoot?: string;
  deployRoot?: string;
  legacyDeployRoot?: string;
}): {
  projectsRoot: string;
  configuredDeploymentRoots: readonly Readonly<{
    root: string;
    required: boolean;
  }>[];
} {
  const portalRoot = path.resolve(
    process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal',
  );
  const currentDeployRoot = path.resolve(
    options.deployRoot || process.env.APPS_ROOT || '/var/www/bridgesllm-apps',
  );
  const legacyDeployRoot = path.resolve(
    options.legacyDeployRoot
      || process.env.LEGACY_APP_FILES_DIR
      || '/var/www/bridgesllm-apps',
  );
  const configuredDeploymentRoots = [
    Object.freeze({ root: currentDeployRoot, required: true }),
    ...(legacyDeployRoot === currentDeployRoot
      ? []
      : [Object.freeze({ root: legacyDeployRoot, required: false })]),
  ];
  return {
    projectsRoot: path.resolve(
      options.projectsRoot || process.env.PORTAL_PROJECTS_ROOT || path.join(portalRoot, 'projects'),
    ),
    configuredDeploymentRoots: Object.freeze(configuredDeploymentRoots),
  };
}

function sameDirectoryIdentity(left: AttestedProjectRoot, right: AttestedProjectRoot): boolean {
  return left.canonicalRoot === right.canonicalRoot
    && left.rootDevice === right.rootDevice
    && left.rootInode === right.rootInode
    && left.rootBirthtimeNs === right.rootBirthtimeNs;
}

function attestExactDirectory(directory: string, label: string): AttestedProjectRoot {
  const normalized = path.resolve(directory);
  if (normalized !== directory || directory.includes('\0')) {
    continuityFailure(`${label} was not a normalized absolute directory.`);
  }
  let identity: AttestedProjectRoot;
  try {
    identity = attestProjectRoot(directory);
  } catch {
    continuityFailure(`${label} was not an attested real directory.`);
  }
  if (identity!.canonicalRoot !== directory) {
    continuityFailure(`${label} resolved through a symbolic link.`);
  }
  return identity!;
}

function projectKey(workspaceOwnerId: string, projectName: string): string {
  return `${workspaceOwnerId}\0${projectName}`;
}

function attestConfiguredDeploymentRoots(
  configured: readonly Readonly<{ root: string; required: boolean }>[],
): readonly AttestedProjectRoot[] {
  const attested: AttestedProjectRoot[] = [];
  for (const entry of configured) {
    try {
      fs.lstatSync(entry.root);
    } catch (error: any) {
      if (!entry.required && error?.code === 'ENOENT') continue;
      continuityFailure('A configured managed App deployment root was unavailable.');
    }
    attested.push(attestExactDirectory(entry.root, 'A managed App deployment root'));
  }
  return Object.freeze(attested);
}

function exactProjectAppPaths(
  project: ContinuityProject,
  deploymentRoots: readonly AttestedProjectRoot[],
): ReadonlySet<string> {
  return new Set(deploymentRoots.map(({ canonicalRoot }) => (
    path.join(canonicalRoot, `${project.workspaceOwnerId}-${project.projectName}`)
  )));
}

function appDeploymentAttestation(
  app: ContinuityApp,
  project: ContinuityProject,
  deploymentRoots: readonly AttestedProjectRoot[],
): AttestedProjectRoot | null {
  if (
    !app.zipPath
    || !path.isAbsolute(app.zipPath)
    || path.resolve(app.zipPath) !== app.zipPath
    || !exactProjectAppPaths(project, deploymentRoots).has(app.zipPath)
  ) return null;
  try {
    return attestExactDirectory(app.zipPath, 'A legacy App deployment');
  } catch (error: unknown) {
    if (error instanceof LegacyProjectContinuityAdoptionError) return null;
    throw error;
  }
}

type ContinuityPathSnapshot = Readonly<{
  path: string;
  state: 'absent' | 'attested' | 'invalid' | 'unsafe';
  canonicalRoot?: string;
  rootDevice?: string;
  rootInode?: string;
  rootBirthtimeNs?: string;
}>;

function continuityPathSnapshot(directory: unknown): ContinuityPathSnapshot {
  const candidate = typeof directory === 'string' ? directory : '';
  if (
    !candidate
    || candidate.includes('\0')
    || !path.isAbsolute(candidate)
    || path.resolve(candidate) !== candidate
  ) return Object.freeze({ path: candidate, state: 'invalid' });
  try {
    fs.lstatSync(candidate);
  } catch (error: any) {
    return Object.freeze({
      path: candidate,
      state: error?.code === 'ENOENT' ? 'absent' : 'unsafe',
    });
  }
  try {
    const attested = attestProjectRoot(candidate);
    if (attested.canonicalRoot !== candidate) {
      return Object.freeze({ path: candidate, state: 'unsafe' });
    }
    return Object.freeze({ path: candidate, state: 'attested', ...attested });
  } catch {
    return Object.freeze({ path: candidate, state: 'unsafe' });
  }
}

function snapshotMatchesIdentity(
  snapshot: ContinuityPathSnapshot,
  identity: ProjectIdentityRecord,
): boolean {
  return snapshot.state === 'attested'
    && snapshot.rootDevice === identity.rootDevice
    && snapshot.rootInode === identity.rootInode
    && snapshot.rootBirthtimeNs === identity.rootBirthtimeNs;
}

function validJournalDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Attest the immutable Project root before treating its App link as exact.
 * ACTIVE requires the recorded canonical inode. RENAMING admits only the
 * journal's exact source-or-target inode topology; DELETING admits its exact
 * root or the durable post-quarantine absent-root state. Other lifecycle
 * states cannot own a runnable App.
 */
function inspectLinkedProjectIdentity(identity: ProjectIdentityRecord): {
  admitted: boolean;
  topologySnapshot: string;
} {
  const lifecycleStatus = identity.lifecycleStatus || 'ACTIVE';
  const canonical = continuityPathSnapshot(identity.canonicalRoot);
  const canonicalShapeValid = canonical.path !== ''
    && canonical.state !== 'invalid'
    && path.basename(identity.canonicalRoot) === identity.projectName;
  let admitted = false;
  let target: ContinuityPathSnapshot | null = null;
  let renameDeployJournalValid: boolean | null = null;

  if (canonicalShapeValid && lifecycleStatus === 'ACTIVE') {
    admitted = canonical.path === identity.canonicalRoot
      && snapshotMatchesIdentity(canonical, identity);
  } else if (canonicalShapeValid && lifecycleStatus === 'RENAMING') {
    const targetName = typeof identity.renameTargetName === 'string'
      ? identity.renameTargetName
      : '';
    const targetNameValid = Boolean(targetName)
      && targetName !== '.'
      && targetName !== '..'
      && !targetName.startsWith('.')
      && !targetName.includes('\0')
      && path.basename(targetName) === targetName;
    if (targetNameValid) {
      target = continuityPathSnapshot(path.join(path.dirname(identity.canonicalRoot), targetName));
    }
    try {
      readProjectIdentityRenameDeployIdentity(identity);
      renameDeployJournalValid = true;
    } catch {
      renameDeployJournalValid = false;
    }
    const sourcePresent = snapshotMatchesIdentity(canonical, identity);
    const targetPresent = Boolean(target && snapshotMatchesIdentity(target, identity));
    const sourceAbsent = canonical.state === 'absent';
    const targetAbsent = target?.state === 'absent';
    admitted = Boolean(
      target
      && renameDeployJournalValid
      && /^[a-f0-9]{64}$/.test(String(identity.renameLeaseTokenHash || ''))
      && validJournalDate(identity.renameLeaseExpiresAt)
      && (
        (sourcePresent && targetAbsent)
        || (
          sourceAbsent
          && targetPresent
          && validJournalDate(identity.renameRuntimeCleanedAt)
        )
      )
    );
  } else if (canonicalShapeValid && lifecycleStatus === 'DELETING') {
    admitted = validJournalDate(identity.deletionStartedAt)
      && (
        snapshotMatchesIdentity(canonical, identity)
        || canonical.state === 'absent'
      );
  }

  return Object.freeze({
    admitted,
    topologySnapshot: JSON.stringify({
      lifecycleStatus,
      canonical,
      target,
      deletionStartedAt: validJournalDate(identity.deletionStartedAt)
        ? identity.deletionStartedAt.toISOString()
        : null,
      renameTargetName: identity.renameTargetName || null,
      renameLeaseTokenHash: identity.renameLeaseTokenHash || null,
      renameLeaseExpiresAt: validJournalDate(identity.renameLeaseExpiresAt)
        ? identity.renameLeaseExpiresAt.toISOString()
        : null,
      renameCleanupStartedAt: validJournalDate(identity.renameCleanupStartedAt)
        ? identity.renameCleanupStartedAt.toISOString()
        : null,
      renameRuntimeCleanedAt: validJournalDate(identity.renameRuntimeCleanedAt)
        ? identity.renameRuntimeCleanedAt.toISOString()
        : null,
      renameDeployJournalValid,
      renameDeployPresent: identity.renameDeployPresent ?? null,
      renameDeployDevice: identity.renameDeployDevice || null,
      renameDeployInode: identity.renameDeployInode || null,
      renameDeployBirthtimeNs: identity.renameDeployBirthtimeNs || null,
    }),
  });
}

async function inspectLinkedAppContinuity(input: {
  database: ContinuityDatabase;
  deploymentRoots: readonly AttestedProjectRoot[];
}): Promise<{
  linkedApps: number;
  stale: StaleLinkedAppCandidate[];
  repairable: RepairableStaleLinkedAppCandidate[];
  unrepairable: StaleLinkedAppCandidate[];
}> {
  const apps = await input.database.app.findMany({
    where: { projectIdentityId: { not: null } },
    orderBy: { id: 'asc' },
    take: MAX_CONTINUITY_APPS + 1,
    select: {
      id: true,
      userId: true,
      projectIdentityId: true,
      name: true,
      zipPath: true,
      deployType: true,
      processStatus: true,
    },
  });
  if (apps.length > MAX_CONTINUITY_APPS) {
    continuityFailure('The linked App continuity inventory exceeded its safety limit.');
  }
  const stale: StaleLinkedAppCandidate[] = [];
  const repairable: RepairableStaleLinkedAppCandidate[] = [];
  const unrepairable: StaleLinkedAppCandidate[] = [];
  for (const app of apps) {
    // Selected explicitly: the rebootability preflight runs this audit against
    // the still-outgoing database, before this release's migrations apply.
    const identity = app.projectIdentityId
      ? await input.database.projectIdentity.findUnique({
        where: { id: app.projectIdentityId },
        select: PROJECT_IDENTITY_RECORD_SELECT,
      })
      : null;
    const project: ContinuityProject | null = identity
      ? {
        workspaceOwnerId: identity.workspaceOwnerId,
        projectName: identity.projectName,
        projectRoot: identity.canonicalRoot,
        identity,
      }
      : null;
    const identityInspection = identity
      ? inspectLinkedProjectIdentity(identity)
      : Object.freeze({ admitted: false, topologySnapshot: 'missing-identity' });
    const declaredDeploymentPath = Boolean(
      project
      && app.zipPath
      && path.isAbsolute(app.zipPath)
      && path.resolve(app.zipPath) === app.zipPath
      && exactProjectAppPaths(project, input.deploymentRoots).has(app.zipPath)
    );
    const interruptedLifecycle = identity?.lifecycleStatus === 'RENAMING'
      || identity?.lifecycleStatus === 'DELETING';
    const exact = project
      && identity!.workspaceOwnerId === app.userId
      && identity!.projectName === app.name
      && identityInspection.admitted
      && declaredDeploymentPath
      && (
        interruptedLifecycle
        || appDeploymentAttestation(app, project, input.deploymentRoots)
      );
    if (exact) continue;

    const staleCandidate = Object.freeze({
      app,
      identity,
      identityTopologySnapshot: identityInspection.topologySnapshot,
    });
    stale.push(staleCandidate);
    const runtimeManagement = projectRuntimeManagement(app);
    // De-association does not adopt, delete, stop, or rename any resource. An
    // exact App-row CAS can therefore contain every stale FK shape, including
    // a missing/odd deployment path or a missing identity. Runtime ownership
    // only decides whether Portal-container intent is settled to error; all
    // external/static/desktop state remains standalone and untouched.
    repairable.push(Object.freeze({ ...staleCandidate, runtimeManagement }));
  }
  return { linkedApps: apps.length, stale, repairable, unrepairable };
}

function continuityRepairPlanToken(
  candidates: readonly RepairableStaleLinkedAppCandidate[],
): string {
  const inventory = candidates.map((candidate) => ({
    app: {
      id: candidate.app.id,
      userId: candidate.app.userId,
      projectIdentityId: candidate.app.projectIdentityId,
      name: candidate.app.name,
      zipPath: candidate.app.zipPath,
      deployType: candidate.app.deployType,
      processStatus: candidate.app.processStatus,
    },
    identity: candidate.identity ? {
      id: candidate.identity.id,
      workspaceOwnerId: candidate.identity.workspaceOwnerId,
      projectName: candidate.identity.projectName,
      canonicalRoot: candidate.identity.canonicalRoot,
      rootDevice: candidate.identity.rootDevice,
      rootInode: candidate.identity.rootInode,
      rootBirthtimeNs: candidate.identity.rootBirthtimeNs,
      generation: candidate.identity.generation,
      lifecycleStatus: candidate.identity.lifecycleStatus || '',
      legacyOpenClawMigrationStatus: candidate.identity.legacyOpenClawMigrationStatus || '',
    } : null,
    identityTopologySnapshot: candidate.identityTopologySnapshot,
    runtimeManagement: candidate.runtimeManagement,
  }));
  return crypto.createHash('sha256')
    .update(`bridgesllm-continuity-repair-v1\0${JSON.stringify(inventory)}`)
    .digest('hex');
}

async function quarantineStaleLinkedApps(input: {
  transaction: ContinuityStore;
  candidates: readonly StaleLinkedAppCandidate[];
}): Promise<number> {
  if (input.candidates.length === 0) return 0;
  let quarantined = 0;
  for (const { app } of input.candidates) {
    const runtimeManagement = projectRuntimeManagement(app);
    const result = await input.transaction.app.updateMany({
      where: {
        id: app.id,
        userId: app.userId,
        projectIdentityId: app.projectIdentityId,
        name: app.name,
        zipPath: app.zipPath,
        deployType: app.deployType,
        processStatus: app.processStatus,
      },
      data: {
        projectIdentityId: null,
        ...(runtimeManagement === 'portal-container' ? { processStatus: 'error' } : {}),
      },
    });
    if (result.count !== 1) {
      continuityFailure('A stale linked App changed before continuity quarantine could commit.');
    }
    quarantined += 1;
  }
  return quarantined;
}

/**
 * Read-only update gate for the linked App invariant. The only automatically
 * repair plan signs every stale row that can be safely contained by severing
 * only its FK. Missing/odd paths and ambiguous resources are preserved; the
 * updater refuses only if it cannot inventory or CAS the exact rows.
 */
export async function auditLegacyProjectContinuityReadiness(options: {
  deployRoot?: string;
  legacyDeployRoot?: string;
  database?: ContinuityDatabase;
} = {}): Promise<LegacyProjectContinuityReadinessAudit> {
  const database = options.database || (prisma as unknown as ContinuityDatabase);
  const roots = continuityRoots(options);
  const deploymentRoots = attestConfiguredDeploymentRoots(roots.configuredDeploymentRoots);
  const inspection = await inspectLinkedAppContinuity({ database, deploymentRoots });
  if (inspection.unrepairable.length > 0) {
    continuityFailure(
      `${inspection.unrepairable.length} Project-linked App association(s) were stale but not exactly repairable.`,
    );
  }
  return Object.freeze({
    linkedApps: inspection.linkedApps,
    staleLinkedApps: inspection.stale.length,
    repairableStaleLinkedApps: inspection.repairable.length,
    repairPlanToken: continuityRepairPlanToken(inspection.repairable),
  });
}

/**
 * Apply the exact plan emitted by the mutation-free audit. The inventory is
 * re-read inside a serializable transaction and must hash to the caller's
 * signed-candidate plan before any App row changes. App/share primary keys and
 * share rows are untouched.
 */
export async function repairLegacyProjectContinuityLinks(options: {
  expectedPlanToken: string;
  deployRoot?: string;
  legacyDeployRoot?: string;
  database?: ContinuityDatabase;
}): Promise<{ appsQuarantined: number; quarantinedAppIds: readonly string[] }> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlanToken)) {
    continuityFailure('The continuity repair plan token was malformed.');
  }
  const database = options.database || (prisma as unknown as ContinuityDatabase);
  const roots = continuityRoots(options);
  const deploymentRoots = attestConfiguredDeploymentRoots(roots.configuredDeploymentRoots);
  const result = await database.$transaction(async (transaction) => {
    const inspection = await inspectLinkedAppContinuity({
      database: transaction as ContinuityDatabase,
      deploymentRoots,
    });
    if (inspection.unrepairable.length > 0) {
      continuityFailure('A stale App association became ambiguous before continuity repair.');
    }
    if (continuityRepairPlanToken(inspection.repairable) !== options.expectedPlanToken) {
      continuityFailure('The stale App continuity inventory changed after its read-only audit.');
    }
    const appsQuarantined = await quarantineStaleLinkedApps({
      transaction,
      candidates: inspection.repairable,
    });
    return {
      appsQuarantined,
      quarantinedAppIds: inspection.repairable.map(({ app }) => app.id),
    };
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
  const postAudit = await auditLegacyProjectContinuityReadiness({
    ...options,
    database,
  });
  if (postAudit.staleLinkedApps !== 0) {
    continuityFailure('Continuity quarantine did not produce a clean linked-App inventory.');
  }
  return Object.freeze({
    appsQuarantined: result.appsQuarantined,
    quarantinedAppIds: Object.freeze([...result.quarantinedAppIds]),
  });
}

async function enumerateProjects(input: {
  database: ContinuityDatabase;
  projectsRoot: string;
  ensureIdentity: typeof ensureProjectIdentity;
}): Promise<{
  projects: ContinuityProject[];
  enrolled: number;
  enrolledIdentityIds: ReadonlySet<string>;
  ignoredInternalDirectories: number;
  preservedUnownedDirectories: number;
}> {
  const projectsRootIdentity = attestExactDirectory(input.projectsRoot, 'The Projects root');
  const users = await input.database.user.findMany({ select: { id: true } });
  const userIds = new Set(users.map(({ id }) => id));
  const projects: ContinuityProject[] = [];
  const enrolledIdentityIds = new Set<string>();
  let enrolled = 0;
  let ignoredInternalDirectories = 0;
  let preservedUnownedDirectories = 0;

  const ownerEntries = fs.readdirSync(input.projectsRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const ownerEntry of ownerEntries) {
    if (isInternalProjectDirectoryName(ownerEntry.name)) {
      ignoredInternalDirectories += 1;
      continue;
    }
    if (!userIds.has(ownerEntry.name)) {
      preservedUnownedDirectories += 1;
      continue;
    }
    if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) {
      continuityFailure('A known Project owner path was not a real directory.');
    }
    const ownerRoot = path.join(input.projectsRoot, ownerEntry.name);
    const ownerIdentity = attestExactDirectory(ownerRoot, 'A Project owner directory');
    const projectEntries = fs.readdirSync(ownerRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const projectEntry of projectEntries) {
      if (isInternalProjectDirectoryName(projectEntry.name)) {
        ignoredInternalDirectories += 1;
        continue;
      }
      if (projectEntry.isSymbolicLink() || !projectEntry.isDirectory()) continue;
      if (projects.length >= MAX_CONTINUITY_PROJECTS) {
        continuityFailure('The Project continuity inventory exceeded its safety limit.');
      }
      const projectRoot = path.join(ownerRoot, projectEntry.name);
      attestExactDirectory(projectRoot, 'A legacy Project root');
      const existing = await input.database.projectIdentity.findUnique({
        where: {
          workspaceOwnerId_projectName: {
            workspaceOwnerId: ownerEntry.name,
            projectName: projectEntry.name,
          },
        },
        select: PROJECT_IDENTITY_RECORD_SELECT,
      });
      const identity = await input.ensureIdentity({
        workspaceOwnerId: ownerEntry.name,
        projectName: projectEntry.name,
        projectRoot,
      }, input.database);
      // Startup continuity may enroll the existing inode, but it may never
      // assert that a pre-4.0 root is CURRENT. CURRENT bypasses preserved
      // name/path-keyed OpenClaw evidence and is reserved for a separately
      // proven explicit migration or a Portal-4-born root.
      if (!existing && identity.legacyOpenClawMigrationStatus !== 'NONE') {
        continuityFailure('A legacy Project was enrolled with unsafe CURRENT provenance.');
      }
      if (!existing) {
        enrolled += 1;
        enrolledIdentityIds.add(identity.id);
      }
      projects.push(Object.freeze({
        workspaceOwnerId: ownerEntry.name,
        projectName: projectEntry.name,
        projectRoot,
        identity,
      }));
    }
    if (!sameDirectoryIdentity(ownerIdentity, attestExactDirectory(ownerRoot, 'A Project owner directory'))) {
      continuityFailure('A Project owner directory changed during continuity enrollment.');
    }
  }
  if (!sameDirectoryIdentity(
    projectsRootIdentity,
    attestExactDirectory(input.projectsRoot, 'The Projects root'),
  )) {
    continuityFailure('The Projects root changed during continuity enrollment.');
  }
  return {
    projects,
    enrolled,
    enrolledIdentityIds,
    ignoredInternalDirectories,
    preservedUnownedDirectories,
  };
}

async function planAppBackfill(input: {
  database: ContinuityDatabase;
  projects: readonly ContinuityProject[];
  deploymentRoots: readonly AttestedProjectRoot[];
  enrolledIdentityIds: ReadonlySet<string>;
  excludedAppIds: ReadonlySet<string>;
}): Promise<{
  candidates: AppBackfillCandidate[];
  alreadyAssociated: number;
  leftStandalone: number;
}> {
  const apps = await input.database.app.findMany({
    orderBy: { id: 'asc' },
    take: MAX_CONTINUITY_APPS + 1,
    select: {
      id: true,
      userId: true,
      projectIdentityId: true,
      name: true,
      zipPath: true,
      deployType: true,
      processStatus: true,
    },
  });
  if (apps.length > MAX_CONTINUITY_APPS) {
    continuityFailure('The App continuity inventory exceeded its safety limit.');
  }
  const projectsByName = new Map(
    input.projects.map((project) => [
      projectKey(project.workspaceOwnerId, project.projectName),
      project,
    ]),
  );
  const exactClaimCounts = new Map<string, number>();
  const candidates: AppBackfillCandidate[] = [];
  let alreadyAssociated = 0;
  let leftStandalone = 0;

  for (const app of apps) {
    const project = projectsByName.get(projectKey(app.userId, app.name));
    if (!project) {
      leftStandalone += 1;
      continue;
    }
    const deploymentIdentity = appDeploymentAttestation(app, project, input.deploymentRoots);
    if (!deploymentIdentity) {
      if (app.projectIdentityId === project.identity.id) {
        continuityFailure('A Project-linked App no longer matched its exact deployment path.');
      }
      leftStandalone += 1;
      continue;
    }
    const claimCount = (exactClaimCounts.get(project.identity.id) || 0) + 1;
    exactClaimCounts.set(project.identity.id, claimCount);
    if (claimCount > 1) {
      continuityFailure('More than one App claimed the same attested Project deployment.');
    }
    if (app.projectIdentityId === project.identity.id) {
      alreadyAssociated += 1;
      continue;
    }
    if (app.projectIdentityId !== null) {
      continuityFailure('An App claimed a different immutable Project identity.');
    }
    // Startup continuity exists only to bridge the one-time 3.x→4.x identity
    // enrollment boundary. A nullable App must never be implicitly rebound to
    // a previously existing identity on a later boot, and a quarantined App
    // requires the explicit supported rebind operation.
    if (
      !input.enrolledIdentityIds.has(project.identity.id)
      || input.excludedAppIds.has(app.id)
    ) {
      leftStandalone += 1;
      continue;
    }
    candidates.push(Object.freeze({ app, project, deploymentIdentity }));
  }
  return { candidates, alreadyAssociated, leftStandalone };
}

async function commitAppBackfill(input: {
  database: ContinuityDatabase;
  candidates: readonly AppBackfillCandidate[];
}): Promise<number> {
  if (input.candidates.length === 0) return 0;
  return input.database.$transaction(async (transaction) => {
    let updated = 0;
    for (const candidate of input.candidates) {
      const before = attestExactDirectory(candidate.app.zipPath, 'A legacy App deployment');
      if (!sameDirectoryIdentity(before, candidate.deploymentIdentity)) {
        continuityFailure('An App deployment changed before continuity association.');
      }
      const result = await transaction.app.updateMany({
        where: {
          id: candidate.app.id,
          userId: candidate.app.userId,
          name: candidate.app.name,
          zipPath: candidate.app.zipPath,
          projectIdentityId: null,
        },
        data: { projectIdentityId: candidate.project.identity.id },
      });
      if (result.count !== 1) {
        continuityFailure('An App changed before continuity association could commit.');
      }
      const after = attestExactDirectory(candidate.app.zipPath, 'A legacy App deployment');
      if (!sameDirectoryIdentity(after, candidate.deploymentIdentity)) {
        continuityFailure('An App deployment changed during continuity association.');
      }
      updated += 1;
    }
    return updated;
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
}

/**
 * Preserve Portal 3.x filesystem/App continuity before any 4.0 runtime starts.
 *
 * This deliberately does not invoke the explicit snapshot/promotion path and
 * never marks an old root CURRENT. It enrolls each exact existing Project inode as NONE, then
 * backfills only an attested App path that already has the same owner/name and
 * one of the product's exact managed deployment shapes. Standalone Apps remain
 * nullable by design. The legacy Project Chat/evidence gate remains intact.
 */
export async function initializeLegacyProjectContinuityAdoption(options: {
  projectsRoot?: string;
  deployRoot?: string;
  legacyDeployRoot?: string;
  database?: ContinuityDatabase;
  ensureIdentity?: typeof ensureProjectIdentity;
} = {}): Promise<{
  projectsFound: number;
  identitiesEnrolled: number;
  appsBackfilled: number;
  appsAlreadyAssociated: number;
  appsLeftStandalone: number;
  appsQuarantined: number;
  ignoredInternalDirectories: number;
  preservedUnownedDirectories: number;
}> {
  const database = options.database || (prisma as unknown as ContinuityDatabase);
  const roots = continuityRoots(options);
  const deploymentRoots = attestConfiguredDeploymentRoots(roots.configuredDeploymentRoots);
  // Canonical boot is a containment boundary, not an updater cleanup gate.
  // Re-read every linked row inside the serializable transaction and sever
  // any stale FK by exact CAS. Ambiguous/missing filesystem resources are
  // deliberately preserved; only Portal-container intent is settled to error.
  const quarantine = await database.$transaction(async (transaction) => {
    const inspection = await inspectLinkedAppContinuity({
      database: transaction as ContinuityDatabase,
      deploymentRoots,
    });
    const appsQuarantined = await quarantineStaleLinkedApps({
      transaction,
      candidates: inspection.stale,
    });
    return {
      appsQuarantined,
      quarantinedAppIds: inspection.stale.map(({ app }) => app.id),
    };
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
  const inventory = await enumerateProjects({
    database,
    projectsRoot: roots.projectsRoot,
    ensureIdentity: options.ensureIdentity || ensureProjectIdentity,
  });
  const appPlan = await planAppBackfill({
    database,
    projects: inventory.projects,
    deploymentRoots,
    enrolledIdentityIds: inventory.enrolledIdentityIds,
    excludedAppIds: new Set(quarantine.quarantinedAppIds),
  });
  const appsBackfilled = await commitAppBackfill({
    database,
    candidates: appPlan.candidates,
  });
  return Object.freeze({
    projectsFound: inventory.projects.length,
    identitiesEnrolled: inventory.enrolled,
    appsBackfilled,
    appsAlreadyAssociated: appPlan.alreadyAssociated,
    appsLeftStandalone: appPlan.leftStandalone,
    appsQuarantined: quarantine.appsQuarantined,
    ignoredInternalDirectories: inventory.ignoredInternalDirectories,
    preservedUnownedDirectories: inventory.preservedUnownedDirectories,
  });
}

export const __legacyProjectContinuityAdoptionTest = Object.freeze({
  MAX_CONTINUITY_PROJECTS,
  MAX_CONTINUITY_APPS,
});
